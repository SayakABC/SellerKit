// electron/shop-product-db.ts
// 「店铺商品清单」数据访问层（pl_shop_sku 表扩展，支持一对多关联）。
//
// 职责：
//   - 商品清单（按 item_id 去重，存 image_url/imported_at）
//   - 商品与产品的关联关系（一对多：一个 item_id 可关联多个 product_id）
//
// 安全边界：
//   本层只允许主进程内部使用；渲染层与 UI 岛一律经语义化 IPC / db 能力域访问。

export {};

import { dbRun, dbQuery, dbGet, dbTransaction, tableExists } from './db';
import { ensureProductSchema, ensureSkuSchema, SKU_POOL_SOURCE, skuPoolSql } from './product-db';
import { toNameKey } from './shopName';

/**
 * 本域**复用** `pl_shop_sku` / `pl_products`，而这两张表由 product 域懒建
 * （`ensureProductSchema` 只建 `pl_products`；`pl_shop_sku` 归 `ensureSkuSchema`）。
 * 表由 owner 建、DDL 只留一份，故这里导入其 ensure 而不是自己写一份 ——
 * 漏了这一步的症状是"新装应用先点商品清单"直接抛 `no such table: pl_shop_sku`。
 */
function ensureSchema(): void {
  ensureProductSchema();
  ensureSkuSchema();
}

/**
 * 商品池与「映射与关联」的归款映射**共用 `pl_shop_sku`**，故本域所有读写都带池谓词
 * （`skuPoolSql`，判据与常量定义在 schema owner `product-db.ts`，映射侧用它的补集 `skuMappingSql`）。
 * 不带谓词的后果：池的 list 混进映射行、池的删除把 confirmed 映射一起删掉（静默打坏归款）。
 */

// 工具函数（纯函数口径与 product-db 一致，故不跨文件导入；唯一例外是上面的 ensureSchema —— 表结构归 owner）
function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}
function toId(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 2147483647 ? v : 0;
}
function num(v: unknown): number {
  if (v === null || v === undefined) return 0;
  const n = Number(v);
  return Number.isFinite(n) ? Math.trunc(n) : 0;
}

/** product_id → (code, name) */
function productLabelMap(): Map<number, { code: string; name: string }> {
  const m = new Map<number, { code: string; name: string }>();
  for (const r of dbQuery<Record<string, unknown>>(`SELECT id, code, name FROM pl_products`)) {
    m.set(num(r.id), { code: String(r.code ?? ''), name: String(r.name ?? '') });
  }
  return m;
}

/** 表是否存在 —— 各域表按域懒建，本层不能假定店铺域已初始化 */
/**
 * `sk_shops.id` → (名称, 平台)；店铺域未初始化时返回空表（降级而非报错）。
 *
 * 店铺名是**展示列**，不进 `pl_shop_sku`：ADR-002 C2「关联用 ID，不用名字」——
 * 存文本快照会让改名后的历史行指着旧名，且与三处历史店铺文本的归一链分叉。
 */
function shopLabelMap(): Map<number, { name: string; platform: string }> {
  const m = new Map<number, { name: string; platform: string }>();
  if (!tableExists('sk_shops')) return m;
  for (const r of dbQuery<Record<string, unknown>>(`SELECT id, name, platform FROM sk_shops`)) {
    m.set(num(r.id), { name: String(r.name ?? ''), platform: String(r.platform ?? '') });
  }
  return m;
}

/**
 * 店铺原文（归一键）→ `shop_id`：人工归一优先 → 同名唯一精确命中（命中多家 = 歧义 = 不猜）。
 *
 * 与 `product-db.resolveOrderSku` / 待关联队列**同一套规则**：规则一分叉，症状就是
 * "队列里说这家店已归一、落单时却认不出来"，而两边各自看都正常。
 */
function resolveShopIdByKey(shopKey: string): number {
  if (!shopKey) return 0;
  if (tableExists('sk_name_map')) {
    const manual = dbGet<{ ref_id: number }>(
      `SELECT ref_id FROM sk_name_map
       WHERE kind = 'shop' AND ignored = 0 AND ref_id > 0 AND raw_key = ?
       LIMIT 1`,
      [shopKey],
    );
    const id = num(manual?.ref_id);
    if (id) return id;
  }
  if (!tableExists('sk_shops')) return 0;
  const rows = dbQuery<{ id: number }>(
    `SELECT id FROM sk_shops WHERE name_key = ? LIMIT 2`,
    [shopKey],
  );
  return rows.length === 1 ? num(rows[0].id) : 0;
}

// ---- 类型 ----

/** 商品清单行（按 item_id 去重） */
export interface ShopProductItem {
  itemId: string;
  shopName: string;
  imageUrl: string;
  importedAt: number;
  relationCount: number; // 关联的产品数
}

/** 商品关联关系行 */
export interface ShopProductRelation {
  id: number;
  itemId: string;
  productId: number;
  productCode: string;
  productName: string;
  createdAt: string;
}

// ---- 商品清单（按 item_id 去重） ----

const MAX_IMPORT_ROWS = 20000;

/**
 * 导入商品清单（按 item_id 去重，保留最新的 image_url）。
 *
 * 店铺归属（`shopId` 直给，或 `shopName` 原文经归一链落成 `shop_id`）——
 * 两者都没有时落 `shop_id = 0`，表示"暂不指定店铺"（岛侧当前就是这样传的）。
 * 归一规则留在宿主一份（岛不该自己解析 `sk_name_map`），平台随之从 `sk_shops` 取：
 * `pl_shop_sku` 的唯一键含 platform，缺平台会让同一家店的同一商品在池行与映射行各存一份。
 *
 * @returns 导入统计
 */
export function importShopProducts(
  items: { itemId: string; shopId?: number; shopName?: string; imageUrl: string }[],
): {
  imported: number;
  updated: number;
} {
  ensureSchema();
  const list = Array.isArray(items) ? items.slice(0, MAX_IMPORT_ROWS) : [];
  const shops = shopLabelMap();
  const now = Date.now();
  let imported = 0;
  let updated = 0;

  dbTransaction(() => {
    for (const r of list) {
      const itemId = toNameKey(r?.itemId); // 归一化
      if (!itemId) continue;
      const shopId = toId(r?.shopId) || resolveShopIdByKey(toNameKey(r?.shopName));
      const imageUrl = str(r?.imageUrl, 2000);
      const platform = toNameKey(shops.get(shopId)?.platform ?? '');

      // 按 item_id 去重（**只在池内**去重：不能拿导入覆盖归款映射的 image_url/imported_at）
      const existing = dbGet<{ id: number }>(
        `SELECT id FROM pl_shop_sku WHERE item_id = ? AND ${skuPoolSql()} LIMIT 1`,
        [itemId],
      );
      if (existing) {
        dbRun(
          `UPDATE pl_shop_sku SET image_url = ?, imported_at = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
          [imageUrl, now, existing.id],
        );
        updated++;
      } else {
        // 新商品：插入一条占位记录（product_id=0 表示未关联）
        dbRun(
          `INSERT INTO pl_shop_sku (item_id, image_url, imported_at, platform, shop_id, product_id, source)
           VALUES (?, ?, ?, ?, ?, 0, ?)`,
          [itemId, imageUrl, now, platform, shopId, SKU_POOL_SOURCE],
        );
        imported++;
      }
    }
  });

  return { imported, updated };
}

/**
 * 商品清单列表（按 item_id 去重，按 imported_at 倒序）。
 * 支持分页 + 搜索。
 */
export function listShopProducts(payload: {
  offset: number;
  limit: number;
  search: string;
}): { rows: ShopProductItem[]; total: number } {
  ensureSchema();
  const search = str(payload?.search, 200);

  // 池谓词恒生效：`pl_shop_sku` 同时装着「映射与关联」的归款映射，不区分就会把映射行当商品列出来
  const where: string[] = [skuPoolSql()];
  const params: (string | number)[] = [];
  if (search) {
    const like = `%${search}%`;
    if (tableExists('sk_shops')) {
      // 店铺名经 shop_id 反查（ADR-002 C2：名字不是关联键，`pl_shop_sku` 不存店铺名）
      where.push(`(item_id LIKE ? OR shop_id IN (SELECT id FROM sk_shops WHERE name LIKE ?))`);
      params.push(like, like);
    } else {
      where.push(`(item_id LIKE ?)`);
      params.push(like);
    }
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  // 按 item_id 去重：取每组最新的一条（ORDER BY imported_at DESC）
  const offset = Math.max(0, Math.floor(Number(payload?.offset) || 0));
  const limit = Math.min(500, Math.max(1, Math.floor(Number(payload?.limit) || 50)));

  const rowsRaw = dbQuery<Record<string, unknown>>(
    `SELECT item_id, shop_id, image_url, imported_at,
            (SELECT COUNT(*) FROM pl_shop_sku AS t2
              WHERE t2.item_id = pl_shop_sku.item_id AND product_id > 0 AND ${skuPoolSql('t2.')}) AS relation_count
     FROM pl_shop_sku
     ${whereSql}
     GROUP BY item_id
     ORDER BY imported_at DESC, id DESC
     LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );

  const totalRow = dbGet<{ c: number }>(
    `SELECT COUNT(DISTINCT item_id) AS c FROM pl_shop_sku ${whereSql}`,
    params,
  );

  const shops = shopLabelMap();
  return {
    rows: rowsRaw.map((r) => ({
      itemId: String(r.item_id ?? ''),
      shopName: shops.get(num(r.shop_id))?.name ?? '',
      imageUrl: String(r.image_url ?? ''),
      importedAt: Number(r.imported_at) || 0,
      relationCount: Number(r.relation_count) || 0,
    })),
    total: totalRow ? num(totalRow.c) : 0,
  };
}

/**
 * 删除商品（按 item_id 删除该商品在**池内**的全部记录：占位行 + 关联行）。
 *
 * ⚠️ 只删池行：`pl_shop_sku` 里同 item_id 可能还挂着「映射与关联」的 confirmed 归款映射，
 * 那是另一个功能的钱账依据，删掉会静默打坏归款（判据见 `skuPoolSql`）。
 */
export function deleteShopProduct(itemId: string): { removed: number } {
  ensureSchema();
  const normalized = toNameKey(itemId);
  if (!normalized) return { removed: 0 };

  const info = dbRun(`DELETE FROM pl_shop_sku WHERE item_id = ? AND ${skuPoolSql()}`, [normalized]);
  return { removed: info.changes || 0 };
}

// ---- 关联关系 ----

/**
 * 查询某个商品的所有关联关系（池内）。
 */
export function listShopProductRelations(itemId: string): ShopProductRelation[] {
  ensureSchema();
  const normalized = toNameKey(itemId);
  if (!normalized) return [];

  const products = productLabelMap();
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT id, item_id, product_id, created_at
     FROM pl_shop_sku
     WHERE item_id = ? AND product_id > 0 AND ${skuPoolSql()}
     ORDER BY created_at DESC`,
    [normalized],
  );

  return rows.map((r) => {
    const productId = num(r.product_id);
    const label = products.get(productId);
    return {
      id: num(r.id),
      itemId: String(r.item_id ?? ''),
      productId,
      productCode: label?.code ?? '',
      productName: label?.name ?? '',
      createdAt: String(r.created_at ?? ''),
    };
  });
}

/**
 * 添加关联关系（item_id + product_id，一对多：同一商品可挂多个产品）。
 * 已存在则跳过（不报错）。
 *
 * `shopId` 为该关联的店铺归属（0 = 跨店共用）。给了店铺就落 `shop_id`/`platform` ——
 * 与「映射与关联」同一条精确键 `(platform, shop_id, item_id, spec)`，套装读取侧才能按店精确命中。
 */
export function addShopProductRelation(
  itemId: string,
  productId: number,
  shopId = 0,
): {
  id: number;
  created: boolean;
} {
  ensureSchema();
  const normalized = toNameKey(itemId);
  if (!normalized) throw new Error('商品ID不能为空');
  const pid = toId(productId);
  if (!pid) throw new Error('产品ID不能为空');
  const sid = toId(shopId);

  // 检查产品是否存在
  if (!dbGet(`SELECT id FROM pl_products WHERE id = ?`, [pid])) {
    throw new Error('产品不存在或已被删除');
  }

  // 检查是否已存在（同店同商品同产品；池内限定，不碰归款映射）
  const existing = dbGet<{ id: number }>(
    `SELECT id FROM pl_shop_sku WHERE item_id = ? AND product_id = ? AND shop_id = ? AND ${skuPoolSql()}`,
    [normalized, pid, sid],
  );
  if (existing) {
    return { id: num(existing.id), created: false };
  }

  const platform = toNameKey(shopLabelMap().get(sid)?.platform ?? '');
  const info = dbRun(
    `INSERT INTO pl_shop_sku (item_id, product_id, platform, shop_id, status, source)
     VALUES (?, ?, ?, ?, 'confirmed', ?)`,
    [normalized, pid, platform, sid, SKU_POOL_SOURCE],
  );
  return { id: Number(info.lastInsertRowid), created: true };
}

/**
 * 删除关联关系（按 id）。
 */
export function deleteShopProductRelation(id: number): { removed: number } {
  ensureSchema();
  const rid = toId(id);
  if (!rid) return { removed: 0 };

  const info = dbRun(`DELETE FROM pl_shop_sku WHERE id = ?`, [rid]);
  return { removed: info.changes || 0 };
}
