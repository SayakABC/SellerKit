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
  /**
   * 一单的包裹（阶段 B2）：包数取 window.__parcelN（默认 2），第一个包装了 1 件。
   * 商品行固定一行 2 件（已分包 1）—— 这样"再放 2 件"必被拒、"放 1 件"必成功，
   * 两条路都能被断言打到（桩只给一个方向的话，"拒绝后回读"永远验不到）。
   */
  function fakeParcelDetail(orderNo) {
    var n = window.__parcelN === undefined ? 2 : window.__parcelN;
    var parcels = [];
    for (var i = 0; i < n; i++) {
      parcels.push({
        id: 900 + i, orderNo: String(orderNo || ''), label: '箱 ' + (i + 1),
        trackingNo: '', carrier: '', shipCents: 1500, weightG: 400, note: '',
        createdAt: '', lines: i === 0 ? [{ id: 1, orderItemId: 5, qty: 1 }] : [],
      });
    }
    return {
      parcels: parcels,
      items: [{ id: 5, styleCode: 'S1', styleColor: 'S1-黑', color: '黑', size: 'M', qty: 2, packed: 1, remaining: 1, weightG: 300 }],
      totals: { count: n, shipCents: 1500 * n, weightG: 400 * n, shipMissing: 0, weightMissing: 0 },
    };
  }
  window.addEventListener('switch-module', function (e) { window.__events.push({ type: 'switch-module', detail: e.detail }); });
  window.addEventListener('open-settings', function (e) { window.__events.push({ type: 'open-settings', detail: e.detail }); });
  function daysAgo(n) {
    var d = new Date(); d.setDate(d.getDate() - n);
    var p = function (x) { return String(x).length < 2 ? '0' + x : String(x); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate());
  }
  /**
   * 现在 + ms 毫秒，格式化成 yyyy-mm-dd hh:mm:ss（本地时区）—— 截止期夹具用它。
   * ⚠️ 必须**相对当前时刻**生成，不能写死日期：写死的话「快超时」的断言会随运行日期漂
   *    （某天跑就恒红、某天跑就恒绿）。
   */
  function atOffset(ms) {
    var d = new Date(Date.now() + ms);
    var p = function (x) { return String(x).length < 2 ? '0' + x : String(x); };
    return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
      p(d.getHours()) + ':' + p(d.getMinutes()) + ':' + p(d.getSeconds());
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
  //   并给两个出口（2026-10-17 起：去「统计」看利润 = **真跳模块** / 去看要拿什么 = 第 3 步页签）。
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

  // ⚠️ 款色（styleColor）必须与「已拿台账」TAKEN 的色名**一致**（都是"黑"）：总览的"已拿"
  //    是按「款|色|码」从台账扣的，而有效色取的就是这一格（与拣货投影的 color 同序）。
  //    两处写成不同的名字（比如款色"红"、台账"黑"）时，已拿会恒为 0 —— 断言看着"能跑"，
  //    实际把"键对不上"这个真 bug 掩盖成"这件本来就没拿"。
  //    ⚠️ 本段代码住在**模板字符串**里：注释中**不能出现反引号**（会提前结束字符串，整段语法错）。
  var IMPORTED = [{
    id: 1, orderNo: 'I-1', source: 'import', shop: '店A', orderTime: daysAgo(1) + ' 10:00:00',
    styleCode: 'S1', styleColor: '黑', color: '黑', size: 'L', itemId: 'ITEM1',
    supplierId: 7, supplierName: '厂A', amountCents: 16518, vatCents: 3469, ddpCents: 2294,
    taxPlatform: '平台已税', bizStatus: '等待发货', rawFields: { '商品信息': '【1】 某款 (商品数量:1 piece)' },
    // 「现在还没发」四数（T2-2）的夹具：截止期很远 ⇒ 不算风险；imageId=0 ⇒ 算缺图。
    dealDeadline: atOffset(30 * 24 * 3600 * 1000), imageId: 0,
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
    // 1 小时后到截止（在 24h 窗口内 ⇒ 算风险）；有图 ⇒ 不算缺图
    dealDeadline: atOffset(1 * 3600 * 1000), imageId: 7,
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
    // 没有截止期（导入单本来就没有这一列）⇒ 计入 noDeadline，**不算**风险；也缺图。
    // 这一行是「现在还没发」与「今天要发」**必须分开**的证据：它三天前导进来，
    // 上面那块（按导入日筛）看不见它，下面那块（按当前状态）必须看见。
    dealDeadline: '', imageId: 0,
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
  // 已拿**台账**（purchase-taken；2026-10-17 新增通道）：与缺口是**两种语义**，夹具必须各给一份 ——
  //   · 缺口 = 还缺什么（缺为 0 的行**不返回**）；
  //   · 台账 = 拿过多少（拿齐了照样在）。
  // 默认那份的 taken 与 GAPS 一致（真库里两者同源：台账 → 缺口 ⇒ 数必然相等）。
  var TAKEN = [
    { styleCode: 'S1', color: '黑', size: 'L', taken: 1 },
  ];
  // **「全拿完」样本**（用户实报场景：提交了、卡却还是待拿）：三款色全部拿齐
  // ⇒ 缺口里**一行都没有**（missing<=0 被丢掉，这就是真形状），但台账里必须三行都在。
  // 拿这份夹具时若实现改回读缺口，已拿就变回 0 ⇒ 厂A 卡仍停在待拿 ⇒ 守卫红。
  var TAKEN_ALL = [
    { styleCode: 'S1', color: '黑', size: 'L', taken: 3 },
    { styleCode: 'S2', color: '白', size: 'M', taken: 1 },
    { styleCode: 'S3', color: '绿', size: 'M', taken: 1 },
  ];
  window.__takenAll = false;
  // 逐行覆盖度（purchase-order-coverage；2026-10-22 新增通道）：「哪张订单的货齐了」的唯一事实源。
  //   · 与 GAPS/TAKEN 是**三种**语义，夹具必须各给一份：
  //       GAPS  = 还缺什么（按款色码，缺为 0 不返回）
  //       TAKEN = 拿过多少（按款色码台账）
  //       本表   = 这一行**订单明细**被拿货单覆盖了几件（按 order_item_id）
  //   · 摆法与 PICK_ROWS 对齐（I-1/I-2 同是 S1·黑·L，I-3 是 S2·白·M，I-4 是 S9·蓝·M），
  //     这样「可以发货 / 还差」与厂家卡上的缺口说的是同一批单：
  //       TAKEN 里 S1·黑·L 只拿了 1 件 ⇒ 按先到先得记在 I-1 上 ⇒ I-1 齐了、I-2 还差 2 件。
  //   · orderItemId=1 与订单夹具 IMPORTED 的 id 同值不是巧合：总览那批（今天导入的 2 行）
  //     靠它取到"已拿 1 件"。改这里的 id，总览的四个数会一起变 —— 那样两处就不再有同一份证据。
  var COVER_ROWS = [
    { orderItemId: 1, orderNo: 'I-1', shop: '店A', orderTime: daysAgo(1) + ' 10:00:00', qty: 1,
      styleCode: 'S1', styleName: '款一', styleColorId: 0, styleColor: '黑', colorRaw: '黑', size: 'L',
      rawFields: { '商品信息': '【1】 某款 (商品数量:1 piece)' }, covered: 1, unclassified: false },
    { orderItemId: 2, orderNo: 'I-2', shop: '店A', orderTime: daysAgo(1) + ' 11:00:00', qty: 2,
      styleCode: 'S1', styleName: '款一', styleColorId: 0, styleColor: '黑', colorRaw: '黑', size: 'L',
      rawFields: { '商品信息': '【1】 某款 (商品数量:2 piece)' }, covered: 0, unclassified: false },
    { orderItemId: 3, orderNo: 'I-3', shop: '店A', orderTime: daysAgo(1) + ' 12:00:00', qty: 1,
      styleCode: 'S2', styleName: '款二', styleColorId: 0, styleColor: '白', colorRaw: '白', size: 'M',
      rawFields: { '商品信息': '【1】 某款 (商品数量:1 piece)' }, covered: 0, unclassified: false },
    { orderItemId: 4, orderNo: 'I-4', shop: '店A', orderTime: daysAgo(1) + ' 13:00:00', qty: 1,
      styleCode: 'S9', styleName: '款九', styleColorId: 0, styleColor: '蓝', colorRaw: '蓝', size: 'M',
      rawFields: { '商品信息': '【1】 某款 (商品数量:1 piece)' }, covered: 0, unclassified: true },
    // 未识别的一条（采集进来的单还没归类：款编码为空）：它的"齐没齐"**不可信**，
    // 必须能标出来 —— 只放有款编码的行，"未识别款"这条渲染写没写都看不出来。
    { orderItemId: 5, orderNo: 'I-5', shop: '', orderTime: daysAgo(1) + ' 14:00:00', qty: 1,
      styleCode: '', styleName: '', styleColorId: 0, styleColor: '', colorRaw: '灰', size: 'XL',
      rawFields: {}, covered: 0, unclassified: true },
  ];
  // 无归属台账（加 order_item_id 之前的历史拿货单）：**默认空** —— 有值时「可以发货」会变成
  // "推算出来的齐"，断言就分不清"真拿齐"和"摊出来的齐"。要用它的那一段自己打开。
  var COVER_POOL = [];
  // 开关：__coverAll = 全部拿齐（四行都 covered 满）；__noCover = 没有未发货订单（整块不该出现）
  window.__coverAll = false;
  window.__noCover = false;
  var IGNORES_BASE = [
    { styleCode: 'S9', color: '蓝', reason: '已线下拿', createdAt: '2026-10-01 10:00:00' },
  ];
  // 忽略清单**有状态**（真库 addIgnore / removeIgnore 就是落库）：忽略 S1·黑 之后，
  // 清单要看得见它进「暂不拿」区 —— 否则"忽略生效"这条交互在冒烟里等于没验。
  window.__ignores = IGNORES_BASE.slice();
  // 拣货清单夹具（2026-10-17 合并后第二轮重排）：**四个厂家格各有各的落点**，拖拽才有落点可拖：
  //   厂A(7)    S1·黑 L ×2 行（还差 2，无进价）+ 一张草稿单   ⇒ 待拿格（卡上带"已开单"）
  //   未指定(0) S2·白 M（还差 1，行上有进价预估 ⇒ 有进价）    ⇒ 待拿格（也是"拖过去=取消关联"的落点）
  //   厂C(9)    S9·蓝 M（整款色在忽略清单里）                  ⇒ 暂不拿格（灰条 + 原因）
  //   厂B(8)    没有清单行、只有一张已提交单                    ⇒ 已拿·已开单格（补卡路径）
  // ⚠️ 故意四家各不相同：只有一厂的话"拖到别家"连落点都没有，断言只能空转。
  // ⚠️ S3·绿 **故意无图**（imagePath 空串）：SKU 图这一轮的两个分支（有图出缩略图 / 无图出占位框）
  //    必须各有一行 —— 只放有图的行，"占位框"那条实现写没写都看不出来。
  // ⚠️ 无进价件数 = S1 三件 + S3 一件 = 4 件（缺口条按需求口径），与"待拿 4 件"不同数；
  //    S2 有进价 ⇒ "有价那一支"也有可观测对照面（≈¥10.00）。
  // ⭐ C2（2026-10-21）：价从**订单行投影**来（pickingRows 已带三档成本字段），不再读款级价目表。
  //    行上给的是真形状：actualCostCents（实付真值）/ costCents（进价预估）/ productCostCents（产品当前价）。
  //    S2 只填 costCents ⇒ 走的正是"预估那一档"；S1/S3 三档全空 ⇒ 无进价两支仍各有可观测面。
  // ⚠️ 每行都带 styleColorId（2026-10-28 门 2 起是**判据的一部分**）：没归类的行开进单里
  //    只会得到 style_color_id = 0，之后改个色名"已拿"就永久失联。没有它，"未指定厂家"那一格
  //    与"已归类但款没厂家"两件事在夹具里就分不开（都是 supplierId=0），门 2 的两条分支只能验一条。
  var PICK_ROWS = [
    { id: 1, orderNo: 'I-1', shop: '店A', orderTime: daysAgo(1) + ' 10:00:00', styleCode: 'S1', styleName: '款一',
      styleColorId: 101, styleColor: '红', color: '黑', size: 'L', itemId: 'ITEM1', supplierId: 7, supplierName: '厂A',
      imagePath: '/tmp/a.jpg', shipped: false, bizStatus: '等待发货',
      actualCostCents: null, costCents: null, productCostCents: null,
      rawFields: { '商品信息': '【1】 某款 (商品数量:1 piece)' } },
    { id: 2, orderNo: 'I-2', shop: '店A', orderTime: daysAgo(1) + ' 11:00:00', styleCode: 'S1', styleName: '款一',
      styleColorId: 101, styleColor: '红', color: '黑', size: 'L', itemId: 'ITEM1', supplierId: 7, supplierName: '厂A',
      imagePath: '/tmp/a.jpg', shipped: false, bizStatus: '等待发货',
      actualCostCents: null, costCents: null, productCostCents: null,
      rawFields: { '商品信息': '【1】 某款 (商品数量:2 piece)' } },
    { id: 3, orderNo: 'I-3', shop: '店A', orderTime: daysAgo(1) + ' 12:00:00', styleCode: 'S2', styleName: '款二',
      styleColorId: 102, styleColor: '白', color: '白', size: 'M', itemId: 'ITEM2', supplierId: 0, supplierName: '',
      imagePath: '/tmp/b.jpg', shipped: false, bizStatus: '等待发货',
      actualCostCents: null, costCents: 1000, productCostCents: null,
      rawFields: { '商品信息': '【1】 某款 (商品数量:1 piece)' } },
    { id: 4, orderNo: 'I-4', shop: '店A', orderTime: daysAgo(1) + ' 13:00:00', styleCode: 'S9', styleName: '款九',
      styleColorId: 103, styleColor: '蓝', color: '蓝', size: 'M', itemId: 'ITEM9', supplierId: 9, supplierName: '厂C',
      imagePath: '/tmp/c.jpg', shipped: false, bizStatus: '等待发货',
      actualCostCents: null, costCents: null, productCostCents: null,
      rawFields: { '商品信息': '【1】 某款 (商品数量:1 piece)' } },
    // S3·绿：**无图**（占位框分支的载体）+ 无成本（"无进价"按件说的另一行）。
    // 与 S1 同在厂A ⇒ 厂A 卡上有两款色行，多行形态（行间分隔线）也一并覆盖。
    { id: 5, orderNo: 'I-5', shop: '店A', orderTime: daysAgo(1) + ' 14:00:00', styleCode: 'S3', styleName: '款三',
      styleColorId: 104, styleColor: '绿', color: '绿', size: 'M', itemId: 'ITEM3', supplierId: 7, supplierName: '厂A',
      imagePath: '', shipped: false, bizStatus: '等待发货',
      actualCostCents: null, costCents: null, productCostCents: null,
      rawFields: { '商品信息': '【1】 某款 (商品数量:1 piece)' } },
  ];
  // 拖拽改厂家的"库"：款编码 → 新厂家（真库就是 pl_products.supplier_id）。假桥必须**记住**这次写 ——
  // 否则 pickingRows 下次生成还是老形状，"拖完清单重排"那条断言恒绿（看着像拖拽没生效）。
  window.__movedSuppliers = {};
  // 拿货单：一张草稿（明细，2 件 × 60.00 = 120.00）+ 一张已提交（明细，5 件 × 100.00 = 500.00）
  // ⚠️ 包价单 2026-10-20 已删（mode='package' 在真库 0 条、也无创建入口）⇒ 夹具里不留这种形状：
  //    假桥若还造包价单，等于**替已删的代码分支养老**（那段代码没了，夹具却还在验它）。
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
    { id: 2, supplierId: 8, supplierName: '厂B', bizDate: '2026-10-04', mode: 'detail', status: 'submitted',
      totalCents: 50000, editedAt: null, createdAt: '2026-10-04 09:00:00',
      items: [
        // 身份已定（styleColorId 有值）⇒ 这行扣得掉待拿，不挂「色未定」
        { id: 3, styleCode: 'S9', styleName: '款九', color: '灰', size: 'XL', qty: 5, styleColorId: 65,
          priceCents: 10000, amountCents: 50000, suggestionQty: 5 },
      ] },
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
  //     真库里这两个量恰好**恒空** —— 导入不提品类（实测 23 行 category 全空）、识别链已整条退役
  //     （R1 起 md_images 连结果列都没有 ⇒ features 恒空）⇒ buildStyleFingerprint('', []) 是**空串**。
  //     夹具原先给的是「帽子」「T恤」⇒ 指纹恒非空 ⇒ "点名款到底要不要指纹"这条**分不出来**，
  //     夹具把被验的量写成了实现的期望形状，断言只能恒绿（本仓反复踩的同一个坑）。
  //     · P-43（无款 + 空品类 + 空特征）⇒ **填了颜色也没处挂**："拦住并说明"那条守卫的载体；
  //     · P-45（有款 S1 + 空品类 + 空特征）⇒ 点名款时必须**照样挂款**（不要求指纹），
  //       否则颜色永远到不了款色（拿货单 / 算钱 / 取图全读款色）。
  // 命名板夹具（P3，2026-10-28）：**两个 listing**（3 + 2 个色键，合计 3 个待命名 / 2 个已命名）。
  //   · 三个 styleColorId 各不相同 ⇒ 「保存」按下的必须是**那一行**的 id（用一个 id 的实现在这里就红）；
  //   · 已命名的不进待办 ⇒ 计数必须是 3 / 共 5（把已命名的也算 = 用户白输一遍）；
  //   · 组内 3 个色**同屏**给出 ⇒ 逐键翻页的实现拿不到 3 个输入框；
  //   · **两组各有各的剩余数（2 / 1）而总数是 3** ⇒ "组头显示的是总进度"这种实现
  //     在这里才分得出来（只有一个组时，组内数与总数恰好相等，那种断言恒绿）。
  var NAMING_BOARD = {
    groups: [
      {
        shop: '店A',
        itemId: 'IT-N1',
        title: 'Naming Fixture Listing',
        // 款身份（组头那条控件）：styleId 必须 > 0 才给编辑；supplierId=0 表示未指定，
        //   下拉要显示"未指定厂家"而不是选中第一个厂家（默认值不能靠位置）。
        styleId: 77,
        styleCode: 'N1',
        styleName: '',
        supplierId: 0,
        styleCount: 1,
        colors: [
          { styleColorId: 901, styleCode: 'N1', styleName: '', colorName: '5', colorRaw: '5',
            named: false, orderRows: 2, qty: 3, localPath: '/tmp/p41.jpg' },
          { styleColorId: 902, styleCode: 'N1', styleName: '', colorName: '7', colorRaw: '7',
            named: false, orderRows: 1, qty: 1, localPath: '/tmp/p42.jpg' },
          { styleColorId: 903, styleCode: 'N1', styleName: '', colorName: '藏青', colorRaw: '9',
            named: true, orderRows: 1, qty: 1, localPath: '/tmp/p44.jpg' },
        ],
      },
      // 第二个 listing：1 个待命名 + 1 个已命名。它存在的唯一理由就是让"组内剩余"
      // 与"总剩余"不相等（上方那条第 4 点）。
      {
        shop: '店A',
        itemId: 'IT-N2',
        title: 'Naming Fixture Listing 2',
        styleId: 78,
        styleCode: 'N2',
        styleName: '',
        supplierId: 0,
        styleCount: 1,
        colors: [
          { styleColorId: 904, styleCode: 'N2', styleName: '', colorName: '1', colorRaw: '1',
            named: false, orderRows: 1, qty: 1, localPath: '/tmp/p45.jpg' },
          { styleColorId: 905, styleCode: 'N2', styleName: '', colorName: '黑', colorRaw: '2',
            named: true, orderRows: 1, qty: 1, localPath: '/tmp/p46.jpg' },
        ],
      },
    ],
    unnamedKeys: 3,
    totalKeys: 5,
  };

  // 款合并夹具（P4，2026-10-28）：一个厂家下 2 个款 + 一条已有的合并记录。
  //   · 两个款**色集不同**（MG-1 有 5、7；MG-2 有 5、9）⇒ 界面上要能看出"合并会搬 1 个色"；
  //   · 合并记录**必须存在**：不然"拆开"那条断言根本没东西可点（空跑）。
  var MERGE_BOARD = {
    groups: [
      {
        supplierId: 5,
        supplierName: '集雨',
        styles: [
          { styleId: 201, styleCode: 'MG-1', styleName: '立领夹克', keyCount: 6, colorCount: 2,
            rowCount: 6, colors: ['5', '7'], imagePath: '' },
          { styleId: 202, styleCode: 'MG-2', styleName: '飘带卫衣', keyCount: 4, colorCount: 2,
            rowCount: 4, colors: ['5', '9'], imagePath: '' },
        ],
      },
    ],
    merges: [
      { batchId: 'b-mg-old', targetStyleId: 203, targetStyleCode: 'MG-3',
        sources: [{ styleId: 204, styleCode: 'MG-4' }], movedColors: 2, movedKeys: 3,
        createdAt: '2026-10-28 20:00:00' },
    ],
  };

  // 门 1（店铺归一）夹具（P5，2026-10-28）：两家店没归一，共 7 行订单。
  //   · 一家**有同名候选**（库里已登记、只是还没认）—— 界面必须敢说"能认成谁"；
  //   · 一家**没有候选** —— 界面必须说"先登记"，而不是编一个名字出来（那会让人点错）。
  //   两个数故意不等（2 家 / 7 行）：只显示家数的实现在"行数"那条断言上会红。
  var SHOP_GATE_FIX = {
    pending: [
      { key: '店甲', raw: '店甲', orders: 5, autoShopName: '店甲', autoShopPlatform: 'ae' },
      { key: '店乙', raw: '店乙', orders: 2, autoShopName: '', autoShopPlatform: '' },
    ],
    orders: 7,
  };

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

  // 颜色字典（md_colors）的**可变**种子：自 2026-10-30 起，产品页 SKU 矩阵与命名板的
  // 「常用色」都由它驱动（写死的 COMMON_COLORS 只是兜底）。命名板改成"选中色格 → 点常用色"
  // 之后，色卡上每一颗都是这里的名字 —— 不桩的话调用落进 __unhandled（data:null），
  // 页面退回内置兜底表，断言会**碰巧**绿（「藏青」恰好在兜底表里），换个色名就红。
  var NAMING_DICT = [
    ['黑色', '#3a3a3a'], ['白色', '#f5f5f5'], ['灰色', '#9a9a9a'], ['藏青', '#2f3b5e'],
    ['藏蓝', '#2f3b5e'], ['军绿', '#5b6b46'], ['酒红', '#7d2f3a'], ['红色', '#d64545'],
  ];
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
    // 带图导入的接线点：芒果报表逐行下主图（真实实现落 md_images，这里只回一个固定 id 供断言）
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

    // 最近一次芒果同步（T2-3 采集状态条）。四种形态都要能造出来 ——
    // 这一条的全部价值就在"把 0 单与没抓到分开"，只测正常态等于什么都没测。
    'mangoSyncStatus': function () {
      rec('mangoSyncStatus');
      var mode = window.__syncMode || 'ok';
      if (mode === 'readfail') return { success: false, error: '模拟：日志表读不出来' };
      if (mode === 'never') return { success: true, data: null };
      var now = new Date().toISOString();
      if (mode === 'fail') {
        // 红线 1 的真实原文：芒果说有 12 单，一单都没抓到
        return { success: true, data: {
          at: now, fetched: 0, totalItems: 12, inserted: 0, updated: 0, skipped: 0,
          missingImage: 0, shopUnmatched: 0, partial: false,
          reason: '芒果说共 12 单，但一单都没抓到（登录过期 / 没停在待发货筛选 / 扩展未生效）',
        } };
      }
      return { success: true, data: {
        at: now, fetched: 3, totalItems: 3, inserted: 2, updated: 1, skipped: 0,
        missingImage: 0, shopUnmatched: 0, partial: false, reason: '',
      } };
    },

    // 待拣：四行四个厂家格（厂A / 未指定 / 厂C / 厂B 无行）—— 宫格 + 拖拽的落点地基，见 PICK_ROWS 注释。
    // ⚠️ styleName 必须有值：「按此生成拿货单」的入参要带上它（拿货单里看的是款名）。
    // ⚠️ __movedSuppliers 的写入要**反映在这里**（真库拖一次就改了 supplier_id）：
    //    不反映的话"拖完清单重排"验不到，而那是这条交互唯一可观测的结果。
    // ── 包裹（阶段 B2）：一单多包 ──────────────────────────────────────────
    // 三个桩都要**按入参回话**（单号照抄、包数按 __parcelN 增减），否则"界面把单号传错了"
    // 这类接线错误验不出来（桩恒回固定值，界面显示什么都是对的）。
    'orderParcelCounts': function (p) {
      rec('orderParcelCounts', p);
      var out = {};
      var n = window.__parcelN === undefined ? 2 : window.__parcelN;
      ((p && p.orderNos) || []).forEach(function (no) { out[no] = n; });
      return { success: true, data: out };
    },
    'orderParcelDetail': function (p) {
      rec('orderParcelDetail', p);
      return { success: true, data: fakeParcelDetail(p && p.orderNo) };
    },
    'orderParcelCreate': function (p) {
      rec('orderParcelCreate', p);
      window.__parcelN = (window.__parcelN === undefined ? 2 : window.__parcelN) + 1;
      return { success: true, data: Object.assign({ id: 900 + window.__parcelN }, fakeParcelDetail(p && p.orderNo)) };
    },
    // 拆包写入：默认**拒绝超拆**（件数 2 就回错，1 就成功）—— 断言"被拒后界面回读、不留假成功"
    'orderParcelSetLine': function (p) {
      rec('orderParcelSetLine', p);
      if (p && p.qty > 1) {
        return { success: false, error: '这行只有 2 件，已分包 1 件，最多还能放 1 件' };
      }
      return { success: true, data: fakeParcelDetail(p && p.orderNo) };
    },
    'pickingRows': function (p) {
      rec('pickingRows', p);
      if (window.__emptyOrders) return { success: true, data: { rows: [], meta: { rows: 0, limit: 2000 } } };
      var moved = window.__movedSuppliers || {};
      return { success: true, data: { rows: PICK_ROWS.map(function (r) {
        var sid = moved[r.styleCode] !== undefined ? moved[r.styleCode] : r.supplierId;
        var sup = SUPPLIERS.filter(function (s) { return s.id === sid; })[0];
        return Object.assign({}, r, { supplierId: sid, supplierName: sup ? sup.name : '' });
      }), meta: { rows: PICK_ROWS.length, limit: 2000 } } };
    },
    // 克重：只给 ITEM1 → 缺克重 0；运价表为空 → "没有"
    // ⚠️ 真实形状是**行对象**（{item_id,name,weight_g,updated_at}）—— 给数字会把「页面拿行当数字用」这类 bug 掩盖掉（本轮真踩到）
    // 成本不在这个桩里：C2 起「缺成本」按**订单行**的两档成本判定（见 TodayView 的 hasCost），
    // 产品当前价只经 productPricedCodes 参与"钉不钉得上"的判断；拣货清单的价则来自 pickingRows 的行投影。
    'productList': function (p) { rec('productList', p); return { success: true, data: { rows: [{ id: 1, code: 'S1', name: '款一', supplierId: 0, supplierName: '', category: '', status: 'active' }], total: 1 } }; },
    'productVariantList': function (p) {
      rec('productVariantList', p);
      // 只给导入行那条（S1 · 黑 · L）—— 采集行没有款色码，回不了，仍要如实计缺
      return { success: true, data: { rows: [{ id: 11, productId: 1, code: '', name: '黑 L', color: '黑', size: 'L', weightG: 275, status: 'active' }] } };
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
      // ⚠️ 真形状：**拿齐的行不出现在缺口里**（purchase-db 末尾 missing<=0 就丢）。
      //    __takenAll 时缺口为空 —— 这条不对称正是"已拿"必须读台账的原因。
      return { success: true, data: window.__noGap || window.__takenAll ? [] : GAPS };
    },
    // 已拿台账（真形状：已提交拿货单的 qty 合计，按款色码；拿齐了照样在）
    'purchaseTaken': function () {
      rec('purchaseTaken', {});
      return { success: true, data: window.__takenAll ? TAKEN_ALL : TAKEN };
    },
    // 逐行覆盖度（2026-10-22）：真形状是 { rows, unattributed } 两段。
    // ⚠️ __coverAll 时 rows 的 covered 全部填满（"都齐了"那一支）；__noCover 时 rows 为空
    //    （没有未发货订单）—— 此时那一块**整块不该出现**，反向守卫靠它。
    'purchaseOrderCoverage': function () {
      rec('purchaseOrderCoverage', {});
      if (window.__noCover) return { success: true, data: { rows: [], unattributed: [] } };
      var rows = COVER_ROWS.map(function (r) {
        if (window.__coverAll) {
          var full = {};
          for (var k in r) full[k] = r[k];
          full.covered = r.qty;
          return full;
        }
        return r;
      });
      return { success: true, data: { rows: rows, unattributed: COVER_POOL } };
    },
    // ⚠️ purchaseIgnoreList 必须**返回副本**（.slice()）：真 IPC 走结构化克隆，每次都是新数组；
    //    假桥若把 window.__ignores 本尊交出去，宿主把"同一引用"赋回 ignores 时会被 Vue 的
    //    hasChanged 判成"没变" ⇒ 忽略后 push 的记录永远进不了 ignoreReasonMap（2026-10-17 实测：
    //    行能进暂不拿区、灰条上的原因却永远不出现 —— 三处证据互相矛盾，根因就在这）。
    'purchaseIgnoreList': function () { rec('purchaseIgnoreList', {}); return { success: true, data: window.__ignores.slice() }; },
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
        bizDate: (p && p.bizDate) || '', mode: 'detail', status: 'draft',
        totalCents: items.reduce(function (a, it) { return a + (Number(it.amountCents) || 0); }, 0),
        editedAt: null, createdAt: '2026-10-10 12:00:00', items: items,
      });
      return { success: true, data: { id: 99 } };
    },
    'purchaseOrderUpdate': function (p) { rec('purchaseOrderUpdate', p); return { success: true }; },
    'purchaseOrderSubmit': function (p) { rec('purchaseOrderSubmit', p); return { success: true }; },
    'purchaseOrderDelete': function (p) { rec('purchaseOrderDelete', p); return { success: true }; },
    'purchaseIgnoreAdd': function (p) {
      rec('purchaseIgnoreAdd', p);
      // 真形状：落库（随后清单重算就把它当已忽略）—— 记住它，"忽略后进暂不拿区"才验得到。
      window.__ignores.push({
        styleCode: String((p && p.styleCode) || ''), color: String((p && p.color) || ''),
        reason: String((p && p.reason) || ''), createdAt: '2026-10-17 12:00:00',
      });
      return { success: true };
    },    'purchaseIgnoreRemove': function (p) {
      rec('purchaseIgnoreRemove', p);
      window.__ignores = window.__ignores.filter(function (r) {
        return !(r.styleCode === String((p && p.styleCode) || '') && r.color === String((p && p.color) || ''));
      });
      return { success: true };
    },
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

    // ---- 命名板（P3，2026-10-28）----
    /* 夹具刻意做成 **1 个 listing × 3 个色键（2 个待命名 + 1 个已命名）**：
       最容易写错的两种实现都能被抓到 ——
         · 逐键翻页（"点开一个填一个"）：组内 3 个输入框应当**同时**在 DOM 里；
         · 把已命名的也当待办：计数应当只数 2。
       ⚠️ 这个桩必须存在：不桩的话调用会落进 __unhandled，页面拿到 data:null ⇒
          // 命名板整块静默失效，只有这条桩能看见。 */
    'orderVariantNaming': function (p) {
      rec('orderVariantNaming', p);
      // ⚠️ 必须回**深拷贝**：真 IPC 是结构化克隆，页面拿到的从来不是主进程的活引用。
      //    直接回 NAMING_BOARD 会让"页面顺手改了夹具"这件事在冒烟里看不出（改了也照样绿），
      //    而线上它改的是自己的副本、库里的值根本没变 —— 假桥把两种结果抹平了。
      return { success: true, data: JSON.parse(JSON.stringify(NAMING_BOARD)) };
    },
    /* 改名：**只接受 id + 名字**（界面不许送款名/编码/平台原文 —— 那些由主进程回读）。
       名字叫「撞名」时回 ok:false，用来验"拒绝原话被显示出来而不是被改写成'保存失败'"。 */
    /* 款信息（命名板组头）：款名 + 厂家一次存。**只接受改过的那一项** ——
       supplierId 缺省表示不动，0 表示清空；两者混成一个是"改个名字顺手把厂家清了"。
       这个桩必须存在：不桩则落进 __unhandled，页面拿到 data:null，保存后静默不刷新。 */
    'orderStyleBasics': function (p) {
      rec('orderStyleBasics', p);
      var name = typeof (p && p.name) === 'string' ? p.name : '';
      return {
        success: true,
        data: {
          ok: true,
          styleId: (p && p.styleId) || 0,
          styleCode: 'N1',
          name: name,
          supplierId: typeof (p && p.supplierId) === 'number' ? p.supplierId : 0,
        },
      };
    },
    /* 款合并（P4）：候选 + 已合并记录。深拷贝同命名板 —— 真 IPC 是结构化克隆。 */
    'orderStyleMergeBoard': function (p) {
      rec('orderStyleMergeBoard', p);
      return { success: true, data: JSON.parse(JSON.stringify(MERGE_BOARD)) };
    },
    /* 合并：只接受目标 + 源款 id；回执带批次号（拆开按它，不按行 id）。 */
    'orderStyleMerge': function (p) {
      rec('orderStyleMerge', p);
      return {
        success: true,
        data: { ok: true, batchId: 'b-mg-new',
          targetStyleId: (p && p.targetStyleId) || 0,
          movedColors: 1, movedKeys: 3 },
      };
    },
    'orderStyleUnmerge': function (p) {
      rec('orderStyleUnmerge', p);
      return { success: true, data: { ok: true, restored: 4, skipped: 0 } };
    },
    /* 门 1（店铺归一）：只读派生。深拷贝 —— 真 IPC 是结构化克隆，
       交活引用会让"页面顺手改了夹具"在冒烟里既看不出、也不变红。 */
    'shopGate': function () {
      rec('shopGate', {});
      return { success: true, data: JSON.parse(JSON.stringify(SHOP_GATE_FIX)) };
    },
    'orderVariantRename': function (p) {
      rec('orderVariantRename', p);
      var name = String((p && p.name) || '');
      // 拒绝的一支：「藏青」在夹具里已经是 903（同一个款 N1）的名字 —— 这正是主进程
      // renameStyleColor 只拦"同款重名"那条语义（换成别的词会验不到真正的判据）。
      if (name === '藏青') {
        return {
          success: true,
          data: { ok: false, error: '这个款下已经有同名颜色了（藏青），要合并请用「映射与关联」', styleColorId: (p && p.styleColorId) || 0, name: name, keys: 0 },
        };
      }
      return {
        success: true,
        data: { ok: true, styleColorId: (p && p.styleColorId) || 0, name: name, keys: 1 },
      };
    },
    /* 颜色字典（2026-10-30）：产品页 SKU 矩阵与命名板的「常用色」都从 md_colors 读。
       不桩的话调用落进 __unhandled（data:null），loadColorDict 退回内置 COMMON_COLORS ——
       那份兜底表**恰好**含 藏青/军绿/酒红，断言会"碰巧"绿（换个色名就红），等于没测。
       种子是可变的：mdColorCreate 会往里 push，同一个页面里新增完能立刻再选到它。 */
    'mdColorList': function (p) {
      rec('mdColorList', p);
      return {
        success: true,
        data: {
          colors: NAMING_DICT.map(function (s, i) {
            return { id: i + 1, name: s[0], hex: s[1], sortOrder: i + 1, status: 'active' };
          }),
        },
      };
    },
    /* 新增颜色：只写字典（**不给色格加行**）。校验照抄主进程那三条（空名 / 纯数字 / 超长）。
       ⚠️ 正则里的 \\d 要写双反斜杠：本段整体在一个模板串里，单个反斜杠会被吃掉。 */
    'mdColorCreate': function (p) {
      rec('mdColorCreate', p);
      var name = String((p && p.name) || '').trim();
      if (!name) return { success: false, error: '颜色名不能为空' };
      if (/^\\d+$/.test(name)) return { success: false, error: '数字色号不能当颜色名（先对照图认成具体的颜色）' };
      if (name.length > 40) return { success: false, error: '颜色名太长了（40 字以内）' };
      var at = -1;
      for (var i = 0; i < NAMING_DICT.length; i++) {
        if (NAMING_DICT[i][0] === name) { at = i; break; }
      }
      var created = at < 0;
      if (created) {
        NAMING_DICT.push([name, '']);
        at = NAMING_DICT.length - 1;
      }
      return {
        success: true,
        data: { color: { id: at + 1, name: NAMING_DICT[at][0], hex: NAMING_DICT[at][1] }, created: created },
      };
    },
    // ---- 归类核对域（2026-10-05「归类核对」页签内建）----
    /* 进页时的**映射自愈**：页面会在取数前调一次（把「映射在、订单没吃到」的行补上）。
       桩默认回 0 行 —— 夹具里没有这类行，这里只验**接线**（真的调了、且没补到就不显示回执）。
       "补完的数字才对"那条由 master-data:ui 验（同一份实现，那边夹具能造出可补的行）。
       ⚠️ 这个桩必须存在：不桩的话调用会落进 __unhandled，页面拿到的 data 是 null，
          接线断了也照样"跑得起来"（自愈静默不生效，只有回执永远不出现）。 */
    'orderReplayMappings': function (p) {
      rec('orderReplayMappings', p);
      var n = Number(window.__smokeHealRows) || 0;
      return { success: true, data: { mappedItems: 1, candidateRows: n, fixableRows: n, fixedRows: n } };
    },
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
    // 表格缩略图放到 96px 仍看不清印花/领型 ⇒ 与「货品档案」同一套模式：点开读原图）。
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
    // 「复制拿货清单」（文字，2026-10-17 第二轮加）：**文本**剪贴板。记下载荷 ——
    // 这里唯一能验的就是"发出去的是四段式文字清单"（厂家 + 日期 + 商品行 + 合计），
    // 数字必须与屏上同一模型（sheetModelOf → sheetTextOf）。
    'writeClipboard': function (text) { rec('writeClipboard', text); return { success: true }; },
    // 拖拽改厂家（2026-10-17 第二轮）：按款编码写 supplier_id。真形状见 product-db.moveProductSupplier：
    //   · 款编码不能空；厂家必须存在（0 = 清空关联除外）—— 验"宿主拒绝不存在的厂家"这条边界；
    //   · changed=false = 目标与现值相同（没有可改的）；
    //   · 写入要**记住**（pickingRows 下次生成按它排）。
    'productMoveSupplier': function (p) {
      rec('productMoveSupplier', p);
      var code = String((p && p.code) || '');
      var sid = Number(p && p.supplierId) || 0;
      if (!code) return { success: false, error: '缺少款编码' };
      if (sid && !SUPPLIERS.some(function (s) { return s.id === sid; })) {
        return { success: false, error: '厂家不存在或已被删除：#' + sid };
      }
      var moved = window.__movedSuppliers || {};
      var orig = 0;
      for (var i = 0; i < PICK_ROWS.length; i++) if (PICK_ROWS[i].styleCode === code) orig = PICK_ROWS[i].supplierId;
      var cur = moved[code] !== undefined ? moved[code] : orig;
      if (cur === sid) return { success: true, data: { changed: false } };
      moved[code] = sid;
      window.__movedSuppliers = moved;
      return { success: true, data: { changed: true } };
    },
    // 「导出带图 xlsx」（拣货单）：真生成在主进程 exceljs（分表 + 嵌图），渲染层只把这批**已经算好的行**
    // 传过去 ⇒ 这里唯一能验的就是出参（件数/进价/金额/图是否转成了 JPEG）。
    // 2026-10-17 从退役的 picking:ui 搬过来（拣货页不再是独立菜单，但导出入口仍在内嵌精简条上）。
    'pickingExportExcel': function (p) {
      rec('pickingExportExcel', p);
      return { success: true, data: { filePath: '/tmp/拣货单.xlsx', rows: (p && p.rows ? p.rows.length : 0) } };
    },
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
/**
 * 「等到某个条件成立，最多等 timeout 毫秒」—— 但**不抛错**，返回 true/false。
 *
 * 为什么不能直接用 waitFor 等"被测实现应该产生的文案"：waitFor 超时会 reject，
 * 那一刻 main() 直接中断 ⇒ **后面所有断言一条都不跑**，而输出里只有前面几条 PASS。
 * 症状是"变异了却看不到 FAIL"——看起来像守卫有效（没红），实际是根本没跑到断言那一步。
 * 断言前的等待只应等"与实现无关的稳定信号"（或干脆等一小段），再让断言自己去判真假。
 */
async function waitSoft(fn, timeout) {
  var t0 = Date.now();
  for (;;) {
    var v = false;
    try { v = fn(); } catch (e) { v = false; }
    if (v) return true;
    if (Date.now() - t0 > (timeout || 4000)) return false;
    await new Promise(function (r) { setTimeout(r, 30); });
  }
}
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
 * ⚠️ 各页签的「.pu-view」是**内嵌视图自己的根类**（复用整页视图，只是藏了页头），
 *    用它当"这个面板挂上了"的判据，比找某个按钮稳（按钮会跟数据走，空库时不存在）。
 * ⚠️ 2026-10-10：原独立的「生成拣货单」页签（判据 .pk-view）**并进了「拿货」** ——
 *    拣货清单现在是「拿货」页签「要拿什么」子视图里的整页视图（PurchasePanel 内嵌），
 *    所以页面级只剩六个页签；.pk-view 仍存在，但它是**拿货面板的下属**，不再是一个页签。
 * ⚠️ 2026-10-17：算钱页签整步撤出（.oc-view 不再属于本页）⇒ 五页签。
 */
var PANEL_SEL = {
  // ⚠️ 2026-10-22：总览改版成"四格数字"，判据从「[data-act="flow"]」（流程卡）换成「daily-summary」。
  //    流程卡与三张卡已撤掉 —— 守着旧锚点会恒红（看着像功能坏了），守着一个"随便有什么元素"的
  //    选择器又会恒绿，所以钉在**这块面板自己的根**上。
  overview: '[data-act="daily-summary"]',
  import: '[data-act="import"]',
  classify: '[data-act="classify-panel"]',
  purchase: '.pu-view',
  recon: '[data-act="recon-panel"]',
};

/**
 * 厂家宫格里的一款色**行**（2026-10-17 合并后第二轮：一家一格，格内一行一款色；
 * 键如 'S1 · 黑'，尺码折进行内的 chip 条）。
 * ⚠️ 2026-10-17 之前这里是「款色卡」网格（data-act="pk-card"）—— 合并重设计后卡 = 一家厂，
 *    款色降为卡内的一行；旧锚点整个没了，断言必须跟着搬（守着旧锚点会恒红，看着像功能坏了）。
 */
function pickRow(key) {
  return document.querySelector('[data-act="pu-srow"][data-key="' + key + '"]');
}
/**
 * 某一区（pending 待拿 / skip 暂不拿 / done 已拿）里某厂家的那一格。
 * 拖拽落点、卡尾动作（复制 / 开单）、已开单行都按它选 —— 一家一格，落点即所见。
 * ⚠️ supplierId 0（未指定厂家）是**合法**的格（拖过去 = 取消关联），选择器照常按 0 选。
 */
function puTile(zone, sid) {
  return document.querySelector('[data-act="pu-scard"][data-zone="' + zone + '"][data-supplier="' + sid + '"]');
}

// ── 厂家宫格守卫（2026-10-17 合并后第二轮；第三轮三区并成单宫格后判据跟着搬）────────────
// 替代原先针对"底部吸底汇总条"的 pkSumGuard（汇总条已随合并取消）：**同一种病会搬到宫格上** ——
// 本视图根是 .wb-page（height:100% 的定高弹性列），内容一多就压缩**默认可缩**的弹性项。
// 宫格（.pu-grid）是它的直接弹性子项 ⇒ 被压时格盒变扁、内容探出 —— 只有几何抓得住，DOM 存在性断言抓不到。
// 三条缺一不可：
//   ① 宫格与格都没被压扁：clientHeight ≈ scrollHeight（变异：删 .pu-grid 的 flex-shrink:0 会红）；
//   ② 格子最小列宽 324 兑现（2026-10-17 第六轮从 288 上调：卡尾要一行摆下三个按钮；
//     窄窗塌成细列时动作被挤成三行、图被压小 —— 这条按宽度红）；
//   ③ 卡底动作按钮滚到眼前后必须在视口内、点得到（elementFromPoint 命中它自己）。
//   ④ 卡尾按钮**同一行**（2026-10-17 第六轮用户要求）：三个按钮 offsetTop 相差 ≤2px ——
//     最小列宽被改回 288 或卡尾内边距回加时，按钮折成两行，这条按 top 红。
// ⚠️ 刻意**不**断言"两家并排"：800×600 无头窗（侧栏 208）下可用宽度 ~500，
//    324 最小列宽**故意**排一列（厂家卡本来就高，硬并排两列一屏看不全一家）——
//    并排与否随窗口宽度变，不是形态判据；宽度与不压塌才是。
function puTileGuard(zone, sid, requiredActs) {
  var tile = puTile(zone, sid);
  var grid = document.querySelector('[data-act="pu-grid"]');
  if (!tile) return { ok: false, detail: 'no-tile ' + zone + '/' + sid };
  var squashedTile = tile.scrollHeight > tile.clientHeight + 1;
  var squashedGrid = !!grid && grid.scrollHeight > grid.clientHeight + 1;
  var w = Math.round(tile.getBoundingClientRect().width);
  var miss = [];
  for (var i = 0; i < requiredActs.length; i++) {
    var act = requiredActs[i];
    var b = tile.querySelector('[data-act="' + act + '"]');
    if (!b) { miss.push(act + '→按钮不在'); continue; }
    if (b.scrollIntoView) b.scrollIntoView({ block: 'nearest', inline: 'nearest' });
    var r = b.getBoundingClientRect();
    var hit = document.elementFromPoint(r.left + r.width / 2, r.top + r.height / 2);
    if (!hit || (hit !== b && !b.contains(hit))) {
      miss.push(act + '→点到 ' + (hit ? String(hit.getAttribute('data-act') || hit.className || hit.tagName).slice(0, 36) : 'null'));
    }
  }
  // ④ 同一行：在场的按钮 top 应一致（折行 ⇒ top 拉开一个按钮高 24px+）。只比存在的按钮。
  var present = [];
  for (var j = 0; j < requiredActs.length; j++) {
    var bb = tile.querySelector('[data-act="' + requiredActs[j] + '"]');
    if (bb) present.push(bb);
  }
  var sameRow = true;
  if (present.length > 1) {
    var top0 = present[0].getBoundingClientRect().top;
    for (var k = 1; k < present.length; k++) {
      if (Math.abs(present[k].getBoundingClientRect().top - top0) > 2) sameRow = false;
    }
  }
  return {
    ok: !squashedTile && !squashedGrid && w >= 324 && miss.length === 0 && sameRow,
    detail: '格宽=' + w + ' 格 client/scroll=' + tile.clientHeight + '/' + tile.scrollHeight +
      ' 宫格 client/scroll=' + (grid ? grid.clientHeight + '/' + grid.scrollHeight : '?') +
      (present.length > 1 ? ' 卡尾按钮同行=' + sameRow : '') +
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
    // 等总览那块四格数字真的算出来（不是"面板挂上了"就算 —— 数字要等 reload 回来）
    await waitFor(function () { return flat(card('daily-summary')).indexOf('件商品') >= 0; }, 8000);

    step('tabs');
    // 页签栏（2026-10-05「发货台」改造）：四步 + 总览 = 五个。
    //   2026-10-10：原第 3 步「生成拣货单」并进「拿货」⇒ 六步 → 五步，页签少一个。
    //   2026-10-17：算钱整步撤出（归拢到独立「统计」页）⇒ 五步 → 四步，再少一个。
    // ⚠️ 「懒加载」也要验：只断言"页签在"不够 —— 面板若是全量挂载，五个整页视图
    //    （拣货上千行、各自取数）会在进页面时一起跑，表现是打开就很慢。
    var tabIds = ['overview', 'import', 'classify', 'purchase', 'recon'];
    report('页签栏：五个页签齐全（总览 + 四步）',
      tabIds.every(function (id) { return !!tabEl(id); }),
      tabIds.map(function (id) { return id + '=' + !!tabEl(id); }).join(' '));
    // 反向守卫：算钱页签**不许回来**（2026-10-17 用户裁定：都归拢到「统计」菜单）。
    // 它一回来，"同一份利润表两个入口、两个口径"就复辟 —— 那正是这一轮要消掉的东西。
    report('算钱页签与它的面板都不在本页（钱只在「统计」页看）',
      !tabEl('cost') && !document.querySelector('[data-act="tab-cost"]') &&
        !document.querySelector('.oc-view'), '');
    report('进入页面默认落在「总览」', onTab('overview'), '');
    // 自证非空转：KNOWN_TABS 解析失败会返回 []，于是"回执的下一步指向真实页签"那条守卫
    // 悄悄退化成"只认模块 id"（页签类按钮全被判悬空 → 假红；或反过来配上副本 → 恒绿）。
    report('页签 id 清单从 flowCtx 真的读到了（否则"下一步"的页签守卫是空转的）',
      KNOWN_TABS.length >= 5 && KNOWN_TABS.indexOf('classify') >= 0 && KNOWN_TABS.indexOf('purchase') >= 0,
      JSON.stringify(KNOWN_TABS));
    report('懒加载：还没点过的页签，面板一个都没挂载（DOM 里查不到）',
      !document.querySelector('.pu-view') &&
        !document.querySelector('[data-act="classify-panel"]') &&
        !document.querySelector('[data-act="recon-panel"]'), '');

    step('overview');
    // 总览改版（2026-10-22 用户裁定："总览里的功能暂时没什么意义，先去掉"）：
    //   流程卡（四步主线）+ 订单 / 待拣 / 钱算得准吗 三张卡**全部撤掉**，只留四格数字 ——
    //   今天要发几单 / 共几件 / 已拿几件 / 还差几件。
    // ⚠️ 反向守卫：这几块一旦被"顺手加回来"，一格数就又会变成三段要逐条读的说明，
    //    而它们的内容在「页签栏 / 拿货 / 统计」里本来就已经有各自唯一的出处。
    report('总览只剩四格数字（流程卡与订单 / 待拣 / 缺口三张卡都不在了）',
      !card('flow') && !card('flow-next') && !card('card-orders') &&
        !card('card-picking') && !card('card-gaps'), '');

    // 只取数字本身：卡片文本是"数字 + 标签"（如 2单），去掉非数字再比，避免空格/标签变化假红。
    // ⚠️ 本段代码住在**模板字符串**里 ⇒ 正则里**不写反斜杠**：[反斜杠]d / [反斜杠]D 会先被外层字符串吃掉
    //    （要么静默变成 d，要么得写两层 \\D 才生效）—— 一层写错就是"取出来永远空串"：
    //    四条断言恒红，而"恒等式"那条则变成空串相加**恒绿**。用 [^0-9] 无转义，读起来没有歧义。
    function numOf(act) {
      var el = card(act);
      return el ? flat(el).replace(/[^0-9]/g, '') : 'x';
    }
    var dSum = flat(card('daily-summary'));
    // 夹具账**算得出来**（这是本轮最容易写错的地方，所以把算式写在注释里）：
    //   今天导入的 = IMPORTED(I-1, S1·黑·L, 1 件) + COLLECTED(C-1, 无款编码, qty 2)
    //   ⇒ 2 单 / 3 件；台账 TAKEN = S1·黑·L 已拿 1 ⇒ 已拿 1 / 还差 2
    // ⚠️ 反向夹具：IMPORTED_OLD 是**三天前**导进来的（1 件、1 单），它必须不在里面 ——
    //    漏传 importDate 会静默退回全库，这里就成 3 单 4 件。
    // ⚠️ 采集行那 2 件**不计已拿**：它没有款色身份（款编码空串），台账里没有它的位置；
    //    实现若按空串键去扣，已拿会变 3（"漏货式"的静默错：货没拿，界面说拿了）。
    report('四个数：2 单 / 3 件 / 已拿 1 / 还差 2（三天前导入的那行不算；采集行不扣已拿）',
      numOf('stat-orders') === '2' && numOf('stat-pieces') === '3' &&
        numOf('stat-taken') === '1' && numOf('stat-remaining') === '2',
      '单=' + numOf('stat-orders') + ' 件=' + numOf('stat-pieces') +
        ' 已拿=' + numOf('stat-taken') + ' 还差=' + numOf('stat-remaining') + ' | ' + dSum);
    // 这一屏唯一能自证的恒等式：已拿 + 还差 = 件数。少一件/多一件用户一眼看得出来，
    // 而"已拿 3、还差 2、共 4 件"这种账对不上会让整屏数字都不被信任。
    report('账能自洽：已拿 + 还差 = 件数',
      Number(numOf('stat-taken')) + Number(numOf('stat-remaining')) === Number(numOf('stat-pieces')),
      numOf('stat-taken') + ' + ' + numOf('stat-remaining') + ' vs ' + numOf('stat-pieces'));
    // 口径小字必须写着范围（"今天导入"）：没有它，这四格会被读成"库里一共这么多"
    report('总览写明口径（今天导入的订单 · 不含已关闭/已完成）',
      flat(document.querySelector('[data-act="daily-scope"]')).indexOf('今天导入') >= 0 &&
        flat(document.querySelector('[data-act="daily-scope"]')).indexOf('关闭') >= 0,
      flat(document.querySelector('[data-act="daily-scope"]')));

    // ---- 「现在还没发」第二行（T2-2）------------------------------------------------
    // 夹具账（算式写在注释里，改夹具时一起改）：
    //   全部待发货 = IMPORTED(I-1, 1 件, 截止+30天, 无图) + COLLECTED(C-1, 2 件, 截止+1h, 有图)
    //              + IMPORTED_OLD(I-OLD, 1 件, 无截止期, 无图)  ⇒ 3 单 / 4 件
    //   快超时 = 1（C-1：1 小时后到期，落在 24h 窗口内）
    //   行缺图 = 2（I-1 与 I-OLD；C-1 有 imageId）
    //   算不出截止期 = 1（I-OLD 是导入单，没有这一列）
    report('还没发四个数：3 单 / 1 快超时 / 4 件 / 2 行缺图',
      numOf('stat-pending') === '3' && numOf('stat-risk') === '1' &&
        numOf('stat-pulse-pieces') === '4' && numOf('stat-missing-image') === '2',
      '待发=' + numOf('stat-pending') + ' 风险=' + numOf('stat-risk') +
        ' 件=' + numOf('stat-pulse-pieces') + ' 缺图=' + numOf('stat-missing-image'));

    // **这一条是本轮改动的核心**：两块的口径不同，且证据是 IMPORTED_OLD。
    // 上面那块（按导入日筛）看不见三天前导进来的 I-OLD ⇒ 2 单；
    // 下面那块（按当前状态，跨天）必须看见它 ⇒ 3 单。
    // 若有人"顺手"把两块合并、或把下面那块也按 importDate 筛，这条会立刻红。
    report('两块口径确实不同：还没发(3) > 今天要发(2)，差的正是三天前导入的那单',
      Number(numOf('stat-pending')) > Number(numOf('stat-orders')) &&
        Number(numOf('stat-pending')) - Number(numOf('stat-orders')) === 1,
      '还没发=' + numOf('stat-pending') + ' 今天要发=' + numOf('stat-orders'));

    // 「算不出截止期」必须说出来：不说的话「快超时 0」会被读成"都不会超时"
    report('没有截止期的要明说（导入单没有这一列）',
      flat(document.querySelector('[data-act="pulse-nodeadline"]')).indexOf('1') >= 0 &&
        flat(document.querySelector('[data-act="pulse-nodeadline"]')).indexOf('截止期') >= 0,
      flat(document.querySelector('[data-act="pulse-nodeadline"]')));

    // 进度条 = 已拿 / 件数（1/3 ⇒ 约 33%）。判据按**几何比例**，不按 class 名：
    // 宽度算错了条子照样"有"，只有比例能抓（±3% 容差给亚像素与四舍五入）。
    var barRatio = (function () {
      var track = card('daily-bar');
      var fill = track && track.firstElementChild;
      if (!track || !fill) return -1;
      var tw = track.getBoundingClientRect().width;
      var fw = fill.getBoundingClientRect().width;
      return tw > 0 ? Math.round((fw / tw) * 100) : -1;
    })();
    report('进度条按 已拿 / 件数 铺宽（1/3 ≈ 33%）',
      barRatio >= 30 && barRatio <= 36, 'fill=' + barRatio + '%');

    // 改造前那条守卫的意图不变：点页签**不许跳页**（面板换内容 + 一个 switch-module 都不派发）
    var swBefore = evts('switch-module').length;
    await activateTab('classify');
    report('点页签 = 就地切（停在「今天」页，面板换内容）',
      onTab('classify') && !!document.querySelector('[data-act="classify-panel"]'), '');
    report('切页签不派发 switch-module（"不跳页"的判据）',
      evts('switch-module').length === swBefore,
      'switch-module=' + evts('switch-module').length);
    window.__events.length = 0;   // ⚠️ 别把上面这次点击留给后面按 [0] 取的断言
    await activateTab('overview');   // 后面的断言都在总览页签上（保活：切回来内容还在）

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
    report('商品信息表：给的是**可点的下一步**（去「产品管理」按 SKU 维护克重），不是一句空指引',
      flat(document.querySelector('[data-act="import-next"]')).indexOf('产品管理') >= 0 &&
        // data-act 由 import-next-<tab|action|moduleId> 生成 ⇒ 目标是 shop-accounts+action=goods，
        // 于是名字仍是 import-next-goods（**模块 id 变了但锚点名没变**，这是刻意的：
        // 锚点该描述"去哪一屏"，不是"哪个模块壳"）。
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
    //    2026-10-17 第三格从「算钱」页签改成「统计」页（算钱已撤出发货台、改名并独立成页）。
    report('回执回答"数据去哪了"：存到订单，并列出能看到它的三处页面',
      ordLanded.indexOf('订单') >= 0 && ordLanded.indexOf('归类核对') >= 0 &&
        ordLanded.indexOf('拿货') >= 0 && ordLanded.indexOf('统计') >= 0,
      ordLanded);

    // 「接下来做什么」—— 按钮必须指向**真实存在的目的地**（写错 = 点了没反应，且不报错）。
    // 这一场是"店铺**未归属**"那组按钮（订单夹具没有店铺列）；"已归属"那组在下面的芒果步里另测一次。
    checkNextTargets('订单报表·店铺未归属');
    // ⚠️ 主操作 2026-10-11 从「去看要拿什么」（第 4 步）改成「去核对这些行」（第 2 步）——
    //    原先与流程卡上"第 2 步才是当前步"自相矛盾：卡片让用户去归类，回执却把人送到拿货。
    //    判据同时钉**主次**（primary 在 classify 上）与**落点**（tab ⇒ 就地切页签，不跳模块）。
    // ⚠️ 次操作**按场景分叉**：店铺已归属 → 「去看要拿什么」(purchase)；未归属 → 「去「统计」归店铺」。
    //    本场是**未归属**（夹具没有店铺列）⇒ 次操作必须是 order-cost、**不是** purchase。
    //    ⚠️ 2026-10-17 起这个按钮是**真跳转**（moduleId = order-cost）而不是切页签 ——
    //      算钱撤出发货台后本页已无它的页签，data-act 因此变成 import-next-order-cost。
    //    两支分别在本场与芒果场各验一次 —— 只验一支等于漏掉另一条分支（"对称交换仍绿"的老毛病）。
    report('订单报表（店铺未归属）：主操作「去核对这些行」(classify) + 次操作「去「统计」归店铺」(order-cost)',
      flat(document.querySelector('button[data-act="import-next-classify"]')).indexOf('核对') >= 0 &&
        !!document.querySelector('button[data-act="import-next-order-cost"]') &&
        flat(document.querySelector('button[data-act="import-next-order-cost"]')).indexOf('统计') >= 0 &&
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

    // 2026-10-22：原「刚导完 → 点亮待拣卡」这条随三张卡一起撤掉了（总览只剩四格数字）。
    // ⚠️ 这里**刻意不补一条"数字跟着导入变了"的断言**：假桥的「orderShippingRows」恒回同一批行，
    //    数字在导入前后必然一样 —— 那种断言怎么写都恒绿，等于给后面的人一个假守卫。
    //    真要验"导入后汇总重取"，看「bump()」与「watch(token)」那两条既有链路（本文件后半段）。
    await activateTab('overview');

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
    // 2026-10-17 合并 + 改名：两个子视图（要拿什么 / 拿了什么）合成"一家一卡"后，页签仍是
    //   「拿货」⇒ 次操作文案跟着变成**页签名**（不再是子视图名"要拿什么"）。
    report('芒果待发货订单的下一步：主操作「去核对这些行」(classify) + 次操作「去「拿货」页签」(purchase)',
      !!document.querySelector('button[data-act="import-next-classify"]') &&
        flat(document.querySelector('button[data-act="import-next-classify"]')).indexOf('核对') >= 0 &&
        !!document.querySelector('button[data-act="import-next-purchase"]') &&
        flat(document.querySelector('button[data-act="import-next-purchase"]')).indexOf('拿货') >= 0 &&
        !document.querySelector('button[data-act="import-next-order-cost"]'),
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

    // ── 今天导入的订单明细（2026-10-22 新增）─────────────────────────────────────
    // 用户实报：「导入后显示"已导入 16 行订单"，但不知道订单在哪」⇒ 第 1 步的产物必须当场列出来。
    // 四条各钉一件事，缺一条都会让"列表看着对了、其实坏了"：
    //   ① 表在，且含今天这批的**导入行**（I-1）与**采集行**（C-1）—— 主干一个读口，两种来源都要出来；
    //   ② **不含 I-OLD**：它是"三天前导入"的反向夹具。漏传 importDate 时它才会出现，
    //      而"列表多几行"在能滚动的表里几乎不可能被人眼发现（这正是要机器盯的那类错）；
    //   ③ 计数与行数一致（计数写死/写错时，用户拿它去核"上面那个 16"就永远对不上）；
    //   ④ 搜索能筛，且无匹配时说的是「没有匹配」而不是「今天还没有导入」——
    //      两句话指向完全不同的下一步（一个改关键字、一个去导文件）。
    await waitFor(function () {
      return !!document.querySelector('[data-act="import-rows-table"]');
    }, 6000).catch(function () {});
    var rowNos = queryAll('[data-act="import-rows-table"] tbody tr').map(function (tr) {
      return flat(tr.querySelector('td'));
    }).join('|');
    report('导入页列出今天导入的订单（导入行与采集行都在）',
      rowNos.indexOf('I-1') >= 0 && rowNos.indexOf('C-1') >= 0, rowNos);
    report('列表与页头「今天导入」同口径：三天前导入的行不出现',
      rowNos.indexOf('I-OLD') < 0, rowNos);
    var rowCountText = flat(document.querySelector('[data-act="import-rows-count"]'));
    // ⚠️ 不能用 /\\d+/ 这种带反斜杠的正则：这段代码住在注入脚本的**模板字符串**里，
    //    反斜杠 d 会被吞成 d（守卫当场变成"永远匹配不到"）。用 [^0-9] 取数字。
    var rowCountNum = Number(rowCountText.replace(/[^0-9]/g, '') || 0);
    report('列表计数 = 实际行数（计数不是一句写死的话）',
      rowCountNum === queryAll('[data-act="import-rows-table"] tbody tr').length,
      rowCountText + ' / rows=' + queryAll('[data-act="import-rows-table"] tbody tr').length);
    // 未归类的行要**标出来**（空着只是个坑；标出来才指得动"去归类核对点名款"）
    report('没归到款的行标「未归类」（C-1 没有款号）',
      flat(document.querySelector('[data-act="import-row-9001"]')).indexOf('未归类') >= 0,
      flat(document.querySelector('[data-act="import-row-9001"]')));

    var qEl = document.querySelector('[data-act="import-rows-search"]');
    if (qEl) {
      qEl.value = 'C-1';
      qEl.dispatchEvent(new Event('input', { bubbles: true }));
      await waitFor(function () {
        return queryAll('[data-act="import-rows-table"] tbody tr').length === 1;
      }, 2000).catch(function () {});
    }
    report('搜索按关键字筛行（输入单号后只剩那一行）',
      !!qEl && queryAll('[data-act="import-rows-table"] tbody tr').length === 1,
      'rows=' + queryAll('[data-act="import-rows-table"] tbody tr').length);
    if (qEl) {
      qEl.value = 'zzz-不存在';
      qEl.dispatchEvent(new Event('input', { bubbles: true }));
      await waitFor(function () { return !!document.querySelector('[data-act="import-rows-empty"]'); }, 2000).catch(function () {});
    }
    var noMatch = flat(document.querySelector('[data-act="import-rows-empty"]'));
    report('搜不到时说的是「没有匹配」而不是「今天还没有导入」（两句话指向不同的下一步）',
      noMatch.indexOf('没有匹配') >= 0 && noMatch.indexOf('今天还没有导入') < 0, noMatch);
    if (qEl) {
      qEl.value = '';
      qEl.dispatchEvent(new Event('input', { bubbles: true }));
      await waitFor(function () {
        return queryAll('[data-act="import-rows-table"] tbody tr').length >= 2;
      }, 2000).catch(function () {});
    }

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
      var el = card('daily-empty');
      return el && flat(el).indexOf('今天还没有导入订单') >= 0;
    }, 8000);
    var emptyText = flat(card('daily-summary'));
    report('无订单时：空态给出下一步按钮（导入 Excel），不是一句"暂无数据"',
      !!card('empty-import') && emptyText.indexOf('导入 Excel') >= 0, emptyText);
    // ⚠️ 空态说「今天还没有导入订单」而不是「还没有订单数据」（2026-10-11）：发货台只数**今天导入**的
    //    那批，库里可能明明有前几天的单 —— 说"还没有订单数据"是假话（用户会以为数据丢了，正是本轮要治的病）。
    report('无订单时不说"还没有订单数据"（那是假话：库里可能有前几天的单）',
      emptyText.indexOf('还没有订单数据') < 0 && emptyText.indexOf('今天还没有导入订单') >= 0,
      emptyText.slice(0, 160));
    // 空态**不该**出现口径小字、四格数字与进度条：前者与"今天还没有导入订单"重复，
    // 后两者是给"有数字"时配的作用域与图形（空态摆一排 0 只会让人以为数据坏了）。
    report('空态不挂口径小字、也不挂四格数字与进度条（避免与那句话重复 / 摆一排 0）',
      !card('daily-scope') && !card('stat-orders') && !card('stat-pieces') && !card('daily-bar'),
      '');
    // ⚠️ 这条同时验两件事：**切到了导入页签**（看不见的按钮点了等于没点）+ **真的弹了选文件**。
    //    改成"一页多页签"之后，"只切过去不弹框"（或反过来）都会漏。
    var beforeSel = calls('selectExcel').length;
    card('empty-import').click();
    await waitFor(function () { return calls('selectExcel').length > beforeSel; }, 6000);
    report('空态按钮真的走导入链路（点了就弹选文件）', calls('selectExcel').length > beforeSel,
      'selectExcel=' + calls('selectExcel').length);
    report('空态按钮顺带把「导入订单」页签切到前台（一步直达，不让用户再找按钮）',
      onTab('import') && !!document.querySelector('[data-act="import"]'), '');
    step('nav');
    // 数据回来（关掉空态开关再刷新）：四格数字必须重新出现 ——
    // 只验"空态出现了"不够：空态若把面板换成了回不来的 DOM（v-if 写反 / 状态没重置），
    // 用户点刷新就永远看不到数，而界面上"有一句空态文案"看上去还挺正常。
    // ⚠️ 先切回总览：KeepAlive 只是**缓存**组件实例，切走的页签**不在 DOM 里** ——
    //    停在导入页签时 stat-orders 根本查不到，等待必然超时（不是数据没回来）。
    await activateTab('overview');
    window.__emptyOrders = false;
    document.querySelector('[data-act="refresh"]').click();
    await waitFor(function () { return !!card('stat-orders'); }, 8000);
    report('刷新后四格数字回来（空态不会把面板永久替换掉）',
      numOf('stat-orders') === '2' && numOf('stat-pieces') === '3',
      flat(card('daily-summary')));

    step('keepalive');
    // **"丝滑"的判据**：切走再切回，面板是**同一个 DOM 实例**（KeepAlive 保活），不是重新挂载。
    // ⚠️ 只在 DOM 上打个标记来验 —— 断言"取了数"不够（重挂载也会取数），
    //    而"节点还是那一个"是保活的直接证据。标记跟着缓存的 DOM 走，重挂载就丢。
    //    2026-10-10：拣货清单现在住在「拿货」面板里 ⇒ 标记打在**拿货面板**上（它才是被 KeepAlive 的那个）。
    // ⚠️ 2026-10-22：总览改版后「nav」步不再顺路把人送到「拿货」页签（那张带按钮的卡撤了），
    //    所以这里得**自己先挂上它** —— 否则 .pu-view 是 null，报错会写成"设置属性失败"，
    //    看起来像保活坏了，实际是这一步压根没进过那个页签。
    await activateTab('purchase');
    var pkEl = document.querySelector('.pu-view');
    var mark = 'KEEP' + Math.random();
    pkEl.__keepMark = mark;
    await activateTab('classify');
    await activateTab('purchase');
    var pkBack = document.querySelector('.pu-view');
    report('切走再切回：拿货面板是**同一个 DOM 实例**（KeepAlive 保活，界面不重建）',
      !!pkBack && pkBack.__keepMark === mark, 'mark=' + String(pkBack && pkBack.__keepMark));

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
    // 「拿货」页签（2026-10-05 内建；2026-10-10 拣货清单并进来；2026-10-17 算钱整步撤出后
    // 由第 4 步顺位成第 3 步；同日「要拿什么 / 拿了什么」合并成一页，晚间第三轮把
    // 「按订单」页签整条撤掉、三区并成**单宫格一种卡**）：
    //   · 顶部动作条（新建空白单）—— 概览文案已撤（2026-10-17 用户反馈，数字只在卡面上）；
    //   · 厂家宫格（唯一视图）：待拿全卡在前，暂不拿/已拿瘦卡在后；款色行带 **SKU 缩略图**，
    //     可**拖到别家的格子**改厂家；单子管理全在卡上（order-action 意图 → 宿主写库）。
    // 合并不复制实现：卡由 PickingView 渲染，宿主只注入三样本（各厂拿货单 / 忽略原因 / 厂家电话）。
    // 断言纪律：① 数字钉在 data-act 上、按真夹具逐格核；② 每个按钮断言**它发出的 IPC 入参**；
    // ③ 拖拽用页内合成 DragEvent（见 fireDrag 头注释）；④ 确认弹层断言**确认前一个请求都不发**。
    await activateTab('purchase');
    await waitFor(function () {
      return !!card('pk-bar') && calls('purchaseOrderList').length >= 1;
    }, 10000);
    // 布局守卫（2026-10-17 第五轮）：嵌入态的 pk-view 不许再叠顶距 ——
    // 外层 .wb-page 已给 18px，这里再补就会比「归类核对」宽一截（用户实测反馈过 30px vs 18px）。
    // 钉 computed padding（源级事实，稳）：回加 12px 这条就红。
    // ⚠️ 本段在模板串里：注释与判据**都不能带反引号**（会被求值剥掉，症状是 "xxx is not defined"）。
    var pkView = card('pk-bar').closest('.pk-view');
    report('嵌入态不叠顶距：pk-view padding-top=0（与归类核对同一层间距起步）',
      !!pkView && getComputedStyle(pkView).paddingTop === '0px',
      pkView ? 'paddingTop=' + getComputedStyle(pkView).paddingTop : 'no-pk-view');

    // ---- 顶部（2026-10-17 第五轮）：概览文案与「新建空白单」都撤了，页级只剩宫格 + 精简条 ----
    report('页签已撤：精简条（导出/更多）/ 厂家宫格同屏，没有任何子页签',
      !!card('pk-bar') && !!card('pu-grid') && !card('pu-sub'),
      '');
    // 概览文案（待拿 N 款色 · N 件 · 涉及 N 家 · N 单 · 上次拿货 X）2026-10-17 应用户要求整条撤掉；
    // 同一轮「新建空白单」（选择厂家 / 新建明细单 / 新建包价单）也撤 —— 开单只剩卡上的「生成拿货单」。
    // 负向断言钉住"撤了就是撤了"：这些入口再回来这条就红。
    report('页级杂项已撤：不再有概览汇总 / 厂家下拉 / 新建明细单 / 新建包价单（开单入口唯一 = 厂家卡）',
      !card('pu-overview') && !card('pu-bar') && !card('pu-supplier') &&
        !card('pu-new-detail') && !card('pu-new-package'),
      flat(document.querySelector('[data-act="purchase-panel"]')));

    // ---- 按单核对（2026-10-22）：拿完货，哪几张单可以发了 ----
    //
    // 这一段治的是用户的原话：「拿完货后，怎么才能知道哪些订单的货拿完了？」
    // 之前整页最细只到**款色码**（拿齐的行从缺口消失，没有"已齐"可回看），订单级结论根本不存在。
    // 夹具（见 FAKE_BRIDGE 的 COVER_ROWS）：I-1 已被拿货单覆盖满 ⇒ 1 单可以发；
    //   I-2（还差 2）/ I-3（还差 1）/ I-4（还差 1 且未识别款）⇒ 3 单还差。
    // ⚠️ 这三条判据**互相不可替代**：
    //    只断言"有这一块" ⇒ 把 covered 全忽略也照样绿；
    //    只断言"1 单齐了" ⇒ 分不清是"按行判定"还是"按款色总量摊"（S1 拿 1 件摊给谁都能得 1）；
    //    所以还要看**齐的那单是哪一张**（I-1，按先到先得最先的那行）。
    await waitFor(function () { return !!card('pu-cover'); }, 8000);
    // 取数走**逐行覆盖度**这条通道（不是拿"缺口"顶上）：上面所有数字的唯一来源
    report('按单核对的数据来自 purchase-order-coverage（逐行覆盖度，不是缺口）',
      calls('purchaseOrderCoverage').length >= 1,
      'calls=' + calls('purchaseOrderCoverage').length);
    report('按单核对 · 折叠头直接给答案（可以发货 1 单 · 还差 4 单），不用展开也看得见',
      !!card('pu-cover-sum') && (flat(card('pu-cover-sum')).replace(/[^0-9]/g, '') === '14'),
      card('pu-cover-sum') ? flat(card('pu-cover-sum')) : 'no-sum');
    // 默认收起：拿货页的主活是开单，名单不该把厂家卡挤到屏幕外
    report('按单核对默认收起（名单不占首屏）', !card('pu-cover-done') && !!card('pu-cover-toggle'), '');
    card('pu-cover-toggle').click();
    await waitFor(function () { return !!card('pu-cover-done'); }, 4000);
    var covDone = queryAll('[data-act="pu-cover-done-item"]');
    var covPart = queryAll('[data-act="pu-cover-partial-item"]');
    report('展开后分两段：可以发货 1 单（I-1）/ 还差 4 单（I-2·I-3·I-4·I-5）',
      covDone.length === 1 && covPart.length === 4 &&
        flat(covDone[0]).indexOf('I-1') >= 0 &&
        flat(covPart[0]).indexOf('I-2') >= 0 && flat(covPart[1]).indexOf('I-3') >= 0 &&
        flat(covPart[2]).indexOf('I-4') >= 0 && flat(covPart[3]).indexOf('I-5') >= 0,
      'done=' + covDone.length + ' partial=' + covPart.length + ' 首个还差=' +
        (covPart[0] ? flat(covPart[0]).slice(0, 40) : 'none'));
    // 反向守卫：齐了的那单**不许**同时出现在「还差」里（两段都从同一批行来，重复就是分桶写错）
    report('齐了的单不会同时出现在「还差」里（两段互斥）',
      covPart.every(function (el) { return flat(el).indexOf('I-1') < 0; }), '');
    // 「还差什么」要落到款色码 × 件数（用户拿这张单去补货就靠这一行）
    var covChips = queryAll('[data-act="pu-cover-chip"]').map(flat);
    report('还差明细给到款色码 × 件数（I-2 缺 S1 · 黑 · L × 2）',
      covChips.some(function (t) { return t.indexOf('S1') >= 0 && t.indexOf('黑') >= 0 && t.indexOf('2') >= 0; }) &&
        covChips.some(function (t) { return t.indexOf('S2') >= 0 && t.indexOf('白') >= 0; }),
      'chips=' + covChips.join(' / '));
    // 没有款编码的行，「齐没齐」这件事本身不可信 ⇒ 必须标出来，不能装作知道
    report('未识别款的单标「未识别款」（不假装知道它齐没齐）',
      covPart.some(function (el) { return flat(el).indexOf('未识别款') >= 0; }),
      '');
    // 件数守恒：明细条说的「共 N 件 / 已拿 M 件」必须与两段里的件数对得上（I-1 拿满 1 件，
    // 其余 2+1+1+1 = 5 件还差 ⇒ 共 6 件、已拿 1 件）。数字写死是故意的：它同时钉住了
    // 「件数按 resolveQty 算」这条 —— 哪天件数退回"按行数算"，这里会先红。
    report('按单核对件数与两段一致（共 6 件 / 已拿 1 件 ⇒ 还差 5 件）',
      !!card('pu-cover-note') &&
        flat(card('pu-cover-note')).indexOf('共 6 件') >= 0 &&
        flat(card('pu-cover-note')).indexOf('已拿 1 件') >= 0,
      card('pu-cover-note') ? flat(card('pu-cover-note')) : 'no-note');
    // 收回去：后面那条「厂家宫格在眼前」的几何守卫要求首屏还是原来的样子 ——
    // 名单摊开会把宫格顶到屏幕外，那是**展开**的代价，不该让默认状态背这个锅。
    card('pu-cover-toggle').click();
    await waitFor(function () { return !card('pu-cover-done'); }, 4000);
    report('再点一次真的收回去（折叠头双向可用，不是只能开）', !card('pu-cover-done'), '');
    // auto：进这一步清单就该出好了（"生成"是它自己的按钮，但这里是拿货，得先看见货）
    await waitFor(function () { return !!pickRow('S1 · 黑'); }, 10000);
    report('清单自动生成过（auto）：进来就有厂家宫格，不用再点一次「生成待拣清单」',
      !!puTile('pending', 7) && pickingGenCalls().length >= 1,
      'tile=' + !!puTile('pending', 7) + ' genCalls=' + pickingGenCalls().length);

    // ---- 宫格三态（同一种卡：待拿全卡 → 暂不拿瘦卡 → 已拿瘦卡；没有分区标题，顺序即分区）----
    // 待拿：厂A（两款色 + 一张草稿单）+ 未指定厂家（S2·白；也是"拖过去=取消关联"的落点）。
    report('待拿两张全卡：厂A + 未指定厂家（带「待拿」签；页签撤掉后这是唯一视图的主体）',
      !!puTile('pending', 7) && !!puTile('pending', 0) &&
        flat(puTile('pending', 7)).indexOf('待拿') >= 0,
      puTile('pending', 7) ? flat(puTile('pending', 7)).slice(0, 60) : 'no-tile');
    // 暂不拿：厂C（S9·蓝 整款色在忽略清单里）—— 瘦卡 + 用户标的忽略原因。
    report('暂不拿瘦卡：厂C（1 款色无需补货（已线下拿）+ 忽略清单入口；与待拿同一外壳）',
      !!puTile('skip', 9) && flat(puTile('skip', 9)).indexOf('厂C') >= 0 &&
        flat(puTile('skip', 9)).indexOf('1 款色无需补货（已线下拿）') >= 0 &&
        flat(puTile('skip', 9)).indexOf('暂不拿') >= 0 &&
        !!card('pu-skip-ignores-9'),
      puTile('skip', 9) ? flat(puTile('skip', 9)) : 'no-skip');
    // 已拿：厂B（瘦卡排在最后，**不再折叠** —— 单子行就在卡上，管理不用切视图）。
    report('已拿瘦卡：厂B（1 张已提交 · ¥500.00 · 最近 2026-10-04）+ 单子行与完整动作（pu-edit-2）',
      !!puTile('done', 8) && flat(puTile('done', 8)).indexOf('1 张已提交 · ¥500.00') >= 0 &&
        flat(puTile('done', 8)).indexOf('最近 2026-10-04') >= 0 && !!card('pu-edit-2'),
      puTile('done', 8) ? flat(puTile('done', 8)) : 'no-done');
    // 「N 行色未定」= 提示 + 入口（2026-10-20）：这些行 style_color_id=0 ⇒ 扣不掉待拿，
    // 用户看到的就是"明明拿过货、清单还是全待拿"。所以这枚标签必须**在卡面上**，
    // 点它直接进编辑器认色（少两步）。反向：#2 的明细已定色，不该挂这枚标签。
    report('已开单行上的「N 行色未定」既是提示也是入口（#3 两行未定 ⇒ 标签在、写清行数）',
      !!card('pu-undecided-3') && flat(card('pu-undecided-3')).indexOf('2 行色未定') >= 0 &&
        !!card('pu-orow-3') &&
        card('pu-orow-3').querySelector('[data-act="pu-undecided-3"]') !== null,
      card('pu-undecided-3') ? flat(card('pu-undecided-3')) : 'no-chip');
    report('明细已定色的单不挂「色未定」标签（反向，防"恒挂一枚标签"的假实现）',
      !card('pu-undecided-2'), card('pu-undecided-2') ? flat(card('pu-undecided-2')) : 'none');

    // 排序本身钉死：zone 属性序 = pending → pending → skip → done（夹具：厂A/未指定/厂C/厂B）。
    report('宫格排序 = 待拿 → 暂不拿 → 已拿（data-zone 序 pending,pending,skip,done）',
      queryAll('[data-act="pu-scard"]').map(function (t) { return t.getAttribute('data-zone'); }).join(',') ===
        'pending,pending,skip,done',
      queryAll('[data-act="pu-scard"]').map(function (t) { return t.getAttribute('data-zone'); }).join(','));

    // ---- 卡上「已开单」那一截（宿主注入的拿货单）：金额必须**分 → 元** ----
    // ⚠️ 单子是分存的（totalCents）—— 2026-10-17 实测踩过：直接拿清单口径的 money()（吃元）
    //    格式化分会显示成 ¥12000.00 / ¥50000.00（数字大 100 倍，还不报错）。
    //    灰条上的"已提交合计"与这里是同一口径，各有一处断言。
    report('已开单行的金额按分除成元（厂A 卡上 #3 草稿 12000 分 → ¥120.00）',
      (function () {
        var orow = puTile('pending', 7).querySelector('[data-act="pu-orow-3"]');
        var t = orow ? flat(orow) : '';
        return !!orow && t.indexOf('¥120.00') >= 0 && t.indexOf('12000') < 0;
      })(),
      (function () {
        var orow = puTile('pending', 7).querySelector('[data-act="pu-orow-3"]');
        return orow ? flat(orow) : 'no-orow';
      })());

    // ---- SKU 图（2026-10-17 合并后第二轮加）：有图出缩略图，无图出占位框（不藏行）----
    // 有图：缩略图在生成时合批取回（orderImageThumbBatch）⇒ 断言 <img> 真的解码出内容
    //（只断"元素在"会漏掉"取回了但没渲染"那一支）。
    var okThumb = true;
    try {
      await waitFor(function () {
        var im = pickRow('S1 · 黑').querySelector('.pu-srow__img');
        return !!im && im.tagName === 'IMG' && im.complete && im.naturalWidth > 0;
      }, 6000);
    } catch (e) { okThumb = false; }
    var thumbIm = pickRow('S1 · 黑').querySelector('.pu-srow__img');
    report('款色行带 SKU 缩略图：S1·黑 的 <img> 解码出内容（合批取回的图真的摆上去了）',
      okThumb && !!thumbIm && String(thumbIm.src).indexOf('data:') === 0,
      thumbIm ? String(thumbIm.src).slice(0, 40) : 'no-img');
    // 无图：占位框（虚线 + 山形图标）—— "这款没图"本身是要去补的信息，藏掉行就等于隐瞒。
    //（行上不再逐行贴「缺图」标签：占位框就是那句话。）
    var noneEl = pickRow('S3 · 绿').querySelector('.pu-srow__img--none');
    report('无图的款色行给占位框而不是藏掉（S3·绿：行还在、图位是虚线占位，行上不再贴「缺图」标签）',
      !!noneEl && !pickRow('S3 · 绿').querySelector('img.pu-srow__img') &&
        flat(pickRow('S3 · 绿')).indexOf('缺图') < 0,
      noneEl ? 'placeholder ok' : 'no-placeholder');
    // 图不许被浏览器当成拖拽源（draggable=false 写在模板上）—— 否则拖起来的是那张图，
    // 行的 dragstart 根本不触发（拖了没反应，还查不到原因）。
    report('缩略图自身不可拖（draggable=false：拖拽的必须是行，不是图）',
      !!thumbIm && thumbIm.getAttribute('draggable') === 'false', '');

    // ---- 拖拽把手（2026-10-17 评审 P1：可发现性）----
    // 此前"行能拖到别家的格子上"只有行 tooltip 这一条线索（要悬停才出现）⇒
    // 扫一眼页面没有任何可拖信号，功能等于不存在。守卫钉两件事：
    //   ① 每个**可拖**的行都有一个把手（数量对得上，不是只有第一行画了）；
    //   ② 把手真的占位（有宽度）—— 只断言"元素在"会放过 0×0 的隐形元素。
    var gripRows = document.querySelectorAll('[data-act="pu-srow"][draggable="true"]');
    var gripOk = gripRows.length >= 2;
    for (var gi = 0; gi < gripRows.length && gripOk; gi++) {
      var gEl = gripRows[gi].querySelector('[data-act="pk-grip"]');
      if (!gEl || gEl.getAttribute('aria-hidden') !== 'true' ||
        gEl.getBoundingClientRect().width < 6) gripOk = false;
    }
    report('可拖的款色行都有可见的拖拽把手（行能拖不再是悬停才知道），把手是装饰不进读屏',
      gripOk, 'draggableRows=' + gripRows.length);

    // ---- 款色行内容（第三轮瘦身：图 + 款名·颜色 + 尺码×件数 + 忽略，一行读完"拿什么"）----
    // S1·黑：同款同色两行订单折成一行；尺码格 = L×**还差**（不是需求 L×3），tooltip 三个数一个不丢。
    var chipEl = pickRow('S1 · 黑').querySelector('[data-size="L"]');
    report('尺码格 = 尺码 × **还差**件数（L×2，不是需求 L×3），tooltip 三个数一个不丢（需求 3 · 已拿 1 · 还差 2）',
      !!chipEl && chipEl.textContent.trim() === 'L×2' &&
        chipEl.getAttribute('title') === 'L：需求 3 · 已拿 1 · 还差 2',
      chipEl ? chipEl.textContent.trim() + ' | ' + chipEl.getAttribute('title') : 'no-chip');
    // 瘦身守卫（用户反馈"信息局促"）：行上只有 款名·颜色 + 件数 —— 款编码 / 金额 / 缺口标签全不上卡。
    report('S1·黑 行：款名"款一"+颜色"黑"+"还差 2 件"；款编码/金额/缺口标签都不在行上',
      flat(pickRow('S1 · 黑')).indexOf('款一') >= 0 &&
        flat(pickRow('S1 · 黑')).indexOf('还差 2 件') >= 0 &&
        flat(pickRow('S1 · 黑')).indexOf('S1') < 0 &&
        flat(pickRow('S1 · 黑')).indexOf('无进价') < 0 &&
        !pickRow('S1 · 黑').querySelector('.pu-srow__amount'),
      flat(pickRow('S1 · 黑')));
    // S2·白（未指定厂家）：款名颜色照常展示（可读性不随瘦身丢）。
    report('S2·白 行（未指定厂家）：款名"款二"+颜色"白"+"还差 1 件"',
      flat(pickRow('S2 · 白')).indexOf('款二') >= 0 &&
        flat(pickRow('S2 · 白')).indexOf('白') >= 0 &&
        flat(pickRow('S2 · 白')).indexOf('还差 1 件') >= 0,
      flat(pickRow('S2 · 白')));
    // S3·绿：厂A 的第二行 ⇒ 行间分隔线与"多款色一行一家"的形态也一并覆盖。
    report('S3·绿 行（无图无价）：M×1 · 还差 1 件（占位图在；金额只在卡底合计行）',
      flat(pickRow('S3 · 绿')).indexOf('还差 1 件') >= 0,
      flat(pickRow('S3 · 绿')));
    // 卡面合计行：待拿口径（与「生成拿货单（N 件）」同源 pendingRollup）。
    report('厂A 卡合计：2 款色 · 待拿 3 件 · —（3 件全部无进价）',
      flat(puTile('pending', 7)).indexOf('合计 2 款色 · 待拿 3 件 · —（3 件全部无进价）') >= 0,
      flat(puTile('pending', 7)).slice(0, 120));
    // ⚠️ 卡合计走 amountText：**不写 ≈**（金额只在卡底合计行报价 —— 行上不再放钱数）——
    //   全缺价写 —、部分缺价写 ¥X（不含 N 件无进价），这条纪律由 pickingSheet 单测锁着。
    //   未指定厂家这格 1 件全有价 ⇒ 精确 ¥10.00（不是 ≈¥10.00）。
    report('未指定厂家卡合计：1 款色 · 待拿 1 件 · ¥10.00（全有价 ⇒ 精确值）',
      flat(puTile('pending', 0)).indexOf('合计 1 款色 · 待拿 1 件 · ¥10.00') >= 0,
      flat(puTile('pending', 0)).slice(0, 120));

    // ⚠️ 2026-10-17 评审 P0 守卫：「未指定厂家」卡的 supplierId 是 **0**，而 copyingId 的空闲哨兵
    //    早先也取 0 ⇒ 那张卡的「复制清单图」恒显「生成中…」且禁用（截图见证过的假动作）。
    //    判据必须落在**那一张卡**上：只断言厂A 的按钮，哨兵退回 0 这条照样绿。
    var unBtn = puTile('pending', 0) ? puTile('pending', 0).querySelector('[data-act="pk-copy"]') : null;
    report('「未指定厂家」卡的「复制清单图」按钮是可用态（空闲哨兵不能是 0 —— 会与它的 supplierId 撞上）',
      !!unBtn && !unBtn.disabled && flat(unBtn).indexOf('复制清单图') >= 0 &&
        flat(unBtn).indexOf('生成中') < 0,
      unBtn ? flat(unBtn) + ' | disabled=' + unBtn.disabled : 'no-btn');

    // ---- 卡尾三动作：复制文字清单 / 复制清单图 / 生成拿货单 ----
    // 复制拿货清单（文字）：**四段式**（标题 + 每款色一行 + 合计），数字与屏上同一模型
    //（sheetModelOf → sheetTextOf）⇒ 这里断言写进**文本**剪贴板的载荷本身。
    var wcBefore = calls('writeClipboard').length;
    puTile('pending', 7).querySelector('[data-act="pk-copy-text"]').click();
    var okWc = true;
    try { await waitFor(function () { return calls('writeClipboard').length > wcBefore; }, 6000); }
    catch (e) { okWc = false; }
    var wcAll = String(calls('writeClipboard')[wcBefore] || '');
    var wcLines = wcAll.split(String.fromCharCode(10));
    report('「复制拿货清单」写进文本剪贴板的是四段式文字（标题 / 两款色行 / 合计；日期=今天；**无款编码**）',
      okWc && wcLines.length === 4 &&
        /^拿货单 · 厂A · \\d{4}-\\d{2}-\\d{2}$/.test(wcLines[0]) &&
        wcLines[1] === '款一 · 黑：L×2 · 2 件' &&
        wcLines[2] === '款三 · 绿：M×1 · 1 件' &&
        wcLines[3] === '共 2 款色 · 3 件 · 预估 —（3 件全部无进价）',
      JSON.stringify(wcLines));
    report('文字清单全文不含款编码（S1/S3 是内部身份，对外文案只有款名·颜色）',
      okWc && wcAll.indexOf('S1') < 0 && wcAll.indexOf('S3') < 0, wcAll);
    var okWcToast = true;
    try { await waitFor(function () { return toastHas('已复制 2 款色 · 3 件的文字清单'); }, 4000); }
    catch (e) { okWcToast = false; }
    report('复制文字后给可核对的提示（2 款色 · 3 件）', okWcToast, toastDump());
    // 复制清单图（图片）：画成 PNG 写进**系统图片剪贴板**（用户粘到微信直接是清单图）。
    var clipBefore = calls('writeClipboardImage').length;
    puTile('pending', 7).querySelector('[data-act="pk-copy"]').click();
    var okClip = true;
    try { await waitFor(function () { return calls('writeClipboardImage').length > clipBefore; }, 8000); }
    catch (e) { okClip = false; }
    var clip = calls('writeClipboardImage')[clipBefore] || '';
    report('「复制清单图」发出的是图片（PNG dataURL），不是纯文本',
      okClip && typeof clip === 'string' && clip.indexOf('data:image/png;base64,') === 0,
      okClip ? 'len=' + clip.length : 'timeout');
    var okClipToast = true;
    try { await waitFor(function () { return toastHas('已复制 2 款色 · 3 件 的清单图'); }, 4000); }
    catch (e) { okClipToast = false; }
    report('复制图成功后的提示说清"几款色几件 + 发给谁"（能核对，不是一句"复制成功"）',
      okClipToast && toastHas('厂A'), toastDump());
    // 一键开单**钉在厂家卡上**（一张单只能挂一个厂家，卡就是天然分组，不必先选厂家）。
    // 按钮上的 N 件 = 这家厂**待拿**件数（与卡合计行、主进程开单明细同一条判据 pendingOf）。
    var crBtn = puTile('pending', 7).querySelector('[data-act="pk-create-order"]');
    report('卡尾给「生成拿货单（3 件）」且带厂家 id（厂A：S1·黑 2 + S3·绿 1）',
      !!crBtn && flat(crBtn).indexOf('生成拿货单（3 件）') >= 0 &&
        crBtn.getAttribute('data-supplier') === '7',
      crBtn ? flat(crBtn) + ' | data-supplier=' + crBtn.getAttribute('data-supplier') : 'no-btn');

    // ---- 宫格守卫（几何 + 可达性；判据见 puTileGuard 头注释）----
    // 压塌这一族的病在汇总条上踩过（2026-10-10）：CSS 写了不等于条子真的在眼前。
    var psg = puTileGuard('pending', 7, ['pk-copy-text', 'pk-copy', 'pk-create-order']);
    report('厂家宫格**在眼前**：宫格与格都没被压扁、格子最小列宽 324 兑现、三个卡底按钮同行且 elementFromPoint 命中自己',
      psg.ok, psg.detail);

    // ---- 吸底守卫（第三轮用户要求"已开单和复制按钮固定在卡片底部"）：几何取证 ----
    // 卡是宫格里的一格，行数不同高矮不同；吸底 = 底块的下缘贴着卡的下缘（margin-top:auto）。
    // 判据：底块 bottom 与卡 bottom 差 ≤ 12px —— 这是**卡盒模型的地板**，不是容差：
    //   margin-top:auto 把底块压到内容盒下缘，量 border-box 就必然含 padding-bottom 10 +
    //   border 1 = 11px（2026-10-17 实测 gap=11px，守卫原 ≤2px 是拿卡下缘当内容盒下缘用）。
    //   改成"动作紧跟行"的实现，厂A 卡这里立刻拉开到几十 px，12px 盖不住 ⇒ 守卫仍有牙。
    (function () {
      var tile = puTile('pending', 7);
      var bottom = tile.querySelector('.pu-scard__bottom');
      var okPin = false, detail = 'no-bottom';
      if (bottom) {
        var tr = tile.getBoundingClientRect();
        var br = bottom.getBoundingClientRect();
        var gap = tr.bottom - br.bottom;
        okPin = gap >= -1 && gap <= 12;
        detail = 'gap=' + Math.round(gap) + 'px';
      }
      report('已开单 + 复制/开单动作吸在卡底（底块下缘与卡下缘齐平；多卡横向对齐）', okPin, detail);
    })();

    // ---- 内嵌精简条上的两个低频动作（拣货菜单退役后，这里是它们**唯一**的入口）----
    // 「更多」= 天数窗 / 店铺 / 含已发货；「导出带图 xlsx」= 把这批算好的行交给主进程画表。
    report('精简条上有「导出带图 xlsx」与「更多」（内嵌时页头不渲染 ⇒ 这两个动作只能挂在这里）',
      !!card('pk-bar') && !!card('pk-bar').querySelector('[data-act="export"]') &&
        !!card('pk-bar').querySelector('[data-act="more"]'), '');
    card('pk-bar').querySelector('[data-act="more"]').click();
    await waitFor(function () { return !!card('shop-pick'); }, 6000);
    report('「更多」展开：天数窗 / 店铺 / 含已发货 三个条件都在',
      !!card('shop-pick') && !!card('include-shipped') && !!document.querySelector('.pk-input--num'), '');

    // 只改天数窗、**不点任何按钮**也要重算：条件条文案撤了（2026-10-17 第五轮），
    // 判据改钉**重算本身**（pickingRows 再次被调 —— 天数是清单层应用的，不入 IPC 入参）
    // —— 改了不重算这条就红。
    var pDays = document.querySelector('.pk-input--num');
    var genBeforeDays = pickingGenCalls().length;
    pDays.value = '60';
    pDays.dispatchEvent(new Event('input'));
    var okDays = true;
    try {
      await waitFor(function () { return pickingGenCalls().length > genBeforeDays; }, 8000);
    } catch (e) { okDays = false; }
    report('只改天数窗（不点按钮）也会重算 → 清单按新窗重出（pickingRows 再次被调）',
      okDays, 'gen=' + pickingGenCalls().length + ' input=' + pDays.value);
    pDays.value = '30';
    pDays.dispatchEvent(new Event('input'));
    var okBack30 = true;
    try {
      await waitFor(function () {
        return pickingGenCalls().length > genBeforeDays + 1;
      }, 8000);
    } catch (e) { okBack30 = false; }
    report('天数窗改回 30 天：清单重算回基准（后面步骤才有确定的起点）',
      okBack30, 'gen=' + pickingGenCalls().length + ' input=' + pDays.value);
    // 收起「更多」：把 DOM 还原成上面那些断言看到的形状，别给后续步骤留一块多出来的面板
    card('pk-bar').querySelector('[data-act="more"]').click();
    await waitFor(function () { return !card('shop-pick'); }, 4000);

    // 导出：出参是**已经算好的一批行**（主进程只画表、不重算）⇒ 屏上的数与表里的数不可能两套。
    var expBefore = calls('pickingExportExcel').length;
    await waitFor(function () {
      var b = document.querySelector('[data-act="export"]');
      return b && !b.disabled;
    }, 8000);
    document.querySelector('[data-act="export"]').click();
    var okExp = true;
    try { await waitFor(function () { return calls('pickingExportExcel').length > expBefore; }, 8000); }
    catch (e) { okExp = false; }
    var exp = calls('pickingExportExcel')[expBefore] || { rows: [] };
    var expRow = (exp.rows && exp.rows[0]) || {};
    report('「导出带图 xlsx」交给主进程的是算好的行（4 个 SKU；首行款色 + 尺码 + 供应商；默认文件名带日期）',
      okExp && !!exp.rows && exp.rows.length === 4 && expRow.styleCode === 'S1' && expRow.size === 'L' &&
        expRow.supplierName === '厂A' && /^拣货单-\\d{4}-\\d{2}-\\d{2}$/.test(String(exp.defaultName)),
      JSON.stringify({ n: exp.rows && exp.rows.length, r0: expRow.styleCode + '/' + expRow.size +
        '/' + expRow.supplierName, name: exp.defaultName }));
    report('图在渲染层已转成 JPEG 后随行传过去（真实订单图大半是 WebP，Excel 嵌 WebP 旧版 Office 看不见）',
      !!expRow.image && /^\\/9j\\//.test(String(expRow.image.base64 || '')) && expRow.image.width > 0,
      JSON.stringify({ has: !!expRow.image, w: expRow.image && expRow.image.width }));
    report('无进价的行金额传 null（表里留空，不写 0 —— 0 元 ≠ 不知道多少钱）',
      expRow.amount === null && expRow.unitPrice === null,
      JSON.stringify({ a: expRow.amount, u: expRow.unitPrice }));

    // ---- 忽略：原因要用户敲字 ⇒ **必须自绘弹层**（Electron 没有 window.prompt）----
    // 意图来自款色**行尾**（PickingView 只发意图；确认弹层与写库都在本面板）。
    // 忽略按**款色整组**生效（ignoreKey 里没有码）⇒ 动作挂在款色行上（键 = S2 · 白）。
    // 选 S2·白 而不是 S1·黑：它是未指定厂家格**唯一**的行 ⇒ 忽略后那一家整格翻进「暂不拿」区，
    // "忽略生效"才有一个看得见的结果（S1·黑 被忽略时厂A 还有 S3·绿 待拿，格子不动）。
    // ⚠️ 2026-10-17 评审 P0 后折叠头**只留标题**（生效范围那句挪进展开区 pu-ignore-note）。
    //    这里必须同时留一条**反向守卫**（折叠头里没有那句）—— 否则把说明塞回折叠头，
    //    "折起来只占一行"会静默退化成老样子，而"有几条"那条断言照样绿。
    report('已忽略折成一行：折叠头只说清有几条 + 生效范围说明不在头上（初始 1 项 = S9·蓝）',
      !!card('pu-ignore-toggle') && !card('pu-ignore-table') &&
        flat(card('pu-ignore-toggle')).indexOf('已忽略 1 项') >= 0 &&
        flat(card('pu-ignore-toggle')).indexOf('款编码 + 款色') < 0 &&
        !card('pu-ignore-note'),
      card('pu-ignore-toggle') ? flat(card('pu-ignore-toggle')) : 'no-toggle');
    card('pk-ignore-S2 · 白').click();
    await waitFor(function () { return !!card('pu-ignore-reason'); }, 4000);
    report('忽略走自绘弹层并给了原因输入框（不是在用 window.prompt）',
      !!card('pu-ignore-reason') && !!card('confirm-ok'), '');
    report('弹层说清是哪一款色 + 还差几件 + 影响范围（这款色含全部尺码）',
      flat(card('confirm-dialog')).indexOf('S2 · 白') >= 0 &&
        flat(card('confirm-dialog')).indexOf('还差 1 件') >= 0 &&
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
      okIg && iga.styleCode === 'S2' && iga.color === '白' && iga.reason === '已线下拿' &&
        iga.size === undefined,
      JSON.stringify(iga));
    // 忽略生效的**可见结果**：未指定厂家整格翻进「暂不拿」区（灰条 + 原因），S2·白 行从待拿区消失。
    // ⚠️ 假桥必须记住忽略（purchaseIgnoreAdd 落 __ignores）—— 不记住，"忽略后重排"恒绿。
    // ⚠️ 等的不只是"格子进了暂不拿区"：分区由 PickingView 自己取的那份忽略清单算，
    //    灰条上的**原因**却来自宿主的 ignoreReasons（另一条加载链路）—— 两个数据源刷新
    //    时序不保证先后，只等分区会撞上"格子到了、原因还没到"（2026-10-17 实测红过这条）。
    var okSkipMove = true;
    try {
      await waitFor(function () {
        return !!puTile('skip', 0) && !puTile('pending', 0) && !pickRow('S2 · 白') &&
          flat(puTile('skip', 0)).indexOf('1 款色无需补货（已线下拿）') >= 0;
      }, 8000);
    } catch (e) { okSkipMove = false; }
    report('忽略后未指定厂家整格进「暂不拿」区（灰条带原因；待拿区只剩厂A）',
      okSkipMove && flat(puTile('skip', 0)).indexOf('1 款色无需补货（已线下拿）') >= 0,
      puTile('skip', 0) ? flat(puTile('skip', 0)) : 'timeout');

    // ---- 取消忽略（页级忽略清单**展开后**撤销；撤销没有不可逆后果 ⇒ 不再要一次确认）----
    // 忽略清单是**页级**的（两个视图共用；「暂不拿」灰条上的「忽略清单」链到它）。
    report('已忽略折成一行：忽略 S2·白 后变 2 项，折叠头仍只说清有几条',
      !!card('pu-ignore-toggle') && !card('pu-ignore-table') &&
        flat(card('pu-ignore-toggle')).indexOf('已忽略 2 项') >= 0 &&
        flat(card('pu-ignore-toggle')).indexOf('款编码 + 款色') < 0,
      card('pu-ignore-toggle') ? flat(card('pu-ignore-toggle')) : 'no-toggle');
    card('pu-ignore-toggle').click();
    var okExpand = true;
    try { await waitFor(function () { return !!card('pu-ignore-table'); }, 4000); }
    catch (e) { okExpand = false; }
    report('展开后忽略清单照实显示（S9 · 蓝 + S2 · 白，两条都带原因），行尾给「取消忽略」',
      okExpand && flat(card('pu-ignore-table')).indexOf('S9') >= 0 &&
        flat(card('pu-ignore-table')).indexOf('S2') >= 0 &&
        flat(card('pu-ignore-table')).indexOf('已线下拿') >= 0 && !!card('pu-unignore-1'),
      card('pu-ignore-table') ? flat(card('pu-ignore-table')) : 'no-table');
    report('展开后才出「生效范围」那句（收起时不需要知道取消后会怎样）—— 它不在折叠头里',
      okExpand && !!card('pu-ignore-note') &&
        flat(card('pu-ignore-note')).indexOf('款编码 + 款色') >= 0,
      card('pu-ignore-note') ? flat(card('pu-ignore-note')) : 'no-note');
    var unIgBefore = calls('purchaseIgnoreRemove').length;
    card('pu-unignore-1').click();
    var okUnIg = true;
    try { await waitFor(function () { return calls('purchaseIgnoreRemove').length > unIgBefore; }, 6000); }
    catch (e) { okUnIg = false; }
    var uniga = calls('purchaseIgnoreRemove')[unIgBefore] || {};
    report('取消忽略按「款编码 + 款色」整组撤销（S2 · 白）',
      okUnIg && uniga.styleCode === 'S2' && uniga.color === '白', JSON.stringify(uniga));
    var okSkipBack = true;
    try { await waitFor(function () { return !!puTile('pending', 0) && !!pickRow('S2 · 白'); }, 8000); }
    catch (e) { okSkipBack = false; }
    report('取消忽略后未指定厂家回到待拿区、S2·白 行回来（撤销闭环）', okSkipBack, '');

    // ---- 拖拽改厂家（2026-10-17 合并后第二轮）：款色行 draggable → 拖到别家的格子松手 ----
    // 合成 DragEvent（真 drag 的数据通道就是 dataTransfer）：dragstart 派发在**行**上（组件在
    // 里面 setData('text/plain', 款编码)），dragover / drop 派发在**格**上。**同一个
    // DataTransfer 实例**一路传下去 —— setData 写进去的 drop 时读得回来（与浏览器真 drag 同一条通道）。
    // ⚠️ 派发顺序即真 drag 的事件序；少了 dragstart，组件里的 dragCode 是空的，dragover 直接早退
    //    （落点不高亮）—— 那测的是"没在拖"，不是"拖不动"。
    // ⚠️ 派发完必须**让出一帧**（setTimeout 0）再断言行/格上的类：is-dragging / is-drop-target
    //    是 Vue 的响应式类绑定，handler 里改的是 ref，DOM 要等 nextTick 才刷 —— 派发后立刻读
    //    className 读到的是上一帧的（2026-10-17 实测：拖拽四条因此全红，而 drop 之后的
    //    waitFor 断言全绿，红的恰恰是同步读 DOM 的那几条）。
    async function fireDrag(el, type, dt, related) {
      var init = { bubbles: true, cancelable: true, dataTransfer: dt };
      if (related !== undefined) init.relatedTarget = related;
      el.dispatchEvent(new DragEvent(type, init));
      await new Promise(function (r) { setTimeout(r, 0); });
    }
    // ① S3·绿：厂A → 未指定厂家（0）—— "拖过去 = 取消关联"那一支（0 是**合法**落点，不是"无"）。
    var msZero = calls('productMoveSupplier').length;
    await (async function () {
      var dt = new DataTransfer();
      var row = pickRow('S3 · 绿');
      await fireDrag(row, 'dragstart', dt);
      var ownTile = puTile('pending', 7);
      await fireDrag(ownTile, 'dragover', dt);
      report('拖拽中：源行半透明（is-dragging）、**原地的格子不高亮**（from===to 是空操作，高亮了是骗人）',
        row.className.indexOf('is-dragging') >= 0 && ownTile.className.indexOf('is-drop-target') < 0,
        'row=' + row.className + ' ownTile=' + ownTile.className);
      var zeroTile = puTile('pending', 0);
      await fireDrag(zeroTile, 'dragover', dt);
      report('拖到未指定厂家的格子上：落点高亮（is-drop-target），原格同时不高亮',
        zeroTile.className.indexOf('is-drop-target') >= 0 &&
          ownTile.className.indexOf('is-drop-target') < 0,
        'zero=' + zeroTile.className + ' own=' + ownTile.className);
      await fireDrag(zeroTile, 'drop', dt);
    })();
    var okMoveZero = true;
    try {
      await waitFor(function () {
        return calls('productMoveSupplier').length > msZero &&
          !!puTile('pending', 0).querySelector('[data-key="S3 · 绿"]');
      }, 8000);
    } catch (e) { okMoveZero = false; }
    var ms0 = calls('productMoveSupplier')[msZero] || {};
    report('拖到未指定厂家：出参 {code:S3, supplierId:0}（取消关联）+ 清单重排（行进未指定格）',
      okMoveZero && ms0.code === 'S3' && ms0.supplierId === 0, JSON.stringify(ms0));
    var okToastZero = true;
    try {
      await waitFor(function () {
        return toastHas('S3 款三（该款共 1 个款色）已移到「未指定厂家」');
      }, 4000);
    } catch (e) { okToastZero = false; }
    report('提示说清"整款一起走"（该款共 N 个款色 —— 写是款级的，只说拖的那行会误导）',
      okToastZero, toastDump());

    // ② S2·白：未指定厂家 → 厂A —— "拖到别家"主路径 + 落点闪烁守卫（dragleave 的 relatedTarget）。
    var msMain = calls('productMoveSupplier').length;
    await (async function () {
      var dt = new DataTransfer();
      var row = pickRow('S2 · 白');
      await fireDrag(row, 'dragstart', dt);
      var aTile = puTile('pending', 7);
      await fireDrag(aTile, 'dragover', dt);
      var lit = aTile.className.indexOf('is-drop-target') >= 0;
      // 拖到格子里的子元素上也会冒泡 dragleave：relatedTarget 还在格内时**不能**清落点
      // （不判这一条的表现是落点闪烁 —— 鼠标在卡内移动时高亮一灭一亮）。
      await fireDrag(aTile, 'dragleave', dt, aTile.querySelector('.pu-srow'));
      var kept = aTile.className.indexOf('is-drop-target') >= 0;
      // relatedTarget 在格外 ⇒ 该清：拖出格子不给"还能松手"的假象。
      await fireDrag(aTile, 'dragleave', dt, document.body);
      var cleared = aTile.className.indexOf('is-drop-target') < 0;
      report('dragleave 守卫：拖到格内子元素上不闪（relatedTarget 在格内不清落点）、拖出格外才清',
        lit && kept && cleared, 'lit=' + lit + ' kept=' + kept + ' cleared=' + cleared);
      // 原地格不当落点：从别格掠过去也不该亮。
      await fireDrag(puTile('pending', 0), 'dragover', dt);
      report('原地的格子不当落点（S2·白 就在未指定厂家里，dragover 自己不高亮）',
        puTile('pending', 0).className.indexOf('is-drop-target') < 0, puTile('pending', 0).className);
      await fireDrag(aTile, 'dragover', dt);
      await fireDrag(aTile, 'drop', dt);
    })();
    var okMoveMain = true;
    try {
      await waitFor(function () {
        return calls('productMoveSupplier').length > msMain &&
          !!puTile('pending', 7).querySelector('[data-key="S2 · 白"]');
      }, 8000);
    } catch (e) { okMoveMain = false; }
    var ms1 = calls('productMoveSupplier')[msMain] || {};
    report('拖到厂A：出参 {code:S2, supplierId:7} + 清单重排（行进厂A 格，未指定格只剩 S3·绿）',
      okMoveMain && ms1.code === 'S2' && ms1.supplierId === 7, JSON.stringify(ms1));
    var okToastMain = true;
    try {
      await waitFor(function () { return toastHas('S2 款二（该款共 1 个款色）已移到「厂A」'); }, 4000);
    } catch (e) { okToastMain = false; }
    report('拖成功的提示说清去向（款名 + 款色数 + 新厂家）', okToastMain, toastDump());

    // ③ S3·绿：未指定厂家 → 厂C —— **暂不拿的灰条也是落点**；落下去厂C 直接翻成待拿区
    //    （它还有 S9·蓝 被忽略着，但 S3·绿 还差 > 0 ⇒ 分区判据按待拿走）。
    var msSkip = calls('productMoveSupplier').length;
    await (async function () {
      var dt = new DataTransfer();
      var row = pickRow('S3 · 绿');
      await fireDrag(row, 'dragstart', dt);
      var skipTile = puTile('skip', 9);
      await fireDrag(skipTile, 'dragover', dt);
      report('暂不拿的灰条也是落点（dragover 高亮）',
        !!skipTile && skipTile.className.indexOf('is-drop-target') >= 0,
        skipTile ? skipTile.className : 'no-tile');
      await fireDrag(skipTile, 'drop', dt);
    })();
    var okFlip = true;
    try {
      await waitFor(function () {
        return !!puTile('pending', 9) && !puTile('skip', 9) &&
          !!puTile('pending', 9).querySelector('[data-key="S3 · 绿"]');
      }, 8000);
    } catch (e) { okFlip = false; }
    var ms2 = calls('productMoveSupplier')[msSkip] || {};
    report('拖进暂不拿的厂家：出参 {code:S3, supplierId:9} + 该厂家翻成待拿卡（暂不拿卡消失）',
      okFlip && ms2.code === 'S3' && ms2.supplierId === 9, JSON.stringify(ms2));

    // ④ S3·绿：厂C → 厂A —— 拖回去（可逆）+ 把夹具还原成"三款都在厂A"，
    //    后面的开单步骤才有确定起点（分区判据双向：厂C 回暂不拿区）。
    var msBack = calls('productMoveSupplier').length;
    await (async function () {
      var dt = new DataTransfer();
      var row = puTile('pending', 9).querySelector('[data-key="S3 · 绿"]');
      await fireDrag(row, 'dragstart', dt);
      await fireDrag(puTile('pending', 7), 'drop', dt);
    })();
    var okRestore = true;
    try {
      await waitFor(function () {
        return !!puTile('skip', 9) && !puTile('pending', 9) &&
          !!puTile('pending', 7).querySelector('[data-key="S3 · 绿"]');
      }, 8000);
    } catch (e) { okRestore = false; }
    var ms3 = calls('productMoveSupplier')[msBack] || {};
    report('拖回厂A：出参 {code:S3, supplierId:7} + 厂C 回暂不拿区（分区判据双向）',
      okRestore && ms3.code === 'S3' && ms3.supplierId === 7, JSON.stringify(ms3));
    // 四条拖拽的净效果：未指定厂家不再占家 ⇒ 它那张待拿卡消失（概览文案已撤，
    // 净效果改钉在**宫格本身**上 —— 卡少一张是同一事实的宫格侧证据）。
    report('拖拽净效果进宫格：未指定厂家清空后整卡消失（不再占家）',
      !puTile('pending', 0),
      'pending,0 = ' + (puTile('pending', 0) ? flat(puTile('pending', 0)) : 'gone'));

    // ---- 新建空白单（概览条右侧；「按订单」页签已撤，这是不走路单的唯一开单入口）----
    // 单子管理本身全在卡上（每张单在自家厂家卡的"已开单"行里），这里只守开单入口的行为。
    report('只有草稿给「提交」（已提交的单不该出现提交按钮；单子行在卡上，不切视图）',
      !!card('pu-submit-3') && !card('pu-submit-2'), '');
    // ⚠️ **默认值不能靠位置**：厂家下拉不许预选第一个 —— 夹具里故意放多个厂，
    // ---- 编辑器：真取单、真算、真提交（分 ↔ 元）----
    // （2026-10-17 第五轮：「新建空白单」整块撤掉，原"厂家不预选 / 禁用 / 解禁"三条断言随之退役
    //   —— 开单入口唯一 = 厂家卡上的「生成拿货单（N 件）」，上面已有负向断言钉住。）
    // 先验「N 行色未定」这枚标签**真的能点进去**（只查元素在 = 守不住"点了没反应"）：
    var undBefore = calls('purchaseOrderGet').length;
    card('pu-undecided-3').click();
    var okUnd = true;
    // ⚠️ 等**抽屉出现**，不能只等"IPC 调用数变了"：调用记下到弹层渲染之间有几十毫秒，
    //    只等前者会立刻跑去点 ✕（此时 ✕ 还不存在 ⇒ null.click 崩掉整轮）。
    try { await waitFor(function () { return !!card('pu-editor') && calls('purchaseOrderGet').length > undBefore; }, 6000); }
    catch (e) { okUnd = false; }
    report('点「2 行色未定」直接打开这张单的编辑器（认色入口就在眼前，不必先找"查看/编辑"）',
      okUnd && (calls('purchaseOrderGet')[undBefore] || {}).id === 3 && !!card('pu-editor'),
      JSON.stringify(calls('purchaseOrderGet')[undBefore] || {}));
    // 关掉再走下面原有的「查看 / 编辑」路径（两步都要各自成立）
    if (card('pue-close')) card('pue-close').click();
    var okClosed = true;
    try { await waitFor(function () { return !card('pu-editor'); }, 6000); } catch (e) { okClosed = false; }
    report('关闭后抽屉真的收起（下一步「查看 / 编辑」才有可点的东西）', okClosed, '');
    card('pu-edit-3').click();
    await waitFor(function () { return !!card('pu-editor'); }, 6000);
    report('「查看 / 编辑」去取的是**这一张**（purchaseOrderGet {id:3}）',
      calls('purchaseOrderGet').length >= 1 && calls('purchaseOrderGet')[0].id === 3 && !!card('pue-table'),
      JSON.stringify(calls('purchaseOrderGet')[0] || {}));
    report('编辑器里明细金额真算（2 件 × 60.00 = ¥120.00）',
      flat(card('pue-total')).indexOf('120.00') >= 0, flat(card('pue-total')));
    // 包价单 2026-10-20 已删：单子只有"明细"一种形态 ⇒ 页头**不再**挂一个恒为"明细"的模式标签
    // （也不该出现"改不动的下拉框"——那是假动作）。反向断言：两种都在就红。
    report('编辑器不再有模式标签 / 模式下拉（单只有明细一种形态）',
      !!card('pu-editor') && !card('pue-mode') && !card('pue-mode-tag'), '');
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
    // ⚠️ 2026-10-28：**不能取下标 0** ——「归类核对」现在也用同一条通道取**款首图**
    //    （行内「归属款」格子常显款图），而它在冒烟里跑在拿货段之前 ⇒ 第 0 次调用不再是编辑器的。
    //    判据改成"第一条**按行带尺码**的调用"：那个形状只有拿货单编辑器会产生（款图那次不带 size），
    //    比"第几次调用"这种顺序假设更贴近这条断言真正想验的东西。
    var si0 = (calls('purchaseStyleImages') || []).filter(function (a) {
      return ((a && a.items) || []).some(function (it) { return !!it && !!it.size; });
    })[0];
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
        return !!a && !!b && a.complete && b.complete && a.naturalWidth > 0 && b.naturalWidth > 0;
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

    // ⭐ 回归守卫（2026-10-18 评审修复）：往**单价**框敲值 ⇒ v-model 写回 + 重渲染。
    //    曾因 rowAmountText 对 number 型 priceText 直接 .trim() 抛 TypeError —— 崩在渲染期
    //    ⇒ Vue 把整个编辑器卸载（"一敲单价编辑器就消失"）。渲染期崩溃不走 window.onerror，
    //    只有 console.error ⇒ 冒烟里断"编辑器还在 + 金额格重算"是唯一抓得住它的姿势。
    //    判据双钉：① 编辑器还在（崩了它就没了）；② 金额格跟着重算（写回真生效，不是空转）。
    var priceEl = card('pue-price-1');
    priceEl.value = '25.5';
    priceEl.dispatchEvent(new Event('input', { bubbles: true }));
    var okTypePrice = true;
    try {
      await waitFor(function () {
        return !!card('pu-editor') && flat(card('pue-amt-1')).indexOf('76.50') >= 0;
      }, 4000);
    } catch (e) { okTypePrice = false; }
    report('敲单价：编辑器不崩（金额格实时重算 3 × 25.50 = ¥76.50，抽屉仍在）',
      okTypePrice,
      card('pu-editor') ? flat(card('pue-amt-1')) : 'editor-unmounted');

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
    var okImgBack = true;
    try {
      await waitFor(function () { return !!card('pue-img-1') && !card('pue-noimg-1'); }, 6000);
    } catch (e) { okImgBack = false; }
    report('改回 S1 · 黑：图从缓存回来（同款色不重复往返 —— 请求数没涨）',
      okImgBack && calls('purchaseStyleImages').length === siBeforeBack,
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
    // #2 是**已提交**单：删除会真的回滚已拿 ⇒ 确认必须同时讲清"缺口回升"与"对账/成本同步减少"。
    // 反向守卫：文案里不许再出现"包价"（那条按 mode 分支的文案已随包价单删除；
    // 谁把它加回来，说明 mode 分支又活过来了）。
    report('删除已提交单的确认同时讲清缺口回升 + 对账/成本影响，且不再按"包价"分支措辞',
      flat(card('confirm-dialog')).indexOf('回升') >= 0 &&
        flat(card('confirm-dialog')).indexOf('对账') >= 0 &&
        flat(card('confirm-dialog')).indexOf('包价') < 0,
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
    var okExp2 = true;
    try { await waitFor(function () { return calls('purchaseExportExcel').length > expBefore; }, 6000); }
    catch (e) { okExp2 = false; }
    var ex = calls('purchaseExportExcel')[expBefore] || {};
    report('导出：出参是这张单的**全部明细行**（每行带款色 + 尺码，主进程靠它查每行自己那件的图）+ 默认文件名',
      okExp2 && (ex.items || []).length === 2 &&
        (ex.items || [])[0].styleCode === 'S1' && (ex.items || [])[0].color === '黑' &&
        (ex.items || [])[0].size === 'L' &&
        (ex.items || [])[1].styleCode === 'S1' && (ex.items || [])[1].color === '黑' &&
        (ex.items || [])[1].size === 'M' &&
        !!ex.defaultName,
      JSON.stringify(ex));

    // ---- 卡尾一键开单（拿货的主路径；页签撤掉后不存在"切回"这一步）----
    // 一张拿货单只能挂一个厂家 ⇒ 按钮就在卡尾，只收这家厂的行（混着发会把单开给错的厂，
    // 而单上看不出来）。卡存在性由上面的「卡尾给生成拿货单」那条钉住。
    await waitFor(function () { return !!pickRow('S1 · 黑'); }, 8000);
    // 四条拖拽的净效果：厂A 现在有三款色待拿 4 件 ⇒ 卡合计与按钮上的数跟着重算。
    // ⚠️ 合计同样走 amountText（不写 ≈）：部分缺价 = ¥X（不含 N 件无进价）。
    var crBtn2 = puTile('pending', 7).querySelector('[data-act="pk-create-order"]');
    report('拖拽还原后卡合计与按钮跟着重算（3 款色 · 待拿 4 件 · ¥10.00（不含 3 件无进价）→ 生成拿货单（4 件））',
      flat(puTile('pending', 7)).indexOf('合计 3 款色 · 待拿 4 件 · ¥10.00（不含 3 件无进价）') >= 0 &&
        !!crBtn2 && flat(crBtn2).indexOf('生成拿货单（4 件）') >= 0,
      flat(puTile('pending', 7)).slice(0, 140) + ' | ' + (crBtn2 ? flat(crBtn2) : 'no-btn'));
    var crBefore = calls('purchaseOrderCreate').length;
    crBtn2.click();
    var okCreate = true;
    try { await waitFor(function () { return calls('purchaseOrderCreate').length > crBefore; }, 6000); }
    catch (e) { okCreate = false; }
    var cr = calls('purchaseOrderCreate')[crBefore] || {};
    var crItem = (cr.items || [])[0] || {};
    report('按清单开单：出参带厂家 + 日期 + 明细（qty = **还差**、单价留 0 待填、建议数量 = 还差、款名带上）',
      okCreate && cr.supplierId === 7 && !!cr.bizDate &&
        crItem.styleCode === 'S1' && crItem.styleName === '款一' && crItem.color === '黑' && crItem.size === 'L' &&
        crItem.qty === 2 && crItem.priceCents === 0 && crItem.suggestionQty === 2 &&
        (cr.items || []).length === 3 &&
        (cr.items || [])[1].styleCode === 'S2' && (cr.items || [])[1].qty === 1 &&
        (cr.items || [])[2].styleCode === 'S3' && (cr.items || [])[2].qty === 1,
      JSON.stringify(cr));
    // 反向守卫：出参不再带 mode（包价单删除后宿主**恒写** 'detail'，界面没得选 ⇒ 传了也是假动作）
    report('开单出参不再带 mode（宿主恒写明细，界面不再有选择）', okCreate && !('mode' in cr), JSON.stringify(cr));
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
    // 生成后**不切视图**（本来就只有一页）：草稿**就地**出现在这家卡的"已开单"区里，
    // 跟着 bump 重取就能看见 —— 不让用户再找。
    var okStay = true;
    try {
      await waitFor(function () { return !!card('pu-orow-99'); }, 4000);
    } catch (e) { okStay = false; }
    report('生成后留在本页（草稿就地在本卡的「已开单」里，不让用户再找）',
      okStay && !!puTile('pending', 7), '');
    var okNewRow = true;
    try {
      await waitFor(function () {
        return !!puTile('pending', 7).querySelector('[data-act="pu-orow-99"]') &&
          flat(puTile('pending', 7)).indexOf('草稿') >= 0;
      }, 8000);
    } catch (e) { okNewRow = false; }
    report('新单就地出现在厂A 卡的「已开单」区（#99 · 草稿；入口唯一 = 卡上那一截）',
      okNewRow, okNewRow ? flat(puTile('pending', 7).querySelector('[data-act="pu-orow-99"]')) : 'timeout');
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
    // 新单**真的入册**：它的管理动作（提交/导出/删除）就在同一张卡的"已开单"行上
    //（页签撤掉后"按订单列表"没有了 —— 入口唯一 = 卡上那一截）。
    var okInList = true;
    try {
      await waitFor(function () {
        return !!card('pu-edit-99') && !!card('pu-submit-99') &&
          !!card('pu-export-99') && !!card('pu-del-99');
      }, 8000);
    } catch (e) { okInList = false; }
    report('新单入册：#99 的查看/提交/导出/删除就在同一张卡上（入口唯一 = 卡上那一截）',
      okInList, okInList ? flat(card('pu-orow-99')) : 'no-row');

    // ---- 拿齐了就要出「待拿」（2026-10-17 用户实报：已经提交了，状态还是在待拿）----
    // 根因：清单的"已拿"原先读的是**缺口**（purchase-outstanding），而缺口末尾有
    // missing <= 0 就丢掉 的规则 —— 拿齐的那一行根本不返回，已拿按 0 算，remaining = 需求，卡永远待拿。
    // 修法：已拿改读**台账**（purchase-taken，拿齐了照样在）。
    // ⚠️ 判据必须走"缺口里没有它、台账里有它"这个**不对称**（夹具 TAKEN_ALL + 缺口为空）：
    //    把实现改回读缺口，这条就红 —— 只断言"拿齐后是已拿"，两份夹具都给全时照样绿（空转）。
    window.__takenAll = true;
    await clickRefresh();
    await activateTab('purchase');
    var okTaken = true;
    try {
      await waitFor(function () {
        return !puTile('pending', 7) && !!puTile('done', 7);
      }, 8000);
    } catch (e) { okTaken = false; }
    report('拿齐了就出「待拿」：厂A 卡落进已拿区（已拿读台账，不是读缺口 —— 缺口里拿齐的行不存在）',
      okTaken && !!card('pk-bar'),
      okTaken ? 'done 卡=' + flat(puTile('done', 7)).slice(0, 80)
        : 'pending 还在=' + !!puTile('pending', 7) + ' done=' + !!puTile('done', 7));
    // 反向：同一个开关下"还差"必须真的归零（不是卡消失了而已）——卡上不该再有开单按钮。
    report('拿齐后厂A 卡上不再有「生成拿货单」（没有可拿的东西 ⇒ 不给按钮）',
      okTaken && !puTile('done', 7).querySelector('[data-act="pk-create-order"]'), '');
    // 双向：开关关掉、刷回来，厂A 回到待拿（守卫盯的是"已拿"这份数，不是一次性把卡搬走）
    window.__takenAll = false;
    await clickRefresh();
    await activateTab('purchase');
    var okBackPending = true;
    try {
      await waitFor(function () { return !!puTile('pending', 7); }, 8000);
    } catch (e) { okBackPending = false; }
    report('台账撤掉后厂A 回到待拿（双向：卡跟着"已拿"这份数走，不是搬一次就不回来）',
      okBackPending, okBackPending ? flat(puTile('pending', 7)).slice(0, 80) : 'pending 没回来');

    // ---- 空态：不许留空白，要说清"为什么空 / 去哪做" ----
    // ⚠️ 容器的「刷新」必须**作废各面板缓存**（token+1）——只重算汇总不刷面板的话，
    //    面板会一直显示旧数据（这正是本轮顺手缝掉的缝）。所以这里点刷新就能看到新状态。
    //    三个开关一起开：订单行没了（清单空）+ 缺口空 + 拿货单空 ⇒ 宫格与空态一起接管全页。
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
      okPickEmpty && !!card('empty-import') && !puTile('pending', 7) && !card('gaps'),
      okPickEmpty ? flat(card('empty')) + ' | tile=' + !!puTile('pending', 7) : 'timeout / 清单没进空态');
    // 空态的动作跟着**原因**走：「超窗」才给"调天数窗"；这里是"压根没扫到行"，给了就是把用户送去瞎点。
    report('空态的动作跟着**原因**走：不是超窗的场景不给「调天数窗」', !card('empty-widen'), '');
    var emptyImpBefore = evts('switch-module').length;
    card('empty-import').click();
    await waitFor(function () { return onTab('import'); }, 6000);
    report('清单空态的「去导入」= 就地切到「导入订单」页签（内嵌事件交给宿主，不跳模块）',
      onTab('import') && evts('switch-module').length === emptyImpBefore, '');
    // 拿货单空态不用单独给：没有单子时"已开单"区整块不渲染、厂家卡跟着消失（已拿卡由单子生成），
    // 概览条右侧的「新建空白单」就是开单入口（不再是死胡同）。

    // 数据回来后界面跟着回来（保活 + token 联动，不是一次性的）
    window.__emptyOrders = false;
    window.__noGap = false;
    window.__noPurchaseOrders = false;
    await clickRefresh();
    // ⚠️ 上一段「去导入」把页签切到了 import（就地切页签，不跳模块）——
    // 精简条 / 款色行都长在拿货页签上，不切回来这条只能 timeout 出 'no-bar'。
    await activateTab('purchase');
    var okBack = true;
    try {
      await waitFor(function () {
        return !!card('pk-bar') &&
          !!pickRow('S1 · 黑') && !!pickRow('S2 · 白') && !!pickRow('S3 · 绿');
      }, 8000);
    } catch (e) { okBack = false; }
    report('数据回来后界面跟着回来（保活 + token 联动，不是一次性的；三款色行都回来）',
      okBack, card('pk-bar') ? 'bar-ok, rows=' + [pickRow('S1 · 黑'), pickRow('S2 · 白'), pickRow('S3 · 绿')].length : 'no-bar');

    // ---- 门 2（拿货前检查）：会开出一张错单的两种，拒绝并说清去哪补 ----
    // 为什么断言"拒绝"而不是"按钮禁用"：一张卡上常常只有一两行有问题，禁用整张卡会连带挡掉
    // 同一张卡上能拿的货 —— 门的作用域是"这批里的那几行"，不是"这家厂"。
    // 两条都必须断言：只验"拒绝"的话，一个"谁来都拒绝"的实现也能全绿。
    // ⚠️ 先把夹具恢复成"未指定厂家那一格还在"的形态：本段前面那条拖拽断言真的改了
    //    那个"款 → 新厂家"的库（S2 被拖到厂A），不还原就只剩三家的卡、没有可断言的对象。
    window.__movedSuppliers = {};
    await clickRefresh();
    var gateBtn = null;
    try {
      await waitFor(function () {
        gateBtn = document.querySelector('[data-act="pk-create-order"][data-supplier="0"]');
        return !!gateBtn;
      }, 8000);
    } catch (e) { gateBtn = document.querySelector('[data-act="pk-create-order"][data-supplier="0"]'); }
    var createBefore = calls('purchaseOrderCreate').length;
    if (gateBtn) gateBtn.click();
    var gateSaid = true;
    try {
      await waitFor(function () { return !!card('pu-error'); }, 6000);
    } catch (e) { gateSaid = false; }
    var gateMsg = card('pu-error') ? flat(card('pu-error')) : '';
    report('门 2：有"款色没指定厂家"的那一批**不开单**，并把原因与去处写在页面上（不是闪一下就没）',
      !!gateBtn && gateSaid && calls('purchaseOrderCreate').length === createBefore &&
        gateMsg.indexOf('还没指定厂家') >= 0 && gateMsg.indexOf('归类核对') >= 0,
      'btn=' + !!gateBtn + ' called=' + (calls('purchaseOrderCreate').length - createBefore) +
        ' msg=' + JSON.stringify(gateMsg.slice(0, 60)));

    // 正向对照：**同一页上**合格的那一家必须照常开单（否则"拒绝"可能只是"整页不能开单"）
    var okBtn = document.querySelector('[data-act="pk-create-order"][data-supplier="7"]');
    if (okBtn) okBtn.click();
    var okCreated = true;
    try {
      await waitFor(function () { return calls('purchaseOrderCreate').length > createBefore; }, 8000);
    } catch (e) { okCreated = false; }
    var cReq = calls('purchaseOrderCreate')[calls('purchaseOrderCreate').length - 1] || {};
    report('门 2：合格的那一家照常开单（拦的是"这批里的问题行"，不是整页）',
      !!okBtn && okCreated && Number(cReq.supplierId) === 7 &&
        (cReq.items || []).length === 2 &&
        (cReq.items || []).every(function (it) { return Number(it.styleColorId) > 0; }),
      'btn=' + !!okBtn + ' created=' + okCreated + ' supplier=' + cReq.supplierId +
        ' items=' + JSON.stringify((cReq.items || []).map(function (it) {
          return it.styleCode + '/' + it.styleColorId;
        })));
    // 关掉开单后自动弹出的编辑器（它会盖住后面页签的点击热区）
    if (card('pue-close')) card('pue-close').click();
    await waitFor(function () { return !card('pu-editor'); }, 4000);

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

    // ---- 门 1（店铺归一）：一句带数字的话 + 可展开清单 + 一个出口 ----
    // 为什么在这一页断言：本页是"款/色的身份"成型的地方，而键里带店名 ——
    // 一个店名没归一，它名下每个 listing 都自成一款（同一件货在统计/拿货里两行）。
    var shopGateOk = true;
    try {
      await waitFor(function () { return !!card('cl-gate-shop'); }, 8000);
    } catch (e) { shopGateOk = false; }
    var shopGateTxt = card('cl-gate-shop-count') ? flat(card('cl-gate-shop-count')) : '';
    report('门 1：订单里有未归一店铺时，页顶给出「N 家店 · M 行订单」（家数与行数都要说）',
      shopGateOk && shopGateTxt.indexOf('2') >= 0 && shopGateTxt.indexOf('7') >= 0 &&
        shopGateTxt.indexOf('家店') >= 0 && shopGateTxt.indexOf('行') >= 0,
      shopGateOk ? JSON.stringify(shopGateTxt) : '没有提示条');
    report('门 1：默认收起 —— 清单不在 DOM（常驻的只有一句话，不占半屏）',
      !card('cl-gate-shop-list'), 'list=' + !!card('cl-gate-shop-list'));
    card('cl-gate-shop-open').click();
    await waitFor(function () { return !!card('cl-gate-shop-list'); }, 4000);
    var rowA = card('cl-gate-shop-店甲');
    var rowB = card('cl-gate-shop-店乙');
    report('门 1：展开后逐条给店名 / 行数 / 能认成谁；没有候选的那家说"先登记"（不编名字）',
      !!rowA && !!rowB && flat(rowA).indexOf('5 行') >= 0 && flat(rowA).indexOf('能认成') >= 0 &&
        flat(rowB).indexOf('2 行') >= 0 && flat(rowB).indexOf('先登记') >= 0,
      'A=' + (rowA ? flat(rowA) : '无') + ' | B=' + (rowB ? flat(rowB) : '无'));
    report('门 1 **不阻断**动作：「这批全部确认无误」仍然可点（它保护数字口径，不是某个动作）',
      !!card('cl-all-ok') && !card('cl-all-ok').disabled &&
        !!card('cl-gate-shop-go'),
      'all-ok=' + (card('cl-all-ok') ? 'disabled=' + card('cl-all-ok').disabled : '无') +
        ' go=' + !!card('cl-gate-shop-go'));

    // ---- 命名板（P3，2026-10-28；2026-10-30 改成"选中色格 → 点常用色"）----
    // 这一页现在唯一还属于人的判断。断言各自守一个容易写错的实现（每条都能被一个具体错法弄红）：
    //   ① 逐键翻页（"点开一个填一个"）=> 组内 3 个色格不会同时在 DOM 里；
    //   ② 把已命名的也算待办 => 计数变 3（用户会白输一遍已经起过的名）；
    //   ③ 改名时把款名/编码/平台原文一起送过去 => 主进程按界面草稿覆盖事实；
    //   ④ 起名仍然能手打 => 色名会漂成「黑 / 黑色 / Black」三行（这一页的整套改法就是为了堵它）。
    await waitFor(function () { return !!card('vn-panel'); }, 8000);
    // 2026-10-30 用户口径「只列出订单中还没认的颜色」的第二半：取数必须**带着与下方核对表
    // 同一个导入日**。键表是跨批次的记忆 —— 漏传就意味着把十几天前的批次一起铺出来
    // （真库实测 59 个键横跨 10-05 → 10-28，而核对表只显示今天这批）。
    // 日期在断言脚本里自算（不用正则：整段在模板串里，反斜杠会被吃掉）。
    var td = new Date();
    function pad2(n) { return n < 10 ? '0' + String(n) : String(n); }
    var todayKey = String(td.getFullYear()) + '-' + pad2(td.getMonth() + 1) + '-' + pad2(td.getDate());
    var vnReq = calls('orderVariantNaming')[0] || {};
    report('命名板取数带着**今天**的导入日（与「待核对」同一批，不是全库）',
      String(vnReq.importDate || '') === todayKey,
      'payload=' + JSON.stringify(vnReq) + ' 今天=' + todayKey);
    var vnCells = queryAll('[data-act^="vn-cell-"]');
    // 按组取格：这条断言说的是"**一个 listing 的**色同屏"，所以必须限定在组内 ——
    // 全页格数会随夹具里加组而变，拿它当判据等于让断言跟着夹具漂。
    var vnGroup1 = queryAll('[data-act="vn-group-IT-N1"] [data-act^="vn-cell-"]');
    var vnCount = flat(card('vn-count'));
    report('命名板：一个 listing 里**还没认**的 2 个色格同屏给出（不是逐键翻页）',
      !!card('vn-panel') && vnGroup1.length === 2,
      '本组=' + vnGroup1.length + ' 全页=' + vnCells.length + ' 计数=' + vnCount);
    // 2026-10-30 用户口径「只展示订单中没有认颜色的数据」：已起名的色**不进渲染**。
    // 夹具里 903（藏青，N1 款下）与 905（黑，N2 款下）都已起名 ⇒ 它们必须既没有格、也没有输入框。
    report('只列待办：已起过名的色不出现（903 / 905 都不在 DOM 里）',
      !card('vn-cell-903') && !card('vn-cell-905') &&
        queryAll('[data-act="vn-group-IT-N1"] [data-act^="vn-cell-"]').length === 2 &&
        queryAll('[data-act="vn-group-IT-N2"] [data-act^="vn-cell-"]').length === 1,
      '903=' + !!card('vn-cell-903') + ' 905=' + !!card('vn-cell-905') +
        ' N1=' + queryAll('[data-act="vn-group-IT-N1"] [data-act^="vn-cell-"]').length +
        ' N2=' + queryAll('[data-act="vn-group-IT-N2"] [data-act^="vn-cell-"]').length);
    // 色格里**不许有输入框**（判据限定在色格内：组头的款名输入框是另一件事，它本来就该在）。
    // 这一条是这次改法的核心：改名只剩"选中 → 点色卡 / 拖到色卡"一条路径。
    report('色名是只读的：色格里没有任何输入框（起名只能点常用色 / 拖到色卡）',
      queryAll('[data-act^="vn-cell-"] input').length === 0 &&
        !!card('vn-name-901') && !!card('vn-palette') && !card('vn-input-901'),
      '格内输入框=' + queryAll('[data-act^="vn-cell-"] input').length +
        ' 色卡条=' + !!card('vn-palette') + ' 旧输入框=' + !!card('vn-input-901'));
    // 未选中时色卡条只说下一步（此时点任何一颗色卡都不该发生写库 —— 见下一条）
    var vnHint0 = flat(card('vn-sel-hint'));
    report('未选中色格时，色卡条只提示"先点一个色格"，且没有「取消选择」',
      vnHint0.indexOf('先在下面点一个色格') >= 0 && !card('vn-sel-clear'),
      'hint=' + JSON.stringify(vnHint0) + ' 取消选择=' + !!card('vn-sel-clear'));
    // ⚠️ 正则里的空白写成 [ ] 而不是 \\s：这段代码整体在一个模板串里，单个反斜杠会被吃掉。
    report('命名板计数只数**未命名**的（夹具 3 待命名 + 2 已命名 => 文案必须是 3 / 共 5）',
      /还有[ ]*3[ ]*个/.test(vnCount) && /共[ ]*5[ ]*个/.test(vnCount),
      '计数文案=' + JSON.stringify(vnCount));
    // 组内进度（P3 补）：一屏只铺 6 个 listing，人需要知道"这一组填完了没"。
    // 判据是**这一组的**剩余数：两组分别是 2 / 1，而总数是 3 —— 拿总数冒充组内数的实现
    // 在这两条上都会红（3 ≠ 2、3 ≠ 1），这也是夹具必须放第二个组的原因。
    var vnLeft1 = flat(card('vn-group-left-IT-N1'));
    var vnLeft2 = flat(card('vn-group-left-IT-N2'));
    report('命名板：组头给的是**这一组**还剩几个（不是总进度）',
      /2[ ]*个没起名/.test(vnLeft1) && /1[ ]*个没起名/.test(vnLeft2),
      'N1=' + JSON.stringify(vnLeft1) + ' N2=' + JSON.stringify(vnLeft2));
    // ---- 起名的手势：点色格（选中）→ 点上面那颗常用色 ----
    // 与产品页 SKU 矩阵同一套（2026-10-30 用户口径「改成编辑产品页的 SKU 编辑的方式」）。
    // 三条要点各自能被一个错法弄红：
    //   ① 一次点击只改**选中的那一格**（按平台原文批量改会把不同 listing 的「1」混成一色）；
    //   ② 点之前就能看出"这一下会被拒"（同款已有该色时色卡打勾）；
    //   ③ 送出去的载荷只有 id + 名字（款名/编码/平台原文一律由主进程回读）。
    function vnChip(name) {
      return document.querySelector('[data-act="vn-common"][data-color="' + name + '"]');
    }
    // 当前选中的是哪一格（从 DOM 读，不碰组件内部状态）
    function vnSelId() {
      var el = document.querySelector('[data-act^="vn-cell-"].is-sel');
      return el ? String(el.getAttribute('data-act')).replace('vn-cell-', '') : '';
    }
    card('vn-cell-901').click();
    await waitFor(function () { return !!card('vn-sel-clear'); }, 4000);
    var vnHint1 = flat(card('vn-sel-hint'));
    report('点一个色格 = 选中它：色卡条改口成"正在给「5」起名"，并出现「取消选择」',
      vnHint1.indexOf('正在给') >= 0 && vnHint1.indexOf('「5」') >= 0 &&
        !!card('vn-sel-clear') && String(card('vn-sel-901').className).indexOf('is-on') >= 0,
      'hint=' + JSON.stringify(vnHint1) + ' 选中标记=' + card('vn-sel-901').className);
    // 同款下已有的色在色卡上打勾（所以人点之前就知道会被拒）；同款没有的不打勾
    var cIn = vnChip('藏青');
    var cOut = vnChip('军绿');
    report('色卡按**款**打勾：这个款下已叫「藏青」的那颗打勾，没有的「军绿」不打勾',
      !!cIn && !!cOut && cIn.className.indexOf('is-in') >= 0 && cOut.className.indexOf('is-in') < 0,
      '藏青=' + (cIn ? cIn.className : '无') + ' 军绿=' + (cOut ? cOut.className : '无'));
    // ① 点一个**已被同款占用**的名字 => 主进程回 ok:false，原话显示在这一格，且**不跳选中**
    //    （跳走等于把错误甩在身后，人还得回头找是哪一格失败了）
    var nb0 = calls('orderVariantNaming').length;
    cIn.click();
    await waitFor(function () { return calls('orderVariantRename').length > 0; }, 6000);
    // 等**重读**（finally 里 reload）落地：桩的 rec 是同步记的，只等"调用发生"拿到的是重读前的 DOM
    await waitFor(function () { return calls('orderVariantNaming').length > nb0; }, 6000);
    var renCalls = calls('orderVariantRename');
    var renPayload = renCalls[0] || {};
    var vnErr = flat(card('vn-err-901'));
    report('点色卡即存，且**只送** styleColorId + name（款名/编码/平台原文不许由界面送）',
      renCalls.length === 1 && Number(renPayload.styleColorId) === 901 &&
        String(renPayload.name) === '藏青' && Object.keys(renPayload).length === 2,
      'payload=' + JSON.stringify(renPayload) + ' 次数=' + renCalls.length);
    report('被拒绝时显示**主进程的原话**（不是统一的"保存失败"），且不把人跳到下一格',
      vnErr.indexOf('同名') >= 0 && vnSelId() === '901',
      '错误文案=' + JSON.stringify(vnErr) + ' 选中=' + JSON.stringify(vnSelId()));
    // ② 点一个**同款还没有**的名字 => 存成功，选中自动交给同组下一个未命名的色
    //    （真库 54 个待命名键，靠鼠标每格点一次 = 54 次）
    var nb1 = calls('orderVariantNaming').length;
    vnChip('军绿').click();
    await waitFor(function () { return calls('orderVariantRename').length === 2; }, 6000);
    await waitFor(function () { return calls('orderVariantNaming').length > nb1; }, 6000);
    var ren2 = calls('orderVariantRename')[1] || {};
    var sel2 = '';
    try {
      await waitFor(function () { return vnSelId() === '902'; }, 6000);
      sel2 = vnSelId();
    } catch (e) { sel2 = vnSelId(); }
    report('存成功 ⇒ 选中自动交给**同组下一个未命名**的格（省掉"每个色点一次鼠标"）',
      Number(ren2.styleColorId) === 901 && String(ren2.name) === '军绿' && sel2 === '902',
      'payload=' + JSON.stringify(ren2) + ' 选中=' + JSON.stringify(sel2));
    // ③ 本组填完 ⇒ 交给**下一组**的第一个未命名格（一组 7 个色的真库 listing 很常见：
    //    填到最后一个还得回头找下一块在哪，等于每组浪费一次滚屏 + 一次点击）
    var nb2 = calls('orderVariantNaming').length;
    vnChip('酒红').click();
    await waitFor(function () { return calls('orderVariantRename').length === 3; }, 6000);
    await waitFor(function () { return calls('orderVariantNaming').length > nb2; }, 6000);
    var ren3 = calls('orderVariantRename')[2] || {};
    var sel3 = '';
    try {
      await waitFor(function () { return vnSelId() === '904'; }, 6000);
      sel3 = vnSelId();
    } catch (e) { sel3 = vnSelId(); }
    report('本组填完 ⇒ 选中交给**下一组**的第一个未命名格（不回头找）',
      Number(ren3.styleColorId) === 902 && String(ren3.name) === '酒红' && sel3 === '904',
      'payload=' + JSON.stringify(ren3) + ' 选中=' + JSON.stringify(sel3));
    // ④ 把色格**拖到空白处**松手 = 什么都不发生，且那一次 click 被吞掉
    //    （拖完松手总会跟一个 click；不吞的话它会顺手选中刚松手位置下面那一格 —— 人以为在拖，其实在选）
    var emptyPt = { x: 8, y: 8 };
    firePointer(card('vn-cell-904'), 'pointerdown', rectCenter(card('vn-cell-904')));
    firePointer(window, 'pointermove', { x: 60, y: 60 });
    firePointer(window, 'pointermove', emptyPt);
    firePointer(window, 'pointerup', emptyPt);
    card('vn-cell-901').dispatchEvent(new MouseEvent('click', { bubbles: true }));
    // Vue 的 class 要等一次重绘：同步读 DOM 永远是"拖动前"的样子（这条断言就会恒绿）
    await new Promise(function (r) { setTimeout(r, 120); });
    report('拖到空白处松手：不改名（也没多送一次 IPC），且拖后那次 click 被吞掉（选中仍是 904）',
      calls('orderVariantRename').length === 3 && vnSelId() === '904',
      'IPC=' + calls('orderVariantRename').length + ' 选中=' + JSON.stringify(vnSelId()));
    // ⑤ 把色格**拖到色卡上**松手 = 起名（与点色卡是同一条落库路径）
    var dragChip = vnChip('藏蓝');
    // 色卡条可能滚出视口 —— elementFromPoint 只认**屏幕上**的点，真上手时人也会先滚到看得见的地方
    dragChip.scrollIntoView({ block: 'center' });
    var from = rectCenter(card('vn-cell-904'));
    var to = rectCenter(dragChip);
    firePointer(card('vn-cell-904'), 'pointerdown', from);
    firePointer(window, 'pointermove', { x: from.x + 18, y: from.y + 18 });
    firePointer(window, 'pointermove', to);
    // ⚠️ 等一次重绘再读 class：绑在 drag.active 上的 is-dragging / is-drop / is-src 是 Vue 渲染出来的，
    //    同步读永远是"按下之前"的样子（这条断言就会恒绿或恒红）
    await new Promise(function (r) { setTimeout(r, 120); });
    // ⚠️ 必须在**松手前**记 class：pointerup 一落地，is-dragging / is-drop / is-src 就都复原了
    var draggingCls = String(card('vn-palette').className);
    var dropCls = String(dragChip.className);
    var srcCls = String(card('vn-cell-904').className);
    firePointer(window, 'pointerup', to);
    await waitFor(function () { return calls('orderVariantRename').length === 4; }, 6000);
    var ren4 = calls('orderVariantRename')[3] || {};
    report('把色格拖到色卡上松手 = 起名（拖动中整排提亮、落点那颗高亮、被拖的格变淡）',
      draggingCls.indexOf('is-dragging') >= 0 && dropCls.indexOf('is-drop') >= 0 &&
        srcCls.indexOf('is-src') >= 0 &&
        Number(ren4.styleColorId) === 904 && String(ren4.name) === '藏蓝' &&
        calls('orderVariantRename').length === 4,
      '拖动中=' + draggingCls + ' 落点=' + dropCls + ' payload=' + JSON.stringify(ren4));

    // ---- 款信息（组头）：这一层是"这个款叫什么 / 从哪家拿" ----
    // 为什么单列断言：色名写 oi_style_colors，款名与厂家写产品主数据（pl_products）——
    //   两张不同域的表。最容易被写错的实现是"一个入口送全量字段"，于是"只改个名字"
    //   顺手把厂家清成 0，拿货页随即多出一批未指定厂家的货。
    var styName = card('vn-style-name-IT-N1');
    var stySup = card('vn-style-sup-IT-N1');
    report('组头给的是「款」这一层：款编码只读 + 款名输入框 + 厂家下拉',
      !!card('vn-style-code-IT-N1') && !!styName && !!stySup &&
        flat(card('vn-style-code-IT-N1')) === 'N1',
      '编码=' + (card('vn-style-code-IT-N1') ? flat(card('vn-style-code-IT-N1')) : '无') +
        ' 名框=' + (styName ? '在' : '无') + ' 厂家=' + (stySup ? '在' : '无'));
    report('厂家下拉默认落在「未指定」（默认值不靠位置：第一个选项是厂家 厂A）',
      !!stySup && stySup.value === '0',
      'value=' + (stySup ? stySup.value : '?') + ' 选项数=' + (stySup ? stySup.options.length : 0));
    // ⚠️ 走**回车**而不是点「保存」：按钮的 disabled 绑在"有改动"上，而改动是上一行
    //    dispatch 出来的 —— Vue 要到下一个 microtask 才重绘，同步 click 打到的还是 disabled 的按钮，
    //    于是"点了没反应"。回车直接进 saveStyle（与面板文案"填完按回车即存"同一路径）。
    var nbBefore = calls('orderVariantNaming').length;
    setInput('vn-style-name-IT-N1', '测试卫衣');
    card('vn-style-name-IT-N1').dispatchEvent(new KeyboardEvent('keyup', { key: 'Enter', bubbles: true }));
    // ⚠️ 不能只等"调用发生了"就往下走：桩里的 rec 是**同步**记下的，promise 还没 resolve。
    //    存成功之后组件会重读一次命名板（finally 里 reload）—— 等那一次才说明草稿已清空，
    //    否则下一步"选厂家"会把还没清掉的草稿当成没保存的改动一起送出去（断言就会红得莫名其妙）。
    await waitFor(function () { return calls('orderVariantNaming').length > nbBefore; }, 6000);
    var sb1 = calls('orderStyleBasics')[0] || {};
    report('只改款名时只送 styleId + name（**不送** supplierId ⇒ 厂家不会被清掉）',
      Number(sb1.styleId) === 77 && String(sb1.name) === '测试卫衣' && !('supplierId' in sb1),
      'payload=' + JSON.stringify(sb1));
    setInput('vn-style-sup-IT-N1', '8');
    await waitFor(function () { return calls('orderStyleBasics').length > 1; }, 6000);
    var sb2 = calls('orderStyleBasics')[1] || {};
    report('选厂家是**离散选择** ⇒ 立刻保存，且不把款名一起重发（避免草稿覆盖刚改的名字）',
      Number(sb2.styleId) === 77 && Number(sb2.supplierId) === 8 && !('name' in sb2),
      'payload=' + JSON.stringify(sb2));

    // ---- 「可能是同一件货」**已撤下**（2026-10-30 用户口径「现在的推荐完全不准」）----
    // 为什么撤：它的"推荐"只是「同一厂家下 ≥2 个款」—— 真库 5 号厂家挂了 8 个款，
    //   等于一屏摆 8 行让人自己判断，比不摆更费注意力（而错并比拆更难被发现）。
    // 为什么这里要留**反向**断言：撤下这件事本身得有人守 —— 以后有人"顺手"把它挂回来，
    //   冒烟全绿的话没人会发现"又冒出一块没有判据的猜测"。
    await activateTab('classify');
    await new Promise(function (r) { setTimeout(r, 150); });
    report('「可能是同一件货」已撤下：本页没有这块，也不再请求合并候选',
      !card('sm-merge') && !card('sm-merge-toggle') && calls('orderStyleMergeBoard').length === 0,
      '卡=' + !!card('sm-merge') + ' 候选请求=' + calls('orderStyleMergeBoard').length);

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
    // ── 颜色格（2026-10-30 起不是下拉了）────────────────────────────────
    // 有款色卡的行 = 「色点 + 色名」按钮（data-color 带当前值），点开一个
    // Teleport 到 body 的小弹层（.cl-color-pop，chip = [data-act="cl-color-pick-common"]）；
    // 没点名款 / 款还没录颜色的行仍是自由输入（INPUT，沿用 setInput）。
    // 弹层挂在 body 下，**不在** classify 卡片里 ⇒ 不能用 card() 查，得走 document。
    function clColorVal(id) {
      var el = card('cl-color-' + id);
      if (!el) return null;
      return el.tagName === 'BUTTON' ? el.getAttribute('data-color') : el.value;
    }
    function clPopChip(name) {
      return document.querySelector('.cl-color-pop [data-act="cl-color-pick-common"][data-color="' + name + '"]');
    }
    async function clPickColor(id, name) {
      var btn = card('cl-color-' + id);
      if (!btn || btn.tagName !== 'BUTTON') return false;
      btn.click();
      try { await waitFor(function () { return !!clPopChip(name); }, 4000); }
      catch (e) { return false; }
      clPopChip(name).click();
      // 选中即写草稿并收起弹层；值到位才算数（点开错 chip 不该恒绿）
      try { await waitFor(function () { return clColorVal(id) === name && !document.querySelector('.cl-color-pop'); }, 4000); }
      catch (e) { return false; }
      return true;
    }
    async function clClearColor(id) {
      var btn = card('cl-color-' + id);
      if (!btn || btn.tagName !== 'BUTTON') return false;
      btn.click();
      try { await waitFor(function () { return !!document.querySelector('[data-act="cl-color-clear"]'); }, 4000); }
      catch (e) { return false; }
      document.querySelector('[data-act="cl-color-clear"]').click();
      try { await waitFor(function () { return clColorVal(id) === ''; }, 4000); }
      catch (e) { return false; }
      // 清空不收起弹层（组件有意如此，方便马上换另一个色）⇒ 这里点遮罩收掉，免得挡后面的行
      var mask = document.querySelector('[data-act="cl-color-pop-mask"]');
      if (mask) mask.click();
      try { await waitFor(function () { return !document.querySelector('.cl-color-pop'); }, 4000); }
      catch (e) { /* 收不收起不挡后面断言 */ }
      return true;
    }

    // ── 色卡托盘（2026-10-30）──────────────────────────────────────────
    // 页头下方常驻一排「色卡」（chip 与产品页共用 ColorPalette ⇒ data-act 是 cl-tray-common，
    // 落点属性 data-cl-tray 由组件透传）。拖动用的是 pointer 事件（不是 HTML5 drag）：
    // pointerdown 的监听在**行头缩略图元素**上，move / up 在 **window** 上 ——
    // 合成事件必须分别派到这两个目标，派错目标 = 拖动压根不发生（而断言会误判成"功能没做"）。
    function trayChips() {
      return queryAll('[data-act="cl-tray-common"]');
    }
    function trayChip(name) {
      return document.querySelector('[data-act="cl-tray-common"][data-color="' + name + '"]');
    }
    function rectCenter(el) {
      var r = el.getBoundingClientRect();
      return { x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
    }
    function firePointer(target, type, pt) {
      target.dispatchEvent(new PointerEvent(type, {
        bubbles: true, cancelable: true, clientX: pt.x, clientY: pt.y,
        button: 0, buttons: 1, pointerId: 1, pointerType: 'mouse', isPrimary: true,
      }));
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
    // 进页时的**映射自愈**接线：取数前调一次，把「映射已确认、订单却没吃到」的行补上。
    // 反向样本：桩默认 0 行 ⇒ 回执**不该**出现（回执是"刚补过"的事实，不是常驻横幅）。
    // ⚠️ 判据是 **=== 1**，不是 >= 1：这条同时钉住"别把它挂到 token 上"——
    //    那个 token 在本页保存一行、翻一页都会变，跟着它重放等于每动一下就全表扫一遍
    //    （实测曾是 21 次）。进页一次就够：重放治的是历史漏网，新订单落库时已经自动归过款。
    report('进页时先按已有映射自愈，且**只调一次**（挂到 token 上会退化成每动一下扫一遍）',
      (calls('orderReplayMappings') || []).length === 1,
      '调用=' + (calls('orderReplayMappings') || []).length);
    report('没有可补的行时不显示自愈回执（回执只在真的补过时出现）',
      !card('cl-auto-healed'),
      '回执=' + (card('cl-auto-healed') ? flat(card('cl-auto-healed')) : '无'));

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
    // ⚠️ 2026-10-28 起**待核对**范围是 8 列：新增了第一列「勾选」（批量操作用）。
    //    已核对范围仍是 7 列（只读列表不做批量退回），所以这条断言跑在待核对上时要写 8。
    report('待核对表格 8 列（勾选 + 图 / 订单号 / 店铺 / 颜色 / 尺码 / 归属款 / 操作）—— 品类与 Logo 两列已撤',
      headTh.length === 8 && headText.indexOf('品类') < 0 && headText.indexOf('Logo') < 0 &&
        headText.indexOf('颜色') >= 0 && headText.indexOf('归属款') >= 0 && headText.indexOf('尺码') >= 0 &&
        !!card('cl-select-all'),
      '表头=' + headText + ' 列数=' + headTh.length);
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
        var ims = card('cl-table') ? card('cl-table').querySelectorAll('.cl-thumb-btn img') : [];
        return ims.length === 3 && Array.prototype.every.call(ims, function (im) {
          return im.complete && im.naturalWidth > 0;
        });
      }, 6000);
    } catch (e) { /* 下面那条断言会把实际值写出来 */ }
    // ⚠️ 2026-10-28 起表格里有**两类图**：订单图（96px，.cl-thumb-btn 里的 img）与
    //    行内「归属款」的款首图（36px，.cl-style-btn__img）。这里必须按语义选择器取，
    //    不能按 img 标签数（旧的 querySelectorAll('img') 会同时数到款图 ⇒ 3 变 6）。
    var thumbImgs = card('cl-table') ? card('cl-table').querySelectorAll('.cl-thumb-btn img') : [];
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

    // ---- ④「归属款」= **带图**选择器（2026-10-28 换掉原生下拉）----
    // 用户原话：「只是通过下拉列表看文字，不够直观，也容易对应错」。原生 select 放不了图、
    // 也没法在展开时把这一行的订单图摆在旁边 ⇒ 换成「带款首图的格子 + 弹层」。
    //
    // ⚠️ 值不再住在 select 的 value 里 ⇒ 必须有**等价出口** data-style：
    //    没有它，下面所有"默认值不靠位置"的判据都会失效（而且失效得静默 —— 读 undefined 会崩）。
    // ⚠️ 这两条必须成对看：只断言"P-42 有值"会被"永远取第一个款"满足；
    //    只断言"P-41 为空"会被"永远取空"满足。两行给相反的值才分得出来。
    report('归属款是带图按钮（不是原生下拉）：已归类行读 data-style = S1，未归类行为空',
      !!card('cl-style-42') && card('cl-style-42').dataset.style === 'S1' &&
        !!card('cl-style-41') && !card('cl-style-41').dataset.style,
      'P-42=' + (card('cl-style-42') ? JSON.stringify(card('cl-style-42').dataset.style) : '?') +
        ' P-41=' + (card('cl-style-41') ? JSON.stringify(card('cl-style-41').dataset.style) : '?'));

    // 行内**常显款首图**：用户要治的就是"只能看文字"，所以不点开弹层也得看得见。
    // 判据是**真的解码出内容**（只断言"元素在"会漏掉"取回了但没渲染"那一支）。
    var okStyleThumb = true;
    try {
      await waitFor(function () {
        var im = card('cl-style-thumb-42');
        return !!im && im.tagName === 'IMG' && im.complete && im.naturalWidth > 0;
      }, 6000);
    } catch (e) { okStyleThumb = false; }
    var stIm = card('cl-style-thumb-42');
    report('行内格子常显**款首图**（P-42 → S1 的图；不点开弹层也知道这行挂的是哪款）',
      okStyleThumb,
      stIm ? 'nat=' + stIm.naturalWidth + ' src=' + String(stIm.src).slice(0, 40) : 'no-img');

    // ---- ④0 色卡托盘 + 拖图定色（2026-10-30）--------------------------------------------
    // 用户口径：把某行的订单图直接拖到色卡上 = 给那一行定色；勾选多行后点色卡 = 一起定色并保存。
    // ⚠️ 托盘列的是**本页各行的款色卡并集**（夹具里只有 S1 在用 ⇒ 黑 / 白），不是 27 个字典色：
    //    这一页落库的是"款 + 色"的款色，颜色不在款色卡里就落不下去（宿主会顺着它给这个款造一个新色）。
    //    所以判据看两件相反的事：本页款色 黑 / 白 **在**，别的款的色 蓝 **不在**。
    var trayEl = card('cl-tray');
    var trayNames = trayChips().map(function (el) { return el.getAttribute('data-color'); });
    report('色卡托盘 = 本页各行的**款色卡并集**（S1 = 黑 / 白），不是字典里那 27 个色',
      !!trayEl && trayNames.join(',') === '黑,白' && !trayChip('蓝'),
      'tray=' + !!trayEl + ' chips=' + trayNames.join(','));
    report('每颗色卡都带拖放落点属性 data-cl-tray（落点按它认，不按坐标区间 —— 胶囊宽度会随字号变）',
      trayChips().length === 2 && trayChips().every(function (el) {
        return el.getAttribute('data-cl-tray') === el.getAttribute('data-color');
      }),
      trayChips().map(function (el) { return el.getAttribute('data-cl-tray'); }).join(','));
    // 没勾选时点色卡：最容易写成"点了没反应"的一支。判据钉在**没写库**上
    // （提示改一句话不影响数据；落库了才是替用户做了他没点的决定）。
    var trayUpd0 = calls('orderUpdate').length;
    var trayAsg0 = calls('orderStyleAssign').length;
    trayChip('黑').click();
    await new Promise(function (r) { setTimeout(r, 300); });
    report('没勾选时点色卡**只提示下一步**，不写库（orderUpdate / orderStyleAssign 一次都没发）',
      calls('orderUpdate').length === trayUpd0 && calls('orderStyleAssign').length === trayAsg0 &&
        toastHas('先在左边勾选'),
      'upd+' + (calls('orderUpdate').length - trayUpd0) +
        ' asg+' + (calls('orderStyleAssign').length - trayAsg0) + ' | 提示=' + toastDump());
    // 勾两行（都是 S1 的 P-42 / P-44）→ 点色卡 ⇒ 两行都落库
    card('cl-select-42').click();
    card('cl-select-44').click();
    try { await waitFor(function () { return flat(card('cl-tray-hint')).indexOf('已选 2 行') >= 0; }, 4000); }
    catch (e) { /* 下面那条会把实际文案写出来 */ }
    var trayHintOk = !!card('cl-tray-hint') && flat(card('cl-tray-hint')).indexOf('已选 2 行') >= 0;
    var trayList0 = calls('orderList').length;
    var trayAsg1 = calls('orderStyleAssign').length;
    trayChip('黑').click();
    var okTrayBulk = true;
    try { await waitFor(function () { return calls('orderStyleAssign').length >= trayAsg1 + 2; }, 10000); }
    catch (e) { okTrayBulk = false; }
    var trayAsgs = calls('orderStyleAssign').slice(trayAsg1);
    var trayIds = trayAsgs.map(function (a) { return Number(a && a.orderId); }).sort().join(',');
    report('勾选 2 行后点色卡「黑」⇒ **两行都定到这个色并保存**（载荷带款编码 S1 + 色 黑）',
      okTrayBulk && trayIds === '42,44' && trayAsgs.every(function (a) {
        return a && a.styleCode === 'S1' && a.color === '黑';
      }),
      'ids=' + trayIds + ' | ' + JSON.stringify(trayAsgs));
    report('托盘把"这一下会处理几行"写在自己身上（已选 2 行），不靠用户在动作条上找',
      trayHintOk, card('cl-tray-hint') ? flat(card('cl-tray-hint')) : 'no-hint');
    var okTraySaved = true;
    try { await waitFor(function () { return toastHas('已把 2 行定到'); }, 5000); } catch (e) { okTraySaved = false; }
    report('落库后回执说清"定到哪个色、几行"（不是一句"完成"）',
      okTraySaved && toastHas('「黑」'), toastDump());
    // 等 bump 的重取落地，再把勾选清掉（勾选会跨重取保留 —— 不清会干扰后面的段落）
    try { await waitFor(function () { return calls('orderList').length > trayList0; }, 10000); }
    catch (e) { /* 不挡后面的断言 */ }
    if (card('cl-bulk-clear')) { try { await clickReady('cl-bulk-clear'); } catch (e) { /* 同上 */ } }
    try { await waitFor(function () { return !card('cl-bulk'); }, 4000); } catch (e) { /* 同上 */ }

    // 拖图定色：pointerdown 从行头缩略图起手 → 越过 6px 阈值 → 在色卡上松手。
    // 色卡可能被滚出视口（elementFromPoint 只在视口内有效）⇒ 先把它滚到中间再算坐标。
    var chipW0 = trayChip('白');
    if (chipW0) {
      var wRect = chipW0.getBoundingClientRect();
      if (wRect.top < 8 || wRect.bottom > window.innerHeight - 8) {
        chipW0.scrollIntoView({ block: 'center' });
        await new Promise(function (r) { setTimeout(r, 200); });
      }
    }
    var thumb44 = card('cl-zoom-44');
    var chipW = trayChip('白');
    var tPt = thumb44 ? rectCenter(thumb44) : { x: 0, y: 0 };
    var cPt = chipW ? rectCenter(chipW) : { x: 0, y: 0 };
    var trayListD = calls('orderList').length;
    var trayAsg2 = calls('orderStyleAssign').length;
    firePointer(thumb44, 'pointerdown', tPt);
    firePointer(window, 'pointermove', { x: tPt.x + 18, y: tPt.y + 18 });
    firePointer(window, 'pointermove', cPt);
    await new Promise(function (r) { setTimeout(r, 200); });
    var dragMarksOk = !!card('cl-tray') && card('cl-tray').className.indexOf('is-dragging') >= 0 &&
      !!trayChip('白') && trayChip('白').className.indexOf('is-drop') >= 0;
    // 先记下来再松手：松手那一刻两处 class 都会复原，事后读只能读到"已经结束了"
    var dragTrayCls = card('cl-tray') ? card('cl-tray').className : 'missing';
    var dragChipCls = trayChip('白') ? trayChip('白').className : 'missing';
    firePointer(window, 'pointerup', cPt);
    // 真实浏览器在 pointerup 之后还会派一次 click —— 它必须被吞掉（否则松手就顺手把大图打开）
    thumb44.dispatchEvent(new MouseEvent('click', { bubbles: true }));
    var okDrop = true;
    try { await waitFor(function () { return calls('orderStyleAssign').length > trayAsg2; }, 10000); }
    catch (e) { okDrop = false; }
    var dropAsg = calls('orderStyleAssign').slice(trayAsg2)[0] || {};
    report('把 P-44 的图拖到色卡「白」上松手 ⇒ 给**那一行**定色并保存（只一行，不是整页）',
      okDrop && Number(dropAsg.orderId) === 44 && dropAsg.styleCode === 'S1' && dropAsg.color === '白',
      JSON.stringify(dropAsg));
    report('拖动过程中托盘进入落点态（is-dragging + 指针底下那颗 is-drop）—— 松手前就知道会落到哪',
      dragMarksOk, 'tray=' + dragTrayCls + ' 白=' + dragChipCls);
    report('拖完那一下的 click 被吞掉（不会松手就顺手把大图打开）', !card('cl-viewer'),
      'viewer=' + (card('cl-viewer') ? '开着（错）' : '没开'));
    // 等这次保存的重取落地（后面那段要读行内控件）
    try { await waitFor(function () { return calls('orderList').length > trayListD; }, 10000); }
    catch (e) { /* 不挡后面的断言 */ }

    // ---- ④1 批量定色弹层（2026-10-30）--------------------------------------------------
    // 与托盘的区别：托盘是**快路径**（勾中的行款式一致，点一下就走）；这一层治的是**混款** ——
    // 同一个色名在有的款色卡里、在有的款色卡里没有。所以判据盯的是**覆盖数**与**只写适配行**，
    // 不是"弹层能打开"（那个一条 "有没有这个 DOM" 就过了，什么错都拦不住）。
    card('cl-select-42').click();
    card('cl-select-43').click();
    try { await waitFor(function () { return !!card('cl-bulk-color'); }, 4000); } catch (e) { /* 下面这条会说 */ }
    report('勾选后动作条出现「批量定色…」，与「批量定款…」并排（两条都是"这 N 行"的动作）',
      !!card('cl-bulk-color') && !!card('cl-bulk-style'),
      'color=' + !!card('cl-bulk-color') + ' style=' + !!card('cl-bulk-style'));
    await clickReady('cl-bulk-color');
    try { await waitFor(function () { return !!card('bc-head'); }, 4000); } catch (e) { /* 下面这条会说 */ }
    var bcHead = card('bc-head') ? flat(card('bc-head')) : 'missing';
    report('弹层头先说清这批的规模（已选 2 行 · 1 个款）',
      bcHead.indexOf('已选 2 行') >= 0 && bcHead.indexOf('1 个款') >= 0, bcHead);
    var bcBlack = card('bc-color-黑');
    var bcWhite = card('bc-color-白');
    var bcBlackMeta = card('bc-meta-黑') ? flat(card('bc-meta-黑')) : 'missing';
    var bcWhiteMeta = card('bc-meta-白') ? flat(card('bc-meta-白')) : 'missing';
    // 夹具：P-42（S1，已是白）+ P-43（还没点名款）⇒ 黑 改 1 行、另 1 行不适用；白 改 0、已是 1
    report('每种色**点之前**就摆出覆盖数（黑：改 1 行 + 另 1 行不适用；白：改 0 行 · 已是 1）',
      bcBlackMeta.indexOf('改 1 行') >= 0 && bcBlackMeta.indexOf('另 1 行不适用') >= 0 &&
        bcWhiteMeta.indexOf('改 0 行') >= 0 && bcWhiteMeta.indexOf('已是 1') >= 0,
      '黑=' + bcBlackMeta + ' | 白=' + bcWhiteMeta);
    report('「一行都不用改」的色仍然列出来、但**点不动**（"已经是它"看得见，不是被藏起来）',
      !!bcWhite && bcWhite.disabled === true && !!bcBlack && bcBlack.disabled === false,
      '白 disabled=' + (bcWhite ? bcWhite.disabled : 'missing') +
        ' 黑 disabled=' + (bcBlack ? bcBlack.disabled : 'missing'));
    report('没选色之前「确定」不可用（这一层不替人猜一个颜色）',
      !!card('bc-apply') && card('bc-apply').disabled === true,
      'apply disabled=' + (card('bc-apply') ? card('bc-apply').disabled : 'missing'));
    bcBlack.click();
    await new Promise(function (r) { setTimeout(r, 120); });
    var bcApplyText = card('bc-apply') ? flat(card('bc-apply')) : 'missing';
    report('选中后按钮自带"真的会改几行"（定色并保存（1 行），不是一句"确定"）',
      bcApplyText.indexOf('1 行') >= 0 && bcApplyText.indexOf('定色并保存') >= 0, bcApplyText);
    var bcAsg0 = calls('orderStyleAssign').length;
    var bcUpd0 = calls('orderUpdate').length;
    await clickReady('bc-apply');
    var okBc = true;
    try { await waitFor(function () { return calls('orderStyleAssign').length > bcAsg0; }, 10000); }
    catch (e) { okBc = false; }
    var bcAsg = calls('orderStyleAssign').slice(bcAsg0)[0] || {};
    report('落库只动**色卡里有这个色**的行（P-42 → 黑；没点名款的 P-43 一行都不写）',
      okBc && Number(bcAsg.orderId) === 42 && bcAsg.color === '黑' &&
        calls('orderUpdate').length - bcUpd0 === 1,
      'asg=' + JSON.stringify(bcAsg) + ' upd+' + (calls('orderUpdate').length - bcUpd0));
    var okBcToast = true;
    try { await waitFor(function () { return toastHas('已把 1 行定到'); }, 5000); } catch (e) { okBcToast = false; }
    report('回执把没定上的那 1 行也说出来（"还没点名款，先定款再定色"，不是一句"完成"）',
      okBcToast && toastHas('还没点名款'), toastDump());
    report('落库后弹层自己关掉（不用用户再点一次关闭）', !card('bc-mask'),
      'mask=' + (card('bc-mask') ? '还在（错）' : '已关'));
    // 清掉勾选，别把这一批带进后面的段落
    try { await waitFor(function () { return calls('orderList').length > trayListD + 1; }, 10000); }
    catch (e) { /* 不挡后面的断言 */ }
    if (card('cl-bulk-clear')) { try { await clickReady('cl-bulk-clear'); } catch (e) { /* 同上 */ } }
    try { await waitFor(function () { return !card('cl-bulk'); }, 4000); } catch (e) { /* 同上 */ }

    // 弹层里的候选 = **产品库全集**（人手工新建、识别池里没有的 S9 也在 ⇒ 识别池驱动会漏它）
    await clickReady('cl-style-41');
    var okPicker = true;
    try { await waitFor(function () { return !!card('sp-list'); }, 4000); } catch (e) { okPicker = false; }
    var spCodes = card('sp-list')
      ? Array.prototype.map.call(card('sp-list').querySelectorAll('[data-code]'), function (el) { return el.dataset.code; })
      : [];
    report('点开归属款 ⇒ 带图弹层；候选 = 产品库全集（S1 / S2 / S9 三个），不是识别池那 2 个',
      okPicker && spCodes.join(',') === 'S1,S2,S9',
      'open=' + okPicker + ' codes=' + spCodes.join(','));
    report('停用款在弹层里带「停用」标记（历史订单可能正指向它，不能藏起来）',
      !!card('sp-item-S9') && flat(card('sp-item-S9')).indexOf('停用') >= 0,
      card('sp-item-S9') ? flat(card('sp-item-S9')) : 'no-row');
    // 左栏这张图是"拿图挑款"的关键：它必须是**这一行自己的订单图**（不是随便哪张）
    var spOrderIm = card('sp-order-img') ? card('sp-order-img').querySelector('img') : null;
    var rowOrderIm = card('cl-zoom-41') ? card('cl-zoom-41').querySelector('img') : null;
    report('弹层左栏固定这一行的订单图（与表格里那张**同源**；原生下拉做不到这件事）',
      !!spOrderIm && spOrderIm.complete && spOrderIm.naturalWidth > 0 &&
        !!rowOrderIm && spOrderIm.getAttribute('src') === rowOrderIm.getAttribute('src'),
      spOrderIm ? 'nat=' + spOrderIm.naturalWidth + ' 同源=' +
        (!!rowOrderIm && spOrderIm.getAttribute('src') === rowOrderIm.getAttribute('src')) : 'no-img');
    await clickReady('sp-cancel');
    var okClosed = true;
    try { await waitFor(function () { return !card('sp-list'); }, 4000); } catch (e) { okClosed = false; }
    report('「取消」真的关掉弹层（不留"关不掉、得点遮罩"的第二条路）', okClosed, '');

    // ---- ④ 颜色**跟着归属款走** + 记住"这张图上次定的颜色" ----
    // 取值优先级（每一支都要**落在该款的色卡里**才作数）：① 图记住的颜色 → ② 订单自己的颜色 → ③ 留空。
    // 三条各有专属夹具行，**不能合并**：只留 P-42 一条的话，"永远取订单自己的颜色"这种错法照样全绿
    //（P-42 两个值恰好都在色卡里）；只留 P-44 的话，"永远读记住的颜色"也能蒙对。
    var col42 = card('cl-color-42');
    report('点名了款 ⇒ 颜色格是**该款的色卡按钮**（色点 + 当前色名，不再是下拉）',
      !!col42 && col42.tagName === 'BUTTON',
      col42 ? col42.tagName : 'no-el');
    // 色卡内容要在弹层里看：点开 P-42 的颜色格，chip 必须正好是 S1 的色卡（黑 / 白）——
    // 只断言"弹层开了"会被"色卡是空壳 / 全是字典色"骗过去（恒绿）。
    col42.click();
    var okPop42 = true;
    try {
      await waitFor(function () { return !!document.querySelector('.cl-color-pop') && !!clPopChip('黑'); }, 4000);
    } catch (e) { okPop42 = false; }
    var popChips = Array.prototype.map.call(
      document.querySelectorAll('.cl-color-pop [data-act="cl-color-pick-common"]'),
      function (el) { return el.getAttribute('data-color'); });
    report('点开颜色格 ⇒ 小弹层列出**该款的色卡**（S1 = 黑 / 白，一个不多一个不少）',
      okPop42 && popChips.join(',') === '黑,白',
      'chips=' + popChips.join(','));
    report('弹层里当前色带选中态（P-42 记住「白」⇒ 白那颗是 is-current）',
      !!clPopChip('白') && clPopChip('白').classList.contains('is-current'), '');
    // 看完就关掉（遮罩），别让它挡后面的行
    var popMask = document.querySelector('[data-act="cl-color-pop-mask"]');
    if (popMask) popMask.click();
    try { await waitFor(function () { return !document.querySelector('.cl-color-pop'); }, 4000); } catch (e) { /* 不挡路 */ }
    report('图记住的颜色**在**该款色卡里 ⇒ 自动选中它（P-42 图记住「白」、订单自己的颜色是「黑」⇒ 必须是白）',
      clColorVal(42) === '白',
      'value=' + clColorVal(42));
    var col45 = card('cl-color-45');
    report('图记住的颜色**不在**色卡、订单自己的颜色在 ⇒ 回落选订单那个（P-45 记住「印花」/ 订单「黑」⇒ 黑）',
      !!col45 && col45.tagName === 'BUTTON' && clColorVal(45) === '黑',
      col45 ? col45.tagName + ' value=' + clColorVal(45) : 'no-el');
    var col44 = card('cl-color-44');
    report('两个颜色都**不在**色卡里 ⇒ 留空让用户自己选（P-44 记住与订单都是「印花」⇒ 空），并写明原因',
      !!col44 && col44.tagName === 'BUTTON' && clColorVal(44) === '' && !!card('cl-color-warn-44'),
      col44 ? 'value=' + JSON.stringify(clColorVal(44)) +
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

    // ---- ④c 批量（2026-10-28）：勾选 → 吸底动作条 → 按商品分组定款 ----
    // 用户原话：「归属款还是只能一个一个选，路径太长（点击、选择、关闭、确认）」。
    // 这一组断言只做**不改变数据**的事（勾选 / 开弹层 / 取消）：后面还有一大段在按顺序用这五行，
    // 而"勾了一下"不该把它们的状态改掉。
    //
    // ⚠️ 先造一行**脏**的：动作条按钮上的数字必须是"真的会被处理的行数"，
    //    而"勾选数"与"干净行数"只有在两者不等时才分得出来（全干净时两个数字一样，断言恒绿）。
    setInput('cl-color-43', '深蓝');
    await waitFor(function () { return !!card('cl-save-43') && card('cl-save-43').disabled === true; }, 3000);
    card('cl-select-all').click();
    var okBulkAll = true;
    try {
      await waitFor(function () { return !!card('cl-bulk') && !!card('cl-bulk-ok'); }, 4000);
    } catch (e) { okBulkAll = false; }
    report('表头全选勾上本页 5 行；动作条上的「确认无误（4）」= **干净行数**（43 刚被改脏，不算进去）',
      okBulkAll && flat(card('cl-bulk-count')).indexOf('5') >= 0 &&
        flat(card('cl-bulk-ok')).indexOf('（4）') >= 0 &&
        !!card('cl-bulk-dirty') && flat(card('cl-bulk-dirty')).indexOf('1') >= 0,
      '计数=' + (card('cl-bulk-count') ? flat(card('cl-bulk-count')) : '无') +
        ' 按钮=' + (card('cl-bulk-ok') ? flat(card('cl-bulk-ok')) : '无') +
        ' 脏提示=' + (card('cl-bulk-dirty') ? flat(card('cl-bulk-dirty')) : '无'));
    card('cl-bulk-clear').click();
    var okBulkGone = true;
    try { await waitFor(function () { return !card('cl-bulk'); }, 4000); } catch (e) { okBulkGone = false; }
    report('清空选择后整条动作条消失（不是灰着一条白占 40px —— 这一页每 40px 就是半行订单）',
      okBulkGone && !card('cl-bulk-count'), '');
    setInput('cl-color-43', '青');

    // 「同商品」徽标改成可点：点一下 = 勾上本页这个商品的所有行（批量定款最自然的起点）
    card('cl-same-41').click();
    var okSameSel = true;
    try {
      await waitFor(function () {
        return !!card('cl-select-41') && card('cl-select-41').checked &&
          !!card('cl-select-42') && card('cl-select-42').checked;
      }, 4000);
    } catch (e) { okSameSel = false; }
    report('点「同商品 ×2」一次勾上该商品的两行（P-41 / P-42），且不牵连别的行（43/44 仍未勾）',
      okSameSel && !!card('cl-select-43') && !card('cl-select-43').checked &&
        !!card('cl-select-44') && !card('cl-select-44').checked &&
        flat(card('cl-bulk-count')).indexOf('2') >= 0,
      '计数=' + (card('cl-bulk-count') ? flat(card('cl-bulk-count')) : '无'));

    // 批量定款：同一个商品的两行 ⇒ **只有一组**（不该出现"每行一个选择器"）
    await clickReady('cl-bulk-style');
    var okBpOne = true;
    try { await waitFor(function () { return !!card('bp-groups') || !!card('bp-apply'); }, 4000); } catch (e) { okBpOne = false; }
    report('批量定款：同一个商品的两行归成**一组**（标题写"这 2 行是同一个商品"，不出现分组列表）',
      okBpOne && !!card('bp-head') && flat(card('bp-head')).indexOf('同一个商品') >= 0 && !card('bp-groups'),
      okBpOne ? flat(card('bp-head')) : 'timeout');
    card('bp-cancel').click();
    var okBpClosed = true;
    try { await waitFor(function () { return !card('bp-mask'); }, 4000); } catch (e) { okBpClosed = false; }
    report('取消批量定款不落库（弹层关掉，行与勾选都还在 —— 不替用户做他没点的决定）',
      okBpClosed && !!card('cl-select-41') && card('cl-select-41').checked &&
        !!card('cl-style-41') && !!card('cl-select-43'),
      '弹层=' + (card('bp-mask') ? '仍在（错）' : '已关') +
        ' P41勾=' + (card('cl-select-41') ? String(card('cl-select-41').checked) : '无'));
    card('cl-bulk-clear').click();
    await waitFor(function () { return !card('cl-bulk'); }, 4000);

    // 跨商品：43 没有商品ID ⇒ **单独成组**，不与别的行合并（合并就是把两件不相关的商品按同一个款落库）
    card('cl-select-43').click();
    card('cl-select-44').click();
    await waitFor(function () { return !!card('cl-bulk'); }, 4000);
    await clickReady('cl-bulk-style');
    var okBpTwo = true;
    try { await waitFor(function () { return !!card('bp-groups'); }, 4000); } catch (e) { okBpTwo = false; }
    report('跨商品勾选分成 2 组（43 没有商品ID ⇒ 自己一组），标题写"N 个商品 · 共 N 行"',
      okBpTwo &&
        card('bp-groups').querySelectorAll('button.bp-group').length === 2 &&
        flat(card('bp-head')).indexOf('2 个商品') >= 0,
      okBpTwo
        ? '组数=' + card('bp-groups').querySelectorAll('button.bp-group').length + ' | ' + flat(card('bp-head'))
        : 'timeout');
    card('bp-cancel').click();
    try { await waitFor(function () { return !card('bp-mask'); }, 4000); } catch (e) { /* 后面会清勾选 */ }
    card('cl-bulk-clear').click();
    try { await waitFor(function () { return !card('cl-bulk'); }, 4000); } catch (e) { /* 同上 */ }

    // ---- ⑤ 弹层里换款：色卡跟着换；原颜色不在新色卡里 ⇒ 一个都没选中 + 「确定」按不下去 ----
    // 用 P-43（未归类、颜色是自由输入、刚被填成「青」）：选 S1 后「青」不在 S1 的（黑/白）里。
    // ⚠️ 2026-10-28 换了控件 ⇒ 这条守卫的**观察点**从"行内颜色被清空后保存禁用"移到
    //    "弹层里色卡没选中 + 「确定」按不下去"：弹层里没选色根本出不去，所以"行内有款没色"
    //    这个中间态在界面上已经不存在了。判据强度没降（仍是"点了款就必须给色"），只是提前到提交之前。
    await clickReady('cl-style-43');
    try { await waitFor(function () { return !!card('sp-item-S1'); }, 4000); } catch (e) { /* 下面那条会把实际值写出来 */ }
    await clickReady('sp-item-S1');
    var okPick = true;
    try {
      await waitFor(function () { return !!card('sp-colors') && !!card('sp-need-color'); }, 4000);
    } catch (e) { okPick = false; }
    report('换款就换色卡：S1 的色卡（黑 / 白）出现，原颜色「青」不在里面 ⇒ 一个都没选中，「确定」按不下去并写明原因',
      okPick && !!card('sp-confirm') && card('sp-confirm').disabled === true &&
        !!card('sp-color-黑') && !card('sp-color-黑').classList.contains('is-on') &&
        !!card('sp-color-白') && !card('sp-color-白').classList.contains('is-on'),
      '确定禁用=' + (card('sp-confirm') ? String(card('sp-confirm').disabled) : 'no-el') +
        ' 黑选中=' + (card('sp-color-黑') ? String(card('sp-color-黑').classList.contains('is-on')) : '?') +
        ' 提示=' + (card('sp-need-color') ? flat(card('sp-need-color')) : '无'));
    await clickReady('sp-color-黑');
    report('选了颜色后「确定」才解禁（不是"选了款就让过"）',
      !!card('sp-confirm') && card('sp-confirm').disabled === false, '');
    await clickReady('sp-confirm');
    var okFill = true;
    try {
      await waitFor(function () {
        var st = card('cl-style-43');
        var col = card('cl-color-43');
        // 有了款（色卡非空）⇒ 这一格从自由输入变成色卡按钮，当前值挂在 data-color 上
        return !!st && st.dataset.style === 'S1' && !!col && col.tagName === 'BUTTON' &&
          clColorVal(43) === '黑';
      }, 4000);
    } catch (e) { okFill = false; }
    report('确定后行内回填「款 + 色」（S1 · 黑）—— 一次做完，不再"先选款、再回来点颜色"',
      okFill,
      'style=' + (card('cl-style-43') ? JSON.stringify(card('cl-style-43').dataset.style) : '?') +
        ' color=' + JSON.stringify(clColorVal(43)));
    // ⚠️ 这一条是上面那组"确定按不下去"的**反面**：证明解禁的原因是"款与色都到位"，
    //    不是"弹层关掉了"这种与内容无关的事件。
    report('回填后「保存」直接可点（款与色都到位）',
      !!card('cl-save-43') && card('cl-save-43').disabled === false, '');

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
    await clickReady('cl-style-41');
    try { await waitFor(function () { return !!card('sp-item-S2'); }, 4000); } catch (e) { /* 下面会写实际值 */ }
    await clickReady('sp-item-S2');
    var okPick2 = true;
    try {
      await waitFor(function () { return !!card('sp-colors') && !!card('sp-color-蓝'); }, 4000);
    } catch (e) { okPick2 = false; }
    // 「同一段联动换一行照样成立」：P-41 刚存的「白」不在 S2 的色卡（只有蓝）里 ⇒ 色卡无选中项、确定禁用
    report('同一段联动在另一行复现：P-41 的「白」不在 S2 的色卡（只有蓝）里 ⇒ 色卡无选中项，「确定」按不下去',
      okPick2 && !!card('sp-confirm') && card('sp-confirm').disabled === true &&
        !!card('sp-color-蓝') && !card('sp-color-蓝').classList.contains('is-on'),
      '确定禁用=' + (card('sp-confirm') ? String(card('sp-confirm').disabled) : 'no-el') +
        ' 蓝色卡=' + (card('sp-color-蓝') ? '在' : '无'));
    await clickReady('sp-color-蓝');
    await clickReady('sp-confirm');
    var okDirty2 = true;
    try {
      await waitFor(function () {
        var st = card('cl-style-41');
        return !!st && st.dataset.style === 'S2' && clColorVal(41) === '蓝';
      }, 4000);
    } catch (e) { okDirty2 = false; }
    report('从该款色卡里选上颜色后回填（S2 · 蓝），「保存」可点',
      okDirty2 && !!card('cl-save-41') && card('cl-save-41').disabled === false,
      'style=' + (card('cl-style-41') ? JSON.stringify(card('cl-style-41').dataset.style) : '?') +
        ' color=' + JSON.stringify(clColorVal(41)));
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
    var okPick45 = await clPickColor(45, '白');
    var okDirty45 = true;
    try { await waitFor(function () { return !!card('cl-save-45') && card('cl-save-45').disabled === false; }, 4000); }
    catch (e) { okDirty45 = false; }
    report('空指纹那一行的保存前提就绪：P-45 从色卡里点选「白」后「保存」可点',
      okPick45 && okDirty45, '点选=' + okPick45 + ' 值=' + JSON.stringify(clColorVal(45)));
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
    var okPick42 = await clPickColor(42, '黑');
    var okDirty3 = true;
    try { await waitFor(function () { return !!card('cl-save-42') && card('cl-save-42').disabled === false; }, 4000); }
    catch (e) { okDirty3 = false; }
    report('回车流的前提就绪：色卡上点选「黑」后该行可保存', okPick42 && okDirty3, '点选=' + okPick42);
    var updKey = calls('orderUpdate').length;
    // 在**行内控件**上派发 Enter（冒泡到 tr 上的 @keydown.enter）。
    // ⚠️ 不能派在颜色格上：它现在是**按钮**，组件刻意忽略按钮上的 Enter
    //    （原生 Enter=点击，会把色卡弹层按开）。行内剩下的非按钮控件是勾选框 ⇒ 派在它身上。
    card('cl-select-42').dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
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
    // 真库现场正是这个形状：23 行全 corrected=1、oi_order_items.color 全空、款色全是「未分类」。
    // ⚠️ 位置很讲究：必须放在**上一段重取已经落定之后**（上面的焦点断言就是那个信号）。
    //    放早了会撞上重取 —— 重取会把草稿按主进程的数据重建（本页有意为之），
    //    于是"我这边刚填的颜色"被冲掉，行**根本没脏**，这条断言会以"守卫没触发"的样子假红。
    //    ⚠️ "点了但什么都没发生"这类断言**必须先证明前提成立**（这一行真的脏了）——
    //    否则"按钮点不动 / 行不在 / 值没填进去"都能让它恒绿（本仓反复踩过的空转）。
    // ⚠️ 判据钉在**通道没被调用**上（不是钉提示）：提示给错一句话不影响数据，落库了才是真丢东西。
    await waitFor(function () { return !!card('cl-style-44') && !!card('cl-color-44'); }, 6000);
    var okPick44 = await clPickColor(44, '黑');
    var okDirty44 = true;
    try { await waitFor(function () { return !!card('cl-save-44') && card('cl-save-44').disabled === false; }, 4000); }
    catch (e) { okDirty44 = false; }
    report('确认守卫的前提就绪：P-44 从色卡里点选「黑」（该行变脏、「保存」可点）',
      okPick44 && okDirty44,
      '存在=' + !!card('cl-color-44') + ' 值=' + JSON.stringify(clColorVal(44)) +
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
    // 把 P-44 的草稿改回原样（它载入时颜色就是空的），免得脏着影响后面这两段确认与空态。
    // 颜色格是色卡按钮 ⇒ "改回空"走弹层里的「清空颜色」（没有"输入空串"这条路了）。
    var okClear44 = await clClearColor(44);
    report('弹层里的「清空颜色」把草稿退回空（P-44 回到载入时的样子，不再脏）',
      okClear44 && clColorVal(44) === '', '清空=' + okClear44 + ' 值=' + JSON.stringify(clColorVal(44)));
    await waitFor(function () { return !!card('cl-save-44') && card('cl-save-44').disabled === true; }, 4000);

    // ---- ⑤ 批量落库（2026-10-28）：保存并下一条 / 批量定款 ----
    // 「保存并下一条」：一次点击 = 落库 **+ 接上下一行**。用户列的四个动作里，
    // "关闭弹层、点保存、找到下一行再点开"这三步就是被它吃掉的。
    // 用 P-44：保存后它离开列表、P-43 顶上来 ⇒ 弹层应当停在 P-43（而不是关掉或停在原地）。
    await clickReady('cl-style-44');
    try { await waitFor(function () { return !!card('sp-item-S2'); }, 4000); } catch (e) { /* 下面会写实际值 */ }
    await clickReady('sp-item-S2');
    try { await waitFor(function () { return !!card('sp-color-蓝'); }, 4000); } catch (e) { /* 同上 */ }
    await clickReady('sp-color-蓝');
    var asgNext0 = calls('orderStyleAssign').length;
    await clickReady('sp-save-next');
    var okSaveNext = true;
    try { await waitFor(function () { return calls('orderStyleAssign').length > asgNext0; }, 6000); }
    catch (e) { okSaveNext = false; }
    var cn = calls('orderStyleAssign')[asgNext0] || {};
    report('弹层主按钮「保存并下一条」一次点击就落库（不必再"关弹层 → 点行内保存"）',
      okSaveNext && cn.orderId === 44 && cn.styleCode === 'S2' && cn.color === '蓝',
      JSON.stringify(cn));
    var okAutoNext = true;
    try {
      // 当前页顺序是 43 / 44 / 45（P-45 在这一段之前没被模拟成"已核对"，仍在列表里）⇒
      // P-44 存完离开后，顶上来的就是它下面那条 **P-45**。
      await waitFor(function () {
        return !!card('sp-order-no') && flat(card('sp-order-no')) === 'P-45';
      }, 8000);
    } catch (e) { okAutoNext = false; }
    report('保存后弹层自动接到**顶上来的那一行**（P-44 走了 ⇒ 停在它下面那条 P-45），不用回头找下一行',
      okAutoNext,
      '弹层单号=' + (card('sp-order-no') ? flat(card('sp-order-no')) : '已关') +
        ' P-44行=' + (card('cl-style-44') ? '仍在（错）' : '已离开'));
    card('sp-cancel').click();
    await waitFor(function () { return !card('sp-mask'); }, 4000);

    // 批量定款落库：只剩 P-43 一行 ⇒ 一组；它的原色「青」不在 S1 的色卡（黑/白）里
    // ⇒ **不许猜**（猜了就是一次看不见的错归属）。行要留在列表、并保持勾选，等他单独选色。
    var asgBulk0 = calls('orderStyleAssign').length;
    card('cl-select-43').click();
    await waitFor(function () { return !!card('cl-bulk'); }, 4000);
    await clickReady('cl-bulk-style');
    try { await waitFor(function () { return !!card('bp-apply'); }, 4000); } catch (e) { /* 下面会写实际值 */ }
    report('只剩一行时批量定款自然退化成一组（不是"必须凑够两行才能用"）',
      !!card('bp-head') && flat(card('bp-head')).indexOf('同一个商品') >= 0 && !card('bp-groups'),
      card('bp-head') ? flat(card('bp-head')) : 'no-head');
    await clickReady('bp-item-S1');
    await clickReady('bp-apply');
    var okNoGuess = true;
    try { await waitFor(function () { return toastHas('要先选颜色'); }, 8000); } catch (e) { okNoGuess = false; }
    report('批量定款遇到"这个款有多个颜色、这行原色对不上"⇒ **不猜**：不落库，行留在列表并保持勾选',
      okNoGuess && calls('orderStyleAssign').length === asgBulk0 &&
        !!card('cl-select-43') && card('cl-select-43').checked &&
        !!card('cl-style-43'),
      '提示=' + toastDump() + ' | 多发的挂款调用=' + (calls('orderStyleAssign').length - asgBulk0) +
        ' | 仍勾=' + (card('cl-select-43') ? String(card('cl-select-43').checked) : '行没了（错）'));
    card('cl-bulk-clear').click();
    try { await waitFor(function () { return !card('cl-bulk'); }, 4000); } catch (e) { /* 下面不依赖它 */ }

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
    // ⚠️⚠️ 2026-10-28 **改判据**（不是放宽）：原先钉的是 {"all":true} —— 而宿主对 all 的实现是
    //    UPDATE ... WHERE corrected = 0（**全库、不带导入日、不带搜索词**）。本页只显示"今天这批"，
    //    点一下却把别的日子/别的批次的未核对行一起确认，还顺带钉死克重与进价快照。
    //    现在改成"按当前筛选取 id 再点名标记" ⇒ 断言要跟着变成 [41,44,45] 这样的**数组**，
    //    并且**反向**断言全程没有出现过 {all:true}（那才是这条修复真正的守卫）。
    report('「这批全部确认无误」按**当前筛选的 id** 标记（数组，不是 {all:true}）',
      okMkAll && Array.isArray(calls('orderMarkCorrected')[mkA]) && calls('orderMarkCorrected')[mkA].length > 0,
      JSON.stringify(calls('orderMarkCorrected')[mkA]));
    // **自证非空转**：上面断言"是数组"，这条断言"从来不是 {all:true}" —— 两条一起才封住那个口子
    // （只写前者的话，哪天又改回 all 只是这条变红、看不出"为什么危险"；只有后者的话，
    //  一个永远发空数组的实现也能过）。
    report('全程 orderMarkCorrected 一次都没收到 {all:true}（"全库未核对一起确认"的口子已封）',
      (calls('orderMarkCorrected') || []).every(function (a) { return Array.isArray(a); }) &&
        (calls('orderMarkCorrected') || []).length > 0,
      JSON.stringify(calls('orderMarkCorrected') || []));

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
    try {
      // ⚠️ 等的是**文案**而不是"空态元素出现"：空态在 rows 变空的那一刻就挂上了，
      //    而"今天还没有导入订单 / 今天这批都核对完了"这两句取决于 counts（同一批取数里算的）。
      //    只等元素会读到上一帧的文案 —— 那种红看起来像"状态判错"，其实是断言读早了。
      await waitFor(function () {
        var el = card('cl-empty');
        return !!el && flat(el).indexOf('今天还没有导入订单') >= 0;
      }, 8000);
    } catch (e) { okClEmpty = false; }
    report('待核对清零时给空态，并说清"核对的对象从哪来"（不是干巴巴的"暂无数据"）',
      okClEmpty && flat(card('cl-empty')).indexOf('导入') >= 0 && !!card('cl-goto-import'),
      (okClEmpty ? flat(card('cl-empty')) : 'timeout') +
        ' | err=' + (card('cl-error') ? flat(card('cl-error')) : '无') +
        ' | 已核对徽标=' + (card('cl-count-corrected') ? flat(card('cl-count-corrected')) : '?') +
        ' | 待核对徽标=' + (card('cl-count-pending') ? flat(card('cl-count-pending')) : '?') +
        ' | 表=' + (card('cl-table') ? '在' : '无') +
        ' | 表行数=' + (card('cl-table') ? card('cl-table').querySelectorAll('tbody tr').length : -1) +
        ' | 开关=' + String(window.__noPendingOrders) +
        ' | 分页=' + (card('cl-pager') ? flat(card('cl-pager')) : '无'));
    window.__noPendingOrders = false;
    // ⚠️ 2026-10-28 必须清掉"本次会话已被核对"的 id 集合，才谈得上"数据回来"：
    //    上面那段把 41/42/43/44/45 **全部**走到已核对（保存 + 单行确认 + 批量确认），
    //    而夹具的 orderList 是按这个集合算状态的 ⇒ 清零后待核对一条都不剩，表格当然回不来。
    //    （改前那条「全部确认无误」发的是 {all:true}，夹具的数组分支不记 id，44 因此**漏网**，
    //     列表"侥幸"还有一行 —— 这种"靠漏网才能通过"的夹具状态正是要清掉的东西。）
    window.__correctedIds = [];
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
    // 出口是**可点**的下一步（提示不是入口：空态说明里的下一步必须点得到）。
    // ⚠️ 两件事一起验：按钮在 + **它真的到得了**（看不见的按钮点了等于没点；只验在不在会漏"点了没反应"）。
    // ⚠️ 2026-10-12 起是**三个**出口：第三个「看已核对的 N 行」是**往后走**（核对完了发现漏/错了）。
    // ⚠️ 2026-10-17：第一个出口改成**真跳「统计」模块**（算钱撤出发货台后本页没有那个页签了），
    //    另两个仍是本页动作 —— 所以判据从"都切页签"改成"第一个必须派发 switch-module"。
    report('「都核对完了」空态给三个可点出口：去「统计」看利润 + 去看要拿什么（第 3 步）+ 看已核对的行',
      !!card('cl-goto-cost') && !!card('cl-goto-purchase') && !!card('cl-goto-corrected') &&
        !card('cl-goto-import') && flat(card('cl-goto-cost')).indexOf('统计') >= 0,
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
    // 去「统计」= 真跳模块（本步只验"确实切到了哪个模块" —— 统计页自己长什么样由 order-profit:ui 钉）。
    // ⚠️ 切模块是**异步**的（外壳 await pm.activate）：必须等目标页真的挂上（.oc-view）再切回来，
    //    否则两次 activate 会互相覆盖 —— 第一次跑这份脚本时就是立刻 dispatch 回去，
    //    结果 order-cost 后到、把 today 顶掉，后面全线 timeout。
    var goCostBefore = evts('switch-module').length;
    card('cl-goto-cost').click();
    var jumpedTo = '';
    var okJump = true;
    try {
      await waitFor(function () {
        jumpedTo = ((evts('switch-module')[goCostBefore] || {}).detail || {}).moduleId || '';
        return jumpedTo === 'order-cost' && !!document.querySelector('.oc-view');
      }, 10000);
    } catch (e) { okJump = false; }
    report('点「去「统计」看利润」真的跳「统计」模块（moduleId=order-cost，且目标页挂上了）',
      okJump && jumpedTo === 'order-cost', 'moduleId=' + (jumpedTo || '(没派发)'));
    // 回到本页继续后面的断言（回程同样等 today 真的挂上 —— 判据双向）
    window.dispatchEvent(new CustomEvent('switch-module', { detail: { moduleId: 'today' } }));
    await waitFor(function () {
      return !!document.querySelector('.td-view') && !!document.querySelector('[data-act="tab-classify"]') &&
        !document.querySelector('.oc-view');
    }, 10000);
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
    // 表格放到 96px 仍看不清印花/领型 ⇒ 与「货品档案」同一套模式：点开读原图（不缩放）。
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
    report('已核对空态的出口是**回到待核对**（而不是"去统计"那套往前走的话术）',
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

    // ---- 几何守卫（2026-10-28 用户报「归类核对页面展示不全」）----
    // 病根：本页根（cl-view）是 height:100% 的**定高弹性列**，直接子项默认可缩。
    //   命名板（P3）插进来之后，核对表成了唯一"可缩"的那一项 ——
    //   实测被压到 55px、表格容器 0px，而页面 scrollHeight 与 clientHeight 相等
    //   （**没有滚动条**）⇒ 表格整块消失、想滚也滚不到。
    // ⚠️ 这是"DOM 都在、界面上什么都没有"的病：cl-table 存在、tr 有 7 行、
    //    存在性断言一条都不会红 —— 只有几何抓得住（与 puTileGuard 同一种病）。
    var clViewEl = document.querySelector('.cl-view');
    var clListEl = document.querySelector('.cl-list');
    var clTableWrap = clListEl ? clListEl.querySelector('.wb-table-wrap') : null;
    function clRows() { return queryAll('.cl-table tbody tr'); }
    report('核对表有地板高度（不是被弹性列压成一条）',
      !!clListEl && clListEl.clientHeight >= 300,
      'clList=' + (clListEl ? clListEl.clientHeight + ' 可见 / ' + clListEl.scrollHeight + ' 内容' : '无'));
    report('表格容器看得见（可见高度 > 一行，不是被压到 0）',
      !!clTableWrap && clTableWrap.clientHeight >= 100,
      'wrap=' + (clTableWrap ? clTableWrap.clientHeight + ' 可见 / ' + clTableWrap.scrollHeight + ' 内容' : '无'));
    // 页面滚得动：内容比容器高时，滚到底必须真的移动 —— 压扁时两者相等，滚不动就是滚不动
    var clScrollable = !!clViewEl && clViewEl.scrollHeight > clViewEl.clientHeight + 1;
    var clTopAfter = -1;
    if (clViewEl) {
      clViewEl.scrollTop = 99999;
      await new Promise(function (r) { setTimeout(r, 250); });
      clTopAfter = clViewEl.scrollTop;
    }
    report('内容超出时页面**滚得动**（滚到底 scrollTop > 0；被压扁时内容与容器等高⇒滚不动）',
      !clScrollable || clTopAfter > 0,
      'overflow=' + clScrollable + ' scrollTop=' + clTopAfter +
        ' (' + (clViewEl ? clViewEl.scrollHeight + '/' + clViewEl.clientHeight : '?') + ')');
    // 最后一行**滚得到、点得到**：整页滚 + 表格内滚之后，它必须落在视口里
    var lastRow = clRows()[clRows().length - 1];
    if (lastRow) {
      lastRow.scrollIntoView({ block: 'nearest', inline: 'nearest' });
      await new Promise(function (r) { setTimeout(r, 250); });
      var lr = lastRow.getBoundingClientRect();
      var hitEl = document.elementFromPoint(lr.left + 20, lr.top + lr.height / 2);
      report('表格最后一行滚得到、点得到（不被裁在看不见的地方）',
        !!hitEl && (hitEl === lastRow || lastRow.contains(hitEl)),
        'hit=' + (hitEl ? String(hitEl.getAttribute('data-act') || hitEl.className || hitEl.tagName).slice(0, 40) : 'null'));
    } else {
      report('表格最后一行滚得到、点得到（不被裁在看不见的地方）', false, 'no-row');
    }
    if (clViewEl) clViewEl.scrollTop = 0;

    // ~~产品维度（指标条那一格）的"显示 0 / 整格隐藏"两条断言~~
    // **已随指标条整条撤掉（2026-10-10）**：那一格连同它上面那排「待核对 / 未归类 / 识别库」
    // 一起被用户判为"看不懂"，取数通道 orderSkuRollup 也整条退场（handler / preload / types /
    // ipc / classify / product-db 一并删）。它"不在了"的守卫在上面的 ① 段里（页头没那排 +
    // 渲染层一次都没读那个键）。**别只把这两条断言注释掉、却把通道留着** —— 那会变成
    // "每次进页面白跑一次往返、且没有任何断言看得见"。

    step('parcel');
    // 拆包（阶段 B2）：行内「拆包 ×N」→ 抽屉 → 超拆被拒后回读 → 新建包裹。
    // 这一段专治"点了有反应、其实没接上"：抽屉开出来**不算数**，必须断言出参里的订单号
    // 与"被拒之后有没有回读"（那是拆分交互唯一会假成功的地方）。
    var parcelBtn = document.querySelector('[data-act^="cl-parcel-"]');
    report('行内「拆包」入口在（已核对 / 待核对两个范围都给）', !!parcelBtn, parcelBtn ? flat(parcelBtn) : '无');
    report('「拆包 ×N」徽标读到各单包数（假桥回 2 ⇒ 文案带 ×2）',
      !!parcelBtn && flat(parcelBtn).indexOf('×2') >= 0, parcelBtn ? flat(parcelBtn) : '');
    if (parcelBtn) {
      parcelBtn.click();
      var okDrawer = true;
      try { await waitFor(function () { return !!card('pd-drawer'); }, 8000); } catch (e) { okDrawer = false; }
      report('点行内「拆包」真的开出抽屉', okDrawer, okDrawer ? 'pd-drawer 在' : 'timeout');
      report('抽屉按这行所属的**订单号**取整单（出参不是空串）',
        calls('orderParcelDetail').length > 0 && !!calls('orderParcelDetail')[0].orderNo,
        JSON.stringify(calls('orderParcelDetail').slice(0, 1)));
      report('抽屉页头带汇总（2 包 · 运费 ¥30.00 = 两包各 15 元）',
        flat(card('pd-totals')).indexOf('2 包') >= 0 && flat(card('pd-totals')).indexOf('30.00') >= 0,
        flat(card('pd-totals')));
      // 超拆：桩在 qty > 1 时回 error ⇒ 界面必须显示理由**并回读**（不能停在"看起来改成了"）
      var detailBefore = calls('orderParcelDetail').length;
      setInput('pd-line-qty-1', '2');
      var okErr = true;
      try { await waitFor(function () { return !!card('pd-error'); }, 8000); } catch (e) { okErr = false; }
      report('超拆被拒：把拒绝理由显示出来（不是静默失败）',
        okErr && flat(card('pd-error')).indexOf('最多还能放') >= 0,
        okErr ? flat(card('pd-error')) : 'timeout');
      report('超拆被拒后**回读整单**（界面不停在假状态）',
        calls('orderParcelDetail').length > detailBefore,
        'before=' + detailBefore + ' after=' + calls('orderParcelDetail').length);
      await clickReady('pd-new');
      var okMore = true;
      try { await waitFor(function () { return flat(card('pd-totals')).indexOf('3 包') >= 0; }, 8000); } catch (e) { okMore = false; }
      report('「新建包裹」真的落库并重绘（2 包 → 3 包，出参带单号）',
        okMore && calls('orderParcelCreate').length > 0 && !!calls('orderParcelCreate')[0].orderNo,
        '3包=' + (flat(card('pd-totals')).indexOf('3 包') >= 0) +
          ' create=' + JSON.stringify(calls('orderParcelCreate').slice(0, 1)));
      card('pd-close').click();
      var okClosed = true;
      try { await waitFor(function () { return !card('pd-drawer'); }, 8000); } catch (e) { okClosed = false; }
      report('「关闭」关掉抽屉（关掉后徽标会重算包数）', okClosed, '');
    }

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

    // ---- 厂家账清零：空态 + **步号钉死**（2026-10-11 修「第 5 步」→「第 4 步」；
    //     2026-10-17 算钱撤出后拿货又顺位成第 3 步，同一条断言跟着改 —— 这正是它存在的理由：
    //     步号是"跨页复制的字"，正文里改了流程顺序，别处那句就悄悄说错）----
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
    report('厂家账清零时给空态：账从哪来 + 出口指到第 3 步「拿货」（步号与实际一致）',
      okReconEmpty && reconEmpty.indexOf('第 3 步') >= 0 && reconEmpty.indexOf('拿货') >= 0 &&
        !!card('rc-goto-purchase'),
      reconEmpty);
    window.__noRecon = false;
    await clickRefresh();
    try { await waitFor(function () { return !!card('rc-table'); }, 8000); } catch (e) {}

    // ---- 采集状态条（T2-3）-----------------------------------------------------
    // ⚠️ 分段原则：**四种形态的文案/配色由单测覆盖**（tests/syncBanner.spec.ts，13 例），
    //    这里只验"接线对不对"——真的渲染出来、真的读 summary.sync、class 真的生效。
    //    原因是实测教训：五种形态各点一次刷新（每次一轮完整 reload）会把页面的虚拟时间预算
    //    撑爆，断言脚本没跑完就被 dump，输出在最后一条 PASS 处截断、grep FAIL 一条都没有 ——
    //    看起来像"全绿"，实际是没跑到。
    //
    // 这一段必须放在**最后**：它要切 __syncMode 并点刷新，会改变后面断言的运行环境。
    // （实测插在进度条断言之前时，总 PASS 数从 308 掉到 306：有两条断言走了另一条分支，
    //   覆盖被悄悄削掉而已有断言全绿，看不出来。）
    //
    // ⚠️ 但要先**切回「总览」**：前面几段最后停在「归类核对」页签上，状态条不在 DOM 里 ——
    //    漏这一步的后果是三条断言全红而文案是空的（文案= 色=(无)，看起来像"状态条没实现"）。
    await activateTab('overview');
    await waitSoft(function () { return !!card('sync-bar'); }, 4000);

    function syncBar() { return card('sync-bar'); }
    function syncHas(s) { return flat(syncBar()).indexOf(s) >= 0; }
    function syncTone() {
      var el = syncBar();
      if (!el) return '(无)';
      var hits = ['is-ok', 'is-warn', 'is-idle', 'is-error'].filter(function (c) {
        return el.className.indexOf(c) >= 0;
      });
      return hits.length ? hits.join(',') : '(无)';
    }

    // ① 正常态：初始加载用的就是 ok 桩（__syncMode 未设 ⇒ 桩默认 ok），不必刷新
    report('状态条正常态：说清"抓了几条、入库几条"，且不染警示色',
      syncHas('抓 3 条') && syncHas('入库 3') && syncTone() === 'is-ok',
      '文案=' + flat(syncBar()) + ' 色=' + syncTone());

    // ② 同步失败：整条染红 + 原话给原因（不翻译）；且绝不许说成"今天没单"
    //
    // ⚠️ 等待条件必须是「这一次 IPC 真的被调用」而**不是**「文案变成 X」：
    //    等文案的话，刷新没发生时也只会等满超时然后拿旧文案去断言 —— 失败信息指向"文案不对"，
    //    而真实原因是"根本没刷新"（实测就踩过一次：detail 里显示的还是上一次的文案）。
    window.__syncMode = 'fail';
    var nFail = calls('mangoSyncStatus').length;
    await clickRefresh();
    await waitSoft(function () { return calls('mangoSyncStatus').length > nFail; }, 8000);
    report('同步失败：整条染红 + 把**原始原因**给出来（不翻译成"同步异常"）',
      syncTone() === 'is-error' && syncHas('芒果说共 12 单') && syncHas('登录过期'),
      '文案=' + flat(syncBar()) + ' 色=' + syncTone() + ' 调用=' + calls('mangoSyncStatus').length);
    report('同步失败时不许说成"今天没单"（那正是这个功能要消灭的歧义）',
      flat(syncBar()).indexOf('没有订单') < 0 && flat(syncBar()).indexOf('没单') < 0,
      '文案=' + flat(syncBar()));

    // ③ 「读不到日志」与「没同步过」必须分开说（两件事要做的事完全不同）
    window.__syncMode = 'readfail';
    var nRead = calls('mangoSyncStatus').length;
    await clickRefresh();
    await waitSoft(function () { return calls('mangoSyncStatus').length > nRead; }, 8000);
    report('读不到日志 ≠ 没同步过（两件事要做的事完全不同，必须分开说）',
      syncTone() === 'is-error' && syncHas('读不到同步状态') && !syncHas('还没同步过'),
      '文案=' + flat(syncBar()) + ' 色=' + syncTone() + ' 调用=' + calls('mangoSyncStatus').length);

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
  // ⚠️ `--virtual-time-budget` 是**整页虚拟时间预算**：断言脚本没跑完就会被 dump，
  //    而症状极其像"全绿"——输出在最后一条 PASS 处**截断**、`SMOKE: ALL PASS` 没出现、
  //    `grep FAIL` 一条都没有。判断"跑完了没"的唯一可靠标志是**输出里有没有 SMOKE: 收尾行**。
  //    2026-11-01：加了几个"切桩 + 点刷新"的断言后 45s 不够用了（那几段每轮都是一次完整 reload），
  //    提到 90s。以后再往里加会点刷新的断言时，先看这一行。
  const cp = spawn(CHROME, ['--headless=new', '--disable-gpu', '--no-sandbox', '--virtual-time-budget=90000', '--dump-dom', `http://127.0.0.1:${PORT}/index.html`]);
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
