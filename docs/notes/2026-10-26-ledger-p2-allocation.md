# 记账 P2：营收占比 / 方案存取 / 明细展开 / 删店保护 —— 五条判定

## 结论（改分摊链路前先看这五条）

1. **营收口径只允许复用统计页那一套；认不出的钱必须分桶，不许猜。**
   `src/lib/ledgerRevenue.ts` 不写任何收入 SQL，只把 `summarizeRevenueByShop` 的结果
   （`src/lib/orderCost.ts`）按**归一键**映射到 `sk_shops.id`（RK-06）。
   四个桶必须各自可见，而不是并成一句"部分营收未计入"：
   - 名字没登记 → `unmatched.reason='not-found'`；同名多店（跨平台同名是合法的）→ `'ambiguous'`，
     **不按遍历顺序取第一家**；
   - 订单没写店铺 → `unassignedCents`；
   - 关闭/取消单 → `excludedClosedRows`（与统计页同一判据）；
   - 金额缺失 → `missingRevenueRows`。
   取证：`src/lib/ledgerRevenue.ts:62`、`:111`、`:123`；弹层取数 `src/modules/ledger/EntryEditor.vue:863`。

2. **取数触顶与"全部营收为 0"是两件不同的事：前者停用基准，后者回落并诚实落库。**
   订单行取数上限 2000 行，`rows.length >= ORDER_ROW_LIMIT` 即视为**半份数据**，
   此时营收基准直接不可用（`EntryEditor.vue:663`、保存前再拦一次 `:1067`）——
   按半份数据算占比会把钱摊错，且界面上看不出少了一半。
   反之，参与店营收全为 0 时引擎回落平均并显式提示；落库的 `basis` 记**实际采用的 `equal`**
   （`payload.basis = appliedBasis`，`:1109`），不把"按营收"写进历史却给一组平均分摊。

3. **历史营收条目：参与集合与基准冻结，改金额按当初分摊金额的比例重算，不回头拉营收。**
   否则之后每来一笔订单，历史分摊都会"自己变"——而账已经结过、报表已经看过。
   实现：权重取 `bk_allocations.amount_cents`（`storedRevenueParts`，`:687`），
   只有 `scope`/参与集合锁死（`scopeLocked`，`:555`），**金额可改**（`amountLocked` 只认已结算，`:552`）。
   ⚠️ 这修正了 P1 的"营收基准锁金额"口径：录错金额只能作废重记，摩擦大于风险。
   `ledger:ui` 用「重新打开旧营收账」这条断言钉住两个事实：预览仍是 300/100（75% / 25%），
   且 `orderShippingRows` 调用次数**不变**（`watch(basis)` 只在 `!existingRevenue` 时取数，`EntryEditor.vue:806`）。

4. **方案 id 只作来源留痕；换基准/比例时必须显式写 0。**
   主进程对 `ruleId` 是**局部更新**语义（不传 = 沿用库里的旧值）。前端若在 `> 0` 时才传，
   用户"套用了方案后又改成手工比例"时，旧方案 id 会永远挂在这笔账上，回看时误导来源。
   所以 `save()` 无条件带 `payload.ruleId = ruleId.value`（`:1112`）；重算从不读它。
   取证：`src/modules/ledger/EntryEditor.vue:1112`、`electron/ledger-db.ts` 的 `ruleId` 分支。

5. **删店保护放在编排层，handler 与冒烟调同一份判据。**
   `electron/shop-delete-guard.ts:18` 用 `countShopReferences`（`electron/ledger-db.ts`）拦两类引用：
   专属条目 `bk_entries.shop_id`、公共分摊行 `bk_allocations.shop_id`。
   - **已作废条目也算引用**：作废不删行，明细里仍按店名展示历史；
   - 不能写进 `shop-accounts-db`（会多一条 db→db 隐式依赖边），也不能只写在 handler 里
     （冒烟只能断言文案，测不到"到底删没删"）；
   - 提示统一引导「停用」：停用后店名照常显示、历史数字一分不变。
   `shop:smoke` 同时有拒绝与正控制（无引用的店必须能删），避免"全都删不了"也能过。

## 冒烟的夹具为什么要放"坏数据"

`scripts/ledger-ui-smoke.mjs` 的 `ORDER_ROWS` 刻意放了关闭单（999999 分）、未登记店（幽灵店 300 元）、
没写店铺（200 元）、缺金额（null）四类行。只放"干净订单"时，四类分桶全都走不到，
"营收与统计页对平"会变成一句空话。同理，方案用例走的是
**保存为方案 → 套用到另一笔 → 重新打开看下拉** 的完整往返（而不是只断言请求体），
才能抓到"按顺序回填"或"旧 id 残留"这类静默错。

## 本轮门禁实测（2026-10-26）

- `npx tsc -p tsconfig.electron.json --noEmit` / `npx vue-tsc --noEmit` / `npm run verify`（230 / 225）/
  `npm run verify:docs` / `npm test`（**49 文件 / 969 例**）/ `npm run build` 全绿。
- `ledger:ui` **78 / 80 条**（宽 / 窄；P1 时为 55 / 57）· `ledger:smoke` **34 项** · `shop:smoke` **45 项**。
- `db:inventory` 不变：**50 个对象 = 49 表 + 1 FTS5**，业务表 47（本轮无表形状变更、无新 IPC 通道）。
