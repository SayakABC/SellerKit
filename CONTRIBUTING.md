# 贡献指南

面向**人类贡献者**。如果你是用 AI 编码助手改这个项目，请先读 [`AGENTS.md`](AGENTS.md)——
那是架构基线与编码红线的权威来源，本文件只补充"人"的协作流程。

---

## 1. 环境准备

**要求**：Node.js 22+、Python 3（`better-sqlite3` 原生模块需从源码编译）、macOS 或 Windows。

```bash
git clone <repo-url> && cd SellerKit
npm install                          # postinstall 会自动把 better-sqlite3 重建为本机 Electron ABI

cp .env.example .env.development     # 按需改 VITE_API_BASE_URL / VITE_REQUEST_ENGINE
npm run dev                          # Vite HMR + Electron
```

### 两个常见环境坑

- **原生模块 ABI 不匹配**：`npm install` 后若出现 `new Database()` 直接 **SIGSEGV**（不是抛异常），
  说明 `better-sqlite3` 还是 Node ABI 的二进制。执行 `npm run rebuild` 从源码重编。
  改了 `electron` 版本后**必须**重跑。
- **`ELECTRON_RUN_AS_NODE=1`**：某些 IDE/宿主环境会导出这个变量，会让 `npx electron xxx`
  与打包产物被当成普通 Node 运行（症状：`app` 为 `undefined`、进程瞬间退出且**无任何日志**）。
  排查与验证时用 `env -u ELECTRON_RUN_AS_NODE npx electron ...`。

---

## 2. 分支与提交

### 分支

| 前缀 | 用途 |
|---|---|
| `feat/` | 新功能 |
| `fix/` | 缺陷修复 |
| `refactor/` | 重构（**行为不变**） |
| `chore/` | 依赖升级、构建配置、工具链 |
| `docs/` | 仅文档 |

- `master` 保持可构建、门禁全绿。**不直接推 `master`**，走分支 + PR。
- 大版本依赖升级（Electron / Vite / Vue 大版本）请单独开分支，不要与功能改动混在一起——
  这类升级需要人工 GUI 回归，混在一起会让回滚粒度失控。

### 提交信息

遵循 [Conventional Commits](https://www.conventionalcommits.org/zh-CN/)：

```
<type>(<scope>): <中文简述>（<问题编号> / <任务编号>）

<为什么这么改——不是"改了什么"（diff 已经说明了），而是动机、取舍与被放弃的方案>

<验收证据：跑了哪些命令、观察到什么结果>

<未覆盖：哪些需要人工验证，别让读者误以为全绿就等于已验证>
```

- `type`：`feat` / `fix` / `refactor` / `perf` / `docs` / `test` / `build` / `chore`。
- 正文优先写**动机与取舍**。本项目的历史提交可作参考。
- 涉及行为变更时，**必须**在正文里写明验收证据与未覆盖项。

---

## 3. 门禁（提交前必须全绿）

```bash
npm run lint                                  # ESLint —— 门禁标准是 error 数 = 0（warning 存量允许）
npm run verify                                # IPC 契约校验（preload ↔ types ↔ 主进程通道）
npm test                                      # vitest 单元测试
npx vue-tsc --noEmit                          # 渲染进程 + tests 类型检查
npx tsc -p tsconfig.electron.json --noEmit    # 主进程类型检查
npm run build                                 # 生产构建
```

按改动内容**额外**跑对应的那一条：

```bash
npm run plugins:sandbox:smoke                 # 改了插件沙箱 → 沙箱全链路：boot → command → call → deactivate → token 拒绝
npm run verify:docs                           # 动了 docs/ 目录、删了任何 .md、改了引用路径 → 文档引用校验
```

> `verify:docs` 挡的是"读者点开一个不存在的文件"。这类损伤 lint 与 tsc 都看不见：
> 删一份文档不会让任何构建失败，只会让引用者踩空。其豁免表只承接**文档正在陈述
> "该路径不存在"**的句子（如"`core/layout/ContentHeader.vue` 从未创建"），每项必写理由。

**项目当前没有 CI**，以上全部靠本地手动执行——请如实执行，不要跳过。

### 改这几类东西时请特别小心

| 改动对象 | 为什么要小心 |
|---|---|
| `electron/preload.ts` / `src/types.ts` / `src/**/*-handlers.ts` | 三者构成 IPC 契约，改一处必须同步另两处；`npm run verify` 会拦，但**报错时不要把差异项塞进豁免清单** |
| `src/styles/index.css` 的 `--wb-*` | 令牌必须浅色/深色各定义一套；改令牌名要全局同步 |
| 色值 | 界面配色必须令牌化；**业务数据色**（如款色色卡）例外，见 `AGENTS.md` §1.6 的判定表 |
| `modules.config.json` / `vite.config.ts` | 构建期模块裁剪链路；`src/registry.generated.ts` 是自动生成的，**禁止手改** |
| `src/core/plugin/**` 与沙箱双端协议 | 受保护内核，改动前先读 `AGENTS.md` §4.4 与红线（沙箱协议常量必须双端同源） |

---

## 4. 测试约定

- 单元测试放在 `tests/`，命名 `*.spec.ts`，用 vitest。
- **只测可确定的部分**：纯函数（`src/lib/`）、契约（`electron/ipc-util.ts`）。
  需要 DOM / IPC / Electron 运行时的逻辑走冒烟脚本与人工回归。
- **夹具不要依赖被 `.gitignore` 忽略的文件**——那会造出"只在作者机器上能跑"的假测试。
  需要 Excel 夹具就用脚本生成后入库（参考 `tests/fixtures/generate-fixtures.mjs`）。
- **断言要钉契约，不要复述实现**。写完测试请做一次变异测试自检：故意改坏被测逻辑
  （去掉四舍五入、偏移一个 id、把兜底文案统一），确认测试真的会失败。若某次变异没被拦下，
  说明该用例取值太"干净"，补齐边界值（浮点残差、除不尽、空值、复合键歧义）。

---

## 5. PR 前检查清单

- [ ] 六个门禁命令全部通过（见 §3），并在 PR 描述里贴出关键输出
- [ ] 新增/变更的行为有对应测试，或明确说明为何无法自动化（并在 PR 里写出手工验证步骤）
- [ ] 触及 IPC 契约、主题令牌、构建裁剪链路时，已同步更新对应文档
- [ ] 提交信息写清了**动机**与**未覆盖项**
- [ ] 文档中的引用路径为**仓库根相对路径**，且指向的文件确实在库内（无悬空引用）
- [ ] 用户可见的行为变更已记入 [`CHANGELOG.md`](CHANGELOG.md) 的 `[Unreleased]`
- [ ] 若改了模块启停 / 打包范围，已确认 `node scripts/select-build.js --list` 输出符合预期

---

## 6. 发布

见 [`CHANGELOG.md`](CHANGELOG.md) 的「发布流程」与「发布前检查清单」。

---

## 7. 授权

本仓库尚无 `LICENSE` 文件——**对外分发或再发布前请先与维护者确认授权安排**
（仓库为上游 fork，需先厘清上游许可与本仓库的许可关系，不要臆造许可类型）。
