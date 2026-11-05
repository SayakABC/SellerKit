// electron/shop-delete-guard.ts
// 删除店铺前的**跨域引用检查**（记账条目归属 / 公共分摊行）。
//
// 为什么单独一层：
//   · 不能让 `shop-accounts-db` 自己 require `ledger-db` —— 那会多一条 db→db 隐式依赖边
//     （域边界要"有意识的决定"，见 AGENTS.md §6）；
//   · 只写在 handler 里则冒烟只能断言文案，测不到"有引用时到底会不会删"。
// 编排层是两边都能调的位置：线上 handler 调用它，`shop-db-smoke.cjs` 也调用同一份。
//
// 判据：`bk_entries.shop_id`（专属条目）与 `bk_allocations.shop_id`（公共分摊）任一非零
// 即拒绝删除。`bk_entries.shop_id` 没有外键可依赖（记账域不拥有 `sk_shops`），所以必须在这里拦。
// 引导用户改用「停用」：停用后店名照常显示、历史数字一分不变。
export {};

import { countShopReferences } from './ledger-db';
import { deleteShopAccount } from './shop-accounts-db';

export function deleteShopAccountGuarded(shopId: number): { deleted: boolean } {
  const refs = countShopReferences(shopId);
  if (refs.total > 0) {
    const parts: string[] = [];
    if (refs.entries > 0) parts.push(`${refs.entries} 条收支`);
    if (refs.allocations > 0) parts.push(`${refs.allocations} 条公共分摊`);
    throw new Error(
      `该店铺有 ${refs.total} 条记账引用（${parts.join('、')}），删除会让历史账目失去归属。请改为「停用」。`,
    );
  }
  return deleteShopAccount(shopId);
}
