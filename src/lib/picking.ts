// src/lib/picking.ts
// 「拣货单」纯计算层：订单行（含图/供应商/款色码）→ 按 **SKU（款 × 色 × 码）** 汇总"要拣什么、各几件"，
// 再按**厂家**分出"哪家各要拿什么、大概多少钱"。
//
// 为什么单独一层（与 `orderCost.ts` 同理由）：聚合规则是这条链上唯一有正确性风险的部分，
// 摘成纯函数才能被 vitest 直接覆盖（DB 层受 Electron 的 ABI 限制测不了）。
//
// 三条口径**刻意与订单利润页共用同一份实现**（同一批数据两处显示不同的数，是查不出的悬案）：
//   · 件数 —— `orderCost.resolveQty`（结算商品行真值 → 报表块内 `商品数量` → 按 1 件并标缺）；
//   · SKU 分组键 —— `orderCost.skuKey`（`款 · 色 · 码`，缺哪段标哪段）；
//   · 进价 —— `orderCost.pickUnitCost` + `orderCost.round2`（款级成本区间，按该行下单日期取当时生效的那条）。
//
// **范围口径**（默认"未发货 · 近 30 天"）也在本层：日期要认 `order_time` 的多种写法
// （实测有 `2026-09-10 12:00:00` 与 `08/30/2026 07:00` 两种，在 SQL 里做字符串比较会**静默丢掉**
// 一整种格式的行），"已终结的单不该拣"要按状态原文判定（`bucketOfStatus` 的唯一实现）——
// 所以 SQL 只回"未发货的行"，本层剔除 **已终结（关闭/已完成）** 与 **超出天数窗**，
// 并把剔除数**报出去**（`excludedFinished` / `excludedOld` / `undated`），不静默。
//
// 缺数据**逐行标**（`missing*` / `noPricePieces` 计数挂在每个 SKU 组上，界面按它出标签）：
// 缺图的没法看图拣、缺件数的没法知道拣几件、缺供应商的分不了单、未识别款的回不了产品库、
// **缺进价的算不出金额**。一条都不许静默糊过去 —— 拣货单是"照它干活"的东西。

import type { PickingRowProjection } from '@/types';
import {
  bucketOfStatus,
  dateKey,
  pickUnitCost,
  resolveQty,
  round2,
  skuKey,
  type CostInterval,
  type SettleQtyInfo,
} from './orderCost';

/** 默认天数窗（"近 30 天"是产品默认值，写在界面上可见） */
export const DEFAULT_PICKING_DAYS = 30;

/** 拣货单的范围选项（默认值在界面上以标签呈现，不藏进设置） */
export interface PickingScope {
  /** 天数窗（下单日期在 `today - days` 之后）；<= 0 = 不限 */
  days?: number;
  /** "今天"（yyyy-mm-dd）；缺省用本机当天 —— 用例靠它固定住，别让断言随日期漂移 */
  today?: string;
  /**
   * **款级成本区间**（`ae_cost_map`，与「算钱」页**同一份取价实现** `orderCost.pickUnitCost`）。
   *
   * 为什么必须同源：拣货单要回答"这批货大概要花多少钱"，利润页要回答"这笔订单的成本" ——
   * 两页只要各自去取一次价，就会出现"同一条订单在两页上成本不一样"的悬案。
   * 不传 / 空数组 → 全部行标「无进价」（**不按 0 算**，见 `noPricePieces`）。
   */
  costs?: CostInterval[] | null;
}

/** 拣货单的一行输入 = 宿主 `picking-rows` 的投影行。
 * 形状单源在 `src/types.ts`（宿主与渲染层共用一个声明）—— 本层**不再抄一份**，
 * 抄一份的代价是"宿主加了一列、纯层不知道"这类静默落后。 */
export type PickingRow = PickingRowProjection;

/** 一个 SKU（款 × 色 × 码）的拣货项 */
export interface PickingGroup {
  /** 分组键（`skuKey` 的产物）：`S1 · 黑 · L` */
  key: string;
  styleCode: string;
  /** **有效颜色**（宿主侧已做回落：款色 → 订单原文色）。分组键用它，不直接用订单原文。 */
  color: string;
  size: string;
  /** **要拣几件** = 组内各行件数之和（分不清件数的行按 1 件，见 `missingQty`） */
  pieces: number;
  /** 涉及订单数（按订单号去重；拆行后的多商品同单只算一单） */
  orders: number;
  /** 涉及订单号（升序去重；"这单里是不是还有别的 SKU"要能当场核对） */
  orderNos: string[];
  /** 供应商名（去重；多渠道拿货时可能多于一个 → 界面按"分不了单"提示） */
  supplierNames: string[];
  /** 首个非 0 供应商 id/名（0 = 未识别；分组主键仍是 SKU，供应商只是属性） */
  supplierId: number;
  supplierName: string;
  /** 组内任一行有图就用它（同 SKU 的订单图通常一致） */
  imagePath: string;
  /** ---- 进价 / 预估金额（口径见 `aggregatePicking` 的注释；缺价**不计入**金额）---- */
  /**
   * 进价（**元/件**）= Σ(件数×单价) / Σ件数，只统计**有价**的件数。
   * `null` = 这一组一件都没取到价（界面标「无进价」，**不是 0**）。
   */
  unitPrice: number | null;
  /** 预估金额（**元**）= Σ(件数 × 进价)，**只含有价的行** */
  amount: number;
  /** 取到价的件数 */
  pricedPieces: number;
  /** 没取到价的件数（缺进价 —— 金额里**不含**它们，界面必须标出来，否则合计看起来"少了一块"却说不出少在哪） */
  noPricePieces: number;
  /** ---- 逐行缺口计数（界面按它出"缺"标签；Σ 不超过组内行数）---- */
  /** 缺图的行数 */
  missingImage: number;
  /** 缺件数（按 1 件兜底）的行数 */
  missingQty: number;
  /** 供应商未识别的行数 */
  missingSupplier: number;
  /** 未识别款的行数 */
  missingStyle: number;
  /** 组内行数（= 订单行数，不是件数） */
  rows: number;
  /** 店铺（去重；按店铺分单时用） */
  shops: string[];
}

export interface PickingSupplierGroup {
  /** 供应商 id；`0` = 未指定厂家（该组 `supplierName` 为 ''，界面显示「未指定厂家」） */
  supplierId: number;
  /** 供应商名；`supplierId = 0` 时为空串（**不要**在这里塞占位文案，文案是界面的事） */
  supplierName: string;
  /** 该厂家的拣货项（与 `PickingSummary.groups` 里的是**同一个对象**） */
  groups: PickingGroup[];
  /** 行数合计 */
  rows: number;
  /** 件数合计 */
  pieces: number;
  /** 预估金额合计（元，只含有价的件数） */
  amount: number;
  /** 没取到进价的件数合计 */
  noPricePieces: number;
}

export interface PickingSummary {
  groups: PickingGroup[];
  /**
   * **按厂家分组的同一批 group**（订单要发给厂家拣货，所以"哪家要拿什么"是第一问）。
   * 每组引用 `groups` 里的**同一个对象**（不是副本）—— 两处显示同一个数，改一处不会分叉。
   * 未指定供应商的 group 全部归入 `supplierId = 0` 的那一组，且**排最后**（它是待补项，不是可执行项）。
   */
  suppliers: PickingSupplierGroup[];
  /** 参与聚合的行数 */
  rows: number;
  /** 件数合计 */
  pieces: number;
  /** 涉及订单数（按订单号去重） */
  orders: number;
  /** 预估金额合计（**元**）= Σ(件数 × 进价)，只含有价的件数 */
  amount: number;
  /** 没取到进价的件数合计（金额里不含它们，界面据此提示"估算偏低"） */
  noPricePieces: number;
  /** 有「无进价」件数的组数（不是件数 —— 界面提示"还有 N 个 SKU 没进价"） */
  noPriceGroups: number;
  /** 缺口行数（逐项：界面按它提示"先去补什么"） */
  missingImage: number;
  missingQty: number;
  missingSupplier: number;
  missingStyle: number;
  /** 已发货的行数（默认范围不该有；混进来时界面要说清楚） */
  shippedRows: number;
  /** ---- 范围口径（界面把默认值写在标签上，并说清剔掉了什么）---- */
  /**
   * 到手的总行数 = 参与聚合的 `rows` + 剔除的 `excludedFinished` + `excludedOld`
   * （`undated` 与 `shippedRows` 是 `rows` 的**子集**，另计只为让界面说清楚）
   */
  scanned: number;
  /** 本次用的天数窗（<= 0 = 不限） */
  days: number;
  /** 因**已终结**（关闭/已完成）被剔除的行数 —— 单已经没了，拣了也白拣 */
  excludedFinished: number;
  /** 因超出天数窗被剔除的行数 */
  excludedOld: number;
  /** 没有下单日期、天数窗无从判定的行数（**照收**，但要说出来） */
  undated: number;
}

/** 天数窗下界（yyyy-mm-dd）：`today - days`；`days<=0` 返回 ''（不限） */
function cutoffDate(today: string, days: number): string {
  if (!(days > 0) || !today) return '';
  const d = new Date(`${today}T00:00:00`);
  if (Number.isNaN(d.getTime())) return '';
  d.setDate(d.getDate() - Math.floor(days));
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/** 本机当天（yyyy-mm-dd）—— 只在调用方不给 `today` 时用（用例一律显式传，避免断言随日期漂移） */
function todayLocal(): string {
  const d = new Date();
  const p = (n: number): string => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())}`;
}

/**
 * 按 SKU 汇总拣货项。
 *
 * 先按**范围**筛（默认"未发货 · 近 30 天"）：`bucketOfStatus` 为 **closed / completed** 的剔除
 * （单已终结，拣了白拣）、超出天数窗的剔除，两者都计数；**没有日期的行照收**（不能拿"没日期"当"太老"
 * —— 那会静默丢行）也计数。剩下的行才进 SKU 汇总。
 *
 * 排序：**件数降序 → 键升序**（拣得多的在前；键作次序保证结果不随输入顺序漂移）。
 * 未识别款 / 缺色 / 缺码的行**各自成组**（`skuKey` 把缺的那段写进键）—— 丢掉它们会让
 * "合计对不上"变成查不出的悬案，而拣货单漏一行就是少发一件货。
 *
 * **进价 / 预估金额**（S3，2026-10-05）：
 *   · 单价 = `pickUnitCost(costs, 款编码, 该行的下单日期)` —— **与「算钱」页同一份取价实现**，
 *     所以同一条订单在两页上的产品成本是同一个数；
 *   · 逐行 `件数 × 单价` 累加（不是"件数合计 × 某一个单价"）：同一 SKU 的订单可能跨成本生效区间，
 *     按组相乘会挑错价；
 *   · `costs` 空 / 该款没有成本行 → 该行**不计入金额**并累到 `noPricePieces`（**不按 0 蒙**：
 *     按 0 算会让"估算偏低"和"真便宜"长得一模一样）。
 */
export function aggregatePicking(
  rows: PickingRow[] | null | undefined,
  opts: { settleQty?: Record<string, SettleQtyInfo> | null } & PickingScope = {},
): PickingSummary {
  const list = Array.isArray(rows) ? rows : [];
  const days = Number.isFinite(Number(opts?.days)) ? Number(opts.days) : DEFAULT_PICKING_DAYS;
  const cutoff = cutoffDate(String(opts?.today ?? '') || todayLocal(), days);
  const costs = Array.isArray(opts?.costs) ? opts.costs : [];
  const agg = new Map<string, PickingGroup>();
  const allOrders = new Set<string>();
  const summary: PickingSummary = {
    groups: [],
    suppliers: [],
    rows: 0,
    pieces: 0,
    orders: 0,
    amount: 0,
    noPricePieces: 0,
    noPriceGroups: 0,
    missingImage: 0,
    missingQty: 0,
    missingSupplier: 0,
    missingStyle: 0,
    shippedRows: 0,
    scanned: list.length,
    days,
    excludedFinished: 0,
    excludedOld: 0,
    undated: 0,
  };

  for (const r of list) {
    // 范围：已终结的单不拣（关闭/已完成）；其余照收
    const bucket = bucketOfStatus(r?.bizStatus);
    if (bucket === 'closed' || bucket === 'completed') {
      summary.excludedFinished += 1;
      continue;
    }
    // 范围：天数窗（认多种日期写法；没有日期的行照收并计数）
    const day = dateKey(r?.orderTime);
    if (day) {
      if (cutoff && day < cutoff) {
        summary.excludedOld += 1;
        continue;
      }
    } else {
      summary.undated += 1;
    }
    if (r?.shipped) summary.shippedRows += 1;

    const key = skuKey(r);
    const { qty, qtySource } = resolveQty(
      { orderNo: r?.orderNo, itemId: r?.itemId, rawFields: r?.rawFields },
      opts?.settleQty,
    );
    // 进价：与「算钱」页同一行、同一份实现（款级成本区间，按该行的下单日期取当时生效的那条）
    const unit = pickUnitCost(costs, String(r?.styleCode ?? ''), dateKey(r?.orderTime));
    const lineAmount = unit === null ? null : round2(qty * unit);
    const noImage = !String(r?.imagePath ?? '');
    const noSupplier = !Number(r?.supplierId);
    const noStyle = !String(r?.styleCode ?? '');
    const orderNo = String(r?.orderNo ?? '').trim();
    const shop = String(r?.shop ?? '');

    const g =
      agg.get(key) ??
      ({
        key,
        styleCode: String(r?.styleCode ?? ''),
        color: String(r?.color ?? ''),
        size: String(r?.size ?? ''),
        pieces: 0,
        orders: 0,
        orderNos: [],
        supplierNames: [],
        supplierId: 0,
        supplierName: '',
        imagePath: '',
        unitPrice: null,
        amount: 0,
        pricedPieces: 0,
        noPricePieces: 0,
        missingImage: 0,
        missingQty: 0,
        missingSupplier: 0,
        missingStyle: 0,
        rows: 0,
        shops: [],
      } satisfies PickingGroup);

    g.rows += 1;
    g.pieces += qty;
    if (lineAmount === null) {
      g.noPricePieces += qty;
      summary.noPricePieces += qty;
    } else {
      g.pricedPieces += qty;
      g.amount = round2(g.amount + lineAmount);
      summary.amount = round2(summary.amount + lineAmount);
    }
    if (orderNo && !g.orderNos.includes(orderNo)) g.orderNos.push(orderNo);
    if (shop && !g.shops.includes(shop)) g.shops.push(shop);
    if (noImage) g.missingImage += 1;
    else if (!g.imagePath) g.imagePath = String(r.imagePath);
    if (noSupplier) g.missingSupplier += 1;
    else {
      const name = String(r.supplierName ?? '');
      if (name && !g.supplierNames.includes(name)) g.supplierNames.push(name);
      if (!g.supplierId) {
        g.supplierId = Number(r.supplierId) || 0;
        g.supplierName = name;
      }
    }
    if (noStyle) g.missingStyle += 1;
    if (qtySource === 'assumed') g.missingQty += 1;

    agg.set(key, g);

    summary.rows += 1;
    summary.pieces += qty;
    if (orderNo) allOrders.add(orderNo);
    if (noImage) summary.missingImage += 1;
    if (qtySource === 'assumed') summary.missingQty += 1;
    if (noSupplier) summary.missingSupplier += 1;
    if (noStyle) summary.missingStyle += 1;
  }

  for (const g of agg.values()) {
    g.orders = g.orderNos.length;
    g.orderNos.sort();
    g.shops.sort();
    g.supplierNames.sort();
    // 进价 = 有价件数的加权均价（同一 SKU 跨成本区间时各行单价可能不同 → 表里给的是均价）
    g.unitPrice = g.pricedPieces > 0 ? round2(g.amount / g.pricedPieces) : null;
    if (g.noPricePieces > 0) summary.noPriceGroups += 1;
  }
  summary.groups = [...agg.values()].sort(
    (a, b) => b.pieces - a.pieces || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0),
  );
  summary.orders = allOrders.size;
  summary.suppliers = groupBySupplier(summary.groups);
  return summary;
}

/**
 * 按厂家把拣货项分组（订单是发给**厂家**拣货的，所以"哪家要拿什么"是第一问）。
 *
 * 排序：**有厂家的在前**（按件数降序，同件数按厂名），**未指定厂家的整组排最后** ——
 * 它是"还没法执行"的待补项，摆在中间会把可执行的清单割成两段。
 *
 * ⚠️ 组归属用每个 group 的**主供应商**（`PickingGroup.supplierId`，即组内首个非 0 供应商）。
 * 同 SKU 多渠道拿货时件数会整块归到主供应商名下 —— 这种组在明细里已由 `supplierNames`
 * 提示"分不了单"，不是静默丢失。
 */
function groupBySupplier(groups: PickingGroup[]): PickingSupplierGroup[] {
  const byId = new Map<number, PickingSupplierGroup>();
  for (const g of groups) {
    const id = Number(g.supplierId) || 0;
    let sg = byId.get(id);
    if (!sg) {
      sg = {
        supplierId: id,
        supplierName: id ? String(g.supplierName ?? '') : '',
        groups: [],
        rows: 0,
        pieces: 0,
        amount: 0,
        noPricePieces: 0,
      };
      byId.set(id, sg);
    }
    sg.groups.push(g);
    sg.rows += g.rows;
    sg.pieces += g.pieces;
    sg.amount = round2(sg.amount + g.amount);
    sg.noPricePieces += g.noPricePieces;
  }
  return [...byId.values()].sort(
    (a, b) =>
      (a.supplierId ? 0 : 1) - (b.supplierId ? 0 : 1) ||
      b.pieces - a.pieces ||
      (a.supplierName < b.supplierName ? -1 : a.supplierName > b.supplierName ? 1 : 0),
  );
}