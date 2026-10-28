# 总览只该有四个数，而「已拿」在库里的粒度决定了它能有多准

**结论先行**（2026-10-22，用户裁定「总览里的功能暂时没什么意义，先去掉，改成展示今天要发多少单 /
多少件 / 已拿多少 / 还差多少」）：

1. 总览 = **一格数**，不是三段说明。流程卡与订单 / 待拣 / 缺口三张卡全撤 ——
   页签栏本来就排好了 1-2-3-4 且带「当前步」标记；那些卡只是把同一件事讲第二遍。
2. 四个数**只能有一处实现**：`src/lib/dailyShip.ts` 的 `dailyShip()`（纯函数 + 11 例单测）。
   面板只摆放，容器只喂数据。
3. **已拿 + 还差 ≡ 件数**。这是这一屏唯一能自证的地方 —— 账对不上，四个数就都不被信任。
   实现方式：逐 SKU `min(需求, 台账)`，不是逐行扣、也不让 `taken` 溢出需求。
4. 「已拿」的准确度被**数据模型封顶**：`purchase_items` **没有 `order_no`**，
   所以"这一单拿了多少件"根本不存在，只有"这款色码历史上一共拿了多少件"。
   于是总览的已拿 = 今天的这批 × 款色码累计台账 ⇒ 同款前几天拿过时会被算进今天（最多算到需求为止）。
   **知情地接受这个近似**，并写在界面上（口径小字），比给一个假装精确的数好。

## 取证

### 1）订单/明细表里没有"已拿"这一列

```bash
sqlite3 -readonly "~/Library/Application Support/seller-kit/sellerkit.db" \
  "PRAGMA table_info(oi_order_items);"
# id, order_id, image_id, size, raw_fields, category, color, logo, material,
# status, corrected, qty, style_color_id, weight_g, cost_cents, actual_cost_cents, created_at
```

`status` 全是 `pending`（72 行）—— 它是"这行发货没有"，不是"这行拿货没有"。
`parcels` / `parcel_lines` 记的是**分包**（`order_item_id` + `qty`），也不是拿货。
⇒ "已拿"只有 `purchase_items`（已提交拿货单明细）一个来源，而它按
`style_color_id|style_code + color + size` 聚合，**没有订单号**
（`electron/purchase-db.ts` 的 `takenLedger()` 就是这条 SQL）。

### 2）为什么不能拿「缺口」当「已拿」

`outstanding()` 末尾 `missing <= 0` 就丢行 ⇒ 拿齐的款色在缺口里**根本不返回**。
拿它算已拿，等于"刚拿完"显示成"一件没拿"（2026-10-17 用户实报过）。
⇒ 必须读台账 `purchase-taken`（`TakenRow`）。

### 3）未识别款的行**照收件数、不扣已拿**

`outstanding()` 对未归类行恒 `have = 0`。总览跟它同口径：
空款编码拼出来的键会把"同色同码的不同商品"并成一格，凭空扣出一批已拿 —— 那是"漏货式"的静默错
（货没到，界面说到了）。件数照收（漏掉才是悄悄少算货）。

## 连带影响（一并还清的技术债）

- `ShippingSummary` 删掉 `picking` 与 `gaps.{weight,cost,rate}` / `gapTotal`：它们唯一的读者是被撤掉的
  「钱算得准吗」卡。⇒ 每次刷新**少跑 3 次 IPC**（`pickingRows` / 产品库克重+价目 / 运价快照）。
  留着就是"每次刷新白算一遍没人看的数"。
- `flow` 留在 `TodayView` 里：页签左侧的「当前步」标记（`.td-tab.is-now`）读它 —— 删了页签就只剩一排没有主次的按钮。

## 守卫（`scripts/today-ui-smoke.mjs`）

| 断言 | 变异（改坏哪里） | 结果 |
| --- | --- | --- |
| 四个数 = 2 单 / 3 件 / 已拿 1 / 还差 2 | 容器不把台账喂给 `dailyShip`（`{taken:{}}`） | ✅ 变红（已拿 0 / 还差 3） |
| 进度条 = 已拿/件数（1/3 ≈ 33%） | 同上 | ✅ 变红（fill 0%） |
| 反向：`flow` / `card-orders` / `card-picking` / `card-gaps` 都不许回来 | 把任一卡加回去 | 红 |
| 空态不摆一排 0、也不挂口径小字 | 去掉 `v-if="daily.orders"` | 红 |
| 刷新后四格数字回来 | 空态把面板替换成回不来的 DOM | 红（等待超时） |

夹具有一处**必须**跟着改：`IMPORTED.styleColor` 由「红」改成「黑」，与台账 `TAKEN` 同色名。
不改的话已拿恒为 0（键对不上），断言看着能跑，却把"键对不上"这个真 bug 掩盖成"这件本来就没拿"。

## 复现

```bash
npx vitest run tests/dailyShip.spec.ts     # 11 例
npm run today:ui                            # 全绿
```
