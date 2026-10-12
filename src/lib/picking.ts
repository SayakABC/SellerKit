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
//
// **"已拿 / 还差"（2026-10-10）**：拣货单问的是"**还要**拿什么"，而不只是"这批订单要什么"。
// `opts.taken`（键 `takenKey(款,色,码)`）来自**已提交拿货单**（与 `purchase-db.outstanding()`
// 同一粒度、同一含义），`opts.ignored` 是「无需补货」的款色集合。两者都缺省时全部按 0 / 无忽略
// ⇒ 输出与加这两项之前**逐字一致**（既有断言不会因为"多算了已拿"而变红）。
// `remaining = max(0, pieces − taken)` 夹到 0：多拿了是"拿多了"，不是"还差负数"。
//
// **款色折叠层（2026-10-10，界面重设计）**：界面行从「款色码」改成「**款色一行、尺码并排**」，
// 折叠与"待拿"口径都在本层（`groupByColor` / `pendingOf` / `pendingRollup`）——
// 折叠只是展示（每个尺码格仍带自己那三个数），**忽略/已拿/开单粒度一个都没变**。

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

/**
 * 「已拿 / 还要拿」的键（款 · 色 · 码）—— **与 `electron/purchase-db.ts` 的 `outstanding()`
 * 分组粒度逐字一致**（`style_code|color|size`，三个原文、不归一）。
 *
 * 为什么把它抬成导出函数：拣货单要显示"已拿多少、还差多少"，而"已拿"来自已提交的拿货单。
 * 键只要两处拼得不一样，就会出现"明明拿过、拣货单还说没拿"——这种错不报错、只是数字不对。
 */
export function takenKey(styleCode: unknown, color: unknown, size: unknown): string {
  return `${String(styleCode ?? '')}|${String(color ?? '')}|${String(size ?? '')}`;
}

/** 「无需补货」的键（款 · 色，**不含码**）—— 忽略是按整款色生效的（同 `purchase_ignore`） */
export function ignoreKey(styleCode: unknown, color: unknown): string {
  return `${String(styleCode ?? '')}|${String(color ?? '')}`;
}

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
  /**
   * **已拿件数**（键 = `takenKey(款, 色, 码)`）—— 来自**已提交**的拿货单（宿主 `outstanding()` 的同一份口径）。
   *
   * 为什么必须有它：拣货单问的是"要拿什么"，而"要拿"= 需求 − 已拿。没有这一项，
   * 开完拿货单后清单**一件不少**（订单还没发货），用户只能自己去第 5 步重新对一遍。
   * 缺省 / 空对象 → 全部按 0（还没开过拿货单），行为与加它之前**逐字一致**。
   */
  taken?: Record<string, number> | null;
  /**
   * 已被标记「无需补货」的款色键集合（`ignoreKey(款, 色)`，整款色生效，忽略全部尺码）。
   * 缺省 → 没有忽略（行为与加它之前一致）。
   */
  ignored?: Set<string> | null;
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
  /**
   * 款名（`oi_styles.name`）。'' = 未识别款或该款没录名字。
   *
   * 为什么让它进拣货单（2026-10-10 并入「拿货」时加）：拿货单的明细行有「名称」一栏
   * （`purchase_items.style_name`，编辑器里可改），原来那版靠 `outstanding()` 带过来；
   * 清单本身只显示 `key`（`S1 · 黑 · L`）—— 合并后清单是"要拿什么"的**唯一**出处，
   * 不带款名就得让用户开完单再逐行手打名字。
   */
  styleName: string;
  /** **有效颜色**（宿主侧已做回落：款色 → 订单原文色）。分组键用它，不直接用订单原文。 */
  color: string;
  size: string;
  /** **要拣几件** = 组内各行件数之和（分不清件数的行按 1 件，见 `missingQty`） */
  pieces: number;
  /**
   * **已拿件数**（同款色码，来自已提交拿货单；见 `PickingScope.taken`）。
   * 可能大于 `pieces`（多拿了）—— 如实呈现，`remaining` 夹到 0，不把"多拿"伪装成"还差负数"。
   */
  taken: number;
  /** **还差件数** = `max(0, pieces − taken)` —— 这才是"还要拿多少" */
  remaining: number;
  /** 该款色被标记「无需补货」（整款色，忽略全部尺码）—— 界面据此标"已忽略"，不计入待拿 */
  ignored: boolean;
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
  /** 已拿件数合计（见 `PickingGroup.taken`） */
  takenPieces: number;
  /** 还差件数合计（= Σ `max(0, pieces − taken)`，**含**被忽略的组 —— 它是"总需求还差多少"） */
  remainingPieces: number;
  /** **还差 > 0 且未被忽略**的组数 —— 界面用它答"还要拿几款"（被忽略的不算） */
  remainingGroups: number;
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
  // 已拿 / 已忽略：缺省 = 空（行为与"还没有拿货单"逐字一致）
  const takenMap = opts?.taken && typeof opts.taken === 'object' ? opts.taken : {};
  const ignoredSet = opts?.ignored instanceof Set ? opts.ignored : null;
  const agg = new Map<string, PickingGroup>();
  const allOrders = new Set<string>();
  const summary: PickingSummary = {
    groups: [],
    suppliers: [],
    rows: 0,
    pieces: 0,
    takenPieces: 0,
    remainingPieces: 0,
    remainingGroups: 0,
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
        styleName: String(r?.styleName ?? ''),
        color: String(r?.color ?? ''),
        size: String(r?.size ?? ''),
        pieces: 0,
        // 已拿 / 还差 / 忽略在**组维度**上算（见下方 `for (const g of agg.values())`），
        // 逐行累加会把同一行的 taken 加 N 次（taken 是"这款色码总共拿了多少"，不是"每行拿了多少"）。
        taken: 0,
        remaining: 0,
        ignored: false,
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
    // 款名：组内**第一个非空**的留着（同款的各行名字一致；识别链降级时可能整组都为空）
    if (!g.styleName) {
      const nm = String(r?.styleName ?? '');
      if (nm) g.styleName = nm;
    }
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
    // 已拿 / 还差 / 忽略：**组维度一次算**（逐行加会把同一行重复计）。
    // `remaining` 夹到 0 —— 多拿了是"拿多了"，不是"还差负数"（负数会让"已拿够"看起来像"还缺"）。
    g.taken = Math.max(0, Number(takenMap[takenKey(g.styleCode, g.color, g.size)]) || 0);
    g.remaining = Math.max(0, g.pieces - g.taken);
    g.ignored = !!(ignoredSet && ignoredSet.has(ignoreKey(g.styleCode, g.color)));
    summary.takenPieces += g.taken;
    summary.remainingPieces += g.remaining;
    if (g.remaining > 0 && !g.ignored) summary.remainingGroups += 1;
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

// ─────────────────────────────── 款色行 / 待拿口径（2026-10-10 界面重设计） ───────────────────────────────
//
// 界面从「一个款色码一行、图逐码重复」改成「**款色一行、尺码并排**」，于是需要一个把
// `PickingGroup[]`（款色码粒度）折叠成 `PickingColorGroup[]`（款色粒度）的纯函数；
// 「按此生成拿货单」的按钮件数与主进程开单的明细行也必须从**同一条判据**取（见 `pendingOf`）。
// 三条口径与上方 `aggregatePicking` 逐字同源（只是再向上折一层），不另讲一套：

/** 款色行里的一个尺码格：主数是**还差**，需求/已拿进 tooltip（界面拼 title 用） */
export interface PickingSizeCell {
  size: string;
  /** 需求件数 */
  pieces: number;
  /** 已拿件数 */
  taken: number;
  /** 还差件数（每码已夹 0） */
  remaining: number;
}

/**
 * **款色一行**（界面行的粒度）：同款同色的各尺码合成一行，尺码并排成小格。
 *
 * ⚠️ 这只是**折叠展示**，不是新的数据粒度：忽略仍是款色（`ignoreKey`）、已拿仍是款色码
 * （`takenKey`）、开单明细仍是款色码 —— 折叠出来的每个尺码格都带着自己那三个数，
 * 谁也没被平均掉（把 `L` 的还差摊进一行总账里，就等于让用户猜每个码拿几件）。
 */
export interface PickingColorGroup {
  /** 分组键：`S1 · 黑`（缺哪段标哪段，与 `skuKey` 同一套占位词） */
  key: string;
  styleCode: string;
  styleName: string;
  color: string;
  /** 主供应商（组内首个非 0，同 `PickingGroup.supplierId` 口径） */
  supplierId: number;
  supplierName: string;
  /** 组内**首个非空**的图（同款色的订单图通常一致；逐码重复只是浪费） */
  imagePath: string;
  /** 尺码并排（**排序与输入顺序无关** —— 让同一行的格子不随件数/数据顺序跳位） */
  sizes: PickingSizeCell[];
  /** 需求件数合计（Σ 各码） */
  pieces: number;
  /** 已拿件数合计（Σ 各码） */
  taken: number;
  /** 还差件数合计（Σ 各码的夹 0 值） */
  remaining: number;
  /** 整款色被标「无需补货」（各码一致 —— 忽略键里没有码） */
  ignored: boolean;
  /**
   * 进价（**元/件**）= 各码"有价需求件"的加权均价（口径同 `PickingGroup.unitPrice`，只向上折一层）。
   * `null` = 这款色一件都没取到价（界面标「无进价」，**不是 0**）。
   */
  unitPrice: number | null;
  /** **还差件**按进价估的金额（元）；只含**有价**的还差件（缺价件进 `pendingNoPricePieces`，不按 0 蒙） */
  pendingAmount: number;
  /** 还差件里没取到进价的件数（界面据此说"估算不含这几件"） */
  pendingNoPricePieces: number;
  /** 逐项缺口（Σ 各码；界面按它出"缺"标签） */
  missingImage: number;
  missingQty: number;
  missingStyle: number;
  /** 没取到进价的件数（按**需求**计；界面按它标「无进价」） */
  noPricePieces: number;
  /** 涉及订单数（各码订单号的**并集**去重 —— 同单跨码只算一单） */
  orders: number;
}

/** 尺码的自然序：字母码 XS→XXXL、数字码按数值、其余按原串（`''` 的"无尺码"排最后）。
 *  为什么要排序而不是随手用输入顺序：格子若随件数/取数顺序跳位，同一行两次生成会长得不一样。 */
const SIZE_LETTER_ORDER = ['XXS', 'XS', 'S', 'M', 'L', 'XL', 'XXL', 'XXXL', '2XL', '3XL', '4XL', '5XL'];

function sizeOrder(a: string, b: string): number {
  const rank = (raw: string): [number, number, string] => {
    const t = raw.trim().toUpperCase();
    const li = SIZE_LETTER_ORDER.indexOf(t);
    if (li >= 0) return [1, li, ''];
    const n = Number(t);
    if (t !== '' && Number.isFinite(n)) return [2, n, ''];
    return [3, 0, t];
  };
  const ra = rank(a);
  const rb = rank(b);
  return ra[0] - rb[0] || ra[1] - rb[1] || (ra[2] < rb[2] ? -1 : ra[2] > rb[2] ? 1 : 0);
}

/**
 * 把（同一批）拣货项按**款色**折成界面行。
 *
 * 输入通常传一个厂家段里的 `PickingGroup[]`（`summary.suppliers[i].groups`），
 * 也可传全量 `summary.groups`（顶部"待拿 X 款色"就这么算）。
 * 排序：**需求件数降序 → 键升序**（与 `aggregatePicking` 同一规则，结果不随输入顺序漂移）。
 *
 * 图/款名取**首个非空**，供应商取**首个非 0** —— 与 `aggregatePicking` 组内回落同一手法；
 * 缺哪一环的计数逐码求和（折叠不丢"缺"）。
 */
export function groupByColor(groups: PickingGroup[] | null | undefined): PickingColorGroup[] {
  const list = Array.isArray(groups) ? groups : [];
  const buckets = new Map<string, { row: PickingColorGroup; groups: PickingGroup[] }>();
  for (const g of list) {
    const key = `${g.styleCode || '(未识别款)'} · ${g.color || '(无颜色)'}`;
    let b = buckets.get(key);
    if (!b) {
      b = {
        row: {
          key,
          styleCode: g.styleCode,
          styleName: '',
          color: g.color,
          supplierId: 0,
          supplierName: '',
          imagePath: '',
          sizes: [],
          pieces: 0,
          taken: 0,
          remaining: 0,
          ignored: g.ignored,
          unitPrice: null,
          pendingAmount: 0,
          pendingNoPricePieces: 0,
          missingImage: 0,
          missingQty: 0,
          missingStyle: 0,
          noPricePieces: 0,
          orders: 0,
        },
        groups: [],
      };
      buckets.set(key, b);
    }
    b.groups.push(g);
    const row = b.row;
    row.sizes.push({ size: g.size, pieces: g.pieces, taken: g.taken, remaining: g.remaining });
    row.pieces += g.pieces;
    row.taken += g.taken;
    row.remaining += g.remaining;
    if (!row.styleName && g.styleName) row.styleName = g.styleName;
    if (!row.imagePath && g.imagePath) row.imagePath = g.imagePath;
    if (!row.supplierId && g.supplierId) {
      row.supplierId = g.supplierId;
      row.supplierName = g.supplierName;
    }
    row.missingImage += g.missingImage;
    row.missingQty += g.missingQty;
    row.missingStyle += g.missingStyle;
    row.noPricePieces += g.noPricePieces;
    // 还差件按进价估：只统计**有价**的还差件（缺价的报出来，不按 0 蒙 —— 与 `aggregatePicking` 同一条纪律）
    if (g.remaining > 0) {
      if (g.unitPrice === null) row.pendingNoPricePieces += g.remaining;
      else row.pendingAmount = round2(row.pendingAmount + g.remaining * g.unitPrice);
    }
  }
  const out: PickingColorGroup[] = [];
  for (const { row, groups: gs } of buckets.values()) {
    row.sizes.sort((a, b) => sizeOrder(a.size, b.size));
    // 进价 = 有价需求件的加权均价（与 `PickingGroup.unitPrice` 同一口径，只是再向上折一层）
    let paid = 0;
    let paidPieces = 0;
    for (const g of gs) {
      if (g.unitPrice !== null) {
        paid += g.unitPrice * g.pricedPieces;
        paidPieces += g.pricedPieces;
      }
    }
    row.unitPrice = paidPieces > 0 ? round2(paid / paidPieces) : null;
    const orders = new Set<string>();
    for (const g of gs) for (const no of g.orderNos) orders.add(no);
    row.orders = orders.size;
    out.push(row);
  }
  return out.sort((a, b) => b.pieces - a.pieces || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/**
 * **待拿**的拣货项 = 「还差 > 0 且未被忽略」（可选再按厂家筛一层）。
 *
 * 为什么必须是导出函数（而不是各调用点自己 filter）：界面上「按此生成拿货单（N 件）」的 N、
 * 以及主进程真正写进订单的明细行，回答的是**同一个问题** —— 两者只要各自写一遍 filter，
 * 就会出现"按钮说 12 件、单里 14 件"这种没人查得出的错。
 *
 * `supplierId` 缺省 = 不限厂家（"总共有哪些要拿"）；给数则**精确匹配**（含 `0`：未指定厂家段）。
 */
export function pendingOf(
  groups: PickingGroup[] | null | undefined,
  supplierId?: number | null,
): PickingGroup[] {
  const list = Array.isArray(groups) ? groups : [];
  return list.filter(
    (g) =>
      !g.ignored &&
      g.remaining > 0 &&
      (supplierId === undefined || supplierId === null || g.supplierId === supplierId),
  );
}

/** 「待拿」的合计（款色数 / 件数 / 预估金额 / 缺价件数）—— 顶部条件条与厂家段标题共用 */
export interface PendingRollup {
  /** 待拿款色数（款色行里还差 > 0 且未忽略的行数） */
  colors: number;
  /** 待拿件数合计（Σ 还差） */
  pieces: number;
  /** 预估金额（元，只含有价的还差件） */
  amount: number;
  /** 还差件里没取到进价的件数（金额里不含它们） */
  noPricePieces: number;
}

/** 按款色行汇总"待拿"（口径 = `pendingOf` 的款色折叠版；被忽略/已拿完的行不进任何一项） */
export function pendingRollup(rows: PickingColorGroup[] | null | undefined): PendingRollup {
  const out: PendingRollup = { colors: 0, pieces: 0, amount: 0, noPricePieces: 0 };
  for (const r of Array.isArray(rows) ? rows : []) {
    if (r.ignored || r.remaining <= 0) continue;
    out.colors += 1;
    out.pieces += r.remaining;
    out.amount = round2(out.amount + r.pendingAmount);
    out.noPricePieces += r.pendingNoPricePieces;
  }
  return out;
}