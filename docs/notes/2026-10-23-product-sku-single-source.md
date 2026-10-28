# 产品 SKU 只维护一套矩阵：内容来自采集商品，维护面在产品编辑抽屉

**日期**：2026-10-23 · **用户口径**：「未关联采集商品页面只认款」「把修改 SKU 矩阵的功能与产品编辑
里的 SKU 编辑合并，最终目的是产品只维护一套完整的 SKU 矩阵，矩阵来源于采集商品」。
**取代关系**：接 [`2026-10-16-sku-matrix-editor.md`](2026-10-16-sku-matrix-editor.md)（那轮把矩阵重做成
色 × 码二维、采集段与建款向导共用组件）；本轮把**维护权**从采集段收进产品编辑抽屉。
不取代任何历史笔记 —— 旧笔记描述的"当时采集段能改矩阵"是事实。

## 结论（六个落点，按可复用程度排）

1. **一条数据只能有一个维护面**。采集段的 SKU 列改成**只读文本**，行内不再有「改/补」入口；
   `shop-items-update-sku` 通道整条删除（主进程 handler → preload → `src/types.ts` →
   `src/core/services/ipc.ts` → `goods/api.ts` 五处一起删）。采集快照 `sku_json` 从此**只由采集帧写**，
   产品侧写的是 `pl_variants` —— 两份数据各归其主，不再互相回写。
2. **"按款筛采集商品"必须是服务端过滤**。`shop-items-list` 新增 `productId`，SQL 走**与列表同一份**
   `LATEST_MAP_JOIN`（最新一条 `confirmed` 映射，`ORDER BY m.id DESC LIMIT 1`），COUNT 也带同一个 JOIN。
   前端过滤会漏分页：产品编辑一次只取前 100 条候选，第 101 条之后的认款商品永远进不了导入面板。
3. **"历史认过"不等于"现在认的是它"**。同一商品改绑后，旧款的导入面板不能再列出它 —— 这是
   `LATEST_MAP_JOIN` 而不是"存在任一 confirmed 映射"的原因。测法：同一 `item_id` 为两个款各写一条
   confirmed（唯一键含 `product_id`，结构上允许），后写的那条 id 更大 ⇒ 只有新款筛得到。
4. **导入只能"补缺口"**。`mergeSkuMatrix(base, incoming)`（`src/lib/skuMatrix.ts`）的语义：
   - 已有的组合、已填的克重、SKU 编码**一个都不覆盖**（采集里的 999g 打不过产品已有的 320g）；
   - 空格只从 0 补成采集值；新色/新码只在该采集行**真有这个组合**时加，**不笛卡尔补齐**；
   - 按色名（trim 后）对齐；无变化时返回原对象引用 ⇒ 幂等、重导入不会造出第二份改动。
   纯函数 + `tests/skuMatrix.spec.ts` 9 例；夹具里必须放一个**竞争值**（999 vs 320），
   否则"覆盖式合并"与"只补缺口"在断言上长得一样。
5. **导入不是保存**。并入只改界面上的矩阵：按钮变成「保存 SKU 矩阵（N）」、抽屉的"未保存改动"
   守卫要把它算进去（关抽屉照样先确认），落库仍走原有的全量提交。导入那一刻
   `productVariantUpsert` 的调用数必须是 **0** —— 否则"导入即生效"会把用户还没看过的矩阵直接写进库。
6. **色图顺手采纳，但只补空、失败不拦**。按「采集行 id + 产品 id + 色→图（同色只取第一张）」
   调 `shop-item-image-fetch`；主进程侧仍是 `adoptStyleColorImageByCode` 的"目标色已有图就不换"。
   矩阵合并与图片采纳是两件事：图片失败只影响回执里的采纳计数，矩阵照常并入。

## 界面分工（谁写什么）

| 面 | 能做什么 | 不能做什么 |
| --- | --- | --- |
| 采集段「待关联采集商品」 | 认款（关联到已有款 / 建款向导）、删采集快照 | 改 SKU 矩阵（只读展示，色码文本 + 未采集态） |
| 产品编辑抽屉 | 维护矩阵（色/码/克重/组合）；「从采集商品导入」补缺口 | 导入不会自动保存；不覆盖已有值 |
| 建款向导（从采集商品新建款） | **建档那一刻**用采集矩阵预填 | 建档后不是维护面 —— 再改去产品编辑抽屉 |

> 向导的预填保留是刻意的：它回答"这个新款的初始矩阵长什么样"，而不是给产品开第二个长期维护入口。

## 守卫（每条都对应一种"看起来对"的坏实现）

- `npm run goods:ui` 的 `matrix-import` 步：
  - 断言请求载荷带 `productId:1` 且**不带** `onlyUnconfirmed`（复用采集段的参数会把已认款的那条候选筛掉）；
  - 候选恰为 `B0XYZ1234`（没采到 SKU）+ `1005007777777777`；未认款的 7001 / 7003 必须在列表外；
    假桥的 `shopItemsList` **真的按 productId 过滤**（只 `rec` 不过滤的桩会让"服务端过滤"恒绿）；
  - 并入后克重逐格是 `['320','150','','180']`（⭐ 只补缺口）、色图载荷只有红色一条、
    `productVariantUpsert` 为 0、导入算未保存改动（关闭先确认）。
- `npm run shop-item:smoke`：按款筛三条 —— 只列"当前认到该款"（未认款 / 认到别款 / pending 都不出现，
  `total` 与 `rows` 同口径）；改绑后旧款筛不到；`0 / NaN` 视为不过滤。
  ⚠️ `NaN` 也是 `typeof 'number'`，不拦会绑进 SQL 直接抛。
- `npm run ipc:shape:smoke`：`productId > 0` 原样透传；`productId=0` 在载荷里必须是 `undefined`
  （主进程的 0 = 不过滤，压成 0 就与"认到 0 号款"分不开）；返回行确实只含认到该款的那一条。
- `tests/uxEntryNames.spec.ts`：文案里的引号名必须是真入口。本轮踩到两处 ——
  ①写「采集商品」段（真名是**待关联采集商品**，已按同组分段控件登记豁免，存在性由 `goods:ui` 钉）；
  ②写「颜色 › + 添加」这种**控件路径**：`entryParts` 会按 ` › ` 拆段逐段校验，段名不是入口就红 ⇒
  改成"用颜色栏的「+ 添加」"（引号里只留按钮文字）。

## 踩坑

- **注入脚本是独立作用域**：`goods:ui` 的假桥里 `var PL_ITEM_SKU_IMG = …`，断言脚本（另一段
  `<script>`）直接引用会 `PL_ITEM_SKU_IMG is not defined`。跨段传值走 `window.__smokeImg.itemSku`
  （与 `__smokeProductImg` / `__smokeLongStyleName` 同法）。
- **导入步骤必须"放弃"而不是"保存"**：后面的 `weight-save-in-drawer` 步断言第一次
  `productVariantUpsert` 的载荷就是它自己那一格；导入若顺手保存，这条会被一次全量提交污染成假红。
  收尾走 `.ed-x` → 确认框「放弃改动并关闭」，并断言此刻 SKU 写入仍是 0。
- **删一条通道不是删一个方法**：`shop-items-update-sku` 在 handler / preload / types / ipc 服务 /
  `goods/api.ts` 各有一份；少删一处 `npm run verify` 会红（这是它的价值），但**载荷形状**它看不见，
  故按款筛的透传另由 `ipc:shape:smoke` 钉。

## 门禁（2026-10-23 实跑）

`lint` 0 error（521 warning）· `verify`（preload 211 / types 211 / 主进程 206）· `verify:docs` ·
`vue-tsc --noEmit` · `tsc -p tsconfig.electron.json` · `vitest` 45 文件 / 872 用例 ·
`build` · `goods:ui`（宽 / 默认 / 窄三遍 ALL PASS）· `shop-item:smoke` 全绿 ·
`ipc:shape:smoke` 53 项全绿。`schema:smoke` 未跑：本轮没有表形状 / 迁移改动。
