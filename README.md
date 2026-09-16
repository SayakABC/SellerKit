# SellerKit

跨平台桌面工具集（Electron + Vue 3 + TypeScript + Tailwind），核心是「Excel 数据 → 模板化文本 → 一键复制」的批量处理链路，并逐步扩展为可插拔的电商运营工具箱。

> 面向开发者。用户侧说明见 [`docs/guides/USER_GUIDE.md`](docs/guides/USER_GUIDE.md)。

---

## 核心能力

| 模块 | 形态 | 说明 |
|---|---|---|
| `excel-copy` | 视图插件包（`extensions/`） | 导入 Excel → 按模板生成文本 → 一键复制，智能跟踪记录使用状态 |
| `order-insight` | 视图插件包（`extensions/`） | 订单导入 → 主图下载 → 指纹查重 → AI 识别 → 归类汇总，含拿货对账 |
| `shop-accounts` | 视图插件包（`extensions/`） | 店群「店铺套」集中管理，密码经系统安全存储（Keychain/DPAPI）加密落库 |
| `quick-note` | 内建模块（`src/modules/`） | 轻量便签 |
| `ae-profit` | 市场 UI 岛（`ui-plugins/`，**不随宿主分发**） | 速卖通利润追踪展示端，经 host `db` 能力域读写 |

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
│   ├── preload.ts               # contextBridge → window.electronAPI（130 个 invoke 通道）
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
├── extensions/<id>/             # 随宿主分发的视图插件包（manifest.json + src/）
├── ui-plugins/<id>/             # 市场分发的 UI 岛（kind: ui，静态产物）
├── scripts/                     # 构建 / 打包 / 脚手架 / 冒烟脚本
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

> 完整规则（含 22 条红线）见 [`AGENTS.md`](AGENTS.md)；当前状态快照见 [`docs/baseline/PROJECT_BASELINE.md`](docs/baseline/PROJECT_BASELINE.md)。

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

---

## 质量现状（2026-09-16）

项目**没有自动化测试、没有 ESLint/Prettier**，回归依赖 `vue-tsc --noEmit` 类型检查 + 手工冒烟脚本：

```bash
npx vue-tsc --noEmit                          # 渲染进程类型检查
npx tsc -p tsconfig.electron.json --noEmit    # 主进程类型检查
npm run plugins:sandbox:smoke                 # 插件沙箱全链路冒烟
npm run mail:smoke                            # 邮件引擎冒烟
```

已知风险（依赖侧）：`xlsx@0.18.5` 存在未修复 CVE（npm 上无补丁版本）、Electron 33 与 Vite 5 均已 EOL。详见审查报告。

---

## 相关仓库

| 仓库 | 角色 |
|---|---|
| `SellerKit`（本仓库） | 桌面主程序 |
| `SellerKitExtensions` | Chrome MV3 采集扩展（速卖通利润追踪采集端） |
| `SellerKitPlugin` | 插件市场托管 |
