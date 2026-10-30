# 产品 / 订单模型简化方案（2026-10-30）

> **状态**：🟢 **D1–D18 与 Q6 全部确认**；**R0（拆行器 + 清库）已完成并全绿（2026-10-30）**，下一步 R1（= S0a 主数据）。
> **读者**：架构 / 开发者 / 产品
> **起因**（用户口径）：一个很简单的功能却铺了十几张表，数据维护不好、结构不清晰；解析订单 Excel 定不了款和色；在产品管理里维护 SKU 的时间成本太高。
> **前置**：[`reviews/PRODUCT_TABLES_REVIEW_2026-10-30.md`](../reviews/PRODUCT_TABLES_REVIEW_2026-10-30.md)、[`notes/2026-10-28-order-driven-classify-plan.md`](../notes/2026-10-28-order-driven-classify-plan.md)、[`plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md`](ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md)、`docs/decisions/ADR-002-master-data-layer.md`（C1）
> **性质**：设计方案 + 分期；R0 已落地（拆行器 / 订单行幂等键 / 清库脚本），R1 起按 §10 继续。
>
> ⚠️ **2026-10-30 重大订正（用户纠错）**：本文 §4 原先以 `(店铺, 商品ID, Color 原文)` 为精确键、并以
> `spec='*'` 作单色 listing 回落 —— **两条都作废**。订单 Excel 里同一 item 下的不同商品可能复用同一
> `Color` 原文，**`(店铺, 商品ID, 订单图片)` 才是 SKU 级身份**；`spec='*'` 回落会把一个 listing 的多个色
> 静默并成一个款色，**不能保留**。新的键与回落规则见
> [`plans/FEATURE_DECOMPOSITION_2026-10-30.md`](FEATURE_DECOMPOSITION_2026-10-30.md) 的 D1–D5；
> D1–D5 已于 2026-10-30 确认（D2 原文入键 / D3 改 `pl_shop_sku` / D4 `spec` 退役）；
> S0a（主数据）仍待 D14–D18，确认前不动代码。

---

## 0. 一句话

订单 Excel 已经带齐了归类需要的全部信息（店铺名 / 产品ID / `产品属性:Color` / `Size`）。现在定不了款和色，**不是信息不够，是信息没有落在能直接查的键上**：

> 把"款色"从三张表里的一层投影，降级为**映射行上的一个色值**；把 SKU 从"建档前置条件"，降级为**按需出现的克重附件**。

---

## 1. 根因（三条，都有真库读数）

| # | 根因 | 取证 |
| --- | --- | --- |
| 1 | **映射键没有 SKU 身份**。`resolveOrderSku` 只按 `(店铺, 商品ID)` 匹配，返回**单一** product+spec；键里的 `spec` 还是"我方色名"（输出），不是"平台色原文"或"图片"（输入） | `product-db.ts:1499-1551`；真库 48 条映射中 **46 条 `spec='*'`**，只有 2 条带色；`(店铺,商品ID,图片)` 58 组 ⇔ `(店铺,商品ID,Color)` 58 组（排除 2 条空色脏行） |
| 2 | **一个"款色"被投影成三张表**：`oi_styles`（13 行空壳）→ `oi_style_colors`（86 行）→ `oi_variant_keys`（59 行记忆） | `order-db.ts:473/483/337`；`oi_styles` 13 行全为 `mapped:<code>` 占位 |
| 3 | **SKU 是建档前置条件**：457 行手工矩阵，但订单真正出现的 `(店铺,商品,色)` 只有 **59** 个键、**10** 个 listing | `pl_variants=457`；`COUNT(DISTINCT variant_key)=59`；`pl_shop_sku` 覆盖 48 行 |

**维护面 vs 真实决策量**（真库 2026-10-30）：

```
维护面（5 表）= pl_products 19 + pl_variants 457 + pl_shop_sku 48
               + oi_styles 13 + oi_style_colors 86            = 623 行
真正需要人决定的 = 10 个 listing 的款名 + 59 个 (listing,色) 的色名 ≈ 69 次
```

→ **96% 的维护行不是"业务事实"，是为了让归类链路能跑而长出来的中间物。** 这就是"表多、数据反而维护不好"的来源。

---

## 2. 目标与原则

**目标**：导入订单后，**款和色一次查表就定**；产品页**不需要先建 SKU**；表结构一屏能讲清。

四条原则（都对应本仓库已有的裁定）：

1. **一个事实一张表**：款在 `pl_products`；色在字典；"哪个 listing 是这个款/这个色"只在**一张映射表**里。
2. **一个键只决定一次**：`(店铺, 商品ID, 图片)`（`Color` 原文只做消歧）—— 认一次，历史与未来同键的订单全部复用（口径订正见 [`FEATURE_DECOMPOSITION_2026-10-30.md`](FEATURE_DECOMPOSITION_2026-10-30.md) D1–D5）。
3. **派生不存储**：款色展示由 JOIN 派生，不建占位款、不建占位色。
4. **SKU 按需出现**：克重有"款默认值"兜底；只有要单独区分时才建 SKU 行。

---

## 3. 目标模型（15 张 → 10 张：6 张业务表 + 4 张主数据表）

> **2026-10-30 第二轮订正**（用户口径）：图片全项目只维护**一张表**，业务表只存 `image_id`；
> 颜色、尺码也各维护**一张主数据表**，其他表只存 `color_id` / `size_id`。旧版"`pl_images` 与
> `oi_images` 都保留"的方案作废（它正是"同一张图有的能显示、有的不能显示"的结构原因）。

### 3.1 保留 / 改造

| 表 | 职责 | 改动 |
| --- | --- | --- |
| `pl_products` | 款（唯一权威） | 加 `default_weight_g`（款默认克重）；`code` 不动 |
| `pl_variants` | SKU（色×码，含克重/编码） | **稀疏**：只建真正用到的组合；`color` / `size` / `name` 文本列退役，改 `color_id` / `size_id`；`UNIQUE(product_id, color_id, size_id)`；`weight_g` 可空（回落款默认） |
| `pl_shop_sku` | **唯一认款表**：`(店铺, 商品ID, 图片) → 产品 + 颜色` | 加 `image_id` / `color_raw` / `color_id`；`spec` 退役；删池行与 `image_url` / `imported_at`；`UNIQUE(shop_id, item_id, image_id, color_raw)` |
| `pl_shop_items` | 采集快照（"店里有什么"） | 保留；**不加 `product_id`**；补 `image_id`（采集图也落地，不再只存远程 URL） |
| `oi_order_items` | 订单行（含归款结果与快照） | 保留 `image_id` / `style_color_id` / `variant_key`；`color` 保留**平台原文**（证据），我方色经 `style_color_id` 取 |
| `oi_style_colors` | **款色**（聚合与采购的粒度） | `style_id` 改 `product_id REFERENCES pl_products(id)`；`color` 文本改 `color_id REFERENCES md_colors(id)`；`UNIQUE(product_id, color_id)`；`code` 仍全局唯一 |
| `md_images` | **全项目唯一图片仓**（内容寻址） | **新增**（合并 `pl_images` + `oi_images` + `pl_item_images`）；`fingerprint UNIQUE`、`url_fingerprint`（普通索引）、`local_path`、`source_url`、`source`；文件统一落 `userData/images/`，进备份 |
| `md_colors` | 颜色主数据 | **新增**；`name UNIQUE`、`hex`、`sort_order`、`status`；种子来自现有 15 种色 + `src/lib/colorSwatch.ts` |
| `md_sizes` | 尺码主数据 | **新增**；`name UNIQUE`、`sort_order`、`size_group`（`S-5XL` 等一键套用） |
| `md_color_aliases` | 平台色 / 别名 → 颜色主数据 | 由 `oi_color_aliases`（5 行）并入；`(product_id, alias_key)` 唯一；`product_id = 0` 表示全局别名 |

**图片归属放在哪**：`md_images` 只存**文件身份**（这一张图是什么字节），不存"这张图属于哪个 listing 的哪一色"。
归属写在 `pl_shop_sku`（`shop_id, item_id, image_id, color_raw`）——理由见
[`FEATURE_DECOMPOSITION_2026-10-30.md`](FEATURE_DECOMPOSITION_2026-10-30.md) §4.3：同一张图可以被多个
listing 复用（同款不同链接、或商品主图被多个色共用），把款/色写死在图片行上，第二个 listing 会读到第一个的结论。

### 3.2 删除 / 合并（本方案的目标状态）

| 表 | 理由 |
| --- | --- |
| `oi_styles` | 只剩 `code`+`fingerprint`；12/13 行与 `pl_products` 同码。它的"款"身份由 `pl_products` 承担，"款色"由 `oi_style_colors.product_id` 承担 |
| `oi_variant_keys` | 59 行"识别记忆"；键改为 `(店铺,商品,图片)` 后不再需要（`named/merged` 两个状态改记在映射行上） |
| `oi_style_fingerprints` | 0 行；指纹识别不是主路径 |
| `oi_color_aliases` | 并入 `md_color_aliases` |
| `pl_bundle_links` / `oi_item_parts` | 写入口零生产调用者（见审查稿 §4.2）；近期不做套装就删 |
| `pl_shop_store_keys` | 4 行；店铺归一统一走 `sk_name_map`（低优先，可最后删） |
| `pl_images` / `oi_images` / `pl_item_images` | **合并进 `md_images`**：当前 12/12 张产品图与订单图同指纹**双份字节**；两套 id 曾在生产上撞车（`order-image-land.ts` 记录的 P0）；只有 `order-images/` 进备份，`product-images/` 不在备份里 —— "同一张图有的能显示有的不能显示"正是这三条造成的 |

> `oi_images` 的识别流水线字段（`status` / `result_json` / `error` / `style_color_id`）**不搬进 `md_images`**。
> 云端视觉识别已于 2026-10-28 整条删除；若确认还要保留"特征匹配"（`features`），单开
> `oi_image_recognition(image_id PK, status, result_json, error, updated_at)`，不要把订单域字段塞进主数据表。

> 表数不是目标；**"一个款色只在一处、一次决定只落一行、一张图只落一份字节"** 才是。按上表收敛后，归类链路只剩 `映射 → 订单行` 一跳。

---

## 4. 订单解析流程（这是解决"定不了款和色"的核心）

> ⚠️ **本节已于 2026-10-30 按用户纠错重写**。旧版本把 `(店铺, 商品ID, Color 原文)` 当精确键、把
> `spec='*'` 当单色 listing 回落，**两条都作废**（原因见文首订正框）。

### 4.1 键

```text
k = (norm(店铺名), norm(商品ID), 图片身份)          ← 主键（SKU 级）
    图片身份 = SHA-256 内容指纹（首选） / 归一 URL（图未落地时的临时键）
次键：Color 原文（只用于同一图片被多个 SKU 复用时的消歧，永不单独当身份）
```

- `产品属性:Color` 原值（如 `1` / `5` / `Khaki`）**只当证据与次级键，永不当色名**（`electron/variantKey.ts` 的两条纪律）。
- 色名（给人看的）来自映射行 → `md_colors.name`。

**真库反证（2026-10-30）**：排除 2 条空色脏行后，73 行订单里
`(店铺, 商品ID, 图片)` 58 组 ⇔ `(店铺, 商品ID, Color)` 58 组，图片 → 多色 **0**、色 → 多图 **0**。
即干净数据上图就是 SKU 级身份；而 `Color:1` 同时出现在 7 个 listing，证明原文不能单独当键。

### 4.2 解析（一次索引查询 + 无命中即待认）

```text
resolve(shop, itemId, imageKey, colorRaw):
  1) 精确命中 (shop_id, item_id, image_key, color_raw)        → product_id + 我方色名
  2) 该图唯一命中 (shop_id, item_id, image_key)                → product_id + 我方色名
  3) 图片被多个 SKU 复用、且 colorRaw 也撞                     → 待认（不猜）
  4) 该 listing 从未认过                                       → 待认款
  5) 该 listing 已认款、这一图没认过                             → 待认色
```

- **禁止** `spec='*'` / "单色 listing 捷径" 一类的静默回落：一个 listing 多个色时，它必然把多个色并成一个款色。
- 命中的定义是**图片键命中 + 状态为 `confirmed`**；`pending` 映射只展示、不参与解析。
- 命中即写 `oi_order_items.style_color_id`（`ensureStyleColor(product_id, color)`）。
- **不做**：色名模糊匹配、"看起来像"的合并、按 Color 原文批量认色。
- 平台换了图或改了色原文 → 落入第 3/5 级（**可见、可回滚**），不会静默并错。

### 4.3 认款动线（一屏、按键分组）

| 列 | 内容 |
| --- | --- |
| 键 | 店铺 / 商品ID / **商品图**（缩略图）+ 色原文（如 `十店 / 1005012742360018 / 图 5 / Color:5`） |
| 证据 | 标题 + 商品图 + 历史件数（来自 `pl_shop_items` + 订单聚合） |
| 决定 | 选款（搜编码/名字）→ 若该款有多色，再选色（可"新建色名"） |
| 落点 | 写一行 `pl_shop_sku(shop,item,image_id,color_raw)`；**同一键的历史订单一次回填** |
| listing 级显式认款 | 人明确点"整条 listing 都是这个款"时，写一行 `pl_shop_sku(shop,item,image_id=0,color_id=0,status='pending_color')`；**色仍待认，不是静默回落** |
| 快捷键 | 键盘：↑↓ 选行、`Enter` 认款、`1..9` 选常用色（沿用命名板已有的键盘交互） |

**决策量**：首轮 ≈ 69 个键（10 个 listing 的款 + 59 个色）；之后每次导入 **0 次人工**。

---

## 5. SKU 维护成本的削减（第二痛点）

现状：19 个款维护了 **457** 行 SKU；订单只用到 **59** 个 `(商品,色)` 键。要让用户不再逐格填：

1. **款默认克重**：`pl_products.default_weight_g`。订单取重量顺序 = `pl_variants.weight_g` → `pl_products.default_weight_g` → 缺失（进缺口统计）。
2. **SKU 稀疏化**：新建款**不生成矩阵**；当订单/采购第一次出现 `(款, color_id, size_id)` 且需要单独克重时才写一行。矩阵编辑器保留为"高级工具"，不是前置条件。
3. **缺口驱动**：产品页首屏给"缺克重"清单，**按近期件数排序**（只补影响运费的 20%）；支持"这款同色所有码同重"一键铺（1 次输入覆盖 N 格）。
4. **尺码主数据**：`md_sizes` + `size_group`（如 `S-5XL`）一键套用，不再逐码点；订单行 `size` 原文经别名解析到 `size_id`。
5. **颜色主数据**：`md_colors` 全局唯一色名 + `md_color_aliases` 按款别名；`oi_style_colors` / `pl_variants` / `pl_shop_sku` 只存 `color_id`。产品页不再要求先建色，认款时从主数据选（可新建）。
6. **图片主数据**：`md_images` 全项目唯一；款主图、色图、采集图、订单图都只存 `image_id`；一份字节、一个目录、进备份 —— 消除"同一张图有的地方能显示、有的地方不能显示"。

**效果对比**：19 次"款默认克重"（可批量）覆盖大多数款；需要逐组合填的行数 ≈ 订单实际组合（≤59），而不是 457。

---

## 6. 分期落地

| 阶段 | 动作 | 改动面 | 解决的问题 |
| --- | --- | --- | --- |
| **S0a（已确认，见 §10）** | **主数据先落地**：`md_images`（合并三张图表）、`md_colors`、`md_sizes`、`md_color_aliases`；远端图统一落地、统一目录、进备份；业务表改为只存 `image_id` / `color_id` / `size_id` | 图片相关约 150 处 / 16 个文件；`oi_style_colors` 95 处；`spec` 65 处；`pl_variants` 色/码 62 处 | "同一张图有的显示有的不显示""三套色词表" |
| **S0b** | 映射键改**图片优先**：`pl_shop_sku` 加 `image_id` / `color_raw` / `color_id`，解析按 `(shop,item,image[,color_raw])` 命中；无命中即待认；**删除 `'*'` 回落**；允许 listing 级显式认款（`image_id=0` + `pending_color`） | `product-db.ts` 的解析函数 + `order-db.ts` 调用点 + 映射写入 + 认款表单 | **Excel 定款定色**（一个 listing 多色能各归各） |
| **S1** | 认款 UI 按 listing 展开 SKU 行（图 + Color 原文 + 我方色），一键写映射 + 回填 | 发货台 `ClassifyPanel` 为主；产品管理右栏保留入口 | 首轮 69 次决定 → 每次导入 0 次 |
| **S2** | 款色收口：`oi_style_colors.style_id → product_id`、`color → color_id`；删 `oi_styles`；`oi_variant_keys` 的两个状态并入映射行后删表 | `order-db.ts`（83 处 JOIN 改 `pl_products`）、`purchase-db.ts`（8）、`picking-db.ts`（3）、`types.ts`（6） | "两套款 / 三张表一个事实" |
| **S3** | 款默认克重 + SKU 稀疏（`color_id`/`size_id`）+ 缺口清单 + 尺码组预设 | `product-db.ts` 的 variant 写入与查询、`SkuMatrixEditor` 首屏、订单取重 SQL | **SKU 维护时间** |
| **S4** | 删旧图表/死表（`pl_images` / `oi_images` / `pl_item_images` / bundle / fingerprints / 池行）、删空 `pl_variants` 文本列、重建库 + `foreign_key_check` | 迁移与冒烟 | 收尾与数据质量 |

> **顺序为什么改成"主数据 → 键 → UI"**：新键要用 `image_id` 和 `color_id`，如果先改解析函数，就得在旧的两张图表、三套色词表上再写一套映射，等于把临时状态固化成第二套事实。S0a 先把"一张图、一套色/码"立起来，S0b 才是真正的一刀。

---

## 7. 明确不做

- **不用图像做归类键**（CLIP 判色 AUC 0.522 ≈ 随机；已有裁定，见 `notes/2026-10-28-classify-local-vision-direction.md`）；
- **不把 `pl_shop_items` 合并进 `pl_shop_sku`**，也不给它加 `product_id`（采集快照与认款决定是两个事实）；
- **不引入 EAV / 用视图替代有 `id` 的表**（`oi_style_colors.id` 被 5 张表引用，见审查稿 §10.2）；
- **不把成本/售价放到变体上**（C1 成本单点：`pl_products.cost_cents` + 采购快照）；
- **不做"导入即自动建款"**（2026-10-29 已回退并留下原因）；本方案只在**人认款时**建，或建"映射候选"。

---

## 8. 验收（每条都能真跑）

| # | 判据 | 变异（改坏必须红） |
| --- | --- | --- |
| 1 | 同一份 Excel 连导两次：第二次认款次数 = **0**，行数不变 | 把 `image_id` 从匹配条件去掉 → 多色测试出现"全部落到同色"，断言红 |
| 2 | 一个 listing 5 个色：5 行图片键映射，5 个色各归各 | 恢复 `spec='*'` 回落 → 5 个色并成 1 个款色，断言红 |
| 3 | 已认过款的库：同一图片、换一次 `Color` 原文仍命中 | 只按 `Color` 原文匹配 → 改原文后命中数掉到 0，断言红 |
| 4 | 平台换了图片、或 `Color` 原文被复用且图片也撞：落入"待认色"，不静默并错 | 加"模糊匹配色名"或"按 listing 取第一行" → 错误合并，断言红 |
| 5 | 删库重建后 `PRAGMA foreign_key_check` 为空 | 只删表不改引用 → 外键/查询报错，断言红 |
| 6 | SKU 为稀疏时，运费/利润仍按"变体 → 款默认"取到重量 | 去掉默认克重回落 → 重量缺失数上升，断言红 |
| 7 | 同一指纹被款主图 / 采集图 / 订单图引用：`md_images` **只有 1 行**、磁盘 **只有 1 份文件**，三处都能显示 | 任一处仍写第二张图表或第二份本地路径 → 断言红 |
| 8 | 备份导出 → 删本地图 → 备份导入：款图、采集图、订单图都能显示 | 只备份一个目录 / 漏还原 `md_images` 目录 → 某类图返回 null，断言红 |
| 9 | 订单行 `(店铺, 商品ID, image_id)` 命中映射后直接得到 `product_id + color_id`，查询链不经过 `oi_styles` / `oi_variant_keys` | 重新引入 listing 级"取第一行" → 多色 listing 命中数量掉到 1，断言红 |
| 10 | `pl_variants` 只存 `color_id` / `size_id`；订单 `size` 原文经 `md_sizes` 解析后能取到变体克重（订单克重不再 0/75） | 保留文本色名做 JOIN（`黑色` vs `4`）→ 克重命中数回到 0，断言红 |

门禁：`product:smoke` / `order:smoke` / `style:smoke` / `goods:smoke` / `schema-migration-smoke` 全绿。

---

## 9. 与既有方案的关系

- `notes/2026-10-28-order-driven-classify-plan.md` 已得出"键在订单里"，并落地了 `variant_key`；**但它把键定成了 `(店铺,商品,Color原文)`**，且映射表里没有 SKU 级身份，于是色仍然要靠 `oi_variant_keys` + 图/别名。本文已按图片键订正（见 §4），并在该笔记里加了批注。
- `plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md`（2026-10-21）已经把成本/克重改成快照；本方案 S3 的"款默认克重"是它的自然延伸，不新增第二套口径。
- `reviews/PRODUCT_TABLES_REVIEW_2026-10-30.md` 的 A/B/C 分级与删除清单，在本方案的 S2/S4 里逐项兑现。

---

## 10. R0 / R1 施工清单（确认后第一刀）

> 决策依据：[`FEATURE_DECOMPOSITION_2026-10-30.md`](FEATURE_DECOMPOSITION_2026-10-30.md) §0.1 / D1–D18 / Q6。
> 本轮**只做 R0 + R1（= S0a）**；`pl_shop_sku` 的键改造（R2）与款色收口（R4）另开一刀，避免一次改两套事实。

### 10.1 R0：拆行器 + 清库（✅ 已完成 2026-10-30）

| # | 改动 | 文件 | 判据 / 结果 |
| --- | --- | --- | --- |
| R0-1 | 一段一行：`【1】…【4】` 每段独立成行；**有块结构时段数 = 块数**（`产品数量` 在速卖通是总件数，当段数会多拆空壳）；每行只留自己那一段（色/码/件数才对得上）；块不足的行留空并计入缺色 | `src/lib/orderRowSplitter.ts` | 真库脏行 `1123192657411338`：4 段 → **4 行**，码 `XL/XXL/XXXL/XL`，件数 `2/1/1/1`，色 `10/10/10/6` |
| R0-1b | 订单行幂等键从 `(订单号, 图片)` 扩到 `(订单号, 图片, 色, 码, 件数)`（同 listing 多 SKU 常共用一张商品图，只按图判重会吞掉后几段） | `electron/order-db.ts` `insertOrder` | 同图不同色/码的 4 段各落一行 |
| R0-2 | 纯函数回归（不依赖 Electron ABI） | `tests/orderRowSplitter.spec.ts`（31 条） | 4 段夹具 / 块数不足 / 单段各 1 组断言 |
| R0-3 | 清空旧映射与派生（测试数据可丢，D12）；清单补 `oi_variant_keys` / 款合并 / 套装部件（CLI 未开外键时不会随父表级联，会留孤儿） | `scripts/reset-dev-data.mjs` | 已 `--yes` 清库（自动备份 `sellerkit.db.bak-2026-10-30T06-09-47`）；`oi_orders` / `oi_order_items` / `oi_images` / `oi_variant_keys` / `oi_style_colors` / `pl_shop_sku` / `pl_images` 全部 **0** 行 |
| R0-3b | 修清库脚本对普通 FTS5 表的 `delete-all` 报错（会让整条事务回滚，等于没清） | `scripts/reset-dev-data.mjs` | 改为 `DELETE FROM sk_mail_fts;`，清库真正生效 |

**R0 门禁**：`vitest run` **1132 passed / 54 files**；`tsc`（`tsconfig.json` + `tsconfig.electron.json`）0 error；`order:smoke` 全绿；`schema:smoke` 仅既有 [H] 失败（与本轮无关，CHANGELOG 已记录）。

### 10.2 R1：主数据落地（= S0a）

**A. 新增主数据模块（唯一写入口）**

| 内容 | 说明 |
| --- | --- |
| `electron/master-data-db.ts` | `md_images` / `md_colors` / `md_sizes` / `md_color_aliases` 的 DDL + 索引 + `migrate('md.main', steps)`（`electron/db.ts:103` 的版本化迁移） |
| 图片唯一落地函数 | `landImageBytes(bytes, {sourceUrl, source})`：算 SHA-256 → `md_images` upsert（`fingerprint` 唯一）→ 文件写 `userData/images/<fingerprint>.<ext>`；订单 / 款图 / 采集图**只准调它**（`electron/order-image-land.ts` 改为薄封装） |
| 种子 | 颜色：现有 15 种 + `src/lib/colorSwatch.ts` 44 个键（`未分类` / 纯数字不入字典）；尺码：8 种 + `XXXL→3XL` 别名；别名：并入 `oi_color_aliases` 5 行（`product_id=0` 全局） |

**B. 删旧实现（三张图表 → 一张）**

| 位置 | 动作 |
| --- | --- |
| `electron/product-db.ts:1917` | 删 `pl_images` DDL 与读写；`imagePathMap` 改读 `md_images.local_path` |
| `electron/product-db.ts:1929` | 删 `pl_item_images` DDL（0 行，无读入口） |
| `electron/order-db.ts:409` | 删 `oi_images` DDL 与 `style_color_id` / `status` / `result_json` / `error` 读写（D16） |
| `electron/order-image-land.ts` | 整文件改写为调用 A 的唯一落地函数；删除"两表 id 撞车"补丁与分支 |

**C. 引用收口（业务表只存 `image_id`）**

| 层 | 文件 | 改动 |
| --- | --- | --- |
| 主进程 | `electron/order-handlers.ts` | `IMAGE_CACHE_DIRS`(`:670`) → 单一 `images`；`order-image-thumb-batch`(`:790`) 按 `md_images` 查；孤图清理(`:816`) 改为"无引用的 `md_images` 行 + 文件" |
| 主进程 | `electron/product-handlers.ts`、`electron/product-xlsx.ts` | 款图/导入图走唯一落地函数 |
| 主进程 | `electron/shop-item-db.ts` | 采集图**落地**并写 `image_id`（当前 71/71 为 0） |
| 主进程 | `electron/backup.ts` | `order-images` → `images`：导出、导入、体检三处；导出回执报 `imageCount/bytes` |
| 渲染层 | `src/core/services/ipc.ts`、`src/modules/goods/api.ts`、`src/modules/today/classify.ts`、`src/modules/today/tabs/ClassifyPanel.vue`、`src/lib/dataHealth.ts`、`src/lib/productImport.ts`、`src/core/services/importSheet.ts`、`src/lib/classifyBulk.ts` | 图片 URL/路径字段改走 `image_id`；不再出现"两套目录"判断 |

> 图片相关引用实测约 **150 处 / 16 个文件**（`order-images|product-images`）；`pl_images|oi_images|pl_item_images` 出现在 **18 个文件**。

**D. 颜色 / 尺码（R1 只改"色"，款色外键留给 R4）**

| 表 | 改动 |
| --- | --- |
| `pl_variants`（`electron/product-db.ts:1893`） | 加 `color_id` / `size_id`，`UNIQUE(product_id,color_id,size_id)`；**读写改走 id**，文本列停写（物理删列留到 R5 / D18） |
| `oi_style_colors` | `color TEXT` → `color_id`（`style_id → product_id` 留给 R4，不混刀） |
| `oi_color_aliases` | 并入 `md_color_aliases`（`product_id=0` 全局 + 按款覆盖，D17） |

**E. 迁移方式（D12）**

- 不写 backfill：`scripts/reset-dev-data.mjs` 清业务表后由应用空库重建 + 种子；重建后跑 `PRAGMA foreign_key_check`（必须为空）。
- `md_*` 表加入 `reset-dev-data.mjs` 的 `CLEAR` 清单（否则清库后种子会被旧行挡住）。

**F. 门禁与冒烟**

```text
npm run build                     # tsc -p tsconfig.electron.json + vite
npm run verify                    # IPC 契约 / 跨域边 / shop upsert 字段
npm run product:smoke
npm run product:sku:smoke
npm run style:smoke
npm run ipc:shape:smoke
node scripts/order-row-splitter-smoke.cjs     # R0-2
# 新增 images:smoke（同图三处引用 / 备份恢复）
```

**G. 变异点（改坏必须红）**

| # | 变异 | 断言 |
| --- | --- | --- |
| 1 | 订单图与款图各自落盘 → 同指纹两行两文件 | `md_images` 行数 = 文件数、同指纹 1 行 |
| 2 | 备份只 `order-images` | 恢复后款图/采集图取不到（`image_id` 有行、文件缺失） |
| 3 | 采集图仍只存 URL | `pl_shop_items.image_id` 非空 ≠ 71 |
| 4 | `pl_variants` 仍用文本色做 JOIN | 订单克重命中数掉回 0/75 |
| 5 | 把 `color_id` 放进唯一键（提前犯 D2 的错） | 新导入命中数 = 0 |

**H. R1 明确不做**

- ❌ 不改 `pl_shop_sku` 的键（`image_id` / `color_raw` / `spec` 退役）→ R2；
- ❌ 不改 `oi_style_colors.style_id → product_id`、不删 `oi_styles` → R4；
- ❌ 不删 `pl_variants` 文本列 → R5（R1 只停写）；
- ❌ 不动 `oi_order_items.variant_key` 与 `snapshotOrderWeights` → R2/R5 随键与克重一起改。
