// 「货与成本」页的**假桥无头冒烟**（不启动宿主，不需要 Electron）。
//
//   npm run goods:ui
//
// 为什么需要它：这一页是**写入面**（2026-10-09 起，改克重的唯一入口是「编辑」抽屉），
// 而 `productVariantUpsert` 是**全量提交** ——
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
/* （2026-10-25）「简洁模式」整个撤掉，原先这里清 'sk.goods.simple' 偏好的那段一并删了 ——
   键不再有生产者与读者。headless 多遍共用 profile 的其他偏好仍是各自步骤自己复位的。 */
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
  /**
   * S1 的款名特意取一个"长得像真的"的长名（18 字）。
   *
   * 为什么不能继续用「款一」：用户报的症状是"款式名展示不完全"，而短名在两行之内怎么排都放得下
   * ⇒ scrollHeight <= clientHeight 那条断言**恒绿**（等于没测）。长名才让"放不下"有机会发生。
   * ⚠️ 它是**常驻夹具**（不是开关）：早先试过"临时打开开关 + 点刷新 + 再刷新复位"，
   *    结果污染了队列那条"缩略图只合批取一次"的绝对计数（每次页级刷新都会让右栏重新合批取图，
   *    1 → 3 条，红的却是队列那条断言）。夹具里直接长名字最省事，也最不容易再撞上这类污染。
   */
  var LONG_STYLE_NAME = '圆领纯棉短袖上衣（宽松版·深藏青·含围巾与帽子）';
  // 断言脚本是**另一段 script**（不同作用域）⇒ 那个名字也要转手一次（同 __smokeProductImg）。
  window.__smokeLongStyleName = LONG_STYLE_NAME;
  var PRODUCTS = [
    { id: 1, code: 'S1', name: LONG_STYLE_NAME, supplierId: 7, supplierName: '厂A', category: '衣服', status: 'active', note: '', imageId: 1, imagePath: PRODUCT_IMG, createdAt: '', updatedAt: '' },
    { id: 2, code: 'S2', name: '款二', supplierId: 0, supplierName: '', category: '衣服', status: 'active', note: '', imageId: 0, imagePath: '', createdAt: '', updatedAt: '' },
  ];
  var VARIANTS = [
    { id: 11, productId: 1, code: 'SKU-A', name: '黑 L', color: '黑', size: 'L', weightG: 320, status: 'active' },
    { id: 12, productId: 1, code: '', name: '黑 M', color: '黑', size: 'M', weightG: 0, status: 'active' },
    { id: 21, productId: 2, code: '', name: '白 XL', color: '白', size: 'XL', weightG: 400, status: 'active' },
  ];

  // 进价（C2 起）是**产品行自己的字段** costCents（列表/抽屉/导出都读它），不再有独立的款级价目表 —
  // 所以这里没有 COSTS 夹具：本页的「当前进价」由 productUpsert 直接写在 PRODUCTS 行上（见 cost-save-in-drawer 步）。

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

  /* ==========================================================================
     采集快照（pl_shop_items；第三个认款输入源）—— 与上面 SHOP_ITEMS **不是一回事**：
     那份服务「店铺商品清单」页签（已收起的 shopProductList）；这份走
     shopItemsList / shopItemsSummary / aeReceiverStatus 三个通道。
     2026-10-16 起「待关联采集商品」段**恒列未认款**（onlyUnconfirmed）⇒ 段内只会有
     两种状态，样本把这两种**同屏**凑齐（少任何一态，"状态列条件渲染"就恒绿）：
       ① 已登记 + 未认款  → 可勾选；认款后该行从本段消失、进「已建立映射」
       ② 未登记店        → 不可勾选 + 整行 is-blocked + 「去登记」出口
     另有两条**已认款**样本（7002 / 7004）：它们**不在**本段出现，只作为"过滤真的在生效"的
     反证存在（客户端过滤的话它们会留在表里，行数立刻对不上）。
     7004 还带一份真 SKU（黑 L/M + 红 M/S）且认到产品 1 —— 「从采集商品导入矩阵」用它：
     其中 黑/L 的 999 必须**打不过**产品已有的 320（只补缺口，不覆盖）。
     ① 的图是**有固有尺寸**的 SVG dataUrl（120×120）：窄窗口"图列地板"那条断言
     要的是一张真大的图 —— 没有它，"地板靠 CSS 声明给"和"图片自己兜底"
     两种实现在夹具里分不出高下（2026-10-12 的坑正是 auto 布局按固有尺寸算 min-content）。
     ========================================================================== */
  var PL_ITEM_IMG = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#cfe8e2"/></svg>');
  /* 「黑」这一色的代表图（详情页 SKU 矩阵采得到；与主图**不同色** ——
     向导"每色行用自己的色图、没有色图回落主图"那条断言靠这个区分开：
     两边给同一张图的话，两种实现分不出高下）。 */
  var PL_ITEM_SKU_IMG = 'data:image/svg+xml,' + encodeURIComponent(
    '<svg xmlns="http://www.w3.org/2000/svg" width="120" height="120"><rect width="120" height="120" fill="#cfe0f8"/></svg>');
  var PL_SHOP_ITEMS_INIT = [
    { id: 7001, shopId: 11, platform: 'shopee', shopName: 'HK 优品店', storeKey: '', itemId: '1005001234567890', title: '折叠收纳箱 60L 蓝色', imageUrl: PL_ITEM_IMG, imageId: 0, priceText: 'US $9.99', category: '收纳', status: '在售', url: 'https://www.aliexpress.com/item/1005001234567890.html', skuJson: JSON.stringify([{ color: '黑', size: 'L', price: 'US $9.99', imageUrl: PL_ITEM_SKU_IMG }, { color: '4', size: 'M', price: 'US $9.99' }]), source: 'detail', scrapedAt: 1759219200000, mappedProductId: 0, mappedProductCode: '', createdAt: '2026-10-12 10:00', updatedAt: '2026-10-12 10:00' },
    { id: 7002, shopId: 12, platform: 'amazon', shopName: 'Aurora Store', storeKey: '', itemId: 'B0XYZ1234', title: 'Travel Organizer 8pcs', imageUrl: '', imageId: 0, priceText: 'US $12.50', category: '旅行', status: '在售', url: '', skuJson: '', source: 'list', scrapedAt: 1759219100000, mappedProductId: 1, mappedProductCode: 'S1', createdAt: '2026-10-12 09:50', updatedAt: '2026-10-12 09:55' },
    { id: 7003, shopId: 0, platform: '', shopName: '', storeKey: '芒果旗舰店', itemId: '1005009876543210', title: '保温杯 500ml 316 不锈钢', imageUrl: '', imageId: 0, priceText: 'US $5.20', category: '水杯', status: '在售', url: '', skuJson: '', source: 'list', scrapedAt: 1759219000000, mappedProductId: 0, mappedProductCode: '', createdAt: '2026-10-12 09:40', updatedAt: '2026-10-12 09:40' },
    { id: 7004, shopId: 11, platform: 'shopee', shopName: 'HK 优品店', storeKey: '', itemId: '1005007777777777', title: '折叠收纳箱 60L 红色升级款', imageUrl: '', imageId: 0, priceText: 'US $9.99', category: '收纳', status: '在售', url: '', skuJson: JSON.stringify([{ color: '黑', size: 'L', price: 'US $9.99', weightG: 999 }, { color: '黑', size: 'M', price: 'US $9.99', weightG: 150 }, { color: '红', size: 'S', price: 'US $9.99', imageUrl: PL_ITEM_SKU_IMG, weightG: 180 }, { color: '红', size: 'M', price: 'US $9.99' }]), source: 'detail', scrapedAt: 1759218900000, mappedProductId: 1, mappedProductCode: 'S1', createdAt: '2026-10-12 09:30', updatedAt: '2026-10-12 09:35' },
  ];
  var PL_SHOP_ITEMS = PL_SHOP_ITEMS_INIT.map(function (r) { return Object.assign({}, r); });

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

  /** 本会话已建立的映射键（队列据此剔除"已关联"的组）—— 真实里是 pl_shop_sku WHERE status='confirmed' */
  var MAP = {};

  /* ==========================================================================
     店铺实体域（sk_shops / sk_name_map）—— 2026-10-08 起「店铺登记」收进内建，
     右栏提示条的「去「店名归一」」与行内的「去登记」都跳它 ⇒ 这一页真的会调这几个通道。

     ⚠️ 样本必须与队列**同源**（这是本文件最容易写错的地方）：
        · 两家店 = 队列里那两行 unmapped 的归属（shopId 11 / 12，平台 shopee / amazon）；
        · 一条未归一店名 = 队列里那一行 shopUnresolved 的原文（「新奇怪物店」，
          且 autoShopId=12 精确命中 Aurora Store —— 「采纳」按钮只在唯一命中时出现）。
     这样"登记完 → 回队列刷新 → 那一行就能关联了"这条**端到端**断言才成立。
     两端各造一套互不相干的夹具（店名对不上队列里的原文）—— 界面照样全绿，
     但那条断言会变成恒真：它验的正是"两端是不是同一件事"。
     ========================================================================== */
  var SHOPS_INIT = [
    { id: 11, platform: 'shopee', name: 'HK 优品店', nameKey: 'hk 优品店', platformShopId: '', shopUrl: '', site: 'MY', status: 'active', openedAt: '', note: '', createdAt: '2026-09-01 10:00', updatedAt: '', aliasCount: 1 },
    { id: 12, platform: 'amazon', name: 'Aurora Store', nameKey: 'aurora store', platformShopId: 'A1B2C3D4', shopUrl: '', site: 'US', status: 'active', openedAt: '', note: '', createdAt: '2026-09-02 10:00', updatedAt: '', aliasCount: 1 },
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
  // 产品抽屉 SKU 矩阵的款色图：**必须与 ORDER_IMG 不同一个路径** —— 队列那条
  // 「缩略图只合批取一次」的断言是按"请求里含订单图那张路径"过滤的，两条通道共用同一张
  // 虚构路径会让抽屉每开一次都算进队列的计数（1 → 6），红的却是队列那条断言。
  var STYLE_IMG = '/tmp/smoke-order-images/style-black.webp';
  /* 订单域「哪些色名底下挂着那张款色图」—— 图挂在**款色行**上（oi_images.style_color_id），
     色行改名时 id 不变、图跟着走。这是真机的结构，不是便利写法：
       · 只返回一张静态图 ⇒ 分不出"按色名查"与"图跟着色行"两种实现；
       · 色行改名却不搬图 ⇒ 会掩盖"产品侧改了名、订单域没改"这个真实故障（2026-10-23 两次实报）。
     初始只有「黑」有图，shopItemImageFetch 采纳时会往里加色名（= 图挂上去），
     styleColorRename 成功后把旧名换成新名（= 色行改名，id 与图都不动）。 */
  var STYLE_COLOR_WITH_IMG = { '黑': 1 };
  var THUMB_IMG = 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
  var BIG_IMG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==';
  // 产品图给**另外两张**（缩略图 / 原图各一）：对比模式要断言"左边真的是候选产品的主图"，
  // 两边都返回同一张 dataUrl 的话，这条断言恒绿 —— 图对不对永远不会被发现。
  var PROD_THUMB = 'data:image/gif;base64,R0lGODlhAQABAAAAACH5BAEKAAEALAAAAAABAAEAAAICTAEAOw==';
  var PROD_BIG = 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==';
  // 断言在**另一段** script 里（两段只共享 window）—— 挂出去它才拿得到
  window.__smokeImg = { order: ORDER_IMG, thumb: THUMB_IMG, big: BIG_IMG, prodThumb: PROD_THUMB, prodBig: PROD_BIG, item: PL_ITEM_IMG, itemSku: PL_ITEM_SKU_IMG };
  var SEQ = 950;
  // 身份 = (店铺, 商品ID)：平台不参与（真实现 2026-10-20 起同口径，见 shopSku.bindingKey）
  function keyOf(r) { return r.shopId + '|' + r.itemId; }
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
    // 采集快照也回原点：认款会把 mappedProductId 写进行内对象，不复位的话
    // 后面每个场景都少一行可勾选（症状是"向导步找不到行"，原因却看不出）。
    PL_SHOP_ITEMS = PL_SHOP_ITEMS_INIT.map(function (r) { return Object.assign({}, r); });
    // 图片采纳的场景开关（item-wizard 步的第二/三遍用）：复位必须清，
    // 否则"主图下载失败"漏进后面的步骤，制造与 P4 无关的假失败。
    window.__smokeImgFail = false;
    window.__smokeColorMode = '';
    for (var k in calls) delete calls[k];
  };

  var OVERRIDES = {
    'getAppVersion': function () { return { success: true, data: '0.0.0-smoke' }; },
    'get-app-version': function () { return { success: true, data: '0.0.0-smoke' }; },
    'getModuleState': function (ns) {
      // 2026-10-17：「货与成本」不再是模块 —— 整页并进「基础数据」左导航的第二项「货品档案」。
      // 所以启动落点是 shop-accounts，并由它自己的偏好把左导航停在 'goods'（资料项 id）。
      // ⚠️ 命名空间就是模块 id（主进程内部再拼 'modules.' 前缀，见 electron/main.ts 的 MODULE_NS_PREFIX）。
      if (ns === 'app-shell') return { success: true, data: { lastActiveModuleId: 'shop-accounts', collapsed: false } };
      if (ns === 'shop-accounts') return { success: true, data: { mainTab: 'goods' } };
      return { success: true, data: null };
    },
    // 筛选语义镜像主进程 listProducts：**快捷筛选优先于 supplierId**（同时给时以快捷筛选为准）。
    // 夹具必须连"筛选真的会窄"一起复刻 —— 否则"点了指标条列表被筛窄"这条断言会恒绿
    // （界面发了参数、假桥原样返回全部，行数照样是 2）。
    // 缺克重集合**每次现算**：假桥的 upsert 会就地改夹具对象（2026-10-09 起，
    // 与 productUpsert 同一口径），写死一份会在任何一次克重保存之后失准。
    // 进价读的是产品行（costCents），本页不再有款级价目表的桩（C2 退役，2026-10-21）。
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
    // ⚠️ 桩**真的改夹具对象**（与下面 productUpsert 同一口径）。
    // 2026-10-09 之前它只记调用、不改数据 —— 那时"改克重后导出读到新值"这条断言能过，
    // 靠的是**组件的乐观更新**恰好改了同一批对象（假桥返回的是同一份引用），属于蒙对：
    // 换成任何"不就地改对象"的实现，断言就会变成"读到旧值也算过"。
    // 现在克重的唯一写入入口是编辑抽屉，桩必须真的反映它，那条断言才有意义。
    'productVariantUpsert': function (p) {
      rec('productVariantUpsert', p);
      var pid = Number((p && p.id) || 0);
      // ⚠️ 没有 id = **新增一行**（真机 pl_variants 自增主键）。桩原来只改已有的行、其余静默忽略，
      //    于是"并入矩阵 → 保存"这类**新增**路径永远看不见行（重拉后消失，图也就无从谈起）——
      //    2026-10-23 的守卫第一次跑就撞上：改名请求发出去了，行却不在库里。
      if (!pid) {
        var maxId = 0;
        for (var mi = 0; mi < VARIANTS.length; mi++) maxId = Math.max(maxId, Number(VARIANTS[mi].id) || 0);
        var created = {
          id: maxId + 1,
          productId: Number(p.productId) || 0,
          code: String(p.code || ''),
          name: String(p.name || ''),
          color: String(p.color || ''),
          size: String(p.size || ''),
          weightG: Number(p.weightG) || 0,
          status: String(p.status || 'active'),
        };
        VARIANTS.push(created);
        return { success: true, data: { id: created.id, created: true } };
      }
      for (var vi = 0; vi < VARIANTS.length; vi++) {
        if (VARIANTS[vi].id !== pid) continue;
        VARIANTS[vi].weightG = Number(p.weightG) || 0;
        VARIANTS[vi].color = String(p.color || '');
        VARIANTS[vi].size = String(p.size || '');
        VARIANTS[vi].name = String(p.name || VARIANTS[vi].name);
        VARIANTS[vi].code = String(p.code || '');
      }
      return { success: true, data: { id: p.id, created: false } };
    },
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
          costCents: Number((p && p.costCents) || 0),
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
      // 进价：与真进程同一条语义 —— **没传就不动**（undefined = 保留），传了才写（含 0）。
      // 桩要是无脑写 Number(p.costCents || 0)，"改名把价清了"这种事故在冒烟里恒绿。
      if (p && p.costCents !== undefined && p.costCents !== null) {
        hit.costCents = Number(p.costCents) || 0;
      }
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
      // ⚠️ 这两格必须**按夹具真算**，不能写死：结果页的「写入进价 N 条 / 新建供应商 N 家」
      //    是 2026-10-10 新增的回执（进价没入库、供应商没写入这两件事，原先界面上一个字都不说）。
      //    桩写死 0 ⇒ 那两条断言恒红；反过来写死 1 ⇒ 与夹具脱钩、换个夹具就骗过去了。
      var knownSupplierNames = ['厂A', '厂B'];
      var createdSeen = {};
      var suppliersCreated = 0;
      for (var si = 0; si < items.length; si++) {
        var it = items[si];
        var raw = String((it && it.supplierRaw) || '').trim();
        if (!raw || Number((it && it.supplierId) || 0) > 0) continue;
        if (knownSupplierNames.indexOf(raw) >= 0) continue;
        if (createdSeen[raw]) continue;
        createdSeen[raw] = 1;
        suppliersCreated++;
      }
      return { success: true, data: {
        created: items.length,
        updated: 0,
        skusWritten: items.reduce(function (n, r) { return n + (((r && r.skus) || []).length); }, 0),
        imagesAttached: items.filter(function (r) { return r && r.imageId > 0; }).length,
        costsWritten: items.filter(function (r) { return typeof (r && r.costCents) === 'number'; }).length,
        costsSkipped: 0,
        suppliersCreated: suppliersCreated,
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
        // 「店铺未归一」那几行**跟着登记状态走**：在「店名归一」里把它认下来之后，
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
        // 采集快照行的认款状态**跟着映射走**（真实里 listShopItems JOIN pl_shop_sku 取最新 confirmed）：
        // 不镜像的话，"认款后该行从本段消失"与"徽标 -1"两条断言在夹具里恒绿 ——
        // 界面拿到的永远是同一份未认款快照，认没认过款看不出区别。
        for (var qi = 0; qi < PL_SHOP_ITEMS.length; qi++) {
          var qr = PL_SHOP_ITEMS[qi];
          if (qr.platform === n.platform && qr.shopId === n.shopId && qr.itemId === n.itemId) {
            qr.mappedProductId = hit.id;
            qr.mappedProductCode = hit.code;
          }
        }
        var exist = null;
        for (var m = 0; m < MAPPED.length; m++) {
          var e = MAPPED[m];
          // 判重不含平台：同一个店下的同一个商品只有一条绑定（平台是店铺的副本，改平台不该新建行）
          if (e.shopId === n.shopId && e.itemId === n.itemId) exist = e;
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
    /* ---- 采集快照（pl_shop_items；第三个认款输入源）----
       桩必须**真的按 search / onlyUnconfirmed 过滤**（服务端过滤的复刻，见 listShopItems）。
       2026-10-16 起界面恒传 onlyUnconfirmed（本段只列未认款）：只 rec 不过滤的桩会让
       "已认款的不在本段出现 / 认款后该行消失"两条断言恒绿 —— 拿到的永远是全量。 */
    'shopItemsList': function (p) {
      rec('shopItemsList', p);
      var kw = (p && p.search) || '';
      var only = !!(p && p.onlyUnconfirmed);
      // 产品侧「从采集商品导入矩阵」的反向过滤：0/缺省 = 不过滤。
      // ⚠️ 桩必须**真的按 productId 过滤**（真实里 JOIN 最新一条 confirmed 映射）——
      // 只 rec 不过滤的话，"列表里只有认到这一款的采集商品"在夹具里恒绿（拿到的是全量）。
      var pid = Number((p && p.productId) || 0);
      var list = PL_SHOP_ITEMS.filter(function (r) {
        if (pid && Number(r.mappedProductId) !== pid) return false;
        if (kw && (r.title + ' ' + r.itemId).indexOf(kw) < 0) return false;
        if (only && r.mappedProductId) return false;
        return true;
      });
      // 零采集样本（__smokeEmptyItems）：验"一条都没采到"时保底通道入口仍可达 ——
      // 采集工具条整条被 itemStats.total > 0 挡着，退路若只放那边，最需要它的时刻恰好看不见。
      if (window.__smokeEmptyItems) list = [];
      return { success: true, data: { rows: list, total: list.length } };
    },
    'shopItemsSummary': function () {
      rec('shopItemsSummary', {});
      // 与 shopItemsList 的 __smokeEmptyItems 同步（零样本必须**处处**都是零，否则
      // "空态"分支进不去，保底通道可达性那条守卫在夹具里恒绿）。
      if (window.__smokeEmptyItems) return { success: true, data: [] };
      // 按 (shop_id, store_key) 分组现算 —— 与主进程 summary 同口径。写死一份静态汇总的话，
      // "认款后已认款数 +1" 这条状态条断言在夹具里恒绿（汇总永远不变）。
      var byShop = {};
      var order = [];
      for (var i = 0; i < PL_SHOP_ITEMS.length; i++) {
        var r = PL_SHOP_ITEMS[i];
        var k = r.shopId + '|' + r.storeKey;
        if (!byShop[k]) {
          byShop[k] = { shopId: r.shopId, storeKey: r.storeKey, total: 0, confirmed: 0, lastScrapedAt: 0 };
          order.push(byShop[k]);
        }
        byShop[k].total++;
        if (r.mappedProductId) byShop[k].confirmed++;
        if (r.scrapedAt > byShop[k].lastScrapedAt) byShop[k].lastScrapedAt = r.scrapedAt;
      }
      return { success: true, data: order };
    },
    /* 手贴商品ID导入（保底通道）：桩复刻主进程 importManualItems 的写路径 ——
       逐条落 pl_shop_items（source='manual'），已存在同 (shopId,id) 算更新、否则新增。
       只 rec 不写会让"导入后列表多出这一行 / 状态条总数 +N"两条断言恒绿。 */
    'shopItemsImport': function (p) {
      rec('shopItemsImport', p);
      var shopId = (p && typeof p.shopId === 'number') ? p.shopId : 0;
      var ids = (p && Array.isArray(p.ids)) ? p.ids : [];
      var received = ids.length;
      var inserted = 0;
      for (var i = 0; i < ids.length; i++) {
        var id = String(ids[i]).trim();
        if (!id) continue;
        var existing = null;
        for (var j = 0; j < PL_SHOP_ITEMS.length; j++) {
          if (PL_SHOP_ITEMS[j].shopId === shopId && PL_SHOP_ITEMS[j].itemId === id) { existing = PL_SHOP_ITEMS[j]; break; }
        }
        if (existing) {
          existing.source = 'manual';
          existing.scrapedAt = Date.now();
        } else {
          PL_SHOP_ITEMS.push({
            id: 8000 + PL_SHOP_ITEMS.length, shopId: shopId, platform: '', shopName: '', storeKey: '',
            itemId: id, title: '', imageUrl: '', imageId: 0, priceText: '', category: '', status: '在售',
            url: '', skuJson: '', source: 'manual', scrapedAt: Date.now(), mappedProductId: 0, mappedProductCode: '',
            createdAt: '', updatedAt: '',
          });
          inserted++;
        }
      }
      return { success: true, data: { received: received, inserted: inserted, updated: received - inserted, skipped: 0 } };
    },
    /* 接收端状态：状态条的"在线/端口/最近采集"由它驱动。
       window.__smokeReceiverOff = 接收端没起时的分支（状态条该说人话 + 不给表格骨架）。 */
    'aeReceiverStatus': function () {
      rec('aeReceiverStatus', {});
      return { success: true, data: {
        running: !window.__smokeReceiverOff,
        port: 46211,
        startedAt: '2026-10-12 09:00:00',
        lastIngestAt: '2026-10-12 10:00:00',
        lastItemsIngestAt: '2026-10-12 10:05:00',
        lastError: '',
        // 结构复刻（AeReceiverStatus 新增字段）：本页不读它，但夹具要与真桥同形
        lastRateMissing: 0,
      } };
    },
    /* 下一个款编码（建款向导的系统发号只读展示）*/
    'productNextCode': function () {
      rec('productNextCode', {});
      return { success: true, data: { code: 'STYLE-042' } };
    },
    /* ---- 采集图下载入库（shop-item-image-fetch；P4）----
       桩按主进程 handler 的分支复刻（product-handlers.ts 的同名 handler）：
         · 行不存在 → success:false（渲染层 unwrap 抛 → 被第④步的 catch 收进回执，不当建档失败）
         · 行已有 imageId → 复用分支（不重下；勾了 adoptMain 仍尝试采纳）
         · __smokeImgFail → 主图下载失败（走 mainError，有色图时不外抛）
         · colors 按 color 去重；__smokeColorMode 决定每色结果：
             color-bound = 目标款色已有图（跳过）/ download-failed = 该张失败 / 默认 = 绑上
       只 rec 不分支的桩会让"失败不外抛 / 跳过不覆盖 / 勾选语义透传"三条断言恒绿 ——
       桩给所有输入同一输出，就是把被验的量写死。 */
    'shopItemImageFetch': function (p) {
      rec('shopItemImageFetch', p);
      var row = null;
      for (var i = 0; i < PL_SHOP_ITEMS.length; i++) {
        if (PL_SHOP_ITEMS[i].id === Number(p && p.id)) { row = PL_SHOP_ITEMS[i]; break; }
      }
      if (!row) return { success: false, error: '采集行不存在或已被删除' };
      var colors = [];
      var seen = {};
      var list = (p && p.colors) || [];
      for (var i = 0; i < list.length; i++) {
        var c = list[i];
        if (!c || !c.color || !c.imageUrl || seen[c.color]) continue;
        seen[c.color] = true;
        var mode = window.__smokeColorMode || 'bound';
        if (mode === 'download-failed') {
          colors.push({ color: c.color, imageId: 0, bound: false, reason: 'download-failed' });
        } else if (mode === 'color-bound') {
          colors.push({ color: c.color, imageId: 90, bound: false, reason: 'color-bound' });
        } else {
          // 采纳成功 = 图挂到这个色名的款色行上（后面按色名查得到，见 STYLE_COLOR_WITH_IMG）
          STYLE_COLOR_WITH_IMG[c.color] = 1;
          colors.push({ color: c.color, imageId: 91, bound: true, reason: '' });
        }
      }
      var adoptMain = !!(p && p.adoptMain);
      if (row.imageId) {
        return { success: true, data: { imageId: row.imageId, localPath: '', reused: true, adopted: adoptMain, mainError: '', colors: colors } };
      }
      if (window.__smokeImgFail) {
        return { success: true, data: { imageId: 0, localPath: '', reused: false, adopted: false, mainError: '图片下载失败: 模拟网络错误', colors: colors } };
      }
      if (!row.imageUrl) {
        if (colors.length) {
          return { success: true, data: { imageId: 0, localPath: '', reused: false, adopted: false, mainError: '这一行没有采集图地址', colors: colors } };
        }
        return { success: false, error: '这一行没有采集图地址' };
      }
      row.imageId = 91; // 下载入库回填（同图去重语义由 DB 冒烟钉住，这里只验界面接线）
      return { success: true, data: { imageId: 91, localPath: '/tmp/smoke-shop-item.webp', reused: false, adopted: adoptMain, mainError: '', colors: colors } };
    },
    /* ---- 删采集行（shop-items-delete；2026-10-16）----
       桩按行 id 真删（唯一键是 shop_id+store_key+item_id 三元组，同一商品ID
       在多家店下各是一行 ⇒ 删除必须按行 id 定位）。行不在 → success:false。
       不联动删映射（映射在另一份夹具 MAP/MAPPED 里，与主进程"两套不互写"一致）。 */
    'shopItemsDelete': function (p) {
      rec('shopItemsDelete', p);
      var id = Number(p && p.id);
      var idx = -1;
      for (var i = 0; i < PL_SHOP_ITEMS.length; i++) {
        if (PL_SHOP_ITEMS[i].id === id) { idx = i; break; }
      }
      if (idx < 0) return { success: false, error: '采集行不存在或已被删除' };
      PL_SHOP_ITEMS.splice(idx, 1);
      return { success: true, data: { removed: true } };
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
        // 产品主图、订单图、款色图返回**不同**的缩略图：弹层里的产品图断言靠这个区分开
        if (p === ORDER_IMG) return THUMB_IMG;
        if (p === STYLE_IMG) return THUMB_IMG;
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
    /* 产品抽屉的 SKU 矩阵行图：按「款编码 + 款色」取订单域的款色图（与拿货单编辑器同一条通道）。
       产品 SKU 没有色图字段，这张图**只作显示** —— 所以夹具里必须同时有"取得到"和"取不到"
       两种行：只给一种的话，"没图的行渲染空占位"与"所有行都画同一张"都分不出来。 */
    'purchaseStyleImages': function (p) {
      rec('purchaseStyleImages', p);
      var items = (p && p.items) || [];
      return { success: true, data: { paths: items.map(function (it) {
        return it && it.styleCode === 'S1' && STYLE_COLOR_WITH_IMG[it.color] ? STYLE_IMG : null;
      }) } };
    },
    /* 款色改名（产品侧改色名 → 订单侧色行改**标签**，id / 图不动）。
       这里不改夹具里的色名：真实里产品侧的颜色早已由 productVariantUpsert 写进 pl_variants，
       本通道动的是 oi_style_colors —— 桩去改 VARIANTS 反而会掩盖"两边各归其主"。
       但**图必须跟着走**：色行改名后按新名查得到那张图，按旧名查不到（同一条款色行）。 */
    'styleColorRename': function (p) {
      rec('styleColorRename', p);
      var from = p && p.from;
      var to = p && p.to;
      if (from && to && STYLE_COLOR_WITH_IMG[from]) {
        delete STYLE_COLOR_WITH_IMG[from];
        STYLE_COLOR_WITH_IMG[to] = 1;
      }
      return { success: true, data: { renamed: true, styleColorId: 91, colorAlias: null } };
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
    // 2026-10-22 物理合并收口：店名归一页的已登记店铺表 / 店铺编辑表单已撤（店铺统一去
    // 「店铺」页改），全仓不再有 shopUpsert 调用点 —— 这个桩连带着删掉（留着 = 给死代码陪葬）。

    // 假桥兜底是 {success:true, data:null}，而 externalLoader 判的是 !r.data ⇒ 不补这个桩，
    // 每张截图右下角都挂一条**常驻红 toast**「扫描插件目录失败（IPC 不可用）」。
    // 真机这里返回 {root, plugins}（plugins-handlers），补桩是让夹具**忠于真形状**，
    // 不是为了消掉颜色 —— 红 toast 一直挂着会训练人忽略红 toast。
    // ⚠️ 本段是模板字面量：注释里**不能出现反引号**（会提前终止模板串，报错却指向注释行）。
    'pluginsScan': function () { return { success: true, data: { root: '/tmp/smoke-plugins', plugins: [] } }; },
  };

  // 「采集已入库」事件桩：订阅类方法必须**同步**返回退订函数（下面的 OVERRIDES 包装是
  // Promise 化的，只适用于 invoke 类；走那条会把退订函数包进 Promise，页面拿到的退订句柄
  // 变成 [object Promise]）。这里给一个真能注册/退订的桩 —— 步 ingest-broadcast 靠
  // __smokeEmitAeItems 把事件推进页面的订阅者，验"扩展（外部进程）写完库后，停在
  // 页面上不点任何按钮，数据能不能自己出来"。
  window.__smokeAeListeners = [];
  window.__smokeEmitAeItems = function (payload) {
    var ls = window.__smokeAeListeners.slice();
    for (var i = 0; i < ls.length; i++) ls[i](payload);
  };

  window.electronAPI = new Proxy({}, {
    get: function (_t, key) {
      if (typeof key !== 'string') return undefined;
      if (key === 'onAeItemsIngested') {
        return function (cb) {
          window.__smokeAeListeners.push(cb);
          return function () {
            window.__smokeAeListeners = window.__smokeAeListeners.filter(function (f) { return f !== cb; });
          };
        };
      }
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
// 跨模块跳转记录器（2026-10-14 整合新增）：「货与成本」的「去「店名归一」」等出口不再是本页页签，
// 而是 switchModule('shop-accounts', action) —— 断言"派发了什么"比断言"页面变成什么"更稳
// （页面那半由 shop-accounts 模块自己的冒烟守，这里守的是"这一页真的把意图发出去了"）。
window.__navs = [];
window.addEventListener('switch-module', function (e) {
  window.__navs.push({ moduleId: e.detail && e.detail.moduleId, action: e.detail && e.detail.action });
});
function lastNav(moduleId) {
  var ns = window.__navs.filter(function (n) { return n.moduleId === moduleId; });
  return ns.length ? ns[ns.length - 1] : null;
}
/** 从测试脚本里派发一次模块切换（用于跨模块跳转后把页面切回来继续断言） */
function navTo(moduleId) {
  window.dispatchEvent(new CustomEvent('switch-module', { detail: { moduleId: moduleId } }));
}
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
// ⚠️ 原先这里还有一个 「variantRows()」（数展开区 SKU 子表的行）。2026-10-10 展开区的 SKU 清单
//    整块撤掉后它没有消费者了 —— 撤掉而不是留着：留着的那一行会让读代码的人以为展开区还有子表。

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
/**
 * 把元素滚进**用户能滚的那些容器**（只认 overflow 为 auto / scroll 的祖先）。
 *
 * 为什么必须先滚再判：货品档案并进「基础数据」后，默认 1200 窗口下两栏是**上下堆叠**的
 * （见 GoodsWorkbenchView.vue 的 @media，断点 1280）—— 右栏那整块队列本来就在首屏下方，
 * 那里"不在视口内"是布局的正常结果，**滚一下就能点**，不是缺陷。
 * 反过来：.wb-panel 那种 overflow: hidden 的容器**不滚** —— 用户滚不了它，
 * 而"元素在 DOM 里、却被容器静默裁掉"正是这一遍要抓的东西，替它滚等于把缺陷抹平。
 */
function scrollIntoUserView(el) {
  var n = el.parentElement;
  var moved = false;
  while (n && n !== document.documentElement) {
    var cs = getComputedStyle(n);
    var canY = /(auto|scroll)/.test(cs.overflowY) && n.scrollHeight > n.clientHeight + 1;
    var canX = /(auto|scroll)/.test(cs.overflowX) && n.scrollWidth > n.clientWidth + 1;
    if (canY || canX) {
      var er = el.getBoundingClientRect();
      var nr = n.getBoundingClientRect();
      var dy = er.top + er.height / 2 - (nr.top + nr.height / 2);
      var dx = er.left + er.width / 2 - (nr.left + nr.width / 2);
      if (canY && Math.abs(dy) > 1) { n.scrollTop += dy; moved = true; }
      if (canX && Math.abs(dx) > 1) { n.scrollLeft += dx; moved = true; }
    }
    n = n.parentElement;
  }
  return moved;
}
/** 当前高亮的是不是这一页资料。
 *  2026-10-17（上午）：七项从页面内左导航搬到主侧栏，激活态不再是 .is-active 这个类
 *  （视觉换成 Tailwind 底色），改由 aria-current="page" 表达 —— 查语义，换皮不红。
 *  2026-10-17（下午）收拢后：侧栏只剩三组（kind-groupId），**资料页是组内页签**
 *  （kind-tab-kindId）。这里只问资料页，所以取页签。 */
function kindActive(id) {
  var el = document.querySelector('[data-act="kind-tab-' + id + '"]');
  return !!el && el.getAttribute('aria-current') === 'page';
}

function reachInfo(el) {
  if (!el) return { ok: false, why: 'missing' };
  var r0 = el.getBoundingClientRect();
  if (!r0.width || !r0.height) return { ok: false, why: 'zero-size' };
  var scrolled = scrollIntoUserView(el);
  var r = el.getBoundingClientRect();
  var cx = r.left + r.width / 2;
  var cy = r.top + r.height / 2;
  if (cx < 0 || cy < 0 || cx > window.innerWidth || cy > window.innerHeight) {
    return { ok: false, why: 'out-of-viewport(' + Math.round(cx) + ',' + Math.round(cy) + ') 视口=' + window.innerWidth + 'x' + window.innerHeight };
  }
  var hit = document.elementFromPoint(cx, cy);
  if (!hit) return { ok: false, why: 'elementFromPoint=null' };
  if (hit === el || el.contains(hit) || hit.contains(el)) return { ok: true, why: '', scrolled: scrolled };
  return { ok: false, why: 'covered-by ' + String(hit.tagName) + '.' + String(hit.className || '').slice(0, 48) };
}
/** 断言某选择器命中的元素**可达**（存在 + 用户能滚到 + 命中自身）；返回该元素便于继续操作。
    失败时把元素自己的矩形一并带出来 —— 只报 covered-by 会让人看不出"是盖子的问题还是它自己被压扁了"。
    成功时若动过滚动位置，详情里带一个「滚动后」标记：判据比"在首屏"松了一档，必须看得见。 */
function reportReachable(name, sel, root) {
  var el = (root || document).querySelector(sel);
  var info = reachInfo(el);
  var r = el ? el.getBoundingClientRect() : null;
  var geo = r ? ' 自身rect=' + Math.round(r.left) + ',' + Math.round(r.top) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height) : '';
  report(name, info.ok, info.ok ? geo.trim() + (info.scrolled ? ' 滚动后' : '') : info.why + geo);
  return el;
}
function mapFlat(sel) { return all(sel).map(flat).join('/'); }
/**
 * 把「待认」段的来源筛选切到某一源（'' = 全部）。
 *
 * 2026-10-25（P2）：右栏三段并两段，订单队列与采集快照合成一张「待认」表 ——
 * 原来靠"切分段"表达的语义，现在靠这个筛选表达。**不切就会两源混在一起**：
 * 那些"表里应有 N 行"的断言会拿到 N+M，而失败原因看起来像"少了一行/多了一行"。
 */
async function setPendingOrigin(v) {
  // ⚠️ 先确保停在「待认」段：从「已认」切回来时筛选下拉**还不存在**，
  // 直接设值会静默返回 false，后面的等待就变成"永远等不到那 200 行"。
  var sel = document.querySelector('[data-act="pending-origin"]');
  if (!sel) {
    var seg = document.querySelector('[data-act="sub-pending"]');
    if (seg) seg.click();
    await sleep(220);
    sel = document.querySelector('[data-act="pending-origin"]');
  }
  if (!sel) { await sleep(120); sel = document.querySelector('[data-act="pending-origin"]'); }
  if (!sel) return false;
  setVal(sel, v);
  await sleep(160);
  return true;
}
/** 队列行 / 映射行：必须**按所在表格**限定 —— [data-item-id] 是这一页三个视图共用的锚点
    （「商品清单」收起前它确实会串到那边去；收起后仍按表限定，免得页签放回来时又串）。 */
function queueRow(itemId) { return document.querySelector('[data-act="pending-table"] tbody tr[data-item-id="' + itemId + '"]'); }
function mappedRow(itemId) { return document.querySelector('[data-act="mapped-table"] tbody tr[data-item-id="' + itemId + '"]'); }
/** 触发 Vue v-model：直接赋值不触发更新，必须走原生 setter + input/change */
function setVal(el, value) {
  var proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype
    : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
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
  // 合并段：先把来源收窄到「订单」。采集快照在夹具里**恒存在**，不收窄的话
  // "队列 3 行"这类断言会拿到 3+N —— 失败看起来像"多了一行"，真实原因是被合并进来的另一源。
  await setPendingOrigin('order');
  await settle(function () { return all('[data-act="pending-table"] tbody tr[data-item-id]').length === 3; }, 6000);
  return all('[data-act="pending-table"] tbody tr[data-item-id]').length === 3;
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
 * 窄视口守卫（第二遍：runner 用 --window-size 把视口压到 1280px 以下）。
 *
 * ⚠️ 2026-10-17 起这一遍**不再是"堆叠形态唯一被验到的地方"** —— 货品档案并进「基础数据」后
 *    默认 1200 窗口就已经在断点下方（reach 那一遍也断言了堆叠）。这里保留它是因为
 *    900px 还有别的东西要验：零款空态、空态按钮的可达性、采集表图列的地板宽度。
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
  await settle(function () { return all('[data-act="pending-table"] tbody tr[data-item-id]').length >= 1; }, 8000);
  var wb = document.querySelector('[data-act="goods-workbench"]');
  var cols = wb ? getComputedStyle(wb).gridTemplateColumns : '';
  report('窄窗口（视口 ' + window.innerWidth + 'px < 1280px）：两栏改为上下堆叠（grid 收成一列）',
    cols.split(' ').filter(function (s) { return s.length; }).length === 1, 'cols=' + cols);
  report('窄窗口下两栏**都还在**（堆叠，不是把某一栏挤没）',
    isShown(document.querySelector('[data-act="pane-products"]')) &&
      isShown(document.querySelector('[data-act="pane-pool"]')),
    'L=' + isShown(document.querySelector('[data-act="pane-products"]')) +
      ' R=' + isShown(document.querySelector('[data-act="pane-pool"]')));
  report('窄窗口下右栏队列仍在（"窄了"不是"少给点东西"的理由）',
    all('[data-act="pending-table"] tbody tr[data-item-id]').length >= 1,
    'rows=' + all('[data-act="pending-table"] tbody tr[data-item-id]').length);

  // ── 采集商品段的图列地板（2026-10-12 窄窗口坑的回归守卫）─────────────
  // 那天的真 bug：table-layout:auto 下一列放固定尺寸的图，列宽按"各列首选宽之和 vs
  // 可用宽"算、差额从每列抠 ⇒ 图列塌成 32px、图变 12px 细条；img{max-width:100%}
  // 按**固有尺寸**算该列 min-content，图片自己兜不住底。1440 下截图完全正常，只有窄窗现形。
  // 判据三条一套：列宽不低于地板 + 图没被压瘪 + 表格右缘不出视口。
  await setPendingOrigin('scrape');
  await settle(function () { return all('[data-act="pending-table"] tbody tr[data-item-id]').length >= 1; }, 8000);
  var iImgTh = document.querySelector('[data-act="pending-table"] thead th.gd-c-img');
  var iImgTd = document.querySelector('[data-act="pending-table"] tbody td.gd-c-img');
  var iImg = iImgTd ? iImgTd.querySelector('img') : null;
  var iTable = document.querySelector('[data-act="pending-table"]');
  report('窄窗口下采集表图列不低于地板（auto 布局会把它抠塌，地板必须由 CSS 声明给）',
    !!iImgTh && iImgTh.getBoundingClientRect().width >= 40,
    '列宽=' + (iImgTh ? Math.round(iImgTh.getBoundingClientRect().width) : 'missing'));
  report('窄窗口下采集图没被压瘪（认款只能靠肉眼比图，12px 细条等于没有）',
    !!iImg && iImg.getBoundingClientRect().width >= 40,
    '图宽=' + (iImg ? Math.round(iImg.getBoundingClientRect().width) : 'missing'));
  report('窄窗口下采集表右缘不出视口（.wb-panel 是 overflow:hidden，越界即静默裁掉）',
    !!iTable && iTable.getBoundingClientRect().right <= window.innerWidth + 1,
    'right=' + (iTable ? Math.round(iTable.getBoundingClientRect().right) : 'missing') + ' vw=' + window.innerWidth);
  // 切回队列段：下面的空态可达性断言建立在"右栏是队列"的初始态上
  await setPendingOrigin('order');
  await settle(function () { return all('[data-act="pending-table"] tbody tr[data-item-id]').length >= 1; }, 8000);

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
  // 空态那一格必须横跨**全部列**（colspan 写死旧值的症状是"右边缺一块"：
  // 不报错、不抛异常，只有看出来）。⭐ 2026-10-25 简洁模式撤掉 ⇒ 列数只剩一档（7），
  // 判据仍是「colSpan === 表头 th 数」的动态比法，不写死数字。
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
  reportReachable('窄窗口下空态「新增款」可达（第一印象按钮，点不到等于这页没用）',
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
  report('零款 + 队列也空 → 左栏空态把「去「发货台」导入订单」放在**第一位**（顺序本身就是一个答案）',
    eqActs.length >= 1 && flat(eqActs[0]).indexOf('发货台') >= 0,
    eqActs.map(flat).join(' / '));
  report('那个按钮是**主按钮**（此刻该做的事，不是三个并列选项里的一个）',
    eqActs.length >= 1 && flat(eqActs[0]).indexOf('发货台') >= 0 &&
      eqActs[0].className.indexOf('wb-btn--primary') >= 0,
    eqActs.length ? eqActs[0].className : 'missing');
  report('空态说明点出"商品是从订单里长出来的"（别让用户猜右边为什么空着）',
    flat(document.querySelector('.gd-list__empty .wb-empty__desc')).indexOf('订单') >= 0,
    flat(document.querySelector('.gd-list__empty .wb-empty__desc')));

  // ── 「进价」页的窄窗口守卫已随 2026-10-14 整合**搬到 master-data:ui** ──
  // 那一页（左行动区 / 右现状表的两栏）现在在「基础数据 › 成本」里，宽/窄两档的
  // 堆叠判据一条没放宽，只是换了住处（scripts/master-data-ui-smoke.mjs 的 cost-narrow 步）。
}

/**
 * 默认窗口（1200×800，即 electron/main.ts 建窗口用的尺寸）下的**可达性**那一遍。
 *
 * 为什么必须单独跑这一遍：这类缺陷**只在默认窗口宽度下才出现** —— 全量那遍跑的是 1440 宽，
 * 两栏都宽裕，什么都点得到。而 1200×800 正是绝大多数用户第一次看到的那个宽度：
 * 在那里点不到，等于那个功能不存在（S3 刚建好的「对比」动线就是这样"等于没做"）。
 *
 * ⚠️ 2026-10-17 这一天里本页的容器宽度变了两次，判据跟着改了两次（读的时候别只看半截）：
 *   上午并进「基础数据」：可用宽度被页面内那条 200px 左导航吃掉 248px ⇒ 默认窗口下**堆叠**，
 *   右栏整块掉到首屏下方，"在视口内"不再成立，于是把判据放宽成"用户能滚到它、
 *   且滚到之后点到的就是它"（reachInfo 只滚 overflow 为 auto/scroll 的祖先，
 *   overflow: hidden 的容器一律不替它滚 —— 那里"元素在 DOM 里却被静默裁掉"仍会红）。
 *   下午那条左导航搬到主侧栏：可用宽度回到 ~956 ⇒ **并排**（左 420 / 右 520），
 *   下面 ⓪ 那条断言也随之翻面。放宽后的滚动兜底**保留**（窄窗口那一遍仍会用到），
 *   但默认窗口这遍不该再靠它 —— 靠滚才通过的那几条会在详情里带「滚动后」标记。
 *   判据放宽了多少：靠滚动才通过的那几条，详情里带「滚动后」标记，一眼能数出来。
 */
async function defaultWindowReachChecks() {
  step('reach-default-window');
  await waitFor(function () { return document.querySelector('[data-act="goods-workbench"]'); }, 12000);
  await waitFor(function () { return all('[data-act="pending-table"] tbody tr[data-item-id]').length >= 1; }, 12000);
  var vw = window.innerWidth;
  report('默认窗口宽度 ' + vw + 'px：落在真机默认窗口这一档（1180–1439）', vw >= 1180 && vw < 1440, 'vw=' + vw + ' vh=' + window.innerHeight);

  // ⓪ 先钉住这一档宽度的**布局前提**：2026-10-17 那条 200px 左导航搬到主侧栏之后，
  //    默认 1200 窗口的可用宽度回到 ~956（1200 − 侧栏 208 − 页内边距 36），
  //    排得下两条栏的下限之和 796 ⇒ **并排**（左 420 / 右 520）。
  //    这一条必须显式断言：下面几条"不该靠滚动"的判据，成立的前提正是"并排了、右栏够宽"。
  //    ⚠️ 它是**翻面断言**：同一天上午这里断言的是"堆叠"。改布局的人如果只改 CSS 不改这里，
  //    红的就是这一条 —— 这正是它存在的意义（下面那些可达性断言在两种布局下都能过）。
  var wbCols = getComputedStyle(document.querySelector('[data-act="goods-workbench"]')).gridTemplateColumns;
  report('默认窗口下两栏**并排**（可用宽度 ~956 ≥ 420 + 360 两条栏的下限）',
    wbCols.split(' ').length >= 2, 'cols=' + wbCols);

  // ① 队列表必须整体落在视口内。超出的那半截列在界面上**看不见也点不到**，而 .wb-panel 是
  //    overflow:hidden —— 没有滚动条、没有报错、DOM 里字段一个不少，存在性断言对它恒绿。
  var qTable = document.querySelector('[data-act="pending-table"]');
  var qr = qTable.getBoundingClientRect();
  report('队列表没有横向溢出视口（右半截会被容器静默裁掉）',
    qr.right <= vw + 1, 'right=' + Math.round(qr.right) + ' vw=' + vw);

  // ①-b 列被**挤扁**是同一类缺陷的另一半：表格是 table-layout: fixed，容器一窄就按比例
  //     抠下去，不溢出、不报错，但「商品ID」被压到 42px 时 16 位 ID 会折成六行（实测行高 305px），
  //     图列被顶到首屏之外。这里钉两个能读得出来的下限，而不是只钉"有没有溢出"。
  var qIdCell = document.querySelector('[data-act="pending-table"] tbody tr[data-item-id] .gd-c-item');
  var qIdW = qIdCell ? Math.round(qIdCell.getBoundingClientRect().width) : 0;
  var qRowH = Math.round(document.querySelector('[data-act="pending-table"] tbody tr[data-item-id]').getBoundingClientRect().height);
  report('队列「商品ID」列宽到能读出一整串（≥120px：16 位 mono 约 128px）',
    qIdW >= 120, 'idCol=' + qIdW + 'px');
  report('队列行高 ≤ 120px（再高说明列被挤扁、每行都在折行）', qRowH <= 120, 'rowH=' + qRowH + 'px');

  // ② 表头最后一列必须完整可见（被裁掉的表头 = 那一列的动作等于没有）
  reportReachable('队列表头「操作」列完整可见', '[data-act="pending-table"] thead th:last-child');

  // ③ 行内动作必须点得到。
  // ⚠️ 2026-10-25（P2）：行内的「关联…」已撤 —— 认款收敛成**唯一**入口（勾选 → 底部动作条），
  //    行内只留「对比」（那是另一个动词：凑近看，不是认）。原先这条断言钉的是
  //    "四个近义入口都在"，现在改由「只允许一个认款提交按钮」那条反向守卫来钉。
  reportReachable('队列行「对比」按钮可达（S3 的对比动线在默认窗口下必须真的可用）',
    '[data-act="pending-table"] tbody tr[data-item-id="SKU-A1"] [data-act="row-compare"]');
  // ④ 图列：认款只能靠肉眼比图，这一列不可点等于整条动线断了
  reportReachable('队列行缩略图可达（点开看原图）', '[data-act="pending-table"] [data-act="q-thumb"]');
  // ⑤ 左栏的关键入口
  reportReachable('左栏「新增款」可达', '[data-act="new-product"]');
  // ⚠️ 2026-10-25（P2 · S4）：行首那个 ▸ 展开钮已下线（单击行 = 选中）。可达性改钉**行尾的
  //    「编辑」** —— 它是档案（供应商 / 类目 / 备注 / 删除）唯一的人工入口，点不到就等于撤了能力。
  reportReachable('左栏产品行「编辑」可达（档案入口；默认窗口下必须真的能点）',
    '[data-act="product-table"] tbody tr[data-product-id] [data-act="row-edit"]');
  // ⑦ D1 死锁的出口：默认窗口下必须**真的能点**。
  //    它躺在一张提示条里、而右栏在这一档宽度下只有 ~500px —— 正是"存在性断言恒绿"的典型位置
  //    （元素在 DOM 里、却被容器裁到视口外或被别的层盖住）。
  reportReachable('右栏提示条的「去「店名归一」」可达（死锁的出口在默认窗口下必须能点）',
    '[data-act="open-registry"]');

  // ⑥ 已建立映射段：列更多，更容易被裁
  await clickText('[data-act="sub-mapped"]', '已认');
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
    (window.innerWidth < 1280 ? 'narrow' : 'full');
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
    report('挂载：基础数据 › 货品档案渲染（原「货与成本」整页）', true);
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
    await settle(function () { return document.querySelector('[data-act="pane-pool"] [data-act="pending-table"]'); }, 6000);
    report('池栏首屏就激活：队列已渲染、且确实扫过一次订单（合并页签后池栏始终可见，懒挂载的前提没了）',
      !!document.querySelector('[data-act="pane-pool"] [data-act="pending-table"]') &&
        calls('productSkuQueue').length >= 1,
      'queueCalls=' + calls('productSkuQueue').length);
    // 宽视口下两栏是**并排**：grid-template-columns 的计算值有**两个**轨道。
    // 窄视口那半边（1280px 以下改为上下堆叠；默认 1200 窗口也在这一档）由脚本末尾的第二遍
    // 与 reach 那一遍分别验 —— 见 viewport-narrow / reach-default-window。
    var wbCols = getComputedStyle(shell).gridTemplateColumns;
    report('宽视口两栏并排（grid 两列；不是某一栏被挤没、也不是叠成上下）',
      wbCols.split(' ').filter(function (s) { return s.length; }).length === 2,
      'cols=' + wbCols);

    // ── 简洁模式：已撤（2026-10-25 用户口径）──────────────────────────
    // 原先这一组守"默认简洁 / 开关两个方向都真 / 结尾切回完整形态"三件事；
    // 开关撤掉后勾选框列、批量条与统计条**恒渲染**，那组断言随之失去存在对象。
    // 下面这条反向守卫替代它：被藏起来的控件不许再以任何形态消失。
    report('简洁模式已撤：左栏勾选框列、批量条件与右栏统计条恒在（不再有任何形态开关）',
      all('[data-act="product-table"] thead th').some(function (th) {
        return th.querySelector('input[type="checkbox"]');
      }) &&
        !!document.querySelector('[data-act="sub-mapped"]'),
      'thCheck=' + !!document.querySelector('[data-act="product-table"] thead input[type="checkbox"]'));

    // 行展开的可发现性（报告 P1-2）→ 2026-10-25（S4）改判"这一行能点、档案在哪儿"：
    // 原先"这一行能点开"只存在于行首那个 ▸ 小三角里（不悬停发现不了，触屏根本没有悬停）；
    // 展开区撤掉后一行只剩一个动作（单击 = 选中），而"改这一款"改由行尾**常显**的「编辑」给出 ——
    // 它比 ▸ 更好发现：不用悬停、不用先展开，且 title 自己写明是哪一款。
    var editBtns = all('[data-act="product-table"] tbody tr[data-product-id]').map(function (r) {
      return r.querySelector('[data-act="row-edit"]');
    });
    report('每一行都常显「编辑」，且 title 写明是哪一款（取代原先那个只有悬停才看得出的 ▸）',
      editBtns.length >= 2 && editBtns.every(function (b) { return !!b; }) &&
        all('[data-act="product-table"] tbody tr[data-product-id]').every(function (r, i) {
          var t = editBtns[i] ? editBtns[i].getAttribute('title') || '' : '';
          return t.indexOf(flat(r.querySelector('[data-act="p-code"]'))) >= 0;
        }) &&
        all('[data-act="product-table"] tbody tr[data-product-id]').every(function (r) {
          return r.classList.contains('is-clickable');
        }),
      'btn=' + editBtns.length +
        ' title0=' + (editBtns[0] ? editBtns[0].getAttribute('title') : 'missing'));

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

    // ── 「只看缺进价」筛选（2026-10-22 承接原「进价」页的缺价待办）──
    // 原「进价」页退役后，缺价清单的"可操作"能力移到了产品列表的这一个筛选：
    // 它和服务端 listProducts 的 onlyMissingCost 绑定，避免前端假筛选把分页后的款藏成"没有"。
    step('issue-filter-cost');
    setVal(issueSel(), 'missingCost');
    await settle(function () { return !!document.querySelector('[data-act="chip-missing-cost"]'); }, 4000);
    report('选「缺进价」→ 出现活跃筛选 chip「只看缺进价」',
      !!document.querySelector('[data-act="chip-missing-cost"]'),
      mapFlat('[data-act="active-filters"] .gd-chip'));
    report('筛缺进价是靠发参数给主进程（不是界面自己过滤，否则分页会藏住后面的款）',
      calls('productList').some(function (p) { return p && p.onlyMissingCost === true; }),
      JSON.stringify(calls('productList').slice(-1)[0]));
    report('筛出的每一行进价都是「—」（即真的只留下没维护进价的款）',
      productRows().length > 0 &&
        Array.from(productRows()).every(function (r) { return flat(r.querySelector('[data-act="p-cost"]')) === '—'; }),
      'rows=' + productRows().length);
    document.querySelector('[data-act="chip-missing-cost"]').click();
    await settle(function () { return !document.querySelector('[data-act="chip-missing-cost"]'); }, 4000);
    report('点 chip × → 撤掉缺进价筛选，回到全部款式',
      !document.querySelector('[data-act="chip-missing-cost"]') && !!issueSel() && issueSel().value === '',
      'value=' + (issueSel() ? issueSel().value : 'missing'));

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
    /**
     * 打开第 n 行（默认第一行）的编辑抽屉。
     *
     * S4 之后「编辑」是**行尾按钮、每行一个**，而原先那个 edit-product 只长在展开区里
     * （天然唯一）。所以不能再 document.querySelector 一把抓 —— 那会永远拿到第一行，
     * 而某几步要的是第二行（S2）。
     */
    function openEditorOf(n) {
      var r = productRows()[n || 0];
      var b = r && r.querySelector('[data-act="row-edit"]');
      if (b) b.click();
      return !!b;
    }
    var p1 = { code: cellOf('p-code', 0), name: cellOf('p-name', 0) };
    report('产品表主列：款编码 / 款式名（SKU 与进价已整列撤掉，见下两条反向守卫）',
      p1.code === 'S1' && p1.name === window.__smokeLongStyleName,
      JSON.stringify(p1));
    // 反向守卫：主表**不该**再有供应商/类目列 —— 分栏之后栏宽有限，这两列（外加"操作"）
    // 移进了行展开（方案 §7-1）。哪天有人"顺手"把它们加回主表，紧凑列表就白裁了，
    // 而症状是"左边那栏又开始横向挤"这种没人会当成 bug 的样子。
    report('主表不再塞供应商/类目列（移进行展开；加回来等于没裁）',
      !productRows()[0].querySelector('[data-act="p-supplier"]') &&
        !productRows()[0].querySelector('[data-act="p-category"]'));
    // 2026-10-10 用户口径：产品列表不展示 SKU 与缺克重（进价那一列当时一并撤掉）。
    // 这条是**反向守卫**：撤掉的东西哪天被"顺手"加回来，款名又要开始显示不全，
    // 而界面不会报错 —— 只会回到用户最初报的那个症状上。
    // ⚠️ 撤列**不等于**撤能力（各有入口，各有断言）：缺克重 → 工具栏「问题件 › 缺克重」筛选
    //    （filter-issue，上面 filter 步与"唯一入口"那条一起守）；进价 → 产品编辑抽屉的「进价（元）」栏
    //    （cost-save-in-drawer 步守）+ 产品列表「只看缺进价」筛选（issue-filter-cost 步守；
    //    原「基础数据 › 进价」页已在 2026-10-22 整页退役）。
    // ⚠️ 2026-10-22（方案 B'）：进价页退役，进价改成"产品列表直接展示一列 + 抽屉里维护"。
    //    所以这条反向守卫**不再禁止 p-cost**（它现在就是用户要的"产品列表展示进价字段"）；
    //    SKU 与 缺克重 仍按 2026-10-10 口径不展示。
    report('主表不再有 SKU 数 / 缺克重两列（2026-10-10 用户口径；进价列 2026-10-22 随进价页退役重新展示）',
      !productRows()[0].querySelector('[data-act="p-sku"]') &&
        !productRows()[0].querySelector('[data-act="missing-weight-cell"]'),
      'sku=' + !!productRows()[0].querySelector('[data-act="p-sku"]') +
        ' missing=' + !!productRows()[0].querySelector('[data-act="missing-weight-cell"]') +
        ' cost=' + !!productRows()[0].querySelector('[data-act="p-cost"]'));

    // ── 款名"显示不全"（2026-10-10 用户报的症状）─────────────────────────
    // 撤列只是给款名腾宽度的**一半**修法；另一半是款名自己做两行折行（.gd-pane__name-text）。
    // ⚠️ 判据必须能真的红：短名在两行内怎么排都放得下 ⇒ 恒绿。夹具里 S1 就是一个 18 字的长款名，
    //    旧布局（款名那列被 SKU 挤到 ~130px）必然放不下，新布局两行放得下。
    //    三条合起来才叫"显示完整"：整段字在（没被换短）+ 不横向溢出 + 不超过两行。
    var nameCell = productRows()[0].querySelector('[data-act="p-name"]');
    var nameBox = nameCell ? nameCell.querySelector('.gd-pane__name-text') : null;
    report('长款名整段都渲染出来了（没有被"悄悄换短"或截成别的字串）',
      !!nameCell && flat(nameCell) === window.__smokeLongStyleName,
      'name=' + (nameCell ? flat(nameCell) : 'missing'));
    report('长款名横向不溢出自己的格子（溢出就是又被裁掉了 —— 用户报的正是这个）',
      !!nameCell && nameCell.scrollWidth <= nameCell.clientWidth + 1,
      'w=' + (nameCell ? nameCell.scrollWidth + '/' + nameCell.clientWidth : 'missing'));
    // ⚠️ 判据里必须带「clientHeight > 0」：折行盒是块级（-webkit-box）；哪天有人把里层那个 span
    //    改回 display:inline（单行省略号那一版），它的 clientHeight/scrollHeight 会是 **0/0**，
    //    而「0 <= 0 + 1」**恒真** —— 那样这条断言就成了空转（实测：变异回单行时它照样绿）。
    report('长款名最多两行、不被切掉（「scrollHeight」超过「clientHeight」= 第三行没了）',
      !!nameBox && nameBox.clientHeight > 0 && nameBox.scrollHeight <= nameBox.clientHeight + 1,
      'h=' + (nameBox ? nameBox.scrollHeight + '/' + nameBox.clientHeight : 'missing'));

    // ── 单击一行 = 选中（P2 · S4）──────────────────────────────────────
    // 原来是"单击 = 展开"，而展开区里塞着五样东西：认款按钮 / 供应商类目 / 编辑删除 /
    // 已关联反查。用户原话是"点了不知道看哪儿"。现在一行只做一件事，其余各归各处：
    //   · 选中 → 右栏动作条的落点（唯一跨栏状态仍是 currentProduct）
    //   · 档案（供应商 / 类目 / 款名 / 删除）→ 行尾「编辑」打开的抽屉
    //   · 已关联反查 → 右栏「已认」段的「只看当前款」
    // ⚠️ 判据要超出"点完有高亮"：① 展开区**真的**没了；② 高亮落在**点的那一行**；
    //    ③ 再点同一行**不取消**（取消会把动作条落点清掉 —— 用户勾了一堆商品后手滑再点一下，
    //    不该被迫从头再来）。
    step('row-select');
    report('左栏既没有展开区、也没有展开钮（一行只做一件事：单击 = 选中）',
      !detail() && !document.querySelector('[data-act="row-expand"]'),
      'detail=' + !!detail() + ' caret=' + !!document.querySelector('[data-act="row-expand"]'));
    productRows()[1].click();
    await settle(function () {
      return !!productRows()[1] && productRows()[1].classList.contains('is-on');
    }, 4000);
    report('单击第二行 → 只有它高亮（选中态落在**点的那一行**，不是永远第一行）',
      productRows()[1].classList.contains('is-on') && !productRows()[0].classList.contains('is-on'),
      'r0=' + productRows()[0].classList.contains('is-on') +
        ' r1=' + productRows()[1].classList.contains('is-on'));
    productRows()[1].click();
    await sleep(150);
    report('再点同一行**不取消**（动作条的落点不该被手滑清掉）',
      productRows()[1].classList.contains('is-on'));
    report('点行**不再**产生任何展开行（撤干净了，不是"藏起来"）',
      !document.querySelector('[data-act="row-detail"]'),
      'detail=' + !!document.querySelector('[data-act="row-detail"]'));

    // ── 档案搬进抽屉（S4 的能力新家）──────────────────────────────────
    // 展开区里的供应商 / 类目 / 编辑 / 删除必须有**一处真的还在**的地方。
    // 撤展开最容易做成"顺手把能力也删了"，而界面上不会报错，只会"某个信息再也找不到"。
    step('profile-in-drawer');
    var editBtn = productRows()[1].querySelector('[data-act="row-edit"]');
    report('行尾有「编辑」（档案入口：它取代了行首那个 ▸ 小三角）', !!editBtn);
    if (editBtn) editBtn.click();
    await settle(function () { return !!document.querySelector('.wb-drawer [data-act="ed-supplier"]'); }, 6000);
    report('抽屉里给出了原来展开区的档案字段：供应商 / 类目 / 款名',
      !!document.querySelector('.wb-drawer [data-act="ed-supplier"]') &&
        !!document.querySelector('.wb-drawer [data-act="ed-category"]') &&
        !!document.querySelector('.wb-drawer [data-act="ed-name"]'));
    // 光有字段不算搬过来了 —— 值必须是**这一款**的（S2：类目=衣服、款名=款二、未关联供应商）
    var edCat = document.querySelector('.wb-drawer [data-act="ed-category"]');
    var edName = document.querySelector('.wb-drawer [data-act="ed-name"]');
    var edSup = document.querySelector('.wb-drawer [data-act="ed-supplier"]');
    report('抽屉里的档案是**这一款的值**（S2：类目=衣服、款名=款二、供应商未关联）',
      !!edCat && edCat.value === '衣服' && !!edName && edName.value === '款二' &&
        !!edSup && String(edSup.value) === '0',
      'cat=' + (edCat ? edCat.value : 'missing') +
        ' name=' + (edName ? edName.value : 'missing') +
        ' sup=' + (edSup ? edSup.value : 'missing'));
    report('⭐ 抽屉里有**款级删除**（展开区那个「删除」的新家；没有它，撤展开就是丢能力）',
      !!document.querySelector('.wb-drawer [data-act="ed-delete-product"]'));
    var ddel = document.querySelector('.wb-drawer [data-act="ed-delete-product"]');
    if (ddel) ddel.click();
    await settle(function () { return !!document.querySelector('.wb-mask .wb-dialog__head'); }, 4000);
    var delMask = document.querySelector('.wb-mask');
    report('款级删除有二次确认，且说清"物理删除不可撤销 + 有历史链路请改用停用"',
      !!delMask && flat(delMask).indexOf('不可撤销') >= 0 && flat(delMask).indexOf('停用') >= 0,
      delMask ? flat(delMask).slice(0, 60) : 'missing');
    // 取消删除（夹具不能少一个款 —— 后面几十条断言都长在 S1/S2 上）
    var delFootBtns = delMask ? delMask.querySelectorAll('.wb-dialog__foot button') : [];
    if (delFootBtns.length) delFootBtns[0].click();
    await sleep(150);
    report('取消删除后这个款还在（确认框不是"点了就算数"）',
      productRows().length >= 2 && !document.querySelector('.wb-mask .wb-dialog__head'));
    // 关抽屉（这一步没改任何字段，✕ 直接关，不该弹"会丢改动"的确认）
    var edClose = document.querySelector('.wb-drawer .ed-x');
    if (edClose) edClose.click();
    await settle(function () { return !document.querySelector('.wb-drawer'); }, 5000);
    report('关掉抽屉后回到列表（且没有把"选中"一起清掉 —— 落点还在）',
      !document.querySelector('.wb-drawer') && productRows()[1].classList.contains('is-on'));

    // ── 已关联反查：搬到右栏「已认」的「只看当前款」（S4）────────────────
    // 这是"数据模型里产品挂在商品上"这件事在**产品侧**的入口。两条口径必须同时钉：
    //   ① 反查必须带 productId（不带 = 每一款都显示全库映射，且不报错）；
    //   ② 失效的映射**不能**混进"已关联"（混进来用户会以为那个商品还在用）。
    step('detail-links');
    await clickText('[data-act="sub-mapped"]', '已认');
    await settle(function () { return !!document.querySelector('[data-act="mapped-by-product"]'); }, 6000);
    var byProd = document.querySelector('[data-act="mapped-by-product"]');
    report('右栏「已认」段给出「只看当前款」（左栏选中哪一款，它就说哪一款）',
      !!byProd && flat(byProd).indexOf('只看当前款') >= 0, byProd ? flat(byProd) : 'missing');
    var listCalls0 = calls('productSkuList').length;
    if (byProd) byProd.click();
    await settle(function () {
      return calls('productSkuList').length > listCalls0 &&
        calls('productSkuList').slice(-1)[0].productId === 2;
    }, 6000);
    report('⭐ 反查请求真的带上了 productId（不带的话每一款都显示全库映射，且不报错）',
      calls('productSkuList').slice(-1)[0].productId === 2,
      JSON.stringify(calls('productSkuList').slice(-1)[0]));
    // S2 只有 1 条 confirmed（B0OLD0002）+ 1 条失效（B0OLD0001）：筛完是 2 行，状态列分得清
    await settle(function () {
      return all('[data-act="mapped-table"] tbody tr[data-item-id]').length === 2;
    }, 6000);
    var byProdRows = all('[data-act="mapped-table"] tbody tr[data-item-id]');
    report('只看当前款 S2 → 只剩它自己那 2 条（不是全库 4 条）',
      byProdRows.length === 2 &&
        byProdRows.map(function (r) { return r.getAttribute('data-item-id'); })
          .sort().join(',') === 'B0OLD0001,B0OLD0002',
      'rows=' + JSON.stringify(byProdRows.map(function (r) { return r.getAttribute('data-item-id'); })));
    report('按钮自己改口报「已筛 + 条数」（用户分得清看到的是一部分还是全部）',
      flat(byProd).indexOf('只看 S2') >= 0 && flat(byProd).indexOf('2 条') >= 0,
      flat(byProd));
    // 再按一下取消：出口必须存在（看完这一款多半要回到全量找别的）
    byProd.click();
    await settle(function () {
      return all('[data-act="mapped-table"] tbody tr[data-item-id]').length === 4;
    }, 6000);
    report('再按一下取消过滤，回到全量 4 条（出口存在，不是"筛进去出不来"）',
      all('[data-act="mapped-table"] tbody tr[data-item-id]').length === 4,
      'rows=' + all('[data-act="mapped-table"] tbody tr[data-item-id]').length);
    await clickText('[data-act="sub-pending"]', '待认');
    await settle(function () { return !!document.querySelector('[data-act="pending-table"]'); }, 6000);

    // ── 行内不再有任何输入控件（反向守卫）──────────────────────────────
    // 展开区撤掉后，"克重只在编辑抽屉里改"这条要靠**行内没有输入框**来守 ——
    // 哪天有人给行内加个快捷编辑，克重就有了第二个实现（改一处漏一处就是两条口径）。
    step('weight-in-editor-only');
    report('产品行内没有任何输入控件（克重 / 供应商 / 类目只能在「编辑」抽屉里改）',
      productRows()[0].querySelectorAll('input:not([type="checkbox"]), select, textarea').length === 0,
      'inputs=' + productRows()[0].querySelectorAll('input:not([type="checkbox"]), select, textarea').length);


    // ── 编辑抽屉的保存模型（2026-10-08 R2 · UX-G3 + W1）──────────────────
    // 旧模型是"一半一半"：表单要按底部「保存」，主图 / SKU 却即时保存 ⇒ "填了名字直接点 ✕"
    // 就是**没保存**，而「取消」不提示就关掉了（真机走查实测：用户以为存了）。
    // 三条判据都超出"按钮换了文案"：
    //   ① 编辑模式底部只有「完成」、**没有「取消」**（没有可取消的对象，留着就是骗人）；
    //   ② 改一个字段**离开输入框就落库**（不用按任何按钮），且**只写一次**（blur 与「完成」撞上时）；
    //   ③ 关掉**真的会丢**的东西（未保存的 SKU 改动）先确认；选「取消」抽屉还在，选「放弃」才关。
    step('editor-save-model');
    openEditorOf(0);
    await waitFor(function () { return !!document.querySelector('.wb-drawer [data-act="ed-autosave-hint"]'); }, 5000);
    var footBtns = Array.prototype.map.call(document.querySelectorAll('.wb-drawer .wb-dialog__foot button'), flat);
    // ⚠️ 2026-10-25（S4）：底部现在是**两颗**（完成 + 删除这款）—— 款级删除从行展开区搬进抽屉后
    //    有了自己的家。加一颗删除**不违反**这条契约：契约禁的是「取消」（没有可取消的对象，
    //    留着就是骗人），删除是有对象、有二次确认的另一个动作。判据改成"没有取消 / 保存"。
    report('编辑模式底部没有「取消」（改动已即时落库，取消没有可取消的对象）',
      footBtns.length >= 1 && footBtns[0].indexOf('完成') >= 0 &&
        !footBtns.some(function (t) { return t.indexOf('取消') >= 0 || t.indexOf('保存') >= 0; }),
      JSON.stringify(footBtns));
    report('款级删除也在底部，但它不是「取消」（有自己的二次确认，见 profile-in-drawer 那一步）',
      footBtns.some(function (t) { return t.indexOf('删除这款') >= 0; }), JSON.stringify(footBtns));
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

    // SKU 矩阵**刻意不自动存**（一次可能改几十格，逐格 blur 存会变成几十次写）——
    // 所以必须有别的兜底：页脚常显"还有 N 处没保存"，关闭前还要确认。
    // 先等 SKU 子表**渲染出来**再取那一格（子表是异步拉的，取不到会让下面抛 TypeError
    // 把整段冒烟打断，读日志的人只看到"异常"，看不出是"子表还没来"）。
    await waitFor(function () { return !!document.querySelector('.wb-drawer [data-act="ed-weight"]'); }, 6000);
    var dirtyWeight = document.querySelector('.wb-drawer [data-act="ed-weight"]');
    dirtyWeight.value = '333';
    dirtyWeight.dispatchEvent(new Event('input'));
    await settle(function () { return !!document.querySelector('[data-act="ed-guard-hint"]'); }, 4000);
    report('页脚常显"SKU 矩阵还有 1 处改动没保存"（不自动存的东西必须有别的兜底，且要**提前**说）',
      flat(document.querySelector('[data-act="ed-guard-hint"]')).indexOf('SKU 矩阵还有 1 处改动没保存') >= 0,
      flat(document.querySelector('[data-act="ed-guard-hint"]')));
    // 基线是 **0**：展开区已经把克重的写入路径整块移除（weight-in-editor-only 步），
    // 本轮唯一的 SKU 写入就只剩抽屉里这条还没保存的改动 —— 写进去就是"静默保存"。
    report('没保存的 SKU 改动不该被静默写库（判据：此刻一次 SKU 写入都没有）',
      calls('productVariantUpsert').length === 0, 'calls=' + calls('productVariantUpsert').length);
    document.querySelector('.wb-drawer .ed-x').click();
    await settle(function () { return !!document.querySelector('[data-act="confirm-dialog"]'); }, 4000);
    report('带未保存的 SKU 改动点 ✕ → 先确认（不是无声关掉，"我改的没了"是新手最贵的一课）',
      flat(document.querySelector('[data-act="confirm-dialog"]')).indexOf('SKU 矩阵还有 1 处改动没保存') >= 0,
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

    // ── 产品 SKU 的**来源**：从采集商品导入矩阵（2026-10-23）────────────────
    // 用户口径：产品只维护一套完整矩阵，矩阵内容来自采集商品的 SKU。
    // 三条判据：① 只列**认到这款**的采集商品（服务端 productId 过滤，不是客户端筛）；
    //   ② 导入**只补缺口**（已有的 320 不许被采集里的 999 覆盖），且**不落库**（仍要按保存）；
    //   ③ 色图顺手采纳（只补空；失败不影响矩阵）。
    step('matrix-import');
    openEditorOf(0);
    await waitFor(function () {
      var b = document.querySelector('.wb-drawer [data-act="ed-import-open"]');
      return !!b && !b.disabled && !!document.querySelector('.wb-drawer [data-act="ed-weight"]');
    }, 6000);
    document.querySelector('.wb-drawer [data-act="ed-import-open"]').click();
    await waitFor(function () {
      return document.querySelectorAll('.wb-drawer [data-act="ed-import-item"]').length === 2;
    }, 6000);
    var impCall = calls('shopItemsList').slice(-1)[0] || {};
    report('导入按 productId 向服务端要「认到这款的采集商品」（不带的话每款都会看到全库快照）',
      Number(impCall.productId) === 1 && !impCall.onlyUnconfirmed,
      JSON.stringify(impCall));
    var impIds = all('.wb-drawer [data-act="ed-import-item"]').map(function (b) {
      return String(b.getAttribute('data-item-id'));
    });
    report('候选只有认到这款的两条（7002 没采到 SKU、7004 带真矩阵）；未认款的 7001/7003 不在',
      impIds.length === 2 && impIds.indexOf('B0XYZ1234') >= 0 && impIds.indexOf('1005007777777777') >= 0 &&
        impIds.indexOf('1005001234567890') < 0 && impIds.indexOf('1005009876543210') < 0,
      JSON.stringify(impIds));
    var noSkuItem = document.querySelector('.wb-drawer [data-act="ed-import-item"][data-item-id="B0XYZ1234"]');
    report('没采到 SKU 的采集行也在候选里，但写明「没采到 SKU」（不是从列表里消失）',
      !!noSkuItem && flat(noSkuItem).indexOf('没采到 SKU') >= 0,
      noSkuItem ? flat(noSkuItem).slice(0, 50) : 'missing');
    // 默认选组合最多的那条；预览必须**先给人看**要变什么，再让人点「并入」
    var impPreview = document.querySelector('.wb-drawer [data-act="ed-import-preview"]');
    report('默认选中组合最多的 7004，预览写明增量（新增 1 色 · 1 个尺码 · 2 个组合 · 补 1 格克重）',
      !!impPreview && flat(impPreview).indexOf('新增 1 色') >= 0 &&
        flat(impPreview).indexOf('新增 1 个尺码') >= 0 && flat(impPreview).indexOf('2 个组合') >= 0 &&
        flat(impPreview).indexOf('补 1 格克重') >= 0 &&
        flat(document.querySelector('.wb-drawer [data-act="ed-import-item"][data-item-id="1005007777777777"]')).indexOf('4 个组合') >= 0,
      impPreview ? flat(impPreview) : 'missing');
    // 换到没 SKU 的那条：预览消失、并入不可点（选了也没东西可并）
    noSkuItem.click();
    await settle(function () { return !document.querySelector('.wb-drawer [data-act="ed-import-preview"]'); }, 3000);
    var impApplyBtn = document.querySelector('.wb-drawer [data-act="ed-import-apply"]');
    report('选到没 SKU 的那条 → 没有预览、并入按钮禁用（不是让人点了才发现没内容）',
      !document.querySelector('.wb-drawer [data-act="ed-import-preview"]') &&
        !!impApplyBtn && impApplyBtn.disabled,
      'disabled=' + !!(impApplyBtn && impApplyBtn.disabled));
    // 切回来再并
    document.querySelector('.wb-drawer [data-act="ed-import-item"][data-item-id="1005007777777777"]').click();
    await settle(function () { return !!document.querySelector('.wb-drawer [data-act="ed-import-preview"]'); }, 3000);
    document.querySelector('.wb-drawer [data-act="ed-import-apply"]').click();
    await waitFor(function () {
      var h = document.querySelector('.wb-drawer [data-act="ed-import-hint"]');
      return !!h && flat(h).indexOf('色图已采纳 1 张') >= 0;
    }, 6000);
    report('并入后面板收起、回执说清并入了什么（1 色 · 1 个尺码 · 2 个组合 · 补 1 格克重 + 色图 1 张）',
      !document.querySelector('.wb-drawer [data-act="ed-import-panel"]') &&
        flat(document.querySelector('.wb-drawer [data-act="ed-import-hint"]')).indexOf('已从采集商品导入') >= 0,
      flat(document.querySelector('.wb-drawer [data-act="ed-import-hint"]')));
    // 一格一个输入框之后，空格也是真输入框 —— 读值必须只取"存在的格"，
    // 否则空格会混进来变成 ''（这是测量对象变了，不是"只补缺口"坏了）。
    var mergedWeights = all('.wb-drawer [data-act="ed-weight"][data-cell-on="1"]').map(function (i) { return i.value; });
    report('⭐ 只补缺口：已有的 320 保留（采集里的 999 打不过它），空格补 150、新色新码 180/待填',
      JSON.stringify(mergedWeights) === JSON.stringify(['320', '150', '', '180']),
      'weights=' + JSON.stringify(mergedWeights));
    var imgCall = calls('shopItemImageFetch').slice(-1)[0] || {};
    report('色图按「采集行 + 产品 + 色」去采纳，同色多图只取第一张（这里只有红有图）',
      Number(imgCall.id) === 7004 && Number(imgCall.productId) === 1 &&
        (imgCall.colors || []).length === 1 && imgCall.colors[0].color === '红' &&
        imgCall.colors[0].imageUrl === window.__smokeImg.itemSku,
      JSON.stringify(imgCall));
    var impSaveBtn = document.querySelector('.wb-drawer [data-act="ed-sku-save"]');
    report('⭐ 导入**不落库**：状态从「已保存」变回「有 3 处待保存」、此刻一次 SKU 写入都没有',
      !!impSaveBtn && !impSaveBtn.disabled && flat(impSaveBtn).indexOf('有 3 处待保存') >= 0 &&
        calls('productVariantUpsert').length === 0,
      'btn=' + (impSaveBtn ? flat(impSaveBtn) : 'missing') + ' writes=' + calls('productVariantUpsert').length);
    // 这一步**不保存**（保存链路由 weight-save-in-drawer 步单独守）——先放弃再关，
    // 否则后面的"矩阵里改克重 → 落库"会拿到一次被导入污染的全量提交。
    document.querySelector('.wb-drawer .ed-x').click();
    await settle(function () { return !!document.querySelector('[data-act="confirm-dialog"]'); }, 4000);
    await clickText('[data-act="confirm-ok"]', '放弃改动并关闭');
    await settle(function () { return !document.querySelector('.wb-drawer'); }, 4000);
    report('导入后没保存就关 → 仍会先确认（导入被当成"未保存的改动"，不是悄悄生效）',
      !document.querySelector('.wb-drawer') && calls('productVariantUpsert').length === 0);

    // ── 克重的**唯一写入路径**（2026-10-09 起在编辑抽屉里；2026-10-23 起在 SKU 矩阵里）──
    // 展开区把克重整块搬走后，这条链不能跟着消失：矩阵保存 → 全量提交（字段齐全）→
    // 库里真的变了 → 导出读到的是**当下值**（下面 export 步等的就是 '320,333'）。
    // ⚠️ 必须排在编辑器那一步**之后**：那一步要用"没保存的改动"验 ✕ 的确认框，提前存掉就没了。
    step('weight-save-in-drawer');
    openEditorOf(0);
    await waitFor(function () {
      return document.querySelectorAll('.wb-drawer [data-act="ed-weight"]').length >= 2;
    }, 6000);
    // 行图**只作显示**（产品 SKU 没有色图字段）：按「款编码 + 色名」去订单域取一张来认色。
    // 两件事都容易静默失效：查错了色 / 点开大图还是 256px 缩略图 —— 都不报错，只是图不对。
    await waitFor(function () { return !!document.querySelector('.wb-drawer [data-act="ed-row-thumb"] img'); }, 6000);
    report('矩阵行头显示该款的色图（按「款编码 + 色名」查来，仅显示；不是产品 SKU 的字段）',
      (calls('purchaseStyleImages').slice(-1)[0].items || []).some(function (it) {
        return it.styleCode === 'S1' && it.color === '黑';
      }),
      JSON.stringify(calls('purchaseStyleImages').slice(-1)[0]));
    document.querySelector('.wb-drawer [data-act="ed-row-thumb"]').click();
    await waitFor(function () {
      var im = document.querySelector('[data-act="ed-viewer-img"]');
      return !!im && im.getAttribute('src') === window.__smokeImg.big;
    }, 6000);
    var bigSrc = document.querySelector('[data-act="ed-viewer-img"]').getAttribute('src');
    report('点色图看大图：缩略图先顶上、原图到了再换（256px 认不出印花；换没换得看 src 真的变了）',
      bigSrc === window.__smokeImg.big && bigSrc !== window.__smokeImg.thumb &&
        flat(document.querySelector('[data-act="ed-viewer"]')).indexOf('款色图') >= 0,
      'big=' + bigSrc.slice(0, 24) + ' thumb=' + window.__smokeImg.thumb.slice(0, 24));
    document.querySelector('[data-act="ed-viewer-close"]').click();
    await settle(function () { return !document.querySelector('[data-act="ed-viewer"]'); }, 4000);
    // ⭐ 改色名不该把图弄丢（2026-10-23 用户报「并入矩阵后改颜色，图片就没了」）。
    //   色图在订单域按「款编码 + 色名」查，而色名是**标签**：敲一个字查询就落空，
    //   旧实现顺手把 row.imageUrl 抹成空 ⇒ 图当场消失（库里其实还挂在款色上）。
    //   这里改成库里**没有图**的名字，图必须还在（查不到 = 没结论，不是"这张图作废"）；
    //   等满防抖（400ms）再看一次，是为了钉住"后台重查回来也不许清空"。
    var colorInput = document.querySelector('.wb-drawer [data-act="ed-color"]');
    colorInput.value = '深蓝';
    colorInput.dispatchEvent(new Event('input'));
    await settle(function () { return false; }, 700);
    var thumbAfterRename = document.querySelector('.wb-drawer [data-act="ed-row-thumb"] img');
    report('改色名后行头色图仍在（防抖重查查不到，也不许抹掉；旧实现这里 src 为空）',
      !!thumbAfterRename && thumbAfterRename.getAttribute('src') === window.__smokeImg.thumb,
      'src=' + (thumbAfterRename ? String(thumbAfterRename.getAttribute('src')).slice(0, 24) : 'missing'));
    colorInput.value = '黑';
    colorInput.dispatchEvent(new Event('input'));
    await settle(function () { return false; }, 700);
    var mWeight = document.querySelectorAll('.wb-drawer [data-act="ed-weight"]')[1];
    mWeight.value = '333';
    mWeight.dispatchEvent(new Event('input'));
    await settle(function () { return !!document.querySelector('.wb-drawer [data-act="ed-sku-save"]'); }, 4000);
    // 2026-10-25 起 SKU 的保存入口**只有底部「完成」**（用户口径「保存按钮和完成按钮合并」）：
    // 点它就落库并关抽屉，不需要先去工具条找一个保存按钮。
    var footDone = Array.prototype.slice.call(document.querySelectorAll('.wb-drawer button')).filter(function (b) {
      return b.classList.contains('wb-btn--primary') && flat(b) === '完成';
    })[0];
    report('底部有「完成」按钮（编辑模式的主保存入口）', !!footDone, 'done=' + (footDone ? 'found' : 'missing'));
    if (footDone) footDone.click();
    await waitFor(function () { return calls('productVariantUpsert').length >= 1; }, 6000);
    var wSent = calls('productVariantUpsert')[0];
    report('矩阵里改克重 → 真的落库，且**带上该行全部现有字段**（全量提交，漏字段会清空颜色/尺码）',
      !!wSent && wSent.id === 12 && Number(wSent.weightG) === 333 && wSent.productId === 1 &&
        wSent.color === '黑' && wSent.size === 'M' && wSent.name === '黑 M' && wSent.status === 'active',
      JSON.stringify(wSent));
    // 「完成」既落库也关抽屉：不用再按 ✕，也不该在关的时候再拦一次
    await settle(function () { return !document.querySelector('.wb-drawer'); }, 8000);
    report('⭐ 点「完成」= 存 SKU + 关闭抽屉（一步到底，不再需要先按「保存 SKU 矩阵」再按 ✕）',
      !document.querySelector('.wb-drawer') && calls('productVariantUpsert').length >= 1,
      'drawer=' + !!document.querySelector('.wb-drawer'));
    report('完成时没有再弹确认框（没有删除、也没有"还有 N 处没保存" —— 弹一次就是假动作）',
      !document.querySelector('[data-act="confirm-dialog"]'));

    // ── SKU 矩阵的批量手势（2026-10-24 重设计的核心：整列/整行开关 + Enter 跳格）────
    // 为什么值得守：逐格点二十下是"SKU 编辑不方便"的主因，而"整列开/关"最容易写成
    // **恒做同一件事**的实现（永远只开不清、或清错列却看着没错）。三条判据都是
    // "点了之后格子真的变了"，且都带**反向**证据（别的列不动 / 再点一次回原状）：
    //   ① 点列头 ⇒ 这一列的空格全开、已开的格一个都不丢；
    //   ② 已经全开时再点 ⇒ 整列取消（语义是"应该是"，不是"反过来"，所以是幂等的两态）；
    //   ③ 克重格里按 Enter ⇒ 焦点落到**同一列的下一格**（不是下一行、也不绕回第一格）。
    // 本步只改界面（不保存），收尾走「放弃改动并关闭」⇒ 后续步骤的夹具不受污染。
    step('sku-bulk-toggle');
    openEditorOf(0);
    await waitFor(function () {
      return document.querySelectorAll('.wb-drawer [data-act="ed-weight"]').length >= 2;
    }, 6000);
    function onCells() {
      return document.querySelectorAll('.wb-drawer [data-act="ed-weight"][data-cell-on="1"]').length;
    }
    // 一格一个输入框之后，"格还在不在"要靠 data-cell-on 分辨（空格也是真输入框，
    // 直接敲数就加入）—— 所以读值必须过滤"存在的格"，否则空格会混进来变成 ''。
    function onWeights() {
      return all('.wb-drawer [data-act="ed-weight"][data-cell-on="1"]').map(function (i) { return i.value; });
    }
    var colBtnM = document.querySelector('.wb-drawer [data-act="ed-col-all"][data-size="M"]');
    report('列头就是整列开关（这一列的尺码名长在按钮上，不是一段只读文字）',
      !!colBtnM && flat(colBtnM) === 'M', colBtnM ? flat(colBtnM) : 'missing');
    // 夹具是 1 色 × 2 码（L / M）且两格都在 ⇒ 点 M 列头该"整列取消"，L 那一格必须还在
    document.querySelector('.wb-drawer [data-act="ed-col-all"][data-size="M"]').click();
    await settle(function () { return onCells() === 1; }, 3000);
    report('⭐ 点列头（该列已全开）⇒ 只取消这一列：单元格 2 → 1，另一列的 320 原样还在',
      onCells() === 1 && JSON.stringify(onWeights()) === JSON.stringify(['320']),
      'cells=' + onCells() + ' weights=' + JSON.stringify(onWeights()));
    document.querySelector('.wb-drawer [data-act="ed-col-all"][data-size="M"]').click();
    await settle(function () { return onCells() === 2; }, 3000);
    report('再点一次同一列头 ⇒ 整列回到全开（同一个动作两态，不是"只能开"或"只能关"）',
      onCells() === 2, 'cells=' + onCells());
    // 行名 = 整行开关：1 色 2 码 ⇒ 点一下整行清空（两者都取消）
    document.querySelector('.wb-drawer [data-act="ed-row-all"]').click();
    await settle(function () { return onCells() === 0; }, 3000);
    report('⭐ 点行名 ⇒ 整行取消（2 → 0），统计跟着说 0 个组合（不是"格子没了但数字还留着"）',
      onCells() === 0 && flat(document.querySelector('.wb-drawer [data-act="ed-stat"]')).indexOf('0 个组合') >= 0,
      'cells=' + onCells() + ' stat=' + flat(document.querySelector('.wb-drawer [data-act="ed-stat"]')));
    document.querySelector('.wb-drawer [data-act="ed-row-all"]').click();
    await settle(function () { return onCells() === 2; }, 3000);
    report('再点一次行名 ⇒ 整行回来（空格 = 不存在，回来的是"存在但待填"，不是被悄悄塞了个假值）',
      onCells() === 2 &&
        JSON.stringify(all('.wb-drawer [data-act="ed-weight"]').map(function (i) { return i.value; })) === JSON.stringify(['', '']),
      'weights=' + JSON.stringify(all('.wb-drawer [data-act="ed-weight"]').map(function (i) { return i.value; })));
    // Enter 跳格：加一色 ⇒ 两行；从第一行 L 的克重格按 Enter，焦点该落到第二行 L（同列下一格）
    document.querySelector('.wb-drawer [data-act="ed-add"]').click();
    await settle(function () { return document.querySelectorAll('.wb-drawer [data-act="ed-weight"]').length === 4; }, 4000);
    var firstL = all('.wb-drawer [data-act="ed-weight"]').filter(function (i) {
      return i.getAttribute('data-cell-row') === '0' && i.getAttribute('data-cell-size') === 'L';
    })[0];
    if (firstL) {
      firstL.focus();
      firstL.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    }
    var actEl = document.activeElement;
    report('⭐ 克重格按 Enter ⇒ 焦点到**同一列的下一格**（14 色时不必再拿鼠标逐格点）',
      !!actEl && actEl.getAttribute('data-act') === 'ed-weight' &&
        actEl.getAttribute('data-cell-row') === '1' && actEl.getAttribute('data-cell-size') === 'L',
      'active=' + (actEl ? actEl.getAttribute('data-act') + ' r' + actEl.getAttribute('data-cell-row') + ' s' + actEl.getAttribute('data-cell-size') : 'none'));
    // 收尾：不保存（这些改动只验手势，落库会污染后面的夹具）
    document.querySelector('.wb-drawer .ed-x').click();
    await settle(function () { return !!document.querySelector('[data-act="confirm-dialog"]'); }, 4000);
    await clickText('[data-act="confirm-ok"]', '放弃改动并关闭');
    await settle(function () { return !document.querySelector('.wb-drawer'); }, 4000);
    report('批量手势只改界面：收尾放弃后没有一次 SKU 写入（否则"试试看"会变成真改库）',
      !document.querySelector('.wb-drawer'), 'drawer=' + !!document.querySelector('.wb-drawer'));

    // ── 按码填克重 + 一格一个控件（2026-10-25）──────────────────────────────
    // 为什么改：真库 303 个已填克重的 SKU 里，按「产品 + 尺码」分组后，有 2 色以上的
    // 86 组**全部**"同码各色完全一致"（0 组不一致，涉及 298 个 SKU）—— 克重的粒度是
    // 「款 × 码」，不是"格"。逐格填 40 次里最多 6 次带着新信息。
    // 四条判据都带反向证据，否则"填一列"很容易写成"填全表"还照样绿：
    //   1 列头填值 ⇒ 这一列全改，另一列原样；2 列头填值**不造 SKU**；
    //   3 空格里敲数 ⇒ 一步加入并填值；4 Delete 两段式（清值 → 再按才移除组合）。
    step('sku-column-weight');
    var upsertBeforeCol = calls('productVariantUpsert').length;
    openEditorOf(0);
    await waitFor(function () {
      return document.querySelectorAll('.wb-drawer [data-act="ed-weight"]').length >= 2;
    }, 6000);
    document.querySelector('.wb-drawer [data-act="ed-add"]').click();
    await settle(function () {
      return document.querySelectorAll('.wb-drawer [data-act="ed-weight"]').length === 4;
    }, 4000);
    function colW(size) {
      return document.querySelector('.wb-drawer [data-act="ed-col-weight"][data-size="' + size + '"]');
    }
    function wCell(r, s) {
      return document.querySelector(
        '.wb-drawer [data-act="ed-weight"][data-cell-row="' + r + '"][data-cell-size="' + s + '"]');
    }
    function cellState(r, s) {
      var el = wCell(r, s);
      return el ? { on: el.getAttribute('data-cell-on') === '1', v: el.value } : null;
    }
    /** 列头用的是 @change（不是 input）：边打字就铺满整列会把中间态也写进去 */
    function setChange(el, v) {
      Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, 'value').set.call(el, v);
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    var lBefore = cellState(0, 'L');
    report('列头有一个「码克重」输入框（每码一个，不是把整款值塞进每一格）',
      !!colW('M') && !!colW('L'), 'M=' + !!colW('M') + ' L=' + !!colW('L'));
    setChange(colW('M'), '700');
    await settle(function () { return !!cellState(0, 'M') && cellState(0, 'M').v === '700'; }, 3000);
    var m0 = cellState(0, 'M');
    var m1 = cellState(1, 'M');
    var l0 = cellState(0, 'L');
    report('⭐ 列头填一次 ⇒ 这一码整列都成 700，另一码（L）的值一个都没动',
      !!m0 && !!m1 && m0.v === '700' && m1.v === '700' && !!l0 && l0.v === (lBefore ? lBefore.v : ''),
      'M=' + (m0 && m0.v) + '/' + (m1 && m1.v) + ' L=' + (l0 && l0.v) + ' (改前 L=' + (lBefore && lBefore.v) + ')');
    // 把一个格删成"空格"，再填整列 ⇒ 它必须被**补回来**（2026-10-25 语义修正）。
    // 旧语义是"列头填值不造 SKU"，于是人明明填了「M = 800」，那一格在矩阵里仍算"不存在"，
    // 保存时反被判成"要删的 SKU"——用户实报「我所有的克重都已经填好了，还提示黑色 L/白色 L/红色 L 会被删掉」。
    // 现在的不变量是**克重即存在**（与"空格里敲数字就加入"同源）。
    setVal(wCell(1, 'M'), '');
    wCell(1, 'M').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await settle(function () { return !!cellState(1, 'M') && !cellState(1, 'M').on; }, 3000);
    setChange(colW('M'), '800');
    await settle(function () { return !!cellState(1, 'M') && cellState(1, 'M').on; }, 3000);
    report('⭐ 列头填值把这一列缺的格**补齐**（克重即存在）：删掉的 row1/M 被补回并带上 800',
      !!cellState(1, 'M') && cellState(1, 'M').on && cellState(1, 'M').v === '800' &&
        cellState(0, 'M').v === '800',
      'row1/M on=' + (cellState(1, 'M') && cellState(1, 'M').on) + ' v=' + (cellState(1, 'M') && cellState(1, 'M').v) +
        ' row0/M=' + cellState(0, 'M').v);
    report('补齐只说事实：回执里写明「补齐 1 个原本没有的组合」（不是"已经都是 800 g"）',
      flat(document.querySelector('.wb-drawer [data-act="ed-merge-hint"]') || document.createElement('span'))
        .indexOf('补齐') >= 0,
      'hint=' + flat(document.querySelector('.wb-drawer [data-act="ed-merge-hint"]') || document.createElement('span')));
    // 再把它删回空格，用来验下一条（空格里敲数 = 一步加入 + 填值）
    setVal(wCell(1, 'M'), '');
    wCell(1, 'M').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await settle(function () { return !!cellState(1, 'M') && !cellState(1, 'M').on; }, 3000);
    // 空格里直接敲数 = 加入 + 填值（一格一个控件省掉的就是这一步）
    setVal(wCell(1, 'M'), '250');
    await settle(function () { return !!cellState(1, 'M') && cellState(1, 'M').on; }, 3000);
    report('⭐ 空格里直接敲 250 ⇒ 一步「加入 + 填值」（不再需要先点一下勾选框再点输入框）',
      !!cellState(1, 'M') && cellState(1, 'M').on && cellState(1, 'M').v === '250',
      'on=' + (cellState(1, 'M') && cellState(1, 'M').on) + ' v=' + (cellState(1, 'M') && cellState(1, 'M').v));
    // Delete 两段式：第一次清值（组合还在），第二次才移除
    setVal(wCell(1, 'M'), '');
    await settle(function () { return !!cellState(1, 'M') && cellState(1, 'M').v === ''; }, 3000);
    report('清空只把值变成「待填」，组合还在（两段式的第一段）',
      !!cellState(1, 'M') && cellState(1, 'M').on && cellState(1, 'M').v === '',
      'on=' + (cellState(1, 'M') && cellState(1, 'M').on));
    wCell(1, 'M').dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    await settle(function () { return !!cellState(1, 'M') && !cellState(1, 'M').on; }, 3000);
    report('⭐ 空值上再按 Delete 才移除组合（一次误按不会抹掉一整条 SKU）',
      !!cellState(1, 'M') && !cellState(1, 'M').on,
      'on=' + (cellState(1, 'M') && cellState(1, 'M').on));
    // 整款克重旁的"现状"读数：混填 → 一致，两态必须不同（恒显示一句话就是假读数）
    report('有格没填时现状读数写「混填」，不编一个数',
      !!document.querySelector('.wb-drawer [data-act="ed-common-weight"]') &&
        flat(document.querySelector('.wb-drawer [data-act="ed-common-weight"]')).indexOf('混填') >= 0,
      'now=' + flat(document.querySelector('.wb-drawer [data-act="ed-common-weight"]')));
    setChange(colW('L'), '800');
    await settle(function () {
      var el = document.querySelector('.wb-drawer [data-act="ed-common-weight"]');
      return !!el && flat(el).indexOf('800') >= 0;
    }, 3000);
    report('⭐ 全部一致时现状读数变成「当前 800 g」（填之前先看见现状，才不会重复劳动）',
      flat(document.querySelector('.wb-drawer [data-act="ed-common-weight"]')).indexOf('800') >= 0,
      'now=' + flat(document.querySelector('.wb-drawer [data-act="ed-common-weight"]')));
    document.querySelector('.wb-drawer .ed-x').click();
    await settle(function () { return !!document.querySelector('[data-act="confirm-dialog"]'); }, 4000);
    await clickText('[data-act="confirm-ok"]', '放弃改动并关闭');
    await settle(function () { return !document.querySelector('.wb-drawer'); }, 4000);
    report('按码填同样只改界面：放弃后零写入',
      !document.querySelector('.wb-drawer') && calls('productVariantUpsert').length === upsertBeforeCol,
      'upsert +' + (calls('productVariantUpsert').length - upsertBeforeCol));

    // ── SKU 编码：规则 + 一键生成（2026-10-25 用户口径「SKU规则设置，并支持一键设置」）──
    // 真库 411 个 SKU 零编码 —— 逐条手打没人做，所以这条路是编码能不能用起来的关键。
    // 两条判据必须都在：①只填空（已有编码不被覆盖）②只改草稿、不落库。
    step('sku-code-rule');
    var codeUpsertBefore = calls('productVariantUpsert').length;
    openEditorOf(0);
    await waitFor(function () {
      return document.querySelectorAll('.wb-drawer [data-act="ed-weight"]').length >= 2;
    }, 6000);
    var codesDetails = document.querySelector('.wb-drawer details[data-act="ed-codes"]');
    if (codesDetails && !codesDetails.open) codesDetails.querySelector('summary').click();
    await settle(function () { return !!document.querySelector('.wb-drawer [data-act="ed-code-rule"]'); }, 3000);
    // ── 展开后必须**看得见**（2026-10-25 用户实报「打开 SKU 编码编辑时被上面的组合遮挡」）──
    // 判据不判"卡片是否存在"（那种断言在压扁/盖住时照样绿）：
    //   ① 编码区顶边落在吸顶工具条**下沿之后**（否则展开的那块藏在工具条底下）；
    //   ② 第一行编码框的命中测试是它自己 —— 被组合区/工具条盖住时 elementFromPoint 返回别的元素。
    var edMain = document.querySelector('.wb-drawer .ed-main');
    var edBar = document.querySelector('.wb-drawer .ed-main__bar');
    var edDet = document.querySelector('.wb-drawer details[data-act="ed-codes"]');
    var edFirst = document.querySelector('.wb-drawer .ed-codes__input');
    await settle(function () { return false; }, 200);
    var mRect = edMain ? edMain.getBoundingClientRect() : null;
    var bRect = edBar ? edBar.getBoundingClientRect() : null;
    var dRect = edDet ? edDet.getBoundingClientRect() : null;
    var iRect = edFirst ? edFirst.getBoundingClientRect() : null;
    var edHit = null;
    if (iRect) edHit = document.elementFromPoint(iRect.left + iRect.width / 2, iRect.top + iRect.height / 2);
    report('展开的编码区在吸顶工具条下沿之后、第一行编码框没被上面的组合区盖住（命中测试是它自己）',
      !!dRect && !!bRect && !!mRect && dRect.top >= bRect.bottom - 1 && dRect.top >= mRect.top &&
        edHit === edFirst,
      'detTop=' + (dRect ? Math.round(dRect.top) : 'x') + ' barBottom=' + (bRect ? Math.round(bRect.bottom) : 'x') +
        ' hit=' + (edHit ? edHit.tagName + '.' + String(edHit.className) : 'null'));

    // 右栏空间不够时（矮窗口 / 多色多码），展开必须**自己滚过去**，不能指望用户猜"下面还有"。
    // 判据用 scrollTop：把容器压小再展开，若没有「展开即入视野」这条逻辑，scrollTop 恒为 0。
    var prevMaxH = edMain ? edMain.style.maxHeight : '';
    if (edMain) {
      edMain.style.maxHeight = '300px';
      edDet.open = false;
      await settle(function () { return !edDet.open; }, 1000);
      edMain.scrollTop = 0;
      edDet.querySelector('summary').click();
      await settle(function () { return edDet.open; }, 1000);
      await settle(function () { return false; }, 250);
      var dRect2 = edDet.getBoundingClientRect();
      var mRect2 = edMain.getBoundingClientRect();
      var bRect2 = edBar.getBoundingClientRect();
      report('⭐ 右栏空间不足时，展开编码区会把它自己滚进视野（不是等用户去猜）',
        edMain.scrollTop > 0,
        'scrollTop=' + Math.round(edMain.scrollTop) + ' maxH=300' +
          ' mainH=' + Math.round(mRect2.height) + ' sh=' + edMain.scrollHeight + ' ch=' + edMain.clientHeight +
          ' detTop=' + Math.round(dRect2.top) + ' detH=' + Math.round(dRect2.height) +
          ' mainTop=' + Math.round(mRect2.top) + ' mainBottom=' + Math.round(mRect2.bottom) +
          ' barBottom=' + Math.round(bRect2.bottom) + ' open=' + edDet.open);
      edMain.style.maxHeight = prevMaxH;
    }
    var ruleInput = document.querySelector('.wb-drawer [data-act="ed-code-rule"]');
    // 不写死"{code}-{color}-{size}"：规则存在 localStorage，本步末尾会改成别的规则，
    // 下一次跑就带着新值进来 —— 那样这条断言会红在"上次的残留"上，与实现无关。
    report('编码区有「规则」输入框，且默认带上款号占位符 {code}（规则不是空的）',
      !!ruleInput && ruleInput.value.indexOf('{code}') >= 0, 'rule=' + (ruleInput ? ruleInput.value : 'missing'));
    var prevEl = document.querySelector('.wb-drawer [data-act="ed-code-preview"]');
    report('规则旁边给出**真实预览**（拿第一条 SKU 的实际值算，含款号 S1 —— 不是示例文字）',
      !!prevEl && flat(prevEl).indexOf('S1') >= 0, 'preview=' + (prevEl ? flat(prevEl) : 'missing'));
    document.querySelector('.wb-drawer [data-act="ed-code-gen"]').click();
    await settle(function () {
      var inputs = all('.wb-drawer .ed-codes__input');
      return inputs.length >= 2 && inputs.every(function (i) { return i.value.trim() !== ''; });
    }, 3000);
    var codeVals = all('.wb-drawer .ed-codes__input').map(function (i) { return i.value; });
    report('⭐ 一键生成填满所有空编码，同时**保留**已有的 SKU-A（覆盖已经核对过的编码比留空更糟）',
      codeVals.indexOf('SKU-A') >= 0 && codeVals.every(function (v) { return v.trim() !== ''; }) &&
        codeVals.filter(function (v) { return v.indexOf('S1') === 0; }).length >= 1,
      JSON.stringify(codeVals));
    report('一键生成只改草稿、不落库（要按底部「完成」才写进库）',
      calls('productVariantUpsert').length === codeUpsertBefore,
      'upsert +' + (calls('productVariantUpsert').length - codeUpsertBefore));
    setVal(ruleInput, '{code}{index}');
    document.querySelector('.wb-drawer [data-act="ed-code-gen-all"]').click();
    await settle(function () {
      var inputs = all('.wb-drawer .ed-codes__input');
      return inputs.length >= 2 && inputs.every(function (i) { return /^S1[0-9]{2}$/.test(i.value); });
    }, 3000);
    var allVals = all('.wb-drawer .ed-codes__input').map(function (i) { return i.value; });
    report('⭐「全部重写」按新规则覆盖（连 SKU-A 也换掉）—— 两个动作分得很清，不靠一次点击猜意图',
      allVals.every(function (v) { return /^S1[0-9]{2}$/.test(v); }) &&
        allVals.length === new Set(allVals).size,
      JSON.stringify(allVals));
    document.querySelector('.wb-drawer .ed-x').click();
    await settle(function () { return !!document.querySelector('[data-act="confirm-dialog"]'); }, 4000);
    await clickText('[data-act="confirm-ok"]', '放弃改动并关闭');
    await settle(function () { return !document.querySelector('.wb-drawer'); }, 4000);
    report('编码步不落库（放弃后零写入）',
      !document.querySelector('.wb-drawer') && calls('productVariantUpsert').length === codeUpsertBefore,
      'upsert +' + (calls('productVariantUpsert').length - codeUpsertBefore));

    // ── 版式与可读性（2026-10-24 用户口径：SKU 样式乱 / 有重叠 / 颜色不直观 / 文字太多）──
    // 这一屏的成败全在"看着"：规格区一旦按 196px 的色卡铺开，7 色就要吃掉 330px，
    // 矩阵被压成三行（"重叠"其实是挤到看不清）；而没有色图的色名就是 14 行汉字。
    // 四条判据都能量：规格/矩阵的高度比、色块、行色条、格内不溢出。
    // ⚠️ 夹具只有 1 色 2 码 —— 单色下"规格区占多高"恒绿，所以这一步入场先补到 4 色。
    step('sku-compact-layout');
    // 只能比"这一步入场前后"的增量：前面的步骤已经真存过 SKU，绝对计数永远不为 0
    var upsertBefore = calls('productVariantUpsert').length;
    openEditorOf(0);
    await waitFor(function () {
      return document.querySelectorAll('.wb-drawer [data-act="ed-weight"]').length >= 2;
    }, 6000);
    for (var ac = 0; ac < 7; ac++) {
      document.querySelector('.wb-drawer [data-act="ed-add"]').click();
      await settle(function () { return false; }, 100);
    }
    var colorInputs = all('.wb-drawer [data-act="ed-color"]');
    setVal(colorInputs[colorInputs.length - 1], '藏青');
    await settle(function () { return false; }, 200);
    // 常用码：只补缺的（夹具已有 L / M）
    var sizeBefore = all('.wb-drawer [data-act="ed-size"]').map(function (i) { return i.value; });
    document.querySelector('.wb-drawer .mx-preset > summary').click();
    await settle(function () {
      return !!document.querySelector('.wb-drawer [data-act="ed-preset"][data-preset="full"]');
    }, 2000);
    var presetFull = document.querySelector('.wb-drawer [data-act="ed-preset"][data-preset="full"]');
    if (presetFull) presetFull.click();
    await settle(function () { return all('.wb-drawer [data-act="ed-size"]').length > sizeBefore.length; }, 3000);
    var sizeAfter = all('.wb-drawer [data-act="ed-size"]').map(function (i) { return i.value; });
    report('⭐「常用」一次补齐尺码，且只补缺的（已有 L/M 不动，列序不被重排）',
      sizeBefore.join('/') === 'L/M' && sizeAfter.join('/') === 'L/M/S/XL/XXL',
      'before=' + sizeBefore.join('/') + ' after=' + sizeAfter.join('/'));
    report('常用码菜单点完就收起（开着会一直盖住下面的矩阵）',
      !document.querySelector('.wb-drawer .mx-preset[open]'),
      'open=' + !!document.querySelector('.wb-drawer .mx-preset[open]'));
    // 判据取"一屏能看见几行组合"而不是某个像素值：用户说的是"只看得见三行"，
    // 而这正是规格区高度与表格高度共同决定的**唯一**可观察结果。
    var geo = (function () {
      function h(sel) { var el = document.querySelector(sel); return el ? Math.round(el.getBoundingClientRect().height) : 0; }
      var table = document.querySelector('.ed-main .mx-wrap');
      var row = document.querySelector('.wb-drawer [data-act="ed-row"]');
      var rowH = row ? row.getBoundingClientRect().height : 0;
      return {
        spec: h('[data-act="ed-spec"]'),
        table: h('.ed-main .mx-wrap'),
        rows: table && rowH ? Math.floor(table.clientHeight / rowH) : 0,
      };
    })();
    report('⭐ 8 色 5 码时一屏能看见 ≥ 7 行组合（旧版色卡布局实测只有 3 行 —— "挤、重叠"的来源）',
      geo.rows >= 7, 'visibleRows=' + geo.rows + ' spec=' + geo.spec + ' table=' + geo.table);
    report('规格区高度 ≤ 200px（色卡布局是 330px；这一块一旦长回来，矩阵立刻被挤没）',
      geo.spec > 0 && geo.spec <= 200, 'spec=' + geo.spec);
    // 克重框**必须是 text**：「type=number」的框被滚轮滚过就改值，而矩阵里这种框占了大半张表 ——
    // 用户想往下滚两行，指针停在哪个格上哪个格的克重就被改（"页面自己乱动"）。
    // 只断言 type（合成 WheelEvent 改不动 number 框的值，断言 value 是恒真的假守卫）。
    var weightBoxes = all('.wb-drawer [data-act="ed-weight"]');
    var numberBoxes = weightBoxes.filter(function (i) { return i.type === 'number'; }).length;
    report('⭐ 克重框不是 number 框（滚轮滚过不会把克重改掉）',
      weightBoxes.length > 0 && numberBoxes === 0,
      'number=' + numberBoxes + ' / ' + weightBoxes.length + ' boxes');
    // 命中测试：「控件在 DOM 里」和「控件的中心点真能点到它」是两件事。
    // 被固定底栏压住、被 sticky 表头盖住、被浮层挡住 —— 这三种情况下断言"元素存在"永远绿，
    // 而用户看到的是"点了没反应"。
    var occluded = (function () {
      var root = document.querySelector('[data-act="ed-sku-block"]');
      if (!root) return { n: 0, bad: ['no-root'] };
      var bad = [];
      var els = root.querySelectorAll('button,input,select,summary');
      var live = 0;
      for (var i = 0; i < els.length; i++) {
        var el = els[i];
        if (el.disabled) continue;
        // 折叠着的内容不算被盖住：Chromium 用 content-visibility 折 details，
        // 里面的控件仍有布局尺寸但不可见、不可点 —— 不排掉就是一片假阳性。
        if (el.closest('details:not([open])')) continue;
        var r = el.getBoundingClientRect();
        if (r.width < 4 || r.height < 4) continue;
        var cx = r.left + r.width / 2;
        var cy = r.top + r.height / 2;
        if (cx < 0 || cy < 0 || cx > innerWidth || cy > innerHeight) continue;
        live++;
        var hit = document.elementFromPoint(cx, cy);
        if (hit && (hit === el || el.contains(hit))) continue;
        bad.push((el.dataset.act || el.tagName) + '←' + (hit ? hit.className || hit.tagName : 'null'));
      }
      return { n: live, bad: bad };
    })();
    report('⭐ SKU 区每个可见控件的中心点都命中它自己（被盖住 = 用户点了没反应）',
      occluded.bad.length === 0,
      'checked=' + occluded.n + ' blocked=' + occluded.bad.slice(0, 4).join(' | '));
    // 色块：没有色图的色名要填近似色（藏青 = #2f3b5e）
    var zqInput = all('.wb-drawer [data-act="ed-color"]').filter(function (i) { return i.value === '藏青'; })[0];
    var zqChip = zqInput ? zqInput.closest('.mx-color') : null;
    var zqSwatch = zqChip ? zqChip.querySelector('.wb-thumb--empty') : null;
    var zqBg = zqSwatch ? getComputedStyle(zqSwatch).backgroundColor : '';
    report('⭐ 没有色图的色名也有色块（藏青 → rgb(47, 59, 94)）—— 不再是一排汉字',
      zqBg === 'rgb(47, 59, 94)', 'bg=' + zqBg);
    // 行色条：同一判据在矩阵行上（规格里改名，下面的行立刻跟着变）
    var zqRow = all('.wb-drawer [data-act="ed-row"]').filter(function (tr) {
      return flat(tr).indexOf('藏青') >= 0;
    })[0];
    report('矩阵行带同一条色条（色名 → 行的左边一眼可见）',
      !!zqRow && zqRow.style.getPropertyValue('--mx-accent') === '#2f3b5e',
      'accent=' + (zqRow ? zqRow.style.getPropertyValue('--mx-accent') : 'missing'));
    // 格内不溢出：✓ + 克重塞进 78px 的列。判据是**矩形越界**（td 的 scrollWidth 在
    // table-layout: fixed 下不可靠 —— 实测把输入框写成 96px 固定宽，scrollWidth 照样等于 clientWidth）。
    var spills = all('.wb-drawer .mx-cell').map(function (td) {
      // ⚠️ 必须量**格内控件**，不能量那个 flex 容器：容器宽度恒等于 td 的内容宽，
      //    控件从它中间溢出时容器自己的 rect 一点都没变（实测：把输入框改成 96px 固定宽，
      //    量容器照样 0 越界 ⇒ 断言恒绿，而这正是要抓的那个"压到隔壁格"）。
      var kids = Array.prototype.slice.call(td.querySelectorAll('.mx-tog, .mx-weight'));
      if (!kids.length) return 0;
      var a = td.getBoundingClientRect();
      var left = Math.min.apply(null, kids.map(function (k) { return k.getBoundingClientRect().left; }));
      var right = Math.max.apply(null, kids.map(function (k) { return k.getBoundingClientRect().right; }));
      return Math.max(Math.round(right - a.right), Math.round(a.left - left), 0);
    }).filter(function (n) { return n > 0; });
    report('5 码时「✓ + 克重」不越出单元格（越界就是压到隔壁格，用户说的"重叠"）',
      spills.length === 0, 'spill=' + spills.length + '/' + all('.wb-drawer .mx-cell').length);
    // 格内控件不许被挤扁：列宽是 auto 布局（按内容分配），码一多就会压输入框。
    // 判据取"宽度够不够用"而不是"有没有横滚"——实测表格永远等于容器宽（会把列挤窄），
    // 横滚那条因此恒绿；真正会被用户看到的失败是"数字看不见 / 点不中"。
    var wInputs = all('.wb-drawer .mx-cell .mx-weight');
    var squeezed = wInputs.filter(function (i) {
      return i.getBoundingClientRect().width < 40;
    }).length;
    // 一格只剩一个控件（2026-10-25 把"勾选框 + 克重框"合成一个输入框），所以守卫改成
    // 「格数 == 输入框数」：再退回双控件（每格两个东西挤在 78px 里）就红。
    var wCells = all('.wb-drawer .mx-cell');
    var extraControls = all('.wb-drawer .mx-cell').length &&
      all('.wb-drawer .mx-cell').reduce(function (n, td) {
        return n + Math.max(0, td.querySelectorAll('button,input').length - 1);
      }, 0);
    report('⭐ 格内控件不被挤扁（克重框 ≥ 40px）且一格只有一个控件 —— 两件挤在 78px 里就点不中、数字看不全',
      squeezed === 0 && wInputs.length >= 2 && wCells.length >= 2 && extraControls === 0,
      'squeezed=' + squeezed + ' inputs=' + wInputs.length + ' cells=' + wCells.length + ' extra=' + extraControls);
    // 认不出的色名：只点小橙点，不许整卡铺橙底（7 个色里 5 个不在词表时整屏像报错）
    var flagTarget = all('.wb-drawer [data-act="ed-color"]')[0];
    setVal(flagTarget, '4');
    await settle(function () {
      return !!document.querySelector('.wb-drawer .mx-color.is-flagged .mx-dot');
    }, 3000);
    var flagChip = document.querySelector('.wb-drawer .mx-color.is-flagged');
    var plainChip = all('.wb-drawer .mx-color').filter(function (c) { return !c.classList.contains('is-flagged'); })[0];
    report('认不出的色名只点一枚小橙点（不再整卡铺橙底 —— 那会让整屏像报错）',
      !!flagChip && !!flagChip.querySelector('.mx-dot') && !!plainChip &&
        getComputedStyle(flagChip).backgroundColor === getComputedStyle(plainChip).backgroundColor,
      'bg=' + (flagChip ? getComputedStyle(flagChip).backgroundColor : 'missing'));
    // 颜色区不许出现滚动条（2026-10-25 用户口径「颜色中的项要完全展示，不要出现滚动条」）。
    // 判据取 scrollHeight vs clientHeight：只删 CSS 里的 max-height 不够，
    // 任何祖先/换行把内容挤出去都会让它再次出现（而"被裁掉半个色"看着像这个色不存在）。
    var colorsEl = document.querySelector('.wb-drawer .mx-colors');
    var colorsCs = colorsEl ? getComputedStyle(colorsEl) : null;
    var colorCount = all('.wb-drawer .mx-color').length;
    report('⭐ 颜色区完全展开、没有滚动条（8 色时内容高度 == 可见高度，overflow-y 不是 auto）',
      !!colorsEl && colorCount >= 5 &&
        colorsEl.scrollHeight <= colorsEl.clientHeight + 1 &&
        colorsCs.overflowY !== 'auto' && colorsCs.overflowY !== 'scroll',
      'colors=' + colorCount + ' h=' + (colorsEl ? colorsEl.scrollHeight + '/' + colorsEl.clientHeight : 'missing') +
        ' overflowY=' + (colorsCs && colorsCs.overflowY));
    // 常用色里要有"这个款已经设置过的颜色"（藏青不在 10 个字典色里）
    var zqPc = document.querySelector('.wb-drawer [data-act="ed-common"][data-color="藏青"]');
    var dictPc = document.querySelector('.wb-drawer [data-act="ed-common"][data-color="黑"]');
    report('⭐ 常用色里加上了已设置的颜色（藏青在列，且是"已在矩阵里"的打勾态）',
      !!zqPc && zqPc.classList.contains('is-in') && !!dictPc,
      'zq=' + !!zqPc + ' isIn=' + (zqPc ? zqPc.classList.contains('is-in') : 'n/a') + ' dict=' + !!dictPc);
    // 收尾：不保存
    document.querySelector('.wb-drawer .ed-x').click();
    await settle(function () { return !!document.querySelector('[data-act="confirm-dialog"]'); }, 4000);
    await clickText('[data-act="confirm-ok"]', '放弃改动并关闭');
    await settle(function () { return !document.querySelector('.wb-drawer'); }, 4000);
    report('版式步不落库（收尾放弃后没有一次 SKU 写入）',
      !document.querySelector('.wb-drawer') && calls('productVariantUpsert').length === upsertBefore,
      'upsert +' + (calls('productVariantUpsert').length - upsertBefore));

    // ── 常用色 + 拖色合并（2026-10-24 用户口径「把常用颜色放在上面，通过拖动颜色方式来合并」）──
    // 为什么这两件事在同一个循环里：采集来的色名常常是同一个色的两种说法（藏青 / 藏蓝），
    // 而产品侧一个色只能有一行。在那之前用户只能"把一行改名成另一行的名字"，保存校验会拦下
    // （"出现了两行"）⇒ 用户读到的是"改了名 SKU 就没了"。合并是那条缺失的路。
    step('sku-color-merge');
    var mergeUpsertBefore = calls('productVariantUpsert').length;
    openEditorOf(0);
    await waitFor(function () { return all('.wb-drawer [data-act="ed-color"]').length >= 1; }, 6000);
    // ① 常用色一排在最上面，已经在矩阵里的打勾变灰；每项自带色块
    var pcs = all('.wb-drawer [data-act="ed-common"]');
    var pcIn = pcs.filter(function (b) { return b.classList.contains('is-in'); });
    var navyPc = document.querySelector('.wb-drawer [data-act="ed-common"][data-color="藏青"]');
    var navyDot = navyPc ? getComputedStyle(navyPc.querySelector('.mx-pc__dot')).backgroundColor : '';
    report('⭐ 常用色排在「颜色」上面，已经在矩阵里的打勾（「黑」）',
      pcs.length >= 8 && pcIn.length === 1 && flat(pcIn[0]).indexOf('黑') >= 0,
      'n=' + pcs.length + ' in=[' + pcIn.map(function (b) { return flat(b); }).join(',') + ']');
    report('常用色自带色块（藏青 → rgb(47, 59, 94)）—— 不是又一排汉字',
      navyDot === 'rgb(47, 59, 94)', 'dot=' + navyDot);
    // ② 点一下加一色；已经在矩阵里的**不再加第二行**（两行同名色保存时必被拦）
    var rowsBefore = all('.wb-drawer [data-act="ed-row"]').length;
    navyPc.click();
    await settle(function () { return all('.wb-drawer [data-act="ed-row"]').length === rowsBefore + 1; }, 3000);
    var rowsAfterPick = all('.wb-drawer [data-act="ed-row"]').length;
    navyPc.click();
    await settle(function () { return false; }, 200);
    report('点常用色加一行；已经在矩阵里的再点**不加第二行**（只把焦点递过去）',
      rowsAfterPick === rowsBefore + 1 &&
        all('.wb-drawer [data-act="ed-row"]').length === rowsAfterPick &&
        (document.activeElement || {}).getAttribute &&
        document.activeElement.getAttribute('data-act') === 'ed-color',
      'rows=' + rowsBefore + '→' + rowsAfterPick + '→' + all('.wb-drawer [data-act="ed-row"]').length +
        ' focus=' + ((document.activeElement || {}).getAttribute ? document.activeElement.getAttribute('data-act') : '?'));
    // ③ 造一个"有得搬"的合并：黑 只留 L，藏青 只留 M（克重 250）
    // ⚠️ 取消一个组合现在是**两段式**（2026-10-25 一格只剩一个输入框）：
    //    先清值（组合还在，只是"待填"），再按 Delete 才真移除。
    //    （本段是模板串：注释里不许出现反引号，否则整段注入脚本会被截断）
    function weightAt(rowIdx, size) {
      return document.querySelector(
        '.wb-drawer .mx-weight[data-cell-row="' + rowIdx + '"][data-cell-size="' + size + '"]'
      );
    }
    function killCell(rowIdx, size) {
      var el = weightAt(rowIdx, size);
      if (!el) return;
      setVal(el, '');
      el.dispatchEvent(new KeyboardEvent('keydown', { key: 'Delete', bubbles: true }));
    }
    killCell(0, 'M');   // 黑 M 取消
    await settle(function () { return false; }, 120);
    killCell(1, 'L');   // 藏青 L 取消
    await settle(function () { return false; }, 120);
    var navyWeight = weightAt(1, 'M');
    setVal(navyWeight, '250');
    await settle(function () { return false; }, 150);
    function cellOn(rowIdx, size) {
      var el = weightAt(rowIdx, size);
      return !!el && el.getAttribute('data-cell-on') === '1';
    }
    report('（造数）黑只剩 L、藏青只剩 M 且克重 250 —— 合并后必须"搬 1 格"',
      cellOn(0, 'L') && !cellOn(0, 'M') && !!navyWeight && !cellOn(1, 'L'),
      'blackL=' + cellOn(0, 'L') + ' navyM=' + (navyWeight ? navyWeight.value : 'missing'));
    // ④ 拖「藏青」到「黑」上（down → 越过 6px → 移到目标 → up）
    var chips = all('.wb-drawer .mx-color');
    var srcRect = chips[1].getBoundingClientRect();
    var dstRect = chips[0].getBoundingClientRect();
    var colorsBox = document.querySelector('.wb-drawer .mx-colors');
    function pev(type, x, y) {
      return new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        pointerId: 1, isPrimary: true, pointerType: 'mouse',
      });
    }
    chips[1].dispatchEvent(pev('pointerdown', srcRect.left + 3, srcRect.top + 3));
    colorsBox.dispatchEvent(pev('pointermove', srcRect.left + 12, srcRect.top + 3));
    await settle(function () { return false; }, 60);
    var srcMarked = chips[1].classList.contains('is-src');
    colorsBox.dispatchEvent(pev('pointermove', dstRect.left + dstRect.width / 2, dstRect.top + dstRect.height / 2));
    await settle(function () { return false; }, 60);
    var dropMarked = chips[0].classList.contains('is-drop');
    report('拖动中：源 chip 变虚、目标 chip 高亮（两种状态形态不同，浅色主题下也看得出来）',
      srcMarked && dropMarked, 'src=' + srcMarked + ' drop=' + dropMarked);
    colorsBox.dispatchEvent(pev('pointerup', dstRect.left + dstRect.width / 2, dstRect.top + dstRect.height / 2));
    await settle(function () { return all('.wb-drawer [data-act="ed-row"]').length === rowsBefore; }, 3000);
    var mergedRows = all('.wb-drawer [data-act="ed-row"]');
    var mergedWeights = mergedRows.length
      ? Array.prototype.map.call(mergedRows[0].querySelectorAll('.mx-weight'), function (i) { return i.value; })
      : [];
    var mergeHintEl = document.querySelector('.wb-drawer [data-act="ed-merge-hint"]');
    report('⭐ 拖到另一色上 = 合并成一行（藏青搬进黑），回执说清搬了几格',
      mergedRows.length === rowsBefore && !!mergeHintEl &&
        flat(mergeHintEl).indexOf('搬 1 格') >= 0 &&
        flat(mergeHintEl).indexOf('藏青') >= 0 && flat(mergeHintEl).indexOf('黑') >= 0,
      'rows=' + mergedRows.length + ' hint=' + (mergeHintEl ? flat(mergeHintEl) : 'missing'));
    // 合并**保留格里的值**：黑 L 还是 320（目标行原有），黑 M 变成 250（源行搬过来的）
    report('⭐ 合并保留克重（黑 L = 320 不动；黑 M = 250 从藏青搬来）—— 不是把行删了重建',
      mergedWeights.join(',') === '320,250', 'weights=' + mergedWeights.join(','));
    // 合并要进"待保存"：不写这一笔等于让人白拖一次
    var mergeSaveBtn = document.querySelector('.wb-drawer [data-act="ed-sku-save"]');
    report('合并进了待保存（状态徽标的脏计数 ≥ 1）',
      !!mergeSaveBtn && flat(mergeSaveBtn).indexOf('有 1 处待保存') >= 0,
      'btn=' + (mergeSaveBtn ? flat(mergeSaveBtn) : 'missing'));
    // ⑤ 纯点击不许合并：down + up 不移动 = 一次点击
    document.querySelector('.wb-drawer [data-act="ed-common"][data-color="白"]').click();
    await settle(function () { return all('.wb-drawer [data-act="ed-row"]').length === rowsBefore + 1; }, 3000);
    var clickChips = all('.wb-drawer .mx-color');
    var cr = clickChips[1].getBoundingClientRect();
    clickChips[1].dispatchEvent(pev('pointerdown', cr.left + 3, cr.top + 3));
    colorsBox.dispatchEvent(pev('pointerup', cr.left + 3, cr.top + 3));
    await settle(function () { return false; }, 200);
    report('没拖动就不合并（阈值 6px：一次点击不能被算成一次合并）',
      all('.wb-drawer [data-act="ed-row"]').length === rowsBefore + 1,
      'rows=' + all('.wb-drawer [data-act="ed-row"]').length);
    // 收尾：不保存
    document.querySelector('.wb-drawer .ed-x').click();
    await settle(function () { return !!document.querySelector('[data-act="confirm-dialog"]'); }, 4000);
    await clickText('[data-act="confirm-ok"]', '放弃改动并关闭');
    await settle(function () { return !document.querySelector('.wb-drawer'); }, 4000);
    report('常用色 / 合并步不落库（收尾放弃后没有一次 SKU 写入）',
      !document.querySelector('.wb-drawer') && calls('productVariantUpsert').length === mergeUpsertBefore,
      'upsert +' + (calls('productVariantUpsert').length - mergeUpsertBefore));

    // ── 拖到「常用色」上归类（2026-10-24 用户口径「拖动颜色里的项，拖动到常用色中进行归类，
    //    最终存储的以常用色为主，最终存储颜色的图片保留一张」）──
    // 这一步守的四件事：
    //   ① 常用色的勾 = 矩阵里**真有这个色名**（没有就保持原始状态，不许拿近似色冒充打勾）；
    //   ② 拖到没打勾的常用色上 = **原地改名**（行数不变、克重不动、色图仍在）；
    //   ③ 拖到已打勾的常用色上 = **并进那一行**（行数 -1，落库色名 = 常用色的写法）；
    //   ④ 归类后一个色只有**一张**色图（mx-color__img 每行恰 1 个，不是每格一张）。
    step('sku-palette-classify');
    var pcUpsertBefore = calls('productVariantUpsert').length;
    openEditorOf(0);
    await waitFor(function () {
      return !!document.querySelector('.wb-drawer [data-act="ed-color"]');
    }, 6000);
    function pcOf(color) {
      return document.querySelector('.wb-drawer [data-act="ed-common"][data-color="' + color + '"]');
    }
    function pevP(type, x, y) {
      return new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        pointerId: 1, isPrimary: true, pointerType: 'mouse',
      });
    }
    // 色图挂在**颜色 chip** 上（不是矩阵行：矩阵里只有开关与克重）。
    // 一个色只能有一张代表图 ⇒ 每个 chip 恰 1 个 mx-color__img；同一色下多张图是数据事故
    // （详情页十条 SKU 挂三张互相矛盾的图）。
    function imgsPerChip() {
      return all('.wb-drawer .mx-color').map(function (c) {
        return c.querySelectorAll('.mx-color__img').length;
      }).join(',');
    }
    // ① 把这一行的色名改成「藏蓝」（订单/平台常见写法，**不在**常用色表里，但表里有「藏青」）
    var cIn0 = document.querySelector('.wb-drawer [data-act="ed-color"]');
    var rowsStart = all('.wb-drawer [data-act="ed-row"]').length;
    var weightsStart = all('.wb-drawer .mx-weight').map(function (i) { return i.value; }).join(',');
    setVal(cIn0, '藏蓝');
    await settle(function () { return false; }, 250);
    var navyPc = pcOf('藏青');
    // 2026-10-25 起"已设置的色"也会出现在这一排（用户口径「常用色需要增加已设置的颜色」），
    // 所以"打勾的数量"不再是 0：藏蓝 在矩阵里 ⇒ 只有它自己打勾，字典色「藏青」不许冒充。
    var pcIn = all('.wb-drawer [data-act="ed-common"].is-in').map(flat);
    report('常用色按「矩阵里真有这个色名」打勾：藏蓝 在矩阵里 ⇒ 只有它打勾，藏青 不打勾',
      !!navyPc && !navyPc.classList.contains('is-in') &&
        pcIn.length === 1 && pcIn[0].indexOf('藏蓝') >= 0,
      'navy=' + (navyPc ? navyPc.className : 'missing') + ' in=' + pcIn.join('|'));
    // ② 拖到没打勾的常用色「藏青」上 —— 归类（原地改名）
    var rootEl2 = document.querySelector('.wb-drawer .mx');
    var chip0 = all('.wb-drawer .mx-color')[0];
    var cr0 = chip0.getBoundingClientRect();
    var nr = navyPc.getBoundingClientRect();
    chip0.dispatchEvent(pevP('pointerdown', cr0.left + 3, cr0.top + 3));
    rootEl2.dispatchEvent(pevP('pointermove', cr0.left + 14, cr0.top + 3));
    await settle(function () { return false; }, 60);
    var srcDashed = chip0.classList.contains('is-src');
    rootEl2.dispatchEvent(pevP('pointermove', nr.left + nr.width / 2, nr.top + nr.height / 2));
    await settle(function () { return false; }, 60);
    report('⭐ 拖动中：常用色整排变成落点，悬停的那一个实心高亮（原来只能瞄下面的小 chip）',
      !!document.querySelector('.wb-drawer .mx-palette--dragging') && srcDashed &&
        navyPc.classList.contains('is-drop'),
      'palette=' + !!document.querySelector('.wb-drawer .mx-palette--dragging') +
        ' src=' + srcDashed + ' drop=' + navyPc.classList.contains('is-drop'));
    rootEl2.dispatchEvent(pevP('pointerup', nr.left + nr.width / 2, nr.top + nr.height / 2));
    await settle(function () { return false; }, 250);
    var hint1 = document.querySelector('.wb-drawer [data-act="ed-merge-hint"]');
    report('⭐ 拖到没打勾的常用色 = 原地改名（落库色名取常用色的写法「藏青」）',
      !!hint1 && flat(hint1).indexOf('藏蓝') >= 0 && flat(hint1).indexOf('藏青') >= 0 &&
        flat(hint1).indexOf('落库色名') >= 0 &&
        document.querySelector('.wb-drawer [data-act="ed-color"]').value === '藏青',
      'hint=' + (hint1 ? flat(hint1) : 'missing') +
        ' color=' + document.querySelector('.wb-drawer [data-act="ed-color"]').value);
    report('改名不是删了重建：行数不变、克重一格都没动（SKU 与编码跟着走）',
      all('.wb-drawer [data-act="ed-row"]').length === rowsStart &&
        all('.wb-drawer .mx-weight').map(function (i) { return i.value; }).join(',') === weightsStart &&
        document.querySelector('.wb-drawer [data-act="ed-color"]').value === '藏青',
      'rows=' + all('.wb-drawer [data-act="ed-row"]').length + '/' + rowsStart +
        ' weights=' + all('.wb-drawer .mx-weight').map(function (i) { return i.value; }).join(','));
    report('归类后常用色立刻打勾（同一份判据：打勾 = 拖上去会并进已有行）',
      navyPc.classList.contains('is-in') && !pcOf('黑').classList.contains('is-in'),
      'navy=' + navyPc.className + ' black=' + pcOf('黑').className);
    // ③ 拖到已打勾的常用色上 —— 并进那一行（先把「黑」加回来造出目标行）
    pcOf('黑').click();
    await settle(function () { return all('.wb-drawer [data-act="ed-row"]').length === rowsStart + 1; }, 3000);
    var chipNavy = all('.wb-drawer .mx-color')[0];
    var cn = chipNavy.getBoundingClientRect();
    var blackPc = pcOf('黑');
    var br = blackPc.getBoundingClientRect();
    chipNavy.dispatchEvent(pevP('pointerdown', cn.left + 3, cn.top + 3));
    rootEl2.dispatchEvent(pevP('pointermove', cn.left + 14, cn.top + 3));
    await settle(function () { return false; }, 60);
    rootEl2.dispatchEvent(pevP('pointermove', br.left + br.width / 2, br.top + br.height / 2));
    await settle(function () { return false; }, 60);
    rootEl2.dispatchEvent(pevP('pointerup', br.left + br.width / 2, br.top + br.height / 2));
    await settle(function () { return all('.wb-drawer [data-act="ed-row"]').length === rowsStart; }, 3000);
    var hint2 = document.querySelector('.wb-drawer [data-act="ed-merge-hint"]');
    var mergedNames = all('.wb-drawer [data-act="ed-color"]').map(function (i) { return i.value; }).join('/');
    report('⭐ 拖到已打勾的常用色 = 并进那一行（两行变一行，落库色名仍是常用色「黑」）',
      all('.wb-drawer [data-act="ed-row"]').length === rowsStart && mergedNames === '黑' &&
        !!hint2 && flat(hint2).indexOf('归到') >= 0 && flat(hint2).indexOf('只留一张色图') >= 0,
      'rows=' + all('.wb-drawer [data-act="ed-row"]').length + ' names=' + mergedNames +
        ' hint=' + (hint2 ? flat(hint2) : 'missing'));
    // 合并后克重取有值的一方（目标行是新建的空白行，不许把量好的 320 清零）
    report('合并保留已量的克重（新建的空目标行不覆盖 320）',
      all('.wb-drawer .mx-weight').map(function (i) { return i.value; }).indexOf('320') >= 0,
      'weights=' + all('.wb-drawer .mx-weight').map(function (i) { return i.value; }).join(','));
    // ④ 一个色只留一张图
    report('⭐ 归类后一个色只有一张色图（每个色 chip 恰 1 个 mx-color__img，不是每格一张）',
      imgsPerChip().split(',').length >= 1 &&
        imgsPerChip().split(',').every(function (n) { return n === '1'; }),
      'imgs/chip=' + imgsPerChip());
    // ⑤ 拖到"本来就是这个色名"的常用色上 ⇒ 什么都不改（不打勾时点它=加一行，打勾时拖它=无变化）
    var chipBlack = all('.wb-drawer .mx-color')[0];
    var cb = chipBlack.getBoundingClientRect();
    var blackPc2 = pcOf('黑');
    var br2 = blackPc2.getBoundingClientRect();
    chipBlack.dispatchEvent(pevP('pointerdown', cb.left + 3, cb.top + 3));
    rootEl2.dispatchEvent(pevP('pointermove', cb.left + 14, cb.top + 3));
    await settle(function () { return false; }, 60);
    rootEl2.dispatchEvent(pevP('pointermove', br2.left + br2.width / 2, br2.top + br2.height / 2));
    await settle(function () { return false; }, 60);
    rootEl2.dispatchEvent(pevP('pointerup', br2.left + br2.width / 2, br2.top + br2.height / 2));
    await settle(function () { return false; }, 250);
    var hint3 = document.querySelector('.wb-drawer [data-act="ed-merge-hint"]');
    report('拖到自己这个色名上 = 什么都不改（只回一句"本来就是常用色"）',
      all('.wb-drawer [data-act="ed-row"]').length === rowsStart &&
        !!hint3 && flat(hint3).indexOf('本来就是常用色') >= 0,
      'rows=' + all('.wb-drawer [data-act="ed-row"]').length + ' hint=' + (hint3 ? flat(hint3) : 'missing'));
    // 收尾：不保存（归类步同样不许落库 —— 它只是把待保存的改动攒起来）。
    // ⚠️ 这里**不假设**一定弹「放弃改动」：本步最后把 黑 改名成 藏青 又并回 黑，
    //    净结果与库里一致 ⇒ 保存计划是空的，抽屉直接关掉。把那个"没有幽灵待保存"也断言掉：
    //    一次改名 + 一次合并回原位，不该留下"还有 1 处改动"的假提示。
    document.querySelector('.wb-drawer .ed-x').click();
    await settle(function () {
      return !document.querySelector('.wb-drawer') || !!document.querySelector('[data-act="confirm-dialog"]');
    }, 4000);
    var closeDialog = document.querySelector('[data-act="confirm-dialog"]');
    report('归类回环后净变化为零 ⇒ 不产生幽灵待保存（抽屉直接关，不问"放弃改动"）',
      !closeDialog, 'dialog=' + !!closeDialog);
    if (closeDialog) await clickText('[data-act="confirm-ok"]', '放弃');
    await settle(function () { return !document.querySelector('.wb-drawer'); }, 4000);
    report('归类步不落库（收尾放弃后没有一次 SKU 写入）',
      !document.querySelector('.wb-drawer') && calls('productVariantUpsert').length === pcUpsertBefore,
      'upsert +' + (calls('productVariantUpsert').length - pcUpsertBefore));

    // ── 色名的抓手与落点（2026-10-25 用户口径「拖动区域太小，操作太不方便」）──
    // 实测取证：整条 chip 125px 里**只有 26px 的色图能按**（色名是 input，被 onChipDown 主动排除），
    // 而落点胶囊 42x22、与颜色行只隔 6px —— 人手一次 20px 的偏差就拖空，表现就是"拖不动"。
    // 这一步守四件事：
    //   ① 抓手扩到整条 chip（按住色名**竖向**拖也算），横向拖仍是选文字；
    //   ② 落点从"点中矩形"改成"离谁最近"（放宽 16/12px）：落在胶囊上方 10px 的空白里也算；
    //   ③ 不想拖的人有候选列表：点进色名挑一个词即归类/合并（零手势）；
    //   ④ 两条路走的是同一个 classifyInto / mergeColorInto，不许各写一套落库语义。
    step('sku-drag-grab');
    var grabUpsertBefore = calls('productVariantUpsert').length;
    openEditorOf(0);
    await waitFor(function () { return !!document.querySelector('.wb-drawer [data-act="ed-color"]'); }, 6000);
    function gPc(color) {
      return document.querySelector('.wb-drawer [data-act="ed-common"][data-color="' + color + '"]');
    }
    function gPe(type, x, y) {
      return new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: x, clientY: y,
        pointerId: 1, isPrimary: true, pointerType: 'mouse',
      });
    }
    var gRoot = document.querySelector('.wb-drawer .mx');
    var gChip = all('.wb-drawer .mx-color')[0];
    var gImgBox = gChip.querySelector('.mx-color__img').getBoundingClientRect();
    var gPcNavy = gPc('藏青');
    var gNavyBox = gPcNavy.getBoundingClientRect();
    report('拖动手柄的色图放大到 28px（26px 的小方块曾经是整条 chip 唯一能按的地方）',
      Math.round(gImgBox.width) >= 28 && Math.round(gImgBox.height) >= 28,
      'img=' + Math.round(gImgBox.width) + 'x' + Math.round(gImgBox.height));
    report('落点胶囊加高到 24px（原来 22：点在上下边缘就脱靶）',
      Math.round(gNavyBox.height) >= 24, 'h=' + Math.round(gNavyBox.height));
    // ① 色名框里**横向**拖 = 拖选文字，绝不能被当成"拖这一行"
    var gName = gChip.querySelector('[data-act="ed-color"]');
    var gn = gName.getBoundingClientRect();
    gName.dispatchEvent(gPe('pointerdown', gn.left + 10, gn.top + gn.height / 2));
    gRoot.dispatchEvent(gPe('pointermove', gn.left + 34, gn.top + gn.height / 2 + 2));
    await settle(function () { return false; }, 80);
    var hDragStarted = !!document.querySelector('.wb-drawer .mx-color.is-src');
    gRoot.dispatchEvent(gPe('pointerup', gn.left + 34, gn.top + gn.height / 2 + 2));
    await settle(function () { return false; }, 80);
    report('色名框里横向拖 ≠ 拖行（那是选文字：抓手变大不能以"选不了字"为代价）',
      !hDragStarted, 'is-src=' + hDragStarted);
    // ② 同一处**竖向**拖 = 拖这一行
    gName.dispatchEvent(gPe('pointerdown', gn.left + 10, gn.top + gn.height / 2));
    gRoot.dispatchEvent(gPe('pointermove', gn.left + 11, gn.top + gn.height / 2 - 18));
    await settle(function () { return false; }, 80);
    var vDragStarted = !!document.querySelector('.wb-drawer .mx-color.is-src');
    report('⭐ 在色名上竖着拖 = 拖这一行（整条 chip 都是抓手，不必先瞄准左边那张小色图）',
      vDragStarted, 'is-src=' + vDragStarted);
    // ③ 落点容错：松手在胶囊**上方 10px 的空白** —— 旧实现用 elementFromPoint，那里什么都没有
    gRoot.dispatchEvent(gPe('pointermove', gNavyBox.left + gNavyBox.width / 2, gNavyBox.top - 10));
    await settle(function () { return false; }, 80);
    var farMarked = gPcNavy.classList.contains('is-drop');
    report('⭐ 指针在胶囊外 10px 也算悬停到它（落点有效面积 42x24 → 74x48）',
      farMarked, 'is-drop=' + farMarked);
    gRoot.dispatchEvent(gPe('pointerup', gNavyBox.left + gNavyBox.width / 2, gNavyBox.top - 10));
    await settle(function () { return false; }, 300);
    report('松手在那一圈空白里照样归类（不是"拖到了但没反应"）',
      document.querySelector('.wb-drawer [data-act="ed-color"]').value === '藏青',
      'color=' + document.querySelector('.wb-drawer [data-act="ed-color"]').value);
    // ④ 候选列表（不拖的那条路）：加一行、改成字典外的写法，再点进色名挑"合并两行"
    gPc('黑').click();
    await settle(function () { return all('.wb-drawer [data-act="ed-row"]').length === 2; }, 3000);
    var gName1 = all('.wb-drawer [data-act="ed-color"]')[1];
    if (gName1) setVal(gName1, '墨黑');
    await settle(function () { return false; }, 200);
    if (document.activeElement && document.activeElement.blur) document.activeElement.blur();
    await settle(function () { return false; }, 150);
    var gName0 = document.querySelector('.wb-drawer [data-act="ed-color"]');
    gName0.focus();
    await settle(function () { return !!document.querySelector('[data-act="ed-color-suggest"]'); }, 2000);
    var gSug = document.querySelector('[data-act="ed-color-suggest"]');
    var gItems = all('[data-act="ed-color-suggest-item"]');
    var gLabels = gItems.map(function (b) {
      var n = b.querySelector('.mx-suggest__name');
      return n ? flat(n) : '?';
    });
    var gNotes = gItems.map(function (b) {
      var n = b.querySelector('.mx-suggest__note');
      return n ? flat(n) : '?';
    });
    report('⭐ 点进色名就给出候选（不想拖的人有第二条路）：常用色 + 其它行，且不列自己',
      !!gSug && gItems.length >= 8 && gLabels.indexOf('墨黑') >= 0 && gLabels.indexOf('藏青') < 0,
      'n=' + gItems.length + ' labels=' + gLabels.join('/'));
    report('候选里写明"会发生什么"：分组（归到常用色 / 并入其它颜色）+ 归类 / 合并两行',
      gNotes.some(function (t) { return t.indexOf('归类') >= 0; }) &&
        gNotes.some(function (t) { return t.indexOf('合并两行') >= 0; }) &&
        document.querySelectorAll('.mx-suggest__group').length >= 2,
      'notes=' + gNotes.join('|') + ' groups=' + document.querySelectorAll('.mx-suggest__group').length);
    // ⑤ 点浮层外的空白 ⇒ 收起（那里不可聚焦、input 不会 blur —— 光靠 blur 会让菜单一直飘着）
    document.querySelector('.wb-drawer .ed-main__bar').dispatchEvent(new PointerEvent('pointerdown', {
      bubbles: true, cancelable: true, clientX: 6, clientY: 6, pointerId: 1, isPrimary: true, pointerType: 'mouse',
    }));
    await settle(function () { return !document.querySelector('[data-act="ed-color-suggest"]'); }, 1500);
    report('点浮层外的空白也收起（焦点没转移、input 没 blur 的情形也算"走了"）',
      !document.querySelector('[data-act="ed-color-suggest"]'),
      'suggest=' + !!document.querySelector('[data-act="ed-color-suggest"]'));
    // 重新打开：焦点还在这个框上（刚才只是关了浮层）⇒ 点一下也要能再弹出来
    gName0.click();
    await settle(function () { return !!document.querySelector('[data-act="ed-color-suggest"]'); }, 2000);
    report('关掉后再点同一个色名框 = 重新给出候选（焦点没变，不会再触发 focus，只能靠 click）',
      !!document.querySelector('[data-act="ed-color-suggest"]'),
      'suggest=' + !!document.querySelector('[data-act="ed-color-suggest"]'));
    var gRowItem = all('[data-act="ed-color-suggest-item"]')
      .filter(function (b) { return b.getAttribute('data-suggest-kind') === 'row'; })[0];
    if (gRowItem) gRowItem.click();
    await settle(function () { return all('.wb-drawer [data-act="ed-row"]').length === 1; }, 3000);
    var gAfterRows = all('.wb-drawer [data-act="ed-row"]').length;
    var gHint = document.querySelector('.wb-drawer [data-act="ed-merge-hint"]');
    report('⭐ 点候选"合并两行" = 真的合并（与拖动走同一个 mergeColorInto，不是两套逻辑）',
      gAfterRows === 1 && !!gHint && flat(gHint).indexOf('并入') >= 0,
      'rows=' + gAfterRows + ' hint=' + (gHint ? flat(gHint) : 'missing'));
    report('选完候选即收起（浮层不留在矩阵上挡视线）',
      !document.querySelector('[data-act="ed-color-suggest"]'),
      'suggest=' + !!document.querySelector('[data-act="ed-color-suggest"]'));
    // 收尾：不保存
    document.querySelector('.wb-drawer .ed-x').click();
    await settle(function () {
      return !document.querySelector('.wb-drawer') || !!document.querySelector('[data-act="confirm-dialog"]');
    }, 4000);
    if (document.querySelector('[data-act="confirm-dialog"]')) await clickText('[data-act="confirm-ok"]', '放弃');
    await settle(function () { return !document.querySelector('.wb-drawer'); }, 4000);
    report('抓手 / 落点 / 候选步不落库（收尾放弃后没有一次 SKU 写入）',
      !document.querySelector('.wb-drawer') && calls('productVariantUpsert').length === grabUpsertBefore,
      'upsert +' + (calls('productVariantUpsert').length - grabUpsertBefore));

    // ── 改色名要同步到订单域的款色（2026-10-23 用户实报「改颜色，图片就没了」）──
    // 色图按「款编码 + 色名」查，只改产品侧名字 ⇒ 图查不到（重开抽屉空）。三条判据：
    //   ① 只是改了名字（还没保存）→ 一次 styleColorRename 都不能有（不保存不动订单域）；
    //   ② 保存时按「改名前 → 改名后」发一次（from 取自 variantId 那行，不是写死的）；
    //   ③ 保存后重拉矩阵（库里已是新名）行头图仍在 —— 那是按 SKU id 续的，不是按色名重查。
    step('color-rename-sync');
    openEditorOf(0);
    await waitFor(function () {
      return !!document.querySelector('.wb-drawer [data-act="ed-color"]');
    }, 6000);
    var renInput = document.querySelector('.wb-drawer [data-act="ed-color"]');
    renInput.value = '深蓝';
    renInput.dispatchEvent(new Event('input'));
    await settle(function () { return false; }, 500);
    report('只改名字（没点保存）→ 不动订单域的色行（款色改名必须是保存那一刻的动作）',
      calls('styleColorRename').length === 0, 'calls=' + calls('styleColorRename').length);
    var renBtn = document.querySelector('.wb-drawer [data-act="ed-sku-save"]');
    report('改名本身算一处未保存改动（保存按钮变可点）',
      !!renBtn && !renBtn.disabled,
      'btn=' + (renBtn ? flat(renBtn) + ' disabled=' + !!renBtn.disabled : 'missing'));
    document.querySelector('.wb-drawer [data-act="ed-sku-save"]').click();
    await settle(function () { return calls('productVariantUpsert').length >= 1; }, 4000);
    var renSent = calls('productVariantUpsert').slice(-1)[0] || {};
    report('改名后保存：SKU 这边写的是新色名（全量提交，颜色跟着行改）',
      calls('productVariantUpsert').length >= 1 && renSent.color === '深蓝',
      'n=' + calls('productVariantUpsert').length + ' color=' + renSent.color);
    await waitFor(function () { return calls('styleColorRename').length >= 1; }, 6000);
    var renCall = calls('styleColorRename')[0];
    report('保存时把订单域色行一起改名：款 + 改名前（黑）→ 改名后（深蓝）',
      !!renCall && Number(renCall.productId) === 1 && renCall.styleCode === 'S1' &&
        renCall.from === '黑' && renCall.to === '深蓝',
      JSON.stringify(renCall));
    await settle(function () {
      var b = document.querySelector('.wb-drawer [data-act="ed-sku-save"]');
      return !!b && b.disabled === true;
    }, 6000);
    var thumbAfterSave = document.querySelector('.wb-drawer [data-act="ed-row-thumb"] img');
    report('保存后（库里已是新色名）行头色图仍在 —— 图按 SKU id 续，不是按色名重查',
      !!thumbAfterSave && thumbAfterSave.getAttribute('src') === window.__smokeImg.thumb,
      'src=' + (thumbAfterSave ? String(thumbAfterSave.getAttribute('src')).slice(0, 24) : 'missing'));
    // 改回去：夹具要回到'黑'（后面 export 步等的是这个过程的数据），顺带钉住 from 是"当下的真实值"
    var renBack = document.querySelector('.wb-drawer [data-act="ed-color"]');
    renBack.value = '黑';
    renBack.dispatchEvent(new Event('input'));
    await settle(function () { return false; }, 500);
    document.querySelector('.wb-drawer [data-act="ed-sku-save"]').click();
    await waitFor(function () { return calls('styleColorRename').length >= 2; }, 6000);
    var renBackCall = calls('styleColorRename')[1];
    report('再改回去也照样同步（from 是改名前那一刻的值：深蓝 → 黑）',
      !!renBackCall && renBackCall.from === '深蓝' && renBackCall.to === '黑',
      JSON.stringify(renBackCall));
    await settle(function () {
      var b = document.querySelector('.wb-drawer [data-act="ed-sku-save"]');
      return !!b && b.disabled === true;
    }, 6000);
    document.querySelector('.wb-drawer .ed-x').click();
    await settle(function () { return !document.querySelector('.wb-drawer'); }, 4000);

    // ── 并入 → 改色名 → 保存：**新增行**也必须把订单域色行一起改名 ────────
    // 真库实证（2026-10-23 用户二次实报「保存以后图片还是丢失了」）：SUST-004 从采集商品并入
    // 5 个色（订单域色名是平台色号 1..5，图挂在那些色行上），用户删到只剩一色改名「深蓝」后
    // 保存 —— 该行在 pl_variants 里是**新建**（id 404-411 全是新行），而色名同步只遍历 updates，
    // 于是订单域还叫 5、产品叫深蓝 ⇒ 按新名查图落空；oi_color_aliases 也是空的
    // （= 改名请求一次都没发出去，失败也没有任何提示）。
    // 上一步钉"已有行改名"，这一步专钉"新增行改名"：原色名只能来自并入那一刻的快照。
    step('import-rename-sync');
    openEditorOf(0);
    await waitFor(function () {
      var b = document.querySelector('.wb-drawer [data-act="ed-import-open"]');
      return !!b && !b.disabled && !!document.querySelector('.wb-drawer [data-act="ed-color"]');
    }, 6000);
    document.querySelector('.wb-drawer [data-act="ed-import-open"]').click();
    await waitFor(function () {
      return !!document.querySelector('.wb-drawer [data-act="ed-import-item"][data-item-id="1005007777777777"]');
    }, 6000);
    document.querySelector('.wb-drawer [data-act="ed-import-item"][data-item-id="1005007777777777"]').click();
    await settle(function () { return !!document.querySelector('.wb-drawer [data-act="ed-import-apply"]'); }, 3000);
    document.querySelector('.wb-drawer [data-act="ed-import-apply"]').click();
    await waitFor(function () {
      return all('.wb-drawer [data-act="ed-color"]').some(function (i) { return i.value === '红'; });
    }, 8000);
    report('并入带来的颜色是**新行**（没有 pl_variants.id，保存时只会走"新增"）',
      all('.wb-drawer [data-act="ed-color"]').map(function (i) { return i.value; }).indexOf('红') >= 0,
      JSON.stringify(all('.wb-drawer [data-act="ed-color"]').map(function (i) { return i.value; })));
    var redInput = all('.wb-drawer [data-act="ed-color"]').filter(function (i) { return i.value === '红'; })[0];
    redInput.value = '深红';
    redInput.dispatchEvent(new Event('input'));
    await settle(function () { return false; }, 700);
    var renBefore = calls('styleColorRename').length;
    document.querySelector('.wb-drawer [data-act="ed-sku-save"]').click();
    // 用 settle 不用 waitFor：没有改名请求时**不该**把整步炸成超时（那样只看到 "timeout"，
    // 看不出是哪条判据塌了）；等到位与否都往下走，由断言把话说清楚。
    await settle(function () {
      return calls('styleColorRename').some(function (c) { return c && c.to === '深红'; });
    }, 8000);
    var newRowRename = calls('styleColorRename').filter(function (c) { return c && c.to === '深红'; })[0];
    report('新增行改名也同步订单域：from 是并入时的原色名（红 → 深红），不是空值也不是新名',
      !!newRowRename && newRowRename.from === '红' && newRowRename.to === '深红' &&
        newRowRename.styleCode === 'S1' && Number(newRowRename.productId) === 1,
      JSON.stringify(calls('styleColorRename').slice(renBefore)));
    await settle(function () {
      var b = document.querySelector('.wb-drawer [data-act="ed-sku-save"]');
      return !!b && b.disabled === true;
    }, 8000);
    function deepRowThumb() {
      var tr = all('.wb-drawer [data-act="ed-row"]').filter(function (r) {
        return flat(r.querySelector('.mx-rowhead__name')) === '深红';
      })[0];
      return tr ? tr.querySelector('[data-act="ed-row-thumb"] img') : null;
    }
    var deepThumb = deepRowThumb();
    report('保存后这一行的色图还在（旧实现：新建行没有 id ⇒ 续不上，且订单域还叫「红」查不到）',
      !!deepThumb && deepThumb.getAttribute('src') === window.__smokeImg.thumb,
      'src=' + (deepThumb ? String(deepThumb.getAttribute('src')).slice(0, 24) : 'missing'));
    // 用户报的就是"保存以后"（关掉重开 / 刷新列表之后）—— 必须重开再看一次：
    // 这一步只能靠库里按新色名查到图，内存里续图的那条路已经断了。
    document.querySelector('.wb-drawer .ed-x').click();
    await settle(function () { return !document.querySelector('.wb-drawer'); }, 4000);
    openEditorOf(0);
    await waitFor(function () { return !!document.querySelector('.wb-drawer [data-act="ed-color"]'); }, 6000);
    await settle(function () { return !!deepRowThumb(); }, 6000);
    var reopenThumb = deepRowThumb();
    report('关掉抽屉再打开，这一行色图仍在（靠库里按新色名查得到 —— 内存续图的路已断）',
      !!reopenThumb && reopenThumb.getAttribute('src') === window.__smokeImg.thumb,
      'src=' + (reopenThumb ? String(reopenThumb.getAttribute('src')).slice(0, 24) : 'missing'));
    document.querySelector('.wb-drawer .ed-x').click();
    await settle(function () { return !document.querySelector('.wb-drawer'); }, 4000);

    // ── 产品「当前进价」的维护入口（阶段 A1：产品编辑抽屉）──────────────────
    // 为什么在这一页守：进价从「成本表」搬到产品表后，**产品抽屉就是它唯一的人工维护入口**。
    // 这一栏没渲染、或渲染了却没进 upsert 载荷，新列就是死列 —— 而利润将来读它，
    // 读到的永远是 0（"有成本"和"零成本"在界面上长得一模一样，这是最贵的一类静默）。
    step('cost-save-in-drawer');
    openEditorOf(0);
    await waitFor(function () {
      return !!document.querySelector('.wb-drawer [data-act="ed-cost"]');
    }, 6000);
    var costInput = document.querySelector('.wb-drawer [data-act="ed-cost"]');
    report('抽屉里有「进价（元）」这一栏（新列的人工入口；没有它 = 只能靠导入或成本面板）',
      !!costInput, costInput ? 'placeholder=' + costInput.getAttribute('placeholder') : 'missing');
    costInput.value = '12.34';
    costInput.dispatchEvent(new Event('input'));
    var beforeUpserts = calls('productUpsert').length;
    costInput.dispatchEvent(new Event('blur'));
    await waitFor(function () { return calls('productUpsert').length > beforeUpserts; }, 6000);
    var upserts = calls('productUpsert');
    var cSent = upserts[upserts.length - 1];
    report('填 12.34 元 → 载荷是**分**（1234），不是原样字符串（元分混用会让价差 100 倍）',
      !!cSent && Number(cSent.costCents) === 1234, JSON.stringify(cSent && { id: cSent.id, costCents: cSent.costCents }));
    // 桩有没有真写夹具，由下面的"关掉再开仍显示 12.34"来判 —— 夹具数组在桩的闭包里，
    // 这里取不到（别为了断言把内部结构提升成全局）。
    // 关掉再开：抽屉读的是 props.product.costCents，能显示回 12.34 才说明**列表把新列带回来了**
    // （只写不读的列，用户下次打开看到空白，会以为自己没保存成功）。
    await settle(function () {
      var b = document.querySelector('.wb-drawer [data-act="ed-sku-save"]');
      return !b || (b.disabled === true && flat(b).indexOf('已保存') >= 0);
    }, 4000);
    document.querySelector('.wb-drawer .ed-x').click();
    await settle(function () { return !document.querySelector('.wb-drawer'); }, 4000);
    openEditorOf(0);
    await waitFor(function () {
      return !!document.querySelector('.wb-drawer [data-act="ed-cost"]');
    }, 6000);
    report('重开抽屉进价显示 12.34（写进去的值能被读回来）',
      document.querySelector('.wb-drawer [data-act="ed-cost"]').value === '12.34',
      'v=' + document.querySelector('.wb-drawer [data-act="ed-cost"]').value);
    document.querySelector('.wb-drawer .ed-x').click();
    await settle(function () { return !document.querySelector('.wb-drawer'); }, 4000);

    // ⚠️ 2026-10-25（P2 · S4）：行展开区整块撤掉后，detail-links / p-supplier 那套判据
    //    在页面上已经不存在（照旧写会得到「detailCell is not defined」这种"脚本比页面旧"的红）。
    //    **口径不变**：产品侧的读数必须属于刚点的这一款，不是"永远显示第一个款"。
    //    换了三处承载，一条契约都没放：
    //      · 「展开区跟着换」→ 选中态跟着换（本步）
    //      · 「未关联供应商显示 (未关联)」→ 抽屉里供应商下拉停在「未关联」（profile-in-drawer 步）
    //      · 「失效不混进已关联 + 失效单列说明」→ 右栏「已认」段的状态标 + 「有 N 条已失效」入口
    //        （detail-links / mapped-invalid-entry 两步）
    step('switch');
    var code0 = flat(productRows()[0].querySelector('[data-act="p-code"]'));
    var code1 = flat(productRows()[1].querySelector('[data-act="p-code"]'));
    productRows()[0].click();
    await settle(function () {
      return !!productRows()[0] && productRows()[0].classList.contains('is-on') &&
        !productRows()[1].classList.contains('is-on');
    }, 4000);
    report('点回第一行 → 选中态跟着换（不是"永远停在刚才那一款"，也不是点了没反应）',
      productRows()[0].classList.contains('is-on') && !productRows()[1].classList.contains('is-on'),
      'r0=' + productRows()[0].classList.contains('is-on') +
        ' r1=' + productRows()[1].classList.contains('is-on'));
    // ⭐ 跨栏只有一个落点：右栏「只看当前款」必须说的是**刚点的那一款**。
    //    两处读数不一致（左栏高亮 A、右栏按 B 反查）就是"认错对象"，而它不会报错。
    await clickText('[data-act="sub-mapped"]', '已认');
    await settle(function () {
      var b = document.querySelector('[data-act="mapped-by-product"]');
      return !!b && flat(b).indexOf(code0) >= 0;
    }, 6000);
    var swBtn = document.querySelector('[data-act="mapped-by-product"]');
    report('右栏「只看当前款」跟着换成刚点的那一款（跨栏读数必须一致，不是"记住上一次"）',
      !!swBtn && flat(swBtn).indexOf(code0) >= 0 && flat(swBtn).indexOf(code1) < 0,
      'cur=' + code0 + ' other=' + code1 + ' btn=' + (swBtn ? flat(swBtn) : 'missing'));
    if (swBtn) swBtn.click();
    await settle(function () {
      return all('[data-act="mapped-table"] tbody tr[data-item-id]').length === 2;
    }, 6000);
    var swIds = all('[data-act="mapped-table"] tbody tr[data-item-id]')
      .map(function (r) { return r.getAttribute('data-item-id'); }).sort().join(',');
    report('⭐ 按款反查不串款：只看 S1 → 是它自己那两条 SKU-OLD*，不是 S2 的 B0OLD*（失效那条也在 S2）',
      swIds === 'SKU-OLD,SKU-OLD2', 'ids=' + swIds);
    report('失效的映射**不混进**「已关联」：只看 S1 时没有一条带「已失效」标',
      all('[data-act="mapped-table"] tbody tr[data-item-id]').every(function (r) {
        return flat(r).indexOf('已失效') < 0 && flat(r).indexOf('已确认') >= 0;
      }), 'ids=' + swIds);
    if (swBtn) swBtn.click();
    await settle(function () {
      return all('[data-act="mapped-table"] tbody tr[data-item-id]').length === 4;
    }, 6000);
    // 出口：回到「待认」段，并把选中还原到第二款 —— 后面几十条断言长在它上面。
    await clickText('[data-act="sub-pending"]', '待认');
    await settle(function () { return !!document.querySelector('[data-act="pending-table"]'); }, 6000);
    productRows()[1].click();
    await settle(function () {
      return !!productRows()[1] && productRows()[1].classList.contains('is-on');
    }, 4000);

    /* ======================================================================
       产品库岛的功能已整体收回内建（2026-10-01，岛本身一并下架）。以下断言
       **逐条从该岛原先的 UI 冒烟搬过来**（那个脚本随岛一起下线了），口径一条都没放宽 ——
       岛下架后这批契约（批量关联一次提交 / 不串店 / 未归一不可点 / 失效按 id 定位 /
       部分 patch 不带空字段）必须继续有人守，否则"迁移"就变成"功能静默降级"。
       ====================================================================== */
    step('tabs');
    // ⚠️ mapFlat 返回的是 **join 过的字符串**（all().map(flat).join('/')），不是数组。
    // 按数组写（tabNames.length === 1 && tabNames[0] === …）会在字符串上**恒假** ——
    // 而 detail 打印出来正是那一个页签名，看着"数据没问题"，实际这条永远红（2026-10-15 实测）。
    //
    // ⚠️ 2026-10-17 收拢（用户口径「成本、供应商收拢到货品档案中」）：页签条不再由
    //    GoodsView 画，而是由「基础数据」把**货品档案这一组的资料**并成一条来画
    //    （.md-tabs .md-tab + data-act="kind-tab-*"）。本页自己的 .gd-tabs 在 embedded
    //    形态下不渲染（hideTabs，页签数 ≤ 1 才允许隐藏），否则屏幕上会出现两条并排的页签条。
    // ⚠️ 2026-10-22（B'）：进价整页退役，货品档案组只剩**两类**资料（款与商品 / 供应商），
    //    故页签数从 3 降到 2，且不再有 kind-tab-cost 锚点。
    var tabNames = mapFlat('.md-tabs .md-tab');
    // ⚠️ 不能用 tabNames 与 '款与商品/供应商' 做全等：组页签上带**徽标数字**
    //    （供应商后跟家数），拼出来的字符串会是 '供应商2' 这种。
    //    要判断签"是哪几条"，查 data-act 锚点（稳定）；要判高亮，查 is-active 那一格的**开头**。
    report('产品管理（原「货品档案」）这一组是两条页签：款与商品 / 供应商，默认停在「款与商品」上',
      all('.md-tabs .md-tab').length === 2 &&
        !!document.querySelector('[data-act="kind-tab-goods"]') &&
        !!document.querySelector('[data-act="kind-tab-suppliers"]') &&
        flat(document.querySelector('.md-tabs .md-tab.is-active')).indexOf('款与商品') === 0,
      tabNames);
    // 反向守卫：本页**不再自带**页签条。留一条 .gd-tabs 就等于两条并排的页签条
    // （一条属于"页"、一条属于"组"），用户分不清哪条是"我在哪一层"。
    report('「货品档案」不再自画页签条（页签由组统一画，屏幕上只有一条）',
      !document.querySelector('.gd-tabs'),
      'gd-tabs=' + !!document.querySelector('.gd-tabs'));
    // 反向守卫：三个维护页签**不许回到 GoodsView 自己名下**。它们现在在组页签里（同一份组件、
    // 同一个面板），但若 GoodsView 又 import 一遍，就是"同一能力两个实现"复辟。
    // data-act 也要一并消失：只删页签不删选择器的话，按旧名定位的东西会静默点空。
    report('维护类页签不在 GoodsView 自己名下（旧锚点 tab-registry / tab-suppliers / tab-cost 都不在）',
      !document.querySelector('[data-act="tab-registry"]') &&
        !document.querySelector('[data-act="tab-suppliers"]') &&
        !document.querySelector('[data-act="tab-cost"]'),
      tabNames);
    // 反向守卫：合并后**不许**再冒出「产品」/「映射与关联」两个旧页签 —— 它们一回来，用户又得
    // 在两个页签之间来回切、看不到同屏的两栏，正是这次重构要消掉的东西。
    // 同时入口锚点必须真的迁到 kind-tab-goods：只换名字不换选择器的话，任何按旧名定位的东西
    // （包括本脚本的历史版本、外部自动化）会**静默点空** —— 点了没反应，最难查。
    report('旧页签不再存在（「产品」/「映射与关联」两个名字与它们的 data-act 都必须消失）',
      tabNames.indexOf('产品') < 0 && tabNames.indexOf('映射与关联') < 0 &&
        !!document.querySelector('[data-act="kind-tab-goods"]') &&
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
    await clickText('.md-tabs .md-tab', '款与商品');
    // 等它渲染出第一行即可，**行数判定留给 report**：条数不对时报可读 FAIL（rows=9），
    // 而不是让 waitFor 超时中断、把后面几十条断言一起吞掉（2026-10-08 的实测教训）。
    await settle(function () { return all('[data-act="pending-table"] tbody tr[data-item-id]').length >= 1; }, 6000);
    // ⭐ 2026-10-25（P2）：合并段首屏**默认不筛来源** —— 订单 3 + 采集 2 同屏。
    //    这是合并的直接结果，也是它要换来的东西：用户不用先选"从哪来"才看得到待办。
    report('待认清单首屏列出**两个来源**（订单 3 + 采集 2 = 5 行，默认不筛来源）',
      all('[data-act="pending-table"] tbody tr[data-item-id]').length === 5,
      'rows=' + all('[data-act="pending-table"] tbody tr[data-item-id]').length);
    // 之后几十条断言都以"订单队列 3 行"为基准 ⇒ 显式收窄来源。
    // 不收窄的话失败看起来像"多了一行"，真实原因是另一源被合并进来了 —— 那种红最难查。
    await setPendingOrigin('order');
    await settle(function () { return all('[data-act="pending-table"] tbody tr[data-item-id]').length === 3; }, 4000);
    report('来源收窄到「订单」后是 3 行（2 待关联 + 1 店铺未归一）',
      all('[data-act="pending-table"] tbody tr[data-item-id]').length === 3,
      'rows=' + all('[data-act="pending-table"] tbody tr[data-item-id]').length);
    // 两栏**同屏且有内容** —— 这是重构相对旧形态的**新增能力**：
    // 旧形态下"产品表"与"待关联队列"分属两个页签，永远不可能同时出现在屏幕上。
    // ⚠️ 判可见性而不是只判存在：合并页签前池栏容器是"有意留在 DOM 里但 display:none"的，
    //    只判 querySelector 找得到等于恒真（那条坑正是这条断言最早要抓的）。
    report('两栏同屏：左栏产品表 + 右栏队列都可见（S4 合并页签后首屏即如此）',
      isShown(document.querySelector('[data-act="pane-products"] [data-act="product-table"]')) &&
        isShown(document.querySelector('[data-act="pane-pool"] [data-act="pending-table"]')),
      'L=' + isShown(document.querySelector('[data-act="pane-products"]')) +
        ' R=' + isShown(document.querySelector('[data-act="pane-pool"]')));
    // ── 剩余数只报**一处**（2026-10-25 用户口径：状态句与徽标/来源下拉重复，撤句留徽标）──
    // 反向守卫：那句「还剩 N 个没认」不许以任何形态回来 —— 它回来的那一刻，
    // 同一个数就又有了第二个实现点（两处各能漂移，正是 P2 修过的那类错账）。
    // ⚠️ 反向断言**不能锚 document.body**：注入脚本自己就住在 body 里的一个 script 元素中，
    //    它的源码（含断言文案）全在 body 的 textContent 里 —— body 级"不许出现 X"必被自己污染成恒红。
    //    锚到右栏（状态句当年住的地方），范围正好是这句话可能回来的地方。
    var badgeNow = pendingBadgeNum();
    report('「还剩 N 个没认」状态句已撤：剩余数只由分段徽标报（badge=' + badgeNow + '）',
      !document.querySelector('[data-act="map-status-line"]') &&
        flat(document.querySelector('[data-act="pane-pool"]')).indexOf('还剩') < 0 &&
        flat(document.querySelector('[data-act="pane-pool"]')).indexOf('个没认') < 0,
      'line=' + !!document.querySelector('[data-act="map-status-line"]') +
        ' badge=' + badgeNow);
    // 反向守卫：五项指标条**不许回到待认段**。它答的是"干得怎么样"（关联率 / 映射记录），
    // 而这一屏的问题是"今天先干哪些" —— 搬回顶部就等于让用户多扫五行找一个数。
    report('待认段不再有指标条（只有一个数，不是五项；目标：首屏常驻决策信息 ≤ 1 行）',
      !document.querySelector('[data-act="map-stats"]'),
      flat(document.querySelector('[data-act="sub-pending"]')));
    // ── D1 死锁：出口必须**可点**，而且指向一个真的在软件里的地方 ─────────────
    // 原文是一句纯文本"请先到「店铺账号管家」的「店铺登记」…"，而那个岛不在默认包里 ——
    // 全新安装上这就是个两端都不可点的死胡同（提示不可点 + 目的地不存在）。
    // 现在：① 提示条上有一个真按钮；② 行内也有一份；③ 目的地是「基础数据」模块的
    // 「店名归一」项（2026-10-14 整合后从本页页签改成跨模块跳转，registry 步端到端验它；
    // 2026-10-22 该项随物理合并改名「店名归一」，按钮文案跟着改 —— 断言钉的是**名**，改名即红）。
    report('未归一店铺被点名，且旁边就是一个真按钮（不是一句"请先到…"的纯文本）',
      flat(document.querySelector('.gd-hints')).indexOf('新奇怪物店') >= 0 &&
        flat(document.querySelector('.gd-hints')).indexOf('店名归一') >= 0 &&
        !!document.querySelector('[data-act="open-registry"]'),
      flat(document.querySelector('.gd-hints')).slice(0, 60));
    var openReg = document.querySelector('[data-act="open-registry"]');
    report('提示条的「去「店名归一」」不是灰按钮（死锁的出口不能是个点不动的装饰）',
      !!openReg && !openReg.disabled,
      openReg ? 'disabled=' + openReg.disabled : 'missing');
    var blockedBtn = queueRow('TB-999').querySelector('[data-act="row-blocked"]');
    report('店铺未归一的行**关联**动作禁用且给出原因',
      !!blockedBtn && blockedBtn.disabled && flat(blockedBtn) === '未登记',
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
    var qIds = all('[data-act="pending-table"] tbody tr[data-item-id]').map(function (r) {
      return String(r.getAttribute('data-item-id')).trim();
    });
    report('队列里不出现已建立映射的商品（队列 = 订单聚合 − 生效映射，不是缓存表）',
      ['SKU-OLD', 'SKU-OLD2', 'B0OLD0001', 'B0OLD0002'].every(function (id) { return qIds.indexOf(id) < 0; }),
      'queue=' + JSON.stringify(qIds));
    var qHeadTrim = all('[data-act="pending-table"] thead th').map(function (t) { return flat(t); });
    report('队列列已裁：平台 / 状态不再是独立列（分别折进店铺格与行态，见方案 §7-2）',
      qHeadTrim.indexOf('平台') < 0 && qHeadTrim.indexOf('状态') < 0, qHeadTrim.join('|'));

    // ── 队列的图：订单里已有的图必须自动出现在认款界面 ────────────────
    // 认款只能靠肉眼比图（订单里没有任何字段能推出"这是哪一款"），所以这一列是**功能**不是装饰。
    // 图直接来自订单（itemImagePool 的第 ② 层），用户不需要另准备任何文件。
    step('queue-thumbs');
    var qHead = all('[data-act="pending-table"] thead th').map(function (t) { return flat(t); });
    report('队列表有「图」列', qHead.indexOf('图') >= 0, qHead.join('|'));
    // 选择器钉在**归一键**上：夹具里那一行的订单原文是 'B0XYZ1234 '（带尾随空格），
    // 界面若拿原文当键，这个元素根本不会挂出来 —— 图那侧最易犯的静默错误就此变红。
    // 合批取图：别退化成"每行一次 IPC"（那会把整列拖卡）。
    // ⚠️ 只能数"请求里含这张订单图的那几次"，**不能**数全局次数：左栏产品列表走的是
    //    同一条通道（image-thumb-batch），全局计数会被它污染成恒红 —— 那这条断言就成噪音了。
    // ⚠️ 2026-10-25（P2 · S5）：判据从"**累计**只发过一次"改成"**一轮列表渲染**只发一次"。
    //    累计次数会被列表**重挂载**污染（S5 那一步要在「已认」段验统计条，切回来时待认清单
    //    重建过一次 ⇒ 合法的 2 次），而"重挂载两次"与"每行一次 IPC"是两件完全不同的事 ——
    //    前者不该红、后者必须红。做法：先把这条通道的计数清零，再**主动刷新一轮**，
    //    此时窗口里只有这一次渲染 ⇒ 计数 > 1 就只能是"每行一次"。
    // ⚠️ 清的是 window.__smokeCalls（假桥里 rec 写的那本账），不是本作用域的 calls 函数 ——
    //    往函数对象上 delete 一个属性不会影响账本，计数照样从 2 起算。
    if (window.__smokeCalls) delete window.__smokeCalls['orderImageThumbBatch'];
    await clickText('[data-act="map-refresh"]', '刷新');
    await settle(function () {
      return calls('orderImageThumbBatch').some(function (arg) {
        var items = Array.isArray(arg) ? arg : (arg && arg.items) || [];
        return items.some(function (it) { return it && it.localPath === SMOKE_IMG.order; });
      });
    }, 8000);
    var orderThumbCalls = calls('orderImageThumbBatch').filter(function (arg) {
      var items = Array.isArray(arg) ? arg : (arg && arg.items) || [];
      return items.some(function (it) { return it && it.localPath === SMOKE_IMG.order; });
    });
    report('缩略图是合批取的（一轮列表渲染只发一次取图请求，不是每行一次 IPC）',
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
    var relateBtn = document.querySelector('[data-act="pending-relate"]');
    report('左栏展开一款后右栏才出现直连入口，且写明落到哪一款',
      !!relateBtn && flat(relateBtn).indexOf('S2') >= 0,
      relateBtn ? flat(relateBtn) : 'missing');
    report('没勾选任何商品时直连不可点（没有待办就不该点得动）',
      !!relateBtn && relateBtn.disabled);
    var rBoxes = all('[data-act="pending-table"] tbody tr[data-item-id] input[type="checkbox"]').filter(function (c) { return !c.disabled; });
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
    report('⭐ 直连落到**左栏选中的那一款**（S2 / id=2），不是产品列表的第一行（S1 / id=1）',
      direct.length === 2 && direct.every(function (r) { return r.productId === 2; }),
      JSON.stringify(direct));
    report('直连不带颜色（spec 落 * —— 没机会选色就不替用户猜一个）',
      direct.every(function (r) { return r.spec === '*'; }),
      JSON.stringify(direct.map(function (r) { return r.spec; })));
    await settle(function () { return all('[data-act="pending-table"] tbody tr[data-item-id]').length === 1; }, 6000);
    report('直连写完队列重拉：刚认下的两行从池里消失（与弹层关联同一条写路径）',
      all('[data-act="pending-table"] tbody tr[data-item-id]').length === 1,
      'rows=' + all('[data-act="pending-table"] tbody tr[data-item-id]').length);
    // 反向守卫：「当前款」必须是**屏幕上看得见的那一行**，不是"记住上一次"的那个 id。
    // 用户**没选任何款**（或选中的款已经不在列表里）时，右栏不该挂着一个"看起来已经选好"的
    // 落点 —— 照着点就是写错款，而且事后看不出是系统替他选的。
    // ⭐ 2026-10-25（S4）：展开区撤掉后，"收起展开行"这个动作没有了（单击 = 选中，再点不取消）。
    //    契约不变，触发方式换成**把当前款筛出列表** —— 落点不在屏幕上就得撤回。
    //    这条路比"收起"更硬：它同时覆盖筛选 / 翻页 / 删除这几种"款已经看不见了"的情形，
    //    而这几种正是"照着点就写错款"的真实来源（收起只是当年唯一能造出来的那一种）。
    // ⚠️ 触发方式选「问题件 › 缺克重」而不是「搜索款号」：本冒烟的 productList 桩**没有实现
    //    search 过滤**（它只认 supplierId / withoutSupplier / onlyMissingWeight），用搜索造不出
    //    "当前款不在列表里"，而那样失败的样子是"按钮没反应" —— 看着像产品坏了，实际是夹具没喂数据。
    setVal(document.querySelector('[data-act="filter-issue"]'), 'missingWeight');
    await settle(function () { return productRows().length === 1; }, 6000);
    await settle(function () {
      var b = document.querySelector('[data-act="pending-relate"]');
      return !!b && flat(b).indexOf('S2') < 0;
    }, 3000);
    report('当前款被筛出列表 → 按钮不再声称落点是 S2，改口「先选一个款」（看不见的款不能当落点）',
      (function () {
        var b = document.querySelector('[data-act="pending-relate"]');
        return !!b && flat(b).indexOf('S2') < 0 && flat(b).indexOf('先选一个款') >= 0;
      })(),
      'rows=' + productRows().length +
        ' codes=' + all('[data-act="p-code"]').map(flat).join('/') +
        ' btn=' + (flat(document.querySelector('[data-act="pending-relate"]')) || 'missing'));
    // 再点回来：落点要能恢复（下一个场景的对比模式还要用它当初始候选）
    await clickText('[data-act="clear-filters"]', '清空全部');
    await settle(function () { return productRows().length === 2; }, 6000);
    productRows()[1].click();
    await settle(function () {
      var b = document.querySelector('[data-act="pending-relate"]');
      return !!b && flat(b).indexOf('S2') >= 0;
    }, 3000);
    report('清掉筛选再点回那一款 → 按钮重新写明落点是 S2',
      (function () {
        var b = document.querySelector('[data-act="pending-relate"]');
        return !!b && flat(b).indexOf('S2') >= 0;
      })(),
      flat(document.querySelector('[data-act="pending-relate"]')) || 'missing');

    // ── B1：认款之后，左栏「已关联商品」必须跟着更新 ────────────────────
    // 真机实测的现行缺陷：loadLinks 拉过一次（哪怕空数组）就**不再重拉** ⇒ 右栏刚写完
    // （指标条变「已关联 3」）而左栏同一屏仍写旧值，刷新按钮/重新展开都无效，只有重启才恢复。
    // 用户刚做完一件"大事"却立刻看到两个互相矛盾的数字 —— 对不会电脑的人，这不叫 bug，叫"这软件靠不住"。
    // 这一步之前刚把 S2 选中过（那时它只有 1 条 confirmed），随后认款给它加了 2 条 ⇒ 现在必须是 3。
    // ⭐ 2026-10-25（S4）：左栏展开区的「已关联商品」整块撤掉后，这条契约的落点是
    //    右栏「已认」段的按款反查 —— 名字换了，"刚写完必须看得到新值"这条口径一个字没动。
    step('links-fresh');
    await clickText('[data-act="sub-mapped"]', '已认');
    await settle(function () { return !!document.querySelector('[data-act="mapped-by-product"]'); }, 6000);
    var lfBtn = document.querySelector('[data-act="mapped-by-product"]');
    if (lfBtn) lfBtn.click();
    // ⚠️ 判据必须同时等「请求带了 productId」**和**「行数变成 4」：只等"B0XYZ1234 出现在表里"
    //    会被**未过滤**的那份（6 条，早就含它）提前满足 ⇒ 读到的是筛选前的旧表（实测 rows=6）。
    await settle(function () {
      var c = calls('productSkuList').slice(-1)[0];
      return !!c && Number(c.productId) === 2 &&
        all('[data-act="mapped-table"] tbody tr[data-item-id]').length === 4;
    }, 8000);
    var lfRows = all('[data-act="mapped-table"] tbody tr[data-item-id]');
    var lfIds = lfRows.map(function (r) { return r.getAttribute('data-item-id'); });
    report('认款后按款反查是**新值**（反查缓存不刷新的话永远停在认款前那一条）',
      lfRows.length === 4 &&
        lfIds.some(function (id) { return String(id).indexOf('B0XYZ1234') >= 0; }),
      'rows=' + lfRows.length + ' ids=' + JSON.stringify(lfIds));
    report('反查不串款：只看 S2 时不出现 S1 那两条 SKU-OLD*',
      lfIds.every(function (id) { return String(id).indexOf('SKU-OLD') < 0; }),
      'ids=' + JSON.stringify(lfIds));
    // 出口：取消按款过滤并回到「待认」段（下一步的「显示更多」守卫长在待认段上）
    lfBtn.click();
    await settle(function () {
      return all('[data-act="mapped-table"] tbody tr[data-item-id]').length >= 4;
    }, 6000);
    await clickText('[data-act="sub-pending"]', '待认');
    await settle(function () { return !!document.querySelector('[data-act="pending-table"]'); }, 6000);

    // ── B2 反向守卫：没有"还没列出的组"时，「显示更多」必须**不存在** ────
    // 此刻 2 行待关联已被认掉、队列里只剩 1 行店铺未归一：待办总数（unmapped + shopUnresolved）
    // 恰好等于已列出数 ⇒ 不该有"显示更多"。旧判据 groups > shown 在这里**恒真**
    // （groups 数的是"聚合出的全部组"，含已关联的），于是渲染出一个点了纹丝不动的按钮 ——
    // 这正是本仓既有结论"假动作"的现行犯。
    report('队列已列完时「显示更多」不存在（判据是"还有没有没列出的组"，不是 groups > shown）',
      !document.querySelector('[data-act="queue-more"]'),
      'btn=' + !!document.querySelector('[data-act="queue-more"]') +
        ' 计数=' + flat(document.querySelector('[data-act="pending-count"]')));

    // ── 夹具复位：上面那条动线把两行待关联商品消耗掉了 ──────────────
    step('reset');
    report('夹具复位：队列回到 3 行（直连消耗掉的两行回来了，后续场景各自从干净态开始）',
      await resetFixture(), 'rows=' + all('[data-act="pending-table"] tbody tr[data-item-id]').length);

    // ── 认款入口**只有一个**（2026-10-25 P2 · S3）────────────────────────
    // 2026-10-08 曾为了让按钮"落在视线焦点上"，在左栏展开区加了第二处入口
    // （relate-from-expanded）。加上右栏工具栏的「关联到 S2」、行内「关联…」、批量关联，
    // 一共有四个近义动作 —— 用户的原话是"不知道该点哪个"。
    // P2 收敛成动作条上的**一个**：勾商品 → 点款 → 按动作条。
    //
    // 这条是**反向守卫**：只要页面上再长出第二个能提交认款的按钮，它就必须变红。
    // 判据用选择器计数（不写死名字），新增入口时只要沿用同一锚点就会被逮住；
    // 换锚点的话，"老的两个锚点都不存在"这条会先响。
    step('relate-single-entry');
    var entryCount = all('[data-act="pending-relate"]').length;
    report('⭐ 全页只有一个认款提交按钮（动作条那个）—— 多一个就等于又长出第二个入口',
      entryCount === 1,
      'count=' + entryCount);
    report('左栏展开区不再有第二个认款入口（relate-from-expanded / relate-hint 都已下线）',
      !document.querySelector('[data-act="relate-from-expanded"]') &&
        !document.querySelector('[data-act="relate-hint"]'),
      'btn=' + !!document.querySelector('[data-act="relate-from-expanded"]') +
        ' hint=' + !!document.querySelector('[data-act="relate-hint"]'));


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
    document.querySelector('[data-act="pending-table"] tbody tr[data-item-id^="B0XYZ1234"] [data-act="row-compare"]').click();
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
      await resetFixture(), 'rows=' + all('[data-act="pending-table"] tbody tr[data-item-id]').length);

    // ── 批量关联：必须一次提交，且每行带自己的店铺 ─────────────────────
    step('batch-map');
    var boxes = all('[data-act="pending-table"] tbody tr[data-item-id] input[type="checkbox"]').filter(function (c) { return !c.disabled; });
    report('可勾选行恰好 2 行', boxes.length === 2, 'boxes=' + boxes.length);
    boxes.forEach(function (b) { b.click(); });
    // ⭐ 2026-10-25（P2）：文案来源变了 —— 旧的「批量关联选中 N 项…」按钮已并入动作条：
    // 动作条左侧报「已选 N 项」，主按钮是「认到 <款>」，right 侧的「换一款…」才开弹层。
    // 本场景要验的是**弹层那条路**（打乱款 → 一次提交），所以点「换一款…」。
    await settle(function () {
      return flat(document.querySelector('[data-act="pending-selcount"]')).indexOf('2') >= 0;
    }, 4000);
    report('动作条报出「已选 2 项」（认款入口收敛成一个后，数量必须写在脸上）',
      flat(document.querySelector('[data-act="pending-selcount"]')).indexOf('2') >= 0,
      flat(document.querySelector('[data-act="pending-selcount"]')) || 'missing');
    await clickText('[data-act="pending-pick"]', '换一款');
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
    await settle(function () { return all('[data-act="pending-table"] tbody tr[data-item-id]').length === 1; }, 6000);
    report('关联后队列重拉，只剩未归一的 1 行（不是本地删行假装成功）',
      all('[data-act="pending-table"] tbody tr[data-item-id]').length === 1,
      'rows=' + all('[data-act="pending-table"] tbody tr[data-item-id]').length);
    // 更锋利的一条：刚认下的那两条**按 id** 从队列消失（只数行数会漏掉"换了一批别的东西"）
    var qIds2 = all('[data-act="pending-table"] tbody tr[data-item-id]').map(function (r) {
      return String(r.getAttribute('data-item-id')).trim();
    });
    report('刚认下的两个商品已从队列消失（已关联的行不再出现在池里）',
      qIds2.indexOf('SKU-A1') < 0 && qIds2.indexOf('B0XYZ1234') < 0, 'queue=' + JSON.stringify(qIds2));
    // 关联率那条挪到下面的 mapped-tab 步（P2 · S5：指标条已搬到「已认」段）

    // ── 已建立映射：新行可见 / 标失效按 id / 改绑拉回已确认 ────────────
    step('mapped-tab');
    await clickText('[data-act="sub-mapped"]', '已认');
    // 第二个参数带尾随空格：写进去的是**订单原文**（见上一步的断言），列表就按写入值显示 ——
    // 归一发生在主进程的匹配侧，界面不替它改数据。
    await waitFor(function () { return !!mappedRow('SKU-A1') && !!mappedRow('B0XYZ1234 '); }, 6000);
    report('新写入的两条出现在「已建立映射」', true, 'rows=' + all('[data-act="mapped-table"] tbody tr[data-item-id]').length);
    // 关联率住在**这一段**（P2 · S5 把它从待认段搬来）：分母是组数，2/3 = 3 组里认了 2 组。
    // ⚠️ 判据必须在切段**之后**取 —— 停在待认段时这条条根本不在 DOM 里，flat(null) 是空串。
    await settle(function () { return flat(document.querySelector('[data-act="map-stats"]')).indexOf('（2/3）') >= 0; }, 6000);
    report('已认段的指标条：关联率更新为 2/3（分母用组数，不是行数）',
      flat(document.querySelector('[data-act="map-stats"]')).indexOf('（2/3）') >= 0,
      flat(document.querySelector('[data-act="map-stats"]')));

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

    // ── 供应商主数据已随 2026-10-14 整合搬去「基础数据」──────────────────
    // 原「suppliers-tab」步（列表渲染 / 产品数列合并自 product.summary / 编辑只放开
    // 电话备注）整条搬到 scripts/master-data-ui-smoke.mjs 的 suppliers 步，一条没放宽。
    // 2026-10-17 收拢后「供应商」是「货品档案」组内的一条页签（kind-tab-suppliers），
    // 但它渲染的仍是**那一份** SupplierView —— 本页里不该再有第二份实现。
    report('供应商只是组内页签，本页没有第二份供应商实现（supplier-table 不在货品档案里）',
      !!document.querySelector('[data-act="kind-tab-suppliers"]') &&
        !document.querySelector('[data-act="tab-suppliers"]') &&
        !document.querySelector('[data-act="supplier-table"]'),
      'tab=' + !!document.querySelector('[data-act="kind-tab-suppliers"]') +
        ' table=' + !!document.querySelector('[data-act="supplier-table"]'));

    // ── 「显示更多」必须是**真动作**（B2 的正向半边）─────────────────────
    // 反向半边（没有更多时不渲染按钮）已在 links-fresh 那步钉过。这一半钉"真的还有没列出的组时，
    // 点下去要真的多列出来"：夹具造 205 组待办，初始上限 200 ⇒ 已列出 200、「显示更多」在；
    // 点一下 ⇒ 205 组全列出、按钮消失。
    // ⚠️ 只有"待办总数 > 已列出"的样本才分得清"点了不动"和"真的多列了" —— 默认夹具只有 3 组，
    //    永远到不了上限，拿它验这条会恒绿（等于没测）。
    step('queue-more');
    // 2026-10-14 起本页只有一个页签（工作台），不必再"从供应商页签切回来"。
    // 仍显式点一次（幂等），理由同 queue 步 —— 别让"默认页签被改错"变成后面断言集体失败的假象。
    await clickText('.md-tabs .md-tab', '款与商品');
    await setPendingOrigin('order');
    window.__smokeQueueMany = true;
    await clickText('[data-act="map-refresh"]', '刷新');
    await settle(function () { return all('[data-act="pending-table"] tbody tr[data-item-id]').length === 200; }, 10000);
    report('待办 205 组 > 单页上限 200：已列出 200 组、「显示更多」出现',
      all('[data-act="pending-table"] tbody tr[data-item-id]').length === 200 &&
        !!document.querySelector('[data-act="queue-more"]'),
      'rows=' + all('[data-act="pending-table"] tbody tr[data-item-id]').length +
        ' btn=' + !!document.querySelector('[data-act="queue-more"]'));
    var moreBtn = document.querySelector('[data-act="queue-more"]');
    await settle(function () { return !!moreBtn && !moreBtn.disabled; }, 6000);
    if (moreBtn && !moreBtn.disabled) moreBtn.click();
    await settle(function () { return all('[data-act="pending-table"] tbody tr[data-item-id]').length === 205; }, 10000);
    report('点「显示更多」→ 真的多列出 5 组，按钮随之消失（不是点了纹丝不动）',
      all('[data-act="pending-table"] tbody tr[data-item-id]').length === 205 &&
        !document.querySelector('[data-act="queue-more"]'),
      'rows=' + all('[data-act="pending-table"] tbody tr[data-item-id]').length +
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
    // ⭐ 2026-10-25（P2）：待认段 = 订单 + 采集**两源合并** ⇒ "清单空了"必须两源都空。
    // 只清队列的话，夹具里那 2 行采集商品会把空态挡在门外 —— 而且挡得看不出原因
    // （页面非空、断言找不到 go-today，看起来像"空态按钮没了"）。
    window.__smokeEmptyItems = true;
    // S4 起不再需要"切回映射视图"：只有一个工作台页签。仍然显式点一次（幂等），
    // 理由同 queue 步 —— 别让"默认页签被改错"变成后面断言集体失败的假象。
    await clickText('.md-tabs .md-tab', '款与商品');
    // 上一步（rebind）停在「已认」，空态在「待认」段里 —— 先切回来（幂等）
    await setPendingOrigin('');
    // ⚠️ 必须显式刷新一次：本步之前工作台**可能已经挂载**（那就点页签是幂等的、不会重新取数），
    //    "切页签会重新挂载"只是副作用，不能当成取数保证（2026-10-08 实测：上一轮新增 queue-more
    //    之后工作台已挂载 ⇒ 空队列信号推不下去 ⇒ 这一步 timeout）。
    await clickText('[data-act="refresh"]', '刷新');
    await waitFor(function () { return !!document.querySelector('[data-act="go-today"]'); }, 6000);
    report('队列为空时给出「去「发货台」导入订单」的真入口（不是一句"导入订单后…"）',
      flat(document.querySelector('[data-act="go-today"]')).indexOf('发货台') >= 0,
      flat(document.querySelector('[data-act="go-today"]')));
    // 全零的另一端（W2/全零）：清单全空时**一项都不列**，空态说一句人话。
    // 「null」（队列没拉过）不能走进这一句 —— 那会替用户宣布一个它不知道的结论
    //（2026-10-08-goods-page-entry-guide.md 第 4 条）。
    // ⭐ 2026-10-25：状态句已撤（与徽标重复），"全零说人话"由空态标题承担 —— 判据换了落点，
    //    守的还是那件事：0 不是进度，是"还没有东西进来"；不许说"还剩 0 个没认"。
    await settle(function () {
      var t = document.querySelector('[data-act="pending-table"] .wb-empty__title');
      return !!t && flat(t).indexOf('还没有要认的商品') >= 0;
    }, 6000);
    var zeroTitle = flat(document.querySelector('[data-act="pending-table"] .wb-empty__title'));
    report('全零时空态说一句人话，不说"还剩 0 个没认"（0 不是进度，是"还没有东西进来"）',
      zeroTitle.indexOf('还剩') < 0 && zeroTitle.indexOf('还没有要认的商品') >= 0,
      zeroTitle);
    // 反向守卫（首次动线 R3）：此刻是"队列空但**有款**"——引导卡**不该**出现。
    // 它的判据是那条链的**两端同时为零**，不是"有一端为零就显示"。
    report('队列空但有款 → 首启引导卡不出现（判据是两端同时为零，不是"一条不满足就显示"）',
      !document.querySelector('[data-act="first-run-card"]'));
    // 采集侧的"空"只为本步造 —— 复位掉，别让它漏进下面那些"队列空但采集有货"的场景
    window.__smokeEmptyItems = false;

    // ── 首次动线（R3 · UX-G4）：空库那张卡 ───────────────────────────────
    // 判据是"零款 + 队列已拉过且为空"——**两个条件都不容易造**，所以夹具两个开关一起用：
    // __smokeEmptyProducts 造零款、__smokeEmptyQueue 造空队列。
    // 少造任何一个，这张卡要么恒不出现（等于没测），要么在有货的库里冒出来（真机上没人会看见）。
    // ⚠️ 断言必须超出"卡出现了"：三步的顺序、三步各带真按钮、第三步不再说"就在这一页"，各是一条。
    // ⚠️ 2026-10-28：第三步从「点一款认款」改成「看要拿什么」（归款已是导入时自动完成的），
    //    所以它**从"刻意没有按钮"翻成了"必须有按钮"** —— 这一步的落点在另一个模块，
    //    没有按钮就只是一句感想。改这段时别再按旧文案写回去。
    step('first-run');
    window.__smokeEmptyProducts = true;
    window.__smokeEmptyQueue = true;
    await clickText('[data-act="refresh"]', '刷新');
    await settle(function () { return !!document.querySelector('[data-act="first-run-card"]'); }, 8000);
    var fr = document.querySelector('[data-act="first-run-card"]');
    report('零款 + 队列已拉过且为空 → 首启引导卡出现（全新安装的唯一时刻）', !!fr);
    report('卡上恰好三步、顺序是 订单 → 店铺 → 看要拿什么（顺序错了这三步就不成立）',
      !!fr && all('[data-act="first-run-card"] .gd-firstrun__step').length === 3 &&
        !!document.querySelector('[data-act="fr-step-orders"]') &&
        !!document.querySelector('[data-act="fr-step-shops"]') &&
        !!document.querySelector('[data-act="fr-step-stats"]'),
      fr ? 'steps=' + all('[data-act="first-run-card"] .gd-firstrun__step').length : 'missing');
    report('三步都带**真按钮**（不是"请先去别处导入"那种纯文本提示）',
      !!document.querySelector('[data-act="fr-import-orders"]') &&
        !!document.querySelector('[data-act="fr-open-registry"]') &&
        !!document.querySelector('[data-act="fr-goto-purchase"]'));
    report('第 3 步不再写「就在这一页」（归款已自动完成，这一页没有第三步可做 —— 留着就是一句错话）',
      !document.querySelector('[data-act="fr-step-here"]') &&
        flat(document.querySelector('[data-act="fr-step-stats"]')).indexOf('就在这一页') < 0,
      'here=' + !!document.querySelector('[data-act="fr-step-here"]'));
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
    await settle(function () { return all('[data-act="pending-table"] tbody tr[data-item-id]').length >= 1; }, 8000);
    report('零款但订单已进队列 → 引导卡也不出现（那时该做的是认款，不是"从零开始"）',
      !document.querySelector('[data-act="first-run-card"]') &&
        all('[data-act="pending-table"] tbody tr[data-item-id]').length >= 1,
      'rows=' + all('[data-act="pending-table"] tbody tr[data-item-id]').length);
    // 复原：后面的「店名归一」端到端要的是"3 行队列 + 真有款"的初始态
    window.__smokeEmptyProducts = false;
    window.__smokeEmptyQueue = false;
    await clickText('[data-act="refresh"]', '刷新');
    await settle(function () { return all('[data-act="pending-table"] tbody tr[data-item-id]').length === 3; }, 8000);

    // ── 「店名归一」：D1 死锁的**端到端**验证 ────────────────────────────
    // 走的正是用户真会走的那条路：右栏提示条点「现在登记」→ **跨模块**跳到「基础数据」的
    // 「店名归一」项 → 在名单里采纳 → 点 TitleBar「返回」回队列 → 那一行从「未登记」灰因
    // 变成「可以关联」。
    //
    // ⚠️ 为什么必须端到端，而不是"按钮派发了事件"就够：这个 bug 的本质是**两端接不上**
    //    （出口不存在 / 出口指向的地方不在软件里）。夹具若在店铺侧和队列侧各造一套互不
    //    相干的店名，界面照样全绿，而用户走完这一圈**什么都不会变** —— 那正是恒绿断言。
    //    所以夹具两端共用同一个店名（「新奇怪物店」），并且登记后队列那一行真的放行。
    // ⚠️ 2026-10-14 整合后跳转改成跨模块：本步同时守三件事 —— 意图发对了（shop-accounts +
    //    registry）、落地页真的渲染出来了（md-view + kind-registry + registry-view）、
    //    回路走得通（TitleBar「返回」把货与成本找回来）。
    step('registry');
    window.__smokeEmptyQueue = false; // 上一步为了验空态把它置空了
    window.__smokeQueueMany = false;
    await clickText('[data-act="refresh"]', '刷新');
    await settle(function () { return !!document.querySelector('[data-act="open-registry"]'); }, 8000);

    await clickText('[data-act="open-registry"]', '店名归一');
    // ① 意图：派发的必须是 shop-accounts + registry（action 写错 = 跳过去停在上次那一项，
    //    不报错、只是"像没反应"—— 那是这类字符串协议最难查的失败形态）
    var regNav = lastNav('shop-accounts');
    report('「去「店名归一」」派发 switch-module → shop-accounts（action=registry）',
      !!regNav && regNav.action === 'registry',
      JSON.stringify(window.__navs));
    // ② 落地：模块真的切过来了，且停在「店名归一」这一项（左导航高亮 + 内容真的是登记页）
    await settle(function () {
      return !!document.querySelector('.md-view') &&
        !!document.querySelector('[data-act="kind-tab-registry"]') &&
        kindActive('registry') &&
        isShown(document.querySelector('[data-act="registry-view"]'));
    }, 12000);
    report('跨模块落地：「基础数据」渲染出来，且自动停在「店名归一」项（左导航高亮 + 登记页可见）',
      !!document.querySelector('.md-view') &&
        !!document.querySelector('[data-act="kind-tab-registry"]') &&
        kindActive('registry') &&
        isShown(document.querySelector('[data-act="registry-view"]')) &&
        !document.querySelector('.gd-view'),
      'nav-active=' + (document.querySelector('[data-act="kind-tab-registry"]') || {}).className);
    // 侧栏三组 + 当前组（店铺账号）的组内页签都在（整合后的形态：一个入口管全部维护）
    // 2026-10-17 收拢：七类资料从"侧栏七个并列项"变成"三组 + 组内页签"，
    // 所以这条断言拆成两半 —— 只验组在，组里没画页签（点进去一片空白）照样能绿。
    report('「基础数据」侧栏三组都在（店铺账号 / 货品档案 / 物流运费）',
      ['accounts', 'goods', 'shipping'].every(function (g) {
        return !!document.querySelector('[data-act="kind-' + g + '"]');
      }),
      ['accounts', 'goods', 'shipping']
        .map(function (g) { return g + '=' + !!document.querySelector('[data-act="kind-' + g + '"]'); }).join(' '));
    report('落到「店名归一」时，组内页签条也画出来了（店铺 / 店名归一 / 企业 / 工具账号）',
      ['accounts', 'registry', 'companies', 'tools'].every(function (k) {
        return !!document.querySelector('[data-act="kind-tab-' + k + '"]');
      }),
      ['accounts', 'registry', 'companies', 'tools']
        .map(function (k) { return k + '=' + !!document.querySelector('[data-act="kind-tab-' + k + '"]'); }).join(' '));

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

    // 2026-10-22 物理合并收口：「已登记店铺表 + 编辑表单」从店名归一撤掉（店铺统一去
    // 「店铺」页看与改）—— 这里钉住"它们没有悄悄回来"；回归覆盖在 master-data:ui 的店铺页。
    report('店名归一不再带已登记店铺表（本页只剩未归一名单 + 指派）',
      !document.querySelector('[data-act="reg-shop-table"]') &&
        !!document.querySelector('[data-act="reg-unmapped-table"]'));


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
    // 只验证"能跳过去"不验证"能跳回来"，用户就会被困在店名归一里 —— 那是这类跳转最容易被做反的一半。
    //
    // ⚠️ 2026-10-17 回路的方式变了：「货品档案」与「店名归一」现在是**同一模块的两个资料项**，
    //    AppShell 的 backId（"回到上一个模块"）在这里不适用 —— 同模块切换不记 back，
    //    TitleBar 也不该出现「返回」。回程 = 点左导航的「货品档案」，这是用户此刻唯一的、
    //    也最直接的回法。所以这条断言反向钉住"别给它一个假的返回按钮"：
    //    一个点了只会把人送回自己的按钮，比没有按钮更迷惑。
    step('registry-back');
    var backBtn = document.querySelector('[data-act="title-back"]');
    var goodsKind = document.querySelector('[data-act="kind-goods"]');
    report('同模块内换资料项**不该**出现 TitleBar「返回」（它的语义是"回到上一个模块"），回程靠左导航的「货品档案」',
      !backBtn && !!goodsKind,
      'back=' + (backBtn ? flat(backBtn) : 'none') + ' kind-goods=' + !!goodsKind);
    if (goodsKind) goodsKind.click();
    await settle(function () { return !!document.querySelector('[data-act="goods-workbench"]'); }, 12000);
    await settle(function () {
      // 2026-10-25（P2）：判据从"行内出现「关联…」按钮"改为"复选框不再禁用" ——
      // 认款已经不在行内了，但"这一行**真的能认了**"这件事没变，判据要跟着入口走。
      var cb = document.querySelector('[data-act="pending-table"] tbody tr[data-item-id="TB-999"] input[type="checkbox"]');
      return !!cb && !cb.disabled;
    }, 10000);
    var afterRow = queueRow('TB-999');
    report('⭐ 登记完点「返回」回队列：那一行**真的能认了**（灰因整段消失，端到端闭环）',
      !!afterRow &&
        !afterRow.querySelector('[data-act="row-open-registry"]') &&
        !afterRow.querySelector('[data-act="row-blocked"]') &&
        !!afterRow.querySelector('input[type="checkbox"]:not([disabled])'),
      afterRow ? flat(afterRow).slice(0, 80) : 'missing');
    var afterCb = afterRow ? afterRow.querySelector('input[type="checkbox"]') : null;
    report('同一行的复选框也不再禁用（平台已经从店铺实体取到了）', !!afterCb && !afterCb.disabled);
    // ⚠️ 断言随 R2 的「0 不占位」一起改了**判据**，没有丢掉它要守的那件事：
    //    原判据是「/店铺未归一 0/」（= 那一项被渲染成 0）。现在值归 0 的这一项**整项不渲染**，
    //    所以"回落为 0"表现为**这一项从条上消失** —— 比渲染一个 0 更强的陈述，
    //    而且它顺带守住了"别把 0 又铺回来"。
    // ⚠️ 判据随 S5/状态句撤除改了落点，但守的**还是那件事**：值归 0 的项不许以"0"或
    //    假待办的形式留在界面上。观测点两个：提示条整条消失（不留没人能处理的警告）；
    //    分段徽标照常报剩余（不许因为少了一类就消失 —— 那是"界面少说了一句"，比多说更危险）。
    // ⚠️ 只判 order 侧（open-registry）：采集侧（items-open-registry）是一份**独立的名单**
    //    （unresolvedItemStores，按"采集时对上的店"算），本步登记的店不在那份名单里，
    //    它的提示条照常留着是**对的** —— 别把两条名单当成一条。
    await settle(function () {
      return !document.querySelector('[data-act="open-registry"]');
    }, 6000);
    report('登记完那行不再卡店铺 → 提示条整条消失（不留假待办），徽标照常报剩余',
      !document.querySelector('[data-act="open-registry"]') && pendingBadgeNum() > 0,
      'reg=' + !!document.querySelector('[data-act="open-registry"]') +
        ' badge=' + pendingBadgeNum());

    // ── W4：单项时不说「批量」（2026-10-08 R2）────────────────────────
    // 批量是一个承诺（一次写多行、一次事务、一次回执）；只有 1 行时它什么都没兑现，
    // 反而让人以为自己勾错了。判据必须在**只勾 1 项**的场景下取 —— 一直有 2 项勾着的话，
    // 单项措辞永远走不到，这条断言会变成恒绿。
    step('batch-label');
    var oneBox = all('[data-act="pending-table"] tbody tr[data-item-id] input[type="checkbox"]')
      .filter(function (c) { return !c.disabled; })[0];
    report('此刻确实有可勾选的行走得到（没有的话下面两条会变成假绿）', !!oneBox);
    oneBox.click();
    // ⭐ 2026-10-25（P2）：文案换了，但**守的东西没换** —— 数量必须跟着项数走。
    // 旧断言的"不说批量"在新形态里没对象了（认款不再分"单个/批量"两套说法：
    // 一次提交 N 行是常态，动作条把 N 直接写在按钮上）。所以判据改成：
    // 左侧计数与主按钮上的项数**两处同时**跟着变 —— 只改一处或写死字符串都会红。
    await settle(function () {
      return flat(document.querySelector('[data-act="pending-selcount"]')).indexOf('1') >= 0;
    }, 4000);
    var oneLabel = flat(document.querySelector('[data-act="pending-selcount"]'));
    var oneMain = flat(document.querySelector('[data-act="pending-relate"]'));
    report('勾 1 项：动作条计数写「已选 1 项」（本场景左栏无展开款 ⇒ 主按钮是「先选一个款」，不假装落点）',
      oneLabel.indexOf('已选 1 项') >= 0 &&
        (oneMain.indexOf('（1 项）') >= 0 || oneMain.indexOf('先选一个款') >= 0),
      oneLabel + ' / ' + oneMain);
    all('[data-act="pending-table"] tbody tr[data-item-id] input[type="checkbox"]')
      .filter(function (c) { return !c.disabled; })[1].click();
    await settle(function () {
      return flat(document.querySelector('[data-act="pending-relate"]')).indexOf('（2 项）') >= 0;
    }, 4000);
    // "主按钮上的项数也变"由**有落点**的场景守（采集段那条：认到 S2（1 项）→ 1 次提交）；
    // 这里只守计数，因为本场景刻意没有展开款 —— 没有落点时按钮就该改成「先选一个款」。
    report('勾到 2 项：动作条计数跟着变 2（不是写死的字符串）',
      flat(document.querySelector('[data-act="pending-selcount"]')).indexOf('已选 2 项') >= 0,
      flat(document.querySelector('[data-act="pending-selcount"]')) + ' / ' +
        flat(document.querySelector('[data-act="pending-relate"]')));
    await clickText('[data-act="pending-clear"]', '清空');
    await settle(function () {
      return flat(document.querySelector('[data-act="pending-selcount"]')).indexOf('勾选') >= 0;
    }, 4000);
    report('清空后动作条回到「勾选商品后可认款」，主按钮不再带项数且禁用（没勾选就点不动）',
      flat(document.querySelector('[data-act="pending-selcount"]')).indexOf('勾选') >= 0 &&
        flat(document.querySelector('[data-act="pending-relate"]')).indexOf('项）') < 0 &&
        !!document.querySelector('[data-act="pending-relate"]').disabled,
      flat(document.querySelector('[data-act="pending-selcount"]')) + ' / disabled=' +
        (document.querySelector('[data-act="pending-relate"]') || {}).disabled);

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
    // 真的能用：点它 → 落到「基础数据 › 店名归一」项，且面板自己关掉
    // （不留在屏幕上挡着刚切过去的那一屏）。
    // ⚠️ 这条动线的**性质**在 2026-10-17 变了两次，读断言时别按老注释理解：
    //    · 2026-10-14 之前 = 切到本页另一个页签；
    //    · 2026-10-14 之后 = **跨模块**跳到「基础数据」（TitleBar「返回」送人回来）；
    //    · 2026-10-17 之后 = **同模块换资料页** —— 货品档案和店名归一现在是同一个模块的
    //      两页资料（侧栏组 kind-goods / 组内页签 kind-tab-registry）。判据（落到
    //      kind-tab-registry 且高亮）没变，但回程变了：没有 title-back 了（同模块内没有
    //      "返回"这回事），而且模块外壳（.md-view）本来就在场 —— 不能再用"出现 .md-view"当落地信号。
    if (helpPanel) helpPanel.querySelector('[data-act="help-go-registry"]').click();
    await settle(function () {
      return !!document.querySelector('[data-act="kind-tab-registry"][aria-current="page"]');
    }, 12000);
    report('帮助里的「打开「店名归一」」真的落到「基础数据 › 店名归一」（不是装饰按钮，面板也自己关掉）',
      !!document.querySelector('[data-act="kind-tab-registry"][aria-current="page"]') &&
        !document.querySelector('[data-act="help-panel"]'),
      'nav-active=' + (document.querySelector('[data-act="kind-tab-registry"]') || {}).className);
    // 回程：后面的导入/导出断言在「产品管理」上，点左导航第一项回去（同模块内没有 TitleBar 返回）。
    // ⚠️ 2026-10-17 深夜：组名「货品档案」按用户口径改名「产品管理」，clickText 的可见名跟着改。
    await clickText('[data-act="kind-goods"]', '产品管理');
    await settle(function () { return !!document.querySelector('[data-act="goods-workbench"]'); }, 12000);

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
    await clickText('.md-tabs .md-tab', '款与商品');
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
        // 克重期望 '320,333' 而不是夹具初值 '320,'：上面 weight-save-in-drawer 步已把黑 M 改成
        // 333（2026-10-09 起克重只在编辑抽屉里改），导出读的是**库里的当下值** ——
        // 导出真带出旧值反而说明读取链路是死的。
        // ⚠️ 下标 6/7：2026-10-09 加「进价(元)」列后各 +1（原 5/6）。
        return r && r.cells && r.cells[6] === 'L,M' && r.cells[7] === '320,333';
      }),
      JSON.stringify((exPayload.rows || []).map(function (r) { return r && r.cells && r.cells.slice(5, 8); })));
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
    // 4 行 = 夹具的 4 条数据行（IMP-1..3 + 款二「厂新」那行）；图贴第 2、4 行（stub 的 byRow 键）。
    report('「图片」列按行显示有没有图（4 行里 2 行有：第 2、4 行）',
      imgCells.length === 4 &&
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
        // 下标 8/9：2026-10-09 加「进价」列后各 +1（原 7/8）
        return tds.length > 9 && flat(tds[8]) === 'M,L' && flat(tds[9]) === '120,';
      })(),
      (function () {
        var tds = document.querySelectorAll('[data-act="import-table"] tbody tr[data-row-no="2"] td');
        return tds.length > 9 ? flat(tds[8]) + ' / ' + flat(tds[9]) : 'tds=' + tds.length;
      })());
    report('预览「进价」列：填了显示 12.34、没填显示「—」（导入前就能核对）',
      (function () {
        var r = document.querySelector('[data-act="import-table"] tbody tr[data-row-no="2"]');
        var el = r && r.querySelector('[data-act="row-cost"]');
        return !!el && flat(el) === '12.34';
      })(),
      (function () {
        var r = document.querySelector('[data-act="import-table"] tbody tr[data-row-no="2"]');
        var el = r && r.querySelector('[data-act="row-cost"]');
        return el ? flat(el) : 'missing';
      })());
    report('⭐ 规格对不上的第 4 行标成「跳过」，而它**仍带着图**（图不改变合格性）',
      (function () {
        var r = document.querySelector('[data-act="import-table"] tbody tr[data-row-no="4"]');
        return !!r && flat(r).indexOf('跳过') >= 0 &&
          r.querySelector('[data-act="row-image"]').getAttribute('data-has-image') === '1';
      })(),
      flat(document.querySelector('[data-act="import-table"] tbody tr[data-row-no="4"]')).slice(0, 60));

    // ── 2026-10-10：款编码列可见性 / 同名款 / 供应商新建 ────────────────────────
    // ⭐ 用户报的「款编码没有回显」：那一列曾缩成"只剩右边一枚徽标"的宽度，输入框宽 0 ——
    //    编码明明有值却看不见，而且**不报任何错**。判据必须是 value + clientWidth **两条**：
    //    只看 innerText 会恒绿（input 没有文本节点），只看 value 又抓不到"塌成 0 宽"这一态。
    var codeCells = all('[data-act="import-table"] tbody tr[data-row-no]').map(function (tr) {
      var inp = tr.querySelector('.im-code-cell input');
      return {
        rowNo: tr.getAttribute('data-row-no'),
        value: inp ? inp.value : null,
        w: inp ? inp.clientWidth : 0,
      };
    });
    report('⭐ 预览「款编码」列每一格都看得见（有值 + 宽度不为 0；那一格曾缩成 0 宽）',
      codeCells.length >= 4 && codeCells.every(function (c) { return !!c.value && c.w >= 80; }),
      JSON.stringify(codeCells));

    var dupTr = document.querySelector('[data-act="import-table"] tbody tr[data-row-no="5"]');
    report('⭐ 同名行（款式名「款二」库里已有）把库里的编码 S2 **回显**到编码格，并逐行标「同名」',
      (function () {
        if (!dupTr) return false;
        var inp = dupTr.querySelector('.im-code-cell input');
        var tag = dupTr.querySelector('[data-act="row-name-matched"]');
        return !!inp && inp.value === 'S2' && !!tag && flat(tag) === '同名';
      })(),
      dupTr ? flat(dupTr).slice(0, 90) : 'missing');
    report('⚠️ 同名行**不是**「自动生成」那一路（沿用已有款 / 新建款是两个相反的徽标，混了就看不出区别）',
      (function () {
        return !!dupTr && flat(dupTr.querySelector('.im-code-cell')).indexOf('自动') < 0;
      })(),
      dupTr ? flat(dupTr.querySelector('.im-code-cell')) : 'missing');
    report('供应商名库里没有 → 标「新建」（否则用户以为名字白填了 —— 旧的实现正是静默落成"未关联"）',
      (function () {
        if (!dupTr) return false;
        var sup = dupTr.querySelector('[data-act="row-supplier"]');
        return !!sup && !!sup.querySelector('[data-act="row-supplier-new"]') && flat(sup).indexOf('厂新') >= 0;
      })(),
      dupTr ? flat(dupTr.querySelector('[data-act="row-supplier"]')) : 'missing');
    report('汇总里报出同名款条数（点提交之前就该知道有几行会动到已有的款）',
      (function () {
        var el = document.querySelector('[data-act="dup-name-count"]');
        return !!el && flat(el).indexOf('1') >= 0;
      })(),
      (function () {
        var el = document.querySelector('[data-act="dup-name-count"]');
        return el ? flat(el) : 'missing';
      })());

    // 同名款这一组开关：默认覆盖（待提交 3 行）→ 切「跳过」（2 行）→ 切回（3 行）。
    // 判据落在**提交按钮的行数**上而不是 aria-pressed：开关"看着切了、提交却没少一行"是最坏的一种。
    report('同名款开关默认停在「覆盖更新」，待提交 = 3 行',
      document.querySelector('[data-act="same-name-overwrite"]').getAttribute('aria-pressed') === 'true' &&
        flat(document.querySelector('[data-act="commit-import"]')).indexOf('3') >= 0,
      flat(document.querySelector('[data-act="commit-import"]')));
    document.querySelector('[data-act="same-name-skip"]').click();
    await settle(function () {
      return flat(document.querySelector('[data-act="commit-import"]')).indexOf('2') >= 0;
    }, 4000);
    report('同名款切「跳过不覆盖」→ 待提交行数立刻少 1（开关真的在管提交，不是装饰）',
      flat(document.querySelector('[data-act="commit-import"]')).indexOf('2') >= 0,
      flat(document.querySelector('[data-act="commit-import"]')));
    document.querySelector('[data-act="same-name-overwrite"]').click();
    await settle(function () {
      return flat(document.querySelector('[data-act="commit-import"]')).indexOf('3') >= 0;
    }, 4000);
    report('切回「覆盖更新」→ 待提交行数回到 3',
      flat(document.querySelector('[data-act="commit-import"]')).indexOf('3') >= 0,
      flat(document.querySelector('[data-act="commit-import"]')));

    var impBefore = calls('productImport').length;
    document.querySelector('[data-act="commit-import"]').click();
    await settle(function () { return calls('productImport').length > impBefore; }, 10000);
    var items = (calls('productImport')[impBefore] || {}).items || [];
    report('只提交能导入的行：规格对不上的 IMP-3 不在 items 里（2026-10-10 起夹具多一行同名行 ⇒ 3 行）',
      items.length === 3 && !items.some(function (x) { return x.code === 'IMP-3'; }),
      JSON.stringify(items.map(function (x) { return x.code; })));
    report('⭐ items 里带上供应商**原文** —— 库里没有的名字靠它在主进程建档（只带 id 时"名字对不上"只剩一个 0）',
      (function () {
        var r = items.filter(function (x) { return x.code === 'S2'; })[0];
        return !!r && r.supplierRaw === '厂新';
      })(),
      JSON.stringify(items.map(function (x) { return x.code + '=' + (x.supplierRaw || ''); })));
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
    report('⭐ items 里进价换算成**分**（12.34 元 → 1234），没填的传 null（= 不改库内已有价）',
      (function () {
        var a = items.filter(function (x) { return x.code === 'IMP-1'; })[0];
        var b = items.filter(function (x) { return x.code === 'IMP-2'; })[0];
        return !!a && a.costCents === 1234 && !!b && b.costCents === null;
      })(),
      JSON.stringify(items.map(function (x) { return x.code + '=' + x.costCents; })));
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
    report('结果页报出「写入进价 N 条 / 新建供应商 N 家」（进价没入库、供应商没写入原先一个字都不说）',
      (function () {
        var t = flat(document.querySelector('.im-result'));
        return t.indexOf('写入进价') >= 0 && t.indexOf('新建供应商') >= 0;
      })(),
      flat(document.querySelector('.im-result')).slice(0, 140));

    // ── 进价维护入口已在 2026-10-22 收回产品编辑抽屉 + 产品列表筛选 ────────
    // 原「基础数据 › 进价」页（CostPane + RatesPane）整页退役，对应冒烟步已随页面删除。
    // 这里只留一条反向守卫：停在「款与商品」时，进价表自己那套锚点不许在 DOM 里
    // （维护入口只剩产品抽屉 ed-cost 与列表 onlyMissingCost 筛选，本页不该再画进价表）。
    report('停在「款与商品」时进价表的锚点不在（成本维护已收回产品编辑抽屉与列表筛选）',
      !document.querySelector('[data-act="tab-cost"]') &&
        !document.querySelector('[data-act="cost-table"]') &&
        !document.querySelector('[data-act="cost-save"]'),
      mapFlat('.md-tabs .md-tab'));

    // ── 待关联采集商品段（第三个认款输入源；采集快照 pl_shop_items）────────
    // 判据三件套（方案 P2 验收）：未认款同屏 / 勾选纪律 / 认款走同一条写路径。
    // ⭐ 2026-10-16 起本段改名「待关联采集商品」且**恒列未认款**（服务端 onlyUnconfirmed）：
    //    已认款的采集商品只在「已建立映射」里出现（认款写的就是映射行）—— 同一个商品
    //    同屏出现两段，正是"页面不协调"的根因。两种未认款状态必须**同屏**出现 ——
    //    少任何一态，"状态列条件渲染"在夹具里恒绿。
    step('shop-items');
    // 切页签后表格元素先出现、行后渲染 —— 必须等行数到位再取 [1]（只等表格会取到 undefined）
    await settle(function () { return productRows().length >= 2; }, 8000);
    var s2row = productRows()[1];
    // ⚠️ 2026-10-25（S4）：展开区撤掉后没有 row-expand / row-detail 了 —— 选中一款只需**点它一下**。
    //    按选中态判再点（不盲点），与 row-select 那一步同一纪律。
    if (!s2row.classList.contains('is-on')) s2row.click();
    await settle(function () {
      return !!productRows()[1] && productRows()[1].classList.contains('is-on');
    }, 4000);
    await setPendingOrigin('scrape');
    await settle(function () { return all('[data-act="pending-table"] tbody tr[data-item-id]').length === 2; }, 8000);
    report('切到「待关联采集商品」段：只剩未认款两行（7002 已认款，被服务端过滤挡在本段外）',
      all('[data-act="pending-table"] tbody tr[data-item-id]').length === 2,
      'rows=' + JSON.stringify(all('[data-act="pending-table"] tbody tr[data-item-id]').map(function (r) { return String(r.getAttribute('data-item-id')); })));
    // ⭐ 2026-10-25（P2）：徽标口径从"本段未认款数"变成"**全部待认数**"
    // （订单 3 + 采集 2 = 5）—— 合并段只有一个徽标，它回答的是"还有多少没认"，
    // 而不是"这一源有多少"。所以它**不随来源筛选变**（筛了只剩 2 行，徽标仍是 5）。
    report('分段徽标报**全部待认数**（订单 3 + 采集 2 = 5），不随来源筛选变',
      (function () {
        var b = document.querySelector('[data-act="sub-pending"] .wb-seg__badge');
        return !!b && flat(b) === '5';
      })(),
      'badge=' + (function () { var b = document.querySelector('[data-act="sub-pending"] .wb-seg__badge'); return b ? flat(b) : 'missing'; })());
    function itemRow(itemId) {
      return document.querySelector('[data-act="pending-table"] tbody tr[data-item-id="' + itemId + '"]');
    }
    function itemBox(row) { return row ? row.querySelector('input[type="checkbox"]') : null; }
    /**
     * ⭐ 两源合并后**仍分得清来源**（方案 §6 变异复核 2 的落点）。
     *
     * 合并成一张表的最大代价是"这条是订单来的还是采集来的"看不见了 —— 而这两种行的
     * 下一步完全不同（订单等发货、采集等认款后上架）。所以来源不是一个装饰性小标签：
     * 把它从行里拿掉，这条必须变红。判据读**行内**标签，不是筛选下拉（那个是用户自己选的，
     * 拿它当证据等于自证）。
     */
    function originTagsOf(origin) {
      return all('[data-act="pending-table"] tbody tr[data-origin="' + origin + '"]').map(function (r) {
        var t = r.querySelector('[data-act="pending-origin-tag"]');
        return t ? flat(t) : '';
      });
    }
    report('⭐ 采集行自带「采集」来源标签（合并后靠它分来源，不看筛选下拉）',
      (function () {
        var tags = originTagsOf('scrape');
        return tags.length === 2 && tags.every(function (t) { return t === '采集'; });
      })(),
      'tags=' + JSON.stringify(originTagsOf('scrape')));
    await setPendingOrigin('order');
    await settle(function () {
      return all('[data-act="pending-table"] tbody tr[data-origin="order"]').length === 3;
    }, 6000);
    report('⭐ 订单行自带「订单」来源标签（同一张表里两源并存，各说各的来源）',
      (function () {
        var tags = originTagsOf('order');
        return tags.length === 3 && tags.every(function (t) { return t === '订单'; });
      })(),
      'tags=' + JSON.stringify(originTagsOf('order')));
    // 后面的断言都建立在"只看采集侧"上
    await setPendingOrigin('scrape');
    /**
     * 勾一个待认行，然后**按结果**判成功（不是点完就走）。
     *
     * 盲点「box.click()」有两个坑，长出来的红一模一样（"点了却没反应"）：
     *   ① 该行本来已是勾选态（上一次写入没把 key 从选择集里摘掉）⇒ click 反而是取消勾选；
     *   ② 在飞的重拉刚好落地，把选择清掉（本文件里早记录过这个竞态）。
     * 判据只能取"动作条计数真的变了"，不能取"我点过了"。
     */
    async function checkPendingRow(itemId, note) {
      var retried = false;
      function selectedCount() {
        var n = document.querySelector('[data-act="pending-selcount"]');
        return n ? flat(n) : 'missing';
      }
      for (var attempt = 0; attempt < 3; attempt++) {
        var row = itemRow(itemId);
        var box = itemBox(row);
        if (!box || box.disabled) { await sleep(150); continue; }
        // 已是勾选态就**不点**（点了等于取消）—— 把判定交给调用方的前置断言，
        // 让"选择集里残留了上一次的 key"这个真错显式变红，而不是在这里被悄悄抹平。
        if (!box.checked) box.click();
        // settle 没有返回值，落停后得自己再判一次（拿 undefined 当判据 = 恒假）
        await settle(function () { return selectedCount().indexOf('已选') >= 0; }, 2500);
        if (selectedCount().indexOf('已选') >= 0) return { ok: true, retried: retried };
        retried = true;
        await sleep(180);
      }
      return { ok: false, retried: retried, why: (note || '') + ' selcount=' + selectedCount() };
    }
    // ⭐ 2026-10-25（用户口径）：状态条压成一行小字，端口收进 title —— 断言跟着换落点，
    //    守的还是那件事：汇总（已采 / 认了）不随当前页过滤，且端口信息仍可考（在 title）。
    var iStatus = document.querySelector('[data-act="items-status"]');
    report('状态条：已采 4 · 认了 2（汇总不随当前页过滤），端口 46211 在 title 里',
      !!iStatus && flat(iStatus).indexOf('已采') >= 0 &&
      flat(iStatus).indexOf('4') >= 0 && flat(iStatus).indexOf('认了 2') >= 0 &&
      (iStatus.getAttribute('title') || '').indexOf('46211') >= 0,
      iStatus ? flat(iStatus) + ' / title=' + (iStatus.getAttribute('title') || '').slice(0, 40) : 'missing');
    var hint = document.querySelector('[data-act="items-hint-shops"]');
    report('未登记店警告条点名「芒果旗舰店」+「去「店名归一」」出口（与队列 hint-shops 同构）',
      !!hint && flat(hint).indexOf('芒果旗舰店') >= 0 &&
      !!hint.querySelector('[data-act="items-open-registry"]'),
      hint ? flat(hint).slice(0, 60) : 'missing');
    // ⭐ 2026-10-25（用户口径）两条**版面**守卫 —— 这类问题 DOM 断言抓不住（元素都在、文案都对，
    //    就是"看着不对"），只能量几何 / 活体测令牌：
    // ① 动作条底色必须**活在主题令牌上**：此前它写的是不存在的 var(--wb-bg-panel, #fff)，
    //    深色主题下永远白底（用户报的"没跟随主题"）。哨兵值法：临时把 --wb-surface 改成一个
    //    界面上不可能出现的颜色，底色不跟着变 = 写死了。
    (function () {
      var bar = document.querySelector('[data-act="pending-actbar"]');
      var prev = document.documentElement.style.getPropertyValue('--wb-surface');
      document.documentElement.style.setProperty('--wb-surface', 'rgb(1, 2, 3)');
      var bg = bar ? getComputedStyle(bar).backgroundColor : '';
      if (prev) document.documentElement.style.setProperty('--wb-surface', prev);
      else document.documentElement.style.removeProperty('--wb-surface');
      report('动作条底色跟著 --wb-surface 走（主题令牌活着，不是写死的白底）',
        bg === 'rgb(1, 2, 3)', 'bg=' + bg);
    })();
    // ② 未登记店提示条必须是**单行轻提示**（此前是两块半屏告警把队列顶出首屏）。
    //    店名串 nowrap + 省略号 ⇒ 高度恒 ~26px；哪天又换行/加大，这里先红。
    var hintBox = document.querySelector('[data-act="items-hint-shops"]');
    var hintH = hintBox ? Math.round(hintBox.getBoundingClientRect().height) : 0;
    report('未登记店提示条是单行轻提示（高度 ≤ 34px，不是半屏告警块）',
      !!hintBox && hintH > 0 && hintH <= 34, 'h=' + hintH);
    var rA = itemRow('1005001234567890'), rB = itemRow('B0XYZ1234'), rC = itemRow('1005009876543210');
    // ⭐ 2026-10-25（P2）：合并段整段就是"待认"，逐行再写「未认款」是废话（已撤掉）。
    // 判据换成**可认 / 不可认两种行态各自给出可点的出口** —— 守的东西没变：
    // 不是一列空白，用户在两态下都知道下一步点哪。
    report('两态同屏：可认行有「删除」、店铺未登记行有「去登记」（各给出可点的出口，不是一列空白）',
      !!rA && !!itemBox(rA) && !itemBox(rA).disabled &&
        !!rA.querySelector('[data-act="i-row-delete"]') &&
        !!rC && !!itemBox(rC) && itemBox(rC).disabled &&
        !!rC.querySelector('[data-act="row-blocked"]') &&
        !!rC.querySelector('[data-act="row-open-registry"]'),
      'A=' + (rA ? flat(rA).slice(-12) : 'x') + ' C=' + (rC ? flat(rC).slice(-12) : 'x'));
    report('⭐ 已认款的 7002 不在本段出现（同一个商品只在一个段里维护，不再两段同屏）',
      !rB, 'B=' + (rB ? 'still-here' : 'filtered'));
    report('勾选纪律：未登记行禁用（没有平台就写不了映射，与队列同一纪律）',
      !!itemBox(rC) && itemBox(rC).disabled, 'disabled=' + !!(itemBox(rC) && itemBox(rC).disabled));
    report('勾选纪律：未认款行可勾选', !!itemBox(rA) && !itemBox(rA).disabled,
      'disabled=' + !!(itemBox(rA) && itemBox(rA).disabled));
    // 直连认款：目标款 = 左栏展开的 S2（不是产品列表第一行 S1）
    itemBox(rA).click();
    await settle(function () {
      var b = document.querySelector('[data-act="pending-relate"]');
      return !!b && !b.disabled && flat(b).indexOf('（1 项）') >= 0;
    }, 4000);
    var iBtn = document.querySelector('[data-act="pending-relate"]');
    report('直连按钮写明落到**左栏展开的那一款**（S2）+ 认几项',
      !!iBtn && flat(iBtn).indexOf('S2') >= 0 && flat(iBtn).indexOf('（1 项）') >= 0,
      iBtn ? flat(iBtn) : 'missing');
    iBtn.click();
    await waitFor(function () { return calls('productSkuMap').length >= 1; }, 6000);
    var iSent = ((calls('productSkuMap')[0] || {}).rows || [])[0] || {};
    report('⭐ 认款走**同一条** productSkuMap 写路径；平台/店铺从快照行带出（不写死、不猜）',
      iSent.platform === 'shopee' && iSent.shopId === 11 && iSent.itemId === '1005001234567890' &&
      iSent.spec === '*' && iSent.productId === 2 && iSent.status === 'confirmed',
      JSON.stringify(iSent));
    // 认款后该行**从本段消失**（服务端 onlyUnconfirmed 恒开，没有"取消筛选"这条路可走）——
    // 桩镜像了映射状态（productSkuMap 写 mappedProductId）：不镜像的话，
    // "认款后行消失 / 徽标 -1"两条断言在夹具里恒绿（界面拿到的永远是同一份未认款快照）。
    await settle(function () {
      return !itemRow('1005001234567890') && all('[data-act="pending-table"] tbody tr[data-item-id]').length === 1;
    }, 6000);
    report('⭐ 认款后该行从本段消失，只剩店铺未登记那行（已认款的去「已建立映射」维护）',
      !itemRow('1005001234567890') &&
        all('[data-act="pending-table"] tbody tr[data-item-id]').length === 1 &&
        String(all('[data-act="pending-table"] tbody tr[data-item-id]')[0].getAttribute('data-item-id')) === '1005009876543210',
      JSON.stringify(all('[data-act="pending-table"] tbody tr[data-item-id]').map(function (r) { return String(r.getAttribute('data-item-id')); })));
    report('认款后分段徽标跟着掉 1（5 → 4：报全部待认数，不是只点亮一次的装饰）',
      (function () {
        var b = document.querySelector('[data-act="sub-pending"] .wb-seg__badge');
        return !!b && flat(b) === '4';
      })(),
      'badge=' + (function () { var b = document.querySelector('[data-act="sub-pending"] .wb-seg__badge'); return b ? flat(b) : 'missing'; })());
    // 同一个商品**只在一个段里维护**：认款写的就是映射行 ⇒ 已认款的采集商品必须能在
    // 「已建立映射」里找到。切过去看（不看的话，"从本段消失"可能被实现成"凭空不见了"）。
    await clickText('[data-act="sub-mapped"]', '已认');
    await settle(function () { return !!mappedRow('1005001234567890'); }, 6000);
    report('⭐ 刚认款的 7001 出现在「已建立映射」里，关联产品是 S2（不是从世界上消失）',
      !!mappedRow('1005001234567890') && flat(mappedRow('1005001234567890')).indexOf('S2') >= 0,
      mappedRow('1005001234567890') ? flat(mappedRow('1005001234567890')).slice(0, 60) : 'missing');
    // 切回本段：下一步（item-wizard）建立在"7001 又可勾选"的原点态上（下一步会 __smokeReset）
    await setPendingOrigin('scrape');

    // ── 建款向导（方案 §4.3；P3）────────────────────────────────────
    // 上一步把唯一可勾选的采集行认掉了 ⇒ 先复位夹具（快照回到"7001 未认款"的原点）
    step('item-wizard');
    window.__smokeReset();
    await clickText('[data-act="map-refresh"]', '刷新');
    // 完成信号必须**跨复位变化**：认款后 7001 从本段消失、复位后又回来，等它 = 没等
    // （旧数据下恒真）⇒ 用在飞刷新落停前点勾选、随后被清空选择的竞态（实测踩到：
    // 点了勾选，在飞的重拉落地把选择清了）。「7001 从消失到回到可勾选」只有复位后
    // 的那一次重拉能造出来。
    // ⚠️ 2026-10-25（P2）：判据从"行里写着「未认款」"改为"复选框可勾" ——
    // 合并段整段就是待认，逐行不再重复写「未认款」（那句话已撤，原判据会永远等不到）。
    await settle(function () {
      var r = itemRow('1005001234567890');
      return !!r && !!r.querySelector('input[type="checkbox"]:not([disabled])');
    }, 8000);
    var wRow = itemRow('1005001234567890');
    var wBox = wRow ? wRow.querySelector('input[type="checkbox"]') : null;
    report('向导前置：7001 回到待认清单、可勾选、且不是勾选态（复位后那一次重拉造出来的状态）',
      !!wRow && !!wBox && !wBox.disabled && !wBox.checked,
      'row=' + !!wRow + ' box=' + !!wBox + ' disabled=' + (wBox ? wBox.disabled : 'n/a') +
        ' checked=' + (wBox ? String(wBox.checked) : 'n/a') +
        ' rows=' + all('[data-act="pending-table"] tbody tr[data-item-id]')
          .map(function (r) { return String(r.getAttribute('data-item-id')); }).join(','));
    var wCheck = await checkPendingRow('1005001234567890', '第一遍');
    report('第一遍：勾一行后计数变成「已选 1 项」', wCheck.ok, JSON.stringify(wCheck));
    await settle(function () {
      var b = document.querySelector('[data-act="items-new-product"]');
      return !!b && !b.disabled;
    }, 4000);
    var wizBtn = document.querySelector('[data-act="items-new-product"]');
    report('「新建款并关联」只在恰好勾选一行时可点（向导预填的是一个商品的矩阵，多行没法合并预填）',
      !!wizBtn && !wizBtn.disabled,
      'btn=' + !!wizBtn + ' disabled=' + (wizBtn ? wizBtn.disabled : 'n/a') +
        ' checked=' + all('[data-act="pending-table"] tbody input[type="checkbox"]:checked').length +
        ' selcount=' + flat(document.querySelector('[data-act="pending-selcount"]')));
    if (wizBtn) wizBtn.click();
    await settle(function () { return !!document.querySelector('[data-act="iw-save"]'); }, 8000);
    report('向导打开：款编码是**系统发号**且只读（渲染层不自行 max+1 —— 会漏识别侧占用的序号）',
      (function () {
        var c = document.querySelector('[data-act="iw-code"]');
        return !!c && c.value === 'STYLE-042' && c.readOnly;
      })(),
      'code=' + (document.querySelector('[data-act="iw-code"]') || {}).value);
    report('档案预填自采集：款式名 = 采集标题、类目 = 采集类目（默认值只能来自证据）',
      (function () {
        var n = document.querySelector('[data-act="iw-name"]');
        var g = document.querySelector('[data-act="iw-category"]');
        return !!n && n.value === '折叠收纳箱 60L 蓝色' && !!g && g.value === '收纳';
      })(),
      'name=' + (document.querySelector('[data-act="iw-name"]') || {}).value);
    var wSkuRows = all('[data-act="iw-sku-row"]');
    report('SKU 矩阵预填：2 色 × 2 码（色名来自采集详情；主进程落库时已按 props 解析成规范形）',
      wSkuRows.length === 2 &&
      all('[data-act="iw-sku-color"]').map(function (i) { return i.value; }).join('/') === '黑/4' &&
      all('[data-act="iw-sku-size"]').map(function (i) { return i.value; }).join('/') === 'L/M',
      'rows=' + wSkuRows.length +
        ' colors=' + all('[data-act="iw-sku-color"]').map(function (i) { return i.value; }).join('/') +
        ' sizes=' + all('[data-act="iw-sku-size"]').map(function (i) { return i.value; }).join('/'));
    // ⭐ 矩阵的**空格**语义：采集到的是"黑只有 L、4 只有 M" ⇒ 只有 2 格是"在卖"，
    //    另外 2 格是空格（直接敲数才加入）。2026-10-25 起一格只有一个输入框（勾选框并进去了），
    //    所以"存在性"看 data-cell-on，别看控件类型 —— 四格都长着输入框。
    report('⭐ 矩阵只出**存在的组合**：四格都有输入框，但只有两格标「在卖」（黑/L、4/M），另两格是空格',
      all('[data-act="iw-sku-weight"]').length === 4 &&
        document.querySelectorAll('[data-act="iw-sku-weight"][data-cell-on="1"]').length === 2 &&
        document.querySelectorAll('[data-act="iw-sku-weight"][data-cell-on="0"]').length === 2,
      'weight=' + all('[data-act="iw-sku-weight"]').length +
        ' on=' + document.querySelectorAll('[data-act="iw-sku-weight"][data-cell-on="1"]').length +
        ' off=' + document.querySelectorAll('[data-act="iw-sku-weight"][data-cell-on="0"]').length);
    report('「采纳为款主图」默认勾选（新建档的款不可能已有主图；只补空的兜底判定仍在主进程）',
      (function () {
        var cb = document.querySelector('[data-act="iw-adopt-image"]');
        return !!cb && cb.checked;
      })(),
      'checked=' + (function () { var cb = document.querySelector('[data-act="iw-adopt-image"]'); return cb ? String(cb.checked) : 'missing'; })());
    report('⭐ 每色行用**自己的**色图缩略图；没采到色图的行回落商品主图（不拿主图冒充色图）',
      (function () {
        var imgs = all('.iw-sku tbody img');
        if (imgs.length !== 2) return false;
        return imgs[0].getAttribute('src') === window.__smokeImg.itemSku &&
          imgs[1].getAttribute('src') === window.__smokeImg.item;
      })(),
      (function () {
        var imgs = all('.iw-sku tbody img');
        return 'n=' + imgs.length + ' ' + imgs.map(function (i) { return String(i.getAttribute('src')).slice(0, 26); }).join(' | ');
      })());
    // 向导与弹层共用同一个矩阵组件 ⇒ 看大图的能力必须**两处都有**（差异只走 props）。
    // ⭐ 向导特有的坑：回落行（没采到色图，显示的是商品主图）也长着图、也能点开 —— 弹层必须写明
    //    "这是回落的主图、保存不会拿它当色图"，否则人会以为这一色的色图就是这样。
    report('⭐ 向导里两行都能点开看大图（回落主图那行也算 —— "有图就能看"是同一套行为，不按来源分叉）',
      all('[data-act="iw-sku-thumb"]').length === 2,
      'thumbs=' + all('[data-act="iw-sku-thumb"]').length);
    all('[data-act="iw-sku-thumb"]')[1].click();
    await settle(function () { return !!document.querySelector('[data-act="iw-sku-viewer-img"]'); }, 4000);
    report('⭐ 回落那行的大图写明来源是商品主图 + 保存不会拿它当色图（不让人把主图误认成色图）',
      flat(document.querySelector('[data-act="iw-sku-viewer-src"]')) === '商品主图（回落）' &&
        flat(document.querySelector('[data-act="iw-sku-viewer"]')).indexOf('不会拿它当色图') >= 0 &&
        document.querySelector('[data-act="iw-sku-viewer-img"]').getAttribute('src') === window.__smokeImg.item,
      'src=' + flat(document.querySelector('[data-act="iw-sku-viewer-src"]')));
    document.querySelector('[data-act="iw-sku-viewer-close"]').click();
    await settle(function () { return !document.querySelector('[data-act="iw-sku-viewer"]'); }, 4000);
    report('关掉大图后向导还在（下一步要接着填克重 —— 关错一层会把这步后面全带红）',
      !document.querySelector('[data-act="iw-sku-viewer"]') && !!document.querySelector('[data-act="iw-save"]'),
      'viewer=' + !!document.querySelector('[data-act="iw-sku-viewer"]'));
    // 拖色的手柄就是**色图本身**，而色图裹在 button 里（为了能点开看大图）。
    // 上一版 onChipDown 写的是 closest("input,button") ⇒ 凡是有色图的色整条都拖不动，
    // 只剩没采到图的空色块能动 —— 用户看到的就是「根本没办法操作」。
    // 这条只有在向导里守得住：产品抽屉的款色没有色图，压根渲染不出这个 button。
    var dragThumb = document.querySelector('[data-act="iw-sku-thumb"]');
    if (dragThumb) {
      var dragThumbRect = dragThumb.getBoundingClientRect();
      var dragColorsBox = document.querySelector('.iw-sku .mx-colors');
      var dragX = dragThumbRect.left + dragThumbRect.width / 2;
      var dragY = dragThumbRect.top + dragThumbRect.height / 2;
      function pevDrag(type, x, y) {
        return new PointerEvent(type, {
          bubbles: true, cancelable: true, clientX: x, clientY: y,
          pointerId: 1, isPrimary: true, pointerType: 'mouse',
        });
      }
      // 位移 30px 但不出这一个 chip：落点仍是源行自己 ⇒ dragOver 为空 ⇒ 松手什么都不做。
      // 这样只验"能不能起拖"，不拿数据开玩笑。
      var colorsBeforeDrag = all('[data-act="iw-sku-color"]').map(function (i) { return i.value; }).join('/');
      dragThumb.dispatchEvent(pevDrag('pointerdown', dragX, dragY));
      dragColorsBox.dispatchEvent(pevDrag('pointermove', dragX + 12, dragY));
      dragColorsBox.dispatchEvent(pevDrag('pointermove', dragX + 30, dragY + 2));
      // 必须等一拍再读 class：Vue 的 DOM 更新是异步的，派发完立刻读永远是"没变"
      // （这条曾经让我误判修复无效 —— 探针的时序错和产品代码的错长得一模一样）。
      await settle(function () { return !!document.querySelector('.iw-sku .mx-color.is-src'); }, 400);
      var startedFromImg = !!document.querySelector('.iw-sku .mx-color.is-src');
      dragColorsBox.dispatchEvent(pevDrag('pointerup', dragX + 30, dragY + 2));
      await settle(function () { return false; }, 150);
      report('⭐ 从色图上按住就能拖（色图裹在 button 里，按钮不能被当成"该让位"的控件）',
        startedFromImg, 'is-src=' + startedFromImg + ' target=' + ((dragThumb.querySelector('img') || {}).tagName || '?'));
      report('这次拖动没改数据、也没弹出大图（松手落在源行自己身上 = 什么都不做）',
        all('[data-act="iw-sku-color"]').map(function (i) { return i.value; }).join('/') === colorsBeforeDrag &&
          !document.querySelector('[data-act="iw-sku-viewer"]'),
        'colors=' + all('[data-act="iw-sku-color"]').map(function (i) { return i.value; }).join('/') +
          ' viewer=' + !!document.querySelector('[data-act="iw-sku-viewer"]'));
    } else {
      report('向导里应至少有一个色图按钮（"从色图起拖"这条保底路径没有落点）', false, 'thumb=missing');
    }
    report('认不出标准色名的行被高亮 + 给出促确认说明（数字色号 4；黑已归一故不高亮）',
      (function () {
        var flagged = document.querySelectorAll('.iw-sku tr.is-flagged').length;
        var note = document.querySelector('[data-act="iw-flag-note"]');
        return flagged === 1 && !!note && flat(note).indexOf('1') >= 0;
      })(),
      'flagged=' + document.querySelectorAll('.iw-sku tr.is-flagged').length);
    report('没选供应商时保存不可点（建档必须知道找谁拿货）',
      document.querySelector('[data-act="iw-save"]').disabled, 'disabled=true');
    setVal(document.querySelector('[data-act="iw-supplier"]'), '7');
    await settle(function () { return !document.querySelector('[data-act="iw-save"]').disabled; }, 4000);
    report('选了供应商后保存可点', !document.querySelector('[data-act="iw-save"]').disabled, '');
    // 把数字色号改成标准色名 → 高亮当场消失（促确认是活判据，不是贴上去的静态样式）。
    // ⚠️ 色名输入 2026-10-17 搬到了上面的「规格」卡片里（不再在矩阵 tr 内），
    //    所以定位走"被高亮的卡片里的那个输入框"；矩阵行的高亮照旧（同一判据两个显示位置）。
    setVal(document.querySelector('.iw-sku .is-flagged [data-act="iw-sku-color"]'), '黑');
    await settle(function () { return document.querySelectorAll('.iw-sku tr.is-flagged').length === 0; }, 4000);
    report('把数字色号改成标准色名后高亮消失（人对色号有最终裁判权）',
      document.querySelectorAll('.iw-sku tr.is-flagged').length === 0,
      'flagged=' + document.querySelectorAll('.iw-sku tr.is-flagged').length);
    // 克重人补：矩阵里那两格各一个数字输入框（黑/L、黑/M）。**填一个、留一个** ——
    // 只喂一个输入的话，"没填的也被写成某个值"这种错永远看不出来。
    // ⚠️ 必须按"存在的格"取下标（data-cell-on）：空格也是真输入框了，
    //    按下标数会喂到空格上，等于凭空多造一条 SKU。
    var wExistCells = all('[data-act="iw-sku-weight"][data-cell-on="1"]');
    setVal(wExistCells[1], '88');
    document.querySelector('[data-act="iw-save"]').click();
    await waitFor(function () { return calls('productUpsert').length >= 1; }, 6000);
    var wUp = (calls('productUpsert')[0] || {});
    report('⭐ 建档走既有 product-upsert：编码用系统发号、预填名/类目/供应商透传（不发明第二套建档口径）',
      wUp.code === 'STYLE-042' && wUp.name === '折叠收纳箱 60L 蓝色' &&
      wUp.category === '收纳' && Number(wUp.supplierId) === 7,
      JSON.stringify(wUp));
    // ⚠️ 必须等 variantList 落地再断言：向导的三连是 await 串行的，建档那次的调用一记录
    //    就往下跑断言的话，查既有行那次还没发生（实测：asked=[] 是时序假象，不是没查）。
    await waitFor(function () { return calls('productVariantList').length >= 1; }, 6000);
    var wVid = (calls('productVariantList')[0] || {}).productIds || [];
    report('写 SKU 前先查既有行（重入时按 color+size 匹配走更新路径，不撞唯一键）',
      calls('productVariantList').some(function (c) { return (c.productIds || []).length === 1; }),
      'asked=' + JSON.stringify(wVid) + ' all=' + JSON.stringify(calls('productVariantList')));
    await waitFor(function () { return calls('productVariantUpsert').length >= 2; }, 6000);
    var wVs = calls('productVariantUpsert');
    report('SKU 行走既有 product-variant-upsert：两行（黑 L / 黑 M）、按**行序 × 列序**展开',
      wVs.length === 2 &&
      wVs.every(function (v) { return Number(v.productId) > 0 && v.color === '黑'; }) &&
      wVs.map(function (v) { return v.size; }).join('/') === 'L/M',
      JSON.stringify(wVs.map(function (v) { return { c: v.color, s: v.size, w: v.weightG }; })));
    report('⭐ 克重按**格**透传：填了的那格 = 88、没填的是 0（矩阵化后克重不能还挂在"行"上）',
      Number(wVs[1].weightG) === 88 && Number(wVs[0].weightG) === 0,
      JSON.stringify(wVs.map(function (v) { return v.weightG; })));
    await waitFor(function () { return calls('productSkuMap').length >= 1; }, 6000);
    var wMap = ((calls('productSkuMap')[0] || {}).rows || [])[0] || {};
    report('⭐ 认款走**同一条** productSkuMap 写路径，落到刚建档的那一款（平台从快照行带出）',
      wMap.platform === 'shopee' && wMap.shopId === 11 && wMap.itemId === '1005001234567890' &&
      Number(wMap.productId) > 0 && wMap.status === 'confirmed',
      JSON.stringify(wMap));
    // 第④步（图片采纳）排在认款之后：色图要挂到款色上，款色按款编码定位，编码来自刚建档的产品行。
    // ⚠️ 两行都改成了"黑"（上面把数字色号 4 改成了标准色名）⇒ 色图只发一条、且用的是**人确认后的色名**
    //    （采纳绑的款色必须与写进 pl_variants 的色是同一个，订单归色才认得上）。
    await waitFor(function () { return calls('shopItemImageFetch').length >= 1; }, 6000);
    var wImg = calls('shopItemImageFetch')[0] || {};
    report('⭐ 主图/色图采纳走 shop-item-image-fetch：采集行 id + 刚建档的产品 + 勾选语义 + 去重后的每色图',
      Number(wImg.id) === 7001 && Number(wImg.productId) > 0 && wImg.adoptMain === true &&
      (wImg.colors || []).length === 1 &&
      wImg.colors[0].color === '黑' && wImg.colors[0].imageUrl === window.__smokeImg.itemSku,
      JSON.stringify(wImg));
    await settle(function () { return !!document.querySelector('[data-act="iw-receipt"]'); }, 6000);
    report('结构化回执说清三件事：建档编码 / 写了几条 SKU / 关联结果（不是一句"成功"）',
      (function () {
        var r = document.querySelector('[data-act="iw-receipt"]');
        return !!r && flat(r).indexOf('STYLE-042') >= 0 && flat(r).indexOf('2') >= 0 &&
          flat(r).indexOf('已关联') >= 0;
      })(),
      flat(document.querySelector('[data-act="iw-receipt"]')).slice(0, 80));
    report('回执说清图片采纳结果：主图已采纳 + 色图绑定 1 张（失败/跳过同样要说，不一句带过）',
      (function () {
        var r = document.querySelector('[data-act="iw-receipt"]');
        var img = document.querySelector('[data-act="iw-receipt-img"]');
        return !!r && !!img && flat(img).indexOf('主图已采纳') >= 0 &&
          flat(r).indexOf('色图绑定 1 张') >= 0;
      })(),
      (function () { var r = document.querySelector('[data-act="iw-receipt"]'); return r ? flat(r).slice(-46) : 'missing'; })());
    // 建档并关联后，该行**从本段消失**（本段恒列未认款，没有"翻状态"这一态）——
    // 同一结果去「已建立映射」看：三个输入源在表上看得见同一条映射（新编码 STYLE-042）。
    // 不去 mapped 看一眼的话，"从本段消失"可能被实现成"凭空不见了"。
    await settle(function () { return !itemRow('1005001234567890'); }, 6000);
    // ⚠️ 映射表只在 sub==='mapped' 时在 DOM 里 —— 断言前必须切过去（不切就恒 missing，
    //    "行还在不在映射表里"这件事永远验不到）。抽屉是浮层、不随分段切走。
    await clickText('[data-act="sub-mapped"]', '已认');
    await settle(function () { return !!mappedRow('1005001234567890'); }, 6000);
    report('⭐ 建档并关联后采集行从本段消失，并出现在「已建立映射」里（STYLE-042）',
      !itemRow('1005001234567890') && !!mappedRow('1005001234567890') &&
        flat(mappedRow('1005001234567890')).indexOf('STYLE-042') >= 0,
      mappedRow('1005001234567890') ? flat(mappedRow('1005001234567890')).slice(0, 60) : 'missing');
    // 切回本段：下面的第二遍（关抽屉 → 复位 → 重新勾选）建立在"停在 items 段"上
    await setPendingOrigin('scrape');

    // ── 第二遍：**不勾**「采纳为款主图」────────────────────────────────────────
    // 为什么必须有这一遍：第一遍勾选默认就是勾的 ⇒ "勾选根本没接进载荷"这个错在默认态下
    // 永远看不出来（回执照样显示"主图已采纳"）。喂第二个"应结果不同"的输入才能让它变红。
    var wizClose = document.querySelector('[data-act="iw-close"]');
    report('提交后向导仍开着（回执读完了才该关；自己消失等于把回执也带走）',
      !!wizClose && !!document.querySelector('[data-act="iw-save"]'),
      'close=' + !!wizClose + ' save=' + !!document.querySelector('[data-act="iw-save"]'));
    if (wizClose) wizClose.click();
    await settle(function () { return !document.querySelector('[data-act="iw-save"]'); }, 4000);
    window.__smokeReset();
    await clickText('[data-act="map-refresh"]', '刷新');
    // ⚠️ 2026-10-25（P2）：同前提 —— 合并段不再逐行写「未认款」，判据改为"可勾选"
    await settle(function () {
      var r = itemRow('1005001234567890');
      return !!r && !!r.querySelector('input[type="checkbox"]:not([disabled])');
    }, 8000);
    var b2Row = itemRow('1005001234567890');
    var b2Box = b2Row ? b2Row.querySelector('input[type="checkbox"]') : null;
    // ⚠️ 判据里必须有「!b2Box.checked」：第一遍是用向导认掉的，向导走的是自己那条
    //    createProductFromItem（commitMap 之后必须把这一行的 key 从合并段选择集里摘掉）。
    //    残留的话这一行复位后就渲染成**已勾选**，下面那次 click 会变成"取消勾选" ——
    //    症状是"点了却没反应"，而根因在上一遍的写入路径里。
    report('第二遍前置：7001 回到待认清单、可勾选、且**不是勾选态**（上一次写入没在选择集里留 key）',
      !!b2Box && !b2Box.disabled && !b2Box.checked,
      'row=' + !!b2Row + ' box=' + !!b2Box +
        ' disabled=' + (b2Box ? b2Box.disabled : 'n/a') +
        ' checked=' + (b2Box ? String(b2Box.checked) : 'n/a') +
        ' rows=' + all('[data-act="pending-table"] tbody tr[data-item-id]')
          .map(function (r) { return String(r.getAttribute('data-item-id')); }).join(','));
    var b2Check = await checkPendingRow('1005001234567890', '第二遍');
    report('第二遍：勾一行后计数真的变成「已选 1 项」（勾选接到了合并段的选择集上）',
      b2Check.ok, JSON.stringify(b2Check));
    await settle(function () {
      var b = document.querySelector('[data-act="items-new-product"]');
      return !!b && !b.disabled;
    }, 4000);
    var b2New = document.querySelector('[data-act="items-new-product"]');
    report('第二遍：勾一行后「新建款并关联」可点', !!b2New && !b2New.disabled,
      'btn=' + !!b2New + ' selcount=' + flat(document.querySelector('[data-act="pending-selcount"]')));
    if (b2New) b2New.click();
    await settle(function () { return !!document.querySelector('[data-act="iw-save"]'); }, 8000);
    document.querySelector('[data-act="iw-adopt-image"]').click(); // 取消勾选（色图照采照绑）
    setVal(document.querySelector('[data-act="iw-supplier"]'), '7');
    await settle(function () { return !document.querySelector('[data-act="iw-save"]').disabled; }, 4000);
    document.querySelector('[data-act="iw-save"]').click();
    await waitFor(function () { return calls('shopItemImageFetch').length >= 1; }, 8000);
    var wImg2 = calls('shopItemImageFetch')[0] || {};
    report('不勾「采纳为款主图」：载荷 adoptMain=false（勾选不是装饰品），每色图照发',
      wImg2.adoptMain === false && (wImg2.colors || []).length === 1,
      JSON.stringify(wImg2));
    await settle(function () { return !!document.querySelector('[data-act="iw-receipt"]'); }, 6000);
    report('没勾采纳时回执**不**出现"主图已采纳"（不回没说做过的话）',
      !document.querySelector('[data-act="iw-receipt-img"]') &&
      !document.querySelector('[data-act="iw-receipt-img-fail"]'),
      (function () { var r = document.querySelector('[data-act="iw-receipt"]'); return r ? flat(r).slice(-40) : 'missing'; })());

    // ── 第三遍：主图下载失败 + 色图"该色已有图"─────────────────────────────────
    // 两条边界一次看全：① 用户点过的"采纳主图"失败必须**可见**（mainError 进回执）；
    // ② 但它不外抛成异常 —— 款与商品已经成立，错误条一亮就像"什么都没建成"。
    document.querySelector('[data-act="iw-close"]').click();
    await settle(function () { return !document.querySelector('[data-act="iw-save"]'); }, 4000);
    window.__smokeReset();
    await clickText('[data-act="map-refresh"]', '刷新');
    // ⚠️ 2026-10-25（P2）：同前提 —— 判据从「行里写着未认款」改为「复选框可勾」
    await settle(function () {
      var r = itemRow('1005001234567890');
      return !!r && !!r.querySelector('input[type="checkbox"]:not([disabled])');
    }, 8000);
    window.__smokeImgFail = true;            // 主图下载失败（模拟网络错）
    window.__smokeColorMode = 'color-bound'; // 色图：目标款色已有图 ⇒ 只补空跳过
    // 同第二遍：判据取"勾选真的落到计数上"，不取"我点了一下"
    var b3Check = await checkPendingRow('1005001234567890', '第三遍');
    report('第三遍：复位后 7001 又能勾上（选择集里没有上一遍残留的 key）', b3Check.ok,
      JSON.stringify(b3Check));
    await settle(function () {
      var b = document.querySelector('[data-act="items-new-product"]');
      return !!b && !b.disabled;
    }, 4000);
    document.querySelector('[data-act="items-new-product"]').click();
    await settle(function () { return !!document.querySelector('[data-act="iw-save"]'); }, 8000);
    setVal(document.querySelector('[data-act="iw-supplier"]'), '7');
    await settle(function () { return !document.querySelector('[data-act="iw-save"]').disabled; }, 4000);
    document.querySelector('[data-act="iw-save"]').click();
    await waitFor(function () { return calls('shopItemImageFetch').length >= 1; }, 8000);
    await settle(function () { return !!document.querySelector('[data-act="iw-receipt"]'); }, 6000);
    report('⭐ 主图下载失败：回执写明"主图没设上（原因）"，且**不**弹错误条 —— 款与商品已经成立',
      (function () {
        var fail = document.querySelector('[data-act="iw-receipt-img-fail"]');
        return !!fail && flat(fail).indexOf('主图没设上') >= 0 && flat(fail).indexOf('图片下载失败') >= 0 &&
          !document.querySelector('[data-act="iw-error"]');
      })(),
      (function () { var f = document.querySelector('[data-act="iw-receipt-img-fail"]'); return f ? flat(f) : 'missing'; })());
    report('色图"该色已有图"时只补空跳过：回执按"跳过（不覆盖）"计数，不混进绑定数',
      (function () {
        var r = document.querySelector('[data-act="iw-receipt"]');
        return !!r && flat(r).indexOf('色图跳过 1 张') >= 0 && flat(r).indexOf('不覆盖') >= 0 &&
          flat(r).indexOf('色图绑定') < 0;
      })(),
      (function () { var r = document.querySelector('[data-act="iw-receipt"]'); return r ? flat(r).slice(-52) : 'missing'; })());
    // 场景开关复位（本步之后的 errors 断言不该被它们影响）
    window.__smokeImgFail = false;
    window.__smokeColorMode = '';

    // ── 手贴商品ID导入（保底通道；P5）────────────────────────────────
    // 扩展选择器全落空时，从后台复制商品ID贴进来，走与采集帧同一个写路径（source=manual）。
    step('item-manual-import');
    window.__smokeReset();
    await setPendingOrigin('scrape');
    await settle(function () { return !!document.querySelector('[data-act="items-manual-import"]'); }, 6000);
    document.querySelector('[data-act="items-manual-import"]').click();
    await settle(function () { return !!document.querySelector('[data-act="manual-import"]'); }, 6000);
    report('保底通道入口：点「手贴商品ID」弹出导入框',
      !!document.querySelector('[data-act="manual-import"]'), '');
    var shopSel = document.querySelector('[data-act="manual-import-shop"]');
    report('归属店铺默认=未登记桶（shopId=0，落未登记桶而非渲染层拼一个假 store）',
      !!shopSel && Number(shopSel.value) === 0, 'shopId=' + (shopSel ? shopSel.value : 'missing'));

    // 空输入：应当报校验错、不调 IPC、框不关
    document.querySelector('[data-act="manual-import-submit"]').click();
    await sleep(120);
    report('空输入不调 IPC（保底通道不能把空串当成一条 ID 落库）',
      calls('shopItemsImport').length === 0 && !!document.querySelector('[data-act="manual-import-error"]'),
      'calls=' + calls('shopItemsImport').length);

    // 填三行（逗号 + 换行混合，含重复），提交
    var ta = document.querySelector('[data-act="manual-import-text"]');
    setVal(ta, '999000111, 999000222\\n999000333\\n999000222');
    document.querySelector('[data-act="manual-import-submit"]').click();
    await waitFor(function () { return calls('shopItemsImport').length >= 1; }, 8000);
    report('导入调用把三行 ID 透传（逗号/换行切分 + 去重，shopId 透 0）',
      (function () {
        var c = calls('shopItemsImport');
        if (!c.length) return false;
        var last = c[c.length - 1];
        var ids = (last.ids || []).slice().sort();
        return last.shopId === 0 && ids.length === 3 &&
          ids.join(',') === ['999000111', '999000222', '999000333'].join(',');
      })(),
      'calls=' + JSON.stringify(calls('shopItemsImport').map(function (c) { return { s: c.shopId, n: (c.ids || []).length }; })));
    // 导入后重新拉列表 → 三行新商品出现（落库即后续认款可消费）
    await settle(function () {
      var rows = all('[data-act="pending-table"] tbody tr[data-item-id]');
      var ids = rows.map(function (r) { return String(r.getAttribute('data-item-id')); });
      return ids.indexOf('999000111') >= 0 && ids.indexOf('999000222') >= 0 && ids.indexOf('999000333') >= 0;
    }, 6000);
    report('导入后列表出现这三行（保底通道与采集帧同一写路径，落库即可认款）',
      (function () {
        var rows = all('[data-act="pending-table"] tbody tr[data-item-id]');
        var ids = rows.map(function (r) { return String(r.getAttribute('data-item-id')); });
        return ids.indexOf('999000111') >= 0 && ids.indexOf('999000222') >= 0 && ids.indexOf('999000333') >= 0;
      })(),
      'rows=' + JSON.stringify(all('[data-act="pending-table"] tbody tr[data-item-id]').map(function (r) { return r.getAttribute('data-item-id'); })));
    // 提交成功框应自动关闭
    report('导入成功框自动关闭（不残留蒙层挡住后续操作）',
      !document.querySelector('[data-act="manual-import"]'), '');

    // ── 零采集时保底通道入口仍可达（退路不能只在"有数据"时出现）──────────────
    // 采集工具条整条被 itemStats.total > 0 挡着 ⇒ 退路若只挂在那边，"一条都没采到"
    // （正是扩展选择器全落空、最需要保底通道的时刻）反而点不到。这一段把零样本造出来钉住它。
    step('item-manual-import-empty');
    // ⚠️⚠️ 两个残留模态都要先关掉，**而且 .click() 看不见它们**：
    //    ① 建款向导抽屉（前一步留在打开状态）；
    //    ② 「导入产品」弹层 —— import 那一步打开它之后**整段没关**（实测命中栈：
    //       DIV.wb-dialog__body im-body > DIV.wb-dialog > DIV.wb-mask > … > 保底入口）。
    //    模态的蒙层 wb-mask 盖住它后面所有元素，后续 step 的 .click() 又绕过命中测试，
    //    于是**一路"绿"**，直到本步的可达性断言（走 elementFromPoint）才把污染暴露出来 ——
    //    那时红的是可达性，看着却像布局坏了。判据：covered-by 栈里有没有 wb-mask / wb-dialog。
    var iwX = document.querySelector('[data-act="iw-close"]');
    if (iwX) { iwX.click(); await sleep(150); }
    var impX = document.querySelector('[data-act="import-close"]');
    if (impX) { impX.click(); await sleep(150); }
    report('前一步的残留模态已清空（导入弹层 + 建款抽屉；可达性断言的前置条件）',
      !document.querySelector('.wb-mask'),
      'masks=' + all('.wb-mask').map(function (m) { return m.getAttribute('data-act') || m.querySelector('.wb-dialog').getAttribute('aria-label'); }).join('/'));
    window.__smokeEmptyItems = true;
    // ⚠️ 2026-10-25（P2）：合并段常驻 ⇒ 改「来源」筛选**不再触发重拉**（只有切分段才拉）。
    //    夹具把"库"翻空了，必须显式刷新一次才会到界面；否则等的是永远不会出现的空态。
    //    同时把来源筛到「采集」：否则"采集侧没有行"会被筛选本身弄成恒真（空判据）。
    await setPendingOrigin('scrape');
    await clickText('[data-act="map-refresh"]', '刷新');
    await settle(function () { return !!document.querySelector('.gd-panel__empty'); }, 8000);
    // ⚠️ 判据从"表不存在"改为"采集侧没有任何待认行"：两源合并后订单行还在这张表里，
    //    "表在不在"已经分不清"零采集"了 —— 该守的是"零采集时给接入引导 + 采集侧不摆空行"。
    report('零采集时给的是接入引导（不是一张空采集表）',
      !!document.querySelector('.gd-panel__empty') &&
        flat(document.querySelector('.gd-panel__empty')).indexOf('还没有采集过店铺商品') >= 0 &&
        all('[data-act="pending-table"] tbody tr[data-origin="scrape"]').length === 0,
      'empty=' + !!document.querySelector('.gd-panel__empty') +
        ' scrapeRows=' + all('[data-act="pending-table"] tbody tr[data-origin="scrape"]').length);
    var emptyEntry = reportReachable('⭐ 零采集时保底通道入口仍可达（退路不能只在"有数据"时出现）',
      '[data-act="items-manual-import-empty"]');
    if (emptyEntry) emptyEntry.click();
    await settle(function () { return !!document.querySelector('[data-act="manual-import"]'); }, 6000);
    report('零采集时点「手贴商品ID」同样弹出导入框（空态那个不是摆设）',
      !!document.querySelector('[data-act="manual-import"]'), '');
    var miCancel = document.querySelector('[data-act="manual-import-cancel"]');
    if (miCancel) miCancel.click();
    await sleep(80);
    window.__smokeEmptyItems = false;
    await clickText('[data-act="map-refresh"]', '刷新');
    await setPendingOrigin('order');

    // ── 采集落库广播：扩展是**外部进程**写库，页面停在原地也必须看到 ────────────────
    // 用户实测场景（2026-10-15）：先在页面上打开过「待关联采集商品」，再用 Chrome 扩展采集 ——
    // 库里有 8 条，页面却永远停在旧状态（不报错、没有任何提示，表现为"采集了却没数据"）。
    // 修法 = 主进程落库后广播 ae-items-ingested，页面收到后自己重拉。这一段把
    // "**只有广播**能带来变化"钉住：全程不点刷新/重拉按钮，数据只能靠事件进来。
    // 夹具的"库"用 __smokeEmptyItems 空↔非空翻转（与保底通道那一段同一个开关）。
    step('ingest-broadcast');
    /** 「待认」分段徽标的数字（null = 徽标不存在）。合并段徽标报的是**全部**待认数 */
    function pendingBadgeNum() {
      var b = document.querySelector('[data-act="sub-pending"] .wb-seg__badge');
      if (!b) return null;
      var n = parseInt(flat(b).replace(/[^0-9]/g, ''), 10);
      return isNaN(n) ? null : n;
    }
    function scrapeRows() { return all('[data-act="pending-table"] tbody tr[data-origin="scrape"]'); }
    // ① 库先造空：此刻采集侧没有待认行（下一步"数据自己出来"才有判别力 ——
    //    不钉前置态的话，行可能本来就在，事件那条断言恒绿）。
    //    ⚠️ 先把来源筛到「采集」：筛选留着「订单」时 scrapeRows() 恒为 0，
    //    那条"采集侧没有行"就成了永远成立的空判据。
    await setPendingOrigin('scrape');
    window.__smokeEmptyItems = true;
    await clickText('[data-act="map-refresh"]', '刷新');
    await settle(function () { return !!document.querySelector('.gd-panel__empty'); }, 8000);
    report('广播前置：零采集快照下采集侧没有任何待认行（给的是接入引导）',
      !!document.querySelector('.gd-panel__empty') && scrapeRows().length === 0,
      'empty=' + !!document.querySelector('.gd-panel__empty') + ' scrapeRows=' + scrapeRows().length);
    // ② 库翻回非空 + 发广播（**不点任何按钮**）：采集行必须自己出来
    window.__smokeEmptyItems = false;
    var bcList0 = calls('shopItemsList').length;
    window.__smokeEmitAeItems({ received: 3, inserted: 3, updated: 0, skipped: 0, at: new Date().toISOString() });
    await settle(function () {
      return scrapeRows().length > 0 && calls('shopItemsList').length > bcList0;
    }, 8000);
    report('⭐ 采集落库广播后，停在这一屏的页面没点任何按钮就出数据',
      scrapeRows().length > 0 && calls('shopItemsList').length > bcList0,
      'scrapeRows=' + scrapeRows().length + ' list=' + bcList0 + '->' + calls('shopItemsList').length);
    // ③ 停在「已认」段：广播只刷汇总/徽标、**不动当前列表** —— 后台重拉不打乱用户眼前这一屏。
    //    ⚠️ 2026-10-25（P2）：合并后面板里"换来源筛选"只是筛选、不是换段 ⇒ 停在待认段时
    //    广播本来就该重拉列表（那是 ② 的契约）。"不动列表"只能在**不处于待认段**时验。
    await clickText('[data-act="sub-mapped"]', '已认');
    await settle(function () { return !!document.querySelector('[data-act="mapped-table"]'); }, 6000);
    var bcSum0 = calls('shopItemsSummary').length;
    var bcList1 = calls('shopItemsList').length;
    var bcBadge0 = pendingBadgeNum();
    window.__smokeEmptyItems = true;
    window.__smokeEmitAeItems({ received: 1, inserted: 1, updated: 0, skipped: 0, at: new Date().toISOString() });
    await settle(function () { return pendingBadgeNum() !== null && pendingBadgeNum() < bcBadge0; }, 6000);
    report('停在「已认」段时广播只刷汇总徽标（当前列表不动 —— 后台重拉不打乱用户眼前这一屏）',
      calls('shopItemsSummary').length > bcSum0 &&
        calls('shopItemsList').length === bcList1 &&
        pendingBadgeNum() !== null && pendingBadgeNum() < bcBadge0,
      'sum=' + bcSum0 + '->' + calls('shopItemsSummary').length +
        ' list=' + bcList1 + '->' + calls('shopItemsList').length +
        ' badge=' + bcBadge0 + '->' + pendingBadgeNum());
    window.__smokeEmptyItems = false;
    window.__smokeEmitAeItems({ received: 2, inserted: 2, updated: 0, skipped: 0, at: new Date().toISOString() });
    await settle(function () { return pendingBadgeNum() === bcBadge0; }, 4000);
    report('库翻回非空后徽标数字回到原值（同一条通道正反两个方向都钉住）',
      pendingBadgeNum() === bcBadge0 && calls('shopItemsList').length === bcList1,
      'badge=' + pendingBadgeNum() + '（原 ' + bcBadge0 + '） list=' + bcList1 + '->' + calls('shopItemsList').length);
    // 回「待认」段（下一步要在这张表上验列结构 / 只读 SKU / 删除）
    await clickText('[data-act="sub-pending"]', '待认');
    await settle(function () { return !!document.querySelector('[data-act="pending-table"]'); }, 6000);
    await setPendingOrigin('scrape');
    await settle(function () { return scrapeRows().length > 0; }, 6000);

    // ── 「待关联采集商品」表列结构 + SKU 只读展示 + 行内删除（2026-10-16 用户口径）──
    // 用户三件事：① 售价整列去掉；② 「商品」列改名「商品ID」且不换行；
    // ③ SKU 要展示出来（原先只有一个条数）。
    // ⭐ 2026-10-23：SKU 矩阵的**唯一维护面是产品编辑抽屉**（采集段只认款）——
    //    这一列降为只读文本，本步反过来钉住"这里没有任何编辑入口"。
    // ⭐ 唯一标识口径（用户问"同一个商品采集多次会不会多条"）：唯一键是
    //    (shop_id, store_key, item_id) 三元组 —— 同店重复采集是**同一条行更新**；
    //    同一商品ID 在两家店 / 未登记桶下各是一行。删除按**行 id**（7003），
    //    删完 7001 必须还在（按 item_id 删会误删别家那份）。
    // ⚠️ 本段恒列未认款 ⇒ 7002（已认款）不在表里，"未采集"样本与删除目标都换成 7003。
    step('item-sku-readonly');
    window.__smokeReset();
    await setPendingOrigin('scrape');
    await settle(function () { return all('[data-act="pending-table"] tbody tr[data-item-id]').length === 2; }, 8000);
    var iThs = all('[data-act="pending-table"] thead th').map(function (th) { return flat(th); });
    // ⭐ 2026-10-25（P2）：六列压成四列（勾选 / 图 / 商品ID·店铺 / 操作）—— 两源共用一套列是
    // 合并的前提。**售价那一列仍然不存在**（这条断言原本守的就是它），SKU 与采集时间折进副行。
    report('售价整列撤掉，且压成四列（勾选/图/商品ID·店铺/操作）—— 两源共用一套列',
      iThs.length === 4 && iThs.indexOf('售价') < 0 &&
        iThs.some(function (h) { return h.indexOf('商品ID') >= 0; }),
      'cols=' + JSON.stringify(iThs));
    var idSpan = document.querySelector('[data-act="pending-table"] [data-act="pending-item-id"]');
    var idTd = idSpan ? idSpan.closest('td') : null;
    // 判据换成**ID 元素自己**的单行高：合并表的 td 允许换行（副行要折），
    // 原先"拿采集时间 td 当高度基准"的写法也随之失效（那一列已经折进副行）。
    // 守的东西没变：16 位 ID 折成两行会把整行撑高、且更难读。
    report('商品ID 单行不折（nowrap + 省略号；16 位 ID 折两行会把行高撑起来）',
      !!idSpan && getComputedStyle(idSpan).whiteSpace === 'nowrap' &&
        idSpan.getBoundingClientRect().height <= 24 &&
        !!idSpan.getAttribute('title'),
      'ws=' + (idSpan ? getComputedStyle(idSpan).whiteSpace : 'missing') +
        ' h=' + (idSpan ? Math.round(idSpan.getBoundingClientRect().height) : 'missing') +
        ' td=' + (idTd ? Math.round(idTd.getBoundingClientRect().height) : 'missing') +
        ' title=' + (idSpan ? idSpan.getAttribute('title') : 'missing'));
    var rA2 = itemRow('1005001234567890');
    // ⭐ 2026-10-28（用户口径"SKU 不要全部列出来"）：副行只报**条数**，色码全文降为 title。
    // 守两件事：① 可见文本里不能再出现色码串（那一串会把副行撑成两行 = "展示不全"）；
    //           ② 全文仍在 title 里（认款时要核对的证据不能因为"精简"而丢）。
    var skuCount = rA2.querySelector('[data-act="pending-sku-count"]');
    var skuCountTitle = skuCount ? (skuCount.getAttribute('title') || '') : '';
    report('SKU 只展示条数（7001 采到两行 ⇒「SKU 2 条」），色码全文进 title 不摊在副行',
      !!skuCount && flat(skuCount).indexOf('SKU 2 条') >= 0 &&
        flat(skuCount).indexOf('黑/L') < 0 &&
        skuCountTitle.indexOf('黑/L、4/M') >= 0,
      'text=' + (skuCount ? flat(skuCount) : 'missing') + ' title=' + skuCountTitle);
    report('没采到矩阵的行只显示「未采集」（列表轻采/手贴行没有矩阵）',
      !!itemRow('1005009876543210').querySelector('[data-act="pending-sku-empty"]'),
      'empty=' + !!itemRow('1005009876543210').querySelector('[data-act="pending-sku-empty"]'));
    report('⭐ 采集段没有任何 SKU 编辑入口（「改 / 补」已撤 —— 矩阵只在产品编辑抽屉里维护）',
      !document.querySelector('[data-act="i-sku-edit"]') &&
        !document.querySelector('[data-act="i-sku-add"]') &&
        !document.querySelector('[data-act="se-save"]'),
      'edit=' + !!document.querySelector('[data-act="i-sku-edit"]') +
        ' add=' + !!document.querySelector('[data-act="i-sku-add"]') +
        ' save=' + !!document.querySelector('[data-act="se-save"]'));
    // 删除 7003（店铺未登记行）：确认弹层说清"映射不受影响"后真删
    itemRow('1005009876543210').querySelector('[data-act="i-row-delete"]').click();
    await settle(function () { return !!document.querySelector('[data-act="confirm-dialog"]'); }, 6000);
    report('删除前有确认弹层，且写明"认款映射不受影响 / 重新采集还会出现"',
      (function () {
        var d = document.querySelector('[data-act="confirm-dialog"]');
        return !!d && flat(d).indexOf('不受影响') >= 0 && flat(d).indexOf('再次出现') >= 0;
      })(),
      flat(document.querySelector('[data-act="confirm-dialog"]')).slice(0, 80));
    document.querySelector('[data-act="confirm-ok"]').click();
    await waitFor(function () { return calls('shopItemsDelete').length >= 1; }, 6000);
    report('⭐ 删除按**行 id**（唯一键是 shop_id+store_key+item_id 三元组，同商品多家店各一行）',
      Number((calls('shopItemsDelete')[0] || {}).id) === 7003,
      JSON.stringify(calls('shopItemsDelete')[0] || {}));
    await settle(function () {
      var rows = all('[data-act="pending-table"] tbody tr[data-item-id]');
      return rows.length === 1 && !itemRow('1005009876543210');
    }, 6000);
    report('删完该行消失、另外一行还在（按 item_id 删会误删别店/未登记桶那份）',
      all('[data-act="pending-table"] tbody tr[data-item-id]').length === 1 &&
        !!itemRow('1005001234567890'),
      JSON.stringify(all('[data-act="pending-table"] tbody tr[data-item-id]').map(function (r) { return r.getAttribute('data-item-id'); })));
    // 取消路径：删除不是"点下就没了"，可取消
    itemRow('1005001234567890').querySelector('[data-act="i-row-delete"]').click();
    await settle(function () { return !!document.querySelector('[data-act="confirm-dialog"]'); }, 6000);
    document.querySelector('[data-act="confirm-cancel"]').click();
    await settle(function () { return !document.querySelector('[data-act="confirm-dialog"]'); }, 4000);
    report('取消删除：行还在、没调 IPC（删除可逆印象不能靠"赌用户不点"）',
      !!itemRow('1005001234567890') && calls('shopItemsDelete').length === 1,
      'calls=' + calls('shopItemsDelete').length);
    // 残留模态清空（下一步 errors 前的前提，同 item-manual-import-empty 的纪律）
    report('本步收尾：无残留模态（编辑/确认弹层都已关）',
      !document.querySelector('.wb-mask'),
      'masks=' + all('.wb-mask').length);

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
//   IMP-1  尺码 2 个 / 克重写 `120,`（第二个留空）—— 顺序对应 + "空格位是有意义的位置"这条；
//          另带一个进价 `12.34` —— 验「进价随行发到 items、且落库前换算成**分**」
//   IMP-2  只填尺码不填克重 —— 合法（0 = 没填），不该被当成错误
//   IMP-3  尺码 2 个 / 克重 **3 个** —— 对不上，必须标成"跳过"且**不**发去落库。
//          ⚠️ 2026-10-09：原先是「2 尺码 / 1 克重」，但同一天加的**克重广播**规则让
//          「1 个克重」变成合法（广播给所有尺码）—— 夹具必须跟着规则改，否则这条守卫
//          会因"行本来就合格"而恒绿（实为恒红，只是以前 dist 陈旧没跑出来）。
//   IMP-4（第 5 行）  款编码**留空** + 款式名取库里已存在的「款二」（S2）+ 供应商写一个**库里没有的**
//          「厂新」—— 一行同时验 2026-10-10 的两条新口径：① 同名款要把库里的编码**回显**出来
//          （留空却不是"自动生成 SUST-00x"，而是"沿用 S2"）；② 名字对不上的供应商会**自动新建**。
//          ⚠️ 款编码那一列是本轮用户报的"没有回显"—— 它的判据必须是"输入框里真的有值且看得见"
//          （`value` 非空 **且** `clientWidth` 不为 0），只看 innerText 会恒绿（input 没有文本节点）。
//
// ⚠️ 不在这份夹具里放图：嵌入图走的是主进程 exceljs（假桥 stub 了 `product-extract-images`），
//    真抽取由 `scripts/product-xlsx-smoke.cjs` 单独钉住。两段各管一头，各自可单独跑。
const XLSX_REQUIRE = createRequire(import.meta.url);
const XLSX_LIB = XLSX_REQUIRE(path.join(ROOT, 'node_modules', 'xlsx'));
const IMPORT_FIXTURE_AOA = [
  ['款编码', '款式名', '供应商', '进价(元)', '图片', '颜色', '尺码', '克重', '状态', '备注'],
  ['IMP-1', '导入款一', '厂A', '12.34', '', '红', 'M,L', '120,', '启用', ''],
  ['IMP-2', '导入款二', '厂A', '', '', '蓝', 'S', '', '启用', ''],
  ['IMP-3', '导入款三', '厂A', '', '', '白', 'S,T', '110,110,110', '启用', ''],
  ['', '款二', '厂新', '', '', '绿', 'L', '150', '启用', ''],
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
      '--enable-logging=stderr', '--log-level=0',
      `--window-size=${size}`,
      `--virtual-time-budget=${budget}`,
      '--dump-dom',
      `http://127.0.0.1:${PORT}/index.html?mode=${mode}`,
    ]);
    let out = '';
    let err = '';
    cp.stdout.on('data', (d) => (out += String(d)));
    // 页面里任何未捕获的异常都只在这里看得见（--dump-dom 只回 DOM，DOM 里没有堆栈）：
    // 冒烟"抓不到 #smoke-result"时要靠它区分"页面没挂载"和"注入脚本自己抛了"。
    cp.stderr.on('data', (d) => (err += String(d)));
    cp.on('error', reject);
    cp.on('close', () => {
      if (process.env.SMOKE_DEBUG && err) {
        console.error(err.split('\n').filter((l) => /ERROR|Uncaught|错误/.test(l)).slice(0, 25).join('\n'));
      }
      resolve(out);
    });
  });
  const m = dom.match(/id="smoke-result"[^>]*>([\s\S]*?)<\/pre>/);
  if (!m) return null;
  return m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
}

// `SMOKE_SIZE` 只是本地排查某个具体窗口尺寸用的开关（默认仍是 1440×900）——
// 2026-10-25「编码区被上面的组合压住」就是靠 `SMOKE_SIZE=1000,620` 把右栏压矮才复现的。
const passes = [
  { mode: 'full', size: process.env.SMOKE_SIZE || '1440,900', budget: 60000, label: '全量断言（宽 1440）' },
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
console.log(ok ? '\n✓ 产品/基础数据页冒烟通过（宽 + 默认窗口 + 窄，共三遍）' : '\n✗ 产品/基础数据页冒烟失败');
process.exit(ok ? 0 : 1);