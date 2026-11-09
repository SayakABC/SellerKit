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

环境要求：Node.js 22+（`.nvmrc` 固定 22.22.2，`package.json` 的 `engines` 会拦旧版本）、
Python 3（编译 `better-sqlite3` 原生模块）、macOS 或 Windows。

**macOS 系统版本是硬门槛**：Electron 44 要求 **macOS 13 (Ventura) 及以上**
（包内 `LSMinimumSystemVersion = 13.0`）。在 macOS 12 上运行二进制会直接
`dyld: Symbol not found: _OBJC_CLASS_$_SMAppService` —— 这既影响 `npm run dev` 拉起宿主，
也影响打开打好的安装包。Windows 侧只要 Windows 10+（仅 x64），不受影响。

```bash
npm install                       # postinstall 会自动重建原生模块
cp .env.example .env.development  # 按需修改 API 地址
npm run dev                       # Vite HMR + Electron（需 macOS 13+）
npm run dev:web                   # 只起 Vite，浏览器预览界面（无主进程，数据一律显示"未连接"）
```

> `npm run dev:web` 走 `public/web-bridge.js` 的空桥：所有 IPC 调用都返回失败，
> 页面能渲染、能看布局与交互，但**不会有真实数据**。它是给「这台机器跑不了 Electron」
> 时用的降级入口，不是第二条运行路径 —— 打包产物是 `file://`，不会加载该垫片。

## 打包

**原生模块决定了「一个平台只能打自己的包」**。`better-sqlite3` 是 C++ 插件，
electron-builder 会按当前构建机重编（或复用）它，但**不会跨平台交叉编译**。
在 macOS 上执行 `--win`，包里装的是 Mach-O：打包照样 `exit 0`、照样能上传 Releases，
Windows 用户装完到主进程 `require('bindings')('better_sqlite3.node')` 才崩。

实测 2026-09-04 那批 1.0.0 / 1.0.1 / 1.0.2 / 1.0.4 产物：8 个 mac 包的
`better_sqlite3.node` 架构各自正确；**9 个 win-x64 包内嵌的却全是 Mach-O x86_64**，
头 8 字节 `cffaedfe07000001`，不是 Windows PE。这些 Windows 包不要发布，
需在 Windows x64 构建机上重打。

| 目标产物 | 构建机 | 命令 |
| --- | --- | --- |
| mac arm64 + x64（dmg / zip 各两份） | macOS 13+，带能编译 C++20 的 Xcode CLT | `npm run dist:mac` |
| win x64（nsis / portable） | Windows 10+ / x64，装好 MSVC 生成工具 | `npm run dist:win` |

- 每台构建机都必须先 `npm install`（`postinstall` → `npm run rebuild`，编出该平台
  Electron 44 / ABI 149 的二进制）再打包。mac 双架构可以一次打完：electron-builder
  会按 target 分别重编，实测两个 zip 里的 `.node` 分别是 arm64 与 x86_64。
- `npm run dist:all`（`--mac --win`）在单台机器上必然有一个平台是坏包。
  `scripts/afterPack.js` 的原生模块门禁会在打包阶段**直接中止**，不让它悄悄产出。
- 发布前复核：`npm run release:check` 扫描 `release/` 下所有 mac zip / win exe，
  读出内嵌 `better_sqlite3.node` 的文件头比对目标平台，有坏包退出码 1。
  `.dmg` 与同名 `.zip` 由同一次打包产出、内容同源，校验 zip 即可。

```bash
npm run build         # 生产构建（不产出安装包）
npm run dist          # 当前平台安装包，产物在 release/
npm run dist:select   # 交互式勾选模块后打包
npm run release:check # 发布前复核已有产物的原生模块平台
```

> Electron 44 的 macOS 13+ 门槛见上文「快速开始」；Windows 侧为 Win10+ / 仅 x64。

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
