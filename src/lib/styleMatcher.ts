// src/lib/styleMatcher.ts
// 款式匹配纯函数（无副作用）：把 AI 识别结果（品类 + 区分特征）归一化为款式指纹，
// 指纹相等 → 同一款式。避免 LLM 命名漂移（同款两次识别名称不一致）导致同款拆成多个款编码。
// 与主进程 electron/order-db.ts 的 resolveStyle 配合：渲染层生成指纹，主进程按指纹查/建款。

/** 全角 → 半角 */
function fullToHalf(s: string): string {
  return s
    .replace(/[\uff01-\uff5e]/g, (c) => String.fromCharCode(c.charCodeAt(0) - 0xfee0))
    .replace(/\u3000/g, ' ');
}

/**
 * 文本归一化：小写、全角转半角、去标点与多余空白。
 * @param s 原始文本
 * @returns 归一化后的紧凑文本（可能为空串）
 */
export function normalizeText(s: string): string {
  return fullToHalf(String(s ?? ''))
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, ' ')
    .trim()
    .replace(/\s+/g, ' ');
}

/**
 * 构建款式指纹：归一化品类 + 排序后的归一化特征（逗号连接）。
 * 特征排序保证「短袖T恤 圆领 条纹」与「条纹 圆领 短袖T恤」指纹一致。
 * @param category 品类（如 短袖T恤）
 * @param features 区分特征数组（如 ['圆领','条纹']）
 * @returns 指纹字符串；品类与特征全空时返回空串（调用方应判空跳过）
 */
export function buildStyleFingerprint(category: string, features: string[]): string {
  const cat = normalizeText(category);
  // 去重 + 排序：模型可能两次输出同一特征（顺序/重复词漂移），必须归一，否则同款拆成多款编码
  const feats = [
    ...new Set(
      (features || [])
        .map((f) => normalizeText(f))
        .filter(Boolean)
        .sort(),
    ),
  ];
  return [cat, ...feats].filter(Boolean).join('|');
}

/**
 * 款式展示名（AI 原始词拼接，供主进程建款时使用；仅展示，不参与匹配）。
 * @param category 品类
 * @param features 区分特征数组
 * @returns 如「短袖T恤 圆领 条纹」
 */
export function buildStyleDisplayName(category: string, features: string[]): string {
  const cat = String(category ?? '').trim();
  const feats = (features || []).map((f) => String(f).trim()).filter(Boolean);
  return feats.length ? `${cat} ${feats.join(' ')}`.trim() : cat || '未命名款式';
}
