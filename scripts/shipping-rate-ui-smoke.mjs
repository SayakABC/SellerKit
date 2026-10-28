// 「基础数据 › 物流运费」（原无忧物流运费岛）的**假桥无头冒烟**（不启动宿主，不需要 Electron）。
//
//   npm run shipping-rate:ui
//
// 2026-10-15 岛回收为内建页（src/modules/shop-accounts/ 组件 + core/services/shipRateOps.ts），
// 本脚本从「ui-plugins/shipping-rate/dist 站点」整体换成「宿主 build 产物站点」——
// 站点换了、纪律没换：假桥 + 无头浏览器真点一遍，判据钉 data-act。
//
// 这条冒烟的**特殊性**：别的页面都是"桩回静态夹具"，这里只有 boot 链是静态的——
// 运价链**全真**：
//   · 报价单文件 = 仓库真夹具 tests/fixtures/shipping-rate.xlsx（字节经 base64 内联进假桥）；
//   · xlsx 解析、sheet 体检、归一化 = 渲染层真代码（importSheet / lib/shipRate）；
//   · 留档 = shipRateSnapshotSave 桩**真收下**归一化产物（存内存快照）；
//   · 计价 = quoteAll 真算（表从 calc 桩取回的就是刚留档的真表）。
// 所以断言能钉**单测同款硬真值**（tests/shipRate.spec.ts）：
//   100g 全表 184 国全部有价、首行哈萨克斯坦 8.50、次行马来西亚 9.80；
//   克重 100g 的订单 / 产品试算走同一张卡 → 三处费用必须一致（8.50）。
// 任何一处口径漂移（解析选错 sheet、留档丢数据、取整改错）都会让这条链当场红。
//
// 两个来回（同一次运行打两遍页面）：
//   A 全量 1440×900：冷启动空态 → 导入真夹具 → 留档 → 查询/订单/产品三链一致 → 持久化
//   B 窄 900×800：boot → 导入 → 首行硬值（精简防超时）
//
// 做法（照技能 `esm-spa-headless-smoke`；与 scripts/master-data-ui-smoke.mjs 同骨架）：
//   dist/renderer 当站点 → 注入假 window.electronAPI → 本地 HTTP → 无头 Chrome --dump-dom
//   → 抓 #smoke-result。
//
// ⚠️ 注入脚本里的注释不能含反引号（它们本身是模板字符串，提前闭合后剩余文本可能
//    恰好仍语法合法，node --check 抓不到——只有实跑能暴露）；改完 node --check 且实跑。

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'renderer');
const WORK = path.join('/tmp', 'sellerkit-shipping-rate-smoke');
const PORT = 8137;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const FIXTURE = path.join(ROOT, 'tests', 'fixtures', 'shipping-rate.xlsx');

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error(`✗ 找不到构建产物 ${DIST}/index.html —— 先跑 npm run build`);
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error(`✗ 找不到无头 Chrome：${CHROME}`);
  process.exit(1);
}
if (!existsSync(FIXTURE)) {
  console.error(`✗ 找不到报价单夹具：${FIXTURE}（tests/fixtures/generate-fixtures.mjs 生成）`);
  process.exit(1);
}
// 夹具字节内联：假桥跑在浏览器里读不了磁盘，xlsx 字节由 node 侧读好、base64 注入
const FIXTURE_B64 = readFileSync(FIXTURE).toString('base64');

const FAKE_BRIDGE = `<script>
(function () {
  var calls = {};
  window.__smokeCalls = calls;
  function rec(name, payload) { (calls[name] = calls[name] || []).push(payload); }

  /* ==========================================================================
     夹具纪律（同 master-data 冒烟）：桩必须**真改夹具**、夹具必须复刻**生产形状**。
     本文件的特殊处：运价链全真（真夹具字节 → 真解析 → 留档桩真存 → 真计价），
     所以这里的"夹具"只有三类 —— 订单原始行 / 产品库 / 内存快照。
     ========================================================================== */

  // 报价单字节（node 侧内联）。每次 importExcelByPath 解一份新 ArrayBuffer ——
  // xlsx 解析会消费 buffer，复用同一份可能在第二次导入时读到空。
  var FIXTURE_B64 = '__FIXTURE_B64__';
  function fixtureBuf() {
    var bin = atob(FIXTURE_B64);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }
  var FIXTURE_PATH = '/fixtures/shipping-rate.xlsx';

  // 宿主快照（sr_rate_snapshots 的内存替身）：save 桩**真收下**归一化产物 ——
  // 只记调用不存表的话，"导入后表渲染 184 国"就靠 save 的返回值蒙对了，
  // calc 回空表时页面立刻露馅的那种断言一个都写不出来。
  var SNAP = null;

  // 模块持久化（electron-store 的 modules.<ns> 内存替身）：真存真取，
  // "重挂载回显 350"这条断言才验的是持久化而不是组件内存。
  var PERSIST = {};

  /* 订单原始行（oi_orders 最小投影 + raw_fields）：extractShipping 按
     「收货国家 / 商品ID」键名族从 raw_fields 里挑 —— 键名必须能被
     COUNTRY_KEYS(/收货国家|国家|地区|country/) 与 ITEM_ID_KEYS(/商品ID|产品ID|SKU|货号/) 命中。
     SO-1：哈萨克斯坦 + S1（红M，SKU 克重 100g）→ 可算，费 = 45×0.1+4 = 8.5；
     SO-2：亚特兰蒂斯（表里没这个国）→ 必须拒算行，不硬套别国的价。 */
  var ORDER_ROWS = [
    { id: 901, orderNo: 'SO-1', rawFields: { '收货国家': '哈萨克斯坦', '商品ID': 'S1', '数量': '1' }, styleCode: 'S1', color: '红', size: 'M' },
    { id: 902, orderNo: 'SO-2', rawFields: { '收货国家': '亚特兰蒂斯', '商品ID': 'S1', '数量': '1' }, styleCode: 'S1', color: '红', size: 'M' },
  ];

  /* 产品库：S1 有 SKU（红M 100g）；S2 刻意**不建 SKU** → 按产品试算里
     "没维护克重的款式"必须如实报缺，不拿别的款顶上（两个取值都要有）。 */
  var PRODUCTS = [
    { id: 1, code: 'S1', name: '款一', supplierId: 7, supplierName: '厂A', category: '衣服', status: 'active', note: '', imageId: 0, imagePath: '', createdAt: '', updatedAt: '' },
    { id: 2, code: 'S2', name: '款二', supplierId: 7, supplierName: '厂A', category: '衣服', status: 'active', note: '', imageId: 0, imagePath: '', createdAt: '', updatedAt: '' },
  ];
  var VARIANTS = [
    { productId: 1, color: '红', size: 'M', name: '款一 红 M', weightG: 100 },
  ];

  var OVERRIDES = {
    'getAppVersion': function () { return { success: true, data: '0.0.0-smoke' }; },
    'get-app-version': function () { return { success: true, data: '0.0.0-smoke' }; },
    // 模块持久化：真存真取（app-shell 命名空间照 master-data 的约定回"上次在基础数据"）
    'getModuleState': function (ns) {
      if (ns === 'app-shell') return { success: true, data: { lastActiveModuleId: 'shop-accounts', collapsed: false } };
      return { success: true, data: PERSIST[ns] !== undefined ? PERSIST[ns] : null };
    },
    'setModuleState': function (ns, data) {
      rec('setModuleState', { ns: ns, data: data });
      PERSIST[ns] = data;
      return { success: true };
    },
    // 不补这个桩，每屏右下角挂常驻红 toast —— 会训练人忽略红 toast
    'pluginsScan': function () { return { success: true, data: { root: '/tmp/smoke-plugins', plugins: [] } }; },

    /* boot 链的兜底就够了：MasterDataView 的徽标加载每类都有 try/catch，
       缺桩只影响徽标不阻断 —— 这里只补 shipping 链真正要消费的。 */

    /* ---- 运价链（全真） ---- */
    // 选文件对话框 → 直接"选"真夹具
    'selectExcel': function () {
      rec('selectExcel', {});
      return { success: true, data: { filePath: FIXTURE_PATH, data: fixtureBuf() } };
    },
    // 按路径读 Excel → 回真夹具字节（xlsx 解析在渲染层真跑）
    'importExcelByPath': function (p) {
      rec('importExcelByPath', p);
      return { success: true, data: { filePath: String(p || FIXTURE_PATH), data: fixtureBuf() } };
    },
    // 留档：**真收下**归一化产物（内容去重、生效日都是主进程的事，内存替身只存最后一份）
    'shipRateSnapshotSave': function (payload) {
      rec('shipRateSnapshotSave', {
        sourceFile: payload && payload.sourceFile,
        sheetName: payload && payload.sheetName,
        countries: payload && payload.table && payload.table.countries ? payload.table.countries.length : 0,
      });
      SNAP = {
        id: 1,
        effectiveFrom: '2026-10-15',
        sourceFile: String((payload && payload.sourceFile) || ''),
        sheetName: String((payload && payload.sheetName) || ''),
        table: payload && payload.table,
      };
      return { success: true, data: { ok: true } };
    },
    // 取当前表：没有就回空 rows（调用方按"还没有运价表"处理 —— 不许静默用空表算）
    'shipRateSnapshotCalc': function () {
      rec('shipRateSnapshotCalc', {});
      return { success: true, data: { rows: SNAP ? [SNAP] : [] } };
    },
    // 订单原始行（最小投影）
    'orderShippingRows': function (p) {
      rec('orderShippingRows', p);
      return { success: true, data: ORDER_ROWS.map(function (r) { return Object.assign({}, r); }) };
    },
    /* 产品库（loadSkuWeights 与 quoteProducts 两个调用方共用）：
       分页形状 {rows,total}，桩**照真宿主分页**（不过滤搜索 —— 本冒烟不验产品搜索）。
       结构要一起复刻：桩忽略 offset/limit 时，分页漏页会被"每次都回全量"掩护成绿的。 */
    'productList': function (p) {
      rec('productList', p);
      var offset = Number(p && p.offset) || 0;
      var limit = Number(p && p.limit) || 50;
      return { success: true, data: { rows: PRODUCTS.slice(offset, offset + limit).map(function (x) { return Object.assign({}, x); }), total: PRODUCTS.length } };
    },
    'productVariantList': function (p) {
      rec('productVariantList', p);
      var want = (p && Array.isArray(p.productIds)) ? p.productIds : [];
      return { success: true, data: { rows: VARIANTS.filter(function (v) { return want.indexOf(v.productId) >= 0; }).map(function (x) { return Object.assign({}, x); }) } };
    },
    // 复制（copy-all 断言判载荷，不判系统剪贴板）
    'writeClipboard': function (text) {
      rec('writeClipboard', String(text));
      return { success: true, data: { ok: true } };
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
</script>`.replace('__FIXTURE_B64__', FIXTURE_B64);

const ASSERT_SCRIPT = `<script type="module">
var lines = [];
var STEP = 'init';
function step(n) { STEP = n; }
function report(name, ok, detail) { lines.push((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' | ' + detail : '')); }
function waitFor(fn, timeout) {
  return new Promise(function (resolve, reject) {
    var t0 = Date.now();
    (function tick() {
      // 回调必须 try/catch：抛错会让 Promise 永不落地，结果一个字都写不出来
      var v;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > (timeout || 4000)) return reject(new Error('timeout'));
      setTimeout(tick, 30);
    })();
  });
}
/** 有界轮询：最多等 ms 毫秒让条件成立；超时也不抛（判定留给紧随其后的 report） */
async function settle(fn, ms) {
  var t0 = Date.now();
  while (!fn() && Date.now() - t0 < (ms || 3000)) await sleep(50);
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function flat(el) { return el ? el.textContent.replace(/\\s+/g, ' ').trim() : ''; }
function calls(name) { return (window.__smokeCalls && window.__smokeCalls[name]) || []; }
function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
function has(text) { return (document.body.innerText || '').indexOf(text) >= 0; }
/* "在视口里"比 "display 不是 none" 严一档 —— 这是本条冒烟被整过一次的地方。
   2026-10-15 实测：运费查询页曾出现「DOM 里 184 国表格完好、页面一片空白」。
   根因是 flex 高度链断裂（flex:1 在没有确定高度的祖先里 = 平分内容而非伸缩）：
   .srq 内容高 8036px → results 面板 7966px → 内部两个 .wb-panel__body（都是 flex:1 1 0%）
   各平分 3982px → summary（row + align-items:center）那行标签被垂直居中到 y≈2162，
   而视口只有 913px；表格本体在 y=4153。**DOM 断言全绿、截图全白。**
   判据补两条：getClientRects().length 只证明"参与布局"，不证明"落在视口内"。

   ⚠️ 本段在注入脚本的模板串里：**注释绝不能含反引号**（提前闭合后剩余文本
      可能恰好仍语法合法，node --check 抓不到，只有实跑暴露 —— 已踩过一次）。 */
function inViewport(el) {
  if (!isShown(el)) return false;
  var r = el.getBoundingClientRect();
  if (r.width <= 0 || r.height <= 0) return false;
  // 允许顶部被滚掉一点（表头 sticky 场景），但不接受整个元素在视口之外
  return r.bottom > 0 && r.top < innerHeight;
}
function isShown(el) {
  if (!el) return false;
  if (!el.getClientRects().length) return false;
  var cs = getComputedStyle(el);
  return cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) !== 0;
}
/** 一行高度内的标签条不该被 flex 撑成几千 px（高度链断裂的特征） */
function heightOf(el) { return el ? Math.round(el.getBoundingClientRect().height) : -1; }
/** 触发 Vue v-model：原生 setter + input/change 事件 */
function setVal(el, value) {
  var proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype
    : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}
/** 最近一条 toast 的文本（钉 data-act 不钉文案；关键回执顺带核数值） */
function lastToast() {
  var ts = all('[data-act="toast"] .wb-toast__text');
  return ts.length ? flat(ts[ts.length - 1]) : '';
}
/** 切到左导航某一项，等这类资料的面板真的渲染出来 */
async function gotoKind(id) {
  var btn = document.querySelector('[data-act="kind-' + id + '"]');
  if (!btn) throw new Error('左导航没有这一项: ' + id);
  btn.click();
  await settle(function () {
    return id === 'shipping'
      ? isShown(document.querySelector('[data-act="shipping-rate-pane"]'))
      : true;
  }, 8000);
  return btn;
}
/** 切运费页内的页签，等目标页签的锚点出现 */
async function gotoTab(id, probe) {
  var t = document.querySelector('[data-act="ship-tab-' + id + '"]');
  if (!t) throw new Error('没有这个页签: ' + id);
  t.click();
  await settle(function () { return !!document.querySelector(probe); }, 6000);
}

/** 走一遍导入（运价表页签空态的入口），返回"留档是否发生" */
async function importFixture() {
  await gotoTab('rates', '[data-act="ship-source"]');
  var btn = document.querySelector('[data-act="ship-source"] [data-act="ship-import"]');
  report('空态有「导入」入口', !!btn && isShown(btn));
  if (!btn) return false;
  btn.click();
  // 导入链全真（解析 268 行 + 归一化 184 国），等留档发生
  await settle(function () { return calls('shipRateSnapshotSave').length >= 1; }, 20000);
  await settle(function () { return !!document.querySelector('[data-act="ship-sections"]'); }, 15000);
  return calls('shipRateSnapshotSave').length >= 1;
}

async function main() {
  /* ── boot：整合外壳 + 左导航 ─────────────────────────────────────── */
  step('boot');
  await waitFor(function () { return document.querySelector('.md-view'); }, 12000);
/** 2026-10-17（上午）：搬到主侧栏后没有 .is-active 类了，激活态看 aria-current="page"。
 *  2026-10-17（下午）收拢后侧栏只剩三组，资料页是组内页签（kind-tab-<id>）——
 *  高亮优先取页签，单页组（物流运费）没有页签条时回落侧栏那一行。 */
function actEl(id) {
  return document.querySelector('[data-act="kind-tab-' + id + '"]') ||
    document.querySelector('[data-act="kind-' + id + '"]');
}
function kindActive(id) {
  var el = actEl(id);
  return !!el && el.getAttribute('aria-current') === 'page';
}

  report('挂载：「基础数据」主视图渲染', true);
  // 2026-10-17 收拢：侧栏只剩三组（店铺账号 / 货品档案 / 物流运费），七类资料变成组内页签。
  // 物流运费**单独一组**（自成一条动线），所以侧栏那一行仍是它的入口 —— 本脚本走的正是那一行。
  var groupIds = ['accounts', 'goods', 'shipping'];
  report('侧栏二级菜单有三组（物流运费仍是一级可见入口，不用去别处找）',
    groupIds.every(function (g) { return !!document.querySelector('[data-act="kind-' + g + '"]'); }),
    groupIds.map(function (g) { return g + '=' + !!document.querySelector('[data-act="kind-' + g + '"]'); }).join(' '));
  report('收拢后资料页没丢：「店铺账号」组内页签条含 账号库 / 店铺登记 / 企业',
    ['accounts', 'registry', 'companies'].every(function (k) {
      return !!document.querySelector('[data-act="kind-tab-' + k + '"]');
    }),
    ['accounts', 'registry', 'companies']
      .map(function (k) { return k + '=' + !!document.querySelector('[data-act="kind-tab-' + k + '"]'); }).join(' '));
  // 反向：邮件已搬走，本模块左导航里**不该**再有它（留着就是两个"邮件"入口）。
  report('左导航里没有「邮件」（2026-10-17 起它是独立一级模块）',
    !document.querySelector('[data-act="kind-mail"]'));
  var shipKind = document.querySelector('[data-act="kind-shipping"]');
  report('第七项就叫「物流运费」', !!shipKind && flat(shipKind).indexOf('物流运费') >= 0,
    flat(shipKind));
  report('默认仍停在「店铺账号」（不因新增种类而改默认位）',
    kindActive('accounts'),
    document.querySelector('[data-act="kind-accounts"]').className);

  /* ── 冷启动空态 ──────────────────────────────────────────────────── */
  step('cold-empty');
  await gotoKind('shipping');
  report('「物流运费」面板挂载', isShown(document.querySelector('[data-act="shipping-rate-pane"]')));
  report('默认停在「运费查询」页签（wb-seg 分段控件的激活类是 is-on）',
    document.querySelector('[data-act="ship-tab-quote"]').className.indexOf('is-on') >= 0,
    document.querySelector('[data-act="ship-tab-quote"]').className);
  // 反向守卫：没表时**不该**渲染结果表，也**不该**发过任何留档调用
  report('冷启动空态：「还没有运价表」+ 不渲染结果表',
    isShown(document.querySelector('[data-act="ship-empty"]')) &&
      flat(document.querySelector('[data-act="ship-empty"]')).indexOf('还没有运价表') >= 0 &&
      !document.querySelector('[data-act="ship-quote-table"]'),
    'empty=' + isShown(document.querySelector('[data-act="ship-empty"]')));
  report('冷启动没发过留档（没表就别写库）', calls('shipRateSnapshotSave').length === 0,
    'saves=' + calls('shipRateSnapshotSave').length);

  /* ── 导入真夹具：解析 → 体检 → 留档，全真链 ─────────────────────── */
  step('import');
  await importFixture();
  report('导入真报价单：宿主留档恰 1 次、184 国（tests/shipRate.spec.ts 同款真值）',
    calls('shipRateSnapshotSave').length === 1 && (calls('shipRateSnapshotSave')[0] || {}).countries === 184,
    JSON.stringify(calls('shipRateSnapshotSave')));
  report('成功回执报出 184 国（人看到的通知与库里的数一致）',
    lastToast().indexOf('184 国') >= 0, lastToast());
  report('工作表体检真的列出了候选（8 张 sheet，含干扰项「目录」与各报价表）',
    has('无忧物流-标准') && has('燕文航空挂号小包'),
    'toast=' + lastToast());
  report('运价表区渲染出来（按国家分节，含哈萨克斯坦）',
    !!document.querySelector('[data-act="ship-sections"]') && has('哈萨克斯坦'));

  /* ── 运费查询：100g 全表，钉单测同款硬值 ────────────────────────── */
  step('quote');
  await gotoTab('quote', '[data-act="ship-quote-table"]');
  await settle(function () { return all('[data-act="ship-quote-table"] tbody tr').length === 184; }, 15000);
  var qRows = all('[data-act="ship-quote-table"] tbody tr');
  report('100g 全表 184 国全部有价（一行不多一行不少）', qRows.length === 184, 'rows=' + qRows.length);
  report('最便宜是哈萨克斯坦 8.50 元（45×0.1+4，表按运费升序）',
    !!qRows[0] && flat(qRows[0]).indexOf('哈萨克斯坦') >= 0 && flat(qRows[0]).indexOf('8.50') >= 0,
    qRows[0] ? flat(qRows[0]).slice(0, 80) : 'missing');
  report('次便宜是马来西亚 9.80 元', !!qRows[1] && flat(qRows[1]).indexOf('马来西亚') >= 0 &&
    flat(qRows[1]).indexOf('9.80') >= 0, qRows[1] ? flat(qRows[1]).slice(0, 80) : 'missing');
  report('汇总条在场（计数与表一致）',
    isShown(document.querySelector('[data-act="ship-summary"]')) &&
      flat(document.querySelector('[data-act="ship-summary"]')).indexOf('184') >= 0,
    flat(document.querySelector('[data-act="ship-summary"]')).slice(0, 60));

  /* ── 几何：表格必须真的落在视口里（2026-10-15 加，见 isShown 处注释） ──
     这组断言对着的是"DOM 完好但页面空白"那类故障，纯文本断言一条都不会红。
     1) 汇总条只有一行高：被 flex 撑成几千 px 是高度链断裂的第一症状；
     2) 首行在视口内：断裂时它会在 y=4153（视口 913 的 4.5 倍处）；
     3) 结果面板不该比视口高太多：表格该在容器里滚，而不是把整页撑高。 */
  var summaryEl = document.querySelector('[data-act="ship-summary"]');
  report('汇总条保持一行高度（未被 flex 撑成空白块）',
    heightOf(summaryEl) > 0 && heightOf(summaryEl) < 120,
    'h=' + heightOf(summaryEl) + 'px');
  var firstRow = qRows[0];
  report('表格首行落在视口内（不是"DOM 在、页面看不见"）',
    inViewport(firstRow),
    firstRow ? 'top=' + Math.round(firstRow.getBoundingClientRect().top) +
      ' bottom=' + Math.round(firstRow.getBoundingClientRect().bottom) +
      ' innerH=' + innerHeight : 'missing');
  var resultsEl = document.querySelector('.srq__results');
  var rh = heightOf(resultsEl);
  report('结果面板不超过视口高度（表格在容器内滚动，不撑高整页）',
    rh > 0 && rh <= innerHeight + 2, 'h=' + rh + ' innerH=' + innerHeight);
  var wrapEl = document.querySelector('.srq__results .wb-table-wrap');
  report('表格容器自己可滚（内容高于容器 ⇒ 滚得动，而不是被裁掉）',
    !!wrapEl && wrapEl.scrollHeight > wrapEl.clientHeight,
    wrapEl ? 'scrollH=' + wrapEl.scrollHeight + ' clientH=' + wrapEl.clientHeight : 'missing');
  // 改克重 → 220ms 防抖重算：费必须跟着变（钉着 8.50 不动 = 结果与输入脱钩）
  var w = document.querySelector('[data-act="ship-weight"]');
  report('克重输入框回显默认 100', !!w && w.value === '100', w ? 'value=' + w.value : 'missing');
  if (w) {
    setVal(w, '350');
    await settle(function () {
      var r0 = all('[data-act="ship-quote-table"] tbody tr')[0];
      return !!r0 && flat(r0).indexOf('8.50') < 0;
    }, 6000);
    var r0b = all('[data-act="ship-quote-table"] tbody tr')[0];
    // KZ 普货小包只有 ≤150g 档（100g 首行 8.50 那张卡），350g 装不下 → 首行易主。
    // 新首行 = 马来西亚 150g–500g 档：8.05×0.35+8 = 16.05（真表真算的确定值，照钉）。
    report('改 350g 后重算：首行换成马来西亚 150g–500g 档 16.05（KZ 的 ≤150g 卡装不下 350g）',
      !!r0b && flat(r0b).indexOf('马来西亚') >= 0 && flat(r0b).indexOf('16.05') >= 0,
      r0b ? flat(r0b).slice(0, 90) : 'missing');
  }

  /* ── 按订单试算：同一张卡，费必须与查询页一致 ───────────────────── */
  step('orders');
  await gotoTab('orders', '[data-act="ship-orders-run"]');
  var runBtn = document.querySelector('[data-act="ship-orders-run"]');
  report('逐单试算有执行按钮', !!runBtn && !runBtn.disabled);
  if (runBtn) {
    runBtn.click();
    await settle(function () { return !!document.querySelector('[data-act="ship-order-table"]'); }, 15000);
  }
  await settle(function () { return all('[data-act="ship-order-table"] tbody tr').length >= 2; }, 8000);
  var oRows = all('[data-act="ship-order-table"] tbody tr');
  report('订单表渲染 2 行（夹具 SO-1 / SO-2）', oRows.length === 2, 'rows=' + oRows.length);
  report('可算行：哈萨克斯坦 SO-1，克重联到 SKU（红M 100g），费 8.50 与查询页同卡同价',
    oRows.length >= 1 && flat(oRows[0]).indexOf('哈萨克斯坦') >= 0 &&
      flat(oRows[0]).indexOf('SO-1') >= 0 && flat(oRows[0]).indexOf('8.50') >= 0,
    oRows[0] ? flat(oRows[0]).slice(0, 100) : 'missing');
  report('表里没这个国的行如实拒算（亚特兰蒂斯：不出现 8.50），不硬套别国的价',
    oRows.length >= 2 && flat(oRows[1]).indexOf('亚特兰蒂斯') >= 0 && flat(oRows[1]).indexOf('8.50') < 0,
    oRows[1] ? flat(oRows[1]).slice(0, 100) : 'missing');

  /* ── 按产品试算：有 SKU 的按 SKU 展开，没建 SKU 的如实报缺 ──────── */
  step('products');
  await gotoTab('products', '[data-act="ship-country"]');
  var cSel = document.querySelector('[data-act="ship-country"]');
  report('目的国下拉已列出表里的国家（含哈萨克斯坦）',
    !!cSel && (cSel.innerText || '').indexOf('哈萨克斯坦') >= 0,
    cSel ? 'options=' + cSel.options.length : 'missing');
  if (cSel) {
    setVal(cSel, '哈萨克斯坦');
    var pRun = document.querySelector('[data-act="ship-products-run"]');
    report('有「试算」按钮', !!pRun && !pRun.disabled);
    if (pRun) {
      pRun.click();
      await settle(function () { return !!document.querySelector('[data-act="ship-product-table"]'); }, 15000);
    }
  }
  await settle(function () { return all('[data-act="ship-product-table"] tbody tr').length >= 2; }, 8000);
  var pRows = all('[data-act="ship-product-table"] tbody tr');
  report('产品表渲染 2 款（S1 / S2）', pRows.length === 2, 'rows=' + pRows.length);
  report('有 SKU 的款按 SKU 展开计价：S1（红M 100g）费 8.50，与查询 / 订单两链一致',
    pRows.length >= 1 && flat(pRows[0]).indexOf('S1') >= 0 && flat(pRows[0]).indexOf('8.50') >= 0,
    pRows[0] ? flat(pRows[0]).slice(0, 100) : 'missing');
  report('没建 SKU 的 S2 不硬算：不出现 8.50（缺克重要如实报，不拿别的款顶）',
    pRows.length >= 2 && flat(pRows[1]).indexOf('S2') >= 0 && flat(pRows[1]).indexOf('8.50') < 0,
    pRows[1] ? flat(pRows[1]).slice(0, 100) : 'missing');

  /* ── 持久化：偏好真落库、重挂载真回显 ──────────────────────────── */
  step('persist');
  var shipSaves = calls('setModuleState').filter(function (c) { return c.ns === 'shipping-rate'; });
  // save#2（weight=350）走的是 500ms 防抖 —— 前面几步的 settle 条件一满足就退出，
  // 不消耗虚拟时间，此刻它多半还没发。先把"克重 350 的落库"等出来再断言。
  await settle(function () {
    var ss = calls('setModuleState').filter(function (c) { return c.ns === 'shipping-rate'; });
    return ss.length >= 2 && Number(ss[ss.length - 1].data.weight) === 350;
  }, 8000);
  shipSaves = calls('setModuleState').filter(function (c) { return c.ns === 'shipping-rate'; });
  // 夹具真实 sheet 集合（含「目录/说明」2 干扰项）。以真实载荷为准，不写死数字。
  var EXPECT_SHEETS = ['目录', '无忧物流-特惠', '无忧物流-标准', '燕文航空挂号小包',
    '超级经济-燕文', '4PX新邮挂号小包', '无忧物流-特货标准', '无忧物流-海运大件专线', '说明'];
  var savedSheets = shipSaves.length && shipSaves[0].data ? (shipSaves[0].data.sheetNames || []) : [];
  var sheetsOk = EXPECT_SHEETS.every(function (n) { return savedSheets.indexOf(n) >= 0; })
    && savedSheets.length === EXPECT_SHEETS.length;
  report('偏好已防抖落库（体检 sheetNames 全部候选表都在载荷里）',
    shipSaves.length >= 1 && Array.isArray(savedSheets) && sheetsOk,
    'saves=' + shipSaves.length + ' sheetNames=' + JSON.stringify(savedSheets));
  report('克重 350 也在持久化载荷里（不是只改了内存）',
    shipSaves.length >= 1 && Number(shipSaves[shipSaves.length - 1].data.weight) === 350,
    'weight=' + (shipSaves.length ? shipSaves[shipSaves.length - 1].data.weight : '—'));
  // 重挂载：切走再切回，store 重新 init（从假桥的 PERSIST 读）→ 回显 350
  await gotoKind('accounts');
  await gotoKind('shipping');
  await settle(function () { return !!document.querySelector('[data-act="ship-weight"]'); }, 8000);
  var w2 = document.querySelector('[data-act="ship-weight"]');
  report('重挂载后克重回显 350（持久化真的接住了，不是组件内存）',
    !!w2 && w2.value === '350', w2 ? 'value=' + w2.value : 'missing');

  step('errors');
  report('无未捕获错误', (window.__smokeErrors || []).length === 0,
    JSON.stringify(window.__smokeErrors || []));
}

/** 窄视口：精简（boot → 导入 → 首行硬值 → 页签条仍在），防 60s 预算不够跑全量 */
async function narrowViewportChecks() {
  step('boot-narrow');
  await waitFor(function () { return document.querySelector('.md-view'); }, 12000);
  await gotoKind('shipping');
  report('窄视口：面板挂载、冷启动空态可见',
    isShown(document.querySelector('[data-act="shipping-rate-pane"]')) &&
      isShown(document.querySelector('[data-act="ship-empty"]')));
  step('import-narrow');
  await importFixture();
  report('窄视口：导入全真链照常（留档 184 国）',
    calls('shipRateSnapshotSave').length === 1 && (calls('shipRateSnapshotSave')[0] || {}).countries === 184,
    JSON.stringify(calls('shipRateSnapshotSave')));
  await gotoTab('quote', '[data-act="ship-quote-table"]');
  await settle(function () { return all('[data-act="ship-quote-table"] tbody tr').length === 184; }, 15000);
  var r0 = all('[data-act="ship-quote-table"] tbody tr')[0];
  report('窄视口：100g 首行哈萨克斯坦 8.50（窄屏不改变口径）',
    !!r0 && flat(r0).indexOf('哈萨克斯坦') >= 0 && flat(r0).indexOf('8.50') >= 0,
    r0 ? flat(r0).slice(0, 80) : 'missing');
  report('窄视口：页签条四项都在（堆叠布局不吞导航）',
    ['quote', 'rates', 'orders', 'products'].every(function (id) {
      return isShown(document.querySelector('[data-act="ship-tab-' + id + '"]'));
    }));
  step('errors');
  report('无未捕获错误', (window.__smokeErrors || []).length === 0,
    JSON.stringify(window.__smokeErrors || []));
}

function finish() {
  var failed = lines.some(function (l) { return l.indexOf('FAIL') === 0 || l.indexOf('SMOKE: FAILED') === 0; });
  lines.push(failed ? 'SMOKE: FAILED' : 'SMOKE: ALL PASS');
  var pre = document.createElement('pre');
  pre.id = 'smoke-result';
  pre.textContent = lines.join('\\n');
  document.body.appendChild(pre);
}

async function run() {
  var MODE = new URLSearchParams(location.search).get('mode') ||
    (window.innerWidth < 1180 ? 'narrow' : 'full');
  if (MODE === 'narrow') {
    try {
      await narrowViewportChecks();
    } catch (e) {
      lines.push('SMOKE: FAILED at [' + STEP + '] - ' + (e && e.message ? e.message : String(e)));
    }
    finish();
    return;
  }
  try {
    await main();
  } catch (e) {
    lines.push('SMOKE: FAILED at [' + STEP + '] - ' + (e && e.message ? e.message : String(e)));
  }
  finish();
}
run();
</script>`;

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
cpSync(DIST, WORK, { recursive: true });
const indexPath = path.join(WORK, 'index.html');
let html = readFileSync(indexPath, 'utf8');
html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '');
html = html.replace('</head>', () => FAKE_BRIDGE + '</head>');
html = html.replace('</body>', () => ASSERT_SCRIPT + '</body>');
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

async function runChrome(size, budget, mode) {
  const dom = await new Promise((resolve, reject) => {
    const cp = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      `--window-size=${size}`,
      `--virtual-time-budget=${budget}`,
      '--dump-dom',
      `http://127.0.0.1:${PORT}/index.html?mode=${mode}`,
    ]);
    let out = '';
    cp.stdout.on('data', (d) => (out += String(d)));
    cp.on('error', reject);
    cp.on('close', () => resolve(out));
  });
  const m = dom.match(/id="smoke-result"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) return null;
  return m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

const passes = [
  { mode: 'full', size: '1440,900', budget: 90000, label: '全量断言（宽 1440）' },
  { mode: 'narrow', size: '900,800', budget: 60000, label: '窄视口精简（900×800）' },
].filter((p) => !process.env.SMOKE_MODE || p.mode === process.env.SMOKE_MODE);
const results = {};
for (const p of passes) {
  const out = await runChrome(p.size, p.budget, p.mode);
  results[p.mode] = out;
  if (passes.indexOf(p) === 0) {
    if (!out) {
      console.error('✗ 宽视口那遍没抓到 #smoke-result（页面可能没挂载）。排查：产物新鲜度（npm run build）→ 资源 404 → 内联脚本语法错 → 假桥缺键');
      process.exit(1);
    }
    console.log(out);
  } else {
    console.log(`\n── ${p.label} ──`);
    console.log(out || '✗ 这一遍没抓到 #smoke-result');
  }
}
server.close();

const ok = passes.every((p) => !!results[p.mode] && results[p.mode].split('\n').pop() === 'SMOKE: ALL PASS');
console.log(ok ? '\n✓ 物流运费（宿主内建）冒烟通过（宽 + 窄，共两遍）' : '\n✗ 物流运费（宿主内建）冒烟失败');
process.exit(ok ? 0 : 1);
