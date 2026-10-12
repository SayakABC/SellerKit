# 拿货单明细的图为什么「都是一样的」—— 取图粒度必须跟着行粒度走

日期：2026-10-11（当日第四轮，前序见 `2026-10-11-shipping-desk-naming-and-daily-scope.md` /
`2026-10-11-today-import-dropzone.md` / `2026-10-11-cost-page-slimming.md` /
`2026-10-11-today-pages-design.md` / `2026-10-11-today-tab-revert.md`）

用户原话（附了单号）：

> 拿货单中的图片为什么都是一样的？拿货单明细的图片应该使用的是**订单 Excel 中解析出来的图片**，
> 例如：订单 1123192657411338，存在多个商品，需要**按顺序对应**。

## 结论：不是图错了，是**挑图的口径比行粗一层**

| | 粒度 |
| --- | --- |
| 订单 Excel 解析出来的图 | **订单行**（`oi_orders.image_id` → `oi_images.local_path`，就是那一件商品的「产品图片链接」） |
| 拿货单明细行 | **款色 × 尺码**（`outstanding()` 的聚合键 = `purchase_items` 唯一键 `(purchase_id, style_code, color, size)`） |
| 取图函数（改前） | **款色**（`findStyleColorImagePath(styleCode, color)` + `ORDER BY i.id DESC LIMIT 1`） |

取图比行**粗一层** ⇒ 同一款的所有行（不同尺码、各来自不同商品）全部落到「该款色下 id 最大那张」——
而那张只对其中一行是对的。用户看到的「都一样」就是这个。

### 真库取证（只读，`~/Library/Application Support/seller-kit/sellerkit.db`）

拿货单 #32（`purchase_id=32`，明细 5 行，全是 `SUST-006 · 未分类`，尺码 S/M/L/XL/XXL）：

```
改前：5 行全部 → oi_images#52  eead0796ee0.webp      ← ORDER BY i.id DESC LIMIT 1 的唯一解
改后：S   → #48  0210feba5c8.webp
      M   → #44  ae2178bd844.webp
      L   → #45  7bd2d64d94f.webp
      XL  → #52  eead0796ee0.webp
      XXL → #48  0210feba5c8.webp
```

（S 与 XXL 同图、M 与 XL 之一同图，是因为不同订单买到了**同一个商品**（同一个 `image_id`）——
这正是「图跟着商品走」该有的结果；改前那 5 行里有 **4 行的图不是自己那件**。）

## ⚠️ 干扰项：「未分类」不是本 bug 的根因，只是放大器

真库 `oi_style_colors` 的 10 行**全是 `color='未分类'`**（颜色从未配过，是 `autoAssignByMap` 的
兜底占位名，见 `2026-10-10-mapping-recolor-backfill.md`）。这会让「同一款的所有图挤进同一个款色」，
把问题放大到整款全同图 —— 但**把颜色配齐也治不好**：同一款同色的多件商品仍会共图。
**判据：`color` 与 `size` 是两个独立的维度，缺哪个都得出「取图粒度 < 行粒度」的结论。**

## 改法：款色 + 尺码**优先**，回落款色级

`electron/order-db.findStyleColorImagePath(styleCode, color, size = '')`：

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

三条口径：

1. **用 `EXISTS` 不用 `JOIN`**：一张图会被**多个订单行**引用（同商品被多个订单买），JOIN 会把候选行
   按引用数放大，`LIMIT 1` 取到谁就变得**不确定**（同一次查询两次跑可能不同）。`EXISTS` 只回答
   "这张图有没有被该尺码用过"，一个候选一行。
2. **回落是有意的**：该尺码下没有任何订单行（手工加的行 / 订单还没导入）时退回「该款色最新图」——
   **有图仍优于缺图**。回落只作兜底，不改变"优先本行对应图"的主口径。
3. **不传 `size` 时行为与改前逐字一致**（`ORDER BY i.id DESC LIMIT 1`）⇒ 只按款色取图的调用方不受影响。

## 改动清单

| 位置 | 动作 |
| --- | --- |
| `electron/order-db.ts` | `findStyleColorImagePath` 加可选 `size`（见上）+ 头注释记取证与三条口径 |
| `electron/purchase-handlers.ts` | `purchase-style-images` 的 items 加 `size` 并传下去；`purchase-export-excel` 嵌图同样传 `it.size` |
| `electron/preload.ts` | `size` 透传（**截 50 字**，与另两个字段同款） |
| `src/types.ts` / `src/core/services/ipc.ts` | `purchaseStyleImages` 的入参加 `size?: string` |
| `src/modules/today/purchase.ts` | `styleImages()` 类型同步 |
| `PurchaseOrderEditor.vue` | `pairKey` 改 `款编码\|款色\|尺码`；`thumbOf`/`resolvedNoImage`/`resolveImages` 全带 size；`pue-size` 加 `@change="onSizeChange(r)"`（**只重查这一行的图，不碰历史价** —— 尺码与单价无关） |

⚠️ 两个细节：

- `resolvedNoImage` 的判据从 `key !== '|'` 改成 **显式判 `!r.styleCode.trim()`**：键变三段后
  `'||'` 这种字符比较会变成脆的隐式契约（"款编码没填"才是语义）。
- 改尺码**必须重查**：尺码是取图键的一部分，不给 `@change` 的话尺码改了图不跟着变（静默）。

## 冒烟：三层守卫，各守一段，缺一不可

| 层 | 文件 | 守什么 | 变异确认 |
| --- | --- | --- | --- |
| 渲染层 | `today:ui` 216 | 两行（同款同色、只差尺码）各显示**自己那件**的图（两张 `<img>` 的 src 不同） | 去掉 `pairKey` 的 size ⇒ **110/112 两条红**，诊断 `L=…393ea \| M=…393ea`（**复现用户现象**） |
| preload 层 | `ipc:shape:smoke` 37 | preload 真的把 size 透下去 + 载荷逐项带尺码 | `size: ''` ⇒ **2 条红**（诊断 `paths=[size-m.png, size-m.png]`） |
| SQL 层 | `ipc:shape:smoke` ⑨ | 真库 JOIN 下同款同色不同尺码取到不同图 + 回落行为 | 去掉 ORDER BY 的 CASE ⇒ **1 条红** |

⚠️ **`purchase:xlsx:smoke` ⑤b 段（+3 条）守的是"导出调用点把 size 传下去了"，不守 SQL** ——
那里 `findStyleColorImagePath` 是 **stub**。变异"改坏 SQL"时它**照样绿**，所以已在该段注释里写明边界；
SQL 口径只有 ⑨ 段守得住。**"绿了"要先问它绿的是哪一段**。

### 夹具侧的两处必要改法

1. **假桥必须按路径给不同的缩略图**（`svgThumb(localPath)` 生成 8×8 不同色的 SVG dataUrl）：
   原先 `orderImageThumbBatch` 对**每一条**都回同一条 GIF ⇒ 两行的 src 永远相同 ⇒
   「两行图不一样」这条守卫**恒绿**。**假桥给"所有输入同一个输出"= 把被验的量写死了。**
2. **假桥的取图路径带上尺码**（`/fake-orders/S1-hei-<size>.jpg`），并把夹具订单 #3 加一行
   `S1 · 黑 · M`（单价留空 ⇒ 金额 0，不影响既有「合计 ¥120.00」与保存断言）。

## ⭐ 可迁移判据

1. **取数粒度必须 ≥ 展示粒度**：凡是"按 X 挑一个代表"的函数，先问一句**调用方要展示的是哪一层**。
   这里展示是「款色 × 尺码」，挑图只认「款色」⇒ 必然一批行共用一张。同族：多 sheet / 多文件 /
   多版本 / 多分公司里"不存在就回落第一个"。
2. **回落要能被指出来**：本轮的回落（该尺码无订单 → 款色级）是**兜底**、不是主口径，所以它
   不能反过来定义行为（不能因为"回落也能出图"就不传 size）。
3. **"假桥对所有输入回同一个输出"是最隐蔽的空转**：它不会报错、断言全绿，而真机必然错。
   判据：给假桥两个**应当有不同结果**的输入，看断言在"实现正确/被改坏"两种情况下是否**都绿**。

## 相关

- 上一版（只按款色，本笔记**取代**其取图口径一节）：`2026-10-10-purchase-editor-columns.md`
- 「未分类」的由来与补色通道：`2026-10-10-mapping-recolor-backfill.md`
- 订单图入库链路（Excel「产品图片链接」→ `oi_images`）：`2026-10-08-order-image-into-goods.md`
- 带图 xlsx 导出的两个真 bug（`extension` / WebP）：`2026-10-05-picking-export-with-images.md`
