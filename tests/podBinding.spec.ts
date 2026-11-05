// tests/podBinding.spec.ts
// 认图案阈值与库存分档（`podBinding`）—— 纯函数，vitest 直接覆盖。
//
// 两个数各有自己的成败线，混在一起会"看起来绿了其实没做完"：
// 已认好 ≥ 60% 只说明"认了一半多"，而「同色多图」没确认完 = 高风险颜色还留着（错印一次整批报废）。
//
// ⚠️ 文案在 2026-11-02 按用户反馈改成人话（覆盖率 → 已认好多少颜色、塌陷链接 → 同色多图、
//    槽位 → 颜色）。这里断言的是**用户看得见的那几个关键词**，改文案时必须同步。
import { describe, it, expect } from 'vitest';
import {
  POD_COVERAGE_TARGET,
  POD_IMAGE_FILTER_LABEL,
  POD_LOW_STOCK_PIECES,
  POD_SLOT_FILTER_LABEL,
  POD_KEY_HINTS,
  nextPodPatternCode,
  podCoverageOf,
  podImageCountLabel,
  podImageCoverageOf,
  podStockToneOf,
} from '../src/lib/podBinding';

const stats = (total: number, bound: number, collapsed = 0, collapsedBound = 0) => ({
  total,
  bound,
  collapsed,
  collapsedBound,
});

describe('podCoverageOf — 认领门禁', () => {
  it('0 个颜色：不算达标，要说"先去采集"（0/0 不能显示成 100%）', () => {
    const c = podCoverageOf(stats(0, 0));
    expect(c.pct).toBe(0);
    expect(c.ok).toBe(false);
    expect(c.text).toContain('采集');
  });

  it('560 个颜色认好 336（60%）：达标且同色多图全确认 → ok', () => {
    const c = podCoverageOf(stats(560, 336, 50, 50));
    expect(c.pct).toBe(60);
    expect(c.ok).toBe(true);
    expect(c.tone).toBe('ok');
    expect(c.gapToTarget).toBe(0);
  });

  it('认领达标但同色多图还差 1 个：不达标（danger，且点名"整批印错"）', () => {
    const c = podCoverageOf(stats(560, 500, 50, 49));
    expect(c.ok).toBe(false);
    expect(c.tone).toBe('danger');
    expect(c.text).toContain('多张图');
    expect(c.text).toContain('整批印错');
    expect(c.text).toContain('1');
  });

  it('门槛按 ceil(total*60%) 算，不按四舍五入后的百分比（335 差一个）', () => {
    const c = podCoverageOf(stats(560, 335, 50, 50));
    expect(c.ok).toBe(false);
    expect(c.gapToTarget).toBe(1);
  });

  it('空 / 脏输入不抛错（按 0 处理）', () => {
    for (const v of [null, undefined, {}, { total: 'x', bound: -3 }]) {
      expect(() => podCoverageOf(v as any)).not.toThrow();
    }
  });
});

describe('podStockToneOf — 库存分档', () => {
  it('0 / 负数 → empty（负数是"修正发现少了"，同样要补）', () => {
    expect(podStockToneOf(0)).toBe('empty');
    expect(podStockToneOf(-3)).toBe('empty');
    expect(podStockToneOf(null)).toBe('empty');
  });

  it('低于阈值（20 件）→ low；等于阈值 → ok（阈值是"低于才黄"）', () => {
    expect(podStockToneOf(POD_LOW_STOCK_PIECES - 1)).toBe('low');
    expect(podStockToneOf(POD_LOW_STOCK_PIECES)).toBe('ok');
  });
});

describe('nextPodPatternCode — 新建图案自动编号', () => {
  it('空库 → P001（新用户不用自己想编号）', () => {
    expect(nextPodPatternCode([])).toBe('P001');
  });

  it('取现有 P 编号的最大值 + 1，并补齐三位', () => {
    expect(nextPodPatternCode(['P001', 'P007', 'P003'])).toBe('P008');
    expect(nextPodPatternCode(['P009'])).toBe('P010');
    expect(nextPodPatternCode(['P099'])).toBe('P100');
  });

  it('不认识的命名不参与自增（花纸厂自己的编码不能被算乱）', () => {
    expect(nextPodPatternCode(['A12', '花纸-03', ''])).toBe('P001');
    expect(nextPodPatternCode(['P002', 'A99'])).toBe('P003');
  });

  it('脏输入不抛错（非数组 / null 项都按没有处理）', () => {
    expect(() => nextPodPatternCode(null as any)).not.toThrow();
    expect(nextPodPatternCode([null as any, undefined as any])).toBe('P001');
  });
});

describe('podImageCoverageOf — 按订单图片的认图案进度', () => {
  it('没有要发的件：不算达标，也不拦（0/0 不能显示成 100%）', () => {
    const c = podImageCoverageOf({
      waitingPieces: 0,
      unboundWaitingPieces: 0,
      unboundWaitingGroups: 0,
    });
    expect(c.pct).toBe(0);
    expect(c.blocked).toBe(false);
    expect(c.text).toContain('发货');
  });

  it('还有没认图案的待发件：danger + blocked，并把件数和张数都摆出来', () => {
    const c = podImageCoverageOf({
      waitingPieces: 10,
      unboundWaitingPieces: 4,
      unboundWaitingGroups: 2,
    });
    expect(c.blocked).toBe(true);
    expect(c.tone).toBe('danger');
    expect(c.pct).toBe(60);
    expect(c.text).toContain('4');
    expect(c.text).toContain('2 张图');
  });

  it('全都认好了但有认不了的行（没图也没商品ID）：warn，不拦（它们本来进不了报单）', () => {
    const c = podImageCoverageOf({
      waitingPieces: 10,
      unboundWaitingPieces: 0,
      unboundWaitingGroups: 0,
      unbindableRows: 3,
    });
    expect(c.blocked).toBe(false);
    expect(c.tone).toBe('warn');
    expect(c.pct).toBe(100);
    expect(c.text).toContain('3');
  });

  it('全都认好且没有认不了的行：ok', () => {
    const c = podImageCoverageOf({
      waitingPieces: 10,
      unboundWaitingPieces: 0,
      unboundWaitingGroups: 0,
    });
    expect(c.blocked).toBe(false);
    expect(c.tone).toBe('ok');
    expect(c.pct).toBe(100);
  });

  it('未认件数超过总件数时按总件数截断（pct 不会变负数）', () => {
    const c = podImageCoverageOf({
      waitingPieces: 5,
      unboundWaitingPieces: 99,
      unboundWaitingGroups: 1,
    });
    expect(c.pct).toBe(0);
  });

  it('空 / 脏输入不抛错（按 0 处理）', () => {
    for (const v of [null, undefined, {}, { waitingPieces: 'x', unboundWaitingPieces: -3 }]) {
      expect(() => podImageCoverageOf(v as any)).not.toThrow();
    }
  });
});

describe('podImageCountLabel — 图案卡片上的识别图文案', () => {
  it('有图说张数，没图说"还没挂识别图"（不是"0"）', () => {
    expect(podImageCountLabel(3)).toBe('3 张识别图');
    expect(podImageCountLabel(0)).toBe('还没挂识别图');
    expect(podImageCountLabel(null)).toBe('还没挂识别图');
    expect(podImageCountLabel('x')).toBe('还没挂识别图');
  });
});

describe('文案常量', () => {
  it('四个筛档有中文标签（界面别自己写第二份）', () => {
    expect(Object.keys(POD_SLOT_FILTER_LABEL).sort()).toEqual([
      'all',
      'bound',
      'collapsed',
      'unbound',
    ]);
  });

  it('图片卡片的四个筛档也是人话', () => {
    expect(Object.keys(POD_IMAGE_FILTER_LABEL).sort()).toEqual([
      'all',
      'bound',
      'noImage',
      'unbound',
    ]);
    expect(POD_IMAGE_FILTER_LABEL.unbound).toBe('还差认图案');
    expect(POD_IMAGE_FILTER_LABEL.bound).toBe('已认好');
    expect(POD_IMAGE_FILTER_LABEL.noImage).toBe('没有图的订单');
    expect(POD_IMAGE_FILTER_LABEL.all).toBe('全部都看');
  });

  it('筛档标签是人话（不再是"槽位 / 塌陷"这些内部词）', () => {
    expect(POD_SLOT_FILTER_LABEL.unbound).toBe('待认领');
    expect(POD_SLOT_FILTER_LABEL.collapsed).toBe('需看图确认');
    expect(POD_SLOT_FILTER_LABEL.bound).toBe('已认好');
  });

  it('键盘提示覆盖计划要求的六个键（Space / 1-9 / Enter / N / M / S）', () => {
    const keys = POD_KEY_HINTS.map((h) => h.key).join(' ');
    for (const k of ['Space', '1-9', 'Enter', 'N', 'M', 'S']) expect(keys).toContain(k);
  });

  it('键盘提示按"图"说事（不是按颜色槽位说）', () => {
    const text = POD_KEY_HINTS.map((h) => h.do).join(' ');
    expect(text).toContain('这张图');
    expect(text).toContain('合并');
    expect(text).not.toContain('槽位');
    expect(text).not.toContain('颜色');
  });

  it('目标线是 60（计划 M3 门禁）', () => {
    expect(POD_COVERAGE_TARGET).toBe(60);
  });
});
