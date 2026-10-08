# 主数据页也要有"起点"：并列的页签等于没有起点

> ⚠️ **本笔记已降级为历史记录（2026-10-08 晚）**：文中的**引导条**（立款 → 补克重 → 认货）
> 与它的判据 `src/modules/goods/flow.ts`（含 `tests/goodsFlow.spec.ts`）**已按用户要求整体撤除**
> —— 用户的原话是"步骤条感觉实用意义不大"。同一次撤除还包括页首那条**指标条**与页签徽标。
> 下面记述的判断（"并列页签等于没有起点"、"有没有下游消费者是收功能的唯一判据"、"`0` 与 `null`
> 必须分开"）**仍然成立、仍然可复用**；只是这一页最终选择用"点一遍页签就知道顺序"来替代常驻引导条。
> 撤除的经过见 `CHANGELOG.md` 的同日条目与 `.workbuddy/memory/2026-10-08.md`。

**结论**

用户说"不知道该从哪里开始、也不知道该做什么"时，先别去看"功能是不是太少"—— 那多半是
**页面的组织维度选错了**：`src/modules/goods/GoodsView.vue` 当时把产品 / 商品清单 / 映射与关联 /
供应商 摆成四个**并列**页签，而"我该从哪开始"在这张页面上**没有任何答案**。
同一仓里「今天」页早就有流程卡（`TodayView.vue` 的 `flow` / `flowNow` + `OverviewPanel.vue` 渲染），
**同一套语言没有被第二页复用**。

四条可复用的判据：

1. **先问"几个入口是真的"，再问"怎么排版"**。这一页真实只有两条链：
   ① 立款（供应商 → 产品(款) → SKU 克重）· ② 认货（订单 → 待关联队列 → 映射(款+色)）。
   四条并列里有**一条是断头路**（见下）。并列入口的数量不是排版问题，是**这一页到底有几件事**的问题。
2. **"有没有下游消费者"是收功能的唯一判据**（同 2026-10-01 删 `DB_OPS` 域的判据）。
   「商品清单」写的池行被判据谓词 `skuPoolSql()` 圈住，而**全仓只有 `electron/shop-product-db.ts`
   自己读它**；订单归款 / 拣货 / 算钱一律走补集 `skuMappingSql()`（`electron/product-db.ts:809-826`
   的注释直说两者"同表共存"）。⇒ 用户在这个页签做的事**不影响任何其它页面**。
3. **"导入后回显"这个需求要先确认它由谁满足**。用户以为商品清单是"导订单后看看进来了什么"，
   实际它要求**另准备一份** Excel（列名须为「产品ID」「产品图片链接」，`productIo.ts:296`），
   且完全不读订单。真正的回显是「映射与关联」的待关联队列（实时聚合 `oi_orders`）与
   「今天」页的导入回执 —— 收掉商品清单**不损失任何能力**。
4. **`0` 和 `null` 必须分开**（这一条在 2026-10-05 的"产品维度指标格"里已经立过一次，这次是第二例）。
   外壳首屏停在「产品」页签时队列**根本没被拉过** ⇒ `mappedQueue` 是 `null` 不是 `0`。
   把 `null` 当 0，引导条会说出"都认完了"——那是它**不知道**的结论，代价是用户不再去配映射。

**落地**（2026-10-08）

- 新纯函数 `src/modules/goods/flow.ts` 的 `buildGoodsFlow()`：三步进度，判据照搬「今天」流程卡的
  **串联语义**（前一步没完成，后面一律 `todo` + "等第 N 步"），使"当前步"**至多一个**。
- `GoodsView.vue` 页头下加**引导条**：三步徽标 + 一句带数字的理由 + 一个**真能过去的**按钮
  （`data-act="guide" / "guide-step-<key>" / "guide-next" / "guide-go"`）。
  到「产品」页签的按钮**必须带上筛选意图**（`intent`）—— 只切页签不筛，用户还得在 27 个款里
  自己找那 3 个缺克重的，那就是这一页刚删掉的"假动作"变体。
- 新常量 `SHOP_PRODUCTS_TAB_ENABLED = false`：**只收界面，数据一行不删**
  （`ShopProductView.vue`、6 个 `shop-product-*` 通道、`shop-product-db.ts`、存量池行全留）。
  恢复 = 把常量改成 `true`，其余一行不用动。
- `SkuMappingView.vue` 队列空态补「去「今天」导入订单」按钮（`switchModule('today')`）——
  同文件下面那个空态（"还没有任何映射"）早就有下一步按钮，这里只是补齐同一形态。

**取证**（可复现）

```bash
npm run goods:ui      # report() 53 → 63 项（新增 10 条、删掉 2 条旧「商品清单」断言）
./node_modules/.bin/vitest run tests/goodsFlow.spec.ts   # 9 条
```

- 「商品清单」无下游：`grep -n "skuPoolSql\|skuMappingSql" electron/*.ts` —— `skuPoolSql` 只在
  `electron/shop-product-db.ts` 出现；`skuMappingSql` 在 `product-db.ts` 的映射读写、`shopSku.ts`
  与 `product-sku-smoke.cjs` 里出现。
- 引导条判据：`src/modules/goods/flow.ts`；断言 `tests/goodsFlow.spec.ts`；
  界面契约 `scripts/goods-ui-smoke.mjs` 的 `guide` / `guide-go-filter` / `guide-advance` /
  `guide-go` / `empty-entry` 五步。
- 空态的 `**星号**`：`SkuMappingView.vue` 里那句"队列不是缓存表，而是**实时**…"原先把 markdown
  写进了**纯文本节点**，界面上原样显示四个星号 —— 已删。（`.wb-empty__desc` 是纯文本，不渲染 markdown。）

**变异复核**（用例全绿 ≠ 守卫有效；四条都确认能变红，之后复原）

| 变异 | 预期变红 | 实际 |
| --- | --- | --- |
| `flow.ts` 把 `null` 当 0（`count(input.mappedQueue ?? 0)`） | 「队列没取到时不能说队列是空的」 | ✅ 1 failed |
| 去掉串联语义（`wait1` 恒空） | 空库用例 + 排他性 + 脏值 | ✅ 3 failed |
| `SHOP_PRODUCTS_TAB_ENABLED = true` | 「三个页签」+「商品清单已收起」 | ✅ 2 FAIL |
| `goStep` 只切页签、不传 `intent` | 「点下一步把列表筛窄」 | ✅ `SMOKE: FAILED at [guide-go-filter] - timeout` |

⚠️ 第四条值得记一下：**「按钮可点」和「按钮有目的地」是两条断言**。只断言"切到了某个页签"
的话，把 `goStep` 改成 `goTab(s.tab)` 照样全绿（页签确实切了）—— 必须断言**结果**
（列表真的窄到 1 行、且活跃筛选行真的出现）。

> 相关：`docs/notes/2026-10-01-simplify-ui-evidence-first.md`（四类复杂度来源）·
> `2026-10-03-hint-is-not-an-entry.md`（提示不是入口）·
> `2026-10-05-shipping-console-tabs.md`（「今天」流程卡的串联语义与页签名守卫）。
> 本次只动「货与成本」这一页，登记在 `CHANGELOG.md` 的 `[Unreleased]`。
