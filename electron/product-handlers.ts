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
//   product-import     Excel 批量导入落库（单事务；行明细已在渲染层解析校验；进价随行写 `pl_products.cost_cents`）
//   product-cost-set   只改「当前进价」一列（成本面板逐款改价）
//   product-size-shift-load 亚洲款加码：一次取回「款 → 偏移」与「款 → 码链」（拣货清单换算用）
//   product-size-shift-set  设/撤一款的加码偏移（0 = 撤）
//   product-priced-codes 有当前进价的款编码集合（「今天」缺口卡用；不返回金额）
//   product-export     导出/模板：主进程用 exceljs 生成 xlsx（按行嵌图）并弹保存框
//   product-extract-images 从导入的 xlsx 里抽**嵌入图片**，落盘登记后按锚点行报回
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
import {
  ensureProductSchema,
  listProducts,
  listPricedProductCodes,
  getProduct,
  upsertProduct,
  deleteProduct,
  batchUpdateProducts,
  moveProductSupplier,
  productSummary,
  importProducts,
  PRODUCT_STATUSES,
  listSkuMappings,
  skuMapSummary,
  shopSkuQueue,
  upsertSkuMappings,
  invalidateSkuMapping,
  attachProductImage,
  adoptProductImageIfEmpty,
  getProductCode,
  clearItemImage,
  detachProductImage,
  itemImagePool,
  pendingProductImages,
  pendingRemoteProductImages,
  confirmedMapPairs,
  setItemImage,
  variantDelete,
  variantList,
  variantUpsert,
  SKU_MAP_STATUSES,
  setProductCostByCode,
  sizeShiftMap,
  sizeChains,
  setSizeShift,
  type ProductUpsertInput,
  type ProductImportRow,
  type SkuMapInput,
  type RemoteProductImageAdoption,
} from './product-db';
import { handle } from './ipc-util';
// 图片仓（唯一落盘入口 + 唯一图片表 `md_images`）：本文件只调 `landImageBytes` / `IMAGE_DIR`
import { IMAGE_DIR, landImageBytes } from './master-data-db';
import { nextStyleCode, adoptStyleColorImageByCode } from './order-db';
// 供应商「按名称查找、不存在则新建」—— `suppliers` 表的 owner 是采购域（ADR-002 C1 单点写入），
// 产品域只借它把 Excel 里的厂家名落成一个 id（2026-10-10）
import { findOrCreateSupplierByName } from './purchase-db';
import { getShopItemRow, setShopItemImageId } from './shop-item-db';
// 产品表 xlsx 的生成与抽图（表头/行列宽/锚点归位都在这份里；"图真的嵌进去了没有"与
// "图归到了哪一行"由 `scripts/product-xlsx-smoke.cjs` 单独钉住）
import { buildProductWorkbook, extractEmbeddedImages } from './product-xlsx';
// 映射写入后回填存量订单 —— 只有 handler 层能同时看到两个域（product-db 不得 import order-db，会成环）
import { reassignOrdersByItemIds, ensureOrderSchema } from './order-db';
// 色图与订单主图落**同一张图片表 `md_images`**、走同一份落库实现（见该文件头的闭环说明）。
// 色图若落在另一份图仓，订单导入的「内容指纹命中」永远看不到它 ⇒ 按图找色一次都不闭（P0-1）。
import { landOrderImageByUrl } from './order-image-land';

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
    // 进价：**只有调用方真的传了这个键**才带上（缺省 = 不修改，见 `upsertProduct` 注释）。
    // 不在这里 `|| 0` —— 那会把"没传"与"填了非法值"都变成 0，静默清掉真实的钱。
    ...(payload?.costCents !== undefined && payload?.costCents !== null
      ? { costCents: Number(payload.costCents) }
      : {}),
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
  const input = sanitizeProduct(payload);
  return upsertProduct(input);
});

/**
 * 逐款改「当前进价」（成本面板的保存按钮；C2 起成本只有一个真源 = `pl_products.cost_cents`）。
 * 与 `product-upsert` 的分工：那个是**全量提交**（会重置厂家/类目/状态/备注），这个只改一列。
 * `costCents = 0` = 清空（读侧按"缺"处理，不是零成本）。
 */
handle('product-cost-set', (payload: any) => {
  ensureProductSchema();
  const code = str(payload?.code, MAX.code).trim();
  if (!code) throw new Error('缺少款编码');
  const cents = Number(payload?.costCents);
  if (!Number.isFinite(cents) || cents < 0) throw new Error('进价必须是非负数字（分）');
  return setProductCostByCode(code, Math.round(cents));
});

/**
 * 亚洲款加码：**一次往返**取回「款 → 偏移」与「款 → 码链」。
 *
 * 为什么合并成一条：拣货清单换算时两样都必须有（偏移决定动不动、码链决定"下一个码是谁"），
 * 分两条通道就必然出现"第一条回来了第二条失败"的半截状态 —— 那种状态下清单会按**不加码**算，
 * 数字看着正常、货拿错。码链按本次清单涉及的款取，不做全库预取（真库款数远大于一屏）。
 */
handle('product-size-shift-load', (payload: any) => ({
  shifts: sizeShiftMap(),
  chains: sizeChains(payload?.codes),
}));

handle('product-size-shift-set', (payload: any) => {
  ensureProductSchema();
  return setSizeShift(payload);
});

/** 有当前进价的款编码集合（缺口卡的存在性检查；不返回金额） */
handle('product-priced-codes', () => {
  ensureProductSchema();
  return { codes: listPricedProductCodes() };
});

/**
 * 下一个款编码（建款向导的「系统发号」只读展示）。
 *
 * 复用识别链路的同一个发号器（`order-db.nextStyleCode`，编码池 = oi_styles ∪ pl_products）——
 * 渲染层自己按 max+1 算会漏掉识别侧占用的序号，撞唯一键时报错方向全反。
 */
handle('product-next-code', () => {
  ensureProductSchema();
  return { code: nextStyleCode() };
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

// 按款编码改厂家（拣货宫格里"把 SKU 拖到别家"的写入口；0 = 清空关联）。
// 与 product-batch-update 的分工：那个按**产品 id** 批量改（货品档案的勾选编辑），
// 这个按 **code** 单款改（拣货清单手上只有款编码）—— 两条路都只改 supplier_id 一列，
// 不碰 name/category/status/note（全量提交会静默重置它们）。
handle('product-move-supplier', (payload: any) => {
  ensureProductSchema();
  const code = str(payload?.code, MAX.code).trim();
  if (!code) throw new Error('缺少款编码');
  return moveProductSupplier(code, toId(payload?.supplierId));
});

// ---- Excel 批量导入 / 导出 ----
//
// 分工：**解析与校验在渲染层**（`src/lib/productImport.ts` + `src/modules/goods/productIo.ts`），
// 主进程只收「已经一行行校验过的结构」落库。这样口径只有一份，
// 且校验逻辑能被 vitest 覆盖（主进程这层因 better-sqlite3 的 Electron ABI 测不了）。
//
// **唯一的例外是"图"**：Excel 的嵌入图是**浮动对象**，既不在单元格里，渲染层也读不到
// （SheetJS 不解析 `xl/drawings`）—— 只有主进程的 exceljs 能。于是图按方向各占一个通道：
//   读进来：`product-extract-images` —— xlsx → 落盘 + 登记 `md_images` → **按锚点行**报回
//   写出去：`product-export`         —— 渲染层给"每格写什么"+"每行的图路径"，主进程生成并嵌图

/** 单次导入上限（与 order 域的导入量级对齐；速卖通万级商品之内） */
const MAX_IMPORT_ROWS = 20000;
/** 单行的 SKU 上限（颜色一格一个 × 尺码若干；防一个坏文件把变体表撑爆） */
const MAX_ROW_SKUS = 500;
/** 单次抽图上限（防一份被误塞了几万张图的文件把 IPC 拖死） */
const MAX_EXTRACT_IMAGES = 3000;
/** 单次导出上限（与渲染层的翻页护栏同量级：40 页 × 500 行） */
const MAX_EXPORT_ROWS = 20000;

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
    // 供应商**原文**：库里没有这个名字时靠它去「查找或新建」（2026-10-10）
    supplierRaw: str(r?.supplierRaw, 100).trim(),
    // 类目**不再从导入侧来**（模板与导出都没有这一列）：库层对已存在的产品原样保留，
    // 见 `importProducts` 的文件注释 —— 这里保留字段会造成"少一列就清空一列"。
    status: coerceStatus(r?.status),
    note: str(r?.note, MAX.note),
    skus: (Array.isArray(r?.skus) ? r.skus : []).slice(0, MAX_ROW_SKUS).map((s: any) => ({
      color: str(s?.color, 40).trim(),
      size: str(s?.size, 40).trim(),
      weightG: Math.round(Number(s?.weightG)) || 0,
    })),
    imageId: toId(r?.imageId),
    // 进价：只认数字（缺省/非数字 = 这行没填 ⇒ 库层不修改已有价，**不是清 0**）
    costCents: typeof r?.costCents === 'number' ? Number(r.costCents) : undefined,
  }));

  // 供应商：库里没有的名字**当场建**（用户口径 2026-10-10：「可以先通过名称查找供应商是否存在，
  // 如果不存在则创建新的供应商」）。写成域归采购域（ADR-002 C1），产品域只注入解析器。
  //
  // ⚠️ 按**归一后的名字**记忆：同一批里 200 行写了同一家厂，只会查/建一次 —— 否则每行都跑一遍
  //    `ensurePurchaseSchema` 的 DDL，500 行就是 500 遍建表语句（幂等但纯浪费）。
  //    `created` 只在**第一次**返回 true，故 `suppliersCreated` 数的是"新建了几家"，不是"用了几次"。
  const supplierMemo = new Map<string, { id: number; created: boolean }>();
  const ensureSupplier = (name: string): { id: number; created: boolean } => {
    const key = String(name ?? '').trim().replace(/\s+/g, '').toLowerCase();
    const hit = supplierMemo.get(key);
    if (hit) return { id: hit.id, created: false };
    const got = findOrCreateSupplierByName(name);
    supplierMemo.set(key, got);
    return got;
  };

  const outcome = importProducts(
    rows,
    payload?.mode === 'insertOnly' ? 'insertOnly' : 'upsert',
    { ensureSupplier },
  );

  // 进价随产品一起落在 `pl_products.cost_cents`（`importProducts → upsertProduct` 已经写过了）；
  // C2 起成本只有一个真源 = 产品表，这里**不再写第二张表**，只把"带进价的行数"回报给界面。
  const failedCodes = new Set(outcome.failed.map((f) => f.code));
  let costsWritten = 0;
  let costsSkipped = 0;
  for (const r of items) {
    if (typeof r?.costCents !== 'number') continue;
    if (failedCodes.has(str(r?.code, MAX.code).trim())) costsSkipped++;
    else costsWritten++;
  }

  return { ...outcome, costsWritten, costsSkipped };
});

/**
 * 抽「导入文件里的嵌入图」：xlsx → 落盘 + 登记 `md_images` → **按锚点行号**报回。
 *
 * 为什么要单独一步、且在**解析之后**才调：
 *   ① "哪张表是产品表"由渲染层逐张体检得出（`readProductSheet`），所以必须先解析、
 *      再把选中的表名传进来 —— 主进程自己去猜表，等于把"读错对象"再实现一遍；
 *   ② 锚点要跟"数据行从第几行开始"比，而表头在第几行也是解析才知道的（表头允许不在第一行）。
 *
 * ⚠️ **只认锚点行，不按顺序配**：浮动图会随用户插行/删行漂移。按顺序配会把错位
 *    全部吃掉且不报错（表现为"图进来了但配错了款"），所以宁可报"没归位"。
 *
 * **不抛**单张图的错（格式不认识 / 超过 10MB / 内容是空的）：其余行照常导入，
 * 这一行只是没图 —— 一张坏图不该让整批导入失败。
 */
handle('product-extract-images', async (payload: any) => {
  const buffer = payload?.buffer;
  if (!(buffer instanceof ArrayBuffer)) throw new Error('缺少 Excel 内容');
  const sheetName = str(payload?.sheetName, 120).trim();
  if (!sheetName) throw new Error('缺少工作表名');
  /** 表头所在行（1-based；由渲染层解析得出） */
  const headerRow = Math.max(0, Math.floor(Number(payload?.headerRow) || 0));

  // 抽图与"归到哪一行"的判定都在 `product-xlsx.ts`（能被 scripts/product-xlsx-smoke.cjs
  // 单独验）；本层只负责"抽出来的字节往哪落、登记成哪个 imageId"。
  return extractEmbeddedImages(buffer, {
    sheetName,
    headerRow,
    max: MAX_EXTRACT_IMAGES,
    land: (bytes) => landImageBuffer(bytes, 'import'),
  });
});

/**
 * 导出 / 下载模板：**主进程生成 xlsx**（exceljs）。
 *
 * 为什么改掉了「渲染层生成 buffer、主进程只写文件」的旧分工（2026-10-08）：**为了嵌图**。
 * 嵌入图要写 `xl/drawings` + 关系 + 内容类型几处对齐（少写一处的症状见 `xlsx-image.ts` 文件头），
 * 而渲染层用的 SheetJS 写不了这套东西。分工改成 ——
 * **渲染层算"每格写什么"（纯函数、有单测），主进程只做"把格子写上 + 把图嵌上"**：
 * 表头与行的口径仍然只有一份，主进程这一层没有任何业务判断。
 *
 * ⚠️ 这一条必须是**裸 `ipcMain.handle`**：保存对话框要挂到发起窗口上（用 `event.sender`
 *    反查 BrowserWindow），而 `ipc-util` 的 register/handle 只把 payload 传给 handler。
 *    先例：`electron/order-handlers.ts` 的 `order-export-excel`（同理由，未纳入 ipc-util）。
 *
 * 返回里带 `embedded` / `imagesFailed`：导出的图**没进去**时用户是看不见的（文件照样打开），
 * 只有把这两个数带回界面才可能被说出来。
 */
ipcMain.handle('product-export', async (event: any, payload: any) => {
  try {
    const headers: string[] = Array.isArray(payload?.headers)
      ? payload.headers.map((h: unknown) => String(h ?? ''))
      : [];
    const bodyRows = Array.isArray(payload?.rows) ? payload.rows : [];
    if (!headers.length) return { success: false, error: 'invalid payload' };
    if (bodyRows.length > MAX_EXPORT_ROWS) {
      return { success: false, error: `单次最多导出 ${MAX_EXPORT_ROWS} 行（收到 ${bodyRows.length}）` };
    }

    // 生成在 `product-xlsx.ts`（"图真的嵌进去了没有"由 product-xlsx-smoke 单独钉住）
    const built = await buildProductWorkbook({
      sheetName: String(payload?.sheetName ?? ''),
      headers,
      rows: bodyRows.map((r: any) => ({
        cells: Array.isArray(r?.cells) ? r.cells.map((c: unknown) => String(c ?? '')) : [],
        imagePath: typeof r?.imagePath === 'string' ? r.imagePath : '',
      })),
      imageColumn: Math.max(0, Math.floor(Number(payload?.imageColumn) || 0)),
    });

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
    fs.writeFileSync(result.filePath, built.buffer);
    return {
      success: true,
      data: {
        filePath: result.filePath,
        embedded: built.embedded,
        imagesFailed: built.imagesFailed,
      },
    };
  } catch (err: any) {
    return { success: false, error: err?.message || 'Unknown error' };
  }
});

// ---- 商品重量：克重只属于 SKU（`pl_variants.weight_g`），「商品ID 克重」整条链已退场 ----

/** 单次查询上限（product-variant-list 按产品 id 批量取 SKU） */
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

handle('product-sku-map', async (payload: any) => {
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
  // 认款**顺手**把商品图采纳为款主图（只补空 / 不覆盖；失败不外抛）。
  // 两档都放在回填之后，且都以"映射已写入"为前提，互不依赖：
  //   ① 本地已有图（订单图 / 人工覆盖图）—— 见 `adoptOrderImages`；
  //   ② 采集商品只有远程 image_url（`pl_shop_items.image_id = 0`）—— 下载入库再采纳。
  //      缺了这一档，「款与商品」里认的采集商品永远补不上主图（2026-10-30 用户实报）。
  // `adoptImages = false` 只来自「建档并关联」向导里用户取消勾选「采纳为款主图」——
  // 那是人的决定，不能被这两档顺手推翻（否则勾选框形同虚设）。
  const adoptImages = payload?.adoptImages !== false;
  const failedItemIds = new Set(out.failed.map((f) => f.itemId));
  if (adoptImages) {
    try {
      out.adopted = adoptOrderImages(rows, failedItemIds);
    } catch {
      out.adopted = 0;
    }
    try {
      out.adopted += await adoptShopItemRemoteImages(rows, failedItemIds);
    } catch {
      // 下载链路整体异常（如网络模块不可用）不影响映射：能采纳几张算几张
    }
  }
  return out;
});

/**
 * 存量补图（2026-10-30 用户实报「认款后产品图片还是没更新」）。
 *
 * 认款顺手补图只覆盖**写入那一刻**的行；升级前已经确认的映射不会自己长图 ——
 * 用户重启后看到的仍是白图。打开「款与商品」时跑一轮：把全库已确认映射里
 * "款还没有主图"的挑出来，先采纳本地图（订单图 / 覆盖图），再下载采集远程图
 * （单轮上限 `MAX_REMOTE_ADOPTS`，超出的如实报 `pending`，下一轮再补）。
 *
 * 三条边界与认款补图同构：**只补空**（两个挑选层都只看 `image_id = 0`）、失败不外抛、
 * 不静默截断（`pending` 报的是"这一轮之后还缺几个款"）。
 */
handle('product-sku-repair-images', async (payload: any) => {
  ensureProductSchema();
  const limitRaw = Number(payload?.limit);
  const limit =
    Number.isFinite(limitRaw) && limitRaw > 0
      ? Math.min(Math.trunc(limitRaw), MAX_REMOTE_ADOPTS)
      : MAX_REMOTE_ADOPTS;
  const pairs = confirmedMapPairs();
  if (!pairs.length) return { adopted: 0, pending: 0 };
  // 两档共用一个"写入行"形状：只用到 productId / itemId（其余字段给安全缺省）
  const rows: SkuMapInput[] = pairs.map((p) => ({
    platform: '',
    shopId: 0,
    itemId: p.itemId,
    spec: '*',
    productId: p.productId,
    status: 'confirmed',
    note: '',
  }));
  let adopted = 0;
  try {
    adopted += adoptOrderImages(rows, new Set());
  } catch {
    // 本地图这一档失败不影响远程档：能补几张算几张
  }
  let pending = 0;
  try {
    const todo = pendingRemoteProductImages(pairs).slice(0, limit);
    adopted += await runRemoteAdoptions(todo);
    // 再取一次**真实缺口**：下载失败的款也算在 pending 里 —— 不能让界面说"全补好了"
    pending = pendingRemoteProductImages(pairs).length;
  } catch {
    try {
      pending = pendingRemoteProductImages(pairs).length;
    } catch {
      pending = 0;
    }
  }
  return { adopted, pending };
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

// ---- 产品图片（`md_images` 主数据域；字节统一落 `userData/images/`） ----
//
// R1 起全项目只有一张图片表 + 一个落盘目录：产品主图、商品覆盖图、订单图、采集图都登记在
// `md_images`（内容 SHA-256 唯一），字节落在 `userData/images/`。
// 落盘/去重**只有 `master-data-db.landImageBytes` 一个入口** —— 本文件不再自带一份
// （两份实现会让"同一张图两种去重口径"，缓存里出现两份、占用统计对不上）。
// srcPath 必须来自**用户经对话框选择的文件**（信任层级与 order-read-local-image 一致）。

/** 单张图片上限（与 order-read-local-image / landImageBytes 的 10MB 对齐） */
const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * 把一段图片字节落进图片仓并登记 `md_images`。
 *
 * 与 `importImageFile` 的分工：那个先做"这是不是一个用户选中的本地文件"的信任判定，
 * 再交给这里落盘。落盘/去重口径见 `master-data-db.landImageBytes`（只此一份）。
 */
function landImageBuffer(
  buf: Buffer,
  source = 'upload',
): { imageId: number; localPath: string; reused: boolean } {
  const landed = landImageBytes(buf, { source: source || 'product-image' });
  return { imageId: landed.imageId, localPath: landed.localPath, reused: landed.reused };
}

/** 把用户选中的图片复制进图片仓（内容 SHA-256 命名去重），返回登记后的图 */
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
  return landImageBuffer(fs.readFileSync(src), source);
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

/**
 * 单次认款最多顺手下载几张远程采集图（每款一张）。
 *
 * 为什么有上限：这是 IPC 同步链路，`downloadFile` 单张最长 15s；没有上限时一次 500 行批量映射
 * 可能把界面卡到分钟级。常态是「本次认到几个没有主图的款」，远小于这个数；超出的下次改绑再补。
 */
const MAX_REMOTE_ADOPTS = 40;

/**
 * 认款补图**第二档**：把「采集商品只有远程 `image_url`」的主图下载入库并采纳为款主图。
 *
 * 为什么需要第二档：第一档 `adoptOrderImages` 只发本地图（订单图 / 人工覆盖图）。「款与商品」
 * 里认的常常是**采集来的商品**：`pl_shop_items.image_id = 0`，但 `image_url` 有值 —— 界面直接
 * 拿远程 URL 显示，用户看到的这张图却从没落过库，于是"认完款、产品页还是白图"
 * （2026-10-30 用户实报）。下载后同时回填采集行，下次列表/映射可直接用本地图。
 *
 * 边界与第一档同构：只补空（`adoptProductImageIfEmpty` 再判一次）、失败不外抛、只处理写入成功的行。
 */
async function adoptShopItemRemoteImages(
  rows: readonly SkuMapInput[],
  failedItemIds: ReadonlySet<string>,
): Promise<number> {
  const pairs = rows
    .filter((r) => !!r.productId && !!r.itemId && !failedItemIds.has(r.itemId))
    .filter((r) => (r.status ?? 'confirmed') === 'confirmed')
    .map((r) => ({ productId: r.productId, itemId: r.itemId }));
  if (!pairs.length) return 0;
  const todo = pendingRemoteProductImages(pairs).slice(0, MAX_REMOTE_ADOPTS);
  return runRemoteAdoptions(todo);
}

/**
 * 执行一批「下载远程采集图 → 入库 → 采纳为款主图」的待办。
 *
 * 与挑选层（`pendingRemoteProductImages`）分开，是因为"哪几张要下"有两个入口：
 * 认款时只挑本次写入的行；存量补图（`product-sku-repair-images`）挑全库已确认的映射。
 * 下载/回填/采纳的语义只写一份 —— 两个入口各写一遍，漂起来就是"其中一个入口会覆盖主图"。
 */
async function runRemoteAdoptions(
  todo: readonly RemoteProductImageAdoption[],
): Promise<number> {
  if (!todo.length) return 0;
  let adopted = 0;
  const queue = [...todo];
  // 并发 4：AE 图床单张通常 <1s；串行会把"批量认款"拖成一条长链
  const workers = Array.from({ length: Math.min(4, todo.length) }, async () => {
    for (;;) {
      const t = queue.shift();
      if (!t) return;
      try {
        const img = await fetchImageToLibrary(t.imageUrl);
        // 先回填采集行（下次列表直接命中本地图）；行可能刚被删，失败不影响采纳
        try {
          setShopItemImageId(t.shopItemId, img.imageId);
        } catch {
          /* 快照行没了：图仍在图片仓，产品主图照常采纳 */
        }
        if (adoptProductImageIfEmpty(t.productId, img.imageId)) adopted += 1;
      } catch {
        // 单张失败不影响其余（也不影响映射本身）：这个款留空图，改绑/下次认款会再试
      }
    }
  });
  await Promise.all(workers);
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

// ---- 采集图下载入库（shop-item-image-fetch；方案 §3.6 唯一新增图片通道）----
//
// 一次调用做两段图片的事（方案 P4 主行 + §8.8 P4 扩展）：
//   ① 商品主图：下载远程主图 → `landImageBuffer`（内容 SHA-256 去重，同图不落两份）→
//      回填 `pl_shop_items.image_id`（这一行此后可走本地图，不必再热链 CDN）；
//      带 `adoptMain=true` 且给 `productId` 时**顺手**采纳为款主图（建款向导的勾选）。
//   ② 每色图（`colors[]`）：逐张下载入库 → 采纳为**款色绑定图**（`adoptStyleColorImageByCode`，
//      只补空）—— 与订单归款（`autoAssignByMap`）走同一条款色解析，两处绑的是同一个款色。
//
// 边界（与 `adoptOrderImages` 同构）：
//   · 只补空不覆盖：主图看 `pl_products.image_id=0`，色图看"图/色任一侧已绑"（判定都在主进程，
//     不靠渲染层自觉）；
//   · **有色图要采纳时失败不外抛**：建档/认款已经写进去了，坏一张图不能让用户以为"没建上"——
//     主图失败走结构化 `mainError`、色图逐张带 `reason`，渲染层照写回执；
//   · 已落库的行直接复用（`image_id` 非 0），不重复下载；
//   · **纯主图调用**（不带 colors）保持"下载失败即抛"：那种调用方没有别的事可做，
//     静默"成功"比明说失败更糟。

const { downloadFile } = require('./http-client');

/** 下载远程图 → 临时文件 → `landImageBytes` 入库；失败抛（由调用方决定外抛还是收进 reason） */
async function fetchImageToLibrary(
  imageUrl: string,
): Promise<{ imageId: number; localPath: string; reused: boolean }> {
  const dir = IMAGE_DIR();
  fs.mkdirSync(dir, { recursive: true });
  // 临时文件用 .img 后缀（不是图片扩展名）：下载失败/格式不对时不会被当成正式缓存图。
  // 随机后缀：色图是连续多张下载，同一毫秒内两个临时路径不能相撞。
  const tmpPath = path.join(
    dir,
    `dl-${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2, 8)}.img`,
  );
  try {
    const r = await downloadFile(imageUrl, tmpPath);
    if (!r.ok) throw new Error(r.error || '图片下载失败');
    // 带 sourceUrl：URL 指纹进登记，同一采集图被采两次不会落第二行（与色图采纳同一口径）
    const landed = landImageBytes(fs.readFileSync(tmpPath), {
      sourceUrl: imageUrl,
      source: 'shop-item',
    });
    return { imageId: landed.imageId, localPath: landed.localPath, reused: landed.reused };
  } finally {
    // landImageBytes 已另存正式文件（内容哈希命名），临时文件必须清掉
    if (fs.existsSync(tmpPath)) fs.unlinkSync(tmpPath);
  }
}

handle('shop-item-image-fetch', async (payload: any) => {
  const rowId = toId(payload?.id);
  if (!rowId) throw new Error('缺少采集行 id');
  const row = getShopItemRow(rowId);
  if (!row) throw new Error('采集行不存在或已被删除');
  // 色图入参消毒（preload 已滤过一层，这里按业务口径再来一次——双防线）：
  // 同色只取第一条（色→图 1:1；矩阵里同一色出现多行时第二条自然被"色侧已绑"挡下）。
  const colorInputs: { color: string; imageUrl: string }[] = [];
  const seenColor = new Set<string>();
  for (const c of Array.isArray(payload?.colors) ? payload.colors : []) {
    const color = typeof c?.color === 'string' ? c.color.trim().slice(0, 100) : '';
    const imageUrl = typeof c?.imageUrl === 'string' ? c.imageUrl.slice(0, 1000) : '';
    if (!color || !imageUrl || seenColor.has(color)) continue;
    seenColor.add(color);
    colorInputs.push({ color, imageUrl });
  }
  const productId = toId(payload?.productId);
  if (colorInputs.length && !productId) {
    // 色图要挂到款色上，款色只能按款编码定位（编码从产品行取）⇒ 缺 productId 无从谈起
    throw new Error('色图采纳需要 productId');
  }
  const colorResults: { color: string; imageId: number; bound: boolean; reason: string }[] = [];
  if (colorInputs.length) {
    // 色图与订单行共用 `md_images` ⇒ 先确保订单域表在（懒建表：采集通道不碰订单表时它还没建）
    ensureOrderSchema();
    const code = getProductCode(productId);
    if (!code) throw new Error(`产品不存在或已被删除: id=${productId}`);
    for (const c of colorInputs) {
      try {
        // ⚠️ 必须走 `landOrderImageByUrl`：它除了落盘，还把 **URL 指纹** 与内容指纹一起登记进
        //    `md_images` —— 订单导入的「按图找色」正是靠这条登记的命中来闭环。
        //    `fetchImageToLibrary` 虽然也进同一张表，但不带 URL 指纹，重复采集会再落一行。
        const landed = await landOrderImageByUrl(c.imageUrl);
        if (!landed.ok) throw new Error(landed.error);
        const r = adoptStyleColorImageByCode(code, c.color, landed.image.imageId);
        colorResults.push({ color: c.color, imageId: landed.image.imageId, bound: r.bound, reason: r.reason || '' });
      } catch (e: unknown) {
        // 单张失败不中断其余色（reason 是机器可判的值，渲染层据此分"失败"与"跳过"）
        colorResults.push({
          color: c.color,
          imageId: 0,
          bound: false,
          reason: 'download-failed',
        });
      }
    }
  }
  // ---- ① 商品主图 ----
  if (row.imageId) {
    // 已有本地图 = 复用；但**采纳仍要做**（这一行可能是早先直连认款时只下载没采纳的）
    let adopted = false;
    if (productId && payload?.adoptMain === true) {
      adopted = adoptProductImageIfEmpty(productId, row.imageId);
    }
    return {
      imageId: row.imageId,
      localPath: '',
      reused: true,
      adopted,
      mainError: '',
      colors: colorResults,
    };
  }
  if (!row.imageUrl) {
    if (colorResults.length) {
      return {
        imageId: 0,
        localPath: '',
        reused: false,
        adopted: false,
        mainError: '这一行没有采集图地址',
        colors: colorResults,
      };
    }
    throw new Error('这一行没有采集图地址');
  }
  try {
    const landed = await fetchImageToLibrary(row.imageUrl);
    setShopItemImageId(rowId, landed.imageId);
    let adopted = false;
    if (productId && payload?.adoptMain === true) {
      // 只补空；采纳本身失败不影响"图已入库 + 行已回填"这个事实
      adopted = adoptProductImageIfEmpty(productId, landed.imageId);
    }
    return {
      imageId: landed.imageId,
      localPath: landed.localPath,
      reused: landed.reused,
      adopted,
      mainError: '',
      colors: colorResults,
    };
  } catch (e: unknown) {
    if (!colorResults.length) throw e;
    return {
      imageId: 0,
      localPath: '',
      reused: false,
      adopted: false,
      mainError: e instanceof Error ? e.message : String(e),
      colors: colorResults,
    };
  }
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
