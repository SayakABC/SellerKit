# 成本两字段落地（阶段 C2）：产品当前价 + 订单行「进价 / 实际进价」

> 2026-10-21。设计定稿见 `docs/plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md` §5 与
> `docs/notes/2026-10-21-order-purchase-model-simplify.md` §9；本篇只记**落地后的真实形状**与踩到的坑。
> 本篇覆盖「写口搬迁 + 读侧改接 + 回填迁移 + **删表**」全流程（删表见 §6）。

## 一、现在成本只有三处，各有唯一写者

| 字段 | 语义 | 唯一写者 | 时点 |
| --- | --- | --- | --- |
| `pl_products.cost_cents` | **当前进价**（供新单估算） | `product-cost-set` / 产品导入 / 编辑抽屉（都经 `upsertProduct` / `setProductCostByCode`） | 随维护更新，不回写历史 |
| `oi_order_items.cost_cents` | **进价（预估）**：确认那一刻产品当前价的拷贝 | `order-db.snapshotOrderCosts`（归类核对「确认无误」/ 全部确认） | 一次；之后产品改价不漂移 |
| `oi_order_items.actual_cost_cents` | **实际进价（拿货实付）** | `purchase-cost-sync.syncOrderRowCosts`（拿货落账后） | 只补空、按拿货日期先到先得、按款色 id + 尺码匹配 |

利润取数**只有一处实现**：`src/lib/orderCost.ts` 的 `actual > 0 → snapshot`，
否则 `estimate > 0 → estimate`，否则 `none`。**0 一律是缺失**，没有 `cost_source` 列。

## 二、v9 迁移为什么是这个顺序

`order.main` v9（`electron/order-db.ts#migrateOrderCostSplit`），顺序不可换：

1. 加 `actual_cost_cents`；
2. 存量 `cost_cents > 0` 搬进 `actual_cost_cents`（v7 起这列实际只装拿货实付）；
3. 清空 `cost_cents`（从此只放预估）；
4. 按**下单日期**从旧 `ae_cost_map` 取当时生效价回填预估（挑法与旧 `pickCostInterval` 逐字一致：
   ≤ 下单日的最后一条，没有则最早一条；未归类行没有款级价 → 留 NULL）；
5. **从拿货单补一次实付**——不能等"下次拿货写操作"。真实库里那 1 行实付 32 的订单，下单时价目表是 28；
   不在这里补，它会从 32 暂时掉回 28（数字凭空变了，用户只会认为坏了）；
6. 把价目表每款**最新**价镜像进 `pl_products.cost_cents`——产品表当时全是 0，不搬 = 删表把价扔掉。

`scripts/schema-migration-smoke.cjs` 场景 [H] 钉住这六步（含"未归类留空""产品价只补空""幂等"）。
这段迁移是**冻结代码**：日后删掉 `ae_cost_map` 也不用改它，`tableExists` 会让第 4/6 步整体空转。

## 三、读侧落点

- 利润页：`orderShippingRows` 已带 `actualCostCents` / `costCents`（B1 后从明细表投影），引擎不再查任何价目表。
- 拣货：`picking-db` 行投影带三档（`actualCostCents` / `costCents` / `productCostCents`），
  优先级只在 `src/lib/picking.ts#aggregatePicking` 一处；`PickingView` 自己不取价。
- 「货品档案」列表：「进价」列读 `pl_products.cost_cents`（`useProductList.loadCosts`），不再有价目表回落。
- 「今天」缺口卡：`hasCost = 行上 actual > 0 或 estimate > 0`，再叠加 `productPricedCodes`
  判断"这行还钉不钉得上"（`TodayView.vue`）。

## 四、守卫都放在哪里（都是"静默失效"型）

1. **零调用反向守卫（删表前）**：`today:ui` 与 `order-profit:ui` 的假桥曾保留 `aeCostMapList` 桩（回空数组 + 记调用），
   断言"一次都没调过"。**删表时这两个桩与断言一起删了** —— 通道已从 preload 消失，再留着桩只会把
   "调用了不存在的 API" 伪装成成功（假桥兜底 `{success:true,data:null}`），守卫反而变成掩护。
   现在的守卫是类型层：`ElectronAPI` / `ipc.ts` / `host.ts` 里都没有这条能力，页面写回去 `vue-tsc` 直接红。
2. **夹具要能区分两档**：`today:ui` 的 S2 只填 `costCents=1000`（走"预估"那档，金额 10.00），
   S1/S3 三档全空（走"无进价"）。全填或全空都抓不到优先级接错。
3. **`product-cost-set` 的 `updated`**：同值重写返回 `updated:false`，界面说「没有改动」而不是「已保存」。
   `product:smoke` 两个回执都断言（只有 `found` 是抓不到"保存了但其实没写"的）。
4. **界面反向守卫**：`master-data:ui` 钉住进价页**没有**「来源 / 生效日 / 区间」列、没有 `cost-source` /
   `cost-row-expand` 锚点；回显里出现这些词也红（撤掉的概念不许从半路爬回来）。
5. **截图脚本的页签切换**：`goods:shot` 拍完「产品管理 › 进价」必须切回「建档与关联」并重新展开一行，
   否则后面两张（SKU 矩阵 / 建款向导）永远跳过——而它们只是"没打开"，看起来像夹具问题。

## 五、本轮改到的脚本

- `scripts/today-ui-smoke.mjs`：`PICK_ROWS` 改行投影三档；**删表时移除 `aeCostMapList` 桩与零调用断言**。
- `scripts/goods-ui-smoke.mjs`：删 `COSTS` 夹具与三个 `aeCostMap*` 桩；进价只由产品行承载。
- `scripts/master-data-ui-smoke.mjs`：回显断言改为「款名 + 当前价」并反向钉住旧概念。
- `scripts/product-db-smoke.cjs`：`setProductCostByCode` 断言补齐 `updated` 两种回执。
- `scripts/ae-cost-smoke.cjs`：**删表时大幅收窄** —— 移除「老库迁移 / 导入语义 / 手工成本 / 产品镜像」四组
  （写口与表都没了），只留快照分组 + 采集落主干两条，并加"新库不长 `ae_cost_map`"的反向守卫。
- `scripts/schema-migration-smoke.cjs`：`ORDER_MAIN_STEPS` 9 → 10；[D] 增"ae 域单独跑不删表 / order 跑完才删"；
  新增 [D2]（order 域先跑、价目表还是 v1 之前的形状）；[H] 自建旧表并断言 v10 删表。
- `scripts/goods-shot.mjs`：进价截图改走 `kind-tab-cost`，拍完切回 `kind-tab-goods`。

## 六、删表（`order.main` v10）

删掉的东西：`ae_cost_map` 表（`DROP TABLE IF EXISTS`）、`ae-cost-map-import / -list / -upsert-manual / -delete-manual`
四条通道、`ae-db` 的 `costMapReplace / costMapUpsertManual / costMapDeleteManual / costMapList / upsertCostRow`
与四个成本类型、`electron/manual-costs.ts`、host 的 `ae.costMapList / ae.costMapImport` op、
`src/types.ts` 的 `AeCostMapItem / AeCostMapImportItem / ManualCostItemInput`、产品导入载荷里已无消费者的
`effectiveFrom`。

**删除为什么挂在 `order.main` v10、而不是 ae 域 v4**：v9 要**先**从这张表把预估回填进订单行；
两个域的 schema 各自懒初始化，谁先跑不确定。若删表在 ae 域，它可能先于 v9 执行，回填源就没了。
放在同一域、紧跟 v9，顺序由版本号钉死（`ORDER_MAIN_STEPS = 10`，冒烟 [D]/[D2]/[H] 三处钉住）。

**v9 的读取要容忍"表还是旧形状"**：若 order 域先跑，`ae_cost_map` 可能连 `effective_from` 都没有
（ae.main 还没迁移到 v1）。`readLegacyCostIntervals` 用 `PRAGMA table_info` 判列，缺列时把生效日当
`'0000-01-01'`、排序里去掉该列 —— 否则 v9 会 `no such column` 直接炸掉整个迁移。冒烟 [D2] 的场景
就是"order 先跑 + 旧形状表"。

**真实库状态（2026-10-22 实测 + 克隆验证）**：`~/Library/Application Support/seller-kit/sellerkit.db`
已是 `order.main=9`（v9 的两字段与预估回填早已落库）、`ae.main=3`、`ae_cost_map` 21 行。
把它 `cp -c` 克隆到临时目录后跑一次 `ensureOrderSchema()`（**不碰运行中的真库**）：v10 删表成功，
47 单 / 51 明细行数不变，实付 1 行 ¥32.00、预估 37 行合计 ¥1,116.00、产品当前价 17 款合计 ¥503.00
逐项原样，`PRAGMA foreign_key_check` 零孤儿。**真库本身要等 app 下次启动才跑 v10**——
正在运行的进程按 v9 假设工作，不要中途手工删表。

