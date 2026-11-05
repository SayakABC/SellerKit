# 按单核对的 73 单：范围标注（默认全量，老单折叠）（2026-11-02）

## 结论

1. **「今天同步 4 单」和「拿货页 73 单未发」不是同一个数**，两个都真：
   - 总览「今天要发」按**导入日**筛（`TodayView.vue` 的 `importDate: localDayKey()`），今天只进 4 单；
   - 按单核对是**全部未发货**（跨天结转），宿主 `purchase-db.orderCoverage()` 的口径；
   - 本机真库取证：73 单 = **69 单 Excel 历史导入（10-05 ~ 10-28）** + **4 单 11-02 芒果采集**。
2. **默认就是全量，不给用户加一步操作**。折叠头写「全部未发货 · 含历史导入 N 单」，
   展开写「全部未发货 N 单 = 今天导入 N + 历史导入 N」；「可以发货 / 还差」两个数始终是全部。
   - **不要**给按单核对加时间窗下拉。试过一版「默认近 30 天」：用户当场否掉（「用户得多操作一步」），
     而且窗口一缩，折叠头的「还差」会从 73 变 12，更像数字在变魔术。
   - 反向守卫：`today-ui-smoke` 断言 `pu-cover-days` / `pu-cover-bar` / `pu-cover-show-all` **都不存在**。
3. 只有**下单超过 30 天**的老单在「可以发货 / 还差」两段里各折成一行
   （`pu-cover-done-older` / `pu-cover-partial-older`，文案「更早 N 单（N 件）」），点开才进列表。
   30 天只是**折叠分组界线**，不是筛选；那一行自己写着单数件数，**不静默藏单**。
4. 折叠分组按**下单日**（`dateKey(orderTime)`）判定；**没有下单日的单照收**（"没日期" ≠ "太老"）。
5. 「今天导入 / 历史导入」必须按**入库日**（`oi_orders.created_at` → `OrderCoverageRow.importedAt`），
   **不能**用下单日：本机今天采集的 4 单，下单日是 10-24 ~ 11-01 —— 用下单日会答成"今天 0 单"。
6. 这次只修**界面口径**。生产上的**累积**问题仍然存在（`ship_time` 没有任何路径被回写，芒果只抓
   「待发货」；单在平台发货后本地永远停在未发货），需要数据闭环（采集回传已发货 / 导入更新已有单）
   才能真正收敛 —— 见同一天的 `2026-11-02-mango-*` 流程笔记与 CHANGELOG 的对应条目。

## 取证（可复现）

```bash
DB="$HOME/Library/Application Support/seller-kit/sellerkit.db"
sqlite3 -header -column "file:$DB?mode=ro" "
SELECT source, COUNT(*) FROM oi_orders GROUP BY source;
SELECT substr(created_at,1,10) AS imported_day, source, COUNT(*) FROM oi_orders GROUP BY 1,2 ORDER BY 1;
SELECT COUNT(*) FROM oi_orders WHERE ship_time='';
"
```

实测输出：`collect 4` / `import 69`；`created_at` 跨 10-05 ~ 11-02；`ship_time` 为空 73/73；
`purchase_orders` 0 条 ⇒ `可以发货 0 单 · 还差 73 单`。

代码位置：

- 宿主口径：`electron/purchase-db.ts` 的 `orderCoverage()`（`WHERE o.ship_time='' AND …`，
  注释「这里是**全部未发货**」；2026-11-02 起多回 `created_at AS imported_at`）。
- 纯函数：`src/lib/orderCoverage.ts` 的 `scopeCoverageByDays()` / `coverageImportSplit()`；
  折叠界线复用 `src/lib/picking.ts` 的 `cutoffDate()`（导出，避免两套实现）。
- 界面：`src/modules/today/tabs/PurchasePanel.vue` 的按单核对段
  （`pu-cover-scope` / `pu-cover-source` / `pu-cover-done-older` / `pu-cover-partial-older`）。
- 门禁：`tests/orderCoverage.spec.ts`（折叠界线与来源拆分）、`scripts/today-ui-smoke.mjs`
  （折叠头范围、来源文案、「更早 1 单」折叠与展开、反向守卫"不许有时间窗控件"）。
