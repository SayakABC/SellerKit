// 「基础数据」页的**假桥无头冒烟**（不启动宿主，不需要 Electron）。
//
//   npm run master-data:ui
//
// 为什么需要它：2026-10-14 把散在三个模块里的维护功能整合成「基础数据」一个入口
// （账号 / 邮件 / 登记 / 企业 / 供应商 / 成本与费率，左导航六项）。这次整合**搬过来的不只是代码**，
// 还有原先挂在三个页面上的冒烟断言 —— 本脚本是它们的新家：
//   · 供应商步（原 goods 的 suppliers-tab）：产品数列 + 编辑只放开电话/备注。
// ⚠️ 原「进价」页（产品当前价维护 + 汇率维护）已在 2026-10-22 整页退役：
//   进价改为在产品编辑抽屉维护、缺价待办改为产品列表「只看缺进价」筛选，
//   当前订单金额均为人民币、汇率维护入口不再需要（详见 docs/notes/2026-10-22-*.md）。
//   对应的冒烟步（进价五步 + 汇率录入 + 窄视口 cost-narrow）已随页面一起移除。
// 另外补三件整合本身的新守卫：左导航六项都能切、跨模块 action 落地、**非法 action 不跳**。
//
// 做法与 goods:ui / order-profit:ui 同款：build 产物 → 假桥 → 本地 HTTP → 无头 Chrome → 抓 #smoke-result。
// ⚠️ 注入脚本里的注释不能含反引号；改完 node --check。

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'renderer');
const WORK = path.join('/tmp', 'sellerkit-master-data-smoke');
const PORT = 8131;
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

  /* ==========================================================================
     夹具（形状照搬各域的真返回；样本的用意见各处注释）

     ⚠️ 两条本文件特有的纪律：
     ① 桩必须**真改夹具**（upsert / delete / map 都就地改）—— 只记调用不改数据的话，
        "保存后表里多一行 / 登记完离开名单"这类断言靠组件乐观更新照样能蒙对；
     ② 夹具必须复刻**生产形状**：进价现在就是产品行上的 costCents（C2 后没有第二张表），
        缺价清单靠"产品库 − 有价的款"现算 —— 写死一份静态汇总就会把被验的量写死。
     ========================================================================== */

  // 产品库：三款，**都挂厂A** —— 供应商步的"产品数列"断言要的是
  // "列里的数来自 product.summary 而不是这页自己数"，3 / 0 两个取值都要有
  // （0 必须渲染成 0 而不是「—」，否则读起来像"没读到"）。
  // ⚠️ 2026-10-17 晚间（款级进价表加图片列）：图的样本**三种形态都要有** ——
  //   S1 有图且有进价（→ img.cost-thumb）；S2 无图、保存后才有价（→ 空占位）；
  //   S3 有图但**没有进价**（→ 永远不进表 ⇒ 它的图不该被取：批量取图只问表里有的款，
  //   这一条把"遍历整个产品库取图"的实现判红 —— 全库上万款时那是白取上万张）。
  // ⚠️ 2026-10-21（C2）：进价是产品行上的 costCents（分）—— ae_cost_map 已退役，
  //   这一页读写的就是这一列。S1/S4 有价、S2/S3 是 0（缺价清单里要有它们俩）。
  var PRODUCTS = [
    { id: 1, code: 'S1', name: '款一', supplierId: 7, supplierName: '厂A', category: '衣服', status: 'active', note: '', imageId: 11, imagePath: '/tmp/smoke-product-images/S1.png', costCents: 1234, createdAt: '', updatedAt: '' },
    { id: 2, code: 'S2', name: '款二', supplierId: 7, supplierName: '厂A', category: '衣服', status: 'active', note: '', imageId: 0, imagePath: '', costCents: 0, createdAt: '', updatedAt: '' },
    { id: 3, code: 'S3', name: '款三', supplierId: 7, supplierName: '厂A', category: '衣服', status: 'active', note: '', imageId: 13, imagePath: '/tmp/smoke-product-images/S3.png', costCents: 0, createdAt: '', updatedAt: '' },
    // S4（2026-10-17 深夜）：款级进价表「供应商 / 状态」两列的**对照样本** ——
    // 停用（archived）+ 未关联供应商（supplierId 0 ⇒ 供应商格回落「—」）。
    // 它有进价所以进表；供应商挂 0 而不是厂B，是保住 suppliers 步"厂A=3 / 厂B=0"的夹具口径。
    { id: 4, code: 'S4', name: '款四', supplierId: 0, supplierName: '', category: '衣服', status: 'archived', note: '', imageId: 0, imagePath: '', costCents: 2050, createdAt: '', updatedAt: '' },
  ];

  var SUPPLIERS = [
    { id: 7, name: '厂A', phone: '13800000000', note: '', createdAt: '2026-09-20 09:00' },
    { id: 8, name: '厂B', phone: '', note: '只做辅料', createdAt: '2026-09-25 09:00' },
  ];

  /* 颜色板（2026-10-30：产品管理组新增「颜色」页签）。三行覆盖三种来源徽标 ——
     字典色 / 只在业务表里出现的异写色 / 平台数字色号。
     用量是**夹具自说自话**的数，合并后必须变（见 mdColorMerge 桩）：
     只回回执不改它的桩，会让"合并后重拉板"这条接线永远验不出来。 */
  var COLORS = [
    { name: '黑色', colorId: 1, hex: '#3a3a3a', styles: 2, skus: 0, orders: 3, inDict: true, numeric: false, imagePath: '' },
    // 待归一两行刻意**有图 / 无图**各一：数字色号「5」带款图（"不看图不知道是红是蓝"的样本），
    // 异写名「黑」不带图（验空占位，不拿中性灰假装是答案）。
    { name: '黑', colorId: 0, hex: '', styles: 1, skus: 2, orders: 1, inDict: false, numeric: false, imagePath: '' },
    { name: '5', colorId: 0, hex: '', styles: 1, skus: 1, orders: 0, inDict: false, numeric: true, imagePath: '/tmp/smoke-color-5.png' },
  ];
  /* 「色卡多到一屏」那条断言要往板上灌标准色，但断言脚本是**另一段 script**（作用域分开），
     直接暴露 COLORS 数组不可行：合并桩会「COLORS = COLORS.filter(...)」换掉绑定，
     外部拿到的旧引用推不动新数组。所以暴露一个**闭包函数**（读的永远是当前绑定）。 */
  window.__smokeAddStandardColors = function (count) {
    for (var i = 1; i <= count; i++) {
      COLORS.push({ name: '烟雾色' + i, colorId: 0, hex: '', styles: 0, skus: 0, orders: 0, inDict: true, numeric: false, imagePath: '' });
    }
  };

  var RATES = [
    { fromCurrency: 'USD', rateToCny: 7.1, updatedAt: '2026-09-30 10:00' },
  ];

  /* 店铺（sk_shops 物理合并行，2026-10-22）：一行 = 一家店（含账号）。
     「店铺」页签（shopAccountList）与「店名归一」页签（shopList）读的是**同一张表** ——
     这份夹具必须同时喂得动两个视图：
       · 11 HK 优品店：齐全行（店名+邮箱+企业+紫鸟+ERP）—— 邮箱挂邮件账号
       · 12 Aurora Store：只有店名（账号待补），amazon —— 店名归一的「唯一命中」目标
       · 13（无店名）：只有邮箱 us@example.com（店铺待建），状态 archived
     状态必须有两个取值（active/archived）才验得出状态筛选。
     记分分值（2026-10-23）：11 带 12 分（验列表显示与编辑器回填），其余 0（验「0 不占位」）。
     保证金（2026-10-25）：12 是退店 + 已到账（验「退店才显示、且不显示在别的行」）；
     11 是启用但库里留着日期（验非退店行**不显示**，光验"退店能显示"会漏掉这一半）。 */
  var SHOPS_INIT = [
    { id: 11, platform: 'shopee', name: 'HK 优品店', nameKey: 'hk 优品店', platformShopId: '', shopUrl: '', site: 'MY', email: 'hk@example.com', companyId: 3, companyName: '示例企业', phone: '13800000000', alipay: 'hk-alipay@example.com', ziniaoAccountId: 1, erpAccountId: 2, ziniaoAccount: 'zn-main', erpAccount: 'erp-max', status: 'active', score: 12, openedAt: '2025-03-01', depositReceivedAt: '2026-01-05', tags: '主力店', note: '', secretKeys: ['shopPwd', 'emailPwd'], hasMailAccount: true, aliasCount: 1, createdAt: '2026-09-01 10:00', updatedAt: '' },
    { id: 12, platform: 'amazon', name: 'Aurora Store', nameKey: 'aurora store', platformShopId: 'A1B2C3D4', shopUrl: '', site: 'US', email: '', companyId: 0, companyName: '', phone: '', alipay: '', ziniaoAccountId: 0, erpAccountId: 0, ziniaoAccount: '', erpAccount: '', status: 'exited', score: 0, openedAt: '', depositReceivedAt: '2026-02-10', tags: '', note: '', secretKeys: [], hasMailAccount: false, aliasCount: 1, createdAt: '2026-09-02 10:00', updatedAt: '' },
    { id: 13, platform: 'aliexpress', name: '', nameKey: '', platformShopId: '', shopUrl: '', site: '', email: 'us@example.com', companyId: 0, companyName: '', phone: '', alipay: '', ziniaoAccountId: 0, erpAccountId: 0, ziniaoAccount: '', erpAccount: '', status: 'archived', score: 0, openedAt: '', depositReceivedAt: '', tags: '', note: '', secretKeys: [], hasMailAccount: false, aliasCount: 0, createdAt: '2026-09-03 10:00', updatedAt: '' },
  ];
  var UNMAPPED_SHOPS_INIT = [
    { key: '新奇怪物店', raw: '新奇怪物店', occurrences: 3, sources: ['order'], autoShopId: 12, autoShopName: 'Aurora Store', autoShopPlatform: 'amazon' },
    { key: 'gaia', raw: 'GAIA', occurrences: 5, sources: ['purchase'], autoShopId: 0, autoShopName: '', autoShopPlatform: '' },
  ];
  var SHOPS = SHOPS_INIT.map(function (s) { return Object.assign({}, s); });
  var UNMAPPED_SHOPS = UNMAPPED_SHOPS_INIT.map(function (r) { return Object.assign({}, r); });
  var SHOP_STALE = 0;
  var SEQ = 950;

  /* 工具账号（sk_tool_accounts，2026-10-22 物理合并新增）：紫鸟 / ERP 各一套。
     店铺行按 id 引用（ziniaoAccountId / erpAccountId）—— 列表紫鸟/ERP 列、两个联动下拉、
     「工具账号」页签都吃这份。password 只进不出（reveal 才回），usageCount 由引用行真算。 */
  var TOOL_ACCOUNTS = [
    { id: 1, kind: 'ziniao', account: 'zn-main', note: '', password: 'smoke-zn-pwd', usageCount: 0, hasPassword: true, createdAt: '', updatedAt: '' },
    { id: 2, kind: 'erp', account: 'erp-max', note: '', password: 'smoke-erp-pwd', usageCount: 0, hasPassword: true, createdAt: '', updatedAt: '' },
  ];

  /* 「待补清单」夹具（2026-10-19）：六类检查**每一类都要有一个真实样本** ——
     少一类，那一格的判据就变成"0 也算对"，等于没验。
       · 订单：2 单没认款（同店同商品ID，合成一条明细）/ 1 单点了不存在的款
         / 1 单颜色还是「未分类」/ 1 单 S3 的 L 码（S3 一个 SKU 都没有）
       · SKU：S1 两码都填了克重（**不该**进清单）、S2 只有 M 且 0 克重、S4 一个 XL
       · 进价：产品行上 S1/S4 有 costCents ⇒ S2/S3 缺（与「进价」页的徽标同口径）
     ⚠️ 订单是"最近 N 单"口径，桩直接回全量即可（行数远小于 2000，不会触发截断提示）。 */
  var HEALTH_ORDERS = [
    { id: 1, orderNo: 'O-1', shop: '店A', styleCode: '', styleColor: '', color: '', size: 'M', itemId: '9001', source: 'import', orderTime: '', supplierId: 0, supplierName: '', amountCents: null, vatCents: null, ddpCents: null, taxPlatform: '', bizStatus: '', rawFields: {} },
    { id: 2, orderNo: 'O-2', shop: '店A', styleCode: '', styleColor: '', color: '', size: 'L', itemId: '9001', source: 'import', orderTime: '', supplierId: 0, supplierName: '', amountCents: null, vatCents: null, ddpCents: null, taxPlatform: '', bizStatus: '', rawFields: {} },
    { id: 3, orderNo: 'O-3', shop: '店B', styleCode: 'NOPE-1', styleColor: '红色', color: 'red', size: 'M', itemId: '', source: 'import', orderTime: '', supplierId: 0, supplierName: '', amountCents: null, vatCents: null, ddpCents: null, taxPlatform: '', bizStatus: '', rawFields: {} },
    { id: 4, orderNo: 'O-4', shop: '店B', styleCode: 'S2', styleColor: '未分类', color: 'Khaki', size: 'M', itemId: '', source: 'import', orderTime: '', supplierId: 7, supplierName: '厂A', amountCents: null, vatCents: null, ddpCents: null, taxPlatform: '', bizStatus: '', rawFields: {} },
    { id: 5, orderNo: 'O-5', shop: '店B', styleCode: 'S3', styleColor: '黑色', color: 'black', size: 'L', itemId: '', source: 'import', orderTime: '', supplierId: 7, supplierName: '厂A', amountCents: null, vatCents: null, ddpCents: null, taxPlatform: '', bizStatus: '', rawFields: {} },
    // O-6 / O-7：模拟真实库里「映射已确认、订单却没吃到」的行 —— 它们挂着占位色，
    // 但商品ID（9002）其实有映射，进页时的自愈应当把它们补成「黑色」（见 orderReplayMappings 桩）。
    // ⚠️ 这两行是「先补再取数」那条断言的**反向样本**：不补的话它们是 2 单，
    //    「颜色未分类」会从 1 单变 3 单 —— 顺序写反立刻红。
    { id: 6, orderNo: 'O-6', shop: '店A', styleCode: 'S1', styleColor: '未分类', color: 'Khaki', size: 'M', itemId: '9002', source: 'import', orderTime: '', supplierId: 0, supplierName: '', amountCents: null, vatCents: null, ddpCents: null, taxPlatform: '', bizStatus: '', rawFields: {} },
    { id: 7, orderNo: 'O-7', shop: '店A', styleCode: 'S1', styleColor: '未分类', color: 'Khaki', size: 'M', itemId: '9002', source: 'import', orderTime: '', supplierId: 0, supplierName: '', amountCents: null, vatCents: null, ddpCents: null, taxPlatform: '', bizStatus: '', rawFields: {} },
  ];
  var HEALTH_VARIANTS = [
    // S1：两码都填了克重 ⇒ 这一款不该出现在「SKU 没填克重」里（反向样本）
    { id: 1, productId: 1, code: '', name: 'M', color: '', size: 'M', weightG: 200, status: 'active', createdAt: '', updatedAt: '' },
    { id: 2, productId: 1, code: '', name: 'L', color: '', size: 'L', weightG: 240, status: 'active', createdAt: '', updatedAt: '' },
    // S2：只有 M，且克重 0 ⇒ 缺克重 1 个（订单里的 M 码能对上 ⇒ 不该同时报"尺码没有"）
    { id: 3, productId: 2, code: '', name: 'M', color: '', size: 'M', weightG: 0, status: 'active', createdAt: '', updatedAt: '' },
    // S4：陪衬（有克重、有进价）
    { id: 4, productId: 4, code: '', name: 'XL', color: '', size: 'XL', weightG: 300, status: 'active', createdAt: '', updatedAt: '' },
  ];
  /** 把六类缺口**全部补上**（只给"齐了"那一步用：留在最后，别污染前面各步的夹具） */
  window.__smokeHealthClean = function () {
    HEALTH_ORDERS = [];
    for (var i = 0; i < HEALTH_VARIANTS.length; i++) HEALTH_VARIANTS[i].weightG = 260;
    for (var j = 0; j < PRODUCTS.length; j++) {
      if (PRODUCTS[j].code === 'S2') PRODUCTS[j].costCents = 1500;
      if (PRODUCTS[j].code === 'S3') PRODUCTS[j].costCents = 1600;
    }
  };

  /* 店铺账号域与上面是**同一张表**（2026-10-22 物理合并：sk_shop_sets 并进 sk_shops）——
     shopAccount* 桩直接读写 SHOPS，不另立夹具（两份夹具 = 合并白合）。 */

  /* 邮件：一个账号 + 两封信（一封未读）。未读数同时驱动左导航徽标与收件箱角标，
     所以夹具里必须真的有一封未读 —— 全已读的样本让"未读"这条判据恒绿。 */
  var MAIL_ACCOUNTS = [
    { id: 41, shopId: 11, email: 'hk@example.com', providerId: 'netease', imapHost: 'imap.163.com', imapPort: 993, imapSecure: true, folder: 'INBOX', folders: ['INBOX'], syncEnabled: true, syncDays: 90, maxBodyBytes: 262144, status: 'idle', lastError: '', lastSyncedAt: '2026-10-13 09:00:00', uidValidity: 1, lastUid: 2, createdAt: '', updatedAt: '' },
  ];
  var MAIL_MESSAGES = [
    { id: 900, accountId: 41, accountEmail: 'hk@example.com', folder: 'INBOX', uid: 1, subject: 'Shopee 店铺绩效周报', fromName: 'Shopee', fromAddr: 'noreply@shopee.com', toJson: '[]', ccJson: '[]', receivedAt: '2026-10-13 08:30:00', size: 2048, seen: false, flagged: false, hasAttachment: false, bodyCached: true, preview: '您的店铺本周绩效…', createdAt: '', readAt: '', read: false },
    { id: 901, accountId: 41, accountEmail: 'hk@example.com', folder: 'INBOX', uid: 2, subject: 'Amazon 账号验证提醒', fromName: 'Amazon', fromAddr: 'no-reply@amazon.com', toJson: '[]', ccJson: '[]', receivedAt: '2026-10-12 15:00:00', size: 1024, seen: true, flagged: false, hasAttachment: false, bodyCached: true, preview: '请完成账号验证…', createdAt: '', readAt: '2026-10-12 16:00:00', read: true },
  ];

  /* 企业（sk_companies）：一家 + 一条合规资料（欧代）—— 合规标签列要有一个"已维护"
     与两个"未维护"的对照，否则条件渲染恒绿。 */
  var COMPANIES = [
    { id: 3, name: '示例企业', unifiedCode: '91440000000000000X', country: '中国', address: '深圳市南山区', legalPerson: '张三', contactName: '李四', contactPhone: '0755-0000000', alipayAccount: 'hk-alipay@example.com', contactEmail: 'li@example.com', vatNo: '', eoriNo: '', status: 'active', note: '', profileTypes: ['eu_rep'], createdAt: '', updatedAt: '' },
  ];

  var OVERRIDES = {
    'getAppVersion': function () { return { success: true, data: '0.0.0-smoke' }; },
    'get-app-version': function () { return { success: true, data: '0.0.0-smoke' }; },
    // 让外壳恢复"上次所在模块" = 基础数据（省掉点侧边栏，断言聚焦本页）
    'getModuleState': function (ns) {
      if (ns === 'app-shell') return { success: true, data: { lastActiveModuleId: 'shop-accounts', collapsed: false } };
      return { success: true, data: null };
    },
    'setModuleState': function () { return { success: true }; },
    // 不补这个桩，每屏右下角都挂一条常驻红 toast「扫描插件目录失败」——
    // 红 toast 一直挂着会训练人忽略红 toast（同 goods 冒烟的理由）。
    'pluginsScan': function () { return { success: true, data: { root: '/tmp/smoke-plugins', plugins: [] } }; },

    /* ---- 店铺账号域（物理合并后 = sk_shops 单表；筛选在渲染层做，这里回全量） ---- */
    'shopAccountDbEnsure': function () { return { success: true, data: { ok: true } }; },
    'shopAccountList': function (p) {
      rec('shopAccountList', p);
      // 「企业」列是主进程 shopAccountList 里 **JOIN 企业表现算**的（SQL: c.name AS company_name），
      // 不是店铺表里的副本列。桩必须按 companyId 现算 —— 写死一份的话，
      // "改完企业名店铺列表仍是旧名"（不重拉）这类 bug 会被夹具掩盖成恒绿。
      // ⚠️ 只现算 companyName：手机号 / 支付宝仍取夹具原值（下方的分面断言依赖那两个原值）。
      return { success: true, data: SHOPS.map(function (a) {
        var c = null;
        for (var i = 0; i < COMPANIES.length; i++) if (COMPANIES[i].id === a.companyId) c = COMPANIES[i];
        return Object.assign({}, a, { companyName: c ? c.name : '' });
      }) };
    },
    'shopAccountSummary': function () {
      rec('shopAccountSummary', {});
      var byStatus = {};
      var complete = 0, shopOnly = 0, accountOnly = 0;
      for (var i = 0; i < SHOPS.length; i++) {
        var a = SHOPS[i];
        byStatus[a.status] = (byStatus[a.status] || 0) + 1;
        if (a.name && a.email) complete++;
        else if (a.name) shopOnly++;
        else accountOnly++;
      }
      return { success: true, data: { total: SHOPS.length, byStatus: byStatus, complete: complete, shopOnly: shopOnly, accountOnly: accountOnly } };
    },
    'shopAccountSecurity': function () { return { success: true, data: { secureStorage: true } }; },
    'shopAccountGet': function (p) {
      rec('shopAccountGet', p);
      for (var i = 0; i < SHOPS.length; i++) {
        if (SHOPS[i].id === Number(p && p.id)) {
          return { success: true, data: Object.assign({}, SHOPS[i], { secrets: { shopPwd: 'smoke-shop', emailPwd: 'smoke-mail' } }) };
        }
      }
      return { success: true, data: null };
    },
    'shopAccountUpsert': function (p) {
      rec('shopAccountUpsert', p);
      var id = Number((p && p.id) || 0);
      var hit = null;
      for (var i = 0; i < SHOPS.length; i++) if (SHOPS[i].id === id) hit = SHOPS[i];
      if (!hit) {
        hit = { id: ++SEQ, platform: 'aliexpress', name: '', nameKey: '', platformShopId: '', shopUrl: '', site: '', email: '', companyId: 0, companyName: '', phone: '', alipay: '', ziniaoAccountId: 0, erpAccountId: 0, ziniaoAccount: '', erpAccount: '', status: 'active', score: 0, openedAt: '', depositReceivedAt: '', tags: '', note: '', secretKeys: [], hasMailAccount: false, aliasCount: 0, createdAt: '2026-10-22 12:00', updatedAt: '' };
        SHOPS.push(hit);
      }
      // 局部语义镜像主进程：undefined = 保持原值；字符串（含空串）= 覆盖；数字 = 覆盖
      var STR_KEYS = ['platform', 'name', 'platformShopId', 'shopUrl', 'site', 'email', 'status', 'openedAt', 'depositReceivedAt', 'tags', 'note'];
      for (var k = 0; k < STR_KEYS.length; k++) if (p[STR_KEYS[k]] !== undefined) hit[STR_KEYS[k]] = p[STR_KEYS[k]];
      var NUM_KEYS = ['companyId', 'ziniaoAccountId', 'erpAccountId', 'score'];
      for (var n = 0; n < NUM_KEYS.length; n++) if (p[NUM_KEYS[n]] !== undefined) hit[NUM_KEYS[n]] = Number(p[NUM_KEYS[n]]) || 0;
      if (p.name !== undefined) hit.nameKey = String(p.name).toLowerCase();
      return { success: true, data: { id: hit.id, secureStorage: true } };
    },
    'shopAccountDelete': function (p) {
      rec('shopAccountDelete', p);
      SHOPS = SHOPS.filter(function (a) { return a.id !== Number(p && p.id); });
      return { success: true, data: { deleted: true } };
    },
    'shopAccountReveal': function (p) {
      rec('shopAccountReveal', p);
      return { success: true, data: { field: p && p.field, value: 'smoke-secret' } };
    },
    'shopAccountBatchUpdate': function (p) {
      rec('shopAccountBatchUpdate', p);
      return { success: true, data: { updated: ((p && p.ids) || []).length } };
    },

    /* ---- 工具账号域（紫鸟 / ERP 共享登录）---- */
    'toolAccountList': function (p) {
      rec('toolAccountList', p);
      var kind = p && p.kind;
      return {
        success: true,
        data: TOOL_ACCOUNTS
          .filter(function (t) { return !kind || t.kind === kind; })
          .map(function (t) {
            var usage = 0;
            for (var i = 0; i < SHOPS.length; i++) {
              if (SHOPS[i].ziniaoAccountId === t.id || SHOPS[i].erpAccountId === t.id) usage++;
            }
            return { id: t.id, kind: t.kind, account: t.account, note: t.note, usageCount: usage, hasPassword: t.hasPassword, createdAt: t.createdAt, updatedAt: t.updatedAt };
          }),
      };
    },
    'toolAccountUpsert': function (p) {
      rec('toolAccountUpsert', p);
      var id = Number((p && p.id) || 0);
      var hit = null;
      for (var i = 0; i < TOOL_ACCOUNTS.length; i++) if (TOOL_ACCOUNTS[i].id === id) hit = TOOL_ACCOUNTS[i];
      if (!hit) {
        hit = { id: 100 + TOOL_ACCOUNTS.length, kind: String(p.kind || 'ziniao'), account: '', note: '', password: '', usageCount: 0, hasPassword: false, createdAt: '2026-10-22 12:00', updatedAt: '' };
        TOOL_ACCOUNTS.push(hit);
      }
      if (p.account !== undefined) hit.account = p.account;
      if (p.note !== undefined) hit.note = p.note;
      if (p.password) { hit.password = p.password; hit.hasPassword = true; }
      return { success: true, data: { id: hit.id } };
    },
    'toolAccountDelete': function (p) {
      rec('toolAccountDelete', p);
      var id = Number(p && p.id);
      var usage = 0;
      for (var i = 0; i < SHOPS.length; i++) {
        if (SHOPS[i].ziniaoAccountId === id || SHOPS[i].erpAccountId === id) usage++;
      }
      if (usage > 0) return { success: false, error: '仍被 ' + usage + ' 家店铺引用' };
      TOOL_ACCOUNTS = TOOL_ACCOUNTS.filter(function (t) { return t.id !== id; });
      return { success: true, data: { deleted: true } };
    },
    'toolAccountReveal': function (p) {
      rec('toolAccountReveal', p);
      for (var i = 0; i < TOOL_ACCOUNTS.length; i++) {
        if (TOOL_ACCOUNTS[i].id === Number(p && p.id)) {
          return { success: true, data: { value: TOOL_ACCOUNTS[i].password || '' } };
        }
      }
      return { success: false, error: '不存在' };
    },

    /* ---- 邮件域（mailStore.ensureReady 的四连 + 列表 / 详情 / 已读）---- */
    'mailDbEnsure': function () { return { success: true, data: { ok: true } }; },
    'mailProviderList': function () {
      return { success: true, data: [{ id: 'netease', label: '网易邮箱', domains: ['163.com', '126.com'], host: 'imap.163.com', port: 993, secure: true, authHint: '请使用授权码', helpUrl: '', idle: true, defaultSyncDays: 90 }] };
    },
    'mailAccountList': function () {
      rec('mailAccountList', {});
      return { success: true, data: MAIL_ACCOUNTS.map(function (a) { return Object.assign({}, a); }) };
    },
    'mailStats': function () {
      rec('mailStats', {});
      var unread = MAIL_MESSAGES.filter(function (m) { return !m.read; }).length;
      return { success: true, data: { accounts: MAIL_ACCOUNTS.length, messages: MAIL_MESSAGES.length, unread: unread, lastSyncedAt: '2026-10-13 09:00:00', folders: [{ path: 'INBOX', count: MAIL_MESSAGES.length }] } };
    },
    'mailMessagesList': function (p) {
      rec('mailMessagesList', p);
      var rows = MAIL_MESSAGES;
      if (p && p.unreadOnly) rows = rows.filter(function (m) { return !m.read; });
      return { success: true, data: { items: rows.map(function (m) { return Object.assign({}, m); }), total: rows.length } };
    },
    'mailMessageGet': function (p) {
      rec('mailMessageGet', p);
      for (var i = 0; i < MAIL_MESSAGES.length; i++) {
        if (MAIL_MESSAGES[i].id === Number(p && p.id)) {
          return { success: true, data: Object.assign({}, MAIL_MESSAGES[i], { htmlBody: '<p>模拟正文</p>', textBody: '模拟正文', attachments: [] }) };
        }
      }
      return { success: true, data: null };
    },
    'mailMessageRead': function (p) {
      rec('mailMessageRead', p);
      var ids = (p && p.ids) || [];
      var changed = 0;
      for (var i = 0; i < MAIL_MESSAGES.length; i++) {
        if (ids.indexOf(MAIL_MESSAGES[i].id) < 0) continue;
        if (!!MAIL_MESSAGES[i].read !== !!p.read) changed++;
        MAIL_MESSAGES[i].read = !!p.read;
        MAIL_MESSAGES[i].readAt = p.read ? '2026-10-14 10:00:00' : '';
      }
      var unread = MAIL_MESSAGES.filter(function (m) { return !m.read; }).length;
      return { success: true, data: { changed: changed, unread: unread } };
    },
    'mailFoldersList': function () { return { success: true, data: [{ path: 'INBOX', count: MAIL_MESSAGES.length }] }; },
    'mailSyncNow': function () { rec('mailSyncNow', {}); return { success: true, data: { started: true } }; },

    /* ---- 店铺登记域（shopApi: ensure / list / unmapped / summary / map / upsert）----
       桩必须真的**改状态**（map 后从名单移走、upsert 后进列表）：只 rec 不改的桩会让
       "登记完变成什么样"整段断言恒绿 —— 而那段正是这一项的核心价值。 */
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
          platformShopId: p.platformShopId || '', shopUrl: p.shopUrl || '', site: p.site || '',
          email: '', companyId: 0, companyName: '', phone: '', alipay: '',
          ziniaoAccountId: 0, erpAccountId: 0, ziniaoAccount: '', erpAccount: '',
          status: p.status || 'active', score: Number(p.score) || 0, openedAt: p.openedAt || '', depositReceivedAt: p.depositReceivedAt || '', note: p.note || '',
          tags: '', secretKeys: [], hasMailAccount: false,
          createdAt: '2026-10-14 12:00', updatedAt: '', aliasCount: 0,
        });
        return { success: true, data: { id: id, created: true } };
      }
      for (var j = 0; j < SHOPS.length; j++) {
        if (SHOPS[j].id !== id) continue;
        // 局部语义镜像（2026-10-22 局部更新改造）：undefined = 保持；空串 = 清空。
        // 夹具若"贴心地"保留旧值，"编辑一次就清空"那条坑永远抓不到。
        var STR_KEYS = ['platform', 'name', 'platformShopId', 'shopUrl', 'site', 'status', 'openedAt', 'depositReceivedAt', 'note'];
        for (var k = 0; k < STR_KEYS.length; k++) if (p[STR_KEYS[k]] !== undefined) SHOPS[j][STR_KEYS[k]] = p[STR_KEYS[k]];
        if (p.score !== undefined) SHOPS[j].score = Number(p.score) || 0;
        SHOPS[j].nameKey = String(SHOPS[j].name || '').toLowerCase();
      }
      return { success: true, data: { id: id, created: false } };
    },

    /* ---- 企业域 ---- */
    'companyList': function (p) {
      rec('companyList', p);
      var kw = String((p && p.search) || '').trim().toLowerCase();
      var list = COMPANIES.filter(function (c) {
        return !kw || (c.name + ' ' + c.unifiedCode + ' ' + c.contactName + ' ' + c.vatNo).toLowerCase().indexOf(kw) >= 0;
      });
      return { success: true, data: list.map(function (c) { return Object.assign({}, c); }) };
    },
    'companySummary': function () {
      rec('companySummary', {});
      return { success: true, data: { total: COMPANIES.length, byStatus: { active: 1 }, byType: { eu_rep: 1 }, expiringSoon: 0 } };
    },
    'companyGet': function (p) {
      rec('companyGet', p);
      for (var i = 0; i < COMPANIES.length; i++) if (COMPANIES[i].id === Number(p && p.id)) return { success: true, data: Object.assign({}, COMPANIES[i], { profiles: [] }) };
      return { success: true, data: null };
    },
    'companyUpsert': function (p) {
      rec('companyUpsert', p);
      var id = Number((p && p.id) || 0);
      if (!id) {
        id = ++SEQ;
        COMPANIES.push(Object.assign({}, p, { id: id, profileTypes: [], createdAt: '', updatedAt: '' }));
        return { success: true, data: { id: id } };
      }
      for (var i = 0; i < COMPANIES.length; i++) if (COMPANIES[i].id === id) { COMPANIES[i].name = p.name || COMPANIES[i].name; }
      return { success: true, data: { id: id } };
    },
    'companyDelete': function (p) {
      rec('companyDelete', p);
      COMPANIES = COMPANIES.filter(function (c) { return c.id !== Number(p && p.id); });
      return { success: true, data: { deleted: true } };
    },

    /* ---- 供应商域（SupplierView 走 goods 域 api，数据层没动）---- */
    'purchaseSupplierList': function () {
      rec('purchaseSupplierList', {});
      return { success: true, data: SUPPLIERS.map(function (s) { return Object.assign({}, s); }) };
    },
    'purchaseSupplierCreate': function (p) {
      rec('purchaseSupplierCreate', p);
      var id = ++SEQ;
      SUPPLIERS.push({ id: id, name: p.name, phone: p.phone || '', note: p.note || '', createdAt: '2026-10-14 12:00' });
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
      SUPPLIERS = SUPPLIERS.filter(function (s) { return s.id !== Number(p && p.id); });
      return { success: true, data: { removed: 1 } };
    },
    // 产品数列的**唯一来源**：按夹具现算（写死一份静态汇总的话，
    // "厂A=2" 这条断言与夹具脱钩，换个夹具就骗过去了）。
    'productSummary': function () {
      rec('productSummary', {});
      var opts = SUPPLIERS.map(function (s) {
        return { id: s.id, name: s.name, productCount: PRODUCTS.filter(function (p) { return p.supplierId === s.id; }).length };
      });
      return { success: true, data: {
        total: PRODUCTS.length,
        byStatus: [{ status: 'active', count: PRODUCTS.length }],
        withoutSupplier: PRODUCTS.filter(function (p) { return !p.supplierId; }).length,
        supplierOptions: opts,
      } };
    },

    /* ---- 产品库（缺价清单 = 产品库 − 有价的款；CostPane 翻页拉全量）----
       __smokeEmptyCosts 只把**返回值**里的价清零（夹具不动 —— 后面几步还要用），
       用来造"一条进价都没有"的空态。 */
    'productList': function (p) {
      rec('productList', p);
      var off = Number((p && p.offset) || 0), lim = Number((p && p.limit) || 0);
      var rows = PRODUCTS.map(function (x) {
        var r = Object.assign({}, x);
        if (window.__smokeEmptyCosts) r.costCents = 0;
        return r;
      });
      if (lim > 0) rows = rows.slice(off, off + lim);
      return { success: true, data: { rows: rows, total: PRODUCTS.length } };
    },

    /* ---- 「待补清单」的两路取数（2026-10-19）----
       ⚠️ 桩必须**按 productIds 真筛**：不筛的话"只取清单里出现过的那几款 SKU"
       这条实现判不红（界面问 4 个 id、桩回全部，结果照样对）。 */
    'productVariantList': function (p) {
      rec('productVariantList', p);
      var ids = ((p && p.productIds) || []).map(Number);
      var rows = HEALTH_VARIANTS.filter(function (v) { return ids.indexOf(Number(v.productId)) >= 0; });
      return { success: true, data: { rows: rows.map(function (v) { return Object.assign({}, v); }) } };
    },
    'orderShippingRows': function (p) {
      rec('orderShippingRows', p);
      return { success: true, data: HEALTH_ORDERS.map(function (o) { return Object.assign({}, o); }) };
    },
    /* 进页时的**映射自愈**（"HealthPane" 在取数前调它）。
       夹具里 O-6/O-7 代表真实库那种「映射已确认、订单却没吃到」的行：它们挂着占位色
       「未分类」，但商品ID（9002）其实有映射 ⇒ 自愈该把它们补成「黑色」。
       ⚠️ 桩必须**真的改数据**（把 styleColor 从 未分类 改成 黑色）：
          只返回 fixedRows: 2 而数据不动，界面上会同时出现"刚补了 2 行"和"还有 3 单未分类"，
          这种自相矛盾的假界面能让断言全绿，却验不出接线顺序（先补再取数）。
       幂等：只改「未分类」的行，第二次进来 fixed 自然是 0。 */
    'orderReplayMappings': function (p) {
      rec('orderReplayMappings', p);
      var fixed = 0;
      for (var i = 0; i < HEALTH_ORDERS.length; i++) {
        var o = HEALTH_ORDERS[i];
        if (o.itemId === '9002' && o.styleColor === '未分类') {
          o.styleColor = '黑色';
          o.color = 'black';
          fixed += 1;
        }
      }
      return { success: true, data: { mappedItems: 1, candidateRows: fixed, fixableRows: fixed, fixedRows: fixed } };
    },

    /* ---- 款主图缩略图（款级进价表「图片」列）----
       按"给了路径"给图，与主进程同形：逐项对应、无效路径置 null。
       记一份调用（items 的路径清单）—— 断言"只给表里有的款取图"要用它。 */
    'orderImageThumbBatch': function (p) {
      var items = Array.isArray(p) ? p : [];
      rec('orderImageThumbBatch', items.map(function (it) { return it && it.localPath; }));
      return { success: true, data: { dataUrls: items.map(function (it) {
        return it && it.localPath ? 'data:image/png;base64,iVBORw0KGgo=' : null;
      }) } };
    },

    /* ---- 进价写入口（C2：只写产品行的 cost_cents 一列）----
       ⚠️ 桩必须**真改夹具**（PRODUCTS）：只记调用的话，"保存后表里出现 S2 那行"
       靠组件乐观更新照样能蒙对，写入路径一改就断。
       返回形状照 product-db.setProductCostByCode：found / updated，「值没变」updated=false。 */
    'productCostSet': function (p) {
      rec('productCostSet', p);
      var code = String((p && p.code) || '').trim();
      var cents = Math.max(0, Math.round(Number(p && p.costCents) || 0));
      var hit = null;
      for (var i = 0; i < PRODUCTS.length; i++) if (PRODUCTS[i].code === code) hit = PRODUCTS[i];
      if (!hit) return { success: true, data: { found: false, updated: false } };
      var updated = hit.costCents !== cents;
      hit.costCents = cents;
      return { success: true, data: { found: true, updated: updated } };
    },

    /* ---- 颜色管理（2026-10-30 用户口径「同色异名要支持合并」）----
       ⚠️ 合并桩必须**真改夹具**（COLORS）：只回回执而不动数据的话，界面会出现
       "合并成功"而源行还留在板上 —— 这种自相矛盾的假界面能让断言全绿，
       却验不出"合并完要重拉颜色板 / 重拉字典单例"这条接线。
       拒绝路径也照主进程抄一遍：拖到数字色号上时界面**根本不发请求**（回执在本地拦），
       所以这里的纯数字判定只会被"直接调"的用例撞到。 */
    'mdColorList': function () {
      return { success: true, data: { colors: COLORS.filter(function (c) { return c.inDict; })
        .map(function (c) { return { id: c.colorId, name: c.name, hex: c.hex }; }) } };
    },
    'mdColorBoard': function () {
      rec('mdColorBoard', {});
      return { success: true, data: { rows: COLORS.map(function (c) { return Object.assign({}, c); }) } };
    },
    // 色块 hex 编辑：只改夹具里那一行的 hex，不动名字（与主进程 updateColorHex 同口径）。
    'mdColorUpdateHex': function (p) {
      rec('mdColorUpdateHex', p || {});
      var id = Number(p && p.id) || 0;
      var hex = String((p && p.hex) || '').trim().toLowerCase();
      var hit = null;
      for (var i = 0; i < COLORS.length; i++) {
        if (COLORS[i].colorId === id) { hit = COLORS[i]; break; }
      }
      if (!hit) return { success: false, error: '颜色不存在' };
      hit.hex = hex;
      return { success: true, data: { color: { id: hit.colorId, name: hit.name, hex: hit.hex } } };
    },
    'mdColorMerge': function (p) {
      rec('mdColorMerge', p || {});
      var src = String((p && p.source) || ''), tgt = String((p && p.target) || '');
      if (src === tgt) return { success: false, error: '这是同一个颜色，不需要合并' };
      if (/^\\d+$/.test(tgt)) return { success: false, error: '数字色号不能作为保留色名（先认成具体的颜色）' };
      var si = -1, ti = -1;
      for (var i = 0; i < COLORS.length; i++) {
        if (COLORS[i].name === src) si = i;
        if (COLORS[i].name === tgt) ti = i;
      }
      if (si < 0) return { success: false, error: '颜色「' + src + '」不存在' };
      if (ti < 0) {
        COLORS.push({ name: tgt, colorId: 0, hex: '', styles: 0, skus: 0, orders: 0, inDict: true, numeric: false, imagePath: '' });
        ti = COLORS.length - 1;
      }
      var s = COLORS[si], t = COLORS[ti];
      t.styles += s.styles;
      t.skus += s.skus;
      t.orders += s.orders;
      t.inDict = true;
      COLORS = COLORS.filter(function (c) { return c !== s; });
      return { success: true, data: { result: {
        source: src, target: tgt,
        dictRemoved: s.inDict ? 1 : 0, aliases: 1,
        styleRenamed: s.styles, styleMerged: 0,
        orders: s.orders, keys: 0, parts: 0,
        skusRenamed: s.skus, skusMerged: 0,
      } } };
    },

    /* ---- 汇率域（ae_rates）：写入有唯一的家，就在这一项 ---- */
    'aeRateList': function () {
      rec('aeRateList', {});
      if (window.__smokeEmptyRates) return { success: true, data: [] };
      return { success: true, data: RATES.slice() };
    },
    'aeRateUpsert': function (p) {
      rec('aeRateUpsert', p);
      var cur = String((p && p.fromCurrency) || '').toUpperCase();
      var v = Number(p && p.rateToCny);
      var hit = null;
      for (var i = 0; i < RATES.length; i++) if (RATES[i].fromCurrency === cur) hit = RATES[i];
      if (hit) hit.rateToCny = v;
      else RATES.push({ fromCurrency: cur, rateToCny: v, updatedAt: '' });
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
</script>`;

const ASSERT_SCRIPT = `<script type="module">
var lines = [];
var STEP = 'init';
function step(n) { STEP = n; }
function report(name, ok, detail) { lines.push((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' | ' + detail : '')); }
/** 跨模块跳转记录器：别处（算钱页的「去维护」等）派发 switch-module + action 跳进来 */
window.__navs = [];
window.addEventListener('switch-module', function (e) {
  window.__navs.push({ moduleId: e.detail && e.detail.moduleId, action: e.detail && e.detail.action });
});
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
/** 有界轮询：最多等 ms 毫秒让条件成立；**超时也不抛**（判定留给紧随其后的 report） */
async function settle(fn, ms) {
  var t0 = Date.now();
  while (!fn() && Date.now() - t0 < (ms || 3000)) await sleep(50);
}
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
function flat(el) { return el ? el.textContent.replace(/\\s+/g, ' ').trim() : ''; }
function calls(name) { return (window.__smokeCalls && window.__smokeCalls[name]) || []; }
function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
function has(text) { return (document.body.innerText || '').indexOf(text) >= 0; }
function isShown(el) {
  if (!el) return false;
  if (!el.getClientRects().length) return false;
  return getComputedStyle(el).display !== 'none';
}
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
/** 派发一个指针事件（拖行合并的唯一驱动方式：面板用 pointerdown/move/up 一套手势）。 */
function pev(el, type, x, y) {
  el.dispatchEvent(new PointerEvent(type, {
    bubbles: true, cancelable: true, clientX: x, clientY: y,
    button: 0, buttons: type === 'pointerup' ? 0 : 1,
    pointerId: 1, pointerType: 'mouse', isPrimary: true,
  }));
}
/** 把 fromEl 拖到 toEl 松手（先越过 6px 阈值，否则只会被当成一次点击）。 */
async function dragRow(fromEl, toEl) {
  var root = document.querySelector('[data-act="colors-panel"]');
  var a = fromEl.getBoundingClientRect();
  var ax = a.left + 20, ay = a.top + a.height / 2;
  pev(fromEl, 'pointerdown', ax, ay);
  await sleep(30);
  pev(root, 'pointermove', ax + 16, ay + 8);   // 纵向 8px：越过 6px 阈值
  // ⚠️ 起点一激活，"松手会发生什么"那一行就插进表的上方（表整体下移约一行）。
  //    落点矩形必须**在激活之后**重新量 —— 用拖动前量的坐标会差那一行的高度，
  //    于是拖到相邻行找不到落点（第一次写这条冒烟时就踩了）。
  await sleep(80);
  var b = toEl.getBoundingClientRect();
  var bx = b.left + 20, by = b.top + b.height / 2;
  pev(root, 'pointermove', bx, by);
  await sleep(60);
  pev(root, 'pointerup', bx, by);
  await sleep(120);
}

/** 切到左导航某一项，并等这一类资料的内容真的渲染出来 */
var KIND_PANE = {
  accounts: '.acct-panel',
  mail: '.mail-head',
  registry: '[data-act="registry-view"]',
  companies: '.cmv-panel, .panel',
  suppliers: '[data-act="supplier-table"]',
  colors: '[data-act="colors-panel"]',
  tools: '.tools-panel',
  health: '[data-act="health-pane"]',
};
/** 资料页 → 它所属的侧栏组（2026-10-17 收拢：侧栏只剩三组，资料页是组内页签）。
 *  ⚠️ 这张表是**断言脚本里**的副本，唯一定义在 MasterDataView.vue 的 GROUPS —— 结构再变时
 *  这里也得跟着改，否则 gotoKind 会点一个不存在的组（报错在第一条用例上，不会静默）。 */
var KIND_GROUP = {
  accounts: 'accounts',
  registry: 'accounts',
  companies: 'accounts',
  tools: 'accounts',
  goods: 'goods',
  colors: 'goods',
  suppliers: 'goods',
  shipping: 'shipping',
  health: 'health',
};
/** 侧栏二级菜单当前高亮的是不是这一项。
 *  ⚠️ 2026-10-17 七项搬到侧栏后**不再有 .is-active 这个类**（视觉换成 Tailwind 的底色），
 *  但模板给激活项挂了 aria-current="page" —— 查语义而不是查配色：换皮时它不会红，
 *  而"高亮错了项"照样红。
 *  同日收拢后高亮有两处：侧栏是**组**（kind-groupId），页内页签是**资料页**
 *  （kind-tab-kindId）。这里优先取页签（问题几乎总是"这一页选中了吗"），
 *  单页组（物流运费）没有页签条 ⇒ 回落侧栏那一行。 */
function actEl(id) {
  return document.querySelector('[data-act="kind-tab-' + id + '"]') ||
    document.querySelector('[data-act="kind-' + id + '"]');
}
function kindActive(id) {
  var el = actEl(id);
  return !!el && el.getAttribute('aria-current') === 'page';
}

/**
 * 切到某一页资料。**两步**（2026-10-17 收拢后）：
 *   ① 点侧栏那一组（不在该组时会落到组内第一页；已在该组时是 no-op）；
 *   ② 组内页签条出现后点那一页。
 * ⚠️ 第 ① 步不能省：侧栏是唯一能跨组走的路，页签条只画当前组的三项。
 */
async function gotoKind(id) {
  var g = KIND_GROUP[id];
  var groupBtn = document.querySelector('[data-act="kind-' + g + '"]');
  if (!groupBtn) throw new Error('侧栏二级菜单没有这一组: ' + g);
  groupBtn.click();
  await settle(function () {
    return !!document.querySelector('[data-act="kind-tab-' + id + '"]') ||
      isShown(document.querySelector(KIND_PANE[id] || '.md-view'));
  }, 8000);
  var tab = document.querySelector('[data-act="kind-tab-' + id + '"]');
  if (tab) tab.click();
  await settle(function () { return isShown(document.querySelector(KIND_PANE[id] || '.md-view')); }, 8000);
  return actEl(id);
}

/**
 * 2026-10-17：「邮件」独立成一级模块 ⇒ 这一页已经**没有** kind-mail 这个资料项了。
 * 邮件相关的断言仍留在本冒烟里（夹具、假桥、上下文都在这儿，另起一份等于把 500 行桩复制一遍），
 * 但入口改成**真跳模块**：switch-module → 目标挂上 .mail-view，断言跑完再切回来。
 * ⚠️ 切回来必须等 .md-view 真的挂上：模块激活是异步的（AppShell 的 await pm.activate），
 *    只等事件会与下一次切换互相覆盖（2026-10-17 在 today 冒烟里踩过同一个坑）。
 */
async function gotoMailModule() {
  window.dispatchEvent(new CustomEvent('switch-module', { detail: { moduleId: 'mail' } }));
  await settle(function () { return !!document.querySelector('.mail-view'); }, 12000);
}

async function backToMasterData(action) {
  window.dispatchEvent(
    new CustomEvent('switch-module', { detail: { moduleId: 'shop-accounts', action: action || 'accounts' } }),
  );
  await settle(function () {
    return !!document.querySelector('.md-view') && !document.querySelector('.mail-view');
  }, 12000);
}

async function main() {
  try {
    /* ── 挂载 + 整合外壳 ───────────────────────────────────────────── */
    step('boot');
    await waitFor(function () { return document.querySelector('.md-view'); }, 12000);
    report('挂载：「基础数据」主视图渲染', true);
    // 侧栏二级菜单：**三项**（2026-10-17 收拢；用户口径「店铺登记、企业收拢到店铺账号中；
    // 成本与费率、供应商收拢到货品档案中」）。七类资料仍在，但变成了组内页签。
    // 两条都要验 —— 只验"三组都在"的话，组里一个页签都没画（点进去一片空白）照样绿。
    // 2026-10-19：第四组「待补清单」（单页组，同物流运费）
    var groupIds = ['accounts', 'goods', 'shipping', 'health'];
    report('侧栏二级菜单的四组都在（店铺账号 / 产品管理 / 物流运费 / 待补清单）',
      groupIds.every(function (g) { return !!document.querySelector('[data-act="kind-' + g + '"]'); }),
      groupIds.map(function (g) { return g + '=' + !!document.querySelector('[data-act="kind-' + g + '"]'); }).join(' '));
    report('四个被收拢的资料项不再并列在侧栏（登记 / 企业 / 工具 / 供应商）',
      ['registry', 'companies', 'tools', 'suppliers'].every(function (k) {
        return !document.querySelector('[data-act="kind-' + k + '"]');
      }),
      ['registry', 'companies', 'tools', 'suppliers']
        .map(function (k) { return k + '=' + !!document.querySelector('[data-act="kind-' + k + '"]'); }).join(' '));
    report('「店铺账号」组内四页都在页签条上（店铺 / 店名归一 / 企业 / 工具账号）',
      ['accounts', 'registry', 'companies', 'tools'].every(function (k) {
        return !!document.querySelector('[data-act="kind-tab-' + k + '"]');
      }),
      ['accounts', 'registry', 'companies', 'tools']
        .map(function (k) { return k + '=' + !!document.querySelector('[data-act="kind-tab-' + k + '"]'); }).join(' '));
    report('页内页签条只有当前组的那几项（不把三组七页平铺回来）',
      !document.querySelector('[data-act="kind-tab-goods"]') &&
        !document.querySelector('[data-act="kind-tab-shipping"]'));
    // 2026-10-17 下午：原第 8 行「设置」按用户口径去掉（它混在资料项里像个页面）。
    // 这里钉住"它没有回来"——安全设置仍在宿主设置中心，不需要也不该在这里再开一个入口。
    report('二级菜单里没有「设置」这一行了',
      !document.querySelector('[data-act="kind-settings"]'));
    // 一级项本身就是二级菜单的开关：用户口径是「现在点击基础数据没法收起二级菜单」。
    // 判据取 DOM 事实（子项在不在），不看箭头转没转 —— 收起要换来的正是那几个缩进行让出的高度。
    // 双向都要验：只验收起的话，把菜单做成"关了打不开"照样绿。
    function navRowEl() { return document.querySelector('[data-act="nav-shop-accounts"]'); }
    report('侧栏「基础数据」一级项可点（它同时是二级菜单的开关）', !!navRowEl());
    var navBefore = navRowEl();
    if (navBefore) navBefore.click();
    await settle(function () { return !document.querySelector('[data-act="kind-accounts"]'); }, 4000);
    report('点一次「基础数据」：二级菜单收起（三项从侧栏消失，箭头折叠）',
      !document.querySelector('[data-act="kind-accounts"]') &&
        !document.querySelector('[data-act="kind-goods"]') &&
        navRowEl().getAttribute('aria-expanded') === 'false',
      'aria-expanded=' + (navRowEl() ? navRowEl().getAttribute('aria-expanded') : 'no-row'));
    navRowEl().click();
    await settle(function () { return !!document.querySelector('[data-act="kind-accounts"]'); }, 4000);
    report('再点一次「基础数据」：二级菜单重新展开（收起不是单向死路）',
      !!document.querySelector('[data-act="kind-accounts"]') &&
        navRowEl().getAttribute('aria-expanded') === 'true',
      'aria-expanded=' + (navRowEl() ? navRowEl().getAttribute('aria-expanded') : 'no-row'));
    report('默认停在「店铺账号」这一项（侧栏二级菜单高亮）',
      kindActive('accounts'),
      document.querySelector('[data-act="kind-accounts"]').className);
    await settle(function () { return all('.acct-panel .data-table tbody tr').length === 3; }, 8000);
    report('店铺列表渲染 3 行（一家齐全 / 一家只有店名 / 一家只有邮箱）',
      all('.acct-panel .data-table tbody tr').length === 3,
      'rows=' + all('.acct-panel .data-table tbody tr').length);

    /* 邮箱接入态（2026-10-25）：冷启动直接落在本页时，邮件账号清单也必须就绪 ——
       此前只有「邮件」页会初始化邮件 store，直接进本页时每一行都报「未接入」，
       接入抽屉也是空表单（用户报的「邮箱设置没有了」正是这条）。
       ⚠️ 必须放在 boot 这一步：后面的 mail 步骤会打开「邮件」页，那时 store 已就绪，
          挪过去这条断言就变成恒绿的了。
       两个方向都要验：11 已接入（带邮箱地址）/ 13 有邮箱但未接入（不能跟着显示已接入）。 */
    await settle(function () {
      return all('.acct-panel .mail-btn').some(function (b) {
        return (b.getAttribute('title') || '').indexOf('已接入') === 0;
      });
    }, 8000);
    var mailBtns = all('.acct-panel .mail-btn');
    var mailTitles = mailBtns.map(function (b) { return b.getAttribute('title') || ''; });
    report('冷启动进本页就读到邮箱接入态（不是清一色「未接入」）',
      mailBtns.length === 2 && mailTitles[0].indexOf('已接入 hk@example.com') === 0 &&
        mailTitles[1].indexOf('未接入邮箱') === 0,
      'titles=' + mailTitles.join(' | '));
    // 抽屉回填：已有账号的配置要能看见（邮箱 / 已接入 / 授权码「留空表示保持不变」），
    // 空壳表单等于用户要重填一遍 —— 那正是「设置没了」的体感。
    if (mailBtns.length) mailBtns[0].click();
    await settle(function () { return !!document.querySelector('.editor-drawer'); }, 5000);
    var mailDrawer = document.querySelector('.editor-drawer');
    var drawerEmail = mailDrawer && mailDrawer.querySelector('input.wb-input');
    var drawerPwd = mailDrawer && mailDrawer.querySelector('.pwd-row input');
    var drawerChip = mailDrawer && mailDrawer.querySelector('.status-chip');
    report('冷启动点开「接入邮箱」：已有配置被回填（邮箱 / 已接入 / 授权码留空）',
      !!mailDrawer && !!drawerEmail && drawerEmail.value === 'hk@example.com' &&
        !!drawerChip && flat(drawerChip) === '已接入' &&
        !!drawerPwd && (drawerPwd.getAttribute('placeholder') || '').indexOf('留空表示保持不变') >= 0,
      'email=' + (drawerEmail ? drawerEmail.value : 'missing') +
        ' | chip=' + (drawerChip ? flat(drawerChip) : 'missing') +
        ' | ph=' + (drawerPwd ? drawerPwd.getAttribute('placeholder') : 'missing'));
    var drawerClose = mailDrawer && mailDrawer.querySelector('.editor-head .icon-btn');
    if (drawerClose) drawerClose.click();
    await settle(function () { return !document.querySelector('.editor-drawer'); }, 4000);
    report('接入抽屉能关掉（不挡后面的步骤）', !document.querySelector('.editor-drawer'));
    // 记分分值（2026-10-23）：挂在状态徽标下（2026-10-25 起两者同在店铺格），只在 > 0 时占位。
    // 夹具 11 有 12 分、12/13 是 0 —— 只验"有分能显示"的话，"0 也渲染一行 0"照样绿。
    function scoreSubOf(row) {
      var sub = row && row.querySelector('.cell-score');
      return sub ? flat(sub) : '';
    }
    var rowEls = all('.acct-panel .data-table tbody tr');
    report('状态格显示记分分值（HK 优品店 12）；记分为 0 的店不占位',
      scoreSubOf(rowEls[0]).indexOf('记分 12') >= 0 && scoreSubOf(rowEls[1]) === '',
      'first=' + scoreSubOf(rowEls[0]) + ' | second=' + scoreSubOf(rowEls[1]));
    // 状态跟店名同格 + 退店才显示保证金到账（2026-10-25）。三个方向都要验：
    // 表头没有「状态」列 / 徽标确实在店铺格里 / 退店行有日期而非退店行没有（11 库里存着日期也不显示）。
    var headers = all('.acct-panel .data-table thead th').map(function (th) { return flat(th); });
    report('表头不再有独立的「状态」列（9 列：选择/店铺/邮箱/企业/手机号/支付宝/紫鸟/ERP/操作）',
      headers.length === 9 && headers.indexOf('状态') < 0 && headers[1] === '店铺',
      'headers=' + headers.join('|'));
    function shopCellOf(row) { return row ? row.children[1] : null; }
    function depositOf(row) {
      var line = row && row.querySelector('.cell-deposit');
      return line ? flat(line) : '';
    }
    report('状态徽标落在店铺格里（HK 优品店那格能直接读到「启用」）',
      !!shopCellOf(rowEls[0]) && !!shopCellOf(rowEls[0]).querySelector('.status-chip') &&
        flat(shopCellOf(rowEls[0]).querySelector('.status-chip')) === '启用',
      'cell=' + (shopCellOf(rowEls[0]) ? flat(shopCellOf(rowEls[0])).slice(0, 40) : 'missing'));
    report('退店行（Aurora Store）显示保证金到账日期 2026-02-10',
      flat(shopCellOf(rowEls[1])).indexOf('退店') >= 0 &&
        depositOf(rowEls[1]).indexOf('保证金到账 2026-02-10') >= 0,
      'cell=' + (shopCellOf(rowEls[1]) ? flat(shopCellOf(rowEls[1])).slice(0, 60) : 'missing'));
    report('非退店行不显示保证金（HK 优品店库里存着 2026-01-05 也不露出来）',
      depositOf(rowEls[0]) === '', 'deposit=' + depositOf(rowEls[0]));
    // 「全部店铺 3」+ 资料完整度两个提示（各 1）都由 summary 数据驱动 —— 钉住数字与文案
    var statFlat = flat(document.querySelector('.acct-panel .stat-group'));
    report('概览数「全部店铺 3」与列表一致（不是写死的字）', /3\\s*全部店铺/.test(statFlat), statFlat.slice(0, 60));
    report('资料完整度提示两条都在（1 个未建店铺 / 1 家待补账号）',
      statFlat.indexOf('1 个未建店铺') >= 0 && statFlat.indexOf('1 家待补账号') >= 0, statFlat.slice(0, 80));

    /* ── 店铺：概览 / 搜索筛选 / 联动筛选 / 编辑器开合 ─────────────── */
    step('accounts');
    // 搜索在渲染层做（shopAccountList 回全量，store.search 过滤 filteredItems）——
    // 判据照旧看行数真变；清除后再回到 3 行，两个方向都验。
    var searchBox = document.querySelector('.acct-panel .toolbar .search-box input');
    report('店铺列表有搜索框', !!searchBox);
    if (searchBox) {
      setVal(searchBox, 'us@');
      await settle(function () { return all('.acct-panel .data-table tbody tr').length === 1; }, 4000);
      report('搜索真的把列表筛窄（us@ → 1 行；筛选接线断了的话恒绿）',
        all('.acct-panel .data-table tbody tr').length === 1,
        'rows=' + all('.acct-panel .data-table tbody tr').length);
      var clearBtn = document.querySelector('.acct-panel .toolbar .search-box .icon-btn');
      if (clearBtn) clearBtn.click();
      await settle(function () { return all('.acct-panel .data-table tbody tr').length === 3; }, 4000);
      report('清空搜索回到 3 行', all('.acct-panel .data-table tbody tr').length === 3,
        'rows=' + all('.acct-panel .data-table tbody tr').length);
    }
    // 联动筛选（2026-10-22 物理合并后的新筛选面）：企业 / 手机号 / 支付宝 / 紫鸟 / ERP。
    // 选项与计数都在渲染层从全量行计算 —— 夹具 3 行（齐全 / 仅店名 / 仅邮箱）让每一维都有命中与不命中。
    function facetSel(title) {
      var sels = all('.acct-panel .toolbar select.filter');
      for (var i = 0; i < sels.length; i++) if (sels[i].getAttribute('title') === title) return sels[i];
      return null;
    }
    var companySel = facetSel('按企业筛选');
    var phoneSel = facetSel('按手机号筛选（选中即锁定所属企业）');
    var ziniaoSel = facetSel('按紫鸟登录筛选');
    var erpSel = facetSel('按 ERP 登录筛选');
    report('五个联动筛选下拉都在（企业 / 手机号 / 支付宝 / 紫鸟 / ERP）',
      all('.acct-panel .toolbar select.filter').length === 5 &&
        !!companySel && !!phoneSel && !!ziniaoSel && !!erpSel &&
        !!facetSel('按支付宝账号筛选（选中即锁定所属企业）'));
    var companyFlat = companySel ? flat(companySel) : '';
    report('企业下拉选项带来源计数（示例企业（1）/（未关联）（2））',
      companyFlat.indexOf('示例企业（1）') >= 0 && companyFlat.indexOf('（未关联）（2）') >= 0,
      companyFlat.slice(0, 80));
    if (companySel) {
      setVal(companySel, '3');
      await settle(function () { return all('.acct-panel .data-table tbody tr').length === 1; }, 4000);
      report('选「示例企业」→ 只剩 1 行（企业筛选真的生效）',
        all('.acct-panel .data-table tbody tr').length === 1,
        'rows=' + all('.acct-panel .data-table tbody tr').length);
      // 三个企业系下拉共享同一个 companyFilter：手机号/支付宝下拉此刻应同步锁定同一企业
      report('企业系下拉共享筛选态（手机号下拉同步锁定「示例企业」）',
        !!phoneSel && phoneSel.value === '3', phoneSel ? 'value=' + phoneSel.value : 'missing');
      // 紫鸟下拉是**独立**筛选维度：企业=3 改变的是它的**候选**（只剩齐全行那套），不是它的值。
      // 断言候选而不是值 —— 拿值当联动判据会把「联动没生效」也判成通过（值本来就一直是空）。
      var znFlat = ziniaoSel ? flat(ziniaoSel) : '';
      report('企业=3 时紫鸟候选只剩 zn-main（1）（分面随企业收窄）',
        znFlat.indexOf('zn-main（1）') >= 0 && znFlat.indexOf('（未使用）') < 0,
        znFlat.slice(0, 80));
      report('没选紫鸟时紫鸟下拉值为空（联动改候选，不改别的维度的值）',
        !!ziniaoSel && ziniaoSel.value === '', ziniaoSel ? 'value=' + ziniaoSel.value : 'missing');
      // 组合收窄：企业=3 且紫鸟=1 → 交集仍 1 行；ERP=2 也在行 11 上
      if (znFlat.indexOf('zn-main（1）') >= 0 && ziniaoSel) {
        setVal(ziniaoSel, '1');
        await settle(function () { return all('.acct-panel .data-table tbody tr').length === 1; }, 4000);
        report('选 zn-main 后仍 1 行（企业 ∩ 紫鸟 非空）',
          all('.acct-panel .data-table tbody tr').length === 1,
          'rows=' + all('.acct-panel .data-table tbody tr').length);
      }
      if (erpSel) {
        setVal(erpSel, '2');
        await settle(function () { return all('.acct-panel .data-table tbody tr').length === 1; }, 4000);
        report('再叠 ERP=erp-max：交集仍剩齐全行 1 行（组合筛选取交集）',
          all('.acct-panel .data-table tbody tr').length === 1,
          'rows=' + all('.acct-panel .data-table tbody tr').length);
        setVal(erpSel, '');
        await settle(function () { return all('.acct-panel .data-table tbody tr').length === 1; }, 4000);
      }
      // 不跳值：搜索词把所有行挤出去后，紫鸟候选里已无 id=1，但选中值必须留在 1
      //（跳成空 = 用户看不见自己筛了什么，交集为空时还会被误读成"数据没了"）
      if (ziniaoSel) {
        var searchBox = document.querySelector('.acct-panel .toolbar .search-box input');
        if (searchBox) {
          setVal(searchBox, '不存在');
          await settle(function () { return all('.acct-panel .data-table tbody tr').length === 0; }, 4000);
          report('搜索与筛选取交集：无命中行时列表归 0',
            all('.acct-panel .data-table tbody tr').length === 0,
            'rows=' + all('.acct-panel .data-table tbody tr').length);
          report('选中项从候选里消失时下拉**不跳值**（仍停在 zn-main）',
            ziniaoSel.value === '1', 'value=' + ziniaoSel.value + ' | ' + flat(ziniaoSel).slice(0, 60));
          setVal(searchBox, '');
          await settle(function () { return all('.acct-panel .data-table tbody tr').length === 1; }, 4000);
        }
        setVal(ziniaoSel, '');
      }
      setVal(companySel, '');
      await settle(function () { return all('.acct-panel .data-table tbody tr').length === 3; }, 4000);
      report('清空筛选回到 3 行', all('.acct-panel .data-table tbody tr').length === 3,
        'rows=' + all('.acct-panel .data-table tbody tr').length);
    }
    // 新增：点「新增店铺」→ 编辑器抽屉真的开（标题写明是新增）
    await clickText('.acct-panel .view-header .btn-primary', '新增店铺');
    await settle(function () { return isShown(document.querySelector('.editor-overlay')); }, 4000);
    report('点「新增店铺」打开编辑器抽屉（标题写明「新增店铺」）',
      isShown(document.querySelector('.editor-overlay')) &&
        flat(document.querySelector('.editor-overlay .editor-title')).indexOf('新增店铺') >= 0,
      flat(document.querySelector('.editor-overlay .editor-title')));
    var edClose = document.querySelector('.editor-overlay .editor-head .icon-btn');
    if (edClose) edClose.click();
    await settle(function () { return !document.querySelector('.editor-overlay'); }, 4000);
    report('编辑器关得掉（不留蒙层挡住后面的操作）', !document.querySelector('.editor-overlay'));
    // 编辑：走 shopAccountGet 取详情 → 表单**预填**（不预填就是让用户重打一遍）
    var editBtn = all('.acct-panel .data-table tbody tr')[0].querySelector('button[title="编辑"]');
    report('店铺行有「编辑」入口', !!editBtn);
    if (editBtn) editBtn.click();
    await settle(function () {
      var o = document.querySelector('.editor-overlay');
      return !!o && !document.querySelector('.editor-loading');
    }, 6000);
    var nameInput = document.querySelector('.editor-overlay .editor-body input');
    var emailInput = document.querySelector('.editor-overlay .editor-body input[placeholder^="店铺主邮箱"]');
    report('编辑时详情真取回来了（店名预填 HK 优品店，不是空表单）',
      !!nameInput && nameInput.value === 'HK 优品店',
      'value=' + (nameInput ? nameInput.value : 'missing'));
    report('邮箱也预填 hk@example.com（物理合并后邮箱就在店铺行上）',
      !!emailInput && emailInput.value === 'hk@example.com',
      'value=' + (emailInput ? emailInput.value : 'missing'));
    // 记分分值 + 四态状态（2026-10-23）：编辑器既要回填既有值，也要给出四个确定性选项。
    var scoreInput = document.querySelector('.editor-overlay [data-act="shop-score"]');
    report('记分分值回填 12（详情取回后表单与列表同口径）',
      !!scoreInput && Number(scoreInput.value) === 12,
      'value=' + (scoreInput ? scoreInput.value : 'missing'));
    var statusBtns = all('.editor-overlay .status-picker [data-status]');
    report('状态选择器四个选项都在（启用 / 停用 / 封店 / 退店，顺序固定）',
      statusBtns.map(function (b) { return flat(b); }).join('|') === '启用|停用|封店|退店',
      statusBtns.map(function (b) { return b.getAttribute('data-status') + ':' + flat(b); }).join(' '));
    // 保证金到账时间（2026-10-25）：输入位只在「退店」状态出现；切走后收起但值留在表单。
    // 三个方向都验：启用不显示 / 退店显示且回填 / 切回封店收起 —— 只验中间一条的话
    // "永远显示"和"切走就清空"两种错都照样绿。
    var depositInput = document.querySelector('.editor-overlay [data-act="shop-deposit"]');
    report('启用状态不显示保证金到账输入（退店才有这个字段）', !depositInput);
    var exitedBtn = document.querySelector('.editor-overlay .status-picker [data-status="exited"]');
    if (exitedBtn) exitedBtn.click();
    await settle(function () { return !!document.querySelector('.editor-overlay [data-act="shop-deposit"]'); }, 4000);
    var depositInput2 = document.querySelector('.editor-overlay [data-act="shop-deposit"]');
    report('切到「退店」后出现保证金到账输入，并回填库里原值 2026-01-05',
      !!depositInput2 && depositInput2.value === '2026-01-05',
      'value=' + (depositInput2 ? depositInput2.value : 'missing'));
    if (depositInput2) setVal(depositInput2, '2026-03-04');
    // 整条链验一次：编辑器改成封店 + 记分 20 → 局部更新载荷 → 列表立刻按新值显示。
    // 只验"选项渲染出来了"的话，status/score 没接进 payload 也照样绿。
    if (scoreInput) setVal(scoreInput, '20');
    var banBtn = document.querySelector('.editor-overlay .status-picker [data-status="banned"]');
    if (banBtn) banBtn.click();
    await settle(function () { return !document.querySelector('.editor-overlay [data-act="shop-deposit"]'); }, 4000);
    report('再切回「封店」：保证金输入收起（只是不显示，不改动已填日期）',
      !document.querySelector('.editor-overlay [data-act="shop-deposit"]'));
    await clickText('.editor-overlay .editor-foot .btn-primary', '保存');
    await settle(function () { return !document.querySelector('.editor-overlay'); }, 6000);
    await settle(function () { return all('.acct-panel .data-table tbody tr').length === 3; }, 6000);
    var savedCall = calls('shopAccountUpsert')[calls('shopAccountUpsert').length - 1] || {};
    report('保存时把「封店 + 记分 20」一起提交（状态走枚举、记分走数字字段）',
      savedCall.status === 'banned' && Number(savedCall.score) === 20,
      JSON.stringify({ status: savedCall.status, score: savedCall.score }));
    report('保证金日期也随表单提交（输入框 → 载荷，不是只在界面上摆着）',
      savedCall.depositReceivedAt === '2026-03-04',
      'depositReceivedAt=' + savedCall.depositReceivedAt);
    var refreshedRow = all('.acct-panel .data-table tbody tr')[0];
    report('保存后列表立即显示「封店 / 记分 20」（不用重进页面）',
      !!refreshedRow &&
        flat(refreshedRow.querySelector('.status-chip')) === '封店' &&
        scoreSubOf(refreshedRow).indexOf('记分 20') >= 0,
      'status=' + (refreshedRow ? flat(refreshedRow.querySelector('.status-chip')) : 'missing') +
        ' | sub=' + scoreSubOf(refreshedRow));
    report('改成封店后保证金日期不再显示在列表（行状态决定可见性）',
      depositOf(refreshedRow) === '', 'deposit=' + depositOf(refreshedRow));
    var edClose2 = document.querySelector('.editor-overlay .editor-head .icon-btn');
    if (edClose2) edClose2.click();
    await settle(function () { return !document.querySelector('.editor-overlay'); }, 4000);

    /* ── 邮件：接入态 / 未读角标 / 列表 / 点开详情 ───────────────────── */
    step('mail');
    await gotoMailModule();
    report('切到「邮件」一级模块：收件箱渲染（有账号时的正常态，不是空态引导）',
      isShown(document.querySelector('.mail-head')) && !document.querySelector('.mail-empty'),
      'head=' + isShown(document.querySelector('.mail-head')));
    report('未读角标 = 1（夹具里真有一封未读；全已读的样本让这条恒绿）',
      flat(document.querySelector('.mail-head .unread-badge')).indexOf('1') >= 0,
      flat(document.querySelector('.mail-head .unread-badge')));
    await settle(function () { return all('.mail-list .mail-item').length === 2; }, 6000);
    report('邮件列表渲染 2 封', all('.mail-list .mail-item').length === 2,
      'rows=' + all('.mail-list .mail-item').length);
    // 2026-10-17：左导航不再有邮件那一项（也没有它的徽标）⇒ 未读数改由**页头**报，
    // 并且反向钉住"基础数据里没有 kind-mail" —— 否则"搬出去了"这件事没人守。
    report('未读数出现在模块页头（左导航的邮件徽标随搬出一起撤掉，不重复摆一个数）',
      flat(document.querySelector('[data-act="mail-unread"]')).indexOf('1') >= 0 &&
        !document.querySelector('[data-act="kind-mail"]'),
      'head=' + flat(document.querySelector('[data-act="mail-unread"]')) +
        ' kind-mail=' + !!document.querySelector('[data-act="kind-mail"]'));
    // 点开第一封（未读）→ 详情渲染，且本地标记已读（IMAP 只读，本地是唯一可靠来源）
    var firstMail = document.querySelector('.mail-list .mail-item');
    if (firstMail) firstMail.click();
    await settle(function () { return !!document.querySelector('.mail-detail .detail-head h3'); }, 6000);
    report('点一封邮件 → 详情渲染出主题',
      flat(document.querySelector('.mail-detail .detail-head h3')).indexOf('Shopee') >= 0,
      flat(document.querySelector('.mail-detail .detail-head h3')));
    await settle(function () { return calls('mailMessageRead').length >= 1; }, 4000);
    report('打开未读邮件即本地标已读（mailMessageRead 带上了那封的 id）',
      (function () {
        var c = calls('mailMessageRead')[0] || {};
        return (c.ids || []).indexOf(900) >= 0 && c.read === true;
      })(),
      JSON.stringify(calls('mailMessageRead')[0] || {}));

    // 切回基础数据：后面几步（店铺登记 / 供应商 / 成本）都在那个模块里，靠左导航。
    await backToMasterData('accounts');
    report('切回「基础数据」：主视图回来了（后面的步骤都靠它的左导航）',
      !!document.querySelector('.md-view') && !document.querySelector('.mail-view'),
      'md-view=' + !!document.querySelector('.md-view'));

    /* ── 店名归一：汇总 chips / 未归一名单 / 不猜歧义 ────────────────── */
    step('registry');
    await gotoKind('registry');
    await settle(function () { return all('[data-act="reg-unmapped-table"] tbody tr[data-shop-key]').length === 2; }, 8000);
    report('汇总 chips 渲染（店铺 3 家 / 未归一 2）',
      (function () {
        var t = flat(document.querySelector('[data-act="reg-stats"]'));
        return /店铺\\s*3\\s*家/.test(t) && /未归一\\s*2/.test(t);
      })(),
      flat(document.querySelector('[data-act="reg-stats"]')).slice(0, 80));
    report('未归一名单 2 条（唯一命中 + 歧义各一条；少了歧义那条，「不猜」就没人守了）',
      all('[data-act="reg-unmapped-table"] tbody tr[data-shop-key]').length === 2,
      'rows=' + all('[data-act="reg-unmapped-table"] tbody tr[data-shop-key]').length);
    var uniqueRow = document.querySelector('[data-act="reg-unmapped-table"] tbody tr[data-shop-key="新奇怪物店"]');
    var ambRow = document.querySelector('[data-act="reg-unmapped-table"] tbody tr[data-shop-key="gaia"]');
    report('唯一命中的行给「采纳：Aurora Store」（带上店名，人才能核对再点）',
      !!uniqueRow && !!uniqueRow.querySelector('[data-act="reg-take"]') &&
        flat(uniqueRow.querySelector('[data-act="reg-take"]')).indexOf('Aurora Store') >= 0,
      uniqueRow ? flat(uniqueRow).slice(0, 60) : 'missing');
    report('歧义行**没有**「采纳」（同名两平台必须让人来选）',
      !!ambRow && !ambRow.querySelector('[data-act="reg-take"]'),
      ambRow ? 'take=' + !!ambRow.querySelector('[data-act="reg-take"]') : 'missing');
    var regSel = uniqueRow ? uniqueRow.querySelector('select') : null;
    report('指派下拉**不预选**（默认空值 —— 预选会把"读错了对象"伪装成"对象有问题"）',
      !!regSel && regSel.value === '',
      regSel ? 'value=' + JSON.stringify(regSel.value) : 'missing');
    // 2026-10-22 物理合并收口：店名归一不再带「已登记店铺」表（店铺行统一去「店铺」页编辑）。
    // 负向断言钉住"已删的表不再复活"——店名归一本页只剩未归一名单 + 指派。
    report('店名归一不再带已登记店铺表（本页只剩未归一名单 + 指派；店铺统一去「店铺」页改）',
      !document.querySelector('[data-act="reg-shop-table"]') &&
        !!document.querySelector('[data-act="reg-unmapped-table"]'));

    /* ── 企业：chips + 列表 + 合规标签 ─────────────────────────────── */
    step('companies');
    await gotoKind('companies');
    await settle(function () { return all('.panel .grid tbody tr').length === 1; }, 8000);
    report('企业列表渲染 1 行', all('.panel .grid tbody tr').length === 1,
      'rows=' + all('.panel .grid tbody tr').length);
    report('企业行含名称 / 信用代码 / 联系人',
      flat(document.querySelector('.panel .grid tbody tr')).indexOf('示例企业') >= 0 &&
        flat(document.querySelector('.panel .grid tbody tr')).indexOf('91440000000000000X') >= 0 &&
        flat(document.querySelector('.panel .grid tbody tr')).indexOf('李四') >= 0,
      flat(document.querySelector('.panel .grid tbody tr')).slice(0, 90));
    // 合规标签：欧代"已维护"（is-on），土代 / 德国包装法未维护 —— 三个对照同屏，
    // 条件渲染才验得出（全维护或全未维护的样本恒绿）。
    var tags = all('.panel .grid tbody tr .tag');
    report('合规资料标签三档对照（欧代已维护；土代 / 德国包装法未维护）',
      tags.length === 3 &&
        tags[0].className.indexOf('is-on') >= 0 &&
        tags[1].className.indexOf('is-on') < 0 &&
        tags[2].className.indexOf('is-on') < 0,
      tags.map(function (t) { return flat(t) + (t.className.indexOf('is-on') >= 0 ? '(on)' : '(off)'); }).join(' '));

    /* ── 企业「编辑」：抽屉必须真打开、真保存（2026-11-03 用户报「编辑保存企业时报错」）──
       旧实现按 company 信封取详情，而 company-get 返回的是**摊平**详情对象
       ⇒ 点「编辑」一律弹「企业不存在或已被删除」，抽屉永远打不开。
       只验上面两行列表渲染时这个 bug 恒绿，所以必须点真按钮走一遍。 */
    step('company-edit');
    var editBtn = document.querySelector('.panel .grid tbody tr button.mini');
    report('企业行「编辑」按钮存在（第一个 mini 按钮）',
      !!editBtn && flat(editBtn).indexOf('编辑') >= 0,
      editBtn ? flat(editBtn) : 'missing');
    if (editBtn) editBtn.click();
    await settle(function () { return !!document.querySelector('.editor-drawer'); }, 4000);
    var editTitle = flat(document.querySelector('.editor-drawer .editor-title'));
    var editInputs = all('.editor-drawer .editor-body input.wb-input');
    var editName = editInputs[0] || null;
    report('点「编辑」打开编辑抽屉（标题「编辑企业」+ 企业名称已回填）',
      editTitle.indexOf('编辑企业') >= 0 && !!editName && editName.value === '示例企业',
      'title=' + editTitle + ' name=' + (editName ? editName.value : 'no-input'));
    // 支付宝账号的唯一编辑入口在企业页：输入框在不在（漏了它，店铺侧「扣运费支付宝」永远填不上）
    report('编辑抽屉有「支付宝账号」输入框并把既有值带出',
      !!document.querySelector('.editor-drawer input[placeholder*="扣运费的支付宝"]'),
      'inputs=' + editInputs.length);
    if (editName) {
      editName.value = '示例企业（改）';
      editName.dispatchEvent(new Event('input'));
    }
    await sleep(60);
    var editSave = document.querySelector('.editor-drawer .editor-foot .btn-primary');
    if (editSave) editSave.click();
    await settle(function () { return !document.querySelector('.editor-drawer'); }, 6000);
    var ups = calls('companyUpsert');
    var lastUps = ups[ups.length - 1] || {};
    report('保存走「更新」而不是新增（带 id=3）+ 支付宝字段同批提交',
      ups.length >= 1 && Number(lastUps.id) === 3 &&
        String(lastUps.name || '').indexOf('示例企业（改）') >= 0 &&
        Object.prototype.hasOwnProperty.call(lastUps, 'alipayAccount'),
      'n=' + ups.length + ' id=' + lastUps.id + ' name=' + lastUps.name +
        ' hasAlipay=' + Object.prototype.hasOwnProperty.call(lastUps, 'alipayAccount'));

    /* ── 改名后两处列表都要跟着变（2026-11-03 用户报「企业名称在列表中没有同步刷新」）──
       ① 企业页自己的列表：保存后必须重拉（不是靠乐观改本地对象）；
       ② 「店铺」页的企业列：它是主进程 JOIN 企业表现算的，店铺列表只在模块级 init / reload 时
          重拉，页签切回来不重拉 ⇒ 企业改了名这里仍是旧快照（本步抓的就是这个）。
       两条分开验：只验 ① 的话，把企业页内部 refresh 去掉也照样绿。 */
    await settle(function () {
      var first = document.querySelector('.panel .grid tbody tr');
      return !!first && flat(first).indexOf('示例企业（改）') >= 0;
    }, 6000);
    report('改名后企业列表立刻显示新名称（不是旧快照）',
      flat(document.querySelector('.panel .grid tbody tr')).indexOf('示例企业（改）') >= 0,
      flat(document.querySelector('.panel .grid tbody tr')).slice(0, 60));
    await gotoKind('accounts');
    await settle(function () {
      return flat(document.querySelector('.acct-panel')).indexOf('示例企业（改）') >= 0;
    }, 8000);
    var shopRow = all('.acct-panel .data-table tbody tr').filter(function (tr) {
      return flat(tr).indexOf('HK 优品店') >= 0;
    })[0];
    report('改名后「店铺」页的企业列跟着变（企业名是 JOIN 现算，不重拉就是旧名）',
      !!shopRow && flat(shopRow).indexOf('示例企业（改）') >= 0,
      shopRow ? flat(shopRow).slice(0, 80) : 'row-missing');

    /* ── 工具账号：紫鸟 / ERP 共享登录（2026-10-22 物理合并新增页签）────────
       一套登录管多家店 —— 夹具两套各被一家引用，统计 / 删除保护都要真数。 */
    step('tools');
    await gotoKind('tools');
    await settle(function () { return all('[data-act="tools-table"] tbody tr[data-tool-id]').length === 2; }, 8000);
    var toolsStats = flat(document.querySelector('[data-act="tools-stats"]'));
    report('工具账号页渲染 2 套（紫鸟 1 / ERP 1）',
      all('[data-act="tools-table"] tbody tr[data-tool-id]').length === 2 &&
        toolsStats.indexOf('紫鸟 1 套') >= 0 && toolsStats.indexOf('ERP 1 套') >= 0,
      'rows=' + all('[data-act="tools-table"] tbody tr[data-tool-id]').length + ' stats=' + toolsStats.slice(0, 40));
    var usedDel = document.querySelector('[data-act="tools-delete"]');
    report('被引用的工具账号删不掉（删除按钮置灰 + 写明被几家店用）',
      !!usedDel && usedDel.disabled && flat(usedDel.parentElement.parentElement).indexOf('1 家店') >= 0,
      usedDel ? 'disabled=' + usedDel.disabled + ' row=' + flat(usedDel.parentElement.parentElement).slice(0, 60) : 'missing');
    report('密码列只显示「已设置」徽标，不明文回显',
      flat(document.querySelector('[data-act="tools-table"]')).indexOf('已设置') >= 0 &&
        flat(document.querySelector('[data-act="tools-table"]')).indexOf('smoke-zn-pwd') < 0,
      '');
    // 新建开合（标题/表单真的出现，关得掉）
    var toolsNew = document.querySelector('[data-act="tools-new"]');
    if (toolsNew) toolsNew.click();
    await settle(function () { return isShown(document.querySelector('[data-act="tools-form-account"]')); }, 4000);
    report('点「新建工具账号」打开编辑表单（登录名输入框真的出现）',
      isShown(document.querySelector('[data-act="tools-form-account"]')));
    var toolsCancel = document.querySelector('[data-act="tools-cancel"]');
    if (toolsCancel) toolsCancel.click();
    await settle(function () { return !isShown(document.querySelector('[data-act="tools-form-account"]')); }, 4000);

    /* ── 回归：组内点第一页页签（2026-10-17 当晚 bug）───────────────────────
       组 id 与 kind id 撞车（组 accounts ⇄ kind accounts）时，旧实现先查组表 ⇒
       在组内点「店铺」页签被当成"点组名"、命中"已在这组"早退 ⇒ 页面什么都不发生
       （无报错、无变化）。gotoKind 的两步走法（先点侧栏组再点页签）恰好绕开这条路径，
       所以必须**单独走页签**才能守住它。 */
    step('tab-back-first');
    document.querySelector('[data-act="kind-tab-accounts"]').click();
    await settle(function () { return isShown(document.querySelector('.acct-panel')); }, 8000);
    report('组内点第一页页签有反应（「店铺账号」组停在「工具账号」时，点「店铺」落在店铺列表）',
      kindActive('accounts') && isShown(document.querySelector('.acct-panel')),
      'tab-active=' + kindActive('accounts') + ' pane=' + isShown(document.querySelector('.acct-panel')));

    /* ── 供应商：产品数列 + 编辑只放开电话/备注 + 增删 ─────────────────
       ⚠️ 从 goods 的 suppliers-tab 步整条搬来，一条没放宽。
       原判据还有"跟着 upstream 的改动走"那半（厂A 的 2 来自 goods 页的批量编辑）——
       本页没有改产品归属的入口，故夹具直接让两款都挂厂A；仍能分辨的错是：
       列里的数不是来自 product.summary（页内自己数 / 缓存旧值 / 把 0 渲染成「—」）。 */
    step('suppliers');
    await gotoKind('suppliers');
    await settle(function () { return all('[data-act="supplier-table"] tbody tr[data-supplier-id]').length === 2; }, 8000);
    report('供应商列表渲染 2 行', all('[data-act="supplier-table"] tbody tr[data-supplier-id]').length === 2,
      'rows=' + all('[data-act="supplier-table"] tbody tr[data-supplier-id]').length);
    report('产品数列合并自 product.summary（厂A=3 / 厂B=0；0 要写 0，不能留空或「—」）',
      flat(document.querySelector('[data-supplier-id="7"] [data-act="s-count"]')) === '3' &&
        flat(document.querySelector('[data-supplier-id="8"] [data-act="s-count"]')) === '0',
      '厂A=' + flat(document.querySelector('[data-supplier-id="7"] [data-act="s-count"]')) +
        ' 厂B=' + flat(document.querySelector('[data-supplier-id="8"] [data-act="s-count"]')));
    report('这一页确实去问了 product.summary（列不是这页自己数出来的）',
      calls('productSummary').length >= 1, 'calls=' + calls('productSummary').length);
    document.querySelector('[data-supplier-id="7"] [data-act="s-edit"]').click();
    await settle(function () { return all('.wb-mask .sup-form').length === 1; }, 4000);
    report('编辑只放开电话/备注（名称是 UNIQUE 键，改它会让历史拿货单指向别处）',
      all('.wb-mask .sup-form input').length === 2 && !document.querySelector('[data-act="sup-name"]'),
      'inputs=' + all('.wb-mask .sup-form input').length);
    await clickText('.wb-mask .wb-dialog__foot button', '取消');
    await settle(function () { return !document.querySelector('.wb-mask'); }, 4000);
    // 新增：厂C → 列表 3 行 + purchaseSupplierCreate 带上名称
    await clickText('[data-act="new-supplier"]', '新增');
    await settle(function () { return all('.wb-mask .sup-form').length === 1; }, 4000);
    setVal(document.querySelector('[data-act="sup-name"]'), '厂C');
    setVal(document.querySelector('[data-act="sup-phone"]'), '13900000000');
    await clickText('[data-act="sup-save"]', '保存');
    await settle(function () { return all('[data-act="supplier-table"] tbody tr[data-supplier-id]').length === 3; }, 6000);
    report('新增供应商 → 列表真多一行（桩真改了夹具，不是组件自己蒙的）',
      all('[data-act="supplier-table"] tbody tr[data-supplier-id]').length === 3,
      'rows=' + all('[data-act="supplier-table"] tbody tr[data-supplier-id]').length);
    report('新增走 purchaseSupplierCreate，名称透传',
      (function () {
        var c = calls('purchaseSupplierCreate');
        return c.length >= 1 && c[c.length - 1].name === '厂C';
      })(),
      JSON.stringify(calls('purchaseSupplierCreate').slice(-1)));
    // 删除：厂B（名下 0 个产品）→ 确认框 → 真删
    document.querySelector('[data-supplier-id="8"] [data-act="s-delete"]').click();
    await settle(function () { return !!document.querySelector('[data-act="confirm-dialog"]'); }, 4000);
    report('删除前有确认框', !!document.querySelector('[data-act="confirm-dialog"]'));
    document.querySelector('[data-act="confirm-ok"]').click();
    await settle(function () { return all('[data-act="supplier-table"] tbody tr[data-supplier-id]').length === 2; }, 6000);
    report('确认后厂B真没了（删除不是只关框）',
      all('[data-act="supplier-table"] tbody tr[data-supplier-id]').length === 2 &&
        !document.querySelector('[data-supplier-id="8"]'),
      'rows=' + all('[data-act="supplier-table"] tbody tr[data-supplier-id]').length);

    /* ── 颜色管理（2026-10-30 重新设计：标准色色卡 + 待归一点选合并）──
       用户反馈两点：① 颜色太多时拖动定位麻烦；② 数字色号 / 平台原文没有真实色块，
       不知道该并给谁。重设计后板分两区：
         · 标准色（字典色）= 色卡，色块 = 真实 hex（可点取色器改），是合并目标；
         · 待归一色名（数字色号 / 平台原文 / 异写）= 列表，没色块（"还没认"就是没色块）。
       合并主路径：**点待归一行选中 → 点标准色卡**（不再靠拖小行）；拖拽保留为快捷。
       断言覆盖：两区渲染 / 真实色块可见 / 用量 / 搜索 / 点选合并 / 拖卡合并 / 重拉板。 */
    step('colors');
    await gotoKind('colors');
    await settle(function () {
      return all('[data-std-card]').length === 1 && all('[data-loose-row]').length === 2;
    }, 8000);
    report('「产品管理」组内有「颜色」页签，点开渲染颜色板（标准色色卡 + 待归一列表）',
      kindActive('colors') && isShown(document.querySelector('[data-act="colors-panel"]')),
      'tab=' + kindActive('colors') + ' pane=' + isShown(document.querySelector('[data-act="colors-panel"]')));
    report('板分两区：标准色 1 张（黑色）、待归一 2 行（黑、5）',
      all('[data-std-card]').length === 1 && all('[data-loose-row]').length === 2,
      'std=' + all('[data-std-card]').length + ' loose=' + all('[data-loose-row]').length);
    report('待归一行的徽标分得清：未入字典 / 数字色号（数字色只能当源）',
      flat(document.querySelector('[data-color="黑"] [data-loose-badge]')) === '未入字典' &&
        flat(document.querySelector('[data-color="5"] [data-loose-badge]')) === '数字色号',
      ['黑', '5'].map(function (n) {
        return n + '=' + flat(document.querySelector('[data-color="' + n + '"] [data-loose-badge]'));
      }).join(' '));
    report('标准色卡展示**真实色块**（hex 文本 + 取色器都在；这是"知道并给谁"的前提）',
      flat(document.querySelector('[data-color="黑色"] [data-std-hex]')) === '#3a3a3a' &&
        !!document.querySelector('[data-color="黑色"] [data-std-swatch]'),
      'hex=' + flat(document.querySelector('[data-color="黑色"] [data-std-hex]')));
    report('用量列说清"谁在用"（款 / SKU / 订单），标准色与待归一都有',
      flat(document.querySelector('[data-color="黑色"] [data-std-usage]')).indexOf('款 2 · 订单 3') === 0 &&
        flat(document.querySelector('[data-color="黑"] [data-loose-usage]')).indexOf('款 1 · SKU 2 · 订单 1') === 0,
      '黑色=' + flat(document.querySelector('[data-color="黑色"] [data-std-usage]')) +
        ' 黑=' + flat(document.querySelector('[data-color="黑"] [data-loose-usage]')));

    /* 2026-10-31 用户口径「带归一列表中需要加款图，不然数字没法知道是什么颜色」。
       两半都要验：有图的色真取到缩略图；没图的色画**空占位**（不能拿灰块冒充"这就是这个色"）。 */
    await settle(function () {
      return !!document.querySelector('[data-loose-row="5"] [data-loose-img] img');
    }, 4000);
    report('待归一列表带款图：数字色号「5」按 imagePath 取到缩略图（否则「5」是红是蓝看不出来）',
      !!document.querySelector('[data-loose-row="5"] [data-loose-img] img') &&
        (calls('orderImageThumbBatch').slice(-1)[0] || []).indexOf('/tmp/smoke-color-5.png') >= 0,
      'img=' + !!document.querySelector('[data-loose-row="5"] [data-loose-img] img') +
        ' calls=' + JSON.stringify(calls('orderImageThumbBatch').slice(-1)));
    report('没有款图的色画空占位（不拿中性灰假装是答案）',
      !document.querySelector('[data-loose-row="黑"] [data-loose-img] img') &&
        !!document.querySelector('[data-loose-row="黑"] [data-loose-img] .wb-thumb--empty'),
      'img=' + !!document.querySelector('[data-loose-row="黑"] [data-loose-img] img'));

    setVal(document.querySelector('[data-act="colors-search"]'), '黑');
    await settle(function () { return all('[data-loose-row]').length === 1; }, 4000);
    report('搜索按色名过滤（「黑」只剩 黑，数字色号 5 被滤掉；标准色 黑色保留）',
      all('[data-loose-row]').length === 1 && !document.querySelector('[data-loose-row="5"]') &&
        !!document.querySelector('[data-std-card="黑色"]'),
      'loose=' + all('[data-loose-row]').length);
    setVal(document.querySelector('[data-act="colors-search"]'), '');
    await settle(function () { return all('[data-loose-row]').length === 2; }, 4000);

    // 主路径：点待归一行选中 → 点标准色卡合并
    var mergeCallsBefore = calls('mdColorMerge').length;
    document.querySelector('[data-loose-row="黑"]').click();
    await sleep(60);
    report('点待归一行「黑」：进入选中态（提示挂在回执行，不额外占高）',
      document.querySelector('[data-loose-row="黑"]').classList.contains('is-selected') &&
        flat(document.querySelector('[data-act="colors-receipt"]')).indexOf('已选「黑」') >= 0,
      'receipt=' + flat(document.querySelector('[data-act="colors-receipt"]')));
    document.querySelector('[data-std-card="黑色"]').click();
    await settle(function () { return calls('mdColorMerge').length > mergeCallsBefore; }, 6000);
    await settle(function () { return !document.querySelector('[data-loose-row="黑"]'); }, 6000);
    report('点标准色卡「黑色」：真合并（源行消失、保留卡用量累加，不是只记一条别名）',
      !document.querySelector('[data-loose-row="黑"]') &&
        flat(document.querySelector('[data-color="黑色"] [data-std-usage]')).indexOf('款 3 · SKU 2 · 订单 4') === 0,
      'usage=' + flat(document.querySelector('[data-color="黑色"] [data-std-usage]')));
    report('合并回执念出动了多少（用户事后唯一能核对的东西）',
      flat(document.querySelector('[data-act="colors-receipt"]')).indexOf('已把「黑」并进「黑色」') === 0,
      flat(document.querySelector('[data-act="colors-receipt"]')));
    report('合并只发一次请求，且源 / 保留色名都对（点错方向会把保留名并掉）',
      calls('mdColorMerge').length === mergeCallsBefore + 1 &&
        (function () {
          var c = calls('mdColorMerge');
          var last = c[c.length - 1] || {};
          return last.source === '黑' && last.target === '黑色';
        })(),
      JSON.stringify(calls('mdColorMerge').slice(-1)));
    report('合并后重拉了颜色板（字典单例与板对齐，别的页面才看得见新名字）',
      calls('mdColorBoard').length >= 2, 'calls=' + calls('mdColorBoard').length);

    // 快捷路径：拖待归一行到标准色卡（数字色号 5 → 黑色；数字色只能当源）
    var dragCallsBefore = calls('mdColorMerge').length;
    await dragRow(document.querySelector('[data-loose-row="5"]'), document.querySelector('[data-std-card="黑色"]'));
    await settle(function () { return calls('mdColorMerge').length > dragCallsBefore; }, 6000);
    report('拖待归一行「5」到标准色卡「黑色」：拖拽仍是快捷合并路径（数字色当源）',
      calls('mdColorMerge').length === dragCallsBefore + 1 &&
        (function () {
          var c = calls('mdColorMerge');
          var last = c[c.length - 1] || {};
          return last.source === '5' && last.target === '黑色';
        })(),
      JSON.stringify(calls('mdColorMerge').slice(-1)));

    /* 2026-10-31 用户口径「标准色卡片尺寸可以小点，不要出现滚动条，要全部都展示出来」。
       夹具里只有 1 张卡 ⇒ 这条断言恒绿。末尾灌 24 个标准色再重进本页（v-if 切走再切回 =
       真的重新挂载并重拉板），量三件事：色卡区自己不出滚动条、面板不被撑出滚动、
       最后一张卡仍在面板可视区内。 */
    var stdBefore = all('[data-std-card]').length;
    window.__smokeAddStandardColors(24);
    await gotoKind('goods');
    await gotoKind('colors');
    await settle(function () { return all('[data-std-card]').length === stdBefore + 24; }, 6000);
    var cardsEl = document.querySelector('.colors-cards');
    var panelEl = document.querySelector('[data-act="colors-panel"]');
    var stdCards = all('[data-std-card]');
    var lastCard = stdCards[stdCards.length - 1];
    report('25 个标准色一屏铺开：色卡区不自己滚，最后一张也在面板可视区内（全部展示出来）',
      !!cardsEl && !!panelEl && !!lastCard &&
        getComputedStyle(cardsEl).overflowY !== 'auto' && getComputedStyle(cardsEl).overflowY !== 'scroll' &&
        panelEl.scrollHeight - panelEl.clientHeight <= 1 &&
        lastCard.getBoundingClientRect().bottom <= panelEl.getBoundingClientRect().bottom + 1,
      'cards=' + stdCards.length +
        ' cardsOverflow=' + (cardsEl ? getComputedStyle(cardsEl).overflowY : 'null') +
        ' panelScroll=' + (panelEl ? (panelEl.scrollHeight - panelEl.clientHeight) : 'null') +
        ' lastBottom=' + (lastCard ? Math.round(lastCard.getBoundingClientRect().bottom) : 'null') +
        ' panelBottom=' + (panelEl ? Math.round(panelEl.getBoundingClientRect().bottom) : 'null'));

    /* ── 图案页已撤走（2026-11-03）：用户口径「把产品管理中的图案和发货台的订花纸功能
       精简合并，放在现有的订花纸中」⇒ 认图案 + 花纸库存都归「发货台 › 订花纸」，
       本页不再有 kind-tab-patterns。这里留一条**反向断言**：它还出现在组内页签里
       就说明删得不干净（那个页签点开是一片空白）。 */
    var tabIdsNow = all('[data-act^="kind-tab-"]').map(function (el) {
      return (el.getAttribute('data-act') || '').replace('kind-tab-', '');
    });
    report('「图案」页签已从基础数据撤走（认图案归「发货台 › 订花纸」）',
      tabIdsNow.indexOf('patterns') < 0, JSON.stringify(tabIdsNow));

    step('errors');
    report('无未捕获错误', (window.__smokeErrors || []).length === 0,
      JSON.stringify(window.__smokeErrors || []));
  } catch (e) {
    lines.push('SMOKE: FAILED at [' + STEP + '] - ' + (e && e.message ? e.message : String(e)));
  }
  finish();
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
  await main();
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

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
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

async function runChrome(size, budget, mode) {
  const dom = await new Promise((resolve, reject) => {
    const cp = spawn(CHROME, [
      '--headless=new',
      '--disable-gpu',
      '--no-sandbox',
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
  { mode: 'narrow', size: '900,800', budget: 60000, label: '窄视口堆叠守卫（900×800）' },
].filter((p) => !process.env.SMOKE_MODE || p.mode === process.env.SMOKE_MODE);
const results = {};
for (const p of passes) {
  const out = await runChrome(p.size, p.budget, p.mode);
  results[p.mode] = out;
  if (passes.indexOf(p) === 0) {
    if (!out) {
      console.error(
        '✗ 宽视口那遍没抓到 #smoke-result（页面可能没挂载）。排查：产物新鲜度（npm run build）→ 资源 404 → 内联脚本语法错 → 假桥缺键'
      );
      process.exit(1);
    }
    console.log(out);
  } else {
    console.log(`\n── ${p.label} ──`);
    console.log(out || '✗ 这一遍没抓到 #smoke-result');
  }
}
server.close();

const ok = passes.every(
  (p) => !!results[p.mode] && results[p.mode].split('\n').pop() === 'SMOKE: ALL PASS'
);
console.log(ok ? '\n✓ 基础数据页冒烟通过（宽 + 窄，共两遍）' : '\n✗ 基础数据页冒烟失败');
process.exit(ok ? 0 : 1);
