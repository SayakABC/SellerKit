# 芒果推送的帧契约：宿主必须同时认「原始响应」与「扩展规整帧」

**一句话结论**：扩展推给 `/mango/ingest` 的不是芒果原始响应，而是它自己 `mango-parse.js`
`toOrder()` 的**规整帧**（换了键名、金额已换成分、时间已格式化成字符串）。
`electron/mango-ingest.ts` 的 `toInternal` 必须**两套键名都认**，不能只认抓包看到的那一套。

## 为什么这条必须记住（2026-11-02 事故）

用户看到的表现是最容易被忽略的那种绿灯：

```
连接 正常 / 上次抓取 11-02 00:21 / 抓到订单 4 / 4 单 / 完整度 完整
推送 成功（新 0 / 更新 0）
```

HTTP 200、扩展无报错、`sk_sync_log` 也写了行 —— 但订单表一行没多。真因是**每一帧都被业务层逐单拒绝**：

```
sk_sync_log 最新一行：fetched=4 total=4 inserted=0 updated=0 skipped=4
detail_json: {"skips":[{"orderNo":"#1","reason":"缺少 orderId"}, … ×4]}
```

`toInternal` 当时只认 `orderId`，而扩展交的是 `orderNo` ⇒ 四单全部"没有单号"。
**帧合法、请求成功、单子一单没进**，两侧各自都以为自己没问题。

## 两套形状各长什么样

| 语义 | ① 芒果原始响应（抓包） | ② 扩展 `toOrder()` 规整帧（真正推来的） |
| --- | --- | --- |
| 单号 | `orderId` | `orderNo` |
| 店铺 | `alias` / `authId` | `shopName` / `shopAuthId` |
| 状态 | `cnOrderStatus` / `orderStatus` | `platformStatusCn` / `platformStatus` / `status` |
| 金额 | `payAmount`（元）+ `currencyCode` | `amountCents`（**已是分**）+ `currency` |
| 下单/付款 | `aeGmtCreate` / `gmtPayTime`（**毫秒**） | `orderTime` / `payTime`（`YYYY-MM-DD HH:mm:ss` **本地串**） |
| 最晚发货 | `sendGoodExpiredDate`（毫秒） | `deadline`（本地串） |
| 时效 | `aeInternetInfoDTO.qualifiedTime` | `timeoutAt`（本地串） |
| 明细 | `orderItemList[]`（`productId` / `productCount` / `productImgUrl` / `attrMap`） | `lines[]`（`itemId` / `qty` / `imgUrl` / `color` / `size`） |
| 标签/国家/重量 | `labelMap` / `countryCode` / `weight`(kg) | `labels[]` / `countryCn` / `weightGram` |

两个特别容易再踩的点：

- **`amountCents` 不能再乘 100**。扩展已经用 `toCents` 算好分；再过一遍 `mangoCents` 就是 12748 → 1274800。
- **`mangoTime('2026-11-01 12:00:00')` 返回 `''`**（`Number()` 是 NaN）。只按毫秒解析会把规整帧的
  四个时间列全写成空 —— 界面上的截止倒计时就永远是空的，且不报错。取时间必须
  先毫秒、再回落 `^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$` 的本地串。

## 判据（两条，缺一条都可能再犯）

1. `tests/mangoIngest.spec.ts`「扩展真正推的规整帧」4 例：夹具**逐字照抄** `toOrder()` 的输出，
   断言 `amountCents` 是 12748 而不是 1274800、四个时间串匹配本地串形状、`lines` 的行级字段落位；
   缺单号时 `reason` 必须**同时**提到 `orderId` 与 `orderNo`（提醒下一个改的人别只改一半）。
2. `scripts/mango-ingest-smoke.cjs` 的 `[8]` 段：用 `vm` 加载
   `SellerKitExtensions/extensions/mango-order/src/mango-parse.js`，取 `window.__skMangoParse.toOrder`
   **造帧**再走全链路到库 —— 这是跨仓契约，任一侧改字段名就会红（手抄夹具做不到这一点）。

## 取证时必须连 WAL 一起读

本仓真库有 3.5MB 的 `-wal`。`cp` 只拷主文件 ⇒ 读到的是**旧快照**，`sk_sync_log` 看起来是空的，
极易误判成"同步根本没跑"：

```bash
sqlite3 "file:$HOME/Library/Application Support/seller-kit/sellerkit.db?mode=ro" ".backup /tmp/sk.db"
sqlite3 /tmp/sk.db "SELECT fetched,inserted,updated,skipped,reason,detail_json FROM sk_sync_log ORDER BY id DESC LIMIT 1;"
```

## 附带修掉的守卫缺陷

`mango-ingest-smoke.cjs` 收尾原本是「失败分支 `process.exit(1)` + 末尾又一行 `process.exit(0)`」，
实测两行都会跑到 ⇒ 变异后 4 项全红、**退出码仍是 0**。已改为单出口
`process.exit(failed > 0 ? 1 : 0)`；变异 `str(o.orderId)||str(o.orderNo)` → `str(o.orderId)`
后确认 `EXIT=1`，还原后 `EXIT=0`、25 项全绿。**任何冒烟脚本都要检查这一点**：红要能变成非零退出码。

## 遗留

修复进了 `dist/electron`，但运行中的 dev 进程持旧模块 —— 必须**重启应用**才能验到"新 4"。
若重启后仍是"新 0"，看 `sk_sync_log` 最新一行的 `skips[].reason` 里写的键名，那就是下一次契约漂移的指纹。

---

## 2026-11-05 续：帧里还有一整组字段没人取（发货回执），以及"回写"为什么不能走原入库路径

用户问「到芒果抓已发货怎么抓、抓哪些、历史补不补」。核查后三条答案，附两个坑。

### 1. 抓取侧零改动：切筛选即可，但**别信 `source.status`**

扩展 hook 的是 `POST /erp/order/data/search.json`，**直接复制页面自己发的请求体**、只改
`page/pageSize` 再重放翻页 ⇒ 筛选条件就在 body 里。把芒果页面切到「已发货」，同一段 hook
自动抓那一批。

但它随帧推的 `source.status` 是**芒果自己的编码**（`sp.get('status')`），语义随版本变；
拿它判"这是哪一批"等于把版本差异变成静默错分。**判据要取帧内的事实**：每单自己的
`cnOrderStatus` + `gmtSend` 是否非空。`planShipReceipt().withShipTime` 就是干这个的 ——
只写进日志让人看"12 单里 12 单带发货时间"，不参与任何分流。

### 2. 帧里一直有、宿主一直没取的字段

| 需要的 | 原始响应键 | 规整帧键（S2 补） | 此前状态 |
|---|---|---|---|
| 发货时间 | `gmtSend`（毫秒；未发货时 `null`） | `shipTime` | 没人取 ⇒ `oi_orders.ship_time` 至今**全空** |
| 运单号 | `logisticsNo` / `mailNo` | `logisticsNo` | 没人取 |
| 承运商 | `logisticsServiceName` / `logisticsTypeCode` | `logisticsCarrier` | 没人取 |

**`raw_fields.采集帧` 里挖不出历史发货时间**：那些帧是待发货时抓的，`gmtSend` 本来就是
`null`；挖一遍只能捞到"采集那一刻已发出去"的零星单 —— 有偏样本比没有更误导。

落库进主表（`logistics_no` / `logistics_carrier`），不塞 `raw_fields`：查件按运单号查、
算运费按承运商聚，JSON 挖得出但索引不了。

### 3. 回写**绝不能**喂 `upsertCollectedOrder`（这是整件事的重点）

它是**整单替换**（DELETE 主表 + DELETE 全部明细 + 重插）。一单从待发变已发后照常重采集，
会静默丢掉：

- `oi_order_items.style_color_id` —— **归类结果**（行是重插的新 id）；
- `oi_item_parts` —— 图案绑定（POD 命根子，`ON DELETE CASCADE`）
- `parcels` / `parcel_lines` —— 代码**显式删除**；
- `purchase_sources.order_item_id` —— 软键（无外键）⇒ 变**悬空 id**，覆盖率 join 不上，
  "已拿"掉回 0、"还差"虚高，**界面不报错**。

行数守卫救不了：已发货单行数不变，`lines.length < oldCount` 不成立 ⇒ 照样替换。
这条已在 `scripts/order-db-smoke.cjs` 的 `[9.5]` 写成**对照实验**：同一单走
`upsertCollectedOrder` 后 `style_color_id` 全变 0、包裹归零。哪天它变绿了，说明整单替换的
缺陷被修了，那时该改写 `applyShipStatus` 头上"为什么必须有它"的注释，而不是默默删掉。

`applyShipStatus` 的三条不变量（都有冒烟 + 变异验证）：
1. **只写 4 列**，金额与时效（`amount_cents` / `deal_deadline` / `timeout_at`）一个都不写 ——
   写了会让利润表与截止风险历史随"什么时候点的采集"漂移；
2. **幂等**：目标值 == 现值不写（同一批跑两遍，第二遍全 `unchanged`）；
3. **空值不算指令**：`''` = "这次没给"，不是"清空"（一次不完整的帧不该把运单号抹掉）。

### 4. `ship_time` 默认不写 —— 它有两个不同的下游

- 发货台队列读 **`biz_status`**（`isWaitingShip`）⇒ 写它就够让队列清零；
- 拣货 / 拿货读 **`ship_time = ''`**（`picking-db` / `purchase-db` 的过滤）⇒ 写它会让这些单
  **从拿货页静默消失**，"发了货但没拿货"的欠货变得不可见。

所以 `opts.writeShipTime` 缺省 `false`。要开这一列，先给那类单一个可见入口，别顺手打开。

### 5. 两个坑

**坑一：新列写进已发布的迁移版本 = 存量库永远拿不到。**
`migrate()` 只跑 `version > current` 的步骤。把
`ALTER TABLE oi_orders ADD COLUMN logistics_no` 加进 **v13**（用户库早已记账到 13）⇒
新库建表带上、老库永远没有，运行时 `SELECT logistics_no` 报 `no such column`
（不在建表时炸，更难查）。必须是**新的 v14**。
实测（`sqlite3 .backup` 出真库副本 → 跑 `ensureOrderSchema`）：
`order.main v13 · logistics 列 = []` → `v14 · ["logistics_no","logistics_carrier"]`，
二次 `ensureOrderSchema` 不抛错，7 单 `ship_time` 仍全空（只加列不回填）。

**坑二：`npm run order:smoke` 在本机会假红。**
继承 `ELECTRON_RUN_AS_NODE=1` 时 `require('electron')` 返回路径串 ⇒ `app` 是 `undefined`，
报 `Cannot read properties of undefined (reading 'getPath')`，看着像数据层坏了。
用 `env -u ELECTRON_RUN_AS_NODE npm run order:smoke`。**判是不是自己改坏的**：先
`git stash push -- <三个文件>` 跑一遍对照 —— 这条已确认改前就红。

---

## 2026-11-06 续：回执接上了（S2）——判据只有一条，落点只有一处

S1 只做了"能安全写主表"的那一层，本次把它接到真实入库链路。四条结论 + 一个会假绿的坑。

### 1. 分流判据 = **帧内带不带发货时间**，只此一条

`splitShipBatch()`（`electron/mango-ingest.ts`）是唯一实现。三种"看起来更聪明"的判据都试过，都不能用：

| 候选判据 | 为什么不行 |
| --- | --- |
| `source.status` | 芒果自己的筛选编码，语义随版本变。改一个枚举 ⇒ 已发货单被当待发货做整单替换 |
| `cnOrderStatus` 含「已发」 | 平台会先改状态、后（或永远不）写 `gmtSend`。状态文本是**异步**的，拿它分流会把"已发但还没回填时间"的单塞进回执道，那批单的明细就再也不走 upsert 了 |
| 有没有运单号 | 反向错：卖家先填运单号再点发货是常见操作，会把未发出的单判成已发 |

`shipTime` 非空是**平台写完那一刻的事实**，其余三个都是推断。守卫里专门有一条用例
（`「已发货」这四个字不是判据`）盯着这条，变异成"看状态文本"立刻红。

### 2. 落点必须是 `applyShipStatus`，不能"顺手也 upsert 一次"

`ingestMangoOrders` 里已发货单**不进 `drafts`**（连图都不下 —— 已发货不需要图）。
如果哪天有人为了"顺便刷新一下明细"让回执批也走 upsert，`[17]` 段的
「明细 id 与归类结果、包裹全都还在」会红。这条是这个功能存在的**唯一**理由，不是洁癖。

### 3. `sk_sync_log` 的 `inserted/updated` **不统计回执**

回执只 UPDATE 主表，不算"这次入库了几单"。混进去的后果是：某天有已发货单混进批里，
「入库 12」就和芒果的"共 12 单"对不上了 —— 而且只在那几天对不上，最难查。
所以 `shipped` / `shipUnknown` 写进 `detail_json`，状态条与扩展 popup 都把「已发货 N」单列。

⚠️ 纯回执批的 `inserted + updated` 是 0，界面原本会显示「抓 5 条 · 入库 0」——**看着像失败**。
这就是必须单列的那个数，不是装饰。

### 4. 两个"不猜"（都还没证据）

- **「已发货」筛选页 URL 没有实证**：`#/erp/order/list/search/status/正常/normal` 里
  `正常/normal` 是**订单分组**（fixture 里 `status:"normal"` 与 `cnOrderStatus:"等待卖家发货"`
  同时出现），已发货对应的段名没人抓过。所以**没做「去收发货回执」按钮** ——
  打开错列表不会报错，用户只会以为"芒果就是这样的"。
- **「正常」分组里到底有没有已发货单**：扩展仓库的芒果探针笔记里列的三个待验证问题之一，
  至今无答案。真实库侧面证据：`oi_orders` 7 单全是「等待卖家发货」，`ship_time` 全空
  ⇒ **一单已发货都没采过**。所以 S2 目前的价值是预防性的，不是"队列已经能清零了"。

要真正验收，得有人在芒果把列表切到已发货抓一轮，然后看 `logistics_no` 有没有值、
`oi_order_items.style_color_id` 有没有被清成 0。

### 5. 坑：同步的冒烟脚本里塞 async 段，会变成**假绿**

`order-db-smoke.cjs` 是顶层顺序执行的同步脚本，收尾是 `closeDb()` + `process.exit(failed?1:0)`。
新加的 `[17]` 段要 `await ingestMangoOrders(...)`（内部有图下载的 Promise）。直接把
async 段写成顶层 `await` 不行（CJS），写成不 await 的调用则是：

```
runShipIngestChecks()   // 没人等它
closeDb(); process.exit(0)   // 立刻退出，exit 0
```

段内断言还没跑，进程已经以 0 退出 —— **报告写"全部通过"，但一条都没验**。
正确写法是把收尾整体挪进 async IIFE，并 `try/catch` 把异常计进 `failed`：

```js
;(async () => {
  try { await runShipIngestChecks(); }
  catch (err) { failed++; console.log(`  ✗ [17] 段整体异常：${err.message}`); }
  closeDb();
  ...
  process.exit(failed ? 1 : 0);
})();
```

判断依据一样：**看退出码 + 看那几行 ✓ 是否真的打印出来**，不能只看最后一句"全部通过"。

---

## 2026-11-06 续二：已发货页地址到手 —— 但"能打开"不等于"能抓到"

用户直接从浏览器地址栏给出：`#/erp/order/shipment/search/status/已发货/delivered`。
上一轮"没做这个入口"的判断当天被推翻，补了按钮。**但真正的风险点没被这条 URL 解决**。

### 1. 两个入口的 URL 必须成对钉住

```
待发货  …/erp/#/erp/order/list/search/status/正常/normal
已发货  …/erp/#/erp/order/shipment/search/status/%E5%B7%B2%E5%8F%91%E8%B4%A7/delivered
```

注意 `list` vs `shipment` —— 这是芒果的**两个路由模块**，不是同一个列表换个筛选。
最现实的错法是复制上一行忘改路径段：按钮照样弹窗口、照样是芒果，**只是列表不对**，
用户以为自己发过货的单都在，其实看到的是待发货那批。所以 `tests/mangoOpen.spec.ts` 的
主断言不是"等于某个字面量"，而是**两个地址必须指向两个不同的模块段**（变异：把已发货改成
照抄待发货 ⇒ 红 2 条）。`today:ui` 也钉了一层：点「收已发货回执」打开的 URL 含
`order/shipment` 且**不含** `order/list`（变异：接线改回 `openMangoPending` ⇒ 红）。

编码形态不一致（一个原样中文、一个百分号编码）是**故意的**：两个字符串分别来自
"此前实测可用"与"用户提供的原文"。两种浏览器都认，别为了统一去改其中一个。

### 2. SPA 路由不同 ⇒ hook 是否命中**仍然未知**

扩展的 hook 只认 `POST /erp/order/data/search.json`，且 `phase` 必须为空或 `order`
（`mango-main.js` 顶部）。`shipment` 是另一个路由模块，所以有两种静默失败：

| 情况 | 现象 | 后果 |
| --- | --- | --- |
| 打的是另一个接口路径 | 扩展一条都不抓 | 用户看到"还没有抓到"，与"芒果没有已发货单"**完全无法区分** |
| 同接口但 `phase` 是别的值 | 同上 | 同上 |

这就是为什么按钮做完了还得补诊断。

### 3. 诊断的形状：只在"看见了但没接上"时说一句

`mango-main.js` 新增 `type: 'unmatched'`：

- 判据不是路径白名单，而是**结构**：`data.list` 非空且元素带 `orderNo`/`orderId`
  （`looksLikeOrderList`）。路径白名单会把"芒果改版"判成"这一页没有订单"。
- 触发点两处：接口路径不匹配、`phase` 不匹配；每（URL+原因）每页只报一次（挡刷屏）。
- 落点：`bridge.js` 存 `storage.unmatched`，**不写 `at`** —— `at` 是"上次抓取时间"，
  写进去 popup 会显示"刚抓过"却一条没有，比没有诊断更误导。
- 显示：popup 在 `unmatched.at >= 最后抓取时间` 时把它排在 `notice` 最前
  （否则会被上一次的 `skip` 文案"内容与上次一致"盖掉）。真抓成之后自动不再显示。

反向要求同样重要：**空列表 / 非订单列表不许报**。真实页面有大量 `/erp/order/` 下的
字典类响应，逐个报一遍等于把 popup 变成噪音墙，真出问题那条会被淹掉
（变异：去掉结构判据改"路过就报" ⇒ 红；`phase` 不报 ⇒ 红）。

### 4. 下一步只有三条路，都得靠真跑一次

在浏览器打开那个地址，看扩展 popup：

1. 「抓 N 单」⇒ 接口与 `phase` 都对，回执通了，直接进 S3 验收；
2. 「阶段不对（phase=xxx）」⇒ 接口同源，把那个 `phase` 加进白名单；
3. 「接口路径不是 …」⇒ 得先拿到那个 URL（F12 Network 里挑响应带 `orderNo` 的那条）。

**都不许猜**：白名单放宽的后果是把打包/发货阶段的单混进订单状态语义，而那种错误
只在某天有人同时打开两个页面时才出现。

## 2026-11-06 续三：真跑结果 —— 路径实证到手，字段名仍未知；先侦查再写码

用户回传 popup：「这一页的订单接口没抓：接口路径不是 /erp/order/data/search.json
（phase=shipment&pageSize=30&page=1&fuzzyO）」。三种可能里的第 3 种。

### 1. 诊断设计省掉一次往返

`unmatched` 落 storage 时带了 `url` 字段，直接从本机 Chrome 扩展存储里读出真实值：

```
接口    POST /erp/order/data/package/delivered?_xid=…
请求体  phase=shipment&pageSize=30&page=1&fuzzyOrderId=…&fuzzyLogisticsNo=…
```

所以「哪个接口」**不用再开 F12**：上一节第 3 条写的"得先拿到 URL"被诊断本身解决了。
教训：诊断 payload 必须带完整 URL 且落到可读取的地方；只把 reason 显示给用户，
等于把"再跑一次"的成本转嫁给用户。

### 2. 用户的方法论纠正（对）

「是不是应该在 mango-probe 里先写个侦查，看看具体是哪个接口，再来写插件代码？」——
对。我上一轮准备直接放宽接口正则 + phase 白名单就接抓取，跳过了响应结构侦查。
现状是**路径已知、字段未知**：

- 订单号是 `orderId` 还是 `orderNo`？已发货页首条带哪个？
- 发货时间是不是仍叫 `gmtSend`？运单号是不是 `logisticsNo` / `mailNo`？
- 有没有 `orderItemList`？`data` 包络是不是同一套（`totalItems` / `list`）？

不实证就写解析，最坏不是"抓不到"，而是**帧里 `shipTime` 为空 ⇒ 宿主 `splitShipBatch`
判成待发批 ⇒ `upsertCollectedOrder` 整单替换**，静默清掉归类与图案绑定。
⇒ 以后接入必须带闸门：已发货来源的帧若一条都不带发货时间，整批拒收并报警，绝不进 upsert。

### 3. 本轮只做侦查，不动抓取代码

在扩展仓库的侦察扩展里加摘要纯函数（可单测）：

- 判据沿用**结构 + 请求体 `phase=shipment`**（`data.list` 首条带 `orderNo`/`orderId`），
  **不是路径白名单** ⇒ 芒果改版换路径照样能发现；
- 待发帧 / 字典响应 / 空列表 / 坏 JSON 一律不算命中，别让噪音淹掉真接口；
- popup 加「复制已发货侦查」：导出接口路径、请求体、`totalItems`、首条**全部字段名**、
  发货相关字段的**值**、数组型字段及长度；**不导出买家姓名/地址的值**；
- 新测试钉住判据、隐私边界、去重、多接口并列，以及"探针 hook 确实拦得到这条接口"。
  全量扩展测试绿；探针升 0.1.1 并打包。

### 4. 关卡

等用户回传字段摘要后才动采集扩展：**按实证字段**写解析 + 接入，并先加防误替换闸门。
摘要到手前采集扩展保持 1.1.1 不动（不刷新、不 bump），避免"同版本换内容"式误判。

## 2026-11-06 续四：侦查到手 —— 已发货是「包裹」列表，不是订单列表

用户回传 `mango-probe` 完整导出（48 条捕获）。关键那条是
`POST /erp/order/data/package/delivered?_xid=…`，请求体
`phase=shipment&status=delivered&pageSize=30&page=1&shipmentTime=[…]`，
响应 `data.totalItems=897` / `data.list[]`。**这一页返回的是包裹，不是订单**：

| 字段 | 位置 | 实测值 |
| --- | --- | --- |
| 订单号 | 包裹顶层 `orderId` | `8215211057763233` |
| 运单号 | 包裹顶层 `logisticsNo` | `CNG00100152845555` |
| 发货时间 | 包裹顶层 `gmtSend`（毫秒） | `1793934203000` |
| 状态 | 顶层 `status` / `step` | `delivered` |
| 明细 | **内嵌** `orderResponse.orderItemList[]` | 顶层没有 |
| 内嵌 `orderResponse.logisticsNo` | — | **`null`** |

### 1. 侦查省下的两个坑（不侦查必然踩）

- **运单号取错层**：内嵌 `orderResponse.logisticsNo` 是订单级且实测为 `null`，
  直觉上"订单对象里找运单号"会得到整列空。只能取包裹顶层。
- **空壳帧静默整单替换**：包裹顶层没有 `orderItemList`，若复用 `toOrder()`
  会得到 `lines: []` 的帧。只要有一条缺 `gmtSend` 被 `splitShipBatch` 判成待发批，
  `upsertCollectedOrder` 就 DELETE + 重插，清掉 `style_color_id` / 图案绑定 / 包裹，
  **界面不报错**。测试里专门钉住「`toOrder(包裹)` 产出空明细」这个事实。

⇒ 已发货走**独立解析**（`toShipReceiptFrame`），只给单号 / 发货时间 / 运单号 /
承运商 / 中文状态 `已发货`；不带明细，不进 upsert。

### 2. 双闸门（兑现续三的关卡）

| 层 | 判据 | 动作 |
| --- | --- | --- |
| 扩展 | `planShipReceiptFrames()` 剔除「有单号但缺 `gmtSend`」的包裹，计入 `source.noShipTime`；有效帧 0 条 | `type:'error'`，**整批不推**（推空数组会把"接口变了"伪装成"今天没单"） |
| 宿主 | `source.kind==='shipped'` ⇒ 整批强制 `planShipReceipt`；`bad.length>0` 或 `withShipTime !== receipts.length` | `ok:false` 整批拒收 + 写日志，**绝不进 `upsert`** |

`scripts/order-db-smoke.cjs [18]` 端到端证明：正常回执批写主表后，
明细 id / 归类 / 包裹与写之前**逐项相同**；坏帧批 `shipped=0` 且现场零变化。

### 3. 接线的几个口径决定

- **沿用 `schema: 'mango-order/v1'`**：宿主接收端只认这一个常量，批次性质放 `source.kind`，
  不为此另开协议（少改一处已发布代码，也少一次 400）。
- **只取最近一页、历史不补**：首页试放大 `pageSize` 到 100，服务端不认退回 30。
  `source.totalItems` 写**本次送出条数**，平台累计放 `source.platformTotal`（只做诊断），
  否则宿主拿 897 与 30 对账会误报「疑似漏抓」。
- **一单多包裹按 `orderNo` 去重**，保留发货时间最晚的运单号；合并数进 `source.duplicate`。
  这是有解释的取舍，不是"最后遍历到的那条"。
- **仍不写 `ship_time`**（`writeShipTime:false`）：发货台队列只看 `biz_status`，
  而拣货/拿货页靠 `ship_time=''` 找活，写了会让欠货静默消失。
- popup 的「完整度」对回执批显示「回执批」，不显示「完整」——否则 30/897 会被读成全同步完了。

### 4. 方法论沉淀

诊断带完整 URL ⇒ 省掉一次 F12；**但路径实证不等于字段实证**。
「先侦查响应结构，再写抓取代码」这条顺序，本轮至少挡住了两次静默数据损坏。

### 5. 真跑验收（2026-11-06 13:27 / 13:28，闭环）

扩展 1.1.2 在已发货页连抓两次，`sk_sync_log` 两条 `kind:'shipped'`：
98 帧 / `shipUpdated=6→0` / `shipUnknown=92` / `noShipTime=0` / `duplicate=2` /
`platformTotal=897` / `inserted=updated=0`。

字段实证在真数据上成立：包裹顶层 `logisticsNo` 有值（不是内嵌 `orderResponse` 的 `null`），
承运商取 `orderResponse.orderItemList[0].logisticsServiceName` 得到
`AliExpress Standard Shipping`；6 单写入 `biz_status=已发货` / `logistics_no` /
`logistics_carrier`，`ship_time` 保持 `''`。队列 7→1（剩 `3077041601058259`）；
第二次 `shipUpdated=0` 说明 `applyShipStatus` 的写前比对生效；
7 单明细 / 归类 / `purchase_sources` 零变化，说明独立回执解析确实没触发 DELETE+重插。
92 单「本地没有」是「只补库内待发 ∩ 平台已发、历史不补」的预期结果，不是漏抓。

排障备忘：再遇到「抓到了 N 单但状态没变」，先看 `sk_sync_log.detail_json` 里的
`columns` 与 `shipUnknown`，别先怀疑 popup —— 历史不补决定了大多数帧本来就该被忽略。

---

## 2026-11-05 续：帧里还有一整组字段没人取（发货回执），以及"回写"为什么不能走原入库路径

用户问「到芒果抓已发货怎么抓、抓哪些、历史补不补」。核查后三条答案，附两个坑。

### 1. 抓取侧零改动：切筛选即可，但**别信 `source.status`**

扩展 hook 的是 `POST /erp/order/data/search.json`，**直接复制页面自己发的请求体**、只改
`page/pageSize` 再重放翻页 ⇒ 筛选条件就在 body 里。把芒果页面切到「已发货」，同一段 hook
自动抓那一批。

但它随帧推的 `source.status` 是**芒果自己的编码**（`sp.get('status')`），语义随版本变；
拿它判"这是哪一批"等于把版本差异变成静默错分。**判据要取帧内的事实**：每单自己的
`cnOrderStatus` + `gmtSend` 是否非空。`planShipReceipt().withShipTime` 就是干这个的 ——
只写进日志让人看"12 单里 12 单带发货时间"，不参与任何分流。

### 2. 帧里一直有、宿主一直没取的字段

| 需要的 | 原始响应键 | 规整帧键（S2 补） | 此前状态 |
|---|---|---|---|
| 发货时间 | `gmtSend`（毫秒；未发货时 `null`） | `shipTime` | 没人取 ⇒ `oi_orders.ship_time` 至今**全空** |
| 运单号 | `logisticsNo` / `mailNo` | `logisticsNo` | 没人取 |
| 承运商 | `logisticsServiceName` / `logisticsTypeCode` | `logisticsCarrier` | 没人取 |

**`raw_fields.采集帧` 里挖不出历史发货时间**：那些帧是待发货时抓的，`gmtSend` 本来就是
`null`；挖一遍只能捞到"采集那一刻已发出去"的零星单 —— 有偏样本比没有更误导。

落库进主表（`logistics_no` / `logistics_carrier`），不塞 `raw_fields`：查件按运单号查、
算运费按承运商聚，JSON 挖得出但索引不了。

### 3. 回写**绝不能**喂 `upsertCollectedOrder`（这是整件事的重点）

它是**整单替换**（DELETE 主表 + DELETE 全部明细 + 重插）。一单从待发变已发后照常重采集，
会静默丢掉：

- `oi_order_items.style_color_id` —— **归类结果**（行是重插的新 id）；
- `oi_item_parts` —— 图案绑定（POD 命根子，`ON DELETE CASCADE`）
- `parcels` / `parcel_lines` —— 代码**显式删除**；
- `purchase_sources.order_item_id` —— 软键（无外键）⇒ 变**悬空 id**，覆盖率 join 不上，
  "已拿"掉回 0、"还差"虚高，**界面不报错**。

行数守卫救不了：已发货单行数不变，`lines.length < oldCount` 不成立 ⇒ 照样替换。
这条已在 `scripts/order-db-smoke.cjs` 的 `[9.5]` 写成**对照实验**：同一单走
`upsertCollectedOrder` 后 `style_color_id` 全变 0、包裹归零。哪天它变绿了，说明整单替换的
缺陷被修了，那时该改写 `applyShipStatus` 头上"为什么必须有它"的注释，而不是默默删掉。

`applyShipStatus` 的三条不变量（都有冒烟 + 变异验证）：
1. **只写 4 列**，金额与时效（`amount_cents` / `deal_deadline` / `timeout_at`）一个都不写 ——
   写了会让利润表与截止风险历史随"什么时候点的采集"漂移；
2. **幂等**：目标值 == 现值不写（同一批跑两遍，第二遍全 `unchanged`）；
3. **空值不算指令**：`''` = "这次没给"，不是"清空"（一次不完整的帧不该把运单号抹掉）。

### 4. `ship_time` 默认不写 —— 它有两个不同的下游

- 发货台队列读 **`biz_status`**（`isWaitingShip`）⇒ 写它就够让队列清零；
- 拣货 / 拿货读 **`ship_time = ''`**（`picking-db` / `purchase-db` 的过滤）⇒ 写它会让这些单
  **从拿货页静默消失**，"发了货但没拿货"的欠货变得不可见。

所以 `opts.writeShipTime` 缺省 `false`。要开这一列，先给那类单一个可见入口，别顺手打开。

### 5. 两个坑

**坑一：新列写进已发布的迁移版本 = 存量库永远拿不到。**
`migrate()` 只跑 `version > current` 的步骤。把
`ALTER TABLE oi_orders ADD COLUMN logistics_no` 加进 **v13**（用户库早已记账到 13）⇒
新库建表带上、老库永远没有，运行时 `SELECT logistics_no` 报 `no such column`
（不在建表时炸，更难查）。必须是**新的 v14**。
实测（`sqlite3 .backup` 出真库副本 → 跑 `ensureOrderSchema`）：
`order.main v13 · logistics 列 = []` → `v14 · ["logistics_no","logistics_carrier"]`，
二次 `ensureOrderSchema` 不抛错，7 单 `ship_time` 仍全空（只加列不回填）。

**坑二：`npm run order:smoke` 在本机会假红。**
继承 `ELECTRON_RUN_AS_NODE=1` 时 `require('electron')` 返回路径串 ⇒ `app` 是 `undefined`，
报 `Cannot read properties of undefined (reading 'getPath')`，看着像数据层坏了。
用 `env -u ELECTRON_RUN_AS_NODE npm run order:smoke`。**判是不是自己改坏的**：先
`git stash push -- <三个文件>` 跑一遍对照 —— 这条已确认改前就红。
