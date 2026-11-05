// src/modules/shop-accounts/shipRateFormat.ts
// 「物流运费」资料项的展示层纯函数（2026-10-15 由 UI 岛 dist/lib.js 迁入）。
//
// 迁入时做了两处**收口**（岛时代的两份实现，进宿主后没必要保留）：
//   ① `rangeText` → 直接用宿主 `@/lib/shipRateQuote` 的 `formatRange`（逐字同口径，
//      岛的注释本来就写着"与宿主同口径，两边都只是显示"—— 那就不该有两份）；
//   ② 删掉 `esc`：Vue 模板自动转义，字符串拼 HTML 是岛时代没有框架的产物。
//
// ⚠️ 这里**不含任何计价逻辑** —— 金额一律来自 shipRateOps 的返回值，界面不重算
// （档位/取整/类别优先级只有 @/lib/shipRate* 一份实现，见 shipRateOps.ts 头部注释）。

import { formatRange } from '@/lib/shipRateQuote';
import type { QuoteRow } from '@/lib/shipRateQuote';
import type { Category } from '@/lib/shipRate';

/** 计费类别标签（与 shipRate.ts 的 Category 一一对应） */
export const CATEGORY_LABELS: Record<string, string> = {
  general: '普货小包',
  special: '非普货小包',
  bulk: '大包',
  // `any` = 该表**整个不分品类**（燕文 / 4PX / 超级经济这类单一价线路）。
  // 不能显示成"普货小包"：那是在把"不分品类"谎称成"普货"。
  any: '不分品类',
};

/**
 * 报价币种标签。
 * ⚠️ 值是 `''` 时表示表头**没标注**币种 —— 宿主会因此拒算，
 * 必须如实显示"未标注"，不能显示成"人民币"。
 */
export const CURRENCY_LABELS: Record<string, string> = {
  CNY: '人民币',
  USD: '美元',
  '': '未标注',
};

/** 币种 → 展示文本 */
export const currencyText = (c: string): string => CURRENCY_LABELS[c] || c || '未标注';

/** 计价模式标签 */
export const MODE_LABELS: Record<string, string> = {
  perKg: '费率×克重+挂号',
  firstStep: '首重+续重',
};

/** 取整口径标签 */
export const ROUNDING_LABELS: Record<string, string> = {
  round: '四舍五入到分',
  ceil: '向上进位到分',
};

/** 计费类别选项（查询页的切换器用；auto = 宿主按重量段自动判定） */
export const CATEGORY_OPTIONS: Array<{ value: string; label: string }> = [
  { value: 'auto', label: '自动判定' },
  { value: 'general', label: '普货小包' },
  { value: 'special', label: '非普货小包' },
  { value: 'bulk', label: '大包' },
];

/** 类别选项值 → 标签（摘要行用） */
export const categoryLabel = (value: string): string =>
  (CATEGORY_OPTIONS.find((o) => o.value === value) || {}).label || value;

/** 价卡的类别集合 → 展示文本（韩国那张同时适用普货与非普货） */
export function categoriesText(categories: string[] | undefined): string {
  const list = Array.isArray(categories) ? categories : [];
  return list.map((c) => CATEGORY_LABELS[c] || c).join(' / ') || '—';
}

/** 金额：两位小数（宿主已按取整口径取整，这里只做显示） */
export const money = (n: number): string => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '—');

/** 克重 → 展示文本 */
export const gramsText = (g: number): string =>
  Number(g) >= 1000 ? `${+(Number(g) / 1000).toFixed(3)}kg` : `${Number(g)}g`;

/** 档位区间 → 展示文本（复用宿主 formatRange，同一口径） */
export const rangeText = formatRange;

/** 费用构成文本（两种模式的科目不同，故统一在这里拼） */
export function breakdownText(row: QuoteRow): string {
  const b = row && row.breakdown;
  if (!b) return '—';
  if (row.card && row.card.mode === 'firstStep') {
    const step = Number(row.card.stepFee) || 0;
    const steps = step > 0 ? Math.round(b.extra / step) : 0;
    const stepPart = b.extra > 0 ? ` + 续重 ${money(step)}×${steps}` : '';
    return `首重 ${money(b.first)}${stepPart}`;
  }
  return `配送 ${money(b.delivery)} + 挂号 ${money(b.register)}`;
}

/** 单行复制文本（TSV 便于粘进表格） */
export function rowCopyText(row: QuoteRow, grams: number): string {
  return [
    row.nameCn,
    row.code || '',
    row.category ? CATEGORY_LABELS[row.category] || row.category : '',
    row.variant ? `（${row.variant}）` : '',
    gramsText(grams),
    money(row.fee),
  ]
    .filter(Boolean)
    .join('\t');
}

/** 全量复制文本（表头 + 每国一行） */
export function allCopyText(rows: QuoteRow[], grams: number): string {
  const head = ['国家/地区', 'Code', '类别', '变体', '克重', '运费(元)', '费用构成'];
  const body = rows
    .filter((r) => r.ok)
    .map((r) =>
      [
        r.nameCn,
        r.code || '',
        r.category ? CATEGORY_LABELS[r.category] || r.category : '',
        r.variant || '',
        gramsText(grams),
        money(r.fee),
        breakdownText(r),
      ].join('\t'),
    );
  return [head.join('\t'), ...body].join('\n');
}

/** 文件名（跨平台取最后一段） */
export const baseName = (p: string): string => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() || '';

/** 类别值的合法集合（持久化偏好读回时的校验用） */
export const CATEGORY_VALUES: Array<Category | 'auto'> = ['auto', 'general', 'special', 'bulk'];
