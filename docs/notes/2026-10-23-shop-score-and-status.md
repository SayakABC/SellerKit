# 店铺记分与四态：新列不能挂已短路的迁移键，状态缺省不能"归一成启用"

## 结论

1. **`sk_shops.score`（记分分值，REAL，0 = 未记录）用独立迁移键 `shop.columns` v1。**
   不能追加进 `shop.main`：那一步在 version ≥ 1 时直接短路（`runShopMainMigration()` 开头就 return），
   之后加多少步骤都不会执行。本域的执行顺序固定为
   `dbMigrate(SCHEMA)` → `shop.main` → `shop.columns` → `dbMigrate(INDEXES)`
   —— `shop.columns` 必须在 `shop.main` **之后**：老库若还没合并，`sk_shops` 会在合并时被重建，
   先补列会补在即将被替换掉的旧表上。重建用的也是同一个 `shopTableSql`（已含 score），
   但 `loadShopsSql` 不列该列 ⇒ 合并出来的老店铺行记分为 0，语义正确。
2. **状态四态只有一处来源**：`SHOP_STATUSES`（启用 / 停用 / 封店 / 退店）。
   账号域 `SHOP_ACCOUNT_STATUSES` 直接引用它，不再维护第二份白名单；
   界面文案与语义色在渲染层 `STATUS_META`（`banned` = 封店 · danger、`exited` = 退店 · warning）。
3. **局部更新时，状态缺省必须沿用"归一后的现值"，不能只判断 `archived`。**
   旧写法 `archived ? 'archived' : 'active'` 会把封店 / 退店在"只改备注"时静默改回启用
   —— 这是本次最容易复发的一处，冒烟专门钉住。记分同理：缺省保持原值，**显式 0 才清为未记录**。
4. **记分非法值抛错，不静默归零。** `normalizeShopScore` 接受 ≥ 0 的有限数并保留两位小数；
   负数 / `NaN` / `Infinity` 抛 `记分分值必须是 0 或正数`。静默归零的后果是"保存成功但分没记上"。
5. **界面遵守「全零不占位」**：记分只在 > 0 时渲染（列表状态徽标下的 `.cell-sub`、卡片字段），
   0 不显示。订单 / 拣货页按 `status: 'active'` 取店，封店 / 退店与停用一样自然退出候选，
   不需要另加过滤。

## 取证

- 列与迁移：`electron/shop-db.ts:223`（建表含 `score REAL NOT NULL DEFAULT 0`）·
  `electron/shop-db.ts:311-323`（`SHOP_COLUMNS_KEY = 'shop.columns'`、`PRAGMA table_info` 幂等 +
  `ALTER TABLE`、`migrate` 一步 v1）· `electron/shop-db.ts:821`（重建用 `shopTableSql('sk_shops_new')`，
  已含 score）· `electron/shop-db.ts:822-827`（`loadShopsSql` 列清单不含 score ⇒ 默认 0）。
- 四态与合并：`electron/shop-db.ts:89`（`SHOP_STATUSES` 四项）· `electron/shop-db.ts:528-535`
  （`mergeStatus`：店铺侧非启用优先；账号侧 `banned`→封店、`closed`→退店、其余非启用→停用）·
  `electron/shop-accounts-db.ts:20,39`（直接复用 `normalizeShopScore` / `SHOP_STATUSES`）。
- 局部更新：`electron/shop-db.ts:1427-1428`（`status === undefined ? normStatus(existing?.status) : …`；
  score 同理）· `electron/shop-accounts-db.ts:430-431`（账号写入面同口径）。
- 归一：`electron/shop-db.ts:1093-1097`（`normalizeShopScore`）。
- 界面：`src/modules/shop-accounts/store.ts:81-92`（`STATUS_META` 四态与 tone）·
  `src/modules/shop-accounts/components/AccountEditor.vue:503,514-520`（四态按钮 `data-status`、
  `data-act="shop-score"`）· `src/modules/shop-accounts/components/AccountsPanel.vue:571-579,693-695`
  （仅 > 0 才渲染记分）。
- 守卫：`npm run shop:smoke` 39 → **43 项** —— `scripts/shop-db-smoke.cjs:309`（老库补列）、
  `:505`（四态写入 / 筛选 / 局部更新不复活）、`:538`（记分边界）；
  `npm run master-data:ui` 的 `scripts/master-data-ui-smoke.mjs:793-801`（0 不占位 vs 记分 12）、
  `:929-955`（编辑器四态 + 记分 20 + 封店保存回写）。
- **迁移测试的构造纪律（本轮踩点）**：老库补列用例必须**显式建出旧形状**（当前 DDL 去掉 score）再调
  `ensureShopSchema()`；若只是 `DROP TABLE` 后 ensure，`dbMigrate(SCHEMA)` 会直接建出**带 score 的新表**，
  `ALTER` 分支永远不执行、断言恒绿。`shop.main` 的用例同理要先清 `sk_schema_migrations` 的对应键。
- 门禁口径：`schema:smoke` **不含本域**（`shop.main` 不走 `migrate()` 步骤表），老库场景以
  `npm run shop:smoke` 为准；本轮 `lint` 0 error / 523 warning、`verify`、`verify:docs`、
  `vue-tsc --noEmit`、`tsc -p tsconfig.electron.json`、`vitest` 45 文件 / 872 用例、`build`、
  `shop:smoke`（43）、`master-data:ui`、`schema:smoke` 均通过。
