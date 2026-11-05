// 字阶级差 × 骨架类字号来源 —— 钉住「相邻两档只差 2px」这个已经复发过一次的病。
//
// 背景（2026-11-03 界面审查，真实产物无头取证）：整套界面的五档字级挤在 12–17px
// （17 页标题 / 15 主数字 / 13 正文 / 12.5 说明 / 12 表头），相邻只差 0.5–2px。
// 1440 宽的窗口里这等于**没有层级**：用户扫屏找不到"从哪开始读"，于是整页读成一块灰。
// 后来把"数字是主角"这条补上（`.wb-metric` 用 column-reverse 把数字放到标签上方），
// 级差才真正成立。方案见 `docs/plans/UI_DESIGN_PROPOSAL_2026-11-03.md` §4.1。
//
// ⚠️ 为什么必须是测试而不是注释：这条缺陷的特点是**看起来还行、用起来说不清哪里不对**，
//    没有肉眼可见的硬伤 —— 于是每次"顺手调一下字号"都会往回收一点，一年后又挤成一团。
//    这里把两件事变成硬约束：
//      ① 字阶令牌**严格递减**且只有一档（重复档位 = 又回到"相邻只差 2px"）；
//      ② 六个骨架类的 font-size 只能用令牌，不许再写裸 px（裸值会让令牌形同虚设）。
//
// 不测的部分（有意）：模板里的 Tailwind `text-[13px]` 局部写法一律不管 ——
// 那是"某处需要特殊处理"，不是"体系"；本测试只守体系。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';

const cssPath = fileURLToPath(new URL('../src/styles/index.css', import.meta.url));
const css = readFileSync(cssPath, 'utf8');

/** `:root { ... }` 里定义的 --wb-fs-* 档位（名字 → px 值） */
function typeScale(): Array<{ name: string; px: number }> {
  const root = css.match(/:root\s*\{([\s\S]*?)\n\}/);
  if (!root) throw new Error('index.css 里找不到 :root 块');
  return [...root[1].matchAll(/--wb-fs-([a-z]+)\s*:\s*([\d.]+)px/g)].map((m) => ({
    name: m[1],
    px: Number(m[2]),
  }));
}

/** 取某个选择器的声明块（这些骨架类都是平铺单层，没有嵌套规则） */
function decls(selector: string): string {
  const esc = selector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const m = css.match(new RegExp(`(?:^|\\n)\\s*${esc}\\s*\\{([\\s\\S]*?)\\n\\s*\\}`, 'm'));
  if (!m) throw new Error(`index.css 里找不到规则：${selector}`);
  return m[1];
}

describe('字阶级差', () => {
  it('七档齐全（hero / display / title / subtitle / body / caption / micro）', () => {
    const names = typeScale().map((t) => t.name);
    expect(names.sort()).toEqual(
      ['body', 'caption', 'display', 'hero', 'micro', 'subtitle', 'title'].sort(),
    );
  });

  it('严格递减，且没有重复档位（重复 = 又回到"相邻只差 2px"）', () => {
    const scale = typeScale();
    const sizes = scale.map((t) => t.px);
    // 按"从大到小"重新排一遍再比 —— 断言的是"这撮数能排成严格递减"，
    // 而不是"定义顺序刚好是递减"（顺序是实现细节，值才是契约）。
    const desc = [...sizes].sort((a, b) => b - a);
    expect(new Set(sizes).size, `有重复档位：${JSON.stringify(scale)}`).toBe(sizes.length);
    for (let i = 1; i < desc.length; i += 1) {
      expect(desc[i - 1], `档位过于接近：${desc[i - 1]} → ${desc[i]}`).toBeGreaterThan(desc[i]);
    }
  });

  it('主数字（hero）与正文（body）拉开 ≥ 1.4 倍 —— "数字是主角"要能量出来', () => {
    const get = (n: string) => typeScale().find((t) => t.name === n)?.px ?? 0;
    expect(get('hero') / get('body')).toBeGreaterThanOrEqual(1.4);
    // 常规指标数字与正文也得能一眼分开（≥1.5 倍才读得出"这是数、那是说明"）
    expect(get('display') / get('body')).toBeGreaterThanOrEqual(1.5);
  });
});

describe('骨架类的字号只从令牌来', () => {
  // 这六个类是"整站长相"，一改全都改。裸 px 会让令牌形同虚设（改档位时不跟着走）。
  const skeletons: Array<[string, string]> = [
    ['.wb-head__title', 'title'],
    ['.wb-head__desc', 'caption'],
    ['.wb-panel__head', 'subtitle'],
    ['.wb-empty__title', 'subtitle'],
    ['.wb-empty__desc', 'body'],
    ['.wb-table', 'body'],
    ['.wb-table th', 'caption'],
  ];

  for (const [selector, token] of skeletons) {
    it(`${selector} 用 var(--wb-fs-${token})`, () => {
      const body = decls(selector);
      expect(body, `${selector} 里写的不是令牌：\n${body}`).toContain(
        `font-size: var(--wb-fs-${token})`,
      );
    });
  }

  it('.wb-metric b 用 display 档（防止"改回 15px"这种回退）', () => {
    // 取 `.wb-metric b` 而不是 `.wb-metric`：前者是数字本身。
    const body = decls('.wb-metric b');
    expect(body).toContain('font-size: var(--wb-fs-display)');
  });

  it('.wb-metric 用 column-reverse 把数字放到视觉上方（DOM 仍是「标签 <b>数字</b>」）', () => {
    // ⚠️ 这条不是"样式偏好"，而是**断言契约的守卫**：三个 UI 冒烟用 textContent 做子串断言
    //    （/产品 2/），一旦有人"顺手"把标签与数字拆成两个兄弟元素，页面看着一样、
    //    但 textContent 会拼成 `产品2` ⇒ 一堆断言变红而没人知道为什么。
    //    column-reverse 是这条契约唯一的实现方式，所以它得钉住。
    expect(decls('.wb-metric')).toContain('flex-direction: column-reverse');
  });
});
