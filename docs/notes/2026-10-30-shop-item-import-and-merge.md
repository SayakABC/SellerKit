# 店铺商品：采集入库、保底导入与面板改造：41 条结论（蒸馏自 5 篇，2026-10-13 ~ 2026-10-16）

> **蒸馏笔记**：由 5 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/2026-10-30-shop-item-import-and-merge.md`
> 原文可取回：`git show b5df35c:docs/notes/2026-10-30-shop-item-import-and-merge.md`
> 原文可取回：`git show b5df35c:docs/notes/2026-10-30-shop-item-import-and-merge.md`
> 原文可取回：`git show b5df35c:docs/notes/2026-10-30-shop-item-import-and-merge.md`
> 原文可取回：`git show b5df35c:docs/notes/2026-10-30-shop-item-import-and-merge.md`

## 1. 保底通道（手贴商品 ID）与采集帧共用同一写函数，不另开第二套插入逻辑

**结论**：扩展端选择器全落空时（后台改版 / 类名漂移），用户从卖家后台复制商品 ID 贴进来，由 SellerKit 侧新通道 `shopItemsImport` 落库。**这条通道与采集帧 `POST /ae/shop-items/ingest` 共用同一写函数 `upsertShopItems`**，仅靠 `pl_shop_items.source` 列的 `manual` / `scrape` 两个值在表上分得开。不在保底通道里另写一套插入逻辑，理由与认款"只走一条 `commitMap`"一致：**第二套写路径 = 第二套失败语义 + 第二套计数口径**，迟早两边对不上。

**取证**：`upsertShopItems`；`POST /ae/shop-items/ingest`；`pl_shop_items.source` 的 `manual` / `scrape`。

**源**：`2026-10-13-shop-item-manual-import`（2026-10-13）

---

## 2. 新通道的契约在五处同步，由 `npm run verify` 强制计数相等

**结论**：契约五处同步 —— handler（`shop-item-handlers.ts`）/ preload / `types.ts`（`ShopItemManualImportPayload`）/ `ipc.ts`（接口 + 顶层包装）/ `api.ts`（`shopItemsImport`）—— `npm run verify` 强制计数相等。

**取证**：`shop-item-handlers.ts`、`types.ts` 的 `ShopItemManualImportPayload`、`ipc.ts`、`api.ts` 的 `shopItemsImport`；`npm run verify`。

**源**：`2026-10-13-shop-item-manual-import`（2026-10-13）

---

## 3. `parseManualIds` 跨分隔符切分并去重，桩给"恒同输出"会让去重守卫恒绿

**结论**：`parseManualIds` = `text.split(/[\n,，\s]+/)` → 去空 → 去重（Set）。只认"应被造出不同结果"的输入，喂两个相同 ID 也会被去重 ⇒ 桩给"恒同输出"会让去重守卫恒绿。

**取证**：已在 `goods:ui` 里用 `999000111, 999000222\n999000333\n999000222` 造"重复 + 跨分隔符"的干扰项，断言 `ids.length === 3`。

**源**：`2026-10-13-shop-item-manual-import`（2026-10-13）

---

## 4. 空输入不调 IPC，且该守卫已变异复核证伪

**结论**：`submitManualImport` 在 `ids.length === 0` 时直接给校验错、关框、不往下走。

**取证**：**变异复核**：把该守卫改成 `if (false && !ids.length)` 重建 dist 复跑 ⇒ 断言 `空输入不调 IPC` 转红（`calls=1`）⇒ 守卫非恒绿。

**源**：`2026-10-13-shop-item-manual-import`（2026-10-13）

---

## 5. 归属店铺默认 = 未登记桶（shopId=0）

**结论**：归属店铺默认 = 未登记桶（`shopId=0`）：下拉首项 `<option :value="0">未登记桶（待登记）</option>`，渲染层不拼假 store；落库时 `getShop` 找不到 0 即走未登记桶（`store_key` 为空）。

**取证**：`<option :value="0">未登记桶（待登记）</option>`；落库路径 `getShop`。

**源**：`2026-10-13-shop-item-manual-import`（2026-10-13）

---

## 6. 保底入口在 PoolPane，提交成功后与采集行走同一条刷新链

**结论**：`PoolPane` 入口：商品段工具条加「手贴商品ID」按钮 → 弹层（店铺下拉 + 文本框 + 提交 + 校验错 + 成功自动关闭）。成功提交后 `loadShopItems()` 刷新，列表立即多出这几行 ⇒ 与采集行同一个下游读者。

**取证**：`PoolPane`；提交后调 `loadShopItems()`。

**源**：`2026-10-13-shop-item-manual-import`（2026-10-13）

---

## 7. 【历史记录】保底按钮第一版只挂在采集工具条里，零采集时按钮跟着消失

**结论**：【历史记录】按钮第一版只挂在采集工具条里，而那整条工具条是 `<template v-if="itemStats.total > 0 || itemRows.length">`（`PoolPane.vue`）—— **零采集时工具条不渲染，保底按钮也就跟着不见了**。而"零采集"恰恰是扩展选择器全落空、最需要退路的时刻。修法与判据：退路入口在**两处**都要有：采集工具条（有数据时）+ 接入引导空态（零数据时），共用 `openManualImport`，`data-act` 前缀区分归属（`items-manual-import` / `items-manual-import-empty`）；断言用 `reportReachable`（判"用户真点得到"，不是"DOM 里有"）+ 零样本夹具。

**取证**：`<template v-if="itemStats.total > 0 || itemRows.length">`（`PoolPane.vue`）；为什么冒烟没抓到：**假桥永远有商品行**，夹具只复刻了"有数据"这个合理形状，没复刻"零数据"这个生产形状 ⇒ 守卫恒绿。补 `__smokeEmptyItems` 零样本后才现形。

**源**：`2026-10-13-shop-item-manual-import`（2026-10-13）

---

## 8. 可达性断言前必须关掉残留的模态，否则 `covered-by` 是状态污染不是布局 bug

**结论**：⚠️ 可达性断言前**必须关掉残留的模态**。

**取证**：实测第一次跑出来 `covered-by TH`，命中栈是 `TH > TABLE.iw-sku > ASIDE.wb-drawer > DIV.wb-mask > 保底入口` —— 是**上一步建款向导的抽屉没关**，蒙层盖住了一切。模态打开时它后面的东西本就不可点，那是状态污染不是布局 bug（`.click()` 会绕过命中测试，所以只有可达性断言会红）。

**源**：`2026-10-13-shop-item-manual-import`（2026-10-13）

---

## 9. 与 P5 扩展端是主路径 / 退路关系，同一张表、同一下游

**结论**：P5 扩展端（`SellerKitExtensions/extensions/ae-profit` v0.2.0）做**选择器稳健化 + 列表/详情分级 + 有界全店批量**，是主路径；本保底通道是**主路径全落空时的退路**，两者写入同一张表、共用同一下游（认款 / 建款向导），所以"贴 ID"进来的行，后续认款、采纳图、建款全部照常工作。

**取证**：`SellerKitExtensions/extensions/ae-profit` v0.2.0。

**源**：`2026-10-13-shop-item-manual-import`（2026-10-13）

---

## 10. 采集快照只存平台事实，人的决定全部显式

**结论**：三条纪律与「采集快照」的定位一致：**快照只存平台事实，人的决定全部显式**。

**取证**：`docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md` P3/P4 落地（`ShopItemWizard.vue` + `shop-item-image-fetch`）。

**源**：`2026-10-13-shop-item-wizard-discipline`（2026-10-13）

---

## 11. 预填值只能来自采集事实，且解析只在落库时做一遍

**结论**：向导预填的标题 / 类目 / SKU 矩阵全部来自 `pl_shop_items` 行；系统发号走 `product-next-code`（复用 `nextStyleCode`，不新增发号口径）。SKU 的 props 解析（`Color:Red;Size:L` / `Red+M+China` 两种形式）放在**采集落库时**（`normalizeIngestSku` → `parseSkuProps`，与订单侧同一函数）。渲染层再解析一遍就是第二套口径，两边一漂，向导预填的色/码与订单归类的色/码会对不上。

**取证**：`electron/shop-item-db.ts` 的 `normalizeIngestSku`；`electron/ae-receiver.ts` 的 `POST /ae/shop-items/ingest` 调 `upsertShopItems`。

**源**：`2026-10-13-shop-item-wizard-discipline`（2026-10-13）

---

## 12. 色号促确认的判据是「归一化前后相等」，不是「像不像颜色」，且永不猜色名

**结论**：`normalizeColor` 认不出标准色名时**原样返回**（"4"→"4"、"Black"→"Black"）——这是订单归类既有的促确认机制，采集侧直接复用：向导对 `normalizeColor(c) === normalizeText(c)` 的行高亮 + 缩略图 + 说明「认不出标准色名，请人工核对」。**永不猜色名**（把 "4" 映射成某个颜色是造事实）；人也只需在发现错时改。

**取证**：`src/modules/goods/components/ShopItemWizard.vue` 的 `flagged()`；`src/lib/colorSwatch.ts` 的归一化函数。

**源**：`2026-10-13-shop-item-wizard-discipline`（2026-10-13）

---

## 13. 三个 IPC = 三个事务 ⇒ 用「结构化回执 + 可重入」替代单事务回滚

**结论**：建款向导一次点击做三件既有事（建档 → 写 SKU → 认款），每个都是独立 IPC 独立事务，**做不到单事务回滚**（D3 禁复合 handler）。验收改为：回执说清「建了哪个款（编码 + id）/ 写了几条 SKU / 几条失败 / 关联上没有」—— 不说「成功」这种一句话；可重入 = 再点一次不重复建款、不撞唯一键：建档撞编码明说「换个编码」；SKU 那步先按 (color,size) 取既有行传 `id` 走**更新**路径（无 id 时 `variantUpsert` 撞同名直接抛）。

**取证**：D3 禁复合 handler；`variantUpsert`。

**源**：`2026-10-13-shop-item-wizard-discipline`（2026-10-13）

---

## 14. 图片采纳下载失败不外抛，只在回执里写明

**结论**：图片采纳（`shop-item-image-fetch`）同理：下载失败**不外抛**（建档/关联已经写进去了，坏一张图不能让用户以为「没建上」），只在回执里写「主图没设上（原因）」。

**取证**：`shop-item-image-fetch`。

**源**：`2026-10-13-shop-item-wizard-discipline`（2026-10-13）

---

## 15. 【历史记录】主图回执的 `'reused'` 联合类型分支在向导流程不可达，已删

**结论**：【历史记录】**UI 联合类型不留不可达分支**：曾给主图回执加了 `'reused'`（采集行早有本地图），但向导只建新档（`image_id` 恒 0）⇒ 该分支在向导流程不可达，已删。自检问法：「这个状态在产品里达得成吗？达不成就别写进联合类型」。

**取证**：`'reused'`；向导 `image_id` 恒 0。

**源**：`2026-10-13-shop-item-wizard-discipline`（2026-10-13）

---

## 16. 色图采纳与订单回流是同一份款色解析，且只补空

**结论**：色图采纳为款色绑定图走 `ensureStyleByCode` + `ensureStyleColor` + `setImageStyleColor`（`electron/order-db.ts`，订单回流 `autoAssignByMap` 用的同一批函数），**只补空**（已绑图的款色不换图）。引第二套款色解析 = 两张表的色会对不上。

**取证**：`electron/product-handlers.ts` 的 `shop-item-image-fetch`；`electron/product-db.ts` 的 `adoptProductImageIfEmpty`（主进程判空，不靠渲染层自觉）；`scripts/shop-item-db-smoke.cjs` 的色图采纳用例（含「换一个没绑过图的色照样绑得上」的反向守卫）。

**源**：`2026-10-13-shop-item-wizard-discipline`（2026-10-13）

---

## 17. 两个采集层级各带一半字段，旧实现的全字段覆盖把另一半静默清空

**结论**：`pl_shop_items` 的行由**两个采集层级**写入，各带**一半字段**：列表轻采（本页 / 本店全部 / 店铺主页）带 itemId / title / imageUrl / priceText / category / status / url，不带 skus（`[]`）；详情重采（「采 SKU」）带 itemId / skus，不带其余全部。而 `upsertShopItems` 旧实现 = **全字段覆盖** ⇒ 后跑的那次把另一次采到的字段**静默清空**，两个方向都可达：「采 SKU」成功后：标题 / 图 / 价 / 状态 / URL 被清空（详情帧里没有它们）；全店重采后：SKU 矩阵被清空（列表帧 `skus: []`）。回执照报 inserted/updated 成功；界面上表现为"那个字段没采到"，实际是**被覆盖没了**。

**取证**：`upsertShopItems` 旧实现；两个方向均不报错（回执是成功），只能从"字段变空"反推。

**源**：`2026-10-15-shop-item-partial-frame-merge`（2026-10-15）

---

## 18. 修法：空值不覆盖，非空照常覆盖，SKU 按"有没有行"判

**结论**：`upsertShopItems` 对已存在行先查旧行，**空值不覆盖**：空值语义 = 「**这次没采到**」，不是「平台上这个字段没了」（后者不存在这种事件）；非空新值**照常覆盖** —— 是"空值不覆盖"，不是"一律不覆盖"；SKU 按"**有没有行**"判（`skus.length ? 新 : 旧`），不是按字符串非空。

**取证**：`upsertShopItems`。

**源**：`2026-10-15-shop-item-partial-frame-merge`（2026-10-15）

---

## 19. 部分帧合并的守卫 3 例，前两例在旧代码上逐条打红

**结论**：`npm run shop-item:smoke` 三例：① 详情帧（只有 SKU）不清空列表帧的标题 / 图 / 价，且 SKU 真写进去；② 列表重采（帧里 SKU 为空）不清空 SKU 矩阵，且标题非空照常覆盖；③ 详情帧带**新** SKU ⇒ 覆盖旧矩阵 —— 防"有值就跳过"的坏修法（该例在旧代码上也是绿的，它守的不是旧缺陷而是**新实现**不许退化成"一律不覆盖"）。

**取证**：`npm run shop-item:smoke`。

**源**：`2026-10-15-shop-item-partial-frame-merge`（2026-10-15）

---

## 20. 夹具用生产形状的两种帧，不是手工拼"合理形状"

**结论**：夹具用**生产形状**的两种帧（`frame({name:'层级店'}, [{itemId, skus:[{props:'Color:Black;Size:L', price:'US $1.20'}]}])`），不是手工拼"合理形状"。

**取证**：`frame({name:'层级店'}, [{itemId, skus:[{props:'Color:Black;Size:L', price:'US $1.20'}]}])`。

**源**：`2026-10-15-shop-item-partial-frame-merge`（2026-10-15）

---

## 21. 为什么之前没人发现：两个方向都没有机会触发、且都不报错

**结论**：三条：① 「采 SKU」在此前从未成功采过（真库 8 行 `sku_json` 全 `[]`）⇒ 方向①没有机会触发；② 方向②（全店重采清 SKU）要"先采过 SKU、再重采整页"才现形，用例与流程都没走到；③ 两个方向都**不报错**（回执是成功），只能从"字段变空"反推。

**取证**：真库 8 行 `sku_json` 全 `[]`。

**源**：`2026-10-15-shop-item-partial-frame-merge`（2026-10-15）

---

## 22. 同族前例：店铺编辑"漏传字段 = 静默清空"

**结论**：同族前例：店铺编辑"漏传字段 = 静默清空" —— 同一实体多个写入者 + 全量提交。

**取证**：店铺编辑。

**源**：`2026-10-15-shop-item-partial-frame-merge`（2026-10-15）

---

## 23. 计划 §3.2 的"upsert 覆盖快照"已改注「只覆盖非空」

**结论**：`docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md` §3.2（原写"upsert 覆盖快照"，已改注「只覆盖非空」）。

**取证**：`docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md` §3.2。

**源**：`2026-10-15-shop-item-partial-frame-merge`（2026-10-15）

---

## 24. 「采集到 8 条、列表却空白」是两个独立缺陷叠加

**结论**：用户报的「采集到 8 条、列表却空白」有**两个独立缺陷**叠在一起。广播桥（`2026-10-15-ae-items-ingested-broadcast.md`）修的是"采集后已打开页面零点击可见"；但真让 8 行消失的是**读链自己**。所以「重启过了还是看不到」与广播结论不矛盾 —— 坏的是两条不同的链。

**取证**：`2026-10-15-ae-items-ingested-broadcast.md`。

**源**：`2026-10-15-shop-items-list-tristate`（2026-10-15）

---

## 25. 根因：preload 把缺省 shopId 压成 0，而 0 是"未登记桶"过滤条件

**结论**：`electron/preload.ts` 的 `shopItemsList` 把缺省 `shopId` 归一成 `0` —— `Number(payload?.shopId) || 0` —— 而 `0` 在数据层是**「未登记桶」过滤条件**（`listShopItems`：`shopId < 0 → shop_id = 0`；有限 ≥0 → 精确等于；`undefined` → 不过滤）。「货与成本 › 店铺商品」的调用点（`src/modules/goods/useSkuPool.ts:488`）**本来就不传 shopId（= 看全部）**，被压成桶过滤 ⇒ **已归店的 8 行（`shop_id=4`）手动刷新也一条都不显示**。

**取证**：`electron/preload.ts` 的 `shopItemsList`；`Number(payload?.shopId) || 0`；`src/modules/goods/useSkuPool.ts:488`；`listShopItems`。

**源**：`2026-10-15-shop-items-list-tristate`（2026-10-15）

---

## 26. 契约是三态：缺省（不过滤）/ ≤0（未登记桶）/ >0（指定店），preload 原样透传

**结论**：契约 = **三态**：缺省（不过滤）/ ≤0（未登记桶）/ >0（指定店）。preload 原样透传：
`shopId: Number.isFinite(Number(payload?.shopId)) ? Number(payload?.shopId) : undefined`。

**取证**：`shopId: Number.isFinite(Number(payload?.shopId)) ? Number(payload?.shopId) : undefined`。

**源**：`2026-10-15-shop-items-list-tristate`（2026-10-15）

---

## 27. `shopItemsImport` 刻意不改，同一个字段名在两个通道里语义不同

**结论**：`shopItemsImport` 刻意**不**改（`|| 0` 保持）：它缺省的语义 = 用户下拉里显式选的「未登记桶」（见 `importManualItems` 文档）—— **同一个字段名在两个通道里语义不同，各自对齐各自的下游**。

**取证**：`shopItemsImport`；`importManualItems`。

**源**：`2026-10-15-shop-items-list-tristate`（2026-10-15）

---

## 28. 通用教训：`Number(x) || 0` 把缺省 / 0 / 负数三种语义压成一个

**结论**：⭐ 通用教训：`Number(x) || 0` 这类"归一"把**缺省、0、负数**三种语义压成一个。凡参数下游是"缺省 = 特殊行为"的（不过滤 / 全表 / 第一个），preload 只许透传、不许补缺省。（同族前例：`2026-10-04-preload-payload-shape.md` —— 形状错了是静默失效。）

**取证**：`2026-10-04-preload-payload-shape.md`。

**源**：`2026-10-15-shop-items-list-tristate`（2026-10-15）

---

## 29. 三态的通道层守卫 5 条

**结论**：`npm run ipc:shape:smoke` ⑩（真 preload + 假 ipcMain + 真库）五条：① 发出去的载荷 `shopId === undefined`（压 0 的写法立刻红）；② 不过滤时看到全部（≥2 行）；③ 点名店只回该店（逐行 shopId 匹配）；④ 未登记桶回 0；⑤ 全新库（DROP 店铺表后）也不抛错（连 fresh-db 守卫一起钉）。

**取证**：`npm run ipc:shape:smoke` ⑩。

**源**：`2026-10-15-shop-items-list-tristate`（2026-10-15）

---

## 30. 真机复验：8 行全出 + 状态条口径

**结论**：真机复验：真实 userData 克隆 + CDP 驱动 → 8 行全出 + 状态条「已采 8 个商品（已认款 1）」。

**取证**：状态条文案「已采 8 个商品（已认款 1）」。

**源**：`2026-10-15-shop-items-list-tristate`（2026-10-15）

---

## 31. 同一实体只在一个段里维护：第三段恒只列未认款

**结论**：**同一实体只在一个段里维护**。采集快照（`pl_shop_items`）与认款映射（`pl_shop_sku`）是两套互不联动的数据，但**认款这件事写的就是映射行** ⇒ 第三段改名「**待关联采集商品**」且**恒只列未认款**（渲染层恒传 `onlyUnconfirmed: true`，服务端过滤）。已认款的采集商品只在「已建立映射」里出现。原先同一商品在两段同屏出现，是用户报的"页面不协调"的根因之一。

**取证**：`pl_shop_items` / `pl_shop_sku`；`onlyUnconfirmed: true`；`data-act` 名一个不动：`sub-queue` 待关联队列 / `sub-mapped` 已建立映射 / `sub-items` **待关联采集商品**。

**源**：`2026-10-16-shop-items-panel-rework`（2026-10-16）

---

## 32. 徽标口径 = 待办数，状态条 = 全库事实

**结论**：**徽标口径 = 待办数，状态条 = 全库事实**。分段徽标报 `total - confirmed`（未认款数），与列表口径一致（否则用户看到"徽标 3、表里 2 行"只会以为漏了数据）；采集状态条仍报全库（已采 N 个 / 已认款 M），它回答的是"采了多少"这一事实，不随当前段过滤。

**取证**：`total - confirmed`。

**源**：`2026-10-16-shop-items-panel-rework`（2026-10-16）

---

## 33. 改 / 删一律按行 id，不按 `item_id`

**结论**：**改 / 删一律按行 id**，不按 `item_id`。`pl_shop_items` 的唯一键是 **`(shop_id, store_key, item_id)` 三元组**：同店重复采集是**同一行 UPDATE**（幂等，只覆盖非空字段；见 `docs/notes/2026-10-30-shop-item-import-and-merge.md`），而同一 `item_id` 在**两家店 / 未登记桶下各是一行** ⇒ 按 `item_id` 删会误删别家那份。

**取证**：`pl_shop_items` 唯一键 `(shop_id, store_key, item_id)`。

**源**：`2026-10-16-shop-items-panel-rework`（2026-10-16）

---

## 34. 人工改 SKU 矩阵不动 `scraped_at` / `raw_json`

**结论**：**人工改 SKU 矩阵不动 `scraped_at` / `raw_json`**：人工修改不能冒充"重新采过"（状态条的"最近采集"会说假话）。重新采集时按"只覆盖非空"规则**会**覆盖人工修改 —— 这一点写在确认弹层与编辑器里，不靠用户猜。

**取证**：`scraped_at` / `raw_json`。

**源**：`2026-10-16-shop-items-panel-rework`（2026-10-16）

---

## 35. 全量提交必须原样带回 `imageUrl`（色图）

**结论**：**全量提交必须原样带回 `imageUrl`（色图）**：`sku_json` 每行 `{color,size,price,imageUrl}`，提交时漏传 = 静默清空色图（建款向导"每色采纳"的输入随之消失，且不报错）。行级消毒复用采集那条 `normalizeIngestSku`（color/size/price 全空的行跳过），不新写一套。

**取证**：`sku_json`；`normalizeIngestSku`。

**源**：`2026-10-16-shop-items-panel-rework`（2026-10-16）

---

## 36. 面板最终形态（代码口径）

**结论**：面板最终形态 —— 三段控件 `sub-queue` 待关联队列 / `sub-mapped` 已建立映射 / `sub-items` **待关联采集商品**（`data-act` 名一个不动）；items 表列：勾选 / 图 / **商品ID**（`nowrap` + 省略号 + `title` 全文，16 位 ID 折行会把整列撑高）/ **SKU**（色码文本「黑/L、4/M」+「改」或「补」）/ 采集时间 / 状态 —— **售价列撤掉**；状态列两态：未认款（默认）/ 店铺未登记（整行浅底 + 禁用 + 「去登记」出口）+ **行内「删除」**；工具条：直连（分栏）/ 批量关联 / 新建款并关联 / 清空选择 / 手贴商品ID / 打开店铺 / 计数，**没有**「只看未认款」勾选框（改为恒开）；空态：「采集的都认款完了」+ 指向「已建立映射」（不再是一张空表）。

**取证**：`data-act` 名；`nowrap` + 省略号 + `title` 全文。

**源**：`2026-10-16-shop-items-panel-rework`（2026-10-16）

---

## 37. 面板改造的取证命令与变异复核输出

**结论**：面板改造门禁全绿，且新断言经变异复核证伪（把 `useSkuPool.ts` 的 `onlyUnconfirmed: true` 改回 `false` → `npm run build` → `goods:ui` **立刻红两条核心断言**）。

**取证**：

```bash
npm run build && npm run goods:ui     # 主流程三遍：310 条 PASS
npx vitest run                        # 39 文件 699 例
env -u ELECTRON_RUN_AS_NODE npx electron --no-sandbox --disable-gpu scripts/preload-ipc-shape-smoke.cjs
                                      # ⑪ 段：改矩阵 / 删行 / 不动 scraped_at / 映射不联动删（55 项）
```

```

FAIL 切到「待关联采集商品」段：只剩未认款两行（7002 已认款…） | rows=[7001, B0XYZ1234, 7003]
FAIL ⭐ 已认款的 7002 不在本段出现（同一商品只在一个段里维护…） | B=still-here
```

（后续 item-wizard 步随之级联红 —— 那一段依赖"段里只有一行可勾选"的原点态，属预期。）还原后 `git diff` 无残留、重建后全绿。

**源**：`2026-10-16-shop-items-panel-rework`（2026-10-16）

---

## 38. ⭐⭐ 断言查的那张表只在某个分段下才在 DOM 里

**结论**：⭐⭐ **断言查的那张表只在某个分段下才在 DOM 里**：`mappedRow()` 查的是 `mapped-table`，而 items 段的断言里顺手断言"已认款的出现在映射表" ⇒ 不切段就是恒 `missing`。**跨段落断言前必须先切到那个段**（切完记得切回来，否则后续步骤的前置态变了）。

**取证**：`mapped-table`。

**源**：`2026-10-16-shop-items-panel-rework`（2026-10-16）

---

## 39. ⭐⭐ `table-layout: fixed` 下列宽由 `thead` 决定，列宽选择器必须同时命中 th 与 td

**结论**：⭐⭐ **`table-layout: fixed` 下列宽由 `thead` 决定**：状态列实测 150px，而 CSS 写的是 `width: 108px` —— 因为选择器只写了 `td.gd-c-ops`，`th` 没命中。**列宽选择器必须同时命中 th 与 td**（去掉元素限定符 `.gd-items .gd-c-ops` 即可）。这类"声明没生效"只能靠几何取证（`getBoundingClientRect`），看 CSS 源码怎么看都对。

**取证**：实测 150px vs `width: 108px`；`.gd-items .gd-c-ops`；`getBoundingClientRect`。

**源**：`2026-10-16-shop-items-panel-rework`（2026-10-16）

---

## 40. ⚠️ 注入脚本的注释里不能有反引号

**结论**：⚠️ **注入脚本的注释里不能有反引号**（模板串提前闭合，`node --check` 报 `Unexpected identifier`）。这条本仓已记过一次，本次又踩 —— 写注释时用「」而不是反引号。

**取证**：`node --check` 报 `Unexpected identifier`。

**源**：`2026-10-16-shop-items-panel-rework`（2026-10-16）

---

## 41. ⚠️ 文案改了要过 `tests/uxEntryNames.spec.ts`，分段控件走第三类判定且必须逐条写理由

**结论**：⚠️ **文案改了要过 `tests/uxEntryNames.spec.ts`**：空态新文案"认款了的采集商品在「已建立映射」里维护"让扫描型守卫报悬空入口名。该守卫是**三选一**判定（宿主模块名 / 岛 displayName / `ALLOWED_NON_ENTRY`），同页分段控件走第三类且**必须逐条写理由**（已补「已建立映射」，与「待关联队列」同例）。

**取证**：`tests/uxEntryNames.spec.ts`；`ALLOWED_NON_ENTRY`。

**源**：`2026-10-16-shop-items-panel-rework`（2026-10-16）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-13-shop-item-manual-import.md` | 2026-10-13 | §1 / §2 / §3 / §4 / §5 / §6 / §7 / §8 / §9 |
| `2026-10-13-shop-item-wizard-discipline.md` | 2026-10-13 | §10 / §11 / §12 / §13 / §14 / §15 / §16 |
| `2026-10-15-shop-item-partial-frame-merge.md` | 2026-10-15 | §17 / §18 / §19 / §20 / §21 / §22 / §23 |
| `2026-10-15-shop-items-list-tristate.md` | 2026-10-15 | §24 / §25 / §26 / §27 / §28 / §29 / §30 |
| `2026-10-16-shop-items-panel-rework.md` | 2026-10-16 | §31 / §32 / §33 / §34 / §35 / §36 / §37 / §38 / §39 / §40 / §41 |
