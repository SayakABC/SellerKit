# 店铺账号合并与状态：34 条结论（蒸馏自 5 篇，2026-10-14 ~ 2026-10-25）

> **蒸馏笔记**：由 5 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/<原文件名>`

## 1. 岛回收为内建：真正的工作是换掉它的 7 个桥桩

**结论**：用户要求把店铺账号管家岛移到宿主内、挂在「店铺管理」菜单下，执行按计划 S1–S7 全部完成；落地时**丢弃 11 个桥接/入口桩**，因为岛的 alias 把宿主路径劫持到了自己的桩文件，源码本来就写的宿主路径。

**取证**：岛 `ui-plugins/shop-accounts`（vite + Vue3 + Pinia 工程岛，源码 ~11,037 行，1.5.2）→ 内建 `src/modules/shop-accounts/`。视图 + 2 个 Pinia store + 13 个组件迁入 `src/modules/shop-accounts/`；丢弃的桩为（`api.js`/`bridge.js`/`storage.js`/`toast.js`/`theme.js`/`types.js`/`main.js`/`settings.js`/`App.vue`/`style.css`/`ToastHost.vue`）——岛的 alias 把 `@/core/services/ipc|toast|storage|clipboard`、`@/types` 劫持到自己的桩文件，进宿主后 `@/` 解析到真身，只有 3 个文件真用了相对路径桥（`CompanyManageView`/`ShopRegistryView` → `ipc.ts`；`ShopAccountsView` 的 `openHostSettingsPanel` 是**导入后未使用的死代码**，一并删）。

二级导航：`ModuleMeta` 增可选 `parent`；新建 `src/core/nav.ts`（`NAV_GROUPS`，「店铺管理」）；AppShell 侧栏改渲染 `navTree`，分组可展开/收起（状态进 `app-shell` 命名空间），子项缩进 + active 联动。刻意**不做**"父模块 + 跨模块跳转"（那会产生一个没有自己内容的中转页）。

设置贡献换入口：`vite.config.ts` 的 `settingsPanelLoaders` 生成条件由 `roots[id] === 'extensions'` 放宽为「任一模块根下存在 `settings.ts`」；`src/modules/shop-accounts/settings.ts` 导出 `settingPanels`（安全设置 + 邮件设置），宿主设置中心分类照常出现。

岛下架：`git rm -r ui-plugins/shop-accounts`（目录内从未入库的文件先 `tar` 留档 `/tmp/sellerkit-retire/shop-accounts-island-2026-10-14.tgz`）；本机 `<userData>/plugins/shop-accounts` 副本备份后移废纸篓。**市场仓（独立 git 仓）的 zip 与 catalog 条目未动**——对外动作待用户确认（范围外，见计划 §0）。

**源**：`2026-10-14-shop-accounts-intake`（2026-10-14）

---

## 2. 数据与配置零迁移

**结论**：岛与内建共用同一套 `electron/*-db.ts` + `ipc.*` 通道；存储命名空间 `modules.shop-accounts` / `modules.shop-accounts-mail` 同键同形，旧用户视图偏好自动生效。迁移的真实工作量在**权限与生命周期面**（桥握手、CSP、Toast 队列、manifest 声明），不在数据。

**取证**：原文「数据与配置零迁移」条；计划 `docs/plans/SHOP_ACCOUNTS_INTAKE_PLAN.md`（含两条设计决策的完整论证）。

**源**：`2026-10-14-shop-accounts-intake`（2026-10-14）

---

## 3. id 反向释放是硬前提：先删岛目录再 build

**结论**：`scripts/lib/module-roots.cjs` 的 `isUndocked()` 只要岛目录在，就把同名 id 从 registry 硬拦掉。**先删岛目录再 build，顺序不能反**。

**取证**：`scripts/lib/module-roots.cjs` 的 `isUndocked()`。

**源**：`2026-10-14-shop-accounts-intake`（2026-10-14）

---

## 4. 安全面只赚不赔：宿主渲染页没有 meta CSP

**结论**：`sk-mail://` 正文 iframe 原需「宿主响应头 `UI_CSP` + 岛 meta CSP」两层交集；宿主渲染页没有 meta CSP ⇒ 风险直接消失一层。

**取证**：`tests/islandMailFrameCsp.spec.ts` 改钉宿主 `index.html` + 内建模块（守卫语义不变：凡嵌正文的文档，其 CSP 必须放行 `frame-src sk-mail:`）。

**源**：`2026-10-14-shop-accounts-intake`（2026-10-14）

---

## 5. 类型顺带补齐：回收后门禁第一次覆盖到两个字段

**结论**：`ShopAccountUpsertInput` 补 `companyId`（岛内凭 alias 绕过了宿主类型，编辑企业归属其实写不进去）、`shopList` 补 `shopSetId` 过滤参数——都是岛"想要但宿主类型面没有"的字段，回收后类型门禁第一次覆盖到它们。

**取证**：`ShopAccountUpsertInput` / `shopList` 的类型定义与上述两处补字段。

**源**：`2026-10-14-shop-accounts-intake`（2026-10-14）

---

## 6. 守卫：内建结构守卫 + 三处自证锚点改址

**结论**：新增 `tests/shopAccountsIntake.spec.ts` 钉内建结构；三个旧锚点同步改址。

**取证**：新增 `tests/shopAccountsIntake.spec.ts`：内建结构守卫（meta `parent: 'shop'` / 模块目录存在 / settings 贡献 / 桥桩不存在 / modules.config 登记）。**变异复核**：改坏 `parent`、改坏 store 导出名、mkdir 空岛目录逐条打红后还原。

改自证锚点：`tests/pluginManifest.spec.ts`（岛清单 −shop-accounts，改钉 excel-copy + shipping-rate；⚠️ 2026-10-15 shipping-rate 也回收为内建，该清单再次改为 excel-copy + ae-profit，见 `2026-10-15-shipping-rate-intake.md` §3）、`tests/islandMailFrameCsp.spec.ts`（见上）、`tests/uxEntryNames.spec.ts`（岛名锚点改钉剩余岛，模块内文案清一遍"岛/宿主桥"措辞）。

**源**：`2026-10-14-shop-accounts-intake`（2026-10-14）

---

## 7. 门禁结果与遗留

**结论**：2026-10-14 实跑全绿；遗留两件（市场仓下架待确认、岛内 4 个页签未拆分）。

**取证**：`tsc -p tsconfig.electron.json` ✅ · `vue-tsc --noEmit` ✅ · `verify` ✅ · `vitest run` **38 文件 695 例** ✅ · `build` ✅（registry 含 `shop-accounts`）· `verify:docs` ✅（本笔记登记后）。剩余岛冒烟见 CHANGELOG 同日条目。

遗留：市场仓下架（删 zip + catalog）待用户确认后另行执行；岛内 4 个页签（账号套装/企业/邮件/店铺登记）维持一体，未拆分；单文件 1000+ 行的技术债随迁入宿主（基线 §6 已有记录）。

**源**：`2026-10-14-shop-accounts-intake`（2026-10-14）

---

## 8. 裁定：一次重建换永久单表，而不是两表 1:1 逻辑合并

**结论**：店铺与账号合并成一张 `sk_shops`（而不是两表 1:1 逻辑合并）。开发期数据量小，重建两张表是一次性成本；逻辑合并留下的并集查询、双行身份、双状态存储是永久成本。

**取证**：真库实测「一个账号挂多家店 = 0」「不同 ERP 登录 = 1（12 个账号共用）」「重复邮箱 = 0」「两份状态产生差异 = 0」—— 一店一账号是真实模型，多对多能力没有收益。

原文三条理由：① 两表可选 1:1 的复杂度不在迁移，而在之后每一次读写：列表要并集、行身份要分两种、状态与开店时间两处、新增字段要判断住哪张表；② 开发期允许人工整理数据，历史包袱可以用备注与手工维护承接；上线后再合表代价大得多。

真库只读：16 账号 / 9 店 / 3 企业 / 3 邮件；6 店有账号、10 账号无店、3 店无账号（2026-10-22）。

裁定见 `docs/decisions/ADR-003-shop-account-physical-merge.md`，执行细节见 `docs/plans/SHOP_ACCOUNT_REDESIGN_PLAN.md`。状态：**已落地（2026-10-22，P0–P3 全部完成，含真库克隆重放）**。

**源**：`2026-10-22-shop-account-physical-merge`（2026-10-22）

---

## 9. 凭据边界不靠物理分表，靠 API 层

**结论**：共享只读域 `shop` 永不返回 `secret_enc` / `secret_keys`，明文只经 owner 域 `shop-accounts` 的 reveal。ADR-002 的 C1–C4 继续有效，仅「身份层必须物理独立」被取代。

**取证**：原文「凭据边界」段；ADR-002 的 C1–C4。

**源**：`2026-10-22-shop-account-physical-merge`（2026-10-22）

---

## 10. 不可逆点：迁移会删表，唯一退路是迁移前备份

**结论**：改之前必须知道四个不可逆点。

**取证**：

- **迁移会删表**：`sk_shop_sets` 被删除，`sk_shops` 与 `sk_mail_accounts` 被重建。SQLite 没有 SQL 级回滚，**唯一退路是迁移前的 `VACUUM INTO` 备份**。
- **店铺 id 1–9 必须原样保留**：`pl_shop_sku.shop_id`、`pl_shop_items.shop_id`、`sk_name_map.ref_id` 都引用它。迁移先按显式 id 插旧店，再让纯账号行拿新 id（10 起）。
- **邮件表必须重建，不能只改列名**：`ALTER TABLE ... RENAME COLUMN` 不会把外键目标从 `sk_shop_sets(id)` 改到 `sk_shops(id)`。重建时保留邮件账号 id，消息 / 文件夹 / 附件的外键才不断。
- **迁移后不能留双读兼容**：旧列 `shop_set_id`、旧表 `sk_shop_sets` 必须彻底消失；「兼容新旧形状」的读取分支会让下一次改表继续背着两套假设。

现有结构：`electron/shop-db.ts`（店铺身份与表级 `UNIQUE(platform, name_key)`）、`electron/shop-accounts-db.ts`（账号套装与加密字段）、`electron/mail-db.ts`（`shop_set_id ... REFERENCES sk_shop_sets(id) ON DELETE CASCADE`）、`electron/company-db.ts`（有 `contact_phone`，无支付宝）。

迁移不能用 `migrate(key, steps)` 直接包：`electron/db.ts` 的 `migrate()` 在外层开事务，而 `PRAGMA foreign_keys=OFF` 在事务内无效；本轮自管事务并手写 `sk_schema_migrations` 账本（`shop.main` v1）。

**源**：`2026-10-22-shop-account-physical-merge`（2026-10-22）

---

## 11. 合并后必须守住的四条

**结论**：合并后必须守住以下四条。

**取证**：

1. **共享只读域不返回密文**：`sk_shops` 现在有 `secret_enc` / `secret_keys`，`electron/shop-db.ts` 的查询必须用显式列清单（现有 `COLS`），**禁止 `SELECT *`**；`DB_OPS.shop` 不得新增 reveal 类 op。守卫在 `tests/pluginTriage.spec.ts`。
2. **面向店铺的列表要过滤纯账号行**：`listShops` / `shopList` 必须带 `trim(name) <> ''`，否则「只有账号、还没建店铺」的行会出现在拣货页、统计页的店铺下拉里（两处调用是 `src/modules/picking/PickingView.vue` 与 `src/modules/order-cost/OrderCostView.vue`，都调 `ipc.shopList({ status: 'active' })`）。
3. **店铺侧写入改局部更新**：`upsertShop` 原先是全量提交（没传就清空）。合并后店铺与账号同表，全量语义会把 `email / company_id / 工具引用 / 凭证` 一起清掉。必须改成 `undefined = 不动、'' = 清空`，与账号合并接口一致。
4. **两种空态都要可用**：`name = ''`（只有账号）与 `email = ''`（只有店铺）都是合法行；数据库 `CHECK` 只拦「两者都空」。部分唯一索引让空值不参与店铺名 / 邮箱唯一性。

**源**：`2026-10-22-shop-account-physical-merge`（2026-10-22）

---

## 12. 以后要改这块时先问的三个问题

**结论**：以后要改这块时先问以下三个问题。

**取证**：

- **要加第二个平台？** 一店一账号的假设就破了，先重设基数，别只加一个平台下拉。
- **要按店铺覆盖工具密码？** 现有模型是「一条登录一份密码」，加覆盖字段属于新的裁定。
- **要让共享域读凭据相关字段？** 说明 API 边界失效，应拆回独立表或单开安全域。

**源**：`2026-10-22-shop-account-physical-merge`（2026-10-22）

---

## 13. 落地结果：19 行核对与 851 封一条不丢

**结论**：`shop.main` v1 已在真库上跑过（应用启动即迁移，迁移前 `VACUUM` 备份在场），在迁移前备份的副本上重放核对全部对得上。

**取证**：在**迁移前备份的副本**上重放一遍核对：19 行 = 6 双栖 + 3 纯店铺 + 10 纯账号、店铺 id 1–9 原样、工具账号 1 条、邮件账号 3 条 + 851 封一条不丢、`foreign_key_check` 干净、`ensureShopSchema()` 连跑三次幂等。

企业从 3 家变 4 家 —— 是某个账号**自带企业名**被精确认出来，不是给它造了壳；「没有企业信息的账号不造壳」这条裁定有痕迹可查：迁移把这类账号的企业名留在 `备注` 里（2 条）。

**源**：`2026-10-22-shop-account-physical-merge`（2026-10-22）

---

## 14. 「先迁移、再建表」的 house convention 在有跨表索引时是错的

**结论**：迁移收尾重建索引时，索引指向的表必须由更早的 ensure 建好；现改为本域**建表在前、索引在最后**。

**取证**：`ensureShopSchema()` 照惯例先跑迁移，而迁移收尾要建 `idx_sk_name_map_ref`（指向 `sk_name_map`）—— 老库第一次启动时这张表还不存在，直接 `no such table: main.sk_name_map`。**由 `shop-item` 冒烟抓到，不是由本域冒烟抓到的**：本域冒烟自己建库、自己 ensure，看不见"别的域先跑"这条启动路径。现改为本域**建表在前、索引在最后**，`CREATE TABLE IF NOT EXISTS` 对老表一个字都不改，所以不会把迁移抢走。→ generalize：**迁移收尾重建索引时，索引指向的表必须由更早的 ensure 建好**。

**源**：`2026-10-22-shop-account-physical-merge`（2026-10-22）

---

## 15. `VACUUM INTO` 撞到已存在的目标文件是直接报错

**结论**：备份名若按固定时刻生成，"上一次尝试留下的备份"会让**第二次迁移永远起不来**；现改为避让已存在文件。

**取证**：`VACUUM INTO` 不覆盖、不提示。症状：改好了代码反复启动都失败在同一步。→ generalize：**任何"先写备份再动手"的路径，备份名必须能被避让/去重**。

**源**：`2026-10-22-shop-account-physical-merge`（2026-10-22）

---

## 16. 删店连带清邮件是设计内，不是迁移丢数据

**结论**：迁移后删掉某几家店铺行，`sk_mail_accounts` 的 `ON DELETE CASCADE` 会连带清除邮件账号与本地邮件缓存 —— 这是**设计内的**（账号本来就是这家店的）。

**取证**：删除确认框用 `hasMailAccount` 专门追加一句（`src/modules/shop-accounts/components/AccountsPanel.vue`）。排查时先用备份副本对照（副本里 851 封完好）即可断定"迁移没丢、是删除按设计丢的"。

**源**：`2026-10-22-shop-account-physical-merge`（2026-10-22）

---

## 17. 冒烟脚本里写死的文件路径是一颗定时炸弹

**结论**：失效形态取决于抛错发生在生命周期的哪一段；每次回收/删除一个岛或改表列名后，除了跑门禁，还应 grep 一遍 `scripts/` 里对被删路径的引用。

**取证**：`mail:body:smoke` 长时间**零输出**、看着像被同机其他任务挤住，实际是它把"第二层 CSP 的来源"**写死成 `ui-plugins/shop-accounts/index.html`** —— 那个岛 2026-10-14 已回收为内建模块，文件不复存在。这次读取发生在 `app.whenReady()` **之前**，Electron 对 load 期异常只打印一行 `App threw an error during load` **并且不退出进程**，于是症状从"报错"变成"卡死"。

同一类死引用还有一处：它的夹具还在 `INSERT INTO sk_mail_accounts (shop_set_id, …)` —— 列改名后是 `no such column`。

修法：① 冒烟里所有"读仓库文件"的动作放进 `app.whenReady()` 的 `try` 内（失败走 catch → 打堆栈 + `app.exit(2)`，永不表现为挂住）；② 第二层 CSP 改为**按事实扫描**（谁的源码引用 `sk-mail://` 就读谁的 `index.html`；当前没有岛嵌正文 ⇒ 显式打印"不适用"并跳过，**不拿副本凑数**，将来有岛要嵌正文时这节自动开始跑真断言）。→ generalize：**冒烟脚本里写死的文件路径 = 一颗定时炸弹，而且它的失效形态取决于抛错发生在生命周期的哪一段**。

**源**：`2026-10-22-shop-account-physical-merge`（2026-10-22）

---

## 18. 合并当轮的门禁记录：红四条同因，全在另一条线上

**结论**：收工复跑绿 20 项；红四条同因（同机另一工具正在写的「进价 / 成本维护」），不替对方补。

**取证**：绿 = `tsc -p tsconfig.electron.json` · `lint`（0 error）· `verify` · `npm test`（860 用例）· `build` · `schema:smoke` · `shop:smoke` 39 项 · `shop-item:smoke` · `product:sku:smoke` · `picking:smoke` · `style:smoke` · `order:smoke` · `ship-rate:smoke` · `product:smoke` · `ipc:shape:smoke` 55 项 · `mail:inline:smoke` · `mail:body:smoke` · `db:inventory`（40 对象 / 37 业务表）· `plugins:island:smoke` · `master-data:ui` · `today:ui` · `shipping-rate:ui`。

**红四条、同因**：`vue-tsc`（`onlyMissingCost`）· `verify:docs`（`CostPane.vue` 悬空）· `goods:ui`（2 条）· `order-profit:ui`（`[cost-rates]` 超时）—— 全部落在**同机另一个工具正在写的「进价 / 成本维护」**那条线上，与本域无关，也不替对方补（判据：这些断言里没有一条读店铺或账号数据）。**未跑**：`mail:smoke` 需 `MAIL_USER`/`MAIL_PASS` 凭据。

**源**：`2026-10-22-shop-account-physical-merge`（2026-10-22）

---

## 19. `sk_shops.score` 用独立迁移键 `shop.columns` v1

**结论**：**`sk_shops.score`（记分分值，REAL，0 = 未记录）用独立迁移键 `shop.columns` v1。** 不能追加进 `shop.main`：那一步在 version ≥ 1 时直接短路（`runShopMainMigration()` 开头就 return），之后加多少步骤都不会执行。

**取证**：本域的执行顺序固定为 `dbMigrate(SCHEMA)` → `shop.main` → `shop.columns` → `dbMigrate(INDEXES)` —— `shop.columns` 必须在 `shop.main` **之后**：老库若还没合并，`sk_shops` 会在合并时被重建，先补列会补在即将被替换掉的旧表上。重建用的也是同一个 `shopTableSql`（已含 score），但 `loadShopsSql` 不列该列 ⇒ 合并出来的老店铺行记分为 0，语义正确。

`electron/shop-db.ts:223`（建表含 `score REAL NOT NULL DEFAULT 0`）· `electron/shop-db.ts:311-323`（`SHOP_COLUMNS_KEY = 'shop.columns'`、`PRAGMA table_info` 幂等 + `ALTER TABLE`、`migrate` 一步 v1）· `electron/shop-db.ts:821`（重建用 `shopTableSql('sk_shops_new')`，已含 score）· `electron/shop-db.ts:822-827`（`loadShopsSql` 列清单不含 score ⇒ 默认 0）。

**源**：`2026-10-23-shop-score-and-status`（2026-10-23）

---

## 20. 状态四态只有一处来源

**结论**：**状态四态只有一处来源**：`SHOP_STATUSES`（启用 / 停用 / 封店 / 退店）。账号域 `SHOP_ACCOUNT_STATUSES` 直接引用它，不再维护第二份白名单；界面文案与语义色在渲染层 `STATUS_META`（`banned` = 封店 · danger、`exited` = 退店 · warning）。

**取证**：`electron/shop-db.ts:89`（`SHOP_STATUSES` 四项）· `electron/shop-db.ts:528-535`（`mergeStatus`：店铺侧非启用优先；账号侧 `banned`→封店、`closed`→退店、其余非启用→停用）· `electron/shop-accounts-db.ts:20,39`（直接复用 `normalizeShopScore` / `SHOP_STATUSES`）· `src/modules/shop-accounts/store.ts:81-92`（`STATUS_META` 四态与 tone）。

**源**：`2026-10-23-shop-score-and-status`（2026-10-23）

---

## 21. 局部更新时状态缺省必须沿用"归一后的现值"

**结论**：**局部更新时，状态缺省必须沿用"归一后的现值"，不能只判断 `archived`。** 旧写法 `archived ? 'archived' : 'active'` 会把封店 / 退店在"只改备注"时静默改回启用 —— 这是本次最容易复发的一处，冒烟专门钉住。记分同理：缺省保持原值，**显式 0 才清为未记录**。

**取证**：`electron/shop-db.ts:1427-1428`（`status === undefined ? normStatus(existing?.status) : …`；score 同理）· `electron/shop-accounts-db.ts:430-431`（账号写入面同口径）· `npm run shop:smoke` 新增 `scripts/shop-db-smoke.cjs:505`（四态写入 / 筛选 / 局部更新不复活）。

**源**：`2026-10-23-shop-score-and-status`（2026-10-23）

---

## 22. 记分非法值抛错，不静默归零

**结论**：**记分非法值抛错，不静默归零。** `normalizeShopScore` 接受 ≥ 0 的有限数并保留两位小数；负数 / `NaN` / `Infinity` 抛 `记分分值必须是 0 或正数`。静默归零的后果是"保存成功但分没记上"。

**取证**：`electron/shop-db.ts:1093-1097`（`normalizeShopScore`）；冒烟 `scripts/shop-db-smoke.cjs:538`（记分边界）。

**源**：`2026-10-23-shop-score-and-status`（2026-10-23）

---

## 23. 界面遵守「全零不占位」

**结论**：**界面遵守「全零不占位」**：记分只在 > 0 时渲染（列表状态徽标下的 `.cell-sub`、卡片字段），0 不显示。订单 / 拣货页按 `status: 'active'` 取店，封店 / 退店与停用一样自然退出候选，不需要另加过滤。

**取证**：`src/modules/shop-accounts/components/AccountEditor.vue:503,514-520`（四态按钮 `data-status`、`data-act="shop-score"`）· `src/modules/shop-accounts/components/AccountsPanel.vue:571-579,693-695`（仅 > 0 才渲染记分）· `scripts/master-data-ui-smoke.mjs:793-801`（0 不占位 vs 记分 12）、`:929-955`（编辑器四态 + 记分 20 + 封店保存回写）。

**源**：`2026-10-23-shop-score-and-status`（2026-10-23）

---

## 24. 迁移测试的构造纪律：老库形状必须显式建出来

**结论**：**迁移测试的构造纪律（本轮踩点）**：老库补列用例必须**显式建出旧形状**（当前 DDL 去掉 score）再调 `ensureShopSchema()`；若只是 `DROP TABLE` 后 ensure，`dbMigrate(SCHEMA)` 会直接建出**带 score 的新表**，`ALTER` 分支永远不执行、断言恒绿。`shop.main` 的用例同理要先清 `sk_schema_migrations` 的对应键。

**取证**：`scripts/shop-db-smoke.cjs:309`（老库补列）。

**源**：`2026-10-23-shop-score-and-status`（2026-10-23）

---

## 25. 门禁口径：`schema:smoke` 不含本域，老库场景以 `shop:smoke` 为准

**结论**：`schema:smoke` **不含本域**（`shop.main` 不走 `migrate()` 步骤表），老库场景以 `npm run shop:smoke` 为准。

**取证**：`npm run shop:smoke` 39 → **43 项**；本轮 `lint` 0 error / 523 warning、`verify`、`verify:docs`、`vue-tsc --noEmit`、`tsc -p tsconfig.electron.json`、`vitest` 45 文件 / 872 用例、`build`、`shop:smoke`（43）、`master-data:ui`、`schema:smoke` 均通过。

**源**：`2026-10-23-shop-score-and-status`（2026-10-23）

---

## 26. 「状态」不再单独占列，徽标与记分一起挂在店铺格

**结论**：**「状态」不再单独占列**：`sk_shops.status` 的徽标与 `score` 记分一起挂在**店铺格**里（店名下方）。顶部状态统计条不动 —— 它是筛选器，不是行内状态，两者不是同一件事。

**取证**：`src/modules/shop-accounts/components/AccountsPanel.vue:546`（表格店铺格）、`:639`（卡片同读法）。

**源**：`2026-10-25-shop-deposit-and-status-inline`（2026-10-25）

---

## 27. 保证金到账时间：口径与 `opened_at` 完全一致

**结论**：**保证金到账时间是店铺行的第 N 个日期字段**：`deposit_received_at TEXT NOT NULL DEFAULT ''`，口径与 `opened_at` 完全一致（`YYYY-MM-DD`、空串 = 未填写、非法日历日归一为空串）。

**取证**：`electron/shop-db.ts:225`（`shopTableSql` 建列）· `electron/shop-accounts-db.ts:442`（局部语义：`undefined` 保持、字符串覆盖）· `:222`（`LIST_COLS` 带出该列，列表与详情共用）· `:830`（`toItem`）· `src/modules/shop-accounts/components/AccountsPanel.vue:157`（`depositText`，未填时说「保证金到账时间未填」而不是「未到账」）。

冒烟：`scripts/shop-db-smoke.cjs` 新增往返用例（写入 / 列表带出 / 漏传保持 / 带时间截日期 / `2026-02-30` 归一空串 / 空串清空）；`scripts/master-data-ui-smoke.mjs` 的夹具让 **11 启用但库里存着日期**、**12 退店且有日期** —— 两个方向都钉住，只验"退店能显示"会让"所有行都显示"照样绿。

**源**：`2026-10-25-shop-deposit-and-status-inline`（2026-10-25）

---

## 28. 可见性由状态决定，数据不随状态清空

**结论**：**可见性由状态决定，数据不随状态清空**：列表只在 `status === 'exited'` 时渲染这一行；状态改回启用 / 封店后库里日期仍在，编辑器也只在「退店」时给输入位。理由：退店可以反悔（重新开店再退），把日期当"退店专属字段"清掉会让用户二次退回时重填。

**取证**：`AccountEditor.vue:519` 的 `data-act="shop-deposit"` 只在退店时渲染。

**源**：`2026-10-25-shop-deposit-and-status-inline`（2026-10-25）

---

## 29. 保证金列走 `shop.columns` v2，不走 `shop.main`

**结论**：**老库走 `shop.columns` v2，不走 `shop.main`**：`shop.main` 的版本一旦 ≥ 1 就整段短路，往里加步骤永远不会执行（v1 的教训见 `2026-10-23-shop-score-and-status.md` 同款）。

**取证**：`electron/shop-db.ts:321`（v2 步骤，`PRAGMA table_info` 幂等探测后 `ALTER TABLE`）、`:330`（`runShopColumnsMigration` 的步骤表，v1=score、v2=deposit）。顺序仍是 `dbMigrate(SCHEMA)` → `shop.main` → `shop.columns` → `dbMigrate(INDEXES)`。冒烟前置断言已从「账本记到 v1」改成 v2。

**源**：`2026-10-25-shop-deposit-and-status-inline`（2026-10-25）

---

## 30. preload 是白名单消毒：漏一个 `opt()` 就静默丢字段

**结论**：**preload 是白名单消毒**：`electron/preload.ts:153` 的 `opt('depositReceivedAt', 40)` 漏了，字段会在渲染层 → 主进程的路上被**静默丢掉**（不报错、不告警）。

**取证**：`electron/preload.ts:153` 的 `opt('depositReceivedAt', 40)`。

**源**：`2026-10-25-shop-deposit-and-status-inline`（2026-10-25）

---

## 31. 脆弱断言换成结构性选择器

**结论**：旧冒烟用 `chip.nextElementSibling` 找记分行 —— 它默认"状态徽标后面紧跟记分"，本轮把状态移进店铺格后立刻失效。现改为结构性选择器 `.cell-score`，以后在两者之间再插一行（比如保证金）不会把断言带崩。

**取证**：`AccountsPanel.vue:564`（`.cell-score`）。

**源**：`2026-10-25-shop-deposit-and-status-inline`（2026-10-25）

---

## 32. 全新库点「店铺商品」报 `no such table: sk_shops`：一条没有守卫的 LEFT JOIN

**结论**：`electron/shop-item-db.ts` 的两处读路径有**无守卫**的 `LEFT JOIN sk_shops`；`shop-items-list` / `shop-items-summary` 开头只调 `ensureShopItemSchema()`（建 `pl_shop_items`），**不建 `sk_shops`**。全新库首跑若第一站就是「店铺商品」段，店铺域从未被初始化 ⇒ JOIN 一个不存在的表 ⇒ 报错。

**取证**：

- `listShopItems`（`:427`）——「店铺商品」列表主查询；
- `getShopItemRow`（`:452`）——图片下载回填的单行读取。

`electron/shop-item-handlers.ts` 的 `shop-items-list` / `shop-items-summary` 开头只调 `ensureShopItemSchema()`（建 `pl_shop_items`），**不建 `sk_shops`**（那是店铺域 `ensureShopSchema` 的事，只在 `electron/shop-handlers.ts` 各 handler 里调用）。

仓内已有两条成熟先例，每一条都能挡住它：

| 先例 | 位置 | 形态 |
| --- | --- | --- |
| 读侧降级守卫 | `electron/shop-product-db.ts:67/92/199`、`electron/product-db.ts:970/995`（`shopLabelMap`/`productLabelMap`） | `if (!tableExists('sk_shops')) return 空表/0` —— "店铺名只是展示列，域未初始化时降级而非报错" |
| 页级显式引导 | `OrderCostView.vue:1100` / `PickingView.vue:914` | `await ipc.shopDbEnsure()` 再读（try/catch 包住，"店铺域不可用不影响本页主流程"） |

**为什么同一页另外两段没事**：队列段 `skuQueue` 的 SQL 不碰 `sk_shops`；映射段 `listSkuMappings`/`skuMapSummary` 走 `shopLabelMap()`（已守卫）。

**为什么"采集"看起来是好的**：`matchShopByStore`（`shop-item-db.ts:186/193/197`）只在**有证据时**才查 `sk_shops`（pin / 归一 URL / storeId 任一非空）；扩展帧 `store:{}` 时全空 ⇒ 跳过查询 ⇒ ingest 照常 200。于是症状是"**能采、不能看**"，更容易被当成显示 bug 查偏。

复现（隔离实例）：

```bash
env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . \
  --user-data-dir=/tmp/sk-fresh --no-sandbox --disable-gpu --remote-debugging-port=9224
# CDP 驱动：进「货与成本」→ 点「店铺商品」段 → 面板出现 no such table: sk_shops
# 反证：先 await window.electronAPI.shopDbEnsure() 再重拉 → 正常空态（读链本身没问题）
```

**源**：`2026-10-15-fresh-db-sk-shops-guard`（2026-10-15）

---

## 33. 修复走第三条路：落库层共用 `ensureSchema()`

**结论**：在 `shop-item-db.ts` 加一个**本文件所有入口共用的** `ensureSchema()` = `ensureShopItemSchema()` + **import 店铺域的 `ensureShopSchema()`**（表由 owner 建、DDL 只留一份，不自己抄建表语句），7 个入口（列表 / 汇总 / upsert / 手贴 / 单行读 / 设图 / adopt）统一走它。

**取证**：同款先例 `shop-product-db.ts` 顺带 ensure product/sku。

为什么不是上面两条：选项 1（页级 `shopDbEnsure()`）只保护「进这一页」这一条入口 —— `getShopItemRow` 的图片回填等非页面入口照炸；本域读链的完整性不该由调用方页面负责。选项 2（逐处 `tableExists` 守卫）要改 N 处 JOIN 并跟着调用方，面最大；本缺陷的正解是"把表建出来"，不是"每条查询自己兜底"。

守卫与取证：

- `npm run shop-item:smoke` 新增全新库段 3 例（DROP `sk_shops`/`sk_name_map` 后：列表回 0 且 `sqlite_master` 证明表被重建 · 有店铺证据的 ingest 照常落库 · 单行读照常返回）；`npm run ipc:shape:smoke` ⑩ 末段同款全新库腿（通道层不可造出 `no such table`）；
- **变异复核**：新用例先在**修前的 dist** 上跑 —— 3 例红且报的正是 `no such table: sk_shops`，重建后全绿。
- 跨域边登记更新：`check-cross-domain-edges.mjs` 的 `shop-item-db.ts → ./shop-db` 符号 +`ensureShopSchema`（verify 会逐条比符号）。
- 真机（隔离新库）：点「店铺商品」段 = 友好空态，`errorText` 为 null（改前是原始 SQLite 报错）。

关联：发现现场 `2026-10-15-ae-items-ingested-broadcast.md`（该文的隔离实例取证法可原样复用，全新库先 `shopDbEnsure()` 引导这一步即来自本缺陷）；`docs/notes/2026-10-30-shop-account-merge-and-status.md`（店铺域回收内建，`sk_shops` 读写归一到 goods 域 `shopApi`）；同轮另两条：`2026-10-15-shop-items-list-tristate.md`（列表空白的真因 = preload 三态压 0）、`2026-10-15-shop-item-partial-frame-merge.md`（采集帧只覆盖非空）。

**源**：`2026-10-15-fresh-db-sk-shops-guard`（2026-10-15）

---

## 34. 相邻发现：「错误横幅」是跨段共享的

**结论**：`useSkuPool` 的 `error` ref 是**一个**，渲染在 `PoolPane.vue:79` 的面板顶部（不分段）；而 `watch(sub)`（`useSkuPool.ts:419`）只处理 `'queue'` / `'items'` 两段 —— 切到「已建立映射」段不会触发任何重拉，因此 items 段的旧错误**原样挂着**，看起来像映射段也坏了。

**取证**：本次端到端第一轮差点据此误判"两段都失败"。修不修同样留待拍板；若修，最小口径 = 切段时清 `error.value`。

**源**：`2026-10-15-fresh-db-sk-shops-guard`（2026-10-15）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-14-shop-accounts-intake.md` | 2026-10-14 | §1–§7 |
| `2026-10-22-shop-account-physical-merge.md` | 2026-10-22 | §8–§18 |
| `2026-10-23-shop-score-and-status.md` | 2026-10-23 | §19–§25 |
| `2026-10-25-shop-deposit-and-status-inline.md` | 2026-10-25 | §26–§31 |
| `2026-10-15-fresh-db-sk-shops-guard.md` | 2026-10-15 | §32–§34 |
