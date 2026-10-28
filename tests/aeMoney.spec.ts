// 「采集订单」金额口径纯层的契约用例（`electron/aeMoney.ts`）。
//
// 钉住的是**口径**而不是实现（这条链此前只有 `ae-engine` 内联实现，进不了 vitest）：
//   · 收入 = 商品金额 + 买家付运费 − 退款（退款科目集只有一份）；
//   · 行收入**按行金额占比**分摊（行金额缺失才回落 qty，再不行平分）—— 一律按 qty 会把
//     「1 件 198 元 + 1 件 12 元」摊成各半；
//   · 汇率为 0 / 缺失 → `null`（**不要折成 0**：0 会让"缺汇率"看起来像"这笔钱是零"）；
//   · `skuProps` 只解析**能确定**的（认不出就空串，由上层标缺口）。
import { describe, expect, it } from 'vitest';
import {
  AE_DEDUCTION_CATEGORIES,
  lineIncomeShares,
  normalizeSkuSize,
  orderIncomeCcy,
  parseOrderPropsColor,
  parseSkuProps,
  propsColorTokens,
  toCentsCny,
} from '../electron/aeMoney';

describe('orderIncomeCcy：收入（原币）', () => {
  it('商品金额 + 买家付运费 − 退款', () => {
    expect(orderIncomeCcy({ goodsAmount: 153.64, shippingIncome: 0, deductionAmount: 0 })).toBeCloseTo(153.64, 6);
    expect(orderIncomeCcy({ goodsAmount: 100, shippingIncome: 12.5, deductionAmount: 30 })).toBeCloseTo(82.5, 6);
  });

  it('缺字段按 0 参与（采集帧可能没给运费/退款列）', () => {
    expect(orderIncomeCcy({ goodsAmount: 50 })).toBeCloseTo(50, 6);
    expect(orderIncomeCcy({})).toBe(0);
  });

  it('退款科目集只有一份（大小写敏感，未知科目不算退款）', () => {
    expect([...AE_DEDUCTION_CATEGORIES].sort()).toEqual(['dispute', 'refund', 'refund_amount']);
    expect(AE_DEDUCTION_CATEGORIES.has('Refund')).toBe(false);
  });
});

describe('lineIncomeShares：行收入分摊', () => {
  it('按行金额占比（198.29 + 199.87 的两行 → 各拿自己那一份）', () => {
    const s = lineIncomeShares(
      [{ qty: 1, goodsAmount: 198.29 }, { qty: 1, goodsAmount: 199.87 }],
      400,
    );
    expect(s[0]).toBeCloseTo(400 * (198.29 / 398.16), 6);
    expect(s[1]).toBeCloseTo(400 * (199.87 / 398.16), 6);
    expect(s[0] + s[1]).toBeCloseTo(400, 6);
  });

  it('**不再一律按 qty**：同 qty 不同价时，贵的行拿得多', () => {
    const s = lineIncomeShares([{ qty: 1, goodsAmount: 198 }, { qty: 1, goodsAmount: 12 }], 210);
    expect(s[0]).toBeGreaterThan(s[1]);
    expect(s[0]).toBeCloseTo(198, 6);
  });

  it('行金额全缺失 → 回落按 qty 占比', () => {
    const s = lineIncomeShares([{ qty: 3, goodsAmount: 0 }, { qty: 1, goodsAmount: 0 }], 80);
    expect(s[0]).toBeCloseTo(60, 6);
    expect(s[1]).toBeCloseTo(20, 6);
  });

  it('金额与 qty 都不可用 → 平分（Σ 恒等于订单收入，不吞钱不生钱）', () => {
    const s = lineIncomeShares([{}, {}, {}], 90);
    expect(s).toEqual([30, 30, 30]);
    expect(s.reduce((a, b) => a + b, 0)).toBeCloseTo(90, 6);
  });

  it('空输入 → 空数组（一单零行由调用方另行处理）', () => {
    expect(lineIncomeShares([], 100)).toEqual([]);
    expect(lineIncomeShares(null, 100)).toEqual([]);
  });
});

describe('parseSkuProps：规格串 → 颜色 / 尺码 / 发货地', () => {
  it('采集帧写法 `Picture color+XXXL+China Mainland`', () => {
    expect(parseSkuProps('Picture color+XXXL+China Mainland')).toEqual({
      color: 'Picture color',
      size: 'XXXL',
      shipsFrom: 'China Mainland',
    });
  });

  it('键值写法 `Color:Red;Size:L`', () => {
    expect(parseSkuProps('Color:Red;Size:L')).toEqual({ color: 'Red', size: 'L', shipsFrom: '' });
  });

  it('只有尺码的写法（颜色留空，不猜）', () => {
    expect(parseSkuProps('Picture color+XXL')).toEqual({ color: 'Picture color', size: 'XXL', shipsFrom: '' });
  });

  it('认不出 / 空 → 全空串（由上层标缺口）', () => {
    expect(parseSkuProps('')).toEqual({ color: '', size: '', shipsFrom: '' });
    expect(parseSkuProps(null)).toEqual({ color: '', size: '', shipsFrom: '' });
    expect(parseSkuProps('某种没有分隔符的描述')).toEqual({ color: '', size: '', shipsFrom: '' });
  });
});

// 报表规格串 → 平台色名（2026-10-20）。真库取证：51 单里 49 单「产品信息」只含一个 Color，
// 2 单（同一张订单含 4 个 SKU 行）含两个 —— 一单多色必须**定不出来**，取第一个就是静默错色。
describe('parseOrderPropsColor：报表一行 → 平台色名', () => {
  /** 真库原文（截取）：标题 + `(产品属性:Color:5,Size:5XL,Ships From:China Mainland)` */
  const report = (props: string) =>
    `【1】Men's Fashion Thickened Jacket, New Autumn and Winter Warm Parka\n(${props})\n(产品数量:1 piece)\n`;

  it('产品属性里的 `Color:5` → 平台色名（真库 49/51 单的形态）', () => {
    expect(
      parseOrderPropsColor({
        产品信息: report('产品属性:Color:5,Size:5XL,Ships From:China Mainland'),
        产品ID: '1005012742360018',
      }),
    ).toBe('5');
  });

  it('属性顺序不固定（`Size` 在前）也认得出', () => {
    expect(
      parseOrderPropsColor({ 产品信息: report('产品属性:Size:XXL,Color:1,Ships From:China Mainland') }),
    ).toBe('1');
  });

  it('非数字色名与全角冒号（`Khaki` / `Color：7`）', () => {
    expect(parseOrderPropsColor({ 产品信息: report('产品属性:Color:Khaki,Size:M') })).toBe('Khaki');
    expect(parseOrderPropsColor({ 产品信息: report('产品属性:Color：7,Size:M') })).toBe('7');
    expect(parseOrderPropsColor({ 产品信息: report('产品属性:Color:Picture color4,Size:L)') })).toBe(
      'Picture color4',
    );
  });

  it('同一颜色在多行 SKU 里重复 → 仍是唯一色', () => {
    const text =
      report('产品属性:Color:10,Size:XL') +
      '【2】同一个商品\n(产品属性:Color:10,Size:XXL)\n【3】同一个商品\n(产品属性:Color:10,Size:XXXL)';
    expect(parseOrderPropsColor({ 产品信息: text })).toBe('10');
  });

  it('只差大小写/空白算同一个色（保留首次出现的写法）', () => {
    const text = report('产品属性:Color:Khaki,Size:M') + '【2】x\n(产品属性:Color: khaki ,Size:L)';
    expect(parseOrderPropsColor({ 产品信息: text })).toBe('Khaki');
  });

  it('一单多色 → 空串（不取第一个：宁可不归色，也不发错色）', () => {
    const text =
      report('产品属性:Color:10,Size:XL') +
      '【2】x\n(产品属性:Color:6,Size:XL)\n' +
      '【3】x\n(产品属性:Color:10,Size:XXL)';
    expect(parseOrderPropsColor({ 产品信息: text })).toBe('');
  });

  it('独立的「颜色」列优先（一列一值，天然没歧义）', () => {
    expect(
      parseOrderPropsColor({ 颜色: '卡其', 产品信息: report('产品属性:Color:5,Size:M') }),
    ).toBe('卡其');
    // 列存在但本行为空 → 回落规格串
    expect(parseOrderPropsColor({ 颜色: '  ', 产品信息: report('产品属性:Color:5,Size:M') })).toBe('5');
  });

  it('没有规格串 / 采集帧那种 `+` 分隔串 → 空串（那一路由 `parseSkuProps` 负责）', () => {
    expect(parseOrderPropsColor({})).toBe('');
    expect(parseOrderPropsColor(null)).toBe('');
    expect(parseOrderPropsColor({ 产品信息: 'Picture color+XXXL+China Mainland' })).toBe('');
    // 规格串在无关列里（标题）不算 —— 只认承载规格的那几列
    expect(parseOrderPropsColor({ 备注: '(产品属性:Color:5,Size:M)' })).toBe('');
  });

  it('propsColorTokens：一段文本里的**全部** Color 值（判断歧义要看到每一个）', () => {
    expect(propsColorTokens('(产品属性:Color:10,Size:XL) (产品属性:Color:6,Size:M)')).toEqual(['10', '6']);
    expect(propsColorTokens('Colour:Red;Color:Blue')).toEqual(['Red', 'Blue']);
    expect(propsColorTokens('')).toEqual([]);
  });
});

describe('normalizeSkuSize：采集尺码剥修饰（真库 546 条取证）', () => {
  // 下面三条输入**必须得到不同的结果**：若实现是"一律返回同一个值"（或干脆返回 ''），
  // 只断言"某一条变成了 S"就会恒绿 —— 所以每条都配一个"不该被动的纯码"做对照。
  it('体重区间后缀剥掉：`XL 60-65kg` → `XL`（含 7XL 这种两位数）', () => {
    expect(normalizeSkuSize('XL 60-65kg')).toBe('XL');
    expect(normalizeSkuSize('S 35-40kg')).toBe('S');
    expect(normalizeSkuSize('7XL 105-115kg')).toBe('7XL');
    expect(normalizeSkuSize('4XL 80-85kg')).toBe('4XL');
    // 对照：本来就是纯码的不能被顺手改成别的
    expect(normalizeSkuSize('XXL')).toBe('XXL');
    expect(normalizeSkuSize('5XL')).toBe('5XL');
  });

  it('版型前缀剥掉：`Asian size XXXL` → `XXXL`（大小写不敏感）', () => {
    expect(normalizeSkuSize('Asian size XXXL')).toBe('XXXL');
    expect(normalizeSkuSize('Asian size 4XL')).toBe('4XL');
    expect(normalizeSkuSize('asian size M')).toBe('M');
    expect(normalizeSkuSize('Size: L')).toBe('L');
    expect(normalizeSkuSize('尺码：XL')).toBe('XL');
  });

  it('无数字的括号补注剥掉：`XS（old）` → `XS`（全角括号也认）', () => {
    expect(normalizeSkuSize('XS（old）')).toBe('XS');
    expect(normalizeSkuSize('XS(old)')).toBe('XS');
    expect(normalizeSkuSize('L [旧版]')).toBe('L');
  });

  it('⭐ 括号里含数字就不剥 —— 年龄段正是童装用来区分变体的（剥了会把两个变体并成一格）', () => {
    expect(normalizeSkuSize('S (2-3 years)')).toBe('S (2-3 years)');
    expect(normalizeSkuSize('M（4-5岁）')).toBe('M（4-5岁）');
  });

  it('⭐ 只剥已知修饰，不校验"像不像尺码"：不认识的码原样留着（黑名单校验会误伤）', () => {
    for (const s of ['70B', '2T', '28W', '均码', 'One Size', 'XL-XXL', '42.5', 'XXL / Tall']) {
      expect(normalizeSkuSize(s), `不该动：${s}`).toBe(s);
    }
  });

  it('剥空 ⇒ 保留原文（宁可脏，也不把"有尺码"变成"没尺码"）', () => {
    expect(normalizeSkuSize('(old)')).toBe('(old)');
    expect(normalizeSkuSize('Asian size')).toBe('Asian size');
    expect(normalizeSkuSize('  ')).toBe('');
    expect(normalizeSkuSize('')).toBe('');
    expect(normalizeSkuSize(null)).toBe('');
    expect(normalizeSkuSize(undefined)).toBe('');
  });

  it('小写/全角码统一成大写码（`xxl` 与 `XXL` 必须是矩阵里的同一列）', () => {
    expect(normalizeSkuSize('xxl')).toBe('XXL');
    expect(normalizeSkuSize('２ＸＬ')).toBe('2XL');
    expect(normalizeSkuSize('m')).toBe('M');
  });

  it('幂等：已归一的输入再走一遍不变（界面改过的值会二次经过这里）', () => {
    for (const s of ['XL 60-65kg', 'Asian size XXXL', 'XS（old）', '  L   ']) {
      const once = normalizeSkuSize(s);
      expect(normalizeSkuSize(once), `二次归一必须稳定：${s} → ${once}`).toBe(once);
    }
  });
});

describe('toCentsCny：原币 → 分', () => {  it('× 汇率 × 100 并四舍五入到分', () => {
    expect(toCentsCny(12.34, 7.2)).toBe(8885); // 88.848 → 8884.8 → 8885
    expect(toCentsCny(1, 1)).toBe(100);
    expect(toCentsCny(153.64, 1)).toBe(15364);
  });

  it('汇率缺失 / 0 / 负数 → null（**不是 0**）', () => {
    expect(toCentsCny(100, 0)).toBeNull();
    expect(toCentsCny(100, undefined)).toBeNull();
    expect(toCentsCny(100, -1)).toBeNull();
  });
});