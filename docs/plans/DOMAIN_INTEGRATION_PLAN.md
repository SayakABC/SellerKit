# 业务域盘点与串联方案（Domain Inventory & Integration Plan）

> **状态**：✅ 方案已定稿（2026-09-24 裁定 G1–G7，见 §3.4.1）· 🚧 **S1 已实施（2026-09-27，执行记录见 §4.3）**，**下一步 S2（共享域放行）**；S4 侧的产品库已推进到 **P3（映射与关联 + `product` 域按 C4 拆只读子域，2026-09-27）**，可直接当 S2 的样板（见 §4.3 末）；**边界与理由固化为 `docs/decisions/ADR-002-master-data-layer.md`**（Accepted：数据三层划分、写入权、共享域粒度、域命名规则）
> **读者**：架构 / 插件开发者
> **要回答的问题**：现在有哪几个功能、各自落在哪些表；为什么这些功能彼此串不起来；接下来按什么顺序把它们串起来。
> **性质**：§1–§2 是**客观快照**（以代码为准，含 `文件:行` 取证）；§3–§4 是**方案与计划**（含待拍板决策）。
> **前置阅读**：`AGENTS.md`（§1.4 持久化 / §1.7 网络与 IPC / §1.9 岛与宿主；红线 3、23）、`docs/baseline/PROJECT_BASELINE.md` §6、`docs/features/PRODUCT_LIBRARY.md`（本方案的上游主数据部分）。

---

## 0. 结论速览（TL;DR）

| 项 | 现状 |
|---|---|
| 库 | **1 个** SQLite 文件 `userData/sellerkit.db`（`electron/db.ts`），WAL + `foreign_keys = ON`；**不是**多个库文件 |
| 表 | 稳态 **33 个对象** = **31 业务表** + 1 内部 KV `sk_mail_meta` + 1 FTS5 虚拟表 `sk_mail_fts`。口径见 `docs/baseline/PROJECT_BASELINE.md` §6（源码侧 `CREATE TABLE IF NOT EXISTS` 32 处 + `CREATE VIRTUAL TABLE` 1 处；5 张 FTS5 影子表与 `sqlite_sequence` 由 SQLite 自建，不计） |
| 功能入口 | **7 个**：6 个市场 UI 岛（店铺账号管家 / 订单归类 / TV模版 / 利润追踪 / 无忧物流运费 / 产品库）+ 1 个内建模块（便签） |
| db 能力域 | **9 个**：`excel-copy`、`shop-accounts`、`order-insight`、`purchase`、`ae`、`shipping-rate`、`product`（P3 拆为**共享只读**）、`product-admin`（P3 拆出，**owner 写**）、**`shop`**（S1 新增）。⚠️ 原文把 `mail` 也算在 db 域里 —— `mail` 是**独立能力域**（与 `storage`/`clipboard`/`dialog`/`secrets` 同级），不在 `DB_OPS` 登记表内 |
| 唯一贯通的主键 | **`style_code`（款式编码）** —— `oi_styles` → `purchase_items` → `ae_cost_map` 三域对齐，零迁移 |
| 完全没贯通的实体 | **店铺** —— 截至 2026-09-24 两侧连概念都不是同一个（见 §2.2 D1）。**2026-09-27 S1 已立实体**（`sk_shops` + `sk_name_map`，历史文本零改写）；但"跨域看一家店的订单/成本/毛利"要等 S3，**映射尚未被任何消费岛使用** |
| 断裂数量 | 数据层 4 条（D1–D4）+ 架构层 2 条（D5–D6）+ 体验层 1 条（D7）；其中 **D1 已部分收敛**（实体与映射已建，消费侧未接） |
| 方案主线 | **补 1 个缺失实体层（店铺）+ 1 个共享只读域 + 1 张名称归一映射表**；不 ALTER 任何存量业务表，不做数据迁移 |

> ⚠️ **本表与 §1 是「快照」**，取数时点见各节标注。此后已发生的变化按阶段记录在 **§4.3 执行记录**（§1.1–§1.4 的逐表/逐岛清单同步刷新在 `docs/baseline/PROJECT_BASELINE.md` §3–§6）。

---

## 1. 现状盘点

### 1.1 存储布局

```
userData/sellerkit.db            ← 单库（electron/db.ts 的 initDb()，全仓唯一连接）
├── oi_*          订单归类域     6 表   electron/order-db.ts
├── purchase_* / suppliers / payments    采购对账域   6 表（含 1 张迁移期临时表）  electron/purchase-db.ts
├── ae_*          利润追踪域     5 表   electron/ae-db.ts
├── pl_*          产品库域       2 表   electron/product-db.ts            （P1 / P4a 新增）
├── sk_shop_sets  店铺账号域     1 表   electron/shop-accounts-db.ts
├── sk_shops / sk_name_map   店铺实体 + 名称归一映射   2 表   electron/shop-db.ts  （S1 新增，2026-09-27）
├── sk_companies / sk_company_profiles   企业合规域   2 表   electron/company-db.ts
└── sk_mail_*     邮件域         8 对象  electron/mail-db.ts（7 表 + 1 FTS5 虚拟表）

userData/config.json             ← electron-store，按 modules.<ns> 分命名空间（UI 偏好，非业务数据）
```

> ⚠️ `docs/baseline/PROJECT_BASELINE.md` §6 标题写作「SQLite（**分域 db 文件**）」—— 措辞与事实不符（分域的是 **表**，库只有一个），且把迁移期临时表 `purchase_items_new` 列为稳态表、漏掉 `sk_mail_fts`。本文件 §1.2 为准，基线 §6 待回写（见 §4 S0-3）。

### 1.2 表清单（字段 / 归属 / 读写在哪些功能）

> ⏱ **本节是 2026-09-24 的快照**：逐表盘点覆盖「问题发生时已经在库里的」那些表。此后新增的
> `pl_products` / `pl_item_weights`（产品库 P1 / P4a）与 `sk_shops` / `sk_name_map`（本方案 S1）
> **不在本节**——它们是方案要补的东西，字段与读写见 `docs/baseline/PROJECT_BASELINE.md` §6、
> `docs/features/PRODUCT_LIBRARY.md` 与本文 §4.3。

**订单归类域**（`electron/order-db.ts`，前缀 `oi_`）

| 表 | 行语义 | 关键列 | 谁写 | 谁读 |
|---|---|---|---|---|
| `oi_images` | 一张主图 = 一个识别任务单元 | `fingerprint` UNIQUE、`url_fingerprint`、`source_url`、`local_path`、`status`、`result_json`、`style_color_id` | 订单归类（导入/识别） | 订单归类、采购（缺口） |
| `oi_orders` | 订单行（图 × 订单号 × 尺码） | `image_id`→`oi_images`、`order_no`、**`shop`**、`size`、`order_time`、`raw_fields`、`category`/`color`/`logo`/`material`、`status`、`corrected` | 订单归类（导入/纠正） | 订单归类（透视/明细）、采购（来源拆分、缺口） |
| `oi_styles` | **款式主档（款编码库）** | `code` UNIQUE、`name`、`fingerprint` UNIQUE | 订单归类（识别建款 / 手工指派 / 导入） | 采购、利润追踪、订单归类 |
| `oi_style_colors` | 款色（款编码 + 颜色 → 款色编码） | `style_id`→`oi_styles`、`color`、`code` UNIQUE | 订单归类 | 同上 |
| `oi_style_fingerprints` | 同一款式可承载多个识别指纹 | `style_id`、`fingerprint` UNIQUE | 订单归类（归并） | 订单归类 |
| `oi_queue` | 视觉识别队列（批次 + 断点续跑） | `batch_no`、`raw_fields`、`url`、`status`、`error`、`fail_count` | 订单归类 | 订单归类 |

**采购对账域**（`electron/purchase-db.ts`）

| 表 | 行语义 | 关键列 | 谁写 | 谁读 |
|---|---|---|---|---|
| `suppliers` | 供应商 | `name` UNIQUE、`phone`、`note` | 订单归类（拿货对账页） | 同左 |
| `purchase_orders` | 拿货单 | `supplier_id`→`suppliers`、`biz_date`、`mode`、`status`(`draft`/`submitted`)、`total_cents`、`edited_at` | 同左 | 同左 |
| `purchase_items` | 拿货单明细 | `purchase_id`→`purchase_orders`、`style_code`、`color`、`size`、`qty`、`price_cents`、`amount_cents`、`suggestion_qty`；UNIQUE(purchase_id, style_code, color, size) | 同左 | 同左、**利润追踪（经快照）** |
| `purchase_sources` | 来源订单行（拿货单 → 店铺 × 款色码 × 数量） | `purchase_id`、**`shop`**、`style_code`、`color`、`size`、`qty` | 同左（`autoSourceRows` / 手填） | 同左（店铺分摊） |
| `payments` | 付款 / 退款 | `supplier_id`、`pay_date`、`type`、`amount_cents`、`method` | 同左 | 同左（对账） |
| `purchase_ignore` | 免补货标记 | `style_code`、`color`、`reason`；UNIQUE(style_code, color) | 同左 | 同左（缺口计算） |

**利润追踪域**（`electron/ae-db.ts`，前缀 `ae_`）

| 表 | 行语义 | 关键列 | 谁写 | 谁读 |
|---|---|---|---|---|
| `ae_orders` | AE 订单主档（窄列 + 全量快照） | `order_id` UNIQUE、**`shop_name`**、`site`、`order_time`、`status`、`currency`、`goods_amount`、`shipping_income`、`raw_json`、`source` | 浏览器扩展推送（`electron/ae-receiver.ts` → `upsertOrderBatch`） | 利润追踪 |
| `ae_order_lines` | SKU 行 | `ae_order_id`→`ae_orders`、`product_id`、`sku_id`、`title`、`sku_props`、**`style_code`**、`qty`、`unit_price`、`goods_amount` | 同左 | 同左（利润引擎） |
| `ae_fees` | 订单级费用科目 | `ae_order_id`、`category`、`amount`、`currency` | 同左 | 同左 |
| `ae_cost_map` | **款 → 加权成本快照** | `style_code` **PRIMARY KEY**、`style_name`、`unit_price_cents`、`sample_count`、`last_biz_date`、`source` | 利润追踪（成本衔接页导入）；源头是采购域 `costSnapshot()` | 利润引擎 |
| `ae_rates` | 币种 → CNY 汇率 | `from_currency` PK、`rate_to_cny` | 利润追踪（汇率维护） | 利润引擎 |

**店铺账号域 / 企业合规域 / 邮件域**

| 表 | 行语义 | 关键列 | 谁写 | 谁读 |
|---|---|---|---|---|
| `sk_shop_sets` | **账号套装**（不是"店铺"——见 §2.2 D1） | `email`、`phone`、`company`、`company_id`、`alipay`、`ziniao_account`、`erp_account`、`platforms`(JSON 数组)、`opened_at`、`status`、`tags`、`note`、`secret_enc`(BLOB)、`secret_keys` | 店铺账号管家 | 店铺账号管家、邮件域（外键） |
| `sk_companies` | 企业主体 | `name`、`unified_code`、`country`、`address`、`legal_person`、`contact_*`、`vat_no`、`eori_no`、`status` | 店铺账号管家（企业管理页） | 同左 |
| `sk_company_profiles` | 合规资料（欧代/土代/德国包装法…） | `company_id`、`type`、`name`、`reg_no`、`contact_*`、`address`、`effective_at`、**`expire_at`**、`status`、`extra` | 同左 | 同左 |
| `sk_mail_accounts` | 邮箱接入 | **`shop_set_id` UNIQUE → `sk_shop_sets(id)` ON DELETE CASCADE**、`provider_id`、`imap_*`、`proxy`、`folder`、`sync_enabled`、`sync_days`、`uid_validity`、`last_uid`、`status` | 店铺账号管家 | 同左（收件箱） |
| `sk_mail_messages` | 邮件索引 | `account_id`→`sk_mail_accounts`、`folder`、`uid`、`message_id`、`subject`、`from_name`/`from_addr`、`to_json`/`cc_json`、`received_at`、`seen`、`flagged`、`has_attachment`、`body_cached`、`preview` | 邮件同步引擎 | 同左 |
| `sk_mail_bodies` | 正文（按需补拉） | `message_id` PK→`sk_mail_messages`、`text_body`、`html_body`、`truncated` | 同左 | 同左 |
| `sk_mail_attachments` | 附件元数据 | `message_id`→`sk_mail_messages`、`filename`、`mime`、`size` | 同左 | 同左 |
| `sk_mail_folders` | 文件夹游标（多文件夹） | `account_id`、`path`、`uid_validity`、`last_uid` | 同左 | 同左 |
| `sk_mail_attachment_cache` | 附件本地缓存 | `attachment_id` PK、`message_id`、`file_path`、`size` | 同左 | 同左 |
| `sk_mail_meta` | 内部 KV（FTS 回填游标） | `key` PK、`value` | 同左 | 同左 |
| `sk_mail_fts` | **FTS5 虚拟表**（全文检索，`rowid` = `sk_mail_messages.id`） | `subject`、`from_name`、`from_addr`、`body` | 同左（写入即维护） | 同左（搜索） |

> `purchase_items_new` 仅存在于迁移函数 `migrateItemsSize()`（`electron/purchase-db.ts` L219）内部，随即 `DROP` + `RENAME` 成 `purchase_items`，**不是稳态表**。

### 1.3 功能清单（入口 → 页签 → 依赖的表 / 域）

> ⏱ 本表 2026-09-24 首版，**2026-09-27 刷新**：补入 2026-09-24 之后新增的两个岛（无忧物流运费 / 产品库）与店铺账号管家的 1.5.0。

| 入口 | 形态 | 页签 / 子功能 | 依赖 db 域 | 落库的表 |
|---|---|---|---|---|
| **便签**（`quick-note`） | 内建模块 | 单页便签 | 无 | 无（不占命名空间、重启即失） |
| **店铺账号管家**（`ui-plugins/shop-accounts`） | UI 岛 v1.5.0 | 账号库（分组/表格·卡片/批量编辑/密钥仅按需解密）· 集中收件箱 · 企业管理（欧代·土代·德国包装法）· **店铺登记**（S1）· 设置（宿主设置分类） | `shop-accounts`、`secrets`、`mail`、**`shop`** | `sk_shop_sets`、`sk_companies`、`sk_company_profiles`、`sk_mail_*`、**`sk_shops`、`sk_name_map`** |
| **订单归类**（`ui-plugins/order-insight`） | UI 岛 v1.2.0 | 导入与识别（列映射/批量识别/断点续跑）· 透视统计 · 订单明细 · 数据纠正 · 产品库（款式维护）· 拿货对账（供应商/拿货单/付款/对账/待拿货缺口）· 识别设置 | `order-insight`、`purchase` | `oi_*`、`suppliers`、`purchase_*`、`payments` |
| **TV模版**（`ui-plugins/excel-copy`） | UI 岛 v1.0.0 | 复制工作台 · 设置（模板配置 / 字段规则 / 显示列） | `excel-copy` | 无业务表（走 electron-store 命名空间 `excel-copy`） |
| **利润追踪**（`ui-plugins/ae-profit`） | UI 岛 v1.0.2（**2026-09-30 起 1.1.0：三页签已收编进宿主「算钱」，岛只剩采集接收端状态** —— 见基线 §4） | 利润统计（趋势/分类/爆品）· 订单明细 · 成本与汇率（成本衔接 / 汇率维护） | `ae`、`purchase` | `ae_orders`、`ae_order_lines`、`ae_fees`、`ae_cost_map`、`ae_rates` |
| **无忧物流运费**（`ui-plugins/shipping-rate`） | UI 岛 v1.1.0 | 报价（克重→逐国运费）· 运价表（来源·覆盖率·解析告警·逐国价卡）· **按订单试算** | `shipping-rate` | 无业务表（运价表落 electron-store 命名空间 `shipping-rate`；商品重量落 `pl_item_weights`） |
| ~~**产品库**（`ui-plugins/product-library`）~~ | ~~UI 岛 v1.0.0~~ | ~~产品列表（检索/新增编辑/批量删除）· Excel 批量导入三步向导（预览可就地修正）· 导出 / 模板下载~~ | ~~`product`~~ | `pl_products`（厂家为 `supplier_id` 软关联 `suppliers`，名称从采购域派生） |
| → **（2026-10-01）** | **已下架 · 收归内建** | 落点 `src/modules/goods/**`（「货与成本」模块 4 个页签）；UI 岛、`product` 能力域、`pl_item_weights` 均已删除。见 [`../features/PRODUCT_LIBRARY.md`](../features/PRODUCT_LIBRARY.md) §0-A —— **数据层（`pl_products` 等）与 IPC 通道不变**，只换了 UI 载体 | 无（内建同进程，不经 `DB_OPS`） | `pl_products`、`pl_variants`、`suppliers` |

### 1.4 能力域矩阵（谁独占、谁共享）

> ⏱ 2026-09-27 刷新：补入 2026-09-24 前后的三个新域（`shipping-rate` / `product` / `shop`）与各域的 op 数与预算对照。

| db 域 | 声明该域的岛 | op 数 | 独占 / 共享 |
|---|---|---:|---|
| `shop-accounts` | 店铺账号管家 | 17 | **独占**（⚠️ 超 ADR-002 N5 预算，存量豁免） |
| `secrets`（独立能力域，非 db） | 店铺账号管家 | — | **独占** |
| `mail`（独立能力域，非 db；24 个 action） | 店铺账号管家 | — | **独占**（不受 db op 预算约束） |
| `order-insight` | 订单归类 | 37 | **独占**（⚠️ 超预算，存量豁免） |
| `excel-copy` | TV模版 | 7 | **独占** |
| `ae` | 利润追踪 | 9 | **独占** |
| `purchase` | 订单归类（`orderList`…`costSnapshot`）、利润追踪（仅 `costSnapshot`） | 24 | **共享域**（⚠️ 超预算，存量豁免） |
| `shipping-rate` | 无忧物流运费 | 5 | **独占** |
| `product` | 产品库 | 8 | **独占**（P3 起要对外开只读子域，见 `PRODUCT_LIBRARY.md` §6.2） |
| **`shop`** | 店铺账号管家（S1，当前唯一消费者） | 8 | **设计上就是共享只读域** —— S2 放行给订单归类 / 利润追踪 |

> 上表前两行（`secrets` / `mail`）**不是 db 域**，列在这里只为完整呈现"哪个岛手里有什么"。
> **`DB_OPS` 登记表共 8 个 db 域**（判据：`src/core/plugin/host.ts` 顶层键），其中 `shop` 是 S1 新增。

`purchase` 是**目前唯一被两个岛同时声明**的域，且共享方式是**单向只读出口**（`costSnapshot()`，`electron/purchase-db.ts` L921）。

> **op 预算（ADR-002 N5 / C4）**：单域 op ≤ 10。上表的 **17 / 24 / 37 是 S1 之前就存在的存量**（本轮首次被量化，
> `tests/pluginTriage.spec.ts` 的 `GRANDFATHERED` 表把它们冻结在现状，只允许变少）；**新域必须自己守住 10**
> —— 这正是 `shop` 定稿为 8 op（而非"顺手加个 stats"）的原因：S3 的 `shopOverview` 就是第 9 个，
> 再往上加就得先按 C4 拆只读子域。

---

## 2. 串联诊断：为什么串不起来

### 2.1 实体锚点表（谁是谁的键）

| 业务实体 | 权威来源 | 其他域如何引用 | 判定 |
|---|---|---|---|
| **款式**（款编码） | `oi_styles.code`（UNIQUE） | `purchase_items.style_code`、`ae_cost_map.style_code`（复合主键的一部分，见下）、`ae_order_lines.style_code` | ✅ **唯一真正贯通**，零迁移（`docs/features/PRODUCT_LIBRARY.md` §3.2 已确认） |
| 款色 | `oi_style_colors`（`style_id` + `code`） | `oi_images.style_color_id`（**ALTER 增列，无 FK 约束**，`electron/order-db.ts` L241） | ⚠️ 可达但无约束，存在悬挂风险 |
| 供应商 | `suppliers.name`(UNIQUE) / `suppliers.id` | `purchase_orders.supplier_id`、`payments.supplier_id`（真 FK） | ⚠️ 只在采购域内闭环 |
| 企业 | `sk_companies.id` | `sk_shop_sets.company_id`（软关联，另存 `company` 名快照） | ⚠️ 半条链，名称与 id 双轨并存 |
| 邮箱 | `sk_mail_accounts` | `shop_set_id` → `sk_shop_sets(id)` ON DELETE CASCADE | ✅ 全仓**唯一**跨域硬外键 |
| **店铺** | **无** | `oi_orders.shop`(TEXT) / `purchase_sources.shop`(TEXT) / `ae_orders.shop_name`(TEXT) | ❌ **三处自由文本，无主键、无归一、无 FK** |
| 产品 / SKU | **无** | — | ❌ 缺失（`docs/features/PRODUCT_LIBRARY.md` 待实施） |
| 成本 | `purchase_items` → `ae_cost_map` | 按 `(款, 生效日)` 快照 | ✅ 时间维度已补（P4a，见 D4） |

### 2.2 断裂点

#### D1 ★ 核心：「店铺」实体根本不存在，且两侧概念不同

这是"功能串不起来"最根本的一条，其余断裂大多由它派生。

| | 店铺账号管家认为的"店铺" | 订单归类 / 采购 / 利润追踪认为的"店铺" |
|---|---|---|
| 载体 | `sk_shop_sets` 一行 = **一个邮箱账号套装** | 一个**平台上的店铺名称字符串** |
| 标识 | `email` | `oi_orders.shop` / `purchase_sources.shop` / `ae_orders.shop_name` |
| 平台信息 | `platforms` JSON 数组 = **平台名**（`ui-plugins/shop-accounts/src/store.ts` L205–212：`Amazon` / `速卖通` / `eBay` / `Shopee`…） | `ae_orders.site` / 自由文本 |
| 粒度 | 1 账号 = N 平台 | 1 平台 = N 店铺名 |

取证：`sk_shop_sets` 的建表语句（`electron/shop-accounts-db.ts` L193–208）里**没有任何"店铺名"字段**；`platforms` 存的是平台枚举而非店铺。

结论：**一个邮箱账号可以在多个平台开多个店铺**，而三处 `shop` 文本恰好是"店铺"这一层——这层没有表。因此：

- 店铺账号管家改名/停用一个账号，其余三个功能完全无感；
- 其余三个功能里同名的店铺，无法判断属于哪个账号，也无法归并同名不同账号的情况。

#### D2 店铺名三处自由文本，且互相拷贝

`oi_orders.shop`（`electron/order-db.ts` L160）→ 采购域 `autoSourceRows()` 从 `oi_orders` 读出后**原样拷进** `purchase_sources.shop`（`electron/purchase-db.ts` L406–416 读、L442 写）；利润追踪的 `ae_orders.shop_name`（`electron/ae-db.ts` L142）来自浏览器扩展推送的 AE 后台字段。

后果：同一店铺在库里最多有 3 份互相独立的字符串。Excel 里手输错一个空格，对账与利润就归到两个"店铺"上，且**不报错**。

#### D3 款式编码贯通，但款式本身没有权威主数据

`oi_styles` 只有 `code` / `name` / `fingerprint` / 三个时间列 —— 没有产品属性（材质、工艺、危险品、生命周期、供应商、平台刊登映射、合规资质、成本卡）。也就是说**骨干键存在，但骨干上没挂主数据**，所以"款"目前只是订单归类的副产品，不能作为跨功能的业务主语。

→ 该缺口已有设计（`docs/features/PRODUCT_LIBRARY.md`，`pl_*` 表，P0–P5），本方案不重复造，S4 与它合流。

#### D4 成本是覆盖式快照，无时间维度 → 历史毛利不可复算 ✅ 已修（P4a，2026-09-24）

改造前（本方案盘点时的状态）：

- `costSnapshot()`（`electron/purchase-db.ts`）按 `style_code` 聚合出**一个**加权均价 + `MAX(biz_date)`；
- 利润追踪侧 `costMapReplace` 先 `DELETE FROM ae_cost_map` 再整表 INSERT ——**历史成本被覆盖，不可回溯**；
- 利润引擎（`electron/ae-engine.ts`）实时用当前 `ae_cost_map` + 当前 `ae_rates` 反算，因此：今日改一次汇率或拿一次新价，**上月已出的毛利数字会跟着变**。

改造后（落地口径见 `docs/features/PRODUCT_LIBRARY.md` §3.3 与 `ADR-002`「Q2 执行口径」）：

- `costSnapshot()` 改按 **`(款, 拿货日期)`** 分组 → 一款跨多次进货导出多行；`lastBizDate` 语义变为「本行拿货日」；
- `ae_cost_map` 改 **`(style_code, effective_from, source)` 复合主键**（一款多行），存量行迁移时补基准生效日；
- `costMapReplace` **只清 `source='purchase'` 的行**，手工成本（`source='manual'`）不再被对账导入抹掉；
- 利润引擎按**订单业务日期**取 `effective_from <= 订单日` 的最近一条（同生效日 manual 优先；无命中回落最早一条）
  → 历史毛利可复算。
- 剩余已知项：汇率（`ae_rates`）仍无生效区间，故「今日改汇率会改变历史毛利」**这条尚未消除** —— 属 `ADR-002` Q2 的后续范围，不在 P4a。

#### D5（架构）能力域按"岛"切分，没有共享只读域

`src/core/plugin/security.ts` L113–124：请求的 `domain` 必须命中**该插件自己 manifest 声明的** `domains`，否则拒绝并写审计。域的白名单集中在 `src/core/plugin/host.ts` L53 的 `DB_OPS`。

后果：**`shop-accounts` 域被店铺账号管家独占**，订单归类/采购/利润追踪在架构上**拿不到店铺账号列表**。这不是疏忽，是安全模型的直接结果——正是它让 D1/D2 无法在岛侧修。

同时 `DB_OPS` 的域粒度是"原内建模块"的形状（`excel-copy` / `order-insight` / `shop-accounts` / `ae` / `purchase`），是「下记」动作的遗留切片，**不是围绕业务实体设计的**。

#### D6（架构）没有跨域事件

`src/core/plugin/eventBus.ts` L36–43 的 `PluginEvents` 只有三个生命周期事件（`plugin:state-changed` / `activated` / `deactivated`），**没有任何业务事件**。岛之间无法"订单入库后通知利润追踪重算"，只能各自轮询或手动刷新。

#### D7（体验）没有统一入口，也没有交叉跳转

5 个入口平铺在侧栏，无首页/概览，无"从订单跳到拿货单""从店铺跳到它的订单/邮件"。`docs/features/PRODUCT_LIBRARY.md` §10（后置能力）规划的"关联跳转"是唯一相关条目，尚未实施。

### 2.3 影响面：现在答不出来的业务问题

| # | 问题 | 现在能否回答 | 卡在哪 |
|---|---|---|---|
| 1 | 这个**店铺**这个月赚了多少？ | ❌ | 店铺无主键（D1/D2）；AE 侧 `shop_name` 与采购侧 `shop` 无法保证同名 |
| 2 | 这个**款**从哪家拿货、卖到哪些店、毛利多少？ | 🟡 半答 | 款编码贯通 ✅，但"卖到哪些店"卡 D1 |
| 3 | 上周那条订单的货拿了没？ | ✅ | 同域可答（`outstanding()` 跨 `oi_*` × `purchase_*` 实时算） |
| 4 | 这个**账号**下有几家店？合规资料齐不齐、有没有过期？ | ❌ | 账号→企业链通（`company_id`），但账号→**店铺**层不存在（D1） |
| 5 | 同一款在多店卖，有没有防关联风险？ | ❌ | 需 product × shop × account 三方关联，店铺层缺失（D1/D3） |
| 6 | 上个月的毛利，用当时的价格和汇率重算一遍 | ❌ | 成本与汇率都被覆盖式更新（D4） |

---

## 3. 方案

### 3.1 原则

1. **零迁移优先**：不 ALTER 任何存量业务表、不重写历史数据。新结构一律以「映射 / 回填」方式旁挂（沿用 `oi_styles.code` 已证明可行的做法）。
2. **补缺失的实体层，而不是补关联字段**：`shop_id` 散布到三张表只是把问题后移；建 `sk_shops` 一张表，三处文本降级为"待归一输入"。
3. **宿主侧一次建成，岛侧只声明与消费**：op 集合一次定稿，避免每接一个消费方就给已发布岛发版（`docs/features/PRODUCT_LIBRARY.md` §5.3 / §6.2 的既定做法）。
4. **不破安全模型**：`security.ts` 的 per-plugin `domains` 声明保持不变；共享通过"多岛各自声明同一域"实现，不引入"全局只读域"豁免。
5. **可回退**：每一步都能单独停机——新表可停用、映射表可清空、岛可回退上一版本。

### 3.2 目标模型

```
sk_companies ──► sk_shop_sets（账号套装）──► sk_shops（★新增：平台 × 店铺名）
  (企业)              (email × platforms)         │
                                                   ├──► oi_orders.shop        （文本 → 归一）
                                                   ├──► purchase_sources.shop （文本 → 归一）
                                                   └──► ae_orders.shop_name   （文本 → 归一）

pl_products（产品/SKU 主数据，见 PRODUCT_LIBRARY）──► oi_styles.code
                                                   ├──► purchase_items.style_code
                                                   └──► ae_order_lines.style_code / ae_cost_map.style_code

供应商 suppliers ──► purchase_orders ──► purchase_items
                                            └─► ae_cost_map（按 (款, 拿货日) 多行，P4a 后）
```

新增的只有 1 张主表 + 1 张映射表：

| 新表 | 作用 |
|---|---|
| `sk_shops` | **店铺实体**：`platform` × `name`（UNIQUE 组合）× `shop_set_id`（所属账号套装，软关联）× `site` × `status` × `opened_at` × `note` |
| `sk_name_map` | **名称归一映射**：`kind`（`shop`/`supplier`/`style`）× `raw`（历史文本）× `ref_id`（指向主表）× `source`（`auto`/`manual`）× `confidence`；唯一键 `(kind, raw)` |

有了 `sk_name_map`，**历史文本不需要改写**：查询时按 `kind='shop'` 把 `oi_orders.shop` 等文本 join 到 `sk_shops.id`。人工确认过的映射行永不被自动覆盖。

### 3.3 三步落地

**S1 立"店铺"实体** —— ✅ **已落地（2026-09-27，见 §4.3）**

1. 宿主新增 `electron/shop-db`（`sk_shops` 幂等 DDL + CRUD）+ `electron/shop-handlers`（经 `electron/ipc-util.ts` 注册）。
2. ~~首启动做一次**只读扫描**：汇总 `oi_orders.shop` / `purchase_sources.shop` / `ae_orders.shop_name` 三处去重后的店铺名，写入 `sk_name_map`（`ref_id=0`，`source='auto'`）。~~
   ⚠️ **实施时改掉了这一条**：不给自动扫描结果**落行**。理由见 G6 / §3.4.1 —— ① `source='auto'` 的占位行会与"人的决定"混在一张表里，
   删订单 / 重导后名单还会漂移；② 精确匹配**可以在查询时实时算**（`name_key` 命中且恰好唯一即给 `suggestedShopId`），
   不需要落盘。现实现是 **`listUnmapped` 每次实时扫三处文本**（`SHOP_NAME_SOURCES`），`sk_name_map` **只存人工决定的行**，
   因此 `source` 至今只有 `manual` 一个值（列保留，供后续自动来源扩展）。
3. 店铺账号管家的企业管理页新增「店铺登记」子页：把未归一的名称指派到账号套装或标记"忽略"。
   ✅ 现为 `shop-accounts` 1.5.0 的**独立页签**（「店铺登记」），不是企业管理下的子页。

**S2 共享只读域**

宿主 `DB_OPS` 新增域 `shop`（粗粒度，≤10 op）：`ensure` / `list` / `get` / `upsert` / `unmapped`（未归一名单）/ `map`（指派）/ `unmap` / `stats`。

各消费岛在 manifest 加 `"shop"` 到 `domains` 并同步 `actions`，**发一次版本**：订单归类、利润追踪、店铺账号管家各一次（TV模版不消费）。

**S3 串联可见**

在 `shop` 域上叠 **1 个跨域统计 op**（粗粒度、只读）：`shopOverview({ shopId, from, to })` → 返回该店铺的订单数/拿货成本/收入/毛利。实现落主进程，一次 SQL 串联 `oi_*` → `purchase_*` → `ae_*`（沿用 `outstanding()` 已在用的多表 JOIN 写法，`electron/purchase-db.ts` L710–718）。

**S4 与产品库合流**：`docs/features/PRODUCT_LIBRARY.md` 的 P1 阶段（`pl_*` DDL + `product` 域）与本方案 S1 同批实施，两者共同构成主数据层；`sk_name_map` 的 `kind` 预留 `product` 值，供产品库的编码归一复用。

### 3.4 待拍板决策

| 编号 | 决策点 | 建议 | 影响面 |
|---|---|---|---|
| **G1** | 店铺实体落点 | **新表 `sk_shops`**（不塞进 `sk_shop_sets`）。理由：1 账号 N 店铺，塞进去要拆行或存 JSON，都无法 join | 全库查询路径 |
| **G2** | 归一方式 | **旁挂映射表 `sk_name_map`**，不改写历史文本列 | 决定是否要迁移脚本 |
| **G3** | 是否给存量表加 `shop_id` 列 | **暂不加**。先靠映射表 join；若 S3 的 JOIN 查询出现性能问题再评估加列（那时是按需 ALTER，代价可控） | 查询性能 vs 改动面 |
| **G4** | 共享域粒度 | **按实体分域**（`shop` / `product`），不做一个万能 `master` 域。理由：`domains` 是岛自报白名单，粒度越粗越容易越权 | 安全边界可读性 |
| **G5** | 成本历史 | ~~`ae_cost_map` **保持当期口径不变**；历史可追溯由 `pl_cost_cards` 承载~~ → **复议改判**：**现在就给 `ae_cost_map` 加生效日区间**，不建第二套成本表（裁定与落地口径见 §3.4.1 与 `ADR-002`「Q2 执行口径」） | 是否要动利润引擎 → **已动**（P4a） |
| **G6** | 自动归一策略 | 先**只做精确匹配 + 去空白**；模糊匹配（相似度）只产出"建议"，不自动写 `ref_id` | 错并风险 |
| **G7** | 跨域事件 | 本轮**不做**（D6）。S3 的 op 走显式调用；事件留到有真实「一处写入、多处需重算」场景时再补 | 是否引入业务事件契约 |

### 3.4.1 裁定结果（2026-09-24）

| 编号 | 裁定                                                                                                                    |
| ---- | ----------------------------------------------------------------------------------------------------------------------- |
| G1   | ✅ 新表 `sk_shops`（不塞进 `sk_shop_sets`）                                                                             |
| G2   | ✅ 旁挂映射表 `sk_name_map`，**不改写历史文本**                                                                          |
| G3   | ✅ 暂不给存量表加 `shop_id` 列                                                                                          |
| G4   | ✅ 按实体分域（`shop` / `product` …），**不建万能域**                                                                   |
| G5   | ⚠️ **改判**：成本历史**现在就加生效日区间**（原建议"保持当期"被否）——落点、代价与验收口径见 `ADR-002` 的「Q2 执行口径」  |
| G6   | ✅ 只做精确匹配 + 去空白，其余人工指派；模糊相似度**只作排序提示、永不写 `ref_id`**（真实数据已证明必须如此，见 `ADR-002`「Q3 数据证据」） |
| G7   | ✅ 跨域事件本轮不做（触发补做条件见 `ADR-002`「When to revisit」第 5 条）                                              |

补充约定：**域命名规则**见 `ADR-002` Decision §5 —— 新域 `shop` 合规；存量 3 个插件 id 形态的域
（`excel-copy` / `shop-accounts` / `order-insight`）随本方案 S2 的发版顺手对齐，不单独发版。

✅ **因 G5 改判而新增的工作量已落地（P4a，2026-09-24）**：「利润引擎按生效区间取成本」的改造已完成 ——
`electron/ae-engine.ts` 取成本路径改按订单业务日期匹配区间 + `electron/ae-db.ts` 的 `ae_cost_map` 加
`effective_from`（复合主键），**并且**同步改了快照源头 `electron/purchase-db.ts`：原 `costSnapshot()`
按款聚合出单行 + `MAX(biz_date)`，只改表不改源头的话一款仍只有一条区间，本阶段验收不可能达成。
回归覆盖见 `scripts/ae-cost-smoke.cjs`（`npm run ae:smoke`，13 项）。

### 3.5 风险与红线对照

| 风险 | 应对 | 依据 |
|---|---|---|
| 把新岛 id 登记进 `modules.config.json` → 市场同名岛无法注册 | 新功能一律做 UI 岛，`modules.config.json` 三处预设都不登记 | `AGENTS.md` 红线 23 |
| 透传 SQL / 岛内拼 SQL | 全部经 `DB_OPS` 白名单，op 内参数化拼装 | `AGENTS.md` §1.7 / 红线 3 |
| 自动归一误并 → 数据被悄悄算错 | `source='auto'` 行可一键清空；`manual` 行优先且不被覆盖；`confidence` 留痕 | 本文件 G6 |
| 改已发布岛的 `domains` 需发版，反复发版成本高 | S1 阶段**一次定稿** `shop` 域 op 集合（≤10） | `PRODUCT_LIBRARY.md` §6.2 |
| 岛 manifest `actions` 撞 128 上限 | 现用量：订单归类 ~59、店铺账号管家 ~41、利润追踪 ~10、TV模版 ~7；`shop` 域 ≤10 仍在余量内 | `src/core/plugin/externalManifest.ts` L44 |
| 跨域 JOIN 拖慢岛首屏 | 统计 op 在主进程分页/聚合，只回传汇总，不回传明细 | 参照 `PRODUCT_LIBRARY.md` §7（P3） |
| 文档/基线继续漂移 | S0 一并修 `PROJECT_BASELINE.md` §6 的两处事实错误 | 本文件 §1.1 注 |

---

## 4. 实施计划

### 4.1 阶段

| 阶段 | 内容 | 落点 | 验收 | 依赖 |
|---|---|---|---|---|
| **S0 决策冻结** ✅ | 拍板 G1–G7；回写 `PROJECT_BASELINE.md` §6（单库事实 + `purchase_items_new` 纠错 + 补 `sk_mail_fts`） | 本文档 §3.4 | 七项决策有明确结论并记录在本文档 | — |
| **S1 店铺实体** ✅ **2026-09-27 完成** | `sk_shops` + `sk_name_map` DDL、CRUD、三处文本的只读汇总、店铺登记子页 | 实际落点：新增 `electron/shopName.ts`（纯函数）+ `electron/shop-db.ts` + `electron/shop-handlers.ts` + `scripts/shop-db-smoke.cjs` + `tests/shopName.spec.ts`；改 `electron/preload.ts` + `src/types.ts` + `src/core/services/ipc.ts` + `electron/main.ts` + `DB_OPS['shop']`；岛侧 `ui-plugins/shop-accounts` 新增「店铺登记」页（1.5.0） | ✅ 实跑：`npm run verify` **161 ≡ 161 / 157 通道**（`shop-handlers:8`）；空库 `ensure` 成功；未归一名单与三处文本的**逐名计数**一致（`shop:smoke` 25/25）；真机探针 8/8 | S0 |
| **S2 共享域放行** | 消费岛 manifest 加 `domains: ["shop"]` 并同步 `actions`，各发一次版本 | `ui-plugins/ae-profit/manifest.json`、`ui-plugins/shop-accounts/manifest.json`（原清单里还有 `order-insight`，该岛已于 2026-10-05 整体下架） | 权限门审计环中 `shop.*` 调用全部 `allowed`（拒绝数为 0）；岛装回后 `npm run plugins:island:smoke` 通过 | S1 ✅ |
| **S3 串联可见** | `shopOverview` 跨域统计 op + 岛内展示 | `DB_OPS['shop']`、`ui-plugins/shop-accounts` 店铺详情 | 任取一家店铺，其"订单数 / 拿货成本 / 收入 / 毛利"与该店铺在订单归类、采购对账、利润追踪三处分别看到的口径一致 | S2 |
| **S4 与产品库合流** | 按 `PRODUCT_LIBRARY.md` P1–P3 推进 `pl_*` 与 `product` 域；`sk_name_map.kind` 增 `product` | 见 `PRODUCT_LIBRARY.md` §5 / §7 | 该文档 §7 的验收标准 | S1 ✅（共用映射表已建）；**P3 ✅（2026-09-27，§7.3 逐条对账）**；可与 S2/S3 并行 |
| **S5 体验收口**（可选） | 宿主"经营概览"入口 + 岛间关联跳转 | 宿主 `src/core/AppShell.vue` 区域；岛内跳转按钮 | 从店铺可一跳进入其订单/邮件；概览页数字与各岛一致 | S3 |

> ⚠️ **S2 之前必须先解决的一件事（S1 施工时暴露）**：`shop` 域是**写读同域** —— `upsert/map/unmap`（写）与
> `list/summary/unmapped`（读）在同一个域里，而 ADR-002 C4 要求**共享域只读**。S1 阶段无妨（当前唯一消费者
> 就是拥有者 `shop-accounts`），但**放行给订单归类 / 利润追踪之前**必须按 C4 把只读子域拆出去
> （`shop` 与 `product` 现在都是 8 op，S3 的 `shopOverview` 一加就到 9，逼近 ADR-002 N5 的上限 10）。

### 4.2 为什么这个顺序

- **S1 在 S2 之前**：没有实体表，放行 `shop` 域也只是把自由文本搬来搬去。
- **S2 在 S3 之前**：`shopOverview` 是跨域 op，必须先让消费岛拿到域权限，否则调用被权限门拒绝。
- **S4 与 S2/S3 可并行**：产品库与本方案动的表、域、岛都不重叠，唯一交汇点是 `sk_name_map`（已在 S1 建好）。

### 4.3 执行记录

#### S1 店铺实体（2026-09-27）

**做了什么**

| 层 | 产物 | 说明 |
|---|---|---|
| 纯函数（宿主 + 可单测） | `electron/shopName.ts`（**新建**） | `toNameKey()` / `mergeNameGroups()`。**为什么要单独成文件**：主进程 `*-db.ts` 依赖 `better-sqlite3`，按 Electron ABI 编译（149），而 vitest 跑在系统 Node（ABI 127）上 → 直接 `require` 会崩；把归一逻辑摘成**零依赖**模块，它才能进 vitest |
| 数据层 | `electron/shop-db.ts`（**新建**） | `sk_shops` + `sk_name_map` 幂等 DDL；`ensureShopSchema` / `listShops` / `getShop` / `listUnmapped` / `shopSummary` / `upsertShop` / `mapName` / `unmapName`；`SHOP_NAME_SOURCES` 定义三处文本 |
| IPC | `electron/shop-handlers.ts`（**新建**）+ `electron/preload.ts` + `src/types.ts` + `src/core/services/ipc.ts` + `electron/main.ts` | 8 个通道（`shop-db-ensure` / `shop-list` / `shop-get` / `shop-upsert` / `shop-summary` / `shop-unmapped` / `shop-map` / `shop-unmap`）；四处同步（verify 的 161 ≡ 161 / 157 就是这条的守卫） |
| 能力域 | `src/core/plugin/host.ts` | 新增 `DB_OPS['shop']`（8 op）—— `shop-accounts` 岛的 `api.js` 用 `shp = (op,payload) => db('shop', op, payload)` 形态绑定（域是**字面量第一实参**，这是 `apiBindings` 守卫唯一认得的形态） |
| 岛 | `ui-plugins/shop-accounts` 1.4.4 → **1.5.0** | 新增「店铺登记」页 `src/components/ShopRegistryView.vue`：chips 统计条 / 未归一名单（一键采纳 / 指派 / 新建并绑定 / 忽略）/ 店铺实体表 / 过期映射说明 / 抽屉表单；`manifest.json` 的 `db.domains` 加 `shop`、`actions` 加 `unmapped`/`map`/`unmap` |
| 测试 | `tests/shopName.spec.ts`（**新建**，15 例）· `scripts/shop-db-smoke.cjs`（**新建**，25 项）· `scripts/shop-registry-smoke.mjs`（**新建**，真机探针 8/8）· `tests/pluginTriage.spec.ts`（+1 组，62 例） | 见下「验证」 |
| 发布 | `market-out/shop-accounts-1.5.0.zip`（91,337 B，`sha256 5f7c1313b3e55b0a28f2786901dfa2ce07528472d716f216d4be18d87a3fa1b7`，11 文件） | catalog 现含 6 个插件 |

**落地时的六条口径（都是被真实数据/项目规则逼出来的，改宽之前先读理由）**

1. **`name_key` 必须进 UNIQUE**：只对 `name` 建唯一约束，`"店A"` 与 `"店A "` 会同时入库 → 同一个归一键命中两家店 → "精确命中"的语义当场破产。故 UNIQUE 是 `(platform, name_key)`。
2. **归一口径 = 去空白 + 剥不可见字符**（剥 U+200B–200F / U+2028 / U+2029 / U+FEFF，全角空格与连续空白并成单个半角空格）。**不做**大小写折叠、**不做**模糊匹配、**不做**"去掉所有内部空白" —— 内部空格在真实数据里是**有效差异**。
3. **不猜歧义**：归一键命中 >1 家店（同名不同平台是合法的）时**不给** `autoShopId`。
4. **未归一名单是实时聚合，不是缓存表**（`listUnmapped` 每次扫三处文本）——否则删订单 / 重导后名单与源头不一致。
5. **映射表只存"人的决定"**：不写 `source='auto'` 占位行 → `source='manual'` 天然不会被自动覆盖。故 §3.3 第 2 条被改掉（见该节 ⚠️）。
6. **模糊匹配只作排序提示、永不写 `ref_id`**（G6）。`sk_shops` 因此**有意不建 `confidence` 列** —— 没有任何生产者会写它。

**验证（全部实跑，非推断）**

| 门禁 | 结果 |
|---|---|
| `npm run verify` | ✅ **166 ≡ 166 / 162 通道**，分布含 `shop-handlers:8` / `product-handlers:16`（注：本表是 **S1 当时**的快照，P3 后已再增 5 个 `product-sku-*` 通道） |
| `npx vue-tsc --noEmit` | ✅ 0 error |
| `npx tsc -p tsconfig.electron.json` | ✅ 0 error |
| `npx eslint .` | ✅ **0 error** / 401 warning |
| `npx vitest run` | ✅ **23 文件 / 421 例** |
| `npm run shop:smoke` | ✅ **25/25**（含「未归一名单覆盖 `oi_orders` 每个店铺名且计数一致」这条**验收原文**的用例） |
| `npm run plugins:island:smoke` | ✅ **6/6 岛** + 重启恢复 |
| `scripts/shop-registry-smoke.mjs`（真机 CDP） | ✅ 8/8 —— 「店铺登记」页挂载、面板渲染、**无 error-bar（= 四个 shop op 全过权限门）**、chips 渲染 |
| `npm run build` / `npm run verify:docs` | ✅ |

**变异验证**（防"假守卫"）

- op 预算守卫：M01 把 `shop` 域加到 11 op（> 预算 10）→ 变红；M02 往豁免表 `GRANDFATHERED` 塞一个没超额的域 → 变红。
- 店铺守卫：M01 把岛里的 `shp('unmap')` 改坏 → 变红；M02 从 manifest 删掉 `map` → 变红。
- 两轮都带「**基线必须绿**」与「**收工必须复原**（比 sha256）」两道自检。

**顺带查出的存量问题**（此前无人知道，已进守卫）

- `order-insight` / `purchase` / `shop-accounts` 三个域的 op 数 **37 / 24 / 17**，**远超 ADR-002 N5 的 10**。新增的守卫把现状冻结为基线（`tests/pluginTriage.spec.ts` 的 `GRANDFATHERED`），**只允许变少**；并加一条断言防止"豁免表被当垃圾桶塞新域"。
- 发现 `apiBindings()` 守卫原先漏掉整整两个 vite 工程岛（`ae-profit` / `shop-accounts`）—— 上一轮（P2）已修，本轮直接受益。

**未做（如实记，属 S2/S3 范围）**

- 消费岛（订单归类 / 利润追踪）**尚未**声明 `shop` 域，映射结果**尚无任何消费方** —— 这正是 D1 只"部分收敛"的意思。
- `shop` 域**写读同域**（`upsert/map/unmap` 与 `list/summary/unmapped` 混在一起），与 ADR-002 C4「共享域只读」冲突；**放行给其他岛之前必须按 C4 拆只读子域**。
- `sk_name_map.kind` 的 `supplier` / `style` / `product` 三个预留值**无生产者**（产品库 P3 才接）。
- 店铺实体与 `sk_shop_sets`（账号套装）之间是**软关联**（`shop_set_id` 整数、无外键），套装删除后 id 仍在、只用于回显。

> 📌 **上述第二条已在别处先做过一次，可直接当 S2 的样板（2026-09-27，产品库 P3）**：
> `product` 域被 P3 的 5 个只读 op 顶到 13（**顶穿 N5 上限**），于是按 C4 拆成
> **`product`（共享只读 6）+ `product-admin`（owner 写 7）**，`security.ts` / `externalManifest.ts` 零改动、
> 岛侧只改 `manifest.capabilities` 并升版（`product-library` 1.0.0 → 1.1.0）。
> 两点可复用：① 判据是**消费者能否"结构上够不到"写 op**，不是"声明里没写就算只读"；
> ② 拆域**必须连带消费岛发版**（`domains`/`actions` 是岛自报白名单），漏了这一步等于没改。
> 详见 `docs/features/PRODUCT_LIBRARY.md` §6.2。`shop` 域的 S2 拆分照此办理，**但注意它的写 op 已有真实使用者**
> （店铺登记页），拆之前要确认消费方拿到的是同一套写权限语义。
>
> ⚠️ **另外，`sk_name_map.kind='product'` 仍然无生产者**：P3 的款式关联走的是
> `oi_styles.code ≡ pl_products.code` **同口径直连**（D2：不引入第二套编码），**没有**经过 `sk_name_map`；
> 店铺商品ID → 产品走的是新表 `pl_shop_sku`。所以"P3 才接"这个预期**实际没有发生**，
> 该预留值目前仍是纯预留 —— 别再按它去推断已有数据。
>
> ⚠️ **2026-10-01 补记**：上文的按 C4 拆域（`product` / `product-admin` / `product-image` /
> `product-supplier` / `shop-products` 五个能力域、共 32 个 op）**已随岛下架一并删除** ——
> 内建页与宿主同进程，不经 `DB_OPS` 桥，这些域**没有任何消费者**，留着就是死权限面
> （`src/core/plugin/host.ts` 就地留墓碑）。所以"`product-library` 1.0.0 → 1.1.0 拆域"
> 是**当时**的做法，现无实物。参见 `docs/features/PRODUCT_LIBRARY.md` §0-A。

#### S1 增补（2026-09-27 下午）：店铺标识列 + 名下店铺区块（方案 B）

| 层 | 产物 | 说明 |
|---|---|---|
| 数据层 | `electron/shop-db.ts` | `sk_shops` 增 `platform_shop_id` 列（幂等 `ALTER`，`PRAGMA table_info` 判定）+ **部分唯一索引** `(platform, platform_shop_id) WHERE platform_shop_id <> ''`；`upsertShop` 对撞名称 / 撞标识**分别抛不同文案**。定位不是"订单自动关联"（三处历史文本实测都没有店铺ID可比对），而是**店铺实体的稳定业务键**：改名不断链 + 收拢同店多种写法 |
| 岛 | `ui-plugins/shop-accounts` 1.5.1 → **1.5.2** | ① 编辑抽屉新增「名下店铺」区块：登记/解绑 `sk_shops`，`shop_set_id` 软关联，复用 `shop` 域 `list` 既有 `shopSetId` 过滤（**未新增 op**）；② 修复店铺登记编辑表单不透传 `platformShopId`、全量提交静默清空标识 |
| 决策修正 | 方案 B | G1 当年怕"1 账号 N 店"裁定店铺不进 `sk_shop_sets`；实测 **14/14 套装的 `platforms` 都是单元素** —— 真实模式是"1 套装 = 1 店"。但仍选**方案 B**（UI 在店铺套、数据落 `sk_shops`）：避免两张"店铺"表复发 D2、`pl_shop_sku.shop_id` 不用改、软关联可迁移 |
| 发布 | `market-out/shop-accounts-1.5.2.zip`（sha256 `8fc1193b…ed284`） | 本机 `<userData>/plugins/` 已同步 |

**两条新口径**：① 店铺套的平台展示名（`速卖通`）与 `sk_shops.platform`（`ae`）是**两套词表**，只靠 `shopPlatformCodeFromLabel()` 启发式对接、对不上由人选；② 全量提交下**解绑必须整行回传**只改 `shopSetId=0`，登记页编辑必须回填 `platformShopId`（1.5.2 前编辑一次即静默清空标识）。

**验证**：端到端真机探针四步全绿（区块 → 登记落库关联 → 桥查 → 解绑归 0）；`shop:smoke` 基线绿 + **变异 4/4 变红**（标识查重短路 / 索引丢 WHERE / 归一去掉 / `shopSetId` 过滤删除）；`verify` / `vue-tsc` / `vitest` 23 文件 421 例全绿。坑：变异串**必须锚定 DDL**——文件头注释里有同形的 `WHERE platform_shop_id <> ''`，`String.replace` 只换第一处会打在注释上（变异未生效却报"恒绿"）。

---

## 5. 关联文档与后续同步

- 本方案是 `docs/features/PRODUCT_LIBRARY.md` 的**并行姊妹方案**：产品库管「款/SKU 主数据」，本方案管「店铺实体 + 名称归一 + 跨域只读统计」。两者共同构成主数据层，`style_code` 与 `sk_name_map` 是两条对齐缝。
- S1 完成后的回写（✅ 2026-09-27 已做）：`docs/baseline/PROJECT_BASELINE.md` **§0/§3/§4/§5/§6/§7/§9/§10**（新增 `sk_shops` / `sk_name_map` 与两个建表文件、IPC 数字 153/149 → **161/157**、岛清单 shop-accounts 1.5.0、新增 `shop-*` 通道域、§3/§6/§9/§10 为全量重扫）、`docs/README.md`（本体与 `PRODUCT_LIBRARY.md` 的索引行 + 补上漏登记的 `reviews/HOST_REVIEW_2026-09-22.md`）、`CHANGELOG.md` `[Unreleased]`、本文档 §0/§1.1–§1.4/§3.3/§4/§5。
  另顺手订正 `AGENTS.md` §1.4 的两处**事实性**滞后（命名空间清单缺 `ae-profit` / `shipping-rate`；UI 岛实例清单缺 `shipping-rate` / `product-library`）——
  这不违反"规则只有一份"：改的是**实例清单**，不是规则条文。
  **S1 本身没有新增 storage 命名空间**（`shop` 是 db 能力域，`product-library` 岛无 `storage`），故无需为此新增命名空间条目。
- 本方案的方向与边界已固化为 `docs/decisions/ADR-002-master-data-layer.md`：ADR 定**边界与理由**（数据三层划分、单点写入、ID 关联、共享域粒度与只读性），本文件定**实现与顺序**（§3.2 目标模型 / §3.3 三步 / §3.4 决策参数）。两者应始终一致；改动任一侧须同步另一侧。
- 与 `docs/plans/REMEDIATION_PLAN.md` 无重叠：那份是工程质量整改（依赖/类型/护栏），本方案是业务数据串联。
