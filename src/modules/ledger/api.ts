// 「记账」模块的数据入口（视图与组件只依赖本文件，不直接碰 `window.electronAPI`）。
//
// `ipc.*` 一律返回 `ApiResult`，而界面关心"拿到数据或抛异常"，故这里统一拆包。
// 保留主进程原始错误文案：它们本来就是给人看的（"已存在同名相关人"、"该条目已被结算单 #12 占用…"）。
import * as ipc from '@/core/services/ipc';
import type { ApiResult } from '@/core/services/ipc';
import type {
  LedgerCategoryRow,
  LedgerEligibleShops,
  LedgerEntryDetail,
  LedgerEntryFilter,
  LedgerEntryInput,
  LedgerEntryRow,
  LedgerImportEntryInput,
  LedgerPartyKind,
  LedgerPartyLedgerRow,
  LedgerPartyRow,
  LedgerRuleRow,
  LedgerSettlementRow,
  LedgerBasis,
  LedgerKind,
  LedgerSummary,
  LedgerRepatchMode,
  LedgerRepatchPreview,
  LedgerRepatchResult,
  LedgerShopBreakdown,
  LedgerExportInput,
  LedgerNameResolveResult,
  LedgerTemplateSheetInput,
  ShopListItem,
  UnifiedOrderRow,
} from '@/types';

function unwrap<T>(r: ApiResult<T>): T {
  if (!r.success) throw new Error(r.error || '操作失败');
  return r.data as T;
}

export async function ensure(): Promise<void> {
  unwrap(await ipc.ledgerDbEnsure());
}

export async function eligibleShops(period: string): Promise<LedgerEligibleShops> {
  return unwrap(await ipc.ledgerEligibleShops(period));
}

export async function categories(
  kind?: LedgerKind,
  includeArchived = false
): Promise<LedgerCategoryRow[]> {
  return unwrap(await ipc.ledgerCategoryList({ kind, includeArchived }));
}

export async function categoryUpsert(payload: {
  id?: number;
  kind?: LedgerKind;
  name?: string;
  sort?: number;
  archived?: boolean;
}): Promise<{ id: number; created: boolean }> {
  return unwrap(await ipc.ledgerCategoryUpsert(payload));
}

export async function rules(): Promise<LedgerRuleRow[]> {
  return unwrap(await ipc.ledgerRuleList());
}

export async function ruleUpsert(payload: {
  id?: number;
  name?: string;
  basis?: LedgerBasis;
  shopIds?: number[];
  ratios?: number[];
  note?: string;
}): Promise<{ id: number; created: boolean }> {
  return unwrap(await ipc.ledgerRuleUpsert(payload));
}

/**
 * 某月的订单行（营收占比取数）。
 *
 * 店名归一键 `shopKey` 由宿主算好（`toNameKey`），营收口径再由
 * `ledgerRevenue.revenueByShopId` 复用统计页的 `computeOrderCosts` —— RK-06。
 */
export async function monthOrderRows(period: string, limit = 2000): Promise<UnifiedOrderRow[]> {
  return unwrap(await ipc.orderShippingRows({ period, limit }));
}

export async function entries(filter: LedgerEntryFilter): Promise<LedgerEntryRow[]> {
  return unwrap(await ipc.ledgerEntryList(filter));
}

export async function entryDetail(id: number): Promise<LedgerEntryDetail | null> {
  return unwrap(await ipc.ledgerEntryGet(id));
}

export async function entryUpsert(
  payload: LedgerEntryInput
): Promise<{ id: number; created: boolean; allocations: number; settledLocked: boolean }> {
  return unwrap(await ipc.ledgerEntryUpsert(payload));
}

export async function entryVoid(id: number, reason: string): Promise<{ id: number; voided: boolean }> {
  return unwrap(await ipc.ledgerEntryVoid(id, reason));
}

/** 恢复作废条目（不删行、不改金额：分摊行本来就保留着） */
export async function entryRestore(id: number): Promise<{ id: number; restored: boolean }> {
  return unwrap(await ipc.ledgerEntryRestore(id));
}

/**
 * 批量作废 —— 「撤销本次导入」的唯一实现。
 * 整批一个事务：要么这批全撤，要么一条都不撤（成功一半比全失败更难收拾）。
 */
export async function entriesVoid(ids: number[], reason: string): Promise<{ voided: number; ids: number[] }> {
  return unwrap(await ipc.ledgerEntriesVoid(ids, reason));
}

export async function summary(period: string): Promise<LedgerSummary> {
  return unwrap(await ipc.ledgerSummary({ period }));
}

/** 全期间汇总：往来账簿是累计余额（不是流量），对账恒等式必须用累计口径。 */
export async function summaryAll(): Promise<LedgerSummary> {
  return unwrap(await ipc.ledgerSummary({ period: '' }));
}

export async function partyLedger(payload: {
  includeArchived?: boolean;
  partyId?: number;
} = {}): Promise<LedgerPartyLedgerRow[]> {
  return unwrap(await ipc.ledgerPartyLedger(payload));
}

export async function settlements(partyId?: number): Promise<LedgerSettlementRow[]> {
  return unwrap(await ipc.ledgerSettleList(partyId ? { partyId } : undefined));
}

/** 结算金额由主进程按勾选条目求和 —— 这里刻意不提供 amountCents 参数 */
export async function settleCreate(payload: {
  partyId: number;
  settleDate: string;
  /** `offset` = 互抵结清：一张单同时挂收入与支出条目，只记净资金流 */
  direction: 'pay' | 'receive' | 'offset';
  entryIds: number[];
  method?: string;
  note?: string;
}): Promise<{ id: number; amountCents: number; entryCount: number; cashCents: number }> {
  return unwrap(await ipc.ledgerSettleCreate(payload));
}

export async function settleVoid(id: number, reason: string): Promise<{ id: number; voided: boolean }> {
  return unwrap(await ipc.ledgerSettleVoid(id, reason));
}

/** 批量变更相关人的预演（结算状态 / 涉及结算单 / 原人余额影响） */
export async function repatchPreview(entryIds: number[]): Promise<LedgerRepatchPreview> {
  return unwrap(await ipc.ledgerEntryRepatchPreview({ entryIds }));
}

/** 批量变更相关人（三路） */
export async function repatch(payload: {
  entryIds: number[];
  toPartyId: number;
  mode: LedgerRepatchMode;
  reason?: string;
}): Promise<LedgerRepatchResult> {
  return unwrap(await ipc.ledgerEntryRepatch(payload));
}

/** 单店取数（结算进度不影响这里的任何数） */
export async function shopBreakdown(payload: {
  shopId: number;
  period?: string;
  from?: string;
  to?: string;
}): Promise<LedgerShopBreakdown> {
  return unwrap(await ipc.ledgerShopBreakdown(payload));
}

/**
 * 明细导出 xlsx（行文案与合计由本模块算好传入，主进程只画表存盘）。
 * 用户点「取消」返回 `null` —— 取消不是失败，不该弹错误提示。
 */
export async function exportExcel(
  payload: LedgerExportInput
): Promise<{ filePath: string; rows: number } | null> {
  const r = await ipc.ledgerExportExcel(payload);
  if (!r.success) {
    if (r.error === '__canceled__') return null;
    throw new Error(r.error || '导出失败');
  }
  return r.data as { filePath: string; rows: number };
}

// ---------------------------------------------------------------------------
// Excel 批量导入
// ---------------------------------------------------------------------------

/**
 * 文件里的名字 → 库里身份。
 *
 * 归一（什么算同一个名字）与"同名是不是同一家店"都在主进程判 —— 渲染层没有 `toNameKey`，
 * 抄一份就是第二实现，两份口径迟早分叉（本项目已因店名/色名的双口径踩过三次）。
 */
export async function nameResolve(payload: {
  party?: string[];
  category?: string[];
  shop?: string[];
}): Promise<LedgerNameResolveResult> {
  return unwrap(await ipc.ledgerNameResolve(payload));
}

/**
 * 整批新增（**全批一个事务**：任一行不合法就整批回滚，错误文案已带「第 N 行：」）。
 * 这里刻意不提供"部分成功"的语义 —— 半批落库会让用户既不知道哪些进了、也不敢再导一遍。
 *
 * `partyId` / `categoryId` 为 0 的行带上 `partyName` / `categoryName`：主进程在同一事务里
 * 找或建（导入自动建不存在的相关人与科目），返回它实际新建了哪些名字。
 */
export async function batchCreate(
  entries: LedgerImportEntryInput[]
): Promise<{
  created: number;
  ids: number[];
  allocations: number;
  createdParties: string[];
  createdCategories: string[];
}> {
  return unwrap(await ipc.ledgerEntryBatchCreate({ entries }));
}

/**
 * 下载导入模板（三张表的内容由 `src/lib/ledgerImport.ts` 生成，与解析器同一份列定义）。
 * 用户点「取消」返回 `null` —— 取消不是失败。
 */
export async function importTemplate(payload: {
  sheets: LedgerTemplateSheetInput[];
  defaultName: string;
}): Promise<{ filePath: string; sheets: number } | null> {
  const r = await ipc.ledgerImportTemplate(payload);
  if (!r.success) {
    if (r.error === '__canceled__') return null;
    throw new Error(r.error || '模板下载失败');
  }
  return r.data as { filePath: string; sheets: number };
}

export async function parties(includeArchived = false): Promise<LedgerPartyRow[]> {
  return unwrap(await ipc.ledgerPartyList({ includeArchived }));
}

export async function partyUpsert(payload: {
  id?: number;
  name?: string;
  kind?: LedgerPartyKind;
  phone?: string;
  note?: string;
  archived?: boolean;
}): Promise<{ id: number; created: boolean }> {
  return unwrap(await ipc.ledgerPartyUpsert(payload));
}

export async function partyMerge(payload: {
  fromId: number;
  toId: number;
  note?: string;
}): Promise<{ fromId: number; toId: number; movedEntries: number; transferredCents: number }> {
  return unwrap(await ipc.ledgerPartyMerge(payload));
}

// 店铺列表来自店铺域（`sk_shops` 的唯一读写处），记账只读不改。
// 记账条目的店铺一律存 `shop_id`，店名只用于展示 —— 改名不影响历史归属。
export async function shops(): Promise<ShopListItem[]> {
  const r = unwrap(await ipc.shopList({ limit: 500 }));
  return r.rows;
}

export type { LedgerBasis };
