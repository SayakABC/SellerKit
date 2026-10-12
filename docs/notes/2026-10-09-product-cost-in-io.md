# 进价进模板：落点是 `ae_cost_map`，不是 `pl_products`（2026-10-09）

对应 CHANGELOG 续十六。用户原话：「货与成本导入导出数据模版中增加进价字段」，随后提议
「进价是不是应该放在 `pl_products`，改价作用到新导入的订单、历史订单用老价格，
可以在订单表中增加价格快照」。

**结论：不搬存储。** 两个诉求现有架构已满足；提议的方案改动面大 5–8 倍，且会反噬
"历史订单用老价"这件事本身。

## 一、为什么否掉「进价入 `pl_products`」

成本**不是单一来源**，一列存不下：

| 来源      | 写入方                                                                       | 形态                        |
| --------- | ---------------------------------------------------------------------------- | --------------------------- |
| `purchase` | 拿货对账**自动同步**（`electron/purchase-handlers.ts:25` → `syncPurchaseCosts()`） | 按 `(款, 拿货日期)` **多行** |
| `manual`   | 手工 / 导入（`ae-db.costMapUpsertManual`）                                    | 手工价                      |

`pl_products` 一列只能存一个当前价 ⇒ 拿货价的历史区间会丢。而 `pl_products` 无价格列是
**ADR-002 Q2** 的裁定；P4a（2026-09-24）专门把 `ae_cost_map` 改成「多行 + 生效区间」并落了
`ae:smoke` 回归，就是为了「成本历史可复算」。

## 二、为什么不需要「订单表加进价快照」

「改价作用到新订单、历史订单用老价」**已经是现有行为**：

```
算钱页 electron …/OrderCostView.vue:695   拉 orderShippingRows + aeCostMapList
      ↓
pickUnitCost(costs, 款编码, 订单日期)      ← src/lib/orderCost.ts:431
      ↓  按 effective_from 回查「该订单下单时生效的价」
```

改价 = 插一条 `effective_from=今天` 的 `manual` 行 → 今天起的单用新价、之前的单用旧价。

**而加快照列会反向破坏它**：订单**导入那一刻最可能还没有价**（用户先导订单、后慢慢补进价），
快照会抄成 `NULL` 且事后补不回 ⇒ 历史订单变成「无成本」。区间回查没有这个问题（补价后立刻能算）。
另：订单有**两条摄取通道**（`oi_orders.source` = `import` / `collect`），快照要在两条都算价。

## 三、落地形态

- 模板 / 导出表头（`PRODUCT_EXPORT_HEADERS`）：
  `款编码 | 款式名 | 供应商 | **进价(元)** | 图片 | 颜色 | 尺码 | 克重 | 状态 | 备注`
- 导入：`parseCostYuan`（元 → 分）→ 行上带 `costCents` → 主进程 `product-handlers` 调
  `electron/product-cost-sync.ts#applyManualCosts` → 写
  `ae_cost_map(source='manual', effective_from=导入当日)`。跨域编排收在宿主一处（同 `purchase-cost-sync.ts`）。
- 列表页 / 预览表：读 `aeCostMapList()` + `pickUnitCost(costs, code, today)` 显示**当前生效价**。

三条口径（每条都是「错了不会报错」的那种）：

1. **空 = 不修改**（`null`），**不是清 0** —— 与克重「没写就不覆盖」同族；否则「导出 → 导回」一次抹掉全部价。
2. **非法值**（负数 / 非数字 / 超两位小数）→ **error 剔行**，不猜数字（进价直通成本链路）。
3. **幂等**：值与库内现价相同则**不写** —— 否则「导出 → 原样导回」每天新增一条区间行。

## 四、⭐ 本轮踩的坑：`goods:ui` 读的是 `dist`，陈旧 dist = 假绿

`scripts/goods-ui-smoke.mjs` 加载 `dist/index.html`。**改完源码没 build 就跑冒烟** ⇒ 它测的是
上一轮的产物：新加的「进价」列断言没有、colspan 还是旧值，却**全部 PASS**。

`npm run build` 之后才暴露出**上一轮遗留的不一致**：同一天加的**克重广播**规则让「1 个克重」合法，
而 `goods-ui-smoke` 的夹具 `IMP-3`（2 尺码 / 1 克重）与断言「必须标成跳过」还停在旧规则 ——
以前没跑出来，正因为 dist 陈旧。

三条教训：

- **改了源码跑 UI 冒烟前必须先 `npm run build`**（否则「全绿」可能是旧产物的绿）。
- **夹具语义要跟规则一起改**（同 `2026-10-09-product-template-rework.md` §四）：本轮把 `IMP-3`
  的克重从 1 个改成 **3 个**，让「对不上」这件事真的成立。
- **按列下标取值的断言，加一列就要整体 +1**（本轮改 3 处：导出 `cells[5]/[6]` → `[6]/[7]`、
  预览 `tds[7]/[8]` → `[8]/[9]`）。更稳的写法是按 `data-act` 取（同一文件已有先例）。

## 五、门禁

`vue-tsc` 0 · `tsc -p tsconfig.electron.json` 0 · `verify` 0（**188≡188 / 184，无新通道**）·
`verify:docs` 0 · `build` 0 · `vitest` 36 文件 / **644** 用例 · `ae:smoke` **28**（+5）·
`product:smoke` ✅ · `product:xlsx:smoke` ✅ · `goods:ui` 三遍 ALL PASS（进价 4 条新断言）。
