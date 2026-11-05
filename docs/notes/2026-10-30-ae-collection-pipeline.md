# 速卖通采集管线：31 条结论（蒸馏自 4 篇，2026-10-15 ~ 2026-10-17）

> **蒸馏笔记**：由 4 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/2026-10-30-ae-collection-pipeline.md`

涉两仓：`SellerKitExtensions`（采集扩展，0.2.1 → 0.3.0 → 0.4.0）+ SellerKit（广播桥这一侧有代码改动；店铺主页采集、走店、翻页与增量三轮均为**零代码改动**，仅文档）。宿主侧协议字段 `ae-shop-item/v1` 未变。

---

## 1. 采集是外部进程写库，已打开的宿主页面一无感知 ⇒ 修法是落库后广播，不是 focus 刷新

**结论**：用户报障：扩展 popup 显示「采集到 8 条」，宿主「货与成本 › 店铺商品」却一片空白。**数据链是好的**（`pl_shop_items` 里 8 行、`shop_id=4` 归店成功、时间戳新、ID 是规范空间）—— 坏的是**可见性**：采集是**外部进程**（Chrome 扩展 → `ae-receiver` 的 HTTP 帧）写库，已打开的宿主页面一无感知，渲染的还是旧快照，不手动刷新永远看不到新数据。

`ae-receiver` 的状态口（ping）也救不了：它只暴露订单任务的 `lastIngestAt`，对商品帧是**盲**的（`lastItemsIngestAt` 不进 ping 载荷）。修法 = **落库后广播**（与 `mail-sync-event` 同款模式），而不是"窗口 focus 时刷新"—— focus 刷新会连带清掉勾选/筛选，语义也不精确。

**取证**：`electron/ae-receiver.ts:90` `emitItemsIngested()`，`win.webContents.send('ae-items-ingested', {...payload, at})`，窗口销毁中静默忽略；`scripts/check-ipc-contract.mjs:48` 的 `BROADCAST_EVENTS` 已登记 `ae-items-ingested`（verify 做双端对称检查）。真机端到端：POST 2 条新商品帧，**零交互** 3 行 → 5 行 + 状态条「已采 5 个商品」。

**源**：`2026-10-15-ae-items-ingested-broadcast`（2026-10-15）

---

## 2. 真因不止广播：`preload.shopItemsList` 把缺省 `shopId` 压成 `0`，而 `0` 是「未登记桶」过滤条件

**结论**：用户重启后**仍看不到**列表 ⇒ 续查揪出另一半：`preload.shopItemsList` 把缺省的 `shopId` 归一成 `0`（`Number(x) || 0`），而 `0` 是**「未登记桶」过滤条件**；页面调用点本来就不传 shopId（= 不过滤），被压成桶过滤 ⇒ 8 行（`shop_id=4`）**手动刷新也一条都不显示**。「数据链完好、坏的是可见性」方向对，但只覆盖广播这一半；列表本身还有一条**读链缺陷**。两处都修后真机复验：真实 userData 克隆上 8 行全出。

**取证**：详见 `docs/notes/2026-10-30-shop-item-import-and-merge.md`；同轮另修 `2026-10-15-fresh-db-sk-shops-guard.md`（全新库上「店铺商品」段的 `sk_shops` 缺表报错）与 `2026-10-15-shop-item-partial-frame-merge.md`（采集帧只覆盖非空）。

**源**：`2026-10-15-ae-items-ingested-broadcast`（2026-10-15）

---

## 3. 广播桥是五环链，缺任何一环都不报错，功能却是死的

**结论**：从外部写库到界面可见，链上有五环；漏掉任何一环都不会有运行时报错（`vue-tsc` 之外的地方），功能静默失效。

**取证**：

| 环 | 位置 | 内容 |
| --- | --- | --- |
| ① 收端广播 | `electron/ae-receiver.ts:90` `emitItemsIngested()`；调用点 `:250` 在 `upsertShopItems` **之后** | `win.webContents.send('ae-items-ingested', {...payload, at})`；窗口销毁中静默忽略 |
| ② 窗口注入 | `electron/main.ts:232` `aeReceiver.setAeEventWindow(() => mainWindow)` | 漏 = 广播永远静默不发（`getWindow` 判空直接 return，send/on 都写着、verify 全绿） |
| ③ preload 订阅 | `electron/preload.ts:1165` `onAeItemsIngested` | `ipcRenderer.on` + 返回 `removeListener` 退订函数 |
| ④ 类型契约 | `src/types.ts:198` + `src/core/services/ipc.ts:785`（顶层包装） | 两处漏任何一处都不报运行错，只让 `vue-tsc` 红 |
| ⑤ 消费端 | `src/modules/goods/useSkuPool.ts:1124` 订阅、`:1129` 退订 | `sub.value === 'items'` → `loadShopItems()` 全量重拉；**其它段 → `loadItemSummaryOnly()` 只刷徽标**（后台重拉不打乱勾选/筛选） |

**源**：`2026-10-15-ae-items-ingested-broadcast`（2026-10-15）

---

## 4. 守卫要三层：静态接线 / 行为冒烟 / 真机端到端

**结论**：只有静态检查会漏行为，只有行为冒烟会漏真机，三层各守一段。

**取证**：

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
3. **真机端到端**（隔离实例，方法见 §6）：真 Electron + 真接收端 + CDP —— POST 2 条新商品帧，
   **零交互** 3 行 → 5 行 + 状态条「已采 5 个商品」。

**源**：`2026-10-15-ae-items-ingested-broadcast`（2026-10-15）

---

## 5. 冒烟桩纪律：订阅型方法必须**同步**返回退订函数

**结论**：`goods-ui-smoke` 的假桥 Proxy 把 `OVERRIDES` 里的方法统一包成 `Promise.resolve(fn(...))` —— 订阅方法被包上之后，返回的退订函数变成 Promise，`off()` 直接炸。因此 `onAeItemsIngested` 必须在 Proxy 的 get 里**特判**。**新加订阅型通道时照抄这个特判。**

**取证**：`scripts/goods-ui-smoke.mjs:977` 特判——推 listener 进 `window.__smokeAeListeners`、同步返回过滤式退订；测试侧用 `window.__smokeEmitAeItems(payload)` 同步触发全部 listener。

**源**：`2026-10-15-ae-items-ingested-broadcast`（2026-10-15）

---

## 6. 可复用取证法：隔离实例端到端（真 Electron + 真接收端 + CDP）

**结论**：复现/验证这类"外部写入 → 界面可见"的问题，用隔离实例 + CDP 直驱，不依赖 playwright；主进程改动必须重启宿主。

**取证**：

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

**源**：`2026-10-15-ae-items-ingested-broadcast`（2026-10-15）

---

## 7. 店铺主页（买家视角）已支持「采集本页商品」：补 matches + 加 Choice 卡片选择器

**结论**：**店铺主页（买家视角 `aliexpress.com/store/…`）已支持「采集本页商品」**。修复两处根因：
① `manifest.content_scripts.matches` 补 `https://www.aliexpress.com/store/*`（此前脚本未常驻，
只靠 popup 的 activeTab 兜底注入）；② 店铺主页是 Choice 主题卡片
`div[exp_type="XRcmd-ItemExposure"]`（无 class、全靠行内样式），加进 `ITEM_ROW_SELECTORS`
首位 + 专用解析（标题 `span[numberoflines]`、价格 = 整段文本恰为价格的节点、主图 = 首张非 `data:` img）。

**取证**：修复点（`SellerKitExtensions/extensions/ae-profit/src/content.js`）：
`ITEM_ROW_SELECTORS` 首位 `[exp_type="XRcmd-ItemExposure"]` · `utlogmapProdId()`（`prod` / `x_object_id`，
须过 `^\d{10,19}$`）· `storefrontTitle()` / `storefrontPrice()` · `storeNameFromPage()` ·
`extractStoreInfo()`（地址栏块优先 + 防改写守卫）· `currentItemId()`（og:url 兜底）·
`parseSkuRow()`（收紧判据）· `COLLECT_ITEM_DETAIL` handler（itemId 为空不推帧）。
回归：扩展仓库 `npm test` **29/29**。店铺主页夹具按生产形状复刻（无 class、行内样式、`utlogmap`
双份、价格拆 4 个 span 紧邻无空白、页内无 `/store/` 链接、页面尾部 data: 占位 png）；
另有 `/i/` 2 例与 props 收紧 1 例。变异复核（**在仓库副本上跑**，10 条逐条打红后复原）：ID 优先级反转 /
去掉嵌套 `utlogmap` 持有者 / 去价格兜底 / 地址栏块失效 / 去 url 防改写守卫 / 去 og 兜底 / 去 itemId 空守卫 /
店名版式失效 / 去行选择器 / props 判据松回旧版。⚠️ 探针注入脚本（拼接 content.js 原文）的**注释与字符串里不能有
反引号** —— content.js 自身含反引号，模板字符串会提前闭合。真机取证：CDP（克隆 Chrome profile + 手动注入
content.js）在真实店铺主页跑「采集本页商品」8/8 条：ID 全为规范 `1005…`、标题 / 价格 / 图 / 店铺键正确、
推送帧结构正确；`/i/` 实页「采 SKU」回 `ok:true` + 规范 itemId。

**源**：`2026-10-15-ae-storefront-collection`（2026-10-15）

---

## 8. ⭐⭐ 速卖通商品ID 有两个空间，凡采集必取规范空间（`1005…` 开头）

**结论**：**速卖通商品ID 有两个空间，凡采集必取规范空间（`1005…` 开头）**：店铺主页卡片 href 是
**旧空间别名**（`32…` 开头、带 `pdp_npi` query）；规范 ID 的唯一可靠来源 = 卡片曝光埋点
`utlogmap`（URL 编码 JSON）的 `prod` 字段（同一串挂在卡片根 div 与内部 `<a>` **双份**）。
**拿 href 采 = 静默对不上账** —— 采集与落库全部"成功"，认款/订单匹配时才发现全空。
已实现「utlogmap 优先 / href 兜底」，并变异钉死（优先级反转 ⇒ 用例红）。

**取证**：`utlogmapProdId()` 读 `prod` / `x_object_id`，须过 `^\d{10,19}$`；变异项「ID 优先级反转」与
「去掉嵌套 `utlogmap` 持有者」逐条打红后复原（同一批 10 条变异见 §7）。

**源**：`2026-10-15-ae-storefront-collection`（2026-10-15）

---

## 9. 店铺连接键取地址栏 `/store/<id>`，别用页面店铺链接、也别用 og:url

**结论**：**店铺主页的店铺连接键取地址栏** `/store/<id>`，不要用页面里的店铺链接（页脚「推荐店铺」之类
会把商品错挂到别人店）；也**别用 og:url** —— og 报的是规范店号（如 `1103865174`），而主机里
用户登记的是地址栏别名 URL（如 `1103865175`），反而匹配不上。店名取页面自报：
`<title>`（`<店名> - Amazing products…`）→ keywords meta 兜底。

**取证**：`extractStoreInfo()`（地址栏块优先 + 防改写守卫）、`storeNameFromPage()`（店名两路兜底）；
夹具刻意做成「页内无 `/store/` 链接、页面尾部 data: 占位 png」，变异「地址栏块失效」「去 url 防改写守卫」
「店名版式失效」各自打红。

**源**：`2026-10-15-ae-storefront-collection`（2026-10-15）

---

## 10. `/i/` 短链详情页不会被重定向到 `/item/` ⇒ itemId 走 `og:url` 兜底

**结论**：**`/i/` 短链详情页不会被重定向到 `/item/`**（跳转后仍停在 `/i/<规范id>.html`）⇒ location 永远没有
`/item/`；itemId 走 `og:url`（content 含规范 `/item/1005….html`）兜底。`/item/<别名>.html` 则会
服务端重定向，location 本来就对。

**取证**：`currentItemId()`（og:url 兜底）+ `COLLECT_ITEM_DETAIL` handler（itemId 为空不推帧）；夹具含
`/i/` 2 例；真机 `/i/` 实页「采 SKU」回 `ok:true` + 规范 itemId；变异「去 og 兜底」「去 itemId 空守卫」各自打红。

**源**：`2026-10-15-ae-storefront-collection`（2026-10-15）

---

## 11. props 兜底判据必须对齐主程序 `parseSkuProps` 的两种可解析写法

**结论**：**props 兜底判据必须对齐主程序 `parseSkuProps` 的两种可解析写法**：`Color:X;Size:Y`
（需 `[;；,，]` 分隔）或 `X+Y+Z`（≥2 段）。旧判据「含 `Color:` 即收」会把买家商品页 UI 文案
（`Color: 6 View More Size: XL…`）当 props 推出去 —— 主程序拆出来 color 会**吸走整段垃圾**。
收紧后不成形即计失败（用户可见），垃圾不进 `pl_shop_sku`（用户看不见）。

**取证**：`parseSkuRow()` 收紧判据；夹具 1 例专测 props 收紧；变异「props 判据松回旧版」打红后复原。

**源**：`2026-10-15-ae-storefront-collection`（2026-10-15）

---

## 12. 买家商品页的 SKU 矩阵暂不支持（既有缺口，刻意未做）

**结论**：**买家商品页的 SKU 矩阵暂不支持**（既有缺口，本轮刻意未做）：SKU 选择器只对卖家后台结构调过，
买家页上「采 SKU」会明说失败并给样本（扩展 README 已注明）。要做需重新采买家页色卡/尺码 DOM。

**取证**：扩展 README 已注明；本轮真机只验到 `/i/` 实页「采 SKU」回 `ok:true` + 规范 itemId（§10）。

**源**：`2026-10-15-ae-storefront-collection`（2026-10-15）

---

## 13. 【历史记录】扩展生效路径 = 拷到 unpacked 扩展目录 + 重新加载（无热更新）

**结论**：【历史记录】**改这个扩展的生效路径**：仓库改动 → 拷到本机 unpacked 扩展目录
（`~/Library/Application Support/Google/Chrome/Default/UnpackedExtensions/<id>/`）→ Chrome 扩展页点
「重新加载」。**没有热更新**；`dist/*.zip` 只用于分发/商店，不是本机生效路径。
（2026-10-16 取证已推翻此路径，见 §31。）

**取证**：部署核对用 `diff -rq` 确认 unpacked 目录与仓库 `extensions/ae-profit` 同版本（0.2.1）。

**源**：`2026-10-15-ae-storefront-collection`（2026-10-15）

---

## 14. 一个按钮：三入口合并为「采集本店全部（含 SKU）」

**结论**：**一个按钮**。原三入口（采集本页 / 采集本店全部 ≤20 页 / 采 SKU）合并为「采集本店全部（含 SKU）」：
在店铺主页或任意本店页面点一次 → 列表阶段（all-items 页聚合全部商品，分页 ≤20 页、翻页 ~900ms）→
**自动续** SKU 阶段（逐款导航到详情页解析 SKU 矩阵）→ 完成后回到起点页。用户在场、随时可停、断点续采。

**取证**：`SellerKitExtensions/extensions/ae-profit/manifest.json` 0.3.0（此前 0.2.1 为三按钮形态）；
走位状态机（扩展侧）位置 `SellerKitExtensions/extensions/ae-profit/src/content.js`（`startWalk` / `runListPhase` /
`runSkuPhase` / `finishWalk` / `boot`）；协议常量 `SellerKitExtensions/extensions/ae-profit/src/protocol.js`；
出站只有 background 一个口（`ITEMS_RESULT` 分帧 ≤100 条）。

原文相关：`docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md`（D14/D15、P6）、`docs/features/PROFIT_TRACKER.md` §1 就地标注。

**源**：`2026-10-16-ae-walk-store-collection`（2026-10-16）

---

## 15. 跨页面状态机靠两样东西：单槽台账 `aeWalk` + 走位标记 `?skwalk=<token>`

**结论**：**跨页面状态机靠两样东西**：单槽台账 `aeWalk`（`chrome.storage.local`，每步写盘）+ 走位标记
`?skwalk=<token>`（本脚本发出的每次导航都带它；页面 boot 凭「URL token == 台账 token」续跑）。
用户手动浏览的 URL 不带 token，不会被误伤；token 不匹配 = 让位（superseded，只入史不跑）。

**取证**：台账字段 `aeWalk`：`{token, store, phase('list'|'sku'|'done'), queue[], index, ledger{<id>:{status,skus,pushed,canonicalId,error,at}},
list{...}, expect{itemId,at}, listStop, skuStop, ...}`；`phase='done'` 时 boot 不再跑（防复活）。

**源**：`2026-10-16-ae-walk-store-collection`（2026-10-16）

---

## 16. 停止信号必须走 storage 独立键 `aeWalkAbort`

**结论**：**停止信号必须走 storage 独立键 `aeWalkAbort`**：content 可能正处在页面跳转中收不到消息，storage 是
跨页面唯一可靠的信号通道（popup 双通道：`storage.set` + `tabs.sendMessage`；消息通道即时、storage 通道
≤800ms 节流）。停止**不推进 phase**（下次点按钮从断点接上）。

**取证**：走位层 12 例含「停止双通道」「storage 残页不复活」两条（见 §23）。

**源**：`2026-10-16-ae-walk-store-collection`（2026-10-16）

---

## 17. 防错配三判据：逐款导航落地后放行

**结论**：**防错配三判据**（逐款导航落地后放行条件）：`cur === target` / 302 别名孪生（台账 `canonicalId === cur`）/
新鲜期（5 分钟）内的未知页。落在上一款的旧页（已入台账）**一点不采**，回目标款重走 ——
错配 = 把别款的 SKU 挂到目标头上。帧 `itemId` 一律用目标款（与列表帧同 ID，宿主才并得进同一行）。

**取证**：走位层 12 例含「302 别名」「防错配」两条（见 §23）。

**源**：`2026-10-16-ae-walk-store-collection`（2026-10-16）

---

## 18. 无规格商品是合法终态，判据只认 `og:url` 带 `/item/`

**结论**：**无规格商品是合法终态**：详情页渲染完成但没有任何 SKU 行 = 该款没有规格（SKU 数 0），不算失败；
页面没渲染出内容（加载失败/人机墙）才记失败。判据只认 `og:url` 带 `/item/`（报错页也有 `<title>`，
拿 title 当判据会把失败伪装成「该商品没有规格」）。

**取证**：SKU 阶段失败三态：推送失败（`ledger.status='failed'`）/ 有行但拆不出（计数明说）/ 页面没渲染（判据 `og:url`）。

**源**：`2026-10-16-ae-walk-store-collection`（2026-10-16）

---

## 19. 订单采集下线 = 仅扩展侧，宿主接收链路零改动

**结论**：**订单采集下线 = 仅扩展侧**：content 订单解析、popup 订单按钮、background `COLLECT_RESULT` 分支、
protocol 订单常量全部移除；宿主 `/ae/ingest` 接收链路、`ae-receiver`、订单主干表与历史数据**零改动**。
域名白名单**全族保留**（`csp/marketplace/sell/seller.aliexpress.com`）——前两者承载商品管理页（在用），
全部保留成本 ≈ 0，删错的后果是静默失效（采集无响应、无提示），保留已断案。

**取证**：订单采集残留：扩展仓全仓 grep（content/background/popup/protocol/options/README ×2）无残留。

**源**：`2026-10-16-ae-walk-store-collection`（2026-10-16）

---

## 20. 走位状态机要点：收尾判据、两阶段互不阻塞、分帧 100、参数与调试钩子

**结论**：列表阶段收尾决定 `stopReason`；两阶段都记账但**互不阻塞**；推送必须分帧，不分帧时超出的条数被静默吞掉；参数集中在一个地方可覆盖。

**取证**：

- 列表阶段收尾（''→done / page-limit / no-cards→list-empty / page-stalled）决定 `stopReason`；队列只收
  **已采页**的款（页数到顶时第 21 页的款一次都不访问）。分页「点了 DOM 没变」= stalled，不空转点击、直接进 SKU 阶段。
- SKU 阶段失败三态：推送失败（`ledger.status='failed'`）/ 有行但拆不出（计数明说）/ 页面没渲染（判据 `og:url`）。
  两阶段都记账但**互不阻塞**：列表推送失败照样走 SKU 阶段，走位照跑完（`stopReason` 仍 'done'，
  「推送失败 ≠ 采集失败」——采到了什么必须让用户知道）。
- 推送分帧按 100 条（background `MAX_ITEM_BATCH`），content 侧先行切块 —— 不分帧时超出的条数被静默吞掉。
- 走位参数集中在 `readCfg()`（`window.__sellerkitAeCfg` 可覆盖：`pageLimit≤100 / pageDelayMs / listWaitMs /
  domWaitMs / skuWaitMs / nav`）；`nav` 供 jsdom 测试捕获导航不真跳。调试钩子
  `window.__sellerkitAe = {collectItems, parseBuyerSkus, extractStoreInfo, startWalk, abortWalk, getWalkState}`。

**源**：`2026-10-16-ae-walk-store-collection`（2026-10-16）

---

## 21. 测试基建坑（一）：夹具要传「数据对象」给渲染函数，别传预渲染 HTML 字符串

**结论**：⭐ **夹具要传「数据对象」给渲染函数，别传预渲染 HTML 字符串**。`allItemsHtml(cards)` / `wirePager` 会
对数组元素调 `card()`（数据对象 → HTML）。误把 `[card({...}), card({...})]`（字符串数组）交给它 ⇒
`card()` 解构字符串得到全 `undefined` ⇒ 渲染出 `href="//www.aliexpress.com/item/undefined.html"`。
症状极具误导性：**解析层单测全绿、走位层全红**（伪装的像状态机坏了）。修法 = 数据对象工厂
`cardD(prod, aliasId, title, n)`，字符串数组只允许直接拼进页面 HTML。

**取证**：症状原文 `href="//www.aliexpress.com/item/undefined.html"`；误用形态 `[card({...}), card({...})]`。

**源**：`2026-10-16-ae-walk-store-collection`（2026-10-16）

---

## 22. 测试基建坑（二）：jsdom realm 与 Node realm 原型不同 ⇒ `deepEqual` 判不等

**结论**：⭐⭐ **jsdom realm 与 Node realm 原型不同 ⇒ `assert/strict` 的 `deepEqual`（严格比较 `[[Prototype]]`）
把「内容完全相同」的对象/数组判为不等**（报 "Values have same structure but are not reference-equal"，
或内容 dump 与期望逐字一致却失败）。content.js 是在 jsdom realm 里 `w.eval` 求值的 ⇒ 它产出的所有
对象/数组都是 jsdom 原型的。修法 = 断言前 JSON 往返归一：`const plain = (v) => JSON.parse(JSON.stringify(v))`。

**取证**：报错原文 "Values have same structure but are not reference-equal"；归一写法 `const plain = (v) => JSON.parse(JSON.stringify(v))`。

**源**：`2026-10-16-ae-walk-store-collection`（2026-10-16）

---

## 23. 扩展侧测试：18/18，走位层架构「与生产同构」

**结论**：一次导航 = 一个新 jsdom + **同一份 `shared.storage`** + `cfg.nav` 捕获导航不真跳 —— 新实例 eval 时 boot 自动凭 `?skwalk` 续跑（MV3 service worker 无法在 Node 里跑，这套架构让「跨页面状态机」可以在单进程里完整回归）。

**取证**：`SellerKitExtensions/tests/items-collection.test.mjs`（`npm test`，**18/18**）：解析层 5（店铺卡片规范 ID /
埋点缺失降级 / 嵌套埋点 / 店铺连接键 / 店名两路兜底）+ SKU 单元 1（笛卡尔积 / 后缀剥离 / soldOut / 缺维度）
+ 走位层 12（全流程 journey / 断点续采 / 302 别名 / 防错配 / 列表 0 卡片 / page-stalled / 页数上限 /
停止双通道 / storage 残页不复活 / 并发保护 / 非店铺页拒绝 / 推送失败两阶段记账）。
调试脚本（`tests/_debug-*.mjs`）为临时产物，已删；`npm test` 只跑 `items-collection.test.mjs`（package.json 显式单文件）。

**源**：`2026-10-16-ae-walk-store-collection`（2026-10-16）

---

## 24. ⭐⭐ 换页成功的判据只能看商品卡片，不能看分页器属性

**结论**：⭐⭐ **换页成功的判据只能看商品卡片，不能看分页器属性**。实测速卖通店铺 `all-items` 页：点页码后
`currentpage` 在 **~800ms 内**就翻到新页，而新一页的卡片**此刻还没渲染**（DOM 里 **0** 张卡，
1500ms 后才有 23 张）。旧判据把 `currentpage/totalpage` 算进列表签名 ⇒ 在空列表上采集（采到 0 条），
随后 `pageNo >= totalpage` 判定「走完」⇒ **整页商品静默丢失还报告「全部完成」**。
这就是「店铺 63 件只采到 40 条」的真因（第 1 页 40 张 + 第 2 页 23 张，第 2 页被整页吃掉）。

**取证**：真机（克隆 Chrome profile + CDP，店铺 `store/1105668759`）：
页面自报 `63 items`；第 1 页 DOM 40 张卡、第 2 页 23 张；分页器 `currentpage=1 totalpage=2`（**分页器是对的**）。
点「2」后 800ms：`currentpage=2`、`cards=0`；1500ms：`cards=23`。
修复后把 `content.js` 带桩注入同一真页面跑列表阶段（导航用 `cfg.nav` 捕获，不真开 63 个详情页）：
`items=63 / rows=63 / failed=0`，帧 `[40, 23]`，`queue` 63 条且去重后仍是 63。

原文相关：`docs/notes/2026-10-30-ae-collection-pipeline.md`（走位状态机）、
`docs/notes/2026-10-30-ae-collection-pipeline.md`（商品ID 双空间）、`docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md`。

**源**：`2026-10-17-ae-collection-paging-and-incremental`（2026-10-17）

---

## 25. ⭐⭐ 两道防线互为兜底，任一道存在都不漏采，别只留一道

**结论**：⭐⭐ **现有两道防线，任一道存在都不漏采，别只留一道**（两条互为兜底）：
① 换页等待的条件是「**有卡片**且卡片集合变了」；② `settleList()` 等卡片数连续 3 次采样不变
（列表是分批渲染的，第一次采到卡片时可能只是半截）。合成一条变异（两道都拆）才打得红。

**取证**：变异复核（仓库副本逐条打红后复原）：拆「有卡片」判据 → 红；拆「必须在第 1 页」→ 红；
不载 seen → 红；flushSeen 记失败款 → 红；列表不看已采全推 → 红；**两道翻页防线一起拆** → 红。
⚠️ 单拆 `settleList` 或单把签名改回含页码**都不红**（被另一道兜住）——所以这两条用例守的是最终行为，
不是某一处实现，改代码时要一起看。

**源**：`2026-10-17-ae-collection-paging-and-incremental`（2026-10-17）

---

## 26. ⭐ 停在第 N 页点「采集本店全部」必须先回列表第 1 页

**结论**：⭐ **停在第 N 页点「采集本店全部」必须先回列表第 1 页**：就地开跑 = 前面几页这轮根本不扫，
而「扫到 0 条新货」会被当成「店里没新货」——静默漏采。（`startWalk` 只在 `currentpage <= 1` 时就地跑，
无分页器即视为第 1 页。）

**取证**：回归新增「停在第 2 页先回第 1 页」1 条；变异「拆「必须在第 1 页」」打红。

**源**：`2026-10-17-ae-collection-paging-and-incremental`（2026-10-17）

---

## 27. ⭐⭐ 跨轮次去重靠独立台账 `aeWalkSeen`，不能靠走位台账 `aeWalk`

**结论**：⭐⭐ **跨轮次去重靠独立台账 `aeWalkSeen`，不能靠走位台账 `aeWalk`**：`aeWalk` 在 `phase='done'`
后不再续用 ⇒ 上一版**第二次点采集会把整店重跑一遍**（列表全翻 + 每款详情页重开一次）。
新台账 `{ <storeId>: { <itemId>: {at, skus} } }`，新一轮走位开始时灌进 `aeWalk.ledger`
（`status='done'`）⇒ SKU 阶段自动跳过、列表阶段只推新增。

**取证**：增量真机：塞入 40 条 seen 后第二轮 `carried=40`，本轮只推剩下那批（不再推已采的）。
回归新增「跨轮增量」1 条；变异「不载 seen」→ 红、「列表不看已采全推」→ 红。

**源**：`2026-10-17-ae-collection-paging-and-incremental`（2026-10-17）

---

## 28. ⭐ 只有 `status==='done'` 才入已采台账

**结论**：⭐ **只有 `status==='done'` 才入已采台账**：上次失败的款必须下一轮重采（「来过」≠「采到」，
把失败记成已采 = 那批货永久丢）。

**取证**：回归新增「失败款重采」1 条；变异「flushSeen 记失败款」→ 红。

**源**：`2026-10-17-ae-collection-paging-and-incremental`（2026-10-17）

---

## 29. 列表阶段照翻全部页是必须的，省不掉的只有 SKU 阶段

**结论**：**列表阶段照翻全部页是必须的**（不翻就发现不了新上架的货），省不掉的是 SKU 阶段（逐款开详情页）。
所以「第二次点采集」= 列表全扫一遍（快）+ SKU 只走新增（慢的那步省了）。

**取证**：增量真机第二轮 `carried=40`，列表仍全扫、SKU 只走新增（§27）。

**源**：`2026-10-17-ae-collection-paging-and-incremental`（2026-10-17）

---

## 30. 出口不能只有增量：`force:true` 整店重采 + 清除本店采集记录

**结论**：出口不能只有增量：**「整店重采（忽略已采集）」**（`WALK_START` 带 `force:true`）与
**「清除本店采集记录」**（popup 直写 storage）都要有，否则用户想刷新价格时无路可走。

**取证**：回归：扩展仓库 `npm test` **24/24**（新增 6 条：延迟渲染翻页 / 空页判 stalled / 停在第 2 页先回第 1 页 /
跨轮增量 / force 全量 / 失败款重采）。

**源**：`2026-10-17-ae-collection-paging-and-incremental`（2026-10-17）

---

## 31. 本机部署事实：Chrome 直接从仓库目录加载，改完「重新加载」即可，没有拷贝步骤

**结论**：**本机部署事实**（2026-10-16 取证，2026-10-17 复核）：Chrome 直接从**仓库目录**加载
（Secure Preferences 的 `"path":"/Users/ck/work/work/ai/SellerKitExtensions/extensions/ae-profit"`；
`…/Chrome/Default/UnpackedExtensions/` 目录存在但**为空**，是旧的拷贝位）⇒ 改完扩展后
**在 `chrome://extensions` 点「重新加载」即可，没有拷贝步骤**。

**取证**：Chrome 加载路径：`~/Library/Application Support/Google/Chrome/Default/Secure Preferences` 内
`"path":"/Users/ck/work/work/ai/SellerKitExtensions/extensions/ae-profit"`（字符串检索）。
2026-10-17 复核同结论：Chrome **直接从仓库目录加载**，
⇒ 改完在 `chrome://extensions` 点「重新加载」即生效，**没有拷贝步骤**
（`~/Library/Application Support/Google/Chrome/Default/UnpackedExtensions/` 是旧拷贝位，当前为空）。

**源**：`2026-10-16-ae-walk-store-collection`（2026-10-16）· `2026-10-17-ae-collection-paging-and-incremental`（2026-10-17）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-15-ae-items-ingested-broadcast.md` | 2026-10-15 | §1 / §2 / §3 / §4 / §5 / §6 |
| `2026-10-15-ae-storefront-collection.md` | 2026-10-15 | §7 / §8 / §9 / §10 / §11 / §12 / §13 |
| `2026-10-16-ae-walk-store-collection.md` | 2026-10-16 | §14 / §15 / §16 / §17 / §18 / §19 / §20 / §21 / §22 / §23 / §31 |
| `2026-10-17-ae-collection-paging-and-incremental.md` | 2026-10-17 | §24 / §25 / §26 / §27 / §28 / §29 / §30 / §31 |
