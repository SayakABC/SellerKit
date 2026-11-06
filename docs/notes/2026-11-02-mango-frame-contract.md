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
