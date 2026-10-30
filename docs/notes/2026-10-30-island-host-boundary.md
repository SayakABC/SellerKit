# UI 岛与宿主边界：14 条结论（蒸馏自 5 篇，2026-09-30 ~ 2026-10-15）

> **蒸馏笔记**：由 5 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：
> - `git show b5df35c:docs/notes/2026-10-30-island-host-boundary.md`
> - `git show b5df35c:docs/notes/2026-10-30-island-host-boundary.md`
> - `git show b5df35c:docs/notes/2026-10-30-island-host-boundary.md`
> - `git show b5df35c:docs/notes/2026-10-30-island-host-boundary.md`
> - `git show b5df35c:docs/notes/2026-10-30-island-host-boundary.md`

## 1. 平台形态判据：岛 = 可选的加工手段；宿主 = 必经的主干与契约

**结论**：**岛 = 可选的加工手段；宿主 = 必经的主干与契约。**
判据主线一句话 —— **删掉它，"货卖出去 / 钱算清楚"的最小闭环还成立吗？** 不成立 → 内建（随包、首启可用）；成立 → 岛（按需装）。
两条副线：① 要跑**不受信/第三方**代码才需要岛；② 需要**独立发版节律**（别人维护 / 高频小改）→ 岛。
配套铁律：**能力可复用，入口必须唯一**（同一件事不允许在内建页与岛里各有一个入口）。

**为什么需要这条判据**：本项目的历史形态是"按实现缝隙切界面"（订单域/产品域/店铺域/运费域/利润域各成一个岛），
结果是**主干功能被做成了可选项** —— 新用户打开应用看到的是"便签 + 两个依赖上游的空页面"，
必须先去插件市场装东西才能干活。用户视角的代价是"我得先学会这个软件"，而这是最贵的一种缺陷。

三分法与现状判定：

| 形态 | 含义 | 本项目实例 |
| --- | --- | --- |
| ① 宿主内建 | 主干 + 契约（外壳/导航/口径层/数据必备维护） | 今天 · 订单（导入·明细·核对·拣货）· 算钱 · 设置 |
| ② 薄内建 + 重手段留岛 | 主干只需要的 20% 内建，低频重手段留岛 | 货与成本（SKU/克重/供应商基础维护内建；批量/清单导入/映射队列留岛） |
| ③ 纯岛 | 可选 / 可外部 / 低频 | 店铺账号管家 · TV模版 · AI 识别加工 · 报价单解析试算 |

**永不岛**：外壳与导航 · 主题与快捷键 · 命令面板 · 设置中心与插件中心 · IPC 与能力门 · 数据库与迁移 ·
**跨域口径层**（算钱的公式、拣货的件数口径）。岛是终端页面，不能拥有导航与契约。

**取证**（2026-09-30，只读）：

- 默认包当时只有 `quick-note` / `order-cost` / `picking`（`modules.config.json`），而这两个业务模块**都依赖 Excel 导入的订单**，
  源头「订单归类」却是市场分发的岛（`ui-plugins/order-insight`）→ 首启断链。
- **两条订单主干都在用**（本机库：`ae_orders` 101 行浏览器采集 / `oi_orders` 42 行 Excel 导入）→ 不能删任一条，
  目标是"单主干 + 双摄取适配器"。
- 三条断链都是"没导/没同步"而非模型缺失：`pl_item_weights` 0 / `ae_cost_map` 0 / `ae_settle_lines` 0
  （同时 `purchase_orders` 3、`pl_variants` 5）→ 属交互问题。
- 已定的相关决策：红线 23（岛 id 不得进构建预设）· ADR-001（**只管**"改完要立刻看预览"的映射类设置）·
  ADR-002 C1/C3（写入方唯一、主数据在宿主中立层）。

> 完整方案与待拍板清单见 `docs/plans/RESTRUCTURE_PLAN.md`（§2 多套收敛 / §5 历史坑 / §6 迁移顺序 / §7 守卫）。

**源**：`2026-09-30-plugin-vs-host-boundary`（2026-09-30）

---

## 2. 给岛加"读数据"能力：宿主只读域 + 复用渲染层纯函数，不重写口径、不新开通道

**结论**：给 UI 岛新增"读业务数据"能力时，**不要**在岛里重写聚合口径，也**不要**新开 IPC 通道 ——
在 `src/core/plugin/host.ts` 的 `DB_OPS` 里加一个**只读域**，op 内部 `await import('@/lib/...')`
复用渲染层那套纯函数（`host.ts` 跑在**渲染进程**，能直接 import `@/lib/*`），一次办完"取数 + 汇总 + 口径"。

**为什么**：岛与宿主是两套产物，口径在两边各写一份**必然漂移**（拣货单少一件就是少发一件货）。
把口径留在 `src/lib/`（已被 vitest 覆盖）并让域 op 调它，岛侧只剩渲染 ⇒ 一处口径、零新通道、零预算消耗。

**取证**：

- 现役落地实例（同一个形态，域 op 内 `await import('@/lib/…')` 复用渲染层纯函数）：
  `shipping-rate`（`quote` 系列 → `@/lib/shipRate*`）、`product`（`importProducts` → `@/lib/productImport`）、
  `excel-copy`（`applyRules` → `@/lib/fieldProcessor`）；外部契约零新增（**IPC 通道数不变**）。
- 岛侧验证链（手写岛无构建、无类型门禁）：`node --check` → 接线守卫（扫描型）→
  假桥无头冒烟（如 `npm run shipping-rate:ui`）→ 真机 `npm run plugins:island:smoke`。

> 关联：`docs/plans/PICKING_PLAN.md` §3.3（两条刻意决策与反证）、`docs/plans/UX_POLISH_PLAN.md` §2 P0/P1、
> `AGENTS.md` §1.8（域/权限门）、红线 23（岛 id 不得登记进构建预设）。

**源**：`2026-09-30-island-read-capability-pattern`（2026-09-30）

---

## 3. 【历史记录】已撤回的实例：`DB_OPS.picking.groups`，以及"守卫必须先剥注释"

**结论**：**【历史记录】**本条原来举的落地实例是 `DB_OPS.picking.groups`（P5 为 order-insight 岛的
「拣货」页签所开）。该页签同日被 **C2/M3** 判为"入口冗余"并**发布前撤回**，域与守卫一并删除
⇒ **实例换人、结论不变**。下面已改指现役实例（见 §2）；那条"守卫必须先剥注释"的踩坑仍然有效
（已固化在 `pluginTriage` 同族断言里：岛内不得自算口径，先剥注释再扫）。

**取证**：

- 已撤回的实例（留作教训）：`DB_OPS.picking.groups` → `@/lib/picking`；它的接线守卫
  `tests/orderInsightPicking.spec.ts` 曾断言**岛里不得出现** `bucketOfStatus` / `parseRowQty` /
  `settleQty` / `aggregatePicking`（口径实现只能在宿主）—— 这类断言**必须先剥注释**，
  否则命中域上方注释里那句 `await import('@/lib/picking')` 而恒绿（**变异测试**抓出来的：
  把真调用换成自算，断言照样通过）。这一形制现在的现役同族在 `pluginTriage`：运费岛的"岛内不自行套费率算式"、
  产品库/订单归类的"岛内不打包 xlsx"、多岛的"无 eval/new Function"。

**源**：`2026-09-30-island-read-capability-pattern`（2026-09-30）

---

## 4. 岛侧改任何文案/界面 = 一次完整发版

**结论**：**岛侧改任何文案/界面 = 一次完整发版**（升版本 → `publish-plugin.js` → 同步本机插件目录 → **重启宿主**）。
评估"改文案"这类小事的成本时必须按发版算，并把多个岛侧改动**攒成一批**。

**取证**：发版链条即上方括注的四步（逐步命令见 `2026-10-30-island-publish-and-retire`）；岛侧生效时点的论证见 §9。

**源**：`2026-09-30-island-read-capability-pattern`（2026-09-30）

---

## 5. 能力域 op 与"页面入口"是两件事：能力可复用，入口必须唯一

**结论**：**能力域 op 与"页面入口"是两件事**：能力可复用，**入口必须唯一**。
当时的实例是"拣货能力有两个入口" → 2026-09-30 按 **C2/M3** 定了：只留内建「拣货」页，
岛内页签删掉、连它专用的 `picking` 域也一起删（**没有消费者的能力域就是死物**）。
⇒ 反向提醒：**开一个只为一处 UI 服务的域 op 之前，先问"这个入口会不会被判冗余"** ——
会的话，宁可不做（本次是"代码写完、守卫写完、发布前撤回"，白做一轮）。

**取证**：`DB_OPS.picking` 域的撤回过程见 §3（`tests/orderInsightPicking.spec.ts` 的四条口径断言、变异测试）。

**源**：`2026-09-30-island-read-capability-pattern`（2026-09-30）

---

## 6. 宿主 op 的入参里出现整块主数据，就是"真源在调用方"的债

**结论**（2026-09-30，M6 运价表回迁落地）：**判据**：宿主 op 的入参里出现**整块主数据**（如 `quote({ table })`），就是"真源在调用方"的债 ——
不是风格问题。调用方一卸载、或两份不等，同一笔业务就会算出两个数。
ADR-002 C3 要求主数据挂宿主中立层，落到代码上就是：**这类参数必须从 op 签名里消失**，
由宿主自己取（`requireRateTable()` → 宿主快照表）。

**取证**：

- 宿主：`src/core/plugin/host.ts` 的 `latestRateSnapshot()` / `requireRateTable()`；`quote` / `quoteOrders` /
  `quoteProducts` 的表参数已移除（域内 op 6 → 8，N5 ≤10）。
- 岛：`ui-plugins/shipping-rate/dist/store.js` 的 `syncTableFromHost()`；`api.js` 三个计价函数去掉 table 形参；
  版本 1.2.1 → 1.3.0。
- 自动化：`npm run shipping-rate:ui`（新脚本）跑**两个来回** 19 项断言，其中核心一条是
  **"计价 payload 里没有 `table`"** —— 这是唯一能防住"两份真相又回来了"的机器守卫；
  另一个来回专门覆盖迁移（`rateAdopt` 带着整张表 + 来源 → 抹掉本地副本 → 渲染）。
  手写岛（`dist/` 即源码、无构建、无类型门禁）**改接线就必须补这种假桥冒烟**：错了全是静默的。

**源**：`2026-09-30-master-data-return-to-host`（2026-09-30）

---

## 7. 主数据迁移三件套，以及"读"与"写"不许共用一个 op 名

**结论**：

1. **迁移三件套**（缺一样就会挨用户骂）：
   ① **读回退一个版本期** —— 宿主还没有数据时，旧位置那份仍然被读到（不能让用户"数据凭空没了"）；
   ② **一次性 adopt** —— 由**知道旧位置的那一方**把数据交上去（本次是岛首启调 `rateAdopt`，
   宿主按内容 sha256 去重 ⇒ 幂等、重入安全）；
   ③ **抹掉本地副本** —— 迁完显式写 `null`（注意宿主侧写回是**合并**语义，省略键 = 保持不变，清不掉）。
2. **不要为省一个 op 把读和写塞进一个名字**：`rateCurrent`（读，给岛渲染）与 `rateAdopt`（写，只为迁移）
   分开命名 —— 名字里就带着"这不是稳态写入"的意思，后来人不会拿它当第二条写路径。
3. 「清空」下线：运价表成了按生效日留档的历史快照（「算钱」按订单日期取"当时那份"复算），
   "一次抹掉所有快照"的语义不再成立 —— 破坏性按钮要随数据模型的变化一起重审，别顺手照搬。

**取证**：宿主与岛两侧的改动点见 §6（`latestRateSnapshot()` / `requireRateTable()`、`syncTableFromHost()`、
版本 1.2.1 → 1.3.0）；迁移回路由 `npm run shipping-rate:ui` 的第二个来回专门覆盖。

**源**：`2026-09-30-master-data-return-to-host`（2026-09-30）

---

## 8. 删表之前先问"老表里的东西，主干里都有了吗"：回填四条纪律

**结论**（同族：`order.main` v4，2026-09-30）：老表要删（本例是采集改写主干后的 `ae_orders`/`ae_order_lines`/`ae_fees`），先问一句：
**老表里的东西，主干里都有了吗？** 本例答案是没有 —— 采集改主干只对**新单**生效，C1 之前采的 101 单
只存在于老表，而界面只读主干 ⇒ 那批单"看不见了"。**直接删表 = 真丢数据**（这类洞在数据量小的测试库上看不出来）。

回填的四条纪律（与上面的"三件套"同源，可直接照抄）：

1. **口径复用实时写入的那一组原语**（`electron/aeMoney.ts` 的收入/汇率换算 + `order-db.upsertCollectedOrder`），
   迁移里**不另写一遍算式** —— 历史数据与新数据算法不同，是"同一批单两个数"的经典来源。
2. **保真 + 可回滚**：原帧整段进 `raw_fields.采集帧`（与实时写入同一个键名），另加 `__migratedFrom='ae_orders'`
   ⇒ 要撤就按标记删这批行（`DELETE ... WHERE json_extract(raw_fields,'$."__migratedFrom"')='ae_orders'`）。
3. **老表原样保留**：回填是**加法**，删表是**另一步**（也留给人做）。回填完先让人在界面上核对数字。
4. **迁移步骤要处理"表不存在"**（house convention：迁移跑在 `dbMigrate(SCHEMA)` 之前）——
   本例：`oi_orders` 或 `ae_orders` 缺任一就整步跳过。另外**冒烟要么造出全套旧表**，要么先把版本记账到前一个版本
   （本冒烟场景 [E] 用后者：只验 v4，避免 v1 的 ALTER 打到没建全的老表上）。

**取证**：C1 之前采的 101 单、`ae_orders` 101 行见 §1 取证第 2 条（同一本机库口径）。

> 相关：`2026-09-30-plugin-vs-host-boundary`（什么该在宿主）、`2026-09-30-function-consolidation-order`（入口收编的顺序纪律）。
> 两篇均已并入本笔记，见 §1 / §9。

**源**：`2026-09-30-master-data-return-to-host`（2026-09-30）

---

## 9. 收编一个入口的顺序：宿主加法先落地，岛减法再发版

**结论**：把功能从「市场岛」收编进「宿主内建页」时，**必须先在宿主把替代入口做出来并合并，再去删岛上的那个入口**。
顺序反了会出现一个**空窗期**：宿主还没有、岛上已经没了 —— 用户当场**没有地方**做那件事。

**为什么这是硬约束（不是风格问题）**：

- 岛的改动**要经发布才生效**（改 `manifest.version` → `publish-plugin.js` → 用户本机安装 → **重启宿主**；见基线 §4 的三条共性），
  而宿主的改动**随下一次构建就到**。两者生效时点不同步，顺序就变成了正确性问题。
- 反例（本次差点踩到）：`ae-profit` 岛上第一无二的「汇率维护」（`ae_rates` upsert）。
  如果先删岛上的页签，而宿主「算钱」页还没接上汇率编辑 —— 外币订单从此**无处补汇率**，
  表现为"利润整单是空的、也找不到地方修"。
- 正确的做法（2026-09-30 实际执行）：`src/modules/order-cost/components/CostRatesSection.vue`（宿主，新增）
  先落地并被 `npm run order-profit:ui` 的 58 项断言守住，**然后**才删岛上的 `CostRatesPanel.vue` 等三个面板。

**取证**：

- 宿主新面板：`src/modules/order-cost/components/CostRatesSection.vue`（默认收起；出现"缺成本"的行时自动摊开）。
- 岛瘦身：`ui-plugins/ae-profit/` 的 `src/` **9 文件 1,776 行 → 5 文件 466 行**；`manifest.json` 1.0.2 → 1.1.0。
- 冒烟：`npm run order-profit:ui` **52 → 58 项**（新增的 6 项正是"默认收起 / 缺成本时自动展开 / 成本表值 / 改汇率真的发出 upsert / 新增币种码归一大写"）。
- 计划与状态：`docs/plans/RESTRUCTURE_PLAN.md` 的 C9 行、`docs/baseline/PROJECT_BASELINE.md` §4 岛清单。

**源**：`2026-09-30-function-consolidation-order`（2026-09-30）

---

## 10. 收编连带要一起改的四件事（漏一个就红）

**结论**：

1. **`manifest.json` 能力声明必须双向对齐**：删了页面就删 op，别留着死声明。
   `tests/pluginTriage.spec.ts` 是**双向**守卫 —— 声明了不调用（"功能凭空消失"）、调用了没声明（运行期越权），**两条都会红**。
   同批还要动 `src/api.js`（适配层）与 `package.json` 的 `version`（有 spec 断言它与 `manifest.version` 相等）。
2. **岛名要跟着功能改名**：`displayName` 还写着旧职责就是"名字在撒谎"。
   `ae-profit` 从「利润追踪（UI 岛）」改为「订单采集（UI 岛）」（它只剩接收端状态）。
3. **`storage` 命名空间会跟着退场**：岛不再声明 `storage` 后，`modules.<id>` 里的旧数据没人读写 ——
   基线 §6 的命名空间表要同步标"已退场"（**不要**顺手去 `config.json` 里删，收益为零且有风险）。
4. **删掉的面板会让引用它的文档悬空**：`npm run verify:docs` 会报出来。审查/评审类文档里的引用属**历史取证**，
   走 `scripts/check-doc-links.mjs` 的 `DELIBERATELY_MISSING` 并写清"记录的是当时状态"；**不要**把校验器改瞎。

**取证**：`ae-profit` 的 `manifest.json` 1.0.2 → 1.1.0、岛 `src/` 9 文件 1,776 行 → 5 文件 466 行；`npm run order-profit:ui` 52 → 58 项（见 §9）。

> 相关：`2026-09-30-plugin-vs-host-boundary`（什么该收编的判据）、`2026-09-30-island-read-capability-pattern`（收编后宿主页怎么复用纯函数）。
> 两篇均已并入本笔记，见 §1 / §2。

**源**：`2026-09-30-function-consolidation-order`（2026-09-30）

---

## 11. 回迁宿主后，"串不起来"的风险不在界面层，而在主进程 db 模块 + IPC handler 编排层

**结论**：UI 岛回迁宿主后，"功能之间串不起来"的风险已不在界面层，而在**主进程的 db 模块 + IPC handler 编排层**。
全仓 35 张表分属 11 个建表文件（10 个业务域 + `db.ts` 的控制表 `sk_schema_migrations`）；跨域读写**只有 3 条合法边**（采集写入、成本同步、拿货带图），
且订单域（`oi_*`）是 fan-in 最高的枢纽。

**取证**（域清单，db 模块 → 表）：

| 域 | db 文件 | 表 |
| -- | -- | -- |
| 产品库 | product-db | pl_products, pl_shop_sku, pl_variants, pl_images, pl_item_images |
| 店铺登记 | shop-accounts-db | sk_shop_sets |
| 公司 | company-db | sk_companies, sk_company_profiles |
| 平台商品 | shop-item-db | pl_shop_items |
| 店铺/店名归一 | shop-db | sk_shops, sk_name_map |
| 邮箱 | mail-db | sk_mail_accounts, sk_mail_messages, sk_mail_bodies, sk_mail_attachments, sk_mail_folders, sk_mail_attachment_cache, sk_mail_meta |
| 速卖通/算钱 | ae-db | ae_cost_map, ae_rates, ae_settle_lines（⚠️ `ae_orders` / `ae_order_lines` / `ae_fees` 三张弃表已于 2026-10-15 随 `ae.main` v3 删除） |
| 拿货 | purchase-db | suppliers, purchase_orders, purchase_items, purchase_sources, payments, purchase_ignore |
| 运价 | ship-rate-db | sr_rate_snapshots |
| 订单识别 | order-db | oi_orders, oi_images, oi_styles, oi_style_colors, oi_style_fingerprints, oi_queue |
| 控制 | db | sk_schema_migrations |

取证：`electron/*.ts` 的 `CREATE TABLE IF NOT EXISTS` 全文抽取，35 张表覆盖上述 11 个建表文件（picking-db 无自建表，复用 order-db）。
⚠️ 本清单**不含** FTS5 虚拟表 `sk_mail_fts` 与真实库里的 5 张 FTS 影子表 / `sqlite_sequence`（口径见 `docs/baseline/PROJECT_BASELINE.md` §「SQLite」）。

宿主模块 → IPC 通道 → 数据域（读/写）：

| 模块 | 通道数 | 主要消费域 | 关键通道 |
| -- | -- | -- | -- |
| goods（产品库） | 50 | 产品库 D1、平台商品 D4、店铺 D5、拿货厂商 D8、成本 D7 | productList/Upsert/Import、shopItem*、shopProductRelation*、purchaseSupplier*、aeCostMapList、orderImage*、productImage* |
| shop-accounts（店铺/账号/公司/邮箱） | 48 | 店铺登记 D2、公司 D3、邮箱 D6、店铺 D5、成本 D7 | company*、mail*、shopAccount*、shopUpsert、aeCostMapUpsert/DeleteManual、productList、aeRateList |
| today（今天/首页） | 36 | 订单 D10、拿货 D8、运价 D9、成本 D7 | order*、pickingRows、purchase*、shipRateSnapshotCalc、purchaseStyleImages、aeCostMapList |
| order-cost（算钱/利润） | 8 | 成本 D7、汇率 D7、订单 D10、运价 D9、店铺 D5 | aeCostMapList、aeRateList、orderAssignShop、orderShippingRows、settleOrders、shipRateSnapshotCalc、shopDbEnsure、shopList |
| picking（拣货） | 9 | 成本 D7、订单 D10、拿货 D8、店铺 D5 | aeCostMapList、orderImageThumbBatch、pickingRows、purchaseIgnoreList、purchaseOutstanding、settleOrders、shopList |
| quick-note | 0 | — | （独立，无 db 通道） |

取证：`src/modules/<m>/**` 抽取 `import {…} from '…services/ipc'` 与 `ipc.<x>`，按模块去重计数。

**源**：`2026-10-15-host-data-dependencies`（2026-10-15）

---

## 12. 跨域依赖边 A–G：合法边只有三条，其余是编排层与渲染层组合

**结论**：域与域之间 SQL 只在各自 `*-db` 内自洽；跨域访问只经三条路径：(a) 主进程编排层直接调别域 db 函数，
(b) IPC handler 调别域 db 函数，(c) 渲染层经 IPC 把多域结果在界面组合。

**取证**：

**边 A — 采集写入（ae-db ⇒ order-db，跨域写）**
`ae-db.upsertOrderBatch`（ae-db.ts:760）先读 `ae_rates`（:765，原币→CNY 折算），再调 `order-db.upsertCollectedOrder`
写 `oi_orders`。触发方 `ae-receiver.ts:152`。order-db.ts:1579 注释明说："汇率属 ae 域，让 order-db 读别的域就是跨域耦合，
所以由 ae-db 负责折算"。→ 算钱域拥有折算逻辑、落库在订单域。

**边 B — 拿货→成本同步（purchase-db ⇒ ae-db，mandated convergence）**
`purchase-cost-sync.syncPurchaseCosts()` 在每次拿货写操作后置触发（`purchase-handlers.ts:25` 的 `withCostSync` 包裹）。
读 `purchase-db.costSnapshot()`（purchase_orders + purchase_items）→ 写 `ae_cost_map`（source='purchase'，经 `ae-db.costMapReplace`）。
这是 ADR-002 规定的**唯一跨域合流点**。幂等：只清 source='purchase' 再重写，手工价（source='manual'）不受影响。
失败 `try/catch` 不影响落账，但利润缺成本 → 首页卡显示"缺成本 N 行"作可见信号。

**边 C — 拿货带图（purchase-handlers ⇒ order-db，跨域读）**
`purchase-style-images`（purchase-handlers.ts:304）→ `order-db.findStyleColorImagePath`（order-db.ts:934），
读 `oi_styles JOIN oi_style_colors JOIN oi_images`（+ 子查询 oi_orders 按 size 匹配）。
即"拿货单带图/明细图"依赖订单域的识别结果（款色→图）。跨 handler 直接 `require` 另一 db 模块。

**边 D — 订单归属店铺（order ⇒ shop，弱耦合）**
`order-assign-shop`（order-handlers.ts:169）→ `order-db.assignShopToOrders`（order-db.ts:1559）只写 `oi_orders.shop`（**原文**）。
店名归一（shopName.ts 纯函数，零 DB）构建 `sk_name_map`/`sk_shops`，由 shop 模块 `shopMap` 拥有。
oi_orders.shop 与 sk_* 是两套表示，对账靠人工 `shopMap`，非自动。

**边 E — 利润/算账汇聚（多域 ⇒ 渲染层组合）**
`settleOrders`（ae-handlers.ts:166）读 `ae_settle_lines`；`aeCostMapList`（→ae-db.costMapList:1053）读 `ae_cost_map`；
`aeRateList`（→ae-db:1068）读 `ae_rates`；`shipRateSnapshotCalc`（ship-rate-handlers.ts:56）读 `sr_rate_snapshots`。
利润 = ae_cost_map + ae_rates + ae_settle_lines + sr_rate_snapshots + oi_orders.amount，在 order-cost/today 渲染层组合（不在主进程合一）。

**边 F — 识别中枢（oi_* 为单源）**
oi_styles/oi_style_colors/oi_images/oi_style_fingerprints 由订单识别管线（collect + import + VLM）写入，被多模块读：
goods（orderReadImage/productImageAttach）、purchase（purchase-style-images 带图）、today（orderImageThumbBatch 缩略图卡）、order-cost（orderShippingRows/orderStyleList）。款色→图只此一份。

**边 G — 产品主数据（pl_* ↔ 订单/识别）**
goods 拥有 pl_products/pl_shop_sku/pl_variants/pl_images/pl_item_images + pl_shop_items；订单识别挂 style_code 到 oi_styles，
产品库反向维护款色主数据。goods 的 `shopProductRelationAdd` 写 pl_shop_sku，与店铺域 D5 有交叉写入。

**源**：`2026-10-15-host-data-dependencies`（2026-10-15）

---

## 13. 跨域边的五个风险，以及"独立 ts 上下文"这条旧判据已经被推翻并处置

**结论**：

1. **订单域（oi_*）fan-in 最高**：写方=ae-receiver（经 ae-db），读方=goods/purchase/today/order-cost。
   改 `oi_*` schema 或 `findStyleColorImagePath`/`upsertCollectedOrder` 前，先查这 4 个模块的断言覆盖。
2. **合法跨域边仅 3 条**（A 采集、B 成本同步、C 拿货带图），且 A/B 收在主进程编排/接收层，UI 不参与（符合 ADR-002 C1/C3）。
3. **`ae_cost_map` 有两条写者**：syncPurchaseCosts（auto, source='purchase'）+ 手工 upsert（shop-accounts/order-cost, source='manual'）。
   costMapReplace 只清 purchase 分支→手工价安全；但"成本数字"有两个真相入口，对账时要先看 source。
4. **店铺身份两套表示**：oi_orders.shop（原文）vs sk_shops/sk_name_map（规范）。自动归属只写原文，规范映射靠人工 shopMap。
   oi_orders.shop 为空不一定是 bug，是还没归——这是"默认值靠语义不靠位置"的活例。
5. **成本同步是 fire-and-forget**（`withCostSync` try/catch）。历史 bug（purchase 有 3 单、cost_map 0 行）根因正是缺自动触发；
   现已补自动触发 + 首页"缺成本"卡，但仍是异步耦合，失败静默（仅日志 + 卡提示）。

**【历史记录】已被推翻的旧判据**：原判据称边 C 是 handler 直接 `require` 另一 db 模块，"若 `findStyleColorImagePath` 签名变，purchase-handlers 不会即时编译报错（**独立 ts 上下文**），
建议把 C 也显式登记为受控合流点（与 A/B 同列）"。
⇒ **✅ 2026-10-15 已处置，且原判据里有一处是错的**：`purchase-handlers.ts` **不是**独立 ts 上下文，
它与 `order-db.ts` 同在 `tsconfig.electron.json` 里（`include: electron/**/*.ts`）——
真正让签名变更漏过去的是 **`const orderDb = require('./order-db')` 没带 `as typeof import(...)`**（`any`）。
现已补标注（实测：改 `findStyleColorImagePath` 的 `color: string→number`，改前 `tsc` 退 0、改后报 TS2345），
并新增守卫 `scripts/check-cross-domain-edges.mjs` 接进 `verify`：**规则 A** 所有 `require('*-db')` 必带类型标注；
**规则 B** `db→db` 静态 import 边逐条在册（含取用符号）。处置明细见
`docs/notes/2026-10-30-db-schema-and-migration.md` §二 P1-4。

**取证**：边 A–G 的行号与调用点见 §12；TS2345 的改前/改后实测即上方括注。

**源**：`2026-10-15-host-data-dependencies`（2026-10-15）

---

## 14. 改前自查清单（给下次动刀用）

**结论**：

- 动 `oi_*`：跑 goods/today/picking/order-cost 四类断言 + `findStyleColorImagePath` 变异。
- 动 `ae_cost_map`：分清 auto/manual 两写者；动 costMapReplace 要看 manual 分支是否被误清。
- 动 `shopName`/`sk_name_map`：影响 order-assign-shop 的归属语义与 shopMap 对账。
- 新增跨域读：先问"能不能收进 A/B/C 之一"，不能就登记为新受控合流点。
  ⚠️ **2026-10-15 起这件事由门禁兜住**：`npm run verify` 的第③条（`scripts/check-cross-domain-edges.mjs`）
  会拦"未登记的 `db→db` 边"与"没带 `as typeof import(...)` 的 `require('*-db')`"；
  在册清单是脚本里的 `DB_EDGES`（含每条边从对方取用的符号），改边**先改清单再改代码**。

**取证**：门禁脚本与规则 A/B 的来历见 §13 的【历史记录】段（`tsconfig.electron.json` 的 `include: electron/**/*.ts`、TS2345 实测）。

**源**：`2026-10-15-host-data-dependencies`（2026-10-15）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-09-30-plugin-vs-host-boundary.md` | 2026-09-30 | §1 |
| `2026-09-30-island-read-capability-pattern.md` | 2026-09-30 | §2 / §3 / §4 / §5 |
| `2026-09-30-master-data-return-to-host.md` | 2026-09-30 | §6 / §7 / §8 |
| `2026-10-15-host-data-dependencies.md` | 2026-10-15 | §11 / §12 / §13 / §14 |
| `2026-09-30-function-consolidation-order.md` | 2026-09-30 | §9 / §10 |
