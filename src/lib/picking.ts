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
//   · 进价 —— 订单行**实际进价**（`actual_cost_cents`）> 订单行**进价预估**（`cost_cents`）>
//     产品**当前进价**（`pl_products.cost_cents`，仅供还没钉预估的老行做估算；与利润页的
//     "actual > estimate > none" 的差别就在这里：拣货是"要花多少钱"的经营估算，不是历史口径）。
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
// `opts.taken`（键 `takenKey(款,色,码)`）来自**已提交拿货单**（与 `purchase-db.takenLedger()`
// 同一粒度、同一含义）。⚠️ 必须是**台账**不是**缺口**（2026-10-17 事故）：`outstanding()` 会丢掉
// "缺为 0"的行 ⇒ 拿齐的款色在台账里消失 ⇒ 清单按已拿 0 算、卡永远停在待拿。
// `opts.ignored` 是「无需补货」的款色集合。两者都缺省时全部按 0 / 无忽略
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
  positiveCents,
  resolveQty,
  round2,
  skuKey,
  type SettleQtyInfo,
} from './orderCost';

/** 默认天数窗（"近 30 天"是产品默认值，写在界面上可见） */
export const DEFAULT_PICKING_DAYS = 30;

/**
 * 「已拿 / 还要拿」的键（款 · 色 · 码）—— **与 `electron/purchase-db.ts` 的 `takenLedger()`
 * 分组粒度逐字一致**（`style_code|color|size`，三个原文、不归一）。
 *
 * 为什么把它抬成导出函数：拣货单要显示"已拿多少、还差多少"，而"已拿"来自已提交的拿货单。
 * 键只要两处拼得不一样，就会出现"明明拿过、拣货单还说没拿"——这种错不报错、只是数字不对。
 */
export function takenKey(styleCode: unknown, color: unknown, size: unknown): string {
  return `${String(styleCode ?? '')}|${String(color ?? '')}|${String(size ?? '')}`;
}

/**
 * 「已拿」的**身份优先**键（2026-10-20）：有款色 id 就用 `#id|码`，没有才回落文本三元组。
 *
 * 为什么必须由同一个函数生成：id 行与文本行是**互斥**的两拨（`takenLedger()` 也是这么分的），
 * 两边各拼一套键就会出现"已拿算两遍"（缺口提前变 0 ⇒ 漏货）或"一遍都算不上"（全待拿，用户实报）。
 * 台账侧与清单侧**只能调这一个函数**。
 */
export function takenKeyOf(
  row:
    | {
        styleColorId?: unknown;
        styleCode?: unknown;
        color?: unknown;
        size?: unknown;
      }
    | null
    | undefined
): string {
  const id = Number(row?.styleColorId) || 0;
  return id > 0
    ? `#${id}|${String(row?.size ?? '')}`
    : takenKey(row?.styleCode, row?.color, row?.size);
}

/**
 * 从已拿台账查一行的**已拿件数**：身份键 + 文本兜底，**不双算**。
 *
 * 为什么是"两段相加"而不是"有 id 就不看文本"（2026-10-20）：
 * 台账按 `takenKeyOf` **互斥分桶** —— 带 id 的明细只进 `#id|码`，老明细（id=0）只进文本键。
 * 这是两拨**不同的单据行**，相加不会重复；反过来"有 id 就只看 id"会让老明细（id=0 但色名恰好
 * 没改过）永远算不上 ⇒ 拿过的货又出现在待拿里（用户实报的"全待拿"的另一个来源）。
 *
 * ⚠️ 与 `electron/purchase-db.ts` 的 `outstanding()` 必须同口径（那边是 `byId + byText`）。
 * 主进程不能 import 本文件（两套 tsconfig），所以口径靠这条注释 + `tests/picking.spec.ts` 钉住。
 */
export function takenFrom(
  map: Record<string, number> | null | undefined,
  row: {
    styleColorId?: unknown;
    styleCode?: unknown;
    color?: unknown;
    size?: unknown;
  }
): number {
  if (!map || typeof map !== 'object') return 0;
  const n = (k: string): number => Math.max(0, Number(map[k]) || 0);
  const byId = n(takenKeyOf(row));
  const id = Number(row?.styleColorId) || 0;
  if (id <= 0) return byId;
  return byId + n(takenKey(row?.styleCode, row?.color, row?.size));
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
   * **已拿件数**（键 = `takenKeyOf(行)`：有款色 id 用 `#id|码`，老数据用 `款|色|码`）
   * —— 来自**已提交**的拿货单（宿主 `purchaseTaken()` 的同一份口径）。
   * ⚠️ 只能喂**台账**（`takenLedger`）：喂"缺口"（`outstanding`）时拿齐的款色会缺项 ⇒ 还差算成满额。
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
  /** 组内**第一个非 0** 的款色 id（身份键，0 = 未归类）。"已拿"匹配优先用它，见 `takenKeyOf`。 */
  styleColorId: number;
  size: string;
  /**
   * **下单尺码**（加码款才有；空数组 = 这一组没加过码）。
   *
   * 亚洲款偏小：客户下单 L，实际要拿 XL（偏移来自 `pl_size_shift`，换算见 `lib/sizeShift`）。
   * 换算发生在聚合**之前**，所以 `size` 是**拿货码**（也是"已拿"的键）；这里留下单码，
   * 只为把"为什么拿 XL 而不是 L"说清楚（界面 `L→XL`、拿货单记下单码、导出「下单码」列）。
   * 封顶时**多个下单码会并到同一个拿货码**（L 和 XL 都→XXL），所以是数组，不是单值。
   */
  orderSizes: string[];
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
  /**
   * **未归类订单行**（没有款色归属）按**商品ID** 聚合 —— 界面据此提示"这批数不准"并给修复入口。
   *
   * 为什么要单独一块（2026-10-20）：未归类行照样进统计（漏掉就是悄悄少算），但它们
   * 既扣不掉"已拿"、也取不到图 ⇒ 界面必须**明确标出**是哪些商品、几件，而不是让用户
   * 面对一堆"待拿"去猜为什么拿不完。按商品ID 聚合是因为修复动作就落在商品ID 上
   * （选中产品 → 该商品的历史订单自动回填款色），一次修一批。
   */
  unclassifiedItems: {
    itemId: string;
    /** 件数（与 `pieces` 同口径 = resolveQty 之和） */
    pieces: number;
    /** 订单行数 */
    rows: number;
    /** 涉及店铺（去重） */
    shops: string[];
  }[];
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

/**
 * 天数窗下界（yyyy-mm-dd）：`today - days`；`days<=0` 返回 ''（不限）。
 *
 * 导出给「按单核对」的时间窗用（2026-11-02）：两处口径必须同一份实现，
 * 否则同一页上的拣货宫格与按单核对会在"哪一天算进了窗口"上分叉。
 */
export function cutoffDate(today: string, days: number): string {
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
 * **进价 / 预估金额**（S3，2026-10-05；C2 改口径 2026-10-21）：
 *   · 单价 = 行级**实付真值** > 行级**进价预估** > 产品**当前进价**（分三档，逐行取第一个正数）；
 *     前两档与利润页同一口径（同一行同一字段），第三档只补"预估还没钉过"的经营估算；
 *   · 逐行 `件数 × 单价` 累加（不是"件数合计 × 某一个单价"）：同一 SKU 的各行价可能不同，
 *     按组相乘会挑错价；
 *   · 三档都没有 → 该行**不计入金额**并累到 `noPricePieces`（**不按 0 蒙**：
 *     按 0 算会让"估算偏低"和"真便宜"长得一模一样）。
 */
export function aggregatePicking(
  rows: PickingRow[] | null | undefined,
  opts: { settleQty?: Record<string, SettleQtyInfo> | null } & PickingScope = {}
): PickingSummary {
  const list = Array.isArray(rows) ? rows : [];
  const days = Number.isFinite(Number(opts?.days)) ? Number(opts.days) : DEFAULT_PICKING_DAYS;
  const cutoff = cutoffDate(String(opts?.today ?? '') || todayLocal(), days);
  // 已拿 / 已忽略：缺省 = 空（行为与"还没有拿货单"逐字一致）
  const takenMap = opts?.taken && typeof opts.taken === 'object' ? opts.taken : {};
  const ignoredSet = opts?.ignored instanceof Set ? opts.ignored : null;
  const agg = new Map<string, PickingGroup>();
  const allOrders = new Set<string>();
  /** 未归类（无款色身份）行 → 按商品ID 聚合（口径与主循环完全一致：同一过滤、同一 qty） */
  const unclassified = new Map<
    string,
    { itemId: string; pieces: number; rows: number; shops: string[] }
  >();
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
    unclassifiedItems: [],
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
      opts?.settleQty
    );
    // 进价三档：实付真值 > 进价预估 > 产品当前价（见函数头注释；0 一律当"没有"）
    const unitCents =
      positiveCents(r?.actualCostCents) ??
      positiveCents(r?.costCents) ??
      positiveCents(r?.productCostCents);
    const unit = unitCents === null ? null : round2(unitCents / 100);
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
        styleColorId: 0,
        size: String(r?.size ?? ''),
        orderSizes: [],
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
    // 款色 id：组内**第一个非 0** 的留着（同款色码的各行应当同 id；未归类行为 0，不覆盖已认出的）
    if (!g.styleColorId) g.styleColorId = Number(r?.styleColorId) || 0;
    // 款名：组内**第一个非空**的留着（同款的各行名字一致；识别链降级时可能整组都为空）
    if (!g.styleName) {
      const nm = String(r?.styleName ?? '');
      if (nm) g.styleName = nm;
    }
    if (qtySource === 'assumed') g.missingQty += 1;
    // 下单码：换算阶段打在行上（`applySizeShift` 的产物）；同组可能来自多个下单码（封顶合并）。
    // ⚠️ 不能加 `os !== g.size` 的过滤：封顶行的下单码**就等于**拿货码（6XL→6XL），
    //    滤掉它会让"5XL→6XL 与 6XL→6XL 并成一组"看起来只来自 5XL（少说了一半来源）。
    const os = String((r as { orderSize?: unknown })?.orderSize ?? '').trim();
    if (os && !g.orderSizes.includes(os)) g.orderSizes.push(os);

    agg.set(key, g);

    summary.rows += 1;
    summary.pieces += qty;
    if (orderNo) allOrders.add(orderNo);
    // 未归类：款式归属为 0（后端 `style_color_id`）—— 件数照收，但单独列出来让人知道"这不全准"
    if (!(Number(r?.styleColorId) > 0)) {
      const iid = String(r?.itemId ?? '').trim();
      const it = unclassified.get(iid) ?? { itemId: iid, pieces: 0, rows: 0, shops: [] };
      it.pieces += qty;
      it.rows += 1;
      if (shop && !it.shops.includes(shop)) it.shops.push(shop);
      unclassified.set(iid, it);
    }
    if (noImage) summary.missingImage += 1;
    if (qtySource === 'assumed') summary.missingQty += 1;
    if (noSupplier) summary.missingSupplier += 1;
    if (noStyle) summary.missingStyle += 1;
  }

  for (const g of agg.values()) {
    g.orders = g.orderNos.length;
    g.orderNos.sort();
    // 下单码按码序排，界面/导出不随输入顺序跳位
    g.orderSizes.sort((a, b) => sizeOrder(a, b));
    g.shops.sort();
    g.supplierNames.sort();
    // 进价 = 有价件数的加权均价（同一 SKU 的各行可能一个用实付、一个用预估 → 表里给的是均价）
    g.unitPrice = g.pricedPieces > 0 ? round2(g.amount / g.pricedPieces) : null;
    if (g.noPricePieces > 0) summary.noPriceGroups += 1;
    // 已拿 / 还差 / 忽略：**组维度一次算**（逐行加会把同一行重复计）。
    // `remaining` 夹到 0 —— 多拿了是"拿多了"，不是"还差负数"（负数会让"已拿够"看起来像"还缺"）。
    g.taken = takenFrom(takenMap, g);
    g.remaining = Math.max(0, g.pieces - g.taken);
    g.ignored = !!(ignoredSet && ignoredSet.has(ignoreKey(g.styleCode, g.color)));
    summary.takenPieces += g.taken;
    summary.remainingPieces += g.remaining;
    if (g.remaining > 0 && !g.ignored) summary.remainingGroups += 1;
  }
  summary.groups = [...agg.values()].sort(
    (a, b) => b.pieces - a.pieces || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0)
  );
  summary.orders = allOrders.size;
  summary.unclassifiedItems = [...unclassified.values()]
    .map((it) => ({ ...it, shops: [...it.shops].sort() }))
    .sort(
      (a, b) => b.pieces - a.pieces || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0)
    );
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
      (a.supplierName < b.supplierName ? -1 : a.supplierName > b.supplierName ? 1 : 0)
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
  /** **下单码**（加码款才有；空 = 未加码）。展示成 `L→XL`，不是两张格 */
  orderSizes: string[];
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
  /** 本行涉及的下单码（各码并集，升序；空 = 未加码）—— 行级提示"这款加了 1 码"用 */
  orderSizes: string[];
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
  /**
   * 涉及订单号（各码订单号的**并集**，升序去重）—— 界面行上"涉及 N 个订单"展开后列的就是它。
   *
   * 为什么要并集而不是"某一码的"：一行是一个款色（含全部尺码），用户问"这行牵扯哪几单"时
   * 要的是这一行**所有码**合起来的单子；同单跨码只出现一次（2026-10-17 合并视图加）。
   */
  orderNos: string[];
}

/** 尺码的自然序：字母码 XS→XXXL、数字码按数值、其余按原串（`''` 的"无尺码"排最后）。
 *  为什么要排序而不是随手用输入顺序：格子若随件数/取数顺序跳位，同一行两次生成会长得不一样。 */
const SIZE_LETTER_ORDER = [
  'XXS',
  'XS',
  'S',
  'M',
  'L',
  'XL',
  'XXL',
  'XXXL',
  '2XL',
  '3XL',
  '4XL',
  '5XL',
];

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
 * 款色行的分组键（`款 · 色`，缺哪一段就把哪一段标出来）。
 *
 * 为什么要单独一个函数：`groupByColor` 用它建键，发货台「订单」屏的「带款色去拿货」
 * 也用它算出"该高亮哪一行"（`PickingView` 的 `focusKey`）—— 拼法一旦有两处，
 * 改了回落词（`(未识别款)` / `(无颜色)`）就会变成"点过去没有任何行被点亮"，
 * 而两边各自看起来都对。
 */
export function colorGroupKey(styleCode: unknown, color: unknown): string {
  return `${String(styleCode ?? '') || '(未识别款)'} · ${String(color ?? '') || '(无颜色)'}`;
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
    const key = colorGroupKey(g.styleCode, g.color);
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
          orderSizes: [],
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
          orderNos: [],
        },
        groups: [],
      };
      buckets.set(key, b);
    }
    b.groups.push(g);
    const row = b.row;
    row.sizes.push({
      size: g.size,
      orderSizes: [...g.orderSizes],
      pieces: g.pieces,
      taken: g.taken,
      remaining: g.remaining,
    });
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
    for (const os of g.orderSizes) if (!row.orderSizes.includes(os)) row.orderSizes.push(os);
    // 还差件按进价估：只统计**有价**的还差件（缺价的报出来，不按 0 蒙 —— 与 `aggregatePicking` 同一条纪律）
    if (g.remaining > 0) {
      if (g.unitPrice === null) row.pendingNoPricePieces += g.remaining;
      else row.pendingAmount = round2(row.pendingAmount + g.remaining * g.unitPrice);
    }
  }
  const out: PickingColorGroup[] = [];
  for (const { row, groups: gs } of buckets.values()) {
    row.sizes.sort((a, b) => sizeOrder(a.size, b.size));
    row.orderSizes.sort((a, b) => sizeOrder(a, b));
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
    // 订单号：各码的并集（同一单跨码只算一次）；排序让展开列表不随输入顺序跳位
    const nos = new Set<string>();
    for (const g of gs) for (const no of g.orderNos) nos.add(no);
    row.orderNos = [...nos].sort();
    row.orders = row.orderNos.length;
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
  supplierId?: number | null
): PickingGroup[] {
  const list = Array.isArray(groups) ? groups : [];
  return list.filter(
    (g) =>
      !g.ignored &&
      g.remaining > 0 &&
      (supplierId === undefined || supplierId === null || g.supplierId === supplierId)
  );
}

/**
 * 门 2（拿货前检查）：**这一批现在能不能开单**。
 *
 * 拦两件事，都只拦"真的会开出一张错单"的：
 *   ① `unclassifiedRows`：这批里有行还没归到款色。开进单里它们只会得到
 *      `purchase_items.style_color_id = 0`，"已拿"从此只能按**色名文本**兜底 ——
 *      以后谁给这个色改个名，这条已拿就永久失联，缺口永远消不掉。
 *   ② `noSupplierRows`：款色归好了、款却没有厂家。开单时主进程直接抛"厂商不存在"，
 *      用户拿到的是一句技术错误，而真正该做的是去指定厂家。
 *
 * **不拦**色名（这点很容易照着旧计划抄错）：色名是标签，不是身份。把 58 个色名做成
 * 开单前置，等于把"导入完就能拿货"这件事又推回成 58 次人工输入 —— 那正是这轮改造要拆掉的门。
 * 未命名的色在单子上按平台原文出（`5`），照样能拿；起名随时可补。
 *
 * ⚠️ 判据看**身份**（`styleColorId` / `supplierId`），不看 `styleCode` 是否为空串：
 *    "款编码空"是展示层的事（真库里存在有款色但款没编码的行），拿它当门会误伤。
 */
export interface PurchaseGate {
  /** 这批里还没归到款色的行数（款色码行） */
  unclassifiedRows: number;
  /** 这批里已归类、但款还没指定厂家的行数 */
  noSupplierRows: number;
  /** 两个都为 0 才开得成 */
  ok: boolean;
}

/** 入参必须是**这一批**（`pendingOf` 的结果），不是全库 —— 门的作用域跟着动作走 */
export function purchaseGateOf(rows: PickingGroup[] | null | undefined): PurchaseGate {
  const list = Array.isArray(rows) ? rows : [];
  let unclassifiedRows = 0;
  let noSupplierRows = 0;
  for (const g of list) {
    if (g.styleColorId <= 0) unclassifiedRows += 1;
    else if (g.supplierId === 0) noSupplierRows += 1;
  }
  return {
    unclassifiedRows,
    noSupplierRows,
    ok: unclassifiedRows === 0 && noSupplierRows === 0,
  };
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
