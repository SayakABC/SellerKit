// src/lib/settleImport.ts
// 「结算明细」导入的**纯解析层**（零依赖：不碰 DB / xlsx / IPC）—— 可被 vitest 直接覆盖。
//
// 数据源：AE 后台导出的「订单明细」（真实样本 `订单明细-6.xlsx`，2 张表 / 200 单 / 412 商品行），
// 表头与口径都由 2026-09-29 的实测结论确定（见 `docs/reviews/BUSINESS_GAP_ANALYSIS_2026-09-29.md` 的后续勘察）：
//
//   1. **两张表**：`订单明细_x`（订单级 29 列）与 `订单商品明细_x`（商品级 39 列，带 商品id/sku/数量 + 全套费用）。
//      取**商品级**那张（信息最全，且订单级行 = `商品id` 为空的那一条）。
//   2. **费用只有结算后才有**：实测待结算行（`待结算原因=订单未发货`）的 放款/净收入/平台分账/佣金 **全是 0**
//      —— 所以这些 0 **不是事实**，靠 `settleStatus` 区分（调用方据此决定"能不能拿来算毛利"）。
//   3. **两条可校验的等式**（实测：无退款已结算行 277/277 命中）：
//        · `平台分账金额 = Σ八类费用`
//        · `净收入 = 成交金额 − Σ八类费用`
//      导入时逐行校验，**不符就记 issue**（平台改口径时看得见），不抛错、不静默丢。
//      退款行**不校验净收入**：全额退款单的费用与净收入都是 0（平台口径），公式对它不成立（实测 55 行全如此）。
//   4. **幂等键 = `(订单号, 商品id, sku id)`**（同一文件重复导入、或多页导出重叠，都靠它去重）。
//   5. **模板定义行要跳掉**：同类导出（如商品信息）首行可能是列定义（`{"dataSourceValidate":…}`）。
//      判据：订单号不像订单号（非 8 位以上纯数字）→ 记 issue 并跳过。
//
// 金额一律**存分**（与 `pl_products.cost_cents` / `oi_orders.amount_cents` 同口径）；
// 空单元格 → 0（本文件实测 412/412 全填；异常靠上面的等式兜）。

/** 八类费用科目（和它们的"退回"）——实测该导出固定这八项；科目名若变，这里加一条即可 */
export const SETTLE_FEE_CATEGORIES = [
  '佣金',
  '交易服务费',
  '联盟佣金',
  '金币营销费',
  'cashback',
  '营销技术服务费',
  '营销智投服务费',
  '新商孵化服务费',
] as const;

/** 结算行（订单级或商品级） */
export interface SettleLine {
  orderNo: string;
  /** 空串 = **订单级行**（该单的汇总行，没有具体商品） */
  itemId: string;
  skuId: string;
  lineType: 'item' | 'order';
  qty: number;
  currency: string;
  /** 结算状态原文（`已结算` / `待结算`）；**不是** `已结算` 时费用列不可信 */
  settleStatus: string;
  /** 待结算原因原文（如 `订单未发货`） */
  pendingReason: string;
  expectedPayoutAt: string;
  payTime: string;
  shipTime: string;
  receiveTime: string;
  /** 半托管服务（原文 `true` / `false`） */
  bizMode: string;
  dealCents: number;
  pendingAmountCents: number;
  payoutCents: number;
  netIncomeCents: number;
  splitCents: number;
  refundInCents: number;
  refundAfterCents: number;
  /** 八类费用（科目 → 分） */
  feeCents: Record<string, number>;
  /** 八类费用的退回（科目 → 分） */
  feeRefundCents: Record<string, number>;
}

export type SettleIssueKind =
  | 'definition-row'
  | 'no-order-no'
  | 'split-mismatch'
  | 'net-mismatch';

export interface SettleParseIssue {
  /** 源文件里的行号（1 起，含表头行） */
  row: number;
  kind: SettleIssueKind;
  detail: string;
}

export interface SettleParseResult {
  rows: SettleLine[];
  /** 逐行问题（**不阻断导入**：能存的照存，问题留给界面显示） */
  issues: SettleParseIssue[];
  stats: {
    itemLines: number;
    orderLines: number;
    settled: number;
    pending: number;
    /** 被跳过的行数（定义行 / 无订单号） */
    skipped: number;
  };
}

/** 金额单元格 → 分。空 / 认不出 → 0（本导出全填；异常由等式校验兜） */
function centsOf(v: unknown): number {
  const s = typeof v === 'string' ? v.trim() : typeof v === 'number' ? String(v) : '';
  if (!s) return 0;
  const n = Number(s.replace(/[^\d.-]/g, ''));
  return Number.isFinite(n) ? Math.round(n * 100) : 0;
}

function intOf(v: unknown, fallback = 0): number {
  const n = Number.parseInt(String(v ?? '').trim(), 10);
  return Number.isFinite(n) ? n : fallback;
}

function text(v: unknown, max = 200): string {
  return typeof v === 'string' ? v.trim().slice(0, max) : '';
}

/** 订单号像不像订单号（8 位以上纯数字）——用来识别"模板定义行"，别把定义串当订单 */
export function looksLikeOrderNo(v: unknown): boolean {
  return /^\d{8,}$/.test(text(v, 64));
}

/** 选「结算明细」那张表：必须同时有 商品id 与 结算状态（订单级那张没有结算状态） */
export function pickSettleSheet(
  sheets: { name: string; rows: Record<string, string>[] }[] | null | undefined,
): { name: string; rows: Record<string, string>[] } | null {
  const list = Array.isArray(sheets) ? sheets : [];
  let best: { name: string; rows: Record<string, string>[] } | null = null;
  for (const s of list) {
    if (!s || !Array.isArray(s.rows) || !s.rows.length) continue;
    const keys = Object.keys(s.rows[0] ?? {});
    if (!keys.includes('商品id') || !keys.includes('结算状态')) continue;
    if (!best || s.rows.length > best.rows.length) best = s;
  }
  return best;
}

/**
 * 幂等键：`订单号|商品id|sku id`（三者都归一为 trim 后的原样文本）。
 * 与表上的 `UNIQUE(order_no, item_id, sku_id)` 同口径 —— 同一文件重复导入、或多页导出重叠都靠它去重。
 */
export function settleKey(line: Pick<SettleLine, 'orderNo' | 'itemId' | 'skuId'>): string {
  return `${text(line?.orderNo, 64)}\u0000${text(line?.itemId, 64)}\u0000${text(line?.skuId, 64)}`;
}

/** 逐行解析（`rows` 为表头映射后的对象；行号按 1 起含表头计算，便于对着 Excel 找） */
export function parseSettleRows(
  rows: Record<string, string>[] | null | undefined,
  opts: { toleranceCents?: number } = {},
): SettleParseResult {
  const list = Array.isArray(rows) ? rows : [];
  const tol = typeof opts.toleranceCents === 'number' ? opts.toleranceCents : 2; // 0.02 元
  const out: SettleLine[] = [];
  const issues: SettleParseIssue[] = [];
  const stats = { itemLines: 0, orderLines: 0, settled: 0, pending: 0, skipped: 0 };

  list.forEach((r, i) => {
    const lineNo = i + 2; // 表头占第 1 行
    const orderNo = text(r?.['订单号'], 64);
    if (!orderNo) {
      stats.skipped++;
      issues.push({ row: lineNo, kind: 'no-order-no', detail: '订单号为空' });
      return;
    }
    if (!looksLikeOrderNo(orderNo)) {
      stats.skipped++;
      issues.push({
        row: lineNo,
        kind: 'definition-row',
        detail: `订单号不像订单号（疑似模板定义行）：${orderNo.slice(0, 40)}`,
      });
      return;
    }

    const itemId = text(r?.['商品id'], 64);
    const feeCents: Record<string, number> = {};
    const feeRefundCents: Record<string, number> = {};
    for (const k of SETTLE_FEE_CATEGORIES) {
      feeCents[k] = centsOf(r?.[k]);
      feeRefundCents[k] = centsOf(r?.[`${k}退回`]);
    }
    const sumFee = Object.values(feeCents).reduce((a, b) => a + b, 0);
    const splitCents = centsOf(r?.['平台分账金额']);
    const dealCents = centsOf(r?.['成交金额']);
    const netIncomeCents = centsOf(r?.['订单放款净收入金额']);
    const refundInCents = centsOf(r?.['售中退款金额']);
    const refundAfterCents = centsOf(r?.['售后退款金额']);
    const settleStatus = text(r?.['结算状态'], 40);

    const line: SettleLine = {
      orderNo,
      itemId,
      skuId: text(r?.['sku id'], 64),
      lineType: itemId ? 'item' : 'order',
      qty: Math.max(1, intOf(r?.['商品数量'], 1)),
      currency: text(r?.['币种'], 12),
      settleStatus,
      pendingReason: text(r?.['待结算原因'], 60),
      expectedPayoutAt: text(r?.['预计放款时间'], 40),
      payTime: text(r?.['支付时间'], 40),
      shipTime: text(r?.['发货时间'], 40),
      receiveTime: text(r?.['确认收货时间'], 40),
      bizMode: text(r?.['半托管服务'], 12),
      dealCents,
      pendingAmountCents: centsOf(r?.['待结算金额']),
      payoutCents: centsOf(r?.['放款金额']),
      netIncomeCents,
      splitCents,
      refundInCents,
      refundAfterCents,
      feeCents,
      feeRefundCents,
    };
    out.push(line);

    if (line.lineType === 'item') stats.itemLines++;
    else stats.orderLines++;
    if (settleStatus.includes('已结算')) stats.settled++;
    else stats.pending++;

    // 等式①：平台分账 = Σ八类费用（实测 277/277 命中）
    if (Math.abs(splitCents - sumFee) > tol) {
      issues.push({
        row: lineNo,
        kind: 'split-mismatch',
        detail: `平台分账 ${splitCents} ≠ Σ费用 ${sumFee}（差 ${splitCents - sumFee} 分）`,
      });
    }
    // 等式②：净收入 = 成交 − Σ费用；**只对"已结算且无退款"校验**
    //   · 待结算行费用列全是 0（平台还没算），等式无意义；
    //   · 全额退款单的费用与净收入都是 0（平台口径），公式不成立（实测 55 行全如此）。
    const hasRefund = refundInCents > 0 || refundAfterCents > 0;
    const canCheckNet = line.settleStatus.includes('已结算') && !hasRefund;
    if (canCheckNet && Math.abs(netIncomeCents - (dealCents - sumFee)) > tol) {
      issues.push({
        row: lineNo,
        kind: 'net-mismatch',
        detail: `净收入 ${netIncomeCents} ≠ 成交 ${dealCents} − Σ费用 ${sumFee}（差 ${
          netIncomeCents - (dealCents - sumFee)
        } 分）`,
      });
    }
  });

  return { rows: out, issues, stats };
}