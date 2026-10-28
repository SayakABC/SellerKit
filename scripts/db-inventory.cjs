// 稳态表清单（不启动界面）。
//
//   npm run db:inventory
//   # = tsc -p tsconfig.electron.json && electron scripts/db-inventory.cjs
//
// 存在的理由：`docs/baseline/PROJECT_BASELINE.md` §6 要写「稳态共 N 个对象」，而这个数字**只能用
// 真建出来的库去数**。以前靠「grep `CREATE TABLE IF NOT EXISTS` 的处数再减几处注释」推算，
// 于是每加一张表、每把建表语句改成模板（`sk_shops` 现在由 `shopTableSql()` 拼）、每多一处
// 迁移期的冻结旧形状，推算式就要跟着改 —— 改晚了文档就开始说谎（本仓已错过三次）。
//
// 做法：临时目录里新建空库 → 依次跑全部域的 `ensure*Schema()`（就是宿主启动时那套）→
// 数 `sqlite_master`。FTS5 的影子表（`*_config/_content/_data/_docsize/_idx`）不是我们的对象，
// 按单张虚拟表计一次。
//
// ⚠️ 它数的是**新库直建的形状**；老库要再加上传感器（`schema:smoke`）覆盖的迁移路径。
//    两者应当相等 —— 不等就是「只改了迁移、忘了改 SCHEMA」（或反之）的形状分叉。

const path = require('path');
const os = require('os');
const fs = require('fs');

const ROOT = path.join(__dirname, '..');
const dbMod = require(path.join(ROOT, 'dist', 'electron', 'db.js'));

/** 域 → ensure 入口所在的文件（顺序 = 外键依赖方向：先店铺/企业，再引用它们的域） */
const DOMAIN_FILES = [
  'company-db',
  'shop-db',
  'shop-accounts-db',
  'mail-db',
  'order-db',
  'product-db',
  'shop-item-db',
  'purchase-db',
  'ae-db',
  'ship-rate-db',
  'picking-db',
  'ledger-db',
];

/** 内部表（不是业务对象，但确实落库，单独列出来免得被算成业务表） */
const INTERNAL = new Set(['sk_mail_meta', 'sk_schema_migrations']);
/** FTS5 自动建的影子表：计入 `sk_mail_fts` 这一张虚拟表 */
const FTS_SHADOW = /^sk_mail_fts(_config|_content|_data|_docsize|_idx)$/;

function run() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-db-inventory-'));
  dbMod.initDb(path.join(dir, 'fresh.db'));
  const owned = new Map();
  let before = new Set(
    dbMod
      .dbQuery(`SELECT name FROM sqlite_master WHERE type='table'`, [])
      .map((r) => String(r.name)),
  );
  const skipped = [];
  for (const file of DOMAIN_FILES) {
    const mod = require(path.join(ROOT, 'dist', 'electron', `${file}.js`));
    for (const key of Object.keys(mod)) {
      if (!/^ensure/.test(key) || typeof mod[key] !== 'function') continue;
      try {
        mod[key]();
      } catch (err) {
        skipped.push(`${file}.${key}: ${err && err.message ? err.message : err}`);
        continue;
      }
      const now = new Set(
        dbMod
          .dbQuery(`SELECT name FROM sqlite_master WHERE type='table'`, [])
          .map((r) => String(r.name)),
      );
      for (const name of now) if (!before.has(name) && !owned.has(name)) owned.set(name, file);
      before = now;
    }
  }

  const rows = dbMod.dbQuery(
    `SELECT type, name FROM sqlite_master
      WHERE (type='table' AND name NOT LIKE 'sqlite_%') OR type='view'
      ORDER BY name`,
    [],
  );
  // ⚠️ FTS5 本体在 `sqlite_master` 里 **type='table'**，不是 'view'：只滤影子表会把它留在 `tables`
  //    里，而它又作为「FTS5 虚拟表」计一次 → 双计（2026-10-22 首跑即中招，报成 41 / 38，
  //    与手抄基线的 40 / 37 对不上，多出的 1 就是它）。本体只从 `tables` 移出、单独计。
  const tables = rows.filter(
    (r) => r.type === 'table' && !FTS_SHADOW.test(String(r.name)) && String(r.name) !== 'sk_mail_fts',
  );
  const virtual = rows.filter((r) => String(r.name) === 'sk_mail_fts').length;
  const business = tables.filter((r) => !INTERNAL.has(String(r.name)));

  console.log('域 → 表（新库直建的稳态形状）');
  const byFile = new Map();
  for (const r of tables) {
    const file = owned.get(String(r.name)) || '(更早的域已建)';
    if (!byFile.has(file)) byFile.set(file, []);
    byFile.get(file).push(String(r.name));
  }
  for (const [file, names] of byFile) {
    console.log(`  ${file}: ${names.sort().join(' · ')}`);
  }
  console.log('');
  console.log(`对象总数 ${tables.length + virtual} = 表 ${tables.length} + FTS5 虚拟表 ${virtual}`);
  console.log(
    `  其中业务表 ${business.length} · 内部表 ${tables.length - business.length}` +
      `（${Array.from(INTERNAL).join(' / ')}）`,
  );
  if (skipped.length) console.log(`⚠️ ensure 抛错被跳过：${skipped.join('; ')}`);
  const shadows = rows.filter((r) => FTS_SHADOW.test(String(r.name))).length;
  console.log(`（FTS5 影子表 ${shadows} 张不单独计数）`);

  dbMod.closeDb();
  fs.rmSync(dir, { recursive: true, force: true });
  if (skipped.length) {
    console.log('✗ 有域的 schema 初始化失败，上面的清单不完整');
    process.exit(1);
  }
  console.log('✓ 稳态表清单输出完毕');
}

try {
  run();
} catch (err) {
  console.log(`✗ 稳态表清单失败：${err && err.stack ? err.stack : err}`);
  process.exit(1);
}
// 显式退出，否则 Electron 在无窗口环境下挂着不返回（同 shop-db-smoke 的约定）
process.exit(0);
