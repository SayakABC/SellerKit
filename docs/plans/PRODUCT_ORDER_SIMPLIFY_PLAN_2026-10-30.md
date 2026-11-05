# 产品 / 订单模型简化方案（2026-10-30）

> **状态**：🟢 **D1–D18 与 Q6 全部确认**；**R0（拆行器 + 清库）与 R1（= S0a 主数据）已完成并全绿（2026-10-30）**，下一步 R2（`pl_shop_sku` 键改造）+ R1b（色/码外键收口）。
> **读者**：架构 / 开发者 / 产品
> **起因**（用户口径）：一个很简单的功能却铺了十几张表，数据维护不好、结构不清晰；解析订单 Excel 定不了款和色；在产品管理里维护 SKU 的时间成本太高。
> **前置**：[`reviews/PRODUCT_TABLES_REVIEW_2026-10-30.md`](../reviews/PRODUCT_TABLES_REVIEW_2026-10-30.md)、[`notes/2026-10-30-order-purchase-grid.md`](../notes/2026-10-30-order-purchase-grid.md)、[`archive/plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md`](../archive/plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md)、`docs/decisions/ADR-002-master-data-layer.md`（C1）
> **性质**：设计方案 + 分期；R0 / R1 已落地（拆行器 / 订单行幂等键 / 清库脚本 / 唯一图片仓），R2 起按 §10 继续。
>
> ⚠️ **2026-10-30 重大订正（用户纠错）**：本文 §4 原先以 `(店铺, 商品ID, Color 原文)` 为精确键、并以
> `spec='*'` 作单色 listing 回落 —— **两条都作废**。订单 Excel 里同一 item 下的不同商品可能复用同一
> `Color` 原文，**`(店铺, 商品ID, 订单图片)` 才是 SKU 级身份**；`spec='*'` 回落会把一个 listing 的多个色
> 静默并成一个款色，**不能保留**。新的键与回落规则见
> [`plans/FEATURE_DECOMPOSITION_2026-10-30.md`](FEATURE_DECOMPOSITION_2026-10-30.md) 的 D1–D5；
> D1–D5 已于 2026-10-30 确认（D2 原文入键 / D3 改 `pl_shop_sku` / D4 `spec` 退役）。
> S0a（主数据）已实施（见 §10.2 的「实施记录」）；D 组（色/码外键收口）拆为 **R1b** 延后，理由同节。

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

- **不用图像做归类键**（CLIP 判色 AUC 0.522 ≈ 随机；已有裁定，见 `notes/2026-10-30-order-classify-panel.md`）；
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

- `notes/2026-10-30-order-purchase-grid.md` 已得出"键在订单里"，并落地了 `variant_key`；**但它把键定成了 `(店铺,商品,Color原文)`**，且映射表里没有 SKU 级身份，于是色仍然要靠 `oi_variant_keys` + 图/别名。本文已按图片键订正（见 §4），并在该笔记里加了批注。
- `archive/plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md`（2026-10-21）已经把成本/克重改成快照；本方案 S3 的"款默认克重"是它的自然延伸，不新增第二套口径。
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

### 10.2 R1：主数据落地（= S0a）（✅ 已完成 2026-10-30；D 组拆为 R1b 延后）

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

#### 实施记录（2026-10-30，本刀实际落地）

| 组 | 状态 | 实际形态 |
| --- | --- | --- |
| **A 主数据模块** | ✅ 落地 | `electron/master-data-db.ts`：`md_images`（内容指纹唯一）/ `md_colors` / `md_sizes` / `md_color_aliases`；唯一落盘入口 `landImageBytes`（两级去重 URL 指纹 → 内容指纹，文件落 `userData/images/<sha256><ext>`）；`registerImageRow` 只登记已落盘的图；种子 27 色 + 10 码（`未分类` 与平台数字色**不入**字典，播种幂等且清库后自愈）。**没有** `md.main` 版本化迁移：四张表是全新表，D12 口径是"清库重建"而非升级老形状 |
| **B 删旧实现** | ✅ 落地 | 三张旧图表（`oi_images` / `pl_images` / `pl_item_images`）的 DDL 与读写全删；`retireLegacyImageTables()` 负责老库拆除：先重建 `oi_order_items`（去掉指向 `oi_images` 的外键）再 DROP 三表、补 `oi_style_colors.image_id`（`foreign_keys` 在事务内是 no-op，且 RENAME 会改写别的表的外键 ⇒ 只能"建新表 → 拷数据 → DROP → RENAME"）。**旧图改为「搬完再拆」**（2026-10-30 修订）：原定"零迁移"是按「无存量库」定的，真库实测有 101 行 `oi_images` + 12 行 `pl_images` + 92 条「图 → 款色」绑定，直接 DROP 等于把人工定款定色的积累清零 ⇒ 新增一次性过渡件 `electron/legacy-image-migration.ts`：经 `landImageBytes`（唯一落盘入口）搬进 `images/`，改写订单行/产品行 `image_id`，款色代表图按 `updated_at DESC` 取 1:1（同色多图其余保留为普通图片） |
| **C 引用收口** | ✅ 落地 | 备份 / 体检 / 孤图清理 / 缩略图白名单统一认 `images/`；订单、产品两域只读 `md_images`（`image_id` 唯一图片键）；采集行图写 `pl_shop_items.image_id`；`oi_style_colors.image_id` 成为**款色代表图**（1:1，真库取证：图→多色 0、色→多图 0）。读取口径统一为 `ITEM_STYLE_COLOR_ID`（行上 `style_color_id` 优先、图上代表款色回落） |
| **D 色/码外键** | ⏭️ **延后为 R1b** | `oi_style_colors.color → color_id`、`pl_variants` 加 `color_id`/`size_id` 并停写文本列、`oi_color_aliases` 并入 `md_color_aliases`。延后理由：这三项都要求**改键**（`UNIQUE(style_id, color)` → `(style_id, color_id)`、`(product_id,color,size)` → `(product_id,color_id,size_id)`），而键改造正是 R2 的内容；同一刀里既改图片事实又改颜色事实，会同时触发两套事实迁移（§0.3 铁律）。字典与别名写入接口（`resolveColorId` / `ensureColorId` / `setColorAlias`）已就绪，R1b 只做"业务表换列 + 回填 + 停写" |
| **E 迁移方式** | ✅ 落地 | `md_*` 已进 `scripts/reset-dev-data.mjs` 的清理清单；`md_*` 本身仍不写 backfill。**图片例外**：旧图表的数据由 `legacy-image-migration.ts` 一次性搬入（过渡件，迁移窗口结束后可整文件删除），理由见 B 组 |
| **F 门禁** | ✅ 全绿 | 见下方「R1 门禁实测」 |

**R1 门禁实测（2026-10-30）**：

```text
npm run build             ✅ vite + tsc 0 error
npm run verify            ✅ IPC 契约 / 跨域边 13 条在册 / shop upsert 字段（新增 order-db / product-db → master-data-db 两条边并写明理由）
npm run verify:docs       ✅ 零悬空引用
npm run lint              ✅ 0 error（622 warning 为既存量）
npm run test              ✅ 1132 passed / 54 files
npm run order:smoke       ✅ 全部通过
npm run product:smoke     ✅ 全部通过
npm run product:sku:smoke ✅ 全部通过
npm run style:smoke       ✅ 全部通过
npm run shop-item:smoke   ✅ 全部通过
npm run picking:smoke     ✅ 全部通过
npm run ipc:shape:smoke   ✅ 58 项
npm run schema:smoke      ✅ 全部通过（[C] 老库夹具按真表名 oi_images 造 stub；[H] 收口断言改为回退后语义）
npm run images:smoke      ✅ 新增，25 项（唯一图片仓 / 两级去重 / 拒绝路径 / 字典与别名 / 播种自愈）
                          ＋[9] 旧图搬迁 1 项（同内容收敛 / 引用改写 / 款色 1:1 / 幂等）
```

**真库落地记录（2026-10-30）**：

- `scripts/reset-dev-data.mjs` 当天被误跑三次，清空了店铺（16）/ 邮件账号（6）/ 订单（70）等主数据 —— 已用
  `sellerkit.db.bak-2026-10-30T06-07-49`（首次清库前的备份）整库恢复，数据一条不丢。
- 真库此前停在**半迁移**状态（旧图表已拆、`md_images` 却是 0 行：一次被沙箱拦在落盘那一步的启动所致）⇒
  以备份为源在副本上重跑整条启动链，产物回写：**113 行旧图 → 101 张唯一图**（同内容合并 12 张），
  75 行订单图 / 11 个产品图全部改写并解析到 `md_images`，**72 个款色**拿到代表图（同色多图省 11 张、悬空绑定 9 条），
  `images/` 落盘 101 个文件、0 缺失。旧图表 `oi_images` / `pl_images` / `pl_item_images` 已拆除。
- 回退位保留：`sellerkit.db.half-migrated-2026-10-30`（半迁移现场）、`sellerkit.db.wiped-2026-10-30`（被清空的库）。

> ⚠️ 两处**冒烟口径变更**（不是"修红断言"，是被测语义在 2026-10-29 已回退 / R1 已换形状）：
> ① `backfillVariantStyleColors` 自 `07aaac3` 起只给**已归类行**补记绑定，不再"导入即建款/建色"
> ⇒ `schema:smoke` [H] 与 `picking:smoke` 的临时款用例改为"待认款"或走 `assignOrderStyle` 认款写路径；
> ② 款色代表图 1:1 之后"同图两色各归各色"不可达 ⇒ `picking:smoke` [7] 改为"同一张图只有一个色结论"。

#### 实施记录（2026-10-30 晚，R1c：字典 IPC + SKU「颜色工作台」）

> 这一刀解决的是 §5 的第二步（"把现有的颜色列出来，批量归类、批量拖动"，用户明确否决"颜色用下拉"）。
> 口径：字典是**只读**数据源，界面只消费；写入仍只经业务路径（`ensureColorId` / `ensureSizeId` / `setColorAlias`）。

| 项 | 状态 | 实际形态 |
| --- | --- | --- |
| **字典 IPC** | ✅ 落地 | `electron/master-data-handlers.ts`：`md-color-list` / `md-size-list` 两条只读通道（`handle` 契约），先 `ensureMasterDataSchema()`（老库缺表时自建 + 播种）再返回；`main.ts` 注册、`preload.ts` 暴露、`src/types.ts` + `src/core/services/ipc.ts` 登记（渲染层唯一入口 `mdColorList()` / `mdSizeList()`） |
| **常用色字典驱动** | ✅ 落地 | `SkuMatrixEditor.vue` 的 `paletteColors` = 字典 27 色（`sort_order,id`）+ 矩阵里字典没有的异写（逐个追加）。色块取 `swatchOf()`：**先字典 hex、再 `findSwatch` 模糊**；字典取不到时整排回落 `COMMON_COLORS`（`src/lib/colorSwatch.ts`）。候选列表（点色名弹出的那条）同步换成字典名 |
| **多选 + 批量** | ✅ 落地 | 多选是显式开关（默认零勾选框）；`toggleSelect` 支持 Shift 连选，`全选 / 取消选择 / 已选 N 色` 在批量条上；从已选行起手拖动 = 整组（`dragGroup`），落「常用色」= `classifySelection`（归成字典写法）、落另一色 = `mergeSelectionInto`；`pickCommon` 在多选且已选时也走 `classifySelection`（点常用色 = 归类） |
| **撤销** | ✅ 落地 | 批量走同一条 `markBulk`（12 秒「撤销」，与整行/整列开关共用回执位）；撤销同时清空勾选（旧下标不能残留到下一次批量） |
| **写后立刻读的坑** | ✅ 修 | `matrix` 是 `defineModel`（props 模式）⇒ `matrix.value = x` 只 emit，父组件**下一帧**才回写 prop，立刻读回来仍是旧矩阵。批量循环里因此只有最后一个色生效（冒烟实测：两色批量只归了后一个，回执还说"已经是这些色名"）。改为**累加局部变量、最后一次写回**；`addSize` 的焦点下标是同一类（焦点落在倒数第二码），一并修 |
| **版式** | ✅ 守住 | 27 色靠压字号/内边距/色点放进两行，胶囊**高度保持 24px**（这是拖动靶子）；版式守卫的规格区上限 200 → 250 并写明"矩阵可见性由 ≥7 行组合的独立守卫兜" |
| **冒烟** | ✅ 新增 | `goods:ui` 增 `sku-batch-classify`（多选开关 / 整组落点文案 / 归一成「黑色」/ 撤销搬回两行 / 全选 / 合并为一行 / 退出多选 / 批量步零写入）；`ipc:shape:smoke` 增 ⑬ 段 10 条（通道在册 / camelCase / 升序 / 不含「未分类」与数字色 / 别名是逗号字符串），58 → 68 项 |

**R1c 门禁实测（2026-10-30 晚）**：

```text
npm run build             ✅ vite + tsc 0 error
npm run verify            ✅ IPC 契约 / 跨域边 / shop upsert 字段
npm run verify:docs       ✅ 零悬空引用
npm run lint              ✅ 0 error
npm run test              ✅ 1132 passed / 54 files（新增「常用色」文案豁免）
npm run images:smoke      ✅ 主数据域（字典 / 别名 / 播种）全绿
npm run ipc:shape:smoke   ✅ 68 项（含新增 ⑬ 段 10 条）
npm run goods:ui          ✅ 宽 1440 + 默认 1200 + 窄 900 三遍全绿
```

**留给下一刀（已确认方向，未开工）**：「未归类 → 别名吸收」；发货台「补代表图」；产品页主图「先选图后保存」；
P1 旧形状注释清扫 + 退役表名 lint；P2 色值单一来源（`colorSwatch.ts` 与 `md_colors.hex` 目前各有一份事实）。
（「色卡托盘 + 拖图定色」与「批量定色弹层」已落地，见文末 §实施记录。）

#### 实施记录（2026-10-30 深夜，R1d：色名只读 + 点选归类 + 通用「常用色」组件）

> 用户口径：「编辑产品中的颜色修改为不能修改，可以改成可多选，点击选中，批量拖动到常用色中选择颜色，
> 如果不存在颜色，可以在常用色后面新增颜色，这可以做成通用的页面或方法，可供产品编辑页和归类核对页使用」。
> 四条拆解：① 色名只读；② 点行即选中（撤 R1c 的「多选」开关）、选中后点/拖到常用色归类；
> ③ 常用色末尾「＋ 新增颜色」写 `md_colors`；④ 抽通用组件供两个页面复用。

| 项 | 状态 | 实际形态 |
| --- | --- | --- |
| **色名只读** | ✅ 落地 | `SkuMatrixEditor.vue` 色名 `<input v-model>` 撤掉，改只读 `<span data-color>`；改色名唯一路径 = 归类 / 合并（落库色名永远取字典写法，界面不再产出异写）。候选词浮层（suggest）整段删除 —— 点行选中后「常用色」那排本身就是候选列表。只读后整条 chip 都是拖动抓手（不再排除 input） |
| **点行即选中** | ✅ 落地 | 点 chip 任意处 = `toggleSelect`（Shift 连选保留），`.mx-sel` 勾常显；R1c 的「多选」显式开关撤掉（选中态本身可见，开关是第二套规则）；批量条只在有选中时渲染 |
| **通用组件** | ✅ 落地 | `src/core/components/ColorPalette.vue`（色点胶囊条 + 打勾 = 已在矩阵 + 拖放落点高亮 + 末尾「＋ 新增颜色」inline 编辑器）；共享服务 `src/core/services/colorDict.ts` 单例字典（失败回落 `COMMON_COLORS`）。产品矩阵接「加行 / 归类 / 落点」，归类页接「写草稿色」 |
| **`md-color-create`** | ✅ 落地 | 「＋ 新增颜色」唯一写通道：空名 / >40 字 / 纯数字拒绝（数字色 = "还没定色"的证据，不是主数据）；同名幂等（`created:false`）。preload 消毒 + `types.ts` / `ipc.ts` 四件套登记 |
| **归类页颜色格** | ✅ 落地 | `ClassifyPanel.vue`：有款色卡的行 = 「色点 + 色名」按钮（`data-color` 带当前值），点开 Teleport 弹层复用 `ColorPalette`（compact、不开新增 —— 加款色是产品页职责）；无款 / 无色卡行仍是自由输入 + datalist。弹层带「清空颜色」，Esc / 遮罩关闭 |
| **回执互斥** | ✅ 修 | 单条回执（8s）与批量「撤销」回执（12s）同行互斥，**最新一条优先**（`flashHint` 清 `undoBulk` / `markBulk` 清 `mergeHint`）。顺带堵掉一条数据路：`undoBulk` 是批量前整矩阵快照，中间又改动再点撤销会把新改动抹掉 |
| **冒烟** | ✅ 改写 | `goods:ui` 颜色断言整体改写（`mxChip/mxNames/tapColorRow/ensureDictColor`；假桥 `mdColorCreate` 桩与真进程同闭环；规格区上限 250 → 300 = 新增颜色按钮多占的小半行）；`today:ui` 颜色格 SELECT → 按钮 + 弹层（`clPickColor/clClearColor`；回车保存改派勾选框 —— 按钮上的 Enter 被组件刻意忽略）；`ipc:shape:smoke` 增 ⑬b 段 5 条，68 → 74 项。lint 抓出假桥模板串里 `\d` 没双重转义的真 bug（实际匹配字母 d），已修 |

**R1d 门禁实测（2026-10-30 深夜）**：

```text
npm run build             ✅ vite + tsc 0 error
npx vue-tsc --noEmit      ✅
npm run verify            ✅ IPC 契约 / 跨域边
npm run verify:docs       ✅ 零悬空引用
npm run lint              ✅ 0 error
npm run test              ✅ 1132 passed / 54 files
npm run images:smoke      ✅ 主数据域全绿
npm run schema:smoke      ✅ 版本化迁移全绿
npm run ipc:shape:smoke   ✅ 74 项（含新增 ⑬b 段 5 条）
npm run goods:ui          ✅ 宽 1440 + 默认 1200 + 窄 900 三遍全绿
npm run today:ui          ✅ 全绿
```

**留给下一刀（R1d 后更新）**：「未归类 → 别名吸收」；发货台「补代表图」；产品页主图「先选图后保存」；P1 清扫；
P2 色值单一来源。（归类页「批量定色」已落地，见文末。）

#### 附带改动（2026-10-30，SKU 编码 `{color}` → 颜色 ID）

> 用户口径：「SKU编码把color修改为颜色ID」。色名会被归类改名（`藏蓝` → `藏青`），编码跟着改就对不上实际色；
> `md_colors.id` 是主数据身份，改名不动。

| 项 | 状态 | 实际形态 |
| --- | --- | --- |
| **取值** | ✅ 落地 | `colorDict.ts` 的 `ColorDictItem` 带 `id`，新增 `colorIdOf()`（`0` = 不在字典）；`skuCode.ts` 的 `SkuCodeSeed` 增 `colorId?`，`renderSkuCode` 经 `colorToken` 渲染 `{color}` |
| **回落** | ✅ 落地 | 拿不到 id（未归类的异写色 / 字典未载入 / 内置兜底色）⇒ 回落色名，不留 `S1--L` 残码 |
| **界面** | ✅ 落地 | 占位符标签与 title 改「颜色ID」；`ProductEditorDrawer` 的 `codeSeeds` 带 `colorId`，`onMounted` 预载 `loadColorDict()`（避免第一帧按色名算再跳成 ID） |
| **门禁** | ✅ 全绿 | `test` 1134（+2：id=3 ⇒ `SUST-001-3-L`；无 id ⇒ 回落 `黑色`）；`goods:ui` `sku-drag-grab` 段 +2（字典已有「黑」时预览为 `S1-29-L`、提示标「颜色ID」）；其余同上一节 |

#### 实施记录（2026-10-30，归类核对：色卡托盘 + 拖图定色）

> 用户口径：「接下来继续改归类核对」→ 确认先做 **「色卡托盘 + 拖图定色」**
> （原描述：「页面上常驻一排字典色卡；把某行/某张图拖到色卡上 = 给这些行定色。
> 拖放语义与产品页的归类拖动对齐」）。

| 项 | 状态 | 实际形态 |
| --- | --- | --- |
| **托盘位置** | ✅ 落地 | `ClassifyPanel.vue` 在页头与表格之间常驻 `.cl-tray`（仅待核对范围且本页有行时渲染，不吸顶 —— 吸顶会压扁 `cl-list` 弹性区）；chip 复用 `ColorPalette`（`act="cl-tray"`、`dropAttr="data-cl-tray"`、compact） |
| **列哪些色** | ✅ 落地 | 托盘颜色 = **本页各行 `styleCode` 的款色卡并集**，不是 27 个字典色。理由：这一页落库的是"款 + 色"的款色，颜色不在款色卡里就落不下去，而宿主 `ensureStyleColor` 会顺着它**给这个款新建一个色**（本页不该凭空造款色）。用行上的 `styleCode` 而非草稿 —— `draftOf` 在 computed 里新建草稿会自激 |
| **点色卡** | ✅ 落地 | 有勾选 ⇒ 给这批行定色并保存；没勾选 ⇒ 只说下一步（不写库），托盘自己的提示句跟着勾选数变（「已选 N 行」） |
| **拖图定色** | ✅ 落地 | 行头缩略图同时是"点击看大图"与"拖动抓手"：`pointerdown` 起手、6px 阈值区分两个意图、拖动期间捕获阶段 `selectstart` 一律 `preventDefault`（产品页同一条教训），拖完那一下的 `click` 被吞掉（否则松手就顺手开大图）；落点按 `data-cl-tray` 认，不按坐标区间 |
| **统一写入口** | ✅ 落地 | 点与拖共用 `applyTrayColor(color, ids)`：串行 `saveOne({ silent, defer })` + 一次 `bump()`（与批量定款同形）；回执**分四类计数**（已保存 / 本来就同色 / 还没点名款 / 款色卡里没有这个色），不合并成一句"完成" |
| **冒烟** | ✅ 落地 | `today:ui` 增 9 条（托盘内容 = 黑/白且不含别款的「蓝」；每颗带 `data-cl-tray`；无勾选点色卡不写库；勾 2 行点色卡 ⇒ 两次 `orderStyleAssign` 带 S1+黑；回执含"已把 2 行定到"；拖 P-44 到「白」⇒ 单行落库；拖动中 `is-dragging` + `is-drop`；拖后 click 被吞、大图没开） |

**门禁实测（2026-10-30）**：`build` / `vue-tsc --noEmit` / `test` 1134 / `lint` 0 error /
`verify` / `verify:docs` 全绿；`today:ui` 353 PASS；`goods:ui` 444 PASS（三窗口遍）。

#### 实施记录（2026-10-30，归类核对：批量定色弹层）

> 用户口径：「继续实现批量定色弹层」。上一刀（托盘 + 拖图）是**快路径**；这一层治的是**混款**：
> 同一个色名在有的款色卡里、在有的款色卡里没有 —— 托盘只按"有没有这个色"逐行处理，
> 人看不到"这一下会改几行、几行会不动"，于是要点完才知道结果。

| 项 | 状态 | 实际形态 |
| --- | --- | --- |
| **入口** | ✅ 落地 | 底部动作条在「批量定款…」旁加「批量定色…」（`data-act="cl-bulk-color"`，仅勾选时出现的同一条 `.cl-bulk`） |
| **弹层** | ✅ 落地 | 新组件 `src/modules/today/tabs/BulkColorPicker.vue`（`bc-*` 命名空间，与 `BulkStylePicker` 同一套 `.wb-dialog` 外壳）；头行报「已选 N 行 · M 个款」 |
| **候选色** | ✅ 落地 | 这批行各自款色卡的**并集**（保持首次出现顺序：色卡顺序就是产品页里人排的顺序）。不摆字典全集 —— 这一页写的是「款 + 色」的款色 |
| **覆盖账** | ✅ 落地 | 每种色**点之前**就摆出「改 N 行 · 已是 M · 另 K 行不适用」；`change = 0` 的色仍然列出但**点不动**（"已经是它"要看得见，藏起来会被读成"色卡读错了"）；`noStyle`（还没点名款）与"色卡没这个色"分开数，title 里点名最多 3 个订单号 |
| **写入口** | ✅ 落地 | 与托盘**同一个入口** `applyTrayColor(color, ids)`（串行 `saveOne({ silent, defer })` + 一次 `bump()`，四类回执照旧）；弹层只 emit 一个色名、落库后自动关闭 —— 不另写一套批量落库（两套必然分叉，症状是"弹层说改了 3 行、列表里只动了 1 行"） |
| **纯函数** | ✅ 落地 | `colorOptionsOf(rows)` 放进 `src/lib/classifyBulk.ts`（与 `pickColorFor` 同区）：`change` / `same` / `miss` / `noStyle` / `missNos` 一次算清，单测 5 条 |
| **冒烟** | ✅ 落地 | `today:ui` 增 9 条（入口与「批量定款…」并排；弹层头「已选 2 行 · 1 个款」；黑「改 1 行 · 另 1 行不适用」、白「改 0 行 · 已是 1」；白点不动而黑可点；未选色时「确定」禁用；选中后按钮报「定色并保存（1 行）」；落库只写 P-42、没点名款的 P-43 一行都不写；回执点名"1 行还没点名款"；落库后弹层自动关闭） |

**门禁实测（2026-10-30）**：`build` / `vue-tsc --noEmit` / `test` **1139**（+5）/ `lint` 0 error（625 存量 warning）/
`verify` / `verify:docs` 全绿；`today:ui` **362 PASS**。

#### 实施记录（2026-10-30，归类核对：「颜色叫什么」改成点选起名）

> 用户口径：「归类核对页面的颜色叫什么也修改成编辑产品页的 SKU 编辑的方式」。
> 追问后选定的形态：「单格选中 + 卡片顶部一排色卡」—— 点一个色格 = 选中它，卡片顶部出现
> 「正在给『5』起名」+ 常用色卡（末尾「＋ 新增颜色」）；点色卡即存并自动跳到下一个未命名的色；
> 把色格拖到色卡上也能命名。一屏只有一排色卡，**不再逐格手打色名**。

| 项 | 状态 | 实际形态 |
| --- | --- | --- |
| **为什么撤掉逐格输入框** | ✅ 落地 | 色名会进拿货单与统计，手打必然漂成「黑 / 黑色 / Black」三行 —— 同一件货在两张纸上分成三行。改成"只能从字典里点"后，落库色名总是字典写法 |
| **选中** | ✅ 落地 | 点整格 = 选中/取消（色名改成只读后"点一下"只剩这一种含义）；`vn-sel` 标记常显（未选空框、已选打勾），点它等价于点整格；缩略图按钮仍走 `@click.stop`（点图是看原图，不选中） |
| **色卡** | ✅ 落地 | 复用通用组件 `ColorPalette`（`act="vn"` / `drop-attr="data-vn-pc"` / `allow-add` / `compact`）。色名来源 = `md_colors` 字典 + 命名板里已起过的名字；**平台原文不进这一排**（摆上去等于允许"把色叫 5"） |
| **点之前的拒绝预告** | ✅ 落地 | 色卡的打勾按**款**算（`presentColors` = 选中格同 `styleCode` 下已命名的名字）—— 正是 `renameStyleColor` 拦"同款重名"的边界。人点之前就知道"这一下会被拒，要合并请用映射与关联" |
| **接力** | ✅ 落地 | 存完把选中交给**同组下一个未命名**的格，本组没了交下一组的第一个；只在 `shownGroups`（这一批渲染出来的）里接力 —— 更后面的那批交给「再看 N 个商品」，**不把人交给看不见的格子**（否则色卡上那句"正在给 X 起名"就是一次看不见的写库） |
| **拖动** | ✅ 落地 | 与产品页 `SkuMatrixEditor` 同一套 pointer 手势（6px 阈值、`selectstart` 捕获阻止刷蓝、`elementFromPoint` + `closest('[data-vn-pc]')` 判落点）；拖完**吞掉**随后的那一次 click（`@click.capture`），否则它会顺手把松手位置下面那一格选中、或把另一颗色卡再点一次 |
| **被拒时** | ✅ 落地 | 原话显示在**那一格**（`vn-err-*`），且**不跳选中** —— 跳走等于把错误甩在身后，人还得回头找是哪一格失败 |
| **冒烟** | ✅ 落地 | `today:ui` 命名板段由 7 条扩到 11 条：色格同屏 / **色格内没有任何输入框** / 未选中时只提示且无「取消选择」/ 点格后改口成"正在给「5」起名" / 色卡按款打勾（藏青打勾、军绿不打）/ 只送 `{styleColorId, name}` 两键 / 被拒显示原话且不跳选中 / 存成功接力同组（902）/ 本组填完跨组（904）/ 拖到空白处不改名且吞掉 click / 拖到色卡落库（`{904, 藏蓝}`）并验拖动中的三个 class（在 `pointerup` 之前取） |
| **夹具/桩** | ✅ 落地 | 新增 `mdColorList` / `mdColorCreate` 桩（可变种子 `NAMING_DICT`）—— 不桩会退回内置 `COMMON_COLORS`，而它**恰好**含藏青/军绿/酒红，断言会"碰巧"绿；`orderVariantRename` 的拒绝名从「撞名」改成「藏青」（夹具里 903 同款已叫藏青，正对"同款重名"语义） |

**门禁实测（2026-10-30）**：`node --check` / `build` / `vue-tsc --noEmit` / `test` **1139** / `lint` 0 error（625 存量 warning）/
`verify:docs` 全绿；`today:ui` **368 PASS**；`goods:ui` **447 PASS**（三窗口遍，共用 `ColorPalette` 未受影响）。

**踩坑（写在这里免得下次重犯）**：
1. 注入脚本整体在一个模板串里 ⇒ 注释与文案**不能出现反引号**（会提前结束字符串，`node --check` 报 `Unexpected identifier`）；
2. 绑定在响应式状态上的 class（`is-dragging` / `is-drop` / `is-src`）**必须等一次重绘**再读 —— 同步读永远是"操作之前"的样子，断言要么恒绿要么恒红；
3. 拖完的 click 要**同步**补派（`setTimeout(0)` 之前），否则吞 click 的那支根本走不到；
4. 落点用 `elementFromPoint` ⇒ 目标必须真的在视口里（`scrollIntoView` 后再取 `rectCenter`）。

#### 实施记录（2026-10-30 续，「只列还没认的色」+ 撤下「可能是同一件货」）

> 用户口径：「颜色叫什么中只展示订单中没有认颜色的数据，目的只为了能认款和色，为之后的拿货统计做准备，
> 可能是同一件货模块现在的推荐完全不准，你看看是不是需要去掉」。
> 追问后确认撤法：**只从页面撤掉**（组件 / IPC / 库表全留）。

| 项 | 状态 | 实际形态 |
| --- | --- | --- |
| **命名板只列待办** | ✅ 落地 | 已起过名的色**不进渲染**（`unnamedOf(g)` 过滤后才是色格）；组头由「· N 色 / 还剩 N 个没起名」收成一句「· N 个没起名」；「查看全部颜色」开关（`showAll`）删掉 —— 它唯一的用途就是"把已起名的也摆出来"，与这次口径相反 |
| **选中态收口** | ✅ 落地 | `selected` 的查找加了 `!named`：选中的一定是没认的格，`selHint` 里"现在叫 X"那半句因此不可达，一并删掉（避免留死分支） |
| **撤下「可能是同一件货」** | ✅ 落地 | `ClassifyPanel` 不再挂 `StyleMergeCard`；模板里留注释写明撤下的理由与"判据有了再接回来"，防止有人顺手挂回去 |
| **为什么只撤界面** | ✅ 落地 | 真库 `select count(*) from oi_style_merges` = **0**，没有"想拆拆不掉"的问题；组件与三支 IPC 全留，恢复成本 = 一行 `<StyleMergeCard />` |
| **为什么它不算推荐** | ✅ 取证 | `styleMergeCandidates()` 的唯一判据是"同厂家 + 该厂家下 ≥2 个有键的款"；真库 5 号厂家挂了 8 个款 ⇒ 一屏 8 行全是同一个厂的**不同货**，人得逐行自己判 |
| **冒烟** | ✅ 落地 | ① 新增「只列待办：903 / 905 都不在 DOM 里」（N1 剩 2 格、N2 剩 1 格）；② 原 10 条款合并断言与 1 条其几何守卫删掉，换成 1 条**反向**断言「没有这块，也不再请求 `orderStyleMergeBoard`」—— 撤下这件事本身要有守卫，否则以后被挂回来冒烟照样全绿 |

**门禁实测（2026-10-30）**：`node --check` / `build` / `vue-tsc --noEmit` / `test` **1139** / `lint` 0 error（625 存量 warning）/
`verify:docs` 全绿；`today:ui` **359 PASS**（368 − 9：删 10 条合并断言 + 1 条几何守卫，加 2 条新的）。

#### 实施记录（2026-10-30 续，颜色管理页 + 同色异名合并）

> 用户口径：「当前颜色的管理页面还没有，现状是存在相同的颜色，只是名称不一样，要支持颜色合并」。
> 此前已确认的四项：① 合并后颜色 ID 归一，统计与展示都按归一后的颜色与名称 ⇒ **必须真改业务数据**
> （不是只记别名）；② 同款 / 同产品撞名**自动并掉**，由用户在本页把人认出的同色归一；
> ③ 入口 = **基础数据 › 产品管理组内「颜色」页签**；④ 手势 = **拖到另一行**（与 SKU 矩阵一致）。

| 项 | 状态 | 实际形态 |
| --- | --- | --- |
| **颜色板是什么** | ✅ 落地 | 一行 = 一个色名，取 **字典（`md_colors`）∪ 业务表（`oi_style_colors` / `oi_order_items` 经 `style_color_id` / `pl_variants`）**。只列字典就看不见要并的东西（`黑` 常常只在款色里、`黑色` 才是字典种子）；只列业务表又看不见"还没人用的字典色"。来源徽标三态：`字典` / `未入字典` / `数字色号`；用量列 `款 N · SKU N · 订单 N`（为 0 说「没用到」，不写 0） |
| **排序** | ✅ 落地 | 字典色按 `sort_order`（与下拉一致）在前，其余按用量降序，同用量按色名 —— **用得多的问题色先看见** |
| **合并必须真改数据** | ✅ 落地 | 编排层 [`color-merge.ts`](../../electron/color-merge.ts) 一个事务内六步：① `md_color_aliases` 指向源色的改指保留色 ② **新增**一条全局别名 `源 → 保留`（下次导入平台色直接归一） ③ 删源字典行 ④ `oi_color_aliases` 同改 ⑤ 款色：同款已有保留色 ⇒ **先搬引用**（`oi_order_items` / `oi_variant_keys` / `oi_item_parts`）、`image_id` 只补空、再删源行；没有 ⇒ **原地改色名** ⑥ SKU：同产品已有「保留色 + 同尺码」⇒ **先删源行再补** `weight_g` / `code`（顺序反了会撞 `code` 全局唯一索引），没有 ⇒ 改 `color` 与 `name` |
| **为什么跨域要单开一层** | ✅ 落地 | 合并同时写主数据 / 订单 / 产品三个域，收进任何一个 `-db` 都会让那个域知道别的域的查表字段。`color-merge.ts` 只做编排，`ensureSchemas()` 三个域全建（**含 `ensureVariantSchema()`**，见踩坑 1） |
| **三条纪律** | ✅ 落地 | ① `code` 一律不动（拣货 / 编码规则已引用） ② `oi_order_items.color` 平台原文不动（"未认色"是派生态） ③ 数字色号只能当源、不能当保留名（与 `md-color-create` 同一条校验） |
| **拒绝路径** | ✅ 落地 | 全部在写之前判定：源为空 / 保留为空 / 同一个色 / 保留名是数字色号 / 源色根本不存在（字典与两处业务表都没有）。前端同口径先拦一次（拖到数字色号行只出回执、**不发请求**） |
| **回执** | ✅ 落地 | 只列真的动过的项：`款色改名 N 行` / `款色并掉 N 行` / `SKU 改名 N 行` / `SKU 并掉 N 行` / `订单改指 N 行` / `变体键 N 条` / `套装部件 N 行` / `别名 N 条` / `源色已从字典移除`；全为 0 ⇒ `（没有用到它的业务数据）`。"改了多少行"是用户事后唯一能核对的东西 |
| **合并后必须重拉** | ✅ 落地 | `loadColorDict(true)`（字典单例，两个页面共享）+ `load()`（颜色板）。少一个就会出现"别的页面点色卡还是旧名字" |
| **拖拽手势** | ✅ 落地 | 与 `SkuMatrixEditor` 同一套：`pointerdown` 只记起点并**立刻锁原生选择**；移动 ≥6px 才进拖动（点一下不等于一次合并）；落点用矩形放宽（`DROP_PAD_X=16` / `DROP_PAD_Y=12`）+ 最近距离，**松手那一行的色名保留**；拖后吞掉一次 click |
| **在拖的时候说清会发生什么** | ✅ 落地 | 起手即提示「拖到另一行 = 并进那一行（落点色名保留）」；有落点时改口「松手：把「A」并进「B」」。一行字复用回执那一行，不额外占高 |
| **新增颜色** | ✅ 落地 | 输入 + 新增走 `addColorToDict`（`md-color-create`），已在字典时回执「已经在字典里了」而不是报错 |
| **搜索** | ✅ 落地 | 按色名子串（大小写折叠）；数字色号与英文色名都搜得到；无匹配走空态 |
| **DB 冒烟** | ✅ 落地 | `master-data-db-smoke.cjs` 的 `[10]` 段换新库后补 `ensureVariantSchema()`，5 条颜色合并断言（字典删行 / 别名改指 / 款色改名 / 同款撞名搬引用 / SKU 并掉）全绿 |
| **IPC 形状冒烟** | ✅ 落地 | `preload-ipc-shape-smoke.cjs` 新增 ⑬c 段（12 条）：两条通道已注册、`mdColorBoard → { rows }` 非空、行字段 camelCase 齐全、`黑色` `inDict=true` 且 `numeric` 与纯数字判定一致、合并回执 `dictRemoved=1`、源字典行真删、全局别名真写、合并后板无源色，以及同色 / 数字保留名 `'15'` / 幽灵源色三条拒绝 |
| **UI 冒烟** | ✅ 落地 | `master-data-ui-smoke.mjs` 新增 `colors` step（10 条）：页签可进且面板可见、三行渲染、三种徽标、用量文案、搜「黑」剩 2 行 / 清空回 3 行、拖行前记录行序、真拖 `黑 → 黑色` 后源行消失且用量累加、回执原文、**只发一次请求**且 payload `{source:'黑',target:'黑色'}`、`mdColorBoard` 被重拉（≥2 次）、再拖到数字色号行被本地拦下（`calls` 不增、行数不变） |

**门禁实测（2026-10-30）**：`build` / `vue-tsc --noEmit` / `test` **1139** / `lint` 0 error（629 存量 warning）/
`verify` / `verify:docs` 全绿；`master-data:ui` **182 PASS**（两视口两遍）/ `images:smoke`（含 `[10]` 颜色合并）全通过 /
`ipc:shape:smoke` **86 项**全通过 / `order:smoke` / `today:ui` 全绿。

**踩坑（写在这里免得下次重犯）**：
1. **`ensureProductSchema()` 不建 `pl_variants`** —— SKU 表由另一个入口 `ensureVariantSchema()` 建。合并时只调前者 ⇒ `tableExists('pl_variants')` 为假、SKU 那半段被**静默跳过**：回执里 `skusRenamed/skusMerged` 恒为 0，用户看到"合并成功"但矩阵里同色异名还在（升级后没打开过产品页的新库必踩）。冒烟里同样要补，否则 `[10]` 直接 `no such table`。
2. **拖拽落点矩形必须在拖动"激活之后"重新量** —— 起手时插入的"松手会发生什么"提示会把表整体下移约一行，用拖动前的 `getBoundingClientRect()` 拖到相邻行找不到落点（第一次写这条冒烟就踩了，表现为"拖了但没合并"）。
3. **注入脚本整体在模板串里** ⇒ 注释与文案不能出现反引号（会提前结束字符串，`node --check` 报 `Unexpected token '^'`）；正则要写成 `/^\\d+$/`。

##### 2026-10-30 重新设计（用户反馈：拖行麻烦 + 不知真实颜色）

> 用户口径：「现在颜色太多时拖动起来有点麻烦，并且数字和文字颜色不知道真实的颜色，没办法合并」。
> 两点根因：① 小行 × 小行的拖放，色多时落点难对准；② 数字色号 / 平台原文（`5` / `Khaki` /
> `Photo color`）没有真实色块，人眼无法判断"这两行是不是同一个色"，自然没法合并。

| 改动 | 形态 |
| --- | --- |
| **板拆两区** | 上：**标准色**（字典色，合并目标）= 色卡网格，色块 = 真实 hex；下：**待归一色名**（数字色号 / 平台原文 / 未入字典的异写）= 列表，**没有色块**（"还没认"就是没色块，不给中性灰兜底假装是答案） |
| **合并主路径改成点选** | 点待归一行 → 选中态（回执行提示"已选 X，点上面标准色即合并"）→ 点任一标准色卡 = 合并。色卡是大目标，不再靠拖小行；拖拽保留为**快捷**（拖待归一行到色卡） |
| **真实色块可修** | 标准色卡的色块点一下 = 原生取色器改 hex（`md-color-update-hex`，**只改 hex 不改名字** —— 名字是业务身份，改错会牵一发动全身）；新增标准色时也可取色器选 hex |
| **拒绝路径不变** | 数字色号仍只能当源、不能当保留名（标准色区不会出现数字色，该路径现基本靠主进程兜底） |

**门禁实测（2026-10-30 续）**：`build` / `vue-tsc --noEmit` / `test` **1139** / `lint` 0 error /
`verify` / `verify:docs` 全绿；`master-data:ui` ALL PASS（colors step 重写为两区 + 点选合并 + 拖卡合并）/
`ipc:shape:smoke` **95 项**（新增 ⑬d `md-color-update-hex`：成功 / 只改 hex 不改名 / 非法 hex 拒 / 幽灵 id 拒）/
`order:smoke` / `today:ui` 全绿。

#### 实施记录（2026-11-02，归类核对撤下「颜色叫什么」）

> 用户口径：「归类核对中的『颜色叫什么』可以去掉，当前在该页面没法保存，并且在待核对页面中可以进行颜色的选择」。

| 项 | 状态 | 实际形态 |
| --- | --- | --- |
| **撤下范围** | ✅ 落地 | `ClassifyPanel` 不再挂 `<VariantNamingCard />`，模板注释写明撤下理由与恢复成本（= 一行）；`VariantNamingCard.vue` 与三支 IPC 全留，不删后端 |
| **颜色选择仍然可用** | ✅ 已存在 | 行内颜色格（点开 = 该款色卡弹层）与顶部色卡托盘，落库仍走 `saveOne` / `applyTrayColor` |
| **起名/改名去哪** | ✅ 说明 | 「基础数据 › 产品管理」的款色卡与颜色页签；本页不再承担"给平台原文起名" |
| **守卫** | ✅ 落地 | `today:ui` 的命名板 11 条断言换成 1 条**反向**断言：`vn-panel` / `vn-palette` 不在，`orderVariantNaming` / `orderVariantRename` / `orderStyleBasics` 一次都不读 |

**门禁实测（2026-11-02）**：`node --check scripts/today-ui-smoke.mjs` ✅ / `vue-tsc --noEmit` 0 error /
`build` ✅ / `test` **1328 passed（67 files）** / `today:ui` **359 PASS · ALL PASS**
（新反向断言 `「颜色叫什么」已从归类核对页撤下…` PASS：`vn-panel=false naming=0 rename=0 basics=0`；
待核对颜色选择那批断言（行内色卡弹层 / 顶部色卡托盘 / 拖图定色）全绿）/ `verify` / `verify:docs` 全绿。
