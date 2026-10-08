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

  // 两个产品：P1 有两个 SKU（一个缺克重）**且有主图**、P2 一个 SKU；P2 未关联供应商**且无主图**。
  // 「有图 / 无图」两个样本都必须有：弹层与对比模式里"取图失败渲染空占位、而不是整列空掉"
  // 这条只有在同一屏里同时存在两种行时才抓得到（全是图的样本恒绿）。
  var PRODUCT_IMG = '/tmp/smoke-product-images/s1.webp';
  var PRODUCTS = [
    { id: 1, code: 'S1', name: '款一', supplierId: 7, supplierName: '厂A', category: '衣服', status: 'active', note: '', imageId: 1, imagePath: PRODUCT_IMG, createdAt: '', updatedAt: '' },
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
    { shopKey: 'hk 优品店', shopRaw: 'HK优品店', itemId: 'SKU-A1', itemKey: 'SKU-A1', title: '折叠收纳箱 60L 蓝色', orderCount: 37, shopId: 11, shopName: 'HK 优品店', platform: 'shopee', autoShopId: 0, autoShopName: '', autoShopPlatform: '', status: 'unmapped' },
    { shopKey: 'aurora store', shopRaw: 'Aurora Store', itemId: 'B0XYZ1234 ', itemKey: 'B0XYZ1234', title: 'Travel Organizer 8pcs', orderCount: 12, shopId: 12, shopName: 'Aurora Store', platform: 'amazon', autoShopId: 0, autoShopName: '', autoShopPlatform: '', status: 'unmapped' },
    { shopKey: '新奇怪物店', shopRaw: '新奇怪物店', itemId: 'TB-999', itemKey: 'TB-999', title: '未知商品', orderCount: 3, shopId: 0, shopName: '', platform: '', autoShopId: 12, autoShopName: 'Aurora Store', autoShopPlatform: 'amazon', status: 'shopUnresolved' },
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

  // 队列的图：图池只认**归一后**的商品ID。上面 B0XYZ1234 那行的订单原文故意带尾随空格
  // （订单报表里很常见），界面若拿原文去查池就查不到 —— 症状是那一列的图全变空占位且不报错。
  var ORDER_IMG = '/tmp/smoke-order-images/b0.webp';
  var THUMB_IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  var BIG_IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  // 产品图给**另外两张**（缩略图 / 原图各一）：对比模式要断言"左边真的是候选产品的主图"，
  // 两边都返回同一张 dataUrl 的话，这条断言恒绿 —— 图对不对永远不会被发现。
  var PROD_THUMB = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  var PROD_BIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  // 断言在**另一段** script 里（两段只共享 window）—— 挂出去它才拿得到
  window.__smokeImg = { order: ORDER_IMG, thumb: THUMB_IMG, big: BIG_IMG, prodThumb: PROD_THUMB, prodBig: PROD_BIG };
  var SEQ = 950;
  function keyOf(r) { return r.platform + '|' + r.shopId + '|' + r.itemId; }
  function productOf(id) {
    for (var i = 0; i < PRODUCTS.length; i++) if (PRODUCTS[i].id === id) return PRODUCTS[i];
    return null;
  }

  /**
   * 夹具复位：清掉本会话建立的映射 + 调用记录，回到"队列 3 行、无任何映射"的初始态。
   *
   * 为什么需要它：S3 之后「直连」「对比确认」「批量关联」三条动线**都要消耗那两行待关联商品**，
   * 而它们各自的断言都建立在"队列里有 2 行可勾选"这个初始态上。用一个夹具跑三个场景，
   * 就必须能回到原点 —— 否则只能删掉其中两个场景的断言（那才是真的降级）。
   *
   * ⚠️ 清的是 calls **这个对象本身的内容**，不是把 window.__smokeCalls 换成新对象：
   * 换掉之后 rec 仍往旧对象里写、断言读的却是新对象 —— 全场恒绿，而且不报错。
   */
  window.__smokeReset = function () {
    MAP = {};
    MAPPED = MAPPED.filter(function (m) { return m.id < 900; });
    for (var k in calls) delete calls[k];
  };

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
      // 空队列分支：仅当断言脚本把 window.__smokeEmptyQueue 打开时走（见 empty-entry 那一步）。
      // 默认分支必须保持"永远剩 1 行店铺未归一" —— 那是"未归一的行不可勾选、不可关联"的样本，
      // 置空它就等于把那条守卫一起关掉。
      if (window.__smokeEmptyQueue) {
        return { success: true, data: {
          rows: [],
          stats: {
            groups: 0, shown: 0, unmapped: 0, shopUnresolved: 0,
            mapped: Object.keys(MAP).length, withItemId: 0, withoutItemId: 0,
            truncated: false, unresolvedShops: [],
          },
        } };
      }
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
      // 反向过滤（产品侧「已关联商品」）：0/缺省 = 不过滤。
      // ⚠️ 桩必须**真的按 productId 过滤** —— 否则"展开哪个款都显示全部映射"这个静默错误
      // 在夹具里恒绿（界面拿到的永远是同一份 4 条），而线上每一款点开都会串。
      var pid = Number((p && p.productId) || 0);
      var list = MAPPED.filter(function (r) {
        if (pid && r.productId !== pid) return false;
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
      var out = { created: 0, updated: 0, reassigned: 0, adopted: 0, failed: [] };
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
      // 采纳款主图的张数由脚本按场景给（真实现里是主进程数的，判据在 product:sku:smoke /
      // ipc:shape:smoke；这里只负责让**界面**拿到一个非 0 / 0 的值，验回执说不说这句话）。
      out.adopted = Number(window.__smokeAdopt || 0);
      return { success: true, data: out };
    },
    'productSkuInvalidate': function (p) {
      rec('productSkuInvalidate', p);
      for (var i = 0; i < MAPPED.length; i++) if (MAPPED[i].id === p.id) MAPPED[i].status = 'invalid';
      return { success: true, data: { changed: true } };
    },
    /* ---- 商品ID 的图（三层回落：覆盖图 → 订单识别图 → 款主图）----
       只给**归一后**的 B0XYZ1234 一张订单图：界面若拿订单原文（带尾随空格）来查，
       命中不了 → 那一行变空占位 → 图断言变红。这正是队列侧最易犯的静默错误。 */
    'productItemImagePool': function (p) {
      rec('productItemImagePool', p);
      var asked = (p && p.itemIds) || [];
      var pool = {};
      for (var i = 0; i < asked.length; i++) {
        if (asked[i] === 'B0XYZ1234') {
          pool[asked[i]] = { override: null, order: [{ imageId: 1, localPath: ORDER_IMG }], product: null };
        }
      }
      return { success: true, data: { pool: pool } };
    },
    /* ⚠️ 假桥替换的是 **preload 那一层**，所以入参形状 = 渲染层传给 preload 的形状：
       ipc.ts 的拆批函数传的是**数组**（payload → items 的包装发生在 preload，这里被绕过了）。
       只认 { items } 会让本函数恒返回空数组 → 界面永远没有图，而且**不报错** ——
       上一版假桥正是只认 { items }，于是"图列真的能显示图"从来没被验证过。 */
    'orderImageThumbBatch': function (payload) {
      rec('orderImageThumbBatch', payload);
      var items = Array.isArray(payload) ? payload : (payload && payload.items) || [];
      return { success: true, data: { dataUrls: items.map(function (it) {
        var p = it && it.localPath;
        // 产品主图与订单图返回**不同**的缩略图：弹层里的产品图断言靠这个区分开
        if (p === ORDER_IMG) return THUMB_IMG;
        if (p === PRODUCT_IMG) return PROD_THUMB;
        return null;
      }) } };
    },
    /* 读原图（点开看大图 / 对比模式的候选图）：按路径返回**不同**的大图 ——
       若两边都回同一张，"对比模式左侧取的是产品主图"这条断言就恒绿（图对不对永远验不出来）。 */
    'orderReadImage': function (p) {
      rec('orderReadImage', p);
      var path = typeof p === 'string' ? p : (p && (p.localPath || p.path)) || '';
      return { success: true, data: { mime: 'image/png', dataUrl: path === PRODUCT_IMG ? PROD_BIG : BIG_IMG } };
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

    /* ---- 店铺商品清单（按 item_id 去重，一件商品可一对多关联产品）----
       ⚠️ 2026-10-08 起该页签在界面上**已收起**（产出没有下游消费方，见 GoodsView 的
       SHOP_PRODUCTS_TAB_ENABLED）。下面的桩**刻意保留**：数据层与 IPC 一行未删，
       恢复页签时这些桩就是现成夹具；删掉会让"放回来"变成"连测试一起重写"。 */
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
/** 当前挂在页面上的 toast 文本（toast 只停 2s，断言必须先 waitFor 它进 DOM 再读） */
function toastText() { return all('.wb-toast__text').map(function (e) { return flat(e); }).join(' | '); }
/**
 * 取**含 needle 的那条**回执（多条时取最后一条 = 最新）。
 * ⚠️ 不能拿 toastText()（全页合计）判一条回执的**有无**：本页是 --virtual-time-budget
 *    一次性跑完的，上一步的回执会一直留在 DOM 里 ⇒ 合计文本会把旧话也算进来，
 *    反向断言（"不许出现 X"）于是被上一步污染成恒红（正向的同类断言则会被污染成恒绿）。
 */
function lastToastWith(needle) {
  var ts = all('.wb-toast__text').map(function (e) { return flat(e); });
  var hit = null;
  for (var i = 0; i < ts.length; i++) if (ts[i].indexOf(needle) >= 0) hit = ts[i];
  return hit;
}
/** 图断言用的 dataUrl：由假桥那段脚本挂在 window 上（两段脚本不是同一作用域） */
var SMOKE_IMG = window.__smokeImg || { order: '', thumb: '', big: '' };
function productRows() { return document.querySelectorAll('[data-act="product-table"] tbody tr[data-product-id]'); }
function variantRows() { return document.querySelectorAll('[data-act="variant-table"] tbody tr[data-variant-id]'); }
function weightInput(rowIndex) {
  var rows = variantRows();
  return rows[rowIndex] ? rows[rowIndex].querySelector('[data-act="weight"]') : null;
}
/** 空安全的克重读法（子表/输入框不在时返回 null，而不是抛 TypeError 打断整段冒烟） */
function weightValue(rowIndex) {
  var el = weightInput(rowIndex);
  return el ? el.value : null;
}

/* ---- 迁入页签用到的通用小工具 ---- */
function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
/**
 * 有界轮询：最多等 ms 毫秒让条件成立；**超时也不抛**。
 *
 * 与 waitFor 的区别只有一条，但很关键：waitFor 超时会 reject ⇒ 整段冒烟在这一步中断，
 * 后面几十条断言一起被吞掉，读日志的人只看到 timeout、看不出是"多了"还是"少了"。
 * 断言前的"等它渲染出来"用本函数，把判定留给紧随其后的 report(...) ⇒ 失败报可读 FAIL。
 * （这条纪律来自本仓 2026-10-08 的实测教训：不要把断言本身写成等待条件。）
 */
async function settle(fn, ms) {
  var t0 = Date.now();
  while (!fn() && Date.now() - t0 < (ms || 3000)) await sleep(50);
}
function has(text) { return (document.body.innerText || '').indexOf(text) >= 0; }
/** 元素是否真的**可见**（display:none 时既没有 client rects，computed display 也是 none）。
    「两栏同屏」这类断言必须判可见性，不能只判 querySelector 找得到 —— 池栏容器是有意
    留在 DOM 里但 display:none 的（见 GoodsWorkbenchView.vue），只判存在等于恒真。 */
function isShown(el) {
  if (!el) return false;
  if (!el.getClientRects().length) return false;
  return getComputedStyle(el).display !== 'none';
}
function mapFlat(sel) { return all(sel).map(flat).join('/'); }
/** 队列行 / 映射行：必须**按所在表格**限定 —— [data-item-id] 是这一页三个视图共用的锚点
    （「商品清单」收起前它确实会串到那边去；收起后仍按表限定，免得页签放回来时又串）。 */
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

/**
 * 夹具复位（对应假桥段的 window.__smokeReset）。
 *
 * S3 之后「直连」「对比确认」「批量关联」三条动线**都要消耗**那两行待关联商品，而它们各自的
 * 断言都建立在"队列里有 2 行可勾选"这个初始态上。一个夹具跑三个场景，就得能回到原点 ——
 * 否则只能删掉其中两个场景的断言，那才是真的降级。
 */
async function resetFixture() {
  window.__smokeReset();
  await clickText('[data-act="map-refresh"]', '刷新');
  await settle(function () { return all('[data-act="queue-table"] tbody tr[data-item-id]').length === 3; }, 6000);
  return all('[data-act="queue-table"] tbody tr[data-item-id]').length === 3;
}

/**
 * 结果收尾：把 lines 汇总成最终判决 + 塞进 #smoke-result 供 runner 抓取。
 * 抽成函数是因为现在有两遍（宽视口跑全量 / 窄视口只跑视口守卫），两遍都要走同一套收尾。
 */
function finish() {
  var failed = lines.some(function (l) { return l.indexOf('FAIL') === 0 || l.indexOf('SMOKE: FAILED') === 0; });
  lines.push(failed ? 'SMOKE: FAILED' : 'SMOKE: ALL PASS');
  var pre = document.createElement('pre');
  pre.id = 'smoke-result';
  pre.textContent = lines.join('\\n');
  document.body.appendChild(pre);
}

/**
 * 窄视口守卫（第二遍：runner 用 --window-size 把视口压到 1180px 以下）。
 *
 * 全量断言只在宽视口跑一遍；这一遍**只验一件事**：窄窗口下两栏改为上下堆叠，
 * 而且**两栏都在**（不是把某一栏挤没）。方案 §9-1 的判据原话就是这一句 ——
 * 当年写 CSS 时把这条断言推到收口阶段，现在补上。
 *
 * ⚠️ 判据用 grid-template-columns 的**轨道个数**，不是"看起来像不像堆叠"：
 *    并排 = 两个轨道（如 "420px 960px"），堆叠 = 一个轨道（如 "1152px"）。
 *    这样顺带守住"把 grid 改成 flex、媒体查询从此失效"这类静默回归 ——
 *    那种改法在视觉上可能恰好也是堆叠，但断言会红，因为这条判的是**声明**不是观感。
 */
async function narrowViewportChecks() {
  step('viewport-narrow');
  await waitFor(function () { return document.querySelector('[data-act="goods-workbench"]'); }, 10000);
  await settle(function () { return all('[data-act="queue-table"] tbody tr[data-item-id]').length >= 1; }, 8000);
  var wb = document.querySelector('[data-act="goods-workbench"]');
  var cols = wb ? getComputedStyle(wb).gridTemplateColumns : '';
  report('窄窗口（视口 ' + window.innerWidth + 'px < 1180px）：两栏改为上下堆叠（grid 收成一列）',
    cols.split(' ').filter(function (s) { return s.length; }).length === 1, 'cols=' + cols);
  report('窄窗口下两栏**都还在**（堆叠，不是把某一栏挤没）',
    isShown(document.querySelector('[data-act="pane-products"]')) &&
      isShown(document.querySelector('[data-act="pane-pool"]')),
    'L=' + isShown(document.querySelector('[data-act="pane-products"]')) +
      ' R=' + isShown(document.querySelector('[data-act="pane-pool"]')));
  report('窄窗口下右栏队列仍在（"窄了"不是"少给点东西"的理由）',
    all('[data-act="queue-table"] tbody tr[data-item-id]').length >= 1,
    'rows=' + all('[data-act="queue-table"] tbody tr[data-item-id]').length);
}

async function main() {
  // ── 窄视口那遍：只跑视口守卫 ──────────────────────────────────────────
  // 全量断言在宽视口那遍跑（见 runner 的两次 spawn）。这里按视口宽度**自判**，
  // 所以 runner 不需要额外注入任何变量 —— 视口宽度本身就是判据。
  if (window.innerWidth < 1180) {
    try {
      await narrowViewportChecks();
    } catch (e) {
      lines.push('SMOKE: FAILED at [' + STEP + '] - ' + (e && e.message ? e.message : String(e)));
    }
    finish();
    return;
  }
  try {
    step('boot');
    await waitFor(function () { return document.querySelector('.gd-view'); }, 10000);
    report('挂载：货与成本页渲染', true);
    await waitFor(function () { return productRows().length >= 2; }, 8000);

    // ── 两栏工作台外壳（S0 建的锚点；S4 起恒两栏）─────────────────────────
    // 守着三件事：
    //   ① **两个栏容器恒在 DOM 里**（左产品 / 右商品池是同一屏的两半，少一个就等于"某一半没了"）；
    //   ② 左栏装的是真的产品表（不是个空壳）；
    //   ③ 池栏**首屏就激活**。
    // ⚠️ 第 ③ 条在 S4 之前是**反**的（当时断的是"池栏未激活、队列没被提前扫"）：那时首屏停在
    //    「产品」页签、池栏看不见，不想白付一次全量订单聚合。S4 把「产品」与「映射与关联」合成
    //    一个页签后**该前提消失** —— 进这一页就是进工作台，池栏上来就在屏幕上，那次聚合正是
    //    用户看得见的那一栏该做的事。于是懒挂载连同 pool 开关一起撤掉，这条断言也按同一理由
    //    反向。若哪天它又变成"没扫"，说明有人把两栏改回可隐藏了。
    step('workbench-shell');
    var shell = document.querySelector('[data-act="goods-workbench"]');
    var paneL = document.querySelector('[data-act="pane-products"]');
    var paneR = document.querySelector('[data-act="pane-pool"]');
    report('两栏外壳存在：goods-workbench + pane-products + pane-pool 三个锚点都在',
      !!shell && !!paneL && !!paneR);
    report('左栏装的是产品表（不是只有个空壳）',
      paneL && paneL.querySelectorAll('[data-act="product-table"] tbody tr[data-product-id]').length >= 2,
      'rows=' + (paneL ? paneL.querySelectorAll('[data-act="product-table"] tbody tr[data-product-id]').length : 'no-pane'));
    // 队列要等一拍才渲染（挂载后立刻发 IPC，下一轮才出表格）—— 用有界 settle，判定留给 report。
    await settle(function () { return document.querySelector('[data-act="pane-pool"] [data-act="queue-table"]'); }, 6000);
    report('池栏首屏就激活：队列已渲染、且确实扫过一次订单（合并页签后池栏始终可见，懒挂载的前提没了）',
      !!document.querySelector('[data-act="pane-pool"] [data-act="queue-table"]') &&
        calls('productSkuQueue').length >= 1,
      'queueCalls=' + calls('productSkuQueue').length);
    // 宽视口下两栏是**并排**：grid-template-columns 的计算值有**两个**轨道。
    // 窄视口那半边（1180px 以下改为上下堆叠）由脚本末尾的第二遍单独验 —— 见 viewport-narrow。
    var wbCols = getComputedStyle(shell).gridTemplateColumns;
    report('宽视口两栏并排（grid 两列；不是某一栏被挤没、也不是叠成上下）',
      wbCols.split(' ').filter(function (s) { return s.length; }).length === 2,
      'cols=' + wbCols);

    // ── 页首两层已撤（2026-10-08）—— 反向守卫 ────────────────────────────
    // "删掉的能力"必须留一条"不再有它"的断言：指标条与引导条是**整块撤掉**，不是被替换。
    // 若哪天有人以"少了个总览 / 少了个引导"的名义加回来，页首又会多出两行只占高度、
    // 不带来新信息的横条。数字的用途没丢（每行自带 n·缺 m 与状态列），顺序由页签本身回答。
    step('no-banner');
    report('页首不再有指标条（产品 / SKU / 缺克重 / 未关联供应商 / 已映射商品ID 那一行）',
      !document.querySelector('[data-act="stats"]') &&
        !document.querySelector('[data-act="metric-products"]') &&
        !document.querySelector('[data-act="metric-missing"]'));
    report('页首不再有起点引导条（立款 → 补克重 → 认货）',
      !document.querySelector('[data-act="guide"]') && !document.querySelector('[data-act="guide-go"]'));
    report('页签上不再挂数字徽标（徽标与被撤的指标条同源，留着就要保留整套页级汇总取数）',
      !document.querySelector('.gd-tab__badge'));

    // ── 问题件筛选：入口搬到左栏工具栏（指标条撤掉后，这是两个筛选的唯一入口）──
    // 值得守两次：① **入口还在不在**（撤指标条最容易顺手把入口一起撤掉，那两个筛选就成死能力）；
    //            ② **点下去真的会筛**（只切控件不筛，正是这一页刚删掉的那种假动作）。
    step('issue-filter');
    function issueSel() { return document.querySelector('[data-act="filter-issue"]'); }
    report('左栏工具栏有「问题件」下拉（缺克重 / 未关联供应商的唯一入口）', !!issueSel());
    setVal(issueSel(), 'missingWeight');
    // 等"筛选生效"的渲染信号 + 列表重拉落地，**两个都不抛** —— 判定在下面 report 里，
    // 筛选没生效时报的是可读 FAIL（rows=2），不是把后面几十条一起吞掉的 timeout。
    await settle(function () { return !!document.querySelector('[data-act="active-filters"]'); }, 4000);
    await settle(function () { return productRows().length === 1; }, 4000);
    report('选「缺克重」→ 产品列表筛到 1 款（P1 有个 SKU 没克重，P2 不该出现）',
      productRows().length === 1 && flat(productRows()[0].querySelector('[data-act="p-code"]')) === 'S1',
      'rows=' + productRows().length);
    report('筛窄是靠发参数给主进程，不是界面自己过滤',
      calls('productList').some(function (p) { return p && p.onlyMissingWeight === true; }),
      JSON.stringify(calls('productList').slice(-1)[0]));
    report('出现活跃筛选 chip（下拉看不出"哪些条件正在生效"，chip 补齐这一环）',
      mapFlat('[data-act="active-filters"] .gd-chip').indexOf('只看缺克重') >= 0,
      mapFlat('[data-act="active-filters"] .gd-chip'));
    document.querySelector('[data-act="chip-missing"]').click();
    await settle(function () {
      return productRows().length === 2 && !document.querySelector('[data-act="active-filters"]');
    }, 4000);
    report('点 chip 的 × → 撤掉该条件，列表回到 2 款、活跃筛选行整行消失',
      productRows().length === 2 && !document.querySelector('[data-act="active-filters"]'),
      'rows=' + productRows().length);
    report('撤掉条件后下拉也回到「全部款式」（单一真源，不会留下"下拉还显示缺克重"）',
      !!issueSel() && issueSel().value === '', 'value=' + (issueSel() ? issueSel().value : 'missing'));

    // ── 工具栏的形状（守"别再加回去"）──
    step('toolbar-shape');
    var toolbarText = flat(document.querySelector('.gd-toolbar'));
    report('工具栏不再重复「下载模板」（导入弹层里已有，且那里文案更贴场景）',
      toolbarText.indexOf('下载模板') < 0, toolbarText);
    // ⚠️ 这条原先断言的是**反**的："工具栏不该有「只看…」开关"（理由：入口统一在顶部指标条）。
    //    2026-10-08 指标条撤掉、入口搬进工具栏后，理由反转 ⇒ 改成断正：它必须**在**。
    report('工具栏有「问题件」入口（指标条撤掉后唯一入口，别当成重复控件删掉）',
      !!document.querySelector('.gd-toolbar [data-act="filter-issue"]'), toolbarText);

    step('products');
    // 2026-10-01 界面重设计后：产品表加了「勾选/主图」两列，**列数会变**，
    // 所以断言从「按位置整行」升级为「按 data-act 逐元素」——被断言的文本值一个字不改，
    // 但不再把「表格有哪几列」当成契约（那是布局，不是数据）。
    function cellOf(act, rowIndex) {
      var row = productRows()[rowIndex];
      var el = row && row.querySelector('[data-act="' + act + '"]');
      return el ? flat(el) : null;
    }
    function detail() { return document.querySelector('[data-act="row-detail"]'); }
    function detailCell(act) {
      var d = detail();
      var el = d && d.querySelector('[data-act="' + act + '"]');
      return el ? flat(el) : null;
    }
    var p1 = {
      code: cellOf('p-code', 0), name: cellOf('p-name', 0),
      sku: cellOf('p-sku', 0), missing: cellOf('missing-weight-cell', 0),
    };
    report('产品表主列：款编码 / 款式名 + 每款 SKU 数与缺克重数',
      p1.code === 'S1' && p1.name === '款一' && p1.sku === '2' && p1.missing === '1',
      JSON.stringify(p1));
    // 反向守卫：主表**不该**再有供应商/类目列 —— 分栏之后栏宽有限，这两列（外加"操作"）
    // 移进了行展开（方案 §7-1）。哪天有人"顺手"把它们加回主表，紧凑列表就白裁了，
    // 而症状是"左边那栏又开始横向挤"这种没人会当成 bug 的样子。
    report('主表不再塞供应商/类目列（移进行展开；加回来等于没裁）',
      !productRows()[0].querySelector('[data-act="p-supplier"]') &&
        !productRows()[0].querySelector('[data-act="p-category"]'));
    // 0 必须写 0：旧写法 missingOf(p.id) || '-' 把"这款不缺"渲染成「—」，用户读成"没生效"（2026-10-01 实报）
    var p2missing = productRows()[1].querySelector('[data-act="missing-weight-cell"]');
    report('缺克重为 0 时显示 0，不是「—」（— 会被读成"没有数据"）',
      !!p2missing && flat(p2missing) === '0', 'cell=' + (p2missing ? flat(p2missing) : 'none'));

    // ── 行展开（S1 新增）：SKU 与"选中之后才关心"的东西都在这里 ──────────
    // 为什么值得守：列裁剪把供应商/类目/SKU 子表/SKU 改克重全搬进了展开区 ——
    // 搬丢任何一样，界面上不会报错，只会"某个信息再也找不到"。
    step('row-expand');
    report('默认没有展开区：详情是"点出来的"（常驻会把紧凑列表撑回宽表）',
      !detail(), 'detail=' + !!detail());
    productRows()[0].querySelector('[data-act="row-expand"]').click();
    await waitFor(function () { return !!detail(); }, 4000);
    report('点 row-expand → row-detail 出现', !!detail());
    report('展开区里给出供应商 / 类目（主表放不下的那两列）',
      detailCell('p-supplier') === '厂A' && detailCell('p-category') === '衣服',
      'supplier=' + detailCell('p-supplier') + ' category=' + detailCell('p-category'));
    report('展开区里有 SKU 子表，列出这款的两个 SKU',
      variantRows().length === 2 && flat(variantRows()[0]).indexOf('黑 L') >= 0,
      Array.prototype.map.call(variantRows(), flat).join(' / '));

    // ── 已关联商品：按款**反查**（只读）────────────────────────────────
    // 这是"数据模型里产品挂在商品上"这件事第一次在**产品侧**有入口。两条口径必须同时钉：
    //   ① 反查必须带 productId（不带 = 每一款点开都显示全库映射，且不报错）；
    //   ② 失效的映射**不能**混进"已关联"（混进来用户会以为那个商品还在用）。
    step('detail-links');
    // 先等它**渲染出来**再断言条数（别把断言本身写成 waitFor 的条件）：
    // 条数不对时要报一条可读的 FAIL，而不是让整个冒烟在这一步超时中断 —— 后者会把后面
    // 几十条断言一起吞掉，读日志的人只看到"timeout"，看不出是「多了」还是「少了」。
    await waitFor(function () {
      return document.querySelectorAll('[data-act="detail-links"] [data-act="detail-link"]').length >= 1;
    }, 6000);
    report('展开区列出这款已关联的店铺商品（2 条 confirmed）',
      document.querySelectorAll('[data-act="detail-links"] [data-act="detail-link"]').length === 2 &&
        flat(document.querySelector('[data-act="detail-links"]')).indexOf('SKU-OLD') >= 0,
      flat(document.querySelector('[data-act="detail-links"]')));
    report('反查请求带上了 productId（不带的话每一款点开都显示全库映射）',
      calls('productSkuList').some(function (x) { return x && x.productId === 1; }),
      JSON.stringify(calls('productSkuList').slice(-1)[0]));
    report('已关联区是**只读**的：没有任何解除/删除按钮（硬删会让关联率莫名回落）',
      !document.querySelector('[data-act="detail-links"] button'),
      flat(document.querySelector('[data-act="detail-links"]')).slice(0, 40));
    // 值的读法要**空安全**：SKU 子表整个不见了的时候，weightInput(i).value 会抛
    // TypeError 把整段冒烟打断，读日志的人只看到"异常"，看不出是"子表没了"。
    report('克重已填的显示数值、未填的留空（0 不当成有效克重）',
      weightValue(0) === '320' && weightValue(1) === '',
      'v0=' + weightValue(0) + ' v1=' + weightValue(1));

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
    // 指标条撤了，改断言**那一行自己的**缺克重格归零 —— 这才是这条断言真正要守的：
    // 保存后界面必须立刻反映出来（不能等下次刷新），顺带覆盖"行内计数是活的"。
    await waitFor(function () { return cellOf('missing-weight-cell', 0) === '0'; }, 6000);
    report('保存后该行的缺克重计数实时归零（不是等下次刷新）',
      cellOf('missing-weight-cell', 0) === '0', cellOf('missing-weight-cell', 0));
    report('界面给出保存回执（不只是一闪而过的 toast）',
      flat(document.querySelector('[data-act="saved"]')).indexOf('黑 M') >= 0,
      flat(document.querySelector('[data-act="saved"]')));

    step('switch');
    productRows()[1].click();
    await waitFor(function () {
      var rows = variantRows();
      return rows.length === 1 && flat(rows[0]).indexOf('白 XL') >= 0;
    }, 6000);
    report('展开另一个款 → SKU 子表跟着换（不是"永远显示第一个款"）', true, flat(variantRows()[0]));
    report('未关联供应商的款显示「(未关联)」（不静默留空）',
      detailCell('p-supplier') === '(未关联)', 'supplier=' + detailCell('p-supplier'));
    // S2 这个款有 2 条映射：1 条 confirmed + 1 条 invalid。夹具刻意留了这条失效行 ——
    // 只有"同款既有生效又有失效"的样本才抓得到"把失效也算成已关联"这种静默错账。
    await waitFor(function () {
      return flat(document.querySelector('[data-act="detail-links"]')).indexOf('B0OLD') >= 0;
    }, 6000);
    report('失效的映射**不混进**「已关联」：列表里只有那 1 条 confirmed',
      document.querySelectorAll('[data-act="detail-links"] [data-act="detail-link"]').length === 1 &&
        flat(document.querySelector('[data-act="detail-links"]')).indexOf('B0OLD0002') >= 0 &&
        flat(document.querySelector('[data-act="detail-links"]')).indexOf('B0OLD0001') < 0,
      flat(document.querySelector('[data-act="detail-links"]')));
    report('失效的那条**单列**说明（"被裁掉"和"不存在"必须长得不一样）',
      flat(document.querySelector('[data-act="detail-links-invalid"]')).indexOf('1 条已失效') >= 0,
      flat(document.querySelector('[data-act="detail-links-invalid"]')));

    /* ======================================================================
       产品库岛的功能已整体收回内建（2026-10-01，岛本身一并下架）。以下断言
       **逐条从该岛原先的 UI 冒烟搬过来**（那个脚本随岛一起下线了），口径一条都没放宽 ——
       岛下架后这批契约（批量关联一次提交 / 不串店 / 未归一不可点 / 失效按 id 定位 /
       部分 patch 不带空字段）必须继续有人守，否则"迁移"就变成"功能静默降级"。
       ====================================================================== */
    step('tabs');
    var tabNames = mapFlat('.gd-tabs .gd-tab');
    // S4（2026-10-08）：页签由 3 个收成 2 个 ——「产品」与「映射与关联」合并为「建档与关联」。
    // 合并的判据不是"少一个页签更清爽"，而是分栏的价值全在**同屏**：分成两个页签，
    // 左栏选款 → 右栏直连 / 对比这两条动线在物理上就不成立。断言口径跟着改：
    // 两个都在 + 默认停在合并后的那个 + 旧的两个名字与它们的 data-act 都必须消失。
    report('两个页签都在（「产品」+「映射与关联」已合并为「建档与关联」），且默认停在它',
      ['建档与关联', '供应商'].every(function (n) { return tabNames.indexOf(n) >= 0; }) &&
        all('.gd-tabs .gd-tab').length === 2 &&
        flat(document.querySelector('.gd-tabs .gd-tab.is-active')).indexOf('建档与关联') === 0,
      tabNames);
    // 反向守卫：合并后**不许**再冒出「产品」/「映射与关联」两个旧页签 —— 它们一回来，用户又得
    // 在两个页签之间来回切、看不到同屏的两栏，正是这次重构要消掉的东西。
    // 同时 data-act 必须真的迁到 tab-workbench：只换名字不换选择器的话，任何按旧名定位的东西
    // （包括本脚本的历史版本、外部自动化）会**静默点空** —— 点了没反应，最难查。
    report('旧页签不再存在（「产品」/「映射与关联」两个名字与它们的 data-act 都必须消失）',
      tabNames.indexOf('产品') < 0 && tabNames.indexOf('映射与关联') < 0 &&
        !!document.querySelector('[data-act="tab-workbench"]') &&
        !document.querySelector('[data-act="tab-products"]') &&
        !document.querySelector('[data-act="tab-mappings"]'),
      tabNames);
    // 反向守卫：「商品清单」2026-10-08 收起（判据是"产出没有下游消费方" —— 它写的池行
    // 只有 electron/shop-product-db.ts 自己读，订单归款走的是它的补集谓词）。
    // 删掉的能力必须留一条"不再有它"的断言，否则它会以"补个入口吧"的名义回来，
    // 而它正是这页里唯一"做什么都不影响任何事"的页签（会让人以为少做了这一步所以后面算不出来）。
    // 恢复方法写在 GoodsView.vue 的 SHOP_PRODUCTS_TAB_ENABLED 上。
    report('「商品清单」页签已收起（产出无下游消费方，别再放回来）',
      tabNames.indexOf('商品清单') < 0 && !document.querySelector('[data-act="tab-shop-products"]'),
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
    // S4 起不再需要"切到映射视图"：合并页签后首屏就是工作台，队列已经在屏幕上。
    // 这里仍显式点一次自己所在的页签（幂等），为的是"默认页签被改错"时能把页面扳回来，
    // 而不是让后面几十条断言集体因为"页面停在别处"而失败、把真正的原因埋掉。
    await clickText('.gd-tabs .gd-tab', '建档与关联');
    // 等它渲染出第一行即可，**行数判定留给 report**：条数不对时报可读 FAIL（rows=9），
    // 而不是让 waitFor 超时中断、把后面几十条断言一起吞掉（2026-10-08 的实测教训）。
    await settle(function () { return all('[data-act="queue-table"] tbody tr[data-item-id]').length >= 1; }, 6000);
    report('队列渲染 3 行（2 待关联 + 1 店铺未归一）',
      all('[data-act="queue-table"] tbody tr[data-item-id]').length === 3,
      'rows=' + all('[data-act="queue-table"] tbody tr[data-item-id]').length);
    // 两栏**同屏且有内容** —— 这是重构相对旧形态的**新增能力**：
    // 旧形态下"产品表"与"待关联队列"分属两个页签，永远不可能同时出现在屏幕上。
    // ⚠️ 判可见性而不是只判存在：合并页签前池栏容器是"有意留在 DOM 里但 display:none"的，
    //    只判 querySelector 找得到等于恒真（那条坑正是这条断言最早要抓的）。
    report('两栏同屏：左栏产品表 + 右栏队列都可见（S4 合并页签后首屏即如此）',
      isShown(document.querySelector('[data-act="pane-products"] [data-act="product-table"]')) &&
        isShown(document.querySelector('[data-act="pane-pool"] [data-act="queue-table"]')),
      'L=' + isShown(document.querySelector('[data-act="pane-products"]')) +
        ' R=' + isShown(document.querySelector('[data-act="pane-pool"]')));
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

    // ── S2 反向守卫：队列里**不**渲染已关联行 ──────────────────────────
    // 队列是"实时聚合订单再减去生效映射"，不是缓存表。若哪天有人"顺手"把已关联行也留在池里
    // （看着更完整），池子会随时间无限增长，而且"关联完就从队列消失"这个**唯一的完成信号**就没了。
    // 夹具的 MAPPED 四条与 QUEUE 三条**无交集**（都是已经没有订单的历史映射）—— 正好用它们互证。
    // 另：右栏（PoolPane）按方案 §7-2 裁了列（平台折进店铺格、状态折进行态），
    //     再拆回独立列就等于没裁 —— 一条反向守卫钉住，理由同下面工具栏的 toolbar-shape。
    step('queue-not-mapped');
    var qIds = all('[data-act="queue-table"] tbody tr[data-item-id]').map(function (r) {
      return String(r.getAttribute('data-item-id')).trim();
    });
    report('队列里不出现已建立映射的商品（队列 = 订单聚合 − 生效映射，不是缓存表）',
      ['SKU-OLD', 'SKU-OLD2', 'B0OLD0001', 'B0OLD0002'].every(function (id) { return qIds.indexOf(id) < 0; }),
      'queue=' + JSON.stringify(qIds));
    var qHeadTrim = all('[data-act="queue-table"] thead th').map(function (t) { return flat(t); });
    report('队列列已裁：平台 / 状态不再是独立列（分别折进店铺格与行态，见方案 §7-2）',
      qHeadTrim.indexOf('平台') < 0 && qHeadTrim.indexOf('状态') < 0, qHeadTrim.join('|'));

    // ── 队列的图：订单里已有的图必须自动出现在认款界面 ────────────────
    // 认款只能靠肉眼比图（订单里没有任何字段能推出"这是哪一款"），所以这一列是**功能**不是装饰。
    // 图直接来自订单（itemImagePool 的第 ② 层），用户不需要另准备任何文件。
    step('queue-thumbs');
    var qHead = all('[data-act="queue-table"] thead th').map(function (t) { return flat(t); });
    report('队列表有「图」列', qHead.indexOf('图') >= 0, qHead.join('|'));
    // 选择器钉在**归一键**上：夹具里那一行的订单原文是 'B0XYZ1234 '（带尾随空格），
    // 界面若拿原文当键，这个元素根本不会挂出来 —— 图那侧最易犯的静默错误就此变红。
    // 合批取图：别退化成"每行一次 IPC"（那会把整列拖卡）。
    // ⚠️ 只能数"请求里含这张订单图的那几次"，**不能**数全局次数：左栏产品列表走的是
    //    同一条通道（image-thumb-batch），全局计数会被它污染成恒红 —— 那这条断言就成噪音了。
    var orderThumbCalls = calls('orderImageThumbBatch').filter(function (arg) {
      var items = Array.isArray(arg) ? arg : (arg && arg.items) || [];
      return items.some(function (it) { return it && it.localPath === SMOKE_IMG.order; });
    });
    report('缩略图是合批取的（队列只发了一次取图请求，不是每行一次 IPC）',
      orderThumbCalls.length === 1, 'calls=' + orderThumbCalls.length);
    var b0Thumb = document.querySelector('[data-act="q-thumb"][data-thumb-key="B0XYZ1234"]');
    report('订单原文带空格的那一行照样有图（查图用归一键，不是订单原文）',
      !!b0Thumb && !!b0Thumb.querySelector('img'), b0Thumb ? 'found' : 'missing');
    report('缩略图真的装了订单图（不是挂个空 src 占位）',
      !!b0Thumb && b0Thumb.querySelector('img').getAttribute('src') === SMOKE_IMG.thumb,
      b0Thumb ? String(b0Thumb.querySelector('img').getAttribute('src')).slice(0, 40) : 'missing');
    report('图注标出来源（认款时要能知道这张图是哪来的）',
      !!b0Thumb && String(b0Thumb.getAttribute('title')).indexOf('订单') >= 0,
      b0Thumb ? b0Thumb.getAttribute('title') : 'missing');
    report('订单里没图的商品显示空占位，不是破图（有图 / 没图要能分开看）',
      !!queueRow('SKU-A1').querySelector('[data-act="q-thumb-empty"]') &&
        !queueRow('SKU-A1').querySelector('[data-act="q-thumb"]'));

    // 点开看大图：缩略图只有 160px 边，认印花 / 领型 / 颜色必须能看原图
    step('queue-viewer');
    b0Thumb.click();
    await waitFor(function () { return !!document.querySelector('[data-act="img-viewer"]'); }, 4000);
    await waitFor(function () {
      var im = document.querySelector('[data-act="img-viewer"] img');
      return !!im && im.getAttribute('src') === SMOKE_IMG.big;
    }, 4000);
    report('点缩略图打开看图弹层，且弹层里是**原图**（不是把缩略图放大充数）',
      document.querySelector('[data-act="img-viewer"] img').getAttribute('src') === SMOKE_IMG.big,
      String(document.querySelector('[data-act="img-viewer"] img').getAttribute('src')).slice(0, 40));
    await clickText('[data-act="viewer-close"]', '关闭');
    await waitFor(function () { return !document.querySelector('[data-act="img-viewer"]'); }, 4000);
    report('关闭后弹层真的消失（不留一个遮罩挡住整页）',
      !document.querySelector('[data-act="img-viewer"]'));

    // ── 直连（S3）：左栏展开的款 → 右栏勾选的商品，一步落地 ────────────
    // 这是分栏相对旧形态的**新增能力**：款与商品同屏，看一眼就知道该落到哪一款，
    // 不必再"勾商品 → 开弹层 → 搜款 → 选"那四步（方案 §2.2 动线 B）。
    //
    // 夹具的辨别力：左栏此刻展开的是 **S2（id=2）**，而产品列表第一行是 S1（id=1）——
    // 把 productId 写死成"第一行的 id"的实现在这里必红（方案 §8-3 变异 4 钉的就是这条）。
    step('relate');
    var relateBtn = document.querySelector('[data-act="relate-to-selected"]');
    report('左栏展开一款后右栏才出现直连入口，且写明落到哪一款',
      !!relateBtn && flat(relateBtn).indexOf('S2') >= 0,
      relateBtn ? flat(relateBtn) : 'missing');
    report('没勾选任何商品时直连不可点（没有待办就不该点得动）',
      !!relateBtn && relateBtn.disabled);
    var rBoxes = all('[data-act="queue-table"] tbody tr[data-item-id] input[type="checkbox"]').filter(function (c) { return !c.disabled; });
    report('直连前可勾选行恰好 2 行（与批量关联看到的同一批）', rBoxes.length === 2, 'boxes=' + rBoxes.length);
    rBoxes.forEach(function (b) { b.click(); });
    await sleep(60);
    report('直连按钮把"落到哪一款 + 认几项"都写在脸上',
      flat(relateBtn).indexOf('（2 项）') >= 0, flat(relateBtn));
    relateBtn.click();
    await waitFor(function () { return calls('productSkuMap').length >= 1; }, 6000);
    var direct = calls('productSkuMap')[0].rows || [];
    report('直连一次提交勾选的 2 行（不是逐条调）', direct.length === 2, 'rows=' + direct.length);
    // ⭐ 这条是 S3 最锋利的一条：写死"第一行产品"的实现会在这里红（夹具第一行是 S1 / id=1）
    report('⭐ 直连落到**左栏展开的那一款**（S2 / id=2），不是产品列表的第一行（S1 / id=1）',
      direct.length === 2 && direct.every(function (r) { return r.productId === 2; }),
      JSON.stringify(direct));
    report('直连不带颜色（spec 落 * —— 没机会选色就不替用户猜一个）',
      direct.every(function (r) { return r.spec === '*'; }),
      JSON.stringify(direct.map(function (r) { return r.spec; })));
    await settle(function () { return all('[data-act="queue-table"] tbody tr[data-item-id]').length === 1; }, 6000);
    report('直连写完队列重拉：刚认下的两行从池里消失（与弹层关联同一条写路径）',
      all('[data-act="queue-table"] tbody tr[data-item-id]').length === 1,
      'rows=' + all('[data-act="queue-table"] tbody tr[data-item-id]').length);
    // 反向守卫：「当前款」= 用户**真的展开过**的那一行，不是"自动选中的第一行"。
    // useProductList 的 selectedId 一进页面就指向第一行（整宽形态的详情面板需要它）。
    // 若拿它当当前款，用户**没选任何款**时右栏也会挂着一个"看起来已经选好"的落点 ——
    // 照着点就是写错款，而且事后看不出是系统替他选的。收起展开行必须让入口一起消失。
    productRows()[1].querySelector('[data-act="row-expand"]').click();
    await settle(function () { return !document.querySelector('[data-act="relate-to-selected"]'); }, 3000);
    report('收起展开行 → 直连入口随之消失（没有可见的落点，就不给入口）',
      !document.querySelector('[data-act="relate-to-selected"]'),
      'btn=' + !!document.querySelector('[data-act="relate-to-selected"]'));
    // 再展开回来：入口要能恢复（下一个场景的对比模式还要用它当初始候选）
    productRows()[1].querySelector('[data-act="row-expand"]').click();
    await settle(function () { return !!document.querySelector('[data-act="relate-to-selected"]'); }, 3000);
    report('重新展开 → 直连入口恢复',
      !!document.querySelector('[data-act="relate-to-selected"]'),
      flat(document.querySelector('[data-act="relate-to-selected"]')));

    // ── 夹具复位：上面那条动线把两行待关联商品消耗掉了 ──────────────
    step('reset');
    report('夹具复位：队列回到 3 行（直连消耗掉的两行回来了，后续场景各自从干净态开始）',
      await resetFixture(), 'rows=' + all('[data-act="queue-table"] tbody tr[data-item-id]').length);

    // ── 对比模式（S3）：候选产品 × 店铺商品，同屏放大，键盘定夺 ──────────
    // 为什么需要它：队列的图是"这件在订单里的样子"，而"这是不是那款"只有把两边的图**摆在一起**
    // 才判断得了 —— 40px 缩略图 + 表格排布时，人是在两个屏幕之间用记忆比。
    //
    // 两条口径必须同时钉：
    //   ① 左侧是**候选产品自己的主图**（独立取图）；队列是"还没配映射"的一半，
    //      itemImagePool 的产品层对它必然为空 —— 拿图池当候选图会得到一片空白且不报错
    //      （方案 §8-3 变异 5）；
    //   ② 键盘 ←/→ 换候选、空格 确认、Esc 关闭，三键都得真的接上。
    step('compare');
    // 按前缀定位：那一行的 itemId 是订单**原文**（夹具里带尾随空格），写死全串会找不到
    document.querySelector('[data-act="queue-table"] tbody tr[data-item-id^="B0XYZ1234"] [data-act="row-compare"]').click();
    await waitFor(function () { return !!document.querySelector('[data-act="compare-modal"]'); }, 5000);
    var cmpItem = document.querySelector('[data-act="compare-item-img"]');
    report('对比模式打开：左候选产品 + 右店铺商品同屏',
      !!document.querySelector('[data-act="compare-modal"] [data-act="compare-side-left"]'),
      flat(document.querySelector('[data-act="compare-modal"] .wb-dialog__head')));
    report('右侧取的是这件商品的订单图（复用队列那一列的图，不重新取一次）',
      !!cmpItem && cmpItem.getAttribute('src') === SMOKE_IMG.thumb,
      cmpItem ? String(cmpItem.getAttribute('src')).slice(0, 44) : 'missing');
    report('初始候选就是左栏展开的那一款（S2）—— 多半已经是最接近的猜测',
      flat(document.querySelector('[data-act="compare-modal"] .wb-dialog__head')).indexOf('2 / 2') >= 0,
      flat(document.querySelector('[data-act="compare-modal"] .wb-dialog__head')));
    // 夹具里 S2 **刻意没有主图** —— 左侧这时必须是"说得出来的空占位"（并告诉你下一步怎么办），
    // 不是一片空白、也不是破图。图取不到与"这款就没有图"在界面上要分得开。
    var cmpEmpty = document.querySelector('[data-act="compare-product-empty"]');
    report('候选款没有主图时：左侧给出空占位 + 下一步（不是一片空白）',
      !!cmpEmpty && flat(cmpEmpty).indexOf('换下一款') >= 0, cmpEmpty ? flat(cmpEmpty) : 'missing');
    // ← 换到 S1（有主图）
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'ArrowLeft', bubbles: true }));
    await settle(function () {
      var im = document.querySelector('[data-act="compare-product-img"]');
      return !!im && im.getAttribute('src') === SMOKE_IMG.prodBig;
    }, 5000);
    var cmpProd = document.querySelector('[data-act="compare-product-img"]');
    report('按 ← 换候选（候选集属于产品库，不是"永远同一款"）',
      flat(document.querySelector('[data-act="compare-modal"] .wb-dialog__head')).indexOf('1 / 2') >= 0,
      flat(document.querySelector('[data-act="compare-modal"] .wb-dialog__head')));
    report('⭐ 左侧取的是**候选产品自己的主图**（独立取图，不是把商品图复制一份）',
      !!cmpProd && cmpProd.getAttribute('src') === SMOKE_IMG.prodBig,
      cmpProd ? String(cmpProd.getAttribute('src')).slice(0, 44) : 'missing');
    window.dispatchEvent(new KeyboardEvent('keydown', { key: ' ', bubbles: true }));
    await waitFor(function () { return calls('productSkuMap').length >= 1; }, 6000);
    var cmpSent = calls('productSkuMap')[0].rows || [];
    report('空格 = 确认关联，写的是**当前候选**（← 之后停在 S1 / id=1）',
      cmpSent.length === 1 && cmpSent[0].productId === 1, JSON.stringify(cmpSent));
    await waitFor(function () { return !document.querySelector('[data-act="compare-modal"]'); }, 4000);
    report('确认后弹层自动关闭（不用再点一次「关闭」）',
      !document.querySelector('[data-act="compare-modal"]'));
    // Esc 关闭：再开一次专门验它（上面那次是被"确认"关掉的，验不到 Esc）。
    // ⚠️ 必须先等写入落地（行内动作恢复可点）再点：写入期间按钮是 disabled 的，而在 disabled
    //    按钮上 click() **不派发事件** —— 症状是"弹层没打开"，很容易被读成功能坏了。
    //    这条等待本身也是个断言：写入完成后动作必须恢复可点（不能永久卡在禁用态）。
    await waitFor(function () {
      var b = queueRow('SKU-A1') && queueRow('SKU-A1').querySelector('[data-act="row-compare"]');
      return !!b && !b.disabled;
    }, 5000);
    report('对比确认写入完成后，行内动作恢复可点（写入期间禁用才是对的）', true);
    queueRow('SKU-A1').querySelector('[data-act="row-compare"]').click();
    await waitFor(function () { return !!document.querySelector('[data-act="compare-modal"]'); }, 5000);
    window.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
    await waitFor(function () { return !document.querySelector('[data-act="compare-modal"]'); }, 4000);
    report('按 Esc 关闭对比弹层（不留一个遮罩挡住整页）',
      !document.querySelector('[data-act="compare-modal"]'));
    report('夹具复位：对比模式消耗掉的一行已归还',
      await resetFixture(), 'rows=' + all('[data-act="queue-table"] tbody tr[data-item-id]').length);

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
    // ── 弹层带产品图（S3）：认款靠肉眼比图，弹层里没图就只能凭记忆挑 ──────
    // 「有图 / 无图」两个样本同时在（S1 有主图、S2 没有）：只放"全都有图"的样本，
    // "取图失败退化成空占位"这条就恒绿了。
    await settle(function () { return all('.pk-item [data-act="pick-thumb"]').length >= 1; }, 4000);
    var s1Pick = null;
    all('.pk-item').forEach(function (it) { if (flat(it).indexOf('S1') >= 0) s1Pick = it; });
    report('选择弹层每行带产品主图（有图的那款显示图）',
      all('.pk-item [data-act="pick-thumb"]').length >= 1,
      'thumbs=' + all('.pk-item [data-act="pick-thumb"]').length);
    report('有主图的那一行装的是它**自己的**主图（不是随便一张占位）',
      !!s1Pick && !!s1Pick.querySelector('[data-act="pick-thumb"]') &&
        s1Pick.querySelector('[data-act="pick-thumb"]').getAttribute('src') === SMOKE_IMG.prodThumb,
      s1Pick && s1Pick.querySelector('[data-act="pick-thumb"]')
        ? String(s1Pick.querySelector('[data-act="pick-thumb"]').getAttribute('src')).slice(0, 44)
        : 'no-s1');
    report('没有主图的那一行渲染空占位，而不是整列空掉（图取不到不该让人连产品都选不了）',
      all('.pk-item [data-act="pick-thumb-empty"]').length >= 1,
      'empties=' + all('.pk-item [data-act="pick-thumb-empty"]').length);
    var pkItems = all('.pk-item');
    var targetRadio = null;
    for (var pi = 0; pi < pkItems.length; pi++) {
      if (flat(pkItems[pi]).indexOf('S2') >= 0) targetRadio = pkItems[pi].querySelector('input[type="radio"]');
    }
    report('选择弹层列出产品且能定位到目标 S2', !!targetRadio, flat(document.querySelector('.pk-item')));
    targetRadio.click();
    await sleep(30);
    // 场景：这次认款顺带采纳了 2 张款主图（真值来自主进程；这里只验界面回执说不说）
    window.__smokeAdopt = 2;
    await clickText('.wb-mask .wb-dialog__foot button', '关联这 2 项');
    await waitFor(function () { return calls('productSkuMap').length >= 1; }, 6000);
    var maps = calls('productSkuMap');
    report('批量关联只发一次调用（不是逐条 N 次）', maps.length === 1, 'calls=' + maps.length);
    var sent = (maps[0] && maps[0].rows) || [];
    report('一次提交覆盖 2 行', sent.length === 2, 'rows=' + sent.length);
    // 写映射传的是**订单原文**（含尾随空格）—— 归一是主进程的事，界面不做归一：
    // 两份归一规则必然漂移，症状是"队列里认得出、写进去却搜不到"。
    report('每行带**自己的**店铺（串店会把别家店的商品ID 记到同一家名下）',
      !!sent[0] && sent[0].platform === 'shopee' && sent[0].shopId === 11 && sent[0].itemId === 'SKU-A1' &&
        !!sent[1] && sent[1].platform === 'amazon' && sent[1].shopId === 12 && sent[1].itemId === 'B0XYZ1234 ',
      JSON.stringify(sent));
    report('写入状态为已确认（才参与自动命中）',
      sent.every(function (r) { return r.status === 'confirmed' && r.productId === 2; }), JSON.stringify(sent));

    // ── 认款顺手采纳款主图：回执必须把那件事说出来 ─────────────────────
    // 「采纳了几张」这个数的**来历**由两层守：product:sku:smoke（挑哪个款、挑哪张图）+
    // ipc:shape:smoke（真复制文件、真登记 pl_images、真写 image_id）。这里只钉界面那一环：
    // 主进程回了 2，用户就得在回执里看到"并把 2 张订单图设为款主图"—— 否则它写的是
    // **产品主数据**，用户只会觉得"我的产品页怎么多了张图，谁动的？"
    // ⚠️ 等待条件**不能**写"含 新增 2 条"：上一步（直连）也发过一次同样的回执，虚拟时间下
    //    它可能还没过期 ⇒ 条件立刻为真、读到的是**上一步**的回执（adopted 那句于是恒缺）。
    //    条件必须指向"这一次才可能出现的那句话"，判定才留给 report（settle 不抛 → 可读 FAIL）。
    var adoptToast = null;
    await settle(function () { adoptToast = lastToastWith('款主图'); return !!adoptToast; }, 6000);
    report('认款回执报出采纳了几张款主图（写的是主数据，不能不说一声）',
      !!adoptToast && adoptToast.indexOf('并把 2 张订单图设为款主图') >= 0,
      adoptToast || JSON.stringify(toastText()));

    // ── 写入后队列**重拉**：已关联的组必须真的消失 ─────────────────────
    step('queue-reload');
    // 等它重拉落地，但**判定留给 report**（settle 不抛）：队列没重拉时报可读 FAIL（rows=3），
    // 而不是让 waitFor 超时中断、把后面几十条断言一起吞掉（2026-10-08 的实测教训）。
    await settle(function () { return all('[data-act="queue-table"] tbody tr[data-item-id]').length === 1; }, 6000);
    report('关联后队列重拉，只剩未归一的 1 行（不是本地删行假装成功）',
      all('[data-act="queue-table"] tbody tr[data-item-id]').length === 1,
      'rows=' + all('[data-act="queue-table"] tbody tr[data-item-id]').length);
    // 更锋利的一条：刚认下的那两条**按 id** 从队列消失（只数行数会漏掉"换了一批别的东西"）
    var qIds2 = all('[data-act="queue-table"] tbody tr[data-item-id]').map(function (r) {
      return String(r.getAttribute('data-item-id')).trim();
    });
    report('刚认下的两个商品已从队列消失（已关联的行不再出现在池里）',
      qIds2.indexOf('SKU-A1') < 0 && qIds2.indexOf('B0XYZ1234') < 0, 'queue=' + JSON.stringify(qIds2));
    await settle(function () { return flat(document.querySelector('[data-act="map-stats"]')).indexOf('（2/3）') >= 0; }, 4000);
    report('关联率更新为 2/3', flat(document.querySelector('[data-act="map-stats"]')).indexOf('（2/3）') >= 0,
      flat(document.querySelector('[data-act="map-stats"]')));

    // ── 已建立映射：新行可见 / 标失效按 id / 改绑拉回已确认 ────────────
    step('mapped-tab');
    await clickText('[data-act="sub-mapped"]', '已建立映射');
    // 第二个参数带尾随空格：写进去的是**订单原文**（见上一步的断言），列表就按写入值显示 ——
    // 归一发生在主进程的匹配侧，界面不替它改数据。
    await waitFor(function () { return !!mappedRow('SKU-A1') && !!mappedRow('B0XYZ1234 '); }, 6000);
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
    // 这次改绑**没有**采纳款主图（adopted=0）
    window.__smokeAdopt = 0;
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
    // 反向：这次 adopted=0，**这一次**的回执里不许出现"款主图" —— 否则那半句是恒真的，等于没守卫。
    var rebindToast = null;
    await waitFor(function () { rebindToast = lastToastWith('更新 1 条'); return !!rebindToast; }, 6000)
      .catch(function () { throw new Error('改绑后没等到回执：toast=' + JSON.stringify(toastText())); });
    report('adopted=0 时回执不提款主图（"全零不是正确表达"，也不许恒说）',
      rebindToast.indexOf('款主图') < 0, rebindToast);
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

    // ── 空态必须是**入口**，不是提示 ──────────────────────────────────
    // 「映射与关联」的队列是这一页唯一"从订单里长出来"的东西，而导入订单只在「今天」页。
    // 原先空态只写一句"导入订单后…"，用户得自己去找「今天」在哪 —— 这类"提示只说有问题、
    // 动作藏在别处"的形态 2026-10-03 被定名过（见 docs/notes 的「提示不是入口」）。
    // ⚠️ 夹具默认的队列里**始终留着** 1 行"店铺未归一"的样本（TB-999，那是"未归一不可关联"的
    //    守卫），空态永远进不去 ⇒ 这里临时把队列置空，专门验空态的形态。
    //    若不动这个开关，"空态有按钮"这条断言会因为组件没渲染而**恒绿**（等于没测）。
    step('empty-entry');
    window.__smokeEmptyQueue = true;
    // S4 起不再需要"切回映射视图"：只有一个工作台页签。仍然显式点一次（幂等），
    // 理由同 queue 步 —— 别让"默认页签被改错"变成后面断言集体失败的假象。
    await clickText('.gd-tabs .gd-tab', '建档与关联');
    await waitFor(function () { return !!document.querySelector('[data-act="go-today"]'); }, 6000);
    report('队列为空时给出「去「今天」导入订单」的真入口（不是一句"导入订单后…"）',
      flat(document.querySelector('[data-act="go-today"]')).indexOf('今天') >= 0,
      flat(document.querySelector('[data-act="go-today"]')));

    step('errors');
    report('无未捕获错误', (window.__smokeErrors || []).length === 0, JSON.stringify(window.__smokeErrors || []));
  } catch (e) {
    lines.push('SMOKE: FAILED at [' + STEP + '] - ' + (e && e.message ? e.message : String(e)));
  }
  finish();
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

/**
 * 跑一遍无头 Chrome 并取回 #smoke-result 的文本。
 *
 * `--window-size` 决定视口宽，而注入脚本**自己按 window.innerWidth 判断**该跑哪一套 ——
 * 所以这里不需要额外注入任何标记，视口宽度就是判据本身。
 * 宽（1440）那遍跑全量断言（含"两栏并排"）；窄（1000）那遍只跑窄视口守卫。
 */
async function runChrome(size, budget) {
  const dom = await new Promise((resolve, reject) => {
    const cp = spawn(CHROME, [
      '--headless=new', '--disable-gpu', '--no-sandbox',
      `--window-size=${size}`,
      `--virtual-time-budget=${budget}`,
      '--dump-dom',
      `http://127.0.0.1:${PORT}/index.html`,
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

const WIDE = await runChrome('1440,900', 45000);
if (!WIDE) {
  console.error('✗ 宽视口那遍没抓到 #smoke-result（页面可能没挂载）。排查：产物新鲜度（npm run build）→ 资源 404 → 内联脚本语法错 → 假桥缺键');
  process.exit(1);
}
console.log(WIDE);

// 第二遍：把视口压到 1180px 以下，只跑窄视口守卫（方案 §9-1 的判据：堆叠且两栏都在）。
const NARROW = await runChrome('1000,900', 30000);
console.log('\n── 窄视口守卫（第二遍，视口 1000px）──');
console.log(NARROW || '✗ 窄视口那遍没抓到 #smoke-result');
server.close();

const ok = WIDE.split('\n').pop() === 'SMOKE: ALL PASS' &&
  !!NARROW && NARROW.split('\n').pop() === 'SMOKE: ALL PASS';
console.log(ok ? '\n✓ 货与成本页冒烟通过（宽 + 窄两遍）' : '\n✗ 货与成本页冒烟失败');
process.exit(ok ? 0 : 1);