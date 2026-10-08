// 货与成本 · 渲染层数据访问层
//
// 职责分工（**别把两者混起来**）：
//   · 本文件 = 薄薄的 `ipc.*` 适配层。`ipc.*` 返回 `ApiResult<T>`（`{success,data,error}`），
//     而视图层关心的是"拿到数据或抛异常"，所以这里统一 `unwrap` —— 视图里不写
//     `if (!r.success) throw` 这类样板。
//   · `productIo.ts` = Excel 导入/导出的**编排**（读文件 → 解析 → 校验 → 落库）。
//
// 为什么这层存在：这套代码原本在 `ui-plugins/product-library` 里，走 `window.__sk` 桥
// （`db(domain, op, payload)`，由宿主 `DB_OPS` 映射到 `ipc.*`）。迁回内建后不再有桥，
// 直接调 `ipc.*` —— **保留同名函数**是为了让视图层代码与原实现逐行对应，便于比对。
// 桥那一侧的能力域（`product` / `product-admin` / `product-image` / …）是**岛时代的权限隔离**，
// 内建渲染层是同进程信任域不需要它 —— 那 5 个域已随岛一起从 `DB_OPS` 删除（2026-10-01）。
import * as ipc from '@/core/services/ipc';
import { unwrapAsync } from './unwrapApi';
import type {
  ImageDataUrl,
  ItemImagePoolEntry,
  ProductBatchUpdateInput,
  ProductListItem,
  ProductStatus,
  ProductSummary,
  ProductUpsertInput,
  ShopProductItem,
  ShopProductRelation,
  ShopSkuRow,
  SkuMapInputPayload,
  SkuMapStatus,
  SkuMapSummary,
  SkuQueueRow,
  SkuQueueStats,
  Supplier,
  VariantRow,
  VariantUpsertInput,
} from '@/types';

/** 拆 `ApiResult`：失败即抛（错误文案原样带出，主进程的报错已经是给人看的）。
 *  用 `unwrapAsync` 而不是 `unwrapApi` —— 这里的入参全是 promise（见 `unwrapApi.ts` 的说明）。 */
const unwrap = unwrapAsync;

/* ============================================================================
   建表
   ============================================================================ */

/**
 * 幂等建表。
 * ⚠️ 必须在**首次读列表之前**调用：`productList` 假定 `pl_products` 已存在。
 * 原岛把它放在各视图自己的 `onMounted`（Vue 子组件 mounted 先于父组件），迁到内建后
 * 由外壳在挂载时先 await 一次，子视图不再各自调。
 */
export const ensure = (): Promise<{ ok: boolean }> => unwrap(ipc.productDbEnsure());

/* ============================================================================
   产品主数据
   ============================================================================ */

export const list = (payload?: {
  search?: string;
  status?: ProductStatus | '';
  supplierId?: number;
  /** 只看未关联供应商的款（与 `supplierId` 互斥，同时给时以本项为准） */
  withoutSupplier?: boolean;
  /** 只看至少有一个 SKU 缺克重的款 */
  onlyMissingWeight?: boolean;
  offset?: number;
  limit?: number;
}): Promise<{ rows: ProductListItem[]; total: number }> => unwrap(ipc.productList(payload));

export const get = (id: number): Promise<ProductListItem | null> => unwrap(ipc.productGet(id));

export const summary = (): Promise<ProductSummary> => unwrap(ipc.productSummary());

/** 新增 / 更新（**全量提交**；编码冲突会抛错，不静默改名） */
export const upsert = (
  payload: ProductUpsertInput
): Promise<{ id: number; created: boolean }> => unwrap(ipc.productUpsert(payload));

/** 物理删除。已进业务链路的产品应改用「停用」—— 编码是跨域关联的锚点。 */
export const remove = (id: number): Promise<{ deleted: boolean }> =>
  unwrap(ipc.productDelete(id));

/** 批量编辑（**部分 patch**：只传要改的字段；`supplierId: 0` = 清空关联） */
export const batchUpdate = (payload: ProductBatchUpdateInput): Promise<{ updated: number }> =>
  unwrap(ipc.productBatchUpdate(payload));

/* ============================================================================
   SKU 子表（pl_variants：一个款下多个 SKU，每 SKU 一个克重）
   ============================================================================ */

export const variantList = (productIds: number[]): Promise<{ rows: VariantRow[] }> =>
  unwrap(ipc.productVariantList(productIds));

/** ⚠️ **全量提交**（缺省字段会被清空）→ 改单个字段时必须把该行现有字段一起送回 */
export const variantUpsert = (
  payload: VariantUpsertInput
): Promise<{ id: number; created: boolean }> => unwrap(ipc.productVariantUpsert(payload));

export const variantDelete = (id: number): Promise<{ removed: number }> =>
  unwrap(ipc.productVariantDelete(id));

/* ============================================================================
   店铺商品ID → 产品 映射
   ============================================================================ */

export const skuList = (payload?: {
  search?: string;
  status?: SkuMapStatus | '';
  shopId?: number;
  /** 反向过滤：只看某一款关联了哪些店铺商品（产品侧「已关联商品」）。0/缺省 = 不过滤 */
  productId?: number;
  offset?: number;
  limit?: number;
}): Promise<{ rows: ShopSkuRow[]; total: number }> => unwrap(ipc.productSkuList(payload));

export const skuSummary = (): Promise<SkuMapSummary> => unwrap(ipc.productSkuSummary());

/**
 * 待关联队列：**实时聚合** `oi_orders` 的商品ID，减去已有生效映射。
 * `status === 'shopUnresolved'` 的行不能写映射（订单里没有平台，硬塞会把两家店并到一起）。
 */
export const skuQueue = (payload?: {
  limit?: number;
  maxRows?: number;
}): Promise<{ rows: SkuQueueRow[]; stats: SkuQueueStats }> => unwrap(ipc.productSkuQueue(payload));

/** 批量关联 / 改绑（一次一批，单事务；行级失败逐行回来）
 *  `adopted` = 认款顺手把订单图采纳为**款主图**的张数（只补空，已有主图的款不动） */
export const skuMap = (payload: {
  rows: SkuMapInputPayload[];
}): Promise<{
  created: number;
  updated: number;
  reassigned: number;
  adopted: number;
  failed: { itemId: string; message: string }[];
}> => unwrap(ipc.productSkuMap(payload));

/** 标失效（**不物理删除**，否则关联率回落查不出原因） */
export const skuInvalidate = (id: number): Promise<{ changed: boolean }> =>
  unwrap(ipc.productSkuInvalidate(id));

/* ============================================================================
   产品图片
   ============================================================================ */

/** 设置款主图（`srcPath` 须来自用户经对话框选的文件） */
export const imageAttach = (
  productId: number,
  srcPath: string
): Promise<{ imageId: number; localPath: string; reused: boolean }> =>
  unwrap(ipc.productImageAttach({ productId, srcPath }));

export const imageDetach = (productId: number): Promise<{ changed: boolean }> =>
  unwrap(ipc.productImageDetach(productId));

export const itemImageSet = (
  itemId: string,
  srcPath: string
): Promise<{ imageId: number; localPath: string; reused: boolean; itemId: string }> =>
  unwrap(ipc.productItemImageSet({ itemId, srcPath }));

export const itemImageClear = (itemId: string): Promise<{ removed: number }> =>
  unwrap(ipc.productItemImageClear(itemId));

/** 批量取商品ID候选图（三层回落：override → order[] → product） */
export const itemImagePool = (
  itemIds: string[]
): Promise<{ pool: Record<string, ItemImagePoolEntry> }> =>
  unwrap(ipc.productItemImagePool(itemIds));

/** 批量缩略图：返回顺序与 items 一致，单项失败为 null（界面显示空占位） */
export const imageThumbBatch = (
  items: { localPath: string; maxEdge?: number }[]
): Promise<{ dataUrls: (string | null)[] }> => unwrap(ipc.orderImageThumbBatch(items));

/**
 * 读**原图**（不缩放）—— 「点开看大图」专用。
 *
 * 为什么不复用 `imageThumbBatch`：那条通道的 `maxEdge` 在主进程被夹到 **256**（表格展示级），
 * 而认款要看清印花/领型/颜色，256 不够。`order-read-image` 走的是**同一套**目录白名单
 * （`order-images` / `product-images` + 扩展名 + realpath 归一），安全边界一致，只是不缩放。
 *
 * 代价是整张原图（可至 MB 级）过 IPC —— 故**只在"用户点开某一张"时调**，不要批量预取。
 */
export const readImage = (localPath: string): Promise<ImageDataUrl> =>
  unwrap(ipc.orderReadImage(localPath));

/* ============================================================================
   供应商主数据
   owner 是宿主 `purchase-db.ts` 的 `suppliers` 表（拿货单 / 付款也引用它）。
   ============================================================================ */

export const supplierList = (): Promise<Supplier[]> => unwrap(ipc.purchaseSupplierList());

export const supplierCreate = (payload: {
  name: string;
  phone?: string;
  note?: string;
}): Promise<{ id: number }> => unwrap(ipc.purchaseSupplierCreate(payload));

/** 编辑只改电话 / 备注 —— 名称是 UNIQUE 键，拿货单与产品都按它展示 */
export const supplierUpdate = (payload: {
  id: number;
  phone?: string;
  note?: string;
}): Promise<unknown> => unwrap(ipc.purchaseSupplierUpdate(payload));

/** 删除：已有拿货单 / 付款记录时**宿主拒绝**（保护对账历史），错误原样抛给界面 */
export const supplierDelete = (id: number): Promise<unknown> =>
  unwrap(ipc.purchaseSupplierDelete(id));

/* ============================================================================
   店铺商品清单（按 item_id 去重，一件商品可一对多关联产品）
   ============================================================================ */

export const shopProductImport = (payload: {
  items: { itemId: string; shopId: number; imageUrl: string }[];
}): Promise<{ imported: number; updated: number }> => unwrap(ipc.shopProductImport(payload));

export const shopProductList = (payload?: {
  offset?: number;
  limit?: number;
  search?: string;
}): Promise<{ rows: ShopProductItem[]; total: number }> => unwrap(ipc.shopProductList(payload));

export const shopProductDelete = (itemId: string): Promise<{ removed: number }> =>
  unwrap(ipc.shopProductDelete(itemId));

export const shopProductRelations = (itemId: string): Promise<ShopProductRelation[]> =>
  unwrap(ipc.shopProductRelations(itemId));

export const shopProductRelationAdd = (payload: {
  itemId: string;
  productId: number;
}): Promise<{ id: number; created: boolean }> => unwrap(ipc.shopProductRelationAdd(payload));

export const shopProductRelationDelete = (id: number): Promise<{ removed: number }> =>
  unwrap(ipc.shopProductRelationDelete(id));
