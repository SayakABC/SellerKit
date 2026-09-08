// scripts/publish-plugin.js
// 插件市场发布工具：把外置插件目录打成 zip（zip 根 = 插件内容，manifest.json 在根），
// 计算 sha256，并写入/更新 catalog.json（用于 GitHub 静态托管的插件市场）。
//
// 用法：
//   node scripts/publish-plugin.js --dir extensions/sk-hello \
//     --base https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main \
//     [--out market-out] [--catalog market-out/catalog.json] [--build]
//
// UI 形态包（manifest.kind === "ui"，P3）：按 UI 岛语义发布——
//   - entry 须指向构建产物（如 ./dist/index.html）且文件存在
//   - 产物缺失时：若给到 --build 则先执行 `npm run build`（先构建后打包），否则报错提示
//   - 打包范围剔除工程开发文件（node_modules/.git/src/package.json 等），保留 manifest + dist/**
//   - catalog 条目写入 kind: "ui"，宿主市场列表/安装可提前识别 UI 岛形态
//
// 说明：
//   - --dir  插件目录（须含 manifest.json；name 必须等于目录名，entry 须 ./ 相对）
//   - --base URL 前缀：zip 下载地址 = <base>/<name>-<version>.zip（填你实际托管的静态 URL）
//   - --out  输出目录（默认 market-out，zip 与 catalog 都会放这里）
//   - 校验与主进程 electron/plugins-market-handlers.ts 同语义：manifest.name===目录名、
//     version x.y.z、entry 仅 ./ 相对、zip 内无 .. 穿越条目
'use strict';

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { spawnSync } = require('child_process');
const JSZip = require('jszip');

const ROOT = path.join(__dirname, '..');
const NAME_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;
const VERSION_RE = /^\d+\.\d+\.\d+$/;
// 进包时应剔除的开发侧/垃圾目录（任意形态包通用）
const SKIP_DIRS = new Set(['node_modules', '.git', '.DS_Store']);
// UI 形态包额外剔除的工程文件（产物在 dist/，源码/构建配置不随市场分发）
const SKIP_FILES_UI = new Set([
  'package.json',
  'package-lock.json',
  'pnpm-lock.yaml',
  'yarn.lock',
  '.gitignore',
  'README.md',
  'vite.config.js',
  'vite.config.mjs',
  'vite.config.ts',
]);
const SKIP_DIRS_UI = new Set(['src']);

function usage() {
  console.log(`用法: node scripts/publish-plugin.js --dir <插件目录> --base <URL前缀> [--out market-out] [--catalog <catalog.json>] [--build]`);
  console.log(`  --build  仅 UI 形态包：entry 产物缺失时先执行 npm run build（先构建后打包）`);
  process.exit(1);
}

const args = process.argv.slice(2);
function opt(name) {
  const i = args.indexOf(name);
  return i >= 0 && args[i + 1] ? args[i + 1] : null;
}
if (args.includes('-h') || args.includes('--help')) usage();
const pluginDirArg = opt('--dir');
const baseUrl = opt('--base');
const outDir = opt('--out') || 'market-out';
const catalogArg = opt('--catalog') || path.join(outDir, 'catalog.json');
const withBuild = args.includes('--build');
if (!pluginDirArg) usage();

// ---- 读取并校验 manifest ----
const pluginDir = path.resolve(ROOT, pluginDirArg);
const pluginId = path.basename(pluginDir);
const manifestPath = path.join(pluginDir, 'manifest.json');
if (!fs.existsSync(manifestPath)) {
  console.error(`[publish-plugin] 缺少 manifest.json: ${manifestPath}`);
  process.exit(1);
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
if (manifest.name !== pluginId) {
  console.error(`[publish-plugin] manifest.name(${manifest.name}) 必须等于目录名(${pluginId})`);
  process.exit(1);
}
if (!VERSION_RE.test(manifest.version || '')) {
  console.error(`[publish-plugin] manifest.version 非法（须 x.y.z）: ${manifest.version}`);
  process.exit(1);
}
const entry = typeof manifest.entry === 'string' ? manifest.entry : '';
if (!entry.startsWith('./') || entry.includes('..')) {
  console.error(`[publish-plugin] manifest.entry 非法（须 ./ 相对且不含 ..）: ${entry}`);
  process.exit(1);
}

// ---- UI 形态包判定（P3）----
const isUi = manifest.kind === 'ui';
if (manifest.kind && manifest.kind !== 'ui' && manifest.kind !== 'extension') {
  console.error(`[publish-plugin] manifest.kind 不支持市场分发（仅 "ui" / "extension"，收到 "${manifest.kind}"；` +
    `"view" 等随宿主分发视图插件不入市场）`);
  process.exit(1);
}
if (isUi && !entry.toLowerCase().endsWith('.html')) {
  console.error(`[publish-plugin] UI 形态包 entry 须指向 HTML 入口（如 ./dist/index.html）: ${entry}`);
  process.exit(1);
}

// ---- entry 产物存在性校验 + 「先构建后打包」----
function runBuild(dir) {
  const r = spawnSync('npm', ['run', 'build'], { cwd: dir, stdio: 'inherit', shell: process.platform === 'win32' });
  if (r.error) {
    console.error(`[publish-plugin] 构建命令执行失败: ${r.error.message}`);
    process.exit(1);
  }
  if (r.status !== 0) {
    console.error('[publish-plugin] npm run build 退出码非 0，中止发布');
    process.exit(1);
  }
}

const entryPath = path.resolve(pluginDir, entry);
if (!fs.existsSync(entryPath)) {
  const pkgPath = path.join(pluginDir, 'package.json');
  const hasBuild = (() => {
    try {
      const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'));
      return !!(pkg.scripts && pkg.scripts.build);
    } catch {
      return false;
    }
  })();
  if (hasBuild) {
    if (withBuild) {
      console.log('[publish-plugin] entry 产物缺失，检测到构建工程 → 执行 npm run build（先构建后打包）…');
      runBuild(pluginDir);
    } else {
      console.error(
        `[publish-plugin] entry 产物不存在: ${entryPath}\n` +
        `  UI 岛为「先构建后打包」：请先 cd ${pluginDir} && npm run build\n` +
        `  或在发布命令追加 --build 自动构建。`,
      );
      process.exit(1);
    }
  } else {
    console.error(`[publish-plugin] manifest.entry 指向的文件不存在: ${entryPath}`);
    process.exit(1);
  }
}

// ---- 遍历目录收集文件（无递归依赖，兼容旧 Node）----
function collectFiles(dir, out = [], prefix = '') {
  for (const name of fs.readdirSync(dir)) {
    const abs = path.join(dir, name);
    const rel = prefix ? `${prefix}/${name}` : name;
    const st = fs.statSync(abs);
    if (st.isDirectory()) {
      if (SKIP_DIRS.has(name) || (isUi && SKIP_DIRS_UI.has(name))) continue;
      collectFiles(abs, out, rel);
    } else {
      if (isUi && SKIP_FILES_UI.has(name)) continue;
      out.push({ rel, abs });
    }
  }
  return out;
}
let files = collectFiles(pluginDir);
// UI 形态且 entry 位于子目录（如 ./dist/index.html）：只打包 manifest.json + entry 所在子树，
// 避免 vite 工程根 dev 入口（index.html / README 等）混入市场包。
const entryRel = entry.replace(/^\.\//, '');
const uiEntryDir = isUi && entryRel.includes('/') ? entryRel.split('/')[0] : '';
if (uiEntryDir) {
  files = files.filter((f) => f.rel === 'manifest.json' || f.rel.startsWith(`${uiEntryDir}/`));
}
files.sort((a, b) => a.rel.localeCompare(b.rel));
if (!files.length) {
  console.error('[publish-plugin] 插件目录为空（UI 包可能缺少构建产物 dist/）');
  process.exit(1);
}

// ---- 打包 zip（zip 根 = 插件内容）----
const zip = new JSZip();
for (const f of files) {
  // 防穿越（发布侧预检）
  if (f.rel.startsWith('/') || f.rel.split('/').includes('..')) {
    console.error(`[publish-plugin] 目录含越界条目，拒绝打包: ${f.rel}`);
    process.exit(1);
  }
  zip.file(f.rel, fs.readFileSync(f.abs));
}
const zipName = `${pluginId}-${manifest.version}.zip`;
(async () => {
  const content = await zip.generateAsync({ type: 'nodebuffer', compression: 'DEFLATE' });
  const sha256 = crypto.createHash('sha256').update(content).digest('hex');
  fs.mkdirSync(path.resolve(ROOT, outDir), { recursive: true });
  const zipPath = path.resolve(ROOT, outDir, zipName);
  fs.writeFileSync(zipPath, content);

  // ---- 校验 zip 可被安全解压的条目（发布侧预检，模拟主进程语义）----
  const zipCheck = await JSZip.loadAsync(content);
  const bad = Object.keys(zipCheck.files).filter(
    (n) => n.startsWith('/') || n.replace(/\\/g, '/').split('/').includes('..'),
  );
  if (bad.length) {
    console.error(`[publish-plugin] zip 含越界条目，已产出但不应发布: ${bad.join(', ')}`);
  }

  // ---- 更新 catalog ----
  const displayName = manifest.displayName || manifest.name;
  const item = {
    id: pluginId,
    name: displayName,
    version: manifest.version,
    description: manifest.description || '',
    author: manifest.author || '',
    downloadUrl: baseUrl ? `${baseUrl.replace(/\/$/, '')}/${zipName}` : `<BASE_URL>/${zipName}`,
    sha256,
    homepage: '',
    ...(isUi ? { kind: 'ui' } : {}), // UI 形态包标记（宿主市场列表/安装可提前识别；L2 后台插件缺省不带）
  };
  const catalogPath = path.resolve(ROOT, catalogArg);
  let catalog = { plugins: [] };
  if (fs.existsSync(catalogPath)) {
    try {
      catalog = JSON.parse(fs.readFileSync(catalogPath, 'utf8'));
      if (!Array.isArray(catalog.plugins)) catalog = { plugins: [] };
    } catch {
      catalog = { plugins: [] };
    }
  }
  const idx = catalog.plugins.findIndex((p) => p.id === pluginId);
  if (idx >= 0) catalog.plugins[idx] = item;
  else catalog.plugins.push(item);
  fs.writeFileSync(catalogPath, JSON.stringify(catalog, null, 2) + '\n');

  console.log(`[publish-plugin] 完成`);
  console.log(`  zip      : ${zipPath} (${(content.length / 1024).toFixed(1)} KB)`);
  console.log(`  sha256   : ${sha256}`);
  console.log(`  kind     : ${isUi ? 'ui（iframe 运行时岛）' : 'extension（L2 Worker 后台）'}`);
  console.log(`  catalog  : ${catalogPath}（含 ${catalog.plugins.length} 个插件）`);
  console.log(`  downloadUrl 应为: ${item.downloadUrl}`);
  console.log(`  本地验证：cd market-out && python3 -m http.server 8000`);
  console.log(`  然后应用「插件市场」填入 http://127.0.0.1:8000/catalog.json`);
})().catch((e) => {
  console.error('[publish-plugin] 失败:', e instanceof Error ? e.message : e);
  process.exit(1);
});
