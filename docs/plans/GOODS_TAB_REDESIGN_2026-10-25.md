# 「款与商品」页重设计方案（P2 / P3 施工用）

> 2026-10-25。起因：用户口径「当前建档与关联页面太杂乱了，操作也不方便」「这几个字也不合适」。
> 本轮已完成 P0（改名）与 P1（层级与文案收敛）。**本文档只覆盖尚未施工的 P2 / P3**，
> 内容按代码现状写成可施工的步骤，凡未实跑的判断都标了「待验证」。

## 0. 已完成（P0 / P1，2026-10-25）

| 批次 | 改动 | 落点 |
| ---- | ---- | ---- |
| P0 | 页签改名 `建档与关联` → `款与商品` | `src/modules/goods/tabs.ts`（唯一来源）+ 13 个文件 41 处引用 + `scripts/goods-ui-smoke.mjs` 断言 |
| P0 | 判定记录（为什么不是「认款台」「产品库」） | `src/modules/goods/tabs.ts` 顶部注释 |
| P1 | 左栏「新增产品」→「新增款」；导出 / 导入降 ghost | `ProductPane.vue` 工具栏与空态 |
| P1 | 右栏采集段 7 颗同款按钮 → 2 主 + 3 ghost | `PoolPane.vue` 采集段工具栏 |
| P1 | 队列段「清空选择」降 ghost | `PoolPane.vue` 队列工具栏 |
| P1 | 页头说明改为只描述两侧各是什么；撤掉 `glossary` 的未使用导入 | `GoodsView.vue` `TAB_DESC` |

已过门禁：`vue-tsc --noEmit`、`npm run verify`、`vitest run tests/uxEntryNames.spec.ts tests/shopAccountsIntake.spec.ts`。
**`goods:ui` 冒烟未跑**（需构建 + Electron，见 §6「验收」）。

> ⚠️ P1 只动了视觉层级与文案，**没有减少任何常驻控件**。原因不是不想减，是冒烟脚本直接
> `setVal` / `click` 那些控件（`scripts/goods-ui-smoke.mjs:1545`、`:1601`、`:3990`、`:4030`），
> 把它们收进折叠面板会让断言变成"操作一个用户看不见的控件"——那比杂乱更糟。
> 真正的减法在 P2，且必须同步改断言。

## 0.1 已完成（P2 · S1–S3，2026-10-25）

| 步 | 落点 | 门禁 |
| -- | ---- | ---- |
| S1 视图模型 | `useSkuPool.ts`：`PendingRow` / `pendingRows` / `pendingOrigin` / `pendingSelectable` / `pendingWriteRows()` / `relatePending()` / `openPendingPicker()`（picker 加 `mode:'pending'`） | `vue-tsc` |
| S2 两段合并 | `PoolPane.vue`：`sub-pending` / `sub-mapped`；一张 4 列表；吸底动作条 `pending-actbar`；来源筛选 `pending-origin` | 冒烟三视口 ALL PASS |
| S3 入口收敛 | 删 `ProductPane.vue` 展开区的 `relate-from-expanded` + `relate-hint` + `relateCount` prop + `relate-request` emit；删外壳与右栏的 `relateNonce` / `selection-changed` 管道；反向守卫见 §4 | 同上 |

**实做与本文原设计的 5 处偏差**（都是实跑暴露的，按代码现实回改）：

| # | 原设计 | 实际 | 为什么 |
| - | ------ | ---- | ------ |
| 1 | 徽标沿用 `pendingRows.length` | 新增 `pendingTotal` = `queuePendingTotal + itemStats.unmapped` | `pendingRows.length` 是"加载了几行"：队列分页时少报，且停在「已认」段只刷汇总时不变 ⇒ 徽标会撒谎 |
| 2 | 行内「删除」只给可认行 | 采集行的「删除」与 `canRelate` 解耦 | 认不上的行（店铺没登记、采错了）最该清，绑上去等于让它们永远删不掉 |
| 3 | 零采集判"表不存在" | 判"接入引导在 + `tr[data-origin="scrape"]` 计数 0" | 合并后订单行还在这张表里，表恒在 |
| 4 | 广播守卫"停在别的段" | 改在「已认」段验 | 合并段就是待认段（`sub='pending'`），广播**本来就该**重拉列表；面板里"换来源筛选"只是筛选、不换段 |
| 5 | 向导无需额外处理 | `createProductFromItem` 提交后按 key 摘掉选择集 | 否则「已选 1 项」虚报（与 `relatePending` / `applyPick` 不一致） |

**验收实跑**：`vue-tsc --noEmit` 无错 · `npm run build` 通过 · `npm run goods:ui` 三遍（1440 / 1200 / 900）ALL PASS ·
`npx vitest run` 910/910 · `npm run verify` 通过。
`npm run verify:docs` **仍有 10 条悬空引用，全部来自本方案之外的在建文件**（未跟踪的
`docs/plans/LEDGER_PLAN.md` 与其在 `CHANGELOG` 里引用的记账源文件尚未创建）——
不属本轮改动，按"另立账本"处理，未在此文件里做豁免。

**变异复核（2 条，均实跑）**：① 动作条复制出第二个 `data-act="pending-relate"` ⇒ 反向守卫 `count=2` 红；
② 删掉行内来源标签 ⇒ 两条"分得清来源"断言红（`tags=["",""]`）。两组各只红目标断言，其余保持绿。


## 0.2 已完成（P2 · S4–S5，2026-10-25）

| 步 | 落点 | 门禁 |
| -- | ---- | ---- |
| S4 一行只做一件事 | `ProductPane.vue`：删展开列 / `row-expand` / `row-detail` 与反查，单击 = 选中（`@click="selectRow"`，重复点不取消）；行尾加「操作」列「编辑」；`ProductEditorDrawer.vue` 加款级删除（`ed-delete-product` + 确认）；`PoolPane.vue`「已认」段加「只看当前款」（`mProduct`，按 `productId` 反查） | `vue-tsc` + 冒烟三视口 ALL PASS |
| S5 统计条搬家 | `PoolMetrics` 移出「待认」段、只留「已认」段；「待认」段改一句状态句（`map-status-line`，`statusKnown` 用 `null ≠ 0` 区分"没拉到"与"真的是零"） | 同上 |

**实做与本文原设计的 3 处偏差（S4–S5 新增，接 §0.1 的 5 条）**：

| # | 原设计 | 实际 | 为什么 |
| - | ------ | ---- | ------ |
| 6 | 「操作」列取代 ▸ 列，宽度不变 | 实测 `ops 56` vs 旧 ▸ 列 `30` ⇒ 款名从 163 掉到 163-26，长款名被挤到第三行；压两处右内边距后 `name 171 / ops 48` | 文字链比小三角宽。**弹性列的宽度差额必须实测**，不能按"撤一列、加一列"推算 |
| 7 | 「收起展开行」仍是可达动作 | 单击不再取消 ⇒ "收起"这个动作本身没有了；落点撤回改由**筛选出当前款**触发 | 再点取消会把整批认款的落点清掉（手滑一下作废）；筛选/翻页/删除才是"款已不在屏幕上"的真实来源 |
| 8 | 抽屉底部只有「完成」 | 现在是「完成」+「删除这款」 | 款级删除从展开区搬进抽屉。契约禁的是「取消」（没有可取消的对象），删除是另一件事、有二次确认 |

**验收实跑**：`vue-tsc --noEmit` 无错 · `npm run build` 通过 · `npm run goods:ui` 三遍（1440 / 1200 / 900）ALL PASS ·
`npx vitest run` 958/958 · `npm run verify` 通过 · `npm run verify:docs` 通过（§0.1 记的那 10 条悬空引用已随账本
文件落地消失）。

**变异复核（2 条，均实跑）**：① `loadMapped` 的 `productId` 写死 0 ⇒ 7 条断言红（含「反查请求真的带上了
productId」「按款反查不串款」「认款后按款反查是新值」）；② `ProductPane` 的 `watch(rows)` 不再撤回落点 ⇒
仅「当前款被筛出列表 → 改口『先选一个款』」红（`rows=1 codes=S1 btn=认到 S2`）。两组各只红目标断言。
教训见 [`docs/notes/2026-10-25-goods-row-select-and-status-line.md`](../notes/2026-10-25-goods-row-select-and-status-line.md)。

## 1. 问题清单（带取证）

| # | 问题 | 取证 |
| - | ---- | ---- |
| 1 | **同一个"认款"动作有 4 个入口**：左栏展开区「认到本款」、右栏「关联到 <款码>」、弹层「关联到…」、采集段「新建款并关联」 | `ProductPane.vue` `data-act="relate-from-expanded"` · `PoolPane.vue` `data-act="relate-to-selected"` / `queue-batch` / `items-batch` / `items-new-product` |
| 2 | **右栏把"来源"当成了并列页签**：待关联队列（订单）/ 待关联采集商品（采集）/ 已建立映射（已认）。前两个都是待办，只因来源不同就分成两段，且两张表列数不同（4 / 6）、工具栏不同（5 / 5 颗按钮） | `useSkuPool.ts` `sub = 'queue' \| 'mapped' \| 'items'` |
| 3 | **同屏重复**：左栏展开区「已关联商品」与右栏「已建立映射」是同一份映射的两个视图 | `ProductPane.vue` `data-act="detail-links"` vs `PoolPane.vue` `data-act="mapped-table"` |
| 4 | **"款 / 产品 / 商品"三个词混用**：页签叫"款与商品"，左栏标题叫「产品」，按钮叫"新增款"，表头叫「款式名」 | `ProductPane.vue` `wb-panel__head` 文案 |
| 5 | **左栏行展开同时装四件事**：认款按钮、元信息、编辑/删除、已关联反查 | `ProductPane.vue` `data-act="row-detail"` 内三块 |
| 6 | **统计条 5 项常驻**，但决策只需要"还差多少" | `PoolMetrics.vue`（简洁模式默认隐藏，仅完整模式可见） |

## 2. 目标与判据

**一句话**：一屏两区 —— 左「款」（你有的），右「待认」（还差的）；认款只有一条路径。

| 判据 | 现状 | 目标 |
| ---- | ---- | ---- |
| 认款入口数 | 4 | **1**（勾选 + 动作条；行内只留「对比」） |
| 右栏分段数 | 3 | **2**（待认 / 已认），来源降为行内标签 + 筛选 |
| 左栏行详情承载 | 4 件事 | **0**（单击 = 选中；资料进抽屉；反查归右栏） |
| 首屏常驻按钮（右栏单段） | 5~7 | ≤ 3 |

## 3. 信息架构（P2）

```
款与商品
├─ 左：款（ProductPane）
│   ├─ 工具栏：搜索 · 筛选 · ＋新增款            （导出/导入维持 ghost）
│   ├─ 列表：图 / 款编码 / 名称 / 状态 / 编辑
│   └─ 单击行 = 选中（唯一跨栏状态 currentProduct）
└─ 右：商品（PoolPane）
    ├─ 分段：待认 (N) · 已认 (M)
    ├─ 状态句：还剩 N 个没认 · M 家店没登记 →
    ├─ 列表：☑ / 图 / 商品ID + 店铺 + 来源标签 / 对比
    └─ 动作条（吸底，跨两栏宽）：已选 N 项 · 认到：[款选择器] · 认到这 N 项
```

**来源标签的值**：`订单` / `采集` / `手贴`（手贴是采集表里的 `source` 之一，展示时归到"采集"或独立，待验证 `ShopItemRow.source` 的实际取值域）。

**合并两源的方式（不改主进程）**：在 `useSkuPool` 里新增 `pendingRows` computed，把
`queueRows`（`SkuQueueRow`）与 `itemRows`（`ShopItemRow`）映射到同一个视图模型：

| 字段 | 来自队列 | 来自采集 |
| ---- | -------- | -------- |
| key | `queueKey(r)` | `'i:' + r.id` |
| itemId | `r.itemId` | `r.itemId` |
| 图 | `queueImgs.get(r.itemKey)`（图池） | `r.imageUrl` |
| 店铺 | `r.shopName` / `r.shopRaw` | `r.shopName` / `r.storeKey` |
| 来源 | `'订单'` | `'采集'` |
| 可否认 | `r.status === 'unmapped'` | `r.shopId !== 0 && !!r.platform` |
| 阻塞原因 | 「需先登记店铺」 | 「店铺未登记」 |

⚠️ 写入路径不变：仍走 `relateToSelected` / `commitMap`（单事务 + 行级失败回传）。
**一个视图模型，两条写入口**是允许的（数据不同源），但**动作只许一个按钮**。

## 4. 认款单动线（P2 核心）

```
勾商品（可多选） → 左栏点一行款（行高亮） → 动作条「认到这 N 项」 → 写库 → 待认清单自己少掉这几行
```

- 动作条的款选择器 = 现有 `ProductPicker.vue`（已存在，`openBatchPicker` 用的就是它）。
- **没选款时**按钮文案为「先选一个款」，按下打开同一个选择器 → 选完继续同一个提交。
- 左栏展开区的「认到本款」**删除**；`data-act="relate-from-expanded"` 与 `relate-hint` 一起下线。
- 采集段「新建款并关联」保留（它是"没有款"时的出口，不是"有款时的第二个入口"）。

**反向守卫（必加）**：全页 `[data-act]` 里**只允许一个**认款提交按钮（断言用选择器计数，不写死名字）。

## 5. 左栏取消展开区（P3）

| 展开区现有能力 | 新家 |
| -------------- | ---- |
| 供应商 / 类目 / 备注 / 创建时间 | 编辑抽屉 `ProductEditorDrawer.vue`（已有全部字段） |
| 编辑 / 删除 | 行尾「编辑」+ 抽屉内删除（删除已在抽屉吗？**待验证**：若不支持，保留行尾「⋯」菜单两项） |
| 已关联商品（只读反查） | 右栏「已认」+ 按款筛选（`mapped` 段已有 `mShop` 筛选，需加 `productId` 维度，**主进程是否支持待验证**） |
| 认款按钮 | 已由动作条取代 |

⚠️ 顺序要求：**先做 P2 再做 P3**。P3 会去掉 `data-act="row-detail"` / `row-expand` / `expand-hint`，
这是冒烟里被引用最多的一组锚点之一；P2 尚未稳定时一起改，失败原因会分不清是谁引起的。

## 6. 施工步骤与验收

| 步 | 内容 | 冒烟改动 |
| -- | ---- | -------- |
| S1 | `useSkuPool` 加 `pendingRows` 视图模型（纯新增，不动旧段） | 无 |
| S2 | `PoolPane` 三段 → 两段；`sub-items` / `sub-queue` 合并为 `sub-pending` | 改 `sub-items` / `sub-queue` 的 `click` 与 `aria-selected` 断言 |
| S3 | 动作条落地；删 `relate-from-expanded` | 删「R2 左栏认到本款」那组（4 条），新增"只允许一个提交按钮"反向守卫 |
| S4 | 左栏单击选中（`data-act="p-select"`），去掉展开 | 改 `row-expand` / `row-detail` 相关全部断言（**数量待统计**） |
| S5 | 状态句替换统计条 | `map-stats` 只在完整模式出现，断言 `1503` / `1517` 依赖它，改为按 `map-status-line` |

**验收（必须实跑，不能只看代码）**：
1. `npm run build`（改界面后不 build 跑的是旧产物）
2. `npm run goods:ui` —— 三遍全绿（宽 / 窄 / 默认窗口可达性）
3. `npx vitest run`（`uxEntryNames` 会拦文案里提到但界面不存在的入口名）
4. 真机点一遍：默认 1200×800 窗口下动作条不被裁、窄窗口两栏堆叠时动作条仍可达

**变异复核**（照本仓惯例，至少 2 条）：
- 把动作条的提交按钮改成两个 ⇒ 反向守卫必须红；
- 把 `pendingRows` 的来源标签去掉 ⇒ "两源合并后仍分得清来源"断言必须红。

## 7. 回退与风险

| 风险 | 处置 |
| ---- | ---- |
| P2 改坏认款写入 | 写路径不动（仍是 `commitMap`），只换 UI；`GOODS_LAYOUT='tabs'` 可退到整宽形态 |
| 合并两源后"归属"混乱 | 来源标签 + 筛选；一个商品不会同时出现在两源（采集段恒列未认款，见 `useSkuPool` 注释） |
| P3 删展开区丢能力 | 逐条对照 §5 表格确认新家存在；`editable`/`productId` 筛选两处**待验证** |
| 断言与实现漂开 | 每步都跑 `goods:ui`，不攒到最后；锚点迁移表与代码同步改 |

> 本方案为产品设计参考，具体实施请结合项目既有门禁与真机走查确认。
