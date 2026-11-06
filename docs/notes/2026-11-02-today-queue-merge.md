# 「待发货」与「导入订单」合并：唯一入口 + Excel 降级（2026-11-02）

## 结论

1. **页签层合并，口径层不动**。`flowCtx.SHIPPING_TAB_NAMES` 删掉 `import`，只留 `queue: '待发货'`；
   `TodayView` 的 `TABS` 同步删掉 `import`，并把 `queue` 标成第 1 步（`no: '1'`）—— 页签从六个回到五个。
   `dailyShip`（按**导入日**筛"今天这批"）与 `shippingPulse` / `shippingQueue`（按**当前状态**跨天算
   "现在还没发"）**没有合并**，两者仍是两块独立的数：合并的是"在哪一屏操作"，不是"数什么"。
2. **弱化 Excel 的具体做法是"折叠 + 降级"，不是"删掉"**。Excel 入口从页头主按钮退成
   `queue-excel-toggle`（`wb-btn--sm wb-btn--ghost`，文案「Excel 导入（备选）」），内容默认收起
   （`excelOpen = false`）。它没消失：芒果登录过期、只有平台报表时仍要走这条路。
3. **反馈不能被一起折叠**。`importing` 为真或 `receipt` 出现时 `excelOpen` **自动置真** ——
   否则"导完的结论 + 下一步按钮"藏在看不见的区域里，等于没反馈。
4. **主入口 = 芒果采集**。`QueuePanel` 页头常驻 `queue-collect`（primary）→ `openMangoPending()`
   打开芒果"待发货筛选页"，扩展自动抓一次。总览空态同样改成
   `empty-collect`（primary，「去芒果采集」）+ `empty-import`（ghost，「Excel 导入（备选）」）。
5. **实现只有一份**。真正界面的实体是 `tabs/ExcelImportSection.vue`（由原 `ImportPanel` 复制改造）；
   `tabs/ImportPanel.vue` 降为**兼容壳**（只渲染 `ExcelImportSection`），不再被页签引用。
   导入的写库动作仍只在 `TodayView` 容器里实现一次（`importExcel` / `importFile`），
   面板只负责呈现与投放 —— 避免"拖放路径长成半截实现"。

## 文案同步（页签名是入口名，删了就会悬空）

`SHIPPING_TAB_NAMES` 是 `tests/uxEntryNames.spec.ts` 与 `scripts/today-ui-smoke.mjs` 的**唯一来源**。
删掉 `import` 之后，任何用户可见文案里写「导入订单」页签都会变成悬空入口名，因此同批改掉：

- `src/modules/picking/PickingView.vue`：「去「发货台」页的「导入订单」页签核一下…」→
  「去「发货台」的「待发货」页展开「Excel 导入（备选）」核一下…」；空态说明与按钮文案同步。
- `src/modules/order-cost/OrderCostView.vue`：运费提示里的「导入订单」→「待发货」页展开 Excel 备选。
- `src/modules/today/tabs/ClassifyPanel.vue`：空态标题「今天还没有导入订单」→「今天还没有订单」
  （采集也是"订单进来了"，只说"导入"会让只做采集的用户以为抓回来的不算数）。

## 守卫（`npm run today:ui`）

合并后冒烟脚本跟着搬，且**新增了能抓住"主次被改回去"的断言**：

- `PANEL_SEL` 删掉 `import`，页签断言改为五个；新增反向断言：`tab-import` / `.td-import` 都不许回来。
- 新增 `tab-no-queue` 锚点（`TodayView`）断言「待发货」带第 1 步编号。
- 新增 `openExcelArea()` 助手：切「待发货」→ 幂等展开备选区。所有原 `activateTab('import')`
  的步骤（import / import-orders / import-mango / import-drop / refresh-link）改走它。
- 新增断言：`queue-collect` 是 primary 且文案含"采集"；`queue-excel-toggle` 是 ghost、文案含"备选"、
  且 `queue-excel` **默认不可见**（`offsetParent === null`）；点开后翻成「收起」。
- 新增断言：`queue-collect` 真的打开芒果"待发货筛选页"（URL 含 `order/list` 与 `status/`）。
- 总览空态：`empty-collect` 必须 primary、`empty-import` 必须 ghost；空态说明要含「芒果」与「备选」。
- 归类空态出口 `cl-goto-import` → `cl-goto-queue`（正向 + 反向两条都改了）。
- 采购空态点击后等 `onTab('queue')`（不再等 `onTab('import')`）。

## 取证

```bash
npm run build        # dist/renderer
npm test             # 67 files / 1328 tests 全绿（含 uxEntryNames / shippingQueue / syncBanner）
npm run today:ui     # 假桥无头冒烟，见 /tmp/today-ui.log
```

关键代码位置（⚠️ 2026-11-05 起「总览 + 待发货」两页签**已合并为一屏「订单」**：
`OverviewPanel.vue` / `QueuePanel.vue` 都已删除，实现落在 `OrderPanel.vue`，四步 `flow` 模型一并撤掉。下表按当时的形态记录，路径去掉了目录前缀以表明它们已不存在）：

- `src/modules/today/flowCtx.ts`（`SHIPPING_TAB_NAMES`，页签名与口径注释）
- `src/modules/today/TodayView.vue`（`TABS` 五页签、取数与 `provide` 分发；四步 `flow` 已于 2026-11-05 撤掉）
- `QueuePanel.vue`（合并后的主面板：采集主入口 + 采集状态条 + 折叠 Excel 区）——**已删除**
- `src/modules/today/tabs/ExcelImportSection.vue`（Excel 实体；保留全部 `import-*` 锚点）
- `OverviewPanel.vue`（空态双按钮与主次）——**已删除**（空态与主次现由 `OrderPanel.vue` 承担）
- `scripts/today-ui-smoke.mjs`（页签/入口/折叠/URL 断言）

---

## 2026-11-05 续：「总览 + 待发货」再合并成「订单」一屏（用户拍板 D-1 / D-2）

用户原话：「『按此开始发货』按钮跳转到待发货有歧义，发货台准确的定位应该是发货前的准备工作，准备完成
就代表这个订单已经完成了准备，所以怎么才能以订单维度来跟踪当前订单的状态。现在的流程感觉是相对独立的。」
方案见 `docs/plans/ORDER_STAGE_TRACKING_PLAN_2026-11-05.md`。

1. **真正的缺口不是按钮文案，是"每张单准备到哪一档"这个派生状态没人算**。上一轮把两屏合并成
   一屏只解决了"在哪操作"，没解决"这单算不算完事" —— 因为页面还在按**全局串行四步**表达，
   而业务是**每单并行**。本轮补 `src/lib/orderStage.ts`：**零新表、零新 IPC、零新增字段**，
   输入就是容器已经取到的 `order-shipping-rows` + `purchase-order-coverage`。
2. **档 = 明细行里最差的那一档（木桶）**，不是"多数行"也不是"第一行"。
   实测反例：一单三行里两行齐、一行差 1 件 ⇒ 这单是「待拿货」，`gap` 要写 1 而不是 0。
3. **「已发出」不是第五档，是自动离队**。`shippingQueue` 本来就只用 `isWaitingShip` 过滤，
   已发货单根本进不来。所以恒等式是 **缺图 + 待归类 + 待拿货 + 待核对 + 已备齐 ≡ `pulse.pending`**；
   想加第五档的人先去看 `ship_time`（至今**没有回写路径**，应用内不做「标记已发货」）。
4. **读不到 ≠ 已备齐**。覆盖度取不到（`coverage.ok=false`）或行没有订单行身份（`id=0`）⇒ 落
   `unknown`（界面词「待核对」），并在首屏出 `stage-unknown-hint` 说明原因。不写这一条，
   用户会把"判不出来"读成"都齐了"，当天少发一批货。
5. **「开始处理」只做它说的事：筛清单**。它不再是「按此开始发货」（那个按钮承诺了应用里不存在的
   动作，落点却是只读表）；现在点一下把清单筛到**当前最卡的那一档**，再点取消。
   采集按钮从 primary 降成页头常驻的工具按钮 —— 采集是"随时可重跑的动作"，不是"下一步"。
6. **跨页带上下文**：`classifyFocus`（单号）+ 新增 `purchaseFocus`（单号/款/色/还差件数）。
   款色键抽成 `colorGroupKey()` 唯一实现（`picking.ts`），否则"订单屏算出的键"与"拿货页的键"
   各写一遍，改一次就静默失配。
7. **「按单核对」没有改读 `orderStage`（有意为之）**：它按 `purchase-order-coverage` 覆盖**跨天未发货**
   （窗口比"今天待发货"宽），强行统一会把历史单从窗口里抹掉。漂移风险改由**交叉断言**守：
   同一批行喂给 `orderStages` 与 `planCoverage`，单集合、`ready` 单的每行足量、缺口数都必须相等
   （`tests/orderStage.spec.ts` §RK-2，已做变异验证：把「少 1 件也算齐」注入后该条变红）。

### 守卫

- `tests/orderStage.spec.ts` 28 例（含三段变异守卫 + RK-2 交叉断言）；
- `npm run today:ui` 443 条：五页签、默认落 `orders`、**反向守卫**「总览/待发货两旧页签都不在」、
  「页签上没有步号」、四档之和 = 合计、点分组筛 2 单再复位 3 单、首屏唯一实心按钮 = `order-start`
  且文案不含"发货"；
- `tests/uxEntryNames.spec.ts` 拦住 6 处改名后的悬空入口名（`OrderCostView` / `PickingView` ×3 /
  `PodOrderPanel` / `OrderPanel`）——**页签改名必须同步所有指路文案**，这一条是机器替人记的。

### 本轮三个门禁坑（都会伪装成"功能没实现"）

1. **冒烟注入模板里不许出现反引号**（`check-smoke-injection` 会拦，但 `node --check` 先崩，
   报的是 `Unexpected identifier`，看着像代码写错）；
2. **点行的"壳"不会触发 `@click`**：`order-row` 只是 `v-for` 容器，点击挂在 `order-row__head` 上
   ⇒ 展开恒 false。给行头补了 `data-act="order-row-head"`，断言改写后才有意义；
3. **默认页签变了，"懒挂载"断言会恒红**：老写法"一个面板都没挂载"在 `orders` 成为默认页后必然失败
   （订单屏本来就挂了）。改成两头钉：默认面板**在**、没点过的四个**不在**。
