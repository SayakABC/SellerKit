# 克重取数拉全：产品分页 + SKU 分批（修掉 500 款上限）

**结论**：`loadSkuWeights()`（`src/core/services/skuWeights.ts`，全应用唯一的克重取数口）必须**拉全产品库**：

- 产品走分页：`product-list` 单页上限 500（`electron/product-db.ts` 的 `MAX_LIST_LIMIT`），按 `offset` 翻页，
  `total` 到齐或遇到短页/空页即停；
- SKU 走分批：`product-variant-list` 单次最多 5000 个产品 id（`electron/product-handlers.ts` 的 `MAX_WEIGHT_QUERY`），
  按 ≤5000 切成多批，合并后再交给 `buildSkuWeightIndex`；
- **任何一页/一批读失败 → 返回空表**，不返回"半个表"。半个表会让**其实有克重**的行被误报成缺口，
  用户会去补已经填好的数；空表则整体表现为"缺克重"，指向读失败而不是数据没维护（与既有契约一致）。

**为什么现在修**：A7（2026-10-21）的真实库对照暴露，原实现只取产品列表前 500 款 ⇒ 第 501 款起的订单行
`weightSource` 静默变成 `none`（"缺克重"），看起来像数据没维护，且没有任何报错。阶段 B/C 已完成但没顺手改这一处。

**取证**：

- 改前：`loadSkuWeights()` 只有一次 `ipc.productList({ limit: 500 })`，注释还把这个上限写在契约里。
- 改后实现与 `shipRateOps.quoteProducts`（`src/core/services/shipRateOps.ts:210-236`）同一套翻页/分批写法，
  不再出现第二套取数口径。
- 用例 `tests/skuWeights.spec.ts`（4 条，`vi.mock('@/core/services/ipc')` 替掉取数）：
  ① 620 款时第 2 页（`offset=500`）的款也能查到克重；② 5200 款时 SKU 按 `[5000, 200]` 两批取；
  ③ 产品第 2 页失败 → `{}` 且一次 SKU 都不取；④ SKU 第 2 批失败 → `{}`。
- 变异验证：在分页循环里加一句无条件 `break`（模拟"只取第一页"）⇒ 3 条变红；移除后 4 条全绿。
- 冒烟：`shipping-rate:ui`（`loadSkuWeights` 的消费方之一）的假桥改成**照真宿主分页**、`productVariantList`
  按 `productIds` 过滤，宽/窄两遍全 PASS；`order-profit:ui`、`today:ui` 全 PASS。

**两个容易踩的签名差异**：

- 假桥（`window.electronAPI`）的 `productVariantList` 收 `{ productIds }`（preload 载荷），
  而 `core/services/ipc.ts` 的包装函数收**裸数组**。写桩时按前者，写业务调用时按后者。
- 假桥若忽略 `offset/limit` 直接回全量，会把"分页漏页"掩护成绿的 —— 夹具要连分页结构一起复刻
  （本次已把 `scripts/shipping-rate-ui-smoke.mjs` 的桩改成真分页）。

**执行结果（2026-10-22）**：`tsc -p tsconfig.electron.json` / `vue-tsc --noEmit` / `eslint`（改动文件 0 error）/
`vitest run` 43 文件 827 用例 / `shipping-rate:ui` / `order-profit:ui` / `today:ui` 全绿。
计划风险行已改为"已修"，见 `docs/plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md` §7。
