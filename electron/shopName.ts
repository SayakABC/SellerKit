// electron/shopName.ts
// 名称归一的**纯函数层**（零依赖：不 import 任何模块，尤其不碰 better-sqlite3）。
//
// 为什么单独成文件：`electron/*-db.ts` 因 better-sqlite3 的 Electron ABI（149）在系统 Node（127）下
// 无法被 vitest 加载，只能走 `scripts/*-db-smoke.cjs`。把"怎么算同一个名字"这条唯一有正确性风险的
// 逻辑摘出来做成无依赖模块，就能被 vitest 直接覆盖（`tests/shopName.spec.ts`），DB 层只留 SQL。
//
// 口径（DOMAIN_INTEGRATION_PLAN G6 已裁定）：
//   1. **只做「去空白」这一种归一**，不做模糊匹配、不做大小写折叠 —— 相似度只能出"建议"，
//      永不写 `ref_id`（ADR-002「Q3 数据证据」：真实数据里相似店名是不同店，自动合并会把钱算错）。
//   2. **不可见字符必须剥掉**：Excel 导出与复制粘贴常带零宽 / BOM，肉眼完全一致却是两个不同字符串。
//      不剥掉就正好复现 D2 那个故障 —— "Excel 多一个空格即归成两家店且不报错"。
//   3. 全角空格（U+3000）与连续空白合并成一个半角空格：中文店铺名里 `"店<U+3000>A"` 与 `"店 A"` 是同一家。

/** 不可见字符：零宽连接符族 + 行/段分隔符 + BOM。整段剥离（不是换成空格）。 */
const INVISIBLE = /[\u200b-\u200f\u2028\u2029\ufeff]/g;
/** 各类空白（`\s` 本身已含 U+3000，显式写出只为让口径可见）→ 合并成单个半角空格 */
const SPACES = /[\s\u3000]+/g;

/**
 * 归一成匹配键。空 / 纯空白 → `''`（调用方须跳过空键，否则"合计""-"这类噪音会把真问题淹没）。
 */
export function toNameKey(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  return raw.replace(INVISIBLE, '').replace(SPACES, ' ').trim();
}

/** 一处历史文本来源的一组原始值（SQL `GROUP BY <原文>` 的产物） */
export interface NameSourceGroup {
  /** 来源标识：order / purchase / ae …（仅用于展示"这条名字出自哪） */
  source: string;
  /** 原始文本（未归一） */
  raw: string;
  /** 出现条数 */
  count: number;
}

/** 合并后的名称 */
export interface MergedName {
  /** 归一键 —— `map` / `unmap` 的入参，也是 `sk_name_map` 的唯一键组成部分 */
  key: string;
  /** 展示用原文 */
  raw: string;
  /** 出现条数（跨来源累加） */
  occurrences: number;
  /** 出现过的来源标识（去重、保序） */
  sources: string[];
}

/**
 * 按归一键合并多个来源的原始值分组。
 *
 * 展示原文取**最短形态**（同时存在 `"店A "` 与 `"店A"` 时取后者），同长度取字典序最小 ——
 * 这样展示结果不依赖 SQL 的返回顺序（"默认值靠语义不靠位置"）。
 */
export function mergeNameGroups(groups: readonly NameSourceGroup[]): MergedName[] {
  const byKey = new Map<string, MergedName>();
  for (const g of groups) {
    const key = toNameKey(g?.raw);
    if (!key) continue; // 空 / 纯空白：不是店铺名，不进名单
    const count = Number.isFinite(g?.count) && g.count > 0 ? Math.floor(g.count) : 0;
    const source = typeof g?.source === 'string' ? g.source : '';
    const raw = typeof g?.raw === 'string' ? g.raw : '';
    const hit = byKey.get(key);
    if (!hit) {
      byKey.set(key, { key, raw, occurrences: count, sources: source ? [source] : [] });
      continue;
    }
    hit.occurrences += count;
    if (source && !hit.sources.includes(source)) hit.sources.push(source);
    if (isBetterDisplayRaw(raw, hit.raw)) hit.raw = raw;
  }
  // 稳定排序：出现次数降序 → 归一键升序（次数相同的顺序可预期，不随 Map 插入顺序漂移）
  return [...byKey.values()].sort(
    (a, b) => b.occurrences - a.occurrences || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
}

/**
 * 展示原文择优：越短越好（更可能是"干净"的那一份）；同长取字典序最小。
 * 导出给 `shopSku.ts` 复用 —— "同一归一键展示哪一份原文"只能有一个口径。
 */
export function isBetterDisplayRaw(candidate: string, current: string): boolean {
  if (!current) return true;
  if (candidate.length !== current.length) return candidate.length < current.length;
  return candidate < current;
}
