# 采集建款向导的三条纪律：预填来自事实、色号促确认、回执替回滚（2026-10-13）

`docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md` P3/P4 落地（`ShopItemWizard.vue` + `shop-item-image-fetch`）。
三条结论与「采集快照」的定位一致：**快照只存平台事实，人的决定全部显式**。

## ① 预填值只能来自采集事实，且解析只在落库时做一遍

- 向导预填的标题 / 类目 / SKU 矩阵全部来自 `pl_shop_items` 行；系统发号走 `product-next-code`
  （复用 `nextStyleCode`，不新增发号口径）。
- SKU 的 props 解析（`Color:Red;Size:L` / `Red+M+China` 两种形式）放在**采集落库时**
  （`normalizeIngestSku` → `parseSkuProps`，与订单侧同一函数）。渲染层再解析一遍就是第二套口径，
  两边一漂，向导预填的色/码与订单归类的色/码会对不上。
- 取证：`electron/shop-item-db.ts` 的 `normalizeIngestSku`；`electron/ae-receiver.ts` 的
  `POST /ae/shop-items/ingest` 调 `upsertShopItems`。

## ② 色号促确认：判据是「归一化前后相等」，不是「像不像颜色」

- `normalizeColor` 认不出标准色名时**原样返回**（"4"→"4"、"Black"→"Black"）——这是订单归类既有的
  促确认机制，采集侧直接复用：向导对 `normalizeColor(c) === normalizeText(c)` 的行高亮 +
  缩略图 + 说明「认不出标准色名，请人工核对」。
- **永不猜色名**（把 "4" 映射成某个颜色是造事实）；人也只需在发现错时改。
- 取证：`src/modules/goods/components/ShopItemWizard.vue` 的 `flagged()`；
  `src/lib/colorSwatch.ts` 的归一化函数。

## ③ 三个 IPC = 三个事务 ⇒ 用「结构化回执 + 可重入」替代单事务回滚

- 建款向导一次点击做三件既有事（建档 → 写 SKU → 认款），每个都是独立 IPC 独立事务，
  **做不到单事务回滚**（D3 禁复合 handler）。验收改为：
  - 回执说清「建了哪个款（编码 + id）/ 写了几条 SKU / 几条失败 / 关联上没有」——
    不说「成功」这种一句话；
  - 可重入 = 再点一次不重复建款、不撞唯一键：建档撞编码明说「换个编码」；
    SKU 那步先按 (color,size) 取既有行传 `id` 走**更新**路径（无 id 时 `variantUpsert`
    撞同名直接抛）。
- 图片采纳（`shop-item-image-fetch`）同理：下载失败**不外抛**（建档/关联已经写进去了，
  坏一张图不能让用户以为「没建上」），只在回执里写「主图没设上（原因）」。
- **UI 联合类型不留不可达分支**：曾给主图回执加了 `'reused'`（采集行早有本地图），
  但向导只建新档（`image_id` 恒 0）⇒ 该分支在向导流程不可达，已删。
  自检问法：「这个状态在产品里达得成吗？达不成就别写进联合类型」。

## 色图采纳与订单回流是同一份款色解析

色图采纳为款色绑定图走 `ensureStyleByCode` + `ensureStyleColor` + `setImageStyleColor`
（`electron/order-db.ts`，订单回流 `autoAssignByMap` 用的同一批函数），**只补空**
（已绑图的款色不换图）。引第二套款色解析 = 两张表的色会对不上。

取证：`electron/product-handlers.ts` 的 `shop-item-image-fetch`；
`electron/product-db.ts` 的 `adoptProductImageIfEmpty`（主进程判空，不靠渲染层自觉）；
`scripts/shop-item-db-smoke.cjs` 的色图采纳用例（含「换一个没绑过图的色照样绑得上」的反向守卫）。
