# Changelog

本项目的所有值得注意的变更都记录在此文件。

格式遵循 [Keep a Changelog](https://keepachangelog.com/zh-CN/1.1.0/)，
版本号遵循 [语义化版本](https://semver.org/lang/zh-CN/)。

> **关于历史条目（重要）**：`v1.0.0` / `v1.0.1` / `v1.0.2` / `v1.0.4` 四个 tag **都指向同一个
> commit `9ccb73d`**（且缺 `v1.0.3`），因此它们不代表真实的发布节点。本文档中 1.0.x 段落
> 标注为**「补录」**，内容依据 `git log` 重建；**不再补打历史 tag**——错位的 tag 已是既成事实，
> 补打只会制造两套互相矛盾的版本坐标。真实版本历史的起点是下方 `[Unreleased]` 之后的第一个
> 正式发布（见 §发布流程）。

## [Unreleased]

### Changed · 依赖大版本升级（工程化整改 R3）

- **Vite 5.4 → 8.3**：构建管线由 Rollup + esbuild 换为 **Rolldown + Oxc**。
  `vite.config.ts` 与 `vitest.config.ts` 配置零改动；`src/registry.generated.ts` 与升级前逐字节一致。
  配套：`@vitejs/plugin-vue` ^5.0.4 → ^6.0.9、`vitest` ^2.1.9 → ^4.1.11（保守取 4.x 维护线而非 5.x）。
  前置条件：`modules.config.ts` 已先改为纯 JSON（消除对 esbuild `transformSync` 的直接依赖）。
- **Electron 33.4.11 → 44.4.1**：跨 11 个大版本。内置 Node 20.18 → 24.21、Chromium 130 → 152、
  原生模块 ABI 130 → 149。业务代码零改动（所用 API 面不在破坏性变更清单内）。
  原生模块重建链路修复：新增显式依赖 `@electron/rebuild@^4.2.0`，并以 scoped `overrides`
  将其依赖的 `node-abi` 收窄到 `^4.35.0`（旧版无法识别 ABI 149）。

### Added

- **UI 岛设置贡献（宿主设置中心承载外置插件设置）**：岛 manifest 新增 `settings: { entry, displayName?, icon?, order? }`，
  声明后宿主设置中心自动出现 `<pluginId>:settings` 分类，内容由新增的 `IslandSettingsPanel.vue`
  以 `sk-plugin://<id>/<entry>` iframe 岛承载（复用 `__sk` 受控桥，权限门与审计口径不变）；
  分类随岛安装/卸载/停用即时增减（`managerSettings.getIslandSettingCategories()`）。
  岛侧跳转复用既有桥能力 `sk.host.ui.openSettings(category)`（`ui` 为默认放行的轻量能力，
  不写入 `capabilities`），由宿主内部 dispatch `open-settings` 打开并定位分类。
  首个接入方：`shop-accounts` 1.4.0（岛内「设置」页签迁出，主视图保留跳转入口）。
  发布脚本 `scripts/publish-plugin.js` 强校验 `settings.entry`（相对路径 / `.html` / 文件存在 / 与 `entry` 同打包子树）。
- **IPC 契约自动校验**（`npm run verify`）：从源码动态提取 preload 暴露键、`src/types.ts` 声明、
  主进程注册通道三份清单求差，把"新增通道忘改声明"的复发路径封死。
- **单元测试网**（`npm test`，vitest）：覆盖 `src/lib/` 全部 7 个纯函数模块、
  `electron/ipc-util.ts` 的 IPC 注册契约、款色色卡字典，共 207 用例；配套自建 Excel 夹具。
  另加**插件体系静态守卫**：`pluginManifest`（manifest × 权限门口径）、`pluginSettingsIsland`、
  `pluginTriage`（红线 23：预设不得占用岛 id；岛的 db 调用必须全在 manifest 声明内）、
  `uiIslandThemeTokens`（宿主令牌 × 注入清单）、`payloadBudget`（桥层载荷体积预算）。
- **ESLint + Prettier**：flat config，门禁标准为 **error 数 = 0**；`vue/no-restricted-class`
  以 error 级拦截调色板类名与任意值色号。
- `electron/ipc-util.ts`：主进程 IPC 注册封装单一事实源（`register` / `handle` 双契约）。
- `--wb-shadow` 主题令牌（抽屉/浮层投影色，浅色与深色各一套）。
- `docs/baseline/`（项目基线快照 + 重构计划）、`docs/reviews/`（代码审查报告）、
  `docs/plans/`（分阶段整改计划）三类文档建立并纳入版本管理。
- `CONTRIBUTING.md`、`CHANGELOG.md`。

### Changed · 业务模块全部下记为市场 UI 岛

内建业务模块至此**清零**：三个模块依次改由市场分发，宿主不再随包编译它们的视图。

- **`shop-accounts` → `ui-plugins/shop-accounts` 1.4.3**、**`order-insight` → 1.2.0**、
  **`excel-copy` → 1.0.0**（TV模版）。`modules.config.json` 的 `minimal` / `standard` / `pro`
  与 `enabledModules` 已移除三者 id，`src/registry.generated.ts` 现在只剩 `quick-note`。
- **`extensions/` 侧当前无实例**：三个目录保留为源码留档，不进构建。
- **配置零迁移**：岛的存储命名空间与内建同源（`modules.<id>`），老用户的模板 / 规则 / 显示列配置自动继承。
- **能力边界由 CSP 决定，不是偏好**：岛所在 iframe 的 CSP 为 `script-src 'self'`（无 `unsafe-eval`），
  因此 Excel 解析与 `jsExpression` 规则求值**必须**留在宿主，岛只做「收集参数 → 调宿主 op → 渲染」。
  副作用是两侧共用 `src/lib/excelParser.ts` / `fieldProcessor.ts`，行为口径不会漂。
- 保留 `quick-note` 为内建模块（`src/modules/` 因此不悬空，「内建模块」这条路径仍有活样例）。

### Fixed

- **深色主题「白字白底」**：8 处硬编码 `text-white` 改用 `--wb-primary-contrast` 令牌。
- **`dist:select` 会静默产出残缺安装包**：模块扫描只认 `src/modules`，漏掉 `extensions/<id>/src`
  的插件包；改为双根扫描并以 `scripts/lib/module-roots.cjs` 作为唯一事实源。
- **`xlsx` 换源**至 SheetJS 官方 CDN 版本，消除 CVE-2023-30533 / CVE-2024-22363。
- **主进程 `throw null` 会让 IPC 变成 reject**：注册封装的 `err.message` 改为 `err?.message`，
  避免 catch 块自身抛 TypeError（渲染层会拿到未处理拒绝而不是约定的 `{ success: false }`）。
- **邮件模块源码内嵌裸控制字节**（7 个 `0x00` / `0x1f`）改为转义写法——原文件被 `file`/`grep`
  判定为二进制，内容无法检索，且编辑器可能静默改写这些不可见字节。
- **`ShopAccountUpsertInput` 缺 `mailAuthPwd`**：敏感字段白名单含该键、写入逻辑也用它，
  但输入类型没声明（"运行时收得下、类型说不收"）。
- **`simpleParser` 的 `as any` 误匹配到回调重载**，返回值被推断成 `void`；移除该 cast 后
  恢复 `Promise<ParsedMail>`，字段访问重新受类型保护。
- `PROJECT_OVERVIEW.md` 严重过期（描述已删除的文件与过期的 IPC 通道数）→ 已删除，
  现状描述职责由 `docs/baseline/PROJECT_BASELINE.md` 承接。
- `UiIslandView.vue` 未连接态圆点裸 hex 改用主题令牌（深色下不再偏亮）。

### Fixed · 宿主代码复查（2026-09-22）

复查结论见 `docs/reviews/HOST_REVIEW_2026-09-22.md`（六道门禁全绿，但 11 项问题**全部落在门禁盲区**）。

- **已下记模块仍被当作打包候选**：`extensions/` 留档目录里仍有 `src/meta.ts`，于是
  「有 meta.ts 即模块」的枚举把 `excel-copy` / `order-insight` 重新算成可打包模块 ——
  勾选即占住岛 id（`registerUiIsland` 见 `records.has(id)` 静默 return → 从市场装的岛永远没有侧栏入口，
  AGENTS 红线 23）。现由 `scripts/lib/module-roots.cjs` 的 `isUndocked()`（判据：`ui-plugins/<id>` 存在）
  在**枚举与构建两处**硬拦：选择器把这类目录单列为「已下记为市场 UI 岛」不入候选，
  `vite.config.ts` 对 `MODULE_IDS` 里出现的已下记 id **报错并忽略**。
- **`db[excel-copy]` 实为「全盘读 + 任意文件覆写」**：`read-file` / `save-template` /
  `check-file-exists` 原先接受任意绝对路径（写还无长度上限），而它们的唯一调用方就是岛的 `db` 能力面。
  现收敛为**用户已选文件白名单**（`electron/user-file-allowlist.ts`）：只放行宿主内置模板路径，
  以及用户经 `select-excel` / `select-template` 对话框真实选过、跨会话持久化的文件；
  存在性探测对未授权路径返回 `false`（与"文件不存在"不可区分，不泄露信息），写模板另加 2MB 上限。
  同法收紧 `order-read-local-image` —— 其路径实际来自**用户导入的 Excel 单元格内容**，
  原注释「用户在导入对话框主动选择」与实现不符。
- **管理面板的能力展示不足以支撑"知情同意"**：原先只显示 `db` 这样的能力 id 标签，用户看不出
  它可能意味着"读写你磁盘上的任意文件"。`PluginOverview` 新增 `capabilityDetails`，
  把域 / 动作 / 命名空间 / 地址白名单展开显示。
- **导航与拖放防护漏掉"保留 preload"的那条路径**：`will-navigate` 原先只拦 `.xlsx/.xls`，
  把任意本地 `.html` 拖进主窗口即会导航过去，而 preload 绑定在 webContents 上、不随 URL 变化
  → 该第三方页面直接拿到 `window.electronAPI`。现收敛为「只放行应用自身 URL」白名单，
  并加 `setWindowOpenHandler` 拒绝开新窗；渲染层加 document 级拖放兜底
  （仅拦文件拖放，保留文本拖入输入框的默认行为）。
- **桥层载荷无体积上限**：`__sk.call` 原先只校验参数个数，而宿主侧「50000 记录 × 256 字段 ×
  20000 字符」三个独立上限组合起来约 250GB。现加预算门禁（`payloadBudget.ts`，默认 64MB，
  用**带早退**的估算实现 —— 否则"海量小值"会把门禁自身变成新的耗时点），
  超限直接回「桥拒绝超大载荷」，不让载荷进入下游的消毒复制与规则引擎遍历。
- **`.gitignore` 的 `dist/` 通配吞掉了两个岛的源码**：`excel-copy` / `order-insight` 是**无构建步骤**的岛
  （无 `package.json` / `vite.config`，`manifest.entry` 指向 `./dist/index.html`），源码直接写在 `dist/` 下。
  原规则使 `git add -A` 只收录 `manifest.json` + `README.md` —— 仓库里存着一个 entry 指向不存在文件的坏岛
  （`order-insight` 此前已如此，且其 1.2.0 是发布过的版本）。
  现加定向例外放行这两个岛的 `dist/`；有 `src/` 与构建脚本的岛（`ae-profit` / `shop-accounts` / `sk-ui-starter`）保持忽略。
- **`AGENTS.md` 多处陈述已被下记推翻**（§1.5 的 `excel` 分类、§1.8 的"已外挂为视图插件包"、
  §1.9 的当前实例表、§6.3 的 129 个通道），§5 更在示范 `MODULE_IDS=excel-copy,quick-note` —— 正是红线 23 的违规操作。
  现 §1.5 / §1.8 / §1.9 改为「规则 + 指针」（现状由 `docs/baseline/PROJECT_BASELINE.md` 单点维护）、
  通道数改为 137、示例改为 `MODULE_IDS=quick-note`，并补上「已下记 id 不得用于打包」的红线说明。
- **4 处滞后注释与文档口径修正**：`vite.config.ts` 的根分布说明；`shop-accounts-handlers.ts` /
  `shop-accounts-db.ts` 仍称 `extensions/shop-accounts`（该目录 2026-09-16 已删）；
  `externalManifest.ts` 的 `activationEvents` 注释称支持 `onCommand:xxx`（实现会静默丢弃）；
  `PLUGIN_DEVELOPMENT.md` 的 `secrets` 需声明 `domains`（该能力无域粒度，声明无效）、
  `engines.sellerkit` 的兼容性语义（实际只查"是非空字符串"，不做范围比对）、
  以及一处把合法能力 id 写成「四项」的陈旧表述（实为七项）。
  被静默忽略的声明（`onCommand:*`、`secrets.domains`）一律改为**明确告警**。
- **款色色卡迁出留档目录**：从 `extensions/order-insight/src/lib/` 迁至 `src/lib/colorSwatch.ts`。
  它是纯函数字典（§1.2 目录语义归 `src/lib/`），而 `tests/colorSwatch.spec.ts` 直接从留档目录 import，
  使"删留档目录"会连带打挂测试与 `vue-tsc`（且报错不提示原因）。迁移后留档目录才真的不进任何门禁链路。

### Changed · 重构

- **`pluginManager.ts` 683 行工厂函数拆分为 6 个职责文件**（`managerContext` / `managerDiscover` /
  `managerActivate` / `managerEnabled` / `managerSettings` / `managerOverview`），
  `pluginManager.ts` 退化为纯组合门面；最长函数 683 → 79 行，对外签名逐字不变。
- **主进程开启 `noImplicitAny`**（`strict` 仍为 `false`，属渐进收紧的中间态，策略见 `AGENTS.md` §6.0.1）：
  清零 61 处隐式 `any`。
- **款色色卡字典**从 `ProductLibraryView.vue` 抽到独立文件 `src/lib/colorSwatch.ts`。
  该批色值为**业务数据**（款色 → 现实颜色），**刻意不令牌化**——否则深色主题下"白色"款色会变成深灰块。
  （抽取时落在 `extensions/order-insight/src/lib/`，2026-09-22 迁入 `src/lib/`：该目录已下记为留档，
  测试挂在留档目录下会让"删留档"连带打挂门禁。）

### Removed

- `extensions/ae-profit` 迁移残留（1,541 行，与命名 id 冲突的旧实现）。
- `buildVersion` 配置：产物版本元数据统一继承 `package.json`，避免 `Info.plist` 版本号与
  应用版本不一致。
- `PROJECT_OVERVIEW.md`（见 Fixed 段）。

## [1.0.4] — 2026-09-04（补录）

> tag `v1.0.4` 指向 `9ccb73d`。以下依据 `git log` 重建。

### Added

- **集中收件箱**：IMAP 收取、全文索引（FTS）、附件缓存与本机解密。
- **店铺账号管家**：多平台店铺账号的加密存储与批量维护。
- **速卖通利润追踪**：M0 闭环 + 存储层通用化（原 `ae-profit`，后 UI 岛化）。
- **UI 岛插件运行时**与宿主 ↔ 岛桥；插件市场目录浏览与安装；基于 `electron-updater` 的自动更新。
- 外置插件开发指南 `PLUGIN_DEVELOPMENT.md`。

### Changed

- 业务模块迁移为 `extensions/<id>` 随宿主分发的插件包，支持运行时启停；
  修复 Tailwind 扫描范围、启停后侧栏刷新等回归。

## [1.0.0] — 2026-09-03（补录）

> 首个提交为 `4141609`；`v1.0.0` ~ `v1.0.2` 三个 tag 均错位指向 `9ccb73d`。

### Added

- 初始版本：**订单洞察**（Excel 导入、订单归类识别、预览与复制）与
  **Excel 模板复制**（模板引擎、字段规则、显示列配置）两个业务的 Electron 桌面工具。
- 三层进程架构（主进程 / preload / 渲染进程）、模块化外壳（`AppShell`）、
  主题令牌体系、IPC 适配的网络请求链路。

---

## 发布流程

1. **确定版本号**：按语义化版本改 `package.json` 的 `version`。
2. **更新本文件**：把 `[Unreleased]` 段落改名为 `[<新版本>] - <YYYY-MM-DD>`，
   并按 Added / Changed / Fixed / Removed 归位；随后新建空的 `[Unreleased]` 段落。
3. **提交**：`git add -A && git commit -m "chore(release): v<新版本>"`。
4. **出包**：`npm run dist`（macOS）/ `npm run dist:win`（Windows）——
   `electron-builder` 会读 `package.json` 的版本号并自动打 tag、上传 Release 资产。
   国内网络下如需加速 Electron 二进制下载：
   `ELECTRON_MIRROR=https://npmmirror.com/mirrors/electron/ npm run dist`。
5. **核对 Release**：确认 tag 指向发布 commit、资产齐全（.dmg / .zip / .exe / `latest.yml` 等），
   且 `latest.yml` 中的版本号与新 tag 一致（自动更新依赖它）。
6. **不要为历史版本补打 tag**（见文首说明）。

### 发布前检查清单

- [ ] `npm run lint` → 0 error
- [ ] `npm run verify` → IPC 契约一致
- [ ] `npm test` → 全绿
- [ ] `npx vue-tsc --noEmit` 与 `npx tsc -p tsconfig.electron.json --noEmit` → exit 0
- [ ] `npm run build` → 通过
- [ ] `npm run plugins:sandbox:smoke` → 通过
- [ ] 手工回归：启动 / 导入 Excel / 预览 / 复制 / 设置页 / 主题切换 / 插件启停 / ⌘K /
      UI 岛加载 / 邮件同步 / 店铺账号
