# 全新库点「店铺商品」报 `no such table: sk_shops` —— 一条没有守卫的 LEFT JOIN

2026-10-15 · ✅ **当日已修**（落库层共用 `ensureSchema()`，见 §修复）· 顺带记录一个"错误横幅跨段共享"的小卫生问题（未修）

## 现象

**全新 userData**（从未登记过店铺、从未导过订单）跑起来，点「货与成本 › 店铺商品」段，
列表区直接显示原始 SQLite 报错 `no such table: sk_shops`。同一页的「待关联队列」「已建立映射」
两段都正常 —— 看起来像"这一页一半坏了一半好的"。

发现于 2026-10-15 的隔离实例端到端取证（做「采集入库广播」的真机验证时顺手撞上的
**既有缺陷**，与本轮广播改动无关）。

## 根因

`electron/shop-item-db.ts` 的两处读路径有**无守卫**的 `LEFT JOIN sk_shops`：

- `listShopItems`（`:427`）——「店铺商品」列表主查询；
- `getShopItemRow`（`:452`）——图片下载回填的单行读取。

而 `electron/shop-item-handlers.ts` 的 `shop-items-list` / `shop-items-summary` 开头只调
`ensureShopItemSchema()`（建 `pl_shop_items`），**不建 `sk_shops`**（那是店铺域 `ensureShopSchema`
的事，只在 `electron/shop-handlers.ts` 各 handler 里调用）。全新库首跑若第一站就是「店铺商品」段，
店铺域从未被初始化 ⇒ JOIN 一个不存在的表 ⇒ 报错。

**仓内已有两条成熟先例，每一条都能挡住它**：

| 先例 | 位置 | 形态 |
| --- | --- | --- |
| 读侧降级守卫 | `electron/shop-product-db.ts:67/92/199`、`electron/product-db.ts:970/995`（`shopLabelMap`/`productLabelMap`） | `if (!tableExists('sk_shops')) return 空表/0` —— "店铺名只是展示列，域未初始化时降级而非报错" |
| 页级显式引导 | `OrderCostView.vue:1100` / `PickingView.vue:914` | `await ipc.shopDbEnsure()` 再读（try/catch 包住，"店铺域不可用不影响本页主流程"） |

**为什么同一页另外两段没事**：队列段 `skuQueue` 的 SQL 不碰 `sk_shops`；映射段
`listSkuMappings`/`skuMapSummary` 走 `shopLabelMap()`（已守卫）。

**为什么"采集"看起来是好的**：`matchShopByStore`（`shop-item-db.ts:186/193/197`）只在
**有证据时**才查 `sk_shops`（pin / 归一 URL / storeId 任一非空）；扩展帧 `store:{}` 时全空 ⇒
跳过查询 ⇒ ingest 照常 200。于是症状是"**能采、不能看**"，更容易被当成显示 bug 查偏。

## 复现（隔离实例）

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . \
  --user-data-dir=/tmp/sk-fresh --no-sandbox --disable-gpu --remote-debugging-port=9224
# CDP 驱动：进「货与成本」→ 点「店铺商品」段 → 面板出现 no such table: sk_shops
# 反证：先 await window.electronAPI.shopDbEnsure() 再重拉 → 正常空态（读链本身没问题）
```

## 修复（✅ 当日已做 —— 第三条路：落库层共用 `ensureSchema()`）

上面两条"先例"之外选了第三条路：在 `shop-item-db.ts` 加一个**本文件所有入口共用的**
`ensureSchema()` = `ensureShopItemSchema()` + **import 店铺域的 `ensureShopSchema()`**
（表由 owner 建、DDL 只留一份，不自己抄建表语句；同款先例 `shop-product-db.ts` 顺带
ensure product/sku），7 个入口（列表 / 汇总 / upsert / 手贴 / 单行读 / 设图 / adopt）统一走它。

为什么不是上面两条：

- 选项 1（页级 `shopDbEnsure()`）只保护「进这一页」这一条入口 —— `getShopItemRow` 的图片回填等
  非页面入口照炸；本域读链的完整性不该由调用方页面负责。
- 选项 2（逐处 `tableExists` 守卫）要改 N 处 JOIN 并跟着调用方，面最大；本缺陷的正解是
  "把表建出来"，不是"每条查询自己兜底"。

守卫与取证：

- `npm run shop-item:smoke` 新增全新库段 3 例（DROP `sk_shops`/`sk_name_map` 后：列表回 0 且
  `sqlite_master` 证明表被重建 · 有店铺证据的 ingest 照常落库 · 单行读照常返回）；
  `npm run ipc:shape:smoke` ⑩ 末段同款全新库腿（通道层不可造出 `no such table`）；
- **变异复核**：新用例先在**修前的 dist** 上跑 —— 3 例红且报的正是 `no such table: sk_shops`，重建后全绿。
- 跨域边登记更新：`check-cross-domain-edges.mjs` 的 `shop-item-db.ts → ./shop-db` 符号
  +`ensureShopSchema`（verify 会逐条比符号）。
- 真机（隔离新库）：点「店铺商品」段 = 友好空态，`errorText` 为 null（改前是原始 SQLite 报错）。

## 相邻发现：「错误横幅」是跨段共享的

`useSkuPool` 的 `error` ref 是**一个**，渲染在 `PoolPane.vue:79` 的面板顶部（不分段）；
而 `watch(sub)`（`useSkuPool.ts:419`）只处理 `'queue'` / `'items'` 两段 —— 切到「已建立映射」
段不会触发任何重拉，因此 items 段的旧错误**原样挂着**，看起来像映射段也坏了。
（本次端到端第一轮差点据此误判"两段都失败"。）修不修同样留待拍板；若修，最小口径 = 切段时清
`error.value`。

## 关联

- 发现现场：`2026-10-15-ae-items-ingested-broadcast.md`（该文的隔离实例取证法可原样复用，
  全新库先 `shopDbEnsure()` 引导这一步即来自本缺陷）。
- `docs/notes/2026-10-14-shop-accounts-intake.md`（店铺域回收内建，`sk_shops` 读写归一到
  goods 域 `shopApi`）。
- 同轮另两条：`2026-10-15-shop-items-list-tristate.md`（列表空白的真因 = preload 三态压 0）·
  `2026-10-15-shop-item-partial-frame-merge.md`（采集帧只覆盖非空）。
