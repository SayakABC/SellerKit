# 数据依赖优化建议（基于 2026-10-15 依赖分析）

**前提修正**：全仓 43 表**同处一个 SQLite 文件** `userData/sellerkit.db`（`electron/db.ts:37` 单例 `initDb()`，
`foreign_keys=ON` + WAL；各 `*-db` 调 `getDb()` 拿同一连接）。所以"跨域"是**逻辑/代码归属边界**，
不是物理隔离——JOIN 跨 `oi_*/pl_*/ae_*/sk_*` 是直接可行的（见首轮 JOIN 取证）。问题落在两类：
① **模块互相认识**（db 层/ handler 层跨域 import）；② **最终一致性靠异步补**（成本同步、店铺解析）。

> ### ⚠️ 状态回填（2026-10-15 傍晚，P1-4 处置时逐条复核）
> 本文是**建议稿**，不是执行记录。与 P1-4 直接相关的三条（§P1 的第 3/4/5 条）复核结论如下 ——
> 完整处置见 `docs/notes/2026-10-15-table-necessity-review.md` §二 P1-4：
> - **第 3 条（消除 `ae-db → order-db` 的模块级 import）→ 未采纳，且前提有误**。原文写"**唯一一处** db 模块互相 import"，
>   **实测有 6 条**（`scripts/check-cross-domain-edges.mjs` 扫出：ae→order、order→product、picking→product、
>   purchase→product、shop-item→shop、shop-product→product）⇒ 按原方案要一次改 6 处（含 5 处与本次审查无关的既存边）。
>   且 A 边是 C1 刻意的方向（`order-db.ts` 注释："汇率属 ae 域，让 order-db 读别的域才是跨域耦合"），形态是单一具名函数。
>   ⇒ 改为**"逐条在册 + 编译期看住"**。
> - **第 4 条（边 C 改走订单域 op / 经 IPC 调）→ 未采纳**。`findStyleColorImagePath` **本来就是订单域导出的公开函数**，
>   调用点补 `as typeof import(...)` 后签名变更**编译期就会红**（已实证）；而"主进程 handler 调 renderer 面的 IPC op"
>   在本仓不是既有分层（`DB_OPS` 是给 UI 岛用的），绕一圈反而错位。⇒ 改为**补类型标注 + 守卫**。
> - **第 5 条（把跨域集成点登记 + 加 verify 守卫）→ ✅ 已采纳**，但守卫形态按第 3 条的实测结论调整：
>   原建议"`grep` 禁止 `*-db` 互相 import"一上线就会因上述 **6 条既存边**而红 ⇒ 改为**白名单在册（比每股边取用的符号清单）**
>   + `require('*-db')` 必带类型标注。

## P0 — 正确性（静默失败类，最该先动）

**1. 成本同步：脏标记 + 后台重算，取代"写后置同步"**
- 现状：`purchase-handlers.ts:25` 的 `withCostSync` 在每次拿货写后**同步**调 `syncPurchaseCosts()` 重算
  `ae_cost_map`(source='purchase')；失败 `try/catch` 仅日志 + 首页"缺成本 N 行"卡。
- 风险：拿货单写成功、但进程在 sync 前崩 / sync 抛错被吞 → 成本缺口**无自动恢复**（正是历史 bug 同类）。
- 改法：拿货写只置 `purchase_dirty`（KV，复用 `sk_mail_meta` 式单例表或 `sk_schema_migrations` 旁）；
  debounce 后台 job（或下次启动）基于 `purchase-db.costSnapshot()` 重算。用户点击不再依赖"当次 sync 成功"，
  崩溃可自愈。呼应 working-memory 的"静默失败三件套"。

**2. 店铺归属：原文 → 解析后的 shop_id（FK）+ 保留原文**
- 现状：`order-assign-shop`（`order-handlers.ts:169` → `order-db.ts:1559`）只写 `oi_orders.shop`（原文）；
  规范名在 `sk_name_map`/`sk_shops`，靠人工 `shopMap` 对账。两套表示 → 按店归因利润/成本可能分叉。
- 改法：`oi_orders` 加 `shop_id`（FK→`sk_shops.id`，库已 `foreign_keys=ON`），assign 时用 `shopName.ts`
  归一→解析 `sk_name_map`→写 `shop_id`；原文留作审计列。回填存量（已有 shopMap 即可）。
- 收益：店铺归因确定性、DB 强制引用完整、利润按店汇总不再靠字符串匹配。
- 风险点：回填要处理"原文在 name_map 但无 shop_set"的孤儿；先给 `shop_id` NOT NULL 默认值 0（与现有未登记桶约定一致）。

## P1 — 架构卫生（降改动爆炸半径）

**3. 消除 ae-db → order-db 的模块级 import（边 A）**
- 现状：`ae-db.ts:36 import { upsertCollectedOrder } from './order-db'` —— **唯一一处 db 模块互相 import**，
  违反 ADR-002"db 模块互不认识"。
- 改法：把"采集帧→折算→落 oi_orders"拆两步：ae 域只负责读 `ae_rates` 折算（`aeRateConvert` 纯函数/ae 域），
  落库交给订单域已注册 op（如 `order-collect-batch`，在 order-handlers 注册）。ae-receiver 先折算再调订单域 op。
  ae-db 不再 import order-db，跨域访问回到"编排层/op"两条受控路径。物理仍同库同事务（op 内 `dbTransaction` 包住）。

**4. 边 C 改走订单域 op，而非 handler 直接 require**
- 现状：`purchase-handlers.ts:294 require('./order-db')` 直接调 `findStyleColorImagePath`（`order-db.ts:934`）。
- 改法：`findStyleColorImagePath` 经已注册 op（preload + `ipc.ts` 三处登记）暴露，purchase 模块经 IPC 调。
  签名变了会在 `vue-tsc`/verify 红，而非静默。`oi_*` 是 4 模块 fan-in 枢纽，读能力应收口到订单域 op。

**5. 把"3 条跨域集成点"写入 AGENTS.md 基线 + 加 verify 守卫**
- 边 A/B/C 目前无人登记，且 A 已破 ADR-002。建议在 AGENTS.md §1.x 列"受控集成点"（每条：为何合法、谁负责、失败语义），
  并加 `verify` 守卫：`grep` 禁止 `*-db` 互相 import、禁止 handler `require` 非本域 db。防下一轮维护者复制破例。

## P2 — 接口面与可测性

**6. 为 oi_* 建稳定只读门面（read facade）**
- 现状：goods/purchase/today/order-cost 直接调 `orderDb.*`（findStyleColorImagePath / listOrdersPage /
  orderImageThumbBatch …），SQL 散落。改 `oi_*` schema 或任一查询，爆炸半径 = 4 模块。
- 改法：抽 `order-read-api.ts` 集中暴露 typed getters（含 `findStyleColorImagePath`），4 消费者依赖门面而非 `order-db` 内部。
  易 mock、依赖图可在门禁强制。

**7. 启动期一致性自检（数据健康指示）**
- 跨域数据最终一致（成本 sync、店铺解析），加启动/开库轻量自检，汇总成一格"数据健康"：
  ① purchase 快照新鲜度 vs `ae_cost_map` source='purchase'；② 有 `shop` 但 `sk_name_map` 无匹配的订单数；
  ③ 有 `oi_styles` 但 `oi_images` 为空的款色数。比现在单点首页卡更主动，先于用户发现静默失败。

## P3 — 不做什么（避免伪优化）

- **不要做物理分库**：已是单库，分库引入跨库事务复杂度且无收益。
- **ae_cost_map 双写者（auto/manual）靠 source 列隔离即可**：只需补一条测试断言"sync 不清 manual"，防 regression。

## 优先级小结

| 项 | 类别 | 收益 | 工作量 |
| -- | -- | -- | -- |
| 1 成本脏标记重算 | 正确性 | 消除静默缺口、崩溃自愈 | 中 |
| 2 店铺 shop_id FK | 正确性/数据完整性 | 归因确定性、DB 强约束 | 中（含回填） |
| 3 去 ae-db→order-db import | 架构 | 恢复 ADR-002 边界 | 小 |
| 4 边 C 走 op | 架构/可测 | 编译期守护 | 小 |
| 5 集成点登记 + verify 守卫 | 架构/防复发 | 防泄漏扩散 | 小 |
| 6 oi_* 只读门面 | 可维护性 | 降爆炸半径 | 中 |
| 7 启动自检 | 可观测 | 主动暴露静默失败 | 小 |
