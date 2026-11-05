// tests/podLedger.spec.ts
// 印花扣减的批次分配（`allocatePrint`）—— 纯函数，vitest 直接覆盖。
//
// 这一层唯一的风险是"**跨批次怎么分、够不够**"：真库会有"一个图案三批花纸、余量各 3/0/7"
// 这种形状，SQL 里的窗口函数既没法在 vitest 里验，也没法让人一眼看出"为什么从这批扣"。
import { describe, it, expect } from 'vitest';
import { allocatePrint } from '../electron/podLedger';

const b = (batchId: number, remaining: number, orderedAt = '') => ({ batchId, remaining, orderedAt });

describe('allocatePrint — 退路与边界', () => {
  it('件数 ≤ 0 / 非数字：空方案且不算缺（这是"不扣"，不是错误）', () => {
    expect(allocatePrint([b(1, 10, '2026-01-01')], 0)).toEqual({ allocations: [], shortfall: 0 });
    expect(allocatePrint([b(1, 10, '2026-01-01')], -3)).toEqual({ allocations: [], shortfall: 0 });
    expect(allocatePrint([b(1, 10, '2026-01-01')], Number.NaN)).toEqual({
      allocations: [],
      shortfall: 0,
    });
  });

  it('没有任何批次：缺口 = 全部件数（不是 0 —— 0 会让界面说"够了"）', () => {
    expect(allocatePrint([], 5)).toEqual({ allocations: [], shortfall: 5 });
  });

  it('余量为 0 / 负数 / 批次 id 为 0 的批次一律不用（它们是"这批用完了"或脏行）', () => {
    const r = allocatePrint([b(1, 0), b(2, -4), b(0, 9, '2026-01-01'), b(3, 7, '2026-02-01')], 3);
    expect(r.shortfall).toBe(0);
    expect(r.allocations).toEqual([{ batchId: 3, pieces: 3 }]);
  });
});

describe('allocatePrint — FIFO', () => {
  it('按 orderedAt 从早到晚扣（先买的先用，花纸放久了先褪色）', () => {
    const r = allocatePrint([b(2, 5, '2026-03-01'), b(1, 5, '2026-01-01')], 8);
    expect(r.allocations).toEqual([
      { batchId: 1, pieces: 5 },
      { batchId: 2, pieces: 3 },
    ]);
  });

  it('同一天按批次 id（先建的先用），结果不依赖传入顺序', () => {
    const a = allocatePrint([b(2, 4, '2026-02-01'), b(1, 4, '2026-02-01')], 6);
    const c = allocatePrint([b(1, 4, '2026-02-01'), b(2, 4, '2026-02-01')], 6);
    expect(a).toEqual(c);
    expect(a.allocations).toEqual([
      { batchId: 1, pieces: 4 },
      { batchId: 2, pieces: 2 },
    ]);
  });

  it('没有日期的批次排在最后（"不知道何时报的"不能抢在已知更早的批次前）', () => {
    const r = allocatePrint([b(1, 4, ''), b(2, 4, '2026-05-01')], 5);
    expect(r.allocations).toEqual([
      { batchId: 2, pieces: 4 },
      { batchId: 1, pieces: 1 },
    ]);
  });

  it('刚好够：分完即止，不多写一行 0 件的分配', () => {
    const r = allocatePrint([b(1, 3, '2026-01-01'), b(2, 3, '2026-02-01')], 3);
    expect(r.allocations).toEqual([{ batchId: 1, pieces: 3 }]);
  });
});

describe('allocatePrint — 不足就整批拒绝', () => {
  it('差 1 件也整批拒绝（allocations 必须为空，不允许半扣）', () => {
    const r = allocatePrint([b(1, 3, '2026-01-01'), b(2, 2, '2026-02-01')], 6);
    expect(r).toEqual({ allocations: [], shortfall: 1 });
  });

  it('缺口 = 需要的 - 可用（可用只算 remaining > 0 的批次）', () => {
    const r = allocatePrint([b(1, 0), b(2, 4, '2026-01-01')], 10);
    expect(r.shortfall).toBe(6);
  });

  it('小数件数四舍五入（余量按件，不按半件记账）', () => {
    const r = allocatePrint([b(1, 5, '2026-01-01')], 2.4);
    expect(r.allocations).toEqual([{ batchId: 1, pieces: 2 }]);
  });
});
