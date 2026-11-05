// src/core/services/skuWeights.ts
// **产品库 SKU 克重**的取数口（款色码 → 单件克重）—— 全应用**唯一**的克重来源。
//
// 2026-10-01（用户领域裁定）：**克重是 SKU 属性**（同款不同颜色/尺码的重量都可能不同），
// 商品ID 上没有克重 —— 原「商品信息 Excel → `pl_item_weights`」那条链已整条删除，
// 表也随 `product.sku` v3 迁移 DROP 掉。此后：
//   · 真值只有一处：`pl_variants.weight_g`（产品库 SKU 子表，按 款×色×码）；
//   · 取数也只有一处：本文件（「算钱」「发货台」页与宿主给运费岛的只读 op 都调它）。
//
// 为什么放在 core/services 而不是各页面自己拉：三处各写一份"产品 → SKU → 建键"就是三处口径，
// 迟早出现"这页说缺克重、那页说不缺"（本轮就修过这类缝）。建键与折叠规则都在纯层（`buildSkuWeightIndex`）。

import * as ipc from './ipc';
import { buildSkuWeightIndex, type WeightVariantRow } from '@/lib/orderCost';

/** `product-list` 单页上限（`electron/product-db.ts` 的 `MAX_LIST_LIMIT`） */
const PRODUCT_PAGE = 500;
/** `product-variant-list` 单次产品 id 上限（`electron/product-handlers.ts` 的 `MAX_WEIGHT_QUERY`） */
const VARIANT_CHUNK = 5000;

/**
 * 读全量 SKU 克重并建成 `款色码 → 克重` 查表。
 *
 * - 键与折叠规则：`buildSkuWeightIndex`（纯层，有单测）—— 本函数只负责取数。
 * - 读不到产品库（表还没建、权限等）→ 返回空表，调用方按"缺克重"如实计（**不静默当 0**）。
 * - **必须拉全**：产品库分页取（单页 500），SKU 分批取（单次 ≤5000）。
 *   原先只取前 500 款，第 501 款起静默变"缺克重"（A7 暴露，2026-10-22 修）。
 *   任何一页读失败都返回空表 —— 半个表会让"其实有克重"的行被误报成缺口。
 */
export async function loadSkuWeights(): Promise<Record<string, number>> {
  const products: Array<{ id: number; code: string }> = [];
  for (let offset = 0; ; offset += PRODUCT_PAGE) {
    const pl = await ipc.productList({ offset, limit: PRODUCT_PAGE });
    if (!pl.success) return {};
    const batch = pl.data?.rows ?? [];
    for (const it of batch) {
      const id = Number(it?.id) || 0;
      if (id) products.push({ id, code: String(it?.code ?? '') });
    }
    const total = Number(pl.data?.total) || 0;
    if (batch.length < PRODUCT_PAGE || (total > 0 && products.length >= total)) break;
  }
  if (!products.length) return {};

  const variants: WeightVariantRow[] = [];
  for (let i = 0; i < products.length; i += VARIANT_CHUNK) {
    const vl = await ipc.productVariantList(
      products.slice(i, i + VARIANT_CHUNK).map((x) => x.id),
    );
    if (!vl.success) return {};
    variants.push(...(vl.data?.rows ?? []));
  }
  const codeOf = new Map<number, string>(products.map((x) => [x.id, x.code]));
  return buildSkuWeightIndex(variants, codeOf);
}
