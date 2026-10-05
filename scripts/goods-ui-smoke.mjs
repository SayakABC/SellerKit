// 「货与成本」页的**假桥无头冒烟**（不启动宿主，不需要 Electron）。
//
//   npm run goods:ui
//
// 为什么需要它：这一页是**写入面**（改克重会落库），而 `productVariantUpsert` 是**全量提交** ——
// 只传 `weightG` 会把该 SKU 的颜色/尺码/名称静默清空（界面看着"保存成功"）。这条只能靠"点击后断言出参"抓。
//
// 做法与 `picking:ui` / `today:ui` 同款：build 产物 → 假桥 → 本地 HTTP → 无头 Chrome → 抓 `#smoke-result`。
// ⚠️ 注入脚本里的注释不能含反引号；改完 `node --check`。

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'renderer');
const WORK = path.join('/tmp', 'sellerkit-goods-smoke');
const PORT = 8129;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error(`✗ 找不到构建产物 ${DIST}/index.html —— 先跑 npm run build`);
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error(`✗ 找不到无头 Chrome：${CHROME}`);
  process.exit(1);
}

const FAKE_BRIDGE = `<script>
(function () {
  var calls = {};
  window.__smokeCalls = calls;
  function rec(name, payload) { (calls[name] = calls[name] || []).push(payload); }

  // 两个产品：P1 有两个 SKU（一个缺克重）、P2 一个 SKU；P2 未关联供应商
  var PRODUCTS = [
    { id: 1, code: 'S1', name: '款一', supplierId: 7, supplierName: '厂A', category: '衣服', status: 'active', note: '', imageId: 0, imagePath: '', createdAt: '', updatedAt: '' },
    { id: 2, code: 'S2', name: '款二', supplierId: 0, supplierName: '', category: '衣服', status: 'active', note: '', imageId: 0, imagePath: '', createdAt: '', updatedAt: '' },
  ];
  var VARIANTS = [
    { id: 11, productId: 1, code: 'SKU-A', name: '黑 L', color: '黑', size: 'L', weightG: 320, status: 'active' },
    { id: 12, productId: 1, code: '', name: '黑 M', color: '黑', size: 'M', weightG: 0, status: 'active' },
    { id: 21, productId: 2, code: '', name: '白 XL', color: '白', size: 'XL', weightG: 400, status: 'active' },
  ];

  /* ==========================================================================
     产品库岛搬进内建后的三个页签（2026-10-01 迁移）。
     数据模型刻意留了三个「有辨别力」的样本（口径照搬原岛冒烟，一条都没放宽）：
       ① 两家**不同平台、不同 shopId** 的店 —— 批量关联"串店"（把第一行的店铺套给
          所有行）只有这种样本才抓得到，同店同平台的样本恒绿；
       ② 一行「店铺未归一」—— 界面上必须仍不可勾选、不可关联（订单里没有平台，
          硬塞会把两家不同平台的店并到同一个键上）；
       ③ 一条历史「已失效」映射 —— 验「恢复 / 改绑顺带拉回已确认」这条回退路径。
     还有一条：MAPPED 初始 4 条，与队列**无交集**（都是已经没有订单的历史映射）——
     队列是实时聚合订单再减去生效映射，两者本来就是两拨数据。
     ========================================================================== */
  var SUPPLIERS = [
    { id: 7, name: '厂A', phone: '13800000000', note: '', createdAt: '2026-09-20 09:00' },
    { id: 8, name: '厂B', phone: '', note: '只做辅料', createdAt: '2026-09-25 09:00' },
  ];

  var QUEUE = [
    { shopKey: 'hk 优品店', shopRaw: 'HK优品店', itemId: 'SKU-A1', title: '折叠收纳箱 60L 蓝色', orderCount: 37, shopId: 11, shopName: 'HK 优品店', platform: 'shopee', autoShopId: 0, autoShopName: '', autoShopPlatform: '', status: 'unmapped' },
    { shopKey: 'aurora store', shopRaw: 'Aurora Store', itemId: 'B0XYZ1234', title: 'Travel Organizer 8pcs', orderCount: 12, shopId: 12, shopName: 'Aurora Store', platform: 'amazon', autoShopId: 0, autoShopName: '', autoShopPlatform: '', status: 'unmapped' },
    { shopKey: '新奇怪物店', shopRaw: '新奇怪物店', itemId: 'TB-999', title: '未知商品', orderCount: 3, shopId: 0, shopName: '', platform: '', autoShopId: 12, autoShopName: 'Aurora Store', autoShopPlatform: 'amazon', status: 'shopUnresolved' },
  ];

  var MAPPED = [
    { id: 501, platform: 'shopee', shopId: 11, itemId: 'SKU-OLD', spec: '*', productId: 1, productCode: 'S1', productName: '款一', variantId: 0, qtyPerItem: 1, status: 'confirmed', source: 'manual', note: '', createdAt: '', updatedAt: '2026-09-26 09:00' },
    { id: 502, platform: 'amazon', shopId: 12, itemId: 'B0OLD0001', spec: '*', productId: 2, productCode: 'S2', productName: '款二', variantId: 0, qtyPerItem: 1, status: 'invalid', source: 'manual', note: 'listing 合并过', createdAt: '', updatedAt: '2026-09-25 09:00' },
    { id: 503, platform: 'shopee', shopId: 11, itemId: 'SKU-OLD2', spec: '*', productId: 1, productCode: 'S1', productName: '款一', variantId: 0, qtyPerItem: 1, status: 'confirmed', source: 'import', note: '', createdAt: '', updatedAt: '2026-09-24 09:00' },
    { id: 504, platform: 'amazon', shopId: 12, itemId: 'B0OLD0002', spec: '*', productId: 2, productCode: 'S2', productName: '款二', variantId: 0, qtyPerItem: 1, status: 'confirmed', source: 'manual', note: '', createdAt: '', updatedAt: '2026-09-23 09:00' },
  ];

  var SHOP_ITEMS = [
    { itemId: 'SKU-A1', shopId: 11, shopName: 'HK 优品店', imageUrl: '', importedAt: 1759219200000, relationCount: 1 },
    { itemId: 'B0XYZ1234', shopId: 12, shopName: 'Aurora Store', imageUrl: '', importedAt: 1759219200000, relationCount: 0 },
  ];

  /** 商品ID → 关联的产品（一对多） */
  var RELATIONS = [
    { id: 901, itemId: 'SKU-A1', productId: 1, productCode: 'S1', productName: '款一', createdAt: '2026-09-27 12:00' },
  ];

  /** 本会话已建立的映射键（队列据此剔除"已关联"的组）—— 真实里是 pl_shop_sku WHERE status='confirmed' */
  var MAP = {};
  var SEQ = 950;
  function keyOf(r) { return r.platform + '|' + r.shopId + '|' + r.itemId; }
  function productOf(id) {
    for (var i = 0; i < PRODUCTS.length; i++) if (PRODUCTS[i].id === id) return PRODUCTS[i];
    return null;
  }

  var OVERRIDES = {
    'getAppVersion': function () { return { success: true, data: '0.0.0-smoke' }; },
    'get-app-version': function () { return { success: true, data: '0.0.0-smoke' }; },
    'getModuleState': function (ns) {
      if (ns === 'app-shell') return { success: true, data: { lastActiveModuleId: 'goods', collapsed: false } };
      return { success: true, data: null };
    },
    // 筛选语义镜像主进程 listProducts：**快捷筛选优先于 supplierId**（同时给时以快捷筛选为准）。
    // 夹具必须连"筛选真的会窄"一起复刻 —— 否则"点了指标条列表被筛窄"这条断言会恒绿
    // （界面发了参数、假桥原样返回全部，行数照样是 2）。
    // 缺克重集合**每次现算**：假桥的 upsert 不改克重，但组件的乐观更新会改 VARIANTS 里的对象，
    // 写死一份会在保存那一步之后失准。
    'productList': function (p) {
      rec('productList', p);
      var rows = PRODUCTS;
      if (p && p.onlyMissingWeight) {
        var missingIds = VARIANTS.filter(function (v) { return !(Number(v.weightG) > 0); })
          .map(function (v) { return v.productId; });
        rows = rows.filter(function (x) { return missingIds.indexOf(x.id) >= 0; });
      } else if (p && p.withoutSupplier) {
        rows = rows.filter(function (x) { return !x.supplierId; });
      } else if (p && p.supplierId) {
        rows = rows.filter(function (x) { return x.supplierId === p.supplierId; });
      }
      return { success: true, data: { rows: rows, total: rows.length } };
    },
    'productVariantList': function (p) {
      rec('productVariantList', p);
      var ids = (p && p.productIds) || [];
      return { success: true, data: { rows: VARIANTS.filter(function (v) { return ids.indexOf(v.productId) >= 0; }) } };
    },
    // 供应商下拉与「供应商」页签的产品数列都取自这里（不各自数一遍，避免两处口径打架）
    'productSummary': function () {
      rec('productSummary', {});
      return { success: true, data: {
        total: PRODUCTS.length,
        byStatus: [{ status: 'active', count: PRODUCTS.length }],
        withoutSupplier: PRODUCTS.filter(function (p) { return !p.supplierId; }).length,
        supplierOptions: [
          { id: 7, name: '厂A', productCount: PRODUCTS.filter(function (p) { return p.supplierId === 7; }).length },
          { id: 8, name: '厂B', productCount: 0 },
        ],
      } };
    },
    // 映射记录总数 = MAPPED.length（4，与指标条「已映射商品ID 4」同源——
    // 两边都从 productSkuSummary 取，所以只要这一处口径对，指标条与映射列表就不会各说各话）
    'productSkuSummary': function () {
      rec('productSkuSummary', {});
      var byShop = [];
      for (var i = 0; i < MAPPED.length; i++) {
        var r = MAPPED[i], hit = null;
        for (var j = 0; j < byShop.length; j++) if (byShop[j].shopId === r.shopId) hit = byShop[j];
        if (hit) hit.count++;
        else byShop.push({ shopId: r.shopId, shopName: r.shopId === 11 ? 'HK 优品店' : 'Aurora Store', platform: r.platform, count: 1 });
      }
      return { success: true, data: { total: MAPPED.length, byStatus: [], byPlatform: [], byShop: byShop } };
    },
    'productVariantUpsert': function (p) { rec('productVariantUpsert', p); return { success: true, data: { id: p.id, created: false } }; },
    'productDbEnsure': function () { return { success: true, data: { ok: true } }; },

    /* ---- 批量编辑（部分 patch：只应用 payload 里出现的字段）---- */
    'productBatchUpdate': function (p) {
      rec('productBatchUpdate', p);
      var ids = (p && p.ids) || [];
      for (var i = 0; i < ids.length; i++) {
        for (var j = 0; j < PRODUCTS.length; j++) {
          if (PRODUCTS[j].id !== ids[i]) continue;
          if (p.supplierId !== undefined) { PRODUCTS[j].supplierId = p.supplierId; PRODUCTS[j].supplierName = p.supplierId === 7 ? '厂A' : ''; }
          if (p.category !== undefined) PRODUCTS[j].category = p.category;
          if (p.status !== undefined) PRODUCTS[j].status = p.status;
          if (p.note !== undefined) PRODUCTS[j].note = p.note;
        }
      }
      return { success: true, data: { updated: ids.length } };
    },

    /* ---- 待关联队列（实时聚合：QUEUE − 本会话已生效的映射）---- */
    'productSkuQueue': function (p) {
      rec('productSkuQueue', p);
      var rows = QUEUE.filter(function (r) { return !(r.shopId && MAP[keyOf(r)]); });
      var unmapped = rows.filter(function (r) { return r.status === 'unmapped'; }).length;
      return { success: true, data: {
        rows: rows,
        stats: {
          groups: QUEUE.length, shown: rows.length, unmapped: unmapped,
          shopUnresolved: rows.length - unmapped, mapped: Object.keys(MAP).length,
          withItemId: 52, withoutItemId: 4, truncated: false,
          unresolvedShops: rows.filter(function (r) { return r.status !== 'unmapped'; }).map(function (r) { return r.shopRaw; }),
        },
      } };
    },
    'productSkuList': function (p) {
      rec('productSkuList', p);
      var kw = (p && p.search) || '', st = (p && p.status) || '', sid = Number((p && p.shopId) || 0);
      var list = MAPPED.filter(function (r) {
        if (st && r.status !== st) return false;
        if (sid && r.shopId !== sid) return false;
        if (kw && (r.itemId + ' ' + r.platform + ' ' + r.note).indexOf(kw) < 0) return false;
        return true;
      });
      var off = Number((p && p.offset) || 0), lim = Number((p && p.limit) || 50);
      return { success: true, data: { rows: list.slice(off, off + lim), total: list.length } };
    },
    'productSkuMap': function (p) {
      rec('productSkuMap', p);
      var input = (p && p.rows) || [];
      var out = { created: 0, updated: 0, failed: [] };
      for (var i = 0; i < input.length; i++) {
        var n = input[i];
        var hit = productOf(n.productId);
        if (!hit) { out.failed.push({ itemId: String(n.itemId), message: '产品不存在或已被删除' }); continue; }
        MAP[keyOf(n)] = true;
        var exist = null;
        for (var m = 0; m < MAPPED.length; m++) {
          var e = MAPPED[m];
          if (e.platform === n.platform && e.shopId === n.shopId && e.itemId === n.itemId) exist = e;
        }
        if (exist) {
          exist.productId = hit.id; exist.productCode = hit.code; exist.productName = hit.name;
          exist.status = n.status || 'confirmed';
          out.updated++;
        } else {
          MAPPED.push({
            id: ++SEQ, platform: n.platform, shopId: n.shopId, itemId: n.itemId, spec: n.spec || '*',
            productId: hit.id, productCode: hit.code, productName: hit.name, variantId: 0, qtyPerItem: 1,
            status: n.status || 'confirmed', source: 'manual', note: n.note || '',
            createdAt: '2026-10-01 12:00', updatedAt: '2026-10-01 12:00',
          });
          out.created++;
        }
      }
      return { success: true, data: out };
    },
    'productSkuInvalidate': function (p) {
      rec('productSkuInvalidate', p);
      for (var i = 0; i < MAPPED.length; i++) if (MAPPED[i].id === p.id) MAPPED[i].status = 'invalid';
      return { success: true, data: { changed: true } };
    },
    'productItemImagePool': function (p) {
      rec('productItemImagePool', p);
      return { success: true, data: { pool: {} } };
    },
    'orderImageThumbBatch': function (p) {
      rec('orderImageThumbBatch', p);
      return { success: true, data: { dataUrls: ((p && p.items) || []).map(function () { return null; }) } };
    },

    /* ---- 供应商主数据 ---- */
    'purchaseSupplierList': function () { rec('purchaseSupplierList', {}); return { success: true, data: SUPPLIERS }; },
    'purchaseSupplierCreate': function (p) {
      rec('purchaseSupplierCreate', p);
      var id = ++SEQ;
      SUPPLIERS.push({ id: id, name: p.name, phone: p.phone || '', note: p.note || '', createdAt: '2026-10-01 12:00' });
      return { success: true, data: { id: id } };
    },
    'purchaseSupplierUpdate': function (p) {
      rec('purchaseSupplierUpdate', p);
      for (var i = 0; i < SUPPLIERS.length; i++) {
        if (SUPPLIERS[i].id === p.id) { SUPPLIERS[i].phone = p.phone || ''; SUPPLIERS[i].note = p.note || ''; }
      }
      return { success: true, data: {} };
    },
    'purchaseSupplierDelete': function (p) {
      rec('purchaseSupplierDelete', p);
      SUPPLIERS = SUPPLIERS.filter(function (s) { return s.id !== p.id; });
      return { success: true, data: { removed: 1 } };
    },

    /* ---- 店铺商品清单（按 item_id 去重，一件商品可一对多关联产品）---- */
    'shopProductList': function (p) {
      rec('shopProductList', p);
      var kw = (p && p.search) || '';
      var list = SHOP_ITEMS.filter(function (x) { return !kw || x.itemId.indexOf(kw) >= 0; });
      return { success: true, data: { rows: list, total: list.length } };
    },
    'shopProductRelations': function (p) {
      rec('shopProductRelations', p);
      return { success: true, data: RELATIONS.filter(function (r) { return r.itemId === p.itemId; }) };
    },
    'shopProductRelationAdd': function (p) {
      rec('shopProductRelationAdd', p);
      var hit = productOf(p.productId);
      var id = ++SEQ;
      RELATIONS.push({ id: id, itemId: p.itemId, productId: p.productId, productCode: hit ? hit.code : '', productName: hit ? hit.name : '', createdAt: '2026-10-01 12:00' });
      for (var i = 0; i < SHOP_ITEMS.length; i++) if (SHOP_ITEMS[i].itemId === p.itemId) SHOP_ITEMS[i].relationCount++;
      return { success: true, data: { id: id, created: true } };
    },
    'shopProductRelationDelete': function (p) {
      rec('shopProductRelationDelete', p);
      var gone = null;
      for (var i = 0; i < RELATIONS.length; i++) if (RELATIONS[i].id === p.id) gone = RELATIONS[i];
      RELATIONS = RELATIONS.filter(function (r) { return r.id !== p.id; });
      if (gone) for (var j = 0; j < SHOP_ITEMS.length; j++) if (SHOP_ITEMS[j].itemId === gone.itemId) SHOP_ITEMS[j].relationCount = Math.max(0, SHOP_ITEMS[j].relationCount - 1);
      return { success: true, data: { removed: gone ? 1 : 0 } };
    },
    'shopProductDelete': function (p) {
      rec('shopProductDelete', p);
      SHOP_ITEMS = SHOP_ITEMS.filter(function (x) { return x.itemId !== p.itemId; });
      RELATIONS = RELATIONS.filter(function (r) { return r.itemId !== p.itemId; });
      return { success: true, data: { removed: 1 } };
    },
    // 假桥兜底是 {success:true, data:null}，而 externalLoader 判的是 !r.data ⇒ 不补这个桩，
    // 每张截图右下角都挂一条**常驻红 toast**「扫描插件目录失败（IPC 不可用）」。
    // 真机这里返回 {root, plugins}（plugins-handlers），补桩是让夹具**忠于真形状**，
    // 不是为了消掉颜色 —— 红 toast 一直挂着会训练人忽略红 toast。
    // ⚠️ 本段是模板字面量：注释里**不能出现反引号**（会提前终止模板串，报错却指向注释行）。
    'pluginsScan': function () { return { success: true, data: { root: '/tmp/smoke-plugins', plugins: [] } }; },
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
      // ⚠️ 回调必须 try/catch：抛错会让 Promise 永不落地 → await 挂死 → 结果一个字都写不出来
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
function productRows() { return document.querySelectorAll('[data-act="product-table"] tbody tr[data-product-id]'); }
function variantRows() { return document.querySelectorAll('[data-act="variant-table"] tbody tr[data-variant-id]'); }
function weightInput(rowIndex) {
  var rows = variantRows();
  return rows[rowIndex] ? rows[rowIndex].querySelector('[data-act="weight"]') : null;
}

/* ---- 迁入页签用到的通用小工具 ---- */
function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function has(text) { return (document.body.innerText || '').indexOf(text) >= 0; }
function mapFlat(sel) { return all(sel).map(flat).join('/'); }
/** 队列行 / 映射行：必须**按所在表格**限定，否则 [data-item-id] 会同时命中「商品清单」 */
function queueRow(itemId) { return document.querySelector('[data-act="queue-table"] tbody tr[data-item-id="' + itemId + '"]'); }
function mappedRow(itemId) { return document.querySelector('[data-act="mapped-table"] tbody tr[data-item-id="' + itemId + '"]'); }
/** 触发 Vue v-model：直接赋值不触发更新，必须走原生 setter + input/change */
function setVal(el, value) {
  var proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}
/** 在 sel 里找文案含 text 且可点的元素点下去（每轮重查 + 校验 isConnected） */
async function clickText(sel, text, timeout) {
  var t0 = Date.now();
  for (;;) {
    var els = all(sel);
    for (var i = 0; i < els.length; i++) {
      var e = els[i];
      if (e.isConnected && !e.disabled && flat(e).indexOf(text) >= 0) { e.click(); return true; }
    }
    if (Date.now() - t0 > (timeout || 4000)) throw new Error('找不到可点击元素: ' + sel + ' / ' + text);
    await sleep(40);
  }
}

async function main() {
  try {
    step('boot');
    await waitFor(function () { return document.querySelector('.gd-view'); }, 10000);
    report('挂载：货与成本页渲染', true);
    await waitFor(function () { return productRows().length >= 2; }, 8000);

    step('stats');
    // 按 data-act **逐元素**断言，而不是拿整条拼串去正则 —— 拼串断言会把"有哪几格"
    // 也一起钉住（挪一下格子就红），而真正要守的是"每一格的标签与数字对不对"。
    function metric(act) {
      var el = document.querySelector('[data-act="' + act + '"]');
      return el ? flat(el) : null;
    }
    var m = {
      products: metric('metric-products'), sku: metric('metric-sku'),
      missing: metric('metric-missing'), noSupplier: metric('metric-no-supplier'),
      mapped: metric('metric-mapped'),
    };
    report('指标条五格：产品 2 · SKU 3 · 缺克重 1 · 未关联供应商 1 · 已映射商品ID 4',
      m.products === '产品 2' && m.sku === 'SKU 3' && m.missing === '缺克重 1' &&
        m.noSupplier === '未关联供应商 1' && m.mapped === '已映射商品ID 4',
      JSON.stringify(m));
    // 「产品 / SKU」是规模事实，没有"点了去哪"的目的地。做成按钮就是假动作
    // （原来两格都绑 goProducts('all')，点下去只是回到全部）。这条守着"别再做回去"。
    report('「产品 / SKU」是只读事实格，不是按钮',
      !document.querySelector('[data-act="metric-products"]').closest('button') &&
        !document.querySelector('[data-act="metric-sku"]').closest('button'));
    report('指标条右段三格仍是可点的待办入口',
      !!document.querySelector('button[data-act="metric-missing"]') &&
        !!document.querySelector('button[data-act="metric-no-supplier"]') &&
        !!document.querySelector('button[data-act="metric-mapped"]'));

    // ── 待办 → 名单：点指标条上的「缺克重」应当**切到产品页并把列表筛窄** ──
    // 这条路径此前完全没有覆盖（"指标条可点"只写在注释里，没人验过点下去真的会筛）。
    step('metric-filter');
    document.querySelector('[data-act="metric-missing"]').click();
    await waitFor(function () { return productRows().length === 1; }, 6000);
    report('点「缺克重 1」→ 产品列表筛到 1 款（P1 有个 SKU 没克重，P2 不该出现）',
      productRows().length === 1 && flat(productRows()[0].querySelector('[data-act="p-code"]')) === 'S1',
      'rows=' + productRows().length);
    report('筛窄是靠发参数给主进程，不是界面自己过滤',
      calls('productList').some(function (p) { return p && p.onlyMissingWeight === true; }),
      JSON.stringify(calls('productList').slice(-1)[0]));
    report('出现活跃筛选 chip（原来的常驻开关看不出"哪些条件正在生效"）',
      mapFlat('[data-act="active-filters"] .gd-chip').indexOf('只看缺克重') >= 0,
      mapFlat('[data-act="active-filters"] .gd-chip'));
    document.querySelector('[data-act="chip-missing"]').click();
    await waitFor(function () { return productRows().length === 2; }, 6000);
    report('点 chip 的 × → 撤掉该条件，列表回到 2 款、活跃筛选行整行消失',
      productRows().length === 2 && !document.querySelector('[data-act="active-filters"]'),
      'rows=' + productRows().length);

    // ── 工具栏的形状：不再有重复入口与常驻开关（守"别再加回去"）──
    step('toolbar-shape');
    var toolbarText = flat(document.querySelector('.gd-toolbar'));
    report('工具栏不再重复「下载模板」（导入弹层里已有，且那里文案更贴场景）',
      toolbarText.indexOf('下载模板') < 0, toolbarText);
    report('工具栏不再有常驻的「只看…」开关（入口统一在顶部指标条）',
      toolbarText.indexOf('只看') < 0, toolbarText);

    step('products');
    // 2026-10-01 界面重设计后：产品表加了「勾选/主图」两列，**列数会变**，
    // 所以断言从「按位置整行」升级为「按 data-act 逐元素」——被断言的文本值一个字不改，
    // 但不再把「表格有哪几列」当成契约（那是布局，不是数据）。
    function cellOf(act, rowIndex) {
      var row = productRows()[rowIndex];
      var el = row && row.querySelector('[data-act="' + act + '"]');
      return el ? flat(el) : null;
    }
    var p1 = {
      code: cellOf('p-code', 0), name: cellOf('p-name', 0), supplier: cellOf('p-supplier', 0),
      sku: cellOf('p-sku', 0), missing: cellOf('missing-weight-cell', 0),
    };
    report('产品表：款编码/名称/供应商 + 每款 SKU 数与缺克重数',
      p1.code === 'S1' && p1.name === '款一' && p1.supplier === '厂A' && p1.sku === '2' && p1.missing === '1',
      JSON.stringify(p1));
    report('未关联供应商的产品显示「(未关联)」（不静默留空）',
      cellOf('p-supplier', 1) === '(未关联)', 'supplier=' + cellOf('p-supplier', 1));
    // 0 必须写 0：旧写法 missingOf(p.id) || '-' 把"这款不缺"渲染成「—」，用户读成"没生效"（2026-10-01 实报）
    var p2missing = productRows()[1].querySelector('[data-act="missing-weight-cell"]');
    report('缺克重为 0 时显示 0，不是「—」（— 会被读成"没有数据"）',
      !!p2missing && flat(p2missing) === '0', 'cell=' + (p2missing ? flat(p2missing) : 'none'));

    step('variants');
    report('默认选中第一个产品 → SKU 表列出它的两个 SKU',
      variantRows().length === 2 && flat(variantRows()[0]).indexOf('黑 L') >= 0,
      Array.prototype.map.call(variantRows(), flat).join(' / '));
    report('克重已填的显示数值、未填的留空（0 不当成有效克重）',
      weightInput(0).value === '320' && weightInput(1).value === '', 
      'v0=' + weightInput(0).value + ' v1=' + weightInput(1).value);

    step('save');
    var input = weightInput(1);
    input.value = '275';
    input.dispatchEvent(new Event('change'));
    await waitFor(function () { return calls('productVariantUpsert').length >= 1; }, 6000);
    var sent = calls('productVariantUpsert')[0];
    report('改克重真的落库，且**带上该行全部现有字段**（全量提交，漏字段会把颜色/尺码清空）',
      !!sent && sent.id === 12 && Number(sent.weightG) === 275 && sent.productId === 1 &&
        sent.color === '黑' && sent.size === 'M' && sent.name === '黑 M' && sent.status === 'active',
      JSON.stringify(sent));
    await waitFor(function () { return metric('metric-missing') === '缺克重 0'; }, 6000);
    report('保存后缺克重计数实时归零', metric('metric-missing') === '缺克重 0', metric('metric-missing'));
    report('界面给出保存回执（不只是一闪而过的 toast）',
      flat(document.querySelector('[data-act="saved"]')).indexOf('黑 M') >= 0,
      flat(document.querySelector('[data-act="saved"]')));

    step('switch');
    productRows()[1].click();
    await waitFor(function () {
      var rows = variantRows();
      return rows.length === 1 && flat(rows[0]).indexOf('白 XL') >= 0;
    }, 6000);
    report('点另一个产品 → SKU 表跟着切换', true, flat(variantRows()[0]));

    /* ======================================================================
       产品库岛的功能已整体收回内建（2026-10-01，岛本身一并下架）。以下断言
       **逐条从该岛原先的 UI 冒烟搬过来**（那个脚本随岛一起下线了），口径一条都没放宽 ——
       岛下架后这批契约（批量关联一次提交 / 不串店 / 未归一不可点 / 失效按 id 定位 /
       部分 patch 不带空字段）必须继续有人守，否则"迁移"就变成"功能静默降级"。
       ====================================================================== */
    step('tabs');
    var tabNames = mapFlat('.gd-tabs .gd-tab');
    report('四个页签都在，且默认停在「产品」',
      ['产品', '商品清单', '映射与关联', '供应商'].every(function (n) { return tabNames.indexOf(n) >= 0; }) &&
        flat(document.querySelector('.gd-tabs .gd-tab.is-active')).indexOf('产品') === 0,
      tabNames);

    // ── 产品：批量编辑（部分 patch —— 没填的字段绝不能带进 payload）──────
    step('batch-edit');
    document.querySelector('[data-act="product-table"] thead input[type="checkbox"]').click();
    await waitFor(function () {
      return flat(document.querySelector('[data-act="selection-bar"]')).indexOf('已选 2 个款') >= 0;
    }, 4000);
    await clickText('[data-act="selection-bar"] button', '批量编辑');
    await waitFor(function () { return all('.wb-mask .gd-batch').length === 1; }, 4000);
    report('批量编辑弹层出现（选中 2 个款）',
      flat(document.querySelector('.wb-mask .wb-dialog__head')).indexOf('批量编辑 2 个款') >= 0,
      flat(document.querySelector('.wb-mask .wb-dialog__head')));
    // 全留空直接应用 → 必须被拦截：否则会发一个空 patch，主进程"成功更新 0 个字段"
    await clickText('.wb-mask .wb-dialog__foot button', '应用到选中行');
    await waitFor(function () { return flat(document.querySelector('.wb-mask')).indexOf('至少修改一项') >= 0; }, 4000);
    report('空 patch 被拦截（至少修改一项），且没有发出写入', calls('productBatchUpdate').length === 0);
    setVal(document.querySelector('.wb-mask .gd-batch select'), '7');
    await clickText('.wb-mask .wb-dialog__foot button', '应用到选中行');
    await waitFor(function () { return calls('productBatchUpdate').length === 1; }, 6000);
    var bu = calls('productBatchUpdate')[0];
    report('批量编辑一次覆盖 2 行', (bu.ids || []).length === 2, JSON.stringify(bu));
    report('批量编辑只带填了的字段（没填的绝不能带，否则会把类目/状态清空）',
      bu.supplierId === 7 && bu.category === undefined && bu.status === undefined && bu.note === undefined,
      JSON.stringify(bu));

    // ── 映射与关联：待关联队列 ────────────────────────────────────────
    step('queue');
    await clickText('.gd-tabs .gd-tab', '映射与关联');
    await waitFor(function () { return all('[data-act="queue-table"] tbody tr[data-item-id]').length === 3; }, 6000);
    report('队列渲染 3 行（2 待关联 + 1 店铺未归一）', true,
      'rows=' + all('[data-act="queue-table"] tbody tr[data-item-id]').length);
    var mstats = flat(document.querySelector('[data-act="map-stats"]'));
    report('统计条反映待办与阻塞，关联率分母用「组数」（未关联时为 0%，不是虚高）',
      /待关联 2/.test(mstats) && /店铺未归一 1/.test(mstats) && mstats.indexOf('0%（0/3）') >= 0, mstats);
    report('未归一店铺被点名（引导去「店铺登记」，而不是给个灰按钮就完事）',
      flat(document.querySelector('.gd-hints')).indexOf('新奇怪物店') >= 0 &&
        flat(document.querySelector('.gd-hints')).indexOf('店铺登记') >= 0,
      flat(document.querySelector('.gd-hints')).slice(0, 60));
    var blockedBtn = queueRow('TB-999').querySelector('[data-act="row-blocked"]');
    report('店铺未归一的行动作禁用且给出原因',
      !!blockedBtn && blockedBtn.disabled && flat(blockedBtn) === '需先登记店铺',
      blockedBtn ? flat(blockedBtn) + ' / disabled=' + blockedBtn.disabled : 'missing');
    var blockedCb = queueRow('TB-999').querySelector('input[type="checkbox"]');
    report('店铺未归一的行不可勾选（平台取不到，硬塞会把两家店并成一个键）', !!blockedCb && blockedCb.disabled);
    report('自动建议只作提示（疑似 Aurora Store），未自动落库',
      flat(queueRow('TB-999')).indexOf('疑似 Aurora Store（amazon）') >= 0, flat(queueRow('TB-999')));

    // ── 批量关联：必须一次提交，且每行带自己的店铺 ─────────────────────
    step('batch-map');
    var boxes = all('[data-act="queue-table"] tbody tr[data-item-id] input[type="checkbox"]').filter(function (c) { return !c.disabled; });
    report('可勾选行恰好 2 行', boxes.length === 2, 'boxes=' + boxes.length);
    boxes.forEach(function (b) { b.click(); });
    await waitFor(function () {
      return flat(document.querySelector('[data-act="queue-batch"]')).indexOf('批量关联选中 2 项') >= 0;
    }, 4000);
    await clickText('[data-act="queue-batch"]', '批量关联选中');
    await waitFor(function () { return all('.pk-item').length >= 2; }, 6000);
    var pkItems = all('.pk-item');
    var targetRadio = null;
    for (var pi = 0; pi < pkItems.length; pi++) {
      if (flat(pkItems[pi]).indexOf('S2') >= 0) targetRadio = pkItems[pi].querySelector('input[type="radio"]');
    }
    report('选择弹层列出产品且能定位到目标 S2', !!targetRadio, flat(document.querySelector('.pk-item')));
    targetRadio.click();
    await sleep(30);
    await clickText('.wb-mask .wb-dialog__foot button', '关联这 2 项');
    await waitFor(function () { return calls('productSkuMap').length >= 1; }, 6000);
    var maps = calls('productSkuMap');
    report('批量关联只发一次调用（不是逐条 N 次）', maps.length === 1, 'calls=' + maps.length);
    var sent = (maps[0] && maps[0].rows) || [];
    report('一次提交覆盖 2 行', sent.length === 2, 'rows=' + sent.length);
    report('每行带**自己的**店铺（串店会把别家店的商品ID 记到同一家名下）',
      !!sent[0] && sent[0].platform === 'shopee' && sent[0].shopId === 11 && sent[0].itemId === 'SKU-A1' &&
        !!sent[1] && sent[1].platform === 'amazon' && sent[1].shopId === 12 && sent[1].itemId === 'B0XYZ1234',
      JSON.stringify(sent));
    report('写入状态为已确认（才参与自动命中）',
      sent.every(function (r) { return r.status === 'confirmed' && r.productId === 2; }), JSON.stringify(sent));

    // ── 写入后队列**重拉**：已关联的组必须真的消失 ─────────────────────
    step('queue-reload');
    await waitFor(function () { return all('[data-act="queue-table"] tbody tr[data-item-id]').length === 1; }, 6000);
    report('关联后队列重拉，只剩未归一的 1 行（不是本地删行假装成功）', true);
    await waitFor(function () { return flat(document.querySelector('[data-act="map-stats"]')).indexOf('（2/3）') >= 0; }, 4000);
    report('关联率更新为 2/3', flat(document.querySelector('[data-act="map-stats"]')).indexOf('（2/3）') >= 0,
      flat(document.querySelector('[data-act="map-stats"]')));

    // ── 已建立映射：新行可见 / 标失效按 id / 改绑拉回已确认 ────────────
    step('mapped-tab');
    await clickText('[data-act="sub-mapped"]', '已建立映射');
    await waitFor(function () { return !!mappedRow('SKU-A1') && !!mappedRow('B0XYZ1234'); }, 6000);
    report('新写入的两条出现在「已建立映射」', true, 'rows=' + all('[data-act="mapped-table"] tbody tr[data-item-id]').length);

    step('invalidate');
    // 记下**点的那一行自己的** id 再点：断言"发出去的 id = 这一行的 id"，
    // 比写死一个种子 id 更强 —— 写死只能证明"发了个数"，证明不了"发的是对的那个"。
    var rowIdBefore = Number(mappedRow('SKU-A1').getAttribute('data-map-id'));
    mappedRow('SKU-A1').querySelector('[data-act="row-invalidate"]').click();
    await waitFor(function () { return all('.wb-mask .wb-dialog__head').length === 1; }, 4000);
    report('标失效有二次确认且说明"不物理删除 / 不再参与自动命中"',
      flat(document.querySelector('.wb-mask')).indexOf('不再参与自动命中') >= 0, flat(document.querySelector('.wb-mask')).slice(0, 40));
    await clickText('.wb-mask .wb-dialog__foot button', '确认标失效');
    await waitFor(function () { return calls('productSkuInvalidate').length === 1; }, 6000);
    report('标失效按 id 定位（不按商品ID 猜）',
      calls('productSkuInvalidate')[0].id === rowIdBefore,
      'sent=' + calls('productSkuInvalidate')[0].id + ' 该行=' + rowIdBefore);
    await waitFor(function () {
      var r = mappedRow('SKU-A1');
      return !!r && flat(r).indexOf('已失效') >= 0 && !!r.querySelector('[data-act="row-restore"]');
    }, 5000);
    report('行状态变为已失效且出现「恢复」入口', true, flat(mappedRow('SKU-A1')));

    step('rebind');
    // 先等"这一笔写完"（行内动作恢复可点）再点。
    // ⚠️ 不能在读完表格就立刻点：列表内容先刷新、「写入中」标记后置回 false，
    //    中间那一瞬按钮还是 disabled —— 冒烟把"禁用中"读成"点不动"就会误判成功能坏了。
    //    反过来这条等待本身也是个断言：写入完成后动作必须恢复可点（不能永久卡在禁用态）。
    await waitFor(function () {
      var b = mappedRow('SKU-A1') && mappedRow('SKU-A1').querySelector('[data-act="row-rebind"]');
      return !!b && !b.disabled;
    }, 5000).catch(function () {
      var b = mappedRow('SKU-A1') && mappedRow('SKU-A1').querySelector('[data-act="row-rebind"]');
      throw new Error('标失效写入完成后，改绑入口仍不可点（busy 卡住？）：disabled=' +
        (b ? b.disabled : 'missing') + '；界面错误=' + flat(document.querySelector('.wb-notice--error')));
    });
    report('写入完成后行内动作恢复可点（写入期间自己禁用才是对的）', true);
    mappedRow('SKU-A1').querySelector('[data-act="row-rebind"]').click();
    await waitFor(function () { return all('.pk-item').length >= 2; }, 6000)
      .catch(function () {
        // 失败时把观察到的现场带出来：光报 timeout 会让人去猜是弹层没开还是产品没读到
        throw new Error('改绑弹层未就绪：pk-item=' + all('.pk-item').length +
          ' mask=' + all('.wb-mask').length + ' 页面报错=' + JSON.stringify(window.__smokeErrors || []));
      });
    var pk2 = all('.pk-item');
    var r2 = null;
    for (var q = 0; q < pk2.length; q++) if (flat(pk2[q]).indexOf('S1') >= 0) r2 = pk2[q].querySelector('input[type="radio"]');
    if (!r2) throw new Error('改绑弹层里找不到产品 S1；列出=' + pk2.map(flat).join(' / '));
    r2.click();
    await sleep(30);
    await clickText('.wb-mask .wb-dialog__foot button', '改绑');
    await waitFor(function () { return calls('productSkuMap').length === 2; }, 6000)
      .catch(function () {
        throw new Error('改绑没发出第二次 skuMap：已发=' + calls('productSkuMap').length +
          ' 界面错误=' + flat(document.querySelector('.wb-notice--error')));
      });
    var sent2 = calls('productSkuMap')[1].rows || [];
    report('改绑只提交 1 行且换到新产品',
      sent2.length === 1 && sent2[0].itemId === 'SKU-A1' && sent2[0].productId === 1, JSON.stringify(sent2));
    report('改绑顺带把失效映射拉回已确认', sent2[0].status === 'confirmed', sent2[0].status);
    await waitFor(function () { return flat(mappedRow('SKU-A1')).indexOf('已确认') >= 0; }, 5000);
    report('改绑结果落到列表（已确认）', true, flat(mappedRow('SKU-A1')));

    // ── 供应商主数据──────────────────────────────────────────
    step('suppliers-tab');
    await clickText('.gd-tabs .gd-tab', '供应商');
    await waitFor(function () { return all('[data-act="supplier-table"] tbody tr[data-supplier-id]').length === 2; }, 6000);
    report('供应商列表渲染 2 行', true);
    // 厂A = 2：上面那次批量编辑把两款都划给了厂A，这一列**必须跟着变**（合并自 product.summary，
    // 不是这页自己的缓存值）。厂B = 0：0 要写 0，不能留空/显示「—」（会被读成"没读到"）。
    report('产品数列合并自 product.summary，且跟着 upstream 的改动走（厂A=2 / 厂B=0）',
      flat(document.querySelector('[data-supplier-id="7"] [data-act="s-count"]')) === '2' &&
        flat(document.querySelector('[data-supplier-id="8"] [data-act="s-count"]')) === '0',
      '厂A=' + flat(document.querySelector('[data-supplier-id="7"] [data-act="s-count"]')) +
        ' 厂B=' + flat(document.querySelector('[data-supplier-id="8"] [data-act="s-count"]')));
    document.querySelector('[data-supplier-id="7"] [data-act="s-edit"]').click();
    await waitFor(function () { return all('.wb-mask .sup-form').length === 1; }, 4000);
    report('编辑只放开电话/备注（名称是 UNIQUE 键，改它会让历史拿货单指向别处）',
      all('.wb-mask .sup-form input').length === 2 && !document.querySelector('[data-act="sup-name"]'),
      'inputs=' + all('.wb-mask .sup-form input').length);
    await clickText('.wb-mask .wb-dialog__foot button', '取消');

    // ── 商品清单（一件商品可一对多关联产品）──────────────────────────
    step('shop-products');
    await clickText('.gd-tabs .gd-tab', '商品清单');
    await waitFor(function () { return all('[data-act="shop-product-table"] tbody tr[data-item-id]').length === 2; }, 6000);
    report('商品清单渲染 2 行', true);
    function shopRow(id) { return document.querySelector('[data-act="shop-product-table"] tbody tr[data-item-id="' + id + '"]'); }
    report('有关联的显示「N 个产品」、没关联的显示「未关联」（不静默留空）',
      flat(shopRow('SKU-A1').querySelector('[data-act="sp-relations"]')).indexOf('1 个产品') >= 0 &&
        flat(shopRow('B0XYZ1234').querySelector('[data-act="sp-relations"]')).indexOf('未关联') >= 0,
      flat(shopRow('SKU-A1')));

    step('errors');
    report('无未捕获错误', (window.__smokeErrors || []).length === 0, JSON.stringify(window.__smokeErrors || []));
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

const dom = await new Promise((resolve, reject) => {
  const cp = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=45000', '--dump-dom', `http://127.0.0.1:${PORT}/index.html`]);
  let out = '';
  cp.stdout.on('data', (d) => (out += String(d)));
  cp.on('error', reject);
  cp.on('close', () => resolve(out));
});
server.close();

const m = dom.match(/id="smoke-result"[^>]*>([\s\S]*?)<\/pre>/);
if (!m) {
  console.error('✗ 没抓到 #smoke-result（页面可能没挂载）。排查：产物新鲜度（npm run build）→ 资源 404 → 内联脚本语法错 → 假桥缺键');
  process.exit(1);
}
const text = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
console.log(text);
const ok = text.split('\n').pop() === 'SMOKE: ALL PASS';
console.log(ok ? '\n✓ 货与成本页冒烟通过' : '\n✗ 货与成本页冒烟失败');
process.exit(ok ? 0 : 1);