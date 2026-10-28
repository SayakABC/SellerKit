# 整店采集（ae-profit 0.3.0）：单按钮走位状态机 + 订单采集扩展侧下线

## 结论

1. **一个按钮**。原三入口（采集本页 / 采集本店全部 ≤20 页 / 采 SKU）合并为「采集本店全部（含 SKU）」：
   在店铺主页或任意本店页面点一次 → 列表阶段（all-items 页聚合全部商品，分页 ≤20 页、翻页 ~900ms）→
   **自动续** SKU 阶段（逐款导航到详情页解析 SKU 矩阵）→ 完成后回到起点页。用户在场、随时可停、断点续采。
2. **跨页面状态机靠两样东西**：单槽台账 `aeWalk`（`chrome.storage.local`，每步写盘）+ 走位标记
   `?skwalk=<token>`（本脚本发出的每次导航都带它；页面 boot 凭「URL token == 台账 token」续跑）。
   用户手动浏览的 URL 不带 token，不会被误伤；token 不匹配 = 让位（superseded，只入史不跑）。
3. **停止信号必须走 storage 独立键 `aeWalkAbort`**：content 可能正处在页面跳转中收不到消息，storage 是
   跨页面唯一可靠的信号通道（popup 双通道：`storage.set` + `tabs.sendMessage`；消息通道即时、storage 通道
   ≤800ms 节流）。停止**不推进 phase**（下次点按钮从断点接上）。
4. **防错配三判据**（逐款导航落地后放行条件）：`cur === target` / 302 别名孪生（台账 `canonicalId === cur`）/
   新鲜期（5 分钟）内的未知页。落在上一款的旧页（已入台账）**一点不采**，回目标款重走 ——
   错配 = 把别款的 SKU 挂到目标头上。帧 `itemId` 一律用目标款（与列表帧同 ID，宿主才并得进同一行）。
5. **无规格商品是合法终态**：详情页渲染完成但没有任何 SKU 行 = 该款没有规格（SKU 数 0），不算失败；
   页面没渲染出内容（加载失败/人机墙）才记失败。判据只认 `og:url` 带 `/item/`（报错页也有 `<title>`，
   拿 title 当判据会把失败伪装成「该商品没有规格」）。
6. **订单采集下线 = 仅扩展侧**：content 订单解析、popup 订单按钮、background `COLLECT_RESULT` 分支、
   protocol 订单常量全部移除；宿主 `/ae/ingest` 接收链路、`ae-receiver`、订单主干表与历史数据**零改动**。
   域名白名单**全族保留**（`csp/marketplace/sell/seller.aliexpress.com`）——前两者承载商品管理页（在用），
   全部保留成本 ≈ 0，删错的后果是静默失效（采集无响应、无提示），保留已断案。
7. **本机部署事实（2026-10-16 取证）**：Chrome 直接从**仓库目录**加载
   （Secure Preferences 的 `"path":"/Users/ck/work/work/ai/SellerKitExtensions/extensions/ae-profit"`；
   `…/Chrome/Default/UnpackedExtensions/` 目录存在但**为空**，是旧的拷贝位）⇒ 改完扩展后
   **在 `chrome://extensions` 点「重新加载」即可，没有拷贝步骤**。

## 走位状态机（扩展侧）要点

> 位置：`SellerKitExtensions/extensions/ae-profit/src/content.js`（`startWalk` / `runListPhase` / `runSkuPhase` /
> `finishWalk` / `boot`）；协议常量 `SellerKitExtensions/extensions/ae-profit/src/protocol.js`；出站只有
> background 一个口（`ITEMS_RESULT` 分帧 ≤100 条）。

- 台账 `aeWalk`：`{token, store, phase('list'|'sku'|'done'), queue[], index, ledger{<id>:{status,skus,pushed,canonicalId,error,at}},
  list{...}, expect{itemId,at}, listStop, skuStop, ...}`；`phase='done'` 时 boot 不再跑（防复活）。
- 列表阶段收尾（''→done / page-limit / no-cards→list-empty / page-stalled）决定 `stopReason`；队列只收
  **已采页**的款（页数到顶时第 21 页的款一次都不访问）。分页「点了 DOM 没变」= stalled，不空转点击、直接进 SKU 阶段。
- SKU 阶段失败三态：推送失败（`ledger.status='failed'`）/ 有行但拆不出（计数明说）/ 页面没渲染（判据 `og:url`）。
  两阶段都记账但**互不阻塞**：列表推送失败照样走 SKU 阶段，走位照跑完（`stopReason` 仍 'done'，
  「推送失败 ≠ 采集失败」——采到了什么必须让用户知道）。
- 推送分帧按 100 条（background `MAX_ITEM_BATCH`），content 侧先行切块 —— 不分帧时超出的条数被静默吞掉。
- 走位参数集中在 `readCfg()`（`window.__sellerkitAeCfg` 可覆盖：`pageLimit≤100 / pageDelayMs / listWaitMs /
  domWaitMs / skuWaitMs / nav`）；`nav` 供 jsdom 测试捕获导航不真跳。调试钩子
  `window.__sellerkitAe = {collectItems, parseBuyerSkus, extractStoreInfo, startWalk, abortWalk, getWalkState}`。

## 两个测试基建坑（本轮踩实）

- ⭐ **夹具要传「数据对象」给渲染函数，别传预渲染 HTML 字符串**。`allItemsHtml(cards)` / `wirePager` 会
  对数组元素调 `card()`（数据对象 → HTML）。误把 `[card({...}), card({...})]`（字符串数组）交给它 ⇒
  `card()` 解构字符串得到全 `undefined` ⇒ 渲染出 `href="//www.aliexpress.com/item/undefined.html"`。
  症状极具误导性：**解析层单测全绿、走位层全红**（伪装的像状态机坏了）。修法 = 数据对象工厂
  `cardD(prod, aliasId, title, n)`，字符串数组只允许直接拼进页面 HTML。
- ⭐⭐ **jsdom realm 与 Node realm 原型不同 ⇒ `assert/strict` 的 `deepEqual`（严格比较 `[[Prototype]]`）
  把「内容完全相同」的对象/数组判为不等**（报 "Values have same structure but are not reference-equal"，
  或内容 dump 与期望逐字一致却失败）。content.js 是在 jsdom realm 里 `w.eval` 求值的 ⇒ 它产出的所有
  对象/数组都是 jsdom 原型的。修法 = 断言前 JSON 往返归一：`const plain = (v) => JSON.parse(JSON.stringify(v))`。

## 测试与验证

- `SellerKitExtensions/tests/items-collection.test.mjs`（`npm test`，**18/18**）：解析层 5（店铺卡片规范 ID /
  埋点缺失降级 / 嵌套埋点 / 店铺连接键 / 店名两路兜底）+ SKU 单元 1（笛卡尔积 / 后缀剥离 / soldOut / 缺维度）
  + 走位层 12（全流程 journey / 断点续采 / 302 别名 / 防错配 / 列表 0 卡片 / page-stalled / 页数上限 /
  停止双通道 / storage 残页不复活 / 并发保护 / 非店铺页拒绝 / 推送失败两阶段记账）。
- **走位层测试架构 = 与生产同构**：一次导航 = 一个新 jsdom + **同一份 `shared.storage`** + `cfg.nav` 捕获
  导航不真跳 —— 新实例 eval 时 boot 自动凭 `?skwalk` 续跑（MV3 service worker 无法在 Node 里跑，
  这套架构让「跨页面状态机」可以在单进程里完整回归）。
- 调试脚本（`tests/_debug-*.mjs`）为临时产物，已删；`npm test` 只跑 `items-collection.test.mjs`（package.json 显式单文件）。

## 取证

- Chrome 加载路径：`~/Library/Application Support/Google/Chrome/Default/Secure Preferences` 内
  `"path":"/Users/ck/work/work/ai/SellerKitExtensions/extensions/ae-profit"`（字符串检索）。
- 订单采集残留：扩展仓全仓 grep（content/background/popup/protocol/options/README ×2）无残留。
- 版本：`SellerKitExtensions/extensions/ae-profit/manifest.json` 0.3.0（此前 0.2.1 为三按钮形态）。

相关：`docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md`（D14/D15、P6）、`docs/features/PROFIT_TRACKER.md` §1 就地标注、
`docs/notes/2026-10-15-ae-storefront-collection.md`（前一轮：店铺主页采集 + 商品 ID 双空间）。
