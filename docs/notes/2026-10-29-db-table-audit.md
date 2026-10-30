# 2026-10-29 数据库表审计（分析 + 注释 + 两张退役表清理）

> 目的：判定每张表是否还在用，并按仓库既有约定在 schema 定义里补"用途"注释。
> 本轮分两段：**先只分析（未删任何表）**；再按用户裁定删除 `sk_shop_sets` 与 `bk_periods`、
> 清理相关代码并在运行库执行清表（见 §8）。除这两张表外，其它 DDL（列名、类型、索引、约束）一字未动。
> 运行库路径：`~/Library/Application Support/seller-kit/sellerkit.db`。

## 1. 汇总

| 口径 | 数量 |
| --- | --- |
| 运行库表数（审计时，`sqlite_master.type='table'`，不含 `sqlite_sequence`） | **60** |
| 运行库表数（清表后实测，同口径） | **58**（−2） |
| 新库稳态对象数（`npm run db:inventory`，清表后实测） | **53** = 表 52（业务 50 + 内部 2）+ FTS5 虚表 1 |
| 在用 | **47** |
| 边缘（审计时） | **6** |
| 疑似无用 | **0** |
| 基础设施 | **7**（FTS5 影子表 5 + `sk_mail_meta` + `sk_schema_migrations`） |
| 已退役删除 | **2**（`sk_shop_sets`、`bk_periods`） |

> `sqlite_sequence` 是 SQLite 为 `AUTOINCREMENT` 自建的内建表（记录各表最大 id），不属任何业务域，也不参与计数。

两条口径差异：新库不再建 `sk_shop_sets`（历史遗留），审计时只有运行库因历史升级残留这张 0 行空表；
`bk_periods` 则是新库仍会建、但代码零读写的留位表。本轮两张都已退役。
`docs/baseline/PROJECT_BASELINE.md` §6 里"稳态共 50 个对象（47 业务表）"已过时（清表后实测为 53 / 50）。

### 与用户提供清单的出入

1. 清单实际列了 **60** 个表名（不是 59），与运行库完全一一对应，没有缺失项。
2. 运行库另有 `sqlite_sequence`（SQLite 内建，见上），清单不必收录。
3. 用户清单里的 5 个 `sk_mail_fts_*` **不是业务表**，是 FTS5 的内部影子表（详见 §2 基础设施）。
4. `sk_shop_sets` 在新库中不会创建，且已在本轮退役（`shop.main` v2 幂等清掉历史残留，见 §8）。

## 2. Schema 权威定义位置

- 公共层：`electron/db.ts`（连接、`dbMigrate`、`migrate`、记账表 `sk_schema_migrations`）
- 各域建表语句（新库一次建到当前形状）：`electron/{ae,ledger,mail,order,product,shop-item,purchase,shop,company,ship-rate}-db.ts`
- 存量库形状收敛：同一文件里的 `migrate('<域>.main', steps)` 版本化迁移（**与 `dbMigrate` 不可互替**，见 AGENTS §1.4）
- 对象清单真源：`scripts/db-inventory.cjs`（`npm run db:inventory`，空库逐域跑 `ensure*Schema()`）

## 3. 逐表清单

「引用位置」给的是**建表语句所在行**（当前工作区，注释已加）；读写方给的是函数/模块名，便于跳转核查。
行数来自运行库只读 `COUNT(*)`（2026-10-29）。

| 表名 | 分类 | 建表位置 | 读/写方（模块或能力域） | 行数 | 备注 |
| --- | --- | --- | --- | --- | --- |
| ae_rates | 在用 | `electron/ae-db.ts:156` | 写 seedDefaultRates / setAeRate；读 upsertOrderBatch、算钱页 | 3 | 只存当前汇率，不存历史 |
| ae_settle_lines | 在用 | `electron/ae-db.ts:176` | 写 importSettleLines；读 settleOrders | 24 | 商品级/订单级两类行，不可相加 |
| bk_parties | 在用 | `electron/ledger-db.ts:134` | 写 相关人维护/合并；读 partyLedger | 5 | 停用/合并不删行 |
| bk_categories | 在用 | `electron/ledger-db.ts:154` | 写 种子 + 科目维护；读 条目表单/汇总 | 25 | 收入/支出两套独立 |
| bk_entries | 在用 | `electron/ledger-db.ts:171` | 写 录入/导入/改挂；读 台账/月汇总/分摊 | 307 | `period` 为生成列 |
| bk_allocations | 在用 | `electron/ledger-db.ts:202` | 写 writeAllocations；读 店铺损益、删店校验 | 2484 | 派生数据，整批重写 |
| bk_allocation_rules | 在用 | `electron/ledger-db.ts:215` | 写 保存方案；读 分摊下拉 | 0 | 空态正常（还没存过方案） |
| bk_settlements | 在用 | `electron/ledger-db.ts:102`（`settlementsDdl`） | 写 结算页；读 余额/明细 | 3 | 作废不删行 |
| bk_settlement_lines | 在用 | `electron/ledger-db.ts:237` | 写 结算/作废；读 条目结算状态 | 234 | 部分唯一索引 `WHERE active=1` |
| bk_transfers | 在用 | `electron/ledger-db.ts:251` | 写 mergeParty；读 余额起始项 | 0 | 只在下相关人合并时才写 |
| bk_periods | **已删除**（原边缘） | （DDL 已移除） | 无读写 | 删除前 0 | 月结留位表，产品不做月结；`ledger.main` v4 清表 |
| bk_op_log | 在用 | `electron/ledger-db.ts:277` | 写 logOp；读 操作历史/排障 | 318 | 只追加不更新 |
| oi_orders | 在用 | `electron/order-db.ts:287` | 写 导入/采集（order-handlers）；读 订单列表/利润 | 70 | 主表，订单号唯一 |
| oi_order_items | 在用 | `electron/order-db.ts:294` | 写 导入/归类/认款；读 归类、采购需求、拣货 | 75 | 款色/成本/变体键落点 |
| oi_variant_keys | 在用 | `electron/order-db.ts:337` | 写 归类/人工合并；读 重导幂等、归类提示 | 59 | 键→款色映射，N:1 合法 |
| oi_style_merges | 边缘 | `electron/order-db.ts:363` | 写 mergeStylesInto；读 unmergeStyles | 0 | IPC 已就绪，渲染层尚未消费 |
| oi_style_merge_items | 边缘 | `electron/order-db.ts:372` | 写 mergeStylesInto；读 unmergeStyles | 0 | 同上；明细用于撤销还原 |
| oi_images | 在用 | `electron/order-db.ts:409` | 写 order-image-land；读 归类核对、商品图池 | 101 | 识别结果缓存，非款色权威 |
| parcels | 在用 | `electron/order-db.ts:442` | 写 发货/寄件录入；读 利润与物流统计 | 0 | 空态正常（尚未录包裹） |
| parcel_lines | 在用 | `electron/order-db.ts:459` | 写 拆包；读 包裹明细/利润 | 0 | 同上 |
| oi_styles | 在用 | `electron/order-db.ts:473` | 写 识别建款/人工建款；读 款列表、采购/拣货汇总 | 21 | 业务字段权威在 `pl_products` |
| oi_style_colors | 在用 | `electron/order-db.ts:483` | 写 归类建款色/命名/合并；读 全款色维度 | 95 | 款色主键 |
| oi_style_fingerprints | 在用 | `electron/order-db.ts:494` | 写 人工归并款；读 自动识别匹配 | 0 | 空 = 尚未做过款归并 |
| oi_color_aliases | 在用 | `electron/order-db.ts:505` | 写 归类时指认；读 色名翻译 | 5 | 产品级对照 |
| oi_item_parts | 边缘 | `electron/order-db.ts:537` | 写 materializeItemParts（需先有套装配置）；读 itemStyleColorIds | 0 | 新套装模型，暂无 UI 写入 |
| pl_products | 在用 | `electron/product-db.ts:112` | 写 产品库编辑；读 映射/归类/成本 | 19 | 款式主数据权威 |
| pl_bundle_links | 边缘 | `electron/product-db.ts:168` | 写 product-db 的 bundle 系列方法；读 isBundleProduct/roles | 0 | 无 IPC/preload/UI，后端已就绪 |
| pl_shop_sku | 在用 | `electron/product-db.ts:984` | 写 认款/映射；读 映射队列、成本 | 48 | 认款唯一写路径 |
| pl_variants | 在用 | `electron/product-db.ts:1893` | 写 SKU 矩阵/导入；读 拣货、成本、映射反查 | 457 | 克重唯一落点 |
| pl_images | 在用 | `electron/product-db.ts:1917` | 写 产品图上传/订单图回灌；读 产品主图、图池 | 12 | 内容寻址，二进制不入库 |
| pl_item_images | 在用 | `electron/product-db.ts:1929` | 写 映射列表改图；读 图池最高优先级 | 0 | 空 = 未人工指定覆盖图 |
| pl_shop_items | 在用 | `electron/shop-item-db.ts:194` | 写 AE 店铺采集；读 商品池/映射候选 | 71 | 采集快照，不认款 |
| pl_shop_store_keys | 在用 | `electron/shop-item-db.ts:219` | 写 采集收养；读 下次采集匹配店 | 4 | 收养记忆 |
| suppliers | 在用 | `electron/purchase-db.ts:249` | 写 供应商维护；读 拿货单/对账/产品 | 6 | 与 `sk_companies` 不同实体 |
| purchase_orders | 在用 | `electron/purchase-db.ts:260` | 写 拿货编辑器；读 拿货列表/对账 | 3 | detail / pool 两模式 |
| purchase_items | 在用 | `electron/purchase-db.ts:274` | 写 拿货单保存；读 拿货明细、成本 | 13 | 与 sources 粒度不同，勿合并 |
| purchase_sources | 在用 | `electron/purchase-db.ts:292` | 写 拿货单保存（整批重写）；读 需求来源追溯 | 14 | order_item_id 为软关联 |
| payments | 在用 | `electron/purchase-db.ts:308` | 写 对账页记一笔；读 supplierBalance | 0 | 空态正常 |
| purchase_ignore | 在用 | `electron/purchase-db.ts:321` | 写 需求列表忽略/恢复；读 生成需求时过滤 | 0 | 空态正常 |
| sk_companies | 在用 | `electron/company-db.ts:200` | 写 企业管理页；读 店铺/合规归属 | 4 | 法律主体 |
| sk_company_profiles | 在用 | `electron/company-db.ts:224` | 写 企业管理页；读 合规看板/店铺详情 | 3 | 到期提醒 |
| sk_shops | 在用 | `electron/shop-db.ts:214` | 写 店铺登记/账号导入；读 归一、映射、邮件、记账 | 13 | 店铺+账号单表 |
| sk_tool_accounts | 在用 | `electron/shop-db.ts:250` | 写 工具账号维护；读 店铺引用、登录注入 | 2 | 密码只存密文 |
| sk_name_map | 在用 | `electron/shop-db.ts:267` | 写 人工归一/忽略；读 店铺匹配、供应商归一 | 11 | 只存人的决定 |
| sk_shop_sets | **已删除**（原边缘） | （历史 DDL 已移除） | 无读写 | 删除前 0 | 新库不建；`shop.main` v2 幂等清掉历史残留 |
| sk_mail_accounts | 在用 | `electron/mail-db.ts:177` | 写 账号设置/同步回写；读 同步调度、列表归属 | 3 | `shop_id` 唯一 + 级联 |
| sk_mail_messages | 在用 | `electron/mail-db.ts:204` | 写 upsertMailMessages；读 列表/检索/筛选 | 1286 | `(account,folder,uid)` 唯一 |
| sk_mail_bodies | 在用 | `electron/mail-db.ts:231` | 写 按需拉正文；读 详情、FTS 重建 | 1286 | 与消息一对一 |
| sk_mail_attachments | 在用 | `electron/mail-db.ts:241` | 写 同步引擎；读 详情/下载/内联图 | 0 | 空态正常（无附件邮件） |
| sk_mail_folders | 在用 | `electron/mail-db.ts:253` | 写 同步引擎；读 增量续拉 | 3 | 账号×文件夹游标 |
| sk_mail_attachment_cache | 在用 | `electron/mail-db.ts:267` | 写 mail-cache；读 下载命中/容量统计 | 0 | 只有下载过的附件才有行 |
| sk_mail_fts | 在用 | `electron/mail-db.ts:425` | 写 同步增量维护；读 全文检索 | 1286 | FTS5 虚表，rowid = messages.id |
| sk_mail_meta | 基础设施 | `electron/mail-db.ts:277` | 写/读 getMailMeta / setMailMeta | 1 | 内部 KV（FTS 回填游标） |
| sk_mail_fts_config | 基础设施 | SQLite 自建 | 随 `sk_mail_fts` | 1 | **FTS5 影子表，绝不能单独删** |
| sk_mail_fts_content | 基础设施 | SQLite 自建 | 随 `sk_mail_fts` | 1286 | 同上 |
| sk_mail_fts_data | 基础设施 | SQLite 自建 | 随 `sk_mail_fts` | 31 | 同上 |
| sk_mail_fts_docsize | 基础设施 | SQLite 自建 | 随 `sk_mail_fts` | 1286 | 同上 |
| sk_mail_fts_idx | 基础设施 | SQLite 自建 | 随 `sk_mail_fts` | 24 | 同上 |
| sk_schema_migrations | 基础设施 | `electron/db.ts:105` | 写 migrate()；读 migrationVersion() | 8 | 迁移记账，删了会让迁移重跑 |
| sr_rate_snapshots | 在用 | `electron/ship-rate-db.ts:38` | 写 运价表导入；读 运费/利润复算 | 1 | 按订单日期取当时那份 |
| sqlite_sequence | 基础设施（内建） | SQLite 自建 | SQLite 内部 | 34 | AUTOINCREMENT 序号 |

## 4. 建议清理清单（风险低 → 高）

> 排序原则：先看"代码是否还建/还读写"，再看"数据是否还有意义"，最后看"是否有外键/迁移依赖"。
> 审计时**未删除任何表**，以下 1–5 是当时的判断记录；其中第 1、2 两条已在同日按用户裁定执行（见 §8）。

1. **`sk_shop_sets`（风险最低）— ✅ 已执行删除**
   - 为什么：新库已不建；唯一出现处是 `LEGACY_SET_DDL`（给历史 `sk_accounts` 做临时落点）与 `shop.main` v1 迁移。运行库是 0 行空表。
   - 删前确认：① 该库是否还有"未跑完 v1 迁移"的历史账号数据（查 `sk_accounts` 是否还存在且有行）；② 备份（`sellerkit.db.bak-*`）是否可用；③ 迁移账本 `sk_schema_migrations['shop.main'] >= 1`。
   - 依赖：无外键指向它（`sk_mail_accounts` 早已改指 `sk_shops`）；无触发器。
   - 最终做法：用户确认"未正式发布、无存量库"，故**不做改名观察，直接删**；整表合并迁移一并退役（见 §8）。

2. **`bk_periods`（风险低）— ✅ 已执行删除**
   - 为什么：全仓零 SQL 读写，仅 DDL + 文档 + reset 脚本；产品明确本期不做月结（LEDGER_PLAN RK-10）。
   - 删前确认：产品是否确定近期不做"锁账/月结"；若要做，这张表是现成落点，删了要重建。
   - 依赖：无。
   - 最终做法：直接删（同样依据"未正式发布、无存量库"）；将来真做锁账时重新设计建表。

3. **`oi_style_merges` / `oi_style_merge_items`（风险中）**
   - 为什么：`mergeStylesInto` / `unmergeStyles` 实现完整，IPC（`order-style-merge-board` / `order-style-merge` / `order-style-unmerge`）与 preload 已接，但渲染层尚未消费；运行库 0 行。
   - 删前确认：款合并 UI 是否会在近期上线；若上线，这两张表是"可撤销"的唯一依据（只改键不改表会让合并不可逆）。
   - 依赖：`oi_style_merge_items.merge_id` 外键指向 `oi_style_merges`（级联）。
   - 建议：不清理；属于"功能已实现、入口未开"，不是死表。

4. **`pl_bundle_links` / `oi_item_parts`（风险中高）**
   - 为什么：都是 2026-10-28 新套装模型，后端 CRUD/读取路径已完整，缺 IPC/UI；运行库 0 行。
   - 删前确认：套装功能是否在路线图内；`pl_bundle_links` 无 IPC，但 `oi_item_parts` 已被订单行读取路径消费（`itemStyleColorIds`）。
   - 依赖：`oi_item_parts` 外键指向 `oi_order_items` 与 `oi_style_colors`；`pl_bundle_links` 无外键。
   - 建议：不清理。删 `pl_bundle_links` 会丢掉套装配置的唯一落点。

5. **不要按行数判死**：`sk_mail_attachments` / `sk_mail_attachment_cache` / `payments` / `purchase_ignore` / `parcels` / `parcel_lines` / `bk_allocation_rules` / `bk_transfers` / `oi_style_fingerprints` / `pl_item_images` 当前 0 行，都是**正常空态**（还没发生过对应的业务动作），不是无用表。

**结论：审计时没有任何一张表达到"疑似无用"标准。** 真正可谈清理的只有 `sk_shop_sets`（历史残留）与 `bk_periods`（产品未启用的留位表）——这两张已按用户裁定删除（§8）。

## 5. 注释改动

SQLite 没有 `COMMENT ON TABLE/COLUMN` 语法，DBeaver 里能看到的"表说明"实际来自 `sqlite_master.sql` 原文。
因此注释分两层写：

1. **建表语句上方的 `//` 块注释**（原有风格，说明设计取舍）——留在源码里，供读代码用。
2. **建表语句内部的 `-- 用途：…` 行**——随 `sqlite_master.sql` 一起落库，DBeaver 的 DDL/源码页能直接看到。

两层都只加注释，未改列名/类型/索引/约束，也不影响迁移幂等与执行顺序。

改动文件（11 个，覆盖 52 张在用业务表）：

| 文件 | 覆盖的表 |
| --- | --- |
| `electron/ae-db.ts` | ae_rates、ae_settle_lines |
| `electron/ledger-db.ts` | bk_parties、bk_categories、bk_entries、bk_allocations、bk_allocation_rules、bk_settlements、bk_settlement_lines、bk_transfers、bk_op_log |
| `electron/order-db.ts` | oi_orders、oi_order_items、oi_variant_keys、oi_style_merges、oi_style_merge_items、oi_images、parcels、parcel_lines、oi_styles、oi_style_colors、oi_style_fingerprints、oi_color_aliases、oi_item_parts |
| `electron/product-db.ts` | pl_products、pl_bundle_links、pl_shop_sku、pl_variants、pl_images、pl_item_images |
| `electron/purchase-db.ts` | suppliers、purchase_orders、purchase_items、purchase_sources、payments、purchase_ignore |
| `electron/shop-item-db.ts` | pl_shop_items、pl_shop_store_keys |
| `electron/shop-db.ts` | sk_shops、sk_tool_accounts、sk_name_map |
| `electron/company-db.ts` | sk_companies、sk_company_profiles |
| `electron/mail-db.ts` | sk_mail_accounts、sk_mail_messages、sk_mail_bodies、sk_mail_attachments、sk_mail_folders、sk_mail_attachment_cache、sk_mail_meta |
| `electron/ship-rate-db.ts` | sr_rate_snapshots |
| `electron/db.ts` | sk_schema_migrations |

**存量库（已解决）**：`CREATE TABLE IF NOT EXISTS` 不会重写已存在表的 `sqlite_master.sql`，所以光改源码，
DBeaver 里看到的仍是旧原文。为此另加了 `scripts/refresh-table-comments.cjs`（`npm run refresh:db-comments`）：
备份 → 建带注释的同名新表 → 搬数据 → 换名 → 重建索引 → 追平 `sqlite_sequence`，只插入一行 `-- 用途：`。
本轮已对运行库执行成功（52/52 张表），数据行数未变。

## 6. 校验

| 命令 | 结果 | 说明 |
| --- | --- | --- |
| `npx tsc -p tsconfig.electron.json --noEmit` | ✅ 通过 | 注释与删除清理都未引入类型错误 |
| `npm run db:inventory` | ✅ 53 对象（表 52 + FTS 1；业务表 50） | 清表后实测，较清理前 −2 张 |
| `npm run shop:smoke` | ✅ 全绿 | 店铺域（迁移用例已随 `shop.main` 合并迁移一并移除） |
| `npm run ledger:smoke` | ✅ 全绿 | 记账域 |
| `npm run order:smoke` | ✅ 全绿 | 订单域含款合并/拆开用例 |
| `npm run schema:smoke` | ⚠️ 1 项失败（**[H] 存量收口应把带键的老行归到款色上**） | **既有失败，与本次改动无关**：在 HEAD（暂存本次改动后）复跑同样失败。根因是 2026-10-29 的 `07aaac3 revert(order)` 撤掉了"导入即自动建款色"，而该冒烟断言未同步更新 |
| `npm run verify` / `npm run verify:docs` | ✅ 通过 | IPC 契约 / 跨域边 / 文档引用 |

未跑全量 `npm test`（vitest）：相关域冒烟已覆盖数据层；如需要可另行执行。

## 7. 原待拍板项与结果

1. `sk_shop_sets` 是否允许后续**改名观察 → 删除**？ → 用户裁定：项目未正式发布、无存量库，**直接删并清代码**。
2. `bk_periods` 保留还是删除？ → 用户裁定：**删**（本期不做月结）。
3. `oi_style_merges*`、`pl_bundle_links`、`oi_item_parts` 是否冻结？ → 未动：均有后端实现与生产读取路径，属"功能已实现、入口未开"。
4. 存量库的注释可见性问题？ → 已用 `npm run refresh:db-comments` 刷新运行库（52 张表）。

## 8. 执行记录：删除 `sk_shop_sets` 与 `bk_periods`

依据：用户明确"当前就是最新版本、还没有正式发布；按'生产代码零引用'口径，没使用就删"。

### 8.1 代码侧改动

| 文件 | 改动 |
| --- | --- |
| `electron/shop-db.ts` | 整表合并迁移（搬账号 / 归并企业 / 建工具账号 / 重建 `sk_mail_accounts`）整段退役；删除 `LEGACY_SET_DDL`、`ensureLegacySetColumns`、`materializeLegacyAccounts`、`shopSecretsOf` 等只服务该迁移的代码与未用 import；`shop.main` 现为 v1 版本占位 + v2 `DROP TABLE IF EXISTS sk_shop_sets` |
| `electron/ledger-db.ts` | 删除 `bk_periods` 建表语句；`ledger.main` 新增 v4 `DROP TABLE IF EXISTS bk_periods` |
| `scripts/shop-db-smoke.cjs` | 移除两条依赖 `sk_shop_sets` 的老库重建用例（迁移已不存在）；`shop.columns` 补列用例保留 |
| `scripts/reset-dev-data.mjs` | 清数据表清单去掉 `bk_periods` |
| `scripts/refresh-table-comments.cjs` | 用途表去掉 `sk_shop_sets` / `bk_periods` 两项 |

### 8.2 运行库执行

1. 备份：`sellerkit.db.bak-retire-20261029`（`sqlite3 .backup`）。
2. 执行前实测：`sk_shop_sets` 0 行、`bk_periods` 0 行；无外键指向两者。
3. 以 `dist/electron` 的 `ensureShopSchema()` + `ensureLedgerSchema()` 对运行库执行（`ELECTRON_RUN_AS_NODE` 模式下跑迁移）。
4. 执行后实测：两表已从 `sqlite_master` 消失；`PRAGMA foreign_key_check` 为空；
   账本 `shop.main = 2`、`ledger.main = 4`；`sqlite_master.type='table'` 由 61（含 `sqlite_sequence`）降到 59。

> 注：`shop.main` 的 v1 保留为**空步骤占位** —— 已跑过合并的开发机账本里记的是 1，跳过它才能轮到 v2。
