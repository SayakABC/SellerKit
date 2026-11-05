// 「记账 › 明细」页的**假桥无头冒烟**（不启动宿主，不需要 Electron）。
//
//   npm run ledger:ui
//
// 为什么需要它：P1 的页面全是接线 —— 合计读 `ledgerSummary`、列表读 `ledgerEntryList`、
// 分摊预览读 `computeAllocations`、保存写 `ledgerEntryUpsert`。这些环节任一处接错
// （读错参数、筛选没生效、预览与落库不是同一份数）都不会报错，只会**显示成另一组数**。
// 静态门禁（tsc / lint / build）对这类错误完全看不见。
//
// 做法与 master-data:ui / goods:ui 同款：build 产物 → 假桥 → 本地 HTTP → 无头 Chrome → 抓 #smoke-result。
// ⚠️ 注入脚本里的注释不能含反引号；改完 node --check。
//
// 两条本文件特有的纪律：
//  ① 桩必须**真改夹具**（upsert / void / merge / archive 都就地改）—— 只记调用不改数据的话，
//     "保存后表里多一行""作废后合计变小"这类断言靠组件乐观更新照样能蒙对；
//  ② 夹具必须复刻**结构**：参与分摊的店铺要同时有"本月已开业 / 已停用 / 当月还没开店"三态，
//     否则"排除项要显式列出来"这条判据恒绿（只放两家全合格的店，代码把排除项丢掉也看不出来）。

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'renderer');
const WORK = path.join('/tmp', 'sellerkit-ledger-smoke');
const PORT = 8137;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

/* 批量导入的 Excel 夹具：**Node 侧生成真 xlsx**，再 base64 塞进假桥。
   不能喂一个"假的 grid"——界面上那条路是 `selectExcel` → `readWorkbookSheets` → `XLSX.read`，
   绕开真文件就等于不测"读得进来"这一段，而这一段恰恰是用户唯一会踩的入口。 */
const require_ = createRequire(import.meta.url);
const XLSX_NODE = require_('xlsx');
const pad2n = (n) => (n < 10 ? '0' : '') + n;
const nowD = new Date();
const IMPORT_MONTH = `${nowD.getFullYear()}-${pad2n(nowD.getMonth() + 1)}`;
/** 三行刻意各带一个失效点：金额超两位小数（取整）/ 公共分摊「全部」/ 名字库里没有（自动新建） */
const IMPORT_XLSX_B64 = (() => {
  const grid = [
    ['发生日期', '方向', '金额(元)', '相关人', '科目', '店铺', '分摊店铺', '分摊基准', '归属', '备注'],
    [`${IMPORT_MONTH}-02`, '支出', 1200.5678, '广州布行', '房租水电', 'HK 优品店', '', '', '', '取整样例'],
    [`${IMPORT_MONTH}-03`, '支出', 300, '广州布行', '', '', '全部', '', '公共', '全摊样例'],
    [`${IMPORT_MONTH}-04`, '支出', 88.8, '新人甲', '新科目', 'Aurora Store', '', '', '', '自动建名样例'],
  ];
  const wb = XLSX_NODE.utils.book_new();
  XLSX_NODE.utils.book_append_sheet(wb, XLSX_NODE.utils.aoa_to_sheet(grid), '明细');
  return XLSX_NODE.write(wb, { type: 'buffer', bookType: 'xlsx' }).toString('base64');
})();

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

  /* 导入夹具的字节（Node 侧用真 xlsx 生成后 base64 传进来） */
  var IMPORT_B64 = '${IMPORT_XLSX_B64}';
  function b64ToBuf(b64) {
    var bin = atob(b64);
    var u8 = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    return u8.buffer;
  }

  function pad2(n) { return (n < 10 ? '0' : '') + n; }
  var NOW = new Date();
  var MONTH = NOW.getFullYear() + '-' + pad2(NOW.getMonth() + 1);
  var PREV_D = new Date(NOW.getFullYear(), NOW.getMonth() - 1, 1);
  var PREV = PREV_D.getFullYear() + '-' + pad2(PREV_D.getMonth() + 1);
  /* 互抵夹具放**下个月**：往来页是累计口径，照样能结算；
     但本月/上个月的汇总与行数断言都看不见它，不用回头改一堆具体数值。 */
  var NEXT_D = new Date(NOW.getFullYear(), NOW.getMonth() + 1, 1);
  var NEXT = NEXT_D.getFullYear() + '-' + pad2(NEXT_D.getMonth() + 1);
  function d(day) { return MONTH + '-' + pad2(day); }
  function dn(day) { return NEXT + '-' + pad2(day); }

  /* ==========================================================================
     夹具
     ========================================================================== */

  /* 店铺三态（分摊参与判据 @ 本月）：
       11 / 12：active 且本月之前已开业 ⇒ 参与
       13：archived ⇒ 排除，理由「已停用」
       14：active 但 openedAt 在本月 20 号 ⇒ 排除，理由「当月还没开店」
     ⚠️ 13 / 14 都必须出现在「未参与」文案里 —— 少了任何一态，"排除项显式列出"就少验一半。 */
  var SHOPS = [
    { id: 11, platform: 'shopee', name: 'HK 优品店', nameKey: 'hk 优品店', platformShopId: '', shopUrl: '', site: 'MY', status: 'active', score: 0, openedAt: '2025-03-01', note: '', createdAt: '', updatedAt: '', aliasCount: 0 },
    { id: 12, platform: 'amazon', name: 'Aurora Store', nameKey: 'aurora store', platformShopId: '', shopUrl: '', site: 'US', status: 'active', score: 0, openedAt: '2026-01-10', note: '', createdAt: '', updatedAt: '', aliasCount: 0 },
    { id: 13, platform: 'aliexpress', name: '老店', nameKey: '老店', platformShopId: '', shopUrl: '', site: '', status: 'archived', score: 0, openedAt: '2024-06-01', note: '', createdAt: '', updatedAt: '', aliasCount: 0 },
    { id: 14, platform: 'shopee', name: '新店筹备', nameKey: '新店筹备', platformShopId: '', shopUrl: '', site: '', status: 'active', score: 0, openedAt: MONTH + '-20', note: '', createdAt: '', updatedAt: '', aliasCount: 0 },
  ];

  var CATEGORIES = [
    { id: 101, kind: 'expense', name: '采购货款', builtin: true, sort: 1, archived: false },
    { id: 102, kind: 'expense', name: '房租水电', builtin: true, sort: 2, archived: false },
    { id: 201, kind: 'income', name: '店铺回款', builtin: true, sort: 1, archived: false },
  ];
  var CAT_SEQ = 300;

  var PARTIES = [
    { id: 21, name: '广州布行', kind: 'supplier', phone: '', note: '面料主供应商', archived: false, createdAt: '', updatedAt: '' },
    { id: 22, name: 'Shopee 平台', kind: 'platform', phone: '', note: '', archived: false, createdAt: '', updatedAt: '' },
    { id: 23, name: '房东陈', kind: 'landlord', phone: '13900000000', note: '', archived: false, createdAt: '', updatedAt: '' },
    { id: 24, name: '张伟', kind: 'staff', phone: '', note: '仓库临时工', archived: false, createdAt: '', updatedAt: '' },
  ];
  var PARTY_SEQ = 900;

  /* 条目：六条有效 + 一条作废。覆盖「专属 / 公共(手工比例) / 按营收(旧账) / 已结算 / 作废」五态。
     金额口径（整月有效）：收入 5000.00 / 支出 6280.00 / 结余 -1280.00 / 条目 6 / 公共 5000.00 —
     这五个数在断言里是**具体值**，桩下面不另存一份汇总（汇总由 buildSummary 现算）。 */
  var ENTRIES = [
    { id: 1, bizDate: d(3), kind: 'expense', scope: 'shop', shopId: 11, partyId: 21, categoryId: 101, amountCents: 120000, basis: '', note: '面料款', status: 'active', voidReason: '', settled: false, settlementId: 0 },
    { id: 2, bizDate: d(8), kind: 'income', scope: 'shop', shopId: 12, partyId: 22, categoryId: 201, amountCents: 500000, basis: '', note: '平台回款', status: 'active', voidReason: '', settled: false, settlementId: 0 },
    { id: 3, bizDate: d(1), kind: 'expense', scope: 'shared', shopId: 0, partyId: 23, categoryId: 102, amountCents: 300000, basis: 'manual', note: '房租', status: 'active', voidReason: '', settled: false, settlementId: 0,
      allocations: [ { shopId: 11, amountCents: 200000, ratioBp: 6667 }, { shopId: 12, amountCents: 100000, ratioBp: 3333 } ] },
    { id: 4, bizDate: d(5), kind: 'expense', scope: 'shop', shopId: 11, partyId: 21, categoryId: 101, amountCents: 5000, basis: '', note: '补差价', status: 'active', voidReason: '', settled: true, settlementId: 9 },
    { id: 5, bizDate: d(9), kind: 'expense', scope: 'shop', shopId: 11, partyId: 21, categoryId: 101, amountCents: 8800, basis: '', note: '重复录入', status: 'void', voidReason: '金额录错，已重记一笔', settled: false, settlementId: 0 },
    { id: 6, bizDate: d(7), kind: 'expense', scope: 'shared', shopId: 0, partyId: 21, categoryId: 101, amountCents: 200000, basis: 'revenue', note: '按营收分摊的旧账', status: 'active', voidReason: '', settled: false, settlementId: 0,
      allocations: [ { shopId: 11, amountCents: 120000, ratioBp: 6000 }, { shopId: 12, amountCents: 80000, ratioBp: 4000 } ] },
    { id: 7, bizDate: d(12), kind: 'expense', scope: 'shop', shopId: 12, partyId: 24, categoryId: 101, amountCents: 3000, basis: '', note: '员工垫付', status: 'active', voidReason: '', settled: false, settlementId: 0 },
  ];
  var ENTRY_SEQ = 100;

  /* 结算单：pre-existing #9 覆盖条目 4（¥50.00「我付给对方」）。
     有它才能验"已结算不再出现在候选里""已结算净额参与未结清"这两条 ——
     若夹具里一个结算单都没有，把 settledNet 整个漏掉也照样全绿。 */
  var SETTLEMENTS = [
    { id: 9, partyId: 21, settleDate: d(6), direction: 'pay', amountCents: 5000, method: '现金', note: '', status: 'active', voidReason: '', entryIds: [4] },
  ];
  var SETTLE_SEQ = 9;

  /* 订单营收（「按营收占比」的取数）：
       已归属 = HK 1500.00 + Aurora 500.00 = 2000.00
       未登记店铺 300.00 / 未写店铺 200.00 / 关闭单 9999.99（不计营收）/ 缺金额 1 行
     合计 = 2000 + 300 + 200 = 2500.00 —— 三个分桶必须**都显式提示**，
     否则"按已归属的部分摊钱"看起来完全正常（这是最坏的一种错）。 */
  var ORDER_ROWS = [
    { id: 901, orderNo: 'O-901', source: 'import', shop: 'HK 优品店', shopKey: 'hk 优品店', orderTime: MONTH + '-03 10:00:00', bizStatus: '交易完成', amountCents: 100000, rawFields: {} },
    { id: 902, orderNo: 'O-902', source: 'import', shop: 'HK 优品店', shopKey: 'hk 优品店', orderTime: MONTH + '-04 10:00:00', bizStatus: '交易完成', amountCents: 50000, rawFields: {} },
    { id: 903, orderNo: 'O-903', source: 'import', shop: 'Aurora Store', shopKey: 'aurora store', orderTime: MONTH + '-05 10:00:00', bizStatus: '交易完成', amountCents: 50000, rawFields: {} },
    { id: 904, orderNo: 'O-904', source: 'import', shop: 'Aurora Store', shopKey: 'aurora store', orderTime: MONTH + '-06 10:00:00', bizStatus: '订单关闭', amountCents: 999999, rawFields: {} },
    { id: 905, orderNo: 'O-905', source: 'import', shop: '幽灵店', shopKey: '幽灵店', orderTime: MONTH + '-07 10:00:00', bizStatus: '交易完成', amountCents: 30000, rawFields: {} },
    { id: 906, orderNo: 'O-906', source: 'import', shop: '', shopKey: '', orderTime: MONTH + '-08 10:00:00', bizStatus: '交易完成', amountCents: 20000, rawFields: {} },
    { id: 907, orderNo: 'O-907', source: 'import', shop: 'HK 优品店', shopKey: 'hk 优品店', orderTime: MONTH + '-09 10:00:00', bizStatus: '交易完成', amountCents: null, rawFields: {} },
  ];

  /* 分摊方案（周期性固定开销存一次，下次一键套用）—— 初始两条，方案往返再从界面新建一条 */
  var RULES = [
    { id: 31, name: '每月房租', basis: 'manual', shopIds: [11, 12], ratios: [6667, 3333], note: '', archived: false },
    { id: 32, name: '公共广告', basis: 'equal', shopIds: [12, 11], ratios: [], note: '', archived: false },
  ];
  var RULE_SEQ = 40;

  function findRule(id) {
    for (var i = 0; i < RULES.length; i++) if (RULES[i].id === Number(id)) return RULES[i];
    return null;
  }

  function listRules() {
    return RULES.filter(function (r) { return !r.archived; }).map(function (r) {
      return { id: r.id, name: r.name, basis: r.basis, shopIds: r.shopIds.slice(), ratios: r.ratios.slice(), note: r.note, archived: r.archived };
    });
  }

  function upsertRule(p) {
    var id = Number(p && p.id) || 0;
    var hit = findRule(id);
    var created = false;
    if (!hit) {
      hit = { id: ++RULE_SEQ, name: '', basis: 'equal', shopIds: [], ratios: [], note: '', archived: false };
      RULES.push(hit);
      created = true;
    }
    if (p.name !== undefined) hit.name = String(p.name);
    if (p.basis) hit.basis = p.basis;
    if (Array.isArray(p.shopIds)) hit.shopIds = p.shopIds.map(Number);
    if (Array.isArray(p.ratios)) hit.ratios = p.ratios.map(Number);
    if (p.note !== undefined) hit.note = String(p.note);
    window.__smokeLedger.lastRuleId = hit.id;
    return { id: hit.id, created: created };
  }

  function findEntry(id) {
    for (var i = 0; i < ENTRIES.length; i++) if (ENTRIES[i].id === Number(id)) return ENTRIES[i];
    return null;
  }
  function findParty(id) {
    for (var i = 0; i < PARTIES.length; i++) if (PARTIES[i].id === Number(id)) return PARTIES[i];
    return null;
  }
  function findCategory(id) {
    for (var i = 0; i < CATEGORIES.length; i++) if (CATEGORIES[i].id === Number(id)) return CATEGORIES[i];
    return null;
  }
  function findShop(id) {
    for (var i = 0; i < SHOPS.length; i++) if (SHOPS[i].id === Number(id)) return SHOPS[i];
    return null;
  }

  /** 行形状照搬 LedgerEntryRow：名字每次现算 —— 相关人改名 / 停用后，历史行要跟着变。 */
  function decorate(e) {
    var p = findParty(e.partyId);
    var c = findCategory(e.categoryId);
    var s = findShop(e.shopId);
    return {
      id: e.id,
      bizDate: e.bizDate,
      period: String(e.bizDate || '').slice(0, 7),
      kind: e.kind,
      scope: e.scope,
      shopId: e.shopId,
      shopName: s ? s.name : '',
      partyId: e.partyId,
      partyName: p ? p.name : '',
      partyArchived: p ? !!p.archived : false,
      categoryId: e.categoryId,
      categoryName: c ? c.name : '',
      amountCents: e.amountCents,
      basis: e.basis || '',
      ruleId: Number(e.ruleId) || 0,
      method: e.method || '',
      note: e.note || '',
      status: e.status,
      voidReason: e.voidReason || '',
      settled: !!e.settled,
      settlementId: e.settlementId || 0,
      allocCount: e.scope === 'shared' ? (e.allocations || []).length : 1,
      createdAt: e.createdAt || '',
      updatedAt: e.updatedAt || '',
    };
  }

  /* 与主进程 ledgerSummary 同口径：只算有效条目；店铺轴按**分摊行**归属。
     「period」为空串 = 全期间（往来对账恒等式用累计口径，不能拿"本月"去比）。
     P4 起 byShop 给四个分项（专属 / 公摊 × 收 / 支）+ publicPoolCents —— 汇总页与单店页
     都从这四个分项相加，不各自再写一套求和。 */
  function buildSummary(period) {
    var income = 0, expense = 0, count = 0, sharedIncome = 0, sharedExpense = 0, sharedCount = 0;
    var byShop = {}, byCat = {};
    for (var i = 0; i < ENTRIES.length; i++) {
      var e = ENTRIES[i];
      if (e.status !== 'active') continue;
      if (period && String(e.bizDate).slice(0, 7) !== period) continue;
      count++;
      if (e.kind === 'income') income += e.amountCents;
      else expense += e.amountCents;
      if (e.scope === 'shared') {
        // 公共金额按方向拆（与主进程同一口径）：混加会让"其中公共"读不出意思
        if (e.kind === 'income') sharedIncome += e.amountCents;
        else sharedExpense += e.amountCents;
        sharedCount++;
      }
      var catKey = e.categoryId;
      if (!byCat[catKey]) byCat[catKey] = { amountCents: 0 };
      byCat[catKey].amountCents += e.amountCents;
      var rows = e.scope === 'shop'
        ? [ { shopId: e.shopId, amountCents: e.amountCents } ]
        : (e.allocations || []);
      for (var j = 0; j < rows.length; j++) {
        var k = rows[j].shopId;
        if (!byShop[k]) {
          byShop[k] = {
            directIncomeCents: 0, sharedIncomeCents: 0,
            directExpenseCents: 0, sharedExpenseCents: 0,
            sharedEntryCount: 0,
          };
        }
        var b = byShop[k];
        if (e.kind === 'income') {
          if (e.scope === 'shared') b.sharedIncomeCents += rows[j].amountCents;
          else b.directIncomeCents += rows[j].amountCents;
        } else if (e.scope === 'shared') {
          b.sharedExpenseCents += rows[j].amountCents;
        } else {
          b.directExpenseCents += rows[j].amountCents;
        }
        if (e.scope === 'shared') b.sharedEntryCount++;
      }
    }
    var shopRows = Object.keys(byShop).map(function (k) {
      var s = findShop(k);
      var r = byShop[k];
      var inc = r.directIncomeCents + r.sharedIncomeCents;
      var exp = r.directExpenseCents + r.sharedExpenseCents;
      return {
        shopId: Number(k),
        shopName: s ? s.name : '',
        shopStatus: s ? s.status : '',
        directIncomeCents: r.directIncomeCents,
        sharedIncomeCents: r.sharedIncomeCents,
        directExpenseCents: r.directExpenseCents,
        sharedExpenseCents: r.sharedExpenseCents,
        incomeCents: inc,
        expenseCents: exp,
        balanceCents: inc - exp,
        sharedEntryCount: r.sharedEntryCount,
      };
    });
    var catRows = Object.keys(byCat).map(function (k) {
      var c = findCategory(k);
      return { categoryId: Number(k), categoryName: c ? c.name : '', kind: c ? c.kind : 'expense', amountCents: byCat[k].amountCents };
    });
    // 公共池 = (收入 − 支出) − Σ各店结余；恒 0。异常注入用 window.__smokeIntegrity（缺字段按正常值兜底）
    var pool = income - expense - shopRows.reduce(function (s, r) { return s + r.balanceCents; }, 0);
    var integrity;
    if (window.__smokeIntegrity) {
      var o = window.__smokeIntegrity;
      integrity = {
        allocationGapCents: Number(o.allocationGapCents) || 0,
        partyGapCents: Number(o.partyGapCents) || 0,
        publicPoolCents: typeof o.publicPoolCents === 'number' ? o.publicPoolCents : pool,
        brokenEntries: o.brokenEntries || [],
        missingPartyEntries: o.missingPartyEntries || [],
      };
    } else {
      integrity = {
        allocationGapCents: 0, partyGapCents: 0, publicPoolCents: pool,
        brokenEntries: [], missingPartyEntries: [],
      };
    }
    return {
      period: period,
      incomeCents: income,
      expenseCents: expense,
      balanceCents: income - expense,
      entryCount: count,
      sharedIncomeCents: sharedIncome,
      sharedExpenseCents: sharedExpense,
      sharedEntryCount: sharedCount,
      byShop: shopRows,
      byCategory: catRows,
      integrity: integrity,
    };
  }

  function eligible(period) {
    var first = period + '-01';
    var out = { eligible: [], excluded: [] };
    for (var i = 0; i < SHOPS.length; i++) {
      var s = SHOPS[i];
      // 与主进程 eligibleShops 同一条口径：退店（exited）**仍可参与分摊**，
      // 只有停用 / 封店才算 inactive。假桥这里少一个分支，夹具里退店的店就会恒绿。
      if (s.status !== 'active' && s.status !== 'exited') {
        out.excluded.push({ id: s.id, name: s.name, reason: 'inactive', status: s.status });
        continue;
      }
      if (!s.openedAt || s.openedAt > first) {
        out.excluded.push({ id: s.id, name: s.name, reason: 'not-open-yet', status: s.status });
        continue;
      }
      out.eligible.push({ id: s.id, name: s.name });
    }
    return out;
  }

  function entryList(p) {
    p = p || {};
    var period = String(p.period || '');
    var out = [];
    for (var i = 0; i < ENTRIES.length; i++) {
      var raw = ENTRIES[i];
      if (period && String(raw.bizDate).slice(0, 7) !== period) continue;
      if (!p.includeVoid && raw.status === 'void') continue;
      if (p.kind && raw.kind !== p.kind) continue;
      if (p.scope && raw.scope !== p.scope) continue;
      if (p.categoryId && Number(raw.categoryId) !== Number(p.categoryId)) continue;
      if (p.partyId && Number(raw.partyId) !== Number(p.partyId)) continue;
      if (p.shopId) {
        var sid = Number(p.shopId);
        var hit = raw.scope === 'shop'
          ? Number(raw.shopId) === sid
          : (raw.allocations || []).some(function (a) { return Number(a.shopId) === sid; });
        if (!hit) continue;
      }
      if (p.settleStatus === 'settled' && !raw.settled) continue;
      if (p.settleStatus === 'unsettled' && raw.settled) continue;
      var row = decorate(raw);
      if (p.keyword) {
        var hay = (row.note + ' ' + row.categoryName + ' ' + row.partyName + ' ' + row.shopName);
        if (hay.indexOf(String(p.keyword)) < 0) continue;
      }
      out.push(row);
    }
    out.sort(function (a, b) {
      if (a.bizDate !== b.bizDate) return a.bizDate < b.bizDate ? 1 : -1;
      return b.id - a.id;
    });
    return out;
  }

  function entryDetail(id) {
    var e = findEntry(id);
    if (!e) return null;
    var d = decorate(e);
    d.allocations = (e.allocations || []).map(function (a) {
      var s = findShop(a.shopId);
      return { shopId: a.shopId, shopName: s ? s.name : '', amountCents: a.amountCents, ratioBp: a.ratioBp };
    });
    return d;
  }

  function upsertEntry(p) {
    var id = Number(p && p.id) || 0;
    var hit = findEntry(id);
    var created = false;
    if (!hit) {
      hit = {
        id: ++ENTRY_SEQ, bizDate: '', kind: 'expense', scope: 'shop', shopId: 0, partyId: 0,
        categoryId: 0, amountCents: 0, basis: '', note: '', status: 'active', voidReason: '',
        settled: false, settlementId: 0,
      };
      ENTRIES.push(hit);
      created = true;
    }
    if (p.bizDate) hit.bizDate = p.bizDate;
    if (p.kind) hit.kind = p.kind;
    if (p.scope) hit.scope = p.scope;
    if (p.partyId !== undefined) hit.partyId = Number(p.partyId) || 0;
    if (p.categoryId !== undefined) hit.categoryId = Number(p.categoryId) || 0;
    if (p.amountCents !== undefined) hit.amountCents = Number(p.amountCents) || 0;
    if (p.ruleId !== undefined) hit.ruleId = Number(p.ruleId) || 0;
    if (p.note !== undefined) hit.note = String(p.note);
    if (hit.scope === 'shop') {
      hit.shopId = Number(p.shopId) || 0;
      hit.allocations = [];
      hit.basis = '';
    } else {
      hit.shopId = 0;
      if (p.basis) hit.basis = p.basis;
      // 营收基准的旧条目重存时**不带** allocations —— 必须沿用库里那份（界面没有营收口径可重算）
      if (p.allocations && p.allocations.length) {
        hit.allocations = p.allocations.map(function (a) {
          return { shopId: Number(a.shopId), amountCents: Number(a.amountCents), ratioBp: Number(a.ratioBp) || 0 };
        });
      }
    }
    window.__smokeLedger.lastEntryId = hit.id;
    return { id: hit.id, created: created, allocations: (hit.allocations || []).length, settledLocked: !!hit.settled };
  }
  function partyList(p) {
    p = p || {};
    var out = [];
    for (var i = 0; i < PARTIES.length; i++) {
      var x = PARTIES[i];
      if (!p.includeArchived && x.archived) continue;
      var count = 0;
      for (var j = 0; j < ENTRIES.length; j++) {
        if (ENTRIES[j].partyId === x.id && ENTRIES[j].status === 'active') count++;
      }
      out.push({ id: x.id, name: x.name, kind: x.kind, phone: x.phone, note: x.note, archived: x.archived, mergedTo: Number(x.mergedTo) || 0, createdAt: x.createdAt, updatedAt: x.updatedAt, entryCount: count });
    }
    return out;
  }

  function upsertParty(p) {
    var id = Number(p && p.id) || 0;
    var hit = findParty(id);
    var created = false;
    if (!hit) {
      hit = { id: ++PARTY_SEQ, name: '', kind: 'other', phone: '', note: '', archived: false, createdAt: '', updatedAt: '' };
      PARTIES.push(hit);
      created = true;
    }
    if (p.name) hit.name = p.name;
    if (p.kind) hit.kind = p.kind;
    if (p.phone !== undefined) hit.phone = p.phone;
    if (p.note !== undefined) hit.note = p.note;
    if (typeof p.archived === 'boolean') hit.archived = p.archived;
    window.__smokeLedger.lastPartyId = hit.id;
    return { id: hit.id, created: created };
  }

  function mergeParty(p) {
    var from = findParty(p.fromId);
    var to = findParty(p.toId);
    if (!from || !to) return { success: false, error: '相关人不存在' };
    var moved = 0;
    for (var i = 0; i < ENTRIES.length; i++) {
      var e = ENTRIES[i];
      if (e.partyId === from.id && !e.settled) {
        e.partyId = to.id;
        moved++;
      }
    }
    from.archived = true;
    from.mergedTo = to.id; // 与主进程一致：archived + merged_to = 「已并入 → B」，只 archived 才是「手动停用」
    return { success: true, data: { fromId: from.id, toId: to.id, movedEntries: moved, transferredCents: 0 } };
  }

  /* ---- 往来与结算（与 electron/ledger-db.ts 的 partyLedger / createSettlement 同口径）---- */

  function findSettlement(id) {
    for (var i = 0; i < SETTLEMENTS.length; i++) if (SETTLEMENTS[i].id === Number(id)) return SETTLEMENTS[i];
    return null;
  }

  /**
   * 一张结算单的两侧毛额（与主进程同一口径：按**条目 kind** 拆，不按单据 direction 猜）。
   * 夹具里的普通单没有 entryIds 时按 direction 兜底 —— 这是**测试桩**的妥协，
   * 真实数据里有效单必有结算行，不存在这个分支。
   */
  function settleSides(s) {
    if (s.direction !== 'offset') {
      return s.direction === 'pay'
        ? { payCents: s.amountCents, receiveCents: 0 }
        : { payCents: 0, receiveCents: s.amountCents };
    }
    var payCents = 0;
    var receiveCents = 0;
    var ids = s.entryIds || [];
    for (var i = 0; i < ids.length; i++) {
      var e = findEntry(ids[i]);
      if (!e) continue;
      if (e.kind === 'expense') payCents += e.amountCents;
      else receiveCents += e.amountCents;
    }
    return { payCents: payCents, receiveCents: receiveCents };
  }

  /** 一个人的往来五行（台账与抽屉都读它，桩里只此一份算法）。 */
  function partyLedgerRows(filter) {
    filter = filter || {};
    var out = [];
    for (var i = 0; i < PARTIES.length; i++) {
      var x = PARTIES[i];
      if (!filter.includeArchived && x.archived) continue;
      if (filter.partyId && Number(filter.partyId) !== x.id) continue;
      var receivable = 0, payable = 0, settledPay = 0, settledReceive = 0, lastDate = '';
      for (var j = 0; j < ENTRIES.length; j++) {
        var e = ENTRIES[j];
        if (e.partyId !== x.id || e.status !== 'active') continue;
        if (e.kind === 'income') receivable += e.amountCents;
        else payable += e.amountCents;
      }
      for (var k = 0; k < SETTLEMENTS.length; k++) {
        var s = SETTLEMENTS[k];
        if (s.partyId !== x.id || s.status !== 'active') continue;
        /* 两侧毛额**按条目 kind 算**，不按单据 direction 猜 —— 与主进程同一口径：
           互抵单一张同时含两类行，按 direction 猜会把应收方向的余额留成假余额。 */
        var sides = settleSides(s);
        settledPay += sides.payCents;
        settledReceive += sides.receiveCents;
        if (!lastDate || s.settleDate > lastDate) lastDate = s.settleDate;
      }
      var net = receivable - payable;
      var settledNet = settledPay - settledReceive;
      out.push({
        partyId: x.id,
        partyName: x.name,
        kind: x.kind,
        archived: !!x.archived,
        mergedTo: Number(x.mergedTo) || 0,
        receivableCents: receivable,
        payableCents: payable,
        netCents: net,
        settledNetCents: settledNet,
        unsettledCents: net + settledNet,
        unsettledReceivableCents: receivable - settledReceive,
        unsettledPayableCents: payable - settledPay,
        transferCents: 0,
        lastSettleDate: lastDate,
      });
    }
    out.sort(function (a, b) {
      if (a.archived !== b.archived) return a.archived ? 1 : -1;
      return a.partyName < b.partyName ? -1 : a.partyName > b.partyName ? 1 : 0;
    });
    return out;
  }

  /**
   * 生成结算单：**金额只按条目求和**，不读 payload.amountCents（与主进程一致）。
   * 主进程的五道拦截在这里都要有，否则"重复结算被拒""方向不符被拒"只能测到组件层的假象。
   */
  function createSettlement(p) {
    p = p || {};
    var party = findParty(p.partyId);
    if (!party) return { success: false, error: '相关人不存在' };
    var direction =
      p.direction === 'receive' ? 'receive' : p.direction === 'offset' ? 'offset' : 'pay';
    var ids = (p.entryIds || []).map(Number).filter(function (x) { return x > 0; });
    if (!ids.length) return { success: false, error: '请至少勾选一条要结算的条目' };
    if (!p.settleDate) return { success: false, error: '结算日期不合法' };
    var wantKind = direction === 'pay' ? 'expense' : 'income';
    var picked = [];
    var total = 0;
    var paySum = 0;
    var receiveSum = 0;
    for (var i = 0; i < ids.length; i++) {
      var e = findEntry(ids[i]);
      if (!e) return { success: false, error: '条目 #' + ids[i] + ' 不存在' };
      if (e.partyId !== party.id) return { success: false, error: '条目 #' + e.id + ' 不属于「' + party.name + '」，不能一起结算' };
      if (e.status !== 'active') return { success: false, error: '条目 #' + e.id + ' 已作废，不能结算' };
      if (direction !== 'offset' && e.kind !== wantKind) {
        return { success: false, error: '「' + (direction === 'pay' ? '我付给对方' : '对方付给我') + '」只能结算' + (wantKind === 'expense' ? '支出' : '收入') + '条目，条目 #' + e.id + ' 不是' };
      }
      if (e.settled) return { success: false, error: '条目 #' + e.id + ' 已结算过（结算单 #' + e.settlementId + '），不能重复结算' };
      picked.push(e);
      total += e.amountCents;
      if (e.kind === 'expense') paySum += e.amountCents;
      else receiveSum += e.amountCents;
    }
    var bal = partyLedgerRows({ includeArchived: true, partyId: party.id })[0];
    if (!bal) return { success: false, error: '相关人往来余额读取失败' };
    if (direction === 'offset') {
      if (paySum <= 0 || receiveSum <= 0) {
        return { success: false, error: '互抵结清必须同时勾选收入与支出条目；只勾单方向请改选「我付给对方」或「对方付给我」' };
      }
      if (paySum > bal.unsettledPayableCents) {
        return { success: false, error: '互抵里的支出部分 ' + paySum + ' 分超出应付未结清 ' + bal.unsettledPayableCents + ' 分' };
      }
      if (receiveSum > bal.unsettledReceivableCents) {
        return { success: false, error: '互抵里的收入部分 ' + receiveSum + ' 分超出应收未结清 ' + bal.unsettledReceivableCents + ' 分' };
      }
    } else {
      var available = direction === 'pay' ? bal.unsettledPayableCents : bal.unsettledReceivableCents;
      if (available <= 0) return { success: false, error: '这个人在「' + (direction === 'pay' ? '应付' : '应收') + '」方向已经没有余额了，没有可结算的条目' };
      if (total > available) return { success: false, error: '结算金额超出该方向未结清 ' + available + ' 分（本期不支持预付/多付）' };
    }

    var row = {
      id: ++SETTLE_SEQ,
      partyId: party.id,
      settleDate: p.settleDate,
      direction: direction,
      amountCents: total,
      method: String(p.method || ''),
      note: String(p.note || ''),
      status: 'active',
      voidReason: '',
      entryIds: ids.slice(),
    };
    SETTLEMENTS.push(row);
    for (var m = 0; m < picked.length; m++) {
      picked[m].settled = true;
      picked[m].settlementId = row.id;
    }
    return {
      success: true,
      data: {
        id: row.id,
        amountCents: total,
        entryCount: ids.length,
        cashCents: paySum - receiveSum,
      },
    };
  }

  function settleList(p) {
    p = p || {};
    var out = [];
    for (var i = 0; i < SETTLEMENTS.length; i++) {
      var s = SETTLEMENTS[i];
      if (p.partyId && Number(p.partyId) !== s.partyId) continue;
      var party = findParty(s.partyId);
      var sides = settleSides(s);
      out.push({
        id: s.id,
        partyId: s.partyId,
        partyName: party ? party.name : '',
        settleDate: s.settleDate,
        direction: s.direction,
        amountCents: s.amountCents,
        payCents: sides.payCents,
        receiveCents: sides.receiveCents,
        cashCents: sides.payCents - sides.receiveCents,
        method: s.method,
        note: s.note,
        status: s.status,
        voidReason: s.voidReason,
        // 与主进程一致：已撤销的单没有有效结算行，件数按 0 计
        entryCount: s.status === 'active' ? s.entryIds.length : 0,
      });
    }
    out.sort(function (a, b) {
      if (a.settleDate !== b.settleDate) return a.settleDate < b.settleDate ? 1 : -1;
      return b.id - a.id;
    });
    return out;
  }

  function voidSettlement(p) {
    p = p || {};
    var s = findSettlement(p.id);
    if (!s) return { success: false, error: '结算单不存在' };
    var why = String(p.reason || '').trim();
    if (!why) return { success: false, error: '撤销结算必须填写原因' };
    if (s.status === 'void') return { success: true, data: { id: s.id, voided: false } };
    s.status = 'void';
    s.voidReason = why;
    for (var i = 0; i < s.entryIds.length; i++) {
      var e = findEntry(s.entryIds[i]);
      if (!e) continue;
      e.settled = false;
      e.settlementId = 0;
    }
    return { success: true, data: { id: s.id, voided: true } };
  }

  /* ---- P4：批量变更相关人（与 electron/ledger-db.ts 的 preview / 三路同口径）---- */

  function repatchBaseUnsettled(partyId) {
    var rows = partyLedgerRows({ includeArchived: true, partyId: partyId });
    return rows.length ? rows[0].unsettledCents : 0;
  }

  function repatchPreview(entryIds) {
    var ids = (entryIds || []).map(Number).filter(function (x) { return x > 0; });
    var rows = [], missing = [], voidIds = [];
    for (var i = 0; i < ids.length; i++) {
      var e = findEntry(ids[i]);
      if (!e) { missing.push(ids[i]); continue; }
      if (e.status !== 'active') { voidIds.push(e.id); continue; }
      rows.push(e);
    }
    var partyAcc = {}, settleAcc = {};
    var unsettledCount = 0, unsettledCents = 0, settledCount = 0, settledCents = 0;
    for (var j = 0; j < rows.length; j++) {
      var r = rows[j];
      var p = findParty(r.partyId);
      var signed = r.kind === 'income' ? r.amountCents : -r.amountCents;
      var acc = partyAcc[r.partyId];
      if (!acc) {
        acc = partyAcc[r.partyId] = {
          partyId: r.partyId,
          partyName: p ? p.name : '',
          baseUnsettled: repatchBaseUnsettled(r.partyId),
          selectedCount: 0, selectedCents: 0,
          selectedSettledCount: 0, selectedSettledCents: 0,
          signedAll: 0, signedUnsettled: 0, settledNetSelected: 0,
        };
      }
      acc.selectedCount++;
      acc.selectedCents += r.amountCents;
      acc.signedAll += signed;
      if (r.settled) {
        settledCount++;
        settledCents += r.amountCents;
        acc.selectedSettledCount++;
        acc.selectedSettledCents += r.amountCents;
        var st = findSettlement(r.settlementId);
        if (st) {
          var sa = settleAcc[st.id];
          if (!sa) {
            // 作废是整单作废：撤掉的是**整张单**结的金额（不只是本次选中那条），每单只计一次
            acc.settledNetSelected += st.direction === 'pay' ? st.amountCents : -st.amountCents;
            var sp = findParty(st.partyId);
            sa = settleAcc[st.id] = {
              id: st.id,
              partyId: st.partyId,
              partyName: sp ? sp.name : '',
              settleDate: st.settleDate,
              direction: st.direction,
              amountCents: st.amountCents,
              entryCount: st.status === 'active' ? st.entryIds.length : 0,
              selectedCount: 0,
            };
          }
          sa.selectedCount++;
        }
      } else {
        unsettledCount++;
        unsettledCents += r.amountCents;
        acc.signedUnsettled += signed;
      }
    }
    var fromParties = Object.keys(partyAcc).map(function (k) {
      var a = partyAcc[k];
      return {
        partyId: a.partyId,
        partyName: a.partyName,
        unsettledCents: a.baseUnsettled,
        selectedCount: a.selectedCount,
        selectedCents: a.selectedCents,
        selectedSettledCount: a.selectedSettledCount,
        selectedSettledCents: a.selectedSettledCents,
        afterMoveCents: a.baseUnsettled - a.signedUnsettled,
        afterVoidMoveCents: a.baseUnsettled - a.signedAll - a.settledNetSelected,
      };
    });
    var settlements = Object.keys(settleAcc).map(function (k) { return settleAcc[k]; });
    settlements.sort(function (a, b) { return b.id - a.id; });
    var collateral = settlements.reduce(function (sum, s) {
      return sum + Math.max(0, s.entryCount - s.selectedCount);
    }, 0);
    return {
      entries: rows.map(function (r) {
        var p = findParty(r.partyId);
        return {
          id: r.id,
          bizDate: r.bizDate,
          kind: r.kind,
          amountCents: r.amountCents,
          partyId: r.partyId,
          partyName: p ? p.name : '',
          status: 'active',
          settlementId: r.settled ? r.settlementId : 0,
        };
      }),
      missingIds: missing,
      voidIds: voidIds,
      fromParties: fromParties,
      settlements: settlements,
      unsettledCount: unsettledCount,
      unsettledCents: unsettledCents,
      settledCount: settledCount,
      settledCents: settledCents,
      collateralEntryCount: collateral,
      recommended: settledCount === 0 ? 'move-all' : 'move-unsettled',
    };
  }

  /** 三路变更：桩必须真改条目与结算单 —— 只回成功的话，"改挂后列表/台账跟着变"会靠乐观更新蒙对 */
  function repatchEntries(p) {
    p = p || {};
    var ids = (p.entryIds || []).map(Number).filter(function (x) { return x > 0; });
    if (!ids.length) return { success: false, error: '请至少选择一条条目' };
    var mode = String(p.mode || '');
    if (mode !== 'move-all' && mode !== 'move-unsettled' && mode !== 'void-then-move') {
      return { success: false, error: '变更相关人缺少有效路径（改挂 / 只改挂未结算 / 撤销结算后改挂）' };
    }
    var why = String(p.reason || '').trim();
    if (mode === 'void-then-move' && !why) return { success: false, error: '撤销结算后改挂必须填写原因' };
    var to = findParty(p.toPartyId);
    if (!to) return { success: false, error: '目标相关人不存在' };
    if (to.archived) return { success: false, error: '目标相关人已停用，请先启用或换一个' };

    var rows = [], missing = [], voided = [];
    for (var i = 0; i < ids.length; i++) {
      var e = findEntry(ids[i]);
      if (!e) { missing.push(ids[i]); continue; }
      if (e.status === 'void') { voided.push(e.id); continue; }
      rows.push(e);
    }
    if (missing.length) return { success: false, error: '有 ' + missing.length + ' 条条目不存在（id: ' + missing.join(', ') + '）' };
    if (voided.length) return { success: false, error: '有 ' + voided.length + ' 条已作废条目不能变更相关人（id: ' + voided.join(', ') + '）' };

    var movable = rows.filter(function (r) { return r.partyId !== to.id; });
    if (!movable.length) return { success: false, error: '所选条目已经都属于该相关人，无需变更' };
    var settled = movable.filter(function (r) { return r.settled; });
    var moves = movable, kept = [];
    if (mode === 'move-all' && settled.length) {
      return { success: false, error: '有 ' + settled.length + ' 条已结算条目不能直接改挂（会与历史结算单对不上）：请改用「只改挂未结算」或「撤销结算后改挂」' };
    }
    if (mode === 'move-unsettled') {
      moves = movable.filter(function (r) { return !r.settled; });
      kept = settled;
      if (!moves.length) {
        return { success: false, error: '所选条目都已被结算，没有可改挂的未结算条目；请改用「撤销结算后改挂」' };
      }
    }

    var voidedSettlements = [];
    if (mode === 'void-then-move' && settled.length) {
      var seen = [];
      for (var s = 0; s < settled.length; s++) {
        var sid = settled[s].settlementId;
        if (seen.indexOf(sid) >= 0) continue;
        seen.push(sid);
        var st = findSettlement(sid);
        if (!st) continue;
        var count = st.entryIds.length;
        if (st.status === 'active') {
          st.status = 'void';
          st.voidReason = why;
          for (var l = 0; l < st.entryIds.length; l++) {
            var le = findEntry(st.entryIds[l]);
            if (!le) continue;
            le.settled = false;
            le.settlementId = 0;
          }
        }
        voidedSettlements.push({
          id: st.id,
          settleDate: st.settleDate,
          direction: st.direction,
          amountCents: st.amountCents,
          entryCount: count,
        });
      }
    }

    var fromAcc = {}, movedCents = 0;
    for (var m = 0; m < moves.length; m++) {
      var r = moves[m];
      var fromId = r.partyId;
      var fp = findParty(fromId);
      r.partyId = to.id;
      movedCents += r.amountCents;
      var acc = fromAcc[fromId];
      if (!acc) {
        acc = fromAcc[fromId] = { partyId: fromId, partyName: fp ? fp.name : '', movedCount: 0, movedCents: 0 };
      }
      acc.movedCount++;
      acc.movedCents += r.amountCents;
    }
    var fromParties = Object.keys(fromAcc).map(function (k) {
      var a = fromAcc[k];
      return {
        partyId: a.partyId,
        partyName: a.partyName,
        movedCount: a.movedCount,
        movedCents: a.movedCents,
        remainingUnsettledCents: repatchBaseUnsettled(a.partyId),
      };
    });
    var keptCents = kept.reduce(function (sum, r) { return sum + r.amountCents; }, 0);
    return {
      success: true,
      data: {
        mode: mode,
        toPartyId: to.id,
        toPartyName: to.name,
        movedCount: moves.length,
        movedCents: movedCents,
        keptSettledCount: kept.length,
        keptSettledCents: keptCents,
        voidedSettlements: voidedSettlements,
        fromParties: fromParties,
      },
    };
  }

  /* ---- P4：单店取数（专属 + 本店分摊；结算进度不影响这里任何数）---- */

  function shopBreakdown(p) {
    p = p || {};
    var shopId = Number(p.shopId) || 0;
    var period = String(p.period || '');
    var shop = findShop(shopId);
    if (!shop) return { success: false, error: '店铺不存在或已被删除' };

    var byCat = {}, sharedEntries = [];
    var income = 0, expense = 0, directIncome = 0, sharedIncome = 0, directExpense = 0, sharedExpense = 0;
    for (var i = 0; i < ENTRIES.length; i++) {
      var e = ENTRIES[i];
      if (e.status !== 'active') continue;
      if (period && String(e.bizDate).slice(0, 7) !== period) continue;
      var allocs = e.scope === 'shop'
        ? [ { shopId: e.shopId, amountCents: e.amountCents, ratioBp: 10000 } ]
        : (e.allocations || []);
      for (var j = 0; j < allocs.length; j++) {
        var a = allocs[j];
        if (Number(a.shopId) !== shopId) continue;
        var shared = e.scope === 'shared';
        var key = e.kind + ':' + e.categoryId;
        var row = byCat[key];
        if (!row) {
          var c = findCategory(e.categoryId);
          row = byCat[key] = {
            categoryId: Number(e.categoryId),
            categoryName: c ? c.name : '',
            kind: e.kind,
            directCents: 0,
            sharedCents: 0,
            amountCents: 0,
          };
        }
        row.amountCents += a.amountCents;
        if (shared) row.sharedCents += a.amountCents;
        else row.directCents += a.amountCents;
        if (e.kind === 'income') {
          income += a.amountCents;
          if (shared) sharedIncome += a.amountCents;
          else directIncome += a.amountCents;
        } else {
          expense += a.amountCents;
          if (shared) sharedExpense += a.amountCents;
          else directExpense += a.amountCents;
        }
        if (!shared) continue;
        var party = findParty(e.partyId);
        var cat = findCategory(e.categoryId);
        sharedEntries.push({
          entryId: e.id,
          bizDate: e.bizDate,
          kind: e.kind,
          entryCents: e.amountCents,
          amountCents: a.amountCents,
          ratioBp: Number(a.ratioBp) || 0,
          categoryName: cat ? cat.name : '',
          partyName: party ? party.name : '',
          note: e.note || '',
        });
      }
    }
    sharedEntries.sort(function (a, b) {
      if (a.bizDate !== b.bizDate) return a.bizDate < b.bizDate ? 1 : -1;
      return b.entryId - a.entryId;
    });
    var byCategory = Object.keys(byCat).map(function (k) { return byCat[k]; });
    byCategory.sort(function (a, b) {
      if (a.kind !== b.kind) return a.kind === 'expense' ? -1 : 1;
      return b.amountCents - a.amountCents || a.categoryId - b.categoryId;
    });
    return {
      success: true,
      data: {
        shopId: shop.id,
        shopName: shop.name,
        shopStatus: shop.status,
        period: period,
        incomeCents: income,
        expenseCents: expense,
        balanceCents: income - expense,
        directIncomeCents: directIncome,
        sharedIncomeCents: sharedIncome,
        directExpenseCents: directExpense,
        sharedExpenseCents: sharedExpense,
        byCategory: byCategory,
        sharedEntries: sharedEntries,
      },
    };
  }

  function categoryList(p) {
    p = p || {};
    var out = [];
    for (var i = 0; i < CATEGORIES.length; i++) {
      var c = CATEGORIES[i];
      if (p.kind && c.kind !== p.kind) continue;
      if (!p.includeArchived && c.archived) continue;
      out.push({ id: c.id, kind: c.kind, name: c.name, builtin: c.builtin, sort: c.sort, archived: c.archived });
    }
    return out;
  }

  function upsertCategory(p) {
    var id = Number(p && p.id) || 0;
    var hit = findCategory(id);
    var created = false;
    if (!hit) {
      hit = { id: ++CAT_SEQ, kind: p.kind || 'expense', name: '', builtin: false, sort: 99, archived: false };
      CATEGORIES.push(hit);
      created = true;
    }
    if (p.name) hit.name = p.name;
    if (typeof p.archived === 'boolean') hit.archived = p.archived;
    return { id: hit.id, created: created };
  }

  window.__smokeLedger = {
    summary: buildSummary,
    lastPartyId: 0,
    lastEntryId: 0,
    lastRuleId: 0,
    /** 临时插一家店 / 摘掉它（验"某一状态下这家店能不能摊"时用；SHOPS 只活在假桥闭包里） */
    addShop: function (shop) { SHOPS.push(shop); return SHOPS.length; },
    popShop: function () { return SHOPS.pop(); },
    /**
     * 临时插一个「垫付 + 代收」的人（互抵流程专用）。
     *
     * 为什么不在夹具里预置：他两边都有余额，一进夹具就会同时改变往来台账的人数、
     * 合计、对账恒等式、改挂下拉、明细行数 —— 七八条与互抵无关的断言全得跟着改数值，
     * 而那些数字恰恰是它们要守的东西。按需插入，既有断言一个不动。
     * 日期取下个月：往来页是累计口径照样能看到，但挤不进本月/上月的合计与行数。
     */
    addOffsetFixture: function () {
      var id = 25;
      PARTIES.push({ id: id, name: '郑强', kind: 'staff', phone: '', note: '垫付兼代收', archived: false, createdAt: '', updatedAt: '' });
      ENTRIES.push(
        { id: 8, bizDate: dn(5), kind: 'expense', scope: 'shop', shopId: 11, partyId: id, categoryId: 101, amountCents: 100000, basis: '', note: '垫付快递费', status: 'active', voidReason: '', settled: false, settlementId: 0 },
        { id: 9, bizDate: dn(6), kind: 'income', scope: 'shop', shopId: 11, partyId: id, categoryId: 201, amountCents: 40000, basis: '', note: '代收货款', status: 'active', voidReason: '', settled: false, settlementId: 0 }
      );
      return id;
    },
    party: function (id) {
      var p = findParty(id);
      return p ? { archived: p.archived, name: p.name, mergedTo: Number(p.mergedTo) || 0 } : null;
    },
    /** 带某个作废原因的条目数（「撤销本次导入」是唯一会写这个原因的路径） */
    voidedWithReason: function (reason) {
      var n = 0;
      for (var i = 0; i < ENTRIES.length; i++) if (ENTRIES[i].voidReason === reason) n++;
      return n;
    },
    entry: function (id) {
      var e = findEntry(id);
      return e ? { partyId: e.partyId, status: e.status, voidReason: e.voidReason, amountCents: e.amountCents, ruleId: Number(e.ruleId) || 0, basis: e.basis || '', settled: !!e.settled, settlementId: Number(e.settlementId) || 0, allocations: (e.allocations || []).slice() } : null;
    },
    rule: function (id) {
      return findRule(id);
    },
    settlement: function (id) {
      var s = findSettlement(id);
      return s ? { partyId: s.partyId, direction: s.direction, amountCents: s.amountCents, status: s.status, voidReason: s.voidReason, settleDate: s.settleDate, entryIds: s.entryIds.slice() } : null;
    },
    settleCount: function () { return SETTLEMENTS.length; },
    lastSettlementId: function () { return SETTLEMENTS.length ? SETTLEMENTS[SETTLEMENTS.length - 1].id : 0; },
    /** 模拟"另一个窗口把这笔结算掉了"：让 UI 的提交撞上服务端的重复结算拦截 */
    forceEntrySettled: function (id, settlementId) {
      var e = findEntry(id);
      if (!e) return false;
      e.settled = Number(settlementId) > 0;
      e.settlementId = Number(settlementId) || 0;
      return true;
    },
    partyLedger: function (id) {
      return partyLedgerRows({ includeArchived: true, partyId: id })[0] || null;
    },
    /** P4：按与主进程同样的规则预演三路（断言用它核对界面上的数，不读界面自己的状态） */
    preview: function (ids) { return repatchPreview(ids); },
    shopLedger: function (id, period) { return shopBreakdown({ shopId: id, period: period }); },
  };

  var OVERRIDES = {
    'getAppVersion': function () { return { success: true, data: '0.0.0-smoke' }; },
    'get-app-version': function () { return { success: true, data: '0.0.0-smoke' }; },
    // 让外壳恢复"上次所在模块" = 记账（省掉点侧边栏，断言聚焦本页）
    'getModuleState': function (ns) {
      if (ns === 'app-shell') return { success: true, data: { lastActiveModuleId: 'ledger', collapsed: false } };
      return { success: true, data: null };
    },
    'setModuleState': function () { return { success: true }; },
    'pluginsScan': function () { return { success: true, data: { root: '/tmp/smoke-plugins', plugins: [] } }; },

    /* ---- 记账域 ---- */
    'ledgerDbEnsure': function () { return { success: true, data: { ok: true } }; },
    'ledgerEligibleShops': function (p) {
      rec('ledgerEligibleShops', p);
      return { success: true, data: eligible(String((p && p.period) || MONTH)) };
    },
    'ledgerCategoryList': function (p) {
      rec('ledgerCategoryList', p || {});
      return { success: true, data: categoryList(p) };
    },
    'ledgerCategoryUpsert': function (p) {
      rec('ledgerCategoryUpsert', p);
      return { success: true, data: upsertCategory(p) };
    },
    'ledgerEntryList': function (p) {
      rec('ledgerEntryList', p || {});
      return { success: true, data: entryList(p) };
    },
    'ledgerEntryGet': function (p) {
      rec('ledgerEntryGet', p);
      return { success: true, data: entryDetail(p && p.id) };
    },
    'ledgerEntryUpsert': function (p) {
      rec('ledgerEntryUpsert', p);
      // 用来演练"落库侧守恒校验失败"的 UI 路径：主进程真会拒，这里只复刻返回形状。
      if (window.__smokeRejectUpsert) return { success: false, error: window.__smokeRejectUpsert };
      return { success: true, data: upsertEntry(p) };
    },
    'ledgerEntryVoid': function (p) {
      rec('ledgerEntryVoid', p);
      var e = findEntry(p && p.id);
      if (!e) return { success: false, error: '条目不存在' };
      if (e.settled) return { success: false, error: '该条目已被结算单 #' + e.settlementId + ' 占用' };
      if (!p.reason) return { success: false, error: '请填写作废原因' };
      e.status = 'void';
      e.voidReason = p.reason;
      return { success: true, data: { id: e.id, voided: true } };
    },
    // 作废的逆操作：只认 void → active，且被结算单占用时拒绝（与主进程 restoreEntry 同判定）。
    // 桩里刻意**不复刻**"分摊合计不一致"那条 —— 桩数据没有分摊行，虚构一个分支只会让断言更假。
    'ledgerEntryRestore': function (p) {
      rec('ledgerEntryRestore', p);
      var e = findEntry(p && p.id);
      if (!e) return { success: false, error: '条目不存在' };
      if (e.status !== 'void') return { success: true, data: { id: e.id, restored: false } };
      if (e.settled) return { success: false, error: '该条目已被结算单 #' + e.settlementId + ' 占用，不能恢复为有效' };
      e.status = 'active';
      e.voidReason = '';
      return { success: true, data: { id: e.id, restored: true } };
    },
    // 批量作废（撤销本次导入）：整批一个事务，任一条不可作废就整批拒 —— 与主进程 voidEntries 同判定
    'ledgerEntriesVoid': function (p) {
      rec('ledgerEntriesVoid', p);
      var ids = (p && p.ids) || [];
      if (!p || !p.reason) return { success: false, error: '作废必须填写原因' };
      var done = [];
      for (var i = 0; i < ids.length; i++) {
        var e = findEntry(ids[i]);
        if (!e) return { success: false, error: '条目 #' + ids[i] + '：条目不存在' };
        if (e.settled) return { success: false, error: '条目 #' + ids[i] + '：该条目已被结算单 #' + e.settlementId + ' 占用' };
        if (e.status !== 'void') {
          e.status = 'void';
          e.voidReason = p.reason;
          done.push(e.id);
        }
      }
      return { success: true, data: { voided: done.length, ids: done } };
    },
    'ledgerSummary': function (p) {
      rec('ledgerSummary', p || {});
      // 空串 = 全期间（往来对账恒等式）；不能把 '' 回落到本月，否则恒等式永远"通过"
      var period = p && typeof p.period === 'string' ? p.period : MONTH;
      return { success: true, data: buildSummary(period) };
    },
    'ledgerPartyList': function (p) {
      rec('ledgerPartyList', p || {});
      return { success: true, data: partyList(p) };
    },
    'ledgerPartyUpsert': function (p) {
      rec('ledgerPartyUpsert', p);
      return { success: true, data: upsertParty(p) };
    },
    'ledgerPartyMerge': function (p) {
      rec('ledgerPartyMerge', p);
      return mergeParty(p);
    },
    'ledgerPartyLedger': function (p) {
      rec('ledgerPartyLedger', p || {});
      return { success: true, data: partyLedgerRows(p) };
    },
    'ledgerSettleList': function (p) {
      rec('ledgerSettleList', p || {});
      return { success: true, data: settleList(p) };
    },
    'ledgerSettleCreate': function (p) {
      rec('ledgerSettleCreate', p);
      return createSettlement(p);
    },
    'ledgerSettleVoid': function (p) {
      rec('ledgerSettleVoid', p);
      return voidSettlement(p);
    },
    'ledgerRuleList': function () {
      return { success: true, data: listRules() };
    },
    'ledgerRuleUpsert': function (p) {
      rec('ledgerRuleUpsert', p);
      return { success: true, data: upsertRule(p) };
    },

    /* ---- P4：批量变更 / 单店 / 导出 ---- */
    'ledgerEntryRepatchPreview': function (p) {
      rec('ledgerEntryRepatchPreview', p || {});
      return { success: true, data: repatchPreview(p && p.entryIds) };
    },
    'ledgerEntryRepatch': function (p) {
      rec('ledgerEntryRepatch', p);
      return repatchEntries(p);
    },
    'ledgerShopBreakdown': function (p) {
      rec('ledgerShopBreakdown', p || {});
      return shopBreakdown(p);
    },
    'ledgerExportExcel': function (p) {
      rec('ledgerExportExcel', p);
      // 用户点「取消」：主进程回 __canceled__，界面必须当无事发生（不弹错误）
      if (window.__smokeExportCancel) return { success: false, error: '__canceled__' };
      return {
        success: true,
        data: { filePath: '/tmp/记账明细.xlsx', rows: (p && p.rows ? p.rows.length : 0) },
      };
    },

    /* ---- 订单营收（只给记账的「按营收占比」；宿主只回行，汇总在渲染层）---- */
    'orderShippingRows': function (p) {
      rec('orderShippingRows', p || {});
      var period = String((p && p.period) || '');
      var limit = Number((p && p.limit) || 0) || 2000;
      var rows = ORDER_ROWS.filter(function (r) {
        return !period || String(r.orderTime).slice(0, 7) === period;
      });
      return { success: true, data: rows.slice(0, limit) };
    },

    /* ---- 店铺列表（记账只读它做下拉 / 过滤）---- */
    'shopList': function (p) {
      rec('shopList', p || {});
      return { success: true, data: { rows: SHOPS.slice(), total: SHOPS.length } };
    },

    /* ---- 批量导入（2026-10-26 真机炸过一次：An object could not be cloned.）----
       那条路是"渲染层解析 + 校验 + 摊钱 → 一个事务整批落库"，中间只有这一处 IPC。
       桩把真机的硬约束**照抄一遍**：先做一次 structuredClone 再记账 —— Vue 的 reactive 代理
       过不去，于是"载荷混进代理"这种错在冒烟里就会红，而不是等用户点到提交才发现。 */
    'selectExcel': function () {
      rec('selectExcel', {});
      return { success: true, data: { filePath: '/tmp/smoke-ledger-import.xlsx', data: b64ToBuf(IMPORT_B64) } };
    },

    'ledgerNameResolve': function (p) {
      rec('ledgerNameResolve', p || {});
      var out = { party: {}, category: {}, shop: {} };
      function hit(list, raw, kindField) {
        var key = String(raw || '').replace(/\\s+/g, '').toLowerCase();
        for (var i = 0; i < list.length; i++) {
          if (String(list[i].name || '').replace(/\\s+/g, '').toLowerCase() === key) {
            var one = {
              id: list[i].id, name: list[i].name,
              state: list[i].archived ? 'archived' : 'ok',
              kind: kindField ? String(list[i].kind || '') : '',
              status: kindField ? '' : String(list[i].status || 'active'),
            };
            return one;
          }
        }
        return { id: 0, name: String(raw || ''), state: 'missing', kind: '', status: '' };
      }
      (p && p.party || []).forEach(function (n) { out.party[n] = hit(PARTIES, n, false); });
      (p && p.category || []).forEach(function (n) { out.category[n] = hit(CATEGORIES, n, true); });
      (p && p.shop || []).forEach(function (n) { out.shop[n] = hit(SHOPS, n, false); });
      return { success: true, data: out };
    },

    'ledgerEntryBatchCreate': function (p) {
      var cloned;
      try { cloned = structuredClone(p); }
      catch (e) {
        // 与真机同一句报错：载荷里混进了不可克隆的东西（几乎总是 Vue 代理）
        rec('ledgerEntryBatchCreateCloneFail', String((e && e.message) || e));
        throw e;
      }
      rec('ledgerEntryBatchCreate', cloned);
      var entries = (cloned && cloned.entries) || [];
      var ids = [], allocRows = 0, newParty = {}, newCategory = {};
      entries.forEach(function (e) {
        var pid = Number(e.partyId) || 0;
        if (!pid && e.partyName) {
          pid = ++PARTY_SEQ;
          PARTIES.push({ id: pid, name: e.partyName, kind: 'other', phone: '', note: '', archived: false, createdAt: '', updatedAt: '' });
          newParty[e.partyName] = true;
        }
        var cid = Number(e.categoryId) || 0;
        if (!cid && e.categoryName) {
          cid = ++CAT_SEQ;
          CATEGORIES.push({ id: cid, kind: e.kind === 'income' ? 'income' : 'expense', name: e.categoryName, builtin: false, sort: 90, archived: false });
          newCategory[e.categoryName] = true;
        }
        var rows = Array.isArray(e.allocations) ? e.allocations.map(function (a) {
          return { shopId: Number(a.shopId), amountCents: Number(a.amountCents), ratioBp: Number(a.ratioBp) };
        }) : [];
        // 专属条目由主进程补一行全额分摊（这里照写，行形状与历史条目一致）
        if (e.scope === 'shop') rows = [{ shopId: Number(e.shopId) || 0, amountCents: Number(e.amountCents), ratioBp: 10000 }];
        allocRows += rows.length;
        var id = ++ENTRY_SEQ;
        ENTRIES.push({
          id: id, bizDate: e.bizDate, kind: e.kind, scope: e.scope,
          shopId: Number(e.shopId) || 0, partyId: pid, categoryId: cid,
          amountCents: Number(e.amountCents), basis: e.basis || '', note: e.note || '',
          status: 'active', voidReason: '', settled: false, settlementId: 0, allocations: rows,
        });
        ids.push(id);
      });
      return {
        success: true,
        data: {
          created: ids.length, ids: ids, allocations: allocRows,
          createdParties: Object.keys(newParty), createdCategories: Object.keys(newCategory),
        },
      };
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

var NARROW = location.search.indexOf('mode=narrow') >= 0;
var NOW = new Date();
function pad2(n) { return (n < 10 ? '0' : '') + n; }
var MONTH = NOW.getFullYear() + '-' + pad2(NOW.getMonth() + 1);
var PREV_D = new Date(NOW.getFullYear(), NOW.getMonth() - 1, 1);
var PREV = PREV_D.getFullYear() + '-' + pad2(PREV_D.getMonth() + 1);
function monthLabel(m) { return m.slice(0, 4) + '年' + Number(m.slice(5)) + '月'; }
/** 与 src/lib/ledger.ts 的 formatCents 一致：无千分位、负数符号在前 */
function money(cents) {
  var v = Math.round(Number(cents) || 0);
  var sign = v < 0 ? '-' : '';
  var abs = Math.abs(v);
  return sign + '¥' + Math.floor(abs / 100) + '.' + String(abs % 100).padStart(2, '0');
}
/** 汇总页/单店页同一家店必须同一套数：期望值取自桩的 summary（与页面读的是不同通道） */
function byShopRow(id) {
  var s = window.__smokeLedger.summary(MONTH);
  for (var i = 0; i < s.byShop.length; i++) if (s.byShop[i].shopId === Number(id)) return s.byShop[i];
  return null;
}

function waitFor(fn, timeout) {
  return new Promise(function (resolve, reject) {
    var t0 = Date.now();
    (function tick() {
      var v;
      try { v = fn(); } catch (e) { return reject(e); }
      if (v) return resolve(v);
      if (Date.now() - t0 > (timeout || 4000)) return reject(new Error('timeout'));
      setTimeout(tick, 30);
    })();
  });
}
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
function act(sel, root) { return (root || document).querySelector('[data-act="' + sel + '"]'); }
function actAll(sel, root) { return Array.prototype.slice.call((root || document).querySelectorAll('[data-act="' + sel + '"]')); }
/** 弹层里的控件：表格里也有 entry-amount / entry-party 同名的 data-act，必须限定在弹层内 */
function eact(sel) { var ed = act('entry-editor'); return ed ? ed.querySelector('[data-act="' + sel + '"]') : null; }
function row(id) { return document.querySelector('[data-entry-id="' + id + '"]'); }
function rowCount() { return all('[data-entry-id]').length; }
function rowIds() {
  return all('[data-entry-id]').map(function (r) { return Number(r.getAttribute('data-entry-id')); })
    .sort(function (a, b) { return a - b; });
}
/** 变更相关人弹层的目标下拉：取除占位项（0）以外的全部候选 id。
 *  「排除条目原所属的人 + 排除已停用」这件事只能从下拉本身读出来，故断言钉这里。 */
function targetChoices() {
  var sel = act('repatch-target');
  var out = [];
  if (!sel) return out;
  for (var i = 0; i < sel.options.length; i++) {
    if (sel.options[i].value !== '0') out.push(sel.options[i].value);
  }
  return out.sort();
}
function setVal(el, value) {
  if (!el) throw new Error('setVal: 元素不存在');
  var proto = el.tagName === 'SELECT' ? HTMLSelectElement.prototype
    : el.tagName === 'TEXTAREA' ? HTMLTextAreaElement.prototype
    : HTMLInputElement.prototype;
  Object.getOwnPropertyDescriptor(proto, 'value').set.call(el, value);
  el.dispatchEvent(new Event(el.tagName === 'SELECT' ? 'change' : 'input', { bubbles: true }));
}
function clickAct(sel, root) {
  var el = act(sel, root);
  if (!el) throw new Error('缺少 data-act=' + sel);
  el.click();
  return el;
}
/** 点一个由表单值控制 disabled 的按钮：input 事件后 Vue 的更新是异步的，
 *  同一任务里直接 click 会点在 disabled 上**静默无效**（这一坑在相关人内联新建上真踩到了）。 */
async function clickEnabled(sel, root) {
  var t0 = Date.now();
  for (;;) {
    var el = (root || document).querySelector(sel);
    if (el && !el.disabled) { el.click(); return; }
    if (Date.now() - t0 > 6000) throw new Error('按钮始终不可点: ' + sel);
    await sleep(40);
  }
}
function metric(name) { return flat(act(name)); }
function lastCall(name) {
  var arr = calls(name);
  return arr.length ? arr[arr.length - 1] : null;
}

async function openEditor() {
  clickAct('new-entry');
  await waitFor(function () { return eact('entry-amount'); }, 8000);
}
async function closeEditor() {
  clickAct('entry-cancel');
  await settle(function () { return !act('entry-editor'); }, 4000);
}
async function saveEditor() {
  clickAct('entry-save');
}
async function waitEditorClosed(ms) {
  await settle(function () { return !act('entry-editor'); }, ms || 9000);
}

async function main() {
  try {
    /* ── 挂载 + 整月合计 ───────────────────────────────────────────── */
    step('boot');
    await waitFor(function () { return document.querySelector('.lg-view'); }, 15000);
    await settle(function () { return rowCount() === 6; }, 10000);
    report('挂载：记账页渲染且读到当月 6 条有效条目', rowCount() === 6, 'rows=' + rowCount() + ' ids=' + rowIds().join(','));
    report('口径常驻：页头写明与「统计」不可相加',
      has('与「统计」的订单毛利口径不同，不可相加'));
    report('整月合计：收入 / 支出 / 结余（负数符号在 ¥ 前）/ 条目 / 公共',
      metric('metric-income').indexOf('¥5000.00') >= 0 &&
        metric('metric-expense').indexOf('¥6280.00') >= 0 &&
        metric('metric-balance').indexOf('-¥1280.00') >= 0 &&
        metric('metric-entries').indexOf('6') >= 0 &&
        metric('metric-shared').indexOf('收 ¥0.00') >= 0 && metric('metric-shared').indexOf('支 ¥5000.00') >= 0,
      metric('metric-income') + ' / ' + metric('metric-expense') + ' / ' + metric('metric-balance') +
        ' / ' + metric('metric-entries') + ' / ' + metric('metric-shared'));
    report('合计标签写明「整月」（不让人从数字反推口径）', has(monthLabel(MONTH) + ' · 整月'));
    if (NARROW) {
      report('窄视口：页面无横向溢出',
        document.documentElement.scrollWidth <= window.innerWidth + 2,
        document.documentElement.scrollWidth + ' > ' + window.innerWidth);
    }

    /* ── 行渲染五态 ───────────────────────────────────────────────── */
    step('rows');
    report('专属支出行：金额带方向符号', flat(row(1).querySelector('[data-act="entry-amount"]')).indexOf('−¥1200.00') >= 0,
      flat(row(1).querySelector('[data-act="entry-amount"]')));
    report('公共行显示「摊 N 家」，不显示店铺名',
      flat(row(3).querySelector('[data-act="entry-shop"]')).indexOf('摊 2 家') >= 0 &&
        row(3).querySelector('[data-act="entry-shop"]').innerText.indexOf('HK') < 0,
      flat(row(3).querySelector('[data-act="entry-shop"]')));
    report('已结算行有徽标（并带结算单号 title）',
      flat(row(4).querySelector('[data-act="entry-settled"]')).indexOf('已结算') >= 0);
    report('作废行默认不出现（需勾「含作废」）', !row(5), 'row5=' + !!row(5));
    report('已结算条目的作废按钮禁用且解释原因',
      row(4).querySelector('[data-act="entry-void"]').disabled &&
        String(row(4).querySelector('[data-act="entry-void"]').title || '').indexOf('结算单 #9') >= 0,
      String(row(4).querySelector('[data-act="entry-void"]').title || ''));

    /* ── 月份切换 ─────────────────────────────────────────────────── */
    step('month');
    clickAct('month-prev');
    await settle(function () { return !!act('ledger-empty') && has(monthLabel(PREV)); }, 8000);
    report('切上个月：显示当月（空态）而不是把本月数据留在屏上',
      !!act('ledger-empty') && has(monthLabel(PREV) + '还没有记账'),
      flat(act('ledger-empty')));
    report('切月真的重新取数（summary / list 都带上了上个月）',
      String(lastCall('ledgerSummary').period) === PREV && String(lastCall('ledgerEntryList').period) === PREV,
      JSON.stringify(lastCall('ledgerSummary')) + ' ' + JSON.stringify(lastCall('ledgerEntryList')));
    clickAct('month-now');
    await settle(function () { return rowCount() === 6 && has(monthLabel(MONTH)); }, 8000);
    report('点月份标签回到本月', rowCount() === 6 && has(monthLabel(MONTH)), 'rows=' + rowCount());

    /* ── 全部日期 ─────────────────────────────────────────────────────
       「全部」最容易错的不是显示，而是**请求参数**：主进程见 period 为空才不过滤，
       传 all 会被当成一个不存在的月份 —— 查出 0 行、还不报错。
       所以这里从"上个月（空态）"点「全部」，能变回 6 行才算真的没按月过滤。 */
    step('all-period');
    clickAct('month-prev');
    await settle(function () { return !!act('ledger-empty') && rowCount() === 0; }, 8000);
    clickAct('month-all');
    await settle(function () { return rowCount() === 6; }, 8000);
    report('从"上个月空态"点全部：列出全部日期的条目（不是把空月留在屏上）',
      rowCount() === 6, 'rows=' + rowCount());
    report('全部日期时列表请求**不带 period**（传 all / 空串都会漏筛）',
      !!lastCall('ledgerEntryList') && !lastCall('ledgerEntryList').period,
      JSON.stringify(lastCall('ledgerEntryList')));
    report('全部日期时合计走全期间（summary 传空串，与往来对账同一口径）',
      String(lastCall('ledgerSummary').period) === '',
      JSON.stringify(lastCall('ledgerSummary')));
    report('合计口径改写成「累计」，不再说「整月」',
      flat(act('metabar-period')).indexOf('全部日期 · 累计') >= 0 &&
        flat(act('metabar-period')).indexOf('整月') < 0,
      flat(act('metabar-period')));
    clickAct('month-prev');
    await settle(function () { return !!act('ledger-empty'); }, 8000);
    report('全部日期下点「‹」回到上一个真实月份（不是 NaN-NaN）',
      String(lastCall('ledgerEntryList').period) === PREV,
      String(lastCall('ledgerEntryList').period));
    clickAct('month-now');
    await settle(function () { return rowCount() === 6 && has(monthLabel(MONTH)); }, 8000);

    /* ── 筛选 ─────────────────────────────────────────────────────── */
    step('filters');
    clickAct('filter-kind-income');
    await settle(function () { return rowCount() === 1; }, 6000);
    report('按方向筛：收入只剩 1 条', rowCount() === 1 && rowIds()[0] === 2, 'ids=' + rowIds().join(','));
    report('筛选**不改变**整月合计（公共支出按整笔算单店会算错，故合计只认月份）',
      metric('metric-income').indexOf('¥5000.00') >= 0 && metric('metric-expense').indexOf('¥6280.00') >= 0,
      metric('metric-income') + ' / ' + metric('metric-expense'));
    report('有筛选时出现「已筛选」标签', has('已筛选'));
    clickAct('filter-reset');
    await settle(function () { return rowCount() === 6; }, 6000);

    setVal(act('filter-shop'), '11');
    await settle(function () { return rowCount() === 4; }, 6000);
    report('按店铺筛：公共支出按**分摊行**归属（房租 / 营收旧账也算店 11 的）',
      rowIds().join(',') === '1,3,4,6', 'ids=' + rowIds().join(','));
    setVal(act('filter-shop'), '0');
    await settle(function () { return rowCount() === 6; }, 6000);

    setVal(act('filter-settle'), 'settled');
    await settle(function () { return rowCount() === 1; }, 6000);
    report('按结算状态筛：未结算/已结算分开', rowIds()[0] === 4, 'ids=' + rowIds().join(','));
    setVal(act('filter-settle'), '');
    await settle(function () { return rowCount() === 6; }, 6000);

    setVal(act('filter-keyword'), '房租');
    await settle(function () { return rowCount() === 1; }, 6000);
    report('关键字筛：命中备注/科目/相关人', rowIds()[0] === 3, 'ids=' + rowIds().join(','));
    clickAct('filter-reset');
    await settle(function () { return rowCount() === 6; }, 6000);

    clickAct('filter-void');
    await settle(function () { return rowCount() === 7; }, 6000);
    report('勾「含作废」：作废行回到列表且标明原因',
      !!row(5) && flat(row(5)).indexOf('作废：金额录错，已重记一笔') >= 0,
      row(5) ? flat(row(5)) : 'missing');
    clickAct('filter-void');
    await settle(function () { return rowCount() === 6; }, 6000);

    /* ── 记一笔：专属支出（含相关人内联新建）──────────────────────── */
    step('create-shop');
    await openEditor();
    setVal(eact('entry-amount'), '1280.50');
    setVal(eact('entry-date'), MONTH + '-15');
    setVal(eact('entry-category'), '101');
    setVal(eact('entry-shop'), '11');
    setVal(eact('entry-note'), '新记一笔');

    clickAct('party-new');
    await waitFor(function () { return eact('party-new-name'); }, 3000);
    setVal(eact('party-new-name'), '测试供应商');
    await clickEnabled('[data-act="party-new-save"]', act('entry-editor'));
    await settle(function () {
      return window.__smokeLedger.lastPartyId > 0 && Number(eact('entry-party').value) === window.__smokeLedger.lastPartyId;
    }, 6000);
    report('相关人内联新建：建完自动选中', calls('ledgerPartyUpsert').length === 1 &&
      lastCall('ledgerPartyUpsert').name === '测试供应商' &&
      Number(eact('entry-party').value) === window.__smokeLedger.lastPartyId,
      JSON.stringify(lastCall('ledgerPartyUpsert')) + ' selected=' + (eact('entry-party') || {}).value);

    await saveEditor();
    await waitEditorClosed();
    await settle(function () { return rowCount() === 7; }, 8000);
    var createdShop = lastCall('ledgerEntryUpsert');
    report('专属支出保存：带 shopId、不带分摊行、金额为分',
      createdShop && createdShop.scope === 'shop' && createdShop.shopId === 11 &&
        createdShop.amountCents === 128050 && !(createdShop.allocations && createdShop.allocations.length),
      JSON.stringify(createdShop));
    report('保存后合计跟着变（支出 +1280.50）', metric('metric-expense').indexOf('¥7560.50') >= 0, metric('metric-expense'));
    report('保存后列表多一行（且不是靠乐观更新：桩数据真加了）', rowCount() === 7 && has('新记一笔'));

    /* ── 记一笔：公共 · 平均分摊（预览 = 落库）────────────────────── */
    step('create-shared-equal');
    await openEditor();
    setVal(eact('entry-amount'), '300.00');
    setVal(eact('entry-party'), '21');
    clickAct('entry-scope-shared');
    await settle(function () {
      var a = eact('alloc-shop-11');
      var b = eact('alloc-shop-12');
      return !!a && !!b && a.checked && b.checked;
    }, 6000);
    report('公共：默认勾选本月可参与的店（11 / 12），未开业的店不出现在勾选区',
      !!eact('alloc-shop-11') && eact('alloc-shop-11').checked &&
        !!eact('alloc-shop-12') && eact('alloc-shop-12').checked &&
        !eact('alloc-shop-14'),
      '11=' + !!eact('alloc-shop-11') + ' 12=' + !!eact('alloc-shop-12') + ' 14=' + !!eact('alloc-shop-14'));
    report('公共：被排除的店**显式列出**（已停用 / 已封店 / 当月还没开店）',
      has('老店（已停用 / 已封店）') && has('新店筹备（当月还没开店）'),
      flat(act('entry-shared')).slice(0, 200));
    var preEqual = all('[data-act="alloc-table"] [data-alloc-shop]');
    report('平均分摊预览：2 家各 ¥150.00，合计 = 条目金额',
      preEqual.length === 2 &&
        flat(preEqual[0]).indexOf('¥150.00') >= 0 && flat(preEqual[1]).indexOf('¥150.00') >= 0 &&
        has('合计 ¥300.00 / 条目 ¥300.00'),
      preEqual.map(flat).join(' | '));
    if (NARROW) {
      var dlg = act('entry-editor');
      report('窄视口：弹层宽度不超视口', dlg.getBoundingClientRect().width <= window.innerWidth,
        Math.round(dlg.getBoundingClientRect().width) + ' > ' + window.innerWidth);
    }
    setVal(eact('entry-category'), '102');
    setVal(eact('entry-note'), '团建');
    await saveEditor();
    await waitEditorClosed();
    await settle(function () { return rowCount() === 6; }, 8000);
    var sharedEqual = lastCall('ledgerEntryUpsert');
    var allocSum = (sharedEqual.allocations || []).reduce(function (s, a) { return s + a.amountCents; }, 0);
    report('公共保存：basis=equal、分摊行 2 条、合计守恒、不带 shopId',
      sharedEqual.scope === 'shared' && sharedEqual.basis === 'equal' &&
        sharedEqual.allocations.length === 2 && allocSum === 30000 && !sharedEqual.shopId,
      JSON.stringify(sharedEqual));
    report('公共保存后表格显示「摊 2 家」', has('摊 2 家'));

    /* ── 记一笔：公共 · 手工比例（合计必须 100%，不自动补齐）───────── */
    step('create-shared-manual');
    await openEditor();
    setVal(eact('entry-amount'), '100.00');
    setVal(eact('entry-party'), '21');
    clickAct('entry-scope-shared');
    await settle(function () { return !!eact('alloc-shop-11'); }, 6000);
    clickAct('alloc-basis-manual');
    await settle(function () { return actAll('alloc-pct', act('entry-editor')).length === 2; }, 4000);
    var pcts = actAll('alloc-pct', act('entry-editor'));
    report('手工比例：切过去先按平均填好（不是空白也不是自动瞎补）',
      pcts[0].value === '50.00' && pcts[1].value === '50.00',
      pcts[0].value + ' / ' + pcts[1].value);

    setVal(pcts[0], '60');
    setVal(pcts[1], '50');
    await settle(function () { return has('超出 10.00 个百分点'); }, 4000);
    var upsertsBefore = calls('ledgerEntryUpsert').length;
    await saveEditor();
    await sleep(300);
    report('合计 110%：预览就报错，且保存被拦下（不发 upsert）',
      has('超出 10.00 个百分点') && calls('ledgerEntryUpsert').length === upsertsBefore &&
        flat(act('entry-form-error')).indexOf('超出 10.00 个百分点') >= 0,
      flat(act('entry-form-error')));

    pcts = actAll('alloc-pct', act('entry-editor'));
    setVal(pcts[1], '40');
    await settle(function () {
      var rs = all('[data-act="alloc-table"] [data-alloc-shop]');
      return rs.length === 2 && flat(rs[0]).indexOf('¥60.00') >= 0 && flat(rs[1]).indexOf('¥40.00') >= 0;
    }, 4000);
    var manualRows = all('[data-act="alloc-table"] [data-alloc-shop]');
    report('改到 60 / 40：预览逐店 60.00 / 40.00，合计仍是条目全额',
      manualRows.length === 2 &&
        flat(manualRows[0]).indexOf('¥60.00') >= 0 && flat(manualRows[1]).indexOf('¥40.00') >= 0 &&
        has('合计 ¥100.00 / 条目 ¥100.00'),
      manualRows.map(flat).join(' | '));
    await saveEditor();
    await waitEditorClosed();
    await settle(function () { return rowCount() === 9; }, 8000);
    var manual = lastCall('ledgerEntryUpsert');
    var manualSum = (manual.allocations || []).reduce(function (s, a) { return s + a.amountCents; }, 0);
    report('手工比例保存：basis=manual、比例快照 6000/4000、金额 6000/4000、合计守恒',
      manual.basis === 'manual' && manualSum === 10000 &&
        manual.allocations[0].amountCents === 6000 && manual.allocations[0].ratioBp === 6000 &&
        manual.allocations[1].amountCents === 4000 && manual.allocations[1].ratioBp === 4000,
      JSON.stringify(manual));

    /* ── 跨月记账：保存后自动切到那一月 ──────────────────────────── */
    step('cross-month');
    await openEditor();
    setVal(eact('entry-amount'), '50.00');
    setVal(eact('entry-party'), '21');
    setVal(eact('entry-shop'), '12');
    setVal(eact('entry-date'), PREV + '-10');
    await settle(function () { return !!eact('entry-period-hint'); }, 3000);
    report('记到上个月的账：保存前提示"保存后会切月"',
      !!eact('entry-period-hint') && flat(eact('entry-period-hint')).indexOf(PREV) >= 0,
      eact('entry-period-hint') ? flat(eact('entry-period-hint')) : 'missing');
    await saveEditor();
    await waitEditorClosed();
    await settle(function () { return has(monthLabel(PREV)) && rowCount() === 1; }, 8000);
    report('保存后自动切到上个月（否则"存成功却看不见"）',
      has(monthLabel(PREV)) && rowCount() === 1,
      'rows=' + rowCount() + ' hasPrev=' + has(monthLabel(PREV)));
    clickAct('month-next');
    await settle(function () { return has(monthLabel(MONTH)) && rowCount() === 9; }, 8000);
    report('切回本月：本月仍是 9 条（跨月那笔没混进来）', rowCount() === 9, 'rows=' + rowCount());

    /* ── 已结算 / 营收基准：只许改安全字段 ───────────────────────── */
    step('locks');
    row(4).click();
    await waitFor(function () { return eact('entry-locked'); }, 6000);
    report('已结算：金额/方向/相关人锁定，提示结算单号',
      eact('entry-amount').disabled && eact('entry-kind-income').disabled &&
        eact('entry-party').disabled && flat(eact('entry-locked')).indexOf('结算单 #9') >= 0);
    report('已结算：科目 / 备注 / 日期仍可改（不是整条冻结）',
      !eact('entry-category').disabled && !eact('entry-note').disabled && !eact('entry-date').disabled);
    await closeEditor();

    row(6).click();
    await waitFor(function () { return eact('entry-revenue-basis'); }, 6000);
    report('营收基准旧账：参与店铺/基准锁定，金额可改但按原比例重算（并写明原因）',
      !eact('entry-amount').disabled && eact('entry-scope-shared').disabled &&
        eact('entry-scope-shop').disabled &&
        flat(eact('entry-revenue-basis')).indexOf('按营收占比') >= 0 &&
        flat(eact('entry-revenue-basis')).indexOf('原比例') >= 0,
      flat(eact('entry-revenue-basis')).slice(0, 120));
    report('营收基准旧账：科目 / 备注仍可改',
      !eact('entry-category').disabled && !eact('entry-note').disabled);
    await closeEditor();

    /* ── 作废：原因必填，历史可查，合计移除 ───────────────────────── */
    step('void');
    row(1).querySelector('[data-act="entry-void"]').click();
    await waitFor(function () { return !!act('confirm-dialog'); }, 6000);
    clickAct('confirm-ok');
    await settle(function () { return has('请填写作废原因'); }, 4000);
    report('作废原因必填：空原因点确认 → 报错且不发请求',
      has('请填写作废原因') && calls('ledgerEntryVoid').length === 0,
      flat(act('confirm-dialog')));
    setVal(act('void-reason'), '录错了');
    clickAct('confirm-ok');
    await settle(function () { return !act('confirm-dialog'); }, 8000);
    await settle(function () { return rowCount() === 6; }, 8000);
    report('作废成功：默认视图里消失（历史不删）', !row(1) && rowCount() === 8, 'rows=' + rowCount());
    report('作废后合计移除这笔（支出 7960.50 → 6760.50）',
      metric('metric-expense').indexOf('¥6760.50') >= 0, metric('metric-expense'));
    report('桩数据真的被改了（不是只关了框）',
      window.__smokeLedger.entry(1).status === 'void' && window.__smokeLedger.entry(1).voidReason === '录错了',
      JSON.stringify(window.__smokeLedger.entry(1)));

    clickAct('filter-void');
    await settle(function () { return rowCount() === 10; }, 6000);
    report('勾「含作废」：两笔作废都在，且写明原因',
      !!row(1) && flat(row(1)).indexOf('作废：录错了') >= 0 &&
        !!row(5) && flat(row(5)).indexOf('金额录错，已重记一笔') >= 0);

    /* ── 恢复：作废的逆操作（审查 §4-2 缺「撤销」出口）───────────── */
    step('restore');
    report('「恢复」只出现在作废行上（有效行没有这个按钮）',
      !!row(1).querySelector('[data-act="entry-restore"]') &&
        !!row(5).querySelector('[data-act="entry-restore"]') &&
        !row(2).querySelector('[data-act="entry-restore"]'),
      'row1=' + !!row(1).querySelector('[data-act="entry-restore"]') +
        ' row2=' + !!row(2).querySelector('[data-act="entry-restore"]'));
    report('有效行的「恢复」是缺失而不是禁用（禁用会让人以为"要满足什么条件才能点"）',
      document.querySelector('[data-entry-id="2"] [data-act="entry-restore"]') === null);

    row(1).querySelector('[data-act="entry-restore"]').click();
    await waitFor(function () { return !!act('confirm-dialog'); }, 6000);
    report('恢复确认写明「重新计入合计与相关人往来」（点下去前必须知道账会变）',
      has('重新计入合计与相关人往来') && flat(act('confirm-dialog')).indexOf('确认恢复') >= 0,
      flat(act('confirm-dialog')).slice(0, 160));
    clickAct('confirm-ok');
    await settle(function () { return !act('confirm-dialog'); }, 8000);
    report('恢复：请求带对 id，桩数据回到有效且作废原因被清',
      (lastCall('ledgerEntryRestore') || {}).id === 1 &&
        window.__smokeLedger.entry(1).status === 'active' &&
        !window.__smokeLedger.entry(1).voidReason,
      JSON.stringify(lastCall('ledgerEntryRestore')) + ' e1=' + JSON.stringify(window.__smokeLedger.entry(1)));
    report('恢复后合计回到作废前（支出 6760.50 → 7960.50）',
      metric('metric-expense').indexOf('¥7960.50') >= 0, metric('metric-expense'));
    report('恢复后行上不再有「恢复」按钮（状态真的变了，不是只关了框）',
      !row(1).querySelector('[data-act="entry-restore"]'));

    // 复原成"作废"状态，后面的用例沿用原状态 —— 顺带证明作废/恢复可反复切换，不是一次性开关
    row(1).querySelector('[data-act="entry-void"]').click();
    await waitFor(function () { return !!act('confirm-dialog'); }, 6000);
    setVal(act('void-reason'), '录错了');
    clickAct('confirm-ok');
    await settle(function () { return !act('confirm-dialog'); }, 8000);
    report('作废 → 恢复 → 再作废：状态可反复切换',
      window.__smokeLedger.entry(1).status === 'void' &&
        window.__smokeLedger.entry(1).voidReason === '录错了');
    report('再作废后合计又移除这笔（7960.50 → 6760.50）',
      metric('metric-expense').indexOf('¥6760.50') >= 0, metric('metric-expense'));
    clickAct('filter-void');
    await settle(function () { return rowCount() === 6; }, 6000);

    /* ── 相关人管理：合并改挂 + 停用 ─────────────────────────────── */
    step('parties');
    clickAct('open-parties');
    await waitFor(function () { return all('[data-act="party-table"] tbody tr[data-party-id]').length === 5; }, 8000);
    report('相关人列表：4 个预置 + 内联新建的 1 个',
      all('[data-act="party-table"] tbody tr[data-party-id]').length === 5,
      'rows=' + all('[data-act="party-table"] tbody tr[data-party-id]').length);

    document.querySelector('[data-party-id="24"] [data-act="party-merge"]').click();
    await waitFor(function () { return !!act('party-merge-target'); }, 4000);
    setVal(act('party-merge-target'), '21');
    await clickEnabled('[data-act="party-merge-confirm"]', act('party-manager'));
    await settle(function () { return !!act('party-table') && flat(document.querySelector('[data-party-id="24"]')).indexOf('已停用') >= 0; }, 8000);
    report('合并：请求参数正确、未结算条目改挂、来源停用',
      (lastCall('ledgerPartyMerge') || {}).fromId === 24 &&
        (lastCall('ledgerPartyMerge') || {}).toId === 21 &&
        window.__smokeLedger.entry(7).partyId === 21 &&
        window.__smokeLedger.party(24).archived === true,
      JSON.stringify(lastCall('ledgerPartyMerge')) + ' entry7=' + JSON.stringify(window.__smokeLedger.entry(7)));

    report('合并后来源标「已并入 → 广州布行」（与含混的「已停用」分开，审查 §5-4）',
      !!document.querySelector('[data-party-id="24"] [data-act="party-merged"]') &&
        flat(document.querySelector('[data-party-id="24"] [data-act="party-merged"]')).indexOf('已并入 → 广州布行') >= 0 &&
        window.__smokeLedger.party(24).mergedTo === 21,
      'mergedTo=' + window.__smokeLedger.party(24).mergedTo);

    document.querySelector('[data-party-id="23"] [data-act="party-archive"]').click();
    await waitFor(function () { return !!act('confirm-dialog'); }, 4000);
    clickAct('confirm-ok');
    await settle(function () { return !act('confirm-dialog') && flat(document.querySelector('[data-party-id="23"]')).indexOf('已停用') >= 0; }, 8000);
    report('手动停用的仍写「已停用」（不冒充「已并入」，也不会去找一个不存在的去向）',
      !document.querySelector('[data-party-id="23"] [data-act="party-merged"]') &&
        flat(document.querySelector('[data-party-id="23"]')).indexOf('已停用') >= 0 &&
        window.__smokeLedger.party(23).mergedTo === 0);
    report('停用相关人：确认后状态变为已停用（历史条目不删）',
      window.__smokeLedger.party(23).archived === true &&
        all('[data-act="party-table"] tbody tr[data-party-id]').length === 5);
    clickAct('party-close');
    await settle(function () { return !act('party-manager'); }, 4000);
    report('历史条目的相关人仍显示，并标「已停用」',
      flat(row(3).querySelector('[data-act="entry-party"]')).indexOf('房东陈') >= 0 &&
        flat(row(3).querySelector('[data-act="entry-party"]')).indexOf('已停用') >= 0,
      flat(row(3).querySelector('[data-act="entry-party"]')));
    report('合并后的历史条目显示新名字（按 id 关联，不按名字）',
      flat(row(7).querySelector('[data-act="entry-party"]')).indexOf('广州布行') >= 0,
      flat(row(7).querySelector('[data-act="entry-party"]')));

    /* ── 科目管理：新增 / 改名 / 停用 ─────────────────────────────── */
    step('categories');
    clickAct('open-categories');
    await waitFor(function () { return !!act('cat-list-income'); }, 6000);
    setVal(act('cat-add-input-income'), '平台补贴');
    await clickEnabled('[data-act="cat-add-income"]', act('category-manager'));
    await settle(function () { return has('平台补贴'); }, 6000);
    report('科目：新增收入科目后立刻出现在列表',
      !!catRow('平台补贴') && lastCall('ledgerCategoryUpsert').kind === 'income',
      JSON.stringify(lastCall('ledgerCategoryUpsert')));

    catRow('平台补贴').querySelector('[data-act="cat-rename"]').click();
    await waitFor(function () { return !!act('cat-rename-input'); }, 4000);
    setVal(act('cat-rename-input'), '平台补贴收入');
    clickAct('cat-rename-save');
    await settle(function () { return !!catRow('平台补贴收入'); }, 6000);
    report('科目：改名生效（条目按 id 关联，历史科目名同步）', !!catRow('平台补贴收入'));

    catRow('平台补贴收入').querySelector('[data-act="cat-archive"]').click();
    await settle(function () { return flat(catRow('平台补贴收入')).indexOf('已停用') >= 0; }, 6000);
    report('科目：停用后有标记、请求带 archived=true',
      flat(catRow('平台补贴收入')).indexOf('已停用') >= 0 &&
        lastCall('ledgerCategoryUpsert').archived === true,
      flat(catRow('平台补贴收入')));
    clickAct('category-close');
    await settle(function () { return !act('category-manager'); }, 4000);

    /* ── 体检异常：翻译成人话并显式提示 ──────────────────────────── */
    step('integrity');
    window.__smokeIntegrity = {
      allocationGapCents: 250,
      partyGapCents: -100,
      brokenEntries: [ { entryId: 99, amountCents: 1000, allocatedCents: 700 } ],
    };
    clickAct('filter-kind-expense');
    await settle(function () { return !!act('integrity-warning'); }, 6000);
    var warn = flat(act('integrity-warning'));
    report('体检不通过：三项异常都说清"差的是什么"，不是一串分',
      warn.indexOf('公共分摊合计比条目金额多 ¥2.50') >= 0 &&
        warn.indexOf('相关人净往来与「总收入 − 总支出」差 ¥1.00') >= 0 &&
        warn.indexOf('1 条公共条目的分摊不全') >= 0,
      warn);
    window.__smokeIntegrity = null;
    clickAct('filter-kind-all');
    await settle(function () { return !act('integrity-warning'); }, 6000);
    report('体检正常时不摆一排 0（提示消失）', !act('integrity-warning'));

    /* ── P2：分摊明细展开 / 改金额重算 ─────────────────────────────── */
    step('alloc-detail');
    var baseRows = rowCount();
    report('前置：此时列表 8 条（作废已排除）', baseRows === 8, 'rows=' + baseRows);
    row(3).querySelector('[data-act="entry-alloc-toggle-3"]').click();
    await waitFor(function () { return !!document.querySelector('[data-alloc-detail="3"]'); }, 6000);
    await settle(function () {
      var el = document.querySelector('[data-alloc-detail="3"]');
      return el && flat(el).indexOf('¥2000.00') >= 0;
    }, 6000);
    var det3 = document.querySelector('[data-alloc-detail="3"]');
    report('展开分摊：逐店列出摊入金额，表头写明基准与「合计 / 条目」',
      !!det3 && flat(det3).indexOf('HK 优品店') >= 0 && flat(det3).indexOf('¥2000.00') >= 0 &&
        flat(det3).indexOf('¥1000.00') >= 0 &&
        flat(det3).indexOf('分摊明细 · 手工比例') >= 0 &&
        flat(det3).indexOf('合计 ¥3000.00 / 条目 ¥3000.00') >= 0,
      det3 ? flat(det3).slice(0, 220) : 'missing');
    report('展开行不会顺带打开编辑弹层（点「摊 N 家」不叠两个框）', !act('entry-editor'));
    row(3).querySelector('[data-act="entry-alloc-toggle-3"]').click();
    await settle(function () { return !document.querySelector('[data-alloc-detail="3"]'); }, 3000);
    report('再点一次收起分摊明细', !document.querySelector('[data-alloc-detail="3"]'));

    step('alloc-recompute');
    row(3).click();
    await waitFor(function () { return eact('entry-amount'); }, 6000);
    var loadedPct = actAll('alloc-pct', act('entry-editor'));
    report('编辑手工比例条目：比例按库里的快照回填（66.67 / 33.33）',
      loadedPct.length === 2 && loadedPct[0].value === '66.67' && loadedPct[1].value === '33.33',
      loadedPct.map(function (x) { return x.value; }).join(' / '));
    setVal(eact('entry-amount'), '1500.00');
    await settle(function () { return has('合计 ¥1500.00 / 条目 ¥1500.00'); }, 5000);
    await saveEditor();
    await waitEditorClosed();
    await settle(function () { return rowCount() === baseRows; }, 8000);
    report('改金额保存后列表仍是同一条（不是新增一条）', rowCount() === baseRows, 'rows=' + rowCount());
    row(3).querySelector('[data-act="entry-alloc-toggle-3"]').click();
    await settle(function () {
      var el = document.querySelector('[data-alloc-detail="3"]');
      return el && flat(el).indexOf('¥1000.05') >= 0;
    }, 6000);
    var det3b = document.querySelector('[data-alloc-detail="3"]');
    report('改金额后分摊按原比例重算（1000.05 / 499.95，缓存已清不是旧数）',
      !!det3b && flat(det3b).indexOf('¥1000.05') >= 0 && flat(det3b).indexOf('¥499.95') >= 0,
      det3b ? flat(det3b).slice(0, 220) : 'missing');
    report('重算后仍守恒：合计 ¥1500.00 / 条目 ¥1500.00',
      !!det3b && flat(det3b).indexOf('合计 ¥1500.00 / 条目 ¥1500.00') >= 0);

    /* ── P2：按营收占比（与「统计」同口径）────────────────────────── */
    step('revenue');
    await openEditor();
    setVal(eact('entry-amount'), '400.00');
    setVal(eact('entry-party'), '21');
    clickAct('entry-scope-shared');
    await settle(function () { return !!eact('alloc-shop-11'); }, 6000);
    clickAct('alloc-basis-revenue');
    await waitFor(function () { return !!act('alloc-revenue-sum'); }, 8000);
    var revSum = flat(act('alloc-revenue-sum'));
    report('营收取数按发生月、上限 2000 行（不是全库）',
      String((lastCall('orderShippingRows') || {}).period) === MONTH &&
        Number((lastCall('orderShippingRows') || {}).limit) === 2000,
      JSON.stringify(lastCall('orderShippingRows')));
    report('营收汇总与「统计」同口径：关闭单排除、缺金额行计数，三项分桶都写清',
      revSum.indexOf('本期营收 ¥2500.00') >= 0 && revSum.indexOf('已归属店铺 ¥2000.00') >= 0 &&
        revSum.indexOf('已排除关闭单 1 行') >= 0 && revSum.indexOf('缺金额 1 行') >= 0,
      revSum);
    report('未登记店铺的营收不参与分摊，且逐家说明原因',
      !!act('alloc-revenue-unmatched') &&
        flat(act('alloc-revenue-unmatched')).indexOf('幽灵店 ¥300.00（未登记）') >= 0,
      act('alloc-revenue-unmatched') ? flat(act('alloc-revenue-unmatched')) : 'missing');
    report('订单没写店铺的营收不参与分摊（不静默摊给别家）',
      !!act('alloc-revenue-unassigned') && flat(act('alloc-revenue-unassigned')).indexOf('¥200.00') >= 0,
      act('alloc-revenue-unassigned') ? flat(act('alloc-revenue-unassigned')) : 'missing');
    await settle(function () {
      var rs = all('[data-act="alloc-table"] [data-alloc-shop]');
      return rs.length === 2 && flat(rs[0]).indexOf('¥300.00') >= 0 && flat(rs[1]).indexOf('¥100.00') >= 0;
    }, 6000);
    var revRows = all('[data-act="alloc-table"] [data-alloc-shop]');
    report('按营收占比预览：1500:500 → 300.00 / 100.00（75% / 25%）',
      revRows.length === 2 &&
        flat(revRows[0]).indexOf('¥1500.00') >= 0 && flat(revRows[0]).indexOf('¥300.00') >= 0 &&
        flat(revRows[1]).indexOf('¥500.00') >= 0 && flat(revRows[1]).indexOf('¥100.00') >= 0,
      revRows.map(flat).join(' | '));
    report('预览合计 = 条目金额（守恒）', has('合计 ¥400.00 / 条目 ¥400.00'));
    await saveEditor();
    await waitEditorClosed();
    await settle(function () { return rowCount() === baseRows + 1; }, 8000);
    var revenueEntryId = window.__smokeLedger.lastEntryId;
    var rev = lastCall('ledgerEntryUpsert');
    report('营收基准保存：basis=revenue、分摊 300/100、占比快照 7500/2500、不带方案 id',
      rev && rev.scope === 'shared' && rev.basis === 'revenue' &&
        rev.allocations.length === 2 &&
        rev.allocations[0].amountCents === 30000 && rev.allocations[1].amountCents === 10000 &&
        rev.allocations[0].ratioBp === 7500 && rev.allocations[1].ratioBp === 2500 &&
        Number(rev.ruleId) === 0,
      JSON.stringify(rev));
    row(revenueEntryId).querySelector('[data-act="entry-alloc-toggle-' + revenueEntryId + '"]').click();
    await settle(function () {
      var el = document.querySelector('[data-alloc-detail="' + revenueEntryId + '"]');
      return el && flat(el).indexOf('¥300.00') >= 0;
    }, 6000);
    var revDet = document.querySelector('[data-alloc-detail="' + revenueEntryId + '"]');
    report('营收基准条目展开后也写明基准（按营收占比），金额与保存预览同一份',
      !!revDet && flat(revDet).indexOf('分摊明细 · 按营收占比') >= 0 &&
        flat(revDet).indexOf('合计 ¥400.00 / 条目 ¥400.00') >= 0,
      revDet ? flat(revDet).slice(0, 220) : 'missing');
    row(revenueEntryId).querySelector('[data-act="entry-alloc-toggle-' + revenueEntryId + '"]').click();

    var shipCallsBeforeReopen = calls('orderShippingRows').length;
    row(revenueEntryId).click();
    await waitFor(function () { return !!eact('entry-revenue-basis'); }, 6000);
    await settle(function () {
      var rs = all('[data-act="alloc-table"] [data-alloc-shop]');
      return rs.length === 2 && flat(rs[0]).indexOf('¥300.00') >= 0;
    }, 6000);
    var revReopenRows = all('[data-act="alloc-table"] [data-alloc-shop]');
    report('重新打开旧营收账：权重取当初分摊金额（75% / 25%），不重新拉订单',
      !eact('entry-amount').disabled && eact('entry-scope-shared').disabled &&
        revReopenRows.length === 2 &&
        flat(revReopenRows[0]).indexOf('¥300.00') >= 0 && flat(revReopenRows[0]).indexOf('75.00%') >= 0 &&
        flat(revReopenRows[1]).indexOf('¥100.00') >= 0 && flat(revReopenRows[1]).indexOf('25.00%') >= 0 &&
        calls('orderShippingRows').length === shipCallsBeforeReopen,
      JSON.stringify({
        calls: calls('orderShippingRows').length,
        before: shipCallsBeforeReopen,
        rows: revReopenRows.map(flat),
      }));
    await closeEditor();

    /* ── P2：分摊方案往返（存 → 套用 → 落库留痕 → 再打开仍指回）──── */
    step('rules');
    await openEditor();
    setVal(eact('entry-amount'), '500.00');
    setVal(eact('entry-party'), '21');
    clickAct('entry-scope-shared');
    await settle(function () { return !!eact('alloc-shop-11'); }, 6000);
    clickAct('alloc-basis-manual');
    await settle(function () { return actAll('alloc-pct', act('entry-editor')).length === 2; }, 4000);
    var rulePct = actAll('alloc-pct', act('entry-editor'));
    setVal(rulePct[0], '70');
    setVal(rulePct[1], '30');
    await settle(function () { return has('合计 ¥500.00 / 条目 ¥500.00'); }, 5000);
    clickAct('alloc-rule-save-open');
    await waitFor(function () { return !!eact('alloc-rule-name'); }, 4000);
    setVal(eact('alloc-rule-name'), '房租 70/30');
    await clickEnabled('[data-act="alloc-rule-save"]', act('entry-editor'));
    await settle(function () { return has('方案「房租 70/30」已保存'); }, 6000);
    var rulePayload = lastCall('ledgerRuleUpsert');
    report('存方案：名称 / 基准 / 店铺顺序 / 万分比一次带上',
      rulePayload && rulePayload.name === '房租 70/30' && rulePayload.basis === 'manual' &&
        rulePayload.shopIds.join(',') === '11,12' && rulePayload.ratios.join(',') === '7000,3000',
      JSON.stringify(rulePayload));
    if (!window.__smokeLedger.lastRuleId) throw new Error('方案未保存成功');
    var savedRuleId = window.__smokeLedger.lastRuleId;
    await saveEditor();
    await waitEditorClosed();
    await settle(function () { return rowCount() === baseRows + 2; }, 8000);
    var withRule = lastCall('ledgerEntryUpsert');
    report('保存为方案的那笔账带 ruleId（来源留痕），分摊 350 / 150',
      withRule && Number(withRule.ruleId) === savedRuleId && withRule.basis === 'manual' &&
        withRule.allocations[0].amountCents === 35000 && withRule.allocations[1].amountCents === 15000,
      JSON.stringify(withRule));

    await openEditor();
    setVal(eact('entry-amount'), '200.00');
    setVal(eact('entry-party'), '21');
    clickAct('entry-scope-shared');
    await settle(function () { return !!eact('alloc-shop-11'); }, 6000);
    setVal(eact('alloc-rule-select'), String(savedRuleId));
    await clickEnabled('[data-act="alloc-rule-apply"]', act('entry-editor'));
    await settle(function () {
      return has('已套用「房租 70/30」') && actAll('alloc-pct', act('entry-editor')).length === 2;
    }, 6000);
    var appliedPct = actAll('alloc-pct', act('entry-editor'));
    report('套用方案：基准切到手工比例、比例按 shopIds 对齐回填 70 / 30',
      appliedPct.length === 2 && appliedPct[0].value === '70.00' && appliedPct[1].value === '30.00' &&
        eact('alloc-basis-manual').classList.contains('is-on') &&
        !!act('alloc-rule-hint') && flat(act('alloc-rule-hint')).indexOf('已套用') >= 0,
      appliedPct.map(function (x) { return x.value; }).join(' / '));
    await settle(function () {
      var rs = all('[data-act="alloc-table"] [data-alloc-shop]');
      return rs.length === 2 && flat(rs[0]).indexOf('¥140.00') >= 0 && flat(rs[1]).indexOf('¥60.00') >= 0;
    }, 5000);
    await saveEditor();
    await waitEditorClosed();
    await settle(function () { return rowCount() === baseRows + 3; }, 8000);
    var appliedEntryId = window.__smokeLedger.lastEntryId;
    var applied = lastCall('ledgerEntryUpsert');
    report('套用后保存：分摊 140 / 60、ruleId 落库（只作留痕，重算不读它）',
      applied && Number(applied.ruleId) === savedRuleId && applied.basis === 'manual' &&
        applied.allocations[0].amountCents === 14000 && applied.allocations[1].amountCents === 6000,
      JSON.stringify(applied));
    row(appliedEntryId).click();
    await waitFor(function () { return !!eact('alloc-rule-select'); }, 6000);
    report('再打开这笔账：方案下拉仍指向当初套用的方案（来源可回溯）',
      Number(eact('alloc-rule-select').value) === savedRuleId &&
        Number(window.__smokeLedger.entry(appliedEntryId).ruleId) === savedRuleId,
      'selected=' + eact('alloc-rule-select').value + ' stored=' + window.__smokeLedger.entry(appliedEntryId).ruleId);
    await closeEditor();

    /* ── P2：落库守恒校验失败 → 错误留在弹层里，不关框 ──────────── */
    step('conservation-reject');
    window.__smokeRejectUpsert = '分摊合计与条目金额不一致（30000 ≠ 29999），已拒绝保存';
    await openEditor();
    setVal(eact('entry-amount'), '300.00');
    setVal(eact('entry-party'), '21');
    clickAct('entry-scope-shared');
    await settle(function () { return !!eact('alloc-shop-11'); }, 6000);
    var beforeReject = rowCount();
    await saveEditor();
    await settle(function () { return has('已拒绝保存'); }, 5000);
    report('守恒校验失败：错误显示在弹层内，弹层不关、列表不变（没写进去也不假装成功）',
      !!act('entry-editor') && flat(act('entry-form-error')).indexOf('已拒绝保存') >= 0 &&
        rowCount() === beforeReject,
      act('entry-form-error') ? flat(act('entry-form-error')) : 'missing');
    window.__smokeRejectUpsert = '';
    await closeEditor();

    /* ── P3：往来台账（六个数 / 合计 / 对账恒等式）────────────────── */
    step('party-ledger');
    clickAct('ledger-tab-parties');
    await waitFor(function () { return !!act('party-ledger-table'); }, 10000);
    await settle(function () { return !!act('party-identity'); }, 8000);
    report('切到「往来」：台账出现，默认不含已停用（21 / 22 / 测试供应商 3 人）',
      all('[data-party-ledger-id]').length === 3 &&
        !document.querySelector('[data-party-ledger-id="23"]') &&
        !document.querySelector('[data-party-ledger-id="24"]'),
      'rows=' + all('[data-party-ledger-id]').map(function (r) { return r.getAttribute('data-party-ledger-id'); }).join(','));
    report('往来取数：台账带 includeArchived、恒等式取**全期间**汇总（不是本月）',
      !!(lastCall('ledgerPartyLedger') || {}).includeArchived &&
        calls('ledgerSummary').some(function (c) { return c.period === ''; }),
      JSON.stringify(lastCall('ledgerPartyLedger')) + ' summaryPeriods=' +
        calls('ledgerSummary').map(function (c) { return JSON.stringify(c.period); }).join(','));

    var pRow21 = document.querySelector('[data-party-ledger-id="21"]');
    report('相关人 21：五个数各自独立（应收 0 / 应付 3630 / 净 −3630 / 已结算 50 / 未结清 −3580）',
      flat(pRow21.querySelector('[data-act="ledger-party-receivable"]')) === '¥0.00' &&
        flat(pRow21.querySelector('[data-act="ledger-party-payable"]')) === '¥3630.00' &&
        flat(pRow21.querySelector('[data-act="ledger-party-net"]')) === '-¥3630.00' &&
        flat(pRow21.querySelector('[data-act="ledger-party-settled"]')) === '¥50.00' &&
        flat(pRow21.querySelector('[data-act="ledger-party-unsettled"]')).indexOf('-¥3580.00') >= 0,
      flat(pRow21));
    report('未结清行同时给出**分方向**余额（可收 / 可付），不用净额代替',
      flat(pRow21.querySelector('[data-act="ledger-party-unsettled"]')).indexOf('可收 ¥0.00 · 可付 ¥3580.00') >= 0,
      flat(pRow21.querySelector('[data-act="ledger-party-unsettled"]')));
    report('台账合计跟随当前显示（应收 5000 / 应付 4910.50 / 净 89.50 / 已结算 50 / 未结清 139.50）',
      flat(act('ledger-total-receivable')) === '¥5000.00' &&
        flat(act('ledger-total-payable')) === '¥4910.50' &&
        flat(act('ledger-total-net')) === '¥89.50' &&
        flat(act('ledger-total-settled')) === '¥50.00' &&
        flat(act('ledger-total-unsettled')) === '¥139.50',
      [flat(act('ledger-total-receivable')), flat(act('ledger-total-payable')), flat(act('ledger-total-net')),
        flat(act('ledger-total-settled')), flat(act('ledger-total-unsettled'))].join(' / '));
    report('对账恒等式：Σ净往来（含已停用）= 全期间收入 − 全期间支出',
      flat(act('party-identity')).indexOf('对账通过') >= 0 &&
        flat(act('party-identity')).indexOf('-¥1410.50') >= 0 &&
        flat(act('party-identity')).indexOf('总收入 ¥5000.00') >= 0 &&
        flat(act('party-identity')).indexOf('总支出 ¥6410.50') >= 0,
      flat(act('party-identity')));

    clickAct('party-include-archived');
    await settle(function () { return all('[data-party-ledger-id]').length === 5; }, 6000);
    report('勾「含已停用」：5 人，合计把停用的人也纳入（应付 6410.50 / 未结清 −1360.50）',
      all('[data-party-ledger-id]').length === 5 &&
        flat(act('ledger-total-payable')) === '¥6410.50' &&
        flat(act('ledger-total-unsettled')) === '-¥1360.50',
      'rows=' + all('[data-party-ledger-id]').length + ' payable=' + flat(act('ledger-total-payable')) +
        ' unsettled=' + flat(act('ledger-total-unsettled')));
    clickAct('party-include-archived');
    await settle(function () { return all('[data-party-ledger-id]').length === 3; }, 6000);

    /* ── P3：往来抽屉（六个数 + 逐笔余额 + 结算单）────────────────── */
    step('party-drawer');
    document.querySelector('[data-party-ledger-id="21"]').click();
    await waitFor(function () { return !!act('drawer-numbers'); }, 8000);
    await settle(function () { return !!document.querySelector('[data-act="drawer-timeline"] tbody tr'); }, 8000);
    var nums = flat(act('drawer-numbers'));
    report('抽屉六个数：应收 / 应付 / 净往来 / 已结算 / 未结清 / 分方向',
      nums.indexOf('应收') >= 0 && nums.indexOf('¥3630.00') >= 0 &&
        nums.indexOf('已结算') >= 0 && nums.indexOf('¥50.00') >= 0 &&
        nums.indexOf('未结清') >= 0 && nums.indexOf('-¥3580.00') >= 0 &&
        nums.indexOf('可付 ¥3580.00') >= 0,
      nums);
    report('抽屉取数按人、**不限月份**（结算与账期无关），并拉结算单',
      String((lastCall('ledgerEntryList') || {}).partyId) === '21' &&
        (lastCall('ledgerEntryList') || {}).period === undefined &&
        Boolean((lastCall('ledgerEntryList') || {}).includeVoid) &&
        String((lastCall('ledgerSettleList') || {}).partyId) === '21',
      JSON.stringify(lastCall('ledgerEntryList')) + ' ' + JSON.stringify(lastCall('ledgerSettleList')));

    var tlTop = document.querySelector('[data-act="drawer-timeline"] tbody tr');
    var tlRows = all('[data-act="drawer-timeline"] tbody tr');
    report('时间线按日期倒序，逐行余额 = 截至该笔之后的未结清（首行与顶部「未结清」一致）',
      tlRows.length === 12 && flat(tlTop).indexOf('-¥3580.00') >= 0 &&
        flat(tlTop).indexOf(MONTH + '-') >= 0,
      'rows=' + tlRows.length + ' top=' + (tlTop ? flat(tlTop) : 'missing'));
    report('结算单作为一笔事件出现在时间线上（带方式），历史结算不丢',
      has('结算 · 我付给对方') && has('结算单 #9'),
      flat(document.querySelector('[data-act="drawer-settlements"]')).slice(0, 160));
    report('结算单列表：#9 有效、1 条、现金',
      flat(document.querySelector('[data-settlement-id="9"]')).indexOf('有效 · 1 条') >= 0 &&
        flat(document.querySelector('[data-settlement-id="9"]')).indexOf('现金') >= 0,
      flat(document.querySelector('[data-settlement-id="9"]')));
    clickAct('drawer-close');
    await settle(function () { return !act('party-drawer'); }, 4000);

    /* ── P3：结算往返（勾选 → 金额由服务端求和 → 台账刷新）────────── */
    step('settle-create');
    var settleBefore = window.__smokeLedger.settleCount();
    document.querySelector('[data-party-ledger-id="21"] [data-act="party-settle-open"]').click();
    await waitFor(function () { return !!act('settle-dialog'); }, 6000);
    await settle(function () { return all('[data-settle-entry]').length > 0; }, 6000);
    report('候选只含**未结算**且方向一致的条目（已结算的 #4 不再出现）',
      all('[data-settle-entry]').length === 8 && !document.querySelector('[data-settle-entry="4"]'),
      'candidates=' + all('[data-settle-entry]').map(function (r) { return r.getAttribute('data-settle-entry'); }).join(','));
    report('方向按余额自动选「我付给对方」（应付方向有余额）',
      act('settle-direction-pay').classList.contains('is-on'));
    report('金额不可手填，初始为 0；上限按**该方向**余额 ¥3580.00',
      flat(act('settle-total')) === '¥0.00' &&
        flat(act('settle-limit')).indexOf('¥3580.00') >= 0 &&
        !document.querySelector('[data-act="settle-amount-input"]'),
      flat(act('settle-total')) + ' / ' + flat(act('settle-limit')));
    clickAct('settle-select-all');
    await settle(function () { return flat(act('settle-total')) === '¥3580.00'; }, 5000);
    report('全选候选：合计恰好等于该方向未结清（已结的 50 不在候选里，所以不是 3630）',
      flat(act('settle-total')) === '¥3580.00',
      flat(act('settle-total')));
    clickAct('settle-select-all');
    await settle(function () { return flat(act('settle-total')) === '¥0.00'; }, 5000);
    act('settle-entry-7').click();
    act('settle-entry-103').click();
    await settle(function () { return flat(act('settle-total')) === '¥130.00'; }, 5000);
    report('勾选两条：合计 ¥130.00（30.00 + 100.00，仍是勾选之和）', flat(act('settle-total')) === '¥130.00');

    await clickEnabled('[data-act="settle-submit"]', act('settle-dialog'));
    await settle(function () { return !act('settle-dialog'); }, 10000);
    await settle(function () {
      var r = document.querySelector('[data-party-ledger-id="21"]');
      return r && flat(r.querySelector('[data-act="ledger-party-settled"]')) === '¥180.00';
    }, 8000);
    var createPayload = lastCall('ledgerSettleCreate');
    var newSettleId = window.__smokeLedger.lastSettlementId();
    var createdSettle = window.__smokeLedger.settlement(newSettleId);
    report('结算请求：不带金额（服务端按条目求和）、方向 pay、日期由界面给',
      createPayload && createPayload.partyId === 21 && createPayload.direction === 'pay' &&
        !('amountCents' in createPayload) &&
        createPayload.entryIds.slice().sort(function (a, b) { return a - b; }).join(',') === '7,103' &&
        /^\\d{4}-\\d{2}-\\d{2}$/.test(String(createPayload.settleDate)),
      JSON.stringify(createPayload));
    report('结算单落库：金额 13000、两条、有效（桩数据真改了，不是乐观更新）',
      window.__smokeLedger.settleCount() === settleBefore + 1 &&
        !!createdSettle && createdSettle.amountCents === 13000 &&
        createdSettle.entryIds.length === 2 && createdSettle.status === 'active' &&
        window.__smokeLedger.entry(7).settled === true && window.__smokeLedger.entry(103).settled === true,
      JSON.stringify(createdSettle));
    report('结算后台账：已结算 50 → 180、未结清 −3580 → −3450（两个数一起动）',
      flat(document.querySelector('[data-party-ledger-id="21"] [data-act="ledger-party-settled"]')) === '¥180.00' &&
        flat(document.querySelector('[data-party-ledger-id="21"] [data-act="ledger-party-unsettled"]')).indexOf('-¥3450.00') >= 0,
      flat(document.querySelector('[data-party-ledger-id="21"]')));

    step('settle-reflect-detail');
    clickAct('ledger-tab-detail');
    await settle(function () { return rowCount() === 11; }, 8000);
    report('结算不产生收支/条目（明细仍是 11 条）', rowCount() === 11, 'rows=' + rowCount());
    report('明细行同步标记「已结算」，且不可再作废',
      flat(row(7).querySelector('[data-act="entry-settled"]')).indexOf('已结算') >= 0 &&
        flat(row(103).querySelector('[data-act="entry-settled"]')).indexOf('已结算') >= 0 &&
        row(103).querySelector('[data-act="entry-void"]').disabled === true,
      flat(row(103).querySelector('[data-act="entry-settled"]')));
    report('结算后整月合计不变（结算只改往来状态）',
      metric('metric-income').indexOf('¥5000.00') >= 0);

    /* ── P3：重复结算被拒（并发/另一窗口已结掉的那笔）─────────────── */
    step('settle-duplicate');
    clickAct('ledger-tab-parties');
    await waitFor(function () { return !!act('party-ledger-table'); }, 8000);
    document.querySelector('[data-party-ledger-id="22"] [data-act="party-settle-open"]').click();
    await waitFor(function () { return !!act('settle-dialog'); }, 6000);
    await settle(function () { return !!act('settle-entry-2'); }, 6000);
    report('只有应收时方向默认「对方付给我」', act('settle-direction-receive').classList.contains('is-on'));
    act('settle-entry-2').click();
    await settle(function () { return flat(act('settle-total')) === '¥5000.00'; }, 5000);
    window.__smokeLedger.forceEntrySettled(2, 88);
    clickAct('settle-submit');
    await settle(function () { return !!act('settle-error'); }, 8000);
    report('重复结算被服务端拒绝：错误留在弹层内、不假装成功、账单没多出来',
      flat(act('settle-error')).indexOf('已结算过') >= 0 &&
        flat(act('settle-error')).indexOf('#88') >= 0 &&
        !!act('settle-dialog') &&
        window.__smokeLedger.settleCount() === settleBefore + 1,
      flat(act('settle-error')));
    window.__smokeLedger.forceEntrySettled(2, 0);
    clickAct('settle-cancel');
    await settle(function () { return !act('settle-dialog'); }, 4000);

    /* ── P3：撤销结算（原因必填 → 恢复未结）──────────────────────── */
    step('settle-void');
    document.querySelector('[data-party-ledger-id="21"]').click();
    await waitFor(function () { return !!act('drawer-numbers'); }, 8000);
    await settle(function () { return !!document.querySelector('[data-settlement-id="' + newSettleId + '"]'); }, 8000);
    var newSettleRow = '[data-settlement-id="' + newSettleId + '"]';
    document.querySelector(newSettleRow + ' [data-act="settle-void-open"]').click();
    await waitFor(function () { return !!act('confirm-dialog'); }, 5000);
    var voidsBefore = calls('ledgerSettleVoid').length;
    clickAct('confirm-ok');
    await settle(function () { return has('请填写撤销原因'); }, 4000);
    report('撤销原因必填：空原因点确认 → 报错且不发请求',
      has('请填写撤销原因') && calls('ledgerSettleVoid').length === voidsBefore,
      flat(act('confirm-dialog')));
    setVal(act('settle-void-reason'), '结错了，重结');
    clickAct('confirm-ok');
    await settle(function () { return !act('confirm-dialog'); }, 8000);
    await settle(function () { return flat(document.querySelector(newSettleRow)).indexOf('已撤销') >= 0; }, 8000);
    report('撤销后结算单**保留**在列表里（标已撤销 + 原因），不删历史',
      !!document.querySelector(newSettleRow) &&
        flat(document.querySelector(newSettleRow)).indexOf('已撤销') >= 0 &&
        flat(document.querySelector(newSettleRow)).indexOf('结错了，重结') >= 0,
      flat(document.querySelector(newSettleRow)));
    var afterVoid = window.__smokeLedger.partyLedger(21);
    report('撤销后余额回到未结状态（已结算 50、未结清 −3580），条目可重新结算',
      afterVoid.settledNetCents === 5000 && afterVoid.unsettledPayableCents === 358000 &&
        window.__smokeLedger.entry(7).settled === false && window.__smokeLedger.entry(103).settled === false,
      JSON.stringify(afterVoid));
    clickAct('drawer-close');
    await settle(function () { return !act('party-drawer'); }, 4000);
    await settle(function () {
      var r = document.querySelector('[data-party-ledger-id="21"]');
      return r && flat(r.querySelector('[data-act="ledger-party-settled"]')) === '¥50.00';
    }, 8000);
    report('台账同步回收：已结算 ¥50.00、未结清 −¥3580.00',
      flat(document.querySelector('[data-party-ledger-id="21"] [data-act="ledger-party-settled"]')) === '¥50.00' &&
        flat(document.querySelector('[data-party-ledger-id="21"] [data-act="ledger-party-unsettled"]')).indexOf('-¥3580.00') >= 0,
      flat(document.querySelector('[data-party-ledger-id="21"]')));

    clickAct('ledger-tab-detail');
    await settle(function () { return rowCount() === 11; }, 8000);
    report('撤销后明细行恢复「未结算」且作废按钮重新可用',
      row(103) && flat(row(103).querySelector('[data-act="entry-settled"]')).indexOf('未结算') >= 0 &&
        row(103).querySelector('[data-act="entry-void"]').disabled === false,
      row(103) ? flat(row(103).querySelector('[data-act="entry-settled"]')) : 'missing');

    /* ── P4：单店视图（三卡来自分摊行，与汇总页必须同一套数）──────── */
    step('p4-shop');
    report('四个页签齐全（明细 / 往来 / 单店 / 汇总）',
      !!act('ledger-tab-detail') && !!act('ledger-tab-parties') &&
        !!act('ledger-tab-shop') && !!act('ledger-tab-summary'));
    clickAct('ledger-tab-shop');
    await waitFor(function () { return !!act('shop-view'); }, 8000);
    report('单店页默认空态：先选一家店（不给"看起来全是 0"的表）',
      isShown(act('shop-empty')) && has('先选一家店'));
    setVal(act('shop-pick'), '11');
    await waitFor(function () { return !!act('shop-card-expense'); }, 8000);
    var s11 = byShopRow(11);
    report('店 11 三卡：收入 0 / 支出 4530.55（本店 1330.50 + 公摊 3200.05）/ 结余为负',
      flat(act('shop-card-income')).indexOf('¥0.00') >= 0 &&
        flat(act('shop-card-expense')).indexOf('本店 ¥1330.50 · 公摊 ¥3200.05') >= 0 &&
        flat(act('shop-card-expense')).indexOf('¥4530.55') >= 0 &&
        flat(act('shop-card-balance')).indexOf('-¥4530.55') >= 0,
      [flat(act('shop-card-income')), flat(act('shop-card-expense')), flat(act('shop-card-balance'))].join(' | '));
    report('单店卡与汇总页 byShop 同源（同一店两个页签不可能两套数）',
      flat(act('shop-card-expense')).indexOf(money(s11.directExpenseCents + s11.sharedExpenseCents)) >= 0 &&
        flat(act('shop-card-income')).indexOf(money(s11.directIncomeCents + s11.sharedIncomeCents)) >= 0,
      JSON.stringify(s11));
    var cat101 = act('shop-cat-expense-101');
    report('科目分布：采购货款 专属 1330.50 + 公摊 1200.00 = 2530.50（占该方向 55.9%）',
      !!cat101 && flat(cat101).indexOf('¥1330.50') >= 0 && flat(cat101).indexOf('¥1200.00') >= 0 &&
        flat(cat101).indexOf('¥2530.50') >= 0 && flat(cat101).indexOf('55.9%') >= 0,
      cat101 ? flat(cat101) : 'missing');
    var shop6a = act('shop-shared-6');
    report('公摊逐笔列出：营收旧账 #6 整笔 2000.00 → 本店摊入 1200.00（60.00%）',
      !!shop6a && flat(shop6a).indexOf('¥2000.00') >= 0 && flat(shop6a).indexOf('¥1200.00') >= 0 &&
        flat(shop6a).indexOf('60.00%') >= 0 && flat(shop6a).indexOf('按营收分摊的旧账') >= 0,
      shop6a ? flat(shop6a) : 'missing');
    report('本店承担的公摊 = 本月摊到它的全部公共条目（7 笔）',
      all('[data-act^="shop-shared-"]').length === 7,
      'n=' + all('[data-act^="shop-shared-"]').length);
    report('与统计口径只读对照：记账 0 vs 订单 1500.00 → 差异 -1500.00，不相加、不裁定',
      flat(act('shop-compare-ledger')) === '¥0.00' &&
        flat(act('shop-compare-orders')) === '¥1500.00' &&
        flat(act('shop-compare-diff')) === '-¥1500.00' &&
        has('两个口径不可相加'),
      flat(act('shop-compare')).slice(0, 200));
    report('认不出店铺的营收显式提示（不静默摊给别家）',
      has('另有 ¥300.00 订单营收未能归属到任何店铺'));
    setVal(act('shop-pick'), '12');
    await waitFor(function () { return flat(act('shop-card-balance')).indexOf('3170.05') >= 0; }, 8000);
    var s12 = byShopRow(12);
    report('切店后重取：店 12 收入 5000.00 全在本店 / 支出 1829.95（本店 30.00 + 公摊 1799.95）',
      flat(act('shop-card-income')).indexOf('本店 ¥5000.00 · 公摊 ¥0.00') >= 0 &&
        flat(act('shop-card-expense')).indexOf('本店 ¥30.00 · 公摊 ¥1799.95') >= 0 &&
        flat(act('shop-card-balance')).indexOf('¥3170.05') >= 0,
      [flat(act('shop-card-income')), flat(act('shop-card-expense')), flat(act('shop-card-balance'))].join(' | ') +
        ' summary=' + JSON.stringify(s12));
    var catIncome = act('shop-cat-income-201');
    report('收入科目占比按**同方向**算（占收入 100.0%，不跟支出混在一起）',
      !!catIncome && flat(catIncome).indexOf('100.0%') >= 0, catIncome ? flat(catIncome) : 'missing');
    var shop6b = act('shop-shared-6');
    report('同一笔公共账两家店摊入互补（#6 店 12：800.00 / 40.00%，两家相加 = 整笔 2000.00）',
      !!shop6b && flat(shop6b).indexOf('¥800.00') >= 0 && flat(shop6b).indexOf('40.00%') >= 0,
      shop6b ? flat(shop6b) : 'missing');
    report('店 12 差异方向相反（记账 5000.00 − 订单 500.00 = +4500.00）',
      flat(act('shop-compare-diff')) === '¥4500.00', flat(act('shop-compare-diff')));
    clickAct('shop-month-prev');
    await waitFor(function () { return !!act('shop-card-expense') && flat(act('shop-card-expense')).indexOf('¥50.00') >= 0; }, 8000);
    report('单店页切月与明细页共用同一个月份（上月只有那笔跨月账，没有公摊）',
      flat(act('shop-card-expense')).indexOf('本店 ¥50.00 · 公摊 ¥0.00') >= 0 &&
        flat(act('shop-card-income')).indexOf('¥0.00') >= 0 &&
        !act('shop-shared-6') && isShown(act('shop-shared-empty')),
      flat(act('shop-card-expense')) + ' | ' + flat(act('shop-shared')));
    clickAct('shop-month-now');
    await waitFor(function () { return flat(act('shop-card-expense')).indexOf('¥1829.95') >= 0; }, 8000);
    report('点「回到本月」把单店页取数拉回当月', has(monthLabel(MONTH)));

    /* ── P4：汇总页（四分项相加 + 三条体检恒等式）──────────────────── */
    step('p4-summary');
    clickAct('ledger-tab-summary');
    await waitFor(function () { return !!act('summary-table'); }, 8000);
    report('汇总顶部：收入 5000.00 / 支出 6360.50 / 结余 -1360.50 / 条目 11',
      flat(act('summary-metric-income')) === '总收入 ¥5000.00' &&
        flat(act('summary-metric-expense')) === '总支出 ¥6360.50' &&
        flat(act('summary-metric-balance')) === '结余 -¥1360.50' &&
        flat(act('summary-metric-entries')) === '条目 11',
      [flat(act('summary-metric-income')), flat(act('summary-metric-expense')),
        flat(act('summary-metric-balance')), flat(act('summary-metric-entries'))].join(' / '));
    var sumRow11 = act('summary-row-11');
    report('店铺汇总行拆四分项（店 11 专属支出 1330.50 / 公摊支出 3200.05 / 结余 -4530.55）',
      !!sumRow11 && flat(sumRow11).indexOf('¥1330.50') >= 0 &&
        flat(sumRow11).indexOf('¥3200.05') >= 0 && flat(sumRow11).indexOf('-¥4530.55') >= 0,
      sumRow11 ? flat(sumRow11) : 'missing');
    report('合计行按四个分项各自相加（专属支出 1360.50 + 公摊支出 5000.00 = 整月支出）',
      flat(act('summary-total-direct-income')) === '¥5000.00' &&
        flat(act('summary-total-shared-income')) === '¥0.00' &&
        flat(act('summary-total-direct-expense')) === '¥1360.50' &&
        flat(act('summary-total-shared-expense')) === '¥5000.00' &&
        flat(act('summary-total-balance')) === '-¥1360.50',
      [flat(act('summary-total-direct-income')), flat(act('summary-total-shared-income')),
        flat(act('summary-total-direct-expense')), flat(act('summary-total-shared-expense')),
        flat(act('summary-total-balance'))].join(' / '));
    report('合计 = Σ各店结余（公共池摊干净了才对得上）',
      s11.balanceCents + s12.balanceCents === -136050, 'sum=' + (s11.balanceCents + s12.balanceCents));
    report('体检正常时只打勾，不摆一排 0',
      flat(act('summary-public-status')).indexOf('✓ 公共池余额 0') >= 0 &&
        flat(act('summary-party-identity')).indexOf('✓') === 0 &&
        flat(act('summary-allocation')).indexOf('✓') === 0,
      [flat(act('summary-public-status')), flat(act('summary-party-identity')),
        flat(act('summary-allocation'))].join(' | '));

    step('p4-integrity-red');
    window.__smokeIntegrity = {
      publicPoolCents: 300,
      brokenEntries: [ { entryId: 99, amountCents: 1000, allocatedCents: 700 } ],
    };
    clickAct('ledger-tab-detail');
    await settle(function () { return rowCount() === 11; }, 6000);
    clickAct('ledger-tab-summary');
    await waitFor(function () { return !!act('summary-drill-shared'); }, 8000);
    report('公共池不为 0：红字写明差多少 + 声明"这数不能用来做决定" + 给定位入口',
      flat(act('summary-public-status')).indexOf('公共池余额 ¥3.00') >= 0 &&
        has('不能用来做决定') && !!act('summary-drill-shared'),
      flat(act('summary-public-status')));
    var brokenBox = act('summary-broken');
    report('分摊不全的条目逐条点名（id + 金额 + 已摊）',
      !!brokenBox && flat(brokenBox).indexOf('条目 #99') >= 0 &&
        flat(brokenBox).indexOf('¥10.00') >= 0 && flat(brokenBox).indexOf('¥7.00') >= 0,
      brokenBox ? flat(brokenBox) : 'missing');
    clickAct('summary-drill-shared');
    await waitFor(function () { return rowCount() === 7 && act('filter-scope').value === 'shared'; }, 8000);
    report('点「去看公共条目」→ 切回明细并筛范围=公共（定位到 7 笔公共账）',
      rowIds().join(',') === '3,6,102,103,105,106,107', 'ids=' + rowIds().join(','));
    window.__smokeIntegrity = null;
    clickAct('filter-reset');
    await settle(function () { return rowCount() === 11; }, 6000);
    report('恢复：体检正常不再提示，明细回到 11 条',
      !act('integrity-warning') && rowCount() === 11, 'rows=' + rowCount());

    /* ── P4：批量勾选（金额合计只算有效条目）──────────────────────── */
    step('p4-batch');
    report('没勾选时不出现批量条（批量动作不与逐行编辑混在一起）', !act('batch-bar'));
    clickAct('select-all');
    await settle(function () { return isShown(act('batch-bar')); }, 4000);
    report('全选只勾有效条目：11 条 / 收 ¥5000.00 · 支 ¥6360.50（作废的两条不参与；收支不混加）',
      flat(act('batch-count')) === '11' &&
        flat(act('batch-sum-income')).indexOf('¥5000.00') >= 0 &&
        flat(act('batch-sum-expense')).indexOf('¥6360.50') >= 0,
      flat(act('batch-bar')));
    clickAct('select-all');
    await settle(function () { return !act('batch-bar'); }, 4000);
    report('再点一次取消全选，批量条收起、表头勾也跟着掉',
      !act('batch-bar') && act('select-all').checked === false);

    /* ── P4 变更相关人 · A 路（全未结算 → 直接改挂）────────────────── */
    step('p4-repatch-a');
    act('select-entry-2').click();
    act('select-entry-7').click();
    await settle(function () { return flat(act('batch-count')) === '2'; }, 4000);
    report('跨相关人勾选：收 ¥5000.00 / 支 ¥30.00（收支不混加）；批量结算被挡住并说明原因',
      flat(act('batch-sum-income')).indexOf('¥5000.00') >= 0 &&
        flat(act('batch-sum-expense')).indexOf('¥30.00') >= 0 &&
        flat(act('batch-settle-hint')).indexOf('不同相关人') >= 0 &&
        act('batch-settle').disabled === true,
      flat(act('batch-bar')));
    clickAct('batch-repatch');
    await waitFor(function () { return !!act('repatch-summary'); }, 8000);
    report('A 路预览：未结算 2 条 / 已结算 0 条 → 「直接改挂」可用且标推荐',
      flat(act('repatch-summary')).indexOf('合计 ¥5030.00') >= 0 &&
        flat(act('repatch-summary')).indexOf('未结算 2 条 / 已结算 0 条') >= 0 &&
        act('repatch-mode-move-all').disabled === false &&
        act('repatch-mode-move-all').classList.contains('is-on') &&
        flat(act('repatch-mode-move-all')).indexOf('推荐') >= 0,
      flat(act('repatch-summary')) + ' | ' + flat(act('repatch-mode-move-all')));
    report('A 路目标下拉只剩内联新建的 901（条目原属的 21 / 22 排除，已停用的 23 / 24 也不给）',
      targetChoices().join(',') === '901', 'choices=' + targetChoices().join(','));
    setVal(act('repatch-target'), '901');
    await clickEnabled('[data-act="repatch-submit"]', act('repatch-dialog'));
    await waitFor(function () { return has('已改挂 2 条'); }, 6000);
    var repA = lastCall('ledgerEntryRepatch') || {};
    report('A 路请求：mode=move-all + 两个条目 id + 目标人 id（界面不复算，交服务端判）',
      repA.mode === 'move-all' && repA.toPartyId === 901 &&
        repA.entryIds.slice().sort(function (a, b) { return a - b; }).join(',') === '2,7',
      JSON.stringify(repA));
    await settle(function () { return !act('repatch-dialog'); }, 6000);
    report('A 路落到数据（不是乐观更新）：两条都换到人 901、批量条收起、结算单没被碰',
      window.__smokeLedger.entry(2).partyId === 901 &&
        window.__smokeLedger.entry(7).partyId === 901 &&
        !act('batch-bar') && window.__smokeLedger.settlement(9).status === 'active',
      'e2=' + window.__smokeLedger.entry(2).partyId + ' e7=' + window.__smokeLedger.entry(7).partyId);

    /* ── P4 变更相关人 · B 路（含已结算 → 只改挂未结算）────────────── */
    step('p4-repatch-b');
    act('select-entry-4').click();
    act('select-entry-101').click();
    await settle(function () { return flat(act('batch-count')) === '2'; }, 4000);
    report('勾选含已结算条目：批量结算禁用并提示改用「变更相关人」',
      flat(act('batch-settle-hint')).indexOf('已结算的条目不能再结') >= 0,
      flat(act('batch-settle-hint')));
    clickAct('batch-repatch');
    await waitFor(function () { return !!act('repatch-summary'); }, 8000);
    report('B 路自动选中：含已结算时推荐「只改挂未结算」，直接改挂不可用',
      flat(act('repatch-summary')).indexOf('未结算 1 条 / 已结算 1 条') >= 0 &&
        act('repatch-mode-move-unsettled').classList.contains('is-on') &&
        act('repatch-mode-move-all').disabled === true,
      flat(act('repatch-summary')) + ' | ' + flat(act('repatch-mode-move-unsettled')));
    var imp21 = act('repatch-impact-21');
    report('影响表点出原人与「含已结算」条数（留在原人这条历史不动）',
      !!imp21 && flat(imp21).indexOf('含已结算 1') >= 0 && flat(imp21).indexOf('¥50.00') >= 0,
      imp21 ? flat(imp21) : 'missing');
    report('B 路目标下拉只剩 22（原属的 21 / 901 排除，停用的 23 / 24 也不给）',
      targetChoices().join(',') === '22', 'choices=' + targetChoices().join(','));
    setVal(act('repatch-target'), '22');
    await clickEnabled('[data-act="repatch-submit"]', act('repatch-dialog'));
    await waitFor(function () { return has('已结算 1 条留在原人'); }, 6000);
    var repB = lastCall('ledgerEntryRepatch') || {};
    report('B 路执行：只有未结算那条换人，已结算的 #4 仍留 21 且带结算单 #9',
      repB.mode === 'move-unsettled' &&
        window.__smokeLedger.entry(101).partyId === 22 &&
        window.__smokeLedger.entry(4).partyId === 21 &&
        window.__smokeLedger.entry(4).settled === true &&
        window.__smokeLedger.entry(4).settlementId === 9,
      JSON.stringify(repB) + ' e101=' + JSON.stringify(window.__smokeLedger.entry(101)));
    await settle(function () { return !act('repatch-dialog'); }, 6000);
    report('B 路零历史改动：结算单 #9 仍有效、条目一条没少',
      window.__smokeLedger.settlement(9).status === 'active' && rowCount() === 11,
      'rows=' + rowCount());

    /* ── P4 变更相关人 · C 路（全是已结算 → 撤结算后改挂）──────────── */
    step('p4-repatch-c');
    act('select-entry-4').click();
    await settle(function () { return flat(act('batch-count')) === '1'; }, 4000);
    clickAct('batch-repatch');
    await waitFor(function () { return !!act('repatch-mode-void-then-move'); }, 8000);
    // 全已结算时**不预选**：C 路会作废历史结算单，必须用户主动点（否则"默认停在最危险那条路"）
    report('全已结算：A/B 禁用并说明原因，C 可用但**不预选**（提交按钮也不可点）',
      act('repatch-mode-move-all').disabled === true &&
        act('repatch-mode-move-unsettled').disabled === true &&
        !act('repatch-mode-void-then-move').classList.contains('is-on') &&
        act('repatch-submit').disabled === true &&
        flat(act('repatch-mode-void-then-move')).indexOf('会作废 1 张结算单') >= 0 &&
        flat(act('repatch-mode-move-unsettled')).indexOf('没有可单独改挂的未结算条目') >= 0,
      flat(act('repatch-mode-move-unsettled')));
    clickAct('repatch-mode-void-then-move');
    await waitFor(function () { return !!act('repatch-settlements'); }, 8000);
    report('点选 C 路后才展开"将作废的结算单"',
      act('repatch-mode-void-then-move').classList.contains('is-on') && !!act('repatch-settlements'));
    report('将作废的结算单逐张列出（#9 · 1 张 合计 ¥50.00 · 我付给对方）',
      flat(act('repatch-settlements')).indexOf('1 张 · 合计 ¥50.00') >= 0 &&
        !!act('repatch-settle-9') && flat(act('repatch-settle-9')).indexOf('¥50.00') >= 0 &&
        flat(act('repatch-settle-9')).indexOf('我付给对方') >= 0,
      flat(act('repatch-settlements')).slice(0, 240));
    report('该结算单只结了选中这条 → 显式说明不牵连其他账（无连带提示）',
      !act('repatch-collateral') && has('作废不会牵连其他账'));
    report('C 路撤销原因必填：没填时提交按钮不可点', act('repatch-submit').disabled === true);
    setVal(act('repatch-reason'), '对接人换了，旧结算单作废重结');
    report('C 路目标下拉给 22 与 901（只排除选中条目的原属人 21）',
      targetChoices().join(',') === '22,901', 'choices=' + targetChoices().join(','));
    setVal(act('repatch-target'), '901');
    await clickEnabled('[data-act="repatch-submit"]', act('repatch-dialog'));
    await waitFor(function () { return has('作废结算单 1 张'); }, 6000);
    var afterC = window.__smokeLedger.settlement(9);
    var entry4c = window.__smokeLedger.entry(4);
    report('C 路执行：#9 作废并留原因，#4 恢复未结算后改挂到 901',
      afterC.status === 'void' && afterC.voidReason === '对接人换了，旧结算单作废重结' &&
        entry4c.settled === false && entry4c.settlementId === 0 && entry4c.partyId === 901,
      JSON.stringify(afterC) + ' e4=' + JSON.stringify(entry4c));
    await settle(function () { return !act('repatch-dialog'); }, 6000);
    report('作废后明细仍 11 条，该行重新可作废（结算状态跟着回退）',
      rowCount() === 11 && row(4).querySelector('[data-act="entry-void"]').disabled === false,
      'rows=' + rowCount());
    report('变更相关人不动金额：三路走完，整月三个数一分没变',
      metric('metric-income').indexOf('¥5000.00') >= 0 &&
        metric('metric-expense').indexOf('¥6360.50') >= 0 &&
        metric('metric-balance').indexOf('-¥1360.50') >= 0,
      metric('metric-income') + ' / ' + metric('metric-expense') + ' / ' + metric('metric-balance'));

    /* ── P4 导出（渲染层给本地化行与合计，取消不算失败）───────────── */
    step('p4-export');
    var exportBtn = act('ledger-export');
    report('导出按钮写明导多少条（按当前筛选）',
      flat(exportBtn) === '导出' && String(exportBtn.getAttribute('title')) === '导出当前 11 条（按当前筛选）',
      String(exportBtn.getAttribute('title')));
    clickAct('ledger-export');
    await waitFor(function () { return calls('ledgerExportExcel').length === 1; }, 8000);
    var ex1 = lastCall('ledgerExportExcel') || {};
    report('导出载荷：11 行 + 合计与屏幕同源（主进程不复算口径）',
      ex1.rows.length === 11 && ex1.totalIncomeCents === 500000 &&
        ex1.totalExpenseCents === 636050 && ex1.balanceCents === -136050 &&
        ex1.filterLabel === '未筛选（整月全部条目）' && ex1.periodLabel === monthLabel(MONTH) &&
        ex1.defaultName === '记账明细-' + MONTH + '.xlsx',
      JSON.stringify({ rows: ex1.rows.length, inc: ex1.totalIncomeCents, exp: ex1.totalExpenseCents,
        bal: ex1.balanceCents, filter: ex1.filterLabel, period: ex1.periodLabel, name: ex1.defaultName }));
    var exIncome = null;
    var exShared = null;
    for (var exi = 0; exi < ex1.rows.length; exi++) {
      if (ex1.rows[exi].kindLabel === '收入') exIncome = ex1.rows[exi];
      if (ex1.rows[exi].scopeLabel === '公共') exShared = ex1.rows[exi];
    }
    report('导出行按当前数据本地化（改挂后的相关人 / 公共条目写摊几家）',
      !!exIncome && exIncome.shopLabel === 'Aurora Store' && exIncome.partyName === '测试供应商' &&
        exIncome.amountCents === 500000 &&
        !!exShared && exShared.shopLabel === '公共（摊 2 家）',
      JSON.stringify({ inc: exIncome, shared: exShared }));
    await waitFor(function () { return has('已导出 11 行'); }, 4000);
    report('成功文案给出行数与文件位置', has('已导出 11 行'));

    clickAct('filter-kind-income');
    await settle(function () { return rowCount() === 1; }, 6000);
    clickAct('ledger-export');
    await waitFor(function () { return calls('ledgerExportExcel').length === 2; }, 8000);
    var ex2 = lastCall('ledgerExportExcel') || {};
    report('按筛选导出：只出这 1 条，筛选条件写进表头、合计改成这批的合计',
      ex2.rows.length === 1 && ex2.filterLabel === '收/支：收入' &&
        ex2.totalIncomeCents === 500000 && ex2.totalExpenseCents === 0 && ex2.balanceCents === 500000,
      JSON.stringify({ rows: ex2.rows.length, filter: ex2.filterLabel, inc: ex2.totalIncomeCents, exp: ex2.totalExpenseCents }));
    clickAct('filter-reset');
    await settle(function () { return rowCount() === 11; }, 6000);

    window.__smokeExportCancel = true;
    var exportCallsBefore = calls('ledgerExportExcel').length;
    clickAct('ledger-export');
    await waitFor(function () { return calls('ledgerExportExcel').length === exportCallsBefore + 1; }, 6000);
    await settle(function () { return flat(act('ledger-export')) === '导出'; }, 4000);
    report('在保存对话框里点取消：不报「导出失败」，按钮恢复正常（取消不是错误）',
      !has('导出失败') && flat(act('ledger-export')) === '导出', flat(act('ledger-export')));
    window.__smokeExportCancel = false;

    /* ── 退店的店仍参与分摊（2026-10-26）────────────────────────────────
       夹具里现成四家店没有"退店"这一态，所以临时插一家、验完摘掉。
       只靠"排除项文案少了『已停用』那一格"验不出这条 —— 文案与判据可以各自演化，
       必须有"它真的进了勾选区、真的拿到一份钱"这条正向断言。 */
    step('exited-shop');
    window.__smokeLedger.addShop({
      id: 15, platform: 'shopee', name: '退店店', nameKey: '退店店', platformShopId: '', shopUrl: '',
      site: '', status: 'exited', score: 0, openedAt: '2024-01-01', note: '',
      createdAt: '', updatedAt: '', aliasCount: 0,
    });
    await openEditor();
    setVal(eact('entry-amount'), '300.00');
    setVal(eact('entry-party'), '21');
    clickAct('entry-scope-shared');
    await settle(function () {
      var c = eact('alloc-shop-15');
      return !!c && c.checked;
    }, 6000);
    report('退店的店参与分摊：勾选区里有它、默认勾上、且不出现在「未参与」里',
      !!eact('alloc-shop-15') && eact('alloc-shop-15').checked &&
        flat(act('entry-shared')).indexOf('退店店（') < 0,
      '15=' + (eact('alloc-shop-15') ? eact('alloc-shop-15').checked : 'missing'));
    var preExited = all('[data-act="alloc-table"] [data-alloc-shop]');
    report('退店的店真的拿到一份分摊（3 家各 ¥100.00）',
      preExited.length === 3 &&
        preExited.every(function (r) { return flat(r).indexOf('¥100.00') >= 0; }) &&
        preExited.map(flat).join(' | ').indexOf('退店店') >= 0,
      preExited.map(flat).join(' | '));
    await closeEditor();
    window.__smokeLedger.popShop();

    /* ── 批量导入（2026-10-26 真机在这里整批失败）────────────────────────
       失败原因是载荷里混进了 Vue 的 reactive 代理：An object could not be cloned.，
       发生在主进程收到任何东西之前，一笔都没进、也说不出哪一行有问题。
       假桥的 batchCreate 桩照真机先做一次 structuredClone，所以这条路径从此是"真跑过"的。 */
    step('import');
    clickAct('ledger-tab-detail');
    await settle(function () { return !!act('ledger-import-open'); }, 6000);
    clickAct('ledger-import-open');
    await waitFor(function () { return !!act('imp-pick'); }, 8000);
    clickAct('imp-pick');
    await waitFor(function () { return !!act('imp-summary-pick'); }, 12000);
    report('导入预览读到了真 xlsx：认列 + 三行可导（分摊店铺没被店铺抢走）',
      flat(act('imp-columns')).indexOf('分摊店铺') >= 0 &&
        flat(act('imp-summary-pick')).indexOf('可导入 3 笔') >= 0,
      flat(act('imp-columns')) + ' / ' + flat(act('imp-summary-pick')));
    report('金额超两位小数：该行标「金额取整」并把取整后的数念出来（1200.5678 → 1200.57）',
      !!act('imp-row-rounded') && has('1200.57'),
      flat(act('imp-row-rounded')) + ' | ' + has('1200.57'));
    report('库里没有的相关人 / 科目标出「将新建」（打错字就会凭空多一个假房东）',
      has('将新建相关人') && has('+ 科目'), flat(act('imp-row-new')));
    var allocToggle = act('imp-alloc-toggle-3');
    var allocText = '';
    if (allocToggle) {
      allocToggle.click();
      await settle(function () { return !!act('imp-alloc-rows'); }, 4000);
      allocText = flat(act('imp-alloc-rows'));
    }
    report('公共行按「全部」摊给当期两家店、每店 ¥150.00（点得开逐笔，不是只写"2 家"）',
      !!allocToggle && (allocText.match(/¥150[.]00/g) || []).length === 2,
      allocToggle ? allocText : '没有「看逐笔」按钮');

    clickEnabled('[data-act="imp-submit"]');
    await settle(function () {
      return calls('ledgerEntryBatchCreate').length === 1 || calls('ledgerEntryBatchCreateCloneFail').length > 0;
    }, 10000);
    var impCloneFail = lastCall('ledgerEntryBatchCreateCloneFail');
    report('提交载荷过得了 IPC 的结构化克隆（Vue 代理过不去：An object could not be cloned.）',
      !impCloneFail, impCloneFail || 'ok');
    var impPayload = lastCall('ledgerEntryBatchCreate') || { entries: [] };
    var impEntries = impPayload.entries || [];
    report('整批 3 笔一次进：金额都是整数分（120057 / 30000 / 8880）',
      impEntries.length === 3 &&
        impEntries.map(function (e) { return e.amountCents; }).join(',') === '120057,30000,8880',
      JSON.stringify(impEntries.map(function (e) { return e.amountCents; })));
    report('公共行的 2 行分摊随载荷过去（分摊在渲染层算，主进程只断言守恒）',
      (impEntries[1] && impEntries[1].allocations || []).length === 2,
      JSON.stringify(impEntries[1] && impEntries[1].allocations));
    report('待建名字跟着走（partyId 0 + partyName），已有的名字不带过去',
      impEntries[2] && impEntries[2].partyId === 0 && impEntries[2].partyName === '新人甲' &&
        impEntries[2].categoryName === '新科目' && !impEntries[0].partyName,
      JSON.stringify({ p: impEntries[2] && impEntries[2].partyName, c: impEntries[2] && impEntries[2].categoryName }));

    await settle(function () { return !act('imp-pick'); }, 8000);
    report('导入成功：toast 念出笔数 / 金额 / 分摊行数 / 新建的名字',
      has('已导入 3 笔') && has('分摊明细 4 行') && has('新建相关人 新人甲') && has('新建科目 新科目'),
      flat(act('ledger-import-open')) + ' | ' + has('已导入 3 笔'));
    await settle(function () { return rowCount() === 14; }, 8000);
    report('三笔真的落到明细（11 → 14 行，不是"提示成功但列表没变"）',
      rowCount() === 14, 'rows=' + rowCount());

    /* ── 撤销本次导入（C3 轻量版：只在本次会话有效）──────────────────
       导错文件时原先只能逐条作废；这里守「给出入口 + 撤销真的作废这三笔」。 */
    step('import-undo');
    await settle(function () { return !!act('import-undo-bar'); }, 6000);
    report('导入成功后给「撤销本次导入（N 条）」入口，并写明刚导了多少笔',
      !!act('import-undo-bar') &&
        flat(act('import-undo-bar')).indexOf('撤销本次导入（3 条）') >= 0 &&
        flat(act('import-undo')).indexOf('3') >= 0,
      act('import-undo-bar') ? flat(act('import-undo-bar')).slice(0, 160) : 'missing');

    clickAct('import-undo');
    await waitFor(function () { return !!act('confirm-dialog'); }, 6000);
    report('撤销确认写明「作废这 N 条」+「整批一个事务」+「新建的相关人/科目不会跟着删」',
      flat(act('confirm-dialog')).indexOf('作废这 3 条') >= 0 &&
        flat(act('confirm-dialog')).indexOf('整批一个事务') >= 0 &&
        flat(act('confirm-dialog')).indexOf('不会跟着删') >= 0,
      flat(act('confirm-dialog')).slice(0, 220));

    clickAct('confirm-ok');
    await settle(function () { return !act('confirm-dialog'); }, 8000);
    await settle(function () { return rowCount() === 11; }, 8000);
    report('撤销后三笔真的变作废、明细回到 11 行（不是"提示撤销但账还在"）',
      rowCount() === 11 && window.__smokeLedger.voidedWithReason('撤销本次导入') === 3,
      'rows=' + rowCount() + ' voided=' + window.__smokeLedger.voidedWithReason('撤销本次导入'));
    report('请求带的是这三条的 id（不是整批 11 条）',
      ((lastCall('ledgerEntriesVoid') || {}).ids || []).length === 3,
      JSON.stringify(lastCall('ledgerEntriesVoid')));
    report('撤销入口用过即消失（避免"再点一次"撤掉别的批次）', !act('import-undo-bar'));
    report('作废原因写「撤销本次导入」：勾「含作废」时用户能看懂这批是怎么没的',
      window.__smokeLedger.voidedWithReason('撤销本次导入') === 3);

    /* ── 互抵结清（2026-10-27）─────────────────────────────────────
       用户提的原场景：垫付 1000（应付）+ 代收 400（应收），净额 −600，
       账上却显示"还要付 1000、还要收 400"。互抵把两边一起核销，只走差额。
       夹具在这里按需插入（不在开头），否则会改动前面七八条人数/合计断言的具体数值。 */
    step('settle-offset');
    var offsetPartyId = window.__smokeLedger.addOffsetFixture();
    clickAct('ledger-tab-parties');
    await waitFor(function () { return !!act('party-ledger-table'); }, 8000);
    await settle(function () {
      return !!document.querySelector('[data-party-ledger-id="' + offsetPartyId + '"]');
    }, 8000);
    var offsetSel = '[data-party-ledger-id="' + offsetPartyId + '"]';

    /* 「已并入」在台账里同样要看得出来（与相关人管理页同一个判据：archived + merged_to） */
    clickAct('party-include-archived');
    await settle(function () { return !!act('ledger-party-merged'); }, 6000);
    report('台账：合并掉的写「已并入 → 广州布行」，手动停用的写「已停用」（两种状态不再混成一个）',
      !!act('ledger-party-merged') &&
        flat(act('ledger-party-merged')).indexOf('已并入 → 广州布行') >= 0 &&
        !!document.querySelector('[data-act="ledger-party-archived"]'),
      act('ledger-party-merged') ? flat(act('ledger-party-merged')) : 'missing');
    clickAct('party-include-archived');
    await settle(function () { return !act('ledger-party-merged'); }, 6000);
    report('互抵前：台账把两个方向分开写（可收 ¥400.00 · 可付 ¥1000.00）—— 正是让人困惑的地方',
      flat(document.querySelector(offsetSel + ' [data-act="ledger-party-unsettled"]')).indexOf('可收 ¥400.00') >= 0 &&
        flat(document.querySelector(offsetSel + ' [data-act="ledger-party-unsettled"]')).indexOf('可付 ¥1000.00') >= 0,
      flat(document.querySelector(offsetSel + ' [data-act="ledger-party-unsettled"]')));

    document.querySelector(offsetSel + ' [data-act="party-settle-open"]').click();
    await waitFor(function () { return !!act('settle-dialog'); }, 6000);
    await settle(function () { return all('[data-settle-entry]').length === 2; }, 6000);
    report('两边都有余额时给出互抵提示（否则用户只能看到"还要付钱"）',
      !!act('settle-offset-tip') && flat(act('settle-offset-tip')).indexOf('互抵结清') >= 0,
      act('settle-offset-tip') ? flat(act('settle-offset-tip')) : 'missing');

    clickAct('settle-direction-offset');
    await settle(function () { return act('settle-direction-offset').classList.contains('is-on'); }, 4000);
    report('互抵模式下候选是**两个方向**的未结条目（不是只给一边）',
      all('[data-settle-entry]').length === 2 &&
        !!document.querySelector('[data-settle-entry="8"]') &&
        !!document.querySelector('[data-settle-entry="9"]'),
      'candidates=' + all('[data-settle-entry]').map(function (r) { return r.getAttribute('data-settle-entry'); }).join(','));

    act('settle-entry-8').click();
    await settle(function () { return flat(act('settle-cash')).indexOf('付 ¥1000.00') >= 0; }, 5000);
    report('只勾单边时不能提交（那不是互抵，是普通结算 —— 放过去用户会以为"抵过了"）',
      act('settle-submit').disabled === true &&
        flat(act('settle-dialog')).indexOf('必须同时勾选收入与支出') >= 0,
      'disabled=' + act('settle-submit').disabled + ' cash=' + flat(act('settle-cash')));

    act('settle-entry-9').click();
    await settle(function () { return flat(act('settle-cash')).indexOf('付 ¥600.00') >= 0; }, 5000);
    report('两边都勾：资金流 = 差额 ¥600.00（不是毛额 ¥1400.00）',
      flat(act('settle-cash')).indexOf('¥600.00') >= 0,
      flat(act('settle-cash')));
    report('汇总把毛额拆开写：支出 ¥1000.00 · 收入 ¥400.00（用户要能对上自己的账）',
      flat(act('settle-dialog')).indexOf('支出') >= 0 &&
        flat(act('settle-dialog')).indexOf('¥1000.00') >= 0 &&
        flat(act('settle-dialog')).indexOf('¥400.00') >= 0);
    report('两边都勾后提交按钮恢复可点', act('settle-submit').disabled === false);

    var offsetCountBefore = window.__smokeLedger.settleCount();
    await clickEnabled('[data-act="settle-submit"]', act('settle-dialog'));
    await settle(function () { return !act('settle-dialog'); }, 10000);
    var offPayload = lastCall('ledgerSettleCreate');
    report('互抵请求：direction=offset、两条条目、仍然不带金额',
      offPayload && offPayload.direction === 'offset' &&
        offPayload.entryIds.slice().sort(function (a, b) { return a - b; }).join(',') === '8,9' &&
        !('amountCents' in offPayload),
      JSON.stringify(offPayload));

    await settle(function () {
      var r = document.querySelector(offsetSel);
      return r && flat(r.querySelector('[data-act="ledger-party-unsettled"]')).indexOf('可收 ¥0.00') >= 0;
    }, 8000);
    var offUnsettled = flat(document.querySelector(offsetSel + ' [data-act="ledger-party-unsettled"]'));
    report('互抵后台账两个方向都归零（只减净额会留下"可收 ¥400"的假余额，用户会被引导再收一次）',
      offUnsettled.indexOf('可收 ¥0.00') >= 0 && offUnsettled.indexOf('可付 ¥0.00') >= 0,
      offUnsettled);
    report('已结算记的是净额 ¥600.00（毛额 1400 只存在单据里，不进台账）',
      flat(document.querySelector(offsetSel + ' [data-act="ledger-party-settled"]')) === '¥600.00',
      flat(document.querySelector(offsetSel + ' [data-act="ledger-party-settled"]')));
    report('互抵只生成一张单（不是"付一张 + 收一张"两张）',
      window.__smokeLedger.settleCount() === offsetCountBefore + 1,
      'before=' + offsetCountBefore + ' after=' + window.__smokeLedger.settleCount());

    step('errors');
    report('无未捕获错误', (window.__smokeErrors || []).length === 0,
      JSON.stringify(window.__smokeErrors || []));
  } catch (e) {
    lines.push('SMOKE: FAILED at [' + STEP + '] - ' + (e && e.message ? e.message : String(e)));
  }
  finish();
}

function catRow(name) {
  var rows = all('[data-act^="cat-list-"] li[data-cat-id]');
  for (var i = 0; i < rows.length; i++) if (flat(rows[i]).indexOf(name) >= 0) return rows[i];
  return null;
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
  { mode: 'full', size: '1440,900', budget: 120000, label: '全量断言（宽 1440）' },
  { mode: 'narrow', size: '900,800', budget: 90000, label: '窄视口堆叠守卫（900×800）' },
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
console.log(ok ? '\n✓ 记账页冒烟通过（宽 + 窄，共两遍）' : '\n✗ 记账页冒烟失败');
process.exit(ok ? 0 : 1);
