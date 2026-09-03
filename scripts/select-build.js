#!/usr/bin/env node
/**
 * 交互式打包选择器 —— 打包时可视化勾选要包含的功能模块，然后自动构建/出包。
 *
 * 用法：
 *   npm run dist:select                 交互勾选模块 → 构建 → 询问是否出安装包
 *   npm run build:select                交互勾选模块 → 只构建（不出安装包）
 *   node scripts/select-build.js --platform=mac   出包时指定平台（mac/win/linux）
 *   node scripts/select-build.js --list           列出可打包模块后退出
 *
 * 原理：把勾选结果以逗号分隔写入 MODULE_IDS 环境变量，交给 vite.config.ts
 *       （优先级最高），未勾选的模块不会进入 registry.generated.ts → 不进 bundle。
 * 记忆：上次勾选结果缓存于 node_modules/.cache/sellerkit-selection.json，下次启动预勾选。
 */
'use strict';

const { spawn } = require('child_process');
const fs = require('fs');
const path = require('path');
const readline = require('readline');

const root = path.resolve(__dirname, '..');
const modulesDir = path.join(root, 'src', 'modules');
const cacheFile = path.join(root, 'node_modules', '.cache', 'sellerkit-selection.json');

const npmCmd = () => (process.platform === 'win32' ? 'npm.cmd' : 'npm');

// ---------- 1. 扫描可用模块（目录名即模块 id，meta.ts 提供展示名） ----------
function scanModules() {
  const ids = fs
    .readdirSync(modulesDir, { withFileTypes: true })
    .filter((d) => d.isDirectory())
    .map((d) => d.name)
    .sort();
  return ids.map((id) => {
    let name = id;
    try {
      const src = fs.readFileSync(path.join(modulesDir, id, 'meta.ts'), 'utf-8');
      const m = src.match(/name:\s*['"]([^'"]+)['"]/);
      if (m) name = m[1];
    } catch {
      /* 无 meta.ts 时用 id 兜底 */
    }
    return { id, name };
  });
}

// ---------- 2. 读取/写入上次选择 ----------
function loadLastSelection(ids) {
  try {
    const saved = JSON.parse(fs.readFileSync(cacheFile, 'utf-8'));
    if (Array.isArray(saved)) {
      return new Set(saved.filter((id) => ids.includes(id)));
    }
  } catch {
    /* 无缓存 */
  }
  return new Set();
}

function saveSelection(ids) {
  try {
    fs.mkdirSync(path.dirname(cacheFile), { recursive: true });
    fs.writeFileSync(cacheFile, JSON.stringify(ids), 'utf-8');
  } catch {
    /* 缓存失败不影响主流程 */
  }
}

// ---------- 3. 交互式多选（↑/↓ 移动 · 空格 勾选 · a 全选 · 回车 确认） ----------
function promptSelect(items, initial) {
  return new Promise((resolve) => {
    const selected = new Set(initial);
    let cursor = 0;
    let first = true;

    const totalLines = items.length + 2; // 头部 + 列表 + 底部统计

    const render = () => {
      if (!first) process.stdout.write(`\x1b[${totalLines}A`);
      first = false;
      let out = '\x1b[2K  选择要打包的功能模块  (\x1b[2m↑/↓ 移动 · 空格 勾选 · a 全选 · 回车 开始\x1b[0m)\n';
      items.forEach((it, i) => {
        const mark = selected.has(i) ? '\x1b[32m◉\x1b[0m' : '\x1b[2m◯\x1b[0m';
        const arrow = i === cursor ? '\x1b[36m❯\x1b[0m' : ' ';
        const title = i === cursor ? `\x1b[36;1m${it.name}\x1b[0m` : it.name;
        out += `\x1b[2K ${arrow} ${mark} ${title}  \x1b[2m(${it.id})\x1b[0m\n`;
      });
      out += `\x1b[2K  \x1b[2m已选 ${selected.size}/${items.length} 个模块\x1b[0m`;
      process.stdout.write(out);
    };

    const cleanup = () => {
      process.stdin.setRawMode(false);
      process.stdin.pause();
      process.stdin.removeListener('keypress', onKey);
    };

    const finish = () => {
      cleanup();
      process.stdout.write('\n');
      resolve([...selected].sort((a, b) => a - b).map((i) => items[i]));
    };

    const onKey = (_str, key) => {
      if (key.ctrl && key.name === 'c') {
        cleanup();
        process.stdout.write('\n\x1b[2m已取消。\x1b[0m\n');
        process.exit(130);
      }
      if (key.name === 'up' || key.name === 'k') {
        cursor = (cursor - 1 + items.length) % items.length;
        render();
      } else if (key.name === 'down' || key.name === 'j') {
        cursor = (cursor + 1) % items.length;
        render();
      } else if (key.name === 'space') {
        if (selected.has(cursor)) selected.delete(cursor);
        else selected.add(cursor);
        render();
      } else if (key.name === 'a') {
        if (selected.size === items.length) selected.clear();
        else items.forEach((_, i) => selected.add(i));
        render();
      } else if (key.name === 'return' || key.name === 'enter') {
        if (selected.size === 0) {
          render();
          return; // 至少选一个
        }
        finish();
      }
    };

    process.stdin.setRawMode(true);
    process.stdin.resume();
    process.stdin.setEncoding('utf8');
    readline.emitKeypressEvents(process.stdin);
    process.stdin.on('keypress', onKey);
    render();
  });
}

// ---------- 4. 执行子进程 ----------
function run(cmd, args, env) {
  return new Promise((resolve) => {
    console.log(`\n\x1b[33m$ ${cmd} ${args.join(' ')}\x1b[0m\n`);
    const child = spawn(cmd, args, { stdio: 'inherit', env, shell: process.platform === 'win32' });
    child.on('exit', (code) => resolve(code ?? 1));
    child.on('error', (e) => {
      console.error(`\x1b[31m启动失败: ${e.message}\x1b[0m`);
      resolve(1);
    });
  });
}

function confirm(question) {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  return new Promise((resolve) => {
    rl.question(question, (ans) => {
      rl.close();
      resolve(/^y(es)?$/i.test(ans.trim()));
    });
  });
}

// ---------- 5. 主流程 ----------
async function main() {
  const args = process.argv.slice(2);
  const buildOnly = args.includes('--build-only');
  const listOnly = args.includes('--list');
  const platform = args.find((a) => a.startsWith('--platform='))?.split('=')[1];

  const modules = scanModules();
  if (modules.length === 0) {
    console.error('未发现任何模块（src/modules 为空）。');
    process.exit(1);
  }

  if (listOnly) {
    console.log('可打包模块:');
    modules.forEach((m) => console.log(`  ${m.id}  (${m.name})`));
    return;
  }

  console.log('\x1b[2mSellerKit · 交互式打包\x1b[0m\n');
  const ids = modules.map((m) => m.id);
  const initial = loadLastSelection(ids);
  const chosen = await promptSelect(modules, initial);
  const chosenIds = chosen.map((m) => m.id);
  saveSelection(chosenIds);

  console.log(`\n\x1b[2m本次打包模块:\x1b[0m ${chosenIds.map((m) => `\x1b[36m${m}\x1b[0m`).join(', ')}`);

  // 构建（MODULE_IDS 优先级最高，未勾选模块不进 bundle）
  const env = { ...process.env, MODULE_IDS: chosenIds.join(',') };
  const code = await run(npmCmd(), ['run', 'build'], env);
  if (code !== 0) {
    console.error('\n\x1b[31m构建失败，已中止。\x1b[0m');
    process.exit(code);
  }

  if (buildOnly) {
    console.log('\n\x1b[32m构建完成（未出安装包）。\x1b[0m');
    return;
  }

  const wantDist = await confirm('是否继续打包安装程序？(y/N) ');
  if (!wantDist) {
    console.log('\x1b[2m构建完成，未出安装包。\x1b[0m');
    return;
  }

  const distArgs = platform ? [`--${platform}`] : [];
  const code2 = await run(npmCmd(), ['exec', 'electron-builder', '--', ...distArgs], env);
  process.exit(code2);
}

main().catch((e) => {
  console.error(e);
  process.exit(1);
});
