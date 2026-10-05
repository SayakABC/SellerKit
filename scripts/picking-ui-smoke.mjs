// 「拣货」页**假桥无头冒烟**（不启动真实宿主，不需要 Electron）。
//
//   npm run picking:ui
//
// 为什么需要它：这一页有三路取数（订单行投影 / 结算件数 / 合批缩略图）+ 一条导出链，而纯层单测
// 只覆盖到 `aggregatePicking`；**接线**（IPC 键名、字段名、键口径、导出 buffer 真的生成了没有）
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
      //   __onlyFinished → 只有一行"订单关闭"（scanned>0 但全被剔除 → "扫了 N 行都被排除"）
      //   __noPickingRows → 一行都没有（scanned=0 → "一行订单都没扫到" + 去导入）
      if (window.__onlyFinished) return { success: true, data: { rows: [row({ id: 9, orderNo: 'OC', bizStatus: '订单关闭', qty: 1 })], meta: { rows: 1, limit: 2000 } } };
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
    // 进价来源（款级成本区间，与「算钱」页同一张表）。只给 S1 定价 → 恰好造出"有价 / 无价"两种行：
    //   S1 · 黑 · L 有价（10 元/件）、(未识别款) · 白 · M 无价 → 金额只含前者，缺价件数照报。
    'aeCostMapList': function () {
      rec('aeCostMapList', {});
      // __noCosts：造"一件价都查不到"的场景（用于验"0 元 ≠ 不知道多少钱"这条表达）
      if (window.__noCosts) return { success: true, data: [] };
      return { success: true, data: [{ styleCode: 'S1', effectiveFrom: '2026-01-01', unitPriceCents: 1000, source: 'purchase' }] };
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
      // 症状是「没抓到 #smoke-result」（会把排查方向带到产物/注入上去）。实测踩过，见 docs/notes/2026-09-30-headless-smoke-waitfor-trap.md
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
function table() { return document.querySelector('[data-act="picking-table"]'); }
function bodyRows() { var t = table(); return t ? t.querySelectorAll('tbody tr') : []; }
function rowByKey(key) {
  var rows = bodyRows();
  for (var i = 0; i < rows.length; i++) { if (rows[i].getAttribute('data-key') === key) return rows[i]; }
  return null;
}
function cellsOf(row) {
  return row ? Array.prototype.map.call(row.querySelectorAll('td'), function (td) { return flat(td); }) : [];
}

async function main() {
  try {
    step('boot');
    await waitFor(function () { return document.querySelector('.pk-view'); }, 10000);
    report('挂载：拣货视图渲染', true);

    step('first-screen');
    // 一键语义：未点按钮**不出清单**（清单是"此刻的快照"，不该在用户没要求时自己刷新）
    report('首屏是空态提示、无清单（点按钮才生成）',
      !!document.querySelector('[data-act="empty"]') && !table(), 'empty=' + !!document.querySelector('[data-act="empty"]'));
    report('首屏不自动取数', calls('pickingRows').length === 0, 'pickingRows=' + calls('pickingRows').length);
    report('首屏保留主操作：生成 + 导出（导出在无清单时禁用）',
      !!document.querySelector('[data-act="generate"]') &&
        document.querySelector('[data-act="export"]').disabled === true);
    report('默认条件写在界面上（未发货 · 近 30 天）',
      flat(document.querySelector('[data-act="scope"]')).indexOf('未发货') >= 0 &&
        /近 30 天/.test(flat(document.querySelector('[data-act="scope"]'))),
      flat(document.querySelector('[data-act="scope"]')));
    report('首屏默认收起低频筛选（天数/店铺/含已发货）',
      !document.querySelector('[data-act="shop-pick"]') && !document.querySelector('[data-act="include-shipped"]'));

    step('generate');
    document.querySelector('[data-act="generate"]').click();
    await waitFor(function () { return bodyRows().length >= 1; }, 8000);
    report('点「生成待拣清单」→ 出清单', bodyRows().length >= 1, 'rows=' + bodyRows().length);
    report('四路取数都发出去了（投影 + 结算 + 成本 + 缩略图合批）',
      calls('pickingRows').length === 1 && calls('settleOrders').length === 1 &&
        calls('aeCostMapList').length === 1 && calls('orderImageThumbBatch').length === 1,
      JSON.stringify({ p: calls('pickingRows').length, s: calls('settleOrders').length,
        c: calls('aeCostMapList').length, t: calls('orderImageThumbBatch').length }));
    report('投影只回未发货（默认不带 includeShipped）',
      calls('pickingRows')[0].includeShipped === false, JSON.stringify(calls('pickingRows')[0]));

    step('groups');
    // 可验算：S1·黑·L = 报表 2 件 + 结算真值 3 件 = 5 件 / 2 单
    var g1 = rowByKey('S1 · 黑 · L');
    var c1 = cellsOf(g1);
    report('同 SKU 合成一组：2（报表）+ 3（结算真值）+ 1（无件数按 1）= 6 件 / 3 单',
      !!g1 && c1.indexOf('6') >= 0 && c1.indexOf('3') >= 0, c1.join(' | '));
    var g2 = rowByKey('(未识别款) · 白 · M');
    report('未识别款/缺色码各自成组（键写在表里，肉眼可见）', !!g2, 'keys=' + Array.prototype.map.call(bodyRows(), function (r) { return r.getAttribute('data-key'); }).join(' / '));
    var c2 = cellsOf(g2);
    report('缺图 / 缺供应商 / 未识别款 逐行标出',
      c2.join(' | ').indexOf('缺图') >= 0 && c2.join(' | ').indexOf('缺供应商') >= 0 &&
        c2.join(' | ').indexOf('未识别款') >= 0, c2.join(' | '));
    report('关闭单的 5 件没被算进来（含它就该是 12 而不是 7）',
      flat(document.querySelector('.pk-topbar')).indexOf('件数 7') >= 0,
      flat(document.querySelector('.pk-topbar')));

    step('money');
    // 进价/金额（S3）：单价来自 aeCostMapList（S1 = 10 元/件），逐行 件数×单价 累加。
    // 可验算：S1·黑·L 6 件 × 10 = 60；(未识别款) 那组没有价 → 不计入，但要作为"无进价"报出来。
    report('顶部给出预估金额（只含有价部分）', /预估金额 ¥60\\.00/.test(flat(document.querySelector('[data-act="amount"]'))),
      flat(document.querySelector('[data-act="amount"]')));
    report('无进价的件数单独报出（不混进金额，也不省略）',
      /无进价 1 件/.test(flat(document.querySelector('[data-act="missing-price"]'))),
      flat(document.querySelector('[data-act="missing-price"]')));
    var g1money = rowByKey('S1 · 黑 · L');
    report('有价的组：进价 10.00 / 金额 60.00（件数×单价，不是"件数合计×某一价"）',
      flat(g1money.querySelector('[data-act="unit-price"]')) === '10.00' &&
        flat(g1money.querySelector('[data-act="amount-cell"]')) === '60.00',
      cellsOf(g1money).join(' | '));
    var g2money = rowByKey('(未识别款) · 白 · M');
    report('无价的组：金额列**留空号而不是 0**，且在「缺」列标出「无进价」',
      flat(g2money.querySelector('[data-act="amount-cell"]')) === '—' &&
        flat(g2money).indexOf('无进价') >= 0,
      cellsOf(g2money).join(' | '));

    step('by-supplier');
    // 按厂家分组（S3）：段标题跨列，有厂家的在前、未指定的整段排最后。
    var heads = document.querySelectorAll('[data-act="supplier-head"], [data-act="supplier-head-none"]');
    report('清单按厂家分段（这里两组：厂A / 未指定）', heads.length === 2, 'heads=' + heads.length);
    report('有厂家的段在前、未指定的段排最后',
      heads.length === 2 && heads[0].getAttribute('data-act') === 'supplier-head' &&
        heads[1].getAttribute('data-act') === 'supplier-head-none' &&
        flat(heads[0]).indexOf('厂A') >= 0,
      heads.length === 2 ? (flat(heads[0]) + ' || ' + flat(heads[1])) : '(段数不对)');
    report('段标题给出该厂家的 SKU 数/件数/金额（发厂家时看的就是这一行）',
      heads.length === 2 && /1 个 SKU · 6 件/.test(flat(heads[0])) && /预估 ¥60\\.00/.test(flat(heads[0])),
      heads.length === 2 ? flat(heads[0]) : '(段数不对)');
    // ⚠️ "0 元" 与 "没查到价" 是两件事。该段整段没价 → 段标题必须说"无进价"，不能写 ¥0.00
    //   （写 0 会被当成"这批货不值钱"，而不是"还不知道多少钱"）。
    report('整段无价时，段标题说「无进价」而不是「预估 ¥0.00」（0 元 ≠ 不知道多少钱）',
      heads.length === 2 && /1 个 SKU · 1 件 · 无进价（1 件）/.test(flat(heads[1])) &&
        String(flat(heads[1])).indexOf('¥0.00') < 0,
      heads.length === 2 ? flat(heads[1]) : '(段数不对)');
    report('表格被放进可横滚的包裹层（加了两列后，窄窗口下右半截会被裁掉）',
      !!table().closest('.wb-table-wrap'));

    step('scope');
    var scope = flat(document.querySelector('[data-act="scope"]'));
    report('已终结（关闭/已完成）剔除数写在标签上', !!document.querySelector('[data-act="excluded-finished"]'), scope);
    report('超窗剔除的行数也写出来', /超窗剔除 1 行/.test(scope), scope);
    report('无下单日期的行照收并计数', /无下单日期 1 行/.test(scope), scope);

    step('summary');
    var top = flat(document.querySelector('.pk-topbar'));
    // 汇总：SKU 3 组（S1·黑·L / S1·黑·L 之外还有 O6 与未识别款）… 用件数锚死：5 + 1 + 1 + 1 = 8
    report('顶部统计：2 个 SKU / 件数 7 / 涉及订单 4',
      /SKU 2/.test(top) && /件数 7/.test(top) && /涉及订单 4/.test(top), top);
    report('缺件数 1（该行无商品信息块）/ 缺图 1 / 缺供应商 1 / 未识别款 1 四项计数可见',
      /缺件数 1/.test(flat(document.querySelector('[data-act="missing-qty"]'))) &&
        /缺图 1/.test(flat(document.querySelector('[data-act="missing-image"]'))) &&
        /缺供应商 1/.test(flat(document.querySelector('[data-act="missing-supplier"]'))) &&
        /未识别款 1/.test(flat(document.querySelector('[data-act="missing-style"]'))),
      flat(document.querySelector('.pk-gaps')));

    step('thumb');
    var img = table().querySelector('tbody img');
    report('缩略图按三层回落路径合批取回并渲染',
      !!img && String(img.src).indexOf('data:image/jpeg') === 0 && calls('orderImageThumbBatch')[0].length >= 1,
      img ? String(img.src).slice(0, 32) : 'no img');
    report('缩略图请求带上 maxEdge（不是原图）',
      calls('orderImageThumbBatch')[0].every(function (x) { return typeof x.maxEdge === 'number' && x.localPath; }),
      JSON.stringify(calls('orderImageThumbBatch')[0]));

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
    // 选了店铺再生成 → 请求必须带该店铺（点击出参是唯一能抓"点了没反应"的手段）
    var sel = document.querySelector('[data-act="shop-pick"]');
    sel.value = '店A';
    sel.dispatchEvent(new Event('change'));
    var before = calls('pickingRows').length;
    document.querySelector('[data-act="generate"]').click();
    await waitFor(function () { return calls('pickingRows').length > before; }, 8000);
    var last = calls('pickingRows')[calls('pickingRows').length - 1];
    report('改筛选后「重新生成」带上店铺（出参可验）', last.shop === '店A', JSON.stringify(last));

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

    step('all-unpriced');
    // 「0 元」与「没查到价」是两件事：一件价都查不到时写「¥0.00」，读起来是"这批货不值钱"。
    // 截图复核时实测发现过（未指定厂家的段标题当时就写着 预估 ¥0.00）。
    window.__noCosts = true;
    document.querySelector('[data-act="generate"]').click();
    await waitFor(function () {
      var el = document.querySelector('[data-act="amount"]');
      return el && flat(el).indexOf('全部无进价') >= 0;
    }, 8000);
    var amt = flat(document.querySelector('[data-act="amount"]'));
    report('一件价都查不到 → 顶部写「—（N 件全部无进价）」，**不写 ¥0.00**',
      /预估金额 —/.test(amt) && /7 件全部无进价/.test(amt) && amt.indexOf('¥0.00') < 0, amt);
    report('全都没价时「进价 / 预估金额」两列都是「—」，不是 0.00',
      flat(document.querySelector('[data-act="unit-price"]')) === '—' &&
        flat(document.querySelector('[data-act="amount-cell"]')) === '—',
      JSON.stringify({ up: flat(document.querySelector('[data-act="unit-price"]')),
        am: flat(document.querySelector('[data-act="amount-cell"]')) }));

    step('empty-branches');
    // P0-3②：空态要分"还没生成过"与"生成过但没货可拣" —— 后者得说清为什么空，而不是继续催人点生成。
    // （首屏那一支在 'boot' 步已断言过文案；这里断言"生成之后仍为空"的两支）
    window.__onlyFinished = true;
    document.querySelector('[data-act="generate"]').click();
    await waitFor(function () { return flat(document.querySelector('[data-act="empty"]')).indexOf('没有要拣的货') >= 0; }, 8000);
    report('生成后为空（行都被剔除）→ 说清扫了几行、被谁排除，并给出放宽办法',
      /扫了 1 行/.test(flat(document.querySelector('[data-act="empty"]'))) &&
        flat(document.querySelector('[data-act="empty"]')).indexOf('天数窗') >= 0,
      flat(document.querySelector('[data-act="empty"]')));
    window.__onlyFinished = false;
    window.__noPickingRows = true;
    document.querySelector('[data-act="generate"]').click();
    await waitFor(function () { return flat(document.querySelector('[data-act="empty"]')).indexOf('一行订单都没扫到') >= 0; }, 8000);
    report('一行都没扫到 → 指向宿主的导入入口（不再让用户猜）',
      !!document.querySelector('[data-act="empty-import"]') &&
        flat(document.querySelector('[data-act="empty"]')).indexOf('导入 Excel') >= 0,
      flat(document.querySelector('[data-act="empty"]')));
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