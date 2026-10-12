// 「拣货」页**假桥无头冒烟**（不启动真实宿主，不需要 Electron）。
//
//   npm run picking:ui
//
// 为什么需要它：这一页有三路取数（订单行投影 / 结算件数 / 合批缩略图）+ 一条导出链 + 一条"复制给厂家"
// （canvas 合成 PNG → 写系统剪贴板），而纯层单测只覆盖到 `aggregatePicking` / `sheetModelOf`；
// **接线**（IPC 键名、字段名、键口径、导出 buffer 真的生成了没有、写进剪贴板的真是 PNG 图片）
// 从未被跑过 —— 这类错全是静默的（页面正常但数字/图/导出不对）。
//
// 做法（照 `esm-spa-headless-smoke` 技能，与 `order-profit:ui` 同款）：
//   build 产物 → 复制到隔离目录 → 注入 fake `window.electronAPI` + 断言脚本
//   → 本地 HTTP 服务器（**必须 HTTP**：file:// 下 ESM 被 CORS 拦，页面根本不挂载）
//   → 无头 Chrome `--dump-dom` → 抓 `#smoke-result`
//
// ⚠️ 本脚本**验不到 xlsx 本身**（导出已移到主进程 exceljs）：这里只能断言"渲染层把什么传过去了"。
//    "图真的嵌进 zip 了没有 / 分表分对了没有" 由 `scripts/picking-xlsx-smoke.cjs` 验（`npm run picking:xlsx:smoke`）。
//
// ⚠️ 注入脚本（FAKE_BRIDGE / ASSERT_SCRIPT）里的注释**不能含反引号**（它们本身是模板字符串）——
// 改完先 `node --check`（npm script 已经带了）。
//
// DOM 契约（2026-10-10 卡片网格重设计，断言一律钉 `data-act`）：
//   `pk-bar`（精简条：缺口 `gaps` + 口径 `scope`）· `pk-tabs`（厂家筛选）/ `pk-tab-all` / `pk-tab[data-supplier]`
//   `pk-grid` → `pk-card[data-key]`（图 + 供应商角标 + 尺码角标条 `size-chip` + 状态标签 +
//   `card-amount` 小计 + `unit-price` 单价）· `pk-sum`（吸底汇总条）→ `pk-sum-row[data-supplier]`
//   （`pk-copy` 复制给厂家 / `pk-create-order` 生成拿货单）→ `pk-sum__total[data-act="amount"]` 总账。

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'renderer');
const WORK = path.join('/tmp', 'sellerkit-picking-smoke');
const PORT = 8124;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error(`✗ 找不到构建产物 ${DIST}/index.html —— 先跑 npm run build`);
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error(`✗ 找不到无头 Chrome：${CHROME}`);
  process.exit(1);
}

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
cpSync(DIST, WORK, { recursive: true });

// ─────────────────────────────────────────────────────────── 可验算的样本
// 4 行订单：① S1·黑·L 2 件（报表块）② 同 SKU 1 件（不同单）→ 合成一组 3 件 / 2 单
//           ③ S2·白·M 1 件（缺图、缺供应商、未识别款）④ 关闭单（应被剔除）
// 日期：用"今天 - 2 天"保证在 30 天窗内（不写死日期，免得随时间失效）
const FAKE_BRIDGE = `<script>
(function () {
  var calls = {};
  window.__smokeCalls = calls;
  function rec(name, payload) { (calls[name] = calls[name] || []).push(payload); }
  function daysAgo(n) {
    var d = new Date(); d.setDate(d.getDate() - n);
    var p = function (x) { return String(x).length < 2 ? '0' + x : String(x); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  var D2 = daysAgo(2) + ' 10:00:00';
  var D400 = daysAgo(400) + ' 10:00:00';
  function block(qty) { return '【1】 某款 (产品属性:Color:黑、Size:L)\\n(商品数量:' + qty + ' piece)'; }
  function row(o) {
    return {
      id: o.id, orderNo: o.orderNo, shop: o.shop || '店A', orderTime: o.orderTime === undefined ? D2 : o.orderTime,
      styleCode: o.styleCode === undefined ? 'S1' : o.styleCode, styleColor: '红',
      color: o.color === undefined ? '黑' : o.color, size: o.size === undefined ? 'L' : o.size,
      itemId: o.itemId || 'IT-' + o.id,
      supplierId: o.supplierId === undefined ? 7 : o.supplierId, supplierName: o.supplierName === undefined ? '厂A' : o.supplierName,
      imagePath: o.imagePath === undefined ? '/tmp/img-' + o.id + '.jpg' : o.imagePath,
      shipped: false, bizStatus: o.bizStatus || '等待发货',
      rawFields: o.rawFields === undefined ? { '商品信息': block(o.qty || 1) } : o.rawFields,
    };
  }
  var ROWS = [
    row({ id: 1, orderNo: 'O1', qty: 2 }),
    row({ id: 2, orderNo: 'O2', qty: 1 }),
    row({ id: 3, orderNo: 'O3', styleCode: '', color: '白', size: 'M', itemId: 'IT-3', supplierId: 0, supplierName: '', imagePath: '' }),
    row({ id: 4, orderNo: 'O4', bizStatus: '订单关闭', qty: 5 }),
    row({ id: 5, orderNo: 'O5', orderTime: D400, qty: 1 }),
    row({ id: 6, orderNo: 'O6', orderTime: '', rawFields: {} }), // 无商品信息块 → 件数按 1 并标缺
  ];

  // 真 JPEG（在页面里用 canvas 现造）：缩略图走的是"渲染层 canvas 转码"这条路，
  // 给个假 dataUrl（'data:...;TINY'）会让 <img> 解码失败 → 导出时每张图都被静默跳过，
  // 于是"图有没有真的被编码"这条链永远测不到。
  function jpegDataUrl(w, h) {
    var c = document.createElement('canvas');
    c.width = w; c.height = h;
    var x = c.getContext('2d');
    x.fillStyle = '#c00'; x.fillRect(0, 0, w, h);
    x.fillStyle = '#004'; x.fillRect(0, 0, Math.round(w / 2), h);
    return c.toDataURL('image/jpeg', 0.9);
  }
  var OVERRIDES = {
    'getAppVersion': function () { return { success: true, data: '0.0.0-smoke' }; },
    'get-app-version': function () { return { success: true, data: '0.0.0-smoke' }; },
    'getModuleState': function (ns) {
      if (ns === 'app-shell') return { success: true, data: { lastActiveModuleId: 'picking', collapsed: false } };
      return { success: true, data: null };
    },
    'pickingRows': function (p) {
      rec('pickingRows', p);
      // 空态两分支的夹具（P0-3②）：
      //   __onlyFinished → 只有一行"订单关闭"（scanned>0 但全被**已终结**剔除）
      //   __onlyOld      → 只有一行"超窗"（scanned>0 但全被**天数窗**剔除）—— 两种原因的**反向夹具**
      //   __noPickingRows → 一行都没有（scanned=0 → "一行订单都没扫到" + 去导入）
      if (window.__onlyFinished) return { success: true, data: { rows: [row({ id: 9, orderNo: 'OC', bizStatus: '订单关闭', qty: 1 })], meta: { rows: 1, limit: 2000 } } };
      if (window.__onlyOld) return { success: true, data: { rows: [row({ id: 10, orderNo: 'OO', orderTime: D400, qty: 1 })], meta: { rows: 1, limit: 2000 } } };
      if (window.__noPickingRows) return { success: true, data: { rows: [], meta: { rows: 0, limit: 2000 } } };
      var rows = ROWS.slice();
      if (!p || !p.includeShipped) rows = rows.filter(function (r) { return !r.shipped; });
      if (p && p.shop) rows = rows.filter(function (r) { return r.shop === p.shop; });
      return { success: true, data: { rows: rows, meta: { rows: rows.length, limit: 2000 } } };
    },
    // 结算商品行件数：故意与报表块不同（3 件）→ 证明"结算真值盖过报表值"这条接线通了
    'settleOrders': function (p) {
      rec('settleOrders', p);
      return { success: true, data: { rows: [{ orderNo: 'O2', settleStatus: '已结算', pendingReason: '',
        dealCents: 0, netIncomeCents: 0, splitCents: 0, feeSumCents: 0, itemLines: 1, from: 'order',
        items: [{ itemId: 'IT-2', lines: 1, qty: 3 }] }] } };
    },
    'orderImageThumbBatch': function (items) {
      rec('orderImageThumbBatch', items);
      return { success: true, data: { dataUrls: items.map(function () { return jpegDataUrl(64, 64); }) } };
    },
    // 进价来源（款级成本区间，与「算钱」页同一张表）。只给 S1 定价 → 恰好造出"有价 / 无价"两种卡：
    //   S1 · 黑 有价（10 元/件）、(未识别款) · 白 无价 → 金额只含前者，缺价件数照报。
    'aeCostMapList': function () {
      rec('aeCostMapList', {});
      // __noCosts：造"一件价都查不到"的场景（用于验"0 元 ≠ 不知道多少钱"这条表达）
      if (window.__noCosts) return { success: true, data: [] };
      return { success: true, data: [{ styleCode: 'S1', effectiveFrom: '2026-01-01', unitPriceCents: 1000, source: 'purchase' }] };
    },
    // 「已拿 / 还差」的来源（2026-10-10 与「拿货」页同源）：宿主 outstanding() 的 taken + 忽略清单。
    // 为什么必须在夹具里给出**非零** taken：不给的话 remaining === pieces，「还差」与尺码角标
    // （L×2 那个格子）两条断言在"实现根本没接线"时也全绿（**空转断言**，靠"把实现改坏一遍"才现形）。
    'purchaseOutstanding': function () {
      rec('purchaseOutstanding', {});
      // __noTaken：反向夹具 —— 造"一件都还没拿过"的当下（尺码角标应回落到需求数）
      if (window.__noTaken) return { success: true, data: [] };
      // __allTaken：造"这家已经拿齐了"的当下（卡标「已拿完」、厂A 标签消失 → 筛选必须回落）
      if (window.__allTaken) return { success: true, data: [
        { styleCode: 'S1', color: '黑', size: 'L', styleName: '某款', demand: 6, taken: 6, missing: 0 },
      ] };
      // 键口径必须与 lib/picking.takenKey 一致（款|色|码，竖线拼接）：
      // S1·黑·L 需求 6 件、已拿 4 件 → 还差 2（并**不影响**金额：金额只看件数与进价）。
      return { success: true, data: [
        { styleCode: 'S1', color: '黑', size: 'L', styleName: '某款', demand: 6, taken: 4, missing: 2 },
      ] };
    },
    'purchaseIgnoreList': function () {
      rec('purchaseIgnoreList', {});
      // __ignore：忽略「S1 · 黑」整款色 —— **特意挑这一款**（它有图）：这样才能验到
      //   "已忽略的款色不进待拿、尺码角标被划掉"这两条判据（挑没图的那组当样本时判据会弱掉）。
      if (window.__ignore) return { success: true, data: [{ styleCode: 'S1', color: '黑', reason: '线下拿了' }] };
      return { success: true, data: [] };
    },
    // 「复制给厂家」的落点：**图片剪贴板**（write-clipboard-image，主进程 nativeImage + clipboard）。
    // 记录的是 dataUrl 字符串本身 —— 断言"写进去的真是 PNG 图片"，不是一段文本。
    'writeClipboardImage': function (dataUrl) {
      rec('writeClipboardImage', dataUrl);
      // __clipFail：反向夹具 —— 造"写剪贴板失败"（失败必须说出来，不能装作已复制）
      if (window.__clipFail) return { success: false, error: 'smoke-clip-fail' };
      return { success: true };
    },
    // 导出：现在的实现在**主进程**（exceljs 带图 + 按厂家分表），所以这里断言的是"传了什么过去"
    'pickingExportExcel': function (p) {
      rec('pickingExportExcel', p);
      return { success: true, data: { filePath: '/tmp/拣货单.xlsx', rows: (p && p.rows ? p.rows.length : 0) } };
    },
    'orderExportExcel': function (buffer, name) {
      rec('orderExportExcel', { size: buffer && buffer.byteLength ? buffer.byteLength : 0, name: name });
      return { success: true, data: { filePath: '/tmp/' + name } };
    },
    'shopDbEnsure': function () { return { success: true, data: { ok: true } }; },
    'shopList': function (p) {
      rec('shopList', p);
      return { success: true, data: { rows: [{ id: 1, name: '店A', platform: 'aliexpress' }], total: 1 } };
    },
  };

  window.electronAPI = new Proxy({}, {
    get: function (_t, key) {
      if (typeof key !== 'string') return undefined;
      var fn = OVERRIDES[key];
      if (fn) return function () { return Promise.resolve(fn.apply(null, arguments)); };
      if (/^on[A-Z]/.test(key)) return function () { return function () {}; };
      return function () { return Promise.resolve({ success: true, data: null }); };
    },
  });

  window.__smokeErrors = [];
  window.addEventListener('error', function (e) { window.__smokeErrors.push(String((e && e.message) || e)); });
  window.addEventListener('unhandledrejection', function (e) { window.__smokeErrors.push('rejection: ' + String((e && e.reason) || e)); });
})();
</script>`;

const ASSERT_SCRIPT = `<script type="module">
var lines = [];
var STEP = 'init';
function step(n) { STEP = n; }
function report(name, ok, detail) { lines.push((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' | ' + detail : '')); }
function waitFor(fn, timeout) {
  return new Promise(function (resolve, reject) {
    var t0 = Date.now();
    (function tick() {
      // ⚠️ 回调必须 try/catch：它一旦抛错，Promise 永不落地 → await 挂死 → 断言结果一个字都写不出来，
      // 症状是「没抓到 #smoke-result」（会把排查方向带到产物/注入上去）。
      var v;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > (timeout || 4000)) return reject(new Error('timeout'));
      setTimeout(tick, 30);
    })();
  });
}
// 有界等待，**超时不当异常**：断言自己给结论。
// 为什么：一条 waitFor 超时会把整份脚本抛到最外层 catch ⇒ 后面几十条断言全不跑，
// 报出来的失败条数与真实失败数无关。
function tryWait(fn, timeout) { return waitFor(fn, timeout).catch(function () {}); }
function flat(el) { return el ? el.textContent.replace(/\\s+/g, ' ').trim() : ''; }
function calls(name) { return (window.__smokeCalls && window.__smokeCalls[name]) || []; }

// ── 卡片网格（2026-10-10）的稳定判据：断言一律钉 data-act，不钉文案/结构 ——
//    文案随时会改，而"这一格是干什么的"由 data-act 唯一表达。
function grid() { return document.querySelector('[data-act="pk-grid"]'); }
function cards() { var g = grid(); return g ? Array.prototype.slice.call(g.querySelectorAll('[data-act="pk-card"]')) : []; }
function cardByKey(key) { return document.querySelector('[data-act="pk-card"][data-key="' + key + '"]'); }
function keysText() { return cards().map(function (c) { return c.getAttribute('data-key'); }).join(' / '); }
function sumRow(sid) { return document.querySelector('[data-act="pk-sum-row"][data-supplier="' + sid + '"]'); }
function tabEl(sid) { return document.querySelector('[data-act="pk-tab"][data-supplier="' + sid + '"]'); }
function amountEl() { return document.querySelector('[data-act="amount"]'); }
function cardAmount(key) { var c = cardByKey(key); return c ? c.querySelector('[data-act="card-amount"]') : null; }
function unitEl(key) { var c = cardByKey(key); return c ? c.querySelector('[data-act="unit-price"]') : null; }
// 提示（toast）读取工具：**必须"全部提示里有没有"**，不能取第一条（同一时刻可以并排好几条，
// 第一条往往是旧的 —— 症状是"新提示没出来"，排查方向整个反掉）。
function toastTexts() { return Array.prototype.map.call(document.querySelectorAll('[data-act="toast"]'), function (el) { return el.textContent; }); }
function toastHas(part) { return toastTexts().some(function (t) { return t.indexOf(part) >= 0; }); }
function toastDump() { return toastTexts().join(' | ').slice(0, 140); }

// ── 按压塌守卫（2026-10-10）────────────────────────────────────────────────────
// 替换原先的「position === 'sticky'」**声明断言** —— CSS 里写了 sticky，不等于条子真的在眼前。
// 实测错法（真机 CDP 量的）：.pk-view 是 .wb-page（height:100% 的定高弹性列），内容一多就压缩
// **默认可缩**的弹性项；.pk-sum 自己 overflow:hidden ⇒ 自动最小尺寸归零 ⇒ 被压到 2px，
// 行与按钮**还在 DOM 里、却被自己裁掉**（elementFromPoint 中心命中不到）。转页签只改变卡片数
// ⇒ 不同的压塌程度，看着像"按钮跟页签走"（真机「全部 6 款色/集雨 4」没按钮、「欢喜/大众 1」有，
// 就是这么来的 —— 与页签语义毫无关系）。所以判据必须落在**几何 + 可达性**上，三条缺一不可：
//   ① 条子没被压扁：clientHeight ≈ scrollHeight（压塌时 2 vs 158，必红）；
//   ② 条子底边在视口内（sticky 把它钉在滚动口底边，钉住了才见得到）；
//   ③ 每个按钮中心 elementFromPoint **命中它自己**（存在性 ≠ 可达性）。
function pkSumGuard(requiredActs) {
  var sum = document.querySelector('[data-act="pk-sum"]');
  var view = document.querySelector('.pk-view');
  if (!sum) return { ok: false, detail: 'no-sum' };
  var rect = sum.getBoundingClientRect();
  var notSquashed = sum.clientHeight + 1 >= sum.scrollHeight;
  var inView = rect.bottom <= window.innerHeight + 1 && rect.top >= -1;
  var miss = [];
  for (var i = 0; i < requiredActs.length; i++) {
    var act = requiredActs[i];
    var b = sum.querySelector('[data-act="' + act + '"]');
    if (!b) { miss.push(act + '→按钮不在'); continue; }
    var r = b.getBoundingClientRect();
    var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || (hit !== b && !b.contains(hit))) {
      miss.push(act + '→点到 ' + (hit ? String(hit.getAttribute('data-act') || hit.className || hit.tagName).slice(0, 36) : 'null'));
    }
  }
  return {
    ok: notSquashed && inView && miss.length === 0,
    detail: '条 h=' + Math.round(rect.height) + '（client ' + sum.clientHeight + ' / scroll ' + sum.scrollHeight +
      '）底=' + Math.round(rect.bottom) + '/视口高 ' + window.innerHeight +
      ' 视图 scroll/client=' + (view ? view.scrollHeight + '/' + view.clientHeight : '?') +
      (miss.length ? ' | ' + miss.join('；') : ''),
  };
}

async function main() {
  try {
    step('boot');
    await waitFor(function () { return document.querySelector('.pk-view'); }, 10000);
    report('挂载：拣货视图渲染', true);

    step('first-screen');
    // 一键语义：未点按钮**不出清单**（清单是"此刻的快照"，不该在用户没要求时自己刷新）
    report('首屏是空态提示、无清单（点按钮才生成）',
      !!document.querySelector('[data-act="empty"]') && !grid(),
      'empty=' + !!document.querySelector('[data-act="empty"]'));
    report('首屏不自动取数', calls('pickingRows').length === 0, 'pickingRows=' + calls('pickingRows').length);
    report('首屏保留主操作：生成 + 导出（导出在无清单时禁用）',
      !!document.querySelector('[data-act="generate"]') &&
        document.querySelector('[data-act="export"]').disabled === true);
    report('首屏没有网格 / 筛选标签 / 汇总条（三块都由"生成"之后才出现）',
      !grid() && !document.querySelector('[data-act="pk-tabs"]') &&
        !document.querySelector('[data-act="pk-sum"]') && !amountEl());
    report('默认条件写在界面上（未发货 · 近 30 天）',
      flat(document.querySelector('[data-act="scope"]')).indexOf('未发货') >= 0 &&
        /近 30 天/.test(flat(document.querySelector('[data-act="scope"]'))),
      flat(document.querySelector('[data-act="scope"]')));
    report('首屏默认收起低频筛选（天数/店铺/含已发货）',
      !document.querySelector('[data-act="shop-pick"]') && !document.querySelector('[data-act="include-shipped"]'));

    step('generate');
    document.querySelector('[data-act="generate"]').click();
    await waitFor(function () { return cards().length >= 1; }, 8000);
    report('点「生成待拣清单」→ 出卡片网格（2 个款色 = 2 张卡）',
      cards().length === 2, 'cards=' + cards().length + ' keys=' + keysText());
    report('六路取数都发出去了（投影 + 结算 + 成本 + 已拿/忽略 + 缩略图合批）',
      calls('pickingRows').length === 1 && calls('settleOrders').length === 1 &&
        calls('aeCostMapList').length === 1 && calls('purchaseOutstanding').length === 1 &&
        calls('purchaseIgnoreList').length === 1 && calls('orderImageThumbBatch').length === 1,
      JSON.stringify({ p: calls('pickingRows').length, s: calls('settleOrders').length,
        c: calls('aeCostMapList').length, o: calls('purchaseOutstanding').length,
        i: calls('purchaseIgnoreList').length, t: calls('orderImageThumbBatch').length }));
    report('投影只回未发货（默认不带 includeShipped）',
      calls('pickingRows')[0].includeShipped === false, JSON.stringify(calls('pickingRows')[0]));

    step('cards');
    // **一张卡 = 一个款色**（2026-10-10 重设计）：同款同色的码折进卡上的尺码角标条；
    // 件数 / 已拿 / 还差折进角标的 tooltip —— 折叠的是展示，三个数一个都没丢。
    // 可验算：S1·黑 的 L 码 = 报表 2 件 + 结算真值 3 件 + 无件数按 1 件 = 需求 6 / 已拿 4 / 还差 2。
    var g1 = cardByKey('S1 · 黑');
    var chipL = g1 && g1.querySelector('[data-act="size-chip"][data-size="L"]');
    report('同款色合成一张卡，尺码×件数落进角标条：L = 需求 6 / 已拿 4 / 还差 2',
      !!g1 && !!chipL && flat(chipL) === 'L×2' && chipL.getAttribute('title') === 'L：需求 6 · 已拿 4 · 还差 2',
      chipL ? flat(chipL) + ' | ' + chipL.getAttribute('title') : '(角标不在)');
    report('未识别款/缺色码各自成卡（键写在卡上，肉眼可见）',
      cards().length === 2 && !!cardByKey('(未识别款) · 白'), keysText());
    var gapsW = cardByKey('(未识别款) · 白').querySelector('[data-act="row-gaps"]');
    report('缺图 / 缺供应商 / 未识别款 逐卡标出',
      !!gapsW && flat(gapsW).indexOf('缺图') >= 0 && flat(gapsW).indexOf('缺供应商') >= 0 &&
        flat(gapsW).indexOf('未识别款') >= 0, gapsW ? flat(gapsW) : '(缺口标签不在)');
    report('卡上标明"这卡发给哪家"（供应商角标）；未指定厂家另有样式',
      flat(g1.querySelector('.pk-card__sup')) === '厂A' &&
        flat(cardByKey('(未识别款) · 白').querySelector('.pk-card__sup')) === '未指定厂家' &&
        cardByKey('(未识别款) · 白').querySelector('.pk-card__sup').className.indexOf('is-missing') >= 0,
      flat(g1.querySelector('.pk-card__sup')) + ' | ' +
        flat(cardByKey('(未识别款) · 白').querySelector('.pk-card__sup')));
    report('关闭单的 5 件没被算进来（总账不含已终结行：含它就该是 8 件而不是 3 件）',
      /待拿 2 款色 · 3 件/.test(flat(amountEl())), flat(amountEl()));

    step('money');
    // 金额口径 = **待拿**（还差件 × 进价，与汇总行「生成拿货单（N 件）」同一个数）。
    // 可验算：S1·黑 L 还差 2 × 10 元 = 20；(未识别款)·白 无价 → 不计入，但要作为"无进价"报出来。
    report('底部总账给出待拿合计 + 预估金额（只含有价部分）',
      /待拿 2 款色 · 3 件 · 预估 ¥20\\.00/.test(flat(amountEl())), flat(amountEl()));
    report('无进价的件数单独报出（不混进金额，也不省略）',
      /不含 1 件无进价/.test(flat(amountEl())), flat(amountEl()));
    report('有价的卡：单价 10.00 —— 数字**恰好**在 data-act 格里，单位（元/件）挂在格外',
      flat(unitEl('S1 · 黑')) === '10.00' && flat(unitEl('S1 · 黑').parentElement).indexOf('元/件') >= 0,
      flat(unitEl('S1 · 黑').parentElement));
    report('无价的卡：单价「—」且**不带**单位（没查到价 ≠ 0 元/件），缺口标「无进价 1 件」',
      flat(unitEl('(未识别款) · 白')) === '—' &&
        flat(unitEl('(未识别款) · 白').parentElement).indexOf('元/件') < 0 &&
        flat(cardByKey('(未识别款) · 白')).indexOf('无进价 1 件') >= 0,
      flat(unitEl('(未识别款) · 白').parentElement));
    report('卡面小计 = **还要拿的件数** × 进价（≈¥20.00，不是需求 6 件的 60.00）',
      flat(cardAmount('S1 · 黑')) === '≈¥20.00', flat(cardAmount('S1 · 黑')));
    report('全无价的卡：小计写「—」不写 ≈¥0.00（0 元 ≠ 不知道多少钱），另用 is-none 降级配色',
      flat(cardAmount('(未识别款) · 白')) === '—' &&
        cardAmount('(未识别款) · 白').className.indexOf('is-none') >= 0,
      flat(cardAmount('(未识别款) · 白')) + ' | ' + cardAmount('(未识别款) · 白').className);

    step('taken-remaining');
    // 「已拿 / 还差」的落点是**尺码角标**：L×2 = 这一码还要拿 2 件；需求与已拿折进 tooltip。
    // 夹具给了 S1·黑 L 已拿 4 → 还差 2，而"已拿"来自与「拿货」页同一份 outstanding()。
    report('角标 = 「尺码 × 还要拿的件数」（L×2，不是需求数 L×6 —— 这张单是照着拿货的）',
      flat(chipL) === 'L×2', flat(chipL));
    report('总账主数 = 待拿（2 款色 · 3 件），不是总需求（那会是 7 件）',
      /待拿 2 款色 · 3 件/.test(flat(amountEl())), flat(amountEl()));

    // 反向夹具：一件都没拿过 ⇒ 角标回落到需求数、总账 = 全部需求
    //（"拿过 / 没拿过"在两处必须同时翻转 —— 只翻一处就是两套口径）
    window.__noTaken = true;
    document.querySelector('[data-act="generate"]').click();
    await tryWait(function () {
      var c = cardByKey('S1 · 黑');
      c = c && c.querySelector('[data-act="size-chip"][data-size="L"]');
      return c && flat(c) === 'L×6';
    }, 8000);
    var chip0 = cardByKey('S1 · 黑').querySelector('[data-act="size-chip"][data-size="L"]');
    report('【反向】没拿过时：角标回到需求数 L×6（已拿 0 写在 tooltip 里）',
      flat(chip0) === 'L×6' && chip0.getAttribute('title') === 'L：需求 6 · 已拿 0 · 还差 6',
      flat(chip0) + ' | ' + chip0.getAttribute('title'));
    report('【反向】没拿过时总账 = 全部需求（2 款色 · 7 件 · 预估 ¥60.00）',
      /待拿 2 款色 · 7 件 · 预估 ¥60\\.00/.test(flat(amountEl())), flat(amountEl()));
    window.__noTaken = false;

    // 忽略：整款色不补 ⇒ 卡标「已忽略」、角标被划掉（is-off 类）、排到最后、并且**不进待拿**。
    // 夹具忽略的是 **S1 · 黑**（有图的那款）——见 purchaseIgnoreList 的注释。
    window.__ignore = true;
    document.querySelector('[data-act="generate"]').click();
    await tryWait(function () { return !!document.querySelector('[data-act="row-ignored"]'); }, 8000);
    var gIgn = cardByKey('S1 · 黑');
    var chipIgn = gIgn && gIgn.querySelector('[data-act="size-chip"][data-size="L"]');
    report('被忽略的卡：标「已忽略」、尺码角标划掉（数字仍留着可回看，不是消失）',
      !!gIgn && !!gIgn.querySelector('[data-act="row-ignored"]') && !!chipIgn &&
        chipIgn.className.indexOf('is-off') >= 0 && flat(chipIgn) === 'L×2',
      gIgn ? flat(gIgn) : '(卡不在)');
    report('被忽略的卡排到最后并调暗（还在网格里 —— "处理过了"也是信息），且不再报金额',
      cards().length === 2 && cards()[cards().length - 1].getAttribute('data-key') === 'S1 · 黑' &&
        gIgn.className.indexOf('is-off') >= 0 && !gIgn.querySelector('[data-act="card-amount"]'),
      keysText() + ' | last=' + cards()[cards().length - 1].getAttribute('data-key'));
    report('被忽略的不进待拿 / 不进标签：2 款色 · 3 件 变成 1 款色 · 1 件（厂A 的标签整格消失）',
      /待拿 1 款色 · 1 件/.test(flat(amountEl())) && !tabEl(7) && !!tabEl(0),
      flat(amountEl()) + ' | tabs=' + !!tabEl(7) + '/' + !!tabEl(0));
    report('被忽略后该厂没有待拿了：汇总行改说「余下已忽略」，不再挂金额、不再给复制',
      flat(sumRow(7)).indexOf('余下已忽略') >= 0 && flat(sumRow(7)).indexOf('待拿') < 0 &&
        !sumRow(7).querySelector('[data-act="pk-copy"]'),
      flat(sumRow(7)));
    window.__ignore = false;
    document.querySelector('[data-act="generate"]').click();
    await tryWait(function () {
      var c = cardByKey('S1 · 黑');
      c = c && c.querySelector('[data-act="size-chip"][data-size="L"]');
      return c && flat(c) === 'L×2' && !document.querySelector('[data-act="row-ignored"]');
    }, 8000);
    report('夹具复位后回到基准（已拿 4 / 无忽略）—— 后面的断言才有个确定的起点',
      flat(cardByKey('S1 · 黑').querySelector('[data-act="size-chip"][data-size="L"]')) === 'L×2' &&
        !document.querySelector('[data-act="row-ignored"]'));

    step('tabs');
    // 顶部厂家筛选标签（2026-10-10）：数 = **待拿款色数**（一个厂家一格；没货要拿的厂家不占位）。
    report('厂家筛选标签：一个厂家一格（数 = 待拿款色数），未指定厂家是独立一格',
      !!document.querySelector('[data-act="pk-tabs"]') &&
        /全部 2/.test(flat(document.querySelector('[data-act="pk-tab-all"]'))) &&
        /厂A 1/.test(flat(tabEl(7))) && /未指定厂家 1/.test(flat(tabEl(0))),
      flat(document.querySelector('[data-act="pk-tab-all"]')) + ' / ' + flat(tabEl(7)) + ' / ' + flat(tabEl(0)));
    tabEl(7).click();
    await tryWait(function () { return cards().length === 1 && !!cardByKey('S1 · 黑'); }, 4000);
    report('点某厂家标签只筛**网格**：只剩这一家的卡，别家的卡退出 DOM（不是藏在下面）',
      cards().length === 1 && !!cardByKey('S1 · 黑') && !cardByKey('(未识别款) · 白') &&
        tabEl(7).className.indexOf('is-on') >= 0 &&
        document.querySelector('[data-act="pk-tab-all"]').className.indexOf('is-on') < 0,
      'cards=' + cards().length + ' keys=' + keysText());
    report('筛选只动网格、不动总账（总账回答的是"这批总共有多少要拿"）',
      /待拿 2 款色 · 3 件/.test(flat(amountEl())) && /1 款色 · 待拿 2 件/.test(flat(sumRow(7))),
      flat(amountEl()));
    tabEl(0).click();
    await tryWait(function () { return cards().length === 1 && !!cardByKey('(未识别款) · 白'); }, 4000);
    report('切到未指定厂家：只剩它那一张卡',
      cards().length === 1 && !!cardByKey('(未识别款) · 白') && !cardByKey('S1 · 黑'), keysText());
    document.querySelector('[data-act="pk-tab-all"]').click();
    await tryWait(function () { return cards().length === 2; }, 4000);
    report('点「全部」回来：两张卡都回来', cards().length === 2, keysText());

    step('done');
    // 「已拿完」是**第四态**：与"齐"分开说（一个是"不用再拿了"，一个是"照它拿"）。
    // 顺带验"筛到一个已经没货要拿的厂家"时筛选**自动回落全部** —— 不回落就会看到空网格，
    // 用户只会以为整单空了（这正是重算后最容易发生的一刻）。
    tabEl(7).click();
    await tryWait(function () { return cards().length === 1; }, 4000);
    window.__allTaken = true;
    document.querySelector('[data-act="generate"]').click();
    await tryWait(function () {
      var c = cardByKey('S1 · 黑');
      return !!c && !!c.querySelector('[data-act="row-taken-all"]');
    }, 8000);
    var cDone = cardByKey('S1 · 黑');
    report('还差 0 的款色：标「已拿完」、调暗、不再报金额（不是消失 —— "处理过了"也是信息）',
      !!cDone && !!cDone.querySelector('[data-act="row-taken-all"]') &&
        cDone.className.indexOf('is-done') >= 0 && !cDone.querySelector('[data-act="card-amount"]'),
      cDone ? cDone.className + ' | ' + flat(cDone) : '(卡不在)');
    report('筛到一个"已经没有要拿的货"的厂家后，筛选自动回落「全部」（不回落会看到空网格）',
      !tabEl(7) && cards().length === 2 && !!cardByKey('S1 · 黑') && !!cardByKey('(未识别款) · 白') &&
        /全部 1/.test(flat(document.querySelector('[data-act="pk-tab-all"]'))),
      'tab7=' + !!tabEl(7) + ' cards=' + cards().length + ' 全部=' + flat(document.querySelector('[data-act="pk-tab-all"]')));
    report('没待拿的厂家不再占标签位，汇总行改说「已拿齐」、不再给复制/开单',
      !tabEl(7) && flat(sumRow(7)).indexOf('已拿齐') >= 0 &&
        !sumRow(7).querySelector('[data-act="pk-copy"]'),
      sumRow(7) ? flat(sumRow(7)) : '(行不在)');
    window.__allTaken = false;
    document.querySelector('[data-act="generate"]').click();
    await tryWait(function () { return !!tabEl(7); }, 8000);
    report('夹具复位后回到基准（已拿 4、厂A 标签回来）',
      !!tabEl(7) && flat(cardByKey('S1 · 黑').querySelector('[data-act="size-chip"][data-size="L"]')) === 'L×2');

    step('by-supplier');
    // 底部汇总条（2026-10-10）：一行一个厂家 = 「这家什么情况 + 复制发哪家 + 一键开单」。
    // 有厂家的在前、未指定的整段排最后（它不是一个可以发单的对象）。
    var rows = document.querySelectorAll('[data-act="pk-sum-row"]');
    report('底部汇总条：一行一个厂家（这里两行：厂A / 未指定）', rows.length === 2, 'rows=' + rows.length);
    report('有厂家的在前、未指定的排最后（带"去补供应商"的提示）',
      rows.length === 2 && rows[0].getAttribute('data-supplier') === '7' &&
        rows[1].getAttribute('data-supplier') === '0' &&
        flat(rows[0]).indexOf('厂A') >= 0 && flat(rows[1]).indexOf('未指定厂家') >= 0 &&
        flat(rows[1]).indexOf('给产品补上供应商') >= 0,
      rows.length === 2 ? (flat(rows[0]) + ' || ' + flat(rows[1])) : '(行数不对)');
    report('每行给出该厂家的**待拿**款色/件数/金额（发厂家时看的就是这一行）',
      rows.length === 2 && /1 款色 · 待拿 2 件 · ¥20\\.00/.test(flat(sumRow(7))),
      rows.length === 2 ? flat(sumRow(7)) : '(行数不对)');
    // ⚠️ "0 元" 与 "没查到价" 是两件事。该行整行没价 → 必须说"无进价"，不能写 ¥0.00
    //   （写 0 会被当成"这批货不值钱"，而不是"还不知道多少钱"）。
    report('整行无价时写「—（全部无进价）」而不是「预估 ¥0.00」（0 元 ≠ 不知道多少钱）',
      rows.length === 2 && /1 款色 · 待拿 1 件 · —（1 件全部无进价）/.test(flat(sumRow(0))) &&
        String(flat(sumRow(0))).indexOf('¥0.00') < 0,
      rows.length === 2 ? flat(sumRow(0)) : '(行数不对)');
    report('「复制给厂家」在**有厂家的行**上（带厂家 id）；未指定厂家那行没有可发的对象，不给按钮',
      !!sumRow(7).querySelector('[data-act="pk-copy"]') &&
        sumRow(7).querySelector('[data-act="pk-copy"]').getAttribute('data-supplier') === '7' &&
        !sumRow(0).querySelector('[data-act="pk-copy"]'));
    report('独立页不给「生成拿货单」（那是宿主「拿货」页的动作 —— 本组件只发意图，且只在宿主开了时出现）',
      !document.querySelector('[data-act="pk-create-order"]'));
    var sg = pkSumGuard(['pk-copy']);
    report('汇总条**在眼前**（几何 + 可达性）：没被压扁、底边在视口内、「复制给厂家」中心命中它自己',
      sg.ok, sg.detail);
    report('卡片区是网格布局（自适应列宽），不再是表格（重设计：货架而不是密排的行）',
      getComputedStyle(grid()).display === 'grid', getComputedStyle(grid()).display);

    step('scope');
    var scope = flat(document.querySelector('[data-act="scope"]'));
    report('已终结（关闭/已完成）剔除数写在标签上', !!document.querySelector('[data-act="excluded-finished"]'), scope);
    report('超窗剔除的行数也写出来', /超窗剔除 1 行/.test(scope), scope);
    report('无下单日期的行照收并计数', /无下单日期 1 行/.test(scope), scope);

    step('summary');
    // 缺口汇总成**一条**（原先四个标签分列两处）；「无进价」按**件数**说 ——
    // "还有几件货算不出钱"才是拿货时要看的
    var gaps = flat(document.querySelector('[data-act="gaps"]'));
    report('缺口一条说完：未识别款 1 / 缺图 1 / 缺供应商 1 / 缺件数 1 / 无进价 1 件',
      /未识别款 1/.test(gaps) && /缺图 1/.test(gaps) && /缺供应商 1/.test(gaps) &&
        /缺件数 1/.test(gaps) && /无进价 1 件/.test(gaps), gaps);
    report('缺口在精简条上、三个数在底部汇总条上（三个数与逐厂动作同屏；缺口只在有缺口时占地方）',
      !!document.querySelector('[data-act="pk-bar"]').querySelector('[data-act="gaps"]') &&
        !!document.querySelector('[data-act="pk-sum"]').querySelector('[data-act="amount"]'),
      flat(document.querySelector('[data-act="pk-bar"]')));

    step('thumb');
    var img = grid().querySelector('img');
    report('缩略图按三层回落路径合批取回并渲染（卡上是真 JPEG）',
      !!img && String(img.src).indexOf('data:image/jpeg') === 0 && calls('orderImageThumbBatch')[0].length >= 1,
      img ? String(img.src).slice(0, 32) : 'no img');
    report('缩略图请求带上 maxEdge（不是原图）',
      calls('orderImageThumbBatch')[0].every(function (x) { return typeof x.maxEdge === 'number' && x.localPath; }),
      JSON.stringify(calls('orderImageThumbBatch')[0]));
    report('缺图的卡画"缺图"占位（不是空图 —— 空占位与"没这类货"长得一样）',
      !!cardByKey('(未识别款) · 白').querySelector('.pk-card__noimg'));

    step('more');
    document.querySelector('[data-act="more"]').click();
    await waitFor(function () { return document.querySelector('[data-act="shop-pick"]'); }, 6000);
    report('「更多」展开后：天数窗 / 店铺 / 含已发货 可达',
      !!document.querySelector('[data-act="shop-pick"]') && !!document.querySelector('[data-act="include-shipped"]'));
    var shopSel = document.querySelector('[data-act="shop-pick"]');
    report('店铺下拉已加载店铺实体（店A）',
      Array.prototype.some.call(shopSel.options, function (o) { return o.value === '店A'; }),
      shopSel.options.length + ' options');

    step('regen');
    // 选了店铺**不点按钮**也要重算：条件变而清单不变，等于条件条在说谎（2026-10-10 新增行为）。
    var genBeforeShop = calls('pickingRows').length;
    var sel = document.querySelector('[data-act="shop-pick"]');
    sel.value = '店A';
    sel.dispatchEvent(new Event('change'));
    await tryWait(function () { return calls('pickingRows').length > genBeforeShop; }, 8000);
    var auto = calls('pickingRows')[calls('pickingRows').length - 1];
    report('只改店铺（不点生成）也会重算，且请求带上该店铺',
      calls('pickingRows').length > genBeforeShop && auto && auto.shop === '店A',
      JSON.stringify({ n: calls('pickingRows').length - genBeforeShop, shop: auto && auto.shop }));

    // 再点一次「重新生成」：按钮这条路仍然通（点击出参是唯一能抓"点了没反应"的手段）
    var before = calls('pickingRows').length;
    document.querySelector('[data-act="generate"]').click();
    await waitFor(function () { return calls('pickingRows').length > before; }, 8000);
    var last = calls('pickingRows')[calls('pickingRows').length - 1];
    report('改筛选后「重新生成」带上店铺（出参可验）', last.shop === '店A', JSON.stringify(last));

    step('scope-reflects-result');
    // 条件条上的天数窗必须是**本次清单实际用的那个数**（summary.days），不是输入框 ref：
    // 改了输入而表还是旧的时候，标签跟着输入一起变 = 界面自述与数据打架。
    var daysIn = document.querySelector('.pk-input--num');
    function setDays(v) { daysIn.value = String(v); daysIn.dispatchEvent(new Event('input')); }
    var genBeforeDays = calls('pickingRows').length;
    setDays(60);
    await tryWait(function () { return /近 60 天/.test(flat(document.querySelector('[data-act="scope"]'))); }, 8000);
    report('只改天数窗（**不点生成**）也会重算，条件条跟着走 → 近 60 天',
      calls('pickingRows').length > genBeforeDays &&
        /近 60 天/.test(flat(document.querySelector('[data-act="scope"]'))),
      'calls=' + calls('pickingRows').length + ' scope=' + flat(document.querySelector('[data-act="scope"]')));
    setDays(0);
    await tryWait(function () { return flat(document.querySelector('[data-act="scope"]')).indexOf('不限天数') >= 0; }, 8000);
    var s0 = flat(document.querySelector('[data-act="scope"]'));
    // 0 的含义是"不限"（cutoffDate 直接返回空串）—— 写成「近 0 天」会被读成"只看今天的单"，正好读反
    report('天数窗 0 说「不限天数」，不写「近 0 天」',
      s0.indexOf('不限天数') >= 0 && s0.indexOf('近 0 天') < 0, s0);
    setDays(30);
    await tryWait(function () { return /近 30 天/.test(flat(document.querySelector('[data-act="scope"]'))); }, 8000);

    step('export');
    // 生成期间按钮是 :disabled 的（Vue 下一个 tick 才解禁）→ 必须等它可用再点，否则点了没反应
    await waitFor(function () {
      var b = document.querySelector('[data-act="export"]');
      return b && !b.disabled;
    }, 8000);
    document.querySelector('[data-act="export"]').click();
    await waitFor(function () { return calls('pickingExportExcel').length >= 1; }, 8000);
    var exps = calls('pickingExportExcel');
    var exp = exps[exps.length - 1];
    report('导出交给主进程（exceljs 带图 + 按厂家分表），文件名带日期',
      exps.length === 1 && !!exp && /^拣货单-\\d{4}-\\d{2}-\\d{2}$/.test(exp.defaultName),
      JSON.stringify({ n: exps.length, name: exp && exp.defaultName }));
    var er = exp.rows;
    report('导出带上"已经算好的行"（件数/进价/金额/缺口文案，主进程只画表不重算）',
      er.length === 2 && er[0].supplierName === '厂A' && er[0].pieces === 6 &&
        er[0].unitPrice === 10 && er[0].amount === 60,
      JSON.stringify({ n: er.length, r0: er[0] && { s: er[0].supplierName, p: er[0].pieces, u: er[0].unitPrice, a: er[0].amount } }));
    // 「已拿 / 还差」也要随行传过去：xlsx 里是三列各自成列（picking-xlsx-smoke 验读回来的列），
    // 这里只验渲染层**把数交给了导出**（传 0/丢掉字段时那边读到的列会是一片 0，但它查不出"为什么"）。
    report('导出带上「已拿 / 还差」（拿货单拿的是"还差"，不是"需求"）',
      er[0].taken === 4 && er[0].remaining === 2 && er[1].taken === 0 && er[1].remaining === 1,
      JSON.stringify({ r0: { t: er[0].taken, r: er[0].remaining }, r1: { t: er[1].taken, r: er[1].remaining } }));
    report('图在渲染层被转成 **JPEG**（真实订单图大半是 WebP，Excel 嵌 webp 在旧版 Office 里看不见）',
      !!er[0].image && er[0].image.width === 64 && er[0].image.height === 64 &&
        er[0].image.base64.length > 100 && /^\\/9j\\//.test(er[0].image.base64),
      JSON.stringify({ has: !!er[0].image, w: er[0].image && er[0].image.width,
        len: er[0].image && er[0].image.base64 ? er[0].image.base64.length : 0 }));
    report('没图的组：image 传 null（不是空对象、更不是伪造一张）',
      er[1].image === null, JSON.stringify({ s: er[1].supplierName, img: er[1].image }));
    report('无进价的行：金额传 null（导出表里**留空**，不是写 0）',
      er.length === 2 && er[1].supplierName === '' && er[1].amount === null && er[1].unitPrice === null &&
        String(er[1].gaps).indexOf('无进价') >= 0,
      JSON.stringify({ s: er[1].supplierName, a: er[1].amount, g: er[1].gaps }));
    report('不再走旧的"渲染层纯文本导出"通道（带图导出已取代它）',
      calls('orderExportExcel').length === 0, 'orderExportExcel=' + calls('orderExportExcel').length);

    step('copy');
    // 「复制给厂家」（2026-10-10）：把**这一家**的待拿行画成一张 PNG（lib/pickingSheet 的 canvas
    // 渲染 + 现有缩略图），写进**系统图片剪贴板**（write-clipboard-image）—— 用户粘到微信里发出去。
    // 数全部与屏上同源（sheetModelOf 走 pendingOf）⇒ 发出去的图与卡上的数不可能两套。
    var copyBtn = sumRow(7).querySelector('[data-act="pk-copy"]');
    report('厂家行给「复制给厂家」（带厂家 id —— 一张图只发这一家）',
      !!copyBtn && copyBtn.getAttribute('data-supplier') === '7');
    copyBtn.click();
    await tryWait(function () { return calls('writeClipboardImage').length >= 1; }, 8000);
    var png = calls('writeClipboardImage')[0] || '';
    report('写进剪贴板的是**图片通道**（PNG dataURL），不是文本',
      typeof png === 'string' && png.indexOf('data:image/png;base64,') === 0 && png.length > 2000,
      'type=' + typeof png + ' len=' + (typeof png === 'string' ? png.length : 0));
    // 非空转：把 dataUrl 真的解码一次 —— 空壳（画布不可用 / 返回空串）在这里会当场红。
    var okPng = await new Promise(function (res) {
      var im = new Image();
      im.onload = function () { res(im.naturalWidth > 0 && im.naturalHeight > 0); };
      im.onerror = function () { res(false); };
      im.src = png;
    });
    report('清单图能解码出像素（真 PNG，不是空壳 dataUrl）', okPng,
      'w=' + (typeof png === 'string' ? png.length : 0));
    await tryWait(function () { return toastHas('已复制'); }, 4000);
    report('复制成功后提示说清"几家几件 + 发给谁"（能核对，不是一句"复制成功"）',
      toastHas('已复制 1 款色 · 2 件 的清单图') && toastHas('厂A'), toastDump());
    // 失败分支：写剪贴板失败必须**说出来**（静默失败会让用户粘出上一张旧图，还以为发对了）
    await tryWait(function () {
      var b = sumRow(7).querySelector('[data-act="pk-copy"]');
      return !!b && !b.disabled;
    }, 4000);
    window.__clipFail = true;
    sumRow(7).querySelector('[data-act="pk-copy"]').click();
    await tryWait(function () { return toastHas('复制失败'); }, 4000);
    report('写剪贴板失败时如实报错（不装作已复制 —— 否则用户粘出的是上一张图）',
      toastHas('复制失败'), toastDump());
    window.__clipFail = false;

    step('all-unpriced');
    // 「0 元」与「没查到价」是两件事：一件价都查不到时写「¥0.00」，读起来是"这批货不值钱"。
    window.__noCosts = true;
    document.querySelector('[data-act="generate"]').click();
    await waitFor(function () {
      var el = amountEl();
      return el && flat(el).indexOf('全部无进价') >= 0;
    }, 8000);
    var amt = flat(amountEl());
    report('一件价都查不到 → 总账写「预估 —（N 件全部无进价）」，**不写 ¥0.00**',
      /预估 —/.test(amt) && /3 件全部无进价/.test(amt) && amt.indexOf('¥0.00') < 0, amt);
    report('全都没价时两张卡的单价都是「—」，不是 0.00',
      flat(unitEl('S1 · 黑')) === '—' && flat(unitEl('(未识别款) · 白')) === '—',
      JSON.stringify({ r1: flat(unitEl('S1 · 黑')), r2: flat(unitEl('(未识别款) · 白')) }));
    report('全都没价时卡面小计也走「—」（不写 ≈¥0.00，也不把无价件当 0 元加进小计）',
      flat(cardAmount('S1 · 黑')) === '—' && flat(cardAmount('(未识别款) · 白')) === '—',
      JSON.stringify({ r1: flat(cardAmount('S1 · 黑')), r2: flat(cardAmount('(未识别款) · 白')) }));
    window.__noCosts = false;

    step('empty-branches');
    // P0-3②：空态要分"还没生成过"与"生成过但没货可拣" —— 后者得说清为什么空，而不是继续催人点生成。
    // ⚠️ **两种剔除原因各验一遍**，且各自的"下一步"必须只给对这个原因有效的那个
    //   （原先只有「已终结」这一支被覆盖，而用户实报的是「超窗」那支 —— 句子合并写法两边都不准）。
    window.__onlyFinished = true;
    document.querySelector('[data-act="generate"]').click();
    await waitFor(function () { return flat(document.querySelector('[data-act="empty"]')).indexOf('没有要拣的货') >= 0; }, 8000);
    var eFin = flat(document.querySelector('[data-act="empty"]'));
    report('空态①（全被「已终结」剔掉）→ 点名已终结，且**不给**"调大天数窗"这种无效动作',
      /扫了 1 行/.test(eFin) && eFin.indexOf('已终结') >= 0 && eFin.indexOf('近 30 天') < 0 &&
        !document.querySelector('[data-act="empty-widen"]') && eFin.indexOf('连已发货') < 0,
      eFin);

    window.__onlyFinished = false;
    window.__onlyOld = true;
    document.querySelector('[data-act="generate"]').click();
    await tryWait(function () { return flat(document.querySelector('[data-act="empty"]')).indexOf('超窗') >= 0; }, 8000);
    var eOld = flat(document.querySelector('[data-act="empty"]'));
    // 「超窗」这一支必须说清"是哪个窗"（否则用户不知道拿什么去比），且不得提"已终结"
    report('空态②（全被「超窗」剔掉，用户实报场景）→ 点名超窗 + 说清是哪个窗',
      /扫了 1 行/.test(eOld) && eOld.indexOf('超窗') >= 0 && /近 30 天/.test(eOld) &&
        eOld.indexOf('已终结') < 0,
      eOld);
    // 提示不是入口：这一支必须给**真按钮**，且点了真的把「更多」展开（天数窗输入框出现）
    report('空态②的下一步是按钮而不是一句"去「更多」调"',
      !!document.querySelector('[data-act="empty-widen"]'),
      flat(document.querySelector('[data-act="empty-widen"]')));
    if (document.querySelector('.pk-input--num')) {
      document.querySelector('[data-act="more"]').click(); // 先收起，才能验"按钮真的把它打开了"
      await tryWait(function () { return !document.querySelector('.pk-input--num'); }, 4000);
    }
    if (document.querySelector('[data-act="empty-widen"]')) {
      document.querySelector('[data-act="empty-widen"]').click();
      await tryWait(function () { return !!document.querySelector('.pk-input--num'); }, 4000);
    }
    report('点空态按钮 → 「更多」面板真的展开（能直接改天数窗，不用自己去翻）',
      !!document.querySelector('.pk-input--num'));

    window.__onlyOld = false;
    window.__noPickingRows = true;
    document.querySelector('[data-act="generate"]').click();
    await waitFor(function () { return flat(document.querySelector('[data-act="empty"]')).indexOf('一行订单都没扫到') >= 0; }, 8000);
    report('一行都没扫到 → 指向宿主的导入入口（不再让用户猜）',
      !!document.querySelector('[data-act="empty-import"]') &&
        flat(document.querySelector('[data-act="empty"]')).indexOf('导入 Excel') >= 0,
      flat(document.querySelector('[data-act="empty"]')));
    report('空态下三块（网格 / 标签 / 汇总条）整块不渲染（不是留着空壳）',
      !grid() && !document.querySelector('[data-act="pk-tabs"]') &&
        !document.querySelector('[data-act="pk-sum"]') && !amountEl());
    window.__navs = [];
    window.addEventListener('switch-module', function (e) { window.__navs.push(e.detail); });
    document.querySelector('[data-act="empty-import"]').click();
    await waitFor(function () { return (window.__navs || []).length >= 1; }, 5000);
    report('空态按钮派发 switch-module → today',
      window.__navs[0] && window.__navs[0].moduleId === 'today', JSON.stringify(window.__navs));

    step('errors');
    report('无未捕获错误', (window.__smokeErrors || []).length === 0,
      JSON.stringify(window.__smokeErrors || []));
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

const indexPath = path.join(WORK, 'index.html');
let html = readFileSync(indexPath, 'utf8');
html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '');
html = html.replace('</head>', () => FAKE_BRIDGE + '</head>');
html = html.replace('</body>', () => ASSERT_SCRIPT + '</body>');
writeFileSync(indexPath, html);

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.woff2': 'font/woff2',
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

const dom = await new Promise((resolve, reject) => {
  const cp = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--virtual-time-budget=45000',
    '--dump-dom',
    `http://127.0.0.1:${PORT}/index.html`,
  ]);
  let out = '';
  cp.stdout.on('data', (d) => (out += String(d)));
  cp.on('error', reject);
  cp.on('close', () => resolve(out));
});
server.close();

const m = dom.match(/id="smoke-result"[^>]*>([\s\S]*?)<\/pre>/);
if (!m) {
  const title = (dom.match(/<title>([\s\S]*?)<\/title>/) || [])[1] || '(无标题)';
  console.error('✗ 没抓到 #smoke-result（页面可能没挂载）。DOM title =', title);
  console.error('  排查顺序：产物新鲜度（npm run build）→ 资源 404 → 内联脚本语法错 → fake 桥缺键导致 boot 崩');
  process.exit(1);
}
const text = m[1]
  .replace(/&amp;/g, '&')
  .replace(/&lt;/g, '<')
  .replace(/&gt;/g, '>')
  .trim();
console.log(text);
const ok = text.split('\n').pop() === 'SMOKE: ALL PASS';
console.log(ok ? '\n✓ 拣货页冒烟通过' : '\n✗ 拣货页冒烟失败');
process.exit(ok ? 0 : 1);
