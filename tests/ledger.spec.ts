// 记账分摊引擎单测（`src/lib/ledger.ts`）。
//
// 为什么这组用例必须存在（而不是"跑一次手工验证就行"）：
//   这是整个记账功能里**唯一**有正确性风险的计算。它的失效方式全是**静默算错**——
//   不抛异常、界面照常出数，只是某家店多摊了几分钱、或者某个月的总账对不上。
//   事后既查不出是哪一笔错的，也没有任何界面提示。
//
// 故三类断言缺一不可：
//   ① **守恒**：`Σ 分摊 == 条目金额`，一分不差（RK-05）；
//   ② **具体值**：3 / 7 / 11 家与 1 分钱的边界，断言到"哪一家拿到那 1 分"——
//      只断言"合计对"抓不住"补给了错的那家"；
//   ③ **该拒绝的要拒绝**：权重为 0 的店不能凭空分到钱、比例合计不足不能自动补齐。
import { describe, it, expect } from 'vitest';
import {
  computeAllocations,
  conservationGap,
  allocationsEqual,
  defaultBizDate,
  periodOf,
  isValidBizDate,
  formatCents,
  parseYuanToCents,
  LEDGER_BASES,
  MAX_ALLOC_AMOUNT_CENTS,
  type AllocationRow,
} from '../src/lib/ledger';

/** 合计（用例里反复用，避免每处手写 reduce） */
const sum = (rows: readonly AllocationRow[]) => rows.reduce((s, r) => s + r.amountCents, 0);

describe('平均分摊（equal）', () => {
  it('3 家店摊 100 分：最小 id 拿尾差（最大余数法 + 平局按 id 升序）', () => {
    const r = computeAllocations(100, 'equal', [{ shopId: 7 }, { shopId: 3 }, { shopId: 5 }]);
    expect(r.fallback).toBe(false);
    expect(r.rows).toEqual([
      { shopId: 3, amountCents: 34, ratioBp: 3333 },
      { shopId: 5, amountCents: 33, ratioBp: 3333 },
      { shopId: 7, amountCents: 33, ratioBp: 3333 },
    ]);
    expect(sum(r.rows)).toBe(100);
  });

  it('7 家店摊 100 分：前 2 家各 15、其余 14，合计仍是 100', () => {
    const shops = [11, 12, 13, 14, 15, 16, 17].map((shopId) => ({ shopId }));
    const r = computeAllocations(100, 'equal', shops);
    expect(r.rows.map((x) => x.amountCents)).toEqual([15, 15, 14, 14, 14, 14, 14]);
    expect(sum(r.rows)).toBe(100);
  });

  it('11 家店摊 1000 分：前 10 家各 91、最后一家 90（尾差不会漏也不会多）', () => {
    const shops = Array.from({ length: 11 }, (_, i) => ({ shopId: 100 + i }));
    const r = computeAllocations(1000, 'equal', shops);
    expect(r.rows.map((x) => x.amountCents)).toEqual([91, 91, 91, 91, 91, 91, 91, 91, 91, 91, 90]);
    expect(sum(r.rows)).toBe(1000);
  });

  it('1 分钱摊 3 家：只有一家拿到 1 分，其余为 0（不会出现 0.33 分）', () => {
    const r = computeAllocations(1, 'equal', [{ shopId: 9 }, { shopId: 2 }, { shopId: 4 }]);
    expect(r.rows).toEqual([
      { shopId: 2, amountCents: 1, ratioBp: 3333 },
      { shopId: 4, amountCents: 0, ratioBp: 3333 },
      { shopId: 9, amountCents: 0, ratioBp: 3333 },
    ]);
    expect(sum(r.rows)).toBe(1);
  });

  it('大量随机金额都守恒（100 次，含非整除）', () => {
    for (let n = 2; n <= 13; n++) {
      const shops = Array.from({ length: n }, (_, i) => ({ shopId: i + 1 }));
      for (const amount of [1, 7, 99, 100, 12345, 999999]) {
        const r = computeAllocations(amount, 'equal', shops);
        expect(conservationGap(amount, r.rows), `n=${n} amount=${amount}`).toBe(0);
        // 任意两家的差额不应超过 1 分（最大余数法的定义性质）
        const values = r.rows.map((x) => x.amountCents);
        expect(Math.max(...values) - Math.min(...values)).toBeLessThanOrEqual(1);
      }
    }
  });

  it('非法参与方一律拒绝（重复 / 0 / 负数 / 空）', () => {
    expect(() => computeAllocations(100, 'equal', [])).toThrow(/至少要选一家/);
    expect(() => computeAllocations(100, 'equal', [{ shopId: 1 }, { shopId: 1 }])).toThrow(/重复/);
    expect(() => computeAllocations(100, 'equal', [{ shopId: 0 }])).toThrow(/非法/);
    expect(() => computeAllocations(100, 'equal', [{ shopId: -3 }])).toThrow(/非法/);
  });

  it('金额非法一律拒绝（0 / 负 / 小数 / 超上限）', () => {
    const shops = [{ shopId: 1 }];
    expect(() => computeAllocations(0, 'equal', shops)).toThrow(/大于 0/);
    expect(() => computeAllocations(-5, 'equal', shops)).toThrow(/大于 0/);
    expect(() => computeAllocations(1.5, 'equal', shops)).toThrow(/整数分/);
    expect(() => computeAllocations(MAX_ALLOC_AMOUNT_CENTS + 1, 'equal', shops)).toThrow(/上限/);
  });
});

describe('按营收占比分摊（revenue）', () => {
  it('500/300/200 营收摊 1000 分：比例精确', () => {
    const r = computeAllocations(1000, 'revenue', [
      { shopId: 1, weight: 500 },
      { shopId: 2, weight: 300 },
      { shopId: 3, weight: 200 },
    ]);
    expect(r.fallback).toBe(false);
    expect(r.rows).toEqual([
      { shopId: 1, amountCents: 500, ratioBp: 5000 },
      { shopId: 2, amountCents: 300, ratioBp: 3000 },
      { shopId: 3, amountCents: 200, ratioBp: 2000 },
    ]);
  });

  it('某店营收为 0 → 该店摊 0，绝不因"余数补分"沾上 1 分', () => {
    // 0/1/1 的权重下，101 分有 1 分尾差；若实现按行序或 id 序补分，shopId=1 会白得 1 分。
    const r = computeAllocations(101, 'revenue', [
      { shopId: 1, weight: 0 },
      { shopId: 2, weight: 1 },
      { shopId: 3, weight: 1 },
    ]);
    expect(r.rows.find((x) => x.shopId === 1)?.amountCents).toBe(0);
    expect(r.rows.find((x) => x.shopId === 2)?.amountCents).toBe(51);
    expect(r.rows.find((x) => x.shopId === 3)?.amountCents).toBe(50);
    expect(sum(r.rows)).toBe(101);
  });

  it('全部营收为 0 → 回落平均并标记 fallback（否则这笔钱会从店铺维度消失）', () => {
    const r = computeAllocations(100, 'revenue', [
      { shopId: 1, weight: 0 },
      { shopId: 2, weight: 0 },
    ]);
    expect(r.fallback).toBe(true);
    expect(r.basis).toBe('equal');
    expect(r.rows.map((x) => x.amountCents)).toEqual([50, 50]);
  });

  it('缺 weight 视为 0（不报错，但不摊钱）', () => {
    const r = computeAllocations(100, 'revenue', [{ shopId: 1, weight: 1 }, { shopId: 2 }]);
    expect(r.rows.map((x) => x.amountCents)).toEqual([100, 0]);
  });

  it('权重是"分"级大数时仍逐分精确（Number 相乘会越过安全整数区，实测会差 1 分）', () => {
    // 10 亿元 × 9e15 量级营收：`amount × weight` 约 9e26，远超 Number.MAX_SAFE_INTEGER。
    // 下面这两个权重只差 1 分营收，正确答案是平分；用 Number 算会得到 50000000001 / 49999999999。
    const r = computeAllocations(MAX_ALLOC_AMOUNT_CENTS, 'revenue', [
      { shopId: 1, weight: 9007199254740408 },
      { shopId: 2, weight: 9007199254740407 },
    ]);
    expect(r.rows).toEqual([
      { shopId: 1, amountCents: 50000000000, ratioBp: 5000 },
      { shopId: 2, amountCents: 50000000000, ratioBp: 5000 },
    ]);
    expect(sum(r.rows)).toBe(MAX_ALLOC_AMOUNT_CENTS);
  });

  it('权重必须是非负安全整数：小数 / 越过安全区一律拒绝（不"约等于"着摊钱）', () => {
    expect(() => computeAllocations(100, 'revenue', [{ shopId: 1, weight: 1.5 }])).toThrow(/非负整数/);
    expect(() =>
      computeAllocations(100, 'revenue', [{ shopId: 1, weight: Number.MAX_SAFE_INTEGER + 2 }]),
    ).toThrow(/非负整数/);
  });
});

describe('手工比例（manual）', () => {
  it('3333/3333/3334 bp 摊 10000 分', () => {
    const r = computeAllocations(10000, 'manual', [
      { shopId: 1, weight: 3333 },
      { shopId: 2, weight: 3333 },
      { shopId: 3, weight: 3334 },
    ]);
    expect(r.rows.map((x) => x.amountCents)).toEqual([3333, 3333, 3334]);
    expect(sum(r.rows)).toBe(10000);
  });

  it('合计不足 10000 → 拒绝，且报出还差几个百分点（不做自动补齐）', () => {
    expect(() =>
      computeAllocations(100, 'manual', [
        { shopId: 1, weight: 5000 },
        { shopId: 2, weight: 4000 },
      ]),
    ).toThrow(/还差 10\.00 个百分点/);
  });

  it('合计超过 10000 → 拒绝，并说明超出多少', () => {
    expect(() =>
      computeAllocations(100, 'manual', [
        { shopId: 1, weight: 6000 },
        { shopId: 2, weight: 5000 },
      ]),
    ).toThrow(/超出 10\.00 个百分点/);
  });

  it('允许某店 0%（这家的 0 是用户明确填的，不是算漏的）', () => {
    const r = computeAllocations(100, 'manual', [
      { shopId: 1, weight: 0 },
      { shopId: 2, weight: 10000 },
    ]);
    expect(r.rows.map((x) => x.amountCents)).toEqual([0, 100]);
  });
});

describe('幂等比较与派生', () => {
  it('分摊等价比较与顺序无关（否则重算会无端触发删了重插）', () => {
    const a = computeAllocations(100, 'equal', [{ shopId: 1 }, { shopId: 2 }]).rows;
    const b = computeAllocations(100, 'equal', [{ shopId: 2 }, { shopId: 1 }]).rows;
    expect(allocationsEqual(a, b)).toBe(true);
  });

  it('金额变了就是不等（不能只比店数）', () => {
    const a: AllocationRow[] = [{ shopId: 1, amountCents: 50, ratioBp: 5000 }];
    const b: AllocationRow[] = [{ shopId: 1, amountCents: 51, ratioBp: 5000 }];
    expect(allocationsEqual(a, b)).toBe(false);
  });

  it('只是 ratioBp 抖动不算变化（占比是展示值，不是判据）', () => {
    const a: AllocationRow[] = [{ shopId: 1, amountCents: 50, ratioBp: 5000 }];
    const b: AllocationRow[] = [{ shopId: 1, amountCents: 50, ratioBp: 5001 }];
    expect(allocationsEqual(a, b)).toBe(true);
  });

  it('期间由日期派生', () => {
    expect(periodOf('2026-10-25')).toBe('2026-10');
    expect(periodOf('2026-01-01')).toBe('2026-01');
  });

  it('日期校验拒绝"格式对、日子不存在"', () => {
    expect(isValidBizDate('2026-10-25')).toBe(true);
    expect(isValidBizDate('2026-02-30')).toBe(false);
    expect(isValidBizDate('2026-13-01')).toBe(false);
    expect(isValidBizDate('2026-1-1')).toBe(false);
    expect(isValidBizDate('')).toBe(false);
    expect(() => periodOf('2026-02-30')).toThrow(/真实日期/);
  });

  it('金额展示保留两位小数（内部一律整数分）', () => {
    expect(formatCents(12345)).toBe('123.45');
    expect(formatCents(5)).toBe('0.05');
    expect(formatCents(-250)).toBe('-2.50');
  });

  it('基准枚举与文档一致（多一个少一个都要同步方案）', () => {
    expect(LEDGER_BASES).toEqual(['equal', 'revenue', 'manual']);
  });
});

describe('金额输入解析（元 → 分）', () => {
  it('常规写法与容错写法都进同一个口径', () => {
    expect(parseYuanToCents('100')).toBe(10000);
    expect(parseYuanToCents('100.5')).toBe(10050);
    expect(parseYuanToCents('100.05')).toBe(10005);
    expect(parseYuanToCents(' 1,234.56 ')).toBe(123456);
    expect(parseYuanToCents('¥1234')).toBe(123400);
  });

  it('超过两位小数**拒绝**，不替用户四舍五入（1.005 变成 1.01 是账上多出 5 厘）', () => {
    expect(parseYuanToCents('1.005')).toBeNull();
    expect(parseYuanToCents('0.001')).toBeNull();
  });

  it('0 / 负数 / 非数字 / 空串一律拒绝（方向由收/支表达，金额恒为正）', () => {
    expect(parseYuanToCents('0')).toBeNull();
    expect(parseYuanToCents('0.00')).toBeNull();
    expect(parseYuanToCents('-5')).toBeNull();
    expect(parseYuanToCents('abc')).toBeNull();
    expect(parseYuanToCents('')).toBeNull();
    expect(parseYuanToCents(null)).toBeNull();
    expect(parseYuanToCents(1200)).toBeNull();
  });

  it('位数过长的输入拒绝（越过 Number 安全整数区就只剩"看起来对"）', () => {
    expect(parseYuanToCents('99999999999')).toBeNull();
    expect(parseYuanToCents(String(MAX_ALLOC_AMOUNT_CENTS / 100 + 1))).toBeNull();
    // 边界值本身合法（10 位整数部分 = 上限 1e9 元），别把上限也挡掉
    expect(parseYuanToCents(String(MAX_ALLOC_AMOUNT_CENTS / 100))).toBe(MAX_ALLOC_AMOUNT_CENTS);
  });
});

// 「记一笔」默认发生日：`month` 可能是「全部日期」哨兵 `'all'`，直接拼 `${month}-01`
// 会得到 `'all-01'` → input[type=date] 渲染成空 → 公共区报"没有可分摊店铺"（审查 P0-1）。
// 这条用例锁的就是"非 YYYY-MM 一律回落本月"。
describe('defaultBizDate（记一笔默认日期）', () => {
  it('全部日期哨兵 → 今天（不拼出 all-01）', () => {
    expect(defaultBizDate('all', '2026-10-27')).toBe('2026-10-27');
  });

  it('历史月份 → 该月 1 日', () => {
    expect(defaultBizDate('2026-09', '2026-10-27')).toBe('2026-09-01');
  });

  it('当月 → 今天（用户多数时候记的是今天）', () => {
    expect(defaultBizDate('2026-10', '2026-10-27')).toBe('2026-10-27');
  });

  it('空串 / 坏值 → 回落今天所在月，绝不产出非法日期', () => {
    expect(defaultBizDate('', '2026-10-27')).toBe('2026-10-27');
    expect(defaultBizDate('2026-1', '2026-10-27')).toBe('2026-10-27');
    for (const m of ['all', '', '2026-1', 'abc']) {
      expect(isValidBizDate(defaultBizDate(m, '2026-03-05'))).toBe(true);
    }
  });
});
