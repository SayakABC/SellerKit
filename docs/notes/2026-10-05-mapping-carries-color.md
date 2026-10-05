# 商品ID 映射带上颜色，以及一个"新库夹具恒绿"的真 bug

> 日期：2026-10-05 · 涉及：`electron/product-db.ts` / `order-db.ts` / `picking-db.ts` /
> `src/modules/goods/components/ProductPicker.vue` · 方案背景见 `docs/plans/DAILY_SHIPPING_FLOW_PLAN.md` §3.1/§3.2

## 做了什么

把「商品ID → 产品」的映射从**产品级**升到**款 + 色**级（用户拍板的 G4）：配一次，
该商品之后的所有订单自动带出款编码与颜色，不再"每单看一眼图"。

| 事 | 落点 |
| --- | --- |
| 颜色**存哪** | `pl_shop_sku.spec`（`'*'` = 未指定）。**不新增列、不动 `pl_variants`** |
| 变体关联 | 写库时按 `(product_id, 色)` 反查一个变体填 `variant_id`（0 = 该色还没录变体）—— 不让用户把颜色选两遍 |
| 匹配语义 | `resolveOrderSku` 去掉写死的 `spec='*'`，改 **`ORDER BY (spec='*' OR spec='') ASC, id ASC`**（**带色行优先**） |
| 颜色来源 | `autoAssignByMap` 的颜色顺序改为 **映射配的色 → 订单原文色 → `未分类`** |
| 拣货投影 | `pickingRows` 的 `color` 改为 **款色 → 订单原文**（原名 `oi_orders.color`，实测恒空/占位） |
| 回填 | 新增 `reassignOrdersByItemIds()`；`product-sku-map` handler 写成功后**自动回填存量订单** |

**为什么 `spec` 而不是 `variant_id`**：颜色是**商品ID 的属性**（同一商品ID 的所有订单必然同色），
而 `pl_variants` 的粒度是 **款 × 色 × 码** —— 映射只需要"款 + 色"，选哪一行变体是任意的。
`spec` 是自由文本"规格"，装颜色天然合适，且 `resolveOrderSku` 的升级注释本来写的就是
「精确 spec 优先、回落 `*`」（`product-db.ts:1139`）。`variant_id` 仍然填，但只作"尽力关联"
（供下游按变体取克重/图），不参与匹配。

## 四条会重复踩的结论

### 1. 归款是**写时触发**的 ⇒ 任何"后配的映射"都必须要回填

`autoAssignByMap` 只在 `insertOrder` 那一刻跑。而真实操作顺序常常反着来（**先导订单、后配映射**）
—— 没有 `reassignOrdersByItemIds`，用户配完映射**看不到任何变化**，只能把 Excel 重导一遍。
同类先例：`syncPurchaseCosts` 上线前的拿货单没进 `ae_cost_map`（见 `purchase-cost-sync.ts`）。
**回填只碰未归款的图**（人工纠正 / AI 识别结论优先，自动归款永不覆盖），并只处理本次写入的那些商品ID。

### 2. 「填充率 ≠ 可用」的第二张脸：**读了口径不对的列，字段有值也白搭**

`pickingRows` 一直返回 `color = oi_orders.color`（订单原文），而 `styleColor`（映射/识别的结论）
另有其列。拣货单用前者 → **映射配好的颜色在拣货单上被丢掉**，症状是"我明明配了色，拣货单还是没色"。
⇒ 凡是"订单原文"与"识别/映射结论"并存的场景，都要明确**谁是权威**并写在 `color` 这类中性字段的注释里。

### 3. ⚠️ **建表语句与迁移必须同向，否则"新库"是最不忠实的夹具**

`oi_styles` 曾三处自相矛盾（**本轮抓到的最值钱的一条**）：

| 位置 | 内容 |
| --- | --- |
| 建表 `order-db.ts:236` | `name TEXT NOT NULL`（新库**有**该列） |
| 三处 INSERT（识别建款 ×2、映射归款 ×1） | 都写 `name`（固定空串哨兵） |
| 迁移 `migrateOrderSpine` | 对老库 `ALTER TABLE oi_styles DROP COLUMN name`（老库**没有**该列） |
| 文件头注释 | 写着"列保留、写入空串哨兵"（与迁移**相反**，是过时残留） |

后果：**老库上任何"新建款"的路径必抛 `no such column: name`**（AI 识别建款、映射归款建款都中招，
症状是"识别/归款静默失败、款表永远为空"）；而**冒烟建的是新库（有 name 列）→ 恒绿、线上必崩**。
`insertOrder` 的注释还写着"不 catch 是有意的：这里能抛的只有真异常" —— 于是这个异常被当成"不该发生"。

**修法**：统一到"**无该列**"（迁移的意图），建表去掉 `name`、三处 INSERT 去掉 `name`、
迁移里的"历史名交接"与 `DROP COLUMN` 都**先探列再动**。改完 `picking:smoke` 在新库（无 name）上仍全绿
—— 这一步同时证明了"夹具形状终于等于线上形状"。

**可带走的判据**：**夹具建表的形状若不是最旧的那个形状，它就不是夹具，是安慰剂。**
凡"只在某个版本之前的库里才存在"的结构差异（删列、改主键、改唯一键），
冒烟要么走"最老形状 → 跑迁移"这条路，要么两条形状各测一次。

### 4. 唯一能抓到第 3 条的验证是**克隆真实库**

```bash
# 只读克隆（APFS clonefile，秒级、不动原件）
CLONE=$(mktemp -d)/seller-kit && mkdir -p "$CLONE"
cp -cR "$HOME/Library/Application Support/seller-kit/sellerkit.db" "$CLONE/sellerkit.db"
# 用 electron 跑（better-sqlite3 是 Electron ABI）
SK_DB="$CLONE/sellerkit.db" ./node_modules/.bin/electron scripts/<你的脚本>.cjs
```

在同一份克隆上跑"配一条映射 → 归款 → 拣货投影"，一次就暴露了两件事：
① 断点确实是 `pl_shop_sku` 为空；② `oi_styles.name` 的建表/迁移矛盾。
**用干净新库跑这两条都会通过。**

> ⚠️ 跑这类脚本时**别加 `--no-sandbox --disable-gpu` 也别用 `npx electron … | tail`**：
> 实测 `npx electron` 的包装进程会让管道不 EOF，命令看起来"永远挂着"（同样的调用用
> `./node_modules/.bin/electron` + 重定向到文件则是秒级返回）。macOS 也没有 `timeout`。

## 验收（2026-10-05 实跑，逐条看退出码）

`tsc` / `vue-tsc` / `verify` / `verify:docs` 全 0；`vitest` 37 文件 **622 例**全过；
`picking:smoke` **19 项**（新增 5 条全钉在颜色链上，**3 组变异逐组确认对应断言变红后复原**，
`grep -rn MUTANT` 无残留）；`product:smoke` 44 / `style:smoke` 22 / `order:smoke` / `schema:smoke` /
`product:sku:smoke` / `goods:ui` 52 / `picking:ui` / `today:ui` / `ipc:shape:smoke` 13 全过；
真实库克隆端到端 5 条断言全过（`款=STYLE-002 色=黑色 码=L/5XL`，`variant_id` 自动关联成功）。
