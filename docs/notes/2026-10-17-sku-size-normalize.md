# 采集 SKU 的尺码剥掉卖家写的修饰：是**提取**不是丢弃，存量必须回填

用户口径：「采集商品解析的 SKU 中尺码要剔除非正常尺码的字符串」。

## 结论

1. **剥修饰、不丢行**。脏尺码里含正当尺码（`XL 60-65kg` 就是 XL），丢掉整行 = 那 4 个商品的矩阵
   凭空少几十个组合（84 格的那款只剩 56 格），用户会当成"漏采"。
2. **只剥三类已知修饰**（体重区间 / 版型前缀 / 无数字的括号补注）。**不做"像不像尺码"的校验** ——
   正当尺码体系无穷（`70B` / `2T` / `28W` / `均码` / `One Size`），黑名单式校验迟早误伤；
   被误伤的码从矩阵里消失且**不报错**。
3. **括号里含数字就不剥**：`S (2-3 years)` 那个区间正是童装区分变体的东西，剥掉会把两个变体并成一格
   （矩阵一格式天然收敛 ⇒ 静默少一条 SKU）。
4. **两条入口刻意分叉**：采集落库剥修饰（`normalizeIngestSku`）；人在矩阵里手改**原样保留**
   （`normalizeEditedSku`）。"用户填的形态不能被吃掉"是本仓硬约束
   （同 [`shop_url` / `shop_url_raw`](2026-10-16-shop-url-raw-vs-key.md) 的教训）。消毒规则仍是同一份。
5. **存量必须回填**（`migrate('shop-item.main', v1)`）。只改代码不回填 = 用户看到的一模一样，
   得等下一次详情页采集才变（可能是几周后，且只覆盖被重采过的那几款）。回填**不动
   `scraped_at` / `updated_at` / `raw_json`**：这是口径修正，不是重采、也不是人改过。
6. **全角转半角只动字母数字**。全角括号在中日文里是正常排版，转了等于改用户看到的形态
   （`M（4-5岁）` → `M(4-5岁)`），而剥括号的正则两种括号都认。

## 取证（真库 2026-10-17）

```bash
cd ~/Library/Application\ Support/seller-kit
sqlite3 -readonly sellerkit.db \
  "SELECT j.value->>'size' sz, COUNT(*) c FROM pl_shop_items, json_each(pl_shop_items.sku_json) j
   GROUP BY sz ORDER BY c DESC;"
```

8 个商品 / 546 条 SKU，脏值只有三类（合计 **120 条**）：

| 形态 | 样本 | 条数 |
| --- | --- | --- |
| 体重区间后缀 | `XL 60-65kg` `S 35-40kg` `7XL 105-115kg` `4XL 80-85kg`（10 种 × 7 色） | 70 |
| 版型前缀 | `Asian size XXXL` `Asian size 4XL`（6 种 × 6 色） | 36 |
| 无数字的括号补注 | `XS（old）`（**全角括号**） | 14 |

关键事实：**剥完无一与本商品已有的纯码撞列**。

- `1005007171795928`（84 行 = 7 色 × 12 码）：`S 35-40kg` `M 40-50kg` `L 50-60kg` `XL 60-65kg` +
  `2XL 65-70kg`…`7XL 105-115kg`，只有纯 `XS` / `XXS` —— **12 列里 10 列带体重区间**。
  剥完仍是 12 列（`XXS | XS | S | M | L | XL | 2XL … 7XL`），只是列头干净了。
- `1005007171956401`（48 行 = 6 色 × 8 码）：6 个 `Asian size X` + 纯 `S` + `XS（old）` —— 无一撞车。
- `1005007172080347` / `1005007172113340`：只有 `XS（old）`，没有纯 `XS`。

⭐ 反过来算一遍"如果按剔除整行做会怎样"：`1005007171795928` 只剩 `XS`/`XXS` 两列 × 7 色 = **14 行**（原 84），
`1005007171956401` 只剩纯 `S` 一列 × 6 色 = **6 行**（原 48）。带修饰的码就是它**全部的码** ——
所以这里只能是"提取出码"，不是"丢掉不正常的行"。

`raw_json` 证明脏值来自**扩展直接给的显式 `size` 字段**（不是 `parseSkuProps` 解析出来的）：

```json
{"color":"printing 04","size":"XS（old）","imageUrl":"https://ae-pic-a1.aliexpress-media.com/kf/Sf95….jpg"}
```

订单侧的 `oi_orders.size` 是干净的（`L` `XXL` `XL` `XXXL` `S` `M` `5XL`，共 39 条），
所以本次改动**对订单侧没有可见影响** —— 但两处共用 `parseSkuProps`，口径仍然一致。

## 真库副本回填实测（最有说服力的那一份取证）

在 `sqlite3 sellerkit.db ".backup <副本>"` 出来的一致性快照上跑一次 `ensureShopItemSchema()`：

```
回填前脏尺码条数 = 120      回填后 = 0
回填前 1005007171795928  列数=12  [XXS | XS | S 35-40kg | M 40-50kg | … | 7XL 105-115kg]
回填后 1005007171795928  列数=12  [XXS | XS | S | M | L | XL | 2XL | 3XL | 4XL | 5XL | 6XL | 7XL]
回填后 1005007171956401  列数=8   [XS | S | M | L | XL | XXL | XXXL | 4XL]
回填后 1005007172113340  列数=9   [XS | S | M | L | XL | XXL | XXXL | 4XL | 5XL]
scraped_at / updated_at 逐行未变；1005007171795928 的 raw_json 里仍留着 kg（原文没被改）
sk_schema_migrations = [..., {"key":"shop-item.main","version":1}]
```

**列数一条不变**是"提取不丢组合"的直接证据；**时间戳与 raw_json 未动**是"这只是一次口径修正"的直接证据。

## 实现位置

| 文件 | 改了什么 |
| --- | --- |
| `electron/aeMoney.ts` | 新增纯函数 `normalizeSkuSize`（零依赖 ⇒ vitest 直接覆盖）。三条正则按注释编号 ①②③ |
| `electron/shop-item-db.ts` | `normalizeIngestSku` 改为走 `normalizeSkuRow(raw, normalizeSkuSize)`；新增 `normalizeEditedSku`（尺码原样）；新增 `migrate('shop-item.main', v1)` + `normalizeStoredSkuSizes` 回填 |
| `electron/shop-item-handlers.ts` | 只更注释（人工保存的消毒入口改叫 `normalizeEditedSku`） |
| `tests/aeMoney.spec.ts` | +8 例 |
| `scripts/shop-item-db-smoke.cjs` | +4 例（采集三步剥离 / 人工原样 / 回填校正且不动时间戳 / **版本已记就不再回填**） |

## 守卫

- 单测 8 例：三类修饰各一 / **括号含数字不剥** / 罕见正当码不动（8 个样本）/ 剥空保留原文 /
  大小写与全角统一 / **幂等**。每条都配"不该被动的纯码"做对照 —— 只断言"某条变成了 S"的实现
  若是"一律返回同一个值"仍会恒绿。
- DB 冒烟 4 例。回填那两条用**版本表**造"数据已在、版本未记"的形状（本域迁移是版本化的，
  比造老表结构更贴近真实升级路径）。
- **变异 5 条全红**，逐条还原、`shasum` 与备份一致后重跑全绿：

| 变异 | 红在哪 |
| --- | --- |
| 采集不剥修饰（`normalizeIngestSku` 传恒等函数） | 1 例（采集那条；人工那条仍绿 ⇒ 两条断言互相独立） |
| 人工保存也归一（`normalizeEditedSku` 传 `normalizeSkuSize`） | 1 例（人工原样那条） |
| 回填不归一 | 2 例（校正那条 + "只做一次"那条的**前提**断言） |
| 回填顺手改 `updated_at` | 1 例（时间戳那条；"只做一次"仍绿 ⇒ 两条判据独立） |
| 括号一律剥（去掉"含数字就不剥"） | 单测 1 例（年龄段那条；其余括号用例仍绿 ⇒ 断言精确） |

## 坑

1. **`npx vitest run` 全量要 130 秒**，Bash 默认 120 秒超时 ⇒ 中途 `SIGTERM`、输出为空、退出码 137。
   不是 OOM、不是残留进程。判据：单 spec 秒过。全量要走后台任务（`run_in_background`）。
2. **`ELECTRON_RUN_AS_NODE=1` 下 7 条色图用例集体假红**（`Cannot read properties of undefined (reading 'getPath')`）。
   本机 shell 里这个变量默认是 1 ⇒ DB 冒烟一律 `env -u ELECTRON_RUN_AS_NODE`（同上一轮的结论，仍踩）。
3. **`npx node scripts/xxx.mjs` 会报 `npm error enoent`** —— `npx` 把 `node` 当包名找。
   门禁脚本要么 `node scripts/xxx.mjs`，要么 `npm run <script>`。
4. 全角转半角**不能连括号一起转**：中文全角括号是正常排版，转了就是改用户看到的值。
   范围收窄到 `[\uFF10-\uFF19\uFF21-\uFF3A\uFF41-\uFF5A]`（字母数字）。
