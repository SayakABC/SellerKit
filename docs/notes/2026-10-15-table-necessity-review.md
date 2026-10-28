# 数据表必要性 / 设计合理性 / 可合并性审查（UI 岛回迁后）

> 审查对象：`electron/*-db.ts` 内 38 张实体表 + 1 张 FTS 虚拟表（`sk_mail_fts`），共 39 个对象。
> 方法：先抓全量 DDL，再对每张表做**全仓库写入点 / 读取点普查**（electron + src + scripts），以"是否有写入"判定死表、以"列族重叠 + 业务基数"判定可合并。
> 前置结论（上一轮）：所有域共用同一个 `sellerkit.db`（`db.ts` 单例 `initDb()`，FK ON + WAL），"跨域"是代码归属边界而非物理分库。

> ✅ **处置状态（2026-10-15 当日落地）**：本审查的 **P0 已执行「废弃路径」**（方案 1，用户裁定"直接删表"）——
> 三张弃表 + 整条死代码链已删（`ae.main` v3 迁移负责删表，其余见 §二 P0 的处置记录）。
> **本表的权威计数随之从 39 个对象降为 36**（33 业务表 + 2 内部表 + 1 FTS），逐项以
> `docs/baseline/PROJECT_BASELINE.md` §「SQLite」为准。
>
> ✅ **同日续办三项**：**P1-3**（缺汇率不再静默：入站回执 `rateMissing` + 界面 `fx`/`revenue` 拆两档）、
> **P1-2**（`oi_orders` 拼接列导出 `ORDER_TABLE_COLUMNS` + `schema:smoke` 场景 [G] 自校验）、
> **合并候选**（`purchase_items`/`sources` **已验为粒度不同 ⇒ 不可并、两张都留**）。
> 三项的判据、刻意没做的事与变异复核分别见 §二 P1-3 / P1-2 处置记录、§五 合并候选处置记录。
>
> ✅ **同日再续办 P1-4（跨域引用收口）**：复核后**推翻了原判据的一半** —— `ae-db → order-db` 是静态 import，
> 本就在类型检查里、且是 C1 刻意的单函数 seam（**不改**）；真缺陷是跨文件 `require` 不带类型标注 ⇒
> 跨域签名改了**编译期零报错**（已实证）。补 3 处标注后 tsc 又照出 **4 处被 `any` 掩盖的旧签名不匹配**，一并修掉；
> 新增 `scripts/check-cross-domain-edges.mjs` 接进 `verify`（require 必有标注 + db→db 边逐条在册）。
> 见 §二 P1-4 处置记录。**本节五条建议至此全部处置完毕。**

## 一、逐域结论（39 个对象）

| 域 | 表 | 写入 | 读取 | 判定 |
|----|----|----|----|------|
| **订单主干 oi_*** | `oi_orders`(22列枢纽) / `oi_images` / `oi_styles` / `oi_style_colors` / `oi_style_fingerprints` / `oi_queue` | 均 ≥2 | 均 ≥3 | ✅ 全部必要，设计合理 |
| **AE 原始 ae_*** | `ae_cost_map` / `ae_rates` / `ae_settle_lines` | 各 ≥1 | 各 ≥5 | ✅ 必要 |
| | `ae_orders` | **0** | 6 | ❌ **死表（零写入）→ ✅ 2026-10-15 已删** |
| | `ae_order_lines` | **0** | 3 | ❌ **死表 → ✅ 已删** |
| | `ae_fees` | **0** | 3 | ❌ **死表 → ✅ 已删** |
| **拿货 purchase_*** | `suppliers` / `purchase_orders` / `purchase_items` / `purchase_sources` / `payments` / `purchase_ignore` | 均 ≥1 | 均 ≥2 | ✅ 必要（见合并候选） |
| **商品 pl_*** | `pl_products` / `pl_shop_sku` / `pl_variants` / `pl_images` / `pl_item_images` / `pl_shop_items` | 均 ≥1 | 均 ≥2 | ✅ 必要（见合并候选） |
| **店铺/账号 sk_*** | `sk_shop_sets` / `sk_shops` / `sk_name_map` / `sk_companies` / `sk_company_profiles` / `sk_schema_migrations` | 均 ≥1 | 均 ≥1 | ✅ 必要 |
| **邮件 sk_mail_*** | `sk_mail_accounts` / `_messages` / `_bodies` / `_attachments` / `_folders` / `_attachment_cache` / `_meta` / `_fts`(FTS) | 均 ≥1 | 多 | ✅ 完整邮件系统，必要（`_meta` 1 列 KV、`_bodies` 拆大文本是常规优化） |
| **运费 sr_*** | `sr_rate_snapshots` | 1 | 3 | ✅ 必要 |
| **迁移** | `sk_schema_migrations` | 1 | 1 | ✅ 必要（迁移版本锁） |

## 二、最需要处理的缺陷（按严重度）

### ~🔴 P0~ ✅ 已处置（2026-10-15）— `ae_orders` / `ae_order_lines` / `ae_fees` 是"只建不写"的孤儿库
- **证据**：全仓库（electron+src+scripts）三表写入点 = **0**；读取方仍在跑：
  - `ae-db.listOrders`（ae-db.ts:858）读 `ae_orders`/`ae_order_lines` → 经 `ae-handlers:47` → IPC `aeOrderList` → `src/core/plugin/host.ts:239`；
  - `ae-db.getAeSummary`（ae-db.ts:887）读 `ae_orders`/`ae_fees`；
  - `ae-engine.ts:149/161/171` 只读 `ae_orders`/`ae_order_lines`/`ae_fees` 做**利润计算**（行经 `ae_order_lines.style_code ↔ ae_cost_map` 命中成本）。
- **根因**：C1 合并（order-db.ts:208 注释「`oi_orders` 是唯一订单主干，两条摄取通道都写它」）把 AE 采集入口 `upsertOrderBatch`（ae-db.ts:760）改写到 `oi_orders`，但**旧的 `ae_orders` 三表及其读取方没跟着迁走**。
- **后果（静默）**：AE 采集合单列表与 AE 汇总读的是空/陈旧数据；利润引擎 `ae-engine` 的成本归因链路（`ae_order_lines`）也是空 → 要么利润算错、要么基于迁移前残留数据。
- **动作二选一**：
  1. **废弃路径**：删三表 + 删 `ae-db.listOrders`/`getAeSummary`/`ae-engine` 中读它们的逻辑，AE 订单/利润统一改走 `oi_orders`（已有 `order-db.listOrdersPage` 与 oi 域成本链路）。
  2. **若 AE 订单列表确为独立功能**：把读者从 `ae_orders` 改指向 `oi_orders`（加 `source='collect'` 过滤），再删三表。
  - ⚠️ 删表前务必先确认 `aeOrderList`/`aeSummary` 在 UI 岛里是否仍被展示；若已无人调用则整段死代码一并清掉。

**处置记录（2026-10-15，方案 1「废弃路径」）**
- **前置确认（回答上面那条 ⚠️）**：三个通道**零存活消费者** —— 宿主「算钱」用的是 `aeCostMapList` / `aeRateList`（利润在渲染层 `src/lib/orderCost.ts` 组合）；ae-profit 岛的 manifest 只剩 `ensure` + `receiverStatus`（C9 收编时岛侧 op 已删）。
- **删了什么**：
  - **表**：`ae_orders` / `ae_order_lines` / `ae_fees` —— 走 **`ae.main` v3** 版本化迁移（`dropLegacyOrderTables`），存量库残留数据（本机实测 101 单采集历史）按用户裁定**直接丢弃**；建表语句同时从 `ae-db.ts` 的 `SCHEMA` 删除。
  - **引擎**：`electron/ae-engine.ts` 整文件删（378 行，唯一消费者是「利润统计」页，早随 C9 并入宿主）。
  - **读口**：`ae-db.listOrders` / `getAeSummary`（及 `mapOrderRow` / `fetchFeesByOrderIds` / `ORDER_COLS`）。
  - **IPC 三段**：`ae-order-list` / `ae-summary` / `ae-profit-stats` —— 四处契约同步删（handlers + preload + `src/types.ts` + `src/core/services/ipc.ts`），`src/core/plugin/host.ts` 的 `ae:` 域包装同步删。
  - **顺带清掉的死配置**：`shop-db.ts` 的 `SHOP_NAME_SOURCES` 原第三源 `{id:'ae', table:'ae_orders', column:'shop_name'}`（表删了它就成了死登记）；`scripts/reset-dev-data.mjs` 清空清单里的三张表名。
  - **口径文案跟着改**：店铺登记页那句用户可见的"订单 / 采购 / **利润**三处的历史文本实时汇总"改为"订单 / 采购**两处**"，`shop-db.ts` / `types.ts` / `ipc.ts` / `preload.ts` / `main.ts` / `shopApi.ts` / `MasterDataView.vue` / `shop-product-db.ts` / `shop-handlers.ts` 里同口径的注释一并改（**"三处文本"是这次删表的直接后果，不改就成了假文档**）。
- **未做的（刻意）**：`order.main` v4 的历史回填**保留原样**（只做加法、不删表）——它是"老库可能还有数据"的兜底；对本机那份库，v4 早已记账完成且三表数据无 `order_no` 与 `oi_orders` 重叠，回填与否都看不见（实测）。
- **验证**：`tsc` / `vue-tsc` / `verify` / `verify:docs` / `build` / `vitest`（692）全绿；`ae:smoke` 25/25、`shop:smoke` 35/35、`schema:smoke` 37/37（场景 D 改为兼测 v3 删表）。
- 详细流水见 `.workbuddy/memory/2026-10-15.md`；门禁口径见 `docs/baseline/PROJECT_BASELINE.md`。

### 🟡 P1 — 设计合理性的结构性问题
1. **双订单库**：`oi_orders`（活）与 `ae_orders` 三表（死）并存，是本次最刺眼的反模式。C1「单一主干」理念没贯彻到底。**→ ✅ 2026-10-15 已随 P0 消除（死表已删）。**
2. **动态 DDL 不透明**：`oi_orders` 列由 `ORDER_MONEY_COLS`/`ORDER_SPINE_COLS`（order-db.ts:197/212）拼接，列定义不在建表字面量里，新人不直读；靠 `migrateOrderSpine`（:451）兜底补列。可用但易漏。
   **→ ✅ 2026-10-15 已处置**（见下方 P1-2 处置记录）。

**处置记录 P1-2（2026-10-15，把"拼接结果"变成可直读、可断言的一份）**
- **先厘清风险边界**（不然容易做无用功）：拼数组这件事本身**已经**防住了最大的坑 ——
  金额列/主干列要**同时**服务「新库建表」与「老库 `ALTER` 补列」（`addOrderMoneyColumns`），
  写成两份字面量必然漂移，共用一份数组是对的。真正缺的是两件事：
  ① **可读性**：列序只存在于运行时，读代码要自己在脑子里展开三个 spread；
  ② **新库建表这条路上没有任何断言**：`ALTER` 补列那条路由 `schema:smoke` 的列存在性断言看着，
  而"模板里少写一个 `${}` / 往字面量里手加一列却没进数组"没有任何判据能发现。
- **做了什么**：
  - `electron/order-db.ts`：把原先**硬写在模板里的 13 个基础列**抽成 `ORDER_BASE_COLS`，
    建表模板改为**三份数组统一拼接**（改列只改数组）；
  - 新增导出 **`ORDER_TABLE_COLUMNS`** —— 由同一批数组推出的**解析后列序**（含尾部 `created_at`）。
    它**不是第二份清单**（改数组它自动跟着变），存在的意义是让"拼接结果"成为可断言对象；
  - `scripts/schema-migration-smoke.cjs` 新增**场景 [G]**：新建干净库 → `ensureOrderSchema()` →
    `PRAGMA table_info(oi_orders)` 的列序与 `ORDER_TABLE_COLUMNS` **逐列相等**；
    并带一条非空转守卫（清单条数 `>= 20`，防止清单被清空后那条反而恒绿）。
- **刻意没做**：**不在启动时做自校验** —— 启动期检查既改不了形状（`CREATE TABLE IF NOT EXISTS`
  对老表一个字不改）又只会往日志里加噪声；"断言拼接结果"这件事的落点是**测试**，不是运行时。
- **验证（含变异复核）**：`schema:smoke` 37 → **38 项 / 7 场景**（新增 [G]）；
  ① 模板丢掉一段 `${}` ⇒ 红（连带 [C] 的老库重建断言也红）；
  ② **只**往模板字面量里手加一列（未进数组）⇒ **只有 [G] 红**（证明 [G] 就是盯这件事的那条）；
  ③ 重建后 `SELECT sql FROM sqlite_master` 与改动前**逐字相同**（列序未变，位置参数 INSERT 不受影响）。

3. ~~**CNY 折算静默丢金额**~~ **→ ✅ 2026-10-15 已处置**（见下方处置记录）：
   `upsertOrderBatch`（ae-db.ts）`rate ? toCentsCny(...) : null` —— 缺汇率时 `amount_cents=NULL`，
   部分订单金额为空且**入站回执只说 `ok:true`**。~~建议缺汇率时标记 `biz_status='rate_missing'`~~
   ⚠️ **该建议已被推翻**：`biz_status` 有下游读者（`src/lib/orderCost.ts:187 bucketOfStatus` 按它分桶
   → 利润/拣货的完成/在途/关闭归类），覆盖它会把真实平台状态吞掉、让订单落进 `unknown` 桶 ——
   这是**真回归**，不是"加个标记"。正确做法见处置记录。
4. ~~**跨域写未收口**~~ **→ ✅ 2026-10-15 已处置**（见下方处置记录）：两处形态不同 ——
   `ae-db → order-db` 是**静态 import**（本就在类型检查里，且是 C1 刻意的单函数 seam），
   真缺陷在 `purchase-handlers` 那种**跨文件 `require` 不带 `as typeof import(...)`** ⇒ 跨域签名改了编译期零报错。

**处置记录 P1-4（2026-10-15）：跨域引用要么被编译期看住，要么被显式登记**
- **先复核原判据，两处结论不同**（"先实证再动手"，别照抄审查结论）：
  - `ae-db.ts:38` 的 `import { upsertCollectedOrder } from './order-db'` 是**同一 ts 项目里的静态 import**
    ⇒ **本来就在类型检查里**（实测：改 `upsertCollectedOrder` 的参数类型，`ae-db` 立刻 TS2345）。
    它也是 C1 刻意的方向（`order-db.ts` 的注释写明"汇率属 ae 域，让 order-db 读别的域才是跨域耦合，
    所以由 ae-db 折算"），形态是**单一具名函数**。**结论：不需要改**（改了只是把 import 挪个位置）。
  - 真缺陷在 `purchase-handlers.ts` 的 `const orderDb = require('./order-db')` —— **不带类型标注的跨文件 require
    就是 `any`**。实测（改前）：把 `order-db.findStyleColorImagePath` 的 `color` 由 `string` 改成 `number`，
    两处调用照传 string，`tsc -p tsconfig.electron.json` **退 0、零报错**；改后同一次探针报
    `TS2345: Argument of type 'string' is not assignable to parameter of type 'number'`（`purchase-handlers.ts:394`）。
- **改了什么（3 处补类型标注 + 被照出来的 4 处旧签名不匹配）**：
  1. `order-handlers.ts:16` / `purchase-handlers.ts:10,300` 三处 `require('./x-db')` 补 `as typeof import('./x-db')`
     （擦除后无运行时开销；同文件对 `./xlsx-image` / `./ipc-util` 早就是这么写的，属补齐惯例）。
  2. ⚠️ **补上标注后 tsc 立刻报出 4 处此前被 `any` 掩盖的签名不匹配**（这才是"收口"的真正产出）：
     - `order-handlers.ts` 的 `order-insert`：`payload.imageId` 是 `unknown`，原来经 `hasImage` 布尔中转**收不窄**
       （TS 不能用排除法收窄 `unknown`）⇒ 改为**类型谓词** `isOrderImageId(v): v is number | null`；
       顺带把 `isPlainObject(payload)` 提到最前（原来 `payload` 为 null 时 `payload.imageId` 会抛，兜底成了异常而不是 `{success:false}`）。
     - `order-handlers.ts` 的 `order-queue-list`：`status` 用 `[...].includes(s) ? s : undefined`，
       `includes` **不收窄** `s` ⇒ 与 `OrderQueueStatus | 'all'` 不符。改为类型谓词 `isQueueStatusFilter`（不用 `as`）。
     - `purchase-handlers.ts` 两处明细：`sanitizeItems` 不产出 `amountCents`，而 `PurchaseItem` 要求它 ——
       真相是 **`amountCents` 是派生列**（`insertItems` 里 `amount_cents = qty × priceCents` 现算），
       写侧**本来就不该**给。新增 `PurchaseItemInput = Omit<PurchaseItem, 'id' | 'amountCents'>`
       用在 `createPurchaseOrder` / `updatePurchaseOrder` / `insertItems` / `computeTotal` / `autoSourceRows`
       （读侧 `loadItems` / `PurchaseOrder.items` 仍是完整 `PurchaseItem`）——
       ⚠️ 这与渲染层 `src/modules/today/purchase.ts:58` 早已存在的同名同义类型**对齐**，不是新发明。
- **新增守卫 `scripts/check-cross-domain-edges.mjs`**（接进 `npm run verify` 第③条），两条规则：
  - **A**：`electron/` 内所有 `require('<路径>-db')` 必须带 `as typeof import(<同路径>)`
    （**同路径**也要查：写 `import('./other-db')` 等于没查）。只扫 `*-db`：那一层才是"签名改了会静默错查"的；
    `main.ts` 的 `require('./order-handlers')` 是**只为注册副作用**的裸调用，没有 API 要查。
  - **B**：`*-db.ts` 之间的静态 import 边必须**逐条在册**（`DB_EDGES`，6 条，含**从对方取用的符号**）。
    不写死"用途说明"文字而是比对符号清单 —— 用途悄悄变了（多 import 一个函数 = 跨域面扩大）也会红，
    免得在册说明慢慢变成假话；在册但源码里已不存在的条目也判红（陈旧条目）。
  - 两条都有**空转守卫**（扫到的条数低于基线即失败）；改了规则要知道基线是 `MIN_DB_REQUIRES=3` / `MIN_DB_EDGES=4`。
- **刻意没做**：① **不搬** `upsertOrderBatch` 到编排层 —— 它已是静态 import、已被类型检查、且是单一具名 seam，
  搬走只是让 import 换个文件，收益为负；② **不给全仓所有 require 补标注** —— `main.ts` 那批是裸副作用调用无从查起，
  其余普通模块属另一类清理，混进来会把这条守卫的判据说糊。
- **变异复核（5 组，逐条实测判红，且只由对应规则报红）**：
  ① 去掉 `order-handlers` 的类型标注 ⇒ 规则 A 红；② 标注指向 `./purchase-db`（≠ 目标）⇒ 规则 A 红（"等于没查"）；
  ③ `shop-item-db` 偷偷 `import ... from './order-db'` ⇒ 规则 B 红（未登记边）；④ `purchase-db` 多拿一个 `ensureSkuSchema`
  ⇒ 规则 B 红（取用面变了）；⑤ 删掉一条在册边 ⇒ 规则 B 红（陈旧条目）。
- **验证**：`tsc` ✅ · `vue-tsc` ✅ · `verify`（3 条）✅ · `verify:docs` ✅ · `build` ✅ ·
  `vitest` 38 文件 692 例 ✅ · 数据库/形状冒烟 9 个 ✅ · 4 个 UI 冒烟（order-profit 91 / today 249 / goods 291 / master-data 74）✅。

**处置记录 P1-3（2026-10-15，正确答案）**
- **判据来源**：对 `collect` 通道，`amount_cents IS NULL` **⟺ 缺汇率**（`upsertOrderBatch` 只在一处生成金额：
  `rate = 本币 ? 1 : (ae_rates 查不到 ? 0 : 汇率)`，只有"非本币且无汇率"才落 NULL）—— 这是一条**精确**判据，
  不需要新列、也不需要动 `biz_status`。
- **改了什么（三处，各治一个症状）**：
  1. **入站不再静默**：`upsertOrderBatch` 回执新增 `rateMissing`（本批因缺汇率落 NULL 的单数）；
     `ae-receiver.ts` 的 `/ae/ingest` 响应带上它，并记进 `AeReceiverStatus.lastRateMissing`。
     至此扩展/界面能说出"这批 N 单缺汇率"，而不是只知道 `ok:true`。
  2. **界面把两档拆开**：`src/lib/orderCost.ts` 新增缺口 `fx`（缺汇率），按 `source` 分流 ——
     `collect` + 金额 null ⇒ `fx`（**去补一条汇率、重推即可**）；`import` + 金额 null ⇒ `revenue`（报表里就没有，无处可补）。
     「算钱」页缺口行新增「缺汇率」chip（沿用 2026-10-11 的**点 chip 即筛行**入口，缺项本身就是入口）。
  3. **契约同步**：`src/types.ts` 的 `AeReceiverStatus` 加 `lastRateMissing`（`electron/ae-receiver.ts` 同构）。
- **刻意没做**：① 不覆盖 `biz_status`（原因见上）；② 不把金额写 0（0 = "确实是 0"，`null` = "算不出来"，
  混起来会把"缺收入"伪装成"收入为零"）；③ 不因 `skipped` 计入 `rateMissing`（坏帧与算不出钱的单处置办法不同，别混成一数）。
- **验证**：`vitest`（新增 `fx` / `revenue` 分流用例，**两输入只差 `source`**，非空转）· `ae:smoke` 25/25
  （同一断言里造 CNY / USD / JPY 三个输入，计数必须给出不同值）· `order-profit:ui` 88 → **91**（+3：缺口 chip / 该行文案 / 金额格）。
- **变异复核（都实测判红）**：① 关掉 `rateMissing` 自增 ⇒ `ae:smoke` 红；② 改成"每单都计数" ⇒ 同一断言红；
  ③ 去掉 `source` 分流（两档并成 `revenue`）⇒ `vitest` 红。


## 三、可合并候选（均非紧急，先验基数再动）

| 候选 | 现状 | 判定 | 建议 |
|------|------|------|------|
| `purchase_items` + `purchase_sources` | 同键 `(purchase_id, style_code, color, size, qty)`；items 多 `price_cents/amount_cents/suggestion_qty`（且 **`UNIQUE(purchase_id,style_code,color,size)`**）、sources 多 `shop`（**无唯一约束**） | **❌ 不可并（已验：1:N，不是 1:1）** | **保留两张表**。取证见下「合并候选处置记录」 |
| `pl_images` + `oi_images` | 两个图仓：pl 给商品主图（fingerprint/local_path/source），oi 给订单识别图（多 url_fingerprint/style_color_id/status/result_json 处理流水线） | 不同流水线，但同源"图片指纹→本地路径" | 可选：统一成 `images(kind, fingerprint, url_fingerprint?, local_path, status?, style_color_id?, ...)`，按 kind 分区。收益=单一图管理层，风险=迁移 oi 处理字段 |
| `sk_companies` + `suppliers` | companies=法律主体（VAT/EORI 等），suppliers=轻量拿货商（name/phone/note），无外键关联 | 若"供应商⊆公司"则漏了关联 | 可选：suppliers 加 `company_id` FK→`sk_companies.id`（无则 suppliers 独立存在）。先确认业务是否同一实体 |
| `pl_item_images`（item_id→image_id 覆盖图） | 与 `pl_shop_items.image_id` 看似重复 | **非冗余** | 保留：`pl_item_images` 是"人工覆盖图"最高优先级层（product-db.ts:1918 优先级链 ①），pl_shop_items.image_id 是抓取原图。属正确覆盖模式 |
| `oi_styles.fingerprint` vs `oi_style_fingerprints` | oi_styles 单列指纹 + 独立多指纹表 | **非冗余** | 保留：单列为快速主键查找的派生冗余，多表存变体指纹。常规反规范化 |
| `sk_mail_*` 八表 | 完整邮件系统 | 各自职责清晰 | 保留；`_meta`(1列KV)、`_bodies`(拆大文本)、`_attachment_cache`(文件路径缓存) 都是合理优化，无需合并 |

## 四、总体评价
- **必要性**：39 个对象里 36 个必要且活跃；**3 个死表（ae_orders/ae_order_lines/ae_fees）已于 2026-10-15 删除** ⇒ 现为 **36 个对象 / 33 业务表**；其余为合理细分。
- **合理性**：单库 + FK + WAL + 域模块 + 44 索引的底座很扎实；~~主要欠账是 C1 合并留下的孤儿订单库 + 利润引擎读死表，以及动态 DDL 的可读性~~ ⇒ **两笔欠账均已于 2026-10-15 还清**（P0 删死表 + P1-2 让拼接列可直读可断言）；~~余下只有 P1-4 跨域写未收口~~ ⇒ **P1-4 亦已于当日收口**（跨域引用改为"编译期看住 + 显式在册"，见 §二 P1-4 处置记录）。
- **可合并**：~~实质可并的只有 `purchase_items/sources`（验 1:1 后）~~ **✅ 2026-10-15 已验：粒度不同、不可并（两张都留）**；可选 `pl_images/oi_images` 与 `sk_companies/suppliers`（无正确性问题驱动，暂不动）；其余"看似重复"的表（pl_item_images、oi_styles 双指纹）都是**有意的覆盖/反规范化模式**，不应并。

## 五、建议执行顺序
1. ~~**P0**：定位 `aeOrderList`/`aeSummary` 在 UI 的实际展示 → 决定"迁读者到 oi_orders"还是"连表带死代码一起删"。~~ **✅ 2026-10-15 已执行（走"连表带死代码一起删"）** —— 这是唯一会改变数据正确性的项，现已收口。
2. ~~**P1-3**：`upsertOrderBatch` 缺汇率改标记而非静默 NULL。~~ **✅ 2026-10-15 已执行**（改为
   "入站回执报 `rateMissing` + 界面把 `fx`/`revenue` 两档拆开"；**不**覆盖 `biz_status` —— 见 §二 P1-3 处置记录）。
3. ~~**P1-2**：`oi_orders` 动态列补一份可读 schema 注释 + 启动自校验。~~ **✅ 2026-10-15 已执行**
   （抽 `ORDER_BASE_COLS` + 导出 `ORDER_TABLE_COLUMNS` + `schema:smoke` 场景 [G] 逐列自校验；
   **刻意不做启动自校验** —— 落点是测试不是运行时。见 §二 P1-2 处置记录）。
4. **合并（低优）**：先验 `purchase_sources` 基数，再决定是否并入 `purchase_items`。
   **→ ✅ 2026-10-15 已验：结论是"不可并，两张都留"**（见下方合并候选处置记录）。
5. ~~**P1-4**：跨域写未收口（`ae-db → order-db` 模块级 import、`purchase-handlers` 直接 require `order-db`）。~~
   **→ ✅ 2026-10-15 已处置**（复核后判定"`ae-db → order-db` 是静态 import、不必改"，真缺陷是**不带类型标注的
   跨文件 require**；补标注 + 修被照出的 4 处旧签名不匹配 + 新增 `check-cross-domain-edges.mjs` 守卫。见 §二 P1-4 处置记录）。

**合并候选处置记录（2026-10-15，只做取证与判定，未改代码）**
- **判据顺序**：先看**写入语义**（谁生成、按什么粒度一行）→ 再看**读取者用不用这个粒度** → 最后才看真实数据基数。
  单看数据基数会被样本骗（本机只有 1 张拿货单）。
- **`purchase_items` vs `purchase_sources` —— 粒度不同，不可并**：
  - **写入**：`purchase_items` 由拿货单**明细**生成，`UNIQUE(purchase_id, style_code, color, size)` ⇒ **一行 = 一个款色码**；
    `purchase_sources` 由**需求订单行的 FIFO 分配**生成（`purchase-db.ts` 里按 `oi_orders.id` 顺序逐行推，
    行数封顶 = 该款色码的 `need`）⇒ **一行 = 一条被拿来凑数的订单行**，同一个款色码可以出多行
    （`purchase_orders` 更新时 `DELETE ... WHERE purchase_id=?` 后整批重写，两表同生命周期）。
  - **读取者要的正是"行"这个粒度**：`purchase-db.ts` 的分配链按 `purchase_sources` 每行的 `qty` 当
    **该订单行的上限**（bucket 的 `used` 计数）来回摊——把 `shop` 挪进 `purchase_items` 会**丢掉行数**，
    分摊少一层上限（同一款色码在两家店各要 1 件 vs 一家店要 2 件，汇总后无法区分）。
  - **真实数据（本机实跑，只读副本）**：`purchase_orders=1 / purchase_items=5 / purchase_sources=6` ——
    sources 比 items 多一行；按 `(purchase_id, style_code, color, size)` 分组，`SUST-006/未分类/XL`
    是 **2 行**（`shop_list=十二店|十二店`）。⚠️ 注意这一例两行**同店**：说明重复的直接来源不是"多店铺"
    而是"多条需求订单行"，**只看 `COUNT(DISTINCT shop)` 会误判成"其实 1:1"** —— 判据要看**行**，不是店铺数。
  - ⇒ **两张表都保留**；`shop` 不进 `purchase_items`（不是"改 JSON 数组"就能解决的，丢的是行粒度不是店铺集合）。
- **`pl_images` / `oi_images` / `sk_companies` / `suppliers`**：维持"可选、暂不动"——
  它们的合并收益是**单一管理层**，风险是迁移处理流水线字段与历史关联，而当前没有任何正确性问题驱动它。
  真要动，单独立项（不是本轮数据表审查能收口的）。
