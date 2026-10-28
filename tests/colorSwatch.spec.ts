// tests/colorSwatch.spec.ts
// 款色色块字典的回归网（R3-5 把内联字典抽成独立文件；2026-09-22 由 extensions/ 迁入 src/lib/）。
//
// 为什么值得单测：这批 hex 是**业务数据**（款色 → 现实颜色的映射），抽文件只是为了
// 让组件不再出现硬编码色值，语义必须稳定——否则款色色块会静默变色，
// 而这是"看起来没坏"的一类缺陷（用户只会觉得颜色不对，不会认为功能有问题）。
//
// 2026-10-24：SKU 矩阵开始按色名画色块（用户口径「颜色不够直观」），于是这份字典从
// "16 个 `X色`"扩到"单字 + 描述式"（黑 / 墨绿 / 香芋紫）。原有 16 个色值**一个都没改**，
// 新增的是"别的名字也能命中"——因此下面的断言从"键必须 16 个"改成"键与值都得合法"，
// 再加两条这条扩展真正会错的判据：最长匹配、以及"认不出返回 null"。
//
// 为什么用 @/lib 而不是相对路径指向 extensions/（2026-09-22）：extensions/order-insight
// 已下记为市场 UI 岛、目录只作源码留档，测试若从那里 import，删留档目录会**连带打挂本测试
// 与 vue-tsc**（且报错不会提示"因为留档被删了"）。迁到 src/lib 后留档目录才真的不进任何链路。
// （补记 2026-10-05：那个岛本身也已整体下架，宿主是这份色卡的唯一引用方 —— 该迁移判断再次成立。）

import { describe, expect, it } from 'vitest';
import { COLOR_SWATCH, COMMON_COLORS, findSwatch } from '@/lib/colorSwatch';

describe('colorSwatch · 款色色块', () => {
  it('键全是中文色名、值是 6 位 hex（不随主题变化的绝对色）', () => {
    expect(Object.keys(COLOR_SWATCH).length).toBeGreaterThanOrEqual(16);
    expect(Object.keys(COLOR_SWATCH).every((k) => /^[\u4e00-\u9fa5]+$/.test(k))).toBe(true);
    for (const v of Object.values(COLOR_SWATCH)) {
      expect(v).toMatch(/^#[0-9a-f]{6}$/i);
    }
  });

  it('精确色名命中对应色值（16 个原有色值不变）', () => {
    expect(findSwatch('黑色')).toBe('#3a3a3a');
    expect(findSwatch('白色')).toBe('#f5f5f5');
    expect(findSwatch('藏青')).toBe('#2f3b5e');
    expect(findSwatch('军绿')).toBe('#5b6b46');
    expect(findSwatch('酒红')).toBe('#7d2f3a');
  });

  it('⭐ 单字色名也要能认（平台色名最常见的写法；旧实现只认 `X色`，一半的行没有色块）', () => {
    expect(findSwatch('黑')).toBe(COLOR_SWATCH['黑色']);
    expect(findSwatch('白')).toBe(COLOR_SWATCH['白色']);
    expect(findSwatch('藏青')).not.toBeNull();
  });

  it('⭐ 最长匹配：混色名不许被主色吃掉（酒红 ≠ 红、墨绿 ≠ 绿、香芋紫 ≠ 紫）', () => {
    expect(findSwatch('酒红')).not.toBe(findSwatch('红'));
    expect(findSwatch('墨绿')).not.toBe(findSwatch('绿'));
    expect(findSwatch('香芋紫')).not.toBe(findSwatch('紫'));
    // 反过来：纯色名仍该落到纯色上（否则上面三条"不相等"可以靠"全都返回 null"作弊）
    expect(findSwatch('红')).toBe(COLOR_SWATCH['红']);
    expect(findSwatch('紫')).toBe(COLOR_SWATCH['紫']);
  });

  it('子串匹配：复合色名命中内层色（深蓝色 → 蓝色，浅卡其 → 卡其）', () => {
    expect(findSwatch('深蓝色')).toBe(COLOR_SWATCH['蓝色']);
    expect(findSwatch('浅卡其')).toBe(COLOR_SWATCH['卡其']);
    expect(findSwatch('藏青色')).toBe(COLOR_SWATCH['藏青']);
  });

  it('认不出 → null（不拿中性灰冒充"这个色就是灰的"）', () => {
    expect(findSwatch('BLACK')).toBeNull(); // 字典只认中文
    expect(findSwatch('4')).toBeNull(); // 平台数字色号
    expect(findSwatch('自定义')).toBeNull();
    expect(findSwatch('')).toBeNull();
    expect(findSwatch(undefined as unknown as string)).toBeNull();
    expect(findSwatch(null as unknown as string)).toBeNull();
  });

  it('★ 关键契约：色值与主题无关（传什么主题都必须返回同一 hex）', () => {
    // 反向断言：色值里不能出现 CSS 变量引用——一旦有人"顺手令牌化"，此断言会失败。
    for (const v of Object.values(COLOR_SWATCH)) {
      expect(v).not.toContain('var(');
      expect(v).not.toContain('--wb-');
    }
  });

  it('⭐ 常用色调色板每一项都认得出、彼此不重复（否则那一排会出现没有色块的文字 / 点两个一样的色）', () => {
    expect(COMMON_COLORS.length).toBeGreaterThanOrEqual(8);
    // 自证非空转：这条一旦空转，"每项都认得出"就是零次循环的恒真
    expect(COMMON_COLORS.length).toBeGreaterThan(0);
    for (const c of COMMON_COLORS) {
      expect(findSwatch(c), `常用色「${c}」在词表里认不出`).not.toBeNull();
    }
    expect(new Set(COMMON_COLORS).size).toBe(COMMON_COLORS.length);
    // 短词不许被长词吃掉：调色板上的「红」必须是纯红，不是酒红的色值
    expect(findSwatch('红')).toBe(COLOR_SWATCH['红']);
  });
});
