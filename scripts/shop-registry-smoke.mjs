#!/usr/bin/env node
// scripts/shop-registry-smoke.mjs
// 「店铺登记」页真机探针（DOMAIN_INTEGRATION_PLAN S1）。
//
// 为什么 ui-island-smoke 不够：它只断言「握手 + 首屏非空」，而本页首屏是**账号库**页签 ——
// 点进「店铺登记」才会触发 shop 域的四个 op（ensure / list / unmapped / summary）。
// 若岛 manifest 漏声明 `shop` 域或漏声明某个 op，宿主权限门会**拒绝**这些调用，
// 界面表现为顶部错误条（loadError）—— 那是本探针唯一能抓到的地方（vitest 无 DOM、无权限门）。
//
// 用法（要在**同一次调用**里起 vite，见下）：
//   npx vite &
//   node scripts/shop-registry-smoke.mjs -- --no-sandbox --disable-gpu
// 退出码：0 通过；1 失败
import { spawn } from 'node:child_process';
import { mkdtempSync, cpSync, existsSync, rmSync, readFileSync } from 'node:fs';
import { homedir, tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const pkg = JSON.parse(readFileSync(join(ROOT, 'package.json'), 'utf8'));
const APP_NAME = pkg.productName || pkg.name;
const CDP_PORT = Number(process.env.SK_SHOP_SMOKE_PORT || 9344);
const ISLAND = 'shop-accounts';
const EXTRA_ARGS = process.argv.slice(2).filter((a) => a !== '--');
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const realUserData = join(homedir(), 'Library', 'Application Support', APP_NAME);
const userData = mkdtempSync(join(tmpdir(), 'sk-shop-registry-'));
if (existsSync(join(realUserData, 'plugins'))) {
  cpSync(join(realUserData, 'plugins'), join(userData, 'plugins'), { recursive: true });
}

let failed = 0;
const check = (ok, name, detail = '') => {
  console.log(`  ${ok ? '\u2713' : '\u2717'} ${name}${detail ? ` — ${detail}` : ''}`);
  if (!ok) failed += 1;
};

/** 极简 CDP 客户端（同 ui-island-smoke：不引 playwright） */
async function cdp(target, expression) {
  const ws = new WebSocket(target.webSocketDebuggerUrl);
  await new Promise((res, rej) => {
    ws.addEventListener('open', res, { once: true });
    ws.addEventListener('error', rej, { once: true });
  });
  const id = 1;
  const done = new Promise((res, rej) => {
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id !== id) return;
      if (msg.error) rej(new Error(JSON.stringify(msg.error)));
      else res(msg.result);
    });
  });
  ws.send(
    JSON.stringify({
      id,
      method: 'Runtime.evaluate',
      params: { expression, awaitPromise: true, returnByValue: true },
    }),
  );
  const out = await done;
  ws.close();
  return out?.result?.value;
}

const listTargets = async () => {
  for (let i = 0; i < 60; i += 1) {
    try {
      const r = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await r.json();
      if (list.length) return list;
    } catch {
      /* 还没起来 */
    }
    await sleep(500);
  }
  return [];
};

console.log(`· 隔离 userData: ${userData}`);
const child = spawn(
  join(ROOT, 'node_modules', '.bin', 'electron'),
  ['.', `--user-data-dir=${userData}`, `--remote-debugging-port=${CDP_PORT}`, ...EXTRA_ARGS],
  { cwd: ROOT, env: { ...process.env, ELECTRON_RUN_AS_NODE: undefined }, stdio: 'ignore' },
);

let hosts = [];
try {
  hosts = await listTargets();
  check(hosts.length > 0, '宿主 CDP 可连接', `${hosts.length} 个 target`);

  // 点侧栏入口，让岛 iframe 被创建。
  // ⚠️ 必须**重试**：宿主启动后侧栏是异步渲染的（先扫描 plugins 再建入口），
  //    刚连上就点会点空 —— 症状是"点了但 iframe 永远不出现"，看起来像岛坏了。
  const host =
    hosts.find((t) => t.type === 'page' && /5173|index\.html/.test(t.url || '')) || hosts[0];
  const NAME = '店铺账号管家（UI 岛）';
  let island = null;
  for (let i = 0; i < 60 && !island; i += 1) {
    await cdp(
      host,
      `(() => { const b = Array.from(document.querySelectorAll('nav button'))
          .find((x) => (x.innerText || '').trim() === ${JSON.stringify(NAME)});
        if (b) b.click(); return !!b; })()`,
    ).catch(() => false);
    await sleep(500);
    const list = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`).then((r) => r.json());
    island = list.find((t) => (t.url || '').startsWith(`sk-plugin://${ISLAND}/`));
  }
  check(!!island, '岛 iframe 已创建（跨源 iframe 是独立 target）');

  if (island) {
    const booted = await cdp(island, `(async () => { const s = window.__sk;
      if (!s || !s.ready) return false; await s.ready; return true; })()`);
    check(booted === true, '桥握手完成（window.__sk.ready 落地）');

    // 切到「店铺登记」页签
    const clicked = await cdp(
      island,
      `(() => { const btns = [...document.querySelectorAll('.main-tabs .tab')];
        const hit = btns.find((b) => (b.textContent || '').includes('店铺登记'));
        if (hit) hit.click(); return !!hit; })()`,
    );
    check(clicked === true, '「店铺登记」页签存在且可点击');

    await sleep(1200);
    const view = await cdp(
      island,
      `(() => { const root = document.querySelector('.registry');
        const err = document.querySelector('.error-bar');
        return JSON.stringify({
          mounted: !!root,
          title: (document.querySelector('.reg-title h3') || {}).textContent || '',
          panels: [...document.querySelectorAll('.panel-head h4')].map((h) => h.textContent.trim()),
          chips: [...document.querySelectorAll('.chips .chip')].map((c) => c.textContent.replace(/\\s+/g, ' ').trim()),
          error: err ? err.textContent.replace(/\\s+/g, ' ').trim() : '',
        }); })()`,
    );
    const v = JSON.parse(view || '{}');
    check(v.mounted === true, '页面已挂载（.registry）');
    check(/未归一的店铺名/.test(v.panels || ''), '「未归一的店铺名」面板已渲染', (v.panels || []).join(' / '));
    check(
      v.error === '',
      '无权限拒绝 / 加载错误（页面触发 ensure+list+unmapped+summary 四个 shop op）',
      v.error,
    );
    // 顶部统计条能出现 = shopSummary 真的回来了
    check((v.chips || []).length > 0, '汇总 chips 已渲染（shopSummary 返回成功）', v.chips);
  }
} finally {
  try {
    child.kill('SIGKILL');
  } catch {
    /* 已退出 */
  }
  await sleep(300);
  try {
    rmSync(userData, { recursive: true, force: true });
  } catch {
    /* 清理失败不影响结论 */
  }
}

console.log('');
if (failed) {
  console.log(`\u2717 「店铺登记」真机探针失败：${failed} 项`);
  process.exit(1);
}
console.log('\u2713 「店铺登记」真机探针全部通过');
