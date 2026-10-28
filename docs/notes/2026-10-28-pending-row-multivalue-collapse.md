# 「列表展示不全」的第二种成因：副行里摊多值文本会把行高撑成两行

**结论**：窄栏表格的副行（这里只有 ~300px 可用宽）**不能承载"多值展开"的信息**。
SKU 色码这类"条数可概括、全文可核对"的字段，**只报条数、全文进 `title`**。
"信息不降级"不等于"信息全摊在脸上" —— 摊开的代价是行高翻倍，一屏从 3 行掉到 2 行，
用户看到的第一反应就是"列表展示不全"。

**背景（2026-10-28 用户口径）**：「款与商品 › 待认」列表展示不全，SKU 改成只显示数量。

## 为什么不是"容器裁切"

`docs/notes/2026-10-03-clipped-not-missing.md` 给的默认归因是**容器裁切**（先量 `scrollWidth`）。
本次不是：表格宽度没越界（`goods:ui` 的"右栏不横向溢出"断言一直绿），
真正变化的是**纵向** —— 副行文本从 1 行变成 2 行 ⇒ 行高 ~66 → ~86px ⇒
`.gd-panel { flex: 1 }` 的可见行数从 3 掉到 2。

所以判据要按症状分开取：

| 症状 | 量什么 | 典型的错 |
| --- | --- | --- |
| 右边一截没了 | `scrollWidth > clientWidth` | `.wb-panel { overflow: hidden }` |
| 行数比预期少 | 行高（`tr` 的 `getBoundingClientRect().height`） | 副行里摊了多值文本 |

## 实现要点

- 数量与文本**同一个函数**出（`itemSkuCount()` / `itemSkuText()`），模板里不另算 ——
  否则"标签说 2 条、title 里列了 3 个色码"这种不一致没人能发现。
- `PendingRow` 同时给 `skuCount`（渲染）与 `skuText`（只作 `title`），并在字段注释里写死
  "别再把它接回副行"：上一版就是"信息不降级"这条理由把它接回去的。
- 「未采集」是**独立分支**（`!r.skuText` 才渲染），不能靠 `SKU 0 条` 顶替 ——
  "没采到矩阵"和"采到 0 条"是两件事，前者要给"重新采集详情页"的出口。

## 断言怎么写才不恒绿

`scripts/goods-ui-smoke.mjs` 那条断言必须**两个方向都钉**：

```js
// ① 可见文本里不能再出现色码串（否则等于没改）
flat(skuCount).indexOf('黑/L') < 0
// ② 全文必须还在 title 里（否则"精简"变成了"丢信息"）
skuCountTitle.indexOf('黑/L、4/M') >= 0
```

只写 ① 无法发现"title 被顺手删掉"；只写 ② 无法发现"文本又摊回去了"。
旧断言的 `data-act="pending-sku-text"` 随之改名 `pending-sku-count`（名字要说实话：
它现在报的是数量），两处一起改，没有第三个消费点（`grep -rn "pending-sku" scripts/ src/` 已核）。

## 取证

- 代码：`src/modules/goods/useSkuPool.ts`（`PendingRow.skuCount` / `pendingRows`）、
  `src/modules/goods/components/PoolPane.vue`（副行 `pending-sku-count` / `pending-sku-empty`）。
- 门禁：`npx vue-tsc --noEmit` 绿、`npm run build` 绿、`npm run goods:ui` 全绿
  （输出含 `text=· SKU 2 条 title=SKU 2 条：黑/L、4/M`）。
- 截图：`W=1200 H=800 npm run goods:shot` → `.cache/goods-shot/full-1200x800.png`。
