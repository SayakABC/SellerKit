// 成本口径（P4a / D5）冒烟：ae_cost_map 多行 + 生效区间 + 手工成本不被对账导入清掉。
//
// 为什么不用 vitest：better-sqlite3 按 **Electron 的 Node ABI** 编译，vitest 跑在系统 Node 上会
// 直接抛 ABI 不匹配 —— 与 order-db / ae-db / purchase-db / product-db 一致，DB 层统一走本冒烟。
//
//   npm run ae:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/ae-cost-smoke.cjs
//
// 覆盖「改造前会静默出错」的几处：
//   ① 老库（`style_code TEXT PRIMARY KEY`）迁移后行数与价格不变、并补上基准生效日；
//   ② `costMapReplace` 只清 source='purchase'，**手工成本不被下一次拿货对账导入抹掉**（D5 的原始触发事实）；
//   ③ 快照源头按 (款, 拿货日期) 分组 —— 否则一款永远只导出一行区间，跨次进货的历史毛利复算不出来；
//   ④ 利润引擎按订单业务日期取区间成本；同生效日 manual 优先；无区间命中回落最早一条。
//
// 库文件落在临时目录，不污染真实 userData。每个用例自带 reset：用例之间不留数据。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-ae-cost-smoke-'));

const { initDb, closeDb, dbRun, dbQuery } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
const adb = require(path.join(ROOT, 'dist', 'electron', 'ae-db.js'));
const aeEngine = require(path.join(ROOT, 'dist', 'electron', 'ae-engine.js'));
const purchaseDb = require(path.join(ROOT, 'dist', 'electron', 'purchase-db.js'));
const costSync = require(path.join(ROOT, 'dist', 'electron', 'purchase-cost-sync.js'));

let failed = 0;
let passed = 0;
function check(name, fn) {
  try {
    fn();
    passed += 1;
    console.log(`  \u2713 ${name}`);
  } catch (err) {
    failed += 1;
    console.log(`  \u2717 ${name}`);
    console.log(`      ${err && err.message ? err.message : String(err)}`);
  }
}

/** 相对今天的日期（yyyy-mm-dd）。用例统一用相对日，避免写死日期后随时间失效 */
function daysAgo(n) {
  const d = new Date();
  d.setDate(d.getDate() - n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

// ===================================================================================
// 一、老库迁移：先建「改造前」的表结构与数据，再跑 ensureAeSchema，验证零丢失
// ===================================================================================

console.log('\n[1] 老库迁移（旧主键 → 多行 + 生效区间）');

const legacyDb = path.join(dir, 'legacy.db');
initDb(legacyDb);
// 旧的 ae_cost_map 形状：一款一行，没有 effective_from
dbRun(`CREATE TABLE ae_cost_map (
  style_code TEXT PRIMARY KEY,
  style_name TEXT NOT NULL DEFAULT '',
  unit_price_cents INTEGER NOT NULL DEFAULT 0,
  sample_count INTEGER NOT NULL DEFAULT 0,
  last_biz_date TEXT NOT NULL DEFAULT '',
  source TEXT NOT NULL DEFAULT 'purchase',
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
)`);
dbRun(`INSERT INTO ae_cost_map (style_code, style_name, unit_price_cents, sample_count, last_biz_date, source) VALUES
  ('OLD-1', '旧款一', 1234, 7, ?, 'purchase'),
  ('OLD-2', '旧款二', 5678, 3, ?, 'manual')`, [daysAgo(500), daysAgo(300)]);

adb.ensureAeSchema();

check('迁移后列含 effective_from', () => {
  const cols = dbQuery(`PRAGMA table_info(ae_cost_map)`).map((c) => c.name);
  assert.ok(cols.includes('effective_from'), `实际列：${cols.join(', ')}`);
});

check('迁移不丢行、价格与来源原样保留', () => {
  const rows = dbQuery(`SELECT * FROM ae_cost_map ORDER BY style_code`);
  assert.strictEqual(rows.length, 2, `期望 2 行，实际 ${rows.length}`);
  assert.strictEqual(rows[0].style_code, 'OLD-1');
  assert.strictEqual(rows[0].unit_price_cents, 1234);
  assert.strictEqual(rows[0].source, 'purchase');
  assert.strictEqual(rows[1].style_code, 'OLD-2');
  assert.strictEqual(rows[1].unit_price_cents, 5678);
  assert.strictEqual(rows[1].source, 'manual', '手工来源必须原样保留，不能被迁移改写成 purchase');
});

check('存量行补基准生效日（早于任何真实业务日，保证迁移瞬间历史订单毛利不变）', () => {
  const rows = dbQuery(`SELECT DISTINCT effective_from AS ef FROM ae_cost_map`);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].ef, '0000-01-01');
});

check('ensureAeSchema 幂等：重复调用不重复迁、不丢行', () => {
  adb.ensureAeSchema();
  adb.ensureAeSchema();
  const n = dbQuery(`SELECT COUNT(*) AS n FROM ae_cost_map`)[0].n;
  assert.strictEqual(n, 2, `期望仍 2 行，实际 ${n}`);
  const leftover = dbQuery(`SELECT name FROM sqlite_master WHERE type='table' AND name LIKE '%legacy%'`);
  assert.strictEqual(leftover.length, 0, `迁移中间表未清理：${JSON.stringify(leftover)}`);
});

check('迁移后主键含 source：同 (款, 生效日) 上 manual 与 purchase 可并存', () => {
  dbRun(`INSERT INTO ae_cost_map (style_code, effective_from, source, unit_price_cents) VALUES ('OLD-1','0000-01-01','manual', 999)`);
  const n = dbQuery(`SELECT COUNT(*) AS n FROM ae_cost_map WHERE style_code='OLD-1' AND effective_from='0000-01-01'`)[0].n;
  assert.strictEqual(n, 2, '同一 (款, 生效日) 应能放下 manual + purchase 两行');
});

// ===================================================================================
// 二、全新库：写入语义 + 快照源头 + 引擎取数
// ===================================================================================

closeDb();
const freshDb = path.join(dir, 'fresh.db');
initDb(freshDb);
adb.ensureAeSchema();

// 采购域最小同构表（只为 costSnapshot 的 JOIN 与状态过滤提供结构，字段名与真实表一致）
dbRun(`CREATE TABLE purchase_orders (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  supplier_id INTEGER NOT NULL DEFAULT 0,
  biz_date TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'draft'
)`);
dbRun(`CREATE TABLE purchase_items (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  purchase_id INTEGER NOT NULL,
  style_code TEXT NOT NULL DEFAULT '',
  style_name TEXT NOT NULL DEFAULT '',
  color TEXT NOT NULL DEFAULT '',
  qty INTEGER NOT NULL DEFAULT 0,
  price_cents INTEGER NOT NULL DEFAULT 0,
  amount_cents INTEGER NOT NULL DEFAULT 0
)`);

const D_400 = daysAgo(400);
const D_200 = daysAgo(200);
const D_100 = daysAgo(100);

function seedPurchases() {
  dbRun(`DELETE FROM purchase_items`);
  dbRun(`DELETE FROM purchase_orders`);
  dbRun(`INSERT INTO purchase_orders (id, biz_date, status) VALUES (1, ?, 'submitted'), (2, ?, 'submitted'), (3, ?, 'draft')`, [D_400, D_200, daysAgo(150)]);
  dbRun(`INSERT INTO purchase_items (purchase_id, style_code, style_name, qty, price_cents, amount_cents) VALUES
    (1, 'A', '款A', 10,  100, 1000),
    (2, 'A', '款A',  5,  300, 1500),
    (3, 'A', '款A', 99,    1,   99)`);
}

function resetCost() {
  dbRun(`DELETE FROM ae_cost_map`);
  dbRun(`DELETE FROM ae_rates`);
}
/** 引擎跑一遍，按订单号取成本（CNY） */
function costOf(orderId, rangeDays = 3650) {
  const ov = aeEngine.getProfitOverview({ granularity: 'month', rangeDays });
  const row = ov.topOrders.find((o) => o.orderId === orderId);
  assert.ok(row, `TOP 订单里没有 ${orderId}（可能是 rangeDays 过滤掉了）`);
  return row.costCny;
}

function seedOrder(orderId, styleCode, orderTime) {
  dbRun(
    `INSERT INTO ae_orders (order_id, order_time, status, currency, goods_amount, shipping_income) VALUES (?,?,'finished','CNY',100,0)`,
    [orderId, orderTime],
  );
  const id = dbQuery(`SELECT id FROM ae_orders WHERE order_id = ?`, [orderId])[0].id;
  dbRun(`INSERT INTO ae_order_lines (ae_order_id, style_code, title, qty) VALUES (?,?,?,1)`, [id, styleCode, `款${styleCode}`]);
}

console.log('\n[2] 快照源头按 (款, 拿货日期) 分组');

check('同款两次进货导出两行（而非 MAX 聚合的一行）；非 submitted 单被排除', () => {
  seedPurchases();
  const snap = purchaseDb.costSnapshot();
  assert.strictEqual(snap.length, 2, `期望 2 行（款A 两个拿货日），实际 ${JSON.stringify(snap)}`);
  assert.deepStrictEqual(
    snap.map((s) => [s.styleCode, s.lastBizDate, s.weightedPriceCents]),
    [
      ['A', D_400, 100],
      ['A', D_200, 300],
    ],
  );
  assert.ok(
    snap.every((s) => s.weightedPriceCents !== 1),
    'draft 单的 1 分/件被混进来了 —— 状态过滤失效',
  );
});

console.log('\n[3] 导入语义：采购行可替换，手工行永不被盖');

check('costMapReplace 不清 source=manual 的行', () => {
  resetCost();
  adb.costMapUpsertManual([{ styleCode: 'A', styleName: '款A', unitPriceCents: 700, sampleCount: 0, effectiveFrom: D_200, lastBizDate: D_200 }]);
  adb.costMapReplace([{ styleCode: 'A', styleName: '款A', unitPriceCents: 300, sampleCount: 5, lastBizDate: D_200 }]);
  const rows = adb.costMapList().filter((r) => r.styleCode === 'A');
  const manual = rows.filter((r) => r.source === 'manual');
  assert.strictEqual(manual.length, 1, `手工行被对账导入清掉了：${JSON.stringify(rows)}`);
  assert.strictEqual(manual[0].unitPriceCents, 700);
  assert.strictEqual(rows.filter((r) => r.source === 'purchase').length, 1);
});

check('重复导入不产生重复行（同 (款, 生效日, 来源) 覆盖写）', () => {
  resetCost();
  const item = { styleCode: 'A', styleName: '款A', unitPriceCents: 300, sampleCount: 5, lastBizDate: D_200 };
  adb.costMapReplace([item]);
  adb.costMapReplace([{ ...item, unitPriceCents: 350 }]);
  const rows = adb.costMapList().filter((r) => r.styleCode === 'A');
  assert.strictEqual(rows.length, 1, `期望 1 行，实际 ${rows.length}`);
  assert.strictEqual(rows[0].unitPriceCents, 350, '第二次导入应覆盖第一次');
});

check('costMapList 暴露 effectiveFrom（界面要显示"这行从哪天生效"）', () => {
  resetCost();
  adb.costMapReplace([{ styleCode: 'A', styleName: '款A', unitPriceCents: 300, sampleCount: 5, lastBizDate: D_200 }]);
  assert.strictEqual(adb.costMapList()[0].effectiveFrom, D_200);
});

check('生效日缺省回落 lastBizDate；两者都空则用基准日', () => {
  resetCost();
  adb.costMapReplace([{ styleCode: 'A', styleName: '款A', unitPriceCents: 300, sampleCount: 5, lastBizDate: '' }]);
  assert.strictEqual(adb.costMapList()[0].effectiveFrom, '0000-01-01');
});

console.log('\n[4] 利润引擎按订单业务日期取成本');

check('同一款跨两次进货：两笔订单各按当时成本', () => {
  resetCost();
  dbRun(`DELETE FROM ae_order_lines`);
  dbRun(`DELETE FROM ae_orders`);
  seedPurchases();
  adb.costMapReplace(
    purchaseDb.costSnapshot().map((s) => ({
      styleCode: s.styleCode,
      styleName: s.styleName,
      unitPriceCents: s.weightedPriceCents,
      sampleCount: s.sampleCount,
      lastBizDate: s.lastBizDate,
    })),
  );
  // 早单落在 100 分/件区间（D_400 之后、D_200 之前），晚单落在 300 分/件区间
  seedOrder('O-OLD', 'A', daysAgo(300));
  seedOrder('O-NEW', 'A', daysAgo(100));
  assert.strictEqual(costOf('O-OLD'), 1, '早单应按 100 分/件的当期成本（1.00 CNY）');
  assert.strictEqual(costOf('O-NEW'), 3, '晚单应按 300 分/件的当期成本（3.00 CNY）');
});

check('同 (款, 生效日) 上 manual 优先于 purchase', () => {
  adb.costMapUpsertManual([{ styleCode: 'A', styleName: '款A', unitPriceCents: 700, sampleCount: 0, effectiveFrom: D_200, lastBizDate: D_200 }]);
  assert.strictEqual(costOf('O-NEW'), 7, '用户在界面上改过的价（manual）必须赢过导入价（purchase）');
  assert.strictEqual(costOf('O-OLD'), 1, '早单不受影响，仍取它自己的区间');
});

check('手工改价后再导入一次对账快照：手工价仍生效（D5 的原始症状不复发）', () => {
  seedPurchases();
  adb.costMapReplace(
    purchaseDb.costSnapshot().map((s) => ({
      styleCode: s.styleCode,
      styleName: s.styleName,
      unitPriceCents: s.weightedPriceCents,
      sampleCount: s.sampleCount,
      lastBizDate: s.lastBizDate,
    })),
  );
  assert.strictEqual(costOf('O-NEW'), 7);
});

check('订单日早于该款最早进货日：回落最早一条，不判成缺成本', () => {
  resetCost();
  dbRun(`DELETE FROM ae_order_lines`);
  dbRun(`DELETE FROM ae_orders`);
  adb.costMapReplace([{ styleCode: 'A', styleName: '款A', unitPriceCents: 500, sampleCount: 3, lastBizDate: D_200 }]);
  seedOrder('O-EARLY', 'A', D_400);
  assert.strictEqual(costOf('O-EARLY'), 5, '应回落最早区间（5.00 CNY），而不是成本缺失');
});

check('该款无任何成本行：仍记为缺成本，不凭空造数', () => {
  resetCost();
  dbRun(`DELETE FROM ae_order_lines`);
  dbRun(`DELETE FROM ae_orders`);
  seedOrder('O-NOCOST', 'ZZZ', D_100);
  const ov = aeEngine.getProfitOverview({ granularity: 'month', rangeDays: 3650 });
  assert.strictEqual(costOf('O-NOCOST'), 0);
  assert.strictEqual(ov.coverage.matchedLines, 0, `matchedLines 应为 0，实际 ${ov.coverage.matchedLines}`);
  assert.strictEqual(ov.coverage.codeLines, 1, '有编码但未命中，仍计入 codeLines（覆盖率提示用）');
});

check('汇率变化不影响已按区间取到的成本', () => {
  resetCost();
  dbRun(`DELETE FROM ae_order_lines`);
  dbRun(`DELETE FROM ae_orders`);
  adb.costMapReplace([{ styleCode: 'A', styleName: '款A', unitPriceCents: 200, sampleCount: 1, lastBizDate: D_400 }]);
  seedOrder('O-CNY', 'A', D_100);
  const before = costOf('O-CNY');
  dbRun(`INSERT INTO ae_rates (from_currency, rate_to_cny) VALUES ('USD', 7.2) ON CONFLICT(from_currency) DO UPDATE SET rate_to_cny = 9.9`);
  assert.strictEqual(costOf('O-CNY'), before);
  assert.strictEqual(before, 2);
});

console.log('\n[4.5] 拿货落账 → 成本自动同步（S3：用户不再手动点"导入成本"）');

check('落账后成本表出现 purchase 行，且 effective_from = 该行拿货日期（历史可复算）', () => {
  resetCost();
  dbRun(`DELETE FROM ae_cost_map`);
  seedPurchases(); // 款A 两个拿货日（见 [2]）
  const r = costSync.syncPurchaseCosts();
  assert.ok(r.replaced >= 1, `应至少替换 1 行，实为 ${r.replaced}`);
  const rows = dbQuery(`SELECT style_code, source, effective_from, unit_price_cents FROM ae_cost_map ORDER BY effective_from`);
  assert.ok(rows.length >= 1);
  assert.ok(rows.every((x) => x.source === 'purchase'));
  assert.ok(rows.every((x) => x.effective_from && x.effective_from !== '0000-01-01'), '生效日必须取真实拿货日期');
});

check('同步**不碰**手工改过的价（source=manual）—— 自动同步不该覆盖人的决定', () => {
  dbRun(`DELETE FROM ae_cost_map`);
  seedPurchases();
  adb.costMapUpsertManual([{ styleCode: 'A', styleName: '款A', unitPriceCents: 999, sampleCount: 1, lastBizDate: D_100, effectiveFrom: D_100 }]);
  costSync.syncPurchaseCosts();
  const manual = dbQuery(`SELECT unit_price_cents FROM ae_cost_map WHERE style_code='A' AND source='manual'`);
  assert.strictEqual(manual.length, 1, '手工行必须还在');
  assert.strictEqual(Number(manual[0].unit_price_cents), 999);
});

console.log('\n[4.6] 手工进价落 ae_cost_map（manual-costs.applyManualCosts，2026-10-09）');

const manualCosts = require(path.join(ROOT, 'dist', 'electron', 'manual-costs.js'));

/** 本段自带 reset：用例之间不留数据 */
function resetManualCost() {
  resetCost();
  dbRun(`DELETE FROM ae_cost_map`);
}

check('导入进价 → 写 manual 行，生效日 = 传入的导入当日', () => {
  resetManualCost();
  const r = manualCosts.applyManualCosts([{ code: 'P-1', name: '收纳箱', costCents: 1234 }], D_100);
  assert.strictEqual(r.written, 1);
  assert.strictEqual(r.skipped, 0);
  const rows = dbQuery(`SELECT style_code, source, effective_from, unit_price_cents FROM ae_cost_map`);
  assert.strictEqual(rows.length, 1);
  assert.strictEqual(rows[0].style_code, 'P-1');
  assert.strictEqual(rows[0].source, 'manual');
  assert.strictEqual(rows[0].effective_from, D_100);
  assert.strictEqual(Number(rows[0].unit_price_cents), 1234);
});

check('⭐ 幂等：值没变再导一次 → 不新增区间行（否则"导出→原样导回"每天膨胀一行）', () => {
  resetManualCost();
  manualCosts.applyManualCosts([{ code: 'P-1', costCents: 1234 }], D_100);
  const r = manualCosts.applyManualCosts([{ code: 'P-1', costCents: 1234 }], D_400);
  assert.strictEqual(r.written, 0, '值一样就不该写');
  assert.strictEqual(r.skipped, 1);
  assert.strictEqual(Number(dbQuery(`SELECT COUNT(*) AS c FROM ae_cost_map`)[0].c), 1);
});

check('改价 → 新增一条区间行（历史订单仍按旧区间复算，改价不改历史）', () => {
  resetManualCost();
  manualCosts.applyManualCosts([{ code: 'P-1', costCents: 1234 }], D_400);
  const r = manualCosts.applyManualCosts([{ code: 'P-1', costCents: 2000 }], D_100);
  assert.strictEqual(r.written, 1);
  const rows = dbQuery(`SELECT effective_from, unit_price_cents FROM ae_cost_map ORDER BY effective_from`);
  assert.strictEqual(rows.length, 2, '两次不同价 = 两条区间');
  assert.strictEqual(Number(rows[0].unit_price_cents), 1234); // D_400 更早
  assert.strictEqual(Number(rows[1].unit_price_cents), 2000);
});

check('无效行（空编码 / 非数字）跳过，不写进成本表', () => {
  resetManualCost();
  const r = manualCosts.applyManualCosts(
    [{ code: '', costCents: 100 }, { code: 'P-9', costCents: Number.NaN }],
    D_100,
  );
  assert.strictEqual(r.written, 0);
  assert.strictEqual(Number(dbQuery(`SELECT COUNT(*) AS c FROM ae_cost_map`)[0].c), 0);
});

check('手工进价与拿货自动同步**并存**（两个来源都在，读取侧 manual 优先）', () => {
  resetManualCost();
  dbRun(
    `INSERT INTO ae_cost_map (style_code, effective_from, source, style_name, unit_price_cents, sample_count, last_biz_date)
     VALUES ('P-1', ?, 'purchase', '', 300, 1, ?)`,
    [D_100, D_100],
  );
  manualCosts.applyManualCosts([{ code: 'P-1', costCents: 1234 }], D_400);
  const rows = dbQuery(`SELECT source FROM ae_cost_map WHERE style_code='P-1' ORDER BY source`);
  assert.deepStrictEqual(rows.map((x) => x.source), ['manual', 'purchase']);
});

check('删除手工区间 → 那条消失（读取回落到更早的区间）', () => {
  resetManualCost();
  manualCosts.applyManualCosts([{ code: 'P-1', costCents: 1000 }], D_400);
  manualCosts.applyManualCosts([{ code: 'P-1', costCents: 2000 }], D_100);
  const del = adb.costMapDeleteManual([{ styleCode: 'P-1', effectiveFrom: D_100 }]);
  assert.strictEqual(del.deleted, 1);
  const rows = dbQuery(`SELECT effective_from, unit_price_cents FROM ae_cost_map WHERE style_code='P-1'`);
  assert.strictEqual(rows.length, 1, '只该剩更早的那条');
  assert.strictEqual(rows[0].effective_from, D_400);
  assert.strictEqual(Number(rows[0].unit_price_cents), 1000);
});

check('⭐ 删除**不动**拿货对账的价（只删 manual）—— 删了下次落账同步也会原样写回来', () => {
  resetManualCost();
  dbRun(
    `INSERT INTO ae_cost_map (style_code, effective_from, source, style_name, unit_price_cents, sample_count, last_biz_date)
     VALUES ('P-1', ?, 'purchase', '', 300, 1, ?)`,
    [D_100, D_100],
  );
  const del = adb.costMapDeleteManual([{ styleCode: 'P-1', effectiveFrom: D_100 }]);
  assert.strictEqual(del.deleted, 0, 'purchase 行不该被删掉');
  assert.strictEqual(Number(dbQuery(`SELECT COUNT(*) AS c FROM ae_cost_map`)[0].c), 1);
});

check('删不存在的区间 → deleted=0（不是错误，重复点删除不该报红）', () => {
  resetManualCost();
  const del = adb.costMapDeleteManual([{ styleCode: 'P-404', effectiveFrom: D_100 }]);
  assert.strictEqual(del.deleted, 0);
});

console.log('\n[5] 采集订单 → 写入**唯一订单主干**（C1 合并的写侧）');

/** 造一帧"采集来"的订单（形状＝扩展推送的 AeIngestOrder） */
function frame(orderId, opts = {}) {
  return {
    orderId,
    shopName: opts.shopName ?? '',
    orderTime: opts.orderTime ?? D_100,
    status: opts.status ?? '交易完成',
    currency: opts.currency ?? 'CNY',
    goodsAmount: opts.goodsAmount ?? 398.16,
    shippingIncome: opts.shippingIncome ?? 12,
    lines: opts.lines ?? [
      { productId: '', skuProps: 'Picture color+XXXL+China Mainland', qty: 1 },
      { productId: '', skuProps: 'Picture color+L+China Mainland', qty: 2 },
    ],
  };
}
function resetSpine() {
  // 本冒烟只建了 ae 域的表 → 主干所在的订单域要显式建起来（幂等）
  require(path.join(ROOT, 'dist', 'electron', 'order-db.js')).ensureOrderSchema();
  dbRun(`DELETE FROM ae_order_lines`);
  dbRun(`DELETE FROM ae_orders`);
  dbRun(`DELETE FROM oi_orders`);
  dbRun(`DELETE FROM ae_rates WHERE from_currency <> 'CNY'`);
}
/** 主干里的采集行（走的是**页面用的那个读口**，不是另写一段 SQL） */
function spineRows(source) {
  return require(path.join(ROOT, 'dist', 'electron', 'order-db.js')).shippingRows(50, { source });
}

check('采集一帧 → 主干落行：source=collect、件数真值、规格解析、整单收入折 CNY 分', () => {
  resetSpine();
  const r = adb.upsertOrderBatch([frame('C-1')]);
  assert.strictEqual(r.inserted, 1);
  const rows = spineRows('collect');
  assert.strictEqual(rows.length, 2, '一单两行（每个商品一行）');
  assert.ok(rows.every((x) => x.source === 'collect'));
  const bySize = Object.fromEntries(rows.map((x) => [x.size, x]));
  assert.strictEqual(bySize['XXXL'].qty, 1);
  assert.strictEqual(bySize['L'].qty, 2, '件数取采集真值（不是按 1 兜底）');
  assert.strictEqual(bySize['XXXL'].color, 'Picture color', 'skuProps 解析出颜色');
  assert.strictEqual(bySize['XXXL'].amountCents, 41016, '整单收入 (398.16+12) 元 = 41016 分，**每行都记整单**');
  assert.strictEqual(bySize['XXXL'].bizStatus, '交易完成');
  assert.deepStrictEqual(bySize['XXXL'].rawFields['采集帧'] !== undefined, true, '整帧原文保真进 raw_fields');
});

check('同一单重推 = 整单替换（幂等），行数不翻倍', () => {
  const r = adb.upsertOrderBatch([frame('C-1')]);
  assert.strictEqual(r.updated, 1);
  assert.strictEqual(spineRows('collect').length, 2);
});

check('缺汇率的币种 → 金额 NULL（**不是 0**）；缺字段的帧跳过并计数', () => {
  resetSpine();
  adb.upsertOrderBatch([frame('C-USD', { currency: 'USD', goodsAmount: 100, shippingIncome: 0, lines: [{ qty: 1 }] })]);
  adb.upsertOrderBatch([frame('C-JPY', { currency: 'JPY', goodsAmount: 5000, shippingIncome: 0, lines: [{ qty: 1 }] })]);
  const rows = spineRows('collect');
  const usd = rows.find((x) => x.orderNo === 'C-USD');
  const jpy = rows.find((x) => x.orderNo === 'C-JPY');
  assert.strictEqual(usd.amountCents, 72000, 'USD 100 × 7.2 = 72000 分');
  assert.strictEqual(jpy.amountCents, null, 'JPY 无汇率 → NULL');
  const bad = adb.upsertOrderBatch([{ orderId: '', goodsAmount: 1 }]);
  assert.strictEqual(bad.skipped + bad.inserted, 1, '空订单号的帧不该静默消失（写失败要计数）');
});

check('读口按 source 过滤：collect / import / all 三态分明', () => {
  resetSpine();
  adb.upsertOrderBatch([frame('C-ONLY')]);
  require(path.join(ROOT, 'dist', 'electron', 'order-db.js')).insertOrder({
    imageId: null, orderNo: 'I-ONLY', shop: '', size: '', orderTime: D_100,
    category: '', color: '', logo: '', rawFields: { 商品ID: 'X1' },
  });
  assert.strictEqual(spineRows('collect').length, 2);
  assert.strictEqual(spineRows('import').length, 1);
  assert.strictEqual(spineRows('all').length, 3);
  assert.ok(spineRows('import').every((x) => x.source === 'import'));
});

check('采集**不再写** legacy 表 ae_orders / ae_order_lines（转只读，待 C9 收编后删表）', () => {
  resetSpine();
  adb.upsertOrderBatch([frame('C-LEGACY')]);
  assert.strictEqual(Number(dbQuery(`SELECT COUNT(*) c FROM ae_orders`)[0].c), 0, 'legacy 表不该再有新行');
  assert.strictEqual(Number(dbQuery(`SELECT COUNT(*) c FROM ae_order_lines`)[0].c), 0);
  assert.strictEqual(spineRows('collect').length, 2, '数据只进主干');
});

console.log('');
if (failed > 0) {
  console.log(`\u2717 成本口径冒烟失败：${failed} 项`);
  closeDb();
  process.exit(1);
}
console.log(`\u2713 成本口径冒烟全部通过（${passed} 项）`);
closeDb();
// 显式退出：不写的话进程靠 Electron 在无 GUI 环境里崩退（stderr 打一屏 GPU/sandbox 报错，
// 退出码是 SIGTRAP），看起来像冒烟失败，且在有窗口环境的机器上会一直挂着不返回。
process.exit(0);
