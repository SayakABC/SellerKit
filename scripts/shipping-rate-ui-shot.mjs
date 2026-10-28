// 「基础数据 › 物流运费 › 运费查询」页的**截图取证**（一次性工具，不是门禁）。
//
//   node scripts/shipping-rate-ui-shot.mjs
//
// 为什么单独一个文件而不是给冒烟加个开关：冒烟判 DOM 语义（钉 data-act），
// 截图判**视觉**（列塌了、字叠了、深浅不分）。取证通道不同 —— dump-dom
// 只给文本与 class，给不出"看起来是什么样"。
// 假桥与夹具**从冒烟脚本里切出来**（不复制粘贴）⇒ 截出来的就是冒烟在跑的那条链，
// 不会出现"截图脚本另造一份桩、看到的东西不是真实形状"。
//
// 产物：/tmp/sellerkit-ship-shot/{wide,narrow}.png

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'renderer');
const WORK = path.join('/tmp', 'sellerkit-ship-shot-work');
const OUT = path.join('/tmp', 'sellerkit-ship-shot');
const PORT = 8141;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/** 从冒烟脚本切出 FAKE_BRIDGE 的模板内容（按 `const FAKE_BRIDGE = \`` 与收尾的 `.replace(` 定位） */
function fakeBridgeFromSmoke() {
  const src = readFileSync(path.join(ROOT, 'scripts', 'shipping-rate-ui-smoke.mjs'), 'utf-8');
  const startMark = 'const FAKE_BRIDGE = `<script>';
  const a = src.indexOf(startMark);
  if (a < 0) throw new Error('冒烟脚本里找不到 FAKE_BRIDGE 起始标记');
  const bodyStart = a + startMark.length;
  // 收尾形如 "</script>" + 反引号 + ".replace(...)"（同一行，见冒烟脚本末尾）
  const endMark = '</script>`';
  const b = src.indexOf(endMark, bodyStart);
  if (b < 0) throw new Error('冒烟脚本里找不到 FAKE_BRIDGE 收尾');
  const body = src.slice(bodyStart, b) + '</script>';
  const b64 = readFileSync(path.join(ROOT, 'tests', 'fixtures', 'shipping-rate.xlsx')).toString('base64');
  return '<script>\n' + body.replace('__FIXTURE_B64__', b64) + '\n';
}

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error(`✗ 找不到构建产物 ${DIST}/index.html —— 先跑 npm run build`);
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error(`✗ 找不到无头 Chrome：${CHROME}`);
  process.exit(1);
}

const FAKE_BRIDGE = fakeBridgeFromSmoke();

// 只做一件事：把「运费查询」页签准备到**有表可显示**的状态，然后停下等人看截图。
// 空态页签截不出表格样式，而空态本身已被冒烟覆盖。
const SHOT_SCRIPT = `<script type="module">
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function settle(fn, ms) {
  var t0 = Date.now();
  return (async function loop() {
    while (!fn() && Date.now() - t0 < (ms || 8000)) await sleep(60);
  })();
}
async function main() {
  await settle(function () { return document.querySelector('.md-view'); }, 15000);
  document.querySelector('[data-act="kind-shipping"]').click();
  await settle(function () {
    var p = document.querySelector('[data-act="shipping-rate-pane"]');
    return p && p.getClientRects().length;
  }, 10000);
  document.querySelector('[data-act="ship-tab-rates"]').click();
  await settle(function () { return document.querySelector('[data-act="ship-source"]'); }, 8000);
  var imp = document.querySelector('[data-act="ship-source"] [data-act="ship-import"]');
  if (imp) {
    imp.click();
    await settle(function () {
      return (window.__smokeCalls && window.__smokeCalls.shipRateSnapshotSave || []).length >= 1;
    }, 25000);
    await settle(function () { return document.querySelector('[data-act="ship-sections"]'); }, 15000);
  }
  document.querySelector('[data-act="ship-tab-quote"]').click();
  await settle(function () { return document.querySelector('[data-act="ship-quote-table"]'); }, 10000);
  await sleep(700);
  probe();
  return true;
}

/* 量测通道：DOM 里有、截图上没有 ⇒ 只能是"布局把它放到了看不见的地方"。
   只量关键节点（面板壳 / 结果区 / 表格容器 / 表头首格）的 rect 与影响可见性的样式，
   往 #probe 里写一行一条；--dump-dom 后读它。 */
function probe() {
  var out = [];
  function q(sel) { return document.querySelector(sel); }
  function row(label, el) {
    if (!el) { out.push(label + ' :: MISSING'); return; }
    var r = el.getBoundingClientRect();
    var cs = getComputedStyle(el);
    out.push(label +
      ' :: rect=' + [Math.round(r.x), Math.round(r.y), Math.round(r.width), Math.round(r.height)].join(',') +
      ' display=' + cs.display + ' pos=' + cs.position +
      ' overflow=' + cs.overflow + ' overflowY=' + cs.overflowY +
      ' flex=' + cs.flex + ' minH=' + cs.minHeight + ' maxH=' + cs.maxHeight +
      ' color=' + cs.color + ' bg=' + cs.backgroundColor +
      ' visibility=' + cs.visibility + ' opacity=' + cs.opacity +
      ' clientH=' + el.clientHeight + ' scrollH=' + el.scrollHeight);
  }
  row('pane', q('[data-act="shipping-rate-pane"]'));
  row('pane-body', q('[data-act="shipping-rate-pane"] .wb-panel__body') || q('[data-act="shipping-rate-pane"] > *'));
  row('srq(页签内容根)', q('[data-act="shipping-rate-pane"] .srq'));
  row('toolbar', q('.srq__toolbar'));
  row('results', q('.srq__results'));
  row('summary', q('[data-act="ship-summary"]'));
  row('table-wrap', q('.srq__results .wb-table-wrap'));
  row('table', q('[data-act="ship-quote-table"]'));
  row('thead-th', q('[data-act="ship-quote-table"] thead th'));
  row('tbody-tr1', q('[data-act="ship-quote-table"] tbody tr'));
  row('tbody-tr1-td1', q('[data-act="ship-quote-table"] tbody tr td'));
  // 视口
  out.push('viewport :: innerW=' + innerWidth + ' innerH=' + innerHeight +
    ' docScrollH=' + document.documentElement.scrollHeight);
  var pre = document.createElement('pre');
  pre.id = 'probe';
  pre.textContent = out.join('\\n');
  document.body.appendChild(pre);
}
main().then(function () { document.title = 'SHOT-READY'; },
  function (e) { document.title = 'SHOT-ERR ' + String((e && e.message) || e); });
</script>`;

mkdirSync(OUT, { recursive: true });
rmSync(WORK, { recursive: true, force: true });
cpSync(DIST, WORK, { recursive: true });
const indexPath = path.join(WORK, 'index.html');
let html = readFileSync(indexPath, 'utf8');
html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '');
html = html.replace('</head>', () => FAKE_BRIDGE + '</head>');
html = html.replace('</body>', () => SHOT_SCRIPT + '</body>');
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

// 同一份准备流程跑两遍通道：
//   --screenshot 出 PNG（判视觉）；--dump-dom 出 HTML（判 DOM，截图空白时用来定位是"没渲染"还是"渲染了但看不见"）
const wantDom = process.argv.includes('--dump-dom');

for (const s of [{ size: '1440,1000', name: 'wide' }, { size: '900,1400', name: 'narrow' }]) {
  const flags = [
    '--headless=new', '--disable-gpu', '--no-sandbox',
    `--window-size=${s.size}`,
    '--virtual-time-budget=90000',
  ];
  if (wantDom) flags.push('--dump-dom');
  else flags.push(`--screenshot=${path.join(OUT, `${s.name}.png`)}`);

  const dom = await new Promise((resolve) => {
    const cp = spawn(CHROME, [...flags, `http://127.0.0.1:${PORT}/index.html`], {
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let out = '';
    cp.stdout.on('data', (d) => (out += String(d)));
    cp.on('close', () => resolve(out));
  });

  if (wantDom) {
    const outFile = path.join(OUT, `${s.name}.html`);
    writeFileSync(outFile, dom);
    const m = dom.match(/<title>([\s\S]*?)<\/title>/);
    console.log(`${s.name} → ${outFile}  title=${m ? m[1] : '(no title)'}  bytes=${dom.length}`);
  } else {
    const outFile = path.join(OUT, `${s.name}.png`);
    console.log(`${s.name} (${s.size}) → ${outFile}  bytes=${existsSync(outFile) ? readFileSync(outFile).length : 0}`);
  }
}
server.close();