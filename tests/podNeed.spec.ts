// tests/podNeed.spec.ts
// 图案净需件（`podNeedReport`）—— 纯函数，vitest 直接覆盖。
//
// 这里钉的三条都是"看起来对、其实错"的地方：
//   ① 状态口径：只认 `mangoStatus.isWaitingShip`（'已发货'/'已取消'/空状态一件都不算）；
//   ② 未绑定件必须单独计数（真库此刻 75 行订单里只有 4 行匹配得到槽位，漏掉就是九成订单漏报）；
//   ③ 余量扣到 0 为止（负余量不涨净需件），净需件 0 的行不进报单。
import { describe, it, expect } from 'vitest';
import {
  podNeedReport,
  podNeedTrustOf,
  podNeedEmptyOf,
  podPatternResolver,
  podResolvePattern,
  sheetsOf,
  piecesOfQty,
} from '../src/lib/podNeed';

const VK = (item: string, color = 'Red') => ['九店', item, color].join('\u0000');
const cand = (variantKey: string, qty: number | null, bizStatus = '待发货') => ({
  variantKey,
  qty,
  bizStatus,
});
const pat = (id: number, code: string, remainingPieces: number) => ({
  id,
  code,
  name: `图案${code}`,
  artworkImageId: 100 + id,
  previewImageId: 200 + id,
  remainingPieces,
});

describe('piecesOfQty / sheetsOf', () => {
  it('件数空/0/负数按 1 件计并标记 assumed（静默当 0 会让净需件偏小）', () => {
    expect(piecesOfQty(null)).toEqual({ pieces: 1, assumed: true });
    expect(piecesOfQty(0)).toEqual({ pieces: 1, assumed: true });
    expect(piecesOfQty(-2)).toEqual({ pieces: 1, assumed: true });
    expect(piecesOfQty('abc')).toEqual({ pieces: 1, assumed: true });
    expect(piecesOfQty(3)).toEqual({ pieces: 3, assumed: false });
  });

  it('张数 = ceil(净需/每张)；净需 0 → 0 张；每张件数没填好时按一张一件', () => {
    expect(sheetsOf(0, 20)).toBe(0);
    expect(sheetsOf(19, 20)).toBe(1);
    expect(sheetsOf(21, 20)).toBe(2);
    expect(sheetsOf(5, 0)).toBe(5);
  });
});

describe('podNeedReport — 状态口径', () => {
  it('只算待发货：已发货 / 已取消 / 空状态都不进待印件', () => {
    const bindings = new Map([[VK('1'), 1]]);
    const report = podNeedReport({
      candidates: [cand(VK('1'), 2, '已发货'), cand(VK('1'), 3, '已取消'), cand(VK('1'), 4, '')],
      bindings,
      patterns: [pat(1, 'P001', 0)],
    });
    expect(report.waitingPieces).toBe(0);
    expect(report.rows).toEqual([]);
  });

  it('芒果的多种"待发"原文都算（别写全等）', () => {
    const bindings = new Map([[VK('1'), 1]]);
    const report = podNeedReport({
      candidates: [cand(VK('1'), 2, '等待卖家发货'), cand(VK('1'), 3, '待卖家发货')],
      bindings,
      patterns: [pat(1, 'P001', 0)],
    });
    expect(report.waitingPieces).toBe(5);
    expect(report.rows[0]).toMatchObject({ needPieces: 5, netNeed: 5 });
  });
});

describe('podNeedReport — 聚合与扣余量', () => {
  const bindings = new Map([
    [VK('1'), 1],
    [VK('2'), 2],
  ]);

  it('按图案跨行累加；余量够的行净需 0 且不进报单', () => {
    const report = podNeedReport({
      candidates: [cand(VK('1'), 4), cand(VK('1'), 4), cand(VK('2'), 3)],
      bindings,
      patterns: [pat(1, 'P001', 8), pat(2, 'P002', 10)],
    });
    expect(report.rows).toEqual([]); // P001 待印 8 ≤ 余量 8；P002 待印 3 ≤ 10
    expect(report.boundPieces).toBe(11);
    expect(report.shortPieces).toBe(0);
    expect(report.totalSheets).toBe(0);
  });

  it('净需件 = 待印 - 余量，按净需倒序，张数按每张件数', () => {
    const report = podNeedReport({
      candidates: [cand(VK('1'), 10), cand(VK('2'), 3)],
      bindings,
      patterns: [pat(1, 'P001', 4), pat(2, 'P002', 0)],
      piecesPerSheet: 2,
    });
    expect(
      report.rows.map((r) => [r.code, r.needPieces, r.remainingPieces, r.netNeed, r.sheets])
    ).toEqual([
      ['P001', 10, 4, 6, 3],
      ['P002', 3, 0, 3, 2],
    ]);
    expect(report.shortPieces).toBe(9);
    expect(report.totalSheets).toBe(5);
    expect(report.piecesPerSheet).toBe(2);
  });

  it('负余量按 0 扣（不把"账面欠料"加进净需件）', () => {
    const report = podNeedReport({
      candidates: [cand(VK('1'), 2)],
      bindings,
      patterns: [pat(1, 'P001', -5)],
    });
    expect(report.rows[0]).toMatchObject({ remainingPieces: 0, netNeed: 2 });
  });

  it('绑定指向已删除的图案 → 按未绑定计（不许指向查不出来的图案）', () => {
    const report = podNeedReport({
      candidates: [cand(VK('1'), 2)],
      bindings: new Map([[VK('1'), 99]]),
      patterns: [pat(1, 'P001', 0)],
    });
    expect(report.unboundPieces).toBe(2);
    expect(report.unboundRows).toBe(1);
    expect(report.rows).toEqual([]);
  });
});

describe('podNeedReport — 未绑定与兜底必须说得出话', () => {
  it('键为空（没有商品ID）的行算未绑定（永远匹配不到图案）', () => {
    const report = podNeedReport({
      candidates: [cand('', 5), cand(VK('1'), 2)],
      bindings: new Map([[VK('1'), 1]]),
      patterns: [pat(1, 'P001', 0)],
    });
    expect(report.unboundPieces).toBe(5);
    expect(report.boundPieces).toBe(2);
    expect(podNeedTrustOf(report).tone).toBe('danger');
  });

  it('件数按 1 兜底的行数单独计（并在可信度里降级成"可能更多"）', () => {
    const report = podNeedReport({
      candidates: [cand(VK('1'), null)],
      bindings: new Map([[VK('1'), 1]]),
      patterns: [pat(1, 'P001', 0)],
    });
    expect(report.assumedRows).toBe(1);
    expect(podNeedTrustOf(report)).toMatchObject({ ok: false, tone: 'warn' });
  });

  it('全部绑好且件数齐：可信', () => {
    const report = podNeedReport({
      candidates: [cand(VK('1'), 2)],
      bindings: new Map([[VK('1'), 1]]),
      patterns: [pat(1, 'P001', 0)],
    });
    expect(podNeedTrustOf(report)).toMatchObject({ ok: true, tone: 'ok' });
  });

  it('空态分三种：没订单 / 没图案 / 余量够', () => {
    const noOrders = podNeedReport({ candidates: [], bindings: new Map(), patterns: [] });
    expect(podNeedEmptyOf(noOrders, 0)).toBe('noOrders');
    const noPatterns = podNeedReport({
      candidates: [cand(VK('1'), 1)],
      bindings: new Map(),
      patterns: [],
    });
    expect(podNeedEmptyOf(noPatterns, 0)).toBe('noPatterns');
    const enough = podNeedReport({
      candidates: [cand(VK('1'), 1)],
      bindings: new Map([[VK('1'), 1]]),
      patterns: [pat(1, 'P001', 5)],
    });
    expect(podNeedEmptyOf(enough, 1)).toBe('enoughStock');
    expect(podNeedEmptyOf(enough, 3)).toBe('enoughStock');
  });

  it('每张件数越界（> 1000 或 0）回落默认 1，不会把张数算成 0', () => {
    for (const v of [0, -1, 5000]) {
      const report = podNeedReport({
        candidates: [cand(VK('1'), 3)],
        bindings: new Map([[VK('1'), 1]]),
        patterns: [pat(1, 'P001', 0)],
        piecesPerSheet: v,
      });
      expect(report.piecesPerSheet).toBe(1);
      expect(report.totalSheets).toBe(3);
    }
  });
});

describe('按订单图片认图案 — 图片指纹优先、颜色槽位兜底', () => {
  // 用户口径：「最终我们肯定是根据订单中的图片来决定印什么花的」。所以判定顺序是
  // **图片指纹 → 变体键**，反过来就会出现"图明明认过了，报单却按颜色算到另一个图案"。
  const FP = 'fp-0001';
  const patterns = [pat(1, 'P001', 0), pat(2, 'P002', 0)];
  const imageBindings = { [FP]: 2 };
  const bindings = new Map([[VK('1'), 1]]);
  const withImage = { ...cand(VK('1'), 3), imageFingerprint: FP };

  it('同一行图片与颜色都认过：按图认（via=image），用图指向的那个图案', () => {
    expect(podResolvePattern(withImage, { bindings, imageBindings, patterns })).toEqual({
      patternId: 2,
      via: 'image',
    });
  });

  it('这张图还没认过 → 回退到颜色槽位（via=slot）', () => {
    expect(
      podResolvePattern(
        { ...withImage, imageFingerprint: 'fp-9999' },
        { bindings, imageBindings, patterns }
      )
    ).toEqual({ patternId: 1, via: 'slot' });
  });

  it('图片认到的图案已被合并/删掉 → 回退颜色（不许指向界面上看不见的图案）', () => {
    expect(
      podResolvePattern(withImage, { bindings, imageBindings: { [FP]: 99 }, patterns })
    ).toEqual({ patternId: 1, via: 'slot' });
  });

  it('两个都认不出来 → none（报单里算未绑定，界面要提示"这张图还没认图案"）', () => {
    expect(
      podResolvePattern(
        { variantKey: 'nope', qty: 1, bizStatus: '待发货' },
        { bindings, imageBindings, patterns }
      )
    ).toEqual({ patternId: 0, via: 'none' });
  });

  it('指纹是空白字符串按"没有图"处理（脏数据不该把颜色兜底挡掉）', () => {
    expect(
      podResolvePattern(
        { ...withImage, imageFingerprint: '   ' },
        { bindings, imageBindings, patterns }
      )
    ).toEqual({ patternId: 1, via: 'slot' });
  });

  it('净需件也按图聚合：同一行在颜色上是 P001、图上是 P002 → 记到 P002', () => {
    const report = podNeedReport({
      candidates: [withImage],
      bindings,
      imageBindings,
      patterns,
    });
    expect(report.rows.map((r) => r.patternId)).toEqual([2]);
    expect(report.rows[0]?.needPieces).toBe(3);
  });

  it('闭包版与单行版判定一致（列表与报表不能各写一份顺序）', () => {
    const resolve = podPatternResolver({ bindings, imageBindings, patterns });
    expect(resolve(withImage)).toEqual(
      podResolvePattern(withImage, { bindings, imageBindings, patterns })
    );
  });
});
