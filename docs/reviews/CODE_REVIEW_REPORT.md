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

正面结论先行——这个项目在架构约束上的执行力高于同类个人项目：

- 三层进程边界**零违规**：渲染层不存在 `require` / `fs` / `path` / 直接文件系统访问；无任何组件绕过 `core/services/ipc.ts` 直连 `window.electronAPI`；无一处裸 `fetch` / `XHR`。
- 129 个 IPC 通道与主进程注册集合**完全一致**（差集为空），且 **100% 符合 kebab-case**。
- `TODO / FIXME / HACK` **0 处**，注释掉的死代码 **0 处**，空 catch / 吞错误 **0 处**。
- 持久化命名空间隔离、`registry.generated.ts` 自动生成纪律均被遵守（该文件已 gitignore，无手改痕迹）。
- 两项类型检查**实测通过**：`vue-tsc --noEmit` 与 `tsc -p tsconfig.electron.json --noEmit` 均 exit 0。

同时存在需要处理的问题，按严重度分布：

| 级别 | 数量 | 代表问题 |
|---|---:|---|
| 🔴 P0 | 1 | `xlsx@0.18.5` 两个未修复 CVE，npm 无补丁版本，且项目读取用户 Excel |
| 🟠 P1 | 13 | `dist:select` 静默产出残缺安装包（**已实测复现**）；深色主题 8 处白字白底（对比度低至 1.6:1）；`ElectronAPI` 缺 4 项声明；`vite.config.ts` 隐式依赖未声明的 `esbuild`（阻塞 Vite 升级）；`extensions/ae-profit/` 迁移残留 1,532 行；零测试 + 无 Lint；4 份文档过期/重复；缺 `README.md` |
| 🟡 P2 | 17 | Electron 33 / Vite 5 均 EOL；683 行单函数；5 份重复 IPC 样板；`jszip` 隐式依赖；文档事实性错误 |

**合计 31 项**（代码类 20 项 `C-01`–`C-20`，文档类 12 项 `D-01`–`D-12`；其中 `C-08` 已并入 `C-03`）。

**文档层是本次最薄弱的环节**：10 份文档中 4 份已过期或与代码冲突，2 份内容高度重复，根目录**从未有 `README.md`**（这其实是 `Requirements.md` §10 早就写下的交付要求）。本次已建 `docs/` 分类体系完成整理（见 §5）。

---

## 一、审查方法与覆盖度

| 手段 | 覆盖 |
|---|---|
| 文件规模统计 | 排除 `node_modules` `dist` `release` `market-out`，统计 `.ts .vue .js .mjs .cjs .css` |
| IPC 契约求差 | `electron/preload.ts` 暴露集合 ↔ 主进程 `ipcMain.handle/on` + 封装注册集合 ↔ `src/types.ts` `ElectronAPI` 声明 |
| 基线逐条核验 | 对照 `AGENTS.md` 三层边界 / IPC / 样式令牌 / 网络 / 持久化 / 模块登记 / 红线 12 |
| 文档比对 | 10 份文档全文通读 + 与代码交叉验证 + 路径引用有效性检查 |
| 实测验证 | `npx vue-tsc --noEmit`、`npx tsc -p tsconfig.electron.json --noEmit` |

**本次未执行的验证（重要限制）**：

- ❌ **未运行 `npm run build`** —— 未验证构建与打包链路（本次仅改文档与注释，构建风险低，但基线快照中的产物路径与打包配置未实测）。
- ❌ **未运行冒烟脚本**（`plugins:sandbox:smoke` / `mail:smoke`）—— 避免脚本对本地 `<userData>` 状态产生副作用。
- ❌ **未执行 `npm audit`** —— 沙箱无外网访问。下文依赖 CVE 结论来自官方公告与第三方复核，非本地实测。
- ⚠️ 依赖版本结论基于 `node_modules` 实际安装版本（已实测读取）。

---

## 二、代码审查

### 2.1 架构一致性——达标项

以下基线规则经实测确认**完全遵守**：

| 规则 | 结论 | 取证 |
|---|---|---|
| 渲染进程禁止 `require` / `fs` / `path` | ✅ | `src/` `extensions/` 全文 0 命中 |
| 组件不得直接调 `window.electronAPI` | ✅ | 无代码级命中，仅 4 处注释说明文案 |
| 禁止渲染层直接 `fetch` / XHR | ✅ | 0 命中；axios 仅在 `src/core/network/request.ts:11` 引入一次 |
| `registry.generated.ts` 禁止手改 | ✅ | 文件头有 `AUTO-GENERATED` 声明；已 gitignore；`git status` 无改动 |
| 持久化走 `useModuleStorage` | ✅ | 4 处正当使用；主进程 `main.ts:329` 的 `store.get('records')` 属 §1.4 允许的**旧 key 迁移探测** |
| 模块须在 `modules.config.ts` 登记 | ✅ | registry 生成的 4 个模块全部在 config 中 |
| IPC 通道命名 kebab-case | ✅ | 129/129 唯一通道匹配 `^[a-z0-9]+(-[a-z0-9]+)*$` |
| 禁止硬编码默认模板路径 | ✅ | 经 `get-default-template-path` IPC |
| 主进程 .ts 加 `export {}`（红线 12） | ✅ 实质达标 | `plugin-ui-protocol.ts` / `preload.ts` 无该标记，但二者均有顶层 import，TS 已视为模块，**无全局污染风险** |

### 2.2 C-01 🔴 P0 · `xlsx@0.18.5` 存在未修复的高危漏洞

| 项 | 内容 |
|---|---|
| 实测版本 | `node_modules/xlsx/package.json` → `0.18.5` |
| 声明范围 | `package.json` → `"xlsx": "^0.18.5"` |
| 漏洞 | **CVE-2023-30533**（原型污染，CVSS 7.8）、**CVE-2024-22363**（ReDoS，CVSS 7.5） |
| 为何危险 | `0.18.5` 是 SheetJS 在 npm 上发布的**最后一个版本**，修复版（0.20.3+）**只发布在 SheetJS 自有 CDN**，不在 npm registry。因此 `npm update` / `npm audit fix` **永远升不上去**，漏洞会长期滞留 |
| 真实攻击面 | 项目核心功能就是**读取用户导入的 Excel 文件**（`src/lib/excelParser.ts`、`extensions/*/src/store.ts`）。恶意构造的 xlsx 可触发原型污染 → 污染渲染进程对象原型；或 ReDoS → 界面卡死 |
| 影响评估 | 单用户桌面应用、导入自用文件，实际被利用概率不高；但这是**唯一一个可被外部文件触发的 P0 级缺陷**，且修复成本极低 |

**修复方案**（一次性，不改变调用方代码）：

```jsonc
// package.json
"overrides": {
  "got": "^11.8.6",
  "cacheable-request": "^10.2.12",
  "xlsx": "https://cdn.sheetjs.com/xlsx-0.20.3/xlsx-0.20.3.tgz"   // 新增
}
```

执行 `npm install` 后需回归验证：Excel 导入 / 导出（`order-export-excel`、`exportWorkbook`）/ 字段规则匹配。注意 0.20.x 与 0.18.x 的 API 差异主要在于已移除部分历史兼容分支，本项目实际用到的 `read` / `utils` 接口保持一致。

> 备选方案：若不愿引入 CDN 依赖，可评估迁移至 `exceljs`（**项目已经依赖** `exceljs@^4.4.0`）。但 `excelParser.ts` 为 §4.4 受保护的底层公共工具，迁移需搜全部调用方，成本高于 `overrides`。

### 2.3 C-03 🔴 P1 · 深色主题下 8 处"白字白底"（本次可复用主题坑位复现）

`AGENTS.md` §1.6 与 §7 明确记载过这个历史坑：「深色主题白字白底 → 主色底文字一律 `--wb-primary-contrast`」。**该坑位在语义色上再次复现**。

实测令牌色值（`src/styles/index.css`）：

| 令牌 | 浅色主题 | 深色主题 |
|---|---|---|
| `--wb-success` | `#16a34a`（深绿） | `#4ade80`（**亮浅绿**） |
| `--wb-warning` | `#b45309`（深棕橙） | `#fbbf24`（**亮黄**） |
| `--wb-danger` | `#dc2626`（深红） | `#f87171`（**亮浅红**） |
| `--wb-primary-contrast` | `#ffffff` | `#15171c`（深色） |

`text-white` 压在这些令牌背景上的实际对比度：

| 背景 | 白字对比度 | WCAG AA（正文 4.5:1） |
|---|---|---|
| `#4ade80`（深色 success） | **≈1.6 : 1** | ❌ 严重不足 |
| `#fbbf24`（深色 warning） | **≈1.7 : 1** | ❌ 严重不足 |
| `#f87171`（深色 danger） | **≈2.6 : 1** | ❌ 不足 |
| `#16a34a`（浅色 success） | ≈3.4 : 1 | ❌ 小字不足 |
| `#dc2626`（浅色 danger） | ≈5.0 : 1 | ✅ |
| `#b45309`（浅色 warning） | ≈6.2 : 1 | ✅ |

**结论**：深色主题下这些徽标 / 提示的文字**几乎不可读**。这不是风格偏好问题，是确凿的可读性缺陷。

**违规清单（8 处，背景为语义令牌）**：

| # | 文件:行 | 片段 |
|---|---|---|
| 1 | `src/core/components/ToastHost.vue:10` | `'bg-[var(--wb-success)] text-white'` |
| 2 | `src/core/components/ToastHost.vue:12` | `'bg-[var(--wb-danger)] text-white'` |
| 3 | `extensions/excel-copy/src/components/FieldRuleManager.vue:27` | `bg-[var(--wb-success)] text-white` |
| 4 | `extensions/order-insight/src/components/CorrectionRow.vue:15` | `bg-[var(--wb-warning)] text-white` |
| 5 | `extensions/order-insight/src/OrderInsightView.vue:24` | `bg-[var(--wb-warning)] text-white` |
| 6 | `extensions/order-insight/src/components/OrderDetailTable.vue:112` | `bg-[var(--wb-danger)] text-white` |
| 7 | `extensions/order-insight/src/components/ProductLibraryView.vue:118` | `bg-[var(--wb-danger)] text-white` |
| 8 | `extensions/order-insight/src/components/ProductLibraryView.vue:119` | hover 态 `hover:bg-[var(--wb-danger)]` + `text-white` |

`src/core/components/ToastHost.vue` 的第 1、2 项优先级最高——它是**全局 Toast 组件**，深色主题下所有成功/错误提示都会受影响，而且它自己的 info 分支（`:14`）已经用对了写法（`text-[var(--wb-surface)]`），属于同文件内的不一致。

**修复方式**（一处改动）：

```
text-white  →  text-[var(--wb-primary-contrast)]
```

`--wb-primary-contrast` 在设计上就是"深色底上的文字色"（浅色主题给白、深色主题给深），正是为此场景准备的双向令牌。

**同时排除的误报（2 处，非违规）**：`ProductLibraryView.vue:79`（`bg-black/55 text-white`）与 `:85`（`bg-black/45 text-white`）是**图片上的半透明黑遮罩**，白字是正确的对比设计，不改。仅建议后续如需支持主题调整时统一走令牌。

### 2.4 C-02 🟠 P1 · `src/types.ts` 的 `ElectronAPI` 缺 4 项声明

`AGENTS.md` §1.1 与 §5 SOP 均要求「新增通道必须同步更新 `src/types.ts` 的 `ElectronAPI` 接口」。实测比对结果：

| 项 | 数量 |
|---|---|
| `preload.ts` 暴露的顶层键 | 133 |
| 其中 invoke 方法 | 130（映射到 129 个唯一通道，`read-file` 被 `importExcelByPath` 与 `readFile` 共用） |
| `on*` 订阅方法 | 2（`mail-sync-event` / `updater-event`） |
| `platform` 常量属性 | 1 |
| `src/types.ts` `ElectronAPI` 声明属性 | 129 |
| **缺口** | **4** |

**缺失的 4 项**（实测 `grep` 确认 `src/types.ts` 中不存在）：

| 缺失项 | preload 位置 | 对应通道 | 影响 |
|---|---|---|---|
| `controlWindow` | `preload.ts:235` | `win-control` | 标题栏最小化/最大化/关闭 |
| `getModuleState` | `preload.ts:218` | `get-module-state` | **§1.4 命名空间持久化核心通道** |
| `setModuleState` | `preload.ts:219` | `set-module-state` | 同上 |
| `platform` | `preload.ts:234` | 非通道（`process.platform`） | 平台判定 |

**为什么现在没报错**：渲染层从 `ipc.ts` 封装层调用（返回类型独立声明），`preload.ts` 也不在渲染层 `tsconfig.json` 的 include 内，因此 `vue-tsc` 检测不到这个缺口——**两项类型检查实测均通过（exit 0）**。这恰恰说明它是"静默"的规则违反：类型系统在这里形成了盲区，实际调用方拿到的是 `any`。

**修复方式**：在 `src/types.ts` 的 `ElectronAPI` 接口中补齐 4 项声明（`getModuleState` / `setModuleState` 建议参考 `resetStore: () => Promise<APIResult<void>>` 的 `APIResult<T>` 包裹风格）。

### 2.5 C-04 / C-05 🟠 P1 · `extensions/` 目录的两处结构性问题

**C-04：`extensions/ae-profit/` 是迁移残留（1,532 行）**

- `modules.config.ts` 中明确注释：*"利润追踪（ae-profit）已迁移为市场 UI 岛（`ui-plugins/ae-profit`），不再随宿主分发；必须保持其不进入默认包，否则内建记录会占用同名 id，导致市场安装的 UI 岛无法注册。"*
- 实际情况：`extensions/ae-profit/`（`manifest.kind = "view"`，v0.2.0，含 `src/meta.ts` + 3 个 Vue 组件）**目录仍然存在**，且出现在 `git status` 的已修改列表中。
- 同时 `ui-plugins/ae-profit/`（`kind: "ui"`，v1.0.1）已就位。
- **风险**：`vite.config.ts` 的 `MODULE_ROOTS` 双根探测按 id 优先匹配 `src/modules/<id>`，其次 `extensions/<id>/src`。当前 ae-profit 未登记进任何 profile，所以**暂时不会被构建收录**——但只要有人误加进 profile，就会立刻命中"同名 id 占用"陷阱，且是静默的运行时问题。
- **另一重影响**：`extensions/ae-profit/src/components/OrderListPanel.vue` 等文件被计入 `tsconfig.json` 的 include（`extensions/**/*.{ts,vue}`），**参与渲染层类型检查**，即 1,532 行已废弃代码仍在消耗每次类型检查的时间。
- **建议**：确认 `ui-plugins/ae-profit` 功能等价后删除 `extensions/ae-profit/`（本次审查未改动，属代码变更）。

**C-05：`extensions/` 承载三类语义不同的内容**

| 类别 | 判定标志 | 实例 | 是否被构建收录 |
|---|---|---|---|
| ① 视图插件包 | 有 `src/meta.ts`，`kind: view` | `excel-copy` `order-insight` `shop-accounts` | ✅ registry 收录 |
| ② UI 岛迁移残留 | `kind: view` 但已移出预设 | `ae-profit` | ❌（意外安全） |
| ③ 外置插件脚手架/示例 | `manifest.entry: ./index.js`，**无 `kind`、无 `src/`** | `_template` `sk-hello` | ❌（设计如此） |

第 ③ 类（`_template` / `sk-hello`）按 `AGENTS.md` §5 的说法，是 `npm run plugins:create` 生成的**外置插件**脚手架，其运行位置应在 `<userData>/plugins/`。放在 `extensions/` 下不会被收录也不会被打包，但**目录位置极易与①混淆**——新人很可能把 `index.js` 写进 `extensions/<id>/` 后困惑"为什么没生效"。

**建议**：把 ③ 类挪到独立目录（如 `scaffolds/` 或 `examples/plugins/`），并在 `AGENTS.md` 中明确判定规则。**本次已在 `AGENTS.md` 新增 §1.9 判定表与红线 23**，机制歧义已在文档层消除；目录物理分离仍待决策。

### 2.6 C-06 🟠 P1 · 无 ESLint / Prettier，10 处 `eslint-disable` 处于空转状态

| 检查 | 结果 |
|---|---|
| `.eslintrc*` / `eslint.config.*` | ❌ 不存在 |
| `.prettierrc*` | ❌ 不存在 |
| `devDependencies` 含 `eslint` / `prettier` | ❌ 无 |
| `package.json` 的 `lint` / `format` 脚本 | ❌ 无 |
| 代码中的 `eslint-disable-next-line no-console` | **10 处** —— 因 lint 从未运行，**这些注释不产生任何效果** |

同时 `AGENTS.md` §6 的验证流程写的是「无 lint 红色波浪线」，这条承诺**没有工程化支撑**（指的是 IDE 反馈，不是项目门禁）。

**影响**：2.3 节的 8 处 `text-white`、2.4 节的 4 项声明缺口，都是**可用 lint 规则自动拦住**的问题类型（`no-restricted-syntax` 拦 `text-white`、自定义规则校验 preload/types 一致性）。当前依赖人工记忆执行基线，规则违反只能靠审查发现。

**建议（按性价比）**：
1. 引入 `eslint` + `@typescript-eslint` + `eslint-plugin-vue`，加 `lint` 脚本。
2. 关键自定义规则：禁止 `text-white` / `bg-black` / `#rrggbb` 字面量出现在 `src/**/*.vue` 与 `extensions/**/*.vue`。
3. 补一条校验脚本：比对 `preload.ts` 暴露键集合与 `src/types.ts` `ElectronAPI` 声明的差集（可在 CI 或 `postbuild` 跑），把 2.4 节的缺口变成可自动化拦截的检查。

**整改结论（R2-3，已完成）**：

| 项 | 落地结果 |
|---|---|
| 配置文件 | `eslint.config.mjs`（flat config）+ `.prettierrc` + `.prettierignore`；`package.json` 加 `lint` / `lint:fix` / `format` / `format:check` |
| 覆盖范围 | `src/**`、`extensions/**`、`electron/**`、`scripts/**` + 根级构建配置；**`ui-plugins/**` 有意排除**（独立子包、各自工具链，不进宿主 bundle） |
| 样式令牌红线 | `vue/no-restricted-class` **error** 级，正则覆盖：调色板具名色（`text-white` / `bg-gray-500`）、透明度变体（`bg-black/55`）、**变体前缀**（`hover:` / `dark:` / `sm:` / `group-hover:`）、`!important`、任意值色（`text-[#fff]` / `bg-[rgb(...)]`） |
| 建议 3 的处置 | 未走 lint，改由 **R2-4 的独立校验脚本**承担（跨三处声明求差，比 lint 规则更直接） |
| 空转注释 | 11 处（10 `no-console` + 1 `no-control-regex`）**已全部真实生效**；为此补齐了「核心 ESLint 规则同样作用于 .ts」这一层——typescript-eslint 的 recommended 只含 TS 专属规则，不含核心规则集，`.ts` 里的核心规则类抑制注释原本永远不会生效 |
| 验收证据 | ① `npm run lint` → **0 error**（356 warning，均为存量 `any`/`console`，已按计划降级收敛）② `--stdin` 探针：静态类名 / 对象键 / 数组元素 / 变体前缀 / `!` 全部拦下，`text-[var(--wb-text)]` 等令牌写法 **0 误报** ③ `npx vue-tsc --noEmit` exit 0 ④ `npm run build` 通过且 `registry.generated.ts` 逐字节一致 |
| 顺带修掉的真问题 | `prefer-const` 2 处；`no-useless-escape` 3 处（`[年/.\-]` → `[年/.-]`，已用样例集验证正则等价）；`src/env.d.ts` 的 `{}` 空白对象类型；`globals` 从隐式依赖补为显式 devDependency（与本报告 C-18/C-19 同类缺陷） |

**残余缺口（必须在 code review 补位）**：`vue/no-restricted-class` 的类名提取只覆盖字面量 / 模板字符串静态段 / 字符串拼接 / 对象静态键 / 数组元素，**不解析三元与 `&&`/`||` 表达式**——
`:class="ok ? 'text-white' : 'text-[var(--wb-text)]'"` 会漏检；而核心规则（含 `no-restricted-syntax`）**看不到 `<template>` 内部**（模板 AST 不在核心遍历键内），无法兜底。已在 `AGENTS.md` §6.1 明写「禁止在三元/`&&` 分支里写调色板类名」。

**Prettier 处置说明**：`.prettierrc` 按现有代码主导风格固化（单引号 / 分号 / 2 空格 / 100 列），但**存量 125 个文件未按此格式化**。为避免一次性机械 diff 淹没真实改动，本次**不做仓库级 `prettier --write`**，`format:check` 也因此不纳入门禁——是否补一次全量格式化需单独决策。

### 2.7 C-07 🟠 P1 · 零自动化测试，无 CI

| 检查 | 结果 |
|---|---|
| `*.test.*` / `*.spec.*` 文件（全仓，排除 node_modules/dist/release/market-out） | **0 个** |
| `__tests__` 目录 | **0 个** |
| `vitest.config.*`（现为 `.mts`）/ `jest.config.*` / `playwright.config.*` | **不存在** |
| `package.json` `test` 脚本 | **无** |
| `.github/workflows` | **不存在** |

**现有最接近测试的资产**是 3 个手工冒烟脚本（无断言框架、无 CI 入口）：

| 脚本 | 行数 | 入口 | 覆盖 |
|---|---:|---|---|
| `scripts/sandbox-smoke.mjs` | 192 | `npm run plugins:sandbox:smoke` | 插件沙箱 boot → command → call → deactivate → **token 拒绝**全链路 |
| `scripts/mail-engine-smoke.cjs` | 150 | `npm run mail:smoke` | 邮件引擎 |
| `scripts/mail-smoke.mjs` | 129 | （无脚本入口） | 邮件通道 |

**风险面**：`src/lib/` 下 `excelParser` / `templateEngine` / `fieldProcessor` / `orderRowSplitter` / `aggregator` / `orderClassifier` / `styleMatcher` 是**无副作用纯函数层**，承担 Excel 解析与模板生成的全部核心逻辑，**零测试覆盖**。这类代码一旦回归，症状是"静默产出错误文本"而非报错——最难被发现的一类 bug。

**建议**：引入 `vitest`（Vite 原生，零额外配置成本），**优先覆盖 `src/lib/` 纯函数层**。这是投入产出比最高的测试切入点：无 DOM、无 IPC、无副作用，用几个真实 Excel 样例即可建立回归网。

**整改结论（R2-5，部分完成）**：

| 项 | 落地结果 |
|---|---|
| 工具链 | `vitest@^2.1.9`（与 vite 5 同代，见 §2.8 版本配套）；`vitest.config.mts`（node 环境、固定 `TZ=Asia/Shanghai`）；`package.json` 加 `test` / `test:watch` |
| 覆盖范围 | `src/lib/` **全部 7 个模块**：`excelParser`(13) / `templateEngine`(16) / `fieldProcessor`(28) / `orderRowSplitter`(14) / `aggregator`(30) / `orderClassifier`(17) / `styleMatcher`(13)——**131 用例全绿**，耗时 ~0.3s |
| 夹具自建 | `tests/fixtures/orders.xlsx`（`generate-fixtures.mjs` 可重生，**必须入库**）。原建议的"用真实 Excel 样例"改用自造小夹具——根目录 `导出测试.xlsx` 被 `.gitignore` 忽略，CI/他机取不到，会变成"只在作者机器上能跑"的假测试 |
| 断言纪律 | 钉的是**契约**而非实现：缺失字段标记、两位小数四舍五入、记录 id 起始值与空行间隙、`Column_N` 表头补位、掩码优先级、白名单自洽性等 |
| 类型一致性 | `tests/**/*.ts` 纳入 `tsconfig.json` include，`npx vue-tsc --noEmit` 一并检查测试（本次即因此发现 7 处对象形状与 `PivotSpec` 类型不一致） |
| 验收证据 | ① `npm test` → 131 passed / 0 failed ② **变异测试**：把 `templateEngine` 缺失字段标记改成空串、把 `excelParser` 记录 id 偏移 +100、把 `aggregator` 的 `round()` 去掉——三种变异均被拦下（第 3 种首次**漏检**，已补 2 条用例钉住浮点残差与除不尽场景后拦下）③ `npm run lint` 0 error ④ `npm run build` 通过且 `registry.generated.ts` 逐字节一致 |

**仍未覆盖（本项不能标记为"已修复"）**：① `.github/workflows` 仍不存在，**无 CI**，门禁全靠本地手动执行；② 组件层、Pinia store、主进程（`electron/**`）、插件沙箱**均无自动化覆盖**（`scripts/sandbox-smoke.mjs` / `mail-engine-smoke.cjs` 仍是无断言框架的手工冒烟）；③ E2E 完全没有。已把"测试全绿 ≠ 整体已验证"写进 `AGENTS.md` §6.3。

### 2.8 C-10 🟡 P2 · 依赖与工具链版本风险

| 包 | 实测版本 | 当前主流 | 风险 | 建议 |
|---|---|---|---|---|
| `xlsx` | 0.18.5 | 0.20.3+（CDN） | 🔴 见 2.2 | `overrides` 指向 CDN |
| `electron` | 33.4.11 | 44.x | 🟠 **已 EOL**，不再获 Chromium 安全补丁，落后 11 个大版本 | 升级至受支持版本（42/43/44），需回归原生模块与 `afterPack.js` |
| `vite` | 5.4.21 | 8.x | 🟠 **已 EOL**，无安全补丁 | 升级；注意与 `@vitejs/plugin-vue` 版本联动 |
| `tailwindcss` | 3.4.19 | 4.x | 🟡 落后 1 大版本（v4 为 CSS-first 大改） | 暂缓——项目重度依赖 `--wb-*` 令牌 + `@layer components`，迁移成本高、收益低 |
| `pinia` | 2.3.1 | 4.x | 🟡 落后 2 大版本（v4 ESM-only） | 暂缓，与 Electron 升级一起评估 |
| `electron-store` | 8.2.0 | 10+ | 🟡 v8 ESM-only —— **项目已用动态 `import()` 兜底并降级 SimpleStore**（`AGENTS.md` §7 记录） | 维持现状，属已知规避 |
| `better-sqlite3` | 12.11.1 | — | ✅ 需原生编译，`postinstall` 已自动 rebuild | — |
| `vue` 3.5.35 / `typescript` 5.9.3 / `axios` 1.19.0 / `vue-tsc` 2.2.12 | — | — | ✅ 健康 | — |

**C-17**：`package.json` 声明 `typescript: ^5.4.2`，实测安装 5.9.3 —— 语义化范围有效，但 `AGENTS.md` §6 曾把"本地 devDependency 为 2.x"与"TS 5.4"绑定描述，易误导。**本次已在 `AGENTS.md` §6 修正该注释**。

### 2.9 C-11 / C-12 / C-14 🟡 P2 · 代码复杂度的三个集中点

**C-11 超长函数（>150 行，经大括号匹配精确计算）共 5 个**：

| 行数 | 位置 | 函数 |
|---:|---|---|
| **683** | `src/core/plugin/pluginManager.ts:193` | `createBuiltinPluginManager` —— 最严重，混合了发现 / 激活 / 贡献注册 / 启停 / 状态持久化多职责 |
| 344 | `src/core/plugin/sandbox.ts:122` | `createSandboxedPlugin` |
| 202 | `electron/ae-engine.ts:133` | `getProfitOverview` |
| 167 | `electron/mail-engine.ts:432` | `syncMailFolder` |
| 158 | `src/core/plugin/uiBridgeHost.ts:223` | `attachUiIslandBridge` |

`pluginManager.ts` 是 `§4.4` 列明的受保护内核文件，拆分需谨慎：建议按"发现 / 激活 / 贡献注册 / 启停"四职责抽子模块，保持对外 `pluginManager` 门面不变。

**C-12 重复代码：5 份 IPC 注册样板**

| 文件:行 | 封装 |
|---|---|
| `electron/order-handlers.ts:99-107` | `register()` |
| `electron/purchase-handlers.ts:16-24` | `register()` —— 与上者**逐字节相同** |
| `electron/ae-handlers.ts:28-37` | `handle<T>()` |
| `electron/mail-handlers.ts:82-91` | `handle<T>()` —— 同一模板拷贝 |
| `electron/shop-accounts-handlers.ts:53-62` | `handle<T>()` —— 同一模板拷贝 |

建议抽 `electron/ipc-util.ts` 统一，消除 5 份拷贝。**注意**：这属于 `AGENTS.md` §4.2「需先理解 IPC 模式后再改」范围，需评估对入参校验链路的影​​响。


**整改结论（R2-6，已完成）**：

| 项 | 落地结果 |
|---|---|
| 新增文件 | `electron/ipc-util.ts`（含契约说明与未纳入项的理由） |
| 两种契约**有意不合并** | `register`（handler 自返 `{success,data,error}`）服务写型域 order / purchase —— 它们要在 handler 内做入参校验并**主动**回传 `{success:false,error:'invalid payload'}`；`handle<T>`（本层包装成 `{success:true,data}`）服务查询型域 ae / mail / shop-accounts。二者不是"严格 vs 宽松"，合并会迫使某一域改写全部 handler |
| 消除量 | 5 份拷贝共 **65 行** → 共享模块 + 5 行 import，5 个 handler 文件净减 59 行 |
| 入参校验差异**全部保留** | 只搬走最外层注册封装；各域的 `isPlainObject` 校验、`str()` 截断、`'invalid payload'` 文案原地未动。`order-handlers.ts` 的"不向渲染层透传 SQL"边界未受影响 |
| 顺手修掉的真问题 | `err.message` → `err?.message`：原实现遇 `throw null` 会在 catch 内再抛 TypeError，使 IPC 变成 **reject**，渲染层拿到未处理拒绝而不是 `{success:false}`（`tests/ipcUtil.spec.ts` 已用变异测试证明：改回旧写法会让 2 条用例失败，报 `promise rejected "TypeError: Cannot read properties of null"`） |
| 顺带有意的收敛 | `handle` 统一为 async：原先 ae / shop-accounts 的版本是同步的，其 `fn` 类型**拒收 async handler**；对调用方无可观测差异（`invoke` 本来就是异步） |
| 验收证据 | ① `npx tsc -p tsconfig.electron.json --noEmit` exit 0 ② `npm run build` 通过且 `registry.generated.ts` 逐字节一致 ③ `npm run verify` → preload 133 / types 133 / **主进程通道 129**（与 R2-4 记载一致，说明通道集合未变）④ `npm test` 145 passed（新增 14 条 ipc-util 契约用例）⑤ 校验脚本反例复测：preload 通道名写错、`ae-summary` 通道名写错，均 exit 1 |
| **未被验收覆盖** | `npm run mail:smoke` 需真实 IMAP 凭据（`MAIL_USER` / `MAIL_PASS`），本机无凭据时只打印"缺少凭据"后退出。其 `tsc` 阶段已通过，但**邮件通道的端到端行为本次未实测**，需在有凭据的环境补验；同理其余四个域的 GUI 手动回归也未做 |

**附带发现并修掉的一处隐性缺陷（校验脚本自身）**：`scripts/check-ipc-contract.mjs` 的"包装式注册"识别原本是**按文件**找局部函数名的——5 份拷贝分散在各文件时恰好能 work，一旦把封装抽成共享模块，定义处与调用处分居两文件，**所有经包装注册的通道都会被误判成"主进程未注册"**（实测 `npm run verify` 报 26 项缺失）。已改为**跨文件**收集包装名（含 `import { register as xx }` 别名），并给调用点匹配加负向后行以排除 `protocol.handle('sk-plugin', …)` 这类成员调用（否则会把 Electron 的 protocol scheme 误当成 IPC 通道，通道数虚增为 130）。这说明：**检查脚本本身也可能与被检查的坏味道耦合，重构时要连它一起验证。**

**残余（有意未改）**：`electron/order-handlers.ts` 的 `order-export-excel` 仍是裸 `ipcMain.handle` —— 它需要 IPC 事件对象（`event.sender`）反查父窗口以正确挂载保存对话框，而 `register` 的签名只传 payload。其 try/catch 与返回结构与 `register` **完全一致**，故行为无差异；若后续要统一，把 `register` 的 handler 扩成 `(payload, event)` 即可（现有 handler 忽略第二参，属纯增量）。已在 `ipc-util.ts` 头部注明。

**C-14 类型宽松度：`any` 共约 288 处**

| 位置 | 数量 | 说明 |
|---|---:|---|
| `electron/preload.ts` | **97** | 主进程消毒函数参数（`sanitizeXxx(items: any)`）——可接受，但密度偏高 |
| `electron/main.ts` / `mail-engine.ts` / `mail-handlers.ts` | 29 / 21 / 18 | 主进程 |
| `extensions/` | 11 | — |
| `src/` | 10 | 含 `env.d.ts` 的标准 shim、`fieldProcessor.ts:1`、`AppShell.vue:2` |
| **主进程合计** | **267** | —— |

**C-13（✅ 已整改，R3-4）**：`noImplicitAny` 已开启（初测 61 错：主进程 `require()` 无类型导致 52 处回调参数失去上下文类型 + 9 处零散；经 typed require 断言 + 逐点修复清零，顺带补齐 `ShopAccountUpsertInput.mailAuthPwd` 真实缺口、新增 `@types/mailparser` / `@types/yauzl`、修掉 `simpleParser` 因 `as any` 误匹配回调重载返回 `void` 的隐性类型失真）。`strict: false` 保留为**有意决策**（渐进收紧策略见 `AGENTS.md` §6.0.1）。原文：`tsconfig.electron.json` 为 `strict: false`。主进程恰恰是 `any` 最密集（267 处）与 SQL / IPC / 文件路径操作最集中的区域，宽松配置与风险不匹配。**不建议一次性开启 `strict`**（会产生大量错误），建议渐进：先开 `noImplicitAny` 观察范围，或对新文件单独加严。

（正面：`tsconfig.json` 渲染层为 `strict: true` ✅，且 `include` 已按 Phase 5 授权覆盖 `extensions/**/*.{ts,vue}` —— 未回退。）

### 2.10 C-15 / C-16 🟡 P2 · 版本管理异常

| 问题 | 实测 |
|---|---|
| `electron-builder.yml` `buildVersion: 1.0.0` vs `package.json` `version: 1.0.4` | 不一致。`buildVersion` 影响打包产物版本元数据，与自动更新（electron-updater 按 `version` 比对）可能产生偏差 |
| git tag 指向 | `v1.0.0` / `v1.0.1` / `v1.0.2` / `v1.0.4` **四个 tag 全部指向同一 commit** `9ccb73d` —— 版本历史不可追溯 |
| 缺失 | 无 `v1.0.3` tag；git 历史中版本跳跃无记录 |

**建议**：`electron-builder.yml` 删除 `buildVersion`（默认继承 `package.json` version），或改为同步；后续发布严格「bump `package.json` → 打 tag → `npm run dist`」，不再补打历史 tag。

### 2.11 C-20 / C-18 / C-19 🟠 P1 · 补充审查：配置与脚本层的隐式依赖与失效入口

> 本节为报告初版后的**补充审查**（针对"依赖升级可行性"专项排查）所发现，含 1 项已实测复现的功能性缺陷。

#### C-20 🟠 P1-High · `npm run dist:select` 会静默产出残缺安装包（**已实测复现**）

`scripts/select-build.js:23` 只扫描一个模块根：

```js
const modulesDir = path.join(root, 'src', 'modules');   // ← 未包含 extensions/
```

而 Phase 5 外挂化之后，`excel-copy` / `order-insight` / `shop-accounts` 三个主力模块的源码**已全部迁至 `extensions/<id>/src/`**，`src/modules/` 下只剩 `quick-note`。

**实测证据**：

```bash
$ node scripts/select-build.js --list
可打包模块:
  quick-note  (便签)          # ← 只有 1 项
```

| 对照来源 | 模块清单 |
|---|---|
| `select-build.js --list`（实测） | `quick-note` |
| `src/modules/` 实际内容 | `quick-note` |
| `extensions/` 实际内容 | `excel-copy` `order-insight` `shop-accounts` `ae-profit` `_template` `sk-hello` |
| `registry.generated.ts` 实际收录 | `excel-copy` `quick-note` `order-insight` `shop-accounts` |

**后果**：选择器把勾选结果写入 `MODULE_IDS` 环境变量，而 `MODULE_IDS` 在 `vite.config.ts` 中**优先级最高**。因此执行 `npm run dist:select` 或 `npm run build:select` 时：

1. 用户只能看到并勾选 `quick-note`；
2. `MODULE_IDS=quick-note` 覆盖掉 profile，构建期裁剪掉 `excel-copy` / `order-insight` / `shop-accounts`；
3. **产出的是一个只有便签功能的安装包，且全程无任何警告。**

这是本次审查中**唯一被实测复现的功能性缺陷**，且属"静默产出错误交付物"类型——比报错更危险。讽刺之处在于 `AGENTS.md` 红线 15 专门保护了"`MODULE_IDS` 优先级不被改"，却没有人发现驱动它的选择器从未适配 `extensions/` 双根。

**修复**：`scanModules()` 改为同时扫描两个根（复用 `vite.config.ts` 的判定标志：目录下存在 `src/meta.ts` 即视为视图插件包），并跳过 `_template` / 无 `meta.ts` 的目录。

```js
const MODULE_ROOTS = [
  { dir: path.join(root, 'src', 'modules'),          probe: (d) => path.join(d, 'meta.ts') },
  { dir: path.join(root, 'extensions'),              probe: (d) => path.join(d, 'src', 'meta.ts') },
];
```

**验收**：`node scripts/select-build.js --list` 应输出 4 项（`excel-copy` / `quick-note` / `order-insight` / `shop-accounts`）。

#### C-18 🟠 P1 · `vite.config.ts` 隐式依赖未声明的 `esbuild`（**Vite 升级的硬阻塞**）

| 项 | 实测 |
|---|---|
| 使用点 | `vite.config.ts:5` → `import { transformSync } from 'esbuild';`（用于转译求值 `modules.config.ts`） |
| `package.json` 声明 | ❌ **`dependencies` / `devDependencies` 中均无 `esbuild`** |
| 实际存在 | `node_modules/esbuild@0.21.5` |
| 来源 | **仅为传递依赖** —— `package-lock.json` 中唯一引用方是 `vite@5 -> esbuild@^0.21.3` |

**风险分级理由**：当前能跑通（Vite 5 恰好把 esbuild 带进来），但有两个触发点：

1. **Vite 升级即崩**：Vite 8 已用 **Rolldown + Oxc 取代 Rollup + esbuild**（见下文 2.12）。升级后 `esbuild` 不再是传递依赖 → `vite.config.ts` 在加载阶段直接抛 `Cannot find module 'esbuild'`，**整个构建链路不可用**。
2. **依赖树变动即崩**：任何导致 npm 提升策略变化的重装（新增依赖、切换包管理器、CI 环境）都可能让该 import 失效。

**推荐修复（一并解决 Vite 8 迁移）**：不要"补声明"，而是**消除这个转译需求**。`modules.config.ts` 按 `AGENTS.md` §1.3 的约束本就是"纯字面量结构（对象/数组/字符串），禁止复杂逻辑"——既然如此，把它改为 `modules.config.json` 即可：

- `vite.config.ts`：`JSON.parse(readFileSync(...))`，删除 esbuild import；
- 类型约束改由 `.json` + 独立 `.d.ts`（或直接保留一份 `BuildConfig` 类型声明）承载，不再需要 TS 转译。

这样同时获得：消除隐式依赖、为 Vite 8 扫清障碍、构建期少一次转译。**代价**：`modules.config.ts` → `.json` 属结构变更，需同步 `AGENTS.md` §1.3/§5、`README.md` 目录树、`docs/baseline/PROJECT_BASELINE.md` §4 的引用。

#### C-19 🟡 P2 · `scripts/publish-plugin.js` 隐式依赖未声明的 `jszip`

| 项 | 实测 |
|---|---|
| 使用点 | `scripts/publish-plugin.js:28` → `const JSZip = require('jszip');` |
| `package.json` 声明 | ❌ 未声明 |
| 来源 | 传递依赖 —— `exceljs -> jszip@^3.10.1` |

风险低于 C-18（由**直接依赖** `exceljs` 带入，且 `exceljs` 自身强依赖 zip 能力，被移除概率低），但性质相同：**用生产依赖的传递包去完成一个开发脚本的职责**。若 `exceljs` 未来改用其它 zip 实现，插件发布脚本会静默失效。

**排查误报说明**：同批扫描另报 `scripts/select-build.js` 使用了未声明的 `readline` —— 经核验 `readline` 为 Node 内置模块（`require('module').builtinModules` 确认），属扫描脚本白名单遗漏的**误报**，非问题。

### 2.12 C-10 补充 · 依赖升级的目标版本（已核实，非估算）

审查初版仅标注"Electron 33 / Vite 5 已 EOL"，未给出目标版本。此处补充核实结果（查询日期 2026-09-16）：

**Electron**（官方支持策略：仅最新 3 个稳定大版本）

| 大版本 | 稳定发布 | EOL | 最新补丁 | 状态 |
|---|---|---|---|---|
| **44** | 2026-08-25 | 2027-03-02 | 44.3.0（2026-09-08） | ✅ 受支持 |
| **43** | 2026-06-30 | 2027-01-05 | 43.7.0 | ✅ 受支持 |
| 42 | 2026-05-05 | 2026-10-20 | 42.11.3 | ✅ 受支持（**1 个月后到期**） |
| 41 | 2026-03-10 | **2026-08-25** | 41.10.7 | ❌ 已 EOL |
| **33（当前）** | 2024-10-15 | **2025-04-29** | 33.4.11 | ❌ 已 EOL 约 1 年 4 个月 |

升到 44 意味着跨越 **11 个大版本**：Chromium M130 → M152、Node.js 20.18 → 24.16。`better-sqlite3` 需按新 Node ABI 重编译（`postinstall` 的 `@electron/rebuild` 已覆盖），`afterPack.js` 的 ElectronAsarIntegrity 处理需重新验证。**建议目标 43 或 44**（42 即将到期，不值得作为终点）。

**Vite**（官方支持策略：当前 minor 常规修复；上一 major/minor 仅重要修复；上上 major 仅安全补丁）

| 版本 | 状态 |
|---|---|
| `8.1`（当前 minor，最新约 8.2.2） | ✅ 常规补丁 |
| `7.3` / `8.0` | 🟡 仅重要修复 + 安全补丁 |
| `6.4` | 🟡 仅安全补丁 |
| **`5.4`（当前）** | ❌ **不再支持** |

**⚠️ Vite 8 是一次架构级变更，不是常规升级**：它用 **Rolldown（Rust 打包器）+ Oxc（解析/转译/压缩）** 取代了 Vite 2–7 的 **Rollup + esbuild** 双引擎架构。对本项目的直接影响有两处：

1. **`esbuild` 传递依赖消失** → 直接触发上文 C-18 的阻塞（`vite.config.ts` 加载失败）。**C-18 必须先修**。
2. **`@vitejs/plugin-vue` 与 `vue` 的版本兼容区间**需重查；`vite.config.ts` 中自定义的 `build.outDir` / `resolve.alias` / `base` 配置项在 Vite 8 中语义不变，风险低。

另注：Vite 8 要求 **Node.js 20.19+ 或 22.12+**（开发机 22.x 满足）。

---

## 三、文档审查

### 3.1 整理前的文档清单与问题

审查时项目根目录有 10 份 `.md`（总计 3,651 行）。

| 文档 | 行数 | 主旨 | 目标读者 | 最后更新 | 整理前状态 |
|---|---:|---|---|---|---|
| `AGENTS.md` | 296 | 架构基线 + 编码红线 | 开发者 / AI | 2026-09-04 | 🟡 活跃但 3 处滞后 |
| `PLUGIN_ARCHITECTURE.md` | 648 | 插件化目标架构 + Phase 1–5 | 架构 / 开发者 | 2026-09-08 | ✅ 活跃 |
| `PLUGIN_DEVELOPMENT.md` | 392 | 外置插件开发手册 | 插件作者 | 2026-09-15 | ✅ 活跃 |
| `PROFIT_TRACKER.md` | 154 | 速卖通利润追踪三端方案 | 架构 / 开发者 | 2026-09-15 | 🟡 内部矛盾 |
| `MAIL_INBOX.md` | 318 | 集中收件箱 M1–M3 | 开发者 | 2026-09-15 | ✅ 活跃 |
| `PROJECT_OVERVIEW.md` | 330 | 单体时期项目分析报告 | 开发者 / 新人 | **2026-06-03** | ⚠️ **严重过期** |
| `REFACTOR_PLAN.md` | 252 | Phase 0 构建期模块化重构计划 | 架构 / 开发者 | 2026-08-21 | ⚠️ 状态标记失效 |
| `Requirements.md` | 305 | 最初立项需求规格 | 需求 / 开发者 | **2026-06-02** | ⚠️ **过期 + 事实错误** |
| `SellerKit_使用指南.md` | 585 | 用户使用指南（详版） | 用户 | 2026-06-20 | 🟡 覆盖面偏旧 |
| `manual.md` | 371 | 用户手册（旧简版） | 用户 | **2026-06-03** | ⚠️ **重复 + 过期** |
| — | — | `README.md` | — | — | ❌ **不存在** |

### 3.2 D-01 / D-02 / D-03 🟠 P1 · 三份文档已失效

**D-01 · `PROJECT_OVERVIEW.md` 与现状严重脱节**（写于 2026-06-03，迟于基线 3 个月）

逐项核对出的脱节点：

| 文档描述 | 实际情况 |
|---|---|
| 标题「**IPTV** 模板复制工具」 | 项目已更名 SellerKit |
| 目录树根为 `iptv/` | 实际为 `SellerKit/` |
| 有 `src/components/*`、`src/stores/app.ts`（约 580 行） | **均已删除**，业务迁至 `extensions/excel-copy/src/` |
| `App.vue` 承载布局与快捷键 | `src/App.vue` 现仅挂载 `<AppShell />` |
| `interface Record` | 已重命名为 `RecordItem`（构建期曾因遮蔽全局 `Record<K,V>` 导致类型检查失败） |
| IPC 表列 8 条通道（自述"9 个通道"却只列 8 条） | 现 preload 暴露 **129 个唯一通道** |
| `测试模板.txt` | **不存在**，实际 extraResources 为 `默认模板.txt` |
| `get-store` / `set-store` 为模块态通道 | 已换为 `get-module-state` / `set-module-state` |
| 未提及 | 运行时插件体系、`extensions/` 视图插件包、`ui-plugins/` UI 岛、SQLite 持久层、`src/core/network/` 网络层、`src/core/ai/`、店铺账号管家、集中收件箱 |

**结论**：该文档描述的是项目"单体时期"的形态，对新人具有**实质性误导风险**（会照着找已不存在的文件）。

**D-02 · `manual.md` 与 `SellerKit_使用指南.md` 高度重复**

- 两文在结构（安装 / 界面 / 快捷键 / FAQ）与内容上几乎同源，**`manual.md` 是使用指南的子集**（缺"字段处理规则""列显示控制""打包产物"三章）。
- 大量陈旧标记：正文写 `cd iptv`（应为 `cd SellerKit`）、版本 `1.0.0`（`package.json` 为 1.0.4）、"最后更新：2024 年"、快捷键表 `Ctrl+Z` **重复两行**、仅覆盖 arm64（现为 arm64 + x64 双架构）。
- 两者均**未覆盖 2026 年后的新能力**：店铺账号管家、订单归类、集中收件箱、自动更新。

**D-03 · `Requirements.md` 为原始需求，含事实错误**

- 正文含失效的绝对路径 `/Users/ck/work/work/ai/iptv/导出测试.xlsx`。
- §7.1 标题**重复出现两次**（"IPC 设计" 与 "拖拽导入实现"）；§8 UI/UX 细节**整节重复**。
- 引用了**从未存在**的 `src/lib/electronAPI.ts`、`TemplateEditor.vue`。
- §10 明确要求「提供简短 README」——**该交付项直到 2026-09-16 才完成**（即本次新建的根 `README.md`）。

### 3.3 D-04 / D-05 / D-06 / D-11 / D-12 🟡 P2 · 文档内部矛盾与事实错误

**D-05 · `PROFIT_TRACKER.md` 内部自相矛盾**

- §7「落位清单」写展示端为 `extensions/ae-profit/`（`kind: view`）
- §10 决策表 `D1` 标记 **⛔ 已被 D1' 取代**，`D1'` 写已迁移为 `ui-plugins/ae-profit/`（`kind: ui`）
- 两处同时存在且未说明取舍 → 读者无法判断哪个是当前方案
- 另：§5 列出的 `ae_ops_costs`、`ae_sync_log` 两张表在 `electron/ae-db.ts` 中**尚未实现**（实际已建 `ae_orders` / `ae_order_lines` / `ae_fees` / `ae_cost_map` / `ae_rates`），属 §8 的 M2 范围，但 §6 标题写"已落地"

**D-04 · `REFACTOR_PLAN.md` 状态标记失效**

文档仍以 🔲 标记未完成项，但代码核验显示 Phase 0–3 **均已落地**：

| 文档承诺 | 代码核验 |
|---|---|
| `core/types.ts` / `AppShell.vue` / `layout/SplitPane.vue` / `modules.config.ts` / 自动生成 registry | ✅ 全部存在 |
| `core/services/{ipc,toast,storage,clipboard,dialog,excel}.ts` | ✅ 7 个齐全 |
| `CommandPalette.vue`(⌘K) / 记忆模块 / `--wb-*` 令牌 | ✅ 已落地 |
| `vite.config.ts` 的 `MODULE_IDS > MODULE_PROFILE > profile > enabledModules` 优先级 | ✅ 已实现 |
| `core/layout/ContentHeader.vue` | ❌ **从未创建**（唯一未实现项） |
| "stub 模块 `modules/hello/`" | 实际为 `modules/quick-note/` |

**D-06 · `AGENTS.md` 自身 3 处滞后**（本次已修正，见 §5）：

| 位置 | 滞后内容 |
|---|---|
| §1.2 目录树 | 未列 `src/core/ai/`、`src/core/layout/`、完整的 `src/core/plugin/` 文件清单；未提 `ui-plugins/` |
| §1.4 | 命名空间只列 `app-shell` / `excel-copy`，实际至少还有 `order-insight` / `shop-accounts` / `plugins` |
| §6 | 把"本地 devDependency 为 2.x"与 TS 5.4 绑定描述，实际 TS 已到 5.9.3 |

**D-11 · `PLUGIN_ARCHITECTURE.md` §4「Monorepo」为纯目标态**

文档 §4 描述 pnpm workspaces + `packages/core` 的 monorepo 结构，但项目实际是单仓 `src/core/plugin`。文中未标注"目标态 / 未采纳"，易被误读为现状。

**D-12 · 其他事实性错误汇总**

| 文档 | 问题 |
|---|---|
| `manual.md` | `cd iptv`；版本 1.0.0；"最后更新：2024 年"；`Ctrl+Z` 重复两行；仅 arm64 |
| `PROJECT_OVERVIEW.md` | `测试模板.txt` 不存在；"IPC 9 个通道"却只列 8 条；`dist:mac` 仅描述 arm64 |
| `Requirements.md` | 失效绝对路径；§7.1 与 §8 重复；引用不存在的文件 |
| `SellerKit_使用指南.md` | 称数据存于 `seller-kit/config.json`，与 `AGENTS.md` §1.4 的 `modules.<ns>` 命名空间描述不符；默认模板示例 `📅 Expiry Date: {{Package}}` 存在占位符语义缺陷（未提示）；仅 arm64；未覆盖新模块 |

**版本漂移交叉验证**：`使用指南` 与 `manual.md` 均称数据在 `seller-kit/config.json` 平铺存放，而 `AGENTS.md` §1.4 与 `PROJECT_BASELINE.md` §6 描述的是 `modules.<namespace>` 命名空间隔离——**文档链自身存在口径冲突**。

### 3.4 D-08 / D-09 / D-10 🟠 P1 · 缺失文档

| 缺失文档 | 影响 | 状态 |
|---|---|---|
| **`README.md`** | 项目无入口。`Requirements.md` §10 早在立项时就要求提供 | ✅ **本次已补**（见 §5） |
| `CHANGELOG.md` | 版本演进不可追溯（叠加 2.10 的 tag 异常，历史完全断裂） | ❌ 仍缺 |
| `CONTRIBUTING.md` | 贡献流程无说明（`AGENTS.md` 面向 AI 编码，不完全等同人类贡献指南） | ❌ 仍缺 |
| `LICENSE` | 无授权声明；注意上游为 `SayakABC/SellerKit` | ❌ 仍缺 |
| **IPC 通道清单** | 129 个通道无成文契约表。契约同步靠人工记忆（2.4 的缺口即由此产生） | 🟡 本次在基线 §5 给出**分域清单与提取命令**，精确表仍缺 |
| 数据库 schema 汇总 | 仅 `MAIL_INBOX.md` 覆盖 `sk_mail_*`；其余 20 余张表无集中说明 | 🟡 本次在基线 §6 补全表名级清单 |
| 目录结构说明 | 无（`PROJECT_OVERVIEW.md` 的目录树已过期） | ✅ 本次在 `README.md` 与基线 §2 补全 |
| 部署发布说明 | `release.sh` / `publish-finalize.js` / electron-updater / GitHub Release 流程无文档 | ❌ 仍缺 |
| 环境变量说明 | 仅 `.env.example` 内部注释 | ✅ 本次在基线 §8 补全 |

### 3.5 D-07 🟡 P2 · 交叉引用有效性问题

`PLUGIN_DEVELOPMENT.md:6` 写「内核实现细节见 `PLUGIN_ARCHITECTURE.md`（本地 AI 内部文档，不提交 GitHub）」。

问题在于 `.gitignore` 同时忽略 `AGENTS.md` / `PLUGIN_ARCHITECTURE.md` / `PROJECT_OVERVIEW.md` / `REFACTOR_PLAN.md`，但**保留** `PLUGIN_DEVELOPMENT.md` / `PROFIT_TRACKER.md` 入库。造成两个后果：

1. 任何克隆本仓库的人打开 `PLUGIN_DEVELOPMENT.md`，**必然看到一个指向不存在文件的引用**。
2. 文档的入库策略不一致：同属插件主题的两份文档，一份入库一份不入库，且没有说明原因。

**本次处理**：保留原有入库策略（不擅自改变上游 fork 的干净度诉求），但已在 `.gitignore` 中写明策略边界与调整方法，并在 `docs/README.md` 单列「版本管理策略」章节。**是否让架构类文档入库，属产品决策，建议你明确一次并在 `.gitignore` 注释中固化。**

---

## 四、发现项汇总（按优先级排序）

### 整改状态总览（滚动更新）

> 本表跟踪本报告发现项的**实际落地状态**；任务编号与依赖关系见 `docs/plans/REMEDIATION_PLAN.md`。
> 未在表中的发现项 = 尚未处理。每个任务的验收证据写在其 commit message 里。

| 发现项 | 任务 | commit | 状态 |
|---|---|---|---|
| C-01 xlsx 两个 CVE | R0-1 | `2b122ca` | ✅ 已修复（换源 SheetJS CDN 0.20.3，读写交叉对照零差异） |
| C-20 `dist:select` 扫描根 | R1-1 | `6a958b3` | ✅ 已修复（抽 `scripts/lib/module-roots.cjs` 单一事实源） |
| C-03 深色主题白字白底 8 处 | R1-2 | `c5b6c51` | ✅ 已修复（改用 `--wb-primary-contrast`） |
| C-02 `ElectronAPI` 缺 4 项声明 | R1-3 | `12947ad` | ✅ 已修复（三处声明现 133 项完全一致） |
| C-15 `buildVersion` ≠ `version` | R1-4 | `f8fc95d` | ✅ 已修复（产物 CFBundleVersion 1.0.4） |
| C-04 `extensions/ae-profit/` 残留 | R1-5 | `ad7471d` | ✅ 已修复（等价性核对后删除，发布资产未残缺） |
| C-18 esbuild 隐式依赖 | R2-1 | `ee912ec` | ✅ 已修复（`modules.config.json`，Vite 8 前置解除） |
| C-19 jszip 隐式依赖 | R2-2 | `ad91889` | ✅ 已修复（显式声明 + 真实发布流程实测） |
| C-06 无 ESLint / Prettier | R2-3 | `3ac8b7a` | ✅ 已修复（见下方 2.6 节的实测结论与残余缺口） |
| C-02 复发防护 / D-10 契约表 | R2-4 | `305669c` | ✅ 已修复（`npm run verify` 从源码动态提三份清单求差；反例实测可拦下） |
| C-07 零自动化测试 | R2-5 | `62a760d` |
| C-21 源码内嵌裸控制字节 | R2-8 | `b18166e` | ✅ 已修复（7 字节转义；等价性已证，编译产物运行期行为不变） |
| C-12 5 份重复 IPC 注册封装 | R2-6 | `f82ef04` | ✅ 已修复（抽 `electron/ipc-util.ts`，净减 59 行；顺手修掉 `err.message` 可致 IPC reject 的隐患） | ✅ 部分修复（vitest 覆盖 `src/lib/` 7 个模块 / 131 用例；**仍无 CI**，组件与主进程仍未覆盖） |

### 🔴 P0 —— 建议尽快处理

| ID | 问题 | 位置 | 修复成本 |
|---|---|---|---|
| C-01 | `xlsx@0.18.5` CVE-2023-30533 + CVE-2024-22363，npm 无补丁版本 | `package.json` | 低（1 行 `overrides`） |

### 🟠 P1 —— 明确的规则违反或实质误导

| ID | 问题 | 位置 | 修复成本 |
|---|---|---|---|
| **C-20** | `npm run dist:select` 只扫 `src/modules`，静默产出残缺安装包（**已实测复现**） | `scripts/select-build.js:23` | 低（改扫描双根） |
| **C-18** | `vite.config.ts` 隐式依赖未声明的 `esbuild`；Vite 8 升级的硬阻塞 | `vite.config.ts:5` | 中（建议改造为 JSON 配置） |
| C-03 | 深色主题 8 处白字白底，对比度低至 1.6:1 | 见 2.3 清单 | 低（8 处类名替换） |
| C-02 | `ElectronAPI` 缺 4 项声明（违反 §1.1 / §5 SOP） | `src/types.ts` | 低 |
| C-04 | `extensions/ae-profit/` 迁移残留 1,532 行 | `extensions/ae-profit/` | 低（确认后删除） |
| C-05 | `extensions/` 混放三类语义不同内容 | `extensions/` | 中（需目录调整） |
| C-06 | 无 ESLint/Prettier，10 处 `eslint-disable` 空转 | 项目配置 | 中 |
| C-07 | 零自动化测试、无 CI，`src/lib/` 核心逻辑无覆盖 | 项目配置 | 中高（测试网已建，CI 未建） |
| D-01 | `PROJECT_OVERVIEW.md` 严重过期，会误导新人 | 文档 | 低（已加标注，建议重写或删） |
| D-02 | `manual.md` 与 `USER_GUIDE.md` 重复 | 文档 | 低（已归档 manual） |
| D-03 | `Requirements.md` 过期 + 事实错误 | 文档 | 低（已加标注） |
| D-08 | 缺 `README.md` | 根目录 | ✅ 已完成 |
| D-09 | 缺 `CHANGELOG.md` / `CONTRIBUTING.md` / `LICENSE` | 根目录 | 中 |

### 🟡 P2 —— 改进项

| ID | 问题 | 位置 |
|---|---|---|
| C-09 | 组件内硬编码色值：`ProductLibraryView.vue:189-211` 色卡字典 18 处 hex；`MailAccessDrawer.vue:305` `box-shadow: rgb(0 0 0 / 18%)` | 见 2.3 | `extensions/order-insight/` · `extensions/shop-accounts/` |
| ✅ R3-5 `44c7521` | 色卡抽 `lib/colorSwatch.ts`（业务数据，**刻意不令牌化**，7 条用例反向断言）；`--wb-shadow` 双主题令牌替代写死纯黑；顺带修掉 `UiIslandView.vue` 未连接态裸 hex；canvas 探针像素加注说明 ↑ | | |
| C-10 | Electron 33 / Vite 5 均 EOL（目标版本见 2.12） | 依赖 | ✅ R3-1/R3-2（`356ec1c`/`699bc4c`）Vite 5→8、Electron 33→44 已落地，GUI 回归待人工 |
| C-11 | 5 个超长函数，最严重 683 行 | `pluginManager.ts:193` 等 |
| C-12 | 5 份重复 IPC 注册样板 | `electron/*-handlers.ts` |
| C-13 | 主进程 `strict: false`，与 `any` 密度不匹配 | `tsconfig.electron.json` | ✅ R3-4 `noImplicitAny` 已开启（61 错清零）；`strict:false` 为有意决策（AGENTS.md §6.0.1） |
| C-14 | `any` 约 288 处（主进程 267） | 主进程 |
| C-15 | `buildVersion` 1.0.0 ≠ `version` 1.0.4 | `electron-builder.yml` |
| C-16 | 4 个 tag 指向同一 commit，无 v1.0.3 | git |
| C-17 | 文档称 TS 5.4，实际 5.9.3 | ✅ 已在 `AGENTS.md` 修正 |
| C-19 | `scripts/publish-plugin.js` 隐式依赖未声明的 `jszip`（来自 `exceljs`） | `scripts/publish-plugin.js:28` |
| C-21 | **源码内嵌裸 C0 控制字节**：`electron/mail-cache.ts:50`（正则字符类内 `0x00`/`0x1F`）、`electron/mail-db.ts:788/862/867`（模板字符串里的 `0x00` 作复合键分隔符）。功能正常，但把这两个文件变成了"二进制文件"——**BSD `grep` 会直接静默跳过它们**（审查期已实际踩到：一次 grep 返回空被误读为"某声明不存在"），编辑器/格式化工具也可能改写或破坏这两个不可见字节。建议改为 `\x00` / `\x1f` 转义写法（语义完全等价） | `electron/` |

> **✅ 已修复（R2-8，`b18166e`）**：7 个裸字节全部改为转义写法。`file` 判定由 `data` 变为 UTF-8 文本，全仓重扫 231 个源码/文本文件控制字节归零；并用「旧版 vs 新版表达式对同一输入求值比对」证明语义逐字节等价（含"分隔符仍是 U+0000 而非被换成空格"与"复合键歧义防护仍成立"两项关键断言）。
| D-04 | `REFACTOR_PLAN.md` 状态标记失效 | 文档 |
| D-05 | `PROFIT_TRACKER.md` §7 与 D1' 矛盾 | 文档 |
| D-06 | `AGENTS.md` 3 处滞后 | ✅ 已修正 |
| D-07 | 入库策略不一致导致引用失效 | `.gitignore` + 文档 |
| D-10 | 缺 IPC 通道精确契约表 | 文档 |
| D-11 | `PLUGIN_ARCHITECTURE.md` §4 Monorepo 未标注目标态 | 文档 |
| D-12 | 多份文档事实性错误（详见 3.3） | 文档 |

### 已确认的正面结论（无需处理）

- 三层进程边界零违规；129 个 IPC 通道集合完全一致且 100% kebab-case
- `TODO/FIXME` 0 处、死代码 0 处、空 catch 0 处
- `src/` 与 `extensions/` 无 Tailwind 调色板类（`text-gray-*` 等）0 命中
- 两项类型检查实测通过（`vue-tsc` exit 0 / `tsc` exit 0）
- `sandboxRuntime.ts` 的 `@ts-nocheck` 与 3 处硬编码色值误报已排除（前者属 §1.8 有意豁免，后者为色卡数据字典与瀑布流遮罩）

---

## 五、本次已执行的变更

> 用户明确选择「建 docs/ 并迁移分类」+「只报告不改代码」。以下变更全部经用户授权；**未修改任何业务逻辑**。

### 5.1 文档结构整理（迁移 9 份文档，git 历史保留）

```
docs/
├── README.md                      # 新建 —— 文档索引（文档地图 / 阅读路径 / 维护规则 / 入库策略）
├── baseline/
│   ├── PROJECT_BASELINE.md        # 新建 —— 项目基线快照
│   └── REFACTOR_PLAN.md           # ← 根目录（标注「已完成并归档」+ 核验说明）
├── architecture/
│   ├── PLUGIN_ARCHITECTURE.md     # ← 根目录
│   ├── PLUGIN_DEVELOPMENT.md      # ← 根目录（git mv）
│   └── PROJECT_OVERVIEW.md        # ← 根目录（标注「已过期」+ 8 条脱节清单）
├── features/
│   ├── MAIL_INBOX.md              # ← 根目录
│   └── PROFIT_TRACKER.md          # ← 根目录（git mv，并修正 §7 矛盾）
├── guides/
│   └── USER_GUIDE.md              # ← SellerKit_使用指南.md（git mv + 重命名为 ASCII 名）
├── requirements/
│   └── Requirements.md            # ← 根目录（git mv，标注「历史档案」）
├── reviews/
│   └── CODE_REVIEW_REPORT.md      # 新建 —— 本文件
└── archive/
    └── manual.md                  # ← 根目录（git mv，标注「已归档，被 USER_GUIDE 取代」）
```

迁移方式：git 已跟踪的 5 份用 `git mv`（保留 history），未跟踪的 4 份用 `mv`。整理后**根目录仅剩 `README.md` + `AGENTS.md`**。

### 5.2 新建文档

| 文件 | 内容 |
|---|---|
| `README.md`（根） | 项目入口：核心能力 / 快速开始 / 目录结构 / 三层边界 / 两套扩展机制 / 存储位置 / 文档导航 / 质量现状 |
| `docs/README.md` | 文档中心：13 份文档地图（含状态与最后更新）/ 5 条阅读路径 / 5 条维护规则 / 入库策略 / 目录结构 |
| `docs/baseline/PROJECT_BASELINE.md` | 基线快照：11 章——元信息 / 工具链 / 目录职责 / 代码规模 / **模块与插件注册表** / **IPC 契约**（129 通道分域）/ **持久化**（5 命名空间 + 26 张表）/ 构建打包 / 环境变量 / 文档基线 / **质量门禁现状** / **8 条冻结契约** |
| `docs/reviews/CODE_REVIEW_REPORT.md` | 本文件 |

### 5.3 `AGENTS.md` 基线修正（5 处）

| 位置 | 变更 |
|---|---|
| 顶部 | 增加指向 `docs/baseline/PROJECT_BASELINE.md` 与 `docs/README.md` 的导航说明，并确立"本文只写规则、不重复快照"的分工 |
| §1.2 | 目录树补全 `core/plugin/`（13 个文件）、`core/ai/`、`core/layout/`、`lib/` 文件清单、`ui-plugins/` |
| §1.4 | 命名空间补全为 5 个：`app-shell` / `excel-copy` / `order-insight` / `shop-accounts` / `plugins` |
| §1.9（**新增**） | `extensions/` 与 `ui-plugins/` 判定规则表（6 个维度对比）+ 第三类脚手架说明 |
| §3 | **新增红线 23**：禁止混淆 `extensions/` 与 `ui-plugins/` 语义（UI 岛 id 不入 profile；不依赖无 `src/meta.ts` 的目录被收录） |
| §6 | 修正 TS 版本注释；新增「质量门禁现状」警示——未安装 ESLint、无自动化测试，`eslint-disable` 当前无效 |

### 5.4 文档内容修正（事实性错误与矛盾）

| 文件 | 变更 |
|---|---|
| `PROFIT_TRACKER.md` | §7 落位清单修正为 `ui-plugins/ae-profit/`；新增「文档与代码漂移提示」3 条（目录残留 / 未实现表 / 矛盾点） |
| `docs/archive/manual.md` | 头部新增归档横幅，列明 5 条已知失效点 |
| `docs/architecture/PROJECT_OVERVIEW.md` | 头部新增过期横幅，列明 8 条与现状脱节点 ⚠️ **该文件已于 R4-1 删除**，本节保留当时的修正记录 |
| `docs/requirements/Requirements.md` | 头部新增历史档案横幅，列明 4 类事实错误 |
| `baseline/REFACTOR_PLAN.md` | 头部状态改为「已完成并归档」+ 逐项代码核验结果 |

### 5.5 交叉引用同步（16 处）

> **R4-7 复核（2026-09-16）**：本表是**当时**（文档目录整理时）的变更记录，保留原样以便追溯。
> 其中两处已被后续任务改变，见行内标注；其余引用经全仓扫描确认仍然有效。
> 复核工具：`npm run verify:docs`（R4-7 新增，见 §六）。

迁移会打断原有裸文件名引用，已全部改为**仓库根相对路径**：

| 文件 | 变更 |
|---|---|
| `docs/features/MAIL_INBOX.md:5` | → `docs/features/PROFIT_TRACKER.md` |
| `docs/features/PROFIT_TRACKER.md` | §7 落位表修正 |
| `docs/baseline/REFACTOR_PLAN.md:5` | → `docs/architecture/PROJECT_OVERVIEW.md` ⚠️ **R4-1 已删除该文件**，`REFACTOR_PLAN.md:8` 已改写为「已于 R4-1 删除」 |
| `docs/architecture/PROJECT_OVERVIEW.md:51` | → `docs/requirements/Requirements.md`（源文件已删除，本行仅存历史） |
| `docs/architecture/PLUGIN_DEVELOPMENT.md:6` | → `docs/architecture/PLUGIN_ARCHITECTURE.md` |
| `docs/architecture/PLUGIN_ARCHITECTURE.md:5` | → `docs/baseline/REFACTOR_PLAN.md` + `docs/architecture/PROJECT_OVERVIEW.md` ⚠️ 后半段同被 R4-1 删除，该行已改写 |
| `AGENTS.md:133` | → `docs/architecture/PLUGIN_ARCHITECTURE.md` |
| `ui-plugins/sk-ui-starter/README.md` + `src/main.js` | → `docs/architecture/PLUGIN_DEVELOPMENT.md` |
| `scripts/ui-plugin-template/README.md` + `src/main.js` | → `docs/architecture/PLUGIN_DEVELOPMENT.md` |
| `electron/plugin-ui-protocol.ts:2` | → `docs/architecture/PLUGIN_ARCHITECTURE.md` |
| `electron/ae-receiver.ts:2` | → `docs/features/PROFIT_TRACKER.md` |
| `electron/ae-engine.ts:4` | → `docs/features/PROFIT_TRACKER.md` |
| `electron/ae-db.ts:13` | → `docs/features/PROFIT_TRACKER.md` |
| `src/core/plugin/uiBridgeHost.ts:2` | → `docs/architecture/PLUGIN_ARCHITECTURE.md` |
| `src/core/components/UiIslandView.vue:25` | → `docs/architecture/PLUGIN_ARCHITECTURE.md` |

> `electron/*.ts` 与 `src/**/*.ts|vue` 中的 6 处改动均为**注释内文档路径**，非业务代码。这属于"迁移文档"的必要收尾（否则我引入的即是失效引用），不计入"修改代码"。

### 5.6 `.gitignore` 同步

> ⚠️ **R4-5 已推翻本节的策略**（2026-09-16）：下方忽略清单当时成立，但已整体改为
> **`AGENTS.md` 与 `docs/**` 全部入库**（理由见 `.gitignore` 注释与 `docs/README.md` 的
> 「版本管理策略」节）。保留本节仅作追溯，**不要照此恢复忽略规则**。

原 4 条忽略规则指向已失效的根目录路径，已更新为 `docs/` 路径，并补充策略说明与调整方法：

```
AGENTS.md
docs/baseline/
docs/architecture/PLUGIN_ARCHITECTURE.md
docs/architecture/PROJECT_OVERVIEW.md
docs/reviews/
```

即：`docs/guides/` `docs/features/` `docs/requirements/` `docs/archive/` 与 `docs/architecture/PLUGIN_DEVELOPMENT.md`、`docs/README.md` 正常入库；基线与审查报告按项目既有「内部文档不入库」策略保留在本地。

**（R4-5 后）当前实际策略**：`.gitignore` 中已无任何 `AGENTS.md` / `docs/**` 条目，全部入库。

---

## 六、验证方式

### 本次已实测

```bash
npx vue-tsc --noEmit                        # ✅ exit 0（渲染进程类型检查通过）
npx tsc -p tsconfig.electron.json --noEmit  # ✅ exit 0（主进程类型检查通过）
git status --short                          # 确认仅文档/注释/.gitignore 变更
```

两项检查**在本次全部编辑完成后执行**，因此同时验证了文档迁移与注释路径修正未破坏类型层面的一致性。

### 建议用户自行补充验证

```bash
npm run build                               # 生产构建（验证 registry 生成链路）
npm run plugins:sandbox:smoke               # 插件沙箱全链路冒烟
npm run mail:smoke                          # 邮件引擎冒烟
# 手工回归：启动 → 导入 Excel → 预览 → 复制 → 设置页 → 主题切换（重点看深色主题下 Toast 与徽标可读性）
```

### 各修复项的针对性验证

| 修复项 | 验证方式 |
|---|---|
| C-01 xlsx 升级 | 导入含多 Sheet 的真实 Excel、导出订单 Excel、核对字段规则匹配结果 |
| C-03 `text-white` | **深色主题**下触发成功/错误 Toast，检查文字可读性；核对 order-insight 各徽标 |
| C-02 类型声明补齐 | 补完后 `vue-tsc` 仍 exit 0；建议加 preload↔types 差集校验脚本 |
| C-04 删除残留 | 确认 `ui-plugins/ae-profit` 功能等价；构建后确认无 `ae-profit` 内建条目 |
| C-07 引入 vitest | 先覆盖 `src/lib/excelParser.ts` + `templateEngine.ts`，用真实 Excel 样例做黄金用例 |

---

## 七、建议的处理顺序

按「风险 × 修复成本」排序，分三批推进（与前文用户选择的「增量迭代」习惯一致）：

**第一批 · 低风险高收益（可以立即做，互不依赖）**

1. `C-20` 修 `scripts/select-build.js` 的扫描根 —— **已实测复现的功能缺陷**，且修复成本极低
2. `C-01` xlsx `overrides` —— 唯一 P0，1 行改动
3. `C-03` 8 处 `text-white` → `text-[var(--wb-primary-contrast)]` —— 全局 Toast 可读性
4. `C-02` 补齐 `src/types.ts` 4 项声明
5. `C-04` 确认后删除 `extensions/ae-profit/`
6. `C-15` `electron-builder.yml` 的 `buildVersion` 与 `package.json` 对齐

**第二批 · 工程化基础（需要单独安排）**

7. `C-18` 消除 `esbuild` 隐式依赖（建议把 `modules.config.ts` 改为 `.json`）—— **必须排在 Vite 升级之前**
8. `C-19` 补声明 `jszip`
9. `C-06` 引入 ESLint + 样式令牌规则（可自动拦住 `C-03` / `C-09` 类问题）
10. `C-07` 引入 vitest，优先覆盖 `src/lib/` 纯函数层
11. `C-12` 抽 `electron/ipc-util.ts` 消除 5 份注册样板
12. `D-09` 补 `CHANGELOG.md`（结合 `C-16` 的 tag 问题一并规范发布流程）

**第三批 · 结构性升级（改动面大，需完整回归）**

13. `C-10` Vite 5 → 8（**前置：`C-18`**；Vite 8 换 Rolldown + Oxc，属架构级变更）
14. `C-10` Electron 33 → 43/44（跨越 11 个大版本，连带 `better-sqlite3`、`afterPack.js` 回归）
15. `C-11` 拆分 `pluginManager.ts` 的 683 行函数
16. `C-13` 主进程渐进开启 `strict` / `noImplicitAny`
17. `C-05` 物理分离 `extensions/` 下的脚手架目录

> 以上顺序已落为可执行的分阶段计划，含每项的改动文件、验收标准、风险与回滚：[`../plans/REMEDIATION_PLAN.md`](../plans/REMEDIATION_PLAN.md)。

**文档侧（可与代码并行）**

15. 重写或删除 `PROJECT_OVERVIEW.md`（当前已加过期标注，但内容仍会误导）
16. 补充 `USER_GUIDE.md` 以覆盖 2026 年后的新能力（店铺账号 / 订单归类 / 收件箱 / 自动更新）
17. 在 `PLUGIN_ARCHITECTURE.md` §4 标注「Monorepo 为目标态、未采纳」
18. 明确 `.gitignore` 的入库策略并固化（决定架构类文档是否入库）

---

## 附录 A · 复现命令

```bash
cd /Users/ck/work/work/ai/SellerKit

# 代码规模
for d in src electron extensions scripts ui-plugins; do
  find $d -type f \( -name '*.ts' -o -name '*.vue' -o -name '*.js' \) -not -path '*/node_modules/*' | wc -l
done

# 样式令牌违规（真实违规）
grep -rn "text-white" src extensions --include=*.vue

# IPC 契约差集
grep -oE "'[a-z0-9-]+'" electron/preload.ts | sort -u > /tmp/preload.txt
grep -rhoE "ipcMain\.(handle|on)\(\s*'[a-z0-9-]+'" electron/ | grep -oE "'[a-z0-9-]+'" | sort -u > /tmp/main.txt
comm -3 /tmp/preload.txt /tmp/main.txt

# ElectronAPI 缺口
for k in controlWindow getModuleState setModuleState platform; do
  echo "$k -> types.ts:$(grep -c "$k" src/types.ts) preload.ts:$(grep -c "$k" electron/preload.ts)"
done

# 依赖实测版本
for p in xlsx electron vite tailwindcss pinia typescript vue; do
  echo "$p: $(node -p "require('./node_modules/$p/package.json').version" 2>/dev/null)"
done

# 文档引用检查（应无输出）
grep -rn --exclude-dir=node_modules --exclude-dir=dist --exclude-dir=release --exclude-dir=.git \
  -E "\`(AGENTS|PLUGIN_ARCHITECTURE|PLUGIN_DEVELOPMENT|PROJECT_OVERVIEW|REFACTOR_PLAN|PROFIT_TRACKER|MAIL_INBOX|manual|Requirements)\.md\`" .

# C-20 复现：交互式选择器只列出 1 个模块（应为 4 个）
node scripts/select-build.js --list
ls src/modules          # 只有 quick-note
ls extensions           # excel-copy order-insight shop-accounts ...

# C-18 / C-19 复现：隐式依赖（两条 grep 均应无输出 → 证明未声明）
grep -n '"esbuild"' package.json ; grep -n '"jszip"' package.json
grep -n "from 'esbuild'" vite.config.ts               # 但代码在用
grep -n "require('jszip')" scripts/publish-plugin.js  # 但代码在用

# C-18 传递来源确认（应看到 vite -> esbuild、exceljs -> jszip）
node -e "const l=require('./package-lock.json');for(const[k,v]of Object.entries(l.packages||{})){const d={...(v.dependencies||{})};if(d.esbuild||d.jszip)console.log(k,'->',d.esbuild?'esbuild@'+d.esbuild:'',d.jszip?'jszip@'+d.jszip:'')}"

# 深色主题令牌色值（用于核对 text-white 对比度）
sed -n "/\[data-theme='dark'\]/,/^}/p" src/styles/index.css | grep -E "success|warning|danger"
```

## 附录 B · 术语与文件速查

| 术语 | 含义 |
|---|---|
| 视图插件包 | `extensions/<id>/`，`kind: view`，构建期随宿主编译，有完整 Vue 能力 |
| UI 岛 | `ui-plugins/<id>/`，`kind: ui`，iframe 运行时 + `window.__sk` 桥，经 host 能力域访问数据 |
| 外置插件 | 安装于 `<userData>/plugins/`，跑在 Level 2 Worker 沙箱 |
| 内建插件 | `src/modules/` 或 `extensions/` 的视图包，经 `pluginManager` 注册为 Level 0 |
| 能力域 | manifest `capabilities` 声明的权限集合（`storage` / `db` / `clipboard` / `dialog` / `secrets` / `mail`） |
| 权限门 | `src/core/plugin/gatedHost.ts`，逐调用判定能力是否已声明 |
| 双根探测 | `vite.config.ts` 的 `MODULE_ROOTS`，按 id 依次探测 `src/modules/<id>` 与 `extensions/<id>/src` |

---

**审查人**：前端专家（WorkBuddy）
**报告状态**：已完成。全部结论基于静态分析与实测命令输出，取证命令见附录 A；未执行构建与冒烟脚本的限制已在 §1 声明。
