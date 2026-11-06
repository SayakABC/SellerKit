# 成本维护与进价页退役：38 条结论（蒸馏自 5 篇，2026-10-09 ~ 2026-10-23；§38 为 2026-11-06 续）

> **蒸馏笔记**：由 5 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/<原文件名>`

## 1. 【历史记录】新增「进价」页签：只做**单款**维护，写入与导入共用同一份口径

**结论**：【历史记录】新页签「**进价**」（「货与成本」，两形态都加）。只做**单款**维护（批量已在导入模板里），写入与导入**共用同一份口径**，删除**只删 `manual`**。（该页后于 2026-10-23 整页退役，见 §29。）

界面放哪：`ae_cost_map` 的**只读**成本表早就活在算钱页（`CostRatesSection.vue`），所以"就地改成可编辑"是最短的路。**没有走那条**，判据三条：
1. **P4 的原始定位在产品库**（现「货与成本」），成本是主数据，这一页是主数据的家。
2. **同页动线**：上一轮刚在产品列表加了「进价」列（缺价的款显示「—」）—— 切个页签就能补；而算钱页看到"缺成本"之后要去哪补，原来在界面上没有任何答案。
3. **算钱页的定位是"看利润"**。把录入塞进去会让那页同时承担两个视角（诊断 + 维护）。

算钱页的成本表**保留只读**，加一句路标。⚠️ 顺带改正了那里一条**站不住的理由**：

> 旧注释：「成本表只读 —— 手点会让用户在两个地方看到两份成本」。
> 事实：`ae_cost_map` 就**一张表**，不存在"两份"。真正的约束是**入口唯一**（让用户猜哪个入口才是"真的"）。

**取证**：`CostRatesSection.vue`（算钱页的只读成本表）；旧注释原文「成本表只读 —— 手点会让用户在两个地方看到两份成本」。

**源**：`2026-10-09-cost-maintenance-pane`（2026-10-09）

---

## 2. 【历史记录】删除：只删 `manual`（`purchase` 行不渲染删除按钮）

**结论**：【历史记录】`purchase` 行是拿货对账**自动同步**的产物（`purchase-cost-sync.ts` 每次落账全量替换那一批）。允许删它的后果是：用户删掉 → 下次落账原样写回来 → **用户以为"删不掉"，反复试**。所以 `costMapDeleteManual` 的 SQL 带 `AND source = 'manual'`，界面上 `purchase` 行**不渲染删除按钮**（渲染一个点了没用的按钮比不渲染更糟）。

**删掉之后会发生什么必须在界面上说出来**：该区间不再生效，读取侧回落到**更早的区间**（没有更早的就回落到最早那条）。确认框里写了这句话，并且有一条冒烟断言钉住"**回落真的成立**"。不写这句话的话，用户看到的是"价悄悄变了"。

**取证**：冒烟两头都钉：删除路径带 `source` 过滤 + 拿货行那条**没有**删除按钮；回落断言用「删掉 S1 的手工 12.34 → 当前价变成更早的拿货价 9.99」验证。

**源**：`2026-10-09-cost-maintenance-pane`（2026-10-09）

---

## 3. 【历史记录】口径：`pickUnitCost` → 拆出 `pickCostInterval`

**结论**：【历史记录】界面要显示"**当前生效的是哪条**、来源是手工还是拿货"。这个"挑哪条"的逻辑原先只存在于 `pickUnitCost` 内部（只返回价格），界面若自己按日期再挑一遍，就会漂。所以把挑法提成 `pickCostInterval(costs, styleCode, bizDate): CostInterval | null`，`pickUnitCost` 改成 `pickCostInterval(...)?.unitPrice ?? null`。**排序 + 回落两条规则只有一份**。

**取证**：漂移的后果原文：「成本页写着「当前价 12.34（手工）」，而算钱 / 拣货算的是 10.00（拿货对账）—— 不报错、不抛异常，只是两个数字对不上，而且没人知道哪个是对的。」（C2 后该挑法成为"旧"，见 §21。）

**源**：`2026-10-09-cost-maintenance-pane`（2026-10-09）

---

## 4. 【历史记录】写入口径：从 `product-cost-sync.ts` 提到 `manual-costs.ts`

**结论**：【历史记录】上一轮（续十六）把导入口径写在 `product-cost-sync.ts`。本轮界面也要写同一批 `manual` 行，两个调用方各自实现"值相同就不写"必然漂开，于是把函数提到 `electron/manual-costs.ts`（文件头写明两个调用方），**`product-cost-sync.ts` 删除** —— 它移走核心逻辑后只剩一层转调，那是没有实质的薄壳（本仓明确不留）。（`electron/manual-costs.ts` 后在 C2 删表时一并删除，见 §26。）

**取证**：`electron/manual-costs.ts` 文件头写明两个调用方；`product-cost-sync.ts` 删除。

**源**：`2026-10-09-cost-maintenance-pane`（2026-10-09）

---

## 5. 两个坑：注入脚本注释里的反引号 · toggle 型展开被点了两次

**结论**：
1. **注入脚本的注释里不能有反引号**。`goods-ui-smoke.mjs` 的断言脚本是一个模板字面量，注释里写了 `` `__smokeEmptyProducts` `` ⇒ 模板串被**提前终止** ⇒ `node --check` 直接报 `Unexpected identifier`（而这个脚本的 npm script 恰好带 `node --check`，所以是"跑之前就红"）。本仓笔记里已记过 5 次，这次是第 6 次。
2. **toggle 型展开被点了两次 → 收起**。删除前的步骤又点了一次行首的展开箭头，而那一行**从上面起就是展开状态** ⇒ 第二次点击把它收起来 ⇒ 下一步 `document.querySelector('[data-cost-detail="S1"]')` 返回 `null` ⇒ 报错信息只有 `Cannot read properties of null (reading 'click')`，指向的是**下一步**，与真因（上面那次多余点击）隔了一步。修法：删掉那次点击，并在注释里写明"不要再点"。

**取证**：`node --check` 报 `Unexpected identifier`；`document.querySelector('[data-cost-detail="S1"]')` 返回 `null`，报错 `Cannot read properties of null (reading 'click')`。

**源**：`2026-10-09-cost-maintenance-pane`（2026-10-09）

---

## 6. 假绿：`goods:ui` 只失败第一遍 —— "等信号"不如让渲染本身代表两件事都完成

**结论**：**假绿**的当次经历：`goods:ui` 只失败了**第一遍**（宽视口），后两遍 ALL PASS —— 根因是 `load()` 里 `loadCosts` 与 `loadProducts` 分开 await：成本表先渲染出来、缺价清单的数据还在路上，而冒烟的 settle 等的是成本表。修法不是"等信号"，而是让**成本表渲染出来本身就意味着两件事都完成**（`Promise.all` + 表 `v-if="!loading"`）。这与 2026-10-08 那条"等信号 ≠ 判信号"是同一类。

**取证**：`goods:ui` 三遍中仅第一遍（宽视口）红；修法为 `Promise.all` + 表 `v-if="!loading"`。

**源**：`2026-10-09-cost-maintenance-pane`（2026-10-09）

---

## 7. 门禁（2026-10-09）

**结论**：全部门禁 0 error / 通过。

**取证**：`vue-tsc` 0 · `tsc -p tsconfig.electron.json` 0 · `verify` **190/186**（+2 通道，`ae-handlers` 12→14）· `verify:docs` 0 · `lint` 0 error · `build` 0 · `vitest` 36 文件 / 644 用例 · `ae:smoke` **31**（+3：删除路径）· `goods:ui` 三遍 ALL PASS（+10 条）· `product:smoke` ✅ · `product:xlsx:smoke` ✅

**源**：`2026-10-09-cost-maintenance-pane`（2026-10-09）

---

## 8. 「今天 › 算钱」只留有用的信息：三类东西被删掉，判据各不相同

**结论**：用户要求"重新优化设计今天--算钱页面，只展示有用的信息，要简洁，不要过度设计，减少提示文字，要从交互让用户真正会用"。这一次动的是**信息架构**：

| 删掉的 | 类型 | 判据 |
| --- | --- | --- |
| 指标条里的「各环齐全 N」 | **重复** | 与下一行的缺口说的是同一件事（齐不齐），而缺口的说法具体得多（缺哪一环、几行）⇒ 同一件事在页面上**只说一处** |
| 「缺哪一环：」「经营状态（利润合计只含非关闭单）：」 | **标签** | 两边的 chip 自己就说清了是什么；标签只是在替读者念一遍 |
| 「在途单结算前平台不给费用，只能估」 | **解释** | 它解释的那个动作（"去配费率"）就在旁边，而且**用户什么都不用知道也能点** |
| 「只作用于订单自己没写税的行」「多件…（多件合并计费尚未支持）」 | **长尾** | 进 `title`。屏幕上只留"是什么"，"为什么"悬停再看 |
| 统计面板头的「只含非关闭单」 | **第二遍** | 同一句口径在页面上说一次就够 —— 那一次放指标条（`不含已关闭 N 行`），**且只在真有已关闭单时出现** |
| 空态里的「点『导入 Excel』…」 | **指向不存在的按钮** | 这一页没有这个按钮（按钮写的是「去『导入订单』」）⇒ 说明只讲"能得到什么"，"点哪里"交给按钮 |

⭐ **主力判据：一句话值不值得留，看它有没有"对应的界面事实"。**
- 有事实兜底（chip 本身就是"缺什么"）⇒ 标签可以撤；
- 没有兜底、但**动作就在旁边**（"平台费未扣"）⇒ 解释可以撤：用户不需要懂在途单结算规则，只需要点那颗按钮；
- 只在**特定条件下才成立**的事实（有已关闭单才有"不含已关闭"这回事）⇒ 改成**条件渲染**，条件不成立时**一个字都不出现** —— "零的正确表达是不出现"，不是"不含已关闭 0 行"。

**取证**：落在 `src/modules/order-cost/OrderCostView.vue`（「今天 › 算钱」就是它的内嵌形态）；撤掉 `metric-complete`，保留指标条的 `不含已关闭 N 行`。

**源**：`2026-10-11-cost-page-slimming`（2026-10-11）

---

## 9. ⭐ 本轮真正的交互改动：**缺口从"提示"变成"筛子"**

**结论**：原先「缺克重 1」是一颗点不动的 chip：它告诉用户"有 1 行缺克重"，却**没有任何办法知道是哪一行** —— 500 行的明细表里只能逐格去找。这是本仓「提示不是入口」那条规矩的又一例，和页头那颗「未归属 2 单 · 去归属」是同一个道理。现在：点它 ⇒ 明细表**只留带这个缺口的行**；面板头出现「只看 缺成本 ×」，再点一下 chip 或点 × 撤掉。

**取证**：`data-act="gap-filter"` / `clear-filter`；点下去行数从 2 变 1 且留下的正是那行。

**源**：`2026-10-11-cost-page-slimming`（2026-10-11）

---

## 10. 缺口筛选的三条实现纪律

**结论**：
1. **形状必须区分开**：只读标签是**实心药丸**，可点的缺口是**描边按钮**（悬停填底、激活变实心）。交互藏在看不出来的地方等于没做 —— 光加 `cursor: pointer` 是不够的，用户不会去悬停每一颗 chip。于是体检行天然分成两半：**左边"要做的事"（可点）、右边"现状"（只读）**，中间一条竖线分开，连"缺什么 / 现状如何"这两个标签都省掉了。
2. ⚠️ **重算时必须清空筛选**：缺口筛选是跟着"这一批数据"的。换来源 / 改税口径之后，原来那个缺口可能已经不存在了，留着筛选会变成"表格空着、头上还写着只看缺X" —— **静默失效**。所以 `recompute()` 里一律 `gapFilter = null`，让用户重新点。
3. ⚠️ **筛选态必须看得见、也必须撤得掉**：表格忽然只剩一行而不说明原因，用户会以为"数据没了"。面板头的「只看 X ×」既是说明也是那个开关。

**取证**：`recompute()` 里一律 `gapFilter = null`；筛选态锚点 `data-act="gap-filter"` / `clear-filter`。

**源**：`2026-10-11-cost-page-slimming`（2026-10-11）

---

## 11. 计数与门禁（2026-10-11）

**结论**：`order-profit:ui` **82 → 86**：
- −1 / +2：原「指标条：订单行 1 / **各环齐全 1** / …」拆成两条，其中一条**反向钉住那格不再回来**（`metric-complete` 存在 = 同一件事又说了一遍）；
- +3：缺口筛选（**是可点按钮** / 点下去行数真的从 2 变 1 且留下的正是那行 / 筛选态可见可撤）。⚠️ 这三条**缺一不可**：只断言"点下去有点反应"是空转 —— 弹个 toast 也能绿。

⚠️ 计数口径：上一轮索引里记的 81 与本轮开工时的 82 差 1（该轮另有未记账的变更）—— **以跑出来的为准**（文件里 86 条 `report(...)` 调用 = 86 条断言，全部执行且全绿）。`.vue` 未动任何既有 `data-act` 名（只**删**了 `metric-complete`、**新增** `gap-filter` / `clear-filter`）。

**取证**：`today:ui` **199**（本页内嵌其中，只验挂载，不受影响）；`vue-tsc` · `tsc -p tsconfig.electron.json` · `verify` · `verify:docs` · `lint` 0 error · `vitest` · `build` 全绿。

**源**：`2026-10-11-cost-page-slimming`（2026-10-11）

---

## 12. 踩点：反引号第三次 · 取证脚本复用冒烟的假桥

**结论**：⚠️ **反引号第三次踩，这次踩在 `order-profit-ui-smoke.mjs` 里** —— 而那个文件的头注释第 21 行就写着"注入脚本里的注释不能含反引号"。一次 `node --check` 就现形。**改这两个 `*-ui-smoke.mjs` 之后，第一件事永远是 `node --check`。**

**取证**：取证方式沿用 `purchase-shot.mjs` 那套：`/tmp/cost-shot.mjs`（不进仓库）= 复用 `order-profit-ui-smoke.mjs` 的假桥（它有可验算的真实样本：S1 / 275g / 成本 10 / 收入 165.18）+ 把开机模块改成 `today` + 点 `[data-act="tab-cost"]` + CDP 截图。空态 / 筛选态 / 深色三张 ⇒ `.cache/cost-shot/`（已 gitignore）。

**源**：`2026-10-11-cost-page-slimming`（2026-10-11）

---

## 13. 明确**没做**的事（留作下一轮选项）

**结论**：
- **统计表行点进去筛明细**（"按款 S1" 那行 → 只留 S1 的订单行）。价值高（两张表目前只能靠肉眼对款编码），但要给 `lib/orderCost` 补一个 `costGroupKey(row, dim)` 导出并把 `summarizeOrderCosts` 里的 `keyOf` 提出来，这一轮按"不要过度设计"先不动。
- 明细表的 14 列**没减**：它们都是算钱算式里的项（运费/产品成本/税/平台费/收入/毛利）或它们的输入（国家→运费、克重→运费、件数→拣货口径），撤掉会让数字变得不可核对。

**取证**：需补 `costGroupKey(row, dim)` 导出并把 `summarizeOrderCosts` 里的 `keyOf` 提出来；明细表 14 列未减。

**源**：`2026-10-11-cost-page-slimming`（2026-10-11）

---

## 14. 【历史记录】页签名「成本与费率」→「成本」：只动呈现层

**结论**：【历史记录】页签名「成本与费率」→「成本」。用户口径：「成本与费率修改为成本，其中款级进价列表增加图片，去除生效日、来源展示，要注意样式」。范围 = `MasterDataView` 的 `KINDS` + 全部用户可见引用。

`KINDS` 里 `cost` 的 `name` 改「成本」。**`store.mainTab` 的七个值与跨模块 action 的字符串协议一个没改** ⇒ 老用户本地偏好、算钱页「去维护」的 `action=cost` 全部照旧。用户可见引用同步：`order-cost` 数据基础区的三处提示文案（"手工录在「基础数据」的「成本」里"…）。`tests/uxEntryNames.spec.ts` 的豁免键 `成本与费率` → `成本`。旧名是**悬空入口名**：豁免表里没有它，文案里再出现就直接红（这正是该守卫的用途）。

**取证**：`MasterDataView` 的 `KINDS`；`store.mainTab` 七个值未改；`action=cost` 未改；豁免键 `成本与费率` → `成本`。

**源**：`2026-10-17-cost-tab-and-thumbs`（2026-10-17）

---

## 15. 【历史记录】款级进价**主表**：加图片列、去「来源」「生效日」（8 列 → 7 列）；明细表两列都保留

**结论**：【历史记录】两件事，都只动**呈现层**：①页签名改名（见 §14）；②款级进价**主表**：加图片列；去「来源」「生效日」两列（8 列 → 7 列）。

**区间明细表（展开区）两列都保留**：那边生效日是行的主键、来源决定它能不能删（拿货对账的行不给删），去了这两列，"哪条在生效 / 哪条能删"就读不出来。用户说的"列表"指主表（面板标题就叫「款级进价」），明细表是它的展开细节。

**加图片**：认款靠肉眼比图 —— 款编码是内部码、款名常常重名或空缺，而队列 / 选款弹层本来就有图，只有这张表没有。数据链路：`productList` 行上现成的 `imagePath` → `ipc.orderImageThumbBatch`（**core 里那个带拆批的包装**，不是裸 `ipc`）→ `Map<款编码, dataUrl>`。
**去两列**：来源与生效日回答"这条价怎么来的、从哪天起的"，是**历史细节**；主表要回答的是"这款现在多少钱、有几段价"。细节不放逐条摊开 —— 展开区里有全的。附带好处：让出表宽给图列。

**取证**：`CostPane.vue`；主表 8 列 → 7 列；数据链路 `productList` 行的 `imagePath` → `ipc.orderImageThumbBatch` → `Map<款编码, dataUrl>`。

**源**：`2026-10-17-cost-tab-and-thumbs`（2026-10-17）

---

## 16. 取图三条实现约束：只问表里有的款 · 必须走拆批包装 · 图列必须定宽

**结论**：
1. **取图只问表里有的款**。产品库翻页拉全量（上限 2 万款），而表通常只有几十行 —— 遍历产品库取图是白取上万张。`loadThumbs()` 先用 `costRows` 的款编码做集合，再过 `products`。
2. **必须走 core 的拆批包装**（`ipc.orderImageThumbBatch`，`src/core/services/ipc.ts`）：主进程 `THUMB_BATCH_MAX = 40` 是**硬截断**（`payload.items.slice(0, 40)`），自己按原长度取值会让第 41 张起的图**静默变空占位**（不报错、只是没图）。
3. **图列必须给定宽**（62px = 40 图 + 2×10 padding + 边）：`table-layout:auto` 下不给宽度的列会被内容（宽图）撑着走，款名那条弹性列就得让位 —— 而列宽选择器都写在 td/th 上，**撑开是静默的**（几何取证才看得出来）。图与空占位的居中也要两条路都给：`img` 是 `display:block`（吃 `margin:auto`），占位 `span` 是 `inline-block`（只认 `text-align`）。

**取证**：`THUMB_BATCH_MAX = 40`（`payload.items.slice(0, 40)`）；图列 62px = 40 图 + 2×10 padding + 边。

**源**：`2026-10-17-cost-tab-and-thumbs`（2026-10-17）

---

## 17. 守卫怎么翻面：锚点随列走 · 夹具要有区分度 · 明细表只取各自的 `<thead>`

**结论**：
- **锚点随列走**：`cost-source` 撤掉（锚点是给列用的，列没了锚点也没了）。只删列不删断言的话，按旧名定位的东西**静默点空** —— 点了没反应，最难查。
- **`master-data:ui` 新增五条**：主表无来源/生效日列（表头 + 锚点双查）、主表七列、S1 渲染出 data: 缩略图、取图只问表里有的款、空态行 colspan 与列数一致。
- **夹具加 S3**（有图、**无成本**）：它是"取图范围"这条判据的**区分度来源** —— 没有它，"遍历整个产品库取图"与"只取表里有的款"产出同一批调用，断言恒绿。反例就在首跑里：最初还要求"没有任何调用含 S3"，但货品档案工作台列的是**全部款**，它取 `[S1,S3]` 是正该发生的 ⇒ 判据改成"存在一次只含 `[S1]` 的调用"。
- **`shopAccountsIntake` 新增结构回归例**：主表 thead 有图列 / 无两列、明细表两列都保留、colspan 与列数一致、缩略图走拆批包装。⚠️ 明细表**嵌在主表 tbody 里**（展开行内），按整表切分会把明细的 `<th>` 算进主表 ⇒ 两边都只取各自的 `<thead>`。
- **变异验证**（各 88 PASS / 1 FAIL，其余不受）：取图改遍历全库 ⇒ 正好「取图只问表里有的款」红；`v-if` 改恒假 ⇒ 正好「S1 渲染出主图缩略图」红。

**取证**：变异结果 88 PASS / 1 FAIL；判据为"存在一次只含 `[S1]` 的调用"。

**源**：`2026-10-17-cost-tab-and-thumbs`（2026-10-17）

---

## 18. ⭐⭐ 踩坑：模板串里的转义会被求值（`node --check` 查不出来）

**结论**：首跑 `master-data:ui` 直接"没抓到 #smoke-result"。排查链路：注入脚本单独抽出来 `node --check` **通过**、页面 0 字节。真正原因：断言里用正则 `/^data:image\//` 判前缀，写在模板串（`` ` ``）里 `\/` 被求值成 `/`，浏览器拿到 `/^data:image//` —— **语法错，整段断言脚本都不跑**。而 `node --check` 查的是外层 .mjs 文件，模板串在它眼里只是个字符串。

这与已知的"注释里不能有反引号"同族：**模板串不是原文传递，转义与插值都会发生**。判据只能实跑；要写正则就绕开需要转义的字符（本例改用 `indexOf(...) === 0`）。自检方法：把模板串按 `\\ → \` 求值后再 `node --check` 一遍。

**取证**：`/^data:image\//` 在模板串里被求值成 `/^data:image//`；修法 `indexOf(...) === 0`。

**源**：`2026-10-17-cost-tab-and-thumbs`（2026-10-17）

---

## 19. C2 之后成本只有**三处**，各有唯一写者

**结论**：

| 字段 | 语义 | 唯一写者 | 时点 |
| --- | --- | --- | --- |
| `pl_products.cost_cents` | **当前进价**（供新单估算） | `product-cost-set` / 产品导入 / 编辑抽屉（都经 `upsertProduct` / `setProductCostByCode`） | 随维护更新，不回写历史 |
| `oi_order_items.cost_cents` | **进价（预估）**：确认那一刻产品当前价的拷贝 | `order-db.snapshotOrderCosts`（归类核对「确认无误」/ 全部确认） | 一次；之后产品改价不漂移 |
| `oi_order_items.actual_cost_cents` | **实际进价（拿货实付）** | `purchase-cost-sync.syncOrderRowCosts`（拿货落账后） | 只补空、按拿货日期先到先得、按款色 id + 尺码匹配 |

**取证**：写者分别为 `product-cost-set` / `product 导入` / 编辑抽屉（经 `upsertProduct` / `setProductCostByCode`）；`order-db.snapshotOrderCosts`；`purchase-cost-sync.syncOrderRowCosts`。

**源**：`2026-10-21-cost-two-fields-c2`（2026-10-21）

---

## 20. 利润取数**只有一处实现**：`actual > 0 → snapshot`，0 一律是缺失，没有 `cost_source` 列

**结论**：利润取数**只有一处实现**：`src/lib/orderCost.ts` 的 `actual > 0 → snapshot`，否则 `estimate > 0 → estimate`，否则 `none`。**0 一律是缺失**，没有 `cost_source` 列。

**取证**：`src/lib/orderCost.ts` 的 `actual > 0 → snapshot`；否则 `estimate > 0 → estimate`；否则 `none`。

**源**：`2026-10-21-cost-two-fields-c2`（2026-10-21）

---

## 21. v9 迁移为什么是**这个顺序**（六步不可换）

**结论**：`order.main` v9（`electron/order-db.ts#migrateOrderCostSplit`），顺序不可换：
1. 加 `actual_cost_cents`；
2. 存量 `cost_cents > 0` 搬进 `actual_cost_cents`（v7 起这列实际只装拿货实付）；
3. 清空 `cost_cents`（从此只放预估）；
4. 按**下单日期**从旧 `ae_cost_map` 取当时生效价回填预估（挑法与旧 `pickCostInterval` 逐字一致：≤ 下单日的最后一条，没有则最早一条；未归类行没有款级价 → 留 NULL）；
5. **从拿货单补一次实付**——不能等"下次拿货写操作"。真实库里那 1 行实付 32 的订单，下单时价目表是 28；不在这里补，它会从 32 暂时掉回 28（数字凭空变了，用户只会认为坏了）；
6. 把价目表每款**最新**价镜像进 `pl_products.cost_cents`——产品表当时全是 0，不搬 = 删表把价扔掉。

`scripts/schema-migration-smoke.cjs` 场景 [H] 钉住这六步（含"未归类留空""产品价只补空""幂等"）。

**取证**：`electron/order-db.ts#migrateOrderCostSplit`；场景 [H]；实付 32 / 价目表 28 的真实数据。

**源**：`2026-10-21-cost-two-fields-c2`（2026-10-21）

---

## 22. v9 迁移是**冻结代码**

**结论**：这段迁移是**冻结代码**：日后删掉 `ae_cost_map` 也不用改它，`tableExists` 会让第 4/6 步整体空转。

**取证**：`tableExists` 会让第 4/6 步整体空转。

**源**：`2026-10-21-cost-two-fields-c2`（2026-10-21）

---

## 23. 读侧落点

**结论**：
- 利润页：`orderShippingRows` 已带 `actualCostCents` / `costCents`（B1 后从明细表投影），引擎不再查任何价目表。
- 拣货：`picking-db` 行投影带三档（`actualCostCents` / `costCents` / `productCostCents`），优先级只在 `src/lib/picking.ts#aggregatePicking` 一处；`PickingView` 自己不取价。
- 「货品档案」列表：「进价」列读 `pl_products.cost_cents`（`useProductList.loadCosts`），不再有价目表回落。
- 「今天」缺口卡：`hasCost = 行上 actual > 0 或 estimate > 0`，再叠加 `productPricedCodes` 判断"这行还钉不钉得上"（`TodayView.vue`）。

**取证**：`src/lib/picking.ts#aggregatePicking`；`useProductList.loadCosts`；`hasCost = 行上 actual > 0 或 estimate > 0`（`TodayView.vue`）。

**源**：`2026-10-21-cost-two-fields-c2`（2026-10-21）

---

## 24. 守卫都放在哪里（都是"静默失效"型）

**结论**：
1. **零调用反向守卫（删表前）**：`today:ui` 与 `order-profit:ui` 的假桥曾保留 `aeCostMapList` 桩（回空数组 + 记调用），断言"一次都没调过"。**删表时这两个桩与断言一起删了** —— 通道已从 preload 消失，再留着桩只会把"调用了不存在的 API"伪装成成功（假桥兜底 `{success:true,data:null}`），守卫反而变成掩护。现在的守卫是类型层：`ElectronAPI` / `ipc.ts` / `host.ts` 里都没有这条能力，页面写回去 `vue-tsc` 直接红。
2. **夹具要能区分两档**：`today:ui` 的 S2 只填 `costCents=1000`（走"预估"那档，金额 10.00），S1/S3 三档全空（走"无进价"）。全填或全空都抓不到优先级接错。
3. **`product-cost-set` 的 `updated`**：同值重写返回 `updated:false`，界面说「没有改动」而不是「已保存」。`product:smoke` 两个回执都断言（只有 `found` 是抓不到"保存了但其实没写"的）。
4. **界面反向守卫**：`master-data:ui` 钉住进价页**没有**「来源 / 生效日 / 区间」列、没有 `cost-source` / `cost-row-expand` 锚点；回显里出现这些词也红（撤掉的概念不许从半路爬回来）。
5. **截图脚本的页签切换**：`goods:shot` 拍完「产品管理 › 进价」必须切回「建档与关联」并重新展开一行，否则后面两张（SKU 矩阵 / 建款向导）永远跳过——而它们只是"没打开"，看起来像夹具问题。

**取证**：S2 `costCents=1000` ⇒ 金额 10.00；S1/S3 三档全空；`updated:false` 对应界面「没有改动」。

**源**：`2026-10-21-cost-two-fields-c2`（2026-10-21）

---

## 25. 本轮改到的脚本

**结论**：
- `scripts/today-ui-smoke.mjs`：`PICK_ROWS` 改行投影三档；**删表时移除 `aeCostMapList` 桩与零调用断言**。
- `scripts/goods-ui-smoke.mjs`：删 `COSTS` 夹具与三个 `aeCostMap*` 桩；进价只由产品行承载。
- `scripts/master-data-ui-smoke.mjs`：回显断言改为「款名 + 当前价」并反向钉住旧概念。
- `scripts/product-db-smoke.cjs`：`setProductCostByCode` 断言补齐 `updated` 两种回执。
- `scripts/ae-cost-smoke.cjs`：**删表时大幅收窄** —— 移除「老库迁移 / 导入语义 / 手工成本 / 产品镜像」四组（写口与表都没了），只留快照分组 + 采集落主干两条，并加"新库不长 `ae_cost_map`"的反向守卫。
- `scripts/schema-migration-smoke.cjs`：`ORDER_MAIN_STEPS` 9 → 10；[D] 增"ae 域单独跑不删表 / order 跑完才删"；新增 [D2]（order 域先跑、价目表还是 v1 之前的形状）；[H] 自建旧表并断言 v10 删表。
- `scripts/goods-shot.mjs`：进价截图改走 `kind-tab-cost`，拍完切回 `kind-tab-goods`。

**取证**：`ORDER_MAIN_STEPS` 9 → 10；截图锚点 `kind-tab-cost` → `kind-tab-goods`。

**源**：`2026-10-21-cost-two-fields-c2`（2026-10-21）

---

## 26. 删表（`order.main` v10）：删了什么，以及**为什么挂在 order 域**

**结论**：删掉的东西：`ae_cost_map` 表（`DROP TABLE IF EXISTS`）、`ae-cost-map-import / -list / -upsert-manual / -delete-manual` 四条通道、`ae-db` 的 `costMapReplace / costMapUpsertManual / costMapDeleteManual / costMapList / upsertCostRow` 与四个成本类型、`electron/manual-costs.ts`、host 的 `ae.costMapList / ae.costMapImport` op、`src/types.ts` 的 `AeCostMapItem / AeCostMapImportItem / ManualCostItemInput`、产品导入载荷里已无消费者的 `effectiveFrom`。

**删除为什么挂在 `order.main` v10、而不是 ae 域 v4**：v9 要**先**从这张表把预估回填进订单行；两个域的 schema 各自懒初始化，谁先跑不确定。若删表在 ae 域，它可能先于 v9 执行，回填源就没了。放在同一域、紧跟 v9，顺序由版本号钉死（`ORDER_MAIN_STEPS = 10`，冒烟 [D]/[D2]/[H] 三处钉住）。

**取证**：`ORDER_MAIN_STEPS = 10`；冒烟 [D]/[D2]/[H] 三处钉住。

**源**：`2026-10-21-cost-two-fields-c2`（2026-10-21）

---

## 27. v9 的读取要容忍"表还是旧形状"

**结论**：若 order 域先跑，`ae_cost_map` 可能连 `effective_from` 都没有（ae.main 还没迁移到 v1）。`readLegacyCostIntervals` 用 `PRAGMA table_info` 判列，缺列时把生效日当 `'0000-01-01'`、排序里去掉该列 —— 否则 v9 会 `no such column` 直接炸掉整个迁移。冒烟 [D2] 的场景就是"order 先跑 + 旧形状表"。

**取证**：`PRAGMA table_info` 判列；缺列时生效日当 `'0000-01-01'`；否则 `no such column`。

**源**：`2026-10-21-cost-two-fields-c2`（2026-10-21）

---

## 28. 真实库状态（2026-10-22 实测 + 克隆验证）

**结论**：`~/Library/Application Support/seller-kit/sellerkit.db` 已是 `order.main=9`（v9 的两字段与预估回填早已落库）、`ae.main=3`、`ae_cost_map` 21 行。把它 `cp -c` 克隆到临时目录后跑一次 `ensureOrderSchema()`（**不碰运行中的真库**）：v10 删表成功，47 单 / 51 明细行数不变，实付 1 行 ¥32.00、预估 37 行合计 ¥1,116.00、产品当前价 17 款合计 ¥503.00 逐项原样，`PRAGMA foreign_key_check` 零孤儿。**真库本身要等 app 下次启动才跑 v10**——正在运行的进程按 v9 假设工作，不要中途手工删表。

**取证**：`order.main=9`、`ae.main=3`、`ae_cost_map` 21 行；克隆后跑 `ensureOrderSchema()`：47 单 / 51 明细行数不变，实付 1 行 ¥32.00、预估 37 行合计 ¥1,116.00、产品当前价 17 款合计 ¥503.00，`PRAGMA foreign_key_check` 零孤儿。

**源**：`2026-10-21-cost-two-fields-c2`（2026-10-21）

---

## 29. 【历史记录】「一页管一个字段」是负债，不是功能 ⇒ 进价页退役

**结论**：【历史记录 / 整页退役】C2 之后进价 = `pl_products.cost_cents` **一个数**，而「基础数据 › 进价」页还剩两块：一款一价的清单 + 汇率维护。用户问"进价页面还需要吗" —— 字段已经在产品行上，页面只是它的一份只读投影 ⇒ **撤页、把"待办"做成产品列表的一个筛选**。

**取证**：进价字段为 `pl_products.cost_cents` 一个数；页面剩余两块 = 一款一价的清单 + 汇率维护。

**源**：`2026-10-23-cost-page-retirement`（2026-10-23）

---

## 30. 【历史记录】汇率是死代码，但要**先证再删**；撤 UI **不删表**

**结论**：【历史记录】汇率是死代码，但要先证再删。撤 UI **不删表**：唯一读 `ae_rates` 的是老采集库的一次性迁移，删表换不来收益、只换来风险。

**取证**：**汇率为什么是死代码**（真库克隆 + 只读 SQL，不是读代码猜的）：

```bash
cp "$HOME/Library/Application Support/seller-kit/sellerkit.db" /tmp/sk-db-ro.db
sqlite3 /tmp/sk-db-ro.db "SELECT currency, rate FROM ae_rates;"        # 5 行，全是种子默认
sqlite3 /tmp/sk-db-ro.db "PRAGMA table_info(oi_orders);" | grep currency # 无输出：没有 currency 列
grep -rn "ae_rates\|aeRateList" electron/ src/                          # 只有迁移函数 + 本轮要删的 UI
```

- `ae_rates`：USD 7.2 / EUR 7.8 / GBP 9.2 / RUB 0.085 / CNY 1.0 —— 与代码里的种子常量逐字相同，说明**从建库到现在没有任何一次用户写入**。
- 金额：`oi_orders` 没有 `currency` 列，导入/采集进来的金额直接是人民币分；`orderCost.ts` 里只有"非 CNY 报价的运费直接拒算"，**没有任何汇率查询**。
- 唯一读者：`migrateLegacyCollectedOrders`（老采集库一次性迁移）。⇒ 表留、UI 撤。

**源**：`2026-10-23-cost-page-retirement`（2026-10-23）

---

## 31. "缺 X 待办"必须走**服务端**筛选，不能在前端 filter

**结论**：产品列表**分页在服务端**（`listProducts` 带 `offset/limit`），前端过滤会把"第 2 页里那些缺进价的款"藏成"没有"—— 用户以为齐了。故 `onlyMissingCost` 进 `listProducts` 的互斥优先级链（未关联厂家 > 指定厂家 > 缺克重 > 缺进价），并在 `filtered` 里参与"是否处于筛选态"。

**取证**：`useProductList.load()` 传 `offset/limit`，`rows` 只装当前页；`filtered` 只用来显示"我现在处于筛选态"的 chip，**不是**筛选本身。变异：把 `onlyMissingCost` 从 `listProducts` 的 WHERE 链里删掉 ⇒ `issue-filter-cost` 红。

**源**：`2026-10-23-cost-page-retirement`（2026-10-23）

---

## 32. 同一个字段在两个列表组件里都要有落点；加列必须同时改 `gdColspan`

**结论**：`ProductPane.vue`（基础数据内嵌形态，`goods:ui` 驱的就是它）与 `ProductListView.vue`（独立页形态）是两套模板：只改一处 ⇒ 冒烟在你没改的那处挂掉。加列同时要改 `gdColspan`（简洁 5/6 → 6/7）：空态行与展开行都跨**全表**，列数写死会各短一格，**不报错**，只是右边留白。

**取证**：`ProductPane.vue` 的 `gdColspan = computed(() => (goodsSimple ? 5 : 6))` —— 2026-10-10 撤 SKU/缺克重/进价三列时两档各 −3，本轮把进价加回来 ⇒ 两档各 +1，改回 6/7。

**源**：`2026-10-23-cost-page-retirement`（2026-10-23）

---

## 33. `vite build` 不含 `vue-tsc`

**结论**：`npm run build` = `vite build && tsc -p tsconfig.electron.json`，渲染层的 Vue/TS 类型错误它**一个都不报**。本轮 `src/modules/goods/api.ts` 的 `list()` 载荷类型漏了 `onlyMissingCost`，`build` 全绿、`vue-tsc --noEmit` 才炸。⇒ 改了渲染层的**跨层参数**，必须单独跑 `npx vue-tsc --noEmit`。

**取证**：`npm run build` = `vite build && tsc -p tsconfig.electron.json`；漏参报错落在 `useProductList.ts:137`。

**源**：`2026-10-23-cost-page-retirement`（2026-10-23）

---

## 34. 退役一个页会连带打断"跳转类"冒烟

**结论**：旧冒烟里有一段：点区头「去维护」→ 等落到 `kind-tab-cost` 高亮 → 再派 `switch-module` 切回来 → 等刷新键可用。页没了以后它表现为 `SMOKE: FAILED at [cost-rates] - timeout`（看着像页面崩了，其实是"等一个永不复现的高亮"）。整段舞蹈要**连根删**（含那句"必须等落下来再切回"的注释），只留下"等刷新键可用"。

**取证**：`SMOKE: FAILED at [cost-rates] - timeout`。

**源**：`2026-10-23-cost-page-retirement`（2026-10-23）

---

## 35. 退役这轮加了什么钉子

**结论**：

| 钉子 | 位置 | 钉住什么 |
|---|---|---|
| 下拉 → chip → 载荷 `onlyMissingCost:true` → 筛出的行 `p-cost` 全是「—」→ 点 chip 撤掉回到全部 | `goods:ui` 的 `issue-filter-cost` 步 | 缺价待办真的在产品列表里、且**服务端**参与筛选（只在前端 filter 会让载荷恒 false） |
| 「产品管理这一组是**两条**页签」 | `goods:ui` | 进价页签不许被"顺手"加回来（加回来 = 又有一个页只管一个字段） |
| 不画币种 / `rate-*` 锚点一个不剩 / `aeRateList` 与 `aeRateUpsert` 调用数都为 0 | `order-profit:ui` 的 `cost-rates` 步 | 汇率 UI 真的退干净了 —— 连"读了不用"的空转调用也钉住（那种残留最容易在下一次改造里复活成 UI） |
| 区头没有 `cr-goto`（「去维护」） | 同上 | 按钮指向的页已不存在，留着就是点一片空白 |
| 缺进价项 `target === 'goods'`，`HealthTarget` 收窄为两类 | `tests/dataHealth.spec.ts` | 健康检查的"去修"不许跳到一个不存在的页 |
| 文案里的入口名必须是**现存**入口 | `tests/uxEntryNames.spec.ts` | 我在 `CostRatesSection.vue` 写的「货品档案 › 产品管理」是**旧模块名**（2026-10-17 已并入「基础数据」），这条测试当场抓住 |

**取证**：上表逐行对应 `goods:ui` 的 `issue-filter-cost` 步 / `order-profit:ui` 的 `cost-rates` 步 / `tests/dataHealth.spec.ts` / `tests/uxEntryNames.spec.ts`。

**源**：`2026-10-23-cost-page-retirement`（2026-10-23）

---

## 36. 变异自检：列数这条**没有自动化守卫**

**结论**：把 `onlyMissingCost` 从 `listProducts` 的 WHERE 链里删掉 ⇒ `issue-filter-cost` 红；把 `gdColspan` 留着旧值 ⇒ 该步仍绿（列数只影响几何，不影响断言）—— 所以列数这条**没有自动化守卫**，只能靠"空态行视觉"和这条笔记。若以后要钉，判据应是 `colSpan === 表头 th 数`（`goods:ui` 里已有动态比法，撤/加列不需要改数字）。

**取证**：删 `onlyMissingCost` ⇒ 红；留旧 `gdColspan` ⇒ 那步仍绿。

**源**：`2026-10-23-cost-page-retirement`（2026-10-23）

---

## 37. 两处沉淀：反引号第三次 · 历史记录不要改指向

**结论**：
- **注入脚本里的注释不能带反引号**（本项目第三次踩）：`goods-ui-smoke.mjs` 与 `order-profit-ui-smoke.mjs` 的断言脚本是模板字符串，注释里写 `` `oi_orders` `` 会直接截断字符串，症状是 `SyntaxError: Unexpected identifier 'oi_orders'`（`node --check` 立刻能抓，别跳过）。
- **历史记录不要改指向**：`PRODUCT_LIBRARY.md` P4 行和 `SHOP_ACCOUNT_REDESIGN_PLAN.md` §7.1 里的 `CostPane.vue` 路径是"它当时住在哪"的记录，改成现存文件则句子不成立 ⇒ 走 `check-doc-links.mjs` 的 `DELIBERATELY_MISSING` 豁免（理由必须能回答"为什么改指就错"）。但**功能文档的"现状"部分必须改写**（P4 行已加「⛔ 2026-10-22 退役 / 现状入口」），否则读者会以为页还在。

**取证**：`SyntaxError: Unexpected identifier 'oi_orders'`；`PRODUCT_LIBRARY.md` P4 行已加「⛔ 2026-10-22 退役 / 现状入口」。

**源**：`2026-10-23-cost-page-retirement`（2026-10-23）

---

## 38. 统计页 P0：先把「这批数能不能信」做成一等公民，图表往后排

**结论**（用户三项决策：默认全部 / 趋势按下单日 / 先方案后落地）：

- **「默认全部」的实质不是加时间窗，是不许静默截断**。宿主 `shippingRows` 物理上限 2000
  （`electron/order-db.ts:4681`），把 `limit` 默认从 500 提到 2000 之后，**到上限必须显式说**
  「更早的订单可能没算进来（只少报，不多报）」；不到上限时整条提示**不渲染**（零的正确表达是不出现）。
  2000 不等于无限，提示是边界声明，不是修好了截断。
- **统计页新增区块不许出金额**。新增的 `trustSummary(rows)` 只数行数：参与合计行数、精准/预测轨行数、
  缺口行数、估算运费行数、结算覆盖率；**刻意不返回任何金额字段**，单测里还有一条结构反向守卫钉住这件事。
  金额继续全部来自既有 `OrderCostSummary` / 页面 `summary` —— `grossTotal`（预测公式，精准行也走预测）
  与 `preciseGrossProfit`（平台结算净收入）**两轨只并排、不相加**。
- **覆盖率必须文本与条宽同源**：无结算样本时是 0% 且条宽 `0%`，不许出现「写着 0% 却画满」或恒 100 的假桥。
- **缺口跳补入口唯一**：一个按钮 `switchModule('shop-accounts', 'health')` 到「基础数据 › 待补清单」，
  不在统计页复制六套跳转（六类缺口各自去哪补已经写在待补清单里）。
- **口径不靠猜**：口径行写死「全部订单 · 按下单日 · 只含非关闭单」，并带估算运费行数 / 平台费扣没扣。
  `trendOf` 本就按 `dateKey(r.orderTime)` 归档 ⇒ 用户拍板「按下单日」**不需要改算法**，只把口径写到界面上。
- 徽标状态用**边框形状**（虚线 = warn）区分，不靠颜色编码；同屏只让异常发声。

**取证**：`src/lib/orderCost.ts` 的 `TrustSummary` / `trustSummary`；`src/modules/order-cost/OrderCostView.vue`
的 `.oc-trust` 区块（`limit = ref(2000)` / `rowLimitHit` / `onLimitChange` / `goHealth`）；
`tests/trustSummary.spec.ts` 6 用例；`npm run order-profit:ui` 新增 `trust` 段 12 条断言、
全量 103 条 PASS。方案与逐条门禁见 `docs/plans/STATS_REBUILD_PLAN_2026-11-06.md` §10。

**源**：`docs/plans/STATS_REBUILD_PLAN_2026-11-06.md`（2026-11-06）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-09-cost-maintenance-pane.md` | 2026-10-09 | §1 / §2 / §3 / §4 / §5 / §6 / §7 |
| `2026-10-11-cost-page-slimming.md` | 2026-10-11 | §8 / §9 / §10 / §11 / §12 / §13 |
| `2026-10-17-cost-tab-and-thumbs.md` | 2026-10-17 | §14 / §15 / §16 / §17 / §18 |
| `2026-10-21-cost-two-fields-c2.md` | 2026-10-21 | §19 / §20 / §21 / §22 / §23 / §24 / §25 / §26 / §27 / §28 |
| `2026-10-23-cost-page-retirement.md` | 2026-10-23 | §29 / §30 / §31 / §32 / §33 / §34 / §35 / §36 / §37 |
