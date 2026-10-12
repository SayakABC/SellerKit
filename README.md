# SellerKit

跨平台桌面工具集（Electron + Vue 3 + TypeScript + Tailwind），核心是「Excel 数据 → 模板化文本 → 一键复制」的批量处理链路，并逐步扩展为可插拔的电商运营工具箱。

> 面向开发者。用户侧说明见 [`docs/guides/USER_GUIDE.md`](docs/guides/USER_GUIDE.md)。

---

## 核心能力

| 模块 | 形态 | 说明 |
|---|---|---|
| `excel-copy` | 市场 UI 岛（`ui-plugins/`，**不随宿主分发**） | 导入 Excel → 按模板生成文本 → 一键复制，智能跟踪记录使用状态 |
| `shop-accounts` | 市场 UI 岛（`ui-plugins/`，**不随宿主分发**） | 店群「店铺套」集中管理，密码经系统安全存储（Keychain/DPAPI）加密落库 |
| `ae-profit` | 市场 UI 岛（`ui-plugins/`，**不随宿主分发**） | 速卖通订单采集接收端（Chrome 扩展推送或 curl 样例），写入宿主订单主干 |
| `shipping-rate` | 市场 UI 岛（`ui-plugins/`，**不随宿主分发**） | 导入物流报价单，按克重 / 按订单 / 按产品试算到各国的实际运费 |
| `today` / `goods` / `order-cost` / `picking` / `quick-note` | 内建模块（`src/modules/`） | 随宿主分发：**发货台**（导入→归类→算钱→拿货→对账，一页六页签）、货与成本、算钱、拣货、便签 |

> 形态说明（判定规则见 `AGENTS.md` §1.9）：**市场 UI 岛**独立构建、打成 zip 走插件市场分发，运行时由宿主 iframe 加载，只经 `window.__sk` 桥调用宿主能力；
> 这些岛的 id 已从 `modules.config.json` 的构建预设里移除，源码在仓库 `ui-plugins/<id>/`，宿主侧数据层（SQLite / IPC / `db` 能力域）保留给岛调用。
> 因此上表 4 个岛均**不随安装包分发**，需从插件市场安装。
> 已整体下架的岛（功能收回内建，源码留档不入库）：**`product-library`**（2026-10-01，→ `src/modules/goods/**`）、
> **`order-insight`**（2026-10-05，→ `src/modules/today/**` 发货台）—— 见 `docs/notes/2026-10-01-ui-island-retirement.md`。
> **这里不写版本号**（版本每次发版都变）—— 权威清单见 `docs/baseline/PROJECT_BASELINE.md` §4 / §5。

支撑能力：集中收件箱（IMAP 多账号同步 / FTS 全文检索 / 附件缓存）、店铺账号管家、订单队列、AI 识别（OpenAI 兼容接口）、自动更新（electron-updater）。

---

## 快速开始

**环境要求**：Node.js 22+、Python 3（`better-sqlite3` 原生模块编译需要）、macOS / Windows。

```bash
npm install          # 装依赖（postinstall 会自动 rebuild 原生模块）

cp .env.example .env.development   # 按需修改 VITE_API_BASE_URL / VITE_REQUEST_ENGINE

npm run dev          # 开发：Vite HMR + Electron
npm run build        # 生产构建（会重新生成 src/registry.generated.ts）
npm run dist:select  # 交互式勾选模块 → 构建 → 出安装包
```

产物落在 `release/`。

---

## 目录结构

```
SellerKit/
├── electron/                    # 主进程（CommonJS / require）
│   ├── main.ts                  # 入口：窗口、生命周期、electron-store
│   ├── preload.ts               # contextBridge → window.electronAPI（133 个 invoke 通道，由 npm run verify 校验）
│   ├── ipc-handlers.ts          # 通用 IPC + 网络请求转发
│   ├── http-client.ts           # Electron net 请求客户端（协议/方法白名单）
│   ├── *-db.ts                  # SQLite 数据访问层（mail / order / purchase / ae / shop-accounts）
│   ├── *-engine.ts              # 业务引擎（mail 同步 / ae 利润计算）
│   ├── *-handlers.ts            # 分域 IPC 注册（ae / mail / order / purchase / shop-accounts）
│   ├── plugins-handlers.ts      # 外置插件目录第一层防线
│   └── plugin-ui-*.ts|js        # UI 岛运行时与自定义协议
├── src/                         # 渲染进程（ESM / Vite）
│   ├── core/                    # 平台核心，禁止业务逻辑
│   │   ├── AppShell.vue         # 工作台外壳
│   │   ├── components/          # TitleBar / SettingsModal / CommandPalette / ToastHost / PluginCenter / UiIslandView
│   │   ├── services/            # ipc / storage / theme / toast / clipboard / dialog / excel
│   │   ├── network/             # axios + IPC adapter（规避 CORS）
│   │   ├── plugin/              # 运行时插件内核（manager / sandbox / gatedHost / security / sdk）
│   │   ├── ai/                  # OpenAI 兼容客户端
│   │   ├── layout/              # SplitPane
│   │   └── types.ts             # ModuleMeta / ModuleDefinition / ModuleCommand
│   ├── modules/<id>/            # 内建业务模块
│   ├── extensions/../           # （见下方 extensions/）
│   ├── lib/                     # 纯函数：excelParser / templateEngine / fieldProcessor / aggregator …
│   ├── styles/index.css         # 全局样式 + 设计令牌（--wb-*，浅/深两套）
│   ├── types.ts                 # 业务共享类型 + ElectronAPI 接口
│   └── registry.generated.ts    # ⚠️ 自动生成，禁止手改
├── extensions/<id>/             # 随宿主分发的视图插件包（manifest.json + src/）；当前仅 excel-copy / order-insight **源码留档**（均已下记为市场岛）
├── ui-plugins/<id>/             # 市场分发的 UI 岛（kind: ui，静态产物）
├── scripts/                     # 构建 / 打包 / 脚手架 / 冒烟脚本
│   ├── templates/               # 插件脚手架：l2-plugin（L2 模板）/ l2-demo（L2 演示）；UI 岛模板见 ui-plugin-template/
│   └── lib/module-roots.cjs     # 模块根探测规则（vite.config.ts 与 select-build.js 共用，单一事实源）
├── docs/                        # 项目文档（入口见 docs/README.md）
├── modules.config.json          # 模块启用清单（单一事实源，纯 JSON 无转译）
├── AGENTS.md                    # 架构基线 + 编码红线（AI 编码必读）
└── electron-builder.yml         # 打包配置
```

---

## 架构要点

### 三层进程边界（不可违背）

```
主进程 electron/ (CommonJS)   ── 窗口 / 文件 IO / 网络(net) / SQLite / electron-store / IPC
        ▲ IPC (contextBridge)
preload.ts                    ── 仅暴露白名单 API 为 window.electronAPI
        ▲
渲染进程 src/ (ESM + Vite)     ── UI / 状态 / Excel 解析 / 模板引擎 / 业务逻辑
```

- 渲染层**禁止** `require` / `fs` / `path` / 直接文件系统访问；一切系统能力经 `src/core/services/ipc.ts` 封装。
- 组件**不得**直接调用 `window.electronAPI`。
- 禁止直接 `fetch` / XHR 跨域，一律走 `src/core/network/request.ts`（axios → IPC adapter → 主进程 Electron `net`）。

### 两套扩展机制

| | 构建期模块裁剪 | 运行时插件体系 |
|---|---|---|
| 载体 | `modules.config.json` → `vite.config.ts` → `src/registry.generated.ts` | `src/core/plugin/` |
| 单元 | 内建模块 / 视图插件包 | 内建插件（L0）/ 外置插件（L2 Worker 沙箱）/ UI 岛 |
| 隔离 | 未选中的模块不进 bundle | 外置插件源码在主线程不存在，跑在独立 module Worker |
| 权限 | — | manifest `capabilities` 显式声明 + `gatedHost` 逐调用判定 + 审计环 |

### 主题与样式

- **禁止硬编码色值**，一律用 `var(--wb-*)`；新颜色先在 `src/styles/index.css` 两套主题各定义令牌。
- 主色背景上的文字必须用 `--wb-primary-contrast`（不可写死 `text-white`）。

> 完整规则（含 23 条红线）见 [`AGENTS.md`](AGENTS.md)；当前状态快照见 [`docs/baseline/PROJECT_BASELINE.md`](docs/baseline/PROJECT_BASELINE.md)。

---

## 数据存储

| 类型 | 位置 | 内容 |
|---|---|---|
| electron-store | `<userData>/config.json` → `modules.<namespace>` | 各模块状态（`app-shell` / `excel-copy` / `order-insight` / `shop-accounts` / `plugins`） |
| SQLite | `<userData>` 下的分域 db 文件 | `sk_mail_*`（收件箱）、`oi_*`（订单洞察）、`purchase_*`（拿货对账）、`ae_*`（利润追踪）、`sk_shop_sets`（店铺账号） |
| localStorage | `sk_auth_token` | 会话 token（不落 electron-store） |
| 系统安全存储 | Keychain / DPAPI | 店铺账号密码、IMAP 授权码 |

---

## 文档导航

| 文档 | 说明 |
|---|---|
| [`AGENTS.md`](AGENTS.md) | **架构基线 + 编码红线**，改代码前必读 |
| [`docs/README.md`](docs/README.md) | 文档中心索引（全部文档地图） |
| [`docs/baseline/PROJECT_BASELINE.md`](docs/baseline/PROJECT_BASELINE.md) | 项目基线快照（结构 / 规模 / 契约 / 依赖现状） |
| [`docs/architecture/PLUGIN_DEVELOPMENT.md`](docs/architecture/PLUGIN_DEVELOPMENT.md) | 外置插件与 UI 岛开发、调试、发布 |
| [`docs/reviews/CODE_REVIEW_REPORT.md`](docs/reviews/CODE_REVIEW_REPORT.md) | 代码与文档审查报告（含风险分级与整改建议） |
| [`docs/guides/USER_GUIDE.md`](docs/guides/USER_GUIDE.md) | 用户使用指南 |
| [`CHANGELOG.md`](CHANGELOG.md) | 版本变更记录 + **发布流程与发布前检查清单** |
| [`CONTRIBUTING.md`](CONTRIBUTING.md) | 贡献指南（环境 / 分支 / 提交规范 / 门禁 / PR 清单） |

---

## 质量现状（2026-09-16）

六项门禁全部为**本地手动执行**（**项目仍无 CI**，这是当前最大的流程缺口）：

```bash
npm run lint                                  # ESLint（门禁标准：error 数 = 0）
npm run verify                                # IPC 契约校验（preload 键 ↔ types 声明 ↔ 主进程通道）
npm test                                      # vitest 单元测试（src/lib 纯函数层 / IPC 注册契约 / 色卡字典）
npx vue-tsc --noEmit                          # 渲染进程 + tests 类型检查
npx tsc -p tsconfig.electron.json --noEmit    # 主进程类型检查（strict:false + noImplicitAny:true）
npm run build                                 # 生产构建
```

手工冒烟（需环境）：

```bash
npm run plugins:sandbox:smoke                 # 插件沙箱全链路：boot → command → call → deactivate → token 拒绝
npm run mail:smoke                            # 邮件引擎冒烟（需真实 IMAP 凭据 MAIL_USER / MAIL_PASS）
```

**重要**：`npm test` 全绿 ≠ 整体已验证。单元测试只覆盖 `src/lib/` 纯函数层、`electron/ipc-util.ts`
注册契约与款色色卡；**组件 / Pinia store / 主进程业务逻辑 / 插件沙箱均无自动化覆盖**，
这些改动仍须手动回归（启动 / 导入 / 预览 / 复制 / 设置 / 主题 / 插件启停 / ⌘K / 邮件同步）。

历史风险已处置：`xlsx` 已换源至 SheetJS 官方 CDN 版本（消除 CVE-2023-30533 / CVE-2024-22363）；
Electron 33 → 44.4.1、Vite 5.4 → 8.3 均已升级（详见 [`CHANGELOG.md`](CHANGELOG.md)）。
详见 [`docs/reviews/CODE_REVIEW_REPORT.md`](docs/reviews/CODE_REVIEW_REPORT.md)。

---

## 相关仓库

| 仓库 | 角色 |
|---|---|
| `SellerKit`（本仓库） | 桌面主程序 |
| `SellerKitExtensions` | Chrome MV3 采集扩展（速卖通利润追踪采集端） |
| `SellerKitPlugin` | 插件市场托管 |
