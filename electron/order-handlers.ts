// electron/order-handlers.ts
// 订单归类模块 IPC handler（electron/main.ts require 后自动生效）。
// 语义化通道 + 入参二次校验；不向渲染层透传 SQL（安全边界见 AGENTS.md §1.7 / 红线 3）。
// 职责：图片指纹查重 / 款色归属落库 / 订单入库 / 分组统计 / 主图下载与读取 / 包裹。

export {};

// 只借类型（擦除后不留运行时依赖）：包裹入参（`ParcelInput`）的白名单字段形状只有数据层那一份。
import type { ParcelInput } from './order-db';

const { ipcMain, app, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
// ⚠️ `as typeof import(...)` 不是装饰：不加它这里是 `any`，`orderDb` 的签名怎么变都不报错
// （跨文件 require 没进过类型检查）。见 `scripts/check-cross-domain-edges.mjs` 规则 A。
const orderDb = require('./order-db') as typeof import('./order-db');
const mangoSync = require('./mango-sync') as typeof import('./mango-sync');
const { register } = require('./ipc-util') as typeof import('./ipc-util');
const { isUserFileAllowed } = require('./user-file-allowlist') as typeof import('./user-file-allowlist');

// 主图缓存目录 `IMAGE_DIR` 由 ./order-image-land 提供（见下方 require，避免两处各定义一份）。

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

/** 订单发生月（`yyyy-mm`）；形状不对 → 不筛（与 `importDate` 同策略：宁可全库，不给假筛选） */
function sanitizePeriod(v: unknown): string | undefined {
  const s = typeof v === 'string' ? v.trim() : '';
  return /^\d{4}-\d{2}$/.test(s) ? s : undefined;
}

// ---- 识别引擎 API Key 安全存储（P2）已于 2026-10-28 删除 ----
// 原实现在 userData/secure/oi-api-key.bin 存云端 VLM 的 API Key。识别链（`readEngine` /
// `recognizeOrder` / `src/core/ai` / 「设置 › 识别」）同一轮一起删掉（用户决定不接云端模型），
// 单独留一个"能存 Key 但没人用"的通道只会让人以为还有识别功能。判断见
// `docs/notes/2026-10-30-order-classify-panel.md`。

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

// 图片格式魔数嗅探 sniffImageFormat / IMG_EXT_BY_FORMAT 已收敛到 ./ipc-util（order/product 两域共用）。
const { sniffImageFormat } = require('./ipc-util') as typeof import('./ipc-util');

// 「远程图 → 图片主数据（`md_images`）」的落库实现收敛到 ./order-image-land（订单主图 / 采集色图共用一份）：
// 色图要靠**内容指纹命中**才能在订单导入后被"按图找到颜色"，两份实现迟早分叉（P0-1 的教训）。
// 本文件不再自带 fingerprintUrl / sha256File / 落盘去重，一律走它（字节落盘只有 `landImageBytes` 一处）。
const {
  ORDER_IMAGE_DIR: IMAGE_DIR,
  landOrderImageByUrl,
} = require('./order-image-land') as typeof import('./order-image-land');
const { allImageLocalPaths } = require('./master-data-db') as typeof import('./master-data-db');

// 幂等建表（模块首次使用时调用）
register('order-db-ensure', async () => {
  orderDb.ensureOrderSchema();
  return { success: true };
});

// 指纹查重与「保存识别结果」通道已在 R1 下线：图片不再有 `result_json`（识别流水线删于 D16），
// 图片记录只是 `md_images` 的一行（指纹 + 本地路径 + 来源），查找走 `order-download-image` 的去重逻辑。

// 插入订单：payload 见 src/types.ts OrderRecord（结构白名单字段）
// 幂等：同 订单号+图片 重复插入直接返回已有 id（避免重复导入产生重复行）
//
// `imageId` 允许 **null**（S2-b 订单报表免图导入）：订单报表没有主图列，识别链只对有图的订单有意义；
// 无图订单一律落 `image_id IS NULL`。
//
// ⚠️ 用**类型谓词**判，不要写 `const ok = v === null || typeof v === 'number'` 再 `if (!ok) return`：
// `payload.imageId` 是 `unknown`（`isPlainObject` 把它收窄成 `Record<string, unknown>`），而 TS **不能**
// 用排除法把 `unknown` 收窄（`!(v === null || typeof v === 'number')` 走完仍是 `unknown`）——
// 赋给 `OrderRecord.imageId`（`number | null`）就报 TS2345。谓词是正向收窄，能收干净，也不用 `as`。
function isOrderImageId(v: unknown): v is number | null {
  return v === null || typeof v === 'number';
}

register('order-insert', async (payload) => {
  orderDb.ensureOrderSchema();
  if (!isPlainObject(payload)) {
    return { success: false, error: 'invalid payload' };
  }
  const imageId = payload.imageId;
  if (!isOrderImageId(imageId)) {
    return { success: false, error: 'invalid payload' };
  }
  const rec = {
    imageId,
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
    data: orderDb.shippingRows(limit, {
      source: src,
      importDate: sanitizeImportDate(payload?.importDate),
      period: sanitizePeriod(payload?.period),
    }),
  };
});

// 最近一次芒果同步的状态（总览的采集状态条读它）。
//
// ⚠️ **这里不吞异常**：这一条存在的意义就是"发现同步失败"，它自己再静默变成 null，
//    「从来没同步过」与「读日志失败」就分不开了 —— 那正是这个功能要消灭的歧义。
register('mango-sync-status', async () => {
  try {
    return { success: true, data: mangoSync.lastMangoSync() };
  } catch (err: unknown) {
    const msg = err instanceof Error ? err.message : String(err);
    return { success: false, error: `读取同步状态失败：${msg}` };
  }
});

// ---- 包裹（阶段 B2）：一单多包 / 按商品行拆 / 拆合并行数量 ----
//
// 通道一律「一单一取、一写一返回」：拆包面板开着的时候，别人（另一个窗口）也可能在改同一单，
// 所以每次写成功都把**整单**最新状态返回，界面直接用返回值重绘，不自己拼"我以为的结果"。
// 校验（跨单/超拆）只在数据层做（`order-db.setParcelLineQty`），这里只收窄入参形状。

// 列表页的小徽标「拆包 ×N」：一次问一批单号，避免每行一个 IPC 往返
register('order-parcel-counts', async (payload) => {
  orderDb.ensureOrderSchema();
  if (!isPlainObject(payload) || !Array.isArray(payload.orderNos)) {
    return { success: false, error: 'invalid payload' };
  }
  const orderNos = payload.orderNos
    .filter((v: unknown): v is string => typeof v === 'string' && v.length > 0)
    .slice(0, 2000);
  return { success: true, data: orderDb.parcelCountByOrders(orderNos) };
});

// 利润页：一批订单的**包裹运费/重量合计**（有包裹时运费以它为准，不再按运价表估算）。
// 与 `order-parcel-counts` 同一套形状收缩：只收单号数组，SQL 在数据层。
register('order-parcel-totals', async (payload) => {
  orderDb.ensureOrderSchema();
  if (!isPlainObject(payload) || !Array.isArray(payload.orderNos)) {
    return { success: false, error: 'invalid payload' };
  }
  const orderNos = payload.orderNos
    .filter((v: unknown): v is string => typeof v === 'string' && v.length > 0)
    .slice(0, 2000);
  return { success: true, data: orderDb.parcelTotalsByOrders(orderNos) };
});

register('order-parcel-detail', async (payload) => {
  orderDb.ensureOrderSchema();
  if (!isPlainObject(payload) || typeof payload.orderNo !== 'string') {
    return { success: false, error: 'invalid payload' };
  }
  const orderNo = payload.orderNo.slice(0, 128);
  return { success: true, data: orderDb.parcelDetail(orderNo) };
});

register('order-parcel-create', async (payload) => {
  orderDb.ensureOrderSchema();
  if (!isPlainObject(payload) || typeof payload.orderNo !== 'string') {
    return { success: false, error: 'invalid payload' };
  }
  const r = orderDb.createParcel(parcelInputOf(payload));
  if (!r.ok) return { success: false, error: r.error || '新建包裹失败' };
  return { success: true, data: { id: r.id, ...orderDb.parcelDetail(String(payload.orderNo)) } };
});

register('order-parcel-update', async (payload) => {
  orderDb.ensureOrderSchema();
  if (!isPlainObject(payload) || typeof payload.id !== 'number') {
    return { success: false, error: 'invalid payload' };
  }
  const r = orderDb.updateParcel(parcelInputOf(payload));
  if (!r.ok) return { success: false, error: r.error || '保存包裹失败' };
  const orderNo = typeof payload.orderNo === 'string' ? payload.orderNo : '';
  return { success: true, data: orderNo ? orderDb.parcelDetail(orderNo) : null };
});

register('order-parcel-delete', async (payload) => {
  orderDb.ensureOrderSchema();
  if (!isPlainObject(payload) || typeof payload.id !== 'number') {
    return { success: false, error: 'invalid payload' };
  }
  const ok = orderDb.deleteParcel(payload.id);
  if (!ok) return { success: false, error: '包裹不存在（可能已被删除）' };
  const orderNo = typeof payload.orderNo === 'string' ? payload.orderNo : '';
  return { success: true, data: orderNo ? orderDb.parcelDetail(orderNo) : null };
});

// 设置「某行在这个包装几件」；`qty <= 0` = 从该包移除这一行
register('order-parcel-set-line', async (payload) => {
  orderDb.ensureOrderSchema();
  if (
    !isPlainObject(payload) ||
    typeof payload.parcelId !== 'number' ||
    typeof payload.orderItemId !== 'number' ||
    typeof payload.qty !== 'number'
  ) {
    return { success: false, error: 'invalid payload' };
  }
  const r = orderDb.setParcelLineQty(payload.parcelId, payload.orderItemId, payload.qty);
  if (!r.ok) return { success: false, error: r.error || '拆包失败' };
  const orderNo = typeof payload.orderNo === 'string' ? payload.orderNo : '';
  return { success: true, data: orderNo ? orderDb.parcelDetail(orderNo) : null };
});

/** 包裹入参收窄：只接白名单字段，字符串截断（长度上限与数据层一致，避免"界面能填、落库被截"）。 */
function parcelInputOf(p: Record<string, unknown>): ParcelInput {
  const str = (v: unknown, max: number) => (typeof v === 'string' ? v.slice(0, max) : undefined);
  const num = (v: unknown) => (v === null ? null : typeof v === 'number' && Number.isFinite(v) ? Math.round(v) : undefined);
  return {
    id: typeof p.id === 'number' ? p.id : undefined,
    orderNo: str(p.orderNo, 128),
    label: str(p.label, 40),
    trackingNo: str(p.trackingNo, 80),
    carrier: str(p.carrier, 40),
    note: str(p.note, 500),
    shipCents: num(p.shipCents),
    weightG: num(p.weightG),
  };
}

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

// 命名板（P3）：按 listing 分组的色键，未命名在前。**只读**。
// 2026-10-30：带上 `importDate`（与「待核对」**同一批**，口径同 `listPending`）。
//   为什么必须筛：`oi_variant_keys` 是**跨批次**的记忆，不筛就会把十几天累积的键全铺出来
//   （真库实测 59 个键、10 个 listing 横跨 10-05 → 10-28），而下面那张核对表只显示今天的导入日 ——
//   两处口径不一样时，人看到的"这一屏要起名的色"和"下面这批订单"对不上号。
//   空串 / 非法日期 = 不筛（订单库冒烟与历史调用走这条）。
register('order-variant-naming', async (payload) => {
  orderDb.ensureOrderSchema();
  const importDate =
    isPlainObject(payload) && typeof payload.importDate === 'string' ? payload.importDate : '';
  return { success: true, data: orderDb.variantNamingBoard(400, importDate) };
});

// 给一个款色起名：命名板唯一的写入口。payload { styleColorId, name }
// ⚠️ `ok:false` 也要回 `success:true`：拒绝的原因是**业务判断**（同款重名 / 空名），
//    不是通道失败。走 `success:false` 会让界面弹出"操作失败"并丢掉那句原话，
//    而用户需要知道的正是"为什么不能叫这个"。
register('order-variant-rename', async (payload) => {
  if (!isPlainObject(payload)) return { success: false, error: 'invalid payload' };
  orderDb.ensureOrderSchema();
  return { success: true, data: orderDb.renameStyleColor(payload.styleColorId as number, payload.name) };
});

// 款的基本信息（命名板组头）：款名 + 厂家一次保存。payload { styleId, name?, supplierId? }
// 为什么与改色名分成两个通道：色名写 `oi_style_colors`，款名/厂家写产品主数据
//   （`pl_products`，ADR-002 C1 的唯一权威）—— 一个通道写两张不同域的表，
//   迟早有人以为它只改了一边。
// ⚠️ 同 `order-variant-rename`：`ok:false` 也回 `success:true`，拒绝原因是业务判断。
register('order-style-basics', async (payload) => {
  if (!isPlainObject(payload)) return { success: false, error: 'invalid payload' };
  orderDb.ensureOrderSchema();
  return {
    success: true,
    data: orderDb.saveStyleBasics(payload.styleId as number, {
      name: payload.name,
      supplierId: payload.supplierId,
    }),
  };
});

// 合并候选 + 已合并记录（拿货页「这几个款可能是同一件货」）。payload 无
register('order-style-merge-board', async () => {
  orderDb.ensureOrderSchema();
  return { success: true, data: orderDb.styleMergeBoard() };
});

// 合并款：把 sourceStyleIds 并进 targetStyleId（一次 N→1）。payload { targetStyleId, sourceStyleIds[] }
// ⚠️ 同 `order-variant-rename`：`ok:false` 也回 `success:true` —— 拒绝原因（目标不存在 /
//    源款已被删）是**业务判断**，要原话显示给用户，不能变成一条 IPC 异常。
register('order-style-merge', async (payload) => {
  if (!isPlainObject(payload)) return { success: false, error: 'invalid payload' };
  orderDb.ensureOrderSchema();
  return {
    success: true,
    data: orderDb.mergeStylesInto(payload.targetStyleId, payload.sourceStyleIds),
  };
});

// 拆开一次合并（按批次 id）。payload { batchId }
register('order-style-unmerge', async (payload) => {
  if (!isPlainObject(payload)) return { success: false, error: 'invalid payload' };
  orderDb.ensureOrderSchema();
  return { success: true, data: orderDb.unmergeStyles(payload.batchId) };
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
      data: {
        styleCode: res.styleCode,
        styleColorCode: res.styleColorCode,
        skuBackfill: res.skuBackfill,
        // `colorAlias` = 这次顺带记住的「平台色名 → 我的色名」（`null` = 没记）。
        // 与 `skuBackfill` 同性质：归属已经改成功了，界面要说的是"额外记住了什么"。
        colorAlias: res.colorAlias,
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// 款色**改名**（产品侧改了色名 ⇒ 订单侧跟着改标签；款色 id / 编码 / 绑定的图不动）。
//
// 为什么要这条通道（2026-10-23 用户实报「并入矩阵后改颜色，图片就没了」）：款色图按
// 「款编码 + 色名」查，产品编辑抽屉里的色名却是随手可改的标签 —— 只改产品侧的名字，
// 库里那张图仍挂在旧色名的色行上，重开抽屉就查不到（显示为空）。
// 为什么由产品侧发起：改名的**用户动作发生在产品页**（SKU 矩阵），保存那一刻才知道"从什么改成了什么"；
// 订单域只提供"按款编码把色行改名"这一条最小写口，不反向依赖产品库（`productId` 只用于记色名对照）。
// payload { productId, styleCode, from, to }
register('style-color-rename', async (payload) => {
  if (!isPlainObject(payload)) return { success: false, error: 'invalid payload' };
  const styleCode = typeof payload.styleCode === 'string' ? payload.styleCode.trim().slice(0, 64) : '';
  const from = typeof payload.from === 'string' ? payload.from.trim().slice(0, 50) : '';
  const to = typeof payload.to === 'string' ? payload.to.trim().slice(0, 50) : '';
  const productId = Number(payload.productId) || 0;
  if (!styleCode || !from || !to) return { success: false, error: 'invalid color rename' };
  if (from === to) return { success: true, data: { renamed: false, reason: 'noop' } };
  orderDb.ensureOrderSchema();
  try {
    const res = orderDb.renameStyleColorByCode(styleCode, from, to);
    // 记一对「旧名 → 新名」的色名对照（**附加产物**，不影响改名结果）：
    // 以后平台再发旧色名的订单，归色时能翻成用户现在用的名字，不至于又长出一个没有图的空色行。
    // 与改名分开报：改名成功而对照没记（例如同键）不该让人以为改名失败。
    const alias = res.renamed ? orderDb.rememberColorAlias(productId, from, to) : null;
    return { success: true, data: { ...res, colorAlias: alias } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// 全库重放已确认映射：把「映射在、订单没吃到」的历史行补上（见 order-db `replaySkuMappings`）。
//
// 为什么单开一个通道：单商品回填只在「人工核对那一下」触发，而这类漏网的成因恰恰是
// **没人再碰过那个商品** —— 没有全局入口，它们在界面上和"没配过映射"永远同形。
//
// payload { dryRun? }：`dryRun` 只报数、不写库（按钮要先显示"有几行能补"，
// 报数不能以改库为代价）。边界与单商品回填同一份实现：只碰未归款 / 占位色的行。
register('order-replay-mappings', async (payload) => {
  const dryRun = isPlainObject(payload) ? payload.dryRun === true : false;
  orderDb.ensureOrderSchema();
  try {
    return { success: true, data: orderDb.replaySkuMappings({ dryRun }) };
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

// 下载主图：payload { url } → 下载并登记进图片主数据，返回图片记录
// 去重：URL 指纹 / 内容指纹任一命中即复用，不重复下载
register('order-download-image', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.url !== 'string' || payload.url.length === 0 || payload.url.length > 8192) {
    return { success: false, error: 'invalid url' };
  }
  orderDb.ensureOrderSchema();
  // 落盘 + 两级去重 + 登记 `md_images` 全在 `order-image-land` 里（与采集色图共用同一份实现）：
  // 「同图不同 URL 复用既有记录（连带款色归属）」正是**按图找色**的命入口，口径只能有一处。
  const landed = await landOrderImageByUrl(payload.url);
  if (!landed.ok) return { success: false, error: landed.error };
  return { success: true, data: landed.image.row };
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
// 安全：仅允许应用自有图片仓目录（`userData/images`，R1 起订单图/产品图/采集图共用一处）内的
// 图片文件，防止任意文件读取。目录白名单在这里收敛为一份（新增缓存目录时加进 IMAGE_CACHE_DIRS
// 即可，别在 handler 里散写字面量）。
const IMAGE_CACHE_DIRS = new Set(['images']);
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
// 本地 LRU 缓存 key: realPath|maxEdge；安全校验与 order-read-image 一致（仅 `images` 目录）。
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

// 孤图清理：扫描 `userData/images`，删除不被 `md_images` 引用的图片文件
// （重置数据/批次覆盖/换图等会留下已入库但行被删的文件；正常下载的图均有 DB 引用，不会误删）。
register('order-cleanup-orphan-images', async () => {
  try {
    const dir = IMAGE_DIR();
    if (!fs.existsSync(dir)) return { success: true, data: { deleted: 0, freedBytes: 0 } };
    const refs = new Set<string>();
    for (const p of allImageLocalPaths()) {
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
