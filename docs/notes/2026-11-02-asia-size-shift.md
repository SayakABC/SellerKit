# 亚洲款加码：拿货侧的尺码换算（2026-11-02）

## 结论（先看这八条）

1. **只换拿货侧**。`oi_order_items.size` / 订单利润 / 发货台 / 客户可见内容一个字不动。
   换算后的码是"要拿什么"的码，也是**已拿台账的键**（`purchase_items.size`）。
2. **换算只有一份实现**：`src/lib/sizeShift.ts`。规则是"字母码按码序 / 数字码按链（没链按 +2）/
   `2XL`≡`XXL` 且**保持原写法** / 超界封顶 / 认不出就不动"。任何第二处再写一遍偏移，
   两边就会在某个牌子的某个码上分叉，而且不报错 —— 只是拿错货。
3. **换算必须发生在 `aggregatePicking` 之前**（`PickingView.generate()`）。清单尺码格、开单明细
   （`g.size`）、已拿抵扣、导出四处全读聚合后的 `size`；换在聚合之后要改五处，必然漏一处。
4. **两个码都要落库**：`purchase_items.order_size`（下单码）+ `purchase_sources.purchase_size`
   （拿货码）。少后者会让 `orderCoverage()` 与店铺分摊的 `(款,色,码)` 对齐断掉 ⇒ 同一批货
   既算 `covered` 又算 `unattributed`，界面**提前谎报"已齐"**。
5. **配置是独立窄表** `pl_size_shift`（款编码 → 偏移 0…±3），**不进 `productUpsert`**：
   那边是全量提交，产品抽屉"只改了个名字"的提交会把偏移清成 0（与 `cost_cents` 同一个坑）。
6. **设置入口放拿货页的「款列表」，一款一行；行内只留只读标记**。
   加码是**款级**生效（同款所有颜色一起），挂在款色行的下拉会让人以为只改了这一个色；而发现
   "这牌偏小"的时刻就是**看清单的时候**，让人切到产品档案改完再切回来，实际没人会改，最后还是照错码拿。
   面板没加码时也**在**（折成一行，标题就是入口）—— 上一版把下拉藏在"有加码才显示"的提示条里，
   结果第一批款永远加不上码。
   面板里还要能**说出哪几款**：只报"3 款已加码"时用户核对的是自己心里的印象，改了 A 忘了 B
   那个数字照样成立。总数是**结论**，款号才是**证据**。
   同理 `shiftedStyles` 的口径是"这批货里偏移 ≠ 0 的款"，不是"有行真的改了码的款"：
   整款封顶 / 整款只有 `F`、均码时一个码都没变，报"0 款（0 行）"会让用户以为设置没保存
   （典型二次伤害：回去再点一遍，然后来报 bug）。
7. **`.wb-page` 是纵向 flex，子项不许被压缩**（`PickingView` 的 `.pk-view > * { flex: 0 0 auto }`）。
   页面本身 `height:100%; overflow:auto`，但子项默认 `flex-shrink:1`；可滚动子区
   （款列表 `overflow-y:auto`）的自动最小尺寸是 **0** ⇒ 面板被压成 2~18px，再被 `.wb-panel`
   的 `overflow:hidden` 裁掉。用户看到的是"一条空白"，说的是"加码区域完全看不到"，
   而**冒烟全绿**（它只查元素在不在、文案对不对）。布局类问题只有两把尺子：几何
   （`getBoundingClientRect` / `scrollHeight vs clientHeight`）与人眼截图，缺一不可。
8. **款列表要出款图，且图是"款色级"、行是"款级"**（2026-11-03 用户要求）。取法是
   **本批该款首个有图的色**（`StyleShiftRow.imagePath`），一旦取到就不再被后面的色覆盖。
   为什么不定成"件数最多的色"或"第一个色"：前者件数一变主图就换（用户会以为图配错了），
   后者在首色没图时会得到一张空框。同款多色图常不一样（不同色拍不同张）⇒ 图的 tooltip
   **必须写明取自哪个色**，否则用户会把它当"这款就长这样"。无图走**虚线占位框**而不是藏掉
   （"这款本批没图"是要去补的信息，藏了会让这一行看起来缺了左边一格）。
   图源与款色行**共用同一批 `thumbs`**（按清单 `imagePath` 合批取回的那份）：加码行的
   `imagePath` 正是从这些行里挑的 ⇒ 不多发 IPC，也不会出现"款色行有图、加码行没图"的分叉。
   ⚠️ 代价是行高 37 → **45px**、一屏 12 → **10 行**（`SHIFT_ROW_MAX` 与 `.pk-shift__rows`
   的 `max-height` 450px 同源，改一边必须改另一边）。

## 取证

| 事实 | 位置 |
| --- | --- |
| 换算入口（聚合前） | `src/modules/picking/PickingView.vue` `generate()`：`applySizeShift(rows, …)` → `aggregatePicking(shifted.rows, …)` |
| 纯函数与不变量 | `src/lib/sizeShift.ts`；用例 `tests/sizeShift.spec.ts`（20 条，含封顶合并、2XL 写法、幂等、两条不同偏移结果必须不同、逐款明细 `stats.styles`） |
| 逐款设置面板（拿货页） | `PickingView.vue` 的 `styleShiftRows`（本批**每一款**，款号升序）→ `filteredShiftRows`（搜款号/款名 + 只看已加码）→ `visibleShiftRows`（一屏 10 行 + 展开全部；行高 45px = 款图 36 + 内边距 8 + 分割线 1）；写盘走 `onShiftChange` → `productSizeShiftSet` 后**立刻 `generate()`**；款名取**本批订单行**的 `styleName`，不查 `pl_products`（拿货页的款常常还没入库） |
| 逐款统计（异常落到款上） | `SizeShiftStats.styles[]`（款号/偏移/行数/改码/封顶/认不出）—— 封顶与"认不出"分开说：前者仍按最大码拿（拿得到），后者是**没加**（照原码拿） |
| 界面守卫 | `scripts/today-ui-smoke.mjs`「亚洲款加码」11 条：面板没加码时也在且标题是入口 · **折叠态几何可见**（高 ≥ 36px、无裁切）· 款列表一款一行（断言**款号集合**）· **展开态行高 ≥ 30px** · 下拉四档 · 出参 `{styleCode,shift}` · 清单换码 `L→XL×3` · 标题行数 · 行内只读标记 · 改回后逐字还原。已做变异测试（注释"改完重算"，3 条转红；撤 `flex:0 0 auto`，几何 2 条转红） |
| 下单码进聚合 | `src/lib/picking.ts` `PickingGroup.orderSizes` / `PickingSizeCell.orderSizes`（组内多个下单码并到同一拿货码时是数组） |
| 配置读写 | `electron/product-db.ts` `sizeShiftMap()` / `sizeChains()` / `setSizeShift()`；通道 `product-size-shift-load` / `-set` |
| 来源对齐 | `electron/purchase-db.ts` `autoSourceRows()`（用 `it.orderSize` 找订单行）、`insertSources()`、`orderCoverage()` 的 `at` CTE、`allocateToShops` 的 `link_size` |
| 编辑器展示 | `src/modules/today/tabs/PurchaseOrderEditor.vue` 尺码格下方「下单 L」；`onSizeChange` 手改码即清 `orderSize` |
| 导出 | `electron/picking-xlsx.ts` 尺码列 `XL（下单L）`（**不加列**：列号变了会挪动既有断言，两个码分两列也让一线工人更容易看错列） |

复现/验证：

```bash
npx vitest run tests/sizeShift.spec.ts tests/picking.spec.ts
npx tsc -p tsconfig.electron.json && npx vue-tsc --noEmit && npm run verify
env -u ELECTRON_RUN_AS_NODE npx electron --no-sandbox --disable-gpu scripts/picking-db-smoke.cjs
env -u ELECTRON_RUN_AS_NODE npx electron --no-sandbox --disable-gpu scripts/picking-xlsx-smoke.cjs
npm run today:ui
```

## 三个坑（都验证过）

1. **`ELECTRON_RUN_AS_NODE=1` 会让所有 `electron scripts/*-smoke.cjs` 报
   `Cannot read properties of undefined (reading 'getPath')`** —— 21 项全红，看着像代码坏了。
   跑法：`env -u ELECTRON_RUN_AS_NODE npx electron --no-sandbox --disable-gpu scripts/<x>-smoke.cjs`。
   另外 `cmd | tail` 的退出码是 `tail` 的，**必须 `set -o pipefail`** 或看 `PIPESTATUS`。
2. **`src/registry.generated.ts` 可能引用已删除的模块**（本次是 `@/modules/pod`），
   `vue-tsc` 与 `pluginSettingsIsland.spec.ts` 会因此红，但它不在 git 里（构建产物）。
   处置：`npm run build` 重新生成即可，别去手改。
3. **`preload.ts` 的 `sanitizePickingExportRows` 曾漏传 `taken` / `remaining`**：
   `buildPickingWorkbook` 读的是这两个字段，漏了就是恒 0 —— 界面「还差 12」、导出表「还差 0」，
   而冒烟直接调 `buildPickingWorkbook` 不经 preload，所以一直是绿的。本次一并补上。
4. **"元素在"和"看得见"是两件事**（2026-11-02 晚，用户实报"加码区域完全看不到"）：
   面板 DOM 在、文案对、断言全绿，几何却是 `panel=2px / clientH=0`（被父级 flex 压扁）。
   补的两条守卫量的是尺寸：折叠态 `高度 >= 36px` 且 `scrollHeight <= clientHeight + 1`（没被裁）、
   展开态行高 `>= 30px`、列表区 `>= 60px`。已做变异测试：撤掉 `flex: 0 0 auto` 后
   `panel=2 head=40 scrollH=64 clientH=0` ⇒ 立刻转红；恢复后 `panel=72 head=70` 绿。
   取证脚本：`npm run purchase:shot`（截图）、以及 `/tmp` 下的 CDP 几何探针（只量不写）。

## 已知边界（不修，但要知道）

- **改偏移后旧码已拿不再抵扣新码需求**：`+1` 时已拿 XL，改 `+2` 后需求变 XXL，缺口会回涨。
  这是事实不是 bug；已开的草稿单不会自动按新规则重算（那是另一张单据的既成事实）。
- **封顶会把多个下单码并到最大码**（5XL/6XL 都→6XL）：件数相加是对的，界面与 `orderSizes`
  都会把两个下单码列全。
- **偏移是款级**，不区分供应商（同款不同厂尺码标准不同时无解）；主键升级为
  `(style_code, supplier_id)` 是预留位。
- **`purchase-db.outstanding()` 不做换算**：它唯一的生产消费方（`purchaseCounts().gap`）
  按**款色**计数、不看码。要码级缺口请走拣货清单，别在主进程补一套偏移算法（见
  `src/modules/today/purchase.ts` 的 `outstanding()` 注释）。
