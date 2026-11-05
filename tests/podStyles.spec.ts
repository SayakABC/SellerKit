// tests/podStyles.spec.ts
// 「按款认图案」的分组层（`podStyleGroupsOf`）—— 纯函数，vitest 直接覆盖。
//
// 这里钉的四条都是"看起来对、其实会错印"的地方：
//   ① 一个款里两个颜色用同一朵花 ⇒ 只算一个图案（用户原话「只需要用任意一张图片存一条记录」）；
//   ② 一个款里两种花 ⇒ 两个图案（不能因为"同款"就并成一个）；
//   ③ 匹配顺序：款色 → 图片指纹 → 变体键（款色最稳，换了商品图也还认得）；
//   ④ 没归类也要能分组（按商品ID 兜底），且**标出来**——否则用户以为这个款已经认好了。
import { describe, it, expect } from 'vitest';
import { podStyleGroupsOf, podStylePickHint } from '../src/lib/podStyles';
import type { PodNeedCandidate, PodNeedPattern } from '../src/lib/podNeed';

const pat = (id: number, code: string): PodNeedPattern => ({
  id,
  code,
  name: `图案${code}`,
  artworkImageId: 0,
  previewImageId: 0,
  remainingPieces: 0,
});

const row = (over: Partial<PodNeedCandidate> = {}): PodNeedCandidate => ({
  variantKey: 'bk\u0000IT-1\u0000红',
  bizStatus: '待发货',
  qty: 1,
  shop: '店A',
  orderNo: 'O-1',
  itemId: 'IT-1',
  color: '红',
  imageFingerprint: '',
  imagePath: '',
  imageUrl: '',
  styleId: 10,
  styleCode: 'A-102',
  styleColorId: 101,
  styleColorName: '红',
  ...over,
});

const patterns = [pat(1, 'P001'), pat(2, 'P002')];

describe('podStyleGroupsOf — 款内图案汇总', () => {
  it('一个款三个颜色：两个同花 + 一个另一种花 ⇒ 两个图案、件数相加', () => {
    const report = podStyleGroupsOf({
      candidates: [
        row({ orderNo: 'O-1', styleColorId: 101, styleColorName: '红', qty: 2 }),
        row({ orderNo: 'O-2', styleColorId: 102, styleColorName: '蓝', qty: 3, color: '蓝' }),
        row({ orderNo: 'O-3', styleColorId: 103, styleColorName: '灰', qty: 4, color: '灰' }),
      ],
      styleColorBindings: { '101': 1, '102': 1, '103': 2 },
      patterns,
    });
    expect(report.groups).toHaveLength(1);
    const g = report.groups[0]!;
    expect(g.colors).toHaveLength(3);
    expect(g.patternIds.sort()).toEqual([1, 2]);
    expect(g.pieces).toBe(9);
    expect(g.unboundPieces).toBe(0);
    expect(report.totals.pieces).toBe(9);
    expect(report.totals.unboundGroups).toBe(0);
  });

  it('三个颜色共用同一朵花 ⇒ 只算一个图案（不是三个）', () => {
    const report = podStyleGroupsOf({
      candidates: [
        row({ styleColorId: 101, styleColorName: '红' }),
        row({ styleColorId: 102, styleColorName: '蓝' }),
        row({ styleColorId: 103, styleColorName: '灰' }),
      ],
      styleColorBindings: { '101': 1, '102': 1, '103': 1 },
      patterns,
    });
    expect(report.groups[0]!.patternIds).toEqual([1]);
  });

  it('款色绑定优先于图片指纹（换了商品图也还认得）', () => {
    const report = podStyleGroupsOf({
      candidates: [row({ imageFingerprint: 'fp-x' })],
      styleColorBindings: { '101': 1 },
      imageBindings: { 'fp-x': 2 },
      patterns,
    });
    const chip = report.groups[0]!.colors[0]!;
    expect(chip.patternId).toBe(1);
    expect(chip.via).toBe('styleColor');
  });
});

describe('podStyleGroupsOf — 兜底与标记', () => {
  it('还没归类：按商品ID 分组，标 unclassified（不伪装成款号）', () => {
    const report = podStyleGroupsOf({
      candidates: [
        row({ styleId: 0, styleCode: '', styleColorId: 0, styleColorName: '', color: '红' }),
        row({ styleId: 0, styleCode: '', styleColorId: 0, styleColorName: '', color: '蓝' }),
      ],
      patterns,
    });
    expect(report.groups).toHaveLength(1);
    expect(report.groups[0]!.unclassified).toBe(true);
    expect(report.groups[0]!.styleCode).toBe('商品 IT-1');
    expect(report.totals.unclassifiedColors).toBe(2);
  });

  it('已发货 / 已取消不算（与报单页同一状态口径）', () => {
    const report = podStyleGroupsOf({
      candidates: [
        row({ bizStatus: '已发货' }),
        row({ bizStatus: '已取消', styleColorId: 102 }),
        row({ bizStatus: '', styleColorId: 103 }),
      ],
      patterns,
    });
    expect(report.groups).toHaveLength(0);
    expect(report.totals.pieces).toBe(0);
  });

  it('按图认好了但没记到款上 ⇒ unsavedColors = 1（界面「记到款上」的数字）', () => {
    const report = podStyleGroupsOf({
      candidates: [row({ imageFingerprint: 'fp-1' })],
      imageBindings: { 'fp-1': 1 },
      patterns,
    });
    expect(report.groups[0]!.colors[0]!.via).toBe('image');
    expect(report.groups[0]!.unsavedColors).toBe(1);
    expect(report.totals.unsavedColors).toBe(1);
  });

  it('同一个款色两行认到不同图案 ⇒ conflict（静默取第一条就是整批错印）', () => {
    const report = podStyleGroupsOf({
      candidates: [
        row({ orderNo: 'O-1', imageFingerprint: 'fp-1' }),
        row({ orderNo: 'O-2', imageFingerprint: 'fp-2' }),
      ],
      imageBindings: { 'fp-1': 1, 'fp-2': 2 },
      patterns,
    });
    // 一个款色只有一个花：仍然是**一张 chip**，但必须挂出"认得不一致"的标记让人去改
    expect(report.groups[0]!.colors).toHaveLength(1);
    const chip = report.groups[0]!.colors[0]!;
    expect(chip.rows).toBe(2);
    expect(chip.conflict).toBe(true);
    expect(chip.patternId).toBe(1);
  });

  it('onlyUnbound 只留还有没认的款；搜索命中款号/色名', () => {
    const candidates = [
      row({ orderNo: 'O-1', styleId: 10, styleCode: 'A-102', styleColorId: 101, styleColorName: '红' }),
      row({ orderNo: 'O-2', styleId: 11, styleCode: 'B-201', styleColorId: 201, styleColorName: '蓝', color: '蓝', itemId: 'IT-9' }),
    ];
    const all = podStyleGroupsOf({
      candidates,
      styleColorBindings: { '101': 1 },
      patterns,
    });
    expect(all.groups).toHaveLength(2);
    const unbound = podStyleGroupsOf({
      candidates,
      styleColorBindings: { '101': 1 },
      patterns,
      onlyUnbound: true,
    });
    expect(unbound.groups.map((g) => g.styleCode)).toEqual(['B-201']);
    const searched = podStyleGroupsOf({ candidates, patterns, search: 'b-201' });
    expect(searched.groups.map((g) => g.styleCode)).toEqual(['B-201']);
  });
});

describe('podStylePickHint', () => {
  it('没选颜色时说清怎么选；选了就说会存几条花纸', () => {
    expect(podStylePickHint(0, false)).toContain('先点颜色图');
    expect(podStylePickHint(3, true)).toContain('只存一条花纸');
    expect(podStylePickHint(2, false)).toContain('2 个颜色');
  });
});
