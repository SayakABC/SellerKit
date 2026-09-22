// UI 岛主题令牌注入清单 × 宿主令牌定义 —— 钉住「宿主加了令牌但忘了加进注入清单」的漂移。
//
// 背景（2026-09-21 真实故障）：宿主 src/styles/index.css 定义了 --wb-shadow，
// 但 uiBridgeHost.ts 的 WB_THEME_TOKENS（注入 iframe 的显式清单）漏了它。
// 该清单是确定性读取路径——collectWbThemeVars 的第二步「索引枚举补齐」在 Chromium 下
// 拿不到自定义属性，因此漏项的令牌在岛内是**永久缺失**的：
// var(--wb-shadow) 解析失败 → 整条 box-shadow 声明被丢弃 → 抽屉完全没有投影
// （表现为「岛屿样式跟宿主主题不一致」，且不报任何错）。
//
// 本测试把「注入清单 ⊇ index.css 定义的令牌」变成硬约束；新增令牌时漏改一处即失败。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { WB_THEME_TOKENS } from '@/core/plugin/uiBridgeHost';

const indexCssPath = fileURLToPath(new URL('../src/styles/index.css', import.meta.url));

/** 提取 index.css 中定义的 --wb-* 令牌名（含 :root 与 [data-theme='dark'] 两处） */
function tokensDefinedInHostStyles(): Set<string> {
  const css = readFileSync(indexCssPath, 'utf8');
  return new Set([...css.matchAll(/(--wb-[a-z0-9-]+)\s*:/g)].map((m) => m[1]));
}

describe('UI 岛主题令牌注入清单', () => {
  it('宿主 index.css 定义的每个 --wb-* 令牌都在注入清单里', () => {
    const defined = [...tokensDefinedInHostStyles()].sort();
    const injected = new Set<string>(WB_THEME_TOKENS);
    const missing = defined.filter((t) => !injected.has(t));

    expect(
      missing,
      `以下令牌在 src/styles/index.css 有定义，但未列入 uiBridgeHost.ts 的 WB_THEME_TOKENS，` +
        `岛内将永久拿不到（var() 解析失败 → 整条声明被丢弃）：\n  ${missing.join('\n  ')}`,
    ).toEqual([]);
  });

  it('注入清单里的令牌宿主都有定义（避免推送空值）', () => {
    const defined = tokensDefinedInHostStyles();
    const orphan = WB_THEME_TOKENS.filter((t) => !defined.has(t));
    expect(orphan, `注入清单中宿主未定义的令牌：${orphan.join(', ')}`).toEqual([]);
  });

  it('注入清单自身不含重复项', () => {
    expect(new Set(WB_THEME_TOKENS).size).toBe(WB_THEME_TOKENS.length);
  });
});
