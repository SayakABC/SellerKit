# SellerKit 整改计划（REMEDIATION_PLAN）

> **依据**：[`../reviews/CODE_REVIEW_REPORT.md`](../reviews/CODE_REVIEW_REPORT.md)（31 项发现：1×P0 + 13×P1 + 17×P2）
> **状态**：🟢 **25 / 27 任务已完成**（Phase 0–3 全部关闭；Phase 4 只剩 `R4-2`「补写 USER_GUIDE 缺失章节」，`R4-6` 的 `LICENSE` 待项目方选定协议）。逐任务 commit sha 与遗留标记见 **§8**。
> **范围**：仅覆盖审查报告的发现项，不含新功能开发
> **本计划不重复**：规则原文在 [`../../AGENTS.md`](../../AGENTS.md)，现状快照在 [`../baseline/PROJECT_BASELINE.md`](../baseline/PROJECT_BASELINE.md)
> **原则**：**增量执行、每阶段独立提交、每阶段可验证可回滚**——不搞一次性大改。

---

## 1. 计划原则

| # | 原则 | 说明 |
|---|---|---|
| P1 | **阶段闸门** | 一个 Phase 全部任务完成并通过验收后，才进入下一个 Phase。不允许跨阶段并行改结构。 |
| P2 | **一键回滚粒度** | 每个任务 = 一个独立 commit。回滚只需 `git revert <sha>`，不需要理解上下文。 |
| P3 | **先护栏后升级** | `Phase 2` 的 ESLint / 契约校验 / 测试是后续升级的**安全网**。不要为了"快"跳过 Phase 2 直接做 Phase 3。 |
| P4 | **依赖顺序不可颠倒** | `R2-1`（消除 esbuild 隐式依赖）是 `R3-1`（Vite 8）的**硬前置**：不先做，Vite 升级后构建直接不可用。 |
| P5 | **改动即验证** | 每个任务给出明确验收命令/操作。没有可验证结论的任务，不允许标记完成。 |
| P6 | **文档与代码同批** | 凡是改变架构约束或目录结构的任务，同一 commit 内更新 `AGENTS.md` / 基线快照 / 相关文档，避免制造新的文档漂移。 |

---

## 2. 阶段总览

| Phase | 主题 | 任务数 | 对应发现 | 目的 | 风险 |
|---|---|---:|---|---|---|
| **Phase 0** | 安全修复 | 2 | C-01 | 消除唯一 P0 与工作区污染 | 极低 |
| **Phase 1** | 基线合规即时修复 | 5 | C-20, C-03, C-02, C-15, C-04 | 修掉"会静默出错"和"明确违反红线"的点 | 低 |
| **Phase 2** | 扩展模型与工程化护栏 | 7 | C-18, C-19, C-06, C-07, C-12, C-05, C-02† | 把靠人记的规则变成自动化拦截；清扫升级障碍 | 中 |
| **Phase 3** | 依赖与结构升级 | 5 | C-10, C-11, C-13, C-09 | 摆脱 EOL 依赖；削复杂度 | **高** |
| **Phase 4** | 文档补齐 | 7 | D-01, D-02, D-03, D-09, D-10, D-11, D-07, C-16 | 补齐缺失文档、消除过期内容 | 低 |
| — | **合计** | **27** | — | — | — |

> 表中 `Phase 2` 的 7 是**制定时**的任务数；执行中新增 `R2-8`（消除源码内嵌裸控制字节，R2-3 执行时发现），故实际总数 **27**。

**Phase 4 可与 Phase 2 / 3 并行**——它只碰 `docs/`，无代码冲突。

### 依赖关系

```
Phase 0 ──► Phase 1 ──► Phase 2 ──► Phase 3
                │           │
                └───────────┴──────────► Phase 4（可并行）

关键硬依赖：
  R2-1（去掉 esbuild 隐式依赖） ──► R3-1（Vite 8）
  R1-3（types.ts 补声明）      ──► R2-4（契约校验脚本，需要先有正确的基线）
  R2-3（ESLint 样式规则）      ──► R3-5（批量修硬编码色值时由 lint 兜底）
  工作区干净（R0-0）           ──► 其余一切
```

### 一句话路线图

> 先止血（Phase 0/1）→ 再装护栏（Phase 2）→ 最后动大件（Phase 3）→ 文档随时跟上（Phase 4）。

---

## Phase 0 · 安全修复

### R0-0 · 前置：清理工作区

| 项 | 内容 |
|---|---|
| **目的** | 当前工作区有 **20 个已修改 + 9 个新增**未提交文件。整改必须建立在可回滚的基线之上 |
| **动作** | ① 评审并提交当前未提交改动（含 `electron/mail-*.ts`、`electron/shop-accounts-*.ts`、`extensions/shop-accounts/`、`extensions/ae-profit/` 改动等）；② 打 tag `v1.0.4` 指向该 commit，作为整改起点 |
| **验收** | `git status --short` 除 `.gitignore` 与 `docs/` 外无未提交改动 |
| **备注** | 若要保留 `extensions/ae-profit/` 的当前改动以便日后对照，先确认 R1-5 的等价性结论 |

### R0-1 · `xlsx` 换源消除两个 CVE（C-01 · P0）

| 项 | 内容 |
|---|---|
| **目标** | 消除 CVE-2023-30533（原型污染）+ CVE-2024-22363（ReDoS） |
| **根因** | `xlsx@0.18.5` 是 SheetJS 在 npm 上的最后一版，修复版仅发布在 SheetJS 自有 CDN，`npm update` 无法升级 |
| **改动文件** | `package.json`（仅 `overrides` 段） |
| **动作** | 执行前先跑 `npm view` 或访问 SheetJS CDN 确认当前推荐版本号（报告中写的是 `0.20.3`，实施时以实际可用版本为准）：<br>`"xlsx": "https://cdn.sheetjs.com/xlsx-<VER>/xlsx-<VER>.tgz"` 加入 `overrides`，然后 `npm install` |
| **验收** | ① `node -p "require('./node_modules/xlsx/package.json').version"` 显示新版本；<br>② 导入含多 Sheet / 中文 / 合并单元格的真实 Excel，记录列表正确；<br>③ `order-export-excel` 与 UI 岛的 `exportWorkbook` 导出结果与升级前一致；<br>④ `npm run build` 通过 |
| **风险** | 0.18 → 0.20 有 API 差异。本项目实际只用 `read` / `utils` / `write` 接口，风险低。**若 Excel 解析出现异常，立即回滚 `overrides` 一行即可** |
| **回滚** | 删除 `overrides.xlsx` → `npm install` |
| **备选** | 已有直接依赖 `exceljs@^4.4.0` 可承担解析；但 `src/lib/excelParser.ts` 是 `AGENTS.md` §4.4 受保护的底层公共工具，迁移需搜全部调用方，成本高于本方案 |

---

## Phase 1 · 基线合规即时修复

> 本阶段全部为**点状低风险修改**，不改架构、不动依赖版本。可一次做完后统一回归。

### R1-1 · 修 `dist:select` 的模块扫描根（C-20 · P1-High）★ 最高优先

| 项 | 内容 |
|---|---|
| **目标** | 让交互式打包选择器正确列出全部 4 个模块，消除"静默产出残缺安装包" |
| **根因** | `scripts/select-build.js:23` 只扫 `src/modules`；Phase 5 外挂化后 3 个主力模块已在 `extensions/` |
| **实测现状** | `node scripts/select-build.js --list` → 只输出 `quick-note`（应为 4 项） |
| **改动文件** | `scripts/select-build.js`（`scanModules()`） |
| **动作** | 改为扫描双根，判定标志与 `vite.config.ts` 的 `MODULE_ROOTS` 对齐：<br>① `src/modules/<id>/has meta.ts` → 内建模块，展示名读 `src/modules/<id>/meta.ts`<br>② `extensions/<id>/src/meta.ts` 存在 → 视图插件包（**这是关键判定**，同时自动排除 `_template` / `sk-hello`）<br>③ 跳过无 `meta.ts` 的目录 |
| **验收** | `node scripts/select-build.js --list` 输出 **4 项**：`excel-copy` / `quick-note` / `order-insight` / `shop-accounts`；<br>勾选全 4 项执行 `npm run build:select`，产出 `dist/renderer` 中 4 个模块的 chunk 均存在 |
| **风险** | 低。建议同时抽出共享的模块探测逻辑，避免与 `vite.config.ts` 二次漂移（可选：抽 `scripts/lib/module-roots.js` 供两者复用）<br>✅ **已落地（R4-7 复核修正）**：实际抽出的是 **`scripts/lib/module-roots.cjs`**（含配套 `module-roots.d.cts` 类型声明），`select-build.js` 与 `vite.config.ts` 共用，`.js` 这个文件名从未存在 |
| **回滚** | `git revert` |

> **为什么排第一**：这是本次唯一**实测复现**的功能性缺陷，属"静默产出错误交付物"。若曾用 `dist:select` 出过包，那些包很可能缺核心功能，建议排查已发布产物。

### R1-2 · 深色主题 8 处白字白底（C-03 · P1）

| 项 | 内容 |
|---|---|
| **目标** | 修掉深色主题下对比度低至 1.6:1 的文字 |
| **改动文件** | 见下表 7 个文件 |
| **动作** | `text-white` → `text-[var(--wb-primary-contrast)]`（该令牌正是"深色底上的文字色"的设计用途：浅色主题给 `#ffffff`、深色主题给 `#15171c`） |

| # | 文件:行 | 背景令牌 |
|---|---|---|
| 1 | `src/core/components/ToastHost.vue:10` | `--wb-success` |
| 2 | `src/core/components/ToastHost.vue:12` | `--wb-danger` |
| 3 | `extensions/excel-copy/src/components/FieldRuleManager.vue:27` | `--wb-success` |
| 4 | `extensions/order-insight/src/components/CorrectionRow.vue:15` | `--wb-warning` |
| 5 | `extensions/order-insight/src/OrderInsightView.vue:24` | `--wb-warning` |
| 6 | `extensions/order-insight/src/components/OrderDetailTable.vue:112` | `--wb-danger` |
| 7 | `extensions/order-insight/src/components/ProductLibraryView.vue:118` 与 `:119`（hover 态） | `--wb-danger` |

| 项 | 内容 |
|---|---|
| **不要动** | `ProductLibraryView.vue:79` / `:85` 的 `bg-black/55 + text-white` 是**图片上的半透明黑遮罩**，白字是正确的对比设计 |
| **验收** | 深色主题下：① 触发成功与错误 Toast，文字清晰可读；② 检查 order-insight 的警告/危险徽标；③ 浅色主题下无回归 |
| **风险** | 极低（纯样式）。注意 `tailwind.config.js` 有意未覆盖 `white`，所以 `text-white` 会保持纯白——这正是问题所在，不要再依赖它做"反色文字" |
| **回滚** | `git revert` |

### R1-3 · 补齐 `ElectronAPI` 缺失的 4 项声明（C-02 · P1）

| 项 | 内容 |
|---|---|
| **目标** | 消除 `preload.ts` ↔ `src/types.ts` 的契约缺口（违反 `AGENTS.md` §1.1 / §5 SOP） |
| **改动文件** | `src/types.ts` |
| **动作** | 在 `ElectronAPI` 接口中补齐 4 项，与 `preload.ts` 实现签名一致：|

| 缺失项 | preload 位置 | 对应通道 | 建议签名 |
|---|---|---|---|
| `controlWindow` | `preload.ts:235` | `win-control` | `(action: 'minimize' \| 'maximize' \| 'close') => Promise<APIResult<void>>` |
| `getModuleState` | `preload.ts:218` | `get-module-state` | `(moduleId: string) => Promise<APIResult<unknown>>` |
| `setModuleState` | `preload.ts:219` | `set-module-state` | `(moduleId: string, data: unknown) => Promise<APIResult<void>>` |
| `platform` | `preload.ts:234` | 非通道常量 | `platform: NodeJS.Platform`（或 `string`） |

| 项 | 内容 |
|---|---|
| **验收** | ① `npx vue-tsc --noEmit` 仍 exit 0；② 手工比对：`preload.ts` 顶层键集合与 `ElectronAPI` 属性集合差集为空（`R2-4` 会把它自动化） |
| **风险** | 极低。**注意**：当前渲染层不直接消费这些声明（走 `ipc.ts` 封装），所以不会有编译报错提示你补——必须主动比对 |
| **回滚** | `git revert` |

### R1-4 · 版本元数据对齐（C-15 · P2）

| 项 | 内容 |
|---|---|
| **目标** | 消除 `electron-builder.yml` 与 `package.json` 的版本分歧 |
| **改动文件** | `electron-builder.yml` |
| **动作** | 删除 `buildVersion: 1.0.0` 一行（默认继承 `package.json` 的 `version`），或改为与之一致 |
| **验收** | `npm run dist`（可只跑 `--dir` 模式）产物的版本号 = `package.json` 的 `1.0.4`；electron-updater 的版本比对来源单一 |
| **风险** | 低。`buildVersion` 影响产物元数据，若历史产物依赖它需一并评估 |
| **回滚** | `git revert` |

### R1-5 · 处置 `extensions/ae-profit/` 迁移残留（C-04 · P1）

| 项 | 内容 |
|---|---|
| **目标** | 移除 1,532 行已废弃代码，消除"同名 id 占用"的静默陷阱 |
| **背景** | `modules.config.ts` 已注明 ae-profit 迁移为 `ui-plugins/ae-profit`（`kind: ui`）；`extensions/ae-profit/`（`kind: view`，v0.2.0）仍在，且被 `tsconfig.json` 的 `extensions/**/*.{ts,vue}` include 纳入类型检查 |
| **动作** | ① **先做等价性确认**：逐项核对 `ui-plugins/ae-profit` 是否覆盖 `extensions/ae-profit` 的功能（利润统计 / 订单明细 / 成本衔接 / 汇率维护）；② 确认后 `git rm -r extensions/ae-profit/`；③ 若发现 `ui-plugins` 有缺失功能，改为**把缺失项补到 UI 岛**，再删除 |
| **验收** | ① `extensions/` 下不再有 ae-profit；② `npx vue-tsc --noEmit` exit 0；③ `npm run build` 后 `registry.generated.ts` 无 ae-profit 条目；④ 从插件市场安装 `ui-plugins/ae-profit` 后可正常注册并读写数据 |
| **风险** | 中。**这一步有真实的功能丢失风险**，必须完成等价性确认再删。若有疑虑，保留目录但**从 `tsconfig.json` include 中排除**作为过渡（能省类型检查时间，但仍留着陷阱） |
| **回滚** | `git revert`（若已提交） |

---

## Phase 2 · 扩展模型与工程化护栏

> 本阶段目标是**把靠记忆执行的规则变成机器执行的检查**，并为 Phase 3 铺路。

### R2-1 · 消除 `esbuild` 隐式依赖（C-18 · P1）★ Vite 升级硬前置

| 项 | 内容 |
|---|---|
| **目标** | 移除 `vite.config.ts` 对未声明依赖 `esbuild` 的引用，解除 Vite 8 升级阻塞 |
| **根因** | `vite.config.ts:5` `import { transformSync } from 'esbuild'`，但 `esbuild` 未在 `package.json` 声明，仅由 `vite@5` 传递带入（实测 `node_modules/esbuild@0.21.5`）。Vite 8 已改用 Rolldown + Oxc，该依赖会消失 |
| **推荐方案（方案 A）** | **消除转译需求**——把 `modules.config.ts` 改为 `modules.config.json`：<br>① `AGENTS.md` §1.3 本就要求该 config 是"纯字面量结构，禁止复杂逻辑"，改 JSON 完全兼容；<br>② `vite.config.ts` 改为 `JSON.parse(readFileSync(...))`，删除 esbuild import；<br>③ `BuildConfig` 类型移入 `.d.ts` 或保留一份纯类型声明文件（供 `select-build.js` 与文档参考） |
| **备选方案（方案 B）** | 在 `devDependencies` 显式声明 `esbuild`。**不推荐**——只是把隐式变显式，Vite 8 下仍需保留一个已不属 Vite 依赖树的包 |
| **改动文件（方案 A）** | `modules.config.ts` → `modules.config.json`（新增）、`vite.config.ts`、`scripts/select-build.js`（若它读该文件）、`AGENTS.md`、`README.md`、`docs/baseline/PROJECT_BASELINE.md` |
| **验收** | ① `grep -rn "from 'esbuild'" vite.config.ts` 无输出；② `npm run build` 通过且 `registry.generated.ts` 内容与改动前**逐字节一致**（这是最强验证）；③ `node scripts/select-build.js --list` 仍输出 4 项；④ `MODULE_IDS=excel-copy npm run build` 与 `MODULE_PROFILE=minimal npm run build` 均生效 |
| **风险** | 中。"registry 逐字节一致"这条验收能把风险压到最低——若不一致说明求值语义变了，必须查清 |
| **回滚** | `git revert` |

### R2-2 · 补声明 `jszip`（C-19 · P2）

| 项 | 内容 |
|---|---|
| **目标** | 消除 `scripts/publish-plugin.js:28` 对传递依赖 `jszip`（来自 `exceljs`）的隐式依赖 |
| **改动文件** | `package.json` |
| **动作** | 把 `jszip` 加入 `devDependencies`（它与 `exceljs` 的 `^3.10.1` 保持同区间，避免装出两个副本） |
| **验收** | `npm install` 后 `node -e "require('jszip')"` 成功；`node scripts/publish-plugin.js --help`（或最小发布流程）可运行 |
| **风险** | 极低 |
| **回滚** | `git revert` |

### R2-3 · 引入 ESLint + Prettier + 样式令牌规则（C-06 · P1）

| 项 | 内容 |
|---|---|
| **目标** | 让"禁止硬编码色值"等红线从人工记忆变成 lint 拦截 |
| **改动文件** | 新增 `eslint.config.mjs`、`.prettierrc`、`.prettierignore`；`package.json` 加 `lint` / `lint:fix` / `format` 脚本 |
| **动作** | ① 装 `eslint` + `@eslint/js` + `typescript-eslint` + `eslint-plugin-vue` + `eslint-config-prettier` + `prettier`（ESLint 9 flat config）；<br>② 关键规则：启用 `vue/no-restricted-class` 拦 `text-white` / `bg-black` / `text-black` / 调色板类（**先确认所用 `eslint-plugin-vue` 版本支持该规则**；不支持则退化为自定义 `no-restricted-syntax` 或独立 grep 校验脚本）；<br>③ 对 `src/**` 与 `extensions/**` 的 `.vue` 启用；<br>④ 清理 `AGENTS.md` §6 的相关表述（"无 lint 红色波浪线"改为项目级 `npm run lint`） |
| **验收** | ① `npm run lint` 在修完 R1-2 后 exit 0；② **故意**在某 `.vue` 里加一个 `text-white`，lint 必须报错（验证规则真的生效）；③ `npx vue-tsc --noEmit` 不受影响 |
| **风险** | 中。存量代码可能有大量告警——建议先 `--fix` 能自动修的部分，剩余**降为 warn** 逐步收敛，避免一次性产生巨大 diff |
| **回滚** | 删除新增配置文件 + 还原 `package.json` |
| **附带收益** | 代码中 10 处空转的 `eslint-disable-next-line no-console` 将变成真实生效的抑制注释 |

### R2-4 · IPC 契约自动校验（C-02 复发防护 + D-10 · P1/P2）

| 项 | 内容 |
|---|---|
| **目标** | 让"新增通道必须同步 `src/types.ts`"从人工要求变成可自动拦截的检查 |
| **改动文件** | 新增 `scripts/check-ipc-contract.mjs`；`package.json` 加 `verify` 脚本 |
| **动作** | 脚本提取三个集合并求差：<br>① `preload.ts` 顶层暴露键<br>② `src/types.ts` 的 `ElectronAPI` 属性<br>③ 主进程注册通道（`ipcMain.handle/on` + 各 `*-handlers.ts` 的 `handle()` / `register()` 封装）<br>；对差异输出中文报告并以非 0 退出码失败。豁免清单需显式维护（`platform` 常量、`mail-sync-event` / `updater-event` 广播、`read-file` 共用通道） |
| **验收** | ① 补完 R1-3 后 `npm run verify` exit 0；② **故意**从 `types.ts` 删掉一个属性，脚本必须报错并指出差异项 |
| **风险** | 低。主要成本是封装式注册（`handle<T>('xxx')`）的正则提取，需覆盖 5 种注册文件形态 |
| **回滚** | 删除脚本 + 还原 `package.json` |
| **备注** | 这也是 D-10「缺 IPC 通道精确契约表」的**可执行替代品**——比手写一份会过期的 md 更有价值 |

### R2-5 · 引入 vitest 并覆盖 `src/lib/` 纯函数层（C-07 · P1）

| 项 | 内容 |
|---|---|
| **目标** | 为承担 Excel 解析与模板生成核心逻辑的纯函数层建立回归网 |
| **改动文件** | 新增 `vitest.config.mts`、`tests/`（含 `tests/fixtures/`）；`package.json` 加 `test` / `test:watch` 脚本 |
| **动作** | 阶段一（优先）覆盖：`src/lib/excelParser.ts`、`src/lib/fieldProcessor.ts`、`templateEngine`（**已于 2026-10-05 随孤儿代码清理删除，该项作废**）；<br>阶段二：`orderRowSplitter` / `aggregator` / `orderClassifier` / `styleMatcher`（其中 `aggregator` 同样已随该次清理删除）。<br>**夹具自建**：不要依赖根目录的 `导出测试.xlsx`（它被 `.gitignore` 忽略，CI/他机不可用），改为在 `tests/fixtures/` 放小型自造 Excel + 期望输出 |
| **验收** | ① `npm test` 全绿；② 故意改坏 `templateEngine` 的占位符替换逻辑，测试必须失败（验证测试真的在断言）——**当时已执行通过**；该模块已于 2026-10-05 删除，此条不复可做 |
| **风险** | 低。纯函数无副作用、无 DOM、无 IPC，是成本最低的测试切入点 |
| **回滚** | 删除 `vitest.config.mts` + `tests/` + 还原 `package.json` |

### R2-6 · 抽取 `electron/ipc-util.ts` 消除 5 份注册样板（C-12 · P2）

| 项 | 内容 |
|---|---|
| **目标** | 消除 5 份逐字节相同的 IPC 注册封装 |
| **重复位置** | `order-handlers.ts:99-107` 与 `purchase-handlers.ts:16-24`（`register()`，完全相同）；`ae-handlers.ts:28-37` / `mail-handlers.ts:82-91` / `shop-accounts-handlers.ts:53-62`（`handle<T>()`，同一模板 3 份拷贝） |
| **改动文件** | 新增 `electron/ipc-util.ts`；上述 5 个 handlers 文件 |
| **动作** | 抽出统一的注册封装（保留各域现有的入参校验行为与返回形状 `{ success, data|error }`），5 处改为 import |
| **验收** | ① `npx tsc -p tsconfig.electron.json --noEmit` exit 0；② `npm run build` 通过；③ `npm run mail:smoke` 通过；④ 手工触发各域一个 IPC 调用（订单列表 / 邮件同步 / 店铺账号列表 / 利润概览），返回结构不变 |
| **风险** | 中。属 `AGENTS.md` §4.2「需先理解 IPC 模式后再改」范围。**注意**各域现有的校验差异（如 `order-handlers.ts` 的"不向渲染层透传 SQL"）必须在抽取时保留，不能统一成最宽松的版本 |
| **回滚** | `git revert` |

### R2-7 · `extensions/` 目录语义分离（C-05 · P1）

| 项 | 内容 |
|---|---|
| **目标** | 消除"视图插件包 / 外置插件脚手架"混放导致的判定歧义 |
| **现状** | `extensions/` 下三类内容：①`excel-copy`/`order-insight`/`shop-accounts`（有 `meta.ts`，被 registry 收录）②`ae-profit`（R1-5 处置）③`_template`/`sk-hello`（`entry: ./index.js`、无 `meta.ts`，不被收录） |
| **动作（方案 A，推荐）** | 把 ③ 类移到独立目录（如 `scaffolds/plugin/` 与 `examples/plugins/sk-hello/`）；同步更新 `scripts/plugin-create.js` 的模板路径与 `scripts/plugins-install-demo.js` |
| **动作（方案 B，最小改动）** | 目录不动，仅在 `AGENTS.md` 中固化判定规则（**已在本次审查中完成**：§1.9 + 红线 23），并加 `.gitignore` 注释说明 |
| **验收** | 方案 A：`npm run plugins:create test-demo` 脚手架生成到新位置且能装到 `<userData>/plugins/`；`npm run plugins:demo:install` 正常；`node scripts/select-build.js --list` 仍输出 4 项 |
| **风险** | 低-中。会触碰脚手架脚本路径 |
| **建议** | 若近期不新增插件，可先采用方案 B（零成本），把方案 A 延后 |

### R2-8 · 消除源码内嵌裸控制字节（C-21 · P3 · **R2-3 执行中新发现**）

| 项 | 内容 |
|---|---|
| **来源** | R2-3 引入 lint 时，`no-control-regex` 抑制注释暴露 `electron/mail-cache.ts:50` 的字符类里嵌着**裸 `0x00`/`0x1F`**；顺藤摸出 `electron/mail-db.ts:788/862/867` 用裸 `0x00` 作模板字符串复合键分隔符 |
| **影响** | 功能正确，但这两个文件对 `grep` 表现为**二进制文件**：BSD grep 会静默跳过，返回空结果（本次审查期已实际踩坑，一度被误读为"某声明不存在"）；编辑器/格式化工具亦可能改写这两个不可见字节 |
| **动作** | 把裸字节改为**转义写法**（`\x00` / `\x1f`），语义完全等价；改后跑 `file` 确认不再是 binary，并跑 `npm run mail:smoke` 验证邮件引擎 |
| **改动文件** | `electron/mail-cache.ts`、`electron/mail-db.ts` |
| **验收** | ① `file` 输出不再是 binary；② `grep -n "u0000"` 类查询能命中；③ `npm run mail:smoke` 通过；④ `npx tsc -p tsconfig.electron.json --noEmit` exit 0 |
| **风险** | 极低（纯转义等价改写） |
| **回滚** | `git revert` |

---

## Phase 3 · 依赖与结构升级

> **高风险阶段。前置条件：Phase 2 全部完成**（ESLint + 契约校验 + 测试是这次升级的安全网）。
> 建议先建分支 `chore/dep-upgrade`，`npm run dist` 出包后手工回归通过再合入。

### R3-1 · Vite 5 → 8（C-10 · P2，但属架构级变更）

| 项 | 内容 |
|---|---|
| **前置** | **R2-1 必须已完成**。Vite 8 用 Rolldown + Oxc 取代 Rollup + esbuild，`vite.config.ts` 的 esbuild import 会直接失效 |
| **目标版本** | `vite@8.1`+（当前支持线：8.1 常规修复 / 7.3+8.0 重要修复 / 6.4 仅安全补丁；**5.4 已不受支持**）。要求 Node.js 20.19+ 或 22.12+（开发机满足） |
| **改动文件** | `package.json`（`vite`、`@vitejs/plugin-vue`、**`vitest`**）；`vitest.config.mts`（若 API 变更） |
| **动作** | ① 先读 Vite 官方 Migration Guide（5→6→7→8 的破坏性变更）；② 升 `vite` 与 `@vitejs/plugin-vue` 到互相兼容的版本；③ 检查 `vite.config.ts` 中 `base` / `build.outDir` / `resolve.alias` / `server.port` 在 Vite 8 的语义；④ 确认 `@vitejs/plugin-vue` 适配 Vue 3.5 与 Rolldown；⑤ **同步升级 `vitest`**（R2-5 落地的 `^2.1.9` 与 vite 5 同代，vite 8 需 vitest 3.x/4.x），并复核 `vitest.config.ts` 的 `test.env` / `resolve.alias` 语义是否变化 |
| **验收** | ① `npm run build` 通过；② `dist/renderer` 产物可正常加载（`npm run dev` 起界面，切模块、⌘K、主题切换均正常）；③ `node scripts/select-build.js --list` 输出 4 项且裁包生效；④ UI 岛的独立构建产物不受影响；⑤ 包体积与升级前对比无异常膨胀；⑥ **`npm test` 仍 131 用例全绿**（R2-5 建的回归网是本次升级的主要安全网，先绿再改） |
| **风险** | **高**。Rolldown/Oxc 是新管线，插件生态兼容性需实测。Tailwind 3 + PostCSS 走的是 PostCSS 链路，受影响较小；但若出现构建异常，优先怀疑 Plugin 兼容性 |
| **回滚** | 分支未合入即丢弃；或 `git revert` + `npm install` |
| **不在本次范围** | Tailwind 3 → 4（v4 为 CSS-first 大改，项目重度依赖 `--wb-*` 令牌 + `@layer components`，收益低风险高）；Pinia 2 → 4（与 Electron 升级一起评估更合适） |

### R3-2 · Electron 33 → 43/44（C-10 · P2）

| 项 | 内容 |
|---|---|
| **根因** | Electron 33 已于 **2025-04-29 EOL**（约 1 年 4 个月无安全补丁）。官方仅支持最新 3 个大版本：44（EOL 2027-03-02）/ 43（2027-01-05）/ 42（2026-10-20） |
| **目标版本** | **建议 43 或 44**（42 一个月后到期，不作终点）。44 最新为 44.3.0 |
| **跨度影响** | 跨 **11 个大版本**：Chromium M130 → M152、Node.js 20.18 → 24.16 |
| **改动文件** | `package.json`（`electron`、`@electron/rebuild`） |
| **动作** | ① 逐个大版本读 Breaking Changes，重点关注本项目实际用到的：`BrowserWindow` / `webContents.send` / `contextBridge` / `net`（`http-client.ts`）/ `protocol.handle`（`plugin-ui-protocol.ts` 的自定义 `sk-plugin` 协议）/ `app.getPath` / `nativeImage` / `ses`；<br>② `npm install` 后跑 `npm run rebuild`（重编 `better-sqlite3` 到新 Node ABI）；<br>③ 重新验证 `scripts/afterPack.js` 的 ElectronAsarIntegrity 移除逻辑是否仍必需/仍有效（`AGENTS.md` §7 记录的历史闪退修复）；<br>④ 确认 `electron-store@8` 的动态 `import()` + SimpleStore 降级路径在新版下仍工作 |
| **验收** | ① `npm run dev` 可启动；<br>② `npm run build` + `npm run dist` 出包，**macOS 打开不闪退**（重点回归 afterPack 逻辑）；<br>③ `better-sqlite3` 正常：邮件同步 / 订单库 / 拿货对账 / 利润表读写均可用；<br>④ `npm run plugins:sandbox:smoke` 通过（Worker 沙箱在新 Chromium 下行为需验证）；<br>⑤ `npm run mail:smoke` 通过；<br>⑥ 自动更新链路（`updater.ts` setFeedURL）与实际 Release 资产匹配 |
| **风险** | **高**。11 个大版本的累积破坏性变更 + 原生模块 ABI 变化 + Chromium 安全模型收紧。**建议分两步走**：先升到 38 或 40（中间版本）验证一轮，再升 43/44；若时间紧，直接到 43 但要接受更长的调试周期 |
| **回滚** | 分支丢弃；或 `git revert` + `npm install` + `npm run rebuild` |

### R3-3 · 拆分 `pluginManager.ts` 的 683 行函数（C-11 · P2）

| 项 | 内容 |
|---|---|
| **目标** | 降低最复杂文件的维护成本 |
| **现状** | `src/core/plugin/pluginManager.ts:193` 的 `createBuiltinPluginManager` 为 **683 行**，混合了发现 / 激活 / 贡献注册 / 启停 / 状态持久化多职责。（另 4 个超长函数：`sandbox.ts:122` 344 行、`ae-engine.ts:133` 202 行、`mail-engine.ts:432` 167 行、`uiBridgeHost.ts:223` 158 行） |
| **改动文件** | `src/core/plugin/pluginManager.ts`（+ 可能新增内部子模块） |
| **动作** | 按四职责抽内部函数/子文件：**发现**（`discoverExternal` 相关）/ **激活**（生命周期 + 超时 + 崩溃处理）/ **贡献注册**（视图 / 命令 / 设置）/ **启停**（`setPluginEnabled` / `applyDisabled` + 持久化）。**保持对外 `pluginManager` 门面签名不变**，避免波及 `AppShell.vue` / `PluginCenter.vue` / UI 岛桥 |
| **验收** | ① `npx vue-tsc --noEmit` exit 0；② `npm run plugins:sandbox:smoke` 通过（**这是本任务的核心回归**，覆盖 boot→command→call→deactivate→token 拒绝全链路）；③ ⌘K 命令、侧边栏、设置页插件分类、内建行启停按钮行为不变；④ 最长函数回落到 150 行以内 |
| **风险** | 中高。该文件是 `AGENTS.md` §4.4 列明的**受保护内核**，且沙箱双端协议常量必须保持同步（红线 20/21/22）。**建议纯重构、不改任何行为**，一次只抽一个职责并跑冒烟 |
| **回滚** | `git revert` |

### R3-4 · 主进程渐进开启类型严格度（C-13 · P2）

| 项 | 内容 |
|---|---|
| **目标** | 缩小主进程（`any` 267 处、SQL/IPC/路径操作密集）的类型盲区 |
| **现状** | `tsconfig.electron.json` 为 `strict: false`；渲染层已是 `strict: true` |
| **动作（渐进，不可一步到位）** | ① 先开 `noImplicitAny`，记录错误量；② 若量可控则修复；若不可控，改为**按目录收紧**（如新文件放 `electron/strict/` 或用 `// @ts-check` 逐文件试点）并只对新增代码要求；③ 明确记录当前的宽松配置是有意决策，而非遗漏（写入 `AGENTS.md`） |
| **验收** | ① `npx tsc -p tsconfig.electron.json --noEmit` exit 0；② 严格度调整后 `npm run build` 通过；③ 若采用目录级收紧，新增文件确实受约束 |
| **风险** | 中。主进程 26 个文件、11,283 行，一次性 `strict` 会产生大量错误 |
| **建议** | 本项**不阻塞**其他任务，可长期挂着增量推进 |

### R3-5 · 收敛组件内硬编码色值（C-09 · P2）

| 项 | 内容 |
|---|---|
| **目标** | 让主题令牌体系真正覆盖所有颜色来源 |
| **现状** | `extensions/order-insight/src/components/ProductLibraryView.vue:189-211` 有 18 处色卡 hex（`黑色:'#3a3a3a'` … 兜底 `'#b9bdc7'`）；`extensions/shop-accounts/src/components/MailAccessDrawer.vue:305` 有 `box-shadow: -18px 0 48px rgb(0 0 0 / 18%)` |
| **动作** | ① 色卡字典属**业务数据**（颜色名→色值映射），非主题色——建议保留在独立常量文件并注明"业务色卡，不参与主题切换"，而非强行令牌化；② `box-shadow` 的阴影色改为令牌（新增一个 `--wb-shadow` 或在 `index.css` 定义） |
| **验收** | ① 色卡逻辑抽到独立文件后，`ProductLibraryView.vue` 不再直接出现 hex；② 深色/浅色主题下抽屉阴影均自然；③ R2-3 的 lint 规则不再对这些位置报错 |
| **风险** | 低 |
| **回滚** | `git revert` |

---

## Phase 4 · 文档补齐（可与 Phase 2/3 并行）

### R4-1 · 处置 `PROJECT_OVERVIEW.md`（D-01 · P1）

| 项 | 内容 |
|---|---|
| **问题** | 描述 2026-06 单体时期形态，含已删除文件（`src/components/*`、`src/stores/app.ts`）、已改名类型（`interface Record`）、不存在的 `测试模板.txt`、仅 8 条 IPC 通道描述。对新人构成实质误导 |
| **动作（二选一）** | **方案 A（推荐）**：直接删除。其"现状描述"职责已由 `docs/baseline/PROJECT_BASELINE.md` 承接，无不可替代内容。<br>**方案 B**：重写为纯"项目演变史"（记录单体 → 模块化 → 插件化的动机与节点），删除所有"当前结构"类描述 |
| **验收** | 文档中不再出现已不存在的文件路径与过期 IPC 数量 |
| **风险** | 低（已加过期横幅，删除不丢信息） |

### R4-2 · 补写 `USER_GUIDE.md` 的缺失章节（D-02 / D-03 · P1）

| 项 | 内容 |
|---|---|
| **问题** | `docs/guides/USER_GUIDE.md` 最后更新 2026-06-20，未覆盖 2026 年后的能力；且与已归档的 `manual.md` 存在重复（重复问题已通过归档解决） |
| **动作** | ① 补章节：店铺账号管家、订单归类（AI 识别 / 拿货对账）、集中收件箱、自动更新；<br>② 修正事实错误：数据位置描述（应为 `modules.<namespace>` 命名空间而非平铺 `seller-kit/config.json`）、平台说明（**arm64 + x64 双架构**，非仅 arm64）；<br>③ 提示默认模板示例 `📅 Expiry Date: {{Package}}` 的占位符语义（当前与 `store.ts` 一致但易混淆）；<br>④ 补"打包与分发"章节 |
| **验收** | 用户可按文档独立完成各模块的首次使用；无事实性错误 |
| **风险** | 低 |

### R4-3 · 建立 `CHANGELOG.md` 与发布规范（D-09 / C-16 · P1/P2）

| 项 | 内容 |
|---|---|
| **问题** | 无 CHANGELOG；4 个 git tag（`v1.0.0`/`v1.0.1`/`v1.0.2`/`v1.0.4`）指向同一 commit `9ccb73d`，缺 `v1.0.3`，版本历史不可追溯；`electron-builder.yml` 的 `publish` 指向 GitHub Releases |
| **动作** | ① 新建 `CHANGELOG.md`（Keep a Changelog 格式），**从 v1.0.4 起正向记录**，历史部分标注"补录，来源为 git log";<br>② 固化发布流程并写入 `README.md`：bump `package.json` version → 更新 CHANGELOG → commit → `npm run dist`（electron-builder 自动打 tag 并上传）→ 核对 Release 资产；<br>③ 明确"不再补打历史 tag"（已错位，补打只会加重混乱） |
| **验收** | 下一次发布产生唯一且指向发布 commit 的 tag；CHANGELOG 有对应条目 |
| **风险** | 低 |

### R4-4 · 标注 `PLUGIN_ARCHITECTURE.md` §4 为目标态（D-11 · P2）

| 项 | 内容 |
|---|---|
| **问题** | §4 描述 pnpm workspaces + `packages/core` 的 monorepo 结构，实际是单仓 `src/core/plugin`。未标注"目标态/未采纳"，易被误读为现状 |
| **动作** | 在 §4 顶部加显著标注：`> ⚠️ 本节为目标态设计，尚未采纳。当前实现为单仓 src/core/plugin，规则以 AGENTS.md 为准。`；同时复核全文其他"未来态"章节是否有同类问题 |
| **验收** | 读者不会把目标态误当现状 |
| **风险** | 低 |

### R4-5 · 决定 `.gitignore` 入库策略（D-07 · P2）

| 项 | 内容 |
|---|---|
| **问题** | `AGENTS.md` / `PLUGIN_ARCHITECTURE.md` / `PROJECT_OVERVIEW.md` / `REFACTOR_PLAN.md`（现有）与 `docs/baseline/` / `docs/reviews/`（本次新增）不入库，但 `PLUGIN_DEVELOPMENT.md` 入库。导致**克隆仓库者打开 `PLUGIN_DEVELOPMENT.md` 必然看到指向不存在文件的引用** |
| **动作（三选一，需你决策）** | **A**：维持现状（fork 干净度优先），在 `PLUGIN_DEVELOPMENT.md` 中改写引用为"内部文档，不入库"并给出获取方式；<br>**B**：架构类文档改为入库（提高可追溯性，但会上传到 `SayakABC/SellerKit` 上游）；<br>**C**：架构文档拆两层——对外部分入库、内部决策记录不入库 |
| **验收** | 任何入库文档中的引用，指向的目标文件**也在库内**（无悬空引用） |
| **风险** | 低，但属产品决策，需你拍板 |

### R4-6 · 补 `CONTRIBUTING.md` 与 `LICENSE`（D-09 · P1）

| 项 | 内容 |
|---|---|
| **问题** | 无授权声明；无人类贡献者指南（`AGENTS.md` 面向 AI 编码，不完全等同） |
| **动作** | ① `LICENSE`：**注意本仓库 remote 为 `SayakABC/SellerKit`**，需先确认上游授权与 fork 的许可安排，不要臆造许可类型；② `CONTRIBUTING.md`：最小可用版（开发环境、分支策略、提交规范、`npm run lint` / `test` / `verify` 门禁、PR 前检查清单） |
| **验收** | 新人可依文档完成一次本地开发与提交 |
| **风险** | 低。**LICENSE 需你确认许可类型后再写** |

### R4-7 · 修正剩余文档事实性错误（D-12 · P2）

| 项 | 内容 |
|---|---|
| **动作** | ① 本轮已修正的：`PROFIT_TRACKER.md` §7 落位矛盾、`REFACTOR_PLAN.md` 状态标记、`AGENTS.md` 三处滞后、4 份文档的状态横幅；<br>② 剩余待修：`PLUGIN_ARCHITECTURE.md` 其它"未来态"章节；`PROJECT_BASELINE.md` 中的"IPC 通道完整清单未单独成文"改为引用 `R2-4` 产出的校验脚本；<br>③ 复核所有文档的裸文件名引用是否已全部改为仓库根相对路径 |
| **验收** | 全仓文档引用检查无悬空、无过期文件路径 |
| **风险** | 低 |

---

## 5. 明确不做的事（范围边界）

| 不做 | 原因 |
|---|---|
| **Tailwind 3 → 4** | v4 为 CSS-first 大改；项目重度依赖 `--wb-*` 令牌 + `@layer components` 全局输入控件规则，迁移成本高、收益低 |
| **Pinia 2 → 4** | v4 为 ESM-only；与 Electron 升级一起评估更合适，单独升级无收益 |
| **`electron-store` 8 → 10+** | v8 的 ESM-only 问题**已用动态 `import()` + SimpleStore 降级解决**（`AGENTS.md` §7 记录），属已知规避，非缺陷 |
| **补齐全部 `any`（约 288 处）** | 主进程宽松是既有的有意决策；只做 R3-4 的渐进收紧，不做全量类型化 |
| **给 UI 岛补自动化测试** | UI 岛是独立分发产物、iframe 隔离、经 host 能力域访问；测试成本远高于 `src/lib/` 纯函数层。等 R2-5 跑顺后再评估 |
| **引入 CI（GitHub Actions）** | 无上游 CI 约定，且 fork 仓库跑 CI 需额外配置。**建议在 R2-3/R2-5/R2-4 完成后单独决策**（这是 R2 的自然延伸，但不属本计划承诺范围） |
| **重写 `PROJECT_OVERVIEW.md` 为完整"演变史"** | R4-1 提供方案 A（删除）与方案 B（改写）；推荐 A，避免维护第二份会过期的现状描述 |

---

## 6. 阶段验收（Definition of Done）

### Phase 0 出口条件
- [ ] 工作区已提交，`v1.0.4` tag 指向整改起点
- [ ] `node -p "require('./node_modules/xlsx/package.json').version"` 显示已换源版本
- [ ] Excel 导入 / 导出实测通过

### Phase 1 出口条件
- [ ] `node scripts/select-build.js --list` 输出 **4 项**
- [ ] 深色主题下 Toast 与徽标文字可读
- [ ] `npx vue-tsc --noEmit` exit 0
- [ ] `npx tsc -p tsconfig.electron.json --noEmit` exit 0
- [ ] `npm run build` 通过
- [ ] `git status` 无 `extensions/ae-profit/`

### Phase 2 出口条件
- [ ] `grep -rn "from 'esbuild'" vite.config.ts` 无输出
- [ ] `npm run build` 产出的 `registry.generated.ts` 与 R2-1 改动前**逐字节一致**
- [ ] `npm run lint` exit 0，且故意违规能被拦下
- [ ] `npm run verify` exit 0，且故意删声明能被拦下
- [ ] `npm test` 全绿，且故意改坏逻辑会失败
- [ ] `npm run mail:smoke` 通过 ❗**未完成**：需真实 IMAP 凭据（`MAIL_USER` / `MAIL_PASS`），本机无凭据时只打印"缺少凭据"退出；其 `tsc` 阶段通过

### Phase 3 出口条件
- [ ] `npx vue-tsc --noEmit` / `tsc -p tsconfig.electron.json --noEmit` 均 exit 0
- [ ] `npm run build` + `npm run dist` 出包成功
- [ ] **macOS 安装包打开不闪退**（afterPack 逻辑回归）
- [ ] `npm run plugins:sandbox:smoke` 通过
- [ ] `npm run mail:smoke` 通过 ❗**未完成**：需真实 IMAP 凭据（`MAIL_USER` / `MAIL_PASS`），本机无凭据时只打印"缺少凭据"退出；其 `tsc` 阶段通过
- [ ] 手工回归矩阵：启动 / 导入 Excel / 预览 / 复制 / 设置页 / 主题切换 / 插件启停 / ⌘K / UI 岛加载 / 邮件同步 / 店铺账号 ❗**未完成**：需人工 GUI
- [~] `better-sqlite3` 相关功能（邮件 / 订单 / 拿货 / 利润）读写正常：**ABI 层面已验**（Electron 44 内建表/插入/查询往返成功、产物内 .node 为 arm64 ABI 149），**业务功能层面未验**（需 GUI）
- [x] `pluginManager.ts` 最长函数 ≤ 150 行（实测最长 79 行：`managerActivate.activate` / `managerContext.createPluginContext`）

### Phase 4 出口条件
- [~] 根目录有 `README.md` ✅、`CHANGELOG.md` ✅、`CONTRIBUTING.md` ✅、`LICENSE` ❗**待用户选定协议**（源项目为 fork，许可证类型需项目方决定，不宜代拟）
- [x] 全仓文档引用无悬空（`npm run verify:docs` → 0 悬空；校验器含 3 类反例自测）
- [ ] `USER_GUIDE.md` 覆盖全部当前模块
- [x] `.gitignore` 策略已定案并写入注释（R4-5：注释写明「全部入库，仅排除 AI 工具本地数据」并保留了「如需重新忽略某类文档怎么改」的说明）

---

## 7. 风险登记册

| 风险 | 关联任务 | 影响 | 缓解措施 |
|---|---|---|---|
| 删 `extensions/ae-profit/` 造成功能丢失 | R1-5 | 利润追踪展示端失效 | **强制等价性确认**；有疑虑则保留目录但从 `tsconfig.json` include 排除 |
| Vite 8 Rolldown 迁移出现构建异常 | R3-1 | 构建链不可用 | R2-1 先行；分支开发；`registry.generated.ts` 逐字节比对 |
| Electron 跨 11 版升级累积破坏 | R3-2 | 运行时行为变化 / 原生模块失效 | 分步升级（先中间版本）；完整回归矩阵；保留回滚分支 |
| 拆分 `pluginManager` 破坏沙箱协议 | R3-3 | 插件体系失效 | 纯重构不改行为；每次只抽一个职责；跑 `plugins:sandbox:smoke` |
| ESLint 引入产生巨大存量 diff | R2-3 | 评审困难、掩盖真实改动 | 存量告警降为 warn 逐步收敛；`--fix` 单独一个 commit |
| `modules.config.ts` → JSON 改变求值语义 | R2-1 | 打包范围出错 | 以 `registry.generated.ts` 逐字节一致作为硬验收 |
| `dist:select` 已产出过残缺包 | R1-1 | 已分发的安装包缺核心功能 | **建议排查已发布 Release 资产**；若确实残缺需重新出包 |

---

## 8. 进度跟踪

> 执行时把 `[ ]` 改为 `[x]`，并在括号内补 commit sha。

### Phase 0 · 安全修复
- [x] `R0-0` 清理工作区 + 打起点 tag（文档整理 `ea267f9`；业务代码 `744fbe3`，tag `remediation-baseline` 指向 `744fbe3`。**注：原计划写 tag `v1.0.4`，因该 tag 已错位指向 `9ccb73d` 而改用语义中性的新 tag**）
- [x] `R0-1` xlsx 换源消除 CVE（C-01）（`2b122ca`）

### Phase 1 · 基线合规即时修复
- [x] `R1-1` 修 `dist:select` 模块扫描根（C-20）★（`6a958b3`）
- [x] `R1-2` 深色主题 8 处 `text-white`（C-03）（`c5b6c51`）
- [x] `R1-3` 补齐 `ElectronAPI` 4 项声明（C-02）（`12947ad`）
- [x] `R1-4` `buildVersion` 与 `version` 对齐（C-15）（`f8fc95d`）
- [x] `R1-5` 处置 `extensions/ae-profit/`（C-04）（`ad7471d`）

### Phase 2 · 扩展模型与工程化护栏
- [x] `R2-1` 消除 esbuild 隐式依赖（C-18）★（`ee912ec`）
- [x] `R2-2` 补声明 jszip（C-19）（`ad91889`）
- [x] `R2-3` ESLint + Prettier + 样式令牌规则（C-06）（`3ac8b7a`）
- [x] `R2-4` IPC 契约自动校验（C-02 防护 / D-10）（`305669c`）
- [x] `R2-5` vitest 覆盖 `src/lib/`（C-07）（`62a760d`。**部分完成**：131 用例覆盖 `src/lib/` 全部 7 个模块；**无 CI**、组件/store/主进程/沙箱仍未覆盖，详见 `CODE_REVIEW_REPORT.md` §2.7）
- [x] `R2-6` 抽 `electron/ipc-util.ts`（C-12）（`f82ef04`。**附带修掉校验脚本自身的按文件耦合**：包装名改为跨文件解析，否则抽成共享模块后 26 个通道会被误判为未注册）
- [x] `R2-7` `extensions/` 语义分离（C-05）（**用户确认采用方案 B 并延后方案 A**，2026-09-16：判定规则已固化在 `AGENTS.md` §1.9 + 红线 23；`extensions/_template`、`extensions/sk-hello` 暂不搬迁 —— **后于 2026-09-22 由 `PLUGIN_TRIAGE_PLAN` T4 完成搬迁**：`extensions/_template` → `scripts/templates/l2-plugin`、`extensions/sk-hello` → `scripts/templates/l2-demo`，两个构建脚本已同步重指向并实跑验证）
- [x] `R2-8` 消除源码内嵌裸控制字节（C-21，R2-3 新发现）（`b18166e`。7 个裸字节改为转义；`file` 不再判为 binary，等价性用「旧版/新版表达式同输入比对」证明）

### Phase 3 · 依赖与结构升级
- [x] `R3-1` Vite 5 → 8（C-10）（`356ec1c`。vite ^8.3.0 / plugin-vue ^6.0.9 / vitest ^4.1.11；registry 逐字节一致、minimal 裁包生效、UI 岛独立构建不受影响。npm Arborist 崩溃用 --legacy-peer-deps 绕过）
- [x] `R3-2` Electron 33 → 43/44（C-10）（`699bc4c`。唯一断点 = node-abi 不识 ABI 149，scoped overrides 收窄到 ^4.35.0 解决；打包产物运行时自检 44.4.1/node24.21.0/abi149，启动存活。**坑**：本机 IDE 的 ELECTRON_RUN_AS_NODE=1 会劫持产物直启；GitHub 直连拉 zip 龟速需 ELECTRON_MIRROR）
- [x] `R3-3` 拆分 `pluginManager.ts`（C-11）（`7dd6a69`。683 行工厂 → 6 个职责文件 + 门面；最长函数 79 行；沙箱冒烟 12 项全过；对外签名逐字不变）
- [x] `R3-4` 主进程渐进开启严格类型（C-13）（`5a328e5`。noImplicitAny 已开启：61 错 → 2 处 typed require 断言 + 9 处逐点修复（含真缺口 ShopAccountUpsertInput 补 mailAuthPwd、mailparser/yauzl 补 @types、simpleParser 重载误匹配修掉 3 处 as any）；strict 仍为 false（有意决策已写入 AGENTS.md §6.0.1））
- [x] `R3-5` 收敛硬编码色值（C-09）（`44c7521`。色卡抽 `lib/colorSwatch.ts`（业务数据，刻意不令牌化）+ 7 条用例反向断言；新增 `--wb-shadow` 双主题令牌；顺带修掉 UiIslandView 裸 hex；AGENTS §1.6 沉淀"何谓允许的固定色值"判定表）

### Phase 4 · 文档补齐
- [x] `R4-1` 处置 `PROJECT_OVERVIEW.md`（D-01）（**采用方案 A：删除**。用户确认。`docs/architecture/PROJECT_OVERVIEW.md` 已删；`docs/README.md` 索引/目录树、`REFACTOR_PLAN.md`、`PLUGIN_ARCHITECTURE.md`、`PROJECT_BASELINE.md` 共 5 处引用已同步改写为「已于 R4-1 删除」）
- [ ] `R4-2` 补写 `USER_GUIDE.md`（D-02 / D-03）（）
- [x] `R4-3` `CHANGELOG.md` + 发布规范（D-09 / C-16）（已建 `CHANGELOG.md`：按 tag 与提交史回溯 1.0.0→1.0.4 并单列本次整改；含**发布前检查清单**与 `npm run dist:select` 的模块勾选说明）
- [x] `R4-4` 标注 `PLUGIN_ARCHITECTURE.md` §4 目标态（D-11）（文首新增「哪些章节是目标态」索引表 + §4/§5/§8 三处行内标注：monorepo/pnpm workspaces 未采纳，`packages/*` 路径实为 `src/core/plugin/*`；并注明「代码结构以 AGENTS.md 为准」）
- [x] `R4-5` `.gitignore` 入库策略定案（D-07）（**用户确认改为全部入库**：删除 `AGENTS.md` 与 `docs/**` 的全部忽略条目，仅保留 `.workbuddy/`/`.codebuddy/`；理由=AGENTS.md 是助手强制约定入口、`PLUGIN_DEVELOPMENT.md` 引用的文件不能悬空。入库前已扫描密钥/内网 IP/凭据，无命中。`docs/README.md` 与 `CODE_REVIEW_REPORT.md` §5.6 策略节已改写）
- [~] `R4-6` `CONTRIBUTING.md` + `LICENSE`（已建 `CONTRIBUTING.md`（环境坑/分支/Conventional Commits/门禁/PR 清单）；`LICENSE` ❗**待用户选定协议**——源项目为 fork，许可证类型不宜代拟）
- [x] `R4-7` 修正剩余文档事实错误（D-12）（`<sha>`。`PROJECT_BASELINE.md` 的 IPC 数字改为实测值并改为引用校验脚本；`PLUGIN_ARCHITECTURE.md` §4/§5/§8 已加目标态标注（R4-4）；悬空引用改为**可复跑校验**：新增 `scripts/check-doc-links.mjs` + `npm run verify:docs`，**实测 20 个 md / 186 个代码文件、439 条引用 → 悬空 0**（真错误 1 条：`module-roots.js` 应为 `.cjs`）；三类反例（断链/幽灵路径/代码注释引用已删文档）实测均 exit 1）

---

## 附录 · 任务 ↔ 发现项对照

| 发现 | 级别 | 任务 | Phase |
|---|---|---|---|
| C-01 | 🔴 P0 | R0-1 | 0 |
| C-20 | 🟠 P1 | R1-1 | 1 |
| C-03 | 🟠 P1 | R1-2 | 1 |
| C-02 | 🟠 P1 | R1-3（修复）+ R2-4（防复发） | 1 / 2 |
| C-04 | 🟠 P1 | R1-5 | 1 |
| C-15 | 🟡 P2 | R1-4 | 1 |
| C-18 | 🟠 P1 | R2-1 | 2 |
| C-19 | 🟡 P2 | R2-2 | 2 |
| C-06 | 🟠 P1 | R2-3 | 2 |
| C-07 | 🟠 P1 | R2-5 | 2 |
| C-12 | 🟡 P2 | R2-6 | 2 |
| C-05 | 🟠 P1 | R2-7 | 2 |
| C-10 | 🟡 P2 | R3-1（Vite）+ R3-2（Electron） | 3 |
| C-11 | 🟡 P2 | R3-3 | 3 |
| C-13 | 🟡 P2 | R3-4 | 3 |
| C-09 | 🟡 P2 | R3-5 | 3 |
| C-14 | 🟡 P2 | R3-4（部分） | 3 |
| C-16 | 🟡 P2 | R4-3 | 4 |
| C-17 | 🟡 P2 | ✅ 本次已修（`AGENTS.md` §6） | — |
| D-01 | 🟠 P1 | R4-1 | 4 |
| D-02 | 🟠 P1 | R4-2（`manual.md` 已归档） | 4 |
| D-03 | 🟠 P1 | R4-2 | 4 |
| D-04 | 🟡 P2 | ✅ 本次已修（`REFACTOR_PLAN.md` 状态） | — |
| D-05 | 🟡 P2 | ✅ 本次已修（`PROFIT_TRACKER.md` §7） | — |
| D-06 | 🟡 P2 | ✅ 本次已修（`AGENTS.md` 3 处） | — |
| D-07 | 🟡 P2 | R4-5 | 4 |
| D-08 | 🟠 P1 | ✅ 本次已补 `README.md` | — |
| D-09 | 🟠 P1 | R4-3 + R4-6 | 4 |
| D-10 | 🟡 P2 | R2-4 | 2 |
| D-11 | 🟡 P2 | R4-4 | 4 |
| D-12 | 🟡 P2 | R4-7 | 4 |

> 发现项侧：`C-17` / `D-04` / `D-05` / `D-06` / `D-08` 5 项在制定计划时已顺手修掉，其余 26 项各对应一个任务。
> 任务侧：**27 个任务中 25 个已完成**，`R4-2` 未开始、`R4-6` 部分完成（`LICENSE` 待定）。
