export interface ElectronAPI {
  selectExcel: () => Promise<APIResult<ExcelFileResult>>;
  importExcelByPath: (filePath: string) => Promise<APIResult<ExcelFileResult | TemplateFileResult>>;
  selectTemplate: () => Promise<APIResult<TemplateFileResult>>;
  saveTemplate: (filePath: string, content: string) => Promise<APIResult<void>>;
  writeClipboard: (text: string) => Promise<APIResult<void>>;
  loadState: () => Promise<APIResult<AppState>>;
  saveState: (data: Partial<AppState>) => Promise<APIResult<void>>;
  checkFileExists: (filePath: string) => Promise<APIResult<boolean>>;
  readFile: (filePath: string) => Promise<APIResult<ExcelFileResult | TemplateFileResult>>;
  getDefaultTemplatePath: () => Promise<APIResult<string>>;
  getAppVersion: () => Promise<APIResult<string>>;
  resetStore: () => Promise<APIResult<void>>;
  // 数据备份/恢复（换机迁移）：选目录 / 导出 / 导入 / 打开数据目录
  selectDirectory: () => Promise<APIResult<string>>;
  backupExport: (targetDir: string) => Promise<APIResult<BackupSummary>>;
  backupImport: (backupDir: string) => Promise<APIResult<void>>;
  openDataDir: () => Promise<APIResult<string>>;
  netRequest: (payload: NetRequestPayload) => Promise<APIResult<NetRequestResult>>;
  // 订单归类模块（SQLite 指纹库 / 订单 / 主图）
  orderDbEnsure: () => Promise<APIResult<void>>;
  orderImageFind: (fingerprint: string) => Promise<APIResult<OrderImageRecord | null>>;
  orderImageSave: (payload: { id: number; status: 'done' | 'error'; resultJson?: string; error?: string }) => Promise<APIResult<void>>;
  orderInsert: (order: OrderRecord) => Promise<APIResult<{ id: number }>>;
  orderGroupStats: (dimensions: string[]) => Promise<APIResult<GroupStat[]>>;
  /** 订单列表（分页 + 关键字搜索）：{ offset?, limit?, corrected?, search? } → { rows, total }；列表不含 raw_fields */
  orderList: (payload?: {
    offset?: number;
    limit?: number;
    corrected?: boolean;
    /** 关键字（单号/店铺/分类/颜色/logo/款编码/款名/款色），匹配为空串视为不筛选 */
    search?: string;
  }) => Promise<APIResult<{ rows: OrderRecord[]; total: number }>>;
  orderClear: () => Promise<APIResult<void>>;
  orderDownloadImage: (url: string) => Promise<APIResult<OrderImageRecord>>;
  orderReadImage: (localPath: string) => Promise<APIResult<ImageDataUrl>>;
  /** 缩略图（主进程等比缩放 + LRU，≤maxEdge px JPEG dataURL） */
  orderImageThumb: (payload: { localPath: string; maxEdge?: number }) => Promise<APIResult<{ dataUrl: string }>>;
  /** 批量缩略图（渲染层同帧多图合并一次往返）：返回顺序与 items 一致，单项无效为 null */
  orderImageThumbBatch: (items: { localPath: string; maxEdge?: number }[]) => Promise<APIResult<{ dataUrls: (string | null)[] }>>;
  /** 识别引擎 API Key：safeStorage 加密落盘（渲染层不落明文） */
  orderApiKeySet: (apiKey: string) => Promise<APIResult<{ stored: boolean }>>;
  orderApiKeyGet: () => Promise<APIResult<{ apiKey: string }>>;
  /** 清理不被数据库引用的孤儿图片文件（返回释放数量与字节） */
  orderCleanupOrphanImages: () => Promise<APIResult<{ deleted: number; freedBytes: number }>>;
  // 产品库导入「图片」列：读取用户指定的本地图片（任意路径，仅图片扩展名，≤10MB）
  orderReadLocalImage: (localPath: string) => Promise<APIResult<ImageDataUrl>>;
  orderExportExcel: (buffer: ArrayBuffer, defaultName?: string) => Promise<APIResult<{ filePath: string }>>;
  // ---- 待识别队列（订单归类：导入行整批落库 oi_queue，失败/缺图重启不丢、可增量重试）----
  orderQueueEnqueue: (payload: { batchNo: string; rows: OrderQueueEnqueueRow[] }) => Promise<APIResult<{ count: number }>>;
  orderQueueStats: (payload: { batchNo: string }) => Promise<APIResult<OrderQueueStats>>;
  /** 队列行分页：失败清单用 { status:'error' }，缺图清单用 { missingOnly:true }；列表不含 raw_fields，返回 { rows, total } */
  orderQueueList: (payload: {
    batchNo: string;
    offset?: number;
    limit?: number;
    status?: OrderQueueStatus | 'all';
    /** 缺图待补（status 为 pending/missing 且 url 为空） */
    missingOnly?: boolean;
  }) => Promise<APIResult<{ rows: OrderQueueRow[]; total: number }>>;
  /** 单行队列行（含 raw_fields）：补图等按需取，避免列表全量携带大字段 */
  orderQueueGet: (id: number) => Promise<APIResult<OrderQueueRow>>;
  orderQueueNextPending: (payload: { batchNo: string; afterId: number; limit: number }) => Promise<APIResult<OrderQueueRow[]>>;
  orderQueueSetResult: (payload: { id: number; status: 'done' | 'error' | 'missing'; error?: string }) => Promise<APIResult<void>>;
  orderQueuePatch: (payload: { id: number; url: string; rawFields: Record<string, string> }) => Promise<APIResult<void>>;
  orderQueueRetryErrors: (payload: { batchNo: string }) => Promise<APIResult<{ count: number }>>;
  orderQueuePurgeDone: (payload: { batchNo: string }) => Promise<APIResult<{ count: number }>>;
  orderQueueLastActive: () => Promise<APIResult<{ batchNo: string; stats: OrderQueueStats } | null>>;
  // 款编码/款色（产品库主数据）
  orderStyleResolve: (payload: { imageId: number; fingerprint: string; category: string; features: string[]; color: string; styleName?: string }) => Promise<APIResult<{ styleCode: string; styleColorCode: string }>>;
  orderStyleList: () => Promise<APIResult<StyleRecord[]>>;
  orderStyleDelete: (payload: { id: number }) => Promise<APIResult<{ deleted: number }>>;
  // 手动归并款式：订单挂到指定款编码 + 记入附加指纹（后续自动识别命中同一款编码）
  orderStyleAssign: (payload: { orderId: number; styleId: number; color: string; fingerprint?: string }) => Promise<APIResult<{ styleCode: string; styleColorCode: string }>>;
  // 修改款式展示名（款编码级）
  orderStyleRename: (payload: { code: string; name: string }) => Promise<APIResult<{ code: string; name: string }>>;
  // 产品库 Excel 批量导入（指纹由渲染层生成）
  orderStyleImport: (payload: { styles: StyleImportItem[] }) => Promise<APIResult<StyleImportResult>>;
  orderUpdate: (payload: OrderUpdateInput) => Promise<APIResult<{ styleCode?: string; styleColorCode?: string }>>;
  orderUpdateStatus: (payload: OrderUpdateStatusInput) => Promise<APIResult<{ status: OrderStatus }>>;
  orderDelete: (payload: { id: number }) => Promise<APIResult<{ deleted: number }>>;
  // 批量标记订单已核对（数据纠正页「确认无误」/「全部确认无误」置 corrected=1，不改识别字段）
  // ids: number[] 部分确认；{ all: true } 主进程一次 UPDATE 全量标记（避免大数组过 IPC）
  orderMarkCorrected: (input: number[] | { all: true }) => Promise<APIResult<{ updated: number }>>;
  // 拿货对账模块（厂商 / 拿货单 / 付款 / 对账 / 待拿货缺口）
  purchaseDbEnsure: () => Promise<APIResult<void>>;
  purchaseSupplierList: () => Promise<APIResult<Supplier[]>>;
  purchaseSupplierCreate: (payload: { name: string; phone?: string; note?: string }) => Promise<APIResult<{ id: number }>>;
  purchaseSupplierUpdate: (payload: { id: number; phone?: string; note?: string }) => Promise<APIResult<void>>;
  purchaseSupplierDelete: (payload: { id: number }) => Promise<APIResult<void>>;
  purchaseOrderList: () => Promise<APIResult<PurchaseOrder[]>>;
  purchaseOrderGet: (payload: { id: number }) => Promise<APIResult<PurchaseOrder>>;
  purchaseOrderCreate: (payload: {
    supplierId: number;
    bizDate: string;
    mode: 'detail' | 'package';
    note?: string;
    totalCents?: number;
    items?: PurchaseItem[];
    /** 来源订单快照（从数据统计跳转生成时锁定店铺归属；缺省时主进程按缺口自动推导） */
    sources?: PurchaseSourceRow[];
  }) => Promise<APIResult<{ id: number }>>;
  purchaseOrderUpdate: (payload: {
    id: number;
    bizDate?: string;
    note?: string;
    totalCents?: number;
    items?: PurchaseItem[];
  }) => Promise<APIResult<void>>;
  purchaseOrderSubmit: (payload: { id: number }) => Promise<APIResult<void>>;
  purchaseOrderDelete: (payload: { id: number }) => Promise<APIResult<void>>;
  purchasePaymentList: (payload?: { supplierId?: number; from?: string; to?: string }) => Promise<APIResult<Payment[]>>;
  purchasePaymentAdd: (payload: {
    supplierId: number;
    payDate: string;
    type: 'payment' | 'refund';
    amountCents: number;
    method?: string;
    note?: string;
  }) => Promise<APIResult<{ id: number }>>;
  purchasePaymentDelete: (payload: { id: number }) => Promise<APIResult<void>>;
  purchaseReconciliation: (payload?: { from?: string; to?: string }) => Promise<APIResult<ReconciliationRow[]>>;
  purchaseOutstanding: () => Promise<APIResult<OutstandingRow[]>>;
  purchaseIgnoreAdd: (payload: { styleCode: string; color?: string; reason?: string }) => Promise<APIResult<void>>;
  purchaseIgnoreRemove: (payload: { styleCode: string; color?: string }) => Promise<APIResult<void>>;
  purchaseIgnoreList: () => Promise<APIResult<IgnoreRow[]>>;
  purchasePriceHistory: (payload: { supplierId?: number; styleCode: string; color?: string }) => Promise<APIResult<{ priceCents: number }>>;
  /** 店铺对账汇总：全部已提交拿货单按来源订单拆分到店铺 */
  purchaseShopAllocation: (payload?: { from?: string; to?: string }) => Promise<APIResult<ShopAllocationRow[]>>;
  /** 指定店铺的对账明细行 */
  purchaseShopAllocationDetail: (payload: { shop: string; from?: string; to?: string }) => Promise<APIResult<ShopAllocationDetailRow[]>>;
  /** 导出拿货单 Excel（主进程生成，款编码+款色自动嵌入款色图） */
  purchaseExportExcel: (payload: { items: PurchaseItem[]; defaultName?: string }) => Promise<APIResult<{ filePath: string }>>;
  // ---- 外置插件（Phase 3：独立插件目录 <userData>/plugins）----
  /** 扫描插件目录：返回每个目录的 manifest.json 原始内容（渲染层负责严格 schema 校验） */
  pluginsScan: () => Promise<APIResult<PluginScanResult>>;
  /** 读取外置插件入口 JS 源码（主进程做路径穿越防护 + 大小限制） */
  pluginsReadEntry: (payload: { id: string; entry: string }) => Promise<APIResult<{ code: string }>>;
  /** 卸载（删除）外置插件目录 */
  pluginsUninstall: (payload: { id: string }) => Promise<APIResult<void>>;
  /** 在系统文件管理器中打开插件目录 */
  pluginsOpenDir: () => Promise<APIResult<string>>;
}

export interface APIResult<T> {
  success: boolean;
  data?: T;
  error?: string;
}

/** 主进程扫描到的外置插件目录条目（manifest.json 解析原始内容 + 派生信息） */
export interface PluginScanItem {
  /** 目录名（应等于 manifest.name） */
  id: string;
  /** 入口文件（manifest.entry ?? './index.js'） */
  entry: string;
  /** manifest.json 解析后的原始内容 */
  manifest: Record<string, unknown>;
  /** 目录读取/manifest 解析失败时的错误（其余字段可能不完整） */
  error?: string;
}

/** plugins-scan 结果：插件根目录 + 条目列表 */
export interface PluginScanResult {
  /** 插件根目录（<userData>/plugins） */
  root: string;
  plugins: PluginScanItem[];
}

/** 网络请求载荷（渲染层 → 主进程） */
export interface NetRequestPayload {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  /** 超时毫秒（可选；默认主进程 15000）。AI 视觉识别等长耗时请求可放宽 */
  timeout?: number;
}

/** 网络请求结果（主进程 → 渲染层，文本型响应） */
export interface NetRequestResult {
  ok: boolean;
  status: number;
  statusText: string;
  headers: Record<string, string>;
  data: string;
}

export interface ExcelFileResult {
  filePath: string;
  data: ArrayBuffer;
}

export interface TemplateFileResult {
  filePath: string;
  content: string;
}

export interface RecordItem {
  id: number;
  fields: Record<string, string>;
  used: boolean;
  order: number;
}

export interface TemplateConfig {
  id: string;
  name: string;
  filePath: string;
  content: string;
  isBuiltIn?: boolean;  // true=文件内置模板，false=用户自定义修改
}

/** 字段处理规则 — 对已有字段进行计算或转换，生成新的衍生字段 */
export interface ProcessingRule {
  id: string;
  name: string;
  enabled: boolean;
  targetField: string;
  type: 'dateOffset' | 'template' | 'math' | 'jsExpression';
  order: number;
  config: {
    sourceField?: string;
    packageField?: string;
    outputFormat?: string;
    template?: string;
    expression?: string;
    code?: string;
  };
}

/** 订单主图指纹记录（SQLite oi_images 表） */
export interface OrderImageRecord {
  id?: number;
  /** 内容指纹 SHA-256 */
  fingerprint: string;
  /** URL 规范化指纹 */
  urlFingerprint: string;
  sourceUrl: string;
  localPath: string;
  status: 'pending' | 'done' | 'error';
  /** AI 识别结果 JSON 原文 */
  resultJson?: string;
  /** AI 识别结果（解析后） */
  result?: Record<string, unknown>;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  /** 归属款色 id（oi_style_colors，识别确认后挂接） */
  styleColorId?: number;
}

/** 识别队列行状态：pending=待识别 / done=成功 / error=失败（可重试）/ missing=缺图（补图后重跑） */
export type OrderQueueStatus = 'pending' | 'done' | 'error' | 'missing';

/** 待识别队列入队行（导入 Excel 解析拆行后的原始记录） */
export interface OrderQueueEnqueueRow {
  /** 完整原始行（含主图列等，识别时使用） */
  rawFields: Record<string, string>;
  /** 主图 URL（可能为空=缺图） */
  url: string;
  /** 订单号（列表展示/失败排查用） */
  orderNo: string;
  /** 产品信息摘要（多产品拆行，列表展示用） */
  info: string;
}

/** 待识别队列行（SQLite oi_queue 表）：导入行落库，识别失败/缺图重启不丢，可增量重试 */
export interface OrderQueueRow extends OrderQueueEnqueueRow {
  id: number;
  /** 批次号（同一次导入共享，runProcess/补图/重试按批次操作） */
  batchNo: string;
  status: OrderQueueStatus;
  /** 最近一次失败原因 */
  error: string;
  /** 累计失败次数（重试不清零，用于持续失败告警） */
  failCount: number;
  createdAt?: string;
  updatedAt?: string;
}

/** 队列统计（概览当前批次进度/遗留） */
export interface OrderQueueStats {
  total: number;
  pending: number;
  done: number;
  error: number;
  missing: number;
}

/** 订单明细（SQLite oi_orders 表） */
export interface OrderRecord {
  id?: number;
  imageId: number;
  orderNo: string;
  shop: string;
  size: string;
  /** 下单时间（可空，来自 Excel 下单时间列） */
  orderTime?: string;
  rawFields: Record<string, string>;
  /** 归一化款式 */
  category: string;
  /** 归一化颜色 */
  color: string;
  logo: string;
  /** 发货状态（导入后默认未发货） */
  status?: OrderStatus;
  /** 是否已纠正（保存纠正后置位；数据纠正列表只展示未纠正订单） */
  corrected?: boolean;
  createdAt?: string;
  /** 联表字段：图片指纹（列表展示用） */
  fingerprint?: string;
  /** 联表字段：图片本地路径（列表展示用） */
  localPath?: string;
  /** 联表字段：款编码（如 STYLE-001，经图片→款色→款 关联） */
  styleCode?: string;
  /** 联表字段：款式名 */
  styleName?: string;
  /** 联表字段：款色（归一化颜色） */
  styleColor?: string;
  /** 联表字段：图片识别结果中的款式特征（纠正重新归类时重建指纹用） */
  features?: string[];
}

/** 款色（款式 × 颜色，oi_style_colors 表） */
export interface StyleColorRecord {
  id: number;
  styleId: number;
  color: string;
  code: string;
  /** 归属该款色的图片数 */
  imageCount: number;
  /** 代表图路径（最新一张，产品库展示用） */
  imagePath?: string;
}

/** 款编码（产品库主数据，oi_styles 表） */
export interface StyleRecord {
  id: number;
  code: string;
  /** 展示名（可改，不参与匹配） */
  name: string;
  /** 款式指纹（匹配键） */
  fingerprint: string;
  colorCount: number;
  imageCount: number;
  orderCount: number;
  /** 封面图路径（最新一张，产品库展示用） */
  coverPath?: string;
  colors: StyleColorRecord[];
  createdAt?: string;
}

/** 产品库 Excel 导入项（渲染层已生成指纹） */
export interface StyleImportItem {
  /** 款编码（可选，留空自动生成；已存在视为更新该款式） */
  code?: string;
  /** 款式名 */
  name: string;
  /** 款色（归一化颜色，必填） */
  color: string;
  /** 主指纹：按「品类+特征」用识别同一算法生成，或用户自定义指纹 */
  fingerprint: string;
  /** 附加指纹（用户显式填写、与主指纹不同的指纹） */
  extraFingerprints?: string[];
}

/** 产品库导入结果 */
export interface StyleImportResult {
  imported: number;
  /** 失败行（row 从 2 起算，第 1 行为表头）与原因 */
  errors: { row: number; message: string }[];
}

/** 订单字段纠正入参（数据纠正步骤） */
export interface OrderUpdateInput {
  id: number;
  category: string;
  color: string;
  logo: string;
  /** 重新归类用：新款指纹（styleMatcher 生成，与 category/features 一致） */
  fingerprint?: string;
  /** 重新归类用：款式特征 */
  features?: string[];
  /** true=按新款指纹重新匹配款式/款色并挂接图片 */
  reclassify: boolean;
  /** 款式名称：识别后由 category+styleName 组合展示，用户可修正；变化时同步到款编码展示名（不参与匹配） */
  styleName?: string;
  /** 手动归并目标款编码 id（>0 时订单图片挂到该款式，替代自动 reclassify 归类，并把指纹记入该款式） */
  targetStyleId?: number;
}

/** 订单发货状态：pending=未发货（导入默认），shipped=已发货 */
export type OrderStatus = 'pending' | 'shipped';

/** 订单发货状态更新入参（订单明细行内切换） */
export interface OrderUpdateStatusInput {
  id: number;
  status: OrderStatus;
}

/** 分组统计结果 */
export interface GroupStat {
  /** 组合键，如 "黑色|短袖T恤" */
  key: string;
  category: string;
  color: string;
  shop: string;
  count: number;
}

/** 图片读取结果（base64 data URL） */
export interface ImageDataUrl {
  mime: string;
  dataUrl: string;
}

/** 导出 Excel 结果 */
export interface ExportExcelResult {
  filePath: string;
}

/** 数据备份导出结果（换机迁移） */
export interface BackupSummary {
  /** 备份文件夹路径 */
  dir: string;
  /** 数据库快照字节数 */
  dbBytes: number;
  /** 图片缓存文件数与字节数 */
  imageCount: number;
  imageBytes: number;
  /** 是否包含 electron-store 配置 */
  hasConfig: boolean;
}

export interface AppState {
  lastExcelPath: string;
  lastTemplatePath: string;
  records: RecordItem[];
  templateConfigs: TemplateConfig[];
  activeTemplateId: string;
  processingRules: ProcessingRule[];
  visibleColumns: string[];
}

// ---- 拿货对账（stock-in）----

/** 厂商 */
export interface Supplier {
  id: number;
  name: string;
  phone: string;
  note: string;
  createdAt: string;
}

/** 拿货明细行（金额单位：分；粒度 = 款编码+款色+尺码） */
export interface PurchaseItem {
  /** 落库后回填；草稿新增行为 0 */
  id?: number;
  styleCode: string;
  styleName: string;
  color: string;
  /** 尺码；旧数据与无码拿货为空串 */
  size: string;
  /** 实拿数量 */
  qty: number;
  /** 单价（分） */
  priceCents: number;
  /** 金额（分）= qty × priceCents */
  amountCents: number;
  /** 生成草稿时的建议数量（仅展示） */
  suggestionQty: number;
}

/** 拿货单的来源订单快照行（生成拿货单时锁定的订单明细，含店铺/尺码，用于按店铺拆分成本） */
export interface PurchaseSourceRow {
  /** 订单所属店铺 */
  shop: string;
  styleCode: string;
  styleName?: string;
  color: string;
  size: string;
  /** 需求件数（订单行粒度通常为 1） */
  qty: number;
}

/** 店铺对账汇总行（拿货成本按来源订单拆分到店铺） */
export interface ShopAllocationRow {
  shop: string;
  /** 分摊总件数 */
  qty: number;
  /** 分摊总成本（分） */
  amountCents: number;
  /** 涉及拿货单数 */
  orderCount: number;
}

/** 店铺对账明细行 */
export interface ShopAllocationDetailRow {
  purchaseId: number;
  bizDate: string;
  supplierName: string;
  shop: string;
  styleCode: string;
  styleName: string;
  color: string;
  size: string;
  qty: number;
  priceCents: number;
  amountCents: number;
}

/** 拿货单 */
export interface PurchaseOrder {
  id: number;
  supplierId: number;
  supplierName: string;
  /** YYYY-MM-DD */
  bizDate: string;
  mode: 'detail' | 'package';
  status: 'draft' | 'submitted';
  totalCents: number;
  note: string;
  editedAt: string | null;
  createdAt: string;
  items: PurchaseItem[];
}

/** 付款记录（金额恒为正，方向由 type 区分） */
export interface Payment {
  id: number;
  supplierId: number;
  supplierName: string;
  payDate: string;
  type: 'payment' | 'refund';
  amountCents: number;
  method: string;
  note: string;
  createdAt: string;
}

/** 对账汇总行（时间窗内） */
export interface ReconciliationRow {
  supplierId: number;
  supplierName: string;
  purchaseCents: number;
  paidCents: number;
  refundCents: number;
  /** 欠款 = purchaseCents − (paidCents − refundCents) */
  balanceCents: number;
  orderCount: number;
  paymentCount: number;
}

/** 待拿货缺口（实时差量 = max(0, 需求 − 已拿)；粒度 = 款色码） */
export interface OutstandingRow {
  styleCode: string;
  styleName: string;
  color: string;
  size: string;
  demand: number;
  taken: number;
  missing: number;
}

/** 无需补货标记 */
export interface IgnoreRow {
  styleCode: string;
  color: string;
  reason: string;
  createdAt: string;
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
