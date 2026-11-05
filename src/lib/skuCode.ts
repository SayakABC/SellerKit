// SKU 编码规则（2026-10-25 用户口径「SKU编码需要增加SKU规则设置，并支持一键设置SKU编码」）。
//
// 为什么需要它：真库 411 个 SKU **零编码** —— 逐条手打 40 个编码没人会做，于是编码一直空着。
// 「规则 + 一键生成」是唯一现实的路径；但生成必须**可见、可撤销、只填空**：
// 编码是人对外的标识（供货单、对账都按它），覆盖掉已经核对过的编码比留空更糟。
//
// 纯函数在这里，UI 只负责"把结果填进 codeDraft"—— 因为编码会被写进 `pl_variants.code`
// （非空时全库唯一），规则算错一次就是几十条重复键，必须能单测。

/** 可用的占位符（顺序 = UI 上的提示顺序） */
export const SKU_CODE_TOKENS = [
  { key: '{code}', label: '款号' },
  { key: '{color}', label: '颜色ID' },
  { key: '{size}', label: '尺码' },
  { key: '{index}', label: '序号' },
] as const;

export const DEFAULT_SKU_CODE_RULE = '{code}-{color}-{size}';

/** 与 `validateMatrix` / 主进程 `str()` 的上限一致（超了会被静默截断，那是改数据） */
export const SKU_CODE_MAX = 64;

export interface SkuCodeSeed {
  /** 稳定标识（`variantId` 的字符串形式）—— 回填靠它对齐，不靠数组下标 */
  key: string;
  styleCode: string;
  color: string;
  /**
   * 该色在 `md_colors` 里的 id（2026-10-30 用户口径「SKU编码把color修改为颜色ID」）。
   *
   * `{color}` 渲染的是**它**，不是色名：色名是会被「归类」改写的标签（`藏蓝` → `藏青`），
   * 改完编码就跟实际色对不上；id 是主数据身份，改名不动。
   * 0 / 缺省 = 不在字典（还没归类的异写色、或字典没载入）⇒ **回落色名**，
   * 不能因为拿不到 id 就把这一段留空（那会生成 `S1--L` 这种残码）。
   */
  colorId?: number;
  size: string;
  /** 1-based，渲染成两位（01、02…） */
  index: number;
}

export interface SkuCodeDraft {
  key: string;
  code: string;
}

/**
 * 一条编码 = 规则里把占位符换掉。
 *
 * 三个刻意的选择：
 *   · **不认识的花括号原样保留**（不静默删掉）—— 人写了 `{style}` 却没被替换，
 *     看到输出里还带着 `{style}` 就会改规则；悄悄吃掉反而是"编码看着对、其实少一截"。
 *   · 字段为空 ⇒ 留空并把连着的那一段分隔符压成一个（`黑` 缺码时 `X-黑-` 变成 `X-黑`），
 *     因为 `X-黑-` 这种尾随分隔符在供货单上会被当成"还没填完"。
 *   · 规则为空 ⇒ 用默认规则（不是生成空编码 —— 空编码等于没设置）。
 */
export function renderSkuCode(rule: string, seed: SkuCodeSeed): string {
  const out = normalizeRule(rule)
    .replace(/\{code\}/g, String(seed.styleCode ?? '').trim())
    .replace(/\{color\}/g, colorToken(seed))
    .replace(/\{size\}/g, String(seed.size ?? '').trim())
    .replace(/\{index\}/g, String(Math.max(1, Math.round(seed.index))).padStart(2, '0'));
  return out
    .replace(/([-\s_/]+)\1+/g, '$1') // `--` / `  ` ⇒ 一个
    .replace(/^[-\s_/]+|[-\s_/]+$/g, '') // 首尾的分隔符没有意义
    .trim();
}

/** `{color}` 的取值：字典 id 优先，拿不到就回落色名（见 `SkuCodeSeed.colorId` 的说明） */
function colorToken(seed: SkuCodeSeed): string {
  const id = Number(seed.colorId ?? 0);
  return id > 0 ? String(id) : String(seed.color ?? '').trim();
}

function normalizeRule(rule: string): string {
  return String(rule ?? '').trim() || DEFAULT_SKU_CODE_RULE;
}

/** 规则里有没有**至少一个**已知占位符（没有 ⇒ 所有 SKU 会得到同一个常量编码） */
export function ruleHasToken(rule: string): boolean {
  const raw = normalizeRule(rule);
  return SKU_CODE_TOKENS.some((t) => raw.includes(t.key));
}

/**
 * 一批编码。**批内唯一** + 超长跳过：
 *   · 批内唯一：两行同名色（或颜色名只差一个空格）会渲染出同一个编码，而 `code` 非空时
 *     全库唯一 —— 直接写进去就是一次"保存失败、还不知道是哪一条"。这里给后来者加 `-2`。
 *   · 超长跳过并计数（不截断：截断会把两条不同 SKU 截成同一个编码）。
 * 全库唯一不在这里判（前端拿不到全库），交给保存时的库约束 + 错误提示。
 */
export function buildSkuCodes(
  rule: string,
  seeds: SkuCodeSeed[],
): { drafts: SkuCodeDraft[]; tooLong: number } {
  const used = new Set<string>();
  const drafts: SkuCodeDraft[] = [];
  let tooLong = 0;
  // 规则里一个已知占位符都没有 ⇒ 每个 SKU 都会渲染成同一个常量 —— 那不是编码，是灾难
  if (!ruleHasToken(rule)) return { drafts, tooLong: 0 };
  for (const seed of seeds) {
    const base = renderSkuCode(rule, seed);
    if (!base) continue; // 规则里一个字段都没用 ⇒ 不生成空编码
    if (base.length > SKU_CODE_MAX) {
      tooLong += 1;
      continue;
    }
    let code = base;
    let n = 1;
    while (used.has(code)) {
      n += 1;
      code = `${base}-${n}`;
      if (code.length > SKU_CODE_MAX) break;
    }
    if (used.has(code) || code.length > SKU_CODE_MAX) {
      tooLong += 1;
      continue;
    }
    used.add(code);
    drafts.push({ key: seed.key, code });
  }
  return { drafts, tooLong };
}
