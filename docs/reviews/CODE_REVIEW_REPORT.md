# SellerKit 代码与文档审查报告

| 项 | 值 |
|---|---|
| 报告日期 | 2026-09-16 |
| 审查对象 | SellerKit 工作区（`/Users/ck/work/work/ai/SellerKit`） |
| git 基线 | commit `2f6e9f9`（branch `master`）+ 未提交工作区改动 |
| 版本 | `package.json` 1.0.4 |
| 审查范围 | `src/` `electron/` `extensions/` `ui-plugins/` `scripts/` 全部源码；10 份项目文档；构建与依赖配置 |
| 审查方式 | 静态分析（规模统计 / 交叉引用比对 / 契约集合求差）+ **实际执行两项类型检查** |
| 规则依据 | 根目录 `AGENTS.md`（架构基线 + 红线 1–23） |
| 当前状态快照 | `docs/baseline/PROJECT_BASELINE.md` |

---

## 摘要

**总体结论：项目架构纪律良好，工程化基础设施缺失，文档层明显滞后于代码。**

正面结论（架构约束执行力高于同类个人项目）：
- 三层进程边界**零违规**：渲染层无 `require`/`fs`/`path`/直接文件系统访问；无组件绕过 `core/services/ipc.ts` 直连 `window.electronAPI`；无裸 `fetch`/`XHR`。
- 129 个 IPC 通道与主进程注册集合**完全一致**（差集为空），100% kebab-case。
- `TODO/FIXME/HACK` **0 处**，注释掉的死代码 **0 处**，空 catch **0 处**。
- 持久化命名空间隔离、`registry.generated.ts` 自动生成纪律均被遵守（已 gitignore，无手改）。
- 两项类型检查**实测通过**：`vue-tsc --noEmit` 与 `tsc -p tsconfig.electron.json --noEmit` 均 exit 0。

严重度分布（合计 31 项：`C-01`–`C-21` 代码类 20 项，`D-01`–`D-12` 文档类 12 项，`C-08` 已并入 `C-03`）：

| 级别 | 数量 | 代表问题 |
|---|---:|---|
| 🔴 P0 | 1 | `xlsx@0.18.5` 两个未修复 CVE，npm 无补丁版本，且项目读取用户 Excel |
| 🟠 P1 | 13 | `dist:select` 静默产出残缺安装包（**已实测复现**）；深色主题 8 处白字白底（对比度低至 1.6:1）；`ElectronAPI` 缺 4 项声明；`vite.config.ts` 隐式依赖未声明的 `esbuild`；`extensions/ae-profit/` 迁移残留 1,532 行；零测试 + 无 Lint；4 份文档过期/重复；缺 `README.md` |
| 🟡 P2 | 17 | Electron 33 / Vite 5 均 EOL；683 行单函数；5 份重复 IPC 样板；`jszip` 隐式依赖；文档事实性错误 |

**文档层是最薄弱的环节**：10 份文档中 4 份已过期或与代码冲突，2 份内容高度重复，根目录**从未有 `README.md`**（实为 `Requirements.md` §10 早就写下的交付要求）。本次已建 `docs/` 分类体系完成整理（见 §5）。

---

## 一、审查方法与覆盖度

手段：文件规模统计（排除 `node_modules`/`dist`/`release`/`market-out`）、IPC 契约求差（`preload.ts` 暴露集 ↔ 主进程 `ipcMain.handle/on` + 封装注册集 ↔ `src/types.ts` `ElectronAPI`）、基线逐条核验（对照 `AGENTS.md`）、10 份文档全文通读 + 代码交叉验证 + 路径引用有效性检查、实测 `vue-tsc`/`tsc` 两项类型检查。

**本次未执行的验证（重要限制）**：
- ❌ **未运行 `npm run build`**——未验证构建与打包链路（仅改文档与注释，构建风险低，但基线快照中的产物路径与打包配置未实测）。
- ❌ **未运行冒烟脚本**（`plugins:sandbox:smoke`/`mail:smoke`）——避免对本地 `<userData>` 产生副作用。
- ❌ **未执行 `npm audit`**——沙箱无外网；依赖 CVE 结论来自官方公告与第三方复核，非本地实测。
- ⚠️ 依赖版本结论基于 `node_modules` 实际安装版本（已实测读取）。

---

## 二、代码审查

### 2.1 架构一致性——达标项
基线规则经实测**完全遵守**：渲染进程禁 `require`/`fs`/`path`（0 命中）；组件不直连 `window.electronAPI`（仅 4 处注释）；禁渲染层 `fetch`/`XHR`（0 命中，axios 仅 `src/core/network/request.ts:11` 一处）；`registry.generated.ts` 禁手改（AUTO-GENERATED + gitignore）；持久化走 `useModuleStorage`；模块均在 `modules.config.ts` 登记；129/129 IPC 通道 kebab-case；禁硬编码模板路径（经 `get-default-template-path`）；主进程 .ts 实质满足红线 12（两者均有顶层 import，TS 视为模块）。

### 2.2 C-01 🔴 P0 · `xlsx@0.18.5` 两个未修复高危漏洞
- 漏洞：**CVE-2023-30533**（原型污染，CVSS 7.8）、**CVE-2024-22363**（ReDoS，CVSS 7.5）。
- 为何危险：`0.18.5` 是 SheetJS 在 npm 上发布的**最后一个版本**，修复版（0.20.3+）**只发布在 SheetJS 自有 CDN**，不在 npm registry → `npm update`/`npm audit fix` 永远升不上去。
- 真实攻击面：核心功能就是**读取用户导入的 Excel**（`src/lib/excelParser.ts`、`extensions/*/src/store.ts`）。恶意 xlsx 可触发原型污染或 ReDoS 卡死。
- 影响：单用户桌面、导入自用文件，实际被利用概率不高；但**唯一可被外部文件触发的 P0**，修复成本极低。

**修复方案**（一次性，不改调用方）：

```jsonc
// package.json
"overrides": {
  "got": "^11.8.6",
  "cacheable-request": "^10.2.12",
  "xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"   // 新增
}
```

执行 `npm install` 后回归：Excel 导入/导出（`order-export-excel`、`exportWorkbook`）/字段规则匹配。备选：迁移至已依赖的 `exceljs@^4.4.0`，但 `excelParser.ts` 为受保护底层工具，迁移需搜全部调用方，成本高于 `overrides`。

### 2.3 C-03 🔴 P1 · 深色主题 8 处"白字白底"（对比度低至 1.6:1）
`AGENTS.md` §1.6/§7 记载过的历史坑在**语义色上再次复现**：`text-white` 压在语义令牌背景上，深色主题下实测对比度 `--wb-success`≈1.6:1、`--wb-warning`≈1.7:1、`--wb-danger`≈2.6:1（均远低于 WCAG AA 4.5:1）。`src/core/components/ToastHost.vue` 的 info 分支已用对写法，同文件内不一致。**结论：深色主题下徽标/提示文字几乎不可读，确凿可读性缺陷。**

违规 8 处（背景为语义令牌）：`ToastHost.vue:10,12`、`excel-copy/FieldRuleManager.vue:27`、`order-insight/CorrectionRow.vue:15`、`OrderInsightView.vue:24`、`OrderDetailTable.vue:112`、`ProductLibraryView.vue:118,119`（hover）。其中 `ToastHost.vue` 前两项优先级最高（全局 Toast）。

**修复**：`text-white → text-[var(--wb-primary-contrast)]`（该令牌浅色给白、深色给深，专为双向场景设计）。**误报已排除** 2 处：`ProductLibraryView.vue:79/85` 的 `bg-black/55` 是图片遮罩，白字正确。

### 2.4 C-02 🟠 P1 · `src/types.ts` 的 `ElectronAPI` 缺 4 项声明
`AGENTS.md` §1.1/§5 SOP 要求新增通道同步更新 `ElectronAPI`。实测：`preload.ts` 暴露 133 顶层键（130 invoke + 2 `on*` + 1 `platform`），`src/types.ts` 仅 129 项，**缺口 4**：`controlWindow`（`win-control`）、`getModuleState`/`setModuleState`（`get-module-state`/`set-module-state`，§1.4 核心通道）、`platform`。

**为什么现在没报错**：渲染层从 `ipc.ts` 封装层调用（返回类型独立声明），`preload.ts` 不在渲染层 tsconfig include 内 → 类型系统盲区，调用方拿到 `any`。两项类型检查仍 exit 0。**修复**：在 `ElectronAPI` 补齐 4 项声明（`getModuleState`/`setModuleState` 参考 `APIResult<T>` 包裹风格）。

### 2.5 C-04 / C-05 🟠 P1 · `extensions/` 结构性问题
- **C-04**：`extensions/ae-profit/` 是迁移残留（1,532 行，`kind:view`，但功能已迁到 `ui-plugins/ae-profit`）。它仍被 `tsconfig.json` include，**消耗每次类型检查时间**；当前未登记进任何 profile 故暂不被构建收录，但误加进 profile 即命中"同名 id 占用"静默运行时问题。**建议**：确认等价后删除。
- **C-05**：`extensions/` 混放三类语义不同内容——① 视图插件包（有 `meta.ts`，`kind:view`，被 registry 收录）；② UI 岛迁移残留（`ae-profit`，意外安全不被收录）；③ 外置插件脚手架（`_template`/`sk-hello`，无 `kind` 无 `src`，设计如此但不被收录）。②③ 目录位置极易与①混淆。**本次已在 `AGENTS.md` 新增 §1.9 判定表与红线 23**，机制歧义在文档层消除；物理分离仍待决策。

### 2.6 C-06 🟠 P1 · 无 ESLint/Prettier，10 处 `eslint-disable` 空转
无 `.eslintrc*`/`eslint.config.*`、无 `.prettierrc*`、devDeps 无 eslint/prettier、`package.json` 无 lint/format 脚本；代码中有 10 处 `eslint-disable-next-line no-console` 因 lint 从未运行而**无效**。`AGENTS.md` §6 的"无 lint 红色波浪线"无工程化支撑。2.3/2.4 的问题本可用 lint 规则自动拦住。

**整改结论（R2-3，已完成）**：
- 配置：`eslint.config.mjs`（flat）+ `.prettierrc` + `.prettierignore`；`lint`/`lint:fix`/`format`/`format:check` 脚本。
- 范围：`src/**` `extensions/**` `electron/**` `scripts/**` + 根构建配置；**`ui-plugins/**` 有意排除**。
- 样式令牌红线：`vue/no-restricted-class` **error** 级，正则覆盖调色板具名色、透明度变体、变体前缀（`hover:`/`dark:`/`sm:`/`group-hover:`）、`!important`、任意值色；令牌写法 0 误报。
- 空转注释 11 处（10 `no-console` + 1 `no-control-regex）**已全部真实生效**；补齐"核心 ESLint 规则同样作用于 .ts"。
- 验收：`npm run lint` → 0 error（356 warning 为存量 `any`/`console`）；`vue-tsc` exit 0；`npm run build` 通过且 `registry.generated.ts` 逐字节一致。
- 顺带修：2 处 `prefer-const`、3 处 `no-useless-escape`、`src/env.d.ts` 空白 `{}` 类型、`globals` 补为显式 devDependency。
- **残余缺口**：`vue/no-restricted-class` 不解析三元与 `&&`/`||` 表达式；核心规则看不到 `<template>` 内部。已在 `AGENTS.md` §6.1 明写"禁止在三元/`&&` 分支里写调色板类名"。
- **Prettier**：未做全仓 `--write`（125 个文件未格式化，避免淹没真实改动），`format:check` 不纳入门禁。

### 2.7 C-07 🟠 P1 · 零自动化测试，无 CI
全仓 0 个 `*.test.*`/`__tests__`；无 vitest/jest/playwright 配置；`package.json` 无 `test` 脚本；无 `.github/workflows`。最接近测试的资产是 3 个手工冒烟脚本（`sandbox-smoke` 192 行 / `mail-engine-smoke` 150 行 / `mail-smoke` 129 行，均无断言框架）。`src/lib/` 下 7 个纯函数层（excelParser/templateEngine/fieldProcessor/orderRowSplitter/aggregator/orderClassifier/styleMatcher）**零测试覆盖**，回归症状是"静默产出错误文本"。**建议**：引入 `vitest`，优先覆盖 `src/lib/`。

**整改结论（R2-5，部分完成）**：
- `vitest@^2.1.9` + `vitest.config.mts`（node 环境、`TZ=Asia/Shanghai`）+ `test`/`test:watch` 脚本。
- 覆盖 `src/lib/` **全部 7 模块，131 用例全绿**（~0.3s）；夹具 `tests/fixtures/orders.xlsx` 入库（避免依赖被 gitignore 的真实 Excel）。
- 断言钉契约（缺字段标记、两位小数、id 起始值、表头补位、掩码优先级等）；`tests/**` 纳入 tsconfig。
- 验收：131 passed；**变异测试**三种变异均被拦下；`npm run lint` 0 error；build 通过。
- **仍未覆盖（不能标"已修复"）**：① 无 CI；② 组件/Pinia store/主进程/插件沙箱无自动化；③ 无 E2E。已写入 `AGENTS.md` §6.3"测试全绿 ≠ 整体已验证"。

### 2.8 C-10 🟡 P2 · 依赖与工具链版本风险
- `xlsx` 0.18.5 → 见 2.2（CDN overrides）。
- `electron` 33.4.11：已 **EOL**（官方仅维护最新 3 大版本，当前 44.x），落后 11 个大版本（Chromium M130→M152、Node 20→24），升 43/44 需回归原生模块与 `afterPack.js`。
- `vite` 5.4.21：已 **EOL**；Vite 8 换 Rolldown+Oxc，属架构级变更（见 2.12）。
- `tailwindcss` 3.4.19（落后 1 大版本 v4，CSS-first 大改，暂缓）、`pinia` 2.3.1（落后 2 大版本，与 Electron 升级一起评估）、`electron-store` 8.2.0（ESM-only，已用动态 `import()` 兜底降级，属已知规避）。
- `better-sqlite3` 12.11.1（需原生编译，postinstall 已 rebuild）、`vue`/`typescript`/`axios`/`vue-tsc` 均健康。
- **C-17**：`package.json` 声明 `typescript:^5.4.2` 实测 5.9.3，已修正 `AGENTS.md` §6 注释。

### 2.9 C-11 / C-12 / C-14 🟡 P2 · 代码复杂度三个集中点
- **C-11 超长函数（>150 行，5 个）**：`pluginManager.ts:193` 的 `createBuiltinPluginManager`（**683 行**，混合发现/激活/贡献注册/启停/持久化多职责，最严重）、`sandbox.ts:122`（344）、`ae-engine.ts:133`（202）、`mail-engine.ts:432`（167）、`uiBridgeHost.ts:223`（158）。`pluginManager.ts` 为受保护内核，建议按四职责抽子模块，保持门面不变。
- **C-12 重复 IPC 注册样板（5 份）**：`order-handlers.ts:99-107` 与 `purchase-handlers.ts:16-24` 逐字节相同；`ae/mail/shop-accounts-handlers` 各一份 `handle<T>` 拷贝。建议抽 `electron/ipc-util.ts`（属 §4.2 需先理解 IPC 模式）。
- **C-14 `any` 约 288 处**：主进程 267（`preload.ts` 97、`main/mail-engine/mail-handlers` 68）、`extensions` 11、`src` 10。

**整改结论（R2-6，已完成）**：新增 `electron/ipc-util.ts`，两种契约**有意不合并**（`register` 服务写型域 order/purchase，主动回传 `{success:false}`；`handle<T>` 服务查询型域 ae/mail/shop-accounts）。5 份拷贝 65 行 → 共享模块 + 5 行 import，净减 59 行，入参校验全部保留。顺手修：`err.message → err?.message`（否则 `throw null` 会让 IPC reject）。验收：tsc exit 0；build 通过；`npm run verify` 主进程 129 通道不变；`npm test` 145 passed。**残余**：`order-export-excel` 仍裸 `ipcMain.handle`（需 `event.sender` 反查父窗口），行为无差异。

**C-13（✅ 已整改，R3-4）**：`noImplicitAny` 已开启（初测 61 错清零，顺带补 `@types/mailparser`/`@types/yauzl`、修 `simpleParser` 类型失真）。`strict:false` 保留为**有意决策**（渐进收紧，见 `AGENTS.md` §6.0.1）。渲染层 `tsconfig.json` 为 `strict:true` ✅。

### 2.10 C-15 / C-16 🟡 P2 · 版本管理异常
- `electron-builder.yml` `buildVersion:1.0.0` vs `package.json` `version:1.0.4` 不一致（影响打包版本元数据，与 electron-updater 比对可能偏差）。**建议**：删 `buildVersion`（默认继承 version）。
- git tag `v1.0.0/1.0.1/1.0.2/1.0.4` **四个全指向同一 commit `9ccb73d`**；缺 `v1.0.3`，版本历史不可追溯。**建议**：后续严格「bump version → 打 tag → dist」。

### 2.11 C-20 / C-18 / C-19 🟠 P1 · 配置与脚本层隐式依赖与失效入口

#### C-20 🟠 P1-High · `npm run dist:select` 静默产出残缺安装包（**已实测复现**）
`scripts/select-build.js:23` 只扫 `src/modules`，而 Phase 5 外挂化后 `excel-copy`/`order-insight`/`shop-accounts` 源码已迁至 `extensions/<id>/src`，`src/modules/` 只剩 `quick-note`。后果：选择器只列出 `quick-note`，`MODULE_IDS` 覆盖 profile，构建裁剪掉三个主力模块，**产出只有便签的安装包且全程无警告**。这是**唯一被实测复现的功能性缺陷**，且属"静默产出错误交付物"。

**修复**：`scanModules()` 同时扫双根（复用 `vite.config.ts` 判定：目录下有 `meta.ts` 即视为视图插件包），跳过 `_template`/无 `meta.ts` 目录：

```js
const MODULE_ROOTS = [
  { dir: path.join(root, 'src', 'modules'),          probe: (d) => path.join(d, 'meta.ts') },
  { dir: path.join(root, 'extensions'),              probe: (d) => path.join(d, 'src', 'meta.ts') },
];
```

验收：`node scripts/select-build.js --list` 应输出 4 项。

#### C-18 🟠 P1 · `vite.config.ts` 隐式依赖未声明的 `esbuild`（Vite 升级硬阻塞）
`vite.config.ts:5` `import { transformSync } from 'esbuild'`，但 `package.json` 未声明，实际仅因 `vite@5` 传递依赖存在。风险：① Vite 8 用 Rolldown+Oxc 取代 esbuild → 升级即崩；② 依赖树变动即崩。**推荐修复**：把 `modules.config.ts` 改为 `modules.config.json`（纯字面量结构，无需 TS 转译），`vite.config.ts` 改 `JSON.parse(readFileSync(...))`，一并消除隐式依赖、扫清 Vite 8 障碍、少一次转译。

#### C-19 🟡 P2 · `scripts/publish-plugin.js` 隐式依赖未声明的 `jszip`
`require('jszip')` 未声明，仅因 `exceljs → jszip` 传递依赖。风险低于 C-18，但性质相同。**排查误报**：同批扫描报 `select-build.js` 用未声明 `readline` —— 实为 Node 内置模块，误报。

### 2.12 C-10 补充 · 依赖升级目标版本（已核实）
- **Electron**：当前 33（2025-04-29 已 EOL 约 1 年 4 个月）；受支持最新 44（2026-08-25，44.3.0），43/42 也受支持（42 约 1 个月后到期）。建议目标 **43 或 44**（跨 11 大版本，需重编译 `better-sqlite3`、重验 `afterPack.js` 的 ElectronAsarIntegrity）。
- **Vite**：当前 5.4 不再支持；8.1 常规补丁、7.3/8.0 仅重要修复、6.4 仅安全补丁。**Vite 8 是架构级变更**（Rolldown+Rolldown 取代 Rollup+esbuild），直接触发 C-18 阻塞，且需重查 `@vitejs/plugin-vue` 兼容；要求 Node 20.19+/22.12+。

---

## 三、文档审查

### 3.1 整理前文档清单（10 份，3,651 行）
`AGENTS.md`(296,活跃但3处滞后)、`PLUGIN_ARCHITECTURE.md`(648,活跃)、`PLUGIN_DEVELOPMENT.md`(392,活跃)、`PROFIT_TRACKER.md`(154,内部矛盾)、`MAIL_INBOX.md`(318,活跃)、`PROJECT_OVERVIEW.md`(330,**2026-06-03 严重过期**)、`REFACTOR_PLAN.md`(252,状态标记失效)、`Requirements.md`(305,**过期+事实错误**)、`SellerKit_使用指南.md`(585,覆盖面偏旧)、`manual.md`(371,**重复+过期**)；**缺 `README.md`**。

### 3.2 D-01 / D-02 / D-03 🟠 P1 · 三份文档已失效
- **D-01 `PROJECT_OVERVIEW.md`** 写于 2026-06-03，与现状严重脱节：标题"IPTV 模板复制工具"（已更名 SellerKit）、目录根 `iptv/`、称有已删除的 `src/components/*`/`stores/app.ts`、IPC 自述 9 个通道却只列 8 条、引用不存在的 `测试模板.txt`、`get-store`/`set-store` 已换 `get-module-state`/`set-module-state`、未提插件体系/SQLite/`src/core/ai` 等。**对新人有实质性误导风险。**
- **D-02 `manual.md` 与 `SellerKit_使用指南.md` 高度重复**：`manual.md` 是子集（缺字段规则/列显示控制/打包产物三章），且大量陈旧标记（`cd iptv`、版本 1.0.0、`Ctrl+Z` 重复两行、仅 arm64）。两者均未覆盖 2026 年后新能力（店铺账号/订单归类/收件箱/自动更新）。
- **D-03 `Requirements.md`** 含失效绝对路径 `/Users/ck/.../iptv/导出测试.xlsx`、§7.1 与 §8 整节重复、引用从未存在的 `src/lib/electronAPI.ts`/`TemplateEditor.vue`；§10 要求"提供简短 README"直到本次才完成。

### 3.3 D-04 / D-05 / D-06 / D-11 / D-12 🟡 P2 · 文档内部矛盾与事实错误
- **D-05 `PROFIT_TRACKER.md`** 自相矛盾：§7 落位写 `extensions/ae-profit`，§10 的 `D1'` 又写已迁 `ui-plugins/ae-profit` 且标"已被 D1' 取代"；§5 列的两张表在 `ae-db.ts` 尚未实现。
- **D-04 `REFACTOR_PLAN.md`** 仍用 🔲 标记未完成，但代码核验 Phase 0–3 均已落地（仅 `ContentHeader.vue` 从未创建）。
- **D-06 `AGENTS.md` 3 处滞后**：§1.2 目录树缺 `core/ai`/`core/layout`/`ui-plugins`；§1.4 命名空间只列 2 个实际至少 5 个；§6 把 TS 版本绑死 5.4（实际 5.9.3）。本次已修正。
- **D-11 `PLUGIN_ARCHITECTURE.md` §4** 的 Monorepo 是纯目标态，未标注"未采纳"，易误读为现状。
- **D-12 事实错误汇总**：`manual.md`（`cd iptv`/版本 1.0.0/`Ctrl+Z` 重复/仅 arm64）、`PROJECT_OVERVIEW.md`（`测试模板.txt` 不存在/通道数错/仅 arm64）、`Requirements.md`（失效路径/重复章节/引用不存在文件）、`SellerKit_使用指南.md`（称数据在 `seller-kit/config.json` 平铺，与 `AGENTS.md` §1.4 命名空间描述冲突；默认模板占位符缺陷；仅 arm64；未覆盖新模块）。**版本漂移交叉验证**：使用指南与 manual 口径互相冲突。

### 3.4 D-08 / D-09 / D-10 🟠 P1 · 缺失文档
- **`README.md`**：✅ **本次已补**。
- 仍缺：`CHANGELOG.md`（版本演进不可追溯，叠加 C-16 tag 异常）、`CONTRIBUTING.md`、`LICENSE`（注意上游 `SayakABC/SellerKit`）、IPC 通道精确契约表（129 通道无成文表，本次在基线 §5 给分域清单与提取命令）、数据库 schema 汇总（本次基线 §6 补全表名级）、部署发布说明。已补：目录结构说明（README+基线 §2）、环境变量说明（基线 §8）。

### 3.5 D-07 🟡 P2 · 交叉引用有效性
`PLUGIN_DEVELOPMENT.md:6` 引用 `PLUGIN_ARCHITECTURE.md`，但 `.gitignore` 忽略后者而保留前者 → 克隆仓库必见失效引用；同主题两文档入库策略不一致。**本次处理**：保留原入库策略，但在 `.gitignore` 写明边界，并在 `docs/README.md` 单列「版本管理策略」。是否让架构类文档入库属产品决策。

---

## 四、发现项汇总（按优先级排序）

### 整改状态总览（滚动更新）
> 任务编号与依赖见 `docs/plans/REMEDIATION_PLAN.md`；未列入表 = 尚未处理。

| 发现项 | 任务 | commit | 状态 |
|---|---|---|---|
| C-01 xlsx 两 CVE | R0-1 | `2b122ca` | ✅ 已修复（SheetJS CDN 0.20.3） |
| C-20 `dist:select` 扫描根 | R1-1 | `6a958b3` | ✅ 已修复（抽 `scripts/lib/module-roots.cjs`） |
| C-03 深色白字白底 8 处 | R1-2 | `c5b6c51` | ✅ 已修复（`--wb-primary-contrast`） |
| C-02 `ElectronAPI` 缺 4 项 | R1-3 | `12947ad` | ✅ 已修复（三处声明 133 项一致） |
| C-15 `buildVersion`≠`version` | R1-4 | `f8fc95d` | ✅ 已修复 |
| C-04 `extensions/ae-profit/` 残留 | R1-5 | `ad7471d` | ✅ 已修复（删除） |
| C-18 esbuild 隐式依赖 | R2-1 | `ee912ec` | ✅ 已修复（`modules.config.json`） |
| C-19 jszip 隐式依赖 | R2-2 | `ad91889` | ✅ 已修复 |
| C-06 无 ESLint/Prettier | R2-3 | `3ac8b7a` | ✅ 已修复 |
| C-02 复发防护/D-10 契约表 | R2-4 | `305669c` | ✅ 已修复（`npm run verify` 动态求差） |
| C-07 零自动化测试 | R2-5 | `62a760d` | ✅ 部分（vitest 覆盖 `src/lib/` 131 用例；**仍无 CI**） |
| C-21 源码内嵌裸控制字节 | R2-8 | `b18166e` | ✅ 已修复（7 字节转义） |
| C-12 5 份重复 IPC 样板 | R2-6 | `f82ef04` | ✅ 已修复（抽 `ipc-util.ts`，净减 59 行） |
| C-09 组件硬编码色值 | R3-5 | `44c7521` | ✅ 已修复（色卡抽 `lib/colorSwatch.ts`） |
| C-10 Electron/Vite EOL | R3-1/R3-2 | `356ec1c`/`699bc4c` | ✅ 已修复（Vite 5→8、Electron 33→44，GUI 回归待人工） |
| C-13 `strict:false` | R3-4 | — | ✅ 已整改（`noImplicitAny` 开启，`strict:false` 有意保留） |
| C-17 TS 版本注释 | — | — | ✅ 已在 `AGENTS.md` 修正 |

### 🔴 P0 —— 建议尽快处理
| ID | 问题 | 位置 | 修复成本 |
|---|---|---|---|
| C-01 | `xlsx@0.18.5` CVE-2023-30533 + CVE-2024-22363，npm 无补丁 | `package.json` | 低（1 行 `overrides`） |

### 🟠 P1 —— 明确的规则违反或实质误导
| ID | 问题 | 位置 | 修复成本 |
|---|---|---|---|
| **C-20** | `dist:select` 只扫 `src/modules`，静默产出残缺安装包（已复现） | `scripts/select-build.js:23` | 低 |
| **C-18** | `vite.config.ts` 隐式依赖未声明 `esbuild`；Vite 8 硬阻塞 | `vite.config.ts:5` | 中（改 JSON 配置） |
| C-03 | 深色 8 处白字白底，对比度 1.6:1 | 见 2.3 | 低 |
| C-02 | `ElectronAPI` 缺 4 项声明 | `src/types.ts` | 低 |
| C-04 | `extensions/ae-profit/` 残留 1,532 行 | `extensions/ae-profit/` | 低（已删除） |
| C-05 | `extensions/` 混放三类语义内容 | `extensions/` | 中 |
| C-06 | 无 ESLint/Prettier，10 处 disable 空转 | 项目配置 | 中（已修复） |
| C-07 | 零测试、无 CI | 项目配置 | 中高（测试网已建，CI 未建） |
| D-01 | `PROJECT_OVERVIEW.md` 严重过期会误导新人 | 文档 | 低（已加标注，建议重写或删） |
| D-02 | `manual.md` 与 `USER_GUIDE.md` 重复 | 文档 | 低（已归档 manual） |
| D-03 | `Requirements.md` 过期+事实错误 | 文档 | 低（已加标注） |
| D-08 | 缺 `README.md` | 根目录 | ✅ 已完成 |
| D-09 | 缺 `CHANGELOG.md`/`CONTRIBUTING.md`/`LICENSE` | 根目录 | 中 |

### 🟡 P2 —— 改进项
| ID | 问题 | 位置 |
|---|---|---|
| C-09 | 组件硬编码色值（`ProductLibraryView` 18 处 hex；`MailAccessDrawer` box-shadow） | `extensions/order-insight`/`shop-accounts`（✅ R3-5 已修） |
| C-10 | Electron 33 / Vite 5 EOL（目标见 2.12） | 依赖（✅ R3-1/R3-2 已修） |
| C-11 | 5 个超长函数，最严重 683 行 | `pluginManager.ts:193` 等 |
| C-12 | 5 份重复 IPC 注册样板 | `electron/*-handlers.ts`（✅ R2-6 已修） |
| C-13 | 主进程 `strict:false` 与 `any` 密度不匹配 | `tsconfig.electron.json`（✅ R3-4 已开 `noImplicitAny`） |
| C-14 | `any` 约 288 处（主进程 267） | 主进程 |
| C-15 | `buildVersion` 1.0.0 ≠ `version` 1.0.4 | `electron-builder.yml`（✅ 已修） |
| C-16 | 4 个 tag 指向同一 commit，无 v1.0.3 | git |
| C-17 | 文档称 TS 5.4，实际 5.9.3 | ✅ 已修正 |
| C-19 | `publish-plugin.js` 隐式依赖 `jszip` | `scripts/publish-plugin.js:28`（✅ 已修） |
| C-21 | 源码内嵌裸 C0 控制字节（2 文件变"二进制"） | `electron/mail-cache.ts`/`mail-db.ts`（✅ R2-8 已修） |
| D-04 | `REFACTOR_PLAN.md` 状态标记失效 | 文档 |
| D-05 | `PROFIT_TRACKER.md` §7 与 D1' 矛盾 | 文档 |
| D-06 | `AGENTS.md` 3 处滞后 | ✅ 已修正 |
| D-07 | 入库策略不一致致引用失效 | `.gitignore`+文档 |
| D-10 | 缺 IPC 通道精确契约表 | 文档 |
| D-11 | `PLUGIN_ARCHITECTURE.md` §4 Monorepo 未标目标态 | 文档 |
| D-12 | 多份文档事实性错误 | 文档 |

### 已确认的正面结论（无需处理）
- 三层进程边界零违规；129 IPC 通道集合一致且 100% kebab-case
- `TODO/FIXME` 0 处、死代码 0 处、空 catch 0 处
- `src/` 与 `extensions/` 无 Tailwind 调色板类 0 命中
- 两项类型检查实测通过
- `sandboxRuntime.ts` 的 `@ts-nocheck` 与 3 处硬编码色值误报已排除

---

## 五、本次已执行的变更

> 用户选择「建 docs/ 并迁移分类」+「只报告不改代码」。以下均经授权，**未修改业务逻辑**。

- **文档结构整理**：迁移 9 份文档到 `docs/{baseline,architecture,features,guides,requirements,reviews,archive}/`，git 已跟踪用 `git mv`（保留 history），未跟踪用 `mv`。整理后**根目录仅剩 `README.md` + `AGENTS.md`**。
- **新建文档**：根 `README.md`（入口）、`docs/README.md`（文档地图）、`docs/baseline/PROJECT_BASELINE.md`（11 章基线快照）、本文件。
- **`AGENTS.md` 基线修正**：顶部加导航指向基线/`docs/README.md`；§1.2 目录树补全 `core/plugin`(13 文件)/`core/ai`/`core/layout`/`lib`/`ui-plugins`；§1.4 命名空间补全为 5 个；新增 §1.9 判定表 + 红线 23；§6 修正 TS 注释并加质量门禁警示。
- **文档内容修正**：`PROFIT_TRACKER.md` §7 改 `ui-plugins/ae-profit`；`manual.md` 加归档横幅；`PROJECT_OVERVIEW.md` 加过期横幅（**该文件已于 R4-1 删除**）；`Requirements.md` 加历史档案横幅；`REFACTOR_PLAN.md` 状态改"已完成并归档"。
- **交叉引用同步（16 处）**：迁移打断的裸文件名引用全部改为仓库根相对路径，详见 `npm run verify:docs`（R4-7 复核）。
- **`.gitignore` 同步**：原忽略清单已整体改为 **`AGENTS.md` 与 `docs/**` 全部入库**（R4-5 推翻原"内部文档不入库"策略）。

---

## 六、验证方式

**本次已实测**：`npx vue-tsc --noEmit` ✅ exit 0；`npx tsc -p tsconfig.electron.json --noEmit` ✅ exit 0；`git status --short` 确认仅文档/注释/`.gitignore` 变更。

**建议用户补充**：`npm run build`（验证 registry 生成）；`npm run plugins:sandbox:smoke`；`npm run mail:smoke`；手工回归（导入 Excel → 预览 → 复制 → 设置 → 深色主题看 Toast/徽标可读性）。

**各修复项针对性验证**：C-01 导入多 Sheet 真实 Excel/导出/字段匹配；C-03 深色主题触发成功/错误 Toast；C-02 补完后 `vue-tsc` 仍 0；C-04 确认 `ui-plugins/ae-profit` 等价、构建无内建条目；C-07 先覆盖 `excelParser`/`templateEngine` 用真实 Excel 做黄金用例。

---

## 七、建议的处理顺序

按「风险 × 修复成本」分三批（与 `docs/plans/REMEDIATION_PLAN.md` 一致）：

**第一批 · 低风险高收益**：1. C-20 修 `select-build.js` 扫描根（已复现，成本极低）；2. C-01 xlsx `overrides`（唯一 P0）；3. C-03 8 处类名替换；4. C-02 补 4 项声明；5. C-04 删残留；6. C-15 对齐 `buildVersion`。

**第二批 · 工程化基础**：7. C-18 消除 esbuild 隐式依赖（**必须排 Vite 升级前**）；8. C-19 补 `jszip`；9. C-06 ESLint + 样式令牌规则；10. C-07 vitest 覆盖 `src/lib/`；11. C-12 抽 `ipc-util.ts`；12. D-09 补 `CHANGELOG.md`（结合 C-16）。

**第三批 · 结构性升级**：13. C-10 Vite 5→8（前置 C-18）；14. Electron 33→43/44；15. C-11 拆 `pluginManager.ts` 683 行；16. C-13 渐进 `strict`/`noImplicitAny`；17. C-05 物理分离脚手架目录。

**文档侧（可并行）**：重写/删 `PROJECT_OVERVIEW.md`；补 `USER_GUIDE.md` 覆盖新能力；`PLUGIN_ARCHITECTURE.md` §4 标"目标态"；固化 `.gitignore` 入库策略。

---

**审查人**：前端专家（WorkBuddy）
**报告状态**：已完成。结论基于静态分析与实测命令输出；未执行构建与冒烟脚本的限制已在 §1 声明。
