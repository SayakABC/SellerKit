# 芒果订单入库与 POD 图案域 · 施工总纲

> **本文件是 2026-11 这一轮的唯一施工入口。** 任务编号一律以本文为准。
>
> 上游两份专门文档作为技术附录引用，**不再单独施工**：
> - [`MANGO_ORDER_EXTENSION_PLAN.md`](./MANGO_ORDER_EXTENSION_PLAN.md) —— 扩展侧原理（world:MAIN / 翻页 / 失败模式）
> - [`POD_PATTERN_PIPELINE_PLAN.md`](./POD_PATTERN_PIPELINE_PLAN.md) —— 图案域 DDL 与判别链（**已在真库副本跑通**）
> - [`ORDER_AUTO_SYNC_PLAN.md`](./ORDER_AUTO_SYNC_PLAN.md) —— 现状实测与三个断点（本次开工的直接对象）
>
> 结论层（不重复任务分解）：[`../notes/2026-11-01-mango-collect-and-pod-conclusions.md`](../notes/2026-11-01-mango-collect-and-pod-conclusions.md)

---

## 0. 一页结论

现在这套系统**通道全通，但一个订单都没进来过**。

```
扩展已经能抓（mango-order 已建成，npm test 全绿）
  ↓ POST 127.0.0.1:46211/mango/ingest
✗ 路由不存在 → 404          ← T1-3
✗ 就算有路由，四个断点会吞掉数据  ← T0-1 ~ T0-5
✗ 进来了也只是死数据：状态空 / 键空 / 无图  ← T0-6、M2
✗ 图案域一张表都没有  ← M3
```

**六个阶段的判据（每一阶段末尾的那条 SQL/命令不过，不进下一阶段）**：

| 阶段 | 一句话 | 终点判据 |
|---|---|---|
| **M0** 断点修复 | 采集路径不再丢字段 | 采集单 `variant_key` 非空率 **100%** |
| **M1** 入库通道 | 扩展推得进来 | `oi_orders` 里出现 `source='collect'` 且字段齐 |
| **M2** 今日待办 | 打开就知道今天做什么 | 首屏 3 秒内出「待发货 N 单 / 有截止风险 M 单」 |
| **M3** 图案槽位 | 560 槽位绑到图案 | 覆盖率 ≥ 60%，**塌陷链接 50 槽 100%** |
| **M4** 报单闭环 | 花纸按图案聚合 | 一次报单产出 `清单.xlsx + 图稿`，余量够的净需件 = 0 |
| **M5** 开机自动化 | 重启电脑无人干预完成同步 | 断网/登录过期/扩展未装三种演练全过 |

**合计 ≈ 11.5 个工作日**（M0 1.5 / M1 2 / M2 1.5 / M3 3 / M4 2 / M5 1.5）。

---

## 1. 现状取证（开工前自己跑一遍，别信本文的数字）

```bash
DB="$HOME/Library/Application Support/seller-kit/sellerkit.db"

sqlite3 "$DB" "SELECT source, COUNT(*) FROM oi_orders GROUP BY source;"          # import|70
sqlite3 "$DB" "SELECT COUNT(*) FROM oi_orders WHERE biz_status='';"              # 70  ← 状态全空
sqlite3 "$DB" "SELECT COUNT(*), SUM(variant_key<>''), SUM(image_id IS NOT NULL)
               FROM oi_order_items;"                                             # 75|75|75（导入路径齐）
sqlite3 "$DB" "SELECT COUNT(*) FROM sk_shops;"                                   # 16
sqlite3 "$DB" "SELECT COUNT(*), COUNT(DISTINCT shop_id) FROM pl_shop_items;"     # 71|2 ← 只采过 2 家店
sqlite3 "$DB" "SELECT name FROM sqlite_master WHERE name LIKE 'pod%';"           # 空 ← 图案域未建
sqlite3 "$DB" "PRAGMA table_info(oi_order_items);" | cut -d'|' -f2 | tr '\n' ' ' # 无 item_id
```

```bash
cd <SellerKit 仓库>
grep -rln "setLoginItemSettings" electron/   # 空 → 无开机自启
grep -rln "new Tray(" electron/              # 空 → 无托盘
grep -rln "new Notification(" electron/      # 空 → 无系统通知
grep -rn  "setInterval" electron/main.ts     # 空 → 无调度
```

---

## 2. 系统优化点清单

> 每条都带**落点**（`文件:行` 或可执行命令）与**为什么现在必须改**。分三级：P0 阻断 / P1 缺口 / P2 卫生。

### 2.1 P0 · 数据链路断点（四个，全部在采集路径上）

| # | 问题 | 落点 | 后果 |
|---|---|---|---|
| **A1** | **`itemId` 被直接丢弃**。`upsertOrderBatch` 算出了 `itemId`（`ae-db.ts:725`），传进 `upsertCollectedOrder` 的 `lines` 后，`ins.run()` 只用了 `size/rawJson/color/qty` —— 商品ID 一个字都没写库；`oi_order_items` 连 `item_id` 列都没有 | `order-db.ts:4116-4129` | **采集单一行都拼不出 `variant_key`**，图案绑定、款色归类、成本全部落空 |
| **A2** | **`image_id` 在采集路径写死 `NULL`** | `order-db.ts:4117-4118`（`VALUES (?, NULL, …)`） | 色名塌陷的 6 链接 / 50 槽位**永远判不出图案** |
| **A3** | **整帧塞进 `raw_fields`**：`rawFields: { 采集帧: JSON.stringify(o) }` | `ae-db.ts:738` | `variantKeyOfRow` 在**顶层**找「产品ID」，永远找不到 → 静默返回 `''` |
| **A4** | **`source` 互斥直接抛错**：`if (existed && existed.source !== 'collect') throw` | `order-db.ts:4088` | 存量 70 单全是 `import`，采集一开跑**全部被拒**；而 `ae-db.ts:749` 只 `console.warn` 后计入 `skipped` —— 界面上只有一个数字，**没有原因** |
| **A5** | **`/mango/ingest` 路由不存在** | `ae-receiver.ts:333-351`（白名单只有 4 条） | 扩展推过去 404（扩展已内置人话提示） |
| **A6** | **`biz_status` 70/70 全空** | 数据现状 | 发货台算不出「待发货」，只能算「未发货」（含取消单） |

### 2.2 P1 · 能力缺口

| # | 缺口 | 取证 | 补法 |
|---|---|---|---|
| **B1** | 无开机自启 | `setLoginItemSettings` 零命中 | T5-2 |
| **B2** | 无托盘 | `new Tray(` 零命中 | T5-1 |
| **B3** | 无系统通知 | `new Notification(` 零命中 | T5-5 |
| **B4** | 无调度 | `setInterval` 在 `main.ts` 零命中 | T5-3 |
| **B5** | **无同步日志** | 无 `sk_sync_log` 表 | T1-6。「抓 0 条」与「今天没单」现在**无法区分** |
| **B6** | `splitVariantKey` 硬编码 `p.length !== 3` | `variantKey.ts:72` | 4 段键拆出来是全空串且**不报错** |
| **B7** | 图案域一张表都没有 | `pod%` 查询为空 | M3 |
| **B8** | `pl_shop_items` 只覆盖 **2/16 店** | `COUNT(DISTINCT shop_id)=2` | 绑定覆盖率的分母是虚的，需先把采铺开（T3-8） |
| **B9** | 芒果字段无处安家：`pay_time` / `shop_auth_id` / `deadline` / `country_code` / `weight_g` | `ORDER_HEADER_COLS` 只有 11 列 | T0-1 / T1-2 |

### 2.3 P2 · 工程卫生

| # | 问题 | 处置 |
|---|---|---|
| **C1** | 两个仓库工作区都有大量未提交改动（SellerKit 30+ 文件、Extensions 12+ 文件） | 按主题拆提交后再开工，**否则改动混在一起无法回退** |
| **C2** | `MANGO_ORDER_EXTENSION_PLAN.md` §4「多账号」已实证作废（单 erp 账号管全部店） | 文档已自注作废，不需改代码 |
| **C3** | `ae-profit` 扩展与 `mango-order` 是两个独立扩展，用户要装两次 | 可接受（职责不同），但 README 要写清"装哪个" |

---

## 3. 目标架构

```
┌─ 采集层（Chrome 扩展，用户自己的浏览器，登录态天然复用）────────────┐
│  mango-order 扩展                                                  │
│   ├ world:MAIN hook fetch/XHR（document_start）                    │
│   ├ 主动翻页（复制 form body 改 page/pageSize，先试 100/页）        │
│   └ 只认 phase=order；先放 pageSize=100，第 2 页全重复即停并标 partial│
└──────────────────────────┬─────────────────────────────────────────┘
                           │ POST 127.0.0.1:46211/mango/ingest
                           │ X-Ae-Token / schema: mango-order/v1
┌──────────────────────────▼─────────────────────────────────────────┐
│─ 落地层（主进程）─────────────────────────────────────────────────── │
│  mango-ingest.ts                                                   │
│   ├ 门店匹配：authId 优先 → 别名回落 → 落"未登记桶"（不报错）        │
│   ├ 图片落地：imgUrl → md_images（内容寻址）→ oi_order_items.image_id│
│   ├ 键计算：variant_key（3/4 段）+ sku_code（并列，图案首选锚点）    │
│   └ 写 sk_sync_log（每批一条：条数/入库/跳过/原因）                  │
├────────────────────────────────────────────────────────────────────┤
│─ 图案层 ──────────────────────────────────────────────────────────── │
│  pod_patterns / pod_variant_patterns / pod_sheet_batches /          │
│  pod_sheet_ledger / pod_pattern_balance(view)                      │
│  判别链：图键 → 色名（塌陷链接禁止降级）→ 人工队列                   │
└────────────────────────────────────────────────────────────────────┘
                           │
┌──────────────────────────▼─────────────────────────────────────────┐
│─ 呈现层 ──────────────────────────────────────────────────────────── │
│  发货台·总览：待发货 N / 有截止风险 M / 件数 / 缺图 K               │
│  图案台：绑定（键盘流）/ 报单（净需件）/ 余量看板                    │
│  采集状态条：上次同步时间·条数·失败原因                             │
└────────────────────────────────────────────────────────────────────┘
```

---

## 4. 任务分解

> 每个任务给：**做什么 / 落点 / 判据 / 依赖**。
> 判据必须是**可执行的命令或 SQL**，不接受"跑通了"。

### M0 · 数据链路断点修复（1.5 天）

> **目标**：采集路径写进来的行，和导入路径一样齐（`item_id` / `image_id` / `variant_key` 都不为空）。
> **不修这一阶段，后面全是无用功。**

| 编号 | 任务 | 落点 | 判据 | 依赖 |
|---|---|---|---|---|
| **T0-1** | 迁移 **v13**：`oi_order_items` 加 `item_id TEXT NOT NULL DEFAULT ''`、`sku_code TEXT NOT NULL DEFAULT ''`；`oi_orders` 加 `pay_time`、`shop_auth_id`、`deal_deadline`、**`timeout_at`**（TEXT，默认 `''`；D-2 按推荐"两个时效时点都存"执行）。照 `addVariantKeys()` 的幂等模式写；**ALTER 不能写进 `db.exec(SCHEMA)`**（SQLite 无 `ADD COLUMN IF NOT EXISTS`，重复执行报 `duplicate column name`） | `order-db.ts` `orderMigrationSteps()`（v12 之后新增第 13 步） | `npm run schema:smoke` 全绿；真库副本跑一遍后 `PRAGMA table_info` 六列齐全且 `version=13` | — |
| **T0-2** | `upsertCollectedOrder` 落齐四列：`item_id`=line.itemId、`sku_code`=line.skuCode、`image_id`=落地后的图、`variant_key`=`variantKeyOf({shopKey,itemKey,colorKey,imageKey})` | `order-db.ts` `upsertCollectedOrder` | 冒烟脚本插一单，`SELECT item_id<>'' AND variant_key<>'' AND image_id IS NOT NULL` 为 1 | T0-1 |
| **T0-3** | `raw_fields` 仍存整帧快照（保真不能丢），但**每行**叠加 `商品ID` / `产品属性` 两个可识别键 —— 让既有 `extractSkuFields` 与 `parseOrderPropsColor` 的键名族能命中 | `order-db.ts` `upsertCollectedOrder` 的行写入 | 采集单在「发货台·归类」里**不再显示为未识别**；`raw_fields['采集帧']` 仍在 | T0-1 |
| **T0-4** | `source` 升级：`import → collect` **允许**（同单更好来源），`collect → import` 禁止；抛错改成**不抛**，走"拒绝并回执原因"。另加**行数不缩水**保护：帧行数少于已有行 ⇒ 整单不写（残帧不许静默删历史行） | `order-db.ts` `upsertCollectedOrder` | 对 import 单推同号采集帧 → 该单 `source='collect'` 且行数不变；推 1 行到 2 行的单 → 整单不写 + 原因非空 | — |
| **T0-5** | `skipped` 带原因：`upsertOrderBatch` 返回 `skips: [{orderNo, reason}]`（上限 50 条），`/ae/ingest` 与 `/mango/ingest` 回执带上；消毒阶段与入库阶段的跳过**原因分开给** | `ae-db.ts` `upsertOrderBatch`、`ae-receiver.ts` | 故意推一条坏帧 → 回执 `skips[0].reason` 非空 | T0-4 |
| **T0-6** | `variantKeyOf` 加第 4 段 `imageKey`（**只有非空才追加**，存量 3 段键逐字节不变）；`splitVariantKey` 接受 3/4 段、其他长度视为脏键；新建 `electron/podImageKey.ts`（`imageKeyOf(url)` 纯函数，**已把 T3-2 提前做掉**）；`variantKeyOfRow` 加 `imageUrl` 可选参数 | `variantKey.ts`、`order-db.ts`、新 `podImageKey.ts` | 单测：`(shop,itemId,color,imgUrl)` 得 4 段键、不给 URL 与旧实现逐字节相同 | T0-1 |

**阶段门禁**：

```sql
-- 采集一单之后跑：必须 100%，不是"接近 100%"
SELECT COUNT(*) AS 行数,
       SUM(item_id <> '')     AS 有商品ID,
       SUM(variant_key <> '') AS 有变体键,
       SUM(image_id IS NOT NULL) AS 有图
FROM oi_order_items oi JOIN oi_orders o ON o.id = oi.order_id
WHERE o.source = 'collect';
```

> ⚠️ **`WHERE variant_key = ''` 是硬陷阱**：存量 75 行键已非空，改了函数**一行都不会更新**。
> 本轮**不重算存量**（那是 M3 T3-6 的定向重算，且只对塌陷链接）。

#### M0 施工记录（2026-11-01 完成）

| 判据 | 实测结果 |
|---|---|
| `npm run schema:smoke` | ✅ 全绿（新库列序自校验 + 老库 v8→v13 升级 + 二次幂等） |
| 真库副本跑 v13（不动线上库） | ✅ `version=13`；主表 4 列 / 明细 2 列齐全；**70 单 / 75 行 / 75 个变体键逐字节不变**；二次运行无 `duplicate column name` |
| `npm run order:smoke` | ✅ 全绿（新增 5 条：四列齐 / 无图仍 3 段 / import→collect 升级 / 残帧拒绝 / 重推同源） |
| `npm run ae:smoke` | ✅ 全绿（新增 `skips[0].reason` 非空断言） |
| `npx vitest run tests/variantKey tests/podImageKey` | ✅ 24 例（含"不给图键与旧实现逐字节相同"的防回归） |

**与上表的偏离（都已回改上表，此处只记原因）**：

1. **T0-1 多加了 `timeout_at`** —— D-2 的推荐是"两个时效时点都存"，若先只建 `deal_deadline`，
   等核对完再补一列就要多一次 v15 迁移。一次建两个字段，界面先只显示 `deal_deadline`。
2. **T0-4 的判据从"整单替换"改为"行数不缩水"** —— 原计划只想到"采集覆盖导入"这一种冲突，
   实际还有一种更坏：**采集帧本身是残的**（翻页中断 / 某行解析失败），整单替换会静默删掉
   这单的历史行，之后按行统计"买了几件"就永久偏少。现在任何来源下帧行数少于已有行都整单不写。
3. **T0-6 不做回填查询的 JOIN**（原计划要 JOIN `md_images` 取 `source_url`）—— 存量 75 行键已非空，
   回填只会影响"键为空"的行（那些行是没有商品ID的，加图键也拼不出键），JOIN 是死代码。
   图键能力建在**写入路径**上（采集帧自带 `productImgUrl`），回填留给 M3 T3-6 的定向重算。
4. **T3-2 提前做掉**：`podImageKey.ts` 是 T0-6 的依赖，先建了（含 6 例单测）。M3 到时不用再做 T3-2。

---

### M1 · 芒果入库通道（2 天）

> **目标**：扩展推过来的帧能落库，字段完整，店铺对得上，失败有日志。

| 编号 | 任务 | 落点 | 判据 | 依赖 |
|---|---|---|---|---|
| **T1-1** | 新增 `electron/mango-ingest.ts`：芒果帧 → 内部结构。**只做映射与校验，不写库**（写库仍走 `upsertCollectedOrder`，一处写口径不分裂） | 新文件 | vitest 覆盖 `toInternal(frame)` 五种输入（正常/缺订单号/缺店/空行/塌陷行） | M0 |
| **T1-2** | `oi_orders` 三个新列在写入时填：`pay_time`（`gmtPayTime`，**发货时效起点**）、`shop_auth_id`（= 芒果 `authId`）、`deal_deadline`（见 D-2 拍板） | `order-db.ts` `upsertCollectedOrder` | 采集单 `SELECT pay_time, shop_auth_id, deal_deadline` 三列非空 | T0-1 |
| **T1-3** | 新增路由 `POST /mango/ingest`：复用 ae-receiver 的 token/限速/1MB/100 条防线；`schema` 只认 `mango-order/v1` | `ae-receiver.ts` 白名单 + 新 handler | `curl -XPOST 127.0.0.1:46211/mango/ingest -H 'X-Ae-Token: …' -d '{…}'` 返回 `{ok:true}`；错误 token 返回 401 | T1-1 |
| **T1-4** | 门店匹配 **authId 优先**：`sk_shops` 加 `erp_shop_id`（芒果 `shops[].id`），匹配序 = `erp_shop_id` → 店名精确 → 未登记桶（**不报错**，与 `matchShopByStore` 同口径） | `shop-db.ts` + `mango-ingest.ts` | 真库 14 个 authId 全部落到具体店；`shop_id=0` 计数为 0 | T1-3 |
| **T1-5** | 图片落地：`imgUrl` → `md_images`（**内容寻址**，复用既有唯一图片仓）→ 取 id 写 `oi_order_items.image_id`；落地失败**不阻断入库**（图缺 <= 行缺，但要计数回报） | `mango-ingest.ts` 调 `md_images` 既有写入口 | 采集单 `image_id IS NOT NULL` 占比 ≥ 95%；`missingImage` 计数在回执里 | T0-2 |
| **T1-6** | 新表 `sk_sync_log`（`id / kind('mango') / started_at / finished_at / fetched / inserted / updated / skipped / partial / reason / detail_json`） | `order-db.ts` v13 一并建 | 每批一条；`fetched=0 AND reason<>''` 的记录存在 | T0-1 |
| **T1-7** | 冒烟 `scripts/mango-ingest-smoke.cjs`：用 `SellerKitExtensions/tests/fixtures/mango-search.sample.json` 的真实帧走一遍 → 校验四列齐 + `sk_sync_log` 有记录 + 幂等（推两次行数不变） | 新文件 + `package.json` `mango:smoke` | `npm run mango:smoke` 全绿 | T1-3 |
| **T1-8** | 扩展补 `alarms` 权限与 `autoSync`：`chrome.alarms` 每 30 分钟检查一次「今天同步过没」，最多补跑 3 次；**不做常驻轮询** | `SellerKitExtensions/extensions/mango-order/manifest.json` + `background.js` | `chrome://extensions` 无权限警告；`chrome.alarms.getAll()` 有 1 条 | T1-3 |

**阶段门禁**：

```sql
-- 推一单之后：来源、状态、键、图、日志 五项必须同时对
SELECT (SELECT COUNT(*) FROM oi_orders WHERE source='collect')        AS 采集单,
       (SELECT COUNT(*) FROM oi_orders WHERE source='collect' AND biz_status<>'') AS 有状态,
       (SELECT COUNT(*) FROM oi_order_items WHERE variant_key<>'')    AS 有键行,
       (SELECT COUNT(*) FROM sk_sync_log)                            AS 日志条数;
-- 期望：采集单 > 0，有状态 = 采集单，有键行 > 0，日志条数 ≥ 1
```

#### M1 施工记录（2026-11-01 完成）

| 判据 | 实测结果 |
|---|---|
| `npm run mango:smoke` | ✅ 25 项全绿（初版 20 项：真实帧入库四列齐 / 变体键含图键 / 图落地 / 幂等 / 红线 1 / 残帧拒写 / 店铺认亲 / 色名塌陷 / 真发 HTTP 四态；+1 项跨仓契约「用扩展 `mango-parse.js` 造帧走全链路」×4，见「M1 补记 ②」） |
| T1-3 的 HTTP 端到端 | ✅ 错 token → 401；`schema` 错 → 400（提示支持哪个）；正确帧 → 200 `{ok:true,inserted:1}` 且订单落库；空帧但 `totalItems=7` → **200 而体内 `ok:false`**（帧合法、业务失败，扩展能看见"没抓到"） |
| 真库副本跑 `shop.columns` v3（不动线上库） | ✅ `version 2 → 3`；16 家店**行数不变**；`erp_shop_id` 全部空串（未学到，不是 NULL）；二次运行无 `duplicate column name` |
| `npm test` | ✅ 1166 例 / 56 文件（新增 `mangoIngest` 18 例、`podImageKey` 6 例） |
| T1-8 扩展侧（`SellerKitExtensions`） | ✅ manifest 补 `alarms`（**静默权限**，`chrome://extensions` 无警告）并升到 1.1.0；`alarms.getAll()` 只有 **1 条** `mango:autoSync`（30 分钟）；12 组 vm 单测驱动真实监听器；两次变异确认会红（去掉次数上限 → 红；`active:false` 改 `true` → 红） |
| `verify` / `verify:docs` / `lint` / `schema:smoke` / `order:smoke` / `shop:smoke` | ✅ 全绿（lint 0 error） |

**与上表的偏离（都已回改上表，此处只记原因）**：

1. **T1-2 落了四列**（计划三列）：`timeout_at` 随 T0-1 一起建、写入路径一并填 —— 否则等 D-2 核对完再补要再来一次 v15 迁移。
2. **T1-3 的判据用冒烟里的真 HTTP 覆盖，不只手测 curl**：端口/token 走 `AE_RECEIVER_PORT` / `AE_RECEIVER_TOKEN` 指到随机端口，
   免得与正在运行的应用抢 46211（抢端口会让冒烟时绿时红，且失败原因看起来像"路由不存在"）。
3. **T1-4 的"店名精确"改成 `toNameKey` 归一键，并加了「同名多家店一律不匹配」**：取第一个会把订单落给一家只是
   恰好叫这个名字的店（图案、成本、时效全跟着错），而订单上写的是一个完全合法的店名 —— 事后无从发现。
4. **T1-6 的 `sk_sync_log` 不在 `order-db` 的 v13 里建，改在 `mango-sync.ts` 自己的 SCHEMA 里建**：日志表属采集域，
   塞进订单域迁移会让订单域知道采集的事；`ensureMangoSchema()` 幂等，谁读谁保证它在。
   列比计划多三列（`total_items` / `missing_image` / `shop_unmatched`）：红条与对账都要用它们。
5. **T1-5 加了上限**：单批最多下 200 张图、并发 4；超出的行这次没图（计 `missingImage`、留一条 warning，下次同步补），
   **不阻断入库** —— 图缺比单缺轻一个量级。
6. **T1-7 的冒烟比判据多守三件事**：残帧不删行 / 色名塌陷分键 / 店铺改名后仍认得出。前两条是 M0 期间真正
   改坏过的风险（静默丢行、图案绑错色），第三条是 authId 匹配**唯一能证伪**的地方 —— 店名相同的用例怎么断都过。
7. **冒烟的图片下载是打桩的（不联网）**：桩必须在 `require order-image-land` **之前**替换 —— 它在模块加载时就把
   `downloadFile` 抓走了，之后改 `http-client.downloadFile` 对它无效。两次变异测试确认这些守卫真的会红：
   去掉变体键第 4 段 → 3 项红；关掉行数保护 → 1 项红。
8. **T1-8 的补跑是「刷新已有的列表页」而不是「有新数据才补」**：列表页开着但几小时前抓失败了（当时应用没启动），
   它**不会再自己发请求** —— 不刷新就永远卡在失败态。所以 `hasListTab` 的结论是 `reload` 而不是"等着它自己抓"。
   另外 `ok:false`（抓 0 条但芒果说有单）**不置"今天已同步"**：那正是最需要补跑的时候。
9. **认店不吃店铺状态（2026-11-01 用户纠正，原实现是错的）**：原 `shopIdentityIndex()` 带
   `WHERE status='active'`，理由是"退店不该再接新单"—— 但芒果推来的是**已下的单**，不是新单。
   过滤会把已退店那 19 单（八店 5 / 十二店 14）扔进未登记桶，订单写芒果 `alias`、库里店叫别的名，
   同一家店在统计里变两家，且**看不出哪里错了**。改为全状态参与匹配，`status` 经 `ShopMatch.shopStatus`
   带出、由同步层计 `onClosedShop` 并出一句提示（"退了店还有单没收尾"是该看见的信息）。
   同口径先例：`src/modules/ledger/labels.ts`「退店不在此列，它照样参与分摊」。

> **D-1 的现场线索（2026-11-01，真库副本只读导出）**：`sk_shops` 共 **16 家**，其中 **5 家已 `exited`**
> （八店、十二店、二店、三店、五店），活跃 **11 家**；`platform_shop_id`（`ShopXXXX Store`）只登记了 9 家。
> 订单侧出现过 10 个店名，含一个**没归一的** `Shop1105228632 Store`（1 单）—— 那是"平台 ID 写进了店名字段"的历史行。
>
> **⚠️ 曾在这里写错过一条（2026-11-01 用户纠正，已改代码）**：原文把「芒果还在给已退店推单」当成需要规避的风险，
> 于是 `shopIdentityIndex()` 加了 `WHERE status='active'`。**这是错的**：订单归属是**下单那一刻**的事实，
> 与店铺今天的经营状态无关 —— 八店 5 单 / 十二店 14 单共 19 单会被扔进未登记桶，订单上写芒果 `alias`（"八店"）而
> 库里那家店叫"八店-UK"，同一家店在统计里变两家，且因为店名是合法文本**看不出哪里错了**。
> 现改为：**全状态参与匹配**（同 `src/modules/ledger/labels.ts` 的既有口径「退店不在此列，它照样参与分摊」），
> `status` 只随 `ShopMatch.shopStatus` 带出来，由 `mango-sync` 计 `onClosedShop` 并出一条提示 ——
> "退了店还有单没收尾"是**该让人看见**的信息，不是该静默隐藏的信息。
>
> **判据更新**：真同步后 `shopUnmatched` 只应剩下 ②「芒果有、库里没有的店」；已退店的那 19 单必须正常归到原店，
> 同时 `onClosedShop > 0` 且提示文案出现。仍需扩展在芒果里真推一次才能验。

#### M1 补记（2026-11-02）：装好即 401 —— 扩展默认 Token 为空 + 提示指向不存在的页面

**现象**（用户首次真推，扩展 popup）：`连接 正常` / `抓到订单 3 / 3 单` / `完整度 完整` / **`推送 HTTP 401 失败`**，
提示写着「Token 不对或为空，去 SellerKit「采集端」页复制 Token 填进设置」。

**定位（一条 curl 就分开"宿主拒了默认值"与"扩展发的不是默认值"）**：

```bash
curl -s -o /tmp/x -w '%{http_code}\n' -X POST http://127.0.0.1:46211/mango/ingest \
  -H 'Content-Type: application/json' -H 'X-Ae-Token: sk-ae-dev-token' -d '{"schema":"bogus"}'
# → 400  {"ok":false,"error":"不支持的 schema：bogus（支持 mango-order/v1）"}
```

400（schema 错）说明 **Token 这一关是过的** —— 所以问题不在宿主，而在扩展发出的 `X-Ae-Token` 不是这个值。

**三条根因（缺一条都修不干净）**：

1. 扩展 `DEFAULTS.token = ''`，而宿主 `/mango/ingest` 要求 `X-Ae-Token`（默认 `sk-ae-dev-token`）⇒ **装上即 401**。
2. 401 的提示指向「SellerKit『采集端』页」—— **那个页面从来没建过**（宿主渲染层没有该入口），
   用户照做会发现无处可复制 ⇒ 一条**无法自救**的错误（本仓明令禁止的"提示不是入口"）。
3. 旧版默认值是 `''` 时用户点过一次「保存」就会把 `token: ''` 落进 `chrome.storage`
   ⇒ `{...DEFAULTS, ...stored}` 被这条空串覆盖。**只改默认值会被旧配置吃掉**。

**处置（`SellerKitExtensions` 1.1.1，本仓无代码改动）**：

- `DEFAULTS.token = 'sk-ae-dev-token'`，并在 `background.js` / `popup.js` 两处都写明"= 宿主
  `electron/ae-receiver.ts` 的默认 Token，**两处必须逐字一致**"；
- `normalizeCfg()`（popup 的 `loadCfg` 同口径）：**空 Token 一律回落默认值** —— 这个字段里的空串
  从来不是"我要清空"，是"没填过"；
- 401 提示改写成可执行的两句话：默认 `sk-ae-dev-token`，宿主用 `AE_RECEIVER_TOKEN` 改过就填改过的那个值。

**判据**：`SellerKitExtensions/tests/mango-push-token.test.mjs` 5 组（默认值真的发出去 / storage 空串回落 / 自定义值原样且去空白 /
401 hint 含默认值与 `AE_RECEIVER_TOKEN` 且**不含**「采集端页」/ 两处常量逐字一致）；变异
`DEFAULTS.token → ''` 立刻红（`默认 Token 必须等于宿主默认值 sk-ae-dev-token，实际 ""`）；
`npm run test:mango` 全绿（解析 9 组 / 抓取 7 组 / 补跑 12 组 / Token 5 组）。

**遗留（已知缺口，写清而不是含糊）**：宿主界面**不显示** Token（`getAeReceiverStatus()` 不含该字段，
`PoolPane` 的「复制接入信息」curl 里也硬编码了默认值）。默认值已让"装上即能用"成立；
只有用 `AE_RECEIVER_TOKEN` 改过的人需要知道那个值 —— 那时由改的人自己填进扩展设置。
若将来要在宿主里显示/复制，数据源就是 `getAeReceiverStatus()` 加一个 `token` 字段。

#### M1 补记 ②（2026-11-02）：推送「成功」但新 0 —— 扩展推的是规整帧，宿主只认原始键名

**现象**（用户第二次真推，Token 已修好）：`连接 正常` / `抓到订单 4 / 4 单` / `完整度 完整` /
**`推送 成功（新 0 / 更新 0）`** —— HTTP 是 200、扩展没报错，但订单表一行没多。

**取证（先解决"库到底写了什么"，否则只能靠猜）**：真库有 3.5MB 的 `-wal`，

```bash
cp ~/Library/Application\ Support/seller-kit/sellerkit.db /tmp/x.db   # ❌ 只拷主文件，漏 WAL
sqlite3 "file:$DB?mode=ro" ".backup /tmp/x.db"                        # ✅ 让 sqlite 自己合 WAL
```

`cp` 那次读到 `oi_orders` 只有 70 行、`sk_sync_log` **空**，于是差点误判成"同步根本没跑"。用 `.backup`
后读到最新一行：

```
fetched=4 total=4 inserted=0 updated=0 skipped=4  reason='4 单未入库（见 skips）'
detail_json: {"skips":[{"orderNo":"#1","reason":"缺少 orderId"}, … ×4]}
```

`skips` 里四条 `缺少 orderId` 就是全部答案：帧**到了**、业务层**跑了**、四单**各自被拒**。

**根因（一套键名对另一套键名）**：`toInternal` 当时只认芒果**原始响应**的键名
（`orderId` / `alias` / `authId` / `cnOrderStatus` / `orderItemList[].productId` / `payAmount` / `sendGoodExpiredDate`…），
而扩展推过来的是它自己 `mango-parse.js` → `toOrder` 的**规整帧**
（`orderNo` / `shopName` / `shopAuthId` / `platformStatusCn` / `lines[{itemId,qty,imgUrl}]` / `amountCents`（已是分）/
`orderTime|payTime|deadline|timeoutAt`（**已格式化成本地时间串**））。两套一个字段都对不上 ⇒
每帧都落进"没有单号"，而 HTTP 层只回 `ok:true`（帧合法、业务层逐单拒绝不算请求失败）——
于是**扩展侧看起来完全成功，宿主侧一单没进**，这是最坏的一种"绿灯"。

**处置（`electron/mango-ingest.ts` 认两套键名，不二选一）**：

- 单号 `orderId || orderNo`，店 `alias || shopName`，`authId || shopAuthId`，
  状态 `cnOrderStatus || platformStatusCn || orderStatus || platformStatus || status`；
- 金额：扩展的 `amountCents` **直接用**（不再 `mangoCents` 乘 100），币种非 CNY 仍记 `null`；
- 时间新增 `stampOrText(ms, text)`：先按毫秒/秒解析，再回落扩展**已格式化**的
  `YYYY-MM-DD HH:mm:ss`（`mangoTime('2026-11-01 12:00:00')` 是 `''`，只走前者会把四个时间列全变空）；
- 明细认 `orderItemList` 或 `lines`，行内 `productId||itemId`、`productImgUrl||imgUrl`、
  `productCount||qty`、`attrMap||attrs`（`lines` 已把 attrMap 摊成 `color/size`，故再回落 `it.color`/`it.size`）；
- `raw_fields`：`countryCode||countryCn`、`labelMap` 摊平为空时回落 `labels[]`、`weight(kg)` 缺时用 `weightGram/1000`。

**判据（两条，缺一条都可能再犯）**：

1. `tests/mangoIngest.spec.ts` 新增「扩展真正推的规整帧」4 例：夹具逐字照抄 `toOrder()` 的输出，
   钉住 `amountCents` 必须是 12748（**不是 1274800**）、四个时间串匹配 `^\d{4}-\d{2}-\d{2} …$`、
   行上的 `qty/color/size/imgUrl`、`目的地国家`/`订单标签`/`重量kg=0.700`；缺单号时 `reason` 要**同时**
   提 `orderId` 与 `orderNo`（提醒下一个改的人别又只改一半）。`npx vitest run tests/mangoIngest.spec.ts` → 23 例。
2. `scripts/mango-ingest-smoke.cjs` 新增 `[8]` 段 4 项：用 `vm` 加载**扩展自己的** `mango-parse.js`，
   取 `window.__skMangoParse.toOrder` 造帧（跨仓契约：任一侧改字段名就红），走完整链路到库，
   并真发一次 HTTP 断言 `inserted=1`。`npm run mango:smoke` → **25 项**全绿。

**顺手修的门禁缺陷（影响所有冒烟的"红"是否可信）**：该脚本收尾原是"失败分支 `process.exit(1)` +
末尾一行 `process.exit(0)`"，实测**两行都会跑到** ⇒ 变异后 4 项全红、退出码仍是 **0**。
改为单出口 `process.exit(failed > 0 ? 1 : 0)`；变异
`str(o.orderId)||str(o.orderNo)` → `str(o.orderId)` 后 `[8]` 四项红且 **EXIT=1**，还原后 EXIT=0。

**遗留**：本轮修复在运行中的 dev 进程里不会自动生效（`dist/electron` 已重编译，进程仍持旧模块）——
**需重启应用**才能验"新 4"。判据仍是 `sk_sync_log` 最新一行的 `skips`：若下次还是"新 0"，看 `reason`
里写的键名，那正是本次事故的指纹。

---

### M2 · 今日待办（1.5 天）

> **目标**：早上打开应用，3 秒内知道「今天要发几单、几件、哪几单快超时、哪些图案还没绑」。
> **注意**：这一步**不依赖抓单也能先做一半**（现有 70 单能算"未发货"），但只有抓单补了状态才准。

| 编号 | 任务 | 落点 | 判据 | 依赖 |
|---|---|---|---|---|
| **T2-1** | 芒果状态 → 内部 bucket 映射表（`正常/待发货/已发货/已完成/已取消/退款中/部分发货` → `pending/shipped/finished/cancelled`）。**唯一实现**，别在别处再写一套 LIKE | 新 `src/lib/mangoStatus.ts`（纯函数）+ 主进程同一份 | 单测：8 种原文全覆盖，未知值落 `unknown` 不落 `pending` | — |
| **T2-2** | 「发货台·总览」四数改口径：`待发货 N`（`bucket='pending'`）/ `有截止风险 M`（`deal_deadline` 距今 < 24h）/ `件数` / `缺图 K`。保留现有 `daily` 四数不动，**新增一行**而非替换 | `src/modules/today/tabs/OverviewPanel.vue` + `flowCtx.ts` 汇总 | `npm run today:ui` 全绿，新断言钉在 `data-act="stat-pending"` / `data-act="stat-risk"` | T2-1 |
| **T2-3** | 采集状态条：`上次同步 今天 09:12 · 抓 3 条 · 入库 3 · partial=false`；失败时红条 + 原因（`登录过期 / 扩展未装 / 抓 0 条但总数 12`） | 总览页顶部 | 断网演练时条变色且文案说明"可能是网络，不是没单" | T1-6 |
| **T2-4** | 待发货清单：按 `deal_deadline` 升序，列 = 订单号 / 店铺 / 图案 / 件数 / 剩余时间 / 图案状态（已绑/待绑/缺图） | 发货台新 tab 或总览下钻 | 抓 3 单时清单显示 3 行，最紧急的在最上 | T2-2 |
| **T2-5** | 冒烟断言：空态（0 单）与有数据两种形态都要钉；**空态不能说"今天没有订单"** 而要说"还没同步，点这里" | `scripts/today-ui-smoke.mjs` | 变异测试：把 `pending` 改回 `unshipped` 断言必须变红 | T2-2 |

> **T2-2 的字段口径（D-2 已定，别实现时改）**：`deal_deadline`（= 芒果 `sendGoodExpiredDate`）就是真倒计时，
> 「有截止风险」**只认这一列**。`timeout_at`（`qualifiedTime`）虽然也存着，但它与前者差 6 天 ——
> 实现时若"两个取更近的那个"，会把稳定的 6 天偏差纠成一堆假告警，而假告警三天就会让人不再看这个数。

**阶段门禁**：打开应用 → 首屏 3 秒内出现四个数字，且「待发货」数 == `SELECT COUNT(*) FROM oi_orders WHERE biz_status IN (待发货集合)`。

#### M2 施工记录（2026-11-01）

已完成 **T2-1 ~ T2-5**（M2 全部完成）。

| 任务 | 落点 | 验证 |
|---|---|---|
| T2-1 状态分桶 | `src/lib/mangoStatus.ts`（5 桶 + 唯一实现） | `tests/mangoStatus.spec.ts` 25 例；变异「认不出→pending」立刻红 |
| T2-2 第二行四数 | `src/lib/shippingPulse.ts`（纯函数）+ `flowCtx.ShippingSummary.pulse` + `TodayView.reload()` + `OverviewPanel` 新块 | `tests/shippingPulse.spec.ts` 12 例；`today:ui` 3 条新断言；两次变异确认会红 |
| T2-3 采集状态条 | `src/lib/syncBanner.ts`（纯函数）+ 新 IPC `mango-sync-status` + `OverviewPanel` 顶部 | `tests/syncBanner.spec.ts` 13 例；`today:ui` 3 条接线断言；变异「error 字段丢掉」立刻红 |
| T2-4 待发货清单 | `shippingQueue`（`src/lib/shippingPulse.ts`，与四数**同一份实现**）+ 新页签 `src/modules/today/tabs/QueuePanel.vue`（`flowCtx` 加 `pulseRows` 行源）+ 总览下钻按钮 | `tests/shippingQueue.spec.ts` 16 例；`today:ui` 5 条接线断言（含"没有截止期的垫底"与"清单单数 == 页签徽标"）；两次变异确认会红 |
| T2-5 空态骨化 | `isNeverSynced`（`src/lib/syncBanner.ts`）+ `src/modules/today/mangoOpen.ts`（`MANGO_PENDING_URL` + `openMangoPending`）+ 总览/清单两处空态各分两支 | `syncBanner.spec.ts` 追加 3 例；`today:ui` 5 条断言（含"出口打开的是待发货筛选页"）；两次变异确认会红 |

**与计划的三处偏离（都是实现时才发现的口径问题）**：

1. **T2-2 不是"给四数改口径"，而是**新开一块**。计划写的是"保留现有 `daily` 四数不动，新增一行"——
   做的时候确认了这两块**必须分开且不能合并**：`daily` 按**导入日**筛（服务导入/归类两步，看"今天导的这批"），
   而"今天要发几单"要按**当前状态**算（跨天：昨天没发完的今天还在）。合并会得到
   "待发货 0 但今天要发 12 单"这种自相矛盾的画面。所以容器里**多了一次取数**（不带 `importDate` 的全库读）。
2. **`shippingRows` 投影缺列，先补投影**。计划默认"四数在现有投影上算得出来"，实际 `deal_deadline` /
   `timeout_at` / `pay_time` / `image_id` **一个都没投影**，`UnifiedOrderRow` 也没声明。
   这四列正好是 2026-09-30"零读者就删"原则删掉的那批 —— 现在有真读者了，按同一条原则加回来。
3. **「算不出风险」要单独计数**（计划没提）。导入单没有 `deal_deadline` 这一列，若把空截止期当"不超时"，
   「快超时 0」会被读成"都不会超时" —— 而事实是"算不出来"。所以 `noDeadline` 单独计数并在界面说出来；
   写成坏格式的日期也归进这一项（否则一个写坏的日期会让风险数永远是 0 而没人知道为什么）。

**一个刻意的实现选择**：`parseLocalTime` **手写**而不用 `new Date(str)`。`yyyy-mm-dd hh:mm:ss` 这种
带空格的格式在 `Date` 构造器里行为是**实现相关**的（V8 当本地时间，别的引擎可能当 Invalid Date），
而这一屏显示"还剩几小时"，解析偏一小时就是错的告警。

**T2-3 的两处偏离 + 一个被查明的旧问题**：

1. **状态条也走容器汇总**（`summary.sync`）而不是面板自己取数 —— 守「面板不直接调 IPC」的纪律；
   但**必须新增 `error` 字段**：`success:false` 若折成 `last:null`，"读不到日志"会被显示成"还没同步过"，
   而这两件事要做的事完全不同（前者要重装/反馈，后者只要去芒果页面点一下）。
2. **文案/配色下沉成纯函数**（`syncBanner.ts`）而不是写在面板里：四种形态若都在 `today:ui` 里验，
   要连点五次刷新，把 `--virtual-time-budget` 撑爆。下沉后单测覆盖四种形态，UI 只验接线，两次刷新够。
3. **⚠️ 查明了一个一直存在的假绿**：`today:ui` 的输出在预算耗尽时会**截断在最后一条 PASS**，
   而 `SMOKE: ALL PASS` 不出现、`grep FAIL` 一条都没有 —— 看着就是"全绿"。
   此前记录的"308 PASS 全绿"其实就是截断，实际跑完是 **364+** 条。预算已提到 90s，
   且**判据改为"输出里有 `SMOKE:` 收尾行"**，不再是"没有 FAIL"。

**T2-4 的三处定性（都影响到后面 M3/M4，先写清楚）**：

1. **`shippingPulse` 改成"由清单汇总而来"，而不是并列两个函数**。计划把清单排在四数之后，
   照字面实现就是"四数一个函数、清单另一个函数"—— 一个按单去重、一个按行累加，
   界面上一句"待发货 3 单"、下面清单列 5 行，用户没法判断哪个是真的。
   现在 `shippingQueue()` 出行，`shippingPulse()` 只做汇总（单级 vs 行级的分流写在两处
   注释里），并有单测直接钉住"两组数逐项相等"。
2. **「图案状态」在 M2 只有两列可真读**：`image_id`（有没有图）与 `style_color_id`（归没归类）。
   所以三档是「缺图 / 待绑 / 已绑」，语义分别是"印不了 / 不知道印在哪个款色 / 可以进生产"。
   M3 的 `pod_variant_patterns` 上线后 `ready` 要**再收紧一层**（"这款色默认印哪个图案"也查得到），
   改动点只有 `patternStateOf` 一处 —— 别在界面里另写判定。
3. **"没有截止期的垫底"是一条独立规则**。导入单没有 `deal_deadline`，若按 0 参与排序会飘到最前
   （"1970 年就到期"），当"最不急"排到最后又会被读成"这几单不重要"。所以：垫底 + 单元格写「不知道」，
   并且**件数与风险里都要单独交代**（`noDeadline`）。单测与 UI 各钉一条。

**T2-5 的两条口径（空态）**：

1. **`0` 分三种，不是两种**：读不到日志 / 从没同步过 / 同步过但芒果那边是空的。
   计划写的是"空态不能说'今天没有订单'而要说'还没同步，点这里'"，实现时补了第三种：
   `error` 非空时**不许**说"还没同步过" —— 日志表坏了却让人去重新点一遍采集，
   是白做一遍还会把真正的问题藏起来。判据抽成 `isNeverSynced`，两处空态共用（同一个 0 不许在两屏上说两种话）。
2. **出口给的是"待发货筛选页"，不是芒果首页**：`status/正常/normal` 这个筛选段就是扩展抓取用的那一个。
   写歪了不会报错 —— 只会打开另一个列表，而用户看到的仍然是"芒果"。所以断言核的是 URL，
   不是"按钮点得动"。

**变异测试（确认守卫有效，不是"跑了就绿"）**：
- 去掉 `isWaitingShip` 筛选 → 3 条红
- 风险窗口 `<= 24h` 改成 `< 0`（只算已过期）→ 2 条红
- `today:ui` 把第二次取数也带上 `importDate` → 3 条红（正是"两块口径必须不同"那条）
- 状态条的 `error` 字段恒空 → 「读不到 ≠ 没同步过」立刻红（detail 里显示"还没同步过"）
- 清单排序里"无截止期"改成按 0 参与比较 → 单测「垫底」红 + UI「最急的在最上」红（顺序变成 I-OLD 打头）
- `patternStateOf` 忽略 `styleColorId` → 单测「有图未归类⇒待绑」红 + UI 状态列变成「已绑,缺图,缺图」
- `isWaitingShip` 改成全等匹配桶名（`=== 'unshipped'`）→ **8 条红**（四数、清单、徽标、下钻全挂）
- `isNeverSynced` 恒 `false`（两态合一）→ 3 条红（两处空态都退回"待发货是空的"，出口按钮消失）

**门禁**：`npm test` **1236 例 / 60 文件** · `today:ui` **377 项 PASS / 0 FAIL**（`SMOKE: ALL PASS`）· `verify` · `verify:docs` · `lint`（0 error）全绿。

---

### M3 · 图案槽位域（3 天）

> **目标**：把 560 个槽位一次性绑到图案上，之后每单自动知道"印哪个图案"。
> DDL 与判别链**已在真库副本跑通**（`POD_PATTERN_PIPELINE_PLAN.md` §2/§3），本阶段是照着施工 + 补两条抓包后的修正。

| 编号 | 任务 | 落点 | 判据 | 依赖 |
|---|---|---|---|---|
| **T3-1** | 迁移 **v14**：`pod_patterns` / `pod_variant_patterns` / `pod_sheet_batches` / `pod_sheet_ledger` / 视图 `pod_pattern_balance` / `pod_binding_worklist`；`pl_shop_items` 加 `pod_n_colors`、`pod_n_images`。**DDL 全文照抄附录 A**，ALTER 单独走 `cols()` 判断 | `order-db.ts` v14 | `npm run schema:smoke` 全绿；新库与旧库升级后 `pod%` 表齐全 | M1 |
| **T3-2** | `electron/podImageKey.ts`：`imageKeyOf(url)` 只认 `/kf/([0-9A-Za-z]+)\.(jpg\|jpeg\|png\|webp)`，**不归一化 hash 段本身** | 新文件（纯函数，零依赖） | 单测 6 例：四种域名 / 带尺寸后缀 / 非 `/kf/` 返回 `''` | T3-1 |
| **T3-3** | `variantKey` 加第 4 段 `imageKey?`（**只有非空才追加**，存量 3 段键逐字节不变）；`splitVariantKey` 的 `p.length !== 3` 改 `< 3 \|\| > 4` | `variantKey.ts:61-74` | 单测 5 例，含「不传 imageKey 与旧实现逐字节相同」这条防回归 | T3-2 |
| **T3-4** | `podLinkStats(skuJson)` 纯函数（返回 `{nColors, nImages}`），在 `upsertShopItems` 的 **INSERT 与 UPDATE 两处都调**（✅ 施工时摘成独立纯模块 `electron/podLinkStats.ts`，并在迁移 v3 内回填存量，见施工记录偏离 3/4） | 新 `podLinkStats.ts` + `shop-item-db.ts` | 同一款采集重跑两次，两列值不变（不是停在第一次的值） | T3-1 |
| **T3-5** | 视图 `pod_binding_worklist` 真库实跑，导出清单人工看一遍 | 附录 A | `SELECT COUNT(*)` = **560**，`SUM(image_key<>'')` = **50** | T3-1 |
| **T3-6** | 塌陷链接**定向重算**：只对 `pod_n_images > 1` 的链接重算 `variant_key`（加第 4 段），其余链接**一个字节都别动** | 一次性脚本 `scripts/pod-rekey-collapsed.cjs` | 重算前后：非塌陷链接的 `variant_key` 集合**完全相同**；塌陷链接行数 = 重算前 | T3-3、T3-5 |
| **T3-7** | 绑定台 UI（内建页，**不做 UI 岛** —— 内建页不受 `DB_OPS` 10 op 上限限制）：一屏 24 张 SKU 色图，键盘 `Space` 多选 / `1-9` 快选 / `Enter` 确认跳下一张 / `N` 新建 / `S` 跳过 | `src/modules/today/tabs/PodOrderPanel.vue`（2026-11-03 起：图案并进「发货台 › 订花纸」；原 `PatternPanel.vue` 已删） | 键盘流能连续绑 24 个槽位不出鼠标 | T3-5 |
| **T3-8** | 采集铺开：`ae-profit` 把剩余 14 家店扫一遍（**这是覆盖率分母的前提**）；扫完重跑 T3-4 统计 | 扩展侧操作 + 现有采集功能 | `SELECT COUNT(DISTINCT shop_id) FROM pl_shop_items` ≥ 14 | 用户配合 |

#### M3 施工记录（2026-11-01）

已完成 **T3-1**（表 + 两个视图 + `pl_shop_items` 两列）与 **T3-4**（判别力统计）。
T3-2 `imageKeyOf` / T3-3 `variantKey` 第 4 段此前随 M0 的 T0-6 已落地（`da2e4d8`），本阶段不必重做。

| 任务 | 落点 | 验证 |
|---|---|---|
| T3-1 迁移/建表 | 新 `electron/pod-db.ts`（`POD_SCHEMA` + `ensurePodSchema` + `podSchemaReport`）；`shop-item-db.ts` 迁移 **v3** 补 `pod_n_colors` / `pod_n_images` | `schema:smoke` 新增 **[I] / [J] 两个场景共 8 条**：空库一条 ensure 建齐六件 / 幂等 / 老库无 pod 对象也能补回 / 幂等补列不吃 `duplicate column` |
| T3-4 判别力统计 | 新 `electron/podLinkStats.ts`（纯函数 `podLinkStats` + `isCollapsedLink`）；`upsertShopItems` 的 **INSERT 与 UPDATE 两处**都调；迁移 v3 内**回填存量** | 单测 `tests/podLinkStats.spec.ts` **16 例**；`shop-item:smoke` 新增 **5 条**写路径断言；`schema:smoke` [J] 新增 **2 条**回填断言 |

**四处偏离（都是施工时才发现的口径问题，比计划更严）**：

1. **没有 v14 版本步骤**。计划写"迁移 v14"，但本域全是**新对象**（四张表 + 两个视图），
   没有"老库形状需要追"的东西 —— `dbMigrate` 的幂等 `CREATE IF NOT EXISTS` 对老库就是补建、
   对新库就是一次建到当前形状，两条路等价。版本步骤留给**将来改形状**（加列 / 换唯一键）。
   冒烟里直接钉了这条：`migrationVersion('pod.main') === 0`。
2. **跨域视图只能由"确定输入已就位"的那一处建**。`pod_binding_worklist` 读 `pl_shop_items` / `sk_shops`，
   而 SQLite 在**准备任何语句**时都会解析 schema 里的视图 —— 视图引用了不存在的表时，
   报错会打在**别处**的 SQL 上（`error in view pod_binding_worklist: no such table: main.pl_shop_items`）。
   第一版把建表挂在订单主干 ensure 里，`schema:smoke` 场景 H 当场红；后来的形状是
   `ensurePodSchema()` **先建输入域**（`ensureShopSchema` → `ensureShopItemSchema`）**再建视图**，
   依赖方向是"消费者 → 提供方"，并在 `check-cross-domain-edges.mjs` 里登记了这两条边。
3. **`pod_n_images` 取"同一色名下不同图键个数的最大值"，不是"整条链接的图总数"**。
   后者会把「5 个色各挂 1 张图」算成 5 —— 那种链接**完全不需要**图键（色名已经分开了），
   而「1 个色挂 5 张图」才必须靠图键。两个数一样大、含义相反，而这两个数的**唯一用途**
   就是区分它们。相应地，`isCollapsedLink()` 的判据只有 `nImages > 1` 一条；计划里写的
   `pod_n_colors = 1 AND pod_n_images > 1` 是它的极端情形（真库 7 条塌陷链接恰好都是这种形状），
   拿 `n_colors = 1` 当前提会在"1 个色塌了、另 1 个色正常"的链接上漏判 —— 那种同样会错印。
4. **补列必须同时回填存量（最初写的"不回填"是错的）**。真库此刻已有 71 条链接，两列全 0 之后
   `WHERE pod_n_images > 1`（找塌陷链接的唯一入口）会筛出 **0 行** —— 那不是"没有塌陷链接"，
   而是"没人算过"，而且它和真结论长得一模一样，T3-5 / T3-6 会据此得出一个**静默的错事实**。
   当时不回填的理由是"回填就是把统计口径写两遍"；`podLinkStats` 摘成纯模块后这条理由不成立了
   —— 迁移与写路径调的是同一个函数。回填只挑「两列都还是 0」的行，已算过的一个字节不动。

**门禁**：`schema:smoke` 全绿（[I] 5 条 / [J] 5 条）· `npm test` **1252 例 / 61 文件** ·
`verify`（跨域边已登记）· `verify:docs` · `lint`（0 error）· `shop-item:smoke` **58 项** ·
`order:smoke` · `mango:smoke` 25 项全绿。

**变异测试（确认断言真的会咬人）**：

| 改坏什么 | 预期变红 | 实际 |
|---|---|---|
| UPDATE 分支改用本帧的 `skuJson` 而不是 `merged.skuJson` | 「列表轻帧不把两列打回 0」 | ✅ 只红那 1 条 |
| `nImages` 改成"整条链接的图总数" | 「三色各一图 → 1」等 5 例 | ✅ 单测 5 红 + 冒烟 2 红 |
| 回填的 WHERE 去掉「两列都是 0」两个条件 | 「重跑迁移不改已写过的值」 | ✅ 红，9 被改回 2 |

> ⚠️ 跑 electron 类冒烟要多加一句 `env -u ELECTRON_RUN_AS_NODE`：本机环境里继承了这个变量时，
> `require('electron')` 返回的是**可执行文件路径**而不是 API 对象，症状是七个"色图采纳"用例
> 齐刷刷报 `Cannot read properties of undefined (reading 'getPath')` —— 看着像代码坏了，其实是没起 Electron。
> 另外 `mango:smoke` 偶尔会 `sandbox initialization failed: Operation not permitted`，
> 加 `ELECTRON_DISABLE_SANDBOX=1` 即可（同上，是环境不是代码）。

**阶段门禁**：

```sql
SELECT (SELECT COUNT(*) FROM pod_binding_worklist) AS 总槽位,
       (SELECT COUNT(*) FROM pod_variant_patterns)  AS 已绑定,
       ROUND(100.0 * (SELECT COUNT(*) FROM pod_variant_patterns)
                   / (SELECT COUNT(*) FROM pod_binding_worklist), 1) AS 覆盖率;
-- 覆盖率 < 60% 不许进 M4
```

```sql
-- 塌陷链接必须 100%（这 50 个是错印高风险）
SELECT COUNT(*) FROM pod_binding_worklist WHERE image_key <> '';      -- 应为 50
SELECT COUNT(*) FROM pod_variant_patterns vp
  JOIN pod_binding_worklist w ON w.variant_key = vp.variant_key
 WHERE w.image_key <> '';                                             -- 也应为 50
```

#### M3 施工记录（续）：T3-5 ~ T3-8（2026-11-01）

| 任务 | 落点 | 验证 / 实测 |
|---|---|---|
| T3-5 真库实跑 | 新 `scripts/pod-worklist.cjs`（`npm run pod:worklist`），**只读副本** | `--expect 560,50` → **总槽位 560 / 已绑 0 / 待绑 560 / 塌陷 50 / 覆盖店铺 2 家（七店、九店）**，CSV 560 行 |
| T3-6 定向重算 | 新 `electron/podRekey.ts`（纯函数 `linkPrefixOf` / `collapsedLinkPrefixes` / `planCollapsedRekey`）+ `scripts/pod-rekey-collapsed.cjs` | 副本 dry-run 与 `--apply`：塌陷前缀 **10 条** / 订单行 **75 行**（其中塌陷 **0 行**）/ 待改 **0** / 已是 4 段 0 / 非塌陷 75 / 认不出图键 0 / 脏键 0 |
| T3-7 绑定台 | 原新独立模块目录（`meta` / 视图 / 三个面板 / `ctx`，2026-11-02 已归档到 `.workbuddy/archive/pod-module-2026-11-02`）；**撤并成一页**，2026-11-03 又并进「发货台 › 订花纸」`src/modules/today/tabs/PodOrderPanel.vue`（见下方「结构变更」），**内建页不做 UI 岛**（D-5） | 键盘流 `Space` 多选 / `1-9` 快选 / `Enter` 确认跳下一张 / `N` 新建 / `S` 跳过 / `←→` 换款（并页后 `↑↓` 换色）；覆盖率条把「≥ 60%」与「塌陷 100%」两个判据并成**一个结论**。⚠️ **2026-11-03 并页重写时这一层整层丢了**（新文件零 `keydown`/`tabindex`），同日已补回并加断言 —— 见下方「并页收口」 |
| T3-8 采集铺开 | **未完成（卡在用户侧）** | 真库 `pl_shop_items` 71 行 / **2 家店**；判据 `COUNT(DISTINCT shop_id) >= 14` **未达** |

三条实测结论（都是"不做就会静默错"的）：

1. **T3-5 的判据成立，可以直接当门禁断言**：`npm run pod:worklist -- --expect 560,50` 不一致即退出码 1。
   脚本先把库（连同 `-wal` / `-shm`）复制到临时目录、在副本上建视图 → **真库一个字节都不写**，
   所以这个数字可以反复复算。CSV 里键的 `\u0000` 写成字面量 `\0`（人看得懂），另给 `variant_key_hex`
   供机器消费。
2. **覆盖率此刻是 0%，计划 §7「M3 覆盖率 < 60% 不进 M4」这条前置在真库上不成立**。
   处置不是等 T3-8（那要用户配合把剩下 14 家店扫一遍），而是把「没绑完」变成**看得见**：
   报单页把未绑件数摆进汇总（`unboundPieces` / `unboundRows`），覆盖率条把「覆盖率 ≥ 60% 且塌陷 100%」
   并成一个结论（`src/lib/podBinding.ts` 的 `podCoverageOf`）。**口径显式化之后 M4 才有资格落地** ——
   否则"3 个图案要报单"这种画面看起来完全正常，实际漏掉九成订单（真库 75 个待发行只有 **4 行**能匹配到槽位）。
3. **T3-6 在真库上是幂等零副作用**：塌陷链接前缀确实有 10 条（`pod_n_images > 1`），
   但**订单行 0 行**挂在它们上面 —— 75 个订单行全部来自另外的 3 段键。所以 `--apply` 前后
   「非塌陷键集合完全相同（59 个键）」「塌陷行数不变（0）」「`oi_variant_keys` 59 行未动」。
   脚本保留，作为"采集铺开、订单真的落进塌陷链接"时的唯一入口；它**刻意不动 `oi_variant_keys`**
   （那张表是"键 → 款色"的命名台账，重算只解决"订单行能否匹配到 4 段槽位"，命名会在下次核对时按新键重建）。

**已知缺口（写在这里，别让下一个人以为有守卫）**：绑定台是本仓唯一**没有 UI 冒烟**的页面 ——
`tests/uxEntryNames.spec.ts` 里「绑定台 / 报单 / 余量看板」的豁免理由写的就是"锚点 = `PodView.vue` 的 TABS"；
键盘流本身只由 `tests/podBinding.spec.ts`（10 例）覆盖**统计口径**，没有任何一条断言钉住"按 `1-9` 真的绑上了"。
补 `pod:ui` 是 T3-7 的收尾项（同日未做）。

#### 并页收口（2026-11-03）：T3-7 的键盘流补回，T3-8 / T5-6 明确卡在用户侧

并进「发货台 › 订花纸」这一页时，**键盘流整层被丢掉了**：旧绑定台（`.workbuddy/archive/pod-module-2026-11-02/tabs/BindingPanel.vue:1214`）
有 `window.addEventListener('keydown', onKeydown)`，新写的 `PodOrderPanel.vue`（2136 行）全文没有
`keydown` / `tabindex` —— 而本表 T3-7 那一行还写着"键盘流 …"，**文档在说谎**。

- **补回的键位**：`Space` 选/取消当前色 · `↑↓` 款内换色（到头跨到相邻款）· `←→` 换款 ·
  `Enter` 认上 · `1-9` 快选建议图案并直接认上 · `N` 新建 · `M` 合并 · `S` 跳过本款 · `Esc` 关层/清选择。
  快捷键写在页面上（`data-act="kbd-hint"`）。
- **`KeepAlive` 是这一层的真陷阱**：本页在 `TodayView` 的 `<KeepAlive>` 里，切走不卸载 ⇒ 监听必须挂
  `onActivated` / 摘 `onDeactivated`，否则在「归类核对」按空格会把这里的颜色选上、按 `1` 直接写库认领。
- **断言**：`today:ui` 410 → **423**（+5 键盘 +8 写路径）。三次变异复核全部按要求变红
  （禁用 ↑↓ / 数字键恒取第一个 / 删掉合并弹层占位项）。**这就是 T3-7 现在唯一的守卫**，
  `pod:ui` 不再单建 —— 绑定台已经并进这一页，单建等于同一批断言写两遍。
- **T3-8（采集铺开）仍卡在用户侧**：真库 `pl_shop_items` 71 行 / **2 家店**，判据 `COUNT(DISTINCT shop_id) >= 14`
  未达；不扫店，M3 的覆盖率判据（≥60%）永远是 0%。
- **T5-6（四种演练）仍未实跑**：断网 / 登录过期 / 扩展未装 / Chrome 没开，需要真机操作，代码侧判据已由
  `tests/schedulerPlan.spec.ts` 24 例覆盖。

**门禁**：`pod:smoke` **24 项** · `tests/podRekey.spec.ts` 10 例 · `pod:worklist --expect 560,50` ✅ ·
`pod:rekey` dry-run / `--apply` ✅ · `verify` / `verify:docs` / `lint`（0 error）/ `vue-tsc` / `npm run build` ✅。

---

### M4 · 报单闭环（2 天）

| 编号 | 任务 | 落点 | 判据 | 依赖 |
|---|---|---|---|---|
| **T4-1** | 净需件 SQL（按图案聚合，**跨店铺**）+ 视图 `pod_order_need` | 附录 A | 3 单样例下，手算净需件与 SQL 一致 | M3 |
| **T4-2** | 报单页：按净需件倒序，一行 = 图案编码 / 待印件 / 余量 / 净需件 / 报单张数 `ceil(净需件/每张件数)` | `src/modules/today/tabs/PodOrderPanel.vue`（发货台 › 订花纸，2026-11-02 起） | 余量够的行净需件显示 0 且不进报单 | T4-1 |
| **T4-3** | zip 导出：`报单_YYYYMMDD.zip` = `清单.xlsx` + 非零图案的**图稿**（`artwork_image_id`，**不是**预览图） | 主进程 xlsx + zip | 解压后图片张数 == 清单行数；抽样比对图稿与预览图不同 | T4-2 |
| **T4-4** | 花纸批次入库 + 印花扣减：`pod_sheet_batches` 一行一批（`pieces_per_sheet` **记在批次行**）；印花完成才扣 `pod_sheet_ledger`（`reason='print'`，带 `ref_order_item_id`） | `electron/pod-db.ts` | 连续 3 天：`SUM(remaining_pieces)` 与手工盘点差 ≤ 2 件 | T4-1 |
| **T4-5** | 余量看板：`pod_pattern_balance` 直读，低于阈值（如 20 件）标黄 | `src/modules/today/tabs/PodOrderPanel.vue`（花纸库存收在同一页底部，2026-11-03 起） | 看板数字 == `SELECT SUM(remaining_pieces)` | T4-4 |

**三条不能错的**：
1. **余量按「件」算，不按「张」** —— 单位搞错，余量复用全废。
2. **`pieces_per_sheet` 记批次行，不记图案主表** —— 换排版就变，记主表会让历史批次被新值改写。
3. **报单时不扣余量，印花完成才扣** —— 报单只是意向，花纸没到就扣等于账上凭空少货。

#### M4 施工记录（2026-11-01）

| 任务 | 落点 | 验证 |
|---|---|---|
| T4-1 净需件 | **偏离**：新 `electron/pod-need.ts`（投影）+ `src/lib/podNeed.ts`（聚合）；**没有** `pod_order_need` 视图 | `tests/podNeed.spec.ts` **13 例**，含"3 单样例手算 == 聚合结果" |
| T4-2 报单页 | `src/modules/today/tabs/PodOrderPanel.vue`（原独立模块的 NeedPanel，已随模块归档）：净需件倒序（同量按编码，刷新不跳行），净需件 0 的行**不进表** | "每张花纸多少件"只影响张数，不影响净需件（界面直接写着这句） |
| T4-3 zip 导出 | 新 `electron/pod-report.ts` + `electron/zip-writer.ts`（零依赖 zip，5 例单测）+ 通道 `pod-report-export` | 新 `npm run pod:report:smoke` **14 项**（见下） |
| T4-4 批次 + 印花扣减 | `pod-db.ts`：`podBatchCreate`（**建批不加余量**）/ `podBatchArrive`（幂等）/ `podPrint`（FIFO，**不足整批拒绝**）/ `podAdjust`（±，带符号流水）；纯函数 `electron/podLedger.ts`（`allocatePrint`） | `pod:smoke` 24 项里 **9 项**在这条链上；`tests/podLedger.spec.ts` 10 例 |
| T4-5 余量看板 | `src/modules/today/tabs/PodOrderPanel.vue`（原独立模块的 BalancePanel，已随模块归档）直读 `pod-balance`（`pod_pattern_balance` + 已绑槽位数） | 阈值 20 件（`src/lib/podBinding.ts` 的 `POD_LOW_STOCK_PIECES`），等于 0（含负数）标红；`tests/podBinding.spec.ts` 10 例 |

**唯一偏离 · T4-1 没有落地 `pod_order_need` 视图**：

> 那个视图要求「待发货集合与 T2-1 同一份实现」，而那份实现是 `src/lib/mangoStatus.ts` 的**正则规则**。
> 在 SQL 里手写 `biz_status IN ('待发货', …)` 就是第二套口径 —— "发货台说 3 单待发、报单说 5 件要印"
> 正是这类分裂的经典症状（附录 A 底下那句警告说的就是这个）。改成两段、只留一份口径：
> ① 主进程 `electron/pod-need.ts` 只**投影**（订单行 + 绑定索引 + 图案余量原样搬，带 `truncated` 截断标记）；
> ② `src/lib/podNeed.ts` 做**聚合**，`isWaitingShip` 全仓只在这里被调用一次。
> 判据「3 单样例下手算净需件与 SQL 一致」等价落在单测里（手算结果写死，用例里没有 SQL）。

三条口径（与上面"三条不能错的"逐条对齐，另多一条）：

- **件数按行算，不按单算**；`qty` 为空按 1 件计并计入 `assumedRows`（静默当 0 会让净需件偏小，
  而偏小的报单意味着"料不够，等发现了再补"）。
- **余量按件扣、扣到 0 为止**（负余量归零，不进净需件）—— 否则明明够料的图案也会被再买一次花纸。
- **未绑定的待发件必须单独计数**（`unboundPieces` / `unboundRows`）。真库实测：75 个订单行只有
  **4 行**能匹配到槽位；只汇总"已绑定"会得到一张看似正常、实则漏掉九成订单的报单。
  导出时这句警告会**写进 xlsx 第 2 行**（不写，花纸商和老板都会当成"齐了"）。

**T4-3 的判据（计划写的是"解压后图片张数 == 清单行数；抽样比对图稿与预览图不同"）现在由冒烟钉住**：

`npm run pod:report:smoke`（新脚本）在临时库 + 仓库自带的**两张字节不同**的图上跑全链路：

| 断言 | 为什么值得单独一条 |
|---|---|
| `图稿/` 文件数 == 净需件 > 0 且有图稿的行数；`missingArtwork` 回给界面 | 数字对不上 = 花纸商缺图制版 |
| **打进 zip 的字节 == `artwork_image_id` 那张，且 ≠ `preview_image_id`** | 红线 7：传错一次整批报废，而导出**照样成功** |
| 缺图稿的行留在清单里、图稿列写「（缺）」、备注写"预览图不能制版" | 不拿预览图兜底（兜底就是错印） |
| 净需件 0 的行不进报单 | 否则"够料"的图案会被再买一次花纸 |
| 编码里的 `/` → `_`（`safeName`） | 否则 zip 解出来是多一层目录 / 解不出来 |
| 第 1/2/3 行 = 标题 / 警告 / 表头；合计行 = 各行和 | 打开第一眼就知道"哪天的、多少件一张、这份单偏少" |
| 净需件全 0 时**抛错** | 导出一份空单比不导出更糟：看起来做完了 |

**变异**（确认断言真的会咬人）：把图稿路径解析改成 `preview_image_id` ⇒ 冒烟当场红
（`ENOENT … open ''`，因为夹具里预览图有、图稿 0 的那一行拿不到文件）—— 与"错印"同一条链路。

**没验的（留待真实使用回填）**：T4-4 的运行期判据「连续 3 天 `SUM(remaining_pieces)` 与手工盘点差 ≤ 2 件」，
以及"印花完成后到货单与实物一致" —— 这需要真实花纸到货数据。代码侧能钉的都钉了
（建批不加余量 / 到货幂等 / FIFO 分批次 / 不足整批拒绝 / 盘点流水带符号 / 看板 == 视图求和）。

**门禁**：`pod:report:smoke` **14 项** · `pod:smoke` **24 项** · `npm test` **1324 例 / 67 文件** ·
`verify` · `verify:docs` · `lint`（0 error）· `vue-tsc` · `npm run build` 全绿。

#### 结构变更（2026-11-02）：图案并入基础数据，订花纸搬去发货台

用户口径：「把图案菜单放在基础数据-产品管理-颜色后面，界面参照颜色的界面设计，花纸库存直接显示在卡片下方，
订花纸放在发货台的归类核对后面，样式参照拿货界面的样式，可以直接复制出今天所需的花纸图片和数量」。

| 原（`src/modules/pod/` 的 `PodView.vue` 三页签） | 新家 | 说明 |
|---|---|---|
| 「认图案」页签 | `发货台 › 订花纸`（2026-11-03 起；`基础数据 › 产品管理 › 图案` 已撤）—— `src/modules/today/tabs/PodOrderPanel.vue` | 页签紧跟「归类核对」；按**款**分组、款内按颜色认图案（界面不复用 `ColorPanel.vue` 的三段式） |
| 「花纸库存」页签 | 同上（合并成**图案卡片下方**那一行） | < 20 件标黄、0 件标红；登记到货 / 记录用掉 / 到货记录都在这一页 —— 认图与补货是同一件事的两半 |
| 「订花纸」页签 | `发货台 › 订花纸` —— `src/modules/today/tabs/PodOrderPanel.vue` | 紧跟「归类核对」，**刻意不带步号**（队列 1 / 归类核对 2 / 拿货 3 / 结算对账 4）；样式照「拿货」；可一键把「今天要订的图案图 + 张数」复制成长图进剪贴板（`src/lib/podSheet.ts` 自绘 PNG + `writeClipboardImage`），另配纯文字清单与 zip 导出 |

- 独立模块 `src/modules/pod/` 已撤并：`modules.config.json` 三处摘掉 `"pod"`（registry 随之重生成），
  源码归档在 `.workbuddy/archive/pod-module-2026-11-02`（可恢复，未删除）。
- 新守卫：`npm run master-data:ui` 断言「图案」页签紧跟「颜色」、两张卡片渲染、库存语气分档；
  `npm run today:ui` 断言六页签齐全且 `classify → pod → purchase` 相邻。

---

### M5 · 开机自动化（1.5 天）

| 编号 | 任务 | 落点 | 判据 | 依赖 |
|---|---|---|---|---|
| **T5-1** | 系统托盘：显示/退出/立即同步三个菜单 | `main.ts` | 关窗口不退出进程；托盘图标可点 | — |
| **T5-2** | 开机自启 + **隐藏启动**：macOS `setLoginItemSettings({openAtLogin:true, openAsHidden:true})`；**Windows 的 `openAsHidden` 不生效**，必须加 `--hidden` 参数 + 判断后不 `show()` | `main.ts` | 重启电脑后进程在跑、主窗口**没弹出来** | T5-1 |
| **T5-3** | 调度器：启动后等网络就绪（最多 60s，重试 3 次）→ 今天同步过就跳过 → 否则调 T5-4。**一天一次，最多 3 次补跑** | 新 `electron/scheduler.ts` | 手动改 `sk_sync_log` 日期为昨天 → 重启触发；改成今天 → 不触发 | T1-6 |
| **T5-4** | 唤起 Chrome 打开待发货 URL：**复用现成的** `openUrlInPreferredBrowser()`（`browser-open.ts:108`），不新写 | `scheduler.ts` 调用 | Chrome 打开到 `…/status/正常/normal` | T5-3 |
| **T5-5** | 系统通知三种：成功（`同步 3 单`）/ 失败（带原因）/ **抓 0 条但总数 > 0**（这第三种最容易被漏，也最重要） | `scheduler.ts` | 断网演练出「失败」通知；把接口改坏演练出「0 条告警」 | T5-3 |
| **T5-6** | 演练清单实跑：①断网重启 ②登录过期（Chrome 退出芒果）③扩展未装 ④Chrome 没开 | 手工 | 四种都能看到**明确原因**，没有一种是"静默没数据" | T5-1~5 |

#### M5 施工记录（2026-11-01）

代码分两层：**判定层** `electron/schedulerPlan.ts`（纯函数，零 Electron 依赖）+ **编排层**
`electron/scheduler.ts`（弹浏览器 / 弹通知 / 写日志 / 挂计时器）。判据全部落在判定层，
这样 T5-3 / T5-5 的每一条都能被 vitest 钉住 —— 副作用在 CI 里跑不了，判据不能跟着一起跑不了。

| 任务 | 落点 | 验证 / 判据 |
|---|---|---|
| T5-1 托盘 | `electron/main.ts`：`createTray()`（18px，mac 模板图）、菜单「显示主窗口 / 立即同步 / 退出」、点托盘恢复窗口；`window-all-closed` **有托盘就不 quit**，`before-quit` 置 `isQuitting` | 托盘只能手工验（关窗 → 进程还在 → 托盘菜单点「显示主窗口」）；`scheduler:smoke` 覆盖它要写的日志表 |
| T5-2 自启 + 隐藏启动 | `configureLoginItem()`（仅打包版）：mac `{openAtLogin:true, openAsHidden:true}`、Win/Linux `args:['--hidden']`；`shouldStartHidden(process.argv)`；`createWindow(show = !START_HIDDEN)` | `tests/schedulerPlan.spec.ts` 6 例（只认精确 `--hidden`，近似串不认）；`SELLERKIT_DISABLE_AUTOSTART=1` 可关 |
| T5-3 调度器 | 新 `electron/scheduler.ts`（`startAutoSync` / `runAutoSync` / `onIngestDone`）+ 新表 `sk_auto_sync_log`（一次尝试一行：`day_key` / `at` / `source` / `action` / `reason` / `url`） | `scheduler:smoke` **12 项**；`tests/schedulerPlan.spec.ts` **24 例** |
| T5-4 唤起浏览器 | 复用 `openUrlInPreferredBrowser()`（`browser-open.ts`，**不新写**）；URL = `…/order/list/search/status/正常/normal`，与扩展 `ORDER_LIST_URL` 同源 | 单测钉常量（换一个筛选页也能"打开成功"，但抓回来的是另一个列表且不报错）；打开失败写 `open_failed` + 通知 |
| T5-5 三种通知 | `autoSyncNotice()`：成功（`同步 N 单（新增 x / 更新 y）` + 瑕疵注记）/ 失败（**原样**带 reason）/ 抓 0 条告警 | `tests/schedulerPlan.spec.ts` 三态 + 一条"zero 必须先于 failure"的顺序断言 |
| T5-6 演练 | **手工四场景**（见下表） | 四种都要看到**明确原因**，没有一种是"静默没数据" —— 该场景**未实跑**（需要真机断网 / 退登录） |

三条实现细节（都会出错、都不会报错）：

1. **`decideAutoSync` 先判"一天上限"、再判"今天已同步"**。顺序反过来，超过 3 次之后原因会变成
   "今天已同步"，而真相是"补跑用完了" —— 两个原因要不要做的事完全不同。`reason` 永不为空（通知原样显示）。
2. **只有 `source='startup' AND action='open'` 计入"今天补跑了几次"**。`already_done` / `give_up` /
   `no_push` / `offline` 都写日志（要能查），但**不占额度**；用户手点的「立即同步」（`source='manual'`）
   也不挤占自动额度。这四条都有冒烟断言。
3. **`day_key` 用本地时区**（与 `src/lib/localDay.ts` 刻意第二份实现 —— 两份都很小、互相 import 不值得）：
   `toISOString().slice(0, 10)` 在东八区会让"今天 08:00 同步过"算成昨天，"一天一次"变成一天两次。
   单测有一条直接用 `new Date('2026-11-01T16:30:00Z') → '2026-11-02'` 钉这个回归。

**通知只在"我们自己去开过浏览器"时发**：`runAutoSync` 打开浏览器后挂 5 分钟 `pending` 计时器（`unref()`，
不阻塞退出）；`ae-receiver` 收到回推时调 `onIngestDone(result)` → 清计时器 + 按 `autoSyncNotice` 发通知 +
写 `done` 日志。用户手点采集（没有 `pending`）**不弹通知**（自己点的还弹一次等于打扰）；5 分钟没回推
写 `no_push` 并通知"扩展可能没装 / 没登录" —— 这是"静默没数据"的唯一兜底。

**顺带的两处工程登记**（漏了就静默消失）：`sk_auto_sync_log` 进 `scripts/db-inventory.cjs` 的域文件清单
（漏登记 → 整张表在清单里不出现）；用途文案进 `scripts/refresh-table-comments.cjs`。
托盘图标进 `electron-builder.yml` 的 `extraResources`（漏了 → 打包版**没有托盘**，开发版看不出问题）。

**T5-6 手工演练清单**：

| 场景 | 怎么做 | 期望看到 | 看到就说明哪里坏了 |
|---|---|---|---|
| ① 断网重启 | 关 Wi-Fi → 托盘退出 → `SELLERKIT_AUTO_SYNC=1 npm run dev` | 60s 内**不**弹浏览器；`sk_auto_sync_log` 一行 `offline`；通知「网络没就绪」 | 通知写「同步失败」= 判定顺序反了（会吓人） |
| ② 登录过期 | Chrome 退出芒果 → 手动「立即同步」→ 在芒果页点扩展采集 | 通知「同步失败」+ 原样 reason；日志 `done`；界面状态条红 | 通知说「今天没有待发货」= 红线 1 被吃掉 |
| ③ 扩展未装 | 停用扩展 → 手动同步 → 等 5 分钟 | 通知「浏览器开了但没回推」；日志 `no_push` | 什么都没有 = 又变成静默无数据 |
| ④ Chrome 没开 | 默认浏览器未能启动 → 重启 | 日志 `open_failed` + 通知带原因 | 「没反应」= 失败没有出口 |

> 演练前先看 `sk_auto_sync_log` 最新几行（`action` / `reason`）—— 通知只存在几秒，
> 日志才是事后能查的那一份（红线 10：没有日志的自动化等于没有自动化）。

**门禁**：`scheduler:smoke` **12 项** · `tests/schedulerPlan.spec.ts` **24 例** ·
`npm test` **1324 例 / 67 文件** · `verify` · `verify:docs` · `lint`（0 error）· `vue-tsc` · `npm run build` 全绿。

---

## 5. 待拍板（5 项，已定 1 项）

> 每项都给了**推荐**。不拍板就按推荐执行，但开工前必须在下面打勾。

| # | 问题 | 状态 | 结论 |
|---|---|---|---|
| **D-1** | 芒果 **14 店** vs `sk_shops` **16 店**，差哪两家？ | 🟡 部分已定 | **已定（2026-11-01 用户）**：店铺状态（退店/封店）**不影响订单归属** —— 退店只说明店铺现在不营业，不改变它退店前那些单归谁；匹配范围改为全状态，`status` 仅作提示（`onClosedShop`）。**剩下未定**：芒果有而 `sk_shops` 完全没有的那几家，需真同步一次后按 `shopUnmatched` 列出来人工登记 |
| **D-2** | `sendGoodExpiredDate`（11-11）vs `qualifiedTime`（11-05）**哪个是真倒计时**？ | ✅ **已定** | **`sendGoodExpiredDate`**（2026-11-01 用户确认）。两列照旧都存（`deal_deadline` / `timeout_at`），界面与「有截止风险」一律取 `deal_deadline`；`timeout_at` 保留仅供核对，不参与任何告警判定 |
| **D-3** | 采集**只抓「待发货」**（实测 3 单），还是也回补历史（5000 单）？ | 🟡 按推荐 | **只抓待发货**。历史订单的用途是"排序"，而排序可以先用 `pl_shop_items` 的采集顺序近似；**不建议回补**（接口翻页 50 页上限 + 风控风险，收益低） |
| **D-4** | 图案锚点用 `skuCode` 还是 `variant_key`？ | 🟡 按推荐 | **两列并列**：`variant_key` 做主键（存量 75 行键不变），新增 `sku_code` 列做**首选精确匹配**，命中不了回落 `variant_key`。见结论笔记 §4.1 |
| **D-5** | 图案域做**内建页**还是 **UI 岛**？ | 🟡 按推荐 | **内建页**（`PICKING_PLAN.md:107-111` 已裁定：内建页不受 `DB_OPS` 10 op 上限限制；绑定台要读写 5 张表） |

---

## 6. 门禁与红线

### 6.1 每阶段必跑

```bash
npm run verify          # IPC 契约 + 店铺 upsert 字段 + 跨域边
npm run test            # vitest
npm run schema:smoke    # 迁移幂等（老库 → 新库）
npm run mango:smoke     # M1 起
npm run today:ui        # M2 起
npm run order:smoke     # M0 起
npm run pod:smoke       # M3 起（图案域四表两视图 + 绑定/批次/流水）
npm run pod:report:smoke # M4 起（报单 zip 的图稿/清单对账，红线 7）
npm run scheduler:smoke # M5 起（sk_auto_sync_log 的补跑计数与日志形状）
npm run pod:worklist -- --expect 560,50   # M3 起（真库副本读一遍覆盖率分母）
```

### 6.2 红线（破了就停，不要"先上线再说"）

1. **抓 0 条 ≠ 今天没单。** 判据 `fetched == 0 && totalItems > 0` → 必须告警。
2. **不做自动登录。** 密码留在库里是给紫鸟那类场景的，不是给这里用的。见验证码就停。
3. **不做常驻轮询。** 一天一次，最多 3 次补跑。
4. **`world: "MAIN"` + `document_start` 都不能省。** isolated world hook 不到页面请求，这个坑会浪费整天。
5. **`splitVariantKey` 的 `!== 3` 不改，4 段键静默失效。** 改完必须补单测。
6. **塌陷链接禁止降级到色名。** 降级 = 把 5–12 个图案并成 1 个，静默错印。
7. **图稿 ≠ 商品主图。** 传错花纸商拿模特图制版，整批报废。
8. **ALTER TABLE 不能写进 `db.exec(SCHEMA)`。** SQLite 无 `ADD COLUMN IF NOT EXISTS`，重复执行直接让迁移失败 —— 而且失败发生在用户升级那一刻。
9. **`pod_n_colors / pod_n_images` 必须在 upsert 的 INSERT 与 UPDATE 两处都算**，否则采集重跑后永远是旧值。
10. **同步必须有日志。** 没有日志的自动化等于没有自动化。

### 6.3 提交纪律

开工前先把两个仓库的工作区清干净（C1）：SellerKit 30+ 文件、Extensions 12+ 文件按主题拆提交。
**别在 30 个未提交改动上再叠 20 个**，回退会变成不可能。

---

## 7. 排期

| 阶段 | 内容 | 工期 | 依赖 | 里程碑产出 |
|---|---|---|---|---|
| **M0** | 断点修复（T0-1~6） | 1.5 d | — | 采集路径字段齐 ✅ |
| **M1** | 入库通道（T1-1~8） | 2 d | M0 | 扩展能推，日志能查 ✅ |
| **M2** | 今日待办（T2-1~5） | 1.5 d | M1 | 早上打开知道做什么 ✅ |
| **M3** | 图案槽位（T3-1~8） | 3 d | M1 | 560 槽位可绑（覆盖率 ≥ 60% **待 T3-8**）· T3-1~7 ✅ |
| **M4** | 报单闭环（T4-1~5） | 2 d | M3 | 一键出花纸报单 ✅（T4-4 三天盘点实测待真实数据） |
| **M5** | 开机自动化（T5-1~6） | 1.5 d | M1、M2 | 重启电脑无人干预 ✅（T5-6 四场景待人工演练） |

> 施工进度（2026-11-01）：**M0 / M1 / M2 / M3（T3-1~T3-7）/ M4 / M5 已完成**。
> T3-2 / T3-3 随 M0 的 T0-6 落地；T3-5 真库实跑 **560 槽位 / 50 带图键 / 71 链接 / 2 家店**；
> T3-6 真库实测「塌陷前缀 10 条、订单行 0 行引用 ⇒ 重算幂等零副作用」；T3-8（扫剩余 14 家店）卡在用户侧。
> **门禁数字**：`npm test` **1328 例 / 67 文件** · `today:ui` 377 项 · `pod:smoke` 24 项 ·
> `pod:report:smoke` 14 项 · `scheduler:smoke` 12 项 · `mango:smoke` 25 项 · `shop-item:smoke` 58 项 ·
> `schema:smoke` 全绿（含图案域 [I] 5 条 / [J] 5 条）· `verify` / `verify:docs` / `lint`（0 error）/ `vue-tsc` / `build` 全绿。

**顺序不能换的三条**：

1. **M0 不过不进 M1** —— 同步进来的是死数据。
2. **M3 覆盖率 < 60% 不进 M4** —— 报单建立在绑定之上，绑定不全就去报单，等于按残缺数据买花纸。
   ⚠️ **2026-11-01 实际处置**：真库覆盖率此刻是 **0%**（只采了 2/16 家店），这条前置**按字面不成立**；
   M4 仍然落地，是因为把"没绑完"做成了**页面上看得见的数**（未绑件数进汇总、写进导出清单第 2 行、
   覆盖率条把「≥60% 且塌陷 100%」并成一个结论）。**没有这层显式化就不许进 M4**。
3. **M5 放最后** —— 自动化跑的是 M1/M2 的链路，链路没稳就自动化，等于每天自动失败一次。

**可以并行的**：M3 与 M2 无依赖关系，两人做可并行；M5 也可以提前做 T5-1/T5-2（托盘与自启与业务无关）。

---

## 附录 A · 图案域 DDL（照抄 `electron/pod-db.ts` 的 `POD_SCHEMA`，真库副本已跑通）

```sql
PRAGMA foreign_keys = ON;

-- 图案主数据。artwork（制版用图稿，纯图案无背景）与 preview（认图案用）必须分开存。
CREATE TABLE IF NOT EXISTS pod_patterns (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  code             TEXT NOT NULL,                 -- P001，业务唯一编码
  name             TEXT NOT NULL DEFAULT '',
  artwork_image_id INTEGER NOT NULL DEFAULT 0,
  preview_image_id INTEGER NOT NULL DEFAULT 0,
  status           TEXT NOT NULL DEFAULT 'active',
  note             TEXT NOT NULL DEFAULT '',
  created_at       TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at       TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE UNIQUE INDEX IF NOT EXISTS ux_pod_patterns_code ON pod_patterns(code);

-- 变体键 → 图案 绑定台账（一行 = 一个槽位）
CREATE TABLE IF NOT EXISTS pod_variant_patterns (
  variant_key TEXT PRIMARY KEY,
  pattern_id  INTEGER NOT NULL REFERENCES pod_patterns(id) ON DELETE RESTRICT,
  source      TEXT NOT NULL DEFAULT 'manual',     -- image / name / manual
  image_key   TEXT NOT NULL DEFAULT '',
  sku_code    TEXT NOT NULL DEFAULT '',           -- D-4：图案首选锚点，空 = 未采到
  state       TEXT NOT NULL DEFAULT 'bound',      -- bound / suspected_merge
  bound_at    TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pod_vp_pattern ON pod_variant_patterns(pattern_id);
CREATE INDEX IF NOT EXISTS idx_pod_vp_sku ON pod_variant_patterns(sku_code);

-- 每链接判别力统计（让"是否塌陷"成为可查字段，不靠人工维护清单）
-- ⚠️ 这两列走单独 ALTER，不能写进 CREATE TABLE
ALTER TABLE pl_shop_items ADD COLUMN pod_n_colors INTEGER NOT NULL DEFAULT 0;
ALTER TABLE pl_shop_items ADD COLUMN pod_n_images INTEGER NOT NULL DEFAULT 0;

-- 花纸批次（一次报单 = 一批）
CREATE TABLE IF NOT EXISTS pod_sheet_batches (
  id               INTEGER PRIMARY KEY AUTOINCREMENT,
  pattern_id       INTEGER NOT NULL REFERENCES pod_patterns(id) ON DELETE RESTRICT,
  sheets           INTEGER NOT NULL,
  pieces_per_sheet INTEGER NOT NULL,
  supplier         TEXT NOT NULL DEFAULT '',
  cost_cents       INTEGER NOT NULL DEFAULT 0,
  ordered_at       TEXT NOT NULL,
  arrived_at       TEXT NOT NULL DEFAULT '',
  note             TEXT NOT NULL DEFAULT ''
);
CREATE INDEX IF NOT EXISTS idx_pod_sb_pattern ON pod_sheet_batches(pattern_id);

-- 件的流水：到货 +，印花 -，盘点调整 ±。余量 = 求和，不存冗余列
CREATE TABLE IF NOT EXISTS pod_sheet_ledger (
  id                INTEGER PRIMARY KEY AUTOINCREMENT,
  batch_id          INTEGER NOT NULL REFERENCES pod_sheet_batches(id) ON DELETE CASCADE,
  delta_pieces      INTEGER NOT NULL,
  reason            TEXT NOT NULL,                -- arrive / print / adjust
  ref_order_item_id INTEGER NOT NULL DEFAULT 0,
  at                TEXT NOT NULL DEFAULT (datetime('now','localtime'))
);
CREATE INDEX IF NOT EXISTS idx_pod_sl_batch ON pod_sheet_ledger(batch_id);

CREATE VIEW IF NOT EXISTS pod_pattern_balance AS
SELECT p.id AS pattern_id, p.code,
       COALESCE(SUM(l.delta_pieces), 0) AS remaining_pieces
FROM pod_patterns p
LEFT JOIN pod_sheet_batches b ON b.pattern_id = p.id
LEFT JOIN pod_sheet_ledger  l ON l.batch_id  = b.id
GROUP BY p.id;

-- 待绑定清单（实测 560 行 / 其中塌陷 50 行 / 覆盖 71 链接）
-- ⚠️ 代码里这条视图是 **DROP + CREATE**（`ensureViewShape`），不是 `IF NOT EXISTS`：
--    形状变了就重建。`IF NOT EXISTS` 会在"已经建过旧形状"的库里静默保留旧列，
--    表现和"没跑迁移"一模一样（2026-11-01 一天内给它加过 image_url、换过店铺段）。
-- ⚠️ 建它之前 `pl_shop_items` 与 `sk_shops` 必须都在 —— SQLite 会解析 schema 里所有视图，
--    引用了不存在的表时报错会打在**别处**的 SQL 上（`error in view … no such table: main.pl_shop_items`）。
DROP VIEW IF EXISTS pod_binding_worklist;
CREATE VIEW pod_binding_worklist AS
WITH sku AS (
  SELECT i.item_id AS item_id, s.name AS shop,
         -- 键里的店铺段必须与订单行**逐字节相同**：订单侧是 toNameKey(oi_orders.shop)，
         -- 而 sk_shops.name_key 就是同一份归一（唯一索引也建在它上面）。
         -- 用展示名 s.name 的风险：店名多一个空格 / 零宽字符，560 个槽位与订单行一个都匹配不上。
         COALESCE(NULLIF(trim(s.name_key), ''), s.name) AS shop_key,
         j.value->>'color' AS color, j.value->>'imageUrl' AS img
  FROM pl_shop_items i JOIN sk_shops s ON s.id = i.shop_id, json_each(i.sku_json) j
  WHERE i.sku_json <> ''
), slot AS (
  SELECT item_id, shop, shop_key, color, img FROM sku GROUP BY item_id, shop, shop_key, color, img
), namecnt AS (
  -- 商品ID 只在店内唯一，跨店同 ID 不是同一个链接
  SELECT shop_key, item_id, color, COUNT(*) AS imgs FROM slot GROUP BY shop_key, item_id, color
)
SELECT
  s.shop_key || char(0) || s.item_id || char(0) || s.color
    || CASE WHEN n.imgs > 1
            THEN char(0) || substr(s.img, instr(s.img,'/kf/')+4,
                                   instr(substr(s.img,instr(s.img,'/kf/')+4),'.')-1)
            ELSE '' END AS variant_key,
  s.shop AS shop, s.item_id AS item_id, s.color AS color,
  CASE WHEN n.imgs > 1
       THEN substr(s.img, instr(s.img,'/kf/')+4, instr(substr(s.img,instr(s.img,'/kf/')+4),'.')-1)
       ELSE '' END AS image_key,
  n.imgs AS imgs_in_name,
  -- 该槽位自己的色图：塌陷链接里"同名色"的几张图长得不一样，绑定台必须看得到差异 ——
  -- 只给图键（一串 S3f2a…）等于让用户凭记忆挑图案，而那正是错印的来源。
  s.img AS image_url
FROM slot s JOIN namecnt n ON n.item_id = s.item_id AND n.color = s.color;
```

> **本节相对最早那版的三处修正（2026-11-01 施工时改的，均已同步到 `electron/pod-db.ts` 与
> `scripts/pod-pattern-schema.sql`，三处必须一致）**：
>
> 1. **`pod_binding_worklist` 的店铺段改用 `sk_shops.name_key`**（订单侧是 `toNameKey(oi_orders.shop)`）。
>    真库此刻 16 家店 `name ≡ name_key`，所以这是"防未来的静默错键"，不是修已知错。
> 2. **工作清单补 `image_url`**（塌陷槽位必须能看见自己的那张色图）。
> 3. **`pod_order_need` 视图没有落地**（唯一一处删减）：它要筛"待发货集合"，而那份口径的唯一实现是
>    `src/lib/mangoStatus.ts` 的正则规则；SQL 里手写 `biz_status IN ('待发货', …)` 就是第二套口径。
>    改成主进程投影（`electron/pod-need.ts`）+ 渲染层聚合（`src/lib/podNeed.ts`），
>    `isWaitingShip` 全仓只在那里被调用一次。详见 M4 施工记录的「唯一偏离」。
>
> 另：判别力两列（`pod_n_colors` / `pod_n_images`）正式路径是 `shop-item-db.ts` 的**迁移 v3**
> （补列 + 回填存量，回填口径 = `electron/podLinkStats.ts`），本附录里那两行 `ALTER` 只是"形状说明"，
> 不许直接对库执行（SQLite 没有 `ADD COLUMN IF NOT EXISTS`，重复执行会让用户升级那一刻失败）。

---

## 附录 B · 与既有文档的关系

| 文档 | 关系 |
|---|---|
| `MANGO_ORDER_EXTENSION_PLAN.md` | 扩展侧原理与失败模式，**本文 T1-8 引用其 §2、§5**；其 §4「多账号」实测作废 |
| `POD_PATTERN_PIPELINE_PLAN.md` | 图案域 DDL 与判别链，**本文附录 A 直接采用**；其「W0–W4 周计划」被本文 M3/M4 取代 |
| `ORDER_AUTO_SYNC_PLAN.md` | 现状实测与三断点，**本文 M0 的直接对象**；其 §3「Electron 内嵌窗口」路线已作废 |
| `DAILY_SHIPPING_FLOW_PLAN.md` | 每日发货六步的差距审查，**本文 M2 是其「晨报」那一格的具体落地** |
| `docs/notes/2026-11-01-mango-collect-and-pod-conclusions.md` | 结论层，本文不重复 |
