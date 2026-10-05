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
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
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

// ─────────────────────────────────────────────────────────────────────────────
// UI 岛 color-scheme 声明纪律 —— 钉住「岛内在元素级写死 color-scheme: light」这类静默失效。
//
// 背景（2026-09-22 真实故障）：宿主把当前主题以**内联样式**写到 iframe 的 <html>
// （uiBridgeHost 下发 theme.mode → electron/plugin-ui-runtime.js#applyTheme 写 color-scheme）。
// 内联只赢在「同一个元素」上：岛内若在**元素级**声明 color-scheme: light，
// 该元素及其子树的原生件（日期选择器 / 下拉弹层 / 滚动条 / 复选框 / 输入光标）仍是浅色——
// 但文字与面板都已跟随主题变黑，表现为「页面样式跟宿主主题不一样」，且不报任何错。
// 历史反面实现：shop-accounts 的 `.date-input { color-scheme: light }`（还配了一条永不命中的
// `:global([data-theme='dark'])` —— 宿主只注入内联令牌，**不同步 data-theme 属性**到 iframe）。
//
// 本测试把「元素级只允许继承」变成硬约束：`:root`/`html` 上的首帧兜底允许，
// 其余选择器上写死 light/dark 即失败。
// ─────────────────────────────────────────────────────────────────────────────

interface ColorSchemeDecl {
  file: string;
  selector: string;
  value: string;
}

/**
 * 递归收集目录下的 .css / .vue 文件。
 * 刻意**不跳过 dist/**：无构建步骤的岛（excel-copy / shipping-rate）源码就在
 * dist/ 下，跳过等于完全不检查它们；构建型岛的 dist 会与 src 重复扫描一份，代价可接受。
 * （原三例中的 order-insight 已于 2026-10-05 整体下架 —— 但这条规则要留着，
 *   它约束的是"手写岛"这一类，不是某一个岛。）
 */
function collectFiles(dir: string, exts: RegExp, out: string[] = []): string[] {
  let entries: import('node:fs').Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return out; // 目录不存在（如未构建 dist）→ 静默跳过
  }
  for (const e of entries) {
    if (e.name === 'node_modules' || e.name.startsWith('.')) continue;
    const p = join(dir, e.name);
    if (e.isDirectory()) collectFiles(p, exts, out);
    else if (exts.test(e.name)) out.push(p);
  }
  return out;
}

/**
 * 文件文本缓存（按路径）。
 * 本文件有多个用例各自遍历同一批岛文件；不缓存时会**重复读整棵树**。
 * 本机文件读取很慢（2026-09-27 实测：36 个文件 414 KB 需 683 ms），而全量并发跑还会放大数倍 ——
 * 重复读会把用例推到 5 s 默认超时线上，表现成"单跑绿、全量红"的假失败。
 */
const cssTextCache = new Map<string, string>();
function readTextCached(file: string): string {
  const hit = cssTextCache.get(file);
  if (hit !== undefined) return hit;
  const text = readFileSync(file, 'utf8');
  cssTextCache.set(file, text);
  return text;
}

/** 抽出所有「选择器 { 声明体 }」里出现 color-scheme 的声明（先剥注释，避免注释里的示例误报） */
function colorSchemeDecls(css: string, file: string): ColorSchemeDecl[] {
  const bare = css.replace(/\/\*[\s\S]*?\*\//g, '');
  const out: ColorSchemeDecl[] = [];
  for (const m of bare.matchAll(/([^{}]+)\{([^{}]*)\}/g)) {
    const decl = /color-scheme\s*:\s*([^;}]+)/i.exec(m[2]);
    if (!decl) continue;
    out.push({ file, selector: m[1].trim(), value: decl[1].trim().toLowerCase() });
  }
  return out;
}

/** 该选择器是否落在根元素上（根元素允许写死，作为首帧兜底） */
function isRootSelector(selector: string): boolean {
  return /(^|[\s,>~+])(:root|html)\b/.test(selector);
}

const UI_PLUGINS_DIR = fileURLToPath(new URL('../ui-plugins', import.meta.url));
const UI_TEMPLATE_DIR = fileURLToPath(new URL('../scripts/ui-plugin-template', import.meta.url));

// 下面两组的每个用例都会遍历 ui-plugins/ 全部岛的 .css/.vue（数据量随**每新增一个岛**增长），
// 在本机慢盘 + 全量并发跑时，默认 5 s 会踩线（表现是"单跑绿、全量红"的假失败）。
// 断言本身是硬的，加时只是不再把"机器忙"报成"纪律被破坏"。
describe('UI 岛 color-scheme 声明纪律', { timeout: 20000 }, () => {
  it('元素级不得写死 color-scheme（只允许 inherit；根元素允许首帧兜底）', () => {
    const files = [
      ...collectFiles(UI_PLUGINS_DIR, /\.(css|vue)$/),
      ...collectFiles(UI_TEMPLATE_DIR, /\.(css|vue)$/),
    ];
    const violations: ColorSchemeDecl[] = [];
    for (const f of files) {
      for (const d of colorSchemeDecls(readTextCached(f), f)) {
        // 允许：inherit（跟随宿主 <html> 内联值）、normal 之外的「light dark」双值（跟随系统）
        if (d.value === 'inherit' || d.value === 'light dark' || d.value === 'dark light') continue;
        if (isRootSelector(d.selector)) continue;
        violations.push(d);
      }
    }
    const detail = violations
      .map((v) => `  ${v.file.replace(fileURLToPath(new URL('..', import.meta.url)), '.')}  ${v.selector} { color-scheme: ${v.value} }`)
      .join('\n');
    expect(
      violations,
      `元素级写死 color-scheme 会盖过宿主写在 <html> 上的内联主题值，深色主题下该元素子树里的\n` +
        `原生控件（日期面板/下拉弹层/滚动条/复选框）仍会发白。改成 color-scheme: inherit：\n${detail}`,
    ).toEqual([]);
  });

  it('不允许用 [data-theme=...] 选择器自我纠正（宿主不同步该属性到 iframe）', () => {
    const files = [
      ...collectFiles(UI_PLUGINS_DIR, /\.(css|vue)$/),
      ...collectFiles(UI_TEMPLATE_DIR, /\.(css|vue)$/),
    ];
    const offenders = files.filter((f) => {
      const bare = readTextCached(f).replace(/\/\*[\s\S]*?\*\//g, '');
      return /\[\s*data-theme\s*[~|^$*]?=/.test(bare);
    });
    expect(
      offenders,
      `以下文件用了 [data-theme=...] 选择器，但 UI 岛内该属性永不存在（宿主只注入内联令牌与\n` +
        `color-scheme），这类规则是死代码；请改用 --wb-* 令牌或 color-scheme: inherit：\n  ` +
        offenders.join('\n  '),
    ).toEqual([]);
  });
});
