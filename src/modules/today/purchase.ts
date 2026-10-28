// 「拿货」域在渲染层的**薄封装**：把宿主的 `purchase*` 通道收成带类型的函数，
// 再加几个纯函数（分/元换算、对账时间窗）。
//
// ⚠️ **本文件不含任何业务算法**。金额、缺口、对账差额、店铺分摊全在 `electron/purchase-db.ts`
//    （主进程）算 —— 界面只做展示与"元 ↔ 分"这一层换算。理由与拣货/算钱一致：
//    同一件事两处摆，迟早两套口径（`orderCost.ts` 曾经同屏并列两个不同作用域的合计，见 MEMORY）。
//
// 为什么不用 `src/core/services/ipc.ts` 里的包装函数：那里只导出了 `purchaseSupplierList/Create/...`
// 四个（供应商），其余通道挂在 `ipc` 对象上。这里补齐，调用点读起来是 `listOrders()` 而不是
// `ipc.purchaseOrderList({})`，且失败一律抛错（`success:false` 的 error 文案比"静默空数组"有用）。

import { ipc, type ApiResult } from '@/core/services/ipc';
import { localDayKey } from '@/lib/localDay';
import type {
  IgnoreRow,
  OrderCoveragePayload,
  OutstandingRow,
  Payment,
  PurchaseItem,
  PurchaseOrder,
  ReconciliationRow,
  ShopAllocationDetailRow,
  ShopAllocationRow,
  StyleColorOptionRow,
  Supplier,
} from '@/types';

/** 取单个值：失败抛错 */
async function need<T>(p: Promise<ApiResult<T>>): Promise<T> {
  const r = await p;
  if (!r.success) throw new Error(r.error || '操作失败');
  return r.data as T;
}

/** 取列表：失败抛错；`data` 缺失当空列表（列表通道建表前会返回 `{success:true}` 无 data） */
async function rows<T>(p: Promise<ApiResult<T[]>>): Promise<T[]> {
  const r = await p;
  if (!r.success) throw new Error(r.error || '读取失败');
  return r.data ?? [];
}

// ---- 建表 / 厂商（只读：维护在「货与成本 › 供应商」）----

export function ensureSchema(): Promise<unknown> {
  return need(ipc.purchaseDbEnsure());
}

export function listSuppliers(): Promise<Supplier[]> {
  return rows(ipc.purchaseSupplierList());
}

// ---- 拿货单 ----

/**
 * 明细行**输入**形状：不收 `amountCents`。
 *
 * 金额由主进程按同一公式重算落库（`purchase-db.computeTotal` = Σ qty×priceCents），
 * 界面这边只是把 qty×price 也算一遍好上线（`toWireItems`）—— 界面不定义口径，只是复述。
 */
export type PurchaseItemInput = Omit<PurchaseItem, 'id' | 'amountCents'>;

function toWireItems(items: PurchaseItemInput[]): PurchaseItem[] {
  return items.map((it) => ({
    ...it,
    amountCents:
      Math.max(0, Math.round(Number(it.qty) || 0)) * Math.max(0, Math.round(Number(it.priceCents) || 0)),
  }));
}

export function listOrders(): Promise<PurchaseOrder[]> {
  return rows(ipc.purchaseOrderList());
}

export function getOrder(id: number): Promise<PurchaseOrder> {
  return need(ipc.purchaseOrderGet({ id }));
}

export function createOrder(payload: {
  supplierId: number;
  bizDate: string;
  items?: PurchaseItemInput[];
}): Promise<{ id: number }> {
  const { items, ...rest } = payload;
  return need(
    ipc.purchaseOrderCreate({
      ...rest,
      ...(items ? { items: toWireItems(items) } : {}),
    })
  );
}

export function updateOrder(payload: {
  id: number;
  bizDate?: string;
  items?: PurchaseItemInput[];
}): Promise<unknown> {
  const { items, ...rest } = payload;
  return need(
    ipc.purchaseOrderUpdate({
      ...rest,
      ...(items ? { items: toWireItems(items) } : {}),
    })
  );
}

export function submitOrder(id: number): Promise<unknown> {
  return need(ipc.purchaseOrderSubmit({ id }));
}

export function deleteOrder(id: number): Promise<unknown> {
  return need(ipc.purchaseOrderDelete({ id }));
}

// ---- 付款 ----

export function listPayments(filter?: {
  supplierId?: number;
  from?: string;
  to?: string;
}): Promise<Payment[]> {
  return rows(ipc.purchasePaymentList(filter));
}

export function addPayment(payload: {
  supplierId: number;
  payDate: string;
  type: 'payment' | 'refund';
  amountCents: number;
  method?: string;
  note?: string;
}): Promise<{ id: number }> {
  return need(ipc.purchasePaymentAdd(payload));
}

export function deletePayment(id: number): Promise<unknown> {
  return need(ipc.purchasePaymentDelete({ id }));
}

// ---- 对账 / 店铺分摊 ----

export function reconciliation(win?: { from?: string; to?: string }): Promise<ReconciliationRow[]> {
  return rows(ipc.purchaseReconciliation(win));
}

export function shopAllocation(win?: { from?: string; to?: string }): Promise<ShopAllocationRow[]> {
  return rows(ipc.purchaseShopAllocation(win));
}

export function shopAllocationDetail(payload: {
  shop: string;
  from?: string;
  to?: string;
}): Promise<ShopAllocationDetailRow[]> {
  return rows(ipc.purchaseShopAllocationDetail(payload));
}

// ---- 待拿货缺口 / 忽略清单 / 单价记忆 ----

export function outstanding(): Promise<OutstandingRow[]> {
  return rows(ipc.purchaseOutstanding());
}

/**
 * **逐行覆盖度**（2026-10-22）：未发货订单每一行「要几件 / 已被拿货单覆盖几件」+ 无归属台账。
 *
 * 与 `outstanding()` 的分工，别混：
 *   · `outstanding()` = 「还缺什么」（**缺为 0 的行不返回**）—— 用来开拿货单；
 *   · 本函数 = 「这一行的货到了没有」（**齐了照样返回**）—— 用来判"哪张单可以发货"。
 * 拿 `outstanding()` 判"齐了"就是 2026-10-17 那次事故的同一个坑：拿齐的行整个消失，
 * 于是"齐了"永远无从确认（见 `TakenRow` 的注释）。
 *
 * 失败抛错：这是「按单核对」整块的数据源，取不到就该让那一块说"取数失败"，
 * 而不是显示"0 单可以发货"（那是**假结论**，用户会以为货真的没齐）。
 */
export function coverage(): Promise<OrderCoveragePayload> {
  return need(ipc.purchaseOrderCoverage());
}

export function listIgnores(): Promise<IgnoreRow[]> {
  return rows(ipc.purchaseIgnoreList());
}

export function addIgnore(payload: { styleCode: string; color?: string; reason?: string }): Promise<unknown> {
  return need(ipc.purchaseIgnoreAdd(payload));
}

export function removeIgnore(payload: { styleCode: string; color?: string }): Promise<unknown> {
  return need(ipc.purchaseIgnoreRemove(payload));
}

/** 同厂商同款色的最近一次单价（分）；查不到返回 0 */
export async function priceHistory(payload: {
  supplierId?: number;
  styleCode: string;
  color?: string;
}): Promise<number> {
  const d = await need(ipc.purchasePriceHistory({ supplierId: 0, ...payload }));
  return Number(d?.priceCents) || 0;
}

/** 导出拿货单 xlsx（主进程生成、款色图嵌入）。用户取消返回 `null`。 */
export async function exportOrderXlsx(payload: {
  items: PurchaseItem[];
  defaultName?: string;
}): Promise<{ filePath: string } | null> {
  const r = await ipc.purchaseExportExcel(payload);
  if (r.success) return r.data ?? null;
  if (r.error === '__canceled__') return null;
  throw new Error(r.error || '导出失败');
}

/**
 * 编辑器行图：按「款编码 + 款色 + 尺码」批量取本地图路径（顺序与入参一致，未命中为 null）。
 * `size` 是取图键的一部分 —— 同一款下每个订单商品各有各的图，漏传它会让同款所有行显示成同一张。
 */
export async function styleImages(payload: {
  items: { styleCode: string; color: string; size?: string; styleColorId?: number }[];
}): Promise<(string | null)[]> {
  const d = await need(ipc.purchaseStyleImages(payload));
  return d?.paths ?? [];
}

/**
 * 按款编码批量取该款**真实存在**的色行（`{ [款编码大写]: 色行[] }`）。
 *
 * 用途：历史拿货明细只存了色名快照（且是占位「未分类」），色行改名后两边对不上 ——
 * 修的时候只能在"该款真实有的色"里选一个，界面上现编名字只会再造一批对不上的标签。
 */
export async function styleColorOptions(
  styleCodes: string[]
): Promise<Record<string, StyleColorOptionRow[]>> {
  const d = await need(ipc.purchaseStyleColors({ styleCodes }));
  return d ?? {};
}

// ---- 纯函数：元 ↔ 分 与时间窗 ----
/** 元 → 分（非有限数按 0，负数归零）——与主进程 `num()` 同口径 */
export function yuanToCents(v: unknown): number {
  const n = Number(v);
  const yuan = Number.isFinite(n) ? n : 0;
  return Math.max(0, Math.round(yuan * 100));
}

/** 分 → 元（数字，供 input 回填） */
export function centsToYuan(cents: unknown): number {
  const n = Number(cents);
  return (Number.isFinite(n) ? n : 0) / 100;
}

/** 分 → 显示用两位小数字符串（**不带 ¥** —— 列头已写「(元)」） */
export function money(cents: unknown): string {
  return centsToYuan(cents).toFixed(2);
}

/** 本地日期 yyyy-MM-dd —— 实现收敛在 `@/lib/localDay`（**不可用 `toISOString`**：会按 UTC 偏移串天） */
export function localDay(d = new Date()): string {
  return localDayKey(d);
}

export type ReconRange = 'all' | 'day' | 'month' | 'year' | 'custom';

export const RECON_RANGES: { id: ReconRange; label: string }[] = [
  { id: 'all', label: '全部' },
  { id: 'day', label: '今天' },
  { id: 'month', label: '本月' },
  { id: 'year', label: '本年' },
  { id: 'custom', label: '自定义' },
];

/**
 * 时间窗 → `{from,to}`（自定义未填时该端为 undefined = 不设边界）。
 * 与 `purchase-db.reconciliation(from,to)` 的语义一致（闭区间，缺省为全部）。
 */
export function windowOf(range: ReconRange, customFrom = '', customTo = ''): { from?: string; to?: string } {
  const p = (x: number): string => String(x).padStart(2, '0');
  if (range === 'day') {
    const t = localDay();
    return { from: t, to: t };
  }
  if (range === 'month') {
    const d = new Date();
    const y = d.getFullYear();
    const m = d.getMonth() + 1;
    const last = new Date(y, m, 0).getDate();
    return { from: `${y}-${p(m)}-01`, to: `${y}-${p(m)}-${p(last)}` };
  }
  if (range === 'year') {
    const y = new Date().getFullYear();
    return { from: `${y}-01-01`, to: `${y}-12-31` };
  }
  if (range === 'custom') return { from: customFrom || undefined, to: customTo || undefined };
  return {};
}

/**
 * 切到「自定义」时预填当月区间（避免空区间让人以为"这个窗里没数据"）。
 * ⚠️ **返回新值**而不是原地改传进来的字符串 —— 字符串是值类型，原地赋值出不去
 *    （初版就写成了原地改，界面上永远不预填）。
 */
export function defaultCustomRange(): { from: string; to: string } {
  const d = new Date();
  const y = d.getFullYear();
  const m = d.getMonth() + 1;
  const last = new Date(y, m, 0).getDate();
  const p = (x: number): string => String(x).padStart(2, '0');
  return { from: `${y}-${p(m)}-01`, to: `${y}-${p(m)}-${p(last)}` };
}

/** 时间窗的一句话（对账页头显示"当前是哪个窗"） */
export function rangeLabel(range: ReconRange, customFrom = '', customTo = ''): string {
  if (range === 'custom') {
    if (!customFrom && !customTo) return '自定义（未设边界）';
    return `${customFrom || '…'} ~ ${customTo || '…'}`;
  }
  return (RECON_RANGES.find((x) => x.id === range) ?? RECON_RANGES[0]!).label;
}

/** 缺口行的稳定键（款编码 + 款色 + 尺码 —— 与 `outstanding()` 的粒度一致） */
export function gapKey(r: Pick<OutstandingRow, 'styleCode' | 'color' | 'size'>): string {
  return `${r.styleCode}|${r.color}|${r.size}`;
}

/** 拿货/对账侧的汇总（页签徽标 / 总览 / 流程卡用；形状与 `ShippingSummary.purchase` 对齐） */
export interface PurchaseCounts {
  orders: number;
  draft: number;
  gap: number;
  ignored: number;
  /**
   * 全部窗口的欠款合计（分）= Σ 各厂家「拿货 −（已付 − 退款)」。
   * **保留符号不改判**：负数说明付多了，那是真信息，不是 0。
   * 它只用于"对账那一步做完没有"这一个判断；对账页里的四个金额由对账页自己按当前窗口取。
   */
  balance: number;
}

/**
 * 汇总取数：**失败按 0 处理**，不抛。
 *
 * 为什么与上面的 `listXxx()` 不同：那几条是面板自己那一屏的数据，取不到就该报错；
 * 而这是"页签上挂个徽标 + 流程卡判对账那一步做没做完"用的 —— 为它让整页汇总挂掉
 * （连带总览卡全空）不值得。拿不到就显示 0，用户点进页签自然会看到真正的错误。
 */
/**
 * 待拿**款色**数（与卡片同一粒度）。
 *
 * 入参是 `purchase-outstanding` 的款色码行（`missing > 0` 才返回、忽略的整款色不返）。
 * 两件事必须在这里做掉，否则徽标与卡片说的不是一回事：
 *   · **按 (款编码, 款色) 去重** —— 卡片把同一款色的多码折成一行；
 *   · **未识别款不计** —— 它没有款色身份，卡片上也不单列（卡片算进"款色数"的只有能拿的）。
 *
 * ⚠️ 残留差异（已知，不在这里藏）：清单（卡片）还有 30 天窗与"已终结订单不拣"两层过滤，
 *    `outstanding()` 是全库订单 ⇒ 有很旧/已发货但状态没终结的订单时徽标会偏大。
 *    彻底同源要共享清单取数（跨组件重构），代价远大于这个徽标的价值 —— 先对齐粒度与术语。
 */
function countColors(rows: OutstandingRow[]): number {
  const set = new Set<string>();
  for (const r of rows) {
    if (!r.styleCode) continue;
    set.add(`${r.styleCode}|${r.color}`);
  }
  return set.size;
}

export async function purchaseCounts(): Promise<PurchaseCounts> {
  const [po, og, ig, rc] = await Promise.all([
    ipc.purchaseOrderList(),
    ipc.purchaseOutstanding(),
    ipc.purchaseIgnoreList(),
    ipc.purchaseReconciliation({}),
  ]);
  const orders = po.success ? po.data ?? [] : [];
  const recon = rc.success ? rc.data ?? [] : [];
  return {
    orders: orders.length,
    draft: orders.filter((o) => o.status !== 'submitted').length,
    // ⚠️ 按**款色**去重计数（2026-10-17 评审 P1）：`outstanding()` 返的是款色**码**行 ——
    //    同款同色两个码是两行，拿行数当"款色数" ⇒ 徽标说 2 款色、卡片（按款色折叠）说 1 款色。
    //    同一个词不能指两个东西：徽标与卡片必须同一粒度。
    gap: og.success ? countColors(og.data ?? []) : 0,
    ignored: ig.success ? (ig.data ?? []).length : 0,
    balance: recon.reduce((a, r) => a + (Number(r.balanceCents) || 0), 0),
  };
}
