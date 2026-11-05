// 「发货台 › 归类核对」页的**取证截图**（不启动宿主，不需要 Electron）。
//
//   npm run classify:shot              # 默认 1440×900：待核对 + 已核对两个范围各一张
//   W=1152 npm run classify:shot       # 窄视口（看挤压）
//   PROBE=1 npm run classify:shot      # 额外打几何：缩略图渲染尺寸 vs 原始尺寸、各容器溢出
//
// 为什么单独一个脚本：布局类问题（图被裁 / 列被挤 / 视重不分）的唯一判据是人眼 ——
// `--dump-dom` 的冒烟只能回答"某个元素在不在、文案对不对"，回答不了"这一块**看着**是不是坏的"。
// 与 `goods-shot.mjs` / `purchase-shot.mjs` 同一条理由、同一套做法。
//
// ⚠️ 本脚本**换掉假桥的缩略图**：`today-ui-smoke.mjs` 的 `svgThumb` 出的是 8×8 **正方形**，
//    而真库 35 张里 31 张是方图、4 张是竖版（800×1067 / 1350×1800 …）。
//    夹具只给正方形 ⇒ "竖版图在方框里被压成多小"这件事**永远看不到**（夹具要复刻生产形状）。
//    这里按真库的混合比例出图，两个范围各自覆盖"方 / 竖 / 无图"三种行。
//
// 复用 `today-ui-smoke.mjs` 里那份假桥（唯一真源）：扫描相邻反引号抽出。
// 硬约束规定该模板串内部不得出现反引号，所以"下一个反引号就是结尾"成立；若哪天有人塞了反引号，
// 这里会立刻抽错并在下面的校验里报错。

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'renderer');
const WORK = path.join('/tmp', 'sellerkit-classify-shot');
const OUT = path.join(ROOT, '.cache', 'classify-shot');
const PORT = 8162;
const CDP_PORT = 9362;
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

// ---- 覆盖缩略图假桥：按真库的长宽比混合出图 ---------------------------------------------
// 判据不是"图出来了"，而是"**这张图在屏幕上占了多大**"：
//   方图 800×800  → contain 进 64×64 方框 = 64×64（满格）
//   竖图 800×1067 → contain 进 64×64 方框 = 48×64（两侧各留 8px 空白，图只剩 3/4 宽）
// 两种都放，肉眼才能看出"方图满格、竖图被压窄"这个差异是不是用户说的"展示不全"。
// 只用单引号：本段整体在一个模板串里。
const THUMB_OVERRIDE = `<script>
(function () {
  var api = window.electronAPI;
  if (!api || typeof api.orderImageThumbBatch !== 'function') return;
  var orig = api.orderImageThumbBatch;
  // 真库实测：31 张方图（800×800 等）/ 4 张竖版（800×1067、1350×1800、1279×1706）。
  // 夹具按 localPath 末尾数字取形状：偶数=方图、奇数=竖图，保证同屏两种都有。
  function shapeOf(p) {
    var m = /(\\d+)$/.exec(String(p || ''));
    var n = m ? Number(m[1]) : 0;
    return n % 2 === 1 ? 'portrait' : 'square';
  }
  function svg(p) {
    var portrait = shapeOf(p) === 'portrait';
    var w = portrait ? 800 : 800;
    var h = portrait ? 1067 : 800;
    // 画一点可辨识的内容：竖图画"衣长刻度"、方图画"网格"——裁没裁、压没压肉眼可判。
    var inner = portrait
      ? '<rect x="0" y="0" width="800" height="1067" fill="#dbe6f2"/>' +
        '<rect x="250" y="120" width="300" height="700" fill="#5b7fa6"/>' +
        '<text x="400" y="900" font-size="60" text-anchor="middle" fill="#1b3a5c">竖</text>'
      : '<rect x="0" y="0" width="800" height="800" fill="#e8e2d4"/>' +
        '<rect x="200" y="200" width="400" height="400" fill="#a8895b"/>' +
        '<text x="400" y="420" font-size="60" text-anchor="middle" fill="#4a3a20">方</text>';
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + h + '">' + inner + '</svg>');
  }
  api.orderImageThumbBatch = function (items) {
    return orig.call(api, items).then(function (r) {
      if (r && r.success && r.data && Array.isArray(r.data.dataUrls)) {
        r.data.dataUrls = r.data.dataUrls.map(function (u, i) {
          var it = items && items[i];
          return it && it.localPath ? svg(it.localPath) : u;
        });
      }
      return r;
    });
  };
  api.__thumbShapeOf = shapeOf;
})();
</script>`;

const ACTION = `<script type="module">
var log = function (m) { var el = document.getElementById('shot-log'); if (el) el.textContent = String(m); };
function q(s) { return document.querySelector(s); }
async function waitFor(fn, ms) {
  var t0 = Date.now();
  while (Date.now() - t0 < ms) { try { if (fn()) return true; } catch (e) {} await new Promise(function (r) { setTimeout(r, 60); }); }
  return false;
}
(async function () {
  await waitFor(function () { return !!q('.td-view') && !!q('[data-act="tab-classify"]'); }, 20000);
  q('[data-act="tab-classify"]').click();
  await waitFor(function () { return !!q('[data-act="cl-table"]'); }, 10000);
  // 等缩略图真的解码出来再截：没解码时 <img> 是空壳，截图会漏掉"图到底有多大"
  await waitFor(function () {
    var ims = q('[data-act="cl-table"]').querySelectorAll('img');
    for (var i = 0; i < ims.length; i++) if (!ims[i].complete || ims[i].naturalWidth === 0) return false;
    return ims.length > 0;
  }, 8000);
  await new Promise(function (r) { setTimeout(r, 400); });
  log('classify ready');
  window.__shotReady = true;
})();
</script>`;

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
cpSync(DIST, WORK, { recursive: true });
const indexPath = path.join(WORK, 'index.html');
let html = readFileSync(indexPath, 'utf8');
html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '');
html = html.replace('</head>', () => FAKE_BRIDGE + THUMB_OVERRIDE + '</head>');
html = html.replace(
  '</body>',
  () => ACTION + '<pre id="shot-log" style="position:fixed;left:0;bottom:0;margin:0;font:10px monospace;opacity:.5"></pre></body>',
);
writeFileSync(indexPath, html);

const MIME = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.svg': 'image/svg+xml', '.png': 'image/png' };
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '').split('?')[0]);
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

/** 表格特写（整窗图里那一列图只有 64px，细节看不清） */
async function shotTable(name) {
  const box = await evaluate(`(function(){
    var t = document.querySelector('[data-act="cl-table"]');
    if (!t) return null;
    var r = t.getBoundingClientRect();
    return { x: Math.max(0, r.left - 8), y: Math.max(0, r.top - 8), w: r.width, h: r.height };
  })()`);
  if (!box || box.w < 10) return;
  await shot(name, { x: box.x, y: box.y, width: Math.min(W - box.x, box.w + 16), height: Math.min(H - box.y, box.h + 16), scale: 1 });
}

// 阶段 1：待核对范围（默认）
await waitPage('!!window.__shotReady', 30000, '导航到「归类核对」');
// 主题：默认跟随系统（headless 是亮色）。THEME=dark 时强制切暗色再截 ——
// 令牌驱动的样式在另一个主题下坏掉是"换了个设置就坏"，只看一个主题发现不了。
if (process.env.THEME === 'dark') {
  await evaluate(`document.documentElement.setAttribute('data-theme','dark')`);
  await sleep(250);
}
await sleep(300);
const tag = process.env.THEME === 'dark' ? 'dark-' : '';
await shot(`${tag}pending-${W}x${H}`);
await shotTable(`${tag}pending-table-${W}x${H}`);

// 阶段 2：切到已核对范围（同一张表的另一种形态：只读格 + 退回动作）
await evaluate(`(function(){ var b = document.querySelector('[data-act="cl-scope-corrected"]'); if (b) b.click(); return !!b; })()`);
await waitPage(`(function(){
  var t = document.querySelector('[data-act="cl-table"]');
  if (!t) return false;
  var ims = t.querySelectorAll('img');
  for (var i = 0; i < ims.length; i++) if (!ims[i].complete || ims[i].naturalWidth === 0) return false;
  return ims.length > 0;
})()`, 8000, '已核对范围出表').catch(() => console.log('⚠ 已核对范围没等到图（截图继续）'));
await sleep(400);
await shot(`${tag}corrected-${W}x${H}`);
await shotTable(`${tag}corrected-table-${W}x${H}`);

// 阶段 3：切回待核对，量几何（人眼之外的第二把尺）
await evaluate(`(function(){ var b = document.querySelector('[data-act="cl-scope-pending"]'); if (b) b.click(); return !!b; })()`);
await waitPage(`(function(){
  var t = document.querySelector('[data-act="cl-table"]');
  if (!t) return false;
  var ims = t.querySelectorAll('img');
  for (var i = 0; i < ims.length; i++) if (!ims[i].complete || ims[i].naturalWidth === 0) return false;
  return ims.length > 0;
})()`, 8000, '切回待核对').catch(() => {});
await sleep(300);

// 阶段 4：归属款选择器（2026-10-28 起取代原生下拉）—— 左栏订单图 + 带图款列表 + 色卡。
// 为什么必须留一张：它是这一步**唯一**的判断动线（"拿这张订单图去挑款"），
// 而"图够不够大 / 列表挤不挤 / 色卡能不能看清"这些问题，DOM 断言一条都答不了。
await evaluate(`(function(){ var b = document.querySelector('[data-act="cl-style-42"]'); if (b) b.click(); return !!b; })()`);
await waitPage(`!!document.querySelector('[data-act="sp-list"]')`, 8000, '打开归属款选择器')
  .catch(() => console.log('⚠ 归属款选择器没打开（截图继续）'));
await sleep(600);
await shot(`${tag}picker-${W}x${H}`);
await evaluate(`(function(){ var b = document.querySelector('[data-act="sp-cancel"]'); if (b) b.click(); return !!b; })()`);
await sleep(200);

// 阶段 5/6：批量（2026-10-28）—— 勾选列 + 吸底动作条 + 批量定款弹层。
// 为什么也要留图：批量这一层全是**版面**问题（勾选列会不会把图列挤窄、"已选 N 行"在
// 1440 宽的窗口里会不会把按钮挤成两行、分组卡片在一组/多组两种形态下是否都成立），
// DOM 断言只能答"元素在不在"，答不了"看不看得清、挤不挤"。
await evaluate(`(function(){ var b = document.querySelector('[data-act="cl-select-all"]'); if (b) b.click(); return !!b; })()`);
await sleep(350);
await shot(`${tag}bulk-bar-${W}x${H}`);
await evaluate(`(function(){ var b = document.querySelector('[data-act="cl-bulk-style"]'); if (b) b.click(); return !!b; })()`);
await waitPage(`!!document.querySelector('[data-act="bp-mask"]')`, 8000, '打开批量定款')
  .catch(() => console.log('⚠ 批量定款没打开（截图继续）'));
await sleep(700);
await shot(`${tag}bulk-picker-${W}x${H}`);

if (process.env.PROBE === '1') {
  const probe = await evaluate(`(function(){
    function info(sel) {
      var el = document.querySelector(sel);
      if (!el) return null;
      var r = el.getBoundingClientRect();
      var cs = getComputedStyle(el);
      return { sel: sel, x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height),
               sw: el.scrollWidth, cw: el.clientWidth, sh: el.scrollHeight, ch: el.clientHeight,
               overflow: cs.overflow, objectFit: cs.objectFit };
    }
    // 每张缩略图：渲染框 vs 原始像素 —— "展示不全"要量的是这一对
    var ims = [].slice.call(document.querySelectorAll('[data-act="cl-table"] img'));
    var thumbs = ims.map(function (im, i) {
      var r = im.getBoundingClientRect();
      var cell = im.closest('td');
      var cr = cell ? cell.getBoundingClientRect() : null;
      return { i: i, natural: im.naturalWidth + 'x' + im.naturalHeight,
               box: Math.round(r.width) + 'x' + Math.round(r.height),
               cellW: cr ? Math.round(cr.width) : null,
               ratio: (r.width / r.height).toFixed(3) };
    });
    var cols = [].slice.call(document.querySelectorAll('[data-act="cl-table"] thead th')).map(function (th) {
      return th.textContent.trim() + ':' + Math.round(th.getBoundingClientRect().width);
    });
    return {
      innerWidth: window.innerWidth,
      wrap: info('.wb-table-wrap'),
      table: info('[data-act="cl-table"]'),
      thumbCol: info('.cl-thumb-col'),
      firstImg: info('[data-act="cl-table"] img'),
      seg: info('.wb-seg'),
      page: info('.wb-page'),
      head: info('.wb-panel__head'),
      cols: cols,
      thumbs: thumbs,
    };
  })()`);
  console.log(JSON.stringify(probe, null, 1));
}

ws.close();
cp.kill('SIGTERM');
server.close();
setTimeout(() => process.exit(0), 300);
