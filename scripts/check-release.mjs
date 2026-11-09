#!/usr/bin/env node
// 复核 release/ 里**已构建**的安装包：内嵌的 better_sqlite3.node 是否属于目标平台/架构。
//
// 为什么需要：afterPack 守卫只能管住「以后打的包」，管不住已经躺在 release/ 里的产物。
// 这个脚本把取证动作固化下来，发布前跑一次即可发现历史坏包。
//
// 用法：
//   npm run release:check
//   node scripts/check-release.mjs [releaseDir]
// 退出码：0 = 全部通过；1 = 存在坏包；2 = 无法完成检查（缺工具等）
//
// 支持：*-mac-{x64,arm64}.zip、*-win-{x64,arm64,ia32}*.exe
// 跳过：.dmg（内容与其同名 .zip 同源，7za 读不了）、.blockmap、其它文件

import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import fs from 'node:fs';
import path from 'node:path';

const require = createRequire(import.meta.url);
const { detectBinary, expectedBinary } = require('./native-binary.js');

let path7za;
try {
  ({ path7za } = require('7zip-bin'));
} catch {
  console.error('找不到 7zip-bin（electron-builder 的依赖）。请先 npm install 后重试。');
  process.exit(2);
}

const releaseDir = path.resolve(process.argv[2] || 'release');
if (!fs.existsSync(releaseDir) || !fs.statSync(releaseDir).isDirectory()) {
  console.error(`目录不存在：${releaseDir}`);
  process.exit(2);
}

function targetOf(name) {
  const mac = /-mac-(x64|arm64|universal)\.zip$/i.exec(name);
  if (mac) return { platform: 'darwin', arch: mac[1] };
  const win = /-win-(x64|arm64|ia32).*\.exe$/i.exec(name);
  if (win) return { platform: 'win32', arch: win[1] };
  return null;
}

function readNative(file) {
  // -r + 精确文件名：bin/ 下那份叫 better-sqlite3.node（连字符），
  // 不会误命中；build/Release/better_sqlite3.node（下划线）才是 bindings 实际加载的。
  return execFileSync(path7za, ['e', '-so', '-r', file, 'better_sqlite3.node'], {
    maxBuffer: 64 * 1024 * 1024,
    stdio: ['ignore', 'pipe', 'pipe'],
  });
}

const rows = [];
for (const name of fs.readdirSync(releaseDir).sort()) {
  const target = targetOf(name);
  if (!target) continue;
  const file = path.join(releaseDir, name);
  const want = expectedBinary(target.platform, target.arch);
  let got;
  try {
    got = detectBinary(readNative(file));
  } catch (err) {
    rows.push({ name, want, got: '读取失败', ok: false, note: String(err.message || err).slice(0, 90) });
    continue;
  }
  const ok = got.format === want.format && got.arch === want.arch;
  rows.push({ name, want, got: `${got.format}/${got.arch}`, ok, note: ok ? '' : '与目标平台不符，启动即崩' });
}

if (rows.length === 0) {
  console.log(`在 ${releaseDir} 下没有找到可复核的安装包（mac *.zip / win *.exe）。`);
  process.exit(0);
}

const pad = (s, n) => String(s).padEnd(n);
console.log(`复核目录：${releaseDir}`);
console.log(`${pad('产物', 44)} ${pad('期望', 12)} ${pad('实际', 12)} 判定`);
console.log('-'.repeat(94));
for (const r of rows) {
  const want = `${r.want.format}/${r.want.arch}`;
  console.log(
    `${pad(r.name, 44)} ${pad(want, 12)} ${pad(r.got, 12)} ${r.ok ? 'PASS' : 'FAIL'}` +
      (r.note ? `  ← ${r.note}` : '')
  );
}

const failed = rows.filter((r) => !r.ok);
console.log('-'.repeat(94));
console.log(`合计 ${rows.length} 个包：${rows.length - failed.length} PASS / ${failed.length} FAIL`);
if (failed.length > 0) {
  console.log(
    '\nFAIL 的包内 better_sqlite3.node 不是目标平台的二进制。' +
      '\n它们能构建、能上传 Releases，但用户启动到数据库初始化时必崩。' +
      '\n修法：在「目标平台 + 目标架构」的构建机上 npm run rebuild 后重新打包（见 README「打包」）。'
  );
  process.exit(1);
}
console.log('注：.dmg 与同名 .zip 由同一次打包产出、内容同源，校验 .zip 即可；7za 无法直接读 dmg。');
