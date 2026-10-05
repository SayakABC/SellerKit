// 店铺实体（sk_shops / sk_name_map）数据层冒烟（不启动 Electron 界面）。
//
//   npm run shop:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/shop-db-smoke.cjs
//
// 为什么不用 vitest：better-sqlite3 按 **Electron 的 Node ABI**（149）编译，vitest 跑在系统 Node（127），
// require 时直接抛 ABI 不匹配。故 DB 层统一走冒烟；纯函数的归一逻辑另在
// `tests/shopName.spec.ts`（15 例）里覆盖。
//
// 覆盖 S1 的核心不变量：
//   · 归一只做「去空白 + 剥不可见字符」—— 肉眼一样的写法必须归成一个键，不同名必须不合并
//   · `sk_shops` 的 UNIQUE 建在**归一键**上（否则 "店A" 与 "店A " 能同时入库 → 精确命中立刻有歧义）
//   · 未归一名单是**实时聚合**三处历史文本，不是会被放陈的缓存表
//   · 不猜歧义：同名命中多家店时不给"精确命中"提示
//   · 指到不存在的店必须抛错，不静默写成"未归一"
// 每个用例自带 reset()：避免上一条的种子数据让下一条"新增"报重复键，产生假失败。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-shop-smoke-'));

const { initDb, closeDb, dbRun, dbQuery, dbGet } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
const sdb = require(path.join(ROOT, 'dist', 'electron', 'shop-db.js'));
const { toNameKey } = require(path.join(ROOT, 'dist', 'electron', 'shopName.js'));

initDb(path.join(dir, 'smoke.db'));
sdb.ensureShopSchema();

// 三个历史文本来源 + 账号套装（shop_set_id 是软关联，这里只为"不越界"建最小同构表）
dbRun(`CREATE TABLE IF NOT EXISTS oi_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, shop TEXT NOT NULL DEFAULT '')`);
dbRun(`CREATE TABLE IF NOT EXISTS purchase_sources (id INTEGER PRIMARY KEY AUTOINCREMENT, shop TEXT NOT NULL DEFAULT '')`);
dbRun(`CREATE TABLE IF NOT EXISTS ae_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, shop_name TEXT NOT NULL DEFAULT '')`);
dbRun(`CREATE TABLE IF NOT EXISTS sk_shop_sets (id INTEGER PRIMARY KEY AUTOINCREMENT, email TEXT NOT NULL DEFAULT '')`);

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
  for (const t of ['sk_shops', 'sk_name_map', 'oi_orders', 'purchase_sources', 'ae_orders', 'sk_shop_sets']) {
    dbRun(`DELETE FROM ${t}`);
  }
};

/** 全量入参（upsert 是全量提交语义） */
const shopInput = (over = {}) => ({
  id: 0,
  platform: 'ae',
  name: '深圳优选店',
  platformShopId: '',
  site: 'RU',
  shopSetId: 0,
  status: 'active',
  openedAt: '',
  note: '',
  ...over,
});

/** 往三处文本各塞若干行 */
const seedOrders = (rows) => {
  for (const s of rows) dbRun(`INSERT INTO oi_orders (shop) VALUES (?)`, [s]);
};
const seedPurchase = (rows) => {
  for (const s of rows) dbRun(`INSERT INTO purchase_sources (shop) VALUES (?)`, [s]);
};
const seedAe = (rows) => {
  for (const s of rows) dbRun(`INSERT INTO ae_orders (shop_name) VALUES (?)`, [s]);
};

const keys = (rows) => rows.map((r) => r.key);
const list = (p = {}) =>
  sdb.listShops({ offset: 0, limit: 50, search: '', platform: '', status: '', shopSetId: 0, ...p });

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

// ⚠️ 这条必须**造一张老版本的表**来测，不能用本脚本的库直接测：
// 本脚本的 `sk_shops` 是 `ensureShopSchema()` 现建的，建表语句里已含新列 ——
// 于是 `ALTER` 那条分支**一次都不会执行**，写成什么样都恒绿。
// 这是"用干净环境测"的典型盲区（记忆里那条：新建的库没有历史状态，必然全绿）。
check('老库迁移：没有 platform_shop_id 列的表能被 ALTER 补上（新建库测不出这条）', () => {
  dbRun(`DROP TABLE IF EXISTS sk_shops`);
  dbRun(`CREATE TABLE sk_shops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    site TEXT NOT NULL DEFAULT '',
    shop_set_id INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    opened_at TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(platform, name_key)
  )`);
  dbRun(`INSERT INTO sk_shops (platform, name, name_key, note) VALUES ('ae', '老店', '老店', '迁移前的行')`);

  const before = dbQuery(`PRAGMA table_info(sk_shops)`).map((r) => r.name);
  assert.ok(!before.includes('platform_shop_id'), '前置条件：老表本来就不该有这一列');

  sdb.ensureShopSchema();

  const after = dbQuery(`PRAGMA table_info(sk_shops)`).map((r) => r.name);
  assert.ok(after.includes('platform_shop_id'), 'ensure 应把新列补上');
  // 老数据不丢，且新列回落空串（不是 NULL）—— NULL 会让 `<> ''` 的部分索引漏掉它
  const row = dbGet(`SELECT name, note, platform_shop_id FROM sk_shops WHERE name_key = '老店'`);
  assert.strictEqual(row.note, '迁移前的行', '补列不得丢数据');
  assert.strictEqual(row.platform_shop_id, '', '补列后旧行应为空串，不是 NULL');
  // 幂等：连跑两次不再 ALTER、不报错
  sdb.ensureShopSchema();
  sdb.ensureShopSchema();
  assert.strictEqual(
    dbQuery(`SELECT COUNT(*) AS c FROM sk_shops`)[0].c,
    1,
    '幂等迁移不得产生额外行'
  );
  reset();
});

// ---- 三处文本的聚合 ----

check('三处历史文本都被汇总进未归一名单', () => {
  reset();
  seedOrders(['甲店']);
  seedPurchase(['乙店']);
  seedAe(['丙店']);
  const rows = sdb.listUnmapped();
  assert.deepStrictEqual(keys(rows).sort(), ['丙店', '乙店', '甲店'].sort());
  assert.deepStrictEqual(rows.find((r) => r.key === '甲店').sources, ['order']);
  assert.deepStrictEqual(rows.find((r) => r.key === '乙店').sources, ['purchase']);
  assert.deepStrictEqual(rows.find((r) => r.key === '丙店').sources, ['ae']);
});

check('验收原文：未归一名单覆盖 oi_orders 的每一个店铺名（逐条，且计数一致）', () => {
  reset();
  seedOrders(['A店', 'A店', 'B店', '  B店  ', 'C店\u3000']);
  // 另两处是子集：此时"未归一名单条数"应与 DISTINCT shop 数完全一致
  seedPurchase(['A店']);
  seedAe(['B店']);
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
  // 这五个都是同一个名字（首尾空白 / 零宽 / BOM / 全角空格在**名字外部**）
  seedOrders(['店A', ' 店A ', '店A\u200b']);
  seedPurchase(['店A']);
  seedAe(['\ufeff店A', '店A']);
  const rows = sdb.listUnmapped();
  assert.strictEqual(rows.length, 1, `期望合成 1 条，实际 ${rows.length}`);
  assert.strictEqual(rows[0].key, '店A');
  assert.strictEqual(rows[0].occurrences, 6, `条数应为 6，实际 ${rows[0].occurrences}`);
  assert.deepStrictEqual(rows[0].sources.sort(), ['ae', 'order', 'purchase'].sort());
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
  dbRun('DROP TABLE ae_orders');
  try {
    assert.strictEqual(sdb.listUnmapped().length, 1);
    assert.strictEqual(sdb.shopSummary().names.total, 1);
  } finally {
    dbRun(`CREATE TABLE IF NOT EXISTS ae_orders (id INTEGER PRIMARY KEY AUTOINCREMENT, shop_name TEXT NOT NULL DEFAULT '')`);
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

// ---- 平台店铺标识（platform_shop_id；2026-09-27 新增）----
// 这个字段的价值**不在"关联订单"** —— 三处历史文本（订单/采购/利润）与账号套装都没有标识列
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

check(`按 shopSetId 过滤：只看某个账号套装名下的店；0 是"不过滤"而不是"只看未关联"`, () => {
  reset();
  sdb.upsertShop(shopInput({ name: '甲店', shopSetId: 7 }));
  sdb.upsertShop(shopInput({ name: '乙店', shopSetId: 7 }));
  sdb.upsertShop(shopInput({ name: '丙店', shopSetId: 0 }));
  assert.strictEqual(list({ shopSetId: 7 }).total, 2);
  assert.strictEqual(list({ shopSetId: 8 }).total, 0, '没挂店铺的套装应为 0（而不是回落成不过滤）');
  assert.strictEqual(list({ shopSetId: 0 }).total, 3, 'shopSetId=0 是"不过滤"');
});

check('标识可清空（全量提交语义下传空串即清空）', () => {
  reset();
  const { id } = sdb.upsertShop(shopInput({ name: '甲店', platformShopId: 'SID-1' }));
  sdb.upsertShop(shopInput({ id, name: '甲店', platformShopId: '' }));
  assert.strictEqual(sdb.getShop(id).platformShopId, '');
});

check('全量提交陷阱：更新时忘记带标识 = 标识被清空（所以界面上必须回填原值）', () => {
  reset();
  const { id } = sdb.upsertShop(shopInput({ name: '甲店', platformShopId: 'SID-1' }));
  sdb.upsertShop(shopInput({ id, name: '甲店改名' })); // 故意不带 platformShopId
  const row = sdb.getShop(id);
  assert.strictEqual(row.name, '甲店改名');
  assert.strictEqual(row.platformShopId, '', '缺省即空是全量提交的定义行为 —— 钉住它，提醒界面回填');
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
