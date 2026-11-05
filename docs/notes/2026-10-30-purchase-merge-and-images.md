# 拿货取图粒度与第三轮并卡：19 条结论（蒸馏自 2 篇，2026-10-11 ~ 2026-10-17）

> **蒸馏笔记**：由 2 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/<原文件名>`

## 1. 拿货单明细的图「都是一样的」：不是图错了，是**挑图的口径比行粗一层**

**结论**：用户原话（附了单号）：「拿货单中的图片为什么都是一样的？拿货单明细的图片应该使用的是**订单 Excel 中解析出来的图片**，例如：订单 1123192657411338，存在多个商品，需要**按顺序对应**。」

| | 粒度 |
| --- | --- |
| 订单 Excel 解析出来的图 | **订单行**（`oi_orders.image_id` → `oi_images.local_path`，就是那一件商品的「产品图片链接」） |
| 拿货单明细行 | **款色 × 尺码**（`outstanding()` 的聚合键 = `purchase_items` 唯一键 `(purchase_id, style_code, color, size)`） |
| 取图函数（改前） | **款色**（`findStyleColorImagePath(styleCode, color)` + `ORDER BY i.id DESC LIMIT 1`） |

取图比行**粗一层** ⇒ 同一款的所有行（不同尺码、各来自不同商品）全部落到「该款色下 id 最大那张」——而那张只对其中一行是对的。用户看到的「都一样」就是这个。

**取证**：改前取图 = `findStyleColorImagePath(styleCode, color)` + `ORDER BY i.id DESC LIMIT 1`；行粒度 = `purchase_items` 唯一键 `(purchase_id, style_code, color, size)`。

**源**：`2026-10-11-purchase-image-by-size`（2026-10-11）

---

## 2. 真库取证：拿货单 #32 五行对照

**结论**：改前 5 行全部落到同一张图；改后按尺码各取到自己的那件（S 与 XXL 同图、M 与 XL 之一同图，是因为不同订单买到了**同一个商品**（同一个 `image_id`）—— 这正是「图跟着商品走」该有的结果；改前那 5 行里有 **4 行的图不是自己那件**）。

**取证**（只读，`~/Library/Application Support/seller-kit/sellerkit.db`）：拿货单 #32（`purchase_id=32`，明细 5 行，全是 `SUST-006 · 未分类`，尺码 S/M/L/XL/XXL）：

```
改前：5 行全部 → oi_images#52  eead0796ee0.webp      ← ORDER BY i.id DESC LIMIT 1 的唯一解
改后：S   → #48  0210feba5c8.webp
      M   → #44  ae2178bd844.webp
      L   → #45  7bd2d64d94f.webp
      XL  → #52  eead0796ee0.webp
      XXL → #48  0210feba5c8.webp
```

**源**：`2026-10-11-purchase-image-by-size`（2026-10-11）

---

## 3. ⚠️ 干扰项：「未分类」不是本 bug 的根因，只是放大器

**结论**：真库 `oi_style_colors` 的 10 行**全是 `color='未分类'`**（颜色从未配过，是 `autoAssignByMap` 的兜底占位名）。这会让「同一款的所有图挤进同一个款色」，把问题放大到整款全同图 —— 但**把颜色配齐也治不好**：同一款同色的多件商品仍会共图。**判据：`color` 与 `size` 是两个独立的维度，缺哪个都得出「取图粒度 < 行粒度」的结论。**

**取证**：真库 `oi_style_colors` 的 10 行全是 `color='未分类'`；兜底占位名来自 `autoAssignByMap`。

**源**：`2026-10-11-purchase-image-by-size`（2026-10-11）

---

## 4. 改法：款色 + 尺码**优先**，回落款色级

**结论**：`electron/order-db.findStyleColorImagePath(styleCode, color, size = '')`：

```sql
SELECT i.local_path
FROM oi_styles s
JOIN oi_style_colors sc ON sc.style_id = s.id
JOIN oi_images i ON i.style_color_id = sc.id
WHERE s.code = ? AND sc.color = ?
  AND i.local_path IS NOT NULL AND i.local_path <> ''
ORDER BY
  CASE WHEN ? <> '' AND EXISTS (
    SELECT 1 FROM oi_orders o WHERE o.image_id = i.id AND o.size = ?
  ) THEN 0 ELSE 1 END,
  i.id DESC
LIMIT 1
```

**取证**：函数签名 `findStyleColorImagePath(styleCode, color, size = '')`，SQL 如上（`CASE WHEN ? <> '' AND EXISTS (...) THEN 0 ELSE 1 END` + `i.id DESC`）。

**源**：`2026-10-11-purchase-image-by-size`（2026-10-11）

---

## 5. 三条口径：用 `EXISTS` 不用 `JOIN` · 回落是有意的 · 不传 `size` 行为逐字一致

**结论**：
1. **用 `EXISTS` 不用 `JOIN`**：一张图会被**多个订单行**引用（同商品被多个订单买），JOIN 会把候选行按引用数放大，`LIMIT 1` 取到谁就变得**不确定**（同一次查询两次跑可能不同）。`EXISTS` 只回答"这张图有没有被该尺码用过"，一个候选一行。
2. **回落是有意的**：该尺码下没有任何订单行（手工加的行 / 订单还没导入）时退回「该款色最新图」—— **有图仍优于缺图**。回落只作兜底，不改变"优先本行对应图"的主口径。
3. **不传 `size` 时行为与改前逐字一致**（`ORDER BY i.id DESC LIMIT 1`）⇒ 只按款色取图的调用方不受影响。

**取证**：不传 `size` 时仍为 `ORDER BY i.id DESC LIMIT 1`；`EXISTS` 只回答"这张图有没有被该尺码用过"。

**源**：`2026-10-11-purchase-image-by-size`（2026-10-11）

---

## 6. 改动清单（六个位置）

**结论**：

| 位置 | 动作 |
| --- | --- |
| `electron/order-db.ts` | `findStyleColorImagePath` 加可选 `size`（见上）+ 头注释记取证与三条口径 |
| `electron/purchase-handlers.ts` | `purchase-style-images` 的 items 加 `size` 并传下去；`purchase-export-excel` 嵌图同样传 `it.size` |
| `electron/preload.ts` | `size` 透传（**截 50 字**，与另两个字段同款） |
| `src/types.ts` / `src/core/services/ipc.ts` | `purchaseStyleImages` 的入参加 `size?: string` |
| `src/modules/today/purchase.ts` | `styleImages()` 类型同步 |
| `PurchaseOrderEditor.vue` | `pairKey` 改 `款编码\|款色\|尺码`；`thumbOf`/`resolvedNoImage`/`resolveImages` 全带 size；`pue-size` 加 `@change="onSizeChange(r)"`（**只重查这一行的图，不碰历史价** —— 尺码与单价无关） |

**取证**：`preload.ts` 的 `size` 透传**截 50 字**；`pairKey` 改为 `款编码\|款色\|尺码`。

**源**：`2026-10-11-purchase-image-by-size`（2026-10-11）

---

## 7. 两个细节：`resolvedNoImage` 显式判 · 改尺码**必须重查**

**结论**：⚠️ 两个细节：
- `resolvedNoImage` 的判据从 `key !== '|'` 改成 **显式判 `!r.styleCode.trim()`**：键变三段后 `'||'` 这种字符比较会变成脆的隐式契约（"款编码没填"才是语义）。
- 改尺码**必须重查**：尺码是取图键的一部分，不给 `@change` 的话尺码改了图不跟着变（静默）。

**取证**：判据从 `key !== '|'` 改为 `!r.styleCode.trim()`；`pue-size` 加 `@change="onSizeChange(r)"`。

**源**：`2026-10-11-purchase-image-by-size`（2026-10-11）

---

## 8. 冒烟：三层守卫，各守一段，缺一不可

**结论**：

| 层 | 文件 | 守什么 | 变异确认 |
| --- | --- | --- | --- |
| 渲染层 | `today:ui` 216 | 两行（同款同色、只差尺码）各显示**自己那件**的图（两张 `<img>` 的 src 不同） | 去掉 `pairKey` 的 size ⇒ **110/112 两条红**，诊断 `L=…393ea \| M=…393ea`（**复现用户现象**） |
| preload 层 | `ipc:shape:smoke` 37 | preload 真的把 size 透下去 + 载荷逐项带尺码 | `size: ''` ⇒ **2 条红**（诊断 `paths=[size-m.png, size-m.png]`） |
| SQL 层 | `ipc:shape:smoke` ⑨ | 真库 JOIN 下同款同色不同尺码取到不同图 + 回落行为 | 去掉 ORDER BY 的 CASE ⇒ **1 条红** |

⚠️ **`purchase:xlsx:smoke` ⑤b 段（+3 条）守的是"导出调用点把 size 传下去了"，不守 SQL** —— 那里 `findStyleColorImagePath` 是 **stub**。变异"改坏 SQL"时它**照样绿**，所以已在该段注释里写明边界；SQL 口径只有 ⑨ 段守得住。**"绿了"要先问它绿的是哪一段**。

**取证**：`today:ui` 216；`ipc:shape:smoke` 37 / ⑨ 段；`purchase:xlsx:smoke` ⑤b 段 +3 条；诊断串 `L=…393ea \| M=…393ea`、`paths=[size-m.png, size-m.png]`。

**源**：`2026-10-11-purchase-image-by-size`（2026-10-11）

---

## 9. 夹具侧的两处必要改法

**结论**：
1. **假桥必须按路径给不同的缩略图**（`svgThumb(localPath)` 生成 8×8 不同色的 SVG dataUrl）：原先 `orderImageThumbBatch` 对**每一条**都回同一条 GIF ⇒ 两行的 src 永远相同 ⇒「两行图不一样」这条守卫**恒绿**。**假桥给"所有输入同一个输出"= 把被验的量写死了。**
2. **假桥的取图路径带上尺码**（`/fake-orders/S1-hei-<size>.jpg`），并把夹具订单 #3 加一行 `S1 · 黑 · M`（单价留空 ⇒ 金额 0，不影响既有「合计 ¥120.00」与保存断言）。

**取证**：`svgThumb(localPath)` 生成 8×8 不同色的 SVG dataUrl；路径 `/fake-orders/S1-hei-<size>.jpg`；夹具订单 #3 加 `S1 · 黑 · M`（单价留空 ⇒ 金额 0，「合计 ¥120.00」不变）。

**源**：`2026-10-11-purchase-image-by-size`（2026-10-11）

---

## 10. ⭐ 三条可迁移判据：取数粒度 ≥ 展示粒度

**结论**：
1. **取数粒度必须 ≥ 展示粒度**：凡是"按 X 挑一个代表"的函数，先问一句**调用方要展示的是哪一层**。这里展示是「款色 × 尺码」，挑图只认「款色」⇒ 必然一批行共用一张。同族：多 sheet / 多文件 / 多版本 / 多分公司里"不存在就回落第一个"。
2. **回落要能被指出来**：本轮的回落（该尺码无订单 → 款色级）是**兜底**、不是主口径，所以它不能反过来定义行为（不能因为"回落也能出图"就不传 size）。
3. **"假桥对所有输入回同一个输出"是最隐蔽的空转**：它不会报错、断言全绿，而真机必然错。判据：给假桥两个**应当有不同结果**的输入，看断言在"实现正确/被改坏"两种情况下是否**都绿**。

**取证**：判据 3 的操作化 —— 给假桥两个应当有不同结果的输入，分别跑"实现正确"与"被改坏"两种变异。

**源**：`2026-10-11-purchase-image-by-size`（2026-10-11）

---

## 11. 取代关系与相关笔记

**结论**：上一版（只按款色）的取图口径一节**被本笔记取代**：`2026-10-10-purchase-editor-columns.md`。「未分类」的由来与补色通道：`2026-10-10-mapping-recolor-backfill.md`（`autoAssignByMap` 兜底占位名）。订单图入库链路（Excel「产品图片链接」→ `oi_images`）：`2026-10-08-order-image-into-goods.md`。带图 xlsx 导出的两个真 bug（`extension` / WebP）：`2026-10-05-picking-export-with-images.md`。

**取证**：取代对象 `2026-10-10-purchase-editor-columns.md` 的取图口径一节；带图 xlsx 导出的两个真 bug 为 `extension` / WebP。

**源**：`2026-10-11-purchase-image-by-size`（2026-10-11）

---

## 12. 拿货页第三轮：「按订单」页签撤掉

**结论**：用户四条口径：页签该不该留 / 三区不协调 / 卡片信息局促（款编码不上卡）/ 卡底动作固定。

**「按订单」视图是纯重复，撤掉是对的**：每张拿货单在厂家卡"已开单"行上本就有同一套 `data-act="pu-*-${单号}"` 四动作。宫格视图唯一独有的是「新建空白单」⇒ 收进概览条右侧。以后不要再往"单子列表"方向加东西 —— 单子管理只有一个入口：厂家卡。

**取证**：厂家卡"已开单"行上的 `data-act="pu-*-${单号}"` 四动作；「新建空白单」收进概览条右侧；`tests/uxEntryNames.spec.ts`：「按订单」豁免已撤 —— 文案再写它直接红。

**源**：`2026-10-17-purchase-merge-round3`（2026-10-17）

---

## 13. 三态只靠**排序 + 瘦卡**表达

**结论**：`PickingView` 的 `orderedCards` 按 `ZONE_RANK`（pending 0 / skip 1 / done 2）稳定排序进**一个** `pu-grid`；分区信息只在 `data-zone` 属性上（冒烟按它断言顺序）。没有分区标题 —— 想恢复"区"就得同时恢复三种视觉语言，别走回头路。

**取证**：`orderedCards` 按 `ZONE_RANK`（pending 0 / skip 1 / done 2）稳定排序进一个 `pu-grid`；分区只在 `data-zone`；`scripts/today-ui-smoke.mjs` step('purchase') 里 `data-zone` 序钉死。

**源**：`2026-10-17-purchase-merge-round3`（2026-10-17）

---

## 14. 款编码的"对外/对内"分工

**结论**：`data-key`（= `款编码 · 颜色`）只是内部身份（拖拽定位 / 冒烟锚点）；界面显示走 `rowName()`（款名 → 颜色 → 未识别款），发厂内容走 `pickingSheet` 的 `SheetLine.label`（同样不含款编码）。**清单图 / 文字清单 / 卡上行**三处永远不该再出现款编码；导出带图 xlsx 是内部作业表，款编码照旧保留（别"顺手统一"把它也删了）。

**取证**：`data-key` = `款编码 · 颜色`；`rowName()`（款名 → 颜色 → 未识别款）；`SheetLine.label` 不含款编码；`tests/pickingSheet.spec.ts`：`label` 反款编码 + 文字清单「款名 · 颜色：尺码×件数」格式；冒烟行上反向守卫（无 S1 / 无 `.pu-srow__amount` / 无「无进价」）+ 文字清单全文无款编码。

**源**：`2026-10-17-purchase-merge-round3`（2026-10-17）

---

## 15. 卡底吸底 = `.pu-scard__bottom { margin-top: auto }`（含**卡盒模型地板**）

**结论**：待拿卡把"已开单 + 三个动作"包在这一块里。冒烟有几何守卫（底块下缘与卡下缘差 ≤ 12px —— **卡盒模型的地板**：padding-bottom 10 + border 1 = 11px，量的是 border-box；原 ≤2px 是拿卡下缘当内容盒下缘用，恒红）。改行结构时别把 bottom 块拆回卡身流式排。

**取证**：底块下缘与卡下缘差 ≤ 12px；地板 = padding-bottom 10 + border 1 = 11px（border-box）；原阈值 ≤2px 恒红。

**源**：`2026-10-17-purchase-merge-round3`（2026-10-17）

---

## 16. 已拿卡不折叠了

**结论**：单子行直接排在瘦卡上（含提交/导出/删除）。"折叠省视场"的旧方案靠 toggle 双向断言守着，那些断言已随视图删掉，别照旧清单跑。

**取证**：已拿卡单子行直接排在瘦卡上；旧的 toggle 双向断言已随视图删掉。冒烟另有 `!card('pu-sub')` 与"新单四动作同卡"两条。

**源**：`2026-10-17-purchase-merge-round3`（2026-10-17）

---

## 17. 守卫落点（改行为前先读）

**结论**：
- `scripts/today-ui-smoke.mjs` step('purchase')：`data-zone` 序钉死、行上反向守卫（无 S1/无 `.pu-srow__amount`/无「无进价」）、文字清单全文无款编码、吸底几何、新单四动作同卡、`!card('pu-sub')`。
- `tests/pickingSheet.spec.ts`：`label` 反款编码 + 文字清单「款名 · 颜色：尺码×件数」格式。
- `tests/uxEntryNames.spec.ts`：「按订单」豁免已撤 —— 文案再写它直接红。

**取证**：上表逐条对应 `scripts/today-ui-smoke.mjs` 的 `step('purchase')`、`tests/pickingSheet.spec.ts`、`tests/uxEntryNames.spec.ts`。

**源**：`2026-10-17-purchase-merge-round3`（2026-10-17）

---

## 18. 顺手缝掉的缝：契约④漏一处 · 下拉选中态残留

**结论**：
- 上一轮拖拽通道 `product-move-supplier` 漏契约②：`productMoveSupplier` 补进 `types.ts`（`ElectronAPI` + `ProductMoveSupplierInput`）。教训重申：契约四处（handlers/preload/types/ipc.ts），verify 只拦②、vue-tsc 只拦③，漏 ② 只有 verify 能抓。
- 概览条的厂家下拉选完会还原成 0（冒烟新加还原步）：`createFromPick` 断言按夹具起点走，残留选中态会让"默认不预选"守卫后续轮次假绿。

**取证**：`productMoveSupplier` 补进 `types.ts`（`ElectronAPI` + `ProductMoveSupplierInput`）；冒烟新增"下拉还原成 0"一步。

**源**：`2026-10-17-purchase-merge-round3`（2026-10-17）

---

## 19. 假桥返回**活引用** = 响应式静默失效（本轮最贵的一课）

**结论**：现象：忽略 S2·白 后行能进「暂不拿」区、忽略清单里也有它，灰条上的**原因**却永远不出现。三处证据互相矛盾：宿主 `ignores` 是新的（页级清单 2 条）、PickingView 的 prop 是旧的（`ignoreReasons` 只有 S9）、而 PickingView **自己取的那份**忽略清单又是新的（所以行会移走）。

根因：假桥 `purchaseIgnoreList` 把 `window.__ignores` **本尊**当 data 返回（真 IPC 结构化克隆，每次新数组）。于是：首次 load 后宿主 `ignores.value` 与 `window.__ignores` 是**同一个数组对象**；冒烟忽略时假桥对它裸 push（不触发响应式）；bump 重取后 `ignores.value = 同一引用`，被 Vue 的 `hasChanged` 判成"没变"——赋值成为空操作，`ignoreReasonMap` 计算属性永不重算。「页面其他 ref 变了 ⇒ 组件重渲染 ⇒ 模板里 `JSON.stringify(ignores)` 恰好把活数组的新内容打出来」让 hostIg 证据看起来"宿主是新的"，计算属性却还拿着旧缓存——这就是矛盾的来源。

修法与守卫：假桥一律 `data: window.__x.slice()`（复刻 IPC 克隆语义）；已在 `purchaseIgnoreList` 处写明。判据侧不用改——「灰条带原因」这条断言本身就是抓这个的。排查成本高（三层证据互相打架）⇒ 下次假桥加新通道，返回数组先问一句"克隆了吗"。

**取证**：假桥 `purchaseIgnoreList` 返回 `window.__ignores` 本尊；修法 `data: window.__x.slice()`；三处证据为宿主页级清单 2 条 / PickingView prop 只有 S9 / 自己取的那份是新的。

**源**：`2026-10-17-purchase-merge-round3`（2026-10-17）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-11-purchase-image-by-size.md` | 2026-10-11 | §1 / §2 / §3 / §4 / §5 / §6 / §7 / §8 / §9 / §10 / §11 |
| `2026-10-17-purchase-merge-round3.md` | 2026-10-17 | §12 / §13 / §14 / §15 / §16 / §17 / §18 / §19 |
