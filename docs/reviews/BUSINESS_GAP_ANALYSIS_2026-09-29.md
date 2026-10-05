# 业务能力差距审查（对 5 大目标需求的落地距离）

> **性质**：审查报告 + 改动清单。§1–§3 是**客观现状**（以代码为准，带 `文件:行` 取证），§4–§6 是**要做的改动**（含待拍板项）。
> **审查对象**：5 大目标需求（店铺管理 / 产品管理 / 物流价格测算 / 订单管理 / 财务管理）对照当前代码。
> **取数时点**：2026-09-29。IPC 契约与 op 数为**实跑所得**（`npm run verify`），非抄文档。
> **前置阅读**：`AGENTS.md`、`docs/baseline/PROJECT_BASELINE.md`、`docs/plans/DOMAIN_INTEGRATION_PLAN.md`、`docs/features/PRODUCT_LIBRARY.md`、`docs/decisions/ADR-002-master-data-layer.md`。

---

## 0. 结论速览

### 0.1 五大需求成熟度

| # | 需求 | 成熟度 | 一句话结论 |
|---|---|---|---|
| 1 | 店铺管理 | 🟡 **85%** | 实体表 + 名称归一 + 维护界面已就绪；差「被其他模块用起来」（S2/S3 未做） |
| 2 | 产品管理 | 🟡 **85%** | 产品/SKU/克重/图片/供应商/商品映射已就绪；差**成本维护界面**（P4）与 SKU 级成本 |
| 3 | 物流价格测算 | 🟢 **90%** | 报价 / 按订单试算 / 按产品试算三条链路都在；差**运价表不在中立层**与多件计费 |
| 4 | 订单管理 | 🔴 **25%** | 预期利润整条链缺 6 个环节；统计无跨域 op；拣货未开工（P5） |
| 5 | 财务管理 | 🔴 **10%** | 供应商对账 + 店铺成本分摊已有；差店铺×天对账、**费用表**、分摊规则、店铺利润 |

### 0.2 一句话根因

**数据基本都在，但没有一个能跨域把它们算到一起的出口；而订单域缺「钱」和「量」。**

三条具体判断：

1. **跨域计算 op 一个都没有**。12 个 db 能力域全是单域 op（`src/core/plugin/host.ts` 的 `DB_OPS`）。`oi_*`（订单）、`pl_*`（产品）、`ae_cost_map`（成本）、`purchase_*`（拿货付款）、`shipping-rate`（运费）五张网各自完整，**没有一根线把它们串起来**。这正是 `DOMAIN_INTEGRATION_PLAN` S3 `shopOverview` 想解决的问题，至今未开工。
2. **订单库里没有金额、没有数量**。`oi_orders`（`electron/order-db.ts:168`）的 12 个列里没有任何金额列；「产品数量」在拆行时被丢弃（`src/lib/shipRateOrders.ts:143` 注释明确"数量恒取 1"）。收入侧字段只存在于**另一套数据** `ae_orders`（浏览器扩展推送的 AE 后台数据，`src/types.ts:1808`）。**"订单预期利润"目前连输入都不完整。**
3. **财务管理是整块空白**。没有任何表承载「运营费用 / 杂费 / 分摊规则」，也没有"店铺利润"这个计算出口。现有的只有**供应商维度**对账与**成本侧**店铺分摊。

### 0.3 本次审查顺带发现的文档漂移（3 处，已实测）

| 项 | 文档写的 | 实测 | 位置 |
|---|---|---|---|
| IPC 契约规模 | `PROJECT_BASELINE.md` §5：**166 声明 / 162 通道** | **182 / 182 / 178 通道** | `npm run verify` 实跑 |
| `product` 域 op 数 | `PRODUCT_LIBRARY.md` §6.2、`host.ts:342` 注释：**6** | **8**（1.2.0 加了 `variantList` / `itemImagePool`） | `host.ts` 解析 |
| `product-admin` 域 op 数 | `PRODUCT_LIBRARY.md` §6.2：**7** | **10**（1.4.0 加 `batchUpdate`，已满额） | 同上 |

> 这三处都不影响功能，但会让"还剩多少 op 预算"的判断出错 —— 而本报告的方案恰恰受这个预算约束。

---

## 1. 现状盘点（客观事实）

### 1.1 12 个 db 能力域与 op 预算（实测）

| 域 | op 数 | 声明它的岛 | 读取面 |
|---|---:|---|---|
| `order-insight` | **37** | order-insight | 独占（存量超预算，冻结） |
| `purchase` | **24** | order-insight、ae-profit | 共享（存量超预算，冻结） |
| `shop-accounts` | **17** | shop-accounts | 独占（存量超预算，冻结） |
| `product-admin` | **10** | product-library | owner 写（**满额**） |
| `ae` | 9 | ae-profit | 独占 |
| `product` | **8** | product-library | 共享只读 |
| `shop` | 8 | shop-accounts | **设计为共享只读，但当前写读同域** |
| `excel-copy` | 7 | excel-copy | 独占 |
| `shipping-rate` | 6 | shipping-rate | 独占 |
| `shop-products` | 6 | product-library | owner 写 |
| `product-image` | 4 | product-library | owner 写 |
| `product-supplier` | 4 | product-library | 共享（供应商主数据） |

> 预算：单域 ≤ 10 op（ADR-002 N5）。**当前 `product-admin` 已满、`product` 8、`shop` 8** —— 加新 op 前必须先找位置，这是本报告方案最大的结构性约束。

### 1.2 各岛的域声明（`ui-plugins/*/manifest.json`）

| 岛 | 版本 | 声明的 db 域 |
|---|---|---|
| `shop-accounts` | 1.5.2 | `shop-accounts`、**`shop`** |
| `order-insight` | 1.3.0 | `order-insight`、`purchase` |
| `product-library` | 1.5.0 | `product`、`product-admin`、`product-image`、`product-supplier`、`order-insight`、`shop-products` |
| `ae-profit` | 1.0.2 | `ae`、`purchase` |
| `shipping-rate` | 1.2.1 | `shipping-rate` |
| `excel-copy` | 1.0.0 | `excel-copy` |

> **关键事实**：`shop` 域**只有拥有者自己声明**（S2 未做）。`product` 域同理 —— 只读面已拆好，但**没有任何第二个消费方**。也就是说"产品库建好了给别人用"这件事，至今零消费方。

### 1.3 唯一贯通的锚点

| 实体 | 状态 | 取证 |
|---|---|---|
| **款式编码** | ✅ 真贯通（`oi_styles.code` ≡ `pl_products.code` ≡ `purchase_items.style_code` ≡ `ae_cost_map.style_code`） | `electron/order-db.ts:273`（`migrateStyleAuthority`） |
| **店铺** | 🟡 实体已立、映射已建、**零消费方** | `electron/shop-db.ts:140`（`sk_shops`）、`:160`（`sk_name_map`） |
| **店铺商品ID → 产品** | 🟡 映射层已建，只在主进程内部被调用 | `electron/product-db.ts:1123`（`resolveOrderSku`，**无 op**） |
| **订单行 → SKU 变体** | ❌ 断的 | `electron/product-db.ts:1141` 注释："一期只有 `spec='*'` 的生产者（变体表推迟到 P5）" |

---

## 2. 逐需求差距分析

### 2.1 店铺管理 —— 🟡 85%

**已具备**

| 能力 | 落点 |
|---|---|
| 店铺实体表（`platform` × `name_key` 唯一 + `platform_shop_id` 部分唯一） | `electron/shop-db.ts:140` |
| 名称归一映射（历史文本零改写，`kind` 预留 supplier/style/product） | `electron/shop-db.ts:160` |
| 未归一名单实时聚合 | `shop-db.listUnmapped` |
| 维护界面（店铺登记页 / 编辑抽屉内「名下店铺」区块） | `ui-plugins/shop-accounts` 1.5.0 / 1.5.2 |

**缺口**

1. **其他模块用不到店铺实体**。`shop` 域只有 `shop-accounts` 声明（§1.2）。订单归类、利润追踪仍按自由文本来 —— 即 D1「只部分收敛」。
2. **`shop` 域写读同域**：`upsert` / `map` / `unmap`（写）与 `list` / `summary` / `unmapped`（读）在同一域，而 ADR-002 C4 要求共享域只读（`host.ts:411-416` 注释已明确记下这个待办）。**放行之前必须先按 C4 拆只读子域。**
3. **没有"店铺经营视图"**（S3 `shopOverview` 未开工）：进一家店看不到它的订单数/成本/收入/毛利。

### 2.2 产品管理 —— 🟡 85%

**已具备**

| 能力 | 落点 |
|---|---|
| 产品（款式）主数据 + 唯一权威写入权 | `pl_products`（`electron/product-db.ts:87`） |
| SKU 子表（服装「颜色+尺码」组合、克重 `weight_g`） | `pl_variants`（`electron/product-db.ts:1384`） |
| 图片三层回落（覆盖图 → 订单图 → 款主图） | `pl_images` / `pl_item_images` |
| 店铺商品ID → 产品映射 + 待关联队列 | `pl_shop_sku`（`electron/product-db.ts:756`） |
| 商品清单（按 `item_id` 去重、一对多关联、套装） | `ui-plugins/product-library` 1.5.0 + `shop-products` 域 |
| 供应商（厂家）主数据维护 | `product-supplier` 域（1.4.0 迁入） |
| Excel 导入 / 导出 / 批量编辑 / 批量删除 | `ui-plugins/product-library` |

**缺口**

1. **P4「成本维护界面」未开工**（`PRODUCT_LIBRARY.md` 进度表标 ⬜）。现在成本只能从 ae-profit 岛的「成本衔接」导一次快照（`costSnapshot`），**手工成本没有任何录入界面**。
2. **成本是款级，无 SKU 级**。`ae_cost_map` 主键是 `(style_code, effective_from, source)`；`costSnapshot()` 口径注明"不计颜色/尺码差异"（`electron/purchase-db.ts:941`）。同款不同色的进价差算不出来。
3. `pl_products` **没有任何价格列**（`code/name/supplier_id/category/status/note`）—— 这是刻意的（成本归 `ae_cost_map`，ADR-002 Q2），但意味着产品页看不到进价，得跨域读。
4. 变体的 `spec` 拆列（颜色/尺码之外的规格维度）留给 P5。

### 2.3 物流价格测算 —— 🟢 90%

**已具备**

| 链路 | 落点 | 说明 |
|---|---|---|
| 报价单 Excel → 运价表（17 段互斥归一化） | `src/lib/shipRate.ts`（832 行）+ `tests/shipRate.spec.ts`（50 例） | 版式族探测、非本币拒算、最低计费重量 |
| 克重 → 逐国运费（单点计价口径） | `src/lib/shipRateQuote.ts` | 两种计价与进位边界 |
| 按订单试算（订单原始行 → 国家 → 逐单运费） | `src/lib/shipRateOrders.ts` + `quoteOrders` op | 拒算五分类逐行带 `reasonClass` |
| 按产品试算（目的国 × `pl_variants.weight_g`） | `quoteProducts` op | 与订单侧两条独立重量数据源 |
| 商品信息 Excel → `pl_item_weights` | `importProductWeights` op | 逐表语义探测，不写死第一张 |

**缺口（其中一条是结构性的）**

1. 🟡 2026-09-29 部分推进：**运价表快照已落宿主中立层**（新表 `sr_rate_snapshots` + 3 个通道，
   导入时由宿主 op 留档、按生效日可复算），**但"当前那份表"的编辑仍在岛侧**（岛仍把整张表传进来）——
   本条的 C3 缺口**收窄但未关闭**，余下的是"岛改读宿主表"（那一步要连带给岛升版）。
   ⚠️ 原文（未改，记录当时判断）：**运价表存在岛的私有 storage 命名空间里**。`quoteOrders` / `quote` / 全部计价 op 都需要调用方**把整张运价表传进来**（`host.ts:763` 注释原文："运价表仍由岛传入（数据落在岛存储，宿主 op 无状态）"）。
   **后果**：任何想做"算运费"的模块（订单利润 / 店铺利润 / 对账）都必须先拿到这张表，而它挂在一个**可卸载的岛**上。这直接违反 ADR-002 C3「主数据 schema 与 op 挂宿主中立层，不挂可卸载的岛上」。**这是"订单预期利润"最难绕的一环。**
2. **其他模块拿不到 `shipping-rate` 域**（独占、6 op、只有本岛声明）。
3. **数量恒按 1 件/行**（`src/lib/shipRateOrders.ts:143`）：多件订单的合并计费没做，宁可少报也不静默多算。
4. 非本币价卡（`无忧物流-特惠` / `超级经济`）**明确拒算**，无汇率来源。

### 2.4 订单管理 —— 🔴 25%

#### 2.4.1 订单预期利润（核心缺口）

先把目标链路画出来，逐个环节标注状态（⚠️ = 有但断/够不到）：

| # | 环节 | 状态 | 事实 | 取证 |
|---|---|---|---|---|
| 1 | 订单行的**商品ID** | ✅ | 在 `raw_fields`，提取函数已有 | `electron/shopSku.ts:64`（`extractSkuFields`） |
| 2 | 订单行的**目的国** | ✅ | 在 `raw_fields`，国名解析三路径已有 | `src/lib/shipRateOrders.ts:109`（`resolveCountry`） |
| 3 | 订单行的**收入（金额）** | ✅ 2026-09-29 补 | 原判「库里无金额列」**对库成立**；但收入来源就是**订单报表本身**（`订单金额`/`产品总金额`，实测 1722 行恒有值）→ 已入账 14 列（`amount_cents` 等），见 `CHANGELOG.md` 与 `electron/orderMoney.ts` | `electron/order-db.ts`；`electron/orderMoney.ts` |
| 4 | 订单行的**数量** | ⚠️ 2026-09-29 更正 | 原判「拆行时丢弃」**不确**：该报表**没有数量列**，数量在 `商品信息` 块内 `(商品数量:N piece)`（实测 58 处 >1）；随 F1-2 接入，运费仍按 1 件/行 | `src/lib/orderRowSplitter.ts`；`electron/orderMoney.ts` |
| 5 | 订单行的**SKU 规格**（颜色/尺码） | ⚠️ | `oi_orders.color` / `.size` 有列，但 `raw_fields` 的「规格」列未接入；与 `pl_variants` 没有映射 | `electron/order-db.ts:173-177` |
| 6 | 订单行 → **产品** | ⚠️ | 已贯通，但**只在主进程内部**（`insertOrder` 直调），无 op；结论只落 `oi_images.style_color_id` | `electron/order-db.ts:828`（`autoAssignByMap`） |
| 7 | 订单行 → **SKU 克重** | ❌ | `pl_shop_sku.variant_id` **一期恒 0**，定位不到 `pl_variants` 行 | `electron/product-db.ts:1141` |
| 8 | **产品进价** | ⚠️ | 有（`ae_cost_map` 款级 + 生效区间），但**无维护界面**，且无 SKU 级 | `electron/ae-db.ts:151` |
| 9 | **运费** | ⚠️ | 计价能力完备，但**运价表在岛私有存储**（见 §2.3-1），跨域够不到 | `host.ts:763` |
| 10 | **平台佣金/费率** | ❌ | 没有费率表；`ae_fees` 是逐单导入的费用明细，不是规则 | `electron/ae-db.ts:190` |
| 11 | **汇率** | ⚠️ | `ae_rates` 有，但**无生效区间**（改汇率会改历史毛利） | ADR-002 Q2 残余项 |
| 12 | **跨域计算出口** | ❌ | 12 个域全是单域 op，没有任何 join 上述五域的 op | `host.ts:53`（`DB_OPS`） |

**结论**：这条链要通，缺的不是某个字段，而是 **①订单侧的"钱/量"、②订单行到 SKU 的下钻、③中立层的运价表、④一个跨域计算 op**。四件事缺一不可。

**为什么不能复用 `ae-engine`**：现有利润引擎（`electron/ae-engine.ts`）吃的是 `ae_orders`（浏览器扩展推送的 AE 后台订单），字段形状与 `oi_orders`（Excel 导入的订单报表）完全不同。两套订单来源、两套口径 —— 直接复用会得到"看着像利润却不一致"的第二套数字。

#### 2.4.2 按店铺 / 按产品统计

| 维度 | 现状 | 缺口 |
|---|---|---|
| 按店铺（订单侧） | `groupStats(['shop'])` 可组，但**只在本域**（`electron/order-db.ts:1092`，维度白名单仅 `category`/`color`/`shop`） | 无跨域、无金额、无日期维度 |
| 按店铺（成本侧） | ✅ `shopAllocation()` 已按店铺分摊拿货成本（FIFO 来源拆分，`electron/purchase-db.ts:888`） | 只有成本侧，没有收入侧 |
| 按产品 | ❌ | 需 join `pl_products`，无 op |
| 按日期 | ❌ | `groupStats` 无日期维度 |

**关键落差**："按店铺统计"目前是**两个半截**：订单侧有单量没金额（且仅本域），采购侧有分摊成本没收入。要合成"店铺利润"，必须先有 §2.4.1 的跨域出口。

#### 2.4.3 拣货

| 项 | 状态 |
|---|---|
| 阶段 | **P5，未开工**（`PRODUCT_LIBRARY.md` 进度表 ⬜） |
| 已有素材 | ✅ `pl_variants`（color/size/weight_g）、`pl_images` / `pl_item_images`（图）、`pl_products.supplier_id`（供应商）、`oi_orders`（订单行） |
| 缺 | ❌ 拣货 op（选中订单 → 按 产品×SKU 聚合）；❌ 订单选择态与拣货单输出；❌ `pl_shop_sku.spec` 的规格级生产者（现在恒 `'*'`）；❌ 订单行的 SKU 定位（同 §2.4.1-5/7） |

> 注意：`outstanding()`（`electron/purchase-db.ts:723`）已经在做"款色码粒度"的订单需求 − 已拿缺口，**它的 JOIN 写法（`oi_orders → oi_images → oi_style_colors → oi_styles`）就是拣货聚合的现成模板**，可直接复用做 S3 / 拣货 op 的实现骨架。

### 2.5 财务管理 —— 🔴 10%

#### 2.5.1 已有能力（比想象中多）

| 能力 | 落点 | 口径 |
|---|---|---|
| 供应商对账 | `reconciliation(from,to)`（`electron/purchase-db.ts:664`） | **按供应商**：拿货额 / 已付 / 退款 / `balanceCents` / 单数 |
| 付款记录 | `payments`（类型 payment / refund，`pay_date`） | 按供应商聚合 |
| **店铺成本分摊** | `shopAllocation(from,to)`（`:888`）+ `shopAllocationDetail`（`:912`） | **按店铺**：拿货件数 / 金额 / 单数（FIFO 来源拆分） |
| 待拿货缺口 | `outstanding()`（`:723`） | 款色码粒度：需求 − 已拿 − 已忽略 |
| 成本快照 | `costSnapshot()`（`:947`） | 款 × 拿货日 → 加权均价 |
| 价格历史 | `priceHistory()`（`:974`） | 供应商 × 款 × 色 |

> 也就是说「拿了多少货 / 预期付多少 / 实际付多少 / 差额」的数据**全都有**，只是**按供应商组织，不是按店铺×天**。

#### 2.5.2 缺口

| 目标 | 现状 | 缺口 | 严重度 |
|---|---|---|---|
| 今天每家店**发了多少货** | 数据在 `oi_orders.shop` + `order_time` | **无 op**；且 `order_time` 的日期格式与采购 `biz_date` 未对齐 | 中 |
| 今天每家店**拿了多少货** | `shopAllocation` 有按店铺的件数 | 时间窗是**区间**不是"天"；且依赖 `purchase_sources.shop`（自由文本，未过 `sk_shops`） | 小 |
| **预期要付多少** | `purchase_orders.total_cents`（`biz_date`） | 无按店铺口径（只有按供应商）；`total_cents` 是单据级，摊到店铺要靠 `shopAllocation` | 中 |
| **实际要付多少** | `payments.amount_cents`（`pay_date`） | **付款只挂在供应商上，没有店铺维度** —— 要摊到店铺必须定分摊规则 | **大** |
| **差值在哪** | 只有 `balanceCents` 总额差 | 缺"差在哪"的分解（单据悬空 / 未付 / 多付 / 退款未认） | 中 |
| **店铺运营费用 / 杂费** | ❌ **没有任何表** | 需新建费用表 | **大** |
| **费用均摊到各店铺** | ❌ **没有任何规则表** | 需新建分摊规则（按单量/销售额/拿货额/固定比例） | **大** |
| **店铺利润统计** | ❌ | 需 = 收入（缺）− 拿货成本（有）− 运费（够不到）− 费用分摊（缺） | **大** |

---

## 3. 现在答不出来的业务问题

| # | 问题 | 能否回答 | 卡在哪 |
|---|---|---|---|
| 1 | 这条订单预计赚多少钱？ | ❌ | 订单无金额（§2.4.1-3）；无跨域计算 op（-12） |
| 2 | 这条订单的实际运费是多少？ | 🟡 单岛内能 | 运价表在岛私有存储，其他模块够不到（§2.3-1） |
| 3 | 这批订单要拣哪些货？每款几件？图在哪？ | ❌ | P5 未开工；订单行定位不到 SKU 变体 |
| 4 | 这家店这个月赚了多少？ | ❌ | 无店铺级收入；无费用分摊 |
| 5 | 今天每家店发了多少货、拿了多少货？ | 🟡 数据有 | 无按店铺×天的 op |
| 6 | 今天预期要付 vs 实际付了多少，差在哪？ | 🟡 供应商维度能 | 付款无店铺维度；缺差额分解 |
| 7 | 这笔运费/房租/软件费摊到各店是多少？ | ❌ | 无费用表、无分摊规则 |
| 8 | 同一个产品在多家店卖，有没有防关联风险？ | ❌ | 需 product × shop × account 三方关联，跨域出口缺失（S3 未做） |
| 9 | 这款从哪家拿货、卖到哪些店、毛利多少？ | 🟡 半答 | 款编码贯通 ✅，"卖到哪些店"仍卡自由文本（S2 未做） |

---

## 4. 改动清单（按依赖顺序分阶段）

> 原则沿用 `DOMAIN_INTEGRATION_PLAN` §3.1：**零迁移优先 / 补实体层不补关联字段 / 宿主一次建成 / 不破安全模型 / 每步可回退**。
> 阶段编号接续既有 S1–S5 与 P0–P5，新增段用 **F0–F6**（Finance / Order-profit）。

### F0 前置（不做则后面全是死路）

| # | 改动 | 落点 | 说明 |
|---|---|---|---|
| F0-1 | **按 C4 拆 `shop` 只读子域** | `host.ts` 的 `DB_OPS` | `shop` 拆为只读（`list`/`get`/`summary`/`unmapped`）+ `shop-admin`（`ensure`/`upsert`/`map`/`unmap`）。样板 = P3 的 `product` / `product-admin` |
| F0-2 | **S2 放行**：order-insight / ae-profit 声明 `shop` 域并**发版** | 两岛 `manifest.json` | 改 `domains` + `actions` 必须升版本；装完要**重启宿主** |
| F0-3 | ✅ **已做（M6，2026-09-30）** 运价表迁到宿主中立层 | 宿主快照表 `sr_rate_snapshots`（按生效日留档）+ 宿主读 op | 原为岛私有 electron-store（`host.ts` 的 `quote` 系列收 `table` 参数）。**不迁则任何跨域算运费都不可能** —— 违反 ADR-002 C3。落地：宿主 op 自取快照、岛只显示（`rateCurrent`）+ 一次性迁移（`rateAdopt`），岛 1.3.0 |
| F0-4 | 回写文档漂移 | 基线 §5 / `PRODUCT_LIBRARY.md` §6.2 | §0.3 的三处实测数字 |

### F1 订单侧补字段（让"利润"有完整输入）

| # | 改动 | 落点 | 待拍板 |
|---|---|---|---|
| F1-1 | **订单金额入账**（收入侧） | `oi_orders` 增 `amount_cents` / `currency`，幂等 `ALTER`；解析在导入时从 `raw_fields` 取 | G8：金额从哪来 |
| F1-2 | **数量入账** | `oi_orders` 增 `qty`；同时放开 `quoteOrders` 的"恒取 1" | G9 |
| F1-3 | **规格归一**：订单「规格」原文 → `pl_variants` (color/size) | 复用 `sk_name_map` 手法（精确匹配自动 + 人工指派，模糊只排序） | G10 |
| F1-4 | `pl_shop_sku.spec` 生产者（规格级映射） | 岛侧映射页扩展 | — |

### F2 订单预期利润引擎

| # | 改动 | 落点 | 说明 |
|---|---|---|---|
| F2-1 | **新增粗粒度只读 op**（1 个，主进程聚合，只回汇总+逐行） | 新域 `order-profit`（只读 ≤10） | 一次 JOIN：`oi_* × pl_* × ae_cost_map × 拿货成本 × 运价表` |
| F2-2 | 返回分项：收入 / 产品成本 / 物流费 / 平台费 / **预期利润** / **物流利润**（收运费−实付运费）/ **产品利润** | 同上 | 逐行带 `reasonClass` 式的"缺什么"标识（缺重量/缺成本/缺国家），别静默按 0 算 |
| F2-3 | 费用/佣金**费率表** | 新表（如 `ord_fee_rules`） | 现在是 `ae_fees` 的逐单明细，没有规则（§2.4.1-10） |
| F2-4 | 岛侧界面：订单利润明细页 | `ui-plugins/order-insight`（或新岛） | 消费方声明新域 + **发版** |

### F3 统计（按店铺 / 按产品）

| # | 改动 | 说明 |
|---|---|---|
| F3-1 | `shopOverview({shopId, from, to})`（S3 原计划） | 订单数 / 拿货成本 / 收入 / 毛利 —— 可并入 F2 的域，别新增域 |
| F3-2 | 按产品统计 op | 产品维度利润/单量；同样复用 F2 域 |

### F4 拣货（原 P5）

| # | 改动 | 说明 |
|---|---|---|
| F4-1 | 拣货聚合 op：选中订单集 → 按 产品 × SKU 聚合 → 图 / 供应商 / 尺码 / 数量 | 实现骨架**直接复用 `outstanding()` 的 JOIN 写法**（`electron/purchase-db.ts:723`） |
| F4-2 | 拣货单输出（界面 + 可选导出） | 依赖 F0-2（拿 `shop` 域）与 F1-3（SKU 定位） |

### F5 财务管理（工作量最大的一块）

| # | 改动 | 落点 | 说明 |
|---|---|---|---|
| F5-1 | **费用表** `fin_expenses`：日期 / 类型（运营·杂费·物流·平台）/ 金额 / 币种 / 归属（店铺 or 全局）/ 备注 / 单据图 | 新表 | 无此表则"店铺利润"无解 |
| F5-2 | **分摊规则表** `fin_alloc_rules`：费用 → 分摊口径（按单量 / 销售额 / 拿货额 / 固定比例）+ 生效区间 | 新表 | **默认口径必须显式记录**，否则历史数字不可复算 |
| F5-3 | **付款的店铺维度** | `payments` 增 `shop_id`（软关联）或经分摊规则摊 | 现在付款只挂供应商（§2.5.2） |
| F5-4 | 新域 `finance`（只读 ≤10）+ `finance-admin`（写） | `host.ts` | 按实体分域，不建万能域（G4 裁定） |
| F5-5 | **店铺×天对账 op**：发货数 × 拿货数 × 预期付 × 实付 × 差额分解 | 复用 `reconciliation` + `shopAllocation` + `oi_orders` | 差额要能分解到"哪张单/哪笔款" |
| F5-6 | **店铺利润 op**：收入 − 拿货成本 − 运费 − 费用分摊 | 同 F2 域或 `finance` 域 | 与 F2 共用成本/运费口径，**不得各自实现** |
| F5-7 | 财务岛界面（费用录入 / 对账 / 店铺利润） | 新岛或并入 shop-accounts | — |

### F6 收口

| # | 改动 | 说明 |
|---|---|---|
| F6-1 | 宿主「经营概览」统一入口 | S5 原计划；模块多了之后没有它每个需求都得进各自的岛 |
| F6-2 | 岛间交叉跳转（店铺 → 它的订单/邮件/利润） | 同上 |

---

## 5. 待拍板决策

> 只列**真需业务判断**的；技术必然项（如"必须拆只读子域"）已按 ADR-002 直接定，不占决策位。

| 编号 | 决策点 | 建议 | 影响面 |
|---|---|---|---|
| **G8** | 订单收入**从哪来**？(a) 订单报表 Excel 的金额列 (b) 复用 AE 后台推送 (c) 人工填 | 建议 (a)：订单报表本身带金额，最贴近"订单管理"语义；(b) 会把两套订单源合并，口径风险大 | 决定 F1-1 的解析规则与是否要人工补录界面 |
| **G9** | 订单数量是否入账（现在恒 1） | 建议入账。否则运费/成本系统性少算，多件订单的利润全部虚高 | `oi_orders.qty` + 运费/成本口径 |
| **G10** | 订单「规格」如何映射到 `pl_variants` | 建议照 `sk_name_map`：**精确匹配自动 + 人工指派一次，模糊只排序**（G6 已裁定同款手法） | F1-3；错配会把两个 SKU 的账并到一起 |
| **G11** | 费用分摊默认口径 | 建议"按**拿货额**比例"为默认（与已实现的 `shopAllocation` 同源，可直接复算），其余口径按需加 | F5-2；口径不确定 = 历史数字不可复算 |
| **G12** | 运价表迁宿主 vs 留在岛内 | 建议**迁宿主**（F0-3）。留岛内则跨域算运费永远要"穿透岛的私有存储" | 一次迁移 + 岛侧改读法 + 发版 |
| **G13** | 新的跨域利润 op 挂哪个域 | 建议**新域 `order-profit`**（只读）。`product` 已 8、`shop` 8、`product-admin` 10 满额 —— 挤进现有域会立刻顶穿上限 | 域划分与岛权限声明 |

**按默认已封存、不用拍板**：拆 `shop` 只读子域（C4 硬要求）· 不建万能域（G4）· 跨域事件本轮仍不做（G7）· 不引入第二套成本表（ADR-002 Q2）· 新岛不登记进 `modules.config.json`（红线 23）。

---

## 6. 风险与硬约束

| 风险 | 说明 | 应对 |
|---|---|---|
| **op 预算已近顶** | `product-admin` 10 满、`product` 8、`shop` 8（N5 ≤10） | 新能力一律**新域**，挤进现有域必顶穿 |
| **岛发版成本** | 改 `domains`/`actions` 就必须升版本 + 重发布 + 装 + **重启宿主**；同版本号重打包等于没更新 | 每个新域**一次定稿 op 集合**，别分批发版 |
| **运价表位置** | 挂在可卸载的岛私有存储（§2.3-1） | F0-3 优先做，它是 F2/F5 的共同前置 |
| **两套订单源** | `oi_orders`（Excel）与 `ae_orders`（扩展推送）形状与口径不同 | 不要合并；利润口径各自实现但**共享同一套成本/运费函数** |
| **日期口径未对齐** | `oi_orders.order_time`（报表成交时间，字符串）vs `purchase_orders.biz_date` | 跨域对账前必须先归一（同 §2.5.2） |
| **自由文本残留** | `purchase_sources.shop` / `ae_orders.shop_name` 仍属自由文本，未过 `sk_shops` | F0-2 放行后逐域接归一，别指望一次全切 |
| **历史数字不可复算** | `ae_rates` 无生效区间；费用分摊口径若无生效区间则同样问题 | 分摊规则**带生效区间**（F5-2 已含） |

---

## 7. 建议的最小可验证路径（第一刀）

**不要一次铺开 5 个需求。** 选断得最狠的一条走通，其余是复制：

```
F0-1 拆 shop 只读子域  →  F0-3 运价表迁宿主  →  F1-1/1-2 订单补钱与量
   →  F2-1 一个跨域利润 op（先只算"产品成本 + 物流费"，不算费用）
   →  取一条真实订单，人工核算三处数字对齐
```

跑通的判据：**同一条订单，在订单利润页看到的"产品进价 / 物流费"，与产品库看到的成本、运费岛看到的运费，是同一个数。**

这一刀的价值是**验证跨域骨架**（域划分、op 粒度、权限声明、发版流程），骨架对了，F3 统计 / F4 拣货 / F5 财务都是同一套模式的复制。

---

## 附：本报告的数据来源

| 项 | 来源 |
|---|---|
| 能力域 op 数、域名清单 | 解析 `src/core/plugin/host.ts` 的 `DB_OPS`（脚本统计，非手抄） |
| IPC 契约 182 / 182 / 178 | `npm run verify` 实跑（2026-09-29） |
| 各岛域声明 | `ui-plugins/*/manifest.json` 实读 |
| 表结构 | `electron/*-db.ts` 的建表语句 |
| 已有对账/分摊能力 | `electron/purchase-db.ts` 的 `reconciliation` / `shopAllocation` / `outstanding` / `costSnapshot` |
| 阶段现状 | `docs/plans/DOMAIN_INTEGRATION_PLAN.md` §4、`docs/features/PRODUCT_LIBRARY.md` 进度表 |

---

## 8. 追加勘察（2026-09-29 晚，随「订单利润」落地后回看）

> 本节只**补事实与状态**，不改 §4–§6 的裁定与编号（F0–F6 / G8–G13 仍为唯一方案表）。

### 8.1 店铺：**半闭环**（实体与映射通了，消费与归一没通）

| 环节 | 状态 | 取证 |
|---|---|---|
| 店铺实体 | ✅ | `sk_shops`（`platform` + `name_key` UNIQUE、`platform_shop_id` 部分唯一） |
| 名称归一映射 | ✅ | `sk_name_map`（`kind/raw/raw_key/ref_id/ignored/source`，人工唯一） |
| 登记/维护界面 | ✅ | `ui-plugins/shop-accounts` 店铺登记页 |
| **跨域读** | ❌ | `shop` 域**只有 owner 自己声明** —— 订单/采购/利润三域读不到店铺实体。这是 per-plugin `domains` 授权的直接结果，**放行前必须先按 C4 拆只读子域**（`src/core/plugin/host.ts:411-416` 已写明） |
| 历史文本归一 | ⚠️ | 三处自由文本零改写（G2 有意）：`oi_orders.shop` / `purchase_sources.shop` / `ae_orders.shop_name`。**只有订单侧在新数据上闭环**（1.4.0 起导入时指定店铺）；采购/AE 侧仍靠人工在未归一名单里指派 |
| 订单→店铺的 ID 关联 | ❌ | `oi_orders` 只有文本 `shop`，无 `shop_id`（唯一的 ID 关联是 `pl_shop_sku.shop_id → sk_shops`）。C2 终态用 ID，现在是迁移期形态 |
| 店铺经营视图（S3） | ❌ | 未开工 |

⇒ 还差三件，按依赖排序：**① C4 拆 `shop` 只读子域 + 放行消费方（S2，含消费岛发版）→ ② 采购/AE 侧接归一 → ③ 订单侧写 `shop_id`**。
③ 有个省事发法：**导入时既然已经要人指定店铺，就顺手写 `shop_id`**（需要选择项来自店铺实体 → 与 ① 同批做）。

### 8.2 拣货（P5/F4）：**可以实现，且不需要 `pl_variants`**

按"款 × 色 × 码"就是 SKU 粒度（D3 的「颜色+尺码」组合），而这三样**订单侧都有**：

| # | 环节 | 状态 | 取证 |
|---|---|---|---|
| 1 | 订单行 → 款编码 | ✅ | 识别链 `oi_images → oi_style_colors → oi_styles`，`purchase-db.outstanding()` 已是现成 JOIN 模板 |
| 2 | 订单行 → 颜色 / 尺码 | ✅ | `oi_orders.color`（AI 归类）/ `oi_orders.size`（尺码列；块内 `Size:` 可兜底，拆行已支持） |
| 3 | 数量 | ⚠️ | 订单报表的数量在块内文本（未接，一期按 1 件）；**结算明细的商品行有 `商品数量` 已经是真值** |
| 4 | 图 | ✅ | 三层回落（`pl_item_images` 覆盖图 → `oi_images` 订单图 → `pl_images` 款图）已实现 |
| 5 | 供应商 | ✅ | `pl_products.supplier_id → suppliers` |
| 6 | **聚合出口** | ❌ | 需一个按 (款,色,码) 的只读 op。⚠️ **不能塞进 `order-insight` 域**：它 37 op 且被 `pluginTriage` 的 `GRANDFATHERED` 冻结（只许变少）→ **必须新域**（如 `picking`） |
| 7 | 订单选择态 + 拣货单输出 | ❌ | 页面/导出未做（未发货筛选可用：`oi_orders.status` + `ship_time`） |

**最短第一刀（零新域、零通道、零发版）**：在「订单利润」页的统计维度里加一项 **`款 × 色 × 码`**
（`summarizeOrderCosts` 扩一个 dimension 即可）→ 立刻得到"款/色/码 × 件数"的汇总表，
先验证口径与字段填充率；确认后再做新域 `picking` 的聚合 op 与拣货单页面（补图/供应商/导出）。

### 8.3 两条本期新增的"可 join 但未接线"的键

- **订单号**：`oi_orders.order_no` ↔ `ae_orders.order_id` ↔ `ae_settle_lines.order_no` —— 同一平台订单号，
  **两套源可 join 但尚未接线**（钱在结算/采集侧、店铺与发货在报表侧）。
- **款式编码**：已真贯通（`pl_products.code` ≡ `oi_styles.code` ≡ `purchase_items.style_code` ≡ `ae_cost_map.style_code` ≡ `ae_order_lines.style_code`）。
