// shipping-rate 岛（无忧物流运费）的**假桥无头冒烟**（不启动宿主，不需要 Electron）。
//
//   npm run shipping-rate:ui
//
// 为什么需要它：手写岛（`dist/` 即源码、无构建、无类型门禁）改了接线，唯一能自动化的是
// "假桥 + 无头浏览器真点一遍"。本岛 1.3.0 做了 M6「运价表回迁宿主」——
// `quote` / `quoteOrders` / `quoteProducts` **不再由岛传表**、岛改为从 `rateCurrent` 取只读副本、
// 首启还要把旧的岛内表一次性迁移上去。这类改动错了全是静默的：
// op 名拼错、岛仍把整张表传回宿主（两份真相又回来了）、迁移没发生（用户"运价表凭空没了"），
// 页面都"看起来正常"。
//
// 两个来回（同一次运行打两遍页面）：
//   A 冷启动：宿主没有快照 + 岛内也没有旧表 → 空态；不该去算、不该有迁移调用
//   B 迁移：岛内**有**旧表、宿主没有 → 必须发生 rateAdopt（带表）→ 取回当前表 → 渲染，
//          并把岛内那份陈旧副本抹掉（saveConfig {table:null}）；**计价 payload 里不许再出现 table**
//
// 做法（照技能 `esm-spa-headless-smoke`；本仓**手写岛冒烟的现役样板** —— 原先同款的
//   `order-insight:picking:ui` / `order-insight:settings:ui` 都已随该岛 2026-10-05 下架删除）：
//   `ui-plugins/shipping-rate/dist/` 直接当站点（手写岛无构建）→ 注入假 `window.__sk`
//   → 本地 HTTP（**必须 HTTP**：file:// 下 ESM 被 CORS 拦）→ 无头 Chrome `--dump-dom` → 抓 `#smoke-result`
//
// ⚠️ 注入脚本里的注释不能含反引号（它们本身是模板字符串）；改完 `node --check`。

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SITE = path.join(ROOT, 'ui-plugins', 'shipping-rate', 'dist');
const WORK = path.join('/tmp', 'sellerkit-shipping-rate-smoke');
const PORT = 8128;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(path.join(SITE, 'index.html'))) {
  console.error(`✗ 找不到岛产物 ${SITE}/index.html`);
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error(`✗ 找不到无头 Chrome：${CHROME}`);
  process.exit(1);
}

// ── 假宿主桥（形状照 dist/bridge.js 的真实用法：host.storage.load/save + host.db.call）
//
// __hostTable：宿主快照里"当前那份"（null = 宿主还没有任何运价表）
// __legacy：岛私有 storage modules.shipping-rate 里的旧键（M6 之前存表的地方）
function fakeSk(legacyJson) {
  return `<script>
(function () {
  var calls = {};
  window.__smokeCalls = calls;
  function rec(name, payload) { (calls[name] = calls[name] || []).push(payload); }

  // 归一化运价表的最小可渲染形状（真实形状见 src/lib/shipRate.ts 的 RateTable）
  var T = {
    sheetName: '无忧物流-标准',
    countries: [
      { code: 'US', nameCn: '美国', nameEn: 'United States', cards: [
        { minG: 0, maxG: 2000, categories: ['general'], mode: 'perKg', ratePerKg: 80, registerFee: 8,
          firstFee: 0, stepFee: 0, baseG: 0, stepG: 0, variant: '', sec: 1, currency: 'CNY', minChargeG: 10 },
      ] },
    ],
    sections: [],
    stats: { sections: 1, countries: 1, cards: 1, perKgCards: 1, firstStepCards: 0, currencies: ['CNY'] },
    warnings: [],
  };
  window.__T = T;
  // 宿主快照"当前那份"：null = 宿主没有运价表（冷启动）
  window.__hostTable = null;
  // 岛私有 storage 里的旧配置（迁移用）
  var LEGACY = ${legacyJson};
  window.__saved = [];

  var DB = {
    'shipping-rate.rateCurrent': function (p) {
      rec('shipping-rate.rateCurrent', p);
      if (!window.__hostTable) return null;
      return { id: 1, effectiveFrom: '2026-09-01', sourceFile: '/Users/x/Downloads/报价单-2026Q3.xlsx',
        sheetName: '无忧物流-标准', table: window.__hostTable };
    },
    'shipping-rate.rateAdopt': function (p) {
      rec('shipping-rate.rateAdopt', p);
      // 模拟宿主落档：迁移后"当前那份"就有了
      window.__hostTable = p && p.table ? p.table : null;
      return { id: 1, created: true, effectiveFrom: '2026-09-30' };
    },
    'shipping-rate.quote': function (p) {
      rec('shipping-rate.quote', p);
      // 计价返回形状：{ grams, results: [{ code, nameCn, ok, fee, ... }] }
      return { grams: p && p.grams, results: [
        { code: 'US', nameCn: '美国', nameEn: 'United States', ok: true, card: {}, fee: 16, currency: 'CNY', reason: '' },
      ] };
    },
    'shipping-rate.quoteOrders': function (p) {
      rec('shipping-rate.quoteOrders', p);
      return { rows: [], summary: { total: 0, ok: 0, noWeight: 0, noCountry: 0, unknownCountry: 0, noPrice: 0, refused: 0 } };
    },
    'shipping-rate.quoteProducts': function (p) {
      rec('shipping-rate.quoteProducts', p);
      return { rows: [], summary: { total: 0, ok: 0, weightless: 0, unknownCountry: 0, noPrice: 0, refused: 0 } };
    },
    // ⚠️ **已删通道的绊线**：productWeightStats / importProductWeights（商品ID → 克重，pl_item_weights）
    //    随 2026-10-01 的领域裁定整条退场（克重是 SKU 属性），表已被 product.sku v3 迁移 DROP。
    //    桩**故意留着**：岛若又去调它，calls 里就会留下记录，断言段要求次数为 0（读一张已不存在的表）。
    'shipping-rate.productWeightStats': function (p) {
      rec('shipping-rate.productWeightStats', p);
      return { imported: 0, total: 0, updatedAt: '' };
    },
    'shipping-rate.importProductWeights': function (p) {
      rec('shipping-rate.importProductWeights', p);
      return { parsed: 0, imported: 0, total: 0 };
    },
    'product.list': function () { return { rows: [], total: 0 }; },
  };

  var sk = {
    version: 'smoke',
    ready: Promise.resolve(),
    host: {
      db: { call: function (domain, op, payload) {
        var key = String(domain) + '.' + String(op);
        rec('db', { key: key, payload: payload });
        var fn = DB[key];
        // 未登记的 op：回空对象（不抛）—— 与本冒烟无关的取数不该把页面打挂
        return Promise.resolve(fn ? fn(payload) : {});
      } },
      ui: { notify: function (m) { rec('notify', m); }, openSettings: function () {} },
      storage: {
        load: function (ns) { rec('storage.load', { ns: ns }); return Promise.resolve(LEGACY || {}); },
        save: function (ns, data) { rec('storage.save', { ns: ns, data: data }); window.__saved.push(data); return Promise.resolve(data); },
      },
      dialog: { openFile: function () { return Promise.resolve(null); } },
      clipboard: { writeText: function () { return Promise.resolve(); } },
    },
    bus: { on: function () { return function () {}; }, emit: function () {} },
  };
  window.__sk = sk;

  window.__smokeErrors = [];
  window.addEventListener('error', function (e) { window.__smokeErrors.push(String((e && e.message) || e)); });
  window.addEventListener('unhandledrejection', function (e) { window.__smokeErrors.push('rejection: ' + String((e && e.reason) || e)); });
})();
</script>`;
}

function assertScript(pass) {
  return `<script type="module">
var lines = [];
var STEP = 'init';
function step(n) { STEP = n; }
function report(name, ok, detail) { lines.push((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' | ' + detail : '')); }
function waitFor(fn, timeout) {
  return new Promise(function (resolve, reject) {
    var t0 = Date.now();
    (function tick() {
      // 回调必须 try/catch：抛错会让 Promise 永不落地 → 一个字都写不出来（见 docs/notes/2026-09-30-headless-smoke-waitfor-trap.md）
      var v;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > (timeout || 4000)) return reject(new Error('timeout'));
      setTimeout(tick, 30);
    })();
  });
}
function flat(el) { return el ? el.textContent.replace(/\\s+/g, ' ').trim() : ''; }
function calls(name) { return (window.__smokeCalls && window.__smokeCalls[name]) || []; }
function dbCalls(key) { return calls('db').filter(function (c) { return c.key === key; }); }
function tabBtn(title) {
  var btns = document.querySelectorAll('#tabs [data-tab]');
  for (var i = 0; i < btns.length; i++) { if (flat(btns[i]).indexOf(title) >= 0) return btns[i]; }
  return null;
}
function click(el) { el.dispatchEvent(new MouseEvent('click', { bubbles: true })); }
function hasTableKey(payload) {
  return !!payload && Object.prototype.hasOwnProperty.call(payload, 'table');
}
var PASS = ${JSON.stringify(pass)};

async function main() {
  try {
    step(PASS + '/boot');
    await waitFor(function () { return document.querySelectorAll('#tabs [data-tab]').length >= 4; }, 10000);
    report(PASS + ' 岛挂载：四个页签都在',
      !!tabBtn('运费查询') && !!tabBtn('运价表') && !!tabBtn('按订单试算') && !!tabBtn('按产品试算'),
      'tabs=' + document.querySelectorAll('#tabs [data-tab]').length);
    report(PASS + ' 桥握手完成', flat(document.querySelector('#conn')).indexOf('已连接') >= 0, flat(document.querySelector('#conn')));

    // 岛一律从宿主取"当前运价表"（M6：真源在宿主快照）
    step(PASS + '/rateCurrent');
    await waitFor(function () { return dbCalls('shipping-rate.rateCurrent').length >= 1; }, 8000);
    report(PASS + ' 启动即问宿主要当前运价表', true, 'calls=' + dbCalls('shipping-rate.rateCurrent').length);

    if (PASS === 'A') {
      // 冷启动：宿主没有快照、岛内也没有旧表
      await waitFor(function () { return flat(document.querySelector('#view')).length > 0; }, 8000);
      report(PASS + ' 没有运价表时渲染空态（不是空白页）',
        flat(document.querySelector('#view')).indexOf('还没有运价表') >= 0, flat(document.querySelector('#view')).slice(0, 80));
      report(PASS + ' 没有旧表可迁 → 不该发生 rateAdopt', dbCalls('shipping-rate.rateAdopt').length === 0,
        JSON.stringify(dbCalls('shipping-rate.rateAdopt')));
      report(PASS + ' 没有表就不去计价', dbCalls('shipping-rate.quote').length === 0);
      report(PASS + ' 空态下无未捕获错误', (window.__smokeErrors || []).length === 0, JSON.stringify(window.__smokeErrors || []));
    } else {
      // 迁移：岛内旧表 → 宿主快照一次；随后一切以宿主为准
      step(PASS + '/migrate');
      await waitFor(function () { return dbCalls('shipping-rate.rateAdopt').length >= 1; }, 8000);
      var adopt = dbCalls('shipping-rate.rateAdopt')[0].payload || {};
      report(PASS + ' 旧表迁移带上整张表', !!adopt.table && Array.isArray(adopt.table.countries) && adopt.table.countries.length === 1,
        'countries=' + (adopt.table && adopt.table.countries ? adopt.table.countries.length : 'none'));
      report(PASS + ' 迁移带上来源（文件路径 + 工作表名）',
        adopt.sourceFile === '/Users/x/old/旧报价单.xlsx' && adopt.sheetName === '旧表',
        JSON.stringify({ sourceFile: adopt.sourceFile, sheetName: adopt.sheetName }));

      step(PASS + '/cleanup');
      await waitFor(function () { return (window.__saved || []).some(function (d) { return d && d.table === null; }); }, 8000);
      report(PASS + ' 迁移成功后抹掉岛内陈旧副本（显式写 table:null）', true,
        JSON.stringify((window.__saved || []).filter(function (d) { return d && d.table === null; })));

      step(PASS + '/render');
      await waitFor(function () { return flat(document.querySelector('#view')).indexOf('美国') >= 0; }, 8000);
      report(PASS + ' 取回当前表并渲染国家运价', flat(document.querySelector('#view')).indexOf('美国') >= 0,
        flat(document.querySelector('#view')).slice(0, 100));

      step(PASS + '/quote-payload');
      // **本冒烟的核心断言**：计价不许再把整张表传回宿主（否则"两份真相"又回来了）
      await waitFor(function () { return dbCalls('shipping-rate.quote').length >= 1; }, 8000);
      var q = dbCalls('shipping-rate.quote')[0].payload || {};
      report(PASS + ' 计价 payload 里没有 table（表由宿主自取）', !hasTableKey(q), JSON.stringify(q).slice(0, 160));
      report(PASS + ' 计价仍带克重与口径，且偏好仍从岛存储读出（表不读了、偏好照读）',
        Number(q.grams) === 250 && q.rounding === 'ceil', JSON.stringify(q));

      step(PASS + '/rates-view');
      click(tabBtn('运价表'));
      await waitFor(function () { return flat(document.querySelector('#view')).indexOf('运价来源') >= 0; }, 8000);
      var ratesText = flat(document.querySelector('#view'));
      report(PASS + ' 运价来源面板的源文件来自宿主快照', ratesText.indexOf('报价单-2026Q3.xlsx') >= 0, ratesText.slice(0, 200));
      report(PASS + ' 展示「生效日」而不是本地导入时间', ratesText.indexOf('生效日') >= 0 && ratesText.indexOf('2026-09-01') >= 0,
        ratesText.slice(0, 240));
      report(PASS + ' 「清空」按钮已下线（M6 后运价表按生效日留档，不该被一次抹掉）',
        ratesText.indexOf('清空') < 0, ratesText.slice(0, 240));

      step(PASS + '/orders-view');
      click(tabBtn('按订单试算'));
      await waitFor(function () { return !!document.querySelector('[data-act="quoteOrders"]'); }, 8000);
      click(document.querySelector('[data-act="quoteOrders"]'));
      await waitFor(function () { return dbCalls('shipping-rate.quoteOrders').length >= 1; }, 8000);
      var qo = dbCalls('shipping-rate.quoteOrders')[0].payload || {};
      report(PASS + ' 按订单试算 payload 里没有 table', !hasTableKey(qo), JSON.stringify(qo).slice(0, 160));

      step(PASS + '/products-view');
      click(tabBtn('按产品试算'));
      // 目的国下拉由视图自己默认选中第一项（不静默提交，但也不必我们代劳）
      await waitFor(function () { return !!document.querySelector('[data-act="quoteProducts"]'); }, 8000);
      click(document.querySelector('[data-act="quoteProducts"]'));
      await waitFor(function () { return dbCalls('shipping-rate.quoteProducts').length >= 1; }, 8000);
      var qp = dbCalls('shipping-rate.quoteProducts')[0].payload || {};
      report(PASS + ' 按产品试算 payload 里没有 table', !hasTableKey(qp), JSON.stringify(qp).slice(0, 160));

      step(PASS + '/errors');
      report(PASS + ' 无未捕获错误', (window.__smokeErrors || []).length === 0, JSON.stringify(window.__smokeErrors || []));
    }
    // 绊线：已删的通道一次都不许调（调了说明岛又回去读那张已 DROP 的表）
    step(PASS + '/removed-ops');
    report(PASS + ' 不碰已删通道 productWeightStats / importProductWeights（商品ID 克重那条链已整条退场）',
      dbCalls('shipping-rate.productWeightStats').length === 0 && dbCalls('shipping-rate.importProductWeights').length === 0,
      'stats=' + dbCalls('shipping-rate.productWeightStats').length + ' import=' + dbCalls('shipping-rate.importProductWeights').length);
  } catch (e) {
    lines.push('SMOKE: FAILED at [' + STEP + '] - ' + (e && e.message ? e.message : String(e)));
  }
  var failed = lines.some(function (l) { return l.indexOf('FAIL') === 0 || l.indexOf('SMOKE: FAILED') === 0; });
  lines.push(failed ? 'SMOKE: FAILED' : 'SMOKE: ALL PASS');
  var pre = document.createElement('pre');
  pre.id = 'smoke-result';
  pre.textContent = lines.join('\\n');
  document.body.appendChild(pre);
}

main();
</script>`;
}

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.mjs': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};

const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(WORK, rel === '/' ? '/index.html' : rel);
  if (!file.startsWith(WORK)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const buf = readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});

await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

/** 跑一个来回：重建站点目录（注入不同的假桥）→ 无头 Chrome dump → 解析 #smoke-result */
async function runPass(pass, legacy) {
  rmSync(WORK, { recursive: true, force: true });
  mkdirSync(WORK, { recursive: true });
  cpSync(SITE, WORK, { recursive: true });

  const html = readFileSync(path.join(WORK, 'index.html'), 'utf-8');
  // ⚠️ 用**函数式** replace：字符串形式会把注入内容里的 $& / $$ 折掉
  let out = html.replace('</head>', () => fakeSk(legacy) + '</head>');
  out = out.replace('</body>', () => assertScript(pass) + '</body>');
  writeFileSync(path.join(WORK, 'index.html'), out);

  const dom = await new Promise((resolve, reject) => {
    const cp = spawn(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
      '--virtual-time-budget=45000',
      '--dump-dom',
      `http://127.0.0.1:${PORT}/index.html`,
    ]);
    let o = '';
    cp.stdout.on('data', (d) => (o += String(d)));
    cp.on('error', reject);
    cp.on('close', () => resolve(o));
  });

  const m = dom.match(/id="smoke-result"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) {
    console.error(`✗ [${pass}] 没抓到 #smoke-result（岛可能没挂载）。`);
    console.error('  排查顺序：dist/index.html 是否存在 → 假桥 __sk 形状 → 内联脚本语法错 → 视图 import 报错');
    process.exit(1);
  }
  return m[1]
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .trim();
}

const LEGACY_NONE = 'null';
const LEGACY_OLD_TABLE = JSON.stringify({
  table: {
    sheetName: '旧表',
    countries: [{ code: 'US', nameCn: '美国', nameEn: 'United States', cards: [{ minG: 0, maxG: 2000 }] }],
    sections: [],
    stats: { sections: 1, countries: 1, cards: 1, perKgCards: 1, firstStepCards: 0, currencies: ['CNY'] },
    warnings: [],
  },
  source: { filePath: '/Users/x/old/旧报价单.xlsx', fileName: '旧报价单.xlsx', sheetName: '旧表' },
  weight: 250,
  rounding: 'ceil',
});

const textA = await runPass('A', LEGACY_NONE);
const textB = await runPass('B', LEGACY_OLD_TABLE);
server.close();

console.log(textA);
console.log(textB);
const failed = [textA, textB].some((t) => t.split('\n').pop() !== 'SMOKE: ALL PASS');
console.log(failed ? '\n✗ shipping-rate 岛冒烟失败' : '\n✓ shipping-rate 岛冒烟通过');
if (failed) process.exit(1);