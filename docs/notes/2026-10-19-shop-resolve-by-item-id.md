# 认店补第五级：商品ID 反查采集快照（2026-10-19）

> 一句话：店铺原文四级证据（URL / storeId / 店名 / 桶键记忆）全落空时，用**订单行本来就带着的商品ID**
> 去 `pl_shop_items` 反查"这个商品当初归在哪家已登记店"。唯一命中才用，多店歧义/店已删一律回到"未归一"。

## 一、为什么非加这一级

用户报障的形状是「映射配了却不生效」，而根因不在映射：

1. 用户登记店铺时把**店名**填进了「平台店铺ID」、URL 里的数字也填错（真库九店就是这样）；
2. `matchShopByStore` 的 1~3 级比的都是**当前登记值**，于是恒落空；
3. 第 4 级（桶键记忆）只在"用户保存店铺"那一次动作里建立，登记之后没再保存就永远没有；
4. 订单侧 `resolveOrderSku` 在 `if (!shopId) return null` 处**直接返回**——手上明明握着 itemId，一次都没查过。

于是症状被拆成两个互不相干的现象：订单进「未分类」、队列报「店铺未归一」。两边各自看都正常，
只能对着代码读才发现。而 `pl_shop_items` 的键本来就是 `(shop_id, store_key, item_id)`：
**商品ID 自己就能反证店**，这是比店名强得多的证据（店名是用户手填的，商品ID 是平台给的）。

## 二、纪律（三条，都是"不猜"）

| 边界 | 行为 | 理由 |
|---|---|---|
| 只认 `shop_id > 0` 且 `JOIN sk_shops` 命中 | 店被删 ⇒ 不命中 | 悬空 `shop_id` 比未登记桶**更难查**（界面显示店名、认款写不进去） |
| 同一 itemId 命中**多家**店 | 返回 0（分歧即无证据） | 按 id 最小挑一个 = 让系统替人下结论，错挂还查不出 |
| 只作**末级兜底** | 原文归一成功就不查 | 人填的归一永远压过推断；也避免多一次查询 |

⚠️ 与「同名唯一自动命中（`autoShopByKey`）」的差别：那条是**建议**，永不自动落库（G6）；
这一条是"这个商品当初就在这家店的名下"的事实记录，因此与人工归一同样当**已认店**使用。

## 三、改动落点（4 处 + 1 个纯函数参数）

| 位置 | 改动 |
|---|---|
| `electron/shop-item-db.ts` `shopIdByItemIds` / `shopIdByItemId` / `itemShopIndex` | 新增反向查询：批量（帧）/ 单条（订单）/ 全量索引（队列，按需加载），歧义规则三处同一 |
| `electron/shop-item-db.ts` `upsertShopItems` | 帧四级证据落空时，用**帧内 itemId** 反查；命中则 `shop_id=该店`、`store_key=''` |
| `electron/product-db.ts` `resolveOrderSku` | 认店顺序改为 人工归一 → 同名唯一 → **商品ID 反查**；`!shopKey` 不再直接判死（有 itemId 仍可认） |
| `electron/product-db.ts` `resolveShopRef` | 新增可选 `itemId` 参数，同样末级兜底（回流写映射走这一条） |
| `electron/order-db.ts` `skuBackfillFromOrder` | 把已在手的 `itemId` 传给 `resolveShopRef`（不传 = 白丢证据） |
| `electron/shopSku.ts` `buildQueueView` / `product-db.shopSkuQueue` | 队列认店加同一级（可选 `resolveShopByItemId`），**必须在剔除已关联之前**认店——否则"其实已配映射"的行还挂在待办里 |

## 四、守卫（全部实跑 + 变异验证）

- `tests/shopSku.spec.ts` +4：反查认店 / 反查后计入 `mapped` / 人工归一优先且不白查 / 反查不出仍报未归一
- `scripts/shop-item-db-smoke.cjs` +3：帧无店铺身份仍归店（且新商品跟着归）/ 多店歧义落桶 / 店被删不命中
- `scripts/product-sku-smoke.cjs` +5：订单**当场归款**（图挂到款色）/ `resolveShopRef` 须带 itemId / 回流不再 `shopUnresolved` / 歧义不写映射 / 队列剔除先认店
- 变异三条各自只红目标断言：去掉 `resolveOrderSku` 末级 ⇒ ①红；队列不用反查 ⇒ ⑤红；歧义改成 `shops[0]` ⇒ 歧义条红

## 五、它**不解决**什么（别把这条当万能）

1. **前提是这个商品曾在"已登记的店"里采到过**。采集行本身落在未登记桶（当时就没认出店）⇒ 反查出来还是 0。
2. **新商品第一次进来**时采集表里没有它 ⇒ 仍回落原文/AI，这一单还要人。
3. 只解决"认店"，**不解决"多色逐色配映射"**（向导恒写 `spec='*'`）。
4. 队列行不区分"原文归一"与"反查认店"（`QueueRow` 没有证据来源字段）⇒ 界面看不出这个店是怎么认出来的。
   要做"证据可见"得加字段 + 改 UI，本轮刻意没做。
