// 运价表快照（宿主中立层）数据层冒烟（不启动界面）。
//
//   npm run ship-rate:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/ship-rate-db-smoke.cjs
//
// 为什么需要：运价表原先只以"当前那一份"存在运费岛的私有 storage 里 —— 报价单更新后，
// **历史订单的预测运费会跟着变**（预测不可复算）。本表一次导入 = 一条快照，按内容去重。
// 覆盖的不变量：
//   · 同内容重复导入 → **不新增行**（幂等，返回同一条 id）
//   · 换一张表 → 新增一条（不同 content_key）
//   · `effective_from` 默认导入当日；显式传入且格式合法才采纳（脏值回落当日，不写脏数据）
//   · 列表按生效日倒序；**列表不带 payload**（整张表不拖过 IPC）
//   · 算账用的快照集合**带 payload**；坏 payload 降级为 `table=null`（不炸整批）
//   · 空库时算账集合为空数组（调用方据此判"还没有运价表"）

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-shiprate-smoke-'));

const { initDb, closeDb, dbGet } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
const srdb = require(path.join(ROOT, 'dist', 'electron', 'ship-rate-db.js'));

initDb(path.join(dir, 'smoke.db'));

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

/** 最小合成运价表（形状同 `RateTable`） */
function table(ratePerKg) {
  return {
    sheetName: 'tiny',
    countries: [
      {
        code: 'US',
        nameCn: '美国',
        nameEn: 'United States',
        cards: [
          {
            minG: 0,
            maxG: 2000,
            categories: ['general'],
            mode: 'perKg',
            ratePerKg,
            registerFee: 8,
            firstFee: 0,
            stepFee: 0,
            baseG: 0,
            stepG: 0,
            variant: '',
            sec: 1,
            currency: 'CNY',
            minChargeG: 10,
          },
        ],
      },
    ],
    sections: [],
    stats: { sections: 1, countries: 1, cards: 1, perKgCards: 1, firstStepCards: 0, currencies: ['CNY'] },
    warnings: [],
  };
}

console.log('\n[1] 落快照与幂等');
let firstId = 0;
check('首次落库：created=true', () => {
  const r = srdb.saveRateSnapshot({ table: table(80), sourceFile: '报价单.xlsx', sheetName: 's1' });
  assert.strictEqual(r.created, true);
  assert.ok(r.id > 0);
  firstId = r.id;
});
check('同内容重复导入：created=false 且**不新增行**（幂等）', () => {
  const before = Number(dbGet(`SELECT COUNT(*) AS n FROM sr_rate_snapshots`).n);
  const r = srdb.saveRateSnapshot({ table: table(80), sourceFile: '报价单.xlsx', sheetName: 's1' });
  assert.strictEqual(r.created, false);
  assert.strictEqual(r.id, firstId);
  assert.strictEqual(Number(dbGet(`SELECT COUNT(*) AS n FROM sr_rate_snapshots`).n), before);
});
check('换一张表（费率不同）→ 新增一条', () => {
  const r = srdb.saveRateSnapshot({ table: table(100), sourceFile: '报价单2.xlsx', sheetName: 's2' });
  assert.strictEqual(r.created, true);
  assert.notStrictEqual(r.id, firstId);
});
check('表结构不对 → 抛错（不静默落空快照）', () => {
  assert.throws(() => srdb.saveRateSnapshot({ table: null }), /运价表缺失/);
});

console.log('\n[2] 生效日');
check('默认 = 导入当日（yyyy-mm-dd）', () => {
  const r = srdb.saveRateSnapshot({ table: table(120) });
  assert.match(r.effectiveFrom, /^\d{4}-\d{2}-\d{2}$/);
});
check('显式传入合法日期 → 采纳；非法 → 回落当日（不写脏值）', () => {
  const ok = srdb.saveRateSnapshot({ table: table(130), effectiveFrom: '2026-01-15' });
  assert.strictEqual(ok.effectiveFrom, '2026-01-15');
  const bad = srdb.saveRateSnapshot({ table: table(140), effectiveFrom: '不是日期' });
  assert.match(bad.effectiveFrom, /^\d{4}-\d{2}-\d{2}$/);
});

console.log('\n[3] 两个读取面');
check('列表：按生效日倒序，且**不带 payload**', () => {
  const rows = srdb.listRateSnapshots(50);
  assert.ok(rows.length >= 4);
  for (let i = 1; i < rows.length; i++) {
    assert.ok(rows[i - 1].effectiveFrom >= rows[i].effectiveFrom, '应按生效日倒序');
  }
  assert.strictEqual(rows[0].payload, undefined, '列表不该带 payload');
  assert.strictEqual(typeof rows[0].countries, 'number');
});
check('算账集合：带 table（已解析回对象）', () => {
  const rows = srdb.rateSnapshotsForCalc(50);
  assert.ok(rows.length >= 4);
  assert.strictEqual(typeof rows[0].table, 'object');
  assert.ok(Array.isArray(rows[0].table.countries));
});
check('坏 payload 降级为 table=null（不炸整批）', () => {
  const { dbRun } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
  dbRun(
    `INSERT INTO sr_rate_snapshots (effective_from, source_file, sheet_name, countries, cards, payload, content_key)
     VALUES ('2099-01-01', 'bad.xlsx', 's', 0, 0, '{坏 JSON', 'bad-key-1')`,
  );
  const rows = srdb.rateSnapshotsForCalc(50);
  const bad = rows.find((r) => r.effectiveFrom === '2099-01-01');
  assert.strictEqual(bad.table, null);
  assert.ok(rows.some((r) => r.table !== null), '其它行不受影响');
});

console.log('\n[4] 空库');
check('没有任何快照时算账集合为空数组（调用方据此判"还没有运价表"）', () => {
  closeDb();
  const dir2 = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-shiprate-empty-'));
  initDb(path.join(dir2, 'empty.db'));
  srdb.ensureShipRateSchema();
  assert.deepStrictEqual(srdb.rateSnapshotsForCalc(50), []);
  assert.deepStrictEqual(srdb.listRateSnapshots(50), []);
  closeDb();
  fs.rmSync(dir2, { recursive: true, force: true });
});

closeDb();
try {
  fs.rmSync(dir, { recursive: true, force: true });
} catch {
  /* 清理失败不影响结论 */
}

console.log('\n' + '\u2500'.repeat(64));
if (failed) {
  console.log(`\u2717 运价表快照冒烟失败：${failed} 项\n`);
  process.exit(1);
}
console.log('\u2713 运价表快照冒烟全部通过\n');
process.exit(0);