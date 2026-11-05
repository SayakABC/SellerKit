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
