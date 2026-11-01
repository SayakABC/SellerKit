# 认款后的存量主图：打开「款与商品」自动补，不用重新认款

## 结论

认款顺手补图只覆盖**写入那一刻**的行。升级前已经 `confirmed` 的映射不会自己长图 ——
用户重启后看到的仍是白图（2026-10-30 实报「认款后产品图片还是没更新」）。
所以补图必须有**第二个入口**：从库里把全库已确认的映射重新取出来，只给「款还没有主图」的补。

- 取数（纯 DB）：[`electron/product-db.ts`](../../electron/product-db.ts) 的
  `confirmedMapPairs()` —— 只取 `status = 'confirmed' AND product_id > 0` 且是**真映射行**
  （`skuMappingSql('')`：排除 `source = 'shop-import'` 与 `shop_id = 0` 的池行）；
  商品ID 归一后**再去重**（库里可能有 `B0PAIR1` 与 ` B0PAIR1 ` 两条原文），出参按
  `productId` + `itemId` 升序 —— 「一款只补一张」的选择必须可复现。
- 执行：[`electron/product-handlers.ts`](../../electron/product-handlers.ts) 的
  `product-sku-repair-images` —— 第一档本地图（`adoptOrderImages`）+ 第二档远程采集图
  （`pendingRemoteProductImages` 挑选 → `runRemoteAdoptions` 下载入库采纳），
  单轮上限 `MAX_REMOTE_ADOPTS = 40`；回执 `{ adopted, pending }`，`pending` 是这轮之后**真实**还缺的款数。
- 触发：渲染层 [`useSkuPool.ts`](../../src/modules/goods/useSkuPool.ts) 在
  `onMounted`（打开「款与商品」）与页级「刷新」时跑一轮；补到图就 toast，并经
  `images-adopted` 事件让外壳重拉**同屏两栏**（否则会出现"提示补了 4 张、左栏还是白图"）。
- **认款写入那一刻也要发同一个事件**：`commitMap` 的回执里 `adopted > 0` 时同样调
  `onImagesAdopted`。后端已把图写进 `pl_products.image_id`，但左栏产品列表归
  `useProductList` 自己管 —— 不通知它，用户看到的正是"回执说设了主图、列表还是白图"
  （2026-10-30 用户实报的另一半）。`goods:ui` 冒烟新增一条断言钉住"补了主图 → 左栏真的重拉"。
- 认款时的补图（`product-sku-map`）保持原样，两条入口共用 `runRemoteAdoptions`，
  语义只写一份：**只补空、失败不外抛、不覆盖已有主图**。

## 「从采集商品导入」看不到关联商品

不是漏查，是**候选为空**：编辑抽屉取 `api.shopItemsList({ productId })`，主进程按
`mi.product_id = ?`（该款**最新一条 confirmed 映射**）过滤 —— 只有认到**当前款**的采集行才会出现，
认到别款的不显示。真库取证（2026-10-30，复制库只读）：

```text
productId 9822（STYLE-001 短裤）→ total 11   # 有 11 条采集商品认到它
productId 9823（STYLE-002 POLO衫）→ total 0   # 没有任何映射，也没有 pl_variants
```

9823 是「新增款」刚建的、从未认款 ⇒ 导入为空是正确行为。空态文案已写明
「只显示认到这一款的采集商品」，并点出当前款编码/名称；本意要是 9823，
需要到「已认」段把映射改绑到它，而不是在编辑抽屉里找。

## 边界（与认款补图同构，别拆）

1. **只补空**：两个挑选层都只看 `pl_products.image_id = 0`；下载完还会再走一次
   `adoptProductImageIfEmpty`，两道判据互为兜底。
2. **池行不是映射**：`source = 'shop-import'`（新池行）与 `shop_id = 0`（存量池行）
   一律不进 `confirmedMapPairs()` —— 池行是「商品清单」的一对多套装关联，拿它补图会把
   套装部件当成整款。
3. **只信 confirmed**：`pending` / `invalid` 不补（失效映射的商品ID 可能已经换了，补上去会张冠李戴）。
4. **不静默截断**：超过单轮上限的缺口用 `pending` 如实报出，下一次刷新继续补。

## 取证

```text
npm run product:sku:smoke
  ✓ 存量补图取数：全库只认「confirmed + 真映射行」的配对
    （池行 / 待确认 / 失效 / 无款一律不进；带空白原文归一后只出一条；按产品 id 升序）
npm run ipc:shape:smoke
  ✓ productSkuRepairImages() → 已确认映射的款补上主图，且回执报出 adopted ≥ 1
  ✓ 再跑一次 → adopted=0 且主图不被覆盖
  ✓ 缺省 limit 传 0 / limit 原样透传
npm run goods:ui
  ✓ 补了款主图 → 左栏产品列表真的重拉（before=1 after=2）
```

真库上旧映射的主图仍是 0（`md_images` 101 条全部 `source = 'order-image'`，
`pl_shop_items.image_id <> 0` 为 0），所以这次不是"补图链路本身坏了"，而是
**升级前写入的映射从未跑过下载补图** —— 需要这一轮存量补图。
