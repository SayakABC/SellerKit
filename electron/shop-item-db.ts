// electron/shop-item-db.ts
// 「店铺商品快照」数据访问层（采集而来 = 平台事实；与 sk_shops 店铺实体 / pl_shop_sku 人的决定解耦）。
//
// 设计边界（见 docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md §3.3 / §3.4）：
//   - pl_shop_items 只存「店里有什么」，不存「这是什么款」—— 认款写路径永远走 pl_shop_sku，两套不互写；
//   - 店铺匹配走「连接键」：先比归一化 URL（= sk_shops.shop_url），再比 storeId（= platform_shop_id）；
//     都不到 → shop_id=0 + store_key（展示用），绝不自动建店；
//   - 唯一键含 store_key：两家未登记店采到同一商品不会互相覆盖（审查 P1 修正）。

import { initDb, dbMigrate, dbGet, dbRun, dbQuery, migrate, tableExists } from './db';
import type { DbBindValue, MigrationStep } from './db';
import { normImageUrl, skuColorsByImage, toSkuKey } from './shopSku';
import { ensureShopSchema, getShop, normalizeShopUrl } from './shop-db';
import { parseSkuProps, normalizeSkuSize } from './aeMoney';

/** 采集帧 schema（与 electron/ae-receiver.ts 的 SCHEMA_SHOP_ITEM 同值） */
const SCHEMA_SHOP_ITEM = 'ae-shop-item/v1';

/**
 * 「商品ID 反查店铺」一次最多查多少个 ID。
 * SQLite 的变量上限（老版本 999）决定了 `IN (...)` 不能无限展开；采集帧常见几十条，
 * 一帧超过这个数只查前 N 条 —— 仍然是"有证据就用、没查到的回落原文匹配"，
 * 不会因为量太大而把整帧判成未登记。
 */
const ITEM_SHOP_LOOKUP_LIMIT = 500;

/**
 * 队列用全量索引的行数上限（防病态库把一次页面打开拖成几秒）。
 * 采集商品总量远小于这个数；真超了只是索引里少几行 ⇒ 那几行仍显示"店铺未归一"，
 * 与"没采到过"同一个表现，不会错认。
 */
const ITEM_SHOP_INDEX_LIMIT = 200000;

// ---- 本地小工具（与 shop-db 同口径，避免跨文件引入私有助手） ----
function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}
function safeJson(v: unknown): string {
  if (v === undefined || v === null) return '';
  try {
    return JSON.stringify(v);
  } catch {
    return '';
  }
}

// ---- 类型（与渲染层 src/types.ts 对应结构保持一致；两端各自声明，避免主进程 import 渲染层） ----

/** 单条采集商品（帧 items[] 的归一后形态） */
export interface ShopItemIngestItem {
  itemId: string;
  title?: string;
  imageUrl?: string;
  priceText?: string;
  category?: string;
  status?: string;
  url?: string;
  skus?: unknown[];
  /** 来源：'ae-scrape' 扩展采集（缺省）/ 'manual' 主机端手贴商品ID（保底通道）。
   *  为什么要有这一列：「手贴的」和「采来的」在表上必须分得开 —— 手贴行没有标题/图，
   *  长得和「采集失败」一模一样，用户会以为采到了脏数据。 */
  source?: string;
}

/**
 * SKU 矩阵快照行（sku_json 的规范形；建款向导直接消费）。
 *
 * 为什么在**采集落库时**就解析：props 的两种形式（`Color:Red;Size:L` / `Red+L+China`）
 * 订单侧已有唯一口径（`aeMoney.parseSkuProps`）—— 渲染层再解析一遍就是第二套口径，
 * 两边一漂，向导预填的色/码与订单归类的色/码会对不上。原文整条保留在 raw_json，不丢信息。
 *
 * `imageUrl` = 这一色的代表图（详情页 SKU 矩阵"选色换图"那张；方案 §8.2：色→图 1:1，
 * 码不单独配图）。列表页轻采不带 ⇒ 空串（"不存在"与"零"分开，不拿主图冒充色图）。
 */
export interface ShopItemSkuRow {
  color: string;
  size: string;
  price: string;
  imageUrl: string;
  /**
   * 克重（克）。**人补的**：采集端不产这个字段；0/缺省 = 没填，序列化时**不写这个 key**
   * （存量快照形状不变，`raw_json` 里也一眼看得出"这行有人补过克重"）。
   * 下游：`pl_shop_items.sku_json` → 建款向导预填 → `pl_variants.weight_g`。
   */
  weightG?: number;
}

/** 采集帧（ae-shop-item/v1） */
export interface ShopItemIngestPayload {
  schema: string;
  store: { url?: string; storeId?: string; name?: string };
  items: ShopItemIngestItem[];
}

export interface ShopItemUpsertResult {
  received: number;
  inserted: number;
  updated: number;
  skipped: number;
}

/** 列表/汇总返回的快照行（驼峰，渲染层直接消费） */
export interface ShopItemRow {
  id: number;
  shopId: number;
  /** 店铺平台（来自 sk_shops；'' = 未登记 —— 没有平台就不能写映射，与队列同一纪律） */
  platform: string;
  /** 店铺名（来自 sk_shops；未登记 = ''，界面回落 storeKey） */
  shopName: string;
  storeKey: string;
  itemId: string;
  title: string;
  imageUrl: string;
  imageId: number;
  priceText: string;
  category: string;
  status: string;
  url: string;
  skuJson: string;
  source: string;
  scrapedAt: number;
  /** 已认到哪个产品（pl_shop_sku 最新一条 confirmed；0 = 没认过） */
  mappedProductId: number;
  /** 已认产品的款编码（展示用；产品已删时为 ''） */
  mappedProductCode: string;
  createdAt: string;
  updatedAt: string;
}

export interface ShopItemListQuery {
  shopId?: number;
  search?: string;
  page?: number;
  pageSize?: number;
  /** 只看没认过款的（服务端过滤 —— 客户端过滤会把分页页掏空） */
  onlyUnconfirmed?: boolean;
  /** 只看「当前认到这个款」的采集行（产品编辑「从采集商品导入」用；按最新一条 confirmed 映射判） */
  productId?: number;
}

export interface ShopItemSummaryRow {
  shopId: number;
  storeKey: string;
  total: number;
  confirmed: number;
  lastScrapedAt: number;
}

/**
 * 「这家店已经采到过 SKU 的哪些款」——扩展跨轮去重的**真源头**（2026-10-18）。
 *
 * ⭐⭐ 为什么必须是宿主而不是扩展自己的台账：扩展的 `aeWalkSeen` 只记「**这一套扩展**
 * 在**这个浏览器**采过的款」。它对下列场景**一无所知**，于是「第二次点采集」会把
 * 早已入库的款全部重采一遍（用户报障：库里已有 40 条，仍采了 63 条）：
 *   · 用户**第一次**用的就是旧版扩展（没有 seen 台账）→ 升级后第一次点采集必然全量重跑；
 *   · 换浏览器 / 清扩展数据 / 换机器 → 台账空；
 *   · 扩展重装、storage 被清。
 * 而「采没采到过」的**事实**在库里（`pl_shop_items` 有行）⇒ 宿主才是权威。
 *
 * ⚠️⚠️ **只返回「采到过 SKU 矩阵」的款**（`sku_json` 非空且非 `[]`），这不是保守而是必需：
 * 采集分两层 —— 列表轻采（无 SKU）与详情重采（带 SKU 矩阵）。用户在列表阶段跑完就停，
 * 库里就有**只有列表信息**的行（`sku_json='[]'`）；若把它们当"已采过"让扩展跳过，
 * 那些款**永远拿不到 SKU 矩阵**，而界面上看着"库里已有、不用再采"—— 静默丢数据。
 * 「存在」≠「采到」，去重表必须按真正采到的那一层算。
 *
 * 返回的 `itemIds` 同时覆盖**两种身份匹配结果**：匹配到已登记店 → 该店的行；
 * 匹配落未登记桶 → 该桶的行（否则"店还没登记"的用户永远去不了重）。
 * 匹配口径与 `upsertShopItems` **同一个函数**（`matchShopByStore`）—— 两处口径分叉
 * 会导致"问的时候算 A 店、写的时候算 B 桶"，去重直接失效。
 */
export function listScrapedItemIds(store: { url?: string; storeId?: string; name?: string }): {
  shopId: number;
  storeKey: string;
  itemIds: string[];
} {
  ensureSchema();
  const { shopId, storeKey } = matchShopByStore(store || {});
  const rows = dbQuery<{ item_id: string }>(
    `SELECT item_id FROM pl_shop_items
      WHERE shop_id = ? AND store_key = ?
        AND sku_json IS NOT NULL AND sku_json <> '' AND sku_json <> '[]'`,
    [shopId, storeKey],
  );
  return { shopId, storeKey, itemIds: rows.map((r) => String(r.item_id || '')).filter((x) => !!x) };
}

// ---- 建表 ----

const SCHEMA = [
  // `pl_shop_items`：店铺商品**快照**（采集而来的平台事实，只存"店里有什么"，不认款）。
  // 唯一键 `(shop_id,store_key,item_id)`：两家未登记店采到同一商品不互相覆盖；`shop_id=0` + `store_key`
  // 表示还没认出是哪家店（**绝不自动建店**）。认款写路径永远走 `pl_shop_sku`，两套不互写。
  // 写 = AE 店铺采集（`shop-item-db`）；读 = 商品池 / 映射候选 / 店铺商品列表。
  `CREATE TABLE IF NOT EXISTS pl_shop_items (
    -- 用途：店铺商品快照（采集的平台事实，只存"店里有什么"，不认款）；shop_id=0 + store_key 表示未认出的店。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_id INTEGER NOT NULL DEFAULT 0,
    store_key TEXT NOT NULL DEFAULT '',
    item_id TEXT NOT NULL,
    title TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    image_id INTEGER NOT NULL DEFAULT 0,
    price_text TEXT NOT NULL DEFAULT '',
    category TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    url TEXT NOT NULL DEFAULT '',
    sku_json TEXT NOT NULL DEFAULT '',
    raw_json TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'ae-scrape',
    scraped_at INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(shop_id, store_key, item_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pl_shop_items_shop ON pl_shop_items(shop_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pl_shop_items_item ON pl_shop_items(item_id)`,
  // 收养记忆：采集帧的「展示名键」→ 已登记店。治「收养只跑一次、之后再采又落未登记桶」。
  // 见 matchShopByStore 第 4 级证据与 backfillStoreKeyMemory 迁移。
  `CREATE TABLE IF NOT EXISTS pl_shop_store_keys (
    -- 用途：采集「展示名键」→ 已登记店 的收养记忆（防治"收养只跑一次、再采又落未登记桶"）。
    store_key TEXT PRIMARY KEY,
    shop_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
];

export function ensureShopItemSchema(): void {
  initDb();
  dbMigrate(SCHEMA);
  // 演进步骤：dbMigrate 只管"新库建到当前形状"，存量数据要靠版本化迁移追上来
  migrate('shop-item.main', shopItemMigrationSteps());
}

/** `pl_shop_items` 的演进步骤（版本化：只跑未应用的，见 `electron/db.ts` 的 `migrate`） */
function shopItemMigrationSteps(): MigrationStep[] {
  return [
    {
      version: 1,
      name: '存量 sku_json 的尺码按采集口径归一（剥掉体重区间 / 版型前缀 / 括号补注）',
      up: normalizeStoredSkuSizes,
    },
    {
      version: 2,
      name: '合并「未登记桶 × 已登记店」的同款重复行 + 回填收养记忆（store_key → shop_id）',
      up: mergeDuplicateUnregisteredRows,
    },
  ];
}

/**
 * v2 迁移（2026-10-18 用户报障「采集没去重、且都落在未关联店铺」）：
 * 同一款商品在 `pl_shop_items` 里存了两行 —— 一行 `shop_id=<已登记店>`（用户登记那刻
 * `adoptShopItemsForShop` 搬过去的），一行 `shop_id=0`（登记之后又采一次、匹配落空、
 * 收养不重跑 ⇒ 新行留在未登记桶）。真库实测：九店 40 条 / 未登记桶 63 条，**交集 40**
 * （两侧 SKU 与标题逐字相同 —— 纯重复，不是两次不同的采集结果）。
 *
 * 三步（每步都可单独判真伪）：
 *   ① 记忆回填：按 `sk_shops` 的三个身份键（店名 / 归一 URL / storeId）反查未登记桶的
 *      `store_key`，把能认出的桶键登记进 `pl_shop_store_keys`（记忆表）；
 *   ② 桶内无主行收养：能认出的桶里、且该店**还没有**同 item_id 行的，直接搬进该店；
 *   ③ 同款重复行：认出的桶里、该店**已经有**同 item_id 行的 —— 把未登记那行**删掉**
 *      （它已是冗余副本；数据以已登记那行为准）。
 *
 * ⚠️ 为什么第 ③ 步敢删：`upsertShopItems` 的「只覆盖非空」保证先落的那行不会被后落
 * 的清空字段，而两行同款时**后落的那行才是最新事实**（`scraped_at` 更大）。所以合并
 * 方向是「已登记行的字段 ← 未登记行的非空值」，同时 `scraped_at` 取较新者 ——
 * 删掉的是旧副本，不是新事实。
 *
 * ⚠️ 认不出的桶（`store_key` 与任何已登记店都对不上）**一律不动**：那是真的"店还没
 * 登记"，用户看到"未关联店铺"是正确提示，静默塞进某家店才是把两家的货混在一起。
 */
function mergeDuplicateUnregisteredRows(): void {
  // ⚠️ **不要**在这里调 ensureSchema()/ensureShopItemSchema()：`ensureShopItemSchema` 本身
  //   就会跑 migrate() ⇒ 迁移体回调本函数 ⇒ 无限递归。记忆表 DDL 由 dbMigrate(SCHEMA)
  //   在 migrate() 之前建好（SCHEMA 已含该表），此处直接查即可。
  // ⚠️ `sk_shops` 是**店铺域**的表，本迁移跑在 `ensureShopItemSchema()` 里，而那一层的
  //   契约是「不保证店铺域已建」（全新库上 `sk_shops` 可能还不存在）。按 db.ts 的跨域
  //   读纪律：缺表**降级**（没有已登记店 ⇒ 没有可认的桶、无可回填的记忆，本步无事可做），
  //   而不是抛 `no such table` —— 那会被误读成"迁移 SQL 坏了"，排查方向整个反掉。
  if (!tableExists('sk_shops')) return;
  const shops = dbQuery<{ id: number; name: string; platform_shop_id: string; shop_url: string }>(
    `SELECT id, name, platform_shop_id, shop_url FROM sk_shops`,
  );
  // 桶键 → 店 id（重名店取 id 最小，与 matchShopByStore 店名级同档）
  const keyToShop = new Map<string, number>();
  for (const s of shops) {
    for (const key of [
      String(s.name || '').trim(),
      normalizeShopUrl(s.shop_url),
      String(s.platform_shop_id || '').trim(),
    ]) {
      if (!key) continue;
      const cur = keyToShop.get(key);
      if (!cur || Number(s.id) < cur) keyToShop.set(key, Number(s.id) || 0);
    }
  }
  const buckets = dbQuery<{ store_key: string }>(
    `SELECT DISTINCT store_key FROM pl_shop_items WHERE shop_id = 0 AND store_key <> ''`,
  );
  for (const b of buckets) {
    const key = String(b.store_key || '').trim();
    if (!key) continue;
    const shopId = keyToShop.get(key) || 0;
    if (!shopId) continue; // 认不出的桶：不动（正确提示「店还没登记」比错挂强）
    dbRun(
      `INSERT INTO pl_shop_store_keys (store_key, shop_id) VALUES (?, ?)
       ON CONFLICT(store_key) DO UPDATE SET shop_id = excluded.shop_id`,
      [key, shopId],
    );
    const dup = dbQuery<{ id: number; item_id: string }>(
      `SELECT id, item_id FROM pl_shop_items
        WHERE shop_id = 0 AND store_key = ?
          AND EXISTS (SELECT 1 FROM pl_shop_items x WHERE x.shop_id = ? AND x.item_id = pl_shop_items.item_id)`,
      [key, shopId],
    );
    // ③ 先合并字段再删副本（已登记行的空字段 ← 未登记行的非空值；scraped_at 取较新者），
    //    最后才删行。逐条读写而不是一条 UPDATE + 六个子查询：同表自引用子查询在 SQLite 里
    //    读的是「本次 UPDATE 之前」的快照，写起来绕、验起来更难读。
    for (const d of dup) {
      const keep = dbGet<{ id: number }>(
        `SELECT id FROM pl_shop_items WHERE shop_id = ? AND item_id = ?`,
        [shopId, d.item_id],
      );
      if (!keep) continue;
      const src = dbGet<Record<string, unknown>>(
        `SELECT title, image_url, price_text, category, status, url, sku_json, raw_json, source, scraped_at
           FROM pl_shop_items WHERE id = ?`,
        [d.id],
      );
      const dst = dbGet<Record<string, unknown>>(
        `SELECT title, image_url, price_text, category, status, url, sku_json, scraped_at
           FROM pl_shop_items WHERE id = ?`,
        [Number(keep.id)],
      );
      const nz = (v: unknown): string => String(v ?? '');
      // 已登记行为空 ⇒ 取未登记行的值；两边都有值 ⇒ 保留已登记行那份（先采的那次）
      const pick = (a: unknown, b: unknown): string => (nz(a) ? nz(a) : nz(b));
      const skuA = nz(dst?.sku_json);
      const skuB = nz(src?.sku_json);
      // sku_json 只在「已登记行为空 / []」时取未登记行那份（`upsertShopItems` 的同一口径）
      const mergedSku = skuA && skuA !== '[]' ? skuA : skuB;
      dbRun(
        `UPDATE pl_shop_items SET
            title = ?, image_url = ?, price_text = ?, category = ?, status = ?, url = ?,
            sku_json = ?, scraped_at = ?
          WHERE id = ?`,
        [
          pick(dst?.title, src?.title),
          pick(dst?.image_url, src?.image_url),
          pick(dst?.price_text, src?.price_text),
          pick(dst?.category, src?.category),
          pick(dst?.status, src?.status),
          pick(dst?.url, src?.url),
          mergedSku,
          // 采集时间取较新者：重复的两行是同一款被采了两次，后采的那次才是最新事实
          Math.max(Number(src?.scraped_at) || 0, Number(dst?.scraped_at) || 0),
          Number(keep.id),
        ],
      );
      dbRun(`DELETE FROM pl_shop_items WHERE id = ?`, [d.id]);
    }
    // ② 剩下的（该店还没有同 item_id）搬进该店，store_key 归一为 ''
    dbRun(
      `UPDATE pl_shop_items SET shop_id = ?, store_key = ''
        WHERE shop_id = 0 AND store_key = ?
          AND NOT EXISTS (SELECT 1 FROM pl_shop_items x WHERE x.shop_id = ? AND x.item_id = pl_shop_items.item_id)`,
      [shopId, key, shopId],
    );
  }
}

/**
 * v1 迁移：把**已经落库**的 `sku_json` 按 `normalizeSkuSize` 重写一遍。
 *
 * 为什么必须回填而不是"新采集时自然收敛"：脏值已经在库里（真库 546 条里 120 条带修饰），
 * 而列表/矩阵/建款向导都直接读它 —— 不回填等于"修了代码但用户看到的一模一样"，
 * 得等下一次详情页采集才变（那可能是几周后，且只覆盖被重采过的那几款）。
 *
 * ⚠️ 与所有迁移同一条纪律（见 `electron/db.ts`）：
 *   · **不改 `scraped_at` / `updated_at`** —— 这是口径修正，不是"重新采过"、也不是人改过；
 *     拿它冒充采集时间会让「最近采集」状态条说假话；
 *   · **不动 `raw_json`** —— 平台原文必须留得住（人才能查"平台当时写的是什么"）；
 *   · 解析不了的行**原样留着**（`sku_json` 可能是历史损坏值）：静默清成 `[]` 等于删数据。
 */
function normalizeStoredSkuSizes(): void {
  const rows = dbQuery<{ id: number; sku_json: string }>(
    `SELECT id, sku_json FROM pl_shop_items WHERE sku_json <> ''`,
  );
  for (const r of rows) {
    let list: unknown;
    try {
      list = JSON.parse(r.sku_json);
    } catch {
      continue;
    }
    if (!Array.isArray(list)) continue;
    let changed = false;
    const next = list.map((x) => {
      if (!x || typeof x !== 'object') return x;
      const row = x as Record<string, unknown>;
      const raw = typeof row.size === 'string' ? row.size : '';
      const size = normalizeSkuSize(raw).slice(0, 40);
      if (size === raw) return x;
      changed = true;
      return { ...row, size };
    });
    if (changed) dbRun(`UPDATE pl_shop_items SET sku_json=? WHERE id=?`, [safeJson(next), r.id]);
  }
}

/**
 * 本文件所有入口共用的初始化：建本域表，**顺带把店铺域拉起来**。
 *
 * ⚠️ 为什么不能只建自己的表：本文件的读链有 `LEFT JOIN sk_shops`（listShopItems / getShopItemRow）、
 * 匹配链会 `SELECT ... FROM sk_shops`（matchShopByStore），而「店铺商品」页的读链**只经本文件**
 * （店铺域自己的 ensureShopSchema 只在 shop-handlers 各入口调用）。全新库第一站就是这一页时
 * `sk_shops` 从未被建过 ⇒ 直接报 `no such table: sk_shops`（2026-10-15 实测，且**只在全新库上出现**）。
 * 同款先例：`shop-product-db.ts` 的 ensureSchema 顺带 ensureProductSchema/ensureSkuSchema ——
 * 表由 owner 建、DDL 只留一份（这里 import 店铺域的 ensure，不自己抄一份建表语句）。
 */
function ensureSchema(): void {
  ensureShopItemSchema();
  ensureShopSchema();
}

// ---- 店铺匹配（连接键） ----

/**
 * 按证据强度匹配店铺实体（sk_shops）：
 *   0. **人点名的 id**（pinnedShopId）—— 手贴保底通道里用户从下拉里选了店，这是最强证据；
 *   1. 归一化 URL == sk_shops.shop_url（最稳，等价于 platform_shop_id 的角色）；
 *   2. storeId == platform_shop_id；
 *   3. 店名 == sk_shops.name（trim 后全等；2026-10-17 补的第三级）；
 *   4. **收养记忆**：store_key == pl_shop_store_keys.store_key（2026-10-18 补的第四级）；
 *   5. 都不到 → 返回 shop_id=0 + store_key（展示用归一名，不自动建店）。
 * 入参 store 可为空对象（兼容扩展只发了 items 没发 store 的情况，此时全部落未登记）。
 *
 * ⚠️ 为什么 pin 必须压过 1/2（审查 P1-1）：`shop_url` 与 `platform_shop_id` 在 sk_shops 里
 * **都是可选字段**（P0 之前登记的店两个都空），1、2 必然落空 ⇒ 只按证据走的话，用户明明
 * 选了「我的店A」，行却写进 shop_id=0 未登记桶，界面还回报"已接收 N 条"。
 * 点名是**严格**的：给了 id 就必须是这家店；id 拿不到（店已被删）由调用方**报错**，
 * 绝不静默回落未登记桶 —— 回落就是把"用户以为做了"伪装成"数据做了"。
 *
 * ⚠️ 第 3 级（店名）是 2026-10-17 补的：用户实测"采集的商品没归到已登记的店，
 * 把店铺名称改成和采到的一致才归位"。根因不是前后空格（帧侧 `store.name` 在扩展里
 * 已 trim、落 store_key 前再 trim 一次；收养侧 `adoptShopItemsForShop` 也 trim）——
 * 根因是**登记的店没填店铺地址/店铺ID 时，1、2 两级恒落空**，而落库匹配从来不看店名，
 * 只有"店铺登记保存"触发的收养按店名收 —— 于是"先登记后采集"的帧永远落未登记桶。
 * 收养本来就按「店名 → URL → storeId」收（同一个用户动作链），落库匹配补上店名只是
 * 把同一条弱证据在两条路径上对齐：不自动建店，只认已经登记过的店。重名店按 id 最小
 * （最早登记的那家）落，与"收养不挑店"比这是更保守的一档；真重名的错挂由人改店名解。
 *
 * ⭐⭐ 第 4 级（收养记忆，2026-10-18）是**为「收养只跑一次」而设**：
 * 1~3 级全是**当前登记值**的比对，而收养发生在"用户登记店铺"那一次动作里 —— 登记之后
 * 用户若没再点保存，收养永不重跑。此时若用户当初没把 URL/店铺ID 填对（真库九店就是这样：
 * `platform_shop_id` 填成了店名 `Shop1105671703 Store`、URL 数字填成 `1105671703` 而真实
 * storeId 是 `1105668759`），1~3 级会**恒落空** ⇒ 之后每次采集都落未登记桶 ⇒ 同一款在
 * 「已登记店」和「未登记桶」各存一行（实测 40 条重复）。
 * 记忆表把"这个桶键上次被收养进了哪一家"记下来，让同键的帧**直接命中那家店**。
 * 它只在**用户已经登记过**的前提下生效（键来自 `adoptShopItemsForShop` / v2 迁移，
 * 两者都以 `sk_shops` 里有这家店为前提）⇒ 仍然不自动建店、不跨店乱挂。
 */
export function matchShopByStore(
  store: {
    url?: string;
    storeId?: string;
    name?: string;
  },
  pinnedShopId?: number,
): { shopId: number; storeKey: string } {
  const pin = Number(pinnedShopId) || 0;
  if (pin > 0) {
    // pin 只在店铺真的存在时生效：否则会写出 shop_id 悬空的行（JOIN 不到平台 ⇒ 认不了款，
    // 比落未登记桶更难发现）。存在性由调用方先校验，这里是防线不是主路。
    const pinned = dbGet<{ id: number }>(`SELECT id FROM sk_shops WHERE id = ?`, [pin]);
    if (pinned) return { shopId: pinned.id, storeKey: '' };
  }
  const url = normalizeShopUrl(store?.url);
  const storeId = typeof store?.storeId === 'string' ? store.storeId.trim() : '';
  let shopId = 0;
  if (url) {
    const hit = dbGet<{ id: number }>(`SELECT id FROM sk_shops WHERE shop_url = ?`, [url]);
    if (hit) shopId = hit.id;
  }
  if (!shopId && storeId) {
    const hit = dbGet<{ id: number }>(`SELECT id FROM sk_shops WHERE platform_shop_id = ?`, [storeId]);
    if (hit) shopId = hit.id;
  }
  if (!shopId) {
    // 第三级证据：店名全等（两侧都 trim；库里存的名可能是老数据带尾空格，SQL trim 兜住）
    const name = typeof store?.name === 'string' ? store.name.trim() : '';
    if (name) {
      const hit = dbGet<{ id: number }>(
        `SELECT id FROM sk_shops WHERE trim(name) = ? ORDER BY id LIMIT 1`,
        [name],
      );
      if (hit) shopId = hit.id;
    }
  }
  if (shopId) return { shopId, storeKey: '' };
  // 未登记行的 store_key 就是「店名 → 归一 URL → storeId」三键按序取第一个非空，
  // 这里用**同一优先级**去查记忆：桶键对上了就直接回那家已登记店。
  const candidates = [
    typeof store?.name === 'string' ? store.name.trim() : '',
    url,
    storeId,
  ].filter((k) => !!k);
  for (const key of candidates) {
    const hit = dbGet<{ shop_id: number }>(
      `SELECT k.shop_id AS shop_id FROM pl_shop_store_keys k
         JOIN sk_shops s ON s.id = k.shop_id
        WHERE k.store_key = ?`,
      [key],
    );
    // JOIN sk_shops 是必要的防线：记忆表里的店可能已被删 ⇒ 落一个悬空 shop_id
    // 比落未登记桶更难发现（界面显示店名、认款却写不进去）。
    if (hit && Number(hit.shop_id) > 0) {
      shopId = Number(hit.shop_id);
      break;
    }
  }
  if (shopId) return { shopId, storeKey: '' };
  const key =
    (typeof store?.name === 'string' && store.name.trim()) ||
    url ||
    (typeof store?.storeId === 'string' ? store.storeId.trim() : '');
  return { shopId: 0, storeKey: key.slice(0, 200) };
}

/**
 * 记下「这个桶键 ⇒ 已登记店 id」（收养记忆表的唯一写入口）。
 * 只在**用户已登记该店**的前提下调用（`adoptShopItemsForShop` 与 v2 迁移）；
 * 键为空或店不存在则不写 —— 记忆表的每一条都必须有 `sk_shops` 里的实体撑着。
 */
export function rememberStoreKeyForShop(shopId: number, storeKey: unknown): void {
  const sid = Number(shopId) || 0;
  const key = String(storeKey ?? '').trim().slice(0, 200);
  if (!sid || !key) return;
  if (!dbGet<{ id: number }>(`SELECT id FROM sk_shops WHERE id = ?`, [sid])) return;
  try {
    dbRun(
      `INSERT INTO pl_shop_store_keys (store_key, shop_id) VALUES (?, ?)
       ON CONFLICT(store_key) DO UPDATE SET shop_id = excluded.shop_id`,
      [key, sid],
    );
  } catch {
    /* 记忆表写不进不影响落库本身（最坏结果 = 又落未登记桶，人工改一下店铺地址即可归位） */
  }
}

/**
 * 商品ID → **已登记店铺 id**（采集快照的反向证据）。
 *
 * 为什么需要：`matchShopByStore` 的 1~4 级证据全部来自**帧自带的店铺身份**
 * （归一 URL / storeId / 店名 / 桶键记忆）。扩展没采到 `store`、或用户把
 * `platform_shop_id` 填成了店名这类情况，四级会**同时落空** ⇒ 商品进未登记桶、
 * 订单侧 `resolveOrderSku` 又因"店铺没归一"直接返回 null（用户看到的症状是
 * "配了映射却不生效"）。而 `pl_shop_items` 的键本来就是 `(shop_id, store_key, item_id)`
 * —— **商品ID 自己就能反证店**：这个商品当初归在哪家已登记店名下。
 *
 * 三条边界（都是为了"不猜"）：
 *   · 只认 `shop_id > 0` **且该店仍存在于 `sk_shops`**（店已删 ⇒ 悬空 id 比未登记桶更难查）；
 *   · 命中**多家**店 = 歧义 ⇒ 返回 0，交回原文匹配 / 人工，绝不按 id 最小挑一个；
 *   · 只作**兜底**：原文匹配成功时不得调用（人填的归一永远压过这条推断）。
 *
 * @param itemIds 帧内 / 订单行的商品ID（去重、截断到 `ITEM_SHOP_LOOKUP_LIMIT` 防 SQL 变量超限）
 * @returns 0 = 没采到过 / 采到的都在未登记桶 / 多店歧义
 */
export function shopIdByItemIds(itemIds: readonly unknown[]): number {
  // 两个表都按域懒建：订单/店铺域未初始化时这里必须安静返回 0（不能抛 no such table）
  if (!tableExists('pl_shop_items') || !tableExists('sk_shops')) return 0;
  const ids = [...new Set((Array.isArray(itemIds) ? itemIds : []).map((x) => toSkuKey(x)).filter((x) => !!x))].slice(
    0,
    ITEM_SHOP_LOOKUP_LIMIT,
  );
  if (!ids.length) return 0;
  const rows = dbQuery<{ shop_id: number }>(
    `SELECT DISTINCT i.shop_id AS shop_id
       FROM pl_shop_items i
       JOIN sk_shops s ON s.id = i.shop_id
      WHERE i.shop_id > 0 AND i.item_id IN (${ids.map(() => '?').join(',')})
      LIMIT 2`,
    ids,
  );
  const shops = [...new Set(rows.map((r) => Number(r.shop_id)).filter((x) => x > 0))];
  // 两条不同的 shop_id 就说明有歧义（LIMIT 2 已足够判定）；恰好一家才算证据
  return shops.length === 1 ? shops[0] : 0;
}

/** 单商品版（订单行 / 队列行只有一条 itemId） */
export function shopIdByItemId(itemId: unknown): number {
  return shopIdByItemIds([itemId]);
}

/**
 * 全量索引 `item_id → 唯一已登记 shop_id`，给「待关联队列」这类**要按行批量认店**的场景。
 *
 * 为什么不让队列逐行调 `shopIdByItemId`：那是每行一条 SQL，待办上千行时就是上千次往返；
 * 这里一次查完。两处的判定**同一条规则**：同一 itemId 命中多家店 = 歧义 = **不进索引**，
 * 即"宁可显示店铺未归一，也不猜是哪家"。
 *
 * ⚠️ 调用方须自行按需加载（队列只在真的出现未认店分组时才建），别在热路径上无条件调用。
 */
export function itemShopIndex(): Map<string, number> {
  const index = new Map<string, number>();
  if (!tableExists('pl_shop_items') || !tableExists('sk_shops')) return index;
  const ambiguous = new Set<string>();
  for (const r of dbQuery<{ item_id: string; shop_id: number }>(
    `SELECT i.item_id AS item_id, i.shop_id AS shop_id
       FROM pl_shop_items i
       JOIN sk_shops s ON s.id = i.shop_id
      WHERE i.shop_id > 0
      LIMIT ?`,
    [ITEM_SHOP_INDEX_LIMIT],
  )) {
    const key = toSkuKey(r.item_id);
    const shopId = Number(r.shop_id) || 0;
    if (!key || !shopId) continue;
    const prev = index.get(key);
    if (prev === undefined) index.set(key, shopId);
    else if (prev !== shopId) ambiguous.add(key);
  }
  for (const key of ambiguous) index.delete(key);
  return index;
}

/**
 * 用**订单行上的那张图**反查采集快照里它属于哪个颜色（`sku_json[].imageUrl` → `color`）。
 *
 * 业务前提（2026-10-19 在真实库上验过，不是推测）：订单报表的「产品图片链接」列是
 * **逐单的 SKU 图**，不是商品主图 —— 同一商品ID 的 9 条订单对应 4~6 张不同图片；
 * 且这 2 条能对上采集商品的订单，其图片与 `sku_json[].imageUrl` **逐字节相同**。
 * 这给了多色商品一条确定性定色途径：一个商品ID 下有 8 个印花时，订单落哪一色不必再靠人眼。
 *
 * 判定规则（"不猜"是硬约束）：
 *   · 同一 itemId 可能有多行采集快照（不同店），**合起来**看，答案必须**全局唯一**；
 *   · 一张图对不上任何色 / 对上多个色（卖家多色共用一张图）⇒ 返回 `''`，
 *     调用方回落到原有序（订单原文色 → 未分类）。多个色时**绝不取第一个**。
 *
 * @returns `''` = 定不了（没采到过 / 图不在 SKU 图里 / 歧义）
 */
export function skuColorByItemImage(itemId: unknown, imageUrl: unknown): string {
  const id = toSkuKey(itemId);
  if (!id || !tableExists('pl_shop_items')) return '';
  if (!normImageUrl(imageUrl)) return '';
  const rows = dbQuery<{ sku_json: string }>(
    `SELECT sku_json FROM pl_shop_items WHERE item_id = ? LIMIT ?`,
    [id, ITEM_SHOP_LOOKUP_LIMIT],
  );
  const colors = new Set<string>();
  for (const r of rows) {
    let parsed: unknown = [];
    try {
      parsed = JSON.parse(String(r.sku_json ?? '[]'));
    } catch {
      continue; // 一条脏 sku_json 不该毁掉整次判定
    }
    for (const c of skuColorsByImage(Array.isArray(parsed) ? parsed : [], imageUrl)) colors.add(c);
  }
  return colors.size === 1 ? [...colors][0] : '';
}

// ---- 落库（接收端调用） ----

/** 帧内单条商品消毒：必填 itemId，其余缺省即空。返回 null 表示整条跳过。 */
export function sanitizeShopItem(raw: unknown): ShopItemIngestItem | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const itemId = toSkuKey(r.itemId);
  if (!itemId) return null;
  return {
    itemId,
    title: str(r.title, 500),
    imageUrl: str(r.imageUrl, 1000),
    priceText: str(r.priceText, 100),
    category: str(r.category, 100),
    status: str(r.status, 40),
    url: str(r.url, 1000),
    skus: Array.isArray(r.skus) ? r.skus : undefined,
    source: str(r.source, 40) || 'ae-scrape',
  };
}

/**
 * 采集帧的单条 SKU → 规范形。显式 color/size 优先，否则按 props 解析
 * （与订单侧同一函数）。三条全空 → null（整行跳过：空行占着矩阵位只会让人以为漏采了）。
 * `imageUrl` 缺省即空串 —— 列表轻采没有色图，不拿商品主图冒充（色图采纳据此判断"采没采到"）。
 *
 * ⭐ **尺码在这里剥一次修饰**（`normalizeSkuSize`）：卖家常把体重区间写进尺码字段
 * （`XL 60-65kg`）、或加版型前缀（`Asian size XXXL`）、或加括号补注（`XS（old）`），
 * 原样落库会让矩阵列头一个码占四列，看着像"采到了四种尺码"。剥的是修饰不是整行 ——
 * 详细取证与三条保守纪律见 `aeMoney.normalizeSkuSize`。
 */
export function normalizeIngestSku(raw: unknown): ShopItemSkuRow | null {
  if (!raw || typeof raw !== 'object') return null;
  const r = raw as Record<string, unknown>;
  const parsed = parseSkuProps(typeof r.props === 'string' ? r.props : '');
  const color = str(r.color, 100) || parsed.color;
  // 先按原长读进来再归一：先截 40 再剥，可能把一个带修饰的码截成半截（`Asian size XXXL` 正好 15 字，
  // 但别的店铺会写更长），归一后的值才是要落库的那个
  const sizeSrc = str(r.size, 200) || parsed.size;
  const size = normalizeSkuSize(sizeSrc).slice(0, 40);
  const price = str(r.price, 100);
  const imageUrl = str(r.imageUrl, 1000);
  if (!color && !size && !price) return null;
  // 克重（0 = 没填）：只在 >0 时**带上这个 key** —— 存量形状不变，不写 0
  const weightSrc = Math.round(Number(r.weightG));
  const row: ShopItemSkuRow = { color, size, price, imageUrl };
  if (Number.isFinite(weightSrc) && weightSrc > 0) row.weightG = weightSrc;
  return row;
}

/**
 * 整帧落库：先按 store 匹配店铺（决定 shop_id / store_key），再逐条 upsert 快照。
 * 幂等：同一 (shop_id, store_key, item_id) 再次采集 = 覆盖更新。
 *
 * ⭐ 覆盖口径 = **只覆盖非空**（2026-10-15 修）：两个采集层级各带**一半**字段 ——
 * 列表帧没有 SKU、详情帧没有标题/图/价 —— 全字段覆盖会让后跑的那次把另一次采到的字段
 * **静默清空**（「采 SKU」清掉标题/图/价、全店重采清掉 SKU 矩阵，两个方向都可达）。
 * 空值语义 = 「这次没采到」，不是「平台上这个字段没了」（后者不存在这种事件）。
 *
 * `opts.pinnedShopId` = **人点名的店铺 id**（保底通道手贴时用）：帧本身不带身份证据
 * （扩展选择器没采到 store），身份来自用户在下拉里的选择，故单独传、不混进帧。
 */
export function upsertShopItems(
  payload: ShopItemIngestPayload,
  opts?: { pinnedShopId?: number },
): ShopItemUpsertResult {
  ensureSchema();
  const matched = matchShopByStore(payload?.store || {}, opts?.pinnedShopId);
  const items = Array.isArray(payload?.items) ? payload.items : [];
  // 兜底：帧自带的四级证据全落空时，用**帧里的商品ID** 反查「这个商品当初归在哪家已登记店」。
  // 只在唯一命中时生效（`shopIdByItemIds` 内部已挡掉多店歧义），命中后 store_key 记空 ——
  // 行归到具体店名下，不再是"未登记桶 + 展示名键"。
  const shopId = matched.shopId || shopIdByItemIds(items.map((it) => it?.itemId));
  const storeKey = shopId ? '' : matched.storeKey;
  let inserted = 0;
  let updated = 0;
  let skipped = 0;
  const now = Date.now();
  for (const it of items) {
    const itemId = toSkuKey(it?.itemId);
    if (!itemId) {
      skipped += 1;
      continue;
    }
    const title = str(it.title, 500);
    const imageUrl = str(it.imageUrl, 1000);
    const priceText = str(it.priceText, 100);
    const category = str(it.category, 100);
    const status = str(it.status, 40);
    const url = str(it.url, 1000);
    const skuRows = (Array.isArray(it.skus) ? it.skus : []).map(normalizeIngestSku).filter(Boolean);
    const skuJson = safeJson(skuRows);
    const source = str(it.source, 40) || 'ae-scrape';
    const rawJson = safeJson(it);
    const existing = dbGet<{
      id: number;
      title: string;
      image_url: string;
      price_text: string;
      category: string;
      status: string;
      url: string;
      sku_json: string;
    }>(
      `SELECT id, title, image_url, price_text, category, status, url, sku_json
         FROM pl_shop_items WHERE shop_id=? AND store_key=? AND item_id=?`,
      [shopId, storeKey, itemId],
    );
    if (existing) {
      // 只覆盖非空（SKU 按"有没有行"判）；非空新值照常覆盖 —— 是"空值不覆盖"不是"一律不覆盖"
      const merged = {
        title: title || existing.title,
        imageUrl: imageUrl || existing.image_url,
        priceText: priceText || existing.price_text,
        category: category || existing.category,
        status: status || existing.status,
        url: url || existing.url,
        skuJson: skuRows.length ? skuJson : existing.sku_json,
      };
      dbRun(
        `UPDATE pl_shop_items SET title=?, image_url=?, price_text=?,
          category=?, status=?, url=?, sku_json=?, raw_json=?, source=?, scraped_at=?, updated_at=datetime('now','localtime')
         WHERE id=?`,
        [merged.title, merged.imageUrl, merged.priceText, merged.category, merged.status, merged.url, merged.skuJson, rawJson, source, now, existing.id],
      );
      updated += 1;
    } else {
      dbRun(
        `INSERT INTO pl_shop_items
          (shop_id, store_key, item_id, title, image_url, price_text, category, status, url, sku_json, raw_json, source, scraped_at)
         VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)`,
        [shopId, storeKey, itemId, title, imageUrl, priceText, category, status, url, skuJson, rawJson, source, now],
      );
      inserted += 1;
    }
  }
  return { received: items.length, inserted, updated, skipped };
}

export interface ManualImportResult {
  ok: boolean;
  received: number;
  inserted: number;
  updated: number;
  skipped: number;
  /** ok=false 时的原因（直接进弹层错误条，不猜） */
  error?: string;
}

/**
 * 手贴商品ID导入（保底通道：列表页选择器全落空时，用户从后台复制商品ID贴进来）。
 *
 * 与扩展采集帧**同一个写路径**（upsertShopItems），不引第二套落库口径；
 * 差别只在 source='manual'（表上分得开「手贴的」与「采来的」）。
 *
 * ⭐ **shopId 是「点名」不是「提示」**：用户在下拉里挑了店 ⇒ 这个 id 本身就是最强身份证据，
 * 直接 pin 住，**不再**去解析店实体的 url/storeId（那两个字段可选，老店全空 ⇒ 解析必然落空
 * ⇒ 行被写进 shop_id=0 未登记桶 —— 审查 P1-1）。点名落空（店已被删）**报错**，不静默回落。
 * shopId=0 是用户在下拉里显式选的「未登记桶（待登记）」，保持落桶语义。
 * 返回 skipped 含「空ID/非字符串」的坏行数（调用方按条数告知，不静默吞）。
 */
export function importManualItems(shopId: number, ids: unknown[]): ManualImportResult {
  ensureSchema();
  const clean: string[] = [];
  let skipped = 0;
  for (const raw of Array.isArray(ids) ? ids : []) {
    const id = toSkuKey(raw);
    if (id) clean.push(id);
    else skipped += 1;
  }
  const nothing = { received: clean.length, inserted: 0, updated: 0, skipped };
  if (!clean.length) return { ok: true, ...nothing };
  const sid = Number(shopId) || 0;
  // 点名严格：选了店就必须存在。静默落未登记桶 = 用户以为贴进了 A 店、行却在桶里，
  // 界面还回报成功 —— 典型的「静默失败三件套」。
  if (sid && !getShop(sid)) {
    return { ok: false, ...nothing, error: `店铺不存在或已被删除（id=${sid}），请重新选择归属店铺` };
  }
  const r = upsertShopItems(
    {
      schema: SCHEMA_SHOP_ITEM,
      store: {}, // 帧不带身份：身份是用户点名的 id，不是页面采到的证据
      items: clean.map((itemId) => ({ itemId, source: 'manual' })),
    },
    { pinnedShopId: sid },
  );
  return { ok: true, received: clean.length, inserted: r.inserted, updated: r.updated, skipped: skipped + r.skipped };
}

// ---- 人工维护（渲染层 IPC 调用：删采集行）----

/**
 * 删一条采集快照行（按**行 id**，不是 item_id）。
 *
 * ⭐ 为什么必须按行 id：唯一键是 `(shop_id, store_key, item_id)` 三元组 ——
 * 同一个商品ID 在两家店、或未登记桶与已登记店下**各是一行**（见文件头设计边界）。
 * 按 item_id 删会删掉别的店那份：用户删 A 店的商品，B 店的也跟着没了。
 *
 * ⚠️ **不联动删 `pl_shop_sku` 映射**：快照存"店里有什么"、映射存"人的决定"，
 * 两套不互写（§3.3）。删了采集行，已建立的认款映射照常生效；重新采集这行还会出现，
 * 且按 item_id 重新对上原映射。确认弹层把这两句写给用户看。
 */
export function deleteShopItem(id: number): boolean {
  ensureSchema();
  const rid = Number(id);
  if (!Number.isFinite(rid) || rid <= 0) return false;
  const r = dbRun(`DELETE FROM pl_shop_items WHERE id=?`, [rid]);
  return r.changes > 0;
}

// ---- 查询（渲染层 IPC 调用） ----
function mapShopItemRow(row: Record<string, unknown>): ShopItemRow {
  return {
    id: Number(row.id) || 0,
    shopId: Number(row.shop_id) || 0,
    platform: String(row.shop_platform ?? ''),
    shopName: String(row.shop_name ?? ''),
    storeKey: String(row.store_key ?? ''),
    itemId: String(row.item_id ?? ''),
    title: String(row.title ?? ''),
    imageUrl: String(row.image_url ?? ''),
    imageId: Number(row.image_id) || 0,
    priceText: String(row.price_text ?? ''),
    category: String(row.category ?? ''),
    status: String(row.status ?? ''),
    url: String(row.url ?? ''),
    skuJson: String(row.sku_json ?? ''),
    source: String(row.source ?? ''),
    scrapedAt: Number(row.scraped_at) || 0,
    mappedProductId: Number(row.mapped_product_id) || 0,
    mappedProductCode: String(row.mapped_product_code ?? ''),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

/**
 * 「这一采集行当前认到哪个款」的**唯一判据**（列表 / 单行 / 按款筛三处共用）。
 *
 * ⚠️ 一条商品可能有多条 confirmed 映射（spec 维度）⇒ 直接 JOIN 会把行算重；
 * 而"历史上认过这个款"与"现在认的是这个款"是两件事 —— 改绑之后旧款不该再筛出这一行。
 * 所以取**最新一条** confirmed（`ORDER BY m.id DESC LIMIT 1`），三处必须同一条 SQL。
 */
const LATEST_MAP_JOIN = `LEFT JOIN pl_shop_sku mi ON mi.id = (
         SELECT m.id FROM pl_shop_sku m
          WHERE m.item_id = si.item_id
            AND m.status = 'confirmed'
            AND (m.shop_id = si.shop_id OR m.shop_id = 0)
          ORDER BY m.id DESC LIMIT 1
       )`;

/**
 * 店铺商品段列表（按店铺 / 搜索 / 分页 / 按款筛）。
 * shopId < 0 视作「未登记」（shop_id=0）；不传则不过滤店铺。
 * 每行带：店铺平台（认款写入用）+ 已认款编码（行内三态）—— 两个都来自 JOIN，
 * 不让渲染层再发 N 次请求去拼（取数粒度 ≥ 展示粒度）。
 */
export function listShopItems(q: ShopItemListQuery): { rows: ShopItemRow[]; total: number } {
  ensureSchema();
  const conds: string[] = [];
  const params: DbBindValue[] = [];
  // NaN 也是 typeof 'number' —— 不拦会把 NaN 绑进 SQL（better-sqlite3 直接抛）
  if (typeof q?.shopId === 'number' && Number.isFinite(q.shopId)) {
    if (q.shopId < 0) conds.push('si.shop_id = 0');
    else {
      conds.push('si.shop_id = ?');
      params.push(q.shopId);
    }
  }
  if (q?.search) {
    const like = `%${q.search}%`;
    conds.push('(si.title LIKE ? OR si.item_id LIKE ?)');
    params.push(like, like);
  }
  if (q?.onlyUnconfirmed) {
    // 与 summary 的 confirmed 判据**同一条** EXISTS（别一个用 JOIN 一个用 EXISTS —— 两边会漂）
    conds.push(`NOT EXISTS (
              SELECT 1 FROM pl_shop_sku m
              WHERE m.item_id = si.item_id
                AND m.status = 'confirmed'
                AND (m.shop_id = si.shop_id OR m.shop_id = 0)
            )`);
  }
  if (typeof q?.productId === 'number' && Number.isFinite(q.productId) && q.productId > 0) {
    conds.push('mi.product_id = ?');
    params.push(q.productId);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  // COUNT 必须带上同一个 JOIN：productId 条件引用 mi.product_id（LEFT JOIN 唯一键，不改变行数）
  const totalRow = dbGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM pl_shop_items si ${LATEST_MAP_JOIN} ${where}`,
    params,
  );
  const total = totalRow?.c || 0;
  const page = Math.max(0, Number(q?.page) || 0);
  const pageSize = Math.min(200, Math.max(1, Number(q?.pageSize) || 50));
  // 平台来自店铺实体（未登记 = ''）；已认款编码取**最新一条** confirmed 映射
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT si.*, sh.platform AS shop_platform,
            sh.name AS shop_name,
            mi.product_id AS mapped_product_id,
            mp.code AS mapped_product_code
       FROM pl_shop_items si
       LEFT JOIN sk_shops sh ON sh.id = si.shop_id
       ${LATEST_MAP_JOIN}
       LEFT JOIN pl_products mp ON mp.id = mi.product_id
       ${where}
      ORDER BY si.updated_at DESC, si.id DESC LIMIT ? OFFSET ?`,
    [...params, pageSize, page * pageSize],
  );
  return { rows: rows.map(mapShopItemRow), total };
}

/** 单行读取（图片下载回填前要确认行还在、地址是什么） */
export function getShopItemRow(id: number): ShopItemRow | null {
  ensureSchema();
  const row = dbGet<Record<string, unknown>>(
    `SELECT si.*, sh.platform AS shop_platform,
            sh.name AS shop_name,
            mi.product_id AS mapped_product_id,
            mp.code AS mapped_product_code
       FROM pl_shop_items si
       LEFT JOIN sk_shops sh ON sh.id = si.shop_id
       ${LATEST_MAP_JOIN}
       LEFT JOIN pl_products mp ON mp.id = mi.product_id
      WHERE si.id = ?`,
    [id],
  );
  return row ? mapShopItemRow(row) : null;
}

/**
 * 回填已下载图片的 image_id（下载入库后这一行就能走本地图，不必再热链 CDN）。
 * 行不存在返回 false —— 采集行可能在被下载的这段时间里又被重采/删除。
 */
export function setShopItemImageId(id: number, imageId: number): boolean {
  ensureSchema();
  const r = dbRun(`UPDATE pl_shop_items SET image_id = ?, updated_at = datetime('now','localtime') WHERE id = ?`, [
    imageId,
    id,
  ]);
  return r.changes > 0;
}

/**
 * 每家店（含未登记）的采集汇总：采集数 / 已认款数 / 最近采集时间。
 * 已认款 = 存在 pl_shop_sku 的 confirmed 行（item_id 相同、shop_id 相同或为 0）。
 * ⚠️ 用 EXISTS 不用 JOIN：一个商品可能有多条 confirmed 映射行（spec 维度），
 * JOIN 会让 COUNT(*) 把同一商品算多次（显示"采了 3 个"实际 1 个）。
 */
export function shopItemsSummary(): ShopItemSummaryRow[] {
  ensureSchema();
  const rows = dbQuery<{ shop_id: number; store_key: string; total: number; confirmed: number; last_scraped: number }>(
    `SELECT si.shop_id AS shop_id,
            si.store_key AS store_key,
            COUNT(*) AS total,
            SUM(CASE WHEN EXISTS (
              SELECT 1 FROM pl_shop_sku m
              WHERE m.item_id = si.item_id
                AND m.status = 'confirmed'
                AND (m.shop_id = si.shop_id OR m.shop_id = 0)
            ) THEN 1 ELSE 0 END) AS confirmed,
            MAX(si.scraped_at) AS last_scraped
       FROM pl_shop_items si
      GROUP BY si.shop_id, si.store_key
      ORDER BY si.shop_id DESC, si.store_key`,
  );
  return rows.map((r) => ({
    shopId: Number(r.shop_id) || 0,
    storeKey: String(r.store_key ?? ''),
    total: Number(r.total) || 0,
    confirmed: Number(r.confirmed) || 0,
    lastScrapedAt: Number(r.last_scraped) || 0,
  }));
}

// ---- 店铺登记后的收养 ----

/**
 * 店铺新建/更新后，把之前落在「未登记」桶（shop_id=0）里的采集行收养进该店铺。
 *
 * 为什么需要：用户往往是「先采集、后登记」—— 采集时店里还没登记，行落 shop_id=0；
 * 登记后若不做收养，那些行永远显示"未登记"，用户看到"我明明登记了还不归位"。
 *
 * 收养键 = 店铺的三个身份标识（店名 / 归一 URL / 平台店铺ID）：未登记行的 store_key
 * 正是按「店名 → URL → storeId」优先级取的展示名，三者任一相等即视为同一家店。
 * 该店名下已存在同 item_id 的行时跳过（避免撞 UNIQUE(shop_id, store_key, item_id)，
 * 保留登记后新采的那条——它的 store_key='' 是规范形态）。
 *
 * ⭐⭐ **顺手把三个键写进收养记忆表**（2026-10-18）：收养是**一次性**的（只在用户保存
 * 店铺那刻跑），而 `matchShopByStore` 1~3 级比的是**用户当前填的** URL/店铺ID ——
 * 用户当初没填对（真库九店 `platform_shop_id` 填成了店名）就永远匹配不上，之后每次采集
 * 都落未登记桶，同一款在两个桶各存一行（实测 40 条重复）。记忆表让"这个桶键上次被收养
 * 进了哪一家"能被后续帧查到。存量库由 v2 迁移回填，不用用户重新保存一次店铺。
 */
export function adoptShopItemsForShop(
  shopId: number,
  identity: { name?: string; url?: string; storeId?: string },
): { adopted: number } {
  ensureSchema();
  if (!shopId) return { adopted: 0 };
  const keys = [
    typeof identity?.name === 'string' ? identity.name.trim() : '',
    normalizeShopUrl(identity?.url),
    typeof identity?.storeId === 'string' ? identity.storeId.trim() : '',
  ].filter((k) => !!k);
  let adopted = 0;
  for (const key of keys) {
    const r = dbRun(
      `UPDATE pl_shop_items SET shop_id=?, store_key='', updated_at=datetime('now','localtime')
        WHERE shop_id=0 AND store_key=?
          AND NOT EXISTS (
            SELECT 1 FROM pl_shop_items x WHERE x.shop_id=? AND x.item_id = pl_shop_items.item_id
          )`,
      [shopId, key, shopId],
    );
    adopted += Number(r?.changes) || 0;
    // 记忆**无条件**写（哪怕本次 adopted=0）："这个桶键归这家店"是登记那一刻的结论，
    // 与桶里此刻有没有行无关 —— 下次采到的帧要靠它归位。
    rememberStoreKeyForShop(shopId, key);
  }
  return { adopted };
}
