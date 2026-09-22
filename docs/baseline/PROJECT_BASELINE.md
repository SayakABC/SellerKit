# SellerKit 项目基线快照（PROJECT BASELINE）

> **性质**：本文件是**当前状态的客观快照**（结构 / 规模 / 契约 / 依赖），不是规则文档。
> 编码规则与红线的唯一权威是 [`../../AGENTS.md`](../../AGENTS.md)；架构"为什么这么做"见 [`../architecture/PLUGIN_ARCHITECTURE.md`](../architecture/PLUGIN_ARCHITECTURE.md)。
> **刷新时机**：版本号变更、新增模块/插件、新增 IPC 通道域、依赖大版本升级后。
> 维护规则见 [`../README.md`](../README.md)。

---

## 0. 基线元信息

| 项 | 值 |
|---|---|
| 快照日期 | 2026-09-16 |
| `package.json` version | `1.0.4` |
| git commit | `2f6e9f9`（branch `master`） |
| 上游 remote | `sellerkit` → `https://github.com/SayakABC/SellerKit.git` |
| `electron-builder.yml` buildVersion | `1.0.0` ⚠️ 与 `package.json` 不一致（见审查报告 P1-6） |
| 工作区状态 | ⚠️ 有大量未提交改动（20 个修改文件 + 9 个新增文件），快照描述的是**工作区当前状态**而非 `2f6e9f9` |
| 快照方式 | 静态分析（文件统计 / grep / 配置读取），**未运行构建** |

---

## 1. 运行时与工具链基线

| 项 | 基线值 | 说明 |
|---|---|---|
| Node.js | 22.x | 开发机 22.22.x |
| TypeScript | 5.9.3（`package.json` 声明 `^5.4.2`） | 渲染层 `strict: true`；主进程 `strict: false` |
| Electron | 33.4.11 | ⚠️ 已 EOL，不再获 Chromium 安全补丁 |
| Vite | 5.4.21 | ⚠️ 已 EOL |
| Vue | 3.5.35 | Composition API + `<script setup>` |
| Pinia | 2.3.1 | setup 语法 store |
| Tailwind CSS | 3.4.19 | v4 为 CSS-first 大改，未升级 |
| 主进程模块格式 | **CommonJS**（`tsconfig.electron.json` → `module: CommonJS`） | 产出 `dist/electron/` |
| 渲染进程模块格式 | **ESM + Vite** | `@` 别名 → `src/` |
| `vue-tsc` | 2.2.12 | 必须用本地版本，勿 `npx` 拉最新（与 TS 不兼容） |

---

## 2. 目录职责基线

| 路径 | 职责 | 进程/构建归属 | 改动约束 |
|---|---|---|---|
| `electron/` | 主进程：窗口、文件 IO、网络（`net`）、SQLite、electron-store、IPC、插件目录防线 | 主进程 · CommonJS | 新增 .ts 须加 `export {}`；IPC 三处同步 |
| `src/` | 渲染进程：UI、状态、Excel 解析、模板引擎、业务逻辑 | 渲染进程 · ESM | 禁止 Node API；禁止直连 `window.electronAPI` |
| `src/core/` | 平台核心（外壳 / 服务 / 网络 / 插件内核 / AI / 布局） | 渲染进程 | 禁止业务逻辑 |
| `src/modules/<id>/` | 内建业务模块（当前仅 `quick-note`） | 构建期收录 | 须在 `modules.config.json` 登记 |
| `src/lib/` | 纯函数工具层（无副作用） | 共用 | 改动前搜全部调用方 |
| `extensions/<id>/` | **随宿主分发的视图插件包**（`kind: view`，含 `src/meta.ts`）；**当前无分发实例**——`excel-copy` / `order-insight` 均已下记，目录里只剩**留档源码**（不进构建） | 构建期随包编译 | 自包含，import 走 `@/` 或包内相对 |
| `ui-plugins/<id>/` | **市场分发 UI 岛**（`kind: ui`，iframe + `window.__sk` 桥） | 独立构建产物，不入主 bundle | 经 host 能力域访问数据 |
| `scripts/` | 构建 / 打包 / 脚手架 / 冒烟脚本 | Node | — |
| `scripts/templates/` | **插件脚手架**：`l2-plugin`（L2 后台插件模板）/ `l2-demo`（L2 演示插件，2026-09-22 由 `extensions/_template` / `extensions/sk-hello` 归位而来）；UI 岛模板在 `scripts/ui-plugin-template/` | Node | 移动须同步改 `scripts/plugin-create.js` 的 `TEMPLATE_BG` 与 `scripts/plugins-install-demo.js` 的 `SOURCE`（二者硬编码指向） |
| `docs/` | 项目文档 | — | 见 `docs/README.md` |
| `dist/` `release/` `market-out/` | 构建与发布产物 | 生成物 | 不入库 |

### ⚠️ 已知目录语义冲突

`extensions/` 当前承载**两类形态**，判定依据是"有无 `src/meta.ts`"：

1. **视图插件包**（`kind: view` + `src/meta.ts`）：**当前无实例** —— 历史上是 `shop-accounts`（2026-09-16 下记）、`order-insight`（2026-09-21 下记）、`excel-copy`（2026-09-22 下记），三者均只保留 `ui-plugins/<id>` 市场岛。路径与机制（`vite.config.ts` 的 `MODULE_ROOTS` 双根探测）仍有效，供将来新增视图插件包使用。
2. **外置插件脚手架/示例**（`manifest.entry = ./index.js`、无 `kind`、无 `src/`）：`_template` / `sk-hello` —— 由 `npm run plugins:create` 生成，产出物应安装到 `<userData>/plugins/`。
3. **下记后留档的源码**（有 `src/meta.ts` 但**不在任何预设里**）：`extensions/order-insight/`、`extensions/excel-copy/` —— 保留作算法与 UI 参考，**不进构建**（由 `tests/pluginTriage.spec.ts` 守住"预设 ∩ 岛 id = ∅"）。

第 2 类**已不在 `extensions/` 下**（迁出后 `extensions/` 只剩第 3 类留档源码 + `plugins:create` 的临时产物），目录语义冲突随之收敛。第 3 类是本项目"下记"动作的常规残留形态：**下记 ≠ 删除**，可逆。另有 `extensions/ae-profit/`（`kind: view`）是迁移到 `ui-plugins/ae-profit/` 后的**残留**，已移出构建预设。详见审查报告 P1-5。

---

## 3. 代码规模基线

统计口径：排除 `node_modules/` `dist/` `release/` `market-out/`；计入 `.ts .vue .js .mjs .cjs .css`。

| 目录 | 文件数 | 代码行数 |
|---|---:|---:|
| `src/` | 55 | 10,254 |
| `electron/` | 26 | 11,283 |
| `extensions/` | 56 | 16,465 |
| `ui-plugins/` | 41 | 5,908 |
| `scripts/` | 21 | 1,833 |
| **合计** | **199** | **45,743** |

> 2026-09-22（T4 脚手架归位）按**增量**修正：脚手架 4 文件 / 114 行由 `extensions/` 移入 `scripts/`
> （`extensions/` 60 → 56 文件、16,579 → 16,465 行；`scripts/` 17 → 21 文件、1,719 → 1,833 行），合计不变。
> ⚠️ 本表是**快照**，与实测已有较大偏差（按同口径实测：`extensions/` 32 文件 / 7,243 行、`src/` 64 文件 / 11,304 行），
> 差额主要来自 `shop-accounts` / `ae-profit` 等包迁出 `extensions/`。**全表重扫列为后续项**，本轮不做。
> 另：`extensions/ae-profit`（1,532 行）这一行的**目录早已不存在**（R1-5 迁出后删除），仅为历史快照残留。

### 各扩展包规模

| 包 | 行数 | 形态 |
|---|---:|---|
| `extensions/order-insight` | 5,422 | view（**已下记，留档**） |
| `extensions/excel-copy` | 1,840 | view（**已下记，留档**） |
| `extensions/ae-profit` | 1,532 | view（**迁移残留**） |
| `ui-plugins/excel-copy` | 2,167 | ui（**dist 即源码，无构建步骤**） |
| `ui-plugins/order-insight` | 2,272 | ui |
| `ui-plugins/ae-profit` | 1,685 | ui |
| `ui-plugins/shop-accounts` | 1,261 | ui |
| `ui-plugins/sk-ui-starter` | 141 | ui（**样例岛，非脚手架**） |
| `scripts/templates/l2-demo` | 65 | 脚手架·L2 示例（原 `extensions/sk-hello`，2026-09-22 归位） |
| `scripts/templates/l2-plugin` | 49 | 脚手架·L2 模板（原 `extensions/_template`） |

> 手写岛（`excel-copy` / `order-insight`）的行数口径 = `dist/*.js` 合计（`dist/` 即源码，无构建步骤）；
> 工程化岛（`shop-accounts` / `ae-profit`）的口径 = `src/`（`dist/` 是构建产物，排除）。

### 最大的 10 个文件

| 行数 | 文件 |
|---:|---|
| 1,426 | `extensions/order-insight/src/store.ts` |
| 1,322 | `electron/mail-db.ts` |
| 1,243 | `src/types.ts` |
| 1,222 | `electron/order-db.ts` |
| 971 | `electron/purchase-db.ts` |
| 875 | `src/core/plugin/pluginManager.ts` |
| 865 | `electron/mail-engine.ts` |
| 828 | `extensions/order-insight/src/stock-in/store.ts` |

**结构观察**：`src/`（平台核心）仅 1.0 万行，而 `electron/` + `extensions/` 合计 2.8 万行——**主进程 DB 层与扩展包 store 是当前体量与维护成本的主要来源**（`*-db.ts` 三个文件均超 900 行）。

---

## 4. 模块与插件注册表基线

`modules.config.json` 是模块启用清单的**单一事实源**，经 `vite.config.ts` 求值后生成 `src/registry.generated.ts`。

### 构建预设

| profile | 模块列表 |
|---|---|
| `minimal` | *（空）* —— 纯外壳：全部业务功能已下记为市场分发的 UI 岛 |
| `standard`（默认） | `quick-note` |
| `pro` | 同 `standard` |
| 兜底 `enabledModules` | `quick-note` |

优先级：`MODULE_IDS` env > `MODULE_PROFILE` env > 文件内 `profile` 字段 > `enabledModules`。

> 取值用 `??` 而非 `\|\|`（2026-09-22 修）：`\|\|` 会把「预设存在但为空数组」和「预设不存在」混为一谈，
> 于是 `minimal: []` 会静默回落到 `enabledModules` —— 一个"纯外壳"预设根本表达不出来，日志还会显示成它自己的名字。

### 当前实际收录（`registry.generated.ts`，standard profile）

| id | 源码根 | 形态 | version | 设置面板 |
|---|---|---|---|---|
| `quick-note` | `src/modules/quick-note` | 内建模块 | — | — |

> `excel-copy`（TV模版）已于 2026-09-22 **下记**（移出 `minimal` / `standard` / `pro` 三处），改为从市场安装的 UI 岛。
> `order-insight`（订单归类）已于 2026-09-21 **下记**（移出 `standard` / `pro`），同样是市场 UI 岛。
> 下记原因（AGENTS 红线 23）：内建记录会占用同名 id，`managerDiscover` 注册 UI 岛时见 `records.has(id)` 即静默跳过，
> 导致已装的岛永远没有入口。宿主侧业务库与 db 能力域（`electron/order-db.ts` / `purchase-db.ts` / `excel-copy` 域等）
> **全部保留不变**，岛照常经 `db` 域调用。源码 `extensions/<id>/` 暂留作算法与 UI 参考，
> 不再参与构建（由 `tests/pluginTriage.spec.ts` 守住）。
>
> ⚠️ 连带修复（2026-09-22）：`vite.config.ts` 生成 `settingsPanelLoaders` 时，空列表的占位注释
> `'  // (none)'` 与闭合 `};` 挤在同一行，等于**把 `}` 一起注释掉** —— 只要构建不含 extensions 视图包
> （下记 `excel-copy` 后必然如此）就直接编译失败。同为占位分支的 `pluginPackageInfos` 因另有换行而未踩到。

### UI 岛清单（`ui-plugins/`，独立分发，不进主 bundle）

| id | version | 能力域（manifest `capabilities`） | 设置面板 |
|---|---|---|---|
| `ae-profit` | 1.0.1 | `storage`(ae-profit) · `clipboard` · `db`(ae · purchase) | — |
| `excel-copy` | 1.0.0 | `storage`(excel-copy) · `clipboard` · `dialog` · `db`(excel-copy) —— **TV模版唯一实现**（2026-09-22 内建下记后）。原生 ESM 手写岛：`dist/` 即源码，**无构建步骤**、零 npm 依赖。2 个页签：复制工作台（筛选/搜索/拖拽导入/键盘/撤销）与设置（模板配置 · 字段规则 · 显示列）。**Excel 解析与规则求值都在宿主**（岛所在 iframe 的 CSP 为 `script-src 'self'`，无 `unsafe-eval`，`jsExpression` 规则根本无法在岛内求值；岛也不打包 xlsx）。与内建版共用 `modules.excel-copy` → 模板 / 字段规则 / 显示列 / 记录使用状态**自动继承**。设置页由宿主设置中心迁到**岛内第二个页签**（原 `extensions/excel-copy/src/settings.ts` 的 `excel` 分类随下记一起消失） | — |
| `order-insight` | 1.2.0 | `storage` · `clipboard` · `dialog` · `db`(order-insight · purchase) —— **订单归类唯一实现**（2026-09-21 内建下记后）。原生 ESM 手写岛：`dist/` 即源码，**无构建步骤**（改完直接发布）。1.1.0：修 `ready()` 握手时序（原写法把 boot Promise 当恒真值，从不等待）、新增命名空间级 `store`、补齐列映射与分组维度的**配置继承**（与内建版共用 `modules.order-insight` 同名键，老用户配置无缝继承、写回不丢其它字段）、设置页新增「列映射」面板。1.2.0：**与内建能力对齐收尾** —— 拿货单查看/编辑（`orderGet`/`orderUpdate`）、单价记忆回填（`priceHistory`）、缺口「取消忽略」（`ignoreRemove`）、对账新增店铺分摊视图（`shopAllocation`/`shopAllocationDetail`）与时间窗筛选、数据纠正新增款编码手工指派（`styleAssign`）；并修掉 4 处**静默失效**（见 §11.12） | — |
| `shop-accounts` | 1.4.3 | `storage` · `clipboard` · `db`(shop-accounts) · `secrets` · `mail` — **店铺账号管家唯一实现**（账号库 / 企业管理 / 收件箱）。1.2.0 起为 Vite+Vue3+Pinia 工程（`ui-plugins/shop-accounts/src` 由下记的内建版源码整体迁入），`dist/` 为构建产物；1.2.2 起企业管理三弹窗改为与 AccountEditor 同款右侧抽屉；1.3.x 修复复制提示（岛内 Toast）、关联企业下拉与 companyId 落库/回显；1.4.2 批量修改的关联企业由「文本+覆盖/追加」改为**选择企业下拉**（`patch.companyId: number`，0=解绑、-1=未选，写入时按 `sk_companies` 同步企业名）；1.4.3 修复握手与主题（boot 前不渲染主视图、`color-scheme` 正确跟随深浅主题、补齐 `--wb-shadow`） | ✅ `manifest.settings`（1.4.0 起，设置页迁入宿主设置中心；1.4.1 修复设置页布局坍缩，分类 `shop-accounts:settings`） |
| `sk-ui-starter` | 0.1.0 | `storage` | — （**样例岛**：与 `scripts/ui-plugin-template` 内容重复，供参照非脚手架；是否从市场下架待拍板，见 `docs/plans/PLUGIN_TRIAGE_PLAN.md` §7） |

---

## 5. IPC 契约基线

**这些数字不再靠人工维护**：`npm run verify`（R2-4）从源码动态提取三份清单求差，
下表为其输出快照（2026-09-16）。三者不相等即为契约漂移，校验会失败并指出缺哪一项。

| 指标 | 值 | 来源 |
|---|---|---|
| preload 暴露键 | **141 个** | `electron/preload.ts` 的 `ipcRenderer.invoke(...)` 字符串 |
| `src/types.ts` `ElectronAPI` 声明 | **141 个** | 与 preload **集合对称**（R1-3 已修复此前的缺 4 项） |
| 主进程注册通道 | **137 个** | 含裸 `ipcMain.handle/on` 与封装 `register()` / `handle<T>()`（封装名**跨文件**解析） |
| 主→渲染单向广播 | 2 处：`mail-sync-event`、`updater-event` | `webContents.send` ↔ `ipcRenderer.on` 双向对称校验 |
| 命名合规性 | 100% 匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`（kebab-case） | 人工核对 |

> 为什么 preload(141) 与主进程通道(137) 不相等：部分键共用同一通道（如 `read-file` 被
> `importExcelByPath` 与 `readFile` 共用），另有一批通道属"仅广播/仅包装"语义，属设计如此而非漂移。
> 主进程注册分布（verify 实时输出）：order 36 / mail 24 / purchase 24 / main 14 / ae 9 /
> shop-accounts 9 / company 8 / backup 4 / plugins 4 / market 2 / updater 2 / ipc-handlers 1。

### 通道域划分（按前缀）

| 域 | 前缀 | 注册文件 |
|---|---|---|
| 通用/文件/窗口 | `get-*` `set-*` `open-*` `check-*` `read-file` `write-file` `save-*` `win-control` `backup-*` `reset-store` | `electron/ipc-handlers.ts` |
| 网络 | `net-request` | `electron/ipc-handlers.ts` + `electron/http-client.ts` |
| 订单洞察 | `order-*` | `electron/order-handlers.ts` + `order-db.ts` |
| 拿货对账 | `purchase-*` | `electron/purchase-handlers.ts` + `purchase-db.ts` |
| 集中收件箱 | `mail-*` | `electron/mail-handlers.ts` + `mail-engine.ts` + `mail-db.ts` |
| 利润追踪 | `ae-*` | `electron/ae-handlers.ts` + `ae-engine.ts` + `ae-db.ts` |
| 店铺账号 | `shop-account-*` | `electron/shop-accounts-handlers.ts` + `shop-accounts-db.ts` |
| 企业管理 | `company-*` | `electron/company-handlers.ts` + `company-db.ts`（企业 + 欧代/土代/德国包装法） |
| 插件市场 | `plugins-market-*` | `electron/plugins-market-handlers.ts` |
| 插件目录防线 | `plugins-*` | `electron/plugins-handlers.ts` |
| 更新 | `updater-*` | `electron/updater.ts` |

> **完整通道清单的权威来源是校验脚本本身**：`scripts/check-ipc-contract.mjs`（`npm run verify`）
> 每次都从源码重新提取三份清单并求差，**不是一份会过期的静态清单**——这也是本基线不再逐条
> 罗列通道的原因（静态清单必然滞后于代码）。
> 需要人读的对照：直接跑 `npm run verify`，输出含三份集合的数量与主进程各域的注册分布。
> 维护约定（新增通道的同步顺序、豁免清单的用法、包装名跨文件解析的边界）见 `AGENTS.md` §6.2。

---

## 6. 持久化基线

### electron-store（`<userData>/config.json`）

按 `modules.<namespaceId>` 隔离，经 `src/core/services/storage.ts` 的 `useModuleStorage<T>(id)` 访问。

| 命名空间 | 内容 |
|---|---|
| `app-shell` | `lastActiveModuleId`、`collapsed` |
| `excel-copy` | 记录列表 / 模板配置 / 字段规则 / 显示列（`ui-plugins/excel-copy` 岛声明） |
| `order-insight` | 订单归类状态（`ui-plugins/order-insight` 岛声明） |
| `shop-accounts` | 店铺账号 UI 状态（`ui-plugins/shop-accounts` 岛声明） |
| `ae-profit` | 利润追踪 UI 状态（`ui-plugins/ae-profit` 岛声明） |
| `sk-ui-starter` | 样例岛自带命名空间（manifest `capabilities` 只写 `"storage"`、**未声明 `namespaces`** → 按 `security.ts` 规则默认仅放行插件自身命名空间） |
| `plugins` | 插件停用集 |

> 外置插件 / UI 岛能写哪些命名空间由 manifest 的 `capabilities[storage].namespaces` 决定：声明了就必须命中，
> 未声明则默认只放行插件自身命名空间（`src/core/plugin/security.ts`）。因此**新增一个用 storage 的岛 = 新增一个命名空间**，
> 本节清单应随岛的 manifest 同步刷新。内建侧落 electron-store 的是 `app-shell`（外壳状态 + 插件停用集）与 `quick-note`（便签列表）。
> 下记**不迁移**命名空间：内建与同名岛共用 `modules.<id>`，这正是"配置自动继承"的实现方式（见 §4）。
>
> ⚠️ `AGENTS.md` §1.4 仍只列 `app-shell` / `excel-copy` 两个命名空间（已滞后，本次快照已补全，详见审查报告 P2-3）。
> 旧扁平 key（`records` / `templateConfigs`）仅由主进程做一次性迁移探测，**禁止新增**。

### SQLite（分域 db 文件）

| 文件 | 表 |
|---|---|
| `electron/mail-db.ts` | `sk_mail_accounts` · `sk_mail_messages` · `sk_mail_bodies` · `sk_mail_attachments` · `sk_mail_folders` · `sk_mail_attachment_cache` · `sk_mail_meta` |
| `electron/order-db.ts` | `oi_orders` · `oi_images` · `oi_styles` · `oi_style_colors` · `oi_style_fingerprints` · `oi_queue` |
| `electron/purchase-db.ts` | `suppliers` · `purchase_orders` · `purchase_items` · `purchase_sources` · `payments` · `purchase_ignore` · `purchase_items_new` |
| `electron/ae-db.ts` | `ae_orders` · `ae_order_lines` · `ae_fees` · `ae_cost_map` · `ae_rates` |
| `electron/shop-accounts-db.ts` | `sk_shop_sets` |
| `electron/company-db.ts` | `sk_companies` · `sk_company_profiles`（企业管理：欧代 / 土代 / 德国包装法） |

> `ae_ops_costs` / `ae_sync_log` 在 `docs/features/PROFIT_TRACKER.md` §5 中列出但**尚未实现**（属 M2 范围）。
> `electron/db.ts` 无 `CREATE TABLE`，为 electron-store 单例与事务复用层。

### 其他存储

| 位置 | 内容 |
|---|---|
| `localStorage.sk_auth_token` | 会话 token（`src/core/network/token.ts`） |
| 系统安全存储（Keychain / DPAPI） | 店铺账号密码、IMAP 授权码 |

---

## 7. 构建与打包基线

### npm scripts

| 脚本 | 作用 |
|---|---|
| `dev` | `concurrently` 起 Vite(5173) + `tsc -p tsconfig.electron.json` + Electron |
| `build` | `vite build`（重新生成 registry）+ `tsc` 主进程 |
| `build:minimal` / `build:standard` / `build:pro` | 按 `MODULE_PROFILE` 构建 |
| `dist` / `dist:mac` / `dist:win` / `dist:all` | `electron-builder` 打包 |
| `dist:minimal` / `dist:standard` / `dist:pro` | 按预设打包 |
| `dist:select` / `build:select` | 交互式勾选模块（`scripts/select-build.js`，记忆于 `node_modules/.cache`） |
| `release` | `bash scripts/release.sh` |
| `plugins:create` / `plugins:create:ui` | 插件脚手架 |
| `plugins:demo:install` | 安装示例外置插件到 `<userData>/plugins/` |
| `plugins:sandbox:smoke` | 插件沙箱全链路冒烟 |
| `mail:smoke` | 邮件引擎冒烟 |
| `rebuild` / `postinstall` | `better-sqlite3` 原生模块重编译 |

> **无 `lint` / `test` / `format` 脚本。**

### 打包配置（`electron-builder.yml`）

| 项 | 值 |
|---|---|
| appId | `com.sellerkit.app` |
| productName | `SellerKit` |
| output | `release/` |
| extraResources | `默认模板.txt` → `默认模板.txt` |
| afterPack | `scripts/afterPack.js`（移除 ElectronAsarIntegrity 修复 macOS 闪退） |
| mac | dmg + zip，**arm64 + x64 双架构**，`asar: true`，`.node` 解包 |
| win | nsis（非 oneClick，可选目录）+ portable，x64 |
| publish | GitHub Releases（`SayakABC/SellerKit`） |

### 构建产物路径

| 产物 | 路径 |
|---|---|
| 渲染层 | `dist/renderer/` |
| 主进程 | `dist/electron/` |
| 模块注册表 | `src/registry.generated.ts`（**自动生成，勿手改**，且被 `.gitignore` 忽略） |
| 安装包 | `release/` |
| 市场包 | `market-out/` |

---

## 8. 环境变量基线

| 变量 | 取值 | 读取方 |
|---|---|---|
| `VITE_API_BASE_URL` | dev `http://localhost:8080` / prod `https://api.example.com` | `src/core/network/request.ts`、`src/env.d.ts` |
| `VITE_REQUEST_ENGINE` | `ipc`（默认）/ `xhr`（仅本地调试） | 同上 |
| `MODULE_PROFILE` | `minimal` / `standard` / `pro` | `vite.config.ts`（构建期 Node） |
| `MODULE_IDS` | 逗号分隔模块 id | `vite.config.ts`（优先级最高） |

> `.env` / `.env.*` 均已 gitignore，仅 `.env.example` 入库。**禁止改 `VITE_` 变量名**（需三处同步）。

---

## 9. 文档基线

全部文档已归入 `docs/`（2026-09-16 整理）。根目录仅保留 `README.md` + `AGENTS.md`。文档地图见 [`../README.md`](../README.md)。

| 分类 | 文档 | 状态 |
|---|---|---|
| 规则（根） | `AGENTS.md` | 唯一规则源 |
| 基线 | `PROJECT_BASELINE.md`（本文件） | 活跃 |
| 基线 | `REFACTOR_PLAN.md` | 已完成归档 |
| 架构 | `PLUGIN_ARCHITECTURE.md` / `PLUGIN_DEVELOPMENT.md` | 活跃 |
| 架构 | `PROJECT_OVERVIEW.md` | ✅ 已于 R4-1 删除（与基线重复且内容过期，职责由本文件承接） |
| 业务 | `MAIL_INBOX.md` / `PROFIT_TRACKER.md` | 活跃 |
| 用户 | `USER_GUIDE.md` | 活跃（覆盖面偏旧） |
| 需求 | `Requirements.md` | 历史档案 |
| 审查 | `CODE_REVIEW_REPORT.md` | 活跃 |
| 归档 | `archive/manual.md` | 已归档 |

---

## 10. 质量门禁现状（重要）

| 门禁 | 现状 |
|---|---|
| 类型检查（渲染层） | `npx vue-tsc --noEmit` ✅ 0 error（含 `.vue` 模板；`strict: true`） |
| 类型检查（主进程） | `npx tsc -p tsconfig.electron.json --noEmit` ✅ 0 error，⚠️ 该配置 `strict: false`（主进程的隐式 any 不会被拦） |
| Lint | `npx eslint .` ✅ **0 error** / 362 warning（绝大多数为 `no-explicit-any`，非阻断） |
| 单元测试 | `npx vitest run` ✅ 13 文件 / 197 用例（environment: node，无 jsdom）；其中 `tests/pluginTriage.spec.ts` 27 例守插件契约（正向"调用 ⊆ 声明" + 反向"声明了必须真调用"） |
| IPC 契约 | `npm run verify` ✅ 141 声明 / 137 通道，`✅ IPC 契约一致` |
| 文档链接 | `npm run verify:docs` ✅ `✅ 无悬空引用`（历史文档的"已删除/从未存在"陈述走脚本白名单） |
| UI 岛冒烟 | 手工无头 Chrome 冒烟（fake `__sk` 桥 + 本地 HTTP 托管产物）：`order-insight` 37 项断言（含 op 真实调用与参数校验）；`shop-accounts` 主视图 15 项 / 设置页 8 项。夹具见技能 `esm-spa-headless-smoke`（含 `file://` ESM 拦截、Vue 重渲染 detach、服务器与 Chrome 必须同一 shell 三个必踩坑） |
| CI | ❌ 无 `.github/workflows` |

> 回归保障 = 上表 6 条可自动化的门禁 + 无头冒烟。改动 `src/lib/` 与插件契约时应同步补测：
> 真实投产 manifest 的 schema 校验、令牌注入清单的覆盖性，均已有 spec 兜住（见 §11）。
> 注意渲染层**必须用 `vue-tsc` 而非 `tsc`** —— 后者不检查 `.vue` 模板，模板里引用的未定义变量会被静默放过。

---

## 11. 冻结契约（改动需评估）

以下为跨模块/跨进程契约，改动会波及其他层：

1. **`window.electronAPI` 形状** — `preload.ts` ↔ `src/types.ts` ↔ `src/core/services/ipc.ts` 三点同步。
2. **`registry.generated.ts` 导出符号** — `enabledModuleMetas` / `moduleViewLoaders` / `pluginPackageInfos` / `settingsPanelLoaders` 被 `AppShell.vue` / `PluginCenter.vue` 消费；生成逻辑在 `vite.config.ts`。
3. **`modules.config.json` 结构** — 必须是纯字面量 JSON（`vite.config.ts` 直接 `JSON.parse`，无转译步骤）。
4. **沙箱桥协议** — `sandboxRuntime.ts`（Worker 端纯 JS）↔ `sandbox.ts`（宿主端）的 MSG 常量与 `rid/id/token` 关联规则必须同源。
5. **事件总线通配判定** — `eventBus.ts` 与 `sandboxRuntime.ts` 双份等价逻辑。
6. **主题令牌名 `--wb-*`** — 定义在 `src/styles/index.css` 两套主题，组件只引用。
   **配套双点契约**：`uiBridgeHost.ts` 的 `WB_THEME_TOKENS` 是注入 UI 岛的**显式清单**，
   必须覆盖 `index.css` 定义的每个令牌（引擎的 `getComputedStyle` 索引枚举拿不到自定义属性，
   漏项即岛内永久缺失 → `var()` 解析失败、整条声明被丢弃）。由 `tests/uiIslandThemeTokens.spec.ts` 兜住。
7. **旧扁平 store key 迁移路径** — `electron/main.ts` 中的一次性迁移探测，勿删勿扩。
8. **`buildConfig.profiles` 语义** — `vite.config.ts` 读取；`scripts/select-build.js` 通过 `MODULE_IDS` 环境变量对其施加最高优先级覆盖。
9. **模块根探测规则** — 唯一权威在 `scripts/lib/module-roots.cjs`（判定标志：目录下存在 `meta.ts`），被 `vite.config.ts` 与 `scripts/select-build.js` 共用；二者不得各写一份。
10. **UI 岛 boot 握手** — `electron/plugin-ui-runtime.js`（iframe 端）↔ `src/core/plugin/uiBridgeHost.ts`（宿主端）的消息类型/载荷字段必须双端同步（AGENTS 红线 20）。
    两条不可回退的纪律：① iframe 端 `hello` **必须一直重试到 boot 落地**，不得设放弃阈值（宿主监听器注册可能晚很多）；
    ② 岛侧 `bridge.js` 的 `ready()` 必须真正等待 boot 完成 —— `window.__sk.ready` 是 **Promise**（恒为真值），
    误当布尔判断会让岛在握手前挂载，首屏用浅色回退令牌且首个数据调用永久挂起（表现为"样式与宿主主题不一致 + 永久加载中"）。
11. **外置 manifest 校验上限** — `externalManifest.ts` 的 `MAX_ACTIONS`（单 capability 动作数上限）与 `DB_OPS` 登记表规模挂钩；
    新增业务域导致单域 op 数增长时需复核。`tests/pluginManifest.spec.ts` 会对真实投产 manifest 跑 schema 校验。
12. **UI 岛的「静默失效」四则**（`ui-plugins/order-insight/dist/`，2026-09-22 一次性修掉，都很容易再犯）：
    - **事件代理的选择器必须显式传** — `app.js#onClick(root, handler, selector)` 默认只代理 `[data-act]`。
      用了别的点击属性（`data-sub` / `data-recon-view` / `data-range` …）就必须把 selector 传进去，
      否则 `closest('[data-act]')` 匹配不到直接 `return`，按钮**点了没反应且不报错**（曾导致「拿货对账」的 5 个子页签除首个外全部不可达）。
    - **绘制必须换挂载点** — `app.js#draw()` 每次 `replaceChildren` 一个新的 `.view-holder` 再 `mount(holder)`。
      若把 `mount` 的 root 固定成 `app.viewEl`，每次 `refresh()` 都会再挂一个点击监听器，
      同一个点击回调 N 次（重复写库 / 重复弹窗 / 撤销栈错乱），同样不报错。
    - **金额单位一律是「分」** — 宿主所有 `*Cents` 字段以分存储；`util.js#money(cents)` 已内置 ÷100。
      不要拿它格式化已是「元」的数（会再缩 100 倍），也不要把分直接当元显示（曾把拿货单/付款/对账金额放大 100 倍）。
    - **字段名 / 参数名以源码为准** — 如对账行真实字段是 `purchaseCents`/`paidCents`/`refundCents`/`balanceCents`（不是 `payableCents`），
      数据纠正的重归类分支条件是 `reclassify && fingerprint`（只传 `reclassify` 是空操作）。宁可回 `src/types.ts` 与 `electron/*-handlers.ts` 对一遍，勿凭记忆。
    前三者由岛无头冒烟（37 项断言，夹具见技能 `esm-spa-headless-smoke`）+ `tests/pluginTriage.spec.ts` 的反向断言兜住。

13. **UI 岛的 CSP 决定了「能力边界」**（不是实现偏好，是硬约束）——
    岛运行在 iframe 里，文档 CSP 是 `script-src 'self'`（`electron/plugin-ui-protocol.ts`），**没有 `'unsafe-eval'`**。
    后果：
    - **任何需要求值 JS 字符串的功能都不能写在岛内** —— 既不能 `eval` 也不能 `new Function`。
      `excel-copy` 的 `jsExpression` 字段规则正是这种形态，因此求值留在宿主（`db` 域 `applyRules` → 复用 `src/lib/fieldProcessor.ts`），
      岛只负责"收集参数 → 调用 → 渲染返回值"。
    - **同理不要指望"顺手在岛里装个库就行"** —— 岛无打包步骤（`dist/` 即源码），依赖需手写进静态文件。
      `excel-copy` 的 Excel 解析因此走宿主已有的 `src/lib/excelParser.ts`，避免两端口径漂移。
    - 两条都由 `tests/pluginTriage.spec.ts` 的 excel-copy 分组守着（扫描岛源码中不得出现 `eval(` / `new Function(`、
      不得 `from 'xlsx'`、必须调用 `applyRules`、必须真实调用宿主该域全部 op）。

14. **下记一个"唯一成员"要连带检查构建配置**（2026-09-22）——`excel-copy` 曾是 `minimal` 预设的**唯一**成员，
    下记后暴露出两处只在"极端组合"下才发作的配置缺陷：
    - `vite.config.ts` 生成 `settingsPanelLoaders` 时，空列表占位注释与闭合 `};` 同行 → **`}` 被一起注释掉**，
      任何不含 extensions 视图包的构建都直接失败（`pluginPackageInfos` 因另有换行而幸免）。**改生成器时要让占位分支与闭合括号分行。**
    - `profiles[profileName] || enabledModules` 用 `||` 会把空数组当缺失 → 空预设静默回落到 `enabledModules`。已改 `??`。
    教训：预设从"有内容"变成"空"是一种**状态迁移**，要像改业务代码一样验证（`MODULE_PROFILE=minimal npm run build`）。

15. **岛内表单的"半保存"**（2026-09-22）——保存动作必须把当前编辑的**全部**字段写回。
    `excel-copy` 的模板保存一度只写 `content` 不写 `name`：界面看着改了（草稿态），落库的还是旧名，
    重启后"名字回退但内容是新版本"。这类"一半生效"比整段失效更难查，已由守卫钉住
    （`saveTemplateToFile` 必须同时落 `name` + `content` + `isBuiltIn`）；
    `excel-copy` 无头冒烟（62 项）里对应的是"**改名保存 → 重读必须一致**"与"跨视图跳转后草稿不丢"两条。

