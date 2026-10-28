// src/lib/orderCost.ts
// 「订单成本」纯计算层：订单行 + 克重 + 运价表 + 款级成本 → 逐行 运费 / 产品成本 / 缺口。
//
// 为什么单独一层（三条都是被咬过的）：
//   1. **口径单源**：运费一律走 `shipRateOrders.quoteOrders`（含拒算五分类），本层只补"成本侧" ——
//      自己再算一遍运费，就会出现"订单页看到的运费"与"运费岛看到的运费"两个数；
//   2. **缺哪一环要看得见**：无国家 / 无克重 / 运价表没这张卡 / 订单行未识别款 / 该款无成本，
//      逐行标 `gaps`，**不静默按 0 算** —— 按 0 算出来的"利润"比没有更危险；
//   3. 纯函数（不碰 DB / IPC）→ 可被 vitest 直接覆盖（DB 层受 Electron ABI 限制测不了）。
//
// 成本取数口径（C2，2026-10-21；本层为**唯一实现**，别再造第二套）：
//   订单行两个字段，**实际 > 预估 > 缺**：
//   · `actualCostCents`（`oi_order_items.actual_cost_cents`）= 拿货落账回写的实付真值；
//   · `costCents`（`oi_order_items.cost_cents`）= 归类核对「确认无误」时按产品当时价钉的**预估**；
//   · 两者都没有 → `productCost = null` + 标 `cost` 缺口（**不按 0 算**）。
//   产品表的当前价（`pl_products.cost_cents`）只用于给**新订单**钉预估，本层不回查 ——
//   否则改一次价，历史利润全跟着变（预测不可复算）。
//
// 数量口径（2026-09-29，P2 落地）：
//   件数**逐行取真值**，两个来源按优先级：① 结算明细的商品行（平台口径，仅当该 (订单,商品) 在结算表里
//   **只有一行**时才敢用 —— 多行 = 同一商品的不同 SKU，把合计给到每一行会翻倍）；② 订单报表
//   「商品信息」块内的 `商品数量`（拆分后每行只剩自己那一块，故就是这一件的数量）；
//   两者都没有 → **按 1 件并逐行标 `qty` 缺口**（拣货单的件数不能是猜的）。
//
// ⚠️ 件数**不参与**成本/运费/毛利算术（只作展示与拣货口径）：多件的合并计费是运价岛的开放项
//   （`shipRateOrders` 一期恒 1 件/行），单方面按件数放大成本/运费会让利润改口径而无人复核。

import type { RateTable, Rounding } from './shipRate';
import { parseRowQty } from './orderRowSplitter';
import {
  extractShipping,
  quoteOrders,
  type OrderQuoteRow,
  type OrderShippingRow,
} from './shipRateOrders';

/** 运价表快照（一次导入 = 一条；`effectiveFrom` = 导入当日） */
export interface RateSnapshot {
  effectiveFrom: string;
  table: RateTable;
}

/**
 * 一单的包裹汇总（宿主 `parcelTotals(order_no)` 的形状；利润页按单号批量取）。
 * **任一个包缺运费 ⇒ `shipCents` 为 null** —— "已知部分之和"不能冒充总运费。
 */
export interface OrderParcelTotals {
  count: number;
  shipCents: number | null;
  weightG: number | null;
  shipMissing: number;
  weightMissing: number;
}

/**
 * 按订单日期取"**当时生效的那份**"运价表（运价快照自身的生效区间）：
 *   · `effectiveFrom <= 订单日` 的**最近一份**；
 *   · 订单日早于所有快照 → **回落最早一份**（宁可用"当时已知的最早那份"，也不判成缺运价表）；
 *   · 订单日认不出（''）→ 取**最新一份**；
 *   · 没有快照 → `null`（调用方回落到"当前那份"或标 `rate` 缺口）。
 *
 * 为什么必须按日期取：报价单会更新，只留"当前那份"会让**历史订单的预测运费跟着变** —— 预测不可复算。
 */
export function pickRateSnapshot(
  snapshots: RateSnapshot[] | null | undefined,
  bizDate: string,
): RateTable | null {
  const rows = (Array.isArray(snapshots) ? snapshots : []).filter((s) => s && s.table && s.effectiveFrom);
  if (!rows.length) return null;
  const sorted = [...rows].sort((a, b) =>
    a.effectiveFrom < b.effectiveFrom ? -1 : a.effectiveFrom > b.effectiveFrom ? 1 : 0,
  );
  if (!bizDate) return sorted[sorted.length - 1].table;
  let hit: RateSnapshot | undefined;
  for (const r of sorted) {
    if (r.effectiveFrom <= bizDate) hit = r;
    else break;
  }
  return (hit ?? sorted[0]).table;
}

/** 缺口标识（逐行给，界面按它提示"去哪儿补"） */
export type OrderCostGap =
  | 'revenue'
  /** 采集单**缺汇率**：外币帧在 `ae_rates` 里查不到 → 整单金额落 NULL。
   *  单列一档是因为**补法不同**：`revenue`（导入报表里没有金额）无处可补，
   *  而它只要去「成本与汇率」加一条汇率、重推一次就有钱（见 `fx` 与 `revenue` 的拆分）。 */
  | 'fx'
  | 'country'
  | 'weight'
  | 'rate'
  /** 这一单**已拆包**，但还有包裹没填运费 —— 运费按包裹真值算，**不回落运价表估算**。
   *  补法明确：去「归类核对 › 拆包」把每个包的运费填上。 */
  | 'parcel'
  | 'style'
  | 'cost'
  | 'tax'
  | 'qty';

/** 这一行是从哪条**摄取通道**来的（C1 合并后两条链进同一模型）：
 *  `import` = Excel 报表导入（`oi_orders`）· `collect` = 浏览器采集（`oi_orders`, source=collect） */
export type OrderSource = 'import' | 'collect';

/** 件数的来源：`settle` = 结算明细商品行（平台真值）；`order` = 订单侧真值（报表块 `商品数量` / 采集行数量）；`assumed` = 都没有 → 按 1 件 */
export type QtySource = 'settle' | 'order' | 'assumed';

/** 结算明细里一个 `(订单,商品)` 的商品行件数：`lines` = 商品行数（>1 表示同商品多 SKU，合计不可逐行复用） */
export interface SettleQtyInfo {
  lines: number;
  qty: number;
}

/**
 * 结算件数的查表键：`订单号 \u0001 商品ID`（`\u0001` 不会出现在业务文本里，不会与真实内容撞车）。
 * 键的形状必须两端一致 → 由本文件导出，消费侧（页面）**别自己再拼一份**。
 */
export function settleQtyKey(orderNo: unknown, itemId: unknown): string {
  return `${String(orderNo ?? '').trim()}\u0001${String(itemId ?? '').trim()}`;
}

/**
 * **件数的唯一判据**（订单利润页与拣货单都用它，别各写一份）：
 *   ① 结算商品行真值（仅当该 (订单,商品) 在结算表里**只有一行** —— 多行 = 同商品多 SKU，合计给每行会翻倍）；
 *   ② **源直接给的件数**（`row.qty`）：采集帧每行就带数量，是**真值**，不必去解析文本；
 *   ③ 订单报表「商品信息」块内的 `商品数量`（拆分后每行只剩自己那一块）；
 *   ④ 都没有 → `1` + `assumed`（调用方据此标缺口，**不静默**）。
 *
 * ⚠️ 别把 ② 漏了：漏了会让采集订单的件数恒为 1 并标"缺件数"（真值就在手上却没用）。
 */
export function resolveQty(
  row: {
    orderNo?: unknown;
    itemId?: unknown;
    rawFields?: Record<string, string> | null;
    /** 源直接给的件数（采集行数量）；导入侧没有该字段 */
    qty?: unknown;
  } | null | undefined,
  settleQty?: Record<string, SettleQtyInfo> | null,
): { qty: number; qtySource: QtySource } {
  const sq = settleQty?.[settleQtyKey(row?.orderNo, row?.itemId)] ?? null;
  if (sq && sq.lines === 1 && sq.qty >= 1) return { qty: sq.qty, qtySource: 'settle' };
  const own = Number(row?.qty);
  if (Number.isFinite(own) && own >= 1) return { qty: Math.round(own), qtySource: 'order' };
  const report = parseRowQty(row?.rawFields ?? {});
  if (report !== null) return { qty: report, qtySource: 'order' };
  return { qty: 1, qtySource: 'assumed' };
}

/** SKU（款 × 色 × 码）的分组键：**缺哪一段就把哪一段标出来**（两张表的口径必须一致） */
export function skuKey(row: { styleCode?: unknown; color?: unknown; size?: unknown }): string {
  return `${String(row?.styleCode ?? '') || '(未识别款)'} · ${String(row?.color ?? '') || '(无颜色)'} · ${
    String(row?.size ?? '') || '(无尺码)'
  }`;
}

/**
 * 尺码**比较用**归一（只用于建查表键，**不改任何展示/落库值**）。
 *
 * 2026-10-19 真库取证：产品 SKU 的码是 `3XL/4XL/5XL`，同一批订单的码是 `XXXL` ——
 * 两边其实是一个码，但 `skuWeightKey` 逐字节比 ⇒ 一条也命中不了（症状是"补了克重还是缺克重"）。
 *
 * 只做两件**可判定等价**的事：全角→半角（`ＸＬ`→`XL`）、重复 X 与数字写法统一到数字写法
 * （`XXL`/`xxl`→`2XL`，`XXXL`→`3XL`）。**不碰** `S/M/L/XL/XS`（XS 与 S 是不同码），
 * 也不猜 `均码`/`70B` 之类 —— 认不出就原样返回，宁可查不到也不把两个码并成一格。
 */
export function canonSizeKey(size?: unknown): string {
  const src = String(size ?? '').trim();
  if (!src) return '';
  const s = src
    .replace(/[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]/g, (ch) =>
      String.fromCharCode(ch.charCodeAt(0) - 0xfee0),
    )
    .replace(/\s+/g, ' ')
    .trim()
    .toUpperCase();
  const many = /^(X{2,})L$/.exec(s); // XXL / XXXL / XXXXL → 2XL / 3XL / 4XL
  if (many) return `${many[1].length}XL`;
  return s;
}

/**
 * **产品库 SKU 克重**的查表键（款编码 × 颜色 × 尺码）—— 建表与查表两端共用同一份，别各写一遍。
 *
 * 存在理由（2026-10-01 用户实报）：算钱的运费只认「商品ID 克重」（`pl_item_weights`，来自商品信息 Excel），
 * 而用户在「货品档案」里补的是**产品库 SKU 克重**（`pl_variants.weight_g`）—— 补完利润毫无变化。
 * 两张表粒度不同（商品ID vs 款×色×码），但**订单行能识别出款色码时，SKU 克重是更准的那份**，故回落。
 *
 * 归一：款编码 `trim + toUpperCase`（与产品库 / 采购单的款编码口径一致）；色只 `trim`；
 * 码过 `canonSizeKey`（`XXXL` 与 `3XL` 必须同键，否则订单永远查不到产品那边填的克重）。
 * **不猜**：款编码为空、或色码全空 → 返回空串（调用方据此放弃回落，老老实实标缺克重）。
 */
export function skuWeightKey(styleCode?: unknown, color?: unknown, size?: unknown): string {
  const code = String(styleCode ?? '').trim().toUpperCase();
  const c = String(color ?? '').trim();
  const sz = canonSizeKey(size);
  if (!code || (!c && !sz)) return '';
  return `${code}\u0001${c}\u0001${sz}`;
}

/**
 * **同款同码**键（不带颜色）：`skuWeightKey` 把颜色留空的那一形态。
 * 由 `loadSkuWeights` **只在"各色同重"确实成立时**才写入，故它代表"这一码的重量唯一"，
 * 不是"随手拿某个颜色顶上"。
 */
export function skuSizeWeightKey(styleCode?: unknown, size?: unknown): string {
  return skuWeightKey(styleCode, '', size);
}

/**
 * 逐行定克重（**单源**：算钱引擎、宿主给运费岛的只读 op、以及各页面的缺口计数都调它，
 * 避免同一批订单在不同页面上给出两个数字）：
 *   ① 按**款色码**（`skuWeightKey`：款 × 色 × 码）查产品库 SKU 克重（`pl_variants.weight_g`）；
 *   ② ① 未命中时按**款码**（`skuSizeWeightKey`）查 —— 该键只在"这款这码各色同重"时存在。
 *   两级都没有 → `null`（调用方如实标「缺克重」，**不猜、不套别的款**）。
 *
 * ② 的理由（2026-10-19 真库取证）：订单上的颜色是**平台色名**（`7` / `Khaki` / `Photo color`），
 * 产品库里是用户自己的色名（`黑色` / `白色`），两者**没有可计算的对应关系**（数字色名连猜都无从猜起）。
 * 而实测量里 83/83 个「款×码」都是各色同重 ⇒ 让颜色退出克重的判定条件，
 * 比逼人去给平台色配一次"我的色名"更省事、也不会因为配错而算错运费。
 * 注意 ② **不会**掩盖"各色确实不同重"：那种款码不会产出该键，仍旧如实缺克重。
 *
 * 2026-10-01 变更（用户领域裁定）：克重是 **SKU 属性**，商品ID 上没有克重 ——
 * 原先"先查商品ID 克重（`pl_item_weights`）再回落"的两级取数已删（表也一并 DROP）。
 */
export function resolveWeightG(
  row: { styleCode?: unknown; color?: unknown; size?: unknown } | null | undefined,
  skuWeights?: Record<string, number> | null,
): number | null {
  const table = skuWeights ?? {};
  const pick = (key: string): number | null => {
    const v = key ? Number(table[key]) : Number.NaN;
    return Number.isFinite(v) && v > 0 ? v : null;
  };
  const exact = pick(skuWeightKey(row?.styleCode, row?.color, row?.size));
  if (exact !== null) return exact;
  return pick(skuSizeWeightKey(row?.styleCode, row?.size));
}

/** 建克重索引的入参：产品库 SKU 行（`pl_variants` 的最小子集） */
export interface WeightVariantRow {
  productId?: unknown;
  color?: unknown;
  size?: unknown;
  weightG?: unknown;
  status?: unknown;
}

/**
 * 由产品库 SKU 行建 `克重查表`（`resolveWeightG` 直接消费）。
 *
 * 两个键族：
 *   · 精确 `skuWeightKey(款, 色, 码)` —— 该行自己维护了克重（>0）就写，颜色为空的行**不写**
 *     （它建出来就是"同款同码"键，会让"各色不同重"被绕过）；
 *   · 折叠 `skuSizeWeightKey(款, 码)` —— **只在"这款这码各色确实同重"时**写：该款该码的
 *     **在售**变体全部填了克重、且值完全一致。有一条没填、或有一个色不同重 → 不写。
 *
 * 纪律：少算（缺克重，人看得见、会去补）优于错算（发错货）。所以宁可让这份表小一点。
 */
export function buildSkuWeightIndex(
  variants: WeightVariantRow[] | null | undefined,
  codeOf: Map<number, string>,
): Record<string, number> {
  const out: Record<string, number> = {};
  type Group = { total: number; filled: number; weight: number };
  const groups = new Map<string, Group>();

  for (const v of Array.isArray(variants) ? variants : []) {
    const code = String(codeOf.get(Number(v?.productId)) ?? '');
    if (!code.trim()) continue; // 没款编码 → 连料号都对不上，别建任何键
    const g = Number(v?.weightG) || 0;
    const color = String(v?.color ?? '').trim();
    const key = color ? skuWeightKey(code, color, v?.size) : '';
    if (key && g > 0) out[key] = g;

    // 已归档的变体不发货，不该挡住折叠（但它的精确键照样生效，上面已经写了）
    if (String(v?.status ?? '') === 'archived') continue;
    const sizeKey = skuSizeWeightKey(code, v?.size);
    if (!sizeKey) continue;
    const grp = groups.get(sizeKey) ?? { total: 0, filled: 0, weight: 0 };
    grp.total += 1;
    if (g > 0) {
      if (grp.filled === 0) grp.weight = g;
      else if (grp.weight !== g) grp.weight = -1; // 出现不同值 → 永久不可折叠
      grp.filled += 1;
    }
    groups.set(sizeKey, grp);
  }

  for (const [key, grp] of groups) {
    if (grp.total > 0 && grp.filled === grp.total && grp.weight > 0) out[key] = grp.weight;
  }
  return out;
}

/**
 * 订单经营状态分桶。**关闭单必须能单独排除**：实测真实报表 934/1722 是关闭单，
 * 混进利润会让整体虚高 —— 但它不删，单列一桶随时可看。
 */
export type BizBucket = 'completed' | 'intransit' | 'closed' | 'unknown';

/** 按状态原文分桶（宽松匹配；认不出 → `unknown`，**不硬塞进 completed**） */
export function bucketOfStatus(bizStatus: unknown): BizBucket {
  const s = typeof bizStatus === 'string' ? bizStatus.trim() : '';
  if (!s) return 'unknown';
  if (/关闭|取消|撤销|cancel|closed/i.test(s)) return 'closed';
  if (/完成|已收货|交易成功|complete/i.test(s)) return 'completed';
  if (/等待|待|运输|发货|在途|shipped|shipping/i.test(s)) return 'intransit';
  return 'unknown';
}

/** 平台是否代征代缴**三态**：空 = 不知道（**不能当"非代征"**，那会把增值税错算成我们的成本） */
export type TaxBearer = 'platform' | 'self' | 'unknown';

export function taxBearerOf(raw: unknown): TaxBearer {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return 'unknown';
  if (/平台.*税|已税|代征|代缴/.test(s)) return 'platform';
  return 'self';
}

/**
 * 从订单行收集去重后的商品ID（供批量取克重）。
 * 口径与 `computeOrderCosts` 同一份提取函数 —— 界面别自己再解析一遍 `raw_fields`。
 */
export function collectItemIds(
  orders: { rawFields: Record<string, string> }[] | null | undefined,
): string[] {
  const set = new Set<string>();
  for (const o of Array.isArray(orders) ? orders : []) {
    const { itemId } = extractShipping(o?.rawFields ?? {});
    if (itemId) set.add(itemId);
  }
  return [...set];
}

export interface OrderCostRow {
  id: number;
  orderNo: string;
  /** 摄取通道（界面按它标来源；两条链的数字在同一张表里可比） */
  source: OrderSource;
  shop: string;
  /** 店名归一键（主进程 `shopName.toNameKey`）—— 按店铺身份聚合营收时用它，名字只作展示 */
  shopKey: string;
  orderTime: string;
  styleCode: string;
  styleColor: string;
  /** 颜色 / 尺码（SKU 粒度 = 款×色×码） */
  color: string;
  size: string;
  /** 供应商（id 用于分组，名字用于展示） */
  supplierId: number;
  supplierName: string;
  itemId: string;
  /** 件数（这一行有几件）—— 拣货口径；取不到来源时按 1 件并标 `qty` 缺口（见 `qtySource`） */
  qty: number;
  /** 件数来自哪里（`assumed` = 结算与报表两处都没有 → 按 1 件，不是真值） */
  qtySource: QtySource;
  country: string;
  weightG: number | null;
  /**
   * 克重是从哪来的（决定这个数"可信到什么程度"，界面用 tooltip 说清楚）：
   * `snapshot` = 订单行上钉过的值（`oi_order_items.weight_g`，归类核对那刻的 SKU 克重）；
   * `lookup` = 现查产品库 SKU；`none` = 都没有。
   */
  weightSource: 'snapshot' | 'lookup' | 'none';
  /** 运费（元）；null = 这一环缺（见 gaps） */
  shipping: number | null;
  /**
   * 运费来自哪：
   * `parcel` = 该单包裹运费合计（按件数摊到各行，真值；见 `parcelTotals` 入参）；
   * `rate` = 按运价表估算（该单还没拆包）；`none` = 没包裹且运价表也算不出。
   */
  shippingSource: 'parcel' | 'rate' | 'none';
  /** 运费的拒算分类（`quoteOrders` 的 `reasonClass`）；'' = 算出来了；`parcelShipMissing` = 包裹缺运费 */
  shippingReason: string;
  /** 这一行用的是**哪份运价表**（快照生效日，yyyy-mm-dd）；'' = 用的是"当前那份"或没表 */
  rateVersion: string;
  /** 产品成本（元）；null = 缺成本 */
  productCost: number | null;
  /**
   * 成本来自哪（C2 两字段，2026-10-21）：
   * `snapshot` = 订单行**实际进价**（`oi_order_items.actual_cost_cents`，拿货落账回写的那笔钱）；
   * `estimate` = 订单行**进价预估**（`oi_order_items.cost_cents`，归类确认时按产品当时价钉的快照）；
   * `none` = 两处都没有（标 `cost` 缺口，**不按 0 算**）。
   */
  costSource: 'snapshot' | 'estimate' | 'none';
  /** 合计成本（元）= 运费 + 产品成本；任一分项为 null 则 null */
  total: number | null;
  /** 经营状态分桶（关闭单单独一桶） */
  bucket: BizBucket;
  /** 收入（元）= 订单金额；null = 报表里没有 */
  revenue: number | null;
  /** 税（元）= 增值税 + DDP，但**平台代征代缴时记 0**（平台已代收代缴，不是我们的成本）；null = 不知道谁承担 */
  taxCost: number | null;
  /** 平台费（元）= 收入 × 费率；`null` = **没配费率**（未扣，见 `platformFeeMissing`），不是 0 */
  platformFee: number | null;
  /** 这一行属于哪一轨：`precise` = 已结算（有平台结算数据）；`forecast` = 预测（在途/无结算数据） */
  tier: 'precise' | 'forecast';
  /** 精准轨：平台结算的**净收入**（元）；`null` = 没有结算数据（走预测轨） */
  preciseNetIncome: number | null;
  /**
   * 精准轨毛利（元）= 净收入 − 商品成本 − 运费。
   * ⚠️ 口径：净收入是**平台结算口径**（已扣佣金/交易服务费/营销费等平台费用），
   * 税与退款也以平台结算为准 —— 本层**不再另外加减**；成本与运费仍是我们的口径（运费是**预测**的，
   * 因为还没拿到物流实付）。任一分项缺则 null。
   */
  preciseGrossProfit: number | null;
  /** 毛利（元）= 收入 − 成本合计 − 税 − 平台费；任一分项缺则 null */
  grossProfit: number | null;
  /** 缺哪几环（空数组 = 全算齐了） */
  gaps: OrderCostGap[];
}

export interface OrderCostSummary {
  rows: OrderCostRow[];
  /** 参与计算的行数（**含关闭单** —— 它回答"读进来多少行"） */
  total: number;
  /** 成本与收入都算齐的行数（含关闭单） */
  ok: number;
  /**
   * ---- 以下全部为**利润口径**：只统计非关闭单 ----
   * 关闭单没有这笔收入，混进来会让每个数都虚高（它单列一桶，便于单独核对）。
   * ⚠️ 这一段的字段**必须同口径**。原先 `shippingTotal`/`costTotal`/`platformFeeTotal`
   * 是含关闭单的，而 `revenueTotal`/`grossTotal` 不含 —— 两者并排显示在同一张指标条上时，
   * 会出现"成本合计比收入合计还大"却看不出原因（关闭单有成本、没收入）。2026-10-03 统一。
   */
  /** 非关闭单的运费合计 */
  shippingTotal: number;
  /** 非关闭单的**产品成本**合计（不含运费） */
  productCostTotal: number;
  /** 非关闭单的成本合计 = 运费 + 产品成本（与毛利算式一致：收入 − 成本合计 − 税 − 平台费 = 毛利） */
  costTotal: number;
  /** 非关闭单的收入合计 */
  revenueTotal: number;
  /** 非关闭单的毛利合计（未配费率时未扣平台费） */
  grossTotal: number;
  /** 非关闭单的平台费合计（未配费率时为 0） */
  platformFeeTotal: number;
  /**
   * 平台费**未扣**（即没配近似费率）。
   * 做成**全局标志**而不是逐行缺口：它对每一行都成立，逐行标只会淹掉"这一行还缺什么"。
   * 已结算单将来用结算明细的真值替换（那时这里与逐行费用都以真值为准）。
   */
  platformFeeMissing: boolean;
  /** 按经营状态分桶的合计（关闭单在这里单列，便于单独核对） */
  bucketTotals: { bucket: BizBucket; rows: number; revenue: number; gross: number }[];
  /** 按缺口分桶的行数（界面提示"先去补什么"） */
  gapCounts: Record<OrderCostGap, number>;
  /** 按**摄取通道**分行的行数（C1 合并后同一页要能说清"这批里多少来自采集"） */
  sourceCounts: Record<OrderSource, number>;
}

export interface OrderCostInput {
  orders: {
    id: number;
    orderNo: string;
    shop?: string;
    /** 店名归一键（宿主 `shippingRows` 已算好）；缺省时按 `shop` 原文兜底，见 `computeOrderCosts` */
    shopKey?: string;
    orderTime?: string;
    styleCode?: string;
    styleColor?: string;
    /** 颜色 / 尺码（SKU 粒度）+ 供应商（拣货与统计要用） */
    color?: string;
    size?: string;
    supplierId?: number;
    supplierName?: string;
    /** 件数真值（采集行有；导入侧没有，由渲染层解析"商品信息"块） */
    qty?: number | null;
    /** 行级克重**快照**（`oi_order_items.weight_g`）；给了就用，认不出（null/<=0）才回落 SKU 查表 */
    weightG?: number | null;
    /** 行级**进价预估**快照（`oi_order_items.cost_cents`，单位：分）；0/null = 没钉过 */
    costCents?: number | null;
    /** 行级**实际进价**快照（`oi_order_items.actual_cost_cents`，单位：分）；0/null = 还没拿货落账 */
    actualCostCents?: number | null;
    rawFields: Record<string, string>;
    /** 摄取通道（缺省按 `import` 处理：老调用方不用改） */
    source?: OrderSource;
    /** ---- 利润用列（来自 `oi_orders`，单位：分）---- */
    amountCents?: number | null;
    vatCents?: number | null;
    ddpCents?: number | null;
    bizStatus?: string;
    taxPlatform?: string;
  }[];
  /**
   * 款色码 → 单件克重（`pl_variants.weight_g`；键由 `skuWeightKey` 生成）。
   * **克重的唯一来源**（2026-10-01 起：商品ID 上没有克重，原 `weights` 入参已删）。
   * 取数走 `core/services/skuWeights.loadSkuWeights()`；查不到才算缺克重。
   */
  skuWeights?: Record<string, number>;
  /** 运价表（"当前那份"，一般来自岛存储）——**没有快照时的回落**；null → 逐行标 `rate` 缺口 */
  rateTable: RateTable | null;
  /**
   * 运价表**快照集合**（宿主 `sr_rate_snapshots`）。给了它就**按订单日期逐行挑"当时那份"**
   * （各按所选快照分组计价，口径仍是同一个 `quoteOrders`）；不给则退回 `rateTable` 单表口径。
   */
  rateSnapshots?: RateSnapshot[] | null;
  /**
   * **按订单号索引的包裹运费/重量汇总**（宿主 `parcelTotalsByOrders`）。
   * 给了且该单 `count > 0` ⇒ 这一单的运费用**包裹合计**（真值，按件数摊到各行），
   * **不再按运价表估算**；包裹缺运费时标 `parcel` 缺口，**不回落估算**
   * （回落会让"用户已经在按包记运费"的数字被估算覆盖，且看不出来）。
   * 不传 / 该单不在表里 = 还没拆包，走原运价表链路。
   */
  parcelTotals?: Record<string, OrderParcelTotals> | null;
  /** 进位方式，默认四舍五入（与运费岛一致） */
  rounding?: Rounding;
  /**
   * 按订单号索引的**平台结算数据**（`ae_settle_lines` 的订单级聚合）：给了它就按"精准轨"算这一行，
   * 没有的行仍走预测轨。键 = 订单号，值至少含 `netIncomeCents`（分）。
   * 口径见 `OrderCostRow.preciseGrossProfit`（净收入已扣平台费，本层不再加减平台费与税）。
   */
  settleByOrder?: Record<string, { netIncomeCents: number; settleStatus?: string }> | null;
  /**
   * **件数真值**：结算明细的商品行（键 = `settleQtyKey(订单号, 商品ID)`，来自 `ae_settle_lines` 的
   * `item_id <> ''` 行）。只在"该 (订单,商品) 在结算表里恰好一行商品行"时才被采用 —— 多行意味着
   * 同一商品的不同 SKU，把合计给到每一行会让件数翻倍（宁可回落订单报表的逐行值）。
   * 不传 → 全部走订单报表；报表里也没有 → 按 1 件并标 `qty` 缺口。
   */
  settleQty?: Record<string, SettleQtyInfo> | null;
  /**
   * **税口径的可见默认**，只作用于**自己没说**的行（`taxPlatform` 为空串时）。
   *
   * 为什么需要它：采集帧里**没有**「平台是否代征代缴」这一列 → 逐行都是 `unknown` → 毛利恒为 `null`，
   * 采集订单就永远算不出钱。AE 的订单报表实测多为「平台已税」，故界面给一个**写在明处**的默认：
   * `'platform'` = 平台代征代缴（税记确定的 0）；缺省 `'unknown'` = 不知道（标缺口、不按 0 算）。
   * ⚠️ 它**不覆盖**行自己的声明：导入侧的 `taxPlatform` 原文永远优先。
   */
  taxDefault?: 'platform' | 'unknown';
  /**
   * 平台费（佣金 + 交易服务费 + 联盟佣金…）的**近似费率**，百分数（`9` = 9%）。
   *
   * 为什么必须估：实测结算明细（2026-09-28 导出）—— **待结算行的费用列全是 0**，
   * 平台在结算前不给费用，所以在途单的费用只能估。
   * 缺省 / <= 0 → 不扣，并把 `platformFeeMissing` 标真（**不按 0 算**）。
   *
   * 参考值（用户真实结算明细，剔除 55 条全额退款后 277 行实测）：
   * 佣金 5.50% + 交易服务费 2.23% + 联盟佣金 0.59% + 金币营销费 0.50% + 营销类 0.31% ≈ **9.14%**。
   */
  platformFeeRatePercent?: number;
}

const GAP_KEYS: OrderCostGap[] = ['revenue', 'fx', 'country', 'weight', 'rate', 'parcel', 'style', 'cost', 'tax', 'qty'];

/** 金额保留两位（分位四舍五入）。
 *  导出给 `picking.ts` 用同一份 —— 拣货单的「预估金额」与利润页的金额必须同一种进位，
 *  否则同一笔钱在两页上差一分，谁也说不清哪个对。 */
export function round2(n: number): number {
  return Math.round((Number(n) || 0) * 100) / 100;
}

/** 分 → 元；null / 非数 → null（**不要**折成 0：0 与"报表里没有"是两回事） */
function centsToYuan(cents: unknown): number | null {
  return typeof cents === 'number' && Number.isFinite(cents) ? round2(cents / 100) : null;
}

/** 成本字段（分）→ 正数；0 / 空 / 非数一律 null（0 是"没维护"，不是"零成本"）。
 *  导出给 `picking.ts` 共用 —— 两页对"这个数算不算有值"必须是同一套判据。 */
export function positiveCents(v: unknown): number | null {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? n : null;
}

/**
 * 日期原文 → `yyyy-mm-dd`；认不出返回 `''`。
 * 容错：`2026-9-1` / `2026/09/01` / `2026.09.01` 都归一；带时分秒的取日期部分。
 */
export function dateKey(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/** 统计维度：款（成本口径的天然维度）/ 目的国（运费口径的天然维度）/ 经营状态桶 */
export type CostGroupDim = 'style' | 'country' | 'bucket' | 'shop' | 'sku' | 'supplier';

export interface CostGroupRow {
  /** 分组键（款编码 / 国家原文 / 桶名 / 组合键 / 供应商 id）；未识别的用固定占位，**不丢行** */
  key: string;
  /** 展示名（仅当与 key 不同才给：供应商按 id 分组、显示名字）；缺省显示 key */
  label?: string;
  rows: number;
  /** 件数合计（拣货口径；与收入/成本同口径**只含非关闭单**） */
  pieces: number;
  /** 收入合计（元，**只含非关闭单**，与汇总口径一致） */
  revenue: number;
  /** 成本合计（元）= 运费 + 产品成本 */
  cost: number;
  /** 预测毛利合计（元） */
  gross: number;
  /** 该组里走精准轨的行数与精准毛利合计（元） */
  preciseRows: number;
  preciseGross: number;
  /** 该组里有缺口的行数（界面提示"这组的数还不全"） */
  gapRows: number;
}

/**
 * 按维度汇总逐行结果（**只统计非关闭单**，与 `revenueTotal`/`grossTotal` 同口径）。
 *
 * 为什么排除关闭单：实测某批订单 2/3 是关闭单，混进"按款/按国家"的合计会让每个组都虚高；
 * 关闭单要看就单看 `bucket` 维度那一组（`dim='bucket'` 会把三桶都列出来）。
 *
 * 排序按毛利倒序（最赚钱的在前）；**未识别款 / 缺国家/ 缺成本的行不会被丢掉**，
 * 而是各自成组 —— 丢掉它们会让"合计对不上"变成查不出的悬案。
 */
export function summarizeOrderCosts(
  rows: OrderCostRow[] | null | undefined,
  dim: CostGroupDim,
): CostGroupRow[] {
  const list = Array.isArray(rows) ? rows : [];
  const agg = new Map<string, CostGroupRow>();
  const keyOf = (r: OrderCostRow): string => {
    if (dim === 'style') return r.styleCode || '(未识别款)';
    if (dim === 'country') return r.country || '(缺国家)';
    if (dim === 'shop') return r.shop || '(未归属店铺)';
    if (dim === 'sku') {
      // SKU 粒度 = 款 × 色 × 码（D3 的「颜色+尺码」组合）。缺哪一段就把哪一段标出来 ——
      // 这正是本维度要回答的问题："色/码到底填得全不全"（拣货能不能做准取决于它）。
      // 键的拼法由 `skuKey` 单源给出（拣货单用同一份，两处键不一致就会"看起来少了一组"）。
      return skuKey(r);
    }
    if (dim === 'supplier') {
      // 按 **id** 分组（C2：关联用 ID），名字只作展示；没有 id 的（未识别款/未填厂家）单独一组
      return String(r.supplierId || 0);
    }
    return r.bucket;
  };
  for (const r of list) {
    const key = keyOf(r);
    const cur = agg.get(key) ?? {
      key,
      // 供应商维度：key 是 id，展示名另取（同 id 的名字一致，取首个即可）
      ...(dim === 'supplier'
        ? { label: list.find((x) => keyOf(x) === key)?.supplierName || '(未识别供应商)' }
        : {}),
      rows: 0,
      pieces: 0,
      revenue: 0,
      cost: 0,
      gross: 0,
      preciseRows: 0,
      preciseGross: 0,
      gapRows: 0,
    };
    cur.rows++;
    if (r.gaps.length) cur.gapRows++;
    if (r.tier === 'precise') {
      cur.preciseRows++;
      if (r.preciseGrossProfit !== null) cur.preciseGross = round2(cur.preciseGross + r.preciseGrossProfit);
    }
    // 与汇总同口径：关闭单不计入收入/成本/毛利/件数合计
    if (r.bucket !== 'closed') {
      cur.pieces += r.qty;
      if (r.revenue !== null) cur.revenue = round2(cur.revenue + r.revenue);
      if (r.total !== null) cur.cost = round2(cur.cost + r.total);
      if (r.grossProfit !== null) cur.gross = round2(cur.gross + r.grossProfit);
    }
    agg.set(key, cur);
  }
  return [...agg.values()].sort((a, b) => b.gross - a.gross || b.rows - a.rows);
}

/**
 * 按店铺汇总**营收**（记账的「按营收占比分摊」用它，RK-06：不新写一套收入 SQL）。
 *
 * 口径完全由 `computeOrderCosts` 决定（收入 = 订单金额；关闭/取消单不计入），
 * 本函数只做「按 `shopKey` 累加」这一件事 —— 统计页按店营收与记账分摊的权重因此天然一致。
 * 单位是**整数分**：权重直接进 `src/lib/ledger.ts` 的分摊引擎，避免再经元/分换算。
 *
 * `shopKey` 由宿主 `shippingRows` 用 `toNameKey` 算好（渲染层不做第二份归一）；
 * 空键 = 订单没写店铺，金额无法归属，单列 `missingShopCents` 交给调用方显式提示。
 */
export interface RevenueByShop {
  byShopKey: Record<string, number>;
  /** Σ 全部可计入营收的金额（= Σ byShopKey + missingShopCents） */
  totalCents: number;
  missingShopCents: number;
  /** 关闭/取消单被排除的行数（营收口径不含它们） */
  excludedClosedRows: number;
  /** 金额缺失、无法计入营收的行数（报表没金额 / 采集缺汇率） */
  missingRevenueRows: number;
}

export function summarizeRevenueByShop(
  orders: OrderCostInput['orders'] | null | undefined,
): RevenueByShop {
  const summary = computeOrderCosts({
    orders: Array.isArray(orders) ? orders : [],
    // 营收与运费/成本无关：不传运价表，逐行运费会标缺，但不进本函数的任何合计。
    rateTable: null,
  });
  const byShopKey: Record<string, number> = {};
  let totalCents = 0;
  let missingShopCents = 0;
  let excludedClosedRows = 0;
  let missingRevenueRows = 0;
  for (const r of summary.rows) {
    if (r.bucket === 'closed') {
      excludedClosedRows++;
      continue;
    }
    if (r.revenue === null) {
      missingRevenueRows++;
      continue;
    }
    const cents = Math.round(r.revenue * 100);
    totalCents += cents;
    if (!r.shopKey) {
      missingShopCents += cents;
      continue;
    }
    byShopKey[r.shopKey] = (byShopKey[r.shopKey] ?? 0) + cents;
  }
  return { byShopKey, totalCents, missingShopCents, excludedClosedRows, missingRevenueRows };
}

export interface CostTrendPoint {
  /** `yyyy-mm`（按月）或 `yyyy-mm-dd`（按日） */
  bucket: string;
  rows: number;
  revenue: number;
  cost: number;
  gross: number;
  /** 该桶里走精准轨的行数与精准毛利合计 */
  preciseRows: number;
  preciseGross: number;
}

/**
 * **时间趋势**（按月 / 按日）：把逐行结果按 `orderTime` 归档。
 *
 * 为什么要有它：岛上「利润统计」的独有内容就是"趋势"，而它一直没进内建页 —— 于是那两条视图
 * 无法退役（C9）。口径与汇总完全一致：**只统计非关闭单**（关闭单没有这笔收入），
 * 日期认不出的行**单独进 `(无日期)` 桶**（不丢行，也不硬塞进某个日期）。
 */
export function trendOf(
  rows: OrderCostRow[] | null | undefined,
  granularity: 'month' | 'day' = 'month',
): CostTrendPoint[] {
  const list = Array.isArray(rows) ? rows : [];
  const agg = new Map<string, CostTrendPoint>();
  for (const r of list) {
    if (r.bucket === 'closed') continue;
    const d = dateKey(r.orderTime);
    const bucket = d ? (granularity === 'day' ? d : d.slice(0, 7)) : '(无日期)';
    const cur = agg.get(bucket) ?? {
      bucket,
      rows: 0,
      revenue: 0,
      cost: 0,
      gross: 0,
      preciseRows: 0,
      preciseGross: 0,
    };
    cur.rows += 1;
    if (r.revenue !== null) cur.revenue = round2(cur.revenue + r.revenue);
    if (r.total !== null) cur.cost = round2(cur.cost + r.total);
    if (r.grossProfit !== null) cur.gross = round2(cur.gross + r.grossProfit);
    if (r.tier === 'precise') {
      cur.preciseRows += 1;
      if (r.preciseGrossProfit !== null) cur.preciseGross = round2(cur.preciseGross + r.preciseGrossProfit);
    }
    agg.set(bucket, cur);
  }
  // `(无日期)` 永远排最后（它不是时间点，塞进时间序列里会误导）
  return [...agg.values()].sort((a, b) => {
    if (a.bucket === '(无日期)') return 1;
    if (b.bucket === '(无日期)') return -1;
    return a.bucket < b.bucket ? -1 : 1;
  });
}

/** 运费拒算分类 → 缺口标识（口径来自 `quoteOrders`，本层不自己判运费能不能算） */
function gapOfReason(reason: string): OrderCostGap | null {
  if (reason === 'noCountry') return 'country';
  if (reason === 'noWeight') return 'weight';
  if (reason === 'unknownCountry' || reason === 'noPrice' || reason === 'refused') return 'rate';
  return null;
}

/** 订单行 × 成本 → 逐行运费/产品成本/合计 + 缺口；并给汇总 */
export function computeOrderCosts(input: OrderCostInput): OrderCostSummary {
  const orders = Array.isArray(input?.orders) ? input.orders : [];
  const table = input?.rateTable ?? null;

  const skuWeights = input?.skuWeights ?? {};
  /** 快照克重只在**是正数**时采用：0/NULL 都是"还没钉过"，不能当成"零克重"（那会把运费算成 0） */
  const snapshotWeight = (o: OrderCostInput['orders'][number] | null): number | null => {
    const v = Number(o?.weightG);
    return Number.isFinite(v) && v > 0 ? Math.round(v) : null;
  };
  const shippingRows: OrderShippingRow[] = orders.map((o) => {
    const ex = extractShipping(o?.rawFields ?? {});
    const weightG = snapshotWeight(o) ?? resolveWeightG(o, skuWeights);
    return {
      id: Number(o?.id) || 0,
      orderNo: String(o?.orderNo ?? ''),
      country: ex.country,
      itemId: ex.itemId,
      weightG,
    };
  });

  /** 件数先算一遍：包裹运费按件数摊到行，行循环里复用同一份（两处各解析一次必然漂开） */
  const qtyInfos = orders.map((o, i) => {
    const sr = shippingRows[i];
    return resolveQty(
      { orderNo: sr.orderNo, itemId: sr.itemId, rawFields: o?.rawFields, qty: o?.qty },
      input?.settleQty,
    );
  });

  const parcelTotalsInput = input?.parcelTotals ?? {};
  /** 有包裹的行 → 该行应摊到的运费（元；null = 该单还有包没填运费） */
  const parcelShipByIndex = new Map<number, number | null>();
  const indexesByOrder = new Map<string, number[]>();
  orders.forEach((o, i) => {
    const no = String(o?.orderNo ?? '');
    const pt = parcelTotalsInput[no];
    if (!no || !pt || !(Number(pt.count) > 0)) return;
    const arr = indexesByOrder.get(no) ?? [];
    arr.push(i);
    indexesByOrder.set(no, arr);
  });
  for (const [no, idxs] of indexesByOrder) {
    const totalCents = parcelTotalsInput[no]?.shipCents;
    if (totalCents === null || totalCents === undefined || !Number.isFinite(Number(totalCents))) {
      // 整单合计为 null：每一行都如实缺，**不拿部分和、也不回落估算**
      for (const i of idxs) parcelShipByIndex.set(i, null);
      continue;
    }
    const totalYuan = round2(Number(totalCents) / 100);
    const qtySum = idxs.reduce((s, i) => s + Math.max(1, qtyInfos[i].qty), 0);
    let acc = 0;
    idxs.forEach((i, k) => {
      // 末行吃残差（分位四舍五入后各行之和必须 == 整单合计，否则汇总对不上包裹总额）
      const share =
        k === idxs.length - 1
          ? round2(totalYuan - acc)
          : round2((totalYuan * Math.max(1, qtyInfos[i].qty)) / qtySum);
      acc = round2(acc + share);
      parcelShipByIndex.set(i, share === 0 ? 0 : share);
    });
  }

  // 运价表：优先**按订单日期逐行挑快照**（报价单会更新，历史订单的预测运费不能跟着变）；
  // 没有快照才退回"当前那一份"单表口径。**有包裹的单不参与** —— 运费已由包裹真值决定。
  const snaps = (Array.isArray(input?.rateSnapshots) ? input.rateSnapshots : []).filter(
    (s): s is RateSnapshot => !!s && !!s.table && !!s.effectiveFrom,
  );
  const singleUsable = !!table && Array.isArray(table.countries) && table.countries.length > 0;
  /** 这一行用哪张表（快照按日期挑；否则用单表） */
  const tableFor = (o: OrderCostInput['orders'][number]): RateTable | null => {
    if (snaps.length) return pickRateSnapshot(snaps, dateKey(o?.orderTime));
    return singleUsable ? (table as RateTable) : null;
  };
  const versionFor = (o: OrderCostInput['orders'][number]): string => {
    if (!snaps.length) return '';
    const d = dateKey(o?.orderTime);
    const sorted = [...snaps].sort((a, b) => (a.effectiveFrom < b.effectiveFrom ? -1 : 1));
    const hit = d ? [...sorted].reverse().find((x) => x.effectiveFrom <= d) : undefined;
    return (hit ?? (d ? sorted[0] : sorted[sorted.length - 1])).effectiveFrom;
  };

  /** 需要按运价表算的行（没有包裹的那些） */
  const rateIndexes = orders.map((_, i) => i).filter((i) => !parcelShipByIndex.has(i));

  const byId = new Map<number, OrderQuoteRow>();
  if (snaps.length) {
    // 按"选中的那份快照"分组，各组各调一次 quoteOrders —— 口径仍是同一份实现，不重算运费
    const groups = new Map<RateTable, number[]>();
    for (const i of rateIndexes) {
      const t = tableFor(orders[i]);
      if (!t) continue;
      const arr = groups.get(t) ?? [];
      arr.push(i);
      groups.set(t, arr);
    }
    for (const [t, idxs] of groups) {
      const sub = idxs.map((i) => shippingRows[i]);
      for (const q of quoteOrders(t, sub, { rounding: input?.rounding }).rows) byId.set(q.id, q);
    }
  } else if (singleUsable) {
    const sub = rateIndexes.map((i) => shippingRows[i]);
    for (const q of quoteOrders(table as RateTable, sub, { rounding: input?.rounding }).rows) {
      byId.set(q.id, q);
    }
  }

  /** 费率（>0 才算配了；否则整批不扣平台费） */
  const rateInput = Number(input?.platformFeeRatePercent);
  const feeRate = Number.isFinite(rateInput) && rateInput > 0 ? rateInput : 0;

  const gapCounts = Object.fromEntries(GAP_KEYS.map((k) => [k, 0])) as Record<
    OrderCostGap,
    number
  >;
  let ok = 0;
  let shippingTotal = 0;
  let productCostTotal = 0;
  let costTotal = 0;
  let revenueTotal = 0;
  let grossTotal = 0;
  let platformFeeTotal = 0;
  const bucketAgg = new Map<BizBucket, { bucket: BizBucket; rows: number; revenue: number; gross: number }>();
  for (const b of ['completed', 'intransit', 'closed', 'unknown'] as BizBucket[]) {
    bucketAgg.set(b, { bucket: b, rows: 0, revenue: 0, gross: 0 });
  }

  const rows: OrderCostRow[] = orders.map((o, i) => {
    const sr = shippingRows[i];
    const q = byId.get(sr.id);
    const styleCode = String(o?.styleCode ?? '');
    const gaps = new Set<OrderCostGap>();

    // 运费侧：**有包裹 = 用包裹真值**（按件数摊到行），否则由 quoteOrders 的结论决定。
    // 包裹缺运费时**不回落运价表**：用户已经在按包记账，拿估算盖上去会让"填没填"看不出来。
    const hasParcel = parcelShipByIndex.has(i);
    let shipping: number | null;
    let shippingSource: OrderCostRow['shippingSource'];
    let shippingReason = '';
    let rateVersion = '';
    if (hasParcel) {
      shipping = parcelShipByIndex.get(i) ?? null;
      shippingSource = 'parcel';
      if (shipping === null) {
        shippingReason = 'parcelShipMissing';
        gaps.add('parcel');
      }
    } else {
      const rowTable = tableFor(o);
      if (!rowTable) gaps.add('rate');
      shipping = q && q.ok ? q.fee : null;
      shippingSource = shipping !== null ? 'rate' : 'none';
      if (q && !q.ok) {
        shippingReason = q.reasonClass;
        const g = gapOfReason(q.reasonClass);
        if (g) gaps.add(g);
      }
      rateVersion = versionFor(o);
    }

    // 成本侧（C2 两字段）：**实付真值 > 进价预估 > 缺**。次序不能反：
    // actual 是"这单实际付了多少"，estimate 是"归类时这款大概多少"——真值必须赢。
    // 0 一律当"没维护/还没落账"（按零成本算会让利润凭空变大）。
    if (!styleCode) gaps.add('style');
    const actualCents = positiveCents(o?.actualCostCents);
    const estimateCents = positiveCents(o?.costCents);
    const usedCents = actualCents ?? estimateCents;
    const costSource: OrderCostRow['costSource'] =
      actualCents !== null ? 'snapshot' : estimateCents !== null ? 'estimate' : 'none';
    const productCost = usedCents === null ? null : round2(usedCents / 100);
    if (productCost === null) gaps.add('cost');

    // 件数：口径单源在 `resolveQty`（结算商品行真值 → 报表块内 `商品数量` → 按 1 件并标缺）
    const { qty, qtySource } = qtyInfos[i];
    if (qtySource === 'assumed') gaps.add('qty');

    // 收入侧：订单金额（买家视角总额，含买家付的运费）
    const revenue = centsToYuan(o?.amountCents);
    if (revenue === null) {
      // **拆分两种成因**（补法不同，见 `OrderCostGap` 上 `fx` 的说明）：
      //   · `collect` 通道的金额只有一个来源（`upsertOrderBatch`：`rate ? 折算 : null`），
      //     本币恒 1:1、外币有汇率即非 null ⇒ 金额为 null **必然**是缺汇率；
      //   · `import` 通道的金额来自报表本身，null = 报表里就没有这一列值（无处可补）。
      // ⚠️ 判据必须挂在 `source` 上（不是"猜"）：导入单没有汇率概念，误判成缺汇率会指错方向。
      gaps.add(o?.source === 'collect' ? 'fx' : 'revenue');
    }

    // 税：平台代征代缴时是**确定的 0**（平台已代收代缴，不是我们的成本）；
    //     明确自缴时 = 增值税 + DDP；**不知道谁承担 → null 并标缺**（不按 0 算）。
    //     行自己没说（采集帧没有该列）时才用**界面上的可见默认**（`taxDefault`，见入参说明）。
    const declared = taxBearerOf(o?.taxPlatform);
    const bearer = declared === 'unknown' && input?.taxDefault === 'platform' ? 'platform' : declared;
    let taxCost: number | null;
    if (bearer === 'platform') {
      taxCost = 0;
    } else if (bearer === 'self') {
      taxCost = round2((centsToYuan(o?.vatCents) ?? 0) + (centsToYuan(o?.ddpCents) ?? 0));
    } else {
      taxCost = null;
      gaps.add('tax');
    }

    const total = shipping === null || productCost === null ? null : round2(shipping + productCost);
    // 平台费：只在**配了费率**时估（结算前平台不给费用）；没配就不扣、由全局标志说明
    const platformFee =
      feeRate > 0 && revenue !== null ? round2((revenue * feeRate) / 100) : null;
    const grossProfit =
      revenue === null || total === null || taxCost === null
        ? null
        : round2(revenue - total - taxCost - (platformFee ?? 0));
    const bucket = bucketOfStatus(o?.bizStatus);

    // 精准轨：有平台结算数据就用它（净收入已扣平台费 → 不再估平台费、不再另外扣税）
    const settled = input?.settleByOrder?.[String(o?.orderNo ?? '')] ?? null;
    const preciseNetIncome = settled ? centsToYuan(settled.netIncomeCents) : null;
    const tier: 'precise' | 'forecast' = preciseNetIncome === null ? 'forecast' : 'precise';
    const preciseGrossProfit =
      preciseNetIncome === null || total === null ? null : round2(preciseNetIncome - total);

    if (total !== null) ok++;
    const agg = bucketAgg.get(bucket);
    if (agg) {
      agg.rows++;
      if (revenue !== null) agg.revenue = round2(agg.revenue + revenue);
      if (grossProfit !== null) agg.gross = round2(agg.gross + grossProfit);
    }
    // ⚠️ 下面这几个合计**必须与利润同口径（只含非关闭单）**。
    //    原先运费/成本/平台费是**含**关闭单的，而收入/毛利不含 —— 并排显示在同一张指标条上时，
    //    会出现"成本合计比收入合计还大"却看不出原因（关闭单有成本、没收入）。
    //    2026-10-03 统一：关闭单一律不进任何合计，它单列一桶（见 bucketTotals）。
    if (bucket !== 'closed') {
      if (shipping !== null) shippingTotal = round2(shippingTotal + shipping);
      if (productCost !== null) productCostTotal = round2(productCostTotal + productCost);
      if (platformFee !== null) platformFeeTotal = round2(platformFeeTotal + platformFee);
      if (revenue !== null) revenueTotal = round2(revenueTotal + revenue);
      if (grossProfit !== null) grossTotal = round2(grossTotal + grossProfit);
      if (total !== null) costTotal = round2(costTotal + total);
    }
    for (const g of gaps) gapCounts[g]++;

    return {
      id: sr.id,
      orderNo: sr.orderNo,
      source: o?.source === 'collect' ? 'collect' : 'import',
      shop: String(o?.shop ?? ''),
      shopKey: String(o?.shopKey ?? o?.shop ?? ''),
      orderTime: String(o?.orderTime ?? ''),
      styleCode,
      styleColor: String(o?.styleColor ?? ''),
      color: String(o?.color ?? ''),
      size: String(o?.size ?? ''),
      supplierId: Number(o?.supplierId) || 0,
      supplierName: String(o?.supplierName ?? ''),
      itemId: sr.itemId,
      qty,
      qtySource,
      country: sr.country,
      weightG: sr.weightG,
      weightSource: snapshotWeight(o) !== null ? 'snapshot' : sr.weightG !== null ? 'lookup' : 'none',
      shipping,
      shippingSource,
      shippingReason,
      rateVersion,
      productCost,
      costSource,
      total,
      platformFee,
      tier,
      preciseNetIncome,
      preciseGrossProfit,
      bucket,
      revenue,
      taxCost,
      grossProfit,
      gaps: GAP_KEYS.filter((k) => gaps.has(k)),
    };
  });

  const sourceCounts: Record<OrderSource, number> = { import: 0, collect: 0 };
  for (const r of rows) sourceCounts[r.source] += 1;

  return {
    rows,
    total: rows.length,
    ok,
    sourceCounts,
    shippingTotal,
    productCostTotal,
    costTotal,
    revenueTotal,
    grossTotal,
    platformFeeTotal,
    platformFeeMissing: feeRate <= 0,
    bucketTotals: [...bucketAgg.values()].filter((b) => b.rows > 0),
    gapCounts,
  };
}