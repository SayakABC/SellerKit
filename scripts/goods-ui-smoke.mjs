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
import { createRequire } from 'node:module';
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
/* 形态偏好（「简洁模式」）必须在**应用脚本之前**清掉。
   这一段是经典内联脚本，在解析到 </head> 时就执行；应用的入口是 <script type="module">（延迟执行），
   于是它读到的就是"从没存过偏好"= 全新安装那一态。
   为什么必须这么做：headless 三遍共用一个浏览器 profile，而切换形态会把 '0'/'1' 写进 localStorage ⇒
   不加这一步，"默认是简洁模式"那条断言会**看上一次跑剩下的值**（第一次全绿、第二次全红）。
   ⚠️ 不要改用 --user-data-dir 隔离：实测这台机器上带它的 headless Chrome 会**直接挂住不退出**
   （2026-10-08 踩到，见 docs/notes/2026-10-08-goods-ux-refactor-r0-r3.md 或者本次的收尾笔记）。 */
try { localStorage.removeItem('sk.goods.simple'); } catch (e) {}
(function () {
  var calls = {};
  window.__smokeCalls = calls;
  function rec(name, payload) { (calls[name] = calls[name] || []).push(payload); }

  // 两个产品：P1 有两个 SKU（一个缺克重）**且有主图**、P2 一个 SKU；P2 未关联供应商**且无主图**。
  // 「有图 / 无图」两个样本都必须有：弹层与对比模式里"取图失败渲染空占位、而不是整列空掉"
  // 这条只有在同一屏里同时存在两种行时才抓得到（全是图的样本恒绿）。
  var PRODUCT_IMG = '/tmp/smoke-product-images/s1.webp';
  // 断言脚本是**另一段 script**（与假桥不同作用域），要通过 window 转手。
  // 导出闭环那条断言要拿它比对"导出的图路径 == 库里主图的路径"—— 写死字面量两边就会各改各的。
  window.__smokeProductImg = PRODUCT_IMG;
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

  /**
   * 夹具里**当前可见**的映射行。多一个开关 window.__smokeNoInvalid：
   * 打开时整个库里**一条失效都没有**（失效行按已确认出现，行数不变）。
   *
   * 为什么需要它：「有 N 条已失效 → 只看它们」那条汇总入口的**反向守卫**（0 时不许渲染）
   * 靠它才有意义 —— 种子数据里本来就有一条失效行，入口永远有正数可显示 ⇒
   * "把条数守卫去掉"这个错在夹具里**恒绿**（2026-10-08 变异复核实测：M6 第一次没变红）。
   */
  function visibleMapped() {
    if (!window.__smokeNoInvalid) return MAPPED;
    return MAPPED.map(function (r) {
      if ((r.status || 'confirmed') !== 'invalid') return r;
      var copy = {};
      for (var k in r) copy[k] = r[k];
      copy.status = 'confirmed';
      return copy;
    });
  }

  /** 商品ID → 关联的产品（一对多） */
  var RELATIONS = [
    { id: 901, itemId: 'SKU-A1', productId: 1, productCode: 'S1', productName: '款一', createdAt: '2026-09-27 12:00' },
  ];

  /** 本会话已建立的映射键（队列据此剔除\"已关联\"的组）—— 真实里是 pl_shop_sku WHERE status='confirmed' */
  var MAP = {};

  /* ==========================================================================
     店铺实体域（sk_shops / sk_name_map）—— 2026-10-08 起「店铺登记」收进内建，
     右栏提示条的「现在登记」与行内的「去登记」都跳它 ⇒ 这一页真的会调这几个通道。

     ⚠️ 样本必须与队列**同源**（这是本文件最容易写错的地方）：
        · 两家店 = 队列里那两行 unmapped 的归属（shopId 11 / 12，平台 shopee / amazon）；
        · 一条未归一店名 = 队列里那一行 shopUnresolved 的原文（「新奇怪物店」，
          且 autoShopId=12 精确命中 Aurora Store —— 「采纳」按钮只在唯一命中时出现）。
     这样"登记完 → 回队列刷新 → 那一行就能关联了"这条**端到端**断言才成立。
     两端各造一套互不相干的夹具（店名对不上队列里的原文）—— 界面照样全绿，
     但那条断言会变成恒真：它验的正是"两端是不是同一件事"。
     ========================================================================== */
  var SHOPS_INIT = [
    { id: 11, platform: 'shopee', name: 'HK 优品店', nameKey: 'hk 优品店', platformShopId: '', site: 'MY', shopSetId: 0, status: 'active', openedAt: '', note: '', createdAt: '2026-09-01 10:00', updatedAt: '', aliasCount: 1 },
    { id: 12, platform: 'amazon', name: 'Aurora Store', nameKey: 'aurora store', platformShopId: 'A1B2C3D4', site: 'US', shopSetId: 7, status: 'active', openedAt: '', note: '', createdAt: '2026-09-02 10:00', updatedAt: '', aliasCount: 1 },
  ];
  /* 未归一店名（主进程 listUnmapped 每次实时聚合算出来的，不是缓存表）—— 两条各有分工：
       ① 「新奇怪物店」= 队列里那行 shopUnresolved 的原文，且**唯一命中** Aurora Store
          ⇒ 必须出现「采纳：Aurora Store」（这是"不猜"的反面：唯一时给一键采纳）；
       ② 「GAIA」= **歧义**样本（同名两平台，主进程给的 autoShopId 恒为 0）
          ⇒ 界面上**不许**有「采纳」（恒渲染采纳的话，①那条断言就变成了恒真），只能靠人选。
     只放 ① 的话，"采纳是条件渲染"这条判据恒绿 —— 它恰好是"不猜歧义"纪律的唯一机器守卫。 */
  var UNMAPPED_SHOPS_INIT = [
    { key: '新奇怪物店', raw: '新奇怪物店', occurrences: 3, sources: ['order'], autoShopId: 12, autoShopName: 'Aurora Store', autoShopPlatform: 'amazon' },
    { key: 'gaia', raw: 'GAIA', occurrences: 5, sources: ['purchase'], autoShopId: 0, autoShopName: '', autoShopPlatform: '' },
  ];
  var SHOPS = SHOPS_INIT.map(function (s) { return Object.assign({}, s); });
  var UNMAPPED_SHOPS = UNMAPPED_SHOPS_INIT.map(function (r) { return Object.assign({}, r); });
  /** 已登记的"历史店名 → 店铺id"绑定（队列据此把 shopUnresolved 行放行成可关联） */
  var SHOP_BIND = {};
  var SHOP_STALE = 0;

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
    // 店铺侧也要回到原点：否则「登记完这一行就能关联了」的断言在复用同一会话的第二个场景里
    // 会直接看到"已经登记过了"，那条断言就恒绿了。
    SHOPS = SHOPS_INIT.map(function (s) { return Object.assign({}, s); });
    UNMAPPED_SHOPS = UNMAPPED_SHOPS_INIT.map(function (r) { return Object.assign({}, r); });
    SHOP_BIND = {};
    SHOP_STALE = 0;
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
      // 空库分支（仅当断言脚本打开 window.__smokeEmptyProducts 时走）：用于验"窄窗口下左栏
      // 空态的按钮真的点得到"。空态只在**真的零款**时才渲染 —— 造不出零款，那条可达性断言
      // 会因为组件根本没渲染而恒绿（等于没测）。
      if (window.__smokeEmptyProducts) rows = [];
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
      // 与 productList 的 __smokeEmptyProducts 同步（空库样本必须**处处**都是零，否则
      // 空态判据里的"零款"会被这一处的非零值顶掉）。
      if (window.__smokeEmptyProducts) {
        return { success: true, data: {
          total: 0,
          byStatus: [],
          withoutSupplier: 0,
          supplierOptions: [
            { id: 7, name: '厂A', productCount: 0 },
            { id: 8, name: '厂B', productCount: 0 },
          ],
        } };
      }
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
      var rows = visibleMapped();
      var byShop = [];
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i], hit = null;
        for (var j = 0; j < byShop.length; j++) if (byShop[j].shopId === r.shopId) hit = byShop[j];
        if (hit) hit.count++;
        else byShop.push({ shopId: r.shopId, shopName: r.shopId === 11 ? 'HK 优品店' : 'Aurora Store', platform: r.platform, count: 1 });
      }
      // ⚠️ byStatus 必须**按夹具真实算**，不能给个空数组：
      //    「有 N 条已失效 → 只看它们」那条汇总入口的条数是它算出来的，
      //    桩写死空数组 ⇒ 那条断言永远拿不到按钮（恒红），
      //    而如果反过来把断言放宽成"按钮在不在都行"，就是一条恒绿的空断言。
      //    真进程的 productSkuSummary 也是按状态聚合的，桩要复刻的是**结构**不是内容。
      var byStatus = [];
      for (var bi = 0; bi < rows.length; bi++) {
        var st = rows[bi].status || 'confirmed', hitSt = null;
        for (var bj = 0; bj < byStatus.length; bj++) if (byStatus[bj].status === st) hitSt = byStatus[bj];
        if (hitSt) hitSt.count++;
        else byStatus.push({ status: st, count: 1 });
      }
      return { success: true, data: { total: rows.length, byStatus: byStatus, byPlatform: [], byShop: byShop } };
    },
    'productVariantUpsert': function (p) { rec('productVariantUpsert', p); return { success: true, data: { id: p.id, created: false } }; },
    'productDbEnsure': function () { return { success: true, data: { ok: true } }; },

    /* ---- 产品表单 upsert（编辑抽屉的**即时保存**走它）---- */
    // 桩必须**真的改夹具对象**：只记调用不改数据的话，"离开输入框就落库 → 列表/表单是新值"
    // 那类断言会恒绿（界面读到的永远是旧值，而它只看自己的表单副本，照样"对"）。
    // 真进程返回 {id, created}：新增给 created:true，编辑给 false（抽屉据此选 toast 文案）。
    'productUpsert': function (p) {
      rec('productUpsert', p);
      var pid = Number((p && p.id) || 0);
      var hit = null;
      for (var i = 0; i < PRODUCTS.length; i++) if (PRODUCTS[i].id === pid) hit = PRODUCTS[i];
      if (!hit) {
        hit = {
          id: 900 + PRODUCTS.length, code: String(p.code), name: String(p.name || ''),
          supplierId: Number(p.supplierId || 0), supplierName: '', category: String(p.category || ''),
          status: p.status || 'active', note: String(p.note || ''), imageId: 0, imagePath: '',
          createdAt: '', updatedAt: '',
        };
        PRODUCTS.push(hit);
        return { success: true, data: { id: hit.id, created: true } };
      }
      hit.name = String(p.name || '');
      hit.supplierId = Number(p.supplierId || 0);
      hit.supplierName = hit.supplierId === 7 ? '厂A' : hit.supplierId === 8 ? '厂B' : '';
      hit.category = String(p.category || '');
      hit.status = p.status || hit.status;
      hit.note = String(p.note || '');
      return { success: true, data: { id: hit.id, created: false } };
    },

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

    /* ---- Excel 导入 / 导出（2026-10-08 模板改列后补的桩）----
       ⚠️ 这两个桩**忠实于新形状**，不"贴心地"补默认值：
         · productImport 的 items 里**不该有 category**（模板已无这一列，库层对已存在的款
           原样保留）——夹具若自己补一个空 category，那条坑就永远抓不到；
         · productExport 收到的是**每格文本 + 每行的图路径**（不是 buffer）：表头/行由渲染层算，
           主进程只写格子 + 嵌图（electron/product-xlsx.ts）。
       抽图那一步（product-extract-images）由假桥给**固定答案**：真抽取（锚点归位、
       图真的进了 zip）由 scripts/product-xlsx-smoke.cjs 单独钉住，两段各管一头。 */
    'selectExcel': function () {
      rec('selectExcel', {});
      return { success: true, data: { filePath: '/tmp/smoke-import.xlsx', data: window.__smokeXlsxBuffer() } };
    },
    'productExtractImages': function (p) {
      rec('productExtractImages', { sheetName: p && p.sheetName, headerRow: p && p.headerRow, hasBuffer: !!(p && p.buffer) });
      return { success: true, data: {
        // 两张图、两种命运：第 2 行（合格）的图提交后成为款主图；第 4 行刻意给**规格对不上**
        // 的行 —— 验"图不改变合格性"（照旧标跳过），且提交被剔除时图跟着行一起不进来
        //（结果页的主图数只算第 2 行那张）。
        byRow: {
          '2': { imageId: 55, localPath: '/tmp/smoke-product-images/imported.png' },
          '4': { imageId: 56, localPath: '/tmp/smoke-product-images/imported2.png' },
        },
        // 第 9 行是空行 ⇒ 图归不了位，必须被说出来（否则就是"导入成功但图没进来"）
        skips: [{ rowNo: 9, reason: '第 9 行插了图片，但那一行没有对应的导入行（表头以上 / 空行 / 与上一行同款已合并），这张图没有归位' }],
        total: 3,
      } };
    },
    'productImport': function (p) {
      rec('productImport', p);
      var items = (p && p.items) || [];
      return { success: true, data: {
        created: items.length,
        updated: 0,
        skusWritten: items.reduce(function (n, r) { return n + (((r && r.skus) || []).length); }, 0),
        imagesAttached: items.filter(function (r) { return r && r.imageId > 0; }).length,
        failed: [],
      } };
    },
    'productExport': function (p) {
      rec('productExport', { sheetName: p && p.sheetName, headers: p && p.headers, imageColumn: p && p.imageColumn, rows: p && p.rows, defaultName: p && p.defaultName });
      var rows = (p && p.rows) || [];
      return { success: true, data: {
        filePath: '/tmp/smoke-out.xlsx',
        embedded: rows.filter(function (r) { return r && r.imagePath; }).length,
        imagesFailed: 0,
      } };
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
      // 大批量分支（window.__smokeQueueMany）：造 205 组待办，用来验「显示更多」是**真动作** ——
      // 初始上限 200 ⇒ 已列出 200、还有 5 组没列出（按钮该出现）；点一下变 205（按钮该消失）。
      // 只有"待办总数 > 已列出"的样本才分得清"点了不动的假动作"和"真的多列出了"。
      var all = QUEUE;
      if (window.__smokeQueueMany) {
        all = [];
        for (var mi = 1; mi <= 205; mi++) {
          all.push({ shopKey: 'many shop', shopRaw: 'Many Shop', itemId: 'MANY-' + mi, itemKey: 'MANY-' + mi, title: '', orderCount: 1, shopId: 11, shopName: 'HK 优品店', platform: 'shopee', autoShopId: 0, autoShopName: '', autoShopPlatform: '', status: 'unmapped' });
        }
      } else {
        // 「店铺未归一」那几行**跟着登记状态走**：在「店铺登记」里把它认下来之后，
        // 这一行就该变成可关联的 unmapped（真实里也一样 —— 平台只能从店铺实体取，
        // 取到了这一行就不再受阻）。夹具不跟着变，"登记完回来就能关联"那条端到端断言
        // 会被永远卡在"登记前后一模一样"上（等于没验）。
        all = QUEUE.map(function (r) {
          var sid = SHOP_BIND[r.shopKey];
          if (r.status === 'shopUnresolved' && sid) {
            var sh = null;
            for (var si = 0; si < SHOPS.length; si++) if (SHOPS[si].id === sid) sh = SHOPS[si];
            return {
              shopKey: r.shopKey, shopRaw: r.shopRaw, itemId: r.itemId, itemKey: r.itemKey,
              title: r.title, orderCount: r.orderCount,
              shopId: sid, shopName: sh ? sh.name : '', platform: sh ? sh.platform : '',
              autoShopId: 0, autoShopName: '', autoShopPlatform: '', status: 'unmapped',
            };
          }
          return r;
        });
      }
      var pending = all.filter(function (r) { return !(r.shopId && MAP[keyOf(r)]); });
      var lim = Number((p && p.limit) || 0);
      var rows = lim > 0 ? pending.slice(0, lim) : pending;
      // ⚠️ 与主进程**同口径**：shown 是这一页**返回**的行数，而 unmapped / shopUnresolved
      //    数的是**全部待办**（不受 limit 影响）——「还有没有没列出的组」正是这两个数之差。
      //    夹具若把三者都按 rows 数，"已列出 < 待办总数"永远不成立，那条守卫会恒绿。
      var unmapped = pending.filter(function (r) { return r.status === 'unmapped'; }).length;
      return { success: true, data: {
        rows: rows,
        stats: {
          groups: all.length, shown: rows.length, unmapped: unmapped,
          shopUnresolved: pending.length - unmapped, mapped: Object.keys(MAP).length,
          withItemId: 52, withoutItemId: 4, truncated: false,
          unresolvedShops: pending.filter(function (r) { return r.status !== 'unmapped'; }).map(function (r) { return r.shopRaw; }),
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
      var list = visibleMapped().filter(function (r) {
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
    /* ---- 店铺实体域（sk_shops / sk_name_map）----
       「店铺登记」2026-10-08 收进内建后，这一页真的会调这几个通道（原先只有岛会调）。
       ⚠️ 桩必须真的**改状态**（map 后从名单移走、upsert 后进列表）：
          只 rec 不改的桩会让"登记完变成什么样"整段断言恒绿 —— 而那段正是 R1 要守的东西。 */
    'shopDbEnsure': function () { return { success: true, data: { ok: true } }; },
    'shopList': function (p) {
      rec('shopList', p);
      return { success: true, data: { rows: SHOPS.map(function (s) { return Object.assign({}, s); }), total: SHOPS.length } };
    },
    'shopUnmapped': function () {
      rec('shopUnmapped', {});
      return { success: true, data: UNMAPPED_SHOPS.map(function (r) { return Object.assign({}, r); }) };
    },
    'shopSummary': function () {
      rec('shopSummary', {});
      var mapped = SHOPS.reduce(function (n, s) { return n + Number(s.aliasCount || 0); }, 0);
      var auto = UNMAPPED_SHOPS.filter(function (r) { return !!r.autoShopId; }).length;
      return { success: true, data: {
        total: SHOPS.length,
        byPlatform: [],
        byStatus: [],
        names: {
          total: SHOPS.length + UNMAPPED_SHOPS.length,
          mapped: mapped,
          unmapped: UNMAPPED_SHOPS.length,
          ignored: 0,
          autoMatched: auto,
          stale: SHOP_STALE,
        },
      } };
    },
    'shopMap': function (p) {
      rec('shopMap', p);
      var raw = String((p && p.raw) || '');
      var refId = Number((p && p.refId) || 0);
      UNMAPPED_SHOPS = UNMAPPED_SHOPS.filter(function (r) { return r.key !== raw; });
      if (refId > 0) {
        SHOP_BIND[raw] = refId;
        for (var i = 0; i < SHOPS.length; i++) if (SHOPS[i].id === refId) SHOPS[i].aliasCount++;
      }
      return { success: true, data: { key: raw, refId: refId, ignored: p && p.ignored === true } };
    },
    'shopUpsert': function (p) {
      rec('shopUpsert', p);
      var id = Number((p && p.id) || 0);
      if (!id) {
        id = ++SEQ;
        SHOPS.push({
          id: id, platform: p.platform || '', name: p.name || '', nameKey: String(p.name || '').toLowerCase(),
          platformShopId: p.platformShopId || '', site: p.site || '', shopSetId: Number(p.shopSetId) || 0,
          status: p.status || 'active', openedAt: p.openedAt || '', note: p.note || '',
          createdAt: '2026-10-08 12:00', updatedAt: '', aliasCount: 0,
        });
        return { success: true, data: { id: id, created: true } };
      }
      for (var j = 0; j < SHOPS.length; j++) {
        if (SHOPS[j].id !== id) continue;
        // 全量提交：payload 里给什么就是什么（界面漏透传哪个字段，这里就真的被清空 ——
        // 夹具若"贴心地"保留旧值，那条坑就永远抓不到）
        SHOPS[j].platform = p.platform || '';
        SHOPS[j].name = p.name || '';
        SHOPS[j].nameKey = String(p.name || '').toLowerCase();
        SHOPS[j].platformShopId = p.platformShopId || '';
        SHOPS[j].site = p.site || '';
        SHOPS[j].shopSetId = Number(p.shopSetId) || 0;
        SHOPS[j].status = p.status || 'active';
        SHOPS[j].openedAt = p.openedAt || '';
        SHOPS[j].note = p.note || '';
      }
      return { success: true, data: { id: id, created: false } };
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
/**
 * 元素是否**真的能被点到**（不只是"在 DOM 里"）。
 *
 * 为什么需要它：本脚本原有 110 条断言**全部**按"元素存在"判定，拦不住"渲染了但点不到"。
 * 2026-10-08 真机走查实测到两类，在存在性断言下都**恒绿**：
 *   ① 默认 1200×800 下右栏队列表超出容器右界 ⇒ 「对比」被容器裁剪面盖住、完全点不到；
 *   ② 窄窗口堆叠时左栏被压扁 ⇒ 空态内容溢出容器、按钮被后续栏盖住（"新手第一屏点不到"）。
 *
 * 判据：元素**中心点**上 document.elementFromPoint 命中的是它自己、它的子孙或祖先。
 * 中心点出视口直接判不可达 —— 默认窗口下的关键动作不该需要先滚动才能用。
 */
function reachInfo(el) {
  if (!el) return { ok: false, why: 'missing' };
  var r = el.getBoundingClientRect();
  if (!r.width || !r.height) return { ok: false, why: 'zero-size' };
  var cx = r.left + r.width / 2;
  var cy = r.top + r.height / 2;
  if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
    return { ok: false, why: 'out-of-viewport(' + Math.round(cx) + ',' + Math.round(cy) + ') 视口=' + window.innerWidth + 'x' + window.innerHeight };
  }
  var hit = document.elementFromPoint(cx, cy);
  if (!hit) return { ok: false, why: 'elementFromPoint=null' };
  if (hit === el || el.contains(hit) || hit.contains(el)) return { ok: true, why: '' };
  return { ok: false, why: 'covered-by ' + String(hit.tagName) + '.' + String(hit.className || '').slice(0, 48) };
}
/** 断言某选择器命中的元素**可达**（存在 + 在视口内 + 命中自身）；返回该元素便于继续操作。
    失败时把元素自己的矩形一并带出来 —— 只报 covered-by 会让人看不出"是盖子的问题还是它自己被压扁了"。 */
function reportReachable(name, sel, root) {
  var el = (root || document).querySelector(sel);
  var info = reachInfo(el);
  var r = el ? el.getBoundingClientRect() : null;
  var geo = r ? ' 自身rect=' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) : '';
  report(name, info.ok, info.ok ? geo.trim() : info.why + geo);
  return el;
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

  // ── 空态**可达性**（B3）────────────────────────────────────────────
  // "两栏都在"≠"两边都能用"：窄窗口堆叠时左栏高度被压扁过，空态（图标 + 文案 + 两个按钮）
  // 整段溢出容器、被后面的栏盖住 —— 症状是"全新安装的默认窗口下，新手第一屏唯一该点的按钮
  // 点不到"，而存在性断言对它恒绿（DOM 里确实有那个按钮）。这一遍专门验它。
  step('viewport-narrow-empty');
  window.__smokeEmptyProducts = true;
  await clickText('[data-act="refresh"]', '刷新');
  await settle(function () { return !!document.querySelector('.gd-list__empty .wb-empty__actions button'); }, 8000);
  report('窄窗口下左栏空态渲染出来了（零款样本：造不出零款这条守卫就恒绿）',
    !!document.querySelector('.gd-list__empty .wb-empty__actions button'),
    'empty=' + !!document.querySelector('.gd-list__empty'));
  // 空态那一格必须横跨**全部列**。这一遍是"简洁模式（默认）"——左栏没有勾选框那一列 ⇒
  // 正确的 colspan 是 6 而不是 7。写死 7 的症状是"右边缺一块"，不报错、不抛异常，只有看出来。
  var emptyCell = document.querySelector('.gd-list__empty');
  var thCount = all('[data-act="product-table"] thead th').length;
  report('空态那一格横跨**全部列**（简洁模式少一列，colspan 必须跟着变，否则右边缺一块）',
    !!emptyCell && emptyCell.colSpan === thCount,
    'colspan=' + (emptyCell ? emptyCell.colSpan : 'missing') + ' 表头=' + thCount);
  // 反向守卫（首次动线 R3）：这一遍是"零款 + **队列非空**" —— 引导卡不该出现。
  // 这是与 empty-entry 那一条**不同的组合**（那条是"有款 + 空队列"），两条合起来才说明
  // 判据真的是"两端同时为零"，而不是跟着其中一个开关走。
  // ⚠️ 这条断言也是"dist 里残留变异"的照妖镜：把 firstRun.ts 的 && 改成 || 再 build、
  //    跑完记得**再 build 回来** —— 否则 dist 里留着变异体，这一遍会挂着一条 FAIL
  //    （2026-10-08 实测踩到，见 docs/notes/2026-10-08-goods-ux-refactor-r0-r3.md §2）。
  report('窄窗口下零款 + 队列非空 → 首启引导卡不出现',
    !document.querySelector('[data-act="first-run-card"]'),
    '队列指标条=[' + flat(document.querySelector('[data-act="map-stats"]')) + ']');
  reportReachable('窄窗口下空态「导入 Excel」可达（新手第一屏的动作之一）',
    '.gd-list__empty .wb-empty__actions button:first-child');
  reportReachable('窄窗口下空态「新增产品」可达（第一印象按钮，点不到等于这页没用）',
    '.gd-list__empty .wb-empty__actions button:last-child');

  // ── 两个空态要说清"先做哪个"（报告 P0-5 左半）──────────────────────
  // 队列是**从订单里长出来的**（不是一张导入进来的表），所以全新安装上正确的第一步是
  // "先在「今天」导订单"。原先左右两个空态各指一个方向（左边说"建款"、右边说"导订单"），
  // 页面没说先做哪个 —— 新手只能瞎点。
  // ⚠️ 这一条的判据是**顺序**（第一个按钮就是它），不是"那个按钮在不在"：
  //    放在第三位照样能点，但那时"顺序"这个答案就没给出来。
  //    同时它必须**跟着状态走** —— 上面那两组（队列非空）断的是原位，两组合起来才说明
  //    顺序是算出来的，不是把两个按钮的写法调了个头。
  step('viewport-narrow-empty-order');
  window.__smokeEmptyQueue = true;
  await clickText('[data-act="refresh"]', '刷新');
  await settle(function () { return !!document.querySelector('[data-act="empty-go-today"]'); }, 8000);
  var eqActs = all('.gd-list__empty .wb-empty__actions button');
  report('零款 + 队列也空 → 左栏空态把「去「今天」导入订单」放在**第一位**（顺序本身就是一个答案）',
    eqActs.length >= 1 && flat(eqActs[0]).indexOf('今天') >= 0,
    eqActs.map(flat).join(' / '));
  report('那个按钮是**主按钮**（此刻该做的事，不是三个并列选项里的一个）',
    eqActs.length >= 1 && flat(eqActs[0]).indexOf('今天') >= 0 &&
      eqActs[0].className.indexOf('wb-btn--primary') >= 0,
    eqActs.length ? eqActs[0].className : 'missing');
  report('空态说明点出"商品是从订单里长出来的"（别让用户猜右边为什么空着）',
    flat(document.querySelector('.gd-list__empty .wb-empty__desc')).indexOf('订单') >= 0,
    flat(document.querySelector('.gd-list__empty .wb-empty__desc')));
}

/**
 * 默认窗口（1200×800，即 electron/main.ts 建窗口用的尺寸）下的**可达性**那一遍。
 *
 * 为什么必须单独跑这一遍：这类缺陷**只在默认窗口宽度下才出现** —— 全量那遍跑的是 1440 宽，
 * 两栏都宽裕，什么都点得到。而 1200×800 正是绝大多数用户第一次看到的那个宽度：
 * 在那里点不到，等于那个功能不存在（S3 刚建好的「对比」动线就是这样"等于没做"）。
 */
async function defaultWindowReachChecks() {
  step('reach-default-window');
  await waitFor(function () { return document.querySelector('[data-act="goods-workbench"]'); }, 12000);
  await waitFor(function () { return all('[data-act="queue-table"] tbody tr[data-item-id]').length >= 1; }, 12000);
  var vw = window.innerWidth;
  report('默认窗口宽度 ' + vw + 'px：走并排形态（与真机默认窗口一致）', vw >= 1180 && vw < 1440, 'vw=' + vw + ' vh=' + window.innerHeight);

  // ① 队列表必须整体落在视口内。超出的那半截列在界面上**看不见也点不到**，而 .wb-panel 是
  //    overflow:hidden —— 没有滚动条、没有报错、DOM 里字段一个不少，存在性断言对它恒绿。
  var qTable = document.querySelector('[data-act="queue-table"]');
  var qr = qTable.getBoundingClientRect();
  report('队列表没有横向溢出视口（右半截会被容器静默裁掉）',
    qr.right <= vw + 1, 'right=' + Math.round(qr.right) + ' vw=' + vw);

  // ② 表头最后一列必须完整可见（被裁掉的表头 = 那一列的动作等于没有）
  reportReachable('队列表头「操作」列完整可见', '[data-act="queue-table"] thead th:last-child');

  // ③ 行内两个动作（认款的两条动线）必须点得到
  reportReachable('队列行「关联…」按钮可达',
    '[data-act="queue-table"] tbody tr[data-item-id="SKU-A1"] [data-act="row-relate"]');
  reportReachable('队列行「对比」按钮可达（S3 的对比动线在默认窗口下必须真的可用）',
    '[data-act="queue-table"] tbody tr[data-item-id="SKU-A1"] [data-act="row-compare"]');
  // ④ 图列：认款只能靠肉眼比图，这一列不可点等于整条动线断了
  reportReachable('队列行缩略图可达（点开看原图）', '[data-act="queue-table"] [data-act="q-thumb"]');
  // ⑤ 左栏的关键入口
  reportReachable('左栏「新增产品」可达', '[data-act="new-product"]');
  reportReachable('左栏产品行展开钮可达',
    '[data-act="product-table"] tbody tr[data-product-id] [data-act="row-expand"]');
  // ⑦ D1 死锁的出口：默认窗口下必须**真的能点**。
  //    它躺在一张提示条里、而右栏在这一档宽度下只有 ~500px —— 正是"存在性断言恒绿"的典型位置
  //    （元素在 DOM 里、却被容器裁到视口外或被别的层盖住）。
  reportReachable('右栏提示条的「现在登记」可达（死锁的出口在默认窗口下必须能点）',
    '[data-act="open-registry"]');

  // ⑥ 已建立映射段：列更多，更容易被裁
  await clickText('[data-act="sub-mapped"]', '已建立映射');
  await settle(function () { return all('[data-act="mapped-table"] tbody tr[data-item-id]').length >= 1; }, 8000);
  reportReachable('「已建立映射」行「改绑」可达',
    '[data-act="mapped-table"] tbody tr[data-item-id] [data-act="row-rebind"]');
  var mTable = document.querySelector('[data-act="mapped-table"]');
  report('映射表没有横向溢出视口',
    !!mTable && mTable.getBoundingClientRect().right <= window.innerWidth + 1,
    mTable ? 'right=' + Math.round(mTable.getBoundingClientRect().right) + ' vw=' + window.innerWidth : 'missing');
}

async function main() {
  // ── 三遍视口，各跑各的那一套 ────────────────────────────────────────
  // 由 runner 用 ?mode= 指定（不指定则按视口宽度自判，保持单独打开页面时的旧行为）：
  //   full   1440×900  全量断言
  //   reach  1200×800  **默认窗口**下的可达性（B4 只在默认窗口宽度下暴露）
  //   narrow  900×800  堆叠形态 + 左栏空态可达性（B3）
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
  if (MODE === 'reach') {
    try {
      await defaultWindowReachChecks();
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

    // ── 简洁模式（2026-10-08 报告 P1-1 / 待拍板 UX-G2）──────────────────
    // 默认**开**：不渲染左栏勾选框列 + 批量条、右栏统计条（理由与边界见 src/modules/goods/simple.ts）。
    // 这一组守三件事，缺一条就退化成"装了个没用的开关"：
    //   ① 默认真的是简洁（不是"开关在、默认还是铺满"）；
    //   ② 两个方向都真（关掉 → 那些控件回来；再打开 → 又消失）；
    //   ③ 后面几十条断言长在被藏起来的那些控件上 ⇒ 结尾必须**切回完整形态**，
    //      否则它们会集体失败，而失败原因看起来像"功能坏了"，不是"夹具没还原"。
    // ⚠️ 每条断言都先等"渲染到位"再判，不等就断言会把"还没重排完"读成"开关没生效"。
    step('simple-mode');
    var simpleBtn = document.querySelector('[data-act="simple-toggle"]');
    report('页头有「简洁模式」开关', !!simpleBtn, simpleBtn ? flat(simpleBtn) : 'missing');
    report('默认就是简洁模式（开关自己说得出当前状态，不靠用户猜）',
      !!simpleBtn && simpleBtn.getAttribute('aria-pressed') === 'true',
      simpleBtn ? 'aria-pressed=' + simpleBtn.getAttribute('aria-pressed') : 'missing');
    report('简洁模式下左栏**一列勾选框都没有**（连表头全选也没有 —— 批量条与整列是一组）',
      all('[data-act="product-table"] input[type="checkbox"]').length === 0,
      'boxes=' + all('[data-act="product-table"] input[type="checkbox"]').length);
    report('简洁模式下右栏**没有统计条**（"五项 0 和关联率 —"是新手最容易被吓退的一屏）',
      !document.querySelector('[data-act="map-stats"]'));
    report('简洁模式**没有**顺手把「问题件」也藏掉（它是缺克重 / 未关联供应商的唯一入口，藏了就是死能力）',
      !!document.querySelector('[data-act="filter-issue"]'));
    if (simpleBtn) simpleBtn.click();
    await settle(function () { return !!document.querySelector('[data-act="map-stats"]'); }, 4000);
    report('关掉简洁模式 → 勾选框列与统计条都回来（开关真的接在渲染上，不是个装饰按钮）',
      all('[data-act="product-table"] input[type="checkbox"]').length >= 2 &&
        !!document.querySelector('[data-act="map-stats"]') &&
        simpleBtn.getAttribute('aria-pressed') === 'false',
      'boxes=' + all('[data-act="product-table"] input[type="checkbox"]').length +
        ' bar=' + !!document.querySelector('[data-act="map-stats"]'));
    if (simpleBtn) simpleBtn.click();
    await settle(function () { return !document.querySelector('[data-act="map-stats"]'); }, 4000);
    report('再打开 → 两样**又消失**（两个方向都真，不是"关得掉、开不回来"）',
      all('[data-act="product-table"] input[type="checkbox"]').length === 0 &&
        !document.querySelector('[data-act="map-stats"]'));
    // 夹具复原：切回完整形态（后续断言长在被藏起来的控件上）
    if (simpleBtn) simpleBtn.click();
    await settle(function () { return !!document.querySelector('[data-act="map-stats"]'); }, 4000);
    report('夹具复原：切回完整形态（后面的批量条 / 选中计数 / 关联率 / 全零那句话都长在它上面）',
      !!document.querySelector('[data-act="map-stats"]') &&
        simpleBtn.getAttribute('aria-pressed') === 'false');
    // 行展开的可发现性（报告 P1-2）：原先"这一行能点开"只存在于行首那个 ▸ 小三角里 ——
    // 不悬停发现不了，触屏根本没有悬停。展开区里装着供应商 / 类目 / 规格 / 已认的商品。
    report('左栏给出「点行展开」的常显提示（原先只有那个 ▸ 小三角）',
      !!document.querySelector('[data-act="expand-hint"]'),
      flat(document.querySelector('[data-act="expand-hint"]')));

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

    // ── 编辑抽屉的保存模型（2026-10-08 R2 · UX-G3 + W1）──────────────────
    // 旧模型是"一半一半"：表单要按底部「保存」，主图 / SKU 却即时保存 ⇒ "填了名字直接点 ✕"
    // 就是**没保存**，而「取消」不提示就关掉了（真机走查实测：用户以为存了）。
    // 三条判据都超出"按钮换了文案"：
    //   ① 编辑模式底部只有「完成」、**没有「取消」**（没有可取消的对象，留着就是骗人）；
    //   ② 改一个字段**离开输入框就落库**（不用按任何按钮），且**只写一次**（blur 与「完成」撞上时）；
    //   ③ 关掉**真的会丢**的东西（未保存的 SKU 改动）先确认；选「取消」抽屉还在，选「放弃」才关。
    step('editor-save-model');
    document.querySelector('[data-act="edit-product"]').click();
    await waitFor(function () { return !!document.querySelector('.wb-drawer [data-act="ed-autosave-hint"]'); }, 5000);
    var footBtns = Array.prototype.map.call(document.querySelectorAll('.wb-drawer .wb-dialog__foot button'), flat);
    report('编辑模式底部只剩一个「完成」，**没有「取消」**（改动已即时落库，取消没有可取消的对象）',
      footBtns.length === 1 && footBtns[0].indexOf('完成') >= 0, JSON.stringify(footBtns));
    report('抽屉自己把保存模型说清（不说明的话用户会继续找那个已经不存在的「保存」）',
      flat(document.querySelector('[data-act="ed-autosave-hint"]')).indexOf('边改边存') >= 0,
      flat(document.querySelector('[data-act="ed-autosave-hint"]')).slice(0, 50));
    // 类目是纯文本字段：blur 即存，**一个按钮都不用按**
    var catInput = document.querySelector('.wb-drawer .ed-body input[placeholder="例：家居收纳"]');
    catInput.value = '收纳';
    catInput.dispatchEvent(new Event('input'));
    catInput.dispatchEvent(new Event('blur'));
    await settle(function () { return calls('productUpsert').length >= 1; }, 6000);
    // 给"再写一次"留出机会：只判 >= 1 的话，并发写两次照样绿
    await sleep(150);
    var upSent = calls('productUpsert');
    report('⭐ 改类目后**离开输入框就落库**（没按任何按钮），且只写一次、带全字段（漏字段会清空别的列）',
      upSent.length === 1 && upSent[0].id === 1 && upSent[0].category === '收纳' &&
        upSent[0].code === 'S1' && upSent[0].supplierId === 7 && upSent[0].note === '',
      JSON.stringify(upSent));
    report('页脚给出"已自动保存"的回执（逐字段静默保存，不能再靠一闪而过的 toast）',
      !!document.querySelector('[data-act="ed-saved-hint"]'),
      flat(document.querySelector('[data-act="ed-saved-hint"]')));

    // SKU 行**刻意不自动存**（一次生成几十行，逐行 blur 存会变成几十次写）——
    // 所以必须有别的兜底：页脚常显"还有 N 条没保存"，关闭前还要确认。
    // 先等 SKU 子表**渲染出来**再取那一行（子表是异步拉的，取不到会让下面抛 TypeError
    // 把整段冒烟打断，读日志的人只看到"异常"，看不出是"子表还没来"）。
    await waitFor(function () { return !!document.querySelector('.wb-drawer .ed-sku__weight'); }, 6000);
    var dirtyWeight = document.querySelector('.wb-drawer .ed-sku__weight');
    dirtyWeight.value = '333';
    dirtyWeight.dispatchEvent(new Event('input'));
    await settle(function () { return !!document.querySelector('[data-act="ed-guard-hint"]'); }, 4000);
    report('页脚常显"还有 1 条 SKU 改动没保存"（不自动存的东西必须有别的兜底，且要**提前**说）',
      flat(document.querySelector('[data-act="ed-guard-hint"]')).indexOf('1 条 SKU 改动没保存') >= 0,
      flat(document.querySelector('[data-act="ed-guard-hint"]')));
    report('没保存的 SKU 行不该被静默写库（判据：此刻仍然只有那一次表单写入）',
      calls('productVariantUpsert').length === 1, 'calls=' + calls('productVariantUpsert').length);
    document.querySelector('.wb-drawer .ed-x').click();
    await settle(function () { return !!document.querySelector('[data-act="confirm-dialog"]'); }, 4000);
    report('带未保存的 SKU 改动点 ✕ → 先确认（不是无声关掉，"我改的没了"是新手最贵的一课）',
      flat(document.querySelector('[data-act="confirm-dialog"]')).indexOf('1 条 SKU 改动没保存') >= 0,
      flat(document.querySelector('[data-act="confirm-dialog"]')).slice(0, 50));
    await clickText('[data-act="confirm-cancel"]', '取消');
    await settle(function () { return !document.querySelector('[data-act="confirm-dialog"]'); }, 4000);
    report('确认框里选「取消」→ 抽屉**还在**（不是把"取消"当成了关闭）',
      !!document.querySelector('.wb-drawer [data-act="ed-autosave-hint"]') &&
        !document.querySelector('[data-act="confirm-dialog"]'));
    document.querySelector('.wb-drawer .ed-x').click();
    await settle(function () { return !!document.querySelector('[data-act="confirm-dialog"]'); }, 4000);
    await clickText('[data-act="confirm-ok"]', '放弃改动并关闭');
    await settle(function () { return !document.querySelector('.wb-drawer'); }, 4000);
    report('选「放弃改动并关闭」→ 抽屉真的关掉（确认框不是又一个假动作）',
      !document.querySelector('.wb-drawer'));

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
    // 左栏选款 → 右栏直连 / 对比这两条动线在物理上就不成立。
    // 同日 R1 又加回一个「店铺登记」（从市场岛收进内建，解 D1 死锁）⇒ 现在是 3 个。
    report('三个页签都在（建档与关联 / 店铺登记 / 供应商），且默认停在「建档与关联」',
      ['建档与关联', '店铺登记', '供应商'].every(function (n) { return tabNames.indexOf(n) >= 0; }) &&
        all('.gd-tabs .gd-tab').length === 3 &&
        flat(document.querySelector('.gd-tabs .gd-tab.is-active')).indexOf('建档与关联') === 0,
      tabNames);
    // 「店铺登记」的存在性**必须单独钉一条**：它对用户的意义是"队列里「需先登记店铺」那几行的出口"，
    // 而 2026-10-08 走查抓到的 D1 就是"文案让用户去登记，那个入口却不在软件里"。
    // 只断言页签名出现在 .gd-tabs 里还不够 —— 点开是空白同样等于没有（下一页的 registry 步验内容）。
    report('「店铺登记」页签有真实锚点 tab-registry（文案点名它，所以它必须在）',
      !!document.querySelector('[data-act="tab-registry"]') &&
        flat(document.querySelector('[data-act="tab-registry"]')).indexOf('店铺登记') >= 0,
      flat(document.querySelector('[data-act="tab-registry"]')) || 'missing');
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
    // 0 不占位（W2/全零，2026-10-08 R2）：此刻已关联是 0，条上**不该有**「已关联」这一项。
    // 用 indexOf < 0 而不是 /已关联 0/ 取反：后者在"这项被渲染成非 0"时也成立（假绿）。
    report('值为 0 的指标**不渲染**（"0 · 0 · 0 · — · 0"读起来像页面坏了）',
      mstats.indexOf('已关联') < 0 && mstats.indexOf('待关联') >= 0,
      mstats);
    // ── D1 死锁：出口必须**可点**，而且指向一个真的在软件里的地方 ─────────────
    // 原文是一句纯文本"请先到「店铺账号管家」的「店铺登记」…"，而那个岛不在默认包里 ——
    // 全新安装上这就是个两端都不可点的死胡同（提示不可点 + 目的地不存在）。
    // 现在：① 提示条上有一个真按钮；② 行内也有一份；③ 目的地是内建页签（下一页 registry 步验它真能开）。
    report('未归一店铺被点名，且旁边就是一个真按钮（不是一句"请先到…"的纯文本）',
      flat(document.querySelector('.gd-hints')).indexOf('新奇怪物店') >= 0 &&
        flat(document.querySelector('.gd-hints')).indexOf('店铺登记') >= 0 &&
        !!document.querySelector('[data-act="open-registry"]'),
      flat(document.querySelector('.gd-hints')).slice(0, 60));
    var openReg = document.querySelector('[data-act="open-registry"]');
    report('提示条的「现在登记」不是灰按钮（死锁的出口不能是个点不动的装饰）',
      !!openReg && !openReg.disabled,
      openReg ? 'disabled=' + openReg.disabled : 'missing');
    var blockedBtn = queueRow('TB-999').querySelector('[data-act="row-blocked"]');
    report('店铺未归一的行**关联**动作禁用且给出原因',
      !!blockedBtn && blockedBtn.disabled && flat(blockedBtn) === '需先登记店铺',
      blockedBtn ? flat(blockedBtn) + ' / disabled=' + blockedBtn.disabled : 'missing');
    // 灰因不能只躺在 title 里（触屏 / 不会悬停的人永远看不到）—— 行内紧跟一个可点的出口
    var rowReg = queueRow('TB-999').querySelector('[data-act="row-open-registry"]');
    report('同一行里有可点的「去登记」（灰因不再只藏在 title，行内就有出路）',
      !!rowReg && !rowReg.disabled,
      rowReg ? flat(rowReg) + ' / disabled=' + rowReg.disabled : 'missing');
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
    // ⚠️ 这一条原先只断言 title 里写着来源 —— 而 title 要鼠标悬停约 1 秒才浮出来，
    //    触屏与不熟鼠标的人**永远拿不到**（报告 P2-1 / C-3）。现在同时断言**常显图注**：
    //    判据从"DOM 里有这句"升级为"这句在屏幕上一直看得见"。
    report('缩略图的来源写在**常显图注**上（不是只躺在 title 里 —— 悬停信息触屏拿不到）',
      !!b0Thumb && flat(b0Thumb.parentNode.querySelector('[data-act="q-thumb-src"]')).indexOf('订单') >= 0,
      b0Thumb ? flat(b0Thumb.parentNode.querySelector('[data-act="q-thumb-src"]')) : 'missing');
    report('「这张图能点开看大图」有常显角标（原先是 title 里的一句话）',
      !!b0Thumb && !!b0Thumb.querySelector('.gd-thumb-btn__zoom'));
    report('订单里没图的商品显示空占位，不是破图（有图 / 没图要能分开看）',
      !!queueRow('SKU-A1').querySelector('[data-act="q-thumb-empty"]') &&
        !queueRow('SKU-A1').querySelector('[data-act="q-thumb"]'));
    // "没有图"必须是**看得见的一句话**：图是认款的主要依据，没有图这件事不能只挂在 title 上
    report('没图那一行的图注直接写「没有图」（用户不必靠悬停去猜为什么这里是空的）',
      flat(queueRow('SKU-A1').querySelector('[data-act="q-thumb-src"]')).indexOf('没有图') >= 0,
      flat(queueRow('SKU-A1').querySelector('[data-act="q-thumb-src"]')));

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

    // ── B1：认款之后，左栏「已关联商品」必须跟着更新 ────────────────────
    // 真机实测的现行缺陷：loadLinks 拉过一次（哪怕空数组）就**不再重拉** ⇒ 右栏刚写完
    // （指标条变「已关联 3」）而左栏同一屏仍写旧值，刷新按钮/重新展开都无效，只有重启才恢复。
    // 用户刚做完一件"大事"却立刻看到两个互相矛盾的数字 —— 对不会电脑的人，这不叫 bug，叫"这软件靠不住"。
    // 这一步之前刚把 S2 展开过（那时它只有 1 条 confirmed），随后认款给它加了 2 条 ⇒ 现在必须是 3。
    step('links-fresh');
    await settle(function () {
      var d = document.querySelector('[data-act="detail-links"]');
      return !!d && flat(d).indexOf('B0XYZ1234') >= 0;
    }, 6000);
    var linksBlock = document.querySelector('[data-act="detail-links"]');
    var linksHead = linksBlock ? linksBlock.parentElement.querySelector('.gd-detail__head') : null;
    report('认款后左栏「已关联商品」是**新值**（缓存不刷新的话永远停在首次展开时那一条）',
      !!linksBlock &&
        linksBlock.querySelectorAll('[data-act="detail-link"]').length === 3 &&
        !!linksHead && flat(linksHead).indexOf('3 个店铺商品') >= 0,
      'rows=' + (linksBlock ? linksBlock.querySelectorAll('[data-act="detail-link"]').length : 'no-block') +
        ' head=' + (linksHead ? flat(linksHead) : 'none'));

    // ── B2 反向守卫：没有"还没列出的组"时，「显示更多」必须**不存在** ────
    // 此刻 2 行待关联已被认掉、队列里只剩 1 行店铺未归一：待办总数（unmapped + shopUnresolved）
    // 恰好等于已列出数 ⇒ 不该有"显示更多"。旧判据 groups > shown 在这里**恒真**
    // （groups 数的是"聚合出的全部组"，含已关联的），于是渲染出一个点了纹丝不动的按钮 ——
    // 这正是本仓既有结论"假动作"的现行犯。
    report('队列已列完时「显示更多」不存在（判据是"还有没有没列出的组"，不是 groups > shown）',
      !document.querySelector('[data-act="queue-more"]'),
      'btn=' + !!document.querySelector('[data-act="queue-more"]') +
        ' 计数=' + flat(document.querySelector('[data-act="queue-count"]')));

    // ── 夹具复位：上面那条动线把两行待关联商品消耗掉了 ──────────────
    step('reset');
    report('夹具复位：队列回到 3 行（直连消耗掉的两行回来了，后续场景各自从干净态开始）',
      await resetFixture(), 'rows=' + all('[data-act="queue-table"] tbody tr[data-item-id]').length);

    // ── W3（2026-10-08 R2）：认款入口必须在**视线焦点**上 ────────────────
    // 真机走查：用户点开左边一款之后眼睛在左栏，而当时唯一的认款按钮在**右栏顶部** ——
    // 中间隔着一个栏宽。这里是同一个动作的第二处入口（左栏展开区第一行）。
    //
    // ⚠️ 判据必须超出"按钮存在"，否则把「@relate-request」接到一个空函数上照样全绿：
    //   ① 没勾选时它是灰的，且灰因写在旁边（不是只藏在 title）；
    //   ② 勾了 2 项它自己亮起来并把项数写在脸上；
    //   ③ **按下去真的写出那 2 行、且落到展开的那一款**（S2 / id=2）—— 写死"第一行"的实现在这里红。
    step('relate-from-expanded');
    var rfBtn = document.querySelector('[data-act="relate-from-expanded"]');
    report('展开区里有认款入口，没勾选时是灰的，且灰因就写在旁边（不是只藏在 title 里）',
      !!rfBtn && rfBtn.disabled &&
        flat(document.querySelector('[data-act="relate-hint"]')).indexOf('先在右栏勾选') >= 0,
      rfBtn
        ? 'disabled=' + rfBtn.disabled + ' hint=' + flat(document.querySelector('[data-act="relate-hint"]'))
        : 'missing');
    all('[data-act="queue-table"] tbody tr[data-item-id] input[type="checkbox"]')
      .filter(function (c) { return !c.disabled; })
      .forEach(function (b) { b.click(); });
    await settle(function () {
      var b = document.querySelector('[data-act="relate-from-expanded"]');
      return !!b && !b.disabled;
    }, 4000);
    rfBtn = document.querySelector('[data-act="relate-from-expanded"]');
    report('右栏勾了 2 项后，左栏那个按钮自己亮起来（跨栏状态真的转过来了）',
      !!rfBtn && !rfBtn.disabled && flat(rfBtn).indexOf('（2 项）') >= 0 &&
        flat(document.querySelector('[data-act="relate-hint"]')).indexOf('2 个商品') >= 0,
      rfBtn ? flat(rfBtn) + ' | ' + flat(document.querySelector('[data-act="relate-hint"]')) : 'missing');
    rfBtn.click();
    // ⚠️ 等待与判定**分开**：waitFor 超时会中断整段冒烟、把后面几十条断言一起吞掉，
    //    读日志的人只看到"timeout @ relate-from-expanded"，看不出是"根本没写库"。
    //    这里用有界轮询等它出现，再由 report 给出可读 FAIL（并让后面的断言继续跑）。
    await settle(function () { return calls('productSkuMap').length >= 1; }, 6000);
    var viaLeft = (calls('productSkuMap')[0] || {}).rows || [];
    report('⭐ 左栏那个按钮按下去**真的写库**（一次 2 行，且落到展开的 S2 —— 与右栏直连同一条写路径）',
      viaLeft.length === 2 && viaLeft.every(function (r) { return r.productId === 2; }),
      'calls=' + calls('productSkuMap').length + ' ' + JSON.stringify(viaLeft));
    report('左栏入口写入的颜色也落 *（它同样没有选色的机会，不替用户猜）',
      viaLeft.length === 2 && viaLeft.every(function (r) { return r.spec === '*'; }),
      JSON.stringify(viaLeft.map(function (r) { return r.spec; })));
    await settle(function () { return all('[data-act="queue-table"] tbody tr[data-item-id]').length === 1; }, 6000);
    report('写完队列重拉（两处入口一条写路径 ⇒ 不存在第二套失败语义）',
      all('[data-act="queue-table"] tbody tr[data-item-id]').length === 1,
      'rows=' + all('[data-act="queue-table"] tbody tr[data-item-id]').length);
    // 夹具复位：这一步也把 2 行消耗掉了，后面的对比场景要从干净态开始
    report('夹具复位：队列回到 3 行（左栏入口消耗掉的两行回来了）',
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

    // ── 失效汇总入口（报告 P1-4 / D-2）──────────────────────────────────
    // 原先要处理失效的行，得**先自己想到**去「状态筛选」里选「已失效」——
    // 而"还有几条失效没处理"这件事界面上没有任何地方说（「恢复」也只长在失效行身上）。
    // 这一组守四件事，缺一条就会退化成"多了个按钮"：
    //   ① 它带着**正数**出现（0 时不许渲染 —— 否则就是 R2 刚删掉的那种"0 占位"）；
    //   ② 按下去**真的筛**（发出去的 status = 'invalid'，不是界面自己过滤）；
    //   ③ 筛完它自己让位给一句状态说明（不留一个按下去没反应的按钮）；
    //   ④ 把筛选放回「全部状态」后它回来（两个方向都真）。
    step('mapped-invalid-entry');
    var invBtn = document.querySelector('[data-act="mapped-invalid-only"]');
    report('有失效行时给出「有 N 条已失效 → 只看它们」的汇总入口',
      !!invBtn && /[1-9][0-9]* 条已失效/.test(flat(invBtn)),
      invBtn ? flat(invBtn) : 'missing');
    if (invBtn) invBtn.click();
    await settle(function () { return !!document.querySelector('[data-act="mapped-invalid-on"]'); }, 4000);
    report('按下去真的只筛失效（筛选参数发给主进程，不是界面自己过滤）',
      calls('productSkuList').length >= 1 &&
        calls('productSkuList').slice(-1)[0].status === 'invalid' &&
        !!document.querySelector('[data-act="mapped-invalid-on"]'),
      JSON.stringify(calls('productSkuList').slice(-1)[0]));
    report('筛完那个按钮自己让位（不留一个按下去没反应的按钮）',
      !document.querySelector('[data-act="mapped-invalid-only"]'));
    setVal(document.querySelector('[data-act="mapped-status"]'), '');
    await settle(function () { return !document.querySelector('[data-act="mapped-invalid-on"]'); }, 4000);
    report('状态筛选放回「全部状态」后汇总入口回来（两个方向都真）',
      !!document.querySelector('[data-act="mapped-invalid-only"]'),
      flat(document.querySelector('[data-act="mapped-invalid-only"]')));
    // 反向：库里**一条失效都没有**时，这个入口不许出现。
    // 少了这一条，上面那几条只证明"它有正数时会出现"——**"0 也渲染"这个错照样全绿**
    // （2026-10-08 变异复核实测：M6 只改掉条数守卫时一条都没红，就是缺了这一步）。
    window.__smokeNoInvalid = true;
    await clickText('[data-act="refresh"]', '刷新');
    // 等到"入口从条上消失"为止：**有界 8s、超时不抛**，判定在下面那条 report 里。
    // ⚠️ 不能改成"等表格有行"或"等汇总被多取一次"这类**中性**信号：
    //    上一步 setVal 触发的重拉可能刚好晚一拍落地，中性信号会被**上一次**请求满足
    //    ⇒ 断言读到的是刷新前那份汇总（2026-10-08 实测：先出现 rows=6 btn=true，
    //    改成数汇总次数后仍出现 btn=true 且"汇总重取=1" —— 就是被上一条请求喂饱的）。
    await settle(function () { return !document.querySelector('[data-act="mapped-invalid-only"]'); }, 8000);
    report('库里一条失效都没有时，汇总入口**不出现**（不许渲染"有 0 条已失效"这种 0 占位）',
      !document.querySelector('[data-act="mapped-invalid-only"]') &&
        !document.querySelector('[data-act="mapped-invalid-on"]'),
      'rows=' + all('[data-act="mapped-table"] tbody tr[data-item-id]').length +
        ' btn=' + !!document.querySelector('[data-act="mapped-invalid-only"]'));
    window.__smokeNoInvalid = false;
    await clickText('[data-act="refresh"]', '刷新');
    await settle(function () { return !!document.querySelector('[data-act="mapped-invalid-only"]'); }, 8000);
    report('把失效行放回去 → 入口回来（不是"检查过一次就再也不出现"）',
      !!document.querySelector('[data-act="mapped-invalid-only"]'));

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

    // ── 悬停信息改常显（报告 P2-1 / C-3）────────────────────────────────
    // 原先「来源 / 更新时间」整行折进 title —— 悬停约 1 秒才浮出来，触屏拿不到，
    // 不熟鼠标的人根本发现不了。现在：**来源**改成行内常显小字（它回答"这条凭什么信"，
    // 每条都要看），**更新时间**仍留 title（它只在"最近动过吗"时才用，常显会把每行撑长）。
    var srcCells = all('[data-act="mapped-table"] [data-act="m-source"]');
    report('已映射行的**来源**常显（原先只在行 title 里，触屏与不熟鼠标的人拿不到）',
      srcCells.length >= 1 && srcCells.every(function (e) { return /手工|导入|智能建议/.test(flat(e)); }),
      srcCells.length + ' 行：' + srcCells.map(flat).join(' / '));
    var mImgCaps = all('[data-act="mapped-table"] [data-act="m-thumb-src"]');
    report('已映射行的图注也常显（有图写来源 / 没图写「没有图」，一句话都不靠悬停）',
      mImgCaps.length >= 1 && mImgCaps.every(function (e) { return flat(e).length > 0; }),
      mImgCaps.length + ' 行：' + mImgCaps.map(flat).join(' / '));

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

    // ── 「显示更多」必须是**真动作**（B2 的正向半边）─────────────────────
    // 反向半边（没有更多时不渲染按钮）已在 links-fresh 那步钉过。这一半钉"真的还有没列出的组时，
    // 点下去要真的多列出来"：夹具造 205 组待办，初始上限 200 ⇒ 已列出 200、「显示更多」在；
    // 点一下 ⇒ 205 组全列出、按钮消失。
    // ⚠️ 只有"待办总数 > 已列出"的样本才分得清"点了不动"和"真的多列了" —— 默认夹具只有 3 组，
    //    永远到不了上限，拿它验这条会恒绿（等于没测）。
    step('queue-more');
    // 上一步停在「供应商」页签、且分段控件停在「已建立映射」—— 先切回来（幂等）。
    await clickText('.gd-tabs .gd-tab', '建档与关联');
    await clickText('[data-act="sub-queue"]', '待关联队列');
    window.__smokeQueueMany = true;
    await clickText('[data-act="map-refresh"]', '刷新');
    await settle(function () { return all('[data-act="queue-table"] tbody tr[data-item-id]').length === 200; }, 10000);
    report('待办 205 组 > 单页上限 200：已列出 200 组、「显示更多」出现',
      all('[data-act="queue-table"] tbody tr[data-item-id]').length === 200 &&
        !!document.querySelector('[data-act="queue-more"]'),
      'rows=' + all('[data-act="queue-table"] tbody tr[data-item-id]').length +
        ' btn=' + !!document.querySelector('[data-act="queue-more"]'));
    var moreBtn = document.querySelector('[data-act="queue-more"]');
    await settle(function () { return !!moreBtn && !moreBtn.disabled; }, 6000);
    if (moreBtn && !moreBtn.disabled) moreBtn.click();
    await settle(function () { return all('[data-act="queue-table"] tbody tr[data-item-id]').length === 205; }, 10000);
    report('点「显示更多」→ 真的多列出 5 组，按钮随之消失（不是点了纹丝不动）',
      all('[data-act="queue-table"] tbody tr[data-item-id]').length === 205 &&
        !document.querySelector('[data-act="queue-more"]'),
      'rows=' + all('[data-act="queue-table"] tbody tr[data-item-id]').length +
        ' btn=' + !!document.querySelector('[data-act="queue-more"]'));
    window.__smokeQueueMany = false;

    // ── 空态必须是**入口**，不是提示 ──────────────────────────────────
    // 「映射与关联」的队列是这一页唯一"从订单里长出来"的东西，而导入订单只在「今天」页。
    // 原先空态只写一句"导入订单后…"，用户得自己去找「今天」在哪 —— 这类"提示只说有问题、
    // 动作藏在别处"的形态 2026-10-03 被定名过（见 docs/notes 的「提示不是入口」）。
    // ⚠️ 夹具默认的队列里**始终留着** 1 行"店铺未归一"的样本（TB-999，那是"未归一不可关联"的
    //    守卫），空态永远进不去 ⇒ 这里临时把队列置空，专门验空态的形态。
    //    若不动这个开关，"空态有按钮"这条断言会因为组件没渲染而**恒绿**（等于没测）。
    step('empty-entry');
    // ⚠️ 先复位夹具：本步到了这里，会话里**已经写过映射**（「batch-map」「rebind」那两步），
    //    「已关联 N」会照常渲染 ⇒ 指标条上还剩非 0 项，"全零说一句人话"那条判据永远走不到
    //    （断言会恒绿）。复位同时也让紧随其后的「registry」步回到"还没登记过"的初始态。
    window.__smokeReset();
    window.__smokeEmptyQueue = true;
    // S4 起不再需要"切回映射视图"：只有一个工作台页签。仍然显式点一次（幂等），
    // 理由同 queue 步 —— 别让"默认页签被改错"变成后面断言集体失败的假象。
    await clickText('.gd-tabs .gd-tab', '建档与关联');
    // ⚠️ 必须显式刷新一次：本步之前工作台**可能已经挂载**（那就点页签是幂等的、不会重新取数），
    //    "切页签会重新挂载"只是副作用，不能当成取数保证（2026-10-08 实测：上一轮新增 queue-more
    //    之后工作台已挂载 ⇒ 空队列信号推不下去 ⇒ 这一步 timeout）。
    await clickText('[data-act="refresh"]', '刷新');
    await waitFor(function () { return !!document.querySelector('[data-act="go-today"]'); }, 6000);
    report('队列为空时给出「去「今天」导入订单」的真入口（不是一句"导入订单后…"）',
      flat(document.querySelector('[data-act="go-today"]')).indexOf('今天') >= 0,
      flat(document.querySelector('[data-act="go-today"]')));
    // 全零的另一端（W2/全零）：五项全零时**一项都不列**，改说一句人话。
    // 「null」（队列没拉过）不能走进这一句 —— 那会替用户宣布一个它不知道的结论
    //（2026-10-08-goods-page-entry-guide.md 第 4 条）。夹具此刻「withoutItemId」已归零。
    await settle(function () { return !!document.querySelector('[data-act="map-allclear"]'); }, 6000);
    var zeroBar = flat(document.querySelector('[data-act="map-stats"]'));
    report('全零时指标条不铺一排 0，改说一句人话（且不再出现"关联率 —"这种无从计算的项）',
      zeroBar.indexOf('待关联') < 0 && zeroBar.indexOf('关联率') < 0 &&
        zeroBar.indexOf('队列里还没有待认的店铺商品') >= 0,
      zeroBar);
    // 反向守卫（首次动线 R3）：此刻是"队列空但**有款**"——引导卡**不该**出现。
    // 它的判据是那条链的**两端同时为零**，不是"有一端为零就显示"。
    report('队列空但有款 → 首启引导卡不出现（判据是两端同时为零，不是"一条不满足就显示"）',
      !document.querySelector('[data-act="first-run-card"]'));

    // ── 首次动线（R3 · UX-G4）：空库那张卡 ───────────────────────────────
    // 判据是"零款 + 队列已拉过且为空"——**两个条件都不容易造**，所以夹具两个开关一起用：
    // __smokeEmptyProducts 造零款、__smokeEmptyQueue 造空队列。
    // 少造任何一个，这张卡要么恒不出现（等于没测），要么在有货的库里冒出来（真机上没人会看见）。
    // ⚠️ 断言必须超出"卡出现了"：三步的顺序、两步有真按钮、第三步**刻意没有**按钮，各是一条。
    step('first-run');
    window.__smokeEmptyProducts = true;
    window.__smokeEmptyQueue = true;
    await clickText('[data-act="refresh"]', '刷新');
    await settle(function () { return !!document.querySelector('[data-act="first-run-card"]'); }, 8000);
    var fr = document.querySelector('[data-act="first-run-card"]');
    report('零款 + 队列已拉过且为空 → 首启引导卡出现（全新安装的唯一时刻）', !!fr);
    report('卡上恰好三步、顺序是 订单 → 店铺 → 认款（顺序错了这三步就不成立）',
      !!fr && all('[data-act="first-run-card"] .gd-firstrun__step').length === 3 &&
        !!document.querySelector('[data-act="fr-step-orders"]') &&
        !!document.querySelector('[data-act="fr-step-shops"]') &&
        !!document.querySelector('[data-act="fr-step-relate"]'),
      fr ? 'steps=' + all('[data-act="first-run-card"] .gd-firstrun__step').length : 'missing');
    report('前两步都带**真按钮**（不是"请先去别处导入"那种纯文本提示）',
      !!document.querySelector('[data-act="fr-import-orders"]') &&
        !!document.querySelector('[data-act="fr-open-registry"]'));
    report('第 3 步**刻意不给按钮**（它的动作就是"回到这一页"，给按钮只能是把当前页再切一次）',
      !!document.querySelector('[data-act="fr-step-here"]') &&
        !document.querySelector('[data-act="fr-step-relate"] button'),
      flat(document.querySelector('[data-act="fr-step-here"]')));
    // 有款之后必须自己消失 —— "做完即消失"不是靠用户去关它（那种「我知道了」按钮
    // 只会造出一个查不出原因的持久状态）。
    window.__smokeEmptyProducts = false;
    await clickText('[data-act="refresh"]', '刷新');
    await settle(function () { return !document.querySelector('[data-act="first-run-card"]'); }, 8000);
    report('有款之后引导卡**自己消失**（不需要用户去点"我知道了"）',
      !document.querySelector('[data-act="first-run-card"]'));
    // 反向二：零款但**订单已经进了队列** → 同样不出现（链的另一端不满足）。
    window.__smokeEmptyProducts = true;
    window.__smokeEmptyQueue = false;
    await clickText('[data-act="refresh"]', '刷新');
    await settle(function () { return all('[data-act="queue-table"] tbody tr[data-item-id]').length >= 1; }, 8000);
    report('零款但订单已进队列 → 引导卡也不出现（那时该做的是认款，不是"从零开始"）',
      !document.querySelector('[data-act="first-run-card"]') &&
        all('[data-act="queue-table"] tbody tr[data-item-id]').length >= 1,
      'rows=' + all('[data-act="queue-table"] tbody tr[data-item-id]').length);
    // 复原：后面的「店铺登记」端到端要的是"3 行队列 + 真有款"的初始态
    window.__smokeEmptyProducts = false;
    window.__smokeEmptyQueue = false;
    await clickText('[data-act="refresh"]', '刷新');
    await settle(function () { return all('[data-act="queue-table"] tbody tr[data-item-id]').length === 3; }, 8000);

    // ── 「店铺登记」：D1 死锁的**端到端**验证 ────────────────────────────
    // 走的正是用户真会走的那条路：右栏提示条点「现在登记」→ 在名单里采纳 → 回队列 →
    // 那一行从「需先登记店铺」变成「可以关联」。
    //
    // ⚠️ 为什么必须端到端，而不是"页签能打开"就够：这个 bug 的本质是**两端接不上**
    //    （出口不存在 / 出口指向的地方不在软件里）。夹具若在店铺侧和队列侧各造一套互不
    //    相干的店名，界面照样全绿，而用户走完这一圈**什么都不会变** —— 那正是恒绿断言。
    //    所以夹具两端共用同一个店名（「新奇怪物店」），并且登记后队列那一行真的放行。
    step('registry');
    window.__smokeEmptyQueue = false; // 上一步为了验空态把它置空了
    window.__smokeQueueMany = false;
    await clickText('[data-act="refresh"]', '刷新');
    await settle(function () { return !!document.querySelector('[data-act="open-registry"]'); }, 8000);

    await clickText('[data-act="open-registry"]', '现在登记');
    await settle(function () { return !!document.querySelector('[data-act="registry-view"]'); }, 8000);
    report('提示条上的「现在登记」真的切到「店铺登记」（且是**页内**跳转，没离开「货与成本」）',
      isShown(document.querySelector('[data-act="registry-view"]')) &&
        flat(document.querySelector('.gd-tabs .gd-tab.is-active')).indexOf('店铺登记') >= 0 &&
        !!document.querySelector('.gd-view'),
      'active=' + flat(document.querySelector('.gd-tabs .gd-tab.is-active')));

    await settle(function () {
      return all('[data-act="reg-unmapped-table"] tbody tr[data-shop-key]').length === 2;
    }, 8000);
    var unmappedKeys = all('[data-act="reg-unmapped-table"] tbody tr[data-shop-key]').map(function (tr) {
      return tr.getAttribute('data-shop-key');
    });
    report('未归一名单渲染 2 条（唯一命中 + 歧义各一条；少了歧义那条，「不猜」就没人守了）',
      unmappedKeys.length === 2 && unmappedKeys.indexOf('新奇怪物店') >= 0 && unmappedKeys.indexOf('gaia') >= 0,
      JSON.stringify(unmappedKeys));

    var uniqueRow = document.querySelector('[data-act="reg-unmapped-table"] tbody tr[data-shop-key="新奇怪物店"]');
    var ambRow = document.querySelector('[data-act="reg-unmapped-table"] tbody tr[data-shop-key="gaia"]');
    report('唯一命中的行给「采纳：Aurora Store」（带上店名，人才能核对再点）',
      !!uniqueRow && !!uniqueRow.querySelector('[data-act="reg-take"]') &&
        flat(uniqueRow.querySelector('[data-act="reg-take"]')).indexOf('Aurora Store') >= 0,
      uniqueRow ? flat(uniqueRow).slice(0, 60) : 'missing');
    report('歧义行**没有**「采纳」（同名两平台必须让人来选 —— 恒渲染采纳的话上面那条就变恒真了）',
      !!ambRow && !ambRow.querySelector('[data-act="reg-take"]'),
      ambRow ? 'take=' + !!ambRow.querySelector('[data-act="reg-take"]') : 'missing');
    // 「不预选」：指派下拉的默认值必须是"未选择"。预选第一家店（按位置取默认）会把
    // "读错了对象"伪装成"对象本身有问题" —— 用户点一下就静默把名字归到错误的店上。
    var regSel = uniqueRow ? uniqueRow.querySelector('select') : null;
    report('指派下拉**不预选**（默认空值）且选项里有全部已登记店铺',
      !!regSel && regSel.value === '' && regSel.options.length >= 3,
      regSel ? 'value=' + JSON.stringify(regSel.value) + ' options=' + regSel.options.length : 'missing');
    report('没选店时「指派」是灰的（不预选 ⇒ 必须自己先选，不可能误点）',
      !!uniqueRow && !!uniqueRow.querySelector('[data-act="reg-assign"]') &&
        uniqueRow.querySelector('[data-act="reg-assign"]').disabled,
      uniqueRow ? 'disabled=' + uniqueRow.querySelector('[data-act="reg-assign"]').disabled : 'missing');

    await settle(function () { return all('[data-act="reg-shop-table"] tbody tr[data-shop-id]').length === 2; }, 6000);
    report('已登记店铺渲染 2 行（与名单同源的那两家店）',
      all('[data-act="reg-shop-table"] tbody tr[data-shop-id]').length === 2,
      'rows=' + all('[data-act="reg-shop-table"] tbody tr[data-shop-id]').length);
    // 反向守卫：店铺实体表里**不许**出现「账号套装」列 —— 那个字段在宿主内零消费者
    // （全仓只有岛和它自己的表读），摆在这里只会让人看不懂又不敢删。值仍然透传（见下一条断言）。
    var shopHead = all('[data-act="reg-shop-table"] thead th').map(flat);
    report('店铺表不含「账号套装」列（宿主内零消费者的字段不该占一列）',
      shopHead.indexOf('账号套装') < 0, shopHead.join('|'));

    // ⭐ **全量提交**的坑：shopUpsert 缺省即空 —— 界面上没有的字段必须原样送回，
    //    否则"编辑一次店铺名"就把 platformShopId / shopSetId 静默清空（岛时代踩过，这次
    //    刻意不给这两个控件，所以只有这条断言能证明它们没被清掉）。
    document.querySelector('[data-shop-id="12"] [data-act="reg-edit"]').click();
    await settle(function () { return !!document.querySelector('.wb-drawer [data-act="reg-save"]'); }, 6000);
    await clickText('[data-act="reg-save"]', '保存');
    await waitFor(function () { return calls('shopUpsert').length >= 1; }, 6000)
      .catch(function () { throw new Error('编辑保存没发出 shopUpsert：界面错误=' + flat(document.querySelector('.wb-notice--error'))); });
    var up = calls('shopUpsert')[0];
    report('编辑保存把界面上**没有控件**的字段原样送回（platformShopId / shopSetId 不被清空）',
      Number(up.id) === 12 && up.platformShopId === 'A1B2C3D4' && Number(up.shopSetId) === 7 &&
        up.platform === 'amazon' && up.name === 'Aurora Store',
      JSON.stringify(up));

    await clickText('[data-act="reg-take"]', '采纳');
    await waitFor(function () { return calls('shopMap').length >= 1; }, 6000)
      .catch(function () { throw new Error('采纳没发出 shopMap：界面错误=' + flat(document.querySelector('.wb-notice--error'))); });
    var mp = calls('shopMap')[0];
    report('采纳写的正是「原始店名 → 店铺id」这一条映射（不写别的、不顺手改订单）',
      String(mp.raw) === '新奇怪物店' && Number(mp.refId) === 12 && mp.ignored !== true,
      JSON.stringify(mp));
    await settle(function () {
      return all('[data-act="reg-unmapped-table"] tbody tr[data-shop-key]').length === 1;
    }, 6000);
    var leftKeys = all('[data-act="reg-unmapped-table"] tbody tr[data-shop-key]').map(function (tr) {
      return tr.getAttribute('data-shop-key');
    });
    report('登记完这条就离开名单（名单是实时算出来的，不是缓存）',
      leftKeys.length === 1 && leftKeys[0] === 'gaia', JSON.stringify(leftKeys));

    // ── 回到队列：死锁真的解开了吗 ────────────────────────────────────
    step('registry-back');
    await clickText('.gd-tabs .gd-tab', '建档与关联');
    await settle(function () {
      return !!document.querySelector('[data-act="queue-table"] tbody tr[data-item-id="TB-999"] [data-act="row-relate"]');
    }, 10000);
    var afterRow = queueRow('TB-999');
    report('⭐ 登记完回队列：那一行**真的能关联了**（「需先登记店铺」整段消失，端到端闭环）',
      !!afterRow && !!afterRow.querySelector('[data-act="row-relate"]') &&
        !afterRow.querySelector('[data-act="row-open-registry"]') &&
        !afterRow.querySelector('[data-act="row-blocked"]'),
      afterRow ? flat(afterRow).slice(0, 80) : 'missing');
    var afterCb = afterRow ? afterRow.querySelector('input[type="checkbox"]') : null;
    report('同一行的复选框也不再禁用（平台已经从店铺实体取到了）', !!afterCb && !afterCb.disabled);
    // ⚠️ 断言随 R2 的「0 不占位」一起改了**判据**，没有丢掉它要守的那件事：
    //    原判据是「/店铺未归一 0/」（= 那一项被渲染成 0）。现在值归 0 的这一项**整项不渲染**，
    //    所以"回落为 0"表现为**这一项从条上消失** —— 比渲染一个 0 更强的陈述，
    //    而且它顺带守住了"别把 0 又铺回来"。
    var afterBar = flat(document.querySelector('[data-act="map-stats"]'));
    report('「店铺未归一」归 0 后**整项从指标条上消失**（不留"0"占位），提示条也整条消失（不留没人能处理的假待办）',
      afterBar.indexOf('店铺未归一') < 0 && !document.querySelector('[data-act="open-registry"]'),
      afterBar);

    // ── W4：单项时不说「批量」（2026-10-08 R2）────────────────────────
    // 批量是一个承诺（一次写多行、一次事务、一次回执）；只有 1 行时它什么都没兑现，
    // 反而让人以为自己勾错了。判据必须在**只勾 1 项**的场景下取 —— 一直有 2 项勾着的话，
    // 单项措辞永远走不到，这条断言会变成恒绿。
    step('batch-label');
    var oneBox = all('[data-act="queue-table"] tbody tr[data-item-id] input[type="checkbox"]')
      .filter(function (c) { return !c.disabled; })[0];
    report('此刻确实有可勾选的行走得到（没有的话下面两条会变成假绿）', !!oneBox);
    oneBox.click();
    await settle(function () {
      return flat(document.querySelector('[data-act="queue-batch"]')).indexOf('关联选中 1 项') >= 0;
    }, 4000);
    var oneLabel = flat(document.querySelector('[data-act="queue-batch"]'));
    report('只勾 1 项时按钮**不说「批量」**（措辞跟着项数走，不是写死的字符串）',
      oneLabel.indexOf('批量') < 0 && oneLabel.indexOf('关联选中 1 项') >= 0, oneLabel);
    all('[data-act="queue-table"] tbody tr[data-item-id] input[type="checkbox"]')
      .filter(function (c) { return !c.disabled; })[1].click();
    await settle(function () {
      return flat(document.querySelector('[data-act="queue-batch"]')).indexOf('批量关联选中 2 项') >= 0;
    }, 4000);
    report('勾到 2 项时「批量」回来（真的是随项数变，不是把"批量"两个字删了）',
      flat(document.querySelector('[data-act="queue-batch"]')).indexOf('批量关联选中 2 项') >= 0,
      flat(document.querySelector('[data-act="queue-batch"]')));
    await clickText('[data-act="queue-clear"]', '清空选择');
    await settle(function () {
      return flat(document.querySelector('[data-act="queue-batch"]')).indexOf('关联选中 0 项') >= 0;
    }, 4000);

    // ── 应用内帮助（R3 · UX-G5）────────────────────────────────────────
    // 全仓原先**没有任何用户可见的帮助入口**（src/** 里"教|教程|帮助|引导|新手|指南"的命中
    // 全是代码注释），而 docs/guides/USER_GUIDE.md 描述的是「TV模版」时代的界面。
    // 判据必须超出"有个 ? 按钮"：面板真的开、有三句话、有那张三步图、两个按钮**真的能用** ——
    // 不然把内容换成一句"请自行查阅文档"照样全绿，而那正是被否掉的那种"帮助"。
    step('help');
    var helpBtn = document.querySelector('[data-act="help"]');
    report('页头有「?」帮助入口（原先一个都没有）', !!helpBtn, helpBtn ? flat(helpBtn) : 'missing');
    report('帮助面板默认**关着**（没有打开的面板不该占着一块界面 / 盖住列表）',
      !document.querySelector('[data-act="help-panel"]'));
    if (helpBtn) helpBtn.click();
    await settle(function () { return !!document.querySelector('[data-act="help-panel"]'); }, 4000);
    var helpPanel = document.querySelector('[data-act="help-panel"]');
    report('点「?」打开面板，且里面有**三句**"这页怎么用"（不是一句"请查阅用户指南"）',
      !!helpPanel && helpPanel.querySelectorAll('.gd-help__body > p').length >= 3,
      helpPanel ? 'p=' + helpPanel.querySelectorAll('.gd-help__body > p').length : 'missing');
    report('面板里有那张三步图（与首启引导卡**同一份** steps，不是各写一套）',
      !!helpPanel && helpPanel.querySelectorAll('.gd-help__steps li').length === 3,
      helpPanel ? 'steps=' + helpPanel.querySelectorAll('.gd-help__steps li').length : 'missing');
    report('帮助里的动作是**真按钮**（"提示不是入口"：只说"你应该先去别处"的帮助不算入口）',
      !!helpPanel && !!helpPanel.querySelector('[data-act="help-go-today"]') &&
        !!helpPanel.querySelector('[data-act="help-go-registry"]'));
    report('帮助面板说明"认款落到哪一款看**展开**的那一行"（这正是本页最容易写错款的一处）',
      !!helpPanel && flat(helpPanel).indexOf('展开') >= 0,
      helpPanel ? flat(helpPanel).slice(0, 40) : 'missing');
    // 真的能用：点它 → 切到「店铺登记」，且面板自己关掉（不留在屏幕上挡着刚打开的那一页）
    if (helpPanel) helpPanel.querySelector('[data-act="help-go-registry"]').click();
    await settle(function () {
      return flat(document.querySelector('.gd-tabs .gd-tab.is-active')).indexOf('店铺登记') >= 0;
    }, 8000);
    report('帮助里的「打开「店铺登记」」真的切过去（不是个装饰按钮）',
      flat(document.querySelector('.gd-tabs .gd-tab.is-active')).indexOf('店铺登记') >= 0 &&
        !document.querySelector('[data-act="help-panel"]'),
      'active=' + flat(document.querySelector('.gd-tabs .gd-tab.is-active')));

    /* -------------------------------------------------------------------------
       Excel 导入 / 导出：模板改列（去「类目」、加「图片 / 颜色 / 尺码 / 克重」）之后，
       这条链在**四个地方**各有一份实现，任何一处没跟上都是静默错误：
         ① 渲染层算表头与行（纯函数，vitest 覆盖）
         ② 主进程写 xlsx 与嵌图（product-xlsx-smoke 覆盖）
         ③ 库层落 SKU / 保留类目（product-db-smoke 覆盖）
         ④ **界面**：预览表渲染哪几列、发出去的 items 长什么样（这一条只有本段能测）
       本段的两个"最值钱"的断言：
         · ⭐ 发出去的 items **没有 category** —— 有它就会把已存在的款的类目清空；
         · ⭐ 图贴给的是**抽图报的那一行**（第 4 行），不是"顺位第一个有数据的行"。
       ------------------------------------------------------------------------- */
    step('import-export');
    await clickText('.gd-tabs .gd-tab', '建档与关联');
    await settle(function () { return !!document.querySelector('[data-act="import-excel"]'); }, 8000);
    report('左栏工具栏：导出 / 导入 Excel 都是真按钮',
      !!document.querySelector('[data-act="export-products"]') &&
        !!document.querySelector('[data-act="import-excel"]'));

    // ── 导出：渲染层给"每格写什么 + 每行的图路径"，主进程只写格子 + 嵌图 ──
    var exBefore = calls('productExport').length;
    var exBtn = document.querySelector('[data-act="export-products"]');
    if (exBtn) exBtn.click();
    await settle(function () { return calls('productExport').length > exBefore; }, 8000);
    var exPayload = calls('productExport')[calls('productExport').length - 1] || {};
    var exHeads = exPayload.headers || [];
    report('导出换成新形状：给的是 headers / rows / imageColumn（不再是渲染层生成的 buffer）',
      Array.isArray(exPayload.headers) && Array.isArray(exPayload.rows) &&
        typeof exPayload.imageColumn === 'number',
      JSON.stringify({ heads: exHeads.length, rows: (exPayload.rows || []).length, col: exPayload.imageColumn }));
    report('导出表头去掉「类目」、加上「图片 / 颜色 / 尺码 / 克重」',
      exHeads.indexOf('类目') < 0 && exHeads.indexOf('图片') >= 0 && exHeads.indexOf('颜色') >= 0 &&
        exHeads.indexOf('尺码') >= 0 && exHeads.indexOf('克重') >= 0,
      exHeads.join('/'));
    report('imageColumn 指向的正是「图片」那一列（指错 = 所有图嵌到别的列上）',
      exHeads[exPayload.imageColumn] === '图片',
      'col=' + exPayload.imageColumn + ' -> ' + exHeads[exPayload.imageColumn]);
    report('导出把主图路径按行带上（"导出→改→导回"闭环里图跟着回来）',
      (exPayload.rows || []).some(function (r) {
        return r && r.imagePath === window.__smokeProductImg;
      }),
      JSON.stringify((exPayload.rows || []).map(function (r) { return (r && r.imagePath) || ''; })));
    report('导出的 SKU 列来自 pl_variants（尺码/克重按颜色拼成一格）',
      (exPayload.rows || []).some(function (r) {
        // 克重期望 '320,275' 而不是夹具初值 '320,'：上面的 save 步已把黑 M 改成 275，
        // 导出读的是**库里的当下值** —— 导出真带出旧值反而说明读取链路是死的。
        return r && r.cells && r.cells[5] === 'L,M' && r.cells[6] === '320,275';
      }),
      JSON.stringify((exPayload.rows || []).map(function (r) { return r && r.cells && r.cells.slice(4, 7); })));
    report('图只挂在每个款的**第一行**（同一张图不重复嵌 N 遍）',
      (exPayload.rows || []).filter(function (r) { return r && r.imagePath; }).length === 1,
      String((exPayload.rows || []).filter(function (r) { return r && r.imagePath; }).length));

    // ── 导入：真 xlsx（Node 侧造的）→ 逐张体检 → 抽图 → 预览 → 提交 ──
    document.querySelector('[data-act="import-excel"]').click();
    await settle(function () { return !!document.querySelector('[data-act="pick-file"]'); }, 8000);
    document.querySelector('[data-act="pick-file"]').click();
    await settle(function () { return !!document.querySelector('[data-act="import-table"]'); }, 10000);
    var impHeads = all('[data-act="import-table"] thead th').map(flat);
    report('预览表头：没有「类目」，有「图片 / 颜色 / 尺码 / 克重」',
      impHeads.indexOf('类目') < 0 && impHeads.indexOf('图片') >= 0 && impHeads.indexOf('颜色') >= 0 &&
        impHeads.indexOf('尺码') >= 0 && impHeads.indexOf('克重') >= 0,
      impHeads.join('/'));
    // 预览默认「只看有问题的行」（有问题行存在时）—— 下面几条断言要**通读所有行**，
    // 先把开关切回「全部」。判定开关当前态用 aria-pressed（点了没反应时会在这条上红）。
    var opBtn = document.querySelector('[data-act="only-problems"]');
    if (opBtn && opBtn.getAttribute('aria-pressed') === 'true') opBtn.click();
    await settle(function () {
      return document.querySelectorAll('[data-act="import-table"] tbody tr[data-row-no]').length >= 3;
    }, 6000);
    var imgCells = all('[data-act="row-image"]');
    report('「图片」列按行显示有没有图（3 行里 2 行有：第 2、4 行）',
      imgCells.length === 3 &&
        imgCells.filter(function (e) { return e.getAttribute('data-has-image') === '1'; }).length === 2,
      imgCells.map(function (e) { return e.getAttribute('data-has-image'); }).join(','));
    report('⭐ 图贴给的是**抽图报的那一行**（第 4 行），不是第一个有数据的行',
      (function () {
        var r = document.querySelector('[data-act="import-table"] tbody tr[data-row-no="4"]');
        return !!r && r.querySelector('[data-act="row-image"]').getAttribute('data-has-image') === '1';
      })(),
      all('[data-act="import-table"] tbody tr[data-row-no]').map(function (tr) {
        return tr.getAttribute('data-row-no') + ':' +
          (tr.querySelector('[data-act="row-image"]') || { getAttribute: function () { return '?'; } }).getAttribute('data-has-image');
      }).join(' '));
    report('汇总里报出「图片 N/M 张归位」（图没进来的事必须看得见）',
      flat(document.querySelector('[data-act="import-images"]')).indexOf('2/3') >= 0,
      flat(document.querySelector('[data-act="import-images"]')));
    report('归不了位的那张图有单独一行说明（第 9 行是空行）',
      !!document.querySelector('[data-act="import-notes"]') &&
        flat(document.querySelector('[data-act="import-notes"]')).indexOf('第 9 行') >= 0,
      flat(document.querySelector('[data-act="import-notes"]')));
    report('尺码/克重按顺序对应渲染：第 2 行 尺码=M,L、克重=120,',
      (function () {
        var tds = document.querySelectorAll('[data-act="import-table"] tbody tr[data-row-no="2"] td');
        return tds.length > 8 && flat(tds[7]) === 'M,L' && flat(tds[8]) === '120,';
      })(),
      (function () {
        var tds = document.querySelectorAll('[data-act="import-table"] tbody tr[data-row-no="2"] td');
        return tds.length > 8 ? flat(tds[7]) + ' / ' + flat(tds[8]) : 'tds=' + tds.length;
      })());
    report('⭐ 规格对不上的第 4 行标成「跳过」，而它**仍带着图**（图不改变合格性）',
      (function () {
        var r = document.querySelector('[data-act="import-table"] tbody tr[data-row-no="4"]');
        return !!r && flat(r).indexOf('跳过') >= 0 &&
          r.querySelector('[data-act="row-image"]').getAttribute('data-has-image') === '1';
      })(),
      flat(document.querySelector('[data-act="import-table"] tbody tr[data-row-no="4"]')).slice(0, 60));

    var impBefore = calls('productImport').length;
    document.querySelector('[data-act="commit-import"]').click();
    await settle(function () { return calls('productImport').length > impBefore; }, 10000);
    var items = (calls('productImport')[impBefore] || {}).items || [];
    report('只提交能导入的行：规格对不上的 IMP-3 不在 items 里',
      items.length === 2 && !items.some(function (x) { return x.code === 'IMP-3'; }),
      JSON.stringify(items.map(function (x) { return x.code; })));
    report('⭐ items 里**没有** category 字段（模板去列 ⇒ 库层对已存在的款原样保留类目）',
      items.length > 0 && items.every(function (x) { return !('category' in x); }),
      items.length ? JSON.stringify(Object.keys(items[0])) : 'empty');
    report('SKU 随行带上（IMP-1 = 红 M 120 克 + 红 L 未填=0）',
      (function () {
        var r = items.filter(function (x) { return x.code === 'IMP-1'; })[0];
        return !!r && JSON.stringify(r.skus) ===
          JSON.stringify([{ color: '红', size: 'M', weightG: 120 }, { color: '红', size: 'L', weightG: 0 }]);
      })(),
      JSON.stringify((items.filter(function (x) { return x.code === 'IMP-1'; })[0] || {}).skus));
    report('抽到图的行把 imageId 带上（图跟着合格行走，进库即成主图）',
      (items.filter(function (x) { return x.code === 'IMP-1'; })[0] || {}).imageId === 55,
      String((items.filter(function (x) { return x.code === 'IMP-1'; })[0] || {}).imageId));
    report('没图的行走 imageId=0（进库后不该把已有的款主图清掉）',
      (items.filter(function (x) { return x.code === 'IMP-2'; })[0] || {}).imageId === 0,
      String((items.filter(function (x) { return x.code === 'IMP-2'; })[0] || {}).imageId));
    report('结果页报出写入的 SKU 数与主图数（这两件事没做成时用户看不见）',
      (function () {
        var t = flat(document.querySelector('.im-result'));
        return t.indexOf('SKU') >= 0 && t.indexOf('主图') >= 0;
      })(),
      flat(document.querySelector('.im-result')).slice(0, 80));

    step('errors');
    report('无未捕获错误', (window.__smokeErrors || []).length === 0, JSON.stringify(window.__smokeErrors || []));
  } catch (e) {
    lines.push('SMOKE: FAILED at [' + STEP + '] - ' + (e && e.message ? e.message : String(e)));
  }
  finish();
}
main();
</script>`;

// ── 导入夹具：一份**真的 xlsx**（列与新版模板一致），注入页面给「选择 Excel 文件」用 ──
//
// 为什么要在 Node 侧先造出真文件、再 base64 塞进页面：导入弹层的第一件事就是
// `XLSX.read(buffer)` 逐张体检 + 列名匹配 —— 用假的二维数组喂不进去（那是单测的活），
// 而这里要验的正是"**真文件**读出来的列与界面渲染的列一致、发出去的 items 形状对"。
//
// 三行的用意（每一行挡一类错）：
//   IMP-1  尺码 2 个 / 克重写 `120,`（第二个留空）—— 顺序对应 + "空格位是有意义的位置"这条
//   IMP-2  只填尺码不填克重 —— 合法（0 = 没填），不该被当成错误
//   IMP-3  尺码 2 个 / 克重 1 个 —— 对不上，必须标成"跳过"且**不**发去落库
//
// ⚠️ 不在这份夹具里放图：嵌入图走的是主进程 exceljs（假桥 stub 了 `product-extract-images`），
//    真抽取由 `scripts/product-xlsx-smoke.cjs` 单独钉住。两段各管一头，各自可单独跑。
const XLSX_REQUIRE = createRequire(import.meta.url);
const XLSX_LIB = XLSX_REQUIRE(path.join(ROOT, 'node_modules', 'xlsx'));
const IMPORT_FIXTURE_AOA = [
  ['款编码', '款式名', '供应商', '图片', '颜色', '尺码', '克重', '状态', '备注'],
  ['IMP-1', '导入款一', '厂A', '', '红', 'M,L', '120,', '启用', ''],
  ['IMP-2', '导入款二', '厂A', '', '蓝', 'S', '', '启用', ''],
  ['IMP-3', '导入款三', '厂A', '', '白', 'S,T', '110', '启用', ''],
];
const IMPORT_XLSX_B64 = (() => {
  const wb = XLSX_LIB.utils.book_new();
  XLSX_LIB.utils.book_append_sheet(wb, XLSX_LIB.utils.aoa_to_sheet(IMPORT_FIXTURE_AOA), '产品库');
  return XLSX_LIB.write(wb, { bookType: 'xlsx', type: 'base64' });
})();
// ⚠️ 这段是**普通字符串拼接**，不是模板字面量：`FAKE_BRIDGE` 那个模板串里不能出现反引号，
//    而 base64 里可能出现任何字符，用 JSON.stringify 转义最稳。
const XLSX_FIXTURE_SCRIPT =
  '<script>window.__smokeXlsxB64=' +
  JSON.stringify(IMPORT_XLSX_B64) +
  ';window.__smokeXlsxBuffer=function(){var s=window.__smokeXlsxB64||"";var b=atob(s);' +
  'var u=new Uint8Array(b.length);for(var i=0;i<b.length;i++)u[i]=b.charCodeAt(i);return u.buffer;};</script>';

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
cpSync(DIST, WORK, { recursive: true });
const indexPath = path.join(WORK, 'index.html');
let html = readFileSync(indexPath, 'utf8');
html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '');
html = html.replace('</head>', () => XLSX_FIXTURE_SCRIPT + FAKE_BRIDGE + '</head>');
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
 * 跑一遍无头 Chrome 并取回 `#smoke-result` 的文本。
 *
 * `--window-size` 决定视口宽，`?mode=` 决定跑哪一套断言（注入脚本按 mode 分派；不传则按
 * 视口宽度自判，保持单独打开页面时的旧行为）。三遍各自的判据见 `main()` 顶部：
 *   full 1440×900（全量）/ reach 1200×800（**默认窗口**可达性）/ narrow 900×800（堆叠 + 空态可达性）。
 * ⚠️ reach 那一遍不能省：B4 这类"渲染了但点不到"的缺陷**只在默认窗口宽度下出现**，
 *    1440 下两栏都宽裕、什么都点得到 —— 拿宽视口验它等于没验。
 */
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
  { mode: 'full', size: '1440,900', budget: 60000, label: '全量断言（宽 1440）' },
  { mode: 'reach', size: '1200,800', budget: 40000, label: '默认窗口可达性（1200×800）' },
  { mode: 'narrow', size: '900,800', budget: 40000, label: '窄视口 + 空态可达性（900×800）' },
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
console.log(ok ? '\n✓ 货与成本页冒烟通过（宽 + 默认窗口 + 窄，共三遍）' : '\n✗ 货与成本页冒烟失败');
process.exit(ok ? 0 : 1);