# 「采集到 8 条，应用里却没有数据」：外部写入 → 界面可见的广播桥

2026-10-15 · 结论 + 可复用的隔离实例端到端取证法

## 结论

用户报障：扩展 popup 显示「采集到 8 条」，宿主「货与成本 › 店铺商品」却一片空白。
**数据链是好的**（`pl_shop_items` 里 8 行、`shop_id=4` 归店成功、时间戳新、ID 是规范空间）——
坏的是**可见性**：采集是**外部进程**（Chrome 扩展 → `ae-receiver` 的 HTTP 帧）写库，
已打开的宿主页面一无感知，渲染的还是旧快照，不手动刷新永远看不到新数据。

`ae-receiver` 的状态口（ping）也救不了：它只暴露订单任务的 `lastIngestAt`，对商品帧是**盲**的
（`lastItemsIngestAt` 不进 ping 载荷）。修法 = **落库后广播**（与 `mail-sync-event` 同款模式），
而不是"窗口 focus 时刷新"—— focus 刷新会连带清掉勾选/筛选，语义也不精确。

## 追记（同日续查）：真因不止广播

用户重启后**仍看不到**列表 ⇒ 续查揪出另一半：`preload.shopItemsList` 把缺省的 `shopId`
归一成 `0`（`Number(x) || 0`），而 `0` 是**「未登记桶」过滤条件**；页面调用点本来就不传
shopId（= 不过滤），被压成桶过滤 ⇒ 8 行（`shop_id=4`）**手动刷新也一条都不显示**。
「数据链完好、坏的是可见性」方向对，但只覆盖广播这一半；列表本身还有一条**读链缺陷**。
两处都修后真机复验：真实 userData 克隆上 8 行全出。
详见 `docs/notes/2026-10-15-shop-items-list-tristate.md`。

## 五环链（缺任何一环都不报错，功能却是死的）

| 环 | 位置 | 内容 |
| --- | --- | --- |
| ① 收端广播 | `electron/ae-receiver.ts:90` `emitItemsIngested()`；调用点 `:250` 在 `upsertShopItems` **之后** | `win.webContents.send('ae-items-ingested', {...payload, at})`；窗口销毁中静默忽略 |
| ② 窗口注入 | `electron/main.ts:232` `aeReceiver.setAeEventWindow(() => mainWindow)` | 漏 = 广播永远静默不发（`getWindow` 判空直接 return，send/on 都写着、verify 全绿） |
| ③ preload 订阅 | `electron/preload.ts:1165` `onAeItemsIngested` | `ipcRenderer.on` + 返回 `removeListener` 退订函数 |
| ④ 类型契约 | `src/types.ts:198` + `src/core/services/ipc.ts:785`（顶层包装） | 两处漏任何一处都不报运行错，只让 `vue-tsc` 红 |
| ⑤ 消费端 | `src/modules/goods/useSkuPool.ts:1124` 订阅、`:1129` 退订 | `sub.value === 'items'` → `loadShopItems()` 全量重拉；**其它段 → `loadItemSummaryOnly()` 只刷徽标**（后台重拉不打乱勾选/筛选） |

`scripts/check-ipc-contract.mjs:48` 的 `BROADCAST_EVENTS` 已登记 `ae-items-ingested`（verify 做双端对称检查）。

## 守卫三层（静态 / 行为 / 真机）

1. **静态接线** `tests/aeItemsIngestWiring.spec.ts`（7 例，剥注释后查活代码）：
   emit 里必须有 `send('ae-items-ingested')` · `handleItemsIngest` 必须调 emit **且在 upsert 之后**
   （早退分支广播 = "没写库却让页面白拉"）· `main.ts` 必须 `setAeEventWindow` · preload 订阅+退订成对 ·
   useSkuPool 回调**体内**（不是全文件 `toContain`——函数**定义**本身含子串，删掉调用只留定义照样绿）
   必须有 `sub.value === 'items'` 分流判据。4 条变异逐条打红（删调用 / 翻转位置 / 删注入 / 删订阅）。
2. **行为冒烟** `npm run goods:ui` 的 `ingest-broadcast` 步（4 条断言）：
   空快照前置（表不存在）→ 假桥发广播 → **零点击**出数据（`items-table` 出现且 `shopItemsList` 计数+1）→
   停在队列段广播只刷徽标（`shopItemsSummary`+1、`shopItemsList` 不动、徽标熄灭）→ 库翻回非空徽标重新点亮
   （同一条通道**正反两向**都钉）。2 条变异：删订阅 → 3 条红；else 分支改成全量重拉 → 只有"列表不动"
   那条红（分支判别有效）。
3. **真机端到端**（隔离实例，方法见下）：真 Electron + 真接收端 + CDP —— POST 2 条新商品帧，
   **零交互** 3 行 → 5 行 + 状态条「已采 5 个商品」。

## 冒烟桩纪律：订阅型方法必须**同步**返回退订函数

`goods-ui-smoke` 的假桥 Proxy 把 `OVERRIDES` 里的方法统一包成 `Promise.resolve(fn(...))` ——
订阅方法被包上之后，返回的退订函数变成 Promise，`off()` 直接炸。因此 `onAeItemsIngested` 在
Proxy 的 get 里**特判**（`scripts/goods-ui-smoke.mjs:977`）：推 listener 进 `window.__smokeAeListeners`、
同步返回过滤式退订；测试侧用 `window.__smokeEmitAeItems(payload)` 同步触发全部 listener。
**新加订阅型通道时照抄这个特判。**

## 可复用取证法：隔离实例端到端（真 Electron + 真接收端 + CDP）

```bash
env -u ELECTRON_RUN_AS_NODE AE_RECEIVER_PORT=46299 ./node_modules/.bin/electron . \
  --user-data-dir=/tmp/sk-e2e --no-sandbox --disable-gpu --remote-debugging-port=9223
```

- 驱动：Node 内置 `fetch('http://127.0.0.1:9223/json/list')` 拿 target + 内置 `WebSocket` 直驱 CDP
  `Runtime.evaluate`（点 UI / 读 DOM）—— **不需要 playwright**。
- 投帧：`POST http://127.0.0.1:46299/ae/shop-items/ingest`，header `X-Ae-Token: sk-ae-dev-token`，
  body `{ schema: 'ae-shop-item/v1', store: {}, items: [...] }`。
- 全新库先 `await window.electronAPI.shopDbEnsure()` 引导一次（否则读链路缺表，见
  `2026-10-15-fresh-db-sk-shops-guard.md`）。
- dev 实例的真实 userData = `~/Library/Application Support/seller-kit/`（取 `package.json` 的
  `name`；本仓没有 `productName`，另有一个打包版目录 `SellerKit/` 并存，别数错）。
- ⚠️ **主进程改动（ae-receiver / main / preload）必须重启宿主才生效**，HMR 不覆盖 ——
  "代码改了、跑起来还是旧行为"先想到这条。
- 跑完杀掉实例前，核对**用户自己那个实例**没被动过（PID 与接收端口各自独立）。

## 关联

- 同轮发现并已修：`2026-10-15-fresh-db-sk-shops-guard.md`（全新库上「店铺商品」段的 `sk_shops` 缺表报错）。
- 同日另半真因：`2026-10-15-shop-items-list-tristate.md`（列表空白的真因 = preload 三态压 0）·
  `2026-10-15-shop-item-partial-frame-merge.md`（采集帧只覆盖非空）。
- 上游：`2026-10-15-ae-storefront-collection.md`（店铺主页采集 + 商品ID 双空间）。
