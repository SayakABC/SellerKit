import { contextBridge, ipcRenderer } from 'electron';

// 网络请求载荷消毒：只透传结构白名单内的字段，防止把渲染层任意对象交给主进程
const isPlainObject = (v: unknown): v is Record<string, unknown> =>
  !!v && typeof v === 'object' && !Array.isArray(v);

/** 拿货明细行消毒：尺码透传，长度/数值约束 */
const sanitizePurchaseItems = (items: any) => {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it: any) => typeof it?.styleCode === 'string' && it.styleCode.trim())
    .map((it: any) => ({
      styleCode: it.styleCode.slice(0, 50),
      styleName: typeof it?.styleName === 'string' ? it.styleName.slice(0, 100) : '',
      color: typeof it?.color === 'string' ? it.color.slice(0, 50) : '',
      size: typeof it?.size === 'string' ? it.size.slice(0, 50) : '',
      qty: typeof it?.qty === 'number' ? Math.max(0, Math.round(it.qty)) : 0,
      priceCents: typeof it?.priceCents === 'number' ? Math.max(0, Math.round(it.priceCents)) : 0,
      suggestionQty: typeof it?.suggestionQty === 'number' ? Math.max(0, Math.round(it.suggestionQty)) : 0,
    }))
    .slice(0, 500);
};

/** 待识别队列入队行消毒：每行仅透传字符串原始字段（数量/长度受控），防任意对象注入主进程 */
const sanitizeQueueRows = (
  rows: any,
): Array<{ rawFields: Record<string, string>; url: string; orderNo: string; info: string }> => {
  if (!Array.isArray(rows)) return [];
  const out: Array<{ rawFields: Record<string, string>; url: string; orderNo: string; info: string }> = [];
  for (const r of rows.slice(0, 50000)) {
    if (!isPlainObject(r)) continue;
    const rawFields: Record<string, string> = {};
    if (isPlainObject(r.rawFields)) {
      let fieldCount = 0;
      for (const [k, v] of Object.entries(r.rawFields)) {
        if (typeof k !== 'string' || k.length > 128 || fieldCount >= 300) continue;
        fieldCount += 1;
        rawFields[k] = String(v ?? '').slice(0, 8000);
      }
    }
    out.push({
      rawFields,
      url: typeof r?.url === 'string' ? r.url.slice(0, 8192) : '',
      orderNo: typeof r?.orderNo === 'string' ? r.orderNo.slice(0, 128) : '',
      info: typeof r?.info === 'string' ? r.info.slice(0, 500) : '',
    });
  }
  return out;
};

/** 通用字符串字段消毒（补图回写原始行用） */
const sanitizeFields = (fields: any): Record<string, string> => {
  const out: Record<string, string> = {};
  if (isPlainObject(fields)) {
    let fieldCount = 0;
    for (const [k, v] of Object.entries(fields)) {
      if (typeof k !== 'string' || k.length > 128 || fieldCount >= 300) continue;
      fieldCount += 1;
      out[k] = String(v ?? '').slice(0, 8000);
    }
  }
  return out;
};

const sanitizeNetPayload = (payload: any) => {
  const headers: Record<string, string> = {};
  if (isPlainObject(payload?.headers)) {
    for (const [k, v] of Object.entries(payload.headers)) {
      if (typeof v === 'string' || typeof v === 'number') headers[k] = String(v);
    }
  }
  // 超时白名单：仅接受有限正整数（≤120s），非法则省略走主进程默认
  const rawTimeout = payload?.timeout;
  const timeout =
    typeof rawTimeout === 'number' && Number.isFinite(rawTimeout) && rawTimeout > 0
      ? Math.min(Math.floor(rawTimeout), 120000)
      : undefined;
  return {
    url: typeof payload?.url === 'string' ? payload.url : '',
    method: typeof payload?.method === 'string' ? payload.method.toUpperCase() : 'GET',
    headers,
    body: typeof payload?.body === 'string' ? payload.body : undefined,
    timeout,
  };
};

contextBridge.exposeInMainWorld('electronAPI', {
  selectExcel: () => ipcRenderer.invoke('select-excel'),
  importExcelByPath: (filePath: string) => ipcRenderer.invoke('read-file', filePath),
  selectTemplate: () => ipcRenderer.invoke('select-template'),
  saveTemplate: (filePath: string, content: string) =>
    ipcRenderer.invoke('save-template', filePath, content),
  writeClipboard: (text: string) => ipcRenderer.invoke('write-clipboard', text),
  loadState: () => ipcRenderer.invoke('get-store'),
  saveState: (data: Record<string, any>) => ipcRenderer.invoke('set-store', data),
  // 模块命名空间持久化（Phase 1）
  getModuleState: (moduleId: string) => ipcRenderer.invoke('get-module-state', moduleId),
  setModuleState: (moduleId: string, data: any) =>
    ipcRenderer.invoke('set-module-state', moduleId, data),
  checkFileExists: (filePath: string) => ipcRenderer.invoke('check-file-exists', filePath),
  readFile: (filePath: string) => ipcRenderer.invoke('read-file', filePath),
  getDefaultTemplatePath: () => ipcRenderer.invoke('get-default-template-path'),
  getAppVersion: () => ipcRenderer.invoke('get-app-version'),
  resetStore: () => ipcRenderer.invoke('reset-store'),
  // 数据备份/恢复（换机迁移）：选目录 / 导出 / 导入 / 打开数据目录
  selectDirectory: () => ipcRenderer.invoke('select-directory'),
  backupExport: (targetDir: string) =>
    ipcRenderer.invoke('backup-export', { targetDir: String(targetDir ?? '').slice(0, 4096) }),
  backupImport: (backupDir: string) =>
    ipcRenderer.invoke('backup-import', { backupDir: String(backupDir ?? '').slice(0, 4096) }),
  openDataDir: () => ipcRenderer.invoke('open-data-dir'),
  // 自定义标题栏（Phase 外观）：平台标识 + 窗口控制
  platform: process.platform,
  controlWindow: (action: 'minimize' | 'maximize' | 'close') =>
    ipcRenderer.invoke('win-control', action),
  // 网络请求：载荷消毒后转发主进程（Electron net 发起，规避 CORS）
  netRequest: (payload: any) => ipcRenderer.invoke('net-request', sanitizeNetPayload(payload)),
  // --- 订单归类模块（SQLite 指纹库 / 订单 / 主图）---
  orderDbEnsure: () => ipcRenderer.invoke('order-db-ensure'),
  orderImageFind: (fingerprint: string) =>
    ipcRenderer.invoke('order-image-find', { fingerprint: String(fingerprint ?? '') }),
  orderImageSave: (payload: any) =>
    ipcRenderer.invoke('order-image-save', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
      status: payload?.status === 'done' || payload?.status === 'error' ? payload.status : 'error',
      resultJson: typeof payload?.resultJson === 'string' ? payload.resultJson : undefined,
      error: typeof payload?.error === 'string' ? payload.error : undefined,
    }),
  orderInsert: (payload: any) =>
    ipcRenderer.invoke('order-insert', {
      imageId: typeof payload?.imageId === 'number' ? payload.imageId : 0,
      orderNo: typeof payload?.orderNo === 'string' ? payload.orderNo : '',
      shop: typeof payload?.shop === 'string' ? payload.shop : '',
      size: typeof payload?.size === 'string' ? payload.size : '',
      orderTime: typeof payload?.orderTime === 'string' ? payload.orderTime : '',
      rawFields: isPlainObject(payload?.rawFields) ? payload.rawFields : {},
      category: typeof payload?.category === 'string' ? payload.category : '',
      color: typeof payload?.color === 'string' ? payload.color : '',
      logo: typeof payload?.logo === 'string' ? payload.logo : '',
    }),
  orderGroupStats: (dimensions: string[]) =>
    ipcRenderer.invoke('order-group-stats', { dimensions: Array.isArray(dimensions) ? dimensions : [] }),
  orderList: (payload: any) =>
    ipcRenderer.invoke('order-list', {
      offset: typeof payload?.offset === 'number' ? Math.max(Math.round(payload.offset), 0) : 0,
      limit: typeof payload?.limit === 'number' ? Math.min(Math.max(Math.round(payload.limit), 1), 2000) : 500,
      corrected: payload?.corrected === true || payload?.corrected === false ? !!payload.corrected : undefined,
      search: typeof payload?.search === 'string' ? payload.search.slice(0, 100) : undefined,
    }),
  orderClear: () => ipcRenderer.invoke('order-clear'),
  orderDownloadImage: (url: string) =>
    ipcRenderer.invoke('order-download-image', { url: String(url ?? '') }),
  orderReadImage: (localPath: string) =>
    ipcRenderer.invoke('order-read-image', { localPath: String(localPath ?? '') }),
  // 缩略图（主进程等比缩放 + LRU）：payload { localPath, maxEdge? } → { dataUrl }
  orderImageThumb: (payload: any) =>
    ipcRenderer.invoke('order-image-thumb', {
      localPath: String(payload?.localPath ?? ''),
      maxEdge: typeof payload?.maxEdge === 'number' ? Math.min(Math.max(Math.round(payload.maxEdge), 16), 256) : 160,
    }),
  // 批量缩略图（渲染层同帧多图合批一次往返）：payload { items: [{ localPath, maxEdge }] } → { dataUrls: (string|null)[] }
  orderImageThumbBatch: (payload: any) =>
    ipcRenderer.invoke('order-image-thumb-batch', {
      items: Array.isArray(payload?.items)
        ? payload.items
            .slice(0, 40)
            .map((it: any) => ({
              localPath: String(it?.localPath ?? '').slice(0, 4096),
              maxEdge: typeof it?.maxEdge === 'number' ? Math.min(Math.max(Math.round(it.maxEdge), 16), 256) : 160,
            }))
        : [],
    }),
  // 识别引擎 API Key：主进程 safeStorage 加密落盘（渲染层不落明文存储）
  orderApiKeySet: (apiKey: string) =>
    ipcRenderer.invoke('order-api-key-set', { apiKey: String(apiKey ?? '').slice(0, 1024) }),
  orderApiKeyGet: () => ipcRenderer.invoke('order-api-key-get'),
  // 清理不被数据库引用的孤儿图片文件（重置/批次覆盖后残留）
  orderCleanupOrphanImages: () => ipcRenderer.invoke('order-cleanup-orphan-images'),
  // 产品库导入「图片」列：读取用户指定的本地图片（任意路径，仅图片扩展名，≤10MB）
  orderReadLocalImage: (localPath: string) =>
    ipcRenderer.invoke('order-read-local-image', { localPath: String(localPath ?? '').slice(0, 4096) }),
  orderExportExcel: (buffer: ArrayBuffer, defaultName?: string) =>
    ipcRenderer.invoke('order-export-excel', { buffer, defaultName }),
  // 待识别队列（订单归类：导入行整批落库，失败/缺图重启不丢、可增量重试）
  orderQueueEnqueue: (payload: any) =>
    ipcRenderer.invoke('order-queue-enqueue', {
      batchNo: typeof payload?.batchNo === 'string' ? payload.batchNo.slice(0, 64) : '',
      rows: sanitizeQueueRows(payload?.rows),
    }),
  orderQueueStats: (payload: any) =>
    ipcRenderer.invoke('order-queue-stats', { batchNo: String(payload?.batchNo ?? '') }),
  orderQueueList: (payload: any) =>
    ipcRenderer.invoke('order-queue-list', {
      batchNo: String(payload?.batchNo ?? ''),
      offset: typeof payload?.offset === 'number' ? Math.max(Math.round(payload.offset), 0) : 0,
      limit: typeof payload?.limit === 'number' ? Math.min(Math.max(Math.round(payload.limit), 0), 2000) : 0,
      status:
        typeof payload?.status === 'string' && ['pending', 'error', 'missing', 'done', 'all'].includes(payload.status)
          ? payload.status
          : undefined,
      missingOnly: payload?.missingOnly === true,
    }),
  orderQueueGet: (id: any) =>
    ipcRenderer.invoke('order-queue-get', { id: typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : 0 }),
  orderQueueNextPending: (payload: any) =>
    ipcRenderer.invoke('order-queue-next-pending', {
      batchNo: String(payload?.batchNo ?? ''),
      afterId: typeof payload?.afterId === 'number' ? Math.max(0, Math.floor(payload.afterId)) : 0,
      limit:
        typeof payload?.limit === 'number'
          ? Math.min(200, Math.max(1, Math.floor(payload.limit)))
          : 50,
    }),
  orderQueueSetResult: (payload: any) =>
    ipcRenderer.invoke('order-queue-set-result', {
      id: typeof payload?.id === 'number' ? Math.floor(payload.id) : 0,
      status: ['done', 'error', 'missing'].includes(payload?.status) ? payload.status : 'error',
      error: typeof payload?.error === 'string' ? payload.error.slice(0, 2000) : '',
    }),
  orderQueuePatch: (payload: any) =>
    ipcRenderer.invoke('order-queue-patch', {
      id: typeof payload?.id === 'number' ? Math.floor(payload.id) : 0,
      url: String(payload?.url ?? '').slice(0, 8192),
      rawFields: sanitizeFields(payload?.rawFields),
    }),
  orderQueueRetryErrors: (payload: any) =>
    ipcRenderer.invoke('order-queue-retry-errors', { batchNo: String(payload?.batchNo ?? '') }),
  orderQueuePurgeDone: (payload: any) =>
    ipcRenderer.invoke('order-queue-purge-done', { batchNo: String(payload?.batchNo ?? '') }),
  orderQueueLastActive: () => ipcRenderer.invoke('order-queue-last-active'),
  // 款编码/款色（产品库主数据）
  orderStyleResolve: (payload: any) =>
    ipcRenderer.invoke('order-style-resolve', {
      imageId: typeof payload?.imageId === 'number' ? payload.imageId : 0,
      fingerprint: typeof payload?.fingerprint === 'string' ? payload.fingerprint : '',
      category: typeof payload?.category === 'string' ? payload.category : '',
      features: Array.isArray(payload?.features)
        ? payload.features.filter((f: unknown) => typeof f === 'string').slice(0, 20)
        : [],
      color: typeof payload?.color === 'string' ? payload.color : '',
      styleName: typeof payload?.styleName === 'string' ? payload.styleName.slice(0, 50) : '',
    }),
  orderStyleList: () => ipcRenderer.invoke('order-style-list'),
  // 删除款式（款编码）：级联删款色、图片解除归属、订单保留
  orderStyleDelete: (payload: any) =>
    ipcRenderer.invoke('order-style-delete', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  // 手动归并款式：订单图片挂到指定款编码 + 记入附加指纹（后续自动识别命中同一款编码）
  orderStyleAssign: (payload: any) =>
    ipcRenderer.invoke('order-style-assign', {
      orderId: typeof payload?.orderId === 'number' ? payload.orderId : 0,
      styleId: typeof payload?.styleId === 'number' ? payload.styleId : 0,
      color: typeof payload?.color === 'string' ? payload.color : '',
      fingerprint: typeof payload?.fingerprint === 'string' ? payload.fingerprint : '',
    }),
  // 修改款式展示名（款编码级）
  orderStyleRename: (payload: any) =>
    ipcRenderer.invoke('order-style-rename', {
      code: typeof payload?.code === 'string' ? payload.code : '',
      name: typeof payload?.name === 'string' ? payload.name : '',
    }),
  // 产品库 Excel 批量导入（指纹由渲染层生成，此处结构白名单消毒）
  orderStyleImport: (payload: any) =>
    ipcRenderer.invoke('order-style-import', {
      styles: Array.isArray(payload?.styles)
        ? payload.styles.map((s: any) => ({
            code: typeof s?.code === 'string' ? s.code : '',
            name: typeof s?.name === 'string' ? s.name : '',
            color: typeof s?.color === 'string' ? s.color : '',
            fingerprint: typeof s?.fingerprint === 'string' ? s.fingerprint : '',
            extraFingerprints: Array.isArray(s?.extraFingerprints)
              ? s.extraFingerprints.filter((f: unknown) => typeof f === 'string')
              : [],
          }))
        : [],
    }),
  // 数据纠正：更新订单字段，可选按新款指纹重新归类
  orderUpdate: (payload: any) =>
    ipcRenderer.invoke('order-update', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
      category: typeof payload?.category === 'string' ? payload.category : '',
      color: typeof payload?.color === 'string' ? payload.color : '',
      logo: typeof payload?.logo === 'string' ? payload.logo : '',
      fingerprint: typeof payload?.fingerprint === 'string' ? payload.fingerprint : '',
      features: Array.isArray(payload?.features)
        ? payload.features.filter((f: unknown) => typeof f === 'string').slice(0, 20)
        : [],
      reclassify: payload?.reclassify === true,
    }),
  // 更新订单发货状态（订单明细行内切换）
  orderUpdateStatus: (payload: any) =>
    ipcRenderer.invoke('order-update-status', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
      status: payload?.status === 'shipped' ? 'shipped' : 'pending',
    }),
  // 删除订单（订单明细行操作）
  orderDelete: (payload: any) =>
    ipcRenderer.invoke('order-delete', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  // 批量标记订单已核对（数据纠正页「确认无误」/「全部确认无误」）
  // ids: number[]（部分确认）；或 { all: true }（全部未核对一次标记，避免大数组过 IPC）
  orderMarkCorrected: (input: any) =>
    ipcRenderer.invoke('order-mark-corrected', {
      all: isPlainObject(input) && input.all === true,
      ids: Array.isArray(input)
        ? input.filter((n: any) => typeof n === 'number' && Number.isInteger(n) && n > 0).slice(0, 10000)
        : [],
    }),
  // --- 拿货对账模块（厂商 / 拿货单 / 付款 / 对账 / 待拿货缺口）---
  purchaseDbEnsure: () => ipcRenderer.invoke('purchase-db-ensure'),
  // 厂商
  purchaseSupplierList: () => ipcRenderer.invoke('purchase-supplier-list'),
  purchaseSupplierCreate: (payload: any) =>
    ipcRenderer.invoke('purchase-supplier-create', {
      name: typeof payload?.name === 'string' ? payload.name.slice(0, 50) : '',
      phone: typeof payload?.phone === 'string' ? payload.phone.slice(0, 30) : '',
      note: typeof payload?.note === 'string' ? payload.note.slice(0, 200) : '',
    }),
  purchaseSupplierUpdate: (payload: any) =>
    ipcRenderer.invoke('purchase-supplier-update', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
      phone: typeof payload?.phone === 'string' ? payload.phone.slice(0, 30) : '',
      note: typeof payload?.note === 'string' ? payload.note.slice(0, 200) : '',
    }),
  purchaseSupplierDelete: (payload: any) =>
    ipcRenderer.invoke('purchase-supplier-delete', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  // 拿货单
  purchaseOrderList: () => ipcRenderer.invoke('purchase-order-list'),
  purchaseOrderGet: (payload: any) =>
    ipcRenderer.invoke('purchase-order-get', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  purchaseOrderCreate: (payload: any) =>
    ipcRenderer.invoke('purchase-order-create', {
      supplierId: typeof payload?.supplierId === 'number' ? payload.supplierId : 0,
      bizDate: typeof payload?.bizDate === 'string' ? payload.bizDate.slice(0, 10) : '',
      mode: payload?.mode === 'package' ? 'package' : 'detail',
      note: typeof payload?.note === 'string' ? payload.note.slice(0, 500) : '',
      totalCents: typeof payload?.totalCents === 'number' ? payload.totalCents : 0,
      items: sanitizePurchaseItems(payload?.items),
      sources: Array.isArray(payload?.sources)
        ? payload.sources
            .filter((s: any) => typeof s?.styleCode === 'string' && s.styleCode.trim())
            .map((s: any) => ({
              shop: typeof s?.shop === 'string' ? s.shop.slice(0, 100) : '',
              styleCode: s.styleCode.slice(0, 50),
              styleName: typeof s?.styleName === 'string' ? s.styleName.slice(0, 100) : '',
              color: typeof s?.color === 'string' ? s.color.slice(0, 50) : '',
              size: typeof s?.size === 'string' ? s.size.slice(0, 50) : '',
              qty: typeof s?.qty === 'number' ? Math.max(1, Math.round(s.qty)) : 1,
            }))
            .slice(0, 100000)
        : undefined,
    }),
  purchaseOrderUpdate: (payload: any) =>
    ipcRenderer.invoke('purchase-order-update', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
      bizDate: typeof payload?.bizDate === 'string' ? payload.bizDate.slice(0, 10) : undefined,
      note: typeof payload?.note === 'string' ? payload.note.slice(0, 500) : undefined,
      totalCents: typeof payload?.totalCents === 'number' ? payload.totalCents : undefined,
      items: Array.isArray(payload?.items) ? sanitizePurchaseItems(payload?.items) : undefined,
    }),
  purchaseOrderSubmit: (payload: any) =>
    ipcRenderer.invoke('purchase-order-submit', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  purchaseOrderDelete: (payload: any) =>
    ipcRenderer.invoke('purchase-order-delete', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  // 付款
  purchasePaymentList: (payload?: any) =>
    ipcRenderer.invoke('purchase-payment-list', {
      supplierId: typeof payload?.supplierId === 'number' ? payload.supplierId : undefined,
      from: typeof payload?.from === 'string' ? payload.from : undefined,
      to: typeof payload?.to === 'string' ? payload.to : undefined,
    }),
  purchasePaymentAdd: (payload: any) =>
    ipcRenderer.invoke('purchase-payment-add', {
      supplierId: typeof payload?.supplierId === 'number' ? payload.supplierId : 0,
      payDate: typeof payload?.payDate === 'string' ? payload.payDate.slice(0, 10) : '',
      type: payload?.type === 'refund' ? 'refund' : 'payment',
      amountCents: typeof payload?.amountCents === 'number' ? Math.max(0, Math.round(payload.amountCents)) : 0,
      method: typeof payload?.method === 'string' ? payload.method.slice(0, 20) : '',
      note: typeof payload?.note === 'string' ? payload.note.slice(0, 200) : '',
    }),
  purchasePaymentDelete: (payload: any) =>
    ipcRenderer.invoke('purchase-payment-delete', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  // 对账 / 待拿货 / 单价记忆
  purchaseReconciliation: (payload?: any) =>
    ipcRenderer.invoke('purchase-reconciliation', {
      from: typeof payload?.from === 'string' ? payload.from : undefined,
      to: typeof payload?.to === 'string' ? payload.to : undefined,
    }),
  purchaseOutstanding: () => ipcRenderer.invoke('purchase-outstanding'),
  purchaseIgnoreAdd: (payload: any) =>
    ipcRenderer.invoke('purchase-ignore-add', {
      styleCode: typeof payload?.styleCode === 'string' ? payload.styleCode.slice(0, 50) : '',
      color: typeof payload?.color === 'string' ? payload.color.slice(0, 50) : '',
      reason: typeof payload?.reason === 'string' ? payload.reason.slice(0, 100) : '',
    }),
  purchaseIgnoreRemove: (payload: any) =>
    ipcRenderer.invoke('purchase-ignore-remove', {
      styleCode: typeof payload?.styleCode === 'string' ? payload.styleCode.slice(0, 50) : '',
      color: typeof payload?.color === 'string' ? payload.color.slice(0, 50) : '',
    }),
  purchaseIgnoreList: () => ipcRenderer.invoke('purchase-ignore-list'),
  purchasePriceHistory: (payload: any) =>
    ipcRenderer.invoke('purchase-price-history', {
      supplierId: typeof payload?.supplierId === 'number' ? payload.supplierId : 0,
      styleCode: typeof payload?.styleCode === 'string' ? payload.styleCode.slice(0, 50) : '',
      color: typeof payload?.color === 'string' ? payload.color.slice(0, 50) : '',
    }),
  purchaseShopAllocation: (payload?: any) =>
    ipcRenderer.invoke('purchase-shop-allocation', {
      from: typeof payload?.from === 'string' ? payload.from.slice(0, 10) : undefined,
      to: typeof payload?.to === 'string' ? payload.to.slice(0, 10) : undefined,
    }),
  purchaseShopAllocationDetail: (payload: any) =>
    ipcRenderer.invoke('purchase-shop-allocation-detail', {
      shop: typeof payload?.shop === 'string' ? payload.shop.slice(0, 100) : '',
      from: typeof payload?.from === 'string' ? payload.from.slice(0, 10) : undefined,
      to: typeof payload?.to === 'string' ? payload.to.slice(0, 10) : undefined,
    }),
  // 拿货单导出（主进程 exceljs 生成，款编码+款色自动嵌图）
  purchaseExportExcel: (payload: any) =>
    ipcRenderer.invoke('purchase-export-excel', {
      items: sanitizePurchaseItems(payload?.items),
      defaultName: typeof payload?.defaultName === 'string' ? payload.defaultName.slice(0, 120) : '',
    }),
});
