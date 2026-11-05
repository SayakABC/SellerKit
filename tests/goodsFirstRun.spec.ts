// 空库一次性引导卡的判据（R3 · UX-G4）。
//
// 为什么这条要单测：它的全部内容就是**两个 `null` 与两个 `0` 的区别**，而这一页已经因为
// 混淆它们犯过一次（把 `null` 当 0 ⇒ 界面说出"都认完了"那种它**不知道**的结论 ——
// `docs/notes/2026-10-30-goods-list-and-pool.md` 第 4 条）。
// 真机看一遍是看不出这个区别的：两种情况下界面上都是"没有行"。
//
// ⚠️ 反向用例（`buildRed`）比正向用例重要：正向只证明"该出现时出现"，
// 而这张卡的代价全在"**不该出现时出现了**"（一个已经干过活的用户，进页面被告知"从零开始"）。
import { describe, expect, it } from 'vitest';
import { FIRST_RUN_STEPS, shouldShowFirstRunCard } from '../src/modules/goods/firstRun';

describe('shouldShowFirstRunCard', () => {
  it('零款 + 队列已拉过且为空 → 出现（全新安装的唯一时刻）', () => {
    expect(shouldShowFirstRunCard({ stylesTotal: 0, queueGroups: 0 })).toBe(true);
  });

  it('队列**没拉过**（null）→ 不出现 —— null 不是"空"，那是"不知道"', () => {
    // 判据写 `!queueGroups` 或者 `(queueGroups ?? 0) === 0` 都会在这里变红，
    // 而那正是 2026-10-08 那条笔记记下的现行犯。
    expect(shouldShowFirstRunCard({ stylesTotal: 0, queueGroups: null })).toBe(false);
  });

  it('款数汇总**没拉到**（null）→ 不出现 —— 同样不能用 0 顶替', () => {
    expect(shouldShowFirstRunCard({ stylesTotal: null, queueGroups: 0 })).toBe(false);
  });

  it('已经有款 → 不出现（这条卡的代价全在"不该出现时出现了"）', () => {
    expect(shouldShowFirstRunCard({ stylesTotal: 3, queueGroups: 0 })).toBe(false);
  });

  it('订单已经进了队列 → 不出现（"做完即消失"：导完订单它就该走）', () => {
    expect(shouldShowFirstRunCard({ stylesTotal: 0, queueGroups: 7 })).toBe(false);
  });

  it('两个都没拉过 → 不出现（首屏那一瞬间不能替用户宣布结论）', () => {
    expect(shouldShowFirstRunCard({ stylesTotal: null, queueGroups: null })).toBe(false);
  });
});

describe('FIRST_RUN_STEPS', () => {
  it('恰好三步、顺序是 订单 → 店铺 → 看要拿什么（顺序错了这三步就不成立）', () => {
    // 第三步 2026-10-28 由 `relate`（点一款认款）改成 `stats`：归款已经是导入时自动完成的，
    // 把"逐个认款"当第三步会让用户每次导入都去做一遍系统已经做完的事。
    // ⚠️ 这条断言是**故意的**：改回 `relate` 必须先改这里，逼人重新想一遍那件事还需不需要人做。
    expect(FIRST_RUN_STEPS.map((s) => s.id)).toEqual(['orders', 'shops', 'stats']);
  });

  it('第三步不再教人"逐个认款"（这句文案已不成立，改回来会误导）', () => {
    const last = FIRST_RUN_STEPS[FIRST_RUN_STEPS.length - 1];
    expect(last.title).not.toMatch(/认款/);
    expect(last.desc).not.toMatch(/点开左边任意一款/);
    // 反过来：它必须真的说清"去哪看"（不说落点，这一步就只是一句感想）
    expect(`${last.title}${last.desc}`).toMatch(/拿货/);
  });

  it('每一步都真的有说明文案（空 desc 会在界面上渲染成一行空白）', () => {
    for (const s of FIRST_RUN_STEPS) {
      expect(s.title.trim().length).toBeGreaterThan(0);
      expect(s.desc.trim().length).toBeGreaterThan(0);
    }
  });
});
