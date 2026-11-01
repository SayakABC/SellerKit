// electron/pod-db.ts
// 图案槽位域（POD）的 schema 与读写入口 —— 2026-11-01 / M3·T3-1。
//
// 这一域要解决的事：一件印花定制品，**印哪个图案**必须是一个能被查出来的事实，
// 而不是每次凭记忆挑。所以核心是两件事：
//   · `pod_patterns` —— 图案主数据（图稿与预览图**分开存**，传错花纸商拿模特图制版 = 整批报废）；
//   · `pod_variant_patterns` —— 变体键 → 图案的绑定台账（**一行 = 一个槽位**）。
// 其余三张（花纸批次 / 件流水 / 两个视图）服务于"余量"与"待绑定清单"，见各自注释。
//
// ⚠️ **为什么没有 `migrate('pod.main', …)` 版本步骤**：本域全是**新表 + 新视图**，
//    没有"老库形状需要追"的东西 —— `dbMigrate` 的幂等 `CREATE ... IF NOT EXISTS`
//    对老库就是"补建"，对新库就是"一次建到当前形状"，两条路等价。
//    版本步骤留给**将来改形状**（例如给 `pod_patterns` 加列、给绑定表换唯一键）时再加，
//    那时才有"老库和新库形状不同、需要一次性数据搬迁"的问题。
//    反面教材见 `electron/db.ts` 里 `migrate()` 的注释（`pl_shop_sku` 唯一键 4→5 列）。
//
// ⚠️ **本文件不建 `pod_order_need` 视图**：那个视图要按"待发货集合"筛订单，
//    而状态口径的唯一实现在 `src/lib/mangoStatus.ts`（主进程侧走 `mango-status` 同一份表）。
//    在 SQL 里手写 `biz_status IN ('待发货', …)` 就是第二套口径 —— "发货台说 3 单待发、
//    报单说 5 件要印"这类分裂正是这么来的。它归 T4-1（净需件）时与状态口径一起落地。
import { dbMigrate, dbQuery, tableExists } from './db';
// 图案域**读**的两张表：`pl_shop_items`（槽位从 SKU JSON 摊出来）与 `sk_shops`（槽位键的第一段是店名）。
// 依赖方向是"消费者 → 提供方"：本域自己要用的输入，自己先把它们的建表跑到 —— 
// 而不是反过来让商品快照域替本域建视图（那会让底层域知道上层域的存在）。
// 同款先例：`shop-item-db` → `./shop-db` 的 `ensureShopSchema`（读链 JOIN sk_shops，全新库第一站不能炸）。
import { ensureShopItemSchema } from './shop-item-db';
import { ensureShopSchema } from './shop-db';

/**
 * 图案域 DDL（幂等）。**与计划文档附录 A 逐字一致**，改动请两边同步。
 *
 * 顺序有讲究：`pod_variant_patterns` 引用 `pod_patterns`，`pod_sheet_ledger` 引用
 * `pod_sheet_batches` —— `CREATE TABLE` 本身不校验引用（SQLite 延迟解析），但视图会，
 * 所以视图排在所有表之后。
 */
export const POD_SCHEMA: string[] = [
  // 图案主数据。artwork（制版用图稿，纯图案无背景）与 preview（认图案用）**必须分开存**。
  `CREATE TABLE IF NOT EXISTS pod_patterns (
    -- 用途：印花图案主数据（图稿 + 预览图）。artwork 给花纸商制版，preview 给人认图，两者不可混用。
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    code             TEXT NOT NULL DEFAULT '',
    name             TEXT NOT NULL DEFAULT '',
    artwork_image_id INTEGER NOT NULL DEFAULT 0,
    preview_image_id INTEGER NOT NULL DEFAULT 0,
    status           TEXT NOT NULL DEFAULT 'active',
    note             TEXT NOT NULL DEFAULT '',
    created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS ux_pod_patterns_code ON pod_patterns(code)`,

  // 变体键 → 图案绑定台账：**一行 = 一个槽位**。
  // `state` 只有 `bound` / `suspected_merge` 两值：后者是"这个键可能是几个图案塌陷成一条"
  // 的可疑标记（塌陷链接禁止偷偷降级到色名，降级 = 把 5~12 个图案并成 1 个，静默错印）。
  `CREATE TABLE IF NOT EXISTS pod_variant_patterns (
    -- 用途：变体键 → 图案的绑定台账（一行 = 一个槽位）；state=suspected_merge 表示键可能塌陷。
    variant_key TEXT PRIMARY KEY,
    pattern_id  INTEGER NOT NULL REFERENCES pod_patterns(id) ON DELETE RESTRICT,
    source      TEXT NOT NULL DEFAULT 'manual',
    image_key   TEXT NOT NULL DEFAULT '',
    sku_code    TEXT NOT NULL DEFAULT '',
    state       TEXT NOT NULL DEFAULT 'bound',
    bound_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pod_vp_pattern ON pod_variant_patterns(pattern_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pod_vp_sku ON pod_variant_patterns(sku_code)`,

  // 花纸批次（一次报单 = 一批）。
  // ⚠️ `pieces_per_sheet` 记在**批次行**、不记图案主表：换排版就变，
  //    记主表会让历史批次被新值改写（余量按"件"算，单位错一次余量复用全废）。
  `CREATE TABLE IF NOT EXISTS pod_sheet_batches (
    -- 用途：花纸批次（一次报单 = 一批）；pieces_per_sheet 记在本行，不记图案主表。
    id               INTEGER PRIMARY KEY AUTOINCREMENT,
    pattern_id       INTEGER NOT NULL REFERENCES pod_patterns(id) ON DELETE RESTRICT,
    sheets           INTEGER NOT NULL DEFAULT 0,
    pieces_per_sheet INTEGER NOT NULL DEFAULT 0,
    supplier         TEXT NOT NULL DEFAULT '',
    cost_cents       INTEGER NOT NULL DEFAULT 0,
    ordered_at       TEXT NOT NULL DEFAULT '',
    arrived_at       TEXT NOT NULL DEFAULT '',
    note             TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pod_sb_pattern ON pod_sheet_batches(pattern_id)`,

  // 件的流水：到货 +，印花 -，盘点调整 ±。余量 = 求和，**不存冗余列**
  //（存了就要维护，维护就会与流水对不上，而对不上的时候没人知道该信哪一个）。
  `CREATE TABLE IF NOT EXISTS pod_sheet_ledger (
    -- 用途：花纸件的流水（到货 + / 印花 - / 盘点 ±）；余量由视图求和，不存冗余列。
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id          INTEGER NOT NULL REFERENCES pod_sheet_batches(id) ON DELETE CASCADE,
    delta_pieces      INTEGER NOT NULL DEFAULT 0,
    reason            TEXT NOT NULL DEFAULT 'adjust',
    ref_order_item_id INTEGER NOT NULL DEFAULT 0,
    at                TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pod_sl_batch ON pod_sheet_ledger(batch_id)`,

  // 图案余量（按件）。左连两张表：没报过单的图案也要出现（余量 0），
  // 否则"这个图案还没买花纸"会在看板上直接消失。
  `CREATE VIEW IF NOT EXISTS pod_pattern_balance AS
   SELECT p.id AS pattern_id, p.code AS code,
          COALESCE(SUM(l.delta_pieces), 0) AS remaining_pieces
   FROM pod_patterns p
   LEFT JOIN pod_sheet_batches b ON b.pattern_id = p.id
   LEFT JOIN pod_sheet_ledger  l ON l.batch_id  = b.id
   GROUP BY p.id`,

  // 待绑定清单：从店铺商品快照里摊出**每个槽位**（店铺 × 商品ID × 颜色 [× 图键]）。
  //
  // 变体键必须与 `electron/variantKey.ts` 的 `variantKey()` **逐字节同构**（`char(0)` 分隔），
  // 否则绑定台账的键永远对不上订单行的键 —— 那会表现为"绑了 560 个槽位，订单一个都匹配不上"，
  // 而且两边各自看起来都正常。第 4 段（图键）**只在同一颜色下有多个图时才追加**：
  // 那是"色名塌陷"的判据，也是它唯一该出现的地方。
  //
  // ⚠️ **它单独一条、且要等 `pl_shop_items` / `sk_shops` 都在了才建**（见 `ensurePodSchema`）。
  //    SQLite 在**准备任何语句**时都会解析 schema 里的视图，视图引用了不存在的表时，
  //    报的是 `error in view pod_binding_worklist: no such table: main.pl_shop_items` ——
  //    而这条错误会打在**别的功能**的 SQL 上（2026-11-01 `schema:smoke` 场景 H 当场踩到）。
  //    也就是说：跨域视图建早了不是"这个视图不可用"，而是**整个库的语句都可能失败**。
  `CREATE VIEW IF NOT EXISTS pod_binding_worklist AS
   WITH sku AS (
     SELECT i.item_id, s.name AS shop, j.value->>'color' AS color, j.value->>'imageUrl' AS img
     FROM pl_shop_items i JOIN sk_shops s ON s.id = i.shop_id, json_each(i.sku_json) j
     WHERE i.sku_json <> ''
   ), slot AS (
     SELECT item_id, shop, color, img FROM sku GROUP BY item_id, shop, color, img
   ), namecnt AS (
     SELECT item_id, color, COUNT(*) AS imgs FROM slot GROUP BY item_id, color
   )
   SELECT
     s.shop || char(0) || s.item_id || char(0) || s.color
       || CASE WHEN n.imgs > 1
               THEN char(0) || substr(s.img, instr(s.img,'/kf/')+4,
                                      instr(substr(s.img,instr(s.img,'/kf/')+4),'.')-1)
               ELSE '' END AS variant_key,
     s.shop AS shop, s.item_id AS item_id, s.color AS color,
     CASE WHEN n.imgs > 1
          THEN substr(s.img, instr(s.img,'/kf/')+4, instr(substr(s.img,instr(s.img,'/kf/')+4),'.')-1)
          ELSE '' END AS image_key,
     n.imgs AS imgs_in_name
   FROM slot s JOIN namecnt n ON n.item_id = s.item_id AND n.color = s.color`,
];

/** 跨域视图（单独一条：建它的前提是 `pl_shop_items` 与 `sk_shops` 都存在，见 `ensurePodSchema`） */
const POD_WORKLIST_VIEW = POD_SCHEMA[POD_SCHEMA.length - 1] as string;

/**
 * 幂等初始化（**每个用到图案域的入口先调它**：绑定台、余量看板、报单页、冒烟脚本）。
 *
 * 顺序是刻意的，三层：
 *   ① 本域自己的表 + `pod_pattern_balance`（只在域内，无条件建）；
 *   ② 输入域的建表（`sk_shops` → `pl_shop_items`）：跨域视图的**前提**，所以先跑；
 *   ③ 跨域视图 `pod_binding_worklist`（前提是①的前提：`pl_shop_items` 与 `sk_shops` 都在）。
 *
 * 为什么不是"挂在订单主干里跟着建"：`pod_binding_worklist` 引用了别的域的表，而 SQLite
 * 在**准备任何语句**时都会解析 schema 里的视图 —— 视图引用了不存在的表时，报的错会打在
 * **别处**的 SQL 上（`error in view pod_binding_worklist: no such table: main.pl_shop_items`，
 * 2026-11-01 `schema:smoke` 场景 H 当场踩到）。也就是说"跨域视图建早了"不是"这张视图不可用"，
 * 而是**整个库的语句都可能失败**。所以它只能由"确定输入已就位"的那一处来建 —— 就是这里。
 *
 * 失败**不吞**：建表失败只可能是"库损坏 / 磁盘满"这类必须让人看见的问题；
 * 吞掉之后的表现是"图案绑定点了没反应"，而那会被误当成界面 bug。
 */
export function ensurePodSchema(): void {
  dbMigrate(POD_SCHEMA.slice(0, -1));
  ensureShopSchema();
  // ⚠️ 必须排在 `ensureShopSchema` 之后：商品快照域的迁移会读 `sk_shops`。
  ensureShopItemSchema();
  dbMigrate([POD_WORKLIST_VIEW]);
}

/** 只建那条跨域视图（前提表不在时返回 false；调用方应先 `ensurePodSchema`） */
export function ensurePodWorklist(): boolean {
  if (!tableExists('pl_shop_items') || !tableExists('sk_shops')) return false;
  dbMigrate([POD_WORKLIST_VIEW]);
  return true;
}

/**
 * 图案域的表齐不齐（`schema:smoke` 与排障用）。
 *
 * 为什么要一个显式的自检而不是"跑一条 SELECT 看看":缺表时 `SELECT` 报的是
 * `no such table: pod_variant_patterns` —— 那句话会被当成"这个功能还没做",
 * 而真相是"迁移没跑到"。分开列出来，一眼能看出缺哪几张。
 */
export function podSchemaReport(): { tables: string[]; views: string[]; missing: string[] } {
  const want = ['pod_patterns', 'pod_variant_patterns', 'pod_sheet_batches', 'pod_sheet_ledger'];
  const wantViews = ['pod_pattern_balance', 'pod_binding_worklist'];
  const rows = dbQuery<{ name: string; type: string }>(
    `SELECT name, type FROM sqlite_master WHERE name LIKE 'pod_%'`,
  );
  const has = new Map(rows.map((r) => [String(r.name), String(r.type)]));
  return {
    tables: want.filter((t) => has.get(t) === 'table'),
    views: wantViews.filter((v) => has.get(v) === 'view'),
    missing: [...want, ...wantViews].filter((n) => !has.has(n)),
  };
}
