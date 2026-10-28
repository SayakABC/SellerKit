# 店铺状态并到店名下 + 保证金到账时间（2026-10-25）

## 结论

1. **「状态」不再单独占列**：`sk_shops.status` 的徽标与 `score` 记分一起挂在**店铺格**里（店名下方）。
   顶部状态统计条不动 —— 它是筛选器，不是行内状态，两者不是同一件事。
2. **保证金到账时间是店铺行的第 N 个日期字段**：`deposit_received_at TEXT NOT NULL DEFAULT ''`，
   口径与 `opened_at` 完全一致（`YYYY-MM-DD`、空串 = 未填写、非法日历日归一为空串）。
3. **可见性由状态决定，数据不随状态清空**：列表只在 `status === 'exited'` 时渲染这一行；
   状态改回启用 / 封店后库里日期仍在，编辑器也只在「退店」时给输入位。理由：退店可以反悔
   （重新开店再退），把日期当"退店专属字段"清掉会让用户二次退回时重填。
4. **老库走 `shop.columns` v2，不走 `shop.main`**：`shop.main` 的版本一旦 ≥ 1 就整段短路，
   往里加步骤永远不会执行（v1 的教训见 `2026-10-23-shop-score-and-status.md` 同款）。

## 取证

- 列与迁移：`electron/shop-db.ts:225`（`shopTableSql` 建列）、`:321`（v2 步骤，`PRAGMA table_info` 幂等
  探测后 `ALTER TABLE`）、`:330`（`runShopColumnsMigration` 的步骤表，v1=score、v2=deposit）。
  顺序仍是 `dbMigrate(SCHEMA)` → `shop.main` → `shop.columns` → `dbMigrate(INDEXES)`。
- 写入/读取：`electron/shop-accounts-db.ts:442`（局部语义：`undefined` 保持、字符串覆盖）、
  `:222`（`LIST_COLS` 带出该列，列表与详情共用）、`:830`（`toItem`）。
- **preload 是白名单消毒**：`electron/preload.ts:153` 的 `opt('depositReceivedAt', 40)` 漏了，
  字段会在渲染层 → 主进程的路上被**静默丢掉**（不报错、不告警）。
- 界面：`src/modules/shop-accounts/components/AccountsPanel.vue:157`（`depositText`，
  未填时说「保证金到账时间未填」而不是「未到账」）、`:546`（表格店铺格）、`:639`（卡片同读法）；
  `AccountEditor.vue:519` 的 `data-act="shop-deposit"` 只在退店时渲染。
- 冒烟：`scripts/shop-db-smoke.cjs` 的前置断言已从「账本记到 v1」改成 v2，并新增往返用例
  （写入 / 列表带出 / 漏传保持 / 带时间截日期 / `2026-02-30` 归一空串 / 空串清空）；
  `scripts/master-data-ui-smoke.mjs` 的夹具让 **11 启用但库里存着日期**、**12 退店且有日期** ——
  两个方向都钉住，只验"退店能显示"会让"所有行都显示"照样绿。

## 顺带修掉的一个脆弱断言

旧冒烟用 `chip.nextElementSibling` 找记分行 —— 它默认"状态徽标后面紧跟记分"，本轮把状态移进店铺格后
立刻失效。现改为结构性选择器 `.cell-score`（`AccountsPanel.vue:564`），
以后在两者之间再插一行（比如保证金）不会把断言带崩。
