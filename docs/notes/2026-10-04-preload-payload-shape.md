# 「产品页的图片没有展示」——通道名一致 ≠ 载荷形状一致

> 2026-10-04 · 结论类笔记（跨工具）
> 相关：`docs/features/MAIL_INBOX.md`（同日修的另一处图片问题）、`AGENTS.md` §6（门禁清单）

## 症状

用户报「**产品页的图片没有展示**」。

先按"没数据"排：库里的确有数据缺失 —— 27 个产品 `image_id` 全为 0、`pl_images` 空、
`product-images/` 目录都不存在、`pl_shop_sku.image_url` 全空。**但这不是全部**：同一个缩略图通道
在「映射与关联」页本该有图（订单域有 42 张带图订单 / 32 个 `order-images` 文件，三层回落实测能解析到
真实 webp 路径），那里也是空的。所以问题在**通道**，不在数据。

## 根因（实测取证）

`order-image-thumb-batch` 的**载荷形状在渲染层声明与 preload 实现之间不一致**：

| 位置 | 约定的形状 |
| --- | --- |
| `src/types.ts`（`ElectronAPI`，**声明**） | `orderImageThumbBatch(items: {...}[])` —— **裸数组** |
| `src/core/services/ipc.ts`（包装函数） | 同上，数组直传 |
| `src/core/plugin/host.ts`（岛桥 `DB_OPS`） | `ipc.orderImageThumbBatch(p.items)` —— 数组 |
| 4 个内置调用点（产品页主图列 / 映射与关联的商品ID图 / 编辑抽屉主图预览 / 拣货单商品图） | 数组 |
| `electron/preload.ts`（**唯一实现**） | 只读 `payload?.items` |

⇒ 传进去的数组被当成"没有 items 的对象"，发出去的是 `{ items: [] }` ⇒ 主进程正常返回
`{ success: true, data: { dataUrls: [] } }` ⇒ 调用方 `forEach` 空数组 ⇒ **界面全是空占位，
且不报任何错**（调用方的 `catch` 兜的是异常，兜不住"成功但空"）。

**用真 preload 取证**（不是读代码猜）：把 `dist/electron/preload.js` 装进打了桩的 `ipcRenderer`，
按声明传裸数组 ——

```
按 types.ts 契约传裸数组  → 载荷 {"items":[]}
传 { items: [...] }       → 载荷 {"items":[{...},{...}]}
```

## 修法

1. `electron/preload.ts` 的 `orderImageThumbBatch` 改为**两种形状都收**（裸数组优先，`{ items }` 兼容
   岛侧老调用方）——单一实现改一处，7 个调用点都不用动，**不动 IPC 契约**（无新通道、无能力域变更、
   岛无需发版）。
2. 顺手堵掉同族的第二个静默缺口：主进程与 preload 都按 `slice(0, 40)` 硬截断，而调用方是"按页/按单"
   给路径的（产品页一页 50 行、拣货单可能上百）⇒ 超出的行**静默空图**。改成在渲染层包装函数
   （`src/core/services/ipc.ts` 的 `orderImageThumbBatch`）**按 40 拆批**：顺序不打乱、单批失败按
   `null` 补位（不让一批的失败作废其余批次）。

## 守卫（`npm run verify` 挡不住这类问题）

`npm run verify`（`check-ipc-contract.mjs`）只核**通道名**三方一致，**看不见载荷形状**。新增两道：

| 门禁 | 覆盖 | 关键设计 |
| --- | --- | --- |
| `npm run ipc:shape:smoke` | 真 preload + 真主进程 handler 对穿（进程内替换 `ipcRenderer.invoke`/`ipcMain.handle`，其余 electron 成员保持真实） | 正面（裸数组必须出 `data:image/*`）+ **反面**（缺失/越权路径必须 `null`，证明"非空"不是恒真）+ 40 项逐项对号 + 同族三条通道形状 |
| `tests/thumbBatchChunk.spec.ts` | 渲染层拆批（假 `window.electronAPI`） | 分批大小 / 返回长度 / 逐项顺序 / 坏批补位 / 空数组不往返 |

变异复核：① 把 preload 改回"只认 `{ items }`" ⇒ 冒烟 7 项红；② 去掉渲染层拆批 ⇒ 单测 2 项红；均已复原。

两个夹具陷阱（本轮踩到，都已写进脚本注释）：
- **1×1 的 PNG 会被 Chromium 判成 empty**（`nativeImage.createFromBuffer` 解不出内容）——拿它当素材，
  "通道坏了"和"素材太小"长得一模一样。改用"按 BGRA 原始位图建图再 `toPNG()`"造真 PNG。
- 这个冒烟要**真 Electron**（nativeImage 真解码）；`ELECTRON_RUN_AS_NODE=1` 时 `require('electron')`
  只是路径字符串，`app` 是 undefined —— 脚本首行加早退护栏直接说清怎么跑，别让人对着一句
  `Cannot read properties of undefined` 猜。

## 遗留（未修，需要用户决策）

1. ~~岛的订单详情缩略图不显示（`DB_OPS` 返回 `{ dataUrls: [...] }`，岛按 `map[localPath]` 取值）~~
   **已自然消失**：调用它的那个岛（「订单归类」）已于 **2026-10-05 整体下架**，随之下线的还有
   那个返回 `{ dataUrls }` 的 `order.imageThumbBatch` op（宿主 `DB_OPS` 的 `order-insight` 域
   整域删除）。**这条遗留不需要再修** —— 但它记下的教训仍然有效：桥两侧的形状口径要有一道
   端到端断言（见本笔记正文与 `npm run ipc:shape:smoke`）。
2. **渲染层那一段接线仍然零覆盖**：`产品页 loadThumbs → thumbs.get(p.id) → <img>` 的映射
   （`items[i].key` 对号）没有任何自动化断言；`goods:ui` 的假桥还把 `orderImageThumbBatch`
   复刻成了**旧形状**（`p.items`），恰好把这个 bug 挡住 —— 假桥是"抄一份行为"，不是"引用实现"，
   天生抓不到"实现与声明不一致"。要补的话得给该冒烟加"带主图的夹具 + 忠实假桥"。
