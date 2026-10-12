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
// 迟早出现"这页说缺克重、那页说不缺"（本轮就修过这类缝）。建键用 `skuWeightKey`（纯层单源）。

import * as ipc from './ipc';
import { skuWeightKey } from '@/lib/orderCost';

/**
 * 读全量 SKU 克重并建成 `款色码 → 克重` 查表。
 *
 * - 键：`skuWeightKey(product.code, variant.color, variant.size)`（款编码 trim+大写，`\u0001` 分隔）；
 *   认不出款色码的行（老数据只有名称、或产品没填编码）**不进表** —— 宁可查不到，也不拿别的款顶上。
 * - 值：`weight_g > 0` 的才进表（0/空 = 没维护）。
 * - 读不到产品库（表还没建、权限等）→ 返回空表，调用方按"缺克重"如实计（**不静默当 0**）。
 * - 上限：产品 500（与产品列表页同量级）、SKU 一次批量取（`productVariantList` 有 5000 上限）。
 */
export async function loadSkuWeights(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  const pl = await ipc.productList({ limit: 500 });
  const products = pl.success ? (pl.data?.rows ?? []) : [];
  const ids = products.map((x) => Number(x.id)).filter(Boolean);
  if (!ids.length) return out;
  const vl = await ipc.productVariantList(ids);
  const codeOf = new Map<number, string>(products.map((x) => [Number(x.id), String(x.code ?? '')]));
  for (const v of vl.success ? (vl.data?.rows ?? []) : []) {
    const g = Number(v.weightG) || 0;
    if (g <= 0) continue;
    const key = skuWeightKey(codeOf.get(Number(v.productId)), v.color, v.size);
    if (key) out[key] = g;
  }
  return out;
}