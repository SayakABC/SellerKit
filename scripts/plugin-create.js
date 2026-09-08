#!/usr/bin/env node
// scripts/plugin-create.js —— 外置插件脚手架
// 两种形态：
//   后台插件（L2 Worker 沙箱，默认）:
//     npm run plugins:create <kebab-id>             → extensions/<kebab-id>/（manifest + index.js）
//    UI 岛插件（iframe 运行时岛，--ui）:
//     npm run plugins:create:ui <kebab-id>          → ui-plugins/<kebab-id>/（vite 工程：manifest + src/ + index.html）
// 通用：
//     … --install  生成后直接复制到 <userData>/plugins/<kebab-id>
//       （UI 岛 --install 仅复制 manifest.json + dist/**，需先 npm run build 产出 dist）
// 约束：manifest.name 必须等于目录名（kebab-case）；entry 仅 ./ 相对路径。
// userData 默认路径（dev 未打包）：macOS ~/Library/Application Support/<appName>；
//   Windows %APPDATA%/<appName>；可用 SK_USER_DATA 覆盖（同 plugins-install-demo.js）。
'use strict';

const fs = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const TEMPLATE_BG = path.join(ROOT, 'extensions', '_template');   // L2 后台插件模板
const TEMPLATE_UI = path.join(ROOT, 'scripts', 'ui-plugin-template'); // UI 岛工程模板
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

/** 递归复制目录，并对文本文件做占位符替换 */
function copyTree(srcDir, destDir, transform) {
  fs.mkdirSync(destDir, { recursive: true });
  for (const name of fs.readdirSync(srcDir)) {
    const src = path.join(srcDir, name);
    const dest = path.join(destDir, name);
    if (fs.statSync(src).isDirectory()) {
      copyTree(src, dest, transform);
    } else {
      let content = fs.readFileSync(src, 'utf8');
      if (transform) content = transform(content);
      fs.writeFileSync(dest, content);
    }
  }
}

function parseArgs(argv) {
  const flags = new Set(argv.filter((a) => a.startsWith('--')));
  const id = argv.find((a) => !a.startsWith('--'));
  return { id, isUi: flags.has('--ui'), install: flags.has('--install') };
}

/** UI 岛：--install 仅复制 manifest.json + dist/**（即市场分发形态） */
function installUiPackage(id, sourceDir) {
  const manifestPath = path.join(sourceDir, 'manifest.json');
  const distDir = path.join(sourceDir, 'dist');
  if (!fs.existsSync(distDir)) {
    console.error('[plugins:create] --install 需要 dist/ 产物：请先 cd 到工程并执行 npm run build');
    process.exit(1);
  }
  const pluginRoot = path.join(defaultUserData(), 'plugins', id);
  fs.rmSync(pluginRoot, { recursive: true, force: true });
  fs.mkdirSync(pluginRoot, { recursive: true });
  fs.copyFileSync(manifestPath, path.join(pluginRoot, 'manifest.json'));
  fs.cpSync(distDir, path.join(pluginRoot, 'dist'), { recursive: true });
  console.log(`[plugins:create] 已安装 UI 岛（manifest + dist）→ ${pluginRoot}`);
  console.log('[plugins:create] 重启应用后：侧边栏出现该岛（「设置 → 插件」可启停/卸载）。');
}

function main() {
  const { id, isUi, install } = parseArgs(process.argv.slice(2));
  if (!id || !ID_RE.test(id) || id.length > 64) {
    console.error(`用法: npm run plugins:create[ :ui] <kebab-id> [-- --install]  （id 须 kebab-case，≤64 字符）`);
    process.exit(1);
  }
  if (id === '_template') {
    console.error('[plugins:create] 禁止使用保留名 _template');
    process.exit(1);
  }

  if (isUi) {
    if (!fs.existsSync(TEMPLATE_UI)) {
      console.error(`[plugins:create] UI 模板目录不存在: ${TEMPLATE_UI}`);
      process.exit(1);
    }
    const target = path.join(ROOT, 'ui-plugins', id);
    if (fs.existsSync(target)) {
      console.error(`[plugins:create] 目标已存在: ${target}`);
      process.exit(1);
    }
    copyTree(TEMPLATE_UI, target, (c) => c.split('__PLUGIN_ID__').join(id));
    console.log(`[plugins:create:ui] 已生成 UI 岛工程 → ${target}`);
    console.log('下一步：');
    console.log(`  cd ${path.relative(ROOT, target)} && npm install && npm run build   # 产出 dist/（先构建后打包）`);
    console.log(`  本地发布: node scripts/publish-plugin.js ${path.relative(ROOT, target)} -o market-out`);
    if (install) installUiPackage(id, target);
    return;
  }

  // 后台插件（L2）
  if (!fs.existsSync(TEMPLATE_BG)) {
    console.error(`[plugins:create] 模板目录不存在: ${TEMPLATE_BG}`);
    process.exit(1);
  }
  const target = path.join(ROOT, 'extensions', id);
  if (fs.existsSync(target)) {
    console.error(`[plugins:create] 目标已存在: ${target}`);
    process.exit(1);
  }

  copyTree(TEMPLATE_BG, target, (c) => c.split('__PLUGIN_ID__').join(id));
  console.log(`[plugins:create] 已生成插件骨架 → ${target}`);

  if (install) {
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
