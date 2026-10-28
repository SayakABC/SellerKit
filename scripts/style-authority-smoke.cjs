// 款式主数据权威冒烟（ADR-002 D1 = 路径 A，不启动 Electron 界面）。
//
//   npm run style:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/style-authority-smoke.cjs
//
// 为什么必须是 DB 层冒烟而不是源码文本断言：D1 的核心承诺是「**读侧真的跟着派生走**」——
// 五处读点（order-db 列表 / 订单列表 / 搜索条件 / purchase-db 两处 JOIN）只要漏改一处，
// 那处的表现是"改完名字界面没变"，而文本断言（"文件里没有 s.name"）证明不了这一点。
// 所以每条读点都配一条「改产品库 → 该出口跟着变」的行为断言。
//
// 三个必守的语义（改 order-db/product-db/purchase-db 时别弄丢）：
//   1. 写：只有 pl_products 承载款名（`oi_styles.name` 在新库里是**恒空串的哨兵列**，
//      老库走 v3 迁移时**直接 DROP COLUMN** —— 两条路都保证它不可能是第二数据源）；
//   2. 读：五处出口全部按 pl_products.code = oi_styles.code 派生，且**缺行时不掉行**；
//   3. 交接：老库的展示名一次性搬进产品库，已有主数据不被历史值覆盖，且可重复执行。
//
// 库文件落在临时目录，不污染真实 userData。每个用例自带 reset()。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-style-smoke-'));

const { initDb, dbRun, dbGet, dbQuery, migrationVersion } = require(
  path.join(ROOT, 'dist', 'electron', 'db.js'),
);
const odb = require(path.join(ROOT, 'dist', 'electron', 'order-db.js'));
const pdb = require(path.join(ROOT, 'dist', 'electron', 'product-db.js'));
const sdb = require(path.join(ROOT, 'dist', 'electron', 'shop-db.js'));
const purdb = require(path.join(ROOT, 'dist', 'electron', 'purchase-db.js'));

initDb(path.join(dir, 'smoke.db'));
odb.ensureOrderSchema();
pdb.ensureSkuSchema(); // reset() 会清 pl_shop_sku；A 组是"老库"场景，不会先跑到建表那里
sdb.ensureShopSchema();
purdb.ensurePurchaseSchema();

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err && err.message ? err.message : String(err)}`);
  }
}

// ---- 夹具 ----

/**
 * 订单域的稳态 = **v3 主干形状** + `oi_styles` 有哨兵列 `name` + 迁移记账最新。
 *
 * 为什么 `reset()` 必须顺手把形状拉回来：A 组会把库退回**老形状**跑真实迁移，而那次迁移会把
 * `oi_styles.name` **删掉**（老库删列后不重建）。B/C 组依赖这一列存在 —— `legacyName()` 与
 * `plantGhostName()` 都要读它（后者往列里种一个"幽灵名"，用来证伪"读侧偷偷读遗留列"）。
 * 若不给回来，A 组一变红就会连锁把 B/C 全带红，**真正的原因被淹掉**。
 * （新库里这一列本来就存在、恒 `''`，所以补回来只是还原新库形状，不是开特例。）
 */
const ORDER_MAIN_BEFORE_V3 = 2; // v3 是第 3 步迁移 → 它之下的版本号是 2
const ORDER_MAIN_LATEST = migrationVersion('order.main'); // 启动时已跑全量迁移，取到的就是最新

const setOrderMainVersion = (v) =>
  dbRun(`UPDATE sk_schema_migrations SET version = ? WHERE key = 'order.main'`, [v]);

const colsOf = (table) =>
  dbQuery(`PRAGMA table_info(${table})`).map((r) => String(r.name ?? ''));

function toSteadyState() {
  if (colsOf('oi_orders').length > 0 && !colsOf('oi_orders').includes('source')) {
    setOrderMainVersion(ORDER_MAIN_BEFORE_V3);
    odb.ensureOrderSchema(); // 老形状 → 补跑 v3，归一为主干
  }
  if (!colsOf('oi_styles').includes('name')) {
    dbRun(`ALTER TABLE oi_styles ADD COLUMN name TEXT NOT NULL DEFAULT ''`);
  }
  setOrderMainVersion(ORDER_MAIN_LATEST);
}

/** 外键开着（db.ts pragma foreign_keys=ON）→ 必须子表先删 */
const reset = () => {
  for (const t of [
    'oi_orders',
    'oi_images',
    'oi_style_colors',
    'oi_style_fingerprints',
    'oi_styles',
    'purchase_items',
    'purchase_orders',
    'purchase_ignore',
    'pl_products',
    'pl_shop_sku',
    'sk_shops',
    'sk_name_map',
  ]) {
    dbRun(`DELETE FROM ${t}`);
  }
  toSteadyState();
};

/**
 * 把库退回 **D1 之前的老形状**，好让 v3 迁移（`order-db.ts` 的 `migrateOrderSpine`）**真的跑起来**。
 *
 * ⚠️ 为什么非退不可（2026-10-01 修的假红根因）：
 *   · 「款式名交接」只在 v3 里跑，而 v3 的幂等判据是「`oi_orders` 已有 `source` 列」；
 *   · `oi_styles.name` 在**新库**里依然存在（只作哨兵位、恒 `''`）。
 *   于是「新形状 `oi_orders` + 有值的老 `name`」这个组合**在真实世界里不可能出现** ——
 *   上一版夹具正是这么建的，结果 v3 一路 early-return，交接从未发生，A 组三条全红
 *   （而红的原因看着像"实现坏了"）。⇒ 夹具必须造**真正的老形状**，并把记账退回 v3 之前。
 *
 * 形状与 `scripts/schema-migration-smoke.cjs` 场景 C 同源（v3 场景的正式归属地在那里，
 * 本组只借它来验 D1 的交接语义）。**改 `ORDER_TABLE_DDL` 时这里不用动**（它描述的是旧形状），
 * 但要看一眼 v3 重建时的 SELECT 列清单是否仍与下面这份 DDL 对得上。
 */
function seedLegacyOrderShape() {
  // 拆表后 `oi_order_items` 外键引用 `oi_orders`：造 D1 之前老形状必须先删明细，
  // 否则 v3 迁移 RENAME `oi_orders` 时外键被自动改指 legacy 表、DROP 后变成悬空引用。
  dbRun(`DROP TABLE IF EXISTS oi_order_items`);
  dbRun(`DROP TABLE IF EXISTS oi_orders`);
  dbRun(`DROP TABLE IF EXISTS oi_styles`);
  dbRun(`CREATE TABLE oi_orders (
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
    amount_cents INTEGER,
    vat_cents INTEGER,
    ddp_cents INTEGER,
    tax_platform TEXT,
    biz_status TEXT,
    ship_time TEXT,
    goods_cents INTEGER,
    ship_fee_cents INTEGER,
    shop_discount_cents INTEGER,
    platform_subsidy_cents INTEGER,
    currency TEXT,
    biz_mode TEXT,
    paid_time TEXT,
    received_time TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`);
  dbRun(`CREATE TABLE oi_styles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`);
  setOrderMainVersion(ORDER_MAIN_BEFORE_V3);
}

/** A 组专用：稳态 → 老形状 → 灌历史款式（模拟 D1 之前的老库） */
function seedLegacyDb(styles) {
  reset();
  seedLegacyOrderShape();
  for (const [code, name] of styles) seedLegacyStyle(code, name);
}

/** 直接写 oi_styles（带 name）：模拟 D1 之前的老库 */
function seedLegacyStyle(code, name) {
  dbRun(`INSERT INTO oi_styles (code, name, fingerprint) VALUES (?, ?, ?)`, [code, name, `FP-${code}`]);
  return Number(dbGet(`SELECT id FROM oi_styles WHERE code = ?`, [code]).id);
}

/** 遗留列的真实值（不是接口返回的名字 —— 断言"没人写它"要看列本身） */
const legacyName = (code) => String(dbGet(`SELECT name FROM oi_styles WHERE code = ?`, [code])?.name ?? '<无此行>');

/**
 * 往遗留列里塞一个"幽灵名"。
 * 真实链路里 `oi_styles.name` 在新库恒为 `''`，所以"读侧没读到它"这件事**无法用正常数据证伪** ——
 * 必须人为造一个只可能被「漏改的读点」命中的值（同"对称交换计数器不破坏汇总断言"那条教训）。
 * ⚠️ 依赖哨兵列存在 → 由 `reset()` 的 `toSteadyState()` 保证（A 组的迁移会把它删掉）。
 */
function plantGhostName(code, ghost) {
  dbRun(`UPDATE oi_styles SET name = ? WHERE code = ?`, [ghost, code]);
}

const productByCode = (code) => dbGet(`SELECT * FROM pl_products WHERE code = ?`, [code]);

const productRow = (over = {}) => ({
  id: 0,
  code: 'STYLE-001',
  name: '产品名',
  supplierId: 0,
  category: '家居',
  status: 'active',
  note: '',
  ...over,
});

const listAll = () => pdb.listProducts({ offset: 0, limit: 50, search: '', status: '', supplierId: 0 });

const shopRow = (over = {}) => ({
  id: 0,
  platform: 'amazon',
  name: '店A',
  site: '',
  status: 'active',
  openedAt: '',
  note: '',
  ...over,
});

/** 确认一条 (平台, 店铺, 商品ID) → 产品 的映射 */
function confirmMap({ shopId, itemId, productId, status = 'confirmed', platform = 'amazon' }) {
  const r = pdb.upsertSkuMappings([{ platform, shopId, itemId, productId, status }]);
  assert.strictEqual(r.failed.length, 0, `映射写入失败：${JSON.stringify(r.failed)}`);
}

/** 订单图片当前归属的**款编码**（空串 = 未归款） */
function imageStyleCode(imageId) {
  const row = dbGet(
    `SELECT s.code AS code FROM oi_images i
     JOIN oi_style_colors sc ON sc.id = i.style_color_id
     JOIN oi_styles s ON s.id = sc.style_id WHERE i.id = ?`,
    [imageId],
  );
  return row ? String(row.code ?? '') : '';
}

/** 落一条带商品ID 的订单（不过 AI：本组验证的正是"确定性映射"这条路） */
function insertMappedOrder({ orderNo, shop, itemId, color = '红色', imageId }) {
  const img =
    imageId ??
    odb.insertImage({ fingerprint: `FP-${orderNo}`, urlFingerprint: `FP-${orderNo}-u`, sourceUrl: '', localPath: '' });
  const id = odb.insertOrder({
    imageId: img,
    orderNo,
    shop,
    size: 'M',
    rawFields: { 商品ID: itemId },
    category: '家居',
    color,
    logo: '',
  });
  return { imageId: img, orderId: id };
}

/** 造一条"有款色归属"的订单：识别建款 → 落图 → 挂款色 → 落单 */
function seedOrder({ fp = 'FP-A', color = '红色', size = 'M', shop = '店A', orderNo = 'NO-1' } = {}) {
  const res = odb.resolveStyle({ fingerprint: fp, category: '家居', features: [], color });
  const imgId = odb.insertImage({ fingerprint: fp, urlFingerprint: `${fp}-u`, sourceUrl: '', localPath: '' });
  odb.setImageStyleColor(imgId, res.styleColorId);
  odb.insertOrder({
    imageId: imgId,
    orderNo,
    shop,
    size,
    rawFields: {},
    category: '家居',
    color,
    logo: '',
  });
  return res;
}

console.log('\n款式主数据权威冒烟（D1：pl_products 唯一权威）\n' + '\u2500'.repeat(64));

// ---- A. 迁移交接（**必须用真老库形状**，见 seedLegacyOrderShape 的注释） ----

check('A1 老库的款式展示名被交接进产品库', () => {
  seedLegacyDb([
    ['STYLE-001', '老库款式甲'],
    ['STYLE-002', ''],
  ]);
  assert.strictEqual(listAll().total, 0, '前置不成立：产品库本该是空的');
  odb.ensureOrderSchema();
  const rows = listAll().rows;
  assert.strictEqual(rows.length, 2, '历史款没有全部交接（空名的款也要建行，否则关联不变量不成立）');
  assert.strictEqual(rows.find((r) => r.code === 'STYLE-001').name, '老库款式甲');
});

check('A2 交接后 oi_styles.name 被删除（结构上不可能留下第二份会分叉的副本）', () => {
  seedLegacyDb([['STYLE-001', '老库款式甲']]);
  odb.ensureOrderSchema();
  assert.ok(
    !colsOf('oi_styles').includes('name'),
    '遗留列还在 → 哪天有人顺手读了它，C1 就又破一次（现行实现是直接 DROP COLUMN，比"置空哨兵"更硬）',
  );
  // ⚠️ 删列不等于交接成功：必须同时确认名字真的搬到了产品库，否则红的是"删列太早"
  assert.strictEqual(
    productByCode('STYLE-001') && productByCode('STYLE-001').name,
    '老库款式甲',
    '删了遗留列却没把名字交接到产品库 = 真丢数据',
  );
});

check('A3 交接幂等，且不覆盖已被人工改过的主数据', () => {
  seedLegacyDb([['STYLE-001', '老库款式甲']]);
  odb.ensureOrderSchema();
  pdb.renameProduct('STYLE-001', '人工改过的名');
  odb.ensureOrderSchema();
  odb.ensureOrderSchema();
  const rows = listAll().rows;
  assert.strictEqual(rows.length, 1, '重复执行建出了重复行');
  assert.strictEqual(rows[0].name, '人工改过的名', '历史遗留值把主数据覆盖回去了');
});

// ---- B. 写侧：唯一写入方 ----

check('B1 识别建款：产品库建行，识别编码池只留 code + 指纹', () => {
  reset();
  const res = odb.resolveStyle({ fingerprint: 'FP-A', category: '家居', features: ['圆角'], color: '红色' });
  const p = productByCode(res.styleCode);
  assert.ok(p, '识别建款没有交接进产品库');
  assert.strictEqual(p.name, '家居 圆角', '建款建议名没有落地到产品库');
  assert.strictEqual(legacyName(res.styleCode), '', '识别代码仍在写 oi_styles.name');
});

check('B2 再次交接同一编码不得覆盖人工维护的名字', () => {
  reset();
  pdb.upsertProduct(productRow({ code: 'STYLE-001', name: '人工名' }));
  pdb.adoptProduct({ code: 'STYLE-001', name: '识别建议名' });
  assert.strictEqual(productByCode('STYLE-001').name, '人工名', '识别结果盖掉了人工维护的主数据');
});

check('B3 建款编码要避开产品库已占用的编码（两处都是编码池）', () => {
  reset();
  pdb.upsertProduct(productRow({ code: 'STYLE-001' }));
  const res = odb.resolveStyle({ fingerprint: 'FP-A', category: '家居', features: [], color: '红色' });
  assert.notStrictEqual(res.styleCode, 'STYLE-001', '把产品库已占用的编码又发了一次 → 下次建款会撞唯一键');
});

check('B4 改名只落到产品库，不动识别编码池', () => {
  reset();
  const res = odb.resolveStyle({ fingerprint: 'FP-A', category: '家居', features: [], color: '红色' });
  odb.renameStyle(res.styleCode, '新展示名');
  assert.strictEqual(productByCode(res.styleCode).name, '新展示名');
  assert.strictEqual(legacyName(res.styleCode), '');
});

check('B5 改名不得重置产品的厂家/类目/状态/备注（窄接口而非整行 upsert）', () => {
  reset();
  const res = odb.resolveStyle({ fingerprint: 'FP-A', category: '家居', features: [], color: '红色' });
  const id = Number(productByCode(res.styleCode).id);
  pdb.upsertProduct(
    productRow({ id, code: res.styleCode, name: '旧名', category: '家居', status: 'archived', note: '备注' }),
  );
  odb.renameStyle(res.styleCode, '新名');
  const p = productByCode(res.styleCode);
  assert.strictEqual(p.name, '新名');
  assert.strictEqual(p.category, '家居', '类目被重置了');
  assert.strictEqual(p.status, 'archived', '状态被重置了');
  assert.strictEqual(p.note, '备注', '备注被清空了');
});

check('B6 产品库 Excel 导入（显式写入语义）允许覆盖名字', () => {
  reset();
  const res = odb.resolveStyle({ fingerprint: 'FP-A', category: '家居', features: [], color: '红色' });
  pdb.renameProduct(res.styleCode, '旧名');
  const r = odb.importStyles([{ code: res.styleCode, name: '导入的新名', color: '红色', fingerprint: 'FP-A' }]);
  assert.strictEqual(r.imported, 1);
  assert.strictEqual(productByCode(res.styleCode).name, '导入的新名', '显式导入没能覆盖产品库的旧名');
  assert.strictEqual(legacyName(res.styleCode), '');
});

check('B7 删款编码（识别池）不删产品库主数据 —— 且它**仍在款式列表里**', () => {
  reset();
  const res = odb.resolveStyle({ fingerprint: 'FP-A', category: '家居', features: [], color: '红色' });
  const id = Number(dbGet(`SELECT id FROM oi_styles WHERE code = ?`, [res.styleCode]).id);
  odb.deleteStyle(id);
  // 前提：识别池那一行真的没了（否则下面测的是别的事）
  assert.strictEqual(
    Number(dbGet(`SELECT COUNT(*) AS n FROM oi_styles WHERE code = ?`, [res.styleCode]).n),
    0,
    '夹具前提：识别池的行没被删掉',
  );
  assert.ok(productByCode(res.styleCode), '删订单空壳款把产品主数据一起删了');
  // ⭐ 2026-10-10 起「款式列表」由**产品库**驱动（`pl_products LEFT JOIN oi_styles`）：
  //    识别池删了行、产品库还在 ⇒ 它必须**仍然在列表里**。这条同时也是用户报的
  //    "归属款展示不全"的正解 —— 手工新建、没出过订单的产品也在同一个列表里。
  //    ⚠️ 旧版断言是 `listStyles().length === 0`（那时列表挂在识别池上）。**别改回它** ——
  //    那会要求"产品库还有这个款、列表里却没有"，正是要修的毛病。
  const s = odb.listStyles().find((x) => x.code === res.styleCode);
  assert.ok(s, '产品库还有这个款、列表里却没了（说明列表还挂在识别池上）');
  assert.strictEqual(s.name, String(productByCode(res.styleCode).name ?? ''), '名字没跟着产品库走');
});

// ---- C. 读侧：五处出口全部派生 ----

check('C1 款式列表的展示名来自产品库', () => {
  reset();
  const res = odb.resolveStyle({ fingerprint: 'FP-A', category: '家居', features: ['圆角'], color: '红色' });
  pdb.renameProduct(res.styleCode, '产品库新名');
  plantGhostName(res.styleCode, '幽灵名zzz');
  const s = odb.listStyles().find((x) => x.code === res.styleCode);
  assert.strictEqual(s.name, '产品库新名', '款式列表还在读识别编码池的名字');
});

check('C2 订单列表的款名来自产品库', () => {
  reset();
  const res = seedOrder();
  pdb.renameProduct(res.styleCode, '产品库新名');
  plantGhostName(res.styleCode, '幽灵名zzz');
  const page = odb.listOrdersPage({ limit: 10 });
  assert.strictEqual(page.rows.length, 1);
  assert.strictEqual(page.rows[0].styleName, '产品库新名', '订单列表还在读识别编码池的名字');
});

check('C3 订单搜索同样不读识别编码池的名字', () => {
  reset();
  const res = seedOrder();
  pdb.renameProduct(res.styleCode, '产品库的名字');
  plantGhostName(res.styleCode, '幽灵名zzz');
  assert.strictEqual(
    odb.listOrdersPage({ limit: 10, search: '幽灵名zzz' }).total,
    0,
    '搜索仍读识别编码池的 name（漏改的搜索条件只有这个输入能抓住）',
  );
  assert.strictEqual(
    odb.listOrdersPage({ limit: 10, search: '产品库的名字' }).total,
    1,
    '搜索没走产品库',
  );
});

check('C4 采购缺口的款名来自产品库（purchase-db 也是消费方）', () => {
  reset();
  const res = seedOrder();
  pdb.renameProduct(res.styleCode, '产品库新名');
  plantGhostName(res.styleCode, '幽灵名zzz');
  const rows = purdb.outstanding();
  assert.strictEqual(rows.length, 1, '前置不成立：应有一条待拿货缺口');
  assert.strictEqual(rows[0].styleName, '产品库新名', '采购域还在读识别编码池的名字');
});

check('C5 产品库缺该款时仍要列出该款（LEFT JOIN 不掉行），且不回落遗留列', () => {
  reset();
  const res = seedOrder();
  dbRun(`DELETE FROM pl_products WHERE code = ?`, [res.styleCode]);
  plantGhostName(res.styleCode, '幽灵名zzz');
  const s = odb.listStyles().find((x) => x.code === res.styleCode);
  assert.ok(s, 'oi_styles 有行而产品缺失时被静默丢掉了（用 INNER JOIN 会让"少一行"看起来像"没这款"）');
  assert.strictEqual(s.name, '', '缺行时回落到了遗留列 —— 交接等于白做，名字又从两个地方来了');
});

// ---- D. 订单导入接 resolve（确定性优先） ----

check('D1 映射命中：订单落库即归到该产品的款色（不依赖 AI）', () => {
  reset();
  const shop = sdb.upsertShop(shopRow());
  const p = pdb.upsertProduct(productRow({ code: 'STYLE-900', name: '映射产品' }));
  confirmMap({ shopId: shop.id, itemId: 'ITEM-1', productId: p.id });
  const { imageId } = insertMappedOrder({ orderNo: 'NO-1', shop: '店A', itemId: 'ITEM-1' });
  assert.strictEqual(imageStyleCode(imageId), 'STYLE-900', '命中映射却没归款');
});

check('D2 未命中：既不改动、也不清空既有归属', () => {
  reset();
  const { imageId } = insertMappedOrder({ orderNo: 'NO-2', shop: '店A', itemId: 'ITEM-无映射' });
  const sc = odb.resolveStyle({ fingerprint: 'FP-AI', category: '家居', features: [], color: '蓝色' });
  odb.setImageStyleColor(imageId, sc.styleColorId);
  // 重入同一条订单（映射仍未建立）→ 归属必须原样
  insertMappedOrder({ orderNo: 'NO-2', shop: '店A', itemId: 'ITEM-无映射', imageId });
  assert.strictEqual(imageStyleCode(imageId), sc.styleCode, '未命中的路径改动了 AI 的归属');
});

check('D3 未确认（pending）的映射不得替人下结论', () => {
  reset();
  const shop = sdb.upsertShop(shopRow());
  const p = pdb.upsertProduct(productRow({ code: 'STYLE-900' }));
  confirmMap({ shopId: shop.id, itemId: 'ITEM-3', productId: p.id, status: 'pending' });
  const { imageId } = insertMappedOrder({ orderNo: 'NO-3', shop: '店A', itemId: 'ITEM-3' });
  assert.strictEqual(imageStyleCode(imageId), '', 'pending 映射被当成已确认用了');
});

check('D4a 店铺未归一：不命中（哪怕库里存在指向 shop_id=0 的脏映射）', () => {
  reset();
  const p = pdb.upsertProduct(productRow({ code: 'STYLE-900' }));
  // 正常写入路径拒绝这种行（空平台 + shop_id=0），但历史库 / 手工 SQL 可能有 ——
  // 只造"真实映射"的话，`if (!shopId) return null` 这一层永远不会被考到（前一层先兜住了）。
  dbRun(
    `INSERT INTO pl_shop_sku (platform, shop_id, item_id, spec, product_id, status)
     VALUES ('', 0, 'ITEM-4', '*', ?, 'confirmed')`,
    [p.id],
  );
  const { imageId } = insertMappedOrder({ orderNo: 'NO-4', shop: '没登记的店', itemId: 'ITEM-4' });
  assert.strictEqual(imageStyleCode(imageId), '', '店铺认不出来却按「空平台 + shop_id=0」的脏映射归了款 → 会串店');
});

check('D4b 已登记的另一家店：不命中（店铺维度必须参与匹配）', () => {
  reset();
  const shopA = sdb.upsertShop(shopRow({ name: '店A' }));
  sdb.upsertShop(shopRow({ name: '店B' })); // 已登记，但不是映射里那家
  const p = pdb.upsertProduct(productRow({ code: 'STYLE-900' }));
  confirmMap({ shopId: shopA.id, itemId: 'ITEM-4', productId: p.id });
  const { imageId } = insertMappedOrder({ orderNo: 'NO-4B', shop: '店B', itemId: 'ITEM-4' });
  assert.strictEqual(imageStyleCode(imageId), '', '同商品ID 换了一家店也命中 → 键里丢了店铺维度');
});

check('D5 产品库独有的款：命中时补占位款，且不吸走真实指纹', () => {
  reset();
  const shop = sdb.upsertShop(shopRow());
  const p = pdb.upsertProduct(productRow({ code: 'STYLE-900', name: '手工产品' }));
  confirmMap({ shopId: shop.id, itemId: 'ITEM-5', productId: p.id });
  assert.strictEqual(
    dbQuery(`SELECT id FROM oi_styles WHERE code = 'STYLE-900'`).length,
    0,
    '前置不成立：识别池本无此款',
  );
  const { imageId } = insertMappedOrder({ orderNo: 'NO-5', shop: '店A', itemId: 'ITEM-5' });
  assert.strictEqual(imageStyleCode(imageId), 'STYLE-900', '手工建的产品命中后没落到款色上');
  // 占位款的哨兵指纹不能把后续真实指纹吸走（否则 AI 识别会把别的款归到这个手工款）
  const r = odb.resolveStyle({ fingerprint: '真实指纹-AAA', category: '家居', features: [], color: '红色' });
  assert.notStrictEqual(r.styleCode, 'STYLE-900', '真实指纹被占位款吸走了');
  assert.strictEqual(legacyName('STYLE-900'), '', '占位行不该带展示名（识别池的 name 恒空）');
});

check('D6 先导订单、后确认映射：重导同一条订单即自动命中', () => {
  reset();
  const shop = sdb.upsertShop(shopRow());
  const p = pdb.upsertProduct(productRow({ code: 'STYLE-900' }));
  const { imageId } = insertMappedOrder({ orderNo: 'NO-6', shop: '店A', itemId: 'ITEM-6' });
  assert.strictEqual(imageStyleCode(imageId), '', '前置不成立：确认映射前不该命中');
  confirmMap({ shopId: shop.id, itemId: 'ITEM-6', productId: p.id });
  insertMappedOrder({ orderNo: 'NO-6', shop: '店A', itemId: 'ITEM-6', imageId }); // 重导（走幂等分支）
  assert.strictEqual(imageStyleCode(imageId), 'STYLE-900', '幂等重入没有重试归款 → 先导后关联的人永远等不到命中');
});

console.log('\u2500'.repeat(64));
if (failed) {
  console.log(`\u2717 款式主数据权威冒烟失败 ${failed} 项\n`);
  process.exit(1);
}
console.log('\u2705 全部通过：写侧唯一（pl_products）、读侧五处全派生、老库交接幂等\n');
process.exit(0);
