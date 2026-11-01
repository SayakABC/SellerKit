// 成本口径冒烟（C2 删除 `ae_cost_map` 之后的残存面）：拿货快照的聚合粒度 + 采集帧落订单主干。
//
// 为什么不用 vitest：better-sqlite3 按 **Electron 的 Node ABI** 编译，vitest 跑在系统 Node 上会
// 直接抛 ABI 不匹配 —— 与 order-db / ae-db / purchase-db / product-db 一致，DB 层统一走本冒烟。
//
//   npm run ae:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/ae-cost-smoke.cjs
//
// ⚠️ 2026-10-21（C2）：旧价目表 `ae_cost_map` 已由 `order.main` v10 删除，`manual-costs.ts`
//   与 `costMap*` 写口一并退役。原文件里的「老库迁移 / 导入语义 / 手工成本 / 产品镜像」四组
//   用例随它们删除 —— 成本现在是「产品当前进价 + 订单行两个字段」，那套口径由 order-db 冒烟
//   与订单利润界面冒烟覆盖。本文件只保留**与那张表无关**的两条 DB 层不变量：
//   ① 拿货快照按 (款, 拿货日期) 分组 —— 上游粒度错了，历史毛利就复算不出来；
//   ② 采集帧只进订单主干 `oi_orders`（旧采集表 ae_orders/ae_order_lines/ae_fees 已删）。
//   外加一条反向守卫：新库不该再长出 `ae_cost_map`。
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
const purchaseDb = require(path.join(ROOT, 'dist', 'electron', 'purchase-db.js'));
const orderDb = require(path.join(ROOT, 'dist', 'electron', 'order-db.js'));

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

const tableGone = (t) =>
  Number(dbQuery(`SELECT COUNT(*) AS c FROM sqlite_master WHERE type='table' AND name='${t}'`)[0].c) === 0;

// ===================================================================================
// 一、全新库：ae 域不再建旧价目表
// ===================================================================================

console.log('\n[1] 新库形状：ae_cost_map 不该被建出来（C2 已退役）');

initDb(path.join(dir, 'fresh.db'));
adb.ensureAeSchema();

check('ensureAeSchema 之后 ae_cost_map 不存在', () => {
  assert.ok(tableGone('ae_cost_map'), 'SCHEMA 里还留着这张表的建表语句');
});
check('汇率表照常建好（成本 CNY 计价仍在用）', () => {
  const cols = dbQuery(`PRAGMA table_info(ae_rates)`).map((c) => c.name);
  assert.ok(cols.includes('from_currency') && cols.includes('rate_to_cny'), `实际列：${cols.join(', ')}`);
});

// ===================================================================================
// 二、拿货快照源头：按 (款, 拿货日期) 分组
// ===================================================================================

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

function seedPurchases() {
  dbRun(`DELETE FROM purchase_items`);
  dbRun(`DELETE FROM purchase_orders`);
  dbRun(`INSERT INTO purchase_orders (id, biz_date, status) VALUES (1, ?, 'submitted'), (2, ?, 'submitted'), (3, ?, 'draft')`, [D_400, D_200, daysAgo(150)]);
  dbRun(`INSERT INTO purchase_items (purchase_id, style_code, style_name, qty, price_cents, amount_cents) VALUES
    (1, 'A', '款A', 10,  100, 1000),
    (2, 'A', '款A',  5,  300, 1500),
    (3, 'A', '款A', 99,    1,   99)`);
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

// ===================================================================================
// 三、采集订单 → 写入**唯一订单主干**（C1 合并的写侧）
// ===================================================================================

console.log('\n[3] 采集订单 → 写入唯一订单主干（C1 合并的写侧）');

/** 造一帧"采集来"的订单（形状＝扩展推送的 AeIngestOrder） */
function frame(orderId, opts = {}) {
  return {
    orderId,
    shopName: opts.shopName ?? '',
    orderTime: opts.orderTime ?? D_200,
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
  // 本冒烟只建了 ae / 采购域的表 → 主干所在的订单域要显式建起来（幂等）
  orderDb.ensureOrderSchema();
  dbRun(`DELETE FROM oi_orders`);
  dbRun(`DELETE FROM ae_rates WHERE from_currency <> 'CNY'`);
}
/** 主干里的采集行（走的是**页面用的那个读口**，不是另写一段 SQL） */
function spineRows(source) {
  return orderDb.shippingRows(50, { source });
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

check('缺汇率的币种 → 金额 NULL（**不是 0**）；回执报出缺汇率单数；缺字段的帧跳过并计数', () => {
  resetSpine();
  const usdRes = adb.upsertOrderBatch([frame('C-USD', { currency: 'USD', goodsAmount: 100, shippingIncome: 0, lines: [{ qty: 1 }] })]);
  const cnyRes = adb.upsertOrderBatch([frame('C-CNY')]);
  const jpyRes = adb.upsertOrderBatch([frame('C-JPY', { currency: 'JPY', goodsAmount: 5000, shippingIncome: 0, lines: [{ qty: 1 }] })]);
  const rows = spineRows('collect');
  const usd = rows.find((x) => x.orderNo === 'C-USD');
  const jpy = rows.find((x) => x.orderNo === 'C-JPY');
  assert.strictEqual(usd.amountCents, 72000, 'USD 100 × 7.2 = 72000 分');
  assert.strictEqual(jpy.amountCents, null, 'JPY 无汇率 → NULL');
  // 非空转：三个输入（USD/CNY 有汇率、JPY 无）必须给出**不同**的计数；
  // 若实现不看汇率恒返回 0（或恒返回批大小），这里至少两条会红。
  assert.strictEqual(cnyRes.rateMissing, 0, '本币恒 1:1 → 不该报缺汇率');
  assert.strictEqual(usdRes.rateMissing, 0, 'USD 有默认汇率 7.2 → 不该报缺汇率');
  assert.strictEqual(jpyRes.rateMissing, 1, 'JPY 无汇率 → 该单要计入 rateMissing（回执不再静默）');
  const bad = adb.upsertOrderBatch([{ orderId: '', goodsAmount: 1 }]);
  assert.strictEqual(bad.skipped + bad.inserted, 1, '空订单号的帧不该静默消失（写失败要计数）');
  assert.strictEqual(bad.rateMissing, 0, '空订单号是校验失败（skipped），不是缺汇率 —— 两个数别混');
  // T0-5：跳过**必须带原因**。只回一个数字时，"1 单没进来"和"1 单重复推送"长得一样，
  // 用户唯一的动作是再点一次同步（然后还是 1）。
  assert.strictEqual(bad.skips.length, 1, '被挡的帧要逐条进 skips');
  assert.ok(
    String(bad.skips[0].reason).length > 0,
    `skips 里必须有原因，实际：${JSON.stringify(bad.skips)}`,
  );
});

check('读口按 source 过滤：collect / import / all 三态分明', () => {
  resetSpine();
  adb.upsertOrderBatch([frame('C-ONLY')]);
  orderDb.insertOrder({
    imageId: null, orderNo: 'I-ONLY', shop: '', size: '', orderTime: D_200,
    category: '', color: '', logo: '', rawFields: { 商品ID: 'X1' },
  });
  assert.strictEqual(spineRows('collect').length, 2);
  assert.strictEqual(spineRows('import').length, 1);
  assert.strictEqual(spineRows('all').length, 3);
  assert.ok(spineRows('import').every((x) => x.source === 'import'));
});

check('弃表已删除：ae_orders / ae_order_lines / ae_fees 不存在（采集只进主干）', () => {
  resetSpine();
  adb.upsertOrderBatch([frame('C-LEGACY')]);
  assert.ok(tableGone('ae_orders'), 'ae_orders 应已被 dropLegacyOrderTables 删除');
  assert.ok(tableGone('ae_order_lines'), 'ae_order_lines 应已删除');
  assert.ok(tableGone('ae_fees'), 'ae_fees 应已删除');
  assert.strictEqual(spineRows('collect').length, 2, '数据只进主干 oi_orders');
});

check('ensureOrderSchema 跑完（v10）后仍然没有 ae_cost_map', () => {
  assert.ok(tableGone('ae_cost_map'), '订单域迁移不该把退役的表建回来');
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
