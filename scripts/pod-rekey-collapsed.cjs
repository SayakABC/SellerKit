// 塌陷链接的定向重算（T3-6）：**只**给「同色名多图」链接的订单行补第 4 段（图键）。
//
//   npm run pod:rekey                     # 默认 dry-run：只报数、不写库
//   npm run pod:rekey -- --apply          # 真写库（仍是在副本上演示；要写线上库用 --db 指定）
//   npm run pod:rekey -- --db /path/x.db --apply
//
// 为什么要这个脚本：存量订单行的 `variant_key` 是 3 段（店铺 / 商品ID / 色）。色名塌陷的链接里
// 同一色名下挂着多张**不同的图**，3 段键把 5~12 个图案并成一件实物 —— 绑定台绑一个图案，
// 另外几个图案就永远匹配不上，之后静默错印。补第 4 段让"同名色不同图"成为不同的键。
//
// 三条硬纪律（全部在 `electron/podRekey.ts` 里，本脚本只负责喂数据 + 验结果）：
//   ① **只动塌陷链接**：非塌陷链接的行一个字节都不改（键是跨表连接的身份，漂一次要全库对账）；
//   ② **已 4 段的不动**（脚本会被重跑）；
//   ③ **图键认不出就报数**（`imageKeyOf` 只认 `/kf/<id>.<ext>`），不许静默跳过。
//
// ⚠️ 默认在**副本**上跑：即使加了 `--apply`，写的也是临时副本（安全试跑）。
//    真要改线上库，必须是用户显式给出 `--db <线上库路径>`，并且**先备份**（脚本会提示）。
//
// ⚠️ 本脚本**不动 `oi_variant_keys`**：那张表是"键 → 款色"的命名台账，加图键后旧行
//    仍按 3 段键挂着；重算只解决"订单行能匹配到 4 段槽位"，命名/归款会在下一次核对时
//    按新键重新生成。脚本结束时会把受影响的旧键行数报出来，让人知道要复核哪些。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');

const ROOT = path.join(__dirname, '..');
const argv = process.argv.slice(2);
let dbPath = '';
let apply = false;
let samples = 10;
for (let i = 0; i < argv.length; i += 1) {
  if (argv[i] === '--db') dbPath = argv[++i] || '';
  else if (argv[i] === '--apply') apply = true;
  else if (argv[i] === '--samples') samples = Math.max(0, Number(argv[++i]) || 0);
  else if (argv[i] === '-h' || argv[i] === '--help') {
    console.log('用法：node scripts/pod-rekey-collapsed.cjs [--db 库路径] [--apply] [--samples N]');
    process.exit(0);
  }
}

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

// 只读副本（连 WAL/SHM 一起拷）
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'sellerkit-pod-rekey-'));
const copy = path.join(dir, 'work.db');
fs.copyFileSync(src, copy);
for (const suffix of ['-wal', '-shm']) {
  const side = `${src}${suffix}`;
  if (fs.existsSync(side)) fs.copyFileSync(side, `${copy}${suffix}`);
}

const dbMod = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
const pod = require(path.join(ROOT, 'dist', 'electron', 'pod-db.js'));
const rekey = require(path.join(ROOT, 'dist', 'electron', 'podRekey.js'));

dbMod.initDb(copy);
pod.ensurePodSchema();

/** 全量槽位（分页上限 200） */
function allSlots() {
  const out = [];
  for (let page = 0; ; page += 1) {
    const r = pod.podWorklist({ filter: 'all', page, pageSize: 200 });
    out.push(...r.rows);
    if (out.length >= r.total || !r.rows.length) break;
    if (page > 5000) throw new Error('分页没有终止');
  }
  return out;
}

/** 订单行候选 + 每行自己的图 URL（图在 `md_images.source_url`） */
function candidates() {
  return dbMod.dbQuery(
    `SELECT i.id AS order_item_id, i.variant_key AS variant_key,
            COALESCE(m.source_url, '') AS image_url
       FROM oi_order_items i
       LEFT JOIN md_images m ON m.id = i.image_id
      WHERE i.variant_key <> ''`,
  );
}

const slots = allSlots();
const collapsedPrefixes = rekey.collapsedLinkPrefixes(slots);
const rows = candidates().map((r) => {
  const variantKey = String(r.variant_key ?? '');
  return {
    orderItemId: Number(r.order_item_id),
    variantKey,
    imageUrl: String(r.image_url ?? ''),
    linkCollapsed: collapsedPrefixes.has(rekey.linkPrefixOf(variantKey)),
  };
});

const plan = rekey.planCollapsedRekey(rows);
const collapsedRowsBefore = rows.filter((r) => r.linkCollapsed).length;
const nonCollapsedKeysBefore = new Set(rows.filter((r) => !r.linkCollapsed).map((r) => r.variantKey));

console.log('\n塌陷链接定向重算（T3-6）');
console.log(`  源库            ${src}`);
console.log(`  工作副本        ${copy}`);
console.log(`  塌陷链接前缀    ${collapsedPrefixes.size} 条`);
console.log(`  订单行          ${rows.length} 行（其中塌陷链接 ${collapsedRowsBefore} 行）`);
console.log(`  待改（3→4 段）  ${plan.updates.length} 行`);
console.log(`  已是 4 段       ${plan.alreadyFour} 行`);
console.log(`  非塌陷（不动）  ${plan.notCollapsed} 行`);
console.log(`  认不出图键      ${plan.cannotSplit} 行  ${plan.cannotSplit ? '← 这几行无法拆分，需补图后重跑' : ''}`);
console.log(`  脏键（不动）    ${plan.dirty} 行`);

if (!plan.updates.length) {
  console.log('\n  没有需要重算的行（幂等：重跑也不会再改）。');
} else {
  const show = plan.updates.slice(0, samples);
  if (show.length) {
    console.log('\n  样例（旧键 → 新键，键里的 NUL 显示为 \\0）：');
    for (const u of show) {
      const fmt = (k) => String(k).split('\u0000').join('\\0');
      console.log(`    #${u.orderItemId}  ${fmt(u.fromKey)}  →  ${fmt(u.toKey)}`);
    }
  }
}

if (apply) {
  console.log('\n  ⚠️ --apply：写入的是**临时副本**（线上库请显式 --db 并先备份）');
  dbMod.dbTransaction(() => {
    for (const u of plan.updates) {
      dbMod.dbRun(`UPDATE oi_order_items SET variant_key = ? WHERE id = ?`, [u.toKey, u.orderItemId]);
    }
  });

  // 判据（计划 T3-6 原文）：非塌陷链接的键集合**完全相同**；塌陷链接行数**不变**
  const afterRows = candidates().map((r) => {
    const variantKey = String(r.variant_key ?? '');
    return { variantKey, linkCollapsed: collapsedPrefixes.has(rekey.linkPrefixOf(variantKey)) };
  });
  const nonCollapsedKeysAfter = new Set(afterRows.filter((r) => !r.linkCollapsed).map((r) => r.variantKey));
  const collapsedRowsAfter = afterRows.filter((r) => r.linkCollapsed).length;

  assert.strictEqual(
    collapsedRowsAfter,
    collapsedRowsBefore,
    `塌陷链接行数变了：${collapsedRowsBefore} → ${collapsedRowsAfter}`,
  );
  assert.strictEqual(nonCollapsedKeysBefore.size, nonCollapsedKeysAfter.size, '非塌陷链接的键集合大小变了');
  for (const k of nonCollapsedKeysBefore) {
    assert.ok(nonCollapsedKeysAfter.has(k), '非塌陷链接的某个键被改动了（重算范围扩散了）');
  }
  for (const u of plan.updates) {
    const row = dbMod.dbGet(`SELECT variant_key FROM oi_order_items WHERE id = ?`, [u.orderItemId]);
    assert.strictEqual(String(row.variant_key), u.toKey, `行 #${u.orderItemId} 没写成新键`);
    const parts = require(path.join(ROOT, 'dist', 'electron', 'variantKey.js')).splitVariantKey(u.toKey);
    assert.ok(parts.imageKey, '新键必须是 4 段');
  }

  const oldKeyTable = dbMod.dbQuery(
    `SELECT COUNT(*) AS n FROM oi_variant_keys`,
  )[0];
  console.log(`\n  ✅ 非塌陷键集合不变（${nonCollapsedKeysBefore.size} 个键）· 塌陷行数不变（${collapsedRowsBefore} 行）`);
  console.log(`  ⚠️ oi_variant_keys 未动（共 ${Number(oldKeyTable.n)} 行）：受影响的 3 段键会在下次核对时按新键重新生成`);
  console.log(`  ✅ 副本已写入：${copy}\n`);
} else {
  console.log('\n  dry-run：没有写库。加 --apply 才写（写在副本上）。\n');
}

dbMod.closeDb();
process.exit(0);
