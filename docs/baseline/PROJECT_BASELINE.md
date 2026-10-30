# SellerKit 项目基线快照（PROJECT BASELINE）

> **性质**：本文件是**当前状态的客观快照**（结构 / 规模 / 契约 / 依赖），不是规则文档。
> 编码规则与红线的唯一权威是 [`../../AGENTS.md`](../../AGENTS.md)；架构"为什么这么做"见 [`../architecture/PLUGIN_ARCHITECTURE.md`](../architecture/PLUGIN_ARCHITECTURE.md)。
> **刷新时机**：版本号变更、新增模块/插件、新增 IPC 通道域、依赖大版本升级后。
> 维护规则见 [`../README.md`](../README.md)。

---

## 0. 基线元信息

| 项 | 值 |
|---|---|
| 快照日期 | **2026-10-26**（§5 IPC 契约、§6 表清单 / 50 个对象、§10 门禁与测试计数**本轮全部按实跑重测**：P4 新增 4 条 `ledger-*` 通道 ⇒ 234 / 229；表与对象数不变 —— 记账五期收口**没有动过表形状**）。⚠️ 历史局部修订：2026-10-01 产品库岛下架 · 2026-10-15 `shipping-rate` 岛回收 · 2026-10-21 C1 包裹运费口径 + C2 删表。⚠️ 2026-10-22 触发：**C2 收尾**（`ae_cost_map` 已删、成本 = 产品当前价 + 订单明细两字段）· **克重取数拉全**（修掉「只取前 500 款」的静默上限）· **依赖大版本升级**（Electron 33→44 / Vite 5→8 / vitest 2→4）。⚠️ 2026-10-23 触发：**产品 SKU 单一维护面**（采集段只读、删 `shop-items-update-sku`、矩阵收进产品编辑抽屉）。⚠️ 2026-10-25 触发：**新增记账域** —— `bk_*` 十张表（`ledger.main` v1）+ 内建模块「记账」P0 数据层与 P1 界面 ⇒ 业务表 37 → **47**、对象 40 → **50**、IPC 声明 212 → **230** / 通道 207 → **225**；测试 45 文件 / 875 例 → **48 / 958**；`db:inventory` 补入 `ledger-db` 域（此前漏登记，数出来不含 `bk_*`）。⚠️ 2026-10-26 触发：**记账 P2 分摊接入** —— 营收占比基准（`src/lib/ledgerRevenue.ts`）+ 方案存取 + 明细展开 + 删店保护 ⇒ 测试 **49 / 969**、`ledger:ui` 78 / 80 条、`ledger:smoke` 34 项、`shop:smoke` 45 项（均无新 IPC / 无表变更）。⚠️ 同日 **P3 往来与结算** —— `ledger:ui` 108 / 110 条、`partyLedger.spec.ts` 22 → 27 例（974）。⚠️ 同日 **P4 批量变更 + 视图 + 导出**（§11 五期收口）—— 新通道 **+4**（`ledger-entry-repatch-preview` / `ledger-entry-repatch` / `ledger-shop-breakdown` / `ledger-export-excel`，`ledger-handlers` 18 → **22**）⇒ IPC **234 / 229**；`ledger:ui` **160 / 162 条**、`ledger:smoke` **46 项**；lint warning 596 → **608**；新文件 `electron/ledger-xlsx.ts`；表与对象数不变 |
| `package.json` version | `1.1.0` |
| git commit | `16f9305`（branch `chore/dep-upgrade`） |
| 上游 remote | `sellerkit` → `https://github.com/SayakABC/SellerKit.git` |
| `electron-builder.yml` buildVersion | ✅ **已不设**（版本元数据单一来源 = `package.json`；此前写死 `1.0.0` 与 `package.json` 分歧的问题已修） |
| 工作区状态 | ⚠️ 有大量未提交改动（**2026-10-25 实跑 `git status --porcelain` 为 371 条**：157 改 + 61 删 + 3 改名 + 150 未跟踪）。本快照描述的是**工作区当前状态**，不是 `16f9305`。删除项含已下架/已回收的岛（`ui-plugins/{product-library,order-insight,shipping-rate}`）、C2 退役的 `electron/ae-engine.ts` / `electron/manual-costs.ts`，以及撤下的留档包，逐项时点见 §4 / §6 |
| 快照方式 | 静态分析（文件统计 / grep / 配置读取）+ **实跑门禁**（`npm run verify` / `vitest` / `eslint` / 各类冒烟）；**未跑打包**（`npm run dist`） |

---

## 1. 运行时与工具链基线

| 项 | 基线值 | 说明 |
|---|---|---|
| Node.js | 22.x | 开发机 22.22.x |
| TypeScript | 5.9.3（`package.json` 声明 `^5.4.2`） | 渲染层 `strict: true`；主进程 `strict: false` |
| Electron | **44.4.1**（`^44.4.1`） | 2026-10-22 `chore/dep-upgrade` 从 33 升上来。⚠️ v44 移除了 `clipboard.writeImage` 等窄 API，写图改走 `clipboard.write([ClipboardItem + Blob])`（见 `docs/notes/2026-10-30-electron-and-platform.md`） |
| Vite | **8.3.0**（`^8.3.0`） | 同批从 5 升上来；vitest 同步到 4.x |
| Vitest | **4.1.11**（`^4.1.11`） | `environment: node`；服务层用例可用 `vi.mock('@/core/services/ipc')`（见 §10 测试行） |
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
| `src/modules/<id>/` | 内建业务模块（**当前注册 5 个**：`today` / `mail` / `order-cost` / `quick-note` / `shop-accounts`；另有 `goods` / `picking` 两个目录只留视图实现、**无 `meta.ts` / `index.ts`**，分别以 `embedded` 形式挂在「基础数据 › 货品档案」与「今天 › 拿货」下） | 构建期收录 | 须在 `modules.config.json` 登记 |
| `src/lib/` | 纯函数工具层（无副作用） | 共用 | 改动前搜全部调用方 |
| `extensions/<id>/` | **随宿主分发的视图插件包**（`kind: view`，含 `meta.ts`）；**当前无实例，且目录不存在** —— 最后两个留档源码包（`excel-copy` / `order-insight`）已于 **2026-09-30（C3）删除**；机制保留，要用再建 | 构建期随包编译 | 自包含，import 走 `@/` 或包内相对 |
| `ui-plugins/<id>/` | **市场分发 UI 岛**（`kind: ui`，iframe + `window.__sk` 桥） | 独立构建产物，不入主 bundle | 经 host 能力域访问数据 |
| `scripts/` | 构建 / 打包 / 脚手架 / 冒烟脚本 | Node | — |
| `scripts/templates/` | **插件脚手架**：`l2-plugin`（L2 后台插件模板）/ `l2-demo`（L2 演示插件，2026-09-22 由 `extensions/_template` / `extensions/sk-hello` 归位而来）；UI 岛模板在 `scripts/ui-plugin-template/` | Node | 移动须同步改 `scripts/plugin-create.js` 的 `TEMPLATE_BG` 与 `scripts/plugins-install-demo.js` 的 `SOURCE`（二者硬编码指向） |
| `docs/` | 项目文档 | — | 见 `docs/README.md` |
| `dist/` `release/` `market-out/` | 构建与发布产物 | 生成物 | 不入库 |

### ⚠️ 已知目录语义冲突

`extensions/` **当前不存在**（2026-09-30 C3 删除最后两个留档包之后）。它曾承载两类形态，判定依据是「有无 `meta.ts`」——留档如下，将来重建目录时照此判定：

1. **视图插件包**（`kind: view` + `meta.ts`）：**当前无实例** —— 历史上是 `shop-accounts`（2026-09-16 下记；**2026-10-14 改为回收为内建模块** `src/modules/shop-accounts`）、`order-insight`（2026-09-21 下记）、`excel-copy`（2026-09-22 下记），后两者只保留 `ui-plugins/<id>` 市场岛。路径与机制（`vite.config.ts` 的 `MODULE_ROOTS` 双根探测）仍有效，供将来新增视图插件包使用。
2. **外置插件脚手架/示例**（`manifest.entry = ./index.js`、无 `kind`、无 `src/`）：`scripts/templates/l2-plugin`（模板）/ `scripts/templates/l2-demo`（示例，原名 `sk-hello`）—— 由 `npm run plugins:create` 生成，产出物应安装到 `<userData>/plugins/`。示例包本身已于 2026-09-24 从市场与本机下架（源码脚手架保留），见 `docs/archive/plans/PLUGIN_TRIAGE_PLAN.md` §0。
3. **下记后留档的源码**（有 `meta.ts` 但**不在任何预设里**）：曾有 `extensions/order-insight/`、`extensions/excel-copy/` —— 作算法与 UI 参考、**不进构建**（由 `tests/pluginTriage.spec.ts` 守住"预设 ∩ 岛 id = ∅"）。

第 2 类早已不在 `extensions/` 下（迁至 `scripts/templates/`）；**第 3 类已于 2026-09-30（C3）删除** —— 判定是「这些源码只是"多套实现"的源头、算法在内建 `src/lib` / 岛 `dist` / 宿主 op 都有落地，且它们一直占着 `tsconfig`/`eslint` 的覆盖范围」。至此**目录本身不再存在**，语义冲突彻底消失（`module-roots.cjs` / `vite.config.ts` 都用 `existsSync` 探测，缺目录无副作用）。（`extensions/ae-profit/` 的迁移残留已于 2026-09-22 删除，见 `ad7471d`；本条由「残留待清」订正为「已清」。详见审查报告 P1-5。）

---

## 3. 代码规模基线

统计口径：排除 `node_modules/` `dist/` `release/` `market-out/`；计入 `.ts .vue .js .mjs .cjs .css`。
**本表 2026-09-27 全量重扫**（此前各行的快照日期不一、已明显失真，那次全表重扫积压项已清）；
**2026-09-29 再次全量重扫**（含当日未提交的 `order-cost` 模块、`schema-migration-smoke.cjs`、以及
`extensions/order-insight` 删掉 `SupplierModal.vue` 等既有改动）。
**2026-09-30 第三次全量重扫**（含 `picking` 模块与 `picking-db` / `picking-handlers` / 两个新冒烟脚本）。
**2026-09-30 第四次重扫**（同日稍后：`today` 首页模块 · `aeMoney` 纯层 · `order-collected-rows` · `reset-dev-data` / `today:ui` 脚本；
顺手清掉 12 个 `vite.config.mjs.timestamp-*.mjs` 垃圾 → `ui-plugins/` 文件数下降是**清理结果**不是丢文件）。
**2026-09-30 第五次重扫**（同日更晚：新建 `src/core/settings/`（宿主自有设置贡献）· 三个新冒烟脚本 · `order-insight` 岛撤「拣货」页签并把「识别设置」改名「导入设置」· `ae-profit` / `shipping-rate` 收编瘦身 · **`extensions/` 留档包删除（C3）**）。
**2026-10-05 第六次重扫**（口径未变；两处大变化：`src/` 涨是 09-30 之后两周新增的「今天」发货台七页签 / 拣货 / 产品库收编，`ui-plugins/` 降是 `product-library`（10-01）与 `order-insight`（10-05）两个岛相继下架 —— **降是清理结果，不是丢文件**。同日另删两个孤儿模块 `aggregator` 313 行 / `templateEngine` 37 行，见 `CHANGELOG.md` 同日 Removed 段）。
**2026-10-10 第七次全量重扫**（口径未变；⚠️ 此前表值**与工作区实测对不上** —— 原记 `src/` 115 / `scripts/` 43，实测 131 / 47：第六次重扫漏算了两批未提交改动（「货与成本」重构 / 拿货七轮 / 截图脚本 `goods:shot`·`purchase:shot` 等）。**计数以实跑为准**：命令同上方「复现命令」，一次 `find … | wc -l` + 同一文件集接 `xargs wc -l`。**2026-10-11 复测**：`scripts/` 47 → 46 —— 当日新增的 `today-shot` 截图脚本随整轮「页签重设计」按用户裁定撤销（`src/` 行数同步回落），见 `docs/notes/2026-10-30-ui-nav-and-tabs.md`。**同日稍后复测（「今天」四页内容设计四轮后，口径命令不变）**：`src/` 40,436 → **40,467**、`scripts/` 18,637 → **18,754**（`today:ui` 新守卫与注释、`order-profit:ui` +3 行；`electron/` / `ui-plugins/` 未动、复测同值），见 `docs/notes/2026-10-30-mail-and-today-pages.md`。）
**2026-10-14 第八次全量重扫**（口径未变；两个主因：① **`shop-accounts` 由 UI 岛回收为内建模块** —— `ui-plugins/shop-accounts/src`（30 文件 / 11,059 行）折进 `src/modules/shop-accounts`，故 `ui-plugins/` 掉到 8 文件 / 509 行、`src/` 同步上涨；② 10-11 之后工作区还有若干未提交改动（`electron/` +1,248 行、`scripts/` +2,796 行）。**这是"搬家"而非"新增功能"** —— `ui-plugins/` 的降幅与 `src/` 的涨幅同源，逐岛分布见下方「各扩展包规模」表。）
**2026-10-15 第九次全量重扫**（口径未变；主因：**`shipping-rate` 岛回收为内建「基础数据 › 物流运费」** —— 业务代码从手写 `dist/` 改写为 `src/modules/shop-accounts/{shipRateFormat,shipRateStore,components/ShippingRatePane*,components/ShipRate*}`，`src/` +10 文件 / +1,657 行；`ui-plugins/shipping-rate/` 14 文件整体下架（`git rm`）。⚠️ **`ui-plugins/` 两行数值不变（8 / 509）是口径使然、不是没删东西**：该岛是「dist 即源码」型，源码在 `dist/` 下被本次口径 `prune` 掉，从头到尾**没进过这张表**。逐岛规模见下方表内已标注下架的那行。同期 `scripts/` +1 文件 / +1,204 行（`shipping-rate-ui-smoke.mjs` 整体重写为宿主形态）。）
**2026-10-22 第十次全量重扫**（口径未变；主因：① **C2 收尾**删掉 `electron/ae-engine.ts` / `electron/manual-costs.ts`，同时订单拆表（B1）+ 包裹（B2）让 `electron/order-db.ts` 涨到 3,830 行；② **克重取数拉全**新增 `tests/skuWeights.spec.ts`（`src/` 不含测试，故只影响 §10）；③ `scripts/` 涨到 51 / 26,073 —— 两个大冒烟脚本（`goods-ui-smoke` 4,020 / `today-ui-smoke` 3,940）是主要体量。⚠️ `ui-plugins/` 只 +4 行，是因为 10-15 之后两个现役岛（`ae-profit` / `excel-copy`）只有零星改动；两者规模见下方扩展包表。）

| 目录 | 文件数 | 代码行数 |
|---|---:|---:|
| `src/` | 171 | 60,511 |
| `electron/` | 55 | 24,679 |
| ~~`extensions/`~~ | — | **已删除（2026-09-30 C3）**；下方两行留档包同步作废 |
| `ui-plugins/` | 8 | 513 |
| `scripts/` | 51 | 26,073 |
| **合计** | **285** | **111,776** |

> ⚠️ **本口径不计 `dist/`**，而唯一在架的**手写岛**（`excel-copy`）的源码**就在 `dist/`**
> （无构建步骤，"dist 即源码"）→ 它们的体量在本表**没有体现**，只在下方「各扩展包规模」表里按岛单列。
> 因此 `ui-plugins/` 行**只含**工程岛的 `src/` 与各岛的配置文件，**不是**它的全部业务代码；
> 逐岛的分布见下方「各扩展包规模」表（手写岛按 `dist/` 单列）。
> 复现命令（与上表口径一致）：
> `find <dir> -type d \( -name node_modules -o -name dist -o -name release -o -name market-out \) -prune -o -type f \( -name '*.ts' -o -name '*.vue' -o -name '*.js' -o -name '*.mjs' -o -name '*.cjs' -o -name '*.css' \) -print | wc -l`
> 行数用**同一 `find` 的同一文件集**接 `-print0 | xargs -0 wc -l | tail -1`。

### 各扩展包规模

| 包 | 文件数 | 行数 | 形态 |
|---|---:|---:|---|
| ~~`extensions/order-insight`~~ | — | — | 留档包，**2026-09-30 已删**（算法在内建 `src/lib` / 岛 `dist` 各有落地） |
| ~~`extensions/excel-copy`~~ | — | — | 留档包，**2026-09-30 已删** |
| `ui-plugins/shop-accounts` | — | — | ui，**2026-10-14 回收为内建模块** → `src/modules/shop-accounts`（口径 = `src/`，**26 文件 / 11,948 行**；回收当时为 18 文件 / 10,181 行，同日「基础数据」整合又迁入供应商与成本费率面板；原岛 30 文件 / 11,059 行不含 7 个桥接桩）。**岛形态唯一的"反向"动作**：不是下架而是收回宿主，见 `docs/plans/SHOP_ACCOUNTS_INTAKE_PLAN.md` |
| ~~`ui-plugins/order-insight`~~ | — | — | ui，**2026-10-05 整体下架**（原 17 文件 / 3,264 行，口径 = `dist/`）—— 功能收归内建「今天」发货台（**2026-10-10 起六页签**：拣货并入拿货，见 `docs/notes/2026-10-30-picking-and-takeout.md`） |
| ~~`ui-plugins/shipping-rate`~~ | — | — | ui，**2026-10-15 回收为内建**（原 14 文件 / 2,334 行，口径 = `dist/`）—— 功能收归内建「基础数据 › 物流运费」（`src/modules/shop-accounts/`）。判定与计价单源抽到 `src/core/services/shipRateOps.ts`，页面直接 import，避免两份口径算出两个价。岛目录已 `git rm`（可从历史恢复）。⚠️ **同日二次收口**：`host.ts` 的 `DB_OPS['shipping-rate']` **薄委托也已整域删除**（初版为兼容"市场里已装旧岛的用户"而留；项目尚未上线、无这批用户）⇒ 现在**没有任何路径能装到或跑起这个岛**。`tests/pluginTriage.spec.ts` 有反向守卫钉住这一点 |
| `ui-plugins/excel-copy` | 10 | 2,473 | ui（**dist 即源码**，无构建步骤） |
| `ui-plugins/ae-profit` | 5 | 470 | ui（**vite 工程**，口径 = `src/`；1.1.0 收编后只剩接收端视图） |
| ~~`ui-plugins/product-library`~~ | — | — | ui，**2026-10-01 整体下架**（原 12 文件 / 4,367 行，口径 = `src/`）—— 功能收归内建「货与成本」，见 `docs/features/PRODUCT_LIBRARY.md` §0-A |
| `scripts/templates/l2-demo` | — | 65 | 脚手架·L2 示例（原 `extensions/sk-hello`，2026-09-22 归位） |
| `scripts/templates/l2-plugin` | — | 49 | 脚手架·L2 模板（原 `extensions/_template`，2026-09-22 归位） |

> 口径：**工程岛**（`ae-profit`）取 `src/`；**手写岛**（现只剩 `excel-copy`）取 `dist/`。
> `shop-accounts`（2026-10-14）与 `shipping-rate`（2026-10-15）先后回收为内建模块后，手写岛只剩 `excel-copy` 一个。
> `extensions/` **目录已不存在**（最后 2 个留档包 2026-09-30 删除；`ae-profit` 的目录更早删除）。
> 宿主侧纯函数**不在这里**（属 `src/`）：`src/lib/productImport.ts` 923 行（产品库导入解析；2026-10-09 模板改列后自 427 行扩至 923 —— 顺序对应 / 同款合并 / 抽图归位 / 提交路径二次校验都收在这份纯函数里）、
> `src/lib/shipRate.ts` 832 行 + `src/lib/shipRateQuote.ts` 281 行（运价表归一化与计价）、
> `src/lib/shipRateOrders.ts`（按订单算运费的数据衔接）、
> `src/lib/pickingSheet.ts` 232 行（发厂清单图模型 + canvas 渲染 —— 屏上 / 「复制给厂家」的 PNG / 导出 xlsx 三方共用同一套措辞）、
> `electron/shopName.ts`（店铺名归一的纯函数层，S1 新增——**放在 `electron/` 下**是为了就近被 `shop-db.ts` 引用，
> 它零依赖、因此仍可被 vitest 覆盖：`*-db.ts` 依赖 better-sqlite3 的 Electron ABI，vitest 直接 require 会崩）。
> ⚠️ **商品重量解析链（`pl_item_weights` 表 + 对应的 Excel 解析）已于 2026-10-01 整条删除**：
> 克重是 **SKU 属性**而非商品ID 属性，改挂 `pl_variants.weight_g`，在「货与成本」按 SKU 维护。
> 该文件已不存在，任何引用都应按此口径改写。

### 最大的 10 个文件

| 行数 | 文件 |
|---:|---|
| 3,830 | `electron/order-db.ts` |
| 2,513 | `src/types.ts` |
| 2,306 | `electron/product-db.ts` |
| 1,884 | `src/modules/picking/PickingView.vue` |
| 1,820 | `src/modules/goods/components/PoolPane.vue` |
| 1,799 | `src/core/services/ipc.ts` |
| 1,518 | `electron/preload.ts` |
| 1,483 | `src/modules/order-cost/OrderCostView.vue` |
| 1,465 | `src/modules/goods/useSkuPool.ts` |
| 1,451 | `src/modules/shop-accounts/components/AccountsPanel.vue` |

> ⚠️ **2026-10-22 本表重数**（口径 = `src/` + `electron/`，与上表一致）：`electron/order-db.ts`
> 因 B1 拆表 + C2 两字段迁移涨到 3,830 行居首；`src/modules/picking/PickingView.vue` 1,884 行
> 仍是最大的模块视图，但它**已不是模块**（只作「今天 › 拿货」的 embedded 视图）。
> 若把 `scripts/` 也算进来，榜首会被两个冒烟脚本占据（`goods-ui-smoke.mjs` 4,020 /
> `today-ui-smoke.mjs` 3,940）—— 本表刻意不收脚本，避免"测试体量"与"产品体量"混排。

**结构观察**：`src/` 6.05 万行、`electron/` 2.47 万行；**宿主契约面（`src/types.ts` 2,513 + `ipc.ts` 1,799 + `preload.ts` 1,518 = 5,830 行）仍是维护成本的主要来源**。
另一处值得盯的是 **`src/modules/shop-accounts` 单模块 1.21 万行**（29 文件；四个 1000+ 行文件：
`AccountsPanel.vue` 1,451 / `CompanyManageView.vue` 1,208 / `store.ts` 1,207 / `AccountEditor.vue` 1,070）——它已从"一个岛的视图层"长成了
"账号 + 企业 + 邮件 + 店铺登记 + 供应商 + 成本费率 + 物流运费七个资料域的界面合体"，**再往上加资料种类之前应先评估拆分**（AGENTS §1 的单文件 ≤300 行约束
在这里早已被绕过，属已知技术债）。⚠️ 2026-10-14 由 UI 岛回收为内建模块：**同一份体量只是换了位置** ——
它在 `ui-plugins/` 时曾是"`ui-plugins/src` 口径的 76%"，回收后成为 `src/` 里最大的单模块，技术债并没有因为搬家而消失。
⚠️ 2026-10-14 同日「基础数据」整合后：入口 `MasterDataView.vue`（392 行，左导航 + 右内容区）
替下原 `ShopAccountsView.vue`（1,595 行四页签），供应商 / 成本费率两块从 goods 与 order-cost 迁入 ——
**模块总行数不降反升（1.02 → 1.21 万行）**：整合减的是"入口数量与学习成本"，不是代码量。

---

## 4. 模块与插件注册表基线

`modules.config.json` 是模块启用清单的**单一事实源**，经 `vite.config.ts` 求值后生成 `src/registry.generated.ts`。

### 构建预设

| profile | 模块列表 |
|---|---|
| `minimal` | *（空）* —— 纯外壳：全部业务功能已下记为市场分发的 UI 岛 |
| `standard`（默认） | `today` `shop-accounts` `mail` `order-cost` `ledger` `quick-note`（**2026-10-17**：`goods` 退出 —— 不再是模块，整页并进 `shop-accounts` 左导航的「货品档案」；同批 `picking` 也退出 —— 只留 `PickingView.vue` 作「今天 › 拿货」的 embedded 视图；同日新增 `mail`。**2026-10-25**：新增 `ledger` —— 内建模块「记账」，`order: 5`） |
| `pro` | 同 `standard` |
| 兜底 `enabledModules` | 同 `standard` |

优先级：`MODULE_IDS` env > `MODULE_PROFILE` env > 文件内 `profile` 字段 > `enabledModules`。

> 取值用 `??` 而非 `\|\|`（2026-09-22 修）：`\|\|` 会把「预设存在但为空数组」和「预设不存在」混为一谈，
> 于是 `minimal: []` 会静默回落到 `enabledModules` —— 一个"纯外壳"预设根本表达不出来，日志还会显示成它自己的名字。

### 当前实际收录（`registry.generated.ts`，standard profile）

| id | 源码根 | 形态 | version | 设置面板 |
|---|---|---|---|---|
| `today` | `src/modules/today` | 内建模块（2026-09-30 新增，显示名「今天」）—— 2026-10-05 起是**发货台**：一页 **五页签**（总览 + 四步：导入订单 / 归类核对 / 拿货 / 结算对账；**2026-10-17「算钱」整步撤出**——用户裁定归拢到独立模块并改名「统计」，页签 6 → 5、步骤 5 → 4，见 `docs/notes/2026-10-30-shipping-desk-and-rate.md`），**五步全部内建**（2026-10-05 晚：拿货 / 结算对账 / 归类核对三页签从「订单归类」岛收编，界面走 `.wb-*`、数据层全用宿主现成 IPC，**零新 IPC / 零迁移 / 岛不发版**；**2026-10-10：原第 3 步「生成拣货单」并入「拿货」**——六步 → 五步，拣货清单成为「拿货 › 要拿什么」子视图（同日晚该子视图整页重做成**卡片网格 +「复制给厂家」**，见 `docs/notes/2026-10-30-purchase-card-and-editor.md`），理由见 `docs/notes/2026-10-30-picking-and-takeout.md`），点步骤**切页签不跳页**；容器 `flowCtx.ts` 提供共享上下文（`reload`/`go`/`bump`/`token`），面板 `tabs/*Panel.vue` + 域薄封装 `purchase.ts` / `classify.ts`；缺口卡可**就地补齐** | — | — |
| ~~`goods`~~ | `src/modules/goods`（**仅视图实现，不再是模块**） | **2026-10-17 退出注册表**：整页并进「基础数据」左导航第二项「货品档案」（`GoodsView.vue` 以 `embedded` 渲染，`meta.ts` / `index.ts` 已删）。此前：2026-09-30 新增、显示名「货与成本」；2026-10-01 产品库岛下架、功能整体收回；2026-10-08 起 S0–S5 工作台重构（`docs/plans/GOODS_WORKBENCH_PLAN.md` §11）。⚠️ **两栏断点同批从 1180 抬到 1280** —— 可用宽度少了左导航 200 + 内边距 36 + 栏间距 12 = 248px，默认 1200 窗口下的主形态现在是**上下堆叠**，见 `docs/notes/2026-10-30-goods-ux-refactor.md` | — | — |
| `mail` | `src/modules/mail` | 内建模块（**2026-10-17 新增**，显示名「邮件」，`order: 3`）：原「基础数据」的「邮件」页签独立成一级模块（`MailView` 页头未读数 + `MailInboxView`；`MailAccessDrawer` 仍留在基础数据 —— 它是**账号**的属性）。设置贡献 `src/modules/mail/settings.ts`（分类 `mail:settings`，页签 `inbox`）。⚠️ **存储命名空间刻意沿用 `shop-accounts-mail`**（已落盘的邮箱账号 / 同步游标 / 附件索引），改键等于让老用户收件箱"变空" | — | 模块级 `settings.ts`（分类 `mail:settings`） |
| `ledger` | `src/modules/ledger` | 内建模块（**2026-10-25 新增**，显示名「记账」，`order: 5`，图标 `note`）：店铺收支 + 公共费用分摊 + 资金相关人往来。P0 数据层 = `electron/ledger-db.ts`（`bk_*` 十张表，迁移键 `ledger.main` v1）+ `src/lib/ledger.ts`（分摊 / 尾差）+ `src/lib/partyLedger.ts`（往来口径）；P1 界面 = 明细页（月份 + 五数 + 八筛选 + 作废 + 体检条）、记一笔弹层（专属 / 公共；公共含可参与店铺三态 + 平均 / 手工比例 + 保存前逐店预览 + 守恒行）、相关人管理（含合并）、科目管理；**P2（2026-10-26）** = 营收占比基准（`src/lib/ledgerRevenue.ts`，复用统计页营收汇总、不另写 SQL；未登记 / 同名多店 / 未写店铺 / 关闭单 / 缺金额 / 取数触顶六个分桶）+ 方案存取（`bk_allocation_rules` 接 UI，`rule_id` 只留痕）+ 明细行展开分摊 + 改金额按原比例重算 + 删店保护（`electron/shop-delete-guard.ts`）；**P3（2026-10-26）** = `明细 / 往来` 页签（选中项持久化）+ 台账（六列 + 分方向余额 + 全期间恒等式）+ 往来抽屉（六个数 / 时间线滚动余额 / 结算单含已撤销）+ 结算弹层（金额只由服务端按条目求和、方向与条目类型绑定、上限按该方向余额）+ 撤销结算（原因必填，条目恢复未结）；**P4（2026-10-26）** = 批量操作条（只算有效条目）+ 变更相关人**三路**（`RepatchDialog.vue`：A 直接改挂 / B 只改挂未结算〔**不写 `bk_transfers`**〕/ C 撤销后改挂〔原因必填、整单作废、连带如实披露〕，预览数由服务端算、界面不复算）+ 单店视图（`ShopView.vue`：三卡按专属/公摊分项、科目占比按同方向、公摊逐笔、与统计口径只读对照）+ 汇总视图（`SummaryView.vue`：四分项 + 四项体检）+ xlsx 导出（`electron/ledger-xlsx.ts`，行与合计由渲染层传入）。模块现为 15 个文件 / 6,052 行。⚠️ **记账 ≠ 统计**：本模块记的是「已发生、金额确定、算谁的」业务收支，与 `order-cost` 的订单预测毛利**只并排不相加**（方案 §1）。冒烟 `npm run ledger:smoke`（DB，46 项）+ `npm run ledger:ui`（假桥，宽 / 窄 160 / 162 条） | — | — |
| `quick-note` | `src/modules/quick-note` | 内建模块 | — | — |
| `order-cost` | `src/modules/order-cost` | 内建模块（2026-09-29 新增；显示名 2026-09-30 由「订单利润」改为**「算钱」**、**2026-10-17 再改为「统计」**（同批把「发货台」的「算钱」页签整步收归此处 ⇒ 利润只有这一个入口、一个口径）；承载采集与导入**两条摄取通道** + 预测/已结算**两条轨** + **时间趋势（月/日）**） | — | — |
| ~~`picking`~~ | `src/modules/picking`（**仅视图实现，不再是模块**） | **2026-10-17 退出注册表**（用户口径「把拣货菜单去掉」）：同一份清单早已是「今天 › 拿货 › 要拿什么」的入口视图（`PickingView.vue` 以 `embedded` 复用，`meta.ts` / `index.ts` 已删），左导航那一项是**第二条入口**，违反"入口唯一"。功能面零损失：导出 / 更多（天数窗·店铺·含已发货）在内嵌时挂在精简条上。此前：2026-09-30 新增、显示名「拣货」；2026-10-10 起整页视图被「今天 › 拿货」以 `embedded` 方式复用，同日晚重做成**卡片网格 +「复制给厂家」**（见 `docs/notes/2026-10-30-picking-and-takeout.md`、`docs/notes/2026-10-30-purchase-card-and-editor.md`） | — | — |
| `shop-accounts` | `src/modules/shop-accounts` | 内建模块（**2026-10-14 由市场 UI 岛回收**；⚠️ **同日整合后显示名改为「基础数据」**，原名「店铺账号管家」）。主视图 `MasterDataView.vue`：**只有内容区**（2026-10-17 起；此前是「左导航七资料种类 + 右内容区」）。七项资料（店铺账号 / **货品档案** / 店铺登记 / 企业 / 供应商 / 成本与费率 / 物流运费）现在是**主侧栏的二级菜单**—— `meta.subNav: true` + 运行时上报（`src/core/services/subNav.ts`），子项只在模块处于前台时展开、切走自动收起（2026-10-17 午后补：**再点一次一级项即可手动收起/展开**，`subCollapsedFor` 只记一个模块 id、不持久化，切模块即清 —— 原先点自己会被 `activateCore` 的同模块早退吞掉）。同日先后两件事：「邮件」搬出成一级模块、「货品档案」= 原「货与成本」整页搬入；随后那条 200px 左导航搬上侧栏，**内容区多出 212px**（「货品档案」两栏断点因此从 1280 回调到 1180）。供应商与进价自 goods、汇率自 order-cost 迁入，**维护动作只留一个家**。**一级入口**（`meta.parent` 缺席；同日把「店铺管理」分组整个撤销，顺序排在「货与成本」之前）。设置页由同目录 `settings.ts` 贡献（分类 `shop-accounts:settings`，见 §4 下方「设置面板贡献」）。数据层零迁移：`electron/shop-accounts-db.ts` + 既有 IPC 通道原样，存储命名空间仍是 `modules.shop-accounts`（⚠️ 这句只对**回收那次**成立：**2026-10-22 物理合并**后本层已改读写 `sk_shops` 的账号列 + `sk_tool_accounts`，`sk_shop_sets` 随 `shop.main` v1 删除，见 §6）。结论笔记见 `docs/notes/2026-10-30-data-model-and-dependencies.md`、`docs/notes/2026-10-30-ui-nav-and-tabs.md` | — | 模块级 `settings.ts`（分类 `shop-accounts:settings`） |

> `order-cost`（**显示名「统计」**，2026-10-17 由「算钱」改名，id 未改）是**跨域算到一处**的第一刀：订单行 × 款级成本 × 克重 ×
> 运价表 × 收入/税 → 逐行 运费/成本/税/收入/毛利 + "缺哪一环"。口径由用户 2026-09-29 裁定：
> **预测**口径（在途单也算）· 关闭单单列一桶不进合计 · 平台代征代缴时税记确定的 0 ·
> 平台费无数据源则全局标"未扣"、**不按 0 算**。
> **件数口径**（P2，2026-09-29）：结算商品行真值 → 订单报表块内 `商品数量` → 按 1 件并逐行标「缺件数」；
> **件数不进成本/运费/毛利算术**（多件合并计费仍是运价岛的开放项），有件数 > 1 的行时界面显式提示这一口径。**有意做成内建模块而不是岛** —— 走渲染层核心不经过岛的
> `domains`/`actions` 判定，**零发版**；搬进岛时再连带声明新 op 一起发版。
> 它读运价表：**只有宿主快照**（`shipRateSnapshotCalc`，按订单日期取"当时那份"；真源 `sr_rate_snapshots`，
> M6 / ADR-002 C3，2026-09-30 迁定）。⚠️ 原先有一层"岛存储回落"（`useModuleStorage('shipping-rate')` 的 `table` 键），
> **2026-10-15 随岛下架一并删除** —— 那个键永远读不到值，是恒不生效的死代码（"看起来还兼容着"比没有更容易骗人）。
> 算法层 `computeOrderCosts` 的单表口径分支**故意留着**（分支本身合法，`tests/orderCost.spec.ts` 钉着
> "快照优先于单表"），只是生产恒传 `rateTable: null`。同键里的 `rounding` 是**用户查询偏好**、仍在写，仍读。纯计算层在
> `src/lib/orderCost.ts`（口径单源 + vitest 覆盖），项目文档见 `../reviews/BUSINESS_GAP_ANALYSIS_2026-09-29.md`。
> **运费口径（阶段 C1，2026-10-21）**：**已拆包**的单运费 = 该单所有包裹的**实付合计**
> （`parcelTotalsByOrders`；按件数摊到各行、尾差归末行，逐行相加仍等于实付），运价表**不参与**；
> 已拆包但缺运费 → 标 `parcel` 缺口、**不回落估算**（否则"按包记的真值"会被估算盖掉）；**未拆包**的单
> 仍走上面的快照链路。`sr_rate_snapshots` 本体保留（2026-10-21 C2 已退役 `ae_cost_map`，与运价表无关）。
> 见 `docs/notes/2026-10-30-shipping-desk-and-rate.md`。
> **成本口径（阶段 C2，2026-10-21）**：订单明细行两个字段 —— `cost_cents` = 归类确认时固定的**进价（预估）**、
> `actual_cost_cents` = 拿货结算写入的**实付真值**；取数优先级 **实际 > 预估 > 缺**（0 = 缺失，不是"免费"），
> 产品行 `pl_products.cost_cents` 只用于给**新订单**估当前价。`ae_cost_map`（款级区间价目表）与
> `ae-cost-map-*` 四条通道已整体退役；旧价目表数据由 `order.main` v9 回填进上述字段后，v10 删表。
> 见 `docs/notes/2026-10-30-cost-maintenance-and-retire.md`。

> `excel-copy`（TV模版）已于 2026-09-22 **下记**（移出 `minimal` / `standard` / `pro` 三处），改为从市场安装的 UI 岛。
> `order-insight`（订单归类）已于 2026-09-21 **下记**（移出 `standard` / `pro`）、2026-10-05 **整体下架**（功能收归内建「今天」发货台）。
> 下记原因（AGENTS 红线 23）：内建记录会占用同名 id，`managerDiscover` 注册 UI 岛时见 `records.has(id)` 即静默跳过，
> 导致已装的岛永远没有入口。宿主侧业务库与 db 能力域（`electron/order-db.ts` / `purchase-db.ts` / `excel-copy` 域等）
> **全部保留不变**，岛照常经 `db` 域调用。源码 `extensions/<id>/` 曾暂留作算法与 UI 参考、不参与构建
> （**已于 2026-09-30 C3 删除**；`tests/pluginTriage.spec.ts` 仍守住"预设 ∩ 岛 id = 空集"）。
>
> ⚠️ 连带修复（2026-09-22）：`vite.config.ts` 生成 `settingsPanelLoaders` 时，空列表的占位注释
> `'  // (none)'` 与闭合 `};` 挤在同一行，等于**把 `}` 一起注释掉** —— 只要构建不含 extensions 视图包
> （下记 `excel-copy` 后必然如此）就直接编译失败。同为占位分支的 `pluginPackageInfos` 因另有换行而未踩到。

### UI 岛清单（`ui-plugins/`，独立分发，不进主 bundle）

| id | version | 能力域（manifest `capabilities`） | 一句话职责 / 形态 | 设置面板 |
|---|---|---|---|---|
| `ae-profit` | **1.1.0** | `clipboard` · `db`(ae) | **订单采集接收端**（原「利润追踪」）。**Vite 工程岛**。1.1.0（2026-09-30，**C9 收编**）：原「利润统计 / 订单明细 / 成本与汇率」三页签并入宿主**「算钱」**页（趋势 / 明细 / 成本表 / 汇率维护都在那里，读同一份主干）→ 岛只留**接收端状态 + 接入方式**（curl 样例）；随之移除 `storage` 与 `purchase` 域、`db.actions` 收敛为 `ensure` / `receiverStatus` 两个（`tests/pluginTriage.spec.ts` 双向守卫） | — |
| `excel-copy` | 1.0.0 | `storage`(excel-copy) · `clipboard` · `dialog` · `db`(excel-copy) | **TV模版唯一实现**（2026-09-22 内建下记后）。**手写 ESM 岛**。设置页在岛内第二个页签（原宿主设置中心的 `excel` 分类随下记消失） | — |
| ~~`order-insight`~~ | ~~1.5.0~~ | — | **2026-10-05 整体下架**：功能**几乎全部收归内建**（发货台 —— `src/modules/today/**`；收编当时是**六步 / 七个页签**：总览 / 导入订单 / 归类核对 / 生成拣货单 / 算钱 / 拿货 / 结算对账。⚠️ **2026-10-10 起是六页签 / 五步** —— 「生成拣货单」并入「拿货」，见下一行 `picking` 与 `docs/notes/2026-10-30-picking-and-takeout.md`）；非每日动作的「识别库 / 透视 / 明细」按裁量去掉。数据层与 IPC 通道一行未改；为该岛开的 `order-insight` 能力域（**37 op**）随之**整域删除**（`src/core/plugin/host.ts` 就地留墓碑）。⚠️ **存储命名空间 `modules.order-insight` 保留不改名**（引擎配置 + 列映射是已落盘的用户数据键）。详见 `CHANGELOG.md` 的 Removed 段与 `docs/notes/2026-10-30-island-publish-and-retire.md` §6 | — |
| ~~`shop-accounts`~~ | ~~1.5.2~~ | — | **2026-10-14 回收为内建模块**（`src/modules/shop-accounts`，侧栏挂在「店铺管理」分组下）：账号库 / 企业管理 / 收件箱 / 店铺登记 / 名下店铺五个面**全部保留**，只是从 iframe 岛变成宿主组件。**数据层与 IPC 通道一行未改**（`electron/shop-accounts-db.ts`、`mail-*`、`company-*`、`shop-*` 原样），存储命名空间 `modules.shop-accounts` / `modules.shop-accounts-mail` **不改名** ⇒ 老用户配置自动继承。设置从 `manifest.settings`（iframe 岛）改为**模块级 `settings.ts` 贡献**。宿主 `DB_OPS` 的 `shop-accounts` / `shop` / `mail` / `secrets` 四个能力域**本轮保留未删**（权限面回收是独立议题，见计划 §0「不在本次范围」）。详见 `docs/plans/SHOP_ACCOUNTS_INTAKE_PLAN.md` | — |
| ~~`shipping-rate`~~ | ~~1.3.1~~ | — | **2026-10-15 回收为内建「基础数据 › 物流运费」，并**同日从市场撤下**（catalog 条目 + 8 个历史 zip 全删、`host.ts` 岛桥域整域删除）—— 项目尚未上线、没有已装旧岛的用户，故不留兼容层（每个保留的域都是一份要维护、还要防它长成"第二入口"的分身）。留存的事实：**手写 ESM 岛**（`dist/` 即源码、无构建步骤）；1.1.0 起「按订单试算」；1.2.0 起「按产品试算」；**1.3.0（M6，2026-09-30）运价表回迁** —— 真源是宿主快照表 `sr_rate_snapshots`（ADR-002 C3），岛不再存表也不再把它传回宿主计价；**1.3.1（2026-10-10，克重链收口）** 两条试算读同一份 SKU 克重（`pl_variants`），原「商品ID 重量链」整条删除（2026-10-01 领域裁定）。⚠️ **该岛从未真正上线过**（zip 只在本机 `market-out/` 打包过，未推送），所以撤下没有用户影响 | — |
| ~~`product-library`~~ | ~~1.5.0~~ | — | **2026-10-01 整体下架**：产品（款式）主数据 / 店铺商品ID→产品映射 / 供应商（厂家）主数据 / 店铺商品清单四个维护台**全部收归内建「货与成本」**（`src/modules/goods/**`，四个页签）。数据层与 IPC 通道一行未改；为它拆的 5 个 `DB_OPS` 域（32 op）随之删除。详见 `docs/features/PRODUCT_LIBRARY.md` §0-A 与 `CHANGELOG.md`。<br>⚠️ **2026-10-08 后续**：界面收成**三个页签**（产品 / 映射与关联 / 供应商）—— 「商品清单」因**产出没有下游消费者**被收起（`SHOP_PRODUCTS_TAB_ENABLED = false`，明细见 `docs/notes/2026-10-30-goods-list-and-pool.md`）；数据层与 IPC **一行未删** | — |

> **本表只留快照级事实**：逐岛细节（版本演进、页签、陷阱、权限声明的取舍）见 **`ui-plugins/<id>/README.md`** 与 `CHANGELOG.md`。
> 三条共性：
> ① **形态**——手写岛（现役只剩 `excel-copy`）`dist/` 即源码、**无构建步骤**；工程岛（`ae-profit`）`dist/` 是构建产物、不入库。（`shop-accounts` 曾是第二个工程岛，2026-10-14 回收为内建模块；`shipping-rate` 曾是第二个手写岛，2026-10-15 同样回收为内建「基础数据 › 物流运费」，二者均不在本表。）
> ② **Excel 解析与重计算一律在宿主**（凡涉及 Excel 的岛都如此）：岛所在 iframe 的 CSP 是 `script-src 'self'`、无 `unsafe-eval`，岛内既不能求值也不打包 `xlsx`（详见 §11-13）。⚠️ 该约束**内建页面同样成立**（只是不受 CSP 限制）：`shipping-rate` 回收时解析与计价仍留在宿主侧 `core/services/shipRateOps.ts`，页面只收参数、渲染返回值
> ③ **全部市场分发、都不入 `modules.config.json`**（红线 23）；前三个由内建版下记而来，与内建**同名 key 共用命名空间** → 模板 / 规则 / 显示列等**配置自动继承**。
> ⚠️ **改岛内容必须升 `manifest.json` 的 `version` 并重跑发布** —— 否则「插件中心 → 市场」与 `<userData>/plugins/` 都还是旧版。

---

## 5. IPC 契约基线

**这些数字不再靠人工维护**：`npm run verify`（R2-4）从源码动态提取三份清单求差，
下表为其输出快照（**2026-10-26 实跑复核**）。三者不相等即为契约漂移，校验会失败并指出缺哪一项。

| 指标 | 值 | 来源 |
|---|---|---|
| preload 暴露键 | **234 个** | `electron/preload.ts` 的 `ipcRenderer.invoke(...)` 字符串 |
| `src/types.ts` `ElectronAPI` 声明 | **234 个** | 与 preload **集合对称**（R1-3 已修复此前的缺 4 项） |
| 主进程注册通道 | **229 个** | 含裸 `ipcMain.handle/on` 与封装 `register()` / `handle<T>()`（封装名**跨文件**解析） |
| 主→渲染单向广播 | 3 处：`mail-sync-event`、`updater-event`、`ae-items-ingested` | `webContents.send` ↔ `ipcRenderer.on` 双向对称校验 |
| 命名合规性 | 100% 匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`（kebab-case） | 人工核对 |

> 为什么 preload(234) 与主进程通道(229) 不相等：部分键共用同一通道（如 `read-file` 被
> `importExcelByPath` 与 `readFile` 共用），另有一批通道属"仅广播/仅包装"语义，属设计如此而非漂移。
> 主进程注册分布（verify 实时输出，**2026-10-26 实跑**）：
> **order 48** / **product 28** / **purchase 28** / mail 24 / **ledger 22** / **shop-accounts 13** / main 12 /
> company 8 / **shop 8** / ae 7 / **shop-product 6** / **shop-item 4** / backup 4 / plugins 4 / ship-rate 3 /
> clipboard 3 / market 2 / updater 2 / picking 2 / ipc-handlers 1 —— 合计 229。
> ⚠️ 本行是**实测快照**：2026-10-23（212·207）→ 10-25（230·225，记账 P0 **+18**）→
> 10-26（234·229，记账 P4 **+4**：`ledger-entry-repatch-preview` / `ledger-entry-repatch` /
> `ledger-shop-breakdown` / `ledger-export-excel`，逐条清单见 `docs/plans/LEDGER_PLAN.md` §11）。
> 下次刷新只改这里与上表，不要在演进轨迹里补编中间数。
> —— 演进轨迹：147/143 → 151/147 → 153/149（+4：`order-shipping-rows`、`product-weight-import/get/stats`）
> → 161/157（+8：S1 的 8 个 `shop-*` 通道）→ 166/162（+5：P3 的 5 个 `product-sku-*` 通道）
> → 182/178（+16：1.2.0~1.5.0 的 `product-*` 增补、`shop-product-*` 6 个、`shop-db-ensure` 等）
> → 185/181（+3：`ship-rate-snapshot-{save,list,calc}`，运价表快照）
> → 188/184（+3：`settle-import` / `settle-orders` / `settle-stats`，结算明细导入）
> → 189/185（+1：`order-assign-shop`，订单归属店铺）
> → 190/186（+1：`picking-rows`，拣货投影 —— 只读，聚合在渲染层纯函数）
> → 191/187（+1：`order-collected-rows` —— 当日即被**主干化**取代：采集改写 `oi_orders` 后该通道删除，回到 **190/186**；`order-shipping-rows` 加 `source` 过滤）。
> → 188/184（−2：删 `get-store` / `set-store`，**C6 旧扁平存储契约退场**，渲染层早已无调用方 → `main` 15→13）。
> → **188/184**（2026-10-09 实测 HEAD 为 187/183 —— 上一行记完后至本轮之前**净 −1**，未逐条溯源；本轮 +1：`product-extract-images`，产品导入抽嵌入图 → product 22→23，总数回到 188/184）。
> → **190/186**（2026-10-09 P4：+2 —— `ae-cost-map-upsert-manual` / `ae-cost-map-delete-manual`（款级进价维护界面）→ `ae-handlers` 12→14）。
> → **189/185**（2026-10-10：−1 —— 删 `order-sku-rollup`（核对页页头指标条上"已配产品 N 个 · 供应商 M 家"
> 那一格的取数通道；用户判那排指标条"看不懂"⇒ 整条撤掉，该通道在渲染层与主进程都**零消费者**）
> → `order-handlers` 38→37；连带删 `product-db` 的 `resolveOrderSkuRollup` / `OrderSkuRollup` /
> `MAX_ROLLUP_ROWS`。见 `docs/notes/2026-10-30-order-classify-panel.md`）。
> → **190/186**（2026-10-10：「复制给厂家」+1 —— `write-clipboard-image`（渲染层把某一家的待拿货画成
> PNG dataURL → 主进程校验 `data:image/` 前缀 + 8MB 上限 → `nativeImage.createFromDataURL` +
> `clipboard.writeImage`）→ `main` 13→14。见 `docs/notes/2026-10-30-purchase-card-and-editor.md`）。
> → **190/186 不变**（2026-10-10 晚，**修复**：上一行的 `clipboard.writeImage` 在 v44 上**不存在**
> —— v44 已移除该窄 API，改正为 `clipboard.write([ClipboardItem + Blob])`；两条剪贴板通道从
> `main.ts` 外提到 `electron/clipboard-handlers.ts` ⇒ `main` 14→12、新增 `clipboard-handlers` 2。
> 见 `docs/notes/2026-10-30-electron-and-platform.md`）。
> → **191/187**（2026-10-10 夜：「拿货单明细表改列」+1 —— `purchase-style-images`（明细行图：按
> 「款编码 + 款色 + **尺码**」批量查本地图路径，复用 `order-db.findStyleColorImagePath` **单一实现**
> 〔拿货单 xlsx 导出早就用的同一个函数〕；渲染层再走既有 `orderImageThumbBatch` 出缩略图）⇒ `purchase-handlers`
> 24→25。见 `docs/notes/2026-10-30-db-schema-and-migration.md`）。
> ⚠️ **口径更正（2026-10-11）**：`size` 是 2026-10-11 补进来的**第三个键** —— 原先只按款色挑
> （`ORDER BY i.id DESC LIMIT 1`）会让同一款的所有行显示同一张图（用户报"拿货单明细的图片都是一样的"）。
> 通道数不变（191/187），缺省行为不变（不传 `size` 时与改前逐字一致）。
> 见 `docs/notes/2026-10-30-purchase-merge-and-images.md`）。
> → **192/188**（2026-10-12：+1 —— `order-reopen-corrected`（「发货台 › 归类核对」新增「退回待核对」：
> 把已核对的行放回待核对列表重做。此前写 `corrected` 的两条路〔保存 / 确认〕**都只写 1**，全仓没有一处写回 0
> ⇒ 核对完选错了款色**没有任何入口能回去改**。只翻 `corrected` 这一位、**不碰** `category`/`color`/`logo`，
> 且**刻意没有 `all` 分支**〔一次退回整批不可逆〕）⇒ `order-handlers` 38→39。
> 见 `docs/notes/2026-10-30-order-classify-panel.md`）。
> → **209/204**（2026-10-21 实测刷新；中间各步**未逐条补记**，以本节上表的实测快照为准）。
> 其中可点名的两轮：B2 包裹 +6（`order-parcel-{counts,detail,create,update,delete,set-line}`）·
> C1 运费接进利润 +1（`order-parcel-totals`，按单号批量读包裹运费汇总；`order-handlers` 已到 47）。
> 见 `docs/notes/2026-10-30-data-model-and-dependencies.md`、`docs/notes/2026-10-30-shipping-desk-and-rate.md`。
> → **207/202**（2026-10-21 C2 删表：**−4** `ae-cost-map-{list,import,upsert-manual,delete-manual}` ⇒ ae 11→7；
> 同期 **+2** `product-cost-set` / `product-priced-codes`（改价唯一写口 / 缺口卡判"还钉不钉得上"）⇒ product 26→28。净 −2）。
> 见 `docs/notes/2026-10-30-cost-maintenance-and-retire.md`。
> → **211/206**（2026-10-23 实测：净 +4 = `shop-accounts` +4 / `purchase` +1 / `shop-item` −1
> 〔删 `shop-items-update-sku`，采集段 SKU 退成只读〕。见 `docs/notes/2026-10-30-goods-sku-weight.md`）。
> → **212/207**（2026-10-23 同日第二次：**+1** `style-color-rename`〔产品侧改色名 → 订单域款色改标签，
> 图按款色 id 走〕，`order-handlers` 47→48。见 `docs/notes/2026-10-30-color-alias-and-merge.md`）。
> → **230/225**（2026-10-25 记账 P0：**+18** 条 `ledger-*` 全部落 `electron/ledger-handlers.ts`
> 〔相关人 / 科目 / 条目 / 分摊预览与方案 / 期初与承接 / 结算单 / 操作日志〕；台账 `bk_*` 十张表见 §6。
> 见 `docs/notes/2026-10-30-ledger-core-fixes.md`、`docs/plans/LEDGER_PLAN.md`）。
> → **234/229**（2026-10-26 记账 P4：**+4** 条 —— `ledger-entry-repatch-preview` / `ledger-entry-repatch`
> 〔变更相关人：预览数由服务端算，界面不复算〕、`ledger-shop-breakdown`〔单店取数〕、
> `ledger-export-excel`〔导出，主进程只画表存盘〕；**无表形状变更、无迁移步骤**。
> 见 `docs/notes/2026-10-30-ledger-parties-and-settlement.md`、`docs/plans/LEDGER_PLAN.md` §11）。

### 通道域划分（按前缀）

| 域 | 前缀 | 注册文件 |
|---|---|---|
| 通用/文件/窗口 | `get-*` `set-*` `open-*` `check-*` `read-file` `write-file` `save-*` `win-control` `backup-*` `reset-store` | `electron/ipc-handlers.ts` |
| 剪贴板 | `write-clipboard` / `write-clipboard-image` | `electron/clipboard-handlers.ts`（2026-10-10 从 `main.ts` 外提；v44 起写图走 `clipboard.write([ClipboardItem])` —— 别再用已删除的 `clipboard.writeImage`） |
| 网络 | `net-request` | `electron/ipc-handlers.ts` + `electron/http-client.ts` |
| 订单洞察 | `order-*` | `electron/order-handlers.ts` + `order-db.ts` |
| 拿货对账 | `purchase-*` | `electron/purchase-handlers.ts` + `purchase-db.ts`（`suppliers` 表的**管理入口**在「货与成本 › 供应商」；对账读侧留此。~~1.4.0 起供应商 CRUD 同时以窄域 `product-supplier` 暴露给产品库岛~~ —— 该岛 2026-10-01 下架，窄域随之删除） |
| 集中收件箱 | `mail-*` | `electron/mail-handlers.ts` + `mail-engine.ts` + `mail-db.ts` |
| **记账** | **`ledger-*`**（22 条） | `electron/ledger-handlers.ts` + `ledger-db.ts` + `ledger-xlsx.ts`（十张 `bk_*` 表；写侧只做守恒断言，分摊计算唯一实现在渲染层 `src/lib/ledger.ts`；导出表由渲染层传行与合计，主进程不复算） |
| 订单采集/成本衔接 | `ae-*` | `electron/ae-handlers.ts` + `ae-db.ts`（`ae-engine.ts` 已于 2026-10-15 删除：唯一消费者「利润统计」页早随 C9 收编并入宿主「算钱」，利润口径在渲染层 `src/lib/orderCost.ts`） |
| 店铺账号 | `shop-account-*` + **`tool-account-*`**（list / upsert / reveal / delete，2026-10-22 物理合并新增：紫鸟 / ERP 登录独立成行，密码明文只从 `tool-account-reveal` 出） | `electron/shop-accounts-handlers.ts` + `shop-accounts-db.ts` |
| **店铺实体（S1）** | **`shop-*`** | `electron/shop-handlers.ts` + `shop-db.ts`（+ 纯函数 `shopName.ts`）。⚠️ 与上面那行的 `shop-account-*` 是**两个不同的域**，前缀只差一段——`shop-list` 属店铺实体、`shop-account-list` 属账号库，改名时别混 |
| 企业管理 | `company-*` | `electron/company-handlers.ts` + `company-db.ts`（企业 + 欧代/土代/德国包装法） |
| **产品库** | **`product-*`** | `electron/product-handlers.ts` + `product-db.ts`（主数据 + 导入导出 + **「店铺商品ID → 产品」映射与关联**）。视图侧 = **内建「货与成本 › 产品」**（原 UI 岛已于 2026-10-01 下架，通道未改） |
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
| `appearance` | `theme`（`light` / `dark` / `system`；`src/core/services/theme.ts`，非模块私有） |
| `order-cost` | 利润页 UI 态：`platformFeeRatePercent`（平台费**近似费率**，2026-09-29 加；缺省 0 = 未配 → 不扣并全局提示"平台费未扣"）+ `shopPick` / `sourceFilter` / `taxDefault`（2026-10-22 按 `OrderCostView.vue` 的 `savePrefs()` 补全 —— 这三个也是已落盘键，删改会丢用户查询偏好） |
| `excel-copy` | 记录列表 / 模板配置 / 字段规则 / 显示列（`ui-plugins/excel-copy` 岛声明） |
| `ledger` | 记账页的界面偏好（`src/modules/ledger/useLedger.ts` 的 `useModuleStorage('ledger')`）：查看月份 / 八项筛选 / `lastParty`（收入、支出各自上次选的相关人）/ `tab`（`明细` / `往来` / `单店` / `汇总` 四值，2026-10-26 P3 新增首个、P4 扩到四个；旧偏好缺该字段或值不在四值内时回落 `detail`）/ `shopId`（单店页上次看的那家店，与明细页的「店铺」筛选**分开存**：一个是"筛账"、一个是"看店"；若那家店已被删除，取数显式报「店铺不存在」，不静默换成别家）。⚠️ **业务数据一律在 SQLite `bk_*` 表**，这里只放"下次进来还停在哪儿" |
| `order-insight` | **键名保留（岛已下架）**：引擎配置（`engine`）+ 四个列名 + 两个透视维度 —— 宿主「设置 › 识别」写入、内建「今天 › 归类核对」读取。⚠️ **名字沿用原岛 id 是有意的**：它是已落盘的用户数据键，改名 = 用户配好的 Key 与列映射静默消失 |
| `shop-accounts` | 店铺账号家的 UI 状态（视图模式 / 分组维度 / 当前页签 / 邮件轮询偏好）。2026-10-14 之前写入方是 UI 岛（`manifest.capabilities[storage].namespaces`），**现在写入方是内建模块**（宿主模块走 `useModuleStorage` 本来就不需要声明）—— **键名与命名空间一字未改**，所以搬迁后老配置自动生效 |
| `shop-accounts-mail` | **邮件模块的持久状态**（`src/modules/mail/mailStore.ts`）：邮箱账号 / 同步游标 / 附件索引 + `prefs`。⚠️ **2026-10-17「邮件」从「基础数据」页签独立成一级模块时刻意沿用此键** —— 改名等于让老用户收件箱"变空" |
| `quick-note` | 便签内容（`notes: Note[]`；`QuickNoteView.vue` 经 `useModuleStorage('quick-note')` 持久化，2026-10-22 按代码订正） |
| ~~`ae-profit`~~ | **已退场（2026-09-30，C9 收编）**：原「利润追踪」岛声明，三页签并入宿主「算钱」后本岛不再声明 `storage`（只剩接收端状态）。旧数据仍留在 `config.json` 里，无人读写、可忽略 |
| `shipping-rate` | **已由岛转为内建页面同用**（岛本身 2026-10-15 下架）：内建「基础数据 › 物流运费」（`src/modules/shop-accounts/shipRateStore.ts`）**刻意沿用同名命名空间** `useModuleStorage('shipping-rate')` —— 空间键未变 ⇒ 升级后旧岛存下的查询偏好（克重 / 类别 / 变体 / 进位方式 + `lastFile` / `sheetNames` / `candidates`）**无缝接续**，不必迁移也不必清空。⚠️ **运价表本身两代都不在此** —— 真源是宿主表 `sr_rate_snapshots`（按生效日留档，"算钱"按订单日期取当时那份），界面只读最新那一份用于显示，计价一律宿主自取 |
| `plugins` | 插件停用集 |

> 外置插件 / UI 岛能写哪些命名空间由 manifest 的 `capabilities[storage].namespaces` 决定：声明了就必须命中，
> 未声明则默认只放行插件自身命名空间（`src/core/plugin/security.ts`）。因此**新增一个用 storage 的岛 = 新增一个命名空间**，
> 本节清单应随岛的 manifest 同步刷新。内建侧的命名空间不止"模块私有"一类：除 `app-shell`（外壳状态）与 `plugins`（插件停用集）外，还有 `appearance`（主题偏好，`src/core/services/theme.ts`）和 `shop-accounts-mail`（邮件账号 / 同步游标 / 附件索引，`mail` 模块刻意沿用原页签的键）。
> `quick-note` **占命名空间 `quick-note`**（便签内容持久化，`QuickNoteView.vue` 的 `useModuleStorage('quick-note')`）—— 2026-10-22 按代码订正，此前"随会话存在、重启即失"的记法已过时。
> 下记**不迁移**命名空间：内建与同名岛共用 `modules.<id>`，这正是"配置自动继承"的实现方式（见 §4）。
>
> ⚠️ 命名空间清单的权威来源仍是代码（`grep useModuleStorage src/`）与本表；`AGENTS.md` §1.4 于 2026-10-22 已同步到同一份清单，两处别再各写一套。
> 旧扁平 key（`records` / `templateConfigs`）仅由主进程做一次性迁移探测，**禁止新增**。

### SQLite（**单库** `userData/sellerkit.db`，按域分**表**）

> ⚠️ 本节原先写作「分域 db 文件」，措辞与事实不符：**库只有一个**（`electron/db.ts` 的 `initDb()`，
> 全仓唯一连接，`DEFAULT_FILE_NAME = 'sellerkit.db'`），分域的是**表**。2026-09-24 按代码修正。
> 逐表字段与"读写在哪个功能"的完整盘点见 [`../plans/DOMAIN_INTEGRATION_PLAN.md`](../plans/DOMAIN_INTEGRATION_PLAN.md) §1.2。

| 定义文件 | 表 |
|---|---|
| `electron/mail-db.ts` | `sk_mail_accounts` · `sk_mail_messages` · `sk_mail_bodies` · `sk_mail_attachments` · `sk_mail_folders` · `sk_mail_attachment_cache` · `sk_mail_meta`（KV）· `sk_mail_fts`（**FTS5 虚拟表**，rowid = `sk_mail_messages.id`） |
| `electron/order-db.ts` | **`oi_orders`**（订单主表，一单一行，`order_no UNIQUE`）· **`oi_order_items`**（订单明细，一 SKU 一行；**`id` 保留拆表前旧行 id**，2026-10-21 B1 拆表）· **`parcels`** · **`parcel_lines`**（包裹与拆包明细，B2）· `oi_images` · `oi_styles` · `oi_style_colors` · `oi_style_fingerprints` · `oi_color_aliases`（`oi_queue` 已于 2026-10-28 删除，v11 迁移 `DROP TABLE`）。⚠️ 两张订单表的列分别由 **`ORDER_HEADER_COLS`** / **`ORDER_ITEM_COLS`** 数组拼出（新库建表与 `schema:smoke` 列序自校验同一来源），解析后的列序导出为 **`ORDER_TABLE_COLUMNS`** / **`ORDER_ITEM_TABLE_COLUMNS`**。`ORDER_LEGACY_SPINE_DDL` 是 v3 迁移重建时用的**冻结旧形状**，不是稳态表 |
| `electron/purchase-db.ts` | `suppliers` · `purchase_orders` · `purchase_items` · `purchase_sources` · `payments` · `purchase_ignore` |
| `electron/ae-db.ts` | `ae_rates` · **`ae_settle_lines`**（**结算明细**，2026-09-29：AE 后台「订单明细」导出 → 一表两粒度，`line_type` 区分**商品行**与**订单级行**（后者 `item_id` 空，是**整单**口径含买家付的运费）→ **两类行不可相加**；费用按 JSON 科目存，加科目零 ALTER；幂等键 `(order_no, item_id, sku_id)`）。⚠️ `ae_cost_map`（款级区间价目表）**已于 2026-10-21 删除**（C2：成本改为产品当前价 + 订单行两字段，`order.main` v10 删表）；`ae_orders` / `ae_order_lines` / `ae_fees`（旧采集落库）**已于 2026-10-15 删除**（C1 合并后零写入，采集只写 `oi_orders`） |
| `electron/product-db.ts` | `pl_products`（产品/款式主数据，P1；`image_id` 列 1.2.0 `ALTER` 增补，幂等判定 `PRAGMA table_info`）· **`pl_shop_sku`**（「店铺商品ID → 产品」映射 + 「商品清单」池，P3；UNIQUE **`(platform, shop_id, item_id, spec, product_id)`** —— 含 `product_id` 是**一对多（套装）的前提**，老库由版本化迁移归一，见下「schema 演进」；`shop_id` 外键 → `sk_shops`；**2026-10-05 起 `spec` 承载「颜色」**（`'*'` = 未指定，一期恒 `'*'` 的时代结束）—— 归款 `autoAssignByMap` 的颜色顺序是**映射色 → 订单原文色 → `未分类`**，`variant_id` 由写库时按 `(product_id, 色)` 反查填（0 = 该色还没录变体）；`pickingRows` 的 `color` 回落**款色 → 订单原文**。见 `docs/notes/2026-10-30-mapping-color-and-replay.md`；
**2026-10-10 起「改色 = 改同一条绑定」**（该商品名下属同一产品恰好一条手动行 → `UPDATE` 它的 `spec`，否则 `INSERT`——旁留的旧行永远命中不了却出现在映射列表里；「同产品」限定使同商品多色绑不同产品仍可新增），且 `reassignOrdersByItemIds` 回填范围扩为「未归款 ∨ 占位色 `未分类`」（挂在**真实颜色**上的图一律不动），用户由此可在「货与成本 › 商品ID 映射」改绑选色自助补色。见 `docs/notes/2026-10-30-mapping-color-and-replay.md`）· `pl_variants`（SKU 子表：name/code/**weight_g**/status，1.2.0；`color`/`size` 列 1.3.0 `ALTER` 增补——服装「颜色+尺码」组合，成对时 name 自动生成，编码部分唯一索引 `WHERE code <> ''`）· `pl_images`（产品图，`fingerprint` UNIQUE = SHA-256）· `pl_item_images`（商品ID覆盖图，`item_id` PK 经归一存储）—— 后三张 1.2.0 |
| `electron/shop-item-db.ts` | **`pl_shop_items`**（**店铺商品快照**，2026-10-13：**采集而来 = 平台事实**，只存「店里有什么」、不认款（认款写路径永远走 `pl_shop_sku`，两套不互写）；唯一键含 `store_key`（两家未登记店采到同一商品不互相覆盖）；`shop_id` 软关联 `sk_shops`，认不出 → 0 + `store_key` 展示，**绝不自动建店**。见 `docs/plans/AE_SHOP_ITEM_SYNC_PLAN.md`）· **`pl_shop_store_keys`**（采集帧「展示名键 → 已登记店」的收养记忆，治"收养只跑一次、之后再采又落未登记桶"） |
| `electron/shop-accounts-db.ts` | **无自有表**（2026-10-22 物理合并）：本层是 `sk_shops` **账号列** + `sk_tool_accounts` 的读写面，表 owner 是 `shop-db.ts`（建表 / 迁移 / 店铺侧局部写入）。原持有的 `sk_shop_sets` 已随物理合并退役（2026-10-29 起 `shop.main` v2 幂等清表）—— 账号与店铺合成一行，`CHECK (trim(name)<>'' OR trim(email)<>'')` 允许"纯店铺 / 纯账号 / 两者都是"三种行共存一张表 |
| `electron/shop-db.ts` | **`sk_shops`**（**店铺 + 店铺账号单表**，2026-10-22 物理合并：身份列 `platform/name/name_key/platform_shop_id/shop_url/shop_url_raw/site/status/opened_at/tags/note` ＋ 账号列 `email/company_id/ziniao_account_id/erp_account_id/secret_enc/secret_keys`；记分 `score`（REAL NOT NULL DEFAULT 0，0 = 未记录，不参与匹配 / 筛选；2026-10-23 新增，老库由 `shop.columns` v1 补列）；保证金到账 `deposit_received_at`（TEXT NOT NULL DEFAULT ''，YYYY-MM-DD，仅在「退店」行的列表里展示；2026-10-25 新增，老库由 `shop.columns` v2 补列）；状态四态 启用 / 停用 / 封店 / 退店（`SHOP_STATUSES` 唯一来源，老账号的 `banned`/`closed` 在合并时映射为封店 / 退店）。**唯一性一律走部分唯一索引**（表级 `UNIQUE(platform, name_key)` 会让纯账号行撞空店名）：`uq_sk_shops_platform_name` `WHERE trim(name_key)<>''` · `uq_sk_shops_email` 建在 `lower(email)` `WHERE trim(email)<>''` · `idx_sk_shops_platform_sid` `WHERE platform_shop_id<>''`；另一条 `CHECK` 钉住「有店名必有归一键」）· **`sk_tool_accounts`**（紫鸟 / ERP 登录，`kind CHECK IN ('ziniao','erp')`、`UNIQUE(kind, account_key)`、`password_enc BLOB` **列表只带 `has_password` 徽标**，明文唯一出口是 `revealToolAccountPassword(id)`（店铺侧凭证同理：明文只走 `revealShopAccountSecret`）、`CHECK (trim(account)<>'')`）—— 一条登录管多店，店铺行只存 `ziniao_account_id` / `erp_account_id` 外键，**新增店铺不再重填密码** · **`sk_name_map`**（名称归一映射，UNIQUE `(kind, raw_key)`；`kind` 预留 `supplier`/`style`/`product`）—— ADR-002 S1，2026-09-27。邮件侧 `sk_mail_accounts.shop_id` 已由 `sk_shop_sets(id)` 改指 **`sk_shops(id) ON DELETE CASCADE`**（删店铺行 → 邮件账号与本地邮件缓存一并清除，确认框已明说）。裁决见 `docs/decisions/ADR-003-shop-account-physical-merge.md` |
| `electron/company-db.ts` | `sk_companies` · `sk_company_profiles`（企业管理：欧代 / 土代 / 德国包装法） |
| **`electron/ledger-db.ts`** | **记账域 `bk_*` 九张**（2026-10-25，迁移键 `ledger.main` v1）：`bk_parties`（资金相关人，`name_key` 唯一，只提供停用 / 合并、**不物理删除**）· `bk_categories`（科目，`kind IN ('income','expense')` 建表定死、两套各自独立）· **`bk_entries`**（收支条目：金额恒为**正整数分**、方向只由 `kind` 表达；`period` 是 SQLite **生成列** `substr(biz_date,1,7) STORED`）· **`bk_allocations`**（公共条目的分摊行 = **派生数据**，无业务写入口；`Σ分摊 == 条目金额` 由主进程断言，不满足整笔回滚）· `bk_allocation_rules`（分摊方案：名称唯一、基准三选一、店铺 id 与万分比存 JSON；2026-10-26 接 UI —— 下拉套用 / 保存为方案，条目 `rule_id` 只作来源留痕）· **`bk_settlements`** / **`bk_settlement_lines`**（结算单与明细；唯一性靠**部分唯一索引** `UNIQUE(entry_id) WHERE active=1` 才允许撤销后重结）· `bk_transfers`（承接余额）· `bk_op_log`（改挂 / 合并等操作留痕）。结算状态**不双写**在条目上，由结算行 JOIN 得出。⚠️ `bk_periods`（月结留位表）2026-10-29 已退役（`ledger.main` v4） |
| `electron/db.ts` | `sk_schema_migrations`（**迁移记账表**，非业务表：`key` 主键 = 域名，`version` = 已应用到的版本，见下「schema 演进」） |
| `electron/ship-rate-db.ts` | **`sr_rate_snapshots`**（**运价表快照**，2026-09-29：一次导入 = 一条，`content_key` UNIQUE 按内容去重，`effective_from` = 导入当日；算账时按订单日期取"当时那份" → 历史预测可复算。ADR-002 C3 要求运价表挂宿主中立层） |

稳态共 **53 个对象**：**50 业务表** + 2 内部表（`sk_mail_meta` KV、`sk_schema_migrations` 记账）+ 1 FTS5 虚拟表（`sk_mail_fts`）。
（2026-10-29 由 `npm run db:inventory` 实测复核：相对 10-25 的 50 / 47 **净 −2 张表** —— 退役 `sk_shop_sets`
（历史账号套装，`shop.main` v2 清表）与 `bk_periods`（月结留位表，`ledger.main` v4 清表），见
`docs/notes/2026-10-30-db-schema-and-migration.md` §8。）

> **怎么数（唯一可信来源 = 真建出来的库，别再手抄 grep 推算）**：`npm run db:inventory`
> 建一个临时库、逐域调 `ensure*Schema()`，把**新库直建的稳态形状**按域归属打印出来（`electron/*.ts` 里
> 有 `CREATE TABLE` 写在模板串、写在函数名里、写在校验注释里，grep 一律数不清 —— 2026-10-22 那次
> `sk_shops` 改成 `shopTableSql()` 模板拼出后，grep 口径直接少一张表就是导火索）。
> 脚本口径：`INTERNAL`（KV + 记账表）单列不计业务表；FTS5 的 5 张影子表折成 1 个虚拟表；
> 任一 ensure 抛错即 `exit 1`（迁移期临时表、冻结 DDL 天然不会出现，因为它们不在稳态形状里）。
> ⚠️ 口径陷阱（首跑即中招，已在脚本注释里钉住）：**FTS5 本体在 `sqlite_master` 里是 `type='table'`**，
> 只滤 5 张影子表会让它同时进「表」与「FTS5 虚拟表」两栏 → 多算 1（首跑报成 41 / 38）。
>
> ⚠️ **别用 `sqlite_master` 的 `type='table'` 条数核对本节**：口径不同。真实库还会多出
> 5 张 FTS5 影子表（`sk_mail_fts_{config,content,data,docsize,idx}`）与 SQLite 自建的 `sqlite_sequence`
> （只要有 `AUTOINCREMENT` 就有）。实测某存量库：`type='table'` = 36 = 当时口径 31 张可见表 + 5 影子表，
> 且该库尚未跑过 S1/P3/1.2.0、缺 `sk_shops` / `sk_name_map` / `pl_shop_sku` / 1.2.0 三张。
>
> 重数历史：2026-09-27 三次订正 —— 上一版的「25 业务表 / 27 个对象」既漏了 `pl_products` / `pl_item_weights`
> 与 S1 两张新表，自身枚举逐行相加也不自洽；S1 后为 30 / 32，P3 加 `pl_shop_sku` 后为 31 / 33，
> 1.2.0 加 `pl_variants` / `pl_images` / `pl_item_images` 后为 **34 / 36**；
> 2026-09-29 加迁移记账表 `sk_schema_migrations` 后为 **34 业务表 / 37 个对象**；
> 同日再加运价表快照 `sr_rate_snapshots` 后为 **35 业务表 / 38 个对象**；
> 同日再加结算明细 `ae_settle_lines` 后为 **36 业务表 / 39 个对象**。
> **2026-10-15 重数订正为 33 / 36**（三处变动一次结清，逐条可复跑）：
> ① **−3**：`ae_orders` / `ae_order_lines` / `ae_fees` 三张弃表（C1 合并后零写入的孤儿表）随 `ae.main` v3 删除，
>    详见 `docs/notes/2026-10-30-db-schema-and-migration.md`；
> ② **−1**：`pl_item_weights`「商品ID → 克重」于 2026-10-01 随克重链收口删除（克重只属 SKU）—— 上一版漏记；
> ③ **+1**：`pl_shop_items`（店铺商品快照，2026-10-13）—— 上一版漏记（上一版枚举里也没有这一行）。
> **2026-10-21/22 重数订正为 37 / 40**（B1/B2 落地 + 补齐两处旧漏记 + C2 删表，逐条可复跑）：
> ① **+3**：B1 拆表新增 `oi_order_items`；B2 包裹新增 `parcels` / `parcel_lines`；
> ② **+2**：上一版漏记 `oi_color_aliases`（平台色名 → 自家色名，产品级）与
>    `pl_shop_store_keys`（采集"展示名键 → 已登记店"的收养记忆）；
> ③ **−1**：C2 删除 `ae_cost_map`（2026-10-21，写口/读侧/通道一并退役）。
> ④ 口径补充：`ORDER_LEGACY_SPINE_DDL` 与 `COST_MAP_DDL` 都是**迁移期冻结 DDL**，**不计入稳态**
>    —— 与 `purchase_items_new` / `pl_shop_sku_legacy_struct` 同一条计数纪律。
> **2026-10-25 重数订正为 47 / 50**：① **+10**：记账域 `bk_parties` / `bk_categories` / `bk_entries` /
>    `bk_allocations` / `bk_allocation_rules` / `bk_settlements` / `bk_settlement_lines` / `bk_transfers` /
>    `bk_periods` / `bk_op_log`（`electron/ledger-db.ts`，`ledger.main` v1）；
>    ② **脚本修正**：`scripts/db-inventory.cjs` 的 `DOMAIN_FILES` 补入 `ledger-db` —— 不补的话它只数到 40，
>    而 40 是**漏数**，不是"记账还没建表"。
> ⚠️ 上一版（2026-10-21 记 38 / 41）在算总账时**漏减 ③ 的 −1**，且只列了一处冻结 DDL；
> 2026-10-22 本轮按源码逐行重数订正为 **37 / 40**。
> **2026-10-22 同日：手抄推算退役**，改由 `npm run db:inventory` 从真建出来的库数（见上「怎么数」）；
> 同日店铺与账号物理合并为**净 0 张表**（−`sk_shop_sets` + `sk_tool_accounts`），故 **37 / 40 未变**。
> **2026-10-29 重数订正为 50 / 53**：退役两张"生产代码零引用"的表 —— `sk_shop_sets`（历史账号套装）
> 与 `bk_periods`（月结留位表，`bk_*` 由十张变九张）；口径仍以 `npm run db:inventory` 实测为准。

### schema 演进（版本化迁移，2026-09-29）

**两条通道，职责不可互相替代**（`electron/db.ts`）：

| 机制 | 做什么 | 何时用 |
|---|---|---|
| `dbMigrate(statements)` | 幂等 DDL（`CREATE TABLE/INDEX IF NOT EXISTS`），每次 ensure 都能跑 | **新库**一次建到当前形状 |
| `migrate(key, steps)` | 版本化**演进**（补列 / 重建表 / 改唯一键 / 搬数据），只跑未应用的版本 | **老库**追上来 |

- 记账表 `sk_schema_migrations(key, version, applied_at)`，**按域 key 分别记版本**（各域仍自己拥有 schema，不共用一个全局版本号）。
- 步骤定义在各域（如 `product-db.ts` 的 `skuMigrationSteps()`），版本号域内从 1 起、升序；同一域的待应用步骤**同一个事务**，任一失败整体回滚。
- **顺序：`ensureXxxSchema()` 内先 `migrate()`、再 `dbMigrate(SCHEMA)`**（house convention）。理由：重建表
  会把旧索引跟着老表一起带走，索引统一由末尾的 `dbMigrate` 补（新库也走同一条路）。
  **代价必须自己挡**：迁移跑在表可能存在之前，故**每一步都要处理"表还不存在"**（新库路径）——
  漏了会在全新库上 `ALTER` 一张没有的表而报 `no such table`（2026-09-29 实测：本冒烟的 [B] 场景正是抓这个）。
- **为什么必须有**（2026-09-29 实测教训）：`pl_shop_sku` 的唯一键在一对多改造时由 4 列扩成 5 列，
  而 `CREATE TABLE IF NOT EXISTS` **不会重建老库** → 老库 4 列键、新库 5 列键；代码里对旧形状的假设
  （`ON CONFLICT(platform, shop_id, item_id, spec)`）在**新库上必失败、在老库上看不出来**。
  形状差异只能靠一次性迁移收敛，幂等 DDL 永远收敛不了。
- 当前已登记：`product.sku` = **v2**（v1 补 `image_url`/`imported_at`；v2 把 `pl_shop_sku` 的唯一键归一到含 `product_id` 的 5 列）；
  `order.main` = **v10**（v1 补 `oi_orders.order_time/status/corrected` + `oi_images.style_color_id`；
  v2 补金额/状态/时点列；**v3 = 归一为唯一订单主干**：重建 `oi_orders`（`image_id` 改可空 + `source`/`qty` + 删 8 个零读者列）·
  `oi_styles` 去哨兵列 `name`（名字先交接进 `pl_products`）· 追平 `sqlite_sequence`）——「重建存量表的三个坑」见 `docs/notes/2026-10-30-db-schema-and-migration.md`；
  **v4 = 历史采集单回填主干**（2026-09-30，C9' 的前置）：老采集表 `ae_orders`/`ae_order_lines` 里的单按
  `source='collect'` 灌进 `oi_orders`（口径用**实时采集同一组原语**：`electron/aeMoney.ts` 的收入/汇率 + `upsertCollectedOrder`），
  `raw_fields` 保真原帧并带 `__migratedFrom='ae_orders'` 可回滚标记；**v4 只做加法、不删老表**；
  表不存在（新库）时整步跳过——`scripts/schema-migration-smoke.cjs` 场景 [E] 专测（含幂等与"金额按汇率折分"）；
  v5 从报表规格串补平台色名（只补空）· v6 `oi_orders` 加 `style_color_id` 并从块内件数回填 `qty` ·
  v7 加行级快照 `weight_g` / `cost_cents`（NULL = 未算）；
  **v8 = B1 拆表**（2026-10-21）：旧 `oi_orders`（一行=订单×图）重建为 `oi_orders`（一单一行，
  `order_no NOT NULL UNIQUE`）+ `oi_order_items`（一 SKU 一行）。**关键不变量：明细 `id` 原样保留
  旧 `oi_orders.id`**（包裹明细 / 采购来源等以行 id 为键的下游零迁移）；主表订单级字段取同单
  `MIN(id)` 那行；旧空单号行各自成单（`__empty__||id`，不并、不丢）；**同款合并不在迁移里做**
  （物理层保留 SKU 粒度，汇总层 `GROUP BY`）。真实库克隆对照与写入口约定见
  `docs/notes/2026-10-30-order-table-and-model.md`；`schema:smoke` 场景 C/G 专测（拆表数据 + 两表列序）；
  **v9 = C2 成本两字段**（2026-10-21）：明细加 `actual_cost_cents`，存量 `cost_cents`（全是拿货实付）
  搬进它并把 `cost_cents` 清空成「进价（预估）」，再按下单日期从旧 `ae_cost_map` 回填预估
  （未归类/无区间留 NULL）、从拿货单补一次实付、把价目表每款最新价镜像进 `pl_products.cost_cents`；
  `schema:smoke` 场景 [H] 钉住搬 / 回填 / 只补空 / 幂等。两字段语义与判据见
  `docs/notes/2026-10-30-cost-maintenance-and-retire.md`；
  **v10 = 删旧价目表**（2026-10-21，C2 收尾）：`DROP TABLE IF EXISTS ae_cost_map`。**必须挂在订单域**、
  紧跟 v9 —— 两个域 schema 懒初始化顺序不定，放 ae 域可能先于 v9 回填执行；v9 的读取已能容忍
  "表还是 v1 之前的形状"（缺 `effective_from` 时按哨兵日处理），冒烟 [D]/[D2]/[H] 三处钉住；
  `ae.main` = **v3**（v1 `ae_cost_map` 改「多行 + 生效区间」复合主键并重建表；
  **v3 = 删弃表 `ae_orders` / `ae_order_lines` / `ae_fees`** —— C1 合并后零写入的孤儿表，冒烟场景 [D] 专测；
  原 v2「补 `ae_order_lines.style_code`」随该表删除而移除，故步数为 2、版本号到 3）
  —— 2026-09-29 把本域**转换**到版本化迁移（原先散在 `ensureAeSchema` 里的两个幂等函数），
  同时把 `style_code` 补进建表语句（原先只写在迁移里 → 迁移先跑后新库会永久缺列，
  与 `oi_images.style_color_id` 是同一个坑——该坑位随 `ae_order_lines` 退场，纪律本身仍适用于所有新列）；
  `purchase.main` = **v1**（删 `purchase_orders.note` —— 零读者列，不进导出/对账/成本；SCHEMA 同向删除，
  冒烟场景 [F] 专测；裁决与判据见 `docs/notes/2026-10-30-purchase-card-and-editor.md`）；
  `ledger.main` = **v4**（2026-10-25 记账域首版：九张 `bk_*` 表由 `SCHEMA` 一次建到当前形状；
  **v1 是形状基线的空步骤**，只把版本号写进账本、给后续步骤一个起点 → v2 结算支持互抵结清
  （`direction=offset`）· v3 `bk_parties.merged_to`（区分「已并入」与「手动停用」）·
  **v4 退役月结留位表 `bk_periods`**（2026-10-29，`DROP TABLE IF EXISTS` 幂等，产品不做月结，
  见 `docs/notes/2026-10-30-db-schema-and-migration.md`）。后续补列 / 重建一律在此追加版本步骤，
  别再往 `CREATE TABLE IF NOT EXISTS` 里"以为老库会跟上"。
  ⚠️ 域内两条结构约定：`bk_entries.period` 是**生成列**（主进程 `rootDir=electron` 无法 import `src/lib`，
  避免两份 `slice(0,7)`）；结算行唯一性用**部分唯一索引** `UNIQUE(entry_id) WHERE active=1`（内联 UNIQUE 会让撤销后永远结不了）。
  口径与三处纠错见 `docs/notes/2026-10-30-ledger-core-fixes.md`；
  `shop.main` = **v2**（2026-10-22 店铺与账号**物理合并**；2026-10-29 合并迁移退役）：历史 v1 做过
  老 `sk_shops`（表级 `UNIQUE(platform, name_key)`）重建为「店铺 + 账号单表」并把 `sk_shop_sets`
  的账号行**搬进来后删表**、紫鸟 / ERP 从"每店重填一遍"抽成独立 `sk_tool_accounts`、
  `sk_mail_accounts.shop_id` 外键目标由 `sk_shop_sets(id)` 改指 `sk_shops(id) ON DELETE CASCADE`
  （SQLite 改不了外键目标，`RENAME COLUMN` 也不行 → 邮件表必须一起重建）。裁决见
  `docs/decisions/ADR-003-shop-account-physical-merge.md`，落地记录见
  `docs/notes/2026-10-30-shop-account-merge-and-status.md`。项目尚未正式发布、没有要升级的存量库，
  新库由 `SCHEMA` 一次建到当前形状，故**整表合并整段退役**：**v1 保留空步骤占位**
  （跑过合并的开发机账本记的是 1，跳过 v1 才轮到 v2），**v2 只做 `DROP TABLE IF EXISTS sk_shop_sets`**
  —— 幂等清掉开发机老库的历史残留，新库上执行为空操作（见 `docs/notes/2026-10-30-db-schema-and-migration.md`）。
  ⚠️ **本域是「先 `dbMigrate(SCHEMA)`、再迁移、最后 `dbMigrate(INDEXES)`」** —— 与上面 house convention
  的先后**相反**，且是被实测逼出来的：`INDEXES` 里的 `idx_sk_name_map_ref` 指向 `sk_name_map`，
  迁移收尾就建索引时老库第一次启动会 `no such table: main.sk_name_map`（2026-10-22 由 `shop-item` 冒烟抓到）。
  `CREATE TABLE IF NOT EXISTS` 对已存在的老表一个字都不改，所以"先建"不会把迁移该改的形状抢走。
  两个键都走标准 `migrate(key, steps)`（`shop.main` 2 步、`shop.columns` 2 步）；`shop.main` 的 v1
  空步骤只用于对齐开发机账本里已记的版本号，没有"已合并即短路"的分支。
  `shop.columns` = **v2**（2026-10-23 v1 给 `sk_shops` 补 `score` 记分分值；2026-10-25 v2 补
  `deposit_received_at` 保证金到账时间，仅退店行展示）：**独立键**，与 `shop.main` 的版本号互不影响；
  步骤用 `PRAGMA table_info` 幂等探测后 `ALTER TABLE ADD COLUMN`
  （新库的 `shopTableSql` 已含这两列，步骤只记账）。本域顺序固定为
  `SCHEMA` → `shop.main` → `shop.columns` → `INDEXES` —— 补列必须排在 `shop.main` 之后，
  否则补在即将被替换的旧表上。
- ⚠️ **纪律（2026-09-29 被冒烟抓到）**：**新增列必须同时写进 `CREATE TABLE`（`SCHEMA`），迁移只负责老库**。
  原因：迁移先跑（house convention），新库上表还不存在 → 步骤只能跳过；此时版本已被记账，
  于是"只写在迁移里"的列在**全新库上永远补不上**。
  实测案例：`oi_images.style_color_id` 原先只写在 `migrateColumns()` 里，改成迁移先跑后
  `style:smoke` 13 项全红（`no such column: i.style_color_id`）。同理，**新增列必须给 `NULL`/无默认**
  的金额列留出"未知"语义时，别写 `DEFAULT 0`。
- ⚠️ **删列是该纪律的镜像（2026-10-10，`purchase.main` v1 首个实例）**：`SCHEMA` 与迁移必须**两处同向删**
  —— 只删一处会让老库/新库形状分叉（`IF NOT EXISTS` 对已存在表一个字都不改）。步骤用 `PRAGMA table_info`
  探测、无列即跳过（迁移跑在表可能存在之前）；**删列后必须实测建单/读写路径**（列删了但 SQL 还引用它 ⇒
  老库上必抛，同 `oi_styles.name` 的删法事故）——冒烟场景 [F] 的"新库直建无 note"一条专抓分叉。
- 冒烟：`npm run schema:smoke`（`scripts/schema-migration-smoke.cjs`）—— 造一个**老库形状**的库，
  断言数据一条不丢、索引没丢、唯一键已升级、`AUTOINCREMENT` 序列已重置、幂等可重跑，并断言新库走"跳过重建"那条路。
  为什么单独成冒烟：老库/新库的形状差异**在全新库上永远复现不出来**。

> 三条相关事实：`oi_images.style_color_id` 由 `ALTER TABLE` 增列、**无外键约束**（只建了索引），存在悬挂可能；
> `ae_ops_costs` / `ae_sync_log` 在 `docs/features/PROFIT_TRACKER.md` §5 中列出但**尚未实现**（属 M2 范围）；
> `electron/db.ts` 只建**迁移记账表** `sk_schema_migrations`（2026-09-29 起；此前它确实一张表都不建），
> 业务表全在各域文件里；它本身是连接单例 / 幂等迁移 + 版本化迁移 / 事务复用层。

### 其他存储

| 位置 | 内容 |
|---|---|
| `localStorage.sk_auth_token` | 会话 token（`src/core/network/token.ts`） |
| 系统安全存储（Keychain / DPAPI） | 店铺账号密码、IMAP 授权码 |

### 设置页分类（`SettingsModal` 左侧导航）

**分类一律由"贡献"生成**（`AGENTS.md` §1.5）：基础两个固定，其余来自三类贡献，同一队列按 `order` 升序。

| 分类 | 来源 | 内容承载 |
|---|---|---|
| `general`「通用」 | 固定（order 0） | 关于 / 外观以外的通用项 |
| ~~`recognition`「识别」~~ | ~~`src/core/settings/panels.ts`~~ | **已于 2026-10-28 删除**：整条链路（`src/core/ai` / 设置页 / `order-api-key-*`）自 2026-10-05 起零调用方，且用户已决定不接云端模型。`panels.ts` 现在导出空数组（保留出口与构建键 `core`）。判断见 `docs/notes/2026-10-30-order-classify-panel.md` |
| 插件包贡献 | `extensions/<id>/src/settings.ts` 的 `settingPanels`（order 默认 100；**当前无实例** —— 目录已于 2026-09-30 C3 删除） | 宿主内 Vue 组件 |
| 岛贡献 | `ui-plugins/<id>/manifest.settings`（order 默认 100） | `sk-plugin://` iframe 岛页 |
| `plugins`「插件」 | 固定（order 999） | 插件中心（已安装 / 市场 / 权限审计） |

> ⚠️ **新增宿主自有设置不要往 `SettingsModal.vue` 里塞硬编码分类**：写一个面板组件 + 在
> `src/core/settings/panels.ts` 加一项即可（`vite.config.ts` 会把它生成进 `settingsPanelLoaders`，键 `core`）。
> 真机守卫：`npm run plugins:island:smoke` 的「设置贡献」段（断言「识别」分类可达且面板渲染）。

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
| `plugins:island:smoke` | **UI 岛逐岛点击冒烟**（隔离 userData + CDP，断言每个岛桥握手与首屏；2026-09-30 起加两段体检：**工具条文案体检**（读宿主 `.ui-island-bar` 可见文本，断言无内部术语（桥/握手/权限门/realm/iframe/L0/L2/越权）且状态行为「已连接」，顺带守住"诊断区默认收起"）与**设置贡献体检**（dispatch `open-settings` → `recognition`，断言「识别」分类可达且面板渲染）。文案纪律见 `AGENTS.md` §1.10；故障速查见 `docs/architecture/UI_ISLAND_INTAKE_CHECKLIST.md` §4.1） |
| `market:serve` | **本地插件市场静态服务**（`scripts/serve-market.mjs`，默认 `market-out` + 8000）。对所有响应发 `Cache-Control: no-store`、**不发** `Last-Modified`/`ETag` —— 别用 `python3 -m http.server` 替代，它只发 `Last-Modified`，会让宿主把旧 catalog 当新鲜缓存（详见下表） |
| `schema:smoke` | **版本化迁移冒烟（条数以脚本输出为准 / 8 个场景；2026-10-21 C2 起 `ORDER_MAIN_STEPS=10`）** —— `electron/db.ts` 的 `migrate()` 是"改形状"的唯一通道，而它服务的场景（**老库 vs 新库形状不一致**）在全新库上永远复现不出来；本脚本造老库形状逐场景断言：`[0]` **步数常数 ↔ 源码比对**（`stepsInSource` 数 `version:` 条数；加了一步忘改常数 → 这里先红）· A 数据/索引不丢 + 唯一键升级 + `AUTOINCREMENT` 序列追平 + 幂等可重跑（含 v3 删 `pl_item_weights`）· B 新库跳过重建 · C `order.main` 老库**归一为主干**（可空 image_id / 款式名交接 / 行号追平）· D **ae 域老库重建 + v3 删弃表**（`ae_orders`/`ae_order_lines`/`ae_fees` 建了夹具、**含数据的也照删** + 幂等 + 结算明细新表无需迁移 + **ae 域单独跑不删 `ae_cost_map`、`order.main` 到 v10 才删**）· **D2 order 域先跑**（价目表还是 v1 之前的形状、没有 `effective_from` ⇒ v9 仍能回填、v10 随后删表）· **E 历史采集单回填主干**（v4：`source=collect` 落到位 / 金额按汇率折分 / 行级明细与颜色尺码 / 原帧保真 + 可回滚标记 / 幂等不翻倍 / **老表原样保留**〔回填是加法，删表是 ae.main v3 的另一场景〕）· **F `purchase.main` 老库删列**（带 `note` 的老库 → 迁移后版本记 v1 + 列已删 + **数据一条不丢** + **老库删列后新建单可用**〔列删了但 INSERT 还写它 ⇒ 老库上建单必抛〕+ 幂等；随后新库直建 `PRAGMA` 无 `note` —— 抓"只删迁移忘了删 SCHEMA"的分叉）· **G `oi_orders` 拼接模板自校验**（新库直建的 `PRAGMA table_info` 列序 ↔ 导出的 `ORDER_TABLE_COLUMNS` 逐列相等；模板漏一个 `${}`、或往字面量里手加一列却没进数组 → 这里红。**老库补列走 `ALTER`，抓不到模板**，故单列一场景）· **H C2 成本两字段 → v10 删表**（v8 起点：实付搬家 / 按下单日回填预估 / 未归类留空 / 从拿货单补实付 / 产品价只补空 / 幂等 / **v10 删掉旧价目表**）（见 §6「schema 演进」） |
| `goods:ui` | **「货与成本」页假桥无头冒烟（**261 项** = 全量 **235** + 默认窗口可达性 11 + 窄视口 **15**；2026-10-10 续 **+19**（「进价」页整页重设计：两栏并排〔grid **轨道数**〕· 左栏=行动区〔结构〕· 两栏真分开〔几何 `aside.right<=list.left`〕· 回显 4 条〔空着不显示 / 款名·当前价·来源 / 不误报 / **前缀不报「查无此款」**〕· 待补整行可点 2 条 · 展开区标出正在生效 1 条 · 「元」在 `data-act` **外面** 1 条 · 零成本空态 3 条〔**反向夹具** `__smokeEmptyCosts`，且验 S1 也回到待补里〕—— 宽 15 / 窄 4；`data-act` 契约**一个没动** ⇒ 既有进价断言原样重挂；变异 3 组逐条确认变红）· 2026-10-10 **+2**（产品列表撤掉 SKU / 缺克重 / 进价 三列的**反向守卫** + 款名「两行内放得下」3 条 —— 撤 3 加 5），三遍 ALL PASS；⚠️ **口径更正（第 3 次）**：此前记的「227 = 205+11+11」与工作区实测对不上 —— 同日那批「进价」页断言（未提交）没被算进那 205 里；**计数以实测为准**（命令：`npm run goods:ui > /tmp/x.log` 再数 `^PASS `）。2026-10-09 三批：导入模板改列 203 → 223，展开区样式修复 223 → 226，展开区去克重（只读 SKU 清单 + 抽屉写入守卫，假桥 `productVariantUpsert` 改为真改夹具）226 → 227，+24 条见下。⚠️ **口径更正**：此前记的「180 项 = 宽视口 107 + 窄视口 3 + R1–R3 新增 70」**没把"默认窗口可达性"那一遍的 11 条算进去**（那一遍是 R0 为 B4 新加的）⇒ 数字看着对、口径是错的；本次把三遍都算上并**分别列出**，免得再漂。2026-10-01 建；2026-10-08 实测更正两次 —— 原记「52 项」未含其后新增的队列「图」列与认款采纳款主图两组；同日重构 S0 再 +4（两栏外壳锚点 · 左栏有内容 · 池栏首屏未激活 · 切到映射视图后两栏同屏可见），S1 再 +9（主表不再塞供应商与类目 · 行展开 `row-expand`/`row-detail` · 展开区给出供应商与类目 · SKU 子表 · 已关联**只读且无解除按钮** · 反查载荷带 `productId` · 失效**单列**不混入），同日晚**页面减负 -8**（撤指标条 / 引导条 / 页签徽标：删 17 加 9），同日 **S2 再 +3**（右栏换 `PoolPane`：队列**列裁剪**「平台 / 状态不再是独立列」· **队列里不出现已建立映射的商品**〔队列 = 订单聚合 − 生效映射，非缓存表〕· 关联后刚认的商品**按 id** 从队列消失；既有 77 条因未动 `data-act` 名而**全部自动重挂通过**），同日 **S3 再 +25**（关联动线：**直连** 10 条 · **对比认款** 11 条 · **弹层带产品图** 3 条 · **反向守卫** 1 条〔收起展开行 → 直连入口消失〕；既有 80 条同样**全部自动重挂** —— 仍未动任何 `data-act` 名）），同日 **S4 再 +5**（收口：页签 **3→2**〔「产品」+「映射与关联」合并为「款与商品」，「供应商」独立〕· **旧页签与旧 `data-act` 都不再存在**· **池栏首屏就激活**〔⚠️ 这条在 S4 之前**方向相反**：合并页签后"池栏看不见所以不提前聚合"的前提消失，懒挂载连同 `pool` 开关一并撤掉〕· **宽视口两栏并排**〔`grid-template-columns` 两个轨道〕；另起**第二遍窄视口**（1000px）3 条：**堆叠 + 两栏都在 + 队列仍在** —— 即方案 §9-1 拖了两轮的视口宽度守卫；既有 105 条全部自动重挂））** —— 断言：两栏外壳三个锚点 + **池栏首屏就激活**（S4 起：页签合并后池栏上来就在屏幕上，不提前跑全量队列聚合的理由随之消失）· **宽视口两栏并排** · **窄视口两栏堆叠且两栏都在**（第二遍跑）· **4 条反向守卫**（页首不再有指标条 / 起点引导条 / 页签数字徽标 · **页签不再有「产品」/「映射与关联」两个旧名与它们的 `data-act`**）· **「问题件」下拉**（缺克重 / 未关联供应商撤掉指标条后的**唯一入口**：选它真把列表筛窄〔发参数给主进程，不是界面自己过滤〕· 出现活跃筛选 chip · 撤条件后**下拉自己回到「全部款式」**〔单一真源〕）· 产品表逐格（款编码 / 款名；**主表不再有 SKU 数 / 缺克重 / 进价三列**的反向守卫 + 长款名「整段在 / 不横向溢出 / 最多两行」3 条，夹具给的是 24 字长名）· 行展开（供应商 / 类目 / 已关联只读；⚠️ **展开区不再有 SKU 清单**〔2026-10-10 撤，有反向守卫；"只读卡"那条断言改钉「已关联商品」整卡〕）· 未关联厂家显示「(未关联)」· 展开另一个款 → 展开区跟着换（判据从 SKU 子表改为该款的供应商 / 反查结果） · **改克重后出参必须带该行全部现有字段**（`productVariantUpsert` 是全量提交，漏字段会把颜色/尺码清空）· **保存后该行缺克重计数实时归零**（原先读页级指标条，指标条撤除后改判行内那一格 —— 语义不变）· 保存回执 · **直连**（入口写明落到哪一款 · 落点是**左栏展开的那款**、不是产品列表第一行 · 不带颜色 · 没勾选时不可点 · 收起展开行则入口消失）· **对比认款**（左右两栏 · 左侧是候选产品**自己的**主图〔独立取图，不走图池产品层〕· 初始候选 = 左栏当前款 · `←` 换候选 · `空格` 写入当前候选 · 确认后自动关 · `Esc` 关闭）· **弹层带产品图**（有图 / 无图两个样本同屏分得开）· **R1 解死锁**（「店铺登记」收进内建页签：提示条「现在登记」与行内「去登记」**都**跳它、且**页签真的激活**〔不是"按钮在、点了没反应"〕· 页签点开**渲染出真的内容**〔存在性 ≠ 有内容〕· 页面没离开「货与成本」）· **R2 包装层**（左栏展开区「认到本款」按钮：计数为 0 时禁用 · 右栏勾 2 项后文案变「认到本款（2 项）」· 按下去**真的写库**并写进左栏展开的那一款 · 指标条**0 不占位**且全零时**不铺一排 0** 改说一句真话 · 单项时不说"批量" · 编辑抽屉统一保存模型：改类目**离开输入框就落库** + 页脚「已自动保存」回执 + 带未保存 SKU 改动点 ✕ **先确认**）· **R3 首次动线**（空库引导卡：零款 + 队列已拉过且为空才出现 · 恰好三步 订单→店铺→认款 · 前两步**带真按钮**、第三步**刻意无按钮** · 有款后**自己消失**〔不需"我知道了"〕· 「零款但订单已进队列」与「队列空但有款」两种**单边为零**都不出现 · 页头「?」面板**默认关着** · 面板里的三步与引导卡**同一份** · 里面的「打开店铺登记」**真的切页签**）· **P0-5 / P1 / P2 收尾（2026-10-08 续）**（**简洁模式**〔P1-1 / UX-G2〕：默认开〔页头 `simple-toggle`，`aria-pressed=true`〕且**两个方向都真**〔关掉 → 勾选框列与统计条回来；再打开 → 又消失〕· 简洁模式下左栏**一列勾选框都没有**〔连表头全选也没有，批量条与整列是一组〕· 右栏**没有统计条** · 但**刻意不藏「问题件」**〔它是缺克重 / 未关联供应商的唯一入口，藏了就是死能力〕· **空态那一格的 `colspan` 跟着列数变**〔**简洁 5 / 完整 6**（2026-10-10 撤三列后；2026-10-09 加「进价」列时曾记 6/7）—— 写死数字的症状是"右边缺一块"、不报错；该断言用的是 `colSpan === 表头 th 数` 的**动态比法** ⇒ 撤列**不必**改断言里的数字〕· **失效汇总入口**〔P1-4〕：有 N 条已失效时带**正数**出现 · 按下去**真的只筛失效**〔发 `status:'invalid'` 给主进程〕· 筛完自己让位成一句状态说明 · 放回「全部状态」又回来 · **库里零失效时整条不渲染**〔不许出现"有 0 条已失效"这种 0 占位〕· **左栏空态说清"先做哪个"**〔P0-5 左半〕：零款 + 队列也空时「去「今天」导入订单」在**第一位**且是主按钮、说明点出"商品是从订单里长出来的"；队列没拉过（`null`）时不翻顺序 · **行展开有常显提示**〔P1-2，原先只有行首那个 ▸〕· **悬停信息改常显**〔P2-1〕：缩略图来源写在**常显图注**上〔有图写来源 / 没图写「没有图」〕+「看大图」常显角标；已映射行的**来源**常显在行内〔更新时间仍留 `title`〕）· **导入模板改列 / 导出嵌图（2026-10-09，+20）**（导出新形状〔headers/rows/imageColumn，不再是渲染层 buffer〕· 表头去「类目」加「图片/颜色/尺码/克重」· `imageColumn` 指向「图片」列 · 主图路径按行带上 · SKU 列来自 `pl_variants` 且读的是**库的当下值**〔save 步改过的克重要反映在导出里〕· 预览表头同口径 · **先切回「全部行」再断言**〔预览默认只看有问题的行，是设计〕· 「图片」列按行标记有图/没图 · 图贴给**抽图报的那一行** · 汇总报「图片 N/M 张归位」· 归不了位的图有单独说明 · 规格对不上的行标「跳过」**且仍带着图**〔图不改变合格性〕· ⭐ **提交剔除不合格行**〔规格对不上的 IMP-3 不在 items 里 —— 这条在修"提交路径丢 skuErrors"真 bug 前是红的〕· items 无 category 字段 · SKU 随行带上 · 抽到图的行 imageId 带上 / 没图的行走 0 · 结果页报写入 SKU 数与主图数〔被剔除行的那张图不虚报〕）· **展开区布局（2026-10-09 样式修复，+3）**（展开区文案可换行〔克重说明在自己的列里放得下 —— `scrollWidth ≤ clientWidth`，nowrap 回归立刻红；基座 td 的 nowrap 被展开区整体继承是根因〕· 认款动作条横跨展开区全宽〔挤在单列里提示语折成细长条〕· 动作条内部不溢出。两条变异各自变红：nowrap 回归 note=301/213；去 grid-column relate=213/467）· 无未捕获错误 |
| `master-data:ui` | **「基础数据」页假桥无头冒烟**（账号库 / 店铺登记 / 企业 / 货品档案 / 物流运费等维护面的接线与锚点；改该页必跑；需本机 Chrome） |
| `today:ui` | **「今天」发货台假桥无头冒烟（149 → **249** 项，2026-10-01 → 2026-10-12；⚠️ **口径更正（第 4 次）**：旧记的「→ 192」未含 10-11 下半日的四轮 —— 导入投放区 192 → **199**、发货台命名 + 导入日过滤 + 回执结论卡 + 归类动作计数 → **215**、取图口径补「尺码」→ **216**、归类保存「挂款链被空指纹短路」修复 → **223**（**计数一律以实测为准**： 再数 `^PASS `）；10-10 七轮：并入拣货 149 → 164、拿货页重设计 164 → 168、卡片网格 +「复制给厂家」168 → 172、拿货单瘦身〔去「备注」整条链 + 「模式」改页头只读标签〕172 → 175、拿货单明细表改列〔图片 + 款色合并 + 按款色取行图〕175 → 181、**编辑器整页重设计 181 → 183**〔抽屉 560 → 620px 让 8 列一行放下 · `table-layout: fixed` + colgroup〔款色吃剩余宽度〕· 行尾文字链接〔竖排挤三行〕改 ↻/✕ 图标按钮〔SVG + `title`/`aria-label`〕· 日期 label 与提示句两行并成一行工具条 · 页脚「共 N 行 · 合计」〔包价单不加"共 N 行"〕· 行 padding 9 → 5px〔行高 77 → ≈58〕；新增两条**几何/可达性**守卫〔表格不横溢出 `scrollWidth ≤ clientWidth` · 行尾按钮在视口内且 `elementFromPoint` 命中〕—— 此前这两类是**零覆盖**〔列被裁 / 按钮在视窗外都是静默的〕，变异双确认〔去 `fixed` ⇒ ①红 590/587；`min-width:700px` ⇒ ①②全红，坐标 791/815 vs 视口 800〕· `data-act` 与表头文字一字未动 ⇒ 既有 181 条原样重挂；见 `docs/notes/2026-10-30-purchase-card-and-editor.md`〕、**编辑器反馈再修 183 → 185**〔用户「拿货单中的款色和尺码为什么要用输入框的样式？操作区两个按钮完全不知道是什么意思」⇒ ①款编码 / 颜色 / 尺码改**幽灵输入框**〔默认无边框无底色像文字 / 悬浮出一条边框 / 聚焦还原完整外观；⚠️ `:focus` 而非 `:focus-visible` —— 鼠标点进去必须有"我在编辑"的反馈；可编辑性一字未动〕②行尾 ↻/✕ 图标**推翻改回文字动作**「取最近价」「删除」〔`.wb-link` 与「拿了什么」列表同套；列 60 → 66px，覆盖 td padding 要写 `.pue__table .pue__ops`〕· 两条新守卫〔ghost `getComputedStyle` 逐项比 `rgba(0, 0, 0, 0)` · 文字动作 `textContent` 恰等〕· 旧两条几何 / 可达性守卫因判据用 `contains` **自动重挂** · ⚠️ 模板串转义两连踩〔正则里的转义括号被剥成半个括号 ⇒ 诊断全对断言恒红；注释里的转义触发 lint error〕，见 `docs/notes/2026-10-30-purchase-card-and-editor.md`（文末「同日反馈修正」）〕；10-11 四轮（**页签内页面内容**设计：导入订单 / 归类核对 / 算钱 / 结算对账）**185 → 192**〔+7：导入空态指引 / 归类说明 ≤ 80 字长度守卫 / 单个「刷新」（按**可见按钮文字数**数，非 `data-act` —— 后者恒绿实测过）/ 零活动厂家不占行 / 删退款三维文案 / 店铺空态按钮 / 步号「第 4 步」；既有 `data-act` 一字未动 ⇒ 原样重挂；见 `docs/notes/2026-10-30-mail-and-today-pages.md`〕、2026-10-12 一轮 **223 → 238**〔+15：归类核对新增**「退回待核对」** —— 页头**范围切换**（待核对 / 已核对 · 计数徽标 `cl-count-*`）· 已核对范围颜色/归属款改**纯只读文本**且**两个取值分支**（款色优先 / 回落订单色）· 行内退回载荷恰 `[46]` · **反向守卫**「待核对行不许混进已核对列表」· 已核对无「全部确认无误」· 已核对空态与出口 · 退回后可编辑；既有 `data-act` 里只**新增**、未改名 ⇒ 原条目自动重挂；见 `docs/notes/2026-10-30-order-classify-panel.md`〕、2026-10-12 同日第二轮 **238 → 249**〔+11：表格图 64 → **96px**（阈值从"≥60"收到"≥90" —— 旧阈值对 96 与 64 都放行）· ⤢「看大图」角标**常显**（读计算样式，不读 class）· 点开**先出缩略图**再把读图拖慢后才换**原图**（`order-read-image` 不缩放）· 载荷恰是该行 `localPath` · 读失败**保留缩略图** · **连点只认最后一次**（⭐ 必须把第一次响应拖慢 300ms 才造得出竞态 —— 同步桩下坏实现也绿）· 已核对范围**同样出图**（⭐ 补夹具：P-46/P-47 的 `localPath` 原先是空串，而真库 23/23 行全有图 ⇒ 该条注释此前**结构上无法被验证**）· **竖版图走 contain 而非 fill**（⭐ 方图进方格子两者渲染相同，必须有一张竖版夹具）· 操作列两动作**同一行**（几何：`offsetTop` 相等）· 页头**不再重复写「待核对订单」**；⭐⭐ 附带抓到一个**只有窄窗口才复现的真 bug**：`--dump-dom` 不传 `--window-size` ⇒ 视口仅 800×600 ⇒ `table-layout: auto` 把**图列从 112px 压到 32px**、基座 `img { max-width: 100% }` 使图变 **12px 细条**（待核对范围只因下拉框撑宽表格而侥幸逃过）⇒ 修法 = 图列**自己的地板**（`td { min-width: 112px }` + 按钮定尺 96×96）；见 `docs/notes/2026-10-30-order-classify-panel.md`〕）** —— 「今天」页自 2026-10-05 起是**一页页签容器**（收编当时七页签 / 六步；**2026-10-10 起六页签 / 五步** —— 原第 3 步「生成拣货单」并入「拿货」，清单成「拿货 › 要拿什么」子视图，见 `docs/notes/2026-10-30-picking-and-takeout.md`；同日晚**拿货页重设计**见 `docs/notes/2026-10-30-ui-nav-and-tabs.md`，界面形态当日第三轮再被**卡片网格**取代，见 `docs/notes/2026-10-30-purchase-card-and-editor.md`）· **页签栏**（六页签齐全 · 默认落总览 · **没点过的页签面板一个都没挂载**（懒加载；否则六个整页视图进页面就一起取数））· **点流程卡 = 就地切页签、绝不跳页**（核心判据必须**两条一起看**：目标页签选中**且**全程 `switch-module` 计数不变 —— 只断言"到了"会假绿，旧实现也"到得了"，只不过靠跳走）· **保活**（切走再切回，面板是**同一个 DOM 实例**，用 `__keepMark` 验；重挂载会丢标记，"取了数"不算证据）· **保活的代价要还回去**（导入后已生成的拣货单自动重算；判据按**入参**挑调用方 —— `limit===undefined` 才是拣货面板自己发的，否则会被容器 `reload()` 的 `{limit:2000}` 满足成假守卫）· 内嵌整页视图（拣货〔现挂在「拿货 › 要拿什么」〕/ 算钱）只藏 `wb-head__main`、**必须保留 `wb-head__actions`**（否则生成 / 导出按钮消失，页面打不开）· **「归类核对」页签（2026-10-05 内建；待核对订单表 2026-10-10 按用户口径重做）**（**页头指标条整条撤掉**（原「待核对 / 未归类 / 识别库款数 / 本页商品数」四格 —— 用户原话「我看不太懂，用户肯定也会很懵」；连带只为它而生的 `order-sku-rollup` 通道整条退场（零消费者即删）、产品维度指标格 `cl-metric-product` 一并撤）· 表头 **9 → 7 列**（**「品类」「Logo」两列撤掉** —— 品类属主数据在「货与成本」维护，Logo 等「印花 logo 管理」做出来再加；⚠️ 两字段在 `Draft` 里**保留并原样回传**，不显示也不抹空：把已有值抹成空串比不显示更糟，且指纹要的品类必须还是订单原本那个）· **图不裁切**（`.cl-table .wb-thumb` 覆盖基座成 64×64 + `object-fit: contain` —— 基座 `.wb-thumb` 是 40px + `cover`，商品照多竖版、上下两端正是"款长什么样"的关键部位，用户报的"图片展示不全"就是它；缩略图 `maxEdge` 96 → 192 跟上展示尺寸）· **⭐ 颜色三支优先级**（**每一支都要在色卡里才作数**：① 这张图**记住过的**颜色（渲染层读 `o.styleColor` —— 宿主记在 `oi_images.style_color_id` 上；图片按内容/地址指纹去重 ⇒ 同样的地址下次读到的还是这一行 ⇒ 自动带出上次选的颜色）→ ② 订单自己的颜色列 → ③ 都不在色卡里 ⇒ **空**，留空让用户自己选、不替他猜）· **⭐ 归属款数据源改产品库全集**（旧实现按识别池 `oi_styles` 驱动，「货与成本」手工新建、还没出过订单的款一个都不出现 —— 用户报的"展示不全"就是这个；改读产品库全集，**停用款也列出来并带「（停用）」后缀**；夹具含一个 archived + 色卡空的款，验它**仍在下拉里**）· **⭐ 缺色拦保存**（点名了款却没给颜色 ⇒ 「保存」`disabled` + 行内写「请先选颜色」—— 宿主落库时颜色是款色主键之一，空颜色会落出一个没有名字的款色且界面看不出异常；选了款里有的颜色即解禁）· **⭐ 换款清空载体**（手点款下拉换款 ⇒ 旧颜色不在新款色卡里就清空、在色卡里就保留省一次点击 —— ⚠️ 只在 `@change` 触发，载入取值在 `initialColor`，两处都做会让"清空"跟"记住的颜色"打架）· 没点名款（走自动匹配）或该款还没录颜色 ⇒ 色卡为空，回落成**自由输入 + datalist**（`cl-color-options` = **标准色词表 + 本库已用写法**，词表在前 —— 自由输入这一支放任它只有库内写法时，同一个色各写各的〔"藏青"/"深蓝"〕错误写法会**自我强化**；⚠️ 刻意**不把用户输入改写成词表里的词**：颜色是款色维度，替用户改判比写得不一致更难查 ⇒ 收敛摆在明面上让他选）· **默认值不靠位置**（已归类行按 code 反查它自己的款）· 点名款出参**走 `styleCode`**（`{orderId, styleCode, color}`）· **⭐ markdown 守卫**（面板可见文案**不许出现 `**粗体**` 或反引号** —— Vue 模板不解析 markdown，写进去会原样显示成一串星号；本轮文案实测踩到，断言用 `String.fromCharCode(96)` 绕开模板串，别在断言里直接写反引号）· **⭐「同商品」徽标**（同一家店同一商品ID 的多行各标「同商品 ×N」，让人知道**定一次就够**；**没有商品ID** 的行、**商品只此一行**的行都**不许**有徽标 —— 夹具三种情况各占一行，少了任一种，"凡有商品ID 就标"或"徽标恒显示"这类错法都会全绿）· 缩略图合批**只带有图的行**（载荷是**裸数组**，preload 才归一成 `{items}`）· 有图的行真渲染 `<img>`（断言 `naturalWidth > 0` —— 空壳 `<img>` 也会"有 img"，只断言"有 img"会恒绿）· **⭐ 键盘流**（行内按回车＝保存这一行，不必去够鼠标；保存后该行离开待核对列表、焦点自动落到**顶上来的**那一条 —— ⚠️ 夹具到这一步才开启"已核对即离表"的模拟（`updateOrder` 写 `corrected = 1`）：**不对齐时列表不缩水，任何下标都"看着对"**，把 `focusRowIdx` 写成 `idx + 1` 当场变红）· 没改动时保存禁用 · 保存出参**带指纹**（漏指纹 = 宿主重归类分支静默空操作，旧岛漏传过）· 没点名款不走 `orderStyleAssign` / 点名款把指纹**记入该款** · 单行确认只标这一行 / 全部确认走 `all` 分支 · **⭐ 人工核对回流被"说出来"**（点名款后提示「已记住这个商品 → 款和颜色，另有 2 单一起归好了」）—— 判据**必须先等提示真的进 DOM 再断言**：假桥是在 invoke 的**同步**阶段记录调用的，直接在"通道被调用"那一刻取 DOM 只会得到"还没有提示"，于是**反向**断言（「没点名款的那次保存不许谎称已记住」）会在"提示没渲染"与"提示里没那句话"之间恒绿 —— 本轮实现时实测踩到，改完并做变异确认才真的变红；取提示一律 `querySelectorAll` 逐个看，不能取第一条（同屏能并排几十条旧提示）；另有一条前置断言「保存提示真的渲染出来了」作自证非空转）· ⚠️ 原「没配 Key 当场拦住并指路」与「批量识别只挑"有图且未归类"的行」两条已随该批量按钮一起删除（2026-10-05 用户要求），代之以一条**反向断言**「工具条不再有识别按钮」）· **「结算对账」页签（2026-10-05 内建）**（指标条四个金额同窗同源（合计 ≠ 任一行）· 厂家对账两行逐格对 · 付款类型**逐行**打标 · 记付款弹层**预选厂家** / 打开时不发请求 / 空金额拦住 / 金额按分提交 / 成功后自关 · 删除先确认且写明后果 / 确认前零请求 · **切时间窗带窗口重取**（不是只改高亮）/ 切回「全部」= 不设边界 · **切「按店铺」才取分摊** · 明细按**这一家店**取 · 无可归属给空态并说清分摊原料从哪来）· 断言三张卡的数字（订单总数 + 两条来源分开计数 + 最近下单 / 待拣同一 SKU 合一组 3 件 2 单 / 缺口三项各自计数与合计）· **范围写在卡上** · **每日发货流程卡**（**五步**齐全（导入 / 归类 / 算钱 / 拿货 / 对账）/ 每步标明"**在本页哪个页签做**"（**反向守卫：不许再出现模块 id 字面量** —— 旧文案就是这么写的，用户看到会以为还得跳走）· **当前步唯一**：`now`+`gap` 合计恒为 1，前一步未完成时后面的步骤必须是 `todo` 且写明「等第 N 步」· 已完成的步打 `done` · 「下一步」按钮跟着当前步走 · **点它就是切页签，不派发 `switch-module`** · **五步全部在本页页签里**（流程卡不再有"在插件里"的步骤、也不给"去插件"的岔路 —— 五个 `flow-<key>` 的 `where` 都写本页页签名）· **点击出参**（空态 `open-settings` → plugins；⚠️ `switch-module` 现在是**反向判据**：断言"点了它也不派发"）· 空态给的是**动作**不是「暂无数据」· **统一导入三条真实路径**（商品信息→指路不写库；**订单报表→多产品拆行 + 无主图列照常落主干 `imageId=null`**，结论带判据与「店铺未归属→归到该店」的下一步；**芒果店长待发货订单→判据点名芒果 + 店铺名落 `shop` + 图片链接真走 `orderDownloadImage` 且 `imageId` 非 null + 结论不再提示「归到该店」**）· **导入回执四段**（标题点名子类 / 判据明细 / **落点行说清"本页哪个页签看得到"**（文案从"页"改"页签"，因为已不跳页） / **下一步按钮的 `moduleId` 必须在 `modules.config.json` 里**，订单回执按"店铺已归属/未归属"的**两组分支各测一次**；认不出时**不给**下一步按钮；可关闭且关掉真的消失）· **订单导入后「待拣」卡点亮** · **缺口卡就地补齐**（缺克重→「货与成本」补 SKU 克重 / 缺成本·未识别款→「货与成本」入口；克重齐时不催人）· **空态主操作不许再"劝人装插件"**（判据=出现「导入 Excel」且**不出现**『另装』且出现「归类核对」，且点它会**顺带把「导入订单」页签切到前台**再弹选文件 —— 两步任一漏掉都算失败）· **页签切换全程零 `switch-module`**（`nav` step）· **拿货页签（2026-10-10 七轮：并入拣货 → 款色一行重设计 → 整页卡片网格 +「复制给厂家」 → 拿货单瘦身〔用户问「模式是什么？备注的意义是什么？」⇒ mode 留〔有下游：明细扣缺口/进成本 vs 包价只进对账〕改**页头只读标签**、note 整条删〔零读者，DB 列走 `purchase.main` v1〕〕 → 明细表改列〔用户要求「列表展示图片、款色、尺码、建议、实拿、单价、金额」〕 → 编辑器整页重设计 → 编辑器按反馈再修〔后两轮细则见本格开头〕）**（默认落在「要拿什么」〔这一步的动词是"去拿货"，清单才是入口〕· 分段只有两个视图名、**不带徽章**〔数字就地给，见下〕· **清单自动生成**〔进这一步就有表，不用再点「生成待拣清单」——`auto` 语义〕· **卡片网格**〔`pk-grid`：一张卡 = 一个款色〔行键 `S1 · 黑`〕= 图〔缺图占位〕+ 厂家胶囊 + 尺码角标条 + 四态标签〔已忽略 > 已拿完 > 缺口 > 齐〕+ 卡面金额/单价〕· **顶部厂家筛选标签**〔数 = **待拿款色数**；点它只筛**网格**、不动总账；未指定厂家独立一格 `data-supplier="0"`、无货不占位〕· **尺码角标条**〔`size-chip`：`L×2` = 这一码还要拿 2 件 / `L✓` = 已拿完；tooltip「需求 3 · 已拿 1 · 还差 2」——**文本与 tooltip 钉在同一格**，串列即红〕· 清单条**就地给数**「待拿 1 款色 · 2 件 · 预估 —（2 件全部无进价）」（与汇总行按钮同一个 `pendingRollup`）· 缺口条按**需求**口径「无进价 3 件」、与「待拿 2 件」刻意不同值〔口径混用即红〕· **吸底汇总条**（`pk-sum`，`position: sticky` + **`flex-shrink: 0`**——**必须显式写**：`.wb-page` 是定高弹性列，内容一多它默认会被压到 2px 再被自身 `overflow: hidden` 裁掉，正是"『复制给厂家』『生成拿货单』只对某几个厂家出现"的假象来源〔页签只改卡片数量 ⇒ 改塌陷程度〕，见 `docs/notes/2026-10-30-ui-style-and-hierarchy.md`；冒烟"在眼前"按**几何 + `elementFromPoint` 命中**断言，不再是声明式断言（只断言 `position: sticky` 会塌了也绿）。同类纪律：**常驻覆盖层必须 `pointer-events: none`** —— 为 aria-live 常驻的 toast 容器（含 `gap` 空隙）会静止地吞掉右下角点击，本轮同修）一行一个厂家 = 「厂A · 1 款色 · 待拿 2 件 · —（2 件全部无进价）」+「复制」+「生成拿货单（2 件）」带 `data-supplier="7"`〔开单钉在汇总行上 —— 页级"先选厂家 + 按此生成拿货单（N）"整个撤掉：数据里已按厂家分好段〕· 「复制」把**这一家**的待拿货画成 **PNG 写进系统图片剪贴板**〔`writeClipboardImage` 载荷以 `data:image/png;base64,` 开头〕，成功 toast 说清"几款色几件 + 发给谁"· 按段开单出参带厂家/日期/模式、qty = **还差**、**单价留 0 待填**、款名带上 · **生成后自动切「拿了什么」并直接打开新单编辑器**〔#99、合计 0.00、明细在〕· 「拿了什么」面板头**就地给数**「2 张 · 1 张草稿待提交 · 已提交 ¥500.00」/ 新单入册后「3 张 · 2 张草稿待提交」· **厂家不预选**〔下拉停「选择厂家…」；夹具放两个厂〕· 没选厂家时两个「新建」都禁用、选了就解禁〔该下拉只服务新建空白单〕· **已忽略折成一行**〔`pu-ignore-toggle`：一行说清几条 + 生效范围，展开才出 `pu-ignore-table`；「取消忽略」原样〕· 空态：没有拿货单时给"最省事的开法"，且其按钮**真的切回「要拿什么」** · **拿货单瘦身（2026-10-10 第四轮，+3）**〔列表**不再有「备注」列** · 编辑器**不再有备注输入框**（`pue-note` 不存在）· 开单出参**不再带 `note`**（整条链已删，DB 列走 `purchase.main` v1 迁移）· **模式是只读的**（页头标签 `pue-mode-tag`；`purchase-order-update` 不接受 mode ⇒ 表单格是"改不动的下拉框"——反向断言 `pue-mode` 已不存在）· **包价单的删除确认不许出现「回升」**（包价只进对账、不扣缺口不进成本，原文案对它是谎话；提交确认与编辑器已提交警示同批按 mode 分叉）〕 · **拿货单明细表改列（2026-10-10 第五轮，+6）**〔表头 **7 数据列** = 图片 / 款色 / 尺码 / 建议 / 实拿 / 单价(元) / 金额(元)（款编码、款式名不再各自成列：款色格 = 款编码·颜色双输入 + 款名**只读灰字**〔权威在产品库〕）· 行图按「款编码 + 款色」查 —— 新通道 `purchase-style-images` **复用 `findStyleColorImagePath` 单一实现**（拿货单 xlsx 导出同一函数）→ 渲染层再走既有 `orderImageThumbBatch`：**图真的出来要两条通道串起来**，只断言任一条只见一半 · 三分态 `undefined`/`null`/string（混用 = 打开瞬间整表闪假「缺图」）· 图装饰**失败静默**、不拦录入 · `resolveImages` 必须在"有价早退"**之前**（否则改款色时图不刷新）· 改 S9 给「缺图」、**改回同款色不重复往返**（计数断言）〕）· 无未捕获错误。⚠️ 断言一律钉在 `data-act` 上（回执拆成四段后整串 `textContent` 拼串会假红/假绿）；**等待判据钉在"只有新结论才有的特征"上**（两条 message 共享"没认出这个文件是什么"⇒ 拿它当完成信号会读着旧回执做）；新增的点击要**顺手清 `window.__events`**（后面有按 `[0]` 取的断言，不清就是假红）。见 `docs/notes/2026-10-30-order-import-pipeline.md`、`2026-09-30-headless-smoke-waitfor-trap.md`、`2026-10-05-daily-flow-card.md` |
| `order-profit:ui` | **「算钱」页假桥无头冒烟（**94 项实测**；2026-10-01 建 → 2026-10-11 实测更正计数〔旧记「64」系建脚本时的快照，其后多轮追加载荷未同步〕；同日空态断言 +2 词条件：不得出现「宿主 / 插件」〔§1.10 禁用词〕，条数不变；⚠️ **2026-10-15 再次更正**：本行原记「81 项」是**陈旧值** —— 工作区此前已有未提交的追加载荷，实测 88；同日 P1-3 **+3 ⇒ 91**；**2026-10-21 C1 再 +3 ⇒ 94**〔已拆包单运费 = 包裹实付合计 **45.00**，与运价表算的 **30.00** 不同值 ⇒ 走哪条链可判 · 已拆包缺运费 → 「—」+ 行标「缺包裹运费」+ chip 1，且悬停写明**不按运价表估算** · 批量读口载荷带全部订单号〕）** —— 复制 `dist/renderer` 到隔离目录 → 注入假 `window.electronAPI`（Proxy + 精确样本）→ 本地 HTTP + 无头 Chrome `--dump-dom`。断言：五路取数接线（订单行/批量克重/款级成本/**宿主快照**/**包裹运费汇总**）· **分→元的精确值**（运费 16.00 / 成本 10.00 / 税 0.00 / 收入 165.18 / 毛利 139.18）· 分桶与缺口文案 · 点「刷新」真的重新取数（断言出参 `{limit:500}`）· **改平台费率 → 毛利被扣（139.18 → 124.31）且费率落盘** · **同一行从「预测」切到「精准」**（打开结算数据后精准毛利 = 净收入 − 运费 − 成本 = 64.86，且悬停说明保留预测值）· **件数接线**（报表块内 2 件 → 结算商品行 3 件盖过它 → 两处都拿掉时按 1 件并出现「缺件数 1」与多件行提示，且提示随数据消失）· **两条摄取通道合并**（打开采集后：采集 1 行/导入 1 行、逐行来源标签、采集行件数=真值 2、税口径默认平台代征记 0.00 与切「不知道」标缺口、仅采集筛选）· **⭐「缺汇率」与「缺收入」分开标（2026-10-15，+3）**（同一行只把 `amountCents` 改成 NULL ⇒ 缺口 chip 是 **`gap-fx`「缺汇率 1」而不是 `gap-revenue`**、该行「缺」列写「缺汇率」且**不写**「缺收入」、金额格给「—」而非 `0.00` —— 判据是**两档结果必须不同**，把两档并成一个 key 的实现会当场红）· **数据基础区**（默认收起 / 缺成本时自动摊开 / 成本表值 / 改汇率真的发出 upsert / 新增币种码归一大写）· **空态给可点的下一步**（指向宿主「今天」的导入入口，不再指向要装的岛；按钮派发 `switch-module → today`，排最后因页面会切走）
· **统计区**（按款一行 165.18/26.00/139.18；维度切到目的国后出现"美国"组）·
**店铺归属全回路**（未归属提示 → 点「归到该店」断言出参 → 刷新后提示消失且明细显示店铺 → 维度切到店铺显示该组）·
**界面精简**（首屏默认不含费率/店铺/结算导入，展开「更多」后可达）·
**两个新维度**（切到 SKU 显示 `S1 · 黑 · L`、切到供应商显示 `厂A`）（断言出参 `{ns:'order-cost', data:{platformFeeRatePercent:9}}`；⚠️ 别断言"最后一次 `setModuleState`"——外壳启动也会调它）· 无未捕获错误。⚠️ 需要本机有 Chrome（macOS 路径硬编码），故不进"每次必跑"清单；**改页面接线必须跑它** |
| ~~`picking:ui`~~ | **已退役（2026-10-17）**：「拣货」一级菜单摘掉后该页失去宿主（同一份清单在「今天 › 拿货 › 要拿什么」，入口唯一），`scripts/picking-ui-smoke.mjs` 与 `package.json` 的 `picking:ui` 一并删除。**它守的东西没有消失**：账面上的导出（`pickingExportExcel` 出参 + 图已转 JPEG + 无价行金额 `null`）、天数窗「改条件即重算」两条已搬进 `npm run today:ui`；其余（卡片网格 / 厂家筛选 / 已拿还差 / 复制给厂家 / 空态分支）today:ui 早已覆盖。下面记的是它**退役时**的覆盖，供查历史。原为**「拣货」页假桥无头冒烟（**50 → 84 项**，2026-09-30 / 2026-10-05 / 2026-10-10）** —— 与 `order-profit:ui` 同款（复制产物 → 假桥 → HTTP + 无头 Chrome）。断言：**一键语义**（首屏空态、不自动取数、默认条件以标签呈现「未发货 · 近 30 天」）· 点生成后**六路取数都发出**（投影 / 结算 / **成本区间** / **已拿 · 忽略**〔两张表〕/ 缩略图合批）· **组内件数 = 2（报表）+ 3（结算真值）+ 1（无件数按 1）= 6 / 3 单**· **已终结（关闭）剔除并计数**、超窗剔除计数、无日期照收计数 · 缺件数/缺图/缺供应商/未识别款**逐行标出** · 缩略图带 `maxEdge` 不是原图 · 「更多」展开后筛选可达 · **改筛选后「重新生成」带出店铺** · **进价 / 预估金额**（总账给**待拿**合计 + 预估金额〔只含有价部分〕、无进价件数单独报出；有价卡单价 `10.00`〔数字**恰好**在 `data-act` 格里，「元/件」挂在格外〕、卡面小计 = **还差件数** × 进价〔≈¥20.00，不是需求 6 件的 60.00〕；无价卡单价 `—` 且**不带**单位〔没查到价 ≠ 0 元/件〕、`is-none` 降级配色）· **按厂家收口**（网格上厂家胶囊逐卡标出；底部汇总条一行一个厂家、顺序 = 有厂家在前未指定排最后、整行无价写 `—（全部无进价）` 而不是 `¥0.00`）· **全无价时总账写「—（N 件全部无进价）」**（造 `aeCostMapList` 返回空）· **「拣货」并入「拿货」后的清单升级（2026-10-10，+10）**（**「需求 / 已拿 / 还差」三列各自的数都对**〔6 / 4 / 2 —— 三个数互不相同，串位或"已拿恒 0"即红〕· 图角标 = 尺码 × **还要拿**的件数〔L×2，不是需求 L×6 —— 图是直接发厂家的〕· 没图的组没有角标可挂、但"还差"照算 = 1 · 条件条「还要拿 2 款 · 3 件」〔合计 = 各组还差之和〕· **反向夹具 `__noTaken`**〔没拿过时：已拿 0 / 还差回到 6 / 角标回到 L×6；且"还要拿"那一格**不渲染** —— 恒显示等于一句废话〕· **反向夹具 `__ignore`**〔被忽略的组行标「已忽略」且**不画角标**〔该组有图 ⇒ 这条判据非空转〕；被忽略的组不从"还要拿"扣 → 2 款 · 3 件 变成 1 款 · 1 件〕· 夹具复位回基准〔后面的断言才有个确定的起点〕· 导出**带上「已拿 / 还差」**〔拿货单拿的是"还差"，不是"需求"〕）· **整页重做卡片网格 +「复制给厂家」（2026-10-10 晚，+24）**（**卡序全网格统一**〔还要拿 → 已拿完 → 已忽略〕· **顶部厂家筛选标签**〔一个厂家一格、数 = 待拿款色数；未指定厂家独立一格；点某厂家只筛**网格**〔别家的卡退出 DOM〕、不动总账；切「未指定」只剩它；已无待拿的厂家不占位、筛选自动回落「全部」〕· **一卡 = 一款色**〔图/缺图占位 + 厂家胶囊 + 角标条 + 四态标签〕· **「已拿完」第四态整条翻**〔反向夹具 `__allTaken`：卡标「已拿完」+ 调暗 + 不再报金额 + 该厂家标签消失 + 汇总行改说「已拿齐」〕· **已忽略排在最后且调暗**〔还在网格里 —— "处理过了"也是信息〕、不进待拿、不进标签（该厂整格消失）· **吸底汇总条**〔`flex-shrink: 0` + `position: sticky`（缺前者会被定高弹性列压成 2px 自裁 ——"按钮只对某几个厂家出现"的真因，见 `docs/notes/2026-10-30-ui-style-and-hierarchy.md`）；"在眼前"按**几何 + `elementFromPoint` 命中**断言；独立页不给「生成拿货单」——那是宿主「拿货」页的动作〕· **网格布局**〔不再是表格〕· **复制成功与失败两分支**〔载荷是 PNG dataURL 且 `new Image()` 解码出像素〔`__clipFail` 反向夹具〕；成功 toast 说清"几家几件 + 发给谁"，失败如实报错不装作已复制〕）· **导出交给 `pickingExportExcel`**（断言传过去的 rows：件数/单价/金额/缺口文案，**图是渲染层转好的 JPEG**（`/9j/` 开头 + 64×64）、没图的组传 `null`、无价的组金额传 `null`，且不再调旧的 `orderExportExcel`）· 空态**三**分支文案：①**未生成过**（引导动作）②**扫到行但全被剔**——⚠️ **两种剔除原因各有一支反向夹具**（`__onlyFinished` / `__onlyOld`）：**已终结**那支必须点名「已终结」且**不给**无效动作（无 `empty-widen` 按钮、不提「连已发货」），**超窗**那支必须点名「超窗」+ 说清是哪个窗 + `0 = 不限`，且其下一步是**真按钮**（点了真的展开「更多」、天数窗输入框出现）③**一行都没扫到**（指向导入入口 + 按钮派发 `switch-module`）· **只改筛选条件（店铺 / 天数窗）不点生成也会重算**，且条件条天数窗读**本次结果的口径**；`0` 显示「不限天数」而不是「近 0 天」 · 无未捕获错误。⚠️ 新增等待一律用脚本内的 `tryWait`（超时不当异常）：一条 `waitFor` 超时会把整份脚本抛到最外层 catch，后面几十条断言全不跑、报出来的失败条数与真实失败数无关。⚠️ 假桥的 `orderImageThumbBatch` 必须返回**真 JPEG**（页面内 canvas 现造）—— 返回假 dataUrl 会让每张图被静默跳过，这条链**永远测不到**。⚠️ 本脚本**验不到 xlsx 本身**，见上一行 |
| `shipping-rate:ui` | **运费**假桥无头冒烟（**已从岛形态整体重写为宿主形态，2026-10-15**：站点从 `ui-plugins/shipping-rate/dist` 换成宿主 `build` 产物，脚本其余骨架与两遍视口〔宽 1440 / 窄 800〕沿用）。**31 项断言**：挂载进「基础数据」· 左导航**七类**资料齐（默认仍停在「店铺账号」，不因新增种类改默认位）· 「物流运费」面板与页签（`wb-seg` 激活类是 `is-on`）· **冷启动空态**「还没有运价表」+ 不渲染结果表 + **不发留档**（没表就别写库）· 导入真报价单（`tests/fixtures/shipping-rate.xlsx` 9 张 sheet 含「目录 / 说明」干扰项）宿主留档恰 1 次 · 成功回执与库里同数（184 国 / 857 张价卡）· **100g 全表 184 国一行不多一行不少**、最便宜哈萨克斯坦 `8.50`、次便宜马来西亚 `9.80`、汇总条计数一致 · **改 350g 后首行换人**（KZ 的 ≤150g 卡装不下 350g → 马来西亚 150g–500g 档 `16.05`）· 逐单试算（可算行与查询页**同卡同价**；表里没这个国如实拒算，不硬套别国价）· 按产品试算（目的国下拉 184 项；**没建 SKU 的款式不硬算**，报「未维护克重」）· 偏好防抖落库（载荷带全部 9 张候选 sheet 名——**按真实集合断言，不写死数字**）· 克重 350 进载荷且**重挂载后回显**（持久化真的接住）· 无未捕获错误 |
| ~~`order-insight:settings:ui`~~ | **已随岛下线（2026-10-05）** —— 原为 `order-insight` 岛「导入设置」页签的假桥无头冒烟（9 项）。岛整体下架后脚本与 `package.json` 命令一并删除；它守的东西**没有消失**：列映射现由内建「今天 › 归类核对」承接，接线断言在 `npm run today:ui` 里（那 9 项对应的是**岛**的页签结构，已无对象） |
| `ipc:shape:smoke` | **preload ↔ 主进程「载荷形状」端到端冒烟（34 项，2026-10-04 建 / 2026-10-05 补 `order-sku-rollup` / 2026-10-08 补订单图采纳 + `product-sku-list` 的 `productId` 透传 / 2026-10-10 删 §⑥ 那 3 条 / 同日晚补 §⑧ **剪贴板真写系统剪贴板 + 读回**（v44 移除 `clipboard.writeImage` 的守卫，见 `docs/notes/2026-10-30-electron-and-platform.md`） / 同夜补 §⑨ **拿货单行图**：`purchase-style-images`（真 preload + 真 handler + 真库 JOIN —— 逐项对位〔命中 / 没图 / 空款编码 / 款不存在〕· 载荷透传 · 空清单 · 500 上限；变异【preload 漏传 items】3 条红 —— 该失效形态与 `orderImageThumbBatch` 事故**同形**：每行都显示「缺图」且一条错都不报，见 `docs/notes/2026-10-30-db-schema-and-migration.md`））** —— `npm run verify` 只核**通道名**、看不见**载荷形状**，而形状错了恰好是最难查的一种**静默**：`orderImageThumbBatch` 声明收**裸数组**、preload 只读 `payload.items` ⇒ 发出 `{items: []}` ⇒ 主进程**正常返回空数组** ⇒ 四个页面缩略图全空、**console 一条错都没有**（调用方的 `catch` 兜的是异常，兜不住"成功但空"）。做法：进程内把 `ipcMain.handle` / `ipcRenderer.invoke` **对穿**，其余 electron 成员保持真实（缩略图要 `nativeImage` 真解码 ⇒ 素材必须是"按 BGRA 原始位图 `createFromBuffer` 再 `toPNG()`"的真 PNG，1×1 PNG 会被判 `isEmpty`、让"通道坏了"与"素材太小"长得一样）。断言三层：① 按声明形状调用必须拿到非空 dataUrl ② 不存在的/越权的路径必须是 `null`（证明"非空"不是恒真）③ 40 项批量**逐项对号**（顺序 + 数量）。**2026-10-10**：原第六节（`order-sku-rollup` 的裸数组 → `{rows}` 包装）随该通道删除而删 —— ⚠️ **只删断言、留夹具**（`shopId` / `pid` 被后面两段引用，连夹具一起删会把无关的东西一并拆掉），节号顺延 ⑦⑧ → ⑥⑦ |
| `ship-rate:smoke` | **运价表快照冒烟（11 项，2026-09-29）** —— 同内容重复导入**不新增行**（按内容去重）· 生效日默认导入当日（脏值回落、不写脏数据）· 列表**不带 payload**、算账集合带 payload（坏 payload 降级 null）· 空库返回空数组（调用方回落"当前那份"） |
| `order:smoke` | **订单域 DB 层冒烟（**27** 项，2026-09-29 补 / 2026-09-30 随主干归一与免图导入更新 / 2026-10-05 补列表投影 / 2026-10-12 补核对状态与退回）** —— ⚠️ **口径更正（2026-10-12）**：此前记的「23 项」与实测对不上 —— HEAD 版实测 **21** 条 `check()`；本轮新增 `[6.5]` 六条后为 **27**（**计数以实跑为准**，直接数脚本里的 `check(` 调用）。此前最大的域反而没有自己的冒烟（改动只能被 `style:smoke` / `product:sku:smoke` 间接兜住）。覆盖：幂等重入（同单号同图不重复插）· **金额入账**（`raw_fields` → **只提主线列**，分；空列 → NULL 而非 0；**零读者列已删**）· **主干两列**（`source` 默认 import / `qty` 缺省 NULL）· `shippingRows` 投影宽了但**不丢行**（LEFT JOIN）· **列表回带商品ID 与原始整行**（`itemId` 由主进程用 `extractSkuFields` 从 `raw_fields` 推，与回流写映射同一个函数；夹具里刻意放一个名字相近的「商品名称」列作**干扰项**，确认没抓到它 —— 这条同时守住"`orderList` 忘了 select `raw_fields`"那个静默陷阱）· `groupStats` 维度白名单 · 队列入队/统计/分页 · **订单归属店铺**（同订单号的多行一起改 / 已同名不改 / 空入参不动数据）· **SKU/供应商投影字段**（缺 `suppliers` 表时降级为空，不抛 `no such table`）· `clearAll` · **核对状态与「退回待核对」（2026-10-12，+6）**（「确认无误」只动点名那一行 · `corrected` 过滤三态〔`false` 只出待核对 / `true` 只出已核对 / **不传 = 不过滤（全表）**〕· ⭐退回把它放回待核对且**不碰** `category`/`color`/`logo` · **退回与确认互为镜像**（都按点名 id 直接写目标值、**不校验原状态** —— 退回一行本来就待核对的行实测 `changes=1` 而非 0）· 退回入参边界（空数组 / 不存在 id → 0，且不误伤别的行）· 「全部确认无误」一次把剩下的全置 1 且幂等） |
| `mail:smoke` | 邮件引擎冒烟（**DB 层**：`electron scripts/mail-engine-smoke.cjs`） |
| `mail:inline:smoke` | **邮件内联图离线冒烟**（老库补 `content_id` 列不丢数据 / 重解析按同名同型同大小保留 `attachment_id` / cid → `sk-mail://att/...` 改写 / 远程图两态 CSP；不需凭据、不碰真实 userData） |
| `mail:body:smoke` | **邮件正文 `sk-mail://` 渲染通道端到端冒烟**（真 Electron；改协议或岛 `index.html` 的 meta CSP 必跑 —— 两层 CSP 取交集，缺一层整 frame 被拒）。「第二层」的来源 2026-10-22 起**按事实扫描**（谁的岛源码引用 `sk-mail://` 就读它的 `index.html`），不再写死 `ui-plugins/shop-accounts/index.html`（该岛已回收为内建模块，写死会让脚本在 `whenReady` 前抛错、而 Electron 遇 load 期异常**不退出** ⇒ 表现为"零输出卡死"）；当前**无岛嵌正文** ⇒ 该节显式打「不适用」跳过，"宿主页不许偷偷加 CSP meta"由 `tests/islandMailFrameCsp.spec.ts` 钉住 |
| `product:xlsx:smoke` | **产品库带图 xlsx 往返冒烟**（产物当 zip 拆开数 `xl/media/`、逐行比对字节；两张不同图防"图配错行"；宿主层，不启动界面） |
| `product:smoke` | 产品库 DB 层冒烟（**24 项**，P2/P4a；2026-09-30 加「商品信息导入顺带回填 SKU 克重、不覆盖人工值」） |
| `shop:smoke` | **店铺 + 账号合并域 DB 层冒烟（45 项，S1 + 2026-10-22 物理合并 + 2026-10-23 记分/四态 + 2026-10-25 保证金 + 2026-10-26 删除保护）** —— 除 S1 的名称归一（含"未归一名单覆盖 `oi_orders` 每个店铺名且计数一致"这条**验收原文**）外，合并后新增三段：① **`shop.main` v1 真跑**（造老形状 + **把账本倒回 0**，否则本脚本自己 ensure 过的库版本已是 1、迁移一步都不跑 = 安慰剂）：店铺行 id 不变、账号列并进同一行、紫鸟/ERP 文本抽进 `sk_tool_accounts`、邮件外键改指 `sk_shops`；② **早期库**（只有 `sk_shop_sets`）→ 账号搬成纯账号行、不孤立（断言**按邮箱取行 + `id > 0`**，因为纯账号行不继承旧 set id）；③ **一行两态**（纯账号行 / 纯店铺行共存、两者都空被 `CHECK` 拒）+ **部分唯一索引是硬约束**（绕过 JS 校验直接 INSERT 同样被拦、空值不参与）+ `upsertShop` **局部更新且不碰账号列**；④ **记分与四态（2026-10-23，+4）**：老库 `shop.columns` v1 补 `score`（老行默认 0、数据不丢、幂等；用例**显式造旧形状**，否则 `dbMigrate(SCHEMA)` 直接建出带 score 的新表、`ALTER` 分支恒绿）· 四态写入 / 筛选 / `byStatus` 汇总 · 局部更新不把封店 / 退店改回启用 · 记分两位小数、缺省保持、显式 0 清空、非法值抛错 · **保证金（2026-10-25，+1）**：`shop.columns` 账本已到 v2、老形状同时缺 `score` / `deposit_received_at` 时两列都补上且老行默认 0 / `''`；写入 / 列表带出 / 漏传保持 / 带时间只留日期 / `2026-02-30` 归一空串 / 空串清空 · **删除保护（2026-10-26，+1）**：有专属条目 / 公共分摊行 / 已作废条目引用时 `deleteShopAccountGuarded` 拒删并引导停用，无引用时必须能删（正控制），拒绝分支断言店仍在 |
| `ledger:smoke` | **记账域 DB 层冒烟（46 项，2026-10-25 P0 + 2026-10-26 P2/P3/P4）** —— 建表幂等 / 预置科目不重复播种 · 相关人必填与同名拒绝 · 专属条目自动单行全额分摊 · 公共条目守恒断言（差 1 分也拒且整笔回滚）· 缺分摊 / 重复店铺 / 店铺不存在拒绝 · 日期与金额校验 · 重算幂等（分摊没变不虚动 `updated_at`）· 更新只改备注沿用现值、金额改了要求重新分摊 · **P2：金额改 + 重传分摊 → 旧行被替换（不叠加）且 ratio 同步**、**改店铺集合 → 被移出店不留幽灵行** · 汇总恒等式与三项体检 · 按店铺筛选走分摊行 · 作废不计入汇总但分摊行留库 · `eligibleShops` 排除退店 / 未开业 · 往来五个数与结算上限 / 幂等 / 撤销 · 相关人合并与停用 · 台账口径与 `src/lib/partyLedger.ts` 同构 · **P4（+12，`docs/notes/2026-10-30-ledger-parties-and-settlement.md`）**：**预览把未结算 / 已结算分开计数**，且两条路各给一个「原人改挂后剩多少」（不能是同一个数）· **预览把「不存在」与「已作废」分成两个清单**（混成一个就不知道该提示用户哪一句）· **A 路 `move-all`** 只在全未结算时放行、余额随条目一起过去 / 遇已结算条目**整笔拒绝且一个字节都没改**（事务回滚，不是改了一半）· **B 路** 只改挂未结算、已结算的留在原人与原单，且**全程不写 `bk_transfers`**（余额随条目走，再写一笔结转等于算两遍）/ 「全都已结算」时拒绝并指向 C 路 · **C 路** 缺原因被拦、填了原因则作废结算单 + 条目恢复未结算后改挂 / **连带披露**（同单账牵连恢复未结且不跟着改挂）· **非法入参各自拒在门口**（7 个 `throws`：目标人 id 为 0 / 不存在 / 已停用 / 就是原属 / `mode` 不认识 / 选中已作废条目 / 条目 id 不存在；预览另断言空集 `entryIds: []` 报「至少选择一条」）· **单店取数** 三卡 = 专属 + 本店公摊，且与汇总 `byShop` **同源同数** / 作废不计入、空月份给全 0、非法入参直接拒 · **体检能变红**：人为制造漏摊，`allocationGapCents` / `partyGapCents` / `publicPoolCents` / `brokenEntries` 各自报出对应的差额（不能互相顶包）。⚠️ 本域冒烟抓到过两个**真在生产代码里**的错（详见上面笔记）：`ORDER BY expense` 是重构后遗留的**旧列名**（表里只有 `direct_expense` / `shared_expense`，SQLite 在运行时才报 `no such column` —— 类型检查与 lint 都抓不到）；C 路的改挂后余额用**选中条目**金额算，而作废是**整单**的 ⇒ 会漏扣被牵连的那部分 |
| `db:inventory` | **稳态表清单（非断言型，2026-10-22）** —— 临时库 + 逐域 `ensure*Schema()` → 按域打印新库直建的形状并报「对象 / 表 / 业务表 / 内部表」计数；任一 ensure 抛错 `exit 1`。存在的理由是 §6「怎么数」：以前靠 grep `CREATE TABLE IF NOT EXISTS` 处数减去注释/冻结 DDL 手推，**每加一张表或把建表改成模板拼装就要跟着改推算式，改晚了文档就说谎**（本仓已错过三次）。口径陷阱：FTS5 本体在 `sqlite_master` 里是 `type='table'`，别双计 |
| `shop-item:smoke` | **店铺商品快照 DB 层冒烟**（`pl_shop_items` / `pl_shop_store_keys`：采集落库 / 两家未登记店采到同一商品不互相覆盖 / 展示名键 → 已登记店的收养记忆 / 认款写路径不混用） |
| `product:sku:smoke` | **「店铺商品ID → 产品」映射层冒烟（41 项，P3；2026-10-05 补 8 条「人工核对回流」；2026-10-08 补 6 条「认款顺手采纳款主图」+ 2 条「按款反向过滤」；2026-10-10 删 6 条「本页汇总」、补 2 条「补色通道」）** —— 含产品库 P3 的两条验收原文（"1000 行陌生订单全部进队列不丢行" / "批量确认后二次导入 100% 命中"）。⚠️ 删掉的那 6 条测的是 `resolveOrderSkuRollup`（核对页指标条的产品维度），它随指标条整条退场（`electron/product-db.ts` 里那个函数与 `MAX_ROLLUP_ROWS` / `OrderSkuRollup` 一并删除）；**它测的规则没有消失** —— 店铺原文 → 实体走 `resolveShopRef`、(平台,店铺,商品ID) → 产品走 `resolveSkuBatch`，两条在上面的用例里都还在。**回流那 8 条**：写入（款+色 / confirmed / 店铺锚点是归一后的实体）· 两个款各指各的 `pl_products.id`（锚点取错会张冠李戴）· 顺带回填存量未归款订单 · **已有别的产品映射时只回报冲突、一行不动**（含 `deepStrictEqual` 证明连 source/更新时刻都没刷）· 颜色为空/占位只记款级 `*` · 已有**款级**映射时点名带色 → **替换**款级行（不并排留一条永远命不中的旧行）· 重复点名回报 `already` 不写第二行 · 三条"不写"分支（无商品ID / 店铺未归一 / 产品库没这个款）· **补色通道 2 条（2026-10-10，`docs/notes/2026-10-30-mapping-color-and-replay.md`）**：改绑补色 → 挂占位「未分类」的存量订单跟着补成该色、且**不留旧映射行**（改色 = 替换同一条绑定）· 边界：同商品多色绑不同产品 → **新增**绑定（不替换既有行）。两条都用真实落库路径（`insertOrder`）造单，并经变异确认非空转（拆「同产品一条行」分支 / 回填范围退回「仅未归款」都会变红） |
| `style:smoke` | **款式主数据权威冒烟（22 项，P3 的 D1）** —— A 老库交接 / B 写侧唯一 / C 读侧五处派生 / D 订单导入接 `resolve` |
| `ae:smoke` | 成本口径冒烟（**C2 删表后收窄**；条数由脚本自计）：① 新库 `ensureAeSchema` **不再建** `ae_cost_map`、汇率表照常；② 拿货快照源头按 **(款, 拿货日期)** 分组（同款两次进货 = 两行，非 `submitted` 单排除）；③ 采集帧落**唯一订单主干**（件数真值 / 规格解析 / 整单收入折分 / 缺汇率金额为 NULL 且 `rateMissing` 计数 / 重推幂等 / source 三态过滤 / 弃表 `ae_orders`·`ae_order_lines`·`ae_fees` 已删）；④ `ensureOrderSchema` 跑完仍无 `ae_cost_map`。原「价目表迁移 / 导入语义 / manual-costs / 产品镜像」四组随表与写口删除（2026-10-21） |
| `ae:settle:smoke` | **结算明细冒烟（10 项，2026-09-29）** —— `ae_settle_lines` 落库幂等（幂等键 = 订单号+商品id+sku id；重导 = update 而非重复行）· **行类型由 `商品id` 是否为空判定**（不信入参自报）· 空订单号逐行 `failed` 不整批回滚· **订单口径优先取订单级行**（两类行不可相加）· **`items` 件数明细**（`lines` = 该 (订单,商品) 的商品行数 —— 存量测试确认去掉`lines++` 会变红）· `qty` 缺省/0/负数 → 1· `settleStats` 计数 |
| `picking:smoke` | **拣货投影冒烟（19 项，2026-09-30 / 2026-10-05；2026-10-10 实现侧修 `styleName` 读错表〔`oi_styles.name` 不存在 → `LEFT JOIN pl_products` 取 `name`〕，断言未变）** —— `pickingRows` 是跨四张表的只读投影，错了都是静默的（图全空/待拣单不见了页面照样渲染）。覆盖：**未发货只认机械事实**（`ship_time` 空 且 `status<>'shipped'`；`includeShipped` 打开时照收）· **关闭单与无日期行本层不许筛掉**（口径在渲染层，存量测试确认改成 `1=1` 会变红）· **图三层回落**（覆盖图 > 订单图 > 款主图，占位图 `local_path=''` 时继续回落）· 识别链款编码/款色（映射命中 → `autoAssignByMap`）· 缺 `suppliers` 表降级不抛 · 店铺过滤 / 上限钳制 / 脏 `raw_fields` 不毁整批 · **映射带颜色**（`pl_shop_sku.spec` 承载颜色 → 归款写进款色 → 投影 `color` 回落款色；含三条易假绿的判据：**带色行优先于 `*` 行**、**映射写入后回填存量订单**、**回填不碰已定色**（2026-10-10 起占位色「未分类」会被补色 —— 该判据覆盖的是"有别的真实色"这层保护；见 `docs/notes/2026-10-30-mapping-color-and-replay.md`），以及"缺省 `spec` 行为不变"的回归）。⚠️ 夹具必须与线上同形状 —— 曾经因建表带 `oi_styles.name` 而线上已 `DROP COLUMN`，导致**冒烟恒绿、线上必崩**（见 `docs/notes/2026-10-30-mapping-color-and-replay.md`） |
| `picking:xlsx:smoke` | **拣货单带图 xlsx 冒烟（15 项，2026-10-05，S3）** —— **界面冒烟验不到产物**（它只能断言"渲染层传了什么"），这个脚本**读回 zip 本身**：产物是合法 zip（PK 魔数）· **一个厂家一张 sheet**（未指定厂家自成一表、不混进任何厂家）· **媒体扩展名跟着「内容」推**（jpeg / png / webp；⚠️ `addImage({filename})` 忘给 `extension` 会写成 `xl/media/image1.undefined` 且包结构不合法）· **`[Content_Types].xml` 声明了 `image/jpeg` 且无 `undefined`** · 表名与顺序读回来 = 传入顺序 · **各表的数来自各自的行**（不是同一批复制两份）· **无进价行读回来是 `null` 而非 0**（0 会被当成"这件免费"）· 每表末尾「合计」= 本表各行之和 · 有图才有 media 部件 · **文件源：内容是 PNG 但名 `.jpg` → 取 `png`**（按内容不按名）· 内容是 WebP → `webp` · 认不出/文件不存在 → **不嵌也不抛**。⚠️ 本脚本是"同一流程只调一次 `process.exit`"的**唯一先例**（失败后用 `exit(0)` 会把红报成绿，实测） |
| `purchase:xlsx:smoke` | **拿货单导出 xlsx 冒烟（26 项，2026-10-05）** —— `picking:xlsx:smoke` 覆盖的是**纯生成层**，本脚本覆盖 `purchase-export-excel` 的**调用点**（此前 `scripts/` 下没有任何脚本 require 过 `purchase-handlers`，而它当时带着与拣货单**同一个** exceljs `extension` 真 bug）。做法：真 handler + 真 exceljs + 假对话框/假窗口（`Module._load` 替身），只把 `order-db.findStyleColorImagePath` 换成可控映射。断言：入参护栏（非对象/`items` 非数组 → `invalid payload`；洗完没行 → `没有可导出的行`）· **取消保存 → 输出目录里一个 `.xlsx` 都不多出来**（不是"写了再删"、也不是写到某个默认路径）· `defaultName` 的 `\ / : * ? " < > \|` 全换 `_`、扩展名固定 `.xlsx` · 表名「拿货单」+ 9 列表头 · **单价 = `priceCents/100`、金额 = 数量×单价** · **`priceCents===0` → 单价/金额留空**（不是 0.00）· **`qty===0` → 实拿数量/金额留空**（0 件 ≠ 尚未填数）· 款色为空的行照常导出（只是不查图）· 只填款名的行不丢 · **媒体扩展名跟着内容**（PNG 内容名 `.jpg` → `imageN.png`；base64 源恒 jpeg，所以是 png 就证明走的是**文件源**分支）· 无 `imageN.undefined` · `[Content_Types].xml` 有 `image/png` 无 `undefined` · 有 drawing 部件 · 有图行设了行高 · **`items` 超 500 截前 500**（剪入参） |
| `preview` | `vite preview`（预览已构建的渲染层产物） |
| `goods:shot` / `purchase:shot` / `classify:shot` | **截图脚本**（无头 Chrome 出图给人工核对视觉；**不进断言门禁**） |
| `reset-dev-data` | **清库重跑（重构期）**：`node scripts/reset-dev-data.mjs`（默认干跑）/ `--yes`（先备份再清）。清 **45 张**业务+主数据表（2026-10-25 补入记账域 `bk_*` 十张；此前 2026-10-22 记 34 与脚本实测 35 就对不上 —— 以 `CLEAR` 数组为准），保留迁移记账/账号/企业/汇率；执行前拒宿主在跑（并发纪律）。⚠️ 不可逆动作由**人**执行 |
| `rebuild` / `postinstall` | `better-sqlite3` 原生模块重编译 |
| `lint` / `lint:fix` / `test` / `test:watch` / `format` / `format:check` / `verify` / `verify:docs` | 质量门禁（现状见 §10） |

> ⚠️ **所有 `*:smoke` 脚本必须用 `electron` 跑、不能改成 `node`**：`better-sqlite3` 是按 **Electron 的 Node ABI（149）**
> 编译的，系统 Node（ABI 127）直接 require 会抛 ABI 不匹配（而且**没有任何 `✗` 行** → 会被误判成"红在别处"）。
> 脚本自身先 `tsc -p tsconfig.electron.json` —— **改完 `electron/*.ts` 忘了编译就跑冒烟 = 在测旧代码**
> （真机探针抓到过：只跑 `vite` 不跑 `tsc`，主进程从 `dist/electron/` 加载到旧 preload，症状是 `ipc.shopList is not a function`）。
> ⚠️ 每个脚本的**成功路径末尾都要显式 `process.exit(0)`**：不写的话进程靠 Electron 崩退，退出码是 **SIGTRAP / 137**，
> 而 stderr 一屏 GPU/sandbox 报错会把结果行挤出视野（看起来像真崩了）。**判"脚本崩了"之前先单独看 stdout。**
> ⚠️ `ELECTRON_RUN_AS_NODE` 剥不剥**实测等价**（2026-09-27 对两个脚本各跑两遍：四种组合全部 exit 0、stderr 0 行、stdout 逐字一致）。
> 保留它更快（不拉 Chromium）；只有跑真机 `plugins:island:smoke` 才需要 GUI，那时加 `-- --no-sandbox --disable-gpu`。
> ⚠️ `plugins:island:smoke` 依赖 5173 的 dev server、**不自己拉起** —— **只起 `vite --port 5173` 就够**，
> 别用 `npm run dev`（那会再拉一个 Electron 抢 CDP 端口）。vite 在本机只绑 IPv6 回环（`localhost` / `[::1]` 通，`127.0.0.1` 不通）。
> ⚠️ **prettier 不在门禁里**：`format:check` 当前对 **336 个文件**失败（2026-10-22 实测；2026-09-27 曾记 151，仓库增长后已重测），是既有现状、不是回归
> —— 别把这个数当质量指标，它只说明"没人对全仓跑过 `--write`"（`AGENTS.md` / `CONTRIBUTING.md` / `vite.config.ts` / `tests/*.spec.ts` … 都在里面）。纪律两条：
> ① 别对"本来就不过"的文件跑 `format --write`（整篇 churn，与本次改动混在一起）；② 对当前干净的文件
> （`CHANGELOG.md` / `docs/decisions/*.md` / `docs/plans/*.md` / `docs/architecture/*.md`）改完**保持干净**，
> 判据 `git show HEAD:<file> | npx prettier --check --stdin-filepath <file>`。
> ⚠️ `--write` 之后**归一化 diff 非空时不要一律当噪声**：先看原始 `diff`，它可能是文档**结构错**的唯一信号
> （2026-09-27 实例：验收表被一个 `> ⚠️` 引用块从中间劈开、续行以 ` + ` 开头被当成列表标记）。
> ⚠️ 上述 `lint` / `test` / `format` 脚本**只是手动门禁**：`build` / `dist` 流程不串联它们，也无 CI（见 §10）。

### 插件市场的缓存纪律（★「已发布，但市场里看不到」的根因）

市场 catalog 与插件 zip 属于**同一 URL 内容会变**的易变资源，两侧都必须防缓存：

| 侧 | 位置 | 做法 |
|---|---|---|
| 请求端 | `electron/http-client.ts` → `downloadFile(url, dest, { noCache: true })` | 带 `Cache-Control: no-cache` 请求头，把「直接用缓存」降级为「回源验证」（没变走 304，变了拿新的） |
| 服务端 | `npm run market:serve`（`scripts/serve-market.mjs`） | 所有响应 `Cache-Control: no-store`，且**不发** `Last-Modified` / `ETag` |

**为什么两条都要**：静态服务只发 `Last-Modified` 时，Chromium（Electron `net` 走的就是它）会套用启发式新鲜度
`freshness = (Date − Last-Modified) × 10%`。catalog 隔两天没动 → 新鲜期就是 5 小时量级 → 期间宿主刷新市场
**连请求都不发**，直接吃旧副本。2026-09-24 实测症状：`shipping-rate` 已发布、`plugins-scan` 也正常，
但「插件中心 → 市场」仍只列旧条目（服务端与磁盘都是新的，只有宿主看到的是旧的）。

守卫：`tests/marketCache.spec.ts`（市场侧每处 `downloadFile` 必须 `noCache:true`；服务端必须 `no-store`
且不出现 `'Last-Modified':` / `'ETag':` 设置）。

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

全部文档已归入 `docs/`（2026-09-16 整理；**2026-09-27 按实际文件重列**）。根目录仅保留 `README.md` + `AGENTS.md`。文档地图见 [`../README.md`](../README.md)。

| 分类 | 文档 | 状态 |
|---|---|---|
| 规则（根） | `AGENTS.md` | 唯一规则源（含 §0 跨工具协作契约：共享层 / 私有层 / 收工两个动作） |
| 结论 | `notes/README.md`（+ `notes/YYYY-MM-DD-*.md`） | 活跃 —— 多 AI 工具共用的结论层，`verify:docs` 有反向索引守卫 |
| 基线 | `PROJECT_BASELINE.md`（本文件） / `archive/baseline/REFACTOR_PLAN.md` | 活跃 / 已完成归档 |
| 架构 | `architecture/PLUGIN_ARCHITECTURE.md` / `PLUGIN_DEVELOPMENT.md` / `UI_ISLAND_INTAKE_CHECKLIST.md` | 活跃（末者为 UI 岛接入 SOP + 故障速查 + 一键冒烟） |
| 业务 | `features/MAIL_INBOX.md` / `PROFIT_TRACKER.md` | 活跃 |
| 业务 | `features/PRODUCT_LIBRARY.md` | 活跃（P0–P3 + P4a 已落地，下一步 P4 成本界面 / P5 拣货） |
| 计划 | `plans/REMEDIATION_PLAN.md`（25/27 完成） / `PLUGIN_TRIAGE_PLAN.md`（T1–T6 完成） | 活跃 |
| 计划 | `plans/DOMAIN_INTEGRATION_PLAN.md`（S1 已实施，下一步 S2） / `SHIPPING_RATE_ISLAND_PLAN.md`（已执行） | 活跃 |
| 计划 | `plans/PAID_LICENSE_PLAN.md`（方案已定稿，未开工） | 活跃（付费授权：Pro 档功能 + 月/年双档订阅 + 零自建托管；三个执法闸门） |
| 决策 | `decisions/ADR-001-…`（岛设置留岛内） / `decisions/ADR-002-…`（主数据层） | 均已采纳（Accepted） |
| 审查 | `reviews/CODE_REVIEW_REPORT.md` / `HOST_REVIEW_2026-09-22.md` | 🗄️ 历史审计（对应发现项已转任务或已修） |
| 审查 | `reviews/ISLAND_COLD_START_AND_THEME_2026-09-22.md` | 活跃（结论已固化进 §11-10） |
| 用户 / 需求 / 归档 | `guides/USER_GUIDE.md` / `archive/requirements/Requirements.md` / `archive/manual.md` | 活跃（覆盖面偏旧）/ 历史档案 / 已归档 |

> 现存 **149 个 `.md`**（含 `docs/README.md`；2026-10-22 实测：architecture 3 / archive 1 / baseline 2 / decisions 2 / features 3 / guides 1 / notes 106 / plans 17 / requirements 1 / reviews 12）。判据是 `find docs -name '*.md'`，**不是记忆**——
> 这张表历史上长期只列 10 行、漏掉 `plans/` 与 `decisions/` 两个整类，正是靠这条命令发现并订正的。
> （2026-09-30 订正：原写 27，实测本轮改动前已为 32 —— 计数未随文档增删同步，属既有漂移；
> 2026-10-22 由 34 → 149，增量几乎全在 `notes/`。⚠️ **上表只是粗粒度地图**，按主题找文档的权威入口是 `docs/README.md`。）

---

## 10. 质量门禁现状（重要）

| 门禁 | 命令 | 现状 |
|---|---|---|
| 类型检查（渲染层） | `npx vue-tsc --noEmit` | ✅ 0 error（含 `.vue` 模板；`strict: true`） |
| 类型检查（主进程） | `npx tsc -p tsconfig.electron.json --noEmit` | ✅ 0 error。⚠️ 该配置 `strict: false`（隐式 any 不拦；`noImplicitAny` 已开） |
| Lint | `npx eslint .` | ✅ **0 error** / 608 warning（绝大多数 `no-explicit-any`，非阻断；2026-10-26 P4 实测，同日 P3 记 596 —— **+12** 发生在记账 P4 的批量操作条 / 三路弹层 / 单店与汇总页签 / `electron/ledger-xlsx.ts` 这一批新增界面（记账模块 `src/modules/ledger` + `electron/ledger-{xlsx,handlers}.ts` 现共 **22** 条 warning，未逐条溯源到文件）。轨迹：10-23 记 521 —— +74 主要来自记账 P1 新增的约 2,600 行界面代码，未逐条收敛。2026-10-11 为 477 —— 之后 UI 岛回收为内建模块 + 本轮依赖升级带来一批准入代码，warning 未随之收敛；⚠️ 基线是 **0 error**，新增的 `error` 级命中一律当回归（2026-09-27 被 `no-irregular-whitespace` 抓过一次：注释里"看着像空格"的全角 U+3000 真会报错） |
| 单元测试 | `npx vitest run` | ✅ **49 文件 / 974 用例**（2026-10-26 **P4 实跑，与同日 P3 同数** —— P4 的批量变更三路、单店/汇总取数、xlsx 导出全在主进程与界面层，没有新的 `src/lib` 纯函数；该轮唯一的测试文件改动是 `tests/uxEntryNames.spec.ts` 的**豁免表**（新增 `往来` =「记账」页内四页签之一，同 `运费查询 / 款与商品` 判例；临时用来定位「相关人」那条误报的豁免在文案改掉、命中消失后**已删** —— 留着会削弱守卫）。P3 实跑 49 / 974：相对同日 P2 的 49 / 969 净 **+5**，即 `tests/partyLedger.spec.ts` 22 → 27：`runningUnsettled` 时间线滚动余额〔乱序入参按原始下标回填 / 同日序号定序 / 作废事件不动余额 / 非法类型抛错〕，与 `partyBalance` 的累计值对得上一处）。同日 P2 实测 49 / 969（相对 10-25 的 48 / 958 净 +1 文件 / +11 用例 —— 记账 P2 新增 `tests/ledgerRevenue.spec.ts`（9 例：营收→店铺 id 的归属，未登记 / 同名多店 / 未写店铺 / 关闭单 / 缺金额 / 截断六类分桶），另 +2 为本分支同期其他改动）。2026-10-25 实跑 48 / 958（相对 10-23 的 45 / 875 净 +3 文件 / +83 用例 —— 记账域新增 `tests/ledger.spec.ts`（26 例：分摊守恒 / 公共分摊按权重 / 元→分 / 舍入余数落地）与 `tests/partyLedger.spec.ts`（22 例：相关人台账与结转口径），其余来自本分支同期其他改动（**未逐条溯源**）。872 那次实测：相对 2026-10-22 的 43 / 827 净 +45 用例 —— 本轮 +9 为 `tests/skuMatrix.spec.ts`〔缺口合并 / 幂等 / 竞争值〕，其余 +36 为本分支 10-22 后累计，**未逐条溯源**）。下述历史轨迹**截至 692** —— 那是 2026-10-21 前的最后一次记录，2026-10-22 实测已到 827〔含当时新增的 `tests/skuWeights.spec.ts` 4 例〕。⚠️ **总数会随别的改动浮动，跑一次门禁为准**。environment: node，无 jsdom）。2026-10-10 同日第三轮（卡片网格 +「复制给厂家」）：新增 `tests/pickingSheet.spec.ts` 11 例（发厂清单图模型：`sheetModelOf` 走 `pendingOf`〔无货返回 null〕· 按厂家过滤 · 金额与无价措辞与屏上 / 导出 **三方共用**同源 · 夹具放**两个时间区间**让 Σ(码×价) 与 还差×均价 可区分〔只放一个区间则两种实现都绿〕）⇒ **36 / 678 → 37 / 689**；同日第二轮（用户重设计）`tests/picking.spec.ts` 增补款色聚合与待拿口径用例 ⇒ 36 / 663 → 36 / 678。2026-10-10（工作区）：拣货并入拿货 —— `tests/picking.spec.ts` 32 → 44（已拿按款色码扣 / 忽略按款色整组 / 还差夹到 0 / `takenKey`/`ignoreKey` 与宿主行粒度逐字同源）；同工作区收尾 `tests/productImport.spec.ts` 58 → 82（导入模板改列 / 进价 / 克重广播）与 `tests/shipRateOrders.spec.ts` 18 → 19（+1「有克重但没商品ID 仍照常计价」，其余措辞去「商品ID」）⇒ 上次已提交快照 626 起净 +37 = **36 / 663**（⚠️ 旧文里记的「644」是 10-09 的**工作区中间快照**、非提交点，别拿它当基准）。2026-10-09 产品模板加「进价」列：`tests/productImport.spec.ts` +18（元→分换算 / 空≠0 / 非法剔行 / 同款合并取先出现值 / 导出→导回闭环）⇒ **36 / 626 → 36 / 644**。2026-10-09 产品导入模板改列：`tests/productImport.spec.ts` 按新口径重写（表头族 / 顺序对应 / 同款合并 / 抽图归位 / 提交路径 skuErrors）+ `uxEntryNames.spec.ts` 登记「图片」列名 ⇒ **36 / 593 → 36 / 626**。此前：2026-10-08 晚随「货与成本」R3 新增 `tests/goodsFirstRun.spec.ts`（8 例，首启卡判据的真值表，含 `queueGroups: null` 必须为 false 的反例）⇒ **35 / 585 → 36 / 593**；同日晚些时候同一次重构删掉 `tests/goodsFlow.spec.ts`（引导条与 `flow.ts` 一起撤除）⇒ 36 文件 / 594 用例 → 35 / 585；此前基线记的「35 文件 / 583 用例」是更早的快照（未含 S1 前后几次新增）。2026-10-05 深夜新增 `tests/visionPrompt.spec.ts`（+1 文件）并在 `orderClassifier.spec.ts` 补描述式颜色 13 例；此前一次减法的原因见 `CHANGELOG.md` 2026-10-05 的 Removed 段（删了 `aggregator` / `templateEngine` 两条 spec = −2 文件 / −46 用例）。⚠️ **node 环境 import 不了任何经 `@/core/services/ipc` 的模块**（它顶层求值 `window.electronAPI`）⇒ 要单测的纯逻辑必须自己不依赖它，先例即 `visionPrompt.ts`（**2026-10-22 例外**：`vi.mock('@/core/services/ipc')` 后可直接测服务层 —— `tests/skuWeights.spec.ts` 用这个办法钉住"产品库必须拉全，不许只取前 500 款"） |
| IPC 契约（`verify` 第①条） | `npm run verify` | ✅ **234** 声明 / **229** 通道，`✅ IPC 契约一致`（2026-10-26 P4 实测；广播 3 处。相对同日 P3 的 230/225 净 **+4**，全部为记账 P4 的 `ledger-repatch-preview` / `ledger-repatch-execute` / `ledger-shop-summary` / `ledger-export-excel`〔`ledger-handlers` 18 → 22〕。相对 10-25 的 230/225：+18 记账 P0。2026-10-12 为 192/188，+15 集中在 mail / shop-item / company / backup / updater 与当时 C2 的写口搬迁）。轨迹：2026-10-11 为 191/187；2026-10-12 +1 `order-reopen-corrected`（归类核对「退回待核对」→ `order-handlers` 38→39）→ 192/188；2026-10-10 −1 删 `order-sku-rollup`（随核对页页头指标条退场）→ 189/185；+1 `write-clipboard-image`（「复制给厂家」写系统图片剪贴板 → `main` 13→14）→ 190/186；剪贴板两条通道从 `main`（14→12）外提到 `clipboard-handlers`：2（190/186 不变）；+1 `purchase-style-images`（拿货单行图取图）→ 191/187。2026-10-09 P4 +2：成本维护界面的 upsert / delete-manual。⚠️ `verify` **不止这一条**（短路按序）：② 店铺写入点必填字段（`check-shop-upsert-fields.mjs`）· ③ 跨域数据访问（`check-cross-domain-edges.mjs`，见下行） |
| 跨域数据访问（`verify` 第③条） | `npm run verify` | ✅ **6 处 `require('*-db')` 全带类型标注 / 9 条 `db→db` 边与在册清单逐条一致**（2026-10-23 实测；2026-10-15 建，P1-4 收口时 6 条，此后新增 `product-db → shop-item-db`〔店铺商品快照反查〕、`shop-item-db → shop-db`、`shop-product-db → product-db` 等）。规则：`require('<路径>-db')` 必须带 `as typeof import(<同路径>)`（不带就是 `any`，被调模块签名改了**编译期零报错** —— 实测 `findStyleColorImagePath` 的 `color: string→number` 改前 `tsc` 退 0）；`db→db` 静态 import 边要逐条在册（含**取用的符号**，用途悄悄扩大也会红）。两条都有空转守卫（脚本常量：require ≥ 3 / 边 ≥ 4）。 |
| 文档链接 | `npm run verify:docs` | ✅ `✅ 无悬空引用`（历史文档里"已删除/从未存在"的陈述走脚本白名单）；2026-09-30 起含 **④ 反向守卫**：`docs/notes/*.md` 命名合规 + 已登记索引，零条目时显式打印"未验证任何内容" |
| UI 岛冒烟（真机接线） | `npm run plugins:island:smoke` | ⚠️ **未重跑（2026-10-22）**——仓库在架的岛已只剩 **2 个**（`ae-profit` 1.1.0 / `excel-copy` 1.0.0；`shop-accounts` / `shipping-rate` / `product-library` / `order-insight` 均已下记为宿主模块，最近一次 `6/6 岛` 是 2026-09-30 的存量岛口径）。冒烟脚本仍可用，但它**按 `<userData>/plugins/` 已装的岛**跑，仓库只剩 2 个岛 ≠ 机器上装了几个 |
| UI 岛冒烟（无头 Chrome） | 手工（见技能 `esm-spa-headless-smoke`） | **岛侧现已无冒烟** —— `shipping-rate:ui` 于 2026-10-15 随岛回收整体重写成**宿主形态**（见上表，已归入宿主页那一组）；在架的 `excel-copy` 仍无冒烟。宿主页现为 `today:ui` / `goods:ui` / `order-profit:ui` / `master-data:ui` / `shipping-rate:ui` / **`ledger:ui`（2026-10-25 新增；2026-10-26 P4 扩到宽 / 窄 **160 / 162 条**〔合计 322〕，在 P3 之上加：**批量勾选**（没勾选不出现批量条 / 全选只勾有效条目并给出条数与金额合计、作废两条不参与 / 再点取消全选连表头勾一起掉）· **变更相关人三路**（A 路全未结算直接改挂、B 路含已结算只改挂未结算、C 路撤结算后改挂 —— 每路都拿**假桥按主进程同规则预演**的数比对界面，且断言目标下拉的**候选集本身**〔排除原属人 + 排除已停用〕、推荐与禁用理由、请求参数、落库后的真实数据〔非乐观更新〕、C 路连带披露与撤销原因必填、三路走完**整月三个数一分没变**）· **单店页 / 汇总页**（三卡 = 专属 + 本店公摊、四分项相加、与汇总页**同一套数**、公共池与三条体检恒等式 + 人为造红各自报数）· **导出**（按钮写明导多少条、载荷行数与三个合计跟屏幕同源、按筛选导出改表头与合计、点保存对话框的取消**不报失败**）；P3 扩到 108 / 110 条〔合计 218〕：明细页 + 记一笔三形态 + 相关人与科目 + 明细展开 + 营收占比与统计页对平〔关闭单 / 未登记 / 未写店铺 / 缺金额分桶〕+ 方案保存-套用-回开往返 + 改金额按原比例重算 + 守恒失败留在弹层内 + **往来页签：台账恒等式（全期间，含已停用）/ 抽屉六个数与时间线滚动余额 / 结算往返〔请求不带金额〕/ 重复结算被拒〔错误留弹层〕/ 撤销原因必填且单据保留、条目恢复未结**；P2 时 78 / 80 条〔合计 158〕；`picking:ui` 于 2026-10-17 随「拣货」摘出左导航退役）。⚠️ 原列的「`order-insight` 37 项断言」随该岛 2026-10-05 下架删除 |
| CI | — | ❌ 无 `.github/workflows` |

### 10.1 守卫分布（别重复加同类 spec）

| spec | 例数 | 守什么 |
|---|---:|---|
| `tests/pluginTriage.spec.ts` | 36 | 插件契约**双向**（调用 ⊆ 声明 + 声明了必须真调用）+ 岛能力缺口 + **db 能力域 op 预算**（超预算的三个域进 `GRANDFATHERED` 冻结，只允许变少） |
| `tests/shipRate.spec.ts` | 50 | 运价表归一化与计价：17 段互斥 / 大包回溯不得越类别起点 / 非普货不得归入普货 / `暂无服务` 不算脏数据 / 两种计价与进位边界 / 载荷预算 / 自动选表 / 表头版式族 1~3 行 / 最低计费重量 / 非本币拒算 / 行式分档表整节拒绝 |
| `tests/shopSku.spec.ts` | 27 | 「店铺商品ID」的归一键 |
| `tests/productImport.spec.ts` | 82 | 产品库导入的解析与逐行校验（表头族定位〔含横幅之后〕/ 列序对应 / 同款合并 / 抽图归位 / 提交路径 skuErrors / **进价 元→分**〔空≠0 / 非法剔行 / 导出→导回闭环〕/ **克重广播与颜色×尺码笛卡尔积** / 厂家名对不上 id 时**不猜**、标「会新建」 / 手改出的重复编码同样被拦 / 状态中英映射 / 导出表头钉字面量） |
| `tests/shipRateOrders.spec.ts` | 19 | 按订单算运费的数据衔接（国名解析 ISO·别名·前缀包含三路径 / `raw_fields` 键名回落 / 拒算五分类且 `reasonClass` 绑到行 / **有克重但没商品ID 仍照常计价**〔克重不从商品ID 取〕） |
| `tests/shopName.spec.ts` | 15 | 店铺名归一（零宽字符 / BOM / 全角空格 / 连续空白合并；**不做**大小写折叠、**不做**模糊匹配；每条"应等价"都配一条"不得等价"的反向断言） |
| `tests/importDetect.spec.ts` | 9 | 统一导入的**纯检测层**（四类文件的判据 + **判定顺序**（混合文件落更具体的那类）+ 认不出时说出「扫过哪些表」；报价单用**真实 21 张表夹具**）|
| `tests/mangoPendingImport.spec.ts` | 17 | 芒果店长待发货订单导入：识别判据**点名到子类** / 主图列 `detectImageColumnStrict` **不回落第一列**（负向：无图列报表不得被当成有图列）/ 真实 16 行夹具拆成 17 行的逐列对齐（图片·尺寸·商品ID）/ 件数 / 金额提列 / 一行→字段（店铺名落 shop、URL 必 trim） |
| `tests/orderCost.spec.ts` | 75 | 「订单成本」纯计算层：成本按生效区间取（同日 `manual` 优先 / 无命中回落最早一条）+ **缺口逐行标**（country/weight/rate/style/cost/**qty**/**fx**）+ **任一分项缺失则 `total = null`**（0 与"不知道"必须分开，否则"缺成本"会显示成"零成本的高利润"）+ **⭐ 缺金额按 `source` 拆两档（2026-10-15）**（`collect` + 金额 NULL ⇒ `fx` 缺汇率〔去补一条汇率即可〕；`import` + 金额 NULL ⇒ `revenue` 缺收入〔报表里就没有〕—— 用例**两个输入只差 `source`**、期望缺口必须不同，并把两档并成一个 key 的实现会当场红）+ **件数口径**（结算商品行真值 → 报表块内 `商品数量` → 按 1 件并标缺；且件数**不进算术**）+ 维度汇总（款/国家/店铺/**SKU 款×色×码**/供应商/桶，含 `pieces` 件数合计） |
| `tests/picking.spec.ts` | 44 | 「拣货单」纯层：**分组键与件数口径与利润页同源**（`skuKey` / `resolveQty`）+ **范围口径**（已终结剔除 / 超窗剔除 / 无日期照收，三者都计数；两种日期写法都认）+ 缺口逐组计数（缺图/缺件数/缺供应商/未识别款）+ 排序确定（件数降序 → 键升序）+ 进价与预估金额 / 按厂家分组 + **已拿 / 还差 / 已忽略**（`takenKey`/`ignoreKey` 与宿主 `outstanding()` 行粒度**逐字同源**〔`|` 拼接原样字符串〕：已拿按**款色码**扣〔同款同色另一码不受影响〕· 忽略按**款色**整组 · 还差**夹到 0** · 已拿不影响件数/金额 · 脏入参当"没有"） |
| `tests/pickingSheet.spec.ts` | 11 | 发厂清单图（屏上 / 复制给厂家的 PNG / 导出 xlsx **三方共用**的模型层）：`sheetModelOf` 走 `pendingOf`（**无货返回 null**，不给厂家发一张空单）· 按厂家过滤只收本家行 · 金额与无价措辞（`money` / `amountText` / `noPriceNote`）与屏上同源 · 夹具放**两个时间区间**让 Σ(码×价) 与 还差×均价 可区分 |
| `tests/orderRowSplitter.spec.ts` | 28 | 一订单多产品拆行（两种多产品信号 / N 的兜底 / 缺图判定）+ **`parseRowQty` 件数提取**：只认这一行自己的商品信息块，多块原文与「数量」列（拆行后仍是整行值）一律拒绝 —— 猜错就是把拣货件数与成本放大 |
| `tests/settleImport.spec.ts` | 17 | 「结算明细」解析：按（商品id + 结算状态）选表 / 行类型由 `商品id` 是否为空判定 / 两条等式校验仅在"已结算且无退款"上生效 |
| `tests/skuWeights.spec.ts` | 4 | **克重取数必须拉全**（服务层，`vi.mock('@/core/services/ipc')`）：产品按 500/页翻页（620 款时第 2 页必须被取到）+ SKU 按 5000 id/批分批；**任一分页/分批失败 ⇒ 返回空表**，不许返回半个表（半表会把有重量的行误报成缺口）—— 夹具两个应结果不同的输入（有/无第 2 页），只取首页的实现当场红 |
| `tests/aeMoney.spec.ts` | 14 | 采集链金额口径纯层（`electron/aeMoney.ts`，**单一口径源**：`ae-db.upsertOrderBatch` 与 `order-db` / `shop-item-db` 共用）：收入 = 商品+买家运费−退款 · 行收入**按行金额占比**分摊（缺失才回落 qty，再不行平分）· 汇率为 0/缺失 → `null`（不折成 0）· `skuProps` 只解析能确定的 |
| `tests/orderMoney.spec.ts` | 10 | 订单金额单元格解析（`CN￥ 1,234.56` → 分 + 币种；空 = null 不是 0）与状态/时点列族提取 |
| `tests/uiIslandBridgeLifecycle.spec.ts` | — | UI 岛接线：切岛重建桥 / 运行时随包分发 / 双端协议一致 / 启动时扫描先于恢复上次模块 |
| `tests/uiIslandThemeTokens.spec.ts` | — | `WB_THEME_TOKENS` 必须覆盖 `index.css` 的每个令牌（漏项 → 岛内 `var()` 解析失败，见 §11-6） |
| `tests/marketCache.spec.ts` | — | 市场侧每处 `downloadFile` 必须 `noCache:true`；本地市场服务必须 `no-store` 且不发 `Last-Modified`/`ETag` |
| `tests/uxEntryNames.spec.ts` | 2 | **悬空入口名**（UX 审查 C4 的机器化）：宿主文案里"去 / 在 / 到「X」"式引用必须是真实入口（宿主模块名 ∪ 岛 `displayName` ∪ `ALLOWED_NON_ENTRY` 里逐条写明理由的控件名）；**自证非空转**（零命中即失败，防模式写坏静默通过）；先剥注释（本仓注释里大量引号名） |
| `tests/pluginManifest.spec.ts` | — | 真实投产 manifest 的 schema 校验 |
| `tests/ledger.spec.ts` | 28 | 分摊引擎纯层：守恒（合计 = 条目金额，差 1 分也拒）/ 尾差落在最后一家 / 平均与手工权重 / 元→分与非法金额抛错 |
| `tests/partyLedger.spec.ts` | 27 | **资金相关人往来（守资损）**：五个数与分方向余额（`分方向之差 ≡ 净额`）/ 作废条目与作废结算单不计入 / `canSettle` **方向**必须与余额同侧（只校验金额会把"越结越欠"放过去）/ 上限按该方向余额而非净额 / 混方向两笔各自可结 / `settlementAmountOf` 只做条目求和 / 全量恒等式 `Σ净往来 = 收入 − 支出` / **P3：`runningUnsettled` 时间线滚动余额**（乱序入参按原始下标回填、同日按序号定序、作废不动余额、非法类型抛错，累计值与 `partyBalance` 对得上） |

### 10.2 六类「门禁全绿也看不见」的盲区（逐条踩过，别重复踩）

1. **渲染层必须用 `vue-tsc` 而非 `tsc`** —— 后者不检查 `.vue` 模板，模板里引用的未定义变量会被静默放过。
2. **「用例全绿」≠「守卫有效」** —— 解析 / 归一化类改动要再跑一次**变异测试**（逐条把实现改坏，确认对应用例**真的变红**）。已现形三类假守卫：
   - 对称交换两个计数器**不破坏汇总断言** → 分类结果要**逐行可观测**（给行带 `reasonClass`），断言钉在行上；
   - 两条解析路径**互为兜底**时只断言结果会蒙对 → 用例要选**只有该路径能到达**的输入（2 字符短拼 → 别名专属；带注记的长名 → 前缀专属）；
   - 判据正则**不能用 `\b` 收尾**（`/([A-Z]\d+)\b/` 匹配不到 `D4a`）→ 真失败被漏数后**方向反着报**成"假守卫"。
3. **判据必须先剥 ANSI** 再匹配 `Tests\s+(\d+) failed`。vitest 的彩色输出里数字两边夹着转义码
   （实为 `Tests\u001b[22m \u001b[1m\u001b[31m1 failed`），直接匹配**恒失败**，会把好测试误报成假守卫。
4. **时序类断言只在 `onMounted` 体内比对调用点** —— 对全文件 `indexOf('pm.discoverExternal()')` 命中的是函数**定义**，
   会得到"永远绿"的假守卫。
5. **跨域读表的冒烟断言必须先 `ensureXxxSchema()`**；且 `scripts/*-smoke.cjs` 只能用 `electron` 跑（系统 Node 抛 ABI 不匹配，
   而且**不产生任何 `✗` 行** → 会被误判成"红在别处"）。
6. **变异脚本自身要有两道自检**：基线必须绿 · 收工必须复原（比 sha256）。2026-09-27 实测：
   上一轮某条变异的残留（未跟踪的岛目录里一个多余 op）让下一轮 M00 对照直接变红，而 `git status` 因为该目录**整体未跟踪**而看不见
   —— 整轮结论全部失真。

> 回归保障 = 上表可自动化的门禁 + 无头冒烟。改动 `src/lib/` 与插件契约时应同步补测；
> 投产 manifest 的 schema 校验、令牌注入清单的覆盖性均已由 spec 兜住（§10.1）。
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
    四条不可回退的纪律：
    ① iframe 端 `hello` **必须一直重试到 boot 落地**，不得设放弃阈值（宿主监听器注册可能晚很多）；
    ② 岛侧 `bridge.js` 的 `ready()` 必须真正等待 boot 完成 —— `window.__sk.ready` 是 **Promise**（恒为真值），
    误当布尔判断会让岛在握手前挂载，首屏用浅色回退令牌且首个数据调用永久挂起（表现为"样式与宿主主题不一致 + 永久加载中"）。
    ③ 宿主收到 `hello` **不得轮转 token**（`repostBoot` 复用）——iframe 的 `load` 早于 `hello` 到达时，
    安全网已发过 boot，轮转会把岛**已在途**的首批 call 判成串台；再叠加"token 不匹配静默丢弃"，
    就是「冷启动必须手动点『重新加载』才出数据」的完整成因（2026-09-22 修，守卫 `tests/uiBridgeHost.spec.ts`）；
    ④ `color-scheme` 不在令牌里：boot/theme 载荷必须带 `theme.mode`，运行时写进 iframe `<html>` 内联样式
    （否则深色下岛内原生控件仍是浅色，见 AGENTS.md §1.6）。
11. **外置 manifest 校验上限** — `externalManifest.ts` 的 `MAX_ACTIONS`（单 capability 动作数上限）与 `DB_OPS` 登记表规模挂钩；
    新增业务域导致单域 op 数增长时需复核。`tests/pluginManifest.spec.ts` 会对真实投产 manifest 跑 schema 校验。
12. **UI 岛的「静默失效」四则**（原实例是 `ui-plugins/order-insight/dist/`，2026-09-22 一次性修掉；
    ⚠️ **该岛已于 2026-10-05 整体下架**，但四则都是「手写岛通用」的坑，对现役的 `excel-copy` / `shipping-rate` 同样成立）：
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
    前三者原由该岛的无头冒烟（37 项断言，夹具见技能 `esm-spa-headless-smoke`）+ `tests/pluginTriage.spec.ts` 的反向断言兜住；
    岛下架后**断言面搬到了内建侧**（`npm run today:ui`），而 `pluginTriage` 里那组反向断言已删（等价守卫现在在
    `purchase.ts` 的 TS 类型里，编译期比扫字符串更强）—— 四则作为**手写岛的写作纪律**保留。

13. **UI 岛的 CSP 决定了「能力边界」**（不是实现偏好，是硬约束）——
    岛运行在 iframe 里，文档 CSP 是 `script-src 'self'`（`electron/plugin-ui-protocol.ts`），**没有 `'unsafe-eval'`**。
    后果：
    - **任何需要求值 JS 字符串的功能都不能写在岛内** —— 既不能 `eval` 也不能 `new Function`。
      `excel-copy` 的 `jsExpression` 字段规则正是这种形态，因此求值留在宿主（`db` 域 `applyRules` → 复用 `src/lib/fieldProcessor.ts`），
      岛只负责"收集参数 → 调用 → 渲染返回值"。
    - **同理不要指望"顺手在岛里装个库就行"** —— 岛无打包步骤（`dist/` 即源码），依赖需手写进静态文件。
      `excel-copy` 的 Excel 解析因此走宿主已有的 `src/lib/excelParser.ts`，避免两端口径漂移。
    - **例外只有一条，且必须精确**：`img-src` 至今仍是 `'self' data:`（**没放开**）。邮件正文要显示图片，
      走的是新增的 `frame-src sk-mail:` —— 只放行"把 `sk-mail://` 文档嵌进来"，图片/网络能力由那份文档
      自己的 CSP 决定（见 `electron/mail-body-protocol.ts`）。要再加协议/源，照这个形状做：**放行嵌入，不放行岛自身的取图/联网**。
      （srcdoc 不算例外：它会**继承**本 CSP，所以正文不能靠 srcdoc 渲染 —— 2026-10-04 实测。）
    - ⚠️ **这里说的 CSP 有两层，取交集**：除上面的宿主响应头 `UI_CSP`，岛自己的
      `ui-plugins/<id>/index.html` 里还有一份 `<meta http-equiv="Content-Security-Policy">`。
      **两层都要放行同一条指令**，缺一层整个 frame 就被拒（`ERR_BLOCKED_BY_CSP`，界面无提示）。
      2026-10-04 的正文空白就是只改了头 CSP、忘了岛 meta（守卫 `tests/islandMailFrameCsp.spec.ts`）。
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

