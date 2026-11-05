// 图案槽位清单（T3-5）：**真库副本**上跑 `ensurePodSchema()`，把 `pod_binding_worklist` 摊成 CSV。
//
//   npm run pod:worklist                        # 自动探测本机 userData 里的 sellerkit.db
//   npm run pod:worklist -- --db /path/to/x.db   # 指定库
//   npm run pod:worklist -- --expect 560,50      # 期望「总槽位,塌陷槽位」（不一致即退出码 1）
//
// 为什么要这个脚本而不是直接开界面看：覆盖率这条门禁的分母**只能从真库数出来**
// （`docs/plans/MANGO_INGEST_AND_POD_PLAN.md` T3-5）。而真库此刻只采集了 2/16 家店，
// 所以这个数要能被反复复算、和采集进度一起对比 —— 采集铺开（T3-8）后重跑同一个命令即可。
//
// ⚠️ **只读副本**：脚本先把库（连同 `-wal`/`-shm`）复制到临时目录再在那里建视图/查询，
//    真库一个字节都不写。`ensurePodSchema()` 是幂等建表+建视图，在副本上跑是安全的。
// ⚠️ 键里含 `\u0000`：CSV 里把它写成字面量 `\0`（人看得懂、也不会撑坏表格软件）。
//    机器要消费时用 `variant_key_hex`（base64）那一列。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
let dbPath = '';
let outPath = '';
let expectArg = '';
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--db') dbPath = argv[++i] || '';
  else if (argv[i] === '--out') outPath = argv[++i] || '';
  else if (argv[i] === '--expect') expectArg = argv[++i] || '';
  else if (argv[i] === '-h' || argv[i] === '--help') {
    console.log('用法：node scripts/pod-worklist.cjs [--db 库路径] [--out csv 路径] [--expect 总槽位,塌陷槽位]');
    process.exit(0);
  }
}

/** 本机 userData 的候选路径（与 `refresh-table-comments.cjs` 同一份探测） */
function findRealDb() {
  const home = os.homedir();
  const candidates = [
    path.join(home, 'Library', 'Application Support', 'seller-kit', 'sellerkit.db'),
    path.join(home, 'Library', 'Application Support', 'SellerKit', 'sellerkit.db'),
  ];
  for (const c of candidates) if (fs.existsSync(c)) return c;
  return '';
}

const src = dbPath || findRealDb();
if (!src || !fs.existsSync(src)) {
  console.error(`✗ 找不到数据库：${src || '（自动探测失败，用 --db 指定）'}`);
  process.exit(1);
}

// 只读副本：连 WAL/SHM 一起拷（少了 -wal 会读到"旧快照"，数字对不上）
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-pod-worklist-'));
const copy = path.join(dir, 'ro.db');
fs.copyFileSync(src, copy);
for (const suffix of ['-wal', '-shm']) {
  const side = `${src}${suffix}`;
  if (fs.existsSync(side)) fs.copyFileSync(side, `${copy}${suffix}`);
}

const dbMod = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
const pod = require(path.join(ROOT, 'dist', 'electron', 'pod-db.js'));

dbMod.initDb(copy);
pod.ensurePodSchema();

/** 一页一页取全量槽位（`SLOT_PAGE_MAX=200`） */
function allSlots() {
  const out = [];
  for (let page = 0; ; page += 1) {
    const r = pod.podWorklist({ filter: 'all', page, pageSize: 200 });
    out.push(...r.rows);
    if (out.length >= r.total || !r.rows.length) break;
    if (page > 5000) throw new Error('分页没有终止（total 与 rows 不一致）');
  }
  return out;
}

const slots = allSlots();
const stats = pod.podWorklistStats();

console.log(`\n图案槽位清单（副本）`);
console.log(`  源库        ${src}`);
console.log(`  临时副本    ${copy}`);
console.log(`  总槽位      ${stats.total}`);
console.log(`  已绑        ${stats.bound}`);
console.log(`  待绑        ${stats.unbound}`);
console.log(`  塌陷链接    ${stats.collapsed}（已绑 ${stats.collapsedBound}）`);
const shops = new Set(slots.map((s) => s.shop));
console.log(`  覆盖店铺    ${shops.size} 家：${[...shops].join('、') || '（无）'}`);

if (expectArg) {
  const [expTotal, expCollapsed] = expectArg.split(',').map((x) => Number(x));
  assert.strictEqual(stats.total, expTotal, `总槽位与期望不符：${stats.total} ≠ ${expTotal}`);
  if (Number.isFinite(expCollapsed)) {
    assert.strictEqual(stats.collapsed, expCollapsed, `塌陷槽位与期望不符：${stats.collapsed} ≠ ${expCollapsed}`);
  }
  console.log(`  ✅ 与期望一致（${expTotal} / ${expCollapsed}）`);
}

// CSV：键里的 NUL 写成字面量 `\0`，另给 base64 列供机器消费
function esc(v) {
  const s = String(v ?? '');
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
const header = [
  'shop',
  'item_id',
  'color',
  'imgs_in_name',
  'image_key',
  'image_url',
  'bound_pattern_code',
  'bound_pattern_id',
  'source',
  'state',
  'variant_key',
  'variant_key_b64',
];
const lines = [header.join(',')];
for (const s of slots) {
  lines.push(
    [
      esc(s.shop),
      esc(s.itemId),
      esc(s.color),
      s.imgsInName,
      esc(s.imageKey),
      esc(s.imageUrl),
      esc(s.patternCode),
      s.patternId,
      esc(s.source),
      esc(s.state),
      esc(String(s.variantKey).split('\u0000').join('\\0')),
      Buffer.from(String(s.variantKey), 'utf8').toString('base64'),
    ].join(','),
  );
}
const target =
  outPath || path.join(dir, `pod-worklist-${new Date().toISOString().slice(0, 10)}.csv`);
fs.writeFileSync(target, `${lines.join('\n')}\n`, 'utf8');
console.log(`  CSV         ${target}（${slots.length} 行）\n`);

dbMod.closeDb();
process.exit(0);
