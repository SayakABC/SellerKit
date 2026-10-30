// 店铺实体（sk_shops / sk_name_map）数据层冒烟（不启动 Electron 界面）。
//
//   npm run shop:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/shop-db-smoke.cjs
//
// 为什么不用 vitest：better-sqlite3 按 **Electron 的 Node ABI**（149）编译，vitest 跑在系统 Node（127），
// require 时直接抛 ABI 不匹配。故 DB 层统一走冒烟；纯函数的归一逻辑另在
// `tests/shopName.spec.ts`（15 例）里覆盖。
//
// 覆盖 S1 + 2026-10-22 物理合并的核心不变量：
//   · 归一只做「去空白 + 剥不可见字符」—— 肉眼一样的写法必须归成一个键，不同名必须不合并
//   · `sk_shops` 的 UNIQUE 建在**归一键**上（否则 "店A" 与 "店A " 能同时入库 → 精确命中立刻有歧义）
//   · 未归一名单是**实时聚合**两处历史文本，不是会被放陈的缓存表
//   · 不猜歧义：同名命中多家店时不给"精确命中"提示
//   · 指到不存在的店必须抛错，不静默写成"未归一"
//   · 合并后的「一行两态」：纯账号行 `name_key=''`、纯店铺行 `email=''` 都不参与各自维度的唯一性，
//     两者都空由 CHECK 拒绝（否则一行既不是店也不是账号，界面里无处安放）
//   · `upsertShop` 是**局部更新**：账号列（email / 工具引用 / 凭证）不在它的写入面里，
//     漏传的列必须保持原值 —— 「货与成本」编辑一次地址就把账号清空的事故不能再有
//   · 状态四态（启用 / 停用 / 封店 / 退店）：局部更新不许把封店 / 退店悄悄改回启用；
//     账号侧历史态（banned / closed / paused）在迁移时并入四态
//   · 记分分值（2026-10-23）：老库靠 `shop.columns` v1 补列；`0` = 未记录，
//     非法值抛错不静默归零
//   · 保证金到账时间（2026-10-25）：老库靠 `shop.columns` v2 补列；只在退店行展示，
//     缺少 = 空串（未填写），非法日期归一为空串而不是写脏值
//   · 删除保护（2026-10-26）：有记账引用（专属条目 / 公共分摊行 / 已作废条目）时**拒绝删除**
//     并引导改用停用；判据在编排层 `shop-delete-guard.ts`，本脚本调线上同一份函数
// 每个用例自带 reset()：避免上一条的种子数据让下一条"新增"报重复键，产生假失败。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-shop-smoke-'));

const { initDb, closeDb, dbRun, dbQuery, dbGet } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
const sdb = require(path.join(ROOT, 'dist', 'electron', 'shop-db.js'));
const adb = require(path.join(ROOT, 'dist', 'electron', 'shop-accounts-db.js'));
const ldb = require(path.join(ROOT, 'dist', 'electron', 'ledger-db.js'));
const { deleteShopAccountGuarded } = require(path.join(ROOT, 'dist', 'electron', 'shop-delete-guard.js'));
const { toNameKey } = require(path.join(ROOT, 'dist', 'electron', 'shopName.js'));

initDb(path.join(dir, 'smoke.db'));
sdb.ensureShopSchema();
// 记账表：删除保护要验的正是"有记账引用时不许删店"，没有这两张表就无从验证。
ldb.ensureLedgerSchema();

// 两个历史文本来源（本冒烟只关心"店铺名文本"这一列，故是最小同构桩）
dbRun(`CREATE TABLE IF NOT EXISTS oi_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, shop TEXT NOT NULL DEFAULT '')`);
dbRun(`CREATE TABLE IF NOT EXISTS purchase_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, shop TEXT NOT NULL DEFAULT '')`);

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

const reset = () => {
  // 分摊行先清（它挂在条目上）；记账条目也要清，否则上一条用例的引用会让下一条的"删除成功"假失败。
  for (const t of [
    'bk_allocations',
    'bk_entries',
    'sk_shops',
    'sk_name_map',
    'oi_orders',
    'purchase_sources',
    'sk_tool_accounts',
  ]) {
    dbRun(`DELETE FROM ${t}`);
  }
};

/** `upsertShop` 的入参（**局部更新**：不带的列保持原值，显式空串才清空） */
const shopInput = (over = {}) => ({
  id: 0,
  platform: 'ae',
  name: '深圳优选店',
  platformShopId: '',
  site: 'RU',
  status: 'active',
  openedAt: '',
  note: '',
  ...over,
});

/** 往两处文本各塞若干行 */
const seedOrders = (rows) => {
  // 本冒烟只关心"店铺名文本"这一列，故 `oi_orders` 是**最小同构桩**（见上方建表，只有 id/shop）——
  // 不要按真实订单表形状给它补列：那会把用例绑死在订单域 schema 上（B1 拆表时就误改过一次）。
  for (const s of rows) dbRun(`INSERT INTO oi_orders (shop) VALUES (?)`, [s]);
};
const seedPurchase = (rows) => {
  for (const s of rows) dbRun(`INSERT INTO purchase_sources (shop) VALUES (?)`, [s]);
};

const keys = (rows) => rows.map((r) => r.key);
const list = (p = {}) =>
  sdb.listShops({ offset: 0, limit: 50, search: '', platform: '', status: '', ...p });

console.log('\n店铺实体数据层冒烟（sk_shops / sk_name_map）\n' + '\u2500'.repeat(64));

// ---- 建表与幂等 ----

check('空库 ensure 幂等（连调两次不报错，两表都在）', () => {
  sdb.ensureShopSchema();
  sdb.ensureShopSchema();
  const t = dbQuery(`SELECT name FROM sqlite_master WHERE type='table' AND name IN ('sk_shops','sk_name_map')`);
  assert.strictEqual(t.length, 2, `期望两张表，实际 ${t.length}`);
});

check('空库：未归一名单为空、汇总全零（源表为空）', () => {
  reset();
  assert.deepStrictEqual(sdb.listUnmapped(), []);
  const s = sdb.shopSummary();
  assert.strictEqual(s.total, 0);
  assert.strictEqual(s.names.total, 0);
});

// `shop.main` 的整表合并迁移已随「未正式发布、无存量库」退役（现在只保留 v1 版本占位 +
// v2 清掉 `sk_shop_sets`），老形状夹具（店铺行 + 账号套装 + 邮箱账号）不再需要。
// `shop.columns`（score / deposit_received_at）仍要验：下面这条用例守的就是那两条补列分支。

check('前置：当前库的表形状已含 score / deposit_received_at，shop.columns 账本记到 v2', () => {
  const cols = dbQuery(`PRAGMA table_info(sk_shops)`).map((r) => String(r.name));
  assert.ok(cols.includes('score'), '新库的建表语句必须自带 score —— 否则只有老库能补，新库反而缺列');
  assert.ok(
    cols.includes('deposit_received_at'),
    '新库的建表语句必须自带 deposit_received_at（保证金到账时间）',
  );
  // 账本一 key 一行、只存**最新版本**（migrate 的 upsert 语义），不是每步一行
  assert.strictEqual(
    dbQuery(`SELECT version FROM sk_schema_migrations WHERE key = 'shop.columns'`)[0].version,
    2,
    'shop.columns 应记到 v2（v1 score + v2 deposit_received_at；它与 shop.main 的版本号互不影响）',
  );
});

// ⚠️ 本脚本的库是现建的，建表语句已含这两列 ⇒ ALTER 分支一次都不会执行。
// 必须造一张「当前形状但既没有 score 也没有 deposit_received_at」的老表，并把 shop.columns 的账本倒回 0。
// 注意**不能只 DROP 表就调 ensure**：`dbMigrate(SCHEMA)` 会按新形状把表建出来（带这两列），
// 补列分支照样恒绿。所以老表要自己按 DDL 建好，让 `CREATE TABLE IF NOT EXISTS` 变成空操作。
check('老库补列：shop.columns v1/v2 给 sk_shops 补 score 与 deposit_received_at，老行默认值正确、数据不丢、幂等', () => {
  reset();
  dbRun(`DROP TABLE IF EXISTS sk_shops`);
  dbRun(`CREATE TABLE sk_shops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL DEFAULT 'ae',
    name TEXT NOT NULL DEFAULT '',
    name_key TEXT NOT NULL DEFAULT '',
    platform_shop_id TEXT NOT NULL DEFAULT '',
    shop_url TEXT NOT NULL DEFAULT '',
    shop_url_raw TEXT NOT NULL DEFAULT '',
    site TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    company_id INTEGER NOT NULL DEFAULT 0,
    ziniao_account_id INTEGER NOT NULL DEFAULT 0,
    erp_account_id INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    opened_at TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    secret_enc BLOB,
    secret_keys TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    CHECK (trim(name) <> '' OR trim(email) <> ''),
    CHECK (
      (trim(name) = '' AND trim(name_key) = '') OR
      (trim(name) <> '' AND trim(name_key) <> '')
    )
  )`);
  const seeded = dbRun(
    `INSERT INTO sk_shops (platform, name, name_key, site, status, note)
     VALUES ('ae', '补列前的老店', '补列前的老店', 'RU', 'banned', '这条备注不许丢')`,
  );
  dbRun(`DELETE FROM sk_schema_migrations WHERE key = 'shop.columns'`);

  const before = dbQuery(`PRAGMA table_info(sk_shops)`).map((r) => String(r.name));
  assert.ok(!before.includes('score'), '前置条件：老表本来就没有 score 列');
  assert.ok(!before.includes('deposit_received_at'), '前置条件：老表本来也没有 deposit_received_at 列');

  sdb.ensureShopSchema();

  const after = dbQuery(`PRAGMA table_info(sk_shops)`).map((r) => String(r.name));
  assert.ok(after.includes('score'), 'shop.columns v1 必须把 score 补上');
  assert.ok(after.includes('deposit_received_at'), 'shop.columns v2 必须把 deposit_received_at 补上');
  const row = dbGet(
    `SELECT name, site, status, note, score, deposit_received_at FROM sk_shops WHERE id = ?`,
    [seeded.lastInsertRowid],
  );
  assert.ok(row, '补列不许丢行');
  assert.strictEqual(row.site, 'RU', '既有列原样');
  assert.strictEqual(row.status, 'banned', '补列不许改状态（封店仍是封店）');
  assert.strictEqual(row.note, '这条备注不许丢');
  assert.strictEqual(Number(row.score), 0, '老行没有记分记录 ⇒ 0（未记录），不是 NULL、也不是脏值');
  assert.strictEqual(row.deposit_received_at, '', '老行没有保证金记录 ⇒ 空串（未填写），不是 NULL');

  // 幂等：再 ensure 两次不重复 ALTER、不产生额外行
  sdb.ensureShopSchema();
  sdb.ensureShopSchema();
  assert.strictEqual(dbQuery(`SELECT COUNT(*) AS c FROM sk_shops`)[0].c, 1);
  assert.strictEqual(Number(sdb.getShop(Number(seeded.lastInsertRowid)).score), 0);
  assert.strictEqual(
    dbQuery(`SELECT deposit_received_at FROM sk_shops WHERE id = ?`, [seeded.lastInsertRowid])[0]
      .deposit_received_at,
    '',
  );
});

// 保证金到账（2026-10-25）：字段走和 openedAt 一样的局部更新语义 ——
// 漏传 = 保持、空串 = 清空、非日期（没选全 / 手打乱码）归一为空串而不是把脏值写进库。
// 列表投影必须带出来（列表渲染只读 list，不读详情）。
check('保证金到账：写入 / 列表带出 / 漏传保持 / 带时间只留日期 / 非法日期归一空串 / 空串清空', () => {
  reset();
  const { id } = adb.upsertShopAccount({ name: '保证金店', depositReceivedAt: '2026-02-03' });
  assert.strictEqual(adb.getShopAccount(id).depositReceivedAt, '2026-02-03');
  assert.strictEqual(
    adb.listShopAccounts({ search: '保证金店' })[0].depositReceivedAt,
    '2026-02-03',
    '共享列表投影必须带出 depositReceivedAt（退店行要显示到账日期）',
  );
  adb.upsertShopAccount({ id, note: '改备注' });
  assert.strictEqual(adb.getShopAccount(id).depositReceivedAt, '2026-02-03', '漏传 = 保持原值');
  adb.upsertShopAccount({ id, depositReceivedAt: '2026-05-06T10:00:00' });
  assert.strictEqual(adb.getShopAccount(id).depositReceivedAt, '2026-05-06', '带时间的日期只留日期部分');
  adb.upsertShopAccount({ id, depositReceivedAt: '2026-02-30' });
  assert.strictEqual(
    adb.getShopAccount(id).depositReceivedAt,
    '',
    '不存在的日历日归一为空串（宁可显示未填，也不写一个假日期）',
  );
  adb.upsertShopAccount({ id, depositReceivedAt: '2026-07-08' });
  adb.upsertShopAccount({ id, depositReceivedAt: '' });
  assert.strictEqual(adb.getShopAccount(id).depositReceivedAt, '', '空串 = 显式清空');
});

// ---- 两处文本的聚合 ----

check('两处历史文本都被汇总进未归一名单', () => {
  reset();
  seedOrders(['甲店']);
  seedPurchase(['乙店']);
  const rows = sdb.listUnmapped();
  assert.deepStrictEqual(keys(rows).sort(), ['乙店', '甲店'].sort());
  assert.deepStrictEqual(rows.find((r) => r.key === '甲店').sources, ['order']);
  assert.deepStrictEqual(rows.find((r) => r.key === '乙店').sources, ['purchase']);
});

check('验收原文：未归一名单覆盖 oi_orders 的每一个店铺名（逐条，且计数一致）', () => {
  reset();
  seedOrders(['A店', 'A店', 'B店', '  B店  ', 'C店\u3000']);
  // 另一处是子集：此时"未归一名单条数"应与 DISTINCT shop 数完全一致
  seedPurchase(['A店']);
  const distinct = dbQuery(`SELECT DISTINCT shop FROM oi_orders WHERE shop <> ''`).map((r) => r.shop);
  const rows = sdb.listUnmapped();
  for (const raw of distinct) {
    const key = toNameKey(raw);
    assert.ok(
      rows.some((r) => r.key === key),
      `oi_orders 的 "${raw}"（键 "${key}"）不在未归一名单里`
    );
  }
  // A店 / B店 / C店 → 3 条（"  B店  " 与 "B店" 同键、'C店' + U+3000 去空白后为 C店）
  assert.strictEqual(rows.length, 3, `期望 3 条，实际 ${rows.length}：${JSON.stringify(keys(rows))}`);
});

check('归一同键：肉眼一样的写法合成一条，条数累加、来源去重', () => {
  reset();
  // 这四个都是同一个名字（首尾空白 / 零宽字符在**名字外部**）
  seedOrders(['店A', ' 店A ', '店A\u200b']);
  seedPurchase(['店A']);
  const rows = sdb.listUnmapped();
  assert.strictEqual(rows.length, 1, `期望合成 1 条，实际 ${rows.length}`);
  assert.strictEqual(rows[0].key, '店A');
  assert.strictEqual(rows[0].occurrences, 4, `条数应为 4，实际 ${rows[0].occurrences}`);
  assert.deepStrictEqual(rows[0].sources.sort(), ['order', 'purchase'].sort());
});

check('内部空白归一：全角空格 / 连续空格同为 "店 A"，但与 "店A" 不同键', () => {
  reset();
  seedOrders(['店\u3000A', '店  A', '店   A']);
  const rows = sdb.listUnmapped();
  assert.strictEqual(rows.length, 1, `三种内部空白写法应合成 1 条，实际 ${rows.length}`);
  assert.strictEqual(rows[0].key, '店 A');
  assert.strictEqual(rows[0].occurrences, 3);
  // 反向控制：内部空格是有效差异，不得与 "店A" 合并
  seedOrders(['店A']);
  assert.strictEqual(sdb.listUnmapped().length, 2);
});

check('不同名不得合并（不做模糊匹配）：编辑距离 1 的两条各自独立', () => {
  reset();
  seedOrders(['深圳优选店', '深圳优选店铺']);
  assert.strictEqual(sdb.listUnmapped().length, 2);
});

check('空 / 纯空白店铺名不进名单（否则噪音淹没真问题）', () => {
  reset();
  seedOrders(['', '   ', '\u3000', '\u200b']);
  seedPurchase(['']);
  assert.deepStrictEqual(sdb.listUnmapped(), []);
});

check('源表不存在时不炸（各域表按域懒建，不能假定都初始化过）', () => {
  reset();
  seedOrders(['甲店']);
  dbRun('DROP TABLE purchase_sources');
  try {
    assert.strictEqual(sdb.listUnmapped().length, 1);
    assert.strictEqual(sdb.shopSummary().names.total, 1);
  } finally {
    dbRun(`CREATE TABLE IF NOT EXISTS purchase_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, shop TEXT NOT NULL DEFAULT '')`);
  }
});

// ---- 门 1（店铺归一）：只数订单里出现过的店名 ----

check('门 1：只数订单 —— 只出现在拿货单里的旧店名不算（否则这个门永远关不上）', () => {
  reset();
  seedOrders(['甲店']);
  seedPurchase(['甲店', '乙店']); // 乙店只出现在历史拿货单里
  const g = sdb.shopNormalizeGate();
  assert.deepStrictEqual(g.pending.map((r) => r.key), ['甲店'], `不该带上乙店：${JSON.stringify(g.pending)}`);
  assert.strictEqual(g.orders, 1);
});

check('门 1：同一店名的多种写法合成一条，行数是**累加**的（3 行是 3 行，不是 1 条）', () => {
  reset();
  seedOrders(['店A', ' 店A ', '店A\u200b', '店B']);
  const g = sdb.shopNormalizeGate();
  assert.strictEqual(g.pending.length, 2, `期望 2 家，实际 ${JSON.stringify(g.pending)}`);
  const a = g.pending.find((r) => r.key === '店A');
  assert.strictEqual(a.orders, 3, `写法合并后行数应为 3，实际 ${a.orders}`);
  assert.strictEqual(g.orders, 4, `合计应为 4，实际 ${g.orders}`);
});

check('门 1：归一过的店铺不进清单（门是**派生**的 —— 归一完再算一次就少一家）', () => {
  reset();
  seedOrders(['店A', '店B']);
  const shop = sdb.upsertShop(shopInput({ name: '店A' }));
  assert.strictEqual(sdb.shopNormalizeGate().pending.length, 2, '归一前应有两家');
  sdb.mapName({ raw: '店A', refId: shop.id });
  const g = sdb.shopNormalizeGate();
  assert.deepStrictEqual(g.pending.map((r) => r.key), ['店B'], `归一后应只剩店B：${JSON.stringify(g.pending)}`);
  assert.strictEqual(g.orders, 1);
});

check('门 1：标了忽略的店不进清单（用户已经说过"这家别管"）', () => {
  reset();
  seedOrders(['甲店', '乙店']);
  sdb.mapName({ raw: '甲店', ignored: true });
  assert.deepStrictEqual(sdb.shopNormalizeGate().pending.map((r) => r.key), ['乙店']);
});

check('门 1：空 / 纯空白店名不算一项；按订单行数倒序（大店先做）', () => {
  reset();
  seedOrders(['', '  ', '小店', '大店', '大店', '大店']);
  const g = sdb.shopNormalizeGate();
  assert.deepStrictEqual(g.pending.map((r) => r.key), ['大店', '小店'], `排序不对：${JSON.stringify(g.pending)}`);
  assert.strictEqual(g.orders, 4);
});

check('门 1：同名店铺已在库里时带出候选名（界面才敢说"能认成谁"）', () => {
  reset();
  seedOrders(['店A']);
  sdb.upsertShop(shopInput({ name: '店A' }));
  const row = sdb.shopNormalizeGate().pending.find((r) => r.key === '店A');
  assert.strictEqual(row.autoShopName, '店A', '精确同名的店铺应作为候选');
  // 反向：库里没有这家店时不许编一个候选出来（空串 = "先登记再认"）
  reset();
  seedOrders(['查无此店']);
  assert.strictEqual(sdb.shopNormalizeGate().pending[0].autoShopName, '');
});

check('门 1：订单表还没建时返回空门，不炸（各域表按域懒建）', () => {
  reset();
  dbRun('DROP TABLE oi_orders');
  try {
    assert.deepStrictEqual(sdb.shopNormalizeGate(), { pending: [], orders: 0 });
  } finally {
    dbRun(`CREATE TABLE IF NOT EXISTS oi_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, shop TEXT NOT NULL DEFAULT '')`);
  }
});

// ---- 店铺主表 ----

check('新增店铺后可查；同名不同平台算两家（UNIQUE 是 platform × 名称）', () => {
  reset();
  const a = sdb.upsertShop(shopInput({ platform: 'ae', name: '同名牌' }));
  const b = sdb.upsertShop(shopInput({ platform: 'amazon', name: '同名牌' }));
  assert.strictEqual(a.created, true);
  assert.strictEqual(b.created, true);
  assert.strictEqual(list().total, 2);
});

check('同平台同名（只差首尾空白）必须抛错，不静默覆盖（UNIQUE 建在归一键上）', () => {
  reset();
  sdb.upsertShop(shopInput({ platform: 'ae', name: '店A' }));
  assert.throws(
    () => sdb.upsertShop(shopInput({ platform: 'ae', name: '  店A  ' })),
    /已存在同名店铺/,
    '只差空白的同名必须被判为冲突'
  );
  assert.strictEqual(list().total, 1, '冲突时不得写入第二行');
});

check('更新既有店铺不新增行（id 不变、created=false）', () => {
  reset();
  const { id } = sdb.upsertShop(shopInput({ name: '店A' }));
  const up = sdb.upsertShop(shopInput({ id, name: '店A 改名', note: '备注' }));
  assert.strictEqual(up.id, id);
  assert.strictEqual(up.created, false);
  assert.strictEqual(list().total, 1);
  assert.strictEqual(sdb.getShop(id).name, '店A 改名');
});

check('更新一个不存在的店铺 → 明确抛错（不静默新增）', () => {
  reset();
  assert.throws(() => sdb.upsertShop(shopInput({ id: 99999 })), /不存在或已被删除/);
});

check('空名称 / 纯空白名称 → 抛错', () => {
  reset();
  assert.throws(() => sdb.upsertShop(shopInput({ name: '' })), /不能为空/);
  assert.throws(() => sdb.upsertShop(shopInput({ name: '   ' })), /不能为空/);
});

check('列表：平台 / 状态过滤与关键字检索', () => {
  reset();
  // ⚠️ site 显式给不同值 —— 用默认值会让两家店同时命中同一个关键字，等于没测到过滤
  sdb.upsertShop(shopInput({ platform: 'ae', name: '甲店', site: 'RU' }));
  sdb.upsertShop(shopInput({ platform: 'amazon', name: '乙店', site: 'US', status: 'archived' }));
  assert.strictEqual(list({ platform: 'ae' }).total, 1);
  assert.strictEqual(list({ platform: 'amazon' }).total, 1);
  assert.strictEqual(list({ status: 'archived' }).total, 1);
  assert.strictEqual(list({ status: 'active' }).total, 1);
  assert.strictEqual(list({ search: 'RU' }).total, 1, 'site=RU 只应命中甲店');
  assert.strictEqual(list({ search: 'US' }).total, 1, 'site=US 只应命中乙店');
  assert.strictEqual(list({ search: '不存在的关键字' }).total, 0);
});

check('状态四态可写入、可筛选；局部更新不把封店 / 退店改回启用', () => {
  reset();
  assert.deepStrictEqual(
    sdb.SHOP_STATUSES.slice().sort(),
    ['active', 'archived', 'banned', 'exited'],
    '状态白名单必须是四态（封店 / 退店不能靠自由文本存）',
  );
  const a = sdb.upsertShop(shopInput({ platform: 'ae', name: '甲店', status: 'active' }));
  const b = sdb.upsertShop(shopInput({ platform: 'amazon', name: '乙店', status: 'banned' }));
  const c = sdb.upsertShop(shopInput({ platform: 'shopee', name: '丙店', status: 'exited' }));
  const d = sdb.upsertShop(shopInput({ platform: 'ebay', name: '丁店', status: 'archived' }));
  assert.strictEqual(list({ status: 'active' }).rows[0].name, '甲店');
  assert.strictEqual(list({ status: 'archived' }).rows[0].name, '丁店');
  assert.strictEqual(list({ status: 'banned' }).rows[0].name, '乙店');
  assert.strictEqual(list({ status: 'exited' }).rows[0].name, '丙店');
  // 局部更新（只改备注）：状态必须按**原值**归一后写回。旧实现只判 `archived`，
  // 会把封店 / 退店悄悄改回启用 —— 用户改一次地址，店就"复活"了，而且没有任何提示。
  sdb.upsertShop({ id: b.id, note: '封店中' });
  sdb.upsertShop({ id: c.id, note: '已退店' });
  sdb.upsertShop({ id: d.id, note: '停用中' });
  assert.strictEqual(sdb.getShop(b.id).status, 'banned', '封店不许被局部更新改回启用');
  assert.strictEqual(sdb.getShop(c.id).status, 'exited', '退店不许被局部更新改回启用');
  assert.strictEqual(sdb.getShop(d.id).status, 'archived', '停用不许被局部更新改回启用');
  // 汇总按四态各自计数（概览 chip 的数字来源）
  const byStatus = {};
  for (const r of sdb.shopSummary().byStatus) byStatus[r.status] = r.count;
  assert.deepStrictEqual(byStatus, { active: 1, archived: 1, banned: 1, exited: 1 });
  // 非法状态不写进白名单之外的值（按启用兜底，列表筛选仍四态可达）
  const bad = sdb.upsertShop(shopInput({ platform: 'wish', name: '戊店', status: '下架' }));
  assert.strictEqual(sdb.getShop(bad.id).status, 'active');
  assert.strictEqual([a.created, b.created, c.created, d.created].every(Boolean), true);
});

check('记分分值：写入 / 两位小数 / 局部更新保持 / 显式 0 清为未记录 / 非法值抛错', () => {
  reset();
  const { id } = sdb.upsertShop(shopInput({ name: '记分店' }));
  assert.strictEqual(sdb.getShop(id).score, 0, '新增不传 = 0（未记录）');
  sdb.upsertShop({ id, score: 12.5 });
  assert.strictEqual(sdb.getShop(id).score, 12.5);
  assert.strictEqual(
    list({ search: '记分店' }).rows[0].score,
    12.5,
    '共享列表投影必须带出 score（列表要显示记分）',
  );
  sdb.upsertShop({ id, note: '只改备注' });
  assert.strictEqual(sdb.getShop(id).score, 12.5, '漏传 score = 保持原值（局部更新语义）');
  sdb.upsertShop({ id, score: 3.456 });
  assert.strictEqual(sdb.getShop(id).score, 3.46, '保留两位小数');
  assert.throws(() => sdb.upsertShop({ id, score: -1 }), /记分分值/);
  assert.throws(() => sdb.upsertShop({ id, score: Number.NaN }), /记分分值/);
  assert.throws(() => sdb.upsertShop({ id, score: Infinity }), /记分分值/);
  assert.strictEqual(sdb.getShop(id).score, 3.46, '非法值抛错后原值不变（不许静默改写）');
  sdb.upsertShop({ id, score: 0 });
  assert.strictEqual(sdb.getShop(id).score, 0, '0 是「清为未记录」的唯一表达');
});

// ---- 平台店铺标识（platform_shop_id；2026-09-27 新增）----
// 这个字段的价值**不在"关联订单"** —— 两处历史文本（订单/采购）与账号套装都没有标识列
// （2026-09-27 逐处实测），全库唯一能拿来比对订单的仍是店名字符串。它解决的是：
//   ① 改名不断链（名称变了历史文本就断了，标识不变）
//   ② 把同一家店的多种写法收拢到一个键上（实测订单侧 42 行出现 7 种店名）

check('两项唯一性各自可达：撞名称报"同名"、撞标识报"标识已被占用"（一句"已存在"会让人修错地方）', () => {
  reset();
  sdb.upsertShop(shopInput({ name: '甲店', platformShopId: 'SID-1' }));
  // 只撞名称（标识是新的）→ 必须报"同名"
  assert.throws(
    () => sdb.upsertShop(shopInput({ name: '甲店', platformShopId: 'SID-2' })),
    /已存在同名店铺/,
    '名称冲突应报同名'
  );
  // 只撞标识（名称是新的）→ 必须报"标识已被占用"
  assert.throws(
    () => sdb.upsertShop(shopInput({ name: '乙店', platformShopId: 'SID-1' })),
    /店铺标识已被占用/,
    '标识冲突应报标识'
  );
  assert.strictEqual(list().total, 1, '两条冲突都不得写入');
});

check('部分唯一索引是硬约束：绕过 JS 检查直接插入同样被拦', () => {
  reset();
  dbRun(`INSERT INTO sk_shops (platform, name, name_key, platform_shop_id) VALUES ('ae','店1','店1','SID-1')`);
  assert.throws(
    () =>
      dbRun(
        `INSERT INTO sk_shops (platform, name, name_key, platform_shop_id) VALUES ('ae','店2','店2','SID-1')`
      ),
    /UNIQUE constraint failed/,
    '索引必须自己兜住 —— JS 检查只负责给可读文案，不是唯一防线'
  );
});

check(`空标识不参与唯一性：多家没填标识的店可以共存（部分索引 WHERE <> '' 的意义）`, () => {
  reset();
  dbRun(`INSERT INTO sk_shops (platform, name, name_key, platform_shop_id) VALUES ('ae','店1','店1','')`);
  dbRun(`INSERT INTO sk_shops (platform, name, name_key, platform_shop_id) VALUES ('ae','店2','店2','')`);
  dbRun(`INSERT INTO sk_shops (platform, name, name_key, platform_shop_id) VALUES ('ae','店3','店3','')`);
  assert.strictEqual(list().total, 3, '三条空标识的店应能共存（不写 WHERE 的话第二家就进不来）');
});

check('同一标识跨平台不冲突（唯一性含 platform；同一家店在不同平台各有一店是合法的）', () => {
  reset();
  sdb.upsertShop(shopInput({ platform: 'ae', name: '甲店', platformShopId: '1105228632' }));
  const b = sdb.upsertShop(shopInput({ platform: 'amazon', name: '乙店', platformShopId: '1105228632' }));
  assert.strictEqual(b.created, true);
  assert.strictEqual(list().total, 2);
});

check('标识与店铺名同口径归一：带零宽 / 首尾全角空白的写法视为同一个（Excel 粘过来就长这样）', () => {
  reset();
  sdb.upsertShop(shopInput({ name: '甲店', platformShopId: 'SID-1' }));
  assert.throws(
    () => sdb.upsertShop(shopInput({ name: '乙店', platformShopId: '  S\u200bID-1\u3000' })),
    /店铺标识已被占用/,
    '归一后同为 SID-1 → 必须冲突'
  );
  assert.strictEqual(list().rows[0].platformShopId, 'SID-1', '落库的应是归一后的值');
});

check('搜索能命中平台店铺标识（用户从后台抄来的就是一串 ID，搜 ID 比搜名字常用）', () => {
  reset();
  sdb.upsertShop(shopInput({ name: '甲店', platformShopId: '1105228632' }));
  sdb.upsertShop(shopInput({ name: '乙店', platformShopId: '9990001' }));
  assert.strictEqual(list({ search: '1105228632' }).total, 1, '应只命中甲店');
  assert.strictEqual(list({ search: '9990001' }).total, 1, '应只命中乙店');
});

// 合并后没有 shopSetId 这一列了（店铺与账号同一行）—— 换成钉住"一行两态"的三条约束：
// 纯账号行 / 纯店铺行 / 两者都空。这是物理合并最容易做错的地方：唯一性若照旧建在 name 上，
// 纯账号行（name=''）第二家就进不来。
check('一行两态：纯账号行（只有邮箱）与纯店铺行（只有店名）可以共存', () => {
  reset();
  dbRun(`INSERT INTO sk_shops (platform, name, name_key, email) VALUES ('ae','','','a@ex.com')`);
  dbRun(`INSERT INTO sk_shops (platform, name, name_key, email) VALUES ('ae','','','b@ex.com')`);
  dbRun(`INSERT INTO sk_shops (platform, name, name_key, email) VALUES ('ae','甲店','甲店','')`);
  dbRun(`INSERT INTO sk_shops (platform, name, name_key, email) VALUES ('ae','乙店','乙店','')`);
  assert.strictEqual(
    dbQuery(`SELECT COUNT(*) AS c FROM sk_shops`)[0].c,
    4,
    '四条（两家纯账号 + 两家纯店铺）都该进得来 —— 唯一性不许把纯账号行互相判重',
  );
  // 列表面**故意**只列有店名的行：纯账号行不该出现在订单/拣货/利润的店铺选择器里
  assert.strictEqual(list().total, 2, '店铺列表只列有店名的两行（纯账号行不进选择器）');
  assert.deepStrictEqual(
    list().rows.map((r) => r.name),
    ['乙店', '甲店'],
    '排序是 platform → name 的 BINARY 序（乙 U+4E59 在 甲 U+7532 之前）',
  );
});

check('邮箱唯一性是硬约束且大小写同键（lower(email) 部分索引）', () => {
  reset();
  dbRun(`INSERT INTO sk_shops (platform, name, name_key, email) VALUES ('ae','','','A@Ex.com')`);
  assert.throws(
    () =>
      dbRun(
        `INSERT INTO sk_shops (platform, name, name_key, email) VALUES ('amazon','','','a@ex.com')`
      ),
    /UNIQUE constraint failed/,
    '同一邮箱跨平台也只能是一个账号 —— 邮箱是账号身份，不参与"同名不同平台算两家"',
  );
});

check('店名与邮箱都为空的行被 CHECK 拒绝（既不是店也不是账号的行不该存在）', () => {
  reset();
  assert.throws(
    () => dbRun(`INSERT INTO sk_shops (platform, name, name_key, email) VALUES ('ae','','','')`),
    /CHECK constraint failed/,
    'CHECK (trim(name) <> "" OR trim(email) <> "") 必须拦住"空行" —— 它在任何列表里都无处安放',
  );
});

check('标识可清空（显式传空串即清空 —— 这是"清空"的唯一表达方式）', () => {
  reset();
  const { id } = sdb.upsertShop(shopInput({ name: '甲店', platformShopId: 'SID-1' }));
  sdb.upsertShop(shopInput({ id, name: '甲店', platformShopId: '' }));
  assert.strictEqual(sdb.getShop(id).platformShopId, '');
});

check('局部更新：不带标识 = 标识保持原值（2026-10-22 由全量提交改成局部提交）', () => {
  reset();
  const { id } = sdb.upsertShop(shopInput({ name: '甲店', platformShopId: 'SID-1' }));
  sdb.upsertShop({ id, name: '甲店改名' }); // 只给要改的两项，其余一律不传
  const row = sdb.getShop(id);
  assert.strictEqual(row.name, '甲店改名');
  assert.strictEqual(
    row.platformShopId,
    'SID-1',
    '漏传的列必须保持原值 —— 「货与成本」只改地址，不该把标识（更不该把账号列）抹掉',
  );
});

check('upsertShop 不碰账号列（同表不同写入面）', () => {
  reset();
  const { id } = sdb.upsertShop(shopInput({ name: '甲店' }));
  dbRun(
    `UPDATE sk_shops SET email = ?, company_id = ?, ziniao_account_id = ?, secret_keys = ? WHERE id = ?`,
    ['a@ex.com', 5, 2, '["shopPwd"]', id],
  );
  sdb.upsertShop({ id, name: '甲店改名', note: '只改名称与备注' });
  const row = dbGet(`SELECT email, company_id, ziniao_account_id, secret_keys FROM sk_shops WHERE id = ?`, [id]);
  assert.strictEqual(row.email, 'a@ex.com', '账号列不许被店铺侧写入抹掉');
  assert.strictEqual(Number(row.company_id), 5);
  assert.strictEqual(Number(row.ziniao_account_id), 2);
  assert.strictEqual(row.secret_keys, '["shopPwd"]');
});

// ---- 归一指派 ----

check('指派后该名称从未归一名单消失，店铺侧 aliasCount +1', () => {
  reset();
  const { id } = sdb.upsertShop(shopInput({ name: '深圳优选店' }));
  seedOrders(['深圳优选店', '深圳优选店 ', '深圳优选店']);
  assert.strictEqual(sdb.listUnmapped().length, 1);
  sdb.mapName({ raw: '深圳优选店 ', refId: id, ignored: false });
  assert.strictEqual(sdb.listUnmapped().length, 0, '已归一的名称不应再出现在名单里');
  assert.strictEqual(sdb.getShop(id).aliasCount, 1);
  const s = sdb.shopSummary();
  assert.strictEqual(s.names.total, 1);
  assert.strictEqual(s.names.mapped, 1);
  assert.strictEqual(s.names.unmapped, 0);
});

check('指派到不存在的店铺 → 抛错（不得静默写成"未归一"）', () => {
  reset();
  seedOrders(['店A']);
  assert.throws(() => sdb.mapName({ raw: '店A', refId: 4242, ignored: false }), /店铺不存在/);
  assert.throws(() => sdb.mapName({ raw: '店A', refId: 0, ignored: false }), /请选择要归一的店铺/);
  assert.strictEqual(sdb.listUnmapped().length, 1, '抛错后名单不应发生变化');
});

check('撤销归一 → 回到未归一名单', () => {
  reset();
  const { id } = sdb.upsertShop(shopInput({ name: '店A' }));
  seedOrders(['店A']);
  sdb.mapName({ raw: '店A', refId: id, ignored: false });
  assert.strictEqual(sdb.listUnmapped().length, 0);
  assert.deepStrictEqual(sdb.unmapName({ raw: ' 店A ' }), { removed: 1 });
  assert.strictEqual(sdb.listUnmapped().length, 1);
  assert.strictEqual(sdb.getShop(id).aliasCount, 0);
});

check('标记忽略 → 不再出现，且 ignored 时不要求 refId', () => {
  reset();
  seedOrders(['合计', '-']);
  // 忽略动作对"这不是店铺名"的噪音要能生效，此时没有可选店铺 → 不得因 refId=0 而抛错
  sdb.mapName({ raw: '合计', refId: 0, ignored: true });
  const rows = sdb.listUnmapped();
  assert.deepStrictEqual(rows.map((r) => r.key), ['-']);
  const s = sdb.shopSummary();
  assert.strictEqual(s.names.total, 2);
  assert.strictEqual(s.names.ignored, 1);
  assert.strictEqual(s.names.unmapped, 1);
});

check('汇总自洽：mapped + unmapped + ignored === total', () => {
  reset();
  const { id } = sdb.upsertShop(shopInput({ name: '已归一店' }));
  seedOrders(['已归一店', '未归一店']);
  seedPurchase(['忽略店']);
  sdb.mapName({ raw: '已归一店', refId: id, ignored: false });
  sdb.mapName({ raw: '忽略店', refId: 0, ignored: true });
  const n = sdb.shopSummary().names;
  assert.strictEqual(n.total, 3);
  assert.strictEqual(n.mapped + n.unmapped + n.ignored, n.total, JSON.stringify(n));
});

// ---- 精确命中提示：只给唯一解 ----

check('精确名唯一命中一家店 → 给出 autoShopId（供"一键采纳"）', () => {
  reset();
  const { id } = sdb.upsertShop(shopInput({ name: '深圳优选店' }));
  seedOrders([' 深圳优选店 ']);
  const row = sdb.listUnmapped()[0];
  assert.strictEqual(row.autoShopId, id);
  assert.strictEqual(row.autoShopName, '深圳优选店');
});

check('同名命中两家店（不同平台）→ 不给提示（不猜歧义）', () => {
  reset();
  sdb.upsertShop(shopInput({ platform: 'ae', name: '同名牌' }));
  sdb.upsertShop(shopInput({ platform: 'amazon', name: '同名牌' }));
  seedOrders(['同名牌']);
  const row = sdb.listUnmapped()[0];
  assert.strictEqual(row.autoShopId, 0, '歧义时不得猜其中一家');
  assert.strictEqual(row.autoShopName, '');
});

check('已归一的名称即使文本仍在，也不出现在名单里（判定按映射表，不按"有同名店"）', () => {
  reset();
  const a = sdb.upsertShop(shopInput({ platform: 'ae', name: '甲店' }));
  const b = sdb.upsertShop(shopInput({ platform: 'amazon', name: '甲店' }));
  seedOrders(['甲店']);
  // 有歧义 → 无提示；显式指派到 b 之后必须消失（说明用的是映射表而非自动命中）
  assert.strictEqual(sdb.listUnmapped()[0].autoShopId, 0);
  sdb.mapName({ raw: '甲店', refId: b.id, ignored: false });
  assert.deepStrictEqual(sdb.listUnmapped(), []);
  assert.strictEqual(sdb.getShop(b.id).aliasCount, 1);
  assert.strictEqual(sdb.getShop(a.id).aliasCount, 0);
});

check('映射过期可观测：名称在文本里消失后 stats.names.stale +1', () => {
  reset();
  const { id } = sdb.upsertShop(shopInput({ name: '店A' }));
  seedOrders(['店A']);
  sdb.mapName({ raw: '店A', refId: id, ignored: false });
  assert.strictEqual(sdb.shopSummary().names.stale, 0);
  dbRun(`DELETE FROM oi_orders`);
  assert.strictEqual(sdb.shopSummary().names.stale, 1, '文本消失后映射应被标为过期');
  assert.strictEqual(sdb.shopSummary().names.total, 0);
});

check('归一入参消毒：kind 白名单兜底 + 空名称抛错', () => {
  reset();
  const { id } = sdb.upsertShop(shopInput({ name: '店A' }));
  assert.throws(() => sdb.mapName({ raw: '   ', refId: id, ignored: false }), /不能为空/);
  // 非法 kind 兜底成 shop（不抛错），且不越界写别的表格
  const r = sdb.mapName({ raw: '店A', refId: id, ignored: false, kind: '不存在的类型' });
  assert.strictEqual(r.key, '店A');
  assert.strictEqual(dbGet(`SELECT kind FROM sk_name_map WHERE raw_key = '店A'`).kind, 'shop');
  assert.throws(() => sdb.mapName({ raw: '店B', refId: id, ignored: false, kind: 'supplier' }), /暂不支持/);
});

// ---- 删除保护：记账引用 ----
//
// 判据在 `electron/shop-delete-guard.ts`（编排层），不是 handler —— 冒烟调的是线上同一份函数，
// 否则只能断言文案、测不到"有引用时到底会不会删"。两类引用都要拦：
//   · 专属条目（`bk_entries.shop_id`）—— 这一笔收支只属于这家店，删店就让历史数字无处可看；
//   · 公共分摊行（`bk_allocations.shop_id`）—— 公共支出的其中一份摊给了这家店。
// 作废条目同样算引用：作废只是把状态改掉，列表里仍按店名展示历史，删店会让那一行失去归属。
check('删除保护：有记账引用（专属条目 / 公共分摊 / 已作废）时拒绝删除，无引用时可删', () => {
  reset();
  const a = adb.upsertShopAccount({ name: '账目店A' });
  const b = adb.upsertShopAccount({ name: '账目店B' });

  dbRun(
    `INSERT INTO bk_entries (biz_date, kind, scope, shop_id, party_id, amount_cents)
     VALUES ('2026-10-05','expense','shop', ?, 1, 1000)`,
    [a.id],
  );
  assert.throws(
    () => deleteShopAccountGuarded(a.id),
    /1 条收支[\s\S]*请改为「停用」/,
    '有专属条目的店必须拒绝删除，并引导改用停用',
  );
  assert.strictEqual(list({ search: '账目店A' }).total, 1, '拒绝时不许真的把店删掉');

  // 公共分摊：条目本身 shop_id = 0，只有分摊行指向 B —— 两类引用分别可达。
  const shared = dbRun(
    `INSERT INTO bk_entries (biz_date, kind, scope, party_id, amount_cents, basis)
     VALUES ('2026-10-06','expense','shared', 1, 500, 'equal')`,
  );
  dbRun(
    `INSERT INTO bk_allocations (entry_id, shop_id, amount_cents, ratio_bp) VALUES (?, ?, 500, 10000)`,
    [shared.lastInsertRowid, b.id],
  );
  assert.throws(
    () => deleteShopAccountGuarded(b.id),
    /1 条公共分摊/,
    '被公共支出摊到的店同样必须拒绝删除（它的账目在分摊表里）',
  );

  // 作废条目仍是引用（历史列表按店名展示），不是"可以删了"。
  const c = adb.upsertShopAccount({ name: '作废店C' });
  dbRun(
    `INSERT INTO bk_entries (biz_date, kind, scope, shop_id, party_id, amount_cents, status)
     VALUES ('2026-10-07','expense','shop', ?, 1, 800, 'void')`,
    [c.id],
  );
  assert.throws(() => deleteShopAccountGuarded(c.id), /1 条收支/, '已作废条目也算历史引用');

  // 正控制：没有任何引用的店必须能删 —— 否则上面两条的"拒绝"可能只是"全都删不了"。
  const clean = adb.upsertShopAccount({ name: '无账目店' });
  assert.deepStrictEqual(deleteShopAccountGuarded(clean.id), { deleted: true });
  assert.strictEqual(list({ search: '无账目店' }).total, 0, '无引用的店应被真正删除');
});

// ---- 收尾 ----

closeDb();
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  /* 临时目录清理失败不影响结论 */
}

console.log('\u2500'.repeat(64));
if (failed) {
  console.log(`\u2717 店铺实体数据层冒烟失败：${failed} 项\n`);
  process.exit(1);
}
console.log(`\u2713 店铺实体数据层冒烟全部通过\n`);
// 显式退出：不写的话进程靠 Electron 在无 GUI 环境里崩退（stderr 打一屏 GPU/sandbox 报错，
// 退出码是 SIGTRAP），看起来像冒烟失败，且在有窗口环境的机器上会一直挂着不返回。
process.exit(0);
