# 映射的身份是「店铺 + 商品ID」，平台只是副本

**结论**：`pl_shop_sku` 的匹配键从 `(platform, shop_id, item_id, spec)` 改成 **`(shop_id, item_id, spec)`**。
平台列保留（作写入时刻的记录与展示兜底），但**不再参与任何判重/命中**。四处一次性改齐，少改一处就是一个新的"看着都在、一条都不命中"。

## 为什么（触发点很小，代价很大）

「基础数据 › 店铺登记」里的平台是个普通下拉框（`ShopRegistryView.vue` 的 `data-act="reg-platform"`），改它没有任何提示。
而映射行的 `platform` 是**写映射那一刻从店铺行抄下来的副本**（`order-db.ts` 的 `platform: shop.platform`），
`sk_shops` 一行本来就只对应一个平台。副本进键的后果：

| 环节 | 改平台之后 |
| --- | --- |
| 认款 `resolveOrderSku` | 拿店铺**当前**平台去查映射行的**旧副本** ⇒ 该店全部映射一条都不命中，订单掉回未认款 |
| 待关联队列 | 队列侧用店铺当前平台拼键、已关联集合用副本拼键 ⇒ 商品被当成未关联，重新塞回待办 |
| 重配映射 | 四列键都不撞 ⇒ **新增一行**；旧行仍 `confirmed`，产品详情把两条都算进"已关联"（幽灵关联） |
| 提示 | 一处都没有。用户只看到"订单突然全认不出了" |

`normPlatform = toNameKey` **不折叠大小写**，所以 `AE` → `ae` 这种看起来没变的修改也中招。

## 改了什么

- `electron/shopSku.ts`：`mappingKey(platform, shopId, itemId)` → **`bindingKey(shopId, itemId)`**
  （函数名换了、少一个参数，旧名字不再存在 —— 免得有人照着旧签名再传平台进去）。
- `electron/product-db.ts` 四处匹配同时改：`resolveOrderSku`、`shopSkuQueue` 的 `mappedKeys`、
  `resolveSkuBatch`（入参还收 `platform` 但**不参与匹配**）、`upsertSkuMappings` 的判重与"改色=替换"孪生行查找。
- 平台改为**从店铺派生**：`mapSkuRow`（映射列表）、`skuMapSummary.byPlatform`（汇总按店铺当前平台聚合）、
  `listSkuMappings` 的关键字搜索（`EXISTS sk_shops ... platform LIKE ?`，店铺域未初始化时回落副本列）。
- 新增索引 `idx_pl_shop_sku_binding(shop_id, item_id, status)`：旧索引 `idx_pl_shop_sku_lookup` 的前缀是 `platform`，
  键去掉平台后那几条查询会退化成扫表。
- 重配时顺手刷新 `platform` 副本（`UPDATE ... SET platform = ?`）：不参与匹配，但留旧值会让看库的人以为店还在别的平台。

**不需要数据迁移**：去掉条件只会让命中**变宽**。真库取证：29 条确认态映射的 `platform` 与所属店铺 100% 一致
（`SELECT COUNT(*) FROM pl_shop_sku m JOIN sk_shops s ON s.id=m.shop_id WHERE m.platform <> s.platform` → 0）
⇒ 新旧命中集合逐行相同，改前能认的单一单不少。

## 取证

- 真实库克隆（只读）：`29/29` 条确认态映射仍命中；同店同商品重复行 `0` 组（⇒ 去掉平台后不会出现"多命中取谁"的歧义）；
  新索引在老库上由 `ensureSkuSchema` 正常补出。
- `npm run product:sku:smoke` 新增 2 条：改平台后 认款仍命中 / 队列仍算已关联 / 列表与汇总跟店铺走 /
  按新平台搜得到 / 重配是 `updated`（不新增幽灵行）；另一条钉住"改一家店不影响别家、同商品ID 不串"。
- 变异七组，各自只让目标断言变红：认款含平台 · 队列键含副本 · 写入判重含平台 · 列表展示用副本 ·
  汇总按副本分组 · 批量解析含平台 · 搜索退回副本列。
- `tests/shopSku.spec.ts` 的键测试随之翻面：原来"平台不同 → 不同键"改判为**平台不在键里**，
  并新增一条"店铺改成 temu 后仍算已关联"（旧实现下必红）。

## 边界

- **池行不受影响**：`skuMappingSql()` 已经把 `source='pool'` 与 `shop_id=0` 排除在外，映射行的 `shop_id` 恒 >0，
  所以平台确实可由店铺唯一派生。
- **厂商跨平台复用同一商品ID** 仍然安全：跨店不串（`shop_id` 才是那层隔离），跨平台同名店也各有各的 id。
- 遗留的多平台重复行（若有）按 `ORDER BY (spec='*') ASC, id ASC` 定序 —— 结果确定，不随写入顺序漂。
