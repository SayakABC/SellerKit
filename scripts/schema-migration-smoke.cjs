// 版本化迁移冒烟（不启动界面）。
//
//   npm run schema:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/schema-migration-smoke.cjs
//
// 为什么值得单独一个冒烟：`electron/db.ts` 的 `migrate` 是"改形状"的唯一通道，
// 而它服务的场景（老库 vs 新库形状不一致）**在全新库上永远复现不出来** ——
// 2026-09-29 的实测教训就是这么来的：`pl_shop_sku` 的唯一键由 4 列扩成 5 列，
// 幂等 DDL 不会重建老库，于是老库 4 列 / 新库 5 列，代码里对旧形状的假设在新库上必失败。
//
// 覆盖的不变量：
//   · 老库（4 列唯一键 + 缺 image_url/imported_at）→ 迁移后**数据一条不丢**（行数/主键/取值/默认值）
//   · 迁移后索引仍在（重建表最容易丢的就是它：索引跟着老表改名会被 `IF NOT EXISTS` 静默跳过）
//   · 迁移后唯一键含 product_id（一对多的前提）→ 同 (店,商品,规格) 可挂第二个产品
//   · AUTOINCREMENT 序列被重置 → 新插入不复用已发出的 id
//   · 幂等：再跑一次不报错、不重复搬数据、版本不回退
//   · 新库（已 5 列）走的是"跳过重建"那条路，不产生 __old 表
//   · 删列（purchase_orders.note）：老库 DROP 后数据不丢、建单路径可用；新库直建即无该列（两侧形状一致）
// 每个场景自带独立临时库。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const {
  initDb,
  closeDb,
  dbRun,
  dbGet,
  dbQuery,
  dbMigrate,
  migrationVersion,
} = require(
  path.join(ROOT, 'dist', 'electron', 'db.js'),
);
const pdb = require(path.join(ROOT, 'dist', 'electron', 'product-db.js'));

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed++;
    console.log(`  \u2717 ${name}\n      ${err.message}`);
  }
}

/**
 * 各迁移链的**当前步数**（= 全量迁移跑完后 `sk_schema_migrations` 里的版本号）。
 *
 * ⚠️ 给对应链加一步就必须改这里的常数 —— 但这不是麻烦，而是**该被提醒的时刻**：
 *    版本号变了意味着"老库会被多搬一次"，老库路径本来就该跟着复核一遍。
 *    所以**别**改成"从源码里读出来，读到多少算多少"：那样新加的步骤会**静默地不被任何断言覆盖**，
 *    而本文件存在的全部理由就是"老库场景在全新库上永远复现不出来"。
 * 下面的 `迁移步数与源码一致` 会拿源码里 `version: N` 的条数比对这几个常数，防止它们悄悄分叉
 * （本文件曾因 product.sku 偷偷加了一步而连红 3 条，正是缺这道比对）。
 */
// pl_shop_sku：1 补列 → 2 唯一键归一 → 3 删 pl_item_weights（克重只属 SKU）
const PRODUCT_SKU_STEPS = 3;
// oi_*：1/2 提列 → 3 主干归一 → 4 历史采集单回填 → 5 色名回填 → 6 style_color_id → 7 行级快照
// → 8 拆表 → 9 成本两字段（C2：actual_cost_cents + 预估回填）→ 10 删旧价目表 ae_cost_map
// → 11 删退役的 oi_queue（云端识别链整条删除，队列无写入方也无读取方）
// → 12 订单行 += variant_key（店铺+商品ID+平台色）· 从 raw_fields 回填 · oi_variant_keys 建表
// （2026-10-21 订正：v5–v6 加进来时这两个常数没跟着改，冒烟从那时起一直红着 —— 本轮一并补齐）
// （2026-10-28 订正：v11 加进来时同样漏改常数，7 条断言一起红 —— 加迁移必须同一提交改这里）
const ORDER_MAIN_STEPS = 13;
const AE_MAIN_STEPS = 2; // ae 域：1 成本生效区间重建 → 3 删弃表（v2 补列已随表删除）
// purchase_orders：1 删 note → 2 purchase_items += style_color_id
// → 3 purchase_sources += order_item_id（2026-10-22 补：常数漏改，[0] 自证拦下）
const PURCHASE_STEPS = 3;

/** 数一数某个 xxxMigrationSteps() 里有几个 version:（返回 -1 = 压根没找到那个函数体） */
function stepsInSource(file, fnName) {
  const src = fs.readFileSync(path.join(ROOT, 'electron', file), 'utf8');
  const body = src.match(new RegExp('function ' + fnName + '\\(\\)[\\s\\S]*?\\n\\}'));
  return body ? (body[0].match(/version:\s*\d+/g) || []).length : -1;
}

function newDb(tag) {
  closeDb();
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), `sellerkit-mig-${tag}-`));
  initDb(path.join(dir, 'smoke.db'));
  return dir;
}

// ── 先自证：步数常数与源码一致（不然下面三条断言的"期望值"本身是过期的）
console.log('\n[0] 迁移步数常数 ↔ 源码');
check('迁移步数与源码一致（加了一步却忘了改常数 → 这里先红，而不是下面三条神秘地红）', () => {
  assert.strictEqual(
    stepsInSource('product-db.ts', 'skuMigrationSteps'),
    PRODUCT_SKU_STEPS,
    'product.sku 的步数变了：改 PRODUCT_SKU_STEPS，并复核 A/B 两个老库场景',
  );
  assert.strictEqual(
    stepsInSource('order-db.ts', 'orderMigrationSteps'),
    ORDER_MAIN_STEPS,
    'order.main 的步数变了：改 ORDER_MAIN_STEPS，并复核 C/E 两个老库场景',
  );
  assert.strictEqual(
    stepsInSource('ae-db.ts', 'aeMigrationSteps'),
    AE_MAIN_STEPS,
    'ae.main 的步数变了：改 AE_MAIN_STEPS，并复核 D 场景',
  );
  assert.strictEqual(
    stepsInSource('purchase-db.ts', 'purchaseMigrationSteps'),
    PURCHASE_STEPS,
    'purchase.main 的步数变了：改 PURCHASE_STEPS，并复核 F 场景',
  );
});

/**
 * 造一张「商品ID 克重」老表（v3 迁移要把它删掉）。
 * 真实历史形状不可考（该表从未进过本仓库的 DDL 记录），字段按迁移文档里点过名的
 * `item_id` / `weight_g` 取 —— 本场景只关心"存在 → 被删"，不关心列细节。
 */
function buildLegacyItemWeights() {
  dbMigrate([
    `CREATE TABLE pl_item_weights (
      item_id TEXT PRIMARY KEY,
      weight_g INTEGER NOT NULL DEFAULT 0,
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`,
  ]);
}

/** 造一个**老库形状**的 pl_shop_sku：4 列唯一键、且没有 image_url / imported_at */
function buildLegacyTable() {
  dbMigrate([
    `CREATE TABLE pl_shop_sku (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      platform TEXT NOT NULL DEFAULT '',
      shop_id INTEGER NOT NULL DEFAULT 0,
      item_id TEXT NOT NULL,
      spec TEXT NOT NULL DEFAULT '*',
      product_id INTEGER NOT NULL DEFAULT 0,
      variant_id INTEGER NOT NULL DEFAULT 0,
      qty_per_item INTEGER NOT NULL DEFAULT 1,
      status TEXT NOT NULL DEFAULT 'confirmed',
      source TEXT NOT NULL DEFAULT 'manual',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      UNIQUE(platform, shop_id, item_id, spec)
    )`,
  ]);
}

function insertRow(o) {
  dbRun(
    `INSERT INTO pl_shop_sku (platform, shop_id, item_id, spec, product_id, status, source, note)
     VALUES (?,?,?,?,?,?,?,?)`,
    [
      o.platform,
      o.shopId,
      o.itemId,
      o.spec || '*',
      o.productId,
      o.status || 'confirmed',
      o.source || 'manual',
      o.note || '',
    ],
  );
}

// ────────────────────────────────────────────────────────── 场景 A：老库追上
console.log('\n[A] 老库（4 列唯一键 + 缺两列）→ 迁移');
const dirA = newDb('legacy');
buildLegacyTable();
buildLegacyItemWeights();
dbRun(`INSERT INTO pl_item_weights (item_id, weight_g) VALUES ('A1', 300)`); // 有数据也照删（该数据源整体退场）
insertRow({ platform: 'amazon', shopId: 1, itemId: 'A1', productId: 0, source: 'shop-import' });
insertRow({ platform: 'amazon', shopId: 1, itemId: 'A2', productId: 7 });
insertRow({
  platform: 'taobao',
  shopId: 2,
  itemId: 'A3',
  productId: 9,
  status: 'invalid',
  note: '备注',
});
const before = dbQuery(`SELECT id, platform, shop_id, item_id, product_id, status, source, note
                        FROM pl_shop_sku ORDER BY id`);

check('迁移前：确实是老形状（唯一键不含 product_id）+ 老库确有「商品ID 克重」表', () => {
  const sql = require(path.join(ROOT, 'dist', 'electron', 'db.js')).tableSql('pl_shop_sku');
  assert.ok(!/unique\s*\([^)]*product_id/i.test(sql), `建表 SQL 不该含 product_id 唯一键：${sql}`);
  assert.ok(!/image_url/.test(sql), '老库不该有 image_url 列');
  assert.strictEqual(
    require(path.join(ROOT, 'dist', 'electron', 'db.js')).tableExists('pl_item_weights'),
    true,
    '夹具没造出 pl_item_weights，v3 的 DROP 分支会静默跳过',
  );
});

let applied = 0;
check('ensureSkuSchema 不抛错并把迁移链跑到底', () => {
  pdb.ensureSkuSchema();
  const db = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
  applied = db.migrationVersion('product.sku');
  assert.strictEqual(applied, PRODUCT_SKU_STEPS);
});

check('v3 迁移删掉 pl_item_weights（「商品ID 克重」整条链退场；有数据也照删）', () => {
  const db = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
  assert.strictEqual(db.tableExists('pl_item_weights'), false);
});

check('数据一条不丢（行数 / 主键 / 取值）', () => {
  const after = dbQuery(`SELECT id, platform, shop_id, item_id, product_id, status, source, note
                         FROM pl_shop_sku ORDER BY id`);
  assert.deepStrictEqual(after, before);
});

check('补列生效且老行取默认值', () => {
  const rows = dbQuery(`SELECT image_url, imported_at FROM pl_shop_sku ORDER BY id`);
  assert.strictEqual(rows.length, 3);
  for (const r of rows) {
    assert.strictEqual(r.image_url, '');
    assert.strictEqual(Number(r.imported_at), 0);
  }
});

check('唯一键已含 product_id（形状判定再跑为真）', () => {
  const db = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
  const sql = db.tableSql('pl_shop_sku');
  assert.ok(/unique\s*\([^)]*product_id[^)]*\)/i.test(sql), `唯一键未升级：${sql}`);
  const idx = dbQuery(`PRAGMA index_info('sqlite_autoindex_pl_shop_sku_1')`).map((r) => r.name);
  assert.deepStrictEqual(idx, ['platform', 'shop_id', 'item_id', 'spec', 'product_id']);
});

check('索引没有在重建中丢掉', () => {
  const names = dbQuery(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='pl_shop_sku'`)
    .map((r) => String(r.name))
    .sort();
  assert.ok(names.includes('idx_pl_shop_sku_lookup'), `缺 lookup 索引：${names.join(',')}`);
  assert.ok(names.includes('idx_pl_shop_sku_product'), `缺 product 索引：${names.join(',')}`);
});

check('临时表已清理（不留 pl_shop_sku_legacy_struct）', () => {
  const n = dbGet(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'pl_shop_sku_legacy_struct'`,
  );
  assert.strictEqual(Number(n.n), 0);
});

check('一对多现在是允许的（同店同商品同规格挂第二个产品）', () => {
  insertRow({ platform: 'amazon', shopId: 1, itemId: 'A2', productId: 8 });
  const rows = dbQuery(
    `SELECT product_id FROM pl_shop_sku WHERE item_id = 'A2' ORDER BY product_id`,
  );
  assert.deepStrictEqual(rows.map((r) => Number(r.product_id)), [7, 8]);
});

check('AUTOINCREMENT 序列已重置：新 id 不复用', () => {
  const maxBefore = Number(dbGet(`SELECT MAX(id) AS m FROM pl_shop_sku`).m);
  const info = dbRun(
    `INSERT INTO pl_shop_sku (platform, shop_id, item_id, spec, product_id, status, source, note)
     VALUES ('amazon', 1, 'A9', '*', 0, 'confirmed', 'shop-import', '')`,
  );
  assert.strictEqual(info.lastInsertRowid, maxBefore + 1);
});

check('幂等：再跑一次不报错、不搬数据、版本不回退', () => {
  const rowsBefore = Number(dbGet(`SELECT COUNT(*) AS n FROM pl_shop_sku`).n);
  pdb.ensureSkuSchema();
  pdb.ensureSkuSchema();
  const db = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
  assert.strictEqual(db.migrationVersion('product.sku'), PRODUCT_SKU_STEPS);
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM pl_shop_sku`).n), rowsBefore);
  assert.strictEqual(db.tableExists('pl_item_weights'), false, '重跑不该把它带回来');
});
closeDb();
try {
  fs.rmSync(dirA, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

// ────────────────────────────────────────────────────────── 场景 B：新库不重建
console.log('\n[B] 新库（ensureSkuSchema 直建）→ 跳过重建');
const dirB = newDb('fresh');
check(`新库一次到位：5 列唯一键 + 版本记为 ${PRODUCT_SKU_STEPS} + 无 legacy 残留表`, () => {
  pdb.ensureSkuSchema();
  const db = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
  assert.strictEqual(db.migrationVersion('product.sku'), PRODUCT_SKU_STEPS);
  const idx = dbQuery(`PRAGMA index_info('sqlite_autoindex_pl_shop_sku_1')`).map((r) => r.name);
  assert.deepStrictEqual(idx, ['platform', 'shop_id', 'item_id', 'spec', 'product_id']);
  const n = dbGet(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name = 'pl_shop_sku_legacy_struct'`);
  assert.strictEqual(Number(n.n), 0);
});
check('新库上池/映射两个谓词都可用（种群标记查询不报错）', () => {
  const pool = dbQuery(`SELECT COUNT(*) AS n FROM pl_shop_sku WHERE ${pdb.skuPoolSql()}`);
  const mapping = dbQuery(`SELECT COUNT(*) AS n FROM pl_shop_sku WHERE ${pdb.skuMappingSql()}`);
  assert.strictEqual(Number(pool[0].n), 0);
  assert.strictEqual(Number(mapping[0].n), 0);
});
closeDb();
try {
  fs.rmSync(dirB, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

// ────────────────────────────────────────────────────────── 场景 C：订单域老库追上
console.log('\n[C] oi_orders 老库（无金额/状态/时点列）→ 迁移后提列可用');
const dirC = newDb('order-legacy');
const odb = require(path.join(ROOT, 'dist', 'electron', 'order-db.js'));
dbMigrate([
  // **老库的图片表叫 `oi_images`**（R1 / S0a 之后已退役，新库只有主数据域的 `md_images`；
  // 见 `electron/order-db.ts` 的 `retireLegacyImageTables`）。老库 2026-10 前的真形状里，
  // `oi_orders.image_id` 写的是 `REFERENCES oi_images(id) ON DELETE CASCADE` —— 而 v3 的
  // 冻结 DDL（`ORDER_LEGACY_SPINE_DDL`）原样复刻了这条外键，于是"重建主干 / 搬数据"两步都会先撞
  // `no such table: main.oi_images`。所以这个表**必须按老库真实表名造出来**，不能拿 `md_images`
  // 顶替（`insertOrder` 也不校验父行，图行只是占位）。
  // 迁移末尾 `retireLegacyImageTables` 会把它拆掉：R1 的口径是"清库重建"，旧图**不做数据迁移**。
  `CREATE TABLE oi_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT NOT NULL DEFAULT '',
    url_fingerprint TEXT NOT NULL UNIQUE,
    source_url TEXT NOT NULL,
    local_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result_json TEXT,
    error TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE TABLE oi_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL REFERENCES oi_images(id) ON DELETE CASCADE,
    order_no TEXT NOT NULL,
    shop TEXT NOT NULL DEFAULT '',
    size TEXT NOT NULL DEFAULT '',
    order_time TEXT NOT NULL DEFAULT '',
    raw_fields TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    logo TEXT NOT NULL DEFAULT '',
    material TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    corrected INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
]);
dbMigrate([
  // 老库的款式表：带 `name`（v3 要把它交接给 pl_products 之后 DROP COLUMN）
  `CREATE TABLE oi_styles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  // 老库的款色表：**只有 4 列、没有 `image_id`**（真库 2026-10-30 实测形状）。
  // 这是 R1 排序事故的复现关键：SCHEMA 里 `idx_oi_style_colors_image` 建在该列上，
  // 若 `dbMigrate(SCHEMA)` 先于 `retireLegacyImageTables` 补列，老库每次都抛
  // `no such column: image_id` —— 这张表不存在时反而建不出这个事故（新表自带该列）。
  `CREATE TABLE oi_style_colors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    style_id INTEGER NOT NULL,
    color TEXT NOT NULL,
    code TEXT NOT NULL
  )`,
]);
dbRun(`INSERT INTO oi_styles (id, code, name, fingerprint) VALUES (1, 'S-OLD', '老款名', 'fp-s1')`);
dbRun(`INSERT INTO oi_style_colors (id, style_id, color, code) VALUES (1, 1, '黑', 'S-OLD-BLACK')`);
dbRun(
  `INSERT INTO oi_images (id, url_fingerprint, source_url, local_path) VALUES (1, 'fp1', 'u', '/tmp/x')`,
);
dbRun(
  `INSERT INTO oi_orders (image_id, order_no, shop, size, order_time, raw_fields, status)
   VALUES (1, 'LEGACY-1', '店A', 'L', '2026-08-30', '{"订单金额":"CN￥ 165.18"}', 'pending')`,
);
const legacyBefore = dbGet(`SELECT id, order_no, shop, raw_fields FROM oi_orders`);

check(`迁移记账推进到 order.main = ${ORDER_MAIN_STEPS}（v1–v3 一次重建完成归一，v4+ 增量）`, () => {
  odb.ensureOrderSchema();
  // 本场景没有 ae_orders → v4 是**空操作**（顺序：v4 在迁移链里、表不存在就跳过），但版本照样推进
  assert.strictEqual(migrationVersion('order.main'), ORDER_MAIN_STEPS);
});

check('老库款色表补出 image_id 列 + 代表图索引建成 + 旧行原样（2026-10-30 真库事故的回归钉）', () => {
  const cols = dbQuery(`PRAGMA table_info(oi_style_colors)`).map((r) => String(r.name));
  assert.ok(cols.includes('image_id'), `老库 oi_style_colors 必须补上 image_id：${cols}`);
  const idx = dbQuery(
    `SELECT name FROM sqlite_master WHERE type='index' AND name='idx_oi_style_colors_image'`,
  );
  assert.strictEqual(idx.length, 1, '补列之后代表图索引必须建得出来（顺序：先补列再 dbMigrate）');
  const row = dbGet(`SELECT id, style_id, color, code FROM oi_style_colors WHERE id = 1`);
  assert.deepStrictEqual(
    row && { id: Number(row.id), style_id: Number(row.style_id), color: row.color, code: row.code },
    { id: 1, style_id: 1, color: '黑', code: 'S-OLD-BLACK' },
    '补列不许动存量行',
  );
});

check('主干形状：主表含订单级列（金额/状态/时点），行级列（qty/raw_fields/size）已拆到明细', () => {
  const cols = dbQuery(`PRAGMA table_info(oi_orders)`).map((r) => String(r.name));
  for (const c of ['order_no', 'shop', 'order_time', 'source', 'amount_cents', 'vat_cents', 'ddp_cents', 'tax_platform', 'biz_status', 'ship_time']) {
    assert.ok(cols.includes(c), `主表缺列 ${c}`);
  }
  // 订单级「总克重/总物流费」**不在**主表：B2 定案 Σ 包裹实时派生（`parcelTotals`），
  // 存一份就是同一数字两处实现。这里反向钉住，免得后人按 A3 旧计划把列加回来。
  for (const absent of ['total_weight_g', 'total_ship_cents', 'weight_g', 'cost_cents']) {
    assert.ok(!cols.includes(absent), `主表不该有列 ${absent}（订单级总数字/行级快照都不落这里）`);
  }
  // 行级列已拆到明细表
  for (const gone of ['image_id', 'size', 'raw_fields', 'category', 'color', 'qty', 'style_color_id', 'weight_g', 'cost_cents', 'corrected']) {
    assert.ok(!cols.includes(gone), `该列应已拆到明细：${gone}`);
  }
  const itemCols = dbQuery(`PRAGMA table_info(oi_order_items)`).map((r) => String(r.name));
  for (const c of ['id', 'order_id', 'image_id', 'size', 'raw_fields', 'qty', 'style_color_id', 'weight_g', 'cost_cents', 'actual_cost_cents', 'corrected']) {
    assert.ok(itemCols.includes(c), `明细表缺列 ${c}`);
  }
  // image_id 可空：直接插一行不带图的订单（S2-b「订单报表免图导入」的前提）
  const id = odb.insertOrder({ imageId: null, orderNo: 'NO-IMG', shop: '', size: '', orderTime: '',
    category: '', color: '', logo: '', rawFields: { 商品ID: 'X1' } });
  assert.ok(id > 0, 'image_id 为空的订单必须能落库');
  dbRun(`DELETE FROM oi_order_items WHERE id = ?`, [id]);
  dbRun(`DELETE FROM oi_orders WHERE order_no = 'NO-IMG'`);
});

check('款式名已交接到 pl_products，且 oi_styles.name 已被删（不留第二数据源）', () => {
  const cols = dbQuery(`PRAGMA table_info(oi_styles)`).map((r) => String(r.name));
  assert.ok(!cols.includes('name'), 'oi_styles.name 该已删除');
  const p = dbGet(`SELECT name FROM pl_products WHERE code = 'S-OLD'`);
  assert.strictEqual(p && p.name, '老款名', '历史款名必须已交接进产品表');
});

check('老行：source=import、qty=NULL、金额为 NULL（不是 0）', () => {
  const row = dbGet(
    `SELECT o.amount_cents, o.vat_cents, o.biz_status, o.source, oi.qty
     FROM oi_order_items oi JOIN oi_orders o ON o.id = oi.order_id
     WHERE o.order_no = 'LEGACY-1' LIMIT 1`,
  );
  assert.strictEqual(row.amount_cents, null, '老行金额必须是 NULL（未知），不能是 0');
  assert.strictEqual(row.source, 'import', '老行一律是报表导入来的');
  assert.strictEqual(row.qty, null, '件数真值只有采集通道会给');
});

check('数据一条不丢（主表行数 / 明细行数 / raw_fields 原样）', () => {
  const after = dbGet(`SELECT id, order_no, shop FROM oi_orders`);
  assert.strictEqual(Number(after.id), Number(legacyBefore.id), '主表 id 应为老行最小 id');
  assert.strictEqual(after.order_no, legacyBefore.order_no);
  assert.strictEqual(after.shop, legacyBefore.shop);
  const item = dbGet(`SELECT id, raw_fields FROM oi_order_items WHERE order_id = ?`, [after.id]);
  assert.strictEqual(Number(item.id), Number(legacyBefore.id), '明细 id 原样保留老行 id（parcel_lines 零迁移）');
  assert.strictEqual(item.raw_fields, legacyBefore.raw_fields, 'raw_fields 必须原样搬进明细');
});

check('AUTOINCREMENT 已追平：重建后新插入的 id 必须大于历史最大 id', () => {
  const id = odb.insertOrder({ imageId: 1, orderNo: 'NEW-1', shop: '店B', size: 'M',
    orderTime: '08/30/2026 07:00', category: '', color: '', logo: '',
    rawFields: { 订单号: 'NEW-1', 订单状态: '交易完成', 订单金额: 'CN￥ 165.18', 预计增值税: 'CN￥ 34.69', DDP关税: 'CN￥ 22.94', 平台是否代征代缴: '平台已税', 发货时间: '08/31/2026 12:57' } });
  assert.ok(Number(id) > Number(legacyBefore.id), `新 id(${id}) 必须大于历史最大 id(${legacyBefore.id})`);
  const row = dbGet(
    `SELECT o.amount_cents, o.vat_cents, o.ddp_cents, o.tax_platform, o.biz_status, o.ship_time, o.source, oi.qty
     FROM oi_order_items oi JOIN oi_orders o ON o.id = oi.order_id WHERE oi.id = ?`,
    [id],
  );
  assert.strictEqual(Number(row.amount_cents), 16518);
  assert.strictEqual(Number(row.vat_cents), 3469);
  assert.strictEqual(Number(row.ddp_cents), 2294);
  assert.strictEqual(row.tax_platform, '平台已税');
  assert.strictEqual(row.biz_status, '交易完成');
  assert.strictEqual(row.ship_time, '08/31/2026 12:57');
  assert.strictEqual(row.source, 'import');
  assert.strictEqual(row.qty, null);
});

check('幂等：再跑 ensureOrderSchema 不重复加列、不重复记账', () => {
  const before = Number(dbGet(`SELECT COUNT(*) AS n FROM oi_orders`).n);
  odb.ensureOrderSchema();
  odb.ensureOrderSchema();
  assert.strictEqual(migrationVersion('order.main'), ORDER_MAIN_STEPS); // 末版 = v9（成本两字段）
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM oi_orders`).n), before);
});
closeDb();
try {
  fs.rmSync(dirC, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

// ────────────────────────────────────────────────────────── 场景 D：ae 域老库追上
console.log('\n[D] ae 域老库：ae_cost_map 老形状（单主键）重建 + 弃表 ae_orders/ae_order_lines/ae_fees 删除');
const dirD = newDb('ae-legacy');
const aedb = require(path.join(ROOT, 'dist', 'electron', 'ae-db.js'));
// 老形状：一款一行、无 effective_from/source；另建三张 C1 合并前遗留的采集表（v3 迁移要删它们）
dbMigrate([
  // 真实老形状：`style_code` 单主键 + **有 source 列**（迁移的 INSERT 要从它取，缺了会 no such column）
  `CREATE TABLE ae_cost_map (
    style_code TEXT PRIMARY KEY,
    source TEXT NOT NULL DEFAULT 'purchase',
    style_name TEXT NOT NULL DEFAULT '',
    unit_price_cents INTEGER NOT NULL DEFAULT 0,
    sample_count INTEGER NOT NULL DEFAULT 0,
    last_biz_date TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE TABLE ae_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL UNIQUE,
    order_time TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'USD',
    goods_amount REAL NOT NULL DEFAULT 0,
    shipping_income REAL NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE ae_order_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ae_order_id INTEGER NOT NULL,
    product_id TEXT NOT NULL DEFAULT '',
    sku_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    sku_props TEXT NOT NULL DEFAULT '',
    qty INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    goods_amount REAL NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE ae_fees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ae_order_id INTEGER NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD'
  )`,
]);
dbRun(`INSERT INTO ae_cost_map (style_code, style_name, unit_price_cents, sample_count) VALUES ('S1','款1',1234,3)`);
dbRun(`INSERT INTO ae_orders (order_id) VALUES ('LEGACY-1')`);
dbRun(`INSERT INTO ae_order_lines (ae_order_id, title) VALUES (1, '旧行')`);
dbRun(`INSERT INTO ae_fees (ae_order_id, category, amount) VALUES (1, 'refund', 5)`);

check('迁移：ae.main 记到 v3，老行不丢且补上哨兵生效日', () => {
  aedb.ensureAeSchema();
  assert.strictEqual(migrationVersion('ae.main'), 3);
  const row = dbGet(`SELECT style_code, unit_price_cents, effective_from, source FROM ae_cost_map`);
  assert.strictEqual(row.style_code, 'S1');
  assert.strictEqual(Number(row.unit_price_cents), 1234);
  assert.strictEqual(row.effective_from, '0000-01-01'); // 哨兵：早于任何真实业务日期
  assert.strictEqual(row.source, 'purchase');
  const n = dbGet(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%legacy_struct%'`);
  assert.strictEqual(Number(n.n), 0, '中间表必须已清理');
});

check('v3 删除弃表：ae_orders / ae_order_lines / ae_fees 已不存在（含数据的也照删）', () => {
  const gone = (t) =>
    Number(dbGet(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='${t}'`).n) === 0;
  assert.ok(gone('ae_orders'), 'ae_orders 应被删');
  assert.ok(gone('ae_order_lines'), 'ae_order_lines 应被删');
  assert.ok(gone('ae_fees'), 'ae_fees 应被删');
});

check('幂等：再跑 ensureAeSchema 不重复记账、不改行数', () => {
  const before = Number(dbGet(`SELECT COUNT(*) AS n FROM ae_cost_map`).n);
  aedb.ensureAeSchema();
  aedb.ensureAeSchema();
  assert.strictEqual(migrationVersion('ae.main'), 3);
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM ae_cost_map`).n), before);
});

// C2 删表挂在 **order.main v10**，不挂 ae 域：v9 要先把区间价回填进订单行，删表必须排在它后面。
// 这里同时钉住"ae 域单独跑不会提前删"——否则两个域懒初始化谁先谁后不确定，回填源会被先删掉。
check('ae 域单独迁移**不删**旧价目表（删表在 order.main v10）', () => {
  const n = Number(dbGet(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='ae_cost_map'`).n);
  assert.strictEqual(n, 1, 'ae 域提前删表 ⇒ v9 读不到回填源');
});

check('order.main 追到 v10：旧价目表被删', () => {
  odb.ensureOrderSchema();
  assert.strictEqual(migrationVersion('order.main'), ORDER_MAIN_STEPS);
  const n = Number(dbGet(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='ae_cost_map'`).n);
  assert.strictEqual(n, 0, 'v10 应在 v9 回填之后删掉 ae_cost_map');
});

check('删表后 ae 域再 ensure 不会把表建回来、也不重复跑 v1', () => {
  aedb.ensureAeSchema();
  aedb.ensureAeSchema();
  assert.strictEqual(migrationVersion('ae.main'), 3);
  const n = Number(dbGet(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='ae_cost_map'`).n);
  assert.strictEqual(n, 0, 'SCHEMA 里已经没有这张表，幂等 DDL 不该再长出它');
});

check('结算明细表已随 SCHEMA 建好（新表无需迁移）', () => {
  const cols = dbQuery(`PRAGMA table_info(ae_settle_lines)`).map((r) => String(r.name));
  for (const c of ['order_no', 'item_id', 'sku_id', 'line_type', 'net_income_cents', 'fee_cents']) {
    assert.ok(cols.includes(c), `缺列 ${c}`);
  }
});
closeDb();
try {
  fs.rmSync(dirD, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

// ────────────────────────────── 场景 D2：order 域先跑、旧价目表还是 v1 之前的形状
//
// 两个域的 schema 各自懒初始化，启动时谁先跑不确定。若 order 先跑，v9 会在
// **ae.main 还没迁移**的库上读 `ae_cost_map` —— 那时表可能连 `effective_from` 都没有。
// 改造前这里会 `no such column` 直接炸迁移（整个应用起不来），所以 v9 的读取必须容忍旧形状。
console.log('\n[D2] order 域先跑：旧形状（无 effective_from）的 ae_cost_map 也要读得动');
const dirD2 = newDb('order-first-legacy');
check('v9 能读旧形状价目表并回填，v10 随后删表', () => {
  const pdbD2 = require(path.join(ROOT, 'dist', 'electron', 'product-db.js'));
  odb.ensureOrderSchema(); // 新库一次到 v10（此时没有旧表，v9/v10 空转）
  pdbD2.ensureProductSchema();
  // 造出"order 域已到 v8、ae 域还没迁移"的起点
  dbRun(`UPDATE sk_schema_migrations SET version = 8 WHERE key = 'order.main'`);
  dbMigrate([
    `CREATE TABLE ae_cost_map (
      style_code TEXT PRIMARY KEY,
      source TEXT NOT NULL DEFAULT 'purchase',
      style_name TEXT NOT NULL DEFAULT '',
      unit_price_cents INTEGER NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      last_biz_date TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`,
  ]);
  dbRun(`INSERT INTO ae_cost_map (style_code, style_name, unit_price_cents) VALUES ('OLD-1', '旧款', 1234)`);
  dbRun(`INSERT INTO oi_styles (id, code, fingerprint) VALUES (1, 'OLD-1', 'fp-old-1')`);
  dbRun(`INSERT INTO oi_style_colors (id, style_id, color, code) VALUES (11, 1, '黑', 'OLD-1-黑')`);
  dbRun(`INSERT INTO oi_orders (id, order_no, order_time) VALUES (1, 'OLD-ORDER', '2026-01-01')`);
  dbRun(`INSERT INTO oi_order_items (id, order_id, size, raw_fields, style_color_id) VALUES (1, 1, 'M', '{}', 11)`);
  dbRun(`INSERT INTO pl_products (code, name, cost_cents) VALUES ('OLD-1', '旧款', 0)`);

  odb.ensureOrderSchema();

  assert.strictEqual(
    Number(dbGet(`SELECT cost_cents FROM oi_order_items WHERE id = 1`).cost_cents),
    1234,
    '旧形状（无 effective_from）下也要能回填，不能因缺列炸迁移',
  );
  assert.strictEqual(
    Number(dbGet(`SELECT cost_cents FROM pl_products WHERE code = 'OLD-1'`).cost_cents),
    1234,
  );
  assert.strictEqual(migrationVersion('order.main'), ORDER_MAIN_STEPS);
  assert.strictEqual(
    Number(dbGet(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='ae_cost_map'`).n),
    0,
  );
});
closeDb();
try {
  fs.rmSync(dirD2, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}
// ────────────────────────────────────────────── 场景 E：历史采集单回填主干（order.main v4）
console.log('\n[E] 老采集表（ae_orders/ae_order_lines）里的历史单 → 回填进主干并可见');
const dirE = newDb('legacy-collect');
// 老库形状：主干（v3 形状：image_id 可空 + source/qty + 金额列）+ 采集表 + 汇率表
// ⚠️ 与迁移步骤的要求一致：**迁移跑在 dbMigrate(SCHEMA) 之前**，所以这里必须先手工把表建出来
// ⚠️ 先把 `order.main` 记到 **3**：场景 C 已经验过 v1–v3，这里只验 v4（否则 v1 的 ALTER 会打到没建全的老表上）
dbMigrate([
  `CREATE TABLE sk_schema_migrations (
    key TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 0,
    applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE TABLE md_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT NOT NULL UNIQUE,
    url_fingerprint TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    local_path TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    result_json TEXT,
    error TEXT,
    style_color_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE TABLE oi_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER,
    order_no TEXT NOT NULL,
    shop TEXT NOT NULL DEFAULT '',
    size TEXT NOT NULL DEFAULT '',
    order_time TEXT NOT NULL DEFAULT '',
    raw_fields TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    logo TEXT NOT NULL DEFAULT '',
    material TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    corrected INTEGER NOT NULL DEFAULT 0,
    amount_cents INTEGER,
    vat_cents INTEGER,
    ddp_cents INTEGER,
    tax_platform TEXT NOT NULL DEFAULT '',
    biz_status TEXT NOT NULL DEFAULT '',
    ship_time TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'import',
    qty INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE TABLE ae_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL UNIQUE,
    shop_name TEXT NOT NULL DEFAULT '',
    site TEXT NOT NULL DEFAULT '',
    order_time TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'USD',
    goods_amount REAL NOT NULL DEFAULT 0,
    shipping_income REAL NOT NULL DEFAULT 0,
    raw_json TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'extension',
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE TABLE ae_order_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ae_order_id INTEGER NOT NULL,
    product_id TEXT NOT NULL DEFAULT '',
    sku_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    sku_props TEXT NOT NULL DEFAULT '',
    qty INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    goods_amount REAL NOT NULL DEFAULT 0,
    style_code TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE TABLE ae_rates (
    from_currency TEXT PRIMARY KEY,
    rate_to_cny REAL NOT NULL DEFAULT 1,
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  // 主干里已有一条"同样单号"的**导入**行：回填不能把它算成第二单（同一单两行 = 算钱翻倍）
  `INSERT INTO oi_orders (image_id, order_no, raw_fields, source, amount_cents)
     VALUES (NULL, 'A-DUP', '{}', 'import', 100)`,
]);
dbRun(`INSERT INTO sk_schema_migrations (key, version) VALUES ('order.main', 3)`);
dbRun(`INSERT INTO ae_rates (from_currency, rate_to_cny) VALUES ('USD', 7)`);
dbRun(`INSERT INTO ae_orders (order_id, shop_name, order_time, status, currency, goods_amount, shipping_income, raw_json)
       VALUES ('A-1', '店A', '2026-08-01 10:00:00', '交易完成', 'USD', 10, 2, '{"k":"v"}')`);
dbRun(`INSERT INTO ae_orders (order_id, shop_name, order_time, status, currency, goods_amount, shipping_income, raw_json)
       VALUES ('A-2', '店A', '2026-08-02 10:00:00', '等待发货', 'CNY', 50, 0, '{}')`);
dbRun(`INSERT INTO ae_order_lines (ae_order_id, product_id, sku_props, qty) VALUES (1, 'P-1', 'Color:Red;Size:L', 2)`);
dbRun(`INSERT INTO ae_order_lines (ae_order_id, product_id, sku_props, qty) VALUES (1, 'P-2', 'Color:Blue;Size:M', 1)`);

const odbE = require(path.join(ROOT, 'dist', 'electron', 'order-db.js'));
odbE.ensureOrderSchema();

function collectRows() {
  return dbQuery(`SELECT o.order_no, o.amount_cents, oi.qty, oi.color, oi.size, o.shop, o.biz_status, oi.raw_fields
                  FROM oi_order_items oi JOIN oi_orders o ON o.id = oi.order_id
                  WHERE o.source = 'collect' ORDER BY o.order_no, oi.id`);
}

check('历史采集单已回填主干（source=collect）', () => {
  const rows = collectRows();
  assert.strictEqual(rows.length, 3, `期望 3 行（A-1 两行明细 + A-2 一行），实际 ${rows.length}`);
  assert.deepStrictEqual([...new Set(rows.map((r) => r.order_no))], ['A-1', 'A-2']);
});

check('金额按汇率折 CNY 分（口径与实时采集同一组原语）', () => {
  const rows = collectRows();
  const a1 = rows.find((r) => r.order_no === 'A-1');
  // (10 + 2) USD × 7 = 84 元 → 8400 分；CNY 单 1:1（50 元 → 5000 分）
  assert.strictEqual(Number(a1.amount_cents), 8400, `A-1=${a1.amount_cents}`);
  const a2 = rows.find((r) => r.order_no === 'A-2');
  assert.strictEqual(Number(a2.amount_cents), 5000, `A-2=${a2.amount_cents}`);
});

check('行级明细落成多行（颜色/尺码从 sku_props 解析、件数保留）', () => {
  const rows = collectRows().filter((r) => r.order_no === 'A-1');
  const props = rows.map((r) => `${r.color}/${r.size}/${r.qty}`).sort();
  assert.deepStrictEqual(props, ['Blue/M/1', 'Red/L/2']);
});

check('原帧整段保真（raw_fields.采集帧）+ 可回滚标记', () => {
  const a1 = collectRows().find((r) => r.order_no === 'A-1');
  const raw = JSON.parse(a1.raw_fields);
  assert.strictEqual(raw['采集帧'].length > 0, true);
  assert.strictEqual(raw.__migratedFrom, 'ae_orders');
});

check('幂等：再跑一次不翻倍、版本不回退', () => {
  const before = collectRows().length;
  odbE.ensureOrderSchema();
  odbE.ensureOrderSchema();
  assert.strictEqual(collectRows().length, before, '重复 ensure 后行数变了');
  assert.strictEqual(migrationVersion('order.main'), ORDER_MAIN_STEPS);
});

check('老采集表**原样保留**（order.main 回填是加法；删表是 ae.main v3 的另一步，见场景 D）', () => {
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM ae_orders`).n), 2);
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM ae_order_lines`).n), 2);
});
closeDb();
try {
  fs.rmSync(dirE, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

// ───────────────────────────────────── 场景 F：purchase 域删列（purchase.main v1：purchase_orders.note）
console.log('\n[F] purchase_orders 老形状（带零读者列 note）→ 迁移删列；新库直建无 note 形状');
const dirF = newDb('purchase-note-old');
const pdbF = require(path.join(ROOT, 'dist', 'electron', 'purchase-db.js'));
// 老库形状：purchase_orders 带 note 列（本仓历史 DDL 就是它，非虚构）
dbMigrate([
  `CREATE TABLE suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE TABLE purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    biz_date TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'detail',
    status TEXT NOT NULL DEFAULT 'draft',
    total_cents INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    edited_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
]);
dbRun(`INSERT INTO suppliers (id, name) VALUES (1, '厂X')`);
dbRun(
  `INSERT INTO purchase_orders (id, supplier_id, biz_date, mode, status, total_cents, note)
   VALUES (1, 1, '2026-10-01', 'detail', 'submitted', 12345, '首单备注')`,
);

check('迁移前：老库确有 note 列（夹具自证，免得断言打在别的形状上）', () => {
  const cols = dbQuery(`PRAGMA table_info(purchase_orders)`).map((r) => String(r.name));
  assert.ok(cols.includes('note'), `夹具没造出 note 列：${cols.join(',')}`);
});

check(`ensurePurchaseSchema 把 purchase.main 记到 v${PURCHASE_STEPS} 并把 note 列删掉`, () => {
  pdbF.ensurePurchaseSchema();
  assert.strictEqual(migrationVersion('purchase.main'), PURCHASE_STEPS);
  const cols = dbQuery(`PRAGMA table_info(purchase_orders)`).map((r) => String(r.name));
  assert.ok(!cols.includes('note'), `note 列应已删除：${cols.join(',')}`);
});

check('删列路径数据一条不丢（其余列取值原样）', () => {
  const r = dbGet(
    `SELECT id, supplier_id, biz_date, mode, status, total_cents FROM purchase_orders WHERE id = 1`,
  );
  assert.strictEqual(Number(r.id), 1);
  assert.strictEqual(Number(r.supplier_id), 1);
  assert.strictEqual(r.biz_date, '2026-10-01');
  assert.strictEqual(r.mode, 'detail');
  assert.strictEqual(r.status, 'submitted');
  assert.strictEqual(Number(r.total_cents), 12345);
});

// 同 `oi_styles.name` 的教训：列删了但 INSERT 还写它 → **老库上任何建单路径必抛**
// （而夹具常建的是新库：新库形状本就无该列，写得出来却看不出来）⇒ 真建一张单，让这条路径实跑。
check('老库删列后新建单可用（INSERT 不再引用 note；退回旧写法这条路必抛）', () => {
  const id = pdbF.createPurchaseOrder({ supplierId: 1, bizDate: '2026-10-10', mode: 'detail', items: [] });
  assert.ok(Number(id) > 1, `新单 id 应大于历史最大 id：${id}`);
});

check('幂等：再跑一次不报错、版本不回退、行数不变', () => {
  const before = Number(dbGet(`SELECT COUNT(*) AS n FROM purchase_orders`).n);
  pdbF.ensurePurchaseSchema();
  pdbF.ensurePurchaseSchema();
  assert.strictEqual(migrationVersion('purchase.main'), PURCHASE_STEPS);
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM purchase_orders`).n), before);
});
closeDb();
try {
  fs.rmSync(dirF, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

// 新库方向：抓「只删迁移忘了删 SCHEMA」的形状分叉（新库会多出 note 列、与老库不一致）
const dirF2 = newDb('purchase-note-fresh');
check('新库直建的形状不含 note（SCHEMA 与迁移两侧同向，否则新旧库形状会分叉）', () => {
  pdbF.ensurePurchaseSchema();
  const cols = dbQuery(`PRAGMA table_info(purchase_orders)`).map((r) => String(r.name));
  assert.ok(!cols.includes('note'), `新库不该有 note 列：${cols.join(',')}`);
  assert.strictEqual(migrationVersion('purchase.main'), PURCHASE_STEPS);
});
closeDb();
try {
  fs.rmSync(dirF2, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

// ────────────────────────────────────────────────────────── 场景 G：新库建表模板的自校验
//
// 背景（P1-2 + B1 拆表）：`oi_orders`（主表）的列由 `ORDER_HEADER_COLS`、`oi_order_items`（明细）
// 由 `ORDER_ITEM_COLS` **拼**进建表模板 —— 好处是列同时服务「新库建表」与「老库 ALTER 补列」，
// 代价是**解析后的列序只存在于运行时**，新人读不到、也没有断言盯着。
// `ORDER_TABLE_COLUMNS` / `ORDER_ITEM_TABLE_COLUMNS` 把拼接结果变成可直读、可断言的一份；
// 这里对着**真库** `PRAGMA` 逐列比：模板里少一个 `${}`、或往字面量里手加一列却没进数组，都会红。
console.log('\n[G] 新库直建：`oi_orders` 主表 + `oi_order_items` 明细的列序自校验');
const dirG = newDb('order-fresh');
check('主表列序 === `ORDER_TABLE_COLUMNS`、明细列序 === `ORDER_ITEM_TABLE_COLUMNS`', () => {
  odb.ensureOrderSchema();
  const headCols = dbQuery(`PRAGMA table_info(oi_orders)`).map((r) => String(r.name));
  // 非空转守卫：清单本身必须有内容，否则下面那条在"清单退化成空"时反而恒绿
  assert.ok(
    odb.ORDER_TABLE_COLUMNS.length >= 10,
    `主表列清单条数异常（清单可能被清空）：${odb.ORDER_TABLE_COLUMNS.length}`,
  );
  assert.ok(
    odb.ORDER_ITEM_TABLE_COLUMNS.length >= 12,
    `明细列清单条数异常（清单可能被清空）：${odb.ORDER_ITEM_TABLE_COLUMNS.length}`,
  );
  assert.deepStrictEqual(headCols, odb.ORDER_TABLE_COLUMNS.slice());
  const itemCols = dbQuery(`PRAGMA table_info(oi_order_items)`).map((r) => String(r.name));
  assert.deepStrictEqual(itemCols, odb.ORDER_ITEM_TABLE_COLUMNS.slice());
});
closeDb();
try {
  fs.rmSync(dirG, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

// ────────────────────────────────────────── 场景 H：C2 成本两字段（order.main v9 → v10 删表）
//
// 为什么必须有这个场景：v9 是本项目第一次**回填历史利润数**（此前 v7 明确"不回填"）。
// 三类错都只在"老库 + 有真实数据"时出现，新库永远复现不出来：
//   · 旧 `cost_cents`（实付）没搬走 → 被当成预估，实付 32 的行按 28 算（少 4 元）；
//   · 预估没按**下单日**取区间 → 全用最新价，历史单被新价格改写（利润随手漂）；
//   · 产品当前价没搬 → 删旧价目表那一刻价就没了。
console.log('\n[H] C2 老库（v8）：实付搬运 + 预估按区间回填 + 产品当前价镜像 + v10 删旧表');
const dirH = newDb('order-cost-split');
check('v9：实付搬家 / 预估按下单日回填 / 未归类留空 / 产品价只补空 / 幂等', () => {
  const aedbH = require(path.join(ROOT, 'dist', 'electron', 'ae-db.js'));
  const purdbH = require(path.join(ROOT, 'dist', 'electron', 'purchase-db.js'));
  odb.ensureOrderSchema();
  aedbH.ensureAeSchema();
  pdb.ensureProductSchema();
  purdbH.ensurePurchaseSchema();

  // 新库直建就是 v9 形状 —— 退回 v8：删列 + 版本退号（这正是升级用户的起点）
  dbRun(`ALTER TABLE oi_order_items DROP COLUMN actual_cost_cents`);
  dbRun(`UPDATE sk_schema_migrations SET version = 8 WHERE key = 'order.main'`);

  dbRun(
    `INSERT INTO oi_styles (id, code, fingerprint) VALUES (1, 'S-COST-1', 'fp-c1'), (2, 'S-COST-2', 'fp-c2')`,
  );
  dbRun(
    `INSERT INTO oi_style_colors (id, style_id, color, code) VALUES (11, 1, '黑', 'S-COST-1-黑'), (12, 2, '黑', 'S-COST-2-黑')`,
  );
  dbRun(
    `INSERT INTO oi_orders (id, order_no, order_time) VALUES (100, 'COST-1', '2026-10-11 05:59:22'), (101, 'COST-0', '2026-01-01')`,
  );
  dbRun(
    `INSERT INTO oi_order_items (id, order_id, size, raw_fields, style_color_id, cost_cents) VALUES
       (1001, 100, 'XL', '{}', 11, 3200),
       (1002, 100, 'M',  '{}', 11, NULL),
       (1003, 100, 'S',  '{}', 0,  NULL),
       (1004, 101, 'L',  '{}', 11, NULL)`,
  );
  // v12 的靶子：一行**带商品ID + 平台色**的老订单（真实报表形状）与一行没有任何商品信息的。
  // 老库里这两个字段只存在于 `raw_fields` 里 ⇒ 只有"从原文重算"才回填得出来。
  dbRun(
    `INSERT INTO oi_order_items (id, order_id, size, raw_fields, style_color_id, cost_cents) VALUES
       (1005, 100, 'M', '{"产品ID":"1005018888888001","产品信息":"【1】Old Row\\n(产品属性:Color:5,Size:M)"}', 0, NULL),
       (1006, 100, 'L', '{"订单号":"NO-ITEM-ID"}', 0, NULL)`,
  );
  dbRun(
    `INSERT INTO pl_products (code, name, cost_cents) VALUES ('S-COST-1', '成本款', 0), ('S-COST-2', '已有价', 5000)`,
  );
  // C2 起 SCHEMA 不再建这张表（新库不该有）—— 本场景模拟老库，必须手工把旧价目表造出来
  dbMigrate([
    `CREATE TABLE ae_cost_map (
      style_code TEXT NOT NULL,
      effective_from TEXT NOT NULL DEFAULT '0000-01-01',
      source TEXT NOT NULL DEFAULT 'purchase',
      style_name TEXT NOT NULL DEFAULT '',
      unit_price_cents INTEGER NOT NULL DEFAULT 0,
      sample_count INTEGER NOT NULL DEFAULT 0,
      last_biz_date TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
      PRIMARY KEY (style_code, effective_from, source)
    )`,
  ]);
  // v11 的靶子 `oi_queue`：它由迁移**删除**、SCHEMA 不再建，所以新库造不出来 ——
  // 必须像 ae_cost_map 一样手工造，否则 v11 删的是空气、断言恒绿。
  // ⚠️ 位置很重要：必须建在**版本已退回 v8 之后**（下面 v9–v11 会整段重跑），
  //    而不是建完再单独把版本调回 v10 —— 那样会跳过 v9（补 actual_cost_cents 列）。
  dbMigrate([
    `CREATE TABLE oi_queue (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      image_id INTEGER NOT NULL DEFAULT 0,
      status TEXT NOT NULL DEFAULT 'pending',
      created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
    )`,
  ]);
  dbRun(
    `INSERT INTO ae_cost_map (style_code, effective_from, source, style_name, unit_price_cents, sample_count, last_biz_date, updated_at)
     VALUES ('S-COST-1', '2026-10-10', 'manual',   '成本款', 2800, 0, '2026-10-10', datetime('now','localtime')),
            ('S-COST-1', '2026-10-17', 'purchase', '成本款', 3200, 1, '2026-10-17', datetime('now','localtime')),
            ('S-COST-2', '2026-10-01', 'manual',   '已有价', 4000, 0, '2026-10-01', datetime('now','localtime'))`,
  );
  dbRun(`INSERT INTO suppliers (name) VALUES ('成本厂')`);  const supId = Number(dbGet(`SELECT id FROM suppliers WHERE name = '成本厂'`).id);
  dbRun(
    `INSERT INTO purchase_orders (id, supplier_id, biz_date, status) VALUES (1, ?, '2026-10-17', 'submitted')`,
    [supId],
  );
  // 已提交拿货：M 码实付 32 —— 迁移要把它补到"原本没有旧实付"的那行
  dbRun(
    `INSERT INTO purchase_items (purchase_id, style_code, color, size, qty, price_cents, amount_cents, style_color_id)
     VALUES (1, 'S-COST-1', '黑', 'M', 1, 3200, 3200, 11)`,
  );

  odb.ensureOrderSchema();
  assert.strictEqual(migrationVersion('order.main'), ORDER_MAIN_STEPS);

  const get = (id) =>
    dbGet(`SELECT cost_cents, actual_cost_cents FROM oi_order_items WHERE id = ?`, [id]);
  // ① 10-11 下单 → 当时生效的是 10-10 的 28，不是 10-17 的 32
  assert.strictEqual(Number(get(1001).cost_cents), 2800, '预估必须按下单日取当时生效价');
  // ② 旧 cost_cents（实付 32）搬进 actual，且不被预估覆盖
  assert.strictEqual(Number(get(1001).actual_cost_cents), 3200, '旧实付必须原样搬进实际进价');
  // ③ 升级当场从拿货单补实付（等下次拿货写操作会让这行短暂按 28 算）
  assert.strictEqual(Number(get(1002).actual_cost_cents), 3200, '已有拿货单要在迁移内补上');
  assert.strictEqual(Number(get(1002).cost_cents), 2800);
  // ④ 未归类：两个字段都留 NULL（不编数，0 也不算成本）
  assert.strictEqual(get(1003).cost_cents, null);
  assert.strictEqual(get(1003).actual_cost_cents, null);
  // ⑤ 下单日早于所有区间 → 取最早那条（与 pickCostInterval 同规则）
  assert.strictEqual(Number(get(1004).cost_cents), 2800, '无 ≤ 下单日的区间时应取最早');
  // ⑥ 产品当前价：空的补最新（10-17 的 32）；已有价不许被旧价目表覆盖
  assert.strictEqual(
    Number(dbGet(`SELECT cost_cents FROM pl_products WHERE code = 'S-COST-1'`).cost_cents),
    3200,
  );
  assert.strictEqual(
    Number(dbGet(`SELECT cost_cents FROM pl_products WHERE code = 'S-COST-2'`).cost_cents),
    5000,
    '产品页已维护过的价，旧价目表无权覆盖',
  );
  // ⑦ 幂等：再跑一次不重复搬、版本不回退
  odb.ensureOrderSchema();
  assert.strictEqual(Number(get(1001).actual_cost_cents), 3200);
  assert.strictEqual(Number(get(1001).cost_cents), 2800);
  assert.strictEqual(migrationVersion('order.main'), ORDER_MAIN_STEPS);
  // ⑧ v10 在回填之后把旧价目表删掉（数据已经搬到订单行与产品行，删表不再丢信息）
  assert.strictEqual(
    Number(dbGet(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='ae_cost_map'`).n),
    0,
    'v10 应删掉 ae_cost_map',
  );
  // ⑨ v11 删掉退役的 `oi_queue`（云端识别链已整条移除：它既没有写入方也没有读取方）
  assert.strictEqual(
    Number(dbGet(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='oi_queue'`).n),
    0,
    'v11 应删掉 oi_queue',
  );
  // ⑩ v12：变体键列 + 键表 + **存量从原文回填**（键只在导入时算一次，存量得靠迁移补）
  const v12Cols = dbQuery(`PRAGMA table_info(oi_order_items)`).map((c) => String(c.name));
  assert.ok(v12Cols.includes('variant_key'), 'v12 应给 oi_order_items 加 variant_key');
  assert.strictEqual(
    Number(dbGet(`SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='oi_variant_keys'`).n),
    1,
    'v12 应建出 oi_variant_keys',
  );
  const vk1005 = String(dbGet(`SELECT variant_key FROM oi_order_items WHERE id = 1005`).variant_key);
  assert.strictEqual(vk1005.split('\u0000').length, 3, `存量行未回填出三段键：${JSON.stringify(vk1005)}`);
  assert.ok(vk1005.includes('1005018888888001'), '键里应含商品ID（从 raw_fields 重算，不是读 color 列）');
  assert.strictEqual(
    String(dbGet(`SELECT variant_key FROM oi_order_items WHERE id = 1006`).variant_key),
    '',
    '无商品ID 的老行不许被编出一个键（那会把无关订单并成一件）',
  );
  // 收口（2026-10-29 回退后）：`ensureOrderSchema` 末尾**不再**"导入即归款" ——
  // `backfillVariantStyleColors` 只给**已归类行**补记 `oi_variant_keys` 绑定，没有任何映射时
  // 不建款/不建色、行留在待认款（`style_color_id = 0`）。所以这里反向钉住：
  // 迁移只写"键"，不许顺手长出一个款色来。
  assert.strictEqual(
    Number(dbGet(`SELECT COALESCE(style_color_id,0) AS s FROM oi_order_items WHERE id = 1005`).s),
    0,
    '没有人工映射时带键的老行必须留在待认款（不许自动长款色）',
  );
  assert.strictEqual(
    Number(dbGet(`SELECT COUNT(*) AS n FROM oi_style_colors`).n),
    2,
    '收口不许新建款色（迁移只写键）',
  );
  // ⑪ v13：芒果同步六列（老库走 ALTER 补，新库由列数组直建 —— 这里钉的是**升级路径**）
  const v13Head = dbQuery(`PRAGMA table_info(oi_orders)`).map((c) => String(c.name));
  for (const c of ['pay_time', 'shop_auth_id', 'deal_deadline', 'timeout_at']) {
    assert.ok(v13Head.includes(c), `v13 应给 oi_orders 加 ${c}`);
  }
  const v13Item = dbQuery(`PRAGMA table_info(oi_order_items)`).map((c) => String(c.name));
  for (const c of ['item_id', 'sku_code']) {
    assert.ok(v13Item.includes(c), `v13 应给 oi_order_items 加 ${c}`);
  }
  // 幂等：再跑一次不许 `duplicate column name`（SQLite 无 ADD COLUMN IF NOT EXISTS）
  odb.ensureOrderSchema();
  assert.strictEqual(migrationVersion('order.main'), ORDER_MAIN_STEPS);
  // 不回填：存量行必须是空串（"没同步过"不能伪装成"付款时刻是 0"）
  const stale = dbGet(
    `SELECT COUNT(*) AS n FROM oi_order_items WHERE item_id <> '' OR sku_code <> ''`,
  );
  assert.strictEqual(Number(stale.n), 0, 'v13 不许编造存量值');
});
closeDb();
try {
  fs.rmSync(dirH, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

// ── [I] 图案域（M3·T3-1）：四张表 + 两个视图，一条 `ensurePodSchema()` 全建齐 ─────────
//
// 为什么这条必须单列：`pod_binding_worklist` 读的是 `pl_shop_items` / `sk_shops`
// （别的域的表）。SQLite 在**准备任何语句**时都会解析 schema 里的视图 ——
// 视图引用了不存在的表时，报的错打在**别处**的 SQL 上
// （`error in view pod_binding_worklist: no such table: main.pl_shop_items`，2026-11-01 场景 H 当场踩到）。
// 也就是说"跨域视图建早了"不是"这张视图不可用"，而是整个库的语句都可能失败。
// 所以它只能由"确定输入已就位"的那一处建：图案域自己的 `ensurePodSchema`（先建输入域，再建视图）。
console.log('\n[I] 图案域建表：一条 ensure 全建齐（含跨域视图的前提）');
const dirI = newDb('pod');
try {
  const pod = require(path.join(ROOT, 'dist', 'electron', 'pod-db.js'));

  // ① 空库直接调：输入域（sk_shops / pl_shop_items）由它自己去建，六件必须齐全
  check('空库上 ensurePodSchema 一次建齐六件（四表 + 余量视图 + 待绑定清单）', () => {
    pod.ensurePodSchema();
    const rep = pod.podSchemaReport();
    assert.deepStrictEqual(rep.missing, [], JSON.stringify(rep));
    assert.strictEqual(rep.tables.length, 4);
    assert.strictEqual(rep.views.length, 2);
  });

  // ② 幂等：每次入口都会调它（绑定台/看板/报单页），重跑必须不报错
  check('幂等：重复 ensure 不报错、六件仍在（CREATE IF NOT EXISTS 就是"补建"）', () => {
    pod.ensurePodSchema();
    pod.ensurePodSchema();
    assert.deepStrictEqual(pod.podSchemaReport().missing, []);
  });

  // ③ 老库升级路径：库里没有 pod 对象／没有那两列（等同旧版本用户）→ ensure 必须补回
  dbRun('DROP VIEW IF EXISTS pod_binding_worklist');
  dbRun('DROP VIEW IF EXISTS pod_pattern_balance');
  dbRun('DROP TABLE IF EXISTS pod_sheet_ledger');
  dbRun('DROP TABLE IF EXISTS pod_sheet_batches');
  dbRun('DROP TABLE IF EXISTS pod_variant_patterns');
  dbRun('DROP TABLE IF EXISTS pod_patterns');
  check('老库（完全没有 pod% 对象）升级后同样建齐，且不需要版本步骤', () => {
    pod.ensurePodSchema();
    assert.deepStrictEqual(pod.podSchemaReport().missing, []);
    assert.strictEqual(
      migrationVersion('pod.main'),
      0,
      '图案域不该有版本步骤（全是新对象，幂等 CREATE 就是升级路径）',
    );
  });

  // ④ 待绑定清单的键必须与 variantKey() 同构：char(0) 分隔、三/四段
  dbRun(`INSERT INTO sk_shops (id, name, name_key, erp_shop_id, status) VALUES (1, '一店', '一店', '', 'active')`);
  dbRun(
    `INSERT INTO pl_shop_items (shop_id, store_key, item_id, sku_json)
     VALUES (1, '', 'IT-9', '[{"color":"黑","imageUrl":"https://img.alicdn.com/kf/A1.jpg"},{"color":"黑","imageUrl":"https://img.alicdn.com/kf/A2.jpg"}]')`,
  );
  check('待绑定清单：同色两个图 ⇒ 键带第 4 段（图键），这是"色名塌陷"的唯一判据', () => {
    const rows = dbQuery(`SELECT variant_key, image_key, imgs_in_name FROM pod_binding_worklist`);
    assert.strictEqual(rows.length, 2, `两个图应摊成两个槽位：${JSON.stringify(rows)}`);
    for (const r of rows) {
      const parts = String(r.variant_key).split('\u0000');
      assert.strictEqual(parts.length, 4, `塌陷链接的键必须是四段：${JSON.stringify(parts)}`);
      assert.strictEqual(parts[3], String(r.image_key));
    }
  });
  check('待绑定清单：同色只有一个图 ⇒ 键仍是三段（不许多出空段）', () => {
    dbRun(
      `INSERT INTO pl_shop_items (shop_id, store_key, item_id, sku_json)
       VALUES (1, '', 'IT-10', '[{"color":"白","imageUrl":"https://img.alicdn.com/kf/B1.jpg"}]')`,
    );
    const r = dbQuery(`SELECT variant_key FROM pod_binding_worklist WHERE item_id = 'IT-10'`)[0];
    assert.strictEqual(String(r.variant_key).split('\u0000').length, 3, String(r.variant_key));
  });
} finally {
  closeDb();
  try {
    fs.rmSync(dirI, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

// ── [J] `pl_shop_items` 补两列（M3·T3-4 的前置）：老库走 ALTER，新库建表即带 ────────
console.log('\n[J] pl_shop_items += pod_n_colors / pod_n_images（判别力统计列）');
const dirJ = newDb('pod-cols');
try {
  const sidb2 = require(path.join(ROOT, 'dist', 'electron', 'shop-item-db.js'));
  const sdb2 = require(path.join(ROOT, 'dist', 'electron', 'shop-db.js'));
  // 手写一份**改动前**的建表语句 = 老形状夹具（没有那两列）。抄 DDL 是有意的：
  // 夹具必须忠于"用户机器上现在长什么样"，而不是忠于当前 SCHEMA（否则这条永远恒绿）。
  dbRun(`CREATE TABLE pl_shop_items (
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
  )`);
  dbRun(`INSERT INTO pl_shop_items (item_id, sku_json) VALUES ('IT-OLD', '[]')`);
  // 第二条老行带**真实矩阵**：用来钉死"补列必须回填"，而不只是"补列成功"。
  // 形状取真库最常见的两种：色 A 挂 2 张图（这一色塌陷）、色 B 挂 1 张图。
  dbRun(`INSERT INTO pl_shop_items (item_id, sku_json) VALUES ('IT-OLD2', ?)`, [
    JSON.stringify([
      { color: 'A', size: 'M', price: '1', imageUrl: 'https://ae01.alicdn.com/kf/SA1.jpg' },
      { color: 'A', size: 'L', price: '1', imageUrl: 'https://ae01.alicdn.com/kf/SA2.jpg' },
      { color: 'B', size: 'M', price: '2', imageUrl: 'https://ae01.alicdn.com/kf/SB1.jpg' },
    ]),
  ]);
  check('迁移前：老库确实没有这两列（夹具自证，免得断言打在别的形状上）', () => {
    const cols = dbQuery(`PRAGMA table_info(pl_shop_items)`).map((c) => String(c.name));
    assert.ok(!cols.includes('pod_n_colors') && !cols.includes('pod_n_images'), cols.join(','));
  });
  sdb2.ensureShopSchema();
  sidb2.ensureShopItemSchema();
  check('迁移 v3 补列生效，空矩阵的存量行是 0（= 还没算过，不是"零个颜色"）', () => {
    const cols = dbQuery(`PRAGMA table_info(pl_shop_items)`).map((c) => String(c.name));
    assert.ok(cols.includes('pod_n_colors'), cols.join(','));
    assert.ok(cols.includes('pod_n_images'), cols.join(','));
    const r = dbQuery(`SELECT pod_n_colors AS a, pod_n_images AS b FROM pl_shop_items WHERE item_id='IT-OLD'`)[0];
    assert.strictEqual(Number(r.a), 0);
    assert.strictEqual(Number(r.b), 0);
  });
  // ⚠️ 这条是本场景的重点：**只补列不回填**会让真库（已有 71 条链接）升级后两列全 0，
  //    于是 `WHERE pod_n_images > 1`（找塌陷链接的唯一入口）筛出 0 行 ——
  //    那不是"没有塌陷链接"，而是"没人算过"，而且长得跟真结论一模一样。
  check('迁移 v3 回填存量：真实矩阵的老行升级后两列就是真实值，不是 0', () => {
    const r = dbQuery(`SELECT pod_n_colors AS a, pod_n_images AS b FROM pl_shop_items WHERE item_id='IT-OLD2'`)[0];
    assert.strictEqual(Number(r.a), 2, '色 A / 色 B 两个色名');
    assert.strictEqual(Number(r.b), 2, '色 A 下挂了 2 张图（塌陷）；色 B 的 1 张不该把它抬到 3');
  });
  check('迁移 v3 回填只补「没算过」的行：重跑迁移不改业务已写过的统计值', () => {
    // 真·重入：把记账删掉逼 v1–v3 再跑一遍。这不是人为制造的场景 ——
    // 用户跨版本升级、或另一个入口先跑了别的域，都可能让同一段迁移再走一次。
    dbRun(`UPDATE pl_shop_items SET pod_n_colors=9, pod_n_images=9 WHERE item_id='IT-OLD2'`);
    dbRun(`DELETE FROM sk_schema_migrations WHERE key='shop-item.main'`);
    sidb2.ensureShopItemSchema();
    const r = dbQuery(`SELECT pod_n_colors AS a FROM pl_shop_items WHERE item_id='IT-OLD2'`)[0];
    assert.strictEqual(Number(r.a), 9, '回填的 WHERE 只挑两列都还是 0 的行，不能把 9 改回 2');
  });
  check('幂等：再跑一次不许 duplicate column name（SQLite 无 ADD COLUMN IF NOT EXISTS）', () => {
    sidb2.ensureShopItemSchema();
    assert.ok(migrationVersion('shop-item.main') >= 3, '版本号应记到 v3 以上');
  });
} finally {
  closeDb();
  try {
    fs.rmSync(dirJ, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log('\n' + '\u2500'.repeat(64));
if (failed) {
  console.log(`\u2717 版本化迁移冒烟失败：${failed} 项\n`);
  process.exit(1);
}
console.log('\u2713 版本化迁移冒烟全部通过\n');
process.exit(0);