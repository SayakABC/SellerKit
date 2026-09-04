#!/usr/bin/env node
// scripts/plugins-install-demo.js
// Phase 3 外置插件演示安装：把 extensions/sk-hello 复制到 <userData>/plugins/sk-hello。
// userData 默认路径（未打包 dev 运行）：
//   macOS: ~/Library/Application Support/<appName>/plugins
//   Windows: %APPDATA%/<appName>/plugins
// 可用环境变量 SK_USER_DATA 覆盖 userData 根目录。
// 用法：npm run plugins:demo:install
'use strict';

const fs = require('fs');
const path = require('path');

const PKG_NAME = 'seller-kit'; // 需与 package.json name 一致（Electron userData 默认名）
const SOURCE = path.resolve(__dirname, '..', 'extensions', 'sk-hello');
const TARGET_ID = 'sk-hello';

function defaultUserData() {
  if (process.env.SK_USER_DATA) return process.env.SK_USER_DATA;
  if (process.platform === 'darwin') {
    return path.join(process.env.HOME || '', 'Library', 'Application Support', PKG_NAME);
  }
  if (process.platform === 'win32') {
    return path.join(process.env.APPDATA || '', PKG_NAME);
  }
  return path.join(process.env.HOME || '', '.config', PKG_NAME);
}

function main() {
  if (!fs.existsSync(SOURCE)) {
    console.error(`[plugins:demo:install] 示例插件目录不存在: ${SOURCE}`);
    process.exit(1);
  }
  const root = defaultUserData();
  const target = path.join(root, 'plugins', TARGET_ID);
  fs.rmSync(target, { recursive: true, force: true });
  fs.mkdirSync(path.dirname(target), { recursive: true });
  fs.cpSync(SOURCE, target, { recursive: true });
  console.log(`[plugins:demo:install] 已安装示例插件 → ${target}`);
  console.log('启动应用后 ⌘K 搜索「外置插件」即可体验；权限演示命令会展示越权被拒提示。');
}

main();
