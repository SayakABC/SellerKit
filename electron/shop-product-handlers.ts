// electron/shop-product-handlers.ts
// 「店铺商品清单」渲染层 IPC（语义化通道）。
//
// 通道列表：
//   shop-product-import     导入商品清单（按 item_id 去重）
//   shop-product-list       商品清单列表（分页 + 搜索）
//   shop-product-delete     删除商品（按 item_id）
//   shop-product-relations  查询某商品的关联关系
//   shop-product-relation-add    添加关联
//   shop-product-relation-delete 删除关联
//
// 入参在 preload 层已做形状消毒，本层再做一次业务口径校验（双防线）。

export {};

import {
  importShopProducts,
  listShopProducts,
  deleteShopProduct,
  listShopProductRelations,
  addShopProductRelation,
  deleteShopProductRelation,
} from './shop-product-db';
import { handle } from './ipc-util';

const MAX = {
  search: 200,
  imageUrl: 2000,
  shopName: 200,
} as const;

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function toId(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 2147483647 ? v : 0;
}

/** 单次导入上限 */
const MAX_IMPORT_ROWS = 20000;

// ---- 商品清单 ----

handle('shop-product-import', (payload: any) => {
  const items = Array.isArray(payload?.items) ? payload.items : [];
  if (items.length > MAX_IMPORT_ROWS) {
    throw new Error(`shop-product-import: 单次最多 ${MAX_IMPORT_ROWS} 行（收到 ${items.length}）`);
  }
  const clean = items.map((r: any) => ({
    itemId: str(r?.itemId, 64).trim(),
    shopId: toId(r?.shopId),
    // 店铺原文交给 db 层的归一链落成 shop_id（岛不该自己解析 sk_name_map）
    shopName: str(r?.shopName, MAX.shopName).trim(),
    imageUrl: str(r?.imageUrl, MAX.imageUrl),
  }));
  return importShopProducts(clean);
});

handle('shop-product-list', (payload: any) => {
  return listShopProducts({
    offset: Number(payload?.offset) || 0,
    limit: Number(payload?.limit) || 50,
    search: str(payload?.search, MAX.search),
  });
});

handle('shop-product-delete', (payload: any) => {
  const itemId = str(payload?.itemId, 64).trim();
  if (!itemId) throw new Error('shop-product-delete: itemId 不能为空');
  return deleteShopProduct(itemId);
});

// ---- 关联关系 ----

handle('shop-product-relations', (payload: any) => {
  const itemId = str(payload?.itemId, 64).trim();
  if (!itemId) throw new Error('shop-product-relations: itemId 不能为空');
  return listShopProductRelations(itemId);
});

handle('shop-product-relation-add', (payload: any) => {
  const itemId = str(payload?.itemId, 64).trim();
  if (!itemId) throw new Error('shop-product-relation-add: itemId 不能为空');
  const productId = toId(payload?.productId);
  if (!productId) throw new Error('shop-product-relation-add: productId 不能为空');
  return addShopProductRelation(itemId, productId, toId(payload?.shopId));
});

handle('shop-product-relation-delete', (payload: any) => {
  const id = toId(payload?.id);
  if (!id) throw new Error('shop-product-relation-delete: id 不能为空');
  return deleteShopProductRelation(id);
});
