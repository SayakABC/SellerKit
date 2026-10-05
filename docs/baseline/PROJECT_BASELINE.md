# SellerKit 项目基线快照（PROJECT BASELINE）

> **性质**：本文件是**当前状态的客观快照**（结构 / 规模 / 契约 / 依赖），不是规则文档。
> 编码规则与红线的唯一权威是 [`../../AGENTS.md`](../../AGENTS.md)；架构"为什么这么做"见 [`../architecture/PLUGIN_ARCHITECTURE.md`](../architecture/PLUGIN_ARCHITECTURE.md)。
> **刷新时机**：版本号变更、新增模块/插件、新增 IPC 通道域、依赖大版本升级后。
> 维护规则见 [`../README.md`](../README.md)。

---

## 0. 基线元信息

| 项 | 值 |
|---|---|
| 快照日期 | **2026-09-27**（§3/§5/§6/§9/§10 于该日全量重扫；其余节仍为 2026-09-16 的快照）。⚠️ **2026-10-01 局部修订**：产品库 UI 岛整体下架、功能收归内建「货与成本」，§4 相关条目已就地标注（**未全量重扫**） |
| `package.json` version | `1.1.0` |
| git commit | `f1b45d1`（branch `chore/dep-upgrade`） |
| 上游 remote | `sellerkit` → `https://github.com/SayakABC/SellerKit.git` |
| `electron-builder.yml` buildVersion | ✅ **已不设**（版本元数据单一来源 = `package.json`；此前写死 `1.0.0` 与 `package.json` 分歧的问题已修） |
| 工作区状态 | ⚠️ 有大量未提交改动（**94 项** `git status`：47 改 + 9 删〔已暂存〕+ 38 未跟踪目录条目〔展开 65 个文件〕；含 S1 的 `shop-*` 域与 P3 的 `product-sku-*` 域、`ui-plugins/{product-library,shipping-rate}`、新建文档与冒烟脚本）。本快照描述的是**工作区当前状态**，不是 `f1b45d1`。⚠️ 其中 `ui-plugins/product-library` 已于 **2026-10-01 整体下架**、`ui-plugins/order-insight` 已于 **2026-10-05 整体下架**（均见 §4） |
| 快照方式 | 静态分析（文件统计 / grep / 配置读取）+ **实跑门禁**（`npm run verify` / `vitest` / `eslint` / 各类冒烟）；**未跑打包**（`npm run dist`） |

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
| `extensions/<id>/` | **随宿主分发的视图插件包**（`kind: view`，含 `meta.ts`）；**当前无实例，且目录不存在** —— 最后两个留档源码包（`excel-copy` / `order-insight`）已于 **2026-09-30（C3）删除**；机制保留，要用再建 | 构建期随包编译 | 自包含，import 走 `@/` 或包内相对 |
| `ui-plugins/<id>/` | **市场分发 UI 岛**（`kind: ui`，iframe + `window.__sk` 桥） | 独立构建产物，不入主 bundle | 经 host 能力域访问数据 |
| `scripts/` | 构建 / 打包 / 脚手架 / 冒烟脚本 | Node | — |
| `scripts/templates/` | **插件脚手架**：`l2-plugin`（L2 后台插件模板）/ `l2-demo`（L2 演示插件，2026-09-22 由 `extensions/_template` / `extensions/sk-hello` 归位而来）；UI 岛模板在 `scripts/ui-plugin-template/` | Node | 移动须同步改 `scripts/plugin-create.js` 的 `TEMPLATE_BG` 与 `scripts/plugins-install-demo.js` 的 `SOURCE`（二者硬编码指向） |
| `docs/` | 项目文档 | — | 见 `docs/README.md` |
| `dist/` `release/` `market-out/` | 构建与发布产物 | 生成物 | 不入库 |

### ⚠️ 已知目录语义冲突

`extensions/` **当前不存在**（2026-09-30 C3 删除最后两个留档包之后）。它曾承载两类形态，判定依据是「有无 `meta.ts`」——留档如下，将来重建目录时照此判定：

1. **视图插件包**（`kind: view` + `meta.ts`）：**当前无实例** —— 历史上是 `shop-accounts`（2026-09-16 下记）、`order-insight`（2026-09-21 下记）、`excel-copy`（2026-09-22 下记），三者均只保留 `ui-plugins/<id>` 市场岛。路径与机制（`vite.config.ts` 的 `MODULE_ROOTS` 双根探测）仍有效，供将来新增视图插件包使用。
2. **外置插件脚手架/示例**（`manifest.entry = ./index.js`、无 `kind`、无 `src/`）：`scripts/templates/l2-plugin`（模板）/ `scripts/templates/l2-demo`（示例，原名 `sk-hello`）—— 由 `npm run plugins:create` 生成，产出物应安装到 `<userData>/plugins/`。示例包本身已于 2026-09-24 从市场与本机下架（源码脚手架保留），见 `docs/plans/PLUGIN_TRIAGE_PLAN.md` §0。
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

| 目录 | 文件数 | 代码行数 |
|---|---:|---:|
| `src/` | 115 | 30,974 |
| `electron/` | 49 | 19,342 |
| ~~`extensions/`~~ | — | — | **已删除（2026-09-30 C3）**；下方两行留档包同步作废 |
| `ui-plugins/` | 40 | 11,793 |
| `scripts/` | 43 | 13,132 |
| **合计** | **247** | **75,241** |

> ⚠️ **本口径不计 `dist/`**，而两个**手写岛**（`excel-copy` / `shipping-rate`）的源码**就在 `dist/`**
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
| `ui-plugins/shop-accounts` | 30 | 11,059 | ui（**vite 工程**，口径 = `src/`） |
| ~~`ui-plugins/order-insight`~~ | — | — | ui，**2026-10-05 整体下架**（原 17 文件 / 3,264 行，口径 = `dist/`）—— 功能收归内建「今天」发货台七个页签 |
| `ui-plugins/excel-copy` | 10 | 2,470 | ui（**dist 即源码**，无构建步骤） |
| `ui-plugins/shipping-rate` | 12 | 2,334 | ui（**dist 即源码**，无构建步骤） |
| `ui-plugins/ae-profit` | 5 | 466 | ui（**vite 工程**，口径 = `src/`；1.1.0 收编后只剩接收端视图） |
| ~~`ui-plugins/product-library`~~ | — | — | ui，**2026-10-01 整体下架**（原 12 文件 / 4,367 行，口径 = `src/`）—— 功能收归内建「货与成本」，见 `docs/features/PRODUCT_LIBRARY.md` §0-A |
| `scripts/templates/l2-demo` | — | 79 | 脚手架·L2 示例（原 `extensions/sk-hello`，2026-09-22 归位） |
| `scripts/templates/l2-plugin` | — | 60 | 脚手架·L2 模板（原 `extensions/_template`，2026-09-22 归位） |

> 口径：**工程岛**（`shop-accounts` / `ae-profit`）取 `src/`；**手写岛**（`excel-copy` / `shipping-rate`）取 `dist/`。
> `extensions/` **目录已不存在**（最后 2 个留档包 2026-09-30 删除；`ae-profit` 的目录更早删除）。
> 宿主侧纯函数**不在这里**（属 `src/`）：`src/lib/productImport.ts` 427 行（产品库导入解析）、
> `src/lib/shipRate.ts` 832 行 + `src/lib/shipRateQuote.ts` 281 行（运价表归一化与计价）、
> `src/lib/shipRateOrders.ts`（按订单算运费的数据衔接）、
> `electron/shopName.ts`（店铺名归一的纯函数层，S1 新增——**放在 `electron/` 下**是为了就近被 `shop-db.ts` 引用，
> 它零依赖、因此仍可被 vitest 覆盖：`*-db.ts` 依赖 better-sqlite3 的 Electron ABI，vitest 直接 require 会崩）。
> ⚠️ **商品重量解析链（`pl_item_weights` 表 + 对应的 Excel 解析）已于 2026-10-01 整条删除**：
> 克重是 **SKU 属性**而非商品ID 属性，改挂 `pl_variants.weight_g`，在「货与成本」按 SKU 维护。
> 该文件已不存在，任何引用都应按此口径改写。

### 最大的 10 个文件

| 行数 | 文件 |
|---:|---|
| 2,118 | `src/types.ts` |
| 1,856 | `electron/product-db.ts` |
| 1,796 | `electron/order-db.ts` |
| 1,596 | `ui-plugins/shop-accounts/src/ShopAccountsView.vue` |
| 1,371 | `src/core/services/ipc.ts` |
| 1,326 | `electron/mail-db.ts` |
| 1,248 | `electron/preload.ts` |
| 1,208 | `ui-plugins/shop-accounts/src/components/CompanyManageView.vue` |
| 1,165 | `ui-plugins/shop-accounts/src/store.ts` |
| 1,062 | `ui-plugins/shop-accounts/src/components/AccountEditor.vue` |

**结构观察**：`src/`（平台核心）2.05 万行，`electron/` 1.85 万行，两者相当——**主进程 DB 层与宿主契约面（`types.ts` / `preload.ts` / `ipc.ts`，三者合计 3,849 行）是当前维护成本的主要来源**。
另一处值得盯的是 **`ui-plugins/shop-accounts` 单岛 1.07 万行、占了整个 `ui-plugins/src` 口径的 76%**（三个 1000+ 行文件：
`ShopAccountsView.vue` 1,596 / `CompanyManageView.vue` 1,208 / `store.ts` 1,132）——它已从"一个岛的视图层"长成了
"账号 + 企业 + 邮件 + 店铺登记四个域的界面合体"，**再往上加页签之前应先评估拆分**（AGENTS §1 的单文件 ≤300 行约束
在这里早已被绕过，属已知技术债）。

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
| `today` | `src/modules/today` | 内建模块（2026-09-30 新增，显示名「今天」）—— 2026-10-05 起是**发货台**：一页 **七页签**（总览 + 六步：导入订单 / 归类核对 / 生成拣货单 / 算钱 / 拿货 / 结算对账），**六步全部内建**（2026-10-05 晚：拿货 / 结算对账 / 归类核对三页签从「订单归类」岛收编，界面走 `.wb-*`、数据层全用宿主现成 IPC，**零新 IPC / 零迁移 / 岛不发版**），点步骤**切页签不跳页**；容器 `flowCtx.ts` 提供共享上下文（`reload`/`go`/`bump`/`token`），面板 `tabs/*Panel.vue` + 域薄封装 `purchase.ts` / `classify.ts`；缺口卡可**就地补齐** | — | — |
| `goods` | `src/modules/goods` | 内建模块（2026-09-30 新增，显示名「货与成本」= **薄内建**：看产品/SKU/克重/供应商，就地改克重；重手段留「产品库」岛） | — | — |
| `quick-note` | `src/modules/quick-note` | 内建模块 | — | — |
| `order-cost` | `src/modules/order-cost` | 内建模块（2026-09-29 新增；显示名 2026-09-30 由「订单利润」改为**「算钱」**；承载采集与导入**两条摄取通道** + 预测/已结算**两条轨** + **时间趋势（月/日）**） | — | — |
| `picking` | `src/modules/picking` | 内建模块（2026-09-30 新增，显示名「拣货」；拣货线 P4） | — | — |

> `order-cost`（**显示名「订单利润」**，id 未改）是**跨域算到一处**的第一刀：订单行 × 款级成本 × 克重 ×
> 运价表 × 收入/税 → 逐行 运费/成本/税/收入/毛利 + "缺哪一环"。口径由用户 2026-09-29 裁定：
> **预测**口径（在途单也算）· 关闭单单列一桶不进合计 · 平台代征代缴时税记确定的 0 ·
> 平台费无数据源则全局标"未扣"、**不按 0 算**。
> **件数口径**（P2，2026-09-29）：结算商品行真值 → 订单报表块内 `商品数量` → 按 1 件并逐行标「缺件数」；
> **件数不进成本/运费/毛利算术**（多件合并计费仍是运价岛的开放项），有件数 > 1 的行时界面显式提示这一口径。**有意做成内建模块而不是岛** —— 走渲染层核心不经过岛的
> `domains`/`actions` 判定，**零发版**；搬进岛时再连带声明新 op 一起发版。
> 它读运价表用的是**过渡形态**：借宿主同一个 electron-store 读 `modules.shipping-rate`
> （零迁移、零发版、无双写）；等出现第二个写入方再按 `migrate()` 正式搬进宿主表。纯计算层在
> `src/lib/orderCost.ts`（口径单源 + vitest 覆盖），项目文档见 `../reviews/BUSINESS_GAP_ANALYSIS_2026-09-29.md`。

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
| ~~`order-insight`~~ | ~~1.5.0~~ | — | **2026-10-05 整体下架**：功能**几乎全部收归内建**（六步发货台 —— `src/modules/today/**` 的七个页签：总览 / 导入订单 / 归类核对 / 生成拣货单 / 算钱 / 拿货 / 结算对账）；非每日动作的「识别库 / 透视 / 明细」按裁量去掉。数据层与 IPC 通道一行未改；为该岛开的 `order-insight` 能力域（**37 op**）随之**整域删除**（`src/core/plugin/host.ts` 就地留墓碑）。⚠️ **存储命名空间 `modules.order-insight` 保留不改名**（引擎配置 + 列映射是已落盘的用户数据键）。详见 `CHANGELOG.md` 的 Removed 段与 `docs/notes/2026-10-01-ui-island-retirement.md` §6 | — |
| `shop-accounts` | 1.5.2 | `storage` · `clipboard` · `db`(shop-accounts · **shop**) · `secrets` · `mail` | **店铺账号管家唯一实现**：账号库 / 企业管理 / 收件箱 / **店铺登记**（1.5.0 新增页签，ADR-002 S1；1.5.1 修复该页「账号套装」下拉恒空 —— `shop-accounts.list` 返回裸数组而视图按 `{rows}` 取）/ **名下店铺**（1.5.2，编辑抽屉内登记/解绑 `sk_shops` 实体，`shop_set_id` 软关联；并修复登记编辑表单不透传 `platformShopId` 会被全量提交静默清空）。**Vite+Vue3+Pinia 工程岛** | ✅ `manifest.settings`（分类 `shop-accounts:settings`） |
| `shipping-rate` | **1.3.0** | `storage`(shipping-rate) · `clipboard` · `dialog` · `db`(shipping-rate) | **无忧物流运费（克重 → 逐国实际运费）唯一实现**（无内建前身）。**手写 ESM 岛**。1.1.0 起「按订单试算」（速卖通商品ID重量表 `pl_item_weights`）；1.2.0 起「按产品试算」（目的国点名 × 产品库 SKU 克重 `pl_variants`，与订单侧两条独立重量数据源）。**1.3.0（2026-09-30，M6 运价表回迁）**：真源是宿主快照表 `sr_rate_snapshots`（ADR-002 C3）—— 岛不再存表、也不再把它传回宿主计价（`quote` / `quoteOrders` / `quoteProducts` 一律宿主自取），改用新 op `rateCurrent` 取只读副本渲染；升级后首启把旧的岛内表**一次性迁移**（`rateAdopt`，按内容去重）并抹掉本地副本；`storage` 只留查询偏好与"上次打开的文件"；「清空运价表」下线（历史快照是「算钱」复算的依据） | — |
| ~~`product-library`~~ | ~~1.5.0~~ | — | **2026-10-01 整体下架**：产品（款式）主数据 / 店铺商品ID→产品映射 / 供应商（厂家）主数据 / 店铺商品清单四个维护台**全部收归内建「货与成本」**（`src/modules/goods/**`，四个页签）。数据层与 IPC 通道一行未改；为它拆的 5 个 `DB_OPS` 域（32 op）随之删除。详见 `docs/features/PRODUCT_LIBRARY.md` §0-A 与 `CHANGELOG.md` | — |

> **本表只留快照级事实**：逐岛细节（版本演进、页签、陷阱、权限声明的取舍）见 **`ui-plugins/<id>/README.md`** 与 `CHANGELOG.md`。
> 三条共性：
> ① **形态**——手写岛（`excel-copy` / `shipping-rate`）`dist/` 即源码、**无构建步骤**；工程岛（`shop-accounts` / `ae-profit`）`dist/` 是构建产物、不入库。
> ② **Excel 解析与重计算一律在宿主**（三个涉及 Excel 的岛都如此）：岛所在 iframe 的 CSP 是 `script-src 'self'`、无 `unsafe-eval`，岛内既不能求值也不打包 `xlsx`（详见 §11-13）。
> ③ **全部市场分发、都不入 `modules.config.json`**（红线 23）；前三个由内建版下记而来，与内建**同名 key 共用命名空间** → 模板 / 规则 / 显示列等**配置自动继承**。
> ⚠️ **改岛内容必须升 `manifest.json` 的 `version` 并重跑发布** —— 否则「插件中心 → 市场」与 `<userData>/plugins/` 都还是旧版。

---

## 5. IPC 契约基线

**这些数字不再靠人工维护**：`npm run verify`（R2-4）从源码动态提取三份清单求差，
下表为其输出快照（**2026-09-30 第五次刷新**）。三者不相等即为契约漂移，校验会失败并指出缺哪一项。

| 指标 | 值 | 来源 |
|---|---|---|
| preload 暴露键 | **188 个** | `electron/preload.ts` 的 `ipcRenderer.invoke(...)` 字符串 |
| `src/types.ts` `ElectronAPI` 声明 | **188 个** | 与 preload **集合对称**（R1-3 已修复此前的缺 4 项） |
| 主进程注册通道 | **184 个** | 含裸 `ipcMain.handle/on` 与封装 `register()` / `handle<T>()`（封装名**跨文件**解析） |
| 主→渲染单向广播 | 2 处：`mail-sync-event`、`updater-event` | `webContents.send` ↔ `ipcRenderer.on` 双向对称校验 |
| 命名合规性 | 100% 匹配 `^[a-z0-9]+(-[a-z0-9]+)*$`（kebab-case） | 人工核对 |

> 为什么 preload(188) 与主进程通道(184) 不相等：部分键共用同一通道（如 `read-file` 被
> `importExcelByPath` 与 `readFile` 共用），另有一批通道属"仅广播/仅包装"语义，属设计如此而非漂移。
> 主进程注册分布（verify 实时输出，2026-09-30）：
> **order 38** / product 25 / mail 24 / purchase 24 / main 13 / **ae 12** / shop-accounts 9 / company 8 /
> **shop 8** / **shop-product 6** / backup 4 / plugins 4 / ship-rate 3 / market 2 / updater 2 /
> ipc-handlers 1 / **picking 1**
> —— 演进轨迹：147/143 → 151/147 → 153/149（+4：`order-shipping-rows`、`product-weight-import/get/stats`）
> → 161/157（+8：S1 的 8 个 `shop-*` 通道）→ 166/162（+5：P3 的 5 个 `product-sku-*` 通道）
> → 182/178（+16：1.2.0~1.5.0 的 `product-*` 增补、`shop-product-*` 6 个、`shop-db-ensure` 等）
> → 185/181（+3：`ship-rate-snapshot-{save,list,calc}`，运价表快照）
> → 188/184（+3：`settle-import` / `settle-orders` / `settle-stats`，结算明细导入）
> → 189/185（+1：`order-assign-shop`，订单归属店铺）
> → 190/186（+1：`picking-rows`，拣货投影 —— 只读，聚合在渲染层纯函数）
> → 191/187（+1：`order-collected-rows` —— 当日即被**主干化**取代：采集改写 `oi_orders` 后该通道删除，回到 **190/186**；`order-shipping-rows` 加 `source` 过滤）。
> → 188/184（−2：删 `get-store` / `set-store`，**C6 旧扁平存储契约退场**，渲染层早已无调用方 → `main` 15→13）。

### 通道域划分（按前缀）

| 域 | 前缀 | 注册文件 |
|---|---|---|
| 通用/文件/窗口 | `get-*` `set-*` `open-*` `check-*` `read-file` `write-file` `save-*` `win-control` `backup-*` `reset-store` | `electron/ipc-handlers.ts` |
| 网络 | `net-request` | `electron/ipc-handlers.ts` + `electron/http-client.ts` |
| 订单洞察 | `order-*` | `electron/order-handlers.ts` + `order-db.ts` |
| 拿货对账 | `purchase-*` | `electron/purchase-handlers.ts` + `purchase-db.ts`（`suppliers` 表的**管理入口**在「货与成本 › 供应商」；对账读侧留此。~~1.4.0 起供应商 CRUD 同时以窄域 `product-supplier` 暴露给产品库岛~~ —— 该岛 2026-10-01 下架，窄域随之删除） |
| 集中收件箱 | `mail-*` | `electron/mail-handlers.ts` + `mail-engine.ts` + `mail-db.ts` |
| 利润追踪 | `ae-*` | `electron/ae-handlers.ts` + `ae-engine.ts` + `ae-db.ts` |
| 店铺账号 | `shop-account-*` | `electron/shop-accounts-handlers.ts` + `shop-accounts-db.ts` |
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
| `order-cost` | `platformFeeRatePercent`（订单利润页的平台费**近似费率**，2026-09-29 加；缺省 0 = 未配 → 不扣并全局提示"平台费未扣"） |
| `excel-copy` | 记录列表 / 模板配置 / 字段规则 / 显示列（`ui-plugins/excel-copy` 岛声明） |
| `order-insight` | **键名保留（岛已下架）**：引擎配置（`engine`）+ 四个列名 + 两个透视维度 —— 宿主「设置 › 识别」写入、内建「今天 › 归类核对」读取。⚠️ **名字沿用原岛 id 是有意的**：它是已落盘的用户数据键，改名 = 用户配好的 Key 与列映射静默消失 |
| `shop-accounts` | 店铺账号 UI 状态（`ui-plugins/shop-accounts` 岛声明） |
| ~~`ae-profit`~~ | **已退场（2026-09-30，C9 收编）**：原「利润追踪」岛声明，三页签并入宿主「算钱」后本岛不再声明 `storage`（只剩接收端状态）。旧数据仍留在 `config.json` 里，无人读写、可忽略 |
| `shipping-rate` | **只留界面状态**：查询偏好（克重 / 类别 / 变体 / 进位方式）+ 上次打开的文件与其体检结果（`lastFile` / `sheetNames` / `candidates`）。⚠️ **1.3.0（M6）起运价表本身不再在此** —— 真源是宿主表 `sr_rate_snapshots`（按生效日留档，"算钱"按订单日期取当时那份）；岛上残留的旧 `table` / `source` 键在首启迁移后由岛显式写 `null` 抹掉 |
| `plugins` | 插件停用集 |

> 外置插件 / UI 岛能写哪些命名空间由 manifest 的 `capabilities[storage].namespaces` 决定：声明了就必须命中，
> 未声明则默认只放行插件自身命名空间（`src/core/plugin/security.ts`）。因此**新增一个用 storage 的岛 = 新增一个命名空间**，
> 本节清单应随岛的 manifest 同步刷新。内建侧有 `app-shell`（外壳状态）、`plugins`（插件停用集）与 `order-cost`（订单利润页 UI 态）三个命名空间；
> `quick-note` **不占命名空间** —— 它的 3 个源文件（`meta.ts` / `index.ts` / `QuickNoteView.vue`）里没有任何
> storage / localStorage / 读写调用，便签内容随会话存在、重启即失（若要持久化，需新增 `quick-note` 命名空间并走 `useModuleStorage`）。
> 下记**不迁移**命名空间：内建与同名岛共用 `modules.<id>`，这正是"配置自动继承"的实现方式（见 §4）。
>
> ⚠️ `AGENTS.md` §1.4 仍只列 `app-shell` / `excel-copy` 两个命名空间（已滞后，本次快照已补全，详见审查报告 P2-3）。
> 旧扁平 key（`records` / `templateConfigs`）仅由主进程做一次性迁移探测，**禁止新增**。

### SQLite（**单库** `userData/sellerkit.db`，按域分**表**）

> ⚠️ 本节原先写作「分域 db 文件」，措辞与事实不符：**库只有一个**（`electron/db.ts` 的 `initDb()`，
> 全仓唯一连接，`DEFAULT_FILE_NAME = 'sellerkit.db'`），分域的是**表**。2026-09-24 按代码修正。
> 逐表字段与"读写在哪个功能"的完整盘点见 [`../plans/DOMAIN_INTEGRATION_PLAN.md`](../plans/DOMAIN_INTEGRATION_PLAN.md) §1.2。

| 定义文件 | 表 |
|---|---|
| `electron/mail-db.ts` | `sk_mail_accounts` · `sk_mail_messages` · `sk_mail_bodies` · `sk_mail_attachments` · `sk_mail_folders` · `sk_mail_attachment_cache` · `sk_mail_meta`（KV）· `sk_mail_fts`（**FTS5 虚拟表**，rowid = `sk_mail_messages.id`） |
| `electron/order-db.ts` | `oi_orders` · `oi_images` · `oi_styles` · `oi_style_colors` · `oi_style_fingerprints` · `oi_queue` |
| `electron/purchase-db.ts` | `suppliers` · `purchase_orders` · `purchase_items` · `purchase_sources` · `payments` · `purchase_ignore` |
| `electron/ae-db.ts` | `ae_orders` · `ae_order_lines` · `ae_fees` · `ae_cost_map` · `ae_rates` · **`ae_settle_lines`**（**结算明细**，2026-09-29：AE 后台「订单明细」导出 → 一表两粒度，`line_type` 区分**商品行**与**订单级行**（后者 `item_id` 空，是**整单**口径含买家付的运费）→ **两类行不可相加**；费用按 JSON 科目存，加科目零 ALTER；幂等键 `(order_no, item_id, sku_id)`） |
| `electron/product-db.ts` | `pl_products`（产品/款式主数据，P1；`image_id` 列 1.2.0 `ALTER` 增补，幂等判定 `PRAGMA table_info`）· `pl_item_weights`（商品ID → 克重，P4a 后为「按订单算运费」补的数据源）· **`pl_shop_sku`**（「店铺商品ID → 产品」映射 + 「商品清单」池，P3；UNIQUE **`(platform, shop_id, item_id, spec, product_id)`** —— 含 `product_id` 是**一对多（套装）的前提**，老库由版本化迁移归一，见下「schema 演进」；`shop_id` 外键 → `sk_shops`；**2026-10-05 起 `spec` 承载「颜色」**（`'*'` = 未指定，一期恒 `'*'` 的时代结束）—— 归款 `autoAssignByMap` 的颜色顺序是**映射色 → 订单原文色 → `未分类`**，`variant_id` 由写库时按 `(product_id, 色)` 反查填（0 = 该色还没录变体）；`pickingRows` 的 `color` 回落**款色 → 订单原文**。见 `docs/notes/2026-10-05-mapping-carries-color.md`）· `pl_variants`（SKU 子表：name/code/**weight_g**/status，1.2.0；`color`/`size` 列 1.3.0 `ALTER` 增补——服装「颜色+尺码」组合，成对时 name 自动生成，编码部分唯一索引 `WHERE code <> ''`）· `pl_images`（产品图，`fingerprint` UNIQUE = SHA-256）· `pl_item_images`（商品ID覆盖图，`item_id` PK 经归一存储）—— 后三张 1.2.0 |
| `electron/shop-accounts-db.ts` | `sk_shop_sets`（`company_id` 列由 `ensureCompanyIdColumn()` 增量补齐，软关联 `sk_companies`） |
| `electron/shop-db.ts` | **`sk_shops`**（店铺实体，UNIQUE `(platform, name_key)`）· **`sk_name_map`**（名称归一映射，UNIQUE `(kind, raw_key)`；`kind` 预留 `supplier`/`style`/`product`）—— ADR-002 S1，2026-09-27 |
| `electron/company-db.ts` | `sk_companies` · `sk_company_profiles`（企业管理：欧代 / 土代 / 德国包装法） |
| `electron/db.ts` | `sk_schema_migrations`（**迁移记账表**，非业务表：`key` 主键 = 域名，`version` = 已应用到的版本，见下「schema 演进」） |
| `electron/ship-rate-db.ts` | **`sr_rate_snapshots`**（**运价表快照**，2026-09-29：一次导入 = 一条，`content_key` UNIQUE 按内容去重，`effective_from` = 导入当日；算账时按订单日期取"当时那份" → 历史预测可复算。ADR-002 C3 要求运价表挂宿主中立层） |

稳态共 **39 个对象**：**36 业务表** + 2 内部表（`sk_mail_meta` KV、`sk_schema_migrations` 记账）+ 1 FTS5 虚拟表（`sk_mail_fts`）。

> **怎么数（可复跑，别再手抄推算）**：`grep -o "CREATE TABLE IF NOT EXISTS" electron/*.ts | wc -l` 合计 **45 处**，
> 其中 **7 处是注释里的同形文字**（分别在 `db.ts` / `product-db.ts` ×3 / `ae-db.ts` / `shop-db.ts`，
> 都是在说明"`IF NOT EXISTS` 对已存在的表一个字都不改"）→ 真实建表 **38 处** = 36 业务表 + 1 KV + 1 记账表；
> 再加 `CREATE VIRTUAL TABLE` **1 处**（FTS5 本体，表名走模板串 `${FTS_TABLE}`，直搜表名看不到它）。
> 另有 1 处 `CREATE TABLE purchase_items_new` 在迁移函数 `migrateItemsSize()` 内部，随即 `DROP` + `RENAME`
> 成 `purchase_items`，**不是稳态表**（且不带 `IF NOT EXISTS`，不进上面的 grep）。同类还有 1 处
> `CREATE TABLE pl_shop_sku_legacy_struct` 的**反向**动作（`pl_shop_sku` 的唯一键归一用"建新表 → 搬数据 → 删旧表"，
> 见下「schema 演进」；临时表在事务内建、随即 `DROP`）。
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
  `order.main` = **v4**（v1 补 `oi_orders.order_time/status/corrected` + `oi_images.style_color_id`；
  v2 补金额/状态/时点列；**v3 = 归一为唯一订单主干**：重建 `oi_orders`（`image_id` 改可空 + `source`/`qty` + 删 8 个零读者列）·
  `oi_styles` 去哨兵列 `name`（名字先交接进 `pl_products`）· 追平 `sqlite_sequence`）——「重建存量表的三个坑」见 `docs/notes/2026-09-30-table-rebuild-traps.md`；
  **v4 = 历史采集单回填主干**（2026-09-30，C9' 的前置）：老采集表 `ae_orders`/`ae_order_lines` 里的单按
  `source='collect'` 灌进 `oi_orders`（口径用**实时采集同一组原语**：`electron/aeMoney.ts` 的收入/汇率 + `upsertCollectedOrder`），
  `raw_fields` 保真原帧并带 `__migratedFrom='ae_orders'` 可回滚标记；**老表原样保留**（删表是另一步）；
  表不存在（新库）时整步跳过——`scripts/schema-migration-smoke.cjs` 场景 [E] 专测（含幂等与"金额按汇率折分"）；
  `ae.main` = **v2**（v1 `ae_cost_map` 改「多行 + 生效区间」复合主键并重建表；v2 补 `ae_order_lines.style_code`）
  —— 2026-09-29 把本域**转换**到版本化迁移（原先散在 `ensureAeSchema` 里的两个幂等函数），
  同时把 `style_code` 补进建表语句（原先只写在迁移里 → 迁移先跑后新库会永久缺列，
  与 `oi_images.style_color_id` 是同一个坑）。
- ⚠️ **纪律（2026-09-29 被冒烟抓到）**：**新增列必须同时写进 `CREATE TABLE`（`SCHEMA`），迁移只负责老库**。
  原因：迁移先跑（house convention），新库上表还不存在 → 步骤只能跳过；此时版本已被记账，
  于是"只写在迁移里"的列在**全新库上永远补不上**。
  实测案例：`oi_images.style_color_id` 原先只写在 `migrateColumns()` 里，改成迁移先跑后
  `style:smoke` 13 项全红（`no such column: i.style_color_id`）。同理，**新增列必须给 `NULL`/无默认**
  的金额列留出"未知"语义时，别写 `DEFAULT 0`。
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
| **`recognition`「识别」** | **宿主自有贡献** `src/core/settings/panels.ts`（order 10） | 视觉识别引擎（服务商 / 模型 / 接口地址 / 温度）+ API Key（写宿主机密存储，只写不读）。**2026-09-30 C4 从「订单归类」岛收编**；该岛 2026-10-05 整体下架后，列映射与「本次导入店铺」由内建「今天 › 导入订单 / 归类核对」承接（同一命名空间，配置自动继承） |
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
| `schema:smoke` | **版本化迁移冒烟（30 项 / 5 个场景）** —— `electron/db.ts` 的 `migrate()` 是"改形状"的唯一通道，而它服务的场景（**老库 vs 新库形状不一致**）在全新库上永远复现不出来；本脚本造老库形状逐场景断言：A 数据/索引不丢 + 唯一键升级 + `AUTOINCREMENT` 序列追平 + 幂等可重跑 · B 新库跳过重建 · C `order.main` 老库**归一为主干**（可空 image_id / 款式名交接 / 行号追平）· D **ae 域老库重建** · **E 历史采集单回填主干**（v4：`source=collect` 落到位 / 金额按汇率折分 / 行级明细与颜色尺码 / 原帧保真 + 可回滚标记 / 幂等不翻倍 / **老表原样保留**）（见 §6「schema 演进」） |
| `goods:ui` | **「货与成本」页假桥无头冒烟（12 项，2026-10-01）** —— 断言：统计条（产品/SKU/缺克重/未关联厂家/已映射）· 产品表逐格（款/名称/供应商/SKU 数/缺克重数）· 未关联厂家显示「(未关联)」· 选产品→SKU 表切换 · **改克重后出参必须带该行全部现有字段**（`productVariantUpsert` 是全量提交，漏字段会把颜色/尺码清空）· 缺克重计数实时归零 · 保存回执 · 无未捕获错误 |
| `today:ui` | **「今天」发货台假桥无头冒烟（131 项，2026-10-01 → 2026-10-05）** —— 「今天」页自 2026-10-05 起是**七页签容器**（总览 + 六步：1 导入订单 / 2 归类核对 / 3 生成拣货单 / 4 算钱 / 5 拿货 / 6 结算对账）· **页签栏**（七页签齐全 · 默认落总览 · **没点过的页签面板一个都没挂载**（懒加载；否则七个整页视图进页面就一起取数））· **点流程卡 = 就地切页签、绝不跳页**（核心判据必须**两条一起看**：目标页签选中**且**全程 `switch-module` 计数不变 —— 只断言"到了"会假绿，旧实现也"到得了"，只不过靠跳走）· **保活**（切走再切回，面板是**同一个 DOM 实例**，用 `__keepMark` 验；重挂载会丢标记，"取了数"不算证据）· **保活的代价要还回去**（导入后已生成的拣货单自动重算；判据按**入参**挑调用方 —— `limit===undefined` 才是拣货面板自己发的，否则会被容器 `reload()` 的 `{limit:2000}` 满足成假守卫）· 内嵌整页视图（拣货 / 算钱）只藏 `wb-head__main`、**必须保留 `wb-head__actions`**（否则生成 / 导出按钮消失，页面打不开）· **「归类核对」页签（2026-10-05 内建）**（指标条四格真取数（待核对/未归类/识别库款数/**本页商品数** —— 最后一格把"这一页其实只有两件事要定"说出来；没有商品ID 的报表整格不显示，不显示"0 个商品"）· **⭐「同商品」徽标**（同一家店同一商品ID 的多行各标「同商品 ×N」，让人知道**定一次就够**；**没有商品ID** 的行、**商品只此一行**的行都**不许**有徽标 —— 夹具三种情况各占一行，少了任一种，"凡有商品ID 就标"或"徽标恒显示"这类错法都会全绿）· 缩略图合批**只带有图的行**（载荷是**裸数组**，preload 才归一成 `{items}`）· 有图的行真渲染 `<img>` · 归属款下拉用真识别库 · **默认值不靠位置**（已归类行按 code 反查它自己的款）· **⭐ 键盘流**（行内按回车＝保存这一行，不必去够鼠标；保存后该行离开待核对列表、焦点自动落到**顶上来的**那一条 —— ⚠️ 夹具到这一步才开启"已核对即离表"的模拟（`updateOrder` 写 `corrected = 1`）：**不对齐时列表不缩水，任何下标都"看着对"**，把 `focusRowIdx` 写成 `idx + 1` 当场变红）· 没改动时保存禁用 · 保存出参**带指纹**（漏指纹 = 宿主重归类分支静默空操作，旧岛漏传过）· 没点名款不走 `orderStyleAssign` / 点名款把指纹**记入该款** · 单行确认只标这一行 / 全部确认走 `all` 分支 · **⭐ 人工核对回流被"说出来"**（点名款后提示「已记住这个商品 → 款和颜色，另有 2 单一起归好了」）—— 判据**必须先等提示真的进 DOM 再断言**：假桥是在 invoke 的**同步**阶段记录调用的，直接在"通道被调用"那一刻取 DOM 只会得到"还没有提示"，于是**反向**断言（「没点名款的那次保存不许谎称已记住」）会在"提示没渲染"与"提示里没那句话"之间恒绿 —— 本轮实现时实测踩到，改完并做变异确认才真的变红；取提示一律 `querySelectorAll` 逐个看，不能取第一条（同屏能并排几十条旧提示）；另有一条前置断言「保存提示真的渲染出来了」作自证非空转）· ⚠️ 原「没配 Key 当场拦住并指路」与「批量识别只挑"有图且未归类"的行」两条已随该批量按钮一起删除（2026-10-05 用户要求），代之以一条**反向断言**「工具条不再有识别按钮」）· **「结算对账」页签（2026-10-05 内建）**（指标条四个金额同窗同源（合计 ≠ 任一行）· 厂家对账两行逐格对 · 付款类型**逐行**打标 · 记付款弹层**预选厂家** / 打开时不发请求 / 空金额拦住 / 金额按分提交 / 成功后自关 · 删除先确认且写明后果 / 确认前零请求 · **切时间窗带窗口重取**（不是只改高亮）/ 切回「全部」= 不设边界 · **切「按店铺」才取分摊** · 明细按**这一家店**取 · 无可归属给空态并说清分摊原料从哪来）· 断言三张卡的数字（订单总数 + 两条来源分开计数 + 最近下单 / 待拣同一 SKU 合一组 3 件 2 单 / 缺口三项各自计数与合计）· **范围写在卡上** · **每日发货流程卡**（**六步**齐全（导入 / 归类 / 拣货 / 算钱 / 拿货 / 对账）/ 每步标明"**在本页哪个页签做**"（**反向守卫：不许再出现模块 id 字面量** —— 旧文案就是这么写的，用户看到会以为还得跳走）· **当前步唯一**：`now`+`gap` 合计恒为 1，前一步未完成时后面的步骤必须是 `todo` 且写明「等第 N 步」· 已完成的步打 `done` · 「下一步」按钮跟着当前步走 · **点它就是切页签，不派发 `switch-module`** · **六步全部在本页页签里**（流程卡不再有"在插件里"的步骤、也不给"去插件"的岔路 —— 六个 `flow-<key>` 的 `where` 都写本页页签名）· **点击出参**（空态 `open-settings` → plugins；⚠️ `switch-module` 现在是**反向判据**：断言"点了它也不派发"）· 空态给的是**动作**不是「暂无数据」· **统一导入三条真实路径**（商品信息→指路不写库；**订单报表→多产品拆行 + 无主图列照常落主干 `imageId=null`**，结论带判据与「店铺未归属→归到该店」的下一步；**芒果店长待发货订单→判据点名芒果 + 店铺名落 `shop` + 图片链接真走 `orderDownloadImage` 且 `imageId` 非 null + 结论不再提示「归到该店」**）· **导入回执四段**（标题点名子类 / 判据明细 / **落点行说清"本页哪个页签看得到"**（文案从"页"改"页签"，因为已不跳页） / **下一步按钮的 `moduleId` 必须在 `modules.config.json` 里**，订单回执按"店铺已归属/未归属"的**两组分支各测一次**；认不出时**不给**下一步按钮；可关闭且关掉真的消失）· **订单导入后「待拣」卡点亮** · **缺口卡就地补齐**（缺克重→「货与成本」补 SKU 克重 / 缺成本·未识别款→「货与成本」入口；克重齐时不催人）· **空态主操作不许再"劝人装插件"**（判据=出现「导入 Excel」且**不出现**『另装』且出现「归类核对」，且点它会**顺带把「导入订单」页签切到前台**再弹选文件 —— 两步任一漏掉都算失败）· **页签切换全程零 `switch-module`**（`nav` step）· 无未捕获错误。⚠️ 断言一律钉在 `data-act` 上（回执拆成四段后整串 `textContent` 拼串会假红/假绿）；**等待判据钉在"只有新结论才有的特征"上**（两条 message 共享"没认出这个文件是什么"⇒ 拿它当完成信号会读着旧回执做）；新增的点击要**顺手清 `window.__events`**（后面有按 `[0]` 取的断言，不清就是假红）。见 `docs/notes/2026-10-05-import-receipt-next-step.md`、`2026-09-30-headless-smoke-waitfor-trap.md`、`2026-10-05-daily-flow-card.md` |
| `order-profit:ui` | **「算钱」页假桥无头冒烟（64 项，2026-10-01）** —— 复制 `dist/renderer` 到隔离目录 → 注入假 `window.electronAPI`（Proxy + 精确样本）→ 本地 HTTP + 无头 Chrome `--dump-dom`。断言：四路取数接线（订单行/批量克重/款级成本/**宿主快照**）· **分→元的精确值**（运费 16.00 / 成本 10.00 / 税 0.00 / 收入 165.18 / 毛利 139.18）· 分桶与缺口文案 · 点「刷新」真的重新取数（断言出参 `{limit:500}`）· **改平台费率 → 毛利被扣（139.18 → 124.31）且费率落盘** · **同一行从「预测」切到「精准」**（打开结算数据后精准毛利 = 净收入 − 运费 − 成本 = 64.86，且悬停说明保留预测值）· **件数接线**（报表块内 2 件 → 结算商品行 3 件盖过它 → 两处都拿掉时按 1 件并出现「缺件数 1」与多件行提示，且提示随数据消失）· **两条摄取通道合并**（打开采集后：采集 1 行/导入 1 行、逐行来源标签、采集行件数=真值 2、税口径默认平台代征记 0.00 与切「不知道」标缺口、仅采集筛选）· **数据基础区**（默认收起 / 缺成本时自动摊开 / 成本表值 / 改汇率真的发出 upsert / 新增币种码归一大写）· **空态给可点的下一步**（指向宿主「今天」的导入入口，不再指向要装的岛；按钮派发 `switch-module → today`，排最后因页面会切走）
· **统计区**（按款一行 165.18/26.00/139.18；维度切到目的国后出现"美国"组）·
**店铺归属全回路**（未归属提示 → 点「归到该店」断言出参 → 刷新后提示消失且明细显示店铺 → 维度切到店铺显示该组）·
**界面精简**（首屏默认不含费率/店铺/结算导入，展开「更多」后可达）·
**两个新维度**（切到 SKU 显示 `S1 · 黑 · L`、切到供应商显示 `厂A`）（断言出参 `{ns:'order-cost', data:{platformFeeRatePercent:9}}`；⚠️ 别断言"最后一次 `setModuleState`"——外壳启动也会调它）· 无未捕获错误。⚠️ 需要本机有 Chrome（macOS 路径硬编码），故不进"每次必跑"清单；**改页面接线必须跑它** |
| `picking:ui` | **「拣货」页假桥无头冒烟（44 项，2026-09-30 / 2026-10-05）** —— 与 `order-profit:ui` 同款（复制产物 → 假桥 → HTTP + 无头 Chrome）。断言：**一键语义**（首屏空态、不自动取数、默认条件以标签呈现「未发货 · 近 30 天」）· 点生成后**四路取数都发出**（投影 / 结算 / **成本区间** / 缩略图合批）· **组内件数 = 2（报表）+ 3（结算真值）+ 1（无件数按 1）= 6 / 3 单**· **已终结（关闭）剔除并计数**、超窗剔除计数、无日期照收计数 · 缺件数/缺图/缺供应商/未识别款**逐行标出** · 缩略图带 `maxEdge` 不是原图 · 「更多」展开后筛选可达 · **改筛选后「重新生成」带出店铺** · **进价 / 预估金额**（顶部「¥60.00（不含 1 件无进价）」+ 行级 `10.00 / 60.00` + 无价组两列都是 `—`）· **按厂家分段**（两段且顺序对、段标题给 SKU 数/件数/金额、**整段无价时说「无进价（N 件）」而不是 `¥0.00`**）· **全无价时顶部写「—（N 件全部无进价）」**（造 `aeCostMapList` 返回空）· 表格在 `.wb-table-wrap` 里 · **导出交给 `pickingExportExcel`**（断言传过去的 rows：件数/单价/金额/缺口文案，**图是渲染层转好的 JPEG**（`/9j/` 开头 + 64×64）、没图的组传 `null`、无价的组金额传 `null`，且不再调旧的 `orderExportExcel`）· 空态两分支文案 · 无未捕获错误。⚠️ 假桥的 `orderImageThumbBatch` 必须返回**真 JPEG**（页面内 canvas 现造）—— 返回假 dataUrl 会让每张图被静默跳过，这条链**永远测不到**。⚠️ 本脚本**验不到 xlsx 本身**，见上一行 |
| `shipping-rate:ui` | **运费岛假桥无头冒烟（两个来回 19 项，2026-09-30）** —— 手写岛无构建，唯一可自动化的是"假桥真点"。来回 A（冷启动）：宿主没有快照 + 岛内没有旧表 → 渲染空态、**不发生迁移调用**、不去计价；来回 B（运价表回迁 M6）：岛内旧表 → `rateAdopt` 带着整张表与来源 → 抹掉本地副本（显式写 `table:null`）→ 取回并渲染 · **核心断言：`quote` / `quoteOrders` / `quoteProducts` 的 payload 里都没有 `table`**（表一律宿主自取，回了就是"两份真相"）|
| ~~`order-insight:settings:ui`~~ | **已随岛下线（2026-10-05）** —— 原为 `order-insight` 岛「导入设置」页签的假桥无头冒烟（9 项）。岛整体下架后脚本与 `package.json` 命令一并删除；它守的东西**没有消失**：列映射现由内建「今天 › 归类核对」承接，接线断言在 `npm run today:ui` 里（那 9 项对应的是**岛**的页签结构，已无对象） |
| `ship-rate:smoke` | **运价表快照冒烟（11 项，2026-09-29）** —— 同内容重复导入**不新增行**（按内容去重）· 生效日默认导入当日（脏值回落、不写脏数据）· 列表**不带 payload**、算账集合带 payload（坏 payload 降级 null）· 空库返回空数组（调用方回落"当前那份"） |
| `order:smoke` | **订单域 DB 层冒烟（23 项，2026-09-29 补 / 2026-09-30 随主干归一与免图导入更新 / 2026-10-05 补列表投影）** —— 此前最大的域反而没有自己的冒烟（改动只能被 `style:smoke` / `product:sku:smoke` 间接兜住）。覆盖：幂等重入（同单号同图不重复插）· **金额入账**（`raw_fields` → **只提主线列**，分；空列 → NULL 而非 0；**零读者列已删**）· **主干两列**（`source` 默认 import / `qty` 缺省 NULL）· `shippingRows` 投影宽了但**不丢行**（LEFT JOIN）· **列表回带商品ID 与原始整行**（`itemId` 由主进程用 `extractSkuFields` 从 `raw_fields` 推，与回流写映射同一个函数；夹具里刻意放一个名字相近的「商品名称」列作**干扰项**，确认没抓到它 —— 这条同时守住"`orderList` 忘了 select `raw_fields`"那个静默陷阱）· `groupStats` 维度白名单 · 队列入队/统计/分页 · **订单归属店铺**（同订单号的多行一起改 / 已同名不改 / 空入参不动数据）· **SKU/供应商投影字段**（缺 `suppliers` 表时降级为空，不抛 `no such table`）· `clearAll` |
| `mail:smoke` | 邮件引擎冒烟（**DB 层**：`electron scripts/mail-engine-smoke.cjs`） |
| `product:smoke` | 产品库 DB 层冒烟（**24 项**，P2/P4a；2026-09-30 加「商品信息导入顺带回填 SKU 克重、不覆盖人工值」） |
| `shop:smoke` | **店铺实体 DB 层冒烟（25 项，S1）** —— 含"未归一名单覆盖 `oi_orders` 每个店铺名且计数一致"这条**验收原文**的用例 |
| `product:sku:smoke` | **「店铺商品ID → 产品」映射层冒烟（31 项，P3；2026-10-05 补 8 条「人工核对回流」）** —— 含产品库 P3 的两条验收原文（"1000 行陌生订单全部进队列不丢行" / "批量确认后二次导入 100% 命中"）。**回流那 8 条**：写入（款+色 / confirmed / 店铺锚点是归一后的实体）· 两个款各指各的 `pl_products.id`（锚点取错会张冠李戴）· 顺带回填存量未归款订单 · **已有别的产品映射时只回报冲突、一行不动**（含 `deepStrictEqual` 证明连 source/更新时刻都没刷）· 颜色为空/占位只记款级 `*` · 已有款级映射时点名带色要**补出带色行并生效** · 重复点名回报 `already` 不写第二行 · 三条"不写"分支（无商品ID / 店铺未归一 / 产品库没这个款） |
| `style:smoke` | **款式主数据权威冒烟（22 项，P3 的 D1）** —— A 老库交接 / B 写侧唯一 / C 读侧五处派生 / D 订单导入接 `resolve` |
| `ae:smoke` | 成本口径冒烟（`ae_cost_map` 生效区间 P4a + **采集写主干** C1 + **落账即同步成本** S3，**23 项** —— 数字由脚本自计，不再手写）：含「行收入按**行金额占比**分摊（不是一律按 qty）」「缺汇率的订单照回且金额为 null」「采集帧的已知缺口如实投影（无店铺/商品ID/代征代缴列）」 |
| `ae:settle:smoke` | **结算明细冒烟（10 项，2026-09-29）** —— `ae_settle_lines` 落库幂等（幂等键 = 订单号+商品id+sku id；重导 = update 而非重复行）· **行类型由 `商品id` 是否为空判定**（不信入参自报）· 空订单号逐行 `failed` 不整批回滚· **订单口径优先取订单级行**（两类行不可相加）· **`items` 件数明细**（`lines` = 该 (订单,商品) 的商品行数 —— 存量测试确认去掉`lines++` 会变红）· `qty` 缺省/0/负数 → 1· `settleStats` 计数 |
| `picking:smoke` | **拣货投影冒烟（19 项，2026-09-30 / 2026-10-05）** —— `pickingRows` 是跨四张表的只读投影，错了都是静默的（图全空/待拣单不见了页面照样渲染）。覆盖：**未发货只认机械事实**（`ship_time` 空 且 `status<>'shipped'`；`includeShipped` 打开时照收）· **关闭单与无日期行本层不许筛掉**（口径在渲染层，存量测试确认改成 `1=1` 会变红）· **图三层回落**（覆盖图 > 订单图 > 款主图，占位图 `local_path=''` 时继续回落）· 识别链款编码/款色（映射命中 → `autoAssignByMap`）· 缺 `suppliers` 表降级不抛 · 店铺过滤 / 上限钳制 / 脏 `raw_fields` 不毁整批 · **映射带颜色**（`pl_shop_sku.spec` 承载颜色 → 归款写进款色 → 投影 `color` 回落款色；含三条易假绿的判据：**带色行优先于 `*` 行**、**映射写入后回填存量订单**、**回填不覆盖已有归款结论**，以及"缺省 `spec` 行为不变"的回归）。⚠️ 夹具必须与线上同形状 —— 曾经因建表带 `oi_styles.name` 而线上已 `DROP COLUMN`，导致**冒烟恒绿、线上必崩**（见 `docs/notes/2026-10-05-mapping-carries-color.md`） |
| `picking:xlsx:smoke` | **拣货单带图 xlsx 冒烟（15 项，2026-10-05，S3）** —— **界面冒烟验不到产物**（它只能断言"渲染层传了什么"），这个脚本**读回 zip 本身**：产物是合法 zip（PK 魔数）· **一个厂家一张 sheet**（未指定厂家自成一表、不混进任何厂家）· **媒体扩展名跟着「内容」推**（jpeg / png / webp；⚠️ `addImage({filename})` 忘给 `extension` 会写成 `xl/media/image1.undefined` 且包结构不合法）· **`[Content_Types].xml` 声明了 `image/jpeg` 且无 `undefined`** · 表名与顺序读回来 = 传入顺序 · **各表的数来自各自的行**（不是同一批复制两份）· **无进价行读回来是 `null` 而非 0**（0 会被当成"这件免费"）· 每表末尾「合计」= 本表各行之和 · 有图才有 media 部件 · **文件源：内容是 PNG 但名 `.jpg` → 取 `png`**（按内容不按名）· 内容是 WebP → `webp` · 认不出/文件不存在 → **不嵌也不抛**。⚠️ 本脚本是"同一流程只调一次 `process.exit`"的**唯一先例**（失败后用 `exit(0)` 会把红报成绿，实测） |
| `purchase:xlsx:smoke` | **拿货单导出 xlsx 冒烟（26 项，2026-10-05）** —— `picking:xlsx:smoke` 覆盖的是**纯生成层**，本脚本覆盖 `purchase-export-excel` 的**调用点**（此前 `scripts/` 下没有任何脚本 require 过 `purchase-handlers`，而它当时带着与拣货单**同一个** exceljs `extension` 真 bug）。做法：真 handler + 真 exceljs + 假对话框/假窗口（`Module._load` 替身），只把 `order-db.findStyleColorImagePath` 换成可控映射。断言：入参护栏（非对象/`items` 非数组 → `invalid payload`；洗完没行 → `没有可导出的行`）· **取消保存 → 输出目录里一个 `.xlsx` 都不多出来**（不是"写了再删"、也不是写到某个默认路径）· `defaultName` 的 `\ / : * ? " < > \|` 全换 `_`、扩展名固定 `.xlsx` · 表名「拿货单」+ 9 列表头 · **单价 = `priceCents/100`、金额 = 数量×单价** · **`priceCents===0` → 单价/金额留空**（不是 0.00）· **`qty===0` → 实拿数量/金额留空**（0 件 ≠ 尚未填数）· 款色为空的行照常导出（只是不查图）· 只填款名的行不丢 · **媒体扩展名跟着内容**（PNG 内容名 `.jpg` → `imageN.png`；base64 源恒 jpeg，所以是 png 就证明走的是**文件源**分支）· 无 `imageN.undefined` · `[Content_Types].xml` 有 `image/png` 无 `undefined` · 有 drawing 部件 · 有图行设了行高 · **`items` 超 500 截前 500**（剪入参） |
| `reset-dev-data` | **清库重跑（重构期）**：`node scripts/reset-dev-data.mjs`（默认干跑）/ `--yes`（先备份再清）。清 33 张业务+主数据表，保留迁移记账/账号/企业/汇率；执行前拒宿主在跑（并发纪律）。⚠️ 不可逆动作由**人**执行 |
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
> ⚠️ **prettier 不在门禁里**：`format:check` 当前对 **151 个文件**失败（2026-09-27 实测），是既有现状、不是回归
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
| 基线 | `PROJECT_BASELINE.md`（本文件） / `baseline/REFACTOR_PLAN.md` | 活跃 / 已完成归档 |
| 架构 | `architecture/PLUGIN_ARCHITECTURE.md` / `PLUGIN_DEVELOPMENT.md` / `UI_ISLAND_INTAKE_CHECKLIST.md` | 活跃（末者为 UI 岛接入 SOP + 故障速查 + 一键冒烟） |
| 业务 | `features/MAIL_INBOX.md` / `PROFIT_TRACKER.md` | 活跃 |
| 业务 | `features/PRODUCT_LIBRARY.md` | 活跃（P0–P3 + P4a 已落地，下一步 P4 成本界面 / P5 拣货） |
| 计划 | `plans/REMEDIATION_PLAN.md`（25/27 完成） / `PLUGIN_TRIAGE_PLAN.md`（T1–T6 完成） | 活跃 |
| 计划 | `plans/DOMAIN_INTEGRATION_PLAN.md`（S1 已实施，下一步 S2） / `SHIPPING_RATE_ISLAND_PLAN.md`（已执行） | 活跃 |
| 计划 | `plans/PAID_LICENSE_PLAN.md`（方案已定稿，未开工） | 活跃（付费授权：Pro 档功能 + 月/年双档订阅 + 零自建托管；三个执法闸门） |
| 决策 | `decisions/ADR-001-…`（岛设置留岛内） / `decisions/ADR-002-…`（主数据层） | 均已采纳（Accepted） |
| 审查 | `reviews/CODE_REVIEW_REPORT.md` / `HOST_REVIEW_2026-09-22.md` | 🗄️ 历史审计（对应发现项已转任务或已修） |
| 审查 | `reviews/ISLAND_COLD_START_AND_THEME_2026-09-22.md` | 活跃（结论已固化进 §11-10） |
| 用户 / 需求 / 归档 | `guides/USER_GUIDE.md` / `requirements/Requirements.md` / `archive/manual.md` | 活跃（覆盖面偏旧）/ 历史档案 / 已归档 |

> 现存 **34 个 `.md`**（含 `docs/README.md`）。判据是 `find docs -name '*.md'`，**不是记忆**——
> 这张表历史上长期只列 10 行、漏掉 `plans/` 与 `decisions/` 两个整类，正是靠这条命令发现并订正的。
> （2026-09-30 订正：原写 27，实测本轮改动前已为 32 —— 计数未随文档增删同步，属既有漂移。）

---

## 10. 质量门禁现状（重要）

| 门禁 | 命令 | 现状 |
|---|---|---|
| 类型检查（渲染层） | `npx vue-tsc --noEmit` | ✅ 0 error（含 `.vue` 模板；`strict: true`） |
| 类型检查（主进程） | `npx tsc -p tsconfig.electron.json --noEmit` | ✅ 0 error。⚠️ 该配置 `strict: false`（隐式 any 不拦；`noImplicitAny` 已开） |
| Lint | `npx eslint .` | ✅ **0 error** / 473 warning（绝大多数 `no-explicit-any`，非阻断）。⚠️ 基线是 **0 error**，新增的 `error` 级命中一律当回归（2026-09-27 被 `no-irregular-whitespace` 抓过一次：注释里"看着像空格"的全角 U+3000 真会报错） |
| 单元测试 | `npx vitest run` | ✅ **34 文件 / 569 用例**（environment: node，无 jsdom）。数变化的原因见 `CHANGELOG.md` 2026-10-05 的 Removed 段（删了 `aggregator` / `templateEngine` 两条 spec = −2 文件 / −46 用例） |
| IPC 契约 | `npm run verify` | ✅ **188** 声明 / **184** 通道，`✅ IPC 契约一致` |
| 文档链接 | `npm run verify:docs` | ✅ `✅ 无悬空引用`（历史文档里"已删除/从未存在"的陈述走脚本白名单）；2026-09-30 起含 **④ 反向守卫**：`docs/notes/*.md` 命名合规 + 已登记索引，零条目时显式打印"未验证任何内容" |
| UI 岛冒烟（真机接线） | `npm run plugins:island:smoke` | ✅ **6/6 岛** + 重启恢复 + 工具条文案体检（2026-09-30 实测） |
| UI 岛冒烟（无头 Chrome） | 手工（见技能 `esm-spa-headless-smoke`） | 岛侧现役只有 `shipping-rate:ui`（`excel-copy` 无冒烟）；宿主页见上表的 `today:ui` / `picking:ui` / `goods:ui` / `order-profit:ui`。⚠️ 原列的「`order-insight` 37 项断言」随该岛 2026-10-05 下架删除 |
| CI | — | ❌ 无 `.github/workflows` |

### 10.1 守卫分布（别重复加同类 spec）

| spec | 例数 | 守什么 |
|---|---:|---|
| `tests/pluginTriage.spec.ts` | 68 | 插件契约**双向**（调用 ⊆ 声明 + 声明了必须真调用）+ 岛能力缺口 + **db 能力域 op 预算**（超预算的三个域进 `GRANDFATHERED` 冻结，只允许变少） |
| `tests/shipRate.spec.ts` | 50 | 运价表归一化与计价：17 段互斥 / 大包回溯不得越类别起点 / 非普货不得归入普货 / `暂无服务` 不算脏数据 / 两种计价与进位边界 / 载荷预算 / 自动选表 / 表头版式族 1~3 行 / 最低计费重量 / 非本币拒算 / 行式分档表整节拒绝 |
| `tests/shopSku.spec.ts` | 25 | 「店铺商品ID」的归一键 |
| `tests/productImport.spec.ts` | 24 | 产品库导入的解析与逐行校验（表头在横幅之后仍能定位 / 厂家名对不上 id 时**不猜** / 手改出的重复编码同样被拦 / 状态中英映射 / 导出表头） |
| `tests/shipRateOrders.spec.ts` | 23 | 按订单算运费的数据衔接（国名解析 ISO·别名·前缀包含三路径 / `raw_fields` 键名回落 / 拒算五分类且 `reasonClass` 绑到行） |
| `tests/shopName.spec.ts` | 15 | 店铺名归一（零宽字符 / BOM / 全角空格 / 连续空白合并；**不做**大小写折叠、**不做**模糊匹配；每条"应等价"都配一条"不得等价"的反向断言） |
| `tests/importDetect.spec.ts` | 9 | 统一导入的**纯检测层**（四类文件的判据 + **判定顺序**（混合文件落更具体的那类）+ 认不出时说出「扫过哪些表」；报价单用**真实 21 张表夹具**）|
| `tests/mangoPendingImport.spec.ts` | 17 | 芒果店长待发货订单导入：识别判据**点名到子类** / 主图列 `detectImageColumnStrict` **不回落第一列**（负向：无图列报表不得被当成有图列）/ 真实 16 行夹具拆成 17 行的逐列对齐（图片·尺寸·商品ID）/ 件数 / 金额提列 / 一行→字段（店铺名落 shop、URL 必 trim） |
| `tests/orderCost.spec.ts` | 69 | 「订单成本」纯计算层：成本按生效区间取（同日 `manual` 优先 / 无命中回落最早一条）+ **缺口逐行标**（country/weight/rate/style/cost/**qty**）+ **任一分项缺失则 `total = null`**（0 与"不知道"必须分开，否则"缺成本"会显示成"零成本的高利润"）+ **件数口径**（结算商品行真值 → 报表块内 `商品数量` → 按 1 件并标缺；且件数**不进算术**）+ 维度汇总（款/国家/店铺/**SKU 款×色×码**/供应商/桶，含 `pieces` 件数合计） |
| `tests/picking.spec.ts` | 21 | 「拣货单」纯层：**分组键与件数口径与利润页同源**（`skuKey` / `resolveQty`）+ **范围口径**（已终结剔除 / 超窗剔除 / 无日期照收，三者都计数；两种日期写法都认）+ 缺口逐组计数（缺图/缺件数/缺供应商/未识别款）+ 排序确定（件数降序 → 键升序） |
| `tests/orderRowSplitter.spec.ts` | 28 | 一订单多产品拆行（两种多产品信号 / N 的兜底 / 缺图判定）+ **`parseRowQty` 件数提取**：只认这一行自己的商品信息块，多块原文与「数量」列（拆行后仍是整行值）一律拒绝 —— 猜错就是把拣货件数与成本放大 |
| `tests/settleImport.spec.ts` | 17 | 「结算明细」解析：按（商品id + 结算状态）选表 / 行类型由 `商品id` 是否为空判定 / 两条等式校验仅在"已结算且无退款"上生效 |
| `tests/aeMoney.spec.ts` | 14 | 采集链金额口径纯层（`electron/aeMoney.ts`，**单一口径源**：`ae-engine` 与 `ae-db.collectedOrderRows` 共用）：收入 = 商品+买家运费−退款 · 行收入**按行金额占比**分摊（缺失才回落 qty，再不行平分）· 汇率为 0/缺失 → `null`（不折成 0）· `skuProps` 只解析能确定的 |
| `tests/orderMoney.spec.ts` | 11 | 订单金额单元格解析（`CN￥ 1,234.56` → 分 + 币种；空 = null 不是 0）与状态/时点列族提取 |
| `tests/uiIslandBridgeLifecycle.spec.ts` | — | UI 岛接线：切岛重建桥 / 运行时随包分发 / 双端协议一致 / 启动时扫描先于恢复上次模块 |
| `tests/uiIslandThemeTokens.spec.ts` | — | `WB_THEME_TOKENS` 必须覆盖 `index.css` 的每个令牌（漏项 → 岛内 `var()` 解析失败，见 §11-6） |
| `tests/marketCache.spec.ts` | — | 市场侧每处 `downloadFile` 必须 `noCache:true`；本地市场服务必须 `no-store` 且不发 `Last-Modified`/`ETag` |
| `tests/uxEntryNames.spec.ts` | 2 | **悬空入口名**（UX 审查 C4 的机器化）：宿主文案里"去 / 在 / 到「X」"式引用必须是真实入口（宿主模块名 ∪ 岛 `displayName` ∪ `ALLOWED_NON_ENTRY` 里逐条写明理由的控件名）；**自证非空转**（零命中即失败，防模式写坏静默通过）；先剥注释（本仓注释里大量引号名） |
| `tests/pluginManifest.spec.ts` | — | 真实投产 manifest 的 schema 校验 |

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

