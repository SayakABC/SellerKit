import type { MarketCatalog, MarketPluginInfo } from './core/plugin/types';

export interface ElectronAPI {
  selectExcel: () => Promise<APIResult<ExcelFileResult>>;
  /** 选择图片文件（产品库主图 / 商品ID覆盖图；只返回路径，内容由主进程写通道按需读取） */
  selectImage: () => Promise<APIResult<{ filePath: string }>>;
  importExcelByPath: (filePath: string) => Promise<APIResult<ExcelFileResult | TemplateFileResult>>;
  selectTemplate: () => Promise<APIResult<TemplateFileResult>>;
  saveTemplate: (filePath: string, content: string) => Promise<APIResult<void>>;
  writeClipboard: (text: string) => Promise<APIResult<void>>;
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
  orderImageSave: (payload: {
    id: number;
    status: 'done' | 'error';
    resultJson?: string;
    error?: string;
  }) => Promise<APIResult<void>>;
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
  /**
   * 本页汇总（「归类核对」页指标条的产品维度）：这批订单行已配到哪些产品 / 几家供应商。
   *
   * 入参是**订单行原文**（`shop` 是报表里的店铺名，不是归一后的店铺实体）—— 归一与匹配都在主进程做，
   * 渲染层只交出它手上有的东西。数据层实现见 `electron/product-db.ts` 的 `resolveOrderSkuRollup`。
   */
  orderSkuRollup: (rows: { shop: string; itemId: string }[]) => Promise<APIResult<OrderSkuRollup>>;
  /** 把若干订单号归属到某店铺（写 `oi_orders.shop` 原文；AE 导出按店铺、无店铺列，故由人指定） */
  orderAssignShop: (payload: {
    orderNos: string[];
    shopName: string;
  }) => Promise<APIResult<{ updated: number }>>;
  /** **统一订单行**（主干 `oi_orders` 的投影；`source` 区分采集/导入）。只读，供算运费/成本/利润/拣货取数 */
  orderShippingRows: (payload?: {
    limit?: number;
    /** 只看某条摄取通道；缺省 = 两条都看 */
    source?: 'all' | 'import' | 'collect';
  }) => Promise<APIResult<UnifiedOrderRow[]>>;
  orderDownloadImage: (url: string) => Promise<APIResult<OrderImageRecord>>;
  /** 拣货投影（只读）：未发货订单行 + 三层回落图 + 款色码/供应商（聚合在渲染层纯函数） */
  pickingRows: (payload?: {
    limit?: number;
    shop?: string;
    includeShipped?: boolean;
  }) => Promise<APIResult<PickingRowsResult>>;
  /** 拣货单导出（主进程 exceljs 生成：带图 + **按厂家分表**）；行由渲染层算好，主进程只画表 */
  pickingExportExcel: (payload: {
    rows: PickingExportRow[];
    defaultName?: string;
  }) => Promise<APIResult<ExportExcelResult & { rows: number }>>;
  orderReadImage: (localPath: string) => Promise<APIResult<ImageDataUrl>>;
  /** 缩略图（主进程等比缩放 + LRU，≤maxEdge px JPEG dataURL） */
  orderImageThumb: (payload: {
    localPath: string;
    maxEdge?: number;
  }) => Promise<APIResult<{ dataUrl: string }>>;
  /** 批量缩略图（渲染层同帧多图合并一次往返）：返回顺序与 items 一致，单项无效为 null */
  orderImageThumbBatch: (
    items: { localPath: string; maxEdge?: number }[]
  ) => Promise<APIResult<{ dataUrls: (string | null)[] }>>;
  /** 识别引擎 API Key：safeStorage 加密落盘（渲染层不落明文） */
  orderApiKeySet: (apiKey: string) => Promise<APIResult<{ stored: boolean }>>;
  orderApiKeyGet: () => Promise<APIResult<{ apiKey: string }>>;
  /** 清理不被数据库引用的孤儿图片文件（返回释放数量与字节） */
  orderCleanupOrphanImages: () => Promise<APIResult<{ deleted: number; freedBytes: number }>>;
  // 产品库导入「图片」列：读取用户指定的本地图片（任意路径，仅图片扩展名，≤10MB）
  orderReadLocalImage: (localPath: string) => Promise<APIResult<ImageDataUrl>>;
  orderExportExcel: (
    buffer: ArrayBuffer,
    defaultName?: string
  ) => Promise<APIResult<{ filePath: string }>>;
  // ---- 待识别队列（订单归类：导入行整批落库 oi_queue，失败/缺图重启不丢、可增量重试）----
  orderQueueEnqueue: (payload: {
    batchNo: string;
    rows: OrderQueueEnqueueRow[];
  }) => Promise<APIResult<{ count: number }>>;
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
  orderQueueNextPending: (payload: {
    batchNo: string;
    afterId: number;
    limit: number;
  }) => Promise<APIResult<OrderQueueRow[]>>;
  orderQueueSetResult: (payload: {
    id: number;
    status: 'done' | 'error' | 'missing';
    error?: string;
  }) => Promise<APIResult<void>>;
  orderQueuePatch: (payload: {
    id: number;
    url: string;
    rawFields: Record<string, string>;
  }) => Promise<APIResult<void>>;
  orderQueueRetryErrors: (payload: { batchNo: string }) => Promise<APIResult<{ count: number }>>;
  orderQueuePurgeDone: (payload: { batchNo: string }) => Promise<APIResult<{ count: number }>>;
  orderQueueLastActive: () => Promise<
    APIResult<{ batchNo: string; stats: OrderQueueStats } | null>
  >;
  // 款编码/款色（产品库主数据）
  orderStyleResolve: (payload: {
    imageId: number;
    fingerprint: string;
    category: string;
    features: string[];
    color: string;
    styleName?: string;
  }) => Promise<APIResult<{ styleCode: string; styleColorCode: string }>>;
  orderStyleList: () => Promise<APIResult<StyleRecord[]>>;
  orderStyleDelete: (payload: { id: number }) => Promise<APIResult<{ deleted: number }>>;
  // 手动归并款式：订单挂到指定款编码 + 记入附加指纹（后续自动识别命中同一款编码）
  orderStyleAssign: (payload: {
    orderId: number;
    styleId: number;
    color: string;
    fingerprint?: string;
  }) => Promise<APIResult<{ styleCode: string; styleColorCode: string; skuBackfill?: SkuBackfillOutcome }>>;
  // 修改款式展示名（款编码级）
  orderStyleRename: (payload: {
    code: string;
    name: string;
  }) => Promise<APIResult<{ code: string; name: string }>>;
  // 产品库 Excel 批量导入（指纹由渲染层生成）
  orderStyleImport: (payload: {
    styles: StyleImportItem[];
  }) => Promise<APIResult<StyleImportResult>>;
  orderUpdate: (
    payload: OrderUpdateInput
  ) => Promise<APIResult<{ styleCode?: string; styleColorCode?: string }>>;
  orderUpdateStatus: (
    payload: OrderUpdateStatusInput
  ) => Promise<APIResult<{ status: OrderStatus }>>;
  orderDelete: (payload: { id: number }) => Promise<APIResult<{ deleted: number }>>;
  // 批量标记订单已核对（数据纠正页「确认无误」/「全部确认无误」置 corrected=1，不改识别字段）
  // ids: number[] 部分确认；{ all: true } 主进程一次 UPDATE 全量标记（避免大数组过 IPC）
  orderMarkCorrected: (input: number[] | { all: true }) => Promise<APIResult<{ updated: number }>>;
  // 速卖通利润追踪（ae-profit / M0）：入站数据走 localhost 接收端，本区仅查询类 IPC
  aeDbEnsure: () => Promise<APIResult<void>>;
  aeOrderList: (payload?: {
    offset?: number;
    limit?: number;
    search?: string;
  }) => Promise<APIResult<{ rows: AeOrderListItem[]; total: number }>>;
  aeSummary: () => Promise<APIResult<AeSummary>>;
  aeReceiverStatus: () => Promise<APIResult<AeReceiverStatus>>;
  // M1 利润追踪扩展：利润统计 / 成本快照 / 汇率维护 / 拿货成本只读导出
  aeProfitStats: (payload?: {
    granularity?: 'day' | 'month';
    rangeDays?: number;
  }) => Promise<APIResult<AeProfitOverview>>;
  aeCostMapImport: (payload: {
    items: AeCostMapImportItem[];
  }) => Promise<APIResult<{ replaced: number }>>;
  aeCostMapList: () => Promise<APIResult<AeCostMapItem[]>>;
  /** ---- 结算明细（AE 后台导出的订单明细；解析在渲染层，主进程只落库）---- */
  settleImport: (payload: { rows: unknown[] }) => Promise<
    APIResult<{ created: number; updated: number; failed: { orderNo: string; message: string }[] }>
  >;
  settleOrders: (payload: { orderNos: string[] }) => Promise<
    APIResult<{
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
        /** `order` = 订单级行（整单口径，含买家付的运费）；`items` = 无订单级行时退化为商品行求和 */
        from: 'order' | 'items';
      }[];
    }>
  >;
  settleStats: () => Promise<
    APIResult<{
      lines: number;
      orders: number;
      itemLines: number;
      orderLines: number;
      pendingOrders: number;
      settledOrders: number;
      lastImportedAt: string;
    }>
  >;
  aeRateList: () => Promise<APIResult<AeRateItem[]>>;
  aeRateUpsert: (payload: {
    fromCurrency: string;
    rateToCny: number;
  }) => Promise<APIResult<{ ok: boolean }>>;
  purchaseCostSnapshot: () => Promise<
    APIResult<{ items: PurchaseCostSnapshotItem[]; count: number }>
  >;
  // 拿货对账模块（厂商 / 拿货单 / 付款 / 对账 / 待拿货缺口）
  purchaseDbEnsure: () => Promise<APIResult<void>>;
  purchaseSupplierList: () => Promise<APIResult<Supplier[]>>;
  purchaseSupplierCreate: (payload: {
    name: string;
    phone?: string;
    note?: string;
  }) => Promise<APIResult<{ id: number }>>;
  purchaseSupplierUpdate: (payload: {
    id: number;
    phone?: string;
    note?: string;
  }) => Promise<APIResult<void>>;
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
  purchasePaymentList: (payload?: {
    supplierId?: number;
    from?: string;
    to?: string;
  }) => Promise<APIResult<Payment[]>>;
  purchasePaymentAdd: (payload: {
    supplierId: number;
    payDate: string;
    type: 'payment' | 'refund';
    amountCents: number;
    method?: string;
    note?: string;
  }) => Promise<APIResult<{ id: number }>>;
  purchasePaymentDelete: (payload: { id: number }) => Promise<APIResult<void>>;
  purchaseReconciliation: (payload?: {
    from?: string;
    to?: string;
  }) => Promise<APIResult<ReconciliationRow[]>>;
  purchaseOutstanding: () => Promise<APIResult<OutstandingRow[]>>;
  purchaseIgnoreAdd: (payload: {
    styleCode: string;
    color?: string;
    reason?: string;
  }) => Promise<APIResult<void>>;
  purchaseIgnoreRemove: (payload: {
    styleCode: string;
    color?: string;
  }) => Promise<APIResult<void>>;
  purchaseIgnoreList: () => Promise<APIResult<IgnoreRow[]>>;
  purchasePriceHistory: (payload: {
    supplierId?: number;
    styleCode: string;
    color?: string;
  }) => Promise<APIResult<{ priceCents: number }>>;
  /** 店铺对账汇总：全部已提交拿货单按来源订单拆分到店铺 */
  purchaseShopAllocation: (payload?: {
    from?: string;
    to?: string;
  }) => Promise<APIResult<ShopAllocationRow[]>>;
  /** 指定店铺的对账明细行 */
  purchaseShopAllocationDetail: (payload: {
    shop: string;
    from?: string;
    to?: string;
  }) => Promise<APIResult<ShopAllocationDetailRow[]>>;
  /** 导出拿货单 Excel（主进程生成，款编码+款色自动嵌入款色图） */
  purchaseExportExcel: (payload: {
    items: PurchaseItem[];
    defaultName?: string;
  }) => Promise<APIResult<{ filePath: string }>>;
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
    payload: ShopAccountUpsertInput
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
    payload: ShopAccountBatchUpdateInput
  ) => Promise<APIResult<ShopAccountBatchUpdateResult>>;
  // ---- 企业管理（企业基本信息 + 欧代 / 土代 / 德国包装法；无密码类凭据）----
  /** 幂等建表（企业管理 Tab 首次激活时调用） */
  companyDbEnsure: () => Promise<APIResult<void>>;
  /** 企业列表（关键字/状态过滤；含已维护的合规类型，不含明细） */
  companyList: (payload?: {
    search?: string;
    status?: CompanyStatus | '';
  }) => Promise<APIResult<CompanyItem[]>>;
  /** 企业详情（含欧代 / 土代 / 德国包装法明细） */
  companyGet: (payload: { id: number }) => Promise<APIResult<CompanyDetail | null>>;
  /** 汇总（总数 / 按状态 / 各合规类型覆盖企业数 / 30 天内到期条数） */
  companySummary: () => Promise<APIResult<CompanySummary>>;
  /** 新增/更新企业 */
  companyUpsert: (payload: CompanyUpsertInput) => Promise<APIResult<{ id: number }>>;
  /** 删除企业（级联删除其合规资料） */
  companyDelete: (payload: { id: number }) => Promise<APIResult<{ deleted: boolean }>>;
  /** 新增/更新合规资料（type 由主进程白名单校验） */
  companyProfileUpsert: (payload: CompanyProfileUpsertInput) => Promise<APIResult<{ id: number }>>;
  /** 删除合规资料 */
  companyProfileDelete: (payload: { id: number }) => Promise<APIResult<{ deleted: boolean }>>;
  // ---- 产品库（产品主数据：编码 / 名称 / 厂家 / 类目；编码为跨域关联锚点，与 oi_styles.code 同口径）----
  /** 幂等建表（视图首次激活时调用） */
  productDbEnsure: () => Promise<APIResult<{ ok: boolean }>>;
  /** 产品列表（关键字 / 状态 / 厂家过滤 + 分页；按编码升序） */
  productList: (payload?: {
    search?: string;
    status?: ProductStatus | '';
    supplierId?: number;
    offset?: number;
    limit?: number;
  }) => Promise<APIResult<{ rows: ProductListItem[]; total: number }>>;
  /** 单条详情（不存在返回 null） */
  productGet: (payload: { id: number }) => Promise<APIResult<ProductListItem | null>>;
  /** 新增/更新（全量提交；编码唯一，冲突时主进程抛错，不静默改名） */
  productUpsert: (
    payload: ProductUpsertInput
  ) => Promise<APIResult<{ id: number; created: boolean }>>;
  /** 删除（物理删除；已进入业务链路的产品应改为 status='archived'） */
  productDelete: (payload: { id: number }) => Promise<APIResult<{ deleted: boolean }>>;
  /** 汇总（总数 / 按状态 / 厂家分布 / 未关联厂家数；supplierOptions 为**全量**厂家，供下拉） */
  productSummary: () => Promise<APIResult<ProductSummary>>;
  /** Excel 批量导入（单事务）；mode='insertOnly' 时编码已存在的行记为失败而不覆盖 */
  productImport: (payload: {
    items: ProductImportRowInput[];
    mode?: 'upsert' | 'insertOnly';
  }) => Promise<APIResult<ProductImportOutcome>>;
  /** 保存渲染层生成的 xlsx（弹保存框）；buffer 无效时主进程返回 success=false */
  productExport: (payload: {
    buffer: ArrayBuffer;
    defaultName?: string;
  }) => Promise<APIResult<{ filePath: string }>>;
  // ---- 店铺商品ID → 产品映射（P3；pl_shop_sku）----
  // 与 sk_name_map 的分工：那张表归**人写的文本**（店名/款名），这张表归**平台商品ID**（稳定标识）。
  /** 映射列表（关键字 / 状态 / 店铺过滤 + 分页；按更新时间倒序） */
  productSkuList: (payload?: {
    search?: string;
    status?: SkuMapStatus | '';
    shopId?: number;
    offset?: number;
    limit?: number;
  }) => Promise<APIResult<{ rows: ShopSkuRow[]; total: number }>>;
  /** 映射汇总（总数 / 按状态 / 按平台 / 按店铺；**不扫订单**） */
  productSkuSummary: () => Promise<APIResult<SkuMapSummary>>;
  /** 待关联队列（实时聚合 oi_orders 的商品ID，减去已有生效映射；非缓存表） */
  productSkuQueue: (payload?: {
    limit?: number;
    maxRows?: number;
  }) => Promise<APIResult<{ rows: SkuQueueRow[]; stats: SkuQueueStats }>>;
  /** 批量关联 / 改绑（单事务；行级失败逐行报回，不做整批回滚）
   *  `reassigned` = 顺带回填的**存量订单行数**（映射写入后重跑确定性归款）
   *  `adopted` = 顺手把订单图采纳为**款主图**的张数（只补空、已有主图的款不动） */
  productSkuMap: (payload: {
    rows: SkuMapInputPayload[];
  }) => Promise<
    APIResult<{
      created: number;
      updated: number;
      reassigned: number;
      adopted: number;
      failed: { itemId: string; message: string }[];
    }>
  >;
  /** 标失效（商品ID 会变；**不物理删除**，否则关联率莫名回落且查不出原因） */
  productSkuInvalidate: (payload: { id: number }) => Promise<APIResult<{ changed: boolean }>>;
  // ---- SKU 子表（pl_variants：一个款下多个 SKU，每 SKU 一个克重）----
  productVariantList: (payload: { productIds: number[] }) => Promise<APIResult<{ rows: VariantRow[] }>>;
  productVariantUpsert: (payload: VariantUpsertInput) => Promise<APIResult<{ id: number; created: boolean }>>;
  productVariantDelete: (payload: { id: number }) => Promise<APIResult<{ removed: number }>>;
  productBatchUpdate: (
    payload: ProductBatchUpdateInput,
  ) => Promise<APIResult<{ updated: number }>>;
  // ---- 产品图片（pl_images / pl_item_images；srcPath 须来自用户对话框所选文件）----
  productImageAttach: (payload: {
    productId: number;
    srcPath: string;
  }) => Promise<APIResult<{ imageId: number; localPath: string; reused: boolean }>>;
  productImageDetach: (payload: { productId: number }) => Promise<APIResult<{ changed: boolean }>>;
  productItemImageSet: (payload: {
    itemId: string;
    srcPath: string;
  }) => Promise<APIResult<{ imageId: number; localPath: string; reused: boolean; itemId: string }>>;
  productItemImageClear: (payload: { itemId: string }) => Promise<APIResult<{ removed: number }>>;
  productItemImagePool: (payload: {
    itemIds: string[];
  }) => Promise<APIResult<{ pool: Record<string, ItemImagePoolEntry> }>>;
  // ---- 店铺商品清单（pl_shop_sku 扩展视图，支持一对多关联）----
  /** 导入商品清单（按 item_id 去重） */
  shopProductImport: (payload: {
    items: { itemId: string; shopId: number; imageUrl: string }[];
  }) => Promise<APIResult<{ imported: number; updated: number }>>;
  /** 商品清单列表（按 item_id 去重，分页 + 搜索） */
  shopProductList: (payload?: {
    offset?: number;
    limit?: number;
    search?: string;
  }) => Promise<APIResult<{ rows: ShopProductItem[]; total: number }>>;
  /** 删除商品（按 item_id 删除所有关联记录） */
  shopProductDelete: (payload: { itemId: string }) => Promise<APIResult<{ removed: number }>>;
  /** 查询某商品的关联关系 */
  shopProductRelations: (payload: { itemId: string }) => Promise<APIResult<ShopProductRelation[]>>;
  /** 添加关联关系 */
  shopProductRelationAdd: (payload: {
    itemId: string;
    productId: number;
  }) => Promise<APIResult<{ id: number; created: boolean }>>;
  /** 删除关联关系 */
  shopProductRelationDelete: (payload: { id: number }) => Promise<APIResult<{ removed: number }>>;
  // ---- 店铺实体（sk_shops / sk_name_map；DOMAIN_INTEGRATION_PLAN S1）----
  // 补上缺失的"店铺"实体层：历史文本（订单 / 采购 / 利润三处）**不改写**，靠名称归一映射旁挂关联。
  /** 幂等建表（视图首次激活时调用） */
  shopDbEnsure: () => Promise<APIResult<{ ok: boolean }>>;
  /** 店铺列表（关键字 / 平台 / 状态过滤 + 分页；按平台 → 名称升序） */
  shopList: (payload?: {
    search?: string;
    platform?: string;
    status?: ShopStatus | '';
    offset?: number;
    limit?: number;
    /** 只看某个账号套装名下的店铺（0/缺省 = 不过滤）—— 店铺套编辑抽屉用 */
    shopSetId?: number;
  }) => Promise<APIResult<{ rows: ShopListItem[]; total: number }>>;
  /** 单条详情（不存在返回 null） */
  shopGet: (payload: { id: number }) => Promise<APIResult<ShopListItem | null>>;
  /** 新增/更新（全量提交；同平台同名冲突时主进程抛错，不静默合并） */
  shopUpsert: (payload: ShopUpsertInput) => Promise<APIResult<{ id: number; created: boolean }>>;
  /** 汇总（店铺数 / 按平台 / 按状态 + 三处历史文本的归一进度） */
  shopSummary: () => Promise<APIResult<ShopSummary>>;
  /** 未归一的历史店铺名（实时聚合三处文本，非缓存表） */
  shopUnmapped: () => Promise<APIResult<UnmappedShopRow[]>>;
  /** 归一指派 / 标记忽略（ignored=true 时不要求 refId） */
  shopMap: (payload: {
    raw: string;
    refId?: number;
    ignored?: boolean;
    kind?: NameMapKind;
    note?: string;
  }) => Promise<APIResult<{ key: string; refId: number; ignored: boolean }>>;
  /** 撤销归一（回到未归一名单） */
  shopUnmap: (payload: {
    raw: string;
    kind?: NameMapKind;
  }) => Promise<APIResult<{ removed: number }>>;
  // ---- 外置插件（Phase 3：独立插件目录 <userData>/plugins）----
  /** 扫描插件目录：返回每个目录的 manifest.json 原始内容（渲染层负责严格 schema 校验） */
  pluginsScan: () => Promise<APIResult<PluginScanResult>>;
  /** 读取外置插件入口 JS 源码（主进程做路径穿越防护 + 大小限制） */
  pluginsReadEntry: (payload: {
    id: string;
    entry: string;
  }) => Promise<APIResult<{ code: string }>>;
  /** 卸载（删除）外置插件目录 */
  pluginsUninstall: (payload: { id: string }) => Promise<APIResult<void>>;
  /** 在系统文件管理器中打开插件目录 */
  pluginsOpenDir: () => Promise<APIResult<string>>;
  // ---- 插件市场（Market：catalog 拉取 + zip 安装，主进程净化/校验）----
  /** 拉取市场 catalog（净化后的合法条目列表） */
  pluginMarketCatalog: (payload: { url: string }) => Promise<APIResult<MarketCatalog>>;
  /** 安装/更新市场插件：下载 zip → sha256 → 解压校验 → 落盘 <userData>/plugins/<id>/；force=true 允许覆盖同版本 */
  pluginMarketInstall: (payload: {
    item: MarketPluginInfo;
    force?: boolean;
  }) => Promise<APIResult<{ id: string; version: string }>>;
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
    payload?: MailMessageListFilter
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
  mailPurge: (payload?: {
    accountId?: number;
    days?: number;
  }) => Promise<APIResult<{ deleted: number }>>;
  /** 收件箱汇总 */
  mailStats: () => Promise<APIResult<MailStats>>;
  /** 支持的邮箱服务商预设（只读展示，含授权码获取指引） */
  mailProviderList: () => Promise<APIResult<MailProviderPresetView[]>>;
  /** ---- 运价表快照（宿主中立层；一次导入 = 一条，按内容去重）---- */
  shipRateSnapshotSave: (payload: {
    table: unknown;
    sourceFile?: string;
    sheetName?: string;
    /** yyyy-mm-dd；缺省 = 导入当日 */
    effectiveFrom?: string;
  }) => Promise<APIResult<{ id: number; created: boolean; effectiveFrom: string }>>;
  shipRateSnapshotList: (payload?: { limit?: number }) => Promise<
    APIResult<{
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
  /** 算账用：含整张表的快照集合（按生效日倒序） */
  shipRateSnapshotCalc: (payload?: { limit?: number }) => Promise<
    APIResult<{
      rows: {
        id: number;
        effectiveFrom: string;
        sourceFile: string;
        sheetName: string;
        table: unknown;
      }[];
    }>
  >;
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
  isBuiltIn?: boolean; // true=文件内置模板，false=用户自定义修改
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
  /** 归属图片；**null = 无图订单**（订单报表免图导入，S2-b） */
  imageId: number | null;
  orderNo: string;
  shop: string;
  size: string;
  /** 下单时间（可空，来自 Excel 下单时间列） */
  orderTime?: string;
  rawFields: Record<string, string>;
  /**
   * 派生字段：**商品ID**（主进程按 `extractSkuFields` 的列名族从 `rawFields` 里取）。
   *
   * 存在意义只有一个：让「归类核对」页看得出**哪几行是同一个商品** —— 给其中一行点名款，
   * 宿主会把「(店铺, 商品ID) → 款 + 色」记下来（回流），该商品**其余的行以后自动归类**。
   * 空串 = 这份报表没有商品ID 列，那条链路对它无从下手（不是错误）。
   *
   * ⚠️ 探测口径**只能有一份**：这个值刻意由主进程给（与回流写映射时用的是同一个
   * `extractSkuFields`），渲染层不要自己再从 `rawFields` 推一遍 —— 推歪了就会出现
   * "徽标说同商品、回流却按另一个键记"。
   */
  itemId?: string;
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
  'shopPwd' | 'emailPwd' | 'alipayPwd' | 'ziniaoPwd' | 'erpPwd' | 'mailAuthPwd';

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
  /** 关联企业 id（企业管理 sk_companies 主键；0 = 未关联） */
  companyId: number;
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
// 企业管理（挂在「店铺账号管家」内：企业基本信息 + 欧代/土代/德国包装法）
// ---------------------------------------------------------------------------

/** 企业状态：启用 / 停用 */
export type CompanyStatus = 'active' | 'inactive';

/**
 * 企业下的合规资料类型
 * - eu_rep       欧代：欧盟授权代表（EC Rep / EU Responsible Person）
 * - tr_rep       土代：土耳其授权代表（Turkish Representative）
 * - de_packaging 德国包装法：LUCID 注册 + 双元系统（回收商）合同
 */
export type ComplianceType = 'eu_rep' | 'tr_rep' | 'de_packaging';

/** 合规资料状态：有效 / 办理中 / 已过期 */
export type ComplianceStatus = 'valid' | 'pending' | 'expired';

/** 合规资料条目（欧代 / 土代 / 德国包装法；类型专属字段在 extra 中） */
export interface CompanyProfileItem {
  id: number;
  companyId: number;
  type: ComplianceType;
  /** 主体名称（欧代公司 / 土代公司 / 双元系统回收商） */
  name: string;
  /** 编号（协议号 / 注册号 / LUCID 号） */
  regNo: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  address: string;
  /** 生效日期（YYYY-MM-DD） */
  effectiveAt: string;
  /** 到期日期（YYYY-MM-DD；空 = 长期有效） */
  expireAt: string;
  status: ComplianceStatus;
  note: string;
  /** 类型专属扩展字段（德国包装法：合同号 / 申报年度 / 申报重量等） */
  extra: Record<string, string>;
  createdAt: string;
  updatedAt: string;
}

/** 企业列表行（含已维护的合规资料类型，供列表徽标展示） */
export interface CompanyItem {
  id: number;
  name: string;
  /** 统一社会信用代码 / 境外注册号 */
  unifiedCode: string;
  country: string;
  address: string;
  legalPerson: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  /** VAT 税号 */
  vatNo: string;
  /** EORI 号 */
  eoriNo: string;
  status: CompanyStatus;
  note: string;
  /** 已维护的合规资料类型 */
  profileTypes: ComplianceType[];
  createdAt: string;
  updatedAt: string;
}

/** 企业详情（含合规资料明细） */
export interface CompanyDetail extends CompanyItem {
  profiles: CompanyProfileItem[];
}

/** 企业汇总（列表顶部 chips：总数 / 状态 / 各合规类型覆盖数 / 到期预警） */
export interface CompanySummary {
  total: number;
  byStatus: Partial<Record<CompanyStatus, number>>;
  byType: Partial<Record<ComplianceType, number>>;
  /** 30 天内到期（含已过期）的合规资料条数 */
  expiringSoon: number;
}

/** 企业写入入参（字段缺省 = 保持原值；空串 = 清空） */
export interface CompanyUpsertInput {
  id?: number;
  name?: string;
  unifiedCode?: string;
  country?: string;
  address?: string;
  legalPerson?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  vatNo?: string;
  eoriNo?: string;
  status?: CompanyStatus;
  note?: string;
}

/** 合规资料写入入参（type 与 companyId 必填） */
export interface CompanyProfileUpsertInput {
  id?: number;
  companyId?: number;
  type?: ComplianceType;
  name?: string;
  regNo?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  address?: string;
  effectiveAt?: string;
  expireAt?: string;
  status?: ComplianceStatus;
  note?: string;
  /** 类型专属扩展字段（整体覆盖） */
  extra?: Record<string, string>;
}

// ---------------------------------------------------------------------------
// 产品库（产品主数据，挂宿主中立层 —— ADR-002 C3；编码为跨域关联锚点）
// ---------------------------------------------------------------------------

/** 产品状态：在售 / 停用（停用仅标记，不物理删除 —— 编码一经使用永不复用） */
export type ProductStatus = 'active' | 'archived';

/** 产品列表行（厂家名由 supplier_id 派生，非本表字段 —— 避免同一语义两个写入者） */
export interface ProductListItem {
  id: number;
  /** 内部编码：与 oi_styles.code / purchase_items.style_code / ae_cost_map.style_code 同口径 */
  code: string;
  name: string;
  /** 关联厂家 suppliers(id)；0 = 未关联 */
  supplierId: number;
  supplierName: string;
  category: string;
  status: string;
  note: string;
  /** 主图 pl_images(id)；0 = 未设置（窄接口 imageAttach/detach 维护，不进全量提交的 upsert） */
  imageId: number;
  /** 主图缓存路径（'' = 无图；经 order-image-thumb 取缩略图展示） */
  imagePath: string;
  createdAt: string;
  updatedAt: string;
}

/** SKU 行（pl_variants：一个款下多个 SKU，每 SKU 一个克重） */
export interface VariantRow {
  id: number;
  productId: number;
  /** SKU 编码（可空；非空时全局唯一） */
  code: string;
  name: string;
  /** 颜色（服装 SKU；老数据可能为空 —— 老行只有自由文本 name） */
  color: string;
  /** 尺码（与 color 成对填写，成对时 name = "颜色 尺码" 自动生成） */
  size: string;
  /** 克重（克，整数；0 = 未填） */
  weightG: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

/** SKU 写入入参（全量提交；id 缺省/0 = 新增） */
export interface VariantUpsertInput {
  id?: number;
  productId: number;
  code?: string;
  /** color+size 都填时自动覆盖为 "颜色 尺码"；老数据只传 name 仍兼容 */
  name?: string;
  color?: string;
  size?: string;
  weightG?: number;
  status?: ProductStatus;
}

/** 产品批量编辑入参（**部分 patch**：undefined 的字段不修改；supplierId 0 = 清空关联） */
export interface ProductBatchUpdateInput {
  ids: number[];
  supplierId?: number;
  category?: string;
  status?: ProductStatus;
  note?: string;
}

/**
 * **统一订单行**（两条摄取通道共用的形状，C1 合并的落点）：
 *   · `order-shipping-rows`（Excel 报表导入 → `oi_orders` 投影）
 *   · `order-collected-rows`（浏览器采集 → `ae_orders` 投影）
 *
 * **只放主线（算钱 + 拣货）真正读的字段**（用户 2026-09-30 定的原则：精简优先、非必要先删、必要再加）：
 * 已删掉货值/买家运费/店铺优惠/平台补贴/币种/业务模式/付款·收货时点/发货时点等 9 个**零读者**字段 ——
 * 它们并没有丢：原始整行仍在 `rawFields`（导入侧）与 `raw_json`（采集侧）里保真，**要加回来随时可重新提取**。
 * 金额一律 **CNY 分**；`null` = 源里没有这一项（**不是 0**，0 会让"缺收入"看起来像"收入为零"）。
 */
export interface UnifiedOrderRow {
  id: number;
  orderNo: string;
  /** 摄取通道（主干 `source`）：`import` = 报表导入 · `collect` = 浏览器采集 */
  source: 'import' | 'collect';
  shop: string;
  orderTime: string;
  /** 识别链 `oi_images.style_color_id → oi_style_colors → oi_styles` 的结果（采集侧取 `style_code`）；未识别为空串 */
  styleCode: string;
  styleColor: string;
  /** 颜色 / 尺码（SKU 粒度 = 款×色×码） */
  color: string;
  size: string;
  /** 商品ID（导入侧 `商品 ID` 列；采集侧 `product_id` —— 实测多为空） */
  itemId: string;
  /** 供应商（经 `pl_products.supplier_id → suppliers`）；未识别款/未填厂家时 id=0、名为空 */
  supplierId: number;
  supplierName: string;
  /** 件数**真值**：仅当源直接给出数量时才有（采集行数量；导入侧由渲染层解析"商品信息"块） */
  qty?: number;
  /** 收入（CNY 分）：导入侧 = 订单金额；采集侧 = (商品金额 + 买家付运费 − 退款) × 汇率 */
  amountCents: number | null;
  /** 预计增值税（导入侧有；采集帧不含 → null） */
  vatCents: number | null;
  /** DDP 关税（导入侧有；采集帧不含 → null） */
  ddpCents: number | null;
  /** 「平台是否代征代缴」原文；空串 = 不知道（≠ 非代征）。采集帧不含该列 → 恒空串 */
  taxPlatform: string;
  /** 订单状态原文（交易完成 / 订单关闭 / 等待买家收货 …）—— 分桶与"未发货"判定都读它 */
  bizStatus: string;
  /** 原始整行（导入侧保真：件数解析、商品ID 提取都从这里；采集侧为空对象） */
  rawFields: Record<string, string>;
}

/** 拣货投影行（宿主 `picking-rows` 返回；纯层 `src/lib/picking.ts` 直接消费它） */
export interface PickingRowProjection {
  id: number;
  orderNo: string;
  shop: string;
  orderTime: string;
  /** 识别链结果；未识别为空串 */
  styleCode: string;
  styleColor: string;
  /** 颜色 / 尺码（SKU 粒度 = 款×色×码） */
  color: string;
  size: string;
  itemId: string;
  /** 供应商；未识别款/未填厂家时 id=0、名为空 */
  supplierId: number;
  supplierName: string;
  /** 三层回落后的图（本地路径，经 `order-image-thumb(-batch)` 换 dataUrl）；'' = 没图 */
  imagePath: string;
  /** 机械事实：已发货（`ship_time` 非空或 `status='shipped'`） */
  shipped: boolean;
  /** 平台状态原文（**关闭/取消的判定在渲染层**，用 `orderCost.bucketOfStatus`） */
  bizStatus: string;
  /** 件数由渲染层从 raw_fields 解析（与订单利润页同一份实现） */
  rawFields: Record<string, string>;
}

/** 拣货投影的返回：行 + 该次筛选的机械事实（界面按它说清"这批是怎么筛出来的"） */
export interface PickingRowsResult {
  rows: PickingRowProjection[];
  meta: {
    /** 返回的行数 */
    rows: number;
    /** 实际用的上限 */
    limit: number;
  };
}

/**
 * 「拣货单导出」的一行（渲染层算好 → 主进程画表）。
 *
 * ⚠️ 凡是业务口径（件数 / 进价 / 金额 / 缺口文案）都在渲染层算完后**原样带过来**，
 * 主进程不重算 —— 这样"屏幕上的数"与"导出的数"结构上不可能不一致。
 * `image` 也一样：**图由渲染层编码**（真实订单图大半是 WebP，只有 Chromium 能解；详见 `lib/pickingExport`）。
 */
export interface PickingExportRow {
  /** 供应商名；'' = 未指定厂家（会单独成一张表） */
  supplierName: string;
  styleCode: string;
  color: string;
  size: string;
  pieces: number;
  orders: number;
  /** 进价（元/件）；`null` = 无进价（导出表里留空，**不写 0**） */
  unitPrice: number | null;
  /** 预估金额（元）；`null` = 无进价 */
  amount: number | null;
  /** 缺口文案（'' = 齐） */
  gaps: string;
  /** 已编码成 JPEG 的图（`null` = 这行没图） */
  image: PickingExportImage | null;
}

/** 已编码的图（渲染层 canvas 产出：JPEG + 尺寸；主进程直接嵌进 xlsx） */
export interface PickingExportImage {
  /** **不含** `data:image/jpeg;base64,` 前缀的纯 base64 */
  base64: string;
  width: number;
  height: number;
}

/** 一张图的引用（展示走 localPath → order-image-thumb 取缩略图） */
export interface ProductImageRef {
  imageId: number;
  localPath: string;
}

/** 一个商品ID的候选图（**有序回落**：override → order[] → product） */
export interface ItemImagePoolEntry {
  /** 手动覆盖图（pl_item_images，人的显式决定，最高优先） */
  override: ProductImageRef | null;
  /** 订单识别图（可能多张，最新的在前） */
  order: ProductImageRef[];
  /** 款主图（该商品ID 的 confirmed 映射 → pl_products.image_id） */
  product: ProductImageRef | null;
}

/** 产品写入入参（**全量提交**语义：缺省即空，不做局部 patch —— 与 shop-account-upsert 一致） */
export interface ProductUpsertInput {
  /** 缺省 = 新增 */
  id?: number;
  code: string;
  name?: string;
  supplierId?: number;
  category?: string;
  status?: ProductStatus;
  note?: string;
}

/** Excel 批量导入的一行（字段已在渲染层解析校验；主进程只做兜底与落库） */
export interface ProductImportRowInput {
  rowNo: number;
  code: string;
  name: string;
  supplierId: number;
  category: string;
  status: string;
  note: string;
}

/** 批量导入结果（`failed` 为库层才拦得住的失败行，如 insertOnly 模式下编码已存在） */
export interface ProductImportOutcome {
  created: number;
  updated: number;
  failed: { rowNo: number; code: string; message: string }[];
}

/** 产品汇总（列表顶部 chips / 覆盖率提示） */
export interface ProductSummary {
  total: number;
  byStatus: { status: string; count: number }[];
  supplierOptions: { id: number; name: string; productCount: number }[];
  /** 未关联厂家的产品数 */
  withoutSupplier: number;
}

// ---------------------------------------------------------------------------
// 店铺商品ID → 产品映射（P3；pl_shop_sku）
//
// 与 sk_name_map 的分工（别混淆）：那张表的键是**人写的文本**（店名/款名），靠精确匹配 + 人工指派；
// 这张表的键是**平台商品ID**，本身就是稳定标识，未命中就进待关联队列由人确认。
// 一期 spec 恒 '*'（变体表到 P5 才建），故队列按 (店铺, 商品ID) 聚合。
// ---------------------------------------------------------------------------

/** 映射状态：确认 / 待确认 / 已失效（商品ID 变了——标失效而不物理删除，否则关联率回落查不出原因） */
export type SkuMapStatus = 'confirmed' | 'pending' | 'invalid';

export interface ShopSkuRow {
  id: number;
  platform: string;
  shopId: number;
  /** 由 shop_id 派生（软关联 sk_shops；店被删则留空） */
  shopName: string;
  itemId: string;
  spec: string;
  productId: number;
  /** 由 product_id 派生 */
  productCode: string;
  productName: string;
  variantId: number;
  qtyPerItem: number;
  status: string;
  source: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 店铺商品清单（pl_shop_sku 扩展视图，支持一对多关联）
// ---------------------------------------------------------------------------

/** 商品清单行（按 item_id 去重） */
export interface ShopProductItem {
  itemId: string;
  shopId: number;
  shopName: string;
  imageUrl: string;
  importedAt: number;
  relationCount: number; // 关联的产品数
}

/** 商品关联关系行 */
export interface ShopProductRelation {
  id: number;
  itemId: string;
  productId: number;
  productCode: string;
  productName: string;
  createdAt: string;
}

/** 一条待写入的映射（批量关联 / 改绑共用） */
export interface SkuMapInputPayload {
  platform: string;
  shopId: number;
  itemId: string;
  /** **颜色**（D4 起承载颜色语义；缺省 `'*'` = 未指定色）。
   *  颜色是商品ID 的属性 —— 配在这里，之后该商品的所有订单自动带色，不必每单看图。 */
  spec?: string;
  productId: number;
  status?: SkuMapStatus;
  note?: string;
}

export interface SkuMapSummary {
  total: number;
  byStatus: { status: string; count: number }[];
  byPlatform: { platform: string; count: number }[];
  byShop: { shopId: number; shopName: string; platform: string; count: number }[];
}

/**
 * ⭐ 人工核对的**回流**结果：「归类核对」页点名某个款时，有没有把
 * 「(店铺, 商品ID) → 款 + 色」记进确定性层（`pl_shop_sku`）。
 *
 * 与主进程 `electron/order-db.ts` 的 `SkuBackfillOutcome` 结构一致（两端各自声明，
 * 主进程不 import 渲染层）。**它是附加产物，不是成功判据**：
 * `status !== 'written'` 时"归属已改"照样是成功的 —— 界面必须把两者分开说，
 * 否则用户会把"没记住这个商品"读成"没保存"。
 */
export interface SkuBackfillOutcome {
  status:
    | 'written'
    | 'already'
    | 'conflict'
    | 'noItemId'
    | 'shopUnresolved'
    | 'noProduct'
    | 'failed'
    | 'disabled';
  /** 顺带自动归款的**存量**订单行数（不含刚点名的那一单） */
  reassigned: number;
  /** 真正记进映射的颜色；`''` = 只记到款级 */
  spec: string;
  /** `conflict` 时对方的产品编码（说清"没覆盖掉谁"） */
  conflictCode: string;
}

/**
 * 「本页汇总」结果（「归类核对」页指标条的产品维度）：这一页的商品已配到哪些产品 / 几家供应商。
 *
 * 与主进程 `electron/product-db.ts` 的 `OrderSkuRollup` 结构一致（两端各自声明，
 * 主进程不 import 渲染层）。
 *
 * ⚠️ `products === 0` 的正确读法是「**本页商品还没配过映射**」——它是一个待办，
 * 不是"这份数据没有产品维度"（对照 `OrderRecord.itemId` 为空时「本页 N 个商品」整格不显示）。
 */
export interface OrderSkuRollup {
  /** 本页商品已配到的**去重产品**数 */
  products: number;
  /** 这些产品涉及的**去重供应商**数（`supplier_id = 0` 的"未关联厂家"不计家数） */
  suppliers: number;
}

/** 待关联队列的一行（`status='shopUnresolved'` 时**不允许**写映射：不拿空平台硬塞） */
export interface SkuQueueRow {
  shopKey: string;
  shopRaw: string;
  itemId: string;
  /** 归一后的商品ID（与 `itemImagePool` 的池键同口径）—— 查图用它，**别用 `itemId`**：
   *  那是订单原文（可能带空格），池的键是归一的，拿原文查必然落空且不报错 */
  itemKey: string;
  /** 展示用商品标题（不参与匹配） */
  title: string;
  orderCount: number;
  shopId: number;
  shopName: string;
  platform: string;
  /** 同名**唯一**精确命中给出的建议（永不自动落库，需人工一键采纳） */
  autoShopId: number;
  autoShopName: string;
  autoShopPlatform: string;
  status: 'unmapped' | 'shopUnresolved';
}

export interface SkuQueueStats {
  groups: number;
  shown: number;
  unmapped: number;
  shopUnresolved: number;
  /** 已有生效映射、已退出队列的组数 */
  mapped: number;
  withItemId: number;
  /** 没有商品ID的订单行数（必须报出，否则是无声丢行） */
  withoutItemId: number;
  truncated: boolean;
  /** 涉及但尚未归一的店铺名（去重；界面靠它提示"先去登记哪些店"） */
  unresolvedShops: string[];
}

// ---------------------------------------------------------------------------
// 店铺实体（sk_shops / sk_name_map；DOMAIN_INTEGRATION_PLAN S1）
//
// 病根（该计划 D1/D2）：店铺实体不存在，店名以自由文本各存三处且互相拷贝 ——
//   oi_orders.shop / purchase_sources.shop / ae_orders.shop_name
// 本层补实体层，历史文本一律不改写（G2）；关联靠 sk_name_map 的归一映射。
// ⚠️ 三处文本**都没有平台字段** → `platform` 无法从历史数据推导，只能在登记店铺时由人指定。
// ---------------------------------------------------------------------------

/** 店铺状态：在营 / 停用（停用仅标记，不物理删除 —— 历史订单仍指向它） */
export type ShopStatus = 'active' | 'archived';

/** 归一映射的实体类型（S1 只用 shop；其余为 supplier / style / product 预留） */
export type NameMapKind = 'shop' | 'supplier' | 'style' | 'product';

export interface ShopListItem {
  id: number;
  platform: string;
  name: string;
  /** 归一键（去空白 + 剥不可见字符后的形态，UNIQUE 与自动命中都用它） */
  nameKey: string;
  /** 平台店铺ID（**归一后**的值；'' = 未填）—— 店铺实体的稳定业务键，改名不影响 */
  platformShopId: string;
  site: string;
  /** 所属账号套装 sk_shop_sets(id)；0 = 未关联（软关联） */
  shopSetId: number;
  status: string;
  openedAt: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  /** 已归一到本店的历史文本条数 */
  aliasCount: number;
}

/** 新增/更新店铺入参（**全量提交**语义：缺省即空） */
export interface ShopUpsertInput {
  /** 0 / 缺省 = 新增 */
  id: number;
  platform: string;
  name: string;
  /** 平台店铺ID（可空；非空时参与唯一性 —— 同平台内不得重复） */
  platformShopId: string;
  site: string;
  shopSetId: number;
  status: string;
  openedAt: string;
  note: string;
}

/** 未归一的历史店铺名（一次实时聚合的结果） */
export interface UnmappedShopRow {
  /** 归一键 —— `shopMap` / `shopUnmap` 的入参 */
  key: string;
  raw: string;
  occurrences: number;
  /** 出现过的来源（order / purchase / ae） */
  sources: string[];
  /** 若恰好能按精确名唯一命中一家店铺则给出（**不自动写映射**；歧义时恒为 0） */
  autoShopId: number;
  autoShopName: string;
  autoShopPlatform: string;
}

/** 店铺汇总（店铺侧 + 历史文本侧的归一进度） */
export interface ShopSummary {
  total: number;
  byPlatform: { platform: string; count: number }[];
  byStatus: { status: string; count: number }[];
  names: {
    total: number;
    mapped: number;
    unmapped: number;
    ignored: number;
    /** 未归一里能按精确名唯一命中的条数（"一键采纳"能消掉多少） */
    autoMatched: number;
    /** 映射已指向店铺、但该名称在文本里已不存在（过期映射，可清理） */
    stale: number;
  };
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
  /**
   * 关联企业 id（引用企业管理列表，仅「覆盖」语义——企业是引用关系，无追加概念）：
   * 0 = 取消关联（同时清空企业名称列）；> 0 = 覆盖为该企业（企业名称列同步取企业库中的名称）。
   * 2026-09-18：原 `company?: { mode, value }` 文本 patch 由下拉选择取代，已移除。
   */
  companyId?: number;
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

/** 拿货成本快照项（purchase-cost-snapshot 只读导出；P4a 起按 (款, 拿货日期) 分组，一款可多项） */
export interface PurchaseCostSnapshotItem {
  styleCode: string;
  styleName: string;
  sampleCount: number;
  /** 加权均价（分） */
  weightedPriceCents: number;
  /**
   * 本项的拿货日期（yyyy-mm-dd）。
   * ⚠️ P4a 语义变更：原为「该款最近一次拿货日期」（一款一项），现为「**本项**的拿货日期」
   * （一款可多项，一项 = 一个成本生效区间）；导库时作为 `ae_cost_map.effective_from`。
   */
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

/** ae_cost_map 行（成本管理面板）。P4a 起同一款可多行：一行 = 一个生效区间。 */
export interface AeCostMapItem extends AeCostMapImportItem {
  /** 生效日（yyyy-mm-dd）；无区间信息的存量行 = `0000-01-01` */
  effectiveFrom: string;
  /** 该行来源：purchase = 对账快照导入，manual = 界面手工录入 */
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
