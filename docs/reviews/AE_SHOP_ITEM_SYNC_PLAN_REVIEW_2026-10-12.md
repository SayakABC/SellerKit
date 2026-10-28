# 「速卖通店铺商品采集 → 商品↔产品映射维护」方案 · 审查稿

> **审查对象**：`docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md`（状态：待评审，未动任何代码）  
> **审查方式**：逐条核对方案中的代码取证（约 30 处 `文件:行`，全部实跑核对）→ 与 `AGENTS.md` / `docs/notes/2026-10-05-repo-hard-constraints.md` 硬约束对表 → git 工作区检查。本审查同样未动任何代码。  
> **日期**：2026-10-12

---

## 0. 一句话结论

**方案成立，可按修订清单开工。** 它自我定位的"已有能力的延伸而非新系统"经核对准确：接收端、落点表、认款写路径、店铺实体全部在产，新增面只有"1 个采集端点 + 1 张快照表 + `sk_shops` 1 列 + 右栏 1 个视图段 + 1 个建款向导"。

需处理：**3 处 P1**（URL 精确匹配大面积失配 / 未登记店撞唯一键 / 一个做不到的验收点）、**7 处 P2**、**3 处过度设计裁退**，以及开工前 **1 个流程事项**（工作区 99 个文件未提交，含本方案要碰的多个文件）。

---

## 1. 取证核对（方案引用 vs 代码现实）

方案的取证质量罕见地高——引用行号几乎全部精确。逐条实跑结果（✅= 精确属实；⚠️= 有偏差需注意）：

- `ae-receiver.ts` 限流/白名单/大小上限：`electron/ae-receiver.ts:22-35`，白名单当前 = GET `/ae/ping` + POST `/ae/ingest`，新 path 要加项 ✅
- 接收端随应用自启：`electron/main.ts:37` `require('./ae-receiver')` ✅
- `ae-receiver-status` 通道可复用：`electron/ae-handlers.ts:55` + `preload.ts:663`；`AeReceiverStatus` 加 `lastItemsIngestAt` 仍须走契约同步 ⚠️（P2-6）
- `PROFIT_TRACKER.md` §5/§6.1/§9 通道协议/窄列快照/合规：三节都在且一致 ✅
- `sk_shops` 无地址列、`platform×name_key` UNIQUE、`platform_shop_id` 部分唯一索引：`electron/shop-db.ts:141-176` ✅；⚠️ 但已有 `site` 列（=`ShopRegistryView.vue:278`），见 P3-5
- `ensureShopColumns()` 补列模式：`shop-db.ts:178-193` ✅
- 编辑不透传 = 静默清空：`src/modules/goods/shopApi.ts:53-58` ✅
- `pl_products`/`pl_variants`/`pl_shop_sku`/`pl_images` 四个行号：`product-db.ts` 与 `shop-db.ts` 全部精确 ✅
- 池/映射谓词互补不变式：`product-db.ts:929-939`，"采集行进第三种群"推理正确 ✅
- `landImageBuffer`/`adoptOrderImages`：`product-handlers.ts:469`/`516` ✅
- 认款写路径：`product-handlers.ts:386-413` + `order-db.ts` 回流函数 ✅
- 建款三连：`product-handlers.ts:139`/`434`/`386` ✅
- 队列只含订单出现过的商品：`product-db.ts:1164-1189` ✅
- `shopUnresolved` 不许写映射 / `hint-shops` 形态：`shopSku.ts:195-196` + `PoolPane.vue:82-91` ✅
- 分段控件两段：`PoolPane.vue:23`/`35` ✅
- 订单图去重（URL→内容指纹→`SELECT *`）：`order-handlers.ts:548-595` + `order-db.ts:551-558` ✅
- `autoAssignByMap`/39% 注释/`setImageStyleColor`：`order-db.ts:1225-1246`/`1239`/`571` ✅
- `code` 与 `oi_styles.code` 共用序号池：`order-db.ts:630-648` ✅
- `importSheet.ts:156-170` 图片入口 + 导入 `color` 恒空 ✅
- `IMAGE_COLUMN_KEYWORDS`/`ITEM_ID_KEYS`：`orderClassifier.ts:201` + `shopSku.ts:43-44` ✅
- `orderRowSplitter` 的 `IMAGE_SEPS`/`ID_SEPS`/`parseInfoBlocks`：`orderRowSplitter.ts:44-69` ✅
- `normalizeColor`：`orderClassifier.ts:104-113` ✅
- 扩展仓库 `SellerKitExtensions` 存在、`content.js` 的 `lines[]` 无 img src：兄弟目录属实 ✅
- `AeProfitView.vue` 状态行 + curl 样例：`AeProfitView.vue:66-103` ✅
- `ShopProductView.vue:54-61` 热链 + `@error` 降级 ✅
- 「店铺登记」是真实入口名：`tabs.ts:33` ✅
- `today:ui` 238 / `product:sku:smoke` 41 组断言 ⚠️ 计数漂移：实测 `today-ui-smoke.mjs` 249 处 `report(`、`product-sku-smoke.cjs` 42 处 `check(`；且守认款链的 UI 冒烟是 **`goods:ui`**（认款 UI 在货与成本右栏），不是 `today:ui`——疑似笔误
- §8.9 样本 `芒果店长_783900_1791724889335.xlsx` ⚠️ 文件不在库；同形夹具在 `tests/fixtures/mango-pending-orders.xlsx`（12 列）+ `mangoPendingImport.spec.ts:143` 同形 URL，判据可改指夹具（P2-1）

---

## 2. 方案与基线对齐的点（做对了的，实现时别丢掉）

1. **不新开端口、不引 Native Messaging**——白名单加一个 path 是接收端最小改动，token/限流/大小上限全部继承。
2. **新表 `pl_shop_items` 而非塞 `pl_shop_sku` 池**——对"池/映射互为补集"不变式的理解正确；"平台事实 vs 人的决定"两张表两种写入者，与 ADR-002 主数据纪律同构。
3. **零新写口径**——认款/建款/图片采纳全部挂既有 handler；本审查因此能抓住 P1-3（两条验收点做不到）。
4. **契约五处同步意识**（handler + preload + types.ts + ipc.ts + 界面），且主动点了 `shop_url` 全量透传的坑。
5. **界面纪律全部对齐**：图列地板、全零不占位、提示必须是入口等。
6. **反候选清单（§5）质量高**——"不自动建店/不自动认款/不覆盖 manual/采集不直接写池"四条条条对铁律。
7. **合规边界与 PROFIT_TRACKER §9 同构**。
8. **§8 现状取证极扎实**——"订单图 URL 同时命中产品与颜色"能从代码推出，支撑"色级缺客观锚点"判断。

---

## 3. 问题清单

### P1 — 开工前必须改方案

- **P1-1　店铺匹配规则 1「URL 精确相等」会大面积失配**（最高实用风险）：人贴 URL 与扩展拿到的 URL 几乎必然不同形（`/store/123/index.html` vs `/store/123` vs 尾斜杠 / `?spm=` / http vs https）。**修订**：匹配前做**店铺级 URL 归一**（提取 `/store/<id>` 段比对；大小写/尾斜杠/query 归一）；对速卖通规则 1 与规则 2 可**合并成一条**（从 URL 提取 id → 比 `platform_shop_id`，复用 `shop-db.ts:199-205` 部分唯一索引）。hint 必须写清期望形态。
- **P1-2　未登记店的 `UNIQUE(shop_id, item_id)` 会互相撞键**：未登记 = `shop_id=0`，两家不同未登记店采到同一 `item_id` 时第二次 upsert 覆盖第一家 `store_key`。**修订**：唯一键改 `UNIQUE(shop_id, store_key, item_id)`（登记店 `store_key` 空串不受影响）。
- **P1-3　P3 验收点「建档+关联单事务回滚」做不到**：三个 IPC 各自独立事务，且 D3 禁止加复合 handler。**修订**：验收点改为「分步失败的**结构化回执** + **可重入**」，接 §4.3 已规划的结构化回执。

### P2 — 实施时必须落

- **P2-1** §8.9 样本文件不在库，"R1 原风险关闭"表述过头 → 判据改指仓库内夹具；R1 状态保持"订单侧已关闭（附夹具）、详情页侧待首采复验"。
- **P2-2** `img_key` 落点/唯一实现没定义（`fingerprintUrl` 是 `order-handlers.ts:69` 私有函数）→ 归一化函数只能一份，写清 L2 比对发生在哪侧。
- **P2-3** 建款向导 vs 既有 `ProductEditorDrawer` 关系没交代（抽屉是"边改边存"自动保存，做不了一次性三连）→ §4.3 补"为什么不扩现有抽屉"。
- **P2-4** §3.6 自相矛盾（表格说新通道，同节说零新通道）→ 删半句。
- **P2-5** §1.2 断言计数与冒烟名 → 改指脚本名（`goods:ui` / `product:sku:smoke` / `ipc:shape:smoke`），不写绝对数。
- **P2-6** 收工清单缺三件必做，门禁要点名到脚本：P0 `shop:smoke` + `schema:smoke` + `ipc:shape:smoke`；P1 `product:smoke` / `order:smoke`；P2/P3/P4 `goods:ui` + `ipc:shape:smoke` + `product:sku:smoke`；另补 `CHANGELOG.md [Unreleased]`、`PROJECT_BASELINE.md` 计数刷新、`ae-receiver-status` 加字段走契约同步。⚠️ 变异跑完必须 `npm run build` 再跑最终门禁。
- **P2-7** 方案文档自身不过 `verify:docs`（审查中已当场修）：§8.1 用反引号路径引用兄弟仓库文件，本仓四路解析不命中 → 已改为 prose 形式，复跑绿。**教训**：新增/改文档后 `verify:docs` 必跑。

### P3 — 建议

- **P3-1** `ae_sync_log` 不存在（§6 P5）→ 砍掉，接收端 skipped 计数已够。
- **P3-2** `shop-items-summary` 消费点要写清（店铺列表徽标 / 状态条）；砍掉徽标则此通道可省（3→2）。
- **P3-3** §3.4 第 3 级"同名唯一命中"要点名复用 `uniqueShopByKey()`（`product-db.ts:1187`）。
- **P3-4** 新增元素 `data-act` 锚点清单（色×图展开行、L2 建议徽标、向导三块）要列出来。
- **P3-5** `site` 列辨析写进方案（`sk_shops.site` 已存在 = 平台站点 RU/US），别想"复用 site 省迁移"把两语义塞一列。

---

## 4. D1–D12 裁定

| # | 决策 | 裁定 |
|---|---|---|
| D1 | 通道复用 ae-receiver 新 path | ✅ 照办 |
| D2 | 采集数据落新表 `pl_shop_items` | ✅ 照办；唯一键按 P1-2 加 `store_key` |
| D3 | 零新写口径 | ✅ 照办；P3 验收点按 P1-3 改 |
| D4 | 店铺匹配四级 | 🔸 照办，规则 1 按 P1-1 做 URL 归一（或合并），规则 3 按 P3-3 点名复用 |
| D5 | 右栏第三段 + 向导抽屉 | ✅ 照办；按 P2-3 补理由 |
| D6 | 采集分级（列表轻采 / 详情按需） | ✅ 照办（预算够：100/批 × 60 批/分；86 商品详情 ≈ 1.5 分钟） |
| D7 | 克重/成本不采集 | ✅ 照办 |
| D8 | SKU 图只采 URL 不采二进制 | ✅ 照办 |
| D9 | 闭环落点 = 认款时采纳为款色绑定图（只补空） | ✅ 方向照办，实施按裁退-1 降级（先写入侧）；`img_key` 按 P2-2 |
| D10 | 未认款同图只建议不写 | ✅ 照办 |
| D11 | `img_key` 按图像 ID 取键 | 🔸 方向对；落点/唯一实现未定（P2-2），样本判据改指夹具（P2-1） |
| D12 | L2 建议带色 + 色号→平台色名翻译 | 🔸 建议移出本期（依赖首采复验，属体验增强；裁退-1） |

---

## 5. 不过度设计：三处裁退建议

1. **§8 拆两期做**：**写入侧先做**（认款时把色图采纳为款色绑定图，只补空）——环已闭，之后订单同图走 `order-download-image` 既有去重分支自动继承。读取侧 L2（建议徽标 + 一键认款）与色号→色名翻译（D12）缓一步，依赖未复验项。§8.9 取证保留（证明 URL = 色变体级，是写入侧价值依据）。
2. **砍掉 P5 的 `ae_sync_log` 批次记录**（P3-1）：接收端 skipped 计数 + 单条失败跳过已在 P1 验证点，再建表本期无读者。
3. **`shop-items-summary` 暂缓**（P3-2）：先只服务状态条（或并入 `shop-items-list` 的 stats），徽标留到有真实需求。

---

## 6. 开工前三件事

1. **先理清工作区**：`git status` 有 **99 个文件未提交**（+11377/−2349），其中 `electron/ae-handlers.ts`、`main.ts`、`order-db.ts`、`order-handlers.ts`、`product-db.ts`、`product-handlers.ts`、`preload.ts` **正是本方案要碰的文件**（存量内容是 P4 成本维护 / 剪贴板 handler 等 unrelated 在制品）。先提交或 stash，否则 diff 与存量脏改动缠在一起，门禁跑的不是干净基线。
2. **方案与本文登记进文档地图**：`docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md` 此前不在 `docs/README.md` 索引里（本审查稿已代为登记）；方案 §8.1 兄弟仓库反引号路径引用已按 P2-7 改 prose（复跑绿）。
3. **按 §3 修订方案后再动代码**：三处 P1 是方案级修订，改完把 D1–D12 状态从"待评审"更新为本文裁定结果。
