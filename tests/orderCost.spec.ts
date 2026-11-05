// 「订单成本」纯计算层的契约用例。
//
// 钉住的是**口径**而不是实现：
//   · 成本只认**订单行自己钉的两个快照**：实际进价 > 进价预估 > 缺（C2 两字段，2026-10-21）；
//     0 / null 一律当"没有"—— 不按 0 算，也不回查产品当前价（否则改价会改写历史利润）；
//   · 缺哪一环就标哪一环（无国家 / 无克重 / 运价表没这张卡 / 未识别款 / 该行没成本），**不静默按 0 算**；
//   · 任一分项缺失时 `total` 为 null —— 这是本层最重要的一条：0 与"不知道"必须区分开，
//     否则"缺成本的订单"会显示成"零成本的高利润"。
import { describe, expect, it } from 'vitest';
import type { RateTable } from '../src/lib/shipRate';
import {
  bucketOfStatus,
  buildSkuWeightIndex,
  canonSizeKey,
  collectItemIds,
  computeOrderCosts,
  dateKey,
  pickRateSnapshot,
  positiveCents,
  resolveWeightG,
  settleQtyKey,
  skuSizeWeightKey,
  skuWeightKey,
  summarizeOrderCosts,
  trendOf,
  taxBearerOf,
} from '../src/lib/orderCost';

/** 最小合成运价表：US 一张 CNY 卡（0–2000g，perKg 80 + 挂号 8，最低计费 10g） */
function tinyTable(): RateTable {
  return {
    sheetName: 'tiny',
    countries: [
      {
        code: 'US',
        nameCn: '美国',
        nameEn: 'United States',
        cards: [
          {
            minG: 0,
            maxG: 2000,
            categories: ['general'],
            mode: 'perKg',
            ratePerKg: 80,
            registerFee: 8,
            firstFee: 0,
            stepFee: 0,
            baseG: 0,
            stepG: 0,
            variant: '',
            sec: 1,
            currency: 'CNY',
            minChargeG: 10,
          },
        ],
      },
    ],
    sections: [],
    stats: {
      sections: 1,
      countries: 1,
      cards: 1,
      perKgCards: 1,
      firstStepCards: 0,
      currencies: ['CNY'],
    },
    warnings: [],
  };
}

/** 同 tinyTable，但把 perKg 费率换掉（用来造"两张不同日期的报价单"） */
function tableWithRate(ratePerKg: number): RateTable {
  const t = tinyTable();
  return {
    ...t,
    countries: t.countries.map((c) => ({
      ...c,
      cards: c.cards.map((card) => ({ ...card, ratePerKg })),
    })),
  };
}

/** 订单行（raw_fields 用真实列名族：国家 + 商品ID） */
/**
 * 默认订单行：**把利润用列也一并给全**（订单金额 165.18 / 增值税 34.69 / DDP 22.94 / 平台已税）。
 * 这样成本类用例的 `gaps` 保持在"这一行的成本链"上，不会被收入/税的缺口淹掉。
 *
 * 商品信息块（`(商品数量:N piece)`）默认给上：真实报表**每一行都有**（153/153 实测），
 * 不给的话每条用例都会多出一个「缺件数」缺口，把断言淹掉。
 */
function infoBlock(qty = 1): string {
  return `【1】 测试款 (产品属性:Color:黑、Size:L、Ships From:China Mainland)\n(商品数量:${qty} piece)\n`;
}

/** 拼 raw_fields：覆盖的用例只关心自己那几列，件数块（真实报表每行都有）默认补上 */
function baseRawFields(over?: Record<string, string>): Record<string, string> {
  const base: Record<string, string> = over
    ? { 商品信息: infoBlock() }
    : { 收货国家: '美国', 商品ID: 'ITEM1', 商品信息: infoBlock() };
  return { ...base, ...(over ?? {}) };
}

function order(over: Partial<Parameters<typeof computeOrderCosts>[0]['orders'][number]> = {}) {
  const { rawFields, ...rest } = over;
  return {
    id: 1,
    orderNo: 'NO1',
    shop: '店A',
    orderTime: '2026-09-10 12:00:00',
    styleCode: 'S1',
    styleColor: '红',
    // 克重按**款色码**查（`pl_variants.weight_g`）—— 行上必须有色/码才可能命中，故默认给一对
    color: '黑',
    size: 'L',
    amountCents: 16518,
    vatCents: 3469,
    ddpCents: 2294,
    bizStatus: '交易完成',
    taxPlatform: '平台已税',
    // 行级**进价预估**快照（C2）：默认 10 元 —— 成本类用例的 `gaps` 不会被「缺成本」淹掉。
    // 需要"这一行没有成本"的用例显式给 `costCents: null`；需要"实际进价"的用例给 `actualCostCents`。
    costCents: 1000,
    rawFields: baseRawFields(rawFields),
    ...rest,
  };
}

/** 款色码 → 克重查表（与实现同一份建键函数；默认款 S1 / 黑 / L） */
function skuW(g: number, code = 'S1', color = '黑', size = 'L'): Record<string, number> {
  return { [skuWeightKey(code, color, size)]: g };
}

describe('dateKey', () => {
  it('归一常见分隔符与单位数月日', () => {
    expect(dateKey('2026-09-10')).toBe('2026-09-10');
    expect(dateKey('2026/9/1')).toBe('2026-09-01');
    expect(dateKey('2026.09.01')).toBe('2026-09-01');
  });
  it('带时分秒只取日期部分', () => {
    expect(dateKey('2026-09-10 12:00:00')).toBe('2026-09-10');
    expect(dateKey('2026-9-10 12:00')).toBe('2026-09-10');
  });
  it('认不出返回空串（不猜）', () => {
    expect(dateKey('')).toBe('');
    expect(dateKey(null)).toBe('');
    expect(dateKey('不是日期')).toBe('');
  });
});

describe('collectItemIds', () => {
  it('去重、跳过空商品ID，认不出国家不影响取商品ID', () => {
    expect(
      collectItemIds([
        { rawFields: { 商品ID: 'A' } },
        { rawFields: { 商品ID: 'A' } },
        { rawFields: { 商品ID: '' } },
        { rawFields: {} },
      ]),
    ).toEqual(['A']);
  });
  it('空输入返回空数组', () => {
    expect(collectItemIds([])).toEqual([]);
    expect(collectItemIds(null)).toEqual([]);
  });
});

describe('positiveCents：0 / 空 / 非数一律算"没有"', () => {
  it('正数原样返回', () => {
    expect(positiveCents(1)).toBe(1);
    expect(positiveCents(1234)).toBe(1234);
  });

  it('0 与负数不算有值（0 是"没维护"，不是"零成本"）', () => {
    expect(positiveCents(0)).toBeNull();
    expect(positiveCents(-5)).toBeNull();
  });

  it('null / undefined / NaN / 非数文本 → null（不猜）', () => {
    expect(positiveCents(null)).toBeNull();
    expect(positiveCents(undefined)).toBeNull();
    expect(positiveCents(Number.NaN)).toBeNull();
    expect(positiveCents('abc')).toBeNull();
    expect(positiveCents('')).toBeNull();
  });
});

describe('computeOrderCosts：逐行结论与缺口', () => {
  it('两笔都能算出来：运费 + 成本 = 合计', () => {
    const r = computeOrderCosts({
      orders: [order()],
      skuWeights: skuW(100),
      rateTable: tinyTable(),
    });
    expect(r.total).toBe(1);
    expect(r.ok).toBe(1);
    const row = r.rows[0];
    expect(row.shipping).toBeCloseTo(16, 2); // 100g × 80/kg = 8 + 挂号 8
    expect(row.productCost).toBe(10);
    expect(row.total).toBeCloseTo(26, 2);
    expect(row.gaps).toEqual([]);
    expect(r.shippingTotal).toBeCloseTo(16, 2);
    expect(r.productCostTotal).toBe(10);
    // 成本合计 = 运费 + 产品成本（指标条「成本合计」= 这个数，与毛利算式同一份）
    expect(r.costTotal).toBeCloseTo(26, 2);
    // 利润：收入 165.18 − (运费 16 + 成本 10) − 税 0（平台已税）= 139.18
    expect(row.revenue).toBeCloseTo(165.18, 2);
    expect(row.taxCost).toBe(0);
    expect(row.grossProfit).toBeCloseTo(139.18, 2);
    expect(r.revenueTotal).toBeCloseTo(165.18, 2);
    expect(r.grossTotal).toBeCloseTo(139.18, 2);
    expect(r.platformFeeMissing).toBe(true);
  });

  it('关闭单不进任何合计 —— 运费/成本/平台费与收入/毛利**同口径**', () => {
    // 守卫的是"同名不同口径"这个坑：指标条上「成本合计」和「收入合计」并排显示，
    // 若成本含关闭单而收入不含，用户会看到"成本比收入还大"却找不到原因。
    const base = {
      skuWeights: skuW(100),
      rateTable: tinyTable(),
      platformFeeRatePercent: 10,
    };
    const open = order({ id: 1, orderNo: 'OPEN' });
    const closed = order({ id: 2, orderNo: 'CLOSED', bizStatus: '交易关闭' });
    const both = computeOrderCosts({ ...base, orders: [open, closed] });
    const onlyOpen = computeOrderCosts({ ...base, orders: [open] });

    // 两行都读进来了 → total 含关闭单
    expect(both.total).toBe(2);
    expect(both.rows.filter((x) => x.bucket === 'closed').length).toBe(1);
    // 四个合计必须与"只有这一单"时**完全相等**：关闭单一个数都不该贡献
    expect(both.revenueTotal).toBeCloseTo(onlyOpen.revenueTotal, 2);
    expect(both.costTotal).toBeCloseTo(onlyOpen.costTotal, 2);
    expect(both.shippingTotal).toBeCloseTo(onlyOpen.shippingTotal, 2);
    expect(both.productCostTotal).toBeCloseTo(onlyOpen.productCostTotal, 2);
    expect(both.grossTotal).toBeCloseTo(onlyOpen.grossTotal, 2);
    expect(both.platformFeeTotal).toBeCloseTo(onlyOpen.platformFeeTotal, 2);
    // 关闭单仍然**不丢行**：它单列一桶，供单独核对
    expect(both.bucketTotals.map((b) => b.bucket).sort()).toEqual(['closed', 'completed']);
    // 成本合计 = 运费 + 产品成本（指标条与毛利算式共用这个恒等式）
    expect(both.costTotal).toBeCloseTo(both.shippingTotal + both.productCostTotal, 2);
  });

  it('缺克重：运费算不出 → total 为 null，并标 weight', () => {
    const r = computeOrderCosts({
      orders: [order()],
      skuWeights: {},
      rateTable: tinyTable(),
    });
    expect(r.rows[0].shipping).toBeNull();
    expect(r.rows[0].total).toBeNull();
    expect(r.rows[0].shippingReason).toBe('noWeight');
    expect(r.rows[0].gaps).toEqual(['weight']);
    expect(r.ok).toBe(0);
    expect(r.gapCounts.weight).toBe(1);
  });

  it('克重回落的键：款编码大小写/空白归一，认不出款色码时返回空串（不猜）', () => {
    // 两端（建表/查表）共用这一个函数，所以键的归一必须钉住
    expect(skuWeightKey(' s1 ', '黑', 'L')).toBe(skuWeightKey('S1', '黑', 'L'));
    expect(skuWeightKey('S1', '黑', 'L')).not.toBe(skuWeightKey('S1', '黑', 'M'));
    // 款编码为空 → 放弃回落（否则无所谓哪一款的克重都会被套上去）
    expect(skuWeightKey('', '黑', 'L')).toBe('');
    // 色码全空 → 同样不回落（老数据的 SKU 只有名字，认不出粒度）
    expect(skuWeightKey('S1', '', '')).toBe('');
    // 只填了颜色或尺码之一 → 仍然可查（真实数据里 SKU 可能只填颜色）
    expect(skuWeightKey('S1', '黑', '')).not.toBe('');
  });

  // 尺码是两个世界的分界线：产品 SKU 写 `3XL`，同一批订单写 `XXXL`。
  // 逐字节比 ⇒ 一条也命中不了，症状是"补了克重还是缺克重"（2026-10-19 真库取证）。
  it('尺码比较归一：重复 X 与数字写法等价，XS 不被并进 S', () => {
    expect(canonSizeKey('XXXL')).toBe('3XL');
    expect(canonSizeKey('3xl')).toBe('3XL');
    expect(canonSizeKey('xxl')).toBe('2XL');
    expect(canonSizeKey('XXXXL')).toBe('4XL');
    expect(canonSizeKey('5XL')).toBe('5XL');
    expect(canonSizeKey('ＸＬ')).toBe('XL');
    // 不猜：XS 与 S 是两个码，均码/70B 这类原样留着
    expect(canonSizeKey('XS')).toBe('XS');
    expect(canonSizeKey('均码')).toBe('均码');
    expect(canonSizeKey('  ')).toBe('');
    // 建键时生效：订单 `XXXL` 与产品 `3XL` 必须同键
    expect(skuWeightKey('S1', '黑', 'XXXL')).toBe(skuWeightKey('S1', '黑', '3XL'));
    expect(skuWeightKey('S1', '黑', 'XXXL')).not.toBe(skuWeightKey('S1', '黑', 'XXL'));
  });

  it('同款同码键：颜色留空，与带色键不相等（不能互相冒名）', () => {
    expect(skuSizeWeightKey('S1', 'L')).toBe(skuWeightKey('S1', '', 'L'));
    expect(skuSizeWeightKey('S1', 'L')).not.toBe(skuWeightKey('S1', '黑', 'L'));
    expect(skuSizeWeightKey('', 'L')).toBe('');
    expect(skuSizeWeightKey('S1', '')).toBe('');
  });

  it('克重两级：精确款色码优先，未命中才用同款同码；都没有 → null', () => {
    const both = { ...skuW(275, 'S1', '黑', 'L'), ...{ [skuSizeWeightKey('S1', 'L')]: 320 } };
    // ① 精确命中，不被"同款同码"顶掉
    expect(resolveWeightG({ styleCode: 'S1', color: '黑', size: 'L' }, both)).toBe(275);
    // ② 平台色名（产品库里没有这个色）→ 落到同款同码
    expect(resolveWeightG({ styleCode: 'S1', color: '7', size: 'L' }, both)).toBe(320);
    // ③ 没有该码 → 仍是 null（不拿别的码顶）
    expect(resolveWeightG({ styleCode: 'S1', color: '7', size: 'M' }, both)).toBeNull();
    // ④ 只有带色键、色对不上 → null（同款同码键不存在就不许瞎套）
    expect(resolveWeightG({ styleCode: 'S1', color: '7', size: 'L' }, skuW(275))).toBeNull();
    expect(resolveWeightG(null, both)).toBeNull();
  });

  it('平台色名的订单靠同款同码把运费算出来（不再因"颜色对不上"整单缺数）', () => {
    const r = computeOrderCosts({
      orders: [order({ color: '7', size: 'XXXL' })],
      skuWeights: { [skuSizeWeightKey('S1', '3XL')]: 275 },
      rateTable: tinyTable(),
    });
    expect(r.rows[0].weightG).toBe(275);
    expect(r.rows[0].shipping).toBeCloseTo(30, 2);
    expect(r.rows[0].gaps).toEqual([]);
  });

  // 折叠（不加色也能取到克重）的**安全边界**：只有"这款这码各色确实同重"才成立。
  // 守的是最贵的一类错：拿别的色的重量报出一个看起来正常的运费。
  describe('buildSkuWeightIndex：折叠只在"各色同重"确实成立时', () => {
    const codeOf = new Map<number, string>([[1, 'S1']]);
    const v = (color: string, size: string, weightG: number, status = 'active') => ({
      productId: 1,
      color,
      size,
      weightG,
      status,
    });

    it('各色都填了且同重 → 产出同款同码键，且不顶掉精确键', () => {
      const idx = buildSkuWeightIndex([v('黑', 'L', 300), v('白', 'L', 300)], codeOf);
      expect(idx[skuWeightKey('S1', '黑', 'L')]).toBe(300);
      expect(idx[skuWeightKey('S1', '白', 'L')]).toBe(300);
      expect(idx[skuSizeWeightKey('S1', 'L')]).toBe(300);
    });

    it('有一个色没填 → **不折叠**（免得把"没维护"当成"同重"）', () => {
      const idx = buildSkuWeightIndex([v('黑', 'L', 300), v('白', 'L', 0)], codeOf);
      expect(idx[skuSizeWeightKey('S1', 'L')]).toBeUndefined();
      expect(resolveWeightG({ styleCode: 'S1', color: '白', size: 'L' }, idx)).toBeNull();
    });

    it('各色不同重 → **不折叠**（平台色名对不上时宁可缺克重，也不报错数）', () => {
      const idx = buildSkuWeightIndex([v('黑', 'L', 300), v('白', 'L', 380)], codeOf);
      expect(idx[skuSizeWeightKey('S1', 'L')]).toBeUndefined();
      expect(resolveWeightG({ styleCode: 'S1', color: '黑', size: 'L' }, idx)).toBe(300);
    });

    it('已归档的变体不参与折叠判定（不发货），但它的精确键照样生效', () => {
      const idx = buildSkuWeightIndex(
        [v('黑', 'L', 300), v('白', 'L', 300), v('灰', 'L', 999, 'archived')],
        codeOf,
      );
      expect(idx[skuSizeWeightKey('S1', 'L')]).toBe(300);
      expect(idx[skuWeightKey('S1', '灰', 'L')]).toBe(999);
    });

    it('颜色为空的行不建精确键（否则它自己就成了"同款同码"键，绕过折叠判定）', () => {
      const idx = buildSkuWeightIndex([v('', 'L', 300), v('黑', 'L', 380), v('白', 'L', 500)], codeOf);
      expect(idx[skuSizeWeightKey('S1', 'L')]).toBeUndefined();
      expect(resolveWeightG({ styleCode: 'S1', color: '7', size: 'L' }, idx)).toBeNull();
    });

    it('款编码为空 / 产品不在 codeOf 里 → 一个键都不建（不拿别的款顶上）', () => {
      expect(buildSkuWeightIndex([v('黑', 'L', 300)], new Map())).toEqual({});
      expect(buildSkuWeightIndex([v('黑', 'L', 300)], new Map([[1, '  ']]))).toEqual({});
      expect(buildSkuWeightIndex(null, codeOf)).toEqual({});
    });

    it('尺码写法不同也算同一码（订单 XXXL vs 产品 3XL）', () => {
      const idx = buildSkuWeightIndex([v('黑', '3XL', 420), v('白', '3XL', 420)], codeOf);
      expect(resolveWeightG({ styleCode: 'S1', color: '7', size: 'XXXL' }, idx)).toBe(420);
    });
  });

  it('克重按**款色码**取（唯一来源）：命中 → 算得出来', () => {
    const r = computeOrderCosts({
      orders: [order({ color: '黑', size: 'L' })],
      skuWeights: skuW(275),
      rateTable: tinyTable(),
    });
    const row = r.rows[0];
    expect(row.weightG).toBe(275);
    // 275g × 80/kg = 22 + 挂号 8 = 30
    expect(row.shipping).toBeCloseTo(30, 2);
    expect(row.gaps).toEqual([]);
    expect(r.gapCounts.weight).toBe(0);
  });

  it('同一款不同色/码各用各自的克重（不是"一款一个重量"）', () => {
    const r = computeOrderCosts({
      orders: [
        order({ id: 1, color: '黑', size: 'L' }),
        order({ id: 2, orderNo: 'NO2', color: '白', size: 'M' }),
      ],
      skuWeights: { ...skuW(100, 'S1', '黑', 'L'), ...skuW(400, 'S1', '白', 'M') },
      rateTable: tinyTable(),
    });
    expect(r.rows[0].weightG).toBe(100);
    expect(r.rows[1].weightG).toBe(400);
    expect(r.rows[0].shipping).toBeCloseTo(16, 2); // 100g → 8 + 挂号 8
    expect(r.rows[1].shipping).toBeCloseTo(40, 2); // 400g → 32 + 8
  });

  it('款色码对不上 → 照旧缺克重，不静默套一个别的款的重量', () => {
    const r = computeOrderCosts({
      orders: [order({ color: '黑', size: 'L' })],
      skuWeights: skuW(275, 'S2', '黑', 'L'), // 是另一款
      rateTable: tinyTable(),
    });
    expect(r.rows[0].weightG).toBeNull();
    expect(r.rows[0].gaps).toEqual(['weight']);
  });

  it('没国家：标 country', () => {
    const r = computeOrderCosts({
      orders: [order({ rawFields: { 商品ID: 'ITEM1' } })],
      skuWeights: skuW(100),
      rateTable: tinyTable(),
    });
    expect(r.rows[0].gaps).toEqual(['country']);
    expect(r.rows[0].total).toBeNull();
  });

  it('运价表不在（岛存储空）：整批标 rate，且不抛错', () => {
    const r = computeOrderCosts({
      orders: [order()],
      skuWeights: skuW(100),
      rateTable: null,
    });
    expect(r.rows[0].shipping).toBeNull();
    expect(r.rows[0].gaps).toEqual(['rate']);
    expect(r.rows[0].productCost).toBe(10); // 成本侧不受影响
  });

  it('运价表不覆盖该国家：标 rate（用 quoteOrders 的分类，不自己判）', () => {
    const r = computeOrderCosts({
      orders: [order({ rawFields: { 收货国家: '火星', 商品ID: 'ITEM1' } })],
      skuWeights: skuW(100),
      rateTable: tinyTable(),
    });
    expect(r.rows[0].gaps).toEqual(['rate']);
    expect(r.rows[0].shippingReason).toBe('unknownCountry');
  });

  it('订单行未识别款且没钉成本：标 style + cost + weight（克重按款色码取，认不出款就查不到 → 如实标缺）', () => {
    const r = computeOrderCosts({
      orders: [order({ styleCode: '', costCents: null })],
      skuWeights: skuW(100),
      rateTable: tinyTable(),
    });
    // 2026-10-01：克重的唯一来源是 SKU（款×色×码）—— 款都没识别出来就无从取克重，
    // 于是运费也缺（旧模型还能靠"商品ID 克重"兜一层，那条链已删）。
    expect(r.rows[0].gaps).toEqual(['weight', 'style', 'cost']);
    expect(r.rows[0].productCost).toBeNull();
    expect(r.rows[0].shipping).toBeNull();
    expect(r.rows[0].total).toBeNull();
  });

  it('款识别了但行上没钉成本（预估/实际都空）：只标 cost', () => {
    const r = computeOrderCosts({
      orders: [order({ costCents: null })],
      skuWeights: skuW(100),
      rateTable: tinyTable(),
    });
    expect(r.rows[0].gaps).toEqual(['cost']);
  });

  it('缺口按行分桶（界面据此提示先去补什么）', () => {
    const r = computeOrderCosts({
      orders: [
        order({ id: 1 }),
        order({ id: 2, rawFields: { 商品ID: 'ITEM1' } }), // 缺国家
        order({ id: 3, styleCode: '', costCents: null }), // 缺款（且没钉成本）
      ],
      skuWeights: skuW(100),
      rateTable: tinyTable(),
    });
    expect(r.total).toBe(3);
    expect(r.ok).toBe(1);
    expect(r.gapCounts.country).toBe(1);
    expect(r.gapCounts.style).toBe(1);
    expect(r.gapCounts.cost).toBe(1);
    // 未识别款那行同时缺克重（克重按款色码取，认不出款就取不到）—— 逐行可见，不是计数错觉
    expect(r.gapCounts.weight).toBe(1);
  });

  it('空输入不炸', () => {
    const r = computeOrderCosts({ orders: [], skuWeights: {}, rateTable: null });
    expect(r.rows).toEqual([]);
    expect(r.total).toBe(0);
    expect(r.ok).toBe(0);
  });
});
// ─────────────────────────────────────────────────────────── 利润层（收入 / 税 / 毛利 / 分桶）
//
// 口径来自用户裁定（2026-09-29）：
//   · 这是**预测**工具 → 在途单要算（不是只算已结算）；
//   · 关闭单单列一桶、**不进利润合计**（实测真实报表 54% 是关闭单，混进来整体虚高）；
//   · 平台代征代缴时增值税**不是我们的成本**（记确定的 0）；不知道谁承担 → 标缺、不按 0 算；
//   · 平台费（佣金）暂无数据源 → 全局标志 `platformFeeMissing`，毛利如实标"未扣平台费"。
describe('利润层：收入 / 税 / 毛利 / 分桶', () => {
  const base = {
    skuWeights: skuW(100),
    rateTable: tinyTable(),
  };

  it('平台已税 → 税记确定的 0（不是"未知"），毛利 = 收入 − 运费 − 成本', () => {
    const r = computeOrderCosts({ ...base, orders: [order()] });
    const row = r.rows[0];
    expect(row.taxCost).toBe(0);
    expect(row.grossProfit).toBeCloseTo(165.18 - 16 - 10, 2);
  });

  it('明确自缴 → 税 = 增值税 + DDP', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [order({ taxPlatform: '商家自缴' })],
    });
    const row = r.rows[0];
    expect(row.taxCost).toBeCloseTo(34.69 + 22.94, 2);
    expect(row.grossProfit).toBeCloseTo(165.18 - 16 - 10 - 57.63, 2);
  });

  it('不知道谁承担税 → taxCost=null、标 tax 缺口、毛利为 null（不按 0 算）', () => {
    const r = computeOrderCosts({ ...base, orders: [order({ taxPlatform: '' })] });
    const row = r.rows[0];
    expect(row.taxCost).toBeNull();
    expect(row.gaps).toContain('tax');
    expect(row.grossProfit).toBeNull();
  });

  it('缺订单金额（导入单）→ 标 revenue 缺口、毛利为 null', () => {
    const r = computeOrderCosts({ ...base, orders: [order({ source: 'import', amountCents: null })] });
    expect(r.rows[0].revenue).toBeNull();
    expect(r.rows[0].gaps).toContain('revenue');
    expect(r.rows[0].gaps).not.toContain('fx');
    expect(r.rows[0].grossProfit).toBeNull();
  });

  it('缺汇率（采集单）与缺收入（导入单）**分开标** —— 两者补法不同，不能压成一档', () => {
    // 非空转：两个输入只差 `source`，期望的缺口必须不同；
    // 若实现不看 source（或把两档并成一个 key），下面任一条断言都会红。
    const r = computeOrderCosts({
      ...base,
      orders: [
        order({ id: 1, source: 'collect', amountCents: null }),
        order({ id: 2, source: 'import', amountCents: null }),
      ],
    });
    expect(r.rows[0].gaps).toContain('fx');
    expect(r.rows[0].gaps).not.toContain('revenue');
    expect(r.rows[1].gaps).toContain('revenue');
    expect(r.rows[1].gaps).not.toContain('fx');
    expect(r.gapCounts.fx).toBe(1);
    expect(r.gapCounts.revenue).toBe(1);
  });

  it('关闭单单独成桶，且**不进**利润合计', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [order({ id: 1 }), order({ id: 2, bizStatus: '订单关闭' })],
    });
    expect(r.rows[1].bucket).toBe('closed');
    // 合计只含非关闭单
    expect(r.revenueTotal).toBeCloseTo(165.18, 2);
    expect(r.grossTotal).toBeCloseTo(139.18, 2);
    // 但分桶合计里两桶都在（关闭单可单独核对）
    const closed = r.bucketTotals.find((b) => b.bucket === 'closed');
    expect(closed?.rows).toBe(1);
    expect(closed?.revenue).toBeCloseTo(165.18, 2);
    const completed = r.bucketTotals.find((b) => b.bucket === 'completed');
    expect(completed?.rows).toBe(1);
  });

  it('在途单照算（这是预测工具，不是只算已结算）', () => {
    const r = computeOrderCosts({ ...base, orders: [order({ bizStatus: '等待买家收货' })] });
    expect(r.rows[0].bucket).toBe('intransit');
    expect(r.rows[0].grossProfit).not.toBeNull();
    expect(r.grossTotal).toBeCloseTo(139.18, 2);
  });
});

describe('bucketOfStatus / taxBearerOf（判定口径在主进程只解析原文，判定归这里）', () => {
  it('状态分桶：关闭 / 完成 / 在途 / 认不出', () => {
    expect(bucketOfStatus('订单关闭')).toBe('closed');
    expect(bucketOfStatus('交易完成')).toBe('completed');
    expect(bucketOfStatus('等待买家收货')).toBe('intransit');
    expect(bucketOfStatus('某种新状态')).toBe('unknown');
    expect(bucketOfStatus('')).toBe('unknown');
  });
  it('税承担方三态：平台 / 自己 / 不知道', () => {
    expect(taxBearerOf('平台已税')).toBe('platform');
    expect(taxBearerOf('商家自缴')).toBe('self');
    expect(taxBearerOf('')).toBe('unknown');
  });
});

// ─────────────────────────────────────────────────────────── 运价表生效区间（历史可复算）
//
// 背景：报价单会更新。只留"当前那份"的话，历史订单的预测运费会随报价单更新而变 —— 预测不可复算。
// 结算口径：`effective_from <= 订单日` 最近一份；早于所有快照 → 回落最早一份。
describe('运价表快照：按订单日期取当时那份', () => {
  const snap = (effectiveFrom: string, ratePerKg: number) => ({
    effectiveFrom,
    table: tableWithRate(ratePerKg),
  });

  it('pickRateSnapshot：区间内取最近一份；早于最早 → 回落最早；晚于最新 → 最新', () => {
    const snaps = [snap('2026-06-01', 80), snap('2026-09-01', 100)];
    expect(pickRateSnapshot(snaps, '2026-08-31')).toBe(snaps[0].table);
    expect(pickRateSnapshot(snaps, '2026-09-01')).toBe(snaps[1].table);
    expect(pickRateSnapshot(snaps, '2026-12-31')).toBe(snaps[1].table);
    expect(pickRateSnapshot(snaps, '2025-01-01')).toBe(snaps[0].table); // 回落最早
    expect(pickRateSnapshot(snaps, '')).toBe(snaps[1].table); // 日期认不出 → 最新
    expect(pickRateSnapshot([], '2026-09-10')).toBeNull();
  });

  it('两张不同日期的报价单：历史订单按**当时那份**算，运费不被后来的表改写', () => {
    const r = computeOrderCosts({
      orders: [
        order({ id: 1, orderTime: '2026-07-15 10:00:00' }), // 落在 06-01 那份
        order({ id: 2, orderTime: '2026-09-15 10:00:00' }), // 落在 09-01 那份
      ],
      skuWeights: skuW(100),
      rateTable: null,
      rateSnapshots: [snap('2026-06-01', 80), snap('2026-09-01', 100)],
    });
    // 100g：80/kg → 8 + 挂号 8 = 16；100/kg → 10 + 8 = 18
    expect(r.rows[0].shipping).toBeCloseTo(16, 2);
    expect(r.rows[1].shipping).toBeCloseTo(18, 2);
    // 每行标明用的是哪份表（"这条按哪张表算的"可自证）
    expect(r.rows[0].rateVersion).toBe('2026-06-01');
    expect(r.rows[1].rateVersion).toBe('2026-09-01');
    expect(r.rows[0].gaps).not.toContain('rate');
  });

  it('有快照时不再看"当前那份"单表（避免两张表混用）', () => {
    const r = computeOrderCosts({
      orders: [order({ orderTime: '2026-09-15 10:00:00' })],
      skuWeights: skuW(100),
      rateTable: tableWithRate(200), // 单表故意设成天价
      rateSnapshots: [snap('2026-09-01', 100)],
    });
    expect(r.rows[0].shipping).toBeCloseTo(18, 2); // 用的是快照，不是单表
  });
});

// ─────────────────────────────────────────────────────────── 包裹运费（阶段 C1：有包用真值）
//
// 为什么：B2 让用户按包裹记运费，但利润引擎一直只认运价表估算 ⇒ 用户填了实付、利润不动。
// 口径：**订单有包裹 ⇒ 运费用包裹合计**（按件数摊到各行），缺运费就标缺、**不回落估算**
// （回落会让"填没填"看不出来，且估算会盖掉真值）。
describe('包裹运费：有包用真值，缺则标缺不回落（C1）', () => {
  const parcel = (over: Partial<{ count: number; shipCents: number | null; weightG: number | null; shipMissing: number; weightMissing: number }> = {}) => ({
    count: 1,
    shipCents: 3000,
    weightG: 1000,
    shipMissing: 0,
    weightMissing: 0,
    ...over,
  });

  it('有包裹：用包裹合计（30 元），不再按运价表算（那张表会算成 16）', () => {
    const r = computeOrderCosts({
      orders: [order()],
      skuWeights: skuW(100),
      rateTable: tinyTable(),
      parcelTotals: { NO1: parcel() },
    });
    expect(r.rows[0].shipping).toBe(30);
    expect(r.rows[0].shippingSource).toBe('parcel');
    expect(r.rows[0].shippingReason).toBe('');
    expect(r.rows[0].rateVersion).toBe('');
    expect(r.rows[0].gaps).not.toContain('parcel');
  });

  it('同单多行：包裹运费按**件数**分摊，各行之和 == 整单合计', () => {
    const r = computeOrderCosts({
      orders: [
        order({ id: 1, orderNo: 'NO1', qty: 3 }),
        order({ id: 2, orderNo: 'NO1', qty: 1, rawFields: baseRawFields({ 商品信息: infoBlock(1) }) }),
      ],
      skuWeights: skuW(100),
      rateTable: null,
      parcelTotals: { NO1: parcel({ shipCents: 4000 }) },
    });
    expect(r.rows.map((x) => x.shipping)).toEqual([30, 10]);
    expect(r.shippingTotal).toBe(40);
  });

  it('分摊除不尽：末行吃残差，合计仍与包裹总额精确相等', () => {
    const r = computeOrderCosts({
      orders: [1, 2, 3].map((id) => order({ id, orderNo: 'NO1' })),
      skuWeights: skuW(100),
      rateTable: null,
      parcelTotals: { NO1: parcel({ shipCents: 1001 }) },
    });
    expect(r.rows.map((x) => x.shipping)).toEqual([3.34, 3.34, 3.33]);
    expect(r.shippingTotal).toBe(10.01);
  });

  it('包裹缺运费：该行标「缺包裹运费」且**不回落运价表**（即便有表、有克重/国家）', () => {
    const r = computeOrderCosts({
      orders: [order()],
      skuWeights: skuW(100),
      rateTable: tinyTable(),
      parcelTotals: { NO1: parcel({ count: 2, shipCents: null, shipMissing: 1 }) },
    });
    expect(r.rows[0].shipping).toBeNull();
    expect(r.rows[0].shippingSource).toBe('parcel');
    expect(r.rows[0].shippingReason).toBe('parcelShipMissing');
    expect(r.rows[0].gaps).toContain('parcel');
    // 没有回落 ⇒ 不应该再冒出"缺运价表 / 缺国家 / 缺克重"
    expect(r.rows[0].gaps).not.toContain('rate');
    expect(r.gapCounts.parcel).toBe(1);
    expect(r.shippingTotal).toBe(0);
  });

  it('没有包裹的单：仍按运价表估算，来源标 rate', () => {
    const r = computeOrderCosts({
      orders: [order()],
      skuWeights: skuW(100),
      rateTable: tinyTable(),
      parcelTotals: {},
    });
    expect(r.rows[0].shipping).toBeCloseTo(16, 2);
    expect(r.rows[0].shippingSource).toBe('rate');
    expect(r.rows[0].gaps).not.toContain('parcel');
  });
});

// ─────────────────────────────────────────────────────────── 平台费率（预测轨的费用近似）
//
// 为什么必须估：实测结算明细里**待结算行的费用列全是 0**（平台结算前不给），所以在途单的费用只能估。
// 纪律：没配费率 → **不扣、标 `platformFeeMissing`**（不按 0 算）；配了 → 扣 `收入 × 费率`。
// 参考实测值：剔除全额退款后 277 行 → 佣金 5.50% + 交易服务费 2.23% + 其余 ≈1.41% ≈ **9.14%**。
describe('平台费率（近似）', () => {
  const base = {
    skuWeights: skuW(100),
    rateTable: tinyTable(),
    orders: [order()],
  };

  it('没配费率 → 不扣、标 platformFeeMissing（毛利仍是未扣平台费的 139.18）', () => {
    const r = computeOrderCosts(base);
    expect(r.rows[0].platformFee).toBeNull();
    expect(r.platformFeeMissing).toBe(true);
    expect(r.platformFeeTotal).toBe(0);
    expect(r.rows[0].grossProfit).toBeCloseTo(139.18, 2);
  });

  it('配 9% → 平台费 = 收入 × 9%，毛利随之下降，标志转 false', () => {
    const r = computeOrderCosts({ ...base, platformFeeRatePercent: 9 });
    expect(r.rows[0].platformFee).toBeCloseTo(14.87, 2); // 165.18 × 9% = 14.8662
    expect(r.rows[0].grossProfit).toBeCloseTo(139.18 - 14.87, 2);
    expect(r.platformFeeTotal).toBeCloseTo(14.87, 2);
    expect(r.platformFeeMissing).toBe(false);
  });

  it('费率 0 / 负数 / 非数 → 视为未配置（不扣、不报错）', () => {
    for (const bad of [0, -3, Number.NaN]) {
      const r = computeOrderCosts({ ...base, platformFeeRatePercent: bad });
      expect(r.rows[0].platformFee).toBeNull();
      expect(r.platformFeeMissing).toBe(true);
    }
  });

  it('收入缺失时平台费也是 null（不凭空空估）', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [order({ amountCents: null })],
      platformFeeRatePercent: 9,
    });
    expect(r.rows[0].platformFee).toBeNull();
    expect(r.rows[0].grossProfit).toBeNull();
  });
});

// ─────────────────────────────────────────────────────────── 双轨：预测 / 精准
//
// 有平台结算数据（`ae_settle_lines` 的订单级聚合）→ 走**精准轨**：
//   精准毛利 = 净收入 − 商品成本 − 运费（净收入已扣平台费，本层不再估平台费、也不再另扣税）
// 没有 → 走**预测轨**（收入用订单金额、平台费按费率估）。
describe('双轨：预测 / 精准', () => {
  const base = {
    skuWeights: skuW(100),
    rateTable: tinyTable(),
    orders: [order()],
  };

  it('无结算数据 → 预测轨（精准字段为 null）', () => {
    const r = computeOrderCosts(base);
    expect(r.rows[0].tier).toBe('forecast');
    expect(r.rows[0].preciseNetIncome).toBeNull();
    expect(r.rows[0].preciseGrossProfit).toBeNull();
  });

  it('有结算数据 → 精准轨：精准毛利 = 净收入 − 运费 − 成本（不另扣平台费）', () => {
    const r = computeOrderCosts({
      ...base,
      platformFeeRatePercent: 9, // 预测轨会扣；精准轨**不应**再扣
      settleByOrder: { NO1: { netIncomeCents: 9086, settleStatus: '已结算' } },
    });
    const row = r.rows[0];
    expect(row.tier).toBe('precise');
    expect(row.preciseNetIncome).toBeCloseTo(90.86, 2);
    expect(row.preciseGrossProfit).toBeCloseTo(90.86 - 16 - 10, 2); // = 64.86
    // 预测轨的字段照常保留（页面可并列展示/对比）
    expect(row.grossProfit).toBeCloseTo(139.18 - 14.87, 2);
  });

  it('未配费率的订单若已结算 → 精准轨仍算得出（不依赖费率）', () => {
    const r = computeOrderCosts({
      ...base,
      settleByOrder: { NO1: { netIncomeCents: 9086, settleStatus: '已结算' } },
    });
    expect(r.platformFeeMissing).toBe(true); // 预测轨仍标"未扣"
    expect(r.rows[0].preciseGrossProfit).toBeCloseTo(64.86, 2); // 精准轨不受影响
  });

  it('结算数据在、但成本/运费缺 → 精准毛利为 null（不拿净收入当毛利）', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [order({ styleCode: '', costCents: null })],
      settleByOrder: { NO1: { netIncomeCents: 9086 } },
    });
    expect(r.rows[0].tier).toBe('precise');
    expect(r.rows[0].preciseNetIncome).toBeCloseTo(90.86, 2);
    expect(r.rows[0].preciseGrossProfit).toBeNull();
  });

  it('按订单号匹配：别的订单号的结算数据不影响本行', () => {
    const r = computeOrderCosts({
      ...base,
      settleByOrder: { OTHER: { netIncomeCents: 100 } },
    });
    expect(r.rows[0].tier).toBe('forecast');
  });
});

// ─────────────────────────────────────────────────────────── 按维度汇总（款 / 国家 / 桶）
//
// 口径两条：①**只统计非关闭单**（与汇总同口径；实测某批 2/3 是关闭单，混进每组都会虚高）；
//          ②**未识别款 / 缺国家 / 缺成本的行各自成组，不丢**（丢了会让"合计对不上"查不出来）。
describe('summarizeOrderCosts', () => {
  const base = { skuWeights: skuW(100), rateTable: tinyTable() };

  it('按款汇总：收入/成本/毛利 + 精准毛利', () => {
    const r = computeOrderCosts({
      ...base,
      skuWeights: { ...skuW(100, 'S1'), ...skuW(100, 'S2') },
      orders: [
        order({ id: 1, styleCode: 'S1' }),
        order({ id: 2, styleCode: 'S1', orderNo: 'NO2' }),
        order({ id: 3, styleCode: 'S2', orderNo: 'NO3', styleColor: '蓝', costCents: 2000 }),
      ],
      settleByOrder: { NO2: { netIncomeCents: 9086 } },
    });
    const byStyle = summarizeOrderCosts(r.rows, 'style');
    expect(byStyle).toHaveLength(2);
    const s1 = byStyle.find((g) => g.key === 'S1');
    expect(s1?.rows).toBe(2);
    expect(s1?.revenue).toBeCloseTo(165.18 * 2, 2);
    expect(s1?.cost).toBeCloseTo((16 + 10) * 2, 2);
    expect(s1?.preciseRows).toBe(1);
    expect(s1?.preciseGross).toBeCloseTo(90.86 - 26, 2);
    const s2 = byStyle.find((g) => g.key === 'S2');
    expect(s2?.cost).toBeCloseTo(16 + 20, 2);
  });

  it('关闭单不进合计（但它的行数仍计进该组，便于对照）', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [order({ id: 1 }), order({ id: 2, orderNo: 'NO2', bizStatus: '订单关闭' })],
    });
    const g = summarizeOrderCosts(r.rows, 'style')[0];
    expect(g.rows).toBe(2);
    expect(g.revenue).toBeCloseTo(165.18, 2); // 只有一单
  });

  it('按国家 / 按桶：未识别与缺的各自成组，不丢行', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [
        order({ id: 1, styleCode: '' }), // 未识别款
        order({ id: 2, orderNo: 'NO2', rawFields: { 商品ID: 'ITEM1' } }), // 缺国家
      ],
    });
    const byStyle = summarizeOrderCosts(r.rows, 'style');
    expect(byStyle.map((g) => g.key).sort()).toEqual(['(未识别款)', 'S1']);
    const byCountry = summarizeOrderCosts(r.rows, 'country');
    expect(byCountry.map((g) => g.key).sort()).toEqual(['(缺国家)', '美国']);
    expect(byCountry.reduce((s, g) => s + g.rows, 0)).toBe(2);
  });

  it('按桶：三桶都列出来（含 closed，便于单独核对）', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [
        order({ id: 1 }),
        order({ id: 2, orderNo: 'NO2', bizStatus: '订单关闭' }),
        order({ id: 3, orderNo: 'NO3', bizStatus: '等待买家收货' }),
      ],
    });
    const byBucket = summarizeOrderCosts(r.rows, 'bucket');
    expect(byBucket.map((g) => g.key).sort()).toEqual(['closed', 'completed', 'intransit']);
  });

  it('排序按毛利倒序；缺口行数单列', () => {
    const r = computeOrderCosts({
      ...base,
      skuWeights: { ...skuW(100, 'LOW'), ...skuW(100, 'HIGH') },
      orders: [
        order({ id: 1, styleCode: 'LOW', costCents: 10000 }),
        order({ id: 2, orderNo: 'NO2', styleCode: 'HIGH', costCents: 100 }),
      ],
    });
    const g = summarizeOrderCosts(r.rows, 'style');
    expect(g[0].key).toBe('HIGH'); // 成本低 → 毛利高 → 排前面
    expect(g.reduce((s, x) => s + x.gapRows, 0)).toBe(0);
  });

  it('空输入不炸', () => {
    expect(summarizeOrderCosts([], 'style')).toEqual([]);
    expect(summarizeOrderCosts(null, 'country')).toEqual([]);
  });
});

describe('summarizeOrderCosts：按店铺维度', () => {
  const base = { skuWeights: skuW(100), rateTable: tinyTable() };

  it('按店铺分组；未归属的自成一组（不丢行）', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [
        order({ id: 1, shop: '店A' }),
        order({ id: 2, orderNo: 'NO2', shop: '店A' }),
        order({ id: 3, orderNo: 'NO3', shop: '' }),
      ],
    });
    const g = summarizeOrderCosts(r.rows, 'shop');
    expect(g.map((x) => x.key).sort()).toEqual(['(未归属店铺)', '店A']);
    const a = g.find((x) => x.key === '店A');
    expect(a?.rows).toBe(2);
    expect(a?.revenue).toBeCloseTo(165.18 * 2, 2);
  });
});

// ─────────────────────────────────────────────────────────── 按 SKU（款×色×码）/ 按供应商
//
// SKU 维度是**取证用**的：色/码到底填得全不全，决定"拣货能不能做准"。缺哪段就把哪段写在 key 里，
// 于是"缺色 3 组"在统计表上肉眼可见（而不是静默合并成一组）。
describe('summarizeOrderCosts：按 SKU / 按供应商', () => {
  const base = { skuWeights: skuW(100), rateTable: tinyTable() };

  it('SKU 维度：同款同色同码合成一组；缺色/码各自成组并标出来', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [
        order({ id: 1, color: '黑', size: 'L' }),
        order({ id: 2, orderNo: 'NO2', color: '黑', size: 'L' }),
        order({ id: 3, orderNo: 'NO3', color: '', size: 'M' }), // 缺颜色
        order({ id: 4, orderNo: 'NO4', color: '黑', size: '' }), // 缺尺码
      ],
    });
    const g = summarizeOrderCosts(r.rows, 'sku');
    expect(g.map((x) => x.key).sort()).toEqual([
      'S1 · 黑 · L',
      'S1 · 黑 · (无尺码)',
      'S1 · (无颜色) · M',
    ].sort());
    const hit = g.find((x) => x.key === 'S1 · 黑 · L');
    expect(hit?.rows).toBe(2);
    // 不丢行：各组行数之和 = 总行数
    expect(g.reduce((s, x) => s + x.rows, 0)).toBe(4);
  });

  it('供应商维度：按 id 分组、显示名字（C2：关联用 ID，名字只展示）', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [
        order({ id: 1, supplierId: 7, supplierName: '厂A' }),
        order({ id: 2, orderNo: 'NO2', supplierId: 7, supplierName: '厂A' }),
        order({ id: 3, orderNo: 'NO3', supplierId: 0, supplierName: '' }),
      ],
    });
    const g = summarizeOrderCosts(r.rows, 'supplier');
    expect(g.map((x) => x.key).sort()).toEqual(['0', '7']);
    const a = g.find((x) => x.key === '7');
    expect(a?.label).toBe('厂A');
    expect(a?.rows).toBe(2);
    expect(g.find((x) => x.key === '0')?.label).toBe('(未识别供应商)');
  });

  it('空输入两个维度都不炸', () => {
    expect(summarizeOrderCosts([], 'sku')).toEqual([]);
    expect(summarizeOrderCosts([], 'supplier')).toEqual([]);
  });
});

// ─────────────────────────────────────────────────────────── 件数口径（P2）
//
// 件数是**拣货口径**（"这个 SKU 要拣几件"），来源优先级已裁定：
//   ① 结算明细商品行真值（仅当该 (订单,商品) 在结算表里**只有一行** —— 多行 = 同商品多 SKU，
//      把合计给到每一行会翻倍）；② 订单报表「商品信息」块内的 `商品数量`；③ 都没有 → 按 1 件并标缺。
// 同时钉住一条**刻意的口径**：件数不参与成本/运费/毛利算术（多件合并计费仍是开放项）。
describe('件数口径', () => {
  const base = { skuWeights: skuW(100), rateTable: tinyTable() };
  // 无件数：`商品信息` 显式给空串（列在但没有值 —— 与"列不存在"同一条判据：取不到就不猜）
  const noQtyFields = { 收货国家: '美国', 商品ID: 'ITEM1', 商品信息: '' };

  it('两处都没有件数 → 按 1 件 **并标 qty 缺口**（不静默）', () => {
    const r = computeOrderCosts({ ...base, orders: [order({ rawFields: noQtyFields })] });
    expect(r.rows[0].qty).toBe(1);
    expect(r.rows[0].qtySource).toBe('assumed');
    expect(r.rows[0].gaps).toContain('qty');
    expect(r.gapCounts.qty).toBe(1);
  });

  it('订单报表块内 `商品数量:2` → 件数 2（来源 order，无缺口）', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [order({ rawFields: { ...noQtyFields, 商品信息: `【1】 A\n(商品数量:2 piece)` } })],
    });
    expect(r.rows[0].qty).toBe(2);
    expect(r.rows[0].qtySource).toBe('order');
    expect(r.rows[0].gaps).not.toContain('qty');
  });

  it('结算真值优先：结算一行 qty=2，报表块写 3 → 取 2（平台口径为准）', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [order({ rawFields: { ...noQtyFields, 商品信息: `【1】 A\n(商品数量:3 piece)` } })],
      settleQty: { [settleQtyKey('NO1', 'ITEM1')]: { lines: 1, qty: 2 } },
    });
    expect(r.rows[0].qty).toBe(2);
    expect(r.rows[0].qtySource).toBe('settle');
  });

  it('结算里该 (订单,商品) 有多行（同商品多 SKU）→ 合计**不可逐行复用** → 回落报表的逐行值', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [order({ rawFields: { ...noQtyFields, 商品信息: `【1】 A\n(商品数量:1 piece)` } })],
      settleQty: { [settleQtyKey('NO1', 'ITEM1')]: { lines: 2, qty: 2 } },
    });
    expect(r.rows[0].qty).toBe(1);
    expect(r.rows[0].qtySource).toBe('order');
  });

  it('结算件数按订单号+商品ID 匹配：别的订单号/商品ID 不影响本行', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [order({ rawFields: noQtyFields })],
      settleQty: {
        [settleQtyKey('NO9', 'ITEM1')]: { lines: 1, qty: 5 },
        [settleQtyKey('NO1', 'ITEM9')]: { lines: 1, qty: 5 },
      },
    });
    expect(r.rows[0].qty).toBe(1);
    expect(r.rows[0].qtySource).toBe('assumed');
  });

  it('**件数不进算术**：qty=2 与 qty=1 的运费/成本/合计/毛利逐项相同（口径待定，先别偷偷放大）', () => {
    const one = computeOrderCosts({ ...base, orders: [order({ rawFields: noQtyFields })] }).rows[0];
    const two = computeOrderCosts({
      ...base,
      orders: [order({ rawFields: { ...noQtyFields, 商品信息: `【1】 A\n(商品数量:2 piece)` } })],
    }).rows[0];
    expect(two.qty).toBe(2);
    expect(two.shipping).toBe(one.shipping);
    expect(two.productCost).toBe(one.productCost);
    expect(two.total).toBe(one.total);
    expect(two.grossProfit).toBe(one.grossProfit);
    expect(two.preciseGrossProfit).toBe(one.preciseGrossProfit);
  });

  it('统计的分组件数 = 组内各件数之和；关闭单不进（与收入/成本同口径）', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [
        order({ id: 1, rawFields: { ...noQtyFields, 商品信息: `【1】 A\n(商品数量:2 piece)` } }),
        order({
          id: 2,
          orderNo: 'NO2',
          rawFields: { ...noQtyFields, 商品信息: `【1】 A\n(商品数量:3 piece)` },
        }),
        order({
          id: 3,
          orderNo: 'NO3',
          bizStatus: '订单关闭',
          rawFields: { ...noQtyFields, 商品信息: `【1】 A\n(商品数量:9 piece)` },
        }),
      ],
    });
    const g = summarizeOrderCosts(r.rows, 'style')[0];
    expect(g.rows).toBe(3);
    expect(g.pieces).toBe(5); // 2 + 3，关闭单的 9 件不进
  });

  it('settleQty 空 / 缺省都不炸', () => {
    expect(
      computeOrderCosts({ ...base, orders: [order()], settleQty: {} }).rows[0].qty,
    ).toBe(1);
    expect(
      computeOrderCosts({ ...base, orders: [order()], settleQty: null }).rows[0].qty,
    ).toBe(1);
  });
});

// ─────────────────────────────────────────────────────────── 双摄取（C1 合并）：来源标记 + 税口径可见默认
//
// 两条链（Excel 导入 / 浏览器采集）进**同一模型**后，页面上必须能一眼分清每行来自哪条通道，
// 且采集侧"没有代征代缴列"这个缺口不能用"猜一个默认"糊过去 —— 默认只作用于**自己没说**的行，
// 并且**写在界面上**（`taxDefault`），行自己的声明永远优先。
describe('来源标记与税口径默认（C1 合并）', () => {
  const base = { skuWeights: skuW(100), rateTable: tinyTable() };

  it('逐行带 source：缺省按 import；显式 collect 标出来', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [order({ id: 1 }), order({ id: 2, orderNo: 'NO2', source: 'collect' })],
    });
    expect(r.rows[0].source).toBe('import');
    expect(r.rows[1].source).toBe('collect');
    expect(r.sourceCounts).toEqual({ import: 1, collect: 1 });
  });

  it('税：行自己声明优先（平台已税 → 确定的 0），不受 taxDefault 影响', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [order({ taxPlatform: '平台已税' })],
      taxDefault: 'unknown',
    });
    expect(r.rows[0].taxCost).toBe(0);
    expect(r.rows[0].gaps).not.toContain('tax');
  });

  it('税：行没说 + taxDefault=platform → 记确定的 0（采集侧因此能算出毛利）', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [order({ rawFields: { 收货国家: '美国', 商品ID: 'ITEM1' }, taxPlatform: '' })],
      taxDefault: 'platform',
    });
    expect(r.rows[0].taxCost).toBe(0);
    expect(r.rows[0].gaps).not.toContain('tax');
    expect(r.rows[0].grossProfit).not.toBeNull();
  });

  it('税：行没说 + 没给默认（或默认 unknown）→ 标 tax 缺口、毛利 null（**不按 0 算**）', () => {
    const silent = { rawFields: { 收货国家: '美国', 商品ID: 'ITEM1' }, taxPlatform: '' };
    for (const taxDefault of [undefined, 'unknown' as const]) {
      const r = computeOrderCosts({ ...base, orders: [order(silent)], taxDefault });
      expect(r.rows[0].taxCost).toBeNull();
      expect(r.rows[0].gaps).toContain('tax');
      expect(r.rows[0].grossProfit).toBeNull();
    }
  });

  it('税：行明确自缴时**不**被默认盖掉（默认只补"没说"的）', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [order({ taxPlatform: '商家自缴' })],
      taxDefault: 'platform',
    });
    expect(r.rows[0].taxCost).toBeCloseTo(34.69 + 22.94, 2);
  });
});

describe('件数：源直接给的件数（采集行真值）', () => {
  const base = { skuWeights: skuW(100), rateTable: tinyTable() };

  it('行带 qty → 用它（来源 order），**不去解析文本也不标缺件数**', () => {
    const r = computeOrderCosts({
      ...base,
      orders: [
        order({
          source: 'collect',
          qty: 3,
          rawFields: { 商品信息: '' }, // 采集帧没有"商品信息"块 —— 不该因此标缺件数
        }),
      ],
    });
    expect(r.rows[0].qty).toBe(3);
    expect(r.rows[0].qtySource).toBe('order');
    expect(r.rows[0].gaps).not.toContain('qty');
  });

  it('结算真值仍然优先于行自带的 qty（平台结算口径 > 源采集口径）', () => {
    const r = computeOrderCosts({
      ...base,
      // 结算查表键是 `(订单号, 商品ID)` —— 商品ID 要从 rawFields 里取得到，否则根本查不中
      orders: [order({ orderNo: 'C1', qty: 5, rawFields: { 商品ID: 'ITEM1' } })],
      settleQty: { [settleQtyKey('C1', 'ITEM1')]: { lines: 1, qty: 2 } },
    });
    expect(r.rows[0].qty).toBe(2);
    expect(r.rows[0].qtySource).toBe('settle');
  });

  it('qty 非法（0 / 负 / 非数）→ 回落后续判据（不把 0 件当件数）', () => {
    for (const bad of [0, -2, null, 'abc']) {
      const r = computeOrderCosts({ ...base, orders: [order({ qty: bad as number })] });
      expect(r.rows[0].qty).toBe(1);
      expect(r.rows[0].qtySource).toBe('order'); // 回落报表块（该行默认带 1 piece 的块）
    }
  });
});

// ─────────────────────────────────────────────────────────── 时间趋势（C9：补上岛「利润统计」的独有内容）
describe('trendOf：按月 / 按日（只统计非关闭单）', () => {
  const base = { skuWeights: skuW(100), rateTable: tinyTable() };
  const rowsOf = (orders: ReturnType<typeof order>[]) => computeOrderCosts({ ...base, orders }).rows;

  it('按月归档：收入/成本/毛利逐桶合计，只含非关闭单', () => {
    const rows = rowsOf([
      order({ id: 1, orderNo: 'A', orderTime: '2026-08-10 10:00:00' }),
      order({ id: 2, orderNo: 'B', orderTime: '2026-09-10 10:00:00' }),
      order({ id: 3, orderNo: 'C', orderTime: '2026-09-20 10:00:00' }),
      order({ id: 4, orderNo: 'D', orderTime: '2026-09-25 10:00:00', bizStatus: '订单关闭' }),
    ]);
    const t = trendOf(rows, 'month');
    expect(t.map((x) => x.bucket)).toEqual(['2026-08', '2026-09']);
    expect(t[0].rows).toBe(1);
    expect(t[1].rows).toBe(2); // 关闭单不进
    expect(t[1].revenue).toBeCloseTo(165.18 * 2, 2);
    expect(t[1].gross).toBeCloseTo(139.18 * 2, 2);
  });

  it('按日归档，且日期认不出的行单独进 `(无日期)` 桶并排最后', () => {
    const rows = rowsOf([
      order({ id: 1, orderNo: 'A', orderTime: '2026-09-10 10:00:00' }),
      order({ id: 2, orderNo: 'B', orderTime: '' }),
      order({ id: 3, orderNo: 'C', orderTime: '2026-09-10 11:00:00' }),
    ]);
    const t = trendOf(rows, 'day');
    expect(t.map((x) => x.bucket)).toEqual(['2026-09-10', '(无日期)']);
    expect(t[0].rows).toBe(2);
    expect(t[1].rows).toBe(1);
  });

  it('精准轨单独计入该桶（不混进预测毛利）', () => {
    const rows = computeOrderCosts({
      ...base,
      orders: [order({ orderNo: 'A', orderTime: '2026-09-10 10:00:00' })],
      settleByOrder: { A: { netIncomeCents: 9086 } },
    }).rows;
    const [p] = trendOf(rows, 'month');
    expect(p.preciseRows).toBe(1);
    expect(p.preciseGross).toBeCloseTo(90.86 - 26, 2);
  });

  it('空输入 / null 不炸', () => {
    expect(trendOf([], 'month')).toEqual([]);
    expect(trendOf(null, 'day')).toEqual([]);
  });
});

// ───────────────────────────────────────── 行级两字段：实际 > 预估 > 缺（C2，2026-10-21）
//
// 成本**只**取订单行自己钉的两个快照，次序不能反：
//   · `actualCostCents`（`oi_order_items.actual_cost_cents`，拿货落账回写的实付真值）先赢；
//   · 没有实际进价才用 `costCents`（`oi_order_items.cost_cents`，归类确认时按产品当时价钉的预估）；
//   · 两者都没有 → 缺，**不按 0 算、也不回查产品当前价**（回查会让改价改写历史利润）。
// 克重同理：`oi_order_items.weight_g`（确认时钉的快照）优先于现查产品库 SKU。
describe('computeOrderCosts：行级快照（A7 / C2）', () => {
  it('克重快照优先：行上有 weightG 就不查 SKU（干扰项 900g 不该生效）', () => {
    const r = computeOrderCosts({
      orders: [order({ weightG: 100 })],
      skuWeights: skuW(900),
      rateTable: tinyTable(),
    });
    expect(r.rows[0].weightG).toBe(100);
    expect(r.rows[0].weightSource).toBe('snapshot');
    expect(r.rows[0].shipping).toBeCloseTo(16, 2); // 100g × 80/kg = 8 + 挂号 8
  });

  it('快照缺失或为 0 → 回落 SKU 查表（0 不是"零克重"）', () => {
    for (const w of [null, undefined, 0]) {
      const r = computeOrderCosts({
        orders: [order({ weightG: w })],
        skuWeights: skuW(100),
        rateTable: tinyTable(),
      });
      expect(r.rows[0].weightG).toBe(100);
      expect(r.rows[0].weightSource).toBe('lookup');
    }
  });

  it('实际进价优先：两个字段都有 → 用实际进价（预估只作干扰）', () => {
    const r = computeOrderCosts({
      orders: [order({ costCents: 800, actualCostCents: 1200 })],
      skuWeights: skuW(100),
      rateTable: tinyTable(),
    });
    expect(r.rows[0].productCost).toBe(12);
    expect(r.rows[0].costSource).toBe('snapshot');
    expect(r.rows[0].gaps).toEqual([]);
  });

  it('没有实际进价 → 用进价预估（costSource=estimate）', () => {
    const r = computeOrderCosts({
      orders: [order({ costCents: 1200 })],
      skuWeights: skuW(100),
      rateTable: tinyTable(),
    });
    expect(r.rows[0].productCost).toBe(12);
    expect(r.rows[0].costSource).toBe('estimate');
    expect(r.rows[0].gaps).toEqual([]);
  });

  it('实际进价为 0 / 空 → 回落预估（0 不是"免费"，也不遮蔽预估）', () => {
    for (const a of [0, null, undefined]) {
      const r = computeOrderCosts({
        orders: [order({ costCents: 900, actualCostCents: a })],
        skuWeights: skuW(100),
        rateTable: tinyTable(),
      });
      expect(r.rows[0].productCost).toBe(9);
      expect(r.rows[0].costSource).toBe('estimate');
    }
  });

  it('两个字段都空 → 标「缺成本」且 costSource=none（不按 0 算）', () => {
    for (const c of [0, null, undefined]) {
      const r = computeOrderCosts({
        orders: [order({ costCents: c, actualCostCents: c })],
        skuWeights: skuW(100),
        rateTable: tinyTable(),
      });
      expect(r.rows[0].productCost).toBeNull();
      expect(r.rows[0].costSource).toBe('none');
      expect(r.rows[0].gaps).toContain('cost');
      expect(r.rows[0].total).toBeNull();
    }
  });

  it('成本快照不依赖款编码：行上钉了价，未识别款也照样有成本（只影响克重/运费）', () => {
    // C2 之前成本按款去价目表查，款认不出来就必然缺；现在价钉在**行**上，
    // 款识别与成本是两件事 —— 这条守住"别再偷偷回查款级表"。
    const r = computeOrderCosts({
      orders: [order({ styleCode: '', costCents: 1500 })],
      skuWeights: skuW(100),
      rateTable: tinyTable(),
    });
    expect(r.rows[0].productCost).toBe(15);
    expect(r.rows[0].costSource).toBe('estimate');
    expect(r.rows[0].gaps).toContain('style');
    expect(r.rows[0].gaps).not.toContain('cost');
  });

  it('不改写历史：同样的行，产品当前价（无论多少）不参与本层计算', () => {
    // 本层入参根本没有"产品当前价"这一项 —— 这个用例是**结构性**的：
    // 若以后有人加回 `costs` / `productCosts` 之类的入口，这里补的干扰项才有意义。
    const r = computeOrderCosts({
      orders: [order({ costCents: 1200 })],
      skuWeights: skuW(100),
      rateTable: tinyTable(),
    });
    expect(r.rows[0].productCost).toBe(12);
  });
});
