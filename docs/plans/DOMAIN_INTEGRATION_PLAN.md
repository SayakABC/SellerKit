# 业务域盘点与串联方案（Domain Inventory & Integration Plan）

> **状态**：✅ 方案已定稿（2026-09-24 裁定 G1–G7，见 §3.4.1）· 🚧 **S1 已实施（2026-09-27）**，**下一步 S2（共享域放行）**；S4 产品库已推进到 **P3（2026-09-27）** 可直接当 S2 样板。边界与理由固化为 `docs/decisions/ADR-002-master-data-layer.md`。
> **读者**：架构 / 插件开发者
> **性质**：§1–§2 是**客观快照**（以代码为准，含 `文件:行` 取证）；§3–§4 是**方案与计划**（含待拍板决策）。
> **前置阅读**：`AGENTS.md` · `docs/baseline/PROJECT_BASELINE.md` §6 · `docs/features/PRODUCT_LIBRARY.md`

---

## 0. 结论速览（TL;DR）

| 项 | 现状 |
|---|---|
| 库 | **1 个** SQLite 文件 `userData/sellerkit.db`（WAL + `foreign_keys=ON`）；非多库文件 |
| 表 | 稳态 **33 个对象** = 31 业务表 + 1 内部 KV `sk_mail_meta` + 1 FTS5 虚拟表 `sk_mail_fts`（口径见 `docs/baseline/PROJECT_BASELINE.md` §6） |
| 功能入口 | **7 个**：6 个市场 UI 岛 + 1 个内建模块（便签） |
| db 能力域 | **9 个**（含 `shop` 为 S1 新增）；`mail` 是独立能力域（非 db） |
| 唯一贯通的主键 | **`style_code`（款式编码）** —— 零迁移 |
| 完全没贯通的实体 | **店铺**（2026-09-27 S1 已立实体，但映射尚未被任何消费岛使用） |
| 断裂数量 | 数据层 4 条（D1–D4）+ 架构层 2 条（D5–D6）+ 体验层 1 条（D7）；D1 已部分收敛 |
| 方案主线 | **补 1 个缺失实体层（店铺）+ 1 个共享只读域 + 1 张名称归一映射表**；不 ALTER 存量业务表，不做数据迁移 |

> ⚠️ §1 是「快照」，此后变化记录在 **§4.3 执行记录**（`docs/baseline/PROJECT_BASELINE.md` §3–§6 同步刷新）。

---

## 1. 现状盘点

### 1.1 存储布局

```
userData/sellerkit.db（单库，electron/db.ts 的 initDb()，全仓唯一连接）
├── oi_*          订单归类域     6 表   electron/order-db.ts
├── purchase_* / suppliers / payments    采购对账域   6 表   electron/purchase-db.ts
├── ae_*          利润追踪域     5 表   electron/ae-db.ts
├── pl_*          产品库域       2 表   electron/product-db.ts（P1/P4a 新增）
├── sk_shop_sets  店铺账号域     1 表   electron/shop-accounts-db.ts   ⚠️ 2026-10-22 已删除（见下）
├── sk_shops / sk_name_map   店铺实体 + 名称归一映射   2 表   electron/shop-db.ts（S1 新增，2026-09-27）
├── sk_companies / sk_company_profiles   企业合规域   2 表   electron/company-db.ts
└── sk_mail_*     邮件域         8 对象  electron/mail-db.ts
userData/config.json   ← electron-store（UI 偏好，非业务数据）
```

> ⚠️ **本文件是 2026-09 的盘点，店铺账号域的形状已在 2026-10-22 变了**：`sk_shop_sets`（账号套装）
> **已删除**，账号列并进 `sk_shops`（「店铺 + 账号单表」，`name` / `email` 任一非空即可）；紫鸟 / ERP 抽成
> `sk_tool_accounts`；`sk_mail_accounts.shop_set_id` → **`shop_id`**（外键目标改指 `sk_shops(id)`）。
> 下文所有 `sk_shop_sets` / `shop_set_id` 行**按此读**（保留原文是为记录当时的取证与裁定过程）；
> 权威现状见 `docs/baseline/PROJECT_BASELINE.md` §6，裁决见 `docs/decisions/ADR-003-shop-account-physical-merge.md`。

> ⚠️ `docs/baseline/PROJECT_BASELINE.md` §6 标题写"分域 db 文件"与事实不符（分域的是**表**，库只有一个），且把迁移期临时表 `purchase_items_new` 列为稳态、漏 `sk_mail_fts`。本文件 §1.2 为准，基线 §6 待回写（§4 S0-3）。

### 1.2 表清单（关键列 / 归属 / 读写）

**订单归类域**（`electron/order-db.ts`，前缀 `oi_`）：`oi_images`（主图=识别任务单元，`style_color_id` 挂款色）、`oi_orders`（订单行，`image_id`/`shop`/`size`/`raw_fields`/`category`/`color`/`logo`/`status`/`corrected`）、`oi_styles`（**款式主档**，`code` UNIQUE）、`oi_style_colors`（款色，`style_id`+`color`→`code` UNIQUE）、`oi_style_fingerprints`（同款多指纹）、`oi_queue`（识别队列，断点续跑）。

**采购对账域**（`electron/purchase-db.ts`）：`suppliers`（`name` UNIQUE）、`purchase_orders`（拿货单，`supplier_id`/`status`）、`purchase_items`（明细，`style_code`/`color`/`size`/`qty`/`price_cents`/`amount_cents`，UNIQUE(purchase_id,style_code,color,size)）、`purchase_sources`（来源订单行，`shop`/`style_code`/`color`/`size`/`qty`）、`payments`（付款/退款）、`purchase_ignore`（免补货标记）。

**利润追踪域**（`electron/ae-db.ts`，前缀 `ae_`）：`ae_orders`（AE 订单主档，`shop_name`/`order_time`/`status`）、`ae_order_lines`（SKU 行，含 `style_code`）、`ae_fees`（费用科目）、`ae_cost_map`（**款→加权成本快照**，`style_code` PRIMARY KEY + `effective_from` 复合主键，P4a 后）、`ae_rates`（币种→CNY 汇率）。

**店铺账号/企业合规/邮件域**：`sk_shop_sets`（**账号套装**，非"店铺"，`email`/`company`/`platforms` JSON）、`sk_companies`（企业主体）、`sk_company_profiles`（合规资料，`expire_at`）、`sk_mail_accounts`（`shop_set_id`→`sk_shop_sets` ON DELETE CASCADE）、`sk_mail_messages`/`sk_mail_bodies`/`sk_mail_attachments`/`sk_mail_folders`/`sk_mail_attachment_cache`/`sk_mail_meta`（KV）/`sk_mail_fts`（FTS5）。

> `purchase_items_new` 仅存在于迁移函数 `migrateItemsSize()` 内部，随即 `DROP`+`RENAME` 成 `purchase_items`，**非稳态表**。

### 1.3 功能清单（入口 → 页签 → 依赖的表 / 域）

| 入口 | 形态 | 依赖 db 域 | 落库表 |
|---|---|---|---|
| **便签** | 内建模块 | 无 | 无（重启即失） |
| **店铺账号管家** | UI 岛 v1.5.0 | `shop-accounts`/`secrets`/`mail`/`shop` | `sk_shop_sets`/`sk_companies`/`sk_company_profiles`/`sk_mail_*`/`sk_shops`/`sk_name_map` |
| **订单归类** | UI 岛 v1.2.0（**2026-10-05 整体下架**） | `order-insight`/`purchase` | `oi_*`/`suppliers`/`purchase_*`/`payments` |
| **TV模版** | UI 岛 v1.0.0 | `excel-copy` | 无业务表（electron-store `excel-copy`） |
| **利润追踪** | UI 岛（**2026-09-30 起 1.1.0：三页签收编进宿主「算钱」**，岛只剩采集接收端） | `ae`/`purchase` | `ae_*` |
| **无忧物流运费** | UI 岛 v1.1.0 | `shipping-rate` | 无业务表（运价表落 `shipping-rate`；重量落 `pl_item_weights`） |
| ~~**产品库**~~ | ~~UI 岛 v1.0.0~~ | ~~`product`~~ | — |
| → **（2026-10-01）已下架·收归内建** | 落 `src/modules/goods/**`（「货与成本」4 页签）；UI 岛/`product` 域/`pl_item_weights` 已删。数据层（`pl_products` 等）与 IPC 通道不变 | 无 | `pl_products`/`pl_variants`/`suppliers` |

### 1.4 能力域矩阵（谁独占、谁共享）

| db 域 | 声明该域的岛 | op 数 | 独占/共享 |
|---|---|---:|---|
| `shop-accounts` | 店铺账号管家 | 17 | **独占**（超 ADR-002 N5，存量豁免） |
| `secrets`/`mail` | 店铺账号管家 | — | **独占**（非 db 域，不受 op 预算约束） |
| `order-insight` | 订单归类（**已下架**） | 37 | 独占（超预算，存量豁免） |
| `excel-copy` | TV模版 | 7 | 独占 |
| `ae` | 利润追踪 | 9 | 独占 |
| `purchase` | 订单归类/利润追踪 | 24 | **共享域**（超预算，存量豁免） |
| `shipping-rate` | 无忧物流运费 | 5 | 独占 |
| `product` | 产品库（已下架） | 8 | 独占（P3 起对外开只读子域） |
| **`shop`** | 店铺账号管家（S1，当前唯一消费者） | 8 | **设计上就是共享只读域** —— S2 放行给订单归类/利润追踪 |

> `purchase` 是**目前唯一被两个岛同时声明**的域，共享方式是**单向只读出口**（`costSnapshot()`，`electron/purchase-db.ts` L921）。
> op 预算（ADR-002 N5/C4）：单域 op ≤ 10。17/24/37 是存量冻结（`tests/pluginTriage.spec.ts` 的 `GRANDFATHERED`，只允许变少）；新域必须守 10 —— 故 `shop` 定稿 8 op（S3 的 `shopOverview` 是第 9 个，再上加就得先按 C4 拆只读子域）。

---

## 2. 串联诊断：为什么串不起来

### 2.1 实体锚点表（谁是谁的键）

| 业务实体 | 权威来源 | 其他域如何引用 | 判定 |
|---|---|---|---|
| **款式**（款编码） | `oi_styles.code`（UNIQUE） | `purchase_items`/`ae_cost_map`/`ae_order_lines` 的 `style_code` | ✅ 唯一贯通，零迁移 |
| 款色 | `oi_style_colors` | `oi_images.style_color_id`（ALTER 增列，无 FK） | ⚠️ 可达但无约束 |
| 供应商 | `suppliers.name`/`id` | `purchase_orders`/`payments` 真 FK | ⚠️ 只在采购域内闭环 |
| 企业 | `sk_companies.id` | `sk_shop_sets.company_id`（软关联） | ⚠️ 半条链 |
| 邮箱 | `sk_mail_accounts` | `shop_set_id`→`sk_shop_sets` 全仓唯一硬外键 | ✅ |
| **店铺** | **无** | `oi_orders.shop`/`purchase_sources.shop`/`ae_orders.shop_name` 三处自由文本 | ❌ 无主键/归一/FK |
| 产品/SKU | **无** | — | ❌ 缺失（产品库补） |
| 成本 | `purchase_items`→`ae_cost_map` | 按 `(款,生效日)` 快照 | ✅ 时间维度已补（P4a） |

### 2.2 断裂点

#### D1 ★ 核心：「店铺」实体根本不存在，且两侧概念不同
店铺账号管家认为的"店铺" = `sk_shop_sets` 一行（**一个邮箱账号套装**）；订单归类/采购/利润追踪认为的"店铺" = **平台上的店铺名称字符串**（`oi_orders.shop`/`purchase_sources.shop`/`ae_orders.shop_name`）。一个邮箱可在多平台开多店，而这层没有表 ⇒ 账号改名/停用其余功能无感；同名店铺无法判断属哪个账号。

#### D2 店铺名三处自由文本，且互相拷贝
`oi_orders.shop` → 采购域 `autoSourceRows()` 原样拷进 `purchase_sources.shop`；`ae_orders.shop_name` 来自扩展推送。同一店铺最多 3 份独立字符串，手输错空格即对账/利润归到两个"店铺"且不报错。

#### D3 款式编码贯通，但款式本身没有权威主数据
`oi_styles` 只有 `code`/`name`/`fingerprint`/时间列 —— 无产品属性。骨干键存在但没挂主数据，款只是订单归类的副产品。缺口由 `docs/features/PRODUCT_LIBRARY.md`（`pl_*` 表）补，本方案不重复造，S4 合流。

#### D4 成本是覆盖式快照，无时间维度 → 历史毛利不可复算 ✅ 已修（P4a，2026-09-24）
改造后：`costSnapshot()` 按 `(款, 拿货日期)` 分组；`ae_cost_map` 改 `(style_code, effective_from, source)` 复合主键（一款多行）；`costMapReplace` 只清 `source='purchase'` 行（手工 `manual` 不被抹）；利润引擎按**订单业务日期**取 `effective_from <= 订单日` 最近一条（同生效日 manual 优先）。剩余：**汇率（`ae_rates`）仍无生效区间**，故"今日改汇率改历史毛利"未消除（属 ADR-002 Q2 后续）。

#### D5（架构）能力域按"岛"切分，没有共享只读域
`security.ts` 要求请求 `domain` 必须命中插件 manifest 声明的 `domains`，否则拒绝。⇒ `shop-accounts` 域被独占，其他岛架构上拿不到店铺列表。D1/D2 无法在岛侧修。

#### D6（架构）没有跨域事件
`eventBus.ts` 只有三个生命周期事件，无业务事件。岛间只能轮询/手动刷新。

#### D7（体验）没有统一入口，也没有交叉跳转
5 个入口平铺侧栏，无首页/概览，无"订单跳拿货单""店铺跳订单/邮件"。

### 2.3 影响面：现在答不出来的业务问题

| # | 问题 | 能否答 | 卡在哪 |
|---|---|---|---|
| 1 | 这个**店铺**这个月赚多少？ | ❌ | 店铺无主键（D1/D2） |
| 2 | 这个**款**从哪家拿货、卖到哪些店、毛利多少？ | 🟡 半答 | 款编码通 ✅，但"卖到哪些店"卡 D1 |
| 3 | 上周那条订单的货拿了没？ | ✅ | 同域可答（`outstanding()`） |
| 4 | 这个**账号**下几家店？合规齐不齐？ | ❌ | 账号→店铺层不存在（D1） |
| 5 | 同款多店卖，防关联风险？ | ❌ | 需 product×shop×account 三方关联，店铺层缺（D1/D3） |
| 6 | 上月毛利用当时价格汇率重算 | ❌ | 成本与汇率覆盖式更新（D4） |

---

## 3. 方案

### 3.1 原则

1. **零迁移优先**：不 ALTER 存量业务表、不重写历史数据；新结构以"映射/回填"旁挂。
2. **补缺失实体层，而非补关联字段**：建 `sk_shops` 一张表，三处文本降级为"待归一输入"。
3. **宿主侧一次建成，岛侧只声明与消费**：op 一次定稿，避免每接消费方就发版。
4. **不破安全模型**：`security.ts` 的 per-plugin `domains` 不变；共享靠"多岛各自声明同一域"。
5. **可回退**：每步能单独停机。

### 3.2 目标模型

```
sk_companies ─► sk_shop_sets（账号套装）──► sk_shops（★新增：平台 × 店铺名）
                                                  ├──► oi_orders.shop（文本→归一）
                                                  ├──► purchase_sources.shop
                                                  └──► ae_orders.shop_name
pl_products（产品/SKU 主数据）──► oi_styles.code ──► purchase_items.style_code / ae_order_lines / ae_cost_map
suppliers ──► purchase_orders ──► purchase_items ──► ae_cost_map（按 (款,拿货日) 多行）
```

新增 1 主表 + 1 映射表：

| 新表 | 作用 |
|---|---|
| `sk_shops` | **店铺实体**：`platform`×`name`（UNIQUE 组合）×`shop_set_id`（软关联）×`site`×`status`×`opened_at`×`note` |
| `sk_name_map` | **名称归一映射**：`kind`(`shop`/`supplier`/`style`)×`raw`(历史文本)×`ref_id`×`source`(`auto`/`manual`)×`confidence`；唯一键 `(kind,raw)` |

`sk_name_map` 使历史文本**不需改写**：查询时按 `kind='shop'` join `sk_shops.id`；人工确认的映射永不被自动覆盖。

### 3.3 三步落地

**S1 立"店铺"实体** ✅（2026-09-27，见 §4.3）：宿主新增 `electron/shop-db`（DDL+CRUD）+ `electron/shop-handlers`；店铺账号管家加「店铺登记」页签（`shop-accounts` 1.5.0）。⚠️ 实施时改掉"首启动只读扫描落盘"那条 —— 不给自动扫描结果落行（`source='auto'` 占位会与人的决定混表、删单/重导后漂移），改为 `listUnmapped` **每次实时扫三处文本**，`sk_name_map` **只存人工决定行**（故 `source` 至今只有 `manual`）。

**S2 共享只读域**：宿主 `DB_OPS` 新增域 `shop`（≤10 op：`ensure`/`list`/`get`/`upsert`/`unmapped`/`map`/`unmap`/`stats`）。各消费岛 manifest 加 `"shop"` 到 `domains` 并同步 `actions`，各发一次版本。

**S3 串联可见**：在 `shop` 域上叠 **1 个跨域统计 op** `shopOverview({shopId,from,to})` → 订单数/拿货成本/收入/毛利，实现落主进程，一次 SQL 串联 `oi_*→purchase_*→ae_*`。

**S4 与产品库合流**：`PRODUCT_LIBRARY.md` 的 P1（`pl_*` DDL + `product` 域）与本方案 S1 同批；`sk_name_map.kind` 预留 `product`，供产品库编码归一复用。

### 3.4 待拍板决策

| 编号 | 决策点 | 建议 | 影响面 |
|---|---|---|---|
| **G1** | 店铺实体落点 | **新表 `sk_shops`**（不塞进 `sk_shop_sets`） | 全库查询路径 |
| **G2** | 归一方式 | **旁挂映射表 `sk_name_map`**，不改写历史文本 | 是否要迁移脚本 |
| **G3** | 是否给存量表加 `shop_id` 列 | **暂不加**（先靠映射 join；性能问题再评估 ALTER） | 查询性能 vs 改动面 |
| **G4** | 共享域粒度 | **按实体分域**（`shop`/`product`），不建万能 `master` 域 | 安全边界可读性 |
| **G5** | 成本历史 | ~~保持当期~~ → **改判：现在就给 `ae_cost_map` 加生效日区间**（落点见 ADR-002「Q2 执行口径」） | 是否动利润引擎 → 已动（P4a） |
| **G6** | 自动归一策略 | 先**只做精确匹配 + 去空白**；模糊匹配只产"建议"，不写 `ref_id` | 错并风险 |
| **G7** | 跨域事件 | 本轮**不做**（D6）；留到有真实"一处写、多处重算"场景 | 是否引入业务事件契约 |

### 3.4.1 裁定结果（2026-09-24）

| 编号 | 裁定 |
| ---- | --- |
| G1 | ✅ 新表 `sk_shops`（不塞进 `sk_shop_sets`） |
| G2 | ✅ 旁挂映射表 `sk_name_map`，**不改写历史文本** |
| G3 | ✅ 暂不给存量表加 `shop_id` 列 |
| G4 | ✅ 按实体分域（`shop`/`product`…），**不建万能域** |
| G5 | ⚠️ **改判**：成本历史**现在就加生效日区间**（原"保持当期"被否） |
| G6 | ✅ 只做精确匹配+去空白，模糊相似度**只作排序提示、永不写 `ref_id`** |
| G7 | ✅ 跨域事件本轮不做 |

补充：**域命名规则**见 `ADR-002` Decision §5（新域 `shop` 合规）。✅ G5 改判新增工作量已落地（P4a）：`ae-engine.ts` 取成本改按订单业务日期匹配区间 + `ae_cost_map` 加 `effective_from`，并同步改快照源头 `purchase-db.ts` 的 `costSnapshot()`。回归见 `scripts/ae-cost-smoke.cjs`（`npm run ae:smoke`，13 项）。

### 3.5 风险与红线对照

| 风险 | 应对 | 依据 |
|---|---|---|
| 新岛 id 登记进 `modules.config.json` → 市场同名岛无法注册 | 新功能一律做 UI 岛，三处预设都不登记 | `AGENTS.md` 红线 23 |
| 透传 SQL / 岛内拼 SQL | 全部经 `DB_OPS` 白名单，op 内参数化 | `AGENTS.md` §1.7 / 红线 3 |
| 自动归一误并 → 数据静默算错 | `source='auto'` 行可一键清空；`manual` 优先不覆盖；`confidence` 留痕 | G6 |
| 改已发布岛 `domains` 需发版 | S1 **一次定稿** `shop` 域 op 集（≤10） | `PRODUCT_LIBRARY.md` §6.2 |
| 岛 manifest `actions` 撞 128 上限 | 现用量远低于上限；`shop` 域 ≤10 仍余量 | `externalManifest.ts` L44 |
| 跨域 JOIN 拖慢首屏 | 统计 op 主进程分页/聚合，只回传汇总 | `PRODUCT_LIBRARY.md` §7 |
| 文档/基线继续漂移 | S0 一并修 `PROJECT_BASELINE.md` §6 两处事实错误 | 本文件 §1.1 注 |

---

## 4. 实施计划

### 4.1 阶段

| 阶段 | 内容 | 落点 | 验收 | 依赖 |
|---|---|---|---|---|
| **S0 决策冻结** ✅ | 拍板 G1–G7；回写 `PROJECT_BASELINE.md` §6 | 本文档 §3.4 | 七项决策有结论并记录 | — |
| **S1 店铺实体** ✅（2026-09-27） | `sk_shops`+`sk_name_map` DDL/CRUD/三处文本只读汇总/店铺登记页 | `electron/shopName.ts`+`shop-db.ts`+`shop-handlers.ts`+`scripts/shop-db-smoke.cjs`+`tests/shopName.spec.ts`；岛 `ui-plugins/shop-accounts` 加「店铺登记」页（1.5.0） | 实跑 `verify` 161≡161/157 通道；空库 `ensure` 成功；未归一名单与三处文本逐名计数一致（`shop:smoke` 25/25）；真机探针 8/8 | S0 |
| **S2 共享域放行** | 消费岛 manifest 加 `domains:["shop"]` 同步 `actions`，各发一版 | `ae-profit`/`shop-accounts` manifest（原清单还有 `order-insight`，已 2026-10-05 下架） | 权限门 `shop.*` 调用全 `allowed`（拒绝数 0）；`plugins:island:smoke` 通过 | S1 |
| **S3 串联可见** | `shopOverview` 跨域统计 op + 岛内展示 | `DB_OPS['shop']` + `shop-accounts` 店铺详情 | 任取一家店铺，其"订单数/拿货成本/收入/毛利"与三处分别看到的口径一致 | S2 |
| **S4 与产品库合流** | 按 `PRODUCT_LIBRARY.md` P1–P3 推进；`sk_name_map.kind` 增 `product` | 见 `PRODUCT_LIBRARY.md` §5/§7 | 该文档 §7 验收 | S1（共用映射表已建）；P3 ✅ 可并行 |
| **S5 体验收口**（可选） | 宿主"经营概览"入口 + 岛间关联跳转 | `AppShell.vue` + 岛内跳转按钮 | 从店铺一跳进其订单/邮件；概览数字与各岛一致 | S3 |

> ⚠️ **S2 前必须先解决**：`shop` 域是**写读同域**（ADR-002 C4 要求共享域只读）。S1 无妨（唯一消费者是拥有者），但**放行给其他岛前**必须按 C4 拆只读子域（`shop` 与 `product` 现都 8 op，S3 的 `shopOverview` 一加就到 9，逼近 N5 上限 10）。

### 4.2 为什么这个顺序

- **S1 在 S2 前**：无实体表，放行 `shop` 域只是搬自由文本。
- **S2 在 S3 前**：`shopOverview` 是跨域 op，先让消费岛拿到域权限，否则调用被拒。
- **S4 与 S2/S3 可并行**：动的表/域/岛不重叠，交汇点只有 `sk_name_map`（S1 已建）。

### 4.3 执行记录

#### S1 店铺实体（2026-09-27）

**产物**：`electron/shopName.ts`（纯函数、零依赖才能进 vitest）+ `shop-db.ts`（`sk_shops`+`sk_name_map` DDL/CRUD/三处文本）+ `shop-handlers.ts` 及契约四处（8 通道）+ `host.ts` 新增 `DB_OPS['shop']`（8 op）+ 岛「店铺登记」页（1.5.0）+ 测试（`shopName.spec`15 / `shop-db-smoke`25 / `shop-registry-smoke`8 / `pluginTriage`+1）。
**六条口径（被真实数据/规则逼出，改宽前先读理由）**：① `name_key` 必须进 UNIQUE（`(platform,name_key)`，否则 `"店A"`/`"店A "` 同库）；② 归一口径 = 去空白 + 剥不可见字符（U+200B–200F 等），**不做**大小写折叠/模糊匹配/去全部内部空白（内部空格是有效差异）；③ 不猜歧义（同键命中>1 家不给 `autoShopId`）；④ 未归一名单是**实时聚合非缓存**；⑤ 映射表**只存"人的决定"**（不写 `source='auto'`）；⑥ 模糊匹配只作排序提示、**永不写 `ref_id`**（G6），故 `sk_shops` **有意不建 `confidence` 列**。
**验证（全实跑）**：`verify` 166≡166/162 通道、`vue-tsc`/`tsc` 0 error、`vitest` 23 文件/421 例、`shop:smoke` 25/25、`plugins:island:smoke` 6/6、真机探针 8/8、`build`/`verify:docs` 通过；变异验证 op 预算守卫与店铺守卫均变红；收工复原比 sha256。
**顺带查出存量问题**：`order-insight`/`purchase`/`shop-accounts` 三域 op 数 37/24/17 超 N5，新增守卫冻结基线（`GRANDFATHERED`，只允许变少）；`apiBindings()` 守卫曾漏 `ae-profit`/`shop-accounts` 两岛（P2 已修，本轮受益）。
**未做（属 S2/S3）**：消费岛尚未声明 `shop` 域，映射无消费方（D1 只"部分收敛"）；`shop` 域写读同域，放行前须按 C4 拆只读子域；`sk_name_map.kind` 的 `supplier`/`style`/`product` 预留值无生产者（产品库 P3 走 `oi_styles.code≡pl_products.code` 直连，不经 `sk_name_map`）。

> 📌 **`product` 域 C4 拆域样板（2026-09-27，P3）**：`product` 域被 5 个只读 op 顶到 13（顶穿 N5），按 C4 拆成 **`product`（共享只读 6）+ `product-admin`（owner 写 7）**，`security.ts`/`externalManifest.ts` 零改动、岛侧只改 `manifest.capabilities` 升版。两点可复用：① 判据是**消费者能否"结构上够不到"写 op**；② 拆域**必须连带消费岛发版**。⚠️ 该拆域已随岛下架删除（`src/core/plugin/host.ts` 留墓碑）—— 现无实物，详见 `docs/features/PRODUCT_LIBRARY.md` §0-A。

#### S1 增补（2026-09-27 下午）：店铺标识列 + 名下店铺区块（方案 B）

数据层 `sk_shops` 增 `platform_shop_id` 列（幂等 `ALTER` + 部分唯一索引 `(platform, platform_shop_id) WHERE platform_shop_id<>''`）；岛 `shop-accounts` 1.5.1→**1.5.2** 编辑抽屉加「名下店铺」区块、修编辑不透传 `platformShopId` 静默清空。决策修正：实测 14/14 套装 `platforms` 都是单元素（"1 套装=1 店"），但仍选**方案 B**（UI 在店铺套、数据落 `sk_shops`）避免两张"店铺"表复发 D2。验证：真机探针四步全绿、`shop:smoke` 基线 + 变异 4/4、`verify`/`vue-tsc`/`vitest` 全绿。

---

## 5. 关联文档与后续同步

- 本方案是 `docs/features/PRODUCT_LIBRARY.md` 的**并行姊妹方案**：产品库管「款/SKU 主数据」，本方案管「店铺实体 + 名称归一 + 跨域只读统计」，共同构成主数据层，`style_code` 与 `sk_name_map` 是对齐缝。
- S1 回写（✅ 2026-09-27）：`docs/baseline/PROJECT_BASELINE.md` §0/§3–§7/§9/§10（新增 `sk_shops`/`sk_name_map`、IPC 数字 153/149→161/157、岛清单 1.5.0）、`docs/README.md`、`CHANGELOG.md` `[Unreleased]`、本文档 §0/§1.1–§1.4/§3.3/§4/§5。顺手订正 `AGENTS.md` §1.4 实例清单两处滞后（不违反"规则只有一份"：改的是实例清单非规则条文）。
- 方向与边界已固化为 `docs/decisions/ADR-002-master-data-layer.md`：ADR 定**边界与理由**，本文件定**实现与顺序**；改动任一侧须同步另一侧。
- 与 `docs/plans/REMEDIATION_PLAN.md` 无重叠：那份是工程质量整改，本方案是业务数据串联。
