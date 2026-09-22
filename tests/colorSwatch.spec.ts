// tests/colorSwatch.spec.ts
// 款色色块字典的回归网（R3-5 把内联字典抽成独立文件；2026-09-22 由 extensions/ 迁入 src/lib/）。
//
// 为什么值得单测：这批 hex 是**业务数据**（款色 → 现实颜色的映射），抽文件只是为了
// 让组件不再出现硬编码色值，语义必须与抽取前逐字节一致——否则款色色块会静默变色，
// 而这是"看起来没坏"的一类缺陷（用户只会觉得颜色不对，不会认为功能有问题）。
//
// 为什么用 @/lib 而不是相对路径指向 extensions/（2026-09-22）：extensions/order-insight
// 已下记为市场 UI 岛、目录只作源码留档，测试若从那里 import，删留档目录会**连带打挂本测试
// 与 vue-tsc**（且报错不会提示"因为留档被删了"）。迁到 src/lib 后留档目录才真的不进任何链路。

import { describe, expect, it } from 'vitest';
import { COLOR_SWATCH, UNKNOWN_SWATCH, swatchOf } from '@/lib/colorSwatch';

describe('colorSwatch · 款色色块', () => {
  it('字典为 16 个常见颜色，键为中文色名', () => {
    expect(Object.keys(COLOR_SWATCH)).toHaveLength(16);
    expect(Object.keys(COLOR_SWATCH).every((k) => /^[\u4e00-\u9fa5]+$/.test(k))).toBe(true);
  });

  it('每个色值都是 6 位 hex（不随主题变化的绝对色）', () => {
    for (const [, v] of Object.entries(COLOR_SWATCH)) {
      expect(v).toMatch(/^#[0-9a-f]{6}$/i);
    }
    expect(UNKNOWN_SWATCH).toMatch(/^#[0-9a-f]{6}$/i);
  });

  it('精确色名命中对应色值', () => {
    expect(swatchOf('黑色')).toBe('#3a3a3a');
    expect(swatchOf('白色')).toBe('#f5f5f5');
    expect(swatchOf('藏青')).toBe('#2f3b5e');
    expect(swatchOf('军绿')).toBe('#5b6b46');
    expect(swatchOf('酒红')).toBe('#7d2f3a');
  });

  it('子串匹配：复合色名命中内层色（深蓝色 → 蓝色，浅卡其 → 卡其）', () => {
    expect(swatchOf('深蓝色')).toBe(COLOR_SWATCH['蓝色']);
    expect(swatchOf('浅卡其')).toBe(COLOR_SWATCH['卡其']);
    expect(swatchOf('藏青色')).toBe(COLOR_SWATCH['藏青']);
  });

  it('匹配前统一转小写（原实现行为），英文输入不误配', () => {
    expect(swatchOf('BLACK')).toBe(UNKNOWN_SWATCH); // 字典只认中文色名
    expect(swatchOf('Red')).toBe(UNKNOWN_SWATCH);
  });

  it('未识别 / 空值 → 中性灰兜底（不是 undefined，避免 style 出现空 background）', () => {
    expect(swatchOf('雾霾蓝')).toBe(UNKNOWN_SWATCH);
    expect(swatchOf('')).toBe(UNKNOWN_SWATCH);
    expect(swatchOf(undefined as unknown as string)).toBe(UNKNOWN_SWATCH);
    expect(swatchOf(null as unknown as string)).toBe(UNKNOWN_SWATCH);
  });

  it('★ 关键契约：色值与主题无关（传什么主题都必须返回同一 hex）', () => {
    // 反向断言：色值里不能出现 CSS 变量引用——一旦有人"顺手令牌化"，此断言会失败。
    for (const v of [...Object.values(COLOR_SWATCH), UNKNOWN_SWATCH]) {
      expect(v).not.toContain('var(');
      expect(v).not.toContain('--wb-');
    }
  });
});
