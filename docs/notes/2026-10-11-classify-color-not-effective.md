# 归类核对里「设了颜色不生效」—— 挂款链被一个字面空串整条短路

日期：2026-10-11（当日第五轮，前序见 `2026-10-11-shipping-desk-naming-and-daily-scope.md` /
`2026-10-11-today-import-dropzone.md` / `2026-10-11-cost-page-slimming.md` /
`2026-10-11-today-pages-design.md` / `2026-10-11-today-tab-revert.md` /
`2026-10-11-purchase-image-by-size.md`）

用户原话：

> 当前归类核对时设置的商品颜色还是没有生效

## 结论：颜色**写进了没人读的那一列**

「颜色」在本仓有**两个存处**，而它们在数据模型里不是一回事：

| 存处 | 是什么 | 谁在读 |
| --- | --- | --- |
| `oi_orders.color` | **订单行自己的一个属性**（导入时从报表里带进来的字符串） | 归类页自己（当草稿显示 / 搜索 `LIKE`）+ `skuBackfillFromOrder` 拿它当**自动归色的提示** |
| `oi_style_colors(style_id, color)` | **颜色的真正载体**，经 `oi_images.style_color_id` 挂到图上 | **拿货**（`outstanding()` 的聚合键 `style_code + color + size`）、**算钱**、**取图**（`findStyleColorImagePath`）、**商品ID 映射回流**（`pl_shop_sku.spec`）——`purchase-db.ts:488/787` 读的都是 `sc.color AS style_color` |

归类核对的「设颜色」如果只落到第一列，那么**用户所有看得见的地方（拿货单、算钱、图）都读不到它** ——
界面一切正常、`toast` 说「已保存」、行也离开了待核对列表。这就是「设了不生效」的全部观感。

## 根因：`if (named && fingerprint)` —— `fingerprint` 在生产数据里**恒为空串**

`src/modules/today/classify.ts` 的 `saveCorrection`（改前）：

```ts
const fingerprint = named || input.fieldsChanged
  ? buildStyleFingerprint(input.category, fpHint)   // = [category, ...features].filter(Boolean).join('|')
  : undefined;

await ipc.orderUpdate({ … });          // ← 颜色写进 oi_orders.color（这一步一直是好的）

if (named && fingerprint) {            // ←★ 断在这里
  await ipc.orderStyleAssign({ … });   //    挂款 / 颜色记忆 / 商品ID 回流 三件事都在里面
}
```

`buildStyleFingerprint` 会把空项都 `filter(Boolean)` 掉 ⇒ **`category` 与 `features` 都为空时它返回 `''`**，
而 `''` 是 falsy ⇒ **即便用户在下拉里明确点名了款（`named` 非空），挂款链也一次都不跑**。

生产数据恰恰就是这个形状（真库实测，2026-10-11）：

```
oi_orders:   category  非空 0 / 23 行      ← 导入报表里根本没有品类列
oi_images:   result_json 全为 null         ← VLM 从没跑过 ⇒ features 恒空
⇒ buildStyleFingerprint('', []) === ''
⇒ 23 行全部「点了款、选了色、看起来保存成功、款色一点没变」
```

### 现场取证（真库**副本** + 宿主真实写入路径）

`sqlite3 <真库> ".backup /tmp/probe1.db"` 拿到副本，再用
`ELECTRON_RUN_AS_NODE=1 ./node_modules/.bin/electron <probe.cjs>`（**原生模块按 Electron ABI 编译，
纯 `node` 起不来**）调 `dist/electron/order-db.js` 走一遍真实写入。订单 #204（`SUST-006`，图 #52）：

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

「改前」那三行就是用户看到的东西：`oi_orders.color` 变了（所以 `isDirty` 归零、界面觉得保存成功），
**颜色的载体一动没动**。

## 改法

### 1. 挂款链不再被空指纹短路（`src/modules/today/classify.ts`）

```ts
if (named) {                        // 不再要求 fingerprint 非空
  await ipc.orderStyleAssign({ …, fingerprint });   // 空串照样传，宿主侧 `fingerprint?: string`
}
```

宿主侧本来就接受可选 `fingerprint`（`assignOrderStyle({ fingerprint?: string })`，`order-db.ts:783`）——
**拦住它的是渲染层自己那道门**，不是接口能力不够。
`fingerprint` 非空时行为与改前逐字一致（记入该款、供后续自动识别命中）。

### 2. 一对「静默失败」守卫（`src/modules/today/tabs/ClassifyPanel.vue`）

修完根因还剩两个口子 —— 都属于**用户以为做成了、其实什么都没发生**这一类：

| 守卫 | 症状（若不拦） |
| --- | --- |
| `colorUnattached`：填了颜色但**既没点名款、指纹又是空**⇒「保存」按不下去 + 格子里写明原因 | 保存只写 `oi_orders.color` 并把行置为已核对，`toast` 还说「已保存」。**与那 23 行真库现场同一个形状** |
| `confirmOne` / `confirmAll`：**行内有未保存改动**时不许「确认无误」（单行与批量两版，提示措辞不同） | 「确认无误」只把 `corrected` 置 1、**不写任何字段** —— 而它和「保存」就在同一格，"选了颜色直接点确认"是很自然的动作，那一下就把刚填的丢掉、行还离开了列表 |

`colorUnattached` 与既有的 `colorMissing`（有款没色）是一对：**款与色是「款 + 色」的两半，缺哪一半都不该放行**。

⚠️ 判据必须与 `saveCorrection` 用**同一个函数**（`buildStyleFingerprint`）。在这里另写一套
「有没有指纹」的判断，迟早出现「界面说能保存、保存下去什么都没发生」——就是本 bug 的第二遍。

## ⭐ 为什么门禁全绿却没拦住：夹具给的不是**生产形状**

`scripts/today-ui-smoke.mjs` 的待核对夹具原先给每行都填了 `category: 'T恤'` / `features: ['圆领','短袖']`
⇒ `fingerprint` 恒非空 ⇒ **`if (named && fingerprint)` 这个洞在冒烟里永远走不到**。
夹具换成生产形状（`category: ''` + `features: []`）后，旧的 `&& fingerprint` 变异体立刻把它打红。

**通用判据（本轮最值钱的一条）：**

- 夹具的职责是复刻**生产数据的形状**，不是复刻「合理的数据」。给夹具补上生产里不存在的字段，
  等于**把被验的量写死**——断言恒绿，而线上必失败。
- 自问法：**「这个字段在生产数据里有几成非空？」** 如果答案是「零」，那夹具填上它就等于关掉了这条用例。
- 复核手法：把实现改回旧写法，确认它**真的变红**——本轮 M1 就是这样把「186 项、诊断 `{}`」
  （通道根本没被调用）打出来的，与用户看到的现象**逐字对应**。

## 三条守卫各守一段（改坏哪段、谁会红）

| 层 | 守卫 | 覆盖 |
| --- | --- | --- |
| 渲染层的**门**（`classify.ts` 的 `if (named)`） | `today:ui` **223** 的「指纹为空也照样挂款：P-45 点名 S1 + 颜色 白 ⇒ `orderStyleAssign` 被调用（带款编码与颜色，指纹为空）」 | 本轮修的那一行 |
| 渲染层的**拦**（两个守卫） | `today:ui` 的「有颜色却没款可挂」「换个行就不拦」「有未保存改动时不落库」×2 | 本轮新加 |
| 宿主侧的**写**（真库 JOIN） | 真库副本探针（本文档「现场取证」），`ipc:shape:smoke` 不覆盖这条 | 需人工跑一次 |

⚠️ 宿主侧那条**没有自动化守卫**（探针是一次性的，没进 `scripts/`）：改 `assignOrderStyle` 的款色写入、
或改 `oi_style_colors` 唯一键，冒烟只会显示「通道被调用了」，不会发现「写歪了」。
要做的话得在 `order:smoke` 里加一条或把探针收进 `scripts/`。

## 验证

**门禁（逐条单看退出码）**：`vue-tsc` 0 · `tsc -p tsconfig.electron.json` 0 · `verify` 0 ·
`verify:docs` 0（**58** 条笔记全登记）· `vitest run` 689 / 37 文件 · `lint` 0 error（477 warning）·
`build` 0 · `today:ui` **216 → 223 · SMOKE: ALL PASS** · `goods:ui` 271 ×3 · `order-profit:ui` ALL PASS。

**变异复核 3 条**（逐条打红后 `grep -rn MUTANT` 清零）：

| # | 改坏什么 | 谁变红 |
| --- | --- | --- |
| M1 | `if (named)` → `if (named && fingerprint)`（**恢复旧写法**） | 「指纹为空也照样挂款」——诊断 `{}`（通道根本没被调用），**原地复现用户现象** |
| M2 | `canAttachColor` 的指纹那一支改 `return false`（凡没点名款就拦） | 「换个行就不拦：P-41 有特征 ⇒ 不该出现这条提示」 |
| M3 | `confirmOne` 的 `isDirty(o)` 守卫拆掉 | 「单行确认在有未保存改动时不落库」+ 批量那条（两条都是守卫家族的断言） |

## ⚠️ 本轮踩的坑

**注入脚本注释里的反引号，第 5 次**（`scripts/today-ui-smoke.mjs` 的两个大模板串内）：
`` `fingerprint` ``、`` `oi_orders.color` `` 这类会把模板串**提前闭合**，而 `node --check` 报的是
「**文件末尾 brace 不配**」——很难往注释想。已加扫描脚本确认模板串内无残留反引号。
**纪律：小批改、每批 `node --check`。**

## 改动文件

- `src/modules/today/classify.ts` —— `if (named && fingerprint)` → `if (named)` + 头注释补「这一步是颜色记忆的落点」
- `src/modules/today/tabs/ClassifyPanel.vue` —— 新增 `canAttachColor` / `colorUnattached` + `confirmOne`/`confirmAll` 的脏改动守卫 + 「保存」禁用条件 + 格子内原因
- `scripts/today-ui-smoke.mjs` —— 夹具换生产形状（P-43 无款无品类无特征 / P-41 有特征作对照 / P-45 点名款但指纹为空）+ 7 条新断言
- 关联笔记：`2026-10-05-classify-auto-pipeline.md`（L0→L1→L2 归类链路总表）、
  `2026-10-05-mapping-carries-color.md`（映射带颜色 / 回流）
