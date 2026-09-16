import type { MarketCatalog, MarketPluginInfo } from './core/plugin/types';

export interface ElectronAPI {
  selectExcel: () => Promise<APIResult<ExcelFileResult>>;
  importExcelByPath: (filePath: string) => Promise<APIResult<ExcelFileResult | TemplateFileResult>>;
  selectTemplate: () => Promise<APIResult<TemplateFileResult>>;
  saveTemplate: (filePath: string, content: string) => Promise<APIResult<void>>;
  writeClipboard: (text: string) => Promise<APIResult<void>>;
  loadState: () => Promise<APIResult<AppState>>;
  saveState: (data: Partial<AppState>) => Promise<APIResult<void>>;
  /** 模块命名空间持久化（§1.4）：读取 `modules.<moduleId>` 下的数据，无数据返回 null */
  getModuleState: (moduleId: string) => Promise<APIResult<unknown>>;
  /** 模块命名空间持久化（§1.4）：写入 `modules.<moduleId>`，模块之间互不污染 */
  setModuleState: (moduleId: string, data: unknown) => Promise<APIResult<void>>;
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
  /** 运行平台标识（`process.platform`，非 IPC 通道）；标题栏样式与平台判定用 */
  platform: string;
  /** 自定义标题栏窗口控制：最小化 / 最大化切换 / 关闭 */
  controlWindow: (action: 'minimize' | 'maximize' | 'close') => Promise<APIResult<void>>;
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
  // 速卖通利润追踪（ae-profit / M0）：入站数据走 localhost 接收端，本区仅查询类 IPC
  aeDbEnsure: () => Promise<APIResult<void>>;
  aeOrderList: (payload?: { offset?: number; limit?: number; search?: string }) => Promise<APIResult<{ rows: AeOrderListItem[]; total: number }>>;
  aeSummary: () => Promise<APIResult<AeSummary>>;
  aeReceiverStatus: () => Promise<APIResult<AeReceiverStatus>>;
  // M1 利润追踪扩展：利润统计 / 成本快照 / 汇率维护 / 拿货成本只读导出
  aeProfitStats: (payload?: { granularity?: 'day' | 'month'; rangeDays?: number }) => Promise<APIResult<AeProfitOverview>>;
  aeCostMapImport: (payload: { items: AeCostMapImportItem[] }) => Promise<APIResult<{ replaced: number }>>;
  aeCostMapList: () => Promise<APIResult<AeCostMapItem[]>>;
  aeRateList: () => Promise<APIResult<AeRateItem[]>>;
  aeRateUpsert: (payload: { fromCurrency: string; rateToCny: number }) => Promise<APIResult<{ ok: boolean }>>;
  purchaseCostSnapshot: () => Promise<APIResult<{ items: PurchaseCostSnapshotItem[]; count: number }>>;
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
  // ---- 店铺账号管家（以「店铺套 · 邮箱」为单位维护店群账号）----
  /** 幂等建表（视图首次激活时调用） */
  shopAccountDbEnsure: () => Promise<APIResult<void>>;
  /** 店铺套列表（关键字/状态/平台过滤；永不返回明文密码，仅 secretKeys 标记哪些敏感字段已配置） */
  shopAccountList: (payload?: {
    search?: string;
    status?: ShopAccountStatus | '';
    platform?: string;
  }) => Promise<APIResult<ShopAccountItem[]>>;
  /** 单套详情（含解密后的敏感字段，仅编辑时使用） */
  shopAccountGet: (payload: { id: number }) => Promise<APIResult<ShopAccountDetail | null>>;
  /** 汇总（总数 / 按状态计数 / 平台选项去重计数） */
  shopAccountSummary: () => Promise<APIResult<ShopAccountSummary>>;
  /** 当前系统安全存储是否可用（不可用时前端提示密码降级存储风险） */
  shopAccountSecurity: () => Promise<APIResult<{ secureStorage: boolean }>>;
  /** 新增/更新店铺套（secrets 缺省=保持、空串=清空、非空=覆盖；密码在主进程加密后落库） */
  shopAccountUpsert: (
    payload: ShopAccountUpsertInput,
  ) => Promise<APIResult<{ id: number; secureStorage: boolean }>>;
  shopAccountDelete: (payload: { id: number }) => Promise<APIResult<{ deleted: boolean }>>;
  /** 按需解密单个敏感字段（复制/查看，避免整条详情往返） */
  shopAccountReveal: (payload: {
    id: number;
    field: ShopAccountSecretKey;
  }) => Promise<APIResult<{ value: string }>>;
  /**
   * 批量修改店铺套（仅作用于非敏感字段；敏感密码字段在批量操作中不被允许）
   * - ids：待改店铺 id 列表（自动去重，仅保留正整数）
   * - patch：单字段修改指令；未声明的字段 = 不改
   *   - status：覆盖
   *   - company / tags / note：{ mode: 'set' | 'append', value }
   *   - platforms：{ mode: 'set' | 'append' | 'remove', values: string[] }
   */
  shopAccountBatchUpdate: (
    payload: ShopAccountBatchUpdateInput,
  ) => Promise<APIResult<ShopAccountBatchUpdateResult>>;
  // ---- 外置插件（Phase 3：独立插件目录 <userData>/plugins）----
  /** 扫描插件目录：返回每个目录的 manifest.json 原始内容（渲染层负责严格 schema 校验） */
  pluginsScan: () => Promise<APIResult<PluginScanResult>>;
  /** 读取外置插件入口 JS 源码（主进程做路径穿越防护 + 大小限制） */
  pluginsReadEntry: (payload: { id: string; entry: string }) => Promise<APIResult<{ code: string }>>;
  /** 卸载（删除）外置插件目录 */
  pluginsUninstall: (payload: { id: string }) => Promise<APIResult<void>>;
  /** 在系统文件管理器中打开插件目录 */
  pluginsOpenDir: () => Promise<APIResult<string>>;
  // ---- 插件市场（Market：catalog 拉取 + zip 安装，主进程净化/校验）----
  /** 拉取市场 catalog（净化后的合法条目列表） */
  pluginMarketCatalog: (payload: { url: string }) => Promise<APIResult<MarketCatalog>>;
  /** 安装/更新市场插件：下载 zip → sha256 → 解压校验 → 落盘 <userData>/plugins/<id>/；force=true 允许覆盖同版本 */
  pluginMarketInstall: (
    payload: { item: MarketPluginInfo; force?: boolean },
  ) => Promise<APIResult<{ id: string; version: string }>>;
  // ---- 软件更新（GitHub Releases 自动更新）----
  /** 触发检查更新：{ mode:'dev' }（开发模式不检查）/ { mode:'release' }；结果经 updater-event 事件异步送达 */
  checkForUpdates: () => Promise<APIResult<{ mode: 'dev' | 'release'; currentVersion: string }>>;
  /** 立即重启并安装已下载更新 */
  quitAndInstallUpdate: () => Promise<APIResult<void>>;
  /** 订阅更新事件（主进程→渲染层单向推送）；返回退订函数 */
  onUpdaterEvent: (cb: (event: UpdaterEventPayload) => void) => () => void;
  // ---- 集中邮件收件箱（IMAP 只读同步）----
  /** 幂等建表（视图首次激活时调用） */
  mailDbEnsure: () => Promise<APIResult<{ ok: boolean }>>;
  /** 已接入邮箱列表（含同步状态；不含任何凭据） */
  mailAccountList: () => Promise<APIResult<MailAccountItem[]>>;
  /** 接入/更新邮箱（授权码只进不出） */
  mailAccountUpsert: (payload: MailAccountUpsertInput) => Promise<APIResult<{ id: number }>>;
  /** 取消接入（连带删除已缓存邮件） */
  mailAccountDelete: (payload: { id: number }) => Promise<APIResult<{ deleted: boolean }>>;
  /** 连接测试：只读打开 INBOX 后即登出，不落库 */
  mailAccountTest: (payload: {
    email: string;
    authPassword: string;
    providerId?: string;
    host?: string;
    port?: number;
    secure?: boolean;
  }) => Promise<APIResult<MailConnectionTestResult>>;
  /** 触发同步（省略 accountId = 全部启用账号） */
  mailSyncNow: (payload?: { accountId?: number }) => Promise<APIResult<{ queued: number[] }>>;
  /** 取消同步（下一批次边界生效） */
  mailSyncCancel: (payload: { accountId: number }) => Promise<APIResult<{ cancelled: boolean }>>;
  /** 当前同步队列状态 */
  mailSyncState: () => Promise<APIResult<{ active: number[]; queued: number[] }>>;
  /** 邮件列表（纯本地查询，不触网） */
  mailMessagesList: (
    payload?: MailMessageListFilter,
  ) => Promise<APIResult<{ items: MailMessageItem[]; total: number }>>;
  /** 邮件详情（含正文与附件元信息） */
  mailMessageGet: (payload: { id: number }) => Promise<APIResult<MailMessageDetail | null>>;
  /** 本地已读标记（ids 为空 + accountId/all 时按账号批量） */
  mailMessageRead: (payload: {
    ids?: number[];
    accountId?: number;
    all?: boolean;
    read?: boolean;
  }) => Promise<APIResult<{ changed: number; unread: number }>>;
  /** 按需补拉正文（M2-1：超大邮件只缓存了预览，点开时现拉原文） */
  mailBodyFetch: (payload: {
    accountId?: number;
    messageId: number;
  }) => Promise<APIResult<MailMessageDetail | null>>;
  /** 附件另存（M2-2：弹系统保存对话框后落盘；用户取消时 canceled=true） */
  mailAttachmentSave: (payload: {
    messageId: number;
    attachmentId: number;
  }) => Promise<APIResult<{ canceled: boolean; path: string; size: number }>>;
  /** 附件预览（M3-1：命中本地缓存不触网；图片返回 data URL） */
  mailAttachmentPreview: (payload: {
    messageId: number;
    attachmentId: number;
  }) => Promise<APIResult<MailAttachmentPreview>>;
  /** 附件用系统默认应用打开（M3-1） */
  mailAttachmentOpen: (payload: {
    messageId: number;
    attachmentId: number;
  }) => Promise<APIResult<{ path: string }>>;
  /** 拉取服务端文件夹列表（M3-3：设置页勾选同步目录） */
  mailFoldersList: (payload: { accountId: number }) => Promise<APIResult<MailRemoteFolder[]>>;
  /** 附件本地缓存占用（M3-1） */
  mailCacheStatus: () => Promise<APIResult<MailCacheStatus>>;
  /** 清空附件本地缓存 */
  mailCacheClear: () => Promise<APIResult<{ removed: number }>>;
  /** 打开附件缓存目录 */
  mailCacheOpen: () => Promise<APIResult<{ opened: boolean }>>;
  /** FTS5 全文索引状态（M3-2） */
  mailFtsStatus: () => Promise<APIResult<MailFtsStatus>>;
  /** 重建全文索引（M3-2） */
  mailFtsRebuild: () => Promise<APIResult<{ total: number; indexed: number }>>;
  /** 手动清理窗口外的过期邮件 */
  mailPurge: (payload?: { accountId?: number; days?: number }) => Promise<APIResult<{ deleted: number }>>;
  /** 收件箱汇总 */
  mailStats: () => Promise<APIResult<MailStats>>;
  /** 支持的邮箱服务商预设（只读展示，含授权码获取指引） */
  mailProviderList: () => Promise<APIResult<MailProviderPresetView[]>>;
  /** 订阅同步事件（主进程→渲染层单向推送）；返回退订函数 */
  onMailSyncEvent: (cb: (event: MailSyncEvent) => void) => () => void;
}

/** 更新事件载荷（主进程 updater.ts 经 updater-event 通道广播，最小安全字段） */
export interface UpdaterEventPayload {
  type:
    | 'checking'
    | 'update-available'
    | 'update-not-available'
    | 'download-progress'
    | 'update-downloaded'
    | 'updater-error';
  version?: string;
  percent?: number;
  message?: string;
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

// ---- 店铺账号管家（shop-accounts 视图插件）----
//
// 业务模型：一行 = 一套店铺（店群中的一个邮箱主体），邮箱为业务主标识。
// 一套店铺 = 邮箱 + 店铺密码 / 邮箱密码 / 关联手机号 / 关联企业名称
//          / 关联支付宝 + 支付密码 / 紫鸟账号 + 紫鸟密码 / ERP账号 + ERP密码
//          / 关联平台（可多选，既支持单平台，也支持一个邮箱跨平台复用）/ 状态 / 标签 / 备注

/** 店铺状态：在用 / 停用 / 封店 / 已注销 */
export type ShopAccountStatus = 'active' | 'paused' | 'banned' | 'closed';

/**
 * 敏感字段键（统一经主进程 safeStorage 加密落库；列表接口永不返回明文）
 * mailAuthPwd = IMAP 授权码（集中邮件收件箱专用，与 emailPwd 登录密码是两套凭据）
 */
export type ShopAccountSecretKey =
  | 'shopPwd'
  | 'emailPwd'
  | 'alipayPwd'
  | 'ziniaoPwd'
  | 'erpPwd'
  | 'mailAuthPwd';

/**
 * 账号编辑器里直接维护的敏感字段（不含 mailAuthPwd）。
 * IMAP 授权码由「收件箱接入」流程单独维护（mailAccountUpsert），不进入店铺套的密码组，
 * 避免在同一处混用两套语义不同的邮箱凭据。
 */
export type ShopAccountSecretField = Exclude<ShopAccountSecretKey, 'mailAuthPwd'>;

/** 店铺套列表行（可检索元数据 + 已配置的敏感字段标记，不含任何明文密码） */
export interface ShopAccountItem {
  id: number;
  /** 店铺邮箱（业务主标识，唯一） */
  email: string;
  /** 关联手机号 */
  phone: string;
  /** 关联企业名称 */
  company: string;
  /** 关联支付宝（运费扣款） */
  alipay: string;
  /** 关联紫鸟账号 */
  ziniaoAccount: string;
  /** ERP 账号 */
  erpAccount: string;
  /** 关联平台（单平台 = 长度 1；跨平台复用 = 多项） */
  platforms: string[];
  /** 开店时间（YYYY-MM-DD；空串 = 未填写） */
  openedAt: string;
  status: ShopAccountStatus;
  tags: string;
  note: string;
  /** 已配置值的敏感字段（仅供 UI 展示「已保存」徽标，不含任何明文） */
  secretKeys: ShopAccountSecretKey[];
  createdAt: string;
  updatedAt: string;
}

/** 店铺套详情（含解密后的敏感字段，仅编辑时获取） */
export interface ShopAccountDetail extends ShopAccountItem {
  secrets: Partial<Record<ShopAccountSecretKey, string>>;
}

/**
 * 店铺套写入入参
 * - secrets：字段缺省 = 保持原值；空串 = 清空；非空 = 覆盖
 * - platforms：undefined = 保持原值；数组（含空数组）= 覆盖
 */
export interface ShopAccountUpsertInput {
  id?: number;
  email?: string;
  phone?: string;
  company?: string;
  alipay?: string;
  ziniaoAccount?: string;
  erpAccount?: string;
  platforms?: string[];
  /** 开店时间（YYYY-MM-DD）；字符串（含空串）= 覆盖，缺省 = 保持原值 */
  openedAt?: string;
  status?: ShopAccountStatus;
  tags?: string;
  note?: string;
  secrets?: Partial<Record<ShopAccountSecretKey, string>>;
}

/** 平台选项（去重 + 该平台店铺套数） */
export interface ShopAccountPlatformCount {
  platform: string;
  count: number;
}

// ---------------------------------------------------------------------------
// 集中邮件收件箱（IMAP 只读；挂在「店铺账号管家」内）
// ---------------------------------------------------------------------------

/** 邮件账号状态：空闲 / 同步中 / 出错 / 已暂停 */
export type MailAccountStatus = 'idle' | 'syncing' | 'error' | 'paused';

/** 邮件账号（连接配置 + 同步状态；**不含任何凭据**——授权码只进不出） */
export interface MailAccountItem {
  id: number;
  shopSetId: number;
  email: string;
  providerId: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  folder: string;
  /** 需同步的文件夹列表（M3-3；为空表示仅同步 folder） */
  folders: string[];
  syncEnabled: boolean;
  /** 同步/保留窗口（天），超出即清理 */
  syncDays: number;
  /** 单封正文缓存上限（字节），超限只留元数据 */
  maxBodyBytes: number;
  status: MailAccountStatus;
  lastError: string;
  lastSyncedAt: string;
  uidValidity: number;
  lastUid: number;
  createdAt: string;
  updatedAt: string;
}

/** 邮件列表行（本地缓存；列表查询纯本地，不触网） */
export interface MailMessageItem {
  id: number;
  accountId: number;
  accountEmail: string;
  folder: string;
  uid: number;
  subject: string;
  fromName: string;
  fromAddr: string;
  toJson: string;
  ccJson: string;
  receivedAt: string;
  size: number;
  seen: boolean;
  flagged: boolean;
  hasAttachment: boolean;
  bodyCached: boolean;
  preview: string;
  createdAt: string;
  /** 本地已读标记时间（空串 = 未在本地读过） */
  readAt: string;
  /** 有效已读态：服务端 seen 或本地已读过（IMAP 只读，本地已读是唯一可靠来源） */
  read: boolean;
}

/** 附件元信息（不缓存二进制，按需下载时再拉） */
export interface MailAttachmentItem {
  id: number;
  messageId: number;
  filename: string;
  mime: string;
  size: number;
}

/** 附件预览结果（M3-1：图片内联，其余类型走系统应用打开） */
export interface MailAttachmentPreview {
  filename: string;
  mime: string;
  size: number;
  /** 本地缓存路径（空串表示未入缓存） */
  path: string;
  /** 能否内联预览（图片且未超体积上限） */
  previewable: boolean;
  /** 预览用的 data URL（不可预览时为空串） */
  dataUrl: string;
}

/** 服务端文件夹条目（M3-3） */
export interface MailRemoteFolder {
  path: string;
  specialUse: string;
  delimiter: string;
}

/** 附件本地缓存状态（M3-1） */
export interface MailCacheStatus {
  dir: string;
  files: number;
  bytes: number;
  maxBytes: number;
}

/** FTS5 全文索引状态（M3-2；available=false 时自动降级为 LIKE 检索） */
export interface MailFtsStatus {
  available: boolean;
  total: number;
  indexed: number;
}

/** 邮件详情（含正文与附件元信息） */
export interface MailMessageDetail extends MailMessageItem {
  textBody: string;
  htmlBody: string;
  /** 正文是否因超长被截断 */
  truncated: boolean;
  attachments: MailAttachmentItem[];
}

/** 连接测试结果（只读打开 INBOX 后即登出，不落库） */
export interface MailConnectionTestResult {
  ok: boolean;
  capabilities: string[];
  /** 是否支持 IDLE 长连接（163/126 实测不支持） */
  idle: boolean;
  folders: { path: string; specialUse: string }[];
  inboxExists: boolean;
  messageCount: number;
  error: string;
}

/** 账号接入入参（secrets.mailAuthPwd 省略 = 保持原值，空串 = 清除） */
export interface MailAccountUpsertInput {
  shopSetId: number;
  email?: string;
  providerId?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  folder?: string;
  /** 需同步的文件夹列表（M3-3；空数组 = 保持单文件夹 folder） */
  folders?: string[];
  syncEnabled?: boolean;
  syncDays?: number;
  maxBodyBytes?: number;
  secrets?: { mailAuthPwd?: string };
}

/** 邮件列表筛选（纯本地查询） */
export interface MailMessageListFilter {
  accountIds?: number[];
  keyword?: string;
  unreadOnly?: boolean;
  /** ISO 时间下界（含） */
  since?: string;
  /** 多文件夹筛选（M3-3；为空表示不限文件夹） */
  folders?: string[];
  limit?: number;
  offset?: number;
}

/** 收件箱汇总 */
export interface MailStats {
  accounts: number;
  messages: number;
  unread: number;
  lastSyncedAt: string;
  /** 本地已收邮件的文件夹分布（M3-3） */
  folders: { path: string; count: number }[];
}

/** 邮箱服务商预设（主进程精简下发，仅 UI 需要的字段） */
export interface MailProviderPresetView {
  id: string;
  label: string;
  domains: string[];
  host: string;
  port: number;
  secure: boolean;
  authHint: string;
  helpUrl: string;
  idle: boolean;
  defaultSyncDays: number;
}

/** 同步事件（主进程 → 渲染层单向广播） */
export interface MailSyncEvent {
  type: 'status' | 'progress' | 'done' | 'error';
  accountId: number;
  email: string;
  status?: string;
  processed?: number;
  total?: number;
  message?: string;
}

/** 店铺套汇总（总量 / 按状态计数 / 平台选项），供统计条与筛选下拉使用 */
export interface ShopAccountSummary {
  total: number;
  byStatus: Partial<Record<ShopAccountStatus, number>>;
  platforms: ShopAccountPlatformCount[];
}

/**
 * 单字段批量修改指令
 * - 字符串字段（company / tags / note）：mode=set 覆盖、append 追加（去重 / 拼接）
 * - 单值账号字段（phone / alipay / ziniaoAccount / erpAccount）：仅覆盖语义
 *   （均为唯一标识，同一字段内追加多个值无业务意义，故不提供 append）
 * - 状态（status）：仅覆盖语义；未传 = 不改
 * - 平台（platforms）：set=覆盖、append=并入、remove=从已有中移除（set 差集）
 * - 未出现在 patch 中的字段一律不动
 *
 * 不在批量操作范围内的字段：
 * - email（业务主标识，批量改成同一值会直接撞唯一约束）
 * - secrets（shopPwd / emailPwd / alipayPwd / ziniaoPwd / erpPwd）——一次性覆写 N 套凭证
 *   无法逐条确认、不可回滚，风险不可控（见 AGENTS.md 红线 3）
 */
export interface ShopAccountBatchFieldPatch {
  status?: ShopAccountStatus;
  company?: { mode: 'set' | 'append'; value: string };
  phone?: string;
  alipay?: string;
  ziniaoAccount?: string;
  erpAccount?: string;
  tags?: { mode: 'set' | 'append'; value: string };
  note?: { mode: 'set' | 'append'; value: string };
  platforms?: { mode: 'set' | 'append' | 'remove'; values: string[] };
}

/** 批量修改入参：ids 为目标店铺 id 数组；patch 全字段可选（未设置=不改） */
export interface ShopAccountBatchUpdateInput {
  ids: number[];
  patch: ShopAccountBatchFieldPatch;
}

/** 批量修改返回：实际被更新（按 patch 修改了至少一个字段）的店铺套条数 */
export interface ShopAccountBatchUpdateResult {
  updated: number;
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

// ---- 速卖通利润追踪（ae-profit / M0，字段与 electron/ae-db.ts 对应）----

/** SKU 明细行（列表页仅行数，点开详情时按需拉取） */
export interface AeOrderLineItem {
  productId: string;
  skuId: string;
  title: string;
  skuProps: string;
  qty: number;
  unitPrice: number;
  goodsAmount: number;
}

/**
 * 费用科目 key（宽松白名单：未知科目同样入库，仅前端 label 字典缺失时回退原 key）。
 * 与 electron/ae-db.ts AeFeeCategory 语义一致；新增科目 = 采集端加 fees 条目，无需改表。
 */
export type AeFeeCategory =
  | 'platform_commission' // 平台佣金
  | 'logistics_fee' // 物流费-卖家承担
  | 'payment_channel' // 支付通道费
  | 'refund' // 退款/纠纷调整（收入扣减类）
  | (string & {});

/** 订单级费用条目（列表行内联；currency 已回填订单币种） */
export interface AeFeeItem {
  category: AeFeeCategory;
  amount: number;
  currency: string;
}

/** 订单明细列表行（不含 raw_json） */
export interface AeOrderListItem {
  id: number;
  orderId: string;
  shopName: string;
  site: string;
  orderTime: string;
  status: string;
  currency: string;
  /** 商品金额（收入侧） */
  goodsAmount: number;
  /** 买家付运费（收入侧） */
  shippingIncome: number;
  /** 费用科目明细（平台佣金/物流费/退款…；同币种 = 订单币种） */
  fees: AeFeeItem[];
  lineCount: number;
  source: string;
  updatedAt: string;
}

export interface AeFeeSummary {
  category: AeFeeCategory;
  total: number;
  orders: number;
}

export interface AeCurrencyGroup {
  currency: string;
  orders: number;
  goodsAmount: number;
  shippingIncome: number;
  fees: AeFeeSummary[];
}

/**
 * 汇总（分币种，收入/费用分列；M1 利润引擎基于此扩展）。
 * 金额保留原币种按组聚合；top 级 total* 为跨币种预览合计（真实口径以 byCurrency 为准）。
 */
export interface AeSummary {
  totalOrders: number;
  totalGoodsAmount: number;
  totalShippingIncome: number;
  byCurrency: AeCurrencyGroup[];
}

/** 接收端运行状态（ae-receiver.ts） */
export interface AeReceiverStatus {
  running: boolean;
  port: number;
  startedAt: string;
  lastIngestAt: string;
  lastError: string;
}

// ---- 速卖通利润追踪 M1：利润引擎 / 成本衔接 / 汇率（与 electron/ae-engine.ts、ae-db.ts 同构）----

/** 拿货成本快照项（purchase-cost-snapshot 只读导出） */
export interface PurchaseCostSnapshotItem {
  styleCode: string;
  styleName: string;
  sampleCount: number;
  /** 加权均价（分） */
  weightedPriceCents: number;
  lastBizDate: string;
}

/** ae_cost_map 导入项（渲染层构造后交 ae-cost-map-import 全量替换） */
export interface AeCostMapImportItem {
  styleCode: string;
  styleName: string;
  unitPriceCents: number;
  sampleCount: number;
  lastBizDate: string;
}

/** ae_cost_map 行（成本管理面板） */
export interface AeCostMapItem extends AeCostMapImportItem {
  source: string;
  updatedAt: string;
}

/** 汇率行（1 fromCurrency = rateToCny CNY） */
export interface AeRateItem {
  fromCurrency: string;
  rateToCny: number;
  updatedAt: string;
}

/** 利润引擎分层合计（CNY 基准） */
export interface AeProfitTotals {
  orders: number;
  /** 净收入 CNY（已扣退款） */
  incomeCny: number;
  /** 商品成本 CNY（命中成本表的行） */
  costCny: number;
  /** 订单级费用 CNY（不含退款科目） */
  feeCny: number;
  /** 毛利 CNY = 净收入 − 成本 */
  grossProfitCny: number;
  /** 运营利润 CNY = 毛利 − 费用 */
  operatingProfitCny: number;
  /** 缺汇率跳过的订单数 */
  missingRateOrders: number;
}

export interface AeTrendPoint {
  bucket: string;
  orders: number;
  incomeCny: number;
  costCny: number;
  grossProfitCny: number;
}

export interface AeTopOrder {
  orderId: string;
  orderTime: string;
  status: string;
  currency: string;
  incomeCny: number;
  costCny: number;
  grossProfitCny: number;
}

export interface AeTopStyle {
  styleCode: string;
  styleName: string;
  qty: number;
  incomeCny: number;
  costCny: number;
  grossProfitCny: number;
}

export interface AeFeeBreakdownItem {
  category: string;
  totalCny: number;
  orders: number;
}

export interface AeProfitOverview {
  baseCurrency: 'CNY';
  totals: AeProfitTotals;
  trend: AeTrendPoint[];
  topOrders: AeTopOrder[];
  topStyles: AeTopStyle[];
  feeBreakdown: AeFeeBreakdownItem[];
  coverage: {
    orderCount: number;
    lineCount: number;
    /** 有 style_code 的行 */
    codeLines: number;
    /** 命中成本表的行 */
    matchedLines: number;
  };
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
