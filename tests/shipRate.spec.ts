// shipRate 单测 —— 物流报价单 → 归一化运价表 → 按克重计价。
//
// 为什么值得单独一组用例（而不是只跑一次手工验证）：
//   这张报价单把 **17 段列结构互不相同的价卡** 拼在同一张 sheet 上（见
//   docs/archive/plans/SHIPPING_RATE_ISLAND_PLAN.md §1），解析器必须"按语义扫描"而不是按固定列号。
//   这类代码的失效方式全是**静默算错**——不抛异常、界面照常出数，只是金额不对。
//   故此处三类断言缺一不可：
//     ① 结构断言（分节数 / 国家数 / 价卡数）——能抓住"某一段整体没被识别"；
//     ② **算法陷阱断言**（回溯越界 / 类别串味 / 档位丢失）——每一条都对应一个真实的错法；
//     ③ 可手算的计价样本——公式错了会直接差 10 倍 / 100 倍。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import {
  DEFAULT_SHEET_HINT,
  normalizeRateSheet,
  pickRateSheet,
  BULK_MAX_G,
  type RateTable,
} from '../src/lib/shipRate';
import {
  applyRounding,
  computeFee,
  formatRange,
  pickCard,
  quoteAll,
} from '../src/lib/shipRateQuote';
import { exceedsByteBudget } from '../src/core/plugin/payloadBudget';

const SHEET = '无忧物流-标准';

/** 入库夹具（生成方式见 tests/fixtures/generate-fixtures.mjs；与源报价单逐格一致） */
function rateSheetRows(): unknown[][] {
  const buf = readFileSync(new URL('./fixtures/shipping-rate.xlsx', import.meta.url));
  const wb = XLSX.read(buf, { type: 'buffer' });
  return XLSX.utils.sheet_to_json(wb.Sheets[SHEET], { header: 1, defval: '' }) as unknown[][];
}

const table: RateTable = normalizeRateSheet(rateSheetRows(), SHEET);
const country = (name: string) => {
  const c = table.countries.find((x) => x.nameCn === name);
  if (!c) throw new Error(`夹具里没有「${name}」`);
  return c;
};

// ─────────────────────────────────────────────────────────── ① 结构

describe('normalizeRateSheet · 真实报价单结构', () => {
  it('识别出 17 个分节 / 184 个国家，且没有告警', () => {
    // 184 = 分节 1 的 144 国 + 其余 16 节的 40 国；**没有任何国家跨节重复**（已逐节比对源表）
    expect(table.stats.sections).toBe(17);
    expect(table.stats.countries).toBe(184);
    expect(table.warnings).toEqual([]);
  });

  it('各分节的国家数与会话中恒定的几节一致', () => {
    const bySec = new Map(table.sections.map((s) => [s.sec, s.countryCount]));
    expect(bySec.get(1)).toBe(144); // 主价卡：占 78%
    expect(bySec.get(8)).toBe(18); // 欧盟组
    expect(bySec.get(15)).toBe(6); // 捷克/芬兰/希腊/匈牙利/荷兰/葡萄牙
    expect(bySec.get(14)).toBe(2); // 马来西亚 / 泰国
    expect(bySec.get(17)).toBe(1); // 摩洛哥
  });

  it('价卡总数 857（791 张 perKg + 66 张 firstStep）', () => {
    expect(table.stats.cards).toBe(857);
    expect(table.stats.perKgCards).toBe(791);
    expect(table.stats.firstStepCards).toBe(66);
    expect(table.stats.perKgCards + table.stats.firstStepCards).toBe(table.stats.cards);
  });

  it('每张价卡的档位区间自洽（minG ≤ maxG，且不超出大包限重）', () => {
    const bad: string[] = [];
    for (const c of table.countries) {
      for (const card of c.cards) {
        if (card.minG > card.maxG) bad.push(`${c.nameCn}: ${card.minG}>${card.maxG}`);
        if (card.maxG > BULK_MAX_G) bad.push(`${c.nameCn}: maxG ${card.maxG}`);
      }
    }
    expect(bad).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────── ② 算法陷阱

describe('normalizeRateSheet · 算法陷阱（每条都对应一种真实的静默错算）', () => {
  it('⚠️ 大包列的档位回溯必须被类别起点截断（否则会继承非普货的 0~2000g）', () => {
    // 分节 1 的版式：D~I 是普货、J~K 是非普货（档位 0~2000g）、L~M 是大包（**无档位**）。
    // 回溯若不被 groupStart 截断，L 列会向左找到 K 列的 "0~2000g(含)"，
    // 于是大包价卡被当成 2000g 档 —— 5kg 的包裹会报"超出档位"，且不报任何错。
    const alb = country('阿尔巴尼亚');
    const bulk = alb.cards.filter((c) => c.categories.includes('bulk'));
    expect(bulk).toHaveLength(1);
    expect(bulk[0].minG).toBe(0);
    expect(bulk[0].maxG).toBe(BULK_MAX_G); // 30000，来自整组的「限重30kg」
    expect(bulk[0].mode).toBe('firstStep');
  });

  it('非普货价卡不得被判成普货（「非普货」三字里含「普货」子串）', () => {
    const alb = country('阿尔巴尼亚');
    expect(alb.cards.filter((c) => c.categories.includes('general'))).toHaveLength(3);
    expect(alb.cards.filter((c) => c.categories.includes('special'))).toHaveLength(1);
    const special = alb.cards.find((c) => c.categories.includes('special'))!;
    expect(special.categories).toEqual(['special']); // 而不是 ['general']
    expect(special.registerFee).toBe(19.8); // 表内 K16=19.8，普货是 18.7
  });

  it('「小包普货&小包非普货计费」合并价卡同时归属两类（韩国）', () => {
    const kr = country('韩国');
    const merged = kr.cards.filter((c) => c.categories.length === 2);
    expect(merged).toHaveLength(2);
    expect(
      merged.every((c) => c.categories.includes('general') && c.categories.includes('special'))
    ).toBe(true);
    expect(merged.map((c) => [c.minG, c.maxG])).toEqual([
      [0, 605],
      [606, 2000],
    ]);
  });

  it('非普货的仓库变体（其他仓 / 香港仓）被保留为 variant，且「计泡」不算变体', () => {
    const ua = country('乌克兰');
    const variants = ua.cards.filter((c) => c.categories.includes('special')).map((c) => c.variant);
    expect(variants.sort()).toEqual(['其他仓', '其他仓', '香港仓']);
    // 大包标题是「大包计费 限重30kg」（无「计泡」）；分节 8 的「大包计费（计泡）」也不得把 计泡 当变体
    const at = country('奥地利');
    expect(at.cards.every((c) => c.variant === '')).toBe(true);
  });

  it('同一国家的「大包」可以是两种模式分档（摩洛哥：0-5000g 按 KG，5000-30000g 首重+续重）', () => {
    const ma = country('摩洛哥');
    const bulk = ma.cards.filter((c) => c.categories.includes('bulk'));
    expect(bulk).toHaveLength(2);
    expect(bulk[0]).toMatchObject({ minG: 0, maxG: 5000, mode: 'perKg', ratePerKg: 141.35 });
    expect(bulk[1]).toMatchObject({
      minG: 5000,
      maxG: 30000,
      mode: 'firstStep',
      firstFee: 351,
      stepFee: 129,
    });
  });

  it('多种价位并存的国家价卡数正确（美国 10 张 / 马来西亚 7 张）', () => {
    expect(country('美国').cards).toHaveLength(10); // 4 普货档 + 4 非普货档 + 2 大包
    expect(country('马来西亚').cards).toHaveLength(7);
  });
});

describe('normalizeRateSheet · 异常输入', () => {
  it('不是报价单的 sheet → 不抛错，返回空表 + 一条说明性告警', () => {
    const r = normalizeRateSheet([['无关表头'], ['x', 'y']], '说明');
    expect(r.countries).toEqual([]);
    expect(r.stats.countries).toBe(0);
    expect(r.warnings.join()).toContain('未找到任何');
  });

  it('空输入 / 非数组输入都不抛错', () => {
    expect(normalizeRateSheet([]).stats.countries).toBe(0);
    expect(normalizeRateSheet(undefined as unknown as unknown[][]).stats.countries).toBe(0);
  });

  it('「暂无服务」是"不提供该类别"，不产生告警', () => {
    // 分节 1 有 101 处「暂无服务」（多为大包）。若当成"数值异常"告警，会把真异常淹没。
    expect(table.warnings.filter((w) => w.includes('暂无服务'))).toEqual([]);
  });

  it('单元格写了非数值的脏数据 → 记告警并丢掉该价卡，而不是静默按 0 计费', () => {
    // 只放一张普货价卡，且费率写成 'abc'：整国因此没有任何可用价卡
    const rows = [
      ['运达国家/地区', '运达国家/地区（英文）', 'Code', '小包普货计费', ''],
      ['', '', '', '0~2000g(含)', ''],
      ['', '', '', '配送服务费 元（RMB）/KG', '挂号服务费 元（RMB）/包裹'],
      ['测试国', 'Testland', 'TL', 'abc', 10],
    ];
    const r = normalizeRateSheet(rows, 'T');
    expect(r.warnings.some((w) => w.includes('配送服务费') && w.includes('abc'))).toBe(true);
    expect(r.countries).toHaveLength(0);
    // 对照：同样的表把费率写成数，就能正常出价 —— 证明上面失败确实是"值脏"而不是"结构没认出来"
    const ok = normalizeRateSheet([...rows.slice(0, 3), ['测试国', 'Testland', 'TL', 60, 10]], 'T');
    expect(ok.warnings).toEqual([]);
    expect(ok.countries[0].cards[0]).toMatchObject({ ratePerKg: 60, registerFee: 10 });
  });
});

// ─────────────────────────────────────────────────────────── ③ 计价

describe('computeFee · 两种模式的公式', () => {
  const alb = country('阿尔巴尼亚');
  const general100 = alb.cards.find(
    (c) => c.minG === 0 && c.maxG === 150 && c.categories.includes('general')
  )!;
  const bulk = alb.cards.find((c) => c.categories.includes('bulk'))!;

  it('perKg：费率 × 克重 ÷ 1000 + 挂号费（209.66 × 100g + 18.7 = 39.67）', () => {
    expect(computeFee(general100, 100).fee).toBe(39.67);
    expect(computeFee(general100, 100).breakdown.delivery).toBeCloseTo(20.966, 6);
  });

  it('perKg：克重为 0 时只收挂号费', () => {
    expect(computeFee(general100, 0).fee).toBe(18.7);
  });

  it('firstStep：不超首重只收首重；超出按每 500g 进位', () => {
    expect(computeFee(bulk, 500).fee).toBe(413.82);
    expect(computeFee(bulk, 501).fee).toBe(applyRounding(413.82 + 170.83));
    expect(computeFee(bulk, 1000).fee).toBe(applyRounding(413.82 + 170.83));
    expect(computeFee(bulk, 1001).fee).toBe(applyRounding(413.82 + 170.83 * 2));
  });

  it('首重+续重跨多档（摩洛哥 10kg = 351 + 19 × 129 = 2802）', () => {
    const ma = country('摩洛哥').cards.find((c) => c.mode === 'firstStep')!;
    expect(computeFee(ma, 10000).fee).toBe(2802);
  });

  it('取整口径：round 四舍五入到分，ceil 向上进位到分', () => {
    expect(applyRounding(39.661)).toBe(39.66);
    expect(applyRounding(39.665)).toBe(39.67);
    expect(applyRounding(39.661, 'ceil')).toBe(39.67);
    expect(applyRounding(39.66, 'ceil')).toBe(39.66); // 整分不该被多进一分
    expect(applyRounding(Number.NaN)).toBe(0);
  });

  it('computeFee 不修改传入的价卡（宿主 op 会跨调用复用同一份运价表）', () => {
    const before = JSON.stringify(general100);
    computeFee(general100, 1234, 'ceil');
    expect(JSON.stringify(general100)).toBe(before);
  });
});

describe('pickCard · 类别自动判定与强制', () => {
  it('≤2kg 自动走普货；>2kg 自动走大包', () => {
    expect(pickCard(country('阿尔巴尼亚'), 100)!.categories).toEqual(['general']);
    expect(pickCard(country('阿尔巴尼亚'), 2000)!.categories).toEqual(['general']);
    expect(pickCard(country('阿尔巴尼亚'), 2001)!.categories).toEqual(['bulk']);
  });

  it('强制类别时只用该类别，命中不到就返回 null（不静默回落）', () => {
    // 美国的分节 4 有普货/非普货/大包，但该国 5kg 的普货档位只到 2kg
    expect(pickCard(country('美国'), 5000, { category: 'general' })).toBeNull();
    expect(pickCard(country('美国'), 5000, { category: 'bulk' })).not.toBeNull();
  });

  it('指定变体但该国没有该变体 → 返回 null，而不是拿别的仓顶替', () => {
    const ua = country('乌克兰');
    expect(pickCard(ua, 100, { category: 'special', variant: '香港仓' })!.variant).toBe('香港仓');
    expect(pickCard(ua, 100, { category: 'special', variant: '不存在的仓' })).toBeNull();
  });

  it('未指定变体时优先取无变体价卡', () => {
    const ua = country('乌克兰');
    // 乌克兰的普货无变体；非普货才分其他仓/香港仓
    expect(pickCard(ua, 100, { category: 'general' })!.variant).toBe('');
  });

  it('合并类别价卡（韩国）在普货与非普货下都能命中同一张', () => {
    const kr = country('韩国');
    const g = pickCard(kr, 100, { category: 'general' })!;
    const s = pickCard(kr, 100, { category: 'special' })!;
    expect(g).toBe(s);
    expect(g.categories).toEqual(['general', 'special']);
  });
});

describe('quoteAll · 一次算全表', () => {
  it('100g：184 国全部有价，按运费升序，最便宜是哈萨克斯坦 8.5 元', () => {
    const rows = quoteAll(table, 100);
    expect(rows).toHaveLength(184);
    expect(rows.filter((r) => !r.ok)).toEqual([]);
    // 手算：表内 KZ 普货 D37=45 元/KG、E37=4 元/包 → 45 × 0.1 + 4 = 8.5
    expect(rows[0].nameCn).toBe('哈萨克斯坦');
    expect(rows[0].fee).toBe(8.5);
    expect(rows[1].nameCn).toBe('马来西亚'); // 18 × 0.1 + 8 = 9.8
    expect(rows[1].fee).toBe(9.8);
    for (let i = 1; i < rows.length; i++)
      expect(rows[i].fee).toBeGreaterThanOrEqual(rows[i - 1].fee);
  });

  it('5kg：小包上限 2kg 后大量国家无大包价 → 无价行排在尾部且给出可用档位', () => {
    const rows = quoteAll(table, 5000);
    const failed = rows.filter((r) => !r.ok);
    expect(failed.length).toBeGreaterThan(0);
    expect(rows.slice(0, rows.length - failed.length).every((r) => r.ok)).toBe(true);
    const f = failed[0];
    expect(f.reason).toContain('无可用运价');
    expect(f.fee).toBe(0);
    expect(f.candidates.length).toBeGreaterThan(0); // 让用户知道该国到底支持哪些重量
  });

  it('报价结果可 JSON 往返（桥是结构化克隆，运价表要经得起序列化）', () => {
    const cloned = JSON.parse(JSON.stringify(table)) as RateTable;
    expect(quoteAll(cloned, 350)).toEqual(quoteAll(table, 350));
  });

  it('formatRange 与档位解析同口径', () => {
    expect(formatRange(0, 150)).toBe('≤150g');
    expect(formatRange(0, 2000)).toBe('≤2kg');
    expect(formatRange(2100, 30000)).toBe('>2.1kg');
    expect(formatRange(150, 300)).toBe('150g–300g');
  });
});

// ─────────────────────────────────────────────────────────── ④ 桥的载荷预算

describe('运价表的载荷规模', () => {
  it('整表能通过 db.call 的载荷预算（否则岛上每次查询都会被预算拦掉）', () => {
    // 用宿主真实的预算函数判定，而不是另写一个"大致够用"的估算
    expect(exceedsByteBudget({ table })).toBe(false);
  });
});

// ─────────────────────────────────────────────────────────── ⑤ 自动选表

/**
 * 整本工作簿的体检结果（等价于宿主 `parseRateSheet` 未点名时做的事）：
 * 逐张 sheet 归一化，连**不可用的也留着**，交给 pickRateSheet 排序。
 */
function scanWorkbook(): {
  sheetNames: string[];
  scans: { sheetName: string; table: RateTable }[];
} {
  const buf = readFileSync(new URL('./fixtures/shipping-rate.xlsx', import.meta.url));
  const wb = XLSX.read(buf, { type: 'buffer' });
  const sheetNames = wb.SheetNames as string[];
  return {
    sheetNames,
    scans: sheetNames.map((name) => ({
      sheetName: name,
      table: normalizeRateSheet(
        XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }) as unknown[][],
        name
      ),
    })),
  };
}

/** 按名取夹具里某张 sheet 的解析结果（含缓存：夹具 200KB+，每组用例都重读会拖慢测试） */
const sheetCache = new Map<string, RateTable>();
function sheetTable(name: string): RateTable {
  const hit = sheetCache.get(name);
  if (hit) return hit;
  const buf = readFileSync(new URL('./fixtures/shipping-rate.xlsx', import.meta.url));
  const wb = XLSX.read(buf, { type: 'buffer' });
  if (!wb.Sheets[name])
    throw new Error(`夹具里没有 sheet「${name}」：${wb.SheetNames.join(' / ')}`);
  const t = normalizeRateSheet(
    XLSX.utils.sheet_to_json(wb.Sheets[name], { header: 1, defval: '' }) as unknown[][],
    name
  );
  sheetCache.set(name, t);
  return t;
}

const firstCountry = (name: string) => {
  const t = sheetTable(name);
  if (!t.countries.length) throw new Error(`「${name}」没解析出任何国家`);
  return t.countries[0];
};

/** 造一个"某张 sheet 的体检结果"：只关心国数与告警，直接从真表复制后改数 */
const fakeScan = (sheetName: string, countries: number, warnings: string[] = []) =>
  ({
    sheetName,
    table: { ...table, sheetName, stats: { ...table.stats, countries }, warnings },
  }) as { sheetName: string; table: RateTable };

describe('pickRateSheet · 自动选表（"读错工作表"曾让导入变成必然失败）', () => {
  // 故障复盘（2026-09-24，用户实测）：导入运价表 → 「未找到任何「运达国家/地区」表头行」。
  // 数据没问题，是**读错了 sheet**：运营商报价单是一本 21 张 sheet 的工作簿，
  // 第 1 张是「目录」，目标表在第 10 张，而旧代码"未点名就取第一个 sheet"。
  // 夹具当时把报价单放在第 1 张，于是这个错误写法在测试里**恒绿**。

  it('夹具复刻了源工作簿结构：报价单不在第一张（否则本组断言会全部恒绿）', () => {
    const { sheetNames, scans } = scanWorkbook();
    expect(sheetNames[0]).toBe('目录');
    // 「无忧物流-特惠」在源文件里就排在目标表之前、且**同样能解析**（23 国）——
    // 有它才能钉住"只取第一张能解析的表"这种写法：只放一张不可用的首表是不够的
    // （不可用的会被过滤掉，排序写错也能蒙对）。
    expect(sheetNames.indexOf('无忧物流-特惠')).toBeLessThan(sheetNames.indexOf(SHEET));
    // 29 = 该 sheet 的 6 个分节全部解析出来（2026-09-25 起）。此前是 23：
    // 后 3 节的类别标题写作「小包计费」（不含普货/非普货/大包），旧实现判成"类别无法识别"
    // 而整节丢掉 —— 西班牙/墨西哥/瑞典/丹麦/爱尔兰/澳大利亚 6 国因此从来没有出现在运价表里。
    expect(scans.find((s) => s.sheetName === '无忧物流-特惠')!.table.stats.countries).toBe(29);
    // 反向控制：第一张确实解析不出运价（若某天它变得可解析，本组就失去意义）
    const first = scans[0].table;
    expect(first.stats.countries).toBe(0);
    expect(first.warnings[0]).toContain('表头行');
  });

  it('不传任何提示也不会选中第一张表（这是原来那条静默错误）', () => {
    const { scans } = scanWorkbook();
    const pick = pickRateSheet(scans);
    expect(pick.sheetName).toBe(SHEET);
    expect(pick.sheetName).not.toBe(scans[0].sheetName);
    expect(pick.sheetName).not.toBe('无忧物流-特惠'); // 也不是"第一张能解析的"
  });

  it('带默认提示时同样选中「无忧物流-标准」，且候选里列出全部 sheet 及原因', () => {
    const { sheetNames, scans } = scanWorkbook();
    const pick = pickRateSheet(scans, DEFAULT_SHEET_HINT);
    expect(pick.sheetName).toBe(SHEET);
    expect(pick.candidates).toHaveLength(sheetNames.length);
    // 不可用的候选必须带"为什么不选它"，否则界面只能显示一堆无信息量的名字
    const cc = pick.candidates.find((c) => c.sheetName === '目录')!;
    expect(cc.countries).toBe(0);
    expect(cc.reason).toContain('表头行');
    // 可用的候选 reason 为空（界面据此区分"可用 / 非报价单"）
    expect(pick.candidates.find((c) => c.sheetName === SHEET)!.reason).toBe('');
  });

  it('名称完全相同 > 名称近似（`无忧物流-标准` 必须赢过 `…-三方清关`）', () => {
    // 真实数据：`无忧物流-标准-三方清关` 只有 1 国 5 卡，但它的名字**包含**提示。
    // 只做 includes 匹配就会选它，用户会拿到一份只有 1 个国家的运价表且毫无提示。
    const pick = pickRateSheet(
      [fakeScan('无忧物流-标准-三方清关', 1), fakeScan(SHEET, 184), fakeScan('无忧物流-特惠', 23)],
      DEFAULT_SHEET_HINT
    );
    expect(pick.sheetName).toBe(SHEET);
  });

  it('名称近似 > 国家数更多（用户点名了一条线路，就不该被"更宽的表"抢走）', () => {
    const pick = pickRateSheet(
      [fakeScan('某条别的线路', 900), fakeScan('无忧物流-标准-威海优选仓', 50)],
      DEFAULT_SHEET_HINT
    );
    expect(pick.sheetName).toBe('无忧物流-标准-威海优选仓');
  });

  it('无提示时按国家数选最宽的可解析表', () => {
    const pick = pickRateSheet([fakeScan('甲', 5), fakeScan('乙', 120), fakeScan('丙', 30)]);
    expect(pick.sheetName).toBe('乙');
  });

  it('提示救不了一张解析不出来的表（不能因为名字像就把空表推给用户）', () => {
    const pick = pickRateSheet(
      [
        fakeScan(SHEET, 0, [
          '未找到任何「运达国家/地区」表头行 —— 该 sheet 不是报价单结构，未解析出任何运价',
        ]),
        fakeScan('别的表', 5),
      ],
      DEFAULT_SHEET_HINT
    );
    expect(pick.sheetName).toBe('别的表');
  });

  it('一张都不可用时 sheetName 为空串，并仍回报全部候选（供界面解释"试过哪些"）', () => {
    const pick = pickRateSheet([
      fakeScan('目录', 0, ['未找到表头行']),
      fakeScan('说明', 0, ['未找到表头行']),
    ]);
    expect(pick.sheetName).toBe('');
    expect(pick.candidates.map((c) => c.sheetName)).toEqual(['目录', '说明']);
  });

  it('排序确定：同输入同输出（并列时按工作簿顺序，不靠 Array.sort 的稳定性）', () => {
    const build = () => [fakeScan('前', 7), fakeScan('后', 7)];
    expect(pickRateSheet(build()).sheetName).toBe('前');
    expect(pickRateSheet(build()).sheetName).toBe('前');
    expect(pickRateSheet([]).sheetName).toBe('');
  });
});

// ─────────────────────────────────────────────────────────── ⑥ 版式族

/**
 * 版式不是一种，是一族（2026-09-25，用源工作簿 21 张 sheet 逐张实测）。
 *
 * 起因是用户实测报错：「燕文航空挂号小包」切换后提示
 *     「没解析出运价：分节 1（第 9 行）：表头结构无法识别，整节跳过」
 * 数据完全正常 —— 是该表**只有 2 行表头**（档位与「运达国家/地区」同行、叶子在下一行），
 * 而实现把表头行数写死成 3 行，于是"叶子行"取到了数据行。
 * 同族还有 4PX / 超级经济 / 顺友 / 特货标准（叶子在上、档位在下）等一大票线路。
 *
 * 这一组用例的每条断言都对应一个**会静默算错**的分支，夹具里各版式族各留一张真表切片。
 */
describe('normalizeRateSheet · 版式族（1~3 行表头 / 叶子与档位上下颠倒 / 币种）', () => {
  it('2 行表头：燕文航空挂号小包能解析出 5 国，且「Item 服务费」被认成挂号费', () => {
    const t = sheetTable('燕文航空挂号小包');
    expect(t.stats.countries).toBe(5);
    expect(t.stats.cards).toBe(5);
    expect(t.warnings).toEqual([]); // 曾经这里只有一条「表头结构无法识别，整节跳过」

    const no = firstCountry('燕文航空挂号小包'); // 挪威
    expect(no.nameCn).toBe('挪威');
    expect(no.cards).toHaveLength(1);
    // ⚠️ 「Item 服务费」是挂号费的别称（燕文/超级经济/顺友 6 张表都这么写）。
    //    不认它 → registerFee 落到 0 → 界面照常出数、金额偏小，属于最难发现的那类错。
    expect(no.cards[0]).toMatchObject({
      mode: 'perKg',
      ratePerKg: 66.2,
      registerFee: 19.2,
      currency: 'CNY',
    });
    // 手算：66.2 元/KG × 100g ÷ 1000 + 19.2 = 25.82
    expect(computeFee(no.cards[0], 100).fee).toBe(25.82);
    // 档位来自**表头行**的「包裹重量为1-2000克」（不是叶子里），1g 的下界按无下界处理
    expect([no.cards[0].minG, no.cards[0].maxG]).toEqual([0, 2000]);
  });

  it('2 行表头 + 最低计费重量：超级经济-燕文每国 2 档，且带出「最低计费重量 10g」', () => {
    const t = sheetTable('超级经济-燕文');
    expect(t.stats.countries).toBe(36);
    expect(t.stats.cards).toBe(72); // 36 国 × 2 档
    expect(t.warnings).toEqual([]);

    const is = firstCountry('超级经济-燕文'); // 冰岛
    expect(is.cards.map((c) => [c.minG, c.maxG])).toEqual([
      [0, 100], // 「包裹重量为1-100克」
      [101, 2000], // 「包裹重量为101-2000克」
    ]);
    // 最低计费重量的值写在**数据行**里（10g），且与本卡不同列
    expect(is.cards.map((c) => c.minChargeG)).toEqual([10, 10]);
    expect(t.sections[0].minChargeG).toBe(10);

    // 两个档位要按克重各自命中（选错档 = 用错费率，且不会有任何提示）
    expect(pickCard(is, 100)!.minG).toBe(0);
    expect(pickCard(is, 101)!.minG).toBe(101);
  });

  it('1 行表头：4PX新邮挂号小包（没有档位行，限重写在叶子里）', () => {
    const t = sheetTable('4PX新邮挂号小包');
    expect(t.stats.countries).toBe(55);
    expect(t.warnings).toEqual([]);
    const vn = firstCountry('4PX新邮挂号小包'); // 越南
    expect(vn.nameCn).toBe('越南');
    // 档位不在表头里 → 从叶子文本的「限重2KG」取上界；取不到就会退化成 30kg
    expect(vn.cards[0]).toMatchObject({ minG: 0, maxG: 2000, ratePerKg: 62.1, registerFee: 16.9 });
  });

  it('叶子行在**上**、档位行在下（无忧物流-特货标准）：以「表头各行的最下一行」为数据起点', () => {
    const t = sheetTable('无忧物流-特货标准');
    expect(t.stats.countries).toBe(77); // 分节 1 的俄罗斯 + 分节 2 的 76 国
    const ru = t.countries.find((c) => c.nameCn === '俄罗斯')!;
    expect(ru.cards).toHaveLength(4);
    expect(ru.cards.map((c) => [c.minG, c.maxG])).toEqual([
      [0, 150],
      [150, 300],
      [300, 500],
      [500, 3000],
    ]);
    // 数据起点若仍按 hdr+3 算（= 档位行），这几国整批取不到值
    expect(t.countries.length).toBeGreaterThan(1);
  });

  it('❗行式分档表必须整节拒绝，绝不能产出"看着像数、其实量纲错"的价', () => {
    // 两类的共同特征：**同一目的地在一节里占多行**（一行一档），分档写在列上而非表头。
    // 这类表能被"结构扫描"认出叶子列（配送服务费/KG 就在列头），但金额语义完全不同
    //   · 无忧物流-优先    20KG以下/20-30KG/31-69KG 三段**逐列给总价**（单元格是"该档总价"）
    //   · 无忧物流-海运大件专线 / 特货标准分节 3   价格起始/终止重量在列上
    // 取错就会把"该档总价"当成"每 KG 费率"，算出来的数比真实值大两个数量级且不报错。
    const sea = sheetTable('无忧物流-海运大件专线');
    expect(sea.stats.countries).toBe(0);
    expect(sea.stats.cards).toBe(0);
    expect(sea.warnings).toHaveLength(1);
    expect(sea.warnings[0]).toContain('分档写在数据行里');

    // 特货标准的第 3 节是同一类（巴林/留尼汪岛/墨西哥 各占 3~6 行）：
    // 那 12 个国家一个都不许出现在结果里，而不是"先放进去再说"
    const tc = sheetTable('无忧物流-特货标准');
    expect(tc.countries.map((c) => c.nameCn)).not.toContain('巴林');
    expect(tc.countries.map((c) => c.nameCn)).not.toContain('墨西哥');
    expect(tc.warnings.filter((w) => w.includes('分档写在数据行里'))).toHaveLength(1);
    // 被拒绝的节不该把"挂号费按 0 计"这类建卡告警漏进总表（那节根本没用上）
    expect(tc.warnings.filter((w) => w.includes('挂号费按 0 计'))).toEqual([]);
  });

  it('「2KG以内（包含2KG）」= 只说上限，不是 [2g, 2g]（无忧物流-特惠分节 1）', () => {
    // 两个数字相同的档位文本若被当成区间，会得到一张只覆盖 2 克的价卡：
    // 界面看不出异常，只是 100g 的查询会报"该重量段无可用运价"。
    const t = sheetTable('无忧物流-特惠');
    const ru = t.countries.find((c) => c.nameCn === '俄罗斯')!;
    const general = ru.cards.find((c) => c.categories.includes('general'))!;
    expect(general.minG).toBe(0);
    expect(general.maxG).toBe(2000);
  });

  it('非人民币线路：不套人民币的壳算钱，而是明确拒算并说明原因', () => {
    // 无忧物流-特惠 / 超级经济 的表头写的是「美元（USD）/KG」。本域没有汇率来源，
    // 所以只能整表拒算 —— 静默按人民币算会差 7 倍，而且金额看起来完全正常。
    const usd = sheetTable('无忧物流-特惠');
    expect(usd.stats.currencies).toEqual(['USD']);
    const rows = quoteAll(usd, 100);
    expect(rows.length).toBeGreaterThan(0);
    expect(rows.every((r) => !r.ok)).toBe(true);
    expect(rows.every((r) => r.reason.includes('汇率'))).toBe(true);
    expect(rows.every((r) => r.fee === 0)).toBe(true);
    expect(rows[0].card!.currency).toBe('USD'); // 卡本身仍回传，界面据此显示"USD 未换算"

    // 对照组：人民币线路照常出价（证明上面拒的是**币种**，不是整条链路坏了）
    const cny = sheetTable(SHEET);
    expect(cny.stats.currencies).toEqual(['CNY']);
    expect(quoteAll(cny, 100).every((r) => r.ok)).toBe(true);
  });

  it('不分品类的表（燕文/4PX/超级经济）：类别记 any，任何类别查询都能命中它', () => {
    const t = sheetTable('燕文航空挂号小包');
    const no = firstCountry('燕文航空挂号小包');
    // 不能谎称成 general（那会让界面把"不分品类"显示成"普货小包"）
    expect(no.cards[0].categories).toEqual(['any']);
    expect(t.sections[0].categories).toEqual(['any']);
    // 强制任何类别都能落到 any 卡上；超出档位则明确返回 null
    expect(pickCard(no, 100, { category: 'general' })).not.toBeNull();
    expect(pickCard(no, 100, { category: 'special' })).not.toBeNull();
    expect(pickCard(no, 100, { category: 'bulk' })).not.toBeNull();
    expect(pickCard(no, 3000)).toBeNull(); // 限重 2KG

    // 有明确类别的表不受影响：general 依旧优先于 any（any 只排最后兜底）
    const withCat = sheetTable('无忧物流-标准');
    expect(
      pickCard(
        withCat.countries.find((c) => c.nameCn === '阿尔巴尼亚')!,
        100
      )!.categories
    ).toEqual(['general']);
  });

  it('价格区分「该重量段无可用运价」与「未接汇率」，不合并成一句', () => {
    const usd = quoteAll(sheetTable('无忧物流-特惠'), 100)[0];
    const noPrice = quoteAll(sheetTable(SHEET), 5000).find((r) => !r.ok)!;
    expect(usd.reason).toContain('汇率');
    expect(noPrice.reason).toContain('无可用运价');
    expect(usd.reason).not.toBe(noPrice.reason);
  });
});

describe('computeFee · 最低计费重量（报价单单列的「最低计费重量 10g」/「起重 克」）', () => {
  const base = (minChargeG: number) => ({
    sec: 1,
    categories: ['any'] as const,
    variant: '',
    minG: 0,
    maxG: 2000,
    mode: 'perKg' as const,
    ratePerKg: 100,
    registerFee: 0,
    firstFee: 0,
    stepFee: 0,
    baseG: 500,
    stepG: 500,
    currency: 'CNY' as const,
    minChargeG,
  });

  it('不足最低计费重量时按最低值计重（3g → 按 10g 算）', () => {
    const r = computeFee(base(10) as never, 3);
    expect(r.breakdown.chargeG).toBe(10);
    expect(r.fee).toBe(1); // 100 元/KG × 10g ÷ 1000
    // 对照组：没有这个约束时是 0.3 元 —— 差的就是那笔少算的钱
    expect(computeFee(base(0) as never, 3).fee).toBe(0.3);
  });

  it('超过最低值不受影响，且不改动传入的价卡', () => {
    const card = base(10);
    const before = JSON.stringify(card);
    const r = computeFee(card as never, 500);
    expect(r.breakdown.chargeG).toBe(500);
    expect(r.fee).toBe(50);
    expect(JSON.stringify(card)).toBe(before);
  });
});
