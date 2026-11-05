# 订单颜色从哪来：27 条结论（蒸馏自 3 篇，2026-10-11 ~ 2026-10-20）

> **蒸馏笔记**：由 3 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/<原文件名>`

## 1. 颜色**写进了没人读的那一列**

**结论**：用户原话："当前归类核对时设置的商品颜色还是没有生效"。「颜色」在本仓有**两个存处**，而它们在数据模型里不是一回事：

| 存处 | 是什么 | 谁在读 |
| --- | --- | --- |
| `oi_orders.color` | **订单行自己的一个属性**（导入时从报表里带进来的字符串） | 归类页自己（当草稿显示 / 搜索 `LIKE`）+ `skuBackfillFromOrder` 拿它当**自动归色的提示** |
| `oi_style_colors(style_id, color)` | **颜色的真正载体**，经 `oi_images.style_color_id` 挂到图上 | **拿货**（`outstanding()` 的聚合键 `style_code + color + size`）、**算钱**、**取图**（`findStyleColorImagePath`）、**商品ID 映射回流**（`pl_shop_sku.spec`）——`purchase-db.ts:488/787` 读的都是 `sc.color AS style_color` |

归类核对的「设颜色」如果只落到第一列，那么**用户所有看得见的地方（拿货单、算钱、图）都读不到它** —— 界面一切正常、
`toast` 说「已保存」、行也离开了待核对列表。这就是「设了不生效」的全部观感。

**取证**：上述两行存处与 `purchase-db.ts:488/787`。

**源**：`2026-10-11-classify-color-not-effective`（2026-10-11）

---

## 2. 根因：`if (named && fingerprint)` —— `fingerprint` 在生产数据里**恒为空串**

**结论**：`src/modules/today/classify.ts` 的 `saveCorrection`（改前）：

```ts
const fingerprint = named || input.fieldsChanged
  ? buildStyleFingerprint(input.category, fpHint)   // = [category, ...features].filter(Boolean).join('|')
  : undefined;

await ipc.orderUpdate({ … });          // ← 颜色写进 oi_orders.color（这一步一直是好的）

if (named && fingerprint) {            // ←★ 断在这里
  await ipc.orderStyleAssign({ … });   //    挂款 / 颜色记忆 / 商品ID 回流 三件事都在里面
}
```

`buildStyleFingerprint` 会把空项都 `filter(Boolean)` 掉 ⇒ **`category` 与 `features` 都为空时它返回 `''`**，而 `''` 是 falsy
⇒ **即便用户在下拉里明确点名了款（`named` 非空），挂款链也一次都不跑**。

生产数据恰恰就是这个形状（真库实测，2026-10-11）：

```
oi_orders:   category  非空 0 / 23 行      ← 导入报表里根本没有品类列
oi_images:   result_json 全为 null         ← VLM 从没跑过 ⇒ features 恒空
⇒ buildStyleFingerprint('', []) === ''
⇒ 23 行全部「点了款、选了色、看起来保存成功、款色一点没变」
```

**取证**：上述代码块与三行读数。

**源**：`2026-10-11-classify-color-not-effective`（2026-10-11）

---

## 3. 现场取证（真库**副本** + 宿主真实写入路径）

**结论**：`sqlite3 <真库> ".backup /tmp/probe1.db"` 拿到副本，再用
`ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron <probe.cjs>`（**原生模块按 Electron ABI 编译，纯 `node` 起不来**）
调 `dist/electron/order-db.js` 走一遍真实写入。订单 #204（`SUST-006`，图 #52）：

```
[saveCorrection] named="SUST-006"  fieldsChanged=true  fingerprint=""  reclassify=false

── 改前（named && fingerprint）──
   [assignOrderStyle] 被调用? 否
   oi_orders.color          : ""      → "黑色"        ← 只有这一列变了
   oi_images#52.style_color_id: 53（未分类）           ← 没动
   oi_style_colors(SUST-006) : [ {53, 未分类, SUST-006-OTHER} ]   ← 没新建

── 改后（named）──
   [assignOrderStyle] 被调用? 是
   oi_images#52.style_color_id: 53 → 57
   oi_style_colors(SUST-006) : [ {53, 未分类, …}, {57, 黑色, SUST-006-BLACK} ]
   skuBackfill: { status:'written', spec:'黑色', reassigned:2 }   ← 同商品另外 2 单一起归好了
```

「改前」那三行就是用户看到的东西：`oi_orders.color` 变了（所以 `isDirty` 归零、界面觉得保存成功），**颜色的载体一动没动**。

**取证**：上述探针命令与输出。

**源**：`2026-10-11-classify-color-not-effective`（2026-10-11）

---

## 4. 改法一：挂款链不再被空指纹短路

**结论**：

```ts
if (named) {                        // 不再要求 fingerprint 非空
  await ipc.orderStyleAssign({ …, fingerprint });   // 空串照样传，宿主侧 `fingerprint?: string`
}
```

宿主侧本来就接受可选 `fingerprint`（`assignOrderStyle({ fingerprint?: string })`，`order-db.ts:783`）——
**拦住它的是渲染层自己那道门**，不是接口能力不够。`fingerprint` 非空时行为与改前逐字一致（记入该款、供后续自动识别命中）。

**取证**：上述代码与 `order-db.ts:783`。

**源**：`2026-10-11-classify-color-not-effective`（2026-10-11）

---

## 5. 改法二：一对「静默失败」守卫

**结论**：修完根因还剩两个口子 —— 都属于**用户以为做成了、其实什么都没发生**这一类：

| 守卫 | 症状（若不拦） |
| --- | --- |
| `colorUnattached`：填了颜色但**既没点名款、指纹又是空**⇒「保存」按不下去 + 格子里写明原因 | 保存只写 `oi_orders.color` 并把行置为已核对，`toast` 还说「已保存」。**与那 23 行真库现场同一个形状** |
| `confirmOne` / `confirmAll`：**行内有未保存改动**时不许「确认无误」（单行与批量两版，提示措辞不同） | 「确认无误」只把 `corrected` 置 1、**不写任何字段** —— 而它和「保存」就在同一格，"选了颜色直接点确认"是很自然的动作，那一下就把刚填的丢掉、行还离开了列表 |

`colorUnattached` 与既有的 `colorMissing`（有款没色）是一对：**款与色是「款 + 色」的两半，缺哪一半都不该放行**。

⚠️ 判据必须与 `saveCorrection` 用**同一个函数**（`buildStyleFingerprint`）。在这里另写一套「有没有指纹」的判断，
迟早出现「界面说能保存、保存下去什么都没发生」——就是本 bug 的第二遍。

**取证**：上述两个守卫与判据要求。

**源**：`2026-10-11-classify-color-not-effective`（2026-10-11）

---

## 6. 为什么门禁全绿却没拦住：夹具给的不是**生产形状**

**结论**：`scripts/today-ui-smoke.mjs` 的待核对夹具原先给每行都填了 `category: 'T恤'` / `features: ['圆领','短袖']`
⇒ `fingerprint` 恒非空 ⇒ **`if (named && fingerprint)` 这个洞在冒烟里永远走不到**。夹具换成生产形状
（`category: ''` + `features: []`）后，旧的 `&& fingerprint` 变异体立刻把它打红。

**通用判据（本轮最值钱的一条）**：

- 夹具的职责是复刻**生产数据的形状**，不是复刻「合理的数据」。给夹具补上生产里不存在的字段，等于**把被验的量写死**
  —— 断言恒绿，而线上必失败。
- 自问法：**「这个字段在生产数据里有几成非空？」** 如果答案是「零」，那夹具填上它就等于关掉了这条用例。
- 复核手法：把实现改回旧写法，确认它**真的变红**——本轮 M1 就是这样把「186 项、诊断 `{}`」（通道根本没被调用）打出来的，
  与用户看到的现象**逐字对应**。

**取证**：夹具原值、`186 项、诊断 {}` 读数。

**源**：`2026-10-11-classify-color-not-effective`（2026-10-11）

---

## 7. 三条守卫各守一段（改坏哪段、谁会红）

**结论**：

| 层 | 守卫 | 覆盖 |
| --- | --- | --- |
| 渲染层的**门**（`classify.ts` 的 `if (named)`） | `today:ui` **223** 的「指纹为空也照样挂款：P-45 点名 S1 + 颜色 白 ⇒ `orderStyleAssign` 被调用（带款编码与颜色，指纹为空）」 | 本轮修的那一行 |
| 渲染层的**拦**（两个守卫） | `today:ui` 的「有颜色却没款可挂」「换个行就不拦」「有未保存改动时不落库」×2 | 本轮新加 |
| 宿主侧的**写**（真库 JOIN） | 真库副本探针，`ipc:shape:smoke` 不覆盖这条 | 需人工跑一次 |

⚠️ 宿主侧那条**没有自动化守卫**（探针是一次性的，没进 `scripts/`）：改 `assignOrderStyle` 的款色写入、或改
`oi_style_colors` 唯一键，冒烟只会显示「通道被调用了」，不会发现「写歪了」。要做的话得在 `order:smoke` 里加一条
或把探针收进 `scripts/`。

**取证**：上表。

**源**：`2026-10-11-classify-color-not-effective`（2026-10-11）

---

## 8. 本轮验证：门禁读数与变异 3 条

**结论**：**门禁（逐条单看退出码）**：`vue-tsc` 0 · `tsc -p tsconfig.electron.json` 0 · `verify` 0 ·
`verify:docs` 0（**58** 条笔记全登记）· `vitest run` 689 / 37 文件 · `lint` 0 error（477 warning）· `build` 0 ·
`today:ui` **216 → 223 · SMOKE: ALL PASS** · `goods:ui` 271 ×3 · `order-profit:ui` ALL PASS。

**变异复核 3 条**（逐条打红后 `grep -rn MUTANT` 清零）：

| # | 改坏什么 | 谁变红 |
| --- | --- | --- |
| M1 | `if (named)` → `if (named && fingerprint)`（**恢复旧写法**） | 「指纹为空也照样挂款」——诊断 `{}`（通道根本没被调用），**原地复现用户现象** |
| M2 | `canAttachColor` 的指纹那一支改 `return false`（凡没点名款就拦） | 「换个行就不拦：P-41 有特征 ⇒ 不该出现这条提示」 |
| M3 | `confirmOne` 的 `isDirty(o)` 守卫拆掉 | 「单行确认在有未保存改动时不落库」+ 批量那条（两条都是守卫家族的断言） |

**取证**：上列门禁与变异表。

**源**：`2026-10-11-classify-color-not-effective`（2026-10-11）

---

## 9. 本轮踩的坑：注入脚本注释里的反引号，第 5 次

**结论**：`scripts/today-ui-smoke.mjs` 的两个大模板串内，`` `fingerprint` ``、`` `oi_orders.color` `` 这类会把模板串**提前闭合**，
而 `node --check` 报的是「**文件末尾 brace 不配**」——很难往注释想。已加扫描脚本确认模板串内无残留反引号。
**纪律：小批改、每批 `node --check`。**

**取证**：上述报错描述。

**源**：`2026-10-11-classify-color-not-effective`（2026-10-11）

---

## 10. 本轮改动文件

**结论**：

- `src/modules/today/classify.ts` —— `if (named && fingerprint)` → `if (named)` + 头注释补「这一步是颜色记忆的落点」
- `src/modules/today/tabs/ClassifyPanel.vue` —— 新增 `canAttachColor` / `colorUnattached` + `confirmOne`/`confirmAll`
  的脏改动守卫 + 「保存」禁用条件 + 格子内原因
- `scripts/today-ui-smoke.mjs` —— 夹具换生产形状（P-43 无款无品类无特征 / P-41 有特征作对照 / P-45 点名款但指纹为空）
  + 7 条新断言

**取证**：上列路径。

**源**：`2026-10-11-classify-color-not-effective`（2026-10-11）

---

## 11. 多色商品定色：订单图 = 逐单 SKU 图，用图反查采集颜色

**结论**：原计划（`ORDER_ATTRIBUTION_WEIGHT_PLAN` 的 P2）说多色商品只能靠人逐色配映射。用户提出：「采集时已经有每个店的
商品ID 和 SKU 图，订单进来通过商品ID 能定店，**通过 SKU 图应该能定色**」。前一版判断是「订单里落的是主图，不是色图，
比对不上」。**这个判断是错的**，错在取证方式：只比了「订单图 vs 采集主图」（采集主图那一列是空的，比不了）。
换两条证据就定了：

| 证据 | 做法 | 结果 |
|---|---|---|
| 订单图是**逐单**的还是整款一张 | 同一商品ID 的多条订单，数 `COUNT(DISTINCT image_id)` | `1005013246442752` 9 单 → **4 张图**；`1005012742360018` 9 单 → **6 张图**；`1005012740676378` 4 单 → **4 张图**（且只有 2 个尺码 ⇒ 不是按码变的） |
| 订单图能不能对上采集色图 | 订单图 `source_url` 与 `sku_json[].imageUrl` 逐字节比 | 能对上的 2 个商品 **2/2 命中**：订单 202 → 色 `7`、订单 209 → 色 `Khaki` |

结论：订单报表的「产品图片链接」列就是**买家所选 SKU 的色图**，不是主图。所以「按图定色」可行，而且**不需要人工逐色配映射**
（原计划 P2 的设计前提不成立，这条能力被本条取代）。

**取证**：上表（含具体商品ID、订单号、色名）。

**源**：`2026-10-19-color-by-order-image`（2026-10-19）

---

## 12. 按图定色：一处能力，四个落点

**结论**：

| 落点 | 事 |
|---|---|
| `shopSku.ts`（纯函数，可被 vitest 覆盖） | `normImageUrl`（剥查询串/锚点/`_220x220` 尺寸后缀，**不折大小写**）+ `skuColorsByImage`（一图 → **所有**命中色） |
| `shop-item-db.ts` | `skuColorByItemImage(itemId, imageUrl)`：同商品ID 的**多行**采集快照合起来判，**全局唯一**才返回 |
| `product-db.ts` | `orderColorByItemImage` = 该能力对订单域的唯一出口（订单域不直接读采集表） |
| `order-db.ts` | `autoAssignByMap` 的颜色顺序改为四级 |

**取证**：上表。

**源**：`2026-10-19-color-by-order-image`（2026-10-19）

---

## 13. 颜色权威顺序（`autoAssignByMap`）

**结论**：

1. **映射里配的颜色**（人明确说过这个商品ID 是什么色）
2. 图片**已有**的真实款色（人工纠正 / AI 结论 / 色图采纳继承）—— **一律不动**
3. **订单图 → 采集 SKU 色图** 推出来的色（本次新增）
4. 订单自身字段（实测恒空/占位）→ 5. `未分类`

② 必须排在 ③ 前面：色图采纳写的是**我的色名**（如「红色」），采集侧记的是**平台色名**（如 `Khaki`）；
让 ③ 盖掉 ② 等于把人工命名冲成平台内部编号。

**取证**：上述五级。

**源**：`2026-10-19-color-by-order-image`（2026-10-19）

---

## 14. 「定不了色」必须保持为未分类，绝不能取第一个

**结论**：多色共用一张图是真实存在的（卖家没给每色单独配图）。此时图对上是**多个**色，取第一个就是**静默错色 = 发错货**。
故 `skuColorsByImage` 返回数组、`skuColorByItemImage` 要求 `size === 1`，否则回落 `未分类`（人看一眼就好）。
同理适用于未来任何"按图/按文本猜属性"的实现：**猜错比猜不到贵一个数量级**。

**取证**：同上。

**源**：`2026-10-19-color-by-order-image`（2026-10-19）

---

## 15. 归款**不得把已有真实色冲成占位色**（顺带修掉的真 bug）

**结论**：改之前 `autoAssignByMap` 无条件 `setImageStyleColor`：图片已经从色图采纳继承了「红色」，只要映射不带色，
归款就把它写成「未分类」——**把人工/AI 的结论覆盖掉，且不回执**。现在：图片已有非占位色 ⇒ 直接返回。
这条守卫同时保护色图采纳链路。

**取证**：同上。

**源**：`2026-10-19-color-by-order-image`（2026-10-19）

---

## 16. 取证要先问「这两列是不是同一种东西」

**结论**：第一版判断错在拿「订单主图」去比「采集主图」—— 两边都叫"主图"，实际一个来自订单报表的 SKU 图列、一个是采集详情页的
封面列，而且采集那一列在本库**恒空**（比不了 ≠ 比不中）。**空列比对永远返回"不命中"，看起来和"对不上"一模一样。**

**取证**：同上。

**源**：`2026-10-19-color-by-order-image`（2026-10-19）

---

## 17. 按图定色的边界（别当万能）

**结论**：

1. **存量订单不会自己变**：`autoAssignByMap` 是写时触发的。已挂在「未分类」上的历史订单，要等该商品**下次配/改映射**
   （`reassignOrdersByItemIds` 只处理本次写入的 itemIds）才会补色。已实测：在真实库克隆上对两个商品跑回填，
   `未分类 → 7 / Khaki`，`reassigned: 2`。
2. **商品必须采到过**（`pl_shop_items` 有它且 `sku_json` 带 `imageUrl`）；没采到 ⇒ 仍走「订单原文色 → 未分类」。
3. **平台把主图当订单图**时会出错：同一商品的所有订单共用一张图 ⇒ 都归到那一张图所属的色。本库实测 AE 报表是逐单 SKU 图
   （见 §11 表），换平台需重新验这一条。
4. 颜色名取的是**平台色名**（`7` / `Khaki` / `printing 04`），不是我的产品色名（`黑色`）。两套命名暂时并存：平台色名用于
   "这单是哪一色"，产品色名用于出货/克重。要把它们**对应起来**是下一步（载体天然现成：`pl_shop_sku.variant_id`，
   按平台色反查我的变体）。

**取证**：上述四条。

**源**：`2026-10-19-color-by-order-image`（2026-10-19）

---

## 18. 按图定色的验收（逐条单看退出码）

**结论**：

- `tests/shopSku.spec.ts` +**6 例**（`normImageUrl` 3 + `skuColorsByImage` 3），文件内共 37 例
- `product:sku:smoke` +**4 条**：①按图归到对应色（含带查询串的图）②多色共用一图 → 未分类 ③映射色压过图色 ④已有真实色不被冲掉
- **变异四条各只红目标**：去掉按图推导 → ①红；歧义取第一个 → ②红；图色压过映射色 → ③红；去掉真实色守卫 → ④红
- `tsc` / `vue-tsc` / `verify`（新增两个跨域符号已登记）/ `verify:docs` / `build` / `vitest` 全过
- 真实库克隆端到端：`未分类 → 7 / Khaki`（件数为 2）

**取证**：上列命令与读数。

**源**：`2026-10-19-color-by-order-image`（2026-10-19）

---

## 19. 现象：订单的颜色一直就在报表里（真库 51 单）

**结论**：

| 状态 | 行数 |
| --- | --- |
| 归到真实色 | 4 |
| 挂占位色「未分类」 | 35 |
| 完全没归色 | 12 |

44 单落「未分类」意味着**不同颜色的订单在拣货单上长得一模一样** —— 这不是"数据不好看"，是发错色的直接来源。追下去发现：
颜色唯一来源是「订单图 → 采集 SKU 色图」，而这 44 单的商品**从没被采集过**（`pl_shop_items` 里没有行）⇒ 那条路恒空。
可报表里明明写着：

```
【1】<标题>
(产品属性:Color:5,Size:5XL,Ships From:China Mainland)
(产品数量:1 piece)
```

`Color:5` 就是平台色名（`1..15` / `Khaki` / `Picture color4` 都是这种写法），跟图一点关系都没有。以前 `oi_orders.color`
恒空，是因为**没人解析过这段文本**。

**取证**：上表与报表原文块。

**源**：`2026-10-20-order-attr-color`（2026-10-20）

---

## 20. 取数口径：`parseOrderPropsColor`

**结论**（`electron/aeMoney.ts`）：

1. 有独立「颜色」列（`颜色` / `color` / `colour`）⇒ 以列值为准（一列一值，天然没歧义）；
2. 否则扫承载规格的列（`产品信息` / `商品信息` / `规格` / `属性` / `sku props`），取里面**所有** `Color:<值>`
   （全角冒号也认），按 `colorAliasKey` 等值去重；
3. **去重后只剩一个才返回**；0 个或 2+ 个一律 `''`。

真库分布正好用得上这条规则：**49/51 单唯一**，**2 单一单多色**（同一张订单含 4 个 SKU 行、颜色 `10` 与 `6`）——
那 2 单必须定不出来。取第一个 = 静默错色。

三条纪律：

- **不看图、不依赖采集**：采集通道的订单 `image_id` 恒空、采集没覆盖的商品没有色图，这条路才是它们的唯一出路；
- **不校验"像不像颜色"**：`1..15` 这种纯编号是正当平台色名，黑名单式校验会误伤且不报错（同 `normalizeSkuSize`）；
- **不接采集帧格式**（`Picture color+XXXL+China Mainland` 没有冒号）：那是 `parseSkuProps` 的地盘，两条口径不混。

**取证**：上述三步与 `49/51`、`2 单`读数。

**源**：`2026-10-20-order-attr-color`（2026-10-20）

---

## 21. 归色顺序补第四级：报表规格串

**结论**（`autoAssignByMap`）：映射里配的色 → 图片**已有**真实色（不动）→ 订单图反查采集色 → **报表规格串** →
已有平台色名 → `未分类`。

规格串刻意排在「按图反查」**之后**：图那条有采集快照作证据、同一份快照还能定克重；两者都在时以图为准 ⇒
**以前能定的行一个都不变**，这一级只多救回以前定不了的行。`insertOrder` 同时把平台色名写进 `oi_orders.color`
（这一列的既有语义就是"订单上的平台色名"，`dataHealth` 拿它当"订单上的颜色：5 / 10"的辨认提示）。

**取证**：上述顺序说明。

**源**：`2026-10-20-order-attr-color`（2026-10-20）

---

## 22. 「认一次色」的原文来源补了第二级

**结论**：`rememberColorFromAssignment` 以前只从采集侧取原文（`orderColorByItemImage`）。没有采集快照的商品（本机 44/51 单）
⇒ 原文恒空 ⇒ **用户认了色也记不下**，下一批照样落 `5`，人工量不随时间递减。现在原文 = 采集色 ‖ 报表规格串色。

⚠️ 仍然是**外部事实**：绝不取 `oi_orders.color` —— `saveCorrection` 先写订单再点名款，拿它当 from 就是"键与目标同值"，
永远记不下（这条纪律上一轮已经踩过）。

**取证**：同上。

**源**：`2026-10-20-order-attr-color`（2026-10-20）

---

## 23. v5 回填（存量单）

**结论**：`order.main` v5：`SELECT ... WHERE TRIM(COALESCE(color,'')) = ''` → `parseOrderPropsColor` → UPDATE 该列。

- **只补空值**：已有值要么是采集帧逐行解析的、要么是人工核对写下的结论，迁移不许覆盖人的结论；
- 不碰 `raw_fields` / `updated_at`（原文保真，回滚只是一条 UPDATE）；
- **迁移里不跑重放**：本步骤跑在 `ensureOrderSchema` 的 `ensureProductSchema()` 之前，款色表还没保证存在；
  重放仍由进页自愈（`replaySkuMappings`）负责。

真库克隆实测：回填 **49 单**，随后重放补上 **32 行**归属，「未分类」**35 → 5**。

**取证**：上述 SQL 与回填读数。

**源**：`2026-10-20-order-attr-color`（2026-10-20）

---

## 24. 连带修掉：映射指向已删产品 ⇒ 队列里"看起来已关联"

**结论**：回填+重放后仍有 11 单认不出，原因不在颜色：**2 条映射指向已删除的产品 `9802`**（映射行不随产品删除消失，
没有外键级联），而 `resolveOrderSku` 把这种映射当**未命中**（绝不替人猜一个产品）。可队列与批量解析按映射表算「已关联」
⇒ 这些商品**连待办都不进**，用户看到"11 单认不出、却没有一处能点"。

修法：`product-db.shopSkuQueue` 与 `resolveSkuBatch` 的映射集合 `JOIN pl_products`（只算产品还在的），与 `resolveOrderSku`
同一口径。点名款能直接改对它 —— `upsertSkuMappings` 本来就按 `(平台, 店铺, 商品ID, spec)` **整行替换**，不依赖产品 id 是否还在。

**取证**：上述 `9802` 与 11 单。

**源**：`2026-10-20-order-attr-color`（2026-10-20）

---

## 25. 报表规格串定色的守卫

**结论**：

- `tests/aeMoney.spec.ts`（+9）：唯一色 / 属性顺序无关 / 全角冒号 / 同色多行 / 大小写等价 / **多色 → 空** / 颜色列优先 /
  采集帧格式不接 / `propsColorTokens` 取全量。
- `product-sku-smoke`（+4）：报表规格串定色①（无采集快照也能定，且认一次后同款自动翻译）、②（一单多色保持未分类）、
  v5 只补空值、映射悬空回到待办。
- 变异（各只红目标断言）：去掉第四级 → ①红；多色取第一个 → ②与单测红；回填不限空值 → v5 红；不从句外学对照 → ①红；
  队列 / 批量各去掉 `JOIN` → 悬空那条分别红。

**取证**：上列用例与变异。

**源**：`2026-10-20-order-attr-color`（2026-10-20）

---

## 26. 报表规格串定色的边界

**结论**：

- **一单多色**：色不可定，落「未分类」（人工）。
- 没有规格串 / 采集帧格式：不归这条链路。
- 剩下 14 单的构成（真库）：11 单悬空映射（点名款即可）、2 单「十五店」还没配映射、1 单是被忽略的噪声店名。

**取证**：上述 `14 单` 构成。

**源**：`2026-10-20-order-attr-color`（2026-10-20）

---

## 27. 下一步（本轮没做，先说清）：改店铺「平台」会静默废掉该店全部映射

**结论**：`pl_shop_sku.platform` 在写映射那一刻从店铺实体抄下来，而 `normPlatform` 就是 `toNameKey`（只折叠空白/不可见字符，
**不折叠大小写**）—— 把店铺平台从 `ae` 改成 `aliexpress`（或 `AE`）之后，`resolveOrderSku` 用新平台去查 ⇒ 全部不命中，
映射列表里看着还在、订单一条都认不出。真库现在 9 家店都是 `ae`，所以还没炸。修法与「悬空映射」同一思路：平台改了就同批
把映射行的平台一起搬过去（要在 handler 层编排，别让 `shop-db` 直写产品域的表）。

**取证**：上述 `normPlatform` 与 9 家店读数。

**源**：`2026-10-20-order-attr-color`（2026-10-20）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-11-classify-color-not-effective.md` | 2026-10-11 | §1–§10 |
| `2026-10-19-color-by-order-image.md` | 2026-10-19 | §11–§18 |
| `2026-10-20-order-attr-color.md` | 2026-10-20 | §19–§27 |
