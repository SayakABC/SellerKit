# 订单表拆成「主表 + 明细」（阶段 B1）—— 落地与写入口约定

> **状态**：🟢 已落地（2026-10-21）· `order.main` v8 · 真实库克隆迁移验证通过
> **读者**：架构 / 开发者
> **归属**：`docs/plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md` 阶段 B 的 **B1**；包裹模型见
> `2026-10-21-parcel-model-b2.md`

---

## 1. 一句话

`oi_orders` 从「一行 = 订单×商品图」拆成 **`oi_orders`（订单主表，一单一行，`order_no UNIQUE`）**
+ **`oi_order_items`（明细，一 SKU 一行）**。

**整次迁移的关键不变量：明细 `id` 原样保留拆表前旧 `oi_orders.id`** —— 所以
`parcel_lines.order_item_id`、采购来源等一切"按行 id 指"的下游零迁移。主表 `id` 才是新自增。

---

## 2. 拆分口径（迁移 v8）

- 主表按 `order_no` 归组，订单级字段取同单 **`MIN(id)`** 那行（同单多行本该同值；万一不一致以最老那行为准）。
- **空订单号的旧行各自独立成一单**：`order_no = '__empty__' || id`。
  宁可多几条主表，也不把"不知道是不是同一单"的行并掉，更不丢行。
  ⚠️ 这个占位**只服务历史迁移**：拆表后新写入的空订单号一律**明确拒绝**（见 §4）。
- 明细逐行搬行级字段，`order_id` 指回主表。
- **同款合并不在迁移里做**（`style_color_id + size` 相同也不并）：合并是汇总层语义，
  物理层要保留 SKU 粒度 —— 拆包、取图、按行核对都靠它。需要合并时用 `GROUP BY`。
- 迁移前旧表 rename 为 `oi_orders_legacy_split`，成功后才 DROP；`sqlite_sequence` 追平主表 `MAX(id)`。
- 新库判据：主表没有 `raw_fields` 列（那是行级列）⇒ 已是新形状，迁移直接跳过。

---

## 3. 真实库对照（验收证据）

克隆真实库（`order.main` = v6、51 行 import、0 行 collect、尚未建包裹表），跑 v7 + v8 后逐项比对：

| 项 | 结果 |
| --- | --- |
| 版本 | v6 → **v8** |
| 行数 | 51 旧行 → **47 主表 + 51 明细**（少掉的 4 行 = 同单多图归并到同一主表行） |
| 明细 id | **51/51 原样保留** |
| 行级字段 | 逐行与迁移前一致（图片 / 尺码 / raw_fields / 款类色 / 核对位 / 件数 / 款色 id / 克重 / 进价 / 创建时间） |
| 主表字段 | 与同单 `MIN(id)` 那行一致（店铺 / 下单时间 / 三笔金额 / 税态 / 状态 / 发货时点） |
| 外键 | 每条明细的 `order_id` 都能在主表找到 |
| 幂等 | 第二次执行不报错、行数不变、版本不回退、`sqlite_sequence` 已追平 |

> 探针本身踩过一次坑：迁移前的 SELECT 漏了 `shop` / `order_time`，导致"主表字段不一致"的假警报。
> **对照脚本也要核对它自己取全了列** —— 否则会把探针 bug 读成迁移 bug。

---

## 4. 三个写入口约定（拆表后才成立的）

### 4.1 空订单号 = 明确拒绝

主表 `order_no` 是 `NOT NULL UNIQUE`，旧实现"用 NULL 占位"现在**必撞约束**。
导入侧解析层（`importSheet`）本来就跳过缺单号的行；DB 层再 throw 一句能看懂的错误，
且**不留下半条主表行**（事务回滚）。不要在 DB 层重新引入"无单号也能落"的旁路。

### 4.2 同一订单号只容一个摄取通道

| 通道 | 写法 | 撞车时 |
| --- | --- | --- |
| 导入（Excel） | 按 `(order_no, image_id)` 幂等，逐 SKU 追加 | 主表是采集单 → **拒绝**（`insertOrder`） |
| 采集（扩展推送） | 同一单号**整单替换** | 主表是导入单 → **拒绝**（`upsertCollectedOrder`） |

为什么必须互斥：导入是"一行一行追加 + 报表金额"，采集是"整单删了重插 + 采集金额"。
混在一起时，采集下一次重推会把导入的行全删掉，而且同一个 `order_no` 上会同时存在两套金额口径。

采集订单在扩展侧已下线，但历史采集单与将来重开采集仍会撞上 —— `ae-db.upsertOrderBatch`
对每条失败现在会打一条 `console.warn`（回执只有 `skipped` 计数，没有原因）。

### 4.3 重采集 / 删除 / 清空时的包裹收尾

| 动作 | 包裹怎么处理 | 不做的后果 |
| --- | --- | --- |
| 采集重推同一单 | 先清该单 `parcel_lines` + `parcels`，再整单替换明细 | 明细 id 全换，旧包变 0 明细空壳，仍进 `parcelTotals` 求和 |
| `deleteOrder(行 id)` | 删完后收掉**没有明细占着**的包 | 空壳包让整单运费被拖成 `null`，界面多一张空卡片 |
| `clearAll()` | `parcels` 与订单/明细一起清 | 孤儿包永远查不到、却占着汇总 |
| 删单个包 | 显式先删 `parcel_lines` 再删包 | 连接级 `PRAGMA foreign_keys` 未开时留孤儿明细 |

---

## 5. 下游改写（随 B1 一并完成）

| 下游 | 改动 |
| --- | --- |
| `shippingRows` | JOIN 明细 + 主表（件数/图片来自明细，店铺/时点/来源来自主表） |
| `pickingRows` | 未发货订单行改读 `oi_order_items`（`electron/picking-db.ts`） |
| `reassignOrdersByItemIds` | 回填落点改 `oi_order_items` |
| 列表 / 分组统计 / 更新 / 删除 | 统一 JOIN；`shop` 在主表，`category/color` 在明细 |
| 结算明细对齐 | **无需改**：`ae_settle_lines` 自身带 `(order_no, item_id)`，不依赖订单行 id |
| 利润引擎 | 行级快照（阶段 A）随列表投影改 JOIN，口径不变 |

---

## 6. 守卫（怎么证明它没坏）

| 层 | 断言 |
| --- | --- |
| `schema:smoke` 场景 C/G | 老库形状拆表后数据一条不丢、明细 id 不变、两表列序与 `ORDER_TABLE_COLUMNS` / `ORDER_ITEM_TABLE_COLUMNS` 一致、v8 步数常数 |
| `order:smoke` [9] 4 条 | 空单号拒绝且不留主表行 · 导入→采集单拒绝 · **重推清包裹**（旧包 999 → 总运费回到 `null`）· 采集→导入单拒绝且不改金额 |
| 下游冒烟 | `picking:smoke` / `shop-item:smoke` / `style:smoke` / `product:smoke` / `product:sku:smoke` / `ae:smoke` / `ship-rate:smoke` |
| 界面冒烟 | `today:ui`（含拆包）/ `order-profit:ui` / `goods:ui` / `master-data:ui` |

---

## 7. 明确没做的事

- **运费仍未接进利润**：`parcelTotals(order_no)` 已可用，`orderCost.ts` 尚未消费（阶段 C 的前置之一）。
- **`ae_cost_map` 退役仍属阶段 C**：`orderCost.ts` 的 `costmap` 回落与 `useProductList` 的读价分支未删。
- **不做订单行物理合并**：同款同码的多行保留多行；需要汇总时按 `GROUP BY` 聚合。
