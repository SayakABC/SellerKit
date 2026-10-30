# 数据模型与依赖：39 条结论（蒸馏自 5 篇，2026-09-30 ~ 2026-10-29）

> **蒸馏笔记**：由 5 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/<原文件名>`

## 1. 全仓同处**一个** SQLite 文件：跨域是逻辑边界，不是物理隔离

**结论**：全仓 43 表**同处一个 SQLite 文件** `userData/sellerkit.db`（`electron/db.ts:37` 单例 `initDb()`，`foreign_keys=ON` + WAL；各 `*-db` 调 `getDb()` 拿同一连接）。所以"跨域"是**逻辑/代码归属边界**，不是物理隔离——JOIN 跨 `oi_*/pl_*/ae_*/sk_*` 是直接可行的（见首轮 JOIN 取证）。问题落在两类：
① **模块互相认识**（db 层/ handler 层跨域 import）；② **最终一致性靠异步补**（成本同步、店铺解析）。

**取证**：`electron/db.ts:37` 单例 `initDb()`；`electron/db.ts:40` 的 `foreign_keys = ON`（套装笔记引用同一行）。

**源**：`2026-10-15-data-dependency-optimizations`（2026-10-15）

---

## 2. 成本同步应改「脏标记 + 后台重算」，取代"写后置同步"

**结论**：现状是 `purchase-handlers.ts:25` 的 `withCostSync` 在每次拿货写后**同步**调 `syncPurchaseCosts()` 重算 `ae_cost_map`(source='purchase')；失败 `try/catch` 仅日志 + 首页"缺成本 N 行"卡。
风险：拿货单写成功、但进程在 sync 前崩 / sync 抛错被吞 → 成本缺口**无自动恢复**（正是历史 bug 同类）。
改法：拿货写只置 `purchase_dirty`（KV，复用 `sk_mail_meta` 式单例表或 `sk_schema_migrations` 旁）；debounce 后台 job（或下次启动）基于 `purchase-db.costSnapshot()` 重算。用户点击不再依赖"当次 sync 成功"，崩溃可自愈。呼应 working-memory 的"静默失败三件套"。

**取证**：`purchase-handlers.ts:25` `withCostSync`；缺口现象另见 §37（`ae_cost_map` 0 行而明细 12 行有价）。

**源**：`2026-10-15-data-dependency-optimizations`（2026-10-15）

---

## 3. 店铺归属应落「原文 → 解析后的 `shop_id`（FK）+ 保留原文」

**结论**：现状 `order-assign-shop`（`order-handlers.ts:169` → `order-db.ts:1559`）只写 `oi_orders.shop`（原文）；规范名在 `sk_name_map`/`sk_shops`，靠人工 `shopMap` 对账。两套表示 → 按店归因利润/成本可能分叉。
改法：`oi_orders` 加 `shop_id`（FK→`sk_shops.id`，库已 `foreign_keys=ON`），assign 时用 `shopName.ts` 归一→解析 `sk_name_map`→写 `shop_id`；原文留作审计列。回填存量（已有 shopMap 即可）。
收益：店铺归因确定性、DB 强制引用完整、利润按店汇总不再靠字符串匹配。
风险点：回填要处理"原文在 name_map 但无 shop_set"的孤儿；先给 `shop_id` NOT NULL 默认值 0（与现有未登记桶约定一致）。

**取证**：`order-handlers.ts:169` → `order-db.ts:1559`（`order-assign-shop` 只写 `oi_orders.shop`）。

**源**：`2026-10-15-data-dependency-optimizations`（2026-10-15）

---

## 4. 【历史记录】"消除 `ae-db → order-db` 模块级 import"的建议 **未采纳，且前提有误**

**结论**：原文写"**唯一一处** db 模块互相 import"，**实测有 6 条**（`scripts/check-cross-domain-edges.mjs` 扫出：ae→order、order→product、picking→product、purchase→product、shop-item→shop、shop-product→product）⇒ 按原方案要一次改 6 处（含 5 处与本次审查无关的既存边）。
且 A 边是 C1 刻意的方向（`order-db.ts` 注释："汇率属 ae 域，让 order-db 读别的域才是跨域耦合"），形态是单一具名函数。⇒ 改为**"逐条在册 + 编译期看住"**。
原建议原文（保留）：`ae-db.ts:36 import { upsertCollectedOrder } from './order-db'` —— **唯一一处 db 模块互相 import**，违反 ADR-002"db 模块互不认识"；改法是把"采集帧→折算→落 oi_orders"拆两步，ae 域只负责读 `ae_rates` 折算（`aeRateConvert` 纯函数/ae 域），落库交给订单域已注册 op（如 `order-collect-batch`，在 order-handlers 注册），ae-receiver 先折算再调订单域 op；ae-db 不再 import order-db，跨域访问回到"编排层/op"两条受控路径。

**取证**：`scripts/check-cross-domain-edges.mjs` 扫出 6 条边；处置结论见 §6 与 `2026-10-15-table-necessity-review.md` §二 P1-4。

**源**：`2026-10-15-data-dependency-optimizations`（2026-10-15，状态回填于同日傍晚）

---

## 5. 【历史记录】"边 C 改走订单域 op / 经 IPC 调" **未采纳**

**结论**：`findStyleColorImagePath` **本来就是订单域导出的公开函数**，调用点补 `as typeof import(...)` 后签名变更**编译期就会红**（已实证）；而"主进程 handler 调 renderer 面的 IPC op"在本仓不是既有分层（`DB_OPS` 是给 UI 岛用的），绕一圈反而错位。⇒ 改为**补类型标注 + 守卫**。

原建议原文（保留）：现状 `purchase-handlers.ts:294 require('./order-db')` 直接调 `findStyleColorImagePath`（`order-db.ts:934`）；改法是把 `findStyleColorImagePath` 经已注册 op（preload + `ipc.ts` 三处登记）暴露，purchase 模块经 IPC 调；签名变了会在 `vue-tsc`/verify 红，而非静默。`oi_*` 是 4 模块 fan-in 枢纽，读能力应收口到订单域 op。

**取证**：`purchase-handlers.ts:294` 直接 `require('./order-db')`；`order-db.ts:934` 是 `findStyleColorImagePath`。

**源**：`2026-10-15-data-dependency-optimizations`（2026-10-15，状态回填于同日傍晚）

---

## 6. "跨域集成点登记 + verify 守卫" **已采纳**，但守卫形态按实测结论改（白名单在册）

**结论**：原建议"`grep` 禁止 `*-db` 互相 import"一上线就会因上述 **6 条既存边**而红 ⇒ 改为**白名单在册（比对每条边取用的符号清单）** + `require('*-db')` 必带类型标注。
原建议原文（保留）：边 A/B/C 目前无人登记，且 A 已破 ADR-002。建议在 AGENTS.md §1.x 列"受控集成点"（每条：为何合法、谁负责、失败语义），并加 `verify` 守卫：`grep` 禁止 `*-db` 互相 import、禁止 handler `require` 非本域 db。防下一轮维护者复制破例。

**取证**：落地形态即 `scripts/check-cross-domain-edges.mjs`（规则 A/B、`DB_EDGES` 6 条、空转基线 `MIN_DB_REQUIRES=3` / `MIN_DB_EDGES=4`、5 组变异复核），详见 `2026-10-15-table-necessity-review.md` §二 P1-4 处置记录。

**源**：`2026-10-15-data-dependency-optimizations`（2026-10-15，状态回填于同日傍晚）

---

## 7. 为 `oi_*` 建稳定只读门面（read facade）

**结论**：现状 goods/purchase/today/order-cost 直接调 `orderDb.*`（findStyleColorImagePath / listOrdersPage / orderImageThumbBatch …），SQL 散落。改 `oi_*` schema 或任一查询，爆炸半径 = 4 模块。
改法：抽 `order-read-api.ts` 集中暴露 typed getters（含 `findStyleColorImagePath`），4 消费者依赖门面而非 `order-db` 内部。易 mock、依赖图可在门禁强制。

**取证**：`2026-10-15-data-dependency-optimizations` P2 第 6 条（4 个消费者：goods / purchase / today / order-cost）。

**源**：`2026-10-15-data-dependency-optimizations`（2026-10-15）

---

## 8. 启动期一致性自检（"数据健康"一格）

**结论**：跨域数据最终一致（成本 sync、店铺解析），加启动/开库轻量自检，汇总成一格"数据健康"：
① purchase 快照新鲜度 vs `ae_cost_map` source='purchase'；② 有 `shop` 但 `sk_name_map` 无匹配的订单数；③ 有 `oi_styles` 但 `oi_images` 为空的款色数。比现在单点首页卡更主动，先于用户发现静默失败。

**取证**：`2026-10-15-data-dependency-optimizations` P2 第 7 条（三个指标原文照抄如上）。

**源**：`2026-10-15-data-dependency-optimizations`（2026-10-15）

---

## 9. P3「不做什么」：不做物理分库；`ae_cost_map` 双写者靠 `source` 隔离

**结论**：
- **不要做物理分库**：已是单库，分库引入跨库事务复杂度且无收益。
- **`ae_cost_map` 双写者（auto/manual）靠 source 列隔离即可**：只需补一条测试断言"sync 不清 manual"，防 regression。

**取证**：`2026-10-15-data-dependency-optimizations` P3 两条（原样）。

**源**：`2026-10-15-data-dependency-optimizations`（2026-10-15）

---

## 10. 优先级小结（7 项，原文表）

| 项 | 类别 | 收益 | 工作量 |
| -- | -- | -- | -- |
| 1 成本脏标记重算 | 正确性 | 消除静默缺口、崩溃自愈 | 中 |
| 2 店铺 shop_id FK | 正确性/数据完整性 | 归因确定性、DB 强约束 | 中（含回填） |
| 3 去 ae-db→order-db import | 架构 | 恢复 ADR-002 边界 | 小 |
| 4 边 C 走 op | 架构/可测 | 编译期守护 | 小 |
| 5 集成点登记 + verify 守卫 | 架构/防复发 | 防泄漏扩散 | 小 |
| 6 oi_* 只读门面 | 可维护性 | 降爆炸半径 | 中 |
| 7 启动自检 | 可观测 | 主动暴露静默失败 | 小 |

**源**：`2026-10-15-data-dependency-optimizations`（2026-10-15）

---

## 11. 「基础数据」整合的判据是「**入口唯一**」，不是"这一页太长"

**结论**：整合前：进价录入在「货与成本 › 进价」、汇率维护在「算钱 › 成本与汇率」半区、店铺登记在两个模块**各有一份实现**。用户为了记一家供应商要先猜"它在哪个模块的第几个页签"；两份实现则意味着改一处忘一处。
⇒ 沿用 `2026-09-30-plugin-vs-host-boundary.md` 的「入口唯一」铁律：**能力只能有一个家**，别的页面想用它就跳转过去，不做平级第二入口。

**取证**：用户口径原文 —— **基础数据维护相关功能整合到一起，让操作更简单、降低学习熟悉成本；不要太多文案，用交互设计层面改善**，让不会用电脑的人也能快速上手。实施 2026-10-14（模块改造 + 界面重设计），门禁与文档收口 2026-10-15。

**源**：`2026-10-15-master-data-consolidation`（2026-10-15 / 实施 2026-10-14）

---

## 12. 左导航 + 右内容区，且默认落在第一项

**结论**：`src/modules/shop-accounts/MasterDataView.vue`（392 行，替下 1,595 行的四页签旧视图）：左导航六资料种类（店铺账号 / 邮件 / 店铺登记 / 企业 / 供应商 / 成本与费率）+ 右内容区。
延续 `2026-10-08-goods-page-entry-guide.md` 的结论：**并列的入口等于没有起点**。所以默认 `mainTab='accounts'`，而不是让用户面对六个并列项自己挑。

**取证**：`MasterDataView.vue` 392 行 vs 旧视图 1,595 行；六项 id：店铺账号 / 邮件 / 店铺登记 / 企业 / 供应商 / 成本与费率。

**源**：`2026-10-15-master-data-consolidation`（2026-10-15）

---

## 13. 跨模块跳转是**字符串协议**：两处必须同一份清单

**结论**：`switchModule('shop-accounts', <action>)` 的 action 落到 `MasterDataView` 的 `KINDS.some(k => k.id === id)`。写错不报错（TS 帮不上忙，它是运行时字符串），表现为**"跳过去停在上次那一项"** —— 用户看到的是"按钮没反应"，不是报错。
⇒ `tests/shopAccountsIntake.spec.ts` 钉两件事：左导航六项的 id 与跨模块 action **同一份清单**；落地时必须校验 action 在 KINDS 里（否则任意字符串都能当选项 = 静默无变化）。

**取证**：`KINDS.some(k => k.id === id)`；`tests/shopAccountsIntake.spec.ts`。

**源**：`2026-10-15-master-data-consolidation`（2026-10-15）

---

## 14. 回程竞态：`activateCore` 的早退守卫会让"切回"静默失效

**结论**：**根因** —— `pm.activate()` 是异步的，`activeId` 在最后才更新。在途激活未完成时 `activateCore('order-cost')` 命中 `src/core/AppShell.vue` 的早退守卫 `if (id === activeId.value && activeView.value) return;`（此时 `activeId` 仍是 `order-cost`）⇒ **静默返回，哪都没去**；随后 shop-accounts 激活完成、消费掉 action marker。
**修法（冒烟侧）**：切回前先等目标模块真的落地 —— `.md-view` 在场 **且** `[data-act="kind-cost"]` 带 `is-active`（顺带确保 marker 已被消费），再派发切回事件。
⭐ **只等 `.oc-view` 会被骗绿**：早退命中时旧视图还没被卸掉，`.oc-view` 一直在。所以回程判据必须**双向**：`.oc-view` 在 **且** `.md-view` 不在。

**取证（现象）**：`order-profit:ui` 在 `cost-rates` 步点「去维护」跳走、紧接着派发 `switch-module` 想切回 `order-cost`，后续 `empty-state` 步超时。调试副本 dump 的现场：

```
DEBUG navs=[{"moduleId":"shop-accounts","action":"cost"},{"moduleId":"order-cost"}]
DEBUG activeModuleHint=店铺账号← 人还停在「基础数据」
DEBUG hasOcView=false / refreshBtn=missing
```

**源**：`2026-10-15-master-data-consolidation`（2026-10-15）

---

## 15. 只读化 + 写入口唯一；反向守卫 = 录入控件整批消失 **且** 0 次 upsert

**结论**：「算钱」页汇率区改只读展示（`rate-value-USD`），区头「去维护」跳转基础数据。
守卫钉两件事，缺一不可：
- 录入控件**整批**没有：`rate-input-USD` / `rate-save-USD` / `rate-add` / `rate-new-cur` / `rate-new-value` 五个选择器全无，且 `.cr__table--rates input` 计数为 0；
- 本页**一次写入都没发过**：`calls('aeRateUpsert').length === 0`（只断言"没有控件"不够 —— 控件可以藏起来而写入照发）。

写入闭环（改既有 / 新增币种 / 币种码归一）随录入一起搬去 `master-data:ui` 的 `rates` 步。

**取证**：`rate-value-USD` / `rate-input-USD` / `rate-save-USD` / `rate-add` / `rate-new-cur` / `rate-new-value`；`calls('aeRateUpsert').length === 0`。

**源**：`2026-10-15-master-data-consolidation`（2026-10-15）

---

## 16. 文档要跟着搬家走：计数表一旦漂移就不再是权威

**结论**：`verify:docs` 抓到三处**搬家后没跟着走的引用**：`CostPane.vue`、`SupplierView.vue`（goods → shop-accounts）、`ShopAccountsView.vue`（改名 `MasterDataView.vue`）。
`docs/baseline/PROJECT_BASELINE.md` 的「最大的 10 个文件」表也停在搬家前，且榜首以下名次全变（`order-db.ts` 1,796 → 2,269）—— 按该文件自己的复现命令重数，并就地标注刷新日期与原因。**计数表一旦漂移就不再是权威**，而本项目多处判断（单模块体量、技术债）都引它。

**取证**：`order-db.ts` 1,796 → 2,269；三处失引用文件如上。

**源**：`2026-10-15-master-data-consolidation`（2026-10-15）

---

## 17. 本轮复发的四个老坑（都不是新坑）

**结论**：
1. ⭐⭐ **扫描型守卫的固定 I/O**：`shopAccountsIntake` 的两次全量扫描写在 `it` 里，随模块涨到 26 文件顶穿 vitest 5s 默认超时 —— 报出来是 `Test timed out`，看着像守卫失败。正是 `2026-10-03-fixed-cost-outside-timed-test.md` 记过的坑；按该笔记把扫描提到模块作用域 + 记忆化文件读取，用例 5.3s → 208ms。
2. ⭐⭐⭐ **残留模态看不见**：导入那一步打开「导入产品」弹层后**整段没关**，而后续 step 的 `.click()` **绕过命中测试**，于是一路"绿"，直到可达性断言（走 `elementFromPoint`）才红 —— 红的是可达性，看着却像布局坏了。判据：`covered-by` 栈里有没有 `wb-mask` / `wb-dialog`。该弹层的 ✕ 与「完成」原先**没有 `data-act`** ⇒ 冒烟根本没法按锚点关它，补 `import-close` / `import-done` 两个锚点后才关得掉。
3. ⭐ **helper 返回类型要看清**：`mapFlat` 返回 **join 过的字符串**，按数组写（`tabNames.length === 1 && tabNames[0] === …`）在字符串上恒假 —— 而 detail 打印出来正是那一个页签名，**看着"数据没问题"，实际这条永远红**。
4. ⚠️ **注入脚本模板串**：`node --check` 对这类脚本**不充分** —— 注释里的反引号提前闭合模板后，若剩余文本恰好仍语法合法就能放过去（实测：`.click is not a function` 报到运行期才暴露）。判据只能是实跑。

**取证**：用例 5.3s → 208ms；`import-close` / `import-done` 两个锚点；`.click is not a function` 报到运行期。

**源**：`2026-10-15-master-data-consolidation`（2026-10-15）

---

## 18. 包裹模型 `parcels` + `parcel_lines`：一单多包，件数可拆

**结论**：`parcels` + `parcel_lines` 两张表（**新增、不改老表**）+ 「归类核对」行内「拆包」抽屉；一个订单可以装成多个包，**一个商品行的件数可以拆到两个包里**；总运费/总重是 Σ 包裹（派生，不落库），**任一个包缺值就是 null，不是"已知部分之和"**。

**取证（数据模型，照抄）**：

```
parcels(id, order_no, label, tracking_no, carrier, ship_cents, weight_g, note, created_at, updated_at)
parcel_lines(id, parcel_id → parcels, order_item_id → oi_order_items, qty, created_at,
             UNIQUE(parcel_id, order_item_id))
```

四条口径（改表前先读）：
1. **键是 `order_no`，不是订单主键**：B1 拆表前 `oi_orders` 一行 = 订单×商品图，一单天然多行、没有"订单主键"可指。`order_no` 是这单的唯一身份（AE 订单号全局唯一），B1 拆出订单主表后它正好就是主表的业务键，**数据不用改**。
2. **`ship_cents` / `weight_g` 可空（NULL = 还不知道），不给 DEFAULT 0** —— 与 `oi_orders` 的金额列同一条纪律。0 是"这包没花钱"，混起来会把"缺运费"算成"零运费"，利润凭空变大。
3. **总运费 / 总重派生**（`parcelTotals`）：任一个包缺值 ⇒ 整单 `null` + `shipMissing/weightMissing` 计数。界面据此说"还有 N 个包没填"，**不报一个看起来正常的和**。
4. **`UNIQUE(parcel_id, order_item_id)`**：同一行在同一个包里只有一条记录，数量写在那一条上 —— "同一行在同一包里记两次"在结构上不可能。

状态：🟢 已落地（2026-10-21）· 数据层 + IPC + 拆包抽屉 + 两条守卫。归属：`docs/plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md` 阶段 B 的 **B2**（B1 拆表已于同日落地，行 id 约定见 `2026-10-21-order-table-split-b1.md`）。

**源**：`2026-10-21-parcel-model-b2`（2026-10-21）

---

## 19. 拆包规则**只有一处实现**：`setParcelLineQty`

**结论**：`electron/order-db.ts` 的 `setParcelLineQty(parcelId, orderItemId, qty)` 是**唯一写入口**。
"还能拆几件"只有一处算法（`parcelRemaining`）：界面显示与写入校验**共用**它。两处各减一遍，必然有一天界面放行、落库拒绝（或反过来超拆）。

**取证（规则表，照抄）**：

| 情况 | 行为 |
| --- | --- |
| `qty <= 0` | 从该包移除这一行 |
| 包与行**不属于同一张订单** | 拒绝，理由「这个商品行不属于该包裹所在的订单」 |
| 超过该行**还能拆**的件数 | 拒绝，理由带具体数字（「最多还能放 N 件」） |
| 该行 `qty` 未知（导入侧没解析出件数） | 不做上限校验（上限就是不知道），但仍要求 `qty > 0` |

**源**：`2026-10-21-parcel-model-b2`（2026-10-21）

---

## 20. 界面落点：**「今天 › 归类核对」行内「拆包」按钮 → 右侧抽屉**

**结论**：`src/modules/today/tabs/ParcelDrawer.vue`。
- 为什么在归类核对：这一页是"逐单干活"的地方，一单一行看得见订单号；拆包与核对是**两件事**（核对待定"这行是什么款"，拆包定"这些件怎么装箱"），所以**两个范围（待核对/已核对）都给这个入口**，且不占「保存 / 确认无误」那组动作的位置。
- 行内徽标「拆包 ×N」（`order-parcel-counts` 批量问一次）：解决"不记得自己拆过没"。关掉抽屉会重算 —— 徽标不更新等于"看不到自己做过的事"。
- 抽屉里：上面是**这单的商品行**（件数 / 已分包 / 还能拆 / 放入哪个包），下面是**包裹卡片**（包名 / 运单号 / 承运 / 运费元 / 重量克 + 箱内明细）。
- **每次写成功都用主进程回的整单状态重绘**，不做本地推测：拆包天然是"多个包互相挤件数"，本地推测和库不一致时，用户看到的是"我明明点了保存"。

**取证**：`src/modules/today/tabs/ParcelDrawer.vue`；IPC `order-parcel-counts`。

**源**：`2026-10-21-parcel-model-b2`（2026-10-21）

---

## 21. 与 B1（拆表）的耦合只有"行 id 不许重排"这一条

**结论**：
- `parcel_lines.order_item_id` 指向 `oi_order_items.id`；B1 迁移**原样保留**了拆表前的 `oi_orders.id`，所以包裹明细的数据一条没动（真实库对照：51/51 行 id 不变）。
- 订单级 `总物流费 / 总克重` **没有落库**：B2 定案由 `parcelTotals(order_no)` 实时派生（一个数字一处实现，不先存一份再等着漂移）。
- 因此 B2 与 B1 的耦合只有"行 id 不许重排"这一条 —— 它写进了 B1 的迁移不变量，有 `schema:smoke` 与真实库克隆双重守卫。

**取证**：真实库对照 51/51 行 id 不变。

**源**：`2026-10-21-parcel-model-b2`（2026-10-21）

---

## 22. 包裹守卫三层（怎么证明它没坏）

**结论**：三层断言，逐层照抄如下。

**取证**：

| 层 | 断言 |
| --- | --- |
| `scripts/order-db-smoke.cjs`［包裹］1 组 20+ 断言 | 拼错单号不造孤儿包 · 3 件拆 2+1 · 超拆被拒且理由含"还能放几件" · 跨单被拒 · **有包缺运费时总运费必须 null** · 补齐后才相加 · 改数量是覆盖不是追加 · 清 0 = 移出 · 删包连明细一起删 |
| `scripts/order-db-smoke.cjs`［9］4 条写入口守卫 | 空单号拒绝 · 导入不能往采集单追加 · **采集重推清包裹**（旧包 999 → 总运费必须变 null）· 采集不能替换导入单 |
| `scripts/today-ui-smoke.mjs`［parcel］7 条 | 入口在 · 徽标 ×2（真读 counts）· 抽屉开出来 · **出参单号非空** · 页头汇总 2 包/¥30.00 · **超拆被拒要显示理由** · **被拒后回读整单** · 新建包裹 2 包 → 3 包 |

> ⚠️ 这组 UI 断言当场抓到一个真 bug：拒绝理由被"回读"清空了（`load()` 开头清 `errorText`），界面表现为"点了没反应"。修法是**先回读、再挂理由**（`ParcelDrawer.setLineQtyValue` 里有注释）。这正是"假成功"最容易藏的地方：写操作失败 + 随后重绘 = 理由一闪而过。

**源**：`2026-10-21-parcel-model-b2`（2026-10-21）

---

## 23. 包裹的**生命周期收尾**（B1 一并落地）

**结论**：四种动作下的包裹处理各有约定。

**取证**：

| 动作 | 包裹怎么处理 |
| --- | --- |
| `deleteOrder(行 id)` | 明细被删后，**没有明细占着的空壳包一并删**；还装着别的商品行的包不动（`order-db.ts#deleteOrder`） |
| `clearAll()` | `parcels` 与订单/明细一起清空（不留孤儿包） |
| 采集重推同一单 | 整单替换会换掉全部明细 id ⇒ **先清该单的 `parcel_lines` + `parcels` 再替换**；否则旧包变空壳、继续污染 `parcelTotals` |
| 删单个包 | 显式先删 `parcel_lines` 再删包（不依赖连接级 `PRAGMA foreign_keys`） |

**源**：`2026-10-21-parcel-model-b2`（2026-10-21）

---

## 24. 包裹明确**没做**的两件事

**结论**：
- **运费没有接进利润**：`orderCost.ts` 仍读行级 `weight_g` 快照 + 运价表。`parcelTotals(order_no)` 已经可用，但"有包裹时用包裹总运费"的消费侧属于阶段 C 的前置。
- **没有"自动分包"**：按 SKU 行/重量自动装箱的规则没定，先只做人工拆。

**取证**：`orderCost.ts` 仍读行级 `weight_g` 快照 + 运价表。

**源**：`2026-10-21-parcel-model-b2`（2026-10-21）

---

## 25. 套装（一件实物多个款色）：组合定义上移到产品库，**一张关联表**

**结论**：起因是业务澄清「套装**不是整体色**，而是自由搭配（上衣红 + 裤黑）」＋「子商品也是独立商品，能单独卖」。
**落地形态就是「产品关联子商品」** —— 子商品是 `pl_products` 里自己的行（有自己的变体、成本、图片、订单），关联表只存关系，**不复制子商品的任何字段**（复制一份就是第二个真相：改子商品价格时套装那份静默过期）。

**取证（DDL，逐字照抄）**：

```sql
pl_bundle_links(product_id, item_id DEFAULT '', alias_key, role,
                child_product_id, child_color, qty,
                UNIQUE(product_id, item_id, alias_key, role))
```

**为什么键里必须有 `alias_key`（平台色号）**：关联的不是"这个套装 ↔ 那些子商品"，而是"**这个套装的这个色号** ↔ 那些子商品的那些颜色"。同一款套装：色号 8 = 红上衣+黑裤、色号 9 = 黑上衣+黑裤。少了色号这一列，两个色号会拆成同一堆东西 —— 拿货单上颜色就没了。而平台色号是**商品级编号**（真库实测 `"8"`，`pl_shop_items.sku_json` 是 `{"color":"8","size":"1"}`），名字里没有任何语义可推：`oi_color_aliases` 现存 5 条正是 `9804|9 → 橙色` 这种人工指认，套装配色就是它的**多值版**（一个色号 → N 个 (子商品, 色名)）。

**为什么不再拆"结构表 + 配色表"两张**（本日中间版本，已合并）：结构一旦独立出来，就必须回答"结构改了历史色号怎么算"，而配色**不可继承**（色号 7 是红黑，不能因为同款一般都是黑黑就套用）。合并后每个色号自成一组、整组替换，没有"模板回落"这条会猜错的路径。

**查找优先级（点名 > 提示）**：`(商品ID, 色号)` → `('', 色号)`。商品级是"这件事就这么定"，产品级是"同款套装一般都这样"；顺序反了用户会以为没保存（变异验证：反转后红 1 条）。

**该色号没配过就 `matched: false`，绝不回落别的色号**。这是"数据精准"的底线：拿别的色号顶上，统计会**安静地给出错误的拿货单** —— 少发一条裤子是发货后才发现的事（变异验证：去掉色号过滤后 5 条红）。

**禁嵌套**：子商品本身是套装 ⇒ 写入处直接拒（`套装套套装`）。这是环的入口；一层对"两件套/三件套"够用，将来要嵌套必须同时补环检测与深度上限。

**尚未接线**（下一步）：`itemStyleColorIds()` 的三档回落（订单快照 → 关联展开 → 图款色）、展开结果经 `ensureStyleColor(childCode, 色名)` 落到 `oi_style_colors`、以及 5 处汇总口径（`purchase-db.outstanding` 等）。**在此之前页面行为零变化。**

**源**：`2026-10-28-bundle-parts-data-model`（2026-10-28）

---

## 26. 套装**不能拆订单行、也不能挂在图片上**；款色集合只有一个读取入口

**结论（行级部分，仍成立）**：套装**不能拆订单行、也不能挂在图片上**；一个订单行的款色集合只有一个读取入口 `itemStyleColorIds()` —— 有部件就用部件集，**绝不**把行/图上的单品款色并进来。
组合定义本身见 §25（产品库的 `pl_bundle_links`），`oi_item_parts` 退化为**归档快照**。老数据零迁移：表里没行 = 不是套装，行为与改造前完全一致。

**取证**：`oi_item_parts`（`electron/order-db.ts:438`）当行无行时即非套装；`itemStyleColorIds()`（`:3899`）。

**源**：`2026-10-28-bundle-parts-data-model`（2026-10-28）

---

## 27. 为什么**不能挂在图片上**（这一条最容易被想错）

**结论**：款色归属的唯一权威是 **`oi_images.style_color_id`**，不是 `oi_order_items.style_color_id`。

**取证**：
- 写入方只写图：`assignOrderStyle` 里只有 `setImageStyleColor(order.image_id, sc.id)`（`electron/order-db.ts:1542` 一带），从不写行级列；行级那列是 v8 拆表前的投影，只剩历史值。
- 所有读者都 JOIN 图：`listOrdersPage`（`electron/order-db.ts:2971`）、`shippingRows`（`:2869`）、采购需求（`electron/purchase-db.ts:374` / `:1126`）一律 `LEFT JOIN oi_style_colors sc ON i.style_color_id = sc.id`。
- 而那张图是**共享记忆**：`order-download-image` 按内容指纹命中即复用整行（连带 `style_color_id`），见 `electron/order-image-land.ts` 文件头。一张套装图挂上"上衣红"之后，同图在别的订单里出现就会被读成单品上衣，且**没有任何界面能纠正它**（用户看到的是"这单是上衣"）。

所以套装事实必须落**行级**（这张订单实际买了哪几件），并在读取时**压过**图级记忆。

**源**：`2026-10-28-bundle-parts-data-model`（2026-10-28）

---

## 28. 为什么**不能拆订单行**：四处会同时错，且都不报错

**结论**：一个套装拆成两条 `oi_order_items`，四处会同时错，且都不报错。

**取证**：

| 后果 | 取证 |
| --- | --- |
| 采购需求件数翻倍（1 套算 2 件） | 需求按 `style_color_id + size` 求和，`electron/purchase-db.ts:1104-1143` |
| 行级成本/克重各存一份 ⇒ 重复计入 | 列在 `ORDER_ITEM_COLS`：`cost_cents` / `actual_cost_cents` / `weight_g`（`electron/order-db.ts:252-257`） |
| 包裹/拣货粒度错（一个套装是一次发出） | `parcel_lines` 挂在 `order_item_id` 上（`electron/order-db.ts:371`） |
| `corrected` 变成两条要分别核对 | 待核对列表按行 |

**源**：`2026-10-28-bundle-parts-data-model`（2026-10-28）

---

## 29. `oi_item_parts` 表与三条设计取舍（每条防一类具体的错）

**结论**：`oi_item_parts`（`electron/order-db.ts:438`）：`order_item_id` / `role`（上衣、裤子…）/ `style_color_id`（NOT NULL）/ `qty_per_set`，`UNIQUE(order_item_id, role)`，`ON DELETE CASCADE`（`foreign_keys = ON` 在 `electron/db.ts:40`）。

三条设计取舍：
1. **`style_color_id NOT NULL`**：0 是 `oi_order_items.style_color_id` 的"未归属"哨兵。部件写 0 会让下游把它当一个真实款色去求和 ⇒ 拿货单多一行空白款。校验在 `replaceItemParts`（`electron/order-db.ts:3833`）。
2. **`UNIQUE(order_item_id, role)`**：同一件实物里"上衣"只有一个款色；同部位要两件用 `qty_per_set=2`。两条同 role 会让需求算重，也让"这个部位是什么款"没有唯一答案。应用层先按 `role.toLowerCase()` 判重（DB 的 UNIQUE 按字节比，挡不住 `Top` / `top`）。
3. **不存 `bundle_key`**：组合键是派生值（`bundleKeyOf`，`:3927`，形如 `12x1+57x1`，先排序再拼 ⇒ 录入顺序无关）。落库必然与部件表漂移。

**取证**：如上逐行引用的行号（`:438` / `:3833` / `:3927` / `electron/db.ts:40`）。

**源**：`2026-10-28-bundle-parts-data-model`（2026-10-28）

---

## 30. 读取口径 `itemStyleColorIds()`：有部件只返部件集，无部件回落**图**

**结论**：读取口径 `itemStyleColorIds()`（`:3899`）：有部件 ⇒ **只返回部件集**（图上残留的单品款色不许并进来，并进来 = 一件实物算两遍）；无部件 ⇒ 回落**图**的款色。回落顺序必须"图 → 行"，反过来会让历史行值压过后来人工改的归属。

**取证**：`itemStyleColorIds()`（`electron/order-db.ts:3899`）。

**源**：`2026-10-28-bundle-parts-data-model`（2026-10-28）

---

## 31. 「平台商品本身就卖套装」与「同一商品既卖单件又卖套装」两种都存在 ⇒ 只能靠行级事实

**结论**：不能用 `(item_id, spec)` 判断"这是套装"：同一 `item_id` 会同时出现单品行和套装行。所以：
- 判定一律看 `oi_item_parts` 有没有行，**不看商品级记忆**；
- `pl_shop_sku` 只能当"建议模板"，且必须能表达"混卖"（同一商品的部件模板只作提示，不自动套用）。

**取证**：`oi_item_parts` 有行为唯一判据；`pl_shop_sku` 仅模板。

**源**：`2026-10-28-bundle-parts-data-model`（2026-10-28）

---

## 32. 【历史记录】P1「回流把套装固化成单品」已修：`pl_shop_sku.bundle_role`（该方案随后**作废**）

**结论（当时的修法，已修）**：`pl_shop_sku` 加列 **`bundle_role`**（`''` = 普通映射；非空 = 该商品此部位的部件）。只加了列，但**每处读写都要跟着换判据**，否则会更糟：

| 位置 | 判据 | 不改的症状 |
| --- | --- | --- |
| `upsertSkuMappings` 的 `existing` 查询 | 套装行按 `(店, 商品, bundle_role)`；普通行额外带 `bundle_role = ''` | 套装各部位的 `spec` 都是 `'*'`，按 spec 判重会让"写裤子"命中"上衣"那行并 UPDATE 它 ⇒ 上衣映射静默消失、回执还报 updated |
| `resolveOrderSku` | 加 `AND bundle_role = ''` | 套装商品的映射会被当成"整行归款"⇒ 整行归成上衣、裤子消失，而且因为有归属不进待核对队列，**没有任何机会被发现** |
| `skuBackfillFromOrder` | 检测到行有部件 ⇒ 逐部位写、`spec='*'`、同部位改绑判 `conflict` | 走单品路径写一条，等于把套装固化成单品 |
| `resolveOrderBundle`（新增） | 返回 `bundle_role <> ''` 的行，供 P2 带出部件模板 | — |

两条纪律：
- **套装的映射不是"歧义多值"**。`resolveOrderSkuList` 的多行是"这个商品可能是 A 款或 B 款"，而套装的多行是"它必然由 A 和 B 组成"。两者在表里长得一样（同 `item_id` 多行），语义相反 —— 所以 `resolveOrderSku` 必须过滤掉部件行，绝不能拿"多值"当歧义去挑一条。
- **同部位改绑一律 `conflict`**，与单品同一条纪律：在这里顺手改等于把这个商品**所有**历史套装行一起改判，而用户此刻只看了一单。真要改绑走「商品ID 映射」页。
- `skuBackfillFromOrder` 的套装分支**不调** `reassignOrdersByItemIds`：`resolveOrderSku` 对套装商品返回 null，回填对这些行本来就不动，扫一遍是白费。

迁移：`product.sku` v4 = `ensureSkuColumns`（幂等补列），`PRODUCT_SKU_STEPS` 3→4。
⚠️ `normalizeSkuUniqueKey`（v2 重建表）开头必须先跑 `ensureSkuColumns()`：它按 `SKU_COPY_COLS` 逐列搬数据，而这份清单随加列变长；停在 v1 的老库没有新列，直接 `SELECT` 会抛 `no such column` 并把整个迁移事务回滚（症状是"升级卡死"，报错却指向一句看不懂的 SQL）。

冒烟：`order-db-smoke.cjs` 的 `[11]` 节 6 条，断言全读**库里的行**而不看返回值。两处变异已验证：判重退回按 spec ⇒ 红 4 条；`resolveOrderSku` 去掉 `bundle_role = ''` ⇒ 红 2 条（其中就有"套装商品不自动归款"这条）。

**【历史记录】该方案已于同日第二轮迭代作废**：`pl_shop_sku.bundle_role`（一个商品按角色占多行映射）与新模型冲突 —— 新模型里一个商品**只映射一个套装产品**，搭配在 `pl_bundle_links` 里。更要紧的是 `resolveOrderSku` 被 P1 加上的 `bundle_role = ''` 过滤会让套装商品解析不到产品，展开就无从谈起。**接线前必须先退掉**（列 + 三处判据 + 那两条冒烟）。

**源**：`2026-10-28-bundle-parts-data-model`（2026-10-28）

---

## 33. 【历史记录】拣货的回落顺序与本口径**相反**（仍未修）

**结论**：`electron/picking-db.ts:121` 是 `COALESCE(NULLIF(oi.style_color_id, 0), i.style_color_id, 0)`（**行优先**），接入套装时必须改成走 `itemStyleColorIds`，**不要照着它抄顺序**。

**取证**：`electron/picking-db.ts:121` 的 `COALESCE(NULLIF(oi.style_color_id, 0), i.style_color_id, 0)`。

**源**：`2026-10-28-bundle-parts-data-model`（2026-10-28）

---

## 34. 套装台账 P2/P3 未做（页面行为不变）

**结论**：核对页的部件槽位、采购需求/拣货按部件展开都没做。P0/P1 都还没有界面能写入 `oi_item_parts`，所以现有页面行为不变。

**取证**：`2026-10-28-bundle-parts-data-model` 的「未做（P2/P3）」段（原文两句）。

**源**：`2026-10-28-bundle-parts-data-model`（2026-10-28）

---

## 35. 冒烟必须让**两条路径期望不同的值**

**结论**：`scripts/order-db-smoke.cjs` 的 `[10]` 节：套装行与单品行**都**先把图挂上同一个单品款色 `scA`，然后套装行写 `[上衣 scA, 裤子 scB]`。断言套装行只出 2 个而不是 3 个 —— 若实现把图款色也并进来就红。两条都期望同一个数（比如都期望 2）会让这个 bug 恒绿。
变异已验证：把 `.concat(999)` 塞进返回值（模拟"掺进杂物"）会让该条与"全量替换"一起变红；把回落写成恒 0 会让"无部件回落"与"清空后回落"一起变红。

**取证**：`scripts/order-db-smoke.cjs` `[10]` 节；`.concat(999)` 变异。

**源**：`2026-10-28-bundle-parts-data-model`（2026-10-28）

---

## 36. 顺带修掉的假绿：`schema:smoke` 场景 H 要**手工造表 + 退版本**

**结论**：`schema:smoke` 因上一轮加 v11（删 `oi_queue`）时漏改 `ORDER_MAIN_STEPS`，7 条断言一起红；补常数到 11，并在场景 H 里**手工造 `oi_queue` + 版本退到 v8**（让 v11 真的跑一遍）后断言它消失 —— 只建表不退版本，v11 早已记账完成、不会再执行，"表被删掉"会退化成"表压根没建过"的假绿。

**取证**：v11（删 `oi_queue`）· `ORDER_MAIN_STEPS` 常数 11 · 场景 H 退版本到 v8。

**源**：`2026-10-28-bundle-parts-data-model`（2026-10-28）

---

## 37. 填充率 ≠ 可用 —— 要看**取值分布**，不是有没有值

**结论**：`oi_orders.color` 填充率 **157/157 = 100%**，看起来"颜色数据齐全"。按取值分布一看：**62 行（39%）是 `Picture color` / `Image Color`** —— 这是平台的"以图为准"占位值，**根本不是颜色**。剩下的是中英文混杂（`black` 与 `黑色` 并存、`Red` 与 `红色` 并存）。
**判据**：用户说"这个字段只能靠肉眼/只能人工判断"时，**先 `GROUP BY` 看取值** —— 十有八九是"字段有值，但值是占位/原文/别名"，而不是"字段为空"。两者的解法完全不同：前者要**归一 + 定权威源**，后者要**补采集**。

**取证（只读连库，绝不改用户库）**：

```bash
python3 -c "
import sqlite3,os
p=os.path.expanduser('~/Library/Application Support/seller-kit/sellerkit.db')
c=sqlite3.connect(f'file:{p}?mode=ro',uri=True).cursor()   # mode=ro：只读，绝不改用户库
print(c.execute('SELECT color,COUNT(*) FROM oi_orders GROUP BY color ORDER BY 2 DESC').fetchall())"
```

**源**：`2026-10-05-gap-audit-read-the-real-db`（2026-10-05）

---

## 38. 主数据的工作量按**去重实体数**算，不是按行数；写时触发的同步**不回溯存量**；同一张表可能有不同**来源形态**

**结论（② 去重实体数）**："商品ID ↔ 产品"的映射表只有 3 行，直觉是"要建几百条"。实测：
- 42 行订单里的商品ID **去重后只有 17 个**；现有 3 条映射已覆盖其中 **26 行（62%）**。
- **判据**：任何"要给 XX 建映射/建主数据"的判断，先 `SELECT COUNT(DISTINCT <实体键>)`，别用行数吓自己。**一个商品ID/店铺/供应商 对应几十行订单是常态。**

**结论（③ 同步不回溯存量）**：`electron/purchase-cost-sync.ts` 在每次拿货写操作后自动同步成本 —— 但当前库里拿货单 3 张（全 `submitted`）、明细 12 行有价，`ae_cost_map` 却是 **0 行**：那几张单建在同步机制**上线之前**。
- **判据**：任何"以后自动同步"的新机制上线，都要单独问一句**"存量怎么补"**。本轮的表现是"货拿了、钱花了，利润里却没成本"——数字凭空变好看，且**不报错**。（这条在 `purchase-cost-sync.ts` 的文件头注释里已经写过一次，是同一个坑的第二次现形。）

**结论（④ 同表不同形）**：`oi_orders` 157 行的 `raw_fields` 有两种**完全不同的键集**：

| 键集 | 行数 | 来源 | 下游后果 |
| --- | --- | --- | --- |
| `{__migratedFrom, 采集帧}` | 115 | 老采集表迁移（v4） | **无产品ID、无图、未识别款** —— 拣货/取图/识别**全部静默失效** |
| `{店铺名,尺寸,订单号,下单时间,产品信息,产品数量,产品图片链接,产品ID}` | 42 | 新导入（芒果店长） | 正常 |

这 115 行全 `status='pending'`，会被拣货投影照收 → 157 行聚出 **75 组**，绝大多数是 `(未识别款)` 噪声。
- **判据**：诊断"某功能数据不对"时，先按 `raw_fields`（或等价 JSON 列）的**键集分组**数一遍。**"同表不同形"** 是迁移 + 新导入并存时的必现现象，而**按 JSON 字段解析的功能会对老形态静默失效**（取不到 → 按兜底值走 → 不报错）。

**取证**：157/157、62 行（39%）、42 行/17 个去重商品ID/26 行（62%）、拿货单 3 张（全 `submitted`）/明细 12 行有价/`ae_cost_map` **0 行**、115 + 42 = 157、聚出 75 组。

**源**：`2026-10-05-gap-audit-read-the-real-db`（2026-10-05）

---

## 39. 「代码只能告诉你系统能做什么，真实库才告诉你它现在有什么」

**结论**：**光读代码会得出方向性错误的结论** —— 本轮 3 个假设全部被真实库实测推翻。只读连库跑一组 count / distinct 就能避免，成本极低（半小时）。
**代码告诉你"系统能做什么"，只有真实库告诉你"它现在实际有什么"。** 做差距审查时先花半小时跑只读 `count / distinct / group by`，再动笔写方案 —— 否则会把"很容易的事"写成"大工程"，或反过来。

**取证**：本轮 3 个假设全部被实测推翻；只读连接串见 §37 的 `mode=ro` 脚本。

**源**：`2026-10-05-gap-audit-read-the-real-db`（2026-10-05）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-15-data-dependency-optimizations.md` | 2026-10-15 | §1 / §2 / §3 / §4 / §5 / §6 / §7 / §8 / §9 / §10 |
| `2026-10-15-master-data-consolidation.md` | 2026-10-15 | §11 / §12 / §13 / §14 / §15 / §16 / §17 |
| `2026-10-21-parcel-model-b2.md` | 2026-10-21 | §18 / §19 / §20 / §21 / §22 / §23 / §24 |
| `2026-10-28-bundle-parts-data-model.md` | 2026-10-28 | §25 / §26 / §27 / §28 / §29 / §30 / §31 / §32 / §33 / §34 / §35 / §36 |
| `2026-10-05-gap-audit-read-the-real-db.md` | 2026-10-05 | §37 / §38 / §39 |
