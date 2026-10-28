# 订单-采购模型简化 — 分阶段执行计划

> **状态**：🟢 **阶段 A 完成**（A1–A8 全部落地；A2 改判不加列、A3 由 B2 的包裹汇总替代）· 🟢 **B1 拆表完成** · 🟢 **B2 包裹完成** · 🟢 **C1 运费接进利润完成** · 🟢 **C2 两字段 + 回填 + 读写改接 + 删表全部完成**（2026-10-21；删表 = `order.main` v10）· **本计划收口**
> **读者**：架构 / 开发者
> **目标**：利润/对账数据源收敛到「订单表 + 订单商品关联表 + 包裹表」，退役 `ae_cost_map`
> **前置阅读**：`docs/notes/2026-10-21-order-purchase-model-simplify.md`、`docs/plans/ORDER_ATTRIBUTION_WEIGHT_PLAN.md`、`docs/plans/PRODUCT_SKU_LINKING_PLAN.md`

---

## 0. 执行记录（2026-10-21）

| 任务 | 状态 | 实做 |
| --- | --- | --- |
| A1 产品表进价 | ✅ | `pl_products.cost_cents` + 抽屉字段 + 导入同写 + 过渡镜像 `ae_cost_map` |
| A2 SKU 图 | 🔁 **改判：不加列** | 现有「色图」链路已完整（`oi_style_colors`+`oi_images.style_color_id`，SKU 矩阵逐色显示）。加 `pl_variants.image_id` = 同一语义第二处存储 |
| A3 订单级 `总克重/总物流费` | ⏸ **不做落库** | 原计划"拆表后落到订单主表"；B2 定案改为 **Σ 包裹实时派生**（`parcelTotals`，任一包缺值 ⇒ null）。一个数字一处实现，不先存一份再等漂移 |
| A4 行级克重 | ✅ | `oi_orders.weight_g`（v7）+ `snapshotOrderWeights()`，归类核对「确认无误/全部确认」时钉（B1 拆表后该列随行级字段在 `oi_order_items`） |
| A5 行级实际进价 | ✅ | `oi_orders.cost_cents`（v7）+ `syncOrderRowCosts()`，拿货落账后回写（只补空、按身份+尺码；B1 后同上）。⚠️ 该列当时装的是**实际进价**；C2 定稿后拆成 `cost_cents`（进价/预估）+ `actual_cost_cents`（实际进价），见 §5 |
| A6 手工进价落点 | ✅ | 落点仍在 `ae_cost_map`，但**镜像收进 `applyManualCosts` 内部**（成本面板 + 产品导入 + 产品抽屉三处同源）；回执带 `productsSynced/productsMissing`，产品库没该款时界面明说"价只记在成本表" |
| A7 利润改读快照 | ✅ | `orderCost.ts` 快照优先 + 缺失回落；行上多两个 `costSource/weightSource`（`snapshot` / `costmap` / `lookup` / `none`），利润页悬停能看出这个数是"实付"还是"估算" |
| A8 门禁 | ✅ | tsc / vue-tsc / verify / verify:docs / build / vitest(813) / schema / order / product / ae:smoke / `order-profit:ui` / `goods:ui` / `master-data:ui` / `today:ui` 全绿 |
| B1 拆表 | ✅ | `order.main` v8：`oi_orders`（一单一行，`order_no UNIQUE`）+ `oi_order_items`（一 SKU 一行，**旧行 id 原样保留**）；下游读写同一批改写；三个写入口加了空单号/通道互斥/重采集清包裹守卫 |
| B2 包裹 | ✅ | `parcels` + `parcel_lines`（qty 可拆）、总运费/总重由 `parcelTotals` 派生（缺值 ⇒ null）、归类核对拆包抽屉 |
| C1 运费接进利润 | ✅ | `orderCost.ts` 消费 `parcelTotalsByOrders`：已拆包的单运费 = 包裹实付合计（按件数摊到各行、尾差归末行），缺运费标 `parcel` 缺口**不回落估算**；未拆包的单保持运价表链路。利润页新增批量读口 `order-parcel-totals`（`orderParcelTotals`） |
| C2 成本两字段 | ✅ | `order.main` v9：加 `actual_cost_cents`，存量实付搬家 + 按**下单日**从旧价目表回填预估（未归类留 NULL）+ 从拿货单补一次实付 + 最新价镜像产品表。写口收拢为三处（产品行 / 归类确认钉预估 / 拿货落账写实付）；`orderCost.ts` 改为 `actual > estimate > none` 并删 `costmap` 回落；利润页与拣货不再调 `aeCostMapList`。`schema:smoke` [H] + 四个 UI 冒烟 + `goods:shot`。**删表已完成**（2026-10-21）：`order.main` v10 `DROP TABLE ae_cost_map`；四条 `ae-cost-map-*` 通道、`ae-db` 成本段、`manual-costs.ts`、host `costMap*` op 一并删除 |

### 0.1 A7 的真实库对照（验收证据）

克隆真实库（51 行订单）跑一遍 v7 迁移 + 两个快照，用**当前**利润引擎分别算 `before`（无快照）与 `after`（有快照）：

| 结果 | 数 |
| --- | --- |
| 克重钉上快照的行 | 4 行 —— `weightSource: lookup → snapshot`，**重量与运费逐行不变**（证明快照 = 现查的结果，只是钉住） |
| 成本被快照改变的行 | 1 行（#194：**28 → 32 元**，来源 `costmap → snapshot`）—— 该行拿货实付 32，成本表估算 28。**这是 A7 的设计意图**（实付压估算），不是回归 |
| 其余 46 行 | 产品成本 / 运费 / 合计**逐行完全一致** |

> 这条对照本身**不入库**（依赖真实库导出的 JSON）。永久守卫落在 `tests/orderCost.spec.ts` 的「行级快照优先」5 条：克重快照压过干扰项 900g、成本快照压过成本表 10 元、0 与缺失都回落、两处都没有才标缺。
> 变异验证：把成本次序反转 / 忽略克重快照 / 把 `0` 当有效快照，三组各自变红（只红目标那几条）。

### 0.2 B1 拆表的真实库对照（验收证据）

克隆真实库（`order.main` = v6、51 行 import、0 行 collect、尚未建包裹表），跑 v7 + v8 后逐项比对：

| 项 | 结果 |
| --- | --- |
| 版本 | v6 → **v8** |
| 行数 | 51 旧行 → **47 主表 + 51 明细**（少掉的 4 行 = 同单多图归并到同一主表行） |
| 明细 id | **51/51 原样保留**（`parcel_lines.order_item_id` 等行 id 下游零迁移） |
| 行级字段 | 逐行与迁移前一致（图片 / 尺码 / raw_fields / 款类色 / 核对位 / 件数 / 款色 id / 克重 / 进价 / 创建时间） |
| 主表字段 | 与同单 `MIN(id)` 那行一致（店铺 / 下单时间 / 三笔金额 / 税态 / 状态 / 发货时点） |
| 外键 | 每条明细的 `order_id` 都能在主表找到 |
| 幂等 | 第二次执行不报错、行数不变、版本不回退、`sqlite_sequence` 已追平 |

拆表后才成立的三条写入口约定（空单号拒绝 / 导入与采集互斥 / 重采集清包裹）与守卫见
`docs/notes/2026-10-21-order-table-split-b1.md`。

### 0.3 过渡期的已知限制（均已随阶段 C 消失）

- **清空进价清不掉老价** ✅ **已消失**：产品抽屉把进价清空 = 写 0，但列表/利润的回落链还会去 `ae_cost_map` 取该款老价，于是界面上价"清不掉"。这**不是两处打架**（列表与利润同一条回落链，数一致），是"成本表还没退役"的必然结果；C2 删掉回落分支与旧表后，0 就是"没维护"。
- **镜像只在有 `manual`/导入价时发生** ✅ **已消失**：C2 起没有镜像 —— `purchase` 源写订单行 `actual_cost_cents`，产品表「当前价」只由人工/导入维护，两者不再交叉。

**A2 的替代结论**：真正缺口不是"没有地方存色图"，而是**没有"人工替换某色图"的入口**（现有只能采集自动补空）。
接入口需先定 UI 落点（归类核对 / SKU 矩阵 / 采集中），单独排期。

---

## 0. 一句话结论

把「进价 / 克重 / 运费」三个数字从**实时反查**（`ae_cost_map` / `pl_shop_sku` / `sr_rate_snapshots`）改成**落库快照**（订单关联表 / 订单表），让利润计算只依赖订单域三张表。拆成两个独立工程：**阶段 A 快照前置**（加字段钉快照，不拆表）与**阶段 B 拆表+包裹**（大工程，独立立项）。

**不做**：重建产品编码规则（已有 `pl_products.code`）；为认色另建页面（复用归类核对「选款色」）；`ae_settle_lines` 退役（平台结算轨去留未定）。

---

## 1. 已拍板的决策（本次计划的前提）

| # | 决策 | 落点 |
| --- | --- | --- |
| D1 | 实际进价 = 拿货单填的价，**不在导入时产生** | 拿货落账后回写订单关联表 |
| D2 | 克重/运费 = **包裹级**，统一在「归类核对确认无误」时钉死 | 导入只落原始数据 |
| D3 | 产品表存「当前进价」，订单关联表存「当时快照」 | 两者并存，退役 `ae_cost_map` |
| D4 | SKU 每色一图，供人工认色 | `pl_variants.image_id` |
| D5 | 拆包按单个商品拆、允许拆分合并行数量 | `parcel_lines` 带 `qty`；关联表保留 SKU 级粒度 |
| D6 | 对账口径 = 拿货单（供应商应付） | 现有 `purchase_orders` 链路 |

---

## 2. 阶段总览

| 阶段 | 内容 | 依赖 | 风险 | 是否可独立交付 |
| --- | --- | --- | --- | --- |
| **A** | 快照前置（加字段钉快照） | 无 | 低 | ✅ |
| **B** | 拆表 + 包裹 | A | 高 | 独立立项 |
| **C** | 退役表 | A+B | 中 | 依赖 A/B |

**建议先做 A**：A 独立交付、直接解决「利润依赖隐藏机制」的痛点，且为 B 的拆表铺平数据基础（快照字段先就位，拆表时只是搬列）。

---

## 3. 阶段 A — 快照前置

### 3.1 目标

- 利润引擎 `orderCost.ts` 改读快照字段，不再实时查 `ae_cost_map` / `pl_shop_sku` / `sr_rate_snapshots`。
- 数字口径与改造前**逐行一致**（门禁验证）。

### 3.2 任务分解

#### A1. `pl_products` + `进价` 列

| 项 | 内容 |
| --- | --- |
| 落点 | `electron/product-db.ts`：`SCHEMA` 加列 + `ensureProductColumns` 补列 |
| 字段 | `cost_cents INTEGER NOT NULL DEFAULT 0`（成本单价，分） |
| 类型 | `ProductListItem` / `ProductUpsertInput` 加 `costCents` |
| IPC | `product-handlers.ts` 的 upsert/list 透传 `costCents`；`preload.ts` 载荷白名单补 |
| 消费 | 产品页展示当前进价；新订单默认进价 |

#### A2. `pl_variants` + `image_id` 列

| 项 | 内容 |
| --- | --- |
| 落点 | `electron/product-db.ts`：`VARIANT_SCHEMA` 加列 + `ensureVariantColumns` 补列 |
| 字段 | `image_id INTEGER NOT NULL DEFAULT 0`（引用 `pl_images`） |
| 类型 | `VariantRow` / `VariantUpsertInput` 加 `imageId`（只读返回，不进全量提交） |
| 接口 | 新增窄接口 `variantImageAttach/detach`（同 `imageAttach/detach` 模式） |
| 消费 | 归类核对「选款色」下拉展示各色 SKU 图 |

#### A3. 订单表 + `总克重`/`总物流费`

| 项 | 内容 |
| --- | --- |
| 落点 | `electron/order-db.ts`：`ORDER_*_COLS` 加列 + `addOrderMoneyColumns` 类补列 |
| 字段 | `total_weight_g INTEGER NOT NULL DEFAULT 0`、`total_ship_cents INTEGER NOT NULL DEFAULT 0` |
| 写入 | 归类核对「确认无误」时：Σ行克重 → 订单总克重；Σ克重+收货国 → 运价 → 总物流费 |

#### A4. 订单关联表 + `克重`/`实际进价`

> ⚠️ 阶段 A **不拆表**，先把字段加到现有 `oi_orders`（一行=订单×图片），拆表在阶段 B 才迁到独立关联表。

| 项 | 内容 |
| --- | --- |
| 落点 | `electron/order-db.ts`：`oi_orders` 加 `weight_g`、`cost_cents` |
| 克重写入 | 归类核对「确认无误」：按「关联产品ID+颜色+尺码」查 SKU 克重 → 钉行 |
| 进价写入 | 拿货落账后回写（见 A5 与 D1） |

#### A5. 进价回写（`purchase-cost-sync` 改落点）

| 项 | 内容 |
| --- | --- |
| 现状 | `purchase-cost-sync.ts` 拿货快照 → `ae_cost_map`（`source='purchase'`） |
| 改造 | 拿货单「款色尺码」→ 回写**该拿货单覆盖的订单行** `cost_cents` |
| 定死 | 只写该单覆盖的行；已写过进价的旧行**不覆盖**（避免后拿价污染历史利润） |
| 保留 | `purchase_orders`/`purchase_items` 仍是对账与拿货事实源 |

#### A6. `manual-costs` 改落点

| 项 | 内容 |
| --- | --- |
| 现状 | `manual-costs.ts` 写 `ae_cost_map`（`source='manual'`） |
| 实做 | ⚠️ **没有搬落点，只消除了"两处各写一遍"**：镜像收进 `applyManualCosts` 内部（一个函数里同时写成本表 + 产品表），三个入口（成本面板 / 产品导入 / 产品抽屉）共用同一份。落点搬迁留给阶段 C（删 `ae_cost_map` 时一并） |
| 为什么 | 落点一搬走，利润与列表就得同时改回落链；而 A7 刚把"实付 > 估算"的次序定下来，两个变更叠在一起没法归因。镜像期的代价只是多一次 UPDATE |
| 回执 | `productsSynced` / `productsMissing` 随结果返回，界面明说"价只记在成本表，产品页不会变"（产品库没该款时不假装成功） |

#### A7. 利润引擎改读快照

| 项 | 内容 |
| --- | --- |
| 落点 | `src/lib/orderCost.ts` |
| 克重 | 行上有 `weightG` 就用（`weightSource='snapshot'`），否则仍按「款色码 → 款码」查 SKU（`'lookup'`） |
| 成本 | 行上有 `costCents` 就用（`costSource='snapshot'`），否则回落 `ae_cost_map` 区间取价（`'costmap'`）；两处都没有 → `'none'` + 标「缺成本」。**C2 起拆为两字段**：`actual_cost_cents`（实际进价）优先，`cost_cents`（进价/预估）次之，见 §5 |
| 运费 | ⏸ 未动（`sr_rate_snapshots` 按订单日期取当时那份）—— 计划原写"改读 `total_ship_cents`"，但那是**订单级**字段，A3 已推迟到 B1；行级运费并不存在，先保持原链路 |
| 次序铁律 | **真值先于估算**：快照是"这单当时的事实"，区间表是"这款大概多少"。次序一反，用户填了实付、利润却还按估算算 —— 改了价看不出变化 |

#### A8. 门禁验证（实跑清单）

- 类型 / 契约：`tsc -p tsconfig.electron.json`、`vue-tsc --noEmit`、`verify`（含跨域 db 边清单）、`verify:docs`
- 单测：`vitest run` → **42 文件 / 813 用例**
- 数据层冒烟：`schema:smoke`（迁移步数 7）、`order:smoke`（新增 [8] 快照 5 条）、`product:smoke`（新增 [P] 进价 7 条）、`ae:smoke`（新增 [4.7] 镜像 4 条）
- 界面冒烟：`order-profit:ui`、`goods:ui`（新增抽屉进价往返）、`master-data:ui`（成本面板 + 窄视口）、`today:ui`
- 证据：§0.1 的真实库逐行对照（51 行）

---

## 4. 阶段 B — 拆表 + 包裹（独立立项）

### 4.1 目标

- `oi_orders` 拆「订单表（一单一行，`order_no` 幂等）+ 订单商品关联表（一单多行）」。
- 建 `parcels` + `parcel_lines`，支持一单多包、拆分数量。

### 4.2 任务分解

#### B1. 拆表 ✅ **已落地（2026-10-21）**

- 订单主表 `oi_orders`：`order_no NOT NULL UNIQUE` + 订单级字段（店铺/下单时间/来源/金额/税态/状态/发货时点）。
- 明细表 `oi_order_items`：一 SKU 一行（图片/尺码/颜色/原始行/件数/款色 id/克重/实际进价/核对位）。
- **关键不变量**：明细 `id` **原样保留旧 `oi_orders.id`**（不重排）—— 包裹明细、采购来源等一切
  "按行 id 指"的下游零迁移；主表 `id` 是新自增。
- 迁移 (`order.main` v8)：按 `order_no` 归组，订单级字段取 `MIN(id)` 那行；空订单号的旧行各自成单
  （`__empty__||id` 占位，不并、不丢）；**同款合并不在迁移里做**（物理层保留 SKU 粒度，汇总按 `GROUP BY`）。
- 下游同一批改写：`shippingRows` / `pickingRows` / `reassignOrdersByItemIds` / 列表投影 / 分组统计 /
  更新与删除；A4/A5 的行级快照列随之落在 `oi_order_items`。
- 三条写入口约定（拆表后才成立）：
  ① 空订单号**明确拒绝**（主表 `NOT NULL`，旧 NULL 占位写法已删）；
  ② 同一订单号**只容一个摄取通道**（导入逐行追加 / 采集整单替换），两边都明确拒绝混写；
  ③ 重采集 / `clearAll` / 删除末行都会收掉包裹（不留 0 明细空壳污染汇总）。
- 证据：§0.2 真实库对照；`schema:smoke` 场景 C/G；`order:smoke` [9] 四条写入口守卫。

#### B2. 包裹表 ✅ **已落地（2026-10-21）**

```
parcels(id, order_no, label, tracking_no, carrier, ship_cents, weight_g, note, created_at, updated_at)
parcel_lines(id, parcel_id, order_item_id, qty, UNIQUE(parcel_id, order_item_id))   -- qty 支持拆分一个 SKU 行数量
```

- 键用 `order_no`（**不是**订单主键）：B1 拆表前 `oi_orders` 一行 = 订单×图，没有订单主键可指；
  B1 之后 `order_no` 正好是订单主表的业务键，**数据不用迁**。`order_item_id` 现指 `oi_order_items.id`
  （即拆表前的 `oi_orders.id`，v8 原样保留）。
- **总物流费 = Σ 包裹 `ship_cents`**：由 `parcelTotals()` 派生，不落库；任一包缺值 ⇒ 整单 `null`。
- 拆包入口：**「今天 › 归类核对」行内「拆包」→ 右侧抽屉**（两个范围都给；按单个商品行拆、可拆数量）。
  上限只有一处算法（`parcelRemaining`），界面显示与写入校验共用。
- 细节与守卫见 `docs/notes/2026-10-21-parcel-model-b2.md`。
- 包裹收尾（B1 一并落地）：`deleteOrder` 收掉空壳包；`clearAll` 连包裹一起清；
  采集重推整单替换前先清该单包裹（明细 id 全换，留着就是空壳）。
- ~~**未做**：运费接进利润~~ → **C1 已完成**（2026-10-21）：`orderCost.ts` 消费 `parcelTotalsByOrders`，已拆包的单不再看运价表。

#### B3. 下游改写 ✅ **随 B1 一并落地**

| 下游 | 改动 | 状态 |
| --- | --- | --- |
| `shippingRows` | 订单行 JOIN 明细表（主表取店铺/时点/来源，明细取件数/图片） | ✅ |
| `pickingRows` | 未发货订单行改读明细表（`electron/picking-db.ts`） | ✅ |
| `settleLines` 对齐 | `order_no` 对齐不变；商品级件数仍按 `(order_no, item_id)` 对齐（结算行自带商品 id，不依赖订单行 id） | ✅ 无需改 |
| 颜色回填 `reassignOrdersByItemIds` | 落点改 `oi_order_items` | ✅ |
| 利润引擎 | 已读行级快照（阶段 A），行级取数随列表投影改 JOIN | ✅ |

---

## 5. 阶段 C — 退役表

### C2 定稿：订单明细行两个成本字段（2026-10-21，已落地；删表已完成）

> 来源：早前方案讨论定过「进价 + 实际进价」两个快照，但实现侧只落了「实际进价」一半，预估一直靠实时查
> `ae_cost_map`。删表前必须把预估也落成字段，否则那些行会从"有估算"变成"缺成本"。

| 字段 | 语义 | 谁写 | 何时 |
| --- | --- | --- | --- |
| `oi_order_items.cost_cents` | **进价（预估）**：该行在归类确认时点"当时生效"的款级价 | 归类核对「确认无误」时钉 | 一次；之后不随产品改价漂移 |
| `oi_order_items.actual_cost_cents` | **实际进价（实付真值）**：拿货单里填的价 | 拿货落账后回写（`syncOrderRowCosts`） | 只补空、按拿货日期先到先得 |
| `pl_products.cost_cents` | **当前进价**：产品页维护，供新单估算 | 成本面板 / 产品导入 / 产品抽屉 | 随维护更新，不回写历史行 |

利润取数（`orderCost.ts`）：`actual_cost_cents > 0` → 实付（`'snapshot'`）；否则 `cost_cents > 0` → 预估
（`'estimate'`）；两者都没有 → `'none'` + 标缺。**0 一律视为缺失**（既不是免费，也不是已钉）。
来源由"哪个字段有值"表达，**不再需要单独的 `cost_source` 标记**。

存量迁移（`order.main` v9 + 独立回填，顺序不可颠倒）：

1. 加列 `actual_cost_cents`；
2. 现有 `cost_cents` 存量全是拿货实付 → `actual_cost_cents = cost_cents`，同时 `cost_cents = NULL`；
3. 按每条订单的下单日期，从 `ae_cost_map` 取当时生效价回填 `cost_cents`（无区间/无款 → 留空）；
4. 之后新行由归类确认写预估、拿货落账写实际。

> **为什么不在导入时钉预估**：导入那一刻「关联产品ID + 颜色」还没确认（正是归类核对要确认的），查不到款级价。
> 归类确认是"款 + 色 + 尺码"第一次齐备的时点，也是预估唯一能钉住的时点。

| 表 | 退役前提 | 连带清理 |
| --- | --- | --- |
| `ae_cost_map` | ✅ **已退役**（2026-10-21）：两字段定稿 + A5/A6/A7 + 回填完成；`order.main` v10 删表 | 已清理：`ae-db.ts` 成本段、`manual-costs.ts`、`ae-cost-map-*` 四条通道、host `costMap*` op、`src/types.ts` 价目表类型、`useProductList.loadCosts` 回落分支、`orderCost.ts` 的 `costmap` 回落与 `costSource='costmap'`；三个写口只写 `pl_products.cost_cents`，不再镜像 |
| `sr_rate_snapshots` 的利润消费 | ✅ **C1 已完成**（2026-10-21） | `orderCost.ts` 消费 `parcelTotalsByOrders`：已拆包的单用包裹实付合计（按件数摊到行），缺运费标 `parcel` 缺口、**不回落估算**；未拆包的单保持运价表链路。**快照表本体保留**（导入/归类算运费仍用） |
| `pl_shop_sku` 克重读法 | ✅ **本来就是虚的** —— `loadSkuWeights()` 只读 `pl_variants`（`src/core/services/skuWeights.ts` 头注释写明"全应用唯一的克重来源"）。计划原条目按别的实现写的，实测无此消费方 | 无（`pl_shop_sku` 没有克重列可删） |
| `ae_settle_lines` | ⚠️ 未定 | 平台结算轨（净收入/件数真值）若保留则不动 |

> **C 的准入门槛（A7 遗留的账）**：判据不是"代码删干净了"，而是**跑一次全库统计，成本侧 `costmap`（= 只靠 `ae_cost_map` 估算）的计数归零**。两条路：① 已有实付的行（`costSource='snapshot'`）本来就不依赖估算；② 其余行在删表前把预估回填进 `cost_cents`，来源变 `'estimate'`。
> ⚠️ **`weightSource='lookup'` 不在判据内**：那是克重来源（读产品库 SKU 克重），C2 不动克重链，它本来就该一直有值。原计划把它一起写进判据是错的。
> 否则删掉回落分支，那些行会从"有估算"直接变成"缺成本"，利润表上凭空多出一片缺口。
>
> **执行结果（2026-10-21 回填 / 2026-10-22 克隆验证）**：回填由 `order.main` v9 完成（`schema:smoke` [H]），删表由 v10 完成。
> 真库实测已到 `order.main=9`（两字段与预估回填早已落库）、旧表 21 行；克隆后跑 v10：47 单 / 51 明细行数不变，
> 实付 ¥32.00、预估 ¥1,116.00、产品价 ¥503.00 逐项原样、外键零孤儿。**真库在 app 下次启动时自动删表** ——
> 运行中的进程仍按 v9 假设工作，不要中途手工删。

---

## 6. 验收标准

| 阶段 | 验收 |
| --- | --- |
| A | ✅ **已达成**（2026-10-21）：51 行真实库对照，46 行逐行一致；4 行克重钉快照（重量/运费不变）；1 行成本按"实付压估算"由 28 → 32（设计意图）。`ae_cost_map` 仍被读（回落），但**已不再是唯一来源**；进价/克重两处快照落库正确 |
| B | ✅ **已达成**（2026-10-21）：真实库 51 行 → 47 主表 + 51 明细，行 id 与字段逐行保留、迁移幂等；一单多包/拆分数量/超拆拒绝的守卫全绿；下游（发货台/拣货/归类回填/列表统计）全部改写并通过冒烟 |
| C | ✅ **已达成**（2026-10-21）：`order.main` v9 六步回填（`schema:smoke` [H]）、v10 删除 `ae_cost_map`；写口只剩「产品当前价 / 归类确认钉预估 / 拿货落账写实付」，读侧 `actual > estimate > none` 一处实现；利润页/拣货的价目表回落已删；`ae-cost-map-*` 通道与 `manual-costs.ts` 已删除；lint/verify/verify:docs/vitest/typecheck/build/schema/order/ae/product/picking + 四个 UI 冒烟全绿 |

---

## 7. 风险与对策

| 风险 | 对策 |
| --- | --- |
| 进价回写污染历史订单 | 只写该拿货单覆盖的行、已写不覆盖（A5 定死） |
| 拆表破坏下游 | ✅ 已执行：阶段 B 独立完成，逐下游改写 + 冒烟；真实库克隆迁移对照（§0.2） |
| 快照字段口径漂移 | 每个数字只一处写（AGENTS 铁律 5），读方统一 `orderCost.ts` |
| `ae_settle_lines` 依赖未明 | 退役前先确认平台结算轨是否仍需 |
| **克重回落有产品数上限**（A7 暴露，✅ **2026-10-22 已修**） | 原 `loadSkuWeights()` 只取前 500 款（`productList({limit:500})`），超过 500 款时后排行的 `weightSource` 静默变成 `none`（"缺克重"），看起来像数据没维护。已改为**产品分页拉全（单页 500）+ SKU 分批取（单次 ≤5000 id）**；任何一页读失败仍返回空表（不给半个表，避免"其实有克重"的行被误报成缺口）。守卫 `tests/skuWeights.spec.ts`（620 款第 2 页命中、5200 款分两批、两处中途失败）。见 `docs/notes/2026-10-22-sku-weight-full-scan.md` |
