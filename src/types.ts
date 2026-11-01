import type { MarketCatalog, MarketPluginInfo } from './core/plugin/types';
// 分摊基准只有一处定义（`src/lib/ledger.ts`）：两个地方各写一份 `'equal'|'revenue'|'manual'`，
// 早晚会出现一边加了新基准、另一边不知道的情况。
import type { LedgerBasis } from './lib/ledger';

export type { LedgerBasis };

/**
 * 「色未定」修复的候选色行（`purchase-style-colors` 返回的一项）。
 *
 * 只来自款色表（该款真实存在的色）—— 修历史单据时**不许现编色名**：
 * 编出来的名字对不上任何色行，等于再造一批"已拿匹配不上、图也取不到"的脏数据。
 */
export interface StyleColorOptionRow {
  /** 色行 id（身份） */
  id: number;
  /** 色名（款色表里的真值，不是订单上的平台色名） */
  color: string;
  /** 该色行是否挂着图；`false` 多为归色改写留下的空壳（界面要与真实色区分） */
  hasImage: boolean;
}

export interface ElectronAPI {
  selectExcel: () => Promise<APIResult<ExcelFileResult>>;
  /** 选择图片文件（产品库主图 / 商品ID覆盖图；只返回路径，内容由主进程写通道按需读取） */
  selectImage: () => Promise<APIResult<{ filePath: string }>>;
  importExcelByPath: (filePath: string) => Promise<APIResult<ExcelFileResult | TemplateFileResult>>;
  selectTemplate: () => Promise<APIResult<TemplateFileResult>>;
  saveTemplate: (filePath: string, content: string) => Promise<APIResult<void>>;
  writeClipboard: (text: string) => Promise<APIResult<void>>;
  /** 写图片剪贴板（PNG dataURL）：「复制给厂家」的发厂清单图，粘进微信发给供应商 */
  writeClipboardImage: (dataUrl: string) => Promise<APIResult<void>>;
  /** 打开外链（「打开店铺」；主进程只放行 http/https，其余协议报错；优先 Chrome，用不了回落系统默认浏览器） */
  openExternal: (url: string) => Promise<APIResult<void>>;
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
  orderInsert: (order: OrderRecord) => Promise<APIResult<{ id: number }>>;
  orderGroupStats: (dimensions: string[]) => Promise<APIResult<GroupStat[]>>;
  /** 订单列表（分页 + 关键字搜索）：{ offset?, limit?, corrected?, search? } → { rows, total }；列表不含 raw_fields */
  orderList: (payload?: {
    offset?: number;
    limit?: number;
    corrected?: boolean;
    /** 关键字（单号/店铺/分类/颜色/logo/款编码/款名/款色），匹配为空串视为不筛选 */
    search?: string;
    /**
     * 只看**这一天导入**的行（`yyyy-mm-dd`，本地时区，按 `oi_orders.created_at` 取日期部分）。
     *
     * 「发货台」的每日口径：一天一导（导出"昨天 → 导出时点"的全部订单），中间追加的也算同一天。
     * 缺省 = 不筛（独立模块如「算钱」看全库）。
     */
    importDate?: string;
  }) => Promise<APIResult<{ rows: OrderRecord[]; total: number }>>;
  orderClear: () => Promise<APIResult<void>>;
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
    /** 只看这一天**导入**的行（`yyyy-mm-dd` 本地时区，按 `created_at`）；缺省 = 全库（见 `orderList` 同名参数） */
    importDate?: string;
    /** 只看订单**发生月**（`yyyy-mm`，按 `order_time`）；缺省 = 全库。记账的营收占比用 */
    period?: string;
  }) => Promise<APIResult<UnifiedOrderRow[]>>;
  // ---- 包裹（阶段 B2）：一单多包 / 按商品行拆 / 拆合并行数量 ----
  // 写通道都回**整单**最新状态（`ParcelDetail`）：拆包面板在开着的时候别人也可能在改同一单，
  // 用返回值重绘比"本地推测结果"稳（推测的结果和库不一致时，用户看到的是"点了没反应"）。
  orderParcelDetail: (payload: { orderNo: string }) => Promise<APIResult<ParcelDetail>>;
  /** 一批订单各拆了几个包（`{ 单号: 包数 }`；不在返回里的 = 0 个包） */
  orderParcelCounts: (payload: { orderNos: string[] }) => Promise<APIResult<ParcelCountMap>>;
  /** 一批订单的包裹汇总（运费/重量；不在返回里的 = 还没拆包）。利润页用它替代运价表估算 */
  orderParcelTotals: (payload: { orderNos: string[] }) => Promise<APIResult<ParcelTotalsMap>>;
  orderParcelCreate: (payload: {
    orderNo: string;
    label?: string;
    trackingNo?: string;
    carrier?: string;
    note?: string;
    /** 分；`null`/缺省 = 还不知道（不是 0） */
    shipCents?: number | null;
    /** 克；`null`/缺省 = 还不知道 */
    weightG?: number | null;
  }) => Promise<APIResult<ParcelDetail & { id: number }>>;
  orderParcelUpdate: (payload: {
    id: number;
    orderNo?: string;
    label?: string;
    trackingNo?: string;
    carrier?: string;
    note?: string;
    /** 只传要改的字段：`undefined` = 不改，`null` = 清成"还不知道" */
    shipCents?: number | null;
    weightG?: number | null;
  }) => Promise<APIResult<ParcelDetail | null>>;
  orderParcelDelete: (payload: { id: number; orderNo?: string }) => Promise<APIResult<ParcelDetail | null>>;
  /** `qty <= 0` = 从该包移除这一行；超拆由主进程拒绝并回 `error` 文案 */
  orderParcelSetLine: (payload: {
    parcelId: number;
    orderItemId: number;
    qty: number;
    orderNo?: string;
  }) => Promise<APIResult<ParcelDetail | null>>;
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
  /** 清理不被数据库引用的孤儿图片文件（返回释放数量与字节） */
  orderCleanupOrphanImages: () => Promise<APIResult<{ deleted: number; freedBytes: number }>>;
  // 产品库导入「图片」列：读取用户指定的本地图片（任意路径，仅图片扩展名，≤10MB）
  orderReadLocalImage: (localPath: string) => Promise<APIResult<ImageDataUrl>>;
  orderExportExcel: (
    buffer: ArrayBuffer,
    defaultName?: string
  ) => Promise<APIResult<{ filePath: string }>>;
  // 款编码/款色（产品库主数据）
  orderStyleResolve: (payload: {
    imageId: number;
    fingerprint: string;
    category: string;
    features: string[];
    color: string;
    styleName?: string;
  }) => Promise<APIResult<{ styleCode: string; styleColorCode: string }>>;
  /**
   * 款选项列表（「归属款」下拉的数据源）：**产品库驱动的全集**，含「货与成本」里手工新建、
   * 还没出过订单的款（旧实现按识别池驱动 ⇒ 那些款一个都不出现，用户报的"展示不全"即此）。
   * 每项带可选颜色（产品库 SKU 颜色在前、识别链款色在后）。
   */
  orderStyleList: () => Promise<APIResult<StyleRecord[]>>;
  /**
   * 命名板（P3）：按 listing 分组的色键，未命名在前。
   * 只读；写走 {@link orderVariantRename}。
   */
  orderVariantNaming: (payload?: {
    /** 这一批的导入日（`YYYY-MM-DD`，与「待核对」同一批）；不传 = 不筛 */
    importDate?: string;
  }) => Promise<APIResult<VariantNamingBoard>>;
  /**
   * 给一个款色起名 —— 命名板**唯一**的写入口。
   * 同款重名 / 空名 / 超长会被主进程拒绝（`ok:false` + 原话），不静默改。
   */
  orderStyleBasics: (payload: {
    styleId: number;
    /** 缺省 = 不改款名（`''` 是合法的"清空回占位"） */
    name?: string;
    /** 缺省 = 不改厂家（`0` 是合法的"清空厂家"） */
    supplierId?: number;
  }) => Promise<APIResult<SaveStyleBasicsOutcome>>;
  orderVariantRename: (payload: {
    styleColorId: number;
    name: string;
  }) => Promise<APIResult<RenameColorOutcome>>;
  /**
   * 合并候选 + 已合并记录（拿货页「这几个款可能是同一件货」那块的唯一数据面）。
   * 只读。
   */
  orderStyleMergeBoard: () => Promise<APIResult<StyleMergeBoard>>;
  /**
   * 把 `sourceStyleIds` 并进 `targetStyleId`（一次 N→1）。
   * 色只按**同名**配对，同名走改键、不同名搬色；不猜相似度。
   */
  orderStyleMerge: (payload: {
    targetStyleId: number;
    sourceStyleIds: number[];
  }) => Promise<APIResult<MergeStylesOutcome>>;
  /** 拆开一次合并（按批次）。`ok:false` 时 `error` 是给用户看的原话。 */
  orderStyleUnmerge: (payload: { batchId: string }) => Promise<APIResult<UnmergeOutcome>>;
  orderStyleDelete: (payload: { id: number }) => Promise<APIResult<{ deleted: number }>>;
  // 手动归并款式：订单挂到指定款编码 + 记入附加指纹（后续自动识别命中同一款编码）
  // ⭐ 主用 `styleCode`（下拉的值就是编码）；`styleId` 保留兼容老形状
  orderStyleAssign: (payload: {
    orderId: number;
    styleCode: string;
    styleId?: number;
    color: string;
    fingerprint?: string;
  }) => Promise<
    APIResult<{
      styleCode: string;
      styleColorCode: string;
      skuBackfill?: SkuBackfillOutcome;
      /** 本次顺带记住的「平台色名 → 我的色名」（`null` = 没记 / 无需记） */
      colorAlias?: ColorAliasRemembered | null;
      /**
       * 归到**套装款**时自动展开的部位快照（单品恒为 `notBundle`）。
       *
       * `missingColor` 是**正常结局**（该平台色号还没配过配色）——此时一件部件都没写，
       * 界面应提示"这套还没配这个色号的配色"，而不是当成失败弹错。
       */
      bundleMaterialize?: {
        status: 'written' | 'already' | 'notBundle' | 'missingColor' | 'noProduct' | 'noItemId';
        roles: string[];
        expanded: Array<{ role: string; styleCode: string; color: string; qty: number }>;
      };
    }>
  >;
  // 全库重放已确认映射：修「映射在、订单没吃到」的历史漏网（`dryRun` 只报数不改库）
  orderReplayMappings: (payload?: { dryRun?: boolean }) => Promise<
    APIResult<SkuMappingReplayStats>
  >;
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
  // 退回待核对（归类核对页「已核对」范围里的行内动作）：把点名的已核对行置回 corrected=0。
  // 入参只有裸数组 —— **没有** { all: true } 形态（退回一律点名，理由见 order-db.ts 的实现注释）。
  orderReopenCorrected: (ids: number[]) => Promise<APIResult<{ updated: number }>>;
  // 速卖通订单采集（ae-profit / M0）：入站数据走 localhost 接收端，本区仅查询类 IPC。
  // ⚠️ 2026-10-15：原 `aeOrderList` / `aeSummary` / `aeProfitStats` 随「订单明细 / 利润统计」页
  //   并入宿主「算钱」后已无消费者，连同死表 ae_orders/ae_order_lines/ae_fees 一并删除。
  aeDbEnsure: () => Promise<APIResult<void>>;
  aeReceiverStatus: () => Promise<APIResult<AeReceiverStatus>>;
  /**
   * 订阅「采集已入库」事件（接收端写库后广播；主进程→渲染层单向）。
   * 外部进程（Chrome 扩展）写库宿主页面无法感知，靠它触发重拉。返回退订函数。
   */
  onAeItemsIngested: (cb: (event: AeItemsIngestedEvent) => void) => () => void;
  // ⚠️ 2026-10-21（C2）：`aeCostMapImport / List / UpsertManual / DeleteManual` 随 ae_cost_map
  //    退役删除（成本真源 = 产品行当前价 + 订单明细行「进价 / 实际进价」）。
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
    items?: PurchaseItem[];
    /** 来源订单快照（从数据统计跳转生成时锁定店铺归属；缺省时主进程按缺口自动推导） */
    sources?: PurchaseSourceRow[];
  }) => Promise<APIResult<{ id: number }>>;
  purchaseOrderUpdate: (payload: {
    id: number;
    bizDate?: string;
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
  purchaseTaken: () => Promise<APIResult<TakenRow[]>>;
  /** 逐行覆盖度：未发货订单每行「要几件 / 已覆盖几件」+ 无归属台账（只读） */
  purchaseOrderCoverage: () => Promise<APIResult<OrderCoveragePayload>>;
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
  /** 拿货单编辑器行图：按「款编码 + 款色」批量取本地图路径（**顺序与入参一致**，未命中为 null） */
  purchaseStyleImages: (payload: {
    items: { styleCode: string; color: string; size?: string; styleColorId?: number }[];
  }) => Promise<APIResult<{ paths: (string | null)[] }>>;
  /** 「色未定」修复的候选色：`{ [款编码大写]: 该款色行[] }`（只列事实，选哪个由用户定）
   *  ⚠️ 返回类型不要写 `Record<string, X[]>` —— `npm run verify` 的成员抽取把泛型里
   *  深度 1 的逗号当成成员分隔符，会把 `X` 误读成"仅 types 声明的通道"（实测踩过）。 */
  purchaseStyleColors: (payload: {
    styleCodes: string[];
  }) => Promise<APIResult<{ [styleCode: string]: StyleColorOptionRow[] }>>;
  /** 款色改名（产品侧改色名 → 订单侧色行跟着改标签；id / 编码 / 绑定的图不动）。
   *  `renamed=false` 时 `reason` 说明原因（`target-exists` = 该名已是一个色行，合并要人来定）。 */
  styleColorRename: (payload: {
    productId: number;
    styleCode: string;
    from: string;
    to: string;
  }) => Promise<
    APIResult<{ renamed: boolean; styleColorId?: number; reason?: string; colorAlias?: unknown }>
  >;
  // ---- 记账（店铺收支 + 公共费用分摊 + 资金相关人往来结算）----
  // 口径：记账记的是「已发生、金额确定、算谁的」业务收支，与「统计」页的订单预测毛利
  // **只并排不求和**（见 docs/plans/LEDGER_PLAN.md §1）。结算只改往来状态，不产生收支。
  /** 幂等建表（视图首次激活时调用） */
  ledgerDbEnsure: () => Promise<APIResult<{ ok: boolean }>>;
  /** 期间内可参与分摊的店铺（含被排除的及原因 —— 界面必须显式写出来） */
  ledgerEligibleShops: (payload: { period: string }) => Promise<APIResult<LedgerEligibleShops>>;
  /** 科目列表（收/支各一套；默认不含已停用） */
  ledgerCategoryList: (payload?: {
    kind?: LedgerKind;
    includeArchived?: boolean;
  }) => Promise<APIResult<LedgerCategoryRow[]>>;
  /** 新建 / 改名 / 停用科目（builtin 可改名不可删；不允许改收/支类型） */
  ledgerCategoryUpsert: (payload: {
    id?: number;
    kind?: LedgerKind;
    name?: string;
    sort?: number;
    archived?: boolean;
  }) => Promise<APIResult<{ id: number; created: boolean }>>;
  /** 分摊方案（房租 / 工资这类每月照抄） */
  ledgerRuleList: () => Promise<APIResult<LedgerRuleRow[]>>;
  ledgerRuleUpsert: (payload: {
    id?: number;
    name?: string;
    basis?: LedgerBasis;
    shopIds?: number[];
    ratios?: number[];
    note?: string;
  }) => Promise<APIResult<{ id: number; created: boolean }>>;
  /** 明细列表（按店铺筛选走**分摊行**：公共支出摊到该店的部分也算该店成本） */
  ledgerEntryList: (payload?: LedgerEntryFilter) => Promise<APIResult<LedgerEntryRow[]>>;
  /** 单条详情（含分摊明细） */
  ledgerEntryGet: (payload: { id: number }) => Promise<APIResult<LedgerEntryDetail | null>>;
  /**
   * 新建 / 更新条目（局部语义：未传的字段 = 保持原值）。
   * 公共条目（scope='shared'）必须带 `allocations`，且其合计必须**恰好等于**金额，否则拒写。
   */
  ledgerEntryUpsert: (
    payload: LedgerEntryInput,
  ) => Promise<APIResult<{ id: number; created: boolean; allocations: number; settledLocked: boolean }>>;
  /** 作废条目（不删行；已被结算单占用的须先撤销结算） */
  ledgerEntryVoid: (payload: { id: number; reason: string }) => Promise<APIResult<{ id: number; voided: boolean }>>;
  /** 恢复作废条目（`void → active`）；被有效结算单占用时拒 */
  ledgerEntryRestore: (payload: { id: number }) => Promise<APIResult<{ id: number; restored: boolean }>>;
  /** 批量作废（「撤销本次导入」用）：整批一个事务，任一条不可作废则整批回滚 */
  ledgerEntriesVoid: (payload: {
    ids: number[];
    reason: string;
  }) => Promise<APIResult<{ voided: number; ids: number[] }>>;
  /** 汇总（店铺轴 / 科目轴 + 三项体检；体检非 0 时界面必须红字提示，不许静默） */
  ledgerSummary: (payload?: {
    period?: string;
    from?: string;
    to?: string;
  }) => Promise<APIResult<LedgerSummary>>;
  /** 相关人列表 */
  ledgerPartyList: (payload?: {
    includeArchived?: boolean;
    keyword?: string;
  }) => Promise<APIResult<LedgerPartyRow[]>>;
  /** 新建 / 改相关人（`name_key` 唯一：拦住"张三"/"张三 "被建成两个人） */
  ledgerPartyUpsert: (payload: {
    id?: number;
    name?: string;
    kind?: LedgerPartyKind;
    phone?: string;
    note?: string;
    archived?: boolean;
  }) => Promise<APIResult<{ id: number; created: boolean }>>;
  /** 合并相关人：未结算条目改挂 + 已结算条目留在原处 + 残额兜底结转（合并后原人未结清必须为 0） */
  ledgerPartyMerge: (payload: {
    fromId: number;
    toId: number;
    note?: string;
  }) => Promise<APIResult<{ fromId: number; toId: number; movedEntries: number; transferredCents: number }>>;
  /** 往来台账：应收 / 应付 / 净往来 / 已结算 / 未结清（五个数缺一个用户就得自己减） */
  ledgerPartyLedger: (payload?: {
    includeArchived?: boolean;
    partyId?: number;
  }) => Promise<APIResult<LedgerPartyLedgerRow[]>>;
  /**
   * 创建结算单。**金额不由前端传** —— 主进程按勾选的条目求和（结构上没有第二个数）。
   * 方向必须与未结清符号一致、金额不得超出未结清；一条条目只能被一张有效结算单占用。
   * `offset` = 互抵结清：一张单同时挂收入与支出条目，只记净资金流（须两类都有）。
   */
  ledgerSettleCreate: (payload: {
    partyId: number;
    settleDate: string;
    direction: 'pay' | 'receive' | 'offset';
    entryIds: number[];
    method?: string;
    note?: string;
  }) => Promise<
    APIResult<{ id: number; amountCents: number; entryCount: number; cashCents: number }>
  >;
  ledgerSettleList: (payload?: { partyId?: number }) => Promise<APIResult<LedgerSettlementRow[]>>;
  /** 撤销结算（作废 + 结算行失活，这批条目恢复可结；必须填原因） */
  ledgerSettleVoid: (payload: {
    id: number;
    reason: string;
  }) => Promise<APIResult<{ id: number; voided: boolean }>>;
  /** 批量变更相关人的预演：选中条目的结算状态、涉及的结算单、原人余额会怎么变 */
  ledgerEntryRepatchPreview: (payload: {
    entryIds: number[];
  }) => Promise<APIResult<LedgerRepatchPreview>>;
  /**
   * 批量变更相关人（三路，见 LEDGER_PLAN §6.4）：
   * - `move-all`        改挂（要求全部未结算）
   * - `move-unsettled`  只改挂未结算、已结算留原人（默认推荐；**不写结转**）
   * - `void-then-move`  撤销涉及的结算单（必填原因）后改挂全部
   */
  ledgerEntryRepatch: (payload: {
    entryIds: number[];
    toPartyId: number;
    mode: LedgerRepatchMode;
    reason?: string;
  }) => Promise<APIResult<LedgerRepatchResult>>;
  /** 单店取数（三卡 + 科目分布含公摊 + 该店承担的公摊条目） */
  ledgerShopBreakdown: (payload: {
    shopId: number;
    period?: string;
    from?: string;
    to?: string;
  }) => Promise<APIResult<LedgerShopBreakdown>>;
  /** 明细导出 xlsx（业务口径全由渲染层算好传入，主进程只画表存盘） */
  ledgerExportExcel: (payload: LedgerExportInput) => Promise<APIResult<{ filePath: string; rows: number }>>;
  /**
   * 文件里的相关人 / 科目 / 店铺名 → 库里 id（批量导入用）。
   * 归一与同名判定只在主进程做（`toNameKey` 与这些表都在这侧），渲染层只消费四态。
   */
  ledgerNameResolve: (payload: {
    party?: string[];
    category?: string[];
    shop?: string[];
  }) => Promise<APIResult<LedgerNameResolveResult>>;
  /**
   * Excel 批量导入：**整批一个事务、只新增**（永不改已有条目、不产生结算单）。
   * 任一行不合法 → 整批回滚，错误带「第 N 行：」。
   */
  ledgerEntryBatchCreate: (payload: {
    entries: LedgerImportEntryInput[];
  }) => Promise<
    APIResult<{
      created: number;
      ids: number[];
      allocations: number;
      /** 本批自动新建的相关人 / 科目名字（界面要如实说出"多出了哪些名字"） */
      createdParties: string[];
      createdCategories: string[];
    }>
  >;
  /** 下载导入模板（三张表内容由渲染层给）；用户点取消 → 错误为 `__canceled__` */
  ledgerImportTemplate: (payload: {
    sheets: LedgerTemplateSheetInput[];
    defaultName: string;
  }) => Promise<APIResult<{ filePath: string; sheets: number }>>;
  // ---- 店铺账号（一行 = 店铺 + 账号，物理合并；紫鸟 / ERP 是共享登录，多店引用同一条）----
  /** 幂等建表（视图首次激活时调用） */
  shopAccountDbEnsure: () => Promise<APIResult<void>>;
  /** 合并列表（关键字 / 状态 / 企业 / 紫鸟 / ERP 联动筛选；永不返回明文密码，仅 secretKeys 标记已配置项） */
  shopAccountList: (payload?: ShopAccountListFilter) => Promise<APIResult<ShopAccountItem[]>>;
  /** 单行详情（含解密后的敏感字段，仅编辑时使用） */
  shopAccountGet: (payload: { id: number }) => Promise<APIResult<ShopAccountDetail | null>>;
  /** 汇总（总数 / 按状态 / 三种完整度计数） */
  shopAccountSummary: () => Promise<APIResult<ShopAccountSummary>>;
  /** 当前系统安全存储是否可用（不可用时前端提示密码降级存储风险） */
  shopAccountSecurity: () => Promise<APIResult<{ secureStorage: boolean }>>;
  /** 新增/更新（局部语义：缺省 = 保持原值，空串 = 清空；店名与邮箱至少填一个） */
  shopAccountUpsert: (
    payload: ShopAccountUpsertInput
  ) => Promise<APIResult<{ id: number; created: boolean; secureStorage: boolean }>>;
  /** 删除（有订单 / 商品 / 归一记录或邮件账号时拒绝，提示改「停用」） */
  shopAccountDelete: (payload: { id: number }) => Promise<APIResult<{ deleted: boolean }>>;
  /** 按需解密单个敏感字段（复制/查看，避免整条详情往返） */
  shopAccountReveal: (payload: {
    id: number;
    field: ShopAccountSecretKey;
  }) => Promise<APIResult<{ value: string }>>;
  /**
   * 批量修改（仅作用于非敏感字段；敏感密码字段在批量操作中不被允许）
   * - ids：待改店铺 id 列表（自动去重，仅保留正整数）
   * - patch：单字段修改指令；未声明的字段 = 不改
   *   - status / companyId / ziniaoAccountId / erpAccountId：覆盖（0 = 取消关联）
   *   - tags / note：{ mode: 'set' | 'append', value }
   */
  shopAccountBatchUpdate: (
    payload: ShopAccountBatchUpdateInput
  ) => Promise<APIResult<ShopAccountBatchUpdateResult>>;
  // ---- 工具账号（紫鸟 / ERP 的登录凭据：一条登录一份密码，被多家店铺共享）----
  /** 工具账号列表（kind 缺省 = 两族一起返回；含 usageCount 引用计数） */
  toolAccountList: (payload?: {
    kind?: ToolAccountKind | '';
  }) => Promise<APIResult<ToolAccountItem[]>>;
  /** 新增/更新（password 缺省 = 保持、空串 = 清除；更新时不可改 kind） */
  toolAccountUpsert: (payload: ToolAccountUpsertInput) => Promise<APIResult<{ id: number }>>;
  /** 删除（仍被店铺引用时拒绝并回传原因） */
  toolAccountDelete: (payload: { id: number }) => Promise<APIResult<{ deleted: boolean }>>;
  /** 按需解密工具账号密码 */
  toolAccountReveal: (payload: { id: number }) => Promise<APIResult<{ value: string }>>;
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
  // ---- 主数据字典（颜色 / 尺码；只读面）----
  /** 颜色字典（启用中，按 sort_order；hex 空串 = 无标准色值） */
  mdColorList: () => Promise<APIResult<{ colors: MdColorItem[] }>>;
  /**
   * 新增颜色到字典（「常用色」末尾的「＋ 新增颜色」）。
   * 幂等：同名已存在时 `created=false` 并返回既有行；纯数字色号会被拒绝。
   */
  mdColorCreate: (payload: { name: string; hex?: string }) => Promise<
    APIResult<{ color: MdColorItem | null; created: boolean }>
  >;
  /** 更新某个字典色的色块 hex（只改显示，不改名字；空串 = 没有标准色值） */
  mdColorUpdateHex: (payload: {
    id: number;
    hex: string;
  }) => Promise<APIResult<{ color: MdColorItem | null }>>;
  /** 颜色板（字典 ∪ 业务表里出现过的色名 + 用量；「颜色」页签） */
  mdColorBoard: () => Promise<APIResult<{ rows: ColorBoardItem[] }>>;
  /**
   * 颜色合并（把源色整体并进保留色）。
   * ⚠️ 真改业务数据（款色 / 产品 SKU / 别名归到保留色）；保留名不许是数字色号。
   */
  mdColorMerge: (payload: {
    source: string;
    target: string;
  }) => Promise<APIResult<{ result: ColorMergeOutcome }>>;
  /** 尺码字典（启用中，含别名） */
  mdSizeList: () => Promise<APIResult<{ sizes: MdSizeItem[] }>>;
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
  /**
   * 只改「当前进价」（分；0 = 清空）。成本面板的保存按钮走这一条 ——
   * 不经过 `productUpsert` 的全量提交（那会把厂家/类目/状态/备注一起重置）。
   */
  productCostSet: (payload: {
    code: string;
    costCents: number;
  }) => Promise<APIResult<{ found: boolean; updated: boolean }>>;
  /** 有当前进价的款编码集合（`pl_products.cost_cents > 0`；「今天」缺口卡用） */
  productPricedCodes: () => Promise<APIResult<{ codes: string[] }>>;
  /** 汇总（总数 / 按状态 / 厂家分布 / 未关联厂家数；supplierOptions 为**全量**厂家，供下拉） */
  productSummary: () => Promise<APIResult<ProductSummary>>;
  /** 下一个款编码（建款向导「系统发号」只读展示；主进程发号器，渲染层勿自行 max+1） */
  productNextCode: () => Promise<APIResult<{ code: string }>>;
  /** Excel 批量导入（单事务）；mode='insertOnly' 时编码已存在的行记为失败而不覆盖 */
  productImport: (payload: {
    items: ProductImportRowInput[];
    mode?: 'upsert' | 'insertOnly';
  }) => Promise<APIResult<ProductImportOutcome>>;
  /**
   * 导出 / 下载模板：渲染层给「每格写什么 + 每行的图路径」，**主进程**用 exceljs 生成并嵌图。
   * 空表头 = invalid payload。
   */
  productExport: (payload: {
    sheetName: string;
    headers: string[];
    /** 数据行（不含表头）；`cells` 长度与 `headers` 对齐 */
    rows: { cells: string[]; imagePath?: string }[];
    /** 「图片」列的 0 基下标（图就嵌在这一列上） */
    imageColumn: number;
    defaultName?: string;
  }) => Promise<APIResult<{ filePath: string; embedded: number; imagesFailed: number }>>;
  /**
   * 从导入的 xlsx 里抽**嵌入图片**：落盘 + 登记 `pl_images` → 按**锚点行号**报回。
   * `sheetName` / `headerRow` 由渲染层解析得出（只有它知道哪张表是产品表）。
   */
  productExtractImages: (payload: {
    buffer: ArrayBuffer;
    sheetName: string;
    /** 表头所在行（1-based） */
    headerRow: number;
  }) => Promise<
    APIResult<{
      /** 行号（字符串键，1-based Excel 行）→ 图 */
      byRow: Record<string, { imageId: number; localPath: string }>;
      /** 没能归位的图（表头以上 / 该行已有图 / 格式不认识…） */
      skips: { rowNo: number; reason: string }[];
      total: number;
    }>
  >;
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
   *  `reassigned` = 顺带处理的**存量订单行数**（映射写入后重跑确定性归款：新归款 + 补色）
   *  `adopted` = 顺手把订单图采纳为**款主图**的张数（只补空、已有主图的款不动） */
  productSkuMap: (payload: {
    rows: SkuMapInputPayload[];
    /** 是否顺手把商品图采纳为款主图（缺省 true = 认款就补图）。
     *  显式 false 只来自「建档并关联」向导里用户取消勾选「采纳为款主图」——
     *  此时不能绕过人的选择去下载/采纳。 */
    adoptImages?: boolean;
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
  /**
   * 存量补图：把「已确认认款、但款还没主图」的商品图（本地订单图 + 采集远程图）补上。
   * 只补空、不覆盖；`pending` = 这一轮之后仍有几个款没补上（下载失败/超出单轮上限）。
   */
  productSkuRepairImages: (payload?: {
    /** 单轮最多下载几张远程图（缺省/非法 = 40，硬上限同主进程） */
    limit?: number;
  }) => Promise<APIResult<{ adopted: number; pending: number }>>;
  // ---- SKU 子表（pl_variants：一个款下多个 SKU，每 SKU 一个克重）----
  productVariantList: (payload: { productIds: number[] }) => Promise<APIResult<{ rows: VariantRow[] }>>;
  productVariantUpsert: (payload: VariantUpsertInput) => Promise<APIResult<{ id: number; created: boolean }>>;
  productVariantDelete: (payload: { id: number }) => Promise<APIResult<{ removed: number }>>;
  productBatchUpdate: (
    payload: ProductBatchUpdateInput,
  ) => Promise<APIResult<{ updated: number }>>;
  productMoveSupplier: (
    payload: ProductMoveSupplierInput,
  ) => Promise<APIResult<{ changed: boolean }>>;
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
  // 补上缺失的"店铺"实体层：历史文本（订单 / 采购两处）**不改写**，靠名称归一映射旁挂关联。
  /** 幂等建表（视图首次激活时调用） */
  shopDbEnsure: () => Promise<APIResult<{ ok: boolean }>>;
  /** 店铺列表（关键字 / 平台 / 状态过滤 + 分页；按平台 → 名称升序） */
  shopList: (payload?: {
    search?: string;
    platform?: string;
    status?: ShopStatus | '';
    offset?: number;
    limit?: number;
  }) => Promise<APIResult<{ rows: ShopListItem[]; total: number }>>;
  /** 单条详情（不存在返回 null） */
  shopGet: (payload: { id: number }) => Promise<APIResult<ShopListItem | null>>;
  /** 新增/更新（**局部更新**：缺省字段保持原值；同平台同名冲突时主进程抛错，不静默合并） */
  shopUpsert: (payload: ShopUpsertInput) => Promise<APIResult<{ id: number; created: boolean }>>;
  /** 汇总（店铺数 / 按平台 / 按状态 + 两处历史文本的归一进度） */
  shopSummary: () => Promise<APIResult<ShopSummary>>;
  /** 未归一的历史店铺名（实时聚合两处文本，非缓存表） */
  shopUnmapped: () => Promise<APIResult<UnmappedShopRow[]>>;
  /**
   * 门 1（店铺归一）：**订单里**出现过、还没归成店铺实体的店名 + 各自的订单行数。
   *
   * 与 `shopUnmapped` 的差别只有一个，但很关键：**作用域**。那个是两处历史文本的合集
   * （含历史拿货单里的旧店名，那部分归一了也不会消失），这个只数订单 ——
   * 因为它保护的是"款/色的身份"（键含店名），而不是"还有哪些店名没整理"。
   */
  shopGate: () => Promise<APIResult<ShopGate>>;
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
  /** 店铺商品快照列表（按店铺 / 搜索 / 分页；shopId<0 = 只看未登记；productId = 只看当前认到该款的） */
  shopItemsList: (payload?: {
    shopId?: number;
    search?: string;
    page?: number;
    pageSize?: number;
    onlyUnconfirmed?: boolean;
    productId?: number;
  }) => Promise<APIResult<{ rows: ShopItemRow[]; total: number }>>;
  /** 采集汇总（每家店：采集数 / 已认款数 / 最近采集时间） */
  shopItemsSummary: () => Promise<APIResult<ShopItemSummaryRow[]>>;
  /** 手贴商品ID导入（保底通道：列表页选择器全落空时贴 ID 进来；shopId=0 = 未登记桶） */
  shopItemsImport: (payload: {
    shopId?: number;
    ids?: string[];
  }) => Promise<APIResult<{ received: number; inserted: number; updated: number; skipped: number }>>;
  /**
   * 下载采集图入库（主进程 net 下载 → landImageBuffer 去重 → 回填 pl_shop_items.image_id）。
   * `adoptMain=true` 且带 productId 时顺手采纳为款主图（只补空）；
   * `colors[]` = 每色图采纳为款色绑定图（只补空；下载/采纳失败逐张进 reason，不外抛）。
   */
  shopItemImageFetch: (payload: {
    id: number;
    productId?: number;
    adoptMain?: boolean;
    colors?: { color: string; imageUrl: string }[];
  }) => Promise<APIResult<ShopItemImageFetchResult>>;
  /** 删一条采集行（按行 id；同一商品ID 在多家店下各是一行，不能按 item_id 删） */
  shopItemsDelete: (payload: { id: number }) => Promise<APIResult<{ removed: boolean }>>;
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

/**
 * 主数据：颜色字典行（`md_colors`，只读面）。
 *
 * `hex` 空串 = 这一色没有标准色值（如「印花多色」）——界面给中性灰，**不要**按色名猜一个。
 */
export interface MdColorItem {
  id: number;
  name: string;
  hex: string;
  sortOrder: number;
  status: string;
}

/**
 * 颜色板的一行（`md-color-board`）：一个色名 + 它在三个业务面各用了多少。
 *
 * `colorId = 0` 表示它只在业务表里（还没进字典）；`numeric` = 平台数字色号
 * （只能当合并的源，不能当保留名 —— 与 `md-color-create` 同一条校验）。
 */
export interface ColorBoardItem {
  name: string;
  colorId: number;
  hex: string;
  /** 用到它的款数（`oi_style_colors` 去重 style_id） */
  styles: number;
  /** 它的 SKU 数（`pl_variants`） */
  skus: number;
  /** 指向它的订单明细行数 */
  orders: number;
  inDict: boolean;
  numeric: boolean;
  /**
   * 这个色名的**代表款图**本地路径（`oi_style_colors.image_id` → `md_images.local_path`）。
   *
   * 数字色号 / 平台原文色名只有字符串（`5` 是红是蓝看不出来），归一列表靠这张图让用户
   * 认得出该并给谁。空串 = 该色在款色表里还没有图（界面画空占位，不拿中性灰冒充）。
   */
  imagePath: string;
}

/** 颜色合并回执（`md-color-merge`）：说清"动了多少"，界面据此给一句可核对的回执 */
export interface ColorMergeOutcome {
  source: string;
  target: string;
  dictRemoved: number;
  aliases: number;
  styleRenamed: number;
  styleMerged: number;
  orders: number;
  keys: number;
  parts: number;
  skusRenamed: number;
  skusMerged: number;
}

/** 主数据：尺码字典行（`md_sizes`，只读面）。`aliases` 是逗号分隔的平台写法 */
export interface MdSizeItem {
  id: number;
  name: string;
  sortOrder: number;
  sizeGroup: string;
  aliases: string;
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

/** 图片记录（`md_images` 主数据行；R1 起全项目只有这一张图片表，无识别流水线字段） */
export interface OrderImageRecord {
  id?: number;
  /** 内容指纹 SHA-256（唯一；文件名就是它） */
  fingerprint: string;
  /** URL 规范化指纹（同图不同签名参数去重；普通索引，不做唯一） */
  urlFingerprint: string;
  sourceUrl: string;
  /** 本地绝对路径（`userData/images/<fingerprint><ext>`） */
  localPath: string;
  /** 来源标记：order-image / product-image / shop-item / upload …（只用于排查，不参与判定） */
  source: string;
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

/**
 * 款选项（「归类核对」页「归属款」下拉的一行）。
 *
 * ⚠️ 数据源是**产品库**（`pl_products`），不是识别池（`oi_styles`）—— 只有进过识别链路的款
 * 才在识别池里，于是「货与成本」手工新建、还没出过订单的款在下拉里一个都不出现
 * （2026-10-10 用户报的「当前数据展示不全」就是这个）。两处 code 是**同一编码池**（D1）。
 *
 * `colors` 给「先选款、再选颜色」用：产品库 SKU 的颜色在前（主数据），识别链已学到的
 * 款色在后（历史结论），去重。**空数组是合法状态**（这个款还没录任何颜色）⇒ 界面必须
 * 回落成"自己填"，不能给一个空下拉。
 */
export interface StyleRecord {
  /** 产品编码（`pl_products.code` ≡ `oi_styles.code`） */
  code: string;
  /** 展示名（唯一权威在 `pl_products.name`） */
  name: string;
  /** `active` / `archived`（停用款仍要能选：历史订单可能正指向它） */
  status: string;
  /** 可选颜色（去重；产品库 SKU 颜色在前） */
  colors: string[];
}

// ─────────────────────────────────────────── 命名板（P3，2026-10-28）
//
// 为什么要有这一组类型：归类自动化之后，订单进来就已经按变体键归好，人这一端唯一还剩的
// 判断是"这个色在我生意里叫什么"。命名板就是那个判断的界面 —— 它按 **listing** 分组
// （一个 listing 常有 4-6 个色键，必须一屏填完），组内一行是一个色键。
//
// ⚠️ 这些字段是**投影**，不是表：`named` 由「当前名 vs 平台原文」现算（不存档），
//    所以改名之后刷新一次，标记就跟着变 —— 存成标志位会漂。

/** 命名板的一行 = 一个变体键（`oi_variant_keys.variant_key`） */
export interface VariantColorItem {
  styleColorId: number;
  styleCode: string;
  /** 款名（产品库 `pl_products.name`；空串 = 还没起款名，不冒充） */
  styleName: string;
  /** 当前落库的色名（可能就是平台原文） */
  colorName: string;
  /** 平台色原文（订单行 `color` 列，导入时原样落库的值） */
  colorRaw: string;
  /** 是否已有人给过名字（派生：`colorName` 与 `colorRaw` 不同） */
  named: boolean;
  orderRows: number;
  /** 件数（`SUM(qty)`；存量行件数缺失时用行数兜） */
  qty: number;
  /** 代表图的本地路径（用 `orderImageThumbBatch` 换成 dataURL 显示） */
  localPath: string;
}

/** 命名板的一组 = 一个 listing（店铺 + 商品ID）下的全部色键 */
export interface VariantNamingGroup {
  shop: string;
  itemId: string;
  /** 产品标题（取不到时回落商品ID） */
  title: string;
  /** 组内各色**共属**的款 id；`0` = 分属多个款（人工合并过），不给整组编辑入口 */
  styleId: number;
  styleCode: string;
  /** 款名（`pl_products.name`；空串 = 占位款，还没人起名） */
  styleName: string;
  /** 厂家 id（0 = 未指定） */
  supplierId: number;
  /** 组内涉及的款数（>1 时界面要说明为什么不能整组改） */
  styleCount: number;
  colors: VariantColorItem[];
}

/** 改款名 / 改厂家的结果（`ok=false` 时 `error` 是给用户看的原话） */
export interface SaveStyleBasicsOutcome {
  ok: boolean;
  error?: string;
  styleId: number;
  styleCode: string;
  /** 保存后的实际值（主进程回读，不用界面送来的值回显） */
  name: string;
  supplierId: number;
}

export interface VariantNamingBoard {
  groups: VariantNamingGroup[];
  /** 还没人给过名字的键数（页签角标 / 折叠标题读它） */
  unnamedKeys: number;
  totalKeys: number;
}

/** 改色名的结果（`ok=false` 时 `error` 是给用户看的原话） */
export interface RenameColorOutcome {
  ok: boolean;
  error?: string;
  styleColorId: number;
  name: string;
  /** 这次改名覆盖到的键数 */
  keys: number;
}

// ── 款合并（拿货页的"这几个款其实是同一件货"）────────────────────────────────

/** 候选里的一个款 */
export interface MergeStyleBrief {
  styleId: number;
  styleCode: string;
  styleName: string;
  keyCount: number;
  colorCount: number;
  rowCount: number;
  /** 色名/原文（最多 10 个） */
  colors: string[];
  /** 示例图本地路径（可能空） */
  imagePath: string;
}

/** 同厂家下的一组候选 */
export interface MergeCandidateGroup {
  supplierId: number;
  supplierName: string;
  styles: MergeStyleBrief[];
}

/** 一次已发生的合并（按**批次**聚合：一次操作可能并进多个款） */
export interface StyleMergeRecord {
  batchId: string;
  targetStyleId: number;
  targetStyleCode: string;
  sources: Array<{ styleId: number; styleCode: string }>;
  movedColors: number;
  movedKeys: number;
  createdAt: string;
}

export interface StyleMergeBoard {
  groups: MergeCandidateGroup[];
  merges: StyleMergeRecord[];
}

export interface MergeStylesOutcome {
  ok: boolean;
  error?: string;
  batchId: string;
  targetStyleId: number;
  movedColors: number;
  movedKeys: number;
}

export interface UnmergeOutcome {
  ok: boolean;
  error?: string;
  restored: number;
  skipped: number;
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
  /** 款色 id（身份键，来自缺口行）。0 = 老数据/色未定 ⇒ 回落文本匹配 */
  styleColorId?: number;
}


/** 拿货单的来源订单快照行（生成拿货单时锁定的订单明细，含店铺/尺码，用于按店铺拆分成本） */
export interface PurchaseSourceRow {
  /** 订单所属店铺 */
  shop: string;
  styleCode: string;
  styleName?: string;
  color: string;
  size: string;
  /** 这条来源覆盖的件数（一条订单行 × 覆盖件数，可以是 2） */
  qty: number;
  /** 指向 `oi_order_items.id`；0 = 无归属（加列之前的历史单 / 订单行不够） */
  orderItemId?: number;
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

// ---- 店铺账号（原「店铺账号管家」与「店铺登记」合并后的单一行）----
//
// 业务模型：一行 = 一家店铺 + 它的账号（`sk_shops` 物理合并，不再有"店铺套"中间层）。
// 店名与邮箱至少有一个：只有邮箱 = 还没建店铺（accountOnly），只有店名 = 账号待补（shopOnly）。
// 手机号 / 支付宝 / 企业名在企业表（`sk_companies`）维护，本结构只读带出用于列表与筛选。
// 紫鸟 / ERP 是共享登录（`sk_tool_accounts`）：一条登录一份密码，多家店铺引用同一条。

/**
 * 店铺状态：启用 / 停用 / 封店 / 退店。
 * 后三者只做标记、不物理删除 —— 历史订单 / 采购仍指向它。
 */
export type ShopAccountStatus = 'active' | 'archived' | 'banned' | 'exited';

/**
 * 店铺行上的敏感字段键（统一经主进程 safeStorage 加密落库；列表接口永不返回明文）
 * 紫鸟 / ERP 密码不在这里 —— 它们跟着工具账号走。
 * mailAuthPwd = IMAP 授权码（集中邮件收件箱专用，与 emailPwd 登录密码是两套凭据）
 */
export type ShopAccountSecretKey = 'shopPwd' | 'emailPwd' | 'alipayPwd' | 'mailAuthPwd';

/** 工具账号类型：紫鸟 / ERP */
export type ToolAccountKind = 'ziniao' | 'erp';

/** 店铺账号列表行（可检索元数据 + 已配置的敏感字段标记，不含任何明文密码） */
export interface ShopAccountItem {
  id: number;
  platform: string;
  /** 店名；'' = 纯账号行（还没建店铺） */
  name: string;
  /** 归一键（店铺名唯一性判定用） */
  nameKey: string;
  /** 平台店铺ID（稳定业务键，改名不影响） */
  platformShopId: string;
  /** 店铺地址原文（展示 / 「打开店铺」的目标；'' = 未填） */
  shopUrl: string;
  site: string;
  /** 店铺邮箱；'' = 纯店铺行（账号待补） */
  email: string;
  /** 关联企业 id（`sk_companies` 主键；0 = 未关联） */
  companyId: number;
  /** 企业名（企业表带出，只读） */
  companyName: string;
  /** 企业联系电话（只读带出，用于列表与筛选） */
  phone: string;
  /** 企业支付宝（运费扣款；只读带出） */
  alipay: string;
  /** 关联紫鸟工具账号 id（0 = 未关联） */
  ziniaoAccountId: number;
  /** 关联 ERP 工具账号 id（0 = 未关联） */
  erpAccountId: number;
  /** 紫鸟账号（工具表带出，只读） */
  ziniaoAccount: string;
  /** ERP 账号（工具表带出，只读） */
  erpAccount: string;
  status: ShopAccountStatus;
  /** 记分分值（平台记分 / 扣分；0 = 未记录） */
  score: number;
  /** 开店时间（YYYY-MM-DD；空串 = 未填写） */
  openedAt: string;
  /** 保证金到账时间（YYYY-MM-DD；退店时填写，空串 = 未填写） */
  depositReceivedAt: string;
  tags: string;
  note: string;
  /** 已配置值的敏感字段（仅供 UI 展示「已保存」徽标，不含任何明文） */
  secretKeys: ShopAccountSecretKey[];
  /** 是否挂着邮件账号（删除确认要写明级联删除范围） */
  hasMailAccount: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 店铺账号详情（含解密后的敏感字段，仅编辑时获取） */
export interface ShopAccountDetail extends ShopAccountItem {
  secrets: Partial<Record<ShopAccountSecretKey, string>>;
}

/** 列表筛选：企业与工具账号用 `undefined = 不筛选 / 0 = 未关联 / > 0 = 指定项` 三态 */
export interface ShopAccountListFilter {
  search?: string;
  status?: ShopAccountStatus | '';
  companyId?: number;
  ziniaoAccountId?: number;
  erpAccountId?: number;
}

/**
 * 店铺账号写入入参（**局部语义**：`undefined = 保持原值`，`'' = 清空`）
 * - secrets：字段缺省 = 保持原值；空串 = 清空；非空 = 覆盖
 * - clearSecrets：明确清除的敏感字段（与 secrets 同时传时 clear 优先）
 */
export interface ShopAccountUpsertInput {
  id?: number;
  name?: string;
  platform?: string;
  platformShopId?: string;
  shopUrl?: string;
  site?: string;
  email?: string;
  /** 0 = 取消关联；> 0 = 关联该企业（企业名 / 手机号 / 支付宝由企业表带出） */
  companyId?: number;
  /** 0 = 取消关联；> 0 = 引用该工具账号 */
  ziniaoAccountId?: number;
  erpAccountId?: number;
  status?: ShopAccountStatus;
  /** 记分分值（≥ 0；缺省 = 保持原值，0 = 清为未记录） */
  score?: number;
  /** 开店时间（YYYY-MM-DD）；字符串（含空串）= 覆盖，缺省 = 保持原值 */
  openedAt?: string;
  /** 保证金到账时间（YYYY-MM-DD）；字符串（含空串）= 覆盖，缺省 = 保持原值 */
  depositReceivedAt?: string;
  tags?: string;
  note?: string;
  secrets?: Partial<Record<ShopAccountSecretKey, string>>;
  clearSecrets?: ShopAccountSecretKey[];
}

/** 工具账号（紫鸟 / ERP 共享登录；密码只进不出） */
export interface ToolAccountItem {
  id: number;
  kind: ToolAccountKind;
  account: string;
  note: string;
  /** 被多少家店铺引用（> 0 时不可删除） */
  usageCount: number;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

/** 工具账号写入入参（局部语义；更新时不可改 kind） */
export interface ToolAccountUpsertInput {
  id?: number;
  /** 新增时必填 */
  kind?: ToolAccountKind;
  account?: string;
  note?: string;
  /** 缺省 = 保持；空串 = 清除；非空 = 覆盖 */
  password?: string;
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
  /** 联系电话（与支付宝一一配对：一个企业的手机号与运费扣款支付宝固定搭配） */
  contactPhone: string;
  /** 扣运费的支付宝账号（一企业一份；店铺行只读展示，密码仍在店铺行） */
  alipayAccount: string;
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
  /** 扣运费的支付宝账号（字段缺省 = 保持；空串 = 清空） */
  alipayAccount?: string;
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
  /** 内部编码：与 oi_styles.code / purchase_items.style_code 同口径 */
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
  /** **当前进价**（分；0 = 未填）。产品级维护入口；订单行快照另存 `oi_order_items.cost_cents` */
  costCents: number;
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

/** 按款编码改厂家（拣货宫格拖拽的写入口；写是**款级**的 —— 该款所有款色一起走） */
export interface ProductMoveSupplierInput {
  /** 款编码（`pl_products.code`；未识别款没有可写的款） */
  code: string;
  /** 目标厂家 suppliers(id)；0 = 清空关联（"未指定厂家"格是合法落点） */
  supplierId: number;
}

/**
 * **统一订单行**（两条摄取通道共用的形状，C1 合并的落点）：
 *   · `order-shipping-rows`（Excel 报表导入 → `oi_orders` 投影）
 *   · `order-collected-rows`（浏览器采集 → `oi_orders` 投影）
 *
 * **只放主线（算钱 + 拣货）真正读的字段**（用户 2026-09-30 定的原则：精简优先、非必要先删、必要再加）：
 * 已删掉货值/买家运费/店铺优惠/平台补贴/币种/业务模式/付款·收货时点/发货时点等 9 个**零读者**字段 ——
 * 它们并没有丢：原始整行仍在 `rawFields`（导入侧）与 `raw_json`（采集侧）里保真，**要加回来随时可重新提取**。
 * 金额一律 **CNY 分**；`null` = 源里没有这一项（**不是 0**，0 会让"缺收入"看起来像"收入为零"）。
 *
 * 2026-11-01（M2）**加回 4 个字段**，它们现在有真读者了 —— 不是推翻上面的原则，正是执行它：
 * `payTime` / `dealDeadline` / `timeoutAt` 供「今天要发几单、哪几单快超时」用，`imageId` 供「缺图 K」用。
 */
export interface UnifiedOrderRow {
  id: number;
  orderNo: string;
  /** 摄取通道（主干 `source`）：`import` = 报表导入 · `collect` = 浏览器采集 */
  source: 'import' | 'collect';
  shop: string;
  /** 店名归一键（主进程 `toNameKey` 算好）—— 按店铺身份聚合营收时用它，别在渲染层自己 trim */
  shopKey: string;
  orderTime: string;
  /** 识别链 `oi_images.style_color_id → oi_style_colors → oi_styles` 的结果（采集侧取 `style_code`）；未识别为空串 */
  styleCode: string;
  styleColor: string;
  /** 款色**身份**（`oi_style_colors.id`；0 = 未归类）—— 逐行覆盖度靠它拼台账键 */
  styleColorId: number;
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
  /** 行级克重**快照**（`oi_order_items.weight_g`，归类核对确认时钉）；`null` = 还没钉 ⇒ 读方回落 SKU 查表 */
  weightG?: number | null;
  /** 行级**进价预估**快照（`oi_order_items.cost_cents`，归类确认时按产品当时价钉；单位：分）；`null` = 还没钉 */
  costCents?: number | null;
  /** 行级**实际进价**快照（`oi_order_items.actual_cost_cents`，拿货落账后回写；单位：分）；`null` = 还没落账 */
  actualCostCents?: number | null;
  /** 付款时点（采集侧写入；导入侧为空串）—— 发货时效的起点 */
  payTime: string;
  /**
   * 最晚发货时点（芒果 `sendGoodExpiredDate`）。**D-2 已定：这就是真倒计时**，
   * 「有截止风险」只认这一列；空串 = 不知道（导入单没有这一列）。
   */
  dealDeadline: string;
  /**
   * 芒果 `qualifiedTime`（比 `dealDeadline` 早 6 天）。**只存不用**，不参与任何告警判定 ——
   * 与 `dealDeadline` 取"更近的那个"会把稳定偏差变成一堆假超时。
   */
  timeoutAt: string;
  /** 行图（`oi_order_items.image_id`；**0 = 没落地**）—— 图案槽位与「缺图」统计读它 */
  imageId: number;
  /** 原始整行（导入侧保真：件数解析、商品ID 提取都从这里；采集侧为空对象） */
  rawFields: Record<string, string>;
}

// ---- 包裹（阶段 B2）：一单多包 / 按商品行拆 / 拆合并行数量 ----
//
// 单位与空值口径跟主进程一致：金额「分」、重量「克」，**null = 还不知道**（不是 0）。
// 「还能拆几件」由主进程算好（`remaining`），界面不再自己减一遍 —— 两处减法必然有一天不一致。

/** 包裹里的一个订单行（一个包可以只装某行的部分件数） */
export interface ParcelLine {
  id: number;
  orderItemId: number;
  qty: number;
}

/** 一个包裹 */
export interface Parcel {
  id: number;
  orderNo: string;
  /** 人工标注的包名（「箱 1」/「补发」）；空串 = 只按顺序展示 */
  label: string;
  trackingNo: string;
  carrier: string;
  shipCents: number | null;
  weightG: number | null;
  note: string;
  lines: ParcelLine[];
  createdAt: string;
}

/** 拆包面板的候选行：订单行 + 已分包件数 + 还能拆几件 */
export interface ParcelItem {
  id: number;
  styleCode: string;
  styleColor: string;
  color: string;
  size: string;
  /** 件数真值（`oi_order_items.qty`）；null = 导入侧没解析出来（不是 0） */
  qty: number | null;
  packed: number;
  /** 还能拆几件；`qty` 未知时 null */
  remaining: number | null;
  weightG: number | null;
}

/** 一单的包裹汇总（**派生**，不落库：总物流费/总重 = Σ 包裹；任一包缺值 ⇒ 整单 null） */
export interface ParcelTotals {
  count: number;
  shipCents: number | null;
  weightG: number | null;
  shipMissing: number;
  weightMissing: number;
}

/** `order-parcel-detail` 的返回（拆包面板一次取全） */
export interface ParcelDetail {
  parcels: Parcel[];
  items: ParcelItem[];
  totals: ParcelTotals;
}

/**
 * 「单号 → 包数」。
 * ⚠️ 单独起个名字而**不**在 `ElectronAPI` 里直接写 `Record<string, number>`：
 * `scripts/check-ipc-contract.mjs` 是按**顶层逗号**切成员的（尖括号不算深度），
 * `Record<string, number>` 里的逗号会被切成两条 ⇒ 冒出一个叫 `number` 的假成员、契约校验红。
 * （脚本的局限，不是契约错；换个写法即可，不必去改校验器。）
 */
export type ParcelCountMap = Record<string, number>;

/** 「单号 → 包裹汇总」（`order-parcel-totals` 的返回）。单独起名的理由同 `ParcelCountMap`。 */
export type ParcelTotalsMap = Record<string, ParcelTotals>;

/** 拣货投影行（宿主 `picking-rows` 返回；纯层 `src/lib/picking.ts` 直接消费它） */
export interface PickingRowProjection {
  id: number;
  orderNo: string;
  shop: string;
  orderTime: string;
  /** 识别链结果；未识别为空串 */
  styleCode: string;
  /** 款名（`oi_styles.name`）；未识别款 / 该款没录名字为空串（供「拿货单」明细预填名称） */
  styleName: string;
  styleColor: string;
  /**
   * 款色 id —— **身份**（分组与"已拿"匹配的键）。0 = 未归类。
   *
   * 为什么必须有它（2026-10-20）：色名是**会变的标签**（映射确认/人工核对都会改写），
   * 拿它当匹配键 ⇒ 改一次名，历史拿货单一条都匹配不上（真库 10 行全部变"待拿"，无任何报错）。
   * 身份一律走 id；色名只用于展示与历史单据快照。
   */
  styleColorId: number;
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
  /** 行级**实际进价**（`oi_order_items.actual_cost_cents`，分）；null = 还没拿货落账 */
  actualCostCents: number | null;
  /** 行级**进价预估**（`oi_order_items.cost_cents`，分）；null = 还没钉过 */
  costCents: number | null;
  /** 产品**当前进价**（`pl_products.cost_cents`，分）；null = 未识别款 / 没维护。
   *  拣货金额的最后一档（前两档没有值时才用）—— "这批大概要花多少钱"的经营估算。 */
  productCostCents: number | null;
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
  /** **需求件数**（这批订单要几件） */
  pieces: number;
  /** **已拿件数**（已提交拿货单的合计；与 `purchase-db.outstanding()` 同一口径） */
  taken: number;
  /** **还差件数** = `max(0, pieces − taken)` —— 厂家照着拿的就是这个数 */
  remaining: number;
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
  /** 当前进价（分）。**不传 = 不修改**（全量提交里的唯一例外，见主进程 `upsertProduct`） */
  costCents?: number;
}

/** Excel 批量导入的一行（字段已在渲染层解析校验；主进程只做兜底与落库） */
export interface ProductImportRowInput {
  rowNo: number;
  code: string;
  name: string;
  supplierId: number;
  /**
   * 供应商**原文**（Excel 里写的那个名字；2026-10-10 新增）。
   *
   * 为什么两样都要：`supplierId` 只在"库里已有这个名字"时非 0；名字对不上时它是 0，
   * 主进程就看不到用户写的到底是哪家 ⇒「按名称查找、不存在则新建」无从执行。
   * 空串 = 用户没填供应商（**不是**"未关联"）。
   */
  supplierRaw?: string;
  status: string;
  note: string;
  /** 该行声明的 SKU；空数组 = 这行没说 SKU（不是"删掉该款现有 SKU"） */
  skus: { color: string; size: string; weightG: number }[];
  /** 该行 Excel 里那张图（`product-extract-images` 的产物）；0 = 没图，不覆盖款上已有主图 */
  imageId: number;
  /**
   * 手工进价（**分**；写产品行的 `pl_products.cost_cents` = 当前进价）。
   * `null` / 缺省 = 这行没填进价 ⇒ **不修改**库内已有价（**不是清 0**）。
   */
  costCents?: number | null;
}

/** 批量导入结果（`failed` 为库层才拦得住的失败行，如 insertOnly 模式下编码已存在） */
export interface ProductImportOutcome {
  created: number;
  updated: number;
  /** 本次真正写库的 SKU 条数（新增 + 更新） */
  skusWritten: number;
  /** 本次设为款主图的张数 */
  imagesAttached: number;
  /** 本次写入产品行「当前进价」的条数 */
  costsWritten: number;
  /** 因与库内现价相同（幂等）或未填而被跳过的进价条数 */
  costsSkipped: number;
  /**
   * 本次**新建**的供应商条数（2026-10-10）。
   * 单独回报是因为"名字对不上 ⇒ 静默落成未关联"曾经是默认行为，
   * 用户看不见有没有真的建档 —— 这个数字就是那句话。
   */
  suppliersCreated?: number;
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
  /**
   * 店铺 id。**0 = 让主进程按商品ID 认店**（2026-10-20）。
   *
   * 为什么允许 0：从「拿货 › 未归类」配映射时，界面手里只有商品ID（订单行不带店铺 id），
   * 硬要它先查店铺等于逼用户回「归类核对」重做一遍。认店走既有证据链末级
   * `shopIdByItemId`（商品ID 反查），**认不出就报错、不猜**（多店歧义/无证据）。
   */
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
 * ⭐ 归类核对顺带记住的**色名对照**：把平台侧那个怪名字（`Khaki` / `1`）换成自家色名。
 *
 * 与 `SkuBackfillOutcome` 同一性质 —— **附加产物**：`null` 时"归属已改"照样是成功的。
 * 记住之后，同一款后续订单（以及同商品的历史订单）自动落成 `to` 这个名字。
 */
export interface ColorAliasRemembered {
  /** 平台侧原文（用户改之前看到的名字） */
  from: string;
  /** 用户填的自家色名 */
  to: string;
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
// 病根（该计划 D1/D2）：店铺实体不存在，店名以自由文本各存两处且互相拷贝 ——
//   oi_orders.shop / purchase_sources.shop
// （2026-10-15：`ae_orders.shop_name` 曾是第三处，随 `ae_orders` 弃表一并删。）
// 本层补实体层，历史文本一律不改写（G2）；关联靠 sk_name_map 的归一映射。
// ⚠️ 两处文本**都没有平台字段** → `platform` 无法从历史数据推导，只能在登记店铺时由人指定。
// ---------------------------------------------------------------------------

/**
 * 店铺状态：启用 / 停用 / 封店 / 退店。
 * 后三者只是标记，不物理删除 —— 历史订单仍指向它。
 */
export type ShopStatus = 'active' | 'archived' | 'banned' | 'exited';

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
  /**
   * 店铺地址（**原文**，界面回显 + 「打开店铺」的目标；'' = 未填）。
   * ⚠️ 与库里那个**匹配键**不是一回事：键存 `sk_shops.shop_url`（协议/www/尾斜杠/index.html/
   * 查询串全剥掉），且**不出现在本结构里** —— 剥掉协议的串打不开（2026-10-16 修的现场）。
   * 采集帧的 URL 匹配走主进程内部，与这里的展示值无关。
   */
  shopUrl: string;
  site: string;
  status: string;
  /** 记分分值（平台记分 / 扣分；0 = 未记录） */
  score: number;
  openedAt: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  /** 已归一到本店的历史文本条数 */
  aliasCount: number;
}

/**
 * 店铺侧新增/更新入参（**局部更新**语义：`undefined = 保持原值`，`'' = 清空`）。
 * ⚠️ 物理合并后这是硬约束：店铺选择器编辑一次不能把同一行的邮箱 / 企业 / 工具 / 凭证清空。
 */
export interface ShopUpsertInput {
  /** 0 / 缺省 = 新增 */
  id: number;
  platform?: string;
  name?: string;
  /** 平台店铺ID（可空；非空时参与唯一性 —— 同平台内不得重复） */
  platformShopId?: string;
  /**
   * 店铺地址（**用户填的原文**，可空；主进程据此派生采集帧的匹配键）。
   * 落库时会规整成"可打开的地址"：已带 `http(s)://` 的原样保留，裸域名补 `https://`
   * （见 `electron/shop-db.ts` 的 `toOpenableUrl`）。再次编辑时回显的就是这个规整后的原文。
   */
  shopUrl?: string;
  site?: string;
  status?: string;
  /** 记分分值（≥ 0；缺省 = 保持原值，0 = 清为未记录） */
  score?: number;
  openedAt?: string;
  note?: string;
}

/** 门 1 的一行：订单里出现过、但还没归成店铺实体的店名 */
export interface ShopGateRow {
  key: string;
  raw: string;
  /** 这个店名在订单里有多少行（"值不值得现在做"看它，不看店铺家数） */
  orders: number;
  /** 同名候选店铺（空 = 库里还没有这家店，得先去登记） */
  autoShopName: string;
  autoShopPlatform: string;
}

/**
 * 门 1（店铺归一）的派生状态。`pending` 为空 = 门是开的。
 *
 * ⚠️ **不阻断任何按钮**：它保护的是"数字口径"（同一家店被当成两家 ⇒ 同一件货在统计里两行），
 *    不是某个动作。理由见 `docs/notes/2026-10-30-order-purchase-grid.md` §9.9。
 */
export interface ShopGate {
  pending: ShopGateRow[];
  /** 覆盖的订单行数合计 */
  orders: number;
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

/** 店铺商品快照行（pl_shop_items；采集而来 = 平台事实，与「这是什么款」的人的决定解耦） */
export interface ShopItemRow {
  id: number;
  /** 所属店铺 sk_shops(id)；0 = 未登记（store_key 为展示名） */
  shopId: number;
  /** 店铺平台（来自 sk_shops；'' = 未登记 —— 没有平台就不能写映射，与待关联队列同一纪律） */
  platform: string;
  /** 店铺名（来自 sk_shops；'' = 未登记，界面回落 storeKey） */
  shopName: string;
  /** 未登记时的展示归一名（店名 → 归一 URL → storeId）；登记后恒 '' */
  storeKey: string;
  /** 平台商品ID（toSkuKey 归一：剥不可见字符 + 折叠空白；与订单侧认款同口径） */
  itemId: string;
  title: string;
  imageUrl: string;
  /** 已下载到图片库的 image_id；0 = 未下载 */
  imageId: number;
  priceText: string;
  category: string;
  status: string;
  url: string;
  /** SKU 矩阵 JSON（详情页重采时才有；列表轻采为空） */
  skuJson: string;
  source: string;
  /** 最近一次采集时间（ms epoch） */
  scrapedAt: number;
  /** 已认到哪个产品（pl_shop_sku 最新一条 confirmed；0 = 没认过） */
  mappedProductId: number;
  /** 已认产品的款编码（展示用；产品已删时为 ''） */
  mappedProductCode: string;
  createdAt: string;
  updatedAt: string;
}

/** 每家店（含未登记）的采集汇总行 */
export interface ShopItemSummaryRow {
  shopId: number;
  storeKey: string;
  /** 采集数 */
  total: number;
  /** 已认款数（存在 confirmed 映射行） */
  confirmed: number;
  /** 最近采集时间（ms epoch；0 = 从未采集） */
  lastScrapedAt: number;
}

/** 采集图下载入库的结果（shop-item-image-fetch；主进程结构化回执，失败不进异常） */
export interface ShopItemImageFetchResult {
  /** 主图：入库后的 pl_images id（0 = 没下载成） */
  imageId: number;
  localPath: string;
  /** true = 这一行此前已入库，本次复用（没重新下载） */
  reused: boolean;
  /** true = 顺手采纳成了款主图（只补空：款已有主图时为 false） */
  adopted: boolean;
  /** 主图失败的原文（'' = 成功/跳过）—— 渲染层照写回执，不当成异常 */
  mainError: string;
  /** 每色图的采纳结果（bound=false 时 reason 说清为什么：图已绑 / 色已有图 / 下载失败） */
  colors: { color: string; imageId: number; bound: boolean; reason: string }[];
}

// ---------------------------------------------------------------------------
// 集中邮件收件箱（IMAP 只读；挂在「店铺账号管家」内）
// ---------------------------------------------------------------------------

/** 邮件账号状态：空闲 / 同步中 / 出错 / 已暂停 */
export type MailAccountStatus = 'idle' | 'syncing' | 'error' | 'paused';

/** 邮件账号（连接配置 + 同步状态；**不含任何凭据**——授权码只进不出） */
export interface MailAccountItem {
  id: number;
  /** 挂载的店铺行（合并后邮箱账号就在店铺行上；ON DELETE CASCADE） */
  shopId: number;
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
  shopId: number;
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

/** 店铺账号汇总（总量 / 按状态 / 三种完整度），供统计条使用 */
export interface ShopAccountSummary {
  total: number;
  byStatus: Partial<Record<ShopAccountStatus, number>>;
  /** 店名 + 邮箱都有 */
  complete: number;
  /** 只有店名（账号待补） */
  shopOnly: number;
  /** 只有邮箱（店铺待建） */
  accountOnly: number;
}

/**
 * 单字段批量修改指令
 * - 状态（status）：仅覆盖语义；未传 = 不改
 * - 引用关系（companyId / ziniaoAccountId / erpAccountId）：仅覆盖语义（0 = 取消关联）
 * - 字符串字段（tags / note）：mode=set 覆盖、append 追加（去重 / 拼接）
 * - 未出现在 patch 中的字段一律不动
 *
 * 不在批量操作范围内的字段：
 * - email（业务主标识，批量改成同一值会直接撞唯一约束）
 * - 店名 / 平台 / 平台店铺ID（身份字段，批量覆盖会把不同店改成同一个）
 * - secrets（shopPwd / emailPwd / alipayPwd）——一次性覆写 N 套凭证
 *   无法逐条确认、不可回滚，风险不可控（见 AGENTS.md 红线 3）
 */
export interface ShopAccountBatchFieldPatch {
  status?: ShopAccountStatus;
  /** 0 = 取消关联；> 0 = 覆盖为该企业 */
  companyId?: number;
  /** 0 = 取消关联；> 0 = 覆盖为该工具账号 */
  ziniaoAccountId?: number;
  erpAccountId?: number;
  tags?: { mode: 'set' | 'append'; value: string };
  note?: { mode: 'set' | 'append'; value: string };
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
  /** 恒 `'detail'`（包价单 2026-10-20 删除；老库若有 package 行也按明细读） */
  mode: 'detail';
  status: 'draft' | 'submitted';
  totalCents: number;
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

/** 待拿货缺口（实时差量 = max(0, 需求 − 已拿)；粒度 = 款色码，未归类单列一组） */
export interface OutstandingRow {
  styleCode: string;
  styleName: string;
  /** 身份键（0 = 未归类）：已拿按它匹配，色名改名不会再失联 */
  styleColorId: number;
  color: string;
  size: string;
  /** 需求件数（SUM(qty)，不是行数） */
  demand: number;
  taken: number;
  missing: number;
  /** 没有款色归属（id=0）—— 界面必须标出来并给修复入口，不许静默排除 */
  unclassified: boolean;
  /** 未归类组的平台商品ID（聚合修复入口用） */
  itemIds: string[];
  /** 未归类组的订单原文色名（平台写法） */
  colorRaw: string;
  /** 需求行数 */
  orders: number;
}

/**
 * **已拿台账**（一行 = 一个款色码：所有已提交拿货单的 qty 合计）。
 *
 * ⚠️ 与 `OutstandingRow` 的分工：它是**台账**（拿过多少，拿齐了照样在），
 *    而 `outstanding()` 是**缺口**（缺为 0 的行不返回）。清单算"还差多少"只能读这一份 ——
 *    读缺口那份，拿齐的款色会被当成"已拿 0" ⇒ 卡永远停在待拿（2026-10-17 用户实报）。
 */
export interface TakenRow {
  /** 款色 id（身份键）。0 = 老明细（按文本三元组兜底匹配） */
  styleColorId: number;
  styleCode: string;
  color: string;
  size: string;
  taken: number;
}

/**
 * 一行订单明细的覆盖情况（`purchase-order-coverage` 的 `rows` 元素，2026-10-22）。
 *
 * `qty` 是明细真值（`null` = 不知道，由渲染层从报表回落）；`covered` 只统计**已提交**拿货单。
 */
export interface OrderCoverageRow {
  /** `oi_order_items.id`（与 `purchase_sources.order_item_id` 同一空间） */
  orderItemId: number;
  orderNo: string;
  shop: string;
  orderTime: string;
  styleCode: string;
  styleName: string;
  styleColorId: number;
  styleColor: string;
  colorRaw: string;
  size: string;
  qty: number | null;
  rawFields: Record<string, string>;
  /**
   * 这一行的色图（本地路径；'' = 没图）。取图优先级与拣货投影同一条：
   * 款色代表图（`oi_style_colors.image_id`）→ 本行订单图（`oi_order_items.image_id`）。
   * 按单核对要能"看图核对"，所以这个字段必须在。
   */
  imagePath: string;
  covered: number;
  unclassified: boolean;
}

export interface OrderCoveragePayload {
  rows: OrderCoverageRow[];
  /** 无归属的已拿台账（按款色码当池子用，与 `covered` 互斥、相加不重复） */
  unattributed: TakenRow[];
}

/** 无需补货标记 */
export interface IgnoreRow {
  styleCode: string;
  color: string;
  reason: string;
  createdAt: string;
}

// ---- 速卖通订单采集（ae-profit / M0）----
//
// ⚠️ 2026-10-15：`AeOrderLineItem` / `AeFeeCategory` / `AeFeeItem` / `AeOrderListItem` /
//   `AeFeeSummary` / `AeCurrencyGroup` / `AeSummary` 随「订单明细」页并入宿主「算钱」后已无消费者，
//   连同死表 `ae_orders`/`ae_order_lines`/`ae_fees` 一并删除。

/** 接收端运行状态（ae-receiver.ts） */
export interface AeReceiverStatus {
  running: boolean;
  port: number;
  startedAt: string;
  /** 最近一次订单采集（/ae/ingest）时间 */
  lastIngestAt: string;
  /** 最近一次商品采集（/ae/shop-items/ingest）时间；'' = 从未采集 */
  lastItemsIngestAt: string;
  lastError: string;
  /** 最近一批订单里**因缺汇率**算不出金额的单数（0 = 全部算出钱了）。缺汇率不算失败，但要能说出口 */
  lastRateMissing: number;
}

/**
 * 「采集已入库」事件（主进程 → 渲染层单向广播）。
 * 扩展推的商品帧在接收端落库成功后发出 —— 已打开的页面据此重拉（不必用户手动刷新）。
 */
export interface AeItemsIngestedEvent {
  /** 帧里收到的条数（= 消毒通过 + 被丢弃） */
  received: number;
  inserted: number;
  updated: number;
  /** 丢弃条数（含帧内消毒失败与 upsert 内跳过） */
  skipped: number;
  /** 广播时刻（ISO 8601） */
  at: string;
}

// ---- 速卖通成本快照 / 汇率（与 electron/ae-db.ts 同构）----

/** 拿货成本快照项（purchase-cost-snapshot 只读导出；P4a 起按 (款, 拿货日期) 分组，一款可多项） */
export interface PurchaseCostSnapshotItem {
  styleCode: string;
  styleName: string;
  sampleCount: number;
  /** 加权均价（分） */
  weightedPriceCents: number;
  /**
   * 本项的拿货日期（yyyy-mm-dd）。
   * P4a 起语义为「**本项**的拿货日期」（一款可多项，一项 = 一个成本区间）。
   */
  lastBizDate: string;
}

// ⚠️ 2026-10-21（C2）：`AeCostMapImportItem` / `AeCostMapItem` / `ManualCostItemInput`
//    随 ae_cost_map 退役删除 —— 成本维护走 `product-cost-set`，不再有区间价目表。

/** 汇率行（1 fromCurrency = rateToCny CNY） */
export interface AeRateItem {
  fromCurrency: string;
  rateToCny: number;
  updatedAt: string;
}

// ⚠️ 2026-10-15：`AeProfitTotals` / `AeTrendPoint` / `AeTopOrder` / `AeTopStyle` /
//   `AeFeeBreakdownItem` / `AeProfitOverview` 随利润引擎 `electron/ae-engine.ts` 一并删除
//   （宿主「算钱」页的利润口径改由渲染层 `src/lib/orderCost.ts` 组合计算）。

/**
 * 「全库重放已确认映射」的统计（主进程 `order-db.replaySkuMappings` 的返回）。
 *
 * 四个数各司其职，**都不参与相加**：
 * - `mappedItems` 输入面（有确认映射的商品数）；
 * - `candidateRows` 待补的存量行（没归款 / 挂在占位色上）；
 * - `fixableRows` 其中映射能覆盖的行；
 * - `fixedRows` 真正写进库的行（`dryRun` 恒 0 —— 报数不该改库）。
 */
export interface SkuMappingReplayStats {
  mappedItems: number;
  candidateRows: number;
  fixableRows: number;
  fixedRows: number;
}

// ---- 记账（店铺收支 + 公共费用分摊 + 资金相关人往来结算）----
//
// 这是一组**新域**的类型，与「统计」（orderCost 的预测毛利）没有任何字段级关系。
// 两边的钱不许相加、不许互相推导 —— 只在汇总页并排对照（见 LEDGER_PLAN.md §1）。

/** 收/支方向。金额恒为正整数分，方向只由这里表达（禁止"负数收入"这种第二种写法） */
export type LedgerKind = 'income' | 'expense';
/** 范围：专属某店 / 公共（需分摊到各店） */
export type LedgerScope = 'shop' | 'shared';
/** 相关人类型（身份用 id，`kind` 只用于分组展示） */
export type LedgerPartyKind = 'supplier' | 'staff' | 'landlord' | 'platform' | 'other';

/** 分摊行（落库形状；`ratioBp` 是权重快照，仅供展示，**不是判据**） */
export interface LedgerAllocationRow {
  shopId: number;
  shopName: string;
  amountCents: number;
  ratioBp: number;
}

/** 写条目时传入的分摊行（渲染层 `computeAllocations` 的产物） */
export interface LedgerAllocationInput {
  shopId: number;
  amountCents: number;
  ratioBp?: number;
}

/** 条目写入入参（局部语义：缺省 = 保持原值） */
export interface LedgerEntryInput {
  id?: number;
  /** YYYY-MM-DD（发生日，不是录入日） */
  bizDate?: string;
  kind?: LedgerKind;
  scope?: LedgerScope;
  shopId?: number;
  /** 资金相关人，**必填**（0 / 空一律拒；数据库还有 CHECK 兜底） */
  partyId?: number;
  categoryId?: number;
  /** 整数分、> 0 */
  amountCents?: number;
  basis?: LedgerBasis;
  ruleId?: number;
  method?: string;
  note?: string;
  /** `scope='shared'` 必填且合计必须等于 `amountCents`；`scope='shop'` 忽略（自动单行全额） */
  allocations?: LedgerAllocationInput[];
}

/** 条目行（列表与详情共用） */
export interface LedgerEntryRow {
  id: number;
  bizDate: string;
  /** `YYYY-MM`，由数据库生成列从 bizDate 派生 */
  period: string;
  kind: LedgerKind;
  scope: LedgerScope;
  shopId: number;
  shopName: string;
  partyId: number;
  partyName: string;
  /** 相关人已停用（历史条目照常显示，但下拉里选不到） */
  partyArchived: boolean;
  categoryId: number;
  categoryName: string;
  amountCents: number;
  basis: LedgerBasis | '';
  /** 套用的分摊方案 id（0 = 未套用）；只作来源留痕，重算不读它 */
  ruleId: number;
  method: string;
  note: string;
  status: 'active' | 'void';
  voidReason: string;
  /** 是否已被**有效**结算单占用（由结算行 JOIN 得出，不在条目上再存一份） */
  settled: boolean;
  settlementId: number;
  /** 分摊行数（公共条目"摊 5 家"用） */
  allocCount: number;
  /**
   * 仅在列表请求带 `includeAllocations` 且 `scope='shared'` 时返回（无店名，供导入查重算指纹）。
   * 与 `LedgerEntryDetail.allocations` 不同：那份一定带 `shopName`，且只有单条详情才给。
   */
  allocations?: Array<{ shopId: number; amountCents: number; ratioBp: number }>;
  createdAt: string;
  updatedAt: string;
}

/** 条目详情（含分摊明细） */
export interface LedgerEntryDetail extends LedgerEntryRow {
  allocations: LedgerAllocationRow[];
}

/** 明细筛选 */
export interface LedgerEntryFilter {
  period?: string;
  from?: string;
  to?: string;
  kind?: LedgerKind;
  scope?: LedgerScope;
  /** 按**分摊行**筛：公共支出摊到该店的部分也算该店支出 */
  shopId?: number;
  partyId?: number;
  categoryId?: number;
  settleStatus?: 'all' | 'settled' | 'unsettled';
  includeVoid?: boolean;
  keyword?: string;
  limit?: number;
  offset?: number;
  /** 给公共条目补分摊行（导入查重算指纹用；常规列表不要开，多一次查询） */
  includeAllocations?: boolean;
}

export interface LedgerCategoryRow {
  id: number;
  kind: LedgerKind;
  name: string;
  builtin: boolean;
  sort: number;
  archived: boolean;
}

export interface LedgerRuleRow {
  id: number;
  name: string;
  basis: LedgerBasis;
  shopIds: number[];
  ratios: number[];
  note: string;
  archived: boolean;
}

export interface LedgerPartyRow {
  id: number;
  name: string;
  kind: LedgerPartyKind;
  phone: string;
  note: string;
  archived: boolean;
  /** 被合并到谁（0 = 没被合并）；`archived && mergedTo > 0` = 「已并入」，否则才是「手动停用」 */
  mergedTo: number;
  createdAt: string;
  updatedAt: string;
  entryCount: number;
}

/**
 * 往来台账一行：五个数必须同时显示。
 * 只给"未结清"一个数的话，用户想知道"这钱是怎么来的"就得自己去翻明细。
 */
export interface LedgerPartyLedgerRow {
  partyId: number;
  partyName: string;
  kind: LedgerPartyKind;
  archived: boolean;
  /** 被合并到谁（0 = 没被合并）：台账据此写「已并入 → B」并给跳转 */
  mergedTo: number;
  /** 应收：我该从对方收 */
  receivableCents: number;
  /** 应付：我该付给对方 */
  payableCents: number;
  /** 净往来 = 应收 − 应付（正 = 对方欠我） */
  netCents: number;
  /** 已结算净额 = Σ我付出 − Σ我收到（对净往来的**调整量**，付出为正） */
  settledNetCents: number;
  /** 未结清 = 净往来 **+** 已结算净额 + 承接余额（加号，不是减号：见 partyLedger.ts 文件头） */
  unsettledCents: number;
  /**
   * 分方向余额：应收方向还能结多少 / 应付方向还能结多少。
   * 两个人（净额）不够用 —— 同一人既欠我钱又该我付时，"该付的那笔"上限是应付余额，不是净额。
   */
  unsettledReceivableCents: number;
  unsettledPayableCents: number;
  /** 承接自他人 / 转给他人的余额（`bk_transfers` 净额） */
  transferCents: number;
  lastSettleDate: string;
}

export interface LedgerSettlementRow {
  id: number;
  partyId: number;
  partyName: string;
  settleDate: string;
  direction: 'pay' | 'receive' | 'offset';
  /** 毛额 = 结算行之和 */
  amountCents: number;
  /** 支出侧毛额（互抵单里我付出的部分；普通 pay 单等于 amountCents） */
  payCents: number;
  /** 收入侧毛额（互抵单里我收到的部分；普通 receive 单等于 amountCents） */
  receiveCents: number;
  /** 实际资金流 = payCents − receiveCents：正 = 我净付出，负 = 我净收到，0 = 完全对冲 */
  cashCents: number;
  method: string;
  note: string;
  status: 'active' | 'void';
  voidReason: string;
  entryCount: number;
}

/** 期间内可参与分摊的店铺；**被排除的必须显式列出来**（否则用户以为漏了） */
export interface LedgerEligibleShops {
  eligible: Array<{ id: number; name: string }>;
  excluded: Array<{
    id: number;
    name: string;
    reason: 'not-open-yet' | 'inactive';
    status: string;
  }>;
}

/** 汇总（店铺轴 / 科目轴 + 体检） */
export interface LedgerSummary {
  period: string;
  incomeCents: number;
  expenseCents: number;
  balanceCents: number;
  entryCount: number;
  /** 公共条目条数（汇总页「公共池」显示用） */
  sharedEntryCount: number;
  /**
   * 公共条目金额，**按方向分开**。
   * 以前只有一个 `sharedCents`（收入+支出混加），排在"收入/支出/结余"后面时会被读成
   * "支出里的公共部分"，一笔公共收入还会让它反直觉地变大（审查 P2-11）。
   */
  sharedIncomeCents: number;
  sharedExpenseCents: number;
  byShop: Array<{
    shopId: number;
    shopName: string;
    shopStatus: string;
    /** 专属收入（条目本身就属于该店） */
    directIncomeCents: number;
    /** 公摊收入（公共条目摊到该店的部分） */
    sharedIncomeCents: number;
    directExpenseCents: number;
    sharedExpenseCents: number;
    /** = 专属 + 公摊（汇总表与单店页共用同四个分项相加，不另取一次求和） */
    incomeCents: number;
    expenseCents: number;
    balanceCents: number;
    sharedEntryCount: number;
  }>;
  byCategory: Array<{
    categoryId: number;
    categoryName: string;
    kind: LedgerKind;
    amountCents: number;
  }>;
  /**
   * 四项体检，正常恒为 0 / 空。
   * 非 0 时汇总页必须红字提示并给定位入口 —— 静默吞掉等于让用户拿错数去做决定。
   */
  integrity: {
    /** Σ分摊 − Σ有效条目金额 */
    allocationGapCents: number;
    /** Σ净往来（只算挂到有效相关人的条目）−（总收入 − 总支出）；非 0 = 有条目 party_id 悬空 */
    partyGapCents: number;
    /** (总收入 − 总支出) − Σ各店结余；非 0 = 公共池漏摊（方案 §7.2） */
    publicPoolCents: number;
    brokenEntries: Array<{ entryId: number; amountCents: number; allocatedCents: number }>;
    /** 条目挂在不存在的相关人上（体检③ 非 0 时的定位入口） */
    missingPartyEntries: Array<{ entryId: number; amountCents: number }>;
  };
}

// ---- 记账 P4：批量变更相关人 / 单店 / 导出 ----

/**
 * 三路（方案 §6.4）：
 * - `move-all`        改挂（全部未结算才允许）
 * - `move-unsettled`  只改挂未结算，已结算留原人（默认推荐，**不写结转**）
 * - `void-then-move`  先作废涉及的结算单（必填原因），再改挂全部
 */
export type LedgerRepatchMode = 'move-all' | 'move-unsettled' | 'void-then-move';

export interface LedgerRepatchEntry {
  id: number;
  bizDate: string;
  kind: LedgerKind;
  amountCents: number;
  partyId: number;
  partyName: string;
  status: 'active';
  /** 0 = 未结算 */
  settlementId: number;
}

export interface LedgerRepatchPartyImpact {
  partyId: number;
  partyName: string;
  unsettledCents: number;
  selectedCount: number;
  selectedCents: number;
  selectedSettledCount: number;
  selectedSettledCents: number;
  /** A/B 路（只移走所选未结算条目）后的未结清 */
  afterMoveCents: number;
  /** C 路（作废结算并移走所选全部条目）后的未结清 */
  afterVoidMoveCents: number;
}

export interface LedgerRepatchSettlement {
  id: number;
  partyId: number;
  partyName: string;
  settleDate: string;
  direction: 'pay' | 'receive';
  amountCents: number;
  /** 该结算单当前有效结算行总数 */
  entryCount: number;
  /** 本批次选中了几条（差额 = C 路作废时被连带恢复未结算的条目） */
  selectedCount: number;
}

export interface LedgerRepatchPreview {
  entries: LedgerRepatchEntry[];
  missingIds: number[];
  voidIds: number[];
  fromParties: LedgerRepatchPartyImpact[];
  settlements: LedgerRepatchSettlement[];
  unsettledCount: number;
  unsettledCents: number;
  settledCount: number;
  settledCents: number;
  /** C 路会连带把未选中的条目恢复未结算的条数（必须让用户看见） */
  collateralEntryCount: number;
  recommended: LedgerRepatchMode;
}

export interface LedgerRepatchResult {
  mode: LedgerRepatchMode;
  toPartyId: number;
  toPartyName: string;
  movedCount: number;
  movedCents: number;
  keptSettledCount: number;
  keptSettledCents: number;
  voidedSettlements: Array<{
    id: number;
    settleDate: string;
    direction: 'pay' | 'receive';
    amountCents: number;
    entryCount: number;
  }>;
  fromParties: Array<{
    partyId: number;
    partyName: string;
    movedCount: number;
    movedCents: number;
    remainingUnsettledCents: number;
  }>;
}

export interface LedgerShopBreakdownCategoryRow {
  categoryId: number;
  categoryName: string;
  kind: LedgerKind;
  directCents: number;
  sharedCents: number;
  amountCents: number;
}

export interface LedgerShopBreakdownSharedRow {
  entryId: number;
  bizDate: string;
  kind: LedgerKind;
  entryCents: number;
  amountCents: number;
  ratioBp: number;
  categoryName: string;
  partyName: string;
  note: string;
}

/** 单店取数（方案 §7.1；结算进度不影响这里任何一个数） */
export interface LedgerShopBreakdown {
  shopId: number;
  shopName: string;
  shopStatus: string;
  period: string;
  incomeCents: number;
  expenseCents: number;
  balanceCents: number;
  directIncomeCents: number;
  sharedIncomeCents: number;
  directExpenseCents: number;
  sharedExpenseCents: number;
  byCategory: LedgerShopBreakdownCategoryRow[];
  sharedEntries: LedgerShopBreakdownSharedRow[];
}

/** 导出一行（展示文案由渲染层本地化，主进程不复算任何业务口径） */
export interface LedgerExportRow {
  bizDate: string;
  kindLabel: string;
  scopeLabel: string;
  shopLabel: string;
  partyName: string;
  categoryName: string;
  amountCents: number;
  settleLabel: string;
  note: string;
}

export interface LedgerExportInput {
  title: string;
  periodLabel: string;
  filterLabel: string;
  rows: LedgerExportRow[];
  /** 与屏幕底部合计同源（主进程不复算） */
  totalIncomeCents: number;
  totalExpenseCents: number;
  balanceCents: number;
  defaultName: string;
}

/**
 * 文件里的一个名字在库里的下落（`ledger-name-resolve` 的产物）。
 *
 * 归一（`toNameKey`）与"同名算不算同一家"的判定**只在主进程**：渲染层再算一遍就是两份口径。
 * 措辞（"不存在 / 已停用 / 对应多家店"）由 `src/lib/ledgerImport.ts` 负责，本结构只给事实。
 */
export interface LedgerNameHit {
  id: number;
  /** 库里登记的名字（可能与文件里的写法差一个空格） */
  name: string;
  state: 'ok' | 'archived' | 'missing' | 'ambiguous';
  /** 只有科目带：收入还是支出（科目名同时存在于两套科目时判 `ambiguous`，不猜方向） */
  kind: LedgerKind | '';
  /**
   * 只有店铺带原始状态（`active` / `exited` / `archived` / `banned`）。
   * `exited`（退店）**算 `ok`**：退店仍参与分摊，让人按状态写字，别按 state 猜。
   */
  status?: string;
}

export interface LedgerNameResolveResult {
  /** 键 = 调用方给的**原文**（预览要按用户文件里的写法回显） */
  party: Record<string, LedgerNameHit>;
  category: Record<string, LedgerNameHit>;
  shop: Record<string, LedgerNameHit>;
}

/**
 * 批量导入一行落库入参：`partyId` / `categoryId` 为 0 时带上名字，
 * 主进程按名字解析，库里没有就**在同一个事务里新建**（导入自动建人/科目）。
 *
 * 与 `LedgerEntryInput` 分开是为了让「记一笔」那条路**拿不到**这两个字段 ——
 * 那条路径上名字找不到就是打错了字，必须报错让人改。
 */
export interface LedgerImportEntryInput extends LedgerEntryInput {
  partyName?: string;
  categoryName?: string;
  /**
   * 这一笔在**用户 Excel 表里的行号**（1-based，含表头）。
   * 主进程报错文案说「第 N 行：…」时用的就是它 —— 勾选子集后"这批的第几条"和
   * 用户看到的行号已经不是一回事，用下标报错等于把人指到别人的行上。
   */
  rowNo?: number;
}

/** 导入模板的一张表：内容全由 `src/lib/ledgerImport.ts` 生成（与解析器共用同一份列定义） */
export interface LedgerTemplateSheetInput {
  name: string;
  rows: string[][];
  widths: number[];
}

declare global {
  interface Window {
    electronAPI: ElectronAPI;
  }
}
