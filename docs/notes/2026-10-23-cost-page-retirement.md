# 进价页退役（B'）：一个字段不需要一页，汇率是死代码

**日期**：2026-10-23 · **取代关系**：接 [`2026-10-21-cost-two-fields-c2.md`](2026-10-21-cost-two-fields-c2.md) 之后
（C2 把价目表 `ae_cost_map` 删了，这轮把**界面**也删了）；不取代任何笔记，只补"界面往哪去"。

## 结论（六条，按可复用程度排）

1. **「一页管一个字段」是负债，不是功能**。C2 之后进价 = `pl_products.cost_cents` **一个数**，
   而「基础数据 › 进价」页还剩两块：一款一价的清单 + 汇率维护。用户问"进价页面还需要吗" ——
   字段已经在产品行上，页面只是它的一份只读投影 ⇒ 撤页、把"待办"做成产品列表的一个筛选。
2. **汇率是死代码，但要先证再删**（下面「取证」一节是完整判据）。撤 UI **不删表**：
   唯一读 `ae_rates` 的是老采集库的一次性迁移，删表换不来收益、只换来风险。
3. **"缺 X 待办"必须走服务端筛选，不能在前端 filter**。产品列表**分页在服务端**
   （`listProducts` 带 `offset/limit`），前端过滤会把"第 2 页里那些缺进价的款"藏成"没有"——
   用户以为齐了。故 `onlyMissingCost` 进 `listProducts` 的互斥优先级链
   （未关联厂家 > 指定厂家 > 缺克重 > 缺进价），并在 `filtered` 里参与"是否处于筛选态"。
4. **同一个字段在两个列表组件里都要有落点**。`ProductPane.vue`（基础数据内嵌形态，`goods:ui` 驱的
   就是它）与 `ProductListView.vue`（独立页形态）是两套模板：只改一处 ⇒ 冒烟在你没改的那处挂掉。
   加列同时要改 `gdColspan`（简洁 5/6 → 6/7）：空态行与展开行都跨**全表**，列数写死会各短一格，
   **不报错**，只是右边留白。
5. **`vite build` 不含 `vue-tsc`**。`npm run build` = `vite build && tsc -p tsconfig.electron.json`，
   渲染层的 Vue/TS 类型错误它**一个都不报**。本轮 `src/modules/goods/api.ts` 的 `list()` 载荷类型
   漏了 `onlyMissingCost`，`build` 全绿、`vue-tsc --noEmit` 才炸（`useProductList.ts:137`）。
   ⇒ 改了渲染层的**跨层参数**，必须单独跑 `npx vue-tsc --noEmit`。
6. **退役一个页会连带打断"跳转类"冒烟**。旧冒烟里有一段：点区头「去维护」→ 等落到
   `kind-tab-cost` 高亮 → 再派 `switch-module` 切回来 → 等刷新键可用。页没了以后它表现为
   `SMOKE: FAILED at [cost-rates] - timeout`（看着像页面崩了，其实是"等一个永不复现的高亮"）。
   整段舞蹈要**连根删**（含那句"必须等落下来再切回"的注释），只留下"等刷新键可用"。

## 取证

**汇率为什么是死代码**（真库克隆 + 只读 SQL，不是读代码猜的）：

```bash
cp "$HOME/Library/Application Support/seller-kit/sellerkit.db" /tmp/sk-db-ro.db
sqlite3 /tmp/sk-db-ro.db "SELECT currency, rate FROM ae_rates;"        # 5 行，全是种子默认
sqlite3 /tmp/sk-db-ro.db "PRAGMA table_info(oi_orders);" | grep currency # 无输出：没有 currency 列
grep -rn "ae_rates\|aeRateList" electron/ src/                          # 只有迁移函数 + 本轮要删的 UI
```

- `ae_rates`：USD 7.2 / EUR 7.8 / GBP 9.2 / RUB 0.085 / CNY 1.0 —— 与代码里的种子常量逐字相同，
  说明**从建库到现在没有任何一次用户写入**。
- 金额：`oi_orders` 没有 `currency` 列，导入/采集进来的金额直接是人民币分；
  `orderCost.ts` 里只有"非 CNY 报价的运费直接拒算"，**没有任何汇率查询**。
- 唯一读者：`migrateLegacyCollectedOrders`（老采集库一次性迁移）。⇒ 表留、UI 撤。

**分页导致的假"没有"**（这是第 3 条结论的取证）：`useProductList.load()` 传 `offset/limit`，
`rows` 只装当前页；`filtered` 只用来显示"我现在处于筛选态"的 chip，**不是**筛选本身。

**列数与跨列**：`ProductPane.vue` 的 `gdColspan = computed(() => (goodsSimple ? 5 : 6))` ——
2026-10-10 撤 SKU/缺克重/进价三列时两档各 −3，本轮把进价加回来 ⇒ 两档各 +1，改回 6/7。

## 守卫（这轮加了什么钉子）

| 钉子 | 位置 | 钉住什么 |
|---|---|---|
| 下拉 → chip → 载荷 `onlyMissingCost:true` → 筛出的行 `p-cost` 全是「—」→ 点 chip 撤掉回到全部 | `goods:ui` 的 `issue-filter-cost` 步 | 缺价待办真的在产品列表里、且**服务端**参与筛选（只在前端 filter 会让载荷恒 false） |
| 「产品管理这一组是**两条**页签」 | `goods:ui` | 进价页签不许被"顺手"加回来（加回来 = 又有一个页只管一个字段） |
| 不画币种 / `rate-*` 锚点一个不剩 / `aeRateList` 与 `aeRateUpsert` 调用数都为 0 | `order-profit:ui` 的 `cost-rates` 步 | 汇率 UI 真的退干净了 —— 连"读了不用"的空转调用也钉住（那种残留最容易在下一次改造里复活成 UI） |
| 区头没有 `cr-goto`（「去维护」） | 同上 | 按钮指向的页已不存在，留着就是点一片空白 |
| 缺进价项 `target === 'goods'`，`HealthTarget` 收窄为两类 | `tests/dataHealth.spec.ts` | 健康检查的"去修"不许跳到一个不存在的页 |
| 文案里的入口名必须是**现存**入口 | `tests/uxEntryNames.spec.ts` | 我在 `CostRatesSection.vue` 写的「货品档案 › 产品管理」是**旧模块名**（2026-10-17 已并入「基础数据」），这条测试当场抓住 |

**变异自检**：把 `onlyMissingCost` 从 `listProducts` 的 WHERE 链里删掉 ⇒ `issue-filter-cost` 红；
把 `gdColspan` 留着旧值 ⇒ 该步仍绿（列数只影响几何，不影响断言）—— 所以列数这条**没有自动化守卫**，
只能靠"空态行视觉"和这条笔记。若以后要钉，判据应是 `colSpan === 表头 th 数`（`goods:ui` 里已有动态比法，
撤/加列不需要改数字）。

## 顺带的两处沉淀

- **注入脚本里的注释不能带反引号**（本项目第三次踩）：`goods-ui-smoke.mjs` 与
  `order-profit-ui-smoke.mjs` 的断言脚本是模板字符串，注释里写 `` `oi_orders` `` 会直接截断字符串，
  症状是 `SyntaxError: Unexpected identifier 'oi_orders'`（`node --check` 立刻能抓，别跳过）。
- **历史记录不要改指向**：`PRODUCT_LIBRARY.md` P4 行和 `SHOP_ACCOUNT_REDESIGN_PLAN.md` §7.1 里的
  `CostPane.vue` 路径是"它当时住在哪"的记录，改成现存文件则句子不成立 ⇒ 走 `check-doc-links.mjs` 的
  `DELIBERATELY_MISSING` 豁免（理由必须能回答"为什么改指就错"）。但**功能文档的"现状"部分必须改写**
  （P4 行已加「⛔ 2026-10-22 退役 / 现状入口」），否则读者会以为页还在。
