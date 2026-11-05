# 店铺身份、认店证据与映射身份：53 条结论（蒸馏自 4 篇，2026-10-16 ~ 2026-10-20）

> **蒸馏笔记**：由 4 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/2026-10-30-shop-identity-and-mapping.md`
> 原文可取回：`git show b5df35c:docs/notes/2026-10-30-shop-identity-and-mapping.md`
> 原文可取回：`git show b5df35c:docs/notes/2026-10-30-shop-identity-and-mapping.md`
> 原文可取回：`git show b5df35c:docs/notes/2026-10-30-shop-identity-and-mapping.md`

## 1. 同一个字段不能既当"匹配键"又当"给人看的地址" —— 两个症状同一个根因

**结论**：**同一个字段不能既当"匹配键"又当"给人看的地址"**。`sk_shops.shop_url` 原先两个角色都担：作为匹配键它必须**归一**（剥掉协议 / `www.` / 尾斜杠 / `index.html` / 查询串，好让"人贴的地址"与"页面采集的 URL"对上），作为界面回显与「打开店铺」的目标它又必须**带协议**。归一化赢了 ⇒ 用户在「店铺登记」里填 `https://x.com/store/1`，存进去是 `x.com/store/1`，再打开编辑前缀不见了，点「打开店铺」报**链接地址无效**（`open-external` 要求 `http(s)://` 开头，无协议直接判非法）。**两个症状同一个根因**（2026-10-16 用户报的现场）。

**取证**：`sk_shops.shop_url`；`https://x.com/store/1` → 存 `x.com/store/1`；`open-external` 要求 `http(s)://` 开头。

**源**：`2026-10-16-shop-url-raw-vs-key`（2026-10-16）

---

## 2. 拆列，不折中：`shop_url` 只做键，新增 `shop_url_raw` 存原文

**结论**：**拆列，不折中**：`shop_url` 继续只做匹配键（索引与 `WHERE shop_url = ?` 一字未动，采集落库口径不变），新增 `shop_url_raw` 存**用户填的原文**。判据是"这一列有没有下游读者"——把协议塞回 `shop_url` 会破坏 `matchShopByStore` 的精确相等，等于拿匹配去换展示。

**取证**：`WHERE shop_url = ?`；`matchShopByStore`。

**源**：`2026-10-16-shop-url-raw-vs-key`（2026-10-16）

---

## 3. 原文规整只补不删：`toOpenableUrl()`

**结论**：**原文规整只补不删**：`toOpenableUrl()` —— 已带 `http(s)://` 的**原样保留**（用户填 http 就是 http）、`//host` 补 `https:`、其它协议（`ftp:` / `javascript:`）原样留着交给 `open-external` 按白名单拒绝（改写成 https 会把"填错了"伪装成"能打开"）、裸域名补 `https://`。匹配键**从规整后的原文派生** ⇒ 展示值与键永远同出一次规整。

**取证**：`toOpenableUrl()`。

**源**：`2026-10-16-shop-url-raw-vs-key`（2026-10-16）

---

## 4. 读取面给原文，缺失才回落 ⇒ 四处消费点一行没改就正确

**结论**：**读取面给原文，缺失才回落**：`mapShopRow()` 输出 `raw || ('https://' + key)`。于是四处消费点（店铺登记页「打开」/ 待关联采集商品的下拉「打开」/ 两处表单回显）**一行没改就正确** —— 老调用方拿到的是它本来就期望的"可打开地址"。

**取证**：`mapShopRow()` → `raw || ('https://' + key)`。

**源**：`2026-10-16-shop-url-raw-vs-key`（2026-10-16）

---

## 5. 老库要回填，且只回填一次

**结论**：**老库要回填，且只回填一次**：补 `shop_url_raw` 列的同一次，把存量归一键写成 `https://<键>`（不回填 ⇒ 老店的「打开店铺」照样报无效）。回填条件两个：`shop_url_raw = ''`（不覆盖已有原文）+ `shop_url <> ''`（不给没地址的店凭空造地址）。**放在"缺列"分支内** = 迁移语义；`shop_url <> ''` 顺带保证"用户清空地址后不会被写回"。

**取证**：`shop_url_raw = ''`；`shop_url <> ''`。

**源**：`2026-10-16-shop-url-raw-vs-key`（2026-10-16）

---

## 6. 改动点清单（五处 + 冒烟）

**结论**：改动点分布：地址字段的两列契约、类型注释、登记页提示、注释同步、冒烟用例。

**取证**：

| 位置 | 内容 |
| --- | --- |
| `electron/shop-db.ts` | `SCHEMA` 加 `shop_url_raw`；`ensureShopColumns()` 补列 + 回填；新增 `toOpenableUrl()` / `displayShopUrl()`；`upsertShop()` 双写（键从规整后的原文派生）；`COLS` + `mapShopRow()` 读原文 |
| `src/types.ts` | `ShopListItem.shopUrl` / `ShopUpsertInput.shopUrl` 注释改为"原文"（**契约字段名不变**，值语义变） |
| `src/modules/shop-accounts/components/ShopRegistryView.vue` | 地址字段提示：保留协议、无协议按 https、比对时忽略协议等差异 |
| `electron/shop-handlers.ts` / `AccountEditor.vue` | 注释同步（收养入口传的就是原文，内部归一 —— 别在外面再归一一次，会与"键从原文派生"分叉） |
| `scripts/shop-item-db-smoke.cjs` | 5 条新用例 + 1 条改写（原「URL 归一匹配」的 `stored.shopUrl` 断言改为直读库两列） |

**源**：`2026-10-16-shop-url-raw-vs-key`（2026-10-16）

---

## 7. 冒烟新增 6 条用例

**结论**：`npm run shop-item:smoke` 新增用例（跑前必须 `tsc`，且需 `env -u ELECTRON_RUN_AS_NODE`）：原文保留 `http://`（用户填 http 不许被改成 https）+ 读取面给原文；裸域名补 `https://`，且读取面的值能过 `open-external` 的协议判据；编辑改址 / 清空 ⇒ 两列同步（清空不留幽灵键）；迁移（上一版形状：有 `shop_url` 无 `shop_url_raw`）⇒ 补列 + 回填 `https://`；迁移（更老形状：地址两列都没有）⇒ 三列一并补上，**不造数据**（`raw` 仍空）；迁移**只做一次**：列已在的库不再回填（`alreadyMigrated` 夹具 —— 这是唯一测不到"跑迁移"的形状）。

**取证**：`npm run shop-item:smoke`；`env -u ELECTRON_RUN_AS_NODE`。

**源**：`2026-10-16-shop-url-raw-vs-key`（2026-10-16）

---

## 8. 变异复核 4 条全红，还原后全绿

**结论**：

| 变异 | 红在哪 |
| --- | --- |
| `mapShopRow` 回退成给匹配键 | 3 条（原文保留 / 可打开 / 迁移后读取面） |
| 回填移出"缺列"分支 | 1 条（迁移只做一次） |
| 回填去掉 `shop_url <> ''` | 1 条（更老形状：`raw` 被写成 `'https://'`） |
| `upsertShop` 的原文也走 `normalizeShopUrl` | 4 条（= 旧实现整体回退） |

**取证**：`scripts/shop-item-db-smoke.cjs` 的 4 组变异。

**源**：`2026-10-16-shop-url-raw-vs-key`（2026-10-16）

---

## 9. 真库克隆端到端（9 家真实店铺）

**结论**：真库克隆端到端（`cp -c` 真 `userData/sellerkit.db` 到临时目录，脚本里 `initDb(process.env.SK_DB)`）通过。

**取证**：

```
迁移前 sk_shops：9 行 / 迁移后：9 行
✅ 迁移：行数 / 逐 id / 键值 / 回填全部一致
✅ 读取面：9 家店的地址全部可打开，没地址的店恒空
✅ 匹配链：8 家有地址的店，帧只差协议/www/query/index.html 仍全部命中
```

**源**：`2026-10-16-shop-url-raw-vs-key`（2026-10-16）

---

## 10. ⭐ 还原变异后必须重跑 `tsc -p tsconfig.electron.json`

**结论**：**⭐ 还原变异后必须重跑 `tsc -p tsconfig.electron.json`**：冒烟读的是 `dist/`。这次就是还原源码后没编译，于是"迁移只做一次"用例红在**变异体残留的 dist** 上，白排查了一轮。（本仓既有结论"变异跑完必须 build"的同型坑，只是这里换成了 tsc。）

**取证**：`tsc -p tsconfig.electron.json`。

**源**：`2026-10-16-shop-url-raw-vs-key`（2026-10-16）

---

## 11. `initDb` 是单例，迁移用例必须先 `closeDb()` 再 `initDb(新路径)` 且放脚本末尾

**结论**：**`initDb` 是单例**：迁移用例必须先 `closeDb()` 再 `initDb(新路径)`，且这类用例要**放在脚本末尾** —— 换到只建了 `sk_shops` 的库之后，前面那些用例的 `reset()` 会因为 `DELETE FROM pl_shop_items` 报 `no such table`（本脚本已经把迁移段单开在"收尾"之前）。

**取证**：`initDb` / `closeDb()`；`DELETE FROM pl_shop_items` → `no such table`。

**源**：`2026-10-16-shop-url-raw-vs-key`（2026-10-16）

---

## 12. 夹具建表用 `replace` 拼 DDL 会静默失效

**结论**：**夹具建表用 `replace` 拼 DDL 会静默失效**（缩进差一格就 replace 不到，于是夹具少了关键列）。形状不同的 DDL 直接各写一份。

**取证**：夹具 DDL。

**源**：`2026-10-16-shop-url-raw-vs-key`（2026-10-16）

---

## 13. "迁移只做一次"不能用"跑迁移"来测

**结论**：**"迁移只做一次"不能用"跑迁移"来测**：凡是"建缺列旧库 → ensure"的用例，回填都在进分支那一次完成，之后再 ensure 多少次都不进分支 ⇒ 断言"没被改写"必然恒绿。必须先造出**列已在**的库。

**取证**：`alreadyMigrated` 夹具。

**源**：`2026-10-16-shop-url-raw-vs-key`（2026-10-16）

---

## 14. 本机 `ELECTRON_RUN_AS_NODE=1` 会让 `app` 缺失（环境，不是回归）

**结论**：**本机 `ELECTRON_RUN_AS_NODE=1` 会让 `app` 缺失**：不带 `env -u ELECTRON_RUN_AS_NODE` 跑冒烟时，凡是碰 `app.getPath` 的用例（色图那批）会集体红成 `Cannot read properties of undefined (reading 'getPath')` —— 那**不是**回归，是环境。判据看改动相关的用例是否绿。

**取证**：`Cannot read properties of undefined (reading 'getPath')`。

**源**：`2026-10-16-shop-url-raw-vs-key`（2026-10-16）

---

## 15. 迁移 / 回填类改动别只信合成夹具

**结论**：迁移/回填类改动**别只信合成夹具**：真库克隆跑一遍才看得到"9 家真实店铺、键逐 id 不变、匹配仍命中"。

**取证**：`cp -c` 真 `userData/sellerkit.db`。

**源**：`2026-10-16-shop-url-raw-vs-key`（2026-10-16）

---

## 16. 真库取证：同一款在库里存了两行（纯冗余副本）

**结论**：拷 `seller-kit/sellerkit.db` 只读查 `pl_shop_items`，两桶 `item_id` **交集 40** ⇒ 同一款在库里存了两行；逐条对比**两侧 SKU 行数、标题逐字相同** ⇒ 纯冗余副本，不是两次不同的采集结果。未登记桶独有 **23** 条，全部 `sku_json` 非空（本轮确实采到了）。

**取证**：

| shop_id / store_key | 条数 | `scraped_at` 时间窗 |
|---|---|---|
| `6 / ''`（九店） | **40** | 10-17 22:09 ~ 22:12 |
| `0 / 'Shop1105671703 Store'`（未登记桶） | **63** | 10-18 00:24 ~ 00:28 |
| `4 / ''`（七店，别的店） | 8 | 10-16 |

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 17. 真库取证：登记信息填错 ⇒ `matchShopByStore` 三级证据全落空

**结论**：`sale` 侧登记信息是第二条根因：九店的 `platform_shop_id` 填的是**店名**、`shop_url` 里的数字也不是真 storeId。采集帧带来的是 `storeId=1105668759` / `name=Shop1105671703 Store`。于是 `matchShopByStore` 的三级证据（归一 URL → storeId → 店名全等）**三级全落空** ⇒ 落未登记桶。

**取证**：

| shop | name | platform_shop_id | shop_url |
|---|---|---|---|
| 6 九店 | `九店` | `Shop1105671703 Store` ← **填的是店名** | `aliexpress.com/store/1105671703` ← **数字也不是真 storeId** |

用户报障原文：「现在采集没有去重，之前已经采集过40条数据了，剩余23条未采集，但本次采集还是采集了所有数据，并出现在待关联采集商品中了，并且未关联店铺」。采集端 `ae-profit` 0.4.0 → 0.5.0；宿主 `shop-item-db` 加记忆表与 v2 迁移。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 18. 时间线把两个根因串起来

**结论**：**时间线把两个根因串起来**：22:09 采 40 条落未登记桶 → 用户登记九店，`shop-upsert` 触发一次 `adoptShopItemsForShop` 把它们搬进 `shop_id=6` → 00:24 又采 63 条，三级匹配仍落空（用户没再保存过店铺 ⇒ 收养不重跑）⇒ 落回未登记桶 ⇒ 与已归店的 40 条并存。

**取证**：`shop-upsert` → `adoptShopItemsForShop`。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 19. 根因 A：跨轮去重的真源头搞错了 —— 台账在扩展本地

**结论**：上一轮（10-17）加的去重台账 `aeWalkSeen` 在**扩展本地** `chrome.storage.local`。它只认「**这一套扩展在这个浏览器**采过的款」，对下列场景一无所知：用户第一次用的就是 0.3.0（没有 seen 台账）⇒ 升级到 0.4.0 后第一次点采集必然全量重跑；换浏览器 / 清扩展数据 / 换机器 / 重装扩展 ⇒ 台账空。用户那 40 条正是旧版扩展采的 ⇒ 本地台账里一条都没有 ⇒ 第二次点采集把 63 条全采全推。**"采没采过"的事实在宿主库里**（`pl_shop_items` 有行），宿主才是权威。

**取证**：`aeWalkSeen`；`chrome.storage.local`。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 20. 修法 A：宿主新增只读端点 `GET /ae/shop-items/known`

**结论**：**宿主**新增只读端点 `GET /ae/shop-items/known?url=&storeId=&name=`（`ae-receiver.ts` 的 `handleItemsKnown`），底层 `shop-item-db.listScrapedItemIds()`。**匹配口径必须与 `upsertShopItems` 同源**（同调 `matchShopByStore`）：问的时候算 A 店、写的时候算 B 桶，去重会「问的和写的不是一家」而静默失效。同时覆盖**未登记桶**的行：店还没登记的用户也得能去重。token 两处都收（header 优先 / query 兜底）；**刻意不套 60 次/分的 ingest 限速窗口** —— 大店铺批量采集时它会被自家 ingest 挤掉，而它恰好是「少采」的那一环，挤掉就退化成全量重采。

**取证**：`GET /ae/shop-items/known?url=&storeId=&name=`；`handleItemsKnown`；`listScrapedItemIds()`。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 21. 修法 A（扩展侧）：本地台账与宿主清单取并集，查不到不阻断但明写原因

**结论**：**扩展** `startWalk` 改为：本地 `aeWalkSeen` 与宿主清单**取并集**灌台账（`fetchKnownFromHost`）。查不到**不阻断采集**，但原因落 `walk.knownError`，popup 明写「未向主程序核对已采清单……可能重复采集」—— 否则用户只看到"又全采了一遍"，分不清是主程序没连上还是真有新货。`force`（整店重采）连宿主那半也不认。

**取证**：`startWalk`；`fetchKnownFromHost`；`walk.knownError`。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 22. ⭐ 清单只列「采到过 SKU 矩阵」的款 ——「存在」≠「采到」

**结论**：`listScrapedItemIds` 的 WHERE 带 `sku_json <> '' AND sku_json <> '[]'`。这不是保守，是必需：采集分两层——**列表轻采**（无 SKU）与**详情重采**（带矩阵）。用户在列表阶段跑完就停，库里就有只有列表信息的行；把它们当"已采过"让扩展跳过，那些款**永远拿不到 SKU 矩阵**，而界面上看着"库里已有、不用再采"。**「存在」≠「采到」。**

**取证**：`sku_json <> '' AND sku_json <> '[]'`。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 23. 根因 B：收养是一次性的，记忆丢了

**结论**：`adoptShopItemsForShop` 只在 `shop-upsert`（用户保存店铺那一刻）跑一次。用户当初没把 URL/店铺ID 填对（platform_shop_id 填成店名），1、2 两级此后**恒落空**，于是之后每次采集都落未登记桶。

**取证**：`adoptShopItemsForShop`；`shop-upsert`。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 24. 修法 B：收养记忆表 `pl_shop_store_keys(store_key → shop_id)`

**结论**：收养记忆表 `pl_shop_store_keys(store_key → shop_id)`：写入时 `adoptShopItemsForShop` **无条件**写（哪怕本次 `adopted=0`——"这个桶键归这家店"是登记那一刻的结论，与桶里此刻有没有行无关）；v2 迁移按 `sk_shops` 三个身份键反查回填。读取时作为 `matchShopByStore` 的**第 4 级证据**，三级全落空后按「店名 → 归一 URL → storeId」优先级查表。`JOIN sk_shops` 是必要防线：记忆指向的店可能已被删 ⇒ 落一个悬空 `shop_id` 比落未登记桶更难发现（界面显示店名、认款却写不进去）。记忆表只在**用户已登记过该店**的前提下产生 ⇒ 仍然不自动建店、不跨店乱挂。

**取证**：`pl_shop_store_keys(store_key → shop_id)`；`adoptShopItemsForShop`；`matchShopByStore` 第 4 级证据。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 25. v2 迁移合并重复行：记忆回填 → 无主行收养 → 同款重复合并，认不出的桶一律不动

**结论**：`shop-item.main` v2 `mergeDuplicateUnregisteredRows`：① **记忆回填**：按 `sk_shops` 三键反查未登记桶 `store_key`，认得出的登记进记忆表；② **无主行收养**：桶里该店**还没有**同 `item_id` 的行 ⇒ 搬进该店，`store_key` 归一为 `''`；③ **同款重复**：该店**已经有**同 `item_id` 的行 ⇒ 已登记行的空字段 ← 未登记行的非空值、`scraped_at` 取**较新**者，然后删掉未登记那行（冗余副本）。认不出的桶**一律不动**：那是真的"店还没登记"，界面提示「店铺未登记」是正确提示，静默塞进某家店才是把两家的货混在一起。

**取证**：`shop-item.main` v2；`mergeDuplicateUnregisteredRows`。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 26. ⚠️ 迁移体里不能调 `ensureSchema()` / `ensureShopItemSchema()`（会无限递归）

**结论**：⚠️ 迁移体里**不能**调 `ensureSchema()` / `ensureShopItemSchema()`：`ensureShopItemSchema` 本身就跑 `migrate()` ⇒ 迁移体回调本函数 ⇒ 无限递归。记忆表 DDL 由 `dbMigrate(SCHEMA)` 在 `migrate()` 之前建好。

**取证**：`ensureShopItemSchema()` → `migrate()`；`dbMigrate(SCHEMA)`。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 27. ⚠️ `sk_shops` 是店铺域的表，本迁移里按 `tableExists` 缺表降级

**结论**：⚠️ `sk_shops` 是**店铺域**的表，而本迁移跑在 `ensureShopItemSchema()` 里 —— 那一层的契约是「不保证店铺域已建」。按 `db.ts` 的跨域读纪律用 `tableExists('sk_shops')` 缺表降级，而不是抛 `no such table`（那会被误读成"迁移 SQL 坏了"）。

**取证**：`tableExists('sk_shops')`。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 28. 【历史记录】被清掉的两组过期断言（「同名不自动落库」与迁移版本 `=== 1`）

**结论**：【历史记录】`shop-item-db-smoke.cjs` 的「同名不自动落库」断言 2026-10-17 就该改：那天给 `matchShopByStore` 加了**第 3 级证据（店名全等）**，口径已变（用户实测「采集的商品没归到已登记的店，把店铺名称改成和采到的一致才归位」），断言没跟着改 ⇒ 一直红。按当前口径重写为两条：**店名全等且已登记 ⇒ 归该店**；**没登记过 ⇒ 仍落未登记桶**（守住「不自动建店」）。两条迁移版本断言也从 `=== 1` 改成 `>= 1`：本域迁移是版本化追加的，写死数字会让每加一个版本这两条用例假红（"某一轮测试总数"同理，不是常量）。

**取证**：`scripts/shop-item-db-smoke.cjs`。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 29. 测试与变异：扩展 29/29（+5）、宿主新增 7 条，逐条打红后复原

**结论**：**扩展仓** `npm test`：**29/29**（新增 5 条：宿主清单生效 / 与本地台账取并集 / 查不到不阻断但留痕 / force 连宿主也不认 / 问时三键原样带上）。**宿主** `npm run shop-item:smoke`：全绿（新增 7 条：记忆命中 / 店删后记忆失效 / 记忆只经登记产生 / 重复行合并 / 认不出的桶不动 / 已采清单只列采过 SKU 的 / 已采清单覆盖未登记桶与不匹配时返回空）。**变异复核**：扩展 5 条 + 宿主 7 条逐条打红后复原。

**取证**：`npm test`（扩展仓）；`npm run shop-item:smoke`。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 30. 打不红的教训①：只看旁证字段（`fromHost`）打不红，要补双向行为断言

**结论**：**只看旁证字段**：新增用例先只断言 `walk.fromHost === 2`，变异"宿主清单不用了"照样绿——`fromHost` 只是记录字段。补**双向行为断言**（队列里真的没有 A1/A2、帧里真的只有 A3）才打红。

**取证**：`walk.fromHost === 2`。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 31. 打不红的教训②：两条路互为兜底，要先禁掉迁移回填

**结论**：**两条路互为兜底**：摘掉「登记时写记忆」后仍绿，因为 v2 迁移的回填**也**写了记忆表。补一条"先把版本记满（禁掉迁移回填）、只可能由登记产生"的用例。

**取证**：v2 迁移回填；`sk_schema_migrations`。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 32. 打不红的教训③：夹具 `reset()` 漏清新表导致记忆跨用例泄漏

**结论**：**夹具 `reset()` 漏清新表**：`reset()` 不清 `pl_shop_store_keys` ⇒ 上一条用例的记忆**跨用例泄漏**，"认不出的桶不许乱塞"那条怎么变异都不红。补进 `reset()` 才生效。（同源坑：`git stash` 对这两个文件无效——它们从未提交过，不在索引里。）

**取证**：`reset()`；`pl_shop_store_keys`。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 33. 变异脚本自身的三次翻车（"工具没跑起来"当判失败处理）

**结论**：变异脚本自身的三次翻车：`[] && x` 中空数组是 **truthy** ⇒ 第一版 M1 变异是**空操作**，报了"没打红"。反向替换把 `?` 号参数插到三元表达式位置 ⇒ TS1005/TS1127 编译失败，**不是**测试红。切片拼接写坏源文件 ⇒ `ae-receiver.ts` 报"没有导出成员"。

**取证**：TS1005 / TS1127；`ae-receiver.ts` 没有导出成员。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 34. 真机效果（用户真实库）

**结论**：用户期间自己跑了一次应用（`npm run dev` 边跑边 `tsc`），修复已在其真实库生效。只读直查 `sellerkit.db`：`pl_shop_store_keys` 已建、`sk_schema_migrations.shop-item.main = 2`；`shop_id=6（九店）= 63 条`，`shop_id=0（未登记桶）= 0 条`，重复行已消除；之后再次采集的帧 `matchShopByStore` 直接命中 `shopId=6`（不再落桶）；`listScrapedItemIds` 返回 63 条（扩展据此跳过）。

**取证**：`sk_schema_migrations.shop-item.main = 2`。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 35. 遗留（用户侧动作，不在代码里）

**结论**：九店登记的 `platform_shop_id` 填的是店名、`shop_url` 数字填错（`1105671703` ≠ 真实 `1105668759`）。记忆表能兜住归位，但**建议用户把店铺地址/ID 改对**——记忆是兜底，1、2 两级匹配才是正路。

**取证**：`1105671703` ≠ 真实 `1105668759`。

**源**：`2026-10-18-collection-dedup-and-shop-matching`（2026-10-18）

---

## 36. 认店补第五级：商品ID 反查采集快照

**结论**：店铺原文四级证据（URL / storeId / 店名 / 桶键记忆）全落空时，用**订单行本来就带着的商品ID**去 `pl_shop_items` 反查"这个商品当初归在哪家已登记店"。唯一命中才用，多店歧义/店已删一律回到"未归一"。

**取证**：四级证据；`pl_shop_items`。

**源**：`2026-10-19-shop-resolve-by-item-id`（2026-10-19）

---

## 37. 为什么非加这一级（用户报障的形状是「映射配了却不生效」）

**结论**：① 用户登记店铺时把**店名**填进了「平台店铺ID」、URL 里的数字也填错（真库九店就是这样）；② `matchShopByStore` 的 1~3 级比的都是**当前登记值**，于是恒落空；③ 第 4 级（桶键记忆）只在"用户保存店铺"那一次动作里建立，登记之后没再保存就永远没有；④ 订单侧 `resolveOrderSku` 在 `if (!shopId) return null` 处**直接返回**——手上明明握着 itemId，一次都没查过。于是症状被拆成两个互不相干的现象：订单进「未分类」、队列报「店铺未归一」。而 `pl_shop_items` 的键本来就是 `(shop_id, store_key, item_id)`：**商品ID 自己就能反证店**，这是比店名强得多的证据（店名是用户手填的，商品ID 是平台给的）。

**取证**：`resolveOrderSku` 的 `if (!shopId) return null`。

**源**：`2026-10-19-shop-resolve-by-item-id`（2026-10-19）

---

## 38. 商品ID 反查的三条纪律（都是"不猜"）

**结论**：

| 边界 | 行为 | 理由 |
|---|---|---|
| 只认 `shop_id > 0` 且 `JOIN sk_shops` 命中 | 店被删 ⇒ 不命中 | 悬空 `shop_id` 比未登记桶**更难查**（界面显示店名、认款写不进去） |
| 同一 itemId 命中**多家**店 | 返回 0（分歧即无证据） | 按 id 最小挑一个 = 让系统替人下结论，错挂还查不出 |
| 只作**末级兜底** | 原文归一成功就不查 | 人填的归一永远压过推断；也避免多一次查询 |

**取证**：`shop_id > 0`；`JOIN sk_shops`。

**源**：`2026-10-19-shop-resolve-by-item-id`（2026-10-19）

---

## 39. 与「同名唯一自动命中（`autoShopByKey`）」的差别：那条是建议，这一条是事实

**结论**：⚠️ 与「同名唯一自动命中（`autoShopByKey`）」的差别：那条是**建议**，永不自动落库（G6）；这一条是"这个商品当初就在这家店的名下"的事实记录，因此与人工归一同样当**已认店**使用。

**取证**：`autoShopByKey`；G6。

**源**：`2026-10-19-shop-resolve-by-item-id`（2026-10-19）

---

## 40. 改动落点（4 处 + 1 个纯函数参数）

**结论**：

| 位置 | 改动 |
|---|---|
| `electron/shop-item-db.ts` `shopIdByItemIds` / `shopIdByItemId` / `itemShopIndex` | 新增反向查询：批量（帧）/ 单条（订单）/ 全量索引（队列，按需加载），歧义规则三处同一 |
| `electron/shop-item-db.ts` `upsertShopItems` | 帧四级证据落空时，用**帧内 itemId** 反查；命中则 `shop_id=该店`、`store_key=''` |
| `electron/product-db.ts` `resolveOrderSku` | 认店顺序改为 人工归一 → 同名唯一 → **商品ID 反查**；`!shopKey` 不再直接判死（有 itemId 仍可认） |
| `electron/product-db.ts` `resolveShopRef` | 新增可选 `itemId` 参数，同样末级兜底（回流写映射走这一条） |
| `electron/order-db.ts` `skuBackfillFromOrder` | 把已在手的 `itemId` 传给 `resolveShopRef`（不传 = 白丢证据） |
| `electron/shopSku.ts` `buildQueueView` / `product-db.shopSkuQueue` | 队列认店加同一级（可选 `resolveShopByItemId`），**必须在剔除已关联之前**认店——否则"其实已配映射"的行还挂在待办里 |

**取证**：`shopIdByItemIds` / `shopIdByItemId` / `itemShopIndex`；`resolveShopByItemId`。

**源**：`2026-10-19-shop-resolve-by-item-id`（2026-10-19）

---

## 41. 守卫（全部实跑 + 变异验证）

**结论**：`tests/shopSku.spec.ts` +4：反查认店 / 反查后计入 `mapped` / 人工归一优先且不白查 / 反查不出仍报未归一。`scripts/shop-item-db-smoke.cjs` +3：帧无店铺身份仍归店（且新商品跟着归）/ 多店歧义落桶 / 店被删不命中。`scripts/product-sku-smoke.cjs` +5：订单**当场归款**（图挂到款色）/ `resolveShopRef` 须带 itemId / 回流不再 `shopUnresolved` / 歧义不写映射 / 队列剔除先认店。变异三条各自只红目标断言：去掉 `resolveOrderSku` 末级 ⇒ ①红；队列不用反查 ⇒ ⑤红；歧义改成 `shops[0]` ⇒ 歧义条红。

**取证**：`tests/shopSku.spec.ts`；`scripts/shop-item-db-smoke.cjs`；`scripts/product-sku-smoke.cjs`。

**源**：`2026-10-19-shop-resolve-by-item-id`（2026-10-19）

---

## 42. 它不解决什么（别把这条当万能）

**结论**：① **前提是这个商品曾在"已登记的店"里采到过**。采集行本身落在未登记桶（当时就没认出店）⇒ 反查出来还是 0。② **新商品第一次进来**时采集表里没有它 ⇒ 仍回落原文/AI，这一单还要人。③ 只解决"认店"，**不解决"多色逐色配映射"**（向导恒写 `spec='*'`）。④ 队列行不区分"原文归一"与"反查认店"（`QueueRow` 没有证据来源字段）⇒ 界面看不出这个店是怎么认出来的。要做"证据可见"得加字段 + 改 UI，本轮刻意没做。

**取证**：`spec='*'`；`QueueRow`。

**源**：`2026-10-19-shop-resolve-by-item-id`（2026-10-19）

---

## 43. 映射的身份是「店铺 + 商品ID」，平台只是副本

**结论**：`pl_shop_sku` 的匹配键从 `(platform, shop_id, item_id, spec)` 改成 **`(shop_id, item_id, spec)`**。平台列保留（作写入时刻的记录与展示兜底），但**不再参与任何判重/命中**。四处一次性改齐，少改一处就是一个新的"看着都在、一条都不命中"。

**取证**：`pl_shop_sku`；`mappingKey(platform, shopId, itemId)` → `bindingKey(shopId, itemId)`。

**源**：`2026-10-20-mapping-identity-shop-item`（2026-10-20）

---

## 44. 触发点很小，代价很大：改平台下拉之后四处全崩，且一处提示都没有

**结论**：「基础数据 › 店铺登记」里的平台是个普通下拉框（`ShopRegistryView.vue` 的 `data-act="reg-platform"`），改它没有任何提示。而映射行的 `platform` 是**写映射那一刻从店铺行抄下来的副本**（`order-db.ts` 的 `platform: shop.platform`），`sk_shops` 一行本来就只对应一个平台。副本进键的后果：

| 环节 | 改平台之后 |
| --- | --- |
| 认款 `resolveOrderSku` | 拿店铺**当前**平台去查映射行的**旧副本** ⇒ 该店全部映射一条都不命中，订单掉回未认款 |
| 待关联队列 | 队列侧用店铺当前平台拼键、已关联集合用副本拼键 ⇒ 商品被当成未关联，重新塞回待办 |
| 重配映射 | 四列键都不撞 ⇒ **新增一行**；旧行仍 `confirmed`，产品详情把两条都算进"已关联"（幽灵关联） |
| 提示 | 一处都没有。用户只看到"订单突然全认不出了" |

`normPlatform = toNameKey` **不折叠大小写**，所以 `AE` → `ae` 这种看起来没变的修改也中招。

**取证**：`ShopRegistryView.vue` 的 `data-act="reg-platform"`；`order-db.ts` 的 `platform: shop.platform`；`normPlatform = toNameKey`。

**源**：`2026-10-20-mapping-identity-shop-item`（2026-10-20）

---

## 45. 函数名换掉、少一个参数：旧名字不再存在

**结论**：`electron/shopSku.ts`：`mappingKey(platform, shopId, itemId)` → **`bindingKey(shopId, itemId)`**（函数名换了、少一个参数，旧名字不再存在 —— 免得有人照着旧签名再传平台进去）。

**取证**：`bindingKey(shopId, itemId)`。

**源**：`2026-10-20-mapping-identity-shop-item`（2026-10-20）

---

## 46. `product-db.ts` 四处匹配同时改

**结论**：`electron/product-db.ts` 四处匹配同时改：`resolveOrderSku`、`shopSkuQueue` 的 `mappedKeys`、`resolveSkuBatch`（入参还收 `platform` 但**不参与匹配**）、`upsertSkuMappings` 的判重与"改色=替换"孪生行查找。

**取证**：`resolveOrderSku`；`mappedKeys`；`resolveSkuBatch`；`upsertSkuMappings`。

**源**：`2026-10-20-mapping-identity-shop-item`（2026-10-20）

---

## 47. 平台改为从店铺派生（列表 / 汇总 / 搜索三处）

**结论**：平台改为**从店铺派生**：`mapSkuRow`（映射列表）、`skuMapSummary.byPlatform`（汇总按店铺当前平台聚合）、`listSkuMappings` 的关键字搜索（`EXISTS sk_shops ... platform LIKE ?`，店铺域未初始化时回落副本列）。

**取证**：`mapSkuRow`；`skuMapSummary.byPlatform`；`EXISTS sk_shops ... platform LIKE ?`。

**源**：`2026-10-20-mapping-identity-shop-item`（2026-10-20）

---

## 48. 新增索引 `idx_pl_shop_sku_binding`，旧索引前缀是 `platform` 会退化成扫表

**结论**：新增索引 `idx_pl_shop_sku_binding(shop_id, item_id, status)`：旧索引 `idx_pl_shop_sku_lookup` 的前缀是 `platform`，键去掉平台后那几条查询会退化成扫表。

**取证**：`idx_pl_shop_sku_binding(shop_id, item_id, status)`；`idx_pl_shop_sku_lookup`。

**源**：`2026-10-20-mapping-identity-shop-item`（2026-10-20）

---

## 49. 重配时顺手刷新 `platform` 副本

**结论**：重配时顺手刷新 `platform` 副本（`UPDATE ... SET platform = ?`）：不参与匹配，但留旧值会让看库的人以为店还在别的平台。

**取证**：`UPDATE ... SET platform = ?`。

**源**：`2026-10-20-mapping-identity-shop-item`（2026-10-20）

---

## 50. 不需要数据迁移：去掉条件只会让命中变宽

**结论**：**不需要数据迁移**：去掉条件只会让命中**变宽**。真库取证：29 条确认态映射的 `platform` 与所属店铺 100% 一致（`SELECT COUNT(*) FROM pl_shop_sku m JOIN sk_shops s ON s.id=m.shop_id WHERE m.platform <> s.platform` → 0）⇒ 新旧命中集合逐行相同，改前能认的单一单不少。

**取证**：`SELECT COUNT(*) FROM pl_shop_sku m JOIN sk_shops s ON s.id=m.shop_id WHERE m.platform <> s.platform` → 0。

**源**：`2026-10-20-mapping-identity-shop-item`（2026-10-20）

---

## 51. 取证：真库克隆 + 冒烟 2 条 + 七组变异 + 键测试翻面

**结论**：真实库克隆（只读）：`29/29` 条确认态映射仍命中；同店同商品重复行 `0` 组（⇒ 去掉平台后不会出现"多命中取谁"的歧义）；新索引在老库上由 `ensureSkuSchema` 正常补出。`npm run product:sku:smoke` 新增 2 条：改平台后 认款仍命中 / 队列仍算已关联 / 列表与汇总跟店铺走 / 按新平台搜得到 / 重配是 `updated`（不新增幽灵行）；另一条钉住"改一家店不影响别家、同商品ID 不串"。变异七组，各自只让目标断言变红：认款含平台 · 队列键含副本 · 写入判重含平台 · 列表展示用副本 · 汇总按副本分组 · 批量解析含平台 · 搜索退回副本列。`tests/shopSku.spec.ts` 的键测试随之翻面：原来"平台不同 → 不同键"改判为**平台不在键里**，并新增一条"店铺改成 temu 后仍算已关联"（旧实现下必红）。

**取证**：`npm run product:sku:smoke`；`ensureSkuSchema`；`tests/shopSku.spec.ts`。

**源**：`2026-10-20-mapping-identity-shop-item`（2026-10-20）

---

## 52. 边界：池行不受影响、跨店不串、遗留重复行有确定序

**结论**：**池行不受影响**：`skuMappingSql()` 已经把 `source='pool'` 与 `shop_id=0` 排除在外，映射行的 `shop_id` 恒 >0，所以平台确实可由店铺唯一派生。**厂商跨平台复用同一商品ID** 仍然安全：跨店不串（`shop_id` 才是那层隔离），跨平台同名店也各有各的 id。遗留的多平台重复行（若有）按 `ORDER BY (spec='*') ASC, id ASC` 定序 —— 结果确定，不随写入顺序漂。

**取证**：`skuMappingSql()`；`ORDER BY (spec='*') ASC, id ASC`。

**源**：`2026-10-20-mapping-identity-shop-item`（2026-10-20）

---

## 53. 界面消费点：登记页平台下拉是根因入口，改它没有任何提示

**结论**：「基础数据 › 店铺登记」里的平台是个普通下拉框（`ShopRegistryView.vue` 的 `data-act="reg-platform"`），改它没有任何提示 ⇒ 用户只看到"订单突然全认不出了"（同 §44 的触发面）。本轮按"平台退出键"的口径把根因入口的语义固定下来：键里没有平台，改平台不再有副作用。

**取证**：`ShopRegistryView.vue` 的 `data-act="reg-platform"`。

**源**：`2026-10-20-mapping-identity-shop-item`（2026-10-20）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-16-shop-url-raw-vs-key.md` | 2026-10-16 | §1 / §2 / §3 / §4 / §5 / §6 / §7 / §8 / §9 / §10 / §11 / §12 / §13 / §14 / §15 |
| `2026-10-18-collection-dedup-and-shop-matching.md` | 2026-10-18 | §16 / §17 / §18 / §19 / §20 / §21 / §22 / §23 / §24 / §25 / §26 / §27 / §28 / §29 / §30 / §31 / §32 / §33 / §34 / §35 |
| `2026-10-19-shop-resolve-by-item-id.md` | 2026-10-19 | §36 / §37 / §38 / §39 / §40 / §41 / §42 |
| `2026-10-20-mapping-identity-shop-item.md` | 2026-10-20 | §43 / §44 / §45 / §46 / §47 / §48 / §49 / §50 / §51 / §52 / §53 |
