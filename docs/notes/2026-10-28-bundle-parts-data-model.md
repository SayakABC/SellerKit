# 套装（一件实物多个款色）的数据模型与读取纪律

> **⚠️ 本文前半段（P0/P1 的行级方案）已被同一日的第二轮迭代收敛掉一部分，先读这一节再往下看。**
>
> ## 2026-10-28 二次收敛：组合定义上移到产品库，**一张关联表**
>
> 起因：业务澄清「套装**不是整体色**，而是自由搭配（上衣红 + 裤黑）」＋「子商品也是独立商品，能单独卖」。
>
> **落地形态就是「产品关联子商品」** —— 子商品是 `pl_products` 里自己的行（有自己的变体、成本、
> 图片、订单），关联表只存关系，**不复制子商品的任何字段**（复制一份就是第二个真相：
> 改子商品价格时套装那份静默过期）。
>
> ```sql
> pl_bundle_links(product_id, item_id DEFAULT '', alias_key, role,
>                 child_product_id, child_color, qty,
>                 UNIQUE(product_id, item_id, alias_key, role))
> ```
>
> **为什么键里必须有 `alias_key`（平台色号）**：关联的不是"这个套装 ↔ 那些子商品"，
> 而是"**这个套装的这个色号** ↔ 那些子商品的那些颜色"。同一款套装：色号 8 = 红上衣+黑裤、
> 色号 9 = 黑上衣+黑裤。少了色号这一列，两个色号会拆成同一堆东西 —— 拿货单上颜色就没了。
> 而平台色号是**商品级编号**（真库实测 `"8"`，`pl_shop_items.sku_json` 是 `{"color":"8","size":"1"}`），
> 名字里没有任何语义可推：`oi_color_aliases` 现存 5 条正是 `9804|9 → 橙色` 这种人工指认，
> 套装配色就是它的**多值版**（一个色号 → N 个 (子商品, 色名)）。
>
> **为什么不再拆"结构表 + 配色表"两张**（本日中间版本，已合并）：结构一旦独立出来，
> 就必须回答"结构改了历史色号怎么算"，而配色**不可继承**（色号 7 是红黑，不能因为同款
> 一般都是黑黑就套用）。合并后每个色号自成一组、整组替换，没有"模板回落"这条会猜错的路径。
>
> **P1 因此作废**：`pl_shop_sku.bundle_role`（一个商品按角色占多行映射）与新模型冲突 ——
> 新模型里一个商品**只映射一个套装产品**，搭配在 `pl_bundle_links` 里。更要紧的是
> `resolveOrderSku` 被 P1 加上的 `bundle_role = ''` 过滤会让套装商品解析不到产品，
> 展开就无从谈起。**接线前必须先退掉**（列 + 三处判据 + 那两条冒烟）。
>
> **查找优先级（点名 > 提示）**：`(商品ID, 色号)` → `('', 色号)`。商品级是"这件事就这么定"，
> 产品级是"同款套装一般都这样"；顺序反了用户会以为没保存（变异验证：反转后红 1 条）。
>
> **该色号没配过就 `matched: false`，绝不回落别的色号**。这是"数据精准"的底线：
> 拿别的色号顶上，统计会**安静地给出错误的拿货单** —— 少发一条裤子是发货后才发现的事
> （变异验证：去掉色号过滤后 5 条红）。
>
> **禁嵌套**：子商品本身是套装 ⇒ 写入处直接拒（`套装套套装`）。这是环的入口；
> 一层对"两件套/三件套"够用，将来要嵌套必须同时补环检测与深度上限。
>
> **尚未接线**（下一步）：`itemStyleColorIds()` 的三档回落（订单快照 → 关联展开 → 图款色）、
> 展开结果经 `ensureStyleColor(childCode, 色名)` 落到 `oi_style_colors`、
> 以及 5 处汇总口径（`purchase-db.outstanding` 等）。**在此之前页面行为零变化。**

**结论（行级部分，仍成立）**：套装**不能拆订单行、也不能挂在图片上**；一个订单行的款色集合
只有一个读取入口 `itemStyleColorIds()` —— 有部件就用部件集，**绝不**把行/图上的单品款色并进来。
组合定义本身见上方"二次收敛"（产品库的 `pl_bundle_links`），`oi_item_parts` 退化为**归档快照**。
老数据零迁移：表里没行 = 不是套装，行为与改造前完全一致。

## 为什么不能挂在图片上（这一条最容易被想错）

款色归属的唯一权威是 **`oi_images.style_color_id`**，不是 `oi_order_items.style_color_id`：

- 写入方只写图：`assignOrderStyle` 里只有 `setImageStyleColor(order.image_id, sc.id)`（`electron/order-db.ts:1542` 一带），
  从不写行级列；行级那列是 v8 拆表前的投影，只剩历史值。
- 所有读者都 JOIN 图：`listOrdersPage`（`electron/order-db.ts:2971`）、`shippingRows`（`:2869`）、
  采购需求（`electron/purchase-db.ts:374` / `:1126`）一律 `LEFT JOIN oi_style_colors sc ON i.style_color_id = sc.id`。
- 而那张图是**共享记忆**：`order-download-image` 按内容指纹命中即复用整行（连带 `style_color_id`），
  见 `electron/order-image-land.ts` 文件头。一张套装图挂上"上衣红"之后，同图在别的订单里出现就会被读成
  单品上衣，且**没有任何界面能纠正它**（用户看到的是"这单是上衣"）。

所以套装事实必须落**行级**（这张订单实际买了哪几件），并在读取时**压过**图级记忆。

## 为什么不能拆订单行

一个套装拆成两条 `oi_order_items`，四处会同时错，且都不报错：

| 后果 | 取证 |
| --- | --- |
| 采购需求件数翻倍（1 套算 2 件） | 需求按 `style_color_id + size` 求和，`electron/purchase-db.ts:1104-1143` |
| 行级成本/克重各存一份 ⇒ 重复计入 | 列在 `ORDER_ITEM_COLS`：`cost_cents` / `actual_cost_cents` / `weight_g`（`electron/order-db.ts:252-257`） |
| 包裹/拣货粒度错（一个套装是一次发出） | `parcel_lines` 挂在 `order_item_id` 上（`electron/order-db.ts:371`） |
| `corrected` 变成两条要分别核对 | 待核对列表按行 |

## 表与读取口径

`oi_item_parts`（`electron/order-db.ts:438`）：
`order_item_id` / `role`（上衣、裤子…）/ `style_color_id`（NOT NULL）/ `qty_per_set`，
`UNIQUE(order_item_id, role)`，`ON DELETE CASCADE`（`foreign_keys = ON` 在 `electron/db.ts:40`）。

三条设计取舍，每条都是防一类具体的错：

1. **`style_color_id NOT NULL`**：0 是 `oi_order_items.style_color_id` 的"未归属"哨兵。部件写 0 会让下游
   把它当一个真实款色去求和 ⇒ 拿货单多一行空白款。校验在 `replaceItemParts`（`electron/order-db.ts:3833`）。
2. **`UNIQUE(order_item_id, role)`**：同一件实物里"上衣"只有一个款色；同部位要两件用 `qty_per_set=2`。
   两条同 role 会让需求算重，也让"这个部位是什么款"没有唯一答案。应用层先按 `role.toLowerCase()` 判重
   （DB 的 UNIQUE 按字节比，挡不住 `Top` / `top`）。
3. **不存 `bundle_key`**：组合键是派生值（`bundleKeyOf`，`:3927`，形如 `12x1+57x1`，先排序再拼 ⇒ 录入顺序无关）。
   落库必然与部件表漂移。

读取口径 `itemStyleColorIds()`（`:3899`）：有部件 ⇒ **只返回部件集**（图上残留的单品款色不许并进来，
并进来 = 一件实物算两遍）；无部件 ⇒ 回落**图**的款色。回落顺序必须"图 → 行"，反过来会让历史行值
压过后来人工改的归属。

## 「平台商品本身就卖套装」与「同一商品既卖单件又卖套装」两种都存在 ⇒ 只能靠行级事实

不能用 `(item_id, spec)` 判断"这是套装"：同一 `item_id` 会同时出现单品行和套装行。所以：

- 判定一律看 `oi_item_parts` 有没有行，**不看商品级记忆**；
- `pl_shop_sku` 只能当"建议模板"，且必须能表达"混卖"（同一商品的部件模板只作提示，不自动套用）。

## 同源缺陷的处置状态

### 已修（P1，2026-10-28）：回流把套装固化成单品

`pl_shop_sku` 加列 **`bundle_role`**（`''` = 普通映射；非空 = 该商品此部位的部件）。只加了列，
但**每处读写都要跟着换判据**，否则会更糟：

| 位置 | 判据 | 不改的症状 |
| --- | --- | --- |
| `upsertSkuMappings` 的 `existing` 查询 | 套装行按 `(店, 商品, bundle_role)`；普通行额外带 `bundle_role = ''` | 套装各部位的 `spec` 都是 `'*'`，按 spec 判重会让"写裤子"命中"上衣"那行并 UPDATE 它 ⇒ 上衣映射静默消失、回执还报 updated |
| `resolveOrderSku` | 加 `AND bundle_role = ''` | 套装商品的映射会被当成"整行归款"⇒ 整行归成上衣、裤子消失，而且因为有归属不进待核对队列，**没有任何机会被发现** |
| `skuBackfillFromOrder` | 检测到行有部件 ⇒ 逐部位写、`spec='*'`、同部位改绑判 `conflict` | 走单品路径写一条，等于把套装固化成单品 |
| `resolveOrderBundle`（新增） | 返回 `bundle_role <> ''` 的行，供 P2 带出部件模板 | — |

两条纪律：

- **套装的映射不是"歧义多值"**。`resolveOrderSkuList` 的多行是"这个商品可能是 A 款或 B 款"，
  而套装的多行是"它必然由 A 和 B 组成"。两者在表里长得一样（同 `item_id` 多行），语义相反 ——
  所以 `resolveOrderSku` 必须过滤掉部件行，绝不能拿"多值"当歧义去挑一条。
- **同部位改绑一律 `conflict`**，与单品同一条纪律：在这里顺手改等于把这个商品**所有**历史套装行
  一起改判，而用户此刻只看了一单。真要改绑走「商品ID 映射」页。
- `skuBackfillFromOrder` 的套装分支**不调** `reassignOrdersByItemIds`：`resolveOrderSku` 对套装商品
  返回 null，回填对这些行本来就不动，扫一遍是白费。

迁移：`product.sku` v4 = `ensureSkuColumns`（幂等补列），`PRODUCT_SKU_STEPS` 3→4。
⚠️ `normalizeSkuUniqueKey`（v2 重建表）开头必须先跑 `ensureSkuColumns()`：它按 `SKU_COPY_COLS`
逐列搬数据，而这份清单随加列变长；停在 v1 的老库没有新列，直接 `SELECT` 会抛 `no such column`
并把整个迁移事务回滚（症状是"升级卡死"，报错却指向一句看不懂的 SQL）。

冒烟：`order-db-smoke.cjs` 的 `[11]` 节 6 条，断言全读**库里的行**而不看返回值。
两处变异已验证：判重退回按 spec ⇒ 红 4 条；`resolveOrderSku` 去掉 `bundle_role = ''` ⇒ 红 2 条
（其中就有"套装商品不自动归款"这条）。

### 仍未修（P3）：拣货的回落顺序与本口径相反

`electron/picking-db.ts:121` 是 `COALESCE(NULLIF(oi.style_color_id, 0), i.style_color_id, 0)`（**行优先**），
接入套装时必须改成走 `itemStyleColorIds`，**不要照着它抄顺序**。

### 未做（P2/P3）

核对页的部件槽位、采购需求/拣货按部件展开。P0/P1 都还没有界面能写入 `oi_item_parts`，
所以现有页面行为不变。

## 冒烟必须让两条路径期望不同的值

`scripts/order-db-smoke.cjs` 的 `[10]` 节：套装行与单品行**都**先把图挂上同一个单品款色 `scA`，
然后套装行写 `[上衣 scA, 裤子 scB]`。断言套装行只出 2 个而不是 3 个 —— 若实现把图款色也并进来就红。
两条都期望同一个数（比如都期望 2）会让这个 bug 恒绿。变异已验证：把 `.concat(999)` 塞进返回值
（模拟"掺进杂物"）会让该条与"全量替换"一起变红；把回落写成恒 0 会让"无部件回落"与"清空后回落"一起变红。

## 本次顺带修掉的假绿

`schema:smoke` 因上一轮加 v11（删 `oi_queue`）时漏改 `ORDER_MAIN_STEPS`，7 条断言一起红；
补常数到 11，并在场景 H 里**手工造 `oi_queue` + 版本退到 v8**（让 v11 真的跑一遍）后断言它消失 ——
只建表不退版本，v11 早已记账完成、不会再执行，"表被删掉"会退化成"表压根没建过"的假绿。
