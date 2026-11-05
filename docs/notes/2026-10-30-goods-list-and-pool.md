# 货品列表与泳池：34 条结论（蒸馏自 6 篇，2026-10-08 ~ 2026-10-25）

> **蒸馏笔记**：由 6 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/<原文件名>`

## 1. 并列的页签等于没有起点

**结论**：用户说"不知道该从哪里开始、也不知道该做什么"时，先别去看"功能是不是太少"—— 那多半是
**页面的组织维度选错了**：`src/modules/goods/GoodsView.vue` 当时把产品 / 商品清单 / 映射与关联 /
供应商 摆成四个**并列**页签，而"我该从哪开始"在这张页面上**没有任何答案**。
同一仓里「今天」页早就有流程卡（`TodayView.vue` 的 `flow` / `flowNow` + `OverviewPanel.vue` 渲染），
**同一套语言没有被第二页复用**。

**取证**：

```bash
npm run goods:ui      # report() 53 → 63 项（新增 10 条、删掉 2 条旧「商品清单」断言）
./node_modules/.bin/vitest run tests/goodsFlow.spec.ts   # 9 条
```

⚠️ **本笔记已降级为历史记录（2026-10-08 晚）**：文中的**引导条**（立款 → 补克重 → 认货）
与它的判据 `src/modules/goods/flow.ts`（含 `tests/goodsFlow.spec.ts`）**已按用户要求整体撤除**
—— 用户的原话是"步骤条感觉实用意义不大"。同一次撤除还包括页首那条**指标条**与页签徽标。
下面记述的判断（"并列页签等于没有起点"、"有没有下游消费者是收功能的唯一判据"、"`0` 与 `null`
必须分开"）**仍然成立、仍然可复用**；只是这一页最终选择用"点一遍页签就知道顺序"来替代常驻引导条。
撤除的经过见 `CHANGELOG.md` 的同日条目与 `.workbuddy/memory/2026-10-08.md`。

**源**：`2026-10-08-goods-page-entry-guide`（2026-10-08）

---

## 2. 先问"几个入口是真的"，再问"怎么排版"

**结论**：这一页真实只有两条链：① 立款（供应商 → 产品(款) → SKU 克重）· ② 认货（订单 → 待关联队列 →
映射(款+色)）。四条并列里有**一条是断头路**（见 §3）。并列入口的数量不是排版问题，是**这一页到底有几件事**的问题。

**取证**：判据写在 `src/modules/goods/flow.ts`；断言 `tests/goodsFlow.spec.ts`；
界面契约 `scripts/goods-ui-smoke.mjs` 的 `guide` / `guide-go-filter` / `guide-advance` /
`guide-go` / `empty-entry` 五步。

**源**：`2026-10-08-goods-page-entry-guide`（2026-10-08）

---

## 3. "有没有下游消费者"是收功能的唯一判据

**结论**：同 2026-10-01 删 `DB_OPS` 域的判据。「商品清单」写的池行被判据谓词 `skuPoolSql()` 圈住，而
**全仓只有 `electron/shop-product-db.ts` 自己读它**；订单归款 / 拣货 / 算钱一律走补集
`skuMappingSql()`（`electron/product-db.ts:809-826` 的注释直说两者"同表共存"）。
⇒ 用户在这个页签做的事**不影响任何其它页面**。

**取证**：`grep -n "skuPoolSql\|skuMappingSql" electron/*.ts` —— `skuPoolSql` 只在
`electron/shop-product-db.ts` 出现；`skuMappingSql` 在 `product-db.ts` 的映射读写、`shopSku.ts`
与 `product-sku-smoke.cjs` 里出现。

**源**：`2026-10-08-goods-page-entry-guide`（2026-10-08）

---

## 4. "导入后回显"这个需求要先确认它由谁满足

**结论**：用户以为商品清单是"导订单后看看进来了什么"，实际它要求**另准备一份** Excel（列名须为
「产品ID」「产品图片链接」，`productIo.ts:296`），且完全不读订单。真正的回显是「映射与关联」的待关联队列
（实时聚合 `oi_orders`）与「今天」页的导入回执 —— 收掉商品清单**不损失任何能力**。

**取证**：`productIo.ts:296`；队列实时聚合 `oi_orders`。

**源**：`2026-10-08-goods-page-entry-guide`（2026-10-08）

---

## 5. `0` 和 `null` 必须分开

**结论**：这一条在 2026-10-05 的"产品维度指标格"里已经立过一次，这次是第二例。
外壳首屏停在「产品」页签时队列**根本没被拉过** ⇒ `mappedQueue` 是 `null` 不是 `0`。
把 `null` 当 0，引导条会说出"都认完了"——那是它**不知道**的结论，代价是用户不再去配映射。

**取证**：

| 变异 | 预期变红 | 实际 |
| --- | --- | --- |
| `flow.ts` 把 `null` 当 0（`count(input.mappedQueue ?? 0)`） | 「队列没取到时不能说队列是空的」 | ✅ 1 failed |
| 去掉串联语义（`wait1` 恒空） | 空库用例 + 排他性 + 脏值 | ✅ 3 failed |
| `SHOP_PRODUCTS_TAB_ENABLED = true` | 「三个页签」+「商品清单已收起」 | ✅ 2 FAIL |
| `goStep` 只切页签、不传 `intent` | 「点下一步把列表筛窄」 | ✅ `SMOKE: FAILED at [guide-go-filter] - timeout` |

⚠️ 第四条值得记一下：**「按钮可点」和「按钮有目的地」是两条断言**。只断言"切到了某个页签"
的话，把 `goStep` 改成 `goTab(s.tab)` 照样全绿（页签确实切了）—— 必须断言**结果**
（列表真的窄到 1 行、且活跃筛选行真的出现）。

**源**：`2026-10-08-goods-page-entry-guide`（2026-10-08）

---

## 6. 【历史记录】引导条与 `flow.ts` 的落地（已撤除）

**结论**：新纯函数 `src/modules/goods/flow.ts` 的 `buildGoodsFlow()`：三步进度，判据照搬「今天」流程卡的
**串联语义**（前一步没完成，后面一律 `todo` + "等第 N 步"），使"当前步"**至多一个**。
`GoodsView.vue` 页头下加**引导条**：三步徽标 + 一句带数字的理由 + 一个**真能过去的**按钮
（`data-act="guide" / "guide-step-<key>" / "guide-next" / "guide-go"`）。
到「产品」页签的按钮**必须带上筛选意图**（`intent`）—— 只切页签不筛，用户还得在 27 个款里
自己找那 3 个缺克重的，那就是这一页刚删掉的"假动作"变体。
⚠️ 这条落地已按用户要求整体撤除（引导条 / `flow.ts` / `tests/goodsFlow.spec.ts` / 页首指标条 / 页签徽标）。

**取证**：`src/modules/goods/flow.ts`；`./node_modules/.bin/vitest run tests/goodsFlow.spec.ts` 9 条；
撤除记录见 `CHANGELOG.md` 同日条目与 `.workbuddy/memory/2026-10-08.md`。

**源**：`2026-10-08-goods-page-entry-guide`（2026-10-08）

---

## 7. 只收界面，数据一行不删

**结论**：新常量 `SHOP_PRODUCTS_TAB_ENABLED = false`：**只收界面，数据一行不删**
（`ShopProductView.vue`、6 个 `shop-product-*` 通道、`shop-product-db.ts`、存量池行全留）。
恢复 = 把常量改成 `true`，其余一行不用动。

**取证**：变异 `SHOP_PRODUCTS_TAB_ENABLED = true` ⇒ 「三个页签」+「商品清单已收起」2 FAIL。

**源**：`2026-10-08-goods-page-entry-guide`（2026-10-08）

---

## 8. 空态要补齐同形态的下一步按钮

**结论**：`SkuMappingView.vue` 队列空态补「去「今天」导入订单」按钮（`switchModule('today')`）——
同文件下面那个空态（"还没有任何映射"）早就有下一步按钮，这里只是补齐同一形态。
另：`SkuMappingView.vue` 里那句"队列不是缓存表，而是**实时**…"原先把 markdown 写进了**纯文本节点**，
界面上原样显示四个星号 —— 已删。（`.wb-empty__desc` 是纯文本，不渲染 markdown。）

**取证**：`SkuMappingView.vue`；`.wb-empty__desc` 是纯文本，不渲染 markdown。

**源**：`2026-10-08-goods-page-entry-guide`（2026-10-08）

---

## 9. "展示不全"是两半问题，只做一半不会好

**结论**：撤列（腾宽度）+ **款名自己折行**。折行必须落在**里层 `span`** 上（`.gd-pane__name-text`），
因为 `td` 得保持 `table-cell` —— 直接在 `td` 上写 `display:-webkit-box` 会让那一格**脱离表格布局**。
上限两行、`title` 给全文。

**取证**：`npm run goods:ui > /tmp/x.log` 再数 `^PASS ` ⇒ **242 = 全量 220 + 默认窗口可达性 11 + 窄视口 11**
（本次全量 +2：撤 3 条、加 5 条）。实测值（1440 全量那遍）：左栏 476.8px；款名字格
`clientWidth=231 / scrollWidth=231`、折行盒 `clientHeight=scrollHeight=35`（= 两行）。

**源**：`2026-10-10-goods-list-slimming`（2026-10-10）

---

## 10. 撤列必须逐条回答"那件事现在去哪做"

**结论**：否则就是静默降级（本仓 2026-10-08 记过的现行犯）：

| 撤掉的 | 留下的入口 | 谁在守 |
| --- | --- | --- |
| 主表「缺克重」列 | 工具栏「问题件 › 缺克重」筛选 | `filter-issue`（既有 + "唯一入口"那条） |
| 主表「进价」列 | 同页「进价」页签（含"还没维护进价的款"清单） | `cost-tab` 步 |
| 展开区 SKU 清单 | 「编辑」抽屉（颜色 × 尺码 + 逐行克重） | `weight-save-in-drawer` 步 |

⭐ 判断顺序：**先问"这个数字还有没有别的界面入口"**，有才撤；撤的同时把反向守卫写上
（"它不在了"也要钉住，加回来就红）。

**取证**：变异「把 `SKU` 列加回主表（th + td）」⇒ 三条可读 FAIL：
`主表不再有 SKU 数/缺克重/进价三列 sku=true` · `空态 colspan=5 表头=6` · `认款动作条 relate=383/467`。
（后两条是"顺带被守住"的既有断言：撤列时 `gdColspan` 忘了改、以及列一多布局就变窄，都能被看见。）
门禁：`tsc -p tsconfig.electron.json` ✅ · `vue-tsc --noEmit` ✅ · `verify` ✅（IPC 契约零改动）·
`verify:docs` ✅ · `build` ✅ · `vitest run` **644 passed** ✅ · `goods:ui` **三遍 ALL PASS**。

**源**：`2026-10-10-goods-list-slimming`（2026-10-10）

---

## 11. "临时开关 + 页级刷新"造/复位夹具，会污染别人的绝对计数

**结论**：为验长款名，一度写成"打开开关 → 点刷新 → 断言 → 关开关 → 再刷新"，
结果**每次页级刷新右栏都会重新合批取图** ⇒ 队列那条"缩略图只合批取 **1** 次"实测变成 **3**
（红的却是队列断言，排查方向整个反过来）。正解：**把长款名做成常驻夹具**（S1 的名字本身）。
这与 2026-10-08 那条"绝对计数会被同通道其它调用污染"同源，**这次的污染源是我自己的夹具手法**。

**取证**：实测"缩略图只合批取 1 次" → **3**。

**源**：`2026-10-10-goods-list-slimming`（2026-10-10）

---

## 12. 夹具必须能造出"放不下"，否则断言恒绿

**结论**：短款名（`款一`）在两行内怎么排都放得下 ⇒ `scrollHeight <= clientHeight` 恒真。
夹具里 S1 现在是 **24 字**长名（实测 314px 宽，1440 视口下款名列只有 231px ⇒ 必然折两行）。
同理，**里层盒的 `clientHeight > 0` 必须写进判据**：退回单行省略号时它是 `display:inline`，
`clientHeight/scrollHeight` 是 **0/0**，而 `0 <= 0 + 1` 恒真 —— 实测变异时它照样绿。

**取证**：变异「款名退回"单行省略号"（`max-width:0` + nowrap + ellipsis，里层 span 改回 `inline`）」
⇒ 两条可读 FAIL：`长款名横向不溢出 w=314/231` · `长款名最多两行 h=0/0`。
⚠️ baseline 原记的「227 = 205+11+11」与工作区实测对不上，已在 baseline 里标注**口径更正（第 3 次）**：
同日那批「进价」页断言没被算进那 205。

**源**：`2026-10-10-goods-list-slimming`（2026-10-10）

---

## 13. 回退形态（`GOODS_LAYOUT='tabs'`）不动

**结论**：`ProductListView` / `SkuMappingView` 的契约是"与重构前逐字一致，回退 = 改一个常量"。
它的列组成现在与 workbench 不同，这是回退路径的应有状态。

**取证**：`node --check` 的两个盲区本轮又各撞一次（都当场抓到，未造成假绿）：
① 外层模板串注释里带反引号 ⇒ 模板串提前闭合；② **注入脚本内部**的注释带反引号 ⇒ `node --check` 也报，
但要按"抠出注入脚本单独 check"的习惯看，才不会把报错读到外层去。

**源**：`2026-10-10-goods-list-slimming`（2026-10-10）

---

## 14. 右栏三段并两段（待认 / 已认）后，判据必须跟着换

**结论**：把「待关联队列（订单）」+「待关联采集商品（采集）」合成一张「待认」表之后，
**判据必须跟着换**。凡是拿"表在不在""行数是多少""徽标有没有"当证据的断言，合并后要么恒绿、
要么恒红 —— 而且长得都像"版面坏了"。本轮同时挖出 3 个**产品侧真错**（不是断言问题），
都是"两个来源合用一个视图"才暴露出来的。

**取证**：改动落点：`src/modules/goods/useSkuPool.ts`（`pendingRows` / `pendingTotal` / `pendingWriteRows`）、
`src/modules/goods/components/PoolPane.vue`（合并段、动作条、行内出口）、
`src/modules/goods/components/ProductPane.vue`（删 `relate-from-expanded`）。

**源**：`2026-10-25-goods-pending-merge`（2026-10-25）

---

## 15. 真错一：向导建完款并关联后，计数虚报

**结论**：症状是动作条仍写「已选 1 项」、「认到 X（1 项）」照样亮着，但清单里一条勾中的都没有。
根因：计数是「清单 ∩ 选择集」（`pendingSelectedRows`）。`createProductFromItem` 写完只 `commitMap`，
**没把这一行的 key 从 `pendingSelected` 里摘掉**；行已离开清单，key 还在 ⇒ 计数虚报。
`relatePending` / `applyPick` 都清了，只有向导这条漏了。
改法：向导提交后按 `i:<行 id>` 单独摘掉（不整集清空：别的动线可能同时勾着更多行）。

**取证**：`src/modules/goods/useSkuPool.ts` 的 `pendingSelectedRows` / `createProductFromItem` / `commitMap`。

**源**：`2026-10-25-goods-pending-merge`（2026-10-25）

---

## 16. 真错二：「店铺未登记」的采集行删不掉

**结论**：症状是只剩「去登记」。根因：行内动作被包在 `v-if="r.canRelate"` 里 ⇒ 认不上的行连「删除」一起没了。
而认不上的行（采错了、店铺没登记）恰恰是最该清掉的。
改法：把「删除」提到 `canRelate` 之外（删的是采集快照，与"能不能认款"无关）。

**取证**：`src/modules/goods/components/PoolPane.vue`（合并段、动作条、行内出口）。

**源**：`2026-10-25-goods-pending-merge`（2026-10-25）

---

## 17. 真错三：分段徽标少报

**结论**：两处症状 —— 队列分页（`queueLimit` + 显示更多）时只数已加载的行；停在「已认」段收到采集广播
（只刷汇总）时数字纹丝不动。根因：徽标写的是 `pendingRows.length` —— 它回答的是"当前加载了几行"。
改法：改 `pendingTotal` = `queuePendingTotal`（未关联 + 店铺未归一）+ `itemStats.unmapped`
（summary 的 total − confirmed），筛选下拉的三个数同源。

**取证**：`src/modules/goods/useSkuPool.ts` 的 `pendingTotal`。

**源**：`2026-10-25-goods-pending-merge`（2026-10-25）

---

## 18. 冒烟判据的五条改写（合并后旧判据全部失效）

**结论**：

1. **「零采集时给接入引导」不能判"表不存在"**：订单行还在同一张表里 ⇒ 表恒在。
   改写为「接入引导在 + 采集侧没有行」（`.gd-panel__empty` 文案 + `tr[data-origin="scrape"]` 计数 0）。
2. **夹具翻空必须显式点刷新**：合并段常驻，改「来源」筛选只是筛选、**不触发重拉**
   （旧实现靠"切分段"触发 `watch(sub)`）。不刷新就永远等不到空态。
3. **判"某来源没有行"必须先筛到那一边**：筛选留在「订单」时 `tr[data-origin="scrape"]` 恒为 0 ——
   那是**空判据**（永远成立 ⇔ 断言无效），不是证据。
4. **「广播只刷徽标、不动列表」只能在「已认」段验**：合并段就是待认段，广播**本来就该**重拉列表
   （那是另一条契约）。同时徽标判据从"在不在"改成"数字变了"——订单还在时它不会消失。
5. **逐行「未认款」文案已撤**（整段就是待认）：等它就绪的判据改成"该行复选框可勾"。

**取证**：`npm run goods:ui` 三遍（1440 / 1200 / 900）ALL PASS；变异 2 组各只红目标断言
（复制提交按钮 / 删来源标签）。单测 910 项全绿；`npm run verify` 通过。

**源**：`2026-10-25-goods-pending-merge`（2026-10-25）

---

## 19. 两条注入脚本的坑（都不是新坑，但又踩了）

**结论**：

- **注释里不能出现反引号**：`ASSERT_SCRIPT` 是模板字面量 ⇒ 一个反引号会把后面整段代码吞进字符串，
  报错行号指向"完全无关的注释行"，`node --check` 也只检查**文件**（字符串内容它看不见）。
  本轮踩了 3 次（`box.click()` / `null` / `!b2Box.checked`）。
- **`settle()` 没有返回值**（它只是轮询到超时就返回）。写 `var ok = await settle(...)` 再拿 `ok` 当判据
  ⇒ **恒假**。落停后必须自己再判一次条件。
- **盲点复选框**：`togglePendingOne` 是"切换"而非"按 `e.target.checked` 赋值" ⇒ 若该行渲染时已是勾选态，
  `click()` 等于**取消勾选**。症状是"点了却没反应"，根因在**上一次写入**（见 §15 错误 1）。
  守卫写法：先说清前置（行存在、可勾、**且不是勾选态**），再点，再判"计数真的变成已选"。

**取证**：`ASSERT_SCRIPT` 模板字面量；`togglePendingOne`。

**源**：`2026-10-25-goods-pending-merge`（2026-10-25）

---

## 20. 认款入口收敛后的反向守卫

**结论**：「全页只有一个认款提交按钮」用**选择器计数**（`[data-act="pending-relate"]` === 1），不写死名字；
配套断言"左栏展开区那两个旧锚点都不存在"。变异复核：把提交按钮复制一个 ⇒ `count=2` 按预期红。

**取证**：`[data-act="pending-relate"]` 计数；变异复制提交按钮 ⇒ `count=2`。

**源**：`2026-10-25-goods-pending-merge`（2026-10-25）

---

## 21. 「款与商品」右栏减负：七条用户口径一次改完

**结论**：接同日上午的 S4/S5 收尾。用户看完成品后又给了七条口径，全部落掉：

| # | 口径 | 落法 |
|---|------|------|
| 1 | 待认 SKU 太长、操作按钮不方便 | 操作列 150→96px 右对齐；灰因「需先登记店铺/店铺未登记」→「未登记」（96px 里长词折三行），完整原因在 title |
| 2 | 「还剩 N 个没认」重复 | 状态句整个撤除——它和分段徽标、来源下拉报同一个数（一屏三处）；剩余数唯一承载回归徽标 |
| 3 | 接收端状态条太占位 | 「接收端在线 · 端口 N · … · 已采 N 个商品（已认款 N）」→「● 已采 N · 认了 N · 最近 MM-DD HH:mm」，12px 次级色；端口与操作指引进 title |
| 4 | 未登记店提示太占位 | 两块橙色告警 → 各一行 12px 轻提示，店名省略号、长解释进 title；按钮「现在登记」→「去「店名归一」」 |
| 5 | 动作条没跟随主题 | **根因**：`var(--wb-bg-panel, #fff)` —— `--wb-bg-panel` 根本不存在，深色下永远白底；`--wb-text-2` 同罪。改 `--wb-surface` / `--wb-text-muted` / `--wb-shadow` |
| 6 | 去掉简洁模式 | `simple.ts` 删除；勾选框列 / 批量条 / `PoolMetrics` 恒渲染；`gdColspan` → 常量 7；页头开关撤掉 |
| 7 | 整体不协调 | 上面六条 + 首屏决策信息收敛（右栏顶部从 ~8 行压到 4 行），队列首屏可见行数 1 → 3 |

**取证**：门禁 `vue-tsc` ✅ · `build` ✅ · `goods:ui` 三视口（1440/1200/900）**ALL PASS** ✅ ·
`vitest run` 958/958 ✅ · `verify` ✅ · `verify:docs` ✅（`simple.ts` 两处历史引用按仓库惯例
登记进 `DELIBERATELY_MISSING` 并就地标注"已撤除"）。

**源**：`2026-10-25-goods-pool-declutter`（2026-10-25）

---

## 22. `--wb-bg-panel` 是幻影变量

**结论**：变量名拼错有回落兜着，不报错、只是"永远不对"。goods 模块里同类幻影还有 `--wb-text-2`（3 处）、
`--wb-font-mono`（有等价回落，未动）。写样式时**先确认令牌存在**，别从别的页面抄名字。

**取证**：`var(--wb-bg-panel, #fff)`；`--wb-text-2` 3 处；`--wb-font-mono` 有等价回落，未动。

**源**：`2026-10-25-goods-pool-declutter`（2026-10-25）

---

## 23. 冒烟反向断言不能锚 `document.body`

**结论**：注入脚本自己住在 body 的 script 元素里，它的源码（含断言文案）全在 body 的 textContent 里 ——
body 级"不许出现 X"必被自己污染成恒红。锚到业务根元素（如 `[data-act="pane-pool"]`）。

**取证**：锚 `[data-act="pane-pool"]`。

**源**：`2026-10-25-goods-pool-declutter`（2026-10-25）

---

## 24. 主题活体哨兵 + 提示条单行守卫

**结论**（本轮新加，均变异复核过）：

- **主题活体哨兵**：临时把 `--wb-surface` 改成 `rgb(1,2,3)`，动作条底色不跟着变 = 写死了
  （变异：background 换回幻影变量 ⇒ 恒红，bg=rgb(255,255,255) 正是老病信号）。
- **提示条单行守卫**：`items-hint-shops` 高度 ≤ 34px（变异：恢复旧版式 13px/8px padding ⇒ h=40 恒红）。
  ⚠️ 第一版变异（只去掉 nowrap）守卫不变红——文本本来就单行，变异没造出真缺陷；换"恢复旧版式"才验到。
- **「还剩 / 个没认」反向守卫**：状态句不许以任何形态回到右栏。

冒烟断言随形态的换落点（守的事都没丢）：

- 全零"说人话"：状态句 → 空态标题「还没有要认的商品」。
- 登记后"提示条消失"：**只判 order 侧**（`open-registry`）——采集侧（`items-open-registry`）是
  独立名单（`unresolvedItemStores`），登记一家店清不掉它是**对的**，别把两条名单当一条。
- 接收端汇总：正文压短后端口断言落点移到 title 属性。

**取证**：`--wb-surface` → `rgb(1,2,3)`；`items-hint-shops` 高 ≤ 34px；变异恢复旧版式 ⇒ h=40。

**源**：`2026-10-25-goods-pool-declutter`（2026-10-25）

---

## 25. S4 撤展开之后，五条契约换了承载（不是作废）

**结论**：S4（行展开区整块撤掉，单击 = 选中）与 S5（统计条搬到「已认」段、待认段改一句状态句）
改的是**呈现层**，但冒烟里挂在"展开区"上的五条契约并不会自己跟着搬 —— 它们先以两种
完全不同的样子红出来：一种是 `detailCell is not defined`（脚本比页面旧），另一种是
`Cannot read properties of null (reading 'click')`（盲点一个已经不存在的锚点）。
**契约一条都没作废**，只是换了承载；本轮同时挖出一个真回归（加「操作」列把款名挤到第三行）。

| 原判据（挂在展开区上） | 新落点 |
| ---- | ---- |
| 「展开另一个款 → 展开区跟着换」（`p-supplier` / `detail-links`） | ① 选中态落在刚点的那一行；② 右栏「已认」段的「只看当前款」**按钮文案跟着换款号**（跨栏只有一个落点，两处读数不一致就是"认错对象"，且不报错） |
| 「未关联供应商显示 `(未关联)`」 | 抽屉里供应商下拉停在「未关联」（`profile-in-drawer` 步，判 `value === '0'`） |
| 「失效映射不混进已关联 + 失效单列说明」 | 右栏「已认」段的状态标 + 「有 N 条已失效 → 只看它们」入口（`detail-links` / `mapped-invalid-entry` 两步） |
| 「认款后左栏已关联商品是\*\*新值\*\*」（缓存不刷新） | 右栏「已认」段按款反查：**请求带 `productId`** 且**行数是新值**（S2 认款后 2 → 4 条，含刚认下的 `B0XYZ1234`，且不含 S1 的 `SKU-OLD*`） |
| 「收起展开行 → 按钮改口『先选一个款』」 | 「当前款被**筛出列表** → 落点撤回」（见下） |

第五条的触发方式必须换：S4 之后单击不再取消选中（再点同一行**不取消**是有意的 ——
落点是右栏认款的目标，手滑一下不该把整批勾选作废），所以"收起"这个动作本身没有了。
换成**筛选把当前款筛出列表**，它比"收起"更硬：同时覆盖筛选 / 翻页 / 删除这几种
"款已经不在屏幕上"的真实来源，而"照着一个看不见的款点下去"正是写错款的来源。

**取证**：`npx vue-tsc --noEmit` 通过 · `npm run build` 通过 · `npm run goods:ui`
三视口（1440 / 1200 / 900）**ALL PASS** · `npx vitest run` **958 / 958 全绿**。

变异复核（2 组，各只红目标断言）：

| 变异 | 红掉的断言 |
| ---- | ---- |
| `useSkuPool.loadMapped` 的 `productId` 写死 0 | 7 条：`反查请求真的带上了 productId` / `只看当前款 S2 → 只剩它自己那 2 条` / `按钮自己改口报已筛 + 条数` / `按款反查不串款` / `失效的映射不混进已关联` / `认款后按款反查是新值` / `反查不串款` |
| `ProductPane` 的 `watch(rows)` 不再撤回落点（改成 `if (false && …)`） | 1 条：`当前款被筛出列表 → 按钮改口「先选一个款」`（`rows=1 codes=S1 btn=认到 S2`） |

⚠️ 第一次全量跑曾红 1 条：`tests/uxEntryNames.spec.ts`（悬空入口名守卫）报
`src/modules/ledger/EntryEditor.vue: 「基础数据 › 店铺」` 对不上真实入口。
**单跑该 spec 绿、复跑全量也绿** ⇒ 判为与并行/顺序相关的偶发（该 spec 扫全仓文案，
另有一批 spec 在改共享状态），不是本轮改动引入（本轮没碰账本模块，也没改任何入口文案）。
记账模块是未跟踪的并行工作，那条文案本身值得他们自己确认一次。

**源**：`2026-10-25-goods-row-select-and-status-line`（2026-10-25）

---

## 26. 唯一的产品侧真错：新加的「操作」列把款名挤出两行

**结论**：

| 现象 | 实测 | 根因 | 改法 |
| ---- | ---- | ---- | ---- |
| 22 字的长款名只显示两行、第三行没了（`scrollHeight 53 / clientHeight 35`） | 列宽：`name 163`、`ops 56`（旧 ▸ 列只有 30） | S4 用「操作」列（文字链「编辑」）取代行首 ▸ 小三角。文字链比小三角宽，且自带右内边距 ⇒ **净宽 +26px**，全部从款名那列扣 —— 而款名是这一栏**唯一吃剩余宽度**的弹性列（2026-10-10 撤三列就是为了它）。原注释写"撤一列加一列、宽度不变"是**想当然**，实测不成立 | `.gd-c-ops` 右内边距 12 → 4px、`.gd-pane__name` 右内边距 12 → 8px ⇒ `name 163 → 171`、`ops 56 → 48`，两行放得下 |

⚠️ 这条能被抓到，靠的是夹具里那个**故意很长的款名**（`LONG_STYLE_NAME`，22 字）：
短名在两行内怎么排都放得下 ⇒ 换个短名这条守卫就恒绿（同一条纪律在
`2026-10-25-sku-codes-occlusion.md` 里也记过：判"被遮挡"不能只判矩形不相交）。

**取证**：`scrollHeight 53 / clientHeight 35`；`name 163` / `ops 56`；改后 `name 163 → 171`、`ops 56 → 48`。

**源**：`2026-10-25-goods-row-select-and-status-line`（2026-10-25）

---

## 27. `settle` 条件被"筛选前"的状态提前满足

**结论**：`links-fresh` 一开始写的是"等到表里出现 `B0XYZ1234`" ⇒ 未过滤的那份（6 条，本来就含它）立刻满足条件，
读到的是**筛选前**的旧表（实测 `rows=6`）。改成同时等
「最后一次 `productSkuList` 的 `productId === 2`」**且**「行数 === 4」。

**取证**：实测 `rows=6`。

**源**：`2026-10-25-goods-row-select-and-status-line`（2026-10-25）

---

## 28. 变异会把虚拟时间预算打满

**结论**：`full` 那遍是 `--virtual-time-budget=60000`，新加的几个
`settle` 在**超时**时各等满 3–8s ⇒ 变异跑里根本抓不到 `#smoke-result`
（报的是"页面可能没挂载"，看着像崩了，其实是被截断）。要拿到可读的 FAIL 行，
临时把预算调到 200000 再跑；**跑完必须还原**（预算是常量，不在产品代码里）。

**取证**：`--virtual-time-budget=60000` → 临时 200000。

**源**：`2026-10-25-goods-row-select-and-status-line`（2026-10-25）

---

## 29. BSD `grep` 不支持 `a\|b`

**结论**：复踩一次的老坑：`grep -n "padding-right: 4px\|8px"` 静默无命中
⇒ 连锁命令直接判失败。一律 `grep -E` 或用检索工具。

**取证**：`grep -n "padding-right: 4px\|8px"` 静默无命中。

**源**：`2026-10-25-goods-row-select-and-status-line`（2026-10-25）

---

## 30. 夹具的边界：先确认桩实现了什么

**结论**：本冒烟的 `productList` 桩**只认 `supplierId` / `withoutSupplier` / `onlyMissingWeight`，
没有实现 `search` 过滤**。最早想用"搜索 `S1`"造出"当前款不在列表里"，结果筛不动 ——
失败的样子是"按钮没反应"，看着像产品坏了，实际是夹具没喂数据。改用
**「问题件 › 缺克重」**（`onlyMissingWeight` ⇒ 只剩 S1）后才真的把 S2 筛出列表。
⭐ 通则：用"筛选"造前置状态时，先确认那个筛选在桩里**真的会过滤**。

**取证**：`productList` 桩只认 `supplierId` / `withoutSupplier` / `onlyMissingWeight`。

**源**：`2026-10-25-goods-row-select-and-status-line`（2026-10-25）

---

## 31. 旧页签名的问题是语法形态，不是"不好听"

**结论**：侧栏读作「产品管理 › 建档与关联」—— 组名是名词，
项名却是**两个动词并列**（建档 + 关联），读起来像一条待办而不是"这一类资料叫什么"；
同组的「供应商」是名词，两者不对称。它也没覆盖这一屏真正的内容：左边是款档案，
右边是**店铺商品** —— 名字里只有动作，用户看到的是两个对象。
新名与两栏一一对应：`款与商品`（左 = 款，右 = 商品），"建档 / 认款"两个动作都被它覆盖。
不选「认款台」（与「发货台」同构、动线清楚，但弱化了左栏的档案维护）；
不选「产品库」（与组名「产品管理」重复"产品"，读作「产品管理 › 产品库」）。

**取证**：唯一来源 `src/modules/goods/tabs.ts` 的 `GOODS_TAB_LABEL.workbench`；
本文件顶部注释记了完整判据（含不选另两个候选的理由）。

**源**：`2026-10-25-goods-tab-rename`（2026-10-25）

---

## 32. 改名只动呈现层

**结论**：`store.mainTab` 的值仍是 `'goods'`（持久化偏好 + 跨模块 action 的字符串协议），
所以用户本地偏好、「待补清单 / 归类核对」里的跳转全部照旧可用。
改名波及 **14 个文件 41 处**：`src/lib/dataHealth.ts`（3 条"去哪儿补"的文案）·
`src/modules/today/tabs/ClassifyPanel.vue`（归类面板的指路）·
`src/modules/shop-accounts/components/ShipRateProductsTab.vue`（运费页的指路）·
`scripts/goods-ui-smoke.mjs`（13 处 `clickText` / 断言）· `tests/uxEntryNames.spec.ts`（豁免表 key）·
`tests/shopAccountsIntake.spec.ts`（4 处）· 其余为注释与文档。
历史记录（`CHANGELOG.md`、`docs/notes/` 旧条目、`docs/plans/` 旧方案）**刻意不改** —— 那是当时的名字。

**取证**：`vue-tsc --noEmit` ✅ · `npm run verify` ✅ ·
`vitest run tests/uxEntryNames.spec.ts tests/shopAccountsIntake.spec.ts` ✅（18 tests）。
`goods:ui` 本轮未跑（需 `npm run build` + Electron），P2 开工前必须先跑一遍拿基线。

**源**：`2026-10-25-goods-tab-rename`（2026-10-25）

---

## 33. 这个页面的 UI 契约被冒烟钉死，减法不能只改界面

**结论**：`scripts/goods-ui-smoke.mjs` 直接
`setVal` / `click` 工具栏控件（`:1545` 用它切筛选、`:1601` 断言它在 `.gd-toolbar` 里、
`:3990` `:4030` 点导入导出）。把控件收进折叠面板能让断言"技术上仍绿"（`display:none` 仍可
`click()`），但那等于**断言在操作一个用户看不见的控件** —— 比杂乱更糟。
所以 2026-10-25 这轮只做**层级与文案**（按钮降 ghost / 主操作只留一个），
真正的收敛（右栏三段合并、认款单动线）留在
[GOODS_TAB_REDESIGN_2026-10-25](../plans/GOODS_TAB_REDESIGN_2026-10-25.md)，必须连断言一起改。

**取证**：`scripts/goods-ui-smoke.mjs` `:1545` / `:1601` / `:3990` / `:4030`。

**源**：`2026-10-25-goods-tab-rename`（2026-10-25）

---

## 34. 认款 4 个近义入口才是"操作不方便"的主因

**结论**：认款入口数：`ProductPane.vue` `data-act="relate-from-expanded"` · `PoolPane.vue`
`data-act="relate-to-selected"` / `queue-batch` / `items-batch` / `items-new-product` = **4 个近义入口**，
这是"操作不方便"的主因，不是排版问题。

**取证**：`ProductPane.vue` / `PoolPane.vue` 的上述 `data-act`。

**源**：`2026-10-25-goods-tab-rename`（2026-10-25）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-08-goods-page-entry-guide.md` | 2026-10-08 | §1 / §2 / §3 / §4 / §5 / §6 / §7 / §8 |
| `2026-10-10-goods-list-slimming.md` | 2026-10-10 | §9 / §10 / §11 / §12 / §13 |
| `2026-10-25-goods-pending-merge.md` | 2026-10-25 | §14 / §15 / §16 / §17 / §18 / §19 / §20 |
| `2026-10-25-goods-pool-declutter.md` | 2026-10-25 | §21 / §22 / §23 / §24 |
| `2026-10-25-goods-row-select-and-status-line.md` | 2026-10-25 | §25 / §26 / §27 / §28 / §29 / §30 |
| `2026-10-25-goods-tab-rename.md` | 2026-10-25 | §31 / §32 / §33 / §34 |
