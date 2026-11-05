// electron/legacy-image-migration.ts
// **一次性**图片搬迁（2026-10-30，R1 修订）：把三张旧图片表的存量搬进唯一图片仓 `md_images`。
//
// 为什么会有这个文件：R1 原定"旧图零迁移"（依据是项目政策「未正式发布、无存量库」）。
// 但 2026-10-30 的真库实测有三样东西不能丢：
//   · `oi_images` 101 行（订单图，全在 `order-images/`，文件 113 个一个不缺）；
//   · `pl_images`  12 行（产品图，`product-images/`）；
//   · `oi_images.style_color_id <> 0` **92 条「图 → 款色」绑定** —— 这是人工定款定色攒下来的结论。
// 旧表一 DROP，图片列全变空白、"按图找色"的知识归零。
//
// 本文件是**过渡件**，只被 `order-db.ts` 的 `retireLegacyImageTables()` 在拆表之前调用一次；
// 拆完旧表就没了，第二次调用直接空转。**迁移窗口结束后整个文件可以删掉**，
// 旧表名（`oi_images` / `pl_images` / `pl_item_images`）也只应该出现在这里。
//
// 三条纪律：
//   ① 落盘仍走**唯一入口** `landImageBytes`（不自己写文件、不自己插 `md_images` 行）；
//   ② 改的是**引用**，不是内容：订单行/产品行的 `image_id` 换成本地图 id，订单号、款色、金额一个字不动；
//   ③ 款色代表图 1:1：旧表允许一个色挂多张图（真库 8 个色各挂 2–4 张），只能留一张 ——
//      按 `updated_at DESC, id DESC` 取最近一次的那张，其余保留为普通图片（不删字节）。

import * as fs from 'fs';
import { dbGet, dbQuery, dbRun, tableExists } from './db';
import { ensureMasterDataSchema, landImageBytes } from './master-data-db';

/** 旧表名（迁移窗口结束后连同本文件一起删） */
export const LEGACY_IMAGE_TABLES = ['oi_images', 'pl_images', 'pl_item_images'] as const;

/** 一条「款色 id → 代表图 md id」的搬迁结论；由调用方在补出 `oi_style_colors.image_id` 之后写入 */
export interface LegacyStyleColorBinding {
  styleColorId: number;
  imageId: number;
}

export interface LegacyImageMigrationResult {
  /** 成功登记进 `md_images` 的图（含"同内容复用既有行"） */
  landed: number;
  /** 文件丢失 / 不是受支持格式而被跳过的旧行 */
  skipped: number;
  /** 被改写 `image_id` 的订单行数（由 `remapOrderItemImages` 在表重建后填） */
  remappedOrderItems: number;
  /** 被改写 `image_id` 的产品行数（`pl_products`） */
  remappedProducts: number;
  /** 被改写 `image_id` 的采集商品行数（`pl_shop_items`） */
  remappedShopItems: number;
  /** 因"一个色挂多张图"而未采用的绑定（取最近一张，其余留作普通图片） */
  droppedBindings: number;
  /** 指向不存在款色的旧绑定（脏数据，跳过） */
  danglingBindings: number;
  /** 款色代表图搬迁结论（1:1；调用方补列后逐条写） */
  bindings: LegacyStyleColorBinding[];
  /**
   * 订单行待改写的映射 `[旧 oi_images.id, md id]`。
   * ⚠️ **不能**在这里直接 UPDATE：旧 `oi_order_items.image_id` 上还挂着
   * `REFERENCES oi_images(id)`，把值改成 `md_images` 的 id 会立刻 `FOREIGN KEY constraint failed`。
   * 必须等 `retireLegacyImageTables` 重建明细表（新 DDL 不带这条外键）之后才改。
   */
  orderImageMap: Array<[number, number]>;
}

function emptyResult(): LegacyImageMigrationResult {
  return {
    landed: 0,
    skipped: 0,
    remappedOrderItems: 0,
    remappedProducts: 0,
    remappedShopItems: 0,
    droppedBindings: 0,
    danglingBindings: 0,
    bindings: [],
    orderImageMap: [],
  };
}

/**
 * 把某张表的 `image_id` 从旧 id 批量改成 md id。
 *
 * ⚠️ **不能**直接 `for (旧id) UPDATE ... WHERE image_id = 旧id`：`md_images` 与旧表都是从 1
 * 开始自增，新 id 很可能是**另一个旧行**的 id —— 逐条改写会把刚改好的行再改一次（真库演练
 * 实测：11 个带图产品被改写了 18 行）。两阶段：先把待改的值全置成**负数**（md id、旧 id 都是
 * 正数，负数不可能撞上），再按 `-旧id` 落正数。
 *
 * @returns 被改写的行数（负数阶段的行数 = 真正需要改的行数）
 */
function remapImageColumn(table: string, map: Map<number, number>): number {
  if (!tableExists(table) || !map.size) return 0;
  const legacyIds = [...map.keys()];
  const changed = dbRun(
    `UPDATE ${table} SET image_id = -image_id
      WHERE image_id IN (${legacyIds.map(() => '?').join(',')})`,
    legacyIds,
  ).changes;
  for (const [legacyId, mdId] of map) {
    dbRun(`UPDATE ${table} SET image_id = ? WHERE image_id = ?`, [mdId, -legacyId]);
  }
  return changed;
}

/** 旧表的真实列集合（历史夹具/更老的库可能缺其中几列，查询不能假定列齐全） */
function columnsOf(table: string): Set<string> {
  return new Set(
    dbQuery<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => String(c.name)),
  );
}

/** 旧表按"缺列回落空值"拼查询：`SELECT id, <可选列…> FROM t [ORDER BY …]` */
function selectLegacy(
  table: string,
  optional: readonly string[],
  orderBy: readonly string[] = [],
): Record<string, unknown>[] {
  const cols = columnsOf(table);
  const head = ['id'];
  const rest = optional.map((c) => (cols.has(c) ? c : `'' AS ${c}`));
  const order = orderBy.filter((c) => cols.has(c)).map((c) => `${c} DESC`);
  const tail = order.length ? ` ORDER BY ${order.join(', ')}, id DESC` : ' ORDER BY id DESC';
  return dbQuery<Record<string, unknown>>(`SELECT ${[...head, ...rest].join(', ')} FROM ${table}${tail}`);
}

/** 一行旧图 → 唯一图片仓；返回新 id（0 = 跳过） */
function landLegacyRow(
  row: Record<string, unknown>,
  source: string,
  result: LegacyImageMigrationResult,
): number {
  const localPath = String(row.local_path ?? '').trim();
  if (!localPath || !fs.existsSync(localPath)) {
    result.skipped += 1;
    return 0;
  }
  let buf: Buffer;
  try {
    buf = fs.readFileSync(localPath);
  } catch {
    result.skipped += 1;
    return 0;
  }
  try {
    // `landImageBytes` 自带两级去重（URL 指纹 → 内容指纹）：同一张图被旧表记了两行时
    // 只会得到同一个 md id（这正是"一张图只有一个色结论"的前提）。
    const landed = landImageBytes(buf, {
      sourceUrl: String(row.source_url ?? ''),
      urlFingerprint: String(row.url_fingerprint ?? ''),
      source,
    });
    result.landed += 1;
    return Number(landed.imageId) || 0;
  } catch {
    // 内容不是受支持图片（历史脏文件）—— 跳过它，不要让整次启动失败
    result.skipped += 1;
    return 0;
  }
}

/**
 * 把旧图表的存量搬进 `md_images` 并改写三处引用（订单行 / 产品 / 采集商品）。
 * 幂等：旧表已拆 ⇒ 空转；同内容重复落盘 ⇒ 复用同一行。
 *
 * ⚠️ 必须在 `DROP TABLE <旧图>` **之前**调用（旧表是唯一的数据源）。
 */
export function migrateLegacyImages(): LegacyImageMigrationResult {
  const result = emptyResult();
  if (!LEGACY_IMAGE_TABLES.some((t) => tableExists(t))) return result;

  ensureMasterDataSchema();

  // ---- 1. 落图 + 建映射（旧表 id → md id）----
  const orderImageMap = new Map<number, number>();
  const productImageMap = new Map<number, number>();

  if (tableExists('oi_images')) {
    for (const row of selectLegacy('oi_images', [
      'url_fingerprint',
      'source_url',
      'local_path',
    ])) {
      const mdId = landLegacyRow(row, 'order-image', result);
      if (mdId) orderImageMap.set(Number(row.id), mdId);
    }
  }
  if (tableExists('pl_images')) {
    for (const row of selectLegacy('pl_images', ['local_path'])) {
      const mdId = landLegacyRow(row, 'product-image', result);
      if (mdId) productImageMap.set(Number(row.id), mdId);
    }
  }

  // ---- 2. 改写引用：产品主图（旧 `pl_images.id`；该列**没有**外键，可以先改）----
  result.remappedProducts = remapImageColumn('pl_products', productImageMap);

  // ---- 3. 改写引用：采集商品的覆盖图（`pl_item_images.item_id → pl_images.id`）----
  // 真库 `pl_item_images` 是 0 行（覆盖图从未使用过），但历史库可能有，照搬不猜。
  if (tableExists('pl_item_images') && tableExists('pl_shop_items')) {
    const picCols = columnsOf('pl_item_images');
    for (const r of picCols.has('item_id') && picCols.has('image_id')
      ? dbQuery<Record<string, unknown>>(`SELECT item_id, image_id FROM pl_item_images`)
      : []) {
      const mdId = productImageMap.get(Number(r.image_id)) || 0;
      if (!mdId) continue;
      result.remappedShopItems += dbRun(
        `UPDATE pl_shop_items SET image_id = ?
          WHERE item_id = ? AND (COALESCE(image_id, 0) = 0 OR image_id = ?)`,
        [mdId, String(r.item_id ?? ''), Number(r.image_id)],
      ).changes;
    }
  }

  // 订单行**只记映射**，改写等重建表之后（见接口注释里的外键理由）。
  if (tableExists('oi_order_items')) {
    result.orderImageMap = [...orderImageMap.entries()];
  }

  // ---- 4. 款色代表图：图行上的旧绑定 → 款色行上的 1:1 结论 ----
  // 旧语义是"一张图属于一个款色、一个色可以有很多图"；新语义是"一个色只有一张代表图"。
  // 排序 `updated_at DESC, id DESC` = 取人工**最后一次**挂的那张（比"最小 id"更接近用户意图）。
  if (tableExists('oi_images') && tableExists('oi_style_colors')) {
    const seen = new Set<number>();
    for (const row of selectLegacy('oi_images', ['style_color_id'], ['updated_at'])) {
      const scId = Number(row.style_color_id) || 0;
      const mdId = orderImageMap.get(Number(row.id)) || 0;
      if (!scId || !mdId) continue;
      if (!dbGet<{ id: number }>(`SELECT id FROM oi_style_colors WHERE id = ?`, [scId])) {
        result.danglingBindings += 1;
        continue;
      }
      if (seen.has(scId)) {
        result.droppedBindings += 1;
        continue;
      }
      seen.add(scId);
      result.bindings.push({ styleColorId: scId, imageId: mdId });
    }
  }

  return result;
}

/**
 * 订单行 `image_id` 的改写 —— **必须在 `oi_order_items` 重建之后调用**。
 *
 * 旧形状里这一列带 `REFERENCES oi_images(id) ON DELETE CASCADE`：在拆旧表之前把值改成
 * `md_images` 的 id 会命中外键校验（`FOREIGN KEY constraint failed`，2026-10-30 演练实测）。
 * `retireLegacyImageTables` 的重建表用的是新 DDL（不带这条外键），所以只能放在那之后。
 *
 * @returns 被改写的行数（写回 `result.remappedOrderItems`）
 */
export function remapOrderItemImages(result: LegacyImageMigrationResult): number {
  if (!tableExists('oi_order_items') || !result.orderImageMap.length) {
    result.remappedOrderItems = 0;
    return 0;
  }
  result.remappedOrderItems = remapImageColumn(
    'oi_order_items',
    new Map(result.orderImageMap),
  );
  return result.remappedOrderItems;
}
