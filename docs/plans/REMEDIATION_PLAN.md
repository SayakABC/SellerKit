# SellerKit 整改计划（REMEDIATION_PLAN）

> **依据**：[`../reviews/CODE_REVIEW_REPORT.md`](../reviews/CODE_REVIEW_REPORT.md)（31 项发现：1×P0 + 13×P1 + 17×P2）
> **状态**：🟢 **25 / 27 任务已完成**（Phase 0–3 全关；Phase 4 仅 `R4-2` 未开始、`R4-6` 的 `LICENSE` 待定协议）。逐任务 commit sha 与遗留见 **§8**。
> **范围**：仅覆盖审查报告的发现项，不含新功能。原则：**增量执行、每阶段独立提交、每阶段可验证可回滚**。

---

## 1. 计划原则

| # | 原则 | 说明 |
|---|---|---|
| P1 | **阶段闸门** | 一个 Phase 全完成后才进下一个，不允许跨阶段并行改结构 |
| P2 | **一键回滚粒度** | 每任务 = 一个独立 commit，`git revert <sha>` 即可 |
| P3 | **先护栏后升级** | Phase 2 的 ESLint/契约校验/测试是后续升级安全网，不跳过直接做 Phase 3 |
| P4 | **依赖顺序不可颠倒** | `R2-1`（去 esbuild 隐式依赖）是 `R3-1`（Vite 8）硬前置 |
| P5 | **改动即验证** | 每任务给明确验收命令/操作，无验证结论不许标记完成 |
| P6 | **文档与代码同批** | 改架构约束/目录结构的任务同 commit 更新 `AGENTS.md`/基线/相关文档 |

---

## 2. 阶段总览

| Phase | 主题 | 任务数 | 对应发现 | 目的 | 风险 |
|---|---|---:|---|---|---|
| **Phase 0** | 安全修复 | 2 | C-01 | 消唯一 P0 与工作区污染 | 极低 |
| **Phase 1** | 基线合规即时修复 | 5 | C-20,C-03,C-02,C-15,C-04 | 修"会静默出错"和"违反红线"的点 | 低 |
| **Phase 2** | 扩展模型与工程化护栏 | 7 | C-18,C-19,C-06,C-07,C-12,C-05,C-02† | 规则变自动化拦截；扫升级障碍 | 中 |
| **Phase 3** | 依赖与结构升级 | 5 | C-10,C-11,C-13,C-09 | 脱 EOL 依赖；削复杂度 | **高** |
| **Phase 4** | 文档补齐 | 7 | D-01~D-03,D-09,D-10,D-11,D-07,C-16 | 补缺失文档、消除过期内容 | 低 |
| — | **合计** | **27** | — | — | — |

> 实际总数 27（R2-8 执行中新增）。**Phase 4 可与 Phase 2/3 并行**（只碰 `docs/`）。

### 依赖关系

```
Phase 0 ─► Phase 1 ─► Phase 2 ─► Phase 3
                └──────────┴──────────► Phase 4（可并行）
关键硬依赖：R2-1 ─► R3-1；R1-3 ─► R2-4；R2-3 ─► R3-5；工作区干净(R0-0) ─► 其余
```
**路线图**：先止血（Phase 0/1）→ 装护栏（Phase 2）→ 动大件（Phase 3）→ 文档随时跟上（Phase 4）。

---

## Phase 0 · 安全修复

### R0-0 · 前置：清理工作区
**目的**：20 个已修改+9 个新增未提交文件，整改须建立在可回滚基线。**动作**：评审并提交未提交改动；打 tag 作整改起点。**验收**：`git status --short` 除 `.gitignore`/`docs/` 外无未提交。

### R0-1 · `xlsx` 换源消除两个 CVE（C-01 · P0）★
**目标**：消 CVE-2023-30533（原型污染）+ CVE-2024-22363（ReDoS）。`xlsx@0.18.5` 修复版仅发 SheetJS CDN，`npm update` 无法升。
**改动**：`package.json` 的 `overrides` 加 `"xlsx": "https://cdn.sheetjs.com/xlsx-<VER>/xlsx-<VER>.tgz"`，`npm install`。
**验收**：① `node -p "require('./node_modules/xlsx/package.json').version"` 显示新版本；② 导入含多 Sheet/中文/合并单元格的真实 Excel 正确；③ `order-export-excel` 与 UI 岛 `exportWorkbook` 结果与升级前一致；④ `npm run build` 通过。
**回滚**：删 `overrides.xlsx` 行 → `npm install`（备选：`exceljs` 可承担解析但迁移成本高）。

---

## Phase 1 · 基线合规即时修复

### R1-1 · 修 `dist:select` 模块扫描根（C-20 · P1-High）★ 最高优先
**目标**：让交互式打包选择器列出全部 4 个模块，消"静默产出残缺包"。根因：`scripts/select-build.js:23` 只扫 `src/modules`，外挂化后 3 个主力模块在 `extensions/`。
**改动**：改扫双根（`src/modules/<id>/meta.ts` 内建；`extensions/<id>/src/meta.ts` 视图插件包，自动排除 `_template`/`sk-hello`）。
**验收**：`node scripts/select-build.js --list` 输出 **4 项**（excel-copy/quick-note/order-insight/shop-accounts）；`npm run build:select` 产出 4 个 chunk。**已落地（R4-7）**：抽出 `scripts/lib/module-roots.cjs` 供两处共用。
> **排第一**：本次唯一实测复现的功能性缺陷，静默产出错误交付物，建议排查已发布产物。

### R1-2 · 深色主题 8 处白字白底（C-03 · P1）
**目标**：修对比度低至 1.6:1 的文字。7 个文件（`ToastHost.vue:10,12`/`FieldRuleManager.vue:27`/`CorrectionRow.vue:15`/`OrderInsightView.vue:24`/`OrderDetailTable.vue:112`/`ProductLibraryView.vue:118,119`）。
**动作**：`text-white` → `text-[var(--wb-primary-contrast)]`（深色底文字色设计用途）。**不要动** `ProductLibraryView.vue:79/:85` 的 `bg-black/55+text-white`（图片遮罩，白字正确）。
**验收**：深色下 Toast/徽标清晰、浅色无回归。**风险**：极低（纯样式；`tailwind.config.js` 有意未覆盖 `white`）。

### R1-3 · 补齐 `ElectronAPI` 缺失 4 项声明（C-02 · P1）
**目标**：消 `preload.ts`↔`src/types.ts` 契约缺口。补 `controlWindow`/`getModuleState`/`setModuleState`/`platform` 四项（签名见原文件 preload 位置）。
**验收**：`vue-tsc --noEmit` exit 0；`preload.ts` 顶层键集合与 `ElectronAPI` 属性集差集为空（R2-4 自动化）。**风险**：极低（渲染层走 `ipc.ts` 封装，不直消费，须主动比对）。

### R1-4 · 版本元数据对齐（C-15 · P2）
**目标**：消 `electron-builder.yml` 与 `package.json` 版本分歧。**动作**：删 `buildVersion: 1.0.0` 一行（继承 `package.json`）。
**验收**：`npm run dist` 产物版本号 = `package.json` 的 `1.0.4`。

### R1-5 · 处置 `extensions/ae-profit/` 迁移残留（C-04 · P1）
**目标**：移除 1,532 行废弃代码，消"同名 id 占用"陷阱。**动作**：① 先做等价性确认（ae-profit 功能是否已被 `ui-plugins/ae-profit` 覆盖）；② 确认后 `git rm -r extensions/ae-profit/`；③ 缺失功能补到 UI 岛再删。
**验收**：`extensions/` 无 ae-profit；`vue-tsc`/`build`/`registry.generated.ts` 无条目；装 UI 岛可正常注册读写。**风险**：中（真实功能丢失风险，必须等价确认再删）。

---

## Phase 2 · 扩展模型与工程化护栏

### R2-1 · 消除 `esbuild` 隐式依赖（C-18 · P1）★ Vite 升级硬前置
**目标**：移除 `vite.config.ts` 对未声明 `esbuild` 的引用（Vite 8 改 Rolldown+Oxc，该依赖消失）。根因：`vite.config.ts:5 import {transformSync} from 'esbuild'`，仅由 vite@5 传递带入。
**方案 A（推荐）**：`modules.config.ts` → `modules.config.json`（AGENTS 本就要求纯字面量）；`vite.config.ts` 改 `JSON.parse(readFileSync(...))` 删 esbuild import。`方案 B`：显式声明 `esbuild`（不推荐，只是改隐式为显式）。
**验收**：① `grep -rn "from 'esbuild'" vite.config.ts` 无输出；② `npm run build` 的 `registry.generated.ts` 与改动前**逐字节一致**（最强验证）；③ `--list` 仍 4 项；④ `MODULE_IDS`/`MODULE_PROFILE` 生效。**回滚**：`git revert`。

### R2-2 · 补声明 `jszip`（C-19 · P2）
`package.json` 的 `devDependencies` 加 `jszip`（与 `exceljs` 同区间，避免两副本）。**验收**：`node -e "require('jszip')"` 成功、`publish-plugin.js` 可跑。

### R2-3 · 引入 ESLint + Prettier + 样式令牌规则（C-06 · P1）
**目标**：让"禁止硬编码色值"等红线变 lint 拦截。新增 `eslint.config.mjs`/`.prettierrc`/`.prettierignore`；`package.json` 加 `lint`/`lint:fix`/`format` 脚本。
**动作**：装 ESLint 9 flat config + `eslint-plugin-vue`；启用 `vue/no-restricted-class` 拦 `text-white`/`bg-black` 等（不支持则退化 grep 校验）；`AGENTS.md` §6 改"项目级 `npm run lint`"。
**验收**：① `npm run lint` 在 R1-2 后 exit 0；② 故意加 `text-white` 必报错；③ `vue-tsc` 不受影响。**风险**：中（存量告警先 `--fix` 能修的、其余降 warn 逐步收敛）。

### R2-4 · IPC 契约自动校验（C-02 复发防护 + D-10 · P1/P2）
**目标**：让"新增通道必须同步 `src/types.ts`"变自动拦截。新增 `scripts/check-ipc-contract.mjs` + `verify` 脚本。脚本求三集合差（preload 顶层键 / `ElectronAPI` 属性 / 主进程注册通道），差异输出中文报告并非 0 退出。豁免清单显式维护（`platform`/`mail-sync-event`/`updater-event`/`read-file`）。
**验收**：① R1-3 后 `npm run verify` exit 0；② 故意删 `types.ts` 属性必报错。**备注**：D-10「缺 IPC 通道契约表」的可执行替代品。

### R2-5 · 引入 vitest 覆盖 `src/lib/` 纯函数层（C-07 · P1）
**目标**：为 Excel 解析/模板生成核心逻辑建回归网。新增 `vitest.config.mts`/`tests/`/`package.json` 加 `test`/`test:watch`。
**动作**：阶段一覆盖 `excelParser.ts`/`fieldProcessor.ts`/`templateEngine`（已删，该项作废）；阶段二 `orderRowSplitter`/`aggregator`/`orderClassifier`/`styleMatcher`（部分已删）。**夹具自建**（`tests/fixtures/` 小型 Excel+期望，不依赖 `.gitignore` 的 `导出测试.xlsx`）。
**验收**：① `npm test` 全绿；② 故意改坏逻辑必失败。**风险**：低（纯函数无副作用）。

### R2-6 · 抽取 `electron/ipc-util.ts` 消除 5 份注册样板（C-12 · P2）
**目标**：消 5 份逐字节相同的 IPC 注册封装（`order-handlers`/`purchase-handlers` 的 `register()`；`ae`/`mail`/`shop-accounts` 的 `handle<T>()`）。抽统一封装（保留各域入参校验与 `{success,data|error}` 返回）。
**验收**：`tsc`/`build`/`mail:smoke` 通过；各域一个 IPC 调用返回结构不变。**风险**：中（须保留各域校验差异，不能统一成最宽松）。

### R2-7 · `extensions/` 目录语义分离（C-05 · P1）
**目标**：消"视图插件包/外置脚手架"混放歧义。**方案 A**：`_template`/`sk-hello` 移到 `scaffolds/`/`examples/`；**方案 B（已采用）**：目录不动，固化判定规则于 `AGENTS.md` §1.9+红线 23。
**验收**：`--list` 仍 4 项。**建议**：近期不新增插件可先 B，A 延后。

### R2-8 · 消除源码内嵌裸控制字节（C-21 · P3 · R2-3 新发现）
**来源**：`mail-cache.ts:50`/`mail-db.ts:788,862,867` 用裸 `0x00`/`0x1F` 作分隔符，使 BSD grep 静默跳过、编辑器可能改写。
**动作**：改转义 `\x00`/`\x1f`，语义等价。**验收**：`file` 非 binary、`grep` 命中、`mail:smoke` 通过、`tsc` 通过。

---

## Phase 3 · 依赖与结构升级

> **高风险阶段。前置：Phase 2 全完成。** 建议分支 `chore/dep-upgrade`，`npm run dist` 出包手工回归后合入。

### R3-1 · Vite 5 → 8（C-10 · P2，架构级）
**前置**：**R2-1 必须已完成**。**目标版本**：`vite@8.1`+（Node 20.19+/22.12+）。**改动**：`package.json`（`vite`/`@vitejs/plugin-vue`/`vitest`）；`vitest.config.mts` 若 API 变。
**动作**：读官方 Migration Guide（5→6→7→8）；升 `vite`+`plugin-vue` 兼容版；核 `base`/`outDir`/`alias`/`port` 语义；同步升 `vitest` 到 3.x/4.x。
**验收**：① `build` 通过；② `dist/renderer` 可加载（dev 切模块/⌘K/主题正常）；③ `--list` 4 项且裁包生效；④ UI 岛独立构建不受影响；⑤ 包体积无异常；⑥ **`npm test` 仍全绿**（R2-5 回归网是主安全网）。
**不在范围**：Tailwind 3→4（`--wb-*` 重度依赖，收益低）；Pinia 2→4（与 Electron 升级一起评）。

### R3-2 · Electron 33 → 43/44（C-10 · P2）
**根因**：Electron 33 已于 2025-04-29 EOL。**目标**：43 或 44（42 一个月后到期不作终点）。**跨度**：11 个大版本（Chromium M130→M152、Node 20.18→24.16）。
**改动**：`package.json`（`electron`/`@electron/rebuild`）。**动作**：逐个大版本读 Breaking Changes（重点 `BrowserWindow`/`webContents.send`/`contextBridge`/`net`/`protocol.handle`/`app.getPath`/`nativeImage`/`ses`）；`npm install` 后 `npm run rebuild` 重编 `better-sqlite3`；复验 `afterPack.js` 逻辑；确认 `electron-store@8` 动态 import 降级仍工作。
**验收**：① dev 可启；② build+dist 出包 macOS 不闪退；③ better-sqlite3 读写正常；④ `plugins:sandbox:smoke` 通过；⑤ `mail:smoke` 通过；⑥ 自动更新链匹配。**风险**：**高**（11 版累积 + ABI + 安全模型）。建议分两步升（先 38/40 验一轮再 43/44）。

### R3-3 · 拆分 `pluginManager.ts` 683 行函数（C-11 · P2）
**目标**：降最复杂文件维护成本（`createBuiltinPluginManager` 683 行混合多职责）。**改动**：按四职责抽内部函数/子文件（发现/激活/贡献注册/启停），**保持对外门面签名不变**（勿破 `AppShell.vue`/`PluginCenter.vue`/UI 岛桥；沙箱双端协议常量须同步，红线 20/21/22）。
**验收**：① `vue-tsc` exit 0；② `plugins:sandbox:smoke` 通过（boot→command→call→deactivate→token 拒绝全链）；③ ⌘K/侧栏/设置/启停行为不变；④ 最长函数 < 150 行。**风险**：中高（受保护内核，建议纯重构每次抽一职责）。

### R3-4 · 主进程渐进开启类型严格度（C-13 · P2）
**目标**：缩 `any` 267 处类型盲区（`tsconfig.electron.json` `strict:false`，渲染层已 `strict:true`）。**动作（渐进）**：先开 `noImplicitAny` 记量→可控则修，否则按目录收紧（新文件 `electron/strict/` 或 `// @ts-check`），只对新代码要求；明确记录宽松是有意决策写入 `AGENTS.md`。
**验收**：`tsc`/`build` 通过。**建议**：不阻塞其他任务，长期增量推进。

### R3-5 · 收敛组件内硬编码色值（C-09 · P2）
**目标**：主题令牌覆盖所有颜色源（`ProductLibraryView.vue:189-211` 18 处色卡 hex、`MailAccessDrawer.vue:305` box-shadow）。**动作**：色卡字典属**业务数据**（颜色名→色值），建议留独立常量注明"业务色卡不参与主题切换"；box-shadow 改令牌（`--wb-shadow` 或 `index.css`）。
**验收**：色卡抽文件后 Vue 不再现 hex；深浅主题阴影自然；R2-3 lint 不报。

---

## Phase 4 · 文档补齐（可与 Phase 2/3 并行）

### R4-1 · 处置 `PROJECT_OVERVIEW.md`（D-01 · P1）
问题：描述 2026-06 单体时期形态，含已删文件/改名类型/不存在 IPC 数，误导新人。**方案 A（已采用）**：删除，职责已由 `docs/baseline/PROJECT_BASELINE.md` 承接。**方案 B**：改写为演变史。**验收**：文档无已不存在路径/过期 IPC 数。

### R4-2 · 补写 `USER_GUIDE.md` 缺失章节（D-02/D-03 · P1）⛔ 未开始
动作：补店铺账号管家/订单归类/集中收件箱/自动更新章节；修正数据位置（`modules.<namespace>` 非平铺 `seller-kit/config.json`）、平台（arm64+x64 双架构）；补"打包与分发"章节。**验收**：用户可独立完成首次使用、无事实错误。

### R4-3 · 建立 `CHANGELOG.md` 与发布规范（D-09/C-16 · P1/P2）
动作：新建 Keep a Changelog 格式 CHANGELOG（从 v1.0.4 起正向记）；固化发布流程入 `README.md`；明确不再补打历史 tag。

### R4-4 · 标注 `PLUGIN_ARCHITECTURE.md` §4 为目标态（D-11 · P2）
动作：§4 顶部加标注"目标态设计，尚未采纳，当前为单仓 `src/core/plugin`"；复核其他"未来态"章节。

### R4-5 · 决定 `.gitignore` 入库策略（D-07 · P2）✅ 已定案（全部入库）
问题：架构文档不入库致克隆者见悬空引用。**已采用**：删 `AGENTS.md`/`docs/**` 全部忽略条目，仅保留 `.workbuddy/`/`.codebuddy/`；入库前已扫密钥/内网 IP/凭据无命中。

### R4-6 · 补 `CONTRIBUTING.md` 与 `LICENSE`（D-09 · P1）⛔ `LICENSE` 待定
动作：`LICENSE` 需先确认上游（`SayakABC/SellerKit` fork）授权类型再写；`CONTRIBUTING.md` 最小版（环境/分支/提交/`lint`/`test`/`verify` 门禁/PR 清单）。**验收**：新人可本地开发提交。

### R4-7 · 修正剩余文档事实性错误（D-12 · P2）
动作：① 已修 `PROFIT_TRACKER.md` §7/`REFACTOR_PLAN.md` 状态/`AGENTS.md` 三处滞后/4 份状态横幅；② 剩余：`PLUGIN_ARCHITECTURE.md` 其他未来态、基线"IPC 通道清单"改引 R2-4 脚本；③ 复核裸文件名引用改仓库根相对路径。

---

## 5. 明确不做的事（范围边界）

| 不做 | 原因 |
|---|---|
| **Tailwind 3 → 4** | v4 CSS-first 大改；重度依赖 `--wb-*` 令牌 + `@layer components`，成本高收益低 |
| **Pinia 2 → 4** | v4 ESM-only；与 Electron 升级一起评，单独无收益 |
| **`electron-store` 8 → 10+** | v8 ESM 问题已用动态 import + SimpleStore 降级解决（AGENTS §7 已知规避） |
| **补齐全部 `any`（约 288 处）** | 主进程宽松是有意决策；只做 R3-4 渐进收紧 |
| **给 UI 岛补自动化测试** | UI 岛独立分发/iframe 隔离/经 host 能力域，成本远高于 `src/lib/` 纯函数层 |
| **引入 CI（GitHub Actions）** | 无上游 CI 约定；建议 R2 完成后单独决策 |
| **重写 `PROJECT_OVERVIEW.md` 为演变史** | R4-1 提供方案 A（删除）避免维护第二份过期现状描述 |

---

## 6. 阶段验收（Definition of Done）

- **Phase 0**：工作区已提交、tag 指向起点；xlsx 已换源；Excel 导入/导出实测通过。
- **Phase 1**：`--list` 4 项；深色主题可读；`vue-tsc`/`tsc` exit 0；`build` 通过；`git status` 无 `extensions/ae-profit/`。
- **Phase 2**：无 `from 'esbuild'`；`registry.generated.ts` 逐字节一致；`lint`/`verify` exit 0（故意违规能拦）；`test` 全绿（故意改坏能失败）；`mail:smoke` 通过 ❗需真实 IMAP 凭据（`MAIL_USER`/`MAIL_PASS`），无凭据只打印"缺少凭据"退出。
- **Phase 3**：`vue-tsc`/`tsc` exit 0；`build`+`dist` 成功；**macOS 不闪退**（afterPack 回归）；`plugins:sandbox:smoke` 通过；`mail:smoke` ❗需凭据；**better-sqlite3 业务功能层面未验**（需 GUI）；`pluginManager.ts` 最长函数 ≤ 150 行（实测 79）。
- **Phase 4**：`README`/`CHANGELOG`/`CONTRIBUTING` ✅、`LICENSE` ❗待定；`verify:docs` 0 悬空；`USER_GUIDE` 覆盖全部当前模块 ❗未开始。

---

## 7. 风险登记册

| 风险 | 关联任务 | 缓解 |
|---|---|---|
| 删 `extensions/ae-profit/` 功能丢失 | R1-5 | 强制等价确认；疑虑则保留目录仅排除 include |
| Vite 8 Rolldown 构建异常 | R3-1 | R2-1 先行；分支；`registry.generated.ts` 逐字节比对 |
| Electron 跨 11 版累积破坏 | R3-2 | 分步升级；完整回归矩阵；保留回滚分支 |
| 拆分 `pluginManager` 破沙箱协议 | R3-3 | 纯重构不改行为；每次抽一职责；`plugins:sandbox:smoke` |
| ESLint 引入巨大存量 diff | R2-3 | 告警降 warn 收敛；`--fix` 单独 commit |
| `modules.config.ts`→JSON 改求值语义 | R2-1 | 以 `registry.generated.ts` 逐字节一致为硬验收 |
| `dist:select` 已产出残缺包 | R1-1 | 排查已发布 Release 资产，残缺需重出包 |

---

## 8. 进度跟踪

### Phase 0
- [x] `R0-0` 清理工作区 + 打起点 tag（语义中性 tag `remediation-baseline`，原 `v1.0.4` 已错位）
- [x] `R0-1` xlsx 换源消 CVE

### Phase 1
- [x] `R1-1` 修 `dist:select` 扫描根 ★
- [x] `R1-2` 深色主题 8 处 `text-white`
- [x] `R1-3` 补 `ElectronAPI` 4 项声明
- [x] `R1-4` `buildVersion` 与 `version` 对齐
- [x] `R1-5` 处置 `extensions/ae-profit/`

### Phase 2
- [x] `R2-1` 消 esbuild 隐式依赖 ★
- [x] `R2-2` 补 jszip
- [x] `R2-3` ESLint+Prettier+样式令牌
- [x] `R2-4` IPC 契约自动校验
- [x] `R2-5` vitest 覆盖 `src/lib/`（131 用例覆盖 7 模块；无 CI，组件/store/主进程/沙箱未覆盖）
- [x] `R2-6` 抽 `electron/ipc-util.ts`（附带修校验脚本按文件耦合）
- [x] `R2-7` `extensions/` 语义分离（方案 B；`_template`/`sk-hello` 后由 `PLUGIN_TRIAGE_PLAN` T4 迁 `scripts/templates/`）
- [x] `R2-8` 消裸控制字节（7 个裸字节改转义）

### Phase 3
- [x] `R3-1` Vite 5→8（vite ^8.3.0/plugin-vue ^6.0.9/vitest ^4.1.11；registry 逐字节一致；npm Arborist 崩溃用 --legacy-peer-deps 绕过）
- [x] `R3-2` Electron 33→43/44（node-abi 不识 ABI 149，scoped overrides 收窄 ^4.35.0 解决；运行时自检 44.4.1/node24.21.0/abi149）
- [x] `R3-3` 拆分 `pluginManager.ts`（683→6 职责文件+门面；最长 79 行；沙箱冒烟 12 项）
- [x] `R3-4` 主进程渐进严格类型（noImplicitAny 开；61 错→2 处 typed require 断言+9 处修复；strict 仍 false，写入 AGENTS §6.0.1）
- [x] `R3-5` 收敛硬编码色值（色卡抽 `lib/colorSwatch.ts`+7 用例；新增 `--wb-shadow`；AGENTS §1.6 沉淀判定表）

### Phase 4
- [x] `R4-1` 处置 `PROJECT_OVERVIEW.md`（方案 A 删除；5 处引用改写"已删"）
- [ ] `R4-2` 补写 `USER_GUIDE.md`（未开始）
- [x] `R4-3` `CHANGELOG.md` + 发布规范
- [x] `R4-4` 标注 `PLUGIN_ARCHITECTURE.md` §4 目标态
- [x] `R4-5` `.gitignore` 入库策略定案（全部入库）
- [~] `R4-6` `CONTRIBUTING.md` + `LICENSE`（`LICENSE` 待用户选定协议）
- [x] `R4-7` 修正文档事实错误（新增 `scripts/check-doc-links.mjs`+`verify:docs`，20 md/186 代码文件/439 引用→悬空 0）

---

## 附录 · 任务 ↔ 发现项对照

| 发现 | 级别 | 任务 | Phase |
|---|---|---|---|
| C-01 | 🔴 P0 | R0-1 | 0 |
| C-20 | 🟠 P1 | R1-1 | 1 |
| C-03 | 🟠 P1 | R1-2 | 1 |
| C-02 | 🟠 P1 | R1-3 + R2-4 | 1/2 |
| C-04 | 🟠 P1 | R1-5 | 1 |
| C-15 | 🟡 P2 | R1-4 | 1 |
| C-18 | 🟠 P1 | R2-1 | 2 |
| C-19 | 🟡 P2 | R2-2 | 2 |
| C-06 | 🟠 P1 | R2-3 | 2 |
| C-07 | 🟠 P1 | R2-5 | 2 |
| C-12 | 🟡 P2 | R2-6 | 2 |
| C-05 | 🟠 P1 | R2-7 | 2 |
| C-10 | 🟡 P2 | R3-1 + R3-2 | 3 |
| C-11 | 🟡 P2 | R3-3 | 3 |
| C-13 | 🟡 P2 | R3-4 | 3 |
| C-09 | 🟡 P2 | R3-5 | 3 |
| C-14 | 🟡 P2 | R3-4（部分） | 3 |
| C-16 | 🟡 P2 | R4-3 | 4 |
| C-17 | 🟡 P2 | ✅ 已修（AGENTS §6） | — |
| D-01 | 🟠 P1 | R4-1 | 4 |
| D-02/D-03 | 🟠 P1 | R4-2 | 4 |
| D-04/05/06/08 | 🟡 P2 | ✅ 已修（REFACTOR_PLAN/PROFIT_TRACKER/AGENTS） | — |
| D-07 | 🟡 P2 | R4-5 | 4 |
| D-09 | 🟠 P1 | R4-3 + R4-6 | 4 |
| D-10 | 🟡 P2 | R2-4 | 2 |
| D-11 | 🟡 P2 | R4-4 | 4 |
| D-12 | 🟡 P2 | R4-7 | 4 |

> 27 个任务中 25 个已完成，`R4-2` 未开始、`R4-6` 部分（`LICENSE` 待定）。
