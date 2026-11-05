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

关键代码位置：

- `src/modules/today/flowCtx.ts`（`SHIPPING_TAB_NAMES`，页签名与口径注释）
- `src/modules/today/TodayView.vue`（`TABS`、四步 `flow`、导入容器实现）
- `src/modules/today/tabs/QueuePanel.vue`（合并后的主面板：采集主入口 + 采集状态条 + 折叠 Excel 区）
- `src/modules/today/tabs/ExcelImportSection.vue`（Excel 实体；保留全部 `import-*` 锚点）
- `src/modules/today/tabs/OverviewPanel.vue`（空态双按钮与主次）
- `scripts/today-ui-smoke.mjs`（页签/入口/折叠/URL 断言）
