# 「速卖通店铺商品采集 → 商品↔产品映射维护」方案 · 审查稿

> **审查对象**：`docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md`（状态：待评审，未动任何代码）  
> **审查方式**：逐条核对方案中的代码取证（约 30 处 `文件:行`，全部实跑核对）→ 与 `AGENTS.md` / `docs/notes/2026-10-05-repo-hard-constraints.md` 硬约束对表 → git 工作区状态检查。本审查同样未动任何代码。  
> **日期**：2026-10-12

---

## 0. 一句话结论

**方案成立，可按修订清单开工。** 它自我定位的"已有能力的延伸而非新系统"经核对是准确的：接收端、落点表、认款写路径、店铺实体全部在产，新增面确实只有"1 个采集端点 + 1 张快照表 + `sk_shops` 1 列 + 右栏 1 个视图段 + 1 个建款向导"。

需要处理的是：**3 处 P1**（URL 精确匹配会在存量库大面积失配 / 未登记店撞唯一键 / 一个做不到的验收点）、**7 处 P2**、**3 处过度设计裁退**，以及开工前的 **1 个流程事项**（工作区 99 个文件未提交，含本方案要碰的多个文件）。

---

## 1. 取证核对（方案引用 vs 代码现实）

逐条实跑结果。**方案的取证质量是本仓罕见的高**——引用行号几乎全部精确：

| 方案引用                                                                                                                 | 核对结果                                                                                                                                                  |
| -------------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `ae-receiver.ts`：46211 / X-Ae-Token / body≤1MB / 单批≤100 / 60 次每分 / 路径白名单                                             | ✅ 逐字属实（`electron/ae-receiver.ts:22-35`；白名单当前 = GET `/ae/ping` + POST `/ae/ingest`，新 path 要加项）                                                         |
| 接收端随应用自启（`main.ts:37`）                                                                                               | ✅ 精确（`electron/main.ts:37` `require('./ae-receiver')`）                                                                                                |
| `ae-receiver-status` 通道可复用                                                                                           | ✅ 在产（`electron/ae-handlers.ts:55` + `preload.ts:663`；`AeReceiverStatus` 加 `lastItemsIngestAt` 字段仍要走契约同步，见 P2-6）                                       |
| `PROFIT_TRACKER.md` §5 通道协议 / §6.1 窄列+raw_json 快照 / §9 合规                                                            | ✅ 三节都在，且内容与方案描述一致（`docs/features/PROFIT_TRACKER.md:77 / 101-106 / 133-138`）                                                                           |
| `sk_shops` 无地址列、`platform×name_key` UNIQUE、`platform_shop_id` 部分唯一索引（`shop-db.ts:141-176`）                           | ✅ 精确（`electron/shop-db.ts:141-176`）；⚠️ 但已有 `site` 列（= 平台站点 RU/US，`ShopRegistryView.vue:278`），见 P3-5                                                   |
| `ensureShopColumns()` 补列模式（建表语句 + PRAGMA 两处同向）                                                                       | ✅ 属实（`shop-db.ts:178-193`）                                                                                                                            |
| 编辑不透传 = 静默清空（同 `platformShopId` 的坑）                                                                                  | ✅ 属实（`src/modules/goods/shopApi.ts:53-58` 注释原文）                                                                                                       |
| `pl_products`（`product-db.ts:98-113`）/ `pl_variants`（`:1612-1631`）/ `pl_shop_sku`（`:804-939`）/ `pl_images`（`:1633+`） | ✅ 四个行号全部精确                                                                                                                                            |
| 池/映射谓词互补不变式（`skuPoolSql` / `skuMappingSql`）                                                                          | ✅ 属实（`product-db.ts:929-939`）；"采集行进第三种群"的推理正确                                                                                                         |
| `landImageBuffer`（`product-handlers.ts:469`）/ `adoptOrderImages`（`:516`）                                             | ✅ 两个行号精确                                                                                                                                              |
| 认款写路径 `product-sku-map` → `upsertSkuMappings` + 回流 + 补色                                                              | ✅ 在产（`product-handlers.ts:386-413`；`reassignOrdersByItemIds` / `skuBackfillFromOrder` 都在 `order-db.ts`）                                               |
| 建款三连既有调用（`product-upsert` / `product-variant-upsert` / `product-sku-map`）                                            | ✅ 三个 handler 都在（`product-handlers.ts:139 / 434 / 386`）                                                                                                |
| 队列只含"订单里出现过的商品"                                                                                                      | ✅ 属实（`shopSkuQueue` 的输入 = `collectOrderRows(oi_orders)`，`product-db.ts:1164-1189`）                                                                    |
| `shopUnresolved` 不许写映射 / `hint-shops` 提示条形态                                                                          | ✅ 属实（`shopSku.ts:195-196`；`PoolPane.vue:82-91` `hint-shops` + `open-registry`）                                                                        |
| 分段控件两段 `sub-queue` / `sub-mapped`                                                                                    | ✅ 属实（`PoolPane.vue:23 / 35`）                                                                                                                          |
| 订单图去重：URL 指纹 → 内容指纹 → `SELECT *` 复用含 `styleColorId`                                                                  | ✅ 逐行属实（`order-handlers.ts:548-595`；`order-db.ts:551-558`）                                                                                             |
| `autoAssignByMap` / 39% `Picture color` 注释 / `setImageStyleColor`                                                    | ✅ 三处行号精确（`order-db.ts:1225-1246 / 1239 / 571`）                                                                                                        |
| `code` 与 `oi_styles.code` 共用序号池                                                                                      | ✅ 属实（`nextStyleCode()` 两边取 max+1，注释明写"防撞产品库唯一键"，`order-db.ts:630-648`）                                                                                |
| `importSheet.ts:156-170` 图片入口 + 导入 `color` 恒空                                                                        | ✅ 属实（`importSheet.ts:156-170 / 179`）                                                                                                                  |
| `IMAGE_COLUMN_KEYWORDS` 含「图片」/ `ITEM_ID_KEYS` 含「产品ID」                                                                | ✅ 属实（`orderClassifier.ts:201`；`shopSku.ts:43-44`）                                                                                                     |
| `orderRowSplitter` 的 `IMAGE_SEPS`/`ID_SEPS`/`parseInfoBlocks`                                                        | ✅ 都在（`orderRowSplitter.ts:44-69`）                                                                                                                     |
| `normalizeColor` 描述式、认不出原样保留                                                                                         | ✅ 属实（`orderClassifier.ts:104-113`）                                                                                                                    |
| 扩展仓库 `SellerKitExtensions` 存在、`content.js` 的 `lines[]` 无 img src                                                     | ✅ 属实（兄弟目录；`content.js:223-228` 只有 title/skuProps/qty/unitPrice/goodsAmount）                                                                           |
| `AeProfitView.vue` 状态行 + curl 样例                                                                                     | ✅ 属实（`AeProfitView.vue:66-103`）                                                                                                                       |
| `ShopProductView.vue:54-61` 热链 + `@error` 降级模式                                                                       | ✅ 属实                                                                                                                                                  |
| 「店铺登记」是真实入口名（文案守卫）                                                                                                   | ✅ `GOODS_TAB_LABEL.registry = '店铺登记'`（`tabs.ts:33`）                                                                                                   |
| `today:ui` 238 / `product:sku:smoke` 41 组断言                                                                          | ⚠️ 计数漂移：实测 `today-ui-smoke.mjs` 249 处 `report(`、`product-sku-smoke.cjs` 42 处 `check(`；且守认款链的 UI 冒烟是 **`goods:ui`**（认款 UI 在货与成本右栏），不是 `today:ui`——疑似笔误 |
| §8.9 样本 `芒果店长_783900_1791724889335.xlsx`                                                                             | ⚠️ 文件不在库；但同形夹具在（`tests/fixtures/mango-pending-orders.xlsx` 12 列 + `mangoPendingImport.spec.ts:143` 同形 URL），判据可改指夹具，见 P2-1                             |

---

## 2. 方案与基线对齐的点（做对了的，实现时别丢掉）

1. **不新开端口、不引 Native Messaging**——白名单加一个 path 是接收端最小改动，token/限流/大小上限全部原样继承。
2. **新表 `pl_shop_items` 而不是塞 `pl_shop_sku` 池**——对"池/映射互为补集"这条不变式的理解完全正确（`listSkuMappings`、队列 `mappedKeys`、`resolveOrderSku` 全依赖它）；"平台事实 vs 人的决定"两张表两种写入者的划分，与 ADR-002 主数据纪律同构。
3. **零新写口径**——认款/建款/图片采纳全部挂既有 handler；本审查因此能抓住 P1-3（有两条验收点其实做不到）。
4. **契约五处同步意识**（handler + preload + types.ts + ipc.ts + 界面）——正是 AGENTS.md §1.1 的要求；`shop_url` 全量提交透传的坑也主动点了。
5. **界面纪律全部对齐既有结论**：图列地板（2026-10-12 窄窗口教训）、`data-act` 一个不动、全零不占位、三态形状可辨、提示必须是入口。
6. **反候选清单（§5）质量高**——尤其"不自动建店/不自动认款/不用采集数据覆盖 manual/采集数据不直接写池"四条，条条对着本仓铁律。
7. **合规边界与 PROFIT_TRACKER §9 同构**（本人店铺、人工触发、限流、不无人值守翻页）。
8. **§8 的现状取证极扎实**——"订单图 URL 同时命中产品与颜色"这条证据（异色异 URL、同色同 URL）是真的能从代码里推出来，且它正好支撑"色级一直缺客观锚点"的判断。

---

## 3. 问题清单

### P1 — 开工前必须改方案

**P1-1　店铺匹配规则 1「URL 精确相等」会在存量库大面积失配（本方案最高的实用风险）**  
方案 §3.4 把 URL 精确相等作为第一匹配级。但登记 URL（人贴的）与采集帧 URL（扩展从页面拿的）在真实使用中几乎必然不同形：`/store/123456/index.html` vs `/store/123456` vs 带尾斜杠 / 带 `?spm=` / `http` vs `https`。失配的落点是 `shop_id=0` + 提示条——用户看着"我填了地址，怎么还没归位"，而提示条只会说"还没登记"。  
**修订**：匹配前做**店铺级 URL 归一**（提取 `/store/<id>` 段比对；大小写/尾斜杠/query 归一）。更进一步：URL 里带的就是 storeId，规则 1 与规则 2 对速卖通可以**合并成一条**（从 URL 提取 id → 比 `platform_shop_id`，复用既有稳定业务键，`shop-db.ts:199-205` 的部分唯一索引）——少一条匹配路径，也少一处会漂移的口径。placeholder/hint 必须写清期望形态。

**P1-2　未登记店的 `UNIQUE(shop_id, item_id)` 会互相撞键**  
§3.3① 表定义里未登记 = `shop_id=0`。两个**不同的**未登记店采到同一个 `item_id` 时，第二次 upsert 会覆盖第一家的 `store_key`——提示条（§4.4）会少数一家店、张冠李戴。  
**修订**：唯一键改 `UNIQUE(shop_id, store_key, item_id)`（登记店 `store_key` 为空串，不受影响；未登记店按归一名分开）。这是"未登记"这条必经路径上的坑，不是边角情况。

**P1-3　P3 验收点「建档+关联单事务回滚」做不到，别去追**  
「建档并关联」= `product-upsert` + `product-variant-upsert` + `product-sku-map` 三个 IPC 调用，各自独立事务；D3「零新写口径」又禁止加复合 handler。按现在的写法，P3 会拿一个永远达不到的验收点，且会**诱惑**有人去加复合 handler（破 D3）。  
**修订**：验收点改为「分步失败的**结构化回执**（哪步成了、哪步没成、建了几个 SKU、关联到哪个商品ID）+ **可重入**（失败后重点不重复建款）」。方案 §4.3 已规划结构化回执，把它接过来当验收判据即可。

### P2 — 实施时必须落

**P2-1　§8.9 的样本文件不在库，"R1 原风险关闭"表述过头**  
`芒果店长_783900_1791724889335.xlsx` 全仓找不到。订单侧的结论有同形夹具背书（`tests/fixtures/mango-pending-orders.xlsx` 12 列；`mangoPendingImport.spec.ts:143` 同形 URL），但"详情页 SKU 图是否同图像 ID"仍待首次真实采集复验——方案 §8.2 自己也是这么写的，§8.9.5 却写成"原风险关闭"。  
**修订**：判据改指仓库内夹具；R1 状态保持"订单侧已关闭（附夹具）、详情页侧待首采复验"。

**P2-2　`img_key` 的落点与"唯一实现"没定义**  
§8.3 的 L1/L2 都要 `img_key`，但没说它加在哪些表（`oi_images`？`pl_shop_items`？`skus[].imageUrl` 行内？）、由谁写、哪个函数算。现状 `fingerprintUrl` 是 `order-handlers.ts:69` 的**私有函数**。  
**修订**：①归一化函数只能有一份（与 `fingerprintUrl` 同文件同源，或抽成共享模块——别在采集端再算一遍）；②写清 L2 的比对发生在哪一侧（主进程带 `img_key` 查 or 渲染层比对），否则 §8.6 的变异"把 img_key 退回 origin+pathname"打不到红。

**P2-3　建款向导 vs 既有 `ProductEditorDrawer` 的关系没交代**  
现有抽屉是"离开输入框就写库"的自动保存模型（`ProductEditorDrawer.vue:15-21` 的提示原文写明"边改边存"），做不了"建档并关联"的一次性三连——所以**新抽屉是对的**。但方案没写这条理由，下一个人要么重新分析一遍，要么把向导改成自动保存形态破坏原子性。  
**修订**：§4.3 补一句"为什么不扩 `ProductEditorDrawer`"。

**P2-4　§3.6 自相矛盾**  
表格里 `shop-item-image-fetch` 是新通道，同节却说"写入与图片采纳**零新通道**"。  
**修订**：删掉那半句（或改为"写入零新通道；图片采纳按需下载走 1 个新通道"）。

**P2-5　§1.2 的断言计数与冒烟名**  
改为指向脚本名（`goods:ui` / `product:sku:smoke` / `ipc:shape:smoke`），不写绝对数——本仓计数漂移是既有纪律（docs/README.md 的计数行自己就漂了 26 个）。

**P2-6　收工清单缺三件本仓必做，门禁要点名到脚本**  
§6 只写了"对应 `*:ui` / `*:smoke`"。按阶段补：**P0** `shop:smoke` + `schema:smoke`（补列迁移既有守卫）+ `ipc:shape:smoke`；**P1** `product:smoke` / `order:smoke`（图 dedup 不变式别被新表带坏）；**P2/P3/P4** `goods:ui` + `ipc:shape:smoke` + `product:sku:smoke`。另补三件收工：①`CHANGELOG.md [Unreleased]`；②`PROJECT_BASELINE.md` 计数刷新（+3 通道 / +1 表 / `sk_shops` +1 列）；③`ae-receiver-status` 加字段同样要走契约同步（`types.ts` 的 `AeReceiverStatus`）。⚠️ 变异跑完必须 `npm run build` 再跑最终门禁（`*:ui` 读 `dist/`）。

**P2-7　方案文档自身不过 `verify:docs`（审查中已当场修）**  
§8.1 用反引号路径引用兄弟仓库文件（SellerKitExtensions 仓库里 ae-profit 扩展的 content script）—— 本仓四路解析全部不命中，`npm run verify:docs` 直接红（exit 1）。引用本身有效（文件在兄弟仓库真实存在，已核对），**不该**进 `DELIBERATELY_MISSING` 豁免表（该表只承接"句子在陈述它不存在"的引用）；已按守卫首选修法改为 prose 形式（"SellerKitExtensions 仓库里 ae-profit 扩展的 content script"），语义一字未动，复跑绿。**教训**：方案作者收工没跑 `verify:docs` —— 新增/改文档后它是必跑项。

### P3 — 建议

**P3-1　`ae_sync_log` 不存在**：§6 P5 写"「ae_sync_log」式批次记录"——全仓零命中，名字像存量，实现时会有人去找它。建议直接砍掉（接收端已有 skipped 计数，见裁退-2）。

**P3-2　`shop-items-summary` 的消费点要写清**：它服务两处——店铺列表行「已采集 N」徽标（§4.1）+ 状态条「本店已采 86 个」（§4.2）。后者可由 `shop-items-list` 的 total 拿。砍掉徽标则此通道可省（3 通道 → 2）。至少写清服务哪几个调用点，别"先开了再说"。

**P3-3　§3.4 第 3 级"同名唯一命中"要点名复用 `uniqueShopByKey()`**（`product-db.ts:1187`，队列已在用）——不点名，实现者会新写一份，两条"同名唯一"必然漂移（`shop-db.ts` 口径 2 同款纪律）。

**P3-4　新增元素的 `data-act` 锚点清单**：§4.5-6 只保证既有 `data-act` 不动；色×图展开行、L2「同图建议」徽标、向导三块各自的锚点要列出来，冒烟才钉得上。

**P3-5　`site` 列辨析要写进方案**：`sk_shops.site` 已存在（= 平台站点 RU/US，`ShopRegistryView.vue:278`）。新字段「店铺地址」与「站点」在表单上并排，必须写清区别——否则实现者可能想"复用 site 列省一次迁移"，那是把两个语义塞进一列、静默改变老数据含义。

---

## 4. D1–D12 裁定

| #   | 决策                      | 裁定                                                      |
| --- | ----------------------- | ------------------------------------------------------- |
| D1  | 通道复用 ae-receiver 新 path | ✅ 照办                                                    |
| D2  | 采集数据落新表 `pl_shop_items` | ✅ 照办；唯一键按 P1-2 加 `store_key`                            |
| D3  | 零新写口径                   | ✅ 照办；P3 验收点按 P1-3 改                                     |
| D4  | 店铺匹配四级                  | 🔸 照办，但规则 1 按 P1-1 做 URL 归一（或与规则 2 合并），规则 3 按 P3-3 点名复用 |
| D5  | 右栏第三段 + 向导抽屉            | ✅ 照办；按 P2-3 补"为什么不扩现有抽屉"                                |
| D6  | 采集分级（列表轻采 / 详情按需）       | ✅ 照办。预算粗算够：100/批 × 60 批/分；86 个商品逐条详情 ≈ 1.5 分钟，可接受       |
| D7  | 克重/成本不采集                | ✅ 照办                                                    |
| D8  | SKU 图只采 URL 不采二进制       | ✅ 照办                                                    |
| D9  | 闭环落点 = 认款时采纳为款色绑定图（只补空） | ✅ 方向照办，实施按裁退-1 降级（先写入侧）；`img_key` 按 P2-2 定义             |
| D10 | 未认款同图只建议不写              | ✅ 照办（公版图防护正确）                                           |
| D11 | `img_key` 按图像 ID 取键     | 🔸 方向对；落点/唯一实现未定（P2-2），样本判据改指夹具（P2-1）                   |
| D12 | L2 建议带色 + 色号→平台色名翻译     | 🔸 建议移出本期：依赖首采复验，属体验增强非闭环必需（裁退-1）                       |

---

## 5. 不过度设计：三处裁退建议

1. **§8 拆成两期做**。**写入侧先做**（认款时把色图采纳为款色绑定图，只补空）——环到这就闭上了：之后任何订单同图走 `order-download-image` 既有去重分支自动继承款色，无需新判断。**读取侧 L2（建议徽标 + 一键认款）与色号→色名翻译（D12）缓一步**——它们是体验增强，不是闭环必需，且都依赖"详情页同图像 ID"这个未复验项。§8.9 的取证保留（它证明 URL = 色变体级，正是写入侧价值的依据）。
2. **砍掉 P5 的 `ae_sync_log` 批次记录**（P3-1）：接收端 skipped 计数 + 单条失败跳过已在 P1 验证点里，再建一张批次表本期没有读者。
3. **`shop-items-summary` 暂缓**（P3-2）：先只服务状态条（或并入 `shop-items-list` 的 stats），店铺列表徽标留到有真实需求再开通道。

---

## 6. 开工前三件事

1. **先理清工作区**：当前 `git status` 有 **99 个文件未提交**（+11377/−2349），其中 `electron/ae-handlers.ts`、`main.ts`、`order-db.ts`、`order-handlers.ts`、`product-db.ts`、`product-handlers.ts`、`preload.ts` **正是本方案要碰的文件**（存量内容是 P4 成本维护 / 剪贴板 handler 等 unrelated 在制品）。先提交或 stash，否则本方案的 diff 会和存量脏改动缠在一起，门禁跑的也不是干净基线——本仓有大坑前科（HEAD 曾停两周、263 项从未 `git add`）。
2. **方案与本文登记进文档地图**：`docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md` 此前不在 `docs/README.md` 索引里（本审查稿已代为登记两行；`docs/**` 实测 96 → 97 个 `.md`，计数行当场已改）。另：方案 §8.1 的兄弟仓库反引号路径引用让 `verify:docs` 红着，已按守卫首选修法改为 prose 形式（P2-7），复跑绿。


1. **按 §3 修订方案后再动代码**：三处 P1 是方案级修订（不是实现细节），改完把 D1–D12 的状态从"待评审"更新为本文裁定结果。
