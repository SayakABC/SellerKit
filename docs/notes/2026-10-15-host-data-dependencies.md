# 宿主各功能的数据依赖关系（UI 岛回迁后）

**结论**：UI 岛回迁宿主后，"功能之间串不起来"的风险已不在界面层，而在**主进程的 db 模块 + IPC handler 编排层**。
全仓 35 张表分属 11 个建表文件（10 个业务域 + `db.ts` 的控制表 `sk_schema_migrations`）；跨域读写**只有 3 条合法边**（采集写入、成本同步、拿货带图），
且订单域（`oi_*`）是 fan-in 最高的枢纽。下面给出域清单、模块→通道→表映射、跨域边与风险。

## 1. 数据域清单（db 模块 → 表）

| 域 | db 文件 | 表 |
| -- | -- | -- |
| 产品库 | product-db | pl_products, pl_shop_sku, pl_variants, pl_images, pl_item_images |
| 店铺登记 | shop-accounts-db | sk_shop_sets |
| 公司 | company-db | sk_companies, sk_company_profiles |
| 平台商品 | shop-item-db | pl_shop_items |
| 店铺/店名归一 | shop-db | sk_shops, sk_name_map |
| 邮箱 | mail-db | sk_mail_accounts, sk_mail_messages, sk_mail_bodies, sk_mail_attachments, sk_mail_folders, sk_mail_attachment_cache, sk_mail_meta |
| 速卖通/算钱 | ae-db | ae_cost_map, ae_rates, ae_settle_lines（⚠️ `ae_orders` / `ae_order_lines` / `ae_fees` 三张弃表已于 2026-10-15 随 `ae.main` v3 删除） |
| 拿货 | purchase-db | suppliers, purchase_orders, purchase_items, purchase_sources, payments, purchase_ignore |
| 运价 | ship-rate-db | sr_rate_snapshots |
| 订单识别 | order-db | oi_orders, oi_images, oi_styles, oi_style_colors, oi_style_fingerprints, oi_queue |
| 控制 | db | sk_schema_migrations |

取证：`electron/*.ts` 的 `CREATE TABLE IF NOT EXISTS` 全文抽取，35 张表覆盖上述 11 个建表文件（picking-db 无自建表，复用 order-db）。
⚠️ 本清单**不含** FTS5 虚拟表 `sk_mail_fts` 与真实库里的 5 张 FTS 影子表 / `sqlite_sequence`（口径见 `docs/baseline/PROJECT_BASELINE.md` §「SQLite」）。

## 2. 宿主模块 → IPC 通道 → 数据域（读/写）

| 模块 | 通道数 | 主要消费域 | 关键通道 |
| -- | -- | -- | -- |
| goods（产品库） | 50 | 产品库 D1、平台商品 D4、店铺 D5、拿货厂商 D8、成本 D7 | productList/Upsert/Import、shopItem*、shopProductRelation*、purchaseSupplier*、aeCostMapList、orderImage*、productImage* |
| shop-accounts（店铺/账号/公司/邮箱） | 48 | 店铺登记 D2、公司 D3、邮箱 D6、店铺 D5、成本 D7 | company*、mail*、shopAccount*、shopUpsert、aeCostMapUpsert/DeleteManual、productList、aeRateList |
| today（今天/首页） | 36 | 订单 D10、拿货 D8、运价 D9、成本 D7 | order*、pickingRows、purchase*、shipRateSnapshotCalc、purchaseStyleImages、aeCostMapList |
| order-cost（算钱/利润） | 8 | 成本 D7、汇率 D7、订单 D10、运价 D9、店铺 D5 | aeCostMapList、aeRateList、orderAssignShop、orderShippingRows、settleOrders、shipRateSnapshotCalc、shopDbEnsure、shopList |
| picking（拣货） | 9 | 成本 D7、订单 D10、拿货 D8、店铺 D5 | aeCostMapList、orderImageThumbBatch、pickingRows、purchaseIgnoreList、purchaseOutstanding、settleOrders、shopList |
| quick-note | 0 | — | （独立，无 db 通道） |

取证：`src/modules/<m>/**` 抽取 `import {…} from '…services/ipc'` 与 `ipc.<x>`，按模块去重计数。

## 3. 跨域依赖边（分析核心）

> 域与域之间 SQL 只在各自 `*-db` 内自洽；跨域访问只经三条路径：(a) 主进程编排层直接调别域 db 函数，
> (b) IPC handler 调别域 db 函数，(c) 渲染层经 IPC 把多域结果在界面组合。

**边 A — 采集写入（ae-db ⇒ order-db，跨域写）**
`ae-db.upsertOrderBatch`（ae-db.ts:760）先读 `ae_rates`（:765，原币→CNY 折算），再调 `order-db.upsertCollectedOrder`
写 `oi_orders`。触发方 `ae-receiver.ts:152`。order-db.ts:1579 注释明说："汇率属 ae 域，让 order-db 读别的域就是跨域耦合，
所以由 ae-db 负责折算"。→ 算钱域拥有折算逻辑、落库在订单域。

**边 B — 拿货→成本同步（purchase-db ⇒ ae-db，mandated convergence）**
`purchase-cost-sync.syncPurchaseCosts()` 在每次拿货写操作后置触发（`purchase-handlers.ts:25` 的 `withCostSync` 包裹）。
读 `purchase-db.costSnapshot()`（purchase_orders + purchase_items）→ 写 `ae_cost_map`（source='purchase'，经 `ae-db.costMapReplace`）。
这是 ADR-002 规定的**唯一跨域合流点**。幂等：只清 source='purchase' 再重写，手工价（source='manual'）不受影响。
失败 `try/catch` 不影响落账，但利润缺成本 → 首页卡显示"缺成本 N 行"作可见信号。

**边 C — 拿货带图（purchase-handlers ⇒ order-db，跨域读）**
`purchase-style-images`（purchase-handlers.ts:304）→ `order-db.findStyleColorImagePath`（order-db.ts:934），
读 `oi_styles JOIN oi_style_colors JOIN oi_images`（+ 子查询 oi_orders 按 size 匹配）。
即"拿货单带图/明细图"依赖订单域的识别结果（款色→图）。跨 handler 直接 `require` 另一 db 模块。

**边 D — 订单归属店铺（order ⇒ shop，弱耦合）**
`order-assign-shop`（order-handlers.ts:169）→ `order-db.assignShopToOrders`（order-db.ts:1559）只写 `oi_orders.shop`（**原文**）。
店名归一（shopName.ts 纯函数，零 DB）构建 `sk_name_map`/`sk_shops`，由 shop 模块 `shopMap` 拥有。
oi_orders.shop 与 sk_* 是两套表示，对账靠人工 `shopMap`，非自动。

**边 E — 利润/算账汇聚（多域 ⇒ 渲染层组合）**
`settleOrders`（ae-handlers.ts:166）读 `ae_settle_lines`；`aeCostMapList`（→ae-db.costMapList:1053）读 `ae_cost_map`；
`aeRateList`（→ae-db:1068）读 `ae_rates`；`shipRateSnapshotCalc`（ship-rate-handlers.ts:56）读 `sr_rate_snapshots`。
利润 = ae_cost_map + ae_rates + ae_settle_lines + sr_rate_snapshots + oi_orders.amount，在 order-cost/today 渲染层组合（不在主进程合一）。

**边 F — 识别中枢（oi_* 为单源）**
oi_styles/oi_style_colors/oi_images/oi_style_fingerprints 由订单识别管线（collect + import + VLM）写入，被多模块读：
goods（orderReadImage/productImageAttach）、purchase（purchase-style-images 带图）、today（orderImageThumbBatch 缩略图卡）、order-cost（orderShippingRows/orderStyleList）。款色→图只此一份。

**边 G — 产品主数据（pl_* ↔ 订单/识别）**
goods 拥有 pl_products/pl_shop_sku/pl_variants/pl_images/pl_item_images + pl_shop_items；订单识别挂 style_code 到 oi_styles，
产品库反向维护款色主数据。goods 的 `shopProductRelationAdd` 写 pl_shop_sku，与店铺域 D5 有交叉写入。

## 4. 风险与观察

1. **订单域（oi_*）fan-in 最高**：写方=ae-receiver（经 ae-db），读方=goods/purchase/today/order-cost。
   改 `oi_*` schema 或 `findStyleColorImagePath`/`upsertCollectedOrder` 前，先查这 4 个模块的断言覆盖。
2. **合法跨域边仅 3 条**（A 采集、B 成本同步、C 拿货带图），且 A/B 收在主进程编排/接收层，UI 不参与（符合 ADR-002 C1/C3）。
   ~~C 是 handler 直接 `require` 另一 db 模块——若 `findStyleColorImagePath` 签名变，purchase-handlers 不会即时编译报错（**独立 ts 上下文**），
   建议把 C 也显式登记为受控合流点（与 A/B 同列）。~~
   ⇒ **✅ 2026-10-15 已处置，且原判据里有一处是错的**：`purchase-handlers.ts` **不是**独立 ts 上下文，
   它与 `order-db.ts` 同在 `tsconfig.electron.json` 里（`include: electron/**/*.ts`）——
   真正让签名变更漏过去的是 **`const orderDb = require('./order-db')` 没带 `as typeof import(...)`**（`any`）。
   现已补标注（实测：改 `findStyleColorImagePath` 的 `color: string→number`，改前 `tsc` 退 0、改后报 TS2345），
   并新增守卫 `scripts/check-cross-domain-edges.mjs` 接进 `verify`：**规则 A** 所有 `require('*-db')` 必带类型标注；
   **规则 B** `db→db` 静态 import 边逐条在册（含取用符号）。处置明细见
   `docs/notes/2026-10-15-table-necessity-review.md` §二 P1-4。
3. **`ae_cost_map` 有两条写者**：syncPurchaseCosts（auto, source='purchase'）+ 手工 upsert（shop-accounts/order-cost, source='manual'）。
   costMapReplace 只清 purchase 分支→手工价安全；但"成本数字"有两个真相入口，对账时要先看 source。
4. **店铺身份两套表示**：oi_orders.shop（原文）vs sk_shops/sk_name_map（规范）。自动归属只写原文，规范映射靠人工 shopMap。
   oi_orders.shop 为空不一定是 bug，是还没归——这是"默认值靠语义不靠位置"的活例。
5. **成本同步是 fire-and-forget**（`withCostSync` try/catch）。历史 bug（purchase 有 3 单、cost_map 0 行）根因正是缺自动触发；
   现已补自动触发 + 首页"缺成本"卡，但仍是异步耦合，失败静默（仅日志 + 卡提示）。

## 5. 改前自查清单（给下次动刀用）

- 动 `oi_*`：跑 goods/today/picking/order-cost 四类断言 + `findStyleColorImagePath` 变异。
- 动 `ae_cost_map`：分清 auto/manual 两写者；动 costMapReplace 要看 manual 分支是否被误清。
- 动 `shopName`/`sk_name_map`：影响 order-assign-shop 的归属语义与 shopMap 对账。
- 新增跨域读：先问"能不能收进 A/B/C 之一"，不能就登记为新受控合流点。
  ⚠️ **2026-10-15 起这件事由门禁兜住**：`npm run verify` 的第③条（`scripts/check-cross-domain-edges.mjs`）
  会拦"未登记的 `db→db` 边"与"没带 `as typeof import(...)` 的 `require('*-db')`"；
  在册清单是脚本里的 `DB_EDGES`（含每条边从对方取用的符号），改边**先改清单再改代码**。
