// dist/lib.js
// 展示层纯函数：转义 / 标签 / 金额与克重格式化 / 复制文本。
// 这里**不含任何计价逻辑** —— 金额一律来自宿主的 quote op，岛内不重算（避免两端口径漂移）。

/** HTML 转义（视图全部用字符串拼 HTML，凡插值必过此函数） */
export const esc = (s) =>
  String(s ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');

/** 计费类别标签（与宿主 shipRate.ts 的 Category 一一对应） */
export const CATEGORY_LABELS = {
  general: '普货小包',
  special: '非普货小包',
  bulk: '大包',
  // `any` = 该表**整个不分品类**（燕文 / 4PX / 超级经济这类单一价线路）。
  // 不能显示成"普货小包"：那是在把"不分品类"谎称成"普货"。
  any: '不分品类',
};

/**
 * 报价币种标签（宿主 RateCard.currency）。
 * ⚠️ 值是 `''` 时表示表头**没标注**币种 —— 宿主会因此拒算，
 * 这里必须如实显示"未标注"，不能显示成"人民币"。
 */
export const CURRENCY_LABELS = {
  CNY: '人民币',
  USD: '美元',
  '': '未标注',
};

/** 币种 → 展示文本 */
export const currencyText = (c) => CURRENCY_LABELS[c] || c || '未标注';

/** 计价模式标签 */
export const MODE_LABELS = {
  perKg: '费率×克重+挂号',
  firstStep: '首重+续重',
};

/** 取整口径标签 */
export const ROUNDING_LABELS = {
  round: '四舍五入到分',
  ceil: '向上进位到分',
};

/** 工作类别选项（查询页的切换器用） */
export const CATEGORY_OPTIONS = [
  { value: 'auto', label: '自动判定' },
  { value: 'general', label: '普货小包' },
  { value: 'special', label: '非普货小包' },
  { value: 'bulk', label: '大包' },
];

/** 价卡的类别集合 → 展示文本（韩国那张同时适用普货与非普货） */
export function categoriesText(categories) {
  const list = Array.isArray(categories) ? categories : [];
  return list.map((c) => CATEGORY_LABELS[c] || c).join(' / ') || '—';
}

/** 金额：两位小数（宿主已按取整口径取整，这里只做显示） */
export const money = (n) => (Number.isFinite(Number(n)) ? Number(n).toFixed(2) : '—');

/** 克重 → 展示文本 */
export const gramsText = (g) =>
  Number(g) >= 1000 ? `${+(Number(g) / 1000).toFixed(3)}kg` : `${Number(g)}g`;

/**
 * 档位区间 → 展示文本。
 * 与宿主 `formatRange`（src/lib/shipRateQuote.ts）同口径 —— 两边都只是显示，
 * 真正的档位判定在宿主完成。
 */
export function rangeText(minG, maxG) {
  const fmt = (g) => (g >= 1000 ? `${+(g / 1000).toFixed(3)}kg` : `${g}g`);
  if (minG <= 0) return `≤${fmt(maxG)}`;
  if (!Number.isFinite(maxG) || maxG >= 30000) return `>${fmt(minG)}`;
  return `${fmt(minG)}–${fmt(maxG)}`;
}

/** 时间戳 → 本地时间文本 */
export function timeText(ts) {
  const n = Number(ts);
  if (!Number.isFinite(n) || n <= 0) return '—';
  const d = new Date(n);
  const p = (x) => String(x).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ${p(d.getHours())}:${p(d.getMinutes())}`;
}

/** 费用构成文本（两种模式的科目不同，故统一在这里拼） */
export function breakdownText(row) {
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
export function rowCopyText(row, grams) {
  return [
    row.nameCn,
    row.code || '',
    CATEGORY_LABELS[row.category] || '',
    row.variant ? `（${row.variant}）` : '',
    gramsText(grams),
    money(row.fee),
  ]
    .filter(Boolean)
    .join('\t');
}

/** 全量复制文本（表头 + 每国一行） */
export function allCopyText(rows, grams) {
  const head = ['国家/地区', 'Code', '类别', '变体', '克重', '运费(元)', '费用构成'];
  const body = rows
    .filter((r) => r.ok)
    .map((r) =>
      [
        r.nameCn,
        r.code || '',
        CATEGORY_LABELS[r.category] || '',
        r.variant || '',
        gramsText(grams),
        money(r.fee),
        breakdownText(r),
      ].join('\t'),
    );
  return [head.join('\t'), ...body].join('\n');
}

/** 文件名（跨平台取最后一段） */
export const baseName = (p) => String(p ?? '').split(/[\\/]/).filter(Boolean).pop() || '';
