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
const PRODUCT_SKU_STEPS = 3; // pl_shop_sku：1 补列 → 2 唯一键归一 → 3 删 pl_item_weights（克重只属 SKU）
const ORDER_MAIN_STEPS = 4; // oi_*：1/2 提列 → 3 主干归一 → 4 历史采集单回填
const AE_MAIN_STEPS = 2; // 成本口径：1 建表 → 2 生效区间

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
});

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

check('迁移前：确实是老形状（唯一键不含 product_id）', () => {
  const sql = require(path.join(ROOT, 'dist', 'electron', 'db.js')).tableSql('pl_shop_sku');
  assert.ok(!/unique\s*\([^)]*product_id/i.test(sql), `建表 SQL 不该含 product_id 唯一键：${sql}`);
  assert.ok(!/image_url/.test(sql), '老库不该有 image_url 列');
});

let applied = 0;
check('ensureSkuSchema 不抛错并把迁移链跑到底', () => {
  pdb.ensureSkuSchema();
  const db = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
  applied = db.migrationVersion('product.sku');
  assert.strictEqual(applied, PRODUCT_SKU_STEPS);
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
  `CREATE TABLE oi_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
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
]);
dbRun(`INSERT INTO oi_styles (id, code, name, fingerprint) VALUES (1, 'S-OLD', '老款名', 'fp-s1')`);
dbRun(
  `INSERT INTO oi_images (id, url_fingerprint, source_url, local_path) VALUES (1, 'fp1', 'u', '/tmp/x')`,
);
dbRun(
  `INSERT INTO oi_orders (image_id, order_no, shop, size, order_time, raw_fields, status)
   VALUES (1, 'LEGACY-1', '店A', 'L', '2026-08-30', '{"订单金额":"CN￥ 165.18"}', 'pending')`,
);
const legacyBefore = dbGet(`SELECT id, order_no, shop, raw_fields FROM oi_orders`);

check('迁移记账推进到 order.main = 4（v1–v3 一次重建完成归一 + v4 回填）', () => {
  odb.ensureOrderSchema();
  // 本场景没有 ae_orders → v4 是**空操作**（顺序：v4 在迁移链里、表不存在就跳过），但版本照样推进
  assert.strictEqual(migrationVersion('order.main'), 4);
});

check('主干形状：+source/+qty；image_id 可空（免图导入的前提）；8 个零读者列已删', () => {
  const cols = dbQuery(`PRAGMA table_info(oi_orders)`).map((r) => String(r.name));
  for (const c of ['source', 'qty', 'amount_cents', 'vat_cents', 'ddp_cents', 'tax_platform', 'biz_status', 'ship_time']) {
    assert.ok(cols.includes(c), `缺列 ${c}`);
  }
  for (const gone of ['goods_cents', 'ship_fee_cents', 'shop_discount_cents', 'platform_subsidy_cents',
    'currency', 'biz_mode', 'paid_time', 'received_time']) {
    assert.ok(!cols.includes(gone), `该列已精简掉：${gone}`);
  }
  // image_id 可空：直接插一行不带图的订单（S2-b「订单报表免图导入」的前提）
  const id = odb.insertOrder({ imageId: null, orderNo: 'NO-IMG', shop: '', size: '', orderTime: '',
    category: '', color: '', logo: '', rawFields: { 商品ID: 'X1' } });
  assert.ok(id > 0, 'image_id 为空的订单必须能落库');
  dbRun(`DELETE FROM oi_orders WHERE id = ?`, [id]);
});

check('款式名已交接到 pl_products，且 oi_styles.name 已被删（不留第二数据源）', () => {
  const cols = dbQuery(`PRAGMA table_info(oi_styles)`).map((r) => String(r.name));
  assert.ok(!cols.includes('name'), 'oi_styles.name 该已删除');
  const p = dbGet(`SELECT name FROM pl_products WHERE code = 'S-OLD'`);
  assert.strictEqual(p && p.name, '老款名', '历史款名必须已交接进产品表');
});

check('老行：source=import、qty=NULL、金额为 NULL（不是 0）', () => {
  const row = dbGet(
    `SELECT amount_cents, vat_cents, biz_status, source, qty FROM oi_orders WHERE order_no = 'LEGACY-1'`,
  );
  assert.strictEqual(row.amount_cents, null, '老行金额必须是 NULL（未知），不能是 0');
  assert.strictEqual(row.source, 'import', '老行一律是报表导入来的');
  assert.strictEqual(row.qty, null, '件数真值只有采集通道会给');
});

check('数据一条不丢（行数 / 主键 / raw_fields 原样）', () => {
  const after = dbGet(`SELECT id, order_no, shop, raw_fields FROM oi_orders`);
  assert.deepStrictEqual(after, legacyBefore);
});

check('AUTOINCREMENT 已追平：重建后新插入的 id 必须大于历史最大 id', () => {
  const id = odb.insertOrder({ imageId: 1, orderNo: 'NEW-1', shop: '店B', size: 'M',
    orderTime: '08/30/2026 07:00', category: '', color: '', logo: '',
    rawFields: { 订单号: 'NEW-1', 订单状态: '交易完成', 订单金额: 'CN￥ 165.18', 预计增值税: 'CN￥ 34.69', DDP关税: 'CN￥ 22.94', 平台是否代征代缴: '平台已税', 发货时间: '08/31/2026 12:57' } });
  assert.ok(Number(id) > Number(legacyBefore.id), `新 id(${id}) 必须大于历史最大 id(${legacyBefore.id})`);
  const row = dbGet(`SELECT amount_cents, vat_cents, ddp_cents, tax_platform, biz_status, ship_time, source, qty FROM oi_orders WHERE id = ?`, [id]);
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
  assert.strictEqual(migrationVersion('order.main'), 4); // v4 = 历史采集单回填（本冒烟场景 E 详测）
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM oi_orders`).n), before);
});
closeDb();
try {
  fs.rmSync(dirC, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

// ────────────────────────────────────────────────────────── 场景 D：ae 域老库追上
console.log('\n[D] ae_cost_map 老形状（style_code 单主键）→ 迁移重建后可用');
const dirD = newDb('ae-legacy');
const aedb = require(path.join(ROOT, 'dist', 'electron', 'ae-db.js'));
// 老形状：一款一行、无 effective_from/source；ae_order_lines 无 style_code
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
]);
dbRun(`INSERT INTO ae_cost_map (style_code, style_name, unit_price_cents, sample_count) VALUES ('S1','款1',1234,3)`);

check('迁移：ae.main 记到 v2，老行不丢且补上哨兵生效日', () => {
  aedb.ensureAeSchema();
  assert.strictEqual(migrationVersion('ae.main'), 2);
  const row = dbGet(`SELECT style_code, unit_price_cents, effective_from, source FROM ae_cost_map`);
  assert.strictEqual(row.style_code, 'S1');
  assert.strictEqual(Number(row.unit_price_cents), 1234);
  assert.strictEqual(row.effective_from, '0000-01-01'); // 哨兵：早于任何真实业务日期
  assert.strictEqual(row.source, 'purchase');
  const n = dbGet(`SELECT COUNT(*) AS n FROM sqlite_master WHERE name LIKE '%legacy_struct%'`);
  assert.strictEqual(Number(n.n), 0, '中间表必须已清理');
});

check('ae_order_lines 补上 style_code（新库靠建表语句、老库靠迁移，两条路都要有）', () => {
  const cols = dbQuery(`PRAGMA table_info(ae_order_lines)`).map((r) => String(r.name));
  assert.ok(cols.includes('style_code'), '缺 style_code 列');
});

check('幂等：再跑 ensureAeSchema 不重复记账、不改行数', () => {
  const before = Number(dbGet(`SELECT COUNT(*) AS n FROM ae_cost_map`).n);
  aedb.ensureAeSchema();
  aedb.ensureAeSchema();
  assert.strictEqual(migrationVersion('ae.main'), 2);
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM ae_cost_map`).n), before);
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
  `CREATE TABLE oi_images (
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
  return dbQuery(`SELECT order_no, amount_cents, qty, color, size, shop, biz_status, raw_fields
                  FROM oi_orders WHERE source = 'collect' ORDER BY order_no, id`);
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
  assert.strictEqual(migrationVersion('order.main'), 4);
});

check('老采集表**原样保留**（回填是加法，删表是另一步）', () => {
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM ae_orders`).n), 2);
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM ae_order_lines`).n), 2);
});
closeDb();
try {
  fs.rmSync(dirE, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

console.log('\n' + '\u2500'.repeat(64));
if (failed) {
  console.log(`\u2717 版本化迁移冒烟失败：${failed} 项\n`);
  process.exit(1);
}
console.log('\u2713 版本化迁移冒烟全部通过\n');
process.exit(0);