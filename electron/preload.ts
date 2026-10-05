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
      suggestionQty:
        typeof it?.suggestionQty === 'number' ? Math.max(0, Math.round(it.suggestionQty)) : 0,
    }))
    .slice(0, 500);
};

/**
 * 拣货单导出行消毒：只透传**渲染层已经算好**的业务值（件数 / 进价 / 金额 / 缺口文案 / 已编码的图），
 * 主进程不重算任何口径（见 `picking-handlers.ts` 的文件头）。
 *
 * ⚠️ `unitPrice` / `amount` 的 `null` **必须原样保留**：它是"没进价"，折成 0 会让导出的表
 * 把"没查到价"写成"这件免费" —— 对账时是查不出来的错。
 * ⚠️ `image` 的 base64 有长度上限（`BASE64_MAX`）：形状不对就整个丢掉（当"这行没图"），
 * 不做截断 —— 截断出来的 base64 是**坏图**，比没图更难排查。
 */
const BASE64_MAX = 400_000;
const sanitizePickingExportRows = (rows: any) => {
  if (!Array.isArray(rows)) return [];
  const money = (v: any) => (typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null);
  const image = (v: any) => {
    if (!v || typeof v !== 'object') return null;
    const base64 = typeof v.base64 === 'string' ? v.base64 : '';
    if (!base64 || base64.length > BASE64_MAX) return null;
    const w = typeof v.width === 'number' ? Math.round(v.width) : 0;
    const h = typeof v.height === 'number' ? Math.round(v.height) : 0;
    return w > 0 && h > 0 ? { base64, width: w, height: h } : null;
  };
  return rows
    .slice(0, 500)
    .map((r: any) => ({
      supplierName: typeof r?.supplierName === 'string' ? r.supplierName.slice(0, 100) : '',
      styleCode: typeof r?.styleCode === 'string' ? r.styleCode.slice(0, 60) : '',
      color: typeof r?.color === 'string' ? r.color.slice(0, 60) : '',
      size: typeof r?.size === 'string' ? r.size.slice(0, 20) : '',
      pieces: typeof r?.pieces === 'number' ? Math.max(0, Math.round(r.pieces)) : 0,
      orders: typeof r?.orders === 'number' ? Math.max(0, Math.round(r.orders)) : 0,
      unitPrice: money(r?.unitPrice),
      amount: money(r?.amount),
      gaps: typeof r?.gaps === 'string' ? r.gaps.slice(0, 200) : '',
      image: image(r?.image),
    }))
    .filter((r: any) => r.styleCode || r.color || r.size);
};

/** 待识别队列入队行消毒：每行仅透传字符串原始字段（数量/长度受控），防任意对象注入主进程 */
const sanitizeQueueRows = (
  rows: any
): Array<{ rawFields: Record<string, string>; url: string; orderNo: string; info: string }> => {
  if (!Array.isArray(rows)) return [];
  const out: Array<{
    rawFields: Record<string, string>;
    url: string;
    orderNo: string;
    info: string;
  }> = [];
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

/** 店铺套入参消毒：结构白名单 + 长度约束（主进程再做一次业务口径校验） */
const sanitizeShopAccountInput = (payload: any) => {
  const s = (v: any, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  // 敏感字段白名单：店铺密码 / 邮箱密码 / 支付宝支付密码 / 紫鸟密码 / ERP密码 / IMAP 授权码
  const allowedSecretKeys = [
    'shopPwd',
    'emailPwd',
    'alipayPwd',
    'ziniaoPwd',
    'erpPwd',
    'mailAuthPwd',
  ];
  const secrets: Record<string, string> = {};
  if (isPlainObject(payload?.secrets)) {
    for (const [k, v] of Object.entries(payload.secrets)) {
      if (!allowedSecretKeys.includes(k) || typeof v !== 'string') continue;
      secrets[k] = v.slice(0, 500);
    }
  }
  // undefined = 保持原值；数组（含空数组）= 覆盖（空数组即清空关联平台）
  const platforms = Array.isArray(payload?.platforms)
    ? payload.platforms
        .slice(0, 20)
        .map((v: unknown) => s(v, 60))
        .filter((v: string) => !!v)
    : undefined;
  return {
    id:
      typeof payload?.id === 'number' && Number.isInteger(payload.id) && payload.id > 0
        ? payload.id
        : 0,
    email: s(payload?.email, 200),
    phone: s(payload?.phone, 40),
    company: s(payload?.company, 120),
    alipay: s(payload?.alipay, 200),
    ziniaoAccount: s(payload?.ziniaoAccount, 120),
    erpAccount: s(payload?.erpAccount, 120),
    ...(platforms === undefined ? {} : { platforms }),
    // 开店时间：仅字符串才透传（缺省 = 主进程/db 层保持原值），格式由 db 层归一化
    ...(typeof payload?.openedAt === 'string' ? { openedAt: s(payload.openedAt, 10) } : {}),
    // 关联企业 id：仅数字才透传（缺省 = 保持原值；0 = 取消关联），存在性由 db 层校验
    ...(typeof payload?.companyId === 'number' && Number.isFinite(payload.companyId)
      ? { companyId: payload.companyId }
      : {}),
    status: s(payload?.status, 20),
    tags: s(payload?.tags, 200),
    note: s(payload?.note, 2000),
    secrets,
  };
};

/**
 * 批量修改入参消毒：结构白名单（仅非敏感字段）+ 数量/长度约束。
 * - ids：正整数数组，去重，上限 5000（与主进程 handler 口径一致）
 * - patch：status / phone / alipay / ziniaoAccount / erpAccount / companyId / tags / note
 *   / platforms，未声明字段一律剔除
 */
const sanitizeShopAccountBatchInput = (payload: any) => {
  const s = (v: any, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  const ids = Array.isArray(payload?.ids)
    ? Array.from(
        new Set(
          payload.ids.filter(
            (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v > 0
          )
        )
      ).slice(0, 5000)
    : [];
  const patchRaw = isPlainObject(payload?.patch) ? payload.patch : {};
  const patch: Record<string, unknown> = {};
  if (typeof patchRaw.status === 'string') {
    patch.status = s(patchRaw.status, 20);
  }
  // 单值账号字段：仅覆盖（长度与 shop-account-upsert 的 MAX_LEN 口径保持一致）
  if (typeof patchRaw.phone === 'string') {
    patch.phone = s(patchRaw.phone, 40);
  }
  if (typeof patchRaw.alipay === 'string') {
    patch.alipay = s(patchRaw.alipay, 200);
  }
  if (typeof patchRaw.ziniaoAccount === 'string') {
    patch.ziniaoAccount = s(patchRaw.ziniaoAccount, 120);
  }
  if (typeof patchRaw.erpAccount === 'string') {
    patch.erpAccount = s(patchRaw.erpAccount, 120);
  }
  // 关联企业：下拉选择（仅覆盖语义）。0 = 取消关联；> 0 = 该企业 id（非整数/负数一律丢弃）
  if (
    typeof patchRaw.companyId === 'number' &&
    Number.isInteger(patchRaw.companyId) &&
    patchRaw.companyId >= 0
  ) {
    patch.companyId = Math.min(patchRaw.companyId, 2147483647);
  }
  if (
    isPlainObject(patchRaw.tags) &&
    (patchRaw.tags.mode === 'set' || patchRaw.tags.mode === 'append')
  ) {
    patch.tags = { mode: patchRaw.tags.mode, value: s(patchRaw.tags.value, 200) };
  }
  if (
    isPlainObject(patchRaw.note) &&
    (patchRaw.note.mode === 'set' || patchRaw.note.mode === 'append')
  ) {
    patch.note = { mode: patchRaw.note.mode, value: s(patchRaw.note.value, 2000) };
  }
  if (
    isPlainObject(patchRaw.platforms) &&
    (patchRaw.platforms.mode === 'set' ||
      patchRaw.platforms.mode === 'append' ||
      patchRaw.platforms.mode === 'remove')
  ) {
    const values = Array.isArray(patchRaw.platforms.values)
      ? patchRaw.platforms.values
          .slice(0, 20)
          .map((v: unknown) => s(v, 60))
          .filter((v: string) => !!v)
      : [];
    patch.platforms = { mode: patchRaw.platforms.mode, values };
  }
  return { ids, patch };
};

/**
 * 企业入参消毒：结构白名单 + 长度约束（主进程再做一次业务口径校验）。
 * 字段缺省（非字符串）= 主进程保持原值；字符串（含空串）= 覆盖/清空。
 */
const sanitizeCompanyInput = (payload: any) => {
  const s = (v: any, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    id:
      typeof payload?.id === 'number' && Number.isInteger(payload.id) && payload.id > 0
        ? payload.id
        : 0,
    name: s(payload?.name, 200),
    unifiedCode: s(payload?.unifiedCode, 60),
    country: s(payload?.country, 40),
    address: s(payload?.address, 300),
    legalPerson: s(payload?.legalPerson, 60),
    contactName: s(payload?.contactName, 60),
    contactPhone: s(payload?.contactPhone, 40),
    contactEmail: s(payload?.contactEmail, 200),
    vatNo: s(payload?.vatNo, 60),
    eoriNo: s(payload?.eoriNo, 60),
    status: s(payload?.status, 20),
    note: s(payload?.note, 2000),
  };
};

/**
 * 合规资料（欧代/土代/德国包装法）入参消毒：结构白名单 + 长度约束。
 * extra 为类型专属扩展字段（如德国包装法的合同号/申报年度/申报重量），
 * 这里只做浅层键名与值长度约束，语义校验在主进程按 type 处理。
 */
const sanitizeCompanyProfileInput = (payload: any) => {
  const s = (v: any, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  let extra: Record<string, string> | undefined;
  if (isPlainObject(payload?.extra)) {
    const out: Record<string, string> = {};
    let count = 0;
    for (const [k, v] of Object.entries(payload.extra)) {
      if (typeof k !== 'string' || k.length > 64 || count >= 30) continue;
      count += 1;
      out[k] = s(v, 200);
    }
    extra = out;
  }
  return {
    id:
      typeof payload?.id === 'number' && Number.isInteger(payload.id) && payload.id > 0
        ? payload.id
        : 0,
    companyId:
      typeof payload?.companyId === 'number' &&
      Number.isInteger(payload.companyId) &&
      payload.companyId > 0
        ? payload.companyId
        : 0,
    type: s(payload?.type, 20),
    name: s(payload?.name, 200),
    regNo: s(payload?.regNo, 60),
    contactName: s(payload?.contactName, 60),
    contactPhone: s(payload?.contactPhone, 40),
    contactEmail: s(payload?.contactEmail, 200),
    address: s(payload?.address, 300),
    ...(typeof payload?.effectiveAt === 'string'
      ? { effectiveAt: s(payload.effectiveAt, 10) }
      : {}),
    ...(typeof payload?.expireAt === 'string' ? { expireAt: s(payload.expireAt, 10) } : {}),
    status: s(payload?.status, 20),
    note: s(payload?.note, 2000),
    ...(extra === undefined ? {} : { extra }),
  };
};

/** 市场安装条目消毒：结构白名单（主进程还会再净化一次，这里是第一道形状约束） */
const sanitizeMarketItem = (raw: any) => {
  if (!isPlainObject(raw)) return {};
  const s = (v: any, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  return {
    id: s(raw.id, 64),
    name: s(raw.name, 80),
    version: s(raw.version, 32),
    description: s(raw.description, 300),
    author: s(raw.author, 80),
    downloadUrl: /^https?:\/\//i.test(s(raw.downloadUrl, 2048)) ? s(raw.downloadUrl, 2048) : '',
    sha256: /^[0-9a-f]{64}$/i.test(s(raw.sha256, 64)) ? s(raw.sha256, 64) : '',
    homepage: s(raw.homepage, 2048),
  };
};

contextBridge.exposeInMainWorld('electronAPI', {
  selectExcel: () => ipcRenderer.invoke('select-excel'),
  selectImage: () => ipcRenderer.invoke('select-image'),
  importExcelByPath: (filePath: string) => ipcRenderer.invoke('read-file', filePath),
  selectTemplate: () => ipcRenderer.invoke('select-template'),
  saveTemplate: (filePath: string, content: string) =>
    ipcRenderer.invoke('save-template', filePath, content),
  writeClipboard: (text: string) => ipcRenderer.invoke('write-clipboard', text),
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
    ipcRenderer.invoke('order-group-stats', {
      dimensions: Array.isArray(dimensions) ? dimensions : [],
    }),
  orderList: (payload: any) =>
    ipcRenderer.invoke('order-list', {
      offset: typeof payload?.offset === 'number' ? Math.max(Math.round(payload.offset), 0) : 0,
      limit:
        typeof payload?.limit === 'number'
          ? Math.min(Math.max(Math.round(payload.limit), 1), 2000)
          : 500,
      corrected:
        payload?.corrected === true || payload?.corrected === false
          ? !!payload.corrected
          : undefined,
      search: typeof payload?.search === 'string' ? payload.search.slice(0, 100) : undefined,
    }),
  orderClear: () => ipcRenderer.invoke('order-clear'),
  // 运费原始行（oi_orders 最小投影 id/order_no/raw_fields，只读；供按订单算运费的宿主 op 提取）
  orderAssignShop: (payload: any) =>
    ipcRenderer.invoke('order-assign-shop', {
      orderNos: Array.isArray(payload?.orderNos)
        ? payload.orderNos.slice(0, 2000).map((x: any) => (typeof x === 'string' ? x.slice(0, 64) : ''))
        : [],
      shopName: typeof payload?.shopName === 'string' ? payload.shopName.slice(0, 200) : '',
    }),
  orderShippingRows: (payload: any) =>
    ipcRenderer.invoke('order-shipping-rows', {
      limit:
        typeof payload?.limit === 'number'
          ? Math.min(Math.max(Math.round(payload.limit), 1), 2000)
          : 500,
      source: typeof payload?.source === 'string' ? payload.source : 'all',
    }),
  orderDownloadImage: (url: string) =>
    ipcRenderer.invoke('order-download-image', { url: String(url ?? '') }),
  // 拣货投影（只读）：未发货订单行 + 三层回落图 + 款色码/供应商
  pickingRows: (payload: any) =>
    ipcRenderer.invoke('picking-rows', {
      limit:
        typeof payload?.limit === 'number'
          ? Math.min(Math.max(Math.round(payload.limit), 1), 5000)
          : 2000,
      shop: typeof payload?.shop === 'string' ? payload.shop.slice(0, 200) : '',
      includeShipped: payload?.includeShipped === true,
    }),
  // 拣货单导出（主进程 exceljs 生成：带图、按厂家分表）；行已由渲染层算好，主进程只画表
  pickingExportExcel: (payload: any) =>
    ipcRenderer.invoke('picking-export-excel', {
      rows: sanitizePickingExportRows(payload?.rows),
      defaultName:
        typeof payload?.defaultName === 'string' ? payload.defaultName.slice(0, 120) : '',
    }),
  orderReadImage: (localPath: string) =>
    ipcRenderer.invoke('order-read-image', { localPath: String(localPath ?? '') }),
  // 缩略图（主进程等比缩放 + LRU）：payload { localPath, maxEdge? } → { dataUrl }
  orderImageThumb: (payload: any) =>
    ipcRenderer.invoke('order-image-thumb', {
      localPath: String(payload?.localPath ?? ''),
      maxEdge:
        typeof payload?.maxEdge === 'number'
          ? Math.min(Math.max(Math.round(payload.maxEdge), 16), 256)
          : 160,
    }),
  // 批量缩略图（渲染层同帧多图合批一次往返）→ { dataUrls: (string|null)[] }
  // ⚠️ 载荷形状以 `src/types.ts` 的声明为准 = **裸数组**（`orderImageThumbBatch(items)`）。
  //    本函数早先只认 `{ items }`：内置调用点（产品页主图列 / 映射与关联的商品ID图 /
  //    编辑抽屉主图预览 / 拣货单商品图）全部按声明传裸数组 → `payload.items` 恒为 undefined
  //    → 发出去的是 `{ items: [] }` → 主进程返回空数组 → **界面全是空占位且不报错**（静默失败）。
  //    两种形状都收（裸数组优先，`{ items }` 兼容岛侧老调用方），但**声明与实现必须一致**，
  //    回归由 `npm run ipc:shape:smoke` 守着（它拿真 preload + 真主进程 handler 端到端跑）。
  orderImageThumbBatch: (payload: any) => {
    const list = Array.isArray(payload)
      ? payload
      : Array.isArray(payload?.items)
        ? payload.items
        : [];
    return ipcRenderer.invoke('order-image-thumb-batch', {
      items: list.slice(0, 40).map((it: any) => ({
        localPath: String(it?.localPath ?? '').slice(0, 4096),
        maxEdge:
          typeof it?.maxEdge === 'number'
            ? Math.min(Math.max(Math.round(it.maxEdge), 16), 256)
            : 160,
      })),
    });
  },
  // 识别引擎 API Key：主进程 safeStorage 加密落盘（渲染层不落明文存储）
  orderApiKeySet: (apiKey: string) =>
    ipcRenderer.invoke('order-api-key-set', { apiKey: String(apiKey ?? '').slice(0, 1024) }),
  orderApiKeyGet: () => ipcRenderer.invoke('order-api-key-get'),
  // 清理不被数据库引用的孤儿图片文件（重置/批次覆盖后残留）
  orderCleanupOrphanImages: () => ipcRenderer.invoke('order-cleanup-orphan-images'),
  // 产品库导入「图片」列：读取用户指定的本地图片（任意路径，仅图片扩展名，≤10MB）
  orderReadLocalImage: (localPath: string) =>
    ipcRenderer.invoke('order-read-local-image', {
      localPath: String(localPath ?? '').slice(0, 4096),
    }),
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
      limit:
        typeof payload?.limit === 'number'
          ? Math.min(Math.max(Math.round(payload.limit), 0), 2000)
          : 0,
      status:
        typeof payload?.status === 'string' &&
        ['pending', 'error', 'missing', 'done', 'all'].includes(payload.status)
          ? payload.status
          : undefined,
      missingOnly: payload?.missingOnly === true,
    }),
  orderQueueGet: (id: any) =>
    ipcRenderer.invoke('order-queue-get', {
      id: typeof id === 'number' && Number.isInteger(id) && id > 0 ? id : 0,
    }),
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
        ? input
            .filter((n: any) => typeof n === 'number' && Number.isInteger(n) && n > 0)
            .slice(0, 10000)
        : [],
    }),
  // --- 速卖通利润追踪（M0：入站走 localhost 接收端，本区仅查询类 IPC）---
  aeDbEnsure: () => ipcRenderer.invoke('ae-db-ensure'),
  aeOrderList: (payload: any) =>
    ipcRenderer.invoke('ae-order-list', {
      offset: typeof payload?.offset === 'number' ? Math.max(Math.round(payload.offset), 0) : 0,
      limit:
        typeof payload?.limit === 'number'
          ? Math.min(Math.max(Math.round(payload.limit), 1), 2000)
          : 200,
      search: typeof payload?.search === 'string' ? payload.search.slice(0, 100) : '',
    }),
  aeSummary: () => ipcRenderer.invoke('ae-summary'),
  aeReceiverStatus: () => ipcRenderer.invoke('ae-receiver-status'),
  aeProfitStats: (payload: any) =>
    ipcRenderer.invoke('ae-profit-stats', {
      granularity: payload?.granularity === 'day' ? 'day' : 'month',
      rangeDays:
        typeof payload?.rangeDays === 'number'
          ? Math.min(Math.max(Math.round(payload.rangeDays), 1), 3650)
          : 90,
    }),
  aeCostMapImport: (payload: any) =>
    ipcRenderer.invoke('ae-cost-map-import', {
      items: Array.isArray(payload?.items) ? payload.items.slice(0, 20000) : [],
    }),
  aeCostMapList: () => ipcRenderer.invoke('ae-cost-map-list'),
  // ---- 结算明细（AE 后台「订单明细」导出；解析在渲染层 src/lib/settleImport.ts，主进程只归一+存）----
  settleImport: (payload: any) =>
    ipcRenderer.invoke('settle-import', {
      rows: Array.isArray(payload?.rows) ? payload.rows.slice(0, 20000) : [],
    }),
  settleOrders: (payload: any) =>
    ipcRenderer.invoke('settle-orders', {
      orderNos: Array.isArray(payload?.orderNos)
        ? payload.orderNos
            .slice(0, 2000)
            .map((x: any) => (typeof x === 'string' ? x.slice(0, 64) : ''))
        : [],
    }),
  settleStats: () => ipcRenderer.invoke('settle-stats'),
  aeRateList: () => ipcRenderer.invoke('ae-rate-list'),
  aeRateUpsert: (payload: any) =>
    ipcRenderer.invoke('ae-rate-upsert', {
      fromCurrency: String(payload?.fromCurrency ?? '')
        .slice(0, 8)
        .toUpperCase(),
      rateToCny: Number(payload?.rateToCny),
    }),
  purchaseCostSnapshot: () => ipcRenderer.invoke('purchase-cost-snapshot'),
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
      amountCents:
        typeof payload?.amountCents === 'number' ? Math.max(0, Math.round(payload.amountCents)) : 0,
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
      defaultName:
        typeof payload?.defaultName === 'string' ? payload.defaultName.slice(0, 120) : '',
    }),
  // ---- 店铺账号管家（以「店铺套 · 邮箱」为单位的店群账号维护；密码经主进程 safeStorage 加密落库，渲染层不存明文）----
  shopAccountDbEnsure: () => ipcRenderer.invoke('shop-account-db-ensure'),
  shopAccountList: (payload: any) =>
    ipcRenderer.invoke('shop-account-list', {
      search: typeof payload?.search === 'string' ? payload.search.slice(0, 100) : '',
      status: typeof payload?.status === 'string' ? payload.status.slice(0, 20) : '',
      platform: typeof payload?.platform === 'string' ? payload.platform.slice(0, 60) : '',
    }),
  shopAccountGet: (payload: any) =>
    ipcRenderer.invoke('shop-account-get', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  shopAccountSummary: () => ipcRenderer.invoke('shop-account-summary'),
  shopAccountSecurity: () => ipcRenderer.invoke('shop-account-security'),
  shopAccountUpsert: (payload: any) =>
    ipcRenderer.invoke('shop-account-upsert', sanitizeShopAccountInput(payload)),
  shopAccountDelete: (payload: any) =>
    ipcRenderer.invoke('shop-account-delete', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  shopAccountReveal: (payload: any) =>
    ipcRenderer.invoke('shop-account-reveal', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
      field: typeof payload?.field === 'string' ? payload.field.slice(0, 20) : '',
    }),
  shopAccountBatchUpdate: (payload: any) =>
    ipcRenderer.invoke('shop-account-batch-update', sanitizeShopAccountBatchInput(payload)),
  // ---- 企业管理（企业基本信息 + 欧代 / 土代 / 德国包装法合规资料；无密码类凭据，不进加密列）----
  companyDbEnsure: () => ipcRenderer.invoke('company-db-ensure'),
  companyList: (payload: any) =>
    ipcRenderer.invoke('company-list', {
      search: typeof payload?.search === 'string' ? payload.search.slice(0, 100) : '',
      status: typeof payload?.status === 'string' ? payload.status.slice(0, 20) : '',
    }),
  companyGet: (payload: any) =>
    ipcRenderer.invoke('company-get', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  companySummary: () => ipcRenderer.invoke('company-summary'),
  companyUpsert: (payload: any) =>
    ipcRenderer.invoke('company-upsert', sanitizeCompanyInput(payload)),
  companyDelete: (payload: any) =>
    ipcRenderer.invoke('company-delete', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  companyProfileUpsert: (payload: any) =>
    ipcRenderer.invoke('company-profile-upsert', sanitizeCompanyProfileInput(payload)),
  companyProfileDelete: (payload: any) =>
    ipcRenderer.invoke('company-profile-delete', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  // ---- 产品库（产品主数据：编码 / 名称 / 厂家 / 类目；编码与 oi_styles.code 同口径，为跨域关联锚点）----
  productDbEnsure: () => ipcRenderer.invoke('product-db-ensure'),
  productList: (payload: any) =>
    ipcRenderer.invoke('product-list', {
      search: typeof payload?.search === 'string' ? payload.search.slice(0, 200) : '',
      status: typeof payload?.status === 'string' ? payload.status.slice(0, 20) : '',
      supplierId: typeof payload?.supplierId === 'number' ? payload.supplierId : 0,
      withoutSupplier: payload?.withoutSupplier === true,
      onlyMissingWeight: payload?.onlyMissingWeight === true,
      offset: typeof payload?.offset === 'number' ? payload.offset : 0,
      limit: typeof payload?.limit === 'number' ? payload.limit : 50,
    }),
  productGet: (payload: any) =>
    ipcRenderer.invoke('product-get', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  productUpsert: (payload: any) =>
    ipcRenderer.invoke('product-upsert', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
      code: typeof payload?.code === 'string' ? payload.code.slice(0, 64) : '',
      name: typeof payload?.name === 'string' ? payload.name.slice(0, 200) : '',
      supplierId: typeof payload?.supplierId === 'number' ? payload.supplierId : 0,
      category: typeof payload?.category === 'string' ? payload.category.slice(0, 60) : '',
      status: typeof payload?.status === 'string' ? payload.status.slice(0, 20) : '',
      note: typeof payload?.note === 'string' ? payload.note.slice(0, 2000) : '',
    }),
  productDelete: (payload: any) =>
    ipcRenderer.invoke('product-delete', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  productSummary: () => ipcRenderer.invoke('product-summary'),
  // ---- Excel 批量导入 / 导出（解析在渲染层，本层只做形状消毒）----
  productImport: (payload: any) =>
    ipcRenderer.invoke('product-import', {
      items: Array.isArray(payload?.items)
        ? payload.items.slice(0, 20000).map((r: any) => ({
            rowNo:
              typeof r?.rowNo === 'number' && Number.isFinite(r.rowNo) ? Math.floor(r.rowNo) : 0,
            code: typeof r?.code === 'string' ? r.code.slice(0, 64) : '',
            name: typeof r?.name === 'string' ? r.name.slice(0, 200) : '',
            supplierId: typeof r?.supplierId === 'number' ? r.supplierId : 0,
            category: typeof r?.category === 'string' ? r.category.slice(0, 60) : '',
            status: typeof r?.status === 'string' ? r.status.slice(0, 20) : 'active',
            note: typeof r?.note === 'string' ? r.note.slice(0, 2000) : '',
          }))
        : [],
      mode: payload?.mode === 'insertOnly' ? 'insertOnly' : 'upsert',
    }),
  // buffer 有意**不做类型兜底**：无效就原样传过去，由主进程判 `instanceof ArrayBuffer`
  // 并返回 `{success:false, error}`。在这里塞一个空 buffer 会让"传错了"变成"导出了个空文件"。
  productExport: (payload: any) =>
    ipcRenderer.invoke('product-export', {
      buffer: payload?.buffer,
      defaultName:
        typeof payload?.defaultName === 'string' && payload.defaultName
          ? payload.defaultName.slice(0, 128)
          : '产品库.xlsx',
    }),
  // ---- 店铺商品ID → 产品映射（P3；pl_shop_sku）----
  // 通道本身**不分读写域**：分域曾经体现在 `DB_OPS` 的白名单里（岛只能调到自己声明过的 op）。
  // ⚠️ 那道闸随产品库岛下架一起删了（2026-10-01）：内建渲染层跑在同进程信任域，不需要它；
  //    将来再开岛时按 ADR-002 C4 重建"只读子域 + owner 写子域"。
  productSkuList: (payload: any) =>
    ipcRenderer.invoke('product-sku-list', {
      offset: typeof payload?.offset === 'number' ? payload.offset : 0,
      limit: typeof payload?.limit === 'number' ? payload.limit : 50,
      search: typeof payload?.search === 'string' ? payload.search.slice(0, 200) : '',
      status: typeof payload?.status === 'string' ? payload.status.slice(0, 20) : '',
      shopId: typeof payload?.shopId === 'number' ? payload.shopId : 0,
    }),
  productSkuSummary: () => ipcRenderer.invoke('product-sku-summary'),
  productSkuQueue: (payload: any) =>
    ipcRenderer.invoke('product-sku-queue', {
      limit: typeof payload?.limit === 'number' ? payload.limit : undefined,
      maxRows: typeof payload?.maxRows === 'number' ? payload.maxRows : undefined,
    }),
  productSkuMap: (payload: any) =>
    ipcRenderer.invoke('product-sku-map', {
      rows: Array.isArray(payload?.rows)
        ? payload.rows.slice(0, 20000).map((r: any) => ({
            platform: typeof r?.platform === 'string' ? r.platform.slice(0, 40) : '',
            shopId: typeof r?.shopId === 'number' ? r.shopId : 0,
            itemId: typeof r?.itemId === 'string' ? r.itemId.slice(0, 64) : '',
            spec: typeof r?.spec === 'string' ? r.spec.slice(0, 40) : '',
            productId: typeof r?.productId === 'number' ? r.productId : 0,
            status: typeof r?.status === 'string' ? r.status.slice(0, 20) : 'confirmed',
            note: typeof r?.note === 'string' ? r.note.slice(0, 2000) : '',
          }))
        : [],
    }),
  productSkuInvalidate: (payload: any) =>
    ipcRenderer.invoke('product-sku-invalidate', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  // ---- SKU 子表（pl_variants：一个款下多个 SKU，每 SKU 一个克重）----
  productVariantList: (payload: any) =>
    ipcRenderer.invoke('product-variant-list', {
      productIds: Array.isArray(payload?.productIds)
        ? payload.productIds.slice(0, 5000).map((x: any) => (typeof x === 'number' ? x : 0))
        : [],
    }),
  productVariantUpsert: (payload: any) =>
    ipcRenderer.invoke('product-variant-upsert', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
      productId: typeof payload?.productId === 'number' ? payload.productId : 0,
      code: typeof payload?.code === 'string' ? payload.code.slice(0, 64) : '',
      name: typeof payload?.name === 'string' ? payload.name.slice(0, 200) : '',
      color: typeof payload?.color === 'string' ? payload.color.slice(0, 40) : '',
      size: typeof payload?.size === 'string' ? payload.size.slice(0, 40) : '',
      weightG: Math.round(Number(payload?.weightG)) || 0,
      status: typeof payload?.status === 'string' ? payload.status.slice(0, 20) : 'active',
    }),
  productVariantDelete: (payload: any) =>
    ipcRenderer.invoke('product-variant-delete', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  // 批量编辑：**只回传用户填了的字段**（undefined 字段直接不带 —— 带了空串就会清掉原值），
  // supplierId: 0 = 清空厂家关联（0 是合法目标值，不能当"没填"）
  productBatchUpdate: (payload: any) => {
    const out: Record<string, unknown> = {
      ids: Array.isArray(payload?.ids)
        ? payload.ids
            .map((x: any) => (typeof x === 'number' && Number.isInteger(x) && x > 0 ? x : 0))
            .filter((x: number) => x > 0)
            .slice(0, 1000)
        : [],
    };
    if (payload?.supplierId !== undefined) out.supplierId = Number(payload.supplierId) || 0;
    if (payload?.category !== undefined) out.category = String(payload.category).slice(0, 60);
    if (payload?.status !== undefined) out.status = String(payload.status).slice(0, 20);
    if (payload?.note !== undefined) out.note = String(payload.note).slice(0, 2000);
    return ipcRenderer.invoke('product-batch-update', out);
  },
  // ---- 产品图片（pl_images / pl_item_images；srcPath 须来自用户对话框所选文件）----
  productImageAttach: (payload: any) =>
    ipcRenderer.invoke('product-image-attach', {
      productId: typeof payload?.productId === 'number' ? payload.productId : 0,
      srcPath: typeof payload?.srcPath === 'string' ? payload.srcPath : '',
    }),
  productImageDetach: (payload: any) =>
    ipcRenderer.invoke('product-image-detach', {
      productId: typeof payload?.productId === 'number' ? payload.productId : 0,
    }),
  productItemImageSet: (payload: any) =>
    ipcRenderer.invoke('product-item-image-set', {
      itemId: typeof payload?.itemId === 'string' ? payload.itemId.slice(0, 64) : '',
      srcPath: typeof payload?.srcPath === 'string' ? payload.srcPath : '',
    }),
  productItemImageClear: (payload: any) =>
    ipcRenderer.invoke('product-item-image-clear', {
      itemId: typeof payload?.itemId === 'string' ? payload.itemId.slice(0, 64) : '',
    }),
  productItemImagePool: (payload: any) =>
    ipcRenderer.invoke('product-item-image-pool', {
      itemIds: Array.isArray(payload?.itemIds)
        ? payload.itemIds.slice(0, 1000).map((x: any) => (typeof x === 'string' ? x.slice(0, 64) : ''))
        : [],
    }),
  // ---- 店铺实体（sk_shops / sk_name_map；DOMAIN_INTEGRATION_PLAN S1）----
  // 补上"店铺"这个缺失的实体层：历史文本（订单 / 采购 / 利润三处）不改写，靠名称归一映射旁挂关联。
  shopDbEnsure: () => ipcRenderer.invoke('shop-db-ensure'),
  shopList: (payload: any) =>
    ipcRenderer.invoke('shop-list', {
      offset: Number(payload?.offset) || 0,
      limit: Number(payload?.limit) || 50,
      search: typeof payload?.search === 'string' ? payload.search.slice(0, 200) : '',
      platform: typeof payload?.platform === 'string' ? payload.platform.slice(0, 40) : '',
      status: typeof payload?.status === 'string' ? payload.status.slice(0, 20) : '',
      shopSetId: Number(payload?.shopSetId) || 0,
    }),
  shopGet: (payload: any) => ipcRenderer.invoke('shop-get', { id: Number(payload?.id) || 0 }),
  shopUpsert: (payload: any) =>
    ipcRenderer.invoke('shop-upsert', {
      id: Number(payload?.id) || 0,
      platform: typeof payload?.platform === 'string' ? payload.platform.slice(0, 40) : '',
      name: typeof payload?.name === 'string' ? payload.name.slice(0, 200) : '',
      platformShopId: typeof payload?.platformShopId === 'string' ? payload.platformShopId.slice(0, 100) : '',
      site: typeof payload?.site === 'string' ? payload.site.slice(0, 40) : '',
      shopSetId: Number(payload?.shopSetId) || 0,
      status: typeof payload?.status === 'string' ? payload.status.slice(0, 20) : 'active',
      openedAt: typeof payload?.openedAt === 'string' ? payload.openedAt.slice(0, 40) : '',
      note: typeof payload?.note === 'string' ? payload.note.slice(0, 2000) : '',
    }),
  shopSummary: () => ipcRenderer.invoke('shop-summary'),
  shopUnmapped: () => ipcRenderer.invoke('shop-unmapped'),
  shopMap: (payload: any) =>
    ipcRenderer.invoke('shop-map', {
      raw: typeof payload?.raw === 'string' ? payload.raw.slice(0, 200) : '',
      refId: Number(payload?.refId) || 0,
      ignored: payload?.ignored === true,
      kind: typeof payload?.kind === 'string' ? payload.kind.slice(0, 20) : 'shop',
      note: typeof payload?.note === 'string' ? payload.note.slice(0, 2000) : '',
    }),
  shopUnmap: (payload: any) =>
    ipcRenderer.invoke('shop-unmap', {
      raw: typeof payload?.raw === 'string' ? payload.raw.slice(0, 200) : '',
      kind: typeof payload?.kind === 'string' ? payload.kind.slice(0, 20) : 'shop',
    }),
  // ---- 外置插件（Phase 3：独立插件目录 <userData>/plugins）----
  pluginsScan: () => ipcRenderer.invoke('plugins-scan'),
  pluginsReadEntry: (payload: any) =>
    ipcRenderer.invoke('plugins-read-entry', {
      id: typeof payload?.id === 'string' ? payload.id.slice(0, 64) : '',
      entry: typeof payload?.entry === 'string' ? payload.entry.slice(0, 256) : '',
    }),
  pluginsUninstall: (payload: any) =>
    ipcRenderer.invoke('plugins-uninstall', {
      id: typeof payload?.id === 'string' ? payload.id.slice(0, 64) : '',
    }),
  pluginsOpenDir: () => ipcRenderer.invoke('plugins-open-dir'),
  // ---- 插件市场（Market：catalog 拉取 + zip 安装；主进程二次净化）----
  pluginMarketCatalog: (payload: any) =>
    ipcRenderer.invoke('plugins-market-catalog', {
      url:
        typeof payload?.url === 'string' && /^https?:\/\//i.test(payload.url)
          ? payload.url.slice(0, 2048)
          : '',
    }),
  pluginMarketInstall: (payload: any) =>
    ipcRenderer.invoke('plugins-market-install', {
      item: sanitizeMarketItem(payload?.item),
      force: payload?.force === true,
    }),
  // ---- 软件更新（GitHub Releases 自动更新）----
  checkForUpdates: () => ipcRenderer.invoke('updater-check'),
  quitAndInstallUpdate: () => ipcRenderer.invoke('updater-install'),
  // 订阅更新事件（主进程→渲染层单向）；返回退订函数
  onUpdaterEvent: (cb: (payload: any) => void) => {
    const listener = (_event: any, payload: any) => {
      if (cb) cb(payload);
    };
    ipcRenderer.on('updater-event', listener);
    return () => {
      ipcRenderer.removeListener('updater-event', listener);
    };
  },
  // ---- 集中邮件收件箱（IMAP 只读同步；授权码只进不出）----
  mailDbEnsure: () => ipcRenderer.invoke('mail-db-ensure'),
  mailAccountList: () => ipcRenderer.invoke('mail-account-list'),
  mailAccountUpsert: (payload: any) =>
    ipcRenderer.invoke('mail-account-upsert', {
      shopSetId: Number(payload?.shopSetId) || 0,
      email: typeof payload?.email === 'string' ? payload.email.slice(0, 200) : '',
      providerId: typeof payload?.providerId === 'string' ? payload.providerId.slice(0, 40) : '',
      imapHost: typeof payload?.imapHost === 'string' ? payload.imapHost.slice(0, 200) : '',
      imapPort: Number(payload?.imapPort) || 993,
      imapSecure: payload?.imapSecure !== false,
      folder: typeof payload?.folder === 'string' ? payload.folder.slice(0, 200) : 'INBOX',
      // 多文件夹（M3-3）：空数组 = 保持「单文件夹 folder」语义
      folders: Array.isArray(payload?.folders)
        ? payload.folders
            .map((f: any) =>
              String(f || '')
                .trim()
                .slice(0, 200)
            )
            .filter(Boolean)
            .slice(0, 30)
        : [],
      syncEnabled: payload?.syncEnabled !== false,
      syncDays: Math.min(365, Math.max(1, Number(payload?.syncDays) || 30)),
      maxBodyBytes: Math.min(
        2 * 1024 * 1024,
        Math.max(8 * 1024, Number(payload?.maxBodyBytes) || 204800)
      ),
      // 授权码：仅当显式传入时才带上（省略 = 保持原值）
      secrets:
        typeof payload?.secrets?.mailAuthPwd === 'string'
          ? { mailAuthPwd: payload.secrets.mailAuthPwd.slice(0, 500) }
          : {},
    }),
  mailAccountDelete: (payload: any) =>
    ipcRenderer.invoke('mail-account-delete', { id: Number(payload?.id) || 0 }),
  mailAccountTest: (payload: any) =>
    ipcRenderer.invoke('mail-account-test', {
      email: typeof payload?.email === 'string' ? payload.email.slice(0, 200) : '',
      authPassword:
        typeof payload?.authPassword === 'string' ? payload.authPassword.slice(0, 500) : '',
      providerId: typeof payload?.providerId === 'string' ? payload.providerId.slice(0, 40) : '',
      host: typeof payload?.host === 'string' ? payload.host.slice(0, 200) : '',
      port: Number(payload?.port) || 993,
      secure: payload?.secure !== false,
    }),
  mailSyncNow: (payload?: any) =>
    ipcRenderer.invoke('mail-sync-now', { accountId: Number(payload?.accountId) || 0 }),
  mailSyncCancel: (payload: any) =>
    ipcRenderer.invoke('mail-sync-cancel', { accountId: Number(payload?.accountId) || 0 }),
  mailSyncState: () => ipcRenderer.invoke('mail-sync-state'),
  mailMessagesList: (payload?: any) =>
    ipcRenderer.invoke('mail-messages-list', {
      accountIds: Array.isArray(payload?.accountIds)
        ? payload.accountIds
            .map((n: any) => Number(n) || 0)
            .filter((n: number) => n > 0)
            .slice(0, 200)
        : [],
      keyword: typeof payload?.keyword === 'string' ? payload.keyword.slice(0, 100) : '',
      unreadOnly: payload?.unreadOnly === true,
      since: typeof payload?.since === 'string' ? payload.since.slice(0, 40) : '',
      // 多文件夹筛选（M3-3）
      folders: Array.isArray(payload?.folders)
        ? payload.folders
            .map((f: any) =>
              String(f || '')
                .trim()
                .slice(0, 200)
            )
            .filter(Boolean)
            .slice(0, 30)
        : [],
      limit: Math.min(200, Math.max(1, Number(payload?.limit) || 50)),
      offset: Math.max(0, Number(payload?.offset) || 0),
    }),
  mailMessageGet: (payload: any) =>
    ipcRenderer.invoke('mail-message-get', { id: Number(payload?.id) || 0 }),
  // 本地已读标记（IMAP 只读，有效已读 = 服务端 seen || 本地 read_at）
  mailMessageRead: (payload: any) =>
    ipcRenderer.invoke('mail-message-read', {
      ids: Array.isArray(payload?.ids)
        ? payload.ids.map((n: any) => Number(n) || 0).filter((n: number) => n > 0)
        : [],
      accountId: Number(payload?.accountId) || 0,
      all: payload?.all === true,
      read: payload?.read !== false,
    }),
  // 按需补拉正文（M2-1）
  mailBodyFetch: (payload: any) =>
    ipcRenderer.invoke('mail-body-fetch', {
      accountId: Number(payload?.accountId) || 0,
      messageId: Number(payload?.messageId) || 0,
    }),
  // 附件另存（M2-2 / M3-1 走本地缓存）
  mailAttachmentSave: (payload: any) =>
    ipcRenderer.invoke('mail-attachment-save', {
      messageId: Number(payload?.messageId) || 0,
      attachmentId: Number(payload?.attachmentId) || 0,
    }),
  // 附件预览（M3-1）：图片返回 data URL
  mailAttachmentPreview: (payload: any) =>
    ipcRenderer.invoke('mail-attachment-preview', {
      messageId: Number(payload?.messageId) || 0,
      attachmentId: Number(payload?.attachmentId) || 0,
    }),
  // 附件用系统应用打开（M3-1）
  mailAttachmentOpen: (payload: any) =>
    ipcRenderer.invoke('mail-attachment-open', {
      messageId: Number(payload?.messageId) || 0,
      attachmentId: Number(payload?.attachmentId) || 0,
    }),
  // 服务端文件夹列表（M3-3）
  mailFoldersList: (payload: any) =>
    ipcRenderer.invoke('mail-folders-list', { accountId: Number(payload?.accountId) || 0 }),
  // 附件本地缓存（M3-1）
  mailCacheStatus: () => ipcRenderer.invoke('mail-cache-status'),
  mailCacheClear: () => ipcRenderer.invoke('mail-cache-clear'),
  mailCacheOpen: () => ipcRenderer.invoke('mail-cache-open'),
  // FTS5 全文检索（M3-2）
  mailFtsStatus: () => ipcRenderer.invoke('mail-fts-status'),
  mailFtsRebuild: () => ipcRenderer.invoke('mail-fts-rebuild'),
  mailPurge: (payload?: any) =>
    ipcRenderer.invoke('mail-purge', {
      accountId: Number(payload?.accountId) || 0,
      days: Math.min(365, Math.max(1, Number(payload?.days) || 30)),
    }),
  mailStats: () => ipcRenderer.invoke('mail-stats'),
  // ---- 店铺商品清单（pl_shop_sku 扩展视图，支持一对多关联）----
  shopProductImport: (payload: any) =>
    ipcRenderer.invoke('shop-product-import', {
      items: Array.isArray(payload?.items)
        ? payload.items.slice(0, 20000).map((r: any) => ({
            itemId: typeof r?.itemId === 'string' ? r.itemId.slice(0, 64) : '',
            shopId: typeof r?.shopId === 'number' ? r.shopId : 0,
            shopName: typeof r?.shopName === 'string' ? r.shopName.slice(0, 200) : '',
            imageUrl: typeof r?.imageUrl === 'string' ? r.imageUrl.slice(0, 2000) : '',
          }))
        : [],
    }),
  shopProductList: (payload: any) =>
    ipcRenderer.invoke('shop-product-list', {
      offset: typeof payload?.offset === 'number' ? payload.offset : 0,
      limit: typeof payload?.limit === 'number' ? payload.limit : 50,
      search: typeof payload?.search === 'string' ? payload.search.slice(0, 200) : '',
    }),
  shopProductDelete: (payload: any) =>
    ipcRenderer.invoke('shop-product-delete', {
      itemId: typeof payload?.itemId === 'string' ? payload.itemId.slice(0, 64) : '',
    }),
  shopProductRelations: (payload: any) =>
    ipcRenderer.invoke('shop-product-relations', {
      itemId: typeof payload?.itemId === 'string' ? payload.itemId.slice(0, 64) : '',
    }),
  shopProductRelationAdd: (payload: any) =>
    ipcRenderer.invoke('shop-product-relation-add', {
      itemId: typeof payload?.itemId === 'string' ? payload.itemId.slice(0, 64) : '',
      productId: typeof payload?.productId === 'number' ? payload.productId : 0,
      shopId: typeof payload?.shopId === 'number' ? payload.shopId : 0,
    }),
  shopProductRelationDelete: (payload: any) =>
    ipcRenderer.invoke('shop-product-relation-delete', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  mailProviderList: () => ipcRenderer.invoke('mail-provider-list'),
  // ---- 运价表快照（宿主中立层；ADR-002 C3：运价表是主数据，不能只留在岛私有 storage）----
  // 一次导入 = 一条快照（按内容去重），算账时按订单日期取"当时生效的那份" → 历史预测可复算。
  shipRateSnapshotSave: (payload: any) =>
    ipcRenderer.invoke('ship-rate-snapshot-save', {
      table: payload?.table ?? null,
      sourceFile: typeof payload?.sourceFile === 'string' ? payload.sourceFile.slice(0, 500) : '',
      sheetName: typeof payload?.sheetName === 'string' ? payload.sheetName.slice(0, 200) : '',
      effectiveFrom:
        typeof payload?.effectiveFrom === 'string' ? payload.effectiveFrom.slice(0, 10) : '',
    }),
  shipRateSnapshotList: (payload: any) =>
    ipcRenderer.invoke('ship-rate-snapshot-list', {
      limit: typeof payload?.limit === 'number' ? payload.limit : 50,
    }),
  shipRateSnapshotCalc: (payload: any) =>
    ipcRenderer.invoke('ship-rate-snapshot-calc', {
      limit: typeof payload?.limit === 'number' ? payload.limit : 50,
    }),
  // 订阅邮件同步事件（主进程→渲染层单向）；返回退订函数
  onMailSyncEvent: (cb: (payload: any) => void) => {
    const listener = (_event: any, payload: any) => {
      if (cb) cb(payload);
    };
    ipcRenderer.on('mail-sync-event', listener);
    return () => {
      ipcRenderer.removeListener('mail-sync-event', listener);
    };
  },
});
