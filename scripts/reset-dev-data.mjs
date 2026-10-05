#!/usr/bin/env node
// scripts/reset-dev-data.mjs
// **清库重跑**：把本机应用库里的业务数据清空，好让"从零到算清钱"的全流程能干净地跑一遍
// （重构期用；用户 2026-09-30 授权，范围＝含主数据）。
//
//   node scripts/reset-dev-data.mjs            # 干跑：只打印"会删什么"，一行不动（默认）
//   node scripts/reset-dev-data.mjs --yes      # 真删：先备份（时间戳），再在事务里删
//
// 为什么是脚本而不是我直接删：
//   ① 破坏性动作留在人手上、可审阅（清单就在下面，加减都在 diff 里）；
//   ② 默认干跑 —— 先看清单再按 --yes，避免"手一抖"；
//   ③ **永远先备份**（同目录 `<db>.bak-<时间戳>`）—— 反悔只需把备份拷回去。
//
// 走 `sqlite3` CLI 而不是 better-sqlite3：应用库是 **Electron ABI** 编译的，系统 Node 加载不了
// （冒烟纪律同款原因，见 AGENTS §6.3）。
//
// ⚠️ 同时刻只让一个进程写这个库：执行前请确认宿主应用已退出（脚本会检查并拒绝）。

import { execFileSync } from 'node:child_process';
import { copyFileSync, existsSync, readFileSync } from 'node:fs';
import { homedir, platform } from 'node:os';
import { join } from 'node:path';

const ROOT = new URL('..', import.meta.url).pathname;
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const APP_NAME = pkg.productName || pkg.name;

/** 宿主 userData 目录（与 `scripts/ui-island-smoke.mjs` 同一套约定） */
function userDataDir() {
  if (platform() === 'darwin') return join(homedir(), 'Library', 'Application Support', APP_NAME);
  if (platform() === 'win32') return join(process.env.APPDATA || '', APP_NAME);
  return join(homedir(), '.config', APP_NAME);
}

const DB = join(userDataDir(), 'sellerkit.db');

/** 要清空的表（业务数据 + 主数据；范围＝用户 2026-09-30 选的 D） */
const CLEAR = [
  // A 订单与派生
  'ae_orders', 'ae_order_lines', 'ae_fees', 'ae_settle_lines', 'ae_cost_map',
  'oi_orders', 'oi_images', 'oi_styles', 'oi_style_colors', 'oi_style_fingerprints', 'oi_queue',
  'sr_rate_snapshots',
  // B 拿货与付款
  'purchase_items', 'purchase_orders', 'purchase_ignore', 'purchase_sources', 'payments', 'suppliers',
  // C 邮件本地缓存（账号配置保留）
  'sk_mail_messages', 'sk_mail_bodies', 'sk_mail_attachments', 'sk_mail_attachment_cache',
  'sk_mail_folders', 'sk_mail_meta',
  // D 主数据（全流程从零演练）
  'pl_products', 'pl_variants', 'pl_images', 'pl_item_images', 'pl_shop_sku',
  'sk_shops', 'sk_name_map', 'sk_shop_sets',
];

/** 保留（**动了会坏事**或属账号/配置） */
const KEEP = [
  'sk_schema_migrations', // 迁移记账：清了会让版本化迁移重跑
  'sk_mail_accounts', 'sk_companies', 'sk_company_profiles', // 账号与资质：重录成本高
  'ae_rates', // 汇率：默认值会重种，用户改过的也留着
];

const yes = process.argv.includes('--yes');

function die(msg) {
  console.error(`✗ ${msg}`);
  process.exit(1);
}

if (!existsSync(DB)) die(`找不到应用库：${DB}`);
if (!tryRun('which', ['sqlite3'])) die('本机没有 sqlite3 CLI');

/** 跑命令拿 stdout；**非零退出返回 ''**（pgrep 无命中时就是非零，不是错误） */
function tryRun(bin, args) {
  try {
    return execFileSync(bin, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch {
    return '';
  }
}
function run(bin, args) {
  return execFileSync(bin, args, { encoding: 'utf8' });
}
/** 只读查询（用 immutable，避免在应用运行时留下锁文件） */
function q(sql) {
  return run('sqlite3', [`file:${DB}?mode=ro&immutable=1`, sql]);
}
/** 写查询（事务里执行） */
function w(sql) {
  return run('sqlite3', [`file:${DB}?mode=rw`, sql]);
}

// 同时刻只让一个写者（AGENTS §0 的并发纪律）
const running = tryRun('pgrep', ['-fl', 'seller-kit|SellerKit']).trim();
if (running && !/reset-dev-data/.test(running)) {
  die(`宿主应用似乎正在运行，别在它写库时清库：\n${running}`);
}

const tables = new Set(q(`SELECT name FROM sqlite_master WHERE type='table';`).split('\n').map((x) => x.trim()).filter(Boolean));
const missing = CLEAR.filter((t) => !tables.has(t));
const targets = CLEAR.filter((t) => tables.has(t));

console.log(`库：${DB}`);
console.log(`将清空 ${targets.length} 张表${missing.length ? `（${missing.length} 张本库还没有，跳过）` : ''}：`);
for (const t of targets) {
  const n = Number(q(`SELECT COUNT(*) FROM ${t};`).trim()) || 0;
  console.log(`  · ${t.padEnd(28)} ${String(n).padStart(6)} 行`);
}
console.log(`保留：${KEEP.join(' · ')}`);
if (tables.has('sk_mail_fts')) {
  console.log('  （邮件全文索引 sk_mail_fts 会用 FTS5 的 delete-all 清空，避免留下指向已删邮件的幽灵命中）');
}

if (!yes) {
  console.log('\n（干跑：一行没动。确认无误后加 --yes 执行；执行前会自动备份）');
  process.exit(0);
}

const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19);
const backup = `${DB}.bak-${stamp}`;
copyFileSync(DB, backup);
console.log(`\n· 已备份：${backup}`);

const ftsReset = tables.has('sk_mail_fts')
  ? `INSERT INTO sk_mail_fts(sk_mail_fts) VALUES('delete-all');`
  : '';
w(`BEGIN;
${targets.map((t) => `DELETE FROM ${t};`).join('\n')}
${ftsReset}
DELETE FROM sqlite_sequence;
COMMIT;`);

console.log('· 已清空。复核（应全为 0，保留项照旧）：');
for (const t of [...targets.slice(0, 6), ...KEEP]) {
  const n = Number(q(`SELECT COUNT(*) FROM ${t};`).trim()) || 0;
  console.log(`  · ${t.padEnd(28)} ${String(n).padStart(6)} 行`);
}
console.log(`\n✓ 完成。反悔就把备份拷回去：cp "${backup}" "${DB}"`);