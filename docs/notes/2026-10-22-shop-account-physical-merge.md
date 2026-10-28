# 店铺账号物理合并：一次重建换永久单表，代价与不可逆点

> 状态：**已落地（2026-10-22，P0–P3 全部完成，含真库克隆重放）**。下面的「裁定 / 不可逆点 / 四条纪律」仍然有效；
> 落地结果与本轮新学到的两条见文末「落地记录」。

**结论**：店铺与账号合并成一张 `sk_shops`（而不是两表 1:1 逻辑合并）。开发期数据量小，
重建两张表是一次性成本；逻辑合并留下的并集查询、双行身份、双状态存储是永久成本。
**凭据边界不靠物理分表，靠 API 层**：共享只读域 `shop` 永不返回 `secret_enc` / `secret_keys`，
明文只经 owner 域 `shop-accounts` 的 reveal。ADR-002 的 C1–C4 继续有效，仅「身份层必须物理独立」被取代。
裁定见 `docs/decisions/ADR-003-shop-account-physical-merge.md`，执行细节见
`docs/plans/SHOP_ACCOUNT_REDESIGN_PLAN.md`。

## 为什么这次选物理合并

1. 真库实测「一个账号挂多家店 = 0」「不同 ERP 登录 = 1（12 个账号共用）」「重复邮箱 = 0」
   「两份状态产生差异 = 0」—— 一店一账号是真实模型，多对多能力没有收益。
2. 两表可选 1:1 的复杂度不在迁移，而在之后每一次读写：列表要并集、行身份要分两种、
   状态与开店时间两处、新增字段要判断住哪张表。
3. 开发期允许人工整理数据，历史包袱可以用备注与手工维护承接；上线后再合表代价大得多。

## 不可逆点（改之前必须知道）

- **迁移会删表**：`sk_shop_sets` 被删除，`sk_shops` 与 `sk_mail_accounts` 被重建。
  SQLite 没有 SQL 级回滚，**唯一退路是迁移前的 `VACUUM INTO` 备份**。
- **店铺 id 1–9 必须原样保留**：`pl_shop_sku.shop_id`、`pl_shop_items.shop_id`、
  `sk_name_map.ref_id` 都引用它。迁移先按显式 id 插旧店，再让纯账号行拿新 id（10 起）。
- **邮件表必须重建，不能只改列名**：`ALTER TABLE ... RENAME COLUMN` 不会把外键目标从
  `sk_shop_sets(id)` 改到 `sk_shops(id)`。重建时保留邮件账号 id，消息 / 文件夹 / 附件的外键才不断。
- **迁移后不能留双读兼容**：旧列 `shop_set_id`、旧表 `sk_shop_sets` 必须彻底消失；
  「兼容新旧形状」的读取分支会让下一次改表继续背着两套假设。

## 合并后必须守住的四条

1. **共享只读域不返回密文**：`sk_shops` 现在有 `secret_enc` / `secret_keys`，
   `electron/shop-db.ts` 的查询必须用显式列清单（现有 `COLS`），**禁止 `SELECT *`**；
   `DB_OPS.shop` 不得新增 reveal 类 op。守卫在 `tests/pluginTriage.spec.ts`。
2. **面向店铺的列表要过滤纯账号行**：`listShops` / `shopList` 必须带 `trim(name) <> ''`，
   否则「只有账号、还没建店铺」的行会出现在拣货页、统计页的店铺下拉里
   （两处调用是 `src/modules/picking/PickingView.vue` 与 `src/modules/order-cost/OrderCostView.vue`，
   都调 `ipc.shopList({ status: 'active' })`）。
3. **店铺侧写入改局部更新**：`upsertShop` 原先是全量提交（没传就清空）。合并后店铺与账号同表，
   全量语义会把 `email / company_id / 工具引用 / 凭证` 一起清掉。必须改成
   `undefined = 不动、'' = 清空`，与账号合并接口一致。
4. **两种空态都要可用**：`name = ''`（只有账号）与 `email = ''`（只有店铺）都是合法行；
   数据库 `CHECK` 只拦「两者都空」。部分唯一索引让空值不参与店铺名 / 邮箱唯一性。

## 取证

- 真库只读：16 账号 / 9 店 / 3 企业 / 3 邮件；6 店有账号、10 账号无店、3 店无账号（2026-10-22）。
- 现有结构：`electron/shop-db.ts`（店铺身份与表级 `UNIQUE(platform, name_key)`）、
  `electron/shop-accounts-db.ts`（账号套装与加密字段）、
  `electron/mail-db.ts`（`shop_set_id ... REFERENCES sk_shop_sets(id) ON DELETE CASCADE`）、
  `electron/company-db.ts`（有 `contact_phone`，无支付宝）。
- 迁移不能用 `migrate(key, steps)` 直接包：`electron/db.ts` 的 `migrate()` 在外层开事务，
  而 `PRAGMA foreign_keys=OFF` 在事务内无效；本轮自管事务并手写 `sk_schema_migrations` 账本（`shop.main` v1）。

## 以后要改这块时先问

- **要加第二个平台？** 一店一账号的假设就破了，先重设基数，别只加一个平台下拉。
- **要按店铺覆盖工具密码？** 现有模型是「一条登录一份密码」，加覆盖字段属于新的裁定。
- **要让共享域读凭据相关字段？** 说明 API 边界失效，应拆回独立表或单开安全域。

## 落地记录（2026-10-22）

**结果**：`shop.main` v1 已在真库上跑过（应用启动即迁移，迁移前 `VACUUM` 备份在场）。
在**迁移前备份的副本**上重放一遍核对：19 行 = 6 双栖 + 3 纯店铺 + 10 纯账号、店铺 id 1–9 原样、
工具账号 1 条、邮件账号 3 条 + 851 封一条不丢、`foreign_key_check` 干净、`ensureShopSchema()` 连跑三次幂等。
企业从 3 家变 4 家 —— 是某个账号**自带企业名**被精确认出来，不是给它造了壳；
「没有企业信息的账号不造壳」这条裁定有痕迹可查：迁移把这类账号的企业名留在 `备注` 里（2 条）。

**本轮新学到的两条（都是"只在真老库上才暴露"的类别）**：

1. **「先迁移、再建表」的 house convention 在有跨表索引时是错的**。`ensureShopSchema()` 照惯例先跑迁移，
   而迁移收尾要建 `idx_sk_name_map_ref`（指向 `sk_name_map`）—— 老库第一次启动时这张表还不存在，
   直接 `no such table: main.sk_name_map`。**由 `shop-item` 冒烟抓到，不是由本域冒烟抓到的**：
   本域冒烟自己建库、自己 ensure，看不见"别的域先跑"这条启动路径。
   现改为本域**建表在前、索引在最后**，`CREATE TABLE IF NOT EXISTS` 对老表一个字都不改，所以不会把迁移抢走。
   →  generalize：**迁移收尾重建索引时，索引指向的表必须由更早的 ensure 建好**。
2. **`VACUUM INTO` 撞到已存在的目标文件是直接报错**，不覆盖、不提示。备份名若按固定时刻生成，
   "上一次尝试留下的备份"会让**第二次迁移永远起不来**（症状：改好了代码反复启动都失败在同一步）。
   现改为避让已存在文件。→ generalize：**任何"先写备份再动手"的路径，备份名必须能被避让/去重**。

**顺带记录一个被误读成 bug 的行为**：迁移后删掉某几家店铺行，`sk_mail_accounts` 的 `ON DELETE CASCADE`
会连带清除邮件账号与本地邮件缓存 —— 这是**设计内的**（账号本来就是这家店的），删除确认框用
`hasMailAccount` 专门追加一句（`src/modules/shop-accounts/components/AccountsPanel.vue`）。
排查时先用备份副本对照（副本里 851 封完好）即可断定"迁移没丢、是删除按设计丢的"。

**顺带记录一个"卡住不动"的真因（差点误记成并发问题）**：`mail:body:smoke` 长时间**零输出**、看着像被同机其他任务挤住，
实际是它把"第二层 CSP 的来源"**写死成 `ui-plugins/shop-accounts/index.html`** —— 那个岛 2026-10-14 已回收为内建模块，
文件不复存在。这次读取发生在 `app.whenReady()` **之前**，Electron 对 load 期异常只打印一行
`App threw an error during load` **并且不退出进程**，于是症状从"报错"变成"卡死"。
同一类死引用还有一处：它的夹具还在 `INSERT INTO sk_mail_accounts (shop_set_id, …)` —— 列改名后是 `no such column`。
修法：① 冒烟里所有"读仓库文件"的动作放进 `app.whenReady()` 的 `try` 内（失败走 catch → 打堆栈 + `app.exit(2)`，
永不表现为挂住）；② 第二层 CSP 改为**按事实扫描**（谁的源码引用 `sk-mail://` 就读谁的 `index.html`；
当前没有岛嵌正文 ⇒ 显式打印"不适用"并跳过，**不拿副本凑数**，将来有岛要嵌正文时这节自动开始跑真断言）。
→ generalize：**冒烟脚本里写死的文件路径 = 一颗定时炸弹，而且它的失效形态取决于抛错发生在生命周期的哪一段**。
每次回收/删除一个岛或改表列名后，除了跑门禁，还应 grep 一遍 `scripts/` 里对被删路径的引用。

**门禁记录（收工复跑，同一棵树）**：绿 = `tsc -p tsconfig.electron.json` · `lint`（0 error）· `verify` · `npm test`（860 用例）·
`build` · `schema:smoke` · `shop:smoke` 39 项 · `shop-item:smoke` · `product:sku:smoke` · `picking:smoke` · `style:smoke` ·
`order:smoke` · `ship-rate:smoke` · `product:smoke` · `ipc:shape:smoke` 55 项 · `mail:inline:smoke` · `mail:body:smoke` ·
`db:inventory`（40 对象 / 37 业务表）· `plugins:island:smoke` · `master-data:ui` · `today:ui` · `shipping-rate:ui`。
**红四条、同因**：`vue-tsc`（`onlyMissingCost`）· `verify:docs`（`CostPane.vue` 悬空）· `goods:ui`（2 条）·
`order-profit:ui`（`[cost-rates]` 超时）—— 全部落在**同机另一个工具正在写的「进价 / 成本维护」**那条线上，
与本域无关，也不替对方补（判据：这些断言里没有一条读店铺或账号数据）。**未跑**：`mail:smoke` 需 `MAIL_USER`/`MAIL_PASS` 凭据。
