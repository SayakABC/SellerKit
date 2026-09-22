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
  `electron/ipc-util.ts` 的 IPC 注册契约、款色色卡字典，共 152 用例；配套自建 Excel 夹具。
- **ESLint + Prettier**：flat config，门禁标准为 **error 数 = 0**；`vue/no-restricted-class`
  以 error 级拦截调色板类名与任意值色号。
- `electron/ipc-util.ts`：主进程 IPC 注册封装单一事实源（`register` / `handle` 双契约）。
- `--wb-shadow` 主题令牌（抽屉/浮层投影色，浅色与深色各一套）。
- `docs/baseline/`（项目基线快照 + 重构计划）、`docs/reviews/`（代码审查报告）、
  `docs/plans/`（分阶段整改计划）三类文档建立并纳入版本管理。
- `CONTRIBUTING.md`、`CHANGELOG.md`。

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

### Changed · 重构

- **`pluginManager.ts` 683 行工厂函数拆分为 6 个职责文件**（`managerContext` / `managerDiscover` /
  `managerActivate` / `managerEnabled` / `managerSettings` / `managerOverview`），
  `pluginManager.ts` 退化为纯组合门面；最长函数 683 → 79 行，对外签名逐字不变。
- **主进程开启 `noImplicitAny`**（`strict` 仍为 `false`，属渐进收紧的中间态，策略见 `AGENTS.md` §6.0.1）：
  清零 61 处隐式 `any`。
- **款色色卡字典**从 `ProductLibraryView.vue` 抽到 `extensions/order-insight/src/lib/colorSwatch.ts`。
  该批色值为**业务数据**（款色 → 现实颜色），**刻意不令牌化**——否则深色主题下"白色"款色会变成深灰块。

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
