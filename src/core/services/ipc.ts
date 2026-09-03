// 类型安全地封装 preload 暴露的 window.electronAPI。
//
// 所有模块都应通过本文件访问主进程能力，禁止在业务代码里直接访问
// window.electronAPI —— 这样既统一了类型，也方便后续替换/ mock / 测试。

import type { NetRequestPayload, NetRequestResult } from '@/core/network/types';
import type {
  OrderImageRecord,
  OrderRecord,
  OrderQueueRow,
  OrderQueueEnqueueRow,
  OrderQueueStats,
  OrderQueueStatus,
  GroupStat,
  ImageDataUrl,
  ExportExcelResult,
  StyleRecord,
  OrderUpdateInput,
  OrderUpdateStatusInput,
  OrderStatus,
  StyleImportItem,
  StyleImportResult,
  BackupSummary,
  Supplier,
  PurchaseOrder,
  PurchaseItem,
  Payment,
  ReconciliationRow,
  OutstandingRow,
  IgnoreRow,
  PurchaseSourceRow,
  ShopAllocationRow,
  ShopAllocationDetailRow,
} from '@/types';

export interface ApiResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

export interface ExcelFilePayload {
  filePath: string;
  data: ArrayBuffer;
}

export interface TemplateFilePayload {
  filePath: string;
  content: string;
}

export interface ElectronApi {
  selectExcel(): Promise<ApiResult<ExcelFilePayload>>;
  importExcelByPath(filePath: string): Promise<ApiResult<ExcelFilePayload>>;
  selectTemplate(): Promise<ApiResult<TemplateFilePayload>>;
  saveTemplate(filePath: string, content: string): Promise<ApiResult<unknown>>;
  writeClipboard(text: string): Promise<ApiResult<unknown>>;
  loadState(): Promise<ApiResult<unknown>>;
  saveState(data: Record<string, unknown>): Promise<ApiResult<unknown>>;
  // 模块命名空间持久化（Phase 1 新增）
  getModuleState(moduleId: string): Promise<ApiResult<unknown>>;
  setModuleState(moduleId: string, data: unknown): Promise<ApiResult<unknown>>;
  checkFileExists(filePath: string): Promise<ApiResult<boolean>>;
  readFile(filePath: string): Promise<ApiResult<TemplateFilePayload>>;
  getDefaultTemplatePath(): Promise<ApiResult<string>>;
  getAppVersion(): Promise<ApiResult<string>>;
  resetStore(): Promise<ApiResult<unknown>>;
  // 数据备份/恢复（换机迁移）：选目录 / 导出 / 导入 / 打开数据目录
  selectDirectory(): Promise<ApiResult<string>>;
  backupExport(targetDir: string): Promise<ApiResult<BackupSummary>>;
  backupImport(backupDir: string): Promise<ApiResult<unknown>>;
  openDataDir(): Promise<ApiResult<string>>;
  // 自定义标题栏：平台标识 + 窗口控制（Phase 外观）
  platform: string;
  controlWindow(action: 'minimize' | 'maximize' | 'close'): Promise<ApiResult<unknown>>;
  // 网络请求（经主进程 Electron net 发起，规避 CORS）
  netRequest(payload: NetRequestPayload): Promise<ApiResult<NetRequestResult>>;
  // 订单归类模块（SQLite 指纹库 / 订单 / 主图）
  orderDbEnsure(): Promise<ApiResult<unknown>>;
  orderImageFind(fingerprint: string): Promise<ApiResult<OrderImageRecord | null>>;
  orderImageSave(payload: { id: number; status: 'done' | 'error'; resultJson?: string; error?: string }): Promise<ApiResult<unknown>>;
  orderInsert(order: OrderRecord): Promise<ApiResult<{ id: number }>>;
  orderGroupStats(dimensions: string[]): Promise<ApiResult<GroupStat[]>>;
  /** 订单列表（分页 + 关键字搜索）：{ offset?, limit?, corrected?, search? } → { rows, total }；列表不含 raw_fields */
  orderList(payload?: {
    offset?: number;
    limit?: number;
    corrected?: boolean;
    /** 关键字（单号/店铺/分类/颜色/logo/款编码/款名/款色），匹配为空串视为不筛选 */
    search?: string;
  }): Promise<ApiResult<{ rows: OrderRecord[]; total: number }>>;
  orderClear(): Promise<ApiResult<unknown>>;
  orderDownloadImage(url: string): Promise<ApiResult<OrderImageRecord>>;
  orderReadImage(localPath: string): Promise<ApiResult<ImageDataUrl>>;
  /** 缩略图（主进程等比缩放 + LRU，≤maxEdge px JPEG dataURL） */
  orderImageThumb(payload: { localPath: string; maxEdge?: number }): Promise<ApiResult<{ dataUrl: string }>>;
  /** 批量缩略图（渲染层同帧多图合并一次往返）：返回顺序与 items 一致，单项无效为 null */
  orderImageThumbBatch(items: { localPath: string; maxEdge?: number }[]): Promise<ApiResult<{ dataUrls: (string | null)[] }>>;
  /** 识别引擎 API Key：safeStorage 加密落盘（渲染层不落明文） */
  orderApiKeySet(apiKey: string): Promise<ApiResult<{ stored: boolean }>>;
  orderApiKeyGet(): Promise<ApiResult<{ apiKey: string }>>;
  /** 清理不被数据库引用的孤儿图片文件（返回释放数量与字节） */
  orderCleanupOrphanImages(): Promise<ApiResult<{ deleted: number; freedBytes: number }>>;
  // 产品库导入「图片」列：读取用户指定的本地图片（任意路径，仅图片扩展名，≤10MB）
  orderReadLocalImage(localPath: string): Promise<ApiResult<ImageDataUrl>>;
  orderExportExcel(buffer: ArrayBuffer, defaultName?: string): Promise<ApiResult<ExportExcelResult>>;
  // 待识别队列（订单归类：导入行整批落库，失败/缺图重启不丢、可增量重试）
  orderQueueEnqueue(payload: { batchNo: string; rows: OrderQueueEnqueueRow[] }): Promise<ApiResult<{ count: number }>>;
  orderQueueStats(payload: { batchNo: string }): Promise<ApiResult<OrderQueueStats>>;
  /** 队列行分页：失败清单用 { status:'error' }，缺图清单用 { missingOnly:true }；列表不含 raw_fields，返回 { rows, total } */
  orderQueueList(payload: {
    batchNo: string;
    offset?: number;
    limit?: number;
    status?: OrderQueueStatus | 'all';
    /** 缺图待补（status 为 pending/missing 且 url 为空） */
    missingOnly?: boolean;
  }): Promise<ApiResult<{ rows: OrderQueueRow[]; total: number }>>;
  /** 单行队列行（含 raw_fields）：补图等按需取，避免列表全量携带大字段 */
  orderQueueGet(id: number): Promise<ApiResult<OrderQueueRow>>;
  orderQueueNextPending(payload: { batchNo: string; afterId: number; limit: number }): Promise<ApiResult<OrderQueueRow[]>>;
  orderQueueSetResult(payload: { id: number; status: 'done' | 'error' | 'missing'; error?: string }): Promise<ApiResult<unknown>>;
  orderQueuePatch(payload: { id: number; url: string; rawFields: Record<string, string> }): Promise<ApiResult<unknown>>;
  orderQueueRetryErrors(payload: { batchNo: string }): Promise<ApiResult<{ count: number }>>;
  orderQueuePurgeDone(payload: { batchNo: string }): Promise<ApiResult<{ count: number }>>;
  orderQueueLastActive(): Promise<ApiResult<{ batchNo: string; stats: OrderQueueStats } | null>>;
  // 款编码/款色（产品库主数据）
  orderStyleResolve(payload: { imageId: number; fingerprint: string; category: string; features: string[]; color: string; styleName?: string }): Promise<ApiResult<{ styleCode: string; styleColorCode: string }>>;
  orderStyleList(): Promise<ApiResult<StyleRecord[]>>;
  orderStyleDelete(payload: { id: number }): Promise<ApiResult<{ deleted: number }>>;
  // 手动归并款式：订单挂到指定款编码 + 记入附加指纹（后续自动识别命中同一款编码）
  orderStyleAssign(payload: { orderId: number; styleId: number; color: string; fingerprint?: string }): Promise<ApiResult<{ styleCode: string; styleColorCode: string }>>;
  // 修改款式展示名（款编码级）
  orderStyleRename(payload: { code: string; name: string }): Promise<ApiResult<{ code: string; name: string }>>;
  // 产品库 Excel 批量导入（指纹由渲染层生成）
  orderStyleImport(payload: { styles: StyleImportItem[] }): Promise<ApiResult<StyleImportResult>>;
  // 数据纠正（更新订单字段，可选按新款指纹重新归类）
  orderUpdate(payload: OrderUpdateInput): Promise<ApiResult<{ styleCode?: string; styleColorCode?: string }>>;
  orderUpdateStatus(payload: OrderUpdateStatusInput): Promise<ApiResult<{ status: OrderStatus }>>;
  orderDelete(payload: { id: number }): Promise<ApiResult<{ deleted: number }>>;
  // 批量标记订单已核对（数据纠正页「确认无误」/「全部确认无误」置 corrected=1，不改识别字段）
  // ids: number[] 部分确认；{ all: true } 主进程一次 UPDATE 全量标记（避免大数组过 IPC）
  orderMarkCorrected(input: number[] | { all: true }): Promise<ApiResult<{ updated: number }>>;
  // 拿货对账模块（厂商 / 拿货单 / 付款 / 对账 / 待拿货缺口）
  purchaseDbEnsure(): Promise<ApiResult<unknown>>;
  purchaseSupplierList(): Promise<ApiResult<Supplier[]>>;
  purchaseSupplierCreate(payload: { name: string; phone?: string; note?: string }): Promise<ApiResult<{ id: number }>>;
  purchaseSupplierUpdate(payload: { id: number; phone?: string; note?: string }): Promise<ApiResult<unknown>>;
  purchaseSupplierDelete(payload: { id: number }): Promise<ApiResult<unknown>>;
  purchaseOrderList(): Promise<ApiResult<PurchaseOrder[]>>;
  purchaseOrderGet(payload: { id: number }): Promise<ApiResult<PurchaseOrder>>;
  purchaseOrderCreate(payload: {
    supplierId: number;
    bizDate: string;
    mode: 'detail' | 'package';
    note?: string;
    totalCents?: number;
    items?: PurchaseItem[];
    sources?: PurchaseSourceRow[];
  }): Promise<ApiResult<{ id: number }>>;
  purchaseOrderUpdate(payload: {
    id: number;
    bizDate?: string;
    note?: string;
    totalCents?: number;
    items?: PurchaseItem[];
  }): Promise<ApiResult<unknown>>;
  purchaseOrderSubmit(payload: { id: number }): Promise<ApiResult<unknown>>;
  purchaseOrderDelete(payload: { id: number }): Promise<ApiResult<unknown>>;
  purchasePaymentList(payload?: { supplierId?: number; from?: string; to?: string }): Promise<ApiResult<Payment[]>>;
  purchasePaymentAdd(payload: {
    supplierId: number;
    payDate: string;
    type: 'payment' | 'refund';
    amountCents: number;
    method?: string;
    note?: string;
  }): Promise<ApiResult<{ id: number }>>;
  purchasePaymentDelete(payload: { id: number }): Promise<ApiResult<unknown>>;
  purchaseReconciliation(payload?: { from?: string; to?: string }): Promise<ApiResult<ReconciliationRow[]>>;
  purchaseOutstanding(): Promise<ApiResult<OutstandingRow[]>>;
  purchaseIgnoreAdd(payload: { styleCode: string; color?: string; reason?: string }): Promise<ApiResult<unknown>>;
  purchaseIgnoreRemove(payload: { styleCode: string; color?: string }): Promise<ApiResult<unknown>>;
  purchaseIgnoreList(): Promise<ApiResult<IgnoreRow[]>>;
  purchasePriceHistory(payload: { supplierId?: number; styleCode: string; color?: string }): Promise<ApiResult<{ priceCents: number }>>;
  purchaseShopAllocation(payload?: { from?: string; to?: string }): Promise<ApiResult<ShopAllocationRow[]>>;
  purchaseShopAllocationDetail(payload: { shop: string; from?: string; to?: string }): Promise<ApiResult<ShopAllocationDetailRow[]>>;
  /** 导出拿货单 Excel（主进程生成，款编码+款色自动嵌入款色图） */
  purchaseExportExcel(payload: { items: PurchaseItem[]; defaultName?: string }): Promise<ApiResult<{ filePath: string }>>;
}

export const ipc: ElectronApi = (window as unknown as { electronAPI: ElectronApi }).electronAPI;

/** 是否为 macOS（决定是否渲染原生交通灯 / 自定义窗口控制） */
export const isMac: boolean = ipc.platform === 'darwin';

/** 窗口最小化 / 最大化切换 / 关闭 */
export function controlWindow(action: 'minimize' | 'maximize' | 'close'): Promise<ApiResult<unknown>> {
  return ipc.controlWindow(action);
}
