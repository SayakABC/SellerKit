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
      // 款色 id 是"已拿 ↔ 需求"的身份键（不是展示字段）：这里丢掉它，开出的单每行都会
      // `style_color_id = 0`，编辑器就退回「色未定 · 选一个」，用户得再选一次色。
      styleColorId:
        typeof it?.styleColorId === 'number' ? Math.max(0, Math.round(it.styleColorId)) : 0,
      // **下单码**（亚洲款加码）：`size` 是拿货码，这一列是订单原文码。
      // 丢掉它 ⇒ 加码单的"这批货覆盖了哪几条订单行"整批匹配不上（见 `PurchaseItem.orderSize`）。
      orderSize: typeof it?.orderSize === 'string' ? it.orderSize.slice(0, 50) : '',
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
      // 下单码（亚洲款加码）：与 `size`（拿货码）不同时导出表里标成 `XL（下单L）`
      orderSize: typeof r?.orderSize === 'string' ? r.orderSize.slice(0, 40) : '',
      pieces: typeof r?.pieces === 'number' ? Math.max(0, Math.round(r.pieces)) : 0,
      // ⚠️ 之前漏了这两列：`buildPickingWorkbook` 读 `it.taken/it.remaining`，不在消毒里透传
      // 就是恒 0 —— 界面「还差 12」、导出表「还差 0」，而且不报错（2026-11-02 补）。
      taken: typeof r?.taken === 'number' ? Math.max(0, Math.round(r.taken)) : 0,
      remaining: typeof r?.remaining === 'number' ? Math.max(0, Math.round(r.remaining)) : 0,
      orders: typeof r?.orders === 'number' ? Math.max(0, Math.round(r.orders)) : 0,
      unitPrice: money(r?.unitPrice),
      amount: money(r?.amount),
      gaps: typeof r?.gaps === 'string' ? r.gaps.slice(0, 200) : '',
      image: image(r?.image),
    }))
    .filter((r: any) => r.styleCode || r.color || r.size);
};

/**
 * 记账导出：渲染层已把展示文案本地化好，本层只做长度/类型消毒。
 * **不复算金额**（合计也由渲染层传）—— 导出的数必须与屏幕上的数同一来源。
 */
const sanitizeLedgerExportRows = (rows: any) => {
  if (!Array.isArray(rows)) return [];
  const t = (v: any, max: number) => (typeof v === 'string' ? v.slice(0, max) : '');
  return rows.slice(0, 5000).map((r: any) => ({
    bizDate: t(r?.bizDate, 10),
    kindLabel: t(r?.kindLabel, 10),
    scopeLabel: t(r?.scopeLabel, 40),
    shopLabel: t(r?.shopLabel, 60),
    partyName: t(r?.partyName, 100),
    categoryName: t(r?.categoryName, 100),
    amountCents: Math.trunc(Number(r?.amountCents)) || 0,
    settleLabel: t(r?.settleLabel, 40),
    note: t(r?.note, 2000),
  }));
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

/**
 * 店铺账号合并入参消毒：结构白名单 + 长度约束。
 * ⚠️ 缺省键必须**不出现**（而不是给 ''）：主进程按「`undefined` = 保持原值、`''` = 清空」
 * 处理局部更新；把缺省补成空串会把没展示的字段悄悄清掉。
 */
const sanitizeShopAccountInput = (payload: any) => {
  const out: Record<string, unknown> = {
    id:
      typeof payload?.id === 'number' && Number.isInteger(payload.id) && payload.id > 0
        ? payload.id
        : 0,
  };
  const opt = (key: string, max: number) => {
    if (typeof payload?.[key] === 'string') out[key] = payload[key].slice(0, max);
  };
  opt('name', 200);
  opt('platform', 40);
  opt('platformShopId', 100);
  opt('shopUrl', 500);
  opt('site', 40);
  opt('email', 200);
  opt('openedAt', 40);
  opt('depositReceivedAt', 40);
  opt('status', 20);
  opt('tags', 200);
  opt('note', 2000);
  const nonNeg = (key: string) => {
    const value = payload?.[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      out[key] = Math.min(value, 2147483647);
    }
  };
  nonNeg('companyId');
  nonNeg('ziniaoAccountId');
  nonNeg('erpAccountId');
  // 记分分值：只收 ≥ 0 的有限数（可为小数；负数 / NaN 由主进程再挡一次）
  if (typeof payload?.score === 'number' && Number.isFinite(payload.score) && payload.score >= 0) {
    out.score = Math.min(payload.score, 2147483647);
  }

  // 敏感字段白名单：店铺密码 / 邮箱密码 / 国际支付宝密码 / IMAP 授权码
  const allowedSecretKeys = ['shopPwd', 'emailPwd', 'alipayPwd', 'mailAuthPwd'];
  if (isPlainObject(payload?.secrets)) {
    const secrets: Record<string, string> = {};
    for (const [k, v] of Object.entries(payload.secrets)) {
      if (!allowedSecretKeys.includes(k) || typeof v !== 'string') continue;
      secrets[k] = v.slice(0, 500);
    }
    if (Object.keys(secrets).length) out.secrets = secrets;
  }
  if (Array.isArray(payload?.clearSecrets)) {
    const clear = payload.clearSecrets.filter(
      (v: unknown): v is string => typeof v === 'string' && allowedSecretKeys.includes(v)
    );
    if (clear.length) out.clearSecrets = clear;
  }
  return out;
};

/**
 * 批量修改入参消毒：结构白名单（仅非敏感字段）+ 数量/长度约束。
 * 手机号 / 支付宝 / 平台 / 工具登录名不再是店铺行字段，已从批量面移除。
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
  const nonNeg = (key: string) => {
    const value = patchRaw[key];
    if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
      patch[key] = Math.min(value, 2147483647);
    }
  };
  nonNeg('companyId');
  nonNeg('ziniaoAccountId');
  nonNeg('erpAccountId');
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
  return { ids, patch };
};

/** 工具账号入参消毒（缺省 = 主进程保持原值；'' = 清空密码） */
const sanitizeToolAccountInput = (payload: any) => {
  const out: Record<string, unknown> = {
    id:
      typeof payload?.id === 'number' && Number.isInteger(payload.id) && payload.id > 0
        ? payload.id
        : 0,
  };
  if (typeof payload?.kind === 'string') out.kind = payload.kind.slice(0, 20);
  if (typeof payload?.account === 'string') out.account = payload.account.slice(0, 200);
  if (typeof payload?.note === 'string') out.note = payload.note.slice(0, 2000);
  if (typeof payload?.password === 'string') out.password = payload.password.slice(0, 500);
  return out;
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
    // ⚠️ 必须带：企业表的支付宝是店铺侧「扣运费账号」的唯一来源；sanitize 会把缺省字段压成空串，
    // 漏传这一行 ⇒ 每次保存企业都把已维护的支付宝清空。
    alipayAccount: s(payload?.alipayAccount, 200),
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

// ---- 记账域载荷消毒 ----
// ⚠️ 这里的 `opt*` 系列**只在该字段确实存在时**才消毒，`undefined` 必须原样保留：
//    主进程对 `undefined` 的语义是"保持原值"，一旦在 preload 折成 `''` / `0`，
//    更新条目时就会把用户没碰过的备注、科目静默清空（这类 bug 界面上完全看不出来）。
const optNum = (v: any): number | undefined =>
  v === undefined ? undefined : Math.trunc(Number(v)) || 0;
const optStr = (v: any, max: number): string | undefined =>
  v === undefined ? undefined : String(v).slice(0, max);
const optIdList = (v: any, limit: number): number[] => {
  if (!Array.isArray(v)) return [];
  return v.slice(0, limit).map((x: any) => Math.trunc(Number(x)) || 0);
};
const optAllocations = (v: any) => {
  if (!Array.isArray(v)) return undefined;
  return v.slice(0, 200).map((a: any) => ({
    shopId: Math.trunc(Number(a?.shopId)) || 0,
    amountCents: Math.trunc(Number(a?.amountCents)) || 0,
    ratioBp: Math.trunc(Number(a?.ratioBp)) || 0,
  }));
};
/** 一组原文名字（批量导入查身份用）。截到 200：库里名字上限 100，更长的写法必然对不上 */
const optNameList = (v: any): string[] => {
  if (!Array.isArray(v)) return [];
  return v
    .slice(0, 1000)
    .filter((x: any) => typeof x === 'string' && x.trim() !== '')
    .map((x: string) => x.slice(0, 200));
};
/**
 * 批量导入的逐行载荷（**写路径**，所以不给默认值）：
 * 缺失字段一律折成 `''` / `0`，由主进程决定"这行不合法"并带行号报错。
 * 反过来若在 preload 兜默认（比如 `kind` 缺省当收入），一笔支出会被静默记成收入。
 */
const sanitizeLedgerImportEntries = (entries: any) => {
  if (!Array.isArray(entries)) return [];
  return entries.slice(0, 2000).map((e: any) => ({
    id: 0, // 这条通道只新增：更新已有条目是「记一笔」的活（那里才有结算占用边界）
    bizDate: typeof e?.bizDate === 'string' ? e.bizDate.slice(0, 10) : '',
    kind: e?.kind === 'income' || e?.kind === 'expense' ? e.kind : '',
    scope: e?.scope === 'shared' || e?.scope === 'shop' ? e.scope : '',
    shopId: Math.trunc(Number(e?.shopId)) || 0,
    partyId: Math.trunc(Number(e?.partyId)) || 0,
    categoryId: Math.trunc(Number(e?.categoryId)) || 0,
    // 名字只在"id 为 0"时有意义：主进程按它建/找相关人与科目（导入自动建名）
    partyName: typeof e?.partyName === 'string' ? e.partyName.slice(0, 100) : '',
    categoryName: typeof e?.categoryName === 'string' ? e.categoryName.slice(0, 100) : '',
    amountCents: Math.trunc(Number(e?.amountCents)) || 0,
    basis: e?.basis === 'equal' || e?.basis === 'revenue' || e?.basis === 'manual' ? e.basis : '',
    ruleId: Math.trunc(Number(e?.ruleId)) || 0,
    method: typeof e?.method === 'string' ? e.method.slice(0, 40) : '',
    note: typeof e?.note === 'string' ? e.note.slice(0, 2000) : '',
    allocations: optAllocations(e?.allocations),
  }));
};
/** 导入模板的三张表：内容全由渲染层算好，本层只截长度 */
const sanitizeLedgerTemplateSheets = (sheets: any) => {
  if (!Array.isArray(sheets)) return [];
  return sheets.slice(0, 8).map((s: any) => ({
    name: typeof s?.name === 'string' ? s.name.slice(0, 31) : '',
    rows: (Array.isArray(s?.rows) ? s.rows.slice(0, 2000) : []).map((r: any) =>
      (Array.isArray(r) ? r.slice(0, 40) : []).map((c: any) => String(c ?? '').slice(0, 500))
    ),
    widths: (Array.isArray(s?.widths) ? s.widths.slice(0, 40) : []).map(
      (w: any) => Math.trunc(Number(w)) || 0
    ),
  }));
};

contextBridge.exposeInMainWorld('electronAPI', {
  selectExcel: () => ipcRenderer.invoke('select-excel'),
  selectImage: () => ipcRenderer.invoke('select-image'),
  importExcelByPath: (filePath: string) => ipcRenderer.invoke('read-file', filePath),
  selectTemplate: () => ipcRenderer.invoke('select-template'),
  saveTemplate: (filePath: string, content: string) =>
    ipcRenderer.invoke('save-template', filePath, content),
  writeClipboard: (text: string) => ipcRenderer.invoke('write-clipboard', text),
  // 写图片剪贴板（PNG dataURL）：「复制给厂家」把发厂清单图送进系统剪贴板
  writeClipboardImage: (dataUrl: string) => ipcRenderer.invoke('write-clipboard-image', dataUrl),
  // 打开外链（「打开店铺」；主进程只放行 http/https，且优先 Chrome、用不了回落系统默认浏览器）
  openExternal: (url: string) =>
    ipcRenderer.invoke('open-external', String(url ?? '').slice(0, 2048)),
  // 模块命名空间持久化（Phase 1）
  getModuleState: (moduleId: string) => ipcRenderer.invoke('get-module-state', moduleId),
  setModuleState: (moduleId: string, data: any) =>
    ipcRenderer.invoke('set-module-state', moduleId, data),
  checkFileExists: (filePath: string) => ipcRenderer.invoke('check-file-exists', filePath),
  readFile: (filePath: string) => ipcRenderer.invoke('read-file', filePath),
  getDefaultTemplatePath: () => ipcRenderer.invoke('get-default-template-path'),
  // 规则求值隔离窗口（jsExpression）：含代码的规则一律送窗口执行。
  // 主窗口不再有 `new Function` —— 见 electron/rule-eval-window.ts 与 index.html 的 CSP。
  ruleEvalBatch: (payload: { rule: { id: string; code: string }; fields: Record<string, string>[] }) =>
    ipcRenderer.invoke('rule-eval-batch', payload),
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
      // 导入日过滤：只放行 `yyyy-mm-dd`（主进程再按 `date(created_at)` 比）
      importDate:
        typeof payload?.importDate === 'string' ? payload.importDate.slice(0, 10) : undefined,
    }),
  orderClear: () => ipcRenderer.invoke('order-clear'),
  // 运费原始行（oi_orders 最小投影 id/order_no/raw_fields，只读；供按订单算运费的宿主 op 提取）
  orderAssignShop: (payload: any) =>
    ipcRenderer.invoke('order-assign-shop', {
      orderNos: Array.isArray(payload?.orderNos)
        ? payload.orderNos
            .slice(0, 2000)
            .map((x: any) => (typeof x === 'string' ? x.slice(0, 64) : ''))
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
      // 导入日过滤（`yyyy-mm-dd`）；空串 = 不筛（与主进程 `shippingRows` 的默认值一致）
      importDate: typeof payload?.importDate === 'string' ? payload.importDate.slice(0, 10) : '',
      // 订单发生月过滤（`yyyy-mm`）；空串 = 不筛。记账的营收占比按条目月份取数。
      period: typeof payload?.period === 'string' ? payload.period.slice(0, 7) : '',
    }),
  // 最近一次芒果同步的状态（无入参；总览的采集状态条读它）
  mangoSyncStatus: () => ipcRenderer.invoke('mango-sync-status'),
  orderDownloadImage: (url: string) =>
    ipcRenderer.invoke('order-download-image', { url: String(url ?? '') }),
  // ---- 包裹（阶段 B2）：一单多包 / 按商品行拆 / 拆合并行数量 ----
  // 每个写通道都带 `orderNo`：主进程写成功后回**整单**最新状态，界面直接重绘。
  orderParcelDetail: (payload: any) =>
    ipcRenderer.invoke('order-parcel-detail', {
      orderNo: typeof payload?.orderNo === 'string' ? payload.orderNo.slice(0, 128) : '',
    }),
  orderParcelCounts: (payload: any) =>
    ipcRenderer.invoke('order-parcel-counts', {
      orderNos: Array.isArray(payload?.orderNos)
        ? payload.orderNos.filter((v: any) => typeof v === 'string').slice(0, 2000)
        : [],
    }),
  orderParcelTotals: (payload: any) =>
    ipcRenderer.invoke('order-parcel-totals', {
      orderNos: Array.isArray(payload?.orderNos)
        ? payload.orderNos.filter((v: any) => typeof v === 'string').slice(0, 2000)
        : [],
    }),
  orderParcelCreate: (payload: any) =>
    ipcRenderer.invoke('order-parcel-create', {
      orderNo: typeof payload?.orderNo === 'string' ? payload.orderNo.slice(0, 128) : '',
      label: typeof payload?.label === 'string' ? payload.label : '',
      trackingNo: typeof payload?.trackingNo === 'string' ? payload.trackingNo : '',
      carrier: typeof payload?.carrier === 'string' ? payload.carrier : '',
      note: typeof payload?.note === 'string' ? payload.note : '',
      shipCents: typeof payload?.shipCents === 'number' ? payload.shipCents : null,
      weightG: typeof payload?.weightG === 'number' ? payload.weightG : null,
    }),
  orderParcelUpdate: (payload: any) =>
    ipcRenderer.invoke('order-parcel-update', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
      orderNo: typeof payload?.orderNo === 'string' ? payload.orderNo.slice(0, 128) : '',
      ...(typeof payload?.label === 'string' ? { label: payload.label } : {}),
      ...(typeof payload?.trackingNo === 'string' ? { trackingNo: payload.trackingNo } : {}),
      ...(typeof payload?.carrier === 'string' ? { carrier: payload.carrier } : {}),
      ...(typeof payload?.note === 'string' ? { note: payload.note } : {}),
      // `null` 是**有意义的取值**（清成"还不知道"），不能和 `undefined`（不改）混
      ...(payload?.shipCents === null || typeof payload?.shipCents === 'number'
        ? { shipCents: payload.shipCents }
        : {}),
      ...(payload?.weightG === null || typeof payload?.weightG === 'number'
        ? { weightG: payload.weightG }
        : {}),
    }),
  orderParcelDelete: (payload: any) =>
    ipcRenderer.invoke('order-parcel-delete', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
      orderNo: typeof payload?.orderNo === 'string' ? payload.orderNo.slice(0, 128) : '',
    }),
  orderParcelSetLine: (payload: any) =>
    ipcRenderer.invoke('order-parcel-set-line', {
      parcelId: typeof payload?.parcelId === 'number' ? payload.parcelId : 0,
      orderItemId: typeof payload?.orderItemId === 'number' ? payload.orderItemId : 0,
      qty: typeof payload?.qty === 'number' ? Math.round(payload.qty) : 0,
      orderNo: typeof payload?.orderNo === 'string' ? payload.orderNo.slice(0, 128) : '',
    }),
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
  // ---- 记账（店铺收支 + 公共费用分摊 + 资金相关人往来结算）----
  // 分摊算法只在 `src/lib/ledger.ts`：本层只搬数字，不做任何比例计算。
  ledgerDbEnsure: () => ipcRenderer.invoke('ledger-db-ensure'),
  ledgerEligibleShops: (payload: any) =>
    ipcRenderer.invoke('ledger-eligible-shops', {
      period: optStr(payload?.period, 7) ?? '',
    }),
  ledgerCategoryList: (payload: any) =>
    ipcRenderer.invoke('ledger-category-list', {
      kind: optStr(payload?.kind, 20) ?? '',
      includeArchived: payload?.includeArchived === true,
    }),
  ledgerCategoryUpsert: (payload: any) =>
    ipcRenderer.invoke('ledger-category-upsert', {
      id: optNum(payload?.id) ?? 0,
      kind: optStr(payload?.kind, 20) ?? '',
      name: optStr(payload?.name, 100) ?? '',
      sort: optNum(payload?.sort),
      archived: typeof payload?.archived === 'boolean' ? payload.archived : undefined,
    }),
  ledgerRuleList: () => ipcRenderer.invoke('ledger-rule-list'),
  ledgerRuleUpsert: (payload: any) =>
    ipcRenderer.invoke('ledger-rule-upsert', {
      id: optNum(payload?.id) ?? 0,
      name: optStr(payload?.name, 100) ?? '',
      basis: optStr(payload?.basis, 20) ?? '',
      shopIds: optIdList(payload?.shopIds, 200),
      ratios: optIdList(payload?.ratios, 200),
      note: optStr(payload?.note, 2000) ?? '',
    }),
  ledgerEntryList: (payload: any) =>
    ipcRenderer.invoke('ledger-entry-list', {
      period: optStr(payload?.period, 7) ?? '',
      from: optStr(payload?.from, 10) ?? '',
      to: optStr(payload?.to, 10) ?? '',
      kind: optStr(payload?.kind, 20) ?? '',
      scope: optStr(payload?.scope, 20) ?? '',
      shopId: optNum(payload?.shopId) ?? 0,
      partyId: optNum(payload?.partyId) ?? 0,
      categoryId: optNum(payload?.categoryId) ?? 0,
      settleStatus: optStr(payload?.settleStatus, 20) ?? 'all',
      includeVoid: payload?.includeVoid === true,
      keyword: optStr(payload?.keyword, 100) ?? '',
      limit: optNum(payload?.limit),
      offset: optNum(payload?.offset),
    }),
  ledgerEntryGet: (payload: any) =>
    ipcRenderer.invoke('ledger-entry-get', { id: optNum(payload?.id) ?? 0 }),
  ledgerEntryUpsert: (payload: any) =>
    ipcRenderer.invoke('ledger-entry-upsert', {
      id: optNum(payload?.id) ?? 0,
      bizDate: optStr(payload?.bizDate, 10),
      kind: optStr(payload?.kind, 20),
      scope: optStr(payload?.scope, 20),
      shopId: optNum(payload?.shopId),
      partyId: optNum(payload?.partyId),
      categoryId: optNum(payload?.categoryId),
      amountCents: optNum(payload?.amountCents),
      basis: optStr(payload?.basis, 20),
      ruleId: optNum(payload?.ruleId),
      method: optStr(payload?.method, 40),
      note: optStr(payload?.note, 2000),
      allocations: optAllocations(payload?.allocations),
    }),
  ledgerEntryVoid: (payload: any) =>
    ipcRenderer.invoke('ledger-entry-void', {
      id: optNum(payload?.id) ?? 0,
      reason: optStr(payload?.reason, 200) ?? '',
    }),
  ledgerEntryRestore: (payload: any) =>
    ipcRenderer.invoke('ledger-entry-restore', {
      id: optNum(payload?.id) ?? 0,
    }),
  // 批量作废（导入撤销）。导入本身上限 2000 行，这里给 4000 是为了**不在消毒层静默截断** ——
  // 真超限要让主进程的 `normalizeIdList` 报错，而不是悄悄少撤几条。
  ledgerEntriesVoid: (payload: any) =>
    ipcRenderer.invoke('ledger-entries-void', {
      ids: optIdList(payload?.ids, 4000),
      reason: optStr(payload?.reason, 200) ?? '',
    }),
  ledgerSummary: (payload: any) =>
    ipcRenderer.invoke('ledger-summary', {
      period: optStr(payload?.period, 7) ?? '',
      from: optStr(payload?.from, 10) ?? '',
      to: optStr(payload?.to, 10) ?? '',
    }),
  ledgerPartyList: (payload: any) =>
    ipcRenderer.invoke('ledger-party-list', {
      includeArchived: payload?.includeArchived === true,
      keyword: optStr(payload?.keyword, 100) ?? '',
    }),
  ledgerPartyUpsert: (payload: any) =>
    ipcRenderer.invoke('ledger-party-upsert', {
      id: optNum(payload?.id) ?? 0,
      name: optStr(payload?.name, 100) ?? '',
      kind: optStr(payload?.kind, 20) ?? '',
      phone: optStr(payload?.phone, 40),
      note: optStr(payload?.note, 2000),
      archived: typeof payload?.archived === 'boolean' ? payload.archived : undefined,
    }),
  ledgerPartyMerge: (payload: any) =>
    ipcRenderer.invoke('ledger-party-merge', {
      fromId: optNum(payload?.fromId) ?? 0,
      toId: optNum(payload?.toId) ?? 0,
      note: optStr(payload?.note, 2000) ?? '',
    }),
  ledgerPartyLedger: (payload: any) =>
    ipcRenderer.invoke('ledger-party-ledger', {
      includeArchived: payload?.includeArchived === true,
      partyId: optNum(payload?.partyId) ?? 0,
    }),
  ledgerSettleCreate: (payload: any) =>
    ipcRenderer.invoke('ledger-settle-create', {
      partyId: optNum(payload?.partyId) ?? 0,
      settleDate: optStr(payload?.settleDate, 10) ?? '',
      direction: optStr(payload?.direction, 20) ?? '',
      // 结算金额**不由前端传**：主进程按勾选的条目求和（唯一算法，结构上没有第二个数）
      entryIds: optIdList(payload?.entryIds, 500),
      method: optStr(payload?.method, 40) ?? '',
      note: optStr(payload?.note, 2000) ?? '',
    }),
  ledgerSettleList: (payload: any) =>
    ipcRenderer.invoke('ledger-settle-list', { partyId: optNum(payload?.partyId) ?? 0 }),
  ledgerSettleVoid: (payload: any) =>
    ipcRenderer.invoke('ledger-settle-void', {
      id: optNum(payload?.id) ?? 0,
      reason: optStr(payload?.reason, 200) ?? '',
    }),
  // ---- 记账 P4：批量变更相关人 / 单店 / 导出 ----
  ledgerEntryRepatchPreview: (payload: any) =>
    ipcRenderer.invoke('ledger-entry-repatch-preview', {
      entryIds: optIdList(payload?.entryIds, 500),
    }),
  ledgerEntryRepatch: (payload: any) =>
    ipcRenderer.invoke('ledger-entry-repatch', {
      entryIds: optIdList(payload?.entryIds, 500),
      toPartyId: optNum(payload?.toPartyId) ?? 0,
      mode: optStr(payload?.mode, 20) ?? '',
      reason: optStr(payload?.reason, 200) ?? '',
    }),
  ledgerShopBreakdown: (payload: any) =>
    ipcRenderer.invoke('ledger-shop-breakdown', {
      shopId: optNum(payload?.shopId) ?? 0,
      period: optStr(payload?.period, 7) ?? '',
      from: optStr(payload?.from, 10) ?? '',
      to: optStr(payload?.to, 10) ?? '',
    }),
  ledgerExportExcel: (payload: any) =>
    ipcRenderer.invoke('ledger-export-excel', {
      title: optStr(payload?.title, 60) ?? '',
      periodLabel: optStr(payload?.periodLabel, 40) ?? '',
      filterLabel: optStr(payload?.filterLabel, 200) ?? '',
      rows: sanitizeLedgerExportRows(payload?.rows),
      // 合计由渲染层传（与底部合计同源），本层不复算
      totalIncomeCents: optNum(payload?.totalIncomeCents) ?? 0,
      totalExpenseCents: optNum(payload?.totalExpenseCents) ?? 0,
      balanceCents: optNum(payload?.balanceCents) ?? 0,
      defaultName: optStr(payload?.defaultName, 120) ?? '',
    }),
  // ---- 记账 P5：Excel 批量导入 ----
  ledgerNameResolve: (payload: any) =>
    ipcRenderer.invoke('ledger-name-resolve', {
      party: optNameList(payload?.party),
      category: optNameList(payload?.category),
      shop: optNameList(payload?.shop),
    }),
  ledgerEntryBatchCreate: (payload: any) =>
    ipcRenderer.invoke('ledger-entry-batch-create', {
      entries: sanitizeLedgerImportEntries(payload?.entries),
    }),
  ledgerImportTemplate: (payload: any) =>
    ipcRenderer.invoke('ledger-import-template', {
      sheets: sanitizeLedgerTemplateSheets(payload?.sheets),
      defaultName: optStr(payload?.defaultName, 120) ?? '',
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
  // 清理不被数据库引用的孤儿图片文件（重置/批次覆盖后残留）
  orderCleanupOrphanImages: () => ipcRenderer.invoke('order-cleanup-orphan-images'),
  // 产品库导入「图片」列：读取用户指定的本地图片（任意路径，仅图片扩展名，≤10MB）
  orderReadLocalImage: (localPath: string) =>
    ipcRenderer.invoke('order-read-local-image', {
      localPath: String(localPath ?? '').slice(0, 4096),
    }),
  orderExportExcel: (buffer: ArrayBuffer, defaultName?: string) =>
    ipcRenderer.invoke('order-export-excel', { buffer, defaultName }),
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
  // 命名板（P3）：按 listing 分组的色键，未命名在前。
  // `importDate` = 这一批的导入日（与「待核对」同一批）；不传 = 不筛。
  orderVariantNaming: (payload?: { importDate?: string }) =>
    ipcRenderer.invoke('order-variant-naming', payload),
  // 给一个款色起名（命名板唯一的写入口）。⚠️ 只送 id + 名字：
  // 款名 / 款编码 / 平台原文都由主进程回读，界面送过来的只能是"要改成什么"。
  orderVariantRename: (payload: any) =>
    ipcRenderer.invoke('order-variant-rename', {
      styleColorId: typeof payload?.styleColorId === 'number' ? payload.styleColorId : 0,
      name: typeof payload?.name === 'string' ? payload.name.slice(0, 80) : '',
    }),
  // 款的基本信息（命名板组头）：款名 + 厂家一次保存。只送 id 与"要改成什么"，
  // 当前值由主进程回读（避免界面拿旧值覆盖别人的改动）。
  // `supplierId` 缺省 = 不动；`0` 是合法的"清空厂家"。
  orderStyleBasics: (payload: any) =>
    ipcRenderer.invoke('order-style-basics', {
      styleId: typeof payload?.styleId === 'number' ? payload.styleId : 0,
      ...(typeof payload?.name === 'string' ? { name: payload.name.slice(0, 80) } : {}),
      ...(typeof payload?.supplierId === 'number' ? { supplierId: payload.supplierId } : {}),
    }),
  // 删除款式（款编码）：级联删款色、图片解除归属、订单保留
  orderStyleDelete: (payload: any) =>
    ipcRenderer.invoke('order-style-delete', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  // 款合并候选 + 已合并记录（拿货页「这几个款可能是同一件货」）
  orderStyleMergeBoard: () => ipcRenderer.invoke('order-style-merge-board'),
  // 合并：一次 N→1。⚠️ 源款 id 去重 + 剔掉目标自己在这里做一遍，
  // 主进程还会再做一遍 —— 界面这层只是让"手滑把目标当源送出去"不会变成一次空写。
  orderStyleMerge: (payload: any) => {
    const target = typeof payload?.targetStyleId === 'number' ? payload.targetStyleId : 0;
    const sources = Array.isArray(payload?.sourceStyleIds)
      ? [
          ...new Set(
            payload.sourceStyleIds.filter(
              (n: unknown) => typeof n === 'number' && n > 0 && n !== target
            )
          ),
        ].slice(0, 50)
      : [];
    return ipcRenderer.invoke('order-style-merge', {
      targetStyleId: target,
      sourceStyleIds: sources,
    });
  },
  // 拆开一次合并（按批次 id，不是行 id：一次 N→1 写 N 行）
  orderStyleUnmerge: (payload: any) =>
    ipcRenderer.invoke('order-style-unmerge', {
      batchId: typeof payload?.batchId === 'string' ? payload.batchId.slice(0, 40) : '',
    }),
  // 手动归并款式：订单图片挂到指定款编码 + 记入附加指纹（后续自动识别命中同一款编码）
  // ⭐ 送**款编码**（不是 id）：下拉的数据源是产品库全集，手工新建的款在识别池里可能还没有行，
  //    主进程按编码 `ensureStyleByCode` 补占位款。`styleId` 兼容老形状，照旧透传。
  orderStyleAssign: (payload: any) =>
    ipcRenderer.invoke('order-style-assign', {
      orderId: typeof payload?.orderId === 'number' ? payload.orderId : 0,
      styleId: typeof payload?.styleId === 'number' ? payload.styleId : 0,
      styleCode: typeof payload?.styleCode === 'string' ? payload.styleCode.slice(0, 64) : '',
      color: typeof payload?.color === 'string' ? payload.color : '',
      fingerprint: typeof payload?.fingerprint === 'string' ? payload.fingerprint : '',
    }),
  // 全库重放已确认映射（`dryRun` 只报数不改库）：修「映射在、订单没吃到」的历史漏网
  orderReplayMappings: (payload: any) =>
    ipcRenderer.invoke('order-replay-mappings', {
      dryRun: payload?.dryRun === true,
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
  // 退回待核对（归类核对页「已核对」范围里的行内动作）：把已核对的行置回 corrected=0。
  // ⚠️ 入参只有裸数组（**没有** mark-corrected 那样的 { all } 形态）：退回一律点名，
  //    没有"全部退回"这条路（口径见 order-db.ts 的 reopenOrdersCorrected 注释）。
  orderReopenCorrected: (ids: any) =>
    ipcRenderer.invoke('order-reopen-corrected', {
      ids: Array.isArray(ids)
        ? ids
            .filter((n: any) => typeof n === 'number' && Number.isInteger(n) && n > 0)
            .slice(0, 10000)
        : [],
    }),
  // --- 速卖通利润追踪（M0：入站走 localhost 接收端，本区仅查询类 IPC）---
  aeDbEnsure: () => ipcRenderer.invoke('ae-db-ensure'),
  aeReceiverStatus: () => ipcRenderer.invoke('ae-receiver-status'),
  // ⚠️ 2026-10-21（C2）：`aeCostMap*` 四条随 ae_cost_map 退役删除（成本真源 = 产品行 + 订单明细行）。
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
      // 包价单已删（2026-10-20）：建单只有明细一种形态，mode/totalCents 不再透传
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
              purchaseSize: typeof s?.purchaseSize === 'string' ? s.purchaseSize.slice(0, 50) : '',
              qty: typeof s?.qty === 'number' ? Math.max(1, Math.round(s.qty)) : 1,
            }))
            .slice(0, 100000)
        : undefined,
    }),
  purchaseOrderUpdate: (payload: any) =>
    ipcRenderer.invoke('purchase-order-update', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
      bizDate: typeof payload?.bizDate === 'string' ? payload.bizDate.slice(0, 10) : undefined,
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
  purchaseTaken: () => ipcRenderer.invoke('purchase-taken'),
  purchaseOrderCoverage: () => ipcRenderer.invoke('purchase-order-coverage'),
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
  // 编辑器行图：按款色批量取本地图路径（**顺序与入参一致**，未命中为 null）
  purchaseStyleImages: (payload: any) =>
    ipcRenderer.invoke('purchase-style-images', {
      items: Array.isArray(payload?.items)
        ? payload.items.slice(0, 500).map((it: any) => ({
            styleCode: typeof it?.styleCode === 'string' ? it.styleCode.slice(0, 50) : '',
            color: typeof it?.color === 'string' ? it.color.slice(0, 50) : '',
            // ⚠️ `size` 必须透传：主进程按「款色+尺码」挑该行自己那件的图；
            // 漏掉它 ⇒ 同款所有行回落到同一张（用户报的"图片都是一样的"）。
            size: typeof it?.size === 'string' ? it.size.slice(0, 50) : '',
            // 款色 id（身份）：有它主进程就按 id 取图 —— 色名被改写后仍能取到（2026-10-20）
            styleColorId: typeof it?.styleColorId === 'number' ? it.styleColorId : 0,
          }))
        : [],
    }),
  // 「色未定」修复的候选色：按款编码列出该款真实存在的色行（`{ [款编码大写]: [{id,color,hasImage}] }`）
  purchaseStyleColors: (payload: any) =>
    ipcRenderer.invoke('purchase-style-colors', {
      styleCodes: Array.isArray(payload?.styleCodes)
        ? payload.styleCodes
            .slice(0, 500)
            .map((c: any) => (typeof c === 'string' ? c.slice(0, 50) : ''))
        : [],
    }),
  // 款色改名（产品侧改色名 ⇒ 订单侧的色行跟着改标签；款色 id / 编码 / 绑定的图不动）。
  // 少了它：产品抽屉里改个色名，色图（按「款编码 + 色名」查）就再也找不到 ⇒ 重开抽屉图变空。
  styleColorRename: (payload: any) =>
    ipcRenderer.invoke('style-color-rename', {
      productId: Number(payload?.productId) || 0,
      styleCode: typeof payload?.styleCode === 'string' ? payload.styleCode.slice(0, 64) : '',
      from: typeof payload?.from === 'string' ? payload.from.slice(0, 50) : '',
      to: typeof payload?.to === 'string' ? payload.to.slice(0, 50) : '',
    }),
  // ---- 店铺账号管家（以「店铺套 · 邮箱」为单位的店群账号维护；密码经主进程 safeStorage 加密落库，渲染层不存明文）----
  shopAccountDbEnsure: () => ipcRenderer.invoke('shop-account-db-ensure'),
  shopAccountList: (payload: any) => {
    const filter: Record<string, unknown> = {
      search: typeof payload?.search === 'string' ? payload.search.slice(0, 200) : '',
      status: typeof payload?.status === 'string' ? payload.status.slice(0, 20) : '',
    };
    // 0 是有效筛选值（未关联企业 / 未使用工具账号），不能用 `|| 0` 压掉缺省
    for (const key of ['companyId', 'ziniaoAccountId', 'erpAccountId']) {
      const value = payload?.[key];
      if (typeof value === 'number' && Number.isInteger(value) && value >= 0) {
        filter[key] = Math.min(value, 2147483647);
      }
    }
    return ipcRenderer.invoke('shop-account-list', filter);
  },
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
  // ---- 工具账号（紫鸟 / ERP 共用一个形状；一条登录一份密码，多店共享）----
  toolAccountList: (payload: any) =>
    ipcRenderer.invoke('tool-account-list', {
      kind: typeof payload?.kind === 'string' ? payload.kind.slice(0, 20) : '',
    }),
  toolAccountUpsert: (payload: any) =>
    ipcRenderer.invoke('tool-account-upsert', sanitizeToolAccountInput(payload)),
  toolAccountDelete: (payload: any) =>
    ipcRenderer.invoke('tool-account-delete', { id: Number(payload?.id) || 0 }),
  toolAccountReveal: (payload: any) =>
    ipcRenderer.invoke('tool-account-reveal', { id: Number(payload?.id) || 0 }),
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
  // ---- 主数据字典（颜色 / 尺码）----
  // 颜色工作台（SKU 矩阵）与归类页的色卡从这里取"现有的颜色"。其余写入仍走业务写路径
  // （建 SKU / 认款时由主进程 `ensureColorId` / `ensureSizeId` 顺带补字典）；
  // 唯一例外是「＋ 新增颜色」—— 只写 `md_colors`，不给任何款加色（主进程 `md-color-create`）。
  mdColorList: () => ipcRenderer.invoke('md-color-list'),
  mdColorCreate: (payload: any) =>
    ipcRenderer.invoke('md-color-create', {
      name: typeof payload?.name === 'string' ? payload.name.slice(0, 40) : '',
      hex: typeof payload?.hex === 'string' ? payload.hex.slice(0, 20) : '',
    }),
  // 只改色块 hex，不改名字（名字是业务身份）。空串 = 这个色没有标准色值。
  mdColorUpdateHex: (payload: any) =>
    ipcRenderer.invoke('md-color-update-hex', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
      hex: typeof payload?.hex === 'string' ? payload.hex.slice(0, 20) : '',
    }),
  // 颜色管理（「基础数据 › 产品管理 › 颜色」）：板 = 字典 ∪ 业务表里出现过的色名 + 用量；
  // 合并会**真改业务数据**（款色 / SKU / 别名归到保留色），见主进程 `color-merge.ts`。
  mdColorBoard: () => ipcRenderer.invoke('md-color-board'),
  mdColorMerge: (payload: any) =>
    ipcRenderer.invoke('md-color-merge', {
      source: typeof payload?.source === 'string' ? payload.source.slice(0, 40) : '',
      target: typeof payload?.target === 'string' ? payload.target.slice(0, 40) : '',
    }),
  mdSizeList: () => ipcRenderer.invoke('md-size-list'),
  productList: (payload: any) =>
    ipcRenderer.invoke('product-list', {
      search: typeof payload?.search === 'string' ? payload.search.slice(0, 200) : '',
      status: typeof payload?.status === 'string' ? payload.status.slice(0, 20) : '',
      supplierId: typeof payload?.supplierId === 'number' ? payload.supplierId : 0,
      withoutSupplier: payload?.withoutSupplier === true,
      onlyMissingWeight: payload?.onlyMissingWeight === true,
      onlyMissingCost: payload?.onlyMissingCost === true,
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
      // 进价只白名单数字：**不传**表示"不修改"，传了非法类型同样按"不修改"处理
      // （主进程侧 `upsertProduct` 对缺省是保留语义，见其注释）
      ...(typeof payload?.costCents === 'number' ? { costCents: payload.costCents } : {}),
    }),
  productDelete: (payload: any) =>
    ipcRenderer.invoke('product-delete', {
      id: typeof payload?.id === 'number' ? payload.id : 0,
    }),
  // 只改「当前进价」（分；0 = 清空）。非数字不传 ⇒ 主进程按非法入参拒绝（不会静默清 0）
  productCostSet: (payload: any) =>
    ipcRenderer.invoke('product-cost-set', {
      code: typeof payload?.code === 'string' ? payload.code.slice(0, 64) : '',
      ...(typeof payload?.costCents === 'number' ? { costCents: payload.costCents } : {}),
    }),
  /** 有当前进价的款编码集合（缺口卡用） */
  productPricedCodes: () => ipcRenderer.invoke('product-priced-codes'),
  /**
   * 亚洲款加码：一次取回「款 → 偏移」与「款 → 码链」。
   * `codes` = 本次清单涉及的款编码（码链只按这批取，不做全库预取）。
   */
  productSizeShiftLoad: (payload: any) =>
    ipcRenderer.invoke('product-size-shift-load', {
      codes: Array.isArray(payload?.codes)
        ? payload.codes.filter((c: any) => typeof c === 'string' && c.trim()).slice(0, 500)
        : [],
    }),
  /** 设/撤一款的加码偏移（0 = 撤）；`shift` 非数字不传 ⇒ 主进程按非法入参拒绝 */
  productSizeShiftSet: (payload: any) =>
    ipcRenderer.invoke('product-size-shift-set', {
      styleCode: typeof payload?.styleCode === 'string' ? payload.styleCode.slice(0, 64) : '',
      ...(typeof payload?.shift === 'number' ? { shift: payload.shift } : {}),
      ...(typeof payload?.note === 'string' ? { note: payload.note.slice(0, 200) } : {}),
    }),
  productSummary: () => ipcRenderer.invoke('product-summary'),
  productNextCode: () => ipcRenderer.invoke('product-next-code'),
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
            /**
             * 供应商**原文**（2026-10-10 新增）。
             *
             * 为什么必须带它：`supplierId` 只在"库里已有这个名字"时非 0；名字对不上时它是 0，
             * 主进程就再也看不到用户到底写了哪家 —— 于是"按名称查找、不存在就新建"这条
             * 根本无从执行（漏了这个字段的症状正是"供应商没有写入"，且**不报错**）。
             */
            supplierRaw: typeof r?.supplierRaw === 'string' ? r.supplierRaw.slice(0, 100) : '',
            // 类目**不在这里**：模板与导出都没有这一列，库层对已存在的产品原样保留（见 product-db）。
            status: typeof r?.status === 'string' ? r.status.slice(0, 20) : 'active',
            note: typeof r?.note === 'string' ? r.note.slice(0, 2000) : '',
            skus: Array.isArray(r?.skus)
              ? r.skus.slice(0, 500).map((s: any) => ({
                  color: typeof s?.color === 'string' ? s.color.slice(0, 40) : '',
                  size: typeof s?.size === 'string' ? s.size.slice(0, 40) : '',
                  weightG:
                    typeof s?.weightG === 'number' && Number.isFinite(s.weightG)
                      ? Math.round(s.weightG)
                      : 0,
                }))
              : [],
            imageId:
              typeof r?.imageId === 'number' && Number.isInteger(r.imageId) && r.imageId > 0
                ? r.imageId
                : 0,
            /**
             * 手工进价（**分**；2026-10-10 补）。
             *
             * ⚠️ 这一格曾经被这段白名单**静默丢掉** —— 渲染层照发、`src/types.ts` 也声明了，
             *    唯独这里没抄进来，于是主进程 `typeof r.costCents === 'number'` 恒为假、
             *    进价一条都写不进库，而界面上没有任何报错（症状：进价没有入库）。
             * 形状口径：`null`/缺省 = 这行没填 ⇒ **不修改**库内已有价（不是 0）。
             */
            costCents:
              typeof r?.costCents === 'number' && Number.isFinite(r.costCents)
                ? Math.round(r.costCents)
                : null,
          }))
        : [],
      mode: payload?.mode === 'insertOnly' ? 'insertOnly' : 'upsert',
    }),
  // 导入侧：抽 xlsx 里的**嵌入图**（渲染层的 SheetJS 读不到浮动图，只能主进程用 exceljs）
  productExtractImages: (payload: any) =>
    ipcRenderer.invoke('product-extract-images', {
      buffer: payload?.buffer,
      sheetName: typeof payload?.sheetName === 'string' ? payload.sheetName.slice(0, 120) : '',
      headerRow:
        typeof payload?.headerRow === 'number' && Number.isFinite(payload.headerRow)
          ? Math.max(0, Math.floor(payload.headerRow))
          : 0,
    }),
  // 导出侧：**不再传 buffer** —— 渲染层给"每格写什么 + 每行的图路径"，主进程用 exceljs
  // 生成并嵌图（嵌入图要写 xl/drawings + 关系 + 内容类型，SheetJS 写不了）。
  // `headers` 空 = 无效载荷，由主进程返回 `{success:false}`（这里不塞默认表头，否则
  // "传错了"会变成一个"表头是空的、但导出成功"的文件）。
  productExport: (payload: any) =>
    ipcRenderer.invoke('product-export', {
      sheetName: typeof payload?.sheetName === 'string' ? payload.sheetName.slice(0, 31) : '',
      headers: Array.isArray(payload?.headers)
        ? payload.headers
            .slice(0, 64)
            .map((h: any) => (typeof h === 'string' ? h.slice(0, 60) : ''))
        : [],
      rows: Array.isArray(payload?.rows)
        ? payload.rows.slice(0, 20000).map((r: any) => ({
            cells: Array.isArray(r?.cells)
              ? r.cells.slice(0, 64).map((c: any) => (typeof c === 'string' ? c : String(c ?? '')))
              : [],
            imagePath: typeof r?.imagePath === 'string' ? r.imagePath.slice(0, 1024) : '',
          }))
        : [],
      imageColumn:
        typeof payload?.imageColumn === 'number' && Number.isFinite(payload.imageColumn)
          ? Math.max(0, Math.floor(payload.imageColumn))
          : 0,
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
      productId: typeof payload?.productId === 'number' ? payload.productId : 0,
    }),
  productSkuSummary: () => ipcRenderer.invoke('product-sku-summary'),
  productSkuQueue: (payload: any) =>
    ipcRenderer.invoke('product-sku-queue', {
      limit: typeof payload?.limit === 'number' ? payload.limit : undefined,
      maxRows: typeof payload?.maxRows === 'number' ? payload.maxRows : undefined,
    }),
  productSkuMap: (payload: any) =>
    ipcRenderer.invoke('product-sku-map', {
      // 缺省**采纳**（直接认款就该顺手补图）；显式 `false` 才关掉 ——
      // 只有「建档并关联」向导在用户取消勾选「采纳为款主图」时会传 false。
      // 不能用 `=== true`：老调用方不传这个键，把缺省读成 false 会让补图静默失效。
      adoptImages: payload?.adoptImages === false ? false : true,
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
  // 存量补图：非法/缺省的 limit 传 0 —— 主进程按 0 回落默认上限（不在这里猜一个数，
  // 上限只归主进程一处，渲染层写死第二份迟早对不上）
  productSkuRepairImages: (payload: any) =>
    ipcRenderer.invoke('product-sku-repair-images', {
      limit: Number.isFinite(Number(payload?.limit)) ? Number(payload?.limit) : 0,
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
  // 按款编码改厂家（拣货宫格拖拽的写入口；supplierId: 0 = 清空关联，合法目标值）
  productMoveSupplier: (payload: any) =>
    ipcRenderer.invoke('product-move-supplier', {
      code: typeof payload?.code === 'string' ? payload.code.slice(0, 64).trim() : '',
      supplierId: typeof payload?.supplierId === 'number' ? payload.supplierId : 0,
    }),
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
        ? payload.itemIds
            .slice(0, 1000)
            .map((x: any) => (typeof x === 'string' ? x.slice(0, 64) : ''))
        : [],
    }),
  // ---- 店铺实体（sk_shops / sk_name_map；DOMAIN_INTEGRATION_PLAN S1）----
  // 补上"店铺"这个缺失的实体层：历史文本（订单 / 采购两处）不改写，靠名称归一映射旁挂关联。
  shopDbEnsure: () => ipcRenderer.invoke('shop-db-ensure'),
  shopList: (payload: any) =>
    ipcRenderer.invoke('shop-list', {
      offset: Number(payload?.offset) || 0,
      limit: Number(payload?.limit) || 50,
      search: typeof payload?.search === 'string' ? payload.search.slice(0, 200) : '',
      platform: typeof payload?.platform === 'string' ? payload.platform.slice(0, 40) : '',
      status: typeof payload?.status === 'string' ? payload.status.slice(0, 20) : '',
    }),
  shopGet: (payload: any) => ipcRenderer.invoke('shop-get', { id: Number(payload?.id) || 0 }),
  // 局部更新：缺省键不出现（`undefined` = 保持原值），否则编辑店铺地址会把账号列清空
  shopUpsert: (payload: any) => {
    const out: Record<string, unknown> = { id: Number(payload?.id) || 0 };
    for (const [key, max] of [
      ['platform', 40],
      ['name', 200],
      ['platformShopId', 100],
      ['shopUrl', 500],
      ['site', 40],
      ['status', 20],
      ['openedAt', 40],
      ['note', 2000],
    ] as const) {
      if (typeof payload?.[key] === 'string') out[key] = payload[key].slice(0, max);
    }
    if (
      typeof payload?.score === 'number' &&
      Number.isFinite(payload.score) &&
      payload.score >= 0
    ) {
      out.score = Math.min(payload.score, 2147483647);
    }
    return ipcRenderer.invoke('shop-upsert', out);
  },
  shopItemsList: (payload: any) =>
    ipcRenderer.invoke('shop-items-list', {
      // shopId 三态原样传（缺省 = 不过滤 / ≤0 = 「未登记」桶 / >0 = 指定店）：
      // `Number(x) || 0` 会把「没传」压成 0 ⇒ 列表只在未登记桶里翻，匹配到店的采集行一条都不显示。
      shopId: Number.isFinite(Number(payload?.shopId)) ? Number(payload?.shopId) : undefined,
      search: typeof payload?.search === 'string' ? payload.search.slice(0, 200) : '',
      page: Number(payload?.page) || 0,
      pageSize: Number(payload?.pageSize) || 50,
      onlyUnconfirmed: payload?.onlyUnconfirmed === true,
      // 0 / 缺省 / NaN 一律 undefined（0 不是"没认款的款"）；负数由主进程再挡一次
      productId: Number(payload?.productId) || undefined,
    }),
  shopItemsSummary: () => ipcRenderer.invoke('shop-items-summary'),
  shopItemsImport: (payload: any) =>
    ipcRenderer.invoke('shop-items-import', {
      shopId: Number(payload?.shopId) || 0,
      ids: Array.isArray(payload?.ids) ? payload.ids.slice(0, 500) : [],
    }),
  // 删一条采集行（按行 id；不联动删认款映射 —— 快照与人的决定是两套）
  shopItemsDelete: (payload: any) =>
    ipcRenderer.invoke('shop-items-delete', { id: Number(payload?.id) || 0 }),
  shopItemImageFetch: (payload: any) =>
    ipcRenderer.invoke('shop-item-image-fetch', {
      id: Number(payload?.id) || 0,
      productId: Number(payload?.productId) || 0,
      // 色→图 1:1；同色只发第一条（主进程再按业务口径去重一次）
      adoptMain: payload?.adoptMain === true,
      colors: Array.isArray(payload?.colors)
        ? payload.colors
            .map((c: any) => ({
              color: typeof c?.color === 'string' ? c.color.slice(0, 100) : '',
              imageUrl: typeof c?.imageUrl === 'string' ? c.imageUrl.slice(0, 1000) : '',
            }))
            .filter((c: any) => !!c.color && !!c.imageUrl)
        : [],
    }),
  // ---- 图案槽位域（POD；M3/M4 —— 绑定台 / 报单 / 余量看板）----
  // 这里只做**形状裁剪**（类型/长度/条数上限）；业务口径校验一律在主进程（AGENTS §2.3 双防线）。
  // `variantKey` 内含 `\u0000`，**原样透传**（不 trim、不按分隔符切）。
  podWorklist: (payload: any) =>
    ipcRenderer.invoke('pod-worklist', {
      filter: typeof payload?.filter === 'string' ? payload.filter.slice(0, 20) : 'all',
      search: typeof payload?.search === 'string' ? payload.search.slice(0, 60) : '',
      page: Number(payload?.page) || 0,
      pageSize: Number(payload?.pageSize) || 24,
    }),
  podPatternList: (payload: any) =>
    ipcRenderer.invoke('pod-pattern-list', {
      search: typeof payload?.search === 'string' ? payload.search.slice(0, 60) : '',
      status: typeof payload?.status === 'string' ? payload.status.slice(0, 20) : '',
    }),
  podPatternCreate: (payload: any) =>
    ipcRenderer.invoke('pod-pattern-create', {
      code: typeof payload?.code === 'string' ? payload.code.slice(0, 60) : '',
      name: typeof payload?.name === 'string' ? payload.name.slice(0, 120) : '',
      artworkImageId: Number(payload?.artworkImageId) || 0,
      previewImageId: Number(payload?.previewImageId) || 0,
      note: typeof payload?.note === 'string' ? payload.note.slice(0, 500) : '',
      source: typeof payload?.source === 'string' ? payload.source.slice(0, 20) : '',
      // 识别图：指纹是"这张图只属于一个图案"的唯一身份，原样透传（校验在主进程）
      images: Array.isArray(payload?.images)
        ? payload.images.slice(0, 200).map((i: any) => ({
            fingerprint:
              typeof i?.fingerprint === 'string'
                ? i.fingerprint.trim().toLowerCase().slice(0, 128)
                : '',
            imageId: Number(i?.imageId) || 0,
          }))
        : [],
    }),
  podPatternUpdate: (payload: any) =>
    ipcRenderer.invoke('pod-pattern-update', {
      id: Number(payload?.id) || 0,
      // 只透传**出现过的键**：`undefined` = 不改，`''` = 清空（两者必须能分开）
      ...(typeof payload?.name === 'string' ? { name: payload.name.slice(0, 120) } : {}),
      ...(payload?.artworkImageId !== undefined
        ? { artworkImageId: Number(payload.artworkImageId) || 0 }
        : {}),
      ...(payload?.previewImageId !== undefined
        ? { previewImageId: Number(payload.previewImageId) || 0 }
        : {}),
      ...(typeof payload?.note === 'string' ? { note: payload.note.slice(0, 500) } : {}),
      ...(typeof payload?.status === 'string' ? { status: payload.status.slice(0, 20) } : {}),
    }),
  // 图片落库：本地选图 / 远程色图 → md_images（只透传来源，路径校验在主进程）
  podPatternImage: (payload: any) =>
    ipcRenderer.invoke('pod-pattern-image', {
      srcPath: typeof payload?.srcPath === 'string' ? payload.srcPath.slice(0, 1024) : '',
      url: typeof payload?.url === 'string' ? payload.url.slice(0, 1024) : '',
    }),
  // 批量颜色图（下载 + 感知哈希/主色）：单批上限与主进程一致
  podSlotImages: (payload: any) =>
    ipcRenderer.invoke('pod-slot-images', {
      urls: Array.isArray(payload?.urls)
        ? payload.urls
            .filter((u: any) => typeof u === 'string' && u.trim())
            .map((u: string) => u.trim().slice(0, 1024))
            .slice(0, 40)
        : [],
    }),
  podBind: (payload: any) =>
    ipcRenderer.invoke('pod-bind', {
      patternId: Number(payload?.patternId) || 0,
      source: typeof payload?.source === 'string' ? payload.source.slice(0, 20) : 'manual',
      state: typeof payload?.state === 'string' ? payload.state.slice(0, 20) : 'bound',
      slots: Array.isArray(payload?.slots)
        ? payload.slots.slice(0, 200).map((s: any) => ({
            variantKey: typeof s?.variantKey === 'string' ? s.variantKey : '',
            imageKey: typeof s?.imageKey === 'string' ? s.imageKey.slice(0, 80) : '',
            skuCode: typeof s?.skuCode === 'string' ? s.skuCode.slice(0, 80) : '',
          }))
        : [],
    }),
  podUnbind: (payload: any) =>
    ipcRenderer.invoke('pod-unbind', {
      keys: Array.isArray(payload?.keys)
        ? payload.keys.filter((k: any) => typeof k === 'string' && k).slice(0, 200)
        : [],
    }),
  // 按款色 / 订单图片认图案：指纹与款色 id 原样透传（格式校验、上限、图案是否可挂都在主进程）
  podImageLink: (payload: any) =>
    ipcRenderer.invoke('pod-image-link', {
      patternId: Number(payload?.patternId) || 0,
      source: typeof payload?.source === 'string' ? payload.source.slice(0, 20) : 'manual',
      styleColorIds: Array.isArray(payload?.styleColorIds)
        ? payload.styleColorIds
            .map((n: any) => Number(n) || 0)
            .filter((n: number) => n > 0)
            .slice(0, 500)
        : [],
      images: Array.isArray(payload?.images)
        ? payload.images.slice(0, 200).map((i: any) => ({
            fingerprint:
              typeof i?.fingerprint === 'string'
                ? i.fingerprint.trim().toLowerCase().slice(0, 128)
                : '',
            imageId: Number(i?.imageId) || 0,
          }))
        : [],
    }),
  podImageUnlink: (payload: any) =>
    ipcRenderer.invoke('pod-image-unlink', {
      fingerprints: Array.isArray(payload?.fingerprints)
        ? payload.fingerprints
            .filter((f: any) => typeof f === 'string' && f)
            .map((f: string) => f.trim().toLowerCase().slice(0, 128))
            .slice(0, 200)
        : [],
      styleColorIds: Array.isArray(payload?.styleColorIds)
        ? payload.styleColorIds
            .map((n: any) => Number(n) || 0)
            .filter((n: number) => n > 0)
            .slice(0, 500)
        : [],
    }),
  podPatternMerge: (payload: any) =>
    ipcRenderer.invoke('pod-pattern-merge', {
      targetId: Number(payload?.targetId) || 0,
      sourceIds: Array.isArray(payload?.sourceIds)
        ? payload.sourceIds
            .map((n: any) => Number(n) || 0)
            .filter((n: number) => n > 0)
            .slice(0, 50)
        : [],
    }),
  podPatternMergeUndo: (payload: any) =>
    ipcRenderer.invoke('pod-pattern-merge-undo', {
      batchId: typeof payload?.batchId === 'string' ? payload.batchId.slice(0, 64) : '',
    }),
  podPatternMergeHistory: (payload: any) =>
    ipcRenderer.invoke('pod-pattern-merge-history', {
      limit: Number(payload?.limit) || 50,
    }),
  podNeedData: () => ipcRenderer.invoke('pod-need-data'),
  podReportExport: (payload: any) =>
    ipcRenderer.invoke('pod-report-export', {
      rows: Array.isArray(payload?.rows)
        ? payload.rows.slice(0, 500).map((r: any) => ({
            patternId: Number(r?.patternId) || 0,
            code: typeof r?.code === 'string' ? r.code.slice(0, 60) : '',
            name: typeof r?.name === 'string' ? r.name.slice(0, 120) : '',
            artworkImageId: Number(r?.artworkImageId) || 0,
            previewImageId: Number(r?.previewImageId) || 0,
            needPieces: Number(r?.needPieces) || 0,
            remainingPieces: Number(r?.remainingPieces) || 0,
            netNeed: Number(r?.netNeed) || 0,
            sheets: Number(r?.sheets) || 0,
          }))
        : [],
      date: typeof payload?.date === 'string' ? payload.date.slice(0, 10) : '',
      piecesPerSheet: Number(payload?.piecesPerSheet) || 1,
      unboundPieces: Number(payload?.unboundPieces) || 0,
      unboundRows: Number(payload?.unboundRows) || 0,
      assumedRows: Number(payload?.assumedRows) || 0,
    }),
  podBatchList: (payload: any) =>
    ipcRenderer.invoke('pod-batch-list', {
      patternId: Number(payload?.patternId) || 0,
      limit: Number(payload?.limit) || 200,
    }),
  podBatchCreate: (payload: any) =>
    ipcRenderer.invoke('pod-batch-create', {
      patternId: Number(payload?.patternId) || 0,
      sheets: Number(payload?.sheets) || 0,
      piecesPerSheet: Number(payload?.piecesPerSheet) || 0,
      supplier: typeof payload?.supplier === 'string' ? payload.supplier.slice(0, 120) : '',
      costCents: Number(payload?.costCents) || 0,
      orderedAt: typeof payload?.orderedAt === 'string' ? payload.orderedAt.slice(0, 10) : '',
      note: typeof payload?.note === 'string' ? payload.note.slice(0, 500) : '',
      arrive: payload?.arrive === true,
    }),
  podBatchArrive: (payload: any) =>
    ipcRenderer.invoke('pod-batch-arrive', { batchId: Number(payload?.batchId) || 0 }),
  podPrint: (payload: any) =>
    ipcRenderer.invoke('pod-print', {
      patternId: Number(payload?.patternId) || 0,
      pieces: Number(payload?.pieces) || 0,
      refOrderItemId: Number(payload?.refOrderItemId) || 0,
    }),
  podAdjust: (payload: any) =>
    ipcRenderer.invoke('pod-adjust', {
      batchId: Number(payload?.batchId) || 0,
      deltaPieces: Number(payload?.deltaPieces) || 0,
      note: typeof payload?.note === 'string' ? payload.note.slice(0, 200) : '',
    }),
  podBalance: () => ipcRenderer.invoke('pod-balance'),
  // 订阅「采集已入库」事件（主进程→渲染层单向，接收端写库后广播）；返回退订函数
  onAeItemsIngested: (cb: (payload: any) => void) => {
    const listener = (_event: any, payload: any) => {
      if (cb) cb(payload);
    };
    ipcRenderer.on('ae-items-ingested', listener);
    return () => {
      ipcRenderer.removeListener('ae-items-ingested', listener);
    };
  },
  // 订阅「芒果订单已同步」事件（`/mango/ingest` 处理完成后广播）；返回退订函数
  onMangoIngested: (cb: (payload: any) => void) => {
    const listener = (_event: any, payload: any) => {
      if (cb) cb(payload);
    };
    ipcRenderer.on('mango-ingested', listener);
    return () => {
      ipcRenderer.removeListener('mango-ingested', listener);
    };
  },
  shopSummary: () => ipcRenderer.invoke('shop-summary'),
  shopUnmapped: () => ipcRenderer.invoke('shop-unmapped'),
  // 门 1（店铺归一）—— 只读派生，无入参
  shopGate: () => ipcRenderer.invoke('shop-gate'),
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
      shopId: Number(payload?.shopId) || 0,
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
  // 待办归集：三类（罚单/纠纷·仲裁/订单关闭）按订单号合并；筛选只认 accountIds
  mailTodoList: (payload: any) =>
    ipcRenderer.invoke('mail-todo-list', {
      accountIds: Array.isArray(payload?.accountIds)
        ? payload.accountIds.map((n: any) => Math.trunc(Number(n) || 0)).filter((n: number) => n > 0).slice(0, 200)
        : [],
    }),
  // 手工划掉 / 撤销一条待办：key 是订单号（解析不出单号时是 #messageId），只做形状消毒
  mailTodoDismiss: (payload: any) =>
    ipcRenderer.invoke('mail-todo-dismiss', {
      key: String(payload?.key || '').slice(0, 64),
      messageId: Math.max(0, Math.trunc(Number(payload?.messageId) || 0)),
      kind: String(payload?.kind || '').slice(0, 24),
    }),
  mailTodoRestore: (payload: any) =>
    ipcRenderer.invoke('mail-todo-restore', { key: String(payload?.key || '').slice(0, 64) }),
  // 自动收信间隔下发：预加载层只收形（0–1440 的整数）；非法值原样透传，由主进程显式报错
  // —— 不能在这里兜成 0，那会把"参数传错"伪装成"用户选择了关闭"
  mailAutoSyncConfig: (payload: any) => {
    const raw = Number(payload?.minutes);
    return ipcRenderer.invoke('mail-auto-sync-config', {
      minutes: Number.isFinite(raw) ? Math.min(1440, Math.max(0, Math.round(raw))) : null,
    });
  },
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
  // 订阅「打开某个模块」意图（通知点击等用户不在界面前的入口）；返回退订函数。
  // 只收形：moduleId/action 一律截断成字符串，业务校验在渲染层（模块存在与否由外壳判）。
  onOpenModule: (cb: (payload: any) => void) => {
    const listener = (_event: any, payload: any) => {
      if (!cb) return;
      cb({
        moduleId: typeof payload?.moduleId === 'string' ? payload.moduleId.slice(0, 60) : '',
        action: typeof payload?.action === 'string' ? payload.action.slice(0, 60) : undefined,
      });
    };
    ipcRenderer.on('open-module', listener);
    return () => {
      ipcRenderer.removeListener('open-module', listener);
    };
  },
  // 订阅侧栏徽标（主进程算好的未读数等）；count=null = 撤掉徽标，不是"显示 0"
  onNavBadge: (cb: (payload: any) => void) => {
    const listener = (_event: any, payload: any) => {
      if (!cb) return;
      const raw = payload?.count;
      const count =
        raw === null || raw === undefined || !Number.isFinite(Number(raw))
          ? null
          : Math.max(0, Math.floor(Number(raw)));
      cb({
        moduleId: typeof payload?.moduleId === 'string' ? payload.moduleId.slice(0, 60) : '',
        count,
        title: typeof payload?.title === 'string' ? payload.title.slice(0, 80) : undefined,
        todo: Boolean(payload?.todo),
      });
    };
    ipcRenderer.on('nav-badge', listener);
    return () => {
      ipcRenderer.removeListener('nav-badge', listener);
    };
  },
});
