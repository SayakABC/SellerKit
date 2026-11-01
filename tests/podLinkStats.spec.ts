// tests/podLinkStats.spec.ts
// 链接判别力统计（`podLinkStats`）—— 纯函数，vitest 直接覆盖。
//
// 这几条测的都是"**按行数算就会错**"的地方：同一色名的 S/M/L 共用一张图是常态，
// 按行数算会把 1 张图数成 3 张，于是全库每条链接都被判成"塌陷"，第 4 段图键
// 会加进每一个变体键 —— 存量键全部变形（正是 T3-6 明确禁止的"一个字节都别动"）。
import { describe, it, expect } from 'vitest';
import { podLinkStats, isCollapsedLink } from '../electron/podLinkStats';

/** 造一行 SKU 快照（只给本函数要用的两个字段） */
const row = (color: string, imageUrl: string) => ({ color, size: 'M', price: '1', imageUrl });

/** 一张 AE 图床的图（`/kf/<id>.jpg`） */
const IMG = (id: string) => `https://ae01.alicdn.com/kf/${id}.jpg`;

describe('podLinkStats — 空与脏输入', () => {
  it('空串 / null / 空数组都返回 0/0（"没算过"，不抛错）', () => {
    for (const v of ['', '   ', null, undefined, [], '[]', 'null', '{"a":1}']) {
      expect(podLinkStats(v)).toEqual({ nColors: 0, nImages: 0 });
    }
  });

  it('坏 JSON 不抛错（采集热路径上一条坏快照不该让整帧失败）', () => {
    expect(() => podLinkStats('[{oops')).not.toThrow();
    expect(podLinkStats('[{oops')).toEqual({ nColors: 0, nImages: 0 });
  });

  it('数组里混着 null / 字符串时跳过它们，不影响其余行', () => {
    const s = podLinkStats([null, 'x', 42, row('Red', IMG('S1'))]);
    expect(s).toEqual({ nColors: 1, nImages: 1 });
  });

  it('接受已经解析好的数组（调用方手里是数组时不必来回 stringify）', () => {
    expect(podLinkStats([row('Red', IMG('S1'))])).toEqual(
      podLinkStats(JSON.stringify([row('Red', IMG('S1'))]))
    );
  });
});

describe('podLinkStats — 色数', () => {
  it('三个色各一张图：nColors=3、nImages=1（不是"总图数 3"）', () => {
    const s = podLinkStats([
      row('Red', IMG('S1')),
      row('Blue', IMG('S2')),
      row('Green', IMG('S3')),
    ]);
    expect(s).toEqual({ nColors: 3, nImages: 1 });
    expect(isCollapsedLink(s)).toBe(false);
  });

  it('空色名算一个色名（"报表没给色"是真实的桶，与视图 GROUP BY color 同口径）', () => {
    expect(podLinkStats([row('', IMG('S1'))])).toEqual({ nColors: 1, nImages: 1 });
    // 1 个真色 + 1 个无色桶 = 2 个色名：不能让它看起来像"只有 1 个色"而被误判成塌陷
    expect(podLinkStats([row('Red', IMG('S1')), row('', IMG('S2'))])).toEqual({
      nColors: 2,
      nImages: 1,
    });
  });

  it('同一个色名重复出现只算一次', () => {
    const s = podLinkStats([row('Red', IMG('S1')), row('Red', IMG('S1')), row('Red', IMG('S1'))]);
    expect(s).toEqual({ nColors: 1, nImages: 1 });
  });

  it('色名只做 trim 归一，不折大小写（与 variantColorKey 的段内归一同口径）', () => {
    expect(podLinkStats([row(' Red ', IMG('S1'))])).toEqual({ nColors: 1, nImages: 1 });
    expect(podLinkStats([row('Red', IMG('S1')), row('red', IMG('S2'))])).toEqual({
      nColors: 2,
      nImages: 1,
    });
  });
});

describe('podLinkStats — 图数（塌陷判据）', () => {
  it('同一色名的 S/M/L 共用一张图：nImages=1（按行数算会得 3，全库每条链接都会被误判塌陷）', () => {
    const s = podLinkStats([
      { color: 'Picture color', size: 'S', price: '1', imageUrl: IMG('S1') },
      { color: 'Picture color', size: 'M', price: '1', imageUrl: IMG('S1') },
      { color: 'Picture color', size: 'L', price: '1', imageUrl: IMG('S1') },
    ]);
    expect(s).toEqual({ nColors: 1, nImages: 1 });
    expect(isCollapsedLink(s)).toBe(false);
  });

  it('同一色名挂 3 张不同的图：nImages=3、判为塌陷（真库 7/71 链接的形状）', () => {
    const s = podLinkStats([
      row('Picture color', IMG('S1')),
      row('Picture color', IMG('S2')),
      row('Picture color', IMG('S3')),
    ]);
    expect(s).toEqual({ nColors: 1, nImages: 3 });
    expect(isCollapsedLink(s)).toBe(true);
  });

  it('同一张图的多种 CDN 形态算一张（尺寸后缀 / 签名查询串 / hash）', () => {
    const s = podLinkStats([
      row('Red', 'https://ae01.alicdn.com/kf/S1.jpg'),
      row('Red', '//ae01.alicdn.com/kf/S1.jpg_220x220.jpg'),
      row('Red', 'https://img.alicdn.com/kf/S1.png?x-oss-process=image/resize,w_100'),
      row('Red', 'https://ae01.alicdn.com/kf/S1.webp#frag'),
    ]);
    expect(s).toEqual({ nColors: 1, nImages: 1 });
  });

  it('认不出的图（空 / 非 /kf/ 图床）不计入图数（是"没有图"，不是"另一张图"）', () => {
    expect(podLinkStats([row('Red', IMG('S1')), row('Red', '')])).toEqual({
      nColors: 1,
      nImages: 1,
    });
    expect(podLinkStats([row('Red', 'https://example.com/pic.jpg')])).toEqual({
      nColors: 1,
      nImages: 0,
    });
  });

  it('取"每个色名的最大值"而不是"整条链接的图总数"：5 色各 1 图 ≠ 1 色 5 图', () => {
    const fiveColors = ['A', 'B', 'C', 'D', 'E'].map((c, i) => row(c, IMG(`S${i + 1}`)));
    expect(podLinkStats(fiveColors)).toEqual({ nColors: 5, nImages: 1 });
    expect(isCollapsedLink(podLinkStats(fiveColors))).toBe(false);

    const oneColorFiveImgs = ['S1', 'S2', 'S3', 'S4', 'S5'].map((id) =>
      row('Picture color', IMG(id))
    );
    expect(podLinkStats(oneColorFiveImgs)).toEqual({ nColors: 1, nImages: 5 });
    expect(isCollapsedLink(podLinkStats(oneColorFiveImgs))).toBe(true);
  });

  it('"1 个色塌了、另 1 个色正常"也要判塌陷（计划里的 n_colors=1 前提会漏判这种）', () => {
    const s = podLinkStats([row('A', IMG('S1')), row('A', IMG('S2')), row('B', IMG('S3'))]);
    expect(s).toEqual({ nColors: 2, nImages: 2 });
    expect(isCollapsedLink(s)).toBe(true);
  });

  it('没有任何图键的链接：nImages=0，不算塌陷', () => {
    const s = podLinkStats([row('Red', ''), row('Blue', '')]);
    expect(s).toEqual({ nColors: 2, nImages: 0 });
    expect(isCollapsedLink(s)).toBe(false);
  });
});

describe('isCollapsedLink — 空输入', () => {
  it('null / undefined / 0 值都不算塌陷（"不知道"不等于"塌了"）', () => {
    expect(isCollapsedLink(null)).toBe(false);
    expect(isCollapsedLink(undefined)).toBe(false);
    expect(isCollapsedLink({ nColors: 0, nImages: 0 })).toBe(false);
  });
});
