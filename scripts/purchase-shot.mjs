// 「拿货」页（拿货单列表 + 明细编辑器）的**取证截图**（不启动宿主，不需要 Electron）。
//
//   npm run purchase:shot              # 默认：1440×900
//   W=1152 npm run purchase:shot       # 窄视口（编辑器是 560px 抽屉，窄窗看挤压）
//   PROBE=1 npm run purchase:shot      # 额外打几何：抽屉宽度、表格 scrollWidth（溢出被裁的判据）
//
// 为什么单独一个脚本：布局类问题（错位、挤压、溢出被裁、视重不分）的唯一判据是人眼 ——
// `--dump-dom` 的冒烟只能回答"某个元素在不在、文案对不对"，回答不了"这一块**看着**是不是坏的"。
// 与 `goods-shot.mjs` 同一条理由、同一套做法。
//
// 复用 `today-ui-smoke.mjs` 里那份假桥（唯一真源）：扫描相邻反引号抽出。
// 硬约束规定该模板串内部不得出现反引号，所以"下一个反引号就是结尾"成立；若哪天有人塞了反引号，
// 这里会立刻抽错并在下面的校验里报错。
//
// 截图是**分阶段**的（导航 → 列表 → 开编辑器(1 行) → 加行填数(6 行) → 包价单），
// 因为「拿货单长什么样」不是一个静态画面：行少/行多、图有/图无、明细/包价都是不同的形态。

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'renderer');
const WORK = path.join('/tmp', 'sellerkit-purchase-shot');
const OUT = path.join(ROOT, '.cache', 'purchase-shot');
const PORT = 8152;
const CDP_PORT = 9352;
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

// ---- 抽出假桥（唯一真源在 today-ui-smoke.mjs）--------------------------------------------
const SMOKE_SRC = readFileSync(path.join(ROOT, 'scripts', 'today-ui-smoke.mjs'), 'utf8');
const BRIDGE_OPEN = 'const FAKE_BRIDGE = `';
const bi = SMOKE_SRC.indexOf(BRIDGE_OPEN);
if (bi === -1) {
  console.error('✗ 在 today-ui-smoke.mjs 里找不到 FAKE_BRIDGE 声明 —— 冒烟脚本被改过，这里要跟着改');
  process.exit(1);
}
const bStart = bi + BRIDGE_OPEN.length;
const bEnd = SMOKE_SRC.indexOf('`', bStart);
const FAKE_BRIDGE = SMOKE_SRC.slice(bStart, bEnd);
if (!FAKE_BRIDGE.includes('electronAPI') || FAKE_BRIDGE.length < 5000) {
  console.error('✗ 抽出来的假桥明显不对（长度或内容不符）—— 多半是有人往那个模板串里写了反引号');
  process.exit(1);
}

// ---- 第一阶段：只负责导航到「拿了什么」（后面的开编辑器 / 填行由 CDP 逐步驱动）------------
const ACTION = `<script type="module">
var log = function (m) { var el = document.getElementById('shot-log'); if (el) el.textContent = String(m); };
function q(s) { return document.querySelector(s); }
async function waitFor(fn, ms) {
  var t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) {} await new Promise(function (r) { setTimeout(r, 60); }); }
  return false;
}
(async function () {
  await waitFor(function () { return !!q('.td-view') && !!q('[data-act="tab-purchase"]'); }, 20000);
  q('[data-act="tab-purchase"]').click();
  await waitFor(function () { return !!q('[data-act="pu-sub-orders"]'); }, 10000);
  q('[data-act="pu-sub-orders"]').click();
  await waitFor(function () { return !!q('[data-act="pu-order-table"]'); }, 10000);
  await new Promise(function (r) { setTimeout(r, 400); });
  log('orders view ready');
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

// ---- CDP：等导航完成 → 分阶段驱动 → 截图 ---------------------------------------------------
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
  if (r.exceptionDetails) throw new Error('页面内异常: ' + JSON.stringify(r.exceptionDetails.exception && r.exceptionDetails.exception.description || r.exceptionDetails));
  return r.result && r.result.value;
}

await send('Page.enable');
await send('Runtime.enable');

async function waitPage(expr, ms, what) {
  for (let i = 0; i < Math.ceil(ms / 250); i++) {
    const ok = await evaluate(expr).catch(() => false);
    if (ok) return true;
    await sleep(250);
  }
  throw new Error('等不到：' + what);
}

mkdirSync(OUT, { recursive: true });

async function shot(name, clip) {
  const r = await send('Page.captureScreenshot', clip ? { format: 'png', clip } : { format: 'png' });
  const p = path.join(OUT, name + '.png');
  writeFileSync(p, Buffer.from(r.data, 'base64'));
  console.log('✓', p);
}

/** 抽屉特写（拿货单主体就 560px 宽，整窗图里看不清细节） */
async function shotDrawer(name) {
  const box = await evaluate(`(function(){
    var d = document.querySelector('.wb-drawer');
    if (!d) return null;
    var r = d.getBoundingClientRect();
    return { x: r.left, y: r.top, w: r.width, h: r.height };
  })()`);
  if (!box || box.w < 10) return;
  await shot(name, { x: Math.max(0, box.x), y: 0, width: box.w, height: Math.min(H, box.h), scale: 1 });
}

// 阶段 1：拿了什么（列表 + 面板头）
await waitPage('!!window.__shotReady', 30000, '导航到「拿了什么」');
await sleep(400);
await shot(`orders-${W}x${H}`);

// 阶段 2：打开 #3 的编辑器（夹具原样：1 行）
await evaluate(`(function(){ document.querySelector('[data-act="pu-edit-3"]').click(); return true; })()`);
await waitPage(`!!document.querySelector('[data-act="pue-table"]')`, 8000, '编辑器打开');
await waitPage(`(function(){ var im = document.querySelector('[data-act="pue-img-1"]'); return !!im && im.complete && im.naturalWidth > 0; })()`, 6000, '行图解码').catch(() => console.log('⚠ 行图没解码出来（截图继续）'));
await sleep(500);
await shot(`editor-open-${W}x${H}`);
await shotDrawer(`drawer-open-${W}x${H}`);

// 阶段 3：加 4 行填成一张"像真的"单（多行 / 有图有缺图 / 价格有填有空）
// ⚠️ 先改款色（会触发自动查历史价，异步），等一拍再填数量单价 —— 否则被自动回填覆盖。
const filled = await evaluate(`(async function () {
  function q(s) { return document.querySelector(s); }
  function setV(sel, v) {
    var el = q(sel); if (!el) return false;
    el.value = String(v);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    return true;
  }
  function setPair(uid, code, color) {
    setV('[data-act="pue-code-' + uid + '"]', code);
    setV('[data-act="pue-color-' + uid + '"]', color);
    var c = q('[data-act="pue-code-' + uid + '"]');
    if (c) c.dispatchEvent(new Event('change', { bubbles: true }));
  }
  var add = q('[data-act="pue-add"]');
  if (!add) return false;
  add.click(); add.click(); add.click(); add.click();
  await new Promise(function (r) { setTimeout(r, 150); });
  setPair(2, 'S2', '白');
  setPair(3, 'S1', '黑');
  setPair(4, 'S1', '白');
  setPair(5, 'S9', '蓝');
  await new Promise(function (r) { setTimeout(r, 500); });
  setV('[data-act="pue-size-2"]', 'M');  setV('[data-act="pue-qty-2"]', 3); setV('[data-act="pue-price-2"]', 25.5);
  setV('[data-act="pue-size-3"]', 'XL'); setV('[data-act="pue-qty-3"]', 1);
  setV('[data-act="pue-size-4"]', 'L');  setV('[data-act="pue-qty-4"]', 2); setV('[data-act="pue-price-4"]', 42);
  setV('[data-act="pue-size-5"]', 'L');  setV('[data-act="pue-qty-5"]', 2); setV('[data-act="pue-price-5"]', 12);
  await new Promise(function (r) { setTimeout(r, 800); });
  return true;
})()`);
if (filled) {
  await shot(`editor-filled-${W}x${H}`);
  await shotDrawer(`drawer-filled-${W}x${H}`);
} else console.log('⚠ 加行按钮找不到，跳过填行截图');

// 阶段 4：关掉再看包价单 #2（另一种形态：只记总额）
await evaluate(`(function(){ var x = document.querySelector('[data-act="pue-close"]'); if (x) x.click(); return true; })()`);
await waitPage(`!document.querySelector('[data-act="pue-table"]')`, 5000, '编辑器关闭');
await evaluate(`(function(){ document.querySelector('[data-act="pu-edit-2"]').click(); return true; })()`);
await waitPage(`!!document.querySelector('[data-act="pue-package"]')`, 8000, '包价编辑器打开');
await sleep(400);
await shot(`package-${W}x${H}`);

// PROBE=1：量几何 —— 编辑器里"挤不挤、有没有被裁"的判据（人眼之外的第二把尺）
if (process.env.PROBE === '1') {
  await evaluate(`(function(){ var x = document.querySelector('[data-act="pue-close"]'); if (x) x.click(); return true; })()`);
  await evaluate(`(function(){ document.querySelector('[data-act="pu-edit-3"]').click(); return true; })()`);
  await waitPage(`!!document.querySelector('[data-act="pue-table"]')`, 8000, '编辑器重开');
  await sleep(300);
  const probe = await evaluate(`(function(){
    function info(sel) {
      var el = document.querySelector(sel);
      if (!el) return null;
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      return { sel: sel, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
               sw: el.scrollWidth, cw: el.clientWidth, pos: cs.position, overflowX: cs.overflowX, fontSize: cs.fontSize };
    }
    return {
      innerWidth: window.innerWidth,
      drawer: info('.wb-drawer'),
      body: info('.pue__body'),
      wrap: info('.pue__body .wb-table-wrap'),
      table: info('[data-act="pue-table"]'),
      head: info('.pue__head'),
      bar: info('.pue__bar'),
      foot: info('.pue__foot'),
      imgcell: info('.pue__imgcell'),
      code: info('.pue__code'),
      color: info('.pue__color'),
      ops: info('.pue__ops'),
      total: info('.pue__total'),
    };
  })()`);
  console.log(JSON.stringify(probe, null, 1));
}

ws.close();
cp.kill('SIGTERM');
server.close();
setTimeout(() => process.exit(0), 300);
