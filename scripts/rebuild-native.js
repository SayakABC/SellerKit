// scripts/rebuild-native.js
// 重建 better-sqlite3 为 Electron ABI（npm install 会恢复 Node ABI 的 prebuilds，
// 与 Electron 的 ABI 不兼容会导致 new Database 时 SIGSEGV）。作为 postinstall 自动执行，
// 也可手动 npm run rebuild。
//
// 背景：better-sqlite3 12.x 当初因 Electron 33 内置 Node 20 而锁定（13.x 要求 Node >= 22）。
//       R3-2 升 Electron 44 后内置 Node 24.21，13.x 已可解禁——但属另一项升级，不在本次范围；
//       12.x 在 ABI 149 下经 @electron/rebuild 从源码编译可用（已实测）。
// 注意：@electron/rebuild 需要 node-abi >= 4.35 才认识 Electron 44 的 ABI 149
//       （package.json 已用 overrides 固定）。

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
