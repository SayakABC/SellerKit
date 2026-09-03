// scripts/rebuild-native.js
// 重建 better-sqlite3 为 Electron ABI（npm install 会恢复 Node ABI 的 prebuilds，
// 而 Electron 33 内置 Node 20，better-sqlite3 12.x prebuilds 与 Electron 不兼容会导致
// new Database 时 SIGSEGV）。作为 postinstall 自动执行，也可手动 npm run rebuild。
//
// 背景：better-sqlite3 13.x 要求 Node >= 22（Electron 33 是 Node 20.18），已锁定 12.x；
//       12.x 的 prebuilds/ 下是 Node ABI 二进制，必须删除并从源码编译成 Electron ABI。

'use strict';

const { execSync } = require('child_process');
const fs = require('fs');
const path = require('path');

const pkgDir = path.join(__dirname, '..', 'node_modules', 'better-sqlite3');
const prebuildsDir = path.join(pkgDir, 'prebuilds');

function main() {
  if (fs.existsSync(prebuildsDir)) {
    fs.rmSync(prebuildsDir, { recursive: true, force: true });
    console.log('[rebuild-native] removed Node-ABI prebuilds');
  }
  console.log('[rebuild-native] rebuilding better-sqlite3 for Electron ABI…');
  execSync('npx @electron/rebuild -f -w better-sqlite3', {
    stdio: 'inherit',
    env: { ...process.env, npm_config_build_from_source: 'true' },
  });
  console.log('[rebuild-native] done');
}

main();
