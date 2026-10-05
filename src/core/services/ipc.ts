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
  PickingRowsResult,
  PickingExportRow,
  UnifiedOrderRow,
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
  PluginScanResult,
  UpdaterEventPayload,
  AeOrderListItem,
  AeReceiverStatus,
  AeSummary,
  AeProfitOverview,
  AeCostMapImportItem,
  AeCostMapItem,
  AeRateItem,
  PurchaseCostSnapshotItem,
  ShopAccountItem,
  ShopAccountDetail,
  ShopAccountUpsertInput,
  ShopAccountSecretKey,
  ShopAccountStatus,
  ShopAccountSummary,
  ShopAccountBatchUpdateInput,
  ShopAccountBatchUpdateResult,
  CompanyStatus,
  CompanyItem,
  CompanyDetail,
  CompanySummary,
  CompanyUpsertInput,
  CompanyProfileUpsertInput,
  ProductStatus,
  ProductListItem,
  ProductUpsertInput,
  ProductSummary,
  ProductImportRowInput,
  ProductImportOutcome,
  ShopStatus,
  ShopListItem,
  ShopUpsertInput,
  ShopSummary,
  UnmappedShopRow,
  NameMapKind,
  SkuMapStatus,
  ShopSkuRow,
  SkuMapInputPayload,
  SkuMapSummary,
  SkuQueueRow,
  SkuQueueStats,
  VariantRow,
  VariantUpsertInput,
  ProductBatchUpdateInput,
  ItemImagePoolEntry,
  ShopProductItem,
  ShopProductRelation,
  MailAccountItem,
  MailAccountUpsertInput,
  MailMessageItem,
  MailMessageDetail,
  MailMessageListFilter,
  MailConnectionTestResult,
  MailStats,
  MailProviderPresetView,
  MailSyncEvent,
  MailAttachmentPreview,
  MailRemoteFolder,
  MailCacheStatus,
  MailFtsStatus,
} from '@/types';
import type { MarketCatalog, MarketPluginInfo } from '@/core/plugin/types';

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
  /** 选择图片文件（产品库主图 / 商品ID覆盖图；只返回路径，内容由主进程按需读取） */
  selectImage(): Promise<ApiResult<{ filePath: string }>>;
  importExcelByPath(filePath: string): Promise<ApiResult<ExcelFilePayload>>;
  selectTemplate(): Promise<ApiResult<TemplateFilePayload>>;
  saveTemplate(filePath: string, content: string): Promise<ApiResult<unknown>>;
  writeClipboard(text: string): Promise<ApiResult<unknown>>;
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
  orderImageSave(payload: {
    id: number;
    status: 'done' | 'error';
    resultJson?: string;
    error?: string;
  }): Promise<ApiResult<unknown>>;
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
  /** 运费原始行（oi_orders 最小投影，只读；供按订单算运费的宿主 op 提取） */
  orderAssignShop(payload: { orderNos: string[]; shopName: string }): Promise<
    ApiResult<{ updated: number }>
  >;
  /** 统一订单行投影（主干 `oi_orders`；`source` 过滤可选） */
  orderShippingRows(payload?: {
    limit?: number;
    source?: 'all' | 'import' | 'collect';
  }): Promise<ApiResult<UnifiedOrderRow[]>>;
  orderDownloadImage(url: string): Promise<ApiResult<OrderImageRecord>>;
  /** 拣货投影（只读；聚合在渲染层纯函数 `src/lib/picking.ts`） */
  pickingRows(payload?: {
    limit?: number;
    shop?: string;
    includeShipped?: boolean;
  }): Promise<ApiResult<PickingRowsResult>>;
  /** 拣货单导出（主进程 exceljs：带图 + 按厂家分表）；行由渲染层算好，主进程只画表 */
  pickingExportExcel(payload: {
    rows: PickingExportRow[];
    defaultName?: string;
  }): Promise<ApiResult<ExportExcelResult & { rows: number }>>;
  orderReadImage(localPath: string): Promise<ApiResult<ImageDataUrl>>;
  /** 缩略图（主进程等比缩放 + LRU，≤maxEdge px JPEG dataURL） */
  orderImageThumb(payload: {
    localPath: string;
    maxEdge?: number;
  }): Promise<ApiResult<{ dataUrl: string }>>;
  /** 批量缩略图（渲染层同帧多图合并一次往返）：返回顺序与 items 一致，单项无效为 null */
  orderImageThumbBatch(
    items: { localPath: string; maxEdge?: number }[]
  ): Promise<ApiResult<{ dataUrls: (string | null)[] }>>;
  /** 识别引擎 API Key：safeStorage 加密落盘（渲染层不落明文） */
  orderApiKeySet(apiKey: string): Promise<ApiResult<{ stored: boolean }>>;
  orderApiKeyGet(): Promise<ApiResult<{ apiKey: string }>>;
  /** 清理不被数据库引用的孤儿图片文件（返回释放数量与字节） */
  orderCleanupOrphanImages(): Promise<ApiResult<{ deleted: number; freedBytes: number }>>;
  // 产品库导入「图片」列：读取用户指定的本地图片（任意路径，仅图片扩展名，≤10MB）
  orderReadLocalImage(localPath: string): Promise<ApiResult<ImageDataUrl>>;
  orderExportExcel(
    buffer: ArrayBuffer,
    defaultName?: string
  ): Promise<ApiResult<ExportExcelResult>>;
  // 待识别队列（订单归类：导入行整批落库，失败/缺图重启不丢、可增量重试）
  orderQueueEnqueue(payload: {
    batchNo: string;
    rows: OrderQueueEnqueueRow[];
  }): Promise<ApiResult<{ count: number }>>;
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
  orderQueueNextPending(payload: {
    batchNo: string;
    afterId: number;
    limit: number;
  }): Promise<ApiResult<OrderQueueRow[]>>;
  orderQueueSetResult(payload: {
    id: number;
    status: 'done' | 'error' | 'missing';
    error?: string;
  }): Promise<ApiResult<unknown>>;
  orderQueuePatch(payload: {
    id: number;
    url: string;
    rawFields: Record<string, string>;
  }): Promise<ApiResult<unknown>>;
  orderQueueRetryErrors(payload: { batchNo: string }): Promise<ApiResult<{ count: number }>>;
  orderQueuePurgeDone(payload: { batchNo: string }): Promise<ApiResult<{ count: number }>>;
  orderQueueLastActive(): Promise<ApiResult<{ batchNo: string; stats: OrderQueueStats } | null>>;
  // 款编码/款色（产品库主数据）
  orderStyleResolve(payload: {
    imageId: number;
    fingerprint: string;
    category: string;
    features: string[];
    color: string;
    styleName?: string;
  }): Promise<ApiResult<{ styleCode: string; styleColorCode: string }>>;
  orderStyleList(): Promise<ApiResult<StyleRecord[]>>;
  orderStyleDelete(payload: { id: number }): Promise<ApiResult<{ deleted: number }>>;
  // 手动归并款式：订单挂到指定款编码 + 记入附加指纹（后续自动识别命中同一款编码）
  orderStyleAssign(payload: {
    orderId: number;
    styleId: number;
    color: string;
    fingerprint?: string;
  }): Promise<ApiResult<{ styleCode: string; styleColorCode: string }>>;
  // 修改款式展示名（款编码级）
  orderStyleRename(payload: {
    code: string;
    name: string;
  }): Promise<ApiResult<{ code: string; name: string }>>;
  // 产品库 Excel 批量导入（指纹由渲染层生成）
  orderStyleImport(payload: { styles: StyleImportItem[] }): Promise<ApiResult<StyleImportResult>>;
  // 数据纠正（更新订单字段，可选按新款指纹重新归类）
  orderUpdate(
    payload: OrderUpdateInput
  ): Promise<ApiResult<{ styleCode?: string; styleColorCode?: string }>>;
  orderUpdateStatus(payload: OrderUpdateStatusInput): Promise<ApiResult<{ status: OrderStatus }>>;
  orderDelete(payload: { id: number }): Promise<ApiResult<{ deleted: number }>>;
  // 批量标记订单已核对（数据纠正页「确认无误」/「全部确认无误」置 corrected=1，不改识别字段）
  // ids: number[] 部分确认；{ all: true } 主进程一次 UPDATE 全量标记（避免大数组过 IPC）
  orderMarkCorrected(input: number[] | { all: true }): Promise<ApiResult<{ updated: number }>>;
  // 速卖通利润追踪（ae-profit / M0）：入站数据走 localhost 接收端，本区仅查询类 IPC
  aeDbEnsure(): Promise<ApiResult<unknown>>;
  aeOrderList(payload?: {
    offset?: number;
    limit?: number;
    search?: string;
  }): Promise<ApiResult<{ rows: AeOrderListItem[]; total: number }>>;
  aeSummary(): Promise<ApiResult<AeSummary>>;
  aeReceiverStatus(): Promise<ApiResult<AeReceiverStatus>>;
  // M1：利润统计 / 成本快照 / 汇率维护 / 拿货成本只读导出
  aeProfitStats(payload?: {
    granularity?: 'day' | 'month';
    rangeDays?: number;
  }): Promise<ApiResult<AeProfitOverview>>;
  aeCostMapImport(payload: {
    items: AeCostMapImportItem[];
  }): Promise<ApiResult<{ replaced: number }>>;
  aeCostMapList(): Promise<ApiResult<AeCostMapItem[]>>;
  settleImport(payload: { rows: unknown[] }): Promise<
    ApiResult<{ created: number; updated: number; failed: { orderNo: string; message: string }[] }>
  >;
  settleOrders(payload: { orderNos: string[] }): Promise<
    ApiResult<{
      rows: {
        orderNo: string;
        settleStatus: string;
        pendingReason: string;
        dealCents: number;
        netIncomeCents: number;
        splitCents: number;
        feeSumCents: number;
        itemLines: number;
        /** 商品行件数明细（`lines` = 该 (订单,商品) 的商品行数；>1 = 同商品多 SKU，qty 不可逐行复用） */
        items: { itemId: string; lines: number; qty: number }[];
        from: 'order' | 'items';
      }[];
    }>
  >;
  settleStats(): Promise<
    ApiResult<{
      lines: number;
      orders: number;
      itemLines: number;
      orderLines: number;
      pendingOrders: number;
      settledOrders: number;
      lastImportedAt: string;
    }>
  >;
  aeRateList(): Promise<ApiResult<AeRateItem[]>>;
  aeRateUpsert(payload: {
    fromCurrency: string;
    rateToCny: number;
  }): Promise<ApiResult<{ ok: boolean }>>;
  purchaseCostSnapshot(): Promise<ApiResult<{ items: PurchaseCostSnapshotItem[]; count: number }>>;
  // 拿货对账模块（厂商 / 拿货单 / 付款 / 对账 / 待拿货缺口）
  purchaseDbEnsure(): Promise<ApiResult<unknown>>;
  purchaseSupplierList(): Promise<ApiResult<Supplier[]>>;
  purchaseSupplierCreate(payload: {
    name: string;
    phone?: string;
    note?: string;
  }): Promise<ApiResult<{ id: number }>>;
  purchaseSupplierUpdate(payload: {
    id: number;
    phone?: string;
    note?: string;
  }): Promise<ApiResult<unknown>>;
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
  purchasePaymentList(payload?: {
    supplierId?: number;
    from?: string;
    to?: string;
  }): Promise<ApiResult<Payment[]>>;
  purchasePaymentAdd(payload: {
    supplierId: number;
    payDate: string;
    type: 'payment' | 'refund';
    amountCents: number;
    method?: string;
    note?: string;
  }): Promise<ApiResult<{ id: number }>>;
  purchasePaymentDelete(payload: { id: number }): Promise<ApiResult<unknown>>;
  purchaseReconciliation(payload?: {
    from?: string;
    to?: string;
  }): Promise<ApiResult<ReconciliationRow[]>>;
  purchaseOutstanding(): Promise<ApiResult<OutstandingRow[]>>;
  purchaseIgnoreAdd(payload: {
    styleCode: string;
    color?: string;
    reason?: string;
  }): Promise<ApiResult<unknown>>;
  purchaseIgnoreRemove(payload: { styleCode: string; color?: string }): Promise<ApiResult<unknown>>;
  purchaseIgnoreList(): Promise<ApiResult<IgnoreRow[]>>;
  purchasePriceHistory(payload: {
    supplierId?: number;
    styleCode: string;
    color?: string;
  }): Promise<ApiResult<{ priceCents: number }>>;
  purchaseShopAllocation(payload?: {
    from?: string;
    to?: string;
  }): Promise<ApiResult<ShopAllocationRow[]>>;
  purchaseShopAllocationDetail(payload: {
    shop: string;
    from?: string;
    to?: string;
  }): Promise<ApiResult<ShopAllocationDetailRow[]>>;
  /** 导出拿货单 Excel（主进程生成，款编码+款色自动嵌入款色图） */
  purchaseExportExcel(payload: {
    items: PurchaseItem[];
    defaultName?: string;
  }): Promise<ApiResult<{ filePath: string }>>;
  // ---- 店铺账号管家（以「店铺套 · 邮箱」为单位维护店群账号）----
  shopAccountDbEnsure(): Promise<ApiResult<unknown>>;
  shopAccountList(payload?: {
    search?: string;
    status?: string;
    platform?: string;
  }): Promise<ApiResult<ShopAccountItem[]>>;
  shopAccountGet(payload: { id: number }): Promise<ApiResult<ShopAccountDetail | null>>;
  shopAccountSummary(): Promise<ApiResult<ShopAccountSummary>>;
  shopAccountSecurity(): Promise<ApiResult<{ secureStorage: boolean }>>;
  shopAccountUpsert(
    payload: ShopAccountUpsertInput
  ): Promise<ApiResult<{ id: number; secureStorage: boolean }>>;
  shopAccountDelete(payload: { id: number }): Promise<ApiResult<{ deleted: boolean }>>;
  shopAccountReveal(payload: {
    id: number;
    field: ShopAccountSecretKey;
  }): Promise<ApiResult<{ value: string }>>;
  shopAccountBatchUpdate(
    payload: ShopAccountBatchUpdateInput
  ): Promise<ApiResult<ShopAccountBatchUpdateResult>>;
  // ---- 企业管理（企业基本信息 + 欧代 / 土代 / 德国包装法）----
  companyDbEnsure(): Promise<ApiResult<unknown>>;
  companyList(payload?: { search?: string; status?: string }): Promise<ApiResult<CompanyItem[]>>;
  companyGet(payload: { id: number }): Promise<ApiResult<CompanyDetail | null>>;
  companySummary(): Promise<ApiResult<CompanySummary>>;
  companyUpsert(payload: CompanyUpsertInput): Promise<ApiResult<{ id: number }>>;
  companyDelete(payload: { id: number }): Promise<ApiResult<{ deleted: boolean }>>;
  companyProfileUpsert(payload: CompanyProfileUpsertInput): Promise<ApiResult<{ id: number }>>;
  companyProfileDelete(payload: { id: number }): Promise<ApiResult<{ deleted: boolean }>>;
  // ---- 产品库（产品主数据；编码为跨域关联锚点，与 oi_styles.code 同口径）----
  productDbEnsure(): Promise<ApiResult<{ ok: boolean }>>;
  productList(payload?: {
    search?: string;
    status?: ProductStatus | '';
    supplierId?: number;
    withoutSupplier?: boolean;
    onlyMissingWeight?: boolean;
    offset?: number;
    limit?: number;
  }): Promise<ApiResult<{ rows: ProductListItem[]; total: number }>>;
  productGet(payload: { id: number }): Promise<ApiResult<ProductListItem | null>>;
  productUpsert(payload: ProductUpsertInput): Promise<ApiResult<{ id: number; created: boolean }>>;
  productDelete(payload: { id: number }): Promise<ApiResult<{ deleted: boolean }>>;
  productSummary(): Promise<ApiResult<ProductSummary>>;
  productImport(payload: {
    items: ProductImportRowInput[];
    mode?: 'upsert' | 'insertOnly';
  }): Promise<ApiResult<ProductImportOutcome>>;
  productExport(payload: {
    buffer: ArrayBuffer;
    defaultName?: string;
  }): Promise<ApiResult<{ filePath: string }>>;
  // ---- 店铺商品ID → 产品映射（P3；pl_shop_sku）----
  productSkuList(payload?: {
    search?: string;
    status?: SkuMapStatus | '';
    shopId?: number;
    offset?: number;
    limit?: number;
  }): Promise<ApiResult<{ rows: ShopSkuRow[]; total: number }>>;
  productSkuSummary(): Promise<ApiResult<SkuMapSummary>>;
  productSkuQueue(payload?: {
    limit?: number;
    maxRows?: number;
  }): Promise<ApiResult<{ rows: SkuQueueRow[]; stats: SkuQueueStats }>>;
  productSkuMap(payload: {
    rows: SkuMapInputPayload[];
  }): Promise<
    ApiResult<{
      created: number;
      updated: number;
      reassigned: number;
      failed: { itemId: string; message: string }[];
    }>
  >;
  productSkuInvalidate(payload: { id: number }): Promise<ApiResult<{ changed: boolean }>>;
  // ---- SKU 子表（pl_variants：一个款下多个 SKU，每 SKU 一个克重）----
  productVariantList(payload: {
    productIds: number[];
  }): Promise<ApiResult<{ rows: VariantRow[] }>>;
  productVariantUpsert(payload: VariantUpsertInput): Promise<ApiResult<{ id: number; created: boolean }>>;
  productVariantDelete(payload: { id: number }): Promise<ApiResult<{ removed: number }>>;
  productBatchUpdate(
    payload: ProductBatchUpdateInput,
  ): Promise<ApiResult<{ updated: number }>>;
  // ---- 产品图片（pl_images / pl_item_images；落盘 userData/product-images/）----
  productImageAttach(payload: {
    productId: number;
    /** 用户经对话框选择的图片文件路径 */
    srcPath: string;
  }): Promise<ApiResult<{ imageId: number; localPath: string; reused: boolean }>>;
  productImageDetach(payload: { productId: number }): Promise<ApiResult<{ changed: boolean }>>;
  productItemImageSet(payload: {
    itemId: string;
    srcPath: string;
  }): Promise<ApiResult<{ imageId: number; localPath: string; reused: boolean; itemId: string }>>;
  productItemImageClear(payload: { itemId: string }): Promise<ApiResult<{ removed: number }>>;
  productItemImagePool(payload: {
    itemIds: string[];
  }): Promise<ApiResult<{ pool: Record<string, ItemImagePoolEntry> }>>;
  // ---- 店铺商品清单（pl_shop_sku 扩展视图，支持一对多关联；商品清单页签的数据面）----
  // 与 productSku* 的区别：这里按 item_id 聚合（一件商品 → 多个产品），单值映射走 productSkuMap。
  shopProductImport(payload: {
    items: { itemId: string; shopId: number; imageUrl: string }[];
  }): Promise<ApiResult<{ imported: number; updated: number }>>;
  shopProductList(payload?: {
    offset?: number;
    limit?: number;
    search?: string;
  }): Promise<ApiResult<{ rows: ShopProductItem[]; total: number }>>;
  shopProductDelete(payload: { itemId: string }): Promise<ApiResult<{ removed: number }>>;
  shopProductRelations(payload: { itemId: string }): Promise<ApiResult<ShopProductRelation[]>>;
  shopProductRelationAdd(payload: {
    itemId: string;
    productId: number;
  }): Promise<ApiResult<{ id: number; created: boolean }>>;
  shopProductRelationDelete(payload: { id: number }): Promise<ApiResult<{ removed: number }>>;
  // ---- 店铺实体（sk_shops / sk_name_map；DOMAIN_INTEGRATION_PLAN S1）----
  // 历史文本（订单 / 采购 / 利润三处）不改写，靠名称归一映射旁挂关联（G2）。
  shopDbEnsure(): Promise<ApiResult<{ ok: boolean }>>;
  shopList(payload?: {
    search?: string;
    platform?: string;
    status?: ShopStatus | '';
    offset?: number;
    limit?: number;
  }): Promise<ApiResult<{ rows: ShopListItem[]; total: number }>>;
  shopGet(payload: { id: number }): Promise<ApiResult<ShopListItem | null>>;
  shopUpsert(payload: ShopUpsertInput): Promise<ApiResult<{ id: number; created: boolean }>>;
  shopSummary(): Promise<ApiResult<ShopSummary>>;
  shopUnmapped(): Promise<ApiResult<UnmappedShopRow[]>>;
  shopMap(payload: {
    raw: string;
    refId?: number;
    ignored?: boolean;
    kind?: NameMapKind;
    note?: string;
  }): Promise<ApiResult<{ key: string; refId: number; ignored: boolean }>>;
  shopUnmap(payload: {
    raw: string;
    kind?: NameMapKind;
  }): Promise<ApiResult<{ removed: number }>>;
  // ---- 集中邮件收件箱（IMAP 只读同步；授权码只进不出）----
  mailDbEnsure(): Promise<ApiResult<{ ok: boolean }>>;
  mailAccountList(): Promise<ApiResult<MailAccountItem[]>>;
  mailAccountUpsert(payload: MailAccountUpsertInput): Promise<ApiResult<{ id: number }>>;
  mailAccountDelete(payload: { id: number }): Promise<ApiResult<{ deleted: boolean }>>;
  mailAccountTest(payload: {
    email: string;
    authPassword: string;
    providerId?: string;
    host?: string;
    port?: number;
    secure?: boolean;
  }): Promise<ApiResult<MailConnectionTestResult>>;
  mailSyncNow(payload?: { accountId?: number }): Promise<ApiResult<{ queued: number[] }>>;
  mailSyncCancel(payload: { accountId: number }): Promise<ApiResult<{ cancelled: boolean }>>;
  mailSyncState(): Promise<ApiResult<{ active: number[]; queued: number[] }>>;
  mailMessagesList(
    payload?: MailMessageListFilter
  ): Promise<ApiResult<{ items: MailMessageItem[]; total: number }>>;
  mailMessageGet(payload: { id: number }): Promise<ApiResult<MailMessageDetail | null>>;
  /** 本地已读标记（IMAP 只读；ids 为空 + accountId/all 时按账号批量） */
  mailMessageRead(payload: {
    ids?: number[];
    accountId?: number;
    all?: boolean;
    read?: boolean;
  }): Promise<ApiResult<{ changed: number; unread: number }>>;
  /** 按需补拉正文（M2-1：超大邮件只缓存了预览，点开时现拉原文） */
  mailBodyFetch(payload: {
    accountId?: number;
    messageId: number;
  }): Promise<ApiResult<MailMessageDetail | null>>;
  /** 附件另存（M2-2：弹系统保存对话框后落盘；用户取消时 canceled=true） */
  mailAttachmentSave(payload: {
    messageId: number;
    attachmentId: number;
  }): Promise<ApiResult<{ canceled: boolean; path: string; size: number }>>;
  /** 附件预览（M3-1：命中本地缓存不触网；图片返回 data URL） */
  mailAttachmentPreview(payload: {
    messageId: number;
    attachmentId: number;
  }): Promise<ApiResult<MailAttachmentPreview>>;
  /** 附件用系统默认应用打开（M3-1） */
  mailAttachmentOpen(payload: {
    messageId: number;
    attachmentId: number;
  }): Promise<ApiResult<{ path: string }>>;
  /** 拉取服务端文件夹列表（M3-3） */
  mailFoldersList(payload: { accountId: number }): Promise<ApiResult<MailRemoteFolder[]>>;
  /** 附件本地缓存占用（M3-1） */
  mailCacheStatus(): Promise<ApiResult<MailCacheStatus>>;
  /** 清空附件本地缓存 */
  mailCacheClear(): Promise<ApiResult<{ removed: number }>>;
  /** 打开附件缓存目录 */
  mailCacheOpen(): Promise<ApiResult<{ opened: boolean }>>;
  /** FTS5 全文索引状态（M3-2） */
  mailFtsStatus(): Promise<ApiResult<MailFtsStatus>>;
  /** 重建全文索引（M3-2） */
  mailFtsRebuild(): Promise<ApiResult<{ total: number; indexed: number }>>;
  mailPurge(payload?: {
    accountId?: number;
    days?: number;
  }): Promise<ApiResult<{ deleted: number }>>;
  mailStats(): Promise<ApiResult<MailStats>>;
  /** 邮箱服务商预设（授权码获取指引 / 默认连接参数，不含凭据） */
  mailProviderList(): Promise<ApiResult<MailProviderPresetView[]>>;
  /** ---- 运价表快照（宿主中立层）---- */
  shipRateSnapshotSave(payload: {
    table: unknown;
    sourceFile?: string;
    sheetName?: string;
    effectiveFrom?: string;
  }): Promise<ApiResult<{ id: number; created: boolean; effectiveFrom: string }>>;
  shipRateSnapshotList(payload?: { limit?: number }): Promise<
    ApiResult<{
      rows: {
        id: number;
        effectiveFrom: string;
        sourceFile: string;
        sheetName: string;
        countries: number;
        cards: number;
        importedAt: string;
      }[];
    }>
  >;
  shipRateSnapshotCalc(payload?: { limit?: number }): Promise<
    ApiResult<{
      rows: { id: number; effectiveFrom: string; sourceFile: string; sheetName: string; table: unknown }[];
    }>
  >;
  /** 订阅邮件同步事件（主进程→渲染层单向）；返回退订函数 */
  onMailSyncEvent(cb: (event: MailSyncEvent) => void): () => void;
  // ---- 外置插件（Phase 3：独立插件目录 <userData>/plugins）----
  pluginsScan(): Promise<ApiResult<PluginScanResult>>;
  pluginsReadEntry(payload: { id: string; entry: string }): Promise<ApiResult<{ code: string }>>;
  pluginsUninstall(payload: { id: string }): Promise<ApiResult<void>>;
  pluginsOpenDir(): Promise<ApiResult<string>>;
  // ---- 插件市场（Market：catalog 拉取 + zip 安装）----
  pluginMarketCatalog(payload: { url: string }): Promise<ApiResult<MarketCatalog>>;
  pluginMarketInstall(payload: {
    item: MarketPluginInfo;
    force?: boolean;
  }): Promise<ApiResult<{ id: string; version: string }>>;
  // 软件更新（GitHub Releases 自动更新）
  checkForUpdates(): Promise<ApiResult<{ mode: 'dev' | 'release'; currentVersion: string }>>;
  quitAndInstallUpdate(): Promise<ApiResult<void>>;
  /** 订阅更新事件（主进程→渲染层单向）；返回退订函数 */
  onUpdaterEvent(cb: (event: UpdaterEventPayload) => void): () => void;
}

export const ipc: ElectronApi = (window as unknown as { electronAPI: ElectronApi }).electronAPI;

/** 是否为 macOS（决定是否渲染原生交通灯 / 自定义窗口控制） */
export const isMac: boolean = ipc.platform === 'darwin';

/** 窗口最小化 / 最大化切换 / 关闭 */
export function controlWindow(
  action: 'minimize' | 'maximize' | 'close'
): Promise<ApiResult<unknown>> {
  return ipc.controlWindow(action);
}

// ---- 外置插件（Phase 3）：统一收敛到 core/services/ipc.ts，组件不得直触 window.electronAPI ----
/** 扫描独立插件目录（<userData>/plugins），返回每个目录的 manifest 原始内容 */
export function pluginsScan(): Promise<ApiResult<PluginScanResult>> {
  return ipc.pluginsScan();
}

/** 读取外置插件入口 JS 源码（用于渲染层动态加载） */
export function pluginsReadEntry(id: string, entry: string): Promise<ApiResult<{ code: string }>> {
  return ipc.pluginsReadEntry({ id, entry });
}

/** 卸载（删除）外置插件目录 */
export function pluginsUninstall(id: string): Promise<ApiResult<void>> {
  return ipc.pluginsUninstall({ id });
}

/** 在系统文件管理器中打开插件目录 */
export function pluginsOpenDir(): Promise<ApiResult<string>> {
  return ipc.pluginsOpenDir();
}

// ---- 插件市场（Market）----
/** 拉取市场 catalog（净化后的合法条目） */
export function marketCatalogFetch(url: string): Promise<ApiResult<MarketCatalog>> {
  return ipc.pluginMarketCatalog({ url });
}

/** 安装/更新市场插件（下载 zip → sha256 → 解压校验 → 落盘 plugins/<id>/） */
export function marketPluginInstall(
  item: MarketPluginInfo,
  force = false
): Promise<ApiResult<{ id: string; version: string }>> {
  return ipc.pluginMarketInstall({ item, force });
}

// ---- 速卖通利润追踪（ae-profit / M0）：语义化查询 IPC ----
/** 幂等建表（视图首次激活时调用） */
export function aeDbEnsure(): Promise<ApiResult<unknown>> {
  return ipc.aeDbEnsure();
}

/** 订单明细列表（分页 + 单号/店铺关键字） */
export function aeOrderList(payload?: {
  offset?: number;
  limit?: number;
  search?: string;
}): Promise<ApiResult<{ rows: AeOrderListItem[]; total: number }>> {
  return ipc.aeOrderList(payload);
}

/** 汇总（分币种，收入/费用分列） */
export function aeSummary(): Promise<ApiResult<AeSummary>> {
  return ipc.aeSummary();
}

/** 接收端运行状态（端口 / 最近入库 / 错误） */
export function aeReceiverStatus(): Promise<ApiResult<AeReceiverStatus>> {
  return ipc.aeReceiverStatus();
}

// ---- M1：利润引擎 / 成本衔接 / 汇率（语义化查询） ----
/** 利润总览（CNY 基准分层利润 + 趋势 + TOP + 费用构成 + 成本覆盖率） */
export function aeProfitStats(payload?: {
  granularity?: 'day' | 'month';
  rangeDays?: number;
}): Promise<ApiResult<AeProfitOverview>> {
  return ipc.aeProfitStats(payload);
}

/** 成本快照全量替换（items 来自 purchaseCostSnapshot 只读导出） */
export function aeCostMapImport(
  items: AeCostMapImportItem[]
): Promise<ApiResult<{ replaced: number }>> {
  return ipc.aeCostMapImport({ items });
}

/** 成本表全量（成本管理面板） */
export function aeCostMapList(): Promise<ApiResult<AeCostMapItem[]>> {
  return ipc.aeCostMapList();
}

/** 汇率全量 */
export function aeRateList(): Promise<ApiResult<AeRateItem[]>> {
  return ipc.aeRateList();
}

/** 结算明细落库（渲染层已解析并校验过；主进程只归一 + 存） */
export function settleImport(payload: { rows: unknown[] }) {
  return ipc.settleImport(payload);
}

/** 按订单号取结算汇总（利润页「精准轨」用） */
export function settleOrders(payload: { orderNos: string[] }) {
  return ipc.settleOrders(payload);
}

/** 结算明细概览（导入结果 / 诊断展示） */
export function settleStats() {
  return ipc.settleStats();
}

/** 汇率 upsert（1 fromCurrency = rateToCny CNY） */
export function aeRateUpsert(
  fromCurrency: string,
  rateToCny: number
): Promise<ApiResult<{ ok: boolean }>> {
  return ipc.aeRateUpsert({ fromCurrency, rateToCny });
}

/** 拿货对账只读成本快照导出（D3 单向通道，供本模块导入 ae_cost_map） */
export function purchaseCostSnapshot(): Promise<
  ApiResult<{ items: PurchaseCostSnapshotItem[]; count: number }>
> {
  return ipc.purchaseCostSnapshot();
}

// ---- 店铺账号管家（shop-accounts 视图插件）----
/** 幂等建表（视图首次激活时调用） */
export function shopAccountDbEnsure(): Promise<ApiResult<unknown>> {
  return ipc.shopAccountDbEnsure();
}

/** 店铺套列表（关键字/状态/平台过滤，永不含明文密码） */
export function shopAccountList(payload?: {
  search?: string;
  status?: ShopAccountStatus | '';
  platform?: string;
}): Promise<ApiResult<ShopAccountItem[]>> {
  return ipc.shopAccountList(payload);
}

/** 单套详情（含解密敏感字段，仅编辑时使用） */
export function shopAccountGet(id: number): Promise<ApiResult<ShopAccountDetail | null>> {
  return ipc.shopAccountGet({ id });
}

/** 汇总（总数 / 按状态计数 / 平台选项去重计数） */
export function shopAccountSummary(): Promise<ApiResult<ShopAccountSummary>> {
  return ipc.shopAccountSummary();
}

/** 当前系统安全存储可用性（false 时密码为降级存储，需在 UI 提示） */
export function shopAccountSecurity(): Promise<ApiResult<{ secureStorage: boolean }>> {
  return ipc.shopAccountSecurity();
}

/** 新增/更新店铺套（secrets：缺省=保持、空串=清空、非空=覆盖） */
export function shopAccountUpsert(
  payload: ShopAccountUpsertInput
): Promise<ApiResult<{ id: number; secureStorage: boolean }>> {
  return ipc.shopAccountUpsert(payload);
}

/** 删除店铺套（含其密文） */
export function shopAccountDelete(id: number): Promise<ApiResult<{ deleted: boolean }>> {
  return ipc.shopAccountDelete({ id });
}

/** 按需解密单个敏感字段（复制/查看用） */
export function shopAccountReveal(
  id: number,
  field: ShopAccountSecretKey
): Promise<ApiResult<{ value: string }>> {
  return ipc.shopAccountReveal({ id, field });
}

/** 批量修改店铺套（非敏感字段，含整批事务） */
export function shopAccountBatchUpdate(
  payload: ShopAccountBatchUpdateInput
): Promise<ApiResult<ShopAccountBatchUpdateResult>> {
  return ipc.shopAccountBatchUpdate(payload);
}

// ---------------------------------------------------------------------------
// 企业管理（企业基本信息 + 欧代 / 土代 / 德国包装法）
// ---------------------------------------------------------------------------

/** 幂等建表（企业管理视图首次激活时调用） */
export function companyDbEnsure(): Promise<ApiResult<unknown>> {
  return ipc.companyDbEnsure();
}

/** 企业列表（关键字/状态过滤；含已维护合规类型，不含明细） */
export function companyList(payload?: {
  search?: string;
  status?: CompanyStatus | '';
}): Promise<ApiResult<CompanyItem[]>> {
  return ipc.companyList(payload);
}

/** 企业详情（含欧代 / 土代 / 德国包装法明细） */
export function companyGet(id: number): Promise<ApiResult<CompanyDetail | null>> {
  return ipc.companyGet({ id });
}

/** 汇总（企业总数 / 状态分布 / 各合规类型覆盖数 / 30 天内到期条数） */
export function companySummary(): Promise<ApiResult<CompanySummary>> {
  return ipc.companySummary();
}

/** 新增/更新企业 */
export function companyUpsert(payload: CompanyUpsertInput): Promise<ApiResult<{ id: number }>> {
  return ipc.companyUpsert(payload);
}

/** 删除企业（级联删除其合规资料） */
export function companyDelete(id: number): Promise<ApiResult<{ deleted: boolean }>> {
  return ipc.companyDelete({ id });
}

/** 新增/更新合规资料（type 白名单：eu_rep / tr_rep / de_packaging） */
export function companyProfileUpsert(
  payload: CompanyProfileUpsertInput
): Promise<ApiResult<{ id: number }>> {
  return ipc.companyProfileUpsert(payload);
}

/** 删除合规资料 */
export function companyProfileDelete(id: number): Promise<ApiResult<{ deleted: boolean }>> {
  return ipc.companyProfileDelete({ id });
}

// ---------------------------------------------------------------------------
// 集中邮件收件箱（IMAP 只读同步）
// ---------------------------------------------------------------------------

/** 幂等建表（收件箱视图首次激活时调用） */
export function mailDbEnsure(): Promise<ApiResult<{ ok: boolean }>> {
  return ipc.mailDbEnsure();
}

/** 已接入邮箱列表（含同步状态；不含任何凭据） */
export function mailAccountList(): Promise<ApiResult<MailAccountItem[]>> {
  return ipc.mailAccountList();
}

/** 接入/更新邮箱；授权码经主进程加密落库，写入后永不回读 */
export function mailAccountUpsert(
  payload: MailAccountUpsertInput
): Promise<ApiResult<{ id: number }>> {
  return ipc.mailAccountUpsert(payload);
}

/** 取消接入（连带删除该账号已缓存的邮件） */
export function mailAccountDelete(id: number): Promise<ApiResult<{ deleted: boolean }>> {
  return ipc.mailAccountDelete({ id });
}

/** 连接测试：只读打开 INBOX 后即登出，不落库任何数据 */
export function mailAccountTest(payload: {
  email: string;
  authPassword: string;
  providerId?: string;
  host?: string;
  port?: number;
  secure?: boolean;
}): Promise<ApiResult<MailConnectionTestResult>> {
  return ipc.mailAccountTest(payload);
}

/** 触发同步（省略 accountId = 同步全部启用中的账号） */
export function mailSyncNow(accountId?: number): Promise<ApiResult<{ queued: number[] }>> {
  return ipc.mailSyncNow(accountId ? { accountId } : {});
}

/** 取消同步（下一个批次边界生效） */
export function mailSyncCancel(accountId: number): Promise<ApiResult<{ cancelled: boolean }>> {
  return ipc.mailSyncCancel({ accountId });
}

/** 当前同步队列状态 */
export function mailSyncState(): Promise<ApiResult<{ active: number[]; queued: number[] }>> {
  return ipc.mailSyncState();
}

/** 邮件列表（纯本地查询，不触网） */
export function mailMessagesList(
  payload?: MailMessageListFilter
): Promise<ApiResult<{ items: MailMessageItem[]; total: number }>> {
  return ipc.mailMessagesList(payload || {});
}

/** 邮件详情（含正文与附件元信息） */
export function mailMessageGet(id: number): Promise<ApiResult<MailMessageDetail | null>> {
  return ipc.mailMessageGet({ id });
}

/**
 * 本地已读标记
 * IMAP 只读不改服务端 flag，本地 read_at 是已读态的唯一可靠来源；返回变更数与最新未读总数，
 * 便于调用方直接刷新角标而不必重查列表。
 * @param payload { ids } 精确标记；或 { accountId } / { all: true } 按范围批量
 * @param read true=标记已读（默认）；false=恢复未读（服务端已读的不可恢复）
 */
export function mailMessageRead(payload: {
  ids?: number[];
  accountId?: number;
  all?: boolean;
  read?: boolean;
}): Promise<ApiResult<{ changed: number; unread: number }>> {
  return ipc.mailMessageRead(payload);
}

/**
 * 按需补拉正文（M2-1）
 * 同步时为超大邮件只缓存了预览，点开详情时按 UID 现拉原文解析入库。
 * @param messageId 本地邮件 id
 * @param accountId 邮箱账号 id（省略时取邮件自身归属）
 * @returns 最新详情（含正文与附件清单）
 */
export function mailBodyFetch(
  messageId: number,
  accountId?: number
): Promise<ApiResult<MailMessageDetail | null>> {
  return ipc.mailBodyFetch({ messageId, accountId });
}

/**
 * 附件另存（M2-2）
 * 库里只存元信息，落盘前重拉原文解析；弹出系统保存对话框（默认文件名=附件名）。
 * @returns 用户取消时 data.canceled 为 true（非错误）
 */
export function mailAttachmentSave(
  messageId: number,
  attachmentId: number
): Promise<ApiResult<{ canceled: boolean; path: string; size: number }>> {
  return ipc.mailAttachmentSave({ messageId, attachmentId });
}

/**
 * 附件预览（M3-1）
 * 命中本地缓存时直接读盘（不触网）；图片返回 data URL 供内联预览，其余类型建议走 mailAttachmentOpen。
 */
export function mailAttachmentPreview(
  messageId: number,
  attachmentId: number
): Promise<ApiResult<MailAttachmentPreview>> {
  return ipc.mailAttachmentPreview({ messageId, attachmentId });
}

/** 附件用系统默认应用打开（M3-1）：未缓存时先落盘到缓存目录再调用 shell.openPath */
export function mailAttachmentOpen(
  messageId: number,
  attachmentId: number
): Promise<ApiResult<{ path: string }>> {
  return ipc.mailAttachmentOpen({ messageId, attachmentId });
}

/** 拉取服务端文件夹列表（M3-3：设置页勾选同步目录；会建立一次只读连接） */
export function mailFoldersList(accountId: number): Promise<ApiResult<MailRemoteFolder[]>> {
  return ipc.mailFoldersList({ accountId });
}

/** 附件本地缓存占用（M3-1） */
export function mailCacheStatus(): Promise<ApiResult<MailCacheStatus>> {
  return ipc.mailCacheStatus();
}

/** 清空附件本地缓存（M3-1） */
export function mailCacheClear(): Promise<ApiResult<{ removed: number }>> {
  return ipc.mailCacheClear();
}

/** 在系统文件管理器中打开附件缓存目录 */
export function mailCacheOpen(): Promise<ApiResult<{ opened: boolean }>> {
  return ipc.mailCacheOpen();
}

/** FTS5 全文索引状态（M3-2） */
export function mailFtsStatus(): Promise<ApiResult<MailFtsStatus>> {
  return ipc.mailFtsStatus();
}

/** 重建全文索引（M3-2） */
export function mailFtsRebuild(): Promise<ApiResult<{ total: number; indexed: number }>> {
  return ipc.mailFtsRebuild();
}

/** 手动清理同步窗口外的过期邮件 */
export function mailPurge(payload?: {
  accountId?: number;
  days?: number;
}): Promise<ApiResult<{ deleted: number }>> {
  return ipc.mailPurge(payload || {});
}

/** 收件箱汇总（账号数 / 邮件数 / 未读数 / 最近同步时间） */
export function mailStats(): Promise<ApiResult<MailStats>> {
  return ipc.mailStats();
}

/** 邮箱服务商预设（授权码获取指引 / 默认连接参数，不含凭据） */
export function mailProviderList(): Promise<ApiResult<MailProviderPresetView[]>> {
  return ipc.mailProviderList();
}

/** 运价表快照：导入时留档（一次导入 = 一条，按内容去重） */
export function shipRateSnapshotSave(payload: {
  table: unknown;
  sourceFile?: string;
  sheetName?: string;
  effectiveFrom?: string;
}) {
  return ipc.shipRateSnapshotSave(payload);
}

/** 运价表快照列表（不含整张表） */
export function shipRateSnapshotList(payload?: { limit?: number }) {
  return ipc.shipRateSnapshotList(payload);
}

/** 算账用：含整张表的快照集合（按生效日倒序） */
export function shipRateSnapshotCalc(payload?: { limit?: number }) {
  return ipc.shipRateSnapshotCalc(payload);
}

/** 订阅邮件同步事件（主进程→渲染层单向广播）；返回退订函数 */
export function onMailSyncEvent(cb: (event: MailSyncEvent) => void): () => void {
  return ipc.onMailSyncEvent(cb);
}

// ---------------------------------------------------------------------------
// 产品库（产品主数据）
// ---------------------------------------------------------------------------

/** 幂等建表（视图首次激活时调用） */
export function productDbEnsure(): Promise<ApiResult<{ ok: boolean }>> {
  return ipc.productDbEnsure();
}

/** 产品列表（关键字 / 状态 / 厂家过滤 + 分页；按编码升序） */
export function productList(payload?: {
  search?: string;
  status?: ProductStatus | '';
  supplierId?: number;
  /** 只看未关联厂家的款（与 `supplierId` 互斥，同时给时以本项为准） */
  withoutSupplier?: boolean;
  /** 只看至少有一个 SKU 缺克重的款 */
  onlyMissingWeight?: boolean;
  offset?: number;
  limit?: number;
}): Promise<ApiResult<{ rows: ProductListItem[]; total: number }>> {
  return ipc.productList(payload);
}

/** 单条产品详情（不存在返回 null） */
export function productGet(id: number): Promise<ApiResult<ProductListItem | null>> {
  return ipc.productGet({ id });
}

/** 新增/更新产品（全量提交；编码唯一，冲突时主进程抛错） */
export function productUpsert(
  payload: ProductUpsertInput
): Promise<ApiResult<{ id: number; created: boolean }>> {
  return ipc.productUpsert(payload);
}

/** 删除产品（物理删除；已进入业务链路的应改为 status='archived'） */
export function productDelete(id: number): Promise<ApiResult<{ deleted: boolean }>> {
  return ipc.productDelete({ id });
}

/** 产品汇总（总数 / 按状态 / 厂家分布 / 未关联厂家数；supplierOptions 为全量厂家，供下拉） */
export function productSummary(): Promise<ApiResult<ProductSummary>> {
  return ipc.productSummary();
}

/** 产品 Excel 批量导入（单事务）；mode='insertOnly' 时编码已存在的行记为失败而不覆盖 */
export function productImport(payload: {
  items: ProductImportRowInput[];
  mode?: 'upsert' | 'insertOnly';
}): Promise<ApiResult<ProductImportOutcome>> {
  return ipc.productImport(payload);
}

/** 保存渲染层生成的 xlsx（弹保存框） */
export function productExport(payload: {
  buffer: ArrayBuffer;
  defaultName?: string;
}): Promise<ApiResult<{ filePath: string }>> {
  return ipc.productExport(payload);
}

/** 映射列表（店铺商品ID → 产品；关键字 / 状态 / 店铺过滤 + 分页） */
export function productSkuList(payload?: {
  search?: string;
  status?: SkuMapStatus | '';
  shopId?: number;
  offset?: number;
  limit?: number;
}): Promise<ApiResult<{ rows: ShopSkuRow[]; total: number }>> {
  return ipc.productSkuList(payload);
}

/** 映射汇总（总数 / 按状态 / 按平台 / 按店铺；不扫订单） */
export function productSkuSummary(): Promise<ApiResult<SkuMapSummary>> {
  return ipc.productSkuSummary();
}

/** 待关联队列（实时聚合 oi_orders 的商品ID，减去已有生效映射） */
export function productSkuQueue(payload?: {
  limit?: number;
  maxRows?: number;
}): Promise<ApiResult<{ rows: SkuQueueRow[]; stats: SkuQueueStats }>> {
  return ipc.productSkuQueue(payload);
}

/** 批量关联 / 改绑（单事务；行级失败逐行报回） */
export function productSkuMap(payload: {
  rows: SkuMapInputPayload[];
}): Promise<
  ApiResult<{
    created: number;
    updated: number;
    reassigned: number;
    failed: { itemId: string; message: string }[];
  }>
> {
  return ipc.productSkuMap(payload);
}

/** 标失效（商品ID 会变；不物理删除） */
export function productSkuInvalidate(id: number): Promise<ApiResult<{ changed: boolean }>> {
  return ipc.productSkuInvalidate({ id });
}

/** 按款批量拉 SKU（pl_variants） */
export function productVariantList(
  productIds: number[],
): Promise<ApiResult<{ rows: VariantRow[] }>> {
  return ipc.productVariantList({ productIds });
}

/** 新增 / 更新 SKU（全量提交；同款下名称唯一，编码非空时全局唯一） */
export function productVariantUpsert(
  payload: VariantUpsertInput,
): Promise<ApiResult<{ id: number; created: boolean }>> {
  return ipc.productVariantUpsert(payload);
}

/** 删除 SKU */
export function productVariantDelete(id: number): Promise<ApiResult<{ removed: number }>> {
  return ipc.productVariantDelete({ id });
}

/** 产品批量编辑（部分 patch：只传要改的字段，undefined = 不修改） */
export function productBatchUpdate(
  payload: ProductBatchUpdateInput,
): Promise<ApiResult<{ updated: number }>> {
  return ipc.productBatchUpdate(payload);
}

/** 设置款主图（srcPath 须来自用户经对话框选择的文件） */
export function productImageAttach(payload: {
  productId: number;
  srcPath: string;
}): Promise<ApiResult<{ imageId: number; localPath: string; reused: boolean }>> {
  return ipc.productImageAttach(payload);
}

/** 移除款主图 */
export function productImageDetach(productId: number): Promise<ApiResult<{ changed: boolean }>> {
  return ipc.productImageDetach({ productId });
}

/** 设置商品ID的手动覆盖图 */
export function productItemImageSet(payload: {
  itemId: string;
  srcPath: string;
}): Promise<ApiResult<{ imageId: number; localPath: string; reused: boolean; itemId: string }>> {
  return ipc.productItemImageSet(payload);
}

/** 清除商品ID的覆盖图（回到自动聚合回落链） */
export function productItemImageClear(itemId: string): Promise<ApiResult<{ removed: number }>> {
  return ipc.productItemImageClear({ itemId });
}

/** 批量取商品ID的候选图（三层回落：覆盖图 → 订单图 → 款主图） */
export function productItemImagePool(
  itemIds: string[],
): Promise<ApiResult<{ pool: Record<string, ItemImagePoolEntry> }>> {
  return ipc.productItemImagePool({ itemIds });
}

/* ============================================================================
   「货与成本」渲染层包装（2026-10-01）
   ----------------------------------------------------------------------------
   下列通道**本来就在 `ElectronApi` 接口里**（preload 与主进程都已实现，`verify` 三方一致），
   只是从来没导出过渲染层包装函数 —— 因为唯一的调用方是「产品库」UI 岛，它走的是
   `window.__sk` 桥（`DB_OPS`）而不是 `ipc.*`。

   岛的功能迁回内建「货与成本」后，渲染层成了第一个消费者，故在此补包装。
   ⚠️ 只是「加一层导出」，**不动 preload / types / 主进程** —— 通道名一个没改，
      所以不涉及 IPC 契约的变更（`npm run verify` 的判据是通道名三方一致）。
   ============================================================================ */

/** 选 Excel 文件（返回**原始字节**；解析交给 `core/services/excel` 或 `@/lib/productImport`） */
export function selectExcel(): Promise<ApiResult<ExcelFilePayload>> {
  return ipc.selectExcel();
}

/** 选图片文件（返回路径；主进程按"用户亲手选过"的信任层级处理） */
export function selectImage(): Promise<ApiResult<{ filePath: string }>> {
  return ipc.selectImage();
}

/** 供应商（厂家）主数据 —— owner 是 `purchase-db.ts` 的 `suppliers` 表，拿货/付款也引用它 */
export function purchaseSupplierList(): Promise<ApiResult<Supplier[]>> {
  return ipc.purchaseSupplierList();
}

export function purchaseSupplierCreate(payload: {
  name: string;
  phone?: string;
  note?: string;
}): Promise<ApiResult<{ id: number }>> {
  return ipc.purchaseSupplierCreate(payload);
}

export function purchaseSupplierUpdate(payload: {
  id: number;
  phone?: string;
  note?: string;
}): Promise<ApiResult<unknown>> {
  return ipc.purchaseSupplierUpdate(payload);
}

/** 删除厂家：已有拿货单 / 付款记录时**宿主拒绝**（保护对账历史） */
export function purchaseSupplierDelete(id: number): Promise<ApiResult<unknown>> {
  return ipc.purchaseSupplierDelete({ id });
}

/* ---- 店铺商品清单（按 item_id 去重，一件商品可一对多关联产品）---- */

export function shopProductImport(payload: {
  items: { itemId: string; shopId: number; imageUrl: string }[];
}): Promise<ApiResult<{ imported: number; updated: number }>> {
  return ipc.shopProductImport(payload);
}

export function shopProductList(payload?: {
  offset?: number;
  limit?: number;
  search?: string;
}): Promise<ApiResult<{ rows: ShopProductItem[]; total: number }>> {
  return ipc.shopProductList(payload);
}

export function shopProductDelete(itemId: string): Promise<ApiResult<{ removed: number }>> {
  return ipc.shopProductDelete({ itemId });
}

export function shopProductRelations(itemId: string): Promise<ApiResult<ShopProductRelation[]>> {
  return ipc.shopProductRelations({ itemId });
}

export function shopProductRelationAdd(payload: {
  itemId: string;
  productId: number;
}): Promise<ApiResult<{ id: number; created: boolean }>> {
  return ipc.shopProductRelationAdd(payload);
}

export function shopProductRelationDelete(id: number): Promise<ApiResult<{ removed: number }>> {
  return ipc.shopProductRelationDelete({ id });
}

/** 店铺实体：幂等建表（视图首次激活时调用） */
export function shopDbEnsure(): Promise<ApiResult<{ ok: boolean }>> {
  return ipc.shopDbEnsure();
}

/** 店铺列表（关键字 / 平台 / 状态过滤 + 分页） */
export function shopList(payload?: {
  search?: string;
  platform?: string;
  status?: ShopStatus | '';
  offset?: number;
  limit?: number;
}): Promise<ApiResult<{ rows: ShopListItem[]; total: number }>> {
  return ipc.shopList(payload);
}

/** 店铺单条详情（不存在返回 null） */
export function shopGet(id: number): Promise<ApiResult<ShopListItem | null>> {
  return ipc.shopGet({ id });
}

/** 店铺新增/更新（全量提交；同平台同名冲突时主进程抛错） */
export function shopUpsert(
  payload: ShopUpsertInput
): Promise<ApiResult<{ id: number; created: boolean }>> {
  return ipc.shopUpsert(payload);
}

/** 店铺汇总（店铺侧 + 三处历史文本的归一进度） */
export function shopSummary(): Promise<ApiResult<ShopSummary>> {
  return ipc.shopSummary();
}

/** 未归一的历史店铺名（实时聚合三处文本） */
export function shopUnmapped(): Promise<ApiResult<UnmappedShopRow[]>> {
  return ipc.shopUnmapped();
}

/** 归一指派 / 标记忽略 */
export function shopMap(payload: {
  raw: string;
  refId?: number;
  ignored?: boolean;
  kind?: NameMapKind;
  note?: string;
}): Promise<ApiResult<{ key: string; refId: number; ignored: boolean }>> {
  return ipc.shopMap(payload);
}

/** 撤销归一（回到未归一名单） */
export function shopUnmap(payload: {
  raw: string;
  kind?: NameMapKind;
}): Promise<ApiResult<{ removed: number }>> {
  return ipc.shopUnmap(payload);
}

/** 运费原始行（oi_orders 最小投影，只读；供按订单算运费的宿主 op 提取） */
/** 把订单归属到某店铺（AE 导出按店铺、无店铺列 → 由人在导入后指定） */
export function orderAssignShop(payload: { orderNos: string[]; shopName: string }) {
  return ipc.orderAssignShop(payload);
}

export function orderShippingRows(payload?: {
  limit?: number;
  source?: 'all' | 'import' | 'collect';
}): Promise<ApiResult<UnifiedOrderRow[]>> {
  return ipc.orderShippingRows(payload);
}

/** 插入一条订单（`imageId: null` = 无图订单，S2-b 免图导入） */
export function orderInsert(order: OrderRecord): Promise<ApiResult<{ id: number }>> {
  return ipc.orderInsert(order);
}

/**
 * 下载订单主图（URL 指纹 / 内容指纹命中即复用既有 `oi_images` 行，不重复落盘）。
 * 返回的 `id` 直接作为 `orderInsert` 的 `imageId`（带图导入的接线点）。
 */
export function orderDownloadImage(url: string): Promise<ApiResult<OrderImageRecord>> {
  return ipc.orderDownloadImage(url);
}

/** 按路径读 Excel（**原始字节**；解析交给 `core/services/excel` / `core/services/importSheet`）。
 * 此前只有 `ElectronApi` 上的声明、没有导出包装函数（新代码想用只得摸 `ipc` 实例）——与 `orderImageThumbBatch` 同款缺口，一并补上。 */
export function importExcelByPath(filePath: string): Promise<ApiResult<ExcelFilePayload>> {
  return ipc.importExcelByPath(filePath);
}

/**
 * 单次往返的图片数上限。**必须与主进程 `order-handlers.ts` 的 `THUMB_BATCH_MAX` 一致** ——
 * 那侧是硬截断（`payload.items.slice(0, THUMB_BATCH_MAX)`），而调用方是按页/按批给路径的
 * （产品页一页 50 行、拣货单可能上百），不在这侧拆批就会有若干行的图**静默变空占位**。
 */
const THUMB_BATCH_MAX = 40;

/**
 * 批量缩略图：返回顺序与 `items` 完全一致，单项无效为 null。
 * 超过单次上限自动拆批（顺序不乱、失败批次按 null 补位）—— 调用方给多少张都要能拿到答案。
 */
export async function orderImageThumbBatch(
  items: { localPath: string; maxEdge?: number }[]
): Promise<ApiResult<{ dataUrls: (string | null)[] }>> {
  const all = Array.isArray(items) ? items : [];
  if (!all.length) return { success: true, data: { dataUrls: [] } };
  const dataUrls: (string | null)[] = [];
  for (let i = 0; i < all.length; i += THUMB_BATCH_MAX) {
    const chunk = all.slice(i, i + THUMB_BATCH_MAX);
    const r = await ipc.orderImageThumbBatch(chunk);
    const part = r?.data?.dataUrls;
    if (r?.success && Array.isArray(part) && part.length === chunk.length) {
      dataUrls.push(...part);
    } else {
      // 整批失败不让其余批次的结果作废：这一段按 null 补位（界面显示空占位，不静默错位）
      for (let k = 0; k < chunk.length; k++) dataUrls.push(null);
    }
  }
  return { success: true, data: { dataUrls } };
}

/** 导出 xlsx（弹保存框；buffer 由渲染层用 xlsx 生成） */
export function orderExportExcel(
  buffer: ArrayBuffer,
  defaultName?: string
): Promise<ApiResult<ExportExcelResult>> {
  return ipc.orderExportExcel(buffer, defaultName);
}

/** 拣货投影（只读）：未发货订单行 + 图 + 款色码/供应商 —— 聚合在纯层 `src/lib/picking.ts` */
export function pickingRows(payload?: {
  limit?: number;
  shop?: string;
  includeShipped?: boolean;
}): Promise<ApiResult<PickingRowsResult>> {
  return ipc.pickingRows(payload);
}

/** 拣货单导出（带图 + 按厂家分表）：主进程 exceljs 生成后弹保存对话框。
 *  用户点取消时返回 `{ success:false, error:'__canceled__' }` —— 调用方按"不算失败"处理。 */
export function pickingExportExcel(payload: {
  rows: PickingExportRow[];
  defaultName?: string;
}): Promise<ApiResult<ExportExcelResult & { rows: number }>> {
  return ipc.pickingExportExcel(payload);
}
