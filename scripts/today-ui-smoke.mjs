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
  window.__emptyOrders = false;
  // 空态开关（默认关闭 = 有数据）：__noGap / __noPurchaseOrders / __noPendingOrders / __noShopAlloc
  window.__noGap = false;
  window.__noPurchaseOrders = false;
  window.__noPendingOrders = false;
  window.__noShopAlloc = false;

  var IMPORTED = [{
    id: 1, orderNo: 'I-1', source: 'import', shop: '店A', orderTime: daysAgo(1) + ' 10:00:00',
    styleCode: 'S1', styleColor: '红', color: '黑', size: 'L', itemId: 'ITEM1',
    supplierId: 7, supplierName: '厂A', amountCents: 16518, vatCents: 3469, ddpCents: 2294,
    taxPlatform: '平台已税', bizStatus: '等待发货', rawFields: { '商品信息': '【1】 某款 (商品数量:1 piece)' },
  }];
  var COLLECTED = [{
    id: 9001, orderNo: 'C-1', source: 'collect', shop: '', orderTime: daysAgo(2) + ' 09:00:00',
    styleCode: '', styleColor: '', color: '白', size: 'M', itemId: '',
    supplierId: 0, supplierName: '', qty: 2, amountCents: 20000,
    vatCents: null, ddpCents: null, taxPlatform: '', bizStatus: '等待发货', rawFields: {},
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
  ];
  // 待拿货缺口：一行，粒度 = 款色码（与宿主 outstanding() 一致）
  var GAPS = [
    { styleCode: 'S1', styleName: '款一', color: '黑', size: 'L', demand: 2, taken: 0, missing: 2 },
  ];
  var IGNORES = [
    { styleCode: 'S9', color: '蓝', reason: '已线下拿', createdAt: '2026-10-01 10:00:00' },
  ];
  // 拿货单：一张草稿（明细，2 件 × 60.00 = 120.00）+ 一张已提交（包价 500.00）
  var PURCHASE_ORDERS = [
    { id: 3, supplierId: 7, supplierName: '厂A', bizDate: '2026-10-05', mode: 'detail', status: 'draft',
      totalCents: 12000, note: '首单', editedAt: null, createdAt: '2026-10-05 09:00:00',
      items: [{ id: 1, styleCode: 'S1', styleName: '款一', color: '黑', size: 'L', qty: 2,
        priceCents: 6000, amountCents: 12000, suggestionQty: 2 }] },
    { id: 2, supplierId: 8, supplierName: '厂B', bizDate: '2026-10-04', mode: 'package', status: 'submitted',
      totalCents: 50000, note: '', editedAt: null, createdAt: '2026-10-04 09:00:00', items: [] },
  ];

  // ---- 对账域夹具（2026-10-05「结算对账」页签内建）----
  // 两行账**故意不同型**：厂A 欠 40.00（拿货 120 / 已付 80）、厂B 欠 520.00（拿货 500 / 退 20）
  //  ⇒ 四个合计（620 / 80 / 20 / 560）都**不等于任一单行** —— 实现若只显示最后一行，断言会红。
  var RECON = [
    { supplierId: 7, supplierName: '厂A', purchaseCents: 12000, paidCents: 8000, refundCents: 0,
      balanceCents: 4000, orderCount: 1, paymentCount: 1 },
    { supplierId: 8, supplierName: '厂B', purchaseCents: 50000, paidCents: 0, refundCents: 2000,
      balanceCents: 52000, orderCount: 1, paymentCount: 1 },
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

  // ---- 归类核对域夹具（2026-10-05「归类核对」页签内建）----
  // ⚠️ 四条**故意各缺一样**，让每个判据**各自独立可观测**（只放"唯一可选项"等于没测）：
  //    · P-41：有图 + 未归类 → 「未归类」计数 + 缩略图合批都该算上它；
  //    · P-42：有图 + **已归类** → 「归属款」下拉必须选中**它自己的款**（默认值不靠位置）；
  //    · P-43：**无图** + 未归类 + **没有商品ID** → 无图行不该进缩略图合批（进了就白跑一次往返，
  //      而"少带一条"与"带对了"在调用数上完全看不出区别）；
  //    · P-44：有图 + 未归类 + **自己的商品ID**（店B / IT-B，本页只此一行）。
  //    P-41 与 P-42 是**同一家店的同一个商品ID**（店A / IT-A）⇒ 这两行要标「同商品 ×2」。
  //    ⭐ 「同商品」「独占商品」「没有商品ID」三种情况必须**各有一行**：
  //       只有"两条同商品 + 一条无商品ID"时，「有商品ID 就标」这种错法也能全绿
  //       （缺的正是 P-44 这样的"有商品ID 但只此一行"——它不该有徽标）。
  var PENDING_ORDERS = [
    { id: 41, imageId: 401, orderNo: 'P-41', shop: '店A', size: 'L', orderTime: '2026-10-04 10:00:00',
      category: 'T恤', color: '黑', logo: '', styleCode: '', styleName: '', styleColor: '',
      localPath: '/tmp/p41.jpg', fingerprint: 'fp41', features: ['圆领', '短袖'],
      itemId: 'IT-A',
      corrected: false, rawFields: { '商品ID': 'IT-A' } },
    { id: 42, imageId: 402, orderNo: 'P-42', shop: '店A', size: 'M', orderTime: '2026-10-04 11:00:00',
      category: '裤子', color: '白', logo: '', styleCode: 'S1', styleName: '款一', styleColor: 'S1-白',
      localPath: '/tmp/p42.jpg', fingerprint: 'fp42', features: [],
      itemId: 'IT-A',
      corrected: false, rawFields: { '商品ID': 'IT-A' } },
    { id: 43, imageId: null, orderNo: 'P-43', shop: '店C', size: 'S', orderTime: '2026-10-04 12:00:00',
      category: '帽子', color: '灰', logo: '', styleCode: '', styleName: '', styleColor: '',
      localPath: '', fingerprint: '', features: [],
      itemId: '',
      corrected: false, rawFields: {} },
    { id: 44, imageId: 404, orderNo: 'P-44', shop: '店B', size: 'XL', orderTime: '2026-10-04 13:00:00',
      category: '外套', color: '蓝', logo: '', styleCode: '', styleName: '', styleColor: '',
      localPath: '/tmp/p44.jpg', fingerprint: 'fp44', features: ['连帽'],
      itemId: 'IT-B',
      corrected: false, rawFields: { '商品ID': 'IT-B' } },
  ];
  // 识别库两行（款编码列表）—— 行内"归属款"下拉的数据源
  var STYLES = [
    { id: 5, code: 'S1', name: '款一', fingerprint: 'fp1', colorCount: 1, imageCount: 1, orderCount: 2, colors: [] },
    { id: 6, code: 'S2', name: '款二', fingerprint: 'fp2', colorCount: 0, imageCount: 0, orderCount: 0, colors: [] },
  ];

  window.__importKind = 'weights';   // 切到 'junk' 时返回一份认不出的表
  var XLSX_WEIGHTS_B64 = 'UEsDBBQAAAAAAAAAAACkAYS4tQIAALUCAAAaAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+DQo8UmVsYXRpb25zaGlwcyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzIj48UmVsYXRpb25zaGlwIElkPSJySWQxIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3dvcmtzaGVldCIgVGFyZ2V0PSJ3b3Jrc2hlZXRzL3NoZWV0MS54bWwiLz48UmVsYXRpb25zaGlwIElkPSJySWQyIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3RoZW1lIiBUYXJnZXQ9InRoZW1lL3RoZW1lMS54bWwiLz48UmVsYXRpb25zaGlwIElkPSJySWQzIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3N0eWxlcyIgVGFyZ2V0PSJzdHlsZXMueG1sIi8+PFJlbGF0aW9uc2hpcCBJZD0icklkNCIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9zaGVldE1ldGFkYXRhIiBUYXJnZXQ9Im1ldGFkYXRhLnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAAAAAADAPiGveHQAA3h0AABMAAAB4bC90aGVtZS90aGVtZTEueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPGE6dGhlbWUgeG1sbnM6YT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL2RyYXdpbmdtbC8yMDA2L21haW4iIG5hbWU9Ik9mZmljZSBUaGVtZSI+PGE6dGhlbWVFbGVtZW50cz48YTpjbHJTY2hlbWUgbmFtZT0iT2ZmaWNlIj48YTpkazE+PGE6c3lzQ2xyIHZhbD0id2luZG93VGV4dCIgbGFzdENscj0iMDAwMDAwIi8+PC9hOmRrMT48YTpsdDE+PGE6c3lzQ2xyIHZhbD0id2luZG93IiBsYXN0Q2xyPSJGRkZGRkYiLz48L2E6bHQxPjxhOmRrMj48YTpzcmdiQ2xyIHZhbD0iMUY0OTdEIi8+PC9hOmRrMj48YTpsdDI+PGE6c3JnYkNsciB2YWw9IkVFRUNFMSIvPjwvYTpsdDI+PGE6YWNjZW50MT48YTpzcmdiQ2xyIHZhbD0iNEY4MUJEIi8+PC9hOmFjY2VudDE+PGE6YWNjZW50Mj48YTpzcmdiQ2xyIHZhbD0iQzA1MDREIi8+PC9hOmFjY2VudDI+PGE6YWNjZW50Mz48YTpzcmdiQ2xyIHZhbD0iOUJCQjU5Ii8+PC9hOmFjY2VudDM+PGE6YWNjZW50ND48YTpzcmdiQ2xyIHZhbD0iODA2NEEyIi8+PC9hOmFjY2VudDQ+PGE6YWNjZW50NT48YTpzcmdiQ2xyIHZhbD0iNEJBQ0M2Ii8+PC9hOmFjY2VudDU+PGE6YWNjZW50Nj48YTpzcmdiQ2xyIHZhbD0iRjc5NjQ2Ii8+PC9hOmFjY2VudDY+PGE6aGxpbms+PGE6c3JnYkNsciB2YWw9IjAwMDBGRiIvPjwvYTpobGluaz48YTpmb2xIbGluaz48YTpzcmdiQ2xyIHZhbD0iODAwMDgwIi8+PC9hOmZvbEhsaW5rPjwvYTpjbHJTY2hlbWU+PGE6Zm9udFNjaGVtZSBuYW1lPSJPZmZpY2UiPjxhOm1ham9yRm9udD48YTpsYXRpbiB0eXBlZmFjZT0iQ2FtYnJpYSIvPjxhOmVhIHR5cGVmYWNlPSIiLz48YTpjcyB0eXBlZmFjZT0iIi8+PGE6Zm9udCBzY3JpcHQ9IkpwYW4iIHR5cGVmYWNlPSLvvK3vvLMg77yw44K044K344OD44KvIi8+PGE6Zm9udCBzY3JpcHQ9IkhhbmciIHR5cGVmYWNlPSLrp5HsnYAg6rOg65SVIi8+PGE6Zm9udCBzY3JpcHQ9IkhhbnMiIHR5cGVmYWNlPSLlrovkvZMiLz48YTpmb250IHNjcmlwdD0iSGFudCIgdHlwZWZhY2U9IuaWsOe0sOaYjumrlCIvPjxhOmZvbnQgc2NyaXB0PSJBcmFiIiB0eXBlZmFjZT0iVGltZXMgTmV3IFJvbWFuIi8+PGE6Zm9udCBzY3JpcHQ9IkhlYnIiIHR5cGVmYWNlPSJUaW1lcyBOZXcgUm9tYW4iLz48YTpmb250IHNjcmlwdD0iVGhhaSIgdHlwZWZhY2U9IlRhaG9tYSIvPjxhOmZvbnQgc2NyaXB0PSJFdGhpIiB0eXBlZmFjZT0iTnlhbGEiLz48YTpmb250IHNjcmlwdD0iQmVuZyIgdHlwZWZhY2U9IlZyaW5kYSIvPjxhOmZvbnQgc2NyaXB0PSJHdWpyIiB0eXBlZmFjZT0iU2hydXRpIi8+PGE6Zm9udCBzY3JpcHQ9IktobXIiIHR5cGVmYWNlPSJNb29sQm9yYW4iLz48YTpmb250IHNjcmlwdD0iS25kYSIgdHlwZWZhY2U9IlR1bmdhIi8+PGE6Zm9udCBzY3JpcHQ9Ikd1cnUiIHR5cGVmYWNlPSJSYWF2aSIvPjxhOmZvbnQgc2NyaXB0PSJDYW5zIiB0eXBlZmFjZT0iRXVwaGVtaWEiLz48YTpmb250IHNjcmlwdD0iQ2hlciIgdHlwZWZhY2U9IlBsYW50YWdlbmV0IENoZXJva2VlIi8+PGE6Zm9udCBzY3JpcHQ9IllpaWkiIHR5cGVmYWNlPSJNaWNyb3NvZnQgWWkgQmFpdGkiLz48YTpmb250IHNjcmlwdD0iVGlidCIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBIaW1hbGF5YSIvPjxhOmZvbnQgc2NyaXB0PSJUaGFhIiB0eXBlZmFjZT0iTVYgQm9saSIvPjxhOmZvbnQgc2NyaXB0PSJEZXZhIiB0eXBlZmFjZT0iTWFuZ2FsIi8+PGE6Zm9udCBzY3JpcHQ9IlRlbHUiIHR5cGVmYWNlPSJHYXV0YW1pIi8+PGE6Zm9udCBzY3JpcHQ9IlRhbWwiIHR5cGVmYWNlPSJMYXRoYSIvPjxhOmZvbnQgc2NyaXB0PSJTeXJjIiB0eXBlZmFjZT0iRXN0cmFuZ2VsbyBFZGVzc2EiLz48YTpmb250IHNjcmlwdD0iT3J5YSIgdHlwZWZhY2U9IkthbGluZ2EiLz48YTpmb250IHNjcmlwdD0iTWx5bSIgdHlwZWZhY2U9IkthcnRpa2EiLz48YTpmb250IHNjcmlwdD0iTGFvbyIgdHlwZWZhY2U9IkRva0NoYW1wYSIvPjxhOmZvbnQgc2NyaXB0PSJTaW5oIiB0eXBlZmFjZT0iSXNrb29sYSBQb3RhIi8+PGE6Zm9udCBzY3JpcHQ9Ik1vbmciIHR5cGVmYWNlPSJNb25nb2xpYW4gQmFpdGkiLz48YTpmb250IHNjcmlwdD0iVmlldCIgdHlwZWZhY2U9IlRpbWVzIE5ldyBSb21hbiIvPjxhOmZvbnQgc2NyaXB0PSJVaWdoIiB0eXBlZmFjZT0iTWljcm9zb2Z0IFVpZ2h1ciIvPjxhOmZvbnQgc2NyaXB0PSJHZW9yIiB0eXBlZmFjZT0iU3lsZmFlbiIvPjwvYTptYWpvckZvbnQ+PGE6bWlub3JGb250PjxhOmxhdGluIHR5cGVmYWNlPSJDYWxpYnJpIi8+PGE6ZWEgdHlwZWZhY2U9IiIvPjxhOmNzIHR5cGVmYWNlPSIiLz48YTpmb250IHNjcmlwdD0iSnBhbiIgdHlwZWZhY2U9Iu+8re+8syDvvLDjgrTjgrfjg4Pjgq8iLz48YTpmb250IHNjcmlwdD0iSGFuZyIgdHlwZWZhY2U9IuunkeydgCDqs6DrlJUiLz48YTpmb250IHNjcmlwdD0iSGFucyIgdHlwZWZhY2U9IuWui+S9kyIvPjxhOmZvbnQgc2NyaXB0PSJIYW50IiB0eXBlZmFjZT0i5paw57Sw5piO6auUIi8+PGE6Zm9udCBzY3JpcHQ9IkFyYWIiIHR5cGVmYWNlPSJBcmlhbCIvPjxhOmZvbnQgc2NyaXB0PSJIZWJyIiB0eXBlZmFjZT0iQXJpYWwiLz48YTpmb250IHNjcmlwdD0iVGhhaSIgdHlwZWZhY2U9IlRhaG9tYSIvPjxhOmZvbnQgc2NyaXB0PSJFdGhpIiB0eXBlZmFjZT0iTnlhbGEiLz48YTpmb250IHNjcmlwdD0iQmVuZyIgdHlwZWZhY2U9IlZyaW5kYSIvPjxhOmZvbnQgc2NyaXB0PSJHdWpyIiB0eXBlZmFjZT0iU2hydXRpIi8+PGE6Zm9udCBzY3JpcHQ9IktobXIiIHR5cGVmYWNlPSJEYXVuUGVuaCIvPjxhOmZvbnQgc2NyaXB0PSJLbmRhIiB0eXBlZmFjZT0iVHVuZ2EiLz48YTpmb250IHNjcmlwdD0iR3VydSIgdHlwZWZhY2U9IlJhYXZpIi8+PGE6Zm9udCBzY3JpcHQ9IkNhbnMiIHR5cGVmYWNlPSJFdXBoZW1pYSIvPjxhOmZvbnQgc2NyaXB0PSJDaGVyIiB0eXBlZmFjZT0iUGxhbnRhZ2VuZXQgQ2hlcm9rZWUiLz48YTpmb250IHNjcmlwdD0iWWlpaSIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBZaSBCYWl0aSIvPjxhOmZvbnQgc2NyaXB0PSJUaWJ0IiB0eXBlZmFjZT0iTWljcm9zb2Z0IEhpbWFsYXlhIi8+PGE6Zm9udCBzY3JpcHQ9IlRoYWEiIHR5cGVmYWNlPSJNViBCb2xpIi8+PGE6Zm9udCBzY3JpcHQ9IkRldmEiIHR5cGVmYWNlPSJNYW5nYWwiLz48YTpmb250IHNjcmlwdD0iVGVsdSIgdHlwZWZhY2U9IkdhdXRhbWkiLz48YTpmb250IHNjcmlwdD0iVGFtbCIgdHlwZWZhY2U9IkxhdGhhIi8+PGE6Zm9udCBzY3JpcHQ9IlN5cmMiIHR5cGVmYWNlPSJFc3RyYW5nZWxvIEVkZXNzYSIvPjxhOmZvbnQgc2NyaXB0PSJPcnlhIiB0eXBlZmFjZT0iS2FsaW5nYSIvPjxhOmZvbnQgc2NyaXB0PSJNbHltIiB0eXBlZmFjZT0iS2FydGlrYSIvPjxhOmZvbnQgc2NyaXB0PSJMYW9vIiB0eXBlZmFjZT0iRG9rQ2hhbXBhIi8+PGE6Zm9udCBzY3JpcHQ9IlNpbmgiIHR5cGVmYWNlPSJJc2tvb2xhIFBvdGEiLz48YTpmb250IHNjcmlwdD0iTW9uZyIgdHlwZWZhY2U9Ik1vbmdvbGlhbiBCYWl0aSIvPjxhOmZvbnQgc2NyaXB0PSJWaWV0IiB0eXBlZmFjZT0iQXJpYWwiLz48YTpmb250IHNjcmlwdD0iVWlnaCIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBVaWdodXIiLz48YTpmb250IHNjcmlwdD0iR2VvciIgdHlwZWZhY2U9IlN5bGZhZW4iLz48L2E6bWlub3JGb250PjwvYTpmb250U2NoZW1lPjxhOmZtdFNjaGVtZSBuYW1lPSJPZmZpY2UiPjxhOmZpbGxTdHlsZUxzdD48YTpzb2xpZEZpbGw+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiLz48L2E6c29saWRGaWxsPjxhOmdyYWRGaWxsIHJvdFdpdGhTaGFwZT0iMSI+PGE6Z3NMc3Q+PGE6Z3MgcG9zPSIwIj48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6dGludCB2YWw9IjUwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMzAwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PGE6Z3MgcG9zPSIzNTAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSIzNzAwMCIvPjxhOnNhdE1vZCB2YWw9IjMwMDAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOmdzPjxhOmdzIHBvcz0iMTAwMDAwIj48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6dGludCB2YWw9IjE1MDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOmxpbiBhbmc9IjE2MjAwMDAwIiBzY2FsZWQ9IjEiLz48L2E6Z3JhZEZpbGw+PGE6Z3JhZEZpbGwgcm90V2l0aFNoYXBlPSIxIj48YTpnc0xzdD48YTpncyBwb3M9IjAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iMTAwMDAwIi8+PGE6c2hhZGUgdmFsPSIxMDAwMDAiLz48YTpzYXRNb2QgdmFsPSIxMzAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48YTpncyBwb3M9IjEwMDAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSI1MDAwMCIvPjxhOnNoYWRlIHZhbD0iMTAwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOmxpbiBhbmc9IjE2MjAwMDAwIiBzY2FsZWQ9IjAiLz48L2E6Z3JhZEZpbGw+PC9hOmZpbGxTdHlsZUxzdD48YTpsblN0eWxlTHN0PjxhOmxuIHc9Ijk1MjUiIGNhcD0iZmxhdCIgY21wZD0ic25nIiBhbGduPSJjdHIiPjxhOnNvbGlkRmlsbD48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6c2hhZGUgdmFsPSI5NTAwMCIvPjxhOnNhdE1vZCB2YWw9IjEwNTAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOnNvbGlkRmlsbD48YTpwcnN0RGFzaCB2YWw9InNvbGlkIi8+PC9hOmxuPjxhOmxuIHc9IjI1NDAwIiBjYXA9ImZsYXQiIGNtcGQ9InNuZyIgYWxnbj0iY3RyIj48YTpzb2xpZEZpbGw+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiLz48L2E6c29saWRGaWxsPjxhOnByc3REYXNoIHZhbD0ic29saWQiLz48L2E6bG4+PGE6bG4gdz0iMzgxMDAiIGNhcD0iZmxhdCIgY21wZD0ic25nIiBhbGduPSJjdHIiPjxhOnNvbGlkRmlsbD48YTpzY2hlbWVDbHIgdmFsPSJwaENsciIvPjwvYTpzb2xpZEZpbGw+PGE6cHJzdERhc2ggdmFsPSJzb2xpZCIvPjwvYTpsbj48L2E6bG5TdHlsZUxzdD48YTplZmZlY3RTdHlsZUxzdD48YTplZmZlY3RTdHlsZT48YTplZmZlY3RMc3Q+PGE6b3V0ZXJTaGR3IGJsdXJSYWQ9IjQwMDAwIiBkaXN0PSIyMDAwMCIgZGlyPSI1NDAwMDAwIiByb3RXaXRoU2hhcGU9IjAiPjxhOnNyZ2JDbHIgdmFsPSIwMDAwMDAiPjxhOmFscGhhIHZhbD0iMzgwMDAiLz48L2E6c3JnYkNscj48L2E6b3V0ZXJTaGR3PjwvYTplZmZlY3RMc3Q+PC9hOmVmZmVjdFN0eWxlPjxhOmVmZmVjdFN0eWxlPjxhOmVmZmVjdExzdD48YTpvdXRlclNoZHcgYmx1clJhZD0iNDAwMDAiIGRpc3Q9IjIzMDAwIiBkaXI9IjU0MDAwMDAiIHJvdFdpdGhTaGFwZT0iMCI+PGE6c3JnYkNsciB2YWw9IjAwMDAwMCI+PGE6YWxwaGEgdmFsPSIzNTAwMCIvPjwvYTpzcmdiQ2xyPjwvYTpvdXRlclNoZHc+PC9hOmVmZmVjdExzdD48L2E6ZWZmZWN0U3R5bGU+PGE6ZWZmZWN0U3R5bGU+PGE6ZWZmZWN0THN0PjxhOm91dGVyU2hkdyBibHVyUmFkPSI0MDAwMCIgZGlzdD0iMjMwMDAiIGRpcj0iNTQwMDAwMCIgcm90V2l0aFNoYXBlPSIwIj48YTpzcmdiQ2xyIHZhbD0iMDAwMDAwIj48YTphbHBoYSB2YWw9IjM1MDAwIi8+PC9hOnNyZ2JDbHI+PC9hOm91dGVyU2hkdz48L2E6ZWZmZWN0THN0PjxhOnNjZW5lM2Q+PGE6Y2FtZXJhIHByc3Q9Im9ydGhvZ3JhcGhpY0Zyb250Ij48YTpyb3QgbGF0PSIwIiBsb249IjAiIHJldj0iMCIvPjwvYTpjYW1lcmE+PGE6bGlnaHRSaWcgcmlnPSJ0aHJlZVB0IiBkaXI9InQiPjxhOnJvdCBsYXQ9IjAiIGxvbj0iMCIgcmV2PSIxMjAwMDAwIi8+PC9hOmxpZ2h0UmlnPjwvYTpzY2VuZTNkPjxhOnNwM2Q+PGE6YmV2ZWxUIHc9IjYzNTAwIiBoPSIyNTQwMCIvPjwvYTpzcDNkPjwvYTplZmZlY3RTdHlsZT48L2E6ZWZmZWN0U3R5bGVMc3Q+PGE6YmdGaWxsU3R5bGVMc3Q+PGE6c29saWRGaWxsPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIi8+PC9hOnNvbGlkRmlsbD48YTpncmFkRmlsbCByb3RXaXRoU2hhcGU9IjEiPjxhOmdzTHN0PjxhOmdzIHBvcz0iMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSI0MDAwMCIvPjxhOnNhdE1vZCB2YWw9IjM1MDAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOmdzPjxhOmdzIHBvcz0iNDAwMDAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iNDUwMDAiLz48YTpzaGFkZSB2YWw9Ijk5MDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PGE6Z3MgcG9zPSIxMDAwMDAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTpzaGFkZSB2YWw9IjIwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMjU1MDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOnBhdGggcGF0aD0iY2lyY2xlIj48YTpmaWxsVG9SZWN0IGw9IjUwMDAwIiB0PSItODAwMDAiIHI9IjUwMDAwIiBiPSIxODAwMDAiLz48L2E6cGF0aD48L2E6Z3JhZEZpbGw+PGE6Z3JhZEZpbGwgcm90V2l0aFNoYXBlPSIxIj48YTpnc0xzdD48YTpncyBwb3M9IjAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iODAwMDAiLz48YTpzYXRNb2QgdmFsPSIzMDAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48YTpncyBwb3M9IjEwMDAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnNoYWRlIHZhbD0iMzAwMDAiLz48YTpzYXRNb2QgdmFsPSIyMDAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48L2E6Z3NMc3Q+PGE6cGF0aCBwYXRoPSJjaXJjbGUiPjxhOmZpbGxUb1JlY3QgbD0iNTAwMDAiIHQ9IjUwMDAwIiByPSI1MDAwMCIgYj0iNTAwMDAiLz48L2E6cGF0aD48L2E6Z3JhZEZpbGw+PC9hOmJnRmlsbFN0eWxlTHN0PjwvYTpmbXRTY2hlbWU+PC9hOnRoZW1lRWxlbWVudHM+PGE6b2JqZWN0RGVmYXVsdHM+PGE6c3BEZWY+PGE6c3BQci8+PGE6Ym9keVByLz48YTpsc3RTdHlsZS8+PGE6c3R5bGU+PGE6bG5SZWYgaWR4PSIxIj48YTpzY2hlbWVDbHIgdmFsPSJhY2NlbnQxIi8+PC9hOmxuUmVmPjxhOmZpbGxSZWYgaWR4PSIzIj48YTpzY2hlbWVDbHIgdmFsPSJhY2NlbnQxIi8+PC9hOmZpbGxSZWY+PGE6ZWZmZWN0UmVmIGlkeD0iMiI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTplZmZlY3RSZWY+PGE6Zm9udFJlZiBpZHg9Im1pbm9yIj48YTpzY2hlbWVDbHIgdmFsPSJsdDEiLz48L2E6Zm9udFJlZj48L2E6c3R5bGU+PC9hOnNwRGVmPjxhOmxuRGVmPjxhOnNwUHIvPjxhOmJvZHlQci8+PGE6bHN0U3R5bGUvPjxhOnN0eWxlPjxhOmxuUmVmIGlkeD0iMiI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTpsblJlZj48YTpmaWxsUmVmIGlkeD0iMCI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTpmaWxsUmVmPjxhOmVmZmVjdFJlZiBpZHg9IjEiPjxhOnNjaGVtZUNsciB2YWw9ImFjY2VudDEiLz48L2E6ZWZmZWN0UmVmPjxhOmZvbnRSZWYgaWR4PSJtaW5vciI+PGE6c2NoZW1lQ2xyIHZhbD0idHgxIi8+PC9hOmZvbnRSZWY+PC9hOnN0eWxlPjwvYTpsbkRlZj48L2E6b2JqZWN0RGVmYXVsdHM+PGE6ZXh0cmFDbHJTY2hlbWVMc3QvPjwvYTp0aGVtZT5QSwMEFAAAAAAAAAAAAFX0BJRaBAAAWgQAAA0AAAB4bC9zdHlsZXMueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPHN0eWxlU2hlZXQgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6dnQ9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L2RvY1Byb3BzVlR5cGVzIj48bnVtRm10cyBjb3VudD0iMSI+PG51bUZtdCBudW1GbXRJZD0iNTYiIGZvcm1hdENvZGU9IiZxdW90O+S4iuWNiC/kuIvljYggJnF1b3Q7aGgmcXVvdDvmmYImcXVvdDttbSZxdW90O+WIhiZxdW90O3NzJnF1b3Q756eSICZxdW90OyIvPjwvbnVtRm10cz48Zm9udHMgY291bnQ9IjEiPjxmb250PjxzeiB2YWw9IjEyIi8+PGNvbG9yIHRoZW1lPSIxIi8+PG5hbWUgdmFsPSJDYWxpYnJpIi8+PGZhbWlseSB2YWw9IjIiLz48c2NoZW1lIHZhbD0ibWlub3IiLz48L2ZvbnQ+PC9mb250cz48ZmlsbHMgY291bnQ9IjIiPjxmaWxsPjxwYXR0ZXJuRmlsbCBwYXR0ZXJuVHlwZT0ibm9uZSIvPjwvZmlsbD48ZmlsbD48cGF0dGVybkZpbGwgcGF0dGVyblR5cGU9ImdyYXkxMjUiLz48L2ZpbGw+PC9maWxscz48Ym9yZGVycyBjb3VudD0iMSI+PGJvcmRlcj48bGVmdC8+PHJpZ2h0Lz48dG9wLz48Ym90dG9tLz48ZGlhZ29uYWwvPjwvYm9yZGVyPjwvYm9yZGVycz48Y2VsbFN0eWxlWGZzIGNvdW50PSIxIj48eGYgbnVtRm10SWQ9IjAiIGZvbnRJZD0iMCIgZmlsbElkPSIwIiBib3JkZXJJZD0iMCIvPjwvY2VsbFN0eWxlWGZzPjxjZWxsWGZzIGNvdW50PSIxIj48eGYgbnVtRm10SWQ9IjAiIGZvbnRJZD0iMCIgZmlsbElkPSIwIiBib3JkZXJJZD0iMCIgeGZJZD0iMCIgYXBwbHlOdW1iZXJGb3JtYXQ9IjEiLz48L2NlbGxYZnM+PGNlbGxTdHlsZXMgY291bnQ9IjEiPjxjZWxsU3R5bGUgbmFtZT0iTm9ybWFsIiB4ZklkPSIwIiBidWlsdGluSWQ9IjAiLz48L2NlbGxTdHlsZXM+PGR4ZnMgY291bnQ9IjAiLz48dGFibGVTdHlsZXMgY291bnQ9IjAiIGRlZmF1bHRUYWJsZVN0eWxlPSJUYWJsZVN0eWxlTWVkaXVtOSIgZGVmYXVsdFBpdm90U3R5bGU9IlBpdm90U3R5bGVNZWRpdW00Ii8+PC9zdHlsZVNoZWV0PlBLAwQUAAAAAAAAAAAAYv+eYJsCAACbAgAAGAAAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4NCjx3b3Jrc2hlZXQgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6cj0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcyI+PGRpbWVuc2lvbiByZWY9IkExOkMyIi8+PHNoZWV0Vmlld3M+PHNoZWV0VmlldyB3b3JrYm9va1ZpZXdJZD0iMCIvPjwvc2hlZXRWaWV3cz48c2hlZXREYXRhPjxyb3cgcj0iMSI+PGMgcj0iQTEiIHQ9InN0ciI+PHY+5ZWG5ZOBSUQ8L3Y+PC9jPjxjIHI9IkIxIiB0PSJzdHIiPjx2PuS6p+WTgeWQjeensDwvdj48L2M+PGMgcj0iQzEiIHQ9InN0ciI+PHY+6YeN6YePKGcpPC92PjwvYz48L3Jvdz48cm93IHI9IjIiPjxjIHI9IkEyIiB0PSJzdHIiPjx2PklURU05PC92PjwvYz48YyByPSJCMiIgdD0ic3RyIj48dj7mn5DmrL7lpJblpZc8L3Y+PC9jPjxjIHI9IkMyIiB0PSJzdHIiPjx2PjMyMDwvdj48L2M+PC9yb3c+PC9zaGVldERhdGE+PGlnbm9yZWRFcnJvcnM+PGlnbm9yZWRFcnJvciBudW1iZXJTdG9yZWRBc1RleHQ9IjEiIHNxcmVmPSJBMTpDMiIvPjwvaWdub3JlZEVycm9ycz48L3dvcmtzaGVldD5QSwMEFAAAAAAAAAAAAGCAAIGIAwAAiAMAAA8AAAB4bC9tZXRhZGF0YS54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+DQo8bWV0YWRhdGEgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6eGxyZD0iaHR0cDovL3NjaGVtYXMubWljcm9zb2Z0LmNvbS9vZmZpY2Uvc3ByZWFkc2hlZXRtbC8yMDE3L3JpY2hkYXRhIiB4bWxuczp4ZGE9Imh0dHA6Ly9zY2hlbWFzLm1pY3Jvc29mdC5jb20vb2ZmaWNlL3NwcmVhZHNoZWV0bWwvMjAxNy9keW5hbWljYXJyYXkiPgogIDxtZXRhZGF0YVR5cGVzIGNvdW50PSIxIj4KICAgIDxtZXRhZGF0YVR5cGUgbmFtZT0iWExEQVBSIiBtaW5TdXBwb3J0ZWRWZXJzaW9uPSIxMjAwMDAiIGNvcHk9IjEiIHBhc3RlQWxsPSIxIiBwYXN0ZVZhbHVlcz0iMSIgbWVyZ2U9IjEiIHNwbGl0Rmlyc3Q9IjEiIHJvd0NvbFNoaWZ0PSIxIiBjbGVhckZvcm1hdHM9IjEiIGNsZWFyQ29tbWVudHM9IjEiIGFzc2lnbj0iMSIgY29lcmNlPSIxIiBjZWxsTWV0YT0iMSIvPgogIDwvbWV0YWRhdGFUeXBlcz4KICA8ZnV0dXJlTWV0YWRhdGEgbmFtZT0iWExEQVBSIiBjb3VudD0iMSI+CiAgICA8Yms+CiAgICAgIDxleHRMc3Q+CiAgICAgICAgPGV4dCB1cmk9IntiZGJiOGNkYy1mYTFlLTQ5NmUtYTg1Ny0zYzNmMzBjMDI5YzN9Ij4KICAgICAgICAgIDx4ZGE6ZHluYW1pY0FycmF5UHJvcGVydGllcyBmRHluYW1pYz0iMSIgZkNvbGxhcHNlZD0iMCIvPgogICAgICAgIDwvZXh0PgogICAgICA8L2V4dExzdD4KICAgIDwvYms+CiAgPC9mdXR1cmVNZXRhZGF0YT4KICA8Y2VsbE1ldGFkYXRhIGNvdW50PSIxIj4KICAgIDxiaz4KICAgICAgPHJjIHQ9IjEiIHY9IjAiLz4KICAgIDwvYms+CiAgPC9jZWxsTWV0YWRhdGE+CjwvbWV0YWRhdGE+UEsDBBQAAAAAAAAAAACYQ/HWSAEAAEgBAAAPAAAAeGwvd29ya2Jvb2sueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPHdvcmtib29rIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvc3ByZWFkc2hlZXRtbC8yMDA2L21haW4iIHhtbG5zOnI9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMiPjx3b3JrYm9va1ByIGNvZGVOYW1lPSJUaGlzV29ya2Jvb2siLz48c2hlZXRzPjxzaGVldCBuYW1lPSLllYblk4Hkv6Hmga8iIHNoZWV0SWQ9IjEiIHI6aWQ9InJJZDEiLz48L3NoZWV0cz48L3dvcmtib29rPlBLAwQUAAAAAAAAAAAASmoR+UwCAABMAgAACwAAAF9yZWxzLy5yZWxzPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPFJlbGF0aW9uc2hpcHMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcyI+PFJlbGF0aW9uc2hpcCBJZD0icklkMiIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzL21ldGFkYXRhL2NvcmUtcHJvcGVydGllcyIgVGFyZ2V0PSJkb2NQcm9wcy9jb3JlLnhtbCIvPjxSZWxhdGlvbnNoaXAgSWQ9InJJZDMiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvZXh0ZW5kZWQtcHJvcGVydGllcyIgVGFyZ2V0PSJkb2NQcm9wcy9hcHAueG1sIi8+PFJlbGF0aW9uc2hpcCBJZD0icklkMSIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9vZmZpY2VEb2N1bWVudCIgVGFyZ2V0PSJ4bC93b3JrYm9vay54bWwiLz48L1JlbGF0aW9uc2hpcHM+UEsDBBQAAAAAAAAAAACWdL84OAIAADgCAAAQAAAAZG9jUHJvcHMvYXBwLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4NCjxQcm9wZXJ0aWVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9leHRlbmRlZC1wcm9wZXJ0aWVzIiB4bWxuczp2dD0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvZG9jUHJvcHNWVHlwZXMiPjxBcHBsaWNhdGlvbj5TaGVldEpTPC9BcHBsaWNhdGlvbj48SGVhZGluZ1BhaXJzPjx2dDp2ZWN0b3Igc2l6ZT0iMiIgYmFzZVR5cGU9InZhcmlhbnQiPjx2dDp2YXJpYW50Pjx2dDpscHN0cj5Xb3Jrc2hlZXRzPC92dDpscHN0cj48L3Z0OnZhcmlhbnQ+PHZ0OnZhcmlhbnQ+PHZ0Omk0PjE8L3Z0Omk0PjwvdnQ6dmFyaWFudD48L3Z0OnZlY3Rvcj48L0hlYWRpbmdQYWlycz48VGl0bGVzT2ZQYXJ0cz48dnQ6dmVjdG9yIHNpemU9IjEiIGJhc2VUeXBlPSJscHN0ciI+PHZ0Omxwc3RyPuWVhuWTgeS/oeaBrzwvdnQ6bHBzdHI+PC92dDp2ZWN0b3I+PC9UaXRsZXNPZlBhcnRzPjwvUHJvcGVydGllcz5QSwMEFAAAAAAAAAAAANaSfBFaAQAAWgEAABEAAABkb2NQcm9wcy9jb3JlLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4NCjxjcDpjb3JlUHJvcGVydGllcyB4bWxuczpjcD0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9tZXRhZGF0YS9jb3JlLXByb3BlcnRpZXMiIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1sbnM6ZGN0ZXJtcz0iaHR0cDovL3B1cmwub3JnL2RjL3Rlcm1zLyIgeG1sbnM6ZGNtaXR5cGU9Imh0dHA6Ly9wdXJsLm9yZy9kYy9kY21pdHlwZS8iIHhtbG5zOnhzaT0iaHR0cDovL3d3dy53My5vcmcvMjAwMS9YTUxTY2hlbWEtaW5zdGFuY2UiLz5QSwMEFAAAAAAAAAAAAKjXaoAVCAAAFQgAABMAAABbQ29udGVudF9UeXBlc10ueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPFR5cGVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L2NvbnRlbnQtdHlwZXMiIHhtbG5zOnhzZD0iaHR0cDovL3d3dy53My5vcmcvMjAwMS9YTUxTY2hlbWEiIHhtbG5zOnhzaT0iaHR0cDovL3d3dy53My5vcmcvMjAwMS9YTUxTY2hlbWEtaW5zdGFuY2UiPjxEZWZhdWx0IEV4dGVuc2lvbj0ieG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24veG1sIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJiaW4iIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQubXMtZXhjZWwuc2hlZXQuYmluYXJ5Lm1hY3JvRW5hYmxlZC5tYWluIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ2bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQudm1sRHJhd2luZyIvPjxEZWZhdWx0IEV4dGVuc2lvbj0iZGF0YSIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5tb2RlbCtkYXRhIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJibXAiIENvbnRlbnRUeXBlPSJpbWFnZS9ibXAiLz48RGVmYXVsdCBFeHRlbnNpb249InBuZyIgQ29udGVudFR5cGU9ImltYWdlL3BuZyIvPjxEZWZhdWx0IEV4dGVuc2lvbj0iZ2lmIiBDb250ZW50VHlwZT0iaW1hZ2UvZ2lmIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJlbWYiIENvbnRlbnRUeXBlPSJpbWFnZS94LWVtZiIvPjxEZWZhdWx0IEV4dGVuc2lvbj0id21mIiBDb250ZW50VHlwZT0iaW1hZ2UveC13bWYiLz48RGVmYXVsdCBFeHRlbnNpb249ImpwZyIgQ29udGVudFR5cGU9ImltYWdlL2pwZWciLz48RGVmYXVsdCBFeHRlbnNpb249ImpwZWciIENvbnRlbnRUeXBlPSJpbWFnZS9qcGVnIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ0aWYiIENvbnRlbnRUeXBlPSJpbWFnZS90aWZmIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ0aWZmIiBDb250ZW50VHlwZT0iaW1hZ2UvdGlmZiIvPjxEZWZhdWx0IEV4dGVuc2lvbj0icGRmIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vcGRmIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJyZWxzIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLXBhY2thZ2UucmVsYXRpb25zaGlwcyt4bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii94bC93b3JrYm9vay54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQuc3ByZWFkc2hlZXRtbC5zaGVldC5tYWluK3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL3dvcmtzaGVldHMvc2hlZXQxLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5zcHJlYWRzaGVldG1sLndvcmtzaGVldCt4bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii94bC90aGVtZS90aGVtZTEueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LnRoZW1lK3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL3N0eWxlcy54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQuc3ByZWFkc2hlZXRtbC5zdHlsZXMreG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIvZG9jUHJvcHMvY29yZS54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtcGFja2FnZS5jb3JlLXByb3BlcnRpZXMreG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIvZG9jUHJvcHMvYXBwLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5leHRlbmRlZC1wcm9wZXJ0aWVzK3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL21ldGFkYXRhLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5zcHJlYWRzaGVldG1sLnNoZWV0TWV0YWRhdGEreG1sIi8+PC9UeXBlcz5QSwECAAAUAAAAAAAAAAAApAGEuLUCAAC1AgAAGgAAAAAAAAAAAAAAAAAAAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHNQSwECAAAUAAAAAAAAAAAAMA+Ia94dAADeHQAAEwAAAAAAAAAAAAAAAADtAgAAeGwvdGhlbWUvdGhlbWUxLnhtbFBLAQIAABQAAAAAAAAAAABV9ASUWgQAAFoEAAANAAAAAAAAAAAAAAAAAPwgAAB4bC9zdHlsZXMueG1sUEsBAgAAFAAAAAAAAAAAAGL/nmCbAgAAmwIAABgAAAAAAAAAAAAAAAAAgSUAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbFBLAQIAABQAAAAAAAAAAABggACBiAMAAIgDAAAPAAAAAAAAAAAAAAAAAFIoAAB4bC9tZXRhZGF0YS54bWxQSwECAAAUAAAAAAAAAAAAmEPx1kgBAABIAQAADwAAAAAAAAAAAAAAAAAHLAAAeGwvd29ya2Jvb2sueG1sUEsBAgAAFAAAAAAAAAAAAEpqEflMAgAATAIAAAsAAAAAAAAAAAAAAAAAfC0AAF9yZWxzLy5yZWxzUEsBAgAAFAAAAAAAAAAAAJZ0vzg4AgAAOAIAABAAAAAAAAAAAAAAAAAA8S8AAGRvY1Byb3BzL2FwcC54bWxQSwECAAAUAAAAAAAAAAAA1pJ8EVoBAABaAQAAEQAAAAAAAAAAAAAAAABXMgAAZG9jUHJvcHMvY29yZS54bWxQSwECAAAUAAAAAAAAAAAAqNdqgBUIAAAVCAAAEwAAAAAAAAAAAAAAAADgMwAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLBQYAAAAACgAKAHsCAAAmPAAAAAA=';
  var XLSX_ORDERS_B64 = 'UEsDBBQAAAAAAAAAAACkAYS4tQIAALUCAAAaAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+DQo8UmVsYXRpb25zaGlwcyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzIj48UmVsYXRpb25zaGlwIElkPSJySWQxIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3dvcmtzaGVldCIgVGFyZ2V0PSJ3b3Jrc2hlZXRzL3NoZWV0MS54bWwiLz48UmVsYXRpb25zaGlwIElkPSJySWQyIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3RoZW1lIiBUYXJnZXQ9InRoZW1lL3RoZW1lMS54bWwiLz48UmVsYXRpb25zaGlwIElkPSJySWQzIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3N0eWxlcyIgVGFyZ2V0PSJzdHlsZXMueG1sIi8+PFJlbGF0aW9uc2hpcCBJZD0icklkNCIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9zaGVldE1ldGFkYXRhIiBUYXJnZXQ9Im1ldGFkYXRhLnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAAAAAADAPiGveHQAA3h0AABMAAAB4bC90aGVtZS90aGVtZTEueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPGE6dGhlbWUgeG1sbnM6YT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL2RyYXdpbmdtbC8yMDA2L21haW4iIG5hbWU9Ik9mZmljZSBUaGVtZSI+PGE6dGhlbWVFbGVtZW50cz48YTpjbHJTY2hlbWUgbmFtZT0iT2ZmaWNlIj48YTpkazE+PGE6c3lzQ2xyIHZhbD0id2luZG93VGV4dCIgbGFzdENscj0iMDAwMDAwIi8+PC9hOmRrMT48YTpsdDE+PGE6c3lzQ2xyIHZhbD0id2luZG93IiBsYXN0Q2xyPSJGRkZGRkYiLz48L2E6bHQxPjxhOmRrMj48YTpzcmdiQ2xyIHZhbD0iMUY0OTdEIi8+PC9hOmRrMj48YTpsdDI+PGE6c3JnYkNsciB2YWw9IkVFRUNFMSIvPjwvYTpsdDI+PGE6YWNjZW50MT48YTpzcmdiQ2xyIHZhbD0iNEY4MUJEIi8+PC9hOmFjY2VudDE+PGE6YWNjZW50Mj48YTpzcmdiQ2xyIHZhbD0iQzA1MDREIi8+PC9hOmFjY2VudDI+PGE6YWNjZW50Mz48YTpzcmdiQ2xyIHZhbD0iOUJCQjU5Ii8+PC9hOmFjY2VudDM+PGE6YWNjZW50ND48YTpzcmdiQ2xyIHZhbD0iODA2NEEyIi8+PC9hOmFjY2VudDQ+PGE6YWNjZW50NT48YTpzcmdiQ2xyIHZhbD0iNEJBQ0M2Ii8+PC9hOmFjY2VudDU+PGE6YWNjZW50Nj48YTpzcmdiQ2xyIHZhbD0iRjc5NjQ2Ii8+PC9hOmFjY2VudDY+PGE6aGxpbms+PGE6c3JnYkNsciB2YWw9IjAwMDBGRiIvPjwvYTpobGluaz48YTpmb2xIbGluaz48YTpzcmdiQ2xyIHZhbD0iODAwMDgwIi8+PC9hOmZvbEhsaW5rPjwvYTpjbHJTY2hlbWU+PGE6Zm9udFNjaGVtZSBuYW1lPSJPZmZpY2UiPjxhOm1ham9yRm9udD48YTpsYXRpbiB0eXBlZmFjZT0iQ2FtYnJpYSIvPjxhOmVhIHR5cGVmYWNlPSIiLz48YTpjcyB0eXBlZmFjZT0iIi8+PGE6Zm9udCBzY3JpcHQ9IkpwYW4iIHR5cGVmYWNlPSLvvK3vvLMg77yw44K044K344OD44KvIi8+PGE6Zm9udCBzY3JpcHQ9IkhhbmciIHR5cGVmYWNlPSLrp5HsnYAg6rOg65SVIi8+PGE6Zm9udCBzY3JpcHQ9IkhhbnMiIHR5cGVmYWNlPSLlrovkvZMiLz48YTpmb250IHNjcmlwdD0iSGFudCIgdHlwZWZhY2U9IuaWsOe0sOaYjumrlCIvPjxhOmZvbnQgc2NyaXB0PSJBcmFiIiB0eXBlZmFjZT0iVGltZXMgTmV3IFJvbWFuIi8+PGE6Zm9udCBzY3JpcHQ9IkhlYnIiIHR5cGVmYWNlPSJUaW1lcyBOZXcgUm9tYW4iLz48YTpmb250IHNjcmlwdD0iVGhhaSIgdHlwZWZhY2U9IlRhaG9tYSIvPjxhOmZvbnQgc2NyaXB0PSJFdGhpIiB0eXBlZmFjZT0iTnlhbGEiLz48YTpmb250IHNjcmlwdD0iQmVuZyIgdHlwZWZhY2U9IlZyaW5kYSIvPjxhOmZvbnQgc2NyaXB0PSJHdWpyIiB0eXBlZmFjZT0iU2hydXRpIi8+PGE6Zm9udCBzY3JpcHQ9IktobXIiIHR5cGVmYWNlPSJNb29sQm9yYW4iLz48YTpmb250IHNjcmlwdD0iS25kYSIgdHlwZWZhY2U9IlR1bmdhIi8+PGE6Zm9udCBzY3JpcHQ9Ikd1cnUiIHR5cGVmYWNlPSJSYWF2aSIvPjxhOmZvbnQgc2NyaXB0PSJDYW5zIiB0eXBlZmFjZT0iRXVwaGVtaWEiLz48YTpmb250IHNjcmlwdD0iQ2hlciIgdHlwZWZhY2U9IlBsYW50YWdlbmV0IENoZXJva2VlIi8+PGE6Zm9udCBzY3JpcHQ9IllpaWkiIHR5cGVmYWNlPSJNaWNyb3NvZnQgWWkgQmFpdGkiLz48YTpmb250IHNjcmlwdD0iVGlidCIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBIaW1hbGF5YSIvPjxhOmZvbnQgc2NyaXB0PSJUaGFhIiB0eXBlZmFjZT0iTVYgQm9saSIvPjxhOmZvbnQgc2NyaXB0PSJEZXZhIiB0eXBlZmFjZT0iTWFuZ2FsIi8+PGE6Zm9udCBzY3JpcHQ9IlRlbHUiIHR5cGVmYWNlPSJHYXV0YW1pIi8+PGE6Zm9udCBzY3JpcHQ9IlRhbWwiIHR5cGVmYWNlPSJMYXRoYSIvPjxhOmZvbnQgc2NyaXB0PSJTeXJjIiB0eXBlZmFjZT0iRXN0cmFuZ2VsbyBFZGVzc2EiLz48YTpmb250IHNjcmlwdD0iT3J5YSIgdHlwZWZhY2U9IkthbGluZ2EiLz48YTpmb250IHNjcmlwdD0iTWx5bSIgdHlwZWZhY2U9IkthcnRpa2EiLz48YTpmb250IHNjcmlwdD0iTGFvbyIgdHlwZWZhY2U9IkRva0NoYW1wYSIvPjxhOmZvbnQgc2NyaXB0PSJTaW5oIiB0eXBlZmFjZT0iSXNrb29sYSBQb3RhIi8+PGE6Zm9udCBzY3JpcHQ9Ik1vbmciIHR5cGVmYWNlPSJNb25nb2xpYW4gQmFpdGkiLz48YTpmb250IHNjcmlwdD0iVmlldCIgdHlwZWZhY2U9IlRpbWVzIE5ldyBSb21hbiIvPjxhOmZvbnQgc2NyaXB0PSJVaWdoIiB0eXBlZmFjZT0iTWljcm9zb2Z0IFVpZ2h1ciIvPjxhOmZvbnQgc2NyaXB0PSJHZW9yIiB0eXBlZmFjZT0iU3lsZmFlbiIvPjwvYTptYWpvckZvbnQ+PGE6bWlub3JGb250PjxhOmxhdGluIHR5cGVmYWNlPSJDYWxpYnJpIi8+PGE6ZWEgdHlwZWZhY2U9IiIvPjxhOmNzIHR5cGVmYWNlPSIiLz48YTpmb250IHNjcmlwdD0iSnBhbiIgdHlwZWZhY2U9Iu+8re+8syDvvLDjgrTjgrfjg4Pjgq8iLz48YTpmb250IHNjcmlwdD0iSGFuZyIgdHlwZWZhY2U9IuunkeydgCDqs6DrlJUiLz48YTpmb250IHNjcmlwdD0iSGFucyIgdHlwZWZhY2U9IuWui+S9kyIvPjxhOmZvbnQgc2NyaXB0PSJIYW50IiB0eXBlZmFjZT0i5paw57Sw5piO6auUIi8+PGE6Zm9udCBzY3JpcHQ9IkFyYWIiIHR5cGVmYWNlPSJBcmlhbCIvPjxhOmZvbnQgc2NyaXB0PSJIZWJyIiB0eXBlZmFjZT0iQXJpYWwiLz48YTpmb250IHNjcmlwdD0iVGhhaSIgdHlwZWZhY2U9IlRhaG9tYSIvPjxhOmZvbnQgc2NyaXB0PSJFdGhpIiB0eXBlZmFjZT0iTnlhbGEiLz48YTpmb250IHNjcmlwdD0iQmVuZyIgdHlwZWZhY2U9IlZyaW5kYSIvPjxhOmZvbnQgc2NyaXB0PSJHdWpyIiB0eXBlZmFjZT0iU2hydXRpIi8+PGE6Zm9udCBzY3JpcHQ9IktobXIiIHR5cGVmYWNlPSJEYXVuUGVuaCIvPjxhOmZvbnQgc2NyaXB0PSJLbmRhIiB0eXBlZmFjZT0iVHVuZ2EiLz48YTpmb250IHNjcmlwdD0iR3VydSIgdHlwZWZhY2U9IlJhYXZpIi8+PGE6Zm9udCBzY3JpcHQ9IkNhbnMiIHR5cGVmYWNlPSJFdXBoZW1pYSIvPjxhOmZvbnQgc2NyaXB0PSJDaGVyIiB0eXBlZmFjZT0iUGxhbnRhZ2VuZXQgQ2hlcm9rZWUiLz48YTpmb250IHNjcmlwdD0iWWlpaSIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBZaSBCYWl0aSIvPjxhOmZvbnQgc2NyaXB0PSJUaWJ0IiB0eXBlZmFjZT0iTWljcm9zb2Z0IEhpbWFsYXlhIi8+PGE6Zm9udCBzY3JpcHQ9IlRoYWEiIHR5cGVmYWNlPSJNViBCb2xpIi8+PGE6Zm9udCBzY3JpcHQ9IkRldmEiIHR5cGVmYWNlPSJNYW5nYWwiLz48YTpmb250IHNjcmlwdD0iVGVsdSIgdHlwZWZhY2U9IkdhdXRhbWkiLz48YTpmb250IHNjcmlwdD0iVGFtbCIgdHlwZWZhY2U9IkxhdGhhIi8+PGE6Zm9udCBzY3JpcHQ9IlN5cmMiIHR5cGVmYWNlPSJFc3RyYW5nZWxvIEVkZXNzYSIvPjxhOmZvbnQgc2NyaXB0PSJPcnlhIiB0eXBlZmFjZT0iS2FsaW5nYSIvPjxhOmZvbnQgc2NyaXB0PSJNbHltIiB0eXBlZmFjZT0iS2FydGlrYSIvPjxhOmZvbnQgc2NyaXB0PSJMYW9vIiB0eXBlZmFjZT0iRG9rQ2hhbXBhIi8+PGE6Zm9udCBzY3JpcHQ9IlNpbmgiIHR5cGVmYWNlPSJJc2tvb2xhIFBvdGEiLz48YTpmb250IHNjcmlwdD0iTW9uZyIgdHlwZWZhY2U9Ik1vbmdvbGlhbiBCYWl0aSIvPjxhOmZvbnQgc2NyaXB0PSJWaWV0IiB0eXBlZmFjZT0iQXJpYWwiLz48YTpmb250IHNjcmlwdD0iVWlnaCIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBVaWdodXIiLz48YTpmb250IHNjcmlwdD0iR2VvciIgdHlwZWZhY2U9IlN5bGZhZW4iLz48L2E6bWlub3JGb250PjwvYTpmb250U2NoZW1lPjxhOmZtdFNjaGVtZSBuYW1lPSJPZmZpY2UiPjxhOmZpbGxTdHlsZUxzdD48YTpzb2xpZEZpbGw+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiLz48L2E6c29saWRGaWxsPjxhOmdyYWRGaWxsIHJvdFdpdGhTaGFwZT0iMSI+PGE6Z3NMc3Q+PGE6Z3MgcG9zPSIwIj48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6dGludCB2YWw9IjUwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMzAwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PGE6Z3MgcG9zPSIzNTAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSIzNzAwMCIvPjxhOnNhdE1vZCB2YWw9IjMwMDAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOmdzPjxhOmdzIHBvcz0iMTAwMDAwIj48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6dGludCB2YWw9IjE1MDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOmxpbiBhbmc9IjE2MjAwMDAwIiBzY2FsZWQ9IjEiLz48L2E6Z3JhZEZpbGw+PGE6Z3JhZEZpbGwgcm90V2l0aFNoYXBlPSIxIj48YTpnc0xzdD48YTpncyBwb3M9IjAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iMTAwMDAwIi8+PGE6c2hhZGUgdmFsPSIxMDAwMDAiLz48YTpzYXRNb2QgdmFsPSIxMzAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48YTpncyBwb3M9IjEwMDAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSI1MDAwMCIvPjxhOnNoYWRlIHZhbD0iMTAwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOmxpbiBhbmc9IjE2MjAwMDAwIiBzY2FsZWQ9IjAiLz48L2E6Z3JhZEZpbGw+PC9hOmZpbGxTdHlsZUxzdD48YTpsblN0eWxlTHN0PjxhOmxuIHc9Ijk1MjUiIGNhcD0iZmxhdCIgY21wZD0ic25nIiBhbGduPSJjdHIiPjxhOnNvbGlkRmlsbD48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6c2hhZGUgdmFsPSI5NTAwMCIvPjxhOnNhdE1vZCB2YWw9IjEwNTAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOnNvbGlkRmlsbD48YTpwcnN0RGFzaCB2YWw9InNvbGlkIi8+PC9hOmxuPjxhOmxuIHc9IjI1NDAwIiBjYXA9ImZsYXQiIGNtcGQ9InNuZyIgYWxnbj0iY3RyIj48YTpzb2xpZEZpbGw+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiLz48L2E6c29saWRGaWxsPjxhOnByc3REYXNoIHZhbD0ic29saWQiLz48L2E6bG4+PGE6bG4gdz0iMzgxMDAiIGNhcD0iZmxhdCIgY21wZD0ic25nIiBhbGduPSJjdHIiPjxhOnNvbGlkRmlsbD48YTpzY2hlbWVDbHIgdmFsPSJwaENsciIvPjwvYTpzb2xpZEZpbGw+PGE6cHJzdERhc2ggdmFsPSJzb2xpZCIvPjwvYTpsbj48L2E6bG5TdHlsZUxzdD48YTplZmZlY3RTdHlsZUxzdD48YTplZmZlY3RTdHlsZT48YTplZmZlY3RMc3Q+PGE6b3V0ZXJTaGR3IGJsdXJSYWQ9IjQwMDAwIiBkaXN0PSIyMDAwMCIgZGlyPSI1NDAwMDAwIiByb3RXaXRoU2hhcGU9IjAiPjxhOnNyZ2JDbHIgdmFsPSIwMDAwMDAiPjxhOmFscGhhIHZhbD0iMzgwMDAiLz48L2E6c3JnYkNscj48L2E6b3V0ZXJTaGR3PjwvYTplZmZlY3RMc3Q+PC9hOmVmZmVjdFN0eWxlPjxhOmVmZmVjdFN0eWxlPjxhOmVmZmVjdExzdD48YTpvdXRlclNoZHcgYmx1clJhZD0iNDAwMDAiIGRpc3Q9IjIzMDAwIiBkaXI9IjU0MDAwMDAiIHJvdFdpdGhTaGFwZT0iMCI+PGE6c3JnYkNsciB2YWw9IjAwMDAwMCI+PGE6YWxwaGEgdmFsPSIzNTAwMCIvPjwvYTpzcmdiQ2xyPjwvYTpvdXRlclNoZHc+PC9hOmVmZmVjdExzdD48L2E6ZWZmZWN0U3R5bGU+PGE6ZWZmZWN0U3R5bGU+PGE6ZWZmZWN0THN0PjxhOm91dGVyU2hkdyBibHVyUmFkPSI0MDAwMCIgZGlzdD0iMjMwMDAiIGRpcj0iNTQwMDAwMCIgcm90V2l0aFNoYXBlPSIwIj48YTpzcmdiQ2xyIHZhbD0iMDAwMDAwIj48YTphbHBoYSB2YWw9IjM1MDAwIi8+PC9hOnNyZ2JDbHI+PC9hOm91dGVyU2hkdz48L2E6ZWZmZWN0THN0PjxhOnNjZW5lM2Q+PGE6Y2FtZXJhIHByc3Q9Im9ydGhvZ3JhcGhpY0Zyb250Ij48YTpyb3QgbGF0PSIwIiBsb249IjAiIHJldj0iMCIvPjwvYTpjYW1lcmE+PGE6bGlnaHRSaWcgcmlnPSJ0aHJlZVB0IiBkaXI9InQiPjxhOnJvdCBsYXQ9IjAiIGxvbj0iMCIgcmV2PSIxMjAwMDAwIi8+PC9hOmxpZ2h0UmlnPjwvYTpzY2VuZTNkPjxhOnNwM2Q+PGE6YmV2ZWxUIHc9IjYzNTAwIiBoPSIyNTQwMCIvPjwvYTpzcDNkPjwvYTplZmZlY3RTdHlsZT48L2E6ZWZmZWN0U3R5bGVMc3Q+PGE6YmdGaWxsU3R5bGVMc3Q+PGE6c29saWRGaWxsPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIi8+PC9hOnNvbGlkRmlsbD48YTpncmFkRmlsbCByb3RXaXRoU2hhcGU9IjEiPjxhOmdzTHN0PjxhOmdzIHBvcz0iMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSI0MDAwMCIvPjxhOnNhdE1vZCB2YWw9IjM1MDAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOmdzPjxhOmdzIHBvcz0iNDAwMDAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iNDUwMDAiLz48YTpzaGFkZSB2YWw9Ijk5MDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PGE6Z3MgcG9zPSIxMDAwMDAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTpzaGFkZSB2YWw9IjIwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMjU1MDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOnBhdGggcGF0aD0iY2lyY2xlIj48YTpmaWxsVG9SZWN0IGw9IjUwMDAwIiB0PSItODAwMDAiIHI9IjUwMDAwIiBiPSIxODAwMDAiLz48L2E6cGF0aD48L2E6Z3JhZEZpbGw+PGE6Z3JhZEZpbGwgcm90V2l0aFNoYXBlPSIxIj48YTpnc0xzdD48YTpncyBwb3M9IjAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iODAwMDAiLz48YTpzYXRNb2QgdmFsPSIzMDAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48YTpncyBwb3M9IjEwMDAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnNoYWRlIHZhbD0iMzAwMDAiLz48YTpzYXRNb2QgdmFsPSIyMDAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48L2E6Z3NMc3Q+PGE6cGF0aCBwYXRoPSJjaXJjbGUiPjxhOmZpbGxUb1JlY3QgbD0iNTAwMDAiIHQ9IjUwMDAwIiByPSI1MDAwMCIgYj0iNTAwMDAiLz48L2E6cGF0aD48L2E6Z3JhZEZpbGw+PC9hOmJnRmlsbFN0eWxlTHN0PjwvYTpmbXRTY2hlbWU+PC9hOnRoZW1lRWxlbWVudHM+PGE6b2JqZWN0RGVmYXVsdHM+PGE6c3BEZWY+PGE6c3BQci8+PGE6Ym9keVByLz48YTpsc3RTdHlsZS8+PGE6c3R5bGU+PGE6bG5SZWYgaWR4PSIxIj48YTpzY2hlbWVDbHIgdmFsPSJhY2NlbnQxIi8+PC9hOmxuUmVmPjxhOmZpbGxSZWYgaWR4PSIzIj48YTpzY2hlbWVDbHIgdmFsPSJhY2NlbnQxIi8+PC9hOmZpbGxSZWY+PGE6ZWZmZWN0UmVmIGlkeD0iMiI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTplZmZlY3RSZWY+PGE6Zm9udFJlZiBpZHg9Im1pbm9yIj48YTpzY2hlbWVDbHIgdmFsPSJsdDEiLz48L2E6Zm9udFJlZj48L2E6c3R5bGU+PC9hOnNwRGVmPjxhOmxuRGVmPjxhOnNwUHIvPjxhOmJvZHlQci8+PGE6bHN0U3R5bGUvPjxhOnN0eWxlPjxhOmxuUmVmIGlkeD0iMiI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTpsblJlZj48YTpmaWxsUmVmIGlkeD0iMCI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTpmaWxsUmVmPjxhOmVmZmVjdFJlZiBpZHg9IjEiPjxhOnNjaGVtZUNsciB2YWw9ImFjY2VudDEiLz48L2E6ZWZmZWN0UmVmPjxhOmZvbnRSZWYgaWR4PSJtaW5vciI+PGE6c2NoZW1lQ2xyIHZhbD0idHgxIi8+PC9hOmZvbnRSZWY+PC9hOnN0eWxlPjwvYTpsbkRlZj48L2E6b2JqZWN0RGVmYXVsdHM+PGE6ZXh0cmFDbHJTY2hlbWVMc3QvPjwvYTp0aGVtZT5QSwMEFAAAAAAAAAAAAFX0BJRaBAAAWgQAAA0AAAB4bC9zdHlsZXMueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPHN0eWxlU2hlZXQgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6dnQ9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L2RvY1Byb3BzVlR5cGVzIj48bnVtRm10cyBjb3VudD0iMSI+PG51bUZtdCBudW1GbXRJZD0iNTYiIGZvcm1hdENvZGU9IiZxdW90O+S4iuWNiC/kuIvljYggJnF1b3Q7aGgmcXVvdDvmmYImcXVvdDttbSZxdW90O+WIhiZxdW90O3NzJnF1b3Q756eSICZxdW90OyIvPjwvbnVtRm10cz48Zm9udHMgY291bnQ9IjEiPjxmb250PjxzeiB2YWw9IjEyIi8+PGNvbG9yIHRoZW1lPSIxIi8+PG5hbWUgdmFsPSJDYWxpYnJpIi8+PGZhbWlseSB2YWw9IjIiLz48c2NoZW1lIHZhbD0ibWlub3IiLz48L2ZvbnQ+PC9mb250cz48ZmlsbHMgY291bnQ9IjIiPjxmaWxsPjxwYXR0ZXJuRmlsbCBwYXR0ZXJuVHlwZT0ibm9uZSIvPjwvZmlsbD48ZmlsbD48cGF0dGVybkZpbGwgcGF0dGVyblR5cGU9ImdyYXkxMjUiLz48L2ZpbGw+PC9maWxscz48Ym9yZGVycyBjb3VudD0iMSI+PGJvcmRlcj48bGVmdC8+PHJpZ2h0Lz48dG9wLz48Ym90dG9tLz48ZGlhZ29uYWwvPjwvYm9yZGVyPjwvYm9yZGVycz48Y2VsbFN0eWxlWGZzIGNvdW50PSIxIj48eGYgbnVtRm10SWQ9IjAiIGZvbnRJZD0iMCIgZmlsbElkPSIwIiBib3JkZXJJZD0iMCIvPjwvY2VsbFN0eWxlWGZzPjxjZWxsWGZzIGNvdW50PSIxIj48eGYgbnVtRm10SWQ9IjAiIGZvbnRJZD0iMCIgZmlsbElkPSIwIiBib3JkZXJJZD0iMCIgeGZJZD0iMCIgYXBwbHlOdW1iZXJGb3JtYXQ9IjEiLz48L2NlbGxYZnM+PGNlbGxTdHlsZXMgY291bnQ9IjEiPjxjZWxsU3R5bGUgbmFtZT0iTm9ybWFsIiB4ZklkPSIwIiBidWlsdGluSWQ9IjAiLz48L2NlbGxTdHlsZXM+PGR4ZnMgY291bnQ9IjAiLz48dGFibGVTdHlsZXMgY291bnQ9IjAiIGRlZmF1bHRUYWJsZVN0eWxlPSJUYWJsZVN0eWxlTWVkaXVtOSIgZGVmYXVsdFBpdm90U3R5bGU9IlBpdm90U3R5bGVNZWRpdW00Ii8+PC9zdHlsZVNoZWV0PlBLAwQUAAAAAAAAAAAAa4aK4G0FAABtBQAAGAAAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4NCjx3b3Jrc2hlZXQgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6cj0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcyI+PGRpbWVuc2lvbiByZWY9IkExOkoyIi8+PHNoZWV0Vmlld3M+PHNoZWV0VmlldyB3b3JrYm9va1ZpZXdJZD0iMCIvPjwvc2hlZXRWaWV3cz48c2hlZXREYXRhPjxyb3cgcj0iMSI+PGMgcj0iQTEiIHQ9InN0ciI+PHY+6K6i5Y2V5Y+3PC92PjwvYz48YyByPSJCMSIgdD0ic3RyIj48dj7orqLljZXnirbmgIE8L3Y+PC9jPjxjIHI9IkMxIiB0PSJzdHIiPjx2PuiuouWNlemHkeminTwvdj48L2M+PGMgcj0iRDEiIHQ9InN0ciI+PHY+6aKE6K6h5aKe5YC856iOPC92PjwvYz48YyByPSJFMSIgdD0ic3RyIj48dj5ERFDlhbPnqI48L3Y+PC9jPjxjIHI9IkYxIiB0PSJzdHIiPjx2PuW5s+WPsOaYr+WQpuS7o+W+geS7o+e8tDwvdj48L2M+PGMgcj0iRzEiIHQ9InN0ciI+PHY+5ZWG5ZOBIElEPC92PjwvYz48YyByPSJIMSIgdD0ic3RyIj48dj7llYblk4Hkv6Hmga88L3Y+PC9jPjxjIHI9IkkxIiB0PSJzdHIiPjx2PuaUtui0p+WbveWutjwvdj48L2M+PGMgcj0iSjEiIHQ9InN0ciI+PHY+5LiL5Y2V5pe26Ze0PC92PjwvYz48L3Jvdz48cm93IHI9IjIiIHhtbDpzcGFjZT0icHJlc2VydmUiPjxjIHI9IkEyIiB0PSJzdHIiPjx2Pk8tMTAwMTwvdj48L2M+PGMgcj0iQjIiIHQ9InN0ciI+PHY+562J5b6F5Y+R6LSnPC92PjwvYz48YyByPSJDMiIgdD0ic3RyIj48dj5DTu+/pSAxNjUuMTg8L3Y+PC9jPjxjIHI9IkQyIiB0PSJzdHIiPjx2PkNO77+lIDM0LjY5PC92PjwvYz48YyByPSJFMiIgdD0ic3RyIj48dj5DTu+/pSAyMi45NDwvdj48L2M+PGMgcj0iRjIiIHQ9InN0ciI+PHY+5bmz5Y+w5bey56iOPC92PjwvYz48YyByPSJHMiIgdD0ic3RyIj48dj5JVC1BLElULUI8L3Y+PC9jPjxjIHI9IkgyIiB0PSJzdHIiIHhtbDpzcGFjZT0icHJlc2VydmUiPjx2IHhtbDpzcGFjZT0icHJlc2VydmUiPuOAkDHjgJEgQeasviAo5ZWG5ZOB5pWw6YePOjEgcGllY2UpCuOAkDLjgJEgQuasviAo5ZWG5ZOB5pWw6YePOjIgcGllY2UpPC92PjwvYz48YyByPSJJMiIgdD0ic3RyIj48dj5Vbml0ZWQgU3RhdGVzPC92PjwvYz48YyByPSJKMiIgdD0ic3RyIj48dj4yMDI2LTA5LTIwIDEwOjAwOjAwPC92PjwvYz48L3Jvdz48L3NoZWV0RGF0YT48aWdub3JlZEVycm9ycz48aWdub3JlZEVycm9yIG51bWJlclN0b3JlZEFzVGV4dD0iMSIgc3FyZWY9IkExOkoyIi8+PC9pZ25vcmVkRXJyb3JzPjwvd29ya3NoZWV0PlBLAwQUAAAAAAAAAAAAYIAAgYgDAACIAwAADwAAAHhsL21ldGFkYXRhLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4NCjxtZXRhZGF0YSB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3NwcmVhZHNoZWV0bWwvMjAwNi9tYWluIiB4bWxuczp4bHJkPSJodHRwOi8vc2NoZW1hcy5taWNyb3NvZnQuY29tL29mZmljZS9zcHJlYWRzaGVldG1sLzIwMTcvcmljaGRhdGEiIHhtbG5zOnhkYT0iaHR0cDovL3NjaGVtYXMubWljcm9zb2Z0LmNvbS9vZmZpY2Uvc3ByZWFkc2hlZXRtbC8yMDE3L2R5bmFtaWNhcnJheSI+CiAgPG1ldGFkYXRhVHlwZXMgY291bnQ9IjEiPgogICAgPG1ldGFkYXRhVHlwZSBuYW1lPSJYTERBUFIiIG1pblN1cHBvcnRlZFZlcnNpb249IjEyMDAwMCIgY29weT0iMSIgcGFzdGVBbGw9IjEiIHBhc3RlVmFsdWVzPSIxIiBtZXJnZT0iMSIgc3BsaXRGaXJzdD0iMSIgcm93Q29sU2hpZnQ9IjEiIGNsZWFyRm9ybWF0cz0iMSIgY2xlYXJDb21tZW50cz0iMSIgYXNzaWduPSIxIiBjb2VyY2U9IjEiIGNlbGxNZXRhPSIxIi8+CiAgPC9tZXRhZGF0YVR5cGVzPgogIDxmdXR1cmVNZXRhZGF0YSBuYW1lPSJYTERBUFIiIGNvdW50PSIxIj4KICAgIDxiaz4KICAgICAgPGV4dExzdD4KICAgICAgICA8ZXh0IHVyaT0ie2JkYmI4Y2RjLWZhMWUtNDk2ZS1hODU3LTNjM2YzMGMwMjljM30iPgogICAgICAgICAgPHhkYTpkeW5hbWljQXJyYXlQcm9wZXJ0aWVzIGZEeW5hbWljPSIxIiBmQ29sbGFwc2VkPSIwIi8+CiAgICAgICAgPC9leHQ+CiAgICAgIDwvZXh0THN0PgogICAgPC9iaz4KICA8L2Z1dHVyZU1ldGFkYXRhPgogIDxjZWxsTWV0YWRhdGEgY291bnQ9IjEiPgogICAgPGJrPgogICAgICA8cmMgdD0iMSIgdj0iMCIvPgogICAgPC9iaz4KICA8L2NlbGxNZXRhZGF0YT4KPC9tZXRhZGF0YT5QSwMEFAAAAAAAAAAAAA6GhetCAQAAQgEAAA8AAAB4bC93b3JrYm9vay54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+DQo8d29ya2Jvb2sgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6cj0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcyI+PHdvcmtib29rUHIgY29kZU5hbWU9IlRoaXNXb3JrYm9vayIvPjxzaGVldHM+PHNoZWV0IG5hbWU9InNoZWV0MSIgc2hlZXRJZD0iMSIgcjppZD0icklkMSIvPjwvc2hlZXRzPjwvd29ya2Jvb2s+UEsDBBQAAAAAAAAAAABKahH5TAIAAEwCAAALAAAAX3JlbHMvLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+DQo8UmVsYXRpb25zaGlwcyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzIj48UmVsYXRpb25zaGlwIElkPSJySWQyIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L3JlbGF0aW9uc2hpcHMvbWV0YWRhdGEvY29yZS1wcm9wZXJ0aWVzIiBUYXJnZXQ9ImRvY1Byb3BzL2NvcmUueG1sIi8+PFJlbGF0aW9uc2hpcCBJZD0icklkMyIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9leHRlbmRlZC1wcm9wZXJ0aWVzIiBUYXJnZXQ9ImRvY1Byb3BzL2FwcC54bWwiLz48UmVsYXRpb25zaGlwIElkPSJySWQxIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL29mZmljZURvY3VtZW50IiBUYXJnZXQ9InhsL3dvcmtib29rLnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAAAAAAOfK5fYyAgAAMgIAABAAAABkb2NQcm9wcy9hcHAueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPFByb3BlcnRpZXMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L2V4dGVuZGVkLXByb3BlcnRpZXMiIHhtbG5zOnZ0PSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9kb2NQcm9wc1ZUeXBlcyI+PEFwcGxpY2F0aW9uPlNoZWV0SlM8L0FwcGxpY2F0aW9uPjxIZWFkaW5nUGFpcnM+PHZ0OnZlY3RvciBzaXplPSIyIiBiYXNlVHlwZT0idmFyaWFudCI+PHZ0OnZhcmlhbnQ+PHZ0Omxwc3RyPldvcmtzaGVldHM8L3Z0Omxwc3RyPjwvdnQ6dmFyaWFudD48dnQ6dmFyaWFudD48dnQ6aTQ+MTwvdnQ6aTQ+PC92dDp2YXJpYW50PjwvdnQ6dmVjdG9yPjwvSGVhZGluZ1BhaXJzPjxUaXRsZXNPZlBhcnRzPjx2dDp2ZWN0b3Igc2l6ZT0iMSIgYmFzZVR5cGU9Imxwc3RyIj48dnQ6bHBzdHI+c2hlZXQxPC92dDpscHN0cj48L3Z0OnZlY3Rvcj48L1RpdGxlc09mUGFydHM+PC9Qcm9wZXJ0aWVzPlBLAwQUAAAAAAAAAAAA1pJ8EVoBAABaAQAAEQAAAGRvY1Byb3BzL2NvcmUueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPGNwOmNvcmVQcm9wZXJ0aWVzIHhtbG5zOmNwPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L21ldGFkYXRhL2NvcmUtcHJvcGVydGllcyIgeG1sbnM6ZGM9Imh0dHA6Ly9wdXJsLm9yZy9kYy9lbGVtZW50cy8xLjEvIiB4bWxuczpkY3Rlcm1zPSJodHRwOi8vcHVybC5vcmcvZGMvdGVybXMvIiB4bWxuczpkY21pdHlwZT0iaHR0cDovL3B1cmwub3JnL2RjL2RjbWl0eXBlLyIgeG1sbnM6eHNpPSJodHRwOi8vd3d3LnczLm9yZy8yMDAxL1hNTFNjaGVtYS1pbnN0YW5jZSIvPlBLAwQUAAAAAAAAAAAAqNdqgBUIAAAVCAAAEwAAAFtDb250ZW50X1R5cGVzXS54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+DQo8VHlwZXMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvY29udGVudC10eXBlcyIgeG1sbnM6eHNkPSJodHRwOi8vd3d3LnczLm9yZy8yMDAxL1hNTFNjaGVtYSIgeG1sbnM6eHNpPSJodHRwOi8vd3d3LnczLm9yZy8yMDAxL1hNTFNjaGVtYS1pbnN0YW5jZSI+PERlZmF1bHQgRXh0ZW5zaW9uPSJ4bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi94bWwiLz48RGVmYXVsdCBFeHRlbnNpb249ImJpbiIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5tcy1leGNlbC5zaGVldC5iaW5hcnkubWFjcm9FbmFibGVkLm1haW4iLz48RGVmYXVsdCBFeHRlbnNpb249InZtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC52bWxEcmF3aW5nIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJkYXRhIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50Lm1vZGVsK2RhdGEiLz48RGVmYXVsdCBFeHRlbnNpb249ImJtcCIgQ29udGVudFR5cGU9ImltYWdlL2JtcCIvPjxEZWZhdWx0IEV4dGVuc2lvbj0icG5nIiBDb250ZW50VHlwZT0iaW1hZ2UvcG5nIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJnaWYiIENvbnRlbnRUeXBlPSJpbWFnZS9naWYiLz48RGVmYXVsdCBFeHRlbnNpb249ImVtZiIgQ29udGVudFR5cGU9ImltYWdlL3gtZW1mIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ3bWYiIENvbnRlbnRUeXBlPSJpbWFnZS94LXdtZiIvPjxEZWZhdWx0IEV4dGVuc2lvbj0ianBnIiBDb250ZW50VHlwZT0iaW1hZ2UvanBlZyIvPjxEZWZhdWx0IEV4dGVuc2lvbj0ianBlZyIgQ29udGVudFR5cGU9ImltYWdlL2pwZWciLz48RGVmYXVsdCBFeHRlbnNpb249InRpZiIgQ29udGVudFR5cGU9ImltYWdlL3RpZmYiLz48RGVmYXVsdCBFeHRlbnNpb249InRpZmYiIENvbnRlbnRUeXBlPSJpbWFnZS90aWZmIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJwZGYiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi9wZGYiLz48RGVmYXVsdCBFeHRlbnNpb249InJlbHMiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtcGFja2FnZS5yZWxhdGlvbnNoaXBzK3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL3dvcmtib29rLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5zcHJlYWRzaGVldG1sLnNoZWV0Lm1haW4reG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIveGwvd29ya3NoZWV0cy9zaGVldDEueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LnNwcmVhZHNoZWV0bWwud29ya3NoZWV0K3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL3RoZW1lL3RoZW1lMS54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQudGhlbWUreG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIveGwvc3R5bGVzLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5zcHJlYWRzaGVldG1sLnN0eWxlcyt4bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii9kb2NQcm9wcy9jb3JlLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1wYWNrYWdlLmNvcmUtcHJvcGVydGllcyt4bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii9kb2NQcm9wcy9hcHAueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LmV4dGVuZGVkLXByb3BlcnRpZXMreG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIveGwvbWV0YWRhdGEueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LnNwcmVhZHNoZWV0bWwuc2hlZXRNZXRhZGF0YSt4bWwiLz48L1R5cGVzPlBLAQIAABQAAAAAAAAAAACkAYS4tQIAALUCAAAaAAAAAAAAAAAAAAAAAAAAAAB4bC9fcmVscy93b3JrYm9vay54bWwucmVsc1BLAQIAABQAAAAAAAAAAAAwD4hr3h0AAN4dAAATAAAAAAAAAAAAAAAAAO0CAAB4bC90aGVtZS90aGVtZTEueG1sUEsBAgAAFAAAAAAAAAAAAFX0BJRaBAAAWgQAAA0AAAAAAAAAAAAAAAAA/CAAAHhsL3N0eWxlcy54bWxQSwECAAAUAAAAAAAAAAAAa4aK4G0FAABtBQAAGAAAAAAAAAAAAAAAAACBJQAAeGwvd29ya3NoZWV0cy9zaGVldDEueG1sUEsBAgAAFAAAAAAAAAAAAGCAAIGIAwAAiAMAAA8AAAAAAAAAAAAAAAAAJCsAAHhsL21ldGFkYXRhLnhtbFBLAQIAABQAAAAAAAAAAAAOhoXrQgEAAEIBAAAPAAAAAAAAAAAAAAAAANkuAAB4bC93b3JrYm9vay54bWxQSwECAAAUAAAAAAAAAAAASmoR+UwCAABMAgAACwAAAAAAAAAAAAAAAABIMAAAX3JlbHMvLnJlbHNQSwECAAAUAAAAAAAAAAAA58rl9jICAAAyAgAAEAAAAAAAAAAAAAAAAAC9MgAAZG9jUHJvcHMvYXBwLnhtbFBLAQIAABQAAAAAAAAAAADWknwRWgEAAFoBAAARAAAAAAAAAAAAAAAAAB01AABkb2NQcm9wcy9jb3JlLnhtbFBLAQIAABQAAAAAAAAAAACo12qAFQgAABUIAAATAAAAAAAAAAAAAAAAAKY2AABbQ29udGVudF9UeXBlc10ueG1sUEsFBgAAAAAKAAoAewIAAOw+AAAAAA==';
  var XLSX_JUNK_B64 = 'UEsDBBQAAAAAAAAAAACkAYS4tQIAALUCAAAaAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHM8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+DQo8UmVsYXRpb25zaGlwcyB4bWxucz0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzIj48UmVsYXRpb25zaGlwIElkPSJySWQxIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3dvcmtzaGVldCIgVGFyZ2V0PSJ3b3Jrc2hlZXRzL3NoZWV0MS54bWwiLz48UmVsYXRpb25zaGlwIElkPSJySWQyIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3RoZW1lIiBUYXJnZXQ9InRoZW1lL3RoZW1lMS54bWwiLz48UmVsYXRpb25zaGlwIElkPSJySWQzIiBUeXBlPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9yZWxhdGlvbnNoaXBzL3N0eWxlcyIgVGFyZ2V0PSJzdHlsZXMueG1sIi8+PFJlbGF0aW9uc2hpcCBJZD0icklkNCIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9zaGVldE1ldGFkYXRhIiBUYXJnZXQ9Im1ldGFkYXRhLnhtbCIvPjwvUmVsYXRpb25zaGlwcz5QSwMEFAAAAAAAAAAAADAPiGveHQAA3h0AABMAAAB4bC90aGVtZS90aGVtZTEueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPGE6dGhlbWUgeG1sbnM6YT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL2RyYXdpbmdtbC8yMDA2L21haW4iIG5hbWU9Ik9mZmljZSBUaGVtZSI+PGE6dGhlbWVFbGVtZW50cz48YTpjbHJTY2hlbWUgbmFtZT0iT2ZmaWNlIj48YTpkazE+PGE6c3lzQ2xyIHZhbD0id2luZG93VGV4dCIgbGFzdENscj0iMDAwMDAwIi8+PC9hOmRrMT48YTpsdDE+PGE6c3lzQ2xyIHZhbD0id2luZG93IiBsYXN0Q2xyPSJGRkZGRkYiLz48L2E6bHQxPjxhOmRrMj48YTpzcmdiQ2xyIHZhbD0iMUY0OTdEIi8+PC9hOmRrMj48YTpsdDI+PGE6c3JnYkNsciB2YWw9IkVFRUNFMSIvPjwvYTpsdDI+PGE6YWNjZW50MT48YTpzcmdiQ2xyIHZhbD0iNEY4MUJEIi8+PC9hOmFjY2VudDE+PGE6YWNjZW50Mj48YTpzcmdiQ2xyIHZhbD0iQzA1MDREIi8+PC9hOmFjY2VudDI+PGE6YWNjZW50Mz48YTpzcmdiQ2xyIHZhbD0iOUJCQjU5Ii8+PC9hOmFjY2VudDM+PGE6YWNjZW50ND48YTpzcmdiQ2xyIHZhbD0iODA2NEEyIi8+PC9hOmFjY2VudDQ+PGE6YWNjZW50NT48YTpzcmdiQ2xyIHZhbD0iNEJBQ0M2Ii8+PC9hOmFjY2VudDU+PGE6YWNjZW50Nj48YTpzcmdiQ2xyIHZhbD0iRjc5NjQ2Ii8+PC9hOmFjY2VudDY+PGE6aGxpbms+PGE6c3JnYkNsciB2YWw9IjAwMDBGRiIvPjwvYTpobGluaz48YTpmb2xIbGluaz48YTpzcmdiQ2xyIHZhbD0iODAwMDgwIi8+PC9hOmZvbEhsaW5rPjwvYTpjbHJTY2hlbWU+PGE6Zm9udFNjaGVtZSBuYW1lPSJPZmZpY2UiPjxhOm1ham9yRm9udD48YTpsYXRpbiB0eXBlZmFjZT0iQ2FtYnJpYSIvPjxhOmVhIHR5cGVmYWNlPSIiLz48YTpjcyB0eXBlZmFjZT0iIi8+PGE6Zm9udCBzY3JpcHQ9IkpwYW4iIHR5cGVmYWNlPSLvvK3vvLMg77yw44K044K344OD44KvIi8+PGE6Zm9udCBzY3JpcHQ9IkhhbmciIHR5cGVmYWNlPSLrp5HsnYAg6rOg65SVIi8+PGE6Zm9udCBzY3JpcHQ9IkhhbnMiIHR5cGVmYWNlPSLlrovkvZMiLz48YTpmb250IHNjcmlwdD0iSGFudCIgdHlwZWZhY2U9IuaWsOe0sOaYjumrlCIvPjxhOmZvbnQgc2NyaXB0PSJBcmFiIiB0eXBlZmFjZT0iVGltZXMgTmV3IFJvbWFuIi8+PGE6Zm9udCBzY3JpcHQ9IkhlYnIiIHR5cGVmYWNlPSJUaW1lcyBOZXcgUm9tYW4iLz48YTpmb250IHNjcmlwdD0iVGhhaSIgdHlwZWZhY2U9IlRhaG9tYSIvPjxhOmZvbnQgc2NyaXB0PSJFdGhpIiB0eXBlZmFjZT0iTnlhbGEiLz48YTpmb250IHNjcmlwdD0iQmVuZyIgdHlwZWZhY2U9IlZyaW5kYSIvPjxhOmZvbnQgc2NyaXB0PSJHdWpyIiB0eXBlZmFjZT0iU2hydXRpIi8+PGE6Zm9udCBzY3JpcHQ9IktobXIiIHR5cGVmYWNlPSJNb29sQm9yYW4iLz48YTpmb250IHNjcmlwdD0iS25kYSIgdHlwZWZhY2U9IlR1bmdhIi8+PGE6Zm9udCBzY3JpcHQ9Ikd1cnUiIHR5cGVmYWNlPSJSYWF2aSIvPjxhOmZvbnQgc2NyaXB0PSJDYW5zIiB0eXBlZmFjZT0iRXVwaGVtaWEiLz48YTpmb250IHNjcmlwdD0iQ2hlciIgdHlwZWZhY2U9IlBsYW50YWdlbmV0IENoZXJva2VlIi8+PGE6Zm9udCBzY3JpcHQ9IllpaWkiIHR5cGVmYWNlPSJNaWNyb3NvZnQgWWkgQmFpdGkiLz48YTpmb250IHNjcmlwdD0iVGlidCIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBIaW1hbGF5YSIvPjxhOmZvbnQgc2NyaXB0PSJUaGFhIiB0eXBlZmFjZT0iTVYgQm9saSIvPjxhOmZvbnQgc2NyaXB0PSJEZXZhIiB0eXBlZmFjZT0iTWFuZ2FsIi8+PGE6Zm9udCBzY3JpcHQ9IlRlbHUiIHR5cGVmYWNlPSJHYXV0YW1pIi8+PGE6Zm9udCBzY3JpcHQ9IlRhbWwiIHR5cGVmYWNlPSJMYXRoYSIvPjxhOmZvbnQgc2NyaXB0PSJTeXJjIiB0eXBlZmFjZT0iRXN0cmFuZ2VsbyBFZGVzc2EiLz48YTpmb250IHNjcmlwdD0iT3J5YSIgdHlwZWZhY2U9IkthbGluZ2EiLz48YTpmb250IHNjcmlwdD0iTWx5bSIgdHlwZWZhY2U9IkthcnRpa2EiLz48YTpmb250IHNjcmlwdD0iTGFvbyIgdHlwZWZhY2U9IkRva0NoYW1wYSIvPjxhOmZvbnQgc2NyaXB0PSJTaW5oIiB0eXBlZmFjZT0iSXNrb29sYSBQb3RhIi8+PGE6Zm9udCBzY3JpcHQ9Ik1vbmciIHR5cGVmYWNlPSJNb25nb2xpYW4gQmFpdGkiLz48YTpmb250IHNjcmlwdD0iVmlldCIgdHlwZWZhY2U9IlRpbWVzIE5ldyBSb21hbiIvPjxhOmZvbnQgc2NyaXB0PSJVaWdoIiB0eXBlZmFjZT0iTWljcm9zb2Z0IFVpZ2h1ciIvPjxhOmZvbnQgc2NyaXB0PSJHZW9yIiB0eXBlZmFjZT0iU3lsZmFlbiIvPjwvYTptYWpvckZvbnQ+PGE6bWlub3JGb250PjxhOmxhdGluIHR5cGVmYWNlPSJDYWxpYnJpIi8+PGE6ZWEgdHlwZWZhY2U9IiIvPjxhOmNzIHR5cGVmYWNlPSIiLz48YTpmb250IHNjcmlwdD0iSnBhbiIgdHlwZWZhY2U9Iu+8re+8syDvvLDjgrTjgrfjg4Pjgq8iLz48YTpmb250IHNjcmlwdD0iSGFuZyIgdHlwZWZhY2U9IuunkeydgCDqs6DrlJUiLz48YTpmb250IHNjcmlwdD0iSGFucyIgdHlwZWZhY2U9IuWui+S9kyIvPjxhOmZvbnQgc2NyaXB0PSJIYW50IiB0eXBlZmFjZT0i5paw57Sw5piO6auUIi8+PGE6Zm9udCBzY3JpcHQ9IkFyYWIiIHR5cGVmYWNlPSJBcmlhbCIvPjxhOmZvbnQgc2NyaXB0PSJIZWJyIiB0eXBlZmFjZT0iQXJpYWwiLz48YTpmb250IHNjcmlwdD0iVGhhaSIgdHlwZWZhY2U9IlRhaG9tYSIvPjxhOmZvbnQgc2NyaXB0PSJFdGhpIiB0eXBlZmFjZT0iTnlhbGEiLz48YTpmb250IHNjcmlwdD0iQmVuZyIgdHlwZWZhY2U9IlZyaW5kYSIvPjxhOmZvbnQgc2NyaXB0PSJHdWpyIiB0eXBlZmFjZT0iU2hydXRpIi8+PGE6Zm9udCBzY3JpcHQ9IktobXIiIHR5cGVmYWNlPSJEYXVuUGVuaCIvPjxhOmZvbnQgc2NyaXB0PSJLbmRhIiB0eXBlZmFjZT0iVHVuZ2EiLz48YTpmb250IHNjcmlwdD0iR3VydSIgdHlwZWZhY2U9IlJhYXZpIi8+PGE6Zm9udCBzY3JpcHQ9IkNhbnMiIHR5cGVmYWNlPSJFdXBoZW1pYSIvPjxhOmZvbnQgc2NyaXB0PSJDaGVyIiB0eXBlZmFjZT0iUGxhbnRhZ2VuZXQgQ2hlcm9rZWUiLz48YTpmb250IHNjcmlwdD0iWWlpaSIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBZaSBCYWl0aSIvPjxhOmZvbnQgc2NyaXB0PSJUaWJ0IiB0eXBlZmFjZT0iTWljcm9zb2Z0IEhpbWFsYXlhIi8+PGE6Zm9udCBzY3JpcHQ9IlRoYWEiIHR5cGVmYWNlPSJNViBCb2xpIi8+PGE6Zm9udCBzY3JpcHQ9IkRldmEiIHR5cGVmYWNlPSJNYW5nYWwiLz48YTpmb250IHNjcmlwdD0iVGVsdSIgdHlwZWZhY2U9IkdhdXRhbWkiLz48YTpmb250IHNjcmlwdD0iVGFtbCIgdHlwZWZhY2U9IkxhdGhhIi8+PGE6Zm9udCBzY3JpcHQ9IlN5cmMiIHR5cGVmYWNlPSJFc3RyYW5nZWxvIEVkZXNzYSIvPjxhOmZvbnQgc2NyaXB0PSJPcnlhIiB0eXBlZmFjZT0iS2FsaW5nYSIvPjxhOmZvbnQgc2NyaXB0PSJNbHltIiB0eXBlZmFjZT0iS2FydGlrYSIvPjxhOmZvbnQgc2NyaXB0PSJMYW9vIiB0eXBlZmFjZT0iRG9rQ2hhbXBhIi8+PGE6Zm9udCBzY3JpcHQ9IlNpbmgiIHR5cGVmYWNlPSJJc2tvb2xhIFBvdGEiLz48YTpmb250IHNjcmlwdD0iTW9uZyIgdHlwZWZhY2U9Ik1vbmdvbGlhbiBCYWl0aSIvPjxhOmZvbnQgc2NyaXB0PSJWaWV0IiB0eXBlZmFjZT0iQXJpYWwiLz48YTpmb250IHNjcmlwdD0iVWlnaCIgdHlwZWZhY2U9Ik1pY3Jvc29mdCBVaWdodXIiLz48YTpmb250IHNjcmlwdD0iR2VvciIgdHlwZWZhY2U9IlN5bGZhZW4iLz48L2E6bWlub3JGb250PjwvYTpmb250U2NoZW1lPjxhOmZtdFNjaGVtZSBuYW1lPSJPZmZpY2UiPjxhOmZpbGxTdHlsZUxzdD48YTpzb2xpZEZpbGw+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiLz48L2E6c29saWRGaWxsPjxhOmdyYWRGaWxsIHJvdFdpdGhTaGFwZT0iMSI+PGE6Z3NMc3Q+PGE6Z3MgcG9zPSIwIj48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6dGludCB2YWw9IjUwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMzAwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PGE6Z3MgcG9zPSIzNTAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSIzNzAwMCIvPjxhOnNhdE1vZCB2YWw9IjMwMDAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOmdzPjxhOmdzIHBvcz0iMTAwMDAwIj48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6dGludCB2YWw9IjE1MDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOmxpbiBhbmc9IjE2MjAwMDAwIiBzY2FsZWQ9IjEiLz48L2E6Z3JhZEZpbGw+PGE6Z3JhZEZpbGwgcm90V2l0aFNoYXBlPSIxIj48YTpnc0xzdD48YTpncyBwb3M9IjAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iMTAwMDAwIi8+PGE6c2hhZGUgdmFsPSIxMDAwMDAiLz48YTpzYXRNb2QgdmFsPSIxMzAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48YTpncyBwb3M9IjEwMDAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSI1MDAwMCIvPjxhOnNoYWRlIHZhbD0iMTAwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOmxpbiBhbmc9IjE2MjAwMDAwIiBzY2FsZWQ9IjAiLz48L2E6Z3JhZEZpbGw+PC9hOmZpbGxTdHlsZUxzdD48YTpsblN0eWxlTHN0PjxhOmxuIHc9Ijk1MjUiIGNhcD0iZmxhdCIgY21wZD0ic25nIiBhbGduPSJjdHIiPjxhOnNvbGlkRmlsbD48YTpzY2hlbWVDbHIgdmFsPSJwaENsciI+PGE6c2hhZGUgdmFsPSI5NTAwMCIvPjxhOnNhdE1vZCB2YWw9IjEwNTAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOnNvbGlkRmlsbD48YTpwcnN0RGFzaCB2YWw9InNvbGlkIi8+PC9hOmxuPjxhOmxuIHc9IjI1NDAwIiBjYXA9ImZsYXQiIGNtcGQ9InNuZyIgYWxnbj0iY3RyIj48YTpzb2xpZEZpbGw+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiLz48L2E6c29saWRGaWxsPjxhOnByc3REYXNoIHZhbD0ic29saWQiLz48L2E6bG4+PGE6bG4gdz0iMzgxMDAiIGNhcD0iZmxhdCIgY21wZD0ic25nIiBhbGduPSJjdHIiPjxhOnNvbGlkRmlsbD48YTpzY2hlbWVDbHIgdmFsPSJwaENsciIvPjwvYTpzb2xpZEZpbGw+PGE6cHJzdERhc2ggdmFsPSJzb2xpZCIvPjwvYTpsbj48L2E6bG5TdHlsZUxzdD48YTplZmZlY3RTdHlsZUxzdD48YTplZmZlY3RTdHlsZT48YTplZmZlY3RMc3Q+PGE6b3V0ZXJTaGR3IGJsdXJSYWQ9IjQwMDAwIiBkaXN0PSIyMDAwMCIgZGlyPSI1NDAwMDAwIiByb3RXaXRoU2hhcGU9IjAiPjxhOnNyZ2JDbHIgdmFsPSIwMDAwMDAiPjxhOmFscGhhIHZhbD0iMzgwMDAiLz48L2E6c3JnYkNscj48L2E6b3V0ZXJTaGR3PjwvYTplZmZlY3RMc3Q+PC9hOmVmZmVjdFN0eWxlPjxhOmVmZmVjdFN0eWxlPjxhOmVmZmVjdExzdD48YTpvdXRlclNoZHcgYmx1clJhZD0iNDAwMDAiIGRpc3Q9IjIzMDAwIiBkaXI9IjU0MDAwMDAiIHJvdFdpdGhTaGFwZT0iMCI+PGE6c3JnYkNsciB2YWw9IjAwMDAwMCI+PGE6YWxwaGEgdmFsPSIzNTAwMCIvPjwvYTpzcmdiQ2xyPjwvYTpvdXRlclNoZHc+PC9hOmVmZmVjdExzdD48L2E6ZWZmZWN0U3R5bGU+PGE6ZWZmZWN0U3R5bGU+PGE6ZWZmZWN0THN0PjxhOm91dGVyU2hkdyBibHVyUmFkPSI0MDAwMCIgZGlzdD0iMjMwMDAiIGRpcj0iNTQwMDAwMCIgcm90V2l0aFNoYXBlPSIwIj48YTpzcmdiQ2xyIHZhbD0iMDAwMDAwIj48YTphbHBoYSB2YWw9IjM1MDAwIi8+PC9hOnNyZ2JDbHI+PC9hOm91dGVyU2hkdz48L2E6ZWZmZWN0THN0PjxhOnNjZW5lM2Q+PGE6Y2FtZXJhIHByc3Q9Im9ydGhvZ3JhcGhpY0Zyb250Ij48YTpyb3QgbGF0PSIwIiBsb249IjAiIHJldj0iMCIvPjwvYTpjYW1lcmE+PGE6bGlnaHRSaWcgcmlnPSJ0aHJlZVB0IiBkaXI9InQiPjxhOnJvdCBsYXQ9IjAiIGxvbj0iMCIgcmV2PSIxMjAwMDAwIi8+PC9hOmxpZ2h0UmlnPjwvYTpzY2VuZTNkPjxhOnNwM2Q+PGE6YmV2ZWxUIHc9IjYzNTAwIiBoPSIyNTQwMCIvPjwvYTpzcDNkPjwvYTplZmZlY3RTdHlsZT48L2E6ZWZmZWN0U3R5bGVMc3Q+PGE6YmdGaWxsU3R5bGVMc3Q+PGE6c29saWRGaWxsPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIi8+PC9hOnNvbGlkRmlsbD48YTpncmFkRmlsbCByb3RXaXRoU2hhcGU9IjEiPjxhOmdzTHN0PjxhOmdzIHBvcz0iMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnRpbnQgdmFsPSI0MDAwMCIvPjxhOnNhdE1vZCB2YWw9IjM1MDAwMCIvPjwvYTpzY2hlbWVDbHI+PC9hOmdzPjxhOmdzIHBvcz0iNDAwMDAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iNDUwMDAiLz48YTpzaGFkZSB2YWw9Ijk5MDAwIi8+PGE6c2F0TW9kIHZhbD0iMzUwMDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PGE6Z3MgcG9zPSIxMDAwMDAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTpzaGFkZSB2YWw9IjIwMDAwIi8+PGE6c2F0TW9kIHZhbD0iMjU1MDAwIi8+PC9hOnNjaGVtZUNscj48L2E6Z3M+PC9hOmdzTHN0PjxhOnBhdGggcGF0aD0iY2lyY2xlIj48YTpmaWxsVG9SZWN0IGw9IjUwMDAwIiB0PSItODAwMDAiIHI9IjUwMDAwIiBiPSIxODAwMDAiLz48L2E6cGF0aD48L2E6Z3JhZEZpbGw+PGE6Z3JhZEZpbGwgcm90V2l0aFNoYXBlPSIxIj48YTpnc0xzdD48YTpncyBwb3M9IjAiPjxhOnNjaGVtZUNsciB2YWw9InBoQ2xyIj48YTp0aW50IHZhbD0iODAwMDAiLz48YTpzYXRNb2QgdmFsPSIzMDAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48YTpncyBwb3M9IjEwMDAwMCI+PGE6c2NoZW1lQ2xyIHZhbD0icGhDbHIiPjxhOnNoYWRlIHZhbD0iMzAwMDAiLz48YTpzYXRNb2QgdmFsPSIyMDAwMDAiLz48L2E6c2NoZW1lQ2xyPjwvYTpncz48L2E6Z3NMc3Q+PGE6cGF0aCBwYXRoPSJjaXJjbGUiPjxhOmZpbGxUb1JlY3QgbD0iNTAwMDAiIHQ9IjUwMDAwIiByPSI1MDAwMCIgYj0iNTAwMDAiLz48L2E6cGF0aD48L2E6Z3JhZEZpbGw+PC9hOmJnRmlsbFN0eWxlTHN0PjwvYTpmbXRTY2hlbWU+PC9hOnRoZW1lRWxlbWVudHM+PGE6b2JqZWN0RGVmYXVsdHM+PGE6c3BEZWY+PGE6c3BQci8+PGE6Ym9keVByLz48YTpsc3RTdHlsZS8+PGE6c3R5bGU+PGE6bG5SZWYgaWR4PSIxIj48YTpzY2hlbWVDbHIgdmFsPSJhY2NlbnQxIi8+PC9hOmxuUmVmPjxhOmZpbGxSZWYgaWR4PSIzIj48YTpzY2hlbWVDbHIgdmFsPSJhY2NlbnQxIi8+PC9hOmZpbGxSZWY+PGE6ZWZmZWN0UmVmIGlkeD0iMiI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTplZmZlY3RSZWY+PGE6Zm9udFJlZiBpZHg9Im1pbm9yIj48YTpzY2hlbWVDbHIgdmFsPSJsdDEiLz48L2E6Zm9udFJlZj48L2E6c3R5bGU+PC9hOnNwRGVmPjxhOmxuRGVmPjxhOnNwUHIvPjxhOmJvZHlQci8+PGE6bHN0U3R5bGUvPjxhOnN0eWxlPjxhOmxuUmVmIGlkeD0iMiI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTpsblJlZj48YTpmaWxsUmVmIGlkeD0iMCI+PGE6c2NoZW1lQ2xyIHZhbD0iYWNjZW50MSIvPjwvYTpmaWxsUmVmPjxhOmVmZmVjdFJlZiBpZHg9IjEiPjxhOnNjaGVtZUNsciB2YWw9ImFjY2VudDEiLz48L2E6ZWZmZWN0UmVmPjxhOmZvbnRSZWYgaWR4PSJtaW5vciI+PGE6c2NoZW1lQ2xyIHZhbD0idHgxIi8+PC9hOmZvbnRSZWY+PC9hOnN0eWxlPjwvYTpsbkRlZj48L2E6b2JqZWN0RGVmYXVsdHM+PGE6ZXh0cmFDbHJTY2hlbWVMc3QvPjwvYTp0aGVtZT5QSwMEFAAAAAAAAAAAAFX0BJRaBAAAWgQAAA0AAAB4bC9zdHlsZXMueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPHN0eWxlU2hlZXQgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6dnQ9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L2RvY1Byb3BzVlR5cGVzIj48bnVtRm10cyBjb3VudD0iMSI+PG51bUZtdCBudW1GbXRJZD0iNTYiIGZvcm1hdENvZGU9IiZxdW90O+S4iuWNiC/kuIvljYggJnF1b3Q7aGgmcXVvdDvmmYImcXVvdDttbSZxdW90O+WIhiZxdW90O3NzJnF1b3Q756eSICZxdW90OyIvPjwvbnVtRm10cz48Zm9udHMgY291bnQ9IjEiPjxmb250PjxzeiB2YWw9IjEyIi8+PGNvbG9yIHRoZW1lPSIxIi8+PG5hbWUgdmFsPSJDYWxpYnJpIi8+PGZhbWlseSB2YWw9IjIiLz48c2NoZW1lIHZhbD0ibWlub3IiLz48L2ZvbnQ+PC9mb250cz48ZmlsbHMgY291bnQ9IjIiPjxmaWxsPjxwYXR0ZXJuRmlsbCBwYXR0ZXJuVHlwZT0ibm9uZSIvPjwvZmlsbD48ZmlsbD48cGF0dGVybkZpbGwgcGF0dGVyblR5cGU9ImdyYXkxMjUiLz48L2ZpbGw+PC9maWxscz48Ym9yZGVycyBjb3VudD0iMSI+PGJvcmRlcj48bGVmdC8+PHJpZ2h0Lz48dG9wLz48Ym90dG9tLz48ZGlhZ29uYWwvPjwvYm9yZGVyPjwvYm9yZGVycz48Y2VsbFN0eWxlWGZzIGNvdW50PSIxIj48eGYgbnVtRm10SWQ9IjAiIGZvbnRJZD0iMCIgZmlsbElkPSIwIiBib3JkZXJJZD0iMCIvPjwvY2VsbFN0eWxlWGZzPjxjZWxsWGZzIGNvdW50PSIxIj48eGYgbnVtRm10SWQ9IjAiIGZvbnRJZD0iMCIgZmlsbElkPSIwIiBib3JkZXJJZD0iMCIgeGZJZD0iMCIgYXBwbHlOdW1iZXJGb3JtYXQ9IjEiLz48L2NlbGxYZnM+PGNlbGxTdHlsZXMgY291bnQ9IjEiPjxjZWxsU3R5bGUgbmFtZT0iTm9ybWFsIiB4ZklkPSIwIiBidWlsdGluSWQ9IjAiLz48L2NlbGxTdHlsZXM+PGR4ZnMgY291bnQ9IjAiLz48dGFibGVTdHlsZXMgY291bnQ9IjAiIGRlZmF1bHRUYWJsZVN0eWxlPSJUYWJsZVN0eWxlTWVkaXVtOSIgZGVmYXVsdFBpdm90U3R5bGU9IlBpdm90U3R5bGVNZWRpdW00Ii8+PC9zdHlsZVNoZWV0PlBLAwQUAAAAAAAAAAAA5Sdo6jgCAAA4AgAAGAAAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4NCjx3b3Jrc2hlZXQgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6cj0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcyI+PGRpbWVuc2lvbiByZWY9IkExOkIyIi8+PHNoZWV0Vmlld3M+PHNoZWV0VmlldyB3b3JrYm9va1ZpZXdJZD0iMCIvPjwvc2hlZXRWaWV3cz48c2hlZXREYXRhPjxyb3cgcj0iMSI+PGMgcj0iQTEiIHQ9InN0ciI+PHY+Zm9vPC92PjwvYz48YyByPSJCMSIgdD0ic3RyIj48dj5iYXI8L3Y+PC9jPjwvcm93Pjxyb3cgcj0iMiI+PGMgcj0iQTIiIHQ9InN0ciI+PHY+MTwvdj48L2M+PGMgcj0iQjIiIHQ9InN0ciI+PHY+Mjwvdj48L2M+PC9yb3c+PC9zaGVldERhdGE+PGlnbm9yZWRFcnJvcnM+PGlnbm9yZWRFcnJvciBudW1iZXJTdG9yZWRBc1RleHQ9IjEiIHNxcmVmPSJBMTpCMiIvPjwvaWdub3JlZEVycm9ycz48L3dvcmtzaGVldD5QSwMEFAAAAAAAAAAAAGCAAIGIAwAAiAMAAA8AAAB4bC9tZXRhZGF0YS54bWw8P3htbCB2ZXJzaW9uPSIxLjAiIGVuY29kaW5nPSJVVEYtOCIgc3RhbmRhbG9uZT0ieWVzIj8+DQo8bWV0YWRhdGEgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9zcHJlYWRzaGVldG1sLzIwMDYvbWFpbiIgeG1sbnM6eGxyZD0iaHR0cDovL3NjaGVtYXMubWljcm9zb2Z0LmNvbS9vZmZpY2Uvc3ByZWFkc2hlZXRtbC8yMDE3L3JpY2hkYXRhIiB4bWxuczp4ZGE9Imh0dHA6Ly9zY2hlbWFzLm1pY3Jvc29mdC5jb20vb2ZmaWNlL3NwcmVhZHNoZWV0bWwvMjAxNy9keW5hbWljYXJyYXkiPgogIDxtZXRhZGF0YVR5cGVzIGNvdW50PSIxIj4KICAgIDxtZXRhZGF0YVR5cGUgbmFtZT0iWExEQVBSIiBtaW5TdXBwb3J0ZWRWZXJzaW9uPSIxMjAwMDAiIGNvcHk9IjEiIHBhc3RlQWxsPSIxIiBwYXN0ZVZhbHVlcz0iMSIgbWVyZ2U9IjEiIHNwbGl0Rmlyc3Q9IjEiIHJvd0NvbFNoaWZ0PSIxIiBjbGVhckZvcm1hdHM9IjEiIGNsZWFyQ29tbWVudHM9IjEiIGFzc2lnbj0iMSIgY29lcmNlPSIxIiBjZWxsTWV0YT0iMSIvPgogIDwvbWV0YWRhdGFUeXBlcz4KICA8ZnV0dXJlTWV0YWRhdGEgbmFtZT0iWExEQVBSIiBjb3VudD0iMSI+CiAgICA8Yms+CiAgICAgIDxleHRMc3Q+CiAgICAgICAgPGV4dCB1cmk9IntiZGJiOGNkYy1mYTFlLTQ5NmUtYTg1Ny0zYzNmMzBjMDI5YzN9Ij4KICAgICAgICAgIDx4ZGE6ZHluYW1pY0FycmF5UHJvcGVydGllcyBmRHluYW1pYz0iMSIgZkNvbGxhcHNlZD0iMCIvPgogICAgICAgIDwvZXh0PgogICAgICA8L2V4dExzdD4KICAgIDwvYms+CiAgPC9mdXR1cmVNZXRhZGF0YT4KICA8Y2VsbE1ldGFkYXRhIGNvdW50PSIxIj4KICAgIDxiaz4KICAgICAgPHJjIHQ9IjEiIHY9IjAiLz4KICAgIDwvYms+CiAgPC9jZWxsTWV0YWRhdGE+CjwvbWV0YWRhdGE+UEsDBBQAAAAAAAAAAADm69RCSwEAAEsBAAAPAAAAeGwvd29ya2Jvb2sueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPHdvcmtib29rIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvc3ByZWFkc2hlZXRtbC8yMDA2L21haW4iIHhtbG5zOnI9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMiPjx3b3JrYm9va1ByIGNvZGVOYW1lPSJUaGlzV29ya2Jvb2siLz48c2hlZXRzPjxzaGVldCBuYW1lPSLpmo/kvr/kuIDlvKDooagiIHNoZWV0SWQ9IjEiIHI6aWQ9InJJZDEiLz48L3NoZWV0cz48L3dvcmtib29rPlBLAwQUAAAAAAAAAAAASmoR+UwCAABMAgAACwAAAF9yZWxzLy5yZWxzPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPFJlbGF0aW9uc2hpcHMgeG1sbnM9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9wYWNrYWdlLzIwMDYvcmVsYXRpb25zaGlwcyI+PFJlbGF0aW9uc2hpcCBJZD0icklkMiIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9yZWxhdGlvbnNoaXBzL21ldGFkYXRhL2NvcmUtcHJvcGVydGllcyIgVGFyZ2V0PSJkb2NQcm9wcy9jb3JlLnhtbCIvPjxSZWxhdGlvbnNoaXAgSWQ9InJJZDMiIFR5cGU9Imh0dHA6Ly9zY2hlbWFzLm9wZW54bWxmb3JtYXRzLm9yZy9vZmZpY2VEb2N1bWVudC8yMDA2L3JlbGF0aW9uc2hpcHMvZXh0ZW5kZWQtcHJvcGVydGllcyIgVGFyZ2V0PSJkb2NQcm9wcy9hcHAueG1sIi8+PFJlbGF0aW9uc2hpcCBJZD0icklkMSIgVHlwZT0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvcmVsYXRpb25zaGlwcy9vZmZpY2VEb2N1bWVudCIgVGFyZ2V0PSJ4bC93b3JrYm9vay54bWwiLz48L1JlbGF0aW9uc2hpcHM+UEsDBBQAAAAAAAAAAACOdyfoOwIAADsCAAAQAAAAZG9jUHJvcHMvYXBwLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4NCjxQcm9wZXJ0aWVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvb2ZmaWNlRG9jdW1lbnQvMjAwNi9leHRlbmRlZC1wcm9wZXJ0aWVzIiB4bWxuczp2dD0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL29mZmljZURvY3VtZW50LzIwMDYvZG9jUHJvcHNWVHlwZXMiPjxBcHBsaWNhdGlvbj5TaGVldEpTPC9BcHBsaWNhdGlvbj48SGVhZGluZ1BhaXJzPjx2dDp2ZWN0b3Igc2l6ZT0iMiIgYmFzZVR5cGU9InZhcmlhbnQiPjx2dDp2YXJpYW50Pjx2dDpscHN0cj5Xb3Jrc2hlZXRzPC92dDpscHN0cj48L3Z0OnZhcmlhbnQ+PHZ0OnZhcmlhbnQ+PHZ0Omk0PjE8L3Z0Omk0PjwvdnQ6dmFyaWFudD48L3Z0OnZlY3Rvcj48L0hlYWRpbmdQYWlycz48VGl0bGVzT2ZQYXJ0cz48dnQ6dmVjdG9yIHNpemU9IjEiIGJhc2VUeXBlPSJscHN0ciI+PHZ0Omxwc3RyPumaj+S+v+S4gOW8oOihqDwvdnQ6bHBzdHI+PC92dDp2ZWN0b3I+PC9UaXRsZXNPZlBhcnRzPjwvUHJvcGVydGllcz5QSwMEFAAAAAAAAAAAANaSfBFaAQAAWgEAABEAAABkb2NQcm9wcy9jb3JlLnhtbDw/eG1sIHZlcnNpb249IjEuMCIgZW5jb2Rpbmc9IlVURi04IiBzdGFuZGFsb25lPSJ5ZXMiPz4NCjxjcDpjb3JlUHJvcGVydGllcyB4bWxuczpjcD0iaHR0cDovL3NjaGVtYXMub3BlbnhtbGZvcm1hdHMub3JnL3BhY2thZ2UvMjAwNi9tZXRhZGF0YS9jb3JlLXByb3BlcnRpZXMiIHhtbG5zOmRjPSJodHRwOi8vcHVybC5vcmcvZGMvZWxlbWVudHMvMS4xLyIgeG1sbnM6ZGN0ZXJtcz0iaHR0cDovL3B1cmwub3JnL2RjL3Rlcm1zLyIgeG1sbnM6ZGNtaXR5cGU9Imh0dHA6Ly9wdXJsLm9yZy9kYy9kY21pdHlwZS8iIHhtbG5zOnhzaT0iaHR0cDovL3d3dy53My5vcmcvMjAwMS9YTUxTY2hlbWEtaW5zdGFuY2UiLz5QSwMEFAAAAAAAAAAAAKjXaoAVCAAAFQgAABMAAABbQ29udGVudF9UeXBlc10ueG1sPD94bWwgdmVyc2lvbj0iMS4wIiBlbmNvZGluZz0iVVRGLTgiIHN0YW5kYWxvbmU9InllcyI/Pg0KPFR5cGVzIHhtbG5zPSJodHRwOi8vc2NoZW1hcy5vcGVueG1sZm9ybWF0cy5vcmcvcGFja2FnZS8yMDA2L2NvbnRlbnQtdHlwZXMiIHhtbG5zOnhzZD0iaHR0cDovL3d3dy53My5vcmcvMjAwMS9YTUxTY2hlbWEiIHhtbG5zOnhzaT0iaHR0cDovL3d3dy53My5vcmcvMjAwMS9YTUxTY2hlbWEtaW5zdGFuY2UiPjxEZWZhdWx0IEV4dGVuc2lvbj0ieG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24veG1sIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJiaW4iIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQubXMtZXhjZWwuc2hlZXQuYmluYXJ5Lm1hY3JvRW5hYmxlZC5tYWluIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ2bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQudm1sRHJhd2luZyIvPjxEZWZhdWx0IEV4dGVuc2lvbj0iZGF0YSIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5tb2RlbCtkYXRhIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJibXAiIENvbnRlbnRUeXBlPSJpbWFnZS9ibXAiLz48RGVmYXVsdCBFeHRlbnNpb249InBuZyIgQ29udGVudFR5cGU9ImltYWdlL3BuZyIvPjxEZWZhdWx0IEV4dGVuc2lvbj0iZ2lmIiBDb250ZW50VHlwZT0iaW1hZ2UvZ2lmIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJlbWYiIENvbnRlbnRUeXBlPSJpbWFnZS94LWVtZiIvPjxEZWZhdWx0IEV4dGVuc2lvbj0id21mIiBDb250ZW50VHlwZT0iaW1hZ2UveC13bWYiLz48RGVmYXVsdCBFeHRlbnNpb249ImpwZyIgQ29udGVudFR5cGU9ImltYWdlL2pwZWciLz48RGVmYXVsdCBFeHRlbnNpb249ImpwZWciIENvbnRlbnRUeXBlPSJpbWFnZS9qcGVnIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ0aWYiIENvbnRlbnRUeXBlPSJpbWFnZS90aWZmIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJ0aWZmIiBDb250ZW50VHlwZT0iaW1hZ2UvdGlmZiIvPjxEZWZhdWx0IEV4dGVuc2lvbj0icGRmIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vcGRmIi8+PERlZmF1bHQgRXh0ZW5zaW9uPSJyZWxzIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLXBhY2thZ2UucmVsYXRpb25zaGlwcyt4bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii94bC93b3JrYm9vay54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQuc3ByZWFkc2hlZXRtbC5zaGVldC5tYWluK3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL3dvcmtzaGVldHMvc2hlZXQxLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5zcHJlYWRzaGVldG1sLndvcmtzaGVldCt4bWwiLz48T3ZlcnJpZGUgUGFydE5hbWU9Ii94bC90aGVtZS90aGVtZTEueG1sIiBDb250ZW50VHlwZT0iYXBwbGljYXRpb24vdm5kLm9wZW54bWxmb3JtYXRzLW9mZmljZWRvY3VtZW50LnRoZW1lK3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL3N0eWxlcy54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtb2ZmaWNlZG9jdW1lbnQuc3ByZWFkc2hlZXRtbC5zdHlsZXMreG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIvZG9jUHJvcHMvY29yZS54bWwiIENvbnRlbnRUeXBlPSJhcHBsaWNhdGlvbi92bmQub3BlbnhtbGZvcm1hdHMtcGFja2FnZS5jb3JlLXByb3BlcnRpZXMreG1sIi8+PE92ZXJyaWRlIFBhcnROYW1lPSIvZG9jUHJvcHMvYXBwLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5leHRlbmRlZC1wcm9wZXJ0aWVzK3htbCIvPjxPdmVycmlkZSBQYXJ0TmFtZT0iL3hsL21ldGFkYXRhLnhtbCIgQ29udGVudFR5cGU9ImFwcGxpY2F0aW9uL3ZuZC5vcGVueG1sZm9ybWF0cy1vZmZpY2Vkb2N1bWVudC5zcHJlYWRzaGVldG1sLnNoZWV0TWV0YWRhdGEreG1sIi8+PC9UeXBlcz5QSwECAAAUAAAAAAAAAAAApAGEuLUCAAC1AgAAGgAAAAAAAAAAAAAAAAAAAAAAeGwvX3JlbHMvd29ya2Jvb2sueG1sLnJlbHNQSwECAAAUAAAAAAAAAAAAMA+Ia94dAADeHQAAEwAAAAAAAAAAAAAAAADtAgAAeGwvdGhlbWUvdGhlbWUxLnhtbFBLAQIAABQAAAAAAAAAAABV9ASUWgQAAFoEAAANAAAAAAAAAAAAAAAAAPwgAAB4bC9zdHlsZXMueG1sUEsBAgAAFAAAAAAAAAAAAOUnaOo4AgAAOAIAABgAAAAAAAAAAAAAAAAAgSUAAHhsL3dvcmtzaGVldHMvc2hlZXQxLnhtbFBLAQIAABQAAAAAAAAAAABggACBiAMAAIgDAAAPAAAAAAAAAAAAAAAAAO8nAAB4bC9tZXRhZGF0YS54bWxQSwECAAAUAAAAAAAAAAAA5uvUQksBAABLAQAADwAAAAAAAAAAAAAAAACkKwAAeGwvd29ya2Jvb2sueG1sUEsBAgAAFAAAAAAAAAAAAEpqEflMAgAATAIAAAsAAAAAAAAAAAAAAAAAHC0AAF9yZWxzLy5yZWxzUEsBAgAAFAAAAAAAAAAAAI53J+g7AgAAOwIAABAAAAAAAAAAAAAAAAAAkS8AAGRvY1Byb3BzL2FwcC54bWxQSwECAAAUAAAAAAAAAAAA1pJ8EVoBAABaAQAAEQAAAAAAAAAAAAAAAAD6MQAAZG9jUHJvcHMvY29yZS54bWxQSwECAAAUAAAAAAAAAAAAqNdqgBUIAAAVCAAAEwAAAAAAAAAAAAAAAACDMwAAW0NvbnRlbnRfVHlwZXNdLnhtbFBLBQYAAAAACgAKAHsCAADJOwAAAAA=';

  // 芒果店长待发货订单样本（base64 在构建期由真实 xlsx 生成后插入 —— 解析路径必须真的走一遍 xlsx）
  var XLSX_MANGO_B64 = '${XLSX_MANGO_B64}';

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
      // 主干一个读口：导入行与采集行在同一个返回里（按 source 区分）
      return { success: true, data: window.__emptyOrders ? [] : IMPORTED.concat(COLLECTED) };
    },

    // 待拣：两行未发货（款 S1 黑 L 各 1 件；不给出块 → 按 1 件并标缺）
    'pickingRows': function (p) {
      rec('pickingRows', p);
      if (window.__emptyOrders) return { success: true, data: { rows: [], meta: { rows: 0, limit: 2000 } } };
      return { success: true, data: { rows: [
        { id: 1, orderNo: 'I-1', shop: '店A', orderTime: daysAgo(1) + ' 10:00:00', styleCode: 'S1', styleColor: '红',
          color: '黑', size: 'L', itemId: 'ITEM1', supplierId: 7, supplierName: '厂A', imagePath: '/tmp/a.jpg',
          shipped: false, bizStatus: '等待发货', rawFields: { '商品信息': '【1】 某款 (商品数量:1 piece)' } },
        { id: 2, orderNo: 'I-2', shop: '店A', orderTime: daysAgo(1) + ' 11:00:00', styleCode: 'S1', styleColor: '红',
          color: '黑', size: 'L', itemId: 'ITEM1', supplierId: 7, supplierName: '厂A', imagePath: '/tmp/a.jpg',
          shipped: false, bizStatus: '等待发货', rawFields: { '商品信息': '【1】 某款 (商品数量:2 piece)' } },
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
      return { success: true, data: window.__noPurchaseOrders ? [] : PURCHASE_ORDERS };
    },
    // ⚠️ 按 id 查：返回"第一条"会把"点了 #2 却打开 #3"这类错掩盖掉
    'purchaseOrderGet': function (p) {
      rec('purchaseOrderGet', p);
      var hit = PURCHASE_ORDERS.filter(function (o) { return o.id === Number(p && p.id); })[0];
      return hit ? { success: true, data: hit } : { success: false, error: '拿货单不存在' };
    },
    'purchaseOrderCreate': function (p) { rec('purchaseOrderCreate', p); return { success: true, data: { id: 99 } }; },
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

    // ---- 对账域（2026-10-05「结算对账」页签内建）----
    // 三行账**故意不同型**：厂A 欠 40.00（已付 80 / 拿货 120）、厂B 欠 520.00（拿货 500 / 退 20）
    //  ⇒ 四个合计各自都不等于 0，且**合计 ≠ 任一单行**（若实现只显示最后一行，断言会红）。
    'purchasePaymentList': function (p) { rec('purchasePaymentList', p); return { success: true, data: PAYMENTS }; },
    'purchasePaymentAdd': function (p) { rec('purchasePaymentAdd', p); return { success: true, data: { id: 77 } }; },
    'purchasePaymentDelete': function (p) { rec('purchasePaymentDelete', p); return { success: true }; },
    'purchaseReconciliation': function (p) { rec('purchaseReconciliation', p); return { success: true, data: RECON }; },
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
      var rows = PENDING_ORDERS.filter(function (o) { return gone.indexOf(o.id) < 0; });
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
    'orderStyleAssign': function (p) { rec('orderStyleAssign', p); return { success: true, data: { styleCode: 'S2', styleColorCode: 'S2-黑', skuBackfill: { status: 'written', reassigned: 2, spec: '黑', conflictCode: '' } } }; },
    'orderMarkCorrected': function (p) {
      rec('orderMarkCorrected', p);
      if (Array.isArray(p)) p.forEach(markCorrectedIfEmulating);
      return { success: true, data: { updated: Array.isArray(p) ? p.length : 2 } };
    },
    'orderImageThumbBatch': function (p) {
      rec('orderImageThumbBatch', p);
      // ⚠️ 载荷是**裸数组**（orderImageThumbBatch(items)，见 src/types.ts 声明）；
      //    归一成 {items} 发生在 preload 里，而假桥替的就是 preload 上面那一层。
      //    写成 p.items ⇒ 恒空数组 ⇒ 缩略图永远是空占位，"图列"那条断言等于没验。
      var items = Array.isArray(p) ? p : (p && p.items) || [];
      // 给**每一条**都回一个极小的 GIF dataUrl：只有真的渲染出 <img>，才说明缩略图链路接上了
      return { success: true, data: { dataUrls: items.map(function () {
        return 'data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7';
      }) } };
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

/**
 * 回执的「下一步」按钮**必须指向真实存在的模块**（id 写错 = 点了没反应，且不报错）。
 *
 * 抽成函数是为了在**两个场景**都跑：订单回执按"店铺已归属 / 未归属"给**两组不同按钮**，
 * 只测一组等于只覆盖一半 —— 实测把它们合并成一条断言、只在其中一个场景跑时，
 * 把**已归属**那组的 id 改错，订单报表场景照样全绿（漏的正是芒果那条路径）。
 */
function checkNextTargets(tag) {
  var btns = queryAll('[data-act="import-next"] button');
  var bad = btns.filter(function (b) {
    var id = (b.getAttribute('data-act') || '').replace('import-next-', '');
    return KNOWN_MODULES.indexOf(id) < 0 || flat(b).length === 0;
  });
  report('回执的「下一步」按钮都指向真实模块、且都带文字（' + tag + '）',
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
 * ⚠️ 各页签的「.pk-view」/「.oc-view」是**内嵌视图自己的根类**（复用整页视图，只是藏了页头），
 *    用它当"这个面板挂上了"的判据，比找某个按钮稳（按钮会跟数据走，空库时不存在）。
 */
var PANEL_SEL = {
  overview: '[data-act="flow"]',
  import: '[data-act="import"]',
  classify: '[data-act="classify-panel"]',
  picking: '.pk-view',
  cost: '.oc-view',
  purchase: '.pu-view',
  recon: '[data-act="recon-panel"]',
};
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
    // 页签栏（2026-10-05「发货台」改造）：六步 + 总览 = 七个。
    // ⚠️ 「懒加载」也要验：只断言"页签在"不够 —— 面板若是全量挂载，七个整页视图
    //    （拣货 / 算钱各上千行、各自取数）会在进页面时一起跑，表现是打开就很慢。
    var tabIds = ['overview', 'import', 'classify', 'picking', 'cost', 'purchase', 'recon'];
    report('页签栏：七个页签齐全（总览 + 六步）',
      tabIds.every(function (id) { return !!tabEl(id); }),
      tabIds.map(function (id) { return id + '=' + !!tabEl(id); }).join(' '));
    report('进入页面默认落在「总览」', onTab('overview'), '');
    report('懒加载：还没点过的页签，面板一个都没挂载（DOM 里查不到）',
      !document.querySelector('.oc-view') && !document.querySelector('.pu-view') &&
        !document.querySelector('[data-act="classify-panel"]') &&
        !document.querySelector('[data-act="recon-panel"]'), '');

    step('flow');
    // 发货主线（2026-10-05「发货台」改造后）：**六步**齐全 + 每步标明"在本页哪个页签做"
    //   + 当前步高亮 + 「下一步」是切页签（不再跳模块）。
    //   ⚠️ 这段会点一次 flow-next，**必须清掉 __events**，
    //   否则后面按 evts('switch-module')[0] 取的断言会读到我这条（假红）。
    var flowKeys = ['import', 'classify', 'picking', 'cost', 'purchase', 'recon'];
    await waitFor(function () {
      var el = card('flow-classify');
      return !!el && flat(el).indexOf('未识别款') >= 0;   // 等到 gaps 也算出来（flow 依赖它）
    }, 8000);
    report('发货主线：六步齐全（导入 / 归类 / 拣货 / 算钱 / 拿货 / 对账）',
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
        flat(card('flow-picking')).indexOf('拣货') >= 0 &&
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
        card('flow-picking').className.indexOf('is-todo') >= 0 &&
        card('flow-cost').className.indexOf('is-todo') >= 0 &&
        flat(card('flow-picking')).indexOf('等第 2 步') >= 0 &&
        flat(card('flow-cost')).indexOf('等第 2 步') >= 0,
      '高亮数=' + queryAll('.td-flow__step.is-now, .td-flow__step.is-gap').length +
        ' | ' + [card('flow-picking'), card('flow-cost')].map(function (el) { return flat(el); }).join(' | '));
    report('「下一步」按钮跟着当前步走（当前步 = 归类核对）',
      !!document.querySelector('[data-act="flow-next-classify"]'),
      card('flow-next') ? flat(card('flow-next')) : 'no-next');
    report('六步全部在本页页签里（流程卡不再有"在插件里"的步骤、也不给"去插件"的岔路）',
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

    step('picking');
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

    // 「数据去哪了」—— 这是回执存在的首要理由
    //（2026-10-05 用户实报：导完不知道接下来做什么，也不知道数据去哪了）
    var ordLanded = flat(document.querySelector('[data-act="import-landed"]'));
    report('回执回答"数据去哪了"：落到订单，并列出能看到它的三处页面',
      ordLanded.indexOf('订单') >= 0 && ordLanded.indexOf('拣货') >= 0 && ordLanded.indexOf('算钱') >= 0,
      ordLanded);

    // 「接下来做什么」—— 按钮必须指向**真实存在的模块**（id 写错 = 点了没反应，且不报错）。
    // 这一场是"店铺未归属"那组按钮；"已归属"那组在下面的芒果步里另测一次。
    checkNextTargets('订单报表·店铺未归属');
    report('订单报表的主操作是「生成待拣清单」（导完订单的下一步就是拣货）',
      flat(document.querySelector('button[data-act="import-next-picking"]')).indexOf('待拣') >= 0,
      flat(document.querySelector('button[data-act="import-next-picking"]')));

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
    // 待发货订单 = 下一步就是拣货：主操作必须是它，且指向 picking
    // （这一场是"店铺已归属"那组按钮 —— 与上面订单报表那组**不是同一条代码路径**）
    checkNextTargets('芒果店长待发货订单·店铺已归属');
    report('芒果待发货订单的下一步是「生成待拣清单」（指向 picking）',
      !!document.querySelector('button[data-act="import-next-picking"]') &&
        flat(document.querySelector('button[data-act="import-next-picking"]')).indexOf('待拣') >= 0,
      flat(document.querySelector('[data-act="import-next"]')));

    // 回执是**常驻**的（不是一闪而过的 toast），用户处理完要能关掉；关掉必须真的消失，不留空壳
    var dismiss = document.querySelector('[data-act="import-dismiss"]');
    if (dismiss) {
      dismiss.click();
      try { await waitFor(function () { return !document.querySelector('[data-act="import-result"]'); }, 4000); } catch (e) {}
    }
    report('回执可关掉，且关掉后卡片真的消失',
      !!dismiss && !document.querySelector('[data-act="import-result"]'), String(!!dismiss));

    step('empty');
    // 空态：给的是"动作"，不是一句"暂无数据"；而且动作必须是**宿主自己能做的那一步**
    // （S2-b 起宿主能直接导订单报表 —— 旧按钮把用户送去装「订单归类」，指向已过时）
    await activateTab('overview');
    window.__emptyOrders = true;
    document.querySelector('[data-act="refresh"]').click();
    await waitFor(function () {
      var el = card('card-orders');
      return el && flat(el).indexOf('还没有订单数据') >= 0;
    }, 8000);
    var emptyCard = flat(card('card-orders'));
    report('无订单时：空态卡说明两条来源并给出下一步按钮',
      !!card('card-orders').querySelector('button[data-act="empty-import"]') &&
        emptyCard.indexOf('来源①') >= 0, emptyCard);
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
    // ⚠️ 改造后这里**不再跳页**：点「生成待拣清单」= 切到「生成拣货单」页签，人一直停在「今天」。
    window.__emptyOrders = false;
    document.querySelector('[data-act="refresh"]').click();
    await waitFor(function () { return card('card-picking') && card('card-picking').querySelector('button[data-act="go-picking"]'); }, 8000);
    var swBeforeNav = evts('switch-module').length;
    card('card-picking').querySelector('button[data-act="go-picking"]').click();
    await waitFor(function () { return onTab('picking') && !!document.querySelector(PANEL_SEL.picking); }, 8000);
    report('「生成待拣清单」= 切到「生成拣货单」页签（就地切换）',
      onTab('picking') && !!document.querySelector('.pk-view'), '');
    report('全程没有派发 switch-module（页面始终没离开「今天」）',
      evts('switch-module').length === swBeforeNav,
      'switch-module=' + evts('switch-module').length);

    step('keepalive');
    // **"丝滑"的判据**：切走再切回，面板是**同一个 DOM 实例**（KeepAlive 保活），不是重新挂载。
    // ⚠️ 只在 DOM 上打个标记来验 —— 断言"取了数"不够（重挂载也会取数），
    //    而"节点还是那一个"是保活的直接证据。标记跟着缓存的 DOM 走，重挂载就丢。
    var pkEl = document.querySelector('.pk-view');
    var mark = 'KEEP' + Math.random();
    pkEl.__keepMark = mark;
    await activateTab('cost');
    await activateTab('picking');
    var pkBack = document.querySelector('.pk-view');
    report('切走再切回：拣货面板是**同一个 DOM 实例**（KeepAlive 保活，界面不重建）',
      !!pkBack && pkBack.__keepMark === mark, 'mark=' + String(pkBack && pkBack.__keepMark));
    report('「算钱」面板也已经挂上过（两个内嵌整页视图在同一页里共存）',
      !!document.querySelector('[data-act="tab-cost"]'), '');

    step('refresh-link');
    // **保活的代价必须还回去**：导入新订单后，已经生成过的拣货单要跟着重算
    // （否则用户切回拣货页签，看到的是"导入之前"那份清单，还以为没生效）。
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
    await activateTab('picking');
    try {
      await waitFor(function () { return pickingGenCalls().length > genAfter; }, 8000);
    } catch (e) { /* 下面 report 给结论 */ }
    report('导入订单后已生成的拣货单自动重算（token 联动，保活不会让用户看到旧清单）',
      pickingGenCalls().length > genAfter,
      '拣货面板的 pickingRows: 生成后=' + genAfter + ' 导入后=' + pickingGenCalls().length);

    step('purchase');
    // 「拿货」页签（2026-10-05 内建）。数据层全是宿主现成的 purchase* 通道，界面是本轮新写的。
    // 断言纪律：① 数字钉在 data-act 上、按真夹具逐格核；② 每个按钮断言**它发出的 IPC 入参**
    //（这是唯一能抓"点了没反应 / 发给了别的通道"的手段）；③ 确认弹层要断言**确认前一个请求都不发**。
    await activateTab('purchase');
    await waitFor(function () {
      return flat(card('pu-stats')).indexOf('拿货单') >= 0 && calls('purchaseOrderList').length >= 1;
    }, 10000);

    report('拿货指标条：四个计数来自真取数（拿货单 2 / 草稿 1 / 缺口 1 / 已忽略 1）',
      flat(card('pu-stats')).indexOf('拿货单 2') >= 0 && flat(card('pu-stats')).indexOf('草稿 1') >= 0 &&
        flat(card('pu-stats')).indexOf('待拿货缺口 1') >= 0 && flat(card('pu-stats')).indexOf('已忽略 1') >= 0,
      flat(card('pu-stats')));
    report('默认落在「待拿货缺口」（这一步的动词是"去拿货"，缺口才是入口）',
      card('pu-sub-gap').className.indexOf('is-on') >= 0 && !!card('pu-gap-table'), '');
    report('缺口按款色码列全（S1 · 黑 · L），三列数字各就各位（需求 / 已拿 / 还差）',
      (function () {
        var t = flat(card('pu-gap-table'));
        return t.indexOf('S1') >= 0 && t.indexOf('款一') >= 0 && t.indexOf('黑') >= 0 &&
          t.indexOf('需求') >= 0 && t.indexOf('已拿') >= 0 && t.indexOf('还差') >= 0;
      })(),
      flat(card('pu-gap-table')));
    report('缺口默认全勾（进这一步就是"这些是还差的货"；要少拿自己取消勾选）',
      !!card('pu-gap-pick-0') && card('pu-gap-pick-0').checked === true, '');
    // ⚠️ **默认值不能靠位置**：厂家下拉不许预选第一个 —— 夹具里故意放两个厂，
    //    否则"预选第一个"与"不预选"在只有一个选项时看起来一模一样，守卫恒绿。
    report('厂家不预选（下拉停在"选择厂家…"，不是第一个选项）',
      !!card('pu-supplier') && card('pu-supplier').value === '0' && card('pu-supplier').options.length === 3,
      card('pu-supplier') ? 'value=' + card('pu-supplier').value + ' options=' + card('pu-supplier').options.length : 'no-select');
    report('没选厂家时「生成拿货单」是禁用的（不允许开出无主单）',
      !!card('pu-create-from-gap') && card('pu-create-from-gap').disabled === true, '');
    report('已忽略清单照实显示（S9 · 蓝 · 已线下拿）',
      !!card('pu-ignore-table') && flat(card('pu-ignore-table')).indexOf('已线下拿') >= 0,
      card('pu-ignore-table') ? flat(card('pu-ignore-table')) : 'no-table');

    // ---- 拿货单视图 ----
    card('pu-sub-orders').click();
    await waitFor(function () { return !!card('pu-order-table'); }, 6000);
    report('拿货单表：两张单都在，状态与金额逐格对（12000 分 → ¥120.00）',
      (function () {
        var t = flat(card('pu-order-table'));
        return t.indexOf('厂A') >= 0 && t.indexOf('厂B') >= 0 && t.indexOf('草稿') >= 0 &&
          t.indexOf('已提交') >= 0 && t.indexOf('¥120.00') >= 0 && t.indexOf('¥500.00') >= 0;
      })(),
      flat(card('pu-order-table')));
    report('只有草稿给「提交」（已提交的单不该出现提交按钮）',
      !!card('pu-submit-3') && !card('pu-submit-2'), '');

    // ---- 编辑器：真取单、真算、真提交（分 ↔ 元）----
    card('pu-edit-3').click();
    await waitFor(function () { return !!card('pu-editor'); }, 6000);
    report('「查看 / 编辑」去取的是**这一张**（purchaseOrderGet {id:3}）',
      calls('purchaseOrderGet').length >= 1 && calls('purchaseOrderGet')[0].id === 3 && !!card('pue-table'),
      JSON.stringify(calls('purchaseOrderGet')[0] || {}));
    report('编辑器里明细金额真算（2 件 × 60.00 = ¥120.00）',
      flat(card('pue-total')).indexOf('120.00') >= 0, flat(card('pue-total')));
    // 模式创建时定死（宿主 update 不收 mode）⇒ 界面**不给**改不动的下拉框（那是假动作）
    report('模式是只读的（不给"改不动的下拉框"）',
      !card('pue-mode') && flat(card('pu-editor')).indexOf('明细') >= 0, '');

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
      flat(card('confirm-dialog')).indexOf('已拿') >= 0 && flat(card('confirm-dialog')).indexOf('对账') >= 0,
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
    report('删除的确认里说明白了"已拿数量会回滚、缺口会回升"（不可逆要讲后果）',
      flat(card('confirm-dialog')).indexOf('回升') >= 0, flat(card('confirm-dialog')));
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
    report('导出：出参是这张单的明细 + 默认文件名（少了图就查不到款色）',
      okExp && (ex.items || []).length === 1 && (ex.items || [])[0].styleCode === 'S1' &&
        (ex.items || [])[0].color === '黑' && !!ex.defaultName,
      JSON.stringify(ex));

    // ---- 按勾选生成草稿（拿货的主路径）----
    card('pu-sub-gap').click();
    await waitFor(function () { return !!card('pu-gap-table'); }, 4000);
    var sel = card('pu-supplier');
    sel.value = '7';
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    await new Promise(function (r) { setTimeout(r, 60); });
    var crBefore = calls('purchaseOrderCreate').length;
    card('pu-create-from-gap').click();
    var okCreate = true;
    try { await waitFor(function () { return calls('purchaseOrderCreate').length > crBefore; }, 6000); }
    catch (e) { okCreate = false; }
    var cr = calls('purchaseOrderCreate')[crBefore] || {};
    var crItem = (cr.items || [])[0] || {};
    report('按勾选生成：出参带厂家 + 日期 + 明细（qty = 缺口、单价留 0 待填、建议数量 = 缺口）',
      okCreate && cr.supplierId === 7 && !!cr.bizDate && crItem.styleCode === 'S1' &&
        crItem.qty === 2 && crItem.priceCents === 0 && crItem.suggestionQty === 2 && crItem.color === '黑',
      JSON.stringify(cr));
    var okSwitch = true;
    try {
      await waitFor(function () { return card('pu-sub-orders').className.indexOf('is-on') >= 0; }, 4000);
    } catch (e) { okSwitch = false; }
    report('生成后自动切到「拿货单」视图（下一步就是填单价，不让用户再找）', okSwitch, '');

    // ---- 忽略：原因要用户敲字 ⇒ **必须自绘弹层**（Electron 没有 window.prompt）----
    card('pu-sub-gap').click();
    await waitFor(function () { return !!card('pu-ignore-0'); }, 4000);
    card('pu-ignore-0').click();
    await waitFor(function () { return !!card('pu-ignore-reason'); }, 4000);
    report('忽略走自绘弹层并给了原因输入框（不是在用 window.prompt）',
      !!card('pu-ignore-reason') && !!card('confirm-ok'), '');
    var reasonEl = card('pu-ignore-reason');
    reasonEl.value = '已线下拿';
    reasonEl.dispatchEvent(new Event('input', { bubbles: true }));
    var igBefore = calls('purchaseIgnoreAdd').length;
    await confirmOk();
    var okIg = true;
    try { await waitFor(function () { return calls('purchaseIgnoreAdd').length > igBefore; }, 6000); }
    catch (e) { okIg = false; }
    var iga = calls('purchaseIgnoreAdd')[igBefore] || {};
    report('忽略出参：款编码 + 款色 + 用户敲的原因（按款色整组生效）',
      okIg && iga.styleCode === 'S1' && iga.color === '黑' && iga.reason === '已线下拿',
      JSON.stringify(iga));

    // ---- 空态：不许留空白，要说清"为什么空 / 去哪做" ----
    // ⚠️ 容器的「刷新」必须**作废各面板缓存**（token+1）——只重算汇总不刷面板的话，
    //    面板会一直显示旧数据（这正是本轮顺手缝掉的缝）。所以这里点刷新就能看到新状态。
    window.__noGap = true;
    window.__noPurchaseOrders = true;
    await clickRefresh();
    var okGapEmpty = true;
    try {
      await waitFor(function () {
        return !!card('pu-gap-none') && flat(card('pu-stats')).indexOf('待拿货缺口 0') >= 0;
      }, 8000);
    } catch (e) { okGapEmpty = false; }
    report('没有缺口时给空态（说清缺口怎么来的 + 给「去导入订单」），不留空白',
      okGapEmpty && !!card('pu-goto-import'),
      okGapEmpty ? flat(card('pu-gap-none')) : 'timeout / 缺口数字没归零');
    card('pu-sub-orders').click();
    await waitFor(function () { return !!card('pu-order-none'); }, 6000);
    report('没有拿货单时给空态（说清最省事的开法 + 给「去待拿货缺口」）',
      !!card('pu-goto-gap'), flat(card('pu-order-none')));
    window.__noGap = false;
    window.__noPurchaseOrders = false;
    await clickRefresh();
    var okBack = true;
    try {
      await waitFor(function () { return flat(card('pu-stats')).indexOf('拿货单 2') >= 0; }, 8000);
    } catch (e) { okBack = false; }
    report('数据回来后界面跟着回来（保活 + token 联动，不是一次性的）',
      okBack, flat(card('pu-stats')));

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
    // 三个重点：① 取数真落到宿主通道；② 逐行动作（保存 / 确认无误 / 全部确认）各自发对通道；
    // ③ **只剩下逐行动作** —— 原「识别未归类」批量按钮已按用户要求删除，本段末尾有一条
    //    反向断言钉住"它不在"，避免它悄悄长回来（要加回来就同步改那条断言）。
    await activateTab('classify');
    await waitFor(function () {
      return !!card('classify-panel') && flat(card('cl-stats')).indexOf('待核对') >= 0 && !!card('cl-table');
    }, 10000);

    report('归类指标条：四格都是真取数（待核对 4 / 未归类 3 / 识别库 2 款 / 本页 2 个商品）',
      flat(card('cl-stats')).indexOf('待核对 4') >= 0 &&
        flat(card('cl-stats')).indexOf('未归类 3') >= 0 &&
        flat(card('cl-stats')).indexOf('识别库 2 款') >= 0 &&
        // 「本页 2 个商品」= 4 行里去重后的商品数（店A/IT-A 占 2 行、店B/IT-B 占 1 行；
        //  P-43 没有商品ID ⇒ 不计入）。它把"这一页其实只有两件事要定"说出来。
        flat(card('cl-stats')).indexOf('本页 2 个商品') >= 0,
      flat(card('cl-stats')));
    report('待核对四条都在（P-41 / P-42 / P-43 / P-44），店铺逐格对',
      (function () {
        var t = flat(card('cl-table'));
        return t.indexOf('P-41') >= 0 && t.indexOf('P-42') >= 0 && t.indexOf('P-43') >= 0 &&
          t.indexOf('P-44') >= 0 &&
          t.indexOf('店A') >= 0 && t.indexOf('店B') >= 0 && t.indexOf('店C') >= 0;
      })(),
      flat(card('cl-table')));
    // ⚠️ 缩略图合批只该带**有图**的行：无图行的 localPath 是空串，混进去就是白跑一次往返
    report('缩略图合批只带**有图**的行（P-41 + P-42 + P-44 三条），无图的 P-43 不进请求',
      (calls('orderImageThumbBatch') || []).some(function (a) {
        return Array.isArray(a) && a.length === 3 &&
          a[0] && a[0].localPath === '/tmp/p41.jpg' &&
          a[1] && a[1].localPath === '/tmp/p42.jpg' &&
          a[2] && a[2].localPath === '/tmp/p44.jpg';
      }),
      JSON.stringify((calls('orderImageThumbBatch') || []).slice(-1)[0] || null));
    report('有图的两行真的渲染出 <img>（核对是"拿图比"出来的，图不能只是空占位）',
      (function () {
        var t = card('cl-table');
        return !!t && t.querySelectorAll('img').length === 3;
      })(),
      'img数=' + (card('cl-table') ? card('cl-table').querySelectorAll('img').length : -1));

    report('归属款下拉用识别库的真款（自动匹配 + S1 + S2 = 3 个选项）',
      !!card('cl-style-41') && card('cl-style-41').options.length === 3,
      card('cl-style-41') ? 'options=' + card('cl-style-41').options.length : 'no-select');
    // ⚠️ **默认值不能靠位置**：已归类那行要选中**它自己的款**（按 code 反查 id），不是第一个选项
    report('默认值不靠位置：已归类行选中它的款（P-42 → id 5），未归类行停在「自动匹配」（0）',
      !!card('cl-style-42') && card('cl-style-42').value === '5' &&
        !!card('cl-style-41') && card('cl-style-41').value === '0',
      'P-42=' + (card('cl-style-42') ? card('cl-style-42').value : '?') +
        ' P-41=' + (card('cl-style-41') ? card('cl-style-41').value : '?'));

    // ---- 品类/颜色的输入建议（datalist）：标准词表 + 本库已用过的写法 ----
    // 存在的意义是"同一个词各写各的"：T恤 与 短袖T恤 会算成两个款。词表给规范写法，
    // 库内写法让第二次遇到同一个词时能选到同一个（白名单覆盖不到的现实品类只能这样收敛）。
    // ⚠️ 只断言"有 datalist"不够 —— list 属性写歪、datalist 空壳都会让它恒绿，
    //    所以三条分开：①list 指向的元素真的在 ②选项非空 ③内容里既有词表也有库内写法。
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
    var catOpt = datalistValues('cl-cat-41');
    report('品类框的输入建议真的挂上了（list 指向的 datalist 存在且选项非空）',
      !!catOpt.id && catOpt.found && catOpt.values.length > 0,
      'list=' + catOpt.id + ' found=' + catOpt.found + ' 选项数=' + catOpt.values.length);
    report('品类建议 = 标准词表 + 本库已用过的写法（短袖T恤 来自词表；帽子 来自本页数据）',
      catOpt.values.indexOf('短袖T恤') >= 0 && catOpt.values.indexOf('帽子') >= 0,
      JSON.stringify(catOpt.values));
    report('品类建议**不**推荐「其他」（它是空值语义，归一化后是空串，不是一个可选值）',
      catOpt.values.indexOf('其他') < 0,
      JSON.stringify(catOpt.values));
    var colOpt = datalistValues('cl-color-41');
    report('颜色建议 = 标准词表 + 本库写法（黑色 来自词表；蓝 来自本页数据）',
      colOpt.found && colOpt.values.indexOf('黑色') >= 0 && colOpt.values.indexOf('蓝') >= 0,
      'list=' + colOpt.id + ' ' + JSON.stringify(colOpt.values));

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

    // ---- 保存：出参必须带指纹 ----
    report('没改动时「保存」是禁用的（不做"点了没反应"的假动作）',
      !!card('cl-save-41') && card('cl-save-41').disabled === true, '');
    var catEl = card('cl-cat-41');
    catEl.value = '卫衣';
    catEl.dispatchEvent(new Event('input', { bubbles: true }));
    var okDirty = true;
    try { await waitFor(function () { return !!card('cl-save-41') && card('cl-save-41').disabled === false; }, 4000); }
    catch (e) { okDirty = false; }
    report('改了品类后才允许保存（脏值一眼看得出来）', okDirty, '');

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

    var sel = card('cl-style-41');
    sel.value = '6';   // S2
    sel.dispatchEvent(new Event('change', { bubbles: true }));
    var okDirty2 = true;
    try { await waitFor(function () { return !!card('cl-save-41') && card('cl-save-41').disabled === false; }, 4000); }
    catch (e) { okDirty2 = false; }
    var asg2 = calls('orderStyleAssign').length;
    await clickReady('cl-save-41');
    var okAsg = true;
    try { await waitFor(function () { return calls('orderStyleAssign').length > asg2; }, 6000); }
    catch (e) { okAsg = false; }
    var ca = calls('orderStyleAssign')[asg2] || {};
    report('点名某个款时把**指纹记入该款**（后续自动识别会命中同一编码）{orderId:41, styleId:6}',
      okAsg && ca.orderId === 41 && ca.styleId === 6 && !!ca.fingerprint, JSON.stringify(ca));

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

    // ---- 键盘流：回车＝保存这一行，焦点自动交给**顶上来的**那一条 ----
    // ⚠️ 从这里开始让夹具**模拟宿主的真实行为**：已核对的单离开待核对列表
    //    （updateOrder 写 corrected = 1）。前面不开这一步是因为那些断言要反复操作同一行；
    //    而下面这条断言**只有对齐之后才有意义** —— 列表不缩水时，焦点"回到第 N 行"永远成立，
    //    根本分不出"往下走了一格"和"原地没动"。
    window.__emulateCorrected = true;
    window.__correctedIds = [];
    var catEl2 = card('cl-cat-42');
    catEl2.value = '长裤';
    catEl2.dispatchEvent(new Event('input', { bubbles: true }));
    var okDirty3 = true;
    try { await waitFor(function () { return !!card('cl-save-42') && card('cl-save-42').disabled === false; }, 4000); }
    catch (e) { okDirty3 = false; }
    report('回车流的前提就绪：改了品类后该行可保存', okDirty3, '');
    var updKey = calls('orderUpdate').length;
    // 在**行内输入框**上派发 Enter（会冒泡到 tr 上的 @keydown.enter）
    catEl2.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
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

    step('recon');
    // 「结算对账」页签（2026-10-05 内建）。数字全在主进程算好（purchase-db），界面只展示 ——
    // 所以断言钉在"四个金额同源同窗"与"每笔动作真发到对应通道"上。
    await activateTab('recon');
    await waitFor(function () {
      return !!card('recon-panel') && flat(card('rc-stats')).indexOf('拿货') >= 0 && !!card('rc-table');
    }, 10000);

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
    window.__noShopAlloc = false;
    await clickRefresh();

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
