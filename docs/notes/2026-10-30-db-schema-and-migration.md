# 数据库表结构与迁移：23 条结论（蒸馏自 4 篇，2026-09-30 ~ 2026-10-29）

> **蒸馏笔记**：由 4 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/<原文件名>`

## 1. 父表**有外键子表**时，不要用 `rename → create → drop` 套路

**结论**：给存量 SQLite 表做结构手术时，有三处**不报错但会丢东西**的地方（本条是其一）。

`oi_styles` 被 `oi_style_colors.style_id REFERENCES oi_styles(id) ON DELETE CASCADE` 引用。
若按"rename → 建新表 → 拷数据 → drop 旧表"重建：`DROP TABLE oi_styles_legacy` 会**连带级联删掉子表数据**（子表的外键指向的是那张被改名的表）。
⇒ 子表在引用时，**优先用 `ALTER TABLE … DROP COLUMN`**（SQLite ≥3.35，本项目内置 3.53）—— 它不发 FK 事件。
只有在**必须改约束**（如 `NOT NULL` → 可空）时才重建，且要确认该表**没有被别的表引用**（`oi_orders` 没有子表 ✓，重建安全）。

**取证**：`electron/order-db.ts` 的 `migrateOrderSpine()`（v3）：① 交接前置、② 重建 `oi_orders`（`image_id` 可空 + `source`/`qty`）、
③ `oi_styles` 走 `DROP COLUMN`、④ 追平 `sqlite_sequence`。

**源**：`2026-09-30-table-rebuild-traps`（2026-09-30）

---

## 2. 重建表会**重置 `sqlite_sequence`** → 下一笔插入撞主键

**结论**：`AUTOINCREMENT` 的行号记账挂在 `sqlite_sequence` 上；旧表被 drop 时它的记账行随之消失，新表记账从 0 开始。
显式插入历史 id **不会**推进记账 ⇒ 下一笔 `INSERT` 会从 1 开始，直接撞已有主键。
⇒ 重建事务末尾必须追平：`UPDATE sqlite_sequence SET seq = MAX(id) WHERE name = ?`，没有记账行时 `INSERT` 一行
（`sqlite_sequence` **没有主键**，不能写 `ON CONFLICT`——本项目更早踩过同一坑）。

**取证**：`scripts/schema-migration-smoke.cjs` 场景 [C]：六条断言——记账到 3 · 主干形状（含 8 列已删）· `image_id` 可空能落库 ·
**款式名已进 `pl_products` 且 `oi_styles.name` 已删** · 老行 `source='import'`/`qty=NULL`/金额 NULL · **新插入 id > 历史最大 id**（行号已追平）· 数据一条不丢。

同一手法在 2026-10-29 的注释刷新脚本里复用：`scripts/refresh-table-comments.cjs` 的流程是"备份 → 建带注释的同名新表 → 搬数据 → 换名 → 重建索引 → 追平 `sqlite_sequence`"。

**源**：`2026-09-30-table-rebuild-traps`（2026-09-30）· 补充取证来自 `2026-10-29-db-table-audit`（2026-10-29）

---

## 3. 迁移里做"数据交接"时，**先自己保证目标表存在**

**结论**：`oi_orders` 的 v3 迁移里要把 `oi_styles.name` 交接进 `pl_products` 再删列，但本迁移跑在
`ensureOrderSchema()` 的 `ensureProductSchema()` **之前** —— 老库（订单域早于产品域）此时**还没有 `pl_products`**，
于是"交接被跳过、列却照删"⇒ **历史款名静默丢失**。
⇒ 交接类步骤要自己把目标表建起来（调幂等的 `ensureProductSchema()`），不要假设外层已经建好。

**取证**：`scripts/schema-migration-smoke.cjs` 场景 [C] 的断言"**款式名已进 `pl_products` 且 `oi_styles.name` 已删**"就是这条的判据。
同类纪律见 `AGENTS.md` §1.4「schema 演进必须走版本化迁移」与技能 `sellerkit-host-schema-migration`。

**源**：`2026-09-30-table-rebuild-traps`（2026-09-30）

---

## 4. 全库是**一个** `sellerkit.db`，"跨域"只是代码归属边界；39 个对象靠**写入/读取点普查**定生死

**结论**：所有域共用同一个 `sellerkit.db`（`db.ts` 单例 `initDb()`，FK ON + WAL），"跨域"是代码归属边界而非物理分库。
审查对象为 `electron/*-db.ts` 内 38 张实体表 + 1 张 FTS 虚拟表（`sk_mail_fts`），共 39 个对象。
方法：先抓全量 DDL，再对每张表做**全仓库写入点 / 读取点普查**（electron + src + scripts），以"是否有写入"判定死表、以"列族重叠 + 业务基数"判定可合并。

逐域结论（39 个对象）：

| 域 | 表 | 写入 | 读取 | 判定 |
|----|----|----|----|------|
| **订单主干 oi_\*** | `oi_orders`(22列枢纽) / `oi_images` / `oi_styles` / `oi_style_colors` / `oi_style_fingerprints` / `oi_queue` | 均 ≥2 | 均 ≥3 | ✅ 全部必要，设计合理 |
| **AE 原始 ae_\*** | `ae_cost_map` / `ae_rates` / `ae_settle_lines` | 各 ≥1 | 各 ≥5 | ✅ 必要 |
| | `ae_orders` | **0** | 6 | ❌ **死表（零写入）→ ✅ 2026-10-15 已删** |
| | `ae_order_lines` | **0** | 3 | ❌ **死表 → ✅ 已删** |
| | `ae_fees` | **0** | 3 | ❌ **死表 → ✅ 已删** |
| **拿货 purchase_\*** | `suppliers` / `purchase_orders` / `purchase_items` / `purchase_sources` / `payments` / `purchase_ignore` | 均 ≥1 | 均 ≥2 | ✅ 必要（见合并候选） |
| **商品 pl_\*** | `pl_products` / `pl_shop_sku` / `pl_variants` / `pl_images` / `pl_item_images` / `pl_shop_items` | 均 ≥1 | 均 ≥2 | ✅ 必要（见合并候选） |
| **店铺/账号 sk_\*** | `sk_shop_sets` / `sk_shops` / `sk_name_map` / `sk_companies` / `sk_company_profiles` / `sk_schema_migrations` | 均 ≥1 | 均 ≥1 | ✅ 必要 |
| **邮件 sk_mail_\*** | `sk_mail_accounts` / `_messages` / `_bodies` / `_attachments` / `_folders` / `_attachment_cache` / `_meta` / `_fts`(FTS) | 均 ≥1 | 多 | ✅ 完整邮件系统，必要（`_meta` 1 列 KV、`_bodies` 拆大文本是常规优化） |
| **运费 sr_\*** | `sr_rate_snapshots` | 1 | 3 | ✅ 必要 |
| **迁移** | `sk_schema_migrations` | 1 | 1 | ✅ 必要（迁移版本锁） |

**取证**：审查口径与计数 —— 39 个对象；P0 删表后**权威计数随之从 39 个对象降为 36**（33 业务表 + 2 内部表 + 1 FTS），逐项以 `docs/baseline/PROJECT_BASELINE.md` §「SQLite」为准。
2026-10-29 更完整的一轮运行库审计见 §16–§20（60 表 → 58 表；新库 53 个对象 = 表 52 + FTS 1）。

**【历史记录】** 本节表格里的 39 对象口径、以及含 `ae_orders` / `ae_order_lines` / `ae_fees` / `sk_shop_sets` 的名单，已被后续两轮删除改写；原表照抄保留。

**源**：`2026-10-15-table-necessity-review`（2026-10-15）

---

## 5. 【历史记录】`ae_orders` / `ae_order_lines` / `ae_fees` 是"只建不写"的孤儿库（已删）

**结论**：全仓库（electron+src+scripts）三表写入点 = **0**；读取方仍在跑。根因是 C1 合并把 AE 采集入口 `upsertOrderBatch`（ae-db.ts:760）改写到 `oi_orders`，但**旧的 `ae_orders` 三表及其读取方没跟着迁走** ⇒ AE 采集合单列表与 AE 汇总读的是空/陈旧数据；利润引擎 `ae-engine` 的成本归因链路（`ae_order_lines`）也是空。
**处置（2026-10-15，方案 1「废弃路径」，用户裁定"直接删表"）**：三张弃表 + 整条死代码链已删。

**取证**（证据链，原文行号）：
- `ae-db.listOrders`（ae-db.ts:858）读 `ae_orders`/`ae_order_lines` → 经 `ae-handlers:47` → IPC `aeOrderList` → `src/core/plugin/host.ts:239`；
- `ae-db.getAeSummary`（ae-db.ts:887）读 `ae_orders`/`ae_fees`；
- `ae-engine.ts:149/161/171` 只读 `ae_orders`/`ae_order_lines`/`ae_fees` 做**利润计算**（行经 `ae_order_lines.style_code ↔ ae_cost_map` 命中成本）；
- 根因注释：`order-db.ts:208`「`oi_orders` 是唯一订单主干，两条摄取通道都写它」。

**处置记录（2026-10-15，方案 1「废弃路径」）**：
- **前置确认**：三个通道**零存活消费者** —— 宿主「算钱」用的是 `aeCostMapList` / `aeRateList`（利润在渲染层 `src/lib/orderCost.ts` 组合）；ae-profit 岛的 manifest 只剩 `ensure` + `receiverStatus`（C9 收编时岛侧 op 已删）。
- **删了什么**：
  - **表**：`ae_orders` / `ae_order_lines` / `ae_fees` —— 走 **`ae.main` v3** 版本化迁移（`dropLegacyOrderTables`），存量库残留数据（本机实测 101 单采集历史）按用户裁定**直接丢弃**；建表语句同时从 `ae-db.ts` 的 `SCHEMA` 删除。
  - **引擎**：`electron/ae-engine.ts` 整文件删（378 行，唯一消费者是「利润统计」页，早随 C9 并入宿主）。
  - **读口**：`ae-db.listOrders` / `getAeSummary`（及 `mapOrderRow` / `fetchFeesByOrderIds` / `ORDER_COLS`）。
  - **IPC 三段**：`ae-order-list` / `ae-summary` / `ae-profit-stats` —— 四处契约同步删（handlers + preload + `src/types.ts` + `src/core/services/ipc.ts`），`src/core/plugin/host.ts` 的 `ae:` 域包装同步删。
  - **顺带清掉的死配置**：`shop-db.ts` 的 `SHOP_NAME_SOURCES` 原第三源 `{id:'ae', table:'ae_orders', column:'shop_name'}`（表删了它就成了死登记）；`scripts/reset-dev-data.mjs` 清空清单里的三张表名。
  - **口径文案跟着改**：店铺登记页那句用户可见的"订单 / 采购 / **利润**三处的历史文本实时汇总"改为"订单 / 采购**两处**"，`shop-db.ts` / `types.ts` / `ipc.ts` / `preload.ts` / `main.ts` / `shopApi.ts` / `MasterDataView.vue` / `shop-product-db.ts` / `shop-handlers.ts` 里同口径的注释一并改（**"三处文本"是这次删表的直接后果，不改就成了假文档**）。
- **未做的（刻意）**：`order.main` v4 的历史回填**保留原样**（只做加法、不删表）——它是"老库可能还有数据"的兜底；对本机那份库，v4 早已记账完成且三表数据无 `order_no` 与 `oi_orders` 重叠，回填与否都看不见（实测）。
- **验证**：`tsc` / `vue-tsc` / `verify` / `verify:docs` / `build` / `vitest`（692）全绿；`ae:smoke` 25/25、`shop:smoke` 35/35、`schema:smoke` 37/37（场景 D 改为兼测 v3 删表）。

**源**：`2026-10-15-table-necessity-review`（2026-10-15）

---

## 6. 【历史记录】双订单库并存是本次最刺眼的反模式（已消除）

**结论**：`oi_orders`（活）与 `ae_orders` 三表（死）并存，C1「单一主干」理念没贯彻到底。**→ ✅ 2026-10-15 已随 P0 消除（死表已删）。**

**取证**：`order-db.ts:208` 注释「`oi_orders` 是唯一订单主干，两条摄取通道都写它」；删表流水见 §5 处置记录。

**源**：`2026-10-15-table-necessity-review`（2026-10-15）

---

## 7. 【历史记录】`oi_orders` 动态拼接列不透明 → 抽 `ORDER_BASE_COLS` + 导出 `ORDER_TABLE_COLUMNS` + smoke 场景 [G]

**结论**：`oi_orders` 列由 `ORDER_MONEY_COLS`/`ORDER_SPINE_COLS`（order-db.ts:197/212）拼接，列定义不在建表字面量里，新人不直读；靠 `migrateOrderSpine`（:451）兜底补列。可用但易漏。**→ ✅ 2026-10-15 已处置。**

**处置记录 P1-2（2026-10-15，把"拼接结果"变成可直读、可断言的一份）**：
- **先厘清风险边界**：拼数组这件事本身**已经**防住了最大的坑 —— 金额列/主干列要**同时**服务「新库建表」与「老库 `ALTER` 补列」（`addOrderMoneyColumns`），写成两份字面量必然漂移，共用一份数组是对的。真正缺的是两件事：① **可读性**：列序只存在于运行时，读代码要自己在脑子里展开三个 spread；② **新库建表这条路上没有任何断言**：`ALTER` 补列那条路由 `schema:smoke` 的列存在性断言看着，而"模板里少写一个 `${}` / 往字面量里手加一列却没进数组"没有任何判据能发现。
- **做了什么**：
  - `electron/order-db.ts`：把原先**硬写在模板里的 13 个基础列**抽成 `ORDER_BASE_COLS`，建表模板改为**三份数组统一拼接**（改列只改数组）；
  - 新增导出 **`ORDER_TABLE_COLUMNS`** —— 由同一批数组推出的**解析后列序**（含尾部 `created_at`）。它**不是第二份清单**（改数组它自动跟着变），存在的意义是让"拼接结果"成为可断言对象；
  - `scripts/schema-migration-smoke.cjs` 新增**场景 [G]**：新建干净库 → `ensureOrderSchema()` → `PRAGMA table_info(oi_orders)` 的列序与 `ORDER_TABLE_COLUMNS` **逐列相等**；并带一条非空转守卫（清单条数 `>= 20`，防止清单被清空后那条反而恒绿）。
- **刻意没做**：**不在启动时做自校验** —— 启动期检查既改不了形状（`CREATE TABLE IF NOT EXISTS` 对老表一个字不改）又只会往日志里加噪声；"断言拼接结果"这件事的落点是**测试**，不是运行时。
- **验证（含变异复核）**：`schema:smoke` 37 → **38 项 / 7 场景**（新增 [G]）；① 模板丢掉一段 `${}` ⇒ 红（连带 [C] 的老库重建断言也红）；② **只**往模板字面量里手加一列（未进数组）⇒ **只有 [G] 红**（证明 [G] 就是盯这件事的那条）；③ 重建后 `SELECT sql FROM sqlite_master` 与改动前**逐字相同**（列序未变，位置参数 INSERT 不受影响）。

**源**：`2026-10-15-table-necessity-review`（2026-10-15）

---

## 8. 【历史记录】缺汇率静默丢金额：判据是 `amount_cents IS NULL`，**不能**盖 `biz_status`

**结论**：`upsertOrderBatch`（ae-db.ts）`rate ? toCentsCny(...) : null` —— 缺汇率时 `amount_cents=NULL`，部分订单金额为空且**入站回执只说 `ok:true`**。
⚠️ **"缺汇率时标记 `biz_status='rate_missing'`"这条建议已被推翻**：`biz_status` 有下游读者（`src/lib/orderCost.ts:187 bucketOfStatus` 按它分桶 → 利润/拣货的完成/在途/关闭归类），覆盖它会把真实平台状态吞掉、让订单落进 `unknown` 桶 —— 这是**真回归**，不是"加个标记"。
**→ ✅ 2026-10-15 已按正确做法处置。**

**处置记录 P1-3（2026-10-15，正确答案）**：
- **判据来源**：对 `collect` 通道，`amount_cents IS NULL` **⟺ 缺汇率**（`upsertOrderBatch` 只在一处生成金额：`rate = 本币 ? 1 : (ae_rates 查不到 ? 0 : 汇率)`，只有"非本币且无汇率"才落 NULL）—— 这是一条**精确**判据，不需要新列、也不需要动 `biz_status`。
- **改了什么（三处，各治一个症状）**：
  1. **入站不再静默**：`upsertOrderBatch` 回执新增 `rateMissing`（本批因缺汇率落 NULL 的单数）；`ae-receiver.ts` 的 `/ae/ingest` 响应带上它，并记进 `AeReceiverStatus.lastRateMissing`。至此扩展/界面能说出"这批 N 单缺汇率"，而不是只知道 `ok:true`。
  2. **界面把两档拆开**：`src/lib/orderCost.ts` 新增缺口 `fx`（缺汇率），按 `source` 分流 —— `collect` + 金额 null ⇒ `fx`（**去补一条汇率、重推即可**）；`import` + 金额 null ⇒ `revenue`（报表里就没有，无处可补）。「算钱」页缺口行新增「缺汇率」chip（沿用 2026-10-11 的**点 chip 即筛行**入口，缺项本身就是入口）。
  3. **契约同步**：`src/types.ts` 的 `AeReceiverStatus` 加 `lastRateMissing`（`electron/ae-receiver.ts` 同构）。
- **刻意没做**：① 不覆盖 `biz_status`（原因见上）；② 不把金额写 0（0 = "确实是 0"，`null` = "算不出来"，混起来会把"缺收入"伪装成"收入为零"）；③ 不因 `skipped` 计入 `rateMissing`（坏帧与算不出钱的单处置办法不同，别混成一数）。
- **验证**：`vitest`（新增 `fx` / `revenue` 分流用例，**两输入只差 `source`**，非空转）· `ae:smoke` 25/25（同一断言里造 CNY / USD / JPY 三个输入，计数必须给出不同值）· `order-profit:ui` 88 → **91**（+3：缺口 chip / 该行文案 / 金额格）。
- **变异复核（都实测判红）**：① 关掉 `rateMissing` 自增 ⇒ `ae:smoke` 红；② 改成"每单都计数" ⇒ 同一断言红；③ 去掉 `source` 分流（两档并成 `revenue`）⇒ `vitest` 红。

**源**：`2026-10-15-table-necessity-review`（2026-10-15）

---

## 9. 【历史记录】跨域引用：静态 import 不必改，**不带类型标注的跨文件 `require`** 才是真缺陷

**结论**：原判断"跨域写未收口"有两处形态不同 —— `ae-db → order-db` 是**静态 import**（本就在类型检查里，且是 C1 刻意的单函数 seam），真缺陷在 `purchase-handlers` 那种**跨文件 `require` 不带 `as typeof import(...)`** ⇒ 跨域签名改了编译期零报错。**→ ✅ 2026-10-15 已处置。**

**处置记录 P1-4（2026-10-15）：跨域引用要么被编译期看住，要么被显式登记**
- **先复核原判据，两处结论不同**（"先实证再动手"，别照抄审查结论）：
  - `ae-db.ts:38` 的 `import { upsertCollectedOrder } from './order-db'` 是**同一 ts 项目里的静态 import** ⇒ **本来就在类型检查里**（实测：改 `upsertCollectedOrder` 的参数类型，`ae-db` 立刻 TS2345）。它也是 C1 刻意的方向（`order-db.ts` 的注释写明"汇率属 ae 域，让 order-db 读别的域才是跨域耦合，所以由 ae-db 折算"），形态是**单一具名函数**。**结论：不需要改**（改了只是把 import 挪个位置）。
  - 真缺陷在 `purchase-handlers.ts` 的 `const orderDb = require('./order-db')` —— **不带类型标注的跨文件 require 就是 `any`**。实测（改前）：把 `order-db.findStyleColorImagePath` 的 `color` 由 `string` 改成 `number`，两处调用照传 string，`tsc -p tsconfig.electron.json` **退 0、零报错**；改后同一次探针报 `TS2345: Argument of type 'string' is not assignable to parameter of type 'number'`（`purchase-handlers.ts:394`）。
- **改了什么（3 处补类型标注 + 被照出来的 4 处旧签名不匹配）**：
  1. `order-handlers.ts:16` / `purchase-handlers.ts:10,300` 三处 `require('./x-db')` 补 `as typeof import('./x-db')`（擦除后无运行时开销；同文件对 `./xlsx-image` / `./ipc-util` 早就是这么写的，属补齐惯例）。
  2. ⚠️ **补上标注后 tsc 立刻报出 4 处此前被 `any` 掩盖的签名不匹配**（这才是"收口"的真正产出）：
     - `order-handlers.ts` 的 `order-insert`：`payload.imageId` 是 `unknown`，原来经 `hasImage` 布尔中转**收不窄**（TS 不能用排除法收窄 `unknown`）⇒ 改为**类型谓词** `isOrderImageId(v): v is number | null`；顺带把 `isPlainObject(payload)` 提到最前（原来 `payload` 为 null 时 `payload.imageId` 会抛，兜底成了异常而不是 `{success:false}`）。
     - `order-handlers.ts` 的 `order-queue-list`：`status` 用 `[...].includes(s) ? s : undefined`，`includes` **不收窄** `s` ⇒ 与 `OrderQueueStatus | 'all'` 不符。改为类型谓词 `isQueueStatusFilter`（不用 `as`）。
     - `purchase-handlers.ts` 两处明细：`sanitizeItems` 不产出 `amountCents`，而 `PurchaseItem` 要求它 —— 真相是 **`amountCents` 是派生列**（`insertItems` 里 `amount_cents = qty × priceCents` 现算），写侧**本来就不该**给。新增 `PurchaseItemInput = Omit<PurchaseItem, 'id' | 'amountCents'>` 用在 `createPurchaseOrder` / `updatePurchaseOrder` / `insertItems` / `computeTotal` / `autoSourceRows`（读侧 `loadItems` / `PurchaseOrder.items` 仍是完整 `PurchaseItem`）—— ⚠️ 这与渲染层 `src/modules/today/purchase.ts:58` 早已存在的同名同义类型**对齐**，不是新发明。
- **新增守卫 `scripts/check-cross-domain-edges.mjs`**（接进 `npm run verify` 第③条），两条规则：
  - **A**：`electron/` 内所有 `require('<路径>-db')` 必须带 `as typeof import(<同路径>)`（**同路径**也要查：写 `import('./other-db')` 等于没查）。只扫 `*-db`：那一层才是"签名改了会静默错查"的；`main.ts` 的 `require('./order-handlers')` 是**只为注册副作用**的裸调用，没有 API 要查。
  - **B**：`*-db.ts` 之间的静态 import 边必须**逐条在册**（`DB_EDGES`，6 条，含**从对方取用的符号**）。不写死"用途说明"文字而是比对符号清单 —— 用途悄悄变了（多 import 一个函数 = 跨域面扩大）也会红，免得在册说明慢慢变成假话；在册但源码里已不存在的条目也判红（陈旧条目）。
  - 两条都有**空转守卫**（扫到的条数低于基线即失败）；改了规则要知道基线是 `MIN_DB_REQUIRES=3` / `MIN_DB_EDGES=4`。
- **刻意没做**：① **不搬** `upsertOrderBatch` 到编排层 —— 它已是静态 import、已被类型检查、且是单一具名 seam，搬走只是让 import 换个文件，收益为负；② **不给全仓所有 require 补标注** —— `main.ts` 那批是裸副作用调用无从查起，其余普通模块属另一类清理，混进来会把这条守卫的判据说糊。
- **变异复核（5 组，逐条实测判红，且只由对应规则报红）**：① 去掉 `order-handlers` 的类型标注 ⇒ 规则 A 红；② 标注指向 `./purchase-db`（≠ 目标）⇒ 规则 A 红（"等于没查"）；③ `shop-item-db` 偷偷 `import ... from './order-db'` ⇒ 规则 B 红（未登记边）；④ `purchase-db` 多拿一个 `ensureSkuSchema` ⇒ 规则 B 红（取用面变了）；⑤ 删掉一条在册边 ⇒ 规则 B 红（陈旧条目）。
- **验证**：`tsc` ✅ · `vue-tsc` ✅ · `verify`（3 条）✅ · `verify:docs` ✅ · `build` ✅ · `vitest` 38 文件 692 例 ✅ · 数据库/形状冒烟 9 个 ✅ · 4 个 UI 冒烟（order-profit 91 / today 249 / goods 291 / master-data 74）✅。

**源**：`2026-10-15-table-necessity-review`（2026-10-15）

---

## 10. `purchase_items` 与 `purchase_sources` **粒度不同，不可并**（两张都留）

**结论**：同键 `(purchase_id, style_code, color, size, qty)` 看着像 1:1，实测是 **1:N** ⇒ 保留两张表。
**判据顺序**：先看**写入语义**（谁生成、按什么粒度一行）→ 再看**读取者用不用这个粒度** → 最后才看真实数据基数。单看数据基数会被样本骗（本机只有 1 张拿货单）。

**取证（合并候选处置记录，2026-10-15，只做取证与判定，未改代码）**：
- **写入**：`purchase_items` 由拿货单**明细**生成，`UNIQUE(purchase_id, style_code, color, size)` ⇒ **一行 = 一个款色码**；`purchase_sources` 由**需求订单行的 FIFO 分配**生成（`purchase-db.ts` 里按 `oi_orders.id` 顺序逐行推，行数封顶 = 该款色码的 `need`）⇒ **一行 = 一条被拿来凑数的订单行**，同一个款色码可以出多行（`purchase_orders` 更新时 `DELETE ... WHERE purchase_id=?` 后整批重写，两表同生命周期）。
- **读取者要的正是"行"这个粒度**：`purchase-db.ts` 的分配链按 `purchase_sources` 每行的 `qty` 当**该订单行的上限**（bucket 的 `used` 计数）来回摊——把 `shop` 挪进 `purchase_items` 会**丢掉行数**，分摊少一层上限（同一款色码在两家店各要 1 件 vs 一家店要 2 件，汇总后无法区分）。
- **真实数据（本机实跑，只读副本）**：`purchase_orders=1 / purchase_items=5 / purchase_sources=6` —— sources 比 items 多一行；按 `(purchase_id, style_code, color, size)` 分组，`SUST-006/未分类/XL` 是 **2 行**（`shop_list=十二店|十二店`）。⚠️ 注意这一例两行**同店**：说明重复的直接来源不是"多店铺"而是"多条需求订单行"，**只看 `COUNT(DISTINCT shop)` 会误判成"其实 1:1"** —— 判据要看**行**，不是店铺数。
- ⇒ **两张表都保留**；`shop` 不进 `purchase_items`（不是"改 JSON 数组"就能解决的，丢的是行粒度不是店铺集合）。
- 2026-10-29 的逐表备注仍是同一句纪律：`purchase_items` "与 sources 粒度不同，勿合并"。

**源**：`2026-10-15-table-necessity-review`（2026-10-15）· 补充取证来自 `2026-10-29-db-table-audit`（2026-10-29）

---

## 11. "看似重复"的表多数是**有意的覆盖 / 反规范化模式**，不该并

**结论**：只有 `purchase_items/sources` 曾被视为实质可并（已验不可并）；其余"看似重复"的表都保留。

**取证**：

| 候选 | 现状 | 判定 | 建议 |
|------|------|------|------|
| `purchase_items` + `purchase_sources` | 同键 `(purchase_id, style_code, color, size, qty)`；items 多 `price_cents/amount_cents/suggestion_qty`（且 **`UNIQUE(purchase_id,style_code,color,size)`**）、sources 多 `shop`（**无唯一约束**） | **❌ 不可并（已验：1:N，不是 1:1）** | **保留两张表**。取证见 §10 |
| `pl_images` + `oi_images` | 两个图仓：pl 给商品主图（fingerprint/local_path/source），oi 给订单识别图（多 url_fingerprint/style_color_id/status/result_json 处理流水线） | 不同流水线，但同源"图片指纹→本地路径" | 可选：统一成 `images(kind, fingerprint, url_fingerprint?, local_path, status?, style_color_id?, ...)`，按 kind 分区。收益=单一图管理层，风险=迁移 oi 处理字段 |
| `sk_companies` + `suppliers` | companies=法律主体（VAT/EORI 等），suppliers=轻量拿货商（name/phone/note），无外键关联 | 若"供应商⊆公司"则漏了关联 | 可选：suppliers 加 `company_id` FK→`sk_companies.id`（无则 suppliers 独立存在）。先确认业务是否同一实体 |
| `pl_item_images`（item_id→image_id 覆盖图） | 与 `pl_shop_items.image_id` 看似重复 | **非冗余** | 保留：`pl_item_images` 是"人工覆盖图"最高优先级层（product-db.ts:1918 优先级链 ①），pl_shop_items.image_id 是抓取原图。属正确覆盖模式 |
| `oi_styles.fingerprint` vs `oi_style_fingerprints` | oi_styles 单列指纹 + 独立多指纹表 | **非冗余** | 保留：单列为快速主键查找的派生冗余，多表存变体指纹。常规反规范化 |
| `sk_mail_*` 八表 | 完整邮件系统 | 各自职责清晰 | 保留；`_meta`(1列KV)、`_bodies`(拆大文本)、`_attachment_cache`(文件路径缓存) 都是合理优化，无需合并 |

- **`pl_images` / `oi_images` / `sk_companies` / `suppliers`**：维持"可选、暂不动"—— 它们的合并收益是**单一管理层**，风险是迁移处理流水线字段与历史关联，而当前没有任何正确性问题驱动它。真要动，单独立项（不是本轮数据表审查能收口的）。
- 2026-10-29 逐表备注同样记着：`suppliers` "与 `sk_companies` 不同实体"。

**源**：`2026-10-15-table-necessity-review`（2026-10-15）· 补充取证来自 `2026-10-29-db-table-audit`（2026-10-29）

---

## 12. 存量表的总体评价与执行顺序（2026-10-15 收口）

**结论**：
- **必要性**：39 个对象里 36 个必要且活跃；**3 个死表（ae_orders/ae_order_lines/ae_fees）已于 2026-10-15 删除** ⇒ 现为 **36 个对象 / 33 业务表**；其余为合理细分。
- **合理性**：单库 + FK + WAL + 域模块 + 44 索引的底座很扎实；~~主要欠账是 C1 合并留下的孤儿订单库 + 利润引擎读死表，以及动态 DDL 的可读性~~ ⇒ **两笔欠账均已于 2026-10-15 还清**（P0 删死表 + P1-2 让拼接列可直读可断言）；~~余下只有 P1-4 跨域写未收口~~ ⇒ **P1-4 亦已于当日收口**（跨域引用改为"编译期看住 + 显式在册"）。
- **可合并**：~~实质可并的只有 `purchase_items/sources`（验 1:1 后）~~ **✅ 2026-10-15 已验：粒度不同、不可并（两张都留）**；可选 `pl_images/oi_images` 与 `sk_companies/suppliers`（无正确性问题驱动，暂不动）；其余"看似重复"的表（pl_item_images、oi_styles 双指纹）都是**有意的覆盖/反规范化模式**，不应并。
- **本节五条建议至此全部处置完毕。**

**取证（建议执行顺序，逐条状态照抄）**：
1. ~~**P0**：定位 `aeOrderList`/`aeSummary` 在 UI 的实际展示 → 决定"迁读者到 oi_orders"还是"连表带死代码一起删"。~~ **✅ 2026-10-15 已执行（走"连表带死代码一起删"）** —— 这是唯一会改变数据正确性的项，现已收口。
2. ~~**P1-3**：`upsertOrderBatch` 缺汇率改标记而非静默 NULL。~~ **✅ 2026-10-15 已执行**（改为"入站回执报 `rateMissing` + 界面把 `fx`/`revenue` 两档拆开"；**不**覆盖 `biz_status` —— 见 §8）。
3. ~~**P1-2**：`oi_orders` 动态列补一份可读 schema 注释 + 启动自校验。~~ **✅ 2026-10-15 已执行**（抽 `ORDER_BASE_COLS` + 导出 `ORDER_TABLE_COLUMNS` + `schema:smoke` 场景 [G] 逐列自校验；**刻意不做启动自校验** —— 落点是测试不是运行时。见 §7）。
4. **合并（低优）**：先验 `purchase_sources` 基数，再决定是否并入 `purchase_items`。**→ ✅ 2026-10-15 已验：结论是"不可并，两张都留"**（见 §10）。
5. ~~**P1-4**：跨域写未收口（`ae-db → order-db` 模块级 import、`purchase-handlers` 直接 require `order-db`）。~~ **→ ✅ 2026-10-15 已处置**（复核后判定"`ae-db → order-db` 是静态 import、不必改"，真缺陷是**不带类型标注的跨文件 require**；补标注 + 修被照出的 4 处旧签名不匹配 + 新增 `check-cross-domain-edges.mjs` 守卫。见 §9）。

**源**：`2026-10-15-table-necessity-review`（2026-10-15）

---

## 13. 拿货单明细列收敛为「图片 / 款色 / 尺码 / 建议 / 实拿 / 单价 / 金额」，取图**复用主进程唯一实现**

**结论**：用户口径（要求，非现状描述）—— 「拿货单中，列表中展示**图片、款色、尺码、建议、实拿、单价、金额**」：
明细表从 `款编码 | 款式名 | 颜色 | 尺码 | 建议 | 实拿 | 单价(元) | 金额(元)` 收敛为
**图片 / 款色 / 尺码 / 建议 / 实拿 / 单价(元) / 金额(元)**（+ 操作列）。
- 款编码 · 颜色两个输入并进「款色」一格（数据与出参一字未动，只是排版）；
- 款式名保留为该格下的**只读灰字**（权威在产品库 / ADR-002 D1，不在编辑器里编辑）；
- 手工加行 / 取最近价 / 删行 / 合计口径 原样。

取图：新通道 `purchase-style-images`（`purchase-handlers`）按「款编码 + 款色」批量查本地图路径，直接复用 **`order-db.findStyleColorImagePath(styleCode, color)`** —— 拿货单 **xlsx 导出**早就用的同一个函数（JOIN `oi_styles → oi_style_colors → oi_images`，`ORDER BY i.id DESC LIMIT 1`）。新增的只是"渲染层够得着"这一跳，**挑选口径没有第二份**。
渲染层拿到本地路径后，再走**既有** `orderImageThumbBatch` 出缩略图（`maxEdge:96`）。
⚠️ **图真的出来要两条通道串起来**：只断言任何一条都只看到一半（冒烟断言到 `<img>` 解码为止）。

**取证（冒烟 `today:ui`，非空转设计）**：
- **不对称夹具**：`S1 · 黑` 有图 / `S9 · 黑` 无图 —— 少了任一边，"永远有图"或"永远缺图"都会蒙对。
- `pue-img-1` 断言 `naturalWidth > 0`（空壳 `<img>` 也"有 img"）。
- payload 断言：`purchaseStyleImages` 收到 `{styleCode:'S1', color:'黑'}`（假桥记调用参数）。
- **变异确认**：表头改字 + 取图 todo 恒空 ⇒ **5 条针对性断言全红**（列集合 / 取图 / 行图 / S9 / 缓存）。
- ⚠️ **v-model 文本输入要发 `input` + `change` 两个事件**：v-model 听 `input`，而 `@change` 处理器是另一个（只发 `change` 会让处理器读到**旧值**）。
- ⚠️ **断言顺序**：改款色会触发 `onCodeChange`，若此时单价为空会**自动查历史价**、污染既有 `calls('purchasePriceHistory')[0]` 断言 ⇒ 改码往返放在「取最近价」断言**之后**（那时已有价、早退不查）。
- **计数**：`today:ui` 175 → **181**（+6）· `ipc:shape:smoke` 30 → **34**（+4）· `verify` 190/186 → **191/187**（+1 通道 `purchase-style-images`）。

**源**：`2026-10-10-purchase-editor-columns`（2026-10-10）

---

## 14. `undefined` / `null` / string 三分态（否则打开瞬间整表闪假「缺图」）

**结论**：`imgPaths` 的键值必须三态分清楚：**`undefined` = 还没查 / `null` = 查过确实没有 / string = 有图**。
把"还没查"当"没有"⇒ 抽屉打开的那一帧整表显示「缺图」，随即又跳成图 —— 用户看到的是"这软件在骗我"。

**取证**：`2026-10-10-purchase-editor-columns` 结论 2（同轮 `today:ui` 冒烟的不对称夹具即为此设）。

**源**：`2026-10-10-purchase-editor-columns`（2026-10-10）

---

## 15. 图是装饰，失败必须静默；但刷新时机不能被早退挡住

**结论**：
- `resolveImages()` 整体 try/catch 吞掉：查不到 / 查挂了都只是空占位，**绝不拦录入与保存主链路**。
- ⚠️ `onCodeChange` 里 `resolveImages(...)` 必须放在**"有价就早退"之前** —— 否则用户已填单价时改款色，早退顺带把取图也挡掉了（改动看着生效了，图却还是旧的）。

**取证**：`2026-10-10-purchase-editor-columns` 结论 3；对应冒烟是"改款色 → 再改回来"那条断言。

**源**：`2026-10-10-purchase-editor-columns`（2026-10-10）

---

## 16. 缓存断言 = 计数，不是"看着对"

**结论**：只查"还没查过的对"（`key in imgPaths` 跳过）。守卫写法：改款色 → 再改回来 ⇒ 断言**`purchaseStyleImages` 的调用数没涨**（`calls=N before=N`）。"图又出现了"本身不是证据 —— 重新请求也能让它出现。

**取证**：`2026-10-10-purchase-editor-columns` 结论 4 + 冒烟"变异确认 ⇒ 5 条针对性断言全红（列集合 / 取图 / 行图 / S9 / 缓存）"。

**源**：`2026-10-10-purchase-editor-columns`（2026-10-10）

---

## 17. preload 没透传 `items` ⇒ 每行「缺图」且零报错：shape smoke ⑨ 段值得单加

**结论**：风险与 `orderImageThumbBatch` 事故**同形**：preload 若没把 `items` 透传出去 ⇒ 主进程按空表处理 ⇒ 回来一串 `null` ⇒ **每行都显示「缺图」，console 一条错都不报**（"真的没图"与"通道坏了"界面无法区分）。

**取证**：
- ⑨ 段 = 真 preload + 真 handler + 真库 JOIN：逐项对位（命中 / 没图 / 空款编码 / 款不存在）· 载荷真的带 5 项 items · 空清单给空数组 · 501 项截断到 500。
- **变异**：preload 的 `items` 改成恒空 ⇒ 3/4 条红（"空清单"那条本就只测不炸，不受影响 —— 属预期）。

**源**：`2026-10-10-purchase-editor-columns`（2026-10-10）

---

## 18. 运行库 **60 表** / 新库 **53 对象**：两套计数口径不能混

**结论**：审计时运行库表数 60（`sqlite_master.type='table'`，不含 `sqlite_sequence`），清表后实测 58（−2）；新库稳态对象数 53 = 表 52（业务 50 + 内部 2）+ FTS5 虚表 1。
在用 47 · 边缘（审计时）6 · 疑似无用 **0** · 基础设施 7（FTS5 影子表 5 + `sk_mail_meta` + `sk_schema_migrations`）· 已退役删除 2（`sk_shop_sets`、`bk_periods`）。
`sqlite_sequence` 是 SQLite 为 `AUTOINCREMENT` 自建的内建表（记录各表最大 id），不属任何业务域，也不参与计数。
两条口径差异：新库不再建 `sk_shop_sets`（历史遗留），审计时只有运行库因历史升级残留这张 0 行空表；`bk_periods` 则是新库仍会建、但代码零读写的留位表。本轮两张都已退役。
`docs/baseline/PROJECT_BASELINE.md` §6 里"稳态共 50 个对象（47 业务表）"已过时（清表后实测为 53 / 50）。

**取证**：运行库路径 `~/Library/Application Support/seller-kit/sellerkit.db`；`npm run db:inventory` 清表后实测 53 对象（表 52 + FTS 1；业务表 50）。

与用户提供清单的出入（照抄）：
1. 清单实际列了 **60** 个表名（不是 59），与运行库完全一一对应，没有缺失项。
2. 运行库另有 `sqlite_sequence`（SQLite 内建，见上），清单不必收录。
3. 用户清单里的 5 个 `sk_mail_fts_*` **不是业务表**，是 FTS5 的内部影子表（详见 §20 `sk_mail_fts_*` 五行）。
4. `sk_shop_sets` 在新库中不会创建，且已在本轮退役（`shop.main` v2 幂等清掉历史残留，见 §22）。

**源**：`2026-10-29-db-table-audit`（2026-10-29）

---

## 19. Schema 权威定义位置（四个落点，各有分工）

**结论**：
- 公共层：`electron/db.ts`（连接、`dbMigrate`、`migrate`、记账表 `sk_schema_migrations`）
- 各域建表语句（新库一次建到当前形状）：`electron/{ae,ledger,mail,order,product,shop-item,purchase,shop,company,ship-rate}-db.ts`
- 存量库形状收敛：同一文件里的 `migrate('<域>.main', steps)` 版本化迁移（**与 `dbMigrate` 不可互替**，见 AGENTS §1.4）
- 对象清单真源：`scripts/db-inventory.cjs`（`npm run db:inventory`，空库逐域跑 `ensure*Schema()`）

**取证**：同上四行即取证（`electron/db.ts:105` 是 `sk_schema_migrations` 的建表位置）。

**源**：`2026-10-29-db-table-audit`（2026-10-29）

---

## 20. 逐表清单：建表位置 + 读写方 + 运行库行数

**结论**：「引用位置」给的是**建表语句所在行**（当前工作区，注释已加）；读写方给的是函数/模块名，便于跳转核查。行数来自运行库只读 `COUNT(*)`（2026-10-29）。

**取证（逐表，照抄）**：

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

**源**：`2026-10-29-db-table-audit`（2026-10-29）

---

## 21. **不要按行数判死**：0 行是正常空态，不是无用表

**结论**：`sk_mail_attachments` / `sk_mail_attachment_cache` / `payments` / `purchase_ignore` / `parcels` / `parcel_lines` / `bk_allocation_rules` / `bk_transfers` / `oi_style_fingerprints` / `pl_item_images` 当前 0 行，都是**正常空态**（还没发生过对应的业务动作），不是无用表。
审计时没有任何一张表达到"疑似无用"标准（疑似无用 = **0**）。真正可谈清理的只有 `sk_shop_sets`（历史残留）与 `bk_periods`（产品未启用的留位表）——这两张已按用户裁定删除。

清理判断的排序原则：先看"代码是否还建/还读写"，再看"数据是否还有意义"，最后看"是否有外键/迁移依赖"。

**取证（"功能已实现、入口未开"的三组，建议不清理）**：
- `oi_style_merges` / `oi_style_merge_items`（风险中）：`mergeStylesInto` / `unmergeStyles` 实现完整，IPC（`order-style-merge-board` / `order-style-merge` / `order-style-unmerge`）与 preload 已接，但渲染层尚未消费；运行库 0 行。依赖：`oi_style_merge_items.merge_id` 外键指向 `oi_style_merges`（级联）。建议：不清理；属于"功能已实现、入口未开"，不是死表。删前确认：款合并 UI 是否会在近期上线；若上线，这两张表是"可撤销"的唯一依据（只改键不改表会让合并不可逆）。
- `pl_bundle_links` / `oi_item_parts`（风险中高）：都是 2026-10-28 新套装模型，后端 CRUD/读取路径已完整，缺 IPC/UI；运行库 0 行。依赖：`oi_item_parts` 外键指向 `oi_order_items` 与 `oi_style_colors`；`pl_bundle_links` 无外键。建议：不清理。删 `pl_bundle_links` 会丢掉套装配置的唯一落点。删前确认：套装功能是否在路线图内；`pl_bundle_links` 无 IPC，但 `oi_item_parts` 已被订单行读取路径消费（`itemStyleColorIds`）。

**源**：`2026-10-29-db-table-audit`（2026-10-29）

---

## 22. 注释要写进 `sqlite_master.sql`：两层写法 + 存量库刷新脚本

**结论**：SQLite 没有 `COMMENT ON TABLE/COLUMN` 语法，DBeaver 里能看到的"表说明"实际来自 `sqlite_master.sql` 原文。因此注释分两层写：
1. **建表语句上方的 `//` 块注释**（原有风格，说明设计取舍）——留在源码里，供读代码用。
2. **建表语句内部的 `-- 用途：…` 行**——随 `sqlite_master.sql` 一起落库，DBeaver 的 DDL/源码页能直接看到。

两层都只加注释，未改列名/类型/索引/约束，也不影响迁移幂等与执行顺序。
`CREATE TABLE IF NOT EXISTS` 不会重写已存在表的 `sqlite_master.sql`，所以光改源码，DBeaver 里看到的仍是旧原文。为此另加了 `scripts/refresh-table-comments.cjs`（`npm run refresh:db-comments`）：备份 → 建带注释的同名新表 → 搬数据 → 换名 → 重建索引 → 追平 `sqlite_sequence`，只插入一行 `-- 用途：`。本轮已对运行库执行成功（52/52 张表），数据行数未变。

**取证（改动文件 11 个，覆盖 52 张在用业务表）**：

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

**源**：`2026-10-29-db-table-audit`（2026-10-29）

---

## 23. 【历史记录】`sk_shop_sets` 与 `bk_periods` 已退役删除（含运行库执行与校验）

**结论**：依据用户明确"当前就是最新版本、还没有正式发布；按'生产代码零引用'口径，没使用就删"，两张表已按用户裁定删除，相关代码同步清理。

**取证（代码侧改动，照抄）**：

| 文件 | 改动 |
| --- | --- |
| `electron/shop-db.ts` | 整表合并迁移（搬账号 / 归并企业 / 建工具账号 / 重建 `sk_mail_accounts`）整段退役；删除 `LEGACY_SET_DDL`、`ensureLegacySetColumns`、`materializeLegacyAccounts`、`shopSecretsOf` 等只服务该迁移的代码与未用 import；`shop.main` 现为 v1 版本占位 + v2 `DROP TABLE IF EXISTS sk_shop_sets` |
| `electron/ledger-db.ts` | 删除 `bk_periods` 建表语句；`ledger.main` 新增 v4 `DROP TABLE IF EXISTS bk_periods` |
| `scripts/shop-db-smoke.cjs` | 移除两条依赖 `sk_shop_sets` 的老库重建用例（迁移已不存在）；`shop.columns` 补列用例保留 |
| `scripts/reset-dev-data.mjs` | 清数据表清单去掉 `bk_periods` |
| `scripts/refresh-table-comments.cjs` | 用途表去掉 `sk_shop_sets` / `bk_periods` 两项 |

**取证（运行库执行，照抄）**：
1. 备份：`sellerkit.db.bak-retire-20261029`（`sqlite3 .backup`）。
2. 执行前实测：`sk_shop_sets` 0 行、`bk_periods` 0 行；无外键指向两者。
3. 以 `dist/electron` 的 `ensureShopSchema()` + `ensureLedgerSchema()` 对运行库执行（`ELECTRON_RUN_AS_NODE` 模式下跑迁移）。
4. 执行后实测：两表已从 `sqlite_master` 消失；`PRAGMA foreign_key_check` 为空；账本 `shop.main = 2`、`ledger.main = 4`；`sqlite_master.type='table'` 由 61（含 `sqlite_sequence`）降到 59。

> 注：`shop.main` 的 v1 保留为**空步骤占位** —— 已跑过合并的开发机账本里记的是 1，跳过它才能轮到 v2。

删前确认（原文记录）：`sk_shop_sets` —— ① 该库是否还有"未跑完 v1 迁移"的历史账号数据（查 `sk_accounts` 是否还存在且有行）；② 备份（`sellerkit.db.bak-*`）是否可用；③ 迁移账本 `sk_schema_migrations['shop.main'] >= 1`。依赖：无外键指向它（`sk_mail_accounts` 早已改指 `sk_shops`）；无触发器。用户确认"未正式发布、无存量库"，故**不做改名观察，直接删**。
`bk_periods` —— 全仓零 SQL 读写，仅 DDL + 文档 + reset 脚本；产品明确本期不做月结（LEDGER_PLAN RK-10）。依赖：无。将来真做锁账时重新设计建表。

**取证（本轮校验，含一条既有失败）**：

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

原待拍板项与结果：① `sk_shop_sets` → 用户裁定：项目未正式发布、无存量库，**直接删并清代码**；② `bk_periods` → 用户裁定：**删**（本期不做月结）；③ `oi_style_merges*`、`pl_bundle_links`、`oi_item_parts` 是否冻结？ → 未动：均有后端实现与生产读取路径，属"功能已实现、入口未开"；④ 存量库的注释可见性问题？ → 已用 `npm run refresh:db-comments` 刷新运行库（52 张表）。

**源**：`2026-10-29-db-table-audit`（2026-10-29）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-09-30-table-rebuild-traps.md` | 2026-09-30 | §1 / §2 / §3 |
| `2026-10-15-table-necessity-review.md` | 2026-10-15 | §4 / §5 / §6 / §7 / §8 / §9 / §10 / §11 / §12 |
| `2026-10-29-db-table-audit.md` | 2026-10-29 | §2（补充）/ §10（补充）/ §11（补充）/ §18 / §19 / §20 / §21 / §22 / §23 |
| `2026-10-10-purchase-editor-columns.md` | 2026-10-10 | §13 / §14 / §15 / §16 / §17 |
