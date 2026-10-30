# 订单归款归色与克重取数 — 简化方案（采集 SKU / 产品 SKU / 订单匹配）

> **状态**：🟡 待拍板（§8 五项）；P0 为阻断性缺陷，建议先行
> **读者**：架构 / 开发者
> **落点**：`electron/product-db.ts` · `electron/order-db.ts` · `src/lib/orderCost.ts` · `src/core/services/skuWeights.ts`
> **前置阅读**：`docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md`、`docs/plans/PRODUCT_SKU_LINKING_PLAN.md`、`docs/notes/2026-10-30-goods-sku-matrix.md`、`docs/decisions/ADR-002-master-data-layer.md`

---

## 0. 一句话结论

两个目标（订单定款定色 / 算钱定克重）的**最小键都是「商品ID」**，而现状把两者都绑定在「款 × 色 × 码」上，多绕两跳：**运费必须等认款、认色、建变体、填克重全部完成才算得出来**。

建议不重构，只做四处加法 + 一处阻断性修复：

| 优先级 | 改动 | 价值 | 复杂度 |
| --- | --- | --- | --- |
| **P0** | `variantUpsert` 的更新分支改「未传即保留」 | 修掉多店铺合并**静默清空 SKU 编码/克重**的真实数据损坏 | 低 |
| **P1** | 克重加第二级键 `(商品ID, 尺码)` | 未认款订单也能算运费；填克重与建档解耦 | 中 |
| **P2** | 单色商品自动定色 | 绝大多数订单不再落「未分类」占位，零误判 | 低 |
| **P3** | 变体级对照 `(平台,店铺,商品ID,颜色,尺码) → variant_id` | 订单精确到码；多店同一组合收敛 | 中（可选） |
| **P4** | 订单 `size` 落库前归一 | 与采集/产品尺码同一空间，拿货聚合不裂行 | 低 |

**不做**：上 VLM 自动归色；为算钱强迫建变体；把克重回退成商品级；自动重建产品 SKU 集合。

---

## 1. 目标与最小键

| 目标 | 现状要求 | 真正最少需要 | 卡点 |
| --- | --- | --- | --- |
| ① 定款 + 定色 | 商品ID → 映射（含 `shop_id`）→ 款；色 = 映射 spec > 订单 color >「未分类」 | 商品ID → 款；色看该商品有几个色 | 店铺归一失败即不命中；多色无判别键 |
| ② 克重 → 运费 | 款编码 + 颜色 + 尺码 → `pl_variants.weight_g` | **商品ID + 尺码** | `resolveWeightG` 单源，认不出款色码直接判「缺克重」 |

口径常量（沿用既有）：运费 = `(国家, 克重)` → 无忧运价表，已在 `src/lib/shipRateQuote.ts`；产品成本仍需款编码（`ae_cost_map`），**这一条不能省**。所以解耦后：**运费不再依赖认款，产品成本仍然依赖**。

---

## 2. 现状（以代码为准）

### 2.1 数据模型

| 层 | 表 / 字段 | 说明 |
| --- | --- | --- |
| 采集事实 | `pl_shop_items.sku_json` | 色×码平面数组 `{color,size,price,imageUrl,weightG?}`；`raw_json` 留平台原文；建表 `shop-item-db.ts:173`；落库 `upsertShopItems` `:607` |
| 关联映射 | `pl_shop_sku` | 键 `(platform, shop_id, item_id, spec, product_id)`；`spec` 只承载颜色；建表 `product-db.ts:847`；写入 `upsertSkuMappings:1496` |
| 产品主数据 | `pl_products` / `pl_variants` | 变体 `color+size` 成对、`code` 全局唯一、`weight_g` 克重权威；建表 `product-db.ts:1656`；`variantUpsert:1749` |
| 订单归属 | `oi_orders` / `oi_images` / `oi_style_colors` / `oi_styles` | 归属落在**图片**：`oi_orders.image_id → oi_images.style_color_id → oi_style_colors(款,色) → oi_styles.code` |

### 2.2 订单归款链路（现状）

| 环节 | 代码 | 行为 |
| --- | --- | --- |
| L0 映射（写时） | `order-db.ts:1305` `autoAssignByMap` | `extractSkuFields(raw_fields)` 取商品ID → `resolveOrderSku`（`product-db.ts:1301`，只认 `confirmed`，带色行优先于 `'*'`）→ `ensureStyleByCode` → 颜色 = 映射 spec > 订单 color > `未分类` → `ensureStyleColor` → `setImageStyleColor` |
| 存量回填 | `order-db.ts:1349` `reassignOrdersByItemIds` | 只回填「未归款」+「挂在占位色 `未分类`」的图；挂真实颜色的不动 |
| L1 指纹 | `resolveStyle` `order-db.ts:759` + `src/lib/styleMatcher.ts` | 品类\|排序特征文本（非图片 hash、非标题），主指纹 + `oi_style_fingerprints` 附加表 |
| L2 VLM | `src/modules/today/classify.ts` `recognizeOrder` | **无自动入口**（`oi_queue` 通道在、渲染层零调用） |

三条短路：`!imageId`（归款落点是图片）、`!itemId`（取不到商品ID）、`!hit`（无确认映射）——全部**静默返回**。

### 2.3 算钱取克重（现状）

```
OrderCostView / TodayView(发货台) / shipRateOps(运费岛)
   → loadSkuWeights()            src/core/services/skuWeights.ts（唯一取数口）
   → resolveWeightG(o, skuWeights)   src/lib/orderCost.ts:175（唯一判定口）
       键 = skuWeightKey(款编码, 色, 码)  → pl_variants.weight_g
   → computeOrderCosts          orderCost.ts:632 内 resolveWeightG(o, skuWeights)
   → quoteOrders / computeFee   shipRateOrders.ts / shipRateQuote.ts
```

判定口与取数口都只有一处（这是既有设计优点，改动必须守住，别在页面里各写一份）。

### 2.4 三个已确认缺陷

**① P0 — 全量提交清字段（数据损坏，已有触发路径）**

```ts
// product-db.ts:1796  id 分支是全量 UPDATE
UPDATE pl_variants SET product_id=?, code=?, name=?, color=?, size=?, weight_g=?, status=? WHERE id=?
// useSkuPool.ts:1055  建款向导重入只传这三样
api.variantUpsert({ id: hit?.id, productId, color, size, weightG })
```

同一款被**第二家店铺**的采集商品再走一次「建档并关联」：既有变体的 `code` 被清成 `''`、`status` 回落默认、`weight_g` 被该店铺矩阵值覆盖（0 即清 0）。命中铁律：**多写入者 + 全量提交 ⇒ 漏传字段 = 静默清空**。

**② P1 — 运费被归款绑架**

`resolveWeightG` 只有一级键（款色码），`shipRateOrders.ts:211` 把原因写成「缺克重（没识别出款色码，或该款 SKU 没维护克重）」——两种完全不同的成因压成一条，且未认款的订单**永远**算不出运费。

**③ P2 — 多色商品无判别键**

订单侧 `color` 导入恒为空串（`importSheet.ts` 落 `color: ''`），同一商品ID 配了多条带色映射时，`resolveOrderSku` 的 `ORDER BY (spec='*') ASC, id ASC` 只会取 id 最小的那条——**颜色不是判出来的，是撞出来的**。

### 2.5 与 2026-10-01 裁定的边界

当年删除 `pl_item_weights` 的理由是**那张表的键太粗（商品级，一个商品一个重量）**，不是「商品ID 不该有克重」。本方案 P1 的键是 **(商品ID, 尺码)**，仍是 SKU 粒度，与该裁定不冲突；`pl_variants.weight_g` 继续是精修后的权威，只降低为「算不出来时的回落」。

---

## 3. 方案

### 3.1 P0 — `variantUpsert` 更新分支：未传即保留

**契约**：只对 `code` / `status` 做「`undefined` = 保留现值，`''` = 显式清空」。`weightG` 维持现状（调用方必须给值；缺失继续抛错，不静默当 0）。

```ts
// product-db.ts variantUpsert，id 分支
const cur = dbGet(...SELECT code, status FROM pl_variants WHERE id=?...);  // 已有查询，扩一列
const code   = input?.code   === undefined ? cur.code   : str(input.code, VARIANT_MAX.code);
const status = input?.status === undefined ? cur.status : normVariantStatus(input.status);
```

**调用方清查**（改前必做）：`grep -rn "variant-upsert" src electron` 逐个确认是否有依赖「不传即清空」的调用点。目前已知：`useSkuPool.createProductFromItem`（要保留）、产品编辑抽屉（全量表单，字段齐全，不受影响）。

**验收**：单测「已有 code/status 的变体，只传 color/size/weightG 再 upsert ⇒ code/status 原样」；变异「把保留改回 `''` ⇒ 该用例必须红」。

### 3.2 P1 — 克重第二级键 `(商品ID, 尺码)`

**表**

```sql
CREATE TABLE IF NOT EXISTS pl_item_sku_weight (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  platform   TEXT    NOT NULL DEFAULT 'ae',
  item_id    TEXT    NOT NULL,
  size       TEXT    NOT NULL DEFAULT '',   -- 归一后的尺码（空串 = 单码/未标）
  weight_g   INTEGER NOT NULL DEFAULT 0,
  source     TEXT    NOT NULL DEFAULT 'manual',  -- manual | snapshot
  updated_at INTEGER NOT NULL DEFAULT 0,
  UNIQUE(platform, item_id, size)
);
```

建表走既有幂等模式（`CREATE TABLE IF NOT EXISTS`，参照 `ensureVariantSchema`），**不改任何现有表**，无需版本迁移。

**写入（两条入口，保守不覆盖）**

| 入口 | 位置 | source | 规则 |
| --- | --- | --- | --- |
| 人工在采集 SKU 矩阵里填克重 | `useSkuPool` 矩阵保存路径 | `manual` | 直接 upsert；**`manual` 永不被 `snapshot` 覆盖** |
| 采集帧里带了 `weightG` | `upsertShopItems`（`normalizeIngestSku` 之后） | `snapshot` | 只补「不存在」或「现有为 snapshot」的行 |

**读取（一把口，不许页面各写）**

`src/core/services/skuWeights.ts` 增 `loadItemWeights(): Promise<Record<string, number>>`，键 `itemWeightKey(itemId, size)`（与 `skuWeightKey` 同风格，`\u0001` 分隔、trim、`weight_g>0` 才进表）。

`resolveWeightG` 改三级：

```ts
resolveWeightG(row, skuWeights, itemWeights?)
  1) skuWeightKey(styleCode, color, size)  → 命中：level='sku'
  2) itemWeightKey(itemId, size)           → 命中：level='item'
  3) null                                   → 调用方照旧标缺克重（不猜、不套别的款）
```

调用方补 `itemId`：`computeOrderCosts` 已有 `ex.itemId`（`orderCost.ts:642`），传 `{ ...o, itemId: ex.itemId }`；`shipRateOps.ts:180`、`TodayView.vue:442` 同改。

**展示**：`OrderCostRow` 增 `weightLevel: 'sku' | 'item' | ''`，克重格 `title` 标来源（照 `rateVersion` 先例：「用哪份」必须看得见）。

**验收**：三条用例——款色码命中（数字不变）、仅商品ID+码命中、两者都没有 → `noWeight`；变异「把第二级删掉 ⇒ 未认款用例必红」。

### 3.3 P2 — 单色商品自动定色

**判据**：该 `(shop_id, item_id)` 的采集 `sku_json` 里，**distinct 颜色（trim 去空后）恰好 1 个** ⇒ 订单颜色就是它。多色或零采集行 → 维持现状。

```ts
// order-db.ts autoAssignByMap，颜色决策处
const color = mapped && mapped !== '*'
  ? mapped
  : (rec.color ?? '').trim()
    || singleColorOfItem(rec.shop, itemId)   // 新增：长度===1 返回它，否则 ''
    || MAPPED_FALLBACK_COLOR;
```

`singleColorOfItem` 放 `shop-item-db.ts`（读该行 `sku_json` 并 parse，不复用渲染层 `skuMatrix`）；返回 `''` 表示判不出，**不返回第一个色**（禁止「不存在就回落第一个」）。

**性能**：每条订单一次 SELECT（`UNIQUE(shop_id, store_key, item_id)` 可命中）。导入批量时若成瓶颈，再加一次导入内的 `itemId → color` Map 缓存，先不做。

**验收**：单色命中 / 多色不命中（落「未分类」）/ 无采集行不命中；变异「把 `=== 1` 改成 `>= 1` ⇒ 多色用例必红」。

### 3.4 P3 — 变体级对照（可选，P1/P2 之后再评估）

```sql
CREATE TABLE IF NOT EXISTS pl_shop_variant (
  platform TEXT, shop_id INTEGER, item_id TEXT,
  color TEXT, size TEXT, variant_id INTEGER NOT NULL, confirmed_at INTEGER,
  UNIQUE(platform, shop_id, item_id, color, size)
);
```

填充时机：认款 / 建款向导时按**归一后**的 `(color, size)` 匹配 `pl_variants`，匹配不上留空（不自动建变体）。收益：订单能精确到码（拣货、SKU 级成本）；多店同一组合收敛到同一 variant。

**先不做它的理由**：订单 `color` 导入恒空，P2 上线前能判出「色+码」的订单是少数。等 P2 跑一段、用真实命中率说话。

### 3.5 P4 — 订单 `size` 落库前归一

`normalizeSkuSize` 目前只在主进程（`electron/aeMoney.ts`），渲染层**不得**为它跨层引用。因此归一放在主进程写入口：

- `insertOrder` 落库前：`size = normalizeSkuSize(raw size)`；
- `updateOrder` 若允许改 size，同一条规则；
- `raw_fields` 保留平台原文（原文保真不丢），显示与聚合用归一值。

**边界**：这只对「平台事实」入口生效；人工在界面上改尺码的入口不归一（沿用既有的两条入口分叉纪律：采集剥、人工原样）。

**验收**：`XL 60-65kg` 落库为 `XL`，`raw_fields.size` 仍为原文；单测 + 变异（去掉归一 ⇒ 断言红）。

### 3.6 后置（不在本期）— 映射键去掉 `shop_id`

`pl_shop_sku` 的唯一键含 `shop_id`，使「店铺文本认不出」成为一个静默 fail 点。同一商品ID 跨店铺本就是同一件货，可让 `item_id` 做主键、`shop_id` 只做冲突提示（同一 item 在不同店铺指向不同产品时报警）。需要重建唯一键 + 迁移 + 冲突人工裁决，风险高于前四项，单独立项。

---

## 4. 迁移、兼容、回滚

| 项 | 做法 |
| --- | --- |
| 新表 | `CREATE TABLE IF NOT EXISTS`；零历史数据依赖，无版本迁移 |
| 回填（可选） | 从 `pl_shop_items.sku_json` 抽 `weightG>0` 的行灌 `pl_item_sku_weight`（source=`snapshot`）；**不做也成立**，缺的只是覆盖率 |
| 现有表 | P0 只改 UPDATE 语义（无 DDL）；P4 只改写入值（无 DDL） |
| 回滚 | P1：把 `resolveWeightG` 第二级摘掉、新表闲置即可；P2：删 `singleColorOfItem` 那一行；P0：语义回退需评审（回退=恢复静默清空，不建议） |
| 数据修复 | P0 上线前，用一条只读 SQL 列出**已被清空 code 的变体**（`code='' AND 曾经有 code` 不可考，改查「同款下存在映射/product 但 code 为空」）——无法自动复原，只能列出让人补 |

---

## 5. 门禁与变异清单

逐条单看退出码，不合并：

```
npx tsc -p tsconfig.electron.json
npx vue-tsc --noEmit
npm run verify
npm run verify:docs
npm run build
npx vitest run            # 全量约 130s ⇒ run_in_background
npm run goods:ui
npm run today:ui
npm run order-profit:ui
npm run shipping-rate:ui
?  DB 冒烟：改主进程后先 tsc 再跑（读 dist/electron）
```

**变异清单**（每条新断言必须能变红，跑完变异必须 `npm run build` 再跑最终门禁）：

| # | 变异 | 期望变红 |
| --- | --- | --- |
| M0 | P0 保留逻辑改回 `''` | `variantUpsert` 保留用例 |
| M1 | 删掉 `resolveWeightG` 第二级 | 未认款算运费用例 |
| M2 | `itemWeightKey` 忽略 size（只用 itemId） | 同商品不同码克重用例 |
| M3 | P2 `=== 1` 改 `>= 1` | 多色不命中用例 |
| M4 | P4 去掉归一 | 尺码归一用例 |

---

## 6. 分期

| 期 | 内容 | 验收 |
| --- | --- | --- |
| **S0** | P0 + 调用方清查 + 数据体检 SQL | 单测绿、变异 M0 红过、无回归 |
| **S1** | P1 表 + 写入两条入口 + 读取三级 + 展示 | 未认款订单能出运费；`noWeight` 计数下降；M1/M2 红过 |
| **S2** | P2 单色定色 | 「未分类」占位订单数下降；M3 红过 |
| **S3** | P4 订单 size 归一 | 拿货聚合不裂行；M4 红过 |
| **S4（可选）** | P3 变体级对照 | 真实命中率数据说话后再做 |

---

## 7. 明确不做

- 不为定色上 VLM：VLM 给「看起来像什么色」，给不出「这一单是哪个色」；多色真正的判别信息是图，图记忆已存在。
- 不为算钱强迫建变体：克重是算钱的输入，不该反过来要求产品主数据先建全。
- 不把克重回退成商品级：2026-10-01 否的是「一个商品一个重量」，不是「商品ID 不能有克重」。
- 不让采集自动建/删产品变体：多写入者 + 全量提交 ⇒ 静默清空；采集有、产品无只提示。
- 不把平台原文当产品 SKU 名：两套命名空间，混一次永久脏。

---

## 8. 待拍板

| # | 问题 | 建议 |
| --- | --- | --- |
| A1 | P0 用「未传即保留」还是「向导补传 code/status」 | 选前者：主进程侧防御，未来调用方不会再踩 |
| A2 | `(商品ID, 尺码)` 克重由谁填 | 采集矩阵里按码填（一次填一个商品全部码），与建档解耦 |
| A3 | 同款不同店铺克重不同时以谁为准 | `manual` 优先，`snapshot` 只补空；冲突时界面提示、不自动改 |
| A4 | P2 单色判据是否包含 `Picture color` 这类占位 | **包含**：只有一个色就是唯一解，占位名也是这个商品的唯一色 |
| A5 | P4 是否同时归一历史订单 | 建议不回fill：历史订单的 `size` 参与聚合会产生「改判」，先只对新导入生效 |
