# 保底通道：手贴商品 ID 走与采集帧同一写路径（source='manual'）

## 结论

扩展端选择器全落空时（后台改版 / 类名漂移），用户从卖家后台复制商品 ID 贴进来，由
SellerKit 侧新通道 `shopItemsImport` 落库。**这条通道与采集帧 `POST /ae/shop-items/ingest`
共用同一写函数 `upsertShopItems`**，仅靠 `pl_shop_items.source` 列的 `manual` / `scrape`
两个值在表上分得开。

不在保底通道里另写一套插入逻辑，理由与认款"只走一条 `commitMap`"一致：**第二套写路径 = 第二套
失败语义 + 第二套计数口径**，迟早两边对不上。

## 关键设计点（取证）

- **契约五处同步**：handler（`shop-item-handlers.ts`）/ preload / `types.ts`（`ShopItemManualImportPayload`）/
  `ipc.ts`（接口 + 顶层包装）/ `api.ts`（`shopItemsImport`）—— `npm run verify` 强制计数相等。
- **`parseManualIds`**：`text.split(/[\n,，\s]+/)` → 去空 → 去重（Set）。只认"应被造出不同结果"的两个输入，
  喂两个相同 ID 也会被去重 ⇒ 桩给"恒同输出"会让去重守卫恒绿，已在 `goods:ui` 里用
  `999000111, 999000222\n999000333\n999000222` 造"重复 + 跨分隔符"的干扰项，断言 `ids.length === 3`。
- **空输入不调 IPC**：`submitManualImport` 在 `ids.length === 0` 时直接给校验错、关框、不往下走。
  **变异复核**：把该守卫改成 `if (false && !ids.length)` 重建 dist 复跑 ⇒ 断言 `空输入不调 IPC` 转红
  （`calls=1`）⇒ 守卫非恒绿。
- **归属店铺默认 = 未登记桶（shopId=0）**：下拉首项 `<option :value="0">未登记桶（待登记）</option>`，
  渲染层不拼假 store；落库时 `getShop` 找不到 0 即走未登记桶（`store_key` 为空）。
- **`PoolPane` 入口**：商品段工具条加「手贴商品ID」按钮 → 弹层（店铺下拉 + 文本框 + 提交 + 校验错 +
  成功自动关闭）。成功提交后 `loadShopItems()` 刷新，列表立即多出这几行 ⇒ 与采集行同一个下游读者。

## 踩过的坑：退路入口被"有数据"挡住（真机手验才发现）

按钮第一版只挂在采集工具条里，而那整条工具条是 `<template v-if="itemStats.total > 0 || itemRows.length">`
（`PoolPane.vue`）—— **零采集时工具条不渲染，保底按钮也就跟着不见了**。而"零采集"恰恰是
扩展选择器全落空、最需要退路的时刻。

为什么冒烟没抓到：**假桥永远有商品行**，夹具只复刻了"有数据"这个合理形状，没复刻"零数据"
这个生产形状 ⇒ 守卫恒绿。补 `__smokeEmptyItems` 零样本后才现形。

修法与判据：

- 退路入口在**两处**都要有：采集工具条（有数据时）+ 接入引导空态（零数据时），共用 `openManualImport`，
  `data-act` 前缀区分归属（`items-manual-import` / `items-manual-import-empty`）。
- 断言用 `reportReachable`（判"用户真点得到"，不是"DOM 里有"）+ 零样本夹具。
- ⚠️ 可达性断言前**必须关掉残留的模态**：实测第一次跑出来 `covered-by TH`，命中栈是
  `TH > TABLE.iw-sku > ASIDE.wb-drawer > DIV.wb-mask > 保底入口` —— 是**上一步建款向导的抽屉没关**，
  蒙层盖住了一切。模态打开时它后面的东西本就不可点，那是状态污染不是布局 bug（`.click()` 会绕过
  命中测试，所以只有可达性断言会红）。

## 与 P5 扩展端的关系

P5 扩展端（`SellerKitExtensions/extensions/ae-profit` v0.2.0）做**选择器稳健化 + 列表/详情分级 +
有界全店批量**，是主路径；本保底通道是**主路径全落空时的退路**，两者写入同一张表、共用同一下游
（认款 / 建款向导），所以"贴 ID"进来的行，后续认款、采纳图、建款全部照常工作。
