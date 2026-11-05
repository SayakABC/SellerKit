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
import { dbMigrate, dbQuery, dbRun, dbTransaction, tableExists, tableSql } from './db';
import { allocatePrint } from './podLedger';
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
    -- 合并去向（0 = 没被合并）。**合并 = 可拆**：源图案行不删，只置 status='merged' + 这里指向目标，
    -- 界面按 merged_into = 0 过滤；撤销时按批次的明细逐条搬回（见 podPatternMergeUndo）。
    -- ⚠️ 老库的这一列由 ensurePodColumns() 补（electron/db.ts 没有加列 helper）。
    merged_into      INTEGER NOT NULL DEFAULT 0,
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

  // 识别图 → 图案（2026-11-02，按图认图案）。
  //
  // 为什么主键是**图片指纹**而不是 (图案, 图片) 两列：用户的原话是「最终相同的只保留一个」——
  // 一张图只能属于一个图案，这不是业务约定而是**结构约束**（CP 主键）。同一张图被认到第二个图案时，
  // 写的是 UPSERT（改指过去），并回报 `moved`，不会出现"两个图案都说这张图是自己的"。
  //
  // 这张表就是"图案自己的图"：用户抱怨「当前印花的图片没有单独的图片，维护起来比较困难」，
  // 指的就是图案主数据里只有 `artwork/preview` 两个 id，而认图靠的是一串颜色槽位。
  // 现在图案 = 一组识别图（来自订单图片，内容指纹现成），维护就是"加一张 / 去掉一张"。
  // ⚠️ 它不是制版图：识别图是商品图（模特穿着），**绝不能**当 `artwork_image_id` 用（红线 7）。
  `CREATE TABLE IF NOT EXISTS pod_pattern_images (
    -- 用途：图案的识别图（图片指纹 → 图案）；主键保证"同一张图只归一个图案"。
    fingerprint TEXT PRIMARY KEY,
    pattern_id  INTEGER NOT NULL REFERENCES pod_patterns(id) ON DELETE CASCADE,
    image_id    INTEGER NOT NULL DEFAULT 0,
    source      TEXT NOT NULL DEFAULT 'order',
    linked_at   TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pod_pi_pattern ON pod_pattern_images(pattern_id)`,

  // 款色 → 图案（2026-11-03，用户口径「SKU 图案和花纸图案 id 的关系，自动维护款中的图案数据」）。
  //
  // 为什么需要这张表，而不是继续只靠图片指纹：
  //   图片指纹回答的是"**这张图**是哪个花"，但同款同色的商品图会换（换季重拍 / 平台改尺寸 /
  //   同款在不同店铺各一套图）。指纹一换，用户就得重新认一遍 —— 而"款 + 色"这个身份是稳定的：
  //   `oi_order_items.style_color_id` 在归类核对之后就有了，跨店铺、跨图片都对得上。
  //   所以**款色认一次，以后同款再进来直接用**（用户原话「下次遇到同款时就不用再对应了」）。
  //
  // 主键是 `style_color_id`（= `oi_style_colors.id`）：一个款色只能属于一个花，
  // 这是结构约束而不是约定 —— 同一色被认到第二个图案时写 UPSERT 并回报 `moved`，
  // 不会出现"两个图案都说这个色是自己的"。
  // ⚠️ 不存在 `style_id` 级的一行：一个款有三种颜色可能是两张花（用户举的例子），
  //    款的图案集合是**派生**的（`COUNT(DISTINCT pattern_id) GROUP BY style_id`），不另存。
  `CREATE TABLE IF NOT EXISTS pod_style_color_patterns (
    -- 用途：款色 → 图案（按款维护的图案数据；同款同色认一次，下次不再认）。
    style_color_id INTEGER PRIMARY KEY,
    pattern_id     INTEGER NOT NULL REFERENCES pod_patterns(id) ON DELETE RESTRICT,
    source         TEXT NOT NULL DEFAULT 'manual',
    updated_at     TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pod_scp_pattern ON pod_style_color_patterns(pattern_id)`,

  // 图案合并的审计（一次 N→1 = 一批 + 每源一行的头 + 明细）。
  //
  // 为什么合并也要审计：用户要求「支持合并，最终相同的只保留一个」，但合并的第一条底线是**可拆**
  // （和款色合并同一个纪律，见 `electron/order-db.ts` 的 `oi_style_merges`）——
  // 合并会搬走三样东西：识别图、颜色绑定、花纸批次。只改 `pattern_id` 的实现，拆的时候
  // 就没人知道"这批花纸原来是哪个图案的"。
  //
  // 明细只有一张表、用 `kind + ref` 三值（image=指纹 / slot=变体键 / batch=批次 id）：
  // 三者都是**值**不是行 id，撤销时逐个校验"当前父级还是不是目标图案"，不是就跳过并计数
  // （静默少还原几条，人会以为合并没拆干净）。
  `CREATE TABLE IF NOT EXISTS pod_pattern_merges (
    -- 用途：图案合并操作头（一次合并 = 一批，支持撤销还原）；明细见 pod_pattern_merge_items。
    id                INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id          TEXT NOT NULL DEFAULT '',
    source_pattern_id INTEGER NOT NULL,
    target_pattern_id INTEGER NOT NULL,
    from_status       TEXT NOT NULL DEFAULT 'active',
    created_at        TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE TABLE IF NOT EXISTS pod_pattern_merge_items (
    -- 用途：图案合并明细（kind = image / slot / batch），记 from/to 以支持撤销搬回。
    id              INTEGER PRIMARY KEY AUTOINCREMENT,
    merge_id        INTEGER NOT NULL REFERENCES pod_pattern_merges(id) ON DELETE CASCADE,
    kind            TEXT NOT NULL,
    ref             TEXT NOT NULL DEFAULT '',
    from_pattern_id INTEGER NOT NULL DEFAULT 0,
    to_pattern_id   INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pod_pmi_merge ON pod_pattern_merge_items(merge_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pod_pm_target ON pod_pattern_merges(target_pattern_id)`,

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
     SELECT i.item_id AS item_id, s.name AS shop,
            -- 键里的店铺段必须与订单行**逐字节相同**：订单侧是 toNameKey(oi_orders.shop)，
            -- 而 sk_shops.name_key 就是同一份归一（同库唯一索引也建在它上面）。
            -- 用展示名 s.name 拼键的风险：店名里多一个空格 / 一个零宽字符，560 个槽位
            -- 与订单行**一个都匹配不上**，而两边各自看起来都正常（真库 16 家店此刻 name ≡ name_key，
            -- 所以这是防未来的静默错键，不是修此刻的已知错）。
            COALESCE(NULLIF(trim(s.name_key), ''), s.name) AS shop_key,
            j.value->>'color' AS color, j.value->>'imageUrl' AS img
     FROM pl_shop_items i JOIN sk_shops s ON s.id = i.shop_id, json_each(i.sku_json) j
     WHERE i.sku_json <> ''
   ), slot AS (
     SELECT item_id, shop, shop_key, color, img FROM sku GROUP BY item_id, shop, shop_key, color, img
   ), namecnt AS (
     -- 按 (店铺, 商品ID, 色) 数图：商品ID 只在店内唯一，跨店同 ID 不是同一个链接。
     SELECT shop_key, item_id, color, COUNT(*) AS imgs FROM slot GROUP BY shop_key, item_id, color
   )
   SELECT
     s.shop_key || char(0) || s.item_id || char(0) || s.color
       || CASE WHEN n.imgs > 1
               THEN char(0) || substr(s.img, instr(s.img,'/kf/')+4,
                                      instr(substr(s.img,instr(s.img,'/kf/')+4),'.')-1)
               ELSE '' END AS variant_key,
     s.shop AS shop, s.item_id AS item_id, s.color AS color,
     CASE WHEN n.imgs > 1
          THEN substr(s.img, instr(s.img,'/kf/')+4, instr(substr(s.img,instr(s.img,'/kf/')+4),'.')-1)
          ELSE '' END AS image_key,
     n.imgs AS imgs_in_name,
     -- 该槽位自己的色图（塌陷链接里"同名色"的几张图**长得不一样**，绑定台必须看得到差异；
     -- 只给图键（一串 S3f2a…）等于让用户凭记忆挑图案 —— 那正是错印的来源）。
     s.img AS image_url
   FROM slot s JOIN namecnt n ON n.item_id = s.item_id AND n.color = s.color`,
];

/** 跨域视图（单独一条：建它的前提是 `pl_shop_items` 与 `sk_shops` 都存在，见 `ensurePodSchema`） */
const POD_WORKLIST_VIEW = POD_SCHEMA[POD_SCHEMA.length - 1] as string;

/** SQL 形状比较用的归一：折叠空白 + 去掉 `IF NOT EXISTS`（建视图时写与 sqlite_master 存的并不逐字相同） */
function shapeOf(sql: string): string {
  return sql
    .replace(/\s+/g, ' ')
    .replace(/create view if not exists/i, 'create view')
    .trim();
}

/**
 * 建视图；**形状变了就重建**。
 *
 * 为什么不能只用 `CREATE VIEW IF NOT EXISTS`：本域是新建的，"视图形状还会改"是既定事实
 * （2026-11-01 一天内就给工作清单加了 `image_url`、并把店铺段换成 `name_key`）。
 * `IF NOT EXISTS` 在**已经建过旧形状**的开发机/用户机上会**静默保留旧列**，
 * 表现为"代码里明明加了列，界面就是没有"——而那与"没跑迁移"长得一模一样。
 * 表不加这一步（改表要走 ALTER/版本步骤），视图是纯派生对象，重建无数据损失。
 */
function ensureViewShape(name: string, ddl: string): void {
  const cur = tableSql(name);
  if (cur && shapeOf(cur) !== shapeOf(ddl)) {
    dbMigrate([`DROP VIEW IF EXISTS ${name}`, ddl]);
    return;
  }
  dbMigrate([ddl]);
}

/**
 * 老库补列（`pod_patterns.merged_into`）。新库由建表语句自带，这里只修"已经建过旧形状"的库。
 *
 * ⚠️ 必须跑在 `dbMigrate(POD_SCHEMA)` **之前**：新加的子查询会读这一列，
 * 老库上列还不存在时，建视图会报 `no such column: merged_into` —— 而 SQLite 会在**其它**
 * 语句上抛同样的错（这就是"迁移没跑到 = 整个库都不能用"的那种失败）。
 * 本仓库没有通用加列 helper（见 `electron/db.ts`），所以这里用 `PRAGMA table_info` 自守。
 */
function ensurePodColumns(): void {
  if (!tableExists('pod_patterns')) return; // 新库：下面的建表语句会带这一列
  const cols = dbQuery<{ name: string }>(`PRAGMA table_info(pod_patterns)`);
  if (!cols.some((c) => String(c.name) === 'merged_into')) {
    dbMigrate([`ALTER TABLE pod_patterns ADD COLUMN merged_into INTEGER NOT NULL DEFAULT 0`]);
  }
}

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
  ensurePodColumns();
  dbMigrate(POD_SCHEMA.slice(0, -1));
  ensureShopSchema();
  // ⚠️ 必须排在 `ensureShopSchema` 之后：商品快照域的迁移会读 `sk_shops`。
  ensureShopItemSchema();
  ensureViewShape('pod_binding_worklist', POD_WORKLIST_VIEW);
}

/** 只建那条跨域视图（前提表不在时返回 false；调用方应先 `ensurePodSchema`） */
export function ensurePodWorklist(): boolean {
  if (!tableExists('pl_shop_items') || !tableExists('sk_shops')) return false;
  ensureViewShape('pod_binding_worklist', POD_WORKLIST_VIEW);
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
  const want = [
    'pod_patterns',
    'pod_pattern_images',
    'pod_pattern_merges',
    'pod_pattern_merge_items',
    'pod_variant_patterns',
    'pod_style_color_patterns',
    'pod_sheet_batches',
    'pod_sheet_ledger',
  ];
  const wantViews = ['pod_pattern_balance', 'pod_binding_worklist'];
  const rows = dbQuery<{ name: string; type: string }>(
    `SELECT name, type FROM sqlite_master WHERE name LIKE 'pod_%'`
  );
  const has = new Map(rows.map((r) => [String(r.name), String(r.type)]));
  return {
    tables: want.filter((t) => has.get(t) === 'table'),
    views: wantViews.filter((v) => has.get(v) === 'view'),
    missing: [...want, ...wantViews].filter((n) => !has.has(n)),
  };
}

// ============================================================================
// 读写 API（2026-11-01，M3·T3-7 / M4）
//
// 分工：本文件只做图案域的 SQL，**不做业务口径**。
//   · 「净需件」「报单张数」是渲染层纯函数（`src/lib/podNeed.ts`）——状态口径（待发货）
//     的唯一实现在 `src/lib/mangoStatus.ts`，在 SQL 里手写 `biz_status IN (…)` 就是第二套口径；
//   · 「印花扣减分到哪个批次」是纯函数（`electron/podLedger.ts` 的 FIFO 分配）——
//     排批次的规则值得单测，而 SQL 里的窗口函数没法在 vitest 里验。
// 本层只保证三件事：**写入是原子的**（一次绑定一批）、**拒绝是响亮的**（不静默吞),
// **余量只有一个来源**（视图 `pod_pattern_balance`，不存冗余列）。
// ============================================================================

/** 槽位筛选（绑定台顶部的四档） */
export type PodSlotFilter = 'all' | 'unbound' | 'bound' | 'collapsed';

export interface PodWorklistQuery {
  filter?: PodSlotFilter;
  /** 店铺 / 商品ID / 色名 / 图案编码的模糊匹配（大小写不敏感） */
  search?: string;
  page?: number;
  pageSize?: number;
}

/** 一个槽位（`variant_key` 一行）+ 它现在的绑定状态 */
export interface PodWorklistRow {
  variantKey: string;
  shop: string;
  itemId: string;
  color: string;
  /** 非空 = 塌陷链接（这一行是"同名色 + 不同图"里的其中一个图案） */
  imageKey: string;
  /** 同色名下一共几张图（塌陷 → `>1`；普通链接恒 1） */
  imgsInName: number;
  /** 槽位自己的色图 URL（绑定台看图用；空 = 该 SKU 没给色图） */
  imageUrl: string;
  /** 0 = 没绑 */
  patternId: number;
  patternCode: string;
  patternName: string;
  /** `bound` / `suspected_merge`（来自绑定台账；未绑 = ''） */
  state: string;
  /** `image` / `name` / `manual`（怎么绑上的；未绑 = ''） */
  source: string;
  /** 平台 SKU 编码（D-4 的首选锚点；空 = 采集帧没给） */
  skuCode: string;
  boundAt: string;
}

export interface PodWorklistStats {
  total: number;
  bound: number;
  unbound: number;
  /** 塌陷链接的槽位数（`image_key <> ''`）—— 这 50 个绑错就是整批错印 */
  collapsed: number;
  collapsedBound: number;
}

const SLOT_PAGE_SIZE = 24;
const SLOT_PAGE_MAX = 200;

function str(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}
function posInt(v: unknown, fallback = 0): number {
  const n = Number(v);
  return Number.isFinite(n) && n >= 0 ? Math.round(n) : fallback;
}

/**
 * 绑定台的汇总数（页面顶部四个数 + 覆盖率）。
 *
 * 为什么覆盖率不算进函数：它是"已绑 / 总数"的除法，由界面做（`src/lib/podBinding.ts` 负责
 * 文案与阈值），这里只给两个**可校验的计数**。
 */
export function podWorklistStats(): PodWorklistStats {
  ensurePodSchema();
  const r = dbQuery<Record<string, unknown>>(
    `SELECT COUNT(*) AS total,
            SUM(CASE WHEN w.image_key <> '' THEN 1 ELSE 0 END) AS collapsed,
            SUM(CASE WHEN v.variant_key IS NULL THEN 0 ELSE 1 END) AS bound,
            SUM(CASE WHEN w.image_key <> '' AND v.variant_key IS NOT NULL THEN 1 ELSE 0 END) AS collapsed_bound
       FROM pod_binding_worklist w
       LEFT JOIN pod_variant_patterns v ON v.variant_key = w.variant_key`
  )[0];
  const total = posInt(r?.total);
  const bound = posInt(r?.bound);
  return {
    total,
    bound,
    unbound: Math.max(0, total - bound),
    collapsed: posInt(r?.collapsed),
    collapsedBound: posInt(r?.collapsed_bound),
  };
}

/**
 * 待绑定槽位清单（一页 24 个，够一屏键盘流）。
 *
 * 排序：**未绑优先**（这一屏就是干这个的），其次**塌陷优先**（错印风险最高的先看），
 * 最后店铺 / 商品 / 色名稳定排序 —— 重绑过的槽位不会因为"绑过了"跳到别处，
 * 用户下一次打开还能在同一条链接里找到它。
 */
export function podWorklist(q: PodWorklistQuery = {}): {
  rows: PodWorklistRow[];
  total: number;
  stats: PodWorklistStats;
} {
  ensurePodSchema();
  const filter: PodSlotFilter =
    q?.filter === 'unbound' || q?.filter === 'bound' || q?.filter === 'collapsed'
      ? q.filter
      : 'all';
  const search = str(q?.search, 60);
  const pageSize = Math.min(
    Math.max(posInt(q?.pageSize, SLOT_PAGE_SIZE) || SLOT_PAGE_SIZE, 1),
    SLOT_PAGE_MAX
  );
  const page = Math.max(posInt(q?.page, 0), 0);

  const conds: string[] = [];
  const args: (string | number)[] = [];
  if (filter === 'unbound') conds.push(`v.variant_key IS NULL`);
  else if (filter === 'bound') conds.push(`v.variant_key IS NOT NULL`);
  else if (filter === 'collapsed') conds.push(`w.image_key <> ''`);
  if (search) {
    conds.push(
      `(w.shop LIKE ? OR w.item_id LIKE ? OR w.color LIKE ? OR w.image_key LIKE ? OR COALESCE(p.code,'') LIKE ?)`
    );
    const like = `%${search}%`;
    for (let i = 0; i < 5; i += 1) args.push(like);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const total = posInt(
    dbQuery<Record<string, unknown>>(
      `SELECT COUNT(*) AS n
         FROM pod_binding_worklist w
         LEFT JOIN pod_variant_patterns v ON v.variant_key = w.variant_key
         LEFT JOIN pod_patterns p ON p.id = v.pattern_id
         ${where}`,
      args
    )[0]?.n
  );
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT w.variant_key, w.shop, w.item_id, w.color, w.image_key, w.imgs_in_name, w.image_url,
            COALESCE(v.pattern_id, 0) AS pattern_id, COALESCE(v.state, '') AS state,
            COALESCE(v.source, '') AS source, COALESCE(v.sku_code, '') AS sku_code,
            COALESCE(v.bound_at, '') AS bound_at,
            COALESCE(p.code, '') AS pattern_code, COALESCE(p.name, '') AS pattern_name
       FROM pod_binding_worklist w
       LEFT JOIN pod_variant_patterns v ON v.variant_key = w.variant_key
       LEFT JOIN pod_patterns p ON p.id = v.pattern_id
       ${where}
      ORDER BY CASE WHEN v.variant_key IS NULL THEN 0 ELSE 1 END,
               CASE WHEN w.image_key <> '' THEN 0 ELSE 1 END,
               w.shop, w.item_id, w.color, w.image_key
      LIMIT ? OFFSET ?`,
    [...args, pageSize, page * pageSize]
  ).map((r) => ({
    variantKey: String(r.variant_key ?? ''),
    shop: String(r.shop ?? ''),
    itemId: String(r.item_id ?? ''),
    color: String(r.color ?? ''),
    imageKey: String(r.image_key ?? ''),
    imgsInName: posInt(r.imgs_in_name),
    imageUrl: String(r.image_url ?? ''),
    patternId: posInt(r.pattern_id),
    patternCode: String(r.pattern_code ?? ''),
    patternName: String(r.pattern_name ?? ''),
    state: String(r.state ?? ''),
    source: String(r.source ?? ''),
    skuCode: String(r.sku_code ?? ''),
    boundAt: String(r.bound_at ?? ''),
  }));

  return { rows, total, stats: podWorklistStats() };
}

export interface PodPatternRow {
  id: number;
  code: string;
  name: string;
  artworkImageId: number;
  previewImageId: number;
  status: string;
  note: string;
  boundSlots: number;
  remainingPieces: number;
  /** 识别图张数（`pod_pattern_images`；界面显示"N 张识别图"） */
  imageCount: number;
  /** 识别图的图片指纹（最多 8 个；主进程用它解析本地路径给界面出缩略图） */
  imageFingerprints: string[];
}

/**
 * 图案清单（认图案页快选 / 报单页 / 余量看板共用）。
 *
 * ⚠️ **被合并的图案不出现**（`merged_into <> 0`）：它们已经不是"可选的图案"了。
 * 行还留着（可撤销），但任何"新增绑定/报单"都不该看到它 —— 否则会出现
 * "明明合并了，列表里还有两张一模一样的图案"。
 */
export function podPatternList(q: { search?: string; status?: string } = {}): PodPatternRow[] {
  ensurePodSchema();
  const search = str(q?.search, 60);
  const status = str(q?.status, 20);
  const conds: string[] = ['p.merged_into = 0'];
  const args: string[] = [];
  if (search) {
    conds.push(`(p.code LIKE ? OR p.name LIKE ?)`);
    args.push(`%${search}%`, `%${search}%`);
  }
  if (status) {
    conds.push(`p.status = ?`);
    args.push(status);
  }
  const where = `WHERE ${conds.join(' AND ')}`;
  return dbQuery<Record<string, unknown>>(
    `SELECT p.id, p.code, p.name, p.artwork_image_id, p.preview_image_id, p.status, p.note,
            (SELECT COUNT(*) FROM pod_variant_patterns v WHERE v.pattern_id = p.id) AS bound_slots,
            (SELECT COALESCE(b.remaining_pieces, 0) FROM pod_pattern_balance b WHERE b.pattern_id = p.id) AS remaining_pieces,
            (SELECT COUNT(*) FROM pod_pattern_images pi WHERE pi.pattern_id = p.id) AS image_count,
            (SELECT GROUP_CONCAT(f.fingerprint, ',')
               FROM (SELECT fingerprint FROM pod_pattern_images fi
                      WHERE fi.pattern_id = p.id
                      ORDER BY fi.linked_at DESC, fi.fingerprint
                      LIMIT 8) f) AS image_fps
       FROM pod_patterns p
       ${where}
      ORDER BY p.code`,
    args
  ).map((r) => ({
    id: posInt(r.id),
    code: String(r.code ?? ''),
    name: String(r.name ?? ''),
    artworkImageId: posInt(r.artwork_image_id),
    previewImageId: posInt(r.preview_image_id),
    status: String(r.status ?? ''),
    note: String(r.note ?? ''),
    boundSlots: posInt(r.bound_slots),
    remainingPieces: Number(r.remaining_pieces) || 0,
    imageCount: posInt(r.image_count),
    imageFingerprints: String(r.image_fps ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean),
  }));
}

export interface PodPatternInput {
  code: string;
  name?: string;
  artworkImageId?: number;
  previewImageId?: number;
  note?: string;
  /** 顺手挂识别图（新建图案时把当前选中的订单图一起挂上，少一步操作） */
  images?: PodImageLinkItem[];
  /** 这些识别图从哪来（`image` = 来自订单图 / `create` = 新建时一起选的；缺省 create） */
  source?: string;
}

/** 一张识别图（指纹是身份；`imageId` 只用于回报/排障） */
export interface PodImageLinkItem {
  fingerprint: string;
  imageId?: number;
}

/** 一次最多挂多少张识别图（一屏图片全选 24 张，留出几屏余量） */
export const POD_IMAGE_LINK_MAX = 200;

/**
 * 图片指纹的归一与校验（SHA-256 十六进制，64 位；这里放宽到 16..128 位以兼容历史值）。
 * 非法指纹**必须拒绝**：它是这张表的唯一身份，写进一串脏值等于让"同一张图"再也对不上。
 */
function cleanImageItems(raw: unknown): PodImageLinkItem[] {
  const out: PodImageLinkItem[] = [];
  const seen = new Set<string>();
  for (const item of Array.isArray(raw) ? raw : []) {
    const fp = typeof item?.fingerprint === 'string' ? item.fingerprint.trim().toLowerCase() : '';
    if (!fp) continue;
    if (!/^[0-9a-f]{16,128}$/.test(fp)) throw new Error(`图片指纹格式不对：${fp.slice(0, 16)}…`);
    if (seen.has(fp)) continue;
    seen.add(fp);
    out.push({ fingerprint: fp, imageId: posInt(item?.imageId) });
  }
  if (out.length > POD_IMAGE_LINK_MAX) throw new Error(`一次最多挂 ${POD_IMAGE_LINK_MAX} 张识别图`);
  return out;
}

/** 能被"认图案"的图案：存在且没被合并（合并掉的图案只能当合并的目标之外，不能再挂新东西） */
function assertBindablePattern(patternId: number): void {
  const row = dbQuery<Record<string, unknown>>(
    `SELECT COALESCE(merged_into, 0) AS merged_into FROM pod_patterns WHERE id = ?`,
    [patternId]
  )[0];
  if (!row) throw new Error('图案不存在（可能已被删除）');
  if (posInt(row.merged_into) > 0) {
    throw new Error('这个图案已经并到别的图案了 —— 去「合并图案」里撤销，或直接选目标图案');
  }
}

/**
 * 挂识别图（**不开事务**，由调用方包：新建图案时与建行同一批）。
 *
 * 同一张图被挂到第二个图案 = 改指过去（表上是 UPSERT），并计入 `moved`。
 * 这就是用户要的「相同的只保留一个」：结构上不允许一张图有两个主人。
 */
function linkImagesNow(
  patternId: number,
  images: PodImageLinkItem[],
  source: string
): { linked: number; moved: number } {
  let moved = 0;
  for (const im of images) {
    const prev = dbQuery<Record<string, unknown>>(
      `SELECT pattern_id FROM pod_pattern_images WHERE fingerprint = ?`,
      [im.fingerprint]
    )[0];
    if (prev && posInt(prev.pattern_id) !== patternId) moved += 1;
    dbRun(
      `INSERT INTO pod_pattern_images (fingerprint, pattern_id, image_id, source)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(fingerprint) DO UPDATE SET
         pattern_id = excluded.pattern_id, image_id = excluded.image_id,
         source = excluded.source, linked_at = datetime('now','localtime')`,
      [im.fingerprint, patternId, posInt(im.imageId), source]
    );
  }
  return { linked: images.length, moved };
}

/** 一次最多认多少个款色（款卡片一屏几十个颜色；上限留出"全部展开"的余量） */
export const POD_STYLE_COLOR_MAX = 500;

/** 款色 id 的归一：正整数、去重、限量。0 / 负数 / 非数字**丢掉**（订单没归类时就是 0） */
function cleanStyleColorIds(raw: unknown): number[] {
  const out: number[] = [];
  const seen = new Set<number>();
  for (const v of Array.isArray(raw) ? raw : []) {
    const id = posInt(v);
    if (id <= 0 || seen.has(id)) continue;
    seen.add(id);
    out.push(id);
  }
  if (out.length > POD_STYLE_COLOR_MAX) {
    throw new Error(`一次最多认 ${POD_STYLE_COLOR_MAX} 个款色`);
  }
  return out;
}

/**
 * 款色 → 图案（**不开事务**，由调用方包）。
 *
 * 与 `linkImagesNow` 同一套纪律：一个款色只有一个花，改指时计入 `moved` 并说给用户听。
 * 这条写入是「下次同款不用再认」的唯一依据（用户口径），所以**认图时必须一起写** ——
 * 只挂指纹不写款色，换一张商品图用户就得重认一遍。
 */
function linkStyleColorsNow(
  patternId: number,
  styleColorIds: number[],
  source: string
): { linked: number; moved: number } {
  let moved = 0;
  for (const id of styleColorIds) {
    const prev = dbQuery<{ pattern_id: number }>(
      `SELECT pattern_id FROM pod_style_color_patterns WHERE style_color_id = ?`,
      [id]
    )[0];
    if (prev && posInt(prev.pattern_id) !== patternId) moved += 1;
    dbRun(
      `INSERT INTO pod_style_color_patterns (style_color_id, pattern_id, source)
       VALUES (?, ?, ?)
       ON CONFLICT(style_color_id) DO UPDATE SET
         pattern_id = excluded.pattern_id, source = excluded.source,
         updated_at = datetime('now','localtime')`,
      [id, patternId, source]
    );
  }
  return { linked: styleColorIds.length, moved };
}

/**
 * 新建图案。
 *
 * ⚠️ `code` 空值必须**拒绝**（唯一索引 `ux_pod_patterns_code` 会让两行空码撞车，
 *    报的是一句 `UNIQUE constraint failed: pod_patterns.code`，用户看到的是"保存失败"）；
 *    重复码也拒绝并给出**人话**（"编码 P001 已存在"），不是把 SQL 错误原样抛给界面。
 *
 * `images` 与建行在**同一个事务**里：否则会出现"图案建好了、识别图没挂上"的半成品，
 * 而用户看到的是图案卡片上一张图都没有（会以为选图没生效）。
 */
export function podPatternCreate(input: PodPatternInput): {
  id: number;
  created: boolean;
  linked: number;
} {
  ensurePodSchema();
  const code = str(input?.code, 60);
  if (!code) throw new Error('图案编码不能为空');
  const existed = dbQuery<{ id: number }>(
    `SELECT id FROM pod_patterns WHERE code = ? COLLATE NOCASE`,
    [code]
  )[0];
  if (existed) throw new Error(`图案编码 ${code} 已存在`);
  const images = cleanImageItems(input?.images);
  const src = ['image', 'order', 'create', 'manual'].includes(str(input?.source, 20))
    ? str(input?.source, 20)
    : 'create';

  let id = 0;
  let linked = 0;
  dbTransaction(() => {
    const r = dbRun(
      `INSERT INTO pod_patterns (code, name, artwork_image_id, preview_image_id, note)
       VALUES (?, ?, ?, ?, ?)`,
      [
        code,
        str(input?.name, 120),
        posInt(input?.artworkImageId),
        posInt(input?.previewImageId),
        str(input?.note, 500),
      ]
    );
    id = Number(r.lastInsertRowid);
    if (images.length) linked = linkImagesNow(id, images, src).linked;
  });
  return { id, created: true, linked };
}

/** 改图案（只改传进来的字段；`undefined` = 不改 —— 与"改成空串"是两件事） */
export function podPatternUpdate(input: {
  id: number;
  name?: string;
  artworkImageId?: number;
  previewImageId?: number;
  note?: string;
  status?: string;
}): { changed: number } {
  ensurePodSchema();
  const id = posInt(input?.id);
  const cur = dbQuery<Record<string, unknown>>(`SELECT * FROM pod_patterns WHERE id = ?`, [id])[0];
  if (!cur) throw new Error('图案不存在（可能已被删除）');
  // 合并掉的图案不能在这里改：它的 status 由合并审计持有（撤销时按 `from_status` 还原）
  if (posInt(cur.merged_into) > 0) {
    throw new Error('这个图案已经并到别的图案了 —— 先撤销合并再改');
  }
  const status = str(input?.status, 20) || String(cur.status ?? 'active');
  if (status !== 'active' && status !== 'retired') {
    throw new Error('图案状态只能是 active / retired');
  }
  const r = dbRun(
    `UPDATE pod_patterns
        SET name = ?, artwork_image_id = ?, preview_image_id = ?, note = ?, status = ?,
            updated_at = datetime('now','localtime')
      WHERE id = ?`,
    [
      input?.name === undefined ? String(cur.name ?? '') : str(input.name, 120),
      input?.artworkImageId === undefined
        ? posInt(cur.artwork_image_id)
        : posInt(input.artworkImageId),
      input?.previewImageId === undefined
        ? posInt(cur.preview_image_id)
        : posInt(input.previewImageId),
      input?.note === undefined ? String(cur.note ?? '') : str(input.note, 500),
      status,
      id,
    ]
  );
  return { changed: Number(r.changes) || 0 };
}

/** 一个要绑的槽位（`variant_key` 是主键；另两段是**证据**，写下来便于对账/排障） */
export interface PodBindSlotInput {
  variantKey: string;
  imageKey?: string;
  skuCode?: string;
}

/** 一次最多绑多少个槽位（键盘流一次一屏 24 个；上限留出"全选一屏"的余量） */
const POD_BIND_MAX = 200;

/**
 * 绑定：一次一批、**一个事务**（半批绑上会留下"看起来绑了一半"的台账）。
 *
 * 落 `image_key` / `sku_code` 的意义：绑定台账要能回答"当初凭什么绑的这个"。
 * `image_key` 空 = 普通链接（色名已够）；非空 = 塌陷链接（靠图键分开）——
 * 塌陷链接的这 50 个槽位**禁止降级到色名**（红线 6），所以证据必须留在台账上。
 */
export function podBindSlots(input: {
  patternId: number;
  slots: PodBindSlotInput[];
  source?: string;
  state?: string;
}): { bound: number; patternId: number } {
  ensurePodSchema();
  const patternId = posInt(input?.patternId);
  const pattern = dbQuery<Record<string, unknown>>(`SELECT id FROM pod_patterns WHERE id = ?`, [
    patternId,
  ])[0];
  if (!pattern) throw new Error('图案不存在（先新建图案再绑）');
  const slots = Array.isArray(input?.slots) ? input.slots : [];
  if (!slots.length) throw new Error('没有要绑定的槽位');
  if (slots.length > POD_BIND_MAX) throw new Error(`一次最多绑定 ${POD_BIND_MAX} 个槽位`);

  const source = ['image', 'name', 'manual'].includes(str(input?.source, 20))
    ? str(input?.source, 20)
    : 'manual';
  const state = str(input?.state, 20) === 'suspected_merge' ? 'suspected_merge' : 'bound';

  const seen = new Set<string>();
  const clean: PodBindSlotInput[] = [];
  for (const s of slots) {
    const key = typeof s?.variantKey === 'string' ? s.variantKey : '';
    // 空键必须拒绝：`pod_variant_patterns.variant_key` 是主键，空串会与其它脏行撞成一条，
    // 而界面上表现为"绑了但订单还是没图案"。
    if (!key) throw new Error('槽位键为空（这条链接没有商品ID，绑不了）');
    if (seen.has(key)) continue; // 同批重复不重复写（幂等）
    seen.add(key);
    clean.push({
      variantKey: key,
      imageKey: str(s?.imageKey, 80),
      skuCode: str(s?.skuCode, 80),
    });
  }

  let n = 0;
  dbTransaction(() => {
    for (const s of clean) {
      dbRun(
        `INSERT INTO pod_variant_patterns (variant_key, pattern_id, source, image_key, sku_code, state)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(variant_key) DO UPDATE SET
           pattern_id = excluded.pattern_id, source = excluded.source,
           image_key = excluded.image_key, sku_code = excluded.sku_code,
           state = excluded.state, bound_at = datetime('now','localtime')`,
        [s.variantKey, patternId, source, s.imageKey ?? '', s.skuCode ?? '', state]
      );
      n += 1;
    }
  });
  return { bound: n, patternId };
}

/** 解绑（重绑错图案时的回退路径；一次一批，返回真正删掉的行数） */
export function podUnbindSlots(keys: string[]): { removed: number } {
  ensurePodSchema();
  const list = (Array.isArray(keys) ? keys : [])
    .filter((k) => typeof k === 'string' && k)
    .slice(0, POD_BIND_MAX);
  if (!list.length) return { removed: 0 };
  let removed = 0;
  dbTransaction(() => {
    for (const k of list) {
      const r = dbRun(`DELETE FROM pod_variant_patterns WHERE variant_key = ?`, [k]);
      removed += Number(r.changes) || 0;
    }
  });
  return { removed };
}

// ============================================================================
// 按图片认图案 + 图案合并（2026-11-02，用户口径）
//
// 「最终我们肯定是根据订单中的图片来决定印什么花的，可以参照款色的对应方式，可以支持合并，
//  最终相同的只保留一个」——
//   · 认图案的单位从「颜色槽位」换成**图片**（订单行自带 `image_id` → 内容指纹，见 `pod-need.ts`）；
//   · 图案自己持有一组识别图（`pod_pattern_images`，指纹主键 ⇒ 结构上"一张图只有一个主人"）；
//   · 合并会搬走识别图 / 颜色绑定 / 花纸批次，且**必须可拆**（审计照抄款色合并的纪律）。
// ============================================================================

/**
 * 挂识别图（认图案的主路径：一次把选中的几张图都归到一个图案）。
 *
 * 返回值里的 `moved` 不是错误，而是要**说给用户听**的事实：
 * "有 N 张图原来属于别的图案，已改到这张"。静默改指会让人以为系统自己乱动了。
 */
export function podImageLink(input: {
  patternId: number;
  images: PodImageLinkItem[];
  source?: string;
  /**
   * 这次一起认的款色（`oi_style_colors.id`）。与图片在**同一个事务**里写：
   * 否则会出现"图认上了、款色没记住"，下次同款换了张商品图就得重认。
   * 允许只给款色不给图（订单没图、或用户只按颜色认）。
   */
  styleColorIds?: number[];
}): { linked: number; moved: number; styleColors: number; movedStyleColors: number; patternId: number } {
  ensurePodSchema();
  const patternId = posInt(input?.patternId);
  if (!patternId) throw new Error('先选一个图案');
  const images = cleanImageItems(input?.images);
  const styleColorIds = cleanStyleColorIds(input?.styleColorIds);
  if (!images.length && !styleColorIds.length) throw new Error('没有选图片或颜色');
  assertBindablePattern(patternId);
  const src = ['image', 'order', 'create', 'manual'].includes(str(input?.source, 20))
    ? str(input?.source, 20)
    : 'manual';
  let out = { linked: 0, moved: 0 };
  let slot = { linked: 0, moved: 0 };
  dbTransaction(() => {
    if (images.length) out = linkImagesNow(patternId, images, src);
    if (styleColorIds.length) slot = linkStyleColorsNow(patternId, styleColorIds, src);
  });
  return {
    ...out,
    styleColors: slot.linked,
    movedStyleColors: slot.moved,
    patternId,
  };
}

/** 取消挂图（认错了的回退路径；图案本身留着）。`styleColorIds` 一并撤掉对应款色 */
export function podImageUnlink(
  fingerprints: string[],
  styleColorIdsRaw?: number[]
): { removed: number; removedStyleColors: number } {
  ensurePodSchema();
  const list = cleanImageItems(
    (Array.isArray(fingerprints) ? fingerprints : []).map((f) => ({ fingerprint: f }))
  ).map((i) => i.fingerprint);
  const slots = cleanStyleColorIds(styleColorIdsRaw);
  if (!list.length && !slots.length) return { removed: 0, removedStyleColors: 0 };
  let removed = 0;
  let removedStyleColors = 0;
  dbTransaction(() => {
    for (const fp of list) {
      const r = dbRun(`DELETE FROM pod_pattern_images WHERE fingerprint = ?`, [fp]);
      removed += Number(r.changes) || 0;
    }
    for (const id of slots) {
      const r = dbRun(`DELETE FROM pod_style_color_patterns WHERE style_color_id = ?`, [id]);
      removedStyleColors += Number(r.changes) || 0;
    }
  });
  return { removed, removedStyleColors };
}

/**
 * 款色 → 图案索引（净需件/报单用；**优先于**图片指纹）。
 * 只返回没被合并的图案：合并掉的源图案不能继续参与匹配（否则合并等于没生效）。
 */
export function podStyleColorIndex(): Map<number, number> {
  ensurePodSchema();
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT sp.style_color_id, sp.pattern_id
       FROM pod_style_color_patterns sp
       JOIN pod_patterns p ON p.id = sp.pattern_id
      WHERE p.merged_into = 0`
  );
  const out = new Map<number, number>();
  for (const r of rows) {
    const id = posInt(r.style_color_id);
    if (id > 0) out.set(id, posInt(r.pattern_id));
  }
  return out;
}

/**
 * 指纹 → 图案（净需件/报单用）。
 * 只返回**没被合并**的图案的挂图：合并掉的行虽然还留着眼睛看着的旧指纹，但不能参与匹配
 * （否则"合并后仍按旧图案报单"，等于合并没生效）。
 */
export function podImageIndex(): Map<string, number> {
  ensurePodSchema();
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT pi.fingerprint, pi.pattern_id
       FROM pod_pattern_images pi
       JOIN pod_patterns p ON p.id = pi.pattern_id
      WHERE p.merged_into = 0`
  );
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = String(r.fingerprint ?? '');
    if (k) out.set(k, posInt(r.pattern_id));
  }
  return out;
}

/** 一次最多并几个源图案（再多也不该在一次点击里发生） */
export const POD_MERGE_MAX = 50;

export interface PodPatternMergeOutcome {
  ok: boolean;
  /** 失败原因（人话，可直接展示；空 = 成功） */
  error: string;
  /** 撤销键（一次 N→1 = 一批；不是"每个源一个键"，否则撤销只能拆掉最后一个） */
  batchId: string;
  targetPatternId: number;
  movedImages: number;
  movedSlots: number;
  movedStyleColors: number;
  movedBatches: number;
}

/**
 * 把 `sourceIds` 并进 `targetId`（一次 N→1）。
 *
 * 搬四样（少搬一样都会留下"合并了但某处还指向旧图案"的暗账）：
 *   ① 识别图 `pod_pattern_images`；② 颜色绑定 `pod_variant_patterns`；
 *   ③ 款色 `pod_style_color_patterns`（2026-11-03；漏搬它，合并后同款仍按旧图案报单）；
 *   ④ 花纸批次 `pod_sheet_batches`。
 * 批次搬走后，件流水按 `batch_id` 跟着走（余量自动落到目标图案上，不需要改流水）。
 * 源图案**不删**：`status='merged' + merged_into=target`，界面过滤它，撤销时搬回来。
 */
export function podPatternMerge(input: {
  targetId: number;
  sourceIds: number[];
}): PodPatternMergeOutcome {
  ensurePodSchema();
  const target = posInt(input?.targetId);
  const srcIds = [
    ...new Set(
      (Array.isArray(input?.sourceIds) ? input.sourceIds : [])
        .map((n) => posInt(n))
        .filter((n) => n > 0 && n !== target)
    ),
  ].slice(0, POD_MERGE_MAX);
  const fail = (error: string): PodPatternMergeOutcome => ({
    ok: false,
    error,
    batchId: '',
    targetPatternId: target,
    movedImages: 0,
    movedSlots: 0,
    movedStyleColors: 0,
    movedBatches: 0,
  });
  if (target <= 0) return fail('先选要保留的那个图案');
  if (!srcIds.length) return fail('先选要并进来的图案');

  const rows = dbQuery<Record<string, unknown>>(
    `SELECT id, code, COALESCE(status, 'active') AS status, COALESCE(merged_into, 0) AS merged_into
       FROM pod_patterns WHERE id IN (${[target, ...srcIds].map(() => '?').join(',')})`,
    [target, ...srcIds]
  );
  const byId = new Map(rows.map((r) => [posInt(r.id), r]));
  if (!byId.has(target)) return fail('要保留的图案不存在（可能已被删除）');
  if (srcIds.some((id) => !byId.has(id))) {
    return fail('要合并的图案里有些不在了（刷新后再试）');
  }
  if ([target, ...srcIds].some((id) => posInt(byId.get(id)?.merged_into) > 0)) {
    return fail('有图案已经并过（先刷新，或先撤销那次合并）');
  }

  const batchId = `pm${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  let movedImages = 0;
  let movedSlots = 0;
  let movedStyleColors = 0;
  let movedBatches = 0;
  dbTransaction(() => {
    for (const srcId of srcIds) {
      const head = Number(
        dbRun(
          `INSERT INTO pod_pattern_merges (batch_id, source_pattern_id, target_pattern_id, from_status)
           VALUES (?, ?, ?, ?)`,
          [batchId, srcId, target, String(byId.get(srcId)?.status ?? 'active')]
        ).lastInsertRowid
      );
      for (const im of dbQuery<{ fingerprint: string }>(
        `SELECT fingerprint FROM pod_pattern_images WHERE pattern_id = ?`,
        [srcId]
      )) {
        dbRun(`UPDATE pod_pattern_images SET pattern_id = ? WHERE fingerprint = ?`, [
          target,
          im.fingerprint,
        ]);
        dbRun(
          `INSERT INTO pod_pattern_merge_items (merge_id, kind, ref, from_pattern_id, to_pattern_id)
           VALUES (?, 'image', ?, ?, ?)`,
          [head, im.fingerprint, srcId, target]
        );
        movedImages += 1;
      }
      for (const slot of dbQuery<{ variant_key: string }>(
        `SELECT variant_key FROM pod_variant_patterns WHERE pattern_id = ?`,
        [srcId]
      )) {
        dbRun(`UPDATE pod_variant_patterns SET pattern_id = ? WHERE variant_key = ?`, [
          target,
          slot.variant_key,
        ]);
        dbRun(
          `INSERT INTO pod_pattern_merge_items (merge_id, kind, ref, from_pattern_id, to_pattern_id)
           VALUES (?, 'slot', ?, ?, ?)`,
          [head, String(slot.variant_key ?? ''), srcId, target]
        );
        movedSlots += 1;
      }
      for (const sc of dbQuery<{ style_color_id: number }>(
        `SELECT style_color_id FROM pod_style_color_patterns WHERE pattern_id = ?`,
        [srcId]
      )) {
        dbRun(`UPDATE pod_style_color_patterns SET pattern_id = ? WHERE style_color_id = ?`, [
          target,
          posInt(sc.style_color_id),
        ]);
        dbRun(
          `INSERT INTO pod_pattern_merge_items (merge_id, kind, ref, from_pattern_id, to_pattern_id)
           VALUES (?, 'stylecolor', ?, ?, ?)`,
          [head, String(posInt(sc.style_color_id)), srcId, target]
        );
        movedStyleColors += 1;
      }
      for (const b of dbQuery<{ id: number }>(
        `SELECT id FROM pod_sheet_batches WHERE pattern_id = ?`,
        [srcId]
      )) {
        dbRun(`UPDATE pod_sheet_batches SET pattern_id = ? WHERE id = ?`, [target, posInt(b.id)]);
        dbRun(
          `INSERT INTO pod_pattern_merge_items (merge_id, kind, ref, from_pattern_id, to_pattern_id)
           VALUES (?, 'batch', ?, ?, ?)`,
          [head, String(posInt(b.id)), srcId, target]
        );
        movedBatches += 1;
      }
      dbRun(
        `UPDATE pod_patterns SET status = 'merged', merged_into = ?,
                updated_at = datetime('now','localtime')
          WHERE id = ?`,
        [target, srcId]
      );
    }
  });
  return {
    ok: true,
    error: '',
    batchId,
    targetPatternId: target,
    movedImages,
    movedSlots,
    movedStyleColors,
    movedBatches,
  };
}

/**
 * 拆开一次合并（按批次把明细逐条搬回，然后删掉整批）。
 *
 * 跳过而不是硬搬的情况（都要计数报出来，静默少还原几条会让人以为没拆干净）：
 *   · 这张图/这个键/这批花纸已经被后来的操作改到别处（当前父级 ≠ 本次的 `to`）；
 *   · 行已被删（`ON DELETE CASCADE`）。
 */
export function podPatternMergeUndo(batchIdRaw: string): {
  ok: boolean;
  error: string;
  restored: number;
  skipped: number;
} {
  ensurePodSchema();
  const batchId = typeof batchIdRaw === 'string' ? batchIdRaw.trim() : '';
  if (!batchId) return { ok: false, error: '没有指定要撤销的合并', restored: 0, skipped: 0 };
  const heads = dbQuery<Record<string, unknown>>(
    `SELECT * FROM pod_pattern_merges WHERE batch_id = ? ORDER BY id`,
    [batchId]
  );
  if (!heads.length) {
    return { ok: false, error: '这条合并记录不在了（可能已经撤销过）', restored: 0, skipped: 0 };
  }
  const items = dbQuery<Record<string, unknown>>(
    `SELECT i.* FROM pod_pattern_merge_items i
       JOIN pod_pattern_merges m ON m.id = i.merge_id
      WHERE m.batch_id = ?
      ORDER BY i.id DESC`,
    [batchId]
  );
  let restored = 0;
  let skipped = 0;
  dbTransaction(() => {
    for (const it of items) {
      const kind = String(it.kind ?? '');
      const ref = String(it.ref ?? '');
      const from = posInt(it.from_pattern_id);
      const to = posInt(it.to_pattern_id);
      if (kind === 'image') {
        const cur = dbQuery<{ pattern_id: number }>(
          `SELECT pattern_id FROM pod_pattern_images WHERE fingerprint = ?`,
          [ref]
        )[0];
        if (!cur || posInt(cur.pattern_id) !== to) {
          skipped += 1;
          continue;
        }
        dbRun(`UPDATE pod_pattern_images SET pattern_id = ? WHERE fingerprint = ?`, [from, ref]);
      } else if (kind === 'slot') {
        const cur = dbQuery<{ pattern_id: number }>(
          `SELECT pattern_id FROM pod_variant_patterns WHERE variant_key = ?`,
          [ref]
        )[0];
        if (!cur || posInt(cur.pattern_id) !== to) {
          skipped += 1;
          continue;
        }
        dbRun(`UPDATE pod_variant_patterns SET pattern_id = ? WHERE variant_key = ?`, [from, ref]);
      } else if (kind === 'stylecolor') {
        const id = posInt(ref);
        const cur = dbQuery<{ pattern_id: number }>(
          `SELECT pattern_id FROM pod_style_color_patterns WHERE style_color_id = ?`,
          [id]
        )[0];
        if (!cur || posInt(cur.pattern_id) !== to) {
          skipped += 1;
          continue;
        }
        dbRun(`UPDATE pod_style_color_patterns SET pattern_id = ? WHERE style_color_id = ?`, [
          from,
          id,
        ]);
      } else if (kind === 'batch') {
        const id = posInt(ref);
        const cur = dbQuery<{ pattern_id: number }>(
          `SELECT pattern_id FROM pod_sheet_batches WHERE id = ?`,
          [id]
        )[0];
        if (!cur || posInt(cur.pattern_id) !== to) {
          skipped += 1;
          continue;
        }
        dbRun(`UPDATE pod_sheet_batches SET pattern_id = ? WHERE id = ?`, [from, id]);
      } else {
        skipped += 1;
        continue;
      }
      restored += 1;
    }
    for (const h of heads) {
      dbRun(
        `UPDATE pod_patterns SET status = ?, merged_into = 0,
                updated_at = datetime('now','localtime')
          WHERE id = ?`,
        [String(h.from_status ?? 'active'), posInt(h.source_pattern_id)]
      );
    }
    dbRun(`DELETE FROM pod_pattern_merges WHERE batch_id = ?`, [batchId]);
  });
  return { ok: true, error: '', restored, skipped };
}

export interface PodPatternMergeRecord {
  batchId: string;
  targetPatternId: number;
  targetCode: string;
  sources: { id: number; code: string }[];
  movedImages: number;
  movedSlots: number;
  movedStyleColors: number;
  movedBatches: number;
  createdAt: string;
}

/** 最近的合并记录（界面「合并图案」里给撤销入口；新的在前） */
export function podPatternMergeHistory(limit = 50): PodPatternMergeRecord[] {
  ensurePodSchema();
  const cap = Math.min(Math.max(posInt(limit, 50) || 50, 1), 200);
  const heads = dbQuery<Record<string, unknown>>(
    `SELECT m.batch_id AS batch_id, m.target_pattern_id AS tgt,
            COALESCE(t.code, '') AS tgt_code, MIN(m.created_at) AS created_at,
            (SELECT COUNT(*) FROM pod_pattern_merge_items i
               JOIN pod_pattern_merges x ON x.id = i.merge_id
              WHERE x.batch_id = m.batch_id AND i.kind = 'image') AS moved_images,
            (SELECT COUNT(*) FROM pod_pattern_merge_items i
               JOIN pod_pattern_merges x ON x.id = i.merge_id
              WHERE x.batch_id = m.batch_id AND i.kind = 'slot') AS moved_slots,
            (SELECT COUNT(*) FROM pod_pattern_merge_items i
               JOIN pod_pattern_merges x ON x.id = i.merge_id
              WHERE x.batch_id = m.batch_id AND i.kind = 'stylecolor') AS moved_style_colors,
            (SELECT COUNT(*) FROM pod_pattern_merge_items i
               JOIN pod_pattern_merges x ON x.id = i.merge_id
              WHERE x.batch_id = m.batch_id AND i.kind = 'batch') AS moved_batches
       FROM pod_pattern_merges m
       LEFT JOIN pod_patterns t ON t.id = m.target_pattern_id
      GROUP BY m.batch_id, m.target_pattern_id
      ORDER BY MAX(m.id) DESC
      LIMIT ?`,
    [cap]
  );
  return heads.map((r) => {
    const batchId = String(r.batch_id ?? '');
    const sources = dbQuery<{ id: number; code: string }>(
      `SELECT m.source_pattern_id AS id, COALESCE(p.code, '') AS code
         FROM pod_pattern_merges m
         LEFT JOIN pod_patterns p ON p.id = m.source_pattern_id
        WHERE m.batch_id = ?
        ORDER BY m.id`,
      [batchId]
    ).map((s) => ({ id: posInt(s.id), code: String(s.code ?? '') }));
    return {
      batchId,
      targetPatternId: posInt(r.tgt),
      targetCode: String(r.tgt_code ?? ''),
      sources,
      movedImages: posInt(r.moved_images),
      movedSlots: posInt(r.moved_slots),
      movedStyleColors: posInt(r.moved_style_colors),
      movedBatches: posInt(r.moved_batches),
      createdAt: String(r.created_at ?? ''),
    };
  });
}

// ============================================================================
// 花纸批次 / 件流水 / 余量（M4·T4-4 / T4-5）
//
// 三条不能错的（计划 §M4 已定）：
//   ① **余量按「件」算，不按「张」** —— `sheets * pieces_per_sheet` 才是件数；
//   ② **`pieces_per_sheet` 记批次行，不记图案主表** —— 换排版就变，记主表会让历史批次被新值改写；
//   ③ **报单（建批次）时不扣余量，印花完成才扣** —— 报单只是意向，花纸没到就扣等于账上凭空少货。
// 所以：建批次（`podBatchCreate`）**不写 `print` 流水**；到货（`podBatchArrive`）才写 `arrive +`；
// 印花完成（`podPrint`）写 `print -`，并按 `podLedger.allocatePrint` 的 FIFO 分到具体批次。
// ============================================================================

/** 一个花纸批次 + 它现在的余量（余量来自流水求和，不存冗余列） */
export interface PodBatchRow {
  id: number;
  patternId: number;
  patternCode: string;
  sheets: number;
  piecesPerSheet: number;
  /** `sheets * piecesPerSheet`（这批一共多少**件**） */
  totalPieces: number;
  /** 本批**当前剩余件数**（= 该批流水求和；可为负 —— 那是"盘点发现少了"，别藏） */
  remainingPieces: number;
  supplier: string;
  costCents: number;
  orderedAt: string;
  arrivedAt: string;
  note: string;
}

const MAX_SHEETS = 100000;
const MAX_PIECES_PER_SHEET = 1000;
const MAX_PRINT_PIECES = 5000;

/** 批次余量（FIFO 分配用；只给还有余量的批次，顺序不敏感） */
export function podBatchRemaining(
  patternId: number
): { batchId: number; remaining: number; orderedAt: string }[] {
  ensurePodSchema();
  const pid = posInt(patternId);
  if (!pid) return [];
  return dbQuery<Record<string, unknown>>(
    `SELECT b.id AS batch_id, b.ordered_at,
            COALESCE(SUM(l.delta_pieces), 0) AS remaining
       FROM pod_sheet_batches b
       LEFT JOIN pod_sheet_ledger l ON l.batch_id = b.id
      WHERE b.pattern_id = ?
      GROUP BY b.id
     HAVING remaining > 0
      ORDER BY b.ordered_at, b.id`,
    [pid]
  ).map((r) => ({
    batchId: posInt(r.batch_id),
    remaining: Number(r.remaining) || 0,
    orderedAt: String(r.ordered_at ?? ''),
  }));
}

/**
 * 建一个花纸批次（= 报单一次）。
 *
 * ⚠️ **默认不写 `arrive` 流水**：报单只是意向，花纸还没到。`arrive=true` 是"先记批次同时记到货"
 * （补录历史批次时用），走的是同一个 `podBatchArrive()`，不另写一份加法。
 */
export function podBatchCreate(input: {
  patternId: number;
  sheets: number;
  piecesPerSheet: number;
  supplier?: string;
  costCents?: number;
  /** `yyyy-mm-dd`；空 = 用今天（本地时区） */
  orderedAt?: string;
  note?: string;
  arrive?: boolean;
}): { batchId: number; arrivedPieces: number } {
  ensurePodSchema();
  const patternId = posInt(input?.patternId);
  if (!patternId) throw new Error('缺少图案（先选图案再报单）');
  const hit = dbQuery<Record<string, unknown>>(
    `SELECT COALESCE(merged_into, 0) AS merged_into FROM pod_patterns WHERE id = ?`,
    [patternId]
  )[0];
  if (!hit) throw new Error('图案不存在（可能已被删除）');
  // 合并掉的图案不能再报单：它的花纸批次已经搬到目标图案上了，再报一批会变成"另一份库存"
  if (posInt(hit.merged_into) > 0)
    throw new Error('这个图案已经并到别的图案了 —— 去订花纸页选目标图案');
  const sheets = posInt(input?.sheets);
  const perSheet = posInt(input?.piecesPerSheet);
  if (sheets <= 0) throw new Error('张数必须大于 0');
  if (perSheet <= 0) throw new Error('每张件数必须大于 0（余量按件算，单位错了余量复用全废）');
  if (sheets > MAX_SHEETS) throw new Error(`张数上限 ${MAX_SHEETS}`);
  if (perSheet > MAX_PIECES_PER_SHEET) throw new Error(`每张件数上限 ${MAX_PIECES_PER_SHEET}`);
  const orderedAt = str(input?.orderedAt, 10) || new Date().toISOString().slice(0, 10);

  let batchId = 0;
  dbTransaction(() => {
    const r = dbRun(
      `INSERT INTO pod_sheet_batches
         (pattern_id, sheets, pieces_per_sheet, supplier, cost_cents, ordered_at, note)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [
        patternId,
        sheets,
        perSheet,
        str(input?.supplier, 120),
        posInt(input?.costCents),
        orderedAt,
        str(input?.note, 500),
      ]
    );
    batchId = Number(r.lastInsertRowid);
  });
  const arrivedPieces = input?.arrive === true ? podBatchArrive(batchId).arrivedPieces : 0;
  return { batchId, arrivedPieces };
}

/**
 * 到货：写 `arrive` 正流水并记 `arrived_at`。
 *
 * **幂等**：已到过货的批次直接返回 `arrived:false`，不再加一次。
 * 没有这层，"点两下到货"就是账上多出一批货，而看板上的余量看起来完全正常 —— 盘点时才发现对不上，
 * 那时已经无法判断是哪一次点重了。
 */
export function podBatchArrive(batchId: number): { arrived: boolean; arrivedPieces: number } {
  ensurePodSchema();
  const id = posInt(batchId);
  if (!id) throw new Error('缺少批次 id');
  const b = dbQuery<Record<string, unknown>>(
    `SELECT id, sheets, pieces_per_sheet, arrived_at FROM pod_sheet_batches WHERE id = ?`,
    [id]
  )[0];
  if (!b) throw new Error('批次不存在（可能已被删除）');
  if (String(b.arrived_at ?? '')) return { arrived: false, arrivedPieces: 0 };
  const already = dbQuery<Record<string, unknown>>(
    `SELECT COUNT(*) AS n FROM pod_sheet_ledger WHERE batch_id = ? AND reason = 'arrive'`,
    [id]
  )[0];
  if (posInt(already?.n) > 0) return { arrived: false, arrivedPieces: 0 };

  const pieces = posInt(b.sheets) * posInt(b.pieces_per_sheet);
  dbTransaction(() => {
    dbRun(
      `INSERT INTO pod_sheet_ledger (batch_id, delta_pieces, reason, ref_order_item_id)
       VALUES (?, ?, 'arrive', 0)`,
      [id, pieces]
    );
    dbRun(`UPDATE pod_sheet_batches SET arrived_at = datetime('now','localtime') WHERE id = ?`, [
      id,
    ]);
  });
  return { arrived: true, arrivedPieces: pieces };
}

/**
 * 印花扣减：按 FIFO 分到批次，一次事务写完全部负流水。
 *
 * ⚠️ **不足就整批拒绝**（`allocatePrint` 的 `shortfall > 0`）：半扣会留下"扣了 3 件但一张花纸
 * 都没领"的中间态，而印花完成是按整单计数的事实。拒绝时**报差多少件**，让人去补货或改单。
 *
 * `refOrderItemId` 记的是"这一批件为哪条订单行印的"（0 = 手工盘点/无来源）。
 * 只记一条：一次扣减通常对应一条订单行的件数，多行合并扣时调用方应分行调用（按行记才对得上账）。
 */
export function podPrint(input: { patternId: number; pieces: number; refOrderItemId?: number }): {
  printed: number;
  allocations: { batchId: number; pieces: number }[];
} {
  ensurePodSchema();
  const patternId = posInt(input?.patternId);
  if (!patternId) throw new Error('缺少图案');
  const pieces = posInt(input?.pieces);
  if (pieces <= 0) throw new Error('印花件数必须大于 0');
  if (pieces > MAX_PRINT_PIECES) throw new Error(`单次印花件数上限 ${MAX_PRINT_PIECES}`);

  const plan = allocatePrint(podBatchRemaining(patternId), pieces);
  if (plan.shortfall > 0) {
    throw new Error(`花纸余量不足：还差 ${plan.shortfall} 件（先报到货或补报）`);
  }
  const ref = posInt(input?.refOrderItemId);
  dbTransaction(() => {
    for (const a of plan.allocations) {
      dbRun(
        `INSERT INTO pod_sheet_ledger (batch_id, delta_pieces, reason, ref_order_item_id)
         VALUES (?, ?, 'print', ?)`,
        [a.batchId, -a.pieces, ref]
      );
    }
  });
  return { printed: pieces, allocations: plan.allocations };
}

/**
 * 盘点调整（±）：账面与实物对不上时留一行**带符号**的流水。
 * 不走 `UPDATE` 改旧行 —— 流水一旦可改，"余量为什么是这个数"就永远讲不清了。
 */
export function podAdjust(input: { batchId: number; deltaPieces: number; note?: string }): {
  adjusted: number;
} {
  ensurePodSchema();
  const batchId = posInt(input?.batchId);
  if (!batchId) throw new Error('缺少批次 id');
  if (!dbQuery(`SELECT id FROM pod_sheet_batches WHERE id = ?`, [batchId])[0]) {
    throw new Error('批次不存在（可能已被删除）');
  }
  const delta = Math.round(Number(input?.deltaPieces) || 0);
  if (delta === 0) return { adjusted: 0 };
  dbRun(
    `INSERT INTO pod_sheet_ledger (batch_id, delta_pieces, reason, ref_order_item_id)
     VALUES (?, ?, 'adjust', 0)`,
    [batchId, delta]
  );
  return { adjusted: delta };
}

/** 批次清单（按图案 / 只看某图案；新的在前） */
export function podBatchList(q: { patternId?: number; limit?: number } = {}): PodBatchRow[] {
  ensurePodSchema();
  const patternId = posInt(q?.patternId);
  const limit = Math.min(Math.max(posInt(q?.limit, 200) || 200, 1), 500);
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT b.id, b.pattern_id, b.sheets, b.pieces_per_sheet, b.supplier, b.cost_cents,
            b.ordered_at, b.arrived_at, b.note, COALESCE(p.code, '') AS pattern_code,
            COALESCE((SELECT SUM(l.delta_pieces) FROM pod_sheet_ledger l WHERE l.batch_id = b.id), 0) AS remaining
       FROM pod_sheet_batches b
       LEFT JOIN pod_patterns p ON p.id = b.pattern_id
      ${patternId ? 'WHERE b.pattern_id = ?' : ''}
      ORDER BY b.ordered_at DESC, b.id DESC
      LIMIT ?`,
    patternId ? [patternId, limit] : [limit]
  );
  return rows.map((r) => ({
    id: posInt(r.id),
    patternId: posInt(r.pattern_id),
    patternCode: String(r.pattern_code ?? ''),
    sheets: posInt(r.sheets),
    piecesPerSheet: posInt(r.pieces_per_sheet),
    totalPieces: posInt(r.sheets) * posInt(r.pieces_per_sheet),
    remainingPieces: Number(r.remaining) || 0,
    supplier: String(r.supplier ?? ''),
    costCents: posInt(r.cost_cents),
    orderedAt: String(r.ordered_at ?? ''),
    arrivedAt: String(r.arrived_at ?? ''),
    note: String(r.note ?? ''),
  }));
}

/** 余量看板的一行（直接来自视图 `pod_pattern_balance`，不另算一遍） */
export interface PodBalanceRow {
  patternId: number;
  code: string;
  name: string;
  remainingPieces: number;
  boundSlots: number;
}

export function podBalanceRows(): PodBalanceRow[] {
  ensurePodSchema();
  return dbQuery<Record<string, unknown>>(
    `SELECT b.pattern_id, b.code, COALESCE(p.name, '') AS name, b.remaining_pieces,
            COALESCE((SELECT COUNT(*) FROM pod_variant_patterns v WHERE v.pattern_id = b.pattern_id), 0) AS bound_slots
       FROM pod_pattern_balance b
       LEFT JOIN pod_patterns p ON p.id = b.pattern_id
      WHERE p.merged_into = 0
      ORDER BY b.remaining_pieces ASC, b.code`
  ).map((r) => ({
    patternId: posInt(r.pattern_id),
    code: String(r.code ?? ''),
    name: String(r.name ?? ''),
    remainingPieces: Number(r.remaining_pieces) || 0,
    boundSlots: posInt(r.bound_slots),
  }));
}

/**
 * 绑定索引 `variant_key → pattern_id`（净需件/报单用）。
 * 只返回**图案仍存在**的绑定：图案被删后留下的孤儿绑定不能让净需件凭空出现。
 */
export function podBindingIndex(): Map<string, number> {
  ensurePodSchema();
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT v.variant_key, v.pattern_id
       FROM pod_variant_patterns v
       JOIN pod_patterns p ON p.id = v.pattern_id
      WHERE p.merged_into = 0`
  );
  const out = new Map<string, number>();
  for (const r of rows) {
    const k = String(r.variant_key ?? '');
    if (k) out.set(k, posInt(r.pattern_id));
  }
  return out;
}
