#!/usr/bin/env node
// scripts/plugin-create.js —— 外置插件脚手架（T6，§8.1 单仓档）
// 用法：
//   npm run plugins:create <kebab-id>            # 在 extensions/<kebab-id>/ 生成插件骨架
//   npm run plugins:create <kebab-id> -- --install  # 生成后直接复制到 <userData>/plugins/<kebab-id>
// 生成物：manifest.json + index.js（占位符 __PLUGIN_ID__ 替换为 id）。
// 约束：manifest.name 必须等于目录名（kebab-case）；entry 为 ./index.js（仅 ./ 相对路径）。
// userData 默认路径（dev 未打包）：macOS ~/Library/Application Support/<appName>；
//   Windows %APPDATA%/<appName>；可用 SK_USER_DATA 覆盖（同 plugins-install-demo.js）。
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE = path.join(ROOT, 'extensions', '_template');
const PKG_NAME = 'seller-kit'; // 需与 package.json name 一致（Electron userData 默认名）
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/; // kebab-case（对齐 externalManifest.ts 的 ID_RE 精神）

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
  const id = process.argv[2];
  if (!id || !ID_RE.test(id) || id.length > 64) {
    console.error(`用法: npm run plugins:create <kebab-id>  （id 须 kebab-case，≤64 字符）`);
    process.exit(1);
  }
  if (id === '_template') {
    console.error('[plugins:create] 禁止使用保留名 _template');
    process.exit(1);
  }
  if (!fs.existsSync(TEMPLATE)) {
    console.error(`[plugins:create] 模板目录不存在: ${TEMPLATE}`);
    process.exit(1);
  }

  const target = path.join(ROOT, 'extensions', id);
  if (fs.existsSync(target)) {
    console.error(`[plugins:create] 目标已存在: ${target}`);
    process.exit(1);
  }

  // 复制模板并对所有文件做占位符替换
  fs.mkdirSync(target, { recursive: true });
  for (const file of fs.readdirSync(TEMPLATE)) {
    const src = path.join(TEMPLATE, file);
    const dest = path.join(target, file);
    if (fs.statSync(src).isDirectory()) continue; // 当前模板无子目录，防御性跳过
    const content = fs.readFileSync(src, 'utf8').split('__PLUGIN_ID__').join(id);
    fs.writeFileSync(dest, content);
  }
  console.log(`[plugins:create] 已生成插件骨架 → ${target}`);

  if (process.argv.includes('--install')) {
    const pluginRoot = path.join(defaultUserData(), 'plugins', id);
    fs.rmSync(pluginRoot, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(pluginRoot), { recursive: true });
    fs.cpSync(target, pluginRoot, { recursive: true });
    console.log(`[plugins:create] 已安装到 ${pluginRoot}（重启应用后生效）`);
  } else {
    console.log('下一步：编辑 manifest.json 的 displayName/capabilities 与 index.js 逻辑；');
    console.log('  体验请复制到 <userData>/plugins/<id>（或重跑时加 --install）。');
  }
}

main();
