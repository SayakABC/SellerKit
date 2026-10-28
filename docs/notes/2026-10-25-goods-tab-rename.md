# 页签「建档与关联」改名「款与商品」：名字的语法形态要匹配它所在的那一层

**结论**（2026-10-25，用户口径「这几个字也不合适」）：

1. **旧名的问题是语法形态，不是"不好听"**。侧栏读作「产品管理 › 建档与关联」—— 组名是名词，
   项名却是**两个动词并列**（建档 + 关联），读起来像一条待办而不是"这一类资料叫什么"；
   同组的「供应商」是名词，两者不对称。它也没覆盖这一屏真正的内容：左边是款档案，
   右边是**店铺商品** —— 名字里只有动作，用户看到的是两个对象。
2. **新名与两栏一一对应**：`款与商品`（左 = 款，右 = 商品），"建档 / 认款"两个动作都被它覆盖。
   不选「认款台」（与「发货台」同构、动线清楚，但弱化了左栏的档案维护）；
   不选「产品库」（与组名「产品管理」重复"产品"，读作「产品管理 › 产品库」）。
3. **改名只动呈现层**：`store.mainTab` 的值仍是 `'goods'`（持久化偏好 + 跨模块 action 的字符串协议），
   所以用户本地偏好、「待补清单 / 归类核对」里的跳转全部照旧可用。
4. **这个页面的 UI 契约被冒烟钉死，减法不能只改界面**。`scripts/goods-ui-smoke.mjs` 直接
   `setVal` / `click` 工具栏控件（`:1545` 用它切筛选、`:1601` 断言它在 `.gd-toolbar` 里、
   `:3990` `:4030` 点导入导出）。把控件收进折叠面板能让断言"技术上仍绿"（`display:none` 仍可
   `click()`），但那等于**断言在操作一个用户看不见的控件** —— 比杂乱更糟。
   所以 2026-10-25 这轮只做**层级与文案**（按钮降 ghost / 主操作只留一个），
   真正的收敛（右栏三段合并、认款单动线）留在
   [GOODS_TAB_REDESIGN_2026-10-25](../plans/GOODS_TAB_REDESIGN_2026-10-25.md)，必须连断言一起改。

**取证**：

- 唯一来源 `src/modules/goods/tabs.ts` 的 `GOODS_TAB_LABEL.workbench`；
  本文件顶部注释记了完整判据（含不选另两个候选的理由）。
- 改名波及 **14 个文件 41 处**：`src/lib/dataHealth.ts`（3 条"去哪儿补"的文案）·
  `src/modules/today/tabs/ClassifyPanel.vue`（归类面板的指路）·
  `src/modules/shop-accounts/components/ShipRateProductsTab.vue`（运费页的指路）·
  `scripts/goods-ui-smoke.mjs`（13 处 `clickText` / 断言）· `tests/uxEntryNames.spec.ts`（豁免表 key）·
  `tests/shopAccountsIntake.spec.ts`（4 处）· 其余为注释与文档。
  历史记录（`CHANGELOG.md`、`docs/notes/` 旧条目、`docs/plans/` 旧方案）**刻意不改** —— 那是当时的名字。
- 认款入口数：`ProductPane.vue` `data-act="relate-from-expanded"` · `PoolPane.vue`
  `data-act="relate-to-selected"` / `queue-batch` / `items-batch` / `items-new-product` = **4 个近义入口**，
  这是"操作不方便"的主因，不是排版问题。

**门禁**：`vue-tsc --noEmit` ✅ · `npm run verify` ✅ ·
`vitest run tests/uxEntryNames.spec.ts tests/shopAccountsIntake.spec.ts` ✅（18 tests）。
`goods:ui` 本轮未跑（需 `npm run build` + Electron），P2 开工前必须先跑一遍拿基线。
