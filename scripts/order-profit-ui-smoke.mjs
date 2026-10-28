// 「订单利润」页**假桥无头冒烟**（不启动真实宿主，不需要 Electron）。
//
//   npm run order-profit:ui
//
// 为什么需要它：这一页有四路取数（订单行 / SKU 克重 / 包裹运费 / 运价表快照）与一条跨域算账链
// （C2 起成本只认订单行自己的两个快照，不再单独拉一张款级价目表），
// 但纯层单测只覆盖到 `computeOrderCosts`；**接线**（IPC 键名、字段名、分→元、快照是否真被走）
// 从未被跑过 —— 而这类错全是静默的（数字不对但页面正常）。
//
// 做法（照 `esm-spa-headless-smoke` 技能）：
//   build 产物 → 复制到隔离目录 → 注入 fake `window.electronAPI` + 断言脚本
//   → 本地 HTTP 服务器（**必须 HTTP**：file:// 下 ESM 被 CORS 拦，页面根本不挂载）
//   → 无头 Chrome `--dump-dom` → 抓 `#smoke-result`
//
// 断言纪律（技能里的踩坑）：
//   · 用**可验算的具体样本**断言精确值（275g → 80/kg×0.275 + 挂号 8 = 30；成本 10；收入 165.18 → 毛利 125.18），
//     不断"有内容/大于 0"；
//   · 点击后断言 **fake 桥收到了预期调用**（含 payload），这是唯一能抓"点了没反应"的手段；
//   · 注入一律用**函数式 replace**（字符串形式会把注入内容里的 `$$` 折成 `$`）；
//   · 每段打 STEP 标记，超时能定位到哪一段；
//   · ⚠️ **注入脚本（FAKE_BRIDGE / ASSERT_SCRIPT）里的注释不能含反引号** —— 它们本身是模板字符串，
//     一个反引号就把字符串截断 → 整段不执行 → 表现为 NO RESULT（本项目已踩过两次）。改完先 `node --check`。
//
// ⚠️ **2026-10-01 重定基（克重来源变了，本文件的期望值整批换过）**：领域裁定「克重是 SKU 属性」后，
//   「商品ID → 克重」（`pl_item_weights` + `productWeightGet`）那条链整条删除、表也 DROP。
//   于是本页的克重**只有一个来源**：产品库 SKU（款 × 色 × 码，`pl_variants.weight_g` = 275g）。
//   旧样本的 100g（→ 运费 16.00 → 毛利 139.18）已不存在；现值 275g → 运费 30.00 → 毛利 125.18。
//   `productWeightGet` 的桩**保留**，但改当**绊线**：调了就有记录，断言要求次数为 0。

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'renderer');
const WORK = path.join('/tmp', 'sellerkit-order-profit-smoke');
const PORT = 8123;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error(`✗ 找不到构建产物 ${DIST}/index.html —— 先跑 npm run build`);
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error(`✗ 找不到无头 Chrome：${CHROME}`);
  process.exit(1);
}

// ─────────────────────────────────────────────────────────── 1. 隔离目录 + 注入
rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
cpSync(DIST, WORK, { recursive: true });

const FAKE_BRIDGE = `<script>
(function () {
  var calls = {};
  window.__smokeCalls = calls;
  function rec(name, payload) { (calls[name] = calls[name] || []).push(payload); }

  // ---- 可验算的样本：275g → 80/kg×0.275 + 挂号 8 = 30 元；行上进价预估 10 元；收入 165.18；平台已税 → 税 0 ----
  var RATE_TABLE = {
    sheetName: 'smoke', countries: [{ code: 'US', nameCn: '美国', nameEn: 'United States', cards: [
      { minG: 0, maxG: 2000, categories: ['general'], mode: 'perKg', ratePerKg: 80, registerFee: 8,
        firstFee: 0, stepFee: 0, baseG: 0, stepG: 0, variant: '', sec: 1, currency: 'CNY', minChargeG: 10 }] }],
    sections: [], stats: { sections: 1, countries: 1, cards: 1, perKgCards: 1, firstStepCards: 0, currencies: ['CNY'] }, warnings: [],
  };
  // 店铺由"归属"动态决定（起始为空 → 能看到"未归属"提示，归属后变有）
  window.__shop = '';
  // 件数取自订单报表「商品信息」块（2 件）；__noQtyInfo 打开后模拟"报表没有数量"→ 应兜底 1 件并标缺
  window.__noQtyInfo = false;
  // 采集侧（C1 合并的第二条摄取通道）：默认关闭，最后一步打开验证"合并"接线
  window.__collectedOn = false;
  // 采集帧的**真实缺口**：无店铺 / 无商品ID / 无代征代缴列 / 无款编码；件数是采集真值
  var COLLECTED = [{
    id: 9001, orderNo: 'C-1', source: 'collect', shop: '', orderTime: '2026-09-25 10:00:00',
    styleCode: '', styleColor: '', color: '黑', size: 'L', itemId: '',
    supplierId: 0, supplierName: '', qty: 2, amountCents: 20000,
    vatCents: null, ddpCents: null, taxPlatform: '', bizStatus: '等待发货', rawFields: {},
  }];
  var ORDER = {
    id: 1, orderNo: 'SMOKE-1', source: 'import', shop: '', orderTime: '2026-09-10 12:00:00',
    styleCode: 'S1', styleColor: '红', color: '黑', size: 'L',
    supplierId: 7, supplierName: '厂A',
    // C2：利润只认订单行自己的两个成本快照（实际进价 > 进价预估 > 缺）。
    // 这一行是"确认过、钉了预估"的样本（10.00）；采集行没有快照 ⇒ 如实标缺成本。
    costCents: 1000, actualCostCents: null,
    amountCents: 16518, vatCents: 3469, ddpCents: 2294,
    bizStatus: '交易完成', taxPlatform: '平台已税',
    rawFields: { '收货国家': '美国', '商品ID': 'ITEM1', '商品信息': '【1】 smoke 款 (产品属性:Color:黑、Size:L)\\n(商品数量:2 piece)' },
  };

  var OVERRIDES = {
    'getAppVersion': function () { return { success: true, data: '0.0.0-smoke' }; },
    'get-app-version': function () { return { success: true, data: '0.0.0-smoke' }; },
    // 让外壳恢复"上次所在模块" = 本页（省掉点侧边栏，断言聚焦本页）
    'getModuleState': function (ns) {
      if (ns === 'app-shell') return { success: true, data: { lastActiveModuleId: 'order-cost', collapsed: false } };
      return { success: true, data: null };
    },
    'orderShippingRows': function (p) {
      rec('orderShippingRows', p);
      // 末段用：把数据抽干，验空态给的是"可点的下一步"而不是一句干话
      if (window.__noOrders) return { success: true, data: [] };
      // 店铺随"归属"变化（模拟真实落库后的下一次读取）；raw_fields 逐次深拷一份再按需删键
      var row = {}; for (var k in ORDER) row[k] = ORDER[k];
      row.rawFields = {}; for (var f in ORDER.rawFields) row.rawFields[f] = ORDER.rawFields[f];
      if (window.__noQtyInfo) delete row.rawFields['商品信息'];
      row.shop = window.__shop || '';
      // 缺汇率：采集帧是外币、ae_rates 查不到该币种 ⇒ 宿主落库时金额**只能是 NULL**（写 0 会把
      // "算不出来"伪装成"收入为零"）。造这一支只为验「界面把缺汇率与缺收入分开标」——
      // 两者补法不同（去「成本与汇率」补一条 / 报表里压根没有），见 src/lib/orderCost.ts 的 fx。
      var collected = COLLECTED;
      if (window.__rateMissing) {
        collected = COLLECTED.map(function (r) {
          var c = {}; for (var k in r) c[k] = r[k];
          c.amountCents = null;
          return c;
        });
      }
      // **一个读口**：采集行与导入行在同一个返回里（按 source 区分，标签由宿主给）
      return { success: true, data: window.__collectedOn ? [row].concat(collected) : [row] };
    },
    // ⚠️ **已删通道的绊线**：productWeightGet（商品ID → 克重，pl_item_weights）随 2026-10-01 的
    //    领域裁定整条退场（克重是 SKU 属性），表已被 product.sku v3 迁移 DROP。
    //    桩**故意留着**：页面若又去调它，calls 里就会留下记录，断言段要求次数为 0（读一张已不存在的表）。
    'productWeightGet': function (p) {
      rec('productWeightGet', p);
      return { success: true, data: { weights: {} } };
    },
    'productList': function (p) { rec('productList', p); return { success: true, data: { rows: [{ id: 1, code: 'S1', name: '款一', supplierId: 0, supplierName: '', category: '', status: 'active', costCents: 1000, updatedAt: '' }], total: 1 } }; },
    'productVariantList': function (p) {
      rec('productVariantList', p);
      // __noSkuWeight 打开 → 模拟"这一款还没在「货与成本」里维护克重"：该行必须如实标缺，不许静默当 0
      if (window.__noSkuWeight) {
        return { success: true, data: { rows: [{ id: 11, productId: 1, code: '', name: '黑 L', color: '黑', size: 'L', weightG: 0, status: 'active' }] } };
      }
      return { success: true, data: { rows: [{ id: 11, productId: 1, code: '', name: '黑 L', color: '黑', size: 'L', weightG: 275, status: 'active' }] } };
    },
    // 成本与汇率（C9 从岛收编进「算钱」；2026-10-14 整合后本区**只读**，写入搬去「基础数据」）：
    // 汇率必须有数据，否则"只读也列得出现状"这条测不到；upsert 桩保留但断言要求 0 次调用
    // （真录入闭环在 scripts/master-data-ui-smoke.mjs 的 rates 步）。
    'aeRateList': function () {
      rec('aeRateList', {});
      return { success: true, data: [{ fromCurrency: 'USD', rateToCny: 7.1, updatedAt: '' }] };
    },
    'aeRateUpsert': function (p) { rec('aeRateUpsert', p); return { success: true, data: { ok: true } }; },
    'setModuleState': function (ns, data) { rec('setModuleState', { ns: ns, data: data }); return { success: true }; },
    // 结算数据（精准轨）：只给 SMOKE-1 → 净收入 90.86 → 精准毛利 = 90.86 − 30 − 10 = 50.86
    // 结算数据用**开关**控制：先验预测轨（空），再打开验精准轨 —— 两轨都要跑
    'settleOrders': function (p) {
      rec('settleOrders', p);
      var rows = window.__settleOn ? [{ orderNo: 'SMOKE-1', settleStatus: '已结算', pendingReason: '',
        dealCents: 10000, netIncomeCents: 9086, splitCents: 914, feeSumCents: 914, itemLines: 1, from: 'order',
        // 商品行件数**故意与报表块的 2 不同（=3）**：用来证明"结算真值确实盖过报表值"这条接线真的通了
        items: [{ itemId: 'ITEM1', lines: 1, qty: 3 }] }] : [];
      return { success: true, data: { rows: rows } };
    },
    'shopDbEnsure': function () { return { success: true, data: { ok: true } }; },
    'shopList': function (p) {
      rec('shopList', p);
      return { success: true, data: { rows: [{ id: 1, name: '店A', platform: 'aliexpress', nameKey: '店a' }], total: 1 } };
    },
    'orderAssignShop': function (p) {
      rec('orderAssignShop', p);
      window.__shop = p && p.shopName ? p.shopName : ''; // 模拟落库
      return { success: true, data: { updated: 1 } };
    },
    'settleStats': function () { rec('settleStats', {}); return { success: true, data: { lines: 0, orders: 0, itemLines: 0, orderLines: 0, pendingOrders: 0, settledOrders: 0, lastImportedAt: '' } }; },
    'shipRateSnapshotCalc': function (p) {
      rec('shipRateSnapshotCalc', p);
      return { success: true, data: { rows: [{ id: 1, effectiveFrom: '2026-09-01', sourceFile: 'smoke.xlsx', sheetName: 's1', table: RATE_TABLE }] } };
    },
    // 包裹运费（阶段 C1）：默认"还没拆包"；打开 __parcelOn → SMOKE-1 两个包合计 45.00。
    // 45 ≠ 运价表的 30 —— 只有不同的两个数才能证明"到底走了哪条链"（同值会让断言语义空转）。
    // __parcelMissing 再打开 → 其中一个包没填运费（shipCents=null）⇒ 整单运费必须给「—」并标缺，
    // **不回落运价表估算**（回落会把用户填的真值盖掉且行上无痕）。
    'orderParcelTotals': function (p) {
      rec('orderParcelTotals', p);
      if (!window.__parcelOn) return { success: true, data: {} };
      return { success: true, data: { 'SMOKE-1': {
        count: 2,
        shipCents: window.__parcelMissing ? null : 4500,
        weightG: 330,
        shipMissing: window.__parcelMissing ? 1 : 0,
        weightMissing: 0,
      } } };
    },
  };

  window.electronAPI = new Proxy({}, {
    get: function (_t, key) {
      if (typeof key !== 'string') return undefined;
      var fn = OVERRIDES[key];
      // ⚠️ 必须转发**全部**实参：setModuleState(ns, data) 是两个参数，
      //    只转第一个会让落盘断言永远拿不到 data（曾据此误判"费率没落盘"）。
      if (fn) return function () { return Promise.resolve(fn.apply(null, arguments)); };
      // 事件订阅（onXxx）返回退订函数；其余一律返回 {success:true,data:null}
      if (/^on[A-Z]/.test(key)) return function () { return function () {}; };
      return function () { return Promise.resolve({ success: true, data: null }); };
    },
  });

  // 任何未捕获错误都要算失败（静默崩了页面照样"有内容"）
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
// ⚠️ 页面里有两张 oc-table（明细 + 统计）→ 明细断言必须走 data-act 限定，否则会读到统计行
function detailTable() { return document.querySelector('[data-act="detail-table"]'); }
function detailRow() { var t = detailTable(); return t ? t.querySelector('tbody tr:first-child') : null; }
function rowCells() {
  var row = detailRow();
  return row ? Array.prototype.map.call(row.querySelectorAll('td'), function (td) { return flat(td); }) : [];
}
function calls(name) { return (window.__smokeCalls && window.__smokeCalls[name]) || []; }

async function main() {
  try {
    // 记录跨模块跳转（空态里的「去「今天」导入」用）：只记录、不拦截 —— 外壳自己会切走
    window.__navs = [];
    window.addEventListener('switch-module', function (e) { window.__navs.push(e.detail); });

    step('boot');
    await waitFor(function () { return document.querySelector('.oc-view'); }, 10000);
    report('挂载：订单利润视图渲染', true);

    step('table');
    await waitFor(function () { return document.querySelectorAll('.oc-table tbody tr').length >= 1; }, 10000);
    // ⚠️ 判据从"逐格整串比对（cells.indexOf('125.18')）"升级为**按 data-act 取单元格**：
    //    毛利格现在长这样「125.18 预测」（"预测/精准"标签并进了同一格），整串比对必然失配 ——
    //    那不是功能坏了，是断言方式在拿布局当契约。
    var moneyCell = function (anchor) {
      var el = document.querySelector('[data-act="detail-table"] [data-act="' + anchor + '"]');
      return el ? flat(el) : '';
    };
    var cellText = rowCells().join(' | ');
    report('行内金额：分→元且精确（运费 30.00 / 产品成本 10.00 / 税 0.00 / 收入 165.18 / 毛利 125.18）',
      moneyCell('shipping') === '30.00' && moneyCell('product-cost') === '10.00' &&
        moneyCell('tax') === '0.00' && moneyCell('revenue') === '165.18' &&
        moneyCell('gross').indexOf('125.18') === 0, cellText);
    // 平台费**必须有列**：毛利 = 收入 − 运费 − 产品成本 − 税 − 平台费，缺了它配好费率后对不上账。
    // 未配费率时它是「—」（不是 0）——"没扣"和"扣了 0"必须分得开。
    report('明细有「平台费」列，未配费率时显示 —（不是 0）',
      !!document.querySelector('[data-act="detail-table"] [data-act="platform-fee"]') &&
        moneyCell('platform-fee') === '—' &&
        document.querySelector('[data-act="detail-table"] [data-act="platform-fee"]').title.indexOf('没扣') >= 0,
      'platformFee=' + moneyCell('platform-fee'));
    // 列头原来叫「轨」——那是代码注释里的说法，用户看不出这列在说什么。
    // 「毛利依据」那列（只有预测/精准两值）已并进毛利格；这一条改守**新结构**：
    //   ① 列头里不再有「毛利依据」「轨」这两个词；
    //   ② 「成本」必须写成「产品成本」——它与「按维度汇总」的「成本」（= 运费 + 产品成本）口径不同，
    //      两边同名会让人以为明细少算了运费；
    //   ③ 毛利列头带口径说明，且轨标签仍是可按的锚点（悬停说清两条轨各怎么算）。
    var headTxt = flat(document.querySelector('[data-act="detail-table"] thead'));
    var tierTag = document.querySelector('[data-act="gross-tier"]');
    report('明细列头：用「产品成本」区分口径、无「毛利依据/轨」残留，毛利列带口径说明',
      headTxt.indexOf('产品成本') >= 0 && headTxt.indexOf('毛利依据') < 0 && headTxt.indexOf('轨') < 0 &&
        !!document.querySelector('[data-act="detail-table"] thead th[title]'),
      headTxt);
    report('轨标签并进毛利格且带悬停口径说明（预测 = 收入−运费−产品成本−税−平台费）',
      !!tierTag && (tierTag.title || '').indexOf('收入') >= 0, tierTag ? tierTag.title : '(无标签)');

    // ===== 根因守卫：宽表**不许被静默裁掉** =====
    // 这张表列多，窄窗口下必然比可用宽度宽；而明细表外层是 .wb-panel{overflow:hidden} ——
    // 没有滚动容器时右侧几列会被**无声裁掉**（既看不见、也没有滚动条能过去）。
    // 这条不是断言"列有多少"，而是断言"最后一列**够得着**"：滚到最右后它必须落在容器可视区内。
    var wrapEl = document.querySelector('[data-act="detail-table"]').closest('.wb-table-wrap');
    var tblEl = document.querySelector('[data-act="detail-table"]');
    var wrapCss = wrapEl ? getComputedStyle(wrapEl) : null;
    var canScrollX = !!wrapCss && (wrapCss.overflowX === 'auto' || wrapCss.overflowX === 'scroll');
    var overflows = !!wrapEl && tblEl.scrollWidth > wrapEl.clientWidth + 1;
    var lastReachable = false;
    if (wrapEl) {
      var prev = wrapEl.scrollLeft;
      wrapEl.scrollLeft = wrapEl.scrollWidth;
      var lastTh = tblEl.querySelector('thead th:last-child');
      var rb = lastTh.getBoundingClientRect();
      var wb = wrapEl.getBoundingClientRect();
      lastReachable = rb.right <= wb.right + 1 && rb.left >= wb.left - 1;
      wrapEl.scrollLeft = prev;
    }
    report('宽明细表在滚动容器里：滚到最右后「缺」列仍够得着（不再被 .wb-panel 静默裁掉）',
      canScrollX && lastReachable,
      'wrap=' + !!wrapEl + ' overflowX=' + (wrapCss ? wrapCss.overflowX : '—') +
        ' 表宽=' + (tblEl ? tblEl.scrollWidth : '—') + ' 容器宽=' + (wrapEl ? wrapEl.clientWidth : '—') +
        ' 溢出=' + overflows + ' 末列可达=' + lastReachable);

    step('qty');
    // 件数来自订单报表「商品信息」块的 (商品数量:2 piece)（结算关着 → 走报表这一路）
    var qtyCell = document.querySelector('[data-act="qty"]');
    report('件数取自订单报表块内商品数量（显示 2，悬停说明来源）',
      !!qtyCell && flat(qtyCell) === '2' && (qtyCell.title || '').indexOf('商品数量') >= 0,
      'cell=' + flat(qtyCell) + ' title=' + (qtyCell ? qtyCell.title : ''));

    step('summary');
    // ⚠️ 判据从"整段 .oc-topbar 拼串"升级为**按 data-act 取元素**：改一个标签文案
    //    （比如「算齐」→「各环齐全」）不该把整条断言带红 —— 那是用测试迁就实现。
    var mRows = flat(document.querySelector('[data-act="metric-rows"]'));
    var mRev = flat(document.querySelector('[data-act="metric-revenue"]'));
    var mCost = flat(document.querySelector('[data-act="metric-cost"]'));
    var mGross = flat(document.querySelector('[data-act="metric-gross"]'));
    var mMargin = flat(document.querySelector('[data-act="metric-margin"]'));
    // 2026-10-11 二改：指标条**只留钱的五个数**，撤掉「各环齐全 N」那一格 ——
    // 它与下一行的缺口说的是同一件事（齐不齐），而缺口的说法具体得多（缺哪一环、几行）。
    // 所以这条断言同时钉住"那格不再回来"：'metric-complete' 存在 = 同一件事又说了一遍。
    report('指标条只有五个数：订单行 1 / 收入 165.18 / 成本 40.00 / 毛利 125.18 / 毛利率 75.8%',
      /订单行 1/.test(mRows) && mRev.indexOf('165.18') >= 0 && mCost.indexOf('40.00') >= 0 &&
        mGross.indexOf('125.18') >= 0 && mMargin.indexOf('75.8%') >= 0,
      [mRows, mRev, mCost, mGross, mMargin].join(' | '));
    report('「齐不齐」在页面上只剩一处说法（指标条不再占一格「各环齐全」）',
      !document.querySelector('[data-act="metric-complete"]'),
      'metric-complete=' + !!document.querySelector('[data-act="metric-complete"]'));
    // 成本合计 = 运费 30 + 产品成本 10 —— 与明细表两列相加、与毛利算式同一个数。
    // 这条同时钉住"成本合计和收入合计**同口径**"（都只含非关闭单）：不一致时会出现成本比收入还大。
    report('成本合计 = 运费 + 产品成本（40.00），与明细两列相加一致',
      mCost.indexOf('40.00') >= 0, mCost);
    // 毛利率 = 毛利 ÷ 收入；此前只有分子分母两个数，要用户自己除。
    report('毛利率 75.8%（125.18 ÷ 165.18），悬停说明未配费率时会偏高',
      mMargin.indexOf('75.8%') >= 0 &&
        (document.querySelector('[data-act="metric-margin"]').title || '').indexOf('偏高') >= 0,
      mMargin + ' | ' + document.querySelector('[data-act="metric-margin"]').title);
    var buckets = flat(document.querySelector('.oc-buckets'));
    report('分桶：已完成 1 行（关闭单不进合计的口径可见）', /已完成 1 行/.test(buckets), buckets);
    var gaps = flat(document.querySelector('.oc-gaps'));
    report('默认未配费率 → 提示"平台费未扣"（不按 0 算）',
      gaps.indexOf('平台费未扣') >= 0, gaps);
    // 缺口行改为**只列真的缺的**：全 0 时收敛成一句「没有缺项」，不再罗列 8 个「缺X 0」。
    // ⚠️ 这条比原来的 /缺收入 0/ **更强**：它同时钉住"没有漏报缺口"——一个 gap chip 都不该有；
    //    而原来只要文案里出现「缺收入 0」就绿，漏报另外 3 个环也照样绿。
    var gapChips = document.querySelectorAll('.oc-gaps [data-act^="gap-"]');
    report('逐行各环齐全：一个缺口 chip 都不渲染',
      gapChips.length === 0, 'chips=' + gapChips.length);
    // 「没有缺项」是**对整行**的断言 ⇒ 平台费还没配（这一行里也有一项）时不能显示它，
    // 否则读起来是"什么都不缺、但这个缺着"。这条同时钉住"别在没配费率时谎报整行齐全"。
    report('平台费未配时「没有缺项」不出现（不谎报整行齐全）',
      !document.querySelector('[data-act="gaps-none"]') &&
        !!document.querySelector('[data-act="fee-missing"]'),
      'none=' + !!document.querySelector('[data-act="gaps-none"]') +
        ' fee-missing=' + !!document.querySelector('[data-act="fee-missing"]'));
    // 件数 > 1 的行 → 界面显式说明成本按单件价（未拆包的单运费也按 1 件估）
    report('多件行提示出现（件数 2 → 成本按单件计）；件数并不缺，故不列「缺件数」',
      !!document.querySelector('[data-act="multi-piece-hint"]') &&
        !document.querySelector('[data-act="gap-qty"]'),
      gaps);

    step('wiring');
    report('克重按款色码批量取（productList → productVariantList 两次调用都没少）',
      calls('productList').length === 1 && calls('productVariantList').length === 1,
      'productList=' + calls('productList').length + ' variantList=' + calls('productVariantList').length);
    // 绊线：已删的通道一次都不许调（调了说明页面又回去读那张已 DROP 的表）
    report('不碰已删通道 productWeightGet（商品ID 克重那条链已整条退场）',
      (calls('productWeightGet') || []).length === 0, JSON.stringify(calls('productWeightGet') || []));
    report('运价表走**宿主快照**（不是岛存储回退）', calls('shipRateSnapshotCalc').length >= 1,
      'snapshotCalc=' + calls('shipRateSnapshotCalc').length);
    // 数据基础区默认收起：没有"缺成本"的行时它不该占主视线（展开行为在 cost-rates 步验）
    report('「数据基础：产品当前进价」区默认收起（不抢主视线）',
      !!document.querySelector('[data-act="cost-rates"]') && !document.querySelector('[data-act="cost-table"]'));

    step('refresh');
    var before = calls('orderShippingRows').length;
    document.querySelector('[data-act="refresh"]').click();
    await waitFor(function () { return calls('orderShippingRows').length > before; }, 6000);
    var last = calls('orderShippingRows')[calls('orderShippingRows').length - 1];
    report('刷新真的重新取数且带 limit', !!last && last.limit === 500, JSON.stringify(last));

    step('stats');
    // 同 refresh 步：刷新期间整块被 v-if 摘掉 → 先等统计表回来
    await waitFor(function () { return document.querySelector('.oc-table--stats tbody tr'); }, 8000);
    var statsRows = document.querySelectorAll('.oc-table--stats tbody tr');
    report('统计区：按款一行（款 S1）', statsRows.length === 1, 'rows=' + statsRows.length);
    var statsCells = statsRows.length
      ? Array.prototype.map.call(statsRows[0].querySelectorAll('td'), function (td) { return flat(td); })
      : [];
    report('统计区的收入/成本/预测毛利 = 165.18 / 40.00 / 125.18',
      statsCells.indexOf('165.18') >= 0 && statsCells.indexOf('40.00') >= 0 && statsCells.indexOf('125.18') >= 0,
      statsCells.join(' | '));
    // 列序也要钉住：款 / 行数 / **件数** / 收入 / 成本 / 预测毛利 / 精准毛利 / 缺
    report('统计列含「件数」且该组件数 = 2（与明细行的 2 一致）',
      flat(document.querySelector('.oc-table--stats thead')).indexOf('件数') >= 0 &&
        statsCells[0] === 'S1' && statsCells[1] === '1' && statsCells[2] === '2',
      statsCells.join(' | '));
    // 切到按目的国 → 应出现"美国"这一组
    var dimSel = document.querySelector('[data-act="dim"]');
    report('维度选择器存在', !!dimSel);
    if (dimSel) {
      dimSel.value = 'country';
      dimSel.dispatchEvent(new Event('change'));
      await waitFor(function () {
        var rowsN = document.querySelectorAll('.oc-table--stats tbody tr');
        return rowsN.length === 1 && flat(rowsN[0]).indexOf('美国') >= 0;
      }, 6000);
      report('切到按目的国：显示"美国"组', true);
    }

    step('stat-view');
    // 「汇总」与「趋势」原先是两个面板（列几乎一样、各带一行表头、各写一遍"只含非关闭单"）——
    // 同一份数据讲两遍。现在是一个面板 + 分段切换，这条钉住"切换真的换视图"。
    var segSum = document.querySelector('[data-act="stat-view-summary"]');
    var segTrend = document.querySelector('[data-act="stat-view-trend"]');
    var paneSum = document.querySelector('[data-act="stat-summary"]');
    var paneTrend = document.querySelector('[data-act="stat-trend"]');
    report('分组统计是一个面板两个视图（有「汇总/趋势」分段，且只有一个面板）',
      !!segSum && !!segTrend && !!paneSum && !!paneTrend &&
        document.querySelectorAll('.oc-stats').length === 1 &&
        segSum.getAttribute('aria-selected') === 'true' && !!paneSum.offsetParent && !paneTrend.offsetParent,
      'segSum=' + !!segSum + ' segTrend=' + !!segTrend +
        ' 面板数=' + document.querySelectorAll('.oc-stats').length +
        ' summary可见=' + !!(paneSum && paneSum.offsetParent) +
        ' trend可见=' + !!(paneTrend && paneTrend.offsetParent));
    if (segTrend) {
      segTrend.click();
      await waitFor(function () {
        return document.querySelector('[data-act="stat-trend"]').offsetParent &&
          !document.querySelector('[data-act="stat-summary"]').offsetParent;
      }, 4000);
      report('点「趋势」→ 趋势表显示、汇总表隐藏', true,
        'summary可见=' + !!document.querySelector('[data-act="stat-summary"]').offsetParent);
      segSum.click();
      await waitFor(function () {
        return document.querySelector('[data-act="stat-summary"]').offsetParent;
      }, 4000);
    }

    step('trend');
    // C9：把岛上「利润统计」独有的"趋势"补进内建页 —— 口径与汇总同一份（只含非关闭单）
    await waitFor(function () { return document.querySelector('[data-act="trend-table"] tbody tr'); }, 8000);
    var tRows = document.querySelectorAll('[data-act="trend-table"] tbody tr');
    var tCells = Array.prototype.map.call(tRows[0].querySelectorAll('td'), flat);
    report('趋势表：该单落在 2026-09（按月），收入/毛利与汇总一致',
      tRows.length === 1 && tCells[0] === '2026-09' && tCells.indexOf('165.18') >= 0 && tCells.indexOf('125.18') >= 0,
      tCells.join(' | '));
    var granSel = document.querySelector('[data-act="trend-gran"]');
    granSel.value = 'day';
    granSel.dispatchEvent(new Event('change'));
    await waitFor(function () {
      var rowsD = document.querySelectorAll('[data-act="trend-table"] tbody tr');
      return rowsD.length >= 1 && flat(rowsD[0]).indexOf('2026-09-10') >= 0;
    }, 6000);
    report('切「按日」→ 桶变成具体日期', true, flat(document.querySelector('[data-act="trend-table"] tbody tr')));

    step('shop');
    // P0（界面精简）：低频控件默认收起 —— 先断言首屏"干净"，再展开去操作
    report('首屏默认收起低频控件（费率/店铺/结算导入）',
      !document.querySelector('.oc-rate__input') &&
        !document.querySelector('[data-act="shop-pick"]') &&
        !document.querySelector('[data-act="import-settle"]'),
      'rate=' + !!document.querySelector('.oc-rate__input') +
        ' shop=' + !!document.querySelector('[data-act="shop-pick"]'));
    report('首屏保留主操作：刷新 + 统计维度', !!document.querySelector('[data-act="refresh"]') &&
      !!document.querySelector('[data-act="dim"]'));

    // ── 提示即入口：页头的「未归属 N 单」必须**点得动**，且点了要落到具体控件上 ──
    // 这条路径此前零覆盖（原来它是一个 <span>：看着像待办提示，点了没反应，
    // 真正的动作藏在「更多」里且没有任何指路）。断言"展开 + 聚焦"，不只断言"能点"。
    var hintEl = document.querySelector('[data-act="unassigned-hint"]');
    report('未归属提示做成了可点按钮（不再是点不动的 span）',
      !!hintEl && hintEl.tagName === 'BUTTON', hintEl ? hintEl.tagName : 'missing');
    if (hintEl) hintEl.click();
    await waitFor(function () {
      var s = document.querySelector('[data-act="shop-pick"]');
      return !!s && document.activeElement === s;
    }, 6000);
    report('点「未归属 1 单 · 去归属」→ 展开「费率与归属」并把店铺下拉聚焦',
      !!document.querySelector('[data-act="shop-pick"]') &&
        document.activeElement === document.querySelector('[data-act="shop-pick"]'),
      'active=' + (document.activeElement ? document.activeElement.getAttribute('data-act') : 'none'));
    report('展开态下「费率与归属」按钮同步 is-on（与侧栏激活态同一套色）',
      document.querySelector('[data-act="more"]').classList.contains('is-on'));
    // 把"「费率与归属」按钮自己也能开合"这条原有覆盖补回来：先收起、再让它自己展开
    document.querySelector('[data-act="more"]').click();
    await waitFor(function () { return !document.querySelector('[data-act="shop-pick"]'); }, 6000);
    document.querySelector('[data-act="more"]').click();
    await waitFor(function () { return document.querySelector('[data-act="shop-pick"]'); }, 6000);
    report('「费率与归属」按钮本身可开合（收起→展开）', !!document.querySelector('[data-act="shop-pick"]'));
    var shopSel = document.querySelector('[data-act="shop-pick"]');
    report('店铺下拉已加载店铺实体（店A）',
      !!shopSel && Array.prototype.some.call(shopSel.options, function (o) { return o.value === '店A'; }),
      shopSel ? shopSel.options.length + ' options' : 'no select');
    // 「归到该店」送出的是**当前列表里全部订单号**（不只是未归属的），界面上原来一个字都没说。
    // 这条把作用域钉在界面上：以后谁把说明删了，这里就变红。
    report('「归到该店」写明作用域（会改写当前列表全部 N 个订单号，不只是未归属的）',
      !!document.querySelector('[data-act="assign-scope"]') &&
        flat(document.querySelector('[data-act="assign-scope"]')).indexOf('全部 1 个订单号') >= 0,
      flat(document.querySelector('[data-act="assign-scope"]')));
    // 选店铺 → 点"归到该店" → 断言出参（点击出参是唯一能抓"点了没反应"的手段）
    if (shopSel) {
      shopSel.value = '店A';
      shopSel.dispatchEvent(new Event('change'));
      // ⚠️ 按钮 :disabled 依赖 shopPick，Vue 下一个 tick 才更新 → 必须等它可用再点（否则点了没反应）
      await waitFor(function () {
        var b = document.querySelector('[data-act="assign-shop"]');
        return b && !b.disabled;
      }, 6000);
      document.querySelector('[data-act="assign-shop"]').click();
      await waitFor(function () { return calls('orderAssignShop').length >= 1; }, 8000);
      var assigned = calls('orderAssignShop')[calls('orderAssignShop').length - 1];
      report('「归到该店」把当前订单号与店铺名一起送出',
        !!assigned && assigned.shopName === '店A' && assigned.orderNos.join(',') === 'SMOKE-1',
        JSON.stringify(assigned));
      // 归属前：工具栏应有"未归属 N 单"提示（让用户知道要不要动手，而不是靠猜）
      report('归属前提示「未归属 1 单」', !!document.querySelector('[data-act="unassigned-hint"]'),
        flat(document.querySelector('[data-act="unassigned-hint"]')));
      // 归属后刷新 → 提示应消失（全部归属齐）
      document.querySelector('[data-act="refresh"]').click();
      await waitFor(function () {
        return !document.querySelector('[data-act="unassigned-hint"]') &&
          flat(document.querySelector('[data-act="detail-table"]')).indexOf('店A') >= 0;
      }, 8000);
      report('归属后：未归属提示消失，且明细行显示店铺', true);
      // 切到按店铺维度 → 应出现"店A"组
      var dim2 = document.querySelector('[data-act="dim"]');
      dim2.value = 'shop';
      dim2.dispatchEvent(new Event('change'));
      await waitFor(function () {
        var rowsS = document.querySelectorAll('.oc-table--stats tbody tr');
        return rowsS.length >= 1 && flat(rowsS[0]).indexOf('店A') >= 0;
      }, 8000);
      report('统计维度切到「店铺」显示店A 组', true);
      // 切到按 SKU（款×色×码）→ key 就是三段式；这是"色/码填得全不全"的取证口径
      dim2.value = 'sku';
      dim2.dispatchEvent(new Event('change'));
      await waitFor(function () {
        var rowsS = document.querySelectorAll('.oc-table--stats tbody tr');
        return rowsS.length >= 1 && flat(rowsS[0]).indexOf('S1 · 黑 · L') >= 0;
      }, 8000);
      report('统计维度切到「SKU（款×色×码）」显示 S1 · 黑 · L 组', true);
      // 切到按供应商 → 按 id 分组、显示名字（厂A）
      dim2.value = 'supplier';
      dim2.dispatchEvent(new Event('change'));
      await waitFor(function () {
        var rowsS = document.querySelectorAll('.oc-table--stats tbody tr');
        return rowsS.length >= 1 && flat(rowsS[0]).indexOf('厂A') >= 0;
      }, 8000);
      report('统计维度切到「供应商」显示厂A 组', true);
    }

    step('precise');
    // ⚠️ 刷新期间 v-if=loading 会把整张表摘掉 → 断言前必须等表回来（否则读到的是空态）
    await waitFor(function () { return detailRow(); }, 8000);
    report('预测轨：无结算数据时标「预测」', flat(detailRow()).indexOf('预测') >= 0, flat(detailRow()));
    report('结算数据按订单号批量取（一次调用）', calls('settleOrders').length >= 1,
      'settleOrders calls=' + calls('settleOrders').length);
    // 打开结算数据开关 → 刷新 → 同一行应切到精准轨
    window.__settleOn = true;
    document.querySelector('[data-act="refresh"]').click();
    await waitFor(function () {
      return flat(document.querySelector('[data-act="gross"]')).indexOf('50.86') >= 0;
    }, 8000);
    report('该行切到「精准」轨', flat(detailRow()).indexOf('精准') >= 0, flat(detailRow()));
    var cellsP = rowCells();
    report('精准毛利 = 净收入 − 运费 − 成本 = 50.86（不另扣平台费）',
      flat(document.querySelector('[data-act="gross"]')).indexOf('50.86') >= 0, cellsP.join(' | '));
    report('精准合计 chip 出现', flat(document.querySelector('.oc-buckets')).indexOf('精准 1 行') >= 0,
      flat(document.querySelector('.oc-buckets')));
    // 结算商品行的件数（3）盖过报表块里的 2 → 证明 settleQty 铺表与查表键两端一致
    var qtyCellP = document.querySelector('[data-act="qty"]');
    report('件数真值优先：结算商品行 qty=3（盖过报表块的 2）',
      !!qtyCellP && flat(qtyCellP) === '3' && (qtyCellP.title || '').indexOf('结算明细') >= 0,
      'cell=' + flat(qtyCellP) + ' title=' + (qtyCellP ? qtyCellP.title : ''));

    step('rate');
    var rateInput = document.querySelector('.oc-rate__input');
    report('费率输入框存在', !!rateInput);
    if (rateInput) {
      rateInput.value = '9';
      rateInput.dispatchEvent(new Event('input'));
      rateInput.dispatchEvent(new Event('change'));
      // 毛利 = 125.18 − 165.18×9%(14.87) = 110.31
      await waitFor(function () {
        return flat(document.querySelector('.oc-topbar')).indexOf('110.31') >= 0;
      }, 6000);
      var top2 = flat(document.querySelector('.oc-topbar'));
      report('改费率后毛利被扣（125.18 → 110.31）', top2.indexOf('110.31') >= 0, top2);
      // 该行已结算 → 单元格显示**精准值**；预测值（110.31）在悬停说明里，两者都要对。
      // ⚠️ 口径说明现在挂在**轨标签**上（原「毛利依据」列并进了毛利格），不在 td 上 ——
      //    按 data-act 取锚点，别再靠 td.oc-total 的类名（那是布局）。两处（毛利格 + 轨标签）都要在。
      var totalCell = document.querySelector('[data-act="gross"]');
      var tierEl = document.querySelector('[data-act="gross-tier"]');
      report('精准行的毛利格显示精准值、轨标签的悬停说明带预测值',
        !!totalCell && flat(totalCell).indexOf('50.86') === 0 &&
          !!tierEl && flat(tierEl) === '精准' && (tierEl.title || '').indexOf('110.31') >= 0,
        'cell=' + flat(totalCell) + ' tier=' + (tierEl ? flat(tierEl) : '—') +
          ' title=' + (tierEl ? tierEl.title : ''));
      // ⚠️ 别断言"最后一次调用"：外壳启动时也会 setModuleState('app-shell')，会把它误当成我们的那次
      var mine = function (c) {
        return c.ns === 'order-cost' && c.data && c.data.platformFeeRatePercent === 9;
      };
      await waitFor(function () { return calls('setModuleState').some(mine); }, 8000);
      report('费率落盘（order-cost 命名空间，且带 9）', calls('setModuleState').some(mine),
        JSON.stringify(calls('setModuleState')));
      report('提示切换为"按 9% 近似"', flat(document.querySelector('.oc-gaps')).indexOf('9% 近似') >= 0,
        flat(document.querySelector('.oc-gaps')));
      // 配好费率后，这一行才真的"整行无缺" ⇒ 此时才该出现「没有缺项」（反向证明它不是恒显）
      await waitFor(function () {
        return !!document.querySelector('[data-act="gaps-none"]');
      }, 6000);
      report('配好费率后「没有缺项」才出现（整行真的无缺）',
        !!document.querySelector('[data-act="gaps-none"]') &&
          !document.querySelector('[data-act="fee-missing"]'),
        'none=' + !!document.querySelector('[data-act="gaps-none"]') +
          ' fee-missing=' + !!document.querySelector('[data-act="fee-missing"]'));
    }

    step('qty-missing');
    // 两个来源都拿掉（报表块与结算都没有）→ 必须**兜底 1 件并逐行标出来**，不许静默
    window.__settleOn = false;
    window.__noQtyInfo = true;
    document.querySelector('[data-act="refresh"]').click();
    await waitFor(function () {
      var c = document.querySelector('[data-act="qty"]');
      return c && flat(c) === '1' && flat(document.querySelector('.oc-gaps')).indexOf('缺件数 1') >= 0;
    }, 8000);
    var qtyCellN = document.querySelector('[data-act="qty"]');
    report('两处都没有件数 → 按 1 件、标「缺件数 1」、悬停说明来源为兜底',
      flat(qtyCellN) === '1' && (qtyCellN.title || '').indexOf('按 1 件') >= 0,
      'cell=' + flat(qtyCellN) + ' title=' + (qtyCellN ? qtyCellN.title : ''));
    report('件数不再是 2 时，多件行提示同步消失（提示跟着数据走，不是常驻噪声）',
      !document.querySelector('[data-act="multi-piece-hint"]'));

    step('collected-merge');
    // C1 合并：两条摄取通道进同一模型 —— 采集行要在同一张表里出现，并**如实暴露它的缺口**
    report('首屏可见两个会改数字的开关：来源筛选 + 税口径（默认平台代征代缴）',
      !!document.querySelector('[data-act="source"]') && !!document.querySelector('[data-act="tax-default"]') &&
        document.querySelector('[data-act="tax-default"]').value === 'platform');
    var srcChips = Array.prototype.map.call(document.querySelectorAll('[data-act="source-count"]'), function (el) { return flat(el); }).join(' | ');
    report('打开采集前：采集 0 行 / 导入 1 行', srcChips.indexOf('采集 0 行') >= 0 && srcChips.indexOf('导入 1 行') >= 0, srcChips);

    window.__collectedOn = true; // 主干里出现采集行（同一个读口返回）
    document.querySelector('[data-act="refresh"]').click();
    await waitFor(function () {
      var t = detailTable();
      return t && flat(t).indexOf('C-1') >= 0;
    }, 8000);
    var srcChips2 = Array.prototype.map.call(document.querySelectorAll('[data-act="source-count"]'), function (el) { return flat(el); }).join(' | ');
    report('打开采集后：采集 1 行 / 导入 1 行', srcChips2.indexOf('采集 1 行') >= 0 && srcChips2.indexOf('导入 1 行') >= 0, srcChips2);
    report('明细行自带来源标签（采集/导入都要出现）',
      flat(detailTable()).indexOf('采集') >= 0 && flat(detailTable()).indexOf('导入') >= 0);

    // 采集帧没有商品ID/款编码 → 该行的缺口必须逐行标出来（不许编数）
    var collectedRow = Array.prototype.filter.call(detailTable().querySelectorAll('tbody tr'), function (tr) {
      return flat(tr).indexOf('C-1') >= 0;
    })[0];
    var cCells = collectedRow
      ? Array.prototype.map.call(collectedRow.querySelectorAll('td'), function (td) { return flat(td); })
      : [];
    report('采集行如实标缺口：未识别款 + 缺成本 + 缺克重（帧里没有商品ID/款编码）',
      cCells.join(' | ').indexOf('未识别款') >= 0 && cCells.join(' | ').indexOf('缺成本') >= 0 &&
        cCells.join(' | ').indexOf('缺克重') >= 0, cCells.join(' | '));
    report('采集行的件数 = 采集真值 2（不是兜底 1、也不标缺件数）',
      flat(collectedRow.querySelector('[data-act="qty"]')) === '2' &&
        cCells.join(' | ').indexOf('缺件数') < 0,
      'qty=' + flat(collectedRow.querySelector('[data-act="qty"]')));
    report('税口径默认=平台代征 → 采集行税记 0.00（不是"—"、也不是缺口）',
      cCells.indexOf('0.00') >= 0 && !document.querySelector('[data-act="gap-tax"]'),
      cCells.join(' | '));

    // ⭐ 「缺汇率」与「缺收入」必须**分开标**：同一行、只把 amountCents 改成 NULL（其余一字不动），
    //    缺口文案要从"没有金额缺口"变成「缺汇率」、且**不许**变成「缺收入」。
    //    ⚠️ 非空转的关键是"两档结果必须不同"：若实现不看 source（或把两档并成一个 key），下面必红；
    //    反过来，若断言只写"出现了某个缺口"，把两档合并成一个 key 也照样绿 —— 那种写法测不到本功能。
    window.__rateMissing = true;
    document.querySelector('[data-act="refresh"]').click();
    await waitFor(function () {
      var g = document.querySelector('[data-act="gap-fx"]');
      return !!g && flat(g).indexOf('缺汇率 1') >= 0;
    }, 8000);
    report('缺汇率的采集行 → 缺口 chip 是「缺汇率 1」而不是「缺收入」',
      !!document.querySelector('[data-act="gap-fx"]') && !document.querySelector('[data-act="gap-revenue"]'),
      'gaps=' + flat(document.querySelector('.oc-gaps')));
    var fxRow = Array.prototype.filter.call(detailTable().querySelectorAll('tbody tr'), function (tr) {
      return flat(tr).indexOf('C-1') >= 0;
    })[0];
    report('该行「缺」列写「缺汇率」、且不写「缺收入」',
      !!fxRow && flat(fxRow).indexOf('缺汇率') >= 0 && flat(fxRow).indexOf('缺收入') < 0,
      fxRow ? flat(fxRow) : '(采集行不存在)');
    report('缺汇率的行金额格给「—」（不是 0.00 —— "算不出来"与"收入为零"不能混）',
      !!fxRow && flat(fxRow.querySelector('[data-act="revenue"]')) === '—',
      fxRow ? flat(fxRow.querySelector('[data-act="revenue"]')) : '(采集行不存在)');
    window.__rateMissing = false;

    var taxSel = document.querySelector('[data-act="tax-default"]');
    taxSel.value = 'unknown';
    taxSel.dispatchEvent(new Event('change'));
    await waitFor(function () {
      var g = document.querySelector('[data-act="gap-tax"]');
      return !!g && flat(g).indexOf('税未知 1') >= 0;
    }, 6000);
    report('税口径切「不知道」→ 该行标税缺口（不按 0 算）',
      !!document.querySelector('[data-act="gap-tax"]') &&
        flat(document.querySelector('[data-act="gap-tax"]')).indexOf('税未知 1') >= 0,
      flat(document.querySelector('.oc-gaps')));

    var srcSel = document.querySelector('[data-act="source"]');
    srcSel.value = 'collect';
    srcSel.dispatchEvent(new Event('change'));
    await waitFor(function () { return flat(detailTable()).indexOf('SMOKE-1') < 0; }, 6000);
    report('切「仅采集」→ 只剩采集行（导入行被筛掉，不重取数）',
      flat(detailTable()).indexOf('C-1') >= 0 && flat(detailTable()).indexOf('SMOKE-1') < 0);
    srcSel.value = 'all';
    srcSel.dispatchEvent(new Event('change'));
    await waitFor(function () { return flat(detailTable()).indexOf('SMOKE-1') >= 0; }, 6000);
    report('切回「全部」→ 两行都在', flat(detailTable()).indexOf('C-1') >= 0 && flat(detailTable()).indexOf('SMOKE-1') >= 0);

    step('gap-filter');
    // ⭐ 缺口是**筛子**，不是**提示**（2026-10-11）：点「缺成本 1」→ 明细表只留那一行。
    //    原先它只是一句话：告诉你"1 行缺成本"，却没有任何办法知道**是哪一行** ——
    //    几百行的表里只能逐格去找。这是本仓「提示不是入口」那条规矩的又一例。
    //    ⚠️ 判据必须三件一起：① 行数真的变了（2 → 1）② 筛选态看得见 ③ 撤得掉。
    //      只断言"点下去有点反应"是空转 —— 弹个 toast、闪一下，都能让它绿。
    var gapCost = document.querySelector('[data-act="gap-cost"]');
    report('缺口 chip 做成了可点按钮（不再是点不动的提示）',
      !!gapCost && gapCost.tagName === 'BUTTON', gapCost ? gapCost.tagName : 'missing');
    var beforeN = document.querySelectorAll('[data-act="detail-table"] tbody tr').length;
    if (gapCost) {
      gapCost.click();
      await waitFor(function () {
        return !!document.querySelector('[data-act="gap-filter"]') &&
          flat(detailTable()).indexOf('SMOKE-1') < 0;
      }, 6000);
      var afterT = flat(detailTable());
      var afterN = document.querySelectorAll('[data-act="detail-table"] tbody tr').length;
      report('点「缺成本 1」→ 明细只剩那一行（2 行 → 1 行，留下的正是缺成本那行）',
        beforeN === 2 && afterN === 1 && afterT.indexOf('C-1') >= 0 && afterT.indexOf('SMOKE-1') < 0,
        'before=' + beforeN + ' after=' + afterN + ' 表=' + afterT.slice(0, 80));
      report('筛选态看得见且带撤掉的口（面板头写明「只看 缺成本」，并挂 ×）',
        !!document.querySelector('[data-act="gap-filter"]') &&
          flat(document.querySelector('[data-act="gap-filter"]')).indexOf('缺成本') >= 0 &&
          !!document.querySelector('[data-act="clear-filter"]'),
        flat(document.querySelector('[data-act="gap-filter"]')));
      document.querySelector('[data-act="clear-filter"]').click();
      await waitFor(function () {
        return document.querySelectorAll('[data-act="detail-table"] tbody tr').length === 2;
      }, 6000);
      report('点 × 撤掉筛选 → 明细回到全部行',
        document.querySelectorAll('[data-act="detail-table"] tbody tr').length === 2 &&
          !document.querySelector('[data-act="gap-filter"]'),
        'rows=' + document.querySelectorAll('[data-act="detail-table"] tbody tr').length);
    }

    step('weight-source');
    // 克重**只有一个来源**（2026-10-01 领域裁定）：产品库 SKU（款 × 色 × 码 → pl_variants.weight_g）。
    // 原「商品ID 克重」（pl_item_weights + productWeightGet）那条链整条退场、表已被 v3 迁移 DROP，
    // 所以这一步不再有"两来源 + 回落"可验，改成验三件事：取数接线 · 悬停说明 · **拿不到时如实缺**。
    report('页面去产品库取过 SKU 克重（款色码 → pl_variants.weight_g 这条路的接线）',
      calls('productList').length >= 1 && calls('productVariantList').length >= 1,
      'productList=' + calls('productList').length + ' variantList=' + calls('productVariantList').length);
    var wCell = document.querySelector('[data-act="weight"]');
    report('克重 275 取自 SKU，且悬停说明写明是「款 × 色 × 码 / 产品库 SKU」',
      flat(wCell) === '275' && (wCell.title || '').indexOf('款') >= 0 && (wCell.title || '').indexOf('SKU') >= 0,
      'v=' + flat(wCell) + ' title=' + (wCell ? wCell.title : ''));
    var gapsBefore = flat(document.querySelector('.oc-gaps'));
    report('前置：此刻只有采集行缺克重（1 行）', /缺克重 1/.test(gapsBefore), gapsBefore);

    // SKU 没维护克重 → 该行必须**如实标缺**（不静默当 0、不套别的款），且缺口计数跟着走
    window.__noSkuWeight = true;
    document.querySelector('[data-act="refresh"]').click();
    await waitFor(function () {
      var c = document.querySelector('[data-act="weight"]');
      return c && flat(c) === '—';
    }, 8000);
    var wCell2 = document.querySelector('[data-act="weight"]');
    report('SKU 没维护克重 → 单元格给「—」（不是 0），悬停说明写明原因',
      flat(wCell2) === '—' && (wCell2.title || '').indexOf('没查到克重') >= 0,
      'v=' + flat(wCell2) + ' title=' + (wCell2 ? wCell2.title : ''));
    var impRow = Array.prototype.filter.call(document.querySelectorAll('[data-act="detail-table"] tbody tr'), function (tr) {
      return flat(tr).indexOf('SMOKE-1') >= 0;
    })[0];
    var impCells = impRow ? Array.prototype.map.call(impRow.querySelectorAll('td'), flat) : [];
    report('该行「缺」列随之标出「缺克重」，缺口计数 1 → 2（不是只改单元格）',
      impCells.join(' ').indexOf('缺克重') >= 0 && /缺克重 2/.test(flat(document.querySelector('.oc-gaps'))),
      impCells.join(' | ') + ' || gaps=' + flat(document.querySelector('.oc-gaps')));
    window.__noSkuWeight = false;
    document.querySelector('[data-act="refresh"]').click();
    await waitFor(function () { return flat(document.querySelector('[data-act="weight"]')) === '275'; }, 8000);

    step('cost-rates');
    // C9 收编 + 2026-10-14 整合：本区整体**只读化**；2026-10-22 起维护入口只剩产品编辑抽屉。
    // 这里只回答"现在产品当前进价是多少、为什么这行毛利是空的"。出现"缺成本"的行时该区自动摊开
    // （collected-merge 步打开的采集行正好缺成本）。
    await waitFor(function () { return document.querySelector('[data-act="cost-table"] tbody tr'); }, 8000);
    var cRow = document.querySelector('[data-act="cost-table"] tbody tr');
    var crCells = Array.prototype.map.call(cRow.querySelectorAll('td'), flat).join(' | ');
    report('缺成本时「数据基础」自动展开，并列出产品当前进价（S1 / 10.00 元）',
      crCells.indexOf('S1') >= 0 && crCells.indexOf('10.00') >= 0, crCells);

    // 2026-10-22 B'：汇率整块退役（「基础数据 › 进价」页撤掉时一并退场）。
    // 依据是三条事实，不是"看着没人用"：① 金额本来就按人民币分存（oi_orders 没有 currency 列）；
    // ② 实时引擎 orderCost.ts 从不读 ae_rates（非人民币报价的运费直接拒算）；
    // ③ 唯一读那张表的是老采集库的一次性迁移。所以这里守三件事：**表不画**、**不取**、**不写**。
    var rateTable = document.querySelector('[data-act="rate-table"]');
    report('汇率表整块退役（本页不再画币种，rate-* 锚点一个不剩）',
      !rateTable && !document.querySelector('[data-act="rate-value-USD"]') &&
        !document.querySelector('.cr__table--rates'),
      'rateTable=' + !!rateTable);
    // 反向守卫：录入控件整批不许回来（曾经从这边搬走过一次，别哪天又搬回来 ——
    // 同一能力两个入口，用户得猜哪个才是"真的"）
    report('汇率录入控件不在本页（输入 / 保存 / 新增一律没有）',
      !document.querySelector('[data-act="rate-input-USD"]') &&
        !document.querySelector('[data-act="rate-save-USD"]') &&
        !document.querySelector('[data-act="rate-add"]') &&
        !document.querySelector('[data-act="rate-new-cur"]') &&
        !document.querySelector('[data-act="rate-new-value"]'),
      'rateInputs=' + document.querySelectorAll('.cr__table--rates input').length);
    // 连取都不取：退役得彻底，别留着"读了不用"的空转调用（那种残留最容易在下一次改造时复活成 UI）
    report('本页连汇率都不取了（不请求 ae_rates，也不写）',
      calls('aeRateList').length === 0 && calls('aeRateUpsert').length === 0,
      'list=' + calls('aeRateList').length + ' upsert=' + calls('aeRateUpsert').length);

    // 撤掉的「去维护」不许回来：它指向的「基础数据 › 进价」页已整页退役，
    // 按钮留着 = 点下去一片空白（比没有按钮更糟）。
    report('区头不再有「去维护」按钮（进价在生产品管理，成本页已退役）',
      !document.querySelector('[data-act="cr-goto"]'),
      'cr-goto=' + !!document.querySelector('[data-act="cr-goto"]'));
    // 本页不再被跳走，刷新键应当早已可用；仍等一次防重挂载竞态（后面几步都要点它）
    await waitFor(function () {
      var b = document.querySelector('[data-act="refresh"]');
      return !!b && !b.disabled;
    }, 10000);

    step('parcel');
    // 阶段 C1：已拆包的单，运费 = 包裹实付合计（真值），不再按运价表估算。
    // 用**不同的两个数**（运价表 30.00 → 包裹 45.00）：同值会让"走了哪条链"的断言空转。
    var parcelCallsBefore = calls('orderParcelTotals').length;
    window.__parcelOn = true;
    document.querySelector('[data-act="refresh"]').click();
    await waitFor(function () {
      var c = document.querySelector('[data-act="detail-table"] [data-act="shipping"]');
      return c && flat(c) === '45.00';
    }, 8000);
    var parcelCalls = calls('orderParcelTotals');
    var lastParcel = parcelCalls[parcelCalls.length - 1];
    report('包裹运费按订单号**批量**取（刷新一次调用，带上全部订单号）',
      parcelCalls.length === parcelCallsBefore + 1 && !!lastParcel &&
        lastParcel.orderNos.indexOf('SMOKE-1') >= 0,
      JSON.stringify(lastParcel));
    var shipP = document.querySelector('[data-act="detail-table"] [data-act="shipping"]');
    report('已拆包单的运费 = 包裹实付 45.00（不是运价表算的 30.00），悬停写明来源与维护处',
      flat(shipP) === '45.00' && (shipP.title || '').indexOf('包裹') >= 0 &&
        (shipP.title || '').indexOf('拆包') >= 0,
      'v=' + flat(shipP) + ' title=' + (shipP ? shipP.title : ''));

    // 已拆包但缺运费：给「—」并标缺 ——**不**回落运价表估算（否则真值被估算盖掉、行上无痕）
    window.__parcelMissing = true;
    document.querySelector('[data-act="refresh"]').click();
    await waitFor(function () {
      var c = document.querySelector('[data-act="detail-table"] [data-act="shipping"]');
      return c && flat(c) === '—';
    }, 8000);
    var shipM = document.querySelector('[data-act="detail-table"] [data-act="shipping"]');
    var smokeRowM = Array.prototype.filter.call(detailTable().querySelectorAll('tbody tr'), function (tr) {
      return flat(tr).indexOf('SMOKE-1') >= 0;
    })[0];
    report('已拆包但缺运费 → 运费「—」、行标「缺包裹运费」、chip 计数 1，且不按运价表估算',
      flat(shipM) === '—' && (shipM.title || '').indexOf('不按运价表估算') >= 0 &&
        !!smokeRowM && flat(smokeRowM).indexOf('缺包裹运费') >= 0 &&
        !!document.querySelector('[data-act="gap-parcel"]') &&
        flat(document.querySelector('[data-act="gap-parcel"]')).indexOf('缺包裹运费 1') >= 0,
      'v=' + flat(shipM) + ' title=' + (shipM ? shipM.title : '') +
        ' row=' + (smokeRowM ? flat(smokeRowM) : '(missing)'));
    window.__parcelOn = false;
    window.__parcelMissing = false;

    step('empty-state');
    // 空态必须给**可点的下一步**（UX 审查 A1/P0-3）：旧文案让用户"先去「订单归类」导入"，
    // 而那个岛可能根本没装；S2-b 起宿主自己能导订单报表，指路要指到宿主自己的入口。
    // ⚠️ 本步会真的把页面切走（点按钮 = 跳「今天」），故**必须排在最后**（errors 只读 window）。
    window.__noOrders = true;
    document.querySelector('[data-act="refresh"]').click();
    await waitFor(function () { return document.querySelector('[data-act="empty-import"]'); }, 8000);
    var emptyText = flat(document.querySelector('.oc-empty'));
    // 末两条是 2026-10-11 补的：原文案拿「宿主 / 插件」向用户解释内部架构（§1.10 禁用词），
    // 修好后钉住"不再出现" —— 只是把「导入 Excel」找回来，文字里照样能把内部词抄回来。
    // 2026-10-11 二改：原文案写「点『导入 Excel』…」，而这一页**没有**这个按钮
    // （按钮写的是「去『导入订单』」）—— 文案点了一个不存在的按钮。现在说明只讲"能得到什么"，
    // "点哪里"交给那颗按钮（它另有一条断言钉着"派发 switch-module → today"）。
    report('空态说清能得到什么，且指向宿主的导入入口（不再指向要装插件）',
      emptyText.indexOf('订单报表') >= 0 && emptyText.indexOf('订单归类') < 0 &&
        emptyText.indexOf('宿主') < 0 && emptyText.indexOf('插件') < 0, emptyText);
    document.querySelector('[data-act="empty-import"]').click();
    await waitFor(function () { return (window.__navs || []).length >= 1; }, 4000);
    // 取**最后一条** nav：本步之前若还有别的跳转（历史上有过「去维护」那条），
    // 用 navs[0] 会读到旧的。
    var emptyNav = window.__navs[window.__navs.length - 1];
    report('空态按钮派发 switch-module → today',
      !!emptyNav && emptyNav.moduleId === 'today', JSON.stringify(window.__navs));

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

// ─────────────────────────────────────────────────────────── 2. HTTP 服务器（必须 HTTP）
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

// ─────────────────────────────────────────────────────────── 3. 无头 Chrome 抓 #smoke-result
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
console.log(ok ? '\n✓ 订单利润页冒烟通过' : '\n✗ 订单利润页冒烟失败');
process.exit(ok ? 0 : 1);