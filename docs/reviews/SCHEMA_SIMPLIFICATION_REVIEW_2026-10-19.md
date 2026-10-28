# 数据库表结构简化与合并评审（2026-10-19）

评审对象：`userData/sellerkit.db` 的全部建表语句（11 个 `electron/*-db.ts`，共 **36 张表**：业务表 35 + 迁移记账表 1）。
取证方式：静态读码（建表语句、写入点、读取点、唯一键形状）+ 与既有裁定文档对账。**本次未改任何代码或表结构。**

---

## §0 结论速览

**一句话诊断**：表多不是问题——36 张表里**没有一张是死表**，域拆分（`sk_*` / `oi_*` / `pl_*` / `purchase_*` / `ae_*` / `sk_mail_*` / `sr_*`）本身是对的；真正的问题是 **3 组「同一业务事实存了两处」** 和 **4 处「关键连接键没落成列」**。

| 类别 | 数量 | 该怎么办 |
| --- | --- | --- |
| 该合并（同一事实两处存） | 3 组 | 只有 1 组收益明确（采购明细双表），另 2 组收益中/低 |
| 该简化（死列、缺键、粒度不一致） | 4 处 | 补列优先于合表，收益最大 |
| 不该合并（看似重复，生命周期不同） | 5 组 | **明确写下理由，防止下一个人重提** |
| 纯死表 | **0 张** | 无需清理 |

**不成立的方向**：把 `oi_*`（订单识别）和 `pl_*`（产品主数据）合成一套款式表、把 `oi_images` 和 `pl_images` 合成一个图片库、把 6 张邮件表压缩成 2 张。这三件事都有否决理由（见 §4）。

---

## §1 判据：什么情况下才允许合并

先立规矩，否则"看着像"就能合，合完会静默坏账。一张表能不能并进另一张，必须三条同时成立：

1. **同一条业务事实**——同一个用户动作写、同一个界面读、同一个时刻产生。两条不同来源（采集帧 vs 平台导出）**即使列长得一样也不是同一事实**。
2. **合并后键还唯一**——原表的唯一键/主键语义不能被稀释。典型反例：`pl_shop_sku` 的唯一键含 `product_id` 是为了支撑"套装"（同店同商品挂两个产品），去掉就永久失去这个能力。
3. **生命周期同频**——删除、重建、孤数据清理必须同时发生。典型反例：订单图会被"孤图清理"删掉，产品主图不该被删。

三条里有一条不成立，就**只补键、不合表**。

---

## §2 该合并的 3 组

### 2.1 `purchase_items` + `purchase_sources` —— 收益明确，建议做

**证据**：两张表的列几乎完全重叠。

| `purchase_items`（`purchase-db.ts:193`） | `purchase_sources`（`purchase-db.ts:206`） |
| --- | --- |
| `purchase_id`、`style_code`、`style_name`、`color`、`size`、`qty` | `purchase_id`、`shop`、`style_code`、`style_name`、`color`、`size`、`qty` |
| `price_cents`、`amount_cents`、`suggestion_qty` | —（只有 `shop` 是新增语义） |

差别只有两处：`items` 带单价/金额/建议量，`sources` 带**来源店铺**。

**现在的连接方式**（`purchase-db.ts:951-971`）：两张表各查一遍，然后在 JS 里用 `` `${style_code}\u0000${color}\u0000${size}` `` 拼复合键对齐。**这不是 SQL JOIN，是运行期字符串匹配**——三列里任何一列在两表写法不一致（空格、归一化、大小写），对账就静默错行，而且不报错。

**改法**：`purchase_items` 加 `shop TEXT NOT NULL DEFAULT ''`，按来源拆行；`qty` 语义改为"该来源的数量"，`SUM(qty)` 即总量；`price_cents` 允许按行不同（本来不同店进价就可能不同，比现在还准）。
**代价**：`mode='package'`（包价模式）只有 `total_cents`、没有明细，此时两表都为空——合并后仍然为空，不受影响。删除路径本来就只有 `DELETE FROM purchase_items/SELECT FROM purchase_sources` 两处（`:582`、`:606`），一并收掉。
**判据**：`purchase:smoke` + 对账页"台账/缺口"两个数字与改动前逐行一致（这两块共用 `takenLedger()`，同一份 SQL 只有一个出口，见 `:848` 注释）。

### 2.2 `pl_shop_store_keys` + `sk_name_map` —— 收益中，建议做

**证据**：两者都是「原始标识 → `sk_shops.id`」的归一表。

| | `pl_shop_store_keys`（`shop-item-db.ts:197`） | `sk_name_map`（`shop-db.ts:180`） |
| --- | --- | --- |
| 键 | `store_key` PRIMARY KEY | `UNIQUE(kind, raw_key)` |
| 值 | `shop_id` | `ref_id` |
| 来源 | **系统记忆**（收养时自动写） | **人的决定**（`source` 默认 `manual`） |
| 附加 | 无 | `ignored`（标记"不是这家"）、`note` |

`sk_name_map.source` 这一列**已经存在**，就是为了区分"人填的"和"系统记的"——也就是说，这张表本来就设计成能装两类来源，只是 `pl_shop_store_keys` 后建（2026-10-18）时另起了一张。

**收益**：仓库里所有"归一"问题只留一张表。现在新建一个归一（供应商归一、平台归一）就要再开一张 `xx_store_keys`，这是复制模板。
**代价与约束**：
- 必须 `kind='store_key'` 与 `kind='shop'` 分开——`manualShopIdByKey()`（`product-db.ts:1021`）是 `WHERE kind='shop'` 全表拉，混进来几千条采集桶键会让 `autoMatchIndex` 变慢且可能误命中；
- `pl_shop_store_keys` **没有 ignored 语义**（桶键一旦记住就是记住），合并后 `ignored=0` 固定；
- 写入点集中在 `rememberStoreKeyForShop()`（`shop-item-db.ts:512`）一处，改造成本低。

**判据**：`shop-item:smoke` + v2 迁移（`backfillStoreKeyMemory`）在新老库各跑一次；关键断言是"同键第二次采集不再落未登记桶"（这是这张表存在的唯一理由）。

### 2.3 `oi_styles.fingerprint` + `oi_style_fingerprints` —— 收益低，可缓

**证据**：一个款的指纹存在两个地方。

- `oi_styles.fingerprint TEXT NOT NULL UNIQUE`（主指纹，`order-db.ts:283`）
- `oi_style_fingerprints(style_id, fingerprint)`（附加指纹，`:299`）

`resolveStyle()` 为此写了两段查询（`:768` 查主表，`:774` 查附表），`mergeOrphanStyle()` 还要手动跳过"与目标主指纹相同"的那条（`:833`）。

**为什么可以合**：主指纹唯一的用处就是"匹配时命中"，没有任何界面读"这个款的标准指纹是哪个"。全部搬进 `oi_style_fingerprints` 后，`resolveStyle` 只需一条 `JOIN`。
**为什么可以缓**：`oi_styles` 现在实质只剩 `(id, code, fingerprint, created_at)` 四列，合并省不下多少；而它处在 AI 识别主链路上，改动会碰到"自动建款"，风险与收益不成比例。
**建议**：本轮不做，等下一次必须动识别链路时顺手做。

---

## §3 该简化的 4 处（收益大于合表）

### 3.1 `pl_shop_sku.variant_id` —— 只写不读的死列

**证据**：`grep variant_id` 全仓，除了建表（`product-db.ts:854`）、写入（`:1486` `variantIdByColor`）和返回类型（`src/types.ts:1651`），**没有任何业务读者**。文档也自认"仍然填，但只作尽力关联"（`docs/notes/2026-10-05-mapping-carries-color.md:23`）。

**代价**：每次认款多一次按色反查变体的查询；`variantIdByColor` 的"同色多码取最小 id"是一个**没有消费者的近似**——它填的值可能不是用户想关联的那个 SKU。
**与既有方案的关系**：`ORDER_ATTRIBUTION_WEIGHT_PLAN.md` 的 P3 打算"升级成 `(productId,color,size)` 精确版"。在那之前，这一列**要么按码填对、要么停止写入**，不要维持"填了个大概"的中间态。
**建议**：先停写（保留列，老库不动），P3 真要做时再按 `(productId,color,size)` 一次填准。

### 3.2 `oi_orders` 缺 `item_id` 列 —— 当前最大的结构缺陷

**证据**：订单表**没有商品ID列**，商品ID 只存在于 `raw_fields` JSON 里（`shopSku.ts:80` 注释："`oi_orders` 没有平台字段……商品ID 只在 raw_fields JSON 里"）。后果是每次都要**把整表读进 JS 再筛**：

```ts
// product-db.ts:1994 —— 取图时扫 5 万行到 JS 里解析 raw_fields
`SELECT id, image_id, raw_fields FROM oi_orders
 WHERE image_id IS NOT NULL ORDER BY id DESC LIMIT ${IMAGE_POOL_SCAN_LIMIT}`
```

同一件事在 `aggregateQueue()`（`shopSku.ts:121`）也有一个 `maxRows = 50000` 上限——**订单超过 5 万行就静默截断**（界面报 `truncated`，但用户不会知道少了哪些）。

**改法**：
1. `ALTER TABLE oi_orders ADD COLUMN item_id TEXT NOT NULL DEFAULT ''`；
2. 两条写入路径落列：`insertOrder`（`:1548`）、`upsertCollectedOrder`（`:1651`），用**同一个** `extractSkuFields(raw_fields)` 提取（口径只能一份，现在已经有这个纯函数）；
3. 版本化迁移回填存量：读 `raw_fields` 写 `item_id`（**不能建生成列**——列名是"列名族"模糊匹配，`ITEM_ID_KEYS` 有 4 个正则，JSON 路径不固定）；
4. 建索引 `idx_oi_orders_item ON oi_orders(item_id)`。

**收益**：待关联队列聚合、`itemImagePool` 取图、`reassignOrdersByItemIds` 回填、归款匹配全部从"扫全表+parse JSON"变成一次索引查询。这也是 `ORDER_ATTRIBUTION_WEIGHT_PLAN` 里 P2/P3 落地前的**前置条件**（否则每次回填都要扫 5 万行）。
**风险**：`raw_fields` 里的列名可能同时命中多个族（`/SKU/i` 很宽），提取口径必须与队列聚合**完全一致**，否则"队列里有、回填时找不到"。判据：同一批订单，`item_id` 列值 与 `aggregateQueue` 的 `itemKey` 逐行相等。

### 3.3 `oi_orders` 缺 `shop_id` 列 —— 每次算钱都在重新归一店铺

**证据**：`oi_orders.shop` 是**店铺原文 TEXT**（`order-db.ts:198`），没有 `shop_id`。每次归款（`autoAssignByMap` → `resolveOrderSku({shop, itemId})`）、每次算钱、每次按店筛选，都要先把原文过一遍 `resolveShopRef()` 才能拿到 `sk_shops.id`。

**这解释了为什么"店铺没归一"会成为静默失败来源**：归一是在**读的时候**做的，读的那段代码一旦漏了 `resolveShopRef`，就静默按 `''` 处理。

**改法**：`ADD COLUMN shop_id INTEGER NOT NULL DEFAULT 0`，写入时解析一次存下来（0 = 未归一），读侧直接用。**不要做成强外键**——店铺可能被删、历史订单必须保留。
**注意**：`shop_id` 是**写入时刻的快照**，店铺后来改名/合并不会回溯（这反而是对的：历史订单该按当时的归属算）。

### 3.4 `pl_item_images` 的键只有 `item_id` —— 与队列/映射的粒度不一致

**证据**：`pl_item_images(item_id TEXT PRIMARY KEY)`（`product-db.ts:1685`），键是**归一后的商品ID，不含店铺**。而队列聚合的键是 `(店铺归一键, 商品ID)`（`shopSku.ts:95`），映射表的键是 `(platform, shop_id, item_id, spec, product_id)`。

**后果**：两家店（尤其跨平台）出现同一个商品ID时，改 A 店的覆盖图，B 店跟着变。概率低但一旦发生是"图片张冠李戴"，用户看到的是"这个商品的图不对"，查不到原因。
**改法**：`PRIMARY KEY(item_id)` → `(shop_id, item_id)`（老库需要重建表 + 回填 `shop_id`，成本不低）。
**优先级**：低。可以等 `oi_orders.shop_id`（§3.3）落地后一起做——那时才有 `shop_id` 可填。

---

## §4 不该合并的 5 组（写明理由，防止复发）

### 4.1 `oi_images` ≠ `pl_images`：生命周期不同，合并会删用户的产品主图

代码里已经写明（`product-db.ts:1602-1605`）：

> `pl_images` 有意**不复用** `oi_images`：那行的生命周期归订单域（**孤图清理会删"没有订单引用"的图**，产品主图会被误删）。

这是唯一一条**会破坏数据**的合并方向。代价是同一张图可能落两个目录、两条 fingerprint（磁盘翻倍），值得。
**可选优化**：让 `pl_images.local_path` 指向同一物理文件（按内容 SHA-256 命名本来就天然同路径），省磁盘而不动两张表。

### 4.2 `oi_orders` ≠ `ae_settle_lines`：两条源，金额口径不同

- `oi_orders` = 采集帧 / 报表导入（订单归类口径）
- `ae_settle_lines` = AE 后台「订单明细」导出的**结算切片**

两者靠 `order_no` 对齐，而且**订单级行与商品级行不能相加**（`ae-db.ts:156-159`，实测 7833.61 vs 29407.01）。合并等于把两套口径塞进一张表，之后每个人都会算错一次。
**这是本仓库已经做对的一次取舍**：2026-10-15 把 `ae_orders/ae_order_lines/ae_fees` 删掉、采集帧统一写 `oi_orders`（`ae-db.ts:4-13`），**保留**了 `ae_settle_lines`。

### 4.3 `oi_styles` ≠ `pl_products`：C1 单点写入靠拆表实现

`oi_styles.name` **已经被删列**（`order-db.ts:17`），业务字段唯一权威在 `pl_products`，两边靠 `code` 同一编码池（`nextStyleCode` 用 `UNION` 查两张表，`:715`）。这是 D1 裁定的结果。

合并的风险不是"重复"，而是**让 AI 自动建款直接写产品主数据**——识别链路会建大量占位款（例如"Picture color"），产品库会被污染成识别池。
**结论**：这是**有意垂直分表**，不是冗余。真要动，只能动 §2.3（指纹那一层），不要动这张。

### 4.4 邮件 1:1 分表：为了让列表页不背大文本

`sk_mail_bodies`（`message_id` 为 PK，1:1）、`sk_mail_attachment_cache`（`attachment_id` 为 PK，1:1）看起来都能内联进 `sk_mail_messages` / `sk_mail_attachments`。

但 `SELECT *` 在邮件域是常态（`mail-db.ts:596/605/682/1044`），正文 HTML 动辄几百 KB——内联后每次拉列表都会把整页 HTML 一起读出来。SQLite 是行存，大 TEXT 会把行撑到多页，全表扫描代价成倍上升。
**结论**：不合并。这是拿"表数"换"列表页响应"，换得对。
（另：`DOMAIN_INTEGRATION_PLAN.md` 里写的 `sk_mail_fts` 实际**没有建**，全文搜索走的是别的路径——这属于"该补能力"，不是"该合表"。）

### 4.5 `sr_rate_snapshots` ≠ `ae_cost_map`：同为"生效区间快照"，形状不同

`ae_cost_map` 是**款级成本行**（`style_code + effective_from`，多行）；`sr_rate_snapshots` 是**整张运价表归一后的 JSON**（`content_key` 按内容去重，`ship-rate-db.ts:10-15`）。
一个适合拆列、一个适合整块存——硬合会逼运价表拆成"国家×卡种"的行，而那张表的形状本来由 `src/lib/shipRate.ts` 归一化决定，拆了就是第二套形状。

---

## §5 一条明确的"不建议动"：跨域用 `code` 而不是 `id`

`purchase_items.style_code`、`ae_cost_map.style_code`、`purchase_ignore.style_code` 都是**字符串编码**，不是 `pl_products.id`。

按 ADR-002 的 C2（关联用 ID），这看起来该改。但不建议：

- 跨域用 `id` 会形成**软链接**——款被删/重建后 `id` 变、编码不变；采购单和成本快照记的是"当时那个款号"，不是"数据库里第 7 行"。
- 跨域用 `code` 的代价（改名/改编码要级联）在这里不存在：产品编码本来就设计成稳定业务键（`pl_products.code UNIQUE`）。

---

## §6 落地顺序与判据

按"收益/成本"排序，**每组独立可上线**，不要打包：

| 序 | 动作 | 收益 | 成本 | 判据（改主进程**先** `tsc -p tsconfig.electron.json`） |
| --- | --- | --- | --- | --- |
| 1 | `pl_shop_sku.variant_id` 停写 | 每次认款少一次查询；去掉"填了个大概" | 极低 | `product:sku:smoke`（顺带确认没读者） |
| 2 | `oi_orders` 补 `shop_id` | 归款/算钱不再反复归一；消除一类静默失败 | 低 | `order:smoke` + 老库/新库各跑一次 |
| 3 | `oi_orders` 补 `item_id` | 队列/取图/回填从扫全表变索引查询 | 中（含存量回填） | `order:smoke` + 新列值 == `aggregateQueue` 的 `itemKey` 逐行 |
| 4 | `purchase_items` 并 `purchase_sources` | 少一张表；消灭三列重复 + 字符串拼键 | 中 | `purchase:smoke` + 台账/缺口逐行一致 |
| 5 | `pl_shop_store_keys` 并 `sk_name_map` | 归一问题只留一张表 | 中 | `shop-item:smoke` + v2 迁移新老库 |
| 6 | `pl_item_images` 键补 `shop_id` | 消除跨店串图 | 高（重建表） | `goods:ui` + `order:smoke` |
| 7 | 指纹两表合并 | 少一个 UNIQUE 索引 | 中高（动识别链路） | `order:smoke` + `resolveStyle` 幂等 |

**顺序理由**：
- 1、2 是"删/补一列"，不重建表，先做能把迁移流程跑通；
- 3 必须在归款方案（P2/P3）之前做，否则每次回填都吃 5 万行扫描；
- 4、5 各自独立，谁先都行；
- 6、7 需要重建表或动识别链路，放最后。

---

## §7 先量影响面（动手前跑这几条）

```sql
-- ① 订单量是否已过 5 万（过了的话 §3.2 的扫描上限已经在截断数据）
SELECT COUNT(*) FROM oi_orders;

-- ② 有多少订单的商品ID 提取不出来（这决定补列后有多少空值）
SELECT COUNT(*) FROM oi_orders
 WHERE json_extract(raw_fields, '$."商品ID"') IS NULL;   -- 列名可能不同，先用 ③ 看实际键名

-- ③ raw_fields 里商品ID 的真实列名分布
SELECT key, COUNT(*) c FROM oi_orders, json_each(raw_fields)
 WHERE key LIKE '%商品%ID%' OR key LIKE '%SKU%' OR key LIKE '%货号%'
 GROUP BY key ORDER BY c DESC LIMIT 10;

-- ④ 同一商品ID 出现在几家店（§3.4 串图的真实概率）
SELECT item_id, COUNT(DISTINCT shop) n FROM (
  SELECT json_extract(raw_fields,'$."商品ID"') item_id, shop FROM oi_orders
) WHERE item_id IS NOT NULL GROUP BY item_id HAVING n > 1 ORDER BY n DESC LIMIT 20;

-- ⑤ 店铺原文的归一情况（§3.3 有多少会填成 0）
SELECT shop, COUNT(*) c FROM oi_orders GROUP BY shop ORDER BY c DESC LIMIT 20;

-- ⑥ 采购明细双表的一致性（§2.1 合并前必须逐行相等，不等说明现在就错着）
SELECT i.purchase_id, i.style_code, i.color, i.size, i.qty AS item_qty, s.qty AS src_qty
  FROM purchase_items i
  LEFT JOIN purchase_sources s
    ON s.purchase_id = i.purchase_id AND s.style_code = i.style_code
   AND s.color = i.color AND s.size = i.size
 WHERE s.id IS NULL OR s.qty <> i.qty
 LIMIT 50;
```

⑥ 如果现在就查出行，说明两表已经在漂移——合并是修 bug，不是重构。

---

## §8 一句话总结

**别为了整齐去合并跨域表**（`oi_*` / `pl_*` / `ae_*` 的分界是对的，且每条边界都有事故在背后）；**该做的是把"同一事实的第二份"收掉**（采购明细双表、店铺归一双表），**以及把两个核心连接键从 JSON 里提出来变成列**（`item_id`、`shop_id`）——后者的收益比任何一次合表都大。
