// src/lib/ledgerRevenue.ts
// 「记账 › 按营收占比分摊」的**取数与归属**层（纯函数，零副作用）。
//
// RK-06：营收口径**只允许**复用「统计」页那一套（`src/lib/orderCost.ts` 的
// `computeOrderCosts` → `summarizeRevenueByShop`），不许另写收入 SQL。
// 本文件只做两件 `orderCost` 不该管的事：
//   ① 把**归一键**（订单只存店名原文，宿主用 `toNameKey` 算好）映射到 `sk_shops.id`；
//   ② 认不出的名字/金额如实分桶 —— 不许"猜一个最像的店"把营收摊错。
//
// 三条不猜的判据：
//   · 名字没登记 → `not-found`（改名、漏登记、历史拼写差异都会落到这里）；
//   · 同名多店（`UNIQUE(platform, name_key)` 允许跨平台同名）→ `ambiguous`，不按顺序取第一个；
//   · 订单没写店铺、金额缺失、取数被上限截断 → 各有独立字段，调用方必须显示或停用该基准。

import { summarizeRevenueByShop, type OrderCostInput } from './orderCost';
import type { UnifiedOrderRow } from '@/types';

/** 店铺身份（`sk_shops` 的最小子集；`nameKey` 是归一键，`name` 只用于展示） */
export interface RevenueShopRef {
  id: number;
  name: string;
  nameKey: string;
}

export type RevenueUnmatchedReason = 'not-found' | 'ambiguous';

export interface RevenueUnmatched {
  /** 归一键 */
  shopKey: string;
  /** 展示用原名（取订单里出现的一种写法） */
  shop: string;
  amountCents: number;
  reason: RevenueUnmatchedReason;
}

export interface LedgerRevenue {
  /** 店铺 id → 营收（整数分）。表里没有 = 该店本期 0 营收（不是"缺数据"） */
  byShopId: Record<number, number>;
  /** 已归属到店铺的营收合计 */
  assignedTotalCents: number;
  /** 所有可计入营收的金额合计（= assigned + unmatched + unassigned） */
  totalCents: number;
  /** 认不出店铺的营收（未登记 / 同名多店），按金额降序 */
  unmatched: RevenueUnmatched[];
  unmatchedTotalCents: number;
  /** 订单没写店铺（或只有空白）的营收 —— 无处可归，只能提示 */
  unassignedCents: number;
  /** 关闭/取消单被排除的行数（营收口径不含它们，与统计页一致） */
  excludedClosedRows: number;
  /** 金额缺失、无法计入营收的行数 */
  missingRevenueRows: number;
  /** 取数触达上限：`true` 时调用方必须停用「按营收占比」，否则占比是拿半份数据算的 */
  truncated: boolean;
}

/**
 * 订单营收 → 店铺 id 维度的营收（整数分）。
 *
 * @param input.orders 宿主 `shippingRows` 的行（必须带 `shopKey`）
 * @param input.shops 店铺主数据（`ShopListItem` 结构兼容）
 * @param input.truncated 取数是否触达上限（由调用方按 `rows.length >= limit` 判定）
 */
export function revenueByShopId(input: {
  orders: OrderCostInput['orders'] | null | undefined;
  shops: readonly RevenueShopRef[] | null | undefined;
  truncated?: boolean;
}): LedgerRevenue {
  const shops = Array.isArray(input?.shops) ? input.shops : [];
  const orders = Array.isArray(input?.orders) ? input.orders : [];

  // 归一键 → 店铺 id；同名多店进 ambiguous（跨平台同名是结构上允许的）
  const idByKey = new Map<string, number>();
  const ambiguous = new Set<string>();
  for (const s of shops) {
    const key = String(s?.nameKey ?? '');
    const id = Number(s?.id) || 0;
    if (!key || id <= 0) continue;
    const prev = idByKey.get(key);
    if (prev === undefined) idByKey.set(key, id);
    else if (prev !== id) ambiguous.add(key);
  }
  // 歧义键一律不进 idByKey，避免"碰巧先遍历到哪家就归哪家"
  for (const key of ambiguous) idByKey.delete(key);

  /** 归一键 → 订单里的展示原名（首个非空即可；名字只用于提示，不参与判定） */
  const rawByKey = new Map<string, string>();
  for (const o of orders) {
    const key = String(o?.shopKey ?? '');
    if (!key || rawByKey.has(key)) continue;
    const raw = String(o?.shop ?? '').trim();
    if (raw) rawByKey.set(key, raw);
  }

  const sum = summarizeRevenueByShop(orders);
  const byShopId: Record<number, number> = {};
  const unmatched: RevenueUnmatched[] = [];
  let assignedTotalCents = 0;
  let unmatchedTotalCents = 0;

  for (const [key, cents] of Object.entries(sum.byShopKey)) {
    const amount = Number(cents) || 0;
    const id = idByKey.get(key);
    if (id && !ambiguous.has(key)) {
      byShopId[id] = (byShopId[id] ?? 0) + amount;
      assignedTotalCents += amount;
      continue;
    }
    unmatched.push({
      shopKey: key,
      shop: rawByKey.get(key) || key,
      amountCents: amount,
      reason: ambiguous.has(key) ? 'ambiguous' : 'not-found',
    });
    unmatchedTotalCents += amount;
  }
  unmatched.sort((a, b) => b.amountCents - a.amountCents || (a.shopKey < b.shopKey ? -1 : 1));

  return {
    byShopId,
    assignedTotalCents,
    totalCents: sum.totalCents,
    unmatched,
    unmatchedTotalCents,
    unassignedCents: sum.missingShopCents,
    excludedClosedRows: sum.excludedClosedRows,
    missingRevenueRows: sum.missingRevenueRows,
    truncated: input?.truncated === true,
  };
}

/**
 * 参与分摊店铺的营收（整数分）—— 按 id 取，没营收 = 0。
 * 只用于把权重喂给 `computeAllocations`；**不要**拿它替代守恒断言。
 */
export function participantRevenueCents(
  revenue: LedgerRevenue | null | undefined,
  shopIds: readonly number[],
): number[] {
  const table = revenue?.byShopId ?? {};
  return shopIds.map((id) => Number(table[id]) || 0);
}

/**
 * 宿主 `orderShippingRows` 的行 → 营收（**取数到营收的接线只在这一处**）。
 *
 * 「记一笔」与「批量导入」算的是同一个月的同一份占比：两边各自 `.map()` 一遍订单行，
 * 将来 `UnifiedOrderRow` 加字段就只有一处带上、另一处静默少算 —— 那笔钱会摊错且看不出来。
 *
 * @param input.limit 调用方传给取数的上限；`行数 >= limit` 即视为截断（`truncated`）。
 *   截断时**必须停用「按营收占比」**：半份订单算出来的占比会把钱摊到错的店上。
 */
export function revenueFromOrderRows(input: {
  orders: UnifiedOrderRow[] | null | undefined;
  shops: readonly RevenueShopRef[] | null | undefined;
  limit?: number;
}): LedgerRevenue {
  const orders = Array.isArray(input?.orders) ? input.orders : [];
  return revenueByShopId({
    orders,
    shops: input?.shops,
    truncated: input?.limit !== undefined ? orders.length >= input.limit : false,
  });
}
