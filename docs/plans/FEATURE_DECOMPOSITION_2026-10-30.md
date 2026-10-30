# 发货台 / 产品管理 功能拆解与待确认清单（2026-10-30）

> **状态**：🟢 **D1–D18 与 Q6 全部确认（2026-10-30 第四轮）** —— 下一步按 `PRODUCT_ORDER_SIMPLIFY_PLAN_2026-10-30.md` §10 的 R0/R1 施工清单开工。
> 本文只做拆解与决策记录，**未改一行代码、未改表结构**。
> **读者**：产品 / 架构 / 开发者
> **起因**（用户口径）：
> > resolve(店铺, 商品ID, Color原文) … 上面的 `(shop, item, spec=Color原文)` 这里做不到精准命中，因为订单 Excel 中的 Color 原文同一 item 下的多个不同的商品有可能重复，`shop, item, 订单图片` 才算精准命中，所以回落也应该是不正确的。你可以把当前发货台和产品管理中的功能一个个拆解，然后我们再通过讨论和确认解决这一个个问题，确认好后，再进行改造。
> **前置**：[`reviews/PRODUCT_TABLES_REVIEW_2026-10-30.md`](../reviews/PRODUCT_TABLES_REVIEW_2026-10-30.md)、[`plans/PRODUCT_ORDER_SIMPLIFY_PLAN_2026-10-30.md`](PRODUCT_ORDER_SIMPLIFY_PLAN_2026-10-30.md)、[`notes/2026-10-28-order-driven-classify-plan.md`](../notes/2026-10-28-order-driven-classify-plan.md)

---

## 0. 先承认纠错，再定讨论基线

上一版方案的解析链从一开始就是错的：

```text
（作废）resolve(shop, itemId, colorRaw):
  1) (shop, item, spec=colorRaw) 精确命中
  2) (shop, item, spec='*') 有 color → 单色 listing 捷径
  3) 否则待认
```

作废原因有两条，都是**结构性的**，不是数据脏：

1. **`Color` 原文是平台给的商品级编号，不是 SKU 身份。**
   `Color:1` 在真库里同时出现在 7 个 listing（瑜伽裤 / 棉袄 / 雨衣 / 印花外套）。同一 listing 下不同商品沿用同一编号也完全可能。把它当唯一键，等于把"位置"当"语义"——错得悄无声息。
2. **`spec` 现在存的是「我方色名」（输出），不是「平台原文」（输入）。**
   `pl_shop_sku.spec` 真库只有 3 种值（`*` 46 行 / `红` 1 / `红色` 1）。用"输出"去匹配"输入"，天然只能命中极少数，于是有了 `spec='*'` 这条"回落"——而它一旦命中，就会把**同 listing 的所有色**都归到同一个款色上。**回落不是补丁，是错误来源。**

**新的讨论基线（待确认，见 D1–D3）：**

> 订单 Excel 里唯一能指向"这一个 SKU"的身份，是**这一行的产品图片链接**（落库后即 `oi_order_items.image_id` / 内容指纹）。
> `Color` 原文是**证据与次级键**；`(店铺, 商品ID, 图片)` 才是主键。

真库反证（只读，副本 `/tmp/skdb/sellerkit.db`，2026-10-30）：

| 观测 | 值 | 含义 |
| --- | --- | --- |
| `oi_order_items` 行数 | 75 | 全部有 `产品图片链接`，全部有 `产品ID` |
| 行上 `image_id` 非空 | **75/75** | 图片身份 100% 可得，不依赖联网补图 |
| `(店铺, 商品ID)` 组 | 37 | listing 数 |
| `(店铺, 商品ID, Color)` 组 | 59 | 含 2 条空色脏行 |
| `(店铺, 商品ID, 图片)` 组 | 58 | 去掉空色行后与色组**完全 1:1**（58 : 58） |
| 图片 → 多色 | **0**（排除空色行） | 干净数据上图就是 SKU 级身份 |
| 色 → 多图 | **0**（排除空色行） | 同上 |
| 那 2 条空色行 | 十二店 / `1005013246442752` | 一条订单含 4 个产品段，拆行器只出 2 行且 `color=''`（是拆行 bug，不是键问题） |

> ⚠️ 这张表只能证明"当前数据里图与色 1:1"，**不能证明平台永远不会给两个 SKU 同一张图**。所以新键仍建议保留 `Color` 原文做**冲突消解**，而不是直接丢掉（见 D2）。

### 0.1 第二轮确认记录（2026-10-30）

用户在上一次回复里逐条给出：

| 用户第 N 点 | 用户原话（摘要） | 本清单的落点 |
| --- | --- | --- |
| 1 | 图片是否单独维护？能否全项目**一张图片表**，业务表只存图片 ID；图片表可以"双写"，后续把颜色/款等属性也放进去，解析订单 Excel 用**商品ID + 图片指纹**就能确定款色 | §4.3 + D14 / D15 / D16（**"属性写图片行"需先处理一图多用**，见 §4.3 末段） |
| 2 | 颜色**全项目一张表**，其他表用 `color_id` 关联；**尺码也单独维护**（基本不变，人工对应更快） | §4.4 + D8 ✅ / D17 / D18 |
| 4 | **允许**（listing 级显式认款） | D5 ✅ |
| 5 | **可以**（SKU 稀疏 + 款默认克重） | D6 ✅ / D7 ✅ |

**已确认的 18 条 + 1 个前置**（可直接作为施工依据；用户第四轮"按建议继续确认剩余项"）：

| 决策 | 结论 |
| --- | --- |
| D1 | 图片键 = **内容指纹**（SHA-256）；图未落地先用归一 URL 临时键，落地后同一行升级 |
| D2 | **`Color` 原文进唯一键**：`UNIQUE(shop_id, item_id, image_id, color_raw)`；原文只消歧，永不单独当身份 |
| D3 | **改 `pl_shop_sku`**（加 `image_id` / `color_raw` / `color_id`），不新建表 |
| D4 | **`spec` 退役**，拆成 `color_raw`（输入）+ `color_id`（输出） |
| D5 | 允许 `(shop,item,image)` 唯一命中（精确 3 元组），**`spec='*'` 一律作废**；listing 级认款写成"显式待认色"行，不是静默回落 |
| D6 | `pl_variants` 稀疏保留（按需建行），新建款/导入**不再铺矩阵** |
| D7 | 克重粒度 = **款默认 + 按码覆盖** |
| D8 | 全项目一张 `md_colors`，其他表只存 `color_id`（别名走 `md_color_aliases`） |
| D9 | 认款 UI：**发货台「归类核对」为主**，产品管理右栏保留入口 |
| D10 | 待认状态：**行级** `pending_style` / `pending_color` / `confirmed` / `ignored`，全部可见可回滚 |
| D11 | 图片目录合并为**一套** `userData/images/` + `md_images` |
| D12 | 旧数据：**测试数据可丢**，不写迁移、重建库 |
| D13 | 「商品清单」池：**删池行 + 6 IPC**；套装两表删 |
| D14 | 图片属性（款/色）**只写映射行**，图片行只存文件身份 |
| D15 | 远端图**全部落地**进 `md_images`（订单图 + 款图 + 采集图） |
| D16 | `oi_images` 识别字段**全删**（`status` / `result_json` / `error` / `features`；`style_color_id` 归映射行） |
| D17 | 颜色别名：**全局（`product_id=0`）+ 按款覆盖** |
| D18 | `pl_variants` **只留 `color_id` / `size_id`**，删 `color` / `size` / `name` |
| Q6 | 拆行器**先修**（一段一行、色/码齐全），再动键 |

> **键的最终口径（D2+D3+D4 合并后）**：`pl_shop_sku(shop_id, item_id, image_id, color_raw)` 唯一，
> 认款结果写 `product_id` + `color_id` + `status`。输入是"原文 + 图片指纹"，输出是"款 ID + 色 ID"，
> **不允许把 `color_id` 放进唯一键**——那是认完才有的结果，拿它当键等于重犯"用输出匹配输入"。

**没有未确认项。** 下一步：按 `PRODUCT_ORDER_SIMPLIFY_PLAN_2026-10-30.md` §10 的 R0/R1 施工清单开工；先 R0（拆行器 + 清库），再 R1（主数据）。

> ⚠️ 第 1 点里"把颜色、款放到图片行"这一步，**建议改落在映射行**：`(店铺, 商品ID, 图片)` 才是"哪个商品用了哪张图"的事实；同一张图会被多个 listing / 多个色复用（同款不同链接、主图被多色共用），写死在图片行会让第二个 listing 读到第一个的结论。用户要的"商品ID + 图片指纹 → 款色"由映射行**完全满足**，不需要把归属放进图片行（详见 §4.3 与 D14）。

---

## 1. 本次拆解的边界

| 区域 | 入口 | 代码 | 页签 / 区块 |
| --- | --- | --- | --- |
| 发货台 | 今天 → 发货 | [`src/modules/today/TodayView.vue`](../../src/modules/today/TodayView.vue)、[`flowCtx.ts`](../../src/modules/today/flowCtx.ts) | 总览 / 导入订单 / 归类核对 / 拿货 / 结算对账 |
| 产品管理 | 货与成本 → 款与商品 | [`src/modules/goods/GoodsView.vue`](../../src/modules/goods/GoodsView.vue)、[`GoodsWorkbenchView.vue`](../../src/modules/goods/components/GoodsWorkbenchView.vue) | 左栏产品 / 右栏商品池（待认 / 已认） |
| 主进程 | 映射 / 归类 | [`electron/product-db.ts`](../../electron/product-db.ts)、[`electron/order-db.ts`](../../electron/order-db.ts) | `resolveOrderSku` / `upsertSkuMappings` / `autoAssignByMap` / `skuBackfillFromOrder` |
| 主进程 | 采集快照 | [`electron/shop-item-db.ts`](../../electron/shop-item-db.ts) | `pl_shop_items` |

**不在本次拆解内**：运费报价、算钱 / 记账、店铺账号、邮件。它们读的是同一批键，但改造要等键定下来之后再看。

---

## 2. 发货台：逐项拆解

### 2.1 总览（`OverviewPanel.vue`）

| 编号 | 功能 | 入口 / 取数 | 输入与键 | 写哪些表 | 现在的问题 | 待确认 |
| --- | --- | --- | --- | --- | --- | --- |
| **T-01** | 今日四数：单 / 件 / 已拿 / 还差 | `TodayView.reload()` → `orderShippingRows({limit:2000, importDate})` + `purchaseOrderCoverage` + `dailyShip` | `(订单号, 图片)` 幂等键；按导入日 | 只读 | 四数里"单"按行、`dailyShip` 按订单号，口径不同源；`estimated` 提示依赖克重，而订单克重 0/75 有值 | 四数是否仍按"行 / 订单号"两套口径？还是统一到订单号？ |
| **T-02** | 归类缺口 `gaps.style` | `all.length - all.filter(o => styleCode).length` | `styleCode` 来自 `oi_style_colors` JOIN | 只读 | 它数的是"没有款色的行"，但**有款无色**与**连款都没有**混成一个数 | 缺口是否拆成「待认款 / 待认色 / 待核对」三档？ |

### 2.2 导入订单（`ImportPanel.vue`）

| 编号 | 功能 | 入口 / 取数 | 输入与键 | 写哪些表 | 现在的问题 | 待确认 |
| --- | --- | --- | --- | --- | --- | --- |
| **T-03** | 四种报表投放：订单报表 / 待发货订单 / 结算明细 / 报价单 | `TYPES`（`ImportPanel.vue:306`）；点击与拖放共用 `importExcel` / `importFile` | 文件类型由表头识别 | 订单 → `oi_orders` / `oi_order_items` / `oi_images`；结算 → 订单金额字段；报价单 → 运费域 | 四种报表共用同一投放区，识别错类型时的回执只说"落点"，不给人"改判类型"的入口 | 是否保留四种合一个投放区？还是按类型分入口？ |
| **T-04** | 订单行拆行（一单多产品段） | `src/lib/orderRowSplitter.ts`；`产品信息` 的 `【1】…【4】` + 每段 `(产品属性:Color:N,Size:X,…)` | `(订单号, 图片)` 幂等 | `oi_order_items` 一行一 SKU | 真库 2 行空色脏数据：4 段只出 2 行、`color=''`；说明拆行器对"多段同商品不同码"处理不全 | **已确认：先修（Q6）** —— 一段一行、色/码齐全，空色不得写成 `''`，改落"待认色" |
| **T-05** | 图片落地与指纹 | `landOrderImageBytes` / `oi_images` | URL 归一键 + SHA-256 内容指纹 | `oi_images`、`oi_order_items.image_id` | 图片落地是异步的；落完才写 `image_id` 的话，"键"在导入瞬间可能还没准备好 | 图片键用**内容指纹**（落库后才有）还是**归一 URL**（导入即有）？见 D1 |
| **T-06** | 导入回执卡 | 识别结论 / 落点 / 拆分 / 主图成败 | — | 只读 | 回执只报"成功/失败"，不报"这次新增了多少待认 SKU" | 回执是否加一行"待认款 N / 待认色 M"？ |

### 2.3 归类核对（`ClassifyPanel.vue`）

| 编号 | 功能 | 入口 / 取数 | 输入与键 | 写哪些表 | 现在的问题 | 待确认 |
| --- | --- | --- | --- | --- | --- | --- |
| **T-07** | 列表：搜索 / 待核对 ⇄ 已核对 / 分页 | `listPending` / `listCorrected`；默认 `importDate=今天` | 行 = 一个订单行（`oi_order_items.id`）；展示 `styleCode` / `styleColor` | 只读 | 列表一行 = 一个 SKU，但界面上**没有 listing 分组**；一个 7 色的 listing 会散成 7 行，认款时看不出"这些是同一商品的色" | 列表是否按 `(店铺, 商品ID)` 分组，组内展开 SKU？见 D9 |
| **T-08** | 逐行挑款 | `StylePicker`（左订单图 / 右带图款列表） | 选中 `targetStyle`（`pl_products.code`） | 保存时写 `oi_order_items.style_color_id`（经 `ensureStyleColor`） | 挑款只看"图 + 款图"，**没有把"这个 listing 的其他色是怎么认的"摆出来** | 挑款时是否显示"同 listing 已认结果"作为上下文？ |
| **T-09** | 选色 / 自由输入色名 | `StylePicker` 右栏只列该款 `oi_style_colors.color`；可自由输入 | 色名（我方） | `oi_style_colors` + `oi_order_items.style_color_id` | 颜色是**我方色名**，与订单 `Color` 原文、`pl_variants.color` 三套词表互不对齐（23 / 32 / 15 种） | 色名是否统一进一份颜色字典（`md_colors`）？见 D8 |
| **T-10** | 保存 / 确认无误 / 退回 | `saveOne()`（`ClassifyPanel.vue:1628`）、`confirmOne`、`confirmAll()`（`:1714`） | `saveCorrection` | `oi_order_items` + `oi_style_colors` + **`pl_shop_sku`（回流）** | 「保存」会顺带写映射（`skuBackfillFromOrder`），但**整条商品只写一个 spec**；多色 listing 只能记住最后一个色 | 保存时到底写不写映射？若写，写哪一行？见 D3 / D4 |
| **T-11** | 批量勾选 / 按商品同选 | 同页多选；`BulkStylePicker` 按**商品**分组 | 商品级（`(shop,item)`） | 同 T-08 | 「按商品同选」的前提是"同商品必同款"，但**色不批量**；而用户现在说同商品下可能有多个不同商品/色 | 批量定款是否保留？它和"按 SKU 认色"如何共存？ |
| **T-12** | 命名板（色名） | `VariantNamingCard.vue`；`variantNamingBoard(limit=400)` | `oi_variant_keys(shop,item,colorRaw)` + `styleColorId` | 只改 `oi_style_colors.color`（不改 code） | 命名板按 listing 分组、一屏填完一个 listing 的所有色 —— **这是全仓唯一"按 listing 看色"的界面** | 认款是否直接并进这块板，做成"色 × 图 × 款 × 色名"一屏？见 D9 |
| **T-13** | 款合并 | `StyleMergeCard.vue` | 两个 `pl_products.code` | 合并订单归属 / 删空壳款 | 合并是"事后纠错"，但映射行不跟着合并就会留下指向旧款的键 | 合并时映射行是否一并改 `product_id`？ |
| **T-14** | 门 1：店铺归一 | 非阻断提示；`resolveShopRef`（`product-db.ts:1581`） | 店名原文 → `sk_shops.id` | `sk_name_map` / 店铺主表 | 未归一的行不给映射（池行 `shop_id=0`），但订单解析用的是**原文**；两者口径靠 `resolveShopRef` 兜 | 店铺身份是否只认 `sk_shops.id`，不再用原文？ |

### 2.4 拿货（`PurchasePanel.vue`）

| 编号 | 功能 | 入口 / 取数 | 输入与键 | 写哪些表 | 现在的问题 | 待确认 |
| --- | --- | --- | --- | --- | --- | --- |
| **T-15** | 按厂家 / 款色缺口 | `purchaseOrderCoverage`；`purchase_items.style_color_id` JOIN `oi_style_colors` | `(style_color_id)` + 厂家 + 时间窗 | 只读 | 款色没认全的行**不进缺口**（INNER JOIN），于是"没货可拿"与"没认款"分不开 | 缺口是否加上"未认款/未认色"单独一档，并允许点回归类页？ |
| **T-16** | 按单核对 / 开单 | `purchase_sources.order_item_id` | 订单行 id | `purchase_items` / `purchase_sources` | 开单键是 `style_color_id`（款色），所以**认错色 = 拿错货**，且开单后不能回头改键 | 开单前是否强制"该行色已确认"？回滚语义？ |
| **T-17** | 已拿 / 还差 | 件数 vs 行数两套口径 | — | 只读 | 审查稿已指出"按行数会漏货" | 统一按件数？ |

### 2.5 结算对账（`ReconPanel.vue`）

| 编号 | 功能 | 入口 / 取数 | 输入与键 | 写哪些表 | 现在的问题 | 待确认 |
| --- | --- | --- | --- | --- | --- | --- |
| **T-18** | 按厂家 / 店铺 + 时间窗 | 结算明细导入字段 | 订单号 | `oi_orders` 金额字段 | 结算明细与订单行靠订单号关联；它不依赖款色，键改造不影响它 | 是否保持不动？（建议：不动） |
| **T-19** | 付款 / 退款 | 同上 | — | 同上 | 与拿货的 `actual_cost_cents` 是两条金额链 | 是否保持不动？（建议：不动） |

---

## 3. 产品管理：逐项拆解

### 3.1 左栏产品（`ProductPane.vue`）

| 编号 | 功能 | 入口 / 取数 | 输入与键 | 写哪些表 | 现在的问题 | 待确认 |
| --- | --- | --- | --- | --- | --- | --- |
| **P-01** | 搜索 / 状态 / 供应商 / 问题件筛选 | `productApi.list` | `pl_products` | 只读 | 「问题件」= 缺克重 / 未关联供应商 / 缺进价；三项混在一个筛选里 | 问题件是否分开？克重是否还要算"问题"（若改款默认克重）？ |
| **P-02** | 新增款 / 导入 Excel / 导出 | `ProductEditorDrawer` / `ProductImportDialog` / 导出 | `pl_products` | `pl_products` | 新建款默认不建 SKU（现状已如此），但界面仍把 SKU 工作区摆在抽屉里 | 新建款是否彻底不出现 SKU 区，等需要时再进？见 D6 |
| **P-03** | 行展开：档案 + 已关联商品 | 展开行 → `shopProductRelations` | `pl_shop_sku` 映射行 | 只读 | 展示的是"映射"结果，但映射身份里**没有图片/平台色原文**，多色 listing 只能显示一行 | 展开区是否改为列出该款的所有映射 SKU（图 + 平台色 + 我方色）？ |
| **P-04** | 批量选择条 | 多选 → 批量状态/供应商等 | `pl_products` | 只读 | 与本次键改造无关 | 保持不动 |

### 3.2 右栏商品池 · 待认（`PoolPane.vue` + `useSkuPool.ts`）

| 编号 | 功能 | 入口 / 取数 | 输入与键 | 写哪些表 | 现在的问题 | 待确认 |
| --- | --- | --- | --- | --- | --- | --- |
| **P-05** | 待认清单 = 订单队列 + 采集快照 | `skuQueue`（实时聚合 `oi_orders` 减已生效映射）+ `pl_shop_items` | `SkuQueueRow` = `(shop, item)`，**无 color、无 image** | 只读 | 一行 = 一个 listing；一个 7 色的 listing 在右栏只有**一个**待认行，"这个 listing 的 7 个色各自认到哪"在界面上不存在 | 待认行是否改成 listing 展开的 SKU 行（图 + Color 原文）？见 D3 / D9 |
| **P-06** | 认到当前款 `pending-relate` | 选中左栏款 → 关联 | `commitMap` → `pendingWriteRows(rows, p.id, '')` | `pl_shop_sku`（`spec` 落 `'*'`） | 一次只认"整条商品"一个款；色永远不写（`color=''` → `'*'`） | 这个按钮在"一个 listing 多色"下应如何表现？是否按 SKU 逐条认？ |
| **P-07** | 选产品 `pending-pick` | `ProductPicker` | `product id` + `color` | `pl_shop_sku` | 颜色选项来自固定 44 色 `COLOR_SWATCH`，**不是该产品真实有的色**；可选"不指定" | 颜色下拉是否只列该产品 `pl_variants.color`？见 D7 |
| **P-08** | 对比 `row-compare` | 订单图 vs 款图 | — | 只读 | 对比是"人看图"，但没有把"同 listing 其他色"一起摆出来 | 对比模式是否并入 listing 认款表？ |
| **P-09** | 改绑 `row-rebind` | `ProductPicker` 预填原色 | `spec: pickedColor || row.spec || '*'` | `pl_shop_sku` | 改绑会把 `spec` 换成新色，但旧色没有"作废"记录 | 改绑是否保留旧行历史（状态 invalid）而不是覆盖？ |
| **P-10** | 标失效 / 恢复 | `skuInvalidate` | `(shop,item,spec)` | `pl_shop_sku.status` | 失效键里仍带 `spec='*'`，多色 listing 无法只失效其中一个色 | 失效是否改成按 `(shop,item,image)` 行？ |
| **P-11** | 建款向导 `items-new-product` | `ShopItemWizard` | `pl_shop_items` 快照 | `pl_products` + `pl_variants` + `pl_shop_sku` | 一次点击"建档 + SKU 矩阵 + 映射"，但 SKU 矩阵来自采集快照；采集没有色图时矩阵可能是空壳 | 向导是否只建档 + 记映射，**不预生成 SKU 矩阵**？见 D6 |
| **P-12** | 手贴商品 / 采集刷新 | `items-manual-import` / `items-status` | `pl_shop_items` | `pl_shop_items` | 采集快照无 color/size 结构（`sku_json` 是自由 JSON） | 采集快照是否要拆出 SKU 行？还是只当"证据"？见 D4 |
| **P-13** | 删除待认行 | `i-row-delete` | `pl_shop_items` | 只删快照 | 删快照不影响订单队列（订单仍会再出现） | 保持不动 |

### 3.3 右栏商品池 · 已认

| 编号 | 功能 | 入口 / 取数 | 输入与键 | 写哪些表 | 现在的问题 | 待确认 |
| --- | --- | --- | --- | --- | --- | --- |
| **P-14** | 已认分页 / 筛选 | `mappedList`（`skuMappingSql()`） | `pl_shop_sku` 映射行 | 只读 | 一行 = 一个 `(shop,item,spec)`；`spec` 是**我方色名**，所以"这个 listing 平台有 7 个色"看不出来 | 已认列表是否改为按 listing 分组、组内 7 行？见 D3 |
| **P-15** | 一行一条映射 vs 一个 SKU 一条 | `upsertSkuMappings`（`product-db.ts:1721`） | 判重键 `(shop_id,item_id,spec)` | `pl_shop_sku` | 同一个 listing 的 7 个平台色，如果 7 个色的**我方色名不同**，可以落 7 行；但解析时 `resolveOrderSku` 只按 `(shop,item)` 取 **1 行**，于是永远只命中第一行 | 解析是否改成"按图片命中具体行"，而不是 listing 级"取第一行"？见 D1 / D5 |
| **P-16** | 映射来源标签 / 状态 | `source` / `status` | — | `pl_shop_sku` | `pending` / `invalid` 与解析链没有强制关系：解析只认 `confirmed` | `pending` 映射是否参与解析？建议：不参与，但界面要显式说"这条还没生效" |
| **P-17** | 商品清单池（隐藏页签） | `SHOP_PRODUCTS_TAB_ENABLED = false`；6 个 IPC 保留 | `pl_shop_sku` 池行（`source='shop-import'` / `shop_id=0`） | `pl_shop_sku` | 池行真库 **0 行**；页签已收起，但表与 IPC 还在，形成"同一张表两个种群" | 是否删除池行种群与 6 个 IPC？见 D12 |

### 3.4 产品编辑抽屉 / SKU（`ProductEditorDrawer.vue`、`SkuMatrixEditor.vue`、`SkuWeightPanel.vue`）

| 编号 | 功能 | 入口 / 取数 | 输入与键 | 写哪些表 | 现在的问题 | 待确认 |
| --- | --- | --- | --- | --- | --- | --- |
| **P-18** | 档案：编码 / 名称 / 类目 / 供应商 / 进价 / 状态 | `ProductEditorDrawer` | `pl_products` | `pl_products` | 编码编辑时只读（改码会断 `oi_styles.code` 与所有引用） | 编码是否仍只读？（建议：是） |
| **P-19** | 主图上传 / 更换 / 移除 | `pl_images`（内容寻址） | 图片指纹 | `pl_images` | `pl_images` 12 张与 `oi_images` **同指纹双份字节** | 图片是否统一目录/统一表？见 D11 |
| **P-20** | SKU 矩阵：色 × 码，格 = 在卖 + 克重 | `SkuMatrixEditor`；`variantUpsert` **全量提交** | `(product, color, size)` | `pl_variants` | 457 行 / 19 款；订单实际只用到 59 个 `(listing,色)` 键；**订单克重 0/75 有值** —— SKU 维护没有回报 | SKU 是否改为"按需稀疏 + 款默认克重"？见 D6 / D7 |
| **P-21** | 常量：常用色 / 预设码 / 默认克重 / 填空白 | `mx-preset` 等 | — | `pl_variants` | 常用色是固定词表；与订单色原文仍无映射 | 是否建"平台色原文 → 我方色名"的**按款**别名？见 D8 |
| **P-22** | 克重面板 | `SkuWeightPanel`；失焦即落库 | `(product, color, size)` | `pl_variants.weight_g` | 逐格填 457 格；运费试算才是买家 | 是否改成"款默认 + 按码覆盖"？见 D7 |
| **P-23** | 从采集商品导入 SKU | `ed-import-*` | `pl_shop_items.sku_json` | `pl_variants` | 采集快照的色名与订单色原文可能对不上 | 是否保留？建议保留为"预填"，不自动建 |
| **P-24** | 旧自由文本 SKU | `ed-legacy` | — | `pl_variants` | 历史遗留入口 | 是否删除？ |
| **P-25** | 删除产品 | `ed-delete-product` → `deleteProduct` | `pl_products.id` | 只删 `pl_products` | **变体不清理**：真库 23 行孤儿 `pl_variants`；`oi_variant_keys` 9 行外键悬空 | 删除是否级联清理变体/映射？见 D12 |

### 3.5 产品 Excel 导入 / 建款向导

| 编号 | 功能 | 入口 / 取数 | 输入与键 | 写哪些表 | 现在的问题 | 待确认 |
| --- | --- | --- | --- | --- | --- | --- |
| **P-26** | 三步导入：选文件 → 预览修错 → 导入 | `ProductImportDialog` | 一行一个款；色一格一个、码逗号多格、克重按顺序 | `pl_products` / `pl_variants` / 供应商 | 导入即生成完整矩阵（色 × 码），这是 457 行的主要来源 | 导入是否只建"款 + 色"，码/克重留空？见 D6 |
| **P-27** | 同名款覆盖 / 跳过 | 同上 | `pl_products.name` | `pl_products` | 覆盖会把已有 SKU 冲掉？需核对 | 覆盖语义是否只覆盖档案、不动 SKU？ |
| **P-28** | 供应商同名复用 / 新建 | 同上 | 供应商名 | `pl_suppliers` | 与键改造无关 | 保持 |

---

## 4. 三条身份链与色词表（改造前必须对齐）

### 4.1 现在的三条链

| 链 | 身份键 | 落在哪 | 谁写 | 断点 |
| --- | --- | --- | --- | --- |
| **订单识别** | `(店铺, 商品ID, 平台 Color 原文)` → `variant_key` | `oi_order_items.variant_key` | 导入时算好（`variantKeyOf`） | `Color` 原文被当身份；实际图才是 SKU 级身份 |
| **认款映射** | `(platform, shop_id, item_id, spec)`，`spec` = **我方色名** | `pl_shop_sku` | 人点关联 / 保存回填 | 键里没有"平台色原文"，也没有"图片"；`spec='*'` 当兜底 |
| **订单归款结果** | `oi_order_items.style_color_id` → `oi_style_colors(color)` → `oi_styles(code)` | 三张表一次投影 | `ensureStyleColor` / `autoAssignByMap` | 一个款色被投影三次；`oi_styles` 仍会建占位行 |

### 4.2 三套色词表（真库读数）

| 词表 | 列 | 取值数 | 典型值 |
| --- | --- | --- | --- |
| 订单行 | `oi_order_items.color` | 23 | `1`…`11`、`未分类`、`红色`（1 行被人工改过） |
| 款色 | `oi_style_colors.color` | 32 | `未分类` 11、`4` 8、`6` 6、`1` 6、`红` 2、`红色`… |
| 产品 SKU | `pl_variants.color` | 15 | `黑色` 121、`红色` 116、`白色` 116、`深蓝` 16、`黑` 8、`红` 8… |
| 映射 | `pl_shop_sku.spec` | **3** | `*` 46、`红` 1、`红色` 1 |

> 四套词表里**没有任何一套能直接对上另一套**。这是"Excel 定不了色"的第二个根因：即使键命中，色名也要再翻译一次。

### 4.3 统一图片表（回答"图片是否单独维护"）

**现状：不是统一维护，是两套半。**

| 观测（真库副本，2026-10-30） | 值 | 后果 |
| --- | --- | --- |
| `pl_images` | 12 行（款主图，落 `product-images/`） | 与订单图同一张字节存两份 |
| `oi_images` | 101 行（订单图，落 `order-images/`） | 两套 `AUTOINCREMENT`，id 各自从 1 开始 |
| 同指纹同时出现在两表 | **12** | 同一张图两条记录、两个 id、两份文件 |
| `pl_item_images` | **0 行** | "商品 → 覆盖图"写了没人读 |
| `pl_shop_items.image_id` 非空 | **0/71** | 采集图只存远程 URL，本地没落地 |
| 备份范围 | 只有 `order-images/` | 恢复后款图全丢（`backup.ts` 只 `cpSync` 订单图目录） |
| 已知生产事故 | `electron/order-image-land.ts` 文件头 | 两表 id 撞车，"一次采纳"改到了任意一张订单图 |

→ 用户看到的"同一张图有的地方能显示、有的地方不能显示"，不是前端渲染问题，而是**同一张图有三个落点、两种 id、一个不进备份**。这与用户第 1 点的判断一致：**该收成一张表。**

**目标：`md_images` 全项目唯一图片仓（内容寻址）。**

```sql
CREATE TABLE md_images (
  id              INTEGER PRIMARY KEY AUTOINCREMENT,
  fingerprint     TEXT NOT NULL UNIQUE,     -- SHA-256，内容寻址（主身份）
  url_fingerprint TEXT,                     -- 归一 URL 的哈希，普通索引：图未落地时可查
  local_path      TEXT NOT NULL,            -- userData/images/<fingerprint>.<ext>
  source_url      TEXT,                     -- 首次落地时的远端地址（证据）
  source          TEXT NOT NULL DEFAULT 'order', -- order | product | collect | manual
  byte_size       INTEGER,
  created_at      TEXT NOT NULL DEFAULT (datetime('now'))
);
CREATE INDEX idx_md_images_url ON md_images(url_fingerprint);
```

落地规则（"双写"的具体含义）：

1. **一份字节一份文件**：文件名 = 指纹，目录统一 `userData/images/`；同字节重复落地只命中同一行（`INSERT .. ON CONFLICT(fingerprint) DO UPDATE`），不再出现"两个 id 同一张图"。
2. **写文件 + 写库行**：两步都成功才算落地；只写库没写文件 → 标记 `local_path` 悬空并在体检里报出来（不再静默）。
3. **业务表只存 `image_id`**：`pl_products.image_id`、`oi_order_items.image_id`、`pl_shop_items.image_id`（新补）、`pl_shop_sku.image_id`（新，映射键用）。
4. **一个目录一个口径**：缩略图、孤图清理、备份/恢复都只认 `userData/images/` + `md_images`。备份改造必须同时做——否则"库里有一行、文件没备份"会比现在更隐蔽。
5. **订单域的识别字段不搬进来**（`status` / `result_json` / `error` / `features`）：云端视觉已于 2026-10-28 删除；如仍要特征匹配，单开 `oi_image_recognition(image_id PK, ...)`（见 D16）。

**属性落点（对用户第 1 点后半句的修正）**：颜色/款**不写在图片行**，写在映射行：

```text
pl_shop_sku(shop_id, item_id, image_id, color_raw)  →  product_id + color_id + status
```

理由：图片是"字节身份"，归属是"哪个 listing 的哪个 SKU 用了它"。同一张图会被多个 listing 复用（同款多链接、主图被多色共用），
写死在图片行会让**第二个 listing 读到第一个的结论**。用户要的"商品ID + 图片指纹 → 款色"，就是这一行映射的查询，能力不减，且可逐 listing 回滚。备选方案见 D14。

### 4.4 颜色 / 尺码主数据（对用户第 2 点）

**现状：没有主数据表，色有 4 套词表，码有两套写法。**

| 观测（真库副本，2026-10-30） | 值 |
| --- | --- |
| 订单行 `oi_order_items.color` | 23 种（`1`…`11`、`未分类`、`红色`…） |
| 款色 `oi_style_colors.color` | 32 种（`未分类` 11、`4` 8、`6` 6、`1` 6…） |
| 产品 SKU `pl_variants.color` | 15 种（`黑色` 121、`红色` 116、`白色` 116、`深蓝` 16…） |
| 映射 `pl_shop_sku.spec` | 3 种（`*` 46、`红` 1、`红色` 1） |
| 尺码 `pl_variants.size` | 8 种（`S`/`M`/`L`/`XL`/`XXL`/`3XL`/`4XL`/`5XL`） |
| 订单 `oi_order_items.size` | 7 种（同上，但有 **`XXXL` 与 `3XL` 两种写法**） |
| 唯一的"别名"尝试 | `oi_color_aliases` **5 行** |

**目标：三张小主数据表，其他表只存 id。**

```sql
md_colors(id, name UNIQUE, hex, sort_order, status, created_at)
md_sizes (id, name UNIQUE, size_group, sort_order, status, created_at)
md_color_aliases(id, product_id, alias_key, color_id, created_at,
                 UNIQUE(product_id, alias_key))   -- product_id = 0 表示全局别名
```

- **种子**：`md_colors` 取现有 15 种色 + `src/lib/colorSwatch.ts`（44 个色名键、10 个常用色，`findSwatch` 认不出返回 null 不画错块）；`未分类` 与纯数字（`1`…`11`）**不是颜色**，作为"待认色"状态，不入字典。`md_sizes` 取 8 种现有码，`XXXL`/`3XL` 用别名归一到同一行（并保留 `size_group` 一键套 `S-5XL`）。
- **改引用**：`pl_variants.color/size` → `color_id`/`size_id`（`UNIQUE(product_id,color_id,size_id)`）；`oi_style_colors.color` → `color_id`（`UNIQUE(product_id,color_id)`）；`pl_shop_sku` 加 `color_id`（另有 `color_raw` 存平台原文）。
- **订单行保留 `color` 原文**：它是证据，不参与判定；我方色由 `style_color_id` → `oi_style_colors.color_id` → `md_colors.name` 派生。
- **别名作用域**：`product_id=0` 全局（如 `Black→黑色`、`XXXL→3XL`）+ 按款覆盖（同一平台原文在不同款可对应不同色）。见 D17。
- **迁移成本（代码引用量，真库实测 grep）**：图片表相关约 **150 处 / 16 个文件**；`oi_style_colors` 95 处；`spec` 65 处；`pl_variants` 色/码 62 处。所以主数据必须先落（S0a），否则解析函数会在旧的三套词表上再写一套翻译，等于固化成第二套事实。

---

## 5. 待确认决策表（D1–D18）

> D1–D5 是"键"的地基，**已全部确认**；D6–D8、D11、D12 也已定。表中保留选项只为记录来路，未确认的只剩 D9 / D10 / D13 / D14–D18。

| 编号 | 问题 | 选项 | 我的建议 | 影响面 |
| --- | --- | --- | --- | --- |
| **D1** | 图片键取什么？ | A. 内容指纹 `md_images.fingerprint`（SHA-256）<br>B. 归一 URL 文本<br>C. `fingerprint + colorRaw` 复合 | **A ✅（用户"图片指纹"口径已确认）**：内容寻址、离线可用、换 CDN 参数不失效。图还没落地时先用归一 URL 作临时键；落地后**同一行 UPDATE 升级为指纹**，不新增行（升级规则需在 S0b 实现） | 导入链路、映射表加列、解析函数 |
| **D2** | `Color` 原文进不进唯一键？ | A. 只作证据列（唯一键 = `shop,item,image`）<br>B. 进唯一键（`shop,item,image,color_raw`）<br>C. 完全丢掉 | **B ✅ 已确认**：图正常时 1:1；图被两个 SKU 复用时用 `color_raw` 消歧；两者都撞 = 待认，不猜 | 映射表 DDL、解析优先级 |
| **D3** | 映射表怎么改？ | A. 改 `pl_shop_sku`（加 `image_id` / `color_raw` / `color_id`）<br>B. 新建 `pl_listing_skus`，旧表退役 | **A ✅ 已确认**：`pl_shop_sku.id` 已被引用，重建代价大；改列 + 迁移最稳 | 映射写入、已认列表、回填 |
| **D4** | `spec` 的语义 | A. 保留 `spec` 作"我方色名"（只当输出）<br>B. 拆成 `color_raw`（输入）+ `color_id`（输出），删 `spec` | **B ✅ 已确认**：把"输入键"和"输出"分开，才不会再出现"用输出匹配输入" | 所有 `spec` 读写点（真库仅 48 行） |
| **D5** | 解析回落的规则 | A. 完全禁止任何回落，命中不了就待认<br>B. 允许"图唯一命中"的 3 元组命中；4 元组优先<br>C. 保留 `spec='*'` 单色捷径（已否定） | **B ✅ 已确认（用户第 4 点"允许"）**：`(shop,item,image)` 唯一命中是**精确键**，不是模糊回落；`spec='*'` 行全部作废，改为"待认色"状态；listing 级认款写显式 `pending_color` 行 | `resolveOrderSku` / `autoAssignByMap` / 回填 |
| **D6** | `pl_variants` 去留 | A. 删表，克重全挂款<br>B. 稀疏保留（按需建行）+ 款默认克重<br>C. 保持现状 | **B ✅ 已确认（用户第 5 点"可以"）**：保留"按码可选覆盖"的能力，但新建款不再生成矩阵；导入不再铺满 | 订单取重、SKU 编辑器、导入 |
| **D7** | 克重粒度 | A. 只按款（`default_weight_g`）<br>B. 款默认 + 按码覆盖<br>C. 款默认 + 按色 + 按码 | **B ✅ 已确认（用户第 5 点"可以"）**：运费主要随码变；按色分重是极少数（真库 15 种色里没有证据） | `pl_products` 加列、订单取重 SQL、SKU UI |
| **D8** | 色名怎么收口？ | A. 不用字典，继续各表存文本<br>B. **全项目一张 `md_colors`** + `md_color_aliases`，其他表只存 `color_id`<br>C. 只做别名表，不建字典 | **B ✅ 已确认（用户第 2 点）**：订单原文 →（全局/按款别名）→ `color_id` → 色名；`oi_style_colors` / `pl_variants` / `pl_shop_sku` 全部改存 `color_id`（设计见 §4.4） | 色名读写、命名板、款色查询 |
| **D9** | 认款 UI 落点 | A. 发货台「归类核对」按 listing 展开 SKU 行<br>B. 产品管理右栏按 listing 展开<br>C. 两处都做（同一组件） | **A ✅ 已确认**：发货台为主，产品管理右栏只显示"还差多少"并跳转 | 两个页面的组件与取数 |
| **D10** | 「待认」的状态与回滚 | A. 只在内存/界面提示<br>B. 行级状态 `pending_style` / `pending_color` / `confirmed` / `ignored`，全部可见可回滚 | **B ✅ 已确认**：状态落在 **`pl_shop_sku.status`**（映射行是唯一认款事实），订单行状态由 JOIN 派生 | 映射状态、列表筛选、回填 |
| **D11** | 图片目录 | A. 保持 `order-images` / `product-images` 两套<br>B. **合并为内容寻址的一套** `userData/images/` + `md_images` | **B ✅ 已确认（用户第 1 点）**：旧建议 A 作废。理由：同指纹双份字节、两套 id 撞车、备份只含其一。清理策略改为"按引用计数归档"，不按目录归属 | 图片落地（`order-image-land.ts`）、备份、缩略图、孤图清理 |
| **D12** | 旧数据怎么办 | A. 全清（测试数据可丢）<br>B. 能按新键迁移的迁移，其余清空<br>C. 全保留 | **A ✅ 已确认**（用户已说测试数据可丢）：`pl_shop_sku` 48 行清空重建，`pl_shop_items` 采集快照保留；删库重建后跑 `foreign_key_check` | 迁移脚本、冒烟夹具 |
| **D13** | 「商品清单」池与套装 | A. 删池行 + 6 IPC；套装两表删<br>B. 保留但标"停用"<br>C. 都保留 | **A ✅ 已确认**：池行真库 0 行；套装写函数零生产调用者 | `pl_shop_sku` 种群、`shop-product` IPC、两表 |
| **D14** | 图片属性（款/色）写哪？ | A. **只写映射行** `pl_shop_sku(shop,item,image,color_raw)`<br>B. 只写图片行（`md_images` 加 `product_id`/`color_id`）<br>C. 两处都写，图片行只当缓存、以映射行为准 | **A ✅ 已确认**：图片是"字节身份"，归属是"哪个 listing 的 SKU 用了它"；一图跨 listing 复用时 B 会让第二个 listing 读到第一个的结论。用户要的"商品ID + 图片指纹 → 款色"由 A 完全满足 | `md_images` 列集、`pl_shop_sku`、解析函数 |
| **D15** | 远端图是否全部落地？ | A. **全部落地**进 `md_images`（订单图 + 款图 + 采集图）<br>B. 只有"认款要用/要展示"的图落地，其余只存 URL<br>C. 都不落地，只存 URL | **A ✅ 已确认**：不落地就无法用内容指纹当键（D1），也无法保证离线显示/备份可恢复。`pl_shop_items.image_id` 71/71 为 0 正是"只存 URL"的后果；磁盘代价 ≈ 现有 101 张订单图 + 12 张款图 | 导入/采集落地链路、磁盘占用、备份体积 |
| **D16** | `oi_images` 识别字段去留 | A. **全删**（`status`/`result_json`/`error`/`features`；`style_color_id` 归映射行）<br>B. 单开 `oi_image_recognition(image_id PK, ...)` 保留特征匹配<br>C. 搬进 `md_images` | **A ✅ 已确认**：云端视觉已于 2026-10-28 整条删除，真库 92/101 的 `style_color_id` 是旧记忆，改由映射行承担；若后续确需特征，再走 B，绝不进主数据表 | `order-db.ts` 的 DDL/写入点、`md_images` 列集 |
| **D17** | 颜色别名作用域 | A. **全局（`product_id=0`）+ 按款覆盖**<br>B. 只按款<br>C. 只全局 | **A ✅ 已确认**：`Black→黑色` 是全局常识；同一平台原文在不同款可对应不同色时用按款行覆盖。`UNIQUE(product_id, alias_key)` 即可表达 | `md_color_aliases`、认款时的色名解析 |
| **D18** | `pl_variants` 文本列去留 | A. **删 `color`/`size`/`name`，只留 `color_id`/`size_id`**<br>B. 保留 `name` 作展示缓存（写时同步）<br>C. 全保留（与 id 并存） | **A ✅ 已确认**：与 D8 一致，避免两套真值；展示名由 JOIN `md_colors`/`md_sizes` 派生。若性能需要缓存，用视图而非冗余列 | `pl_variants` DDL、SKU 编辑器、订单取重 SQL |

> **D14–D18 与用户第 1 点的关系**：用户提的"图片表可以双写、属性也放进去"由 D14 决定落点；D15/D16 决定这张表里到底放哪些字段；D17/D18 决定颜色/尺码收口后文本列是否还留。

---

## 6. 确认后的分期（草案，未拍板）

| 阶段 | 内容 | 解决什么 | 依赖 | 对应方案分期 |
| --- | --- | --- | --- | --- |
| **R0** | 修拆行器（一段一行、色/码齐全）+ 清空旧映射（测试数据可丢） | 让"键"有干净的输入 | Q6 ✅ / D12 ✅ | 前置 |
| **R1** | **主数据先落地**：`md_images`（合并三张图表、统一 `userData/images/`、远端图全落地、进备份）+ `md_colors` + `md_sizes` + `md_color_aliases`；业务表只存 `image_id` / `color_id` / `size_id` | "同一张图有的显示有的不显示"、四套色词表、`XXXL`/`3XL` | D8✅ D11✅ / D14–D18 | S0a |
| **R2** | 映射键改**图片优先**：`pl_shop_sku` 加 `image_id` / `color_raw` / `color_id`；`UNIQUE(shop_id,item_id,image_id,color_raw)`；解析无命中即待认；**删 `'*'` 回落**；listing 级显式认款行 | **Excel 定款定色**（一个 listing 多色各归各） | D1–D5 ✅ 全部确认 | S0b |
| **R3** | 认款 UI 按 listing 展开 SKU 行（发货台为主、产品管理保留入口），一屏写映射 + 回填；状态四档可见可回滚 | 首轮 69 次决定 → 每次导入 0 次 | D9 ✅ / D10 ✅ | S1 |
| **R4** | 款色收口：`oi_style_colors` 改 `product_id` + `color_id`；删 `oi_styles` / `oi_variant_keys` | 一个事实一张表 | D8✅ | S2 |
| **R5** | SKU 稀疏（`color_id`/`size_id`）+ 款默认克重 + 缺口清单 + 尺码组预设 | SKU 维护时间 | D6✅ D7✅ / D18 | S3 |
| **R6** | 删旧图表 / 死表 / 池行 / 识别字段，重建库 + `foreign_key_check` | 收尾与数据质量 | D12 ✅ / D13 ✅ / D16 ✅ | S4 |

> **顺序为什么是"主数据 → 键 → UI"**：R2 要用 `image_id` 与 `color_id`；若先改解析，就得在旧的两张图表、四套色词表上再写一套翻译，等于把临时状态固化成第二套事实。R1 先把"一张图、一套色/码"立起来，R2 才是真正的一刀。

---

## 7. 明确不做（本轮）

- ❌ 不用 CLIP/视觉做**归类键**（AUC 0.522 ≈ 随机，已有裁定）；图只用于展示与人工判断。
- ❌ 不做"按平台 Color 原文批量命名/批量认色"——同一原文跨 listing 不保证同色。
- ❌ 不做"导入即自动建款"（2026-10-29 已回退）。
- ❌ 不在键未定时动 `oi_style_colors` 的 86 行历史归类结果。
- ❌ 不动结算对账 / 运费报价 / 记账。

---

## 8. 确认结果与下一步

**全部确认（2026-10-30 第四轮，用户"按建议继续确认剩余项"）：**

| 项 | 结果 |
| --- | --- |
| Q6 拆行器 | **先修**：一段一行、色/码齐全；空色不写 `''`，落"待认色" |
| D9 认款 UI | **A**：发货台「归类核对」为主，产品管理右栏保留入口 |
| D10 待认状态 | **B**：`pending_style` / `pending_color` / `confirmed` / `ignored` 四档，落在 `pl_shop_sku.status` |
| D13 池与套装 | **A**：删池行 + 6 IPC；套装两表删 |
| D14 图片属性落点 | **A**：只写映射行 |
| D15 远端图落地 | **A**：全部落地进 `md_images` |
| D16 识别字段 | **A**：全删，`style_color_id` 归映射行 |
| D17 颜色别名作用域 | **A**：全局 + 按款覆盖 |
| D18 变体文本列 | **A**：只留 `color_id` / `size_id` |

**下一步**：施工清单见 [`PRODUCT_ORDER_SIMPLIFY_PLAN_2026-10-30.md`](PRODUCT_ORDER_SIMPLIFY_PLAN_2026-10-30.md) §10（R0 / R1 的文件级改动、迁移方式、冒烟命令、变异点）。先做 R0（拆行器 + 清库），再做 R1（`md_images` / `md_colors` / `md_sizes` / `md_color_aliases`）。

> 施工开始前本文与方案文档保持"未改代码"状态；改动落地时按 `docs/` 分工回报到 `CHANGELOG`。
</content>
