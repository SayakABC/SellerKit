// 开机自动化（M5）的 DB 冒烟（不启动界面、不真开浏览器）。
//
//   npm run scheduler:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/scheduler-db-smoke.cjs
//
// 只测**能测的那一半**：`sk_auto_sync_log` 的形状与"今天触发过几次"的计数口径。
// 真正会开浏览器 / 弹通知的那一半（`runAutoSync` 的 open 分支）不能在这里跑 ——
// 它会真的唤起用户的 Chrome，而且 `openUrlInPreferredBrowser` 依赖 electron 的 shell；
// 那一半的判据是手工演练（计划 T5-6：断网 / 登录过期 / 扩展未装 / Chrome 没开）。
//
// 为什么计数口径值得单独钉：`attemptsToday` 少数一次 = 一天补跑 4 次（用户被 Chrome 弹脸）；
// 多数一次 = 第二次开机就 give_up（当天只抓了一次，剩下两次机会白扔）。
// 而这两种坏法都不会报错，只会在某天早上表现为"今天没单"或"怎么又开浏览器了"。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-scheduler-smoke-'));

const { initDb, closeDb, dbQuery, dbGet } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
const sch = require(path.join(ROOT, 'dist', 'electron', 'scheduler.js'));
const plan = require(path.join(ROOT, 'dist', 'electron', 'schedulerPlan.js'));

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

initDb(path.join(dir, 'smoke.db'));

const today = plan.localDayKey();
const yesterday = plan.localDayKey(new Date(Date.now() - 24 * 3600 * 1000));

/** 本地时间戳（与 `writeAutoSyncLog` 的默认一致，都是 ISO UTC；读回时用 day_key 判定） */
const nowIso = () => new Date().toISOString();

console.log('\n[1] schema：日志表自己的域，建一次就齐（不依赖任何别的域）');
check('ensureAutoSyncSchema 在**空库**上就能建成（不靠别域先跑）', () => {
  sch.ensureAutoSyncSchema();
  const t = dbQuery(`SELECT name FROM sqlite_master WHERE type='table' AND name='sk_auto_sync_log'`);
  assert.strictEqual(t.length, 1, '缺 sk_auto_sync_log：迁移没跑到');
});

check('形状 = day_key / at / source / action / reason / url（少一列就少一个判据）', () => {
  const cols = dbQuery(`PRAGMA table_info(sk_auto_sync_log)`).map((c) => String(c.name));
  for (const c of ['day_key', 'at', 'source', 'action', 'reason', 'url']) {
    assert.ok(cols.includes(c), `缺列 ${c}（实际 ${cols.join(', ')}）`);
  }
  assert.ok(!cols.includes('fetched'), '抓取计数属于 sk_sync_log，不该长在这张动作表上');
});

check('重复 ensure 幂等（用户每次启动都会跑一次）', () => {
  sch.ensureAutoSyncSchema();
  sch.ensureAutoSyncSchema();
  const idx = dbQuery(`SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='sk_auto_sync_log'`);
  assert.ok(idx.length >= 1, '按 (day_key, source, action) 查次数必须有索引');
});

console.log('\n[2] 计数口径：只数「今天 · 自动 · 真开了浏览器」');
check('写一行 → 默认 day_key 是**本机今天**（不是 UTC 日期）', () => {
  sch.writeAutoSyncLog({ action: 'open', reason: '测试开浏览器', source: 'startup', url: plan.MANGO_ORDER_LIST_URL });
  const r = dbQuery(`SELECT day_key, source, action FROM sk_auto_sync_log ORDER BY id DESC LIMIT 1`)[0];
  assert.strictEqual(String(r.day_key), today);
  assert.strictEqual(String(r.source), 'startup');
  assert.strictEqual(String(r.action), 'open');
});

check('startup + open 数到 3 次；already_done / give_up / no_push 都不计数', () => {
  sch.writeAutoSyncLog({ action: 'open', reason: '第二次', source: 'startup' });
  sch.writeAutoSyncLog({ action: 'open', reason: '第三次', source: 'startup' });
  sch.writeAutoSyncLog({ action: 'already_done', reason: '今天同步过', source: 'startup' });
  sch.writeAutoSyncLog({ action: 'give_up', reason: '用满 3 次', source: 'startup' });
  sch.writeAutoSyncLog({ action: 'no_push', reason: '没等到推送', source: 'startup' });
  assert.strictEqual(sch.attemptsToday(today, 'startup'), 3);
  // 这 3 行是"动作"，不是"动手"：数进去会让人当天第二次开机就放弃
  const actions = dbQuery(`SELECT action, COUNT(*) AS n FROM sk_auto_sync_log GROUP BY action`);
  const map = Object.fromEntries(actions.map((a) => [String(a.action), Number(a.n)]));
  assert.strictEqual(map['open'], 3);
  assert.strictEqual(map['already_done'], 1);
});

check('托盘里的「立即同步」按它自己的口径数（不挤占自动补跑的 3 次）', () => {
  sch.writeAutoSyncLog({ action: 'open', reason: '人点的', source: 'manual' });
  assert.strictEqual(sch.attemptsToday(today, 'startup'), 3, '手动同步不该占用自动补跑的次数');
  assert.strictEqual(sch.attemptsToday(today, 'manual'), 1);
});

check('昨天的触发行不计数（跨天必须重新有 3 次机会）', () => {
  sch.writeAutoSyncLog({ action: 'open', reason: '昨天开的', source: 'startup', dayKey: yesterday });
  assert.strictEqual(sch.attemptsToday(today, 'startup'), 3);
  assert.strictEqual(sch.attemptsToday(yesterday, 'startup'), 1);
});

console.log('\n[3] 与判定层对齐：满 3 次之后启动就应该放弃');
check('attemptsToday 喂给 decideAutoSync → give_up（且文案说清是上限）', () => {
  const d = plan.decideAutoSync({
    now: new Date(),
    lastSyncAt: '',
    attemptsToday: sch.attemptsToday(today),
    maxAttempts: plan.MAX_AUTO_SYNC_PER_DAY,
  });
  assert.strictEqual(d.action, 'give_up');
  assert.ok(d.reason.includes('3'), `文案里要有次数：${d.reason}`);
});

check('没触发过 + 从没同步过 → open（第一天开机就该抓）', () => {
  const d = plan.decideAutoSync({
    now: new Date(),
    lastSyncAt: '',
    attemptsToday: sch.attemptsToday(yesterday, 'startup'),
  });
  assert.strictEqual(d.action, 'open');
  assert.ok(d.reason.length > 0);
});

console.log('\n[4] 脏输入不许让日志/计数坏掉');
check('reason 超长被截到 500；空 reason / 非法 source 也不抛', () => {
  const long = 'x'.repeat(2000);
  sch.writeAutoSyncLog({ action: 'open_failed', reason: long, source: 'startup' });
  const r = dbQuery(`SELECT reason FROM sk_auto_sync_log ORDER BY id DESC LIMIT 1`)[0];
  assert.strictEqual(String(r.reason).length, 500);
  assert.doesNotThrow(() => sch.writeAutoSyncLog({ action: 'offline', reason: '', source: 'startup' }));
  const n = dbQuery(`SELECT COUNT(*) AS n FROM sk_auto_sync_log`)[0];
  assert.ok(Number(n.n) > 0);
});

check('读计数这条路不抛（表坏了也不该挡住开机）', () => {
  assert.doesNotThrow(() => sch.attemptsToday('', 'startup'));
  assert.strictEqual(typeof sch.attemptsToday('', 'startup'), 'number');
});

check('表里只会有本域该有的东西（没有顺手建别的域的表）', () => {
  const tables = dbQuery(`SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%'`).map(
    (t) => String(t.name),
  );
  // 只允许：本域日志表 + db 基础设施
  const extra = tables.filter((t) => t !== 'sk_auto_sync_log' && !['sk_schema_migrations'].includes(t));
  assert.deepStrictEqual(extra, [], `建出了不该建的表：${extra.join(', ')}`);
  assert.ok(dbGet(`SELECT 1 AS ok`) !== undefined);
});

closeDb();
fs.rmSync(dir, { recursive: true, force: true });
if (failed) {
  console.log(`\n\u2717 ${failed} 条断言失败`);
  process.exit(1);
}
console.log('\n\u2713 开机自动化（DB 层）冒烟全部通过');
// 显式退出：Electron 无窗口时不会自己返回（同 pod-db-smoke 的约定）
process.exit(0);
