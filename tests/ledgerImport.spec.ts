// 记账批量导入的解析与校验单测（`src/lib/ledgerImport.ts`）。
//
// 这组用例盯的不是"分摊算得对不对"（那是 `ledger.spec.ts` 的活），而是**导入这条路独有的四个失效面**：
//   ① 列认错：`分摊店铺` 被 `店铺` 抢走 → 一笔公共支出只落到第一家店头上，而合计仍然对得上（守恒断言抓不到）；
//   ② 值猜错：日期把美式 `10/01/2026` 当成 10 月 1 日或 1 月 10 日、金额把 `1.005` 取整却**不吭声** → 钱进错月份/悄悄多几厘；
//   ③ 名字静默失联：对不上就"当没这个人"或"挑一个最像的" → 往来台账从此挂在别人账上；
//   ④ 摊钱用了半份数据：营收取数被截断还照摊 → 各店占比全是假的。
// 所以断言一律**钉到具体那一行的具体那个数/具体那句话**，不写"有报错就行"（恒绿的断言等于没有）。
import { describe, it, expect } from 'vitest';
import {
  LEDGER_IMPORT_COLUMNS,
  LEDGER_TEMPLATE_COLUMNS,
  LEDGER_IMPORT_MAX_ROWS,
  buildLedgerImportPayload,
  buildLedgerTemplateSheets,
  collectImportNameLookups,
  collectImportPeriodNeeds,
  ledgerEntryFingerprint,
  ledgerEntryFingerprintsFromRows,
  pickableImportRowNos,
  parseImportAllocCell,
  parseImportAmountCell,
  parseImportDateCell,
  parseLedgerImportRows,
  pickLedgerImportSheet,
  resolveLedgerImportRows,
  type LedgerImportContext,
  type LedgerImportRowResult,
  type LedgerImportSheet,
  type LedgerRefResolution,
} from '../src/lib/ledgerImport';
import type { LedgerRevenue } from '../src/lib/ledgerRevenue';
import { parseYuanToCents } from '../src/lib/ledger';
// 名字冲突：本文件里的 `ref` 是"一条名字解析结果"的工厂函数，Vue 的那个改名导入
import { ref as vueRef } from 'vue';
import type { LedgerEntryRow, LedgerKind } from '../src/types';

/** 模板的十个可填列（用例里的行都按这个顺序摆） */
const HEADER = [
  '发生日期*',
  '方向*',
  '金额(元)*',
  '相关人*',
  '科目',
  '店铺',
  '分摊店铺',
  '分摊基准',
  '归属',
  '备注',
];

const ref = (
  id: number,
  name: string,
  state: LedgerRefResolution['state'] = 'ok',
  kind?: LedgerKind,
  status?: string,
): LedgerRefResolution => ({ id, name, state, kind: kind ?? '', status: status ?? '' });

/** 一条合格的专属支出行（后面各用例在它上面只改被测的那一格） */
const SHOP_ROW = ['2026-10-01', '支出', '1200.50', '房东老王', '房租', 'AE 旗舰店', '', '', '', '十月房租'];

/** `SHOP_ROW` 解析后应当落库的那笔账（查重用例的两个方向共用它，避免两处各写一份数） */
const SHOP_FP_INPUT = {
  bizDate: '2026-10-01',
  kind: 'expense' as LedgerKind,
  amountCents: 120050,
  partyId: 1,
  categoryId: 11,
  scope: 'shop' as const,
  shopId: 101,
  note: '十月房租',
  allocations: [{ shopId: 101, amountCents: 120050, ratioBp: 10000 }],
};

const revenueOf = (byShopId: Record<number, number>, truncated = false): LedgerRevenue => {
  const assigned = Object.values(byShopId).reduce((s, n) => s + n, 0);
  return {
    byShopId,
    assignedTotalCents: assigned,
    totalCents: assigned,
    unmatched: [],
    unmatchedTotalCents: 0,
    unassignedCents: 0,
    excludedClosedRows: 0,
    missingRevenueRows: 0,
    truncated,
  };
};

/** 默认引用表：三种"对不上"的状态各留一个样本，且店名 101/102 的 id 顺序与名字顺序相反（防"按顺序取第一个"） */
function baseContext(over: Partial<LedgerImportContext> = {}): LedgerImportContext {
  return {
    refs: {
      party: {
        房东老王: ref(1, '房东老王'),
        某供应商: ref(2, '某供应商'),
        离职会计: ref(3, '离职会计', 'archived'),
        重名的人: ref(0, '重名的人', 'ambiguous'),
      },
      category: {
        房租: ref(11, '房租', 'ok', 'expense'),
        货款: ref(12, '货款', 'ok', 'income'),
        旧科目: ref(13, '旧科目', 'archived', 'expense'),
      },
      shop: {
        'AE 旗舰店': ref(101, 'AE 旗舰店', 'ok', undefined, 'active'),
        'AE 二店': ref(102, 'AE 二店', 'ok', undefined, 'active'),
        // 退店：状态 exited 但 state 仍是 ok（参与分摊），措辞上不许被当成"不能摊钱"
        退店的店: ref(104, '退店的店', 'ok', undefined, 'exited'),
        已关张的店: ref(103, '已关张的店', 'archived', undefined, 'archived'),
        封了的店: ref(105, '封了的店', 'archived', undefined, 'banned'),
        同名店: ref(0, '同名店', 'ambiguous'),
      },
    },
    eligibleByPeriod: { '2026-10': [101, 102] },
    revenue: { byPeriod: { '2026-10': revenueOf({ 101: 30000, 102: 10000 }) } },
    shopNameById: { 101: 'AE 旗舰店', 102: 'AE 二店', 103: '已关张的店', 104: '退店的店', 105: '封了的店' },
    ...over,
  };
}

/** 走完整三段流水线（选表 → 取值 → 校验），返回逐行结果 */
function runOnce(rows: unknown[][], over: Partial<LedgerImportContext> = {}, header: string[] = HEADER) {
  const sheet: LedgerImportSheet = { name: '明细', grid: [header, ...rows] };
  const picked = pickLedgerImportSheet([sheet]);
  expect(picked.picked, `表头没认出来：${picked.scanned.join(' | ')}`).not.toBeNull();
  const parsed = parseLedgerImportRows(sheet, picked.picked!);
  const ctx = baseContext(over);
  return {
    scan: picked.picked!,
    parsed,
    results: resolveLedgerImportRows(parsed.rows, ctx),
  };
}

const only = (rows: unknown[][], over: Partial<LedgerImportContext> = {}, header: string[] = HEADER) =>
  runOnce(rows, over, header).results[0];

describe('① 选表与列表头', () => {
  it('「分摊店铺」不被「店铺」抢走（含子串的长族先分配）', () => {
    const { scan } = runOnce([SHOP_ROW]);
    expect(scan.columns.shop).toBe(5);
    expect(scan.columns.allocShops).toBe(6);
    expect(scan.columns.bizDate).toBe(0);
    expect(scan.columns.settle).toBe(-1); // 这份文件没有结算列
  });

  it('只有一列「共同分摊店铺」（没有独立「店铺」列）时仍归分摊族', () => {
    // 这条钉的是**分配顺序**：两族都只能按"包含"命中同一列时，先分配的是分摊族。
    // 反过来（店铺族先）不会报错、只会把公共支出静默落成"第一家店全额"，而合计仍然对得上。
    const h = [...HEADER];
    h[5] = '';
    h[6] = '共同分摊店铺';
    const row = [...SHOP_ROW];
    row[5] = '';
    row[6] = 'AE 旗舰店、AE 二店';
    const { scan, results } = runOnce([row], {}, h);
    expect(scan.columns.allocShops).toBe(6);
    expect(scan.columns.shop).toBe(-1);
    const r = results[0];
    expect(r.errors.join()).toBe('');
    expect(r.input.scope).toBe('shared');
    expect(r.allocations.map((a) => a.shopId)).toEqual([101, 102]);
    expect(r.allocations.reduce((s, a) => s + a.amountCents, 0)).toBe(r.input.amountCents);
  });

  it('「归属店铺」算店铺列，不会被「归属」那一族抢走', () => {
    const h = [...HEADER];
    h[5] = '归属店铺';
    const { scan } = runOnce([SHOP_ROW], {}, h);
    expect(scan.columns.shop).toBe(5);
    expect(scan.columns.scope).toBe(8); // 独立的「归属」列仍在原位，两者各归各
    // 摘掉真正的「归属」列后，含「归属」二字的店铺列依然归店铺 —— 证明不是"谁先抢到算谁的"
    const h2 = [...h];
    h2[8] = '';
    const r2 = runOnce([SHOP_ROW], {}, h2);
    expect(r2.scan.columns.shop).toBe(5);
    expect(r2.scan.columns.scope).toBe(-1);
  });

  it('表头带必填星号与括号注记都能认（金额(元)* → 金额）', () => {
    const { scan } = runOnce([SHOP_ROW], {}, HEADER);
    expect(scan.headers.length).toBe(HEADER.length);
    expect(scan.qualified).toBe(true);
  });

  it('多张表时取数据行最多的那张，而不是第一张', () => {
    const sheets: LedgerImportSheet[] = [
      { name: '填写说明', grid: [['列', '必填', '怎么填'], ['发生日期', '必填', '填 2026-10-01']] },
      { name: '汇总', grid: [HEADER, SHOP_ROW] },
      { name: '明细', grid: [HEADER, SHOP_ROW, SHOP_ROW, SHOP_ROW] },
    ];
    const picked = pickLedgerImportSheet(sheets);
    expect(picked.picked?.sheetName).toBe('明细');
    expect(picked.picked?.dataRows).toBe(3);
    // 落选的每一张都要有"为什么不算"的结论（用户要靠它判断软件到底看过哪些表）
    expect(picked.scanned.some((s) => s.startsWith('填写说明：'))).toBe(true);
  });

  it('表头前面有标题行也能找到，且行号按 Excel 真实行号报', () => {
    const sheet: LedgerImportSheet = { name: '明细', grid: [['某某银行流水'], HEADER, SHOP_ROW] };
    const picked = pickLedgerImportSheet([sheet]);
    expect(picked.picked?.headerRow).toBe(1);
    const parsed = parseLedgerImportRows(sheet, picked.picked!);
    expect(parsed.rows[0].rowNo).toBe(3);
  });

  it('只有日期 + 金额的两列流水不算账单表（缺"谁/哪家店"这一维）', () => {
    const picked = pickLedgerImportSheet([
      { name: 'Sheet1', grid: [['日期', '金额'], ['2026-10-01', '100']] },
    ]);
    expect(picked.picked).toBeNull();
    expect(picked.scanned[0]).toContain('没凑齐');
  });

  it('空表给的结论不是"前 0 行"', () => {
    const picked = pickLedgerImportSheet([{ name: '空', grid: [] }]);
    expect(picked.scanned[0]).toContain('这张表是空的');
  });
});

describe('② 单元格语法', () => {
  it('日期：四种写法汇到同一个 YYYY-MM-DD', () => {
    for (const raw of ['2026-10-01', '2026/10/1', '2026.10.1', '2026年10月1日', ' 2026-10-01 08:30:00 ']) {
      expect(parseImportDateCell(raw), raw).toEqual({ text: '2026-10-01', error: '' });
    }
  });

  it('日期：Excel 序列号与 8 位数字都认', () => {
    // 2026-10-01 = 自 1899-12-30 起第 46296 天
    expect(parseImportDateCell(46296).text).toBe('2026-10-01');
    expect(parseImportDateCell(46296.75).text).toBe('2026-10-01'); // 带时间的小数序列号
    expect(parseImportDateCell(20261001).text).toBe('2026-10-01');
    expect(parseImportDateCell('20261001').text).toBe('2026-10-01');
  });

  it('日期：月/日在前的写法**不猜**（猜错会把钱记到别的月份）', () => {
    const r = parseImportDateCell('10/01/2026');
    expect(r.text).toBe('');
    expect(r.error).toContain('看不懂');
  });

  it('日期：不存在的日子、只到月、离谱数字各有明确说法', () => {
    expect(parseImportDateCell('2026-02-30').error).toContain('看不懂');
    expect(parseImportDateCell('2026-10').error).toContain('每笔账要落到具体那天');
    expect(parseImportDateCell(12345).error).toContain('不像日期');
    expect(parseImportDateCell('').text).toBe('');
    expect(parseImportDateCell('').error).toBe(''); // 空值不是语法错，交给"必填"判定
  });

  it('金额：数字格与文本格两条路都汇到"整数分"', () => {
    expect(parseImportAmountCell(1200.5)).toEqual({ cents: 120050, error: '', rounded: '' });
    expect(parseImportAmountCell('¥1,200.50')).toEqual({ cents: 120050, error: '', rounded: '' });
    expect(parseImportAmountCell('1200')).toEqual({ cents: 120000, error: '', rounded: '' });
    // 尾零不是"取整"，不该念一句废话
    expect(parseImportAmountCell('1200.500').rounded).toBe('');
  });

  it('金额：超过两位小数自动保留两位（四舍五入），并逐行念出改了值', () => {
    // 数字格与文本格**同一结论**：Excel 里 1.005 与手打文本 "1.005" 不能进成两个数
    const num = parseImportAmountCell(1.005);
    expect(num.cents).toBe(101);
    expect(num.error).toBe('');
    expect(num.rounded).toContain('1.005');
    expect(num.rounded).toContain('1.01');
    const text = parseImportAmountCell('1.005');
    expect(text.cents).toBe(101);
    expect(text.rounded).toContain('1.01');
    // 十进制位半进一，不碰浮点（1.005*100 = 100.49999999999999）
    expect(parseImportAmountCell('1200.5678').cents).toBe(120057);
    expect(parseImportAmountCell(1200.5678).cents).toBe(120057);
    expect(parseImportAmountCell('0.999').cents).toBe(100); // 进位到 1.00
    expect(parseImportAmountCell('1.0049').cents).toBe(100); // 第三位 4 → 舍
  });

  it('金额：两位以内与「记一笔」同一结论（两条路不许漂移）', () => {
    for (const s of ['1200', '1200.5', '1200.50', '0.01', '1,234.56', '¥1234']) {
      expect(parseImportAmountCell(s).cents).toBe(parseYuanToCents(s));
      expect(parseImportAmountCell(s).rounded).toBe('');
    }
  });

  it('金额：取整后成 0 说的是"太小"而不是"没填"', () => {
    const r = parseImportAmountCell('0.004');
    expect(r.cents).toBe(0);
    expect(r.error).toContain('保留两位小数后是 0.00');
    expect(r.error).not.toContain('必填');
  });

  it('金额：负数单独说明（方向由「方向」列决定，静默取绝对值会掩盖填错）', () => {
    expect(parseImportAmountCell(-100).error).toContain('请填正数');
    expect(parseImportAmountCell('-100').error).toContain('请填正数');
    expect(parseImportAmountCell(-1.005).error).toContain('请填正数');
  });

  it('金额：0 与空是两回事，两者都不落库', () => {
    expect(parseImportAmountCell(0).error).toBe('金额必须大于 0');
    expect(only([['2026-10-01', '支出', '', '房东老王']]).errors).toContain('金额必填');
    expect(only([['2026-10-01', '支出', '0', '房东老王']]).ok).toBe(false);
  });

  it('金额取整只提醒、不拦行：这行仍然默认勾选（要的是别卡住导入）', () => {
    const r = only([['2026-10-01', '支出', '1200.5678', '房东老王', '', 'AE 旗舰店']]);
    expect(r.ok).toBe(true);
    expect(r.selected).toBe(true);
    expect(r.amountCents).toBe(120057);
    expect(r.amountRounded).toBe(true);
    expect(r.warnings.join()).toContain('1200.57');
    expect(r.errors).toEqual([]);
  });

  it('方向：认收入/支出各种写法，认不出报错（方向反了整批符号都反）', () => {
    expect(parseImportDateCell('x').text).toBe('');
    expect(only([['2026-10-01', '收入', '10', '房东老王']]).input.kind).toBe('income');
    expect(only([['2026-10-01', '支出', '10', '房东老王']]).input.kind).toBe('expense');
    expect(only([['2026-10-01', '进账', '10', '房东老王']]).input.kind).toBe('income');
    expect(only([['2026-10-01', '转账', '10', '房东老王']]).errors.join()).toContain('方向「转账」看不懂');
  });

  it('没有「方向」列时，报错说的是"文件缺列"而不是"这行没填"', () => {
    const h = [...HEADER];
    h[1] = '类别'; // 不再命中方向族
    const r = only([SHOP_ROW], {}, h);
    expect(r.errors.join()).toContain('这份文件没有「方向」列');
  });

  it('归属与分摊基准认不出都报错，不回落默认', () => {
    expect(only([['2026-10-01', '支出', '10', '房东老王', '', 'AE 旗舰店', '', '', '随便', '']]).errors.join()).toContain(
      '归属「随便」看不懂',
    );
    expect(only([['2026-10-01', '支出', '10', '房东老王', '', '', 'AE 旗舰店', '按比例分摊']]).errors.join()).toContain(
      '分摊基准「按比例分摊」看不懂',
    );
  });
});

describe('③ 分摊店铺文法', () => {
  it('分隔符：、 , ; | / 都切；**空白不切**（店名本身带空格）', () => {
    const r = parseImportAllocCell('AE 旗舰店、AE 二店/AE 三店;AE 四店,AE 五店|AE 六店');
    expect(r.errors).toEqual([]);
    expect(r.tokens).toHaveLength(6);
    expect(r.tokens.map((t) => t.shop)).toEqual([
      'AE 旗舰店',
      'AE 二店',
      'AE 三店',
      'AE 四店',
      'AE 五店',
      'AE 六店',
    ]);
  });

  it('百分比：带 % 或不带都收，非法比例报错且不进 token', () => {
    const ok = parseImportAllocCell('AE 旗舰店=60%、AE 二店=40');
    expect(ok.hasPct).toBe(true);
    expect(ok.tokens.map((t) => t.pct)).toEqual([60, 40]);
    const bad = parseImportAllocCell('AE 旗舰店=abc');
    expect(bad.errors.join()).toContain('比例不合法');
    expect(bad.tokens).toHaveLength(0);
    expect(parseImportAllocCell('=60%').errors.join()).toContain('缺少店名');
  });

  it('一半带比例、一半不带 → 报错（不替用户猜"没写的平分剩下的"）', () => {
    const r = parseImportAllocCell('AE 旗舰店=60%、AE 二店');
    expect(r.errors.join()).toContain('混着写');
  });

  it('「全部」是一个 token，不是一家叫"全部"的店', () => {
    const r = parseImportAllocCell('全部');
    expect(r.tokens).toEqual([{ raw: '全部', shop: '', pct: null, all: true, error: '' }]);
  });

  it('只有分隔符没有店名 → 报错而不是静默空', () => {
    expect(parseImportAllocCell('、、').errors.join()).toContain('没有店名');
  });
});

describe('④ 名字对 id：相关人/科目缺失自动建，店铺必须已登记', () => {
  it('相关人库里没有 → 不报错，带着名字等落库时新建', () => {
    const r = only([['2026-10-01', '支出', '10', '房东 老王', '', 'AE 旗舰店']]);
    expect(r.errors).toEqual([]);
    expect(r.ok).toBe(true);
    expect(r.newParty).toBe('房东 老王');
    expect(r.input.partyId).toBe(0);
    expect(r.input.partyName).toBe('房东 老王');
  });

  it('已停用 / 同名多条 仍然报错（那不是"没有"，新建只会掩盖真问题）', () => {
    expect(only([['2026-10-01', '支出', '10', '离职会计']]).errors.join()).toContain('已停用');
    expect(only([['2026-10-01', '支出', '10', '重名的人']]).errors.join()).toContain('匹配到多条');
    expect(only([['2026-10-01', '支出', '10', '']]).errors.join()).toContain('相关人必填');
    expect(only([SHOP_ROW]).ok).toBe(true);
  });

  it('相关人存在时，落库用的是 id，展示用的是库里登记的名字', () => {
    const r = only([['2026-10-01', '支出', '10', '房东老王']]);
    expect(r.input.partyId).toBe(1);
    expect(r.input.partyName).toBeUndefined();
    expect(r.newParty).toBe('');
    expect(r.partyText).toBe('房东老王');
  });

  it('科目留空 = 不分类（合法）；库里没有就新建；方向不匹配仍然报错', () => {
    const blank = only([['2026-10-01', '支出', '10', '房东老王', '', 'AE 旗舰店']]);
    expect(blank.input.categoryId).toBe(0);
    expect(blank.newCategory).toBe('');

    const fresh = only([['2026-10-01', '支出', '10', '房东老王', '水电', 'AE 旗舰店']]);
    expect(fresh.errors).toEqual([]);
    expect(fresh.newCategory).toBe('水电');
    expect(fresh.input.categoryId).toBe(0);
    expect(fresh.input.categoryName).toBe('水电');

    expect(only([['2026-10-01', '收入', '10', '房东老王', '房租', '', 'AE 旗舰店']]).errors.join()).toContain(
      '是支出科目',
    );
    expect(only([['2026-10-01', '支出', '10', '房东老王', '旧科目', 'AE 旗舰店']]).errors.join()).toContain('已停用');
  });

  it('店名对不上时报的是"文件里的写法"，并指路去哪儿改（店铺不新建）', () => {
    expect(only([['2026-10-01', '支出', '10', '房东老王', '', '不存在的店']]).errors.join()).toContain(
      '「基础数据 › 店铺」',
    );
    expect(only([['2026-10-01', '支出', '10', '房东老王', '', '同名店']]).errors.join()).toContain('多家店');
  });

  it('退店的店照样能摊、能专属；停用与封店不行且说法不同', () => {
    const own = only([['2026-10-01', '支出', '10', '房东老王', '', '退店的店']]);
    expect(own.errors).toEqual([]);
    expect(own.input.shopId).toBe(104);

    const shared = only([['2026-10-01', '支出', '10', '房东老王', '', '', '退店的店']]);
    expect(shared.errors).toEqual([]);
    expect(shared.allocations.map((a) => a.shopId)).toEqual([104]);

    expect(only([['2026-10-01', '支出', '10', '房东老王', '', '', '已关张的店']]).errors.join()).toContain('已停用');
    expect(only([['2026-10-01', '支出', '10', '房东老王', '', '', '封了的店']]).errors.join()).toContain('已封店');
  });
});

describe('④b 待新建的名字参与查重', () => {
  it('同一天同金额、相关人一个在库一个待建 → 不是同一笔（id 都是 0 会误判成重复）', () => {
    const { results } = runOnce([
      ['2026-10-01', '支出', '10', '房东老王', '', 'AE 旗舰店'],
      ['2026-10-01', '支出', '10', '新人甲', '', 'AE 旗舰店'],
    ]);
    expect(results[1].duplicate).toBe(false);
    expect(results[1].selected).toBe(true);
  });

  it('两行全同（同名待建）→ 第二行判重复并默认不勾', () => {
    const { results } = runOnce([
      ['2026-10-01', '支出', '10', '新人甲', '', 'AE 旗舰店'],
      ['2026-10-01', '支出', '10', '新人甲', '', 'AE 旗舰店'],
    ]);
    expect(results[1].duplicate).toBe(true);
    expect(results[1].selected).toBe(false);
    expect(results[1].warnings.join()).toContain('第 2 行'); // 行号是 Excel 真实行号：表头第 1 行
  });

  it('待建名字进得了落库入参（partyId 0 + partyName），库里已有的不带名字', () => {
    const { results } = runOnce([
      ['2026-10-01', '支出', '10', '新人甲', '新科目', 'AE 旗舰店'],
      ['2026-10-02', '支出', '20', '房东老王', '房租', 'AE 旗舰店'],
    ]);
    const payload = buildLedgerImportPayload(results);
    expect(payload[0].partyId).toBe(0);
    expect(payload[0].partyName).toBe('新人甲');
    expect(payload[0].categoryId).toBe(0);
    expect(payload[0].categoryName).toBe('新科目');
    expect(payload[1].partyName).toBeUndefined();
    expect(payload[1].categoryName).toBeUndefined();
  });
});

describe('⑤ 归属推导（专属 / 公共互斥）', () => {
  it('只填店铺 → 专属；分摊由主进程写单行全额，本层只为逐笔展示合成它', () => {
    const r = only([SHOP_ROW]);
    expect(r.input.scope).toBe('shop');
    expect(r.input.shopId).toBe(101);
    expect(r.input.allocations).toBeUndefined();
    expect(r.allocations).toEqual([{ shopId: 101, shopName: 'AE 旗舰店', amountCents: 120050, ratioBp: 10000 }]);
    expect(r.scopeText).toBe('专属');
  });

  it('只填分摊店铺 → 公共，落库不带 shopId', () => {
    const r = only([['2026-10-02', '支出', '100', '房东老王', '', '', 'AE 旗舰店、AE 二店']]);
    expect(r.input.scope).toBe('shared');
    expect(r.input.shopId).toBe(0);
    expect(r.input.basis).toBe('equal');
    expect(r.basisInferred).toBe(true);
    expect(r.input.allocations).toEqual([
      { shopId: 101, amountCents: 5000, ratioBp: 5000 },
      { shopId: 102, amountCents: 5000, ratioBp: 5000 },
    ]);
  });

  it('两列都填 / 都不填 → 报错（两个来源会互相 competing）', () => {
    expect(only([['2026-10-01', '支出', '10', '房东老王', '', 'AE 旗舰店', 'AE 二店']]).errors.join()).toContain(
      '同时填了',
    );
    expect(only([['2026-10-01', '支出', '10', '房东老王']]).errors.join()).toContain('至少要填一个');
  });

  it('「归属」列与推导结果冲突时报错，一致时放行', () => {
    expect(only([['2026-10-01', '支出', '10', '房东老王', '', 'AE 旗舰店', '', '', '公共']]).errors.join()).toContain(
      '但填的是「店铺」',
    );
    expect(only([['2026-10-01', '支出', '10', '房东老王', '', '', 'AE 旗舰店、AE 二店', '', '公共']]).ok).toBe(true);
  });
});

describe('⑥ 分摊：基准、权重、守恒', () => {
  it('手工比例：百分比直接换算成分，尾差按最大余数法落', () => {
    const r = only([['2026-10-02', '支出', '100', '房东老王', '', '', 'AE 旗舰店=60%、AE 二店=40%']]);
    expect(r.input.basis).toBe('manual');
    expect(r.basisText).toBe('手工比例');
    expect(r.allocations.map((a) => a.amountCents)).toEqual([6000, 4000]);
  });

  it('比例合计不是 100% → 用引擎原文报错，不自动补齐', () => {
    const r = only([['2026-10-02', '支出', '100', '房东老王', '', '', 'AE 旗舰店=60%、AE 二店=30%']]);
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('还差 10.00 个百分点');
  });

  it('显式基准与百分比互相矛盾时报错（写平均却带百分比 = 手工）', () => {
    expect(
      only([['2026-10-02', '支出', '100', '房东老王', '', '', 'AE 旗舰店=60%、AE 二店=40%', '平均分摊']]).errors.join(),
    ).toContain('平均分摊');
    expect(
      only([['2026-10-02', '支出', '100', '房东老王', '', '', 'AE 旗舰店、AE 二店', '手工比例']]).errors.join(),
    ).toContain('没写百分比');
  });

  it('按营收占比：权重取宿主算好的营收，3:1 的营收摊出 75/25', () => {
    const r = only([['2026-10-02', '支出', '100', '房东老王', '', '', 'AE 旗舰店、AE 二店', '按营收占比']]);
    expect(r.input.basis).toBe('revenue');
    expect(r.allocations.map((a) => a.amountCents)).toEqual([7500, 2500]);
  });

  it('按营收占比但取数被截断 → 整行拒（半份数据算出来的占比会把钱摊错）', () => {
    const r = only(
      [['2026-10-02', '支出', '100', '房东老王', '', '', 'AE 旗舰店、AE 二店', '按营收占比']],
      { revenue: { byPeriod: { '2026-10': revenueOf({ 101: 30000, 102: 10000 }, true) } } },
    );
    expect(r.ok).toBe(false);
    expect(r.errors.join()).toContain('截断');
  });

  it('按营收占比但当期各店都零营收 → 回落平均并逐行说明', () => {
    const r = only(
      [['2026-10-02', '支出', '100', '房东老王', '', '', 'AE 旗舰店、AE 二店', '按营收占比']],
      { revenue: { byPeriod: { '2026-10': revenueOf({}) } } },
    );
    expect(r.ok).toBe(true);
    expect(r.input.basis).toBe('equal');
    expect(r.warnings.join()).toContain('已改按平均分摊');
  });

  it('「全部」按当期可摊店铺展开；没有可摊店铺时报错而不是摊给 0 家', () => {
    const r = only([['2026-10-02', '支出', '100', '房东老王', '', '', '全部']]);
    expect(r.allocations.map((a) => a.shopId)).toEqual([101, 102]);
    expect(
      only([['2026-10-02', '支出', '100', '房东老王', '', '', '全部']], { eligibleByPeriod: {} }).errors.join(),
    ).toContain('当期店铺没取到');
    expect(
      only([['2026-10-02', '支出', '100', '房东老王', '', '', '全部']], { eligibleByPeriod: { '2026-10': [] } }).errors.join(),
    ).toContain('没有营业中的店铺');
  });

  it('同一家店写两遍 → 报错（两行分摊会被算两次，而界面看着像两家）', () => {
    const r = only([['2026-10-02', '支出', '100', '房东老王', '', '', 'AE 旗舰店、AE 旗舰店']]);
    expect(r.errors.join()).toContain('写了两遍');
  });

  it('停用的店不能被摊钱；同名多店不能猜一家', () => {
    expect(
      only([['2026-10-02', '支出', '100', '房东老王', '', '', '已关张的店、AE 二店']]).errors.join(),
    ).toContain('已停用');
    expect(only([['2026-10-02', '支出', '100', '房东老王', '', '', '同名店']]).errors.join()).toContain('多家店');
  });

  it('一行里前面已报错时不再算分摊（不带半套参与店铺去摊钱）', () => {
    // 相关人"库里没有"已不算错（会新建），所以这里用仍然硬错的「已停用」当第一处错
    const r = only([['2026-10-02', '支出', '100', '离职会计', '', '', 'AE 旗舰店、不存在的店']]);
    expect(r.errors.filter((e) => e.includes('已停用'))).toHaveLength(1); // 只报相关人那一条，不再逐家店铺报
    expect(r.errors.join()).not.toContain('分摊店铺');
    expect(r.allocations).toEqual([]);
    expect(r.input.allocations).toBeUndefined();
  });

  it('守恒：任意金额与任意家数，逐笔合计恒等于条目金额', () => {
    for (const cents of ['0.01', '100.01', '33.33', '99999999.99']) {
      const r = only([['2026-10-02', '支出', cents, '房东老王', '', '', 'AE 旗舰店、AE 二店、全部']]);
      const sum = r.allocations.reduce((s, a) => s + a.amountCents, 0);
      expect(sum, cents).toBe(Math.round(Number(cents) * 100));
    }
  });
});

describe('⑦ 重复录入识别', () => {
  it('文件内两行完全相同 → 第二行标疑似重复且默认不勾选', () => {
    const { results } = runOnce([SHOP_ROW, [...SHOP_ROW]]);
    expect(results[0].duplicate).toBe(false);
    expect(results[0].selected).toBe(true);
    expect(results[1].duplicate).toBe(true);
    expect(results[1].selected).toBe(false);
    // rowNo 是 Excel 里的真实行号（表头占第 1 行），用户对着文件找的就是这个号
    expect(results[1].warnings.join()).toContain('第 2 行');
    expect(results[1].ok).toBe(true); // 是"疑似重复"，不是"这行有错"
  });

  it('库里已有同样的账 → 命中指纹，判据与文件内部共用同一个函数', () => {
    const first = only([SHOP_ROW]);
    const fromDb = ledgerEntryFingerprint(SHOP_FP_INPUT);
    expect(fromDb).toBe(first.fingerprint);
    const again = only([SHOP_ROW], { knownFingerprints: [fromDb] });
    expect(again.duplicate).toBe(true);
    expect(again.selected).toBe(false);
  });

  it('摊给不同店 = 两笔真账，不算重复', () => {
    const { results } = runOnce([
      ['2026-10-02', '支出', '100', '房东老王', '', '', 'AE 旗舰店、AE 二店'],
      ['2026-10-02', '支出', '100', '房东老王', '', '', 'AE 旗舰店'],
    ]);
    expect(results[0].fingerprint).not.toBe(results[1].fingerprint);
    expect(results[1].duplicate).toBe(false);
  });

  it('备注不同 = 两笔账（备注是用户自己写的区分手段）', () => {
    const { results } = runOnce([SHOP_ROW, [...SHOP_ROW.slice(0, 9), '十月房租（第二次）']]);
    expect(results[1].duplicate).toBe(false);
  });
});

describe('⑦′ 库里已有条目 → 指纹集合（界面取数投影）', () => {
  /** 明细列表的一行（只填指纹会读到的字段，其余按类型补齐） */
  const dbRow = (over: Partial<LedgerEntryRow> = {}): LedgerEntryRow => ({
    id: 1,
    bizDate: '2026-10-01',
    period: '2026-10',
    kind: 'expense',
    scope: 'shop',
    shopId: 101,
    shopName: 'AE 旗舰店',
    partyId: 1,
    partyName: '房东老王',
    partyArchived: false,
    categoryId: 11,
    categoryName: '房租',
    amountCents: 120050,
    basis: 'equal',
    ruleId: 0,
    method: '',
    note: '十月房租',
    status: 'active',
    voidReason: '',
    settled: false,
    settlementId: 0,
    allocCount: 1,
    createdAt: '',
    updatedAt: '',
    ...over,
  });

  it('专属条目：投影出的指纹与解析器给同一笔账算出的完全相同', () => {
    const fromDb = ledgerEntryFingerprintsFromRows([dbRow()]);
    expect(fromDb).toEqual([ledgerEntryFingerprint(SHOP_FP_INPUT)]);
    // 端到端：把这条库里的账交给解析器，同一行必须被判成疑似重复
    const again = only([SHOP_ROW], { knownFingerprints: fromDb });
    expect(again.duplicate).toBe(true);
    expect(again.selected).toBe(false);
  });

  it('作废条目不进集合（作废=这笔账不算了，用户重新记一遍是对的）', () => {
    expect(ledgerEntryFingerprintsFromRows([dbRow({ status: 'void', voidReason: '记错了' })])).toEqual([]);
  });

  it('公共条目：列表带了分摊行才进集合（同额不同摊法不能判成重复）', () => {
    const shared = dbRow({
      scope: 'shared',
      shopId: 0,
      allocCount: 2,
      amountCents: 30000,
      allocations: [
        { shopId: 101, amountCents: 15000, ratioBp: 5000 },
        { shopId: 102, amountCents: 15000, ratioBp: 5000 },
      ],
    });
    const one = ledgerEntryFingerprintsFromRows([shared]);
    expect(one).toHaveLength(1);
    // 同一笔账、换一种摊法（3:7）：指纹必须不同，否则"记了但摊法不同"会被误标重复
    const other = ledgerEntryFingerprintsFromRows([
      { ...shared, allocations: [
        { shopId: 101, amountCents: 9000, ratioBp: 3000 },
        { shopId: 102, amountCents: 21000, ratioBp: 7000 },
      ] },
    ]);
    expect(other).toHaveLength(1);
    expect(other[0]).not.toBe(one[0]);

    // 没带分摊行（未开 includeAllocations）：跳过而不是拿半套字段算 —— 只漏报，不误报
    expect(ledgerEntryFingerprintsFromRows([dbRow({ scope: 'shared', shopId: 0, allocCount: 2 })])).toEqual([]);
    expect(ledgerEntryFingerprintsFromRows([{ ...shared, allocations: [] }])).toEqual([]);
    // 单店条目缺 shopId：无归属，无法构造专属那条"全额分摊"，同样跳过
    expect(ledgerEntryFingerprintsFromRows([dbRow({ shopId: 0 })])).toEqual([]);
  });

  it('端到端：库里有同一笔公共支出 → 第二次导入判「疑似重复」且默认不勾', () => {
    // 房租 / 工资这类公共费用是**按月重复导入**的典型：以前整类被跳过，重复入账后
    // 分摊守恒断言查不出来（两边一起翻倍）、四项体检也全绿
    const row = ['2026-10-02', '支出', '100', '房东老王', '', '', 'AE 旗舰店、AE 二店', '', '公共', '水电'];
    const dbShared = dbRow({
      scope: 'shared',
      shopId: 0,
      allocCount: 2,
      bizDate: '2026-10-02',
      amountCents: 10000,
      note: '水电',
      categoryId: 0,
      allocations: [
        { shopId: 101, amountCents: 5000, ratioBp: 5000 },
        { shopId: 102, amountCents: 5000, ratioBp: 5000 },
      ],
    });
    const fp = ledgerEntryFingerprintsFromRows([dbShared]);
    expect(fp).toHaveLength(1);
    const again = only([row], { knownFingerprints: fp });
    expect(again.duplicate).toBe(true);
    expect(again.selected).toBe(false);
  });

  it('逐行取，坏数据不会让整批查重消失（宿主返回非数组时给空集）', () => {    expect(ledgerEntryFingerprintsFromRows([dbRow(), dbRow({ id: 2, bizDate: '2026-10-05' })])).toHaveLength(2);
    expect(ledgerEntryFingerprintsFromRows(undefined as unknown as LedgerEntryRow[])).toEqual([]);
  });
});

describe('⑦″ 全选只勾「合格且不像重复」的行', () => {
  const r = (rowNo: number, over: Partial<LedgerImportRowResult> = {}): LedgerImportRowResult =>
    ({ rowNo, ok: true, duplicate: false, ...over }) as LedgerImportRowResult;

  it('疑似重复不参与全选（否则去重等于白做）', () => {
    const rows = [r(1), r(2, { duplicate: true }), r(3), r(4, { duplicate: true })];
    expect(pickableImportRowNos(rows)).toEqual([1, 3]);
  });

  it('不合格的行也不参与（勾上也进不了库）', () => {
    expect(pickableImportRowNos([r(1, { ok: false }), r(2)])).toEqual([2]);
  });

  it('没有重复行时行为与"全选所有合格行"一致', () => {
    expect(pickableImportRowNos([r(1), r(2), r(3)])).toEqual([1, 2, 3]);
  });
});

describe('⑧ 取数需求收集 + 提交载荷', () => {
  it('只把文件里真出现过的名字交给宿主查（去重、去空）', () => {
    const { parsed } = runOnce([SHOP_ROW, [...SHOP_ROW], ['2026-10-03', '支出', '1', '某供应商']]);
    const lookups = collectImportNameLookups(parsed.rows);
    expect(lookups.party.sort()).toEqual(['某供应商', '房东老王'].sort());
    expect(lookups.shop).toEqual(['AE 旗舰店']);
    expect(lookups.category).toEqual(['房租']);
  });

  it('只有「全部」与「按营收占比」才要当期数据，且按期间归并', () => {
    const { parsed } = runOnce([
      ['2026-10-02', '支出', '100', '房东老王', '', '', '全部'],
      ['2026-11-02', '支出', '100', '房东老王', '', '', 'AE 旗舰店', '按营收占比'],
      ['2026-12-02', '支出', '100', '房东老王', '', 'AE 旗舰店'],
    ]);
    const needs = collectImportPeriodNeeds(parsed.rows);
    expect(needs.eligiblePeriods).toEqual(['2026-10']);
    expect(needs.revenuePeriods).toEqual(['2026-11']);
  });

  it('载荷只收"勾选且合格"的行，且保持文件顺序（出错时"第 N 行"才对得上）', () => {
    const { results } = runOnce([
      SHOP_ROW,
      ['2026-10-02', '支出', '100', '房东老王', '', '', 'AE 旗舰店、AE 二店'],
      ['2026-10-03', '支出', '', '房东老王'],
      [...SHOP_ROW],
    ]);
    const payload = buildLedgerImportPayload(results);
    expect(payload).toHaveLength(2);
    expect(payload[0].bizDate).toBe('2026-10-01');
    expect(payload[1].bizDate).toBe('2026-10-02');
    // 载荷必须是干净副本：界面后面还会在同一对象上改勾选
    expect(payload[1].allocations).toEqual([
      { shopId: 101, amountCents: 5000, ratioBp: 5000 },
      { shopId: 102, amountCents: 5000, ratioBp: 5000 },
    ]);
  });
});

describe('⑨ 结算列、空行与上限', () => {
  it('认得「结算状态」列，但逐行说明它不生效（导入不产生结算单）', () => {
    const h = [...HEADER];
    h[9] = '结算状态';
    const { scan, results } = runOnce([SHOP_ROW], {}, h);
    expect(scan.columns.settle).toBe(9);
    expect(results[0].warnings.join()).toContain('导入不生效');
    expect(results[0].ok).toBe(true);
  });

  it('整行空跳过（Excel 尾部空行是常态），但不算合格行也不报错', () => {
    const { parsed, results } = runOnce([SHOP_ROW, ['', '', '', '', '', '', '', '', '', '']]);
    expect(parsed.blankRows).toBe(1);
    expect(results).toHaveLength(1);
  });

  it(`超过 ${LEDGER_IMPORT_MAX_ROWS} 行不静默吞掉，而是回传截断数`, () => {
    const many: unknown[][] = [];
    for (let i = 0; i < LEDGER_IMPORT_MAX_ROWS + 3; i++) many.push(SHOP_ROW);
    const { parsed, results } = runOnce(many);
    expect(results).toHaveLength(LEDGER_IMPORT_MAX_ROWS);
    expect(parsed.truncated).toBe(3);
  });
});

describe('⑩ 模板内容（与解析器共用同一份列定义）', () => {
  it('模板只出表头，不塞示例行（示例行被误当数据导进来就是假账）', () => {
    const sheets = buildLedgerTemplateSheets();
    const data = sheets[0];
    expect(data.name).toBe('导入模板');
    expect(data.rows).toHaveLength(1);
    expect(data.rows[0]).toEqual(LEDGER_TEMPLATE_COLUMNS.map((c) => c.label));
  });

  it('「结算状态」列在解析族里，但不出现在模板里', () => {
    expect(LEDGER_IMPORT_COLUMNS.some((c) => c.key === 'settle')).toBe(true);
    expect(LEDGER_TEMPLATE_COLUMNS.some((c) => c.key === 'settle')).toBe(false);
  });

  it('表头名与解析族同源：模板表头原样导回一定认得出', () => {
    const labels = LEDGER_TEMPLATE_COLUMNS.map((c) => c.label);
    const { scan } = runOnce([SHOP_ROW], {}, labels);
    expect(scan.qualified).toBe(true);
    expect(scan.columns.party).toBe(labels.indexOf('相关人*'));
  });

  it('说明表把"相关人/科目自动新建、店铺不新建"和"只新增不改"写在脸上', () => {
    const guide = buildLedgerTemplateSheets()[1].rows.map((r) => r.join('|')).join('\n');
    expect(guide).toContain('自动新建');
    // 店铺是唯一"不新建"的一轴：它是基础数据实体，凭空建半个店比报错更糟
    expect(guide).toContain('店铺必须先登记');
    expect(guide).toContain('不会改动已有的');
    expect(guide).toContain('百分比');
  });

  it('「已有名称」表：没数据时给占位，有数据时逐列铺开（用户靠它对名字）', () => {
    const empty = buildLedgerTemplateSheets()[2];
    expect(empty.rows[1]).toEqual(['（还没有相关人）', '（还没有支出科目）', '（还没有收入科目）', '（还没有店铺）']);
    const filled = buildLedgerTemplateSheets({
      parties: ['房东老王'],
      expenseCategories: ['房租', '水电'],
      shops: ['AE 旗舰店', 'AE 二店', 'AE 三店'],
    })[2];
    expect(filled.rows[1]).toEqual(['房东老王', '房租', '', 'AE 旗舰店']);
    // 四列各自铺开，短的列补空而不是把后面的名字往前挪（挪了就等于名字对不上行）
    expect(filled.rows[2]).toEqual(['', '水电', '', 'AE 二店']);
    expect(filled.rows[3]).toEqual(['', '', '', 'AE 三店']);
  });
});

// IPC 那一层不是普通函数调用：`ipcRenderer.invoke` 走**结构化克隆**，Vue 的 reactive proxy
// 一个都克隆不了（真机报错：`An object could not be cloned.`，且发生在"哪一行都没进去"之前，
// 用户看到的只有这一句与业务无关的英文）。这组用例把"结果躺在 ref 里"这个真实状态复刻出来 ——
// 直接调纯函数永远是绿的同时，界面一提交就炸，正是这次线上失败的原因。
describe('⑪ 提交入参必须能被结构化克隆（IPC 不接受 Vue 代理）', () => {
  it('结果放在 ref 里时，payload 仍能 structuredClone', () => {
    const rows = vueRef(
      runOnce([
        SHOP_ROW,
        ['2026-10-02', '支出', '100', '房东老王', '', '', 'AE 旗舰店、AE 二店', '', '公共', '水电'],
      ]).results,
    );
    // 界面里就是这条路径：先按勾选状态重排，再交给 payload 构造
    const payload = buildLedgerImportPayload(rows.value.map((r) => ({ ...r, selected: true })));
    expect(payload).toHaveLength(2);
    expect(() => structuredClone(payload)).not.toThrow();
    // 分摊行也得是真值：它的元素同样是代理，只把外层数组拷出来是没用的
    const alloc = payload[1].allocations ?? [];
    expect(alloc.length).toBeGreaterThan(0);
    for (const a of alloc) {
      expect(typeof a.shopId).toBe('number');
      expect(typeof a.amountCents).toBe('number');
      expect(typeof a.ratioBp).toBe('number');
    }
  });

  it('反向证明：旧写法（浅拷贝代理）确实会被拒 —— 这层不是白加的', () => {
    // 必须是**公共分摊**行：只有它带 `allocations`。专属行的分摊在 `r.allocations`（纯展示）里，
    // `input` 只有标量 —— 也就是说"只导专属行"时旧写法碰巧能过，一旦有公共支出就整批炸。
    const rows = vueRef(
      runOnce([['2026-10-02', '支出', '100', '房东老王', '', '', 'AE 旗舰店、AE 二店', '', '公共', '水电']]).results,
    );
    const shallow = rows.value.map((r) => ({
      ...r.input,
      allocations: r.input.allocations ? [...r.input.allocations] : undefined,
    }));
    expect(() => structuredClone(shallow)).toThrow(/could not be cloned/i);
  });
});

// ---------------------------------------------------------------------------
// ⑧ 列级错误与行号（审查 §5-6）
// ---------------------------------------------------------------------------
describe('⑧ 缺「相关人」列说一句，不要逐行刷屏；行号是 Excel 行号', () => {
  /** 没有「相关人」列，但有「店铺」—— 这样的表仍然算合格表（qualifies 只看 日期+金额+(相关人|店铺|分摊)） */
  const NO_PARTY_HEADER = ['发生日期*', '方向*', '金额(元)*', '科目', '店铺', '备注'];

  it('整列缺失 → 一条列级错误，且逐行不再重复同一句话', () => {
    const { parsed, results } = runOnce(
      [
        ['2026-10-01', '支出', '10', '房租', 'AE 旗舰店', ''],
        ['2026-10-02', '支出', '20', '房租', 'AE 旗舰店', ''],
        ['2026-10-03', '支出', '30', '房租', 'AE 旗舰店', ''],
      ],
      {},
      NO_PARTY_HEADER
    );
    expect(parsed.columnErrors).toHaveLength(1);
    expect(parsed.columnErrors[0]).toContain('没有「相关人」列');
    // 关键：三行不能各报一句"相关人必填"，否则用户以为要改三处，而真相是表头少一列
    expect(results.filter((r) => r.errors.some((e) => e.includes('相关人必填')))).toHaveLength(0);
  });

  it('列在、格空着 → 仍逐行报（这是"这一行没填"，不是"表头缺列"）', () => {
    const { parsed, results } = runOnce([
      ['2026-10-01', '支出', '10', '', '房租', 'AE 旗舰店', '', '', '', ''],
      ['2026-10-02', '支出', '20', '', '房租', 'AE 旗舰店', '', '', '', ''],
    ]);
    expect(parsed.columnErrors).toEqual([]);
    expect(results.every((r) => r.errors.some((e) => e.includes('相关人必填')))).toBe(true);
  });

  it('载荷带 Excel 行号：勾选子集后行号不变（否则主进程会报"第 1 行"指向别人的行）', () => {
    const { results } = runOnce([
      ['2026-10-01', '支出', '10', '房东老王', '房租', 'AE 旗舰店', '', '', '', ''],
      ['2026-10-02', '支出', '20', '房东老王', '房租', 'AE 旗舰店', '', '', '', ''],
      ['2026-10-03', '支出', '30', '房东老王', '房租', 'AE 旗舰店', '', '', '', ''],
    ]);
    // 表头第 1 行 ⇒ 数据从第 2 行起
    expect(buildLedgerImportPayload(results).map((r) => r.rowNo)).toEqual([2, 3, 4]);

    const only3rd = results.map((r, i) => ({ ...r, selected: i === 2 }));
    expect(buildLedgerImportPayload(only3rd).map((r) => r.rowNo)).toEqual([4]);
  });
});
