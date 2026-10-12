// electron/order-handlers.ts
// 订单归类模块 IPC handler（electron/main.ts require 后自动生效）。
// 语义化通道 + 入参二次校验；不向渲染层透传 SQL（安全边界见 AGENTS.md §1.7 / 红线 3）。
// 职责：指纹查重 / 识别结果落库 / 订单入库 / 分组统计 / 主图下载与读取。

export {};

const { ipcMain, app, nativeImage, safeStorage } = require('electron');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { downloadFile } = require('./http-client');
const orderDb = require('./order-db');
const { register } = require('./ipc-util') as typeof import('./ipc-util');
const { isUserFileAllowed } = require('./user-file-allowlist') as typeof import('./user-file-allowlist');

/** 主图缓存目录：userData/order-images/ */
const IMAGE_DIR = () => path.join(app.getPath('userData'), 'order-images');

/**
 * 「导入日」过滤参数（`yyyy-mm-dd`，本地时区）—— **只放行这个形状**，其余一律当"不筛"。
 *
 * 为什么不透传给 SQL 一个任意字符串：这个值会进 `date(o.created_at) = ?` 的参数位，
 * 形状不收窄的话，一个 `'` 或者半截日期会变成"永远匹配不上"（= 静默空列表，
 * 用户读成"今天没导东西"）。宁可退化成全库，也不给一个看起来生效、其实筛空的过滤。
 */
function sanitizeImportDate(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^\d{4}-\d{2}-\d{2}$/.test(s) ? s : undefined;
}

// ---- 识别引擎 API Key 安全存储（P2）----
// 目标：API Key 是敏感凭据，不应随 config 以明文落 electron-store。
// 方案：主进程 safeStorage（macOS Keychain / Windows DPAPI）加密后写入 userData/secure/oi-api-key.bin；
//       safeStorage 不可用（如部分 Linux 无钥匙串服务）时降级为本地文件（Electron 官方建议降级策略），
//       保证跨平台可运行。渲染层仅经 IPC 读写，不落任何明文存储。
const API_KEY_FILE = () => path.join(app.getPath('userData'), 'secure', 'oi-api-key.bin');

function storeApiKey(key: string): boolean {
  try {
    const dir = path.dirname(API_KEY_FILE());
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    const data = safeStorage.isEncryptionAvailable()
      ? safeStorage.encryptString(key)
      : Buffer.from(key, 'utf8');
    fs.writeFileSync(API_KEY_FILE(), data);
    return true;
  } catch (e) {
    console.error('[order-handlers] store api key failed:', e);
    return false;
  }
}

function loadApiKey(): string {
  try {
    if (!fs.existsSync(API_KEY_FILE())) return '';
    const buf = fs.readFileSync(API_KEY_FILE());
    return safeStorage.isEncryptionAvailable() ? safeStorage.decryptString(buf) : buf.toString('utf8');
  } catch {
    return ''; // 解密失败（钥匙串迁移/不可用等）视为未配置，由用户重新填写
  }
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** URL 规范化指纹：仅保留协议+host+path（忽略 query/hash，同一张图不同参数签名视为同图） */
function fingerprintUrl(url: string): string {
  try {
    const u = new URL(url);
    return crypto.createHash('sha256').update(u.origin + u.pathname).digest('hex');
  } catch {
    return crypto.createHash('sha256').update(url).digest('hex');
  }
}

/** 文件内容指纹 SHA-256（字节级去重） */
function sha256File(filePath: string): string {
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

// 图片格式魔数嗅探 sniffImageFormat / IMG_EXT_BY_FORMAT 已收敛到 ./ipc-util（order/product 两域共用）。
const { sniffImageFormat, IMG_EXT_BY_FORMAT } = require('./ipc-util') as typeof import('./ipc-util');

// 幂等建表（模块首次使用时调用）
register('order-db-ensure', async () => {
  orderDb.ensureOrderSchema();
  return { success: true };
});

// 指纹查重：payload.fingerprint 为内容指纹或 URL 指纹，返回图片记录或 null
register('order-image-find', async (payload) => {
  orderDb.ensureOrderSchema();
  if (!isPlainObject(payload) || typeof payload.fingerprint !== 'string' || payload.fingerprint.length === 0) {
    return { success: false, error: 'invalid fingerprint' };
  }
  const found = orderDb.findImageByFingerprint(payload.fingerprint) || orderDb.findImageByUrlFingerprint(payload.fingerprint);
  if (!found) return { success: true, data: null };
  let result: any = undefined;
  if (found.resultJson) {
    try { result = JSON.parse(found.resultJson); } catch { /* 保留 undefined */ }
  }
  return { success: true, data: { ...found, result } };
});

// 保存识别结果：payload { id, status: 'done'|'error', resultJson?, error? }
register('order-image-save', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.id !== 'number') {
    return { success: false, error: 'invalid payload' };
  }
  const status = payload.status === 'done' || payload.status === 'error' ? payload.status : 'error';
  orderDb.updateImageResult(
    payload.id,
    status,
    typeof payload.resultJson === 'string' ? payload.resultJson : undefined,
    typeof payload.error === 'string' ? payload.error : undefined,
  );
  return { success: true };
});

// 插入订单：payload 见 src/types.ts OrderRecord（结构白名单字段）
// 幂等：同 订单号+图片 重复插入直接返回已有 id（避免重复导入产生重复行）
register('order-insert', async (payload) => {
  orderDb.ensureOrderSchema();
  // `imageId` 允许 **null**（S2-b 订单报表免图导入）：订单报表没有主图列，
  // 识别链只对有图的订单有意义；无图订单一律落 `image_id IS NULL`。
  const hasImage = payload.imageId === null || typeof payload.imageId === 'number';
  if (!isPlainObject(payload) || !hasImage) {
    return { success: false, error: 'invalid payload' };
  }
  const rec = {
    imageId: payload.imageId,
    orderNo: typeof payload.orderNo === 'string' ? payload.orderNo : '',
    shop: typeof payload.shop === 'string' ? payload.shop : '',
    size: typeof payload.size === 'string' ? payload.size : '',
    orderTime: typeof payload.orderTime === 'string' ? payload.orderTime : '',
    rawFields: isPlainObject(payload.rawFields) ? (payload.rawFields as Record<string, string>) : {},
    category: typeof payload.category === 'string' ? payload.category : '',
    color: typeof payload.color === 'string' ? payload.color : '',
    logo: typeof payload.logo === 'string' ? payload.logo : '',
  };
  const id = orderDb.insertOrder(rec);
  return { success: true, data: { id } };
});

// 分组统计：payload { dimensions: ['category','color','shop'] 子集 }
register('order-group-stats', async (payload) => {
  orderDb.ensureOrderSchema();
  const dims = Array.isArray(payload?.dimensions)
    ? payload.dimensions.filter((d: unknown) => typeof d === 'string')
    : ['category', 'color'];
  return { success: true, data: orderDb.groupStats(dims) };
});

// 订单列表（分页 + corrected 过滤 + 关键字搜索）：payload { offset?, limit?, corrected?, search? } → { rows, total }
register('order-list', async (payload) => {
  orderDb.ensureOrderSchema();
  const offset = typeof payload?.offset === 'number' ? Math.max(Math.round(payload.offset), 0) : 0;
  const limit = typeof payload?.limit === 'number' ? Math.min(Math.max(Math.round(payload.limit), 1), 2000) : 500;
  const corrected =
    payload?.corrected === true || payload?.corrected === false ? !!payload.corrected : undefined;
  const search = typeof payload?.search === 'string' ? payload.search.slice(0, 100) : undefined;
  return {
    success: true,
    data: orderDb.listOrdersPage({ offset, limit, corrected, search, importDate: sanitizeImportDate(payload?.importDate) }),
  };
});

// 清空订单与识别缓存
register('order-clear', async () => {
  orderDb.clearAll();
  return { success: true };
});

// 订单原始行（最小投影：id/order_no/raw_fields + shop/order_time/style_code/style_color；只读）——
// 供「按订单算运费/成本」宿主 op 提取 收货国家/商品ID 消费，大载荷不回渲染层/岛
// 订单归属店铺（实测 AE 导出按店铺、无店铺列 → 店铺由人指定；写 oi_orders.shop 原文）
register('order-assign-shop', async (payload) => {
  orderDb.ensureOrderSchema();
  const orderNos = Array.isArray(payload?.orderNos)
    ? payload.orderNos.slice(0, 2000).map((x: unknown) => (typeof x === 'string' ? x : ''))
    : [];
  const shopName = typeof payload?.shopName === 'string' ? payload.shopName.slice(0, 200) : '';
  if (!shopName.trim()) {
    return { success: false, error: 'order-assign-shop: shopName 不能为空' };
  }
  return { success: true, data: orderDb.assignShopToOrders(orderNos, shopName) };
});

register('order-shipping-rows', async (payload) => {
  orderDb.ensureOrderSchema();
  const limit = typeof payload?.limit === 'number' ? Math.min(Math.max(Math.round(payload.limit), 1), 2000) : 500;
  const src = payload?.source === 'import' || payload?.source === 'collect' ? payload.source : 'all';
  return {
    success: true,
    data: orderDb.shippingRows(limit, { source: src, importDate: sanitizeImportDate(payload?.importDate) }),
  };
});

// ---- 待识别队列（oi_queue）：导入行整批落库；失败/缺图重启不丢、可增量重试 ----

register('order-queue-enqueue', async (payload) => {
  orderDb.ensureOrderSchema();
  if (!isPlainObject(payload) || typeof payload.batchNo !== 'string' || !Array.isArray(payload.rows)) {
    return { success: false, error: 'invalid payload' };
  }
  const batchNo = payload.batchNo.slice(0, 64);
  const rows = payload.rows
    .slice(0, 50000)
    .map((r: unknown) => {
      const rec = isPlainObject(r) ? r : {};
      return {
        rawFields: isPlainObject(rec.rawFields) ? (rec.rawFields as Record<string, string>) : {},
        url: typeof rec.url === 'string' ? rec.url.slice(0, 8192) : '',
        orderNo: typeof rec.orderNo === 'string' ? rec.orderNo.slice(0, 128) : '',
        info: typeof rec.info === 'string' ? rec.info.slice(0, 500) : '',
      };
    })
    .filter((r: any) => typeof r.rawFields === 'object' && r.rawFields !== null);
  const count = orderDb.enqueueQueueRows(batchNo, rows);
  return { success: true, data: { count } };
});

register('order-queue-stats', async (payload) => {
  orderDb.ensureOrderSchema();
  if (!isPlainObject(payload) || typeof payload.batchNo !== 'string') {
    return { success: false, error: 'invalid payload' };
  }
  return { success: true, data: orderDb.queueStats(payload.batchNo) };
});

// 队列行分页：payload { batchNo, offset?, limit?, status?, missingOnly? } → { rows, total }
// 失败清单用 { status:'error' }，缺图清单用 { missingOnly:true }，不再整批过 IPC。
register('order-queue-list', async (payload) => {
  orderDb.ensureOrderSchema();
  if (!isPlainObject(payload) || typeof payload.batchNo !== 'string') {
    return { success: false, error: 'invalid payload' };
  }
  const offset = typeof payload.offset === 'number' ? Math.max(Math.round(payload.offset), 0) : 0;
  const limit = typeof payload.limit === 'number' ? Math.min(Math.max(Math.round(payload.limit), 0), 2000) : 0;
  const status =
    typeof payload.status === 'string' && ['pending', 'error', 'missing', 'done', 'all'].includes(payload.status)
      ? payload.status
      : undefined;
  const missingOnly = payload.missingOnly === true;
  return {
    success: true,
    data: orderDb.listQueueRowsPage(payload.batchNo, { offset, limit, status, missingOnly }),
  };
});

// 单行队列行（含 raw_fields）：补图/查看原始信息按需取，避免列表全量携带大字段
register('order-queue-get', async (payload) => {
  orderDb.ensureOrderSchema();
  if (!isPlainObject(payload) || typeof payload.id !== 'number') {
    return { success: false, error: 'invalid payload' };
  }
  const row = orderDb.getQueueRow(Math.round(payload.id));
  if (!row) return { success: false, error: 'row not found' };
  return { success: true, data: row };
});

register('order-queue-next-pending', async (payload) => {
  orderDb.ensureOrderSchema();
  if (
    !isPlainObject(payload) ||
    typeof payload.batchNo !== 'string' ||
    typeof payload.afterId !== 'number' ||
    typeof payload.limit !== 'number'
  ) {
    return { success: false, error: 'invalid payload' };
  }
  const afterId = Math.max(0, Math.floor(payload.afterId));
  const limit = Math.min(200, Math.max(1, Math.floor(payload.limit)));
  return { success: true, data: orderDb.nextPendingQueueRows(payload.batchNo, afterId, limit) };
});

register('order-queue-set-result', async (payload) => {
  orderDb.ensureOrderSchema();
  if (
    !isPlainObject(payload) ||
    typeof payload.id !== 'number' ||
    typeof payload.status !== 'string' ||
    !['done', 'error', 'missing'].includes(payload.status)
  ) {
    return { success: false, error: 'invalid payload' };
  }
  const error = typeof payload.error === 'string' ? payload.error.slice(0, 2000) : '';
  orderDb.setQueueRowResult(Math.floor(payload.id), payload.status as 'done' | 'error' | 'missing', error);
  return { success: true };
});

register('order-queue-patch', async (payload) => {
  orderDb.ensureOrderSchema();
  if (
    !isPlainObject(payload) ||
    typeof payload.id !== 'number' ||
    typeof payload.url !== 'string' ||
    !isPlainObject(payload.rawFields)
  ) {
    return { success: false, error: 'invalid payload' };
  }
  orderDb.patchQueueRow(Math.floor(payload.id), payload.url.slice(0, 8192), payload.rawFields as Record<string, string>);
  return { success: true };
});

register('order-queue-retry-errors', async (payload) => {
  orderDb.ensureOrderSchema();
  if (!isPlainObject(payload) || typeof payload.batchNo !== 'string') {
    return { success: false, error: 'invalid payload' };
  }
  const count = orderDb.retryQueueErrors(payload.batchNo);
  return { success: true, data: { count } };
});

register('order-queue-purge-done', async (payload) => {
  orderDb.ensureOrderSchema();
  if (!isPlainObject(payload) || typeof payload.batchNo !== 'string') {
    return { success: false, error: 'invalid payload' };
  }
  const count = orderDb.purgeDoneQueueRows(payload.batchNo);
  return { success: true, data: { count } };
});

register('order-queue-last-active', async () => {
  orderDb.ensureOrderSchema();
  const active = orderDb.lastActiveQueueBatch();
  return { success: true, data: active };
});

// 款式匹配/落库：payload { imageId, fingerprint, category, features[], color }
// fingerprint 由渲染层 src/lib/styleMatcher.ts 生成（归一化 品类+特征），主进程只做查/建
register('order-style-resolve', async (payload) => {
  if (!isPlainObject(payload)) return { success: false, error: 'invalid payload' };
  if (typeof payload.imageId !== 'number' || payload.imageId <= 0) {
    return { success: false, error: 'invalid imageId' };
  }
  if (typeof payload.fingerprint !== 'string' || payload.fingerprint.length === 0 || payload.fingerprint.length > 512) {
    return { success: false, error: 'invalid fingerprint' };
  }
  const category = typeof payload.category === 'string' ? payload.category.slice(0, 50) : '';
  const color = typeof payload.color === 'string' ? payload.color.slice(0, 50) : '';
  const features = Array.isArray(payload.features)
    ? payload.features.filter((f: unknown): f is string => typeof f === 'string').map((f) => f.slice(0, 50)).slice(0, 20)
    : [];
  if (!category && features.length === 0) return { success: false, error: 'invalid recognition' };
  const styleName = typeof payload.styleName === 'string' ? payload.styleName.slice(0, 50) : '';
  orderDb.ensureOrderSchema();
  const res = orderDb.resolveStyle({
    fingerprint: payload.fingerprint,
    category,
    features,
    color,
    styleName: styleName || undefined,
  });
  orderDb.setImageStyleColor(payload.imageId, res.styleColorId);
  return { success: true, data: { styleCode: res.styleCode, styleColorCode: res.styleColorCode } };
});

// 款选项列表（「归属款」下拉的数据源）：**产品库驱动的全集**（含还没进识别链的手工新建款），
// 每项带可选颜色（产品库 SKU 颜色 + 识别链款色）。详见 `order-db.listStyles` 的注释。
register('order-style-list', async () => {
  orderDb.ensureOrderSchema();
  return { success: true, data: orderDb.listStyles() };
});

// 删除款式（款编码）：级联删款色、图片解除归属、订单保留。payload { id }
register('order-style-delete', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.id !== 'number' || payload.id <= 0) {
    return { success: false, error: 'invalid payload' };
  }
  orderDb.ensureOrderSchema();
  orderDb.deleteStyle(payload.id);
  return { success: true, data: { deleted: payload.id } };
});

// 手动归并款式：把订单图片挂到指定款编码的对应款色，并把订单指纹记入该款式的附加指纹表
// （解决同款衣服识别漂移产生多个款编码：归并后后续自动识别也能命中目标款编码）
// payload { orderId, styleCode, color, fingerprint? }（也接受老形状 { styleId } —— 宿主冒烟仍在用）
// ⭐ 款**按编码**认，不按 id：下拉的数据源是产品库（`listStyles`），手工新建、还没出过订单的款
//    在识别池里没有行，主进程要用 `ensureStyleByCode` 给它补一行占位款（见该函数注释）。
register('order-style-assign', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.orderId !== 'number' || payload.orderId <= 0) {
    return { success: false, error: 'invalid orderId' };
  }
  const styleId = typeof payload.styleId === 'number' && payload.styleId > 0 ? payload.styleId : 0;
  const styleCode = typeof payload.styleCode === 'string' ? payload.styleCode.slice(0, 64) : '';
  if (!styleId && !styleCode) {
    return { success: false, error: 'invalid styleCode' };
  }
  const color = typeof payload.color === 'string' ? payload.color.slice(0, 50) : '';
  const fingerprint = typeof payload.fingerprint === 'string' ? payload.fingerprint.slice(0, 512) : '';
  orderDb.ensureOrderSchema();
  try {
    const res = orderDb.assignOrderStyle({
      orderId: payload.orderId,
      styleId,
      styleCode,
      color,
      fingerprint: fingerprint || undefined,
    });
    // `skuBackfill` = ⭐ 人工核对的**回流**（这次点名顺带把「商品ID → 款+色」记进确定性层了吗）。
    // 它是**附加产物**：`status !== 'written'` 时归属照样是改成功的，界面必须把两者分开说，
    // 否则用户会把"没记住商品"读成"没保存"（见 `SkuBackfillOutcome` 的边界说明）。
    return {
      success: true,
      data: { styleCode: res.styleCode, styleColorCode: res.styleColorCode, skuBackfill: res.skuBackfill },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// 修改款式展示名（款编码级，全局生效；仅展示，不参与匹配）。payload { code, name }
register('order-style-rename', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.code !== 'string' || !payload.code) {
    return { success: false, error: 'invalid payload' };
  }
  const name = typeof payload.name === 'string' ? payload.name.slice(0, 50) : '';
  orderDb.ensureOrderSchema();
  try {
    orderDb.renameStyle(payload.code, name);
    return { success: true, data: { code: payload.code, name } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// 产品库 Excel 批量导入：payload { styles: StyleImportItem[] }
// 指纹由渲染层 src/lib/styleMatcher.ts 生成（与识别同算法），主进程只做查/建/冲突校验
register('order-style-import', async (payload) => {
  if (!isPlainObject(payload) || !Array.isArray(payload.styles) || payload.styles.length === 0) {
    return { success: false, error: 'invalid payload' };
  }
  if (payload.styles.length > 5000) {
    return { success: false, error: 'too many rows (max 5000)' };
  }
  const items = payload.styles
    .filter((s: unknown) => isPlainObject(s))
    .map((s: any) => ({
      code: typeof s.code === 'string' ? s.code.slice(0, 50) : '',
      name: typeof s.name === 'string' ? s.name.slice(0, 50) : '',
      color: typeof s.color === 'string' ? s.color.slice(0, 50) : '',
      fingerprint: typeof s.fingerprint === 'string' ? s.fingerprint.slice(0, 512) : '',
      extraFingerprints: Array.isArray(s.extraFingerprints)
        ? s.extraFingerprints
            .filter((f: unknown): f is string => typeof f === 'string')
            .map((f: string) => f.slice(0, 512))
            .slice(0, 20)
        : [],
    }));
  orderDb.ensureOrderSchema();
  try {
    const res = orderDb.importStyles(items);
    return { success: true, data: res };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// 订单字段纠正（数据纠正步骤）：payload { id, category, color, logo, fingerprint?, features?, reclassify }
// reclassify=true 且 fingerprint 非空时，主进程按新款指纹重新匹配款式/款色并挂接图片
register('order-update', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.id !== 'number' || payload.id <= 0) {
    return { success: false, error: 'invalid payload' };
  }
  orderDb.ensureOrderSchema();
  const data = orderDb.updateOrder({
    id: payload.id,
    category: typeof payload.category === 'string' ? payload.category.slice(0, 100) : '',
    color: typeof payload.color === 'string' ? payload.color.slice(0, 100) : '',
    logo: typeof payload.logo === 'string' ? payload.logo.slice(0, 100) : '',
    fingerprint:
      typeof payload.fingerprint === 'string' && payload.fingerprint.length > 0 && payload.fingerprint.length <= 512
        ? payload.fingerprint
        : undefined,
    features: Array.isArray(payload.features)
      ? payload.features.filter((f: unknown): f is string => typeof f === 'string').map((f) => f.slice(0, 50)).slice(0, 20)
      : [],
    reclassify: payload.reclassify === true,
  });
  return { success: true, data };
});

// 订单发货状态更新（订单明细行内切换）：payload { id, status: 'pending'|'shipped' }
register('order-update-status', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.id !== 'number' || payload.id <= 0) {
    return { success: false, error: 'invalid payload' };
  }
  orderDb.ensureOrderSchema();
  const status = payload.status === 'shipped' ? 'shipped' : 'pending';
  orderDb.updateOrderStatus(payload.id, status);
  return { success: true, data: { status } };
});

// 批量标记订单已核对（数据纠正页「确认无误」/「全部确认无误」）：payload { ids: number[] } 或 { all: true }
// 不修改识别字段，仅置 corrected=1 使订单离开待纠正列表；all 由主进程一次 UPDATE 全量标记，
// 避免大批量下把数万 id 经 IPC 传回。
register('order-mark-corrected', async (payload) => {
  orderDb.ensureOrderSchema();
  if (isPlainObject(payload) && payload.all === true) {
    const updated = orderDb.markAllOrdersCorrected();
    return { success: true, data: { updated } };
  }
  if (!isPlainObject(payload) || !Array.isArray(payload.ids)) {
    return { success: false, error: 'invalid payload' };
  }
  const ids = payload.ids
    .filter((n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0)
    .slice(0, 10000);
  if (!ids.length) return { success: false, error: 'empty ids' };
  const updated = orderDb.markOrdersCorrected(ids);
  return { success: true, data: { updated } };
});

// 退回待核对（归类核对页「已核对」范围里的行内动作）：payload { ids: number[] }
// 与 order-mark-corrected 互为**镜像**（那边置 corrected=1，这边置 0），但**只有点名这一条路**：
// 没有 `{ all: true }` 分支 —— 一次退回整批已核对的行不可逆，且用户看不出退回了多少
// （口径见 order-db.ts 的 reopenOrdersCorrected 注释）。
// 校验与 mark-corrected 的同段代码**刻意各写一遍**而不是抽公共函数：两边过滤规则相同是巧合，
// 而"哪天退回要收窄适用范围（比如只允许退今天的行）"时，共享实现会把两件事绑在一起。
register('order-reopen-corrected', async (payload) => {
  orderDb.ensureOrderSchema();
  if (!isPlainObject(payload) || !Array.isArray(payload.ids)) {
    return { success: false, error: 'invalid payload' };
  }
  const ids = payload.ids
    .filter((n: unknown): n is number => typeof n === 'number' && Number.isInteger(n) && n > 0)
    .slice(0, 10000);
  if (!ids.length) return { success: false, error: 'empty ids' };
  const updated = orderDb.reopenOrdersCorrected(ids);
  return { success: true, data: { updated } };
});

// 删除订单（订单明细行操作）：payload { id }
register('order-delete', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.id !== 'number' || payload.id <= 0) {
    return { success: false, error: 'invalid payload' };
  }
  orderDb.ensureOrderSchema();
  orderDb.deleteOrder(payload.id);
  return { success: true, data: { deleted: payload.id } };
});

// 下载主图：payload { url } → 下载并写入指纹库（pending 态），返回图片记录
// 去重：URL 指纹 / 内容指纹任一命中即复用，不重复下载、不重复识别
register('order-download-image', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.url !== 'string' || payload.url.length === 0 || payload.url.length > 8192) {
    return { success: false, error: 'invalid url' };
  }
  orderDb.ensureOrderSchema();
  const url = payload.url;
  const urlFp = fingerprintUrl(url);
  const existing = orderDb.findImageByUrlFingerprint(urlFp);
  if (existing) {
    let result: any = undefined;
    if (existing.resultJson) {
      try { result = JSON.parse(existing.resultJson); } catch { /* ignore */ }
    }
    return { success: true, data: { ...existing, result } };
  }

  const dir = IMAGE_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const tmpPath = path.join(dir, urlFp + '.img');
  const r = await downloadFile(url, tmpPath);
  if (!r.ok) return { success: false, error: r.error || 'download failed' };
  const fingerprint = sha256File(tmpPath);
  const buf = fs.readFileSync(tmpPath);
  const fmt = sniffImageFormat(buf);
  if (!fmt) {
    // 下载内容不是受支持的图片（或下载到了错误页/防盗链占位），不落盘避免垃圾入库
    fs.unlinkSync(tmpPath);
    return { success: false, error: 'unsupported image format' };
  }
  const finalPath = path.join(dir, fingerprint + IMG_EXT_BY_FORMAT[fmt]);
  if (fs.existsSync(finalPath)) {
    fs.unlinkSync(tmpPath); // 同图不同 URL：内容已存在，丢弃临时文件
  } else {
    fs.renameSync(tmpPath, finalPath);
  }

  const byContent = orderDb.findImageByFingerprint(fingerprint);
  if (byContent) {
    // 同图不同 URL：复用既有记录（含识别状态 / 款色归属 styleColorId / 识别结果），不再落新行
    let result: any = undefined;
    if (byContent.resultJson) {
      try { result = JSON.parse(byContent.resultJson); } catch { /* ignore */ }
    }
    return { success: true, data: { ...byContent, result } };
  }
  const id = orderDb.insertImage({ fingerprint, urlFingerprint: urlFp, sourceUrl: url, localPath: finalPath, status: 'pending' });
  return { success: true, data: { id, fingerprint, urlFingerprint: urlFp, sourceUrl: url, localPath: finalPath, status: 'pending' as const } };
});

// 导出 Excel：渲染层用 xlsx 生成 buffer，经保存对话框落盘
// payload { buffer: ArrayBuffer, defaultName?: string }
ipcMain.handle('order-export-excel', async (event: any, payload: any) => {
  try {
    if (!isPlainObject(payload) || !(payload.buffer instanceof ArrayBuffer)) {
      return { success: false, error: 'invalid payload' };
    }
    const win = event.sender
      ? require('electron').BrowserWindow.fromWebContents(event.sender)
      : null;
    const result = await require('electron').dialog.showSaveDialog(win, {
      title: '导出订单归类结果',
      defaultPath: path.join(app.getPath('downloads'), String(payload.defaultName || '订单归类汇总.xlsx')),
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, error: 'User canceled' };
    fs.writeFileSync(result.filePath, Buffer.from(payload.buffer));
    return { success: true, data: { filePath: result.filePath } };
  } catch (err: any) {
    return { success: false, error: err.message || 'Unknown error' };
  }
});

// 读图：payload { localPath } → { mime, dataUrl }（base64，供渲染层 <img> 展示）
// 安全：仅允许应用自有图片缓存目录（order-images / product-images）内的图片文件，防止任意文件读取。
// product-images 是产品库图片（pl_images）的落盘目录 —— 展示复用同一套读图/缩略图通道，
// 目录白名单在这里收敛为一份（新增缓存目录时加进 IMAGE_CACHE_DIRS 即可，别在 handler 里散写字面量）。
const IMAGE_CACHE_DIRS = new Set(['order-images', 'product-images']);
const IMAGE_EXT_OK = new Set(['.jpg', '.jpeg', '.png', '.webp']);
// 注意：dev（seller-kit）与打包版（SellerKit）的 userData 目录名不一致（连字符/大小写），
//       DB 中可能残留另一运行形态写入的绝对路径，不能依赖 userData 前缀 startsWith；
//       统一按缓存目录名 + realpath 归一化校验，跨运行形态兼容。
register('order-read-image', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.localPath !== 'string') {
    return { success: false, error: 'invalid path' };
  }
  const resolved = path.resolve(payload.localPath);
  let realResolved: string;
  try {
    realResolved = fs.realpathSync(resolved);
  } catch {
    return { success: false, error: 'file not found' };
  }
  // 文件必须直接位于图片缓存目录内（不允许子目录/越权路径）
  if (!IMAGE_CACHE_DIRS.has(path.basename(path.dirname(realResolved)).toLowerCase())) {
    return { success: false, error: 'path not allowed' };
  }
  // 仅允许图片扩展名
  if (!IMAGE_EXT_OK.has(path.extname(realResolved).toLowerCase())) {
    return { success: false, error: 'path not allowed' };
  }
  const buf = fs.readFileSync(realResolved);
  // MIME 按内容魔数定（不能按扩展名：历史上 WebP 内容曾落 .jpg 名，错名会渲染空白）
  const fmt = sniffImageFormat(buf);
  if (!fmt) return { success: false, error: 'invalid image' };
  const mime = fmt === 'jpeg' ? 'image/jpeg' : fmt === 'png' ? 'image/png' : 'image/webp';
  return { success: true, data: { mime, dataUrl: `data:${mime};base64,${buf.toString('base64')}` } };
});

// 缩略图：payload { localPath, maxEdge? } → { dataUrl }（JPEG data URL）
// 主进程 nativeImage 解码后按最长边等比缩至 maxEdge（≤160px 展示级清晰度），
// 供表格/封面/产品库等小尺寸展示，避免整张原图（可至 MB 级）反复过 IPC。
// 本地 LRU 缓存 key: realPath|maxEdge；安全校验与 order-read-image 一致（仅 order-images 目录）。
const thumbCache = new Map<string, string>();
const THUMB_CACHE_MAX = 200;
/** 批量缩略图单次往返上限（超出拆批；渲染层合批窗口为 1 帧，同屏可见图通常远小于此值） */
const THUMB_BATCH_MAX = 40;

/** 单张缩略图（含本地 LRU）：realResolved 需已通过目录/扩展名校验；解码/缩放失败返回 null */
function thumbDataUrl(realResolved: string, maxEdge: number): string | null {
  const cacheKey = `${realResolved}|${maxEdge}`;
  const hit = thumbCache.get(cacheKey);
  if (hit) {
    thumbCache.delete(cacheKey);
    thumbCache.set(cacheKey, hit); // 触碰 LRU
    return hit;
  }
  try {
    const buf = fs.readFileSync(realResolved);
    const fmt = sniffImageFormat(buf);
    // WebP：nativeImage.createFromBuffer 不支持解码（isEmpty），且 WebP 本身已压缩、
    // 同尺寸下体积远小于 JPEG/PNG 原图——直接原样返回（渲染层 <img> 原生支持 webp），
    // 不再缩放（主进程无 WebP 解码能力，硬缩放需引入编解码依赖，收益不抵复杂度）。
    if (fmt === 'webp') {
      const dataUrl = `data:image/webp;base64,${buf.toString('base64')}`;
      cacheThumb(cacheKey, dataUrl);
      return dataUrl;
    }
    const img = nativeImage.createFromBuffer(buf);
    if (img.isEmpty()) return null;
    const size = img.getSize();
    let out = img;
    if (size.width > maxEdge || size.height > maxEdge) {
      const scale = maxEdge / Math.max(size.width, size.height);
      out = img.resize({
        width: Math.max(1, Math.round(size.width * scale)),
        height: Math.max(1, Math.round(size.height * scale)),
      });
    }
    const dataUrl = `data:image/jpeg;base64,${out.toJPEG(80).toString('base64')}`;
    cacheThumb(cacheKey, dataUrl);
    return dataUrl;
  } catch {
    return null;
  }
}

/** 写入缩略图 LRU（超限淘汰最久未用项） */
function cacheThumb(cacheKey: string, dataUrl: string) {
  thumbCache.set(cacheKey, dataUrl);
  if (thumbCache.size > THUMB_CACHE_MAX) {
    const oldest = thumbCache.keys().next().value;
    if (oldest) thumbCache.delete(oldest);
  }
}

/** 路径校验：realpath 后必须位于图片缓存目录且为允许的图片扩展名；失败返回 null */
function resolveThumbPath(localPath: string): string | null {
  try {
    const realResolved = fs.realpathSync(path.resolve(localPath));
    if (!IMAGE_CACHE_DIRS.has(path.basename(path.dirname(realResolved)).toLowerCase())) return null;
    if (!IMAGE_EXT_OK.has(path.extname(realResolved).toLowerCase())) return null;
    return realResolved;
  } catch {
    return null;
  }
}

/** 单张缩略图（单发场景保留，行为与批量完全一致） */
register('order-image-thumb', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.localPath !== 'string') {
    return { success: false, error: 'invalid path' };
  }
  const realResolved = resolveThumbPath(payload.localPath);
  if (!realResolved) return { success: false, error: 'path not allowed' };
  const maxEdge = typeof payload.maxEdge === 'number'
    ? Math.min(Math.max(Math.round(payload.maxEdge), 16), 256)
    : 160;
  const dataUrl = thumbDataUrl(realResolved, maxEdge);
  return dataUrl
    ? { success: true, data: { dataUrl } }
    : { success: false, error: 'invalid image' };
});

// 批量缩略图：payload { items: [{ localPath, maxEdge }] } → { dataUrls: (string|null)[] }
// 渲染层把同一帧内多张可见图（订单列表/纠正行/封面/产品库）合并为一次 IPC 往返，消除逐张单发；
// 返回顺序与 items 一致，单项路径无效/解码失败置 null（不拖垮整批，调用方按需跳过）。
register('order-image-thumb-batch', async (payload) => {
  if (!isPlainObject(payload) || !Array.isArray(payload.items)) {
    return { success: false, error: 'invalid items' };
  }
  const items = payload.items.slice(0, THUMB_BATCH_MAX);
  const dataUrls: (string | null)[] = [];
  for (const item of items) {
    if (!isPlainObject(item) || typeof item.localPath !== 'string') {
      dataUrls.push(null);
      continue;
    }
    const realResolved = resolveThumbPath(item.localPath);
    if (!realResolved) {
      dataUrls.push(null);
      continue;
    }
    const maxEdge = typeof item.maxEdge === 'number'
      ? Math.min(Math.max(Math.round(item.maxEdge), 16), 256)
      : 160;
    dataUrls.push(thumbDataUrl(realResolved, maxEdge));
  }
  return { success: true, data: { dataUrls } };
});

// ---- API Key 安全存取（P2）：渲染层只传明文、只收明文，加密落盘全部在主进程 ----
register('order-api-key-set', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.apiKey !== 'string' || payload.apiKey.length > 1024) {
    return { success: false, error: 'invalid apiKey' };
  }
  const key = payload.apiKey.trim();
  return storeApiKey(key)
    ? { success: true, data: { stored: key.length > 0 } }
    : { success: false, error: 'store api key failed' };
});

register('order-api-key-get', async () => {
  return { success: true, data: { apiKey: loadApiKey() } };
});

// 孤图清理（P2）：扫描 order-images 目录，删除不被 oi_images / oi_queue 引用的图片文件
// （重置数据/批次覆盖/换图等会留下已入库但行被删的文件；正常下载的图均有 DB 引用，不会误删）。
register('order-cleanup-orphan-images', async () => {
  try {
    const dir = IMAGE_DIR();
    if (!fs.existsSync(dir)) return { success: true, data: { deleted: 0, freedBytes: 0 } };
    const refs = new Set<string>();
    for (const p of orderDb.listImageLocalPaths()) {
      if (p) refs.add(path.basename(p)); // dev/打包形态 userData 前缀不同，按文件名判定引用
    }
    let deleted = 0;
    let freedBytes = 0;
    for (const name of fs.readdirSync(dir)) {
      if (refs.has(name)) continue;
      const full = path.join(dir, name);
      let size = 0;
      try {
        const st = fs.statSync(full);
        if (!st.isFile()) continue;
        size = st.size;
      } catch {
        continue;
      }
      fs.unlinkSync(full);
      deleted += 1;
      freedBytes += size;
    }
    return { success: true, data: { deleted, freedBytes } };
  } catch (e: any) {
    return { success: false, error: e?.message || 'cleanup failed' };
  }
});

// 读用户指定的本地图片（产品库导入「图片」列用）：payload { localPath } → { mime, dataUrl }
// 读取「产品库导入」图片列里的本地图片路径。
//
// 安全（H-02）：仅图片扩展名 + 文件存在 + ≤10MB 之外，另加「用户已选文件」白名单。
// 原注释称"该文件是用户在导入对话框主动选择的本地产品图"，与实现不符：
// 路径实际来自**用户导入的 Excel 单元格内容**（旧版 store.readImageForImport(raw) 的 `raw`）。
// 也就是说，一份表格里的文本就能驱动宿主去读本机任意图片并以 base64 回吐 —— 这属于
// 由数据（而非用户动作）决定的读取范围，必须收回。现收紧为：只读用户经对话框真实选过的文件。
// 若将来确实需要"表格里写本地图片路径"，正确做法是给 dialog.openFile 增加一个 image 类型
// （由用户确认），而不是放宽这里的判据。
register('order-read-local-image', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.localPath !== 'string' || payload.localPath.length === 0 || payload.localPath.length > 4096) {
    return { success: false, error: 'invalid path' };
  }
  if (!isUserFileAllowed(payload.localPath)) {
    return { success: false, error: 'path not allowed' };
  }
  const ext = path.extname(payload.localPath).toLowerCase();
  if (ext !== '.jpg' && ext !== '.jpeg' && ext !== '.png' && ext !== '.webp' && ext !== '.bmp') {
    return { success: false, error: 'path not allowed' };
  }
  let buf: Buffer;
  try {
    const st = fs.statSync(payload.localPath);
    if (!st.isFile()) return { success: false, error: 'file not found' };
    if (st.size > 10 * 1024 * 1024) return { success: false, error: 'file too large (≤10MB)' };
    buf = fs.readFileSync(payload.localPath);
  } catch {
    return { success: false, error: 'file not found' };
  }
  // MIME 按内容魔数定（扩展名可能不可信）；bmp 无标准魔数探测，按扩展名兜底
  const fmt = sniffImageFormat(buf);
  const mime = fmt === 'jpeg' ? 'image/jpeg' : fmt === 'png' ? 'image/png' : fmt === 'webp' ? 'image/webp' : ext === '.bmp' ? 'image/bmp' : null;
  if (!mime) return { success: false, error: 'invalid image' };
  return { success: true, data: { mime, dataUrl: `data:${mime};base64,${buf.toString('base64')}` } };
});
