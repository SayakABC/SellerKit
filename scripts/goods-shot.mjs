// 「货与成本」页的**取证截图**（不启动宿主，不需要 Electron）。
//
//   npm run goods:shot            # 默认：1440×900（两栏并排）
//   W=1000 npm run goods:shot     # 窄视口
//
// 为什么单独一个脚本：`--dump-dom` 的冒烟只能回答"某个元素在不在、文案对不对"，
// 回答不了"这一块**看着**是不是坏的"（错位、重叠、被裁、深浅不分）。
// 布局类问题的唯一判据是人眼 —— 所以这里只负责**把界面按指定状态渲染出来并落 PNG**，
// 不做任何断言。
//
// 复用 `goods-ui-smoke.mjs` 里那份假桥（唯一真源）：用**扫描相邻反引号**的方式抽出来。
// 本仓硬约束规定那两个模板串内部不得出现反引号，所以"下一个反引号就是结尾"是成立的 ——
// 这条偷懒的解析方式因此是安全的；若哪天有人往假桥里塞了反引号，这里会立刻抽错并报错（见下）。

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'renderer');
const WORK = path.join('/tmp', 'sellerkit-goods-shot');
const OUT = path.join(ROOT, '.cache', 'goods-shot');
const PORT = 8151;
const CDP_PORT = 9351;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const W = Number(process.env.W) || 1440;
const H = Number(process.env.H) || 900;

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error(`✗ 找不到构建产物 ${DIST}/index.html —— 先跑 npm run build`);
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error(`✗ 找不到无头 Chrome：${CHROME}`);
  process.exit(1);
}

// ---- 抽出假桥（唯一真源在 goods-ui-smoke.mjs）-------------------------------------------
const SMOKE_SRC = readFileSync(path.join(ROOT, 'scripts', 'goods-ui-smoke.mjs'), 'utf8');
const BRIDGE_OPEN = 'const FAKE_BRIDGE = `';
const bi = SMOKE_SRC.indexOf(BRIDGE_OPEN);
if (bi === -1) {
  console.error('✗ 在 goods-ui-smoke.mjs 里找不到 FAKE_BRIDGE 声明 —— 冒烟脚本被改过，这里要跟着改');
  process.exit(1);
}
const bStart = bi + BRIDGE_OPEN.length;
const bEnd = SMOKE_SRC.indexOf('`', bStart);
const FAKE_BRIDGE = SMOKE_SRC.slice(bStart, bEnd);
// 抽出来的东西至少要**像**那座桥：装的是渲染层用的 `window.electronAPI`（不是插件岛的 `__sk` 桥），
// 且长度对得上。长度不足或缺这个键 ⇒ 多半是有人往模板串里写了反引号，抽到一半就断了。
if (!FAKE_BRIDGE.includes('electronAPI') || FAKE_BRIDGE.length < 5000) {
  console.error('✗ 抽出来的假桥明显不对（长度或内容不符）—— 多半是有人往那个模板串里写了反引号');
  process.exit(1);
}

// ---- 渲染状态：把第一个产品行展开 --------------------------------------------------------
const ACTION = `<script type="module">
var log = function (m) { var el = document.getElementById('shot-log'); if (el) el.textContent = String(m); };
function rows() { return document.querySelectorAll('[data-act="product-table"] tbody tr[data-product-id]'); }
async function waitFor(fn, ms) {
  var t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) {} await new Promise(function (r) { setTimeout(r, 60); }); }
  return false;
}
(async function () {
  await waitFor(function () { return rows().length >= 2; }, 15000);
  var r = rows()[0];
  if (r) r.click();
  await waitFor(function () { return !!document.querySelector('[data-act="row-detail"]'); }, 8000);
  var d = document.querySelector('[data-act="row-detail"]');
  if (d) d.scrollIntoView({ block: 'center' });
  await new Promise(function (res) { setTimeout(res, 600); });
  log('rows=' + rows().length + ' detail=' + (d ? 'yes' : 'no'));
  window.__shotReady = true;
})();
</script>`;

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
cpSync(DIST, WORK, { recursive: true });
const indexPath = path.join(WORK, 'index.html');
let html = readFileSync(indexPath, 'utf8');
html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '');
html = html.replace('</head>', () => FAKE_BRIDGE + '</head>');
html = html.replace(
  '</body>',
  () => ACTION + '<pre id="shot-log" style="position:fixed;left:0;bottom:0;margin:0;font:10px monospace;opacity:.5"></pre></body>',
);
writeFileSync(indexPath, html);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(WORK, rel === '/' ? '/index.html' : rel);
  if (!file.startsWith(WORK)) { res.writeHead(403); res.end('forbidden'); return; }
  try {
    const buf = readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch { res.writeHead(404); res.end('not found'); }
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

// ---- CDP：等渲染完成 → 截图 --------------------------------------------------------------
const cp = spawn(CHROME, [
  '--headless=new', '--disable-gpu', '--no-sandbox', '--hide-scrollbars',
  `--remote-debugging-port=${CDP_PORT}`,
  `--window-size=${W},${H}`,
  '--user-data-dir=' + path.join(WORK, 'profile'),
  `http://127.0.0.1:${PORT}/index.html`,
], { stdio: 'ignore' });

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function cdpUrl() {
  for (let i = 0; i < 60; i++) {
    try {
      const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
      const list = await res.json();
      const page = list.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
      if (page) return page.webSocketDebuggerUrl;
    } catch { /* 还没起来 */ }
    await sleep(250);
  }
  throw new Error('等不到 CDP 端口');
}

const wsUrl = await cdpUrl();
const ws = new WebSocket(wsUrl);
await new Promise((resolve, reject) => {
  ws.addEventListener('open', resolve);
  ws.addEventListener('error', reject);
});
let msgId = 0;
const pending = new Map();
ws.addEventListener('message', (ev) => {
  let m; try { m = JSON.parse(String(ev.data)); } catch { return; }
  if (m.id && pending.has(m.id)) { pending.get(m.id)(m); pending.delete(m.id); }
});
function send(method, params) {
  const id = ++msgId;
  return new Promise((resolve, reject) => {
    pending.set(id, (m) => (m.error ? reject(new Error(method + ': ' + JSON.stringify(m.error))) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params: params || {} }));
  });
}
async function evaluate(expr) {
  const r = await send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
  return r.result && r.result.value;
}

await send('Page.enable');
await send('Runtime.enable');

// 等注入脚本报 ready（它自己等数据、点开第一行、滚到可见）
for (let i = 0; i < 120; i++) {
  const ready = await evaluate('!!window.__shotReady').catch(() => false);
  if (ready) break;
  await sleep(250);
}
await sleep(400);

mkdirSync(OUT, { recursive: true });

async function shot(name, clip) {
  const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
  const p = path.join(OUT, name + '.png');
  writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('✓', p);
}

await shot(`full-${W}x${H}`);

// 展开区单独特写（绝对页面坐标 = 视口坐标 + 各层滚动偏移）
const box = await evaluate(`(function(){
  var d = document.querySelector('[data-act="row-detail"]');
  if (!d) return null;
  var r = d.getBoundingClientRect();
  var sx = window.scrollX || 0, sy = window.scrollY || 0;
  return { x: r.left + sx, y: r.top + sy, w: r.width, h: r.height };
})()`);
if (box && box.w > 10 && box.h > 10) {
  await shot(`detail-${W}x${H}`, { x: Math.max(0, box.x - 8), y: Math.max(0, box.y - 8), width: Math.min(W, box.w + 16), height: box.h + 16, scale: 1 });
}
const logText = await evaluate('(document.getElementById("shot-log")||{}).textContent || ""');
console.log('状态：', logText);

// PROBE=1 时额外量几何：谁压着谁、各块的矩形与 z-index/position —— 布局类缺陷的判据，
// 不靠人眼猜"是不是重叠"。
if (process.env.PROBE === '1') {
  const probe = await evaluate(`(function(){
    function info(sel) {
      var el = document.querySelector(sel);
      if (!el) return null;
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      return { sel: sel, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
               pos: cs.position, z: cs.zIndex, bg: cs.backgroundColor };
    }
    var btn = document.querySelector('[data-act="relate-from-expanded"]');
    var at = null;
    if (btn) {
      var r = btn.getBoundingClientRect();
      var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      at = hit ? (hit.tagName + '.' + (hit.className && hit.className.baseVal === undefined ? hit.className : '') ) : null;
    }
    return [
      info('.gd-pane__table thead th'),
      info('[data-act="product-table"] tbody tr[data-product-id]'),
      info('[data-act="row-detail"]'),
      info('.gd-detail__relate'),
      info('[data-act="relate-from-expanded"]'),
      info('.gd-detail__note'),
      info('[data-act="variant-table"]'),
      info('.gd-detail__ops'),
      { btnHitTest: at, scrollY: window.scrollY }
    ];
  })()`);
  console.log(JSON.stringify(probe, null, 1));
  // 找出按钮到根之间所有会创建 stacking context 的祖先（z-index 抬升类缺陷的唯一来源）
  const chain = await evaluate(`(function(){
    var el = document.querySelector('[data-act="relate-from-expanded"]');
    var out = [];
    while (el && el !== document.documentElement) {
      var cs = getComputedStyle(el);
      var ctx = [];
      if (cs.transform !== 'none') ctx.push('transform');
      if (cs.filter !== 'none') ctx.push('filter');
      if (cs.backdropFilter && cs.backdropFilter !== 'none') ctx.push('backdrop-filter');
      if (cs.perspective !== 'none') ctx.push('perspective');
      if (cs.willChange && cs.willChange !== 'auto') ctx.push('will-change:' + cs.willChange);
      if (cs.isolation === 'isolate') ctx.push('isolation');
      if (cs.contain && cs.contain !== 'none') ctx.push('contain:' + cs.contain);
      if (cs.position !== 'static' && cs.zIndex !== 'auto') ctx.push('pos:' + cs.position + ' z:' + cs.zIndex);
      if (parseFloat(cs.opacity) < 1) ctx.push('opacity:' + cs.opacity);
      out.push({ tag: el.tagName, cls: String(el.className).slice(0, 60), ctx: ctx.join(',') });
      el = el.parentElement;
    }
    return out;
  })()`);

  const hint = await evaluate(`(function(){
    var el = document.querySelector('[data-act="relate-hint"]');
    if (!el) return null;
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    var parent = el.parentElement.getBoundingClientRect();
    return { hint: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
             parent: { x: Math.round(parent.left), y: Math.round(parent.top), w: Math.round(parent.width), h: Math.round(parent.height) },
             display: cs.display, whiteSpace: cs.whiteSpace, pos: cs.position, fontSize: cs.fontSize };
  })()`);
  console.log('hint:', JSON.stringify(hint));
  console.log('--- 按钮祖先链（含 stacking context 的会标出）---');
  for (const c of chain) if (c.ctx || c.cls) console.log(c.ctx ? '* ' : '  ', c.tag, c.cls || '', c.ctx || '');
}

ws.close();
cp.kill('SIGTERM');
server.close();
setTimeout(() => process.exit(0), 300);
