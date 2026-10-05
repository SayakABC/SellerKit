// shipRateProducts 单测 —— 按产品试算的纯函数半场。
//
// 与 shipRateOrders.spec.ts 同一套纪律：计价口径（pickCard/computeFee/拒算）由
// shipRate.spec.ts 钉住，本文件只测产品侧衔接 —— 尤其是拒算分类必须**钉在行上**
// （对称交换两个计数器不破坏 Σ=total 的汇总断言，逐行 reasonClass 才是真守卫）。
import { describe, it, expect } from 'vitest';
import { quoteProducts, type ProductQuoteInput } from '../src/lib/shipRateProducts';
import type { RateTable } from '../src/lib/shipRate';
import { quoteAll } from '../src/lib/shipRateQuote';

/** 最小合成运价表：US 一张 CNY 卡（0–2000g）+ GB 一张 USD 卡 + RU 大包段 */
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
      {
        code: 'GB',
        nameCn: '英国',
        nameEn: 'United Kingdom',
        cards: [
          {
            minG: 0,
            maxG: 2000,
            categories: ['any'],
            mode: 'perKg',
            ratePerKg: 66.2,
            registerFee: 19.2,
            firstFee: 0,
            stepFee: 0,
            baseG: 0,
            stepG: 0,
            variant: '',
            sec: 1,
            currency: 'USD',
            minChargeG: 0,
          },
        ],
      },
      {
        code: 'RU',
        nameCn: '俄罗斯',
        nameEn: 'Russia',
        cards: [
          {
            minG: 2001,
            maxG: 30000,
            categories: ['bulk'],
            mode: 'perKg',
            ratePerKg: 44,
            registerFee: 0,
            firstFee: 0,
            stepFee: 0,
            baseG: 0,
            stepG: 0,
            variant: '',
            sec: 1,
            currency: 'CNY',
            minChargeG: 0,
          },
        ],
      },
    ],
    sections: [],
    stats: {
      sections: 1,
      countries: 3,
      cards: 3,
      perKgCards: 3,
      firstStepCards: 0,
      currencies: ['CNY', 'USD'],
    },
    warnings: [],
  };
}

const item = (over: Partial<ProductQuoteInput>): ProductQuoteInput => ({
  productId: 1,
  code: 'V-001',
  name: '连衣裙',
  skuLabel: '红色 M',
  weightG: 500,
  ...over,
});

describe('quoteProducts · 逐 SKU 计价', () => {
  it('正常 SKU：80 元/KG × 500g + 挂号 8 = 48，国家信息随行回传', () => {
    const { rows, summary } = quoteProducts(tinyTable(), '美国', [item({})]);
    expect(summary.ok).toBe(1);
    expect(rows[0].fee).toBe(48);
    expect(rows[0].countryCode).toBe('US');
    expect(rows[0].nameCn).toBe('美国');
  });

  it('目的国可以用中文名 / 英文名 / ISO 三种写法点名，解析只做一次', () => {
    for (const c of ['United States', 'US']) {
      const { rows } = quoteProducts(tinyTable(), c, [item({})]);
      expect(rows[0].ok).toBe(true);
    }
  });

  it('目的国表里没有 → 整批抛错（国家来自表自身下拉，静默改判会掩盖真 bug）', () => {
    expect(() => quoteProducts(tinyTable(), '火星', [item({})])).toThrow(/火星/);
    expect(() => quoteProducts(tinyTable(), '', [item({})])).toThrow();
  });

  it('SKU 克重缺失单独成行（不冒充"无价"），reason 带 SKU 标签指引去产品库补', () => {
    const { rows, summary } = quoteProducts(tinyTable(), '美国', [
      item({ productId: 1, skuLabel: '红色 M', weightG: null }),
      item({ productId: 2, skuLabel: '', weightG: null, code: 'V-002' }), // 没建 SKU 的款式
    ]);
    expect(summary.noWeight).toBe(2);
    expect(rows[0].reasonClass).toBe('noWeight');
    expect(rows[0].reason).toContain('红色 M');
    expect(rows[1].reasonClass).toBe('noWeight');
  });

  it('重量段无价 / 非本币拒算分开计数，reasonClass 与行一一绑定', () => {
    const { rows, summary } = quoteProducts(tinyTable(), '美国', [
      item({ productId: 1, weightG: 999999 }), // 超出全部档位
    ]);
    const gb = quoteProducts(tinyTable(), '英国', [item({ weightG: 500 })]); // USD 卡 → 拒算
    expect(summary.noPrice).toBe(1);
    expect(rows[0].reasonClass).toBe('noPrice');
    expect(gb.summary.refused).toBe(1);
    expect(gb.rows[0].reasonClass).toBe('refused');
  });

  it('最低计费重量生效：5g 抬到 10g 起计', () => {
    const { rows } = quoteProducts(tinyTable(), '美国', [item({ weightG: 5 })]);
    expect(rows[0].fee).toBeCloseTo(80 * (10 / 1000) + 8, 2);
  });

  it('混合批次：summary 各类互斥且 Σ = total', () => {
    const { summary } = quoteProducts(tinyTable(), '美国', [
      item({ productId: 1 }),
      item({ productId: 2, weightG: null }),
      item({ productId: 3, weightG: 999999 }),
      item({ productId: 4, weightG: 0 }),
    ]);
    expect(summary.total).toBe(4);
    const Σ = summary.ok + summary.noWeight + summary.unknownCountry + summary.noPrice + summary.refused;
    expect(Σ).toBe(summary.total);
  });

  it('空输入：返回空 rows 与全零 summary（不抛错）', () => {
    const { rows, summary } = quoteProducts(tinyTable(), '美国', []);
    expect(rows).toEqual([]);
    expect(summary.total).toBe(0);
  });
});
