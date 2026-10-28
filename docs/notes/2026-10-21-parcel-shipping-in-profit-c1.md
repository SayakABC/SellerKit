# 包裹运费接进利润（阶段 C1）

> 2026-10-21 · 订单-采购模型简化 C1。计划正文与执行表见
> [`docs/plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md`](../plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md) §5。

## 一句话

利润页的运费改为**包裹真值优先**：已拆包的单 = 包裹 `ship_cents` 合计（按件数摊到各商品行），
没拆包的单保持运价表链路；**已拆包但缺运费 ⇒ 标缺，不回落估算**。

## 四条口径（改之前先读）

1. **包裹是真相**。用户在拆包抽屉里填的运费/重量就是这一单的实付，不能再被运价表估算覆盖。
   缺了就写「—」并标 `parcel` 缺口（界面 chip「缺包裹运费」，可点筛行）—— 回落估算会让
   "按包记的真值"被悄悄盖掉，且行上没有任何痕迹（和 A7「真值先于估算」同一条纪律）。
2. **摊的只是行，订单总额不变**。`orderCost.ts` 按每单件数把订单级运费摊到各行：
   `round2(total × qty / qtySum)`，**尾差归末行** ⇒ 各行之和恒等于订单合计（`10.01 → 3.34/3.34/3.33`）。
   件数取的是同一处 `resolveQty`（结算真值 → 报表块 → 按 1 并标缺）。
3. **未拆包的单原样**。`parcelTotals[orderNo].count === 0` 或不在返回里 ⇒ 走原「快照按订单日期取当时那份」
   的运价表链路，行为与 C1 之前逐字相同。
4. **一个数字一处实现**。单笔 `parcelTotals(orderNo)` 已改为委托批量 `parcelTotalsByOrders([no])` ——
   聚合 SQL、缺值判空、`shipMissing/weightMissing` 只有一份。利润页一次批量取（`order-parcel-totals`），
   不逐单 IPC。

## 接线与界面

- 链路：`order-db.parcelTotalsByOrders` → `order-handlers` 的 `order-parcel-totals` → preload
  `orderParcelTotals` → `src/types.ts` / `src/core/services/ipc.ts`（**三处同步**，`npm run verify` 会拦）。
- `OrderCostRow.shippingSource`：`parcel` / `rate` / `none`；运费单元格悬停三态说清"真值 / 哪份运价表 /
  包裹缺运费且不估算"。多件提示同步改成"成本按单件价；未拆包的单运费按 1 件估"。
- 「还没读到运价表」的 toast **只在还有未拆包订单时**出现：全部已拆包时运费走包裹实付，
  再喊用户去导报价单 = 支他去补一份用不到的数据。

## 两个静默坑（这次踩到 / 差点踩到）

- **契约校验器切不动内联 `Record<...>`**：`ElectronAPI` 里直接写
  `Promise<APIResult<Record<string, ParcelTotals>>>` 会被顶层逗号切成假成员 ⇒ 用具名别名
  `ParcelTotalsMap`（同 `ParcelCountMap`）。这是脚本的局限，不是契约错。
- **假桥的兜底会把新通道伪装成"没数据"**：`order-profit:ui` 的 Proxy 对未声明方法返回
  `{success:true,data:null}` ⇒ 新加的 `orderParcelTotals` 不补桩也"全绿"，但页面永远走运价表。
  故显式加桩，并用**两个应结果不同的数**验真：运价表 30.00、包裹 45.00（同值会让"走了哪条链"空转）。

## 顺带修复：B1 拆表后遗留的旧夹具

`ipc:shape:smoke` ⑥/⑧ 仍按 B1 前形状造数（`INSERT INTO oi_orders (image_id, size, ...)`）——
B1 后 `image_id`/`size` 在 `oi_order_items`，冒烟一跑就 `no column named image_id`。
已改为「主表一行 + 明细一行」。

> ⚠️ **不是所有 `INSERT INTO oi_orders (shop)` 都要补列**：`shop-db-smoke.cjs` 里那张
> `oi_orders` 是**最小同构桩**（只关心店铺名文本，只建 `id/shop` 两列），它刻意不跟订单域 schema 走。
> 拆表后 grep 到旧列时，先分清「真夹具要跟 schema」还是「有意的最小桩」——这次一度把桩改坏。

## 守卫

- `tests/orderCost.spec.ts` 新增 5 条：包裹合计压过运价表 / 多行按件数摊 / 尾差归末行 /
  缺运费标缺不回落（`shippingSource='parcel'` + `parcel` 缺口、**没有** `rate` 缺口）/ 无包保持原链路。
- `scripts/order-profit-ui-smoke.mjs` 新增 2 条：包裹 45.00 ≠ 运价表 30.00；缺运费 →「—」+
  行标「缺包裹运费」+ chip「缺包裹运费 1」+ 悬停写明不估算。批量读口断言"刷新一次调用、带上全部单号"。
- 本轮门禁：`tsc`（主进程）· `vue-tsc` · `verify`（209/209/204）· `vitest` 818 · `build` ·
  `order-profit:ui` · `order:smoke` · `shop:smoke` · `ipc:shape:smoke` 全绿。

## 留给 C2

`ae_cost_map` 退役仍按计划门槛：先把成本维护/导入写口搬到产品表、回填行快照，再以**全库统计
`costSource='costmap'` 与 `weightSource='lookup'` 归零**为判据删回落分支，最后删表（不可逆，由用户执行）。
