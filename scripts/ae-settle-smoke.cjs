// 「结算明细」（ae_settle_lines）冒烟：落库幂等 + 按订单聚合（含**商品行件数明细**）。
//
// 为什么不用 vitest：better-sqlite3 按 **Electron 的 Node ABI** 编译，vitest 跑在系统 Node 上会
// 直接抛 ABI 不匹配 —— 与其它 *-db 一致，DB 层统一走本冒烟。
//
//   npm run ae:settle:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/ae-settle-smoke.cjs
//
// 覆盖「改了会静默出错、且用界面看不出来」的几处：
//   ① 幂等键 `(订单号, 商品id, sku id)`：重导同一份导出是 **update 而非重复行**（否则金额翻倍）；
//   ② 行类型**由 `商品id` 是否为空判定**（不信入参自报）—— 标错类型会让两类行相加；
//   ③ 订单口径**优先取订单级行**（`item_id=''`）：实测它与商品行合计相差数倍，相加即错；
//      没有订单级行时才退化为商品行求和，并把 `from` 标成 `items`；
//   ④ **`items` 件数明细**：`lines` = 该 (订单,商品) 的商品行数 —— 实测同一商品会以多个 SKU
//      出现在一张单里（订单报表 14 行"商品ID 重复"），消费侧只在 `lines === 1` 时敢用 `qty`，
//      否则会把合计铺到每一行而**翻倍**（件数口径见 `docs/plans/PICKING_PLAN.md` §3.2）。
//
// 库文件落在临时目录，不污染真实 userData。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-ae-settle-smoke-'));

const { initDb, closeDb, dbRun, dbQuery } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
const adb = require(path.join(ROOT, 'dist', 'electron', 'ae-db.js'));

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

initDb(path.join(dir, 'smoke.db'));
adb.ensureAeSchema();

function reset() {
  dbRun(`DELETE FROM ae_settle_lines`);
}

/** 一行结算明细（默认商品行；`itemId` 给空串即订单级行） */
function line(over = {}) {
  return {
    orderNo: 'O1',
    itemId: 'I1',
    skuId: 'S1',
    qty: 1,
    settleStatus: '已结算',
    dealCents: 10000,
    netIncomeCents: 9086,
    splitCents: 914,
    feeCents: { 佣金: 550, 交易服务费: 223 },
    ...over,
  };
}

const byOrder = (nos) => adb.settleOrders(nos).find((r) => r.orderNo === 'O1');

console.log('\n[1] 落库：幂等键 (订单号, 商品id, sku id)');

check('首次导入 = created；重导同一份 = updated，且**不产生重复行**', () => {
  reset();
  const first = adb.upsertSettleLines([line(), line({ itemId: '', skuId: '', qty: 2 })]);
  assert.strictEqual(first.created, 2);
  assert.strictEqual(first.updated, 0);
  assert.strictEqual(first.failed.length, 0);
  const again = adb.upsertSettleLines([line(), line({ itemId: '', skuId: '', qty: 2 })]);
  assert.strictEqual(again.created, 0);
  assert.strictEqual(again.updated, 2);
  const cnt = dbQuery(`SELECT COUNT(*) AS c FROM ae_settle_lines`)[0].c;
  assert.strictEqual(cnt, 2, `重导后行数应仍为 2，实为 ${cnt}`);
});

check('行类型由 商品id 是否为空判定（入参自报 lineType 不被信任）', () => {
  reset();
  adb.upsertSettleLines([line({ lineType: 'order' })]); // 自报 order，但 itemId 非空 → 必须落成 item
  const t = dbQuery(`SELECT line_type FROM ae_settle_lines`)[0].line_type;
  assert.strictEqual(t, 'item');
});

check('空订单号 → 逐行 failed，不整批回滚', () => {
  reset();
  const r = adb.upsertSettleLines([line({ orderNo: '' }), line({ orderNo: 'O2' })]);
  assert.strictEqual(r.failed.length, 1);
  assert.strictEqual(r.created, 1);
  assert.strictEqual(dbQuery(`SELECT COUNT(*) AS c FROM ae_settle_lines`)[0].c, 1);
});

console.log('\n[2] 聚合：订单口径取订单级行（两类行不可相加）');

check('有订单级行 → 金额取它、from=order（商品行只用来数行数与件数）', () => {
  reset();
  adb.upsertSettleLines([
    line({ itemId: 'I1', skuId: 'S1', dealCents: 8715, netIncomeCents: 8000 }),
    line({ itemId: 'I2', skuId: 'S2', dealCents: 900, netIncomeCents: 100 }),
    line({ itemId: '', skuId: '', dealCents: 11452, netIncomeCents: 9086, splitCents: 914 }),
  ]);
  const r = byOrder(['O1']);
  assert.strictEqual(r.from, 'order');
  assert.strictEqual(r.dealCents, 11452, '订单级行是整单口径，不得被商品行覆盖');
  assert.strictEqual(r.netIncomeCents, 9086);
  assert.strictEqual(r.itemLines, 2);
  assert.strictEqual(r.feeSumCents, 773, '费用合计取订单级行的八类之和');
});

check('没有订单级行 → 退化为商品行求和，且 from=items（让消费侧知道口径不同）', () => {
  reset();
  adb.upsertSettleLines([
    line({ itemId: 'I1', skuId: 'S1', dealCents: 8715, netIncomeCents: 8000 }),
    line({ itemId: 'I2', skuId: 'S2', dealCents: 900, netIncomeCents: 100 }),
  ]);
  const r = byOrder(['O1']);
  assert.strictEqual(r.from, 'items');
  assert.strictEqual(r.dealCents, 9615);
  assert.strictEqual(r.netIncomeCents, 8100);
});

check('查询空订单号列表 / 不存在的订单号 → 空结果，不炸', () => {
  reset();
  assert.deepStrictEqual(adb.settleOrders([]), []);
  assert.deepStrictEqual(adb.settleOrders(['NOPE']), []);
});

console.log('\n[3] items 件数明细：lines 决定消费侧敢不敢用 qty');

check('同一 (订单,商品) 多 SKU（多行）→ lines=2、qty 求和（消费侧据此拒绝逐行复用）', () => {
  reset();
  adb.upsertSettleLines([
    line({ itemId: 'I1', skuId: 'S-XXL', qty: 1 }),
    line({ itemId: 'I1', skuId: 'S-XXXL', qty: 3 }),
    line({ itemId: 'I2', skuId: 'S-M', qty: 2 }),
  ]);
  const r = byOrder(['O1']);
  const i1 = r.items.find((x) => x.itemId === 'I1');
  const i2 = r.items.find((x) => x.itemId === 'I2');
  assert.deepStrictEqual(i1, { itemId: 'I1', lines: 2, qty: 4 });
  assert.deepStrictEqual(i2, { itemId: 'I2', lines: 1, qty: 2 });
  assert.strictEqual(r.itemLines, 3, 'itemLines = 商品行数，items 是它的按商品归并');
});

check('订单级行**不进** items（它没有商品id，件数无从归属）', () => {
  reset();
  adb.upsertSettleLines([line({ itemId: '', skuId: '', qty: 9 }), line({ itemId: 'I1', skuId: 'S1', qty: 1 })]);
  const r = byOrder(['O1']);
  assert.strictEqual(r.items.length, 1);
  assert.deepStrictEqual(r.items[0], { itemId: 'I1', lines: 1, qty: 1 });
});

check('qty 缺省/0/负数 → 落成 1（件数不可能是 0；0 会让拣货单"不用拣"）', () => {
  reset();
  adb.upsertSettleLines([
    line({ itemId: 'A', skuId: 's', qty: 0 }),
    line({ itemId: 'B', skuId: 's', qty: -5 }),
    line({ itemId: 'C', skuId: 's', qty: undefined }),
  ]);
  const r = byOrder(['O1']);
  assert.deepStrictEqual(
    r.items.map((x) => x.qty).sort(),
    [1, 1, 1],
  );
});

console.log('\n[4] 概览 settleStats：行/订单/已结算计数随导入变化');

check('导入后统计：行数、订单数、商品行/订单级行、已结算订单', () => {
  reset();
  adb.upsertSettleLines([
    line({ orderNo: 'O1', itemId: 'I1', skuId: 'S1', settleStatus: '已结算' }),
    line({ orderNo: 'O1', itemId: '', skuId: '', settleStatus: '已结算' }),
    line({ orderNo: 'O2', itemId: 'I1', skuId: 'S1', settleStatus: '待结算' }),
  ]);
  const s = adb.settleStats();
  assert.strictEqual(s.lines, 3);
  assert.strictEqual(s.orders, 2);
  assert.strictEqual(s.itemLines, 2);
  assert.strictEqual(s.orderLines, 1);
  assert.strictEqual(s.settledOrders, 1);
  assert.strictEqual(s.pendingOrders, 1);
  assert.ok(s.lastImportedAt, 'lastImportedAt 应有值');
});

console.log('');
if (failed > 0) {
  console.log(`\u2717 结算明细冒烟失败：${failed} 项`);
  closeDb();
  process.exit(1);
}
console.log(`\u2713 结算明细冒烟全部通过（${passed} 项）`);
closeDb();
// 显式退出：不写的话进程靠 Electron 在无 GUI 环境里崩退（stderr 一屏 GPU/sandbox 报错，退出码 SIGTRAP）
process.exit(0);