# 产品管理相关表审查（冗余判定与优化改造建议）

> **审查日期**：2026-10-30
> **审查对象**：产品管理链路上的 15 张表 —— `pl_products` / `pl_variants` / `pl_images` / `pl_item_images` / `pl_shop_sku` / `pl_shop_items` / `pl_shop_store_keys` / `pl_bundle_links` / `oi_styles` / `oi_style_colors` / `oi_style_fingerprints` / `oi_variant_keys` / `oi_color_aliases` / `oi_item_parts` / `oi_images`（另有 `oi_order_items` 仅作对照）。
> **方法**：静态通读 + `文件:行` 取证 + **真库只读副本**查询（运行库 `~/Library/Application Support/seller-kit/sellerkit.db` 的 `db` + `-wal` 复制到 `/tmp/skdb/sk.db` 后查；WAL 库直接 `-readonly` 打不开）。**未修改任何表、未跑任何迁移**。
> **对照口径**：`features/PRODUCT_LIBRARY.md`（产品库权威口径）、`notes/2026-10-15-table-necessity-review.md`、`notes/2026-10-28-order-driven-classify-plan.md`、`notes/2026-10-29-db-table-audit.md`。
> **结论性质**：审查 + 分期建议，**不含已实施的改动**。每一条都给了可复现 SQL 或代码位置，没有取证的判断一律不写。

---

## 0. 结论

**没有"整张表都是多余的"表**（这与 `notes/2026-10-29-db-table-audit.md` 的"疑似无用 0"一致），但存在 **1 个表内种群真冗余、1 处字节重复、3 处结构上的"两套真相/无入口"**，以及若干必须清理的数据质量欠账。

| 等级 | 数量 | 内容 |
| --- | --- | --- |
| **A. 真冗余（可退役/可去重）** | 2 | ① `pl_shop_sku` 的**池行种群**（`source='shop-import'` / `shop_id=0`，实库 **0 行**）及其两个专用列；② `pl_images` 与 `oi_images` 对**同一张图**存了两份**字面相同的字节**（12/12） |
| **B. 结构待收紧（不是重复实体，但有第二真相或入口缺失）** | 3 | ③ `oi_styles` 与 `pl_products` 两套款、靠 `code` 字符串锚点；④ 套装 `pl_bundle_links` **写入口零生产调用者** ⇒ `oi_item_parts` 永远为空；⑤ `oi_style_fingerprints`（0 行）已被 `oi_variant_keys` 取代 |
| **C. 正常空态 / 明确保留** | 10 | `pl_products`、`pl_variants`、`pl_item_images`、`pl_shop_items`、`pl_shop_store_keys`、`oi_style_colors`、`oi_variant_keys`、`oi_color_aliases`、`oi_item_parts`（结构不与配置表重复，空是因为没人配，见 §4.2）、`oi_images` |

一句话：**能删的只有"商品清单池"这一支；能省的是图片字节；该改的是"款有两套""套装没人能配"；不该动的是 `pl_variants` / `oi_style_colors` / `pl_item_images`。**

---

## 1. 真库读数（2026-10-30，只读副本）

| 表 | 行数 | 备注 |
| --- | --- | --- |
| `pl_products` | 19 | 主数据权威；11/19 有主图 |
| `pl_variants` | 457 | **23 行孤儿**（`product_id` 指向已删产品 1 与 9802）；120 行有 `code`、341 行有 `weight_g` |
| `pl_images` | 12 | 全部 `source='order-image'` |
| `pl_item_images` | 0 | 手动覆盖图，UI 可达（正常空态） |
| `pl_shop_sku` | 48 | **池行 0**；48/48 是 `source=manual` / `status=confirmed` / `shop_id<>0` 的映射行 |
| `pl_shop_items` | 71 | 采集快照；48 条映射中 21 条能按 `(shop_id,item_id)` 对上采集行 |
| `pl_shop_store_keys` | 4 | 与 `sk_name_map kind='shop'`（11 行）不是同一件事 |
| `pl_bundle_links` | 0 | 套装配置 |
| `oi_styles` | 13 | 12 个 `code` 与 `pl_products` 重叠，1 个 `STYPE-001` 无对应产品；13/13 指纹 = `mapped:<code>` |
| `oi_style_colors` | 86 | 款色主键；`code` 与 `pl_variants.code` **0 重叠** |
| `oi_style_fingerprints` | 0 | 附加指纹 |
| `oi_variant_keys` | 59 | **9 行孤儿**（`style_color_id` 133–141 不存在，`PRAGMA foreign_key_check` 报 9 条） |
| `oi_color_aliases` | 5 | 平台色名 → 自家色名 |
| `oi_item_parts` | 0 | 套装部件（订单行级事实） |
| `oi_images` | 101 | 全部落在 `order-images/` |
| `oi_order_items` | 75 | 对照用 |

---

## 2. 逐表判定

「写/读」给的是生产代码里的入口（不含 `scripts/` 冒烟）。判定只针对**这张表在产品的当前形态**。

| 表 | 行数 | 写 | 读 | 判定 | 依据 |
| --- | --- | --- | --- | --- | --- |
| `pl_products` | 19 | 产品编辑 / 导入 / 批量编辑 | 产品列表、映射、订单、成本 | ✅ 保留（唯一款权威） | `electron/product-db.ts:112`；ADR-002 C1 |
| `pl_variants` | 457 | SKU 子表 / 导入 | 拣货、运费、成本、映射反查 | ✅ 保留（**补删除清理**） | DDL `product-db.ts:1893`；`deleteProduct` 只删主表 `:578` |
| `pl_images` | 12 | 产品图上传 / 订单图采纳 | 款主图、商品图池 | ⚠️ **字节与 `oi_images` 重复** | DDL `product-db.ts:1917`；`landImageBuffer` `product-handlers.ts:520` |
| `pl_item_images` | 0 | 商品覆盖图 | 图池最高优先级 | ✅ 保留（空态） | `useSkuPool.ts:1044`；`product-db.ts:2221` |
| `pl_shop_sku` | 48 | 映射写入 / 池导入 | 归款、队列、套装关系 | ⚠️ **池行种群真冗余**，映射行保留 | DDL `:984`；谓词 `:1121` |
| `pl_shop_items` | 71 | 店铺采集 | 采集列表、认款候选、反查 | ✅ 保留（**勿加 `product_id`**） | DDL `shop-item-db.ts:194`；`productId` 过滤走映射 JOIN `:946` |
| `pl_shop_store_keys` | 4 | 采集收养记忆 | 收养第 4 级证据 | ✅ 保留（低优先合并候选） | DDL `shop-item-db.ts:219`；`sk_name_map` 分工不同 |
| `pl_bundle_links` | 0 | **仅冒烟脚本** | `isBundleProduct` / `resolveBundleParts` | ⚠️ **无生产入口** | `product-db.ts:168`；写函数 `:2503/:2572/:2590` **零调用者** |
| `oi_styles` | 13 | `ensureStyleByCode` 占位、识别落库 | 款列表、归类 | ⚠️ **与 `pl_products` 两套款** | DDL `order-db.ts:473`；`MAPPED_FP_PREFIX` `:2317` |
| `oi_style_colors` | 86 | 归类建色 / 改名 / 合并搬色 | 订单、采购、拣货、映射 | ✅ 保留（款色主键） | DDL `order-db.ts:483` |
| `oi_style_fingerprints` | 0 | 人工归并 / 重分类 | `resolveStyle` 附加指纹 | ⚠️ **可退役候选** | DDL `:494`；识别已由 `oi_variant_keys` 承担 `:337` |
| `oi_variant_keys` | 59 | 归类投影 / 合并 | 归款、重导幂等 | ✅ 保留（**清孤儿**） | DDL `:337`；`rememberVariantBinding` `:1461` |
| `oi_color_aliases` | 5 | 归类时记一次 | 色名翻译 | ✅ 保留 | DDL `:505`；`electron/colorAlias.ts` |
| `oi_item_parts` | 0 | **只有 `materializeItemParts`** | 采购/拣货 UNION、套装键 | ⚠️ 结构保留，**事实永远为空** | DDL `:537`；写入前置 `isBundleProduct` `:5169` |
| `oi_images` | 101 | 订单图落地 / 识别回写 | 归类、图池订单图层 | ✅ 保留（流水线字段） | DDL `:409` |

---

## 3. A 级：两处真冗余

### 3.1 `pl_shop_sku` 的池行种群（`source='shop-import'` / `shop_id=0`）

**判据（三条都成立）**：

1. **实库 0 行**：`SELECT COUNT(*) FROM pl_shop_sku WHERE source='shop-import' OR shop_id=0` = **0**；48 行全为 `manual/confirmed/shop_id<>0`。
2. **唯一消费者是它自己**：`skuPoolSql()`（`product-db.ts:1121`）全仓只被 `electron/shop-product-db.ts` 使用（`:158/:195/:255/:273/:321`）；订单归款、拣货、算钱、队列一律走补集 `skuMappingSql()`（`:1126`）。`GoodsView.vue:214-222` 已把这条判据写在注释里。
3. **入口不可达**：页签开关 `SHOP_PRODUCTS_TAB_ENABLED = false`（`GoodsView.vue:226`），`workbench` 形态下页签表只剩一个（`:267`），所以 `<ShopProductView v-else-if="tab === 'shop-products'">`（`:149`）永不渲染；`api.shopProduct*` 的全部调用者也只有 `ShopProductView.vue`。

**池专属列**：`image_url` / `imported_at`（`product-db.ts:997-998`，老库补列 `:1014`）。读它们的是池列表（`shop-product-db.ts:215-221`），映射侧从不读。

**池概念是否已有替代**：有。`pl_shop_items`（`shop-item-db.ts:194`）是更完整的"店里有什么"快照（标题/价/类目/URL/SKU JSON/原始 JSON），且两个域**明确不互写**（`:192` 注释）。

**建议（P1，整支退役；不是删表）**：

- 删 `src/modules/goods/components/ShopProductView.vue` + `GoodsView.vue` 的页签分支与开关常量 + `shopApi.ts` 中的池适配；
- 删 6 个 IPC（`shop-product-import/list/delete/relations/relation-add/relation-delete`，`shop-product-handlers.ts:45` 起）与 `shop-product-db.ts` 的池方法；
- 删 `SKU_POOL_SOURCE` / `skuPoolSql()`，把映射侧谓词简化为"本表全部是映射行"；
- 池行与 `image_url` / `imported_at` 两列在迁移里清掉（**当前 0 行，零数据风险**；老库若仍有池行需先盘点，见 §7 的预检 SQL）；
- ⚠️ `scripts/schema-migration-smoke.cjs:174/261` 仍在造池行、`scripts/goods-ui-smoke.mjs` 有"页签不在"的反向断言 —— 退役要连冒烟一起改，不能只删 UI。

**收益**：`pl_shop_sku` 从"一表两义"回到单一语义（映射），`skuMappingSql` / `skuPoolSql` 这对手工补集谓词消失，未来不会有人再把池行当映射行读。

**代价 / 风险**：`ShopProductView` 是"要放回来只改一个常量"的回退路径（`GoodsView.vue:146`），退役后这条回退彻底消失；`schema-migration-smoke` 的池行用例要重写成"映射行"用例。**若产品仍想保留"导入商品清单"能力，正确做法是把它接到 `pl_shop_items`（采集快照）而不是复活池行。**

### 3.2 `pl_images` 与 `oi_images` 的重复字节

**取证**：

- `pl_images` 12 行，`fingerprint` **12/12** 也存在于 `oi_images`；
- 12/12 的文件在 `product-images/` 与 `order-images/` **两个目录都存在、大小相同**，抽样 `2047f3…webp` 的 sha1 两边一致；
- `pl_images.source` 12/12 = `order-image`（说明全部由"认款采纳订单图"产生）；
- 两个目录体积：`product-images` 948K、`order-images` 5.8M —— 重复量 ≈ 12 张被采纳图。

**这是"存储重复"，不是"表冗余"**：两张表的字段与生命周期不同（`oi_images` 带 `url_fingerprint`/`status`/`result_json`/`style_color_id` 识别流水线；`pl_images` 只有内容寻址与来源）。**不要合并表**，否则流水线字段会污染产品图仓，或反之。

**为什么当初复制**（`product-db.ts:1836-1839` 注释）：`order-cleanup-orphan-images`（`order-handlers.ts:816`）只扫 `order-images/` 且只认 `oi_images` 的引用 —— 若产品图直接引用订单图文件，订单侧一清理就会删掉款主图。

**两条可选路线**：

| 路线 | 做法 | 风险 |
| --- | --- | --- |
| **R1（推荐，低风险）** 保持复制，修周边两个洞 | ① `backup.ts:89-93` 只备 `order-images/`（**产品图根本不在备份里**）⇒ 把 `product-images/` 一起备、导入时一起还原；② 文档写清"采纳=复制"的代价 | 改备份/还原两段；旧备份没有 `product-images/` 需兼容（缺失即跳过） |
| R2（彻底） 统一一个物理目录 + 一张图仓表 | 清理判据改为"两表引用的并集"，`pl_images.local_path` 可直接指向订单图路径；长期只留一个目录 | 要同时改 `order-cleanup-orphan-images`、备份、读取白名单、迁移 12 条路径；**任一漏改就删图** |

**明确不做**：现在就把 12 条 `pl_images.local_path` 改指向 `order-images/` —— 孤图清理会立刻有机会删掉它们（除非同一提交改完清理判据）。

---

## 4. B 级：三处结构待收紧

### 4.1 两套"款"：`oi_styles` ↔ `pl_products`（靠 `code` 字符串锚点）

**现状**：

- `oi_styles` 只剩 `code` + `fingerprint`（DDL `order-db.ts:473-479`），业务字段（名字/供应商/类目/状态/进价）全在 `pl_products`（`product-db.ts:112`）；
- 13 行里 **12 行 `code` 与 `pl_products` 重叠**，1 行 `STYPE-001` 已无产品；13/13 指纹 = `mapped:<code>`（`ensureStyleByCode` 造占位行，`order-db.ts:2335-2346`）；
- 关联方式 = `oi_styles.code → pl_products.code`（文档见 `features/PRODUCT_LIBRARY.md` §3.2），**库层没有 `product_id` 外键**。

**两个真实缺口**：

1. **改 `code` 会静默断链**：`upsertProduct` 的更新分支把 `code` 一起写回（`product-db.ts:423/428`），既不校验引用，也不同步 `oi_styles.code` / `oi_style_colors.code` / `pl_variants.code`。改完编码后，订单归款、采购 JOIN 会静默"找不到款"，而不是报错。
2. **`oi_styles` 实际仍在增长**：`notes/2026-10-28-order-driven-classify-plan.md` §8.3 写"`oi_styles` 冻结不再新建"，但 `assignOrderStyle` / `autoAssignByMap` 走 `ensureStyleByCode` 时仍会 **INSERT 占位行**（`order-db.ts:2343`）。也就是说"冻结"只对 AI 识别路径成立，**产品库新增一个从未出过订单的款、且被点名归款时，仍会长出 `mapped:` 行**。

**建议（P2，先加锚点再收口）**：

- 第一步：给 `oi_styles` 加 `product_id INTEGER NOT NULL DEFAULT 0`（或挂在 `oi_style_colors` 上，取决于"款色是否跨款"的裁定），按 `code` 回填 12 行；JOIN 改读 id，`code` 只做展示；
- 第二步：`upsertProduct` 在改 `code` 时要么禁止（推荐，编码是跨域锚点，`deleteProduct` 注释已说明），要么在同事务里同步三处 `code`；
- 第三步：清理 `STYPE-001` 这条无主款（确认无 `oi_style_colors` / 订单引用后删）；
- **不要删 `oi_styles`**：它仍是 `oi_style_colors` 的父锚与合并历史的落点（`oi_style_merges`）。

**明确不做**：给 `pl_shop_items` 加 `product_id`。那会变成第二套归属真相，而现有反查已经通过 `pl_shop_sku` 的 JOIN 完成（`shop-item-db.ts:946-949`）。

### 4.2 套装：`pl_bundle_links` 无生产写入口 ⇒ `oi_item_parts` 永远为空

**取证（这条比"0 行"更硬）**：

- `replaceBundleLinks` / `deleteBundleLinks` / `clearBundle`（`product-db.ts:2503/2572/2590`）在全仓**没有任何生产调用者**（`electron/` 除定义处、`src/` 全无；只有 `scripts/*-smoke.cjs` 调用）；
- 没有任何 `bundle-*` IPC（`preload.ts` / `src/core/services/ipc.ts` 均无），产品编辑抽屉也没有套装 UI；
- 因此 `resolveOrderSku` 侧 `isBundleProduct()` 恒为 false（`order-db.ts:5169`），`materializeItemParts` 每次落库都在第一道闸门返回 `notBundle`（`:1860` 调用、`:5169` 判定）；
- `oi_item_parts` 的读取侧**已经接好**：`ITEM_STYLE_COLOR_SRC`（`order-db.ts:4984-4995`）被采购/拣货聚合使用，`bundleKeyOf`（`:5237`）也可用 —— 也就是说**读链路是完整的，唯一缺的是"谁来填配置"**。

**结论**：这不是"两张表重复"（配置 vs 事实本就该分两层），而是**一个半成品功能**：数据层、读链路、冒烟（`scripts/product-sku-smoke.cjs:1663+` 11 处）都有，生产入口为 0。

**建议（P2，产品取舍，二选一）**：

- **做**：补 `bundleLinks` 的读写 IPC + 产品编辑抽屉的"套装部件"区（role / 子产品 / 子色 / 件数）+ 订单核对页展示 `oi_item_parts`。工作量主要在 UI 与冒烟守卫；
- **冻结**：明确写入 `PRODUCT_LIBRARY.md` / 本审查：套装功能暂不开放；`pl_bundle_links` 与 `oi_item_parts` 保留表结构（避免迁移震荡），但**删除零调用者的 3 个写函数与冒烟里的"生产假象"**，并给 `materializeItemParts` 留一行注释说明"当前无配置入口"。

**不建议**：把套装塞进 `pl_shop_sku`（`order-db.ts:3705-3711` 已明确论证：目录事实不该进平台镜像）。

### 4.3 `oi_style_fingerprints`（0 行）：识别路径已被 `oi_variant_keys` 取代

- 表存在、读写代码都在（写入 `order-db.ts:1749/1836/2148`，读取 `:1692/:2142`），但 **0 行**说明从未发生过"人工归并附加指纹"；
- 当前订单归款的落点是 `oi_variant_keys`（`variant_key → style_color_id`，59 行）；`resolveStyle` 的指纹匹配在"订单驱动归类"之后已不是主路径；
- `orderStyleResolve` IPC 有类型定义（`src/core/services/ipc.ts:250`）但**没有任何 renderer 调用者**。

**建议**：**先不动**（它是 0 行、无成本、且有真实写入路径）。在下一轮"识别只认 `oi_variant_keys`"的裁定里，连同 `orderStyleResolve` 通道一起退役；届时删表 + 删 `resolveStyle` 的附加指纹分支。**不要在没有替代方案时先删**——`reclassify` 分支仍会读它。

### 4.4 `pl_shop_store_keys`（4）vs `sk_name_map kind='shop'`（11）——**暂不合并**

前者是"采集帧展示名键 → 已登记店"的**自动收养记忆**（`shop-item-db.ts:219-224`，读在第 4 级证据 `:510`）；后者是**人工决定**的命名映射。两者写入者不同、语义不同。记录为低优先合并候选，等"店铺实体"再收口时一起看。

---

## 5. C 级：明确不是冗余（避免下一轮重复讨论）

| 对比 | 为什么不是冗余 | 取证 |
| --- | --- | --- |
| `pl_variants` vs `oi_style_colors` | 前者是款×色×码的**人工主数据**（克重/成本/编码，457 行）；后者是**款级颜色**的归类主键（86 行）。`code` **0 重叠** | `product-db.ts:1893`；`order-db.ts:483`；SQL 见 §8-④ |
| `pl_item_images` | 商品覆盖图是图池**最高优先级**（人的显式决定）；0 行 = 还没人用过，不是没用 | `product-db.ts:2221`；`useSkuPool.ts:1044` |
| `pl_shop_items` | 采集快照 vs 映射表是两个事实（"店里有什么" / "这个商品归哪个款"）；DDL 注释明确"两套不互写" | `shop-item-db.ts:192-195` |
| `oi_color_aliases` | 平台色名是字符串（`Khaki` / `1..15`），与自家色名无可计算的对应关系，只能人工指认一次 | `order-db.ts:505`；`electron/colorAlias.ts` |
| `oi_item_parts` | 订单行级**事实**，与产品级**配置**（`pl_bundle_links`）分属两层；表里没行 = 不是套装，读取回落单品 | `order-db.ts:537-546` |
| `oi_images` | 识别流水线状态（`status`/`result_json`/`error`/`url_fingerprint`）是产品图仓不具备的 | `order-db.ts:409-421` |
| `pl_shop_sku` 映射行 | 48 行全部在用：归款、队列、套装关系、成本反查 | `product-db.ts:1246/1402/1457` |

---

## 6. 数据质量欠账（与"冗余"分开处理，但同一批改）

| # | 问题 | 实测 | 根因候选 | 建议 |
| --- | --- | --- | --- | --- |
| 1 | `pl_variants` 孤儿 | **23 行**（`product_id=1` 5 行、`9802` 18 行） | `deleteProduct` 只删主表（`product-db.ts:581`），无级联/无清理 | 补"删产品前先清 variants（或禁止删除被引用产品）"，加一次性清理 |
| 2 | `oi_variant_keys` 孤儿 | **9 行**（id 51–67，`style_color_id` 133–141 不存在；`PRAGMA foreign_key_check` 报 9 条） | 表声明 `ON DELETE CASCADE`（`order-db.ts:341`），但库内仍存在 → 写入/重建时 `foreign_keys` 未生效或 id 来自别处 | 删孤儿；把 `foreign_key_check` 加进冒烟门禁 |
| 3 | 款色名质量 | `oi_style_colors` 86 行中 **57 行是裸数字**、**11 行空/未分类** | 平台色号被直接当色名落库；历史归类 | 纳入"色名归一"计划；不阻塞本审查 |
| 4 | 产品图不在备份 | `backup.ts:89-93` 只 `cpSync(order-images)`；导入 `:135-137` 只覆盖 `order-images` | 图片从订单域单独立目录后没跟着进备份 | **P0**：备份/还原加 `product-images`（旧备份缺目录时跳过） |
| 5 | 4 张空态表 | `pl_item_images` / `pl_bundle_links` / `oi_item_parts` / `oi_style_fingerprints` 均为 0 | 前两张"没人用"、后两张"没人配" | 分别对应 §3.1、§4.2、§4.3 的裁定，不要一律当"多余"删 |

---

## 7. 分期改造建议

### P0（零数据风险，建议先做）

1. 删 `pl_variants` 23 条孤儿、`oi_variant_keys` 9 条孤儿；
2. `foreign_key_check` 进 `npm run db:inventory` 或任一冒烟，作为常驻门禁（当前它能直接报出 9 条）；
3. `backup-export` / `backup-import` 覆盖 `product-images/`；
4. `deleteProduct` 增加"存在 variants / 映射 / 订单引用"的处置（清或拒），并在 UI 给出可读文案。

### P1（真冗余退役，一次做完）

5. 「商品清单」池整支退役（§3.1）：UI 组件 + 6 IPC + `shop-product-db.ts` 池方法 + 2 列 + `skuPoolSql/SKU_POOL_SOURCE`；同步改 `schema-migration-smoke.cjs`、`goods-ui-smoke.mjs`；
6. 图片路线先选 **R1**（备份 + 文档），不要再复制新图前先动 `local_path`。

### P2（结构改造，需拍板）

7. `oi_styles` 加 `product_id` 并回填，JOIN 改读 id；`upsertProduct` 禁止改 `code`（或同步三处）；
8. 套装：接 UI 或冻结（§4.2）；
9. `oi_style_fingerprints` + `orderStyleResolve`：随"识别只认 `oi_variant_keys`"的裁定一起退役（§4.3）；
10. `pl_shop_store_keys` 与 `sk_name_map` 合并评估（低优先，§4.4）。

### 明确不做

- 不合并 `pl_images` 与 `oi_images`（字段/生命周期不同）；
- 不合并 `pl_variants` 与 `oi_style_colors`（语义不同、`code` 0 重叠）；
- 不给 `pl_shop_items` 加 `product_id`；
- 不用"删表"解决空态（0 行不等于无用：`pl_item_images` 有 UI 入口、`oi_item_parts` 有读链路）。

---

## 8. 可复现取证 SQL

在 `/tmp/skdb/sk.db`（运行库 `db` + `-wal` 的副本）执行：

```sql
-- ① 行数与池行
SELECT 'pl_products',   COUNT(*) FROM pl_products
UNION ALL SELECT 'pl_variants',   COUNT(*) FROM pl_variants
UNION ALL SELECT 'pl_shop_sku',   COUNT(*) FROM pl_shop_sku
UNION ALL SELECT 'pool_rows',     COUNT(*) FROM pl_shop_sku WHERE source='shop-import' OR shop_id=0
UNION ALL SELECT 'pl_shop_items', COUNT(*) FROM pl_shop_items
UNION ALL SELECT 'pl_images',     COUNT(*) FROM pl_images
UNION ALL SELECT 'oi_styles',     COUNT(*) FROM oi_styles
UNION ALL SELECT 'oi_style_colors', COUNT(*) FROM oi_style_colors
UNION ALL SELECT 'oi_variant_keys', COUNT(*) FROM oi_variant_keys
UNION ALL SELECT 'oi_item_parts', COUNT(*) FROM oi_item_parts;

-- ② 池行/映射行的真实构成
SELECT source, status, shop_id=0 AS shop0, COUNT(*) FROM pl_shop_sku GROUP BY 1,2,3;

-- ③ 图片同指纹（12/12）
SELECT COUNT(*) AS total,
       SUM(CASE WHEN EXISTS(SELECT 1 FROM oi_images o WHERE o.fingerprint=i.fingerprint)
                THEN 1 ELSE 0 END) AS hit
FROM pl_images i;

-- ④ 两套款的重叠 / 款色编码与变体编码不重叠
SELECT (SELECT COUNT(*) FROM oi_styles) AS styles,
       (SELECT COUNT(*) FROM oi_styles s
         WHERE EXISTS(SELECT 1 FROM pl_products p WHERE p.code=s.code)) AS overlap;
SELECT (SELECT COUNT(*) FROM oi_style_colors c
         WHERE EXISTS(SELECT 1 FROM pl_variants v WHERE v.code=c.code)) AS color_variant_overlap;

-- ⑤ 孤儿
SELECT COUNT(*) FROM pl_variants v
 WHERE NOT EXISTS(SELECT 1 FROM pl_products p WHERE p.id=v.product_id);          -- 23
SELECT COUNT(*) FROM oi_variant_keys k
 WHERE NOT EXISTS(SELECT 1 FROM oi_style_colors c WHERE c.id=k.style_color_id);  -- 9
PRAGMA foreign_key_check;                                                         -- 9 条
```

代码侧取证（对应 §3–§4）：

```bash
rg -n "skuPoolSql|SKU_POOL_SOURCE" electron src          # 只被 shop-product-db 使用
rg -n "SHOP_PRODUCTS_TAB_ENABLED" src/modules/goods/GoodsView.vue
rg -n "replaceBundleLinks|deleteBundleLinks|clearBundle" electron src   # 生产 0 调用者
rg -n "orderStyleResolve" src --glob '*.vue'             # 0 调用者
```

---

## 9. 风险与验收

| 改动 | 验收方式 | 变异点（改坏必须红） |
| --- | --- | --- |
| 池行退役 | `npm run goods:smoke`（ascertain 页签不含「商品清单」）；`schema-migration-smoke` 全绿 | 把 `skuMappingSql` 补集判据改成"全表" → 映射 COUNT 断言必须红 |
| 图片进备份 | 新增/改造 `backup` 冒烟：导出后备份目录含 `product-images/`；导入后文件可读 | 删掉 `product-images` 的 `cpSync` → 备份清单断言必须红 |
| 删孤儿 | 跑完 `PRAGMA foreign_key_check` 输出为空 | 只删 `pl_variants` 不删键 → 变体计数断言必须红 |
| `oi_styles.product_id` | 12 行回填后，按 id JOIN 与按 code JOIN 结果一致 | 把 `code` 改一次 → 断言"改码被拒/同步"必须红 |
| 套装冻结或接 UI | 冻结：`oi_item_parts` 恒 0 且 `bundleMaterialize='notBundle'`；接 UI：端到端写读一条 | 删掉 `isBundleProduct` 闸门 → 非套装行被展开，断言必须红 |

文档门禁：本审查稿入库后须跑 `npm run verify:docs`（文件名符合 `YYYY-MM-DD-<slug>` 规则、已被 `docs/README.md` 索引、无悬空链接）。

---

## 10. 附：对一份外部「AI 重构方案」的复核（2026-10-30）

> 背景：用户提供了一份外部提案（产品域 8 表 → 3 表 + 3 张主数据 + 4 个兼容视图 + 12 步迁移）。
> **结论：不建议按它的 DDL / 迁移脚本执行。** 它的"颜色/尺码主数据化"方向可吸收，但必须按本仓库的实际语义重写；其余四处改动会直接弄坏运行时。

### 10.1 事实层先对不上：提案测的不是这个库

| 提案假设 | 本仓库实际 | 后果 |
| --- | --- | --- |
| `pl_style_colors` / `pl_style_sizes` / `pl_style_categories`（EAV 三表） | **不存在**（全仓 0 引用） | 问题 3 是伪问题；3 个兼容视图没有替代对象 |
| `pl_supplier_products`（供应商双写） | **不存在** | 问题 2 是伪问题；`pl_products.supplier_id` 是唯一真相 |
| `pl_products.sku_code` / `hs_code` / `category_path` / `image_url` | `code` / `category` / `image_id`（`cost_cents` 也在主表） | 建表与迁移 SQL 列名全部对不上 |
| `pl_variants.price_cents` / `cost_cents` / `sku_code` / `sort_order` / `enabled` | `code` / `name` / `color` / `size` / `weight_g` / `status` | 同上；且 457 行里 341 行有克重、120 行有编码 |
| `pl_shop_sku.shop_sku_code` | `platform` / `item_id` / `spec` / `qty_per_item` / `status` / `source` | "上架 SKU"与"认款映射"不是一个东西 |
| `pl_shop_items.store_product_id` / `color` / `size` / `price` / `quantity` / `raw_fields` | `item_id` / `title` / `price_text` / `sku_json` / `raw_json` / `store_key` | 迁移 SQL 必报 `no such column` |
| 行数：`pl_products` 18、`pl_variants` 0、`pl_shop_sku` 0、`pl_shop_items` 0、`pl_style_colors` 1 | **19 / 457 / 48 / 71 / 无此表** | 提案的"现状总览"是想象出来的，后续判断全部悬空 |

**一句话**：这份提案在通用数据库范式上是对的，但**没有对着本项目的库读一遍** —— 它列的 5 个"核心问题"里有 2 个（供应商双写、EAV 款色三表）在本仓库根本不存在，真正的痛点表（`oi_styles` / `oi_variant_keys` / `pl_images` / `pl_bundle_links`）一个都没提。

### 10.2 四处会直接弄坏运行时的改动

1. **用视图 `v_oi_style_colors` 替代 `oi_style_colors`（并 `DROP TABLE oi_style_colors`）—— 不可行。**
   实库里有 **5 张表以 `style_color_id` 指向它**：`oi_order_items`、`oi_images`、`oi_variant_keys`、`oi_item_parts`、`purchase_items`（`PRAGMA` 实测）。SQLite 的外键目标必须是**表**，视图不能当 FK 目标；而且视图只有 `(style_code, color)`，**没有稳定 `id`**，订单/采购/识别全部断链。这条与"两套款"的真实痛点沾边，但药方开反了 —— 该做的是给 `oi_style_colors` **加 `product_id`**，不是把它变成视图。
2. **把 `pl_shop_items` 合并进 `pl_shop_sku` —— 会丢掉"店里有、但还没认款"这个状态。**
   实库 71 条采集行、48 条映射行，两者是**两个事实**（采集快照 vs 认款决定，`shop-item-db.ts:192` 注释明确"不互写"）；"待关联队列 / 仅未确认 / 采集候选"全靠 `pl_shop_items`。叠加它把 `product_id` 设成 `NOT NULL` 并加 `UNIQUE(shop_id, variant_id)`，会同时禁掉 **一商品多款（套装）** 与 **`shop_id=0` 未解析店铺**（`skuQueue` 的 `shopUnresolved` 分支）。真实的"双轨"是 `pl_shop_sku` 里的**池行**，该删的是池行（见 §3.1），不是采集快照。
3. **`pl_products` 去掉 `code`、改叫 `style_code` / `sku_code` —— 会拆掉跨域锚点。**
   `code` 被 `oi_styles.code`、`pl_variants.code`、采购/拣货的 JOIN 当字符串锚点用（`features/PRODUCT_LIBRARY.md` §3.2）。改列名不是"改个名字"，是全链路改语义。
4. **`pl_variants` 加 `price_cents` / `cost_cents` 与 `UNIQUE(product_id, color_id, size_id)` —— 造第二套成本真相，且唯一键对 NULL 不生效。**
   成本在本仓库是**单点**：`pl_products.cost_cents`（当前进价）+ 采购快照（历史实付），ADR-002 C1 明确不许两个写入者；再给变体加成本就会立即出现"哪份算利润"的二义。另 SQLite 的 `UNIQUE` 把 `NULL` 视为互不相等 —— `color_id` / `size_id` 可空时，重复变体照样能插进去。

**外加**：它的迁移脚本里有 3 处 `...` 占位、`CAST(si.price * 100)`（实际列叫 `price_text` 且是平台原文）、`si.quantity` / `si.color` / `v.sku_code` 均不存在 —— 直接执行会先报错、再在部分执行后停在半路。

### 10.3 它说对的部分（可吸收，但要重写）

- **颜色 / 尺码主数据化** —— 这是全篇最有价值的一条。本仓库实测：`pl_variants` 457 行但只有 **15 个色名 / 8 个码**，且已经出现同义分裂（`黑色` 121 vs `黑` 8、`红色` 116 vs `红` 8、`白色` 116 vs `白` 8、`灰色` 8 vs `灰` 8、`蓝`/`深蓝`、`灰白`）；平台侧 `oi_style_colors` 86 行里 57 行是**裸数字色号**，而 `oi_color_aliases`（5 行）已经在做"9→红 / 5→深蓝"的人工指认。**主数据 + 别名**正好能同时收口这两件事。
- **价格统一为分** —— 本仓库已经是 `*_cents` 口径；唯一例外是 `pl_shop_items.price_text`（平台原文，**必须保留**，不要 CAST 成 REAL）。
- **产品域该瘦身** —— 方向对，但瘦的应该是"池行 / 死表 / 孤儿"，不是把事实表合并掉。

### 10.4 我建议的方案（测试数据可丢 ⇒ 不做 12 步迁移）

用户已确认数据可丢，因此**外部提案里成本最高的"迁移 + 双写 + 回滚"整段可以直接删掉**：改 DDL → 删库重建 → 跑冒烟。按以下顺序，每步都可独立验收：

| 步骤 | 动作 | 收益 | 主要改动面 |
| --- | --- | --- | --- |
| **S1 删死表 / 死功能** | 删 `oi_style_fingerprints`（0 行）+ `order-style-resolve` 通道与 `resolveStyle` 的附加指纹分支；套装若近期不做 → 删 `pl_bundle_links` + `oi_item_parts` + 5 个零调用者函数；池行退役（§3.1） | 一次去掉 3 张"0 行"表和 1 个半成品功能 | `order-db.ts` / `product-db.ts` / `shop-product-*` / 5 个冒烟 |
| **S2 一套款** | **删 `oi_styles`**，把 `oi_style_colors.style_id` 改成 `product_id REFERENCES pl_products(id)`；`code` 保留唯一；所有 `JOIN oi_styles` 改 `JOIN pl_products` | 彻底消灭"两套款 + `mapped:` 占位行 + 改码断链" | 约 **114 处引用**（`order-db` 83、`purchase-db` 8、`picking-db` 3、`types.ts` 6、UI/纯函数若干）；需同步改冒烟 |
| **S3 颜色 / 尺码主数据** | 新建 `md_colors`（15 色 + 规范化）/ `md_sizes`（8 码）/ `md_color_aliases(alias, color_id, product_id)`；`pl_variants` 加 `color_id` / `size_id`（保留文本列做展示与兜底）；`oi_style_colors` 加 `color_id`；把 `oi_color_aliases` 并进别名表 | 一个色名来源 + UI 色块/排序/同义归一 | 新增 3 表、改 3 张表的 DDL、种子 SQL 很短（15+8 行） |
| **S4 图片** | 先按 §3.2 的 **R1**：`product-images/` 进备份；是否统一目录单独拍板 | 不丢产品图 | `backup.ts` + 冒烟 |
| **S5 重建与门禁** | 删库重建 → `PRAGMA foreign_key_check` 为空 → 跑 `product:smoke` / `style:smoke` / `goods:smoke` / `schema-migration-smoke` | 一次性验证全部结构假设 | 无数据迁移 |

**表数会变成多少（诚实口径）**：15 张 → **约 13 张**（删 `oi_styles` / `oi_style_fingerprints` / `pl_bundle_links` / `oi_item_parts`，`oi_color_aliases` 并入别名表，新增 `md_colors` / `md_sizes` / `md_color_aliases`）。**表数量不是这次改造的指标**：收益是"一套款、一套色名、店铺商品两事实各归其位、没有 0 行死表"，而不是提案里那个 `-62%` 的漂亮数字。

### 10.5 需要拍板的三件事

1. **套装**（`pl_bundle_links` + `oi_item_parts`）：近期不做就**删**（推荐；留着只会让 `materializeItemParts` 永远返回 `notBundle`）；要做就补 IPC + 抽屉 UI。
2. **`oi_styles`**：测试数据可丢 ⇒ **删表、`oi_style_colors` 直接挂 `pl_products`**（推荐，一次到位）；保守版是保留表 + 加 `product_id`（改动约 10 处，但两套款仍在）。
3. **图片**：保留复制 + 只补备份（推荐，最小改动），还是统一目录 + 孤图清理改"两表并集"（彻底但涉及删图判据）。

三项拍板后即可从 **S1** 开始；S1 与 S3 互不依赖，可并行。
