// tests/podSheet.spec.ts
// 「订花纸」清单的可复制模型（`podSheetModelOf` / `podSheetTextOf`）—— 纯函数，vitest 直接覆盖。
//
// 钉的四件事（都是"复制出去才发现不对"的地方）：
//   ① 没有要补的行 ⇒ `null`（调用方据此提示"这次不用订"，而不是复制一张空图）；
//   ② 合计（张数 / 件数）与行是同一份来源（`PodNeedRow` 已算好，这里只累加，绝不重算）；
//   ③ 缺制版图的图案**仍进清单**，但必须标出来（不标 → 花纸厂去制版、然后打回来问图）；
//   ④ 对外那张图的取法有固定优先级（制版图 → 预览图 → 识别图），空路径不静默跳过这一行。
import { describe, it, expect } from 'vitest';
import { podSheetModelOf, podSheetTextOf } from '../src/lib/podSheet';
import type { PodNeedRow } from '../src/lib/podNeed';
import type { PodPatternRow } from '../src/types';

const row = (
  patternId: number,
  code: string,
  name: string,
  over: Partial<PodNeedRow> = {}
): PodNeedRow => ({
  patternId,
  code,
  name,
  artworkImageId: 100 + patternId,
  previewImageId: 200 + patternId,
  needPieces: 10,
  remainingPieces: 0,
  netNeed: 10,
  sheets: 10,
  ...over,
});

const pattern = (id: number, over: Partial<PodPatternRow> = {}): PodPatternRow => ({
  id,
  code: `P00${id}`,
  name: '',
  artworkImageId: 100 + id,
  previewImageId: 200 + id,
  artworkLocalPath: `/tmp/pod-art-${id}.png`,
  previewLocalPath: `/tmp/pod-preview-${id}.png`,
  status: 'active',
  note: '',
  boundSlots: 0,
  remainingPieces: 0,
  imageCount: 0,
  imageFingerprints: [],
  imageLocalPaths: [],
  ...over,
});

describe('podSheetModelOf — 空清单', () => {
  it('没有要补的行 ⇒ null（不要复制一张空图出去）', () => {
    expect(podSheetModelOf([], [], { date: '2026-11-02', piecesPerSheet: 1 })).toBeNull();
    expect(podSheetModelOf(null, [], { date: '2026-11-02', piecesPerSheet: 1 })).toBeNull();
    expect(podSheetModelOf(undefined, [], { date: '2026-11-02', piecesPerSheet: 1 })).toBeNull();
  });
});

describe('podSheetModelOf — 合计与文案', () => {
  it('张数 / 件数按行累加（模型只读 PodNeedRow 已算好的值，不再算一遍）', () => {
    const m = podSheetModelOf(
      [
        row(1, 'P001', '小雏菊', { netNeed: 6, sheets: 3 }),
        row(2, 'P002', '向日葵', { netNeed: 4, sheets: 4 }),
      ],
      [pattern(1), pattern(2)],
      { date: '2026-11-02', piecesPerSheet: 2 }
    );
    expect(m).not.toBeNull();
    expect(m?.totalSheets).toBe(7);
    expect(m?.totalPieces).toBe(10);
    expect(m?.title).toBe('订花纸 · 2026-11-02');
    expect(m?.subtitle).toBe('每张印 2 件 · 共 2 个图案');
    expect(m?.footer).toBe('共 2 个图案 · 补 10 件 · 要订 7 张');
    expect(m?.lines.map((l) => l.sheets)).toEqual([3, 4]);
  });

  it('还有没认图案的件数时，副标题必须说（否则这张图发出去就是"少订了"）', () => {
    const m = podSheetModelOf([row(1, 'P001', '小雏菊')], [pattern(1)], {
      date: '2026-11-02',
      piecesPerSheet: 1,
      unboundPieces: 5,
      unboundRows: 2,
    });
    expect(m?.subtitle).toBe('每张印 1 件 · 共 1 个图案（还没认图案的 5 件 / 2 行没算进来）');
  });

  it('每张件数没填好时按 1 件说（不把 0 当成排版值）', () => {
    const m = podSheetModelOf([row(1, 'P001', '小雏菊')], [pattern(1)], {
      date: '2026-11-02',
      piecesPerSheet: 0,
    });
    expect(m?.subtitle).toContain('每张印 1 件');
  });
});

describe('podSheetModelOf — 图与制版图', () => {
  it('对外那张图：制版图 → 预览图 → 识别图（三张都没有 = 空串，画占位）', () => {
    const rows = [
      row(1, 'P001', 'A'),
      row(2, 'P002', 'B'),
      row(3, 'P003', 'C'),
      row(4, 'P004', 'D'),
    ];
    const m = podSheetModelOf(
      rows,
      [
        pattern(1),
        pattern(2, { artworkLocalPath: '', previewLocalPath: '/tmp/prev2.png' }),
        pattern(3, {
          artworkLocalPath: '',
          previewLocalPath: '',
          imageLocalPaths: ['/tmp/img3.png'],
        }),
        pattern(4, { artworkLocalPath: '', previewLocalPath: '', imageLocalPaths: [] }),
      ],
      { date: '2026-11-02', piecesPerSheet: 1 }
    );
    expect(m?.lines.map((l) => l.localPath)).toEqual([
      '/tmp/pod-art-1.png',
      '/tmp/prev2.png',
      '/tmp/img3.png',
      '',
    ]);
  });

  it('图案列表里找不到这一行时：图给空串（不整份失败），但行仍在清单里', () => {
    const m = podSheetModelOf([row(9, 'P009', 'E')], [], { date: '2026-11-02', piecesPerSheet: 1 });
    expect(m?.lines).toHaveLength(1);
    expect(m?.lines[0].localPath).toBe('');
  });

  it('缺制版图（artworkImageId <= 0）的行：仍进清单，但被标出来', () => {
    const m = podSheetModelOf(
      [row(1, 'P001', 'A', { artworkImageId: 0 }), row(2, 'P002', 'B', { artworkImageId: 7 })],
      [pattern(1), pattern(2)],
      { date: '2026-11-02', piecesPerSheet: 1 }
    );
    expect(m?.lines.map((l) => l.missingArtwork)).toEqual([true, false]);
    expect(m?.missingArtwork).toEqual(['P001']);
  });
});

describe('podSheetTextOf — 纯文字清单', () => {
  it('一行一个图案：编号 名字：要订 N 张（补 N 件，还剩 N 件）', () => {
    const m = podSheetModelOf(
      [
        row(1, 'P001', '小雏菊', { needPieces: 12, remainingPieces: 7, netNeed: 5, sheets: 5 }),
        row(2, 'P002', '', { needPieces: 8, remainingPieces: 0, netNeed: 8, sheets: 8 }),
      ],
      [pattern(1), pattern(2)],
      { date: '2026-11-02', piecesPerSheet: 1 }
    );
    expect(m).not.toBeNull();
    expect(podSheetTextOf(m!)).toBe(
      [
        '订花纸 · 2026-11-02',
        '每张印 1 件 · 共 2 个图案',
        'P001 小雏菊：要订 5 张（补 5 件，还剩 7 件）',
        'P002：要订 8 张（补 8 件，还剩 0 件）',
        '共 2 个图案 · 补 13 件 · 要订 13 张',
      ].join('\n')
    );
  });

  it('缺制版图的行写「（缺制版图）」——不写的话对方会去制版，然后回来问图在哪', () => {
    const m = podSheetModelOf([row(1, 'P001', '小雏菊', { artworkImageId: 0 })], [pattern(1)], {
      date: '2026-11-02',
      piecesPerSheet: 1,
    });
    expect(podSheetTextOf(m!)).toContain(
      'P001 小雏菊：要订 10 张（补 10 件，还剩 0 件）（缺制版图）'
    );
  });
});
