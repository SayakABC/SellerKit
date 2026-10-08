// electron/product-handlers.ts
// 「产品库」渲染层 IPC（语义化通道，electron/main.ts require 后自动生效）。
// 视图侧为**内建**「货与成本 › 产品」（`src/modules/goods/**`）；数据层留在主进程（ADR-002 C3）。
// （原视图侧是市场分发的 UI 岛 `ui-plugins/product-library`，该岛已于 2026-10-01 下架，
//  功能整体收回内建；通道本身一行未改。）
//   product-db-ensure  幂等建表（视图首次激活时调用）
//   product-list       列表（关键字 / 状态 / 厂家过滤 + 分页）
//   product-get        单条详情
//   product-upsert     新增 / 更新（全量提交；编码唯一，冲突即报错）
//   product-delete     删除
//   product-batch-update 批量编辑（部分 patch：厂家/类目/状态/备注，undefined = 不修改）
//   product-summary    汇总（总数 / 按状态 / 厂家分布 + 全量厂家下拉）
//   product-import     Excel 批量导入落库（单事务；行明细已在渲染层解析校验）
//   product-export     导出/模板：保存渲染层生成的 xlsx（弹保存框）
//   product-sku-list   映射列表（店铺商品ID → 产品；筛选 + 分页）
//   product-sku-summary 映射汇总（不扫订单）
//   product-sku-queue  待关联队列（实时聚合 oi_orders 的商品ID，减去已有生效映射）
//   product-sku-map    批量关联 / 改绑（单事务，行级失败逐行报回）
//   product-sku-invalidate 标失效（商品ID 会变；不物理删除）
// 入参在 preload 层已做形状消毒，本层再做一次业务口径校验（双防线，见 AGENTS.md §2.3）。

export {};

import { ipcMain, app, dialog, BrowserWindow } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { createHash } from 'crypto';
import {
  ensureProductSchema,
  listProducts,
  getProduct,
  upsertProduct,
  deleteProduct,
  batchUpdateProducts,
  productSummary,
  importProducts,
  PRODUCT_STATUSES,
  listSkuMappings,
  skuMapSummary,
  shopSkuQueue,
  upsertSkuMappings,
  invalidateSkuMapping,
  attachProductImage,
  clearItemImage,
  detachProductImage,
  itemImagePool,
  pendingProductImages,
  setItemImage,
  upsertImageRecord,
  variantDelete,
  variantList,
  variantUpsert,
  SKU_MAP_STATUSES,
  type ProductUpsertInput,
  type ProductImportRow,
  type SkuMapInput,
} from './product-db';
import { handle, IMG_EXT_BY_FORMAT, sniffImageFormat } from './ipc-util';
// 映射写入后回填存量订单 —— 只有 handler 层能同时看到两个域（product-db 不得 import order-db，会成环）
import { reassignOrdersByItemIds } from './order-db';

const MAX = {
  code: 64,
  name: 200,
  category: 60,
  status: 20,
  note: 2000,
  search: 200,
} as const;

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

/** 解析正整数 id（非法返回 0） */
function toId(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 2147483647 ? v : 0;
}

/** 状态白名单（非法 → 'active'；与 product-db 的 normStatus 同口径） */
function coerceStatus(v: unknown): string {
  const s = str(v, MAX.status).trim();
  return (PRODUCT_STATUSES as readonly string[]).includes(s) ? s : 'active';
}

/** 产品入参消毒：结构白名单 + 长度约束（全量提交语义，缺省即空） */
function sanitizeProduct(payload: any): ProductUpsertInput {
  return {
    id: toId(payload?.id),
    code: str(payload?.code, MAX.code).trim(),
    name: str(payload?.name, MAX.name).trim(),
    supplierId: toId(payload?.supplierId),
    category: str(payload?.category, MAX.category).trim(),
    status: coerceStatus(payload?.status),
    note: str(payload?.note, MAX.note),
  };
}

handle('product-db-ensure', (): { ok: boolean } => {
  ensureProductSchema();
  return { ok: true };
});

// 图片 handlers 依赖的导入已并入文件头 import 块（createHash / 图片落盘工具）。

/** 把用户选中的图片复制进 product-images 缓存（内容 SHA-256 命名去重），返回登记后的图 */

handle('product-list', (payload: any) => {
  ensureProductSchema();
  const status = str(payload?.status, MAX.status).trim();
  return listProducts({
    offset: Number(payload?.offset) || 0,
    limit: Number(payload?.limit) || 50,
    search: str(payload?.search, MAX.search).trim(),
    status: (PRODUCT_STATUSES as readonly string[]).includes(status) ? status : '',
    supplierId: toId(payload?.supplierId),
    // 布尔项只认严格 true —— 渲染层传 "1"/1 时不应静默生效（筛选结果变少而用户看不出原因）
    withoutSupplier: payload?.withoutSupplier === true,
    onlyMissingWeight: payload?.onlyMissingWeight === true,
  });
});

handle('product-get', (payload: any) => {
  ensureProductSchema();
  return getProduct(toId(payload?.id));
});

handle('product-upsert', (payload: any) => {
  ensureProductSchema();
  return upsertProduct(sanitizeProduct(payload));
});

handle('product-delete', (payload: any) => {
  ensureProductSchema();
  return deleteProduct(toId(payload?.id));
});

// 批量编辑（部分 patch：preload 只回传用户填了的字段，undefined = 不修改）
handle('product-batch-update', (payload: any) => {
  const ids = Array.isArray(payload?.ids) ? payload.ids.map((x: unknown) => toId(x)) : [];
  if (ids.length > 1000) {
    throw new Error(`product-batch-update: 单次最多 1000 个产品（收到 ${ids.length}）`);
  }
  return batchUpdateProducts({
    ids,
    ...(payload?.supplierId !== undefined
      ? { supplierId: toId(payload.supplierId) }
      : {}),
    ...(payload?.category !== undefined ? { category: str(payload.category, MAX.category) } : {}),
    ...(payload?.status !== undefined ? { status: coerceStatus(payload.status) } : {}),
    ...(payload?.note !== undefined ? { note: str(payload.note, MAX.note) } : {}),
  });
});

handle('product-summary', () => {
  ensureProductSchema();
  return productSummary();
});

// ---- Excel 批量导入 / 导出 ----
//
// 分工：**解析与校验在渲染层**（`src/lib/productImport.ts` + `src/modules/goods/productIo.ts`），
// 主进程只收「已经一行行校验过的结构」落库。这样口径只有一份，
// 且校验逻辑能被 vitest 覆盖（主进程这层因 better-sqlite3 的 Electron ABI 测不了）。

/** 单次导入上限（与 order 域的导入量级对齐；速卖通万级商品之内） */
const MAX_IMPORT_ROWS = 20000;

handle('product-import', (payload: any) => {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length > MAX_IMPORT_ROWS) {
    throw new Error(`product-import: 单次最多 ${MAX_IMPORT_ROWS} 行（收到 ${items.length}）`);
  }
  const rows: ProductImportRow[] = items.map((r: any) => ({
    rowNo: Number(r?.rowNo) || 0,
    code: str(r?.code, MAX.code).trim(),
    name: str(r?.name, MAX.name).trim(),
    supplierId: toId(r?.supplierId),
    category: str(r?.category, MAX.category).trim(),
    status: coerceStatus(r?.status),
    note: str(r?.note, MAX.note),
  }));
  return importProducts(rows, payload?.mode === 'insertOnly' ? 'insertOnly' : 'upsert');
});

// 导出 xlsx：**buffer 由渲染层用 xlsx 生成**（与 order-insight 的 exportWorkbook 同构），
// 本通道只负责弹保存框并写文件 —— 主进程不引 xlsx，避免多一份解析/生成实现。
//
// ⚠️ 这一条必须是**裸 `ipcMain.handle`**：保存对话框要挂到发起窗口上（用 `event.sender`
//    反查 BrowserWindow），而 `ipc-util` 的 register/handle 只把 payload 传给 handler。
//    先例：`electron/order-handlers.ts` 的 `order-export-excel`（同理由，未纳入 ipc-util）。
ipcMain.handle('product-export', async (event: any, payload: any) => {
  try {
    if (!payload || !(payload.buffer instanceof ArrayBuffer)) {
      return { success: false, error: 'invalid payload' };
    }
    const win = event?.sender ? BrowserWindow.fromWebContents(event.sender) : null;
    const result = await dialog.showSaveDialog(win, {
      title: '导出产品库',
      defaultPath: path.join(
        app.getPath('downloads'),
        String(payload.defaultName || '产品库.xlsx'),
      ),
      filters: [{ name: 'Excel', extensions: ['xlsx'] }],
    });
    if (result.canceled || !result.filePath) return { success: false, error: 'User canceled' };
    fs.writeFileSync(result.filePath, Buffer.from(payload.buffer));
    return { success: true, data: { filePath: result.filePath } };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Unknown error' };
  }
});

// ---- 商品重量（pl_item_weights；按订单算运费的数据源头） ----

/** 单次导入上限（商品信息表全量导入；速卖通万级商品之内） */
/** 单次查询上限 */
const MAX_WEIGHT_QUERY = 5000;

// ---- 「店铺商品ID → 产品」映射（P3）----

/** 单次批量关联上限（一次确认一批；与导入量级对齐） */
const MAX_SKU_BATCH = 20000;

handle('product-sku-list', (payload: any) => {
  const status = str(payload?.status, MAX.status).trim();
  return listSkuMappings({
    offset: Number(payload?.offset) || 0,
    limit: Number(payload?.limit) || 50,
    search: str(payload?.search, MAX.search).trim(),
    status: (SKU_MAP_STATUSES as readonly string[]).includes(status) ? status : '',
    shopId: toId(payload?.shopId),
    // 反向过滤（产品侧「已关联商品」）：0 = 不过滤
    productId: toId(payload?.productId),
  });
});

handle('product-sku-summary', () => {
  return skuMapSummary();
});

handle('product-sku-queue', (payload: any) => {
  return shopSkuQueue({
    limit: Number(payload?.limit) || undefined,
    maxRows: Number(payload?.maxRows) || undefined,
  });
});

handle('product-sku-map', (payload: any) => {
  const items = Array.isArray(payload?.rows) ? payload.rows : [];
  if (items.length > MAX_SKU_BATCH) {
    throw new Error(`product-sku-map: 单次最多 ${MAX_SKU_BATCH} 条（收到 ${items.length}）`);
  }
  const rows: SkuMapInput[] = items.map((r: any) => ({
    platform: str(r?.platform, 40),
    shopId: toId(r?.shopId),
    itemId: str(r?.itemId, 64),
    spec: str(r?.spec, 40) || '*',
    productId: toId(r?.productId),
    status: str(r?.status, MAX.status) || 'confirmed',
    note: str(r?.note, MAX.note),
  }));
  const out = upsertSkuMappings(rows);
  // 配完映射**顺手把存量未归款订单回填一遍** —— 真实操作顺序常常是"先导订单、后配映射"，
  // 没有这一步用户配完看不到任何变化，只能重导 Excel（见 `reassignOrdersByItemIds`）。
  // 只回填本次写入成功的商品ID；回填失败不影响"映射已写入"这个事实（下次写入会再试）。
  const written = new Set(rows.map((r) => r.itemId).filter((id) => !!id && !out.failed.some((f) => f.itemId === id)));
  try {
    out.reassigned = reassignOrdersByItemIds([...written]);
  } catch {
    out.reassigned = 0;
  }
  // 认款**顺手**把订单图采纳为款主图（只补空 / 不覆盖；失败不外抛 —— 见 `adoptOrderImages`）。
  // 放在回填之后：两件事都以"映射已写入"为前提，互不依赖。
  try {
    out.adopted = adoptOrderImages(rows, new Set(out.failed.map((f) => f.itemId)));
  } catch {
    out.adopted = 0;
  }
  return out;
});

handle('product-sku-invalidate', (payload: any) => {
  return invalidateSkuMapping(toId(payload?.id));
});

// ---- SKU 子表（pl_variants；一个款下多个 SKU，每 SKU 一个克重） ----

handle('product-variant-list', (payload: any) => {
  const ids = Array.isArray(payload?.productIds) ? payload.productIds : [];
  if (ids.length > MAX_WEIGHT_QUERY) {
    throw new Error(`product-variant-list: 单次最多 ${MAX_WEIGHT_QUERY} 个产品（收到 ${ids.length}）`);
  }
  return { rows: variantList(ids.map((x: unknown) => toId(x))) };
});

handle('product-variant-upsert', (payload: any) => {
  return variantUpsert({
    id: toId(payload?.id),
    productId: toId(payload?.productId),
    code: str(payload?.code, 64).trim(),
    name: str(payload?.name, 200).trim(),
    color: str(payload?.color, 40).trim(),
    size: str(payload?.size, 40).trim(),
    weightG: Math.round(Number(payload?.weightG)) || 0,
    status: coerceStatus(payload?.status),
  });
});

handle('product-variant-delete', (payload: any) => {
  return variantDelete(toId(payload?.id));
});

// ---- 产品图片（pl_images / pl_item_images；落盘 userData/product-images/） ----
//
// 图片**不**走 order-download-image：那条链路写 oi_images、受订单域孤图清理管辖，
// 产品主图挂上去会被"没有订单引用"的清理误删。这里独立落盘 + pl_images 登记，
// 展示复用 order-read-image / order-image-thumb（目录白名单已扩展为两缓存目录）。
// srcPath 必须来自**用户经对话框选择的文件**（信任层级与 order-read-local-image 一致）。

const PRODUCT_IMAGE_DIR = () => path.join(app.getPath('userData'), 'product-images');
/** 单张图片上限（与 order-read-local-image 的 10MB 对齐） */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/** 把用户选中的图片复制进 product-images 缓存（内容 SHA-256 命名去重），返回登记后的图 */
function importImageFile(
  srcPath: unknown,
  source = 'upload',
): { imageId: number; localPath: string; reused: boolean } {
  if (typeof srcPath !== 'string' || !srcPath.trim()) throw new Error('缺少图片文件路径');
  const src = path.resolve(srcPath.trim());
  const stat = fs.statSync(src); // 不存在会抛 ENOENT，handle 层转 error
  if (!stat.isFile()) throw new Error('指定路径不是文件');
  if (stat.size > MAX_IMAGE_BYTES) throw new Error('图片超过 10MB 上限');
  const ext = path.extname(src).toLowerCase();
  if (!['.jpg', '.jpeg', '.png', '.webp'].includes(ext)) {
    throw new Error('仅支持 jpg / png / webp 图片');
  }
  const buf = fs.readFileSync(src);
  const fmt = sniffImageFormat(buf);
  if (!fmt) throw new Error('文件内容不是受支持的图片格式（按文件头判断，不只看扩展名）');
  const fingerprint = createHash('sha256').update(buf).digest('hex');
  const dir = PRODUCT_IMAGE_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, fingerprint + IMG_EXT_BY_FORMAT[fmt]);
  if (!fs.existsSync(finalPath)) fs.writeFileSync(finalPath, buf);
  const rec = upsertImageRecord({ fingerprint, localPath: finalPath, source });
  return { imageId: rec.imageId, localPath: finalPath, reused: rec.reused };
}

/**
 * 认款时**顺手**把订单图采纳为款主图（对本次写入映射的每一行看一次）。
 *
 * 为什么挂在 `product-sku-map` 里、而不是单独做个按钮：用户此刻的注意力就在"这个商品=哪个款"，
 * 而订单图就在旁边（队列的「图」列）。顺手落下来之后，款侧就不再是"一张图都没有"——
 * 下次这个款出现在选款列表里就有图可比，形成「认款 → 有图 → 更好认款」的正循环。
 *
 * 三条边界：
 *   ① **只补空、不覆盖** —— 判定在 `pendingProductImages`（`pl_products.image_id = 0` 才采纳）；
 *   ② **失败不外抛** —— 映射已经写进去了，采纳只是附加动作，坏一张图不能让用户以为"没关联上"；
 *   ③ **只对写入成功的行** —— 失败的 itemId 跳过，免得给一个根本没配上的商品改了款图。
 */
function adoptOrderImages(rows: readonly SkuMapInput[], failedItemIds: ReadonlySet<string>): number {
  const pairs = rows
    .filter((r) => !!r.productId && !!r.itemId && !failedItemIds.has(r.itemId))
    .filter((r) => (r.status ?? 'confirmed') === 'confirmed')
    .map((r) => ({ productId: r.productId, itemId: r.itemId }));
  if (!pairs.length) return 0;
  let adopted = 0;
  for (const c of pendingProductImages(pairs)) {
    try {
      const img = importImageFile(c.localPath, c.source);
      attachProductImage(c.productId, img.imageId);
      adopted += 1;
    } catch {
      // 单张失败不影响其余（也不影响"映射已写入"）：这个款留空图，下次认款会再试
    }
  }
  return adopted;
}

handle('product-image-attach', (payload: any) => {
  const productId = toId(payload?.productId);
  if (!productId) throw new Error('请指定产品');
  const img = importImageFile(payload?.srcPath);
  attachProductImage(productId, img.imageId);
  return img;
});

handle('product-image-detach', (payload: any) => {
  return detachProductImage(toId(payload?.productId));
});

handle('product-item-image-set', (payload: any) => {
  const itemId = str(payload?.itemId, 64).trim();
  if (!itemId) throw new Error('缺少商品ID');
  const img = importImageFile(payload?.srcPath);
  setItemImage({ itemId, imageId: img.imageId });
  return { ...img, itemId };
});

handle('product-item-image-clear', (payload: any) => {
  return clearItemImage(str(payload?.itemId, 64).trim());
});

/** 单次取图池上限（映射列表一页 ≤500 行；队列分批拉） */
const MAX_IMAGE_POOL = 1000;

handle('product-item-image-pool', (payload: any) => {
  const ids = Array.isArray(payload?.itemIds) ? payload.itemIds : [];
  if (ids.length > MAX_IMAGE_POOL) {
    throw new Error(`product-item-image-pool: 单次最多 ${MAX_IMAGE_POOL} 个商品ID（收到 ${ids.length}）`);
  }
  const pool = itemImagePool(ids.map((x: unknown) => String(x ?? '')));
  // Map → 普通对象（IPC 序列化）；键 = 归一后的 item_id
  return { pool: Object.fromEntries(pool) };
});
