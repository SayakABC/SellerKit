# 「拿货单」明细表改列：图片 + 款色合并 + 行图取图链路

日期：2026-10-10（当日第五轮，前四轮见 `2026-10-10-picking-merged-into-purchase.md` /
`2026-10-10-purchase-tab-rework.md` / `2026-10-10-purchase-card-grid.md` /
`2026-10-10-purchase-note-removal.md`）

## 用户口径（这是要求，不是现状描述）

「拿货单中，列表中展示**图片、款色、尺码、建议、实拿、单价、金额**」——
明细表从 `款编码 | 款式名 | 颜色 | 尺码 | 建议 | 实拿 | 单价(元) | 金额(元)` 收敛为
**图片 / 款色 / 尺码 / 建议 / 实拿 / 单价(元) / 金额(元)**（+ 操作列）。

- 款编码 · 颜色两个输入并进「款色」一格（数据与出参一字未动，只是排版）；
- 款式名保留为该格下的**只读灰字**（权威在产品库 / ADR-002 D1，不在编辑器里编辑）；
- 手工加行 / 取最近价 / 删行 / 合计口径 原样。

## 结论 1：取图复用「主进程唯一实现」，口径不搬家

- 新通道 `purchase-style-images`（`purchase-handlers`）按「款编码 + 款色」批量查本地图路径，
  直接复用 **`order-db.findStyleColorImagePath(styleCode, color)`** —— 拿货单 **xlsx 导出**
  早就用的同一个函数（JOIN `oi_styles → oi_style_colors → oi_images`，`ORDER BY i.id DESC LIMIT 1`）。
  新增的只是"渲染层够得着"这一跳，挑选口径没有第二份。
- 渲染层拿到本地路径后，再走**既有** `orderImageThumbBatch` 出缩略图（`maxEdge:96`）。
  ⚠️ **图真的出来要两条通道串起来**：只断言任何一条都只看到一半（冒烟断言到 `<img>` 解码为止）。

## 结论 2：`undefined` / `null` / string 三分态（否则打开瞬间整表闪假「缺图」）

`imgPaths` 的键值必须三态分清楚：**`undefined` = 还没查 / `null` = 查过确实没有 / string = 有图**。
把"还没查"当"没有"⇒ 抽屉打开的那一帧整表显示「缺图」，随即又跳成图 —— 用户看到的是"这软件在骗我"。

## 结论 3：图是装饰，失败必须静默；但刷新时机不能被早退挡住

- `resolveImages()` 整体 try/catch 吞掉：查不到 / 查挂了都只是空占位，**绝不拦录入与保存主链路**。
- ⚠️ `onCodeChange` 里 `resolveImages(...)` 必须放在**"有价就早退"之前** —— 否则用户已填单价时改款色，
  早退顺带把取图也挡掉了（改动看着生效了，图却还是旧的）。

## 结论 4：缓存断言 = 计数，不是"看着对"

只查"还没查过的对"（`key in imgPaths` 跳过）。守卫写法：改款色 → 再改回来 ⇒ 断言
**`purchaseStyleImages` 的调用数没涨**（`calls=N before=N`）。"图又出现了"本身不是证据 —— 重新请求也能让它出现。

## 冒烟（`today:ui`，非空转设计）

- **不对称夹具**：`S1 · 黑` 有图 / `S9 · 黑` 无图 —— 少了任一边，"永远有图"或"永远缺图"都会蒙对。
- `pue-img-1` 断言 `naturalWidth > 0`（空壳 `<img>` 也"有 img"）。
- payload 断言：`purchaseStyleImages` 收到 `{styleCode:'S1', color:'黑'}`（假桥记调用参数）。
- **变异确认**：表头改字 + 取图 todo 恒空 ⇒ **5 条针对性断言全红**（列集合 / 取图 / 行图 / S9 / 缓存）。
- ⚠️ **v-model 文本输入要发 `input` + `change` 两个事件**：v-model 听 `input`，而 `@change`
  处理器是另一个（只发 `change` 会让处理器读到**旧值**）。
- ⚠️ **断言顺序**：改款色会触发 `onCodeChange`，若此时单价为空会**自动查历史价**、污染既有
  `calls('purchasePriceHistory')[0]` 断言 ⇒ 改码往返放在「取最近价」断言**之后**（那时已有价、早退不查）。

## shape smoke ⑨ 段：为什么值得单加

风险与 `orderImageThumbBatch` 事故**同形**：preload 若没把 `items` 透传出去 ⇒ 主进程按空表处理 ⇒
回来一串 `null` ⇒ **每行都显示「缺图」，console 一条错都不报**（"真的没图"与"通道坏了"界面无法区分）。

- ⑨ 段 = 真 preload + 真 handler + 真库 JOIN：逐项对位（命中 / 没图 / 空款编码 / 款不存在）·
  载荷真的带 5 项 items · 空清单给空数组 · 501 项截断到 500。
- **变异**：preload 的 `items` 改成恒空 ⇒ 3/4 条红（"空清单"那条本就只测不炸，不受影响 —— 属预期）。

## 计数

- `today:ui` 175 → **181**（+6）· `ipc:shape:smoke` 30 → **34**（+4）·
  `verify` 190/186 → **191/187**（+1 通道 `purchase-style-images`）。
