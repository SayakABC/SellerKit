# 「信息展示不全」的默认归因是错的：先量 `scrollWidth` 再决定加不加字段

**结论**

用户说"页面信息展示不全"时，第一反应几乎都是"少了字段"。本轮「算钱」取证否掉了这个方向：

> **"展示不全" = 容器把内容裁掉了，不是数据缺失。**

判据只有一行：在**真实长度的数据**下量 `table.scrollWidth` 与可用宽度 `page.clientWidth`。

- 实测 `table.scrollWidth = 1211` > `page.clientWidth = 1064`，而外层 `.wb-panel { overflow: hidden }`
  **静默吞掉溢出** —— 不出滚动条、不报错、DOM 里字段一个不少。截图 `/tmp/c3-oc-clipped.png` 里右侧 3 列整块消失。
- 若只看"字段在不在"（模板 / 数据 / 类型），**永远查不出来** —— 字段确实在，只是画到屏幕外面去了。

⇒ 修法由这条判据直接决定：**不是加字段，是让表能滚**（新增全局 `.wb-table-wrap`，`overflow: auto` + `max-height` + 首列吸附）。

**同屏并列的数，必须同口径 —— 否则"杂乱"会伪装成"展示不全"**

本轮顺带查出一个真实口径 bug（`src/lib/orderCost.ts`）：同一条指标带上的 5 个合计里，
`costTotal` / `shippingTotal` / `platformFeeTotal` **含关闭单**，而 `revenueTotal` / `grossTotal` **不含**。
用户拿它们相减算毛利，得到的是错的数 —— **而且看不出来**。统一为「只含非关闭单」并补单测守卫。

> 通用判据：**凡是并排显示、允许用户做加减的两个数，先问"它们的作用域是不是同一个"**。

**守卫要钉在根因上 —— 钉在"壳"上会恒绿**

只断言"页面里有 `.wb-table-wrap` 元素"没有任何价值：包上去就绿，溢出依旧被裁。
本轮的根因守卫是**三合一**（`scripts/order-profit-ui-smoke.mjs`）：

```
wrap 存在  ∧  该容器 scrollWidth > clientWidth 时真的可滚（overflowX=auto）  ∧  最后一列可达
```

实测输出：`wrap=true overflowX=auto 表宽=819 容器宽=498 溢出=true 末列可达=true`。
变异验证：去掉滚动包裹层 → `末列可达=false`（红）。

**取证**（可复现）

| 项 | 位置 |
| --- | --- |
| 根因（容器裁切） | `.wb-panel { overflow: hidden }` 吞掉 `table.scrollWidth=1211` 超出 `page.clientWidth=1064` 的部分 |
| 修法 | `src/styles/index.css` 新增 `.wb-table-wrap`；`OrderCostView.vue` 明细表与统计表套入 |
| 口径 bug | `src/lib/orderCost.ts`：`costTotal`/`shippingTotal`/`platformFeeTotal` 原先含关闭单 |
| 根因守卫 | `scripts/order-profit-ui-smoke.mjs`：「宽明细表在滚动容器里…末列可达」 |
| 变异复核 | ①去包裹层 → 末列不可达；②平台费列恒显 0.00 → 列守卫红；③分段切换打断 → 红；④`costTotal` 退回含关闭单 → `expected 52 to be close to 26` |

**顺带记的工程细节**：`.wb-seg` 原为「货与成本」模块私有，本轮提为全局（`src/styles/index.css`）——
**同一角色的控件在第二个页面上出现时，就该提为全局**，不要复制第二份。
