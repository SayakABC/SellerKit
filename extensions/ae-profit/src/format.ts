// extensions/ae-profit/src/format.ts
// 「利润追踪」共享展示工具：时间/金额/百分比格式化 + 费用科目 label 字典。
// 纯展示函数，无副作用；金额不带单位，单位由列头/卡片语境标明（订单行=原币种，引擎聚合=CNY）。

/** 时间展示：取前 16 位（yyyy-MM-dd HH:mm），ISO T 分隔替换为空格 */
export function fmtTime(s: string): string {
  if (!s) return '—';
  return s.length >= 16 ? s.slice(0, 16).replace('T', ' ') : s;
}

/** 金额展示：千分位 + 2 位小数（非法输入按 0） */
export function fmtMoney(v: number): string {
  const n = Number.isFinite(v) ? v : 0;
  return n.toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 整数展示：千分位（订单数/SKU 行数等） */
export function fmtInt(v: number): string {
  return Math.round(Number.isFinite(v) ? v : 0).toLocaleString('zh-CN');
}

/** 百分比：部分/总量 → 'xx.x%'；total <= 0 返回 '—' */
export function fmtPct(part: number, total: number): string {
  if (!(total > 0)) return '—';
  return ((part / total) * 100).toFixed(1) + '%';
}

/** 分 → 元（成本表单价等），2 位小数 */
export function fmtYuanFromCents(cents: number): string {
  const n = Number.isFinite(cents) ? cents : 0;
  return (n / 100).toLocaleString('zh-CN', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
}

/** 费用科目 label 字典（展示端：新增科目由采集端直接推送，此处只补显示名；缺失回退原始 key） */
const FEE_LABELS: Record<string, string> = {
  platform_commission: '平台佣金',
  logistics_fee: '物流费(卖)',
  payment_channel: '支付通道费',
  refund: '退款/纠纷',
  refund_amount: '退款(旧口径)',
  dispute: '纠纷调整',
};
export function feeLabel(category: string): string {
  return FEE_LABELS[category] ?? category;
}

/** 日期桶展示：day → MM-DD（同年），month → YY-MM */
export function fmtBucket(bucket: string, granularity: 'day' | 'month'): string {
  if (granularity === 'day') return bucket.slice(5);
  return bucket.slice(2);
}
