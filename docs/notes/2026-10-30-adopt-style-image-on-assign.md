# 认款时顺手把当前款色的图补成产品主图

**结论**（2026-10-30 用户口径「认款后，如果产品没有图片的时候，没有把当前款的图片给产品」）：

- 认款入口 `assignOrderStyle`（归类核对点名归款 / 批量定款 / `order-style-assign`）在归属事务**提交后**，
  取**该款色当前生效的图**，调 `adoptProductImageIfEmpty` 写 `pl_products.image_id`。
- 源不是"本次订单图"这一个死口径：`该款色 image_id` 才是用户看到的「当前款的图片」——
  有订单图时 `setImageStyleColor` 刚把它绑到款色；订单本身没图时保留款色原有的图，两种都算。
- **只补空**（`pl_products.image_id = 0` 才写）、**失败不外抛**、**无图/无产品行静默跳过**。
  已有主图绝不覆盖（人挑过的图优先）；归属 / 款色 / 回流都已提交，坏一张图不能让人以为"没保存"。
- 这条与「商品ID 映射」的 `adoptOrderImages` **不是重复实现**：那条只在给商品ID 配映射时跑，
  归类核对里没有商品ID 的单、批量定款都不走映射 ⇒ 必须由认款链路自己补。

**取证**：

- 落点：`electron/order-db.ts:1980`（事务内取款色生效图）→ `:1987` 调 `adoptStyleColorImageIfEmpty`；
  允许"只补空"的判定收在 `electron/product-db.ts:2106` 的 `adoptProductImageIfEmpty`（不靠调用方自觉）。
- 对照：`electron/product-handlers.ts:556` 的 `adoptOrderImages` 是映射链路的同一件事。
- 守卫：`scripts/product-sku-smoke.cjs:749` 一例三断言 —— 订单图被采纳 / 已有主图不被覆盖 /
  订单没图时采纳款色已有的图；`npm run product:sku:smoke` 全绿。
