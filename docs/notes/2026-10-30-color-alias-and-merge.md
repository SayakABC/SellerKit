# 颜色别名与色名合并：43 条结论（蒸馏自 3 篇，2026-10-19 ~ 2026-10-24）

> **蒸馏笔记**：由 3 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/<原文件名>`（`<原文件名>` 见文末合并清单）

## 1. 平台侧色名与自家色名之间没有可计算的对应关系，不要再试图"从平台色推我的色"

**结论**：订单/采集里的颜色是**平台侧字符串**，真库实测三类：`Khaki`、`Photo color`、`1`…`15`。款色库里是自家色名（`黑色` / `卡其`）。**两者之间没有可计算的对应关系** —— 数字色名连语义都没有，所以不要再试图"从平台色推我的色"（上一轮已证伪，见 `2026-10-19-weight-key-drops-color.md`）。

**取证**：真库实测平台侧三类色名 `Khaki`、`Photo color`、`1`…`15`；款色库侧为 `黑色` / `卡其`；上一轮证伪见 `2026-10-19-weight-key-drops-color.md`。

**源**：`2026-10-19-color-alias-by-product`（2026-10-19）

---

## 2. 唯一可行的路径是"人认一次、机器复用"，入口要放在本来就要做的动作里

**结论**：唯一可行的路径是**人认一次、机器复用**。但"专门去配一遍"确实太重（一个款 5~8 个色要逐个填），所以入口放在**本来就要做的动作**里：归类核对时把颜色改掉、点名款保存 —— 这一对当场记下。

**取证**：一个款 5~8 个色要逐个填 ⇒ 专门配一遍太重；入口 = 「归类核对改色名」+「点名款保存」这两个已有动作。

**源**：`2026-10-19-color-alias-by-product`（2026-10-19）

---

## 3. 记忆粒度 = 产品（`pl_products.id`），不是平台也不是商品

**结论**：记忆粒度 = **产品**（`pl_products.id`），不是平台也不是商品。

**取证**：
- 平台级（`Khaki → 卡其`）会串 —— 同平台色名在不同款上未必同一叫法，影响面是全店；
- 商品级最安全但费工 —— 同款在真实库常有 3~9 个商品ID，要一件件配；
- **产品级**居中：同一款衣服的 `Khaki` 就是同一个色，配一次覆盖该款全部商品与订单。

**源**：`2026-10-19-color-alias-by-product`（2026-10-19）

---

## 4. 没配过对照的色名原样落库，不许因为"查不到翻译"就丢成 `未分类`

**结论**：没配过对照的色名**原样落库**，不许因为"查不到翻译"就丢成 `未分类`（那会把"没配置"伪装成"没颜色"）。

**取证**：`autoAssignByMap` 的翻译只在字典命中时发生；未命中保持原色名落库（落点见 §5）。

**源**：`2026-10-19-color-alias-by-product`（2026-10-19）

---

## 5. 落点：纯函数 / 新表 / 各调用点各管什么

**结论**：颜色别名的落点共六处 —— `electron/colorAlias.ts` 纯函数、`oi_color_aliases` 新表、`autoAssignByMap` 翻译、`assignOrderStyle` 学习、`reassignOrdersByItemIds` 回填、`ClassifyPanel.colorAliasNote` 说明。

**取证**：

| 位置 | 作用 |
| --- | --- |
| `electron/colorAlias.ts` | 纯函数：`colorAliasKey`（大小写/空白/全角折叠）、`pickColorAlias`、`translateColor` |
| `oi_color_aliases` | 新表 `(product_id, alias_key) UNIQUE`；`alias_raw` 只为展示 |
| `autoAssignByMap` | ③按图定色 / ④订单原文色 → 落库前翻译；①映射色不翻译（人工填的已是自家名） |
| `assignOrderStyle` | 学习：原始色名**只从采集侧取**（`orderColorByItemImage`），返回 `colorAlias` 供界面说明 |
| `reassignOrdersByItemIds(ids, { colors })` | 配好对照后回填同商品历史订单（只认调用方显式点名的平台色名） |
| `ClassifyPanel.colorAliasNote` | toast 说清"以后这个名字都叫 X"（静默生效的规则最难查） |

**源**：`2026-10-19-color-alias-by-product`（2026-10-19）

---

## 6. 边界①：学习时不能拿订单自己的 `color` 当"原文"

**结论**：学习时不能拿订单自己的 `color` 当"原文"。

**取证**：`saveCorrection` 的顺序是「先 `orderUpdate` 写 `oi_orders.color`（新值）→ 再 `orderStyleAssign`」，此时订单行的 color 已经是用户填的自家名，拿它当 from ⇒ 键与目标同值，永远记不下东西（`rememberColorAlias` 里 `colorAliasKey(want) === key` 直接 return null）。

**源**：`2026-10-19-color-alias-by-product`（2026-10-19）

---

## 7. 边界②：`import` 的原始色名必须来自采集快照，不是订单字段

**结论**：`import` 的原始色名必须来自采集快照，不是订单字段；定不出就不学。

**取证**：真库里 `oi_orders.color` 有相当比例是空或占位；能定色的证据是**订单图 → `sku_json[].imageUrl` 反查**（2/2 逐字节命中，见 `2026-10-19-color-by-order-image.md`）。定不出就不学（`raw === ''` → return null）—— 记一对猜的对照，会影响该款**以后所有**订单，比不记危险得多。

**源**：`2026-10-19-color-alias-by-product`（2026-10-19）

---

## 8. 变异取证：每条只让目标断言变红；两层过滤是冗余保护而非重复实现

**结论**：字典层的 `WHERE product_id` 与纯函数层的产品判定是**冗余保护**，不是重复实现 —— 想验证"隔离存在"必须两层一起变异。

**取证**：

| 变异 | 结果 |
| --- | --- |
| `autoAssignByMap` 不调 `toOwnColor` | 色名对照 ①② 全红（`'Khaki' !== '卡其'`） |
| `rememberColorFromAssignment` 不写库（`remembered = null`） | 只有 ① 红（`colorAlias` 实际 `null`）—— ②是直接调 `rememberColorAlias`，本就不测学习链路 |
| 字典查询去掉 `WHERE product_id` + 纯函数去掉产品判定（**两层全拿掉**） | ② 红（`'卡其' !== 'Khaki'`，被别的款带跑） |
| 只拿掉其中一层 | **全绿** —— 两层过滤是冗余保护，不是重复实现；想验证"隔离存在"必须两层一起变异 |

**源**：`2026-10-19-color-alias-by-product`（2026-10-19）

---

## 9. 已知未做：存量库里已落成平台色名的款色不会在配好对照的瞬间改名

**结论**：存量库里已经落成平台色名的款色（`oi_style_colors.color = 'Khaki'`）**不会**在配好对照的瞬间改名：只有走到归款链路（新订单 / 该商品被回填）的图才会翻译。要整体洗一遍需要另做一次迁移，而"哪些 `Khaki` 属于哪一款"在款色表里没有产品维度，强洗会跨款误改。

**取证**：`oi_style_colors` 表上没有产品维度 ⇒ 无法判断某个 `Khaki` 属于哪一款；翻译只在归款链路（`autoAssignByMap` / 回填）上发生。

**2026-10-30 补充**：整体洗仍不是自动的，但有了人工入口 ——「基础数据 › 产品管理 › 颜色」里把存量色名拖并到正确的色上，合并会真改款色 / SKU / 别名（见 §10）。

**源**：`2026-10-19-color-alias-by-product`（2026-10-19）

---

## 10. 已落地（2026-10-30 更新）：字典有了人工管理界面，且支持同色异名合并

**结论**：这一条原先记的是"字典没有人工管理界面，只能靠核对时学习"——**已于 2026-10-30 补上**：
「基础数据 › 产品管理 › 颜色」页签把**字典 ∪ 业务表里出现过的色名**摊在一张板上（带来源徽标与用量），
**拖一行到另一行 = 把前者并进后者**（落点色名保留）。合并**真改业务数据**（不是只记别名）：
款色 / SKU / 两套别名一起归到保留色，之后统计与展示都按归一后的颜色与名称走，§9 里"存量款色不会自动
改名"的缺口现在有了人工洗法（按色逐一合并即可）。

**取证**：编排层 `electron/color-merge.ts` 的 `mergeColors` 在一个事务内改写 `md_color_aliases` /
`md_colors` / `oi_color_aliases` / `oi_style_colors`（含 `oi_order_items`、`oi_variant_keys`、`oi_item_parts`
的引用）与 `pl_variants`；界面 `ColorPanel.vue` 拖后 `loadColorDict(true)` + 重拉板。守卫见
`master-data-db-smoke.cjs` `[10]`、`preload-ipc-shape-smoke.cjs` ⑬c、`master-data-ui-smoke.mjs` 的 `colors` step。
学习入口仍然保留（§2）：本页只是让"不用等到下次核对也能改"。

**源**：`2026-10-19-color-alias-by-product`（2026-10-19）；2026-10-30 按本轮实施更新。

---

## 11. 色图在订单域是按「款编码 + 色名」查的，而抽屉里的色名是被直接改的标签

**结论**：色图在订单域是按「款编码 + 色名」查的（`order-db#findStyleColorImagePath` → `oi_styles.code` + `oi_style_colors.color` → `oi_images`）。而产品抽屉里那一行的色名是 `v-model="r.color"` 直接改的标签 —— **每敲一个字，查询就落空一次**。

**取证**：`order-db#findStyleColorImagePath` 的查询键 = `oi_styles.code` + `oi_style_colors.color`；产品编辑抽屉 `ProductEditorDrawer.vue` 的色名单元格用 `v-model="r.color"` 直接绑定。

**源**：`2026-10-23-color-rename-keeps-image`（2026-10-23）

---

## 12. 【历史记录】旧实现把"查不到"当成"这张图作废"，于是图当场消失

**结论**：【历史记录】旧实现（`ProductEditorDrawer.vue#applyColorImages`）把"查不到"当成"这张图作废"：`if (row.imageUrl !== url) row.imageUrl = url`，`url` 为空就写成空 ⇒ 图当场消失。而库里那张图**还好端端挂在款色上**；界面把它抹掉纯属自伤。（此实现已被 §13 的"只补不撤"取代。）

**取证**：旧代码 `if (row.imageUrl !== url) row.imageUrl = url`；库里 `oi_images.style_color_id` 对应的图并未删除。

**源**：`2026-10-23-color-rename-keeps-image`（2026-10-23）

---

## 13. 现在只**补**不**撤**：查到才换，查不到/查询失败一律保留行上原有的图

**结论**：现在只**补**不**撤**：查到才换（库里有另一张图，说明这个色名确实对应别的图），查不到/查询失败一律保留行上原有的图。与 2026-10-20 拿货单那条同源：**色名会变，别拿它当身份**（`findStyleColorImagePath` 的 id 优先分支就是这么来的）。

**取证**：
- 旧行为不是"可能"，是可复现的：把 `if (url && row.imageUrl !== url)` 改回 `if (row.imageUrl !== url)`（= 旧实现）后 `npm run goods:ui` 立刻红：`FAIL 改色名后行头色图仍在 … | src=missing`。改回新实现 ⇒ `PASS … | src=data:image/gif;base64,…`。
- 夹具口径：`goods-ui-smoke.mjs` 的 `purchaseStyleImages` 只对 `S1 + 黑` 返回图，所以"改成库里没有的名字（深蓝）"正是"查询落空"这一态；等 700ms 是为了让防抖重查真的跑完（只判同步状态会漏掉"重查回来又清空"这种写法）。
- 为什么不在 `loadColorImages` 里直接不写 `colorImages = {}`：那个清空是**必要的**——它保证"库里的结论"不会混着上一轮的缓存；本轮的判据是"命中才写行"，清缓存与清显示分开。

**源**：`2026-10-23-color-rename-keeps-image`（2026-10-23）

---

## 14. 改名后防抖 400ms 重查一次

**结论**：改名后**防抖 400ms 重查一次**：改色名有两种意图 —— ①同一个色换个说法（图不变）；②改成一个库里已有、且有自己那张图的色（图该换成新的）。只有库能回答是哪一种。逐键查库既慢，异步回来的顺序还会乱贴。

**取证**：防抖 400ms；冒烟等 700ms 才断言（覆盖重查回来的那一态，见 §13 取证第二条）。

**源**：`2026-10-23-color-rename-keeps-image`（2026-10-23）

---

## 15. 保存后重拉（`loadSkus`）按 **SKU id** 把旧图带到新行，不按色名

**结论**：保存后重拉（`loadSkus`）也要把图续上：`matrixPlan` ①② 保证改名是**原地改**（`pl_variants.id` 不变），所以按 **SKU id** 把旧图带到新行（`carryRowImages`），不按色名 —— 按色名再查必然落空。

**取证**：`matrixPlan` 的 `updates` 保持 `pl_variants.id` 不变；`carryRowImages` 以 SKU id 为键搬运图。

**源**：`2026-10-23-color-rename-keeps-image`（2026-10-23）

---

## 16. 【历史记录】`carryRowImages` 只在本次抽屉会话内有效，重开仍显示空占位

**结论**：【历史记录】`carryRowImages` 只在本次抽屉会话内有效 —— **关掉抽屉再打开**，图的来源只剩"按新色名查库"，而库里那张图还挂在**旧色名**的款色行上，所以重开仍会显示空占位。这条已按用户裁定（**款色一起改名**）补上，见 §18（第二落点）。

**取证**：重开抽屉后图只剩"按新色名查库"一条来源；库里图挂在旧色名的 `oi_style_colors` 行上。

**源**：`2026-10-23-color-rename-keeps-image`（2026-10-23）

---

## 17. 第二落点：保存 SKU 矩阵那一刻把订单域的款色**一起改名**（`id` / `code` / 图全不动）

**结论**：保存 SKU 矩阵那一刻，把这一款的色行**改名**：`oi_style_colors.color` 改成新名字，`id` / `code` / `oi_images.style_color_id` 全都不动 ⇒ 图跟着 id 走，拿货/拣货按款色 id 分组的历史行也不受影响。

**取证**：通道 `style-color-rename`（`electron/order-handlers.ts`）→ `order-db#renameStyleColorByCode`，payload `{ productId, styleCode, from, to }`；改名成功后顺手 `rememberColorAlias(productId, from, to)`。

**源**：`2026-10-23-color-rename-keeps-image`（2026-10-23）

---

## 18. 改名的三条边界：目标已存在 ⇒ 拒绝；不重算 `code`；款/色行找不到 ⇒ 什么都不做

**结论**：三条边界 —— 目标色名已是一个色行 ⇒ **拒绝**（`target-exists`，两色合并要人看图决定，不能由"改成同名"隐式发生）；**不重算 `code`**（历史派生值、表上全局 UNIQUE，重算一次就可能去撞别的色行，把改名变成失败）；款/色行找不到 ⇒ 什么都不做（`no-style` / `no-color`），老库还没这个色是常态。

**取证**：`renameStyleColorByCode` 的三种返回：`target-exists` / `no-style` / `no-color`；`oi_style_colors.code` 为全局 UNIQUE 的历史派生值。

**源**：`2026-10-23-color-rename-keeps-image`（2026-10-23）

---

## 19. 旧名只能取自 `MatrixPlan.updates[].prevColor`，不能保存后回读 `variants`

**结论**：旧名从哪来 —— `MatrixPlan.updates[].prevColor`，算差异那一刻读到的 `pl_variants.color`。⚠️ 不能保存后回读 `variants`：写路径会把颜色改掉，回读到的是新名 ⇒ 判成"没改名"、同步静默不执行。真机上这条同样脆——别依赖"本地那份是旧的"。

**取证**：本轮**实测踩到**：假桥返回的是夹具对象的引用，写一次 upsert `variants[i].color` 就变新名了。

**源**：`2026-10-23-color-rename-keeps-image`（2026-10-23）

---

## 20. 色名同步失败不拦保存

**结论**：失败不拦保存：SKU 已经写进库，色名同步只是显示与后续归色的辅助；失败时界面照旧能看，只是重开后那一行没有图（比把一次成功的保存报成失败好）。

**取证**：保存流程不因 `style-color-rename` 通道失败而中断；失败后果 = 重开后该行无图。

**源**：`2026-10-23-color-rename-keeps-image`（2026-10-23）

---

## 21. 守卫 `color-rename-sync` 四步

**结论**：守卫（`goods:ui` 的 `color-rename-sync` 步）钉住"改名只在保存时发生、且取的是改名前的真实值"。

**取证**：① 只改名字**没点保存** ⇒ 一次 `styleColorRename` 都不能有；② 保存时发 `{productId:1, styleCode:'S1', from:'黑', to:'深蓝'}`；③ 保存后（库里已是新色名）行头图仍在；④ 再改回去发的 `from` 是"深蓝"（说明取的是改名前的真实值，不是写死的）。

**源**：`2026-10-23-color-rename-keeps-image`（2026-10-23）

---

## 22. 【历史记录】前两条落点只覆盖了"已有 SKU 原地改名"，并入的新行走 `creates` ⇒ 色名同步一次都没发出去

**结论**：【历史记录】上面两条落点只覆盖了"已有 SKU 原地改名"（`MatrixPlan.updates`）。用户实际操作是**从采集商品并入 → 改色名 → 保存**，那几行在 `pl_variants` 里还没有 id ⇒ 走 `creates`，于是色名同步一次都没发出去。（本轮已修，见 §23。）

**取证**：真库实证（`~/Library/Application Support/seller-kit/sellerkit.db`，只读查询）：

| 查询 | 结果 | 含义 |
| --- | --- | --- |
| `pl_variants where product_id=9807` | 新增 8 行「深蓝」，id **404–411**（全为最大 id） | 保存时走的是**新增**，不是原地改 |
| `oi_style_colors where style_id=42` | `未分类,1,2,3,4,5,6,7,8` | 订单域色名是**平台色号**，产品侧是中文名 |
| `oi_images` 最近一批 | 5 张，`style_color_id` 指向色名 `1,2,3,4,5`，`created_at=23:04:57` | 图挂在"导入时采纳到的那几个色行"上 |
| `oi_color_aliases where product_id=9807` | **空** | 改名请求一次都没发生（不是失败，是没发） |
| 按 `SUST-004 + 深蓝` 查图 | `[]` | 重开抽屉必然空 |

**根因**：`renameStyleColors` 只遍历 `plan.updates`。并入的行 `variantId=0`，改色名后仍然匹配不到任何 `pl_variants` 行 ⇒ `creates`。而 `SkuCreate` 里**根本没有"原色名"这个字段** —— 信息在并入那一刻就丢了（`mergeSkuMatrix` 新建行时 `imageUrl: ''`，色名会被用户改）。

**源**：`2026-10-23-color-rename-keeps-image`（2026-10-23）

---

## 23. 第三落点：新增行也要改名 —— `srcColor` / `prevColor` / 失败要说话

**结论**：`SkuMatrixRow.srcColor` 记下并入时的色名并一路带到 `SkuCreate.prevColor`，`renameStyleColors` 先收 `creates` 再收 `updates`、按 `(from,to)` 去重；失败不再静默，回执要点名"哪几行色图重开后会空"。

**取证**：
- `SkuMatrixRow.srcColor`（`src/lib/skuMatrix.ts`）：`mergeSkuMatrix` 新并入的行记下**并入时的色名**，此后用户改 `color` 它不变；不写进 `sku_json`（`toSkuFlat` 不带它）。
- `SkuCreate.prevColor`：算差异时把 `row.srcColor` 带进 plan；`renameStyleColors` 的 `pairs` 先收 `creates` 再收 `updates`，按 `(from,to)` 去重（一行多码只发一次）。
- 失败不再静默：`renameStyleColors` 返回 `{renamed, failed[{from,to,reason}]}`，保存后 `toast(..., 'error')` 点名"哪几行色图重开后会空" —— 静默失败的下场就是用户再报一次"图又没了"。

**源**：`2026-10-23-color-rename-keeps-image`（2026-10-23）

---

## 24. 夹具同时修了一个假绿灯：upsert 桩静默忽略新增、静态图分不出"按色名查"与"图跟着色行走"

**结论**：`scripts/goods-ui-smoke.mjs` 同时修掉一个假绿灯 —— `productVariantUpsert` 桩原来**只改已有 id、没有 id 就静默忽略**，`purchaseStyleImages` 原来只认 `S1 + 黑`，两处都会让新增路径恒绿。

**取证**：
1. `productVariantUpsert` 桩原来**只改已有 id、没有 id 就静默忽略** —— 新增路径永远看不见行，守卫第一次跑就撞上：改名请求发出去了，行却不在库里（重拉后消失）。现在按真机语义 push 新行并回 `created:true`。
2. `purchaseStyleImages` 从"只认 `S1 + 黑`"改成维护 `STYLE_COLOR_WITH_IMG` 集合：`shopItemImageFetch` 采纳时加入色名、`styleColorRename` 成功时把旧名换成新名 —— 复刻"图挂在款色行上，色行改名后 id 与图都不动"。静态一张图分不出"按色名查"与"图跟着色行走"。

**源**：`2026-10-23-color-rename-keeps-image`（2026-10-23）

---

## 25. 守卫 `import-rename-sync`：并入改名后，重开抽屉图仍在

**结论**：新增行的改名同步由 `import-rename-sync` 步钉住，且必须断言到"关掉抽屉再打开"这一层。

**取证**：守卫（`import-rename-sync` 步）：并入 → 把「红」改成「深红」→ 保存，断言 ① `styleColorRename` 收到 `{from:'红', to:'深红'}`（旧实现这里是空数组）；② 保存后该行色图仍在；③ **关掉抽屉再打开**仍在（这一条只能靠库里按新色名查得到）。

**源**：`2026-10-23-color-rename-keeps-image`（2026-10-23）

---

## 26. 已经丢的那批图不做自动对齐，只能由人指认一次

**结论**：库里没有"深蓝原来叫色号几"的记录 —— 采集里 9 个色的尺码集合完全一样（`S…4XL` 各 7 个），靠尺码/顺序猜会猜错色、发错货。所以不做自动对齐，补偿只能由人指认一次（重新导入那一色 → 在矩阵里把新行改名成产品现有色名 → 保存，本次修复会把图带过去）。

**取证**：采集侧 9 个色的尺码集合完全相同（`S…4XL` 各 7 个）⇒ 无区分特征；补偿路径 = 重新导入该色 → 矩阵里把新行改名成产品现有色名 → 保存。

**源**：`2026-10-23-color-rename-keeps-image`（2026-10-23）

---

## 27. 门禁（2026-10-23 实跑）

**结论**：2026-10-23 全量门禁通过，含新增的三组守卫；两处变异回旧实现 ⇒ 对应断言红。

**取证**：`vue-tsc --noEmit` 0 · `tsc -p tsconfig.electron.json` 0 · `verify`（preload 212 / types 212 / 主进程 207，`✅ IPC 契约一致`）· `verify:docs` · `build` 通过 · `goods:ui`（宽 / 默认 / 窄，共三遍）ALL PASS，含新增 `改色名后行头色图仍在`、`color-rename-sync` 四步与 `import-rename-sync` 五步；两处变异回旧实现 ⇒ 对应断言红（`src=missing` / `renames=[]`）。

**源**：`2026-10-23-color-rename-keeps-image`（2026-10-23）

---

## 28. "改了名 / 删了色，SKU 就没了"不是丢格

**结论**：**「改了名 / 删了色，SKU 就没了」不是丢格**。探针把整段流程走了一遍（并入 → 改第 1 个色名 → 改最后一个 → 删最后一个），每一步的「格数 / ✓ 数 / 克重输入框数」都原样保持（`checked: 4 → 4 → 4 → 2`，最后一步少的就是被删那一行的 2 格）。改色名在数据层只是改标签，`cells` 一个都不动。

**取证**：`checked 4 → 4`、`weightInputs 4 → 4`（改色名前后，格与克重都在）；`checked 4 → 2`（删一色后，只少被删那一行的 2 格）。

**源**：`2026-10-24-color-merge-and-palette`（2026-10-24）

---

## 29. 真正缺的是"把两行并成一行"这条路，不是"修一个丢数据的 bug"

**结论**：真正缺的是"把两行并成一行"这条路。用户能想到的做法只能是"把一行改名成另一行的名字"，而保存校验会拦下（`颜色「黑」出现了两行 —— 先合成一行再保存`）。被拦下之后如果关掉抽屉（放弃改动），此前"并入矩阵"的一切都没落库 ⇒ 合起来就读成"改了名就没了"。⇒ 这轮补的是**合并**，不是"修一个丢数据的 bug"。

**取证**：保存校验拦截文案 `颜色「黑」出现了两行 —— 先合成一行再保存`；"放弃改动并关闭"会整体丢弃未落库的并入结果。

**源**：`2026-10-24-color-merge-and-palette`（2026-10-24）

---

## 30. 拖色合并：色 chip 拖到另一个 chip 上松手 = 前者的格搬进后者、前者消失

**结论**：**拖色合并**：把色 chip 拖到另一个 chip 上松手 = 前者的格搬进后者、前者消失（`mergeMatrixColor`）。阈值 6px：小于它算点击（点输入框 / ✕ / 缩略图要照旧）。

**取证**：拖合并（藏青只留 M/250，黑只留 L/320）⇒ `rows 2 → 1`、`weights 320,250`、回执「搬 1 格」、脏计数 1；纯点击（不移动）⇒ `rows` 不变（阈值生效）。

**源**：`2026-10-24-color-merge-and-palette`（2026-10-24）

---

## 31. 常用色一排排在「颜色」上面：点一下加一色，已在矩阵的打勾变灰且不会加第二行

**结论**：**常用色一排排在「颜色」上面**：10 个服装高频色，点一下加一色；已经在矩阵里的**打勾变灰**，再点**不会加第二行**（只把焦点递到那一行的输入框）—— 于是这一排同时回答"还差哪些色没加"。

**取证**：常用色一排 10 个；已在矩阵的「黑」带 `is-in`（打勾）；藏青色块 `rgb(47, 59, 94)`；再点已在的色 ⇒ `rows 2 → 2`，焦点落在那一行的 `ed-color` 输入框；规格区高度：加了常用色一行后 `spec 150 → 178`（守卫线 200，8 色 5 码仍看得见 12 行）。

**源**：`2026-10-24-color-merge-and-palette`（2026-10-24）

---

## 32. 合并的落库语义：搬的是同一个格对象，`variantId` 跟着走

**结论**：**合并的落库语义**（这是它安全的原因）：搬的是**同一个格对象**，`variantId` 跟着走 ⇒ 保存时那些 SKU 是"原地改色名"，不是"删旧建新"（编码与状态都在）。同码冲突保留**目标行**那一格，但克重取有值的一方；源侧那条 SKU 会随保存删掉 —— 回执把这件事说出来（`… 5 个同码格以「藏青」为准（保存后少 5 个 SKU）`）。

**取证**：拖合并后 `rows 2 → 1`、`weights 320,250`；回执文案 `… 5 个同码格以「藏青」为准（保存后少 5 个 SKU）`；变异（见 §34）逐条钉住 `variantId` 与克重的搬运。

**源**：`2026-10-24-color-merge-and-palette`（2026-10-24）

---

## 33. 全量判据与冒烟/单测数字

**结论**：2026-10-24 一轮的判据由下表与三条门禁数字共同钉住。

**取证**：

| 判据 | 数字 / 现象 |
| --- | --- |
| 改色名前后 | `checked 4 → 4`、`weightInputs 4 → 4`（格与克重都在） |
| 删一色后 | `checked 4 → 2`（只少被删那一行的 2 格） |
| 拖合并（藏青只留 M/250，黑只留 L/320） | `rows 2 → 1`、`weights 320,250`、回执「搬 1 格」、脏计数 1 |
| 常用色 | 一排 10 个；已在矩阵的「黑」带 `is-in`（打勾）；藏青色块 `rgb(47, 59, 94)` |
| 再点已在的色 | `rows 2 → 2`，焦点落在那一行的 `ed-color` 输入框 |
| 纯点击（不移动） | `rows` 不变（阈值生效） |
| 规格区高度 | 加了常用色一行后 `spec 150 → 178`（守卫线 200，8 色 5 码仍看得见 12 行） |

- 冒烟：`goods:ui` 新步 `sku-color-merge`（10 条断言，含"造数"自检一条），**371 项 × 三遍 ALL PASS**。
- 单测：`tests/skuMatrix.spec.ts` **54** 例（新增 6 条合并用例）、`tests/colorSwatch.spec.ts` **8** 例（新增"常用色每一项都认得出、彼此不重复"）。`vitest` 45 文件。
- 截图：`goods:shot` 新增拖到一半（`sku-matrix-merging-*.png`）与松手后（`sku-matrix-merged-*.png`）两张 —— 这条交互只有"拖到一半"和"回执"两个状态看得见，别的都靠猜。

**源**：`2026-10-24-color-merge-and-palette`（2026-10-24）

---

## 34. 变异：证明新断言不是空转

**结论**：五条变异各只红对应断言，证明合并相关的断言不是空转。

**取证**：

| 变异 | 结果 |
| --- | --- |
| `mergeMatrixColor` 搬格时新建格对象（丢 `variantId`） | 只红「搬过去的那一格自己带的 variantId 也要跟着走」 |
| 删掉"同码冲突时把源行克重带过来" | 只红「搬过来的格保留 variantId」（克重那半） |
| 删掉"源行独有的码补进 sizes" | 只红「源独有的码跟着走…」 |
| 组件里 `matrix.value = res.matrix` 注释掉 | 红 4 条（合并没生效的连锁），含"合并保留克重""进待保存" |
| `hasColor` 恒 false | 只红「常用色…已经在矩阵里的打勾」 |

**源**：`2026-10-24-color-merge-and-palette`（2026-10-24）

---

## 35. 坑：空格里没有克重输入框，冒烟一律用 `[data-cell-row][data-cell-size]` 定位

**结论**：空组合只有一个虚线按钮（`v-else`），`.mx-weight` 只存在于"在卖"的格上。冒烟里按下标取 `querySelectorAll('.mx-weight')[1]` 会拿到 `undefined`（报错还是 `Cannot read properties of undefined (reading 'tagName')` —— 看着像选择器坏了）。一律改用 `[data-cell-row][data-cell-size]` 定位。

**取证**：报错原文 `Cannot read properties of undefined (reading 'tagName')`；定位改用 `[data-cell-row][data-cell-size]`。

**源**：`2026-10-24-color-merge-and-palette`（2026-10-24）

---

## 36. 坑：冒烟注入脚本是模板串，注释里一个反引号就把整段截断

**结论**：那条注释里顺手写了「用 `[data-cell-row][data-cell-size]` 定位」，反引号直接把注入脚本截断，Node 报 `ReferenceError: data is not defined`。这一条已在工程铁律里，但**写"定位方式"这类注释时最容易顺手带上反引号**。

**取证**：Node 报错 `ReferenceError: data is not defined`；触发点 = 模板串注释中的反引号。

**源**：`2026-10-24-color-merge-and-palette`（2026-10-24）

---

## 37. 坑：不用 HTML5 拖放，也不用 pointer capture

**结论**：色 chip 里有 `<input>`，`draggable` 会和"拖选文字"抢事件；合成事件（冒烟/截图脚本）里 `setPointerCapture` 会抛 `InvalidStateError`，且捕获会把 move 全锁在源元素上。合并目标就在同一个容器里 ⇒ 监听挂容器 + `elementFromPoint` 命中 `[data-mx-row]` 足够。

**取证**：`setPointerCapture` 在合成事件下抛 `InvalidStateError`；命中判据 `[data-mx-row]` + `elementFromPoint`。

**源**：`2026-10-24-color-merge-and-palette`（2026-10-24）

---

## 38. 坑：回执文案不许换行，回执出现时顶掉图例

**结论**：`.mx-bar` 是 `flex-wrap: wrap`，回执一长就把图例挤到第二行 ⇒ 下面矩阵整体下移十几像素，看着像界面错位。修法不是缩字号，而是**回执出现时顶掉图例**（两者都是次要说明）+ 单行截断（全文进 `title`）。

**取证**：`.mx-bar` 为 `flex-wrap: wrap`；修法 = 回执与图例互斥显示 + 单行截断（全文进 `title`）。

**源**：`2026-10-24-color-merge-and-palette`（2026-10-24）

---

## 39. 坑：常用色的每个词都必须在色卡词表里（单测钉住）

**结论**：否则调色板会出现一排"没有色块的文字"，比不画色块更让人以为是坏了。

**取证**：`tests/colorSwatch.spec.ts` **8** 例，含"常用色每一项都认得出、彼此不重复"。

**源**：`2026-10-24-color-merge-and-palette`（2026-10-24）

---

## 40. 不做：改名撞到已有色名 ⇒ 自动合并

**结论**：**不做"改名撞到已有色名 ⇒ 自动合并"**：敲字过程中会瞬间路过别人的名字，自动合并等于按一次键就能毁掉一行数据。撞名仍拦下，但文案改成指路（"把一行拖到另一行上合并成一色"）。

**取证**：撞名拦截文案改为 `把一行拖到另一行上合并成一色`（指路，不自动合并）。

**源**：`2026-10-24-color-merge-and-palette`（2026-10-24）

---

## 41. 不做：合并不可撤销（保存前可放弃），不单开 undo

**结论**：**合并不可撤销（保存前可放弃）**：抽屉里的改动本来就靠"放弃改动并关闭"整体回退，不为此单开一步 undo。

**取证**：整体回退入口 = 「放弃改动并关闭」抽屉。

**源**：`2026-10-24-color-merge-and-palette`（2026-10-24）

---

## 42. 不做：不给调色板做"取色器"

**结论**：**不给调色板做"取色器"**：色名是外部事实（平台色名 / 采集色名），颜色值只是识别辅助。

**取证**：常用色色块（如藏青 `rgb(47, 59, 94)`）仅作识别辅助，不作为色名来源。

**源**：`2026-10-24-color-merge-and-palette`（2026-10-24）

---

## 43. 用户口径与轮次背景

**结论**：本轮由用户口径驱动 —— 「是否可以把常用颜色放在上面，通过拖动颜色方式来合并？当前将并入的颜色名称修改后或删除后，下面已存在的 SKU 信息就没了。」（2026-10-24 第三轮）。

**取证**：用户原话见上；入口形态 = 常用色一排（§31）+ 拖色合并（§30）。

**源**：`2026-10-24-color-merge-and-palette`（2026-10-24）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-19-color-alias-by-product.md` | 2026-10-19 | §1 / §2 / §3 / §4 / §5 / §6 / §7 / §8 / §9 / §10 |
| `2026-10-23-color-rename-keeps-image.md` | 2026-10-23 | §11 / §12 / §13 / §14 / §15 / §16 / §17 / §18 / §19 / §20 / §21 / §22 / §23 / §24 / §25 / §26 / §27 |
| `2026-10-24-color-merge-and-palette.md` | 2026-10-24 | §28 / §29 / §30 / §31 / §32 / §33 / §34 / §35 / §36 / §37 / §38 / §39 / §40 / §41 / §42 / §43 |
