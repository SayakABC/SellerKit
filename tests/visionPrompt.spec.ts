// 识别提示词与归一化词表**必须同源**（2026-10-05）。
//
// 为什么值得一条守卫：这两处各写一份字面量时，"两头打架"是**静默**的 ——
//   · 提示词让模型从一份列表里选，而归一化按另一份字典匹配 ⇒ 模型选出的词归不了类、原样穿透；
//   · 颜色更典型：提示词要求写「底色+花色」的描述式，而归一化只做**整串**字典精确匹配
//     ⇒ 同一个颜色两次措辞不同就成两个款色（详见 docs/notes/2026-10-05-classify-auto-pipeline.md）。
// 症状要等到"同款拆成好几个款/款色"才看得见，且看起来像"模型不稳定"，方向完全错。
//
// ⚠️ 本文件能成立的前提：`VISION_PROMPT` 住在**纯模块** `src/core/ai/visionPrompt.ts`。
//    它原先在 `openaiCompatible.ts` 里，那个文件 import `@/core/network/request`，
//    而 `src/core/services/ipc.ts` 顶层求值 `window.electronAPI` ⇒ node 环境 import 直接抛，
//    只能退化成"扫源码文本"（模式写歪就恒绿）。别把提示词挪回去。
import { describe, it, expect } from 'vitest';
import { VISION_PROMPT } from '../src/core/ai/visionPrompt';
import { CATEGORY_WHITELIST, COLOR_WHITELIST } from '../src/lib/orderClassifier';

describe('识别提示词的枚举来自归一化词表（不是各抄一份）', () => {
  it('品类枚举是注入的', () => {
    expect(VISION_PROMPT).toContain(CATEGORY_WHITELIST.join('|'));
  });

  it('⭐ 颜色枚举也是注入的 —— 这条就是"颜色口径两头打架"的守卫', () => {
    expect(COLOR_WHITELIST.length).toBeGreaterThan(0);
    expect(VISION_PROMPT).toContain(COLOR_WHITELIST.join('|'));
  });

  it('自证非空转：两个枚举本身有内容（否则 join 出空串，"包含空串"恒真）', () => {
    expect(CATEGORY_WHITELIST.length).toBeGreaterThan(10);
    expect(COLOR_WHITELIST.length).toBeGreaterThan(20);
    expect(CATEGORY_WHITELIST.join('|').length).toBeGreaterThan(20);
    expect(COLOR_WHITELIST.join('|').length).toBeGreaterThan(40);
  });

  it('颜色的多色写法与解析规则成对：提示词说「底色+花色」，解析器按分隔符取底色', () => {
    // 这两句是**契约**：改提示词的写法就必须同步 COLOR_SPLIT_RE（orderClassifier 里），
    // 否则模型按新写法输出、归一化按旧分隔符切不动 ⇒ 又回到"描述式原样穿透"。
    expect(VISION_PROMPT).toContain('底色+花色');
    expect(VISION_PROMPT).toContain('底色在前');
  });
});
