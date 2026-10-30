# 克重与 SKU 单一来源：43 条结论（蒸馏自 5 篇，2026-10-17 ~ 2026-10-25）

> **蒸馏笔记**：由 5 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/<原文件名>`

## 1. 规格编辑独立成区：界面被切成两段

**结论**：用户口径「规格编辑把通用的编辑项提取出来，如：颜色（色图 · 色名）、尺码、
默认克重，增加克重编辑」：

- **规格区**（上）：颜色卡片列表（色图 + 色名 + 删除）、尺码 chip（内联改名 + 删除）、默认克重；
- **组合区**（下）：矩阵，行 = 颜色（**只读**：28px 图 + 色名）、列 = 尺码（**只读**文字），
  格 = `✓ 在卖` 开关 + 该（色·码）的克重。

**取证**：`SkuMatrixEditor.vue` 规格区 + 组合区重排。

**源**：`2026-10-17-sku-spec-rack-and-weight`（2026-10-17）

---

## 2. 为什么必须分（不是审美）

**结论**：原来的行头 208px 里塞着「缩略图 + 色名输入 + 删除」、列头 92px 里塞着
「尺码输入 + 删除」。三件事挤在 208px 里，名字稍长就看不全；92px 里两个控件已经贴边。
分开后各得其所：规格能排成卡片（14 色也扫得动、色名打得全），表格列宽回到 96px 的自然宽度，
**并且"改规格"只剩一个入口** —— 不再有"表头改一个字、下面 140 个格跟着搬"的隐式耦合
（`renameMatrixSize` 仍管整列搬家，但它现在只从尺码 chip 进来）。

**取证**：行头 208px / 列头 92px / 列宽 96px。

**源**：`2026-10-17-sku-spec-rack-and-weight`（2026-10-17）

---

## 3. 克重是「格」的属性，0 / 缺省不写这个 key

**结论**：克重是（色 × 码）各一个值，落 `pl_shop_items.sku_json` 的 `weightG`。
**0 / 缺省不写这个 key** ⇒ 存量 546 条快照的形状一个字节都不变，`raw_json` 里也一眼看得出
"这行有人补过克重"。下游链：快照 → 建款向导预填 → `pl_variants.weight_g`。**单向**：这里改快照的
克重不会回头改已建款的 SKU（那要走产品编辑，不能让两个写者互相改）。

**取证**：`toSkuJsonRow` **0 不写 key**；`electron/shop-item-db.ts` 的 `normalizeSkuRow` **>0 才带 key**（采集路径无此字段 ⇒ 0，不写）。

**源**：`2026-10-17-sku-spec-rack-and-weight`（2026-10-17）

---

## 4. 默认克重 = 两个显式批量动作

**结论**：不是"自动继承的隐藏默认值"：

- 「填进空格（N）」：只动 `weightG <= 0` 的格（**默认不覆盖**人已核对过的值）；
- 「覆盖已填」：另一个按钮，改全部（破坏性动作必须是独立的一次点击）。

初值**刻意空着**、不按现有数据猜一个 —— 猜错就会在"加一色"时静默给十几格打上错误的克重，
而克重会进成本/运费计算。人敲过值之后，新增的格才带这个初值（`addMatrixColor/-Size/toggleMatrixCell`
都收 `weightG` 参数）。

**取证**：变异「`仅填空` 改成一律覆盖」⇒ 单测 2 条红；变异「`toSkuJsonRow` 让 0 也写 key」⇒ 单测 2 条红；
`fillMatrixWeight(m, w, {onlyEmpty})`；`countFilledWeightCells`。

**源**：`2026-10-17-sku-spec-rack-and-weight`（2026-10-17）

---

## 5. ⭐ 0 显示成空（占位「待填」）

**结论**：内部 0 = 没填，但把它画进输入框就长成一个真数字 ——
截图取证第一版整列是 `0`，读起来是"这些 SKU 是 0 克"。所以格里的克重走 `:value` + `@input`
而不是 `v-model`（`weightDisplay()` / `onWeightInput()`）。

**取证**：变异「`weightDisplay` 把 0 画成 `0`」⇒ 冒烟「待填」1 条红（`values="0"/"0"/"0"`）。

**源**：`2026-10-17-sku-spec-rack-and-weight`（2026-10-17）

---

## 6. `cellMode` prop 取消

**结论**：原先"弹层只标存在性 / 向导只填克重"两种模式合并成一种
（两个都要：存在性 + 克重）。向导里因此**也能取消组合**了 —— 这是顺带修好的能力缺口，
不是行为回归（冒烟的 `iw-sku-cell` 从 2 变 4，断言同步改成"四格都能标、其中两格是空的"）。

**取证**：`iw-sku-cell` 从 2 变 4。

**源**：`2026-10-17-sku-spec-rack-and-weight`（2026-10-17）

---

## 7. 界面规格（交付给下一个改这块的人）

**结论**：

| 项 | 值 | 为什么 |
| --- | --- | --- |
| 规格区标签列 | `76px` | 三行（颜色 / 尺码 / 默认克重）左对齐成一条竖线，扫读快于"每行都贴一个标题" |
| 颜色卡片 | `repeat(auto-fill, minmax(196px, 1fr))`，高 40+8，列表 `max-height: 112px` 滚动 | 940 宽弹层里一行 3 张；14 色时两行内见得到 6 个，其余滚动 |
| 色图 | 卡片内 40px（矩阵行头 28px） | 40px 是能看出版型/花色的下限；表格里再小一档换列宽 |
| 尺码 chip | 输入 `72px` + `✕`，高 26 | 改名不用点"编辑"，chip 本身就是输入框 |
| 组合表列宽 | 行头 `168px` + 每列 `96px`（`table-layout: fixed`，列宽声明**必须挂在 th**） | 14×10 满叉积时表格 1128px，靠 wrap 横滚 |
| 格内控件 | `✓` 26px + 克重输入（`flex:1`，`max-width: 88px`），成对**居中** | 列被 `min-width:100%` 撑宽时，左对齐会让两者被甩到两端 |
| 空格 | 整格一个大虚线按钮（`width:100%`） | 目标大、看得见"这里能点"；比 26px 小方块好点得多 |
| 焦点 | 卡片 `:focus-within` 描边 + 环 | 14 色时"现在改的是哪一色"必须看得出来 |
| 主题 | 全部走 `--wb-*` 令牌（含 `--wb-warning-soft` 高亮、`--wb-focus-ring` 焦点环） | 深色主题自动成立，不写死颜色 |

**取证**：`npm run goods:shot` → `sku-matrix-1440x900.png` / `sku-matrix-900x800.png` / `sku-wizard-1440x900.png` 人眼验版式
（1440：规格区 198px、表格 108px，一屏同时看得见规格与组合；900：弹层 846×578 也不出现
"最后一行被裁"）。改动点：`src/lib/skuMatrix.ts` 的 `SkuFlatRow.weightG?` · `normWeightG` ·
`parseSkuJsonRows`（渲染层**唯一**解析点，两处调用不再各抄一份）· `countFilledWeightCells` ·
`fillMatrixWeight(m, w, {onlyEmpty})` · `addMatrixColor/-Size`/`toggleMatrixCell` 收 `weightG`；
契约四处同改（`electron/preload.ts` + `src/types.ts` + `src/core/services/ipc.ts` + `src/modules/goods/api.ts`，`weightG?: number`）；
`tests/skuMatrix.spec.ts` +10 例（读回克重 / 0 不写 key / 填只填空 / 覆盖才改已填 / 批量填不造 SKU / 新增格带初值 / `parseSkuJsonRows` 抗坏值 …），当轮 28 例。

**源**：`2026-10-17-sku-spec-rack-and-weight`（2026-10-17）

---

## 8. 坑：断言点击 disabled 按钮 = 静默无效

**结论**：⭐ `setVal()` 之后立刻 `click()`，Vue 还没把 `disabled`
刷回 DOM ⇒ 点了没反应、断言红在"填进去的值没变"（实测 `weights=88/0/0`）。
先 `await settle(() => !btn.disabled)` 再点 —— 这一步顺带就是"输入后按钮变可点"的断言。

**取证**：实测 `weights=88/0/0`。

**源**：`2026-10-17-sku-spec-rack-and-weight`（2026-10-17）

---

## 9. 坑：0 值的显示

**结论**：⭐ 内部语义 0 = 未填，`v-model` 会把它画成 `0`。要显示"空 + 占位"就只能
`:value` + `@input`；副作用是输入过程中别回写 DOM（否则打字时光标跳）。

**取证**：`weightDisplay()` / `onWeightInput()`。

**源**：`2026-10-17-sku-spec-rack-and-weight`（2026-10-17）

---

## 10. 坑：`table-layout: fixed` + `min-width: 100%` 时多出的宽度是均分

**结论**：多出来的宽度是**均分**给各列的（实测
906px 表：168/96/96 → 350/278/278）。所以格内控件必须成对居中，否则被甩到两端。

**取证**：实测 906px 表：168/96/96 → 350/278/278。

**源**：`2026-10-17-sku-spec-rack-and-weight`（2026-10-17）

---

## 11. 坑：父组件 scoped 样式打不到子组件渲染的元素

**结论**：2026-10-16 已有这条：`is-flagged` 高亮必须
留在 `SkuMatrixEditor.vue` 自己的 scoped 块里；冒烟定位也从"`tr.is-flagged` 里的输入框"
改成"` .is-flagged ` 里的输入框"（色名输入已不在 tr 内）。

**取证**：冒烟定位从 `tr.is-flagged` 改为 `.is-flagged`。

**源**：`2026-10-17-sku-spec-rack-and-weight`（2026-10-17）

---

## 12. 坑：注入脚本（假桥 / 冒烟）里注释也不能有反引号

**结论**：仍是本仓最容易复发的一条（本次未踩）。

**取证**：本轮未踩。

**源**：`2026-10-17-sku-spec-rack-and-weight`（2026-10-17）

---

## 13. `loadSkuWeights()` 必须拉全产品库

**结论**：`loadSkuWeights()`（`src/core/services/skuWeights.ts`，全应用唯一的克重取数口）必须**拉全产品库**：

- 产品走分页：`product-list` 单页上限 500（`electron/product-db.ts` 的 `MAX_LIST_LIMIT`），按 `offset` 翻页，
  `total` 到齐或遇到短页/空页即停；
- SKU 走分批：`product-variant-list` 单次最多 5000 个产品 id（`electron/product-handlers.ts` 的 `MAX_WEIGHT_QUERY`），
  按 ≤5000 切成多批，合并后再交给 `buildSkuWeightIndex`；
- **任何一页/一批读失败 → 返回空表**，不返回"半个表"。半个表会让**其实有克重**的行被误报成缺口，
  用户会去补已经填好的数；空表则整体表现为"缺克重"，指向读失败而不是数据没维护（与既有契约一致）。

**取证**：改前：`loadSkuWeights()` 只有一次 `ipc.productList({ limit: 500 })`，注释还把这个上限写在契约里。
改后实现与 `shipRateOps.quoteProducts`（`src/core/services/shipRateOps.ts:210-236`）同一套翻页/分批写法，
不再出现第二套取数口径。
用例 `tests/skuWeights.spec.ts`（4 条，`vi.mock('@/core/services/ipc')` 替掉取数）：
① 620 款时第 2 页（`offset=500`）的款也能查到克重；② 5200 款时 SKU 按 `[5000, 200]` 两批取；
③ 产品第 2 页失败 → `{}` 且一次 SKU 都不取；④ SKU 第 2 批失败 → `{}`。
变异验证：在分页循环里加一句无条件 `break`（模拟"只取第一页"）⇒ 3 条变红；移除后 4 条全绿。
冒烟：`shipping-rate:ui`（`loadSkuWeights` 的消费方之一）的假桥改成**照真宿主分页**、`productVariantList`
按 `productIds` 过滤，宽/窄两遍全 PASS；`order-profit:ui`、`today:ui` 全 PASS。

**源**：`2026-10-22-sku-weight-full-scan`（2026-10-22）

---

## 14. 为什么现在修：第 501 款起的 `weightSource` 静默变成 `none`

**结论**：A7（2026-10-21）的真实库对照暴露，原实现只取产品列表前 500 款 ⇒ 第 501 款起的订单行
`weightSource` 静默变成 `none`（"缺克重"），看起来像数据没维护，且没有任何报错。阶段 B/C 已完成但没顺手改这一处。

**取证**：`MAX_LIST_LIMIT` = 500；`MAX_WEIGHT_QUERY` = 5000；
执行结果（2026-10-22）：`tsc -p tsconfig.electron.json` / `vue-tsc --noEmit` / `eslint`（改动文件 0 error）/
`vitest run` 43 文件 827 用例 / `shipping-rate:ui` / `order-profit:ui` / `today:ui` 全绿。
计划风险行已改为"已修"，见 `docs/plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md` §7。

**源**：`2026-10-22-sku-weight-full-scan`（2026-10-22）

---

## 15. 两个容易踩的签名差异

**结论**：

- 假桥（`window.electronAPI`）的 `productVariantList` 收 `{ productIds }`（preload 载荷），
  而 `core/services/ipc.ts` 的包装函数收**裸数组**。写桩时按前者，写业务调用时按后者。
- 假桥若忽略 `offset/limit` 直接回全量，会把"分页漏页"掩护成绿的 —— 夹具要连分页结构一起复刻
  （本次已把 `scripts/shipping-rate-ui-smoke.mjs` 的桩改成真分页）。

**取证**：`{ productIds }` vs 裸数组；`scripts/shipping-rate-ui-smoke.mjs` 的桩改成真分页。

**源**：`2026-10-22-sku-weight-full-scan`（2026-10-22）

---

## 16. 克重的粒度是「款 × 码」，不是"格"

**结论**：用户口径「审查现在的编辑产品信息页，当前编辑 SKU 信息还是不太方便，请重新设计符合人操作习惯的」。
改之前先把真库（`~/Library/Application Support/seller-kit/sellerkit.db`）跑了一遍，因为"填一次能管几格"
完全取决于业务事实，不能靠推测：

| 事实 | 数字 |
| --- | --- |
| `pl_variants` 总行数 / 填了克重的 | 411 / **303** |
| 按「`product_id` + `size`」分组、只看 ≥2 色的组 | 86 组 ⇒ **全部"同码各色克重完全一致"，0 组不一致** |
| 上面这一条覆盖的 SKU | **298 / 303**（98%） |
| 一款典型规模 | 3 色 × 6 码 = 18 个 SKU |
| 有码阶梯的款（例） | `L500 → XL600 → XXL700 → 3XL800 → 4XL850 → 5XL900` |
| SKU 状态 | 411 行**全部 active**（零停用）⇒ 不给 SKU 级状态入口 |
| SKU 编码 | 411 行**全空** ⇒ 编码继续折叠在 `details` 里是对的 |

**结论**：克重是**款 × 码**的属性。逐格填 40 次里，最多 6 次带着新信息，其余 34 次在重复同一个数字。
而改造前界面只提供"批量值 + 填空格"（全表统一值），且那个输入框无标签地夹在「克重」行中间，
名字叫「批量值」——所以实际没人用，人是一格格敲的。

**取证**：上表数字（真库 `sqlite3 -readonly`）。

**源**：`2026-10-25-sku-weight-by-size`（2026-10-25）

---

## 17. `fillMatrixSizeWeight`：按一列填

**结论**：`fillMatrixSizeWeight(m, size, w, {onlyEmpty})`（`src/lib/skuMatrix.ts`）：按**一列**填。
语义逐条对齐 `fillMatrixWeight`：**只碰存在的格**（绝不因批量填造 SKU）、默认**只填空**、
0/负数/不存在的码 ⇒ **返回原引用**（幂等，调用方靠 `next === before` 判定"没变化"）。

**取证**：变异「`fillMatrixSizeWeight` 忽略 `size`（填全表）」⇒
`FAIL ⭐ 列头填一次 ⇒ …另一码（L）的值一个都没动 \| M=700/700 L=700 (改前 L=320)` +
`FAIL 有格没填时现状读数写「混填」`。

**源**：`2026-10-25-sku-weight-by-size`（2026-10-25）

---

## 18. 矩阵第二行「码克重」

**结论**：每个尺码一个输入框，填了铺满该列。这是阶梯款的路径
（`L 500 / XL 600 / XXL 700` 三次数，代替 18 次）。它**覆盖**（不是只填空）——
在列头敲一个数是"这一码就是这个重量"的明确声明；回执用 `flashHint` 说清改了几格。
占位符三态：该列没格 `—`、有格没填 `待填`、有填但不一致 `混填`。

**取证**：占位符三态 `—` / `待填` / `混填`；`flashHint`。

**源**：`2026-10-25-sku-weight-by-size`（2026-10-25）

---

## 19. 整款值提为主入口

**结论**：`克重 [整款] g │ 铺到空着的 39 格 │ 全部覆盖 │ 当前 500 g`。
主按钮把"影响几格"写在脸上（原来叫「填空格（39）」，要读括号才懂）；
右侧**常显现状**（`当前 500 g` / `当前 混填`）—— 填之前先看见现状，才不会重复劳动、
也不会一按覆盖把核对过的值抹平。现状值走 `matrixWeightCommon`（**派生显示**，不落库）。

**取证**：整款/列头两态读数 `当前 混填` → `当前 800 g`（同一元素两种文本，防"恒显示一句话"的假读数）。

**源**：`2026-10-25-sku-weight-by-size`（2026-10-25）

---

## 20. 单元格合成一个输入框

**结论**：空 = 这个组合不存在（虚线 + `＋`）、`✓` 不存在了（改为"实线 + 待填"）、
数字 = 有值。40 格从 **80 个控件降到 40 个**。空格里**直接敲数字就"加入 + 填值"一步完成**
（原来要点 ✓ 再点输入框敲数）。⚠️ 空格里敲 `0` / 非数字 / 退格成空 ⇒ **什么都不做**，
空格仍是不存在——`normWeightG` 归零即视为没输入，与 `toggleMatrixCell` 同语义。

**取证**：变异「`onWeightInput` 去掉建格分支（空格敲数不加入）」⇒
`FAIL ⭐ 空格里直接敲 250 ⇒ 一步「加入 + 填值」 \| on=false v=250` + `FAIL 清空只把值变成「待填」，组合还在`。

**源**：`2026-10-25-sku-weight-by-size`（2026-10-25）

---

## 21. Delete 两段式（防误删一整条 SKU）+ 键盘

**结论**：值非空时 Delete 交给浏览器删字符；框已经空了再按 Delete
才移除组合。中间那一步（`待填`，组合还在）肉眼可见。
键盘：Enter = 同列下一格（既有），新增 ↑↓ 换行。空格也是输入框之后，Tab 天然沿行序走。

**取证**：Enter 同列下一格；↑↓ 换行。

**源**：`2026-10-25-sku-weight-by-size`（2026-10-25）

---

## 22. 取舍（知情不做）：删掉了「按住拖过几格连续勾选/取消」

**结论**：它当初是为"用按钮逐格切换太慢"做的补偿；
一格一个输入框之后，加入是"敲数"、取消是"Delete"，拖动省的次数被更直接的动作取代了。
整批仍然有：行头 / 列头开关（`setMatrixRowCells` / `setMatrixColumnCells`）、整款值、列头值。
连带的 `drag` / `suppressClick` / `cellDown` / `cellEnter` / `cellClick` 与 `window` 上的
`pointerup|pointercancel` 监听一并删除（色 chip 的拖动是另一套 `chipDrag`，不受影响）。

**取证**：`setMatrixRowCells` / `setMatrixColumnCells`；`chipDrag` 不受影响。

**源**：`2026-10-25-sku-weight-by-size`（2026-10-25）

---

## 23. 取舍（知情不做）：不做「这一格是批量填的」标记

**结论**：批量填是**真写进每格**的（落库就是 40 行各一个值），
要标来源就得再存一份"哪些是覆盖"的状态 —— 那是第二个真相，正是本仓"身份/派生"两条铁律要防的。
需要看差异时，列头的 `混填` + 统计行 `克重 已填 40/40` 已经能回答"还有没有例外"。

**取证**：`混填` + `克重 已填 40/40`。

**源**：`2026-10-25-sku-weight-by-size`（2026-10-25）

---

## 24. 取舍（知情不做）：不做自动保存

**结论**：矩阵仍是显式保存（一次可能改几十格，逐次写库会变成几十次写 + 几十次重拉），
`closeGuard` 照旧只拦"真的会丢"的两类。这轮的取舍是：**减少需要保存的动作**，不是改保存模型。

**取证**：`closeGuard`；显式保存。

**源**：`2026-10-25-sku-weight-by-size`（2026-10-25）

---

## 25. 坑：`ed-cell` 钩子一消失，四条旧断言一起红，但全是"测量对象变了"

**结论**：

- `ed-cell[aria-pressed="true"]` 数"存在的格" ⇒ 改数 `ed-weight[data-cell-on="1"]`；
- `all('[data-act="ed-weight"]').map(value)` 读值 ⇒ 空格也是输入框了，**必须过滤存在的格**，
  否则 `['320','150','','180']` 变成 6 个含 `''` 的项；
- `iw-sku-weight`（建款向导，共用本组件）按下标取第 1 个喂 `88` ⇒ **喂到了空格上**，
  等于凭空造出一条 SKU（实测提交出 3 行，其中两行同是 `黑/M`）。改为按 `data-cell-on="1"` 取下标；
- `querySelectorAll('.mx-tog')[1].click()` ⇒ `undefined.click()` 直接把整段注入脚本打断
  （表现是"抓不到 `#smoke-result`，页面可能没挂载"）。改用 `killCell()`（清值 + Delete）。

⇒ 教训：**控件合并时必须先搜一遍"哪些断言在数控件"**，它们红起来长得像功能坏了。

**取证**：实测提交出 3 行，其中两行同是 `黑/M`；`['320','150','','180']` 变成 6 个含 `''` 的项。

**源**：`2026-10-25-sku-weight-by-size`（2026-10-25）

---

## 26. 坑：注入脚本里 `function cellOf` 撞名

**结论**：前面某个步骤已有一个 `cellOf(act, rowIndex)`，
同名函数声明在严格模式下是 `SyntaxError: Identifier 'cellOf' has already been declared`，
整段脚本一行都不执行。改名 `wCell` 解决。**同名函数声明是硬错，不是覆盖**。

**取证**：`SyntaxError: Identifier 'cellOf' has already been declared`。

**源**：`2026-10-25-sku-weight-by-size`（2026-10-25）

---

## 27. 坑：注释里的反引号又一次截断整段注入脚本

**结论**：写 `` `data-cell-on` `` 当术语用：
报错是 `SyntaxError: Unexpected identifier 'data'`，指向的行号是**整页**的，不是脚本的。
本仓已有这条坑的记录，仍然踩了 —— 注入段里描述字段名一律不带反引号。

**取证**：`SyntaxError: Unexpected identifier 'data'`。

**源**：`2026-10-25-sku-weight-by-size`（2026-10-25）

---

## 28. 坑：`@change` + `@keydown.enter` 双触发

**结论**：列头按 Enter 会先把 `change` 走一遍、再被 Enter 处理一次，
第二遍只剩"已经都是 X g"的回执。改为 Enter ⇒ `blur()`（让 `change` 自然发生一次）。

**取证**：Enter ⇒ `blur()`。

**源**：`2026-10-25-sku-weight-by-size`（2026-10-25）

---

## 29. 坑：`--dump-dom` 拿不到堆栈

**结论**：给 `runChrome` 加了 `--enable-logging=stderr` 与
`SMOKE_DEBUG=1` 才看见 `INFO:CONSOLE ... Uncaught SyntaxError`。没有它时会话里只剩"页面可能没挂载"一句，
与"资源 404 / 假桥缺键"完全分不开。这段能力留在脚本里（默认静默）。

**取证**：`--enable-logging=stderr` / `SMOKE_DEBUG=1`；`INFO:CONSOLE ... Uncaught SyntaxError`。

**源**：`2026-10-25-sku-weight-by-size`（2026-10-25）

---

## 30. 遗留（知情不做）：1 色 2 码留白、SKU 编码/状态无入口

**结论**：

- **1 色 2 码时表格右侧留大片空白**：`width: max-content` + `min-width: 100%` 会把剩余宽度都塞给
  最后一列，于是两个格离得很远。这是本轮之前就有的行为（列宽逻辑没动），真库典型款是 3 色 × 6 码，
  基本不触发；要治得给表格加"填充列"或放弃撑满，两条都会动既有几何断言。
- **SKU 编码 / 状态仍无入口**：真库 411 行全空 / 全 active，按"没有人用的字段不占位置"保留现状。
  将来若开始用编码，它该进列头而**不是**再占一行。

**取证**：`width: max-content` + `min-width: 100%`；真库 411 行全空 / 全 active。

**源**：`2026-10-25-sku-weight-by-size`（2026-10-25）

---

## 31. 不变量：克重即存在

**结论**：用户原话「我所有的克重都已经填好了，点击保存 SKU 矩阵时，还是提示"矩阵里没有勾选的 3 个组合会被删掉：
黑色 L、白色 L、红色 L"。保存按钮和完成按钮合并，放在完成上。」
根因不是提示文案的问题：三个颜色同时缺 **L 码**，这个形状本身就是线索：缺的不是"某一格"，而是**一整列**。
能造成这个状态的有两条路，两条都真实存在：

1. **列头点一下 = 整列取消**（`toggleColumn`）。而"填这一码的克重"的输入框就在列头**正下方 22px**。
   想填 L 列克重，手一偏就点到上面的码名 —— 三格 SKU 从矩阵里消失。当时**没有任何回执**。
2. 之后在列头填 `500`，`fillMatrixSizeWeight` 对不存在的格是 `if (!cell) return r`
   （"空格 = 组合不存在，批量填不造 SKU"），于是**一个格都没写进去**；
   而回执只有一句「这一列已经都是 500 g」—— 人读到的是"填好了"。

矛盾在语义层：**格内敲数字 = 创建组合**（`onWeightInput`），**列头敲数字 ≠ 创建**
（`fillMatrixSizeWeight`）。同一个动作（输入一个克重）在两种位置有两种存在性后果，
用户看到的就是"我明明填了，你却要删"。
**不变量：克重即存在。** 给一个组合填了克重，就是声明它在卖。

**取证**：`toggleColumn`；列头正下方 22px；`if (!cell) return r`。

**源**：`2026-10-25-sku-weight-presence-and-save-merge`（2026-10-25）

---

## 32. 三道兜底

**结论**：

1. `fillMatrixSizeWeight` 新增 `createMissing`（默认 false，组件传 true）：列头敲数 = 这一码整列，
   缺的格一起补上。回执改成说事实：「M 这一列改成 800 g · 补齐 1 个原本没有的组合」。
   同时 `applyColWeight` 补两个分支：没有颜色行 / 这一列 0 个组合，各自说实话（不再报"已经都是 X g"）。
2. **整行/整列开关给「撤销」**（12s 内可收回）：误点当场救回，不必"放弃改动"重来。
   回执直说后果：「已取消「L」整列 3 个组合（保存时会列为删除）」。
3. **删除确认加第三个出口**「保留这 N 个」：把确认框里列出的 SKU 连同 `variantId`、原克重
   一起加回矩阵（非破坏方向，还没落库，人可再核对）。只给"删除 / 取消"时，误点的人只能整轮重来。
4. **保存合并到「完成」**：工具条不再有"保存 SKU 矩阵"按钮，只留状态徽标
   （`有 5 处待保存` / `SKU 已保存`，点一下 = 立即存但不关）。`complete()` 先存矩阵再关；
   有删除则弹确认，确认后落库并关，取消则留在抽屉。
   `closeGuard` 文案同步："按「完成」会一并保存"。

**取证**：守卫新增/改写 12 条：按码填补齐、补齐回执、撤销回执、完成=存+关、完成不弹确认、
状态徽标文案、颜色不滚动、常用色含已设置色、编码规则预览/一键/全部重写、编码不落库。
变异三条各只红目标断言：

| 变异 | 结果 |
|---|---|
| `createMissing` 改回 false | 「列头填值把这一列缺的格补齐」红（`row1/M on=false`） |
| `.mx-colors` 加回 `max-height/overflow-y` | 「颜色区完全展开」红（`overflowY=auto`） |
| `complete()` 不存矩阵 | `weight-save-in-drawer` 超时（点完成 → 弹未保存确认 → 抽屉不关） |

**源**：`2026-10-25-sku-weight-presence-and-save-merge`（2026-10-25）

---

## 33. 顺带三件（同一轮用户口径）

**结论**：

- **颜色区不再滚动**：删掉 `max-height: 96px / 64px` 两档 + `overflow-y: auto`。
  实测 8 色 `scrollHeight/clientHeight = 68/68`、`overflow-y: visible`。
- **常用色加"已设置的颜色"**：`paletteColors = 字典色 ∪ 本品已在用的色名`。
  自定义色（酒红 / 灰白 / 藏青）第二次不用手打，也就不会因为打错字变成两个色。
- **SKU 编码规则 + 一键生成**（`src/lib/skuCode.ts`）：占位符 `{code} {color} {size} {index}`，
  默认 `{code}-{color}-{size}`，规则存 localStorage。
  「一键生成」**只填空**（已有编码不动）、「全部重写」是另一个显式动作；
  批内重名自动 `-2`，超 64 字跳过并计数，规则里一个占位符都没有则拒绝生成（否则 40 条同一个编码）。

**取证**：实测 8 色 `scrollHeight/clientHeight = 68/68`、`overflow-y: visible`；`src/lib/skuCode.ts`。

**源**：`2026-10-25-sku-weight-presence-and-save-merge`（2026-10-25）

---

## 34. 留下的判断：整款填只碰存在的格；列头仍是整列开关

**结论**：

- 整款填（"铺到空着的 N 格"）**仍然只碰存在的格**：它是"补作业"，不是"声明整款都在卖"。
  按码填补齐是因为列 = 一整排格子，人有理由认为"这一码就是这样"。
- 列头仍是整列开关（一份控件两个职责），靠"撤销 + 删除确认里的保留"兜住误点；
  真要做成"列头只选列"，得重做选区模型，这一轮没动。

**取证**：`fillMatrixWeight`（只碰存在的格）vs `fillMatrixSizeWeight`（`createMissing`）。

**源**：`2026-10-25-sku-weight-presence-and-save-merge`（2026-10-25）

---

## 35. 一条数据只能有一个维护面

**结论**：用户口径「未关联采集商品页面只认款」「把修改 SKU 矩阵的功能与产品编辑
里的 SKU 编辑合并，最终目的是产品只维护一套完整的 SKU 矩阵，矩阵来源于采集商品」。
采集段的 SKU 列改成**只读文本**，行内不再有「改/补」入口；
`shop-items-update-sku` 通道整条删除（主进程 handler → preload → `src/types.ts` →
`src/core/services/ipc.ts` → `goods/api.ts` 五处一起删）。采集快照 `sku_json` 从此**只由采集帧写**，
产品侧写的是 `pl_variants` —— 两份数据各归其主，不再互相回写。

**取证**：门禁（2026-10-23 实跑）`lint` 0 error（521 warning）· `verify`（preload 211 / types 211 / 主进程 206）·
`verify:docs` · `vue-tsc --noEmit` · `tsc -p tsconfig.electron.json` · `vitest` 45 文件 / 872 用例 ·
`build` · `goods:ui`（宽 / 默认 / 窄三遍 ALL PASS）· `shop-item:smoke` 全绿 ·
`ipc:shape:smoke` 53 项全绿。`schema:smoke` 未跑：本轮没有表形状 / 迁移改动。

**源**：`2026-10-23-product-sku-single-source`（2026-10-23）

---

## 36. "按款筛采集商品"必须是服务端过滤

**结论**：`shop-items-list` 新增 `productId`，SQL 走**与列表同一份**
`LATEST_MAP_JOIN`（最新一条 `confirmed` 映射，`ORDER BY m.id DESC LIMIT 1`），COUNT 也带同一个 JOIN。
前端过滤会漏分页：产品编辑一次只取前 100 条候选，第 101 条之后的认款商品永远进不了导入面板。

**取证**：`shop-item:smoke` 按款筛三条 —— 只列"当前认到该款"（未认款 / 认到别款 / pending 都不出现，
`total` 与 `rows` 同口径）；改绑后旧款筛不到；`0 / NaN` 视为不过滤。
⚠️ `NaN` 也是 `typeof 'number'`，不拦会绑进 SQL 直接抛。

**源**：`2026-10-23-product-sku-single-source`（2026-10-23）

---

## 37. "历史认过"不等于"现在认的是它"

**结论**：同一商品改绑后，旧款的导入面板不能再列出它 —— 这是
`LATEST_MAP_JOIN` 而不是"存在任一 confirmed 映射"的原因。测法：同一 `item_id` 为两个款各写一条
confirmed（唯一键含 `product_id`，结构上允许），后写的那条 id 更大 ⇒ 只有新款筛得到。

**取证**：`ORDER BY m.id DESC LIMIT 1`；`npm run shop-item:smoke` 改绑后旧款筛不到。

**源**：`2026-10-23-product-sku-single-source`（2026-10-23）

---

## 38. 导入只能"补缺口"

**结论**：`mergeSkuMatrix(base, incoming)`（`src/lib/skuMatrix.ts`）的语义：

- 已有的组合、已填的克重、SKU 编码**一个都不覆盖**（采集里的 999g 打不过产品已有的 320g）；
- 空格只从 0 补成采集值；新色/新码只在该采集行**真有这个组合**时加，**不笛卡尔补齐**；
- 按色名（trim 后）对齐；无变化时返回原对象引用 ⇒ 幂等、重导入不会造出第二份改动。

纯函数 + `tests/skuMatrix.spec.ts` 9 例；夹具里必须放一个**竞争值**（999 vs 320），
否则"覆盖式合并"与"只补缺口"在断言上长得一样。

**取证**：`goods:ui` 的 `matrix-import` 步：并入后克重逐格是 `['320','150','','180']`（⭐ 只补缺口）、
色图载荷只有红色一条、`productVariantUpsert` 为 0、导入算未保存改动（关闭先确认）。

**源**：`2026-10-23-product-sku-single-source`（2026-10-23）

---

## 39. 导入不是保存

**结论**：并入只改界面上的矩阵：按钮变成「保存 SKU 矩阵（N）」、抽屉的"未保存改动"
守卫要把它算进去（关抽屉照样先确认），落库仍走原有的全量提交。导入那一刻
`productVariantUpsert` 的调用数必须是 **0** —— 否则"导入即生效"会把用户还没看过的矩阵直接写进库。

**取证**：`productVariantUpsert` 为 0。

**源**：`2026-10-23-product-sku-single-source`（2026-10-23）

---

## 40. 色图顺手采纳，但只补空、失败不拦

**结论**：按「采集行 id + 产品 id + 色→图（同色只取第一张）」
调 `shop-item-image-fetch`；主进程侧仍是 `adoptStyleColorImageByCode` 的"目标色已有图就不换"。
矩阵合并与图片采纳是两件事：图片失败只影响回执里的采纳计数，矩阵照常并入。

**取证**：色图载荷只有红色一条；`adoptStyleColorImageByCode`。

**源**：`2026-10-23-product-sku-single-source`（2026-10-23）

---

## 41. 界面分工（谁写什么）

**结论**：

| 面 | 能做什么 | 不能做什么 |
| --- | --- | --- |
| 采集段「待关联采集商品」 | 认款（关联到已有款 / 建款向导）、删采集快照 | 改 SKU 矩阵（只读展示，色码文本 + 未采集态） |
| 产品编辑抽屉 | 维护矩阵（色/码/克重/组合）；「从采集商品导入」补缺口 | 导入不会自动保存；不覆盖已有值 |
| 建款向导（从采集商品新建款） | **建档那一刻**用采集矩阵预填 | 建档后不是维护面 —— 再改去产品编辑抽屉 |

> 向导的预填保留是刻意的：它回答"这个新款的初始矩阵长什么样"，而不是给产品开第二个长期维护入口。

**取证**：`goods:ui` 的 `matrix-import` 步；`npm run shop-item:smoke`；`npm run ipc:shape:smoke`。

**源**：`2026-10-23-product-sku-single-source`（2026-10-23）

---

## 42. 守卫（每条都对应一种"看起来对"的坏实现）

**结论**：

- `npm run goods:ui` 的 `matrix-import` 步：
  - 断言请求载荷带 `productId:1` 且**不带** `onlyUnconfirmed`（复用采集段的参数会把已认款的那条候选筛掉）；
  - 候选恰为 `B0XYZ1234`（没采到 SKU）+ `1005007777777777`；未认款的 7001 / 7003 必须在列表外；
    假桥的 `shopItemsList` **真的按 productId 过滤**（只 `rec` 不过滤的桩会让"服务端过滤"恒绿）；
  - 并入后克重逐格是 `['320','150','','180']`（⭐ 只补缺口）、色图载荷只有红色一条、
    `productVariantUpsert` 为 0、导入算未保存改动（关闭先确认）。
- `npm run ipc:shape:smoke`：`productId > 0` 原样透传；`productId=0` 在载荷里必须是 `undefined`
  （主进程的 0 = 不过滤，压成 0 就与"认到 0 号款"分不开）；返回行确实只含认到该款的那一条。
- `tests/uxEntryNames.spec.ts`：文案里的引号名必须是真入口。本轮踩到两处 ——
  ①写「采集商品」段（真名是**待关联采集商品**，已按同组分段控件登记豁免，存在性由 `goods:ui` 钉）；
  ②写「颜色 › + 添加」这种**控件路径**：`entryParts` 会按 ` › ` 拆段逐段校验，段名不是入口就红 ⇒
  改成"用颜色栏的「+ 添加」"（引号里只留按钮文字）。

**取证**：`goods:ui` `matrix-import` 步 / `ipc:shape:smoke` 53 项 / `uxEntryNames.spec.ts`。

**源**：`2026-10-23-product-sku-single-source`（2026-10-23）

---

## 43. 踩坑

**结论**：

- **注入脚本是独立作用域**：`goods:ui` 的假桥里 `var PL_ITEM_SKU_IMG = …`，断言脚本（另一段
  `<script>`）直接引用会 `PL_ITEM_SKU_IMG is not defined`。跨段传值走 `window.__smokeImg.itemSku`
  （与 `__smokeProductImg` / `__smokeLongStyleName` 同法）。
- **导入步骤必须"放弃"而不是"保存"**：后面的 `weight-save-in-drawer` 步断言第一次
  `productVariantUpsert` 的载荷就是它自己那一格；导入若顺手保存，这条会被一次全量提交污染成假红。
  收尾走 `.ed-x` → 确认框「放弃改动并关闭」，并断言此刻 SKU 写入仍是 0。
- **删一条通道不是删一个方法**：`shop-items-update-sku` 在 handler / preload / types / ipc 服务 /
  `goods/api.ts` 各有一份；少删一处 `npm run verify` 会红（这是它的价值），但**载荷形状**它看不见，
  故按款筛的透传另由 `ipc:shape:smoke` 钉。

**取证**：`PL_ITEM_SKU_IMG is not defined`；`window.__smokeImg.itemSku`；`.ed-x` → 「放弃改动并关闭」。

**源**：`2026-10-23-product-sku-single-source`（2026-10-23）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-17-sku-spec-rack-and-weight.md` | 2026-10-17 | §1 / §2 / §3 / §4 / §5 / §6 / §7 / §8 / §9 / §10 / §11 / §12 |
| `2026-10-22-sku-weight-full-scan.md` | 2026-10-22 | §13 / §14 / §15 |
| `2026-10-23-product-sku-single-source.md` | 2026-10-23 | §35 / §36 / §37 / §38 / §39 / §40 / §41 / §42 / §43 |
| `2026-10-25-sku-weight-by-size.md` | 2026-10-25 | §16 / §17 / §18 / §19 / §20 / §21 / §22 / §23 / §24 / §25 / §26 / §27 / §28 / §29 / §30 |
| `2026-10-25-sku-weight-presence-and-save-merge.md` | 2026-10-25 | §31 / §32 / §33 / §34 |
