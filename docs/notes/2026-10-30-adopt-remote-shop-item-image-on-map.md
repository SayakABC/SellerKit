# 认款时必须把「只有远程 `image_url`」的采集主图下载入库

## 结论

「款与商品」认款后产品主图仍为空，**不是采纳逻辑没跑，而是没有图可采纳**：
`adoptOrderImages`（第一档）只发**本地**图（订单图 / 人工覆盖图），而采集商品通常只有
`pl_shop_items.image_url` 这个远程地址（`image_id = 0`，界面直接拿远程 URL 显示）。
于是必须补**第二档**：下载 → 落 `md_images` → 回填采集行 `image_id` → 再采纳为款主图。

- 选择层（纯 DB，不做网络）：[`electron/product-db.ts`](../../electron/product-db.ts) 的
  `pendingRemoteProductImages()` —— 只补空（`pl_products.image_id = 0`）、一款一张（按
  `productId + itemId` 升序确定性取第一张）、只挑还没入库的采集行（`image_id = 0` 且有 URL）。
- 执行层（网络）：[`electron/product-handlers.ts`](../../electron/product-handlers.ts) 的
  `adoptShopItemRemoteImages()` —— 复用已有的 `fetchImageToLibrary`（下载 + `landImageBytes` +
  清临时文件），并发 4、单次最多 `MAX_REMOTE_ADOPTS = 40` 张，单张失败只跳过它自己。
- 触发点在 `product-sku-map` 的写入成功之后（含改绑 / 恢复）：两档都只对**写入成功且
  `status = 'confirmed'` 的行**跑，回执 `adopted` 是两档之和，界面已按这个数说人话。

## 两条不能破的边界

1. **只补空、不覆盖**：`pendingProductImages` / `pendingRemoteProductImages` 都只看
   `pl_products.image_id = 0`；第二档下载完还会再走一次 `adoptProductImageIfEmpty`，
   两道判据互为兜底（第一档刚落图时第二档会因 `image_id` 已非 0 而跳过）。
2. **人的选择不能被"顺手"推翻**：`product-sku-map` 新增 `adoptImages?: boolean`（缺省 `true`）。
   唯一传 `false` 的是「建档并关联」向导 —— 用户取消勾选「采纳为款主图」时，
   第 ③ 步的认款不能再偷偷采纳（否则第 ④ 步的 `adoptMain = false` 形同虚设）。
   ⚠️ preload 侧必须写成 `=== false ? false : true`，**不能**写成 `=== true` ——
   老调用方不传这个键，缺省读成 `false` 会让补图静默失效。

## 取证

真库（2026-10-30，复制库只读）确认问题在图源而不在分支：

```sql
-- 78 条 confirmed 映射 / 71 条采集商品**全部** image_id = 0 且 image_url 有值
SELECT COUNT(*) FROM pl_shop_items WHERE image_id = 0 AND image_url <> '';
-- 有映射但没主图的款：9806 / 9811 / 9818 / 9822
```

选择层的 4 条规则由 DB 冒烟钉住（`npm run product:sku:smoke`）：

- 同一款下两个采集商品 → 只挑一个（`B0REMOTE1`，按 itemId 升序）；
- 已有主图的款 → 不再下载覆盖；
- 采集图已入库（`image_id <> 0`）→ 不按远程 URL 再下一遍（交给第一档）；
- 产品 id 不存在 → 不挑。

「向导取消勾选」由真 handler 冒烟钉住（`npm run ipc:shape:smoke`）：
`productSkuMap({ adoptImages: false })` 回 `adopted = 0` 且 `pl_products.image_id` 仍为 0。

## 存量怎么办

本修复只在**认款写入时**触发。已存在的映射不会因为升级自动补图 —— 对这些款
**再认一次 / 改绑一次**（或「恢复」失效映射）就会走同一条路径补上；
已有主图的款永远不会被换掉。
