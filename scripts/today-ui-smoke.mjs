// 「今天」首页的**假桥无头冒烟**（不启动宿主，不需要 Electron）。
//
//   npm run today:ui
//
// 为什么需要它：这一页是"新用户打开看到的第一屏"，它的错全是静默的 —— 数字取错源、按钮派发了错的事件、
// 空态没给动作，页面照样"看着正常"。断言纪律同 `picking:ui`：可验算的具体值 + **点击后断言事件出参**
// （点击出参是唯一能抓"点了没反应"的手段）。
//
// ⚠️ 注入脚本里的注释不能含反引号；改完 `node --check`。

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'renderer');
const WORK = path.join('/tmp', 'sellerkit-today-smoke');
const PORT = 8127;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

// 真实存在的模块 id —— 用来判"导入回执的下一步按钮有没有指向一个不存在的模块"。
// **从真来源读**（modules.config.json 的当前 profile），不在这里抄一份副本：
// 抄了的话，将来改配置这断言会恒绿（副本还停在旧清单上）。
const CFG = JSON.parse(readFileSync(path.join(ROOT, 'modules.config.json'), 'utf8'));
const KNOWN_MODULES = CFG.profiles[CFG.profile] ?? CFG.enabledModules;

// 「发货台」页内页签的 **id**（`flowCtx.SHIPPING_TAB_NAMES` 的键）—— 导入回执的"下一步"可以落在
// 本页的一个页签上（那时按钮是**就地切页签**，不跳模块）。**从真来源读**，理由同 KNOWN_MODULES：
// 抄一份副本的话，将来加/删页签这断言会恒绿（副本还停在旧清单上），而"点了没反应"照样漏过去。
const FLOW_CTX_SRC = readFileSync(path.join(ROOT, 'src/modules/today/flowCtx.ts'), 'utf8');
const TAB_BLOCK = /SHIPPING_TAB_NAMES\s*=\s*\{([\s\S]*?)\}\s*as const/.exec(FLOW_CTX_SRC);
const KNOWN_TABS = TAB_BLOCK ? [...TAB_BLOCK[1].matchAll(/(\w+)\s*:/g)].map((m) => m[1]) : [];

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error(`✗ 找不到构建产物 ${DIST}/index.html —— 先跑 npm run build`);
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error(`✗ 找不到无头 Chrome：${CHROME}`);
  process.exit(1);
}

// 用真实 xlsx 生成两份小工作簿（冒烟里不能凭空写数组：解析路径必须真的走一遍 xlsx）
const XLSX = (await import('xlsx')).default ?? (await import('xlsx'));
function makeXlsx(aoa, sheetName) {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(aoa), sheetName);
  return Buffer.from(XLSX.write(wb, { type: 'array', bookType: 'xlsx' })).toString('base64');
}
const XLSX_WEIGHTS = makeXlsx([['商品ID', '产品名称', '重量(g)'], ['ITEM9', '某款外套', '320']], '商品信息');
const XLSX_JUNK = makeXlsx([['foo', 'bar'], ['1', '2']], '随便一张表');
// 一份小订单报表（表头签名 = 订单号 + 订单金额/商品信息；行内含两个商品 → 装配时应拆成两行）
const XLSX_ORDERS = makeXlsx([
  ['订单号', '订单状态', '订单金额', '预计增值税', 'DDP关税', '平台是否代征代缴', '商品 ID', '商品信息', '收货国家', '下单时间'],
  ['O-1001', '等待发货', 'CN￥ 165.18', 'CN￥ 34.69', 'CN￥ 22.94', '平台已税', 'IT-A,IT-B',
   '【1】 A款 (商品数量:1 piece)\n【2】 B款 (商品数量:2 piece)', 'United States', '2026-09-20 10:00:00'],
], 'sheet1');

// 芒果店长「待发货订单」小样本：**自带店铺名 + 产品图片链接**（与上面的 AE 报表的区别就在这两列）。
// 它的 base64 **会被真的插进注入脚本**（`${XLSX_MANGO_B64}`）—— 用来验证"带图导入"的接线：
// 店铺名落到 orderInsert.shop、图片链接真的走了 orderDownloadImage、图 id 挂到订单行。
const XLSX_MANGO_B64 = makeXlsx([
  ['店铺名', '尺寸', '订单号', '下单时间', '产品信息', '产品数量', '产品图片链接', '产品ID', '产品总金额', '物流费用', '订单金额', '收货国家（中文）'],
  ['六店', 'XXXL', 'M-1001', '2026-10-04 16:55:46',
   '【1】A款 (产品属性:Size:XXXL,Color:1,Ships From:China Mainland)\n(产品数量:1 piece)',
   '1', 'https://img.example.com/a.jpg\n', 'IT-M1', 'CNY14.46', 'CNY77.59', '76.75', '德国'],
], 'sheet1');

const FAKE_BRIDGE = `<script>
(function () {
  var calls = {};
  window.__smokeCalls = calls;
  window.__events = [];
  function rec(name, payload) { (calls[name] = calls[name] || []).push(payload); }
  window.addEventListener('switch-module', function (e) { window.__events.push({ type: 'switch-module', detail: e.detail }); });
  window.addEventListener('open-settings', function (e) { window.__events.push({ type: 'open-settings', detail: e.detail }); });
  function daysAgo(n) {
    var d = new Date(); d.setDate(d.getDate() - n);
    var p = function (x) { return String(x).length < 2 ? '0' + x : String(x); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  /**
   * 按种子生成一条**内容不同**的极小图片 dataUrl（8x8 SVG，走 data: 前缀）。
   * 缩略图假桥若对所有路径回同一个 dataUrl，"两行显示的是不是同一张图"就永远验不出来
   * （2026-10-11 用户报"拿货单明细的图片都是一样的"——守卫必须能分辨两张图）。
   * 只用单引号：本段整体在一个模板串里。
   */
  function svgThumb(seed, shape) {
    var h = 0;
    for (var i = 0; i < seed.length; i++) h = (h * 31 + seed.charCodeAt(i)) >>> 0;
    var c = '#' + ('000000' + (h % 16777215).toString(16)).slice(-6);
    // 形状：默认 8x8 方图；传 'pt' 给 6x8 **竖版**。
    // ⭐ 为什么非得有一张竖版：方图放进方形格子，object-fit 的 fill / contain / cover
    //    **渲染结果一模一样**（格子本身就是方的）⇒ 只留方图的话，"object-fit 被改成 fill"
    //   这种错法在冒烟里永远绿。真库 35 张里 31 方 4 竖（2026-10-12 实测），夹具照抄这个比例。
    var w = shape === 'pt' ? 6 : 8;
    var ht = 8;
    return 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(
      '<svg xmlns="http://www.w3.org/2000/svg" width="' + w + '" height="' + ht + '">' +
        '<rect width="' + w + '" height="' + ht + '" fill="' + c + '"/></svg>',
    );
  }
  // 哪几条夹具行是竖版图（真库约 1/9 竖版）：路径里带 p47 的那行。
  function shapeOf(p) { return String(p || '').indexOf('p47') >= 0 ? 'pt' : ''; }
  window.__emptyOrders = false;
  // 空态开关（默认关闭 = 有数据）：__noGap / __noPurchaseOrders / __noPendingOrders / __noShopAlloc
  window.__noGap = false;
  window.__noPurchaseOrders = false;
  window.__noPendingOrders = false;
  window.__noShopAlloc = false;
  // 「今天这批**都核对完了**」的开关（2026-10-11 新增）：与 __noPendingOrders 的区别是 ——
  //   __noPendingOrders = 什么都没导（待核对 0、已核对也 0）⇒ 空态说「今天还没有导入订单」；
  //   __allCorrected    = 导过、但全核完了（待核对 0、已核对 > 0）⇒ 空态说「今天这批都核对完了」
  //   并给**流程的第 3、4 步**出口（去算钱 / 去看要拿什么）。
  // ⚠️ 两个空态**必须分开造**：只造前者的话，"核完了"那条路径在冒烟里根本走不到，
  //   而它正是用户问题 ②（"做完归类核对后订单不知道在哪"）要治的那条 —— 断言会恒绿。
  window.__allCorrected = false;
  // 「退回待核对」（2026-10-12）动过的订单 id：夹具里**每行的 corrected 状态是按这些集合算出来的**
  //   · __correctedIds —— 被保存/确认过（已核对）；
  //   · __reopenedIds  —— 被退回（放回待核对，**优先于**上面那个集合）。
  // ⚠️ 两个集合都由断言段在运行中写（桥里只读）—— 与 __correctedIds 同一个姿势。
  window.__reopenedIds = [];
  // 「点开看原图」（2026-10-12）的两个探针开关：
  //   __readImageFail  —— 让 orderReadImage 回 data:null ⇒ 验"读失败保留缩略图"那一支；
  //   __readImageDelay —— { localPath: 毫秒 }，按路径拖慢响应 ⇒ 造"连点"竞态（见下面的桩）。
  window.__readImageFail = false;
  window.__readImageDelay = {};

  var IMPORTED = [{
    id: 1, orderNo: 'I-1', source: 'import', shop: '店A', orderTime: daysAgo(1) + ' 10:00:00',
    styleCode: 'S1', styleColor: '红', color: '黑', size: 'L', itemId: 'ITEM1',
    supplierId: 7, supplierName: '厂A', amountCents: 16518, vatCents: 3469, ddpCents: 2294,
    taxPlatform: '平台已税', bizStatus: '等待发货', rawFields: { '商品信息': '【1】 某款 (商品数量:1 piece)' },
    // ⚠️ createdAt = **导入日**（不是下单日 orderTime）。下单在前天、导入在今天 —— 这正是
    //    真实工作流（每天早上导"昨天 → 现在"的单），也是"按导入日而不是按下单日筛"这条口径的用例。
    createdAt: daysAgo(0) + ' 10:00:00',
  }];
  var COLLECTED = [{
    id: 9001, orderNo: 'C-1', source: 'collect', shop: '', orderTime: daysAgo(2) + ' 09:00:00',
    styleCode: '', styleColor: '', color: '白', size: 'M', itemId: '',
    supplierId: 0, supplierName: '', qty: 2, amountCents: 20000,
    vatCents: null, ddpCents: null, taxPlatform: '', bizStatus: '等待发货', rawFields: {},
    createdAt: daysAgo(0) + ' 08:30:00',
  }];
  // 「导入日」过滤的**反向夹具**（2026-10-11 新增）：一行是**三天前**导进来的。
  // 它与上面那两行的 orderTime 同形，**只有 createdAt（导入日）不同** ⇒ 发货台按导入日筛时
  // 它必须**不出现在任何计数里**。
  // ⚠️ 没有它，"按导入日筛"这条实现根本测不到：夹具全落在今天就等于恒真 ——
  //    真库里"错筛成不筛"与"筛对了"看起来一模一样（这正是本仓反复踩的"夹具让断言空转"）。
  var IMPORTED_OLD = [{
    id: 5001, orderNo: 'I-OLD', source: 'import', shop: '店A', orderTime: daysAgo(4) + ' 10:00:00',
    styleCode: '', styleColor: '', color: '灰', size: 'XL', itemId: '', supplierId: 0, supplierName: '',
    amountCents: 500, vatCents: null, ddpCents: null, taxPlatform: '', bizStatus: '等待发货',
    rawFields: {}, createdAt: daysAgo(3) + ' 11:00:00',
  }];

  function b64ToBuf(b64) {
    var bin = atob(b64); var len = bin.length; var bytes = new Uint8Array(len);
    for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
    return bytes.buffer;
  }

  // ---- 拿货域夹具（2026-10-05「拿货」页签内建）----
  // 两个厂：**故意给两个** —— 只有一个的话"厂家没预选"这条守卫会变成恒绿
  //（下拉只有一个选项时，预选与不预选看起来一样）。
  var SUPPLIERS = [
    { id: 7, name: '厂A', phone: '13800000000', note: '', createdAt: '2026-10-01 09:00:00' },
    { id: 8, name: '厂B', phone: '', note: '', createdAt: '2026-10-01 09:00:00' },
    { id: 9, name: '厂C', phone: '', note: '', createdAt: '2026-10-01 09:00:00' },
  ];
  // 待拿货缺口：一行，粒度 = 款色码（与宿主 outstanding() 一致）。
  // ⚠️ 三个数**故意都不是整组件数**（3/1/2，而拣货清单那组是 3 件）：这样"已拿"与"还差"
  //    才不会退化成"前者恒 0、后者恒等于需求"—— 尺码格断言（要拿 = 还差 = 2，不是需求 3）
  //    与顶部条「待拿 1 款色 · 2 件」都靠这一行区分 remaining 与 demand 两种口径；
  //    行内「无进价 3 件」取自需求口径 ⇒ 与"待拿 2 件"不同数，两条支路互不遮蔽（2026-10-10 换的判据）。
  var GAPS = [
    { styleCode: 'S1', styleName: '款一', color: '黑', size: 'L', demand: 3, taken: 1, missing: 2 },
  ];
  var IGNORES = [
    { styleCode: 'S9', color: '蓝', reason: '已线下拿', createdAt: '2026-10-01 10:00:00' },
  ];
  // 拿货单：一张草稿（明细，2 件 × 60.00 = 120.00）+ 一张已提交（包价 500.00）
  var PURCHASE_ORDERS = [
    { id: 3, supplierId: 7, supplierName: '厂A', bizDate: '2026-10-05', mode: 'detail', status: 'draft',
      totalCents: 12000, editedAt: null, createdAt: '2026-10-05 09:00:00',
      items: [
        { id: 1, styleCode: 'S1', styleName: '款一', color: '黑', size: 'L', qty: 2,
          priceCents: 6000, amountCents: 12000, suggestionQty: 2 },
        // 第二行 **同款同色、只差尺码**（M）—— 这是"行图必须按尺码各取各的"那条守卫的地基：
        // 只按款色取图时，这两行会显示成同一张（用户报的"拿货单明细的图片都是一样的"）。
        // 单价留空 ⇒ 金额 0，既有的「合计 ¥120.00」与保存断言都不受影响。
        { id: 2, styleCode: 'S1', styleName: '款一', color: '黑', size: 'M', qty: 1,
          priceCents: 0, amountCents: 0, suggestionQty: 1 },
      ] },
    { id: 2, supplierId: 8, supplierName: '厂B', bizDate: '2026-10-04', mode: 'package', status: 'submitted',
      totalCents: 50000, editedAt: null, createdAt: '2026-10-04 09:00:00', items: [] },
  ];
  // 新建的单**真的入册**（2026-10-10 重设计后）：生成拿货单会**立刻打开编辑器填价**
  // （createFromPick → openEditor(r.id)）。假桥若不记住新建的单，purchaseOrderGet(99)
  // 会拿一句「拿货单不存在」把这条主路径变成错误提示 —— 夹具必须忠于真形状（真库里 create 就是落库的）。
  var CREATED_ORDERS = [];
  function allOrders() { return PURCHASE_ORDERS.concat(CREATED_ORDERS); }

  // ---- 对账域夹具（2026-10-05「结算对账」页签内建）----
  // 两行有账 + 一行零账，**故意不同型**：厂A 欠 40.00（拿货 120 / 已付 80）、厂B 欠 520.00（拿货 500 / 退 20）
  //  ⇒ 四个合计（620 / 80 / 20 / 560）都**不等于任一单行** —— 实现若只显示最后一行，断言会红。
  //  + 厂C **全零**（真形状：reconciliation 是按 suppliers 表出全量的，零活动厂家照样占一行）——
  //    本页仿"账本"语义只列**窗口内有账**的厂家（零行是常态噪音：真库 6 家里 5 家恒零），
  //    厂C 就是这条过滤的载体：它**不该**出现在表里。
  var RECON = [
    { supplierId: 7, supplierName: '厂A', purchaseCents: 12000, paidCents: 8000, refundCents: 0,
      balanceCents: 4000, orderCount: 1, paymentCount: 1 },
    { supplierId: 8, supplierName: '厂B', purchaseCents: 50000, paidCents: 0, refundCents: 2000,
      balanceCents: 52000, orderCount: 1, paymentCount: 1 },
    { supplierId: 9, supplierName: '厂C', purchaseCents: 0, paidCents: 0, refundCents: 0,
      balanceCents: 0, orderCount: 0, paymentCount: 0 },
  ];
  // 付款两笔：一笔付款、一笔退款 —— 都覆盖到，"类型"列的两条分支才都有断言
  var PAYMENTS = [
    { id: 21, supplierId: 7, supplierName: '厂A', payDate: '2026-10-02', type: 'payment',
      amountCents: 8000, method: '微信', note: '首款', createdAt: '2026-10-02 10:00:00' },
    { id: 22, supplierId: 8, supplierName: '厂B', payDate: '2026-10-03', type: 'refund',
      amountCents: 2000, method: '银行', note: '退次品', createdAt: '2026-10-03 10:00:00' },
  ];
  // 店铺分摊：两个店**金额不同** ⇒ 只显示第一行会被断言抓到
  var SHOP_ALLOC = [
    { shop: '店A', qty: 2, amountCents: 12000, orderCount: 1 },
    { shop: '店B', qty: 3, amountCents: 18000, orderCount: 1 },
  ];
  var SHOP_DETAIL = [
    { purchaseId: 3, bizDate: '2026-10-05', supplierName: '厂A', shop: '店A', styleCode: 'S1',
      styleName: '款一', color: '黑', size: 'L', qty: 2, priceCents: 6000, amountCents: 12000 },
  ];

  // ---- 归类核对域夹具（2026-10-05「归类核对」页签内建；2026-10-10 按新口径重做）----
  // 五行**故意各不相同**，让每条判据**各自独立可观测**（只放"唯一可选项"等于没测）：
  //    · P-41：有图 + 未归类 + 没点名款（本款色卡为空）→ 颜色格必须是**自由输入**，值 = 订单自己的颜色；
  //    · P-42：有图 + 已归类 S1 + 图记住的颜色「白」**在** S1 色卡里、而订单自己的颜色是「黑」→
  //      颜色格必须自动选中**记住的**「白」而不是订单的「黑」（两条支路给出不同答案，才分得清是哪条在起作用）；
  //    · P-43：**无图** + 未归类 + **没有商品ID** → 无图行不该进缩略图合批（进了就白跑一次往返，
  //      而"少带一条"与"带对了"在调用数上完全看不出区别）；它同时是"点名一个**还没录颜色**的款
  //      ⇒ 颜色回落自由输入"这条判据的载体；
  //    · P-44：有图 + 已归类 S1 + 图记住「印花」**不在** S1 色卡、订单自己的颜色「印花」也不在
  //      → 颜色格必须**留空**（让用户自己选），不替他改判、也不把别的款的色硬塞进来；
  //    · P-45：无图 + 已归类 S1 + 图记住「印花」不在色卡、订单自己的颜色「黑」**在**色卡
  //      → 回落选订单自己的颜色（这条与 P-42 一起把"先认记住的色、次认订单的色"这个次序钉死）。
  //    P-41 与 P-42 是**同一家店的同一个商品ID**（店A / IT-A）⇒ 这两行要标「同商品 ×2」。
  //    ⭐ 「同商品」「独占商品」「没有商品ID」三种情况必须**各有一行**：
  //       只有"两条同商品 + 一条无商品ID"时，「有商品ID 就标」这种错法也能全绿
  //       （缺的正是 P-44 这样的"有商品ID 但只此一行"——它不该有徽标）。
  // ⭐⭐ **P-43 与 P-45 的 category 必须是空串，这不是随手写的**（2026-10-11 修"归类核对设的颜色不生效"）：
  //     真库里这两个量恰好**恒空** —— 导入不提品类（实测 23 行 category 全空）、从没跑过 VLM
  //     （oi_images.result_json 全 null ⇒ features 恒空）⇒ buildStyleFingerprint('', []) 是**空串**。
  //     夹具原先给的是「帽子」「T恤」⇒ 指纹恒非空 ⇒ "点名款到底要不要指纹"这条**分不出来**，
  //     夹具把被验的量写成了实现的期望形状，断言只能恒绿（本仓反复踩的同一个坑）。
  //     · P-43（无款 + 空品类 + 空特征）⇒ **填了颜色也没处挂**："拦住并说明"那条守卫的载体；
  //     · P-45（有款 S1 + 空品类 + 空特征）⇒ 点名款时必须**照样挂款**（不要求指纹），
  //       否则颜色永远到不了款色（拿货单 / 算钱 / 取图全读款色）。
  var PENDING_ORDERS = [
    { id: 41, imageId: 401, orderNo: 'P-41', shop: '店A', size: 'L', orderTime: '2026-10-04 10:00:00',
      category: 'T恤', color: '黑', logo: '', styleCode: '', styleName: '', styleColor: '',
      localPath: '/tmp/p41.jpg', fingerprint: 'fp41', features: ['圆领', '短袖'],
      itemId: 'IT-A', createdAt: daysAgo(0) + ' 09:00:00',
      corrected: false, rawFields: { '商品ID': 'IT-A' } },
    { id: 42, imageId: 402, orderNo: 'P-42', shop: '店A', size: 'M', orderTime: '2026-10-04 11:00:00',
      category: '裤子', color: '黑', logo: '', styleCode: 'S1', styleName: '款一', styleColor: '白',
      localPath: '/tmp/p42.jpg', fingerprint: 'fp42', features: [],
      itemId: 'IT-A', createdAt: daysAgo(0) + ' 09:01:00',
      corrected: false, rawFields: { '商品ID': 'IT-A' } },
    { id: 43, imageId: null, orderNo: 'P-43', shop: '店C', size: 'S', orderTime: '2026-10-04 12:00:00',
      category: '', color: '灰', logo: '', styleCode: '', styleName: '', styleColor: '',
      localPath: '', fingerprint: '', features: [],
      itemId: '', createdAt: daysAgo(0) + ' 09:02:00',
      corrected: false, rawFields: {} },
    { id: 44, imageId: 404, orderNo: 'P-44', shop: '店B', size: 'XL', orderTime: '2026-10-04 13:00:00',
      category: '外套', color: '印花', logo: '', styleCode: 'S1', styleName: '款一', styleColor: '印花',
      localPath: '/tmp/p44.jpg', fingerprint: 'fp44', features: ['连帽'],
      itemId: 'IT-B', createdAt: daysAgo(0) + ' 09:03:00',
      corrected: false, rawFields: { '商品ID': 'IT-B' } },
    { id: 45, imageId: null, orderNo: 'P-45', shop: '店E', size: 'M', orderTime: '2026-10-04 14:00:00',
      category: '', color: '黑', logo: '', styleCode: 'S1', styleName: '款一', styleColor: '印花',
      localPath: '', fingerprint: 'fp45', features: [],
      itemId: 'IT-C', createdAt: daysAgo(0) + ' 09:04:00',
      corrected: false, rawFields: { '商品ID': 'IT-C' } },
  ];
  // 「已核对」的订单（2026-10-11 新增）：页头「待核对 X · 已核对 Y」里那个 Y 用它们。
  // ⚠️ **故意给 2 行**（不是 0、也不是全部）：0 的话，"计数实现坏了恒返回 0"照样全绿；
  //    全部的话，两个数相等也分不出"数错了"。5 + 2 这组数**两边各自可辨**。
  // ⚠️ 它们也必须是**今天导进来的**（createdAt）—— 口径与待核对那一份同一个筛，
  //    否则两个数加起来大于这批总数，用户一眼看出对不上。
  // ⭐⭐ 2026-10-12：这两行的 color / styleColor **刻意不一样**，这是"已核对范围只读格
  //     显示的是哪一个"唯一能分辨的夹具形状 —— 两个值相同的话（原来 P-46 两处都是「黑」），
  //     "先读款色"与"先读订单色"两种实现都显示「黑」，断言只能恒绿（本仓反复踩的同一个坑）。
  //     · P-46：款色「黑」/ 订单色「灰」⇒ 必须显示**黑**（款色是下游真读的那一份）；
  //     · P-47：款色**空** / 订单色「蓝」⇒ 必须回落显示**蓝**（款色没有时不能让格子空着）。
  // ⭐⭐ 2026-10-12（用户报"已核对范围看着是坏的"）：这两行**必须也有图**。
  //     真库实测 23/23 行全有图（已核对 184–206、待核对 207–213 都是 HAS），
  //     而模板注释明写"已核对范围里同样要出图：退回的判据就是这张图定错了款"。
  //     原先 localPath 是空串 ⇒ 两个范围各显示一列空占位、行被撑得很高 ⇒ **那一列**在冒烟里
  //     从来没有被看见过（"已核对范围也出图"这条因此无法被验证 = 恒绿）。
  //     给图之后它才第一次成为可断言的判据。顺带：p46 是方图、p47 是竖图（见 classify-shot 的形状混合）。
  var CORRECTED_ORDERS = [
    { id: 46, imageId: 406, orderNo: 'P-46', shop: '店A', size: 'L', orderTime: '2026-10-04 08:00:00',
      category: 'T恤', color: '灰', logo: '', styleCode: 'S1', styleName: '款一', styleColor: '黑',
      localPath: '/tmp/p46.jpg', fingerprint: 'fp46', features: [], itemId: 'IT-A',
      createdAt: daysAgo(0) + ' 08:30:00', corrected: true, rawFields: {} },
    { id: 47, imageId: 407, orderNo: 'P-47', shop: '店B', size: 'M', orderTime: '2026-10-04 08:10:00',
      category: '裤子', color: '蓝', logo: '', styleCode: 'S2', styleName: '款二', styleColor: '',
      localPath: '/tmp/p47.jpg', fingerprint: 'fp47', features: [], itemId: 'IT-B',
      createdAt: daysAgo(0) + ' 08:31:00', corrected: true, rawFields: {} },
  ];
  // 「归属款」下拉的数据源 = **产品库全集**（不是识别池）。三行各验一件事：
  //    · S1 / S2 是两个正常款 —— S1 有色卡（黑/白）、S2 有色卡（蓝）；
  //    · S9 是**产品库里手工新建、识别池里没有**的款（旧实现按 oi_styles 驱动 ⇒ 手工建的款一个都不出现，
  //      这正是用户报的"展示不全"），且状态是 archived ⇒ 选项文案要带「（停用）」；
  //      它的色卡**故意为空** ⇒ 点名它之后颜色格要回落成自由输入（而不是给一个空下拉）。
  //    ⚠️ 有 S9 之后"选项数"本身就成了判据：识别池两行时是 3 个选项（自动匹配 + 2），
  //       产品库驱动才是 4 个 —— 数不对直接红，不靠人眼比对款名。
  var STYLES = [
    { code: 'S1', name: '款一', status: 'active', colors: ['黑', '白'] },
    { code: 'S2', name: '款二', status: 'active', colors: ['蓝'] },
    { code: 'S9', name: '款九', status: 'archived', colors: [] },
  ];

  window.__importKind = 'weights';   // 切到 'junk' 时返回一份认不出的表
  var XLSX_WEIGHTS_B64 = 'UEsDBBQAAAAAAAAAAACkAYS4tQIAALUCAAAaAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+DQo8UmVsYXRpb25zaGlwcyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzIj48UmVsYXRpb25zaGlwIElkPSJySWQxIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3dvcmtzaGVldCIgVGFyZ2V0PSJ3b3Jrc2hlZXRzL3NoZWV0MS54bWwiLz48UmVsYXRpb25zaGlwIElkPSJySWQyIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3RoZW1lIiBUYXJnZXQ9InRoZW1lL3RoZW1lMS54bWwiLz48UmVsYXRpb25zaGlwIElkPSJySWQzIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3N0eWxlcyIgVGFyZ2V0PSJzdHlsZXMueG1sIi8+PFJlbGF0aW9uc2hpcCBJZD0icklkNCIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9zaGVldE1ldGFkYXRhIiBUYXJnZXQ9Im1ldGFkYXRhLnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAAAAAADAPiGveHQAA3h0AABMAAAB4bC90aGVtZS90aGVtZTEueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPGE6dGhlbWUgeG1sbnM6YT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL2RyYXdpbmdtbC8yMDA2L21haW4iIG5hbWU9Ik9mZmljZSBUaGVtZSI+PGE6dGhlbWVFbGVtZW50cz48YTpjbHJTY2hlbWUgbmFtZT0iT2ZmaWNlIj48YTpkazE+PGE6c3lzQ2xyIHZhbD0id2luZG93VGV4dCIgbGFzdENscj0iMDAwMDAwIi8+PC9hOmRrMT48YTpsdDE+PGE6c3lzQ2xyIHZhbD0id2luZG93IiBsYXN0Q2xyPSJGRkZGRkYiLz48L2E6bHQxPjxhOmRrMj48YTpzcmdiQ2xyIHZhbD0iMUY0OTdEIi8+PC9hOmRrMj48YTpsdDI+PGE6c3JnYkNsciB2YWw9IkVFRUNFMSIvPjwvYTpsdDI+PGE6YWNjZW50MT48YTpzcmdiQ2xyIHZhbD0iNEY4MUJEIi8+PC9hOmFjY2VudDE+PGE6YWNjZW50Mj48YTpzcmdiQ2xyIHZhbD0iQzA1MDREIi8+PC9hOmFjY2VudDI+PGE6YWNjZW50Mz48YTpzcmdiQ2xyIHZhbD0iOUJCQjU5Ii8+PC9hOmFjY2VudDM+PGE6YWNjZW50ND48YTpzcmdiQ2xyIHZhbD0iODA2NEEyIi8+PC9hOmFjY2VudDQ+PGE6YWNjZW50NT48YTpzcmdiQ2xyIHZhbD0iNEJBQ0M2Ii8+PC9hOmFjY2VudDU+PGE6YWNjZW50Nj48YTpzcmdiQ2xyIHZhbD0iRjc5NjQ2Ii8+PC9hOmFjY2VudDY+PGE6aGxpbms+PGE6c3JnYkNsciB2YWw9IjAwMDBGRiIvPjwvYTpobGluaz48YTpmb2xIbGluaz48YTpzcmdiQ2xyIHZhbD0iODAwMDgwIi8+PC9hOmZvbEhsaW5rPjwvYTpjbHJTY2hlbWU+PGE6Zm9udFNjaGVtZSBuYW1lPSJPZmZpY2UiPjxhOm1ham9yRm9udD48YTpsYXRpbiB0eXBlZmFjZT0iQ2FtYnJpYSIvPjxhOmVhIHR5cGVmYWNlPSIiLz48YTpjcyB0eXBlZmFjZT0iIi8+PGE6Zm9udCBzY3JpcHQ9IkpwYW4iIHR5cGVmYWNlPSLvvK3vvLMg77yw44K044K344OD44KvIi8+PGE6Zm9udCBzY3JpcHQ9IkhhbmciIHR5cGVmYWNlPSLrp5HsnYAg6rOg65SVIi8+PGE6Zm9udCBzY3JpcHQ9IkhhbnMiIHR5cGVmYWNlPSLlrovkvZMiLz48YTpmb250IHNjcmlwdD0iSGFudCIgdHlwZWZhY2U9IuaWsOe0sOaYjumrlCIvPjxhOmZvbnQgc2NyaXB0PSJBcmFiIiB0eXBlZmFjZT0iVGltZXMgTmV3IFJvbWFuIi8+PGE6Zm9udCBzY3JpcHQ9IkhlYnIiIHR5cGVmYWNlPSJUaW1lcyBOZXcgUm9tYW4iLz48YTpmb250IHNjcmlwdD0iVGhhaSIgdHlwZWZhY2U9IlRhaG9tYSIvPjxhOmZvbnQgc2NyaXB0PSJFdGhpIiB0eXBlZmFjZT0iTnlhbGEiLz48YTpmb250IHNjcmlwdD0iQmVuZyIgdHlwZWZhY2U9IlZyaW5kYSIvPjxhOmZvbnQgc2NyaXB0PSJHdWpyIiB0eXBlZmFjZT0iU2hydXRpIi8+PGE6Zm9udCBzY3JpcHQ9IktobXIiIHR5cGVmYWNlPSJNb29sQm9yYW4iLz48YTpmb250IHNjcmlwdD0iS25kYSIgdHlwZWZhY2U9IlR1bmdhIi8+PGE6Zm9udCBzY3JpcHQ9Ikd1cnUiIHR5cGVmYWNlPSJSYWF2aSIvPjxhOmZvbnQgc2NyaXB0PSJDYW5zIiB0eXBlZmFjZT0iRXVwaGVtaWEiLz48YTpmb250IHNjcmlwdD0iQ2hlciIgdHlwZWZhY2U9IlBsYW50YWdlbmV0IENoZXJva2VlIi8+PGE6Zm9udCBzY3JpcHQ9IllpaWkiIHR5cGVmYWNlPSJNaWNyb3NvZnQgWWkgQmFpdGkiLz48YTpmb250IHNjcmlwdD0iVGlidCIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBIaW1hbGF5YSIvPjxhOmZvbnQgc2NyaXB0PSJUaGFhIiB0eXBlZmFjZT0iTVYgQm9saSIvPjxhOmZvbnQgc2NyaXB0PSJEZXZhIiB0eXBlZmFjZT0iTWFuZ2FsIi8+PGE6Zm9udCBzY3JpcHQ9IlRlbHUiIHR5cGVmYWNlPSJHYXV0YW1pIi8+PGE6Zm9udCBzY3JpcHQ9IlRhbWwiIHR5cGVmYWNlPSJMYXRoYSIvPjxhOmZvbnQgc2NyaXB0PSJTeXJjIiB0eXBlZmFjZT0iRXN0cmFuZ2VsbyBFZGVzc2EiLz48YTpmb250IHNjcmlwdD0iT3J5YSIgdHlwZWZhY2U9IkthbGluZ2EiLz48YTpmb250IHNjcmlwdD0iTWx5bSIgdHlwZWZhY2U9IkthcnRpa2EiLz48YTpmb250IHNjcmlwdD0iTGFvbyIgdHlwZWZhY2U9IkRva0NoYW1wYSIvPjxhOmZvbnQgc2NyaXB0PSJTaW5oIiB0eXBlZmFjZT0iSXNrb29sYSBQb3RhIi8+PGE6Zm9udCBzY3JpcHQ9Ik1vbmciIHR5cGVmYWNlPSJNb25nb2xpYW4gQmFpdGkiLz48YTpmb250IHNjcmlwdD0iVmlldCIgdHlwZWZhY2U9IlRpbWVzIE5ldyBSb21hbiIvPjxhOmZvbnQgc2NyaXB0PSJVaWdoIiB0eXBlZmFjZT0iTWljcm9zb2Z0IFVpZ2h1ciIvPjxhOmZvbnQgc2NyaXB0PSJHZW9yIiB0eXBlZmFjZT0iU3lsZmFlbiIvPjwvYTptYWpvckZvbnQ+PGE6bWlub3JGb250PjxhOmxhdGluIHR5cGVmYWNlPSJDYWxpYnJpIi8+PGE6ZWEgdHlwZWZhY2U9IiIvPjxhOmNzIHR5cGVmYWNlPSIiLz48YTpmb250IHNjcmlwdD0iSnBhbiIgdHlwZWZhY2U9Iu+8re+8syDvvLDjgrTjgrfjg4Pjgq8iLz48YTpmb250IHNjcmlwdD0iSGFuZyIgdHlwZWZhY2U9IuunkeydgCDqs6DrlJUiLz48YTpmb250IHNjcmlwdD0iSGFucyIgdHlwZWZhY2U9IuWui+S9kyIvPjxhOmZvbnQgc2NyaXB0PSJIYW50IiB0eXBlZmFjZT0i5paw57Sw5piO6auUIi8+PGE6Zm9udCBzY3JpcHQ9IkFyYWIiIHR5cGVmYWNlPSJBcmlhbCIvPjxhOmZvbnQgc2NyaXB0PSJIZWJyIiB0eXBlZmFjZT0iQXJpYWwiLz48YTpmb250IHNjcmlwdD0iVGhhaSIgdHlwZWZhY2U9IlRhaG9tYSIvPjxhOmZvbnQgc2NyaXB0PSJFdGhpIiB0eXBlZmFjZT0iTnlhbGEiLz48YTpmb250IHNjcmlwdD0iQmVuZyIgdHlwZWZhY2U9IlZyaW5kYSIvPjxhOmZvbnQgc2NyaXB0PSJHdWpyIiB0eXBlZmFjZT0iU2hydXRpIi8+PGE6Zm9udCBzY3JpcHQ9IktobXIiIHR5cGVmYWNlPSJEYXVuUGVuaCIvPjxhOmZvbnQgc2NyaXB0PSJLbmRhIiB0eXBlZmFjZT0iVHVuZ2EiLz48YTpmb250IHNjcmlwdD0iR3VydSIgdHlwZWZhY2U9IlJhYXZpIi8+PGE6Zm9udCBzY3JpcHQ9IkNhbnMiIHR5cGVmYWNlPSJFdXBoZW1pYSIvPjxhOmZvbnQgc2NyaXB0PSJDaGVyIiB0eXBlZmFjZT0iUGxhbnRhZ2VuZXQgQ2hlcm9rZWUiLz48YTpmb250IHNjcmlwdD0iWWlpaSIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBZaSBCYWl0aSIvPjxhOmZvbnQgc2NyaXB0PSJUaWJ0IiB0eXBlZmFjZT0iTWljcm9zb2Z0IEhpbWFsYXlhIi8+PGE6Zm9udCBzY3JpcHQ9IlRoYWEiIHR5cGVmYWNlPSJNViBCb2xpIi8+PGE6Zm9udCBzY3JpcHQ9IkRldmEiIHR5cGVmYWNlPSJNYW5nYWwiLz48YTpmb250IHNjcmlwdD0iVGVsdSIgdHlwZWZhY2U9IkdhdXRhbWkiLz48YTpmb250IHNjcmlwdD0iVGFtbCIgdHlwZWZhY2U9IkxhdGhhIi8+PGE6Zm9udCBzY3JpcHQ9IlN5cmMiIHR5cGVmYWNlPSJFc3RyYW5nZWxvIEVkZXNzYSIvPjxhOmZvbnQgc2NyaXB0PSJPcnlhIiB0eXBlZmFjZT0iS2FsaW5nYSIvPjxhOmZvbnQgc2NyaXB0PSJNbHltIiB0eXBlZmFjZT0iS2FydGlrYSIvPjxhOmZvbnQgc2NyaXB0PSJMYW9vIiB0eXBlZmFjZT0iRG9rQ2hhbXBhIi8+PGE6Zm9udCBzY3JpcHQ9IlNpbmgiIHR5cGVmYWNlPSJJc2tvb2xhIFBvdGEiLz48YTpmb250IHNjcmlwdD0iTW9uZyIgdHlwZWZhY2U9Ik1vbmdvbGlhbiBCYWl0aSIvPjxhOmZvbnQgc2NyaXB0PSJWaWV0IiB0eXBlZmFjZT0iQXJpYWwiLz48YTpmb250IHNjcmlwdD0iVWlnaCIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBVaWdodXIiLz48YTpmb250IHNjcmlwdD0iR2VvciIgdHlwZWZhY2U9IlN5bGZhZW4iLz48L2E6bWlub3JGb250PjwvYTpmb250U2NoZW1lPjxhOmZtdFNjaGVtZSBuYW1lPSJPZmZpY2UiPjxhOmZpbGxTdHlsZUxzdD48YTpzb2xpZEZpbGw+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiLz48L2E6c29saWRGaWxsPjxhOmdyYWRGaWxsIHJvdFdpdGhTaGFwZT0iMSI+PGE6Z3NMc3Q+PGE6Z3MgcG9zPSIwIj48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6dGludCB2YWw9IjUwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMzAwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PGE6Z3MgcG9zPSIzNTAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSIzNzAwMCIvPjxhOnNhdE1vZCB2YWw9IjMwMDAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOmdzPjxhOmdzIHBvcz0iMTAwMDAwIj48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6dGludCB2YWw9IjE1MDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOmxpbiBhbmc9IjE2MjAwMDAwIiBzY2FsZWQ9IjEiLz48L2E6Z3JhZEZpbGw+PGE6Z3JhZEZpbGwgcm90V2l0aFNoYXBlPSIxIj48YTpnc0xzdD48YTpncyBwb3M9IjAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iMTAwMDAwIi8+PGE6c2hhZGUgdmFsPSIxMDAwMDAiLz48YTpzYXRNb2QgdmFsPSIxMzAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48YTpncyBwb3M9IjEwMDAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSI1MDAwMCIvPjxhOnNoYWRlIHZhbD0iMTAwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOmxpbiBhbmc9IjE2MjAwMDAwIiBzY2FsZWQ9IjAiLz48L2E6Z3JhZEZpbGw+PC9hOmZpbGxTdHlsZUxzdD48YTpsblN0eWxlTHN0PjxhOmxuIHc9Ijk1MjUiIGNhcD0iZmxhdCIgY21wZD0ic25nIiBhbGduPSJjdHIiPjxhOnNvbGlkRmlsbD48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6c2hhZGUgdmFsPSI5NTAwMCIvPjxhOnNhdE1vZCB2YWw9IjEwNTAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOnNvbGlkRmlsbD48YTpwcnN0RGFzaCB2YWw9InNvbGlkIi8+PC9hOmxuPjxhOmxuIHc9IjI1NDAwIiBjYXA9ImZsYXQiIGNtcGQ9InNuZyIgYWxnbj0iY3RyIj48YTpzb2xpZEZpbGw+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiLz48L2E6c29saWRGaWxsPjxhOnByc3REYXNoIHZhbD0ic29saWQiLz48L2E6bG4+PGE6bG4gdz0iMzgxMDAiIGNhcD0iZmxhdCIgY21wZD0ic25nIiBhbGduPSJjdHIiPjxhOnNvbGlkRmlsbD48YTpzY2hlbWVDbHIgdmFsPSJwaENsciIvPjwvYTpzb2xpZEZpbGw+PGE6cHJzdERhc2ggdmFsPSJzb2xpZCIvPjwvYTpsbj48L2E6bG5TdHlsZUxzdD48YTplZmZlY3RTdHlsZUxzdD48YTplZmZlY3RTdHlsZT48YTplZmZlY3RMc3Q+PGE6b3V0ZXJTaGR3IGJsdXJSYWQ9IjQwMDAwIiBkaXN0PSIyMDAwMCIgZGlyPSI1NDAwMDAwIiByb3RXaXRoU2hhcGU9IjAiPjxhOnNyZ2JDbHIgdmFsPSIwMDAwMDAiPjxhOmFscGhhIHZhbD0iMzgwMDAiLz48L2E6c3JnYkNscj48L2E6b3V0ZXJTaGR3PjwvYTplZmZlY3RMc3Q+PC9hOmVmZmVjdFN0eWxlPjxhOmVmZmVjdFN0eWxlPjxhOmVmZmVjdExzdD48YTpvdXRlclNoZHcgYmx1clJhZD0iNDAwMDAiIGRpc3Q9IjIzMDAwIiBkaXI9IjU0MDAwMDAiIHJvdFdpdGhTaGFwZT0iMCI+PGE6c3JnYkNsciB2YWw9IjAwMDAwMCI+PGE6YWxwaGEgdmFsPSIzNTAwMCIvPjwvYTpzcmdiQ2xyPjwvYTpvdXRlclNoZHc+PC9hOmVmZmVjdExzdD48L2E6ZWZmZWN0U3R5bGU+PGE6ZWZmZWN0U3R5bGU+PGE6ZWZmZWN0THN0PjxhOm91dGVyU2hkdyBibHVyUmFkPSI0MDAwMCIgZGlzdD0iMjMwMDAiIGRpcj0iNTQwMDAwMCIgcm90V2l0aFNoYXBlPSIwIj48YTpzcmdiQ2xyIHZhbD0iMDAwMDAwIj48YTphbHBoYSB2YWw9IjM1MDAwIi8+PC9hOnNyZ2JDbHI+PC9hOm91dGVyU2hkdz48L2E6ZWZmZWN0THN0PjxhOnNjZW5lM2Q+PGE6Y2FtZXJhIHByc3Q9Im9ydGhvZ3JhcGhpY0Zyb250Ij48YTpyb3QgbGF0PSIwIiBsb249IjAiIHJldj0iMCIvPjwvYTpjYW1lcmE+PGE6bGlnaHRSaWcgcmlnPSJ0aHJlZVB0IiBkaXI9InQiPjxhOnJvdCBsYXQ9IjAiIGxvbj0iMCIgcmV2PSIxMjAwMDAwIi8+PC9hOmxpZ2h0UmlnPjwvYTpzY2VuZTNkPjxhOnNwM2Q+PGE6YmV2ZWxUIHc9IjYzNTAwIiBoPSIyNTQwMCIvPjwvYTpzcDNkPjwvYTplZmZlY3RTdHlsZT48L2E6ZWZmZWN0U3R5bGVMc3Q+PGE6YmdGaWxsU3R5bGVMc3Q+PGE6c29saWRGaWxsPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIi8+PC9hOnNvbGlkRmlsbD48YTpncmFkRmlsbCByb3RXaXRoU2hhcGU9IjEiPjxhOmdzTHN0PjxhOmdzIHBvcz0iMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSI0MDAwMCIvPjxhOnNhdE1vZCB2YWw9IjM1MDAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOmdzPjxhOmdzIHBvcz0iNDAwMDAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iNDUwMDAiLz48YTpzaGFkZSB2YWw9Ijk5MDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PGE6Z3MgcG9zPSIxMDAwMDAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTpzaGFkZSB2YWw9IjIwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMjU1MDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOnBhdGggcGF0aD0iY2lyY2xlIj48YTpmaWxsVG9SZWN0IGw9IjUwMDAwIiB0PSItODAwMDAiIHI9IjUwMDAwIiBiPSIxODAwMDAiLz48L2E6cGF0aD48L2E6Z3JhZEZpbGw+PGE6Z3JhZEZpbGwgcm90V2l0aFNoYXBlPSIxIj48YTpnc0xzdD48YTpncyBwb3M9IjAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iODAwMDAiLz48YTpzYXRNb2QgdmFsPSIzMDAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48YTpncyBwb3M9IjEwMDAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnNoYWRlIHZhbD0iMzAwMDAiLz48YTpzYXRNb2QgdmFsPSIyMDAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48L2E6Z3NMc3Q+PGE6cGF0aCBwYXRoPSJjaXJjbGUiPjxhOmZpbGxUb1JlY3QgbD0iNTAwMDAiIHQ9IjUwMDAwIiByPSI1MDAwMCIgYj0iNTAwMDAiLz48L2E6cGF0aD48L2E6Z3JhZEZpbGw+PC9hOmJnRmlsbFN0eWxlTHN0PjwvYTpmbXRTY2hlbWU+PC9hOnRoZW1lRWxlbWVudHM+PGE6b2JqZWN0RGVmYXVsdHM+PGE6c3BEZWY+PGE6c3BQci8+PGE6Ym9keVByLz48YTpsc3RTdHlsZS8+PGE6c3R5bGU+PGE6bG5SZWYgaWR4PSIxIj48YTpzY2hlbWVDbHIgdmFsPSJhY2NlbnQxIi8+PC9hOmxuUmVmPjxhOmZpbGxSZWYgaWR4PSIzIj48YTpzY2hlbWVDbHIgdmFsPSJhY2NlbnQxIi8+PC9hOmZpbGxSZWY+PGE6ZWZmZWN0UmVmIGlkeD0iMiI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTplZmZlY3RSZWY+PGE6Zm9udFJlZiBpZHg9Im1pbm9yIj48YTpzY2hlbWVDbHIgdmFsPSJsdDEiLz48L2E6Zm9udFJlZj48L2E6c3R5bGU+PC9hOnNwRGVmPjxhOmxuRGVmPjxhOnNwUHIvPjxhOmJvZHlQci8+PGE6bHN0U3R5bGUvPjxhOnN0eWxlPjxhOmxuUmVmIGlkeD0iMiI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTpsblJlZj48YTpmaWxsUmVmIGlkeD0iMCI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTpmaWxsUmVmPjxhOmVmZmVjdFJlZiBpZHg9IjEiPjxhOnNjaGVtZUNsciB2YWw9ImFjY2VudDEiLz48L2E6ZWZmZWN0UmVmPjxhOmZvbnRSZWYgaWR4PSJtaW5vciI+PGE6c2NoZW1lQ2xyIHZhbD0idHgxIi8+PC9hOmZvbnRSZWY+PC9hOnN0eWxlPjwvYTpsbkRlZj48L2E6b2JqZWN0RGVmYXVsdHM+PGE6ZXh0cmFDbHJTY2hlbWVMc3QvPjwvYTp0aGVtZT5QSwMEFAAAAAAAAAAAAFX0BJRaBAAAWgQAAA0AAAB4bC9zdHlsZXMueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPHN0eWxlU2hlZXQgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6dnQ9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L2RvY1Byb3BzVlR5cGVzIj48bnVtRm10cyBjb3VudD0iMSI+PG51bUZtdCBudW1GbXRJZD0iNTYiIGZvcm1hdENvZGU9IiZxdW90O+S4iuWNiC/kuIvljYggJnF1b3Q7aGgmcXVvdDvmmYImcXVvdDttbSZxdW90O+WIhiZxdW90O3NzJnF1b3Q756eSICZxdW90OyIvPjwvbnVtRm10cz48Zm9udHMgY291bnQ9IjEiPjxmb250PjxzeiB2YWw9IjEyIi8+PGNvbG9yIHRoZW1lPSIxIi8+PG5hbWUgdmFsPSJDYWxpYnJpIi8+PGZhbWlseSB2YWw9IjIiLz48c2NoZW1lIHZhbD0ibWlub3IiLz48L2ZvbnQ+PC9mb250cz48ZmlsbHMgY291bnQ9IjIiPjxmaWxsPjxwYXR0ZXJuRmlsbCBwYXR0ZXJuVHlwZT0ibm9uZSIvPjwvZmlsbD48ZmlsbD48cGF0dGVybkZpbGwgcGF0dGVyblR5cGU9ImdyYXkxMjUiLz48L2ZpbGw+PC9maWxscz48Ym9yZGVycyBjb3VudD0iMSI+PGJvcmRlcj48bGVmdC8+PHJpZ2h0Lz48dG9wLz48Ym90dG9tLz48ZGlhZ29uYWwvPjwvYm9yZGVyPjwvYm9yZGVycz48Y2VsbFN0eWxlWGZzIGNvdW50PSIxIj48eGYgbnVtRm10SWQ9IjAiIGZvbnRJZD0iMCIgZmlsbElkPSIwIiBib3JkZXJJZD0iMCIvPjwvY2VsbFN0eWxlWGZzPjxjZWxsWGZzIGNvdW50PSIxIj48eGYgbnVtRm10SWQ9IjAiIGZvbnRJZD0iMCIgZmlsbElkPSIwIiBib3JkZXJJZD0iMCIgeGZJZD0iMCIgYXBwbHlOdW1iZXJGb3JtYXQ9IjEiLz48L2NlbGxYZnM+PGNlbGxTdHlsZXMgY291bnQ9IjEiPjxjZWxsU3R5bGUgbmFtZT0iTm9ybWFsIiB4ZklkPSIwIiBidWlsdGluSWQ9IjAiLz48L2NlbGxTdHlsZXM+PGR4ZnMgY291bnQ9IjAiLz48dGFibGVTdHlsZXMgY291bnQ9IjAiIGRlZmF1bHRUYWJsZVN0eWxlPSJUYWJsZVN0eWxlTWVkaXVtOSIgZGVmYXVsdFBpdm90U3R5bGU9IlBpdm90U3R5bGVNZWRpdW00Ii8+PC9zdHlsZVNoZWV0PlBLAwQUAAAAAAAAAAAAYv+eYJsCAACbAgAAGAAAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4NCjx3b3Jrc2hlZXQgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6cj0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcyI+PGRpbWVuc2lvbiByZWY9IkExOkMyIi8+PHNoZWV0Vmlld3M+PHNoZWV0VmlldyB3b3JrYm9va1ZpZXdJZD0iMCIvPjwvc2hlZXRWaWV3cz48c2hlZXREYXRhPjxyb3cgcj0iMSI+PGMgcj0iQTEiIHQ9InN0ciI+PHY+5ZWG5ZOBSUQ8L3Y+PC9jPjxjIHI9IkIxIiB0PSJzdHIiPjx2PuS6p+WTgeWQjeensDwvdj48L2M+PGMgcj0iQzEiIHQ9InN0ciI+PHY+6YeN6YePKGcpPC92PjwvYz48L3Jvdz48cm93IHI9IjIiPjxjIHI9IkEyIiB0PSJzdHIiPjx2PklURU05PC92PjwvYz48YyByPSJCMiIgdD0ic3RyIj48dj7mn5DmrL7lpJblpZc8L3Y+PC9jPjxjIHI9IkMyIiB0PSJzdHIiPjx2PjMyMDwvdj48L2M+PC9yb3c+PC9zaGVldERhdGE+PGlnbm9yZWRFcnJvcnM+PGlnbm9yZWRFcnJvciBudW1iZXJTdG9yZWRBc1RleHQ9IjEiIHNxcmVmPSJBMTpDMiIvPjwvaWdub3JlZEVycm9ycz48L3dvcmtzaGVldD5QSwMEFAAAAAAAAAAAAGCAAIGIAwAAiAMAAA8AAAB4bC9tZXRhZGF0YS54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+DQo8bWV0YWRhdGEgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6eGxyZD0iaHR0cDovL3NjaGVtYXMubWljcm9zb2Z0LmNvbS9vZmZpY2Uvc3ByZWFkc2hlZXRtbC8yMDE3L3JpY2hkYXRhIiB4bWxuczp4ZGE9Imh0dHA6Ly9zY2hlbWFzLm1pY3Jvc29mdC5jb20vb2ZmaWNlL3NwcmVhZHNoZWV0bWwvMjAxNy9keW5hbWljYXJyYXkiPgogIDxtZXRhZGF0YVR5cGVzIGNvdW50PSIxIj4KICAgIDxtZXRhZGF0YVR5cGUgbmFtZT0iWExEQVBSIiBtaW5TdXBwb3J0ZWRWZXJzaW9uPSIxMjAwMDAiIGNvcHk9IjEiIHBhc3RlQWxsPSIxIiBwYXN0ZVZhbHVlcz0iMSIgbWVyZ2U9IjEiIHNwbGl0Rmlyc3Q9IjEiIHJvd0NvbFNoaWZ0PSIxIiBjbGVhckZvcm1hdHM9IjEiIGNsZWFyQ29tbWVudHM9IjEiIGFzc2lnbj0iMSIgY29lcmNlPSIxIiBjZWxsTWV0YT0iMSIvPgogIDwvbWV0YWRhdGFUeXBlcz4KICA8ZnV0dXJlTWV0YWRhdGEgbmFtZT0iWExEQVBSIiBjb3VudD0iMSI+CiAgICA8Yms+CiAgICAgIDxleHRMc3Q+CiAgICAgICAgPGV4dCB1cmk9IntiZGJiOGNkYy1mYTFlLTQ5NmUtYTg1Ny0zYzNmMzBjMDI5YzN9Ij4KICAgICAgICAgIDx4ZGE6ZHluYW1pY0FycmF5UHJvcGVydGllcyBmRHluYW1pYz0iMSIgZkNvbGxhcHNlZD0iMCIvPgogICAgICAgIDwvZXh0PgogICAgICA8L2V4dExzdD4KICAgIDwvYms+CiAgPC9mdXR1cmVNZXRhZGF0YT4KICA8Y2VsbE1ldGFkYXRhIGNvdW50PSIxIj4KICAgIDxiaz4KICAgICAgPHJjIHQ9IjEiIHY9IjAiLz4KICAgIDwvYms+CiAgPC9jZWxsTWV0YWRhdGE+CjwvbWV0YWRhdGE+UEsDBBQAAAAAAAAAAACYQ/HWSAEAAEgBAAAPAAAAeGwvd29ya2Jvb2sueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPHdvcmtib29rIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvc3ByZWFkc2hlZXRtbC8yMDA2L21haW4iIHhtbG5zOnI9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMiPjx3b3JrYm9va1ByIGNvZGVOYW1lPSJUaGlzV29ya2Jvb2siLz48c2hlZXRzPjxzaGVldCBuYW1lPSLllYblk4Hkv6Hmga8iIHNoZWV0SWQ9IjEiIHI6aWQ9InJJZDEiLz48L3NoZWV0cz48L3dvcmtib29rPlBLAwQUAAAAAAAAAAAASmoR+UwCAABMAgAACwAAAF9yZWxzLy5yZWxzPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPFJlbGF0aW9uc2hpcHMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcyI+PFJlbGF0aW9uc2hpcCBJZD0icklkMiIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzL21ldGFkYXRhL2NvcmUtcHJvcGVydGllcyIgVGFyZ2V0PSJkb2NQcm9wcy9jb3JlLnhtbCIvPjxSZWxhdGlvbnNoaXAgSWQ9InJJZDMiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvZXh0ZW5kZWQtcHJvcGVydGllcyIgVGFyZ2V0PSJkb2NQcm9wcy9hcHAueG1sIi8+PFJlbGF0aW9uc2hpcCBJZD0icklkMSIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9vZmZpY2VEb2N1bWVudCIgVGFyZ2V0PSJ4bC93b3JrYm9vay54bWwiLz48L1JlbGF0aW9uc2hpcHM+UEsDBBQAAAAAAAAAAACWdL84OAIAADgCAAAQAAAAZG9jUHJvcHMvYXBwLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4NCjxQcm9wZXJ0aWVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9leHRlbmRlZC1wcm9wZXJ0aWVzIiB4bWxuczp2dD0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvZG9jUHJvcHNWVHlwZXMiPjxBcHBsaWNhdGlvbj5TaGVldEpTPC9BcHBsaWNhdGlvbj48SGVhZGluZ1BhaXJzPjx2dDp2ZWN0b3Igc2l6ZT0iMiIgYmFzZVR5cGU9InZhcmlhbnQiPjx2dDp2YXJpYW50Pjx2dDpscHN0cj5Xb3Jrc2hlZXRzPC92dDpscHN0cj48L3Z0OnZhcmlhbnQ+PHZ0OnZhcmlhbnQ+PHZ0Omk0PjE8L3Z0Omk0PjwvdnQ6dmFyaWFudD48L3Z0OnZlY3Rvcj48L0hlYWRpbmdQYWlycz48VGl0bGVzT2ZQYXJ0cz48dnQ6dmVjdG9yIHNpemU9IjEiIGJhc2VUeXBlPSJscHN0ciI+PHZ0Omxwc3RyPuWVhuWTgeS/oeaBrzwvdnQ6bHBzdHI+PC92dDp2ZWN0b3I+PC9UaXRsZXNPZlBhcnRzPjwvUHJvcGVydGllcz5QSwMEFAAAAAAAAAAAANaSfBFaAQAAWgEAABEAAABkb2NQcm9wcy9jb3JlLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4NCjxjcDpjb3JlUHJvcGVydGllcyB4bWxuczpjcD0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9tZXRhZGF0YS9jb3JlLXByb3BlcnRpZXMiIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1sbnM6ZGN0ZXJtcz0iaHR0cDovL3B1cmwub3JnL2RjL3Rlcm1zLyIgeG1sbnM6ZGNtaXR5cGU9Imh0dHA6Ly9wdXJsLm9yZy9kYy9kY21pdHlwZS8iIHhtbG5zOnhzaT0iaHR0cDovL3d3dy53My5vcmcvMjAwMS9YTUxTY2hlbWEtaW5zdGFuY2UiLz5QSwMEFAAAAAAAAAAAAKjXaoAVCAAAFQgAABMAAABbQ29udGVudF9UeXBlc10ueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPFR5cGVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L2NvbnRlbnQtdHlwZXMiIHhtbG5zOnhzZD0iaHR0cDovL3d3dy53My5vcmcvMjAwMS9YTUxTY2hlbWEiIHhtbG5zOnhzaT0iaHR0cDovL3d3dy53My5vcmcvMjAwMS9YTUxTY2hlbWEtaW5zdGFuY2UiPjxEZWZhdWx0IEV4dGVuc2lvbj0ieG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24veG1sIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJiaW4iIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQubXMtZXhjZWwuc2hlZXQuYmluYXJ5Lm1hY3JvRW5hYmxlZC5tYWluIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ2bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQudm1sRHJhd2luZyIvPjxEZWZhdWx0IEV4dGVuc2lvbj0iZGF0YSIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5tb2RlbCtkYXRhIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJibXAiIENvbnRlbnRUeXBlPSJpbWFnZS9ibXAiLz48RGVmYXVsdCBFeHRlbnNpb249InBuZyIgQ29udGVudFR5cGU9ImltYWdlL3BuZyIvPjxEZWZhdWx0IEV4dGVuc2lvbj0iZ2lmIiBDb250ZW50VHlwZT0iaW1hZ2UvZ2lmIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJlbWYiIENvbnRlbnRUeXBlPSJpbWFnZS94LWVtZiIvPjxEZWZhdWx0IEV4dGVuc2lvbj0id21mIiBDb250ZW50VHlwZT0iaW1hZ2UveC13bWYiLz48RGVmYXVsdCBFeHRlbnNpb249ImpwZyIgQ29udGVudFR5cGU9ImltYWdlL2pwZWciLz48RGVmYXVsdCBFeHRlbnNpb249ImpwZWciIENvbnRlbnRUeXBlPSJpbWFnZS9qcGVnIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ0aWYiIENvbnRlbnRUeXBlPSJpbWFnZS90aWZmIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ0aWZmIiBDb250ZW50VHlwZT0iaW1hZ2UvdGlmZiIvPjxEZWZhdWx0IEV4dGVuc2lvbj0icGRmIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vcGRmIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJyZWxzIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLXBhY2thZ2UucmVsYXRpb25zaGlwcyt4bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii94bC93b3JrYm9vay54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQuc3ByZWFkc2hlZXRtbC5zaGVldC5tYWluK3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL3dvcmtzaGVldHMvc2hlZXQxLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5zcHJlYWRzaGVldG1sLndvcmtzaGVldCt4bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii94bC90aGVtZS90aGVtZTEueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LnRoZW1lK3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL3N0eWxlcy54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQuc3ByZWFkc2hlZXRtbC5zdHlsZXMreG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIvZG9jUHJvcHMvY29yZS54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtcGFja2FnZS5jb3JlLXByb3BlcnRpZXMreG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIvZG9jUHJvcHMvYXBwLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5leHRlbmRlZC1wcm9wZXJ0aWVzK3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL21ldGFkYXRhLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5zcHJlYWRzaGVldG1sLnNoZWV0TWV0YWRhdGEreG1sIi8+PC9UeXBlcz5QSwECAAAUAAAAAAAAAAAApAGEuLUCAAC1AgAAGgAAAAAAAAAAAAAAAAAAAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHNQSwECAAAUAAAAAAAAAAAAMA+Ia94dAADeHQAAEwAAAAAAAAAAAAAAAADtAgAAeGwvdGhlbWUvdGhlbWUxLnhtbFBLAQIAABQAAAAAAAAAAABV9ASUWgQAAFoEAAANAAAAAAAAAAAAAAAAAPwgAAB4bC9zdHlsZXMueG1sUEsBAgAAFAAAAAAAAAAAAGL/nmCbAgAAmwIAABgAAAAAAAAAAAAAAAAAgSUAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbFBLAQIAABQAAAAAAAAAAABggACBiAMAAIgDAAAPAAAAAAAAAAAAAAAAAFIoAAB4bC9tZXRhZGF0YS54bWxQSwECAAAUAAAAAAAAAAAAmEPx1kgBAABIAQAADwAAAAAAAAAAAAAAAAAHLAAAeGwvd29ya2Jvb2sueG1sUEsBAgAAFAAAAAAAAAAAAEpqEflMAgAATAIAAAsAAAAAAAAAAAAAAAAAfC0AAF9yZWxzLy5yZWxzUEsBAgAAFAAAAAAAAAAAAJZ0vzg4AgAAOAIAABAAAAAAAAAAAAAAAAAA8S8AAGRvY1Byb3BzL2FwcC54bWxQSwECAAAUAAAAAAAAAAAA1pJ8EVoBAABaAQAAEQAAAAAAAAAAAAAAAABXMgAAZG9jUHJvcHMvY29yZS54bWxQSwECAAAUAAAAAAAAAAAAqNdqgBUIAAAVCAAAEwAAAAAAAAAAAAAAAADgMwAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLBQYAAAAACgAKAHsCAAAmPAAAAAA=';
  var XLSX_ORDERS_B64 = 'UEsDBBQAAAAAAAAAAACkAYS4tQIAALUCAAAaAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+DQo8UmVsYXRpb25zaGlwcyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzIj48UmVsYXRpb25zaGlwIElkPSJySWQxIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3dvcmtzaGVldCIgVGFyZ2V0PSJ3b3Jrc2hlZXRzL3NoZWV0MS54bWwiLz48UmVsYXRpb25zaGlwIElkPSJySWQyIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3RoZW1lIiBUYXJnZXQ9InRoZW1lL3RoZW1lMS54bWwiLz48UmVsYXRpb25zaGlwIElkPSJySWQzIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3N0eWxlcyIgVGFyZ2V0PSJzdHlsZXMueG1sIi8+PFJlbGF0aW9uc2hpcCBJZD0icklkNCIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9zaGVldE1ldGFkYXRhIiBUYXJnZXQ9Im1ldGFkYXRhLnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAAAAAADAPiGveHQAA3h0AABMAAAB4bC90aGVtZS90aGVtZTEueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPGE6dGhlbWUgeG1sbnM6YT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL2RyYXdpbmdtbC8yMDA2L21haW4iIG5hbWU9Ik9mZmljZSBUaGVtZSI+PGE6dGhlbWVFbGVtZW50cz48YTpjbHJTY2hlbWUgbmFtZT0iT2ZmaWNlIj48YTpkazE+PGE6c3lzQ2xyIHZhbD0id2luZG93VGV4dCIgbGFzdENscj0iMDAwMDAwIi8+PC9hOmRrMT48YTpsdDE+PGE6c3lzQ2xyIHZhbD0id2luZG93IiBsYXN0Q2xyPSJGRkZGRkYiLz48L2E6bHQxPjxhOmRrMj48YTpzcmdiQ2xyIHZhbD0iMUY0OTdEIi8+PC9hOmRrMj48YTpsdDI+PGE6c3JnYkNsciB2YWw9IkVFRUNFMSIvPjwvYTpsdDI+PGE6YWNjZW50MT48YTpzcmdiQ2xyIHZhbD0iNEY4MUJEIi8+PC9hOmFjY2VudDE+PGE6YWNjZW50Mj48YTpzcmdiQ2xyIHZhbD0iQzA1MDREIi8+PC9hOmFjY2VudDI+PGE6YWNjZW50Mz48YTpzcmdiQ2xyIHZhbD0iOUJCQjU5Ii8+PC9hOmFjY2VudDM+PGE6YWNjZW50ND48YTpzcmdiQ2xyIHZhbD0iODA2NEEyIi8+PC9hOmFjY2VudDQ+PGE6YWNjZW50NT48YTpzcmdiQ2xyIHZhbD0iNEJBQ0M2Ii8+PC9hOmFjY2VudDU+PGE6YWNjZW50Nj48YTpzcmdiQ2xyIHZhbD0iRjc5NjQ2Ii8+PC9hOmFjY2VudDY+PGE6aGxpbms+PGE6c3JnYkNsciB2YWw9IjAwMDBGRiIvPjwvYTpobGluaz48YTpmb2xIbGluaz48YTpzcmdiQ2xyIHZhbD0iODAwMDgwIi8+PC9hOmZvbEhsaW5rPjwvYTpjbHJTY2hlbWU+PGE6Zm9udFNjaGVtZSBuYW1lPSJPZmZpY2UiPjxhOm1ham9yRm9udD48YTpsYXRpbiB0eXBlZmFjZT0iQ2FtYnJpYSIvPjxhOmVhIHR5cGVmYWNlPSIiLz48YTpjcyB0eXBlZmFjZT0iIi8+PGE6Zm9udCBzY3JpcHQ9IkpwYW4iIHR5cGVmYWNlPSLvvK3vvLMg77yw44K044K344OD44KvIi8+PGE6Zm9udCBzY3JpcHQ9IkhhbmciIHR5cGVmYWNlPSLrp5HsnYAg6rOg65SVIi8+PGE6Zm9udCBzY3JpcHQ9IkhhbnMiIHR5cGVmYWNlPSLlrovkvZMiLz48YTpmb250IHNjcmlwdD0iSGFudCIgdHlwZWZhY2U9IuaWsOe0sOaYjumrlCIvPjxhOmZvbnQgc2NyaXB0PSJBcmFiIiB0eXBlZmFjZT0iVGltZXMgTmV3IFJvbWFuIi8+PGE6Zm9udCBzY3JpcHQ9IkhlYnIiIHR5cGVmYWNlPSJUaW1lcyBOZXcgUm9tYW4iLz48YTpmb250IHNjcmlwdD0iVGhhaSIgdHlwZWZhY2U9IlRhaG9tYSIvPjxhOmZvbnQgc2NyaXB0PSJFdGhpIiB0eXBlZmFjZT0iTnlhbGEiLz48YTpmb250IHNjcmlwdD0iQmVuZyIgdHlwZWZhY2U9IlZyaW5kYSIvPjxhOmZvbnQgc2NyaXB0PSJHdWpyIiB0eXBlZmFjZT0iU2hydXRpIi8+PGE6Zm9udCBzY3JpcHQ9IktobXIiIHR5cGVmYWNlPSJNb29sQm9yYW4iLz48YTpmb250IHNjcmlwdD0iS25kYSIgdHlwZWZhY2U9IlR1bmdhIi8+PGE6Zm9udCBzY3JpcHQ9Ikd1cnUiIHR5cGVmYWNlPSJSYWF2aSIvPjxhOmZvbnQgc2NyaXB0PSJDYW5zIiB0eXBlZmFjZT0iRXVwaGVtaWEiLz48YTpmb250IHNjcmlwdD0iQ2hlciIgdHlwZWZhY2U9IlBsYW50YWdlbmV0IENoZXJva2VlIi8+PGE6Zm9udCBzY3JpcHQ9IllpaWkiIHR5cGVmYWNlPSJNaWNyb3NvZnQgWWkgQmFpdGkiLz48YTpmb250IHNjcmlwdD0iVGlidCIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBIaW1hbGF5YSIvPjxhOmZvbnQgc2NyaXB0PSJUaGFhIiB0eXBlZmFjZT0iTVYgQm9saSIvPjxhOmZvbnQgc2NyaXB0PSJEZXZhIiB0eXBlZmFjZT0iTWFuZ2FsIi8+PGE6Zm9udCBzY3JpcHQ9IlRlbHUiIHR5cGVmYWNlPSJHYXV0YW1pIi8+PGE6Zm9udCBzY3JpcHQ9IlRhbWwiIHR5cGVmYWNlPSJMYXRoYSIvPjxhOmZvbnQgc2NyaXB0PSJTeXJjIiB0eXBlZmFjZT0iRXN0cmFuZ2VsbyBFZGVzc2EiLz48YTpmb250IHNjcmlwdD0iT3J5YSIgdHlwZWZhY2U9IkthbGluZ2EiLz48YTpmb250IHNjcmlwdD0iTWx5bSIgdHlwZWZhY2U9IkthcnRpa2EiLz48YTpmb250IHNjcmlwdD0iTGFvbyIgdHlwZWZhY2U9IkRva0NoYW1wYSIvPjxhOmZvbnQgc2NyaXB0PSJTaW5oIiB0eXBlZmFjZT0iSXNrb29sYSBQb3RhIi8+PGE6Zm9udCBzY3JpcHQ9Ik1vbmciIHR5cGVmYWNlPSJNb25nb2xpYW4gQmFpdGkiLz48YTpmb250IHNjcmlwdD0iVmlldCIgdHlwZWZhY2U9IlRpbWVzIE5ldyBSb21hbiIvPjxhOmZvbnQgc2NyaXB0PSJVaWdoIiB0eXBlZmFjZT0iTWljcm9zb2Z0IFVpZ2h1ciIvPjxhOmZvbnQgc2NyaXB0PSJHZW9yIiB0eXBlZmFjZT0iU3lsZmFlbiIvPjwvYTptYWpvckZvbnQ+PGE6bWlub3JGb250PjxhOmxhdGluIHR5cGVmYWNlPSJDYWxpYnJpIi8+PGE6ZWEgdHlwZWZhY2U9IiIvPjxhOmNzIHR5cGVmYWNlPSIiLz48YTpmb250IHNjcmlwdD0iSnBhbiIgdHlwZWZhY2U9Iu+8re+8syDvvLDjgrTjgrfjg4Pjgq8iLz48YTpmb250IHNjcmlwdD0iSGFuZyIgdHlwZWZhY2U9IuunkeydgCDqs6DrlJUiLz48YTpmb250IHNjcmlwdD0iSGFucyIgdHlwZWZhY2U9IuWui+S9kyIvPjxhOmZvbnQgc2NyaXB0PSJIYW50IiB0eXBlZmFjZT0i5paw57Sw5piO6auUIi8+PGE6Zm9udCBzY3JpcHQ9IkFyYWIiIHR5cGVmYWNlPSJBcmlhbCIvPjxhOmZvbnQgc2NyaXB0PSJIZWJyIiB0eXBlZmFjZT0iQXJpYWwiLz48YTpmb250IHNjcmlwdD0iVGhhaSIgdHlwZWZhY2U9IlRhaG9tYSIvPjxhOmZvbnQgc2NyaXB0PSJFdGhpIiB0eXBlZmFjZT0iTnlhbGEiLz48YTpmb250IHNjcmlwdD0iQmVuZyIgdHlwZWZhY2U9IlZyaW5kYSIvPjxhOmZvbnQgc2NyaXB0PSJHdWpyIiB0eXBlZmFjZT0iU2hydXRpIi8+PGE6Zm9udCBzY3JpcHQ9IktobXIiIHR5cGVmYWNlPSJEYXVuUGVuaCIvPjxhOmZvbnQgc2NyaXB0PSJLbmRhIiB0eXBlZmFjZT0iVHVuZ2EiLz48YTpmb250IHNjcmlwdD0iR3VydSIgdHlwZWZhY2U9IlJhYXZpIi8+PGE6Zm9udCBzY3JpcHQ9IkNhbnMiIHR5cGVmYWNlPSJFdXBoZW1pYSIvPjxhOmZvbnQgc2NyaXB0PSJDaGVyIiB0eXBlZmFjZT0iUGxhbnRhZ2VuZXQgQ2hlcm9rZWUiLz48YTpmb250IHNjcmlwdD0iWWlpaSIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBZaSBCYWl0aSIvPjxhOmZvbnQgc2NyaXB0PSJUaWJ0IiB0eXBlZmFjZT0iTWljcm9zb2Z0IEhpbWFsYXlhIi8+PGE6Zm9udCBzY3JpcHQ9IlRoYWEiIHR5cGVmYWNlPSJNViBCb2xpIi8+PGE6Zm9udCBzY3JpcHQ9IkRldmEiIHR5cGVmYWNlPSJNYW5nYWwiLz48YTpmb250IHNjcmlwdD0iVGVsdSIgdHlwZWZhY2U9IkdhdXRhbWkiLz48YTpmb250IHNjcmlwdD0iVGFtbCIgdHlwZWZhY2U9IkxhdGhhIi8+PGE6Zm9udCBzY3JpcHQ9IlN5cmMiIHR5cGVmYWNlPSJFc3RyYW5nZWxvIEVkZXNzYSIvPjxhOmZvbnQgc2NyaXB0PSJPcnlhIiB0eXBlZmFjZT0iS2FsaW5nYSIvPjxhOmZvbnQgc2NyaXB0PSJNbHltIiB0eXBlZmFjZT0iS2FydGlrYSIvPjxhOmZvbnQgc2NyaXB0PSJMYW9vIiB0eXBlZmFjZT0iRG9rQ2hhbXBhIi8+PGE6Zm9udCBzY3JpcHQ9IlNpbmgiIHR5cGVmYWNlPSJJc2tvb2xhIFBvdGEiLz48YTpmb250IHNjcmlwdD0iTW9uZyIgdHlwZWZhY2U9Ik1vbmdvbGlhbiBCYWl0aSIvPjxhOmZvbnQgc2NyaXB0PSJWaWV0IiB0eXBlZmFjZT0iQXJpYWwiLz48YTpmb250IHNjcmlwdD0iVWlnaCIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBVaWdodXIiLz48YTpmb250IHNjcmlwdD0iR2VvciIgdHlwZWZhY2U9IlN5bGZhZW4iLz48L2E6bWlub3JGb250PjwvYTpmb250U2NoZW1lPjxhOmZtdFNjaGVtZSBuYW1lPSJPZmZpY2UiPjxhOmZpbGxTdHlsZUxzdD48YTpzb2xpZEZpbGw+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiLz48L2E6c29saWRGaWxsPjxhOmdyYWRGaWxsIHJvdFdpdGhTaGFwZT0iMSI+PGE6Z3NMc3Q+PGE6Z3MgcG9zPSIwIj48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6dGludCB2YWw9IjUwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMzAwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PGE6Z3MgcG9zPSIzNTAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSIzNzAwMCIvPjxhOnNhdE1vZCB2YWw9IjMwMDAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOmdzPjxhOmdzIHBvcz0iMTAwMDAwIj48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6dGludCB2YWw9IjE1MDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOmxpbiBhbmc9IjE2MjAwMDAwIiBzY2FsZWQ9IjEiLz48L2E6Z3JhZEZpbGw+PGE6Z3JhZEZpbGwgcm90V2l0aFNoYXBlPSIxIj48YTpnc0xzdD48YTpncyBwb3M9IjAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iMTAwMDAwIi8+PGE6c2hhZGUgdmFsPSIxMDAwMDAiLz48YTpzYXRNb2QgdmFsPSIxMzAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48YTpncyBwb3M9IjEwMDAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSI1MDAwMCIvPjxhOnNoYWRlIHZhbD0iMTAwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOmxpbiBhbmc9IjE2MjAwMDAwIiBzY2FsZWQ9IjAiLz48L2E6Z3JhZEZpbGw+PC9hOmZpbGxTdHlsZUxzdD48YTpsblN0eWxlTHN0PjxhOmxuIHc9Ijk1MjUiIGNhcD0iZmxhdCIgY21wZD0ic25nIiBhbGduPSJjdHIiPjxhOnNvbGlkRmlsbD48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6c2hhZGUgdmFsPSI5NTAwMCIvPjxhOnNhdE1vZCB2YWw9IjEwNTAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOnNvbGlkRmlsbD48YTpwcnN0RGFzaCB2YWw9InNvbGlkIi8+PC9hOmxuPjxhOmxuIHc9IjI1NDAwIiBjYXA9ImZsYXQiIGNtcGQ9InNuZyIgYWxnbj0iY3RyIj48YTpzb2xpZEZpbGw+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiLz48L2E6c29saWRGaWxsPjxhOnByc3REYXNoIHZhbD0ic29saWQiLz48L2E6bG4+PGE6bG4gdz0iMzgxMDAiIGNhcD0iZmxhdCIgY21wZD0ic25nIiBhbGduPSJjdHIiPjxhOnNvbGlkRmlsbD48YTpzY2hlbWVDbHIgdmFsPSJwaENsciIvPjwvYTpzb2xpZEZpbGw+PGE6cHJzdERhc2ggdmFsPSJzb2xpZCIvPjwvYTpsbj48L2E6bG5TdHlsZUxzdD48YTplZmZlY3RTdHlsZUxzdD48YTplZmZlY3RTdHlsZT48YTplZmZlY3RMc3Q+PGE6b3V0ZXJTaGR3IGJsdXJSYWQ9IjQwMDAwIiBkaXN0PSIyMDAwMCIgZGlyPSI1NDAwMDAwIiByb3RXaXRoU2hhcGU9IjAiPjxhOnNyZ2JDbHIgdmFsPSIwMDAwMDAiPjxhOmFscGhhIHZhbD0iMzgwMDAiLz48L2E6c3JnYkNscj48L2E6b3V0ZXJTaGR3PjwvYTplZmZlY3RMc3Q+PC9hOmVmZmVjdFN0eWxlPjxhOmVmZmVjdFN0eWxlPjxhOmVmZmVjdExzdD48YTpvdXRlclNoZHcgYmx1clJhZD0iNDAwMDAiIGRpc3Q9IjIzMDAwIiBkaXI9IjU0MDAwMDAiIHJvdFdpdGhTaGFwZT0iMCI+PGE6c3JnYkNsciB2YWw9IjAwMDAwMCI+PGE6YWxwaGEgdmFsPSIzNTAwMCIvPjwvYTpzcmdiQ2xyPjwvYTpvdXRlclNoZHc+PC9hOmVmZmVjdExzdD48L2E6ZWZmZWN0U3R5bGU+PGE6ZWZmZWN0U3R5bGU+PGE6ZWZmZWN0THN0PjxhOm91dGVyU2hkdyBibHVyUmFkPSI0MDAwMCIgZGlzdD0iMjMwMDAiIGRpcj0iNTQwMDAwMCIgcm90V2l0aFNoYXBlPSIwIj48YTpzcmdiQ2xyIHZhbD0iMDAwMDAwIj48YTphbHBoYSB2YWw9IjM1MDAwIi8+PC9hOnNyZ2JDbHI+PC9hOm91dGVyU2hkdz48L2E6ZWZmZWN0THN0PjxhOnNjZW5lM2Q+PGE6Y2FtZXJhIHByc3Q9Im9ydGhvZ3JhcGhpY0Zyb250Ij48YTpyb3QgbGF0PSIwIiBsb249IjAiIHJldj0iMCIvPjwvYTpjYW1lcmE+PGE6bGlnaHRSaWcgcmlnPSJ0aHJlZVB0IiBkaXI9InQiPjxhOnJvdCBsYXQ9IjAiIGxvbj0iMCIgcmV2PSIxMjAwMDAwIi8+PC9hOmxpZ2h0UmlnPjwvYTpzY2VuZTNkPjxhOnNwM2Q+PGE6YmV2ZWxUIHc9IjYzNTAwIiBoPSIyNTQwMCIvPjwvYTpzcDNkPjwvYTplZmZlY3RTdHlsZT48L2E6ZWZmZWN0U3R5bGVMc3Q+PGE6YmdGaWxsU3R5bGVMc3Q+PGE6c29saWRGaWxsPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIi8+PC9hOnNvbGlkRmlsbD48YTpncmFkRmlsbCByb3RXaXRoU2hhcGU9IjEiPjxhOmdzTHN0PjxhOmdzIHBvcz0iMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSI0MDAwMCIvPjxhOnNhdE1vZCB2YWw9IjM1MDAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOmdzPjxhOmdzIHBvcz0iNDAwMDAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iNDUwMDAiLz48YTpzaGFkZSB2YWw9Ijk5MDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PGE6Z3MgcG9zPSIxMDAwMDAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTpzaGFkZSB2YWw9IjIwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMjU1MDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOnBhdGggcGF0aD0iY2lyY2xlIj48YTpmaWxsVG9SZWN0IGw9IjUwMDAwIiB0PSItODAwMDAiIHI9IjUwMDAwIiBiPSIxODAwMDAiLz48L2E6cGF0aD48L2E6Z3JhZEZpbGw+PGE6Z3JhZEZpbGwgcm90V2l0aFNoYXBlPSIxIj48YTpnc0xzdD48YTpncyBwb3M9IjAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iODAwMDAiLz48YTpzYXRNb2QgdmFsPSIzMDAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48YTpncyBwb3M9IjEwMDAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnNoYWRlIHZhbD0iMzAwMDAiLz48YTpzYXRNb2QgdmFsPSIyMDAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48L2E6Z3NMc3Q+PGE6cGF0aCBwYXRoPSJjaXJjbGUiPjxhOmZpbGxUb1JlY3QgbD0iNTAwMDAiIHQ9IjUwMDAwIiByPSI1MDAwMCIgYj0iNTAwMDAiLz48L2E6cGF0aD48L2E6Z3JhZEZpbGw+PC9hOmJnRmlsbFN0eWxlTHN0PjwvYTpmbXRTY2hlbWU+PC9hOnRoZW1lRWxlbWVudHM+PGE6b2JqZWN0RGVmYXVsdHM+PGE6c3BEZWY+PGE6c3BQci8+PGE6Ym9keVByLz48YTpsc3RTdHlsZS8+PGE6c3R5bGU+PGE6bG5SZWYgaWR4PSIxIj48YTpzY2hlbWVDbHIgdmFsPSJhY2NlbnQxIi8+PC9hOmxuUmVmPjxhOmZpbGxSZWYgaWR4PSIzIj48YTpzY2hlbWVDbHIgdmFsPSJhY2NlbnQxIi8+PC9hOmZpbGxSZWY+PGE6ZWZmZWN0UmVmIGlkeD0iMiI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTplZmZlY3RSZWY+PGE6Zm9udFJlZiBpZHg9Im1pbm9yIj48YTpzY2hlbWVDbHIgdmFsPSJsdDEiLz48L2E6Zm9udFJlZj48L2E6c3R5bGU+PC9hOnNwRGVmPjxhOmxuRGVmPjxhOnNwUHIvPjxhOmJvZHlQci8+PGE6bHN0U3R5bGUvPjxhOnN0eWxlPjxhOmxuUmVmIGlkeD0iMiI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTpsblJlZj48YTpmaWxsUmVmIGlkeD0iMCI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTpmaWxsUmVmPjxhOmVmZmVjdFJlZiBpZHg9IjEiPjxhOnNjaGVtZUNsciB2YWw9ImFjY2VudDEiLz48L2E6ZWZmZWN0UmVmPjxhOmZvbnRSZWYgaWR4PSJtaW5vciI+PGE6c2NoZW1lQ2xyIHZhbD0idHgxIi8+PC9hOmZvbnRSZWY+PC9hOnN0eWxlPjwvYTpsbkRlZj48L2E6b2JqZWN0RGVmYXVsdHM+PGE6ZXh0cmFDbHJTY2hlbWVMc3QvPjwvYTp0aGVtZT5QSwMEFAAAAAAAAAAAAFX0BJRaBAAAWgQAAA0AAAB4bC9zdHlsZXMueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPHN0eWxlU2hlZXQgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6dnQ9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L2RvY1Byb3BzVlR5cGVzIj48bnVtRm10cyBjb3VudD0iMSI+PG51bUZtdCBudW1GbXRJZD0iNTYiIGZvcm1hdENvZGU9IiZxdW90O+S4iuWNiC/kuIvljYggJnF1b3Q7aGgmcXVvdDvmmYImcXVvdDttbSZxdW90O+WIhiZxdW90O3NzJnF1b3Q756eSICZxdW90OyIvPjwvbnVtRm10cz48Zm9udHMgY291bnQ9IjEiPjxmb250PjxzeiB2YWw9IjEyIi8+PGNvbG9yIHRoZW1lPSIxIi8+PG5hbWUgdmFsPSJDYWxpYnJpIi8+PGZhbWlseSB2YWw9IjIiLz48c2NoZW1lIHZhbD0ibWlub3IiLz48L2ZvbnQ+PC9mb250cz48ZmlsbHMgY291bnQ9IjIiPjxmaWxsPjxwYXR0ZXJuRmlsbCBwYXR0ZXJuVHlwZT0ibm9uZSIvPjwvZmlsbD48ZmlsbD48cGF0dGVybkZpbGwgcGF0dGVyblR5cGU9ImdyYXkxMjUiLz48L2ZpbGw+PC9maWxscz48Ym9yZGVycyBjb3VudD0iMSI+PGJvcmRlcj48bGVmdC8+PHJpZ2h0Lz48dG9wLz48Ym90dG9tLz48ZGlhZ29uYWwvPjwvYm9yZGVyPjwvYm9yZGVycz48Y2VsbFN0eWxlWGZzIGNvdW50PSIxIj48eGYgbnVtRm10SWQ9IjAiIGZvbnRJZD0iMCIgZmlsbElkPSIwIiBib3JkZXJJZD0iMCIvPjwvY2VsbFN0eWxlWGZzPjxjZWxsWGZzIGNvdW50PSIxIj48eGYgbnVtRm10SWQ9IjAiIGZvbnRJZD0iMCIgZmlsbElkPSIwIiBib3JkZXJJZD0iMCIgeGZJZD0iMCIgYXBwbHlOdW1iZXJGb3JtYXQ9IjEiLz48L2NlbGxYZnM+PGNlbGxTdHlsZXMgY291bnQ9IjEiPjxjZWxsU3R5bGUgbmFtZT0iTm9ybWFsIiB4ZklkPSIwIiBidWlsdGluSWQ9IjAiLz48L2NlbGxTdHlsZXM+PGR4ZnMgY291bnQ9IjAiLz48dGFibGVTdHlsZXMgY291bnQ9IjAiIGRlZmF1bHRUYWJsZVN0eWxlPSJUYWJsZVN0eWxlTWVkaXVtOSIgZGVmYXVsdFBpdm90U3R5bGU9IlBpdm90U3R5bGVNZWRpdW00Ii8+PC9zdHlsZVNoZWV0PlBLAwQUAAAAAAAAAAAAa4aK4G0FAABtBQAAGAAAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4NCjx3b3Jrc2hlZXQgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6cj0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcyI+PGRpbWVuc2lvbiByZWY9IkExOkoyIi8+PHNoZWV0Vmlld3M+PHNoZWV0VmlldyB3b3JrYm9va1ZpZXdJZD0iMCIvPjwvc2hlZXRWaWV3cz48c2hlZXREYXRhPjxyb3cgcj0iMSI+PGMgcj0iQTEiIHQ9InN0ciI+PHY+6K6i5Y2V5Y+3PC92PjwvYz48YyByPSJCMSIgdD0ic3RyIj48dj7orqLljZXnirbmgIE8L3Y+PC9jPjxjIHI9IkMxIiB0PSJzdHIiPjx2PuiuouWNlemHkeminTwvdj48L2M+PGMgcj0iRDEiIHQ9InN0ciI+PHY+6aKE6K6h5aKe5YC856iOPC92PjwvYz48YyByPSJFMSIgdD0ic3RyIj48dj5ERFDlhbPnqI48L3Y+PC9jPjxjIHI9IkYxIiB0PSJzdHIiPjx2PuW5s+WPsOaYr+WQpuS7o+W+geS7o+e8tDwvdj48L2M+PGMgcj0iRzEiIHQ9InN0ciI+PHY+5ZWG5ZOBIElEPC92PjwvYz48YyByPSJIMSIgdD0ic3RyIj48dj7llYblk4Hkv6Hmga88L3Y+PC9jPjxjIHI9IkkxIiB0PSJzdHIiPjx2PuaUtui0p+WbveWutjwvdj48L2M+PGMgcj0iSjEiIHQ9InN0ciI+PHY+5LiL5Y2V5pe26Ze0PC92PjwvYz48L3Jvdz48cm93IHI9IjIiIHhtbDpzcGFjZT0icHJlc2VydmUiPjxjIHI9IkEyIiB0PSJzdHIiPjx2Pk8tMTAwMTwvdj48L2M+PGMgcj0iQjIiIHQ9InN0ciI+PHY+562J5b6F5Y+R6LSnPC92PjwvYz48YyByPSJDMiIgdD0ic3RyIj48dj5DTu+/pSAxNjUuMTg8L3Y+PC9jPjxjIHI9IkQyIiB0PSJzdHIiPjx2PkNO77+lIDM0LjY5PC92PjwvYz48YyByPSJFMiIgdD0ic3RyIj48dj5DTu+/pSAyMi45NDwvdj48L2M+PGMgcj0iRjIiIHQ9InN0ciI+PHY+5bmz5Y+w5bey56iOPC92PjwvYz48YyByPSJHMiIgdD0ic3RyIj48dj5JVC1BLElULUI8L3Y+PC9jPjxjIHI9IkgyIiB0PSJzdHIiIHhtbDpzcGFjZT0icHJlc2VydmUiPjx2IHhtbDpzcGFjZT0icHJlc2VydmUiPuOAkDHjgJEgQeasviAo5ZWG5ZOB5pWw6YePOjEgcGllY2UpCuOAkDLjgJEgQuasviAo5ZWG5ZOB5pWw6YePOjIgcGllY2UpPC92PjwvYz48YyByPSJJMiIgdD0ic3RyIj48dj5Vbml0ZWQgU3RhdGVzPC92PjwvYz48YyByPSJKMiIgdD0ic3RyIj48dj4yMDI2LTA5LTIwIDEwOjAwOjAwPC92PjwvYz48L3Jvdz48L3NoZWV0RGF0YT48aWdub3JlZEVycm9ycz48aWdub3JlZEVycm9yIG51bWJlclN0b3JlZEFzVGV4dD0iMSIgc3FyZWY9IkExOkoyIi8+PC9pZ25vcmVkRXJyb3JzPjwvd29ya3NoZWV0PlBLAwQUAAAAAAAAAAAAYIAAgYgDAACIAwAADwAAAHhsL21ldGFkYXRhLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4NCjxtZXRhZGF0YSB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3NwcmVhZHNoZWV0bWwvMjAwNi9tYWluIiB4bWxuczp4bHJkPSJodHRwOi8vc2NoZW1hcy5taWNyb3NvZnQuY29tL29mZmljZS9zcHJlYWRzaGVldG1sLzIwMTcvcmljaGRhdGEiIHhtbG5zOnhkYT0iaHR0cDovL3NjaGVtYXMubWljcm9zb2Z0LmNvbS9vZmZpY2Uvc3ByZWFkc2hlZXRtbC8yMDE3L2R5bmFtaWNhcnJheSI+CiAgPG1ldGFkYXRhVHlwZXMgY291bnQ9IjEiPgogICAgPG1ldGFkYXRhVHlwZSBuYW1lPSJYTERBUFIiIG1pblN1cHBvcnRlZFZlcnNpb249IjEyMDAwMCIgY29weT0iMSIgcGFzdGVBbGw9IjEiIHBhc3RlVmFsdWVzPSIxIiBtZXJnZT0iMSIgc3BsaXRGaXJzdD0iMSIgcm93Q29sU2hpZnQ9IjEiIGNsZWFyRm9ybWF0cz0iMSIgY2xlYXJDb21tZW50cz0iMSIgYXNzaWduPSIxIiBjb2VyY2U9IjEiIGNlbGxNZXRhPSIxIi8+CiAgPC9tZXRhZGF0YVR5cGVzPgogIDxmdXR1cmVNZXRhZGF0YSBuYW1lPSJYTERBUFIiIGNvdW50PSIxIj4KICAgIDxiaz4KICAgICAgPGV4dExzdD4KICAgICAgICA8ZXh0IHVyaT0ie2JkYmI4Y2RjLWZhMWUtNDk2ZS1hODU3LTNjM2YzMGMwMjljM30iPgogICAgICAgICAgPHhkYTpkeW5hbWljQXJyYXlQcm9wZXJ0aWVzIGZEeW5hbWljPSIxIiBmQ29sbGFwc2VkPSIwIi8+CiAgICAgICAgPC9leHQ+CiAgICAgIDwvZXh0THN0PgogICAgPC9iaz4KICA8L2Z1dHVyZU1ldGFkYXRhPgogIDxjZWxsTWV0YWRhdGEgY291bnQ9IjEiPgogICAgPGJrPgogICAgICA8cmMgdD0iMSIgdj0iMCIvPgogICAgPC9iaz4KICA8L2NlbGxNZXRhZGF0YT4KPC9tZXRhZGF0YT5QSwMEFAAAAAAAAAAAAA6GhetCAQAAQgEAAA8AAAB4bC93b3JrYm9vay54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+DQo8d29ya2Jvb2sgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6cj0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcyI+PHdvcmtib29rUHIgY29kZU5hbWU9IlRoaXNXb3JrYm9vayIvPjxzaGVldHM+PHNoZWV0IG5hbWU9InNoZWV0MSIgc2hlZXRJZD0iMSIgcjppZD0icklkMSIvPjwvc2hlZXRzPjwvd29ya2Jvb2s+UEsDBBQAAAAAAAAAAABKahH5TAIAAEwCAAALAAAAX3JlbHMvLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+DQo8UmVsYXRpb25zaGlwcyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzIj48UmVsYXRpb25zaGlwIElkPSJySWQyIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMvbWV0YWRhdGEvY29yZS1wcm9wZXJ0aWVzIiBUYXJnZXQ9ImRvY1Byb3BzL2NvcmUueG1sIi8+PFJlbGF0aW9uc2hpcCBJZD0icklkMyIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9leHRlbmRlZC1wcm9wZXJ0aWVzIiBUYXJnZXQ9ImRvY1Byb3BzL2FwcC54bWwiLz48UmVsYXRpb25zaGlwIElkPSJySWQxIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL29mZmljZURvY3VtZW50IiBUYXJnZXQ9InhsL3dvcmtib29rLnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAAAAAAOfK5fYyAgAAMgIAABAAAABkb2NQcm9wcy9hcHAueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPFByb3BlcnRpZXMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L2V4dGVuZGVkLXByb3BlcnRpZXMiIHhtbG5zOnZ0PSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9kb2NQcm9wc1ZUeXBlcyI+PEFwcGxpY2F0aW9uPlNoZWV0SlM8L0FwcGxpY2F0aW9uPjxIZWFkaW5nUGFpcnM+PHZ0OnZlY3RvciBzaXplPSIyIiBiYXNlVHlwZT0idmFyaWFudCI+PHZ0OnZhcmlhbnQ+PHZ0Omxwc3RyPldvcmtzaGVldHM8L3Z0Omxwc3RyPjwvdnQ6dmFyaWFudD48dnQ6dmFyaWFudD48dnQ6aTQ+MTwvdnQ6aTQ+PC92dDp2YXJpYW50PjwvdnQ6dmVjdG9yPjwvSGVhZGluZ1BhaXJzPjxUaXRsZXNPZlBhcnRzPjx2dDp2ZWN0b3Igc2l6ZT0iMSIgYmFzZVR5cGU9Imxwc3RyIj48dnQ6bHBzdHI+c2hlZXQxPC92dDpscHN0cj48L3Z0OnZlY3Rvcj48L1RpdGxlc09mUGFydHM+PC9Qcm9wZXJ0aWVzPlBLAwQUAAAAAAAAAAAA1pJ8EVoBAABaAQAAEQAAAGRvY1Byb3BzL2NvcmUueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPGNwOmNvcmVQcm9wZXJ0aWVzIHhtbG5zOmNwPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L21ldGFkYXRhL2NvcmUtcHJvcGVydGllcyIgeG1sbnM6ZGM9Imh0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvIiB4bWxuczpkY3Rlcm1zPSJodHRwOi8vcHVybC5vcmcvZGMvdGVybXMvIiB4bWxuczpkY21pdHlwZT0iaHR0cDovL3B1cmwub3JnL2RjL2RjbWl0eXBlLyIgeG1sbnM6eHNpPSJodHRwOi8vd3d3LnczLm9yZy8yMDAxL1hNTFNjaGVtYS1pbnN0YW5jZSIvPlBLAwQUAAAAAAAAAAAAqNdqgBUIAAAVCAAAEwAAAFtDb250ZW50X1R5cGVzXS54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+DQo8VHlwZXMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvY29udGVudC10eXBlcyIgeG1sbnM6eHNkPSJodHRwOi8vd3d3LnczLm9yZy8yMDAxL1hNTFNjaGVtYSIgeG1sbnM6eHNpPSJodHRwOi8vd3d3LnczLm9yZy8yMDAxL1hNTFNjaGVtYS1pbnN0YW5jZSI+PERlZmF1bHQgRXh0ZW5zaW9uPSJ4bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi94bWwiLz48RGVmYXVsdCBFeHRlbnNpb249ImJpbiIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5tcy1leGNlbC5zaGVldC5iaW5hcnkubWFjcm9FbmFibGVkLm1haW4iLz48RGVmYXVsdCBFeHRlbnNpb249InZtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC52bWxEcmF3aW5nIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJkYXRhIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50Lm1vZGVsK2RhdGEiLz48RGVmYXVsdCBFeHRlbnNpb249ImJtcCIgQ29udGVudFR5cGU9ImltYWdlL2JtcCIvPjxEZWZhdWx0IEV4dGVuc2lvbj0icG5nIiBDb250ZW50VHlwZT0iaW1hZ2UvcG5nIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJnaWYiIENvbnRlbnRUeXBlPSJpbWFnZS9naWYiLz48RGVmYXVsdCBFeHRlbnNpb249ImVtZiIgQ29udGVudFR5cGU9ImltYWdlL3gtZW1mIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ3bWYiIENvbnRlbnRUeXBlPSJpbWFnZS94LXdtZiIvPjxEZWZhdWx0IEV4dGVuc2lvbj0ianBnIiBDb250ZW50VHlwZT0iaW1hZ2UvanBlZyIvPjxEZWZhdWx0IEV4dGVuc2lvbj0ianBlZyIgQ29udGVudFR5cGU9ImltYWdlL2pwZWciLz48RGVmYXVsdCBFeHRlbnNpb249InRpZiIgQ29udGVudFR5cGU9ImltYWdlL3RpZmYiLz48RGVmYXVsdCBFeHRlbnNpb249InRpZmYiIENvbnRlbnRUeXBlPSJpbWFnZS90aWZmIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJwZGYiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi9wZGYiLz48RGVmYXVsdCBFeHRlbnNpb249InJlbHMiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtcGFja2FnZS5yZWxhdGlvbnNoaXBzK3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL3dvcmtib29rLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5zcHJlYWRzaGVldG1sLnNoZWV0Lm1haW4reG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIveGwvd29ya3NoZWV0cy9zaGVldDEueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LnNwcmVhZHNoZWV0bWwud29ya3NoZWV0K3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL3RoZW1lL3RoZW1lMS54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQudGhlbWUreG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIveGwvc3R5bGVzLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5zcHJlYWRzaGVldG1sLnN0eWxlcyt4bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii9kb2NQcm9wcy9jb3JlLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1wYWNrYWdlLmNvcmUtcHJvcGVydGllcyt4bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii9kb2NQcm9wcy9hcHAueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LmV4dGVuZGVkLXByb3BlcnRpZXMreG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIveGwvbWV0YWRhdGEueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LnNwcmVhZHNoZWV0bWwuc2hlZXRNZXRhZGF0YSt4bWwiLz48L1R5cGVzPlBLAQIAABQAAAAAAAAAAACkAYS4tQIAALUCAAAaAAAAAAAAAAAAAAAAAAAAAAB4bC9fcmVscy93b3JrYm9vay54bWwucmVsc1BLAQIAABQAAAAAAAAAAAAwD4hr3h0AAN4dAAATAAAAAAAAAAAAAAAAAO0CAAB4bC90aGVtZS90aGVtZTEueG1sUEsBAgAAFAAAAAAAAAAAAFX0BJRaBAAAWgQAAA0AAAAAAAAAAAAAAAAA/CAAAHhsL3N0eWxlcy54bWxQSwECAAAUAAAAAAAAAAAAa4aK4G0FAABtBQAAGAAAAAAAAAAAAAAAAACBJQAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sUEsBAgAAFAAAAAAAAAAAAGCAAIGIAwAAiAMAAA8AAAAAAAAAAAAAAAAAJCsAAHhsL21ldGFkYXRhLnhtbFBLAQIAABQAAAAAAAAAAAAOhoXrQgEAAEIBAAAPAAAAAAAAAAAAAAAAANkuAAB4bC93b3JrYm9vay54bWxQSwECAAAUAAAAAAAAAAAASmoR+UwCAABMAgAACwAAAAAAAAAAAAAAAABIMAAAX3JlbHMvLnJlbHNQSwECAAAUAAAAAAAAAAAA58rl9jICAAAyAgAAEAAAAAAAAAAAAAAAAAC9MgAAZG9jUHJvcHMvYXBwLnhtbFBLAQIAABQAAAAAAAAAAADWknwRWgEAAFoBAAARAAAAAAAAAAAAAAAAAB01AABkb2NQcm9wcy9jb3JlLnhtbFBLAQIAABQAAAAAAAAAAACo12qAFQgAABUIAAATAAAAAAAAAAAAAAAAAKY2AABbQ29udGVudF9UeXBlc10ueG1sUEsFBgAAAAAKAAoAewIAAOw+AAAAAA==';
  var XLSX_JUNK_B64 = 'UEsDBBQAAAAAAAAAAACkAYS4tQIAALUCAAAaAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+DQo8UmVsYXRpb25zaGlwcyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzIj48UmVsYXRpb25zaGlwIElkPSJySWQxIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3dvcmtzaGVldCIgVGFyZ2V0PSJ3b3Jrc2hlZXRzL3NoZWV0MS54bWwiLz48UmVsYXRpb25zaGlwIElkPSJySWQyIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3RoZW1lIiBUYXJnZXQ9InRoZW1lL3RoZW1lMS54bWwiLz48UmVsYXRpb25zaGlwIElkPSJySWQzIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3N0eWxlcyIgVGFyZ2V0PSJzdHlsZXMueG1sIi8+PFJlbGF0aW9uc2hpcCBJZD0icklkNCIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9zaGVldE1ldGFkYXRhIiBUYXJnZXQ9Im1ldGFkYXRhLnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAAAAAADAPiGveHQAA3h0AABMAAAB4bC90aGVtZS90aGVtZTEueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPGE6dGhlbWUgeG1sbnM6YT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL2RyYXdpbmdtbC8yMDA2L21haW4iIG5hbWU9Ik9mZmljZSBUaGVtZSI+PGE6dGhlbWVFbGVtZW50cz48YTpjbHJTY2hlbWUgbmFtZT0iT2ZmaWNlIj48YTpkazE+PGE6c3lzQ2xyIHZhbD0id2luZG93VGV4dCIgbGFzdENscj0iMDAwMDAwIi8+PC9hOmRrMT48YTpsdDE+PGE6c3lzQ2xyIHZhbD0id2luZG93IiBsYXN0Q2xyPSJGRkZGRkYiLz48L2E6bHQxPjxhOmRrMj48YTpzcmdiQ2xyIHZhbD0iMUY0OTdEIi8+PC9hOmRrMj48YTpsdDI+PGE6c3JnYkNsciB2YWw9IkVFRUNFMSIvPjwvYTpsdDI+PGE6YWNjZW50MT48YTpzcmdiQ2xyIHZhbD0iNEY4MUJEIi8+PC9hOmFjY2VudDE+PGE6YWNjZW50Mj48YTpzcmdiQ2xyIHZhbD0iQzA1MDREIi8+PC9hOmFjY2VudDI+PGE6YWNjZW50Mz48YTpzcmdiQ2xyIHZhbD0iOUJCQjU5Ii8+PC9hOmFjY2VudDM+PGE6YWNjZW50ND48YTpzcmdiQ2xyIHZhbD0iODA2NEEyIi8+PC9hOmFjY2VudDQ+PGE6YWNjZW50NT48YTpzcmdiQ2xyIHZhbD0iNEJBQ0M2Ii8+PC9hOmFjY2VudDU+PGE6YWNjZW50Nj48YTpzcmdiQ2xyIHZhbD0iRjc5NjQ2Ii8+PC9hOmFjY2VudDY+PGE6aGxpbms+PGE6c3JnYkNsciB2YWw9IjAwMDBGRiIvPjwvYTpobGluaz48YTpmb2xIbGluaz48YTpzcmdiQ2xyIHZhbD0iODAwMDgwIi8+PC9hOmZvbEhsaW5rPjwvYTpjbHJTY2hlbWU+PGE6Zm9udFNjaGVtZSBuYW1lPSJPZmZpY2UiPjxhOm1ham9yRm9udD48YTpsYXRpbiB0eXBlZmFjZT0iQ2FtYnJpYSIvPjxhOmVhIHR5cGVmYWNlPSIiLz48YTpjcyB0eXBlZmFjZT0iIi8+PGE6Zm9udCBzY3JpcHQ9IkpwYW4iIHR5cGVmYWNlPSLvvK3vvLMg77yw44K044K344OD44KvIi8+PGE6Zm9udCBzY3JpcHQ9IkhhbmciIHR5cGVmYWNlPSLrp5HsnYAg6rOg65SVIi8+PGE6Zm9udCBzY3JpcHQ9IkhhbnMiIHR5cGVmYWNlPSLlrovkvZMiLz48YTpmb250IHNjcmlwdD0iSGFudCIgdHlwZWZhY2U9IuaWsOe0sOaYjumrlCIvPjxhOmZvbnQgc2NyaXB0PSJBcmFiIiB0eXBlZmFjZT0iVGltZXMgTmV3IFJvbWFuIi8+PGE6Zm9udCBzY3JpcHQ9IkhlYnIiIHR5cGVmYWNlPSJUaW1lcyBOZXcgUm9tYW4iLz48YTpmb250IHNjcmlwdD0iVGhhaSIgdHlwZWZhY2U9IlRhaG9tYSIvPjxhOmZvbnQgc2NyaXB0PSJFdGhpIiB0eXBlZmFjZT0iTnlhbGEiLz48YTpmb250IHNjcmlwdD0iQmVuZyIgdHlwZWZhY2U9IlZyaW5kYSIvPjxhOmZvbnQgc2NyaXB0PSJHdWpyIiB0eXBlZmFjZT0iU2hydXRpIi8+PGE6Zm9udCBzY3JpcHQ9IktobXIiIHR5cGVmYWNlPSJNb29sQm9yYW4iLz48YTpmb250IHNjcmlwdD0iS25kYSIgdHlwZWZhY2U9IlR1bmdhIi8+PGE6Zm9udCBzY3JpcHQ9Ikd1cnUiIHR5cGVmYWNlPSJSYWF2aSIvPjxhOmZvbnQgc2NyaXB0PSJDYW5zIiB0eXBlZmFjZT0iRXVwaGVtaWEiLz48YTpmb250IHNjcmlwdD0iQ2hlciIgdHlwZWZhY2U9IlBsYW50YWdlbmV0IENoZXJva2VlIi8+PGE6Zm9udCBzY3JpcHQ9IllpaWkiIHR5cGVmYWNlPSJNaWNyb3NvZnQgWWkgQmFpdGkiLz48YTpmb250IHNjcmlwdD0iVGlidCIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBIaW1hbGF5YSIvPjxhOmZvbnQgc2NyaXB0PSJUaGFhIiB0eXBlZmFjZT0iTVYgQm9saSIvPjxhOmZvbnQgc2NyaXB0PSJEZXZhIiB0eXBlZmFjZT0iTWFuZ2FsIi8+PGE6Zm9udCBzY3JpcHQ9IlRlbHUiIHR5cGVmYWNlPSJHYXV0YW1pIi8+PGE6Zm9udCBzY3JpcHQ9IlRhbWwiIHR5cGVmYWNlPSJMYXRoYSIvPjxhOmZvbnQgc2NyaXB0PSJTeXJjIiB0eXBlZmFjZT0iRXN0cmFuZ2VsbyBFZGVzc2EiLz48YTpmb250IHNjcmlwdD0iT3J5YSIgdHlwZWZhY2U9IkthbGluZ2EiLz48YTpmb250IHNjcmlwdD0iTWx5bSIgdHlwZWZhY2U9IkthcnRpa2EiLz48YTpmb250IHNjcmlwdD0iTGFvbyIgdHlwZWZhY2U9IkRva0NoYW1wYSIvPjxhOmZvbnQgc2NyaXB0PSJTaW5oIiB0eXBlZmFjZT0iSXNrb29sYSBQb3RhIi8+PGE6Zm9udCBzY3JpcHQ9Ik1vbmciIHR5cGVmYWNlPSJNb25nb2xpYW4gQmFpdGkiLz48YTpmb250IHNjcmlwdD0iVmlldCIgdHlwZWZhY2U9IlRpbWVzIE5ldyBSb21hbiIvPjxhOmZvbnQgc2NyaXB0PSJVaWdoIiB0eXBlZmFjZT0iTWljcm9zb2Z0IFVpZ2h1ciIvPjxhOmZvbnQgc2NyaXB0PSJHZW9yIiB0eXBlZmFjZT0iU3lsZmFlbiIvPjwvYTptYWpvckZvbnQ+PGE6bWlub3JGb250PjxhOmxhdGluIHR5cGVmYWNlPSJDYWxpYnJpIi8+PGE6ZWEgdHlwZWZhY2U9IiIvPjxhOmNzIHR5cGVmYWNlPSIiLz48YTpmb250IHNjcmlwdD0iSnBhbiIgdHlwZWZhY2U9Iu+8re+8syDvvLDjgrTjgrfjg4Pjgq8iLz48YTpmb250IHNjcmlwdD0iSGFuZyIgdHlwZWZhY2U9IuunkeydgCDqs6DrlJUiLz48YTpmb250IHNjcmlwdD0iSGFucyIgdHlwZWZhY2U9IuWui+S9kyIvPjxhOmZvbnQgc2NyaXB0PSJIYW50IiB0eXBlZmFjZT0i5paw57Sw5piO6auUIi8+PGE6Zm9udCBzY3JpcHQ9IkFyYWIiIHR5cGVmYWNlPSJBcmlhbCIvPjxhOmZvbnQgc2NyaXB0PSJIZWJyIiB0eXBlZmFjZT0iQXJpYWwiLz48YTpmb250IHNjcmlwdD0iVGhhaSIgdHlwZWZhY2U9IlRhaG9tYSIvPjxhOmZvbnQgc2NyaXB0PSJFdGhpIiB0eXBlZmFjZT0iTnlhbGEiLz48YTpmb250IHNjcmlwdD0iQmVuZyIgdHlwZWZhY2U9IlZyaW5kYSIvPjxhOmZvbnQgc2NyaXB0PSJHdWpyIiB0eXBlZmFjZT0iU2hydXRpIi8+PGE6Zm9udCBzY3JpcHQ9IktobXIiIHR5cGVmYWNlPSJEYXVuUGVuaCIvPjxhOmZvbnQgc2NyaXB0PSJLbmRhIiB0eXBlZmFjZT0iVHVuZ2EiLz48YTpmb250IHNjcmlwdD0iR3VydSIgdHlwZWZhY2U9IlJhYXZpIi8+PGE6Zm9udCBzY3JpcHQ9IkNhbnMiIHR5cGVmYWNlPSJFdXBoZW1pYSIvPjxhOmZvbnQgc2NyaXB0PSJDaGVyIiB0eXBlZmFjZT0iUGxhbnRhZ2VuZXQgQ2hlcm9rZWUiLz48YTpmb250IHNjcmlwdD0iWWlpaSIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBZaSBCYWl0aSIvPjxhOmZvbnQgc2NyaXB0PSJUaWJ0IiB0eXBlZmFjZT0iTWljcm9zb2Z0IEhpbWFsYXlhIi8+PGE6Zm9udCBzY3JpcHQ9IlRoYWEiIHR5cGVmYWNlPSJNViBCb2xpIi8+PGE6Zm9udCBzY3JpcHQ9IkRldmEiIHR5cGVmYWNlPSJNYW5nYWwiLz48YTpmb250IHNjcmlwdD0iVGVsdSIgdHlwZWZhY2U9IkdhdXRhbWkiLz48YTpmb250IHNjcmlwdD0iVGFtbCIgdHlwZWZhY2U9IkxhdGhhIi8+PGE6Zm9udCBzY3JpcHQ9IlN5cmMiIHR5cGVmYWNlPSJFc3RyYW5nZWxvIEVkZXNzYSIvPjxhOmZvbnQgc2NyaXB0PSJPcnlhIiB0eXBlZmFjZT0iS2FsaW5nYSIvPjxhOmZvbnQgc2NyaXB0PSJNbHltIiB0eXBlZmFjZT0iS2FydGlrYSIvPjxhOmZvbnQgc2NyaXB0PSJMYW9vIiB0eXBlZmFjZT0iRG9rQ2hhbXBhIi8+PGE6Zm9udCBzY3JpcHQ9IlNpbmgiIHR5cGVmYWNlPSJJc2tvb2xhIFBvdGEiLz48YTpmb250IHNjcmlwdD0iTW9uZyIgdHlwZWZhY2U9Ik1vbmdvbGlhbiBCYWl0aSIvPjxhOmZvbnQgc2NyaXB0PSJWaWV0IiB0eXBlZmFjZT0iQXJpYWwiLz48YTpmb250IHNjcmlwdD0iVWlnaCIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBVaWdodXIiLz48YTpmb250IHNjcmlwdD0iR2VvciIgdHlwZWZhY2U9IlN5bGZhZW4iLz48L2E6bWlub3JGb250PjwvYTpmb250U2NoZW1lPjxhOmZtdFNjaGVtZSBuYW1lPSJPZmZpY2UiPjxhOmZpbGxTdHlsZUxzdD48YTpzb2xpZEZpbGw+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiLz48L2E6c29saWRGaWxsPjxhOmdyYWRGaWxsIHJvdFdpdGhTaGFwZT0iMSI+PGE6Z3NMc3Q+PGE6Z3MgcG9zPSIwIj48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6dGludCB2YWw9IjUwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMzAwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PGE6Z3MgcG9zPSIzNTAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSIzNzAwMCIvPjxhOnNhdE1vZCB2YWw9IjMwMDAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOmdzPjxhOmdzIHBvcz0iMTAwMDAwIj48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6dGludCB2YWw9IjE1MDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOmxpbiBhbmc9IjE2MjAwMDAwIiBzY2FsZWQ9IjEiLz48L2E6Z3JhZEZpbGw+PGE6Z3JhZEZpbGwgcm90V2l0aFNoYXBlPSIxIj48YTpnc0xzdD48YTpncyBwb3M9IjAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iMTAwMDAwIi8+PGE6c2hhZGUgdmFsPSIxMDAwMDAiLz48YTpzYXRNb2QgdmFsPSIxMzAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48YTpncyBwb3M9IjEwMDAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSI1MDAwMCIvPjxhOnNoYWRlIHZhbD0iMTAwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOmxpbiBhbmc9IjE2MjAwMDAwIiBzY2FsZWQ9IjAiLz48L2E6Z3JhZEZpbGw+PC9hOmZpbGxTdHlsZUxzdD48YTpsblN0eWxlTHN0PjxhOmxuIHc9Ijk1MjUiIGNhcD0iZmxhdCIgY21wZD0ic25nIiBhbGduPSJjdHIiPjxhOnNvbGlkRmlsbD48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6c2hhZGUgdmFsPSI5NTAwMCIvPjxhOnNhdE1vZCB2YWw9IjEwNTAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOnNvbGlkRmlsbD48YTpwcnN0RGFzaCB2YWw9InNvbGlkIi8+PC9hOmxuPjxhOmxuIHc9IjI1NDAwIiBjYXA9ImZsYXQiIGNtcGQ9InNuZyIgYWxnbj0iY3RyIj48YTpzb2xpZEZpbGw+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiLz48L2E6c29saWRGaWxsPjxhOnByc3REYXNoIHZhbD0ic29saWQiLz48L2E6bG4+PGE6bG4gdz0iMzgxMDAiIGNhcD0iZmxhdCIgY21wZD0ic25nIiBhbGduPSJjdHIiPjxhOnNvbGlkRmlsbD48YTpzY2hlbWVDbHIgdmFsPSJwaENsciIvPjwvYTpzb2xpZEZpbGw+PGE6cHJzdERhc2ggdmFsPSJzb2xpZCIvPjwvYTpsbj48L2E6bG5TdHlsZUxzdD48YTplZmZlY3RTdHlsZUxzdD48YTplZmZlY3RTdHlsZT48YTplZmZlY3RMc3Q+PGE6b3V0ZXJTaGR3IGJsdXJSYWQ9IjQwMDAwIiBkaXN0PSIyMDAwMCIgZGlyPSI1NDAwMDAwIiByb3RXaXRoU2hhcGU9IjAiPjxhOnNyZ2JDbHIgdmFsPSIwMDAwMDAiPjxhOmFscGhhIHZhbD0iMzgwMDAiLz48L2E6c3JnYkNscj48L2E6b3V0ZXJTaGR3PjwvYTplZmZlY3RMc3Q+PC9hOmVmZmVjdFN0eWxlPjxhOmVmZmVjdFN0eWxlPjxhOmVmZmVjdExzdD48YTpvdXRlclNoZHcgYmx1clJhZD0iNDAwMDAiIGRpc3Q9IjIzMDAwIiBkaXI9IjU0MDAwMDAiIHJvdFdpdGhTaGFwZT0iMCI+PGE6c3JnYkNsciB2YWw9IjAwMDAwMCI+PGE6YWxwaGEgdmFsPSIzNTAwMCIvPjwvYTpzcmdiQ2xyPjwvYTpvdXRlclNoZHc+PC9hOmVmZmVjdExzdD48L2E6ZWZmZWN0U3R5bGU+PGE6ZWZmZWN0U3R5bGU+PGE6ZWZmZWN0THN0PjxhOm91dGVyU2hkdyBibHVyUmFkPSI0MDAwMCIgZGlzdD0iMjMwMDAiIGRpcj0iNTQwMDAwMCIgcm90V2l0aFNoYXBlPSIwIj48YTpzcmdiQ2xyIHZhbD0iMDAwMDAwIj48YTphbHBoYSB2YWw9IjM1MDAwIi8+PC9hOnNyZ2JDbHI+PC9hOm91dGVyU2hkdz48L2E6ZWZmZWN0THN0PjxhOnNjZW5lM2Q+PGE6Y2FtZXJhIHByc3Q9Im9ydGhvZ3JhcGhpY0Zyb250Ij48YTpyb3QgbGF0PSIwIiBsb249IjAiIHJldj0iMCIvPjwvYTpjYW1lcmE+PGE6bGlnaHRSaWcgcmlnPSJ0aHJlZVB0IiBkaXI9InQiPjxhOnJvdCBsYXQ9IjAiIGxvbj0iMCIgcmV2PSIxMjAwMDAwIi8+PC9hOmxpZ2h0UmlnPjwvYTpzY2VuZTNkPjxhOnNwM2Q+PGE6YmV2ZWxUIHc9IjYzNTAwIiBoPSIyNTQwMCIvPjwvYTpzcDNkPjwvYTplZmZlY3RTdHlsZT48L2E6ZWZmZWN0U3R5bGVMc3Q+PGE6YmdGaWxsU3R5bGVMc3Q+PGE6c29saWRGaWxsPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIi8+PC9hOnNvbGlkRmlsbD48YTpncmFkRmlsbCByb3RXaXRoU2hhcGU9IjEiPjxhOmdzTHN0PjxhOmdzIHBvcz0iMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSI0MDAwMCIvPjxhOnNhdE1vZCB2YWw9IjM1MDAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOmdzPjxhOmdzIHBvcz0iNDAwMDAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iNDUwMDAiLz48YTpzaGFkZSB2YWw9Ijk5MDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PGE6Z3MgcG9zPSIxMDAwMDAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTpzaGFkZSB2YWw9IjIwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMjU1MDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOnBhdGggcGF0aD0iY2lyY2xlIj48YTpmaWxsVG9SZWN0IGw9IjUwMDAwIiB0PSItODAwMDAiIHI9IjUwMDAwIiBiPSIxODAwMDAiLz48L2E6cGF0aD48L2E6Z3JhZEZpbGw+PGE6Z3JhZEZpbGwgcm90V2l0aFNoYXBlPSIxIj48YTpnc0xzdD48YTpncyBwb3M9IjAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iODAwMDAiLz48YTpzYXRNb2QgdmFsPSIzMDAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48YTpncyBwb3M9IjEwMDAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnNoYWRlIHZhbD0iMzAwMDAiLz48YTpzYXRNb2QgdmFsPSIyMDAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48L2E6Z3NMc3Q+PGE6cGF0aCBwYXRoPSJjaXJjbGUiPjxhOmZpbGxUb1JlY3QgbD0iNTAwMDAiIHQ9IjUwMDAwIiByPSI1MDAwMCIgYj0iNTAwMDAiLz48L2E6cGF0aD48L2E6Z3JhZEZpbGw+PC9hOmJnRmlsbFN0eWxlTHN0PjwvYTpmbXRTY2hlbWU+PC9hOnRoZW1lRWxlbWVudHM+PGE6b2JqZWN0RGVmYXVsdHM+PGE6c3BEZWY+PGE6c3BQci8+PGE6Ym9keVByLz48YTpsc3RTdHlsZS8+PGE6c3R5bGU+PGE6bG5SZWYgaWR4PSIxIj48YTpzY2hlbWVDbHIgdmFsPSJhY2NlbnQxIi8+PC9hOmxuUmVmPjxhOmZpbGxSZWYgaWR4PSIzIj48YTpzY2hlbWVDbHIgdmFsPSJhY2NlbnQxIi8+PC9hOmZpbGxSZWY+PGE6ZWZmZWN0UmVmIGlkeD0iMiI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTplZmZlY3RSZWY+PGE6Zm9udFJlZiBpZHg9Im1pbm9yIj48YTpzY2hlbWVDbHIgdmFsPSJsdDEiLz48L2E6Zm9udFJlZj48L2E6c3R5bGU+PC9hOnNwRGVmPjxhOmxuRGVmPjxhOnNwUHIvPjxhOmJvZHlQci8+PGE6bHN0U3R5bGUvPjxhOnN0eWxlPjxhOmxuUmVmIGlkeD0iMiI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTpsblJlZj48YTpmaWxsUmVmIGlkeD0iMCI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTpmaWxsUmVmPjxhOmVmZmVjdFJlZiBpZHg9IjEiPjxhOnNjaGVtZUNsciB2YWw9ImFjY2VudDEiLz48L2E6ZWZmZWN0UmVmPjxhOmZvbnRSZWYgaWR4PSJtaW5vciI+PGE6c2NoZW1lQ2xyIHZhbD0idHgxIi8+PC9hOmZvbnRSZWY+PC9hOnN0eWxlPjwvYTpsbkRlZj48L2E6b2JqZWN0RGVmYXVsdHM+PGE6ZXh0cmFDbHJTY2hlbWVMc3QvPjwvYTp0aGVtZT5QSwMEFAAAAAAAAAAAAFX0BJRaBAAAWgQAAA0AAAB4bC9zdHlsZXMueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPHN0eWxlU2hlZXQgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6dnQ9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L2RvY1Byb3BzVlR5cGVzIj48bnVtRm10cyBjb3VudD0iMSI+PG51bUZtdCBudW1GbXRJZD0iNTYiIGZvcm1hdENvZGU9IiZxdW90O+S4iuWNiC/kuIvljYggJnF1b3Q7aGgmcXVvdDvmmYImcXVvdDttbSZxdW90O+WIhiZxdW90O3NzJnF1b3Q756eSICZxdW90OyIvPjwvbnVtRm10cz48Zm9udHMgY291bnQ9IjEiPjxmb250PjxzeiB2YWw9IjEyIi8+PGNvbG9yIHRoZW1lPSIxIi8+PG5hbWUgdmFsPSJDYWxpYnJpIi8+PGZhbWlseSB2YWw9IjIiLz48c2NoZW1lIHZhbD0ibWlub3IiLz48L2ZvbnQ+PC9mb250cz48ZmlsbHMgY291bnQ9IjIiPjxmaWxsPjxwYXR0ZXJuRmlsbCBwYXR0ZXJuVHlwZT0ibm9uZSIvPjwvZmlsbD48ZmlsbD48cGF0dGVybkZpbGwgcGF0dGVyblR5cGU9ImdyYXkxMjUiLz48L2ZpbGw+PC9maWxscz48Ym9yZGVycyBjb3VudD0iMSI+PGJvcmRlcj48bGVmdC8+PHJpZ2h0Lz48dG9wLz48Ym90dG9tLz48ZGlhZ29uYWwvPjwvYm9yZGVyPjwvYm9yZGVycz48Y2VsbFN0eWxlWGZzIGNvdW50PSIxIj48eGYgbnVtRm10SWQ9IjAiIGZvbnRJZD0iMCIgZmlsbElkPSIwIiBib3JkZXJJZD0iMCIvPjwvY2VsbFN0eWxlWGZzPjxjZWxsWGZzIGNvdW50PSIxIj48eGYgbnVtRm10SWQ9IjAiIGZvbnRJZD0iMCIgZmlsbElkPSIwIiBib3JkZXJJZD0iMCIgeGZJZD0iMCIgYXBwbHlOdW1iZXJGb3JtYXQ9IjEiLz48L2NlbGxYZnM+PGNlbGxTdHlsZXMgY291bnQ9IjEiPjxjZWxsU3R5bGUgbmFtZT0iTm9ybWFsIiB4ZklkPSIwIiBidWlsdGluSWQ9IjAiLz48L2NlbGxTdHlsZXM+PGR4ZnMgY291bnQ9IjAiLz48dGFibGVTdHlsZXMgY291bnQ9IjAiIGRlZmF1bHRUYWJsZVN0eWxlPSJUYWJsZVN0eWxlTWVkaXVtOSIgZGVmYXVsdFBpdm90U3R5bGU9IlBpdm90U3R5bGVNZWRpdW00Ii8+PC9zdHlsZVNoZWV0PlBLAwQUAAAAAAAAAAAA5Sdo6jgCAAA4AgAAGAAAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4NCjx3b3Jrc2hlZXQgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6cj0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcyI+PGRpbWVuc2lvbiByZWY9IkExOkIyIi8+PHNoZWV0Vmlld3M+PHNoZWV0VmlldyB3b3JrYm9va1ZpZXdJZD0iMCIvPjwvc2hlZXRWaWV3cz48c2hlZXREYXRhPjxyb3cgcj0iMSI+PGMgcj0iQTEiIHQ9InN0ciI+PHY+Zm9vPC92PjwvYz48YyByPSJCMSIgdD0ic3RyIj48dj5iYXI8L3Y+PC9jPjwvcm93Pjxyb3cgcj0iMiI+PGMgcj0iQTIiIHQ9InN0ciI+PHY+MTwvdj48L2M+PGMgcj0iQjIiIHQ9InN0ciI+PHY+Mjwvdj48L2M+PC9yb3c+PC9zaGVldERhdGE+PGlnbm9yZWRFcnJvcnM+PGlnbm9yZWRFcnJvciBudW1iZXJTdG9yZWRBc1RleHQ9IjEiIHNxcmVmPSJBMTpCMiIvPjwvaWdub3JlZEVycm9ycz48L3dvcmtzaGVldD5QSwMEFAAAAAAAAAAAAGCAAIGIAwAAiAMAAA8AAAB4bC9tZXRhZGF0YS54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+DQo8bWV0YWRhdGEgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6eGxyZD0iaHR0cDovL3NjaGVtYXMubWljcm9zb2Z0LmNvbS9vZmZpY2Uvc3ByZWFkc2hlZXRtbC8yMDE3L3JpY2hkYXRhIiB4bWxuczp4ZGE9Imh0dHA6Ly9zY2hlbWFzLm1pY3Jvc29mdC5jb20vb2ZmaWNlL3NwcmVhZHNoZWV0bWwvMjAxNy9keW5hbWljYXJyYXkiPgogIDxtZXRhZGF0YVR5cGVzIGNvdW50PSIxIj4KICAgIDxtZXRhZGF0YVR5cGUgbmFtZT0iWExEQVBSIiBtaW5TdXBwb3J0ZWRWZXJzaW9uPSIxMjAwMDAiIGNvcHk9IjEiIHBhc3RlQWxsPSIxIiBwYXN0ZVZhbHVlcz0iMSIgbWVyZ2U9IjEiIHNwbGl0Rmlyc3Q9IjEiIHJvd0NvbFNoaWZ0PSIxIiBjbGVhckZvcm1hdHM9IjEiIGNsZWFyQ29tbWVudHM9IjEiIGFzc2lnbj0iMSIgY29lcmNlPSIxIiBjZWxsTWV0YT0iMSIvPgogIDwvbWV0YWRhdGFUeXBlcz4KICA8ZnV0dXJlTWV0YWRhdGEgbmFtZT0iWExEQVBSIiBjb3VudD0iMSI+CiAgICA8Yms+CiAgICAgIDxleHRMc3Q+CiAgICAgICAgPGV4dCB1cmk9IntiZGJiOGNkYy1mYTFlLTQ5NmUtYTg1Ny0zYzNmMzBjMDI5YzN9Ij4KICAgICAgICAgIDx4ZGE6ZHluYW1pY0FycmF5UHJvcGVydGllcyBmRHluYW1pYz0iMSIgZkNvbGxhcHNlZD0iMCIvPgogICAgICAgIDwvZXh0PgogICAgICA8L2V4dExzdD4KICAgIDwvYms+CiAgPC9mdXR1cmVNZXRhZGF0YT4KICA8Y2VsbE1ldGFkYXRhIGNvdW50PSIxIj4KICAgIDxiaz4KICAgICAgPHJjIHQ9IjEiIHY9IjAiLz4KICAgIDwvYms+CiAgPC9jZWxsTWV0YWRhdGE+CjwvbWV0YWRhdGE+UEsDBBQAAAAAAAAAAADm69RCSwEAAEsBAAAPAAAAeGwvd29ya2Jvb2sueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPHdvcmtib29rIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvc3ByZWFkc2hlZXRtbC8yMDA2L21haW4iIHhtbG5zOnI9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMiPjx3b3JrYm9va1ByIGNvZGVOYW1lPSJUaGlzV29ya2Jvb2siLz48c2hlZXRzPjxzaGVldCBuYW1lPSLpmo/kvr/kuIDlvKDooagiIHNoZWV0SWQ9IjEiIHI6aWQ9InJJZDEiLz48L3NoZWV0cz48L3dvcmtib29rPlBLAwQUAAAAAAAAAAAASmoR+UwCAABMAgAACwAAAF9yZWxzLy5yZWxzPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPFJlbGF0aW9uc2hpcHMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcyI+PFJlbGF0aW9uc2hpcCBJZD0icklkMiIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzL21ldGFkYXRhL2NvcmUtcHJvcGVydGllcyIgVGFyZ2V0PSJkb2NQcm9wcy9jb3JlLnhtbCIvPjxSZWxhdGlvbnNoaXAgSWQ9InJJZDMiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvZXh0ZW5kZWQtcHJvcGVydGllcyIgVGFyZ2V0PSJkb2NQcm9wcy9hcHAueG1sIi8+PFJlbGF0aW9uc2hpcCBJZD0icklkMSIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9vZmZpY2VEb2N1bWVudCIgVGFyZ2V0PSJ4bC93b3JrYm9vay54bWwiLz48L1JlbGF0aW9uc2hpcHM+UEsDBBQAAAAAAAAAAACOdyfoOwIAADsCAAAQAAAAZG9jUHJvcHMvYXBwLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4NCjxQcm9wZXJ0aWVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9leHRlbmRlZC1wcm9wZXJ0aWVzIiB4bWxuczp2dD0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvZG9jUHJvcHNWVHlwZXMiPjxBcHBsaWNhdGlvbj5TaGVldEpTPC9BcHBsaWNhdGlvbj48SGVhZGluZ1BhaXJzPjx2dDp2ZWN0b3Igc2l6ZT0iMiIgYmFzZVR5cGU9InZhcmlhbnQiPjx2dDp2YXJpYW50Pjx2dDpscHN0cj5Xb3Jrc2hlZXRzPC92dDpscHN0cj48L3Z0OnZhcmlhbnQ+PHZ0OnZhcmlhbnQ+PHZ0Omk0PjE8L3Z0Omk0PjwvdnQ6dmFyaWFudD48L3Z0OnZlY3Rvcj48L0hlYWRpbmdQYWlycz48VGl0bGVzT2ZQYXJ0cz48dnQ6dmVjdG9yIHNpemU9IjEiIGJhc2VUeXBlPSJscHN0ciI+PHZ0Omxwc3RyPumaj+S+v+S4gOW8oOihqDwvdnQ6bHBzdHI+PC92dDp2ZWN0b3I+PC9UaXRsZXNPZlBhcnRzPjwvUHJvcGVydGllcz5QSwMEFAAAAAAAAAAAANaSfBFaAQAAWgEAABEAAABkb2NQcm9wcy9jb3JlLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4NCjxjcDpjb3JlUHJvcGVydGllcyB4bWxuczpjcD0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9tZXRhZGF0YS9jb3JlLXByb3BlcnRpZXMiIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1sbnM6ZGN0ZXJtcz0iaHR0cDovL3B1cmwub3JnL2RjL3Rlcm1zLyIgeG1sbnM6ZGNtaXR5cGU9Imh0dHA6Ly9wdXJsLm9yZy9kYy9kY21pdHlwZS8iIHhtbG5zOnhzaT0iaHR0cDovL3d3dy53My5vcmcvMjAwMS9YTUxTY2hlbWEtaW5zdGFuY2UiLz5QSwMEFAAAAAAAAAAAAKjXaoAVCAAAFQgAABMAAABbQ29udGVudF9UeXBlc10ueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPFR5cGVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L2NvbnRlbnQtdHlwZXMiIHhtbG5zOnhzZD0iaHR0cDovL3d3dy53My5vcmcvMjAwMS9YTUxTY2hlbWEiIHhtbG5zOnhzaT0iaHR0cDovL3d3dy53My5vcmcvMjAwMS9YTUxTY2hlbWEtaW5zdGFuY2UiPjxEZWZhdWx0IEV4dGVuc2lvbj0ieG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24veG1sIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJiaW4iIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQubXMtZXhjZWwuc2hlZXQuYmluYXJ5Lm1hY3JvRW5hYmxlZC5tYWluIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ2bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQudm1sRHJhd2luZyIvPjxEZWZhdWx0IEV4dGVuc2lvbj0iZGF0YSIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5tb2RlbCtkYXRhIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJibXAiIENvbnRlbnRUeXBlPSJpbWFnZS9ibXAiLz48RGVmYXVsdCBFeHRlbnNpb249InBuZyIgQ29udGVudFR5cGU9ImltYWdlL3BuZyIvPjxEZWZhdWx0IEV4dGVuc2lvbj0iZ2lmIiBDb250ZW50VHlwZT0iaW1hZ2UvZ2lmIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJlbWYiIENvbnRlbnRUeXBlPSJpbWFnZS94LWVtZiIvPjxEZWZhdWx0IEV4dGVuc2lvbj0id21mIiBDb250ZW50VHlwZT0iaW1hZ2UveC13bWYiLz48RGVmYXVsdCBFeHRlbnNpb249ImpwZyIgQ29udGVudFR5cGU9ImltYWdlL2pwZWciLz48RGVmYXVsdCBFeHRlbnNpb249ImpwZWciIENvbnRlbnRUeXBlPSJpbWFnZS9qcGVnIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ0aWYiIENvbnRlbnRUeXBlPSJpbWFnZS90aWZmIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ0aWZmIiBDb250ZW50VHlwZT0iaW1hZ2UvdGlmZiIvPjxEZWZhdWx0IEV4dGVuc2lvbj0icGRmIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vcGRmIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJyZWxzIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLXBhY2thZ2UucmVsYXRpb25zaGlwcyt4bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii94bC93b3JrYm9vay54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQuc3ByZWFkc2hlZXRtbC5zaGVldC5tYWluK3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL3dvcmtzaGVldHMvc2hlZXQxLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5zcHJlYWRzaGVldG1sLndvcmtzaGVldCt4bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii94bC90aGVtZS90aGVtZTEueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LnRoZW1lK3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL3N0eWxlcy54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQuc3ByZWFkc2hlZXRtbC5zdHlsZXMreG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIvZG9jUHJvcHMvY29yZS54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtcGFja2FnZS5jb3JlLXByb3BlcnRpZXMreG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIvZG9jUHJvcHMvYXBwLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5leHRlbmRlZC1wcm9wZXJ0aWVzK3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL21ldGFkYXRhLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5zcHJlYWRzaGVldG1sLnNoZWV0TWV0YWRhdGEreG1sIi8+PC9UeXBlcz5QSwECAAAUAAAAAAAAAAAApAGEuLUCAAC1AgAAGgAAAAAAAAAAAAAAAAAAAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHNQSwECAAAUAAAAAAAAAAAAMA+Ia94dAADeHQAAEwAAAAAAAAAAAAAAAADtAgAAeGwvdGhlbWUvdGhlbWUxLnhtbFBLAQIAABQAAAAAAAAAAABV9ASUWgQAAFoEAAANAAAAAAAAAAAAAAAAAPwgAAB4bC9zdHlsZXMueG1sUEsBAgAAFAAAAAAAAAAAAOUnaOo4AgAAOAIAABgAAAAAAAAAAAAAAAAAgSUAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbFBLAQIAABQAAAAAAAAAAABggACBiAMAAIgDAAAPAAAAAAAAAAAAAAAAAO8nAAB4bC9tZXRhZGF0YS54bWxQSwECAAAUAAAAAAAAAAAA5uvUQksBAABLAQAADwAAAAAAAAAAAAAAAACkKwAAeGwvd29ya2Jvb2sueG1sUEsBAgAAFAAAAAAAAAAAAEpqEflMAgAATAIAAAsAAAAAAAAAAAAAAAAAHC0AAF9yZWxzLy5yZWxzUEsBAgAAFAAAAAAAAAAAAI53J+g7AgAAOwIAABAAAAAAAAAAAAAAAAAAkS8AAGRvY1Byb3BzL2FwcC54bWxQSwECAAAUAAAAAAAAAAAA1pJ8EVoBAABaAQAAEQAAAAAAAAAAAAAAAAD6MQAAZG9jUHJvcHMvY29yZS54bWxQSwECAAAUAAAAAAAAAAAAqNdqgBUIAAAVCAAAEwAAAAAAAAAAAAAAAACDMwAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLBQYAAAAACgAKAHsCAADJOwAAAAA=';

  // 芒果店长待发货订单样本（base64 在构建期由真实 xlsx 生成后插入 —— 解析路径必须真的走一遍 xlsx）
  var XLSX_MANGO_B64 = '${XLSX_MANGO_B64}';

  // 把四份夹具的 base64 挂到 window：**驱动脚本（另一段注入脚本）要用它合成一个"拖进来的文件"**。
  // 桥脚本是 IIFE，内部变量从外面取不到 —— 这是唯一的出口（selectExcel 的 override 用它，
  // 投放区的拖放用例也用它）。
  window.__smokeXlsxB64 = {
    orders: XLSX_ORDERS_B64, junk: XLSX_JUNK_B64, weights: XLSX_WEIGHTS_B64, mango: XLSX_MANGO_B64,
  };

  // ⭐ 「已核对 = 离开待核对列表」的开关（默认关）。
  //    宿主里 updateOrder / markOrdersCorrected 都写 corrected = 1，那一行随即不在
  //    orderList({corrected:false}) 里 —— 夹具**默认不模拟**这一步，因为本页前半段的断言
  //    要反复操作同一行（保存 → 再点名款 → 读提示），列表当场缩水那些断言就没法写。
  //    到「回车＝保存并往下走」那一段再打开（window.__emulateCorrected = true）：
  //    那一刻起夹具才与宿主对齐，而"焦点落到**顶上来**的那一条"这条断言**只有对齐后才有意义**
  //    （列表不缩水时，任何下标看上去都"对"）。
  function markCorrectedIfEmulating(id) {
    if (!window.__emulateCorrected) return;
    var n = Number(id);
    if (n && (window.__correctedIds || []).indexOf(n) < 0) window.__correctedIds.push(n);
  }

  var OVERRIDES = {
    'getAppVersion': function () { return { success: true, data: '0.0.0-smoke' }; },
    'selectExcel': function () {
      rec('selectExcel', {});
      var b64 = window.__importKind === 'junk'
        ? XLSX_JUNK_B64
        : (window.__importKind === 'orders'
          ? XLSX_ORDERS_B64
          : (window.__importKind === 'mango' ? XLSX_MANGO_B64 : XLSX_WEIGHTS_B64));
      return { success: true, data: { filePath: '/tmp/smoke-import.xlsx', data: b64ToBuf(b64) } };
    },
    'orderInsert': function (p) { rec('orderInsert', p); return { success: true, data: { id: 1 } }; },
    // 带图导入的接线点：芒果报表逐行下主图（真实实现落 oi_images，这里只回一个固定 id 供断言）
    'orderDownloadImage': function (p) { rec('orderDownloadImage', p); return { success: true, data: { id: 77, localPath: '/tmp/mango.jpg' } }; },
    'settleImport': function (p) { rec('settleImport', p); return { success: true, data: { created: 0, updated: 0, failed: [] } }; },
    'shipRateSnapshotSave': function (p) { rec('shipRateSnapshotSave', p); return { success: true, data: { id: 7, created: true, effectiveFrom: '2026-09-30' } }; },
    'get-app-version': function () { return { success: true, data: '0.0.0-smoke' }; },
    'getModuleState': function (ns) {
      if (ns === 'app-shell') return { success: true, data: { lastActiveModuleId: 'today', collapsed: false } };
      return { success: true, data: null };
    },
    'orderShippingRows': function (p) {
      rec('orderShippingRows', p);
      if (window.__emptyOrders) return { success: true, data: [] };
      // 主干一个读口：导入行与采集行在同一个返回里（按 source 区分）
      var rows = IMPORTED.concat(COLLECTED, IMPORTED_OLD);
      // ⚠️ 必须**真的**按 importDate 筛（与主进程 shippingRows 同口径：比 created_at 的日期部分）。
      //    忽略入参的话，"发货台只取今天导入的那批"这条接线在冒烟里就测不到了 ——
      //    而它恰恰是本轮改动里最容易漏传的一个参数（漏传 = 静默退回全库，界面看不出异常）。
      if (p && p.importDate) {
        rows = rows.filter(function (r) {
          return String(r.createdAt || '').slice(0, 10) === p.importDate;
        });
      }
      return { success: true, data: rows };
    },

    // 待拣：两行未发货（款 S1 黑 L 各 1 件；不给出块 → 按 1 件并标缺）。
    // ⚠️ styleName 必须有值：「按此生成拿货单」的入参要带上它（拿货单里看的是款名），
    //    夹具不给的话那一条断言只能退而求其次（形状对了、内容是空的，错法照样全绿）。
    'pickingRows': function (p) {
      rec('pickingRows', p);
      if (window.__emptyOrders) return { success: true, data: { rows: [], meta: { rows: 0, limit: 2000 } } };
      return { success: true, data: { rows: [
        { id: 1, orderNo: 'I-1', shop: '店A', orderTime: daysAgo(1) + ' 10:00:00', styleCode: 'S1', styleName: '款一',
          styleColor: '红', color: '黑', size: 'L', itemId: 'ITEM1', supplierId: 7, supplierName: '厂A',
          imagePath: '/tmp/a.jpg', shipped: false, bizStatus: '等待发货', rawFields: { '商品信息': '【1】 某款 (商品数量:1 piece)' } },
        { id: 2, orderNo: 'I-2', shop: '店A', orderTime: daysAgo(1) + ' 11:00:00', styleCode: 'S1', styleName: '款一',
          styleColor: '红', color: '黑', size: 'L', itemId: 'ITEM1', supplierId: 7, supplierName: '厂A',
          imagePath: '/tmp/a.jpg', shipped: false, bizStatus: '等待发货', rawFields: { '商品信息': '【1】 某款 (商品数量:2 piece)' } },
      ], meta: { rows: 2, limit: 2000 } } };
    },
    // 克重：只给 ITEM1 → 缺克重 0；成本表只覆盖 S2 → S1 缺成本 1 行；运价表为空 → "没有"
    // ⚠️ 真实形状是**行对象**（{item_id,name,weight_g,updated_at}）—— 给数字会把「页面拿行当数字用」这类 bug 掩盖掉（本轮真踩到）
    'productList': function (p) { rec('productList', p); return { success: true, data: { rows: [{ id: 1, code: 'S1', name: '款一', supplierId: 0, supplierName: '', category: '', status: 'active' }], total: 1 } }; },
    'productVariantList': function (p) {
      rec('productVariantList', p);
      // 只给导入行那条（S1 · 黑 · L）—— 采集行没有款色码，回不了，仍要如实计缺
      return { success: true, data: { rows: [{ id: 11, productId: 1, code: '', name: '黑 L', color: '黑', size: 'L', weightG: 275, status: 'active' }] } };
    },
    'aeCostMapList': function () {
      rec('aeCostMapList', {});
      return { success: true, data: [{ styleCode: 'S2', styleName: '款2', unitPriceCents: 1000, sampleCount: 1,
        lastBizDate: '2026-01-01', effectiveFrom: '2026-01-01', source: 'manual', updatedAt: '' }] };
    },
    'shipRateSnapshotCalc': function () { rec('shipRateSnapshotCalc', {}); return { success: true, data: { rows: [] } }; },
    'shopDbEnsure': function () { return { success: true, data: { ok: true } }; },
    'shopList': function () { return { success: true, data: { rows: [], total: 0 } }; },
    // 假桥兜底是 {success:true, data:null}，而 externalLoader 判的是 !r.data ⇒ 不补这个桩，
    // 每张截图右下角都挂一条红色 toast「扫描插件目录失败（IPC 不可用）」。
    // 真机这里返回 {root, plugins}（plugins-handlers），补桩是让夹具**忠于真形状**，
    // 不是为了消掉颜色 —— 红 toast 一直挂着会训练人忽略红 toast。
    'pluginsScan': function () { return { success: true, data: { root: '/tmp/smoke-plugins', plugins: [] } }; },
    'setModuleState': function (ns, data) { rec('setModuleState', { ns: ns, data: data }); return { success: true }; },

    // ---- 拿货域（2026-10-05「拿货」页签内建；全部是宿主现成的 purchase* 通道）----
    // 三个开关给空态用：__noGap / __noPurchaseOrders。默认关闭 = 有数据。
    'purchaseDbEnsure': function () { return { success: true, data: { ok: true } }; },
    'purchaseSupplierList': function () { rec('purchaseSupplierList', {}); return { success: true, data: SUPPLIERS }; },
    'purchaseOutstanding': function () {
      rec('purchaseOutstanding', {});
      return { success: true, data: window.__noGap ? [] : GAPS };
    },
    'purchaseIgnoreList': function () { rec('purchaseIgnoreList', {}); return { success: true, data: IGNORES }; },
    'purchaseOrderList': function () {
      rec('purchaseOrderList', {});
      return { success: true, data: window.__noPurchaseOrders ? [] : allOrders() };
    },
    // ⚠️ 按 id 查：返回"第一条"会把"点了 #2 却打开 #3"这类错掩盖掉
    'purchaseOrderGet': function (p) {
      rec('purchaseOrderGet', p);
      var hit = allOrders().filter(function (o) { return o.id === Number(p && p.id); })[0];
      return hit ? { success: true, data: hit } : { success: false, error: '拿货单不存在' };
    },
    'purchaseOrderCreate': function (p) {
      rec('purchaseOrderCreate', p);
      // 真形状：建单**落库**，随后 purchaseOrderGet(99) 要能取到（见 CREATED_ORDERS 注释）
      var items = ((p && p.items) || []).map(function (it, i) {
        return {
          id: i + 1, styleCode: it.styleCode, styleName: it.styleName, color: it.color, size: it.size,
          qty: it.qty, priceCents: it.priceCents || 0, amountCents: it.amountCents || 0,
          suggestionQty: it.suggestionQty || 0,
        };
      });
      var sup = SUPPLIERS.filter(function (s) { return s.id === Number(p && p.supplierId); })[0];
      CREATED_ORDERS.push({
        id: 99, supplierId: Number(p && p.supplierId), supplierName: sup ? sup.name : '',
        bizDate: (p && p.bizDate) || '', mode: (p && p.mode) || 'detail', status: 'draft',
        totalCents: items.reduce(function (a, it) { return a + (Number(it.amountCents) || 0); }, 0),
        editedAt: null, createdAt: '2026-10-10 12:00:00', items: items,
      });
      return { success: true, data: { id: 99 } };
    },
    'purchaseOrderUpdate': function (p) { rec('purchaseOrderUpdate', p); return { success: true }; },
    'purchaseOrderSubmit': function (p) { rec('purchaseOrderSubmit', p); return { success: true }; },
    'purchaseOrderDelete': function (p) { rec('purchaseOrderDelete', p); return { success: true }; },
    'purchaseIgnoreAdd': function (p) { rec('purchaseIgnoreAdd', p); return { success: true }; },
    'purchaseIgnoreRemove': function (p) { rec('purchaseIgnoreRemove', p); return { success: true }; },
    // 历史价：55.50 —— **故意不等于任何现有单价**，否则"回填生效没生效"看不出来
    'purchasePriceHistory': function (p) {
      rec('purchasePriceHistory', p);
      return { success: true, data: { priceCents: 5550 } };
    },
    'purchaseExportExcel': function (p) {
      rec('purchaseExportExcel', p);
      return { success: true, data: { filePath: '/tmp/purchase-smoke.xlsx' } };
    },
    // 行图取路径（编辑器明细表）：**只有 S1·黑 有图**，其余给 null ——
    // 这个不对称是两条断言的地基：S1·黑 行必须出 <img>、改成的 S9·黑 必须出「缺图」占位。
    // 路径里**带上尺码**：同款同色、只差尺码的两行必须取到**不同的图**（true 形状：订单 Excel 里
    // 每个商品行各有自己的图）。只按款色取图时这两行会拿到同一个路径 ⇒「两行图不同」那条会红。
    // 真形状：未命中就是 null，且**顺序与入参一致**（实现若把 null 与"还没查"混为一谈，缺图那条会红）。
    'purchaseStyleImages': function (p) {
      rec('purchaseStyleImages', p);
      var items = (p && p.items) || [];
      return { success: true, data: { paths: items.map(function (it) {
        if (!it || it.styleCode !== 'S1' || it.color !== '黑') return null;
        return '/fake-orders/S1-hei-' + String(it.size || 'nosize') + '.jpg';
      }) } };
    },

    // ---- 对账域（2026-10-05「结算对账」页签内建）----
    // 三行账**故意不同型**：厂A 欠 40.00（已付 80 / 拿货 120）、厂B 欠 520.00（拿货 500 / 退 20）
    //  ⇒ 四个合计各自都不等于 0，且**合计 ≠ 任一单行**（若实现只显示最后一行，断言会红）。
    'purchasePaymentList': function (p) { rec('purchasePaymentList', p); return { success: true, data: PAYMENTS }; },
    'purchasePaymentAdd': function (p) { rec('purchasePaymentAdd', p); return { success: true, data: { id: 77 } }; },
    'purchasePaymentDelete': function (p) { rec('purchasePaymentDelete', p); return { success: true }; },
    // window.__noRecon：对账清零的**反向夹具** —— 其余夹具恒有账，没有它"空态"那条路径走不到。
    // 形态 = 厂家目录还在、这个窗口里全零（不是 []，那是连厂家表都空的全新库）——
    // 真机上这就是空态的**唯一**触发点：零活动行被页面过滤掉 ⇒ 无行可渲染。
    'purchaseReconciliation': function (p) {
      rec('purchaseReconciliation', p);
      var zero = function (r) { return { supplierId: r.supplierId, supplierName: r.supplierName, purchaseCents: 0, paidCents: 0, refundCents: 0, balanceCents: 0, orderCount: 0, paymentCount: 0 }; };
      return { success: true, data: window.__noRecon ? RECON.map(zero) : RECON };
    },
    'purchaseShopAllocation': function (p) {
      rec('purchaseShopAllocation', p);
      return { success: true, data: window.__noShopAlloc ? [] : SHOP_ALLOC };
    },
    'purchaseShopAllocationDetail': function (p) { rec('purchaseShopAllocationDetail', p); return { success: true, data: SHOP_DETAIL }; },

    // ---- 归类核对域（2026-10-05「归类核对」页签内建）----
    // ⚠️ 三条待核对订单**故意一条有图 + 一条已归类 + 一条无图**：
    //    · P-41 有图未归类 / P-42 有图已归类 → 缩略图合批应当只带这两条（无图的 P-43 不能混进去，
    //      否则白跑一次往返，而"少带一条"与"带对了"在调用数上看不出区别）；
    //    · P-42 已归类 → 「归属款」下拉必须选中**它自己的款**而不是第一个选项（默认值不靠位置）。
    'orderList': function (p) {
      rec('orderList', p);
      if (window.__noPendingOrders) return { success: true, data: { rows: [], total: 0 } };
      var gone = window.__correctedIds || [];
      var reopened = window.__reopenedIds || [];
      // corrected 过滤（2026-10-11 起必须真的做）：pendingCounts 用它**分别**数
      // 「待核对」「已核对」两个数，两个数都从这一条通道出。
      // ⚠️ 原先这里忽略 corrected（两个调用返回同一批）—— 那时只有"待核对"一个数在用，
      //    没暴露；现在忽略它会让「已核对」恒等于「待核对」，页头两个数永远一样（静默错）。
      var wantCorrected = !!(p && p.corrected === true);
      var wantPending = !!(p && p.corrected === false);
      // ⭐ 2026-10-12：状态改成**按行算**（原来是从两个数组里各挑一部分拼出来）。
      //    退回会把一行从"已核对"变回"待核对"，两个数组的写法表达不了"它现在属于哪一边" ——
      //    而"退回真的把它放回了待核对队列"正是这一轮最该验的那件事。
      function isCorrected(o) {
        // 被退回的**优先**（退回是可逆动作：再点一次「确认无误」就回到已核对 —— 但这里没有
        // 那条路径的模拟，夹具只需要"退回后它是待核对"，见下面 orderMarkCorrected 的注释）
        if (reopened.indexOf(o.id) >= 0) return false;
        // 「全核完了」：待核对清空、已核对照旧有数 —— 与 __noPendingOrders（两个都清空）区分开。
        if (window.__allCorrected) return true;
        // 夹具基线（CORRECTED_ORDERS 的 corrected:true）+ 本次会话里被保存/确认过的
        return o.corrected === true || gone.indexOf(o.id) >= 0;
      }
      var all = PENDING_ORDERS.concat(CORRECTED_ORDERS);
      // 与主进程 listOrdersPage **同语义**：corrected 未传 = **不过滤**（全表），传了才按该列筛。
      // ⚠️ 这一点必须照搬，否则"corrected 过滤"这组断言是**空转**：默认分支只回"待核对"的话，
      //    列表忘了传 corrected: false 这个回归在冒烟里抓不到（表里永远不会有已核对的那些行）。
      //    这正是本仓反复踩的"夹具让断言恒绿"——夹具的结构必须与真实实现一致，不能只复刻内容。
      var base = all.filter(function (o) {
        var c = isCorrected(o);
        return wantCorrected ? c : (wantPending ? !c : true);
      });
      // 「导入日」过滤：与主进程 listOrdersPage(importDate) 同口径（比 createdAt 的日期部分）
      var rows = (p && p.importDate)
        ? base.filter(function (o) { return String(o.createdAt || '').slice(0, 10) === p.importDate; })
        : base;
      return { success: true, data: { rows: rows, total: rows.length } };
    },
    'orderStyleList': function () { rec('orderStyleList', {}); return { success: true, data: STYLES }; },
    'orderUpdate': function (p) {
      rec('orderUpdate', p);
      markCorrectedIfEmulating(p && p.id);
      return { success: true, data: { styleCode: 'S1', styleColorCode: 'S1-黑' } };
    },
    // ⭐ 点名款时宿主会**回流**「(店铺, 商品ID) → 款 + 色」（写 pl_shop_sku + 回填存量订单），
    //    结果随 skuBackfill 回来。这里刻意给**最值得说**的那一种：记住了 + 顺带归好 2 单
    //    —— 界面若不把回执说出来，用户永远不知道"记住过一次"这件事存在（下面有断言钉它）。
    // ⚠️ 回执里的款编码是**夹具固定值**（S2），不是从入参回显 —— 断言钉的是"界面把点名的款编码
    //    原样发到请求里"（看 calls('orderStyleAssign') 的载荷），别拿回执反推请求发对了。
    'orderStyleAssign': function (p) { rec('orderStyleAssign', p); return { success: true, data: { styleCode: 'S2', styleColorCode: 'S2-蓝', skuBackfill: { status: 'written', reassigned: 2, spec: '蓝', conflictCode: '' } } }; },
    'orderMarkCorrected': function (p) {
      rec('orderMarkCorrected', p);
      if (Array.isArray(p)) p.forEach(markCorrectedIfEmulating);
      return { success: true, data: { updated: Array.isArray(p) ? p.length : 2 } };
    },
    // ⭐ 「退回待核对」（2026-10-12）：把已核对的行放回待核对（corrected = 0）。
    // ⚠️ 入参是**裸数组**（真 preload 就是这个形状：orderReopenCorrected(ids) 的 { ids } 包装
    //    发生在 preload 里，而假桥替的就是 preload 上面那一层）—— 对照 orderMarkCorrected
    //    的记录值也是裸数组（[43]），两者形状必须一致，否则断言会去读一个不存在的字段。
    // ⚠️ 它**只记 id、只改状态位**：夹具若顺手改了款/色，就验不出"退回不重写上一轮的结论"了
    //    （那条判据钉在**请求载荷**上 —— 载荷里只要多了 color/styleCode 之类的字段就该红）。
    // ⚠️ 本段整块在**模板串**里 ⇒ 注释不能含反引号（会把模板串提前闭合，见文件头第 9 行）。
    'orderReopenCorrected': function (p) {
      rec('orderReopenCorrected', p);
      var ids = Array.isArray(p) ? p : [];
      var arr = window.__reopenedIds = window.__reopenedIds || [];
      ids.forEach(function (n) { if (arr.indexOf(n) < 0) arr.push(n); });
      return { success: true, data: { updated: ids.length } };
    },
    // ~~产品维度（指标条那一格）的桩 orderSkuRollup~~ **已随指标条整条撤掉（2026-10-10）**：
    // 那条通道只为页头那排"待核对 / 未归类 / 识别库 / 已配产品"而生，用户看不懂 ⇒ 整条退场
    // （handler / preload / types / ipc / classify / product-db 一并删）。留一个没人调的桩，
    // 下一个人会以为"产品维度在这一页还有覆盖"。**要用时连实现一起加回来。**
    'orderImageThumbBatch': function (p) {
      rec('orderImageThumbBatch', p);
      // ⚠️ 载荷是**裸数组**（orderImageThumbBatch(items)，见 src/types.ts 声明）；
      //    归一成 {items} 发生在 preload 里，而假桥替的就是 preload 上面那一层。
      //    写成 p.items ⇒ 恒空数组 ⇒ 缩略图永远是空占位，"图列"那条断言等于没验。
      var items = Array.isArray(p) ? p : (p && p.items) || [];
      // 给**每一条**都回一条能解码的图 dataUrl：只有真的渲染出 <img>，才说明缩略图链路接上了。
      // ⚠️ 按 localPath 生成**内容不同**的 dataUrl：全回同一条的话，「同款不同尺码的两行图不一样」
      //    这条守卫会恒绿（两行 src 永远相同）—— 那正是用户报的 bug 的形状。
      return { success: true, data: { dataUrls: items.map(function (it) {
        return svgThumb(String((it && it.localPath) || ''), shapeOf(it && it.localPath));
      }) } };
    },
    // 读**原图**（不缩放）——「点开看大图」专用（2026-10-12 新增：用户第二次报"图片展示不全"，
    // 表格缩略图放到 96px 仍看不清印花/领型 ⇒ 与「货与成本」同一套模式：点开读原图）。
    // ⚠️ 回的必须与缩略图**不同的** dataUrl、且同样能解码：否则"换上原图了"这条断言恒绿
    //    （src 压根没变也能算对）。window.__readImageFail = true 时返回 data:null
    //    ⇒ 验"读失败保留缩略图、不比现在更坏"那一支。
    'orderReadImage': function (p) {
      rec('orderReadImage', p);
      var path = String(p || '');
      var fail = !!window.__readImageFail;
      // __readImageDelay：按路径把这一条的响应**拖慢**若干毫秒。
      // ⭐ 没有它，"连点只认最后一次"这条守卫是**恒绿**的：假桥同步返回时，两次
      //    await 的 continuation 按点击顺序排队，后点的那个总在最后生效 ⇒ 坏实现也绿。
      //    真竞态是"第一次的响应晚于第二次到达，把新结果盖掉"——必须把第一次拖慢才造得出来。
      var delay = window.__readImageDelay && window.__readImageDelay[path];
      var out = function () {
        return fail ? { success: true, data: null }
          : { success: true, data: { mime: 'image/svg+xml', dataUrl: svgThumb('FULL-' + path, shapeOf(path)) } };
      };
      if (delay) return new Promise(function (res) { setTimeout(function () { res(out()); }, delay); });
      return out();
    },
    // 「复制给厂家」的图片剪贴板（2026-10-10 第二轮）：渲染层把这一家的清单画成 canvas → PNG dataURL
    // → 这个通道（真写系统剪贴板在主进程）。记下**载荷**：这里唯一能验的就是"发出去的是不是图片"。
    'writeClipboardImage': function (dataUrl) { rec('writeClipboardImage', dataUrl); return { success: true }; },
    // ~~识别链路的四个桩（orderReadImage / orderImageSave / orderApiKeyGet / orderApiKeySet）~~
    // **已随「识别未归类」一起删除（2026-10-05）**：它们只服务那条批量识别链路。
    // 假桥里留着没人用的桩会让下一个人以为"识别在这里还有覆盖" —— 要用时再加回来。
  };

  window.electronAPI = new Proxy({}, {
    get: function (_t, key) {
      if (typeof key !== 'string') return undefined;
      var fn = OVERRIDES[key];
      if (fn) return function () { return Promise.resolve(fn.apply(null, arguments)); };
      if (/^on[A-Z]/.test(key)) return function () { return function () {}; };
      // ⭐ 兜底分支顺带记一笔：**渲染层读了哪些没人实现的键**。
      //    它是为"某条通道被整条删掉之后，页面不能再读它"这类**反向断言**留的钩子 ——
      //    桩删掉之后"通道被调用了几次"恒为 0（读不到就无所谓调用），那是条恒绿的假守卫；
      //    只有记"有没有人读"才能真的红。顺带它也把"本页偷偷用了什么没实现的键"暴露出来。
      rec('__unhandled', String(key));
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
(function () { var m = document.createElement('pre'); m.id = 'assert-start'; m.textContent = 'started'; document.body.appendChild(m); })();
function step(n) { STEP = n; }
function report(name, ok, detail) { lines.push((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' | ' + detail : '')); }
function waitFor(fn, timeout) {
  return new Promise(function (resolve, reject) {
    var t0 = Date.now();
    (function tick() {
      // ⚠️ 回调必须 try/catch：它一旦抛错，Promise 永不落地 → await 挂死 → 断言结果一个字都写不出来
      // （症状是"没抓到 smoke-result"，会把排查方向带到产物/注入上去）
      var v;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > (timeout || 4000)) return reject(new Error('timeout'));
      setTimeout(tick, 30);
    })();
  });
}
function flat(el) { return el ? el.textContent.replace(/\\s+/g, ' ').trim() : ''; }
function card(act) { return document.querySelector('[data-act="' + act + '"]'); }
function queryAll(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
// 真实模块 id（构建期从 modules.config.json 插进来）—— 判"下一步"按钮指向的模块存不存在
var KNOWN_MODULES = ${JSON.stringify(KNOWN_MODULES)};
// 「发货台」页内页签的 id（构建期从 flowCtx.SHIPPING_TAB_NAMES 插进来）—— 见下 checkNextTargets
var KNOWN_TABS = ${JSON.stringify(KNOWN_TABS)};

/**
 * 回执的「下一步」按钮**必须指向真实存在的目的地**（写错 = 点了没反应，且不报错）。
 *
 * 目的地有两类（ImportNextStep 是 tab / moduleId 二选一）：
 *   · 本页页签（tab）—— 就地切页签，id ∈ KNOWN_TABS（从 flowCtx 现读）；
 *   · 别的模块（moduleId）—— 真跳转，id ∈ KNOWN_MODULES（从 modules.config.json 现读）。
 * 两类都从真来源读，不在这里抄清单 —— 抄了的话将来改配置这条断言会恒绿。
 *
 * 抽成函数是为了在**两个场景**都跑：订单回执按"店铺已归属 / 未归属"给**两组不同按钮**，
 * 只测一组等于只覆盖一半 —— 实测把它们合并成一条断言、只在其中一个场景跑时，
 * 把**已归属**那组的 id 改错，订单报表场景照样全绿（漏的正是芒果那条路径）。
 */
function checkNextTargets(tag) {
  var btns = queryAll('[data-act="import-next"] button');
  var bad = btns.filter(function (b) {
    var id = (b.getAttribute('data-act') || '').replace('import-next-', '');
    var known = KNOWN_MODULES.indexOf(id) >= 0 || KNOWN_TABS.indexOf(id) >= 0;
    return !known || flat(b).length === 0;
  });
  report('回执的「下一步」按钮都指向真实目的地（本页页签或模块）、且都带文字（' + tag + '）',
    btns.length >= 1 && bad.length === 0,
    JSON.stringify(btns.map(function (b) { return flat(b) + '->' + b.getAttribute('data-act'); })));
}
function evts(type) { return (window.__events || []).filter(function (e) { return e.type === type; }); }
function calls(name) { return (window.__smokeCalls && window.__smokeCalls[name]) || []; }

/**
 * **只数「拣货面板」自己发出的 「pickingRows」**（按入参区分调用方）。
 *
 * ⚠️ 为什么不能数总数（这是实测踩出来的假守卫）：这个 IPC 有**两个调用方** ——
 *    ① 容器每次 「reload()」 都调 「{limit:2000}」（只为页签徽标/总览卡要个汇总数）；
 *    ② 拣货面板点「生成」时调 「{shop, includeShipped}」（无 limit）。
 *    变异测试（拿掉 「:refresh-token」）时总数照样涨 —— 被 ① 满足了，
 *    于是"导入后自动重算"这条断言**恒绿**，看着像守卫其实什么都没验。
 *    判据：**拣货面板的入参没有 limit，容器的一定有**（两边形状本来就不同，别改成一样）。
 */
function pickingGenCalls() {
  return calls('pickingRows').filter(function (a) { return !a || a.limit === undefined; });
}

/**
 * 页签辅助（2026-10-05「发货台」改造后新增）。
 *
 * ⚠️ 面板是「defineAsyncComponent」**懒加载**的 ⇒ 点完页签**不能立刻**断言面板内容：
 *    必须等该面板的特征元素出现。原来的脚本是"整页都在 DOM 里"，没有这一步的概念。
 * ⚠️ 各页签的「.oc-view」是**内嵌视图自己的根类**（复用整页视图，只是藏了页头），
 *    用它当"这个面板挂上了"的判据，比找某个按钮稳（按钮会跟数据走，空库时不存在）。
 * ⚠️ 2026-10-10：原独立的「生成拣货单」页签（判据 .pk-view）**并进了「拿货」** ——
 *    拣货清单现在是「拿货」页签「要拿什么」子视图里的整页视图（PurchasePanel 内嵌），
 *    所以页面级只剩六个页签；.pk-view 仍存在，但它是**拿货面板的下属**，不再是一个页签。
 */
var PANEL_SEL = {
  overview: '[data-act="flow"]',
  import: '[data-act="import"]',
  classify: '[data-act="classify-panel"]',
  cost: '.oc-view',
  purchase: '.pu-view',
  recon: '[data-act="recon-panel"]',
};

/** 拣货清单里的一款色**卡**（2026-10-10 起是卡片网格，不再是表格行；键如 'S1 · 黑'，尺码折进卡上的 size-chip 条） */
function pickCard(key) {
  return document.querySelector('[data-act="pk-card"][data-key="' + key + '"]');
}
/** 取该卡里某个 data-act 格的文本（钉在格上，不拿整卡拼串 —— 拼串会被相邻格串味） */
function cellText(el, act) {
  var td = el && el.querySelector('[data-act="' + act + '"]');
  return td ? td.textContent.trim() : '';
}
/** 底部汇总条里某厂家那一行（一本账一行：这家什么情况 + 复制发哪家 + 一键开单） */
function sumRow(sid) {
  return document.querySelector('[data-act="pk-sum-row"][data-supplier="' + sid + '"]');
}

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
// 这里两个按钮都要在（本页是嵌入形态，supplier-action 开着 ⇒ 生成拿货单必须出现）。
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
function tabEl(id) { return document.querySelector('[data-act="tab-' + id + '"]'); }
function onTab(id) { var el = tabEl(id); return !!el && el.className.indexOf('is-on') >= 0; }
async function activateTab(id) {
  var el = tabEl(id);
  if (!el) throw new Error('没有这个页签：' + id);
  if (!onTab(id)) el.click();
  await waitFor(function () { return onTab(id) && !!document.querySelector(PANEL_SEL[id]); }, 10000);
}

/**
 * 等"上一笔导入真的做完了"再点下一次。
 *
 * ⚠️ 判据是**按钮恢复可点**，不是"结论文本出现了"：「importExcel」在拿到识别结果后还要
 *    随后还要 await load() 重拉整页，这期间 importing 仍为 true、按钮是 disabled 的 ——
 *    这一瞬点下去 .click() 会被静默忽略（实测：第三次点击连 selectExcel 都没发出去，
 *    表现成"订单报表没落库"，排查方向被带到识别逻辑上）。
 */
async function waitImportIdle() {
  await waitFor(function () {
    var b = card('import');
    return !!b && !b.disabled;
  }, 6000);
  return true;
}

/**
 * 点确认弹层的「确定」—— **先等它可点**。
 *
 * ⚠️ 弹层的确定键在 busy 期间是 disabled 的（写操作进行中不许重复提交）。
 *    而假桥的 IPC 是"立刻 resolve"，脚本常常在上一个 await 链还没走完时就跑到这里：
 *    于是点在一个 disabled 的按钮上 —— click() 静默无效，断言变成"请求没发出去"，
 *    排查方向会被带到"确认弹层没接上"上（实测：删除那一条就是这么假红的）。
 */
async function confirmOk() {
  await waitFor(function () {
    var b = card('confirm-ok');
    return !!b && !b.disabled;
  }, 8000);
  card('confirm-ok').click();
  await waitFor(function () { return !card('confirm-dialog'); }, 8000);
}

/** 点容器页头的「刷新」——同样要**先等它可点**（loading 期间它是 disabled 的） */
async function clickRefresh() {
  await waitFor(function () {
    var b = card('refresh');
    return !!b && !b.disabled;
  }, 8000);
  card('refresh').click();
}

/**
 * 点一个按钮 —— **先等它可点**。
 *
 * ⚠️ 与 confirmOk 同一条教训，只是换了个对象：页面上凡"写操作期间自锁"的按钮
 *    （保存 / 确认无误 / 全部确认 / 登记付款）在 busy 期间都是 disabled 的。
 *    假桥的 IPC 立刻 resolve，脚本常常在上一个 await 链还没走完时跑到下一步：
 *    点在一个 disabled 的按钮上 → .click() 静默无效 → 断言变成"请求没发出去"，
 *    排查方向会被带到"接线没接上"（实测：cl-all-ok 就是这么假红的）。
 */
async function clickReady(act, timeout) {
  await waitFor(function () {
    var b = card(act);
    return !!b && !b.disabled;
  }, timeout || 8000);
  card(act).click();
}

async function main() {
  try {
    step('boot');
    await waitFor(function () { return document.querySelector('.td-view'); }, 10000);
    report('挂载：今天页渲染', true);
    await waitFor(function () { return flat(card('card-orders')).indexOf('行') >= 0; }, 8000);

    step('tabs');
    // 页签栏（2026-10-05「发货台」改造）：五步 + 总览 = 六个。
    //   2026-10-10：原第 3 步「生成拣货单」并进「拿货」⇒ 六步 → 五步，页签少一个。
    // ⚠️ 「懒加载」也要验：只断言"页签在"不够 —— 面板若是全量挂载，六个整页视图
    //    （算钱上千行、各自取数）会在进页面时一起跑，表现是打开就很慢。
    var tabIds = ['overview', 'import', 'classify', 'cost', 'purchase', 'recon'];
    report('页签栏：六个页签齐全（总览 + 五步）',
      tabIds.every(function (id) { return !!tabEl(id); }),
      tabIds.map(function (id) { return id + '=' + !!tabEl(id); }).join(' '));
    report('进入页面默认落在「总览」', onTab('overview'), '');
    // 自证非空转：KNOWN_TABS 解析失败会返回 []，于是"回执的下一步指向真实页签"那条守卫
    // 悄悄退化成"只认模块 id"（页签类按钮全被判悬空 → 假红；或反过来配上副本 → 恒绿）。
    report('页签 id 清单从 flowCtx 真的读到了（否则"下一步"的页签守卫是空转的）',
      KNOWN_TABS.length >= 5 && KNOWN_TABS.indexOf('classify') >= 0 && KNOWN_TABS.indexOf('purchase') >= 0,
      JSON.stringify(KNOWN_TABS));
    report('懒加载：还没点过的页签，面板一个都没挂载（DOM 里查不到）',
      !document.querySelector('.oc-view') && !document.querySelector('.pu-view') &&
        !document.querySelector('[data-act="classify-panel"]') &&
        !document.querySelector('[data-act="recon-panel"]'), '');

    step('flow');
    // 发货主线（2026-10-05「发货台」改造后）：**五步**齐全 + 每步标明"在本页哪个页签做"
    //   + 当前步高亮 + 「下一步」是切页签（不再跳模块）。
    //   2026-10-10：原第 3 步「生成拣货单」并进「拿货」⇒ 六步 → 五步（flow-picking 卡不存在了）。
    //   ⚠️ 这段会点一次 flow-next，**必须清掉 __events**，
    //   否则后面按 evts('switch-module')[0] 取的断言会读到我这条（假红）。
    var flowKeys = ['import', 'classify', 'cost', 'purchase', 'recon'];
    await waitFor(function () {
      var el = card('flow-classify');
      return !!el && flat(el).indexOf('未识别款') >= 0;   // 等到 gaps 也算出来（flow 依赖它）
    }, 8000);
    report('发货主线：五步齐全（导入 / 归类 / 算钱 / 拿货 / 对账）',
      flowKeys.every(function (k) { return !!card('flow-' + k); }),
      flowKeys.map(function (k) { return k + '=' + !!card('flow-' + k); }).join(' '));
    // 「在哪做」的语义变了：以前是"跳去哪个模块"，现在是"本页的哪个页签"。
    // 反向守卫：不许再出现模块 id 字面量（picking / order-cost）—— 那是漏改的旧文案，
    // 用户看到会以为还要跳走（旧文案就是这么写的）。
    report('发货主线：每一步都标明"在本页哪个页签做"（且不写模块 id）',
      flowKeys.every(function (k) {
        var t = flat(card('flow-' + k));
        return t.indexOf('本页') >= 0 && t.indexOf('picking') < 0 && t.indexOf('order-cost') < 0;
      }) &&
        flat(card('flow-purchase')).indexOf('拿货') >= 0 &&
        flat(card('flow-cost')).indexOf('算钱') >= 0,
      flowKeys.map(function (k) { return flat(card('flow-' + k)); }).join(' | '));
    // 假桥数据：2 行订单（1 采集 + 1 导入），采集行无款编码 → 第 2 步是当前步
    report('当前步高亮：有未识别款 → 第 2 步「归类核对」是 now',
      !!card('flow-classify') && card('flow-classify').className.indexOf('is-now') >= 0,
      card('flow-classify') ? card('flow-classify').className : 'no-card');
    report('已完成的那步打 done（有订单 → 第 1 步 done）',
      !!card('flow-import') && card('flow-import').className.indexOf('is-done') >= 0,
      card('flow-import') ? card('flow-import').className : 'no-card');
    // ⚠️ 这条是拍图拍出来的：最初各步独立判断 → 有未识别款时第 2/3/4 步同时高亮，
    //    "当前该做哪一步"反而答不出来。串联语义：前一步没完成，后面的只能是 todo 且写明等谁。
    report('当前步唯一：高亮（now/gap）的步骤数 = 1，且第 2 步未完成时第 3/4 步是 todo 并写明「等第 2 步」',
      queryAll('.td-flow__step.is-now, .td-flow__step.is-gap').length === 1 &&
        card('flow-classify').className.indexOf('is-now') >= 0 &&
        card('flow-purchase').className.indexOf('is-todo') >= 0 &&
        card('flow-cost').className.indexOf('is-todo') >= 0 &&
        flat(card('flow-purchase')).indexOf('等第 2 步') >= 0 &&
        flat(card('flow-cost')).indexOf('等第 2 步') >= 0,
      '高亮数=' + queryAll('.td-flow__step.is-now, .td-flow__step.is-gap').length +
        ' | ' + [card('flow-purchase'), card('flow-cost')].map(function (el) { return flat(el); }).join(' | '));
    report('「下一步」按钮跟着当前步走（当前步 = 归类核对）',
      !!document.querySelector('[data-act="flow-next-classify"]'),
      card('flow-next') ? flat(card('flow-next')) : 'no-next');
    report('五步全部在本页页签里（流程卡不再有"在插件里"的步骤、也不给"去插件"的岔路）',
      flat(card('flow')).indexOf('插件') < 0 &&
        flat(card('flow-purchase')).indexOf('本页') >= 0 &&
        flat(card('flow-recon')).indexOf('本页') >= 0,
      'purchase=' + flat(card('flow-purchase')) + ' | recon=' + flat(card('flow-recon')));

    // ⚠️ **本次改造的核心判据**：点流程卡**不许跳页**。两条一起才成立 ——
    //    ① 目标页签被选中且它的面板真的挂上了；
    //    ② 这一路上**一个 switch-module 都没派发**（那是"跳页"的唯一出口，全仓只有外壳在听）。
    //    只断言 ① 会假绿：旧实现点下去也"到了"归类页，只不过是跳走实现的。
    var swBefore = evts('switch-module').length;
    document.querySelector('[data-act="flow-next-classify"]').click();
    await waitFor(function () { return onTab('classify'); }, 6000);
    await waitFor(function () { return !!document.querySelector(PANEL_SEL.classify); }, 8000);
    report('点流程卡 = 就地切页签（停在「今天」页，页签变选中、面板换内容）',
      onTab('classify') && !!document.querySelector('[data-act="classify-panel"]'), '');
    report('切页签不派发 switch-module（"不跳页"的判据）',
      evts('switch-module').length === swBefore,
      'switch-module=' + evts('switch-module').length);
    window.__events.length = 0;   // ⚠️ 别把上面这次点击留给后面按 [0] 取的断言
    await activateTab('overview');   // 后面的卡断言都在总览页签上（保活：切回来内容还在）

    step('orders');
    var o = flat(card('card-orders'));
    report('订单卡：总数 + 两条来源分开计数', o.indexOf('2 行') >= 0 && o.indexOf('采集 1 行') >= 0 && o.indexOf('导入 1 行') >= 0, o);
    report('订单卡：显示最近下单日期（可核对）', /最近下单 \\d{4}-\\d{2}-\\d{2}/.test(o), o);
    // ---- 口径：发货台只数**今天导入**的那批（2026-10-11 新增）--------------------------------
    // ① 卡上必须**写明口径**：没有标签时那个「2 行」会被读成"库里一共 2 行"，而库里的数在
    //    「导入订单」页签（问"库里有几行"的地方在那儿）—— 同一页两个数不一样时，用户没法判断谁对。
    //    标签就是这个数字的作用域。
    var scopeEl = card('card-orders') && card('card-orders').querySelector('[data-act="orders-scope"]');
    report('订单卡：口径标签「今天导入」在卡片标题行（数字的作用域，不是全库）',
      !!scopeEl && flat(scopeEl).indexOf('今天导入') >= 0, scopeEl ? flat(scopeEl) : 'no-scope');
    // ② **反向夹具**坐实"真的按导入日筛"：夹具里有一行 IMPORTED_OLD（**三天前**导进来、orderTime 与今天
    //    那两行同形），它必须**不在**这个计数里 —— 漏传 importDate 会静默退回全库，这里就成 3 行。
    //    ⚠️ 只断言"等于 2"不够自证：把 OLD 行从夹具里去掉，"漏传"照样是 2 ⇒ 恒绿。
    //    OLD 行就是让"漏传"这个错误**可造**的那一半（本仓"夹具让断言空转"的老毛病）。
    report('订单卡：**只数今天导入的**（三天前导进来的那行不准算 —— 漏传 importDate 这里会变 3 行）',
      o.indexOf('2 行') >= 0 && o.indexOf('3 行') < 0, o);

    step('picking-card');
    var p = flat(card('card-picking'));
    report('待拣卡：同一 SKU 合一组 = 1 个 SKU / 3 件（1+2 件）/ 涉及 2 单',
      p.indexOf('1 个 SKU') >= 0 && p.indexOf('3 件') >= 0 && p.indexOf('涉及订单 2') >= 0, p);
    report('待拣卡：范围写在卡上（未发货 · 近 30 天）', /未发货 · 近 30 天/.test(p), p);
    report('待拣走的是拣货那位"同一份纯函数"（调了 pickingRows）', calls('pickingRows').length >= 1);

    step('gaps');
    var g = flat(card('card-gaps'));
    // 口径（2026-10-01 收紧）：缺克重是**行级**，且与「算钱」同一份判定（resolveWeightG）——
    //   导入行没有"商品ID 克重"，但按款色码（S1 · 黑 · L）回落到了产品库 SKU 克重 → **不算缺**；
    //   采集行没有款色码也认不出商品ID → 回不了，如实计 1 行。
    report('缺克重按**行**计，且回落生效：导入行（款色码对得上）不算缺 → 只剩采集行 1 行',
      g.indexOf('缺克重 1 行') >= 0, g);
    report('「今天」也去产品库取过 SKU 克重（与「算钱」同一份回落口径）',
      calls('productList').length >= 1 && calls('productVariantList').length >= 1,
      'productList=' + calls('productList').length + ' variantList=' + calls('productVariantList').length);
    report('缺克重 > 0 时给「去「货与成本」补 SKU 克重」按钮（按钮跟着数据走，且指向真实存在的入口）',
      !!card('card-gaps').querySelector('button[data-act="go-goods"]') &&
        flat(card('card-gaps')).indexOf('货与成本') >= 0, g);
    report('缺口卡：缺克重 1 / 缺成本 1（成本表只覆盖 S2）/ 未识别款 1（采集行无款编码）/ 运价表没有',
      g.indexOf('缺成本 1 行') >= 0 && g.indexOf('未识别款 1 行') >= 0 && g.indexOf('运价表 没有') >= 0, g);
    report('缺口卡：总数 = 缺克重 1 + 缺成本 1 + 未识别款 1 + 无运价表 1 = 4 项', g.indexOf('还缺 4 项') >= 0, g);
    report('缺成本/未识别款时有「货与成本」就地入口（不只让用户看缺口）',
      !!card('card-gaps').querySelector('button[data-act="go-goods"]'), g);

    step('import');
    // 「商品信息」表：2026-10-01 起**不再是可导入类型**（克重是 SKU 属性，商品ID 上没有克重）。
    // 用户真拿它来导时，必须给一句**指路**（不许干说"认不出"），且**一个字节都不写库**。
    // ⚠️ 导入按钮与回执现在都在「导入订单」页签里（以前在页头，是全页共用的）⇒ 先切过去。
    await activateTab('import');
    var beforeWrites = calls('settleImport').length + calls('shipRateSnapshotSave').length + calls('orderInsert').length;
    await waitImportIdle();
    document.querySelector('[data-act="import"]').click();
    await waitFor(function () { return calls('selectExcel').length >= 1; }, 6000);
    await waitFor(function () {
      var el = document.querySelector('[data-act="import-title"]');
      return el && flat(el).indexOf('商品信息') >= 0;
    }, 8000);
    var irText = flat(document.querySelector('[data-act="import-result"]'));
    // 判据**钉在 data-act 上**，不再拿整段 textContent 拼串 —— 回执卡现在有标题/明细/落点/按钮四段，
    // 整串比对会因为拆元素而假红（相邻元素间 textContent 不插分隔符），也会因为"别处恰好也有这个词"而假绿。
    report('商品信息表：判据里写明"这类文件不用再导入"',
      flat(document.querySelector('[data-act="import-detail"]')).indexOf('不用再导入') >= 0, irText);
    report('商品信息表：给的是**可点的下一步**（去「货与成本」按 SKU 维护克重），不是一句空指引',
      flat(document.querySelector('[data-act="import-next"]')).indexOf('货与成本') >= 0 &&
        !!document.querySelector('button[data-act="import-next-goods"]'),
      irText);
    report('商品信息表：一个字节都不写库（它没有可落的表了）',
      calls('settleImport').length + calls('shipRateSnapshotSave').length + calls('orderInsert').length === beforeWrites, irText);

    // 认不出的文件：同样只解释、不写库
    window.__importKind = 'junk';
    await waitImportIdle();
    document.querySelector('[data-act="import"]').click();
    await waitFor(function () { return calls('selectExcel').length >= 2; }, 6000);
    // ⚠️ 判据钉在**标题**上，不钉在整段 message 上：商品信息表那条 message **也含"没认出"**
    //    （模板开头就是"没认出这个文件是什么"）⇒ 拿它当完成信号会**在上一条还在时立刻满足**，
    //    后面所有断言都会读着旧回执做（实测：把"认不出时不给下一步按钮"判成了红）。
    await waitFor(function () {
      var el = document.querySelector('[data-act="import-title"]');
      return el && flat(el).indexOf('没认出') >= 0;
    }, 8000);
    report('认不出的文件：只解释、不写库（结论留在界面上可核对）',
      calls('settleImport').length + calls('shipRateSnapshotSave').length + calls('orderInsert').length === beforeWrites,
      flat(document.querySelector('[data-act="import-result"]')));
    // 反向守卫：认不出时**不能**硬塞一个"下一步"（没有可去的地方，塞了就是把用户送去瞎点）
    report('认不出的文件：不给「下一步」按钮',
      !document.querySelector('[data-act="import-next"]'),
      flat(document.querySelector('[data-act="import-result"]')));

    step('import-orders');
    // S2-b：订单报表**免图导入** —— 多产品行要拆、无主图列照样落主干（imageId=null）
    window.__importKind = 'orders';
    await waitImportIdle();
    document.querySelector('[data-act="import"]').click();
    try {
      await waitFor(function () { return calls('orderInsert').length >= 2; }, 8000);
    } catch (e) {
      // 失败时把现场带出来：光"timeout"会让人分不清是识别错了、还是识别对了但落库抛错
      throw new Error('订单报表没有落库：orderInsert=' + calls('orderInsert').length +
        ' selectExcel=' + calls('selectExcel').length +
        ' 结论=' + flat(document.querySelector('[data-act="import-result"]')) +
        ' 错误=' + flat(document.querySelector('.td-error')));
    }
    var ins = calls('orderInsert');
    report('订单报表 → 多产品行拆成两行落主干（每行一个商品ID）',
      ins.length === 2 && ins[0].rawFields['商品 ID'].indexOf('IT-A') >= 0 && ins[1].rawFields['商品 ID'].indexOf('IT-B') >= 0,
      JSON.stringify(ins.map(function (x) { return x.rawFields['商品 ID']; })));
    report('无主图列也照常落库（imageId 为 null）',
      ins.every(function (x) { return x.imageId === null; }), String(ins[0].imageId));
    report('订单号/下单时间带进 payload（金额提列在主进程做）',
      ins[0].orderNo === 'O-1001' && String(ins[0].orderTime || '').indexOf('2026-09-20') >= 0,
      JSON.stringify({ o: ins[0].orderNo, t: ins[0].orderTime }));
    var ordTitle = flat(document.querySelector('[data-act="import-title"]'));
    var ordDetail = flat(document.querySelector('[data-act="import-detail"]'));
    report('回执把"是什么"（标题）与"凭什么这么判"（明细）分开渲染',
      ordTitle.indexOf('订单报表') >= 0 &&
        ordDetail.indexOf('订单报表') >= 0 &&
        ordDetail.indexOf('归到该店') >= 0,
      JSON.stringify({ title: ordTitle, detail: ordDetail }));

    // ---- 结论卡（2026-10-11 重做）--------------------------------------------
    // 用户实报「导完记录不知道去哪了、反馈信息模糊、文字太多、完全看不懂」。
    // 这一层要钉的是**层次**而不只是"文案里有这几个字"：
    //   ① 大字结论（import-headline）独立存在，且**真的比明细大**（读计算样式，不读 class 名）；
    //   ② 判据（import-detail）**默认折叠**，点一下能展开 —— 否则"折叠"只写在样式上，
    //      用户根本找不到展开的入口（文案还在，只是永远看不见）。
    //   ③ 异常行只在**真的出事**时出现（本次导入没有跳过/没有主图失败 ⇒ import-warn 不该在）。
    var headlineEl = document.querySelector('[data-act="import-headline"]');
    var detailEl = document.querySelector('[data-act="import-detail"]');
    var hlSize = headlineEl ? parseFloat(getComputedStyle(headlineEl).fontSize) : 0;
    var dtSize = detailEl ? parseFloat(getComputedStyle(detailEl).fontSize) : 0;
    report('回执有一行**大字结论**（"已导入 2 行订单"），且字号真的比判据大（读计算样式）',
      !!headlineEl && flat(headlineEl).indexOf('已导入 2 行订单') >= 0 && hlSize > dtSize,
      'headline=' + (headlineEl ? flat(headlineEl) : '无') +
        ' 字号 ' + hlSize + ' vs 明细 ' + dtSize);

    var moreEl = detailEl ? detailEl.closest('details') : null;
    var toggleEl = document.querySelector('[data-act="import-detail-toggle"]');
    var collapsedBefore = !!moreEl && moreEl.open === false;
    if (toggleEl) toggleEl.click();
    await waitFor(function () {
      var d = document.querySelector('[data-act="import-detail"]');
      return !!d && !!d.closest('details') && d.closest('details').open === true;
    }, 2000).catch(function () {});
    var expandedAfter = !!moreEl && moreEl.open === true;
    report('判据（识别凭什么/拆了几行）**默认折叠**，点「怎么看出来的」能展开',
      collapsedBefore && expandedAfter,
      'details在=' + !!moreEl + ' 展开前open=' + (moreEl ? moreEl.open : '?') + ' 展开后=' + expandedAfter);

    report('本次导入没有异常行 ⇒ 回执**不出现**异常块（不写"无异常"这种不带信息的话）',
      !document.querySelector('[data-act="import-warn"]'),
      'warn=' + (document.querySelector('[data-act="import-warn"]') ? flat(document.querySelector('[data-act="import-warn"]')) : '无'));

    // 「数据去哪了」—— 这是回执存在的首要理由
    //（2026-10-05 用户实报：导完不知道接下来做什么，也不知道数据去哪了）
    var ordLanded = flat(document.querySelector('[data-act="import-landed"]'));
    // ⚠️ 口径 2026-10-10 变过：拣货清单并进「拿货」⇒ "能看到它的页面"里那格从「拣货」改成「拿货」。
    //    2026-10-11 又把「归类核对」排到最前（刚导完的行大概率还没归款）。
    report('回执回答"数据去哪了"：存到订单，并列出能看到它的三处页面',
      ordLanded.indexOf('订单') >= 0 && ordLanded.indexOf('归类核对') >= 0 &&
        ordLanded.indexOf('拿货') >= 0 && ordLanded.indexOf('算钱') >= 0,
      ordLanded);

    // 「接下来做什么」—— 按钮必须指向**真实存在的目的地**（写错 = 点了没反应，且不报错）。
    // 这一场是"店铺**未归属**"那组按钮（订单夹具没有店铺列）；"已归属"那组在下面的芒果步里另测一次。
    checkNextTargets('订单报表·店铺未归属');
    // ⚠️ 主操作 2026-10-11 从「去看要拿什么」（第 4 步）改成「去核对这些行」（第 2 步）——
    //    原先与流程卡上"第 2 步才是当前步"自相矛盾：卡片让用户去归类，回执却把人送到拿货。
    //    判据同时钉**主次**（primary 在 classify 上）与**落点**（tab ⇒ 就地切页签，不跳模块）。
    // ⚠️ 次操作**按场景分叉**：店铺已归属 → 「去看要拿什么」(purchase)；未归属 → 「去「算钱」归店铺」(cost)。
    //    本场是**未归属**（夹具没有店铺列）⇒ 次操作必须是 cost、**不是** purchase。
    //    两支分别在本场与芒果场各验一次 —— 只验一支等于漏掉另一条分支（"对称交换仍绿"的老毛病）。
    report('订单报表（店铺未归属）：主操作「去核对这些行」(classify) + 次操作「去「算钱」归店铺」(cost)',
      flat(document.querySelector('button[data-act="import-next-classify"]')).indexOf('核对') >= 0 &&
        !!document.querySelector('button[data-act="import-next-cost"]') &&
        flat(document.querySelector('button[data-act="import-next-cost"]')).indexOf('算钱') >= 0 &&
        !document.querySelector('button[data-act="import-next-purchase"]'),
      JSON.stringify(queryAll('[data-act="import-next"] button').map(function (b) {
        return flat(b) + '->' + b.getAttribute('data-act') + (b.className.indexOf('primary') >= 0 ? '(主)' : '');
      })));
    report('主按钮带 primary 样式（"哪个是主操作"在界面上看得出来，不靠用户猜）',
      (function () {
        var b = document.querySelector('button[data-act="import-next-classify"]');
        return !!b && b.className.indexOf('primary') >= 0;
      })(),
      (function () {
        var b = document.querySelector('button[data-act="import-next-classify"]');
        return b ? b.className : 'no-btn';
      })());

    // 只给按钮还不够：三个卡并列时用户仍要自己找。刚导完订单就把「待拣」卡点亮（**只引导，不重复入口**）
    // ⚠️ 「待拣」卡在**总览**页签里（导入页签只有导入按钮 + 回执）⇒ 切回去看
    await activateTab('overview');
    report('刚导完订单 → 「待拣」卡点亮并给出"已算进来"的提示',
      !!card('card-picking') &&
        card('card-picking').className.indexOf('is-fresh') >= 0 &&
        !!card('picking-fresh'),
      card('card-picking') ? card('card-picking').className : 'no-card');

    step('import-mango');
    await activateTab('import');
    // 芒果店长**待发货订单**：报表自带「店铺名 + 产品图片链接」—— 于是要 ① 判据点名到芒果、
    // ② 店铺名直接落 shop（不再提示"未归属"）、③ 图片链接真的走下载并把图 id 挂到订单行。
    // 这三条全是"静默可错"的（导完了、店铺空、图全空都不报错），所以钉在真实接线上。
    var mangoInsertBefore = calls('orderInsert').length;
    window.__importKind = 'mango';
    await waitImportIdle();
    document.querySelector('[data-act="import"]').click();
    try {
      await waitFor(function () { return calls('orderInsert').length > mangoInsertBefore; }, 8000);
    } catch (e) {
      throw new Error('芒果待发货订单没有落库：orderInsert=' + calls('orderInsert').length +
        ' downloadImage=' + calls('orderDownloadImage').length +
        ' 结论=' + flat(document.querySelector('[data-act="import-result"]')) +
        ' 错误=' + flat(document.querySelector('.td-error')));
    }
    var mins = calls('orderInsert').slice(mangoInsertBefore);
    var mtext = flat(document.querySelector('[data-act="import-result"]'));
    report('芒果待发货订单：判据点名「芒果店长」（不是笼统的订单报表签名）', mtext.indexOf('芒果店长') >= 0, mtext);
    report('店铺名列直接落到订单行（不再要求「归到该店」）',
      mins.length === 1 && mins[0].shop === '六店' && mtext.indexOf('归到该店') < 0,
      JSON.stringify({ shop: mins[0].shop, msg: mtext }));
    // 注意：这个方法的入参是**裸 URL 字符串**（preload 的 orderDownloadImage(url) 再包成 {url}），
    //    不是 {url} 对象 —— 断言按真实形状取，别写成 [0].url（那会恒 undefined）。
    var dl = calls('orderDownloadImage');
    report('产品图片链接真的走了下载，且图 id 挂到订单行（imageId 非 null）',
      dl.length === 1 && String(dl[0] ?? '').indexOf('img.example.com/a.jpg') >= 0 && mins[0].imageId === 77,
      JSON.stringify({ url: dl[0], imageId: mins[0].imageId }));
    report('结论说清主图张数与店铺归属（用户可核对导到哪去了）',
      mtext.indexOf('主图 1 张') >= 0 && mtext.indexOf('六店') >= 0, mtext);
    // 标题要点名到**子类**：用户导的是"芒果店长待发货订单"，回执就该叫这个名字（不是笼统的"订单报表"）
    report('回执标题点名到「芒果店长待发货订单」',
      flat(document.querySelector('[data-act="import-title"]')).indexOf('芒果店长待发货订单') >= 0,
      flat(document.querySelector('[data-act="import-title"]')));
    // 待发货订单：主操作与次操作都落在本页页签上（这一场是"店铺已归属"那组按钮 ——
    // 与上面订单报表那组**不是同一条代码路径**）。
    checkNextTargets('芒果店长待发货订单·店铺已归属');
    report('芒果待发货订单的下一步：主操作「去核对这些行」(classify) + 次操作「去看要拿什么」(purchase)',
      !!document.querySelector('button[data-act="import-next-classify"]') &&
        flat(document.querySelector('button[data-act="import-next-classify"]')).indexOf('核对') >= 0 &&
        !!document.querySelector('button[data-act="import-next-purchase"]') &&
        flat(document.querySelector('button[data-act="import-next-purchase"]')).indexOf('要拿什么') >= 0 &&
        !document.querySelector('button[data-act="import-next-cost"]'),
      flat(document.querySelector('[data-act="import-next"]')));

    // 回执是**常驻**的（不是一闪而过的 toast），用户处理完要能关掉；关掉必须真的消失，不留空壳
    var dismiss = document.querySelector('[data-act="import-dismiss"]');
    if (dismiss) {
      dismiss.click();
      try { await waitFor(function () { return !document.querySelector('[data-act="import-result"]'); }, 4000); } catch (e) {}
    }
    report('回执可关掉，且关掉后卡片真的消失',
      !!dismiss && !document.querySelector('[data-act="import-result"]'), String(!!dismiss));
    // 关掉后要**回到干净的空态**：页面上没有回执，而**入口还在**。
    // ⚠️ 判据 2026-10-11 换过：原先断言的是"空态那段说明文字里有没有 Excel / 回执"—— 那段文字
    //    已按"少提示、靠交互"撤掉，再钉文案等于把一段说明文锁进测试。现在钉的是**真会坏的东西**：
    //    没留残壳（无 import-result）+ 投放区还在 + 主按钮没被禁用（关回执顺手把入口也禁了 = 死路）。
    //    ⚠️ 只断言"回执没了"是空转：页面整个塌成空白时它也绿。
    var zoneAfter = document.querySelector('[data-act="import-drop"]');
    var pickAfter = card('import');
    report('关掉回执后回到干净空态：无残壳、入口仍在且可用',
      !document.querySelector('[data-act="import-result"]') &&
        !!zoneAfter && !!pickAfter && !pickAfter.disabled && flat(pickAfter).indexOf('Excel') >= 0,
      'result=' + !!document.querySelector('[data-act="import-result"]') +
        ' zone=' + !!zoneAfter +
        ' btn=' + (pickAfter ? flat(pickAfter) + '/disabled=' + pickAfter.disabled : 'none'));

    step('import-drop');
    // 投放区（2026-10-11 重设计）：① 点**区块本身**（不是里面那个按钮）也要拉起选文件；
    // ② 把文件**拖进来**要真的导入。这两条是"可点可拖"这层交互**唯一**的守卫 ——
    //    只断言"元素在"是空转：点上去没反应、拖了没动作照样绿。
    await waitImportIdle();
    window.__importKind = 'junk';   // 先用认不出的表：只验"有没有发起选文件"，一个字节都不写库
    var selBeforeZone = calls('selectExcel').length;
    var insBeforeZone = calls('orderInsert').length;
    var zone = document.querySelector('[data-act="import-drop"]');
    report('导入页有投放区（可点可拖的入口）', !!zone, String(!!zone));
    if (zone) zone.click();         // ⚠️ 点的是**区**本身，不是 [data-act="import"] 那个按钮
    await waitFor(function () { return calls('selectExcel').length > selBeforeZone; }, 6000);
    report('投放区整块可点：点区块本身（非按钮）也会拉起选文件',
      calls('selectExcel').length > selBeforeZone, 'selectExcel=' + calls('selectExcel').length);
    // ⚠️ **必须等整轮导入结束**再往下：waitImportIdle 单看"按钮可点"是不够的 ——
    //    选文件对话框刚弹出来那一瞬按钮仍可点（importing 还没置位），此刻拖放会被
    //    runImport 的重入守卫静默吞掉，症状是"拖了没反应"（实测踩到：orderInsert+0、
    //    回执还停在上一条的结论上）。完成信号取"回执换成认不出的结论 **且** 按钮恢复可点"。
    try {
      await waitFor(function () {
        var t = document.querySelector('[data-act="import-title"]');
        return !!t && flat(t).indexOf('没认出') >= 0 && !card('import').disabled;
      }, 8000);
    } catch (e) { /* 下面那条 report 给结论 */ }
    report('认不出的表走同一条链路：只解释、不写库',
      calls('orderInsert').length === insBeforeZone, 'orderInsert=' + calls('orderInsert').length);

    // 真"拖"一份订单报表进来：字节来自 DataTransfer（不是文件对话框），必须照样拆行落库。
    // ⚠️ 先把旧回执撤掉：下面的判据是"**新**回执出现了"，不清场的话上一条结论会让它恒绿。
    // ⚠️ 用 new Event('drop') + defineProperty 挂 dataTransfer，而不是 new DragEvent(...) ——
    //    DragEvent 构造器对 dataTransfer 的支持在各版本不一致，这条链上失败会被读成"投放区没实现"。
    if (card('import-dismiss')) card('import-dismiss').click();
    var insBeforeDrop = calls('orderInsert').length;
    var dropNote = '';
    try {
      var db64 = (window.__smokeXlsxB64 || {}).orders || '';
      var dbin = atob(db64);
      var dbytes = new Uint8Array(dbin.length);
      for (var di = 0; di < dbin.length; di++) dbytes[di] = dbin.charCodeAt(di);
      var dfile = new File([dbytes.buffer], '拖进来的订单报表.xlsx', { type: 'application/vnd.ms-excel' });
      var ddt = new DataTransfer();
      ddt.items.add(dfile);
      var dev = new Event('drop', { bubbles: true, cancelable: true });
      Object.defineProperty(dev, 'dataTransfer', { value: ddt });
      document.querySelector('[data-act="import-drop"]').dispatchEvent(dev);
      dropNote = 'bytes=' + dbytes.length + '/files=' + ddt.files.length;
    } catch (e) { dropNote = 'throw:' + String((e && e.message) || e); }
    try { await waitFor(function () { return calls('orderInsert').length >= insBeforeDrop + 2; }, 8000); } catch (e) {}
    report('把 Excel 拖进投放区 = 真的导入（订单报表照样拆两行落库）',
      calls('orderInsert').length >= insBeforeDrop + 2,
      dropNote + ' orderInsert+' + (calls('orderInsert').length - insBeforeDrop) +
        ' err=' + flat(document.querySelector('.td-error')));
    report('拖入后同样留下回执（拖放不是一条静默路径）',
      !!document.querySelector('[data-act="import-result"]') &&
        flat(document.querySelector('[data-act="import-title"]')).indexOf('订单报表') >= 0,
      flat(document.querySelector('[data-act="import-result"]')));

    // 能识别的四类要拧成**可扫的标签**（原先埋在空态那句长括号里，用户很难确认"我这份在不在里面"）
    var chips = queryAll('[data-act="import-drop"] .ti-drop__types li');
    var chipText = chips.map(function (c) { return flat(c); }).join('|');
    report('投放区把能识别的四类文件列成标签（不埋在长句里）',
      chips.length === 4 && chipText.indexOf('结算明细') >= 0 && chipText.indexOf('报价单') >= 0, chipText);

    // 说明文字压到只剩一行标题之后，**"拖到上面时区自己会变"就成了用户唯一的引导**：
    // 原先靠副标题写"也可以直接把文件拖进来"，现在靠虚线框在 dragenter 时变实线 + 标题换字。
    // ⚠️ 判据读的是**计算样式**（dashed → solid）而不是 class 名：'is-over' 挂上了但样式没生效
    //    （选择器写错、被覆盖）时用户照样看不出来，只查 class 会恒绿。等待与判定分开写。
    var zIdle = getComputedStyle(zone).borderStyle;
    zone.dispatchEvent(new Event('dragenter', { bubbles: true, cancelable: true }));
    try { await waitFor(function () { return getComputedStyle(zone).borderStyle === 'solid'; }, 2000); } catch (e) {}
    var zOver = getComputedStyle(zone).borderStyle;
    var zOverTitle = flat(zone.querySelector('.ti-drop__title'));
    zone.dispatchEvent(new Event('dragleave', { bubbles: true, cancelable: true }));
    try { await waitFor(function () { return getComputedStyle(zone).borderStyle === 'dashed'; }, 2000); } catch (e) {}
    var zBack = getComputedStyle(zone).borderStyle;
    report('文件悬在投放区上方时：边框虚线变实线 + 标题换成「松手就导入」，离开后复原',
      zIdle === 'dashed' && zOver === 'solid' && zBack === 'dashed' && zOverTitle.indexOf('松手') >= 0,
      'idle=' + zIdle + ' over=' + zOver + ' back=' + zBack + ' title=' + zOverTitle);

    step('empty');
    // 空态：给的是"动作"，不是一句"暂无数据"；而且动作必须是**宿主自己能做的那一步**
    // （S2-b 起宿主能直接导订单报表 —— 旧按钮把用户送去装「订单归类」，指向已过时）
    await activateTab('overview');
    window.__emptyOrders = true;
    document.querySelector('[data-act="refresh"]').click();
    await waitFor(function () {
      var el = card('card-orders');
      return el && flat(el).indexOf('今天还没有导入订单') >= 0;
    }, 8000);
    var emptyCard = flat(card('card-orders'));
    report('无订单时：空态卡说明两条来源并给出下一步按钮',
      !!card('card-orders').querySelector('button[data-act="empty-import"]') &&
        emptyCard.indexOf('来源①') >= 0, emptyCard);
    // ⚠️ 空态说「今天还没有导入订单」而不是「还没有订单数据」（2026-10-11）：发货台只数**今天导入**的
    //    那批，库里可能明明有前几天的单 —— 说"还没有订单数据"是假话（用户会以为数据丢了，正是本轮要治的病）。
    report('无订单时不说"还没有订单数据"（那是假话：库里可能有前几天的单）',
      emptyCard.indexOf('还没有订单数据') < 0 && emptyCard.indexOf('今天还没有导入订单') >= 0,
      emptyCard.slice(0, 160));
    // 空态**不该**出现口径标签（那句本身已经交代了范围），标签是给"有数字"时的数字配的作用域。
    report('空态不挂「今天导入」口径标签（避免与空态那句话重复）',
      !card('card-orders').querySelector('[data-act="orders-scope"]'), '');
    // ⚠️ 判据随改造变了：以前要做的是"别再劝用户去装插件"（那时归类只在插件里），
    //    现在归类有了页签 ⇒ 反向守卫升级成"**不许**出现『另装』"，并指向本页页签。
    report('空态的主操作是「导入 Excel」（且不再把用户送去装插件）',
      emptyCard.indexOf('导入 Excel') >= 0 && emptyCard.indexOf('去打开') < 0 &&
        emptyCard.indexOf('另装') < 0 && emptyCard.indexOf('归类核对') >= 0, emptyCard);
    // ⚠️ 这条同时验两件事：**切到了导入页签**（看不见的按钮点了等于没点）+ **真的弹了选文件**。
    //    以前只验后者 —— 改成页签之后，"只切过去不弹框"（或反过来）都会漏。
    var beforeSel = calls('selectExcel').length;
    card('card-orders').querySelector('button[data-act="empty-import"]').click();
    await waitFor(function () { return calls('selectExcel').length > beforeSel; }, 6000);
    report('空态按钮真的走导入链路（点了就弹选文件）', calls('selectExcel').length > beforeSel,
      'selectExcel=' + calls('selectExcel').length);
    report('空态按钮顺带把「导入订单」页签切到前台（一步直达，不让用户再找按钮）',
      onTab('import') && !!document.querySelector('[data-act="import"]'), '');
    await activateTab('overview');
    report('一行订单都没有时：缺克重 0，且不给「补克重」按钮（按钮跟着数据走）',
      flat(card('card-gaps')).indexOf('缺克重 0 行') >= 0 &&
        !card('card-gaps').querySelector('button[data-act="go-goods"]'),
      flat(card('card-gaps')));
    report('无订单时待拣卡也不催人（显示"没有要拣的"）',
      flat(card('card-picking')).indexOf('没有要拣的') >= 0, flat(card('card-picking')));

    step('nav');
    // 点击出参是唯一能抓"点了没反应"的手段。
    // ⚠️ 改造后这里**不再跳页**：点「去看要拿什么」= 切到「拿货」页签，人一直停在「今天」。
    //    2026-10-10：拣货清单并进「拿货」⇒ 落点从原「生成拣货单」页签改成「拿货」页签。
    window.__emptyOrders = false;
    document.querySelector('[data-act="refresh"]').click();
    await waitFor(function () { return card('card-picking') && card('card-picking').querySelector('button[data-act="go-picking"]'); }, 8000);
    var swBeforeNav = evts('switch-module').length;
    card('card-picking').querySelector('button[data-act="go-picking"]').click();
    await waitFor(function () { return onTab('purchase') && !!document.querySelector(PANEL_SEL.purchase); }, 8000);
    report('「去看要拿什么」= 切到「拿货」页签（就地切换）',
      onTab('purchase') && !!document.querySelector('.pu-view'), '');
    report('全程没有派发 switch-module（页面始终没离开「今天」）',
      evts('switch-module').length === swBeforeNav,
      'switch-module=' + evts('switch-module').length);

    step('keepalive');
    // **"丝滑"的判据**：切走再切回，面板是**同一个 DOM 实例**（KeepAlive 保活），不是重新挂载。
    // ⚠️ 只在 DOM 上打个标记来验 —— 断言"取了数"不够（重挂载也会取数），
    //    而"节点还是那一个"是保活的直接证据。标记跟着缓存的 DOM 走，重挂载就丢。
    //    2026-10-10：拣货清单现在住在「拿货」面板里 ⇒ 标记打在**拿货面板**上（它才是被 KeepAlive 的那个）。
    var pkEl = document.querySelector('.pu-view');
    var mark = 'KEEP' + Math.random();
    pkEl.__keepMark = mark;
    await activateTab('cost');
    await activateTab('purchase');
    var pkBack = document.querySelector('.pu-view');
    report('切走再切回：拿货面板是**同一个 DOM 实例**（KeepAlive 保活，界面不重建）',
      !!pkBack && pkBack.__keepMark === mark, 'mark=' + String(pkBack && pkBack.__keepMark));
    report('「算钱」面板也已经挂上过（两个内嵌整页视图在同一页里共存）',
      !!document.querySelector('[data-act="tab-cost"]'), '');

    step('refresh-link');
    // **保活的代价必须还回去**：导入新订单后，已经生成过的拣货单要跟着重算
    // （否则用户切回拿货页签，看到的是"导入之前"那份清单，还以为没生效）。
    // ⚠️ 判据必须是**拣货面板自己发出的**那些调用（见 「pickingGenCalls」 的注释）：
    //    用总数会被容器的 reload 满足 ⇒ 变异（拿掉 refresh-token）照样全绿，守卫是假的。
    var genBefore = pickingGenCalls().length;
    if (document.querySelector('[data-act="generate"]')) {
      document.querySelector('[data-act="generate"]').click();
      try { await waitFor(function () { return pickingGenCalls().length > genBefore; }, 8000); } catch (e) {}
    }
    var genAfter = pickingGenCalls().length;
    var insBefore = calls('orderInsert').length;
    window.__importKind = 'orders';
    await activateTab('import');
    await waitImportIdle();
    document.querySelector('[data-act="import"]').click();
    try {
      await waitFor(function () { return calls('orderInsert').length > insBefore; }, 8000);
    } catch (e) {
      throw new Error('refresh-link 这一步的导入没落库：orderInsert=' + calls('orderInsert').length +
        ' 结论=' + flat(document.querySelector('[data-act="import-result"]')));
    }
    await activateTab('purchase');
    try {
      await waitFor(function () { return pickingGenCalls().length > genAfter; }, 8000);
    } catch (e) { /* 下面 report 给结论 */ }
    report('导入订单后已生成的拣货单自动重算（token 联动，保活不会让用户看到旧清单）',
      pickingGenCalls().length > genAfter,
      '拣货面板的 pickingRows: 生成后=' + genAfter + ' 导入后=' + pickingGenCalls().length);

    step('purchase');
    // 「拿货」页签（2026-10-05 内建；**2026-10-10 拣货清单并进来 + 两轮页内重设计**）—— 两条子视图：
    //   ① 要拿什么（默认）：内嵌整页「拣货」视图（embedded auto row-action supplier-action：
    //      顶部厂家筛选标签 / 款色卡片网格（图 + 尺码角标 + 缺口 + 进价 + 行尾忽略）/
    //      吸底汇总条（逐厂：复制给厂家 + 生成拿货单（N 件）））；
    //   ② 拿了什么：拿货单列表 + 编辑器。
    // 2026-10-10 重设计（改这一段前先读 tabs/PurchasePanel.vue 与 picking/PickingView.vue 头注释）：
    //   · 页级指标条**整条撤掉** ⇒ 数字**就地**给：清单条（待拿 N 款色 · N 件 · 预估 ¥）/
    //     面板头（N 张 · N 张草稿待提交 · 已提交 ¥）；两段徽标一并撤掉（数字就在正下方同一处）；
    //   · 第二轮：表格 → **卡片网格**（一张卡 = 一个款色），开单/复制从"页级 + 先选厂家"
    //     **钉到厂家行上**（一张单只能挂一个厂家，行就是天然分组）；
    //   · 已忽略清单折成一行（pu-ignore-toggle），展开才出表；
    //   · 生成后**直接切到「拿了什么」并打开编辑器**填价（这条链的下一步就是录付了多少钱）。
    // 断言纪律：① 数字钉在 data-act 上、按真夹具逐格核；② 每个按钮断言**它发出的 IPC 入参**
    //（这是唯一能抓"点了没反应 / 发给了别的通道"的手段）；③ 确认弹层要断言**确认前一个请求都不发**。
    await activateTab('purchase');
    await waitFor(function () {
      return !!card('pu-sub-pick') && calls('purchaseOrderList').length >= 1;
    }, 10000);

    // ---- 子视图 A：要拿什么（默认）----
    report('默认落在「要拿什么」（这一步的动词是"去拿货"，清单才是入口）',
      card('pu-sub-pick').className.indexOf('is-on') >= 0 && !!card('pk-bar'), '');
    // auto：进这一步清单就该出好了（"生成"是它自己的按钮，但这里是拿货，得先看见货）
    await waitFor(function () { return !!pickCard('S1 · 黑'); }, 10000);
    report('清单自动生成过（auto）：进来就有卡片网格，不用再点一次「生成待拣清单」',
      !!card('pk-grid') && pickingGenCalls().length >= 1,
      'grid=' + !!card('pk-grid') + ' genCalls=' + pickingGenCalls().length);
    // 卡片网格（2026-10-10 第二轮重设计）：顶部**厂家筛选标签**（数 = 待拿款色数），
    // 底部一条**吸底汇总条**逐厂收口。内嵌形态下面板头不渲染，这两块是本页看货/发厂/开单的入口。
    report('顶部厂家筛选标签：全部 1 / 厂A 1（数 = 待拿款色数；未指定厂家不占位、也不该混进来）',
      !!card('pk-tabs') && flat(card('pk-tab-all')) === '全部 1' &&
        !!document.querySelector('[data-act="pk-tab"][data-supplier="7"]') &&
        flat(document.querySelector('[data-act="pk-tab"][data-supplier="7"]')) === '厂A 1' &&
        !document.querySelector('[data-act="pk-tab"][data-supplier="0"]'),
      card('pk-tabs') ? flat(card('pk-tabs')) : 'no-tabs');
    // ⚠️ 2026-10-10 收口：这条以前只断言 position === 'sticky'（声明断言）—— 真机上
    //    「全部/集雨」页签下汇总条被 flex 压塌到 2px、按钮全被自己裁掉时，它照样全绿。
    //    现在按几何 + 可达性断言（见 pkSumGuard 头注释）：页签只筛网格不改这条的数据，
    //    按钮该出现就必须**看得见、点得到**。
    var psg = pkSumGuard(['pk-copy', 'pk-create-order']);
    report('底部汇总条**在眼前**（几何 + 可达性）：没被压扁、底边在视口内、两个按钮中心 elementFromPoint 命中它自己',
      psg.ok, psg.detail);

    // 款色一行（2026-10-10）：同款同色所有尺码折进**一行**，尺码格 = L×2（**还差**件数）。
    // ⚠️ 文字与 tooltip 必须断言在**同一格**上：字面说"还要拿 2"、tooltip 说"需求 3 / 已拿 1"，
    //    分开成两条断言的话，实现里把 tooltip 接错口径（如需求改取还差列）照样全绿。
    var chipEl = pickCard('S1 · 黑').querySelector('[data-act="size-chip"][data-size="L"]');
    report('尺码格 = 尺码 × **还差**件数（L×2，不是需求 L×3），tooltip 三个数一个不丢（需求 3 · 已拿 1 · 还差 2）',
      !!chipEl && chipEl.textContent.trim() === 'L×2' &&
        chipEl.getAttribute('title') === 'L：需求 3 · 已拿 1 · 还差 2',
      chipEl ? chipEl.textContent.trim() + ' | ' + chipEl.getAttribute('title') : 'no-chip');
    report('卡上进价格在一件价都没查到时写 —（成本表只覆盖 S2，不写 ¥0.00）',
      cellText(pickCard('S1 · 黑'), 'unit-price') === '—',
      cellText(pickCard('S1 · 黑'), 'unit-price'));
    // 清单条主数 = **待拿**（与段尾按钮、「按此生成」同一判据 pendingRollup）——
    // 一件价都没查到时不写 ¥0.00（那等于说"这批货值 0 元"），走 —（N 件全部无进价）。
    report('清单条就地给数：待拿 1 款色 · 2 件 · 预估 —（2 件全部无进价）',
      !!card('amount') && flat(card('amount')).indexOf('待拿 1 款色') >= 0 &&
        flat(card('amount')).indexOf('2 件') >= 0 && flat(card('amount')).indexOf('预估 —') >= 0 &&
        flat(card('amount')).indexOf('2 件全部无进价') >= 0,
      card('amount') ? flat(card('amount')) : 'no-amount');
    // 缺口行「无进价 3 件」取**需求**口径 ⇒ 与"待拿 2 件"**不同数**：两条支路互不遮蔽
    //（把「无进价」也换成待拿口径、或两个数写成一个，这条会当场红 —— 夹具三个数故意都不同）。
    report('缺口条按需求口径报无进价件数（3 件，不是待拿的 2 件 —— 口径混用会在此露馅）',
      !!card('gaps') && flat(card('gaps')).indexOf('无进价 3 件') >= 0,
      card('gaps') ? flat(card('gaps')) : 'no-gaps');
    report('款色卡上照实标缺口（无进价 3 件）',
      flat(pickCard('S1 · 黑')).indexOf('无进价 3 件') >= 0,
      flat(pickCard('S1 · 黑')));
    // 底部汇总条逐厂一行（2026-10-10 第二轮）：一行 = 「这家什么情况 + 复制发哪家 + 一键开单」。
    // 一件一单的约束（一张拿货单只能挂一个厂家）直接落在行上，不用先选厂家再对一遍。
    var srow = sumRow(7);
    report('汇总条逐厂一行：厂A → 1 款色 · 待拿 2 件 · —（2 件全部无进价）',
      !!srow && flat(srow).indexOf('厂A') >= 0 &&
        flat(srow).indexOf('1 款色 · 待拿 2 件') >= 0 &&
        flat(srow).indexOf('2 件全部无进价') >= 0,
      srow ? flat(srow) : 'no-sum-row');
    // 开单按钮**钉在厂家行上**（2026-10-10）：一张单只能挂一个厂家，行就是天然分组 ——
    // 原先"页级按钮 + 先选厂家"的那一步对用户是白问的。按钮上的 N 件 = 这家厂**待拿**件数
    //（与清单条、主进程开单明细同一条判据 pendingOf）。
    report('汇总条那行给「生成拿货单（2 件）」且带厂家 id（按厂家开单，不必先选厂家）',
      !!srow && !!srow.querySelector('[data-act="pk-create-order"]') &&
        flat(srow.querySelector('[data-act="pk-create-order"]')).indexOf('生成拿货单（2 件）') >= 0 &&
        srow.querySelector('[data-act="pk-create-order"]').getAttribute('data-supplier') === '7',
      srow && srow.querySelector('[data-act="pk-create-order"]')
        ? flat(srow.querySelector('[data-act="pk-create-order"]')) + ' | data-supplier=' +
          srow.querySelector('[data-act="pk-create-order"]').getAttribute('data-supplier')
        : 'no-btn');
    // 「复制给厂家」：把**这一家**的待拿货画成一张 PNG 写进**系统图片剪贴板**（用户粘到微信发给厂家）。
    // 真写剪贴板在主进程 ⇒ 这里断言"发出去的是图片（PNG dataURL），不是纯文本"。
    var clipBefore = calls('writeClipboardImage').length;
    sumRow(7).querySelector('[data-act="pk-copy"]').click();
    var okClip = true;
    try { await waitFor(function () { return calls('writeClipboardImage').length > clipBefore; }, 8000); }
    catch (e) { okClip = false; }
    var clip = calls('writeClipboardImage')[clipBefore] || '';
    report('「复制给厂家」发出的是图片（PNG dataURL），不是纯文本（粘进微信直接是清单图）',
      okClip && typeof clip === 'string' && clip.indexOf('data:image/png;base64,') === 0,
      okClip ? 'len=' + clip.length : 'timeout');
    var okClipToast = true;
    try { await waitFor(function () { return toastHas('已复制 1 款色 · 2 件 的清单图'); }, 4000); }
    catch (e) { okClipToast = false; }
    report('复制成功后的提示说清"几款色几件 + 发给谁"（能核对，不是一句"复制成功"）',
      okClipToast && toastHas('厂A'), toastDump());
    // 已忽略清单**折成一行**（低频）：一行说完几条 + 生效范围，表要展开才出（展开在下面撤销那步验）
    report('已忽略折成一行：一行说清几条 + 生效范围，展开才出表',
      !!card('pu-ignore-toggle') && !card('pu-ignore-table') &&
        flat(card('pu-ignore-toggle')).indexOf('已忽略 1 项') >= 0 &&
        flat(card('pu-ignore-toggle')).indexOf('款编码 + 款色') >= 0,
      card('pu-ignore-toggle') ? flat(card('pu-ignore-toggle')) : 'no-toggle');

    // ---- 子视图 B：拿了什么（切换要真的换内容 —— 存在性由这条钉） ----
    card('pu-sub-orders').click();
    await waitFor(function () { return !!card('pu-order-table'); }, 6000);
    report('切到「拿了什么」：面板真的换内容（拿货单表上来、拣货清单退场）',
      !!card('pu-order-table') && !card('pk-grid'), '');
    report('拿货单表：两张单都在，状态与金额逐格对（12000 分 → ¥120.00）',
      (function () {
        var t = flat(card('pu-order-table'));
        return t.indexOf('厂A') >= 0 && t.indexOf('厂B') >= 0 && t.indexOf('草稿') >= 0 &&
          t.indexOf('已提交') >= 0 && t.indexOf('¥120.00') >= 0 && t.indexOf('¥500.00') >= 0;
      })(),
      flat(card('pu-order-table')));
    // 备注整列已删（零消费者字段）：表头不再有「备注」二字（模式并进厂家格的两个标签不算）
    report('拿货单列表不再有「备注」列（零消费者字段已删）',
      !!card('pu-order-table') && flat(card('pu-order-table')).indexOf('备注') < 0,
      flat(card('pu-order-table')));
    report('只有草稿给「提交」（已提交的单不该出现提交按钮）',
      !!card('pu-submit-3') && !card('pu-submit-2'), '');
    // 就地给数（替代撤掉的页级指标条）：几张 / 几张草稿待提交 / 已提交多少钱
    //（"已提交 ¥"就是对账的拿货一侧；草稿不计入 —— 与下面那行说明同一口径）。
    report('面板头就地给数：2 张 · 1 张草稿待提交 · 已提交 ¥500.00',
      !!card('pu-orders-meta') && flat(card('pu-orders-meta')).indexOf('2 张') >= 0 &&
        flat(card('pu-orders-meta')).indexOf('1 张草稿待提交') >= 0 &&
        flat(card('pu-orders-meta')).indexOf('已提交 ¥500.00') >= 0,
      card('pu-orders-meta') ? flat(card('pu-orders-meta')) : 'no-meta');
    // ⚠️ **默认值不能靠位置**：厂家下拉不许预选第一个 —— 夹具里故意放多个厂，
    //    否则"预选第一个"与"不预选"在只有一个选项时看起来一模一样，守卫恒绿。
    //    判据故意**不钉死选项数**（厂家目录会随夹具长大：对账段的厂C 就是第三个）——
    //    绝对计数是污染源；这里要的只是"占位项在前、value=0、且真选项 ≥ 2"。
    report('厂家不预选（下拉停在"选择厂家…"，不是第一个选项）',
      !!card('pu-supplier') && card('pu-supplier').value === '0' &&
        card('pu-supplier').options.length >= 3,
      card('pu-supplier') ? 'value=' + card('pu-supplier').value + ' options=' + card('pu-supplier').options.length : 'no-select');
    report('没选厂家时两个「新建」都禁用（不允许开出无主单）',
      !!card('pu-new-detail') && card('pu-new-detail').disabled === true &&
        !!card('pu-new-package') && card('pu-new-package').disabled === true, '');
    var supSel = card('pu-supplier');
    supSel.value = '7';
    supSel.dispatchEvent(new Event('change', { bubbles: true }));
    var okEnable = true;
    try { await waitFor(function () { return card('pu-new-detail').disabled === false; }, 4000); }
    catch (e) { okEnable = false; }
    report('选了厂家就解禁（"禁用"守卫不是恒绿的假守卫）',
      okEnable && card('pu-new-package').disabled === false, '');

    // ---- 编辑器：真取单、真算、真提交（分 ↔ 元）----
    card('pu-edit-3').click();
    await waitFor(function () { return !!card('pu-editor'); }, 6000);
    report('「查看 / 编辑」去取的是**这一张**（purchaseOrderGet {id:3}）',
      calls('purchaseOrderGet').length >= 1 && calls('purchaseOrderGet')[0].id === 3 && !!card('pue-table'),
      JSON.stringify(calls('purchaseOrderGet')[0] || {}));
    report('编辑器里明细金额真算（2 件 × 60.00 = ¥120.00）',
      flat(card('pue-total')).indexOf('120.00') >= 0, flat(card('pue-total')));
    // 模式创建时定死（宿主 update 不收 mode）⇒ 界面**不给**改不动的下拉框（那是假动作），
    // 只在页头给一个只读标签（措辞与列表里的模式标签同源）。
    report('模式是只读的（页头标签，不是"改不动的下拉框"）',
      !card('pue-mode') && !!card('pue-mode-tag') &&
        flat(card('pue-mode-tag')).indexOf('明细') >= 0, '');
    // 备注整条已删（零消费者字段）：编辑器里不再有那个输入框
    report('备注整条已删（零消费者字段）：编辑器不再有备注输入框',
      !!card('pu-editor') && !card('pue-note'), '');

    // ---- 明细表字段（2026-10-10 第二轮）：图片 / 款色 / 尺码 / 建议 / 实拿 / 单价 / 金额 ----
    // 列集合**逐列钉死**（含反向：款编码、款式名不再各自成列 —— 它们归进「款色」格：
    // 款编码·颜色两个输入 + 款名灰字一行）。少一列、多一列都会红。
    var heads = queryAll('[data-act="pue-table"] thead th').map(function (th) { return flat(th); });
    report('明细表列 = 图片/款色/尺码/建议/实拿/单价(元)/金额(元)（款编码、款式名不再各自成列）',
      heads.join('|') === '图片|款色|尺码|建议|实拿|单价(元)|金额(元)|', heads.join('|'));
    report('款色格里的款名还在（只读灰字，权威在产品库）',
      !!card('pue-name-1') && flat(card('pue-name-1')) === '款一',
      card('pue-name-1') ? flat(card('pue-name-1')) : 'no-name');

    // ---- 身份列不再是"输入框长相"（2026-10-10 第二轮反馈）----
    // 款色 / 尺码是清单带过来的**身份数据**，不是要填的字段 —— 方框会被读成"这里要我填什么"
    // （用户原话："拿货单中的款色和尺码为什么要用输入框的样式？"）。
    // 现在默认无边框无底色（像文字），点进去才变输入框；实拿/单价仍是输入框。
    // ⚠️ 判据用字符串相等而不是正则：本段代码嵌在模板字符串里，正则里的转义括号会被剥掉
    //    （实测第一次跑就栽在这 —— 诊断值全对、断言恒红）。
    function cssOf(act, prop) {
      var el = card(act);
      return el ? getComputedStyle(el)[prop] : '';
    }
    function isTransparent(v) {
      return v === 'rgba(0, 0, 0, 0)' || v === 'transparent';
    }
    var ghostOk =
      isTransparent(cssOf('pue-code-1', 'borderTopColor')) &&
      isTransparent(cssOf('pue-code-1', 'backgroundColor')) &&
      isTransparent(cssOf('pue-size-1', 'borderTopColor')) &&
      isTransparent(cssOf('pue-size-1', 'backgroundColor'));
    var solidOk =
      !isTransparent(cssOf('pue-qty-1', 'borderTopColor')) &&
      !isTransparent(cssOf('pue-price-1', 'borderTopColor'));
    report('款色/尺码默认像文字（无边框无底色，点进去才变输入框）；实拿/单价保留输入框',
      ghostOk && solidOk,
      'code=' + cssOf('pue-code-1', 'borderTopColor') + '/' + cssOf('pue-code-1', 'backgroundColor') +
        ' size=' + cssOf('pue-size-1', 'borderTopColor') +
        ' qty=' + cssOf('pue-qty-1', 'borderTopColor') +
        ' price=' + cssOf('pue-price-1', 'borderTopColor'));

    // ---- 布局守卫（2026-10-10 重设计）：8 列必须一行放下、行尾两个按钮必须**真的可达** ----
    // 之前的形态：表格固有宽度 658px > 抽屉内容区 527px ⇒ 「金额(元)」被裁半边、行尾操作列
    // 落在视窗外 —— **静默不可达**（点不到、也没有任何报错，只有截图能看出来）。
    // 这两条就是为它补的守卫；纯 DOM 存在性断言（上面的 heads）抓不到这类问题。
    var wrapEl = document.querySelector('[data-act="pu-editor"] .wb-table-wrap');
    report('明细表不横向溢出（8 列一行放下，金额列不被裁）',
      !!wrapEl && wrapEl.scrollWidth <= wrapEl.clientWidth + 1,
      wrapEl ? ('scrollWidth=' + wrapEl.scrollWidth + ' clientWidth=' + wrapEl.clientWidth) : 'no-wrap');

    function reachable(act) {
      var el = card(act);
      if (!el) return { ok: false, why: 'no-el' };
      var r = el.getBoundingClientRect();
      if (!r.width || !r.height) return { ok: false, why: 'zero-size' };
      if (r.right > window.innerWidth || r.left < 0 || r.bottom > window.innerHeight || r.top < 0) {
        return { ok: false, why: 'out-of-view ' + Math.round(r.left) + ',' + Math.round(r.top) };
      }
      // 按钮里可能有子节点（文字 / SVG），elementFromPoint 命中的可能是子节点 ⇒ 用 contains 判
      var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
      var ok = !!hit && (hit === el || el.contains(hit));
      return { ok: ok, why: ok ? '' : 'hit=' + (hit ? hit.tagName : 'null') };
    }
    var reachFill = reachable('pue-fill-1');
    var reachDel = reachable('pue-delrow-1');
    report('行尾「取最近价」「删除」按钮在视口内且可被点中（不是被裁掉/滚出视野）',
      reachFill.ok && reachDel.ok,
      'fill=' + JSON.stringify(reachFill) + ' del=' + JSON.stringify(reachDel));
    // 两个动作必须是**读得懂的文字**（2026-10-10 第二轮反馈：↻ / ✕ 图标"完全不知道是什么意思"）
    report('行尾两个动作是文字按钮（「取最近价」「删除」，不是无标注图标）',
      flat(card('pue-fill-1')) === '取最近价' && flat(card('pue-delrow-1')) === '删除',
      'fill=' + flat(card('pue-fill-1')) + ' | del=' + flat(card('pue-delrow-1')));

    // 打开就按行取图：入参 = 这一行的款色 **+ 尺码**，一次带全（不是逐行往返）
    var si0 = calls('purchaseStyleImages')[0];
    report('打开编辑器就按行取图（purchaseStyleImages 一次收到 S1·黑·L 与 S1·黑·M 两行）',
      !!si0 && (si0.items || []).length === 2 &&
        si0.items[0].styleCode === 'S1' && si0.items[0].color === '黑' && si0.items[0].size === 'L' &&
        si0.items[1].styleCode === 'S1' && si0.items[1].color === '黑' && si0.items[1].size === 'M',
      JSON.stringify(si0 || null));
    var okRowImg = true;
    try {
      await waitFor(function () {
        var im = card('pue-img-1');
        return !!im && im.complete && im.naturalWidth > 0;
      }, 6000);
    } catch (e) { okRowImg = false; }
    report('行图真的渲染出来（取图 + 缩略图两条通道接上，<img> 解码出内容）',
      okRowImg, card('pue-img-1') ? (card('pue-img-1').src || '').slice(0, 48) : 'no-img');
    // ⭐ 同款同色、**只差尺码**的两行必须各显示自己那件的图 —— 这是用户 2026-10-11 报的
    //    "拿货单明细的图片都是一样的"的正面守卫：取图只按款色时两行会拿到同一张。
    var okRowImg2 = true;
    try {
      await waitFor(function () {
        var a = card('pue-img-1'), b = card('pue-img-2');
        return !!a && !!b && a.complete && a.naturalWidth > 0 && b.complete && b.naturalWidth > 0;
      }, 6000);
    } catch (e) { okRowImg2 = false; }
    var imgA = card('pue-img-1'), imgB = card('pue-img-2');
    report('同款同色只差尺码的两行各取各的图（两张 src 不同，不是同款全同一张）',
      okRowImg2 && !!imgA && !!imgB && String(imgA.src) !== String(imgB.src),
      'L=' + (imgA ? String(imgA.src).slice(-26) : 'no-img') +
        ' | M=' + (imgB ? String(imgB.src).slice(-26) : 'no-img'));

    var qtyEl = card('pue-qty-1');
    qtyEl.value = '3';
    qtyEl.dispatchEvent(new Event('input', { bubbles: true }));
    var okQty = true;
    try {
      await waitFor(function () { return flat(card('pue-total')).indexOf('180.00') >= 0; }, 4000);
    } catch (e) { okQty = false; }
    report('改实拿数量 → 合计实时重算（3 × 60.00 = ¥180.00），不靠重新取数',
      okQty, flat(card('pue-total')));

    card('pue-fill-1').click();
    var okFill = true;
    try { await waitFor(function () { return calls('purchasePriceHistory').length >= 1; }, 4000); }
    catch (e) { okFill = false; }
    await new Promise(function (r) { setTimeout(r, 80); });
    var ph = calls('purchasePriceHistory')[0] || {};
    report('「取最近价」按**当前厂家**同款色查（supplierId=7 / S1 / 黑）',
      okFill && ph.supplierId === 7 && ph.styleCode === 'S1' && ph.color === '黑', JSON.stringify(ph));
    report('历史价 5550 分被回填进单价框（55.5 元）',
      !!card('pue-price-1') && String(card('pue-price-1').value) === '55.5',
      card('pue-price-1') ? card('pue-price-1').value : 'no-input');

    // ---- 改款色 → 行图跟着重查；查不到的给「缺图」占位（不是死不掉的旧图）----
    // ⚠️ 只 dispatch 'change' 不会更新 v-model（文本输入的 v-model 听 'input'）⇒ 两个都要发，
    //    否则 onCodeChange 读到的是**旧款编码**，这条断言反而会绿得莫名其妙。
    var code1 = card('pue-code-1');
    code1.value = 'S9';
    code1.dispatchEvent(new Event('input', { bubbles: true }));
    code1.dispatchEvent(new Event('change', { bubbles: true }));
    var okMiss = true;
    try {
      await waitFor(function () { return !!card('pue-noimg-1') && !card('pue-img-1'); }, 6000);
    } catch (e) { okMiss = false; }
    var siAll = calls('purchaseStyleImages');
    var siLast = siAll[siAll.length - 1];
    report('款色改成 S9 · 黑 → 行图重查、查不到给「缺图」占位',
      okMiss && !!siLast && (siLast.items || [])[0] && siLast.items[0].styleCode === 'S9',
      JSON.stringify(siLast || null));
    // 改回 S1 · 黑：图从缓存回来，**不再发第二次请求**（同款色来回改不重复往返）
    var siBeforeBack = calls('purchaseStyleImages').length;
    code1 = card('pue-code-1');
    code1.value = 'S1';
    code1.dispatchEvent(new Event('input', { bubbles: true }));
    code1.dispatchEvent(new Event('change', { bubbles: true }));
    var okBack = true;
    try {
      await waitFor(function () { return !!card('pue-img-1') && !card('pue-noimg-1'); }, 6000);
    } catch (e) { okBack = false; }
    report('改回 S1 · 黑：图从缓存回来（同款色不重复往返 —— 请求数没涨）',
      okBack && calls('purchaseStyleImages').length === siBeforeBack,
      'calls=' + calls('purchaseStyleImages').length + ' before=' + siBeforeBack);

    var updBefore = calls('purchaseOrderUpdate').length;
    card('pue-save').click();
    var okSave = true;
    try { await waitFor(function () { return calls('purchaseOrderUpdate').length > updBefore; }, 6000); }
    catch (e) { okSave = false; }
    var upd = calls('purchaseOrderUpdate')[calls('purchaseOrderUpdate').length - 1] || {};
    var updItem = (upd.items || [])[0] || {};
    report('保存：出参带 id / 日期 / 明细，且单价按**分**提交（55.50 元 → 5550 分）',
      okSave && upd.id === 3 && !!upd.bizDate && updItem.styleCode === 'S1' && updItem.qty === 3 &&
        updItem.priceCents === 5550 && updItem.suggestionQty === 2,
      JSON.stringify(upd));
    var okClosed = true;
    try { await waitFor(function () { return !card('pu-editor'); }, 4000); } catch (e) { okClosed = false; }
    report('保存后编辑器关闭（不留"保存了还挂在上面"的假象）', okClosed, '');

    // ---- 确认弹层：真拦得住（不点确认一个请求都不发）----
    card('pu-submit-3').click();
    await waitFor(function () { return !!card('confirm-dialog'); }, 4000);
    var subBefore = calls('purchaseOrderSubmit').length;
    report('提交前先确认，且弹层写清后果（"已拿" / 缺口 / 对账 / 成本）',
      flat(card('confirm-dialog')).indexOf('已拿') >= 0 &&
        flat(card('confirm-dialog')).indexOf('缺口') >= 0 &&
        flat(card('confirm-dialog')).indexOf('对账') >= 0 &&
        flat(card('confirm-dialog')).indexOf('成本') >= 0,
      flat(card('confirm-dialog')));
    report('没点确认时一个请求都不发（确认是真拦，不是装饰）',
      calls('purchaseOrderSubmit').length === subBefore, '');
    await confirmOk();
    var okSub = true;
    try { await waitFor(function () { return calls('purchaseOrderSubmit').length > subBefore; }, 6000); }
    catch (e) { okSub = false; }
    report('确认后才真提交（purchaseOrderSubmit {id:3}）',
      okSub && (calls('purchaseOrderSubmit')[subBefore] || {}).id === 3,
      JSON.stringify(calls('purchaseOrderSubmit')[subBefore] || {}));

    card('pu-del-2').click();
    await waitFor(function () { return !!card('confirm-dialog'); }, 4000);
    // ⚠️ #2 是**包价单**：确认只能讲对账影响，不许再一刀切地说"缺口回升"（包价不参与缺口/成本）。
    //    "回升不得出现"是**反向守卫** —— 文案若退回那句旧话，这条立刻红。
    report('删除包价单的确认只说对账影响、不谎称"缺口回升"（包价只进对账）',
      flat(card('confirm-dialog')).indexOf('对账') >= 0 &&
        flat(card('confirm-dialog')).indexOf('回升') < 0,
      flat(card('confirm-dialog')));
    var delBefore = calls('purchaseOrderDelete').length;
    await confirmOk();
    var okDel = true;
    try { await waitFor(function () { return calls('purchaseOrderDelete').length > delBefore; }, 6000); }
    catch (e) { okDel = false; }
    report('确认后删除的是**这一张**（purchaseOrderDelete {id:2}）',
      okDel && (calls('purchaseOrderDelete')[delBefore] || {}).id === 2,
      JSON.stringify(calls('purchaseOrderDelete')[delBefore] || {}));

    // ---- 导出：出参必须是"这张单的明细"（主进程拿它查款色图嵌 A 列）----
    var expBefore = calls('purchaseExportExcel').length;
    card('pu-export-3').click();
    var okExp = true;
    try { await waitFor(function () { return calls('purchaseExportExcel').length > expBefore; }, 6000); }
    catch (e) { okExp = false; }
    var ex = calls('purchaseExportExcel')[expBefore] || {};
    report('导出：出参是这张单的**全部明细行**（每行带款色 + 尺码，主进程靠它查每行自己那件的图）+ 默认文件名',
      okExp && (ex.items || []).length === 2 &&
        (ex.items || [])[0].styleCode === 'S1' && (ex.items || [])[0].color === '黑' &&
        (ex.items || [])[0].size === 'L' &&
        (ex.items || [])[1].styleCode === 'S1' && (ex.items || [])[1].color === '黑' &&
        (ex.items || [])[1].size === 'M' &&
        !!ex.defaultName,
      JSON.stringify(ex));

    // ---- 回「要拿什么」：按**厂家段**一键开单（拿货的主路径）----
    // 一张拿货单只能挂一个厂家 ⇒ 按钮就在段上，只收这家厂的行（混着发会把单开给错的厂，
    // 而单上看不出来）。段存在性由上面的「厂家段尾给…」那条钉住。
    card('pu-sub-pick').click();
    await waitFor(function () { return !!pickCard('S1 · 黑'); }, 8000);
    var crBefore = calls('purchaseOrderCreate').length;
    card('pk-create-order').click();
    var okCreate = true;
    try { await waitFor(function () { return calls('purchaseOrderCreate').length > crBefore; }, 6000); }
    catch (e) { okCreate = false; }
    var cr = calls('purchaseOrderCreate')[crBefore] || {};
    var crItem = (cr.items || [])[0] || {};
    report('按清单开单：出参带厂家 + 日期 + 模式 + 明细（qty = **还差 2**、单价留 0 待填、建议数量 = 还差、款名带上）',
      okCreate && cr.supplierId === 7 && !!cr.bizDate && cr.mode === 'detail' &&
        crItem.styleCode === 'S1' && crItem.styleName === '款一' && crItem.color === '黑' && crItem.size === 'L' &&
        crItem.qty === 2 && crItem.priceCents === 0 && crItem.suggestionQty === 2 && crItem.amountCents === 0,
      JSON.stringify(cr));
    // 反向守卫：出参不再带备注（整条链已删；谁把 note 加回 payload，这条立刻红）
    report('开单出参不再带备注（整条链已删）', okCreate && !('note' in cr), JSON.stringify(cr));
    // 提示是 createOrder **之后**才 toast 的（IPC 被记录 ≠ 提示已出来）⇒ 必须等，
    // 直接断言会看上一刻的旧提示，红的却是"新提示没出来"（方向整个反掉）。
    var okToast = true;
    try {
      await waitFor(function () { return toastHas('已生成拿货单 #99'); }, 4000);
    } catch (e) { okToast = false; }
    report('生成后给一条能核对去向的提示（带单号与下一步）',
      okToast && toastHas('填好单价'), toastDump());
    var okSwitch = true;
    try {
      await waitFor(function () { return card('pu-sub-orders').className.indexOf('is-on') >= 0; }, 4000);
    } catch (e) { okSwitch = false; }
    report('生成后自动切到「拿了什么」（下一步就是填单价，不让用户再找）', okSwitch, '');
    // 生成后**直接打开这张新单的编辑器**（这条链的下一步就是"录付了多少钱"，价格全是 0，就地填）。
    // ⚠️ 假桥必须**记住新建的单**（CREATED_ORDERS）：真库里 create 就是落库，get 要取得回来 ——
    //    否则这个断言会在一个"不存在的单"上翻转成假红。
    var okNewEditor = true;
    try {
      await waitFor(function () {
        return !!card('pu-editor') && !!card('pue-table') &&
          flat(card('pu-editor')).indexOf('拿货单 #99') >= 0;
      }, 6000);
    } catch (e) { okNewEditor = false; }
    report('生成后直接进编辑器填价（新单 #99 打开着、明细在、合计 0.00 等填）',
      okNewEditor && flat(card('pue-total')).indexOf('0.00') >= 0,
      card('pu-editor') ? flat(card('pue-total')) : 'no-editor');
    // 关掉编辑器再继续（遮罩挡着下面所有点击）
    card('pue-close').click();
    var okNewClosed = true;
    try { await waitFor(function () { return !card('pu-editor'); }, 4000); } catch (e) { okNewClosed = false; }
    report('编辑器关得掉（这一步不留遮罩挡住后面的操作）', okNewClosed, '');
    // 新单**真的入册**：列表出现 #99 一行，面板头跟着变（3 张 / 2 张草稿 —— 草稿数必须跟着涨，
    // 只涨总数不涨草稿说明口径接错了列）。
    var okNewRow = true;
    try {
      await waitFor(function () {
        return !!card('pu-edit-99') &&
          flat(card('pu-orders-meta')).indexOf('3 张') >= 0 &&
          flat(card('pu-orders-meta')).indexOf('2 张草稿待提交') >= 0;
      }, 6000);
    } catch (e) { okNewRow = false; }
    report('新单入册：列表出现 #99 一行，面板头跟着变（3 张 · 2 张草稿待提交 · 已提交 ¥500.00）',
      okNewRow && flat(card('pu-orders-meta')).indexOf('已提交 ¥500.00') >= 0,
      card('pu-orders-meta') ? flat(card('pu-orders-meta')) : 'no-meta');

    // ---- 忽略：原因要用户敲字 ⇒ **必须自绘弹层**（Electron 没有 window.prompt）----
    // 意图来自清单**行尾**（PickingView 只发意图；确认弹层与写库都在本面板 —— 见其头注释）。
    // 2026-10-10：忽略按**款色整组**生效（ignoreKey 里没有码）⇒ 动作挂在款色行上（键 = S1 · 黑）。
    card('pu-sub-pick').click();
    await waitFor(function () { return !!card('pk-ignore-S1 · 黑'); }, 8000);
    card('pk-ignore-S1 · 黑').click();
    await waitFor(function () { return !!card('pu-ignore-reason'); }, 4000);
    report('忽略走自绘弹层并给了原因输入框（不是在用 window.prompt）',
      !!card('pu-ignore-reason') && !!card('confirm-ok'), '');
    report('弹层说清是哪一款色（款色一行）+ 还差几件 + 影响范围（这款色含全部尺码）',
      flat(card('confirm-dialog')).indexOf('S1 · 黑') >= 0 &&
        flat(card('confirm-dialog')).indexOf('还差 2 件') >= 0 &&
        flat(card('confirm-dialog')).indexOf('全部尺码') >= 0,
      flat(card('confirm-dialog')));
    var reasonEl = card('pu-ignore-reason');
    reasonEl.value = '已线下拿';
    reasonEl.dispatchEvent(new Event('input', { bubbles: true }));
    var igBefore = calls('purchaseIgnoreAdd').length;
    report('没点确认时一个请求都不发（确认是真拦，不是装饰）',
      calls('purchaseIgnoreAdd').length === igBefore, '');
    await confirmOk();
    var okIg = true;
    try { await waitFor(function () { return calls('purchaseIgnoreAdd').length > igBefore; }, 6000); }
    catch (e) { okIg = false; }
    var iga = calls('purchaseIgnoreAdd')[igBefore] || {};
    report('忽略出参：款编码 + 款色 + 用户敲的原因，且**不带尺码**（按款色整组生效）',
      okIg && iga.styleCode === 'S1' && iga.color === '黑' && iga.reason === '已线下拿' &&
        iga.size === undefined,
      JSON.stringify(iga));

    // ---- 取消忽略（折起的忽略清单**展开后**撤销；撤销没有不可逆后果 ⇒ 不再要一次确认）----
    card('pu-ignore-toggle').click();
    var okExpand = true;
    try { await waitFor(function () { return !!card('pu-ignore-table'); }, 4000); }
    catch (e) { okExpand = false; }
    report('展开后忽略清单照实显示（S9 · 蓝 · 已线下拿），行尾给「取消忽略」',
      okExpand && flat(card('pu-ignore-table')).indexOf('已线下拿') >= 0 && !!card('pu-unignore-0'),
      card('pu-ignore-table') ? flat(card('pu-ignore-table')) : 'no-table');
    var unIgBefore = calls('purchaseIgnoreRemove').length;
    card('pu-unignore-0').click();
    var okUnIg = true;
    try { await waitFor(function () { return calls('purchaseIgnoreRemove').length > unIgBefore; }, 6000); }
    catch (e) { okUnIg = false; }
    var uniga = calls('purchaseIgnoreRemove')[unIgBefore] || {};
    report('取消忽略按「款编码 + 款色」整组撤销（S9 · 蓝）',
      okUnIg && uniga.styleCode === 'S9' && uniga.color === '蓝', JSON.stringify(uniga));

    // ---- 空态：不许留空白，要说清"为什么空 / 去哪做" ----
    // ⚠️ 容器的「刷新」必须**作废各面板缓存**（token+1）——只重算汇总不刷面板的话，
    //    面板会一直显示旧数据（这正是本轮顺手缝掉的缝）。所以这里点刷新就能看到新状态。
    //    三个开关一起开：订单行没了（清单空）+ 缺口空 + 拿货单空 ⇒ 两个子视图同时进空态。
    window.__emptyOrders = true;
    window.__noGap = true;
    window.__noPurchaseOrders = true;
    await clickRefresh();
    var okPickEmpty = true;
    try {
      await waitFor(function () {
        return !!card('empty') && flat(card('empty')).indexOf('一行订单都没扫到') >= 0;
      }, 8000);
    } catch (e) { okPickEmpty = false; }
    report('一行订单都没有时：清单空态说清"为什么空"并给可点的下一步（去导入）',
      okPickEmpty && !!card('empty-import') && !card('amount') && !card('gaps'),
      okPickEmpty ? flat(card('empty')) + ' | amount=' + !!card('amount') : 'timeout / 清单没进空态');
    // 空态的动作跟着**原因**走：「超窗」才给"调天数窗"；这里是"压根没扫到行"，给了就是把用户送去瞎点。
    report('空态的动作跟着**原因**走：不是超窗的场景不给「调天数窗」', !card('empty-widen'), '');
    var emptyImpBefore = evts('switch-module').length;
    card('empty-import').click();
    await waitFor(function () { return onTab('import'); }, 6000);
    report('清单空态的「去导入」= 就地切到「导入订单」页签（内嵌事件交给宿主，不跳模块）',
      onTab('import') && evts('switch-module').length === emptyImpBefore, '');

    // 拿货单空态（有入口回「要拿什么」，不是死胡同）
    await activateTab('purchase');
    card('pu-sub-orders').click();
    await waitFor(function () { return !!card('pu-order-none'); }, 6000);
    report('没有拿货单时给空态（说清最省事的开法 + 给「去看要拿什么」）',
      !!card('pu-goto-pick') && flat(card('pu-order-none')).indexOf('要拿什么') >= 0,
      flat(card('pu-order-none')));
    card('pu-goto-pick').click();
    await waitFor(function () { return card('pu-sub-pick').className.indexOf('is-on') >= 0; }, 4000);
    report('空态的按钮真的把子视图切回「要拿什么」（一步回到能干活的地方）',
      card('pu-sub-pick').className.indexOf('is-on') >= 0 && !!card('pk-bar'), '');

    // 数据回来后界面跟着回来（保活 + token 联动，不是一次性的）
    window.__emptyOrders = false;
    window.__noGap = false;
    window.__noPurchaseOrders = false;
    await clickRefresh();
    var okBack = true;
    try {
      await waitFor(function () {
        return !!card('amount') && flat(card('amount')).indexOf('待拿 1 款色') >= 0 && !!pickCard('S1 · 黑');
      }, 8000);
    } catch (e) { okBack = false; }
    report('数据回来后界面跟着回来（保活 + token 联动，不是一次性的）',
      okBack, (card('amount') ? flat(card('amount')) : 'no-amount') + ' | 清单卡=' + !!pickCard('S1 · 黑'));

    // 提示（toast）的读取工具。**必须"全部提示里有没有"**，不能用 querySelector 取第一条：
    // 同一时刻界面上可以并排好几条（本页跑完累计几十条），第一条往往是**旧**提示 ——
    // 症状是"新提示没出来"，排查方向会整个反掉（这条已在真实事故里踩过）。
    function toastTexts() {
      return Array.prototype.map.call(document.querySelectorAll('[data-act="toast"]'), function (el) {
        return el.textContent;
      });
    }
    function toastHas(part) {
      return toastTexts().some(function (t) { return t.indexOf(part) >= 0; });
    }
    function toastDump() { return toastTexts().join(' | '); }

    step('classify');
    // 「归类核对」页签（2026-10-05 内建；从「订单归类」岛搬来，功能照搬、样式走 .wb-*）。
    // 2026-10-10 按用户口径重做后，本段四个重点 —— 改这一段前先读组件头注释：
    //   ① 页头那排「待核对 / 未归类 / 识别库 / 已配产品」指标条**整条撤掉**（用户："看不懂"）；
    //   ② 「品类」「Logo」两列**撤掉**（等"印花 logo 管理"做出来再加回来）；
    //   ③ 列表图**不裁切**（核对是拿图比出来的，不是读文字读出来的）；
    //   ④ 颜色改成**跟着归属款走** + 记住"这张图上次定的颜色"。
    // 末尾仍有反向断言（批量识别 / 指标条各自的"它不在了"守卫）。
    await activateTab('classify');
    await waitFor(function () {
      return !!card('classify-panel') && !!card('cl-table');
    }, 10000);

    // 本段两个小工具。⚠️ 全段都在 ASSERT_SCRIPT 模板串里 ⇒ 注释里**不能出现反引号**。
    function setInput(act, val) {
      var el = card(act);
      if (!el) return false;
      el.value = val;
      // input 与 change **都要**派发：input 走 <input> 的 v-model，change 走 <select> 的 v-model
      // 与 @change 处理器。只派一种，另一支会静默不生效 —— 症状是"联动没接上"，很难查。
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
      return true;
    }
    function datalistValues(inputAct) {
      var el = card(inputAct);
      var id = el ? el.getAttribute('list') : '';
      var dl = id ? document.getElementById(id) : null;
      if (!dl) return { id: id, found: false, values: [] };
      return {
        id: id,
        found: true,
        values: Array.prototype.map.call(dl.querySelectorAll('option'), function (o) { return o.value; }),
      };
    }

    // ---- ① 页头指标条整条撤掉（用户："我看不太懂，用户肯定也会很懵"）----
    // ⚠️ 反向断言必须**自证非空转**：同一条 report 里先确认面板与表格真的在（同一个 card() 查找
    //    函数、同一时刻），否则 !card('cl-stats') 可能只是"这一页压根没挂上"。
    // ⚠️ 判据用的是「识别库 / 已配产品」这两个**只出现在那排指标条上**的词，不是「待核对」——
    //    面板标题就叫「待核对订单」，拿它判会把正常文案当成残留。
    report('页头的「待核对 / 未归类 / 识别库 / 已配产品」指标条整条撤掉（面板与表格仍在，不是空页）',
      !!card('classify-panel') && !!card('cl-table') && !card('cl-stats') &&
        flat(card('classify-panel')).indexOf('识别库') < 0 &&
        flat(card('classify-panel')).indexOf('已配产品') < 0,
      'cl-stats=' + (card('cl-stats') ? '仍在（错）' : '已无') +
        ' 表=' + (card('cl-table') ? '在' : '没了') +
        ' 面板文案=' + (card('classify-panel') ? flat(card('classify-panel')).slice(0, 48) : '?'));
    // 页头操作说明压到**一行**：点名款 → 选色 → 保存 / 确认无误，回车提示在即可。
    // ⚠️ 长度守卫是**刻意的**（2026-10-11 收瘦：原文案三行、含整段"为什么要点款"的解释）——
    //    这段的回归风险就是"又被人把解释抄回来"，长度是最省事也最准的判据。
    //    80 不是"美观线"：关键词（点名/颜色/保存/确认无误/回车）本身 ≈ 45 字，80 给的是
    //    "还能补半句实用提示"的余量，重抄回那段 ≈110 字的解释必然红。
    var clGuide = card('cl-guide');
    report('页头操作说明**一行讲完**（点名「归属款」→ 选色 → 保存 / 确认无误 + 回车提示），≤ 80 字',
      !!clGuide && flat(clGuide).length <= 80 &&
        flat(clGuide).indexOf('回车') >= 0 && flat(clGuide).indexOf('保存') >= 0 &&
        flat(clGuide).indexOf('确认无误') >= 0,
      clGuide ? 'len=' + flat(clGuide).length + ' | ' + flat(clGuide) : 'no-guide');
    // 连带：那条**只为指标条而生**的取数通道在渲染层一次都不该被读（留着它 = 每次进页面白跑一次往返）。
    // ⚠️ 判据钉在"electronAPI 上有没有人**读**这个键"，而不是"这个通道被调用了几次"：桩删掉之后
    //    后者恒为 0（读不到就无所谓调用）—— 那是条恒绿的假守卫。假桥在兜底分支里把**没人实现的键**
    //    记进 __unhandled，就是为这条断言留的钩子（顺带也把"本页偷偷用了什么没实现的键"暴露出来）。
    report('指标条的取数通道（orderSkuRollup）在渲染层一次都没被读（零消费者即删，不是"留着不显示"）',
      (calls('__unhandled') || []).indexOf('orderSkuRollup') < 0,
      '本页读过的未实现键=' + JSON.stringify(calls('__unhandled') || []));
    // ⚠️ 这条是**实测踩到的**（2026-10-10）：改版时把说明文字写成 markdown 粗体（两颗星号夹住一段话），
    //    而 Vue 模板**不解析 markdown** ⇒ 屏幕上原样显示成一串星号（日志里一眼看到）。
    //    所以判据是"渲染出来的文字里不许出现 markdown 记号"，不是"源码里有没有写"。
    //    同一条也顺手盖住反引号（注释里常写 o.color 这种，写进可见文案就是一样的事故）。
    //    ⚠️ 反引号要用 fromCharCode(96) 拼 —— 本段在模板串里，直接写一个反引号会把模板串提前闭合
    //       （上面刚踩过：写成字面量时 node --check 报的是文件末尾的 brace 不配，很难往这里想）。
    var BACKTICK = String.fromCharCode(96);
    report('面板上可见的文案没有漏出 markdown 记号（模板里写 **粗体** 会原样显示成一串星号）',
      (function () {
        var t = flat(card('classify-panel'));
        return !!t && t.indexOf('**') < 0 && t.indexOf(BACKTICK) < 0;
      })(),
      '文案片段=' + flat(card('classify-panel')).slice(0, 80));
    report('待核对五行都在（P-41 / P-42 / P-43 / P-44 / P-45），店铺逐格对',
      (function () {
        var t = flat(card('cl-table'));
        return t.indexOf('P-41') >= 0 && t.indexOf('P-42') >= 0 && t.indexOf('P-43') >= 0 &&
          t.indexOf('P-44') >= 0 && t.indexOf('P-45') >= 0 &&
          t.indexOf('店A') >= 0 && t.indexOf('店B') >= 0 && t.indexOf('店C') >= 0 && t.indexOf('店E') >= 0;
      })(),
      flat(card('cl-table')));

    // ---- 页头**范围切换**：待核对 5 / 已核对 2（2026-10-11 加计数，2026-10-12 两个数各自成范围）----
    // 用户问题 ②：「做完归类核对后，订单不知道在哪」—— 根因之一是**核对过的行全无屏幕可见**
    // （本页只查 corrected=0）。那两个数从"只读的计数句"变成**两个可点的范围**，就是这件事的解。
    // ⚠️ 夹具是 **5 待核对 + 2 已核对**（故意给 2，不是 0、也不是给满）：0 的话"计数实现坏了恒返回 0"
    //    照样绿；给满的话两个数相等，也分不出"数错了"。5 / 2 这组两边各自可辨。
    // ⚠️ 判据钉在两个**徽标各自的文本**上（不是"面板上出现过这两个数"）：后者会被列表里的
    //    行号/金额蒙对，而这里要的正是"哪个范围各有多少行"。
    report('页头范围切换：待核对 5 · 已核对 2（夹具刻意让两个数**不相等且都不为 0**，否则计数坏了也绿）',
      flat(card('cl-count-pending')) === '5' && flat(card('cl-count-corrected')) === '2',
      '待核对=' + JSON.stringify(flat(card('cl-count-pending'))) +
        ' 已核对=' + JSON.stringify(flat(card('cl-count-corrected'))));
    // 默认停在**待核对**：已核对是"出错了才去"的那一支，默认落在它上面会让每天第一次进来
    // 看到的是一屏不需要动的行（而这一页的本职工作是核对还没定的那些）。
    // **自证非空转**：下面那条 report 用同一个 card() 取到了两个范围按钮的真元素 ⇒
    // 这里的 !card(...) 不可能是"因为查不到元素才恒绿"。
    report('默认停在「待核对」范围（已核对不是首屏：它是出错了才去的那一支）',
      !!card('cl-scope-pending') && card('cl-scope-pending').className.indexOf('is-on') >= 0 &&
        !!card('cl-scope-corrected') && card('cl-scope-corrected').className.indexOf('is-on') < 0,
      '待核对=' + (card('cl-scope-pending') ? card('cl-scope-pending').className : 'missing') +
        ' 已核对=' + (card('cl-scope-corrected') ? card('cl-scope-corrected').className : 'missing'));
    // 反向夹具坐实"corrected 过滤真的做了"：CORRECTED_ORDERS（P-46 / P-47）**不许**出现在待核对表里。
    // ⚠️ 若实现漏了 corrected=false（或桥忽略该参数），表里会多出这两行 —— 那正是用户抱怨的
    //    "核对过的单还赖在待核对列表里"。只断言"5 行都在"是抓不到这个的（多出来的行不会被发现）。
    report('待核对表里**没有**已核对的那两行（P-46 / P-47）—— corrected 过滤真的生效，不是只多不少',
      (function () {
        var t = flat(card('cl-table'));
        return t.indexOf('P-46') < 0 && t.indexOf('P-47') < 0;
      })(),
      'P-46=' + (flat(card('cl-table')).indexOf('P-46') >= 0 ? '混进来了（错）' : '无') +
        ' P-47=' + (flat(card('cl-table')).indexOf('P-47') >= 0 ? '混进来了（错）' : '无'));

    // ---- ② 品类 / Logo 两列撤掉（等"印花 logo 管理"做出来再加回来）----
    // 判据钉在**表头**（7 列）与**控件**两处：只看表头会漏掉"列撤了、控件还在原地写值"这种
    // 半拉子改法 —— 那是最糟的一种（看不见，却仍在写）。两处都要，不能只留一处。
    var headTh = card('cl-table') ? card('cl-table').querySelectorAll('thead th') : [];
    var headText = Array.prototype.map.call(headTh, function (th) { return th.textContent.trim(); }).join('|');
    report('表格只剩 7 列（图 / 订单号 / 店铺 / 颜色 / 尺码 / 归属款 / 操作）—— 品类与 Logo 两列已撤',
      headTh.length === 7 && headText.indexOf('品类') < 0 && headText.indexOf('Logo') < 0 &&
        headText.indexOf('颜色') >= 0 && headText.indexOf('归属款') >= 0 && headText.indexOf('尺码') >= 0,
      '表头=' + headText);
    report('品类 / Logo 的输入控件也一并消失（列撤了控件却留着 = 看不见但仍在写）',
      !card('cl-cat-41') && !card('cl-logo-41') && !card('cl-cat-options'),
      'cl-cat-41=' + (card('cl-cat-41') ? '仍在（错）' : '已无') +
        ' cl-logo-41=' + (card('cl-logo-41') ? '仍在（错）' : '已无') +
        ' cl-cat-options=' + (card('cl-cat-options') ? '仍在（错）' : '已无'));

    // ⚠️ 缩略图合批只该带**有图**的行：无图行的 localPath 是空串，混进去就是白跑一次往返
    report('缩略图合批只带**有图**的行（P-41 + P-42 + P-44 三条），无图的 P-43 / P-45 不进请求',
      (calls('orderImageThumbBatch') || []).some(function (a) {
        return Array.isArray(a) && a.length === 3 &&
          a[0] && a[0].localPath === '/tmp/p41.jpg' &&
          a[1] && a[1].localPath === '/tmp/p42.jpg' &&
          a[2] && a[2].localPath === '/tmp/p44.jpg';
      }),
      JSON.stringify((calls('orderImageThumbBatch') || []).slice(-1)[0] || null));

    // ---- ③ 图**整张**看得见（用户报的"图片展示不全"）----
    // 根因是基座 .wb-thumb 的 40px + object-fit: cover（会裁掉边缘），而商品照多是竖版 ——
    // 上下两端恰恰是"这个款长什么样"的关键部位 ⇒ 本页覆盖成 contain。
    // ⚠️ 先等图片元素真的解码出内容（naturalWidth > 0）再判：图是异步加载的，在"元素在、但还没
    //    加载完"的那一刻取 computed style 读到的是占位状态，断言会变成"看运气"。
    try {
      await waitFor(function () {
        var ims = card('cl-table') ? card('cl-table').querySelectorAll('img') : [];
        return ims.length === 3 && Array.prototype.every.call(ims, function (im) {
          return im.complete && im.naturalWidth > 0;
        });
      }, 6000);
    } catch (e) { /* 下面那条断言会把实际值写出来 */ }
    var thumbImgs = card('cl-table') ? card('cl-table').querySelectorAll('img') : [];
    var thumbDetail = Array.prototype.map.call(thumbImgs, function (im) {
      var cs = getComputedStyle(im);
      return cs.objectFit + '/' + cs.width + 'x' + cs.height + '/nat=' + im.naturalWidth;
    }).join(' , ');
    report('列表图片是**整图**（放大的格子 + object-fit: contain），不是基座那个 40px cover 裁出来的中心块',
      thumbImgs.length === 3 && Array.prototype.every.call(thumbImgs, function (im) {
        var cs = getComputedStyle(im);
        return cs.objectFit === 'contain' && parseFloat(cs.width) >= 90 && im.naturalWidth > 0;
      }),
      'img数=' + thumbImgs.length + ' | ' + thumbDetail);

    // ---- ③b 尺寸：64px 不够，用户**原话复报**了一次"展示不全"（2026-10-12）----
    // 上一轮（10-10）修的是 cover→contain + 40→64px。同一句话再来一遍 ⇒ 图既然从来不缺角
    // （主进程等比缩放 + contain；真库 35 张 31 方 4 竖都完整），剩下的问题只能是**尺寸**：
    // 64px 看不清印花 / 领型 / 颜色，而这一页的全部工作就是拿图比对。
    // ⚠️ 阈值从"≥60"收到"≥90"：64px 那一版留下的旧阈值对 96px 与 64px **都放行**，
    //    等于这条断言对"到底放大了没有"不设防。判定值取实测 96。
    report('表格图放大到 96px（64px 时代用户原话复报"展示不全"—— 认款要看清印花/领型/颜色）',
      thumbImgs.length === 3 && Array.prototype.every.call(thumbImgs, function (im) {
        return parseFloat(getComputedStyle(im).width) >= 90 &&
          parseFloat(getComputedStyle(im).height) >= 90;
      }),
      thumbDetail);
    // 「能点开」必须**常显**：只写在 title 里的话，触屏 / 不会悬停的人永远看不到
    // （2026-10-10 PoolPane P2-1 同一个教训）。判据读**计算样式**而不是 class 名 ——
    // class 在、样式被别的规则盖掉，屏幕上还是没有（读 class 是恒绿的）。
    var zoomBtn = card('cl-zoom-41');
    var zoomMark = zoomBtn ? zoomBtn.querySelector('.cl-thumb-btn__zoom') : null;
    report('每张图带**常显**的「看大图」角标（⤢ 算得出来、不是只写在 title 里）',
      !!zoomBtn && !!zoomMark && getComputedStyle(zoomMark).display !== 'none' &&
        getComputedStyle(zoomMark).visibility !== 'hidden' &&
        parseFloat(getComputedStyle(zoomMark).opacity) > 0,
      zoomBtn
        ? 'btn=在 角标 display=' + getComputedStyle(zoomMark).display +
          ' opacity=' + getComputedStyle(zoomMark).opacity
        : 'no-zoom-btn');

    // ---- ③c 行高：两个文字动作不许换行把行撑高 ----
    // 「保存 / 确认无误」换行成两行时每行多出约 20px（5 行多占 100px），是用户报的
    // "样式有问题"里最扎眼的一处。判据是**几何**（两个按钮在同一视觉行上），不是 DOM 结构 ——
    // flex-wrap 从 wrap 改成 nowrap 之后，两个按钮**仍然都在 DOM 里**，只数元素个数分不出来。
    var save41 = card('cl-save-41');
    var ok41 = card('cl-ok-41');
    var opsTd = save41 ? save41.closest('td') : null;
    report('操作列「保存 / 确认无误」排在**同一行**（换行会把每行撑高，5 行多占 100px）',
      !!save41 && !!ok41 && save41.offsetTop === ok41.offsetTop &&
        !!opsTd && opsTd.scrollWidth <= opsTd.clientWidth + 1,
      save41 && ok41
        ? 'saveTop=' + save41.offsetTop + ' okTop=' + ok41.offsetTop +
          ' opsWrap=' + (opsTd ? getComputedStyle(opsTd).flexWrap : '?') +
          ' opsH=' + (opsTd ? getComputedStyle(opsTd).height : '?')
        : 'no-btns');

    // ---- ③d 页头：范围名只说一处（同一件事 adjacent 说两遍 = 本仓纪律）----
    // 原先是「面板标题 待核对订单」+ 紧挨着的「分段控件 待核对 5」，同一个信息写两遍。
    // 分段控件自带 is-on 高亮 + 计数 ⇒ 它是唯一真源，标题删掉。
    // ⚠️ 判据按**页头元素的文本**判，不按"整个面板"：面板里别处（空态出口"看已核对的 N 行"）
    //    出现"已核对"是正当的，只会在全局文本上误伤。
    var panelHead = document.querySelector('.wb-panel__head');
    report('页头不再重复写「待核对订单」—— 范围名只说一处（分段控件那个，带计数与选中态）',
      !!panelHead && flat(panelHead).indexOf('待核对订单') < 0 && flat(panelHead).indexOf('已核对订单') < 0,
      panelHead ? flat(panelHead) : 'no-head');

    // ---- ④「归属款」下拉的数据源 = **产品库全集**（用户报的"展示不全"就是它）----
    report('归属款下拉 = 产品库全集（自动匹配 + S1 + S2 + S9 = 4 个选项），识别池只有 2 款 ⇒ 3 个就说明驱动表没换',
      !!card('cl-style-41') && card('cl-style-41').options.length === 4,
      card('cl-style-41') ? 'options=' + card('cl-style-41').options.length : 'no-select');
    report('产品库里手工新建、识别池里没有的款也在下拉里（S9），且停用款带「（停用）」标记',
      (function () {
        var sel = card('cl-style-41');
        if (!sel) return false;
        var hit = Array.prototype.filter.call(sel.options, function (o) { return o.value === 'S9'; })[0];
        return !!hit && hit.textContent.indexOf('停用') >= 0;
      })(),
      card('cl-style-41')
        ? Array.prototype.map.call(card('cl-style-41').options, function (o) {
          return o.value + ':' + o.textContent;
        }).join(' / ')
        : 'no-select');
    // ⚠️ **默认值不能靠位置**：已归类那行要选中**它自己的款编码**（产品库驱动 ⇒ 下拉的 value 就是 code），
    //    不是第一个选项；未归类那行停在「自动匹配」（空值）。
    report('默认值不靠位置：已归类行选中它自己的款编码（P-42 → S1），未归类行停在「自动匹配」（空值）',
      !!card('cl-style-42') && card('cl-style-42').value === 'S1' &&
        !!card('cl-style-41') && card('cl-style-41').value === '',
      'P-42=' + (card('cl-style-42') ? card('cl-style-42').value : '?') +
        ' P-41=' + (card('cl-style-41') ? card('cl-style-41').value : '?'));

    // ---- ④ 颜色**跟着归属款走** + 记住"这张图上次定的颜色" ----
    // 取值优先级（每一支都要**落在该款的色卡里**才作数）：① 图记住的颜色 → ② 订单自己的颜色 → ③ 留空。
    // 三条各有专属夹具行，**不能合并**：只留 P-42 一条的话，"永远取订单自己的颜色"这种错法照样全绿
    //（P-42 两个值恰好都在色卡里）；只留 P-44 的话，"永远读记住的颜色"也能蒙对。
    var col42 = card('cl-color-42');
    report('点名了款 ⇒ 颜色格是**该款的下拉**（S1 色卡 = 请选择颜色 + 黑 + 白）',
      !!col42 && col42.tagName === 'SELECT' && col42.options.length === 3 &&
        Array.prototype.map.call(col42.options, function (o) { return o.value; }).join(',') === ',黑,白',
      col42 ? col42.tagName + ' opts=' +
        Array.prototype.map.call(col42.options, function (o) { return o.value; }).join(',') : 'no-el');
    report('图记住的颜色**在**该款色卡里 ⇒ 自动选中它（P-42 图记住「白」、订单自己的颜色是「黑」⇒ 必须是白）',
      !!col42 && col42.value === '白',
      col42 ? 'value=' + col42.value : 'no-el');
    var col45 = card('cl-color-45');
    report('图记住的颜色**不在**色卡、订单自己的颜色在 ⇒ 回落选订单那个（P-45 记住「印花」/ 订单「黑」⇒ 黑）',
      !!col45 && col45.tagName === 'SELECT' && col45.value === '黑',
      col45 ? col45.tagName + ' value=' + col45.value : 'no-el');
    var col44 = card('cl-color-44');
    report('两个颜色都**不在**色卡里 ⇒ 留空让用户自己选（P-44 记住与订单都是「印花」⇒ 空），并写明原因',
      !!col44 && col44.tagName === 'SELECT' && col44.value === '' && !!card('cl-color-warn-44'),
      col44 ? 'value=' + JSON.stringify(col44.value) +
        ' warn=' + (card('cl-color-warn-44') ? flat(card('cl-color-warn-44')) : '无') : 'no-el');
    var col41 = card('cl-color-41');
    report('没点名款 ⇒ 颜色格回落**自由输入**（本款没有色卡，给下拉就成了无源之水）',
      !!col41 && col41.tagName === 'INPUT' && col41.value === '黑',
      col41 ? col41.tagName + ' value=' + col41.value : 'no-el');
    // 自由输入那一支的输入建议（datalist）= 标准色词表 + 本库已用过的写法。
    // ⚠️ 只断言"有 datalist"不够 —— list 属性写歪、datalist 空壳都会让它恒绿，所以三条分开：
    //    ①list 指向的元素真的在 ②内容里有**词表**写法（灰色） ③内容里有**本库数据**（灰 —— 词表里
    //    没有这个写法，只可能来自订单行）。少了 ③，"只读词表、不读库"的实现照样全绿。
    var colOpt = datalistValues('cl-color-41');
    report('颜色自由输入的输入建议真的挂上了（list 指向的 datalist 存在且选项非空）',
      !!colOpt.id && colOpt.found && colOpt.values.length > 0,
      'list=' + colOpt.id + ' found=' + colOpt.found + ' 选项数=' + colOpt.values.length);
    report('颜色建议 = 标准色词表 + 本库已用过的写法（灰色 来自词表；灰 只可能来自本页订单）',
      colOpt.found && colOpt.values.indexOf('灰色') >= 0 && colOpt.values.indexOf('灰') >= 0,
      'list=' + colOpt.id + ' ' + JSON.stringify(colOpt.values.slice(0, 14)));

    // ---- ⭐「同商品」徽标：这一页到底有几件事要定 ----
    // P-41 与 P-42 是**同一家店的同一个商品ID**（店A/IT-A）⇒ 两行都标「同商品 ×2」；
    // P-43 没有商品ID、P-44 的商品只此一行 ⇒ 两者都**不许**有徽标。
    // ⚠️ 这三个判据必须**分开看**：
    //    · 只断言"P-41 有徽标" ⇒ "凡有商品ID 就标"这种错法照样全绿（P-44 正是用来打它的）；
    //    · 只断言"P-43 没有" ⇒ "徽标恒显示"这种错法照样全绿（P-41/P-42 用来打它）。
    // **自证非空转**：P-41/P-42 两个元素是同一个 card() 取到的真元素 ⇒ 下面 P-43/P-44 的
    //    !card(...) 不可能是"因为查不到任何元素才恒绿"。
    report('同商品徽标：同店同商品ID 的两行各标「同商品 ×2」（P-41 / P-42）',
      !!card('cl-same-41') && flat(card('cl-same-41')).indexOf('同商品 ×2') >= 0 &&
        !!card('cl-same-42') && flat(card('cl-same-42')).indexOf('同商品 ×2') >= 0,
      'P-41=' + (card('cl-same-41') ? flat(card('cl-same-41')) : '无徽标') +
        ' P-42=' + (card('cl-same-42') ? flat(card('cl-same-42')) : '无徽标'));
    report('同商品徽标**不**乱标：没有商品ID 的 P-43、商品只此一行的 P-44 都没有徽标',
      !card('cl-same-43') && !card('cl-same-44'),
      'P-43=' + (card('cl-same-43') ? '有徽标（错）' : '无') +
        ' P-44=' + (card('cl-same-44') ? '有徽标（错）' : '无'));

    // ---- ④b 「颜色无处挂」：没点名款、又没有可用于自动匹配的指纹 ⇒ 不许"保存成功" ----
    // 载体是 P-43（无款 + 空品类 + 空特征，见夹具头的说明）。这条判据**必须两边都看**：
    //   · P-43 填了颜色却没处挂 ⇒ 提示在 + 「保存」按不下去；
    //   · P-41 同样没点名款，但它有特征（指纹非空、能自动匹配）⇒ **不许**出现同一个提示 ——
    //     否则"凡没点名款就拦"这种错法会把自动匹配这条路整条堵死，而只盯 P-43 是全绿的。
    // 与下面 ⑥ 的那条配成一对：**同一个动作（填颜色）在两行上给相反的结果**，才分得出是哪条在起作用。
    setInput('cl-color-43', '青');
    var okOrphan = true;
    try {
      await waitFor(function () {
        var el = card('cl-color-43');
        return !!el && el.value === '青' && !!card('cl-style-warn-43') &&
          !!card('cl-save-43') && card('cl-save-43').disabled === true;
      }, 4000);
    } catch (e) { okOrphan = false; }
    report('有颜色却没款可挂：P-43（无款 + 空品类 + 空特征）给提示且「保存」按不下去',
      okOrphan,
      '值=' + JSON.stringify(card('cl-color-43') ? card('cl-color-43').value : null) +
        ' 提示=' + (card('cl-style-warn-43') ? flat(card('cl-style-warn-43')) : '无') +
        ' save禁用=' + (card('cl-save-43') ? String(card('cl-save-43').disabled) : 'no-el'));
    report('换个行就不拦：P-41 也没点名款，但它有特征（指纹非空、能自动匹配）⇒ 没有这条提示',
      !card('cl-style-warn-41'),
      'P-41提示=' + (card('cl-style-warn-41') ? flat(card('cl-style-warn-41')) : '无'));

    // ---- ⑤ 换款就换色卡；原颜色不在新色卡里 ⇒ 清空 + 拦住「保存」----
    // 用 P-43（未归类、颜色是自由输入、刚被填成「青」）：点 S1 后「青」不在 S1 的（黑/白）里 ⇒ 应被清空。
    // ⚠️ 这三条**必须连着看才叫验过**：只断言"保存禁用"会被"这行本来就不脏"满足（恒绿），
    //    所以后面补一条"补上颜色立刻可保存"—— 它才证明卡住的是缺色，不是"没改动"。
    setInput('cl-style-43', 'S1');
    var okPick = true;
    try {
      await waitFor(function () {
        var el = card('cl-color-43');
        return !!el && el.tagName === 'SELECT' && el.value === '' && !!card('cl-color-warn-43');
      }, 4000);
    } catch (e) { okPick = false; }
    report('换款后色卡跟着换：原颜色不在新色卡里 ⇒ 清空并提示（P-43 的「灰」不在 S1 的黑/白里）',
      okPick,
      'tag=' + (card('cl-color-43') ? card('cl-color-43').tagName : '?') +
        ' value=' + JSON.stringify(card('cl-color-43') ? card('cl-color-43').value : null) +
        ' warn=' + (card('cl-color-warn-43') ? flat(card('cl-color-warn-43')) : '无'));
    report('点名了款却没给颜色时「保存」按不下去（否则会落出一个没有名字的款色，而界面上看不出异常）',
      !!card('cl-save-43') && card('cl-save-43').disabled === true,
      'disabled=' + (card('cl-save-43') ? card('cl-save-43').disabled : 'no-el'));
    setInput('cl-color-43', '黑');
    var okEnable = true;
    try { await waitFor(function () { return !!card('cl-save-43') && card('cl-save-43').disabled === false; }, 4000); }
    catch (e) { okEnable = false; }
    report('补上颜色后**同一行**立刻可保存 —— 证明上面"按不下去"卡的是缺色，不是"这行压根没改动"',
      okEnable, '');

    // ---- ⑥ 保存（没点名款）：只走重归类，出参必须带指纹 ----
    report('没改动时「保存」是禁用的（不做"点了没反应"的假动作）',
      !!card('cl-save-41') && card('cl-save-41').disabled === true, '');
    setInput('cl-color-41', '白');
    var okDirty = true;
    try { await waitFor(function () { return !!card('cl-save-41') && card('cl-save-41').disabled === false; }, 4000); }
    catch (e) { okDirty = false; }
    report('改了颜色后才允许保存（脏值一眼看得出来）', okDirty, '');

    var updBefore = calls('orderUpdate').length;
    var asgBefore = calls('orderStyleAssign').length;
    var clListB = calls('orderList').length;
    await clickReady('cl-save-41');
    var okSave = true;
    try { await waitFor(function () { return calls('orderUpdate').length > updBefore; }, 6000); }
    catch (e) { okSave = false; }
    var cu = calls('orderUpdate')[updBefore] || {};
    // ⚠️ fingerprint 是宿主重归类分支的**必要条件**（reclassify && fingerprint）——
    //    只传 reclassify 是静默空操作（旧版岛里就漏传过）。所以这条钉在指纹上，不是钉在 reclassify 上。
    report('保存带**指纹** + reclassify + 特征（宿主按指纹重算归属款；漏指纹就是静默空操作）',
      okSave && cu.id === 41 && cu.reclassify === true && !!cu.fingerprint &&
        Array.isArray(cu.features) && cu.features.length === 2,
      JSON.stringify(cu));
    report('没点名款时不挂款（自动匹配走重归类，不走 orderStyleAssign）',
      calls('orderStyleAssign').length === asgBefore, '');
    // ⚠️ 这条是下面那条正面断言的**反向守卫**：只改品类/颜色那次没有回流（宿主根本没收到点名），
    //    提示里就不能出现"已记住这个商品" —— 否则那句提示成了恒显示的噪音，
    //    真回流时用户也不会再多看一眼（"狼来了"）。
    // ⚠️⚠️ 必须**先等这次保存的提示渲染出来**再断言"里面没有那句话"。踩过的坑（本轮实测）：
    //    假桥是在 invoke 的**同步**阶段记录调用的，而 toast 要等 await 回来才 push、再等 Vue
    //    渲染才进 DOM；直接在"通道被调用"的那一刻取 DOM，只会得到"还没有提示"——
    //    于是这条**反向**断言恒绿（"提示还没渲染"和"提示里没有那句话"长得一模一样），
    //    把提示改成恒显示那句、它照样全绿。等待判据钉在**只有这次保存才会有**的那句话上。
    var saveToastSeen = true;
    try {
      await waitFor(function () { return toastHas('已保存，归属 S1'); }, 4000);
    } catch (e) { saveToastSeen = false; }
    report('保存提示真的渲染出来了（下面"没有那句话"必须有这个前提才算数）',
      saveToastSeen, toastDump());
    report('没点名款的那次保存**不**谎称"已记住这个商品"（回流提示只在真的回流时出现）',
      saveToastSeen && !toastHas('已记住这个商品'), toastDump());

    // 等重取完成（bump → token → load → orderList）再做"点名款"那一段
    var okReload = true;
    try { await waitFor(function () { return calls('orderList').length > clListB; }, 8000); }
    catch (e) { okReload = false; }
    report('保存后整页重取（保活的旧数据不会赖着不走）', okReload, '');

    // ---- ⑦ 点名某个款 + 从**该款的色卡**里选颜色 ⇒ 两件事一起落库 ----
    setInput('cl-style-41', 'S2');
    var okPick2 = true;
    try {
      await waitFor(function () {
        var el = card('cl-color-41');
        return !!el && el.tagName === 'SELECT' && el.value === '' && !!card('cl-color-warn-41');
      }, 4000);
    } catch (e) { okPick2 = false; }
    report('同一段联动在另一行复现：P-41 刚改的「白」不在 S2 的色卡（只有蓝）里 ⇒ 换款后清空并提示',
      okPick2,
      'tag=' + (card('cl-color-41') ? card('cl-color-41').tagName : '?') +
        ' value=' + JSON.stringify(card('cl-color-41') ? card('cl-color-41').value : null));
    report('点名款但还没选颜色：P-41 的「保存」也按不下去（同一条守卫，换一行照样成立）',
      !!card('cl-save-41') && card('cl-save-41').disabled === true, '');
    setInput('cl-color-41', '蓝');
    var okDirty2 = true;
    try { await waitFor(function () { return !!card('cl-save-41') && card('cl-save-41').disabled === false; }, 4000); }
    catch (e) { okDirty2 = false; }
    report('从该款色卡里选上颜色后可以保存', okDirty2, '');
    var asg2 = calls('orderStyleAssign').length;
    await clickReady('cl-save-41');
    var okAsg = true;
    try { await waitFor(function () { return calls('orderStyleAssign').length > asg2; }, 6000); }
    catch (e) { okAsg = false; }
    var ca = calls('orderStyleAssign')[asg2] || {};
    // ⚠️ 必须走**款编码**而不是 id：下拉的数据源是产品库全集，产品库里手工新建的款在识别池里没有行
    //    （宿主按 code ensureStyleByCode 补占位款）—— 发 id 的话那些款根本点不了。
    report('点名款走的是**款编码** + 选中的颜色 + 指纹 {orderId:41, styleCode:S2, color:蓝}',
      okAsg && ca.orderId === 41 && ca.styleCode === 'S2' && ca.color === '蓝' && !!ca.fingerprint,
      JSON.stringify(ca));

    // ---- ⭐ 回流被**说出来**（"记住了"这件事不说，用户就不知道它可以重复发生）----
    // 同样要先**等**它出现（理由同上：通道被调用的那一刻提示还没进 DOM）。
    // 判据钉在**只有回流成功才会有**的那句话上（含顺带归好的单数）——
    // 只断言"出现了某个提示"会被上一条保存的提示满足（同族假绿）。
    var backfillToastSeen = true;
    try {
      await waitFor(function () { return toastHas('另有 2 单一起归好了'); }, 4000);
    } catch (e) { backfillToastSeen = false; }
    report('回流被说出来：点名款后提示「已记住这个商品 → 款和颜色，另有 2 单一起归好了」',
      backfillToastSeen && toastHas('已记住这个商品'), toastDump());

    // ---- ⭐⭐ 点名款**不要求指纹**（2026-10-11 用户报"归类核对设的颜色不生效"的回归守卫）----
    // 载体是 P-45 = **生产形状**（有款 S1 + 空品类 + 空特征 ⇒ 指纹是空串）。真库每一行都是这个形状。
    // 改前那句是 if (named && fingerprint) ⇒ 挂款 / 颜色记忆 / 商品ID 回流**一次都不跑**，
    //   而 orderUpdate 那一步照样写订单自己的 color 列、提示还说"已保存" ⇒ 用户设的颜色哪儿都没生效
    //   （拿货单 / 算钱 / 取图读的都是款色）。上面 ⑦ 那条用的是 P-41（指纹非空）⇒ **它挡不住这个回归**。
    // 判据钉在**请求载荷**上，不钉回执：回执是假桥的固定值，拿回执反推请求，改坏了照样能全绿。
    var asgEmpty = calls('orderStyleAssign').length;
    var clListC = calls('orderList').length;
    setInput('cl-color-45', '白');
    var okDirty45 = true;
    try { await waitFor(function () { return !!card('cl-save-45') && card('cl-save-45').disabled === false; }, 4000); }
    catch (e) { okDirty45 = false; }
    report('空指纹那一行的保存前提就绪：P-45 改了颜色后「保存」可点', okDirty45, '');
    await clickReady('cl-save-45');
    var okAsgEmpty = true;
    try { await waitFor(function () { return calls('orderStyleAssign').length > asgEmpty; }, 6000); }
    catch (e) { okAsgEmpty = false; }
    var caE = calls('orderStyleAssign')[asgEmpty] || {};
    report('指纹为空也**照样挂款**：P-45 点名 S1 + 颜色 白 ⇒ orderStyleAssign 被调用（带款编码与颜色，指纹为空）',
      okAsgEmpty && caE.orderId === 45 && caE.styleCode === 'S1' && caE.color === '白' && !caE.fingerprint,
      JSON.stringify(caE));
    // 等这次保存触发的重取落地再进键盘流那一段（否则会和它的"列表缩水/焦点"判据抢时序）
    try { await waitFor(function () { return calls('orderList').length > clListC; }, 8000); } catch (e) { /* 下一条不依赖它 */ }

    // ---- 键盘流：回车＝保存这一行，焦点自动交给**顶上来的**那一条 ----
    // ⚠️ 从这里开始让夹具**模拟宿主的真实行为**：已核对的单离开待核对列表
    //    （updateOrder 写 corrected = 1）。前面不开这一步是因为那些断言要反复操作同一行；
    //    而下面这条断言**只有对齐之后才有意义** —— 列表不缩水时，焦点"回到第 N 行"永远成立，
    //    根本分不出"往下走了一格"和"原地没动"。
    window.__emulateCorrected = true;
    window.__correctedIds = [];
    setInput('cl-color-42', '黑');
    var okDirty3 = true;
    try { await waitFor(function () { return !!card('cl-save-42') && card('cl-save-42').disabled === false; }, 4000); }
    catch (e) { okDirty3 = false; }
    report('回车流的前提就绪：改了颜色后该行可保存', okDirty3, '');
    var updKey = calls('orderUpdate').length;
    // 在**行内控件**上派发 Enter（会冒泡到 tr 上的 @keydown.enter）
    card('cl-color-42').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    var okKeySave = true;
    try { await waitFor(function () { return calls('orderUpdate').length > updKey; }, 6000); }
    catch (e) { okKeySave = false; }
    report('行内按回车就能保存（不必去够鼠标点「保存」）',
      okKeySave && (calls('orderUpdate')[updKey] || {}).id === 42,
      JSON.stringify(calls('orderUpdate')[updKey] || {}));
    // 等焦点落定：保存后该行离开列表，原 P-43 顶到它的位置 ⇒ 焦点应在 P-43 的归属款下拉上
    var okFocus = true;
    try {
      await waitFor(function () {
        return !card('cl-style-42') && !!card('cl-style-43') && document.activeElement === card('cl-style-43');
      }, 6000);
    } catch (e) { okFocus = false; }
    report('保存后该行离开待核对列表，焦点自动落到**顶上来的**那一条（原 P-42 的位置 → 现在是 P-43）',
      okFocus,
      'P-42行=' + (card('cl-style-42') ? '仍在（错）' : '已离开') +
        ' 焦点=' + (document.activeElement && document.activeElement.getAttribute
          ? String(document.activeElement.getAttribute('data-act'))
          : String(document.activeElement)));

    // ---- ⭐ 确认无误 的守卫：有没保存的改动时**不许**确认（否则刚填的颜色被静默丢掉）----
    // 「确认无误」只把 corrected 置 1、**不写任何字段** ⇒ 用户"选了颜色再点确认无误"是很自然的动作
    // （两个按钮就在同一格里），而这一下会把刚填的东西丢掉、那一行还离开了列表。
    // 真库现场正是这个形状：23 行全 corrected=1、oi_orders.color 全空、款色全是「未分类」。
    // ⚠️ 位置很讲究：必须放在**上一段重取已经落定之后**（上面的焦点断言就是那个信号）。
    //    放早了会撞上重取 —— 重取会把草稿按主进程的数据重建（本页有意为之），
    //    于是"我这边刚填的颜色"被冲掉，行**根本没脏**，这条断言会以"守卫没触发"的样子假红。
    //    ⚠️ "点了但什么都没发生"这类断言**必须先证明前提成立**（这一行真的脏了）——
    //    否则"按钮点不动 / 行不在 / 值没填进去"都能让它恒绿（本仓反复踩过的空转）。
    // ⚠️ 判据钉在**通道没被调用**上（不是钉提示）：提示给错一句话不影响数据，落库了才是真丢东西。
    await waitFor(function () { return !!card('cl-style-44') && !!card('cl-color-44'); }, 6000);
    setInput('cl-color-44', '黑');
    var okDirty44 = true;
    try { await waitFor(function () { return !!card('cl-save-44') && card('cl-save-44').disabled === false; }, 4000); }
    catch (e) { okDirty44 = false; }
    report('确认守卫的前提就绪：P-44 填了颜色（该行变脏、「保存」可点）',
      okDirty44,
      '存在=' + !!card('cl-color-44') + ' 值=' +
        JSON.stringify(card('cl-color-44') ? card('cl-color-44').value : null) +
        ' save=' + (card('cl-save-44') ? String(card('cl-save-44').disabled) : 'no-el'));
    var mkGuard = calls('orderMarkCorrected').length;
    await clickReady('cl-ok-44');
    // 守卫是同步弹提示的 ⇒ 给渲染一点时间即可（toast 2s 后自动下线，别等太久把它等没了）
    await new Promise(function (r) { setTimeout(r, 300); });
    report('单行「确认无误」在**有未保存改动**时不落库，并说清要先保存',
      calls('orderMarkCorrected').length === mkGuard && toastHas('先点「保存」'),
      '调用数=' + calls('orderMarkCorrected').length + '（点前 ' + mkGuard + '）| 提示=' + toastDump());
    // 批量那道口子：**任一行**脏就不许"全部确认"（一起丢、且说不清是哪几行）
    var mkAllGuard = calls('orderMarkCorrected').length;
    await clickReady('cl-all-ok');
    await new Promise(function (r) { setTimeout(r, 300); });
    report('「全部确认无误」在任一行有未保存改动时也不落库（提示与单行那条不同，是批量版）',
      calls('orderMarkCorrected').length === mkAllGuard && toastHas('先逐行点「保存」'),
      '调用数=' + calls('orderMarkCorrected').length + '（点前 ' + mkAllGuard + '）| 提示=' + toastDump());
    // 把 P-44 的草稿改回原样（它载入时颜色就是空的），免得脏着影响后面这两段确认与空态
    setInput('cl-color-44', '');
    await waitFor(function () { return !!card('cl-save-44') && card('cl-save-44').disabled === true; }, 4000);

    // ---- 确认无误：单行 / 全部两条分支 ----
    var mkB = calls('orderMarkCorrected').length;
    await clickReady('cl-ok-43');
    var okMk = true;
    try { await waitFor(function () { return calls('orderMarkCorrected').length > mkB; }, 6000); }
    catch (e) { okMk = false; }
    report('单行「确认无误」只标这一行（orderMarkCorrected [43]，不是全部）',
      okMk && JSON.stringify(calls('orderMarkCorrected')[mkB]) === '[43]',
      JSON.stringify(calls('orderMarkCorrected')[mkB]));

    var mkA = calls('orderMarkCorrected').length;
    await clickReady('cl-all-ok');
    var okMkAll = true;
    try { await waitFor(function () { return calls('orderMarkCorrected').length > mkA; }, 6000); }
    catch (e) { okMkAll = false; }
    report('「全部确认无误」走 all 分支（orderMarkCorrected {all:true}）',
      okMkAll && JSON.stringify(calls('orderMarkCorrected')[mkA]) === '{"all":true}',
      JSON.stringify(calls('orderMarkCorrected')[mkA]));

    // ---- 反向断言：批量识别已删除（2026-10-05 用户要求）----
    // 删功能**必须留一条"它不在了"的守卫**，否则哪天有人把按钮加回来，冒烟照样全绿、
    // 而且没人会想起来"这个动作是被有意拿掉的"。判据钉在 data-act 上（比文案稳）：
    // 文案随时可以改，data-act 里的动作名 cl-recognize 才是刻意不再启用的那个判据。
    // ⚠️ 本段整块是**注入脚本的内容**（在 ASSERT_SCRIPT 模板串里）⇒ 注释里不能出现反引号，
    //    否则会把模板串提前闭合、整段代码变成语法错误（本文件第 9 行本来就写着这条）。
    // ⚠️ 真要加回识别入口时，**改这条断言**（而不是绕开它）—— 那一刻就是"重新确认设计"的时机。
    // **自证非空转**：下一条 report 用**同一个** card() 取到了 cl-query / cl-reload 两个真元素
    // ⇒ 上面的 !card(...) 不可能是"因为查不到任何元素才恒绿"（同一个查找函数，同一页同一时刻）。
    report('工具条不再有「识别未归类」批量按钮（该动作已按用户要求删除，本页只留逐行动作）',
      !card('cl-recognize') && !card('cl-stop') && !card('cl-progress'),
      'cl-recognize=' + (card('cl-recognize') ? '仍在' : '已无') +
        ' cl-stop=' + (card('cl-stop') ? '仍在' : '已无') +
        ' cl-progress=' + (card('cl-progress') ? '仍在' : '已无'));
    report('删除后工具条仍能用：查询 / 刷新都在，且没有任何按钮停在 disabled',
      !!card('cl-query') && !card('cl-query').disabled &&
        !!card('cl-reload') && !card('cl-reload').disabled,
      'query=' + (card('cl-query') ? String(card('cl-query').disabled) : 'missing') +
        ' reload=' + (card('cl-reload') ? String(card('cl-reload').disabled) : 'missing'));

    // ---- 空态：待核对清零 ----
    window.__noPendingOrders = true;
    await clickRefresh();
    var okClEmpty = true;
    try { await waitFor(function () { return !!card('cl-empty'); }, 8000); } catch (e) { okClEmpty = false; }
    report('待核对清零时给空态，并说清"核对的对象从哪来"（不是干巴巴的"暂无数据"）',
      okClEmpty && flat(card('cl-empty')).indexOf('导入') >= 0 && !!card('cl-goto-import'),
      okClEmpty ? flat(card('cl-empty')) : 'timeout');
    window.__noPendingOrders = false;
    await clickRefresh();
    var okClBack = true;
    try { await waitFor(function () { return !!card('cl-table'); }, 8000); } catch (e) { okClBack = false; }
    report('数据回来后表格跟着回来（刷新作废面板缓存，不是一次性的）', okClBack, '');

    // ---- 空态之二：**今天这批都核对完了**（2026-10-11 新增，用户问题 ② 的正解）------------
    // 这是与上面那条**不同**的空态：上面是"什么都没导"（待核对 0、已核对 0 ⇒ 出口 = 去导入），
    // 这里是"导过、全核完了"（待核对 0、已核对 > 0 ⇒ 出口 = 流程的第 3、4 步）。
    // ⚠️ 两者必须分开造：只有一个开关的话，"核完了"这条路径在冒烟里走不到 —— 而它才是用户抱怨的
    //    "做完归类核对后订单不知道在哪"要治的那条（原先这里什么都没有，用户核对完就断在这一页）。
    window.__allCorrected = true;
    await clickRefresh();
    var okClDone = true;
    try { await waitFor(function () { return !!card('cl-empty'); }, 8000); } catch (e) { okClDone = false; }
    report('待核对清零但有已核对的行时：空态说「今天这批都核对完了」（与"什么都没导"区分开）',
      okClDone && flat(card('cl-empty')).indexOf('今天这批都核对完了') >= 0 &&
        flat(card('cl-empty')).indexOf('今天还没有导入订单') < 0,
      okClDone ? flat(card('cl-empty')) : 'timeout');
    // 出口是**可点**的第 3、4 步（提示不是入口：空态说明里的下一步必须点得到）。
    // ⚠️ 两件事一起验：按钮在 + **它真的切页签**（看不见的按钮点了等于没点；只验在不在会漏"点了没反应"）。
    // ⚠️ 2026-10-12 起是**三个**出口：第三个「看已核对的 N 行」是**往后走**（核对完了发现漏/错了），
    //    前两个是往前走。判据里要带上它，否则"哪天后两个被换掉"照样绿。
    report('「都核对完了」空态给三个可点出口：去算钱 / 去看要拿什么（第 3、4 步）+ 看已核对的行',
      !!card('cl-goto-cost') && !!card('cl-goto-purchase') && !!card('cl-goto-corrected') &&
        !card('cl-goto-import'),
      'cost=' + (card('cl-goto-cost') ? '在' : '无') + ' purchase=' + (card('cl-goto-purchase') ? '在' : '无') +
        ' corrected=' + (card('cl-goto-corrected') ? '在' : '无') +
        ' import=' + (card('cl-goto-import') ? '在（错：这不是"没导过"）' : '无'));
    // ⭐ 第三个出口要**真的切范围并列出内容**（不是"点了仍停在空态"）：两个范围共用同一个
    //    视图与同一个取数实现 ⇒ 切过去应该看到行。__allCorrected 还开着 ⇒ 那边列的是全部行。
    card('cl-goto-corrected').click();
    var okGotoCorr = true;
    try {
      await waitFor(function () {
        return !card('cl-empty') && !!card('cl-table') && !!card('cl-scope-corrected') &&
          card('cl-scope-corrected').className.indexOf('is-on') >= 0;
      }, 8000);
    } catch (e) { okGotoCorr = false; }
    report('点「看已核对的行」切到已核对范围并真的列出内容（不是仍停在空态上）',
      okGotoCorr,
      '空态=' + (card('cl-empty') ? '仍在（错）' : '已无') + ' 表=' + (card('cl-table') ? '在' : '没了'));
    card('cl-scope-pending').click();
    await waitFor(function () { return !!card('cl-empty'); }, 8000);
    card('cl-goto-cost').click();
    await waitFor(function () { return onTab('cost') && !!document.querySelector(PANEL_SEL.cost); }, 8000);
    report('点「去算钱」真的切到「算钱」页签（就地切换，不跳模块）', onTab('cost'), '');
    await activateTab('classify');
    await waitFor(function () { return !!card('cl-empty'); }, 8000);
    var pBeforeGoto = evts('switch-module').length;
    card('cl-goto-purchase').click();
    await waitFor(function () { return onTab('purchase') && !!document.querySelector(PANEL_SEL.purchase); }, 8000);
    report('点「去看要拿什么」真的切到「拿货」页签（且是就地切页签，没走 switch-module）',
      onTab('purchase') && evts('switch-module').length === pBeforeGoto, '');
    window.__allCorrected = false;
    await activateTab('classify');
    await clickRefresh();
    var okClRestore = true;
    try { await waitFor(function () { return !!card('cl-table'); }, 8000); } catch (e) { okClRestore = false; }
    report('关掉"全核完了"后表格回来（开关没有粘住）', okClRestore, '');

    // ============ 「已核对」范围 + 行内「退回待核对」（2026-10-12）========================
    // 要治的：核对过之后发现定错了款/色 —— 那些行按定义不在待核对列表里（本页只查 corrected=0），
    // 屏幕上根本没有它们，也就没有任何地方能改回去。真库现场：23 行全 corrected=1、color 全空、
    // 款色全是「未分类」，而代码里此前**没有任何一处**会把 corrected 置回 0（用户再也回不到那些行）。
    //
    // ⚠️ 夹具先**复位到基线**：上面几段（保存 / 确认单行 / 全部确认）已经把 __correctedIds 攒到
    //    {42,43} —— 那会让"已核对几行"变成一个跟着前面段落走的数（前面改一句断言这里就变）。
    //    复位到 P-46 / P-47 这两行，下面的判据才有**确定的数**（5 待核对 · 2 已核对）而不是"恰好"。
    //    ⚠️ 复位动的是**夹具的集合**、不是断言 —— 这不是"把跑不过的删掉"，是把夹具摆成它该有的形状。
    window.__correctedIds = [];
    window.__reopenedIds = [];
    await clickRefresh();
    await waitFor(function () { return !!card('cl-table'); }, 8000);

    // ---- 切到「已核对」：列出来的必须是**另一批行** ----
    card('cl-scope-corrected').click();
    var okScope = true;
    try {
      await waitFor(function () {
        return !!card('cl-table') && flat(card('cl-table')).indexOf('P-46') >= 0 &&
          !!card('cl-scope-corrected') && card('cl-scope-corrected').className.indexOf('is-on') >= 0;
      }, 8000);
    } catch (e) { okScope = false; }
    report('切到「已核对」范围：列出已核对的行（P-46 在），切换按钮进选中态',
      okScope,
      '表=' + (card('cl-table') ? flat(card('cl-table')).slice(0, 60) : '没了') +
        ' 已核对按钮=' + (card('cl-scope-corrected') ? card('cl-scope-corrected').className : 'missing'));
    // ⭐ 反向守卫：**待核对的行不许混进来**。只断言"P-46 在"的话，取数忘了传 corrected:true
    //    （两个范围列同一批行）照样全绿 —— 而那正是"换个范围看不出区别"这个毛病本身。
    report('「已核对」范围里**没有**待核对的行（P-41…P-45）—— 两个范围真的是两批行',
      (function () {
        var t = flat(card('cl-table'));
        return t.indexOf('P-46') >= 0 && t.indexOf('P-47') >= 0 &&
          t.indexOf('P-41') < 0 && t.indexOf('P-42') < 0 && t.indexOf('P-43') < 0 &&
          t.indexOf('P-44') < 0 && t.indexOf('P-45') < 0;
      })(),
      flat(card('cl-table')));
    // ⭐ 已核对范围是**只读**的：款/色的输入控件不在，唯一的动作是「退回待核对」。
    //    ⚠️ 两件事必须一起验：只验"控件没了"会被"整块没渲染"蒙对（连退回按钮也没有 = 那行没法用）。
    report('已核对范围的行是只读的：款/色变成文本（没有下拉/输入框），操作列只有「退回待核对」',
      !card('cl-style-46') && !card('cl-color-46') && !card('cl-save-46') && !card('cl-ok-46') &&
        !!card('cl-reopen-46') && !!card('cl-ro-style-46') && !!card('cl-ro-color-46'),
      'style=' + (card('cl-style-46') ? '仍在（错）' : '无') +
        ' color=' + (card('cl-color-46') ? '仍在（错）' : '无') +
        ' reopen=' + (card('cl-reopen-46') ? '在' : '无（错）') +
        ' roStyle=' + (card('cl-ro-style-46') ? '在' : '无（错）'));
    // ⚠️ 只读格必须是**这一行现在的值**，而且**两个取值分支各有一行夹具**（见 CORRECTED_ORDERS）：
    //    · P-46 —— 款色「黑」与订单色「灰」**不同** ⇒ 必须显示款色「黑」（下游读的就是这一份）；
    //    · P-47 —— 款色为空、订单色「蓝」 ⇒ 必须回落显示「蓝」（不能让格子空着）。
    //    只留 P-46 的话，"先读订单色"这种错法照样绿（单看它两种实现给出不同答案，才分得出来）；
    //    只留 P-47 的话，"永远读款色、空了就留白"也能蒙对。两行**一起**才把这条钉死。
    report('只读格显示这一行现在的款与颜色（P-46 款色优先「黑」/ P-47 款色空则回落订单色「蓝」）',
      flat(card('cl-ro-style-46')).indexOf('S1') >= 0 && flat(card('cl-ro-color-46')) === '黑' &&
        flat(card('cl-ro-color-47')) === '蓝',
      'P46style=' + JSON.stringify(flat(card('cl-ro-style-46'))) +
        ' P46color=' + JSON.stringify(flat(card('cl-ro-color-46'))) +
        ' P47color=' + JSON.stringify(flat(card('cl-ro-color-47'))));
    // 「全部确认无误」对已核对的行是**空动作**（那些行 corrected 本来就是 1）：
    // 留在已核对范围里会让人以为它能做别的什么。这是本块唯一的**反向**断言（别把它删成"应该还在"）。
    report('已核对范围里没有「全部确认无误」（对已核对的行再确认一次是空动作）',
      !card('cl-all-ok'), 'cl-all-ok=' + (card('cl-all-ok') ? '仍在（错）' : '已无'));
    // 说明句跟着范围换：待核对讲"点名款/选色/保存"、已核对讲"退回待核对"。
    // 一句话盖两边必然有一边是错的（"点保存"在已核对范围里根本没有那个按钮）。
    report('页头说明跟着范围换：已核对范围讲的是「退回待核对」，不再讲待核对那一套',
      !!card('cl-guide') && flat(card('cl-guide')).indexOf('退回待核对') >= 0 &&
        flat(card('cl-guide')).indexOf('确认无误') < 0,
      card('cl-guide') ? flat(card('cl-guide')) : 'no-guide');

    // ---- 已核对范围**也出图**（2026-10-12：用户报"已核对范围看着是坏的"）----
    // 真库实测 23/23 行全有图，模板注释也明写"退回的判据就是这张图定错了款，没有图退回只能靠猜"。
    // 而夹具原先给这两行 localPath 空串 ⇒ 屏幕上两列空占位、行被撑得很高，看着像页面坏了；
    // 更要紧的是**这一列从来没有被任何断言看见过**（"已核对范围也出图"因此是恒绿的）。
    var okImgs = [];
    try {
      await waitFor(function () {
        var ims = card('cl-table') ? card('cl-table').querySelectorAll('img') : [];
        okImgs = Array.prototype.slice.call(ims);
        return ims.length === 2 && Array.prototype.every.call(ims, function (im) {
          return im.complete && im.naturalWidth > 0;
        });
      }, 6000);
    } catch (e) { /* 下面那条断言会把实际值写出来 */ }
    var okImgDetail = okImgs.map(function (im) {
      var cs = getComputedStyle(im);
      var td = im.closest('td');
      var tr = td ? td.getBoundingClientRect() : null;
      // detail 里带上**列宽**：这一条断言红的时候，第一要看的的就是图列有没有被 auto 布局压扁
      // （2026-10-12 实测：窄窗口下图列从 112px 塌到 32px，max-width:100% 随即使图变 12px 细条）
      return cs.objectFit + '/' + cs.width + 'x' + cs.height +
        '/nat=' + im.naturalWidth + 'x' + im.naturalHeight + '/列宽=' + (tr ? Math.round(tr.width) : '?');
    }).join(' , ') + ' || 表宽=' + (card('cl-table') ? Math.round(card('cl-table').getBoundingClientRect().width) : '?');
    report('已核对范围**同样出图**（2 张都解码得出来、contain、96px）—— 退回的判据就是"这张图定错了款"',
      okImgs.length === 2 && okImgs.every(function (im) {
        return im.naturalWidth > 0 && getComputedStyle(im).objectFit === 'contain' &&
          parseFloat(getComputedStyle(im).width) >= 90;
      }),
      'img数=' + okImgs.length + ' | ' + okImgDetail);
    // ⭐ 竖版那一行（P-47）单独钉：方图放进**方形**格子，object-fit 的 fill 与 contain
    //    渲染结果一模一样 ⇒ 只留方图的话，"contain 被改成 fill"这种错法永远绿。
    //    真库 35 张里 4 张竖版，夹具照抄这个比例（P-47 是竖版）。
    var ptImg = (function () {
      var ims = card('cl-table') ? card('cl-table').querySelectorAll('img') : [];
      for (var i = 0; i < ims.length; i++) if (ims[i].naturalHeight > ims[i].naturalWidth) return ims[i];
      return null;
    })();
    report('竖版图走 contain 而不是 fill（方图放进方格子两者渲染相同 —— 只有竖版行分得出来）',
      !!ptImg && ptImg.naturalWidth === 6 && ptImg.naturalHeight === 8 &&
        getComputedStyle(ptImg).objectFit === 'contain',
      ptImg ? 'nat=' + ptImg.naturalWidth + 'x' + ptImg.naturalHeight +
        ' fit=' + getComputedStyle(ptImg).objectFit : 'no-portrait-img');

    // ---- 点开看**原图**（2026-10-12）----
    // 表格放到 96px 仍看不清印花/领型 ⇒ 与「货与成本」同一套模式：点开读原图（不缩放）。
    // 四步各自单独验，少一步就有一条错法能蒙混：
    //   ① 弹层**立刻**出（用已在手里的缩略图顶上，不等磁盘）—— 只有把读图拖慢才看得见这一跳；
    //   ② 原图换上（src 真的变了且解码得出来）；
    //   ③ 载荷是**这一行**的 localPath；
    //   ④ 读失败保留缩略图、连点只认最后一次。
    function thumbSrc(id) {
      var b = card('cl-zoom-' + id);
      var im = b ? b.querySelector('img') : null;
      return im ? im.getAttribute('src') : '';
    }
    window.__readImageDelay = { '/tmp/p46.jpg': 400 };
    var rb0 = calls('orderReadImage').length;
    await clickReady('cl-zoom-46');
    var okThumbFirst = true;
    try {
      await waitFor(function () {
        var im = card('cl-viewer') ? card('cl-viewer').querySelector('img') : null;
        return !!im && im.complete && im.getAttribute('src') === thumbSrc(46);
      }, 3000);
    } catch (e) { okThumbFirst = false; }
    report('点开先弹出**缩略图**（点下去立刻有东西看，不等磁盘 —— 读图拖慢 400ms 才看得见这一跳）',
      okThumbFirst,
      'viewer=' + (card('cl-viewer') ? '在' : '无') + ' src同表格图=' + (function () {
        var im = card('cl-viewer') ? card('cl-viewer').querySelector('img') : null;
        return im ? String(im.getAttribute('src') === thumbSrc(46)) : '?';
      })());
    var okSwap = true;
    try {
      await waitFor(function () {
        var im = card('cl-viewer') ? card('cl-viewer').querySelector('img') : null;
        return !!im && im.complete && im.naturalWidth > 0 && im.getAttribute('src') !== thumbSrc(46);
      }, 3000);
    } catch (e) { okSwap = false; }
    report('再把**原图**换上（src 真的变了、且解码得出来；批量那条通道 maxEdge 只到 256）',
      okSwap,
      'viewer src=' + (function () {
        var im = card('cl-viewer') ? card('cl-viewer').querySelector('img') : null;
        return im ? String(im.getAttribute('src')).slice(0, 40) : '?';
      })());
    report('读原图的载荷是**这一行**的 localPath（点 46 行读 /tmp/p46.jpg，不是别的行的）',
      calls('orderReadImage').length > rb0 &&
        calls('orderReadImage')[calls('orderReadImage').length - 1] === '/tmp/p46.jpg',
      JSON.stringify(calls('orderReadImage').slice(-1)));

    // ---- 读失败**保留缩略图**（不比现在更坏）----
    window.__readImageDelay = {};
    window.__readImageFail = true;
    var rb1 = calls('orderReadImage').length;
    await clickReady('cl-zoom-47');
    var okFailKeep = true;
    try {
      await waitFor(function () {
        var im = card('cl-viewer') ? card('cl-viewer').querySelector('img') : null;
        return !!im && calls('orderReadImage').length > rb1;
      }, 3000);
    } catch (e) { okFailKeep = false; }
    report('原图读失败时**保留缩略图**（弹层不空、不比现在更坏；用户至少看到原来那张）',
      okFailKeep && (function () {
        var im = card('cl-viewer') ? card('cl-viewer').querySelector('img') : null;
        return !!im && im.complete && im.getAttribute('src') === thumbSrc(47);
      })(),
      'read调用=' + (calls('orderReadImage').length - rb1) + ' src同表格图=' + (function () {
        var im = card('cl-viewer') ? card('cl-viewer').querySelector('img') : null;
        return im ? String(im.getAttribute('src') === thumbSrc(47)) : '?';
      })());
    window.__readImageFail = false;

    // ---- 连点只认**最后**一次（viewerSeq 守卫）----
    // 先取"只点 47"时的正确终态作基准（p47 的原图）。
    var full47 = '';
    await clickReady('cl-zoom-47');
    try {
      await waitFor(function () {
        var im = card('cl-viewer') ? card('cl-viewer').querySelector('img') : null;
        return !!im && im.complete && im.getAttribute('src') !== thumbSrc(47);
      }, 3000);
      full47 = card('cl-viewer').querySelector('img').getAttribute('src');
    } catch (e) { /* 下面写实际值 */ }
    // ⭐ 竞态必须**造出来**才算验过：把 p46 的响应拖慢 300ms，先点 46 再立刻点 47 ——
    //    没有 viewerSeq 时，46 的晚到响应会把已换成 47 的弹层盖回 46（用户看到的是点错的那张）。
    //    假桥同步返回时两条 continuation 按点击顺序排队、后点的总在最后生效 ⇒ 坏实现也绿，
    //    所以这个拖慢 + 事后等待是这条断言**唯一**的取证手段。
    window.__readImageDelay = { '/tmp/p46.jpg': 300 };
    await clickReady('cl-zoom-46');
    await clickReady('cl-zoom-47');
    await new Promise(function (r) { setTimeout(r, 800); });
    var okRace = (function () {
      var im = card('cl-viewer') ? card('cl-viewer').querySelector('img') : null;
      var head = card('cl-viewer') ? flat(card('cl-viewer').querySelector('.wb-dialog__head')) : '';
      return !!im && !!full47 && im.getAttribute('src') === full47 && head.indexOf('P-47') >= 0;
    })();
    report('连点两张只认**最后一次**（拖慢第一次的响应，才造得出"晚到的旧图盖掉新图"这个竞态）',
      okRace,
      '终态=' + (function () {
        var im = card('cl-viewer') ? card('cl-viewer').querySelector('img') : null;
        var head = card('cl-viewer') ? flat(card('cl-viewer').querySelector('.wb-dialog__head')) : '';
        return 'src=' + (im ? String(im.getAttribute('src')).slice(0, 24) : '?') + ' head=' + head;
      })());
    window.__readImageDelay = {};
    card('cl-viewer-close').click();
    await waitFor(function () { return !card('cl-viewer'); }, 3000);

    // ---- 行内「退回待核对」：只发这一行的 id ----
    // ⚠️ 判据钉在**请求载荷**上（不钉提示、也不钉"行不见了"）：
    //    载荷错了（比如带上 { all:true }）才是真危险的事，而提示写错一句话不影响数据。
    var rpB = calls('orderReopenCorrected').length;
    await clickReady('cl-reopen-46');
    var okReopen = true;
    try { await waitFor(function () { return calls('orderReopenCorrected').length > rpB; }, 6000); }
    catch (e) { okReopen = false; }
    var rp = calls('orderReopenCorrected')[rpB];
    // 载荷是**裸数组**（真 preload 的形状），且**没有** mark-corrected 那种 { all } ——
    // 退回一律点名。"全部退回"被刻意拿掉了（不可逆，且用户看不出退回了多少）。
    report('「退回待核对」只发这一行的 id（载荷 [46]；没有 { all } 形态 —— 退回一律点名）',
      okReopen && JSON.stringify(rp) === '[46]', JSON.stringify(rp));
    // ⭐⭐ 退回的**正确性判据**：它把那行放回了待核对队列 —— 不是"只是从当前表里挪走"。
    //     只断言"它不在了"会被"退回把行删了"这类错法蒙对，必须**到待核对里看见它**才算数。
    //     先验这一半（离开已核对 + 页头计数当场变），切范围那一半在下面。
    var okLeftCorr = true;
    try {
      await waitFor(function () {
        return flat(card('cl-table')).indexOf('P-46') < 0 && flat(card('cl-count-corrected')) === '1';
      }, 8000);
    } catch (e) { okLeftCorr = false; }
    report('退回后它离开「已核对」表，页头已核对计数 2 → 1（计数当场跟着变，不用等切范围刷）',
      okLeftCorr,
      '表=' + (flat(card('cl-table')).indexOf('P-46') >= 0 ? 'P-46 仍在（错）' : 'P-46 已离开') +
        ' 已核对=' + JSON.stringify(flat(card('cl-count-corrected'))));
    card('cl-scope-pending').click();
    var okBack = true;
    try {
      await waitFor(function () {
        return !!card('cl-table') && flat(card('cl-table')).indexOf('P-46') >= 0 &&
          flat(card('cl-count-pending')) === '6';
      }, 8000);
    } catch (e) { okBack = false; }
    report('切回「待核对」：退回来的那一行**真的在待核对列表里**（P-46 可见，待核对 5 → 6）',
      okBack,
      'P-46=' + (flat(card('cl-table')).indexOf('P-46') >= 0 ? '在' : '不在（错）') +
        ' 待核对=' + JSON.stringify(flat(card('cl-count-pending'))));
    // 退回来的行必须是**可编辑**的 —— 退回的全部意义是让它重新能改（不是为了"看"）。
    report('退回来的那一行可编辑：款下拉 + 颜色控件都在，且它不再是已核对那套动作',
      !!card('cl-style-46') && !!card('cl-color-46') && !card('cl-reopen-46'),
      'style=' + (card('cl-style-46') ? '在' : '无（错）') +
        ' color=' + (card('cl-color-46') ? '在' : '无（错）') +
        ' reopen=' + (card('cl-reopen-46') ? '仍在（错）' : '无'));

    // ---- 「已核对」范围自己的空态（退回把这一批退光之后）----
    // 这是与"待核对都核对完了"**不同**的第四种空态（那个是待核对侧清零）——两个方向各自要有话说，
    // 而且要各有**可点的出口**（在已核对侧空着时唯一的下一步就是回去）。
    // ⚠️ 必须真的把已核对退光才造得出来：靠开关造（像 __allCorrected 那样）会跳过"退回"这条实现路径。
    card('cl-scope-corrected').click();
    await waitFor(function () { return !!card('cl-reopen-47'); }, 8000);
    await clickReady('cl-reopen-47');
    var okCorrEmpty = true;
    try { await waitFor(function () { return !!card('cl-empty'); }, 8000); } catch (e) { okCorrEmpty = false; }
    report('把已核对退光后给**它自己的**空态（不是"都核对完了"，那说的是待核对侧）',
      okCorrEmpty && flat(card('cl-empty')).indexOf('还没有核对过的行') >= 0 &&
        flat(card('cl-empty')).indexOf('都核对完了') < 0,
      okCorrEmpty ? flat(card('cl-empty')) : 'timeout');
    report('已核对空态的出口是**回到待核对**（而不是"去算钱"那套往前走的话术）',
      !!card('cl-goto-pending') && !card('cl-goto-cost') && !card('cl-goto-import'),
      'goto-pending=' + (card('cl-goto-pending') ? '在' : '无（错）') +
        ' goto-cost=' + (card('cl-goto-cost') ? '在（错）' : '无'));
    card('cl-goto-pending').click();
    var okBack2 = true;
    try {
      await waitFor(function () {
        return !!card('cl-table') && flat(card('cl-table')).indexOf('P-47') >= 0 &&
          flat(card('cl-count-pending')) === '7';
      }, 8000);
    } catch (e) { okBack2 = false; }
    report('点「回到待核对」真的切回去并列出退回来的两行（待核对 5 → 7：两行都退回来了）',
      okBack2,
      'P-47=' + (flat(card('cl-table')).indexOf('P-47') >= 0 ? '在' : '不在（错）') +
        ' 待核对=' + JSON.stringify(flat(card('cl-count-pending'))));

    // ~~产品维度（指标条那一格）的"显示 0 / 整格隐藏"两条断言~~
    // **已随指标条整条撤掉（2026-10-10）**：那一格连同它上面那排「待核对 / 未归类 / 识别库」
    // 一起被用户判为"看不懂"，取数通道 orderSkuRollup 也整条退场（handler / preload / types /
    // ipc / classify / product-db 一并删）。它"不在了"的守卫在上面的 ① 段里（页头没那排 +
    // 渲染层一次都没读那个键）。**别只把这两条断言注释掉、却把通道留着** —— 那会变成
    // "每次进页面白跑一次往返、且没有任何断言看得见"。

    step('recon');
    // 「结算对账」页签（2026-10-05 内建）。数字全在主进程算好（purchase-db），界面只展示 ——
    // 所以断言钉在"四个金额同源同窗"与"每笔动作真发到对应通道"上。
    await activateTab('recon');
    await waitFor(function () {
      return !!card('recon-panel') && flat(card('rc-stats')).indexOf('拿货') >= 0 && !!card('rc-table');
    }, 10000);

    // 内嵌时页面上只该有一个「刷新」（容器页头那个）。本页原来还有一个面板内的「刷新」，
    // 与容器重复（2026-10-11 删除）——容器那个是超集：「bump()」波及所有面板，含本页。
    // ⚠️ 判据按**用户可见的按钮文字**数，不按 data-act —— 那个重复按钮的 data-act 叫
    //    rc-reload，而「[data-act="refresh"]」选择器从来只命中容器这一个（拿它判恒绿，实测过）。
    //    先等容器按钮回到可点：它 loading 时显示「读取中…」，文字数出来会是 0。
    await waitFor(function () {
      var b = card('refresh');
      return !!b && !b.disabled;
    }, 8000);
    var refreshBtns = (function () {
      var all = document.querySelectorAll('button');
      var n = 0;
      for (var i = 0; i < all.length; i++) {
        if ((all[i].textContent || '').trim() === '刷新') n++;
      }
      return n;
    })();
    report('内嵌时可见的「刷新」只有一个（容器页头那个），本页不再重复一个同名的',
      refreshBtns === 1, 'count=' + refreshBtns);

    report('对账指标条：四个金额同口径（拿货 ¥620 / 已付 ¥80 / 已退 ¥20 / 欠款 ¥560）',
      flat(card('rc-stats')).indexOf('拿货 ¥620.00') >= 0 &&
        flat(card('rc-stats')).indexOf('已付 ¥80.00') >= 0 &&
        flat(card('rc-stats')).indexOf('已退 ¥20.00') >= 0 &&
        flat(card('rc-stats')).indexOf('欠款 ¥560.00') >= 0,
      flat(card('rc-stats')));
    report('厂家对账两行逐格对（厂A ¥40 欠 / 厂B ¥520 欠）—— 合计 ¥560 ≠ 任一行',
      (function () {
        var t = flat(card('rc-table'));
        return t.indexOf('厂A') >= 0 && t.indexOf('厂B') >= 0 &&
          t.indexOf('¥120.00') >= 0 && t.indexOf('¥40.00') >= 0 &&
          t.indexOf('¥500.00') >= 0 && t.indexOf('¥520.00') >= 0;
      })(),
      flat(card('rc-table')));
    // 零活动的厂家**不占一行**（2026-10-11）：对账 op 按 suppliers 表出全量（厂C 全零也在内），
    // 本页只列**窗口内有账**的厂家 —— 真库 6 家里 5 家恒零，全列出来是常态噪音。
    // ⚠️ 判据要同时数"行数 = 2"与"无厂C"：只看无厂C的话，"只显示前两行"这类错法也能蒙对。
    report('零活动的厂家不占一行（厂家目录 3 家、表里只列有账的 2 家）',
      (function () {
        var t = card('rc-table');
        if (!t) return false;
        return t.querySelectorAll('tbody tr').length === 2 && flat(t).indexOf('厂C') < 0;
      })(),
      card('rc-table')
        ? 'rows=' + card('rc-table').querySelectorAll('tbody tr').length + ' ' + flat(card('rc-table'))
        : 'no-table');
    report('付款记录两笔都在，类型列**逐行**打标（一笔付款、一笔退款）',
      (function () {
        var t = card('rc-pay-table');
        if (!t) return false;
        var tags = t.querySelectorAll('.wb-tag');
        return tags.length === 2 && tags[0].textContent.indexOf('付款') >= 0 &&
          tags[1].textContent.indexOf('退款') >= 0;
      })(),
      card('rc-pay-table') ? flat(card('rc-pay-table')) : 'no-table');

    // ---- 记付款弹层 ----
    card('rc-pay-7').click();
    await waitFor(function () { return !!card('rc-pay-dialog'); }, 6000);
    report('从对账行点「记付款」→ 弹层把该厂家**预选**好（省掉再选一次）',
      !!card('rc-pay-supplier') && card('rc-pay-supplier').value === '7',
      card('rc-pay-supplier') ? 'value=' + card('rc-pay-supplier').value : 'no-select');
    var addB = calls('purchasePaymentAdd').length;
    report('弹层打开时一个请求都不发', calls('purchasePaymentAdd').length === addB, '');
    card('rc-pay-ok').click();
    await new Promise(function (r) { setTimeout(r, 80); });
    report('金额为空时拦住（不记 0 元账，对账表不白多一行）',
      calls('purchasePaymentAdd').length === addB, '');
    var amtEl = card('rc-pay-amount');
    amtEl.value = '12.5';
    amtEl.dispatchEvent(new Event('input', { bubbles: true }));
    await clickReady('rc-pay-ok');
    var okAdd = true;
    try { await waitFor(function () { return calls('purchasePaymentAdd').length > addB; }, 6000); }
    catch (e) { okAdd = false; }
    var cap = calls('purchasePaymentAdd')[addB] || {};
    report('登记付款：厂家 + 类型 + 日期齐，金额按**分**提交（12.50 元 → 1250 分）',
      okAdd && cap.supplierId === 7 && cap.type === 'payment' && !!cap.payDate && cap.amountCents === 1250,
      JSON.stringify(cap));
    var okClose = true;
    try { await waitFor(function () { return !card('rc-pay-dialog'); }, 4000); } catch (e) { okClose = false; }
    report('登记成功后弹层自行关闭（不留"记完了还挂着"的假象）', okClose, '');

    // ---- 删除付款：确认弹层要真拦 ----
    card('rc-pay-del-21').click();
    await waitFor(function () { return !!card('confirm-dialog'); }, 6000);
    report('删除先确认，且写明后果（已付减少、欠款回升）',
      flat(card('confirm-dialog')).indexOf('回升') >= 0, flat(card('confirm-dialog')));
    var delB = calls('purchasePaymentDelete').length;
    report('没点确认时不发删除请求（确认是真拦，不是装饰）',
      calls('purchasePaymentDelete').length === delB, '');
    await confirmOk();
    var okDel = true;
    try { await waitFor(function () { return calls('purchasePaymentDelete').length > delB; }, 6000); }
    catch (e) { okDel = false; }
    report('确认后才真删（purchasePaymentDelete {id:21}）',
      okDel && (calls('purchasePaymentDelete')[delB] || {}).id === 21,
      JSON.stringify(calls('purchasePaymentDelete')[delB] || {}));

    // ---- 删退款：后果文案按**类型分叉**（2026-10-11）----
    // 差额 = 拿货 −（已付 − 退款）⇒ 删付款欠款**回升**、删退款欠款**减少**（方向相反）。
    // 旧文案「（或「已退」）会同步减少，欠款随之回升」把两笔账糊成一句，对退款是**反的**。
    // ⚠️ 断言要三维：讲到「已退」、方向是「减少」、且**不许出现**「回升」——前两条都满足时
    //    最后一条才拦得住"两句糅一起"的旧写法（旧文案恰好同时含「已退」与「减少」）。
    await clickReady('rc-pay-del-22');
    await waitFor(function () { return !!card('confirm-dialog'); }, 6000);
    report('删退款时的后果文案：写「欠款减少」（付款才是「回升」—— 两文案按类型分叉）',
      (function () {
        var t = flat(card('confirm-dialog'));
        return t.indexOf('已退') >= 0 && t.indexOf('减少') >= 0 && t.indexOf('回升') < 0;
      })(),
      flat(card('confirm-dialog')));
    await clickReady('confirm-cancel', 6000);
    try { await waitFor(function () { return !card('confirm-dialog'); }, 4000); } catch (e) {}

    // ---- 时间窗：切了必须**带窗口重取**（否则数字与窗口打架）----
    var rcB = calls('purchaseReconciliation').length;
    card('rc-range-month').click();
    var okRange = true;
    try { await waitFor(function () { return calls('purchaseReconciliation').length > rcB; }, 6000); }
    catch (e) { okRange = false; }
    var cw = calls('purchaseReconciliation')[rcB] || {};
    report('切时间窗会带窗口重取（不是只改高亮：四个金额必须与窗口同口径）',
      okRange && !!cw.from && !!cw.to, JSON.stringify(cw));
    var rcB2 = calls('purchaseReconciliation').length;
    card('rc-range-all').click();
    var okRange2 = true;
    try { await waitFor(function () { return calls('purchaseReconciliation').length > rcB2; }, 6000); }
    catch (e) { okRange2 = false; }
    report('切回「全部」= 不设边界（from/to 都不传，而不是传个空区间）',
      okRange2 && !(calls('purchaseReconciliation')[rcB2] || {}).from,
      JSON.stringify(calls('purchaseReconciliation')[rcB2] || {}));

    // ---- 视图 B：按店铺分摊 ----
    var allocB = calls('purchaseShopAllocation').length;
    card('rc-view-shop').click();
    var okAlloc = true;
    try {
      await waitFor(function () {
        return !!card('rc-shop-table') && calls('purchaseShopAllocation').length > allocB;
      }, 8000);
    } catch (e) { okAlloc = false; }
    report('切「按店铺」才去取分摊（多数时候看厂家账，不必每次多跑一趟）', okAlloc, '');
    report('店铺分摊两行逐格对（店A ¥120 / 店B ¥180）',
      (function () {
        var t = flat(card('rc-shop-table'));
        return t.indexOf('店A') >= 0 && t.indexOf('店B') >= 0 &&
          t.indexOf('¥120.00') >= 0 && t.indexOf('¥180.00') >= 0;
      })(),
      flat(card('rc-shop-table')));

    var detB = calls('purchaseShopAllocationDetail').length;
    await clickReady('rc-shop-toggle-店A');
    var okDet = true;
    // 等**表渲染出来**，不是等"请求发出去了"：取数与渲染差一个 tick，只等调用数会读到还没挂上的 DOM
    try { await waitFor(function () { return !!card('rc-shop-detail'); }, 8000); }
    catch (e) { okDet = false; }
    var cdet = calls('purchaseShopAllocationDetail')[detB] || {};
    report('展开明细按**这一家店**取（shopAllocationDetail {shop:"店A"}）',
      okDet && cdet.shop === '店A', JSON.stringify(cdet));
    report('明细表渲染出来（款编码 S1 · 2 件 · ¥120.00）',
      !!card('rc-shop-detail') && flat(card('rc-shop-detail')).indexOf('S1') >= 0 &&
        flat(card('rc-shop-detail')).indexOf('¥120.00') >= 0,
      card('rc-shop-detail') ? flat(card('rc-shop-detail')) : 'no-detail');

    window.__noShopAlloc = true;
    await clickRefresh();
    var okShopEmpty = true;
    try { await waitFor(function () { return !!card('rc-shop-none'); }, 8000); } catch (e) { okShopEmpty = false; }
    report('没有可归属的拿货成本时给空态，并说清"分摊的原料从哪来"',
      okShopEmpty && flat(card('rc-shop-none')).indexOf('拿货单') >= 0,
      okShopEmpty ? flat(card('rc-shop-none')) : 'timeout');
    // 空态要给**一个可点的下一步**（2026-10-11 补的按钮 —— 此前只有文字、没有出口；
    // 与厂家视图的「去拿货」同一个落点：这张表空 ⇔ 窗口里没有已提交的拿货单）。
    var gotoShopEl = card('rc-shop-goto-purchase');
    if (gotoShopEl) {
      gotoShopEl.click();
      try { await waitFor(function () { return onTab('purchase'); }, 4000); } catch (e) {}
    }
    report('店铺空态的下一步：按钮切到「拿货」页签（就地切换，不跳页）',
      !!gotoShopEl && onTab('purchase'),
      'button=' + !!gotoShopEl + ' onPurchase=' + onTab('purchase'));
    await activateTab('recon');
    window.__noShopAlloc = false;
    await clickRefresh();

    // ---- 厂家账清零：空态 + **步号钉死**（2026-10-11 修「第 5 步」→「第 4 步」）----
    // 六步→五步后拿货顺位成第 4 步，本页空态文案漏改 —— 步号这类"跨页复制的字"
    // 只能靠断言钉住（注释改了、界面没改，没有任何门禁看得见）。
    // 触发形态 = 厂家目录还在、窗口内全零（__noRecon 归零而不是清空）—— 真机上这就是空态的
    // 唯一入口（零活动行被过滤 ⇒ 无行可渲染）；老实现全列零行、这里会一直等不到，同样能抓。
    // ⚠️ 先切回「按厂家」：上面「按店铺」用例把视图留在了 shop，而 rc-recon-none 只属于
    //    厂家视图（保活还会把视图状态带回来）—— 不切回就永远等不到，会误报成"空态没实现"。
    card('rc-view-supplier').click();
    try { await waitFor(function () { return !!card('rc-table'); }, 6000); } catch (e) {}
    window.__noRecon = true;
    await clickRefresh();
    var okReconEmpty = true;
    try { await waitFor(function () { return !!card('rc-recon-none'); }, 8000); } catch (e) { okReconEmpty = false; }
    var reconEmpty = okReconEmpty ? flat(card('rc-recon-none')) : 'timeout';
    report('厂家账清零时给空态：账从哪来 + 出口指到第 4 步「拿货」（步号与实际一致）',
      okReconEmpty && reconEmpty.indexOf('第 4 步') >= 0 && reconEmpty.indexOf('拿货') >= 0 &&
        !!card('rc-goto-purchase'),
      reconEmpty);
    window.__noRecon = false;
    await clickRefresh();
    try { await waitFor(function () { return !!card('rc-table'); }, 8000); } catch (e) {}

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
  console.error('✗ 没抓到 #smoke-result（页面可能没挂载）。排查：产物新鲜度（npm run build）→ 资源 404 → 内联脚本语法错 → fake 桥缺键');
  console.error(`  DEBUG dom=${dom.length}B td-view=${dom.includes('td-view')} preAttr=${dom.includes('id="smoke-result"')} app=${dom.includes('data-v-app')}`);
  console.error('  DEBUG tail=' + JSON.stringify(dom.slice(-260)));
  process.exit(1);
}
const text = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
console.log(text);
const ok = text.split('\n').pop() === 'SMOKE: ALL PASS';
console.log(ok ? '\n✓ 今天页冒烟通过' : '\n✗ 今天页冒烟失败');
process.exit(ok ? 0 : 1);
