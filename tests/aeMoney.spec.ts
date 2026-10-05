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
  orderIncomeCcy,
  parseSkuProps,
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

describe('toCentsCny：原币 → 分', () => {
  it('× 汇率 × 100 并四舍五入到分', () => {
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