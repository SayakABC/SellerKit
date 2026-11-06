# SellerKit

跨平台电商运营工具箱（Electron + Vue 3 + TypeScript）。从「Excel 数据 → 模板文本 → 一键复制」的批量处理起步，逐步扩展为一套可插拔的桌面工具集。

## 功能

内建模块：

- **发货台** —— 订单导入、归类、拿货、对账，一页完成
- **基础数据** —— 店铺账号、货品档案（款 / SKU / 采集商品）、店铺登记、企业、供应商、成本与费率、物流运费
- **邮件** —— IMAP 多账号集中收件，全文检索、附件缓存
- **统计** —— 订单成本与利润核算
- **台账** —— 往来账与结算

插件体系：

- 外置插件运行在独立 Worker 沙箱，UI 岛经 iframe 加载；能力由 manifest 显式声明，逐调用授权
- 模块可按构建预设裁剪（`modules.config.json`），最小可打出纯外壳
- 示例岛：`excel-copy`（Excel 批量复制）、`ae-profit`（速卖通订单采集接收端，配合 [SellerKitExtensions](https://github.com/SayakABC/SellerKitExtensions) Chrome 扩展使用）

其他：AI 识别（OpenAI 兼容接口）、基于 electron-updater 的自动更新。

## 快速开始

环境要求：Node.js 22+、Python 3（编译 `better-sqlite3` 原生模块）、macOS 或 Windows。

```bash
npm install                       # postinstall 会自动重建原生模块
cp .env.example .env.development  # 按需修改 API 地址
npm run dev                       # Vite HMR + Electron
```

## 打包

```bash
npm run build        # 生产构建
npm run dist         # 当前平台安装包，产物在 release/
npm run dist:select  # 交互式勾选模块后打包
```

## 目录结构

```
electron/      主进程（CommonJS）：窗口、IPC、SQLite、网络转发
src/
  core/        平台核心：外壳、服务、网络层、插件内核
  modules/     内建业务模块
  lib/         纯函数库（Excel 解析、模板引擎等）
ui-plugins/    市场分发的 UI 岛
scripts/       构建、打包与冒烟脚本
tests/         vitest 单元测试
```

## 架构要点

三层进程边界，渲染层不直接访问 Node API：

```
主进程 electron/ ── 窗口 / 文件 IO / 网络(net) / SQLite / electron-store
       ↕ IPC（contextBridge 白名单）
渲染进程 src/ ── UI / 状态 / 业务逻辑
```

- 系统能力统一经 `src/core/services/ipc.ts` 封装；网络请求走 `src/core/network/request.ts`（axios → IPC → 主进程 `net`），规避 CORS。
- 数据存储：单库 SQLite（`<userData>/sellerkit.db`，按表分域）+ electron-store；店铺账号密码、IMAP 授权码存系统安全存储（Keychain / DPAPI）。
- 界面配色统一使用 `src/styles/index.css` 的 `--wb-*` 主题令牌，浅色 / 深色两套。

## 开发

提交前跑一遍门禁：

```bash
npm run lint                                  # ESLint
npm run verify                                # IPC 契约校验（preload ↔ types ↔ 主进程通道）
npm test                                      # vitest 单元测试
npx vue-tsc --noEmit                          # 渲染进程类型检查
npx tsc -p tsconfig.electron.json --noEmit    # 主进程类型检查
npm run build                                 # 生产构建
```

提交信息遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-CN/)，其余约定见 [CONTRIBUTING.md](CONTRIBUTING.md)。

使用 AI 编码助手时，先读 [AGENTS.md](AGENTS.md)（架构基线与编码红线）；工作进度统一记录在 [AI_PROGRESS.md](AI_PROGRESS.md)。

## 许可

本项目为专有软件，保留所有权利，详见 [LICENSE](LICENSE)。
