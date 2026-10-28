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


// ---- 第五张：产品编辑抽屉里的 SKU 矩阵（规格区 + 组合区的版式）-------------------------
// 2026-10-23 起这是矩阵的**唯一维护面**（采集段的「修改 SKU 矩阵」弹层已撤）。
// 这一块的成败全在"看着挤不挤、一屏能不能同时看见规格和几列组合"，冒烟只能回答元素在不在。
const edOk = await evaluate(`(async function(){
  var btn = document.querySelector('[data-act="edit-product"]');
  if (!btn) return false;
  btn.click();
  var t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (document.querySelector('[data-act="ed-sku-block"]')) return true;
    await new Promise(function (r) { setTimeout(r, 80); });
  }
  return false;
})()`);
if (edOk) {
  await sleep(300);
  await shot(`sku-matrix-${W}x${H}`);
  // 抽屉自身的几何：宽高 + 规格区/组合区各占多少（"一屏能不能同时看见"是个可量的数）
  const edBox = await evaluate(`(function(){
    function box(sel) { var el = document.querySelector(sel); if (!el) return null;
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }
    // 颜色卡片与格内控件也要量：卡片等宽、格子里的对（开关 + 克重）居中 —— 这两条光看
    // 整页小图判断不了（缩放后差几十像素看不出，但那是"两张卡不一样宽"级别的缺陷）。
    var cards = Array.prototype.map.call(document.querySelectorAll('[data-act="ed-spec"] .mx-color'),
      function (c) { var r = c.getBoundingClientRect(); return [Math.round(r.left), Math.round(r.width)]; });
    var pair = document.querySelector('.ed-main .mx-cell__on');
    var pairBox = null;
    if (pair) {
      var pr = pair.getBoundingClientRect();
      var cell = pair.closest('td').getBoundingClientRect();
      pairBox = { cell: Math.round(cell.width), leftGap: Math.round(pr.left - cell.left),
                  rightGap: Math.round(cell.right - pr.right) };
    }
    return { drawer: box('.ed-drawer'), block: box('[data-act="ed-sku-block"]'),
             col: box('.ed-drawer .ed-col'), bar: box('.ed-drawer .ed-main__bar'),
             spec: box('[data-act="ed-spec"]'),
             table: box('.ed-main .mx-wrap'), foot: box('.ed-drawer .wb-dialog__foot'),
             vh: innerHeight, cards: cards, pairBox: pairBox };
  })()`);
  console.log('产品 SKU 矩阵几何：', JSON.stringify(edBox));

  // 命中测试：SKU 区每个可交互控件的**中心点**是否真的命中它自己。
  // 「页面根本没办法操作」最常见的物理原因就是有东西盖在上面（sticky 表头压住格子、
  // 浮层盖住 chip、容器把按钮裁掉一半），而"元素在 DOM 里"的断言对此完全无感 ——
  // 它在，只是点不到。`elementFromPoint` 是唯一能问出这件事的探针。
  const hits = await evaluate(`(function(){
    var root = document.querySelector('[data-act="ed-sku-block"]');
    if (!root) return null;
    var bad = [];
    var els = root.querySelectorAll('button,input,select,summary');
    var live = 0;
    for (var i = 0; i < els.length; i++) {
      var el = els[i];
      if (el.disabled) continue;
      // 折叠着的内容不算"被盖住"：Chromium 用 content-visibility: hidden 折 details，
      // 里面的控件仍有布局尺寸但不可见、不接收点击 —— 不排掉就是一片假阳性。
      if (el.closest('details:not([open])')) continue;
      if (el.checkVisibility && !el.checkVisibility({ checkVisibilityCSS: true })) continue;
      var r = el.getBoundingClientRect();
      if (r.width < 4 || r.height < 4) continue;
      var x = r.left + r.width / 2, y = r.top + r.height / 2;
      if (x < 0 || y < 0 || x > innerWidth || y > innerHeight) continue;
      live++;
      var got = document.elementFromPoint(x, y);
      if (got && (got === el || el.contains(got))) continue;
      bad.push({ act: el.dataset.act || el.tagName,
                 label: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || '').slice(0, 24),
                 hit: got ? String(got.className || got.tagName).slice(0, 40) : 'null',
                 at: [Math.round(r.left), Math.round(r.top), Math.round(r.width), Math.round(r.height)] });
    }
    return { live: live, blocked: bad.slice(0, 12), blockedCount: bad.length };
  })()`);
  console.log('SKU 区命中测试：', JSON.stringify(hits));
  if (hits && hits.blockedCount) console.log('⚠ 上面这些控件被盖住了（点在它们的中心点上会落到别人身上）');
} else console.log('⚠ 产品编辑抽屉没打开，跳过该张（先看上面产品表是否已渲染）');

// ---- 第六张：**多色多码**（8 色 × 5 码）--------------------------------------------------
// 用户实报「并入矩阵后 SKU 样式是乱的、有很多重叠、颜色不直观」时就是这个状态 ——
// 1 色 2 码的截图看不出任何问题（那一版自己也这么以为）。冒烟量的是数字
// （可见行 ≥ 7 / 规格区 ≤ 200px / 色块取到真色），这里再留一张**人能看懂**的图：
// 8 个色名一眼能不能分清、矩阵还剩几行。
// ⚠️ 这一步改了矩阵（未保存）⇒ 后面关抽屉必然弹「还有改动没保存」，由向导那一段的
//    `confirm-ok` 兜（那段本来就要处理"脏状态别带进向导"）。
const denseOk = await evaluate(`(async function(){
  function tick(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var add = document.querySelector('[data-act="ed-add"]');
  if (!add) return null;
  for (var i = 0; i < 7; i++) { add.click(); await tick(50); }
  var inputs = document.querySelectorAll('[data-act="ed-color"]');
  var names = ['藏青', '军绿', '米白', '酒红', '卡其', '浅灰', '粉'];
  for (var j = 0; j < names.length; j++) {
    var el = inputs[j + 1];                       // 第 0 个是原产品自己的「黑」
    if (!el) break;
    el.value = names[j];
    el.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await tick(150);
  var preset = document.querySelector('[data-act="ed-preset"][data-preset="full"]');
  if (preset) preset.click();                     // 常用 → S–XXL（只补缺的码）
  await tick(400);
  function box(sel) { var el = document.querySelector(sel); if (!el) return null;
    var r = el.getBoundingClientRect();
    return { w: Math.round(r.width), h: Math.round(r.height) }; }
  var wrap = document.querySelector('.ed-main .mx-wrap');
  var tr = document.querySelector('.ed-main .mx tbody tr');
  var rowsVisible = (wrap && tr) ? Math.floor(wrap.clientHeight / tr.getBoundingClientRect().height) : 0;
  return { colors: document.querySelectorAll('[data-act="ed-color"]').length,
           sizes: document.querySelectorAll('[data-act="ed-size"]').length,
           spec: box('[data-act="ed-spec"]'), table: box('.ed-main .mx-wrap'),
           rowsVisible: rowsVisible };
})()`);
if (denseOk) {
  await shot(`sku-matrix-dense-${W}x${H}`);
  console.log('8 色 5 码几何：', JSON.stringify(denseOk));
} else console.log('⚠ 没能造出多色多码状态（抽屉里找不到「＋ 颜色」）');

// ---- 编码规则 + 一键生成（2026-10-25 用户口径「SKU编码需要增加SKU规则设置，并支持一键设置」）----
// 这张图要回答的是：规则长什么样、填进去的编码是不是**看着合理**（款号-色-码）、
// 以及"只填空"之后已有编码有没有被覆盖。
const codeShot = await evaluate(`(async function(){
  function tick(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var d = document.querySelector('[data-act="ed-codes"]');
  if (!d) return null;
  if (!d.open) d.querySelector('summary').click();
  await tick(250);
  var gen = document.querySelector('[data-act="ed-code-gen"]');
  if (gen) gen.click();
  await tick(350);
  d.scrollIntoView({ block: 'end' });
  await tick(250);
  var inputs = document.querySelectorAll('.ed-codes__input');
  var filled = 0;
  for (var i = 0; i < inputs.length; i++) if (inputs[i].value.trim()) filled++;
  var prev = document.querySelector('[data-act="ed-code-preview"]');
  return { open: d.open, filled: filled, total: inputs.length,
           preview: prev ? prev.textContent.replace(/\\s+/g, ' ').trim() : '' };
})()`);
if (codeShot) {
  await shot(`sku-code-rule-${W}x${H}`);
  console.log('编码规则：', JSON.stringify(codeShot));
} else console.log('⚠ 抽屉里没有 SKU 编码区');

// ---- 第七张：拖色合并在**半路**的样子 --------------------------------------------------
// 用户口径（2026-10-24）「通过拖动颜色方式来合并」。这条交互只有两种状态看得见：
// 拖到一半（源 chip 变虚、目标 chip 高亮）和松手后的回执 —— 都得留图，否则
// "拖了没反应"和"拖对了但提示看不懂"只能靠猜。
const mergeShot = await evaluate(`(async function(){
  function tick(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function pev(type, x, y) {
    return new PointerEvent(type, { bubbles: true, cancelable: true,
      clientX: x, clientY: y, pointerId: 1, isPrimary: true, pointerType: 'mouse' });
  }
  var chips = document.querySelectorAll('[data-act="ed-spec"] .mx-color');
  if (chips.length < 3) return null;
  var src = chips[2], dst = chips[1];              // 「军绿」拖到「藏青」上
  var sr = src.getBoundingClientRect(), dr = dst.getBoundingClientRect();
  var box = document.querySelector('[data-act="ed-spec"] .mx-colors');
  src.dispatchEvent(pev('pointerdown', sr.left + 3, sr.top + 3));
  box.dispatchEvent(pev('pointermove', sr.left + 12, sr.top + 4));
  await tick(80);
  box.dispatchEvent(pev('pointermove', dr.left + dr.width / 2, dr.top + dr.height / 2));
  await tick(120);
  return { mid: { src: src.classList.contains('is-src'), drop: dst.classList.contains('is-drop') } };
})()`);
if (mergeShot) await shot(`sku-matrix-merging-${W}x${H}`);

const merged = await evaluate(`(async function(){
  function tick(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var box = document.querySelector('[data-act="ed-spec"] .mx-colors');
  var dst = document.querySelectorAll('[data-act="ed-spec"] .mx-color')[1];
  var dr = dst.getBoundingClientRect();
  box.dispatchEvent(new PointerEvent('pointerup', { bubbles: true, cancelable: true,
    clientX: dr.left + dr.width / 2, clientY: dr.top + dr.height / 2,
    pointerId: 1, isPrimary: true, pointerType: 'mouse' }));
  await tick(400);
  var hint = document.querySelector('[data-act="ed-merge-hint"]');
  return { colors: document.querySelectorAll('[data-act="ed-color"]').length,
           hint: hint ? hint.textContent.replace(/\\s+/g, ' ').trim() : '' };
})()`);
if (merged) {
  await shot(`sku-matrix-merged-${W}x${H}`);
  console.log('拖色合并：', JSON.stringify(merged));
}

// ---- 拖到「常用色」上**归类**（2026-10-24 用户口径：落点改成上面那排常用色）----------
// 这张图要回答的是"拖拽的落点长什么样"：常用色整排变成靶子（虚线描边）、悬停的那一个
// 实心反白。下面的 chip 只有 22px 高、还都是输入框，是用户说"拖动不太方便"的根源。
const classifyMid = await evaluate(`(async function(){
  function tick(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  function pev(type, x, y) {
    return new PointerEvent(type, { bubbles: true, cancelable: true,
      clientX: x, clientY: y, pointerId: 1, isPrimary: true, pointerType: 'mouse' });
  }
  // 找一个"不在常用色表里"的色名来演示归类（浅灰 归到 灰）
  var chips = document.querySelectorAll('[data-act="ed-spec"] .mx-color');
  var src = null;
  for (var i = 0; i < chips.length; i++) {
    var inp = chips[i].querySelector('[data-act="ed-color"]');
    if (inp && inp.value.trim() === '浅灰') { src = chips[i]; break; }
  }
  var pc = document.querySelector('[data-act="ed-common"][data-color="灰"]');
  if (!src || !pc) return null;
  var sr = src.getBoundingClientRect(), pr = pc.getBoundingClientRect();
  var root = document.querySelector('.ed-drawer .mx');
  src.dispatchEvent(pev('pointerdown', sr.left + 3, sr.top + 3));
  root.dispatchEvent(pev('pointermove', sr.left + 12, sr.top + 4));
  await tick(60);
  root.dispatchEvent(pev('pointermove', pr.left + pr.width / 2, pr.top + pr.height / 2));
  await tick(120);
  return { dragging: !!document.querySelector('.mx-palette--dragging'),
           drop: pc.classList.contains('is-drop'), x: pr.left + pr.width / 2, y: pr.top + pr.height / 2 };
})()`);
if (classifyMid) {
  await shot(`sku-palette-classify-${W}x${H}`);
  const done = await evaluate(`(async function(){
    function tick(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
    var pc = document.querySelector('[data-act="ed-common"][data-color="灰"]');
    var pr = pc.getBoundingClientRect();
    document.querySelector('.ed-drawer .mx').dispatchEvent(new PointerEvent('pointerup', {
      bubbles: true, cancelable: true, clientX: pr.left + pr.width / 2,
      clientY: pr.top + pr.height / 2, pointerId: 1, isPrimary: true, pointerType: 'mouse' }));
    await tick(400);
    var hint = document.querySelector('[data-act="ed-merge-hint"]');
    return { colors: document.querySelectorAll('[data-act="ed-color"]').length,
             names: Array.prototype.map.call(document.querySelectorAll('[data-act="ed-color"]'),
               function (i) { return i.value; }).join('/'),
             hint: hint ? hint.textContent.replace(/\\s+/g, ' ').trim() : '' };
  })()`);
  await shot(`sku-palette-classified-${W}x${H}`);
  console.log('拖色归类：', JSON.stringify({ mid: classifyMid, after: done }));
} else console.log('⚠ 没造出归类态（找不到「浅灰」或常用色「灰」）');

// ---- 色名候选（2026-10-25 用户口径「拖动区域太小」→ 不拖也能改叫法）-------------------
// 拖动天生要求精度（抓手 28px、落点 74x48），而"这一色该叫什么"本质是挑一个词。
// 这张图要回答的是：点进色名之后，人能不能一眼看出"选它会怎样"（归类 / 并进已有 / 合并两行）。
const sugShot = await evaluate(`(async function(){
  function tick(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
  var input = document.querySelector('[data-act="ed-spec"] [data-act="ed-color"]');
  if (!input) return null;
  input.focus();
  await tick(260);
  var box = document.querySelector('[data-act="ed-color-suggest"]');
  if (!box) return null;
  var r = box.getBoundingClientRect();
  return { items: document.querySelectorAll('[data-act="ed-color-suggest-item"]').length,
           box: { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) },
           inViewport: r.top >= 0 && r.bottom <= innerHeight && r.left >= 0 && r.right <= innerWidth };
})()`);
if (sugShot) {
  await shot(`sku-color-suggest-${W}x${H}`);
  console.log('色名候选：', JSON.stringify(sugShot));
  await evaluate('(function(){ var el = document.activeElement; if (el && el.blur) el.blur(); return true; })()');
} else console.log('⚠ 色名候选没有弹出来（focus 后找不到浮层）');

// ---- 真鼠标拖动（CDP Input）--------------------------------------------------------------
// 上面两张用的是**合成** PointerEvent（冒烟只能 `--dump-dom`，没法发可信输入）。合成事件
// 走不到 Chromium 的原生图片拖放 ⇒ 抓不到"从缩略图按下先起一个原生 dragstart"这类真机故障
// （`<img>` 默认可拖：`dragstart` 一来指针事件就断了，`pointerup` 永远等不到 = "拖不动"）。
// 这里用可信输入再拖一次（米白 → 常用色「白」），把 mid/after 打出来。
const realPre = await evaluate(`(function(){
  function at(el) { var r = el.getBoundingClientRect(); return { x: Math.round(r.left + 9), y: Math.round(r.top + r.height / 2) }; }
  var chips = document.querySelectorAll('[data-act="ed-spec"] .mx-color');
  var src = null;
  for (var i = 0; i < chips.length; i++) {
    var inp = chips[i].querySelector('[data-act="ed-color"]');
    if (inp && inp.value.trim() === '米白') { src = chips[i]; break; }
  }
  var pc = document.querySelector('[data-act="ed-common"][data-color="白"]');
  if (!src || !pc) return null;
  return { from: at(src), to: at(pc),
           names: Array.prototype.map.call(document.querySelectorAll('[data-act="ed-color"]'),
             function (i) { return i.value; }).join('/') };
})()`);
if (realPre) {
  const pt = (t) => ({
    x: Math.round(realPre.from.x + (realPre.to.x - realPre.from.x) * t),
    y: Math.round(realPre.from.y + (realPre.to.y - realPre.from.y) * t),
  });
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', ...pt(0), button: 'left', buttons: 1, clickCount: 1 });
  for (let i = 1; i <= 6; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mouseMoved', ...pt(i / 6), button: 'left', buttons: 1 });
    await sleep(50);
  }
  const mid = await evaluate(`(function(){
    var pc = document.querySelector('[data-act="ed-common"][data-color="白"]');
    return { dragging: !!document.querySelector('.mx-palette--dragging'),
             drop: pc.classList.contains('is-drop') };
  })()`);
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', ...pt(1), button: 'left', buttons: 0, clickCount: 1 });
  await sleep(400);
  const post = await evaluate(`(function(){
    var hint = document.querySelector('[data-act="ed-merge-hint"]');
    return { names: Array.prototype.map.call(document.querySelectorAll('[data-act="ed-color"]'),
               function (i) { return i.value; }).join('/'),
             hint: hint ? hint.textContent.replace(/\\s+/g, ' ').trim() : '' };
  })()`);
  console.log('真鼠标拖动（米白 → 白）：', JSON.stringify({ mid: mid, before: realPre.names, after: post }));
  await shot(`sku-palette-realdrag-${W}x${H}`);
} else console.log('⚠ 真鼠标拖动探针跳过（找不到「米白」或常用色「白」）');

// ---- 第六张：建款向导（同一个矩阵组件，但这里是 640px 抽屉 —— 规格区在窄容器里挤不挤）----
// 两处共用 `SkuMatrixEditor`：产品抽屉与向导都是窄容器（640），规格区是"标签列 + 内容列"，
// 窄容器里颜色卡片会掉到 2 列、尺码 chip 会换行 —— 这些只有截图看得见。
const iwOk = await evaluate(`(async function(){
  var x = document.querySelector('.ed-drawer .ed-x');
  if (x) x.click();
  await new Promise(function (r) { setTimeout(r, 300); });
  // 抽屉若提示"还有 N 处改动没保存"，截图脚本没改过矩阵 ⇒ 直接丢弃（别把脏状态带进向导）
  var ok = document.querySelector('[data-act="confirm-ok"]');
  if (ok) ok.click();
  await new Promise(function (r) { setTimeout(r, 300); });
  var seg = document.querySelector('[data-act="sub-items"]');
  if (seg) seg.click();
  await new Promise(function (r) { setTimeout(r, 300); });
  var cb = document.querySelector('[data-act="items-table"] tbody input[type="checkbox"]');
  if (cb) cb.click();
  await new Promise(function (r) { setTimeout(r, 300); });
  var btn = document.querySelector('[data-act="items-new-product"]');
  if (!btn || btn.disabled) return false;
  btn.click();
  var t0 = Date.now();
  while (Date.now() - t0 < 8000) {
    if (document.querySelector('[data-act="iw-sku-row"]')) return true;
    await new Promise(function (r) { setTimeout(r, 80); });
  }
  return false;
})()`);
if (iwOk) {
  await sleep(300);
  await shot(`sku-wizard-${W}x${H}`);
  const iwBox = await evaluate(`(function(){
    function box(sel) { var el = document.querySelector(sel); if (!el) return null;
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.left), y: Math.round(r.top), w: Math.round(r.width), h: Math.round(r.height) }; }
    return { drawer: box('.iw-drawer'), spec: box('[data-act="iw-sku-spec"]'),
             table: box('.iw-sku .mx-wrap'), weightRow: box('[data-act="iw-sku-default-weight"]') };
  })()`);
  console.log('建款向导几何：', JSON.stringify(iwBox));
} else console.log('⚠ 建款向导没打开，跳过该张（要先勾一行才可点「新建款并关联」）');

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
      info('[data-act="detail-links"]'),
      info('.gd-detail__meta'),
      info('.gd-detail__ops'),
      { btnHitTest: at, scrollY: window.scrollY }
    ];
  })()`);
  console.log(JSON.stringify(probe, null, 1));
  // 「展示不全」类问题的专属度量：容器宽度 → 卡片宽度 → 子表 min-content 宽度。
  // 判据是 scrollWidth > clientWidth（横向溢出被裁）与表格 rect 宽度超过卡片。
  const overflow = await evaluate(`(function(){
    function box(el) { if (!el) return null; var r = el.getBoundingClientRect();
      return { w: Math.round(r.width), sw: el.scrollWidth, cw: el.clientWidth, x: Math.round(r.left) }; }
    var pane = document.querySelector('[data-act="pane-products"]');
    var detail = document.querySelector('[data-act="row-detail"]');
    var grid = document.querySelector('.gd-detail');
    var blocks = Array.prototype.map.call(document.querySelectorAll('.gd-detail__block'), function (b) {
      var l = b.querySelector('[data-act="detail-links"]');
      return { block: box(b), inner: box(l), innerSel: l ? 'detail-links' : null };
    });
    var body = document.querySelector('.gd-panel__body, .wb-panel__body');
    var rel = document.querySelector('.gd-detail__relate');
    return { innerWidth: window.innerWidth, pane: box(pane), detail: box(detail),
             grid: box(grid), gridCols: grid ? getComputedStyle(grid).gridTemplateColumns : null,
             relate: box(rel), blocks: blocks,
             bodyScrollX: body ? body.scrollWidth - body.clientWidth : null,
             bodyW: body ? body.clientWidth : null };
  })()`);
  console.log('overflow:', JSON.stringify(overflow, null, 1));
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
