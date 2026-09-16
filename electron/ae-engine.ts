// electron/ae-engine.ts
// 「速卖通利润追踪」利润引擎（M1）：查询层实时计算分层利润，不落计算结果表。
//
// 口径（v1，与 docs/features/PROFIT_TRACKER.md §4 一致并落为 CNY 基准）：
//   - 收入（订单原币）= 商品金额 + 买家付运费 − 退款/纠纷调整（refund/dispute 费用科目按收入扣减）
//   - 商品成本（CNY）= Σ(行数 × 款单价分/100)，行经 ae_order_lines.style_code ↔ ae_cost_map 命中；
//     行无 style_code 或未命中 → 该行成本缺失（coverage 反映，不阻塞利润展示）
//   - 毛利 = 净收入 − 商品成本（全部折 CNY：外币 × ae_rates.rate_to_cny）
//   - 订单级费用（CNY）= 其余 fee 科目合计；运营利润 = 毛利 − 订单级费用
//   - 分层均以 CNY 呈现（成本 CNY、结算外币按汇率折算）；分币种原币视图仍在 ae-summary
// 依赖：ae-db 的 ensureAeSchema() 已建表；本文件只读，无写能力。

export {};

import { dbQuery } from './db';

/** 利润统计基准币：所有外币经 ae_rates 折算到 CNY；CNY 订单恒 1:1（不查表） */
const BASE_CURRENCY = 'CNY';

// ---- 输出类型（渲染层 src/types.ts 镜像同构，跨 IPC 传纯 JSON） ----

export interface AeProfitTotals {
  /** 参与利润统计的订单数（有汇率的订单） */
  orders: number;
  /** 净收入 CNY（已扣退款） */
  incomeCny: number;
  /** 商品成本 CNY（命中的行） */
  costCny: number;
  /** 订单级费用 CNY（不含退款科目） */
  feeCny: number;
  /** 毛利 CNY = 净收入 − 成本 */
  grossProfitCny: number;
  /** 运营利润 CNY = 毛利 − 费用 */
  operatingProfitCny: number;
  /** 因缺汇率跳过的订单数（不参与上述合计） */
  missingRateOrders: number;
}

export interface AeTrendPoint {
  /** yyyy-mm-dd（日）或 yyyy-mm（月） */
  bucket: string;
  orders: number;
  incomeCny: number;
  costCny: number;
  grossProfitCny: number;
}

export interface AeTopOrder {
  orderId: string;
  orderTime: string;
  status: string;
  currency: string;
  incomeCny: number;
  costCny: number;
  grossProfitCny: number;
}

export interface AeTopStyle {
  /** 款编码（缺省/无编码行用 productId 兜底，仍可聚合观察） */
  styleCode: string;
  styleName: string;
  qty: number;
  incomeCny: number;
  costCny: number;
  grossProfitCny: number;
}

export interface AeFeeBreakdownItem {
  category: string;
  totalCny: number;
  orders: number;
}

export interface AeProfitOverview {
  baseCurrency: 'CNY';
  totals: AeProfitTotals;
  trend: AeTrendPoint[];
  topOrders: AeTopOrder[];
  topStyles: AeTopStyle[];
  feeBreakdown: AeFeeBreakdownItem[];
  coverage: {
    /** 参与统计订单数（含缺汇率） */
    orderCount: number;
    lineCount: number;
    /** 有 style_code 的行 */
    codeLines: number;
    /** 命中成本表的行 */
    matchedLines: number;
  };
}

interface OrderRow {
  id: number;
  orderId: string;
  orderTime: string;
  status: string;
  currency: string;
  goodsAmount: number;
  shippingIncome: number;
}
interface LineRow {
  aeOrderId: number;
  styleCode: string;
  title: string;
  productId: string;
  qty: number;
}
interface FeeRow {
  aeOrderId: number;
  category: string;
  amount: number;
}

function num(v: unknown): number {
  return v !== undefined && v !== null ? Number(v) : 0;
}
function str(v: unknown): string {
  return v === undefined || v === null ? '' : String(v);
}

/** 退款/纠纷类科目 = 收入扣减（其余费用进费用侧） */
const DEDUCTION_CATEGORIES = new Set(['refund', 'dispute', 'refund_amount']);

function fmtCny(v: number): number {
  return Math.round(v * 100) / 100;
}

/**
 * 利润总览（趋势/TOP/费用构成/覆盖），引擎唯一对外入口。
 * @param opts.granularity 'day'（yyyy-mm-dd）| 'month'（yyyy-mm），默认 'month'
 * @param opts.rangeDays 只看最近 N 天（按 order_time 字符串前缀近似过滤），默认 90
 */
export function getProfitOverview(opts?: { granularity?: 'day' | 'month'; rangeDays?: number }): AeProfitOverview {
  const granularity = opts?.granularity === 'day' ? 'day' : 'month';
  const rangeDays = Math.max(1, Math.min(opts?.rangeDays ?? 90, 3650));
  const fromPrefix = datePrefixDaysAgo(rangeDays);

  const rates = new Map<string, number>();
  for (const r of dbQuery<Record<string, unknown>>(`SELECT from_currency, rate_to_cny FROM ae_rates`)) {
    const ccy = str(r.from_currency);
    const v = num(r.rate_to_cny);
    if (ccy && v > 0) rates.set(ccy, v);
  }

  const orders = dbQuery<Record<string, unknown>>(
    `SELECT id, order_id, order_time, status, currency, goods_amount, shipping_income
     FROM ae_orders ORDER BY order_time ASC, id ASC`,
  ).map((r) => ({
    id: num(r.id),
    orderId: str(r.order_id),
    orderTime: str(r.order_time),
    status: str(r.status),
    currency: str(r.currency) || 'USD',
    goodsAmount: num(r.goods_amount),
    shippingIncome: num(r.shipping_income),
  })) as OrderRow[];

  const lines = dbQuery<Record<string, unknown>>(
    `SELECT ae_order_id, style_code, title, product_id, qty FROM ae_order_lines`,
  ).map((r) => ({
    aeOrderId: num(r.ae_order_id),
    styleCode: str(r.style_code),
    title: str(r.title),
    productId: str(r.product_id),
    qty: num(r.qty),
  })) as LineRow[];

  const fees = dbQuery<Record<string, unknown>>(`SELECT ae_order_id, category, amount FROM ae_fees`).map((r) => ({
    aeOrderId: num(r.ae_order_id),
    category: str(r.category),
    amount: num(r.amount),
  })) as FeeRow[];

  const costMap = new Map<string, number>(); // style_code(大写) → 分
  const costName = new Map<string, string>();
  for (const r of dbQuery<Record<string, unknown>>(`SELECT style_code, style_name, unit_price_cents FROM ae_cost_map`)) {
    const code = str(r.style_code).toUpperCase();
    const cents = num(r.unit_price_cents);
    if (code && cents > 0) {
      costMap.set(code, cents);
      if (!costName.has(code)) costName.set(code, str(r.style_name));
    }
  }

  // 按订单聚合
  const feeByOrder = new Map<number, FeeRow[]>();
  for (const f of fees) {
    const arr = feeByOrder.get(f.aeOrderId) ?? [];
    arr.push(f);
    feeByOrder.set(f.aeOrderId, arr);
  }
  const lineByOrder = new Map<number, LineRow[]>();
  for (const l of lines) {
    const arr = lineByOrder.get(l.aeOrderId) ?? [];
    arr.push(l);
    lineByOrder.set(l.aeOrderId, arr);
  }

  // 行级中间结果（TOP 款编码聚合用）
  const styleAgg = new Map<string, { code: string; name: string; qty: number; incomeCny: number; costCny: number }>();

  const totals: AeProfitTotals = { orders: 0, incomeCny: 0, costCny: 0, feeCny: 0, grossProfitCny: 0, operatingProfitCny: 0, missingRateOrders: 0 };
  const trendMap = new Map<string, AeTrendPoint>();
  const topOrders: AeTopOrder[] = [];
  const feeBreakAgg = new Map<string, { totalCny: number; orders: number }>();
  let lineCount = 0;
  let codeLines = 0;
  let matchedLines = 0;
  let orderCount = 0;

  for (const o of orders) {
    orderCount += 1;
    // 基准币（CNY）恒按 1:1 参与统计，无需汇率表行；外币折 CNY 才查表
    const rate = o.currency === BASE_CURRENCY ? 1 : rates.get(o.currency);
    if (!rate) {
      // 缺汇率：不参与利润合计，但明细/覆盖仍统计
      totals.missingRateOrders += 1;
      continue;
    }
    const orderLines = lineByOrder.get(o.id) ?? [];
    const orderFees = feeByOrder.get(o.id) ?? [];
    let deduction = 0;
    let otherFee = 0;
    for (const f of orderFees) {
      if (DEDUCTION_CATEGORIES.has(f.category)) deduction += f.amount;
      else otherFee += f.amount;
    }
    const incomeCcy = o.goodsAmount + o.shippingIncome - deduction;
    const incomeCny = incomeCcy * rate;
    // 行收入分摊比例：按行 qty 占订单总 qty（订单级收入无行明细时按比例近似，M1 口径）
    const totalQty = Math.max(1, orderLines.reduce((s, x) => s + x.qty, 0));
    let costCny = 0;
    for (const l of orderLines) {
      lineCount += 1;
      const code = l.styleCode.trim().toUpperCase();
      if (code) codeLines += 1;
      const cents = code ? costMap.get(code) : undefined;
      const shareCny = ((l.qty / totalQty) * incomeCcy) * rate;
      if (cents !== undefined) {
        matchedLines += 1;
        const lineCost = (cents / 100) * l.qty;
        costCny += lineCost;
        const agg = styleAgg.get(code) ?? { code, name: costName.get(code) || l.title || code, qty: 0, incomeCny: 0, costCny: 0 };
        agg.qty += l.qty;
        agg.incomeCny += shareCny;
        agg.costCny += lineCost;
        styleAgg.set(code, agg);
      } else if (code) {
        // 有编码未命中成本 → 进 TOP 观察（成本缺失，毛利不完整）——按无成本行记收入侧聚合
        const agg = styleAgg.get(code) ?? { code, name: costName.get(code) || l.title || code, qty: 0, incomeCny: 0, costCny: 0 };
        agg.qty += l.qty;
        agg.incomeCny += shareCny;
        styleAgg.set(code, agg);
      }
    }
    const feeCny = otherFee * rate;
    const gross = incomeCny - costCny;
    const operating = gross - feeCny;

    totals.orders += 1;
    totals.incomeCny += incomeCny;
    totals.costCny += costCny;
    totals.feeCny += feeCny;
    totals.grossProfitCny += gross;
    totals.operatingProfitCny += operating;

    // 费用构成（折 CNY）
    for (const f of orderFees) {
      if (DEDUCTION_CATEGORIES.has(f.category)) continue;
      const agg = feeBreakAgg.get(f.category) ?? { totalCny: 0, orders: 0 };
      agg.totalCny += f.amount * rate;
      agg.orders += 1;
      feeBreakAgg.set(f.category, agg);
    }

    // 趋势桶（range 过滤：order_time 前缀 >= fromPrefix）
    if (o.orderTime.slice(0, 10) >= fromPrefix) {
      const bucket = granularity === 'day' ? o.orderTime.slice(0, 10) : o.orderTime.slice(0, 7);
      const tp = trendMap.get(bucket) ?? { bucket, orders: 0, incomeCny: 0, costCny: 0, grossProfitCny: 0 };
      tp.orders += 1;
      tp.incomeCny += incomeCny;
      tp.costCny += costCny;
      tp.grossProfitCny += gross;
      trendMap.set(bucket, tp);
    }

    topOrders.push({
      orderId: o.orderId,
      orderTime: o.orderTime,
      status: o.status,
      currency: o.currency,
      incomeCny: fmtCny(incomeCny),
      costCny: fmtCny(costCny),
      grossProfitCny: fmtCny(gross),
    });
  }

  // 归一
  const round2 = (v: number) => fmtCny(v);
  const trend = [...trendMap.values()].sort((a, b) => (a.bucket < b.bucket ? -1 : 1));
  topOrders.sort((a, b) => b.grossProfitCny - a.grossProfitCny);
  const feeBreakdown = [...feeBreakAgg.entries()]
    .map(([category, agg]) => ({ category, totalCny: round2(agg.totalCny), orders: agg.orders }))
    .sort((a, b) => b.totalCny - a.totalCny);
  const topStyles = [...styleAgg.entries()]
    .map(([, agg]) => ({
      styleCode: agg.code,
      styleName: agg.name,
      qty: agg.qty,
      incomeCny: round2(agg.incomeCny),
      costCny: round2(agg.costCny),
      grossProfitCny: round2(agg.incomeCny - agg.costCny),
    }))
    .sort((a, b) => b.grossProfitCny - a.grossProfitCny)
    .slice(0, 20);

  return {
    baseCurrency: BASE_CURRENCY,
    totals: {
      orders: totals.orders,
      incomeCny: round2(totals.incomeCny),
      costCny: round2(totals.costCny),
      feeCny: round2(totals.feeCny),
      grossProfitCny: round2(totals.grossProfitCny),
      operatingProfitCny: round2(totals.operatingProfitCny),
      missingRateOrders: totals.missingRateOrders,
    },
    trend: trend.map((t) => ({ ...t, incomeCny: round2(t.incomeCny), costCny: round2(t.costCny), grossProfitCny: round2(t.grossProfitCny) })),
    topOrders: topOrders.slice(0, 20),
    topStyles,
    feeBreakdown,
    coverage: { orderCount, lineCount, codeLines, matchedLines },
  };
}

/** 计算 rangeDays 前的日期前缀 yyyy-mm-dd（趋势窗口过滤） */
function datePrefixDaysAgo(days: number): string {
  const d = new Date();
  d.setDate(d.getDate() - days);
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}
