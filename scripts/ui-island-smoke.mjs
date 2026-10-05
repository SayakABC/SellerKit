#!/usr/bin/env node
// scripts/ui-island-smoke.mjs
// UI 岛冒烟：启动一个**隔离 userData** 的宿主实例（不影响你在用的那个），逐个点击侧栏 UI 岛入口，
// 断言每个岛都真正完成桥握手（window.__sk.ready 落地）且首屏有内容；
// 最后**重启一次**，断言不点任何导航就回到本会话最后点开的那个岛（恢复上次所在模块）。
//
// 为什么需要它（2026-09-24）：
//   UI 岛的历史故障几乎全是**静默失效**——不抛错、不打印、页面只是空白。典型三例：
//     ① 切岛未重建桥：本会话第一个岛正常，之后每个岛永久卡在「等待桥握手」；
//     ② 打包版漏 plugin-ui-runtime.js：所有岛都没有 window.__sk；
//     ③ 恢复「上次所在模块」早于外置插件扫描：上次停在岛 → 重启后静默回落到首个非岛模块。
//   三者都无法用 vitest（environment=node，无 DOM/无 Electron）覆盖，只能真机点。
//   本脚本把「逐个岛点一遍 + 重启一次验证恢复」变成一条命令，避免每次都要人工发现。
//
// 用法：
//   npm run dev                     # 另开一个终端，保持 vite 在 5173
//   node scripts/ui-island-smoke.mjs
//   node scripts/ui-island-smoke.mjs -- --no-sandbox --disable-gpu   # 受限环境（CI/沙箱）需加
//   退出码：0 全部通过；1 有岛未通过 / 环境不满足
//
// 依赖：Node ≥ 18（用内置 fetch 与 WebSocket），不引第三方包。
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, readdirSync, readFileSync, existsSync, rmSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const APP_NAME = pkg.productName || pkg.name; // Electron userData 目录名
const CDP_PORT = Number(process.env.SK_SMOKE_PORT || 9333);
const BOOT_TIMEOUT_MS = Number(process.env.SK_SMOKE_BOOT_TIMEOUT || 12000);
const EXTRA_ELECTRON_ARGS = process.argv.slice(2).filter((a) => a !== '--');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/** 宿主 userData 目录（dev 模式 = Electron 默认路径） */
function userDataDir() {
  if (process.platform === 'darwin')
    return join(homedir(), 'Library', 'Application Support', APP_NAME);
  if (process.platform === 'win32') return join(process.env.APPDATA || '', APP_NAME);
  return join(homedir(), '.config', APP_NAME);
}

// ---------- 极简 CDP 客户端（不依赖 playwright/puppeteer） ----------
class Cdp {
  constructor(wsUrl) {
    this.wsUrl = wsUrl;
    this.id = 0;
    this.pending = new Map();
  }
  async connect() {
    this.ws = new WebSocket(this.wsUrl);
    await new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = () => rej(new Error(`无法连接 CDP: ${this.wsUrl}`));
    });
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { res, rej } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? rej(new Error(JSON.stringify(m.error))) : res(m.result);
      }
    };
  }
  send(method, params = {}) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      this.pending.set(id, { res, rej });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async evaluate(expression, awaitPromise = true) {
    const r = await this.send('Runtime.evaluate', {
      expression,
      awaitPromise,
      returnByValue: true,
    });
    if (r.exceptionDetails)
      throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
}

const targets = async () => (await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`)).json();

async function waitForHostTarget(timeoutMs) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const list = await targets();
      const host = list.find((t) => (t.url || '').includes('localhost:5173'));
      if (host) return host;
    } catch {
      /* 还没起来 */
    }
    await sleep(700);
  }
  return null;
}

/** 岛侧自检：桥是否注入、boot 是否到达、首屏是否有内容 */
async function islandProbe(bootTimeoutMs) {
  const list = await targets();
  const t = list.find((x) => (x.url || '').startsWith('sk-plugin://'));
  if (!t) return { ok: false, reason: 'iframe 未导航到 sk-plugin://（协议/入口路径问题）' };
  const c = new Cdp(t.webSocketDebuggerUrl);
  await c.connect();
  await c.send('Runtime.enable');
  const raw = await c.evaluate(`(async () => {
    if (typeof window.__sk !== 'object') {
      return JSON.stringify({ bridge: 'MISSING', scripts: Array.from(document.scripts).map(s => s.src).filter(Boolean) });
    }
    const booted = await Promise.race([
      window.__sk.ready.then(() => true),
      new Promise(r => setTimeout(() => r(false), ${bootTimeoutMs})),
    ]);
    return JSON.stringify({
      bridge: 'OK',
      booted,
      manifestId: window.__sk.manifest && window.__sk.manifest.id,
      htmlLen: document.documentElement.outerHTML.length,
      text: (document.body.innerText || '').replace(/\\s+/g, ' ').trim().slice(0, 60),
    });
  })()`);
  const d = JSON.parse(raw);
  if (d.bridge === 'MISSING') {
    return {
      ok: false,
      url: t.url,
      reason: `岛内没有 window.__sk（桥未注入）。已加载脚本：${(d.scripts || []).join(', ')}`,
    };
  }
  if (!d.booted)
    return { ok: false, url: t.url, reason: `未收到 boot 握手（宿主桥可能绑在别的岛）` };
  if (d.htmlLen < 800)
    return { ok: false, url: t.url, reason: `握手成功但首屏几乎为空（htmlLen=${d.htmlLen}）` };
  return { ok: true, url: t.url, detail: `${d.manifestId} · ${d.htmlLen}B · ${d.text}` };
}

/** 重启恢复专用：**不做任何点击**，看宿主是否自己渲染出某个岛（activeIslandId 是否被恢复逻辑填上） */
async function activeIslandProbe(bootTimeoutMs) {
  const list = await targets();
  const t = list.find((x) => (x.url || '').startsWith('sk-plugin://'));
  if (!t) return { present: false };
  const c = new Cdp(t.webSocketDebuggerUrl);
  await c.connect();
  await c.send('Runtime.enable');
  const raw = await c.evaluate(`(async () => {
    if (typeof window.__sk !== 'object') return JSON.stringify({ bridge: 'MISSING' });
    const booted = await Promise.race([
      window.__sk.ready.then(() => true),
      new Promise(r => setTimeout(() => r(false), ${bootTimeoutMs})),
    ]);
    return JSON.stringify({ bridge: 'OK', booted, htmlLen: document.documentElement.outerHTML.length });
  })()`);
  const d = JSON.parse(raw);
  return {
    present: true,
    url: t.url,
    detail:
      d.bridge === 'OK'
        ? `桥已连接 · booted=${d.booted} · ${d.htmlLen}B`
        : '桥未注入（页面无 __sk）',
  };
}

async function main() {
  // 1) 前置：vite dev server 必须在跑（本脚本不负责拉起它）
  try {
    await fetch('http://localhost:5173/');
  } catch {
    console.error(
      '✗ 连不上 vite dev server（http://localhost:5173）。请先在另一个终端跑 npm run dev。'
    );
    process.exit(1);
  }

  // 2) 找出「已安装的 UI 岛」清单（源 userData 的 plugins 目录）
  const srcPlugins = join(userDataDir(), 'plugins');
  const installed = existsSync(srcPlugins)
    ? readdirSync(srcPlugins, { withFileTypes: true })
        .filter((e) => e.isDirectory())
        .map((e) => {
          const mf = join(srcPlugins, e.name, 'manifest.json');
          if (!existsSync(mf)) return null;
          try {
            const m = JSON.parse(readFileSync(mf, 'utf8'));
            return m.kind === 'ui' ? { id: e.name, name: m.displayName || e.name } : null;
          } catch {
            return null;
          }
        })
        .filter(Boolean)
    : [];
  if (installed.length === 0) {
    console.error(`✗ 未在 ${srcPlugins} 找到任何 UI 岛（kind:"ui"）。先安装一个岛再跑冒烟。`);
    process.exit(1);
  }

  // 3) 隔离 userData：复制一份已安装的岛，避免污染在用的宿主数据
  const tmpUserData = mkdtempSync(join(tmpdir(), 'sk-island-smoke-'));
  cpSync(srcPlugins, join(tmpUserData, 'plugins'), { recursive: true });
  console.log(`· 隔离 userData: ${tmpUserData}`);
  console.log(`· 待测 UI 岛: ${installed.map((i) => i.id).join(', ')}`);

  // 4) 启动宿主（dev 模式：加载 vite dev server + 注册 sk-plugin:// 协议）
  const electronBin = join(
    ROOT,
    'node_modules',
    '.bin',
    process.platform === 'win32' ? 'electron.cmd' : 'electron'
  );
  /** 起一个宿主实例（固定用隔离 userData；第二次调用即「重启」，electron-store 里的 lastActiveModuleId 会带过来） */
  const launchApp = () => {
    const env = { ...process.env };
    delete env.ELECTRON_RUN_AS_NODE; // 否则 Electron 会以纯 Node 模式启动，require('electron') 拿不到 ipcMain
    const child = spawn(
      electronBin,
      [
        '.',
        `--user-data-dir=${tmpUserData}`,
        `--remote-debugging-port=${CDP_PORT}`,
        ...EXTRA_ELECTRON_ARGS,
      ],
      { cwd: ROOT, env, stdio: ['ignore', 'pipe', 'pipe'] }
    );
    child.stdout.on(
      'data',
      (b) => process.env.SK_SMOKE_VERBOSE && process.stdout.write(`  [app] ${b}`)
    );
    child.stderr.on(
      'data',
      (b) => process.env.SK_SMOKE_VERBOSE && process.stderr.write(`  [app] ${b}`)
    );
    return child;
  };
  /** 等调试端口从「可达」变回「不可达」，避免重启时读到上一个实例的 target 列表 */
  async function waitPortDown(timeoutMs = 15000) {
    const deadline = Date.now() + timeoutMs;
    while (Date.now() < deadline) {
      try {
        await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      } catch {
        return;
      }
      await sleep(300);
    }
  }

  let app = launchApp();
  let failed = false;
  let lastClicked = null; // 本会话最后成功点开的岛 → 它被持久化成「上次所在模块」
  try {
    const hostTarget = await waitForHostTarget(45000);
    if (!hostTarget) throw new Error('宿主未在 45s 内暴露调试目标（应用可能启动失败）');
    const host = new Cdp(hostTarget.webSocketDebuggerUrl);
    await host.connect();
    await host.send('Runtime.enable');

    // 等侧栏出现（外置插件扫描完成）
    let nav = [];
    for (let i = 0; i < 40; i++) {
      nav = await host.evaluate(
        `Array.from(document.querySelectorAll('nav button')).map(b => b.innerText.trim())`
      );
      if (nav.some((n) => installed.some((it) => n === it.name))) break;
      await sleep(1000);
    }

    console.log('\n侧栏入口:', nav.join(' | '));
    console.log('\n岛 id                  结果   详情');
    console.log('─'.repeat(96));
    const results = [];
    for (const island of installed) {
      const clicked = await host.evaluate(
        `(() => { const b = Array.from(document.querySelectorAll('nav button')).find(x => x.innerText.trim() === ${JSON.stringify(island.name)}); if (!b) return false; b.click(); return true })()`
      );
      if (!clicked) {
        results.push({
          id: island.id,
          ok: false,
          reason: '侧栏没有该入口（可能被停用，或在 modules.config.json 里与内建 id 冲突）',
        });
        console.log(`${island.id.padEnd(22)} ✗      侧栏无入口`);
        failed = true;
        continue;
      }
      lastClicked = island;
      await sleep(2500);
      const r = await islandProbe(BOOT_TIMEOUT_MS);
      // 宿主工具条文案体检（UX 审查 B1/D1）：业务页顶上不该出现内部术语，状态行要说人话、
      // 失败要可点重试；「宿主→岛事件」这类调试入口必须**默认收起**（收起时不在 innerText 里）。
      const bar = await host.evaluate(
        `(() => { const el = document.querySelector('.ui-island-bar'); return el ? el.innerText.replace(/\\s+/g, ' ').trim() : '' })()`
      );
      const banned = ['桥', '握手', '权限门', 'realm', 'iframe', 'L0', 'L2', '宿主→岛事件', '越权'];
      const hits = banned.filter((w) => String(bar).includes(w));
      results.push({ id: island.id, ...r, bar: String(bar), hits });
      if (r.ok) console.log(`${island.id.padEnd(22)} ✓      ${r.detail}`);
      else {
        failed = true;
        console.log(`${island.id.padEnd(22)} ✗      ${r.reason}`);
      }
    }

    // 工具条体检结论（单独一段，免得混进"岛能不能用"的结论里）
    const barBad = results.filter((r) => r.ok && (r.hits?.length || !String(r.bar).includes('已连接')));
    console.log('─'.repeat(96));
    if (barBad.length) {
      failed = true;
      console.log(`✗ 工具条文案体检未过：${barBad.length}/${results.length}`);
      for (const b of barBad) {
        console.log(
          `   · ${b.id}: ${b.hits?.length ? `出现内部术语 ${b.hits.join('/')}` : '状态行未显示「已连接」'} —— "${b.bar}"`
        );
      }
    } else if (results.some((r) => r.ok)) {
      console.log(`✓ 工具条文案体检：${results.filter((r) => r.ok).length} 个岛均无内部术语、状态行说人话、诊断区默认收起`);
    }

    const bad = results.filter((r) => !r.ok);
    console.log('─'.repeat(96));
    if (bad.length === 0) {
      console.log(`✓ ${results.length}/${results.length} 个 UI 岛握手 + 首屏均正常。`);
    } else {
      console.log(`✗ ${bad.length}/${results.length} 个岛未通过。`);
      // 只坏「首个之后的岛」= 切岛未重建桥；全部都坏 = 桥注入层（协议/分发）
      const firstOk = results.length > 1 && results[0].ok;
      console.log(
        firstOk
          ? '  特征提示：首个岛正常、其余全坏 → 典型「切岛未重建桥」：检查 AppShell 的 UiIslandView 是否带 :key="activeIslandId"，' +
              '以及 UiIslandView.attach 是否按 pluginId 重建（见 docs/architecture/UI_ISLAND_INTAKE_CHECKLIST.md §3.1）。'
          : '  特征提示：所有岛都坏 → 桥注入层问题：确认 sk-plugin:// 已注册、岛 HTML 里有 <script src=".../__sk__/runtime.js">，' +
              '否则看 docs/architecture/UI_ISLAND_INTAKE_CHECKLIST.md §3.2 / §3.3。'
      );
    }

    // ---- 4.6) 宿主设置分类贡献（含**宿主自有**的 `src/core/settings/panels.ts`，键 `core`）----
    // 为什么在这里测：设置分类是"贡献驱动"的（AGENTS §1.5），分类清单与面板入口都由 registry 生成 ——
    // 生成器写坏时**不会报错**，只是分类静默消失。这条断言把"宿主自有的「识别」设置拿得到"钉在真机上。
    //
    // 判据钉在语义锚点上（`[data-act="settings-cat"]` + `data-cat` = 分类 id），**不用** `aside > div`
    // 这类按结构取值的选择器：导航渲染成 div 还是 button 是布局，改布局不该弄红这条断言
    // （2026-10-01 就因导航改成 `<button>` 而误红过一次）。断言用**分类 id**（`recognition`）
    // 而非显示名，改名不该等于功能缺失。
    await host.evaluate(
      `window.dispatchEvent(new CustomEvent('open-settings', { detail: { category: 'recognition' } }))`
    );
    await sleep(1500);
    const settingsRaw = await host.evaluate(`(() => {
      const cats = Array.from(document.querySelectorAll('[data-act="settings-cat"]')).map((el) => ({
        id: el.getAttribute('data-cat') || '',
        name: (el.innerText || '').trim(),
      }));
      const q = (sel) => document.querySelector(sel);
      const provider = q('[data-act="rs-provider"]');
      return JSON.stringify({
        cats,
        hasEngineForm: !!provider,
        provider: provider ? provider.value : '',
        keyState: q('[data-act="rs-key-state"]') ? q('[data-act="rs-key-state"]').innerText.trim() : '',
      });
    })()`);
    const st = JSON.parse(settingsRaw);
    const hasRecognition = (st.cats || []).some((c) => c.id === 'recognition');
    if (hasRecognition && st.hasEngineForm) {
      console.log(
        `\n[设置贡献] ✓ 「识别」分类可达且面板渲染（分类导航=${(st.cats || []).map((c) => c.name || c.id).join('/')} · 引擎=${
          st.provider || '—'
        } · 密钥=${st.keyState || '—'}）`
      );
    } else {
      failed = true;
      console.log(
        `\n[设置贡献] ✗ 宿主自有设置分类没出来：分类导航=${JSON.stringify(st.cats)} · 引擎表单=${st.hasEngineForm}\n` +
          `  修：看 vite.config.ts 的 settingsPanelLoaders 是否收录 'core'（src/core/settings/panels.ts），以及 src/registry.generated.ts 是否已重新生成。`
      );
    }
    // 关掉设置，别影响下一步的重启恢复断言
    await host.evaluate(
      `document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }))`
    );
    await sleep(400);

    // ---- 5) 重启恢复：上次停在某个岛 → 重启后应「不点任何导航」就回到那个岛 ----
    // 这是**行为断言**，静态测试证明不了：恢复逻辑用 pm.has(id) 判定，而岛只在 discoverExternal
    // 里登记 —— 扫描晚于恢复时会被静默跳过（回落首个非岛模块）。
    if (lastClicked) {
      app.kill();
      await waitPortDown();
      app = launchApp();
      const t2 = await waitForHostTarget(45000);
      if (!t2) throw new Error('重启后宿主未暴露调试目标');
      console.log(`\n[重启恢复] 期望不点导航即回到 ${lastClicked.id}`);
      let restored = null;
      for (let i = 0; i < 20; i++) {
        restored = await activeIslandProbe(BOOT_TIMEOUT_MS);
        if (restored.present) break;
        await sleep(1000);
      }
      if (restored?.present && restored.url.includes(`sk-plugin://${lastClicked.id}/`)) {
        console.log(
          `[重启恢复] ✓ 已自动回到 ${lastClicked.id}（${restored.detail || '握手正常'}）`
        );
      } else {
        failed = true;
        console.log(
          `[重启恢复] ✗ 未回到上次所在的岛：${
            restored?.present
              ? `当前渲染的是 ${restored.url}（期望 ${lastClicked.id}）`
              : '重启后没有任何岛被渲染 —— 恢复「上次所在模块」时 UI 岛尚未登记。'
          }\n  修：AppShell.onMounted 里 discoverExternal 必须在恢复之前（见清单 §3.10 与 uiIslandBridgeLifecycle.spec.ts 的时序守卫）。`
        );
      }
    }
  } catch (e) {
    console.error(`\n✗ 冒烟执行失败：${e.message}`);
    failed = true;
  } finally {
    app.kill();
    await sleep(500);
    rmSync(tmpUserData, { recursive: true, force: true });
  }
  process.exit(failed ? 1 : 0);
}

main();
