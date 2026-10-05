# SellerKit - 项目基线（Architecture Baseline）与编码规则

AI 编码助手和开发者在修改 SellerKit 项目时必须遵循本文件。本文档是**基线**：以当前代码实际状态为准，任何新增功能都需符合本文档描述的架构模式与编码规则。

---

## 0. 跨工具协作契约（WorkBuddy / Qoder / Hermes 等一律适用）

本项目会被多个 AI 工具交替打开。**共享层只有三处**，工具自己的记忆目录不是共享层：

| 层   | 位置                                                                            | 入库 | 说明                                                   |
| ---- | ------------------------------------------------------------------------------- | ---- | ------------------------------------------------------ |
| 规则 | `AGENTS.md`（本文件）、`docs/**`、`CHANGELOG.md`                                | ✅   | 任何工具、任何人都读得到 —— **唯一权威**               |
| 结论 | `docs/notes/`                                                                   | ✅   | "下次开工还得记得"的结论（命名 / 索引规则见其 README） |
| 草稿 | `.workbuddy/memory/`、`~/.qoder/memory/`、`~/.hermes/memory_store.db`（SQLite） | ❌   | 工具私有，**换机器即失效**                             |

**读（开工前）**：本文件 → `docs/README.md`（文档地图）→ 与本次改动相关的 `docs/**` 与 `docs/notes/`。

**写（收工前两件事，缺一不可）**：

1. 变更史写 `CHANGELOG.md` 的 `[Unreleased]` 段 —— "做了什么"；
2. 跨工具的结论写 `docs/notes/YYYY-MM-DD-<slug>.md`，并在 `docs/notes/README.md` 索引表登记一行 —— "以后要记住什么"。

**禁止**：把结论**只**写进工具私有目录 —— 别的工具看不到、`git clone` 带不走，写了等于没写。
私有目录可以继续记草稿（更碎、更流水），但凡是"下次开工还得记得"的，必须落进上面两处。

> 根目录 `AGENTS.local.md`（**不入库**）是软链 → `.workbuddy/memory/MEMORY.md`，存在的唯一原因是让会读它的工具
> （Qoder 原生读 `AGENTS.md` / `AGENTS.local.md` / `.qoder/rules/*.md`）看到 WorkBuddy 的笔记。
> 它是**单向只读桥，不是权威** —— 权威始终是上表的前两行。换机器后该软链必然悬空，属已知。

**并发提醒**：同一工作区同一时刻只让**一个**工具写（其余只读）。两个工具同时改同一批文件会互相覆盖，
git 不会替你合并，也没有任何工具能感知另一个工具的存在。

> 现状与缺口取证见 `docs/notes/2026-09-30-cross-tool-context-sharing.md`。

---

## 1. 架构基线（不可违背）

### 1.1 进程三层边界

```
┌──────────────────────────────────────────────────────────────┐
│ 主进程 (electron/main.ts)      CommonJS (require)            │
│ 职责: 窗口管理 / 文件 I/O / 剪贴板 / 网络请求(net) / electron-store 持久化 / IPC│
│ 禁止: ESM import / DOM / Vue 组件                             │
├──────────────────────────────────────────────────────────────┤
│ preload.ts (electron/preload.ts)   contextBridge              │
│ 职责: 将有限 IPC API 暴露为 window.electronAPI               │
│ 禁止: 暴露 Node 全部能力 / 引入渲染进程代码                    │
├──────────────────────────────────────────────────────────────┤
│ 渲染进程 (src/)               ES Module + Vite               │
│ 职责: UI / 状态 / Excel 解析 / 模板引擎 / 网络请求(axios) / 业务逻辑│
│ 禁止: require / fs / path / 直接文件系统访问                   │
└──────────────────────────────────────────────────────────────┘
```

- 渲染进程一切文件/系统能力必须经 `src/core/services/ipc.ts` 封装后再用（组件**不得直接调** `window.electronAPI`）。
- IPC 通道命名 kebab-case；preload 中每通道一个方法；**新增通道要同步三处**：
  ① `electron/preload.ts` 实现 ② `src/types.ts` 的 `ElectronAPI`（**`npm run verify` 拦截**，见 §6.2）
  ③ `src/core/services/ipc.ts` 的 `ElectronApi`（渲染层消费面；**verify 不看这个文件**，只有 `npx vue-tsc --noEmit` 能拦）。
  漏掉 ③ 的典型症状：宿主 `src/core/plugin/host.ts` 的 `DB_OPS` 报 `Property 'xxx' does not exist on type 'ElectronApi'`
  —— 运行时可能照常（preload 真有），但类型门禁红，且下一个读该文件的人会误判"能力没实现"（2026-09-29 的 `shop-product-*` 就是漏了 ③）。
- 主进程注册通道**统一走 `electron/ipc-util.ts`** 的 `register` / `handle`（见 §6.2），**禁止**在新 handler 文件里再抄一份注册封装。
- 网络请求链路：渲染层 axios（IPC adapter）→ `net-request` IPC → 主进程 `electron/http-client.ts`（Electron `net`）→ 真实 HTTP（详见 §1.7）。

### 1.2 渲染进程分层（src/）

```
src/
├── core/                       # 平台核心（禁止业务逻辑）
│   ├── AppShell.vue            # 工作台外壳：TitleBar+侧边栏+工作区+设置/命令/Toast
│   ├── components/             # TitleBar / SettingsModal / CommandPalette / ToastHost / PluginCenter / UiIslandView / IslandSettingsPanel / ConfirmDialog
│   ├── services/               # ipc / storage / theme / toast / clipboard / dialog / excel / shell（外壳级全局事件：切模块 / 开设置 / 重载岛）
│   ├── network/                # 统一网络请求（request: axios+IPC adapter / token / types）
│   ├── settings/               # **宿主自有**设置面板贡献（src/core/settings/panels.ts；键 `core`）
│   ├── plugin/                 # 运行时插件内核：pluginManager / sandbox / gatedHost / security / sdk / contributions / lifecycle / externalManifest / externalLoader / marketClient / uiBridgeHost / di / host / types / index
│   ├── ai/                     # OpenAI 兼容 AI 客户端（types / openaiCompatible / index）
│   ├── layout/                 # SplitPane.vue（分栏布局）
│   └── types.ts                # ModuleMeta / ModuleDefinition / ModuleCommand 等
├── modules/<module-id>/        # 内建业务模块（快速迭代用；当前 today / quick-note / order-cost（显示名「算钱」）/ picking）
│   ├── meta.ts                 # 模块元信息（必须）
│   ├── index.ts                # ModuleDefinition（必须）
│   ├── store.ts                # Pinia store（setup 语法）
│   ├── <Xxx>View.vue           # 模块主视图
│   └── components/             # 模块内组件
├── lib/                        # 纯函数工具（无副作用）：excelParser / templateEngine / fieldProcessor / styleMatcher / orderClassifier / orderRowSplitter / orderImportRow / aggregator
extensions/<id>/                # 随宿主分发视图插件包（Phase 5）★ 与 ui-plugins/ 语义不同，见 §1.9
                                # ⚠️ 当前**目录不存在**：最后两个留档源码包已于 2026-09-30（C3）删除，机制保留
│   └── src/                    # = 原业务模块代码（meta/index/store/view/components…自包含）
ui-plugins/<id>/                # 市场分发 UI 岛（kind: ui，iframe + window.__sk 桥），见 §1.8 / §1.9
├── styles/index.css            # 全局样式 + 设计令牌（--wb-*）
├── types.ts                    # 业务共享类型 + ElectronAPI 接口
├── registry.generated.ts       # ⚠️ 自动生成，禁止手改
├── env.d.ts
├── main.ts / App.vue
```

### 1.3 模块化插件体系（核心机制）

模块启停由构建期裁剪控制，链路：

```
modules.config.json ──► vite.config.ts ──► src/registry.generated.ts ──► AppShell.vue
(纯 JSON 字面量)        (JSON.parse 读取)    (自动生成 enabledModuleMetas + moduleViewLoaders)
```

关键约束：

- **`src/registry.generated.ts` 是 AUTO-GENERATED，严禁手改**；任何修改会在下次 `npm run dev/build` 被覆盖。
- `vite.config.ts` 直接 `JSON.parse` 读取 `modules.config.json`，**不做任何转译**；因此 config 必须是**纯字面量结构**（对象/数组/字符串），禁止复杂逻辑——JSON 格式本身即强制了这一点。**不得改回 `.ts`/`.js`**：那需要引入转译器，会重新引入构建期对未声明依赖（历史上是 `esbuild`）的隐式依赖。
- **双根源码解析（Phase 5）**：规则唯一权威在 `scripts/lib/module-roots.cjs`（`vite.config.ts` 与 `scripts/select-build.js` 共用），按 id 探测 `src/modules/<id>`（优先）或 `extensions/<id>/src`，判定标志为「目录下存在 `meta.ts` 入口」；meta/index 入口统一进 registry；扩展插件包另生成 `pluginPackageInfos`（manifest 元数据）与 `settingsPanelLoaders`（设置面板入口 `settings.ts`）。新增/外挂化请参照 §1.8「随宿主分发视图插件」。
- 模块视图通过 `moduleViewLoaders` 动态 `import()`，仅激活时才拉取；未启用模块不进入 bundle。
- 打包范围选择优先级（`vite.config.ts`）：`MODULE_IDS`（逗号分隔自定义清单）> `MODULE_PROFILE`（预设名，如 minimal/standard/pro）> 文件内 `profile` 字段 > `enabledModules` 兜底。未选中的模块代码不进 bundle，侧边栏菜单与 ⌘K 命令均不出现（侧边栏由 `enabledModuleMetas` 渲染）。
- 交互式打包：`npm run dist:select` / `build:select`（`scripts/select-build.js`，方向键+空格勾选模块，记住上次选择于 `node_modules/.cache`），勾选结果经 `MODULE_IDS` 传给构建。

`ModuleMeta`（`src/core/types.ts`）：

```typescript
{ id: string; name: string; icon?: 'table'|'tool'|'box'|'chart'|'sparkles'|'note'; order?: number }
```

`ModuleDefinition`：

```typescript
{ meta: ModuleMeta; view: Component; commands?: ModuleCommand[]; activate?(): void|Promise<void>; deactivate?(): void|Promise<void> }
```

#### 新增一个模块（SOP）

1. 建目录 `src/modules/<kebab-id>/`
2. 写 `meta.ts`（id 与目录名一致、kebab-case；name 为用户可见名；icon 从图标白名单取）
3. 写 `index.ts`（导出 `ModuleDefinition`；可暴露 `commands` 进 ⌘K 命令面板；`deactivate` 释放弹窗等资源）
4. 写主视图 + store（若需状态）
5. 在 `modules.config.json` 的 `enabledModules` / 相关 profile 中登记 id（确认纳入哪些打包预设）
6. 重启 `npm run dev` 自动注册；验证侧边栏出现、⌘K 可切换

### 1.4 持久化基线（命名空间隔离）

- 统一经 `src/core/services/storage.ts` 的 `useModuleStorage<T>(namespaceId)`，返回 `{ load, save, scheduleSave, clear }`。
- 数据落在 electron-store 的 `modules.<namespaceId>` key 下，**模块之间互不污染**。
- 已有命名空间：`app-shell`（外壳状态：lastActiveModuleId / collapsed）、`excel-copy`（业务状态）、`order-insight`（⚠️ **键名沿用已下架的岛 id，系有意保留**：引擎配置 + 列映射是已落盘的用户数据键，改名 = 用户配好的 Key 静默消失；现由宿主「设置 › 识别」与内建「今天 › 归类核对」读写）、`shop-accounts`（店铺账号 UI 态）、`ae-profit`（利润追踪 UI 态）、`shipping-rate`（运价表 + 报价配置）、`plugins`（插件停用集）、`order-cost`（订单利润页的 UI 态：平台费近似费率）。完整清单见 `docs/baseline/PROJECT_BASELINE.md` §6。
  > ⚠️ 本节只列**内建侧 + 已发布岛**；`product-library` **不占命名空间**（岛内无跨会话状态、不声明 `storage`）—— 该岛已于 **2026-10-01 整体下架**（功能收回内建「货与成本」），此注记保留作先例：**岛要跨会话存状态才占命名空间**。
  > 清单的权威来源是基线 §6 —— **新增一个用 storage 的岛 = 新增一个命名空间**，两处要一起改。
- 写操作统一 `scheduleSave(data)`（500ms 防抖）；需要立即落盘用 `save(data)`。
- **禁止**使用旧扁平 key（records/templateConfigs 等）直接读写；主进程内置 excel-copy 旧数据迁移，勿新增扁平 key。
- 持久化字段的新增/变更需保持向后兼容：读取时对缺失字段做默认值兜底（参考 `store.loadState()` 的写法）。
- Token/会话态等安全敏感状态例外：走 `src/core/network/token.ts`（localStorage `sk_auth_token`），不落 electron-store。
- **schema 演进必须走版本化迁移（2026-09-29 起）**，两条通道在 `electron/db.ts`，**不可互相替代**：
  - `dbMigrate(statements)` —— 幂等 DDL（`CREATE TABLE/INDEX IF NOT EXISTS`），负责"**新库**一次建到当前形状"；
  - `migrate(key, steps)` —— 版本化**演进**（补列 / 重建表 / 改唯一键 / 搬数据），负责"**老库**追上来"。
    记账表 `sk_schema_migrations` 按域 key 记版本（各域仍自己拥有 schema），步骤在域内从 1 起升序，同一域的待应用步骤同一个事务。
  - **禁止**只把新列/新唯一键写进 `CREATE TABLE` 就以为老库会跟上：`IF NOT EXISTS` 对**已存在**的表一个字都不改。
    这已被实测咬过一次（`pl_shop_sku` 的唯一键 4 列 → 5 列，老库不重建 → 老库 4 列 / 新库 5 列，
    代码里对旧形状的假设在**新库上必失败、在老库上看不出来**）—— 形状差异只能靠迁移收敛。
  - 新增迁移步骤后跑 `npm run schema:smoke`（造老库形状，断言数据一条不丢 + 幂等），
    并在 `docs/baseline/PROJECT_BASELINE.md` §6「schema 演进」登记该域的当前版本。

### 1.5 设置页扩展机制（SettingsModal）

- 左右布局：左侧分类导航 + 右侧内容区。
- **基础分类固定两个**：`general`（通用）/ `plugins`（插件）；其余分类一律由**设置贡献**动态生成，
  不得硬编码进 `SettingsModal.vue`（见下方两类贡献）。当前实有分类清单见
  `docs/baseline/PROJECT_BASELINE.md` §6 —— 本文件只写规则，不写"当前有哪些"（实例最易滞后）。
- **设置项收拢原则**：业务功能设置一律收进设置页，内容页只留高频操作（筛选 Tab 等）。
- 模块内组件需要"打开设置页并定位"时，dispatch 全局事件（AppShell 已监听）：
  ```typescript
  // 基础分类
  window.dispatchEvent(new CustomEvent('open-settings', { detail: { category: 'plugins' } }));
  // 设置贡献分类：视图插件包用其 settings.ts 的自定 id；UI 岛用 '<pluginId>:settings'
  window.dispatchEvent(
    new CustomEvent('open-settings', { detail: { category: 'shop-accounts:settings' } })
  );
  ```
  AppShell 通过 `initialCategory` / `initialTab` props 传给 SettingsModal 完成定位。
  注意 `initialTab` 只对**声明了二级 Tab 的分类**有效 —— 目前只有视图插件包的 `settings.ts` 能声明 `tabs`；
  UI 岛的 `manifest.settings` 是单页（`islandPanels` 无 tabs 字段），对它传 `tab` 会被忽略。
- 设置面板组件同时用于"设置页内嵌"与"独立抽屉"两种形态时，用 `embedded?: boolean` prop 条件渲染外壳（参考 `TemplateManager.vue` / `FieldRuleManager.vue` / `ColumnSelector.vue`）。
- **两类插件设置贡献（2026-09-18 起，二者同队列按 order 排序）**：

  | 形态                                    | 声明位置                                                     | 内容承载                                                                                             | 分类 id                    |
  | --------------------------------------- | ------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------- | -------------------------- |
  | 视图插件包（`extensions/`，随宿主分发） | `settings.ts` → `settingsPanelLoaders`                       | 宿主内 Vue 组件（`embedded` 内嵌；**唯一可声明二级 Tab 的形态**）                                    | 自定                       |
  | **宿主自有**（`src/core/settings/`） | `panels.ts` → `settingsPanelLoaders`（键 `core`） | 宿主内 Vue 组件（同上；与插件贡献**同一队列**按 order 排序） | 自定（如 `recognition`） |
  | **UI 岛（`ui-plugins/`，市场安装）**    | `manifest.settings = { entry, displayName?, icon?, order? }` | `IslandSettingsPanel.vue` → `sk-plugin://<id>/<entry>` iframe 岛（复用 `__sk` 受控桥，权限同白名单） | 固定 `<pluginId>:settings` |
  - 岛设置页由岛工程**独立入口**产出（Vite 多入口：`index.html` 主视图 + `settings.html` 设置页），`entry` 须与 `manifest.entry` 同子树（发布脚本 `scripts/publish-plugin.js` 强校验）。
  - 岛内不再重复实现设置页：宿主是唯一入口；岛侧只需一个「设置」按钮，调用既有桥能力 `sk.host.ui.openSettings('<pluginId>:settings')`（`ui` 属轻量能力，gatedHost 默认放行，**不得写入 capabilities**）——宿主内部 dispatch `open-settings`，AppShell 打开 SettingsModal 并定位分类。
    ✅ **已决策的例外（勿擅自"修正"）**：`excel-copy` 的**映射类**设置留在**岛内视图**（不声明 `manifest.settings`，故不进本节分类导航）。这不是疏漏——收编会打断它「改模板/规则 → 立刻看预览」的核心回路。完整论证与重新评估条件见 **`docs/decisions/ADR-001-island-settings-stay-in-island.md`**。改这个插件的设置入口前**必须先读该 ADR**。（原先同列的 `order-insight` 已于 **2026-10-05 整体下架**，它的列映射现由内建「今天 › 归类核对」承接 —— ADR-001 的判据没有变，只是适用对象少了一个。）
    ⚠️ **2026-09-30（C4 收编）的边界**：ADR-001 只覆盖"改完要看预览"的**映射类** —— 当时 `order-insight` 岛的「视觉引擎 + API Key」按此判据**已搬进宿主「设置 › 识别」**（`src/core/settings/`，全局基础设施不该藏在可卸载的业务岛里），岛内页签改名**「导入设置」**只留列映射与"本次导入店铺"（该岛 2026-10-05 下架，列映射随后内建进「今天」）。**判据是"改完要不要立刻看数据变化"，不是"原来在哪"。**
    - 判据（供新插件对号入座）：**改完设置是否需要立刻看数据变化**——需要 → 留在岛内（同 excel-copy）；不需要（如低频账号管理）→ 收编进宿主（同 `shop-accounts`）。
  - 岛被停用/卸载时分类即时消失（`managerSettings.getIslandSettingCategories()` 读 `ctx.uiIslands` + `ctx.disabled`）。

### 1.6 主题设计令牌（--wb-* CSS 变量）

- **禁止在组件中硬编码色值**；一律用 `var(--wb-*)`（浅色 `:root` 与深色 `[data-theme='dark']` 两套）。
- **本红线已自动拦截**（R2-3）：`npm run lint` 通过 `vue/no-restricted-class` 拦调色板类与任意值色；
  唯一例外是图片上的半透明遮罩（黑底白字与其绝对对比有关，与主题无关），需在该处写
  `<!-- eslint-disable vue/no-restricted-class -->` 并注明理由——见 `ProductLibraryView.vue`。
  残余缺口（三元/逻辑表达式内的类名）与门禁细则见 §6.1。
- 常用令牌：`--wb-bg / --wb-surface / --wb-surface-2 / --wb-border / --wb-text / --wb-text-muted / --wb-primary / --wb-primary-hover / --wb-primary-soft / --wb-primary-contrast / --wb-accent(-soft) / --wb-success / --wb-warning / --wb-danger / --wb-hover / --wb-overlay / --wb-radius`。
- **主色背景上的文字必须用 `--wb-primary-contrast`**（不可写死 `text-white`——深色主题下主色为冷白灰会白字白底）。
- 输入控件（input/select/textarea）由 `@layer components` 全局规则统一主题化，组件无需重复设背景/文字色；确需覆盖时用更高层类（如 `bg-transparent`）。
- 新颜色必须走令牌体系：先在 `index.css` 两套主题各定义一个 `--wb-*`，再在组件引用。
- **何谓"允许的固定色值"**（R3-5 厘清——不是所有 hex 都是违规，判定看**语义**）：
  | 情形                                                                                     | 处置                                                                              | 现有实例                                                                                                                    |
  | ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------- |
  | 界面配色（底色/边框/文字/语义色/阴影）                                                   | **必须令牌化**；缺令牌就先在两套主题各加一个                                      | `--wb-shadow`（R3-5 新增，抽屉投影）                                                                                        |
  | 业务数据颜色（色名 → 色值，表达现实世界的颜色）                                          | 集中到独立文件并注明"不参与主题切换"                                              | `src/lib/colorSwatch.ts`（款色色卡，17 个 hex；2026-09-22 由 `extensions/order-insight/src/lib/` 迁入，理由见该文件头注释） |
  | 非 UI 像素（canvas 像素数据、图片生成探测等）                                            | 就地保留 + 注释说明"非界面配色"                                                   | `src/core/ai/openaiCompatible.ts`（视觉探针图 `#e05a3a`）                                                                   |
  | `var(--wb-x, #hex)` 的 fallback 值                                                       | **允许**：令牌缺失时的保险；但取值须与 `index.css` 的令牌定义一致，令牌改名时同步 | `src/core/components/UiIslandView.vue`                                                                                      |
  | 业务数据色若被"顺手令牌化"，深色主题下"白色"款色会变成深灰块——颜色识别失效，属反向破坏。 |
- **`color-scheme` 不是令牌，须单独跟随**（2026-09-22）：UI 岛（iframe）里写死 `color-scheme: light`（或不声明）
  会让深色主题下的**原生控件**（日期选择器、下拉弹层、滚动条、复选框、输入光标）仍是浅色 ——
  文字与面板都变黑了，只有原生件是白的，表现为「岛内样式跟宿主主题不一致」。
  处置：宿主已在 boot/theme 载荷下发 `theme.mode`（`uiBridgeHost.ts#currentThemeMode`），
  运行时把它写到 iframe 的 `<html>` 内联样式上（`electron/plugin-ui-runtime.js#applyTheme`）——
  **新岛不要再自己解析 `--wb-bg` 亮度、也不要写死 `color-scheme`**；
  确需在元素级指定时写 `color-scheme: inherit`（跟着 `<html>` 走）。
  `:root` 上保留 `color-scheme: light` 作为首帧兜底是允许的（宿主内联必盖过它）；**元素级写死 light 才致命**——
  元素自己的声明优先于 `<html>` 的内联值。同理：靠 `[data-theme='dark']` 选择器自我纠正**不可能生效**，
  宿主只注入内联令牌、不同步 `data-theme` 属性到 iframe。
  存量反例已于 2026-09-22 收口：`ui-plugins/shop-accounts/src/components/AccountEditor.vue`（`.date-input` + 一条永不命中的 `data-theme` 死选择器）、
  `ui-plugins/ae-profit/src/style.css`（`@layer components` 的日期/时间输入组）。

> 与本节同族的一条纪律：**用户可见文案**（不是色值，而是"说给用户听的话"）见 **§1.10** ——
> 禁用内部术语、空态三段式、以及守卫落在真机冒烟读 `innerText`。

### 1.7 网络请求基线（统一走 src/core/network）

- 渲染层**禁止直接 fetch/XHR 跨域**（CORS 限制）：一律经 `src/core/network/request.ts` 的默认 axios 实例。
- 请求链路：axios（IPC adapter，默认）→ `net-request` IPC → 主进程 `electron/http-client.ts`（Electron `net`）→ 真实 HTTP。
- 引擎切换：`.env` 的 `VITE_REQUEST_ENGINE`（`ipc` 默认 / `xhr` 仅本地调试）；基础地址 `VITE_API_BASE_URL`（`.env.development` / `.env.production`），创建实例时可传 `baseURL` 覆盖。
- Token：`getToken/setToken`（`token.ts`）；请求拦截器自动附加 `Authorization: Bearer <token>`，401 响应自动清除本地 token。
- 安全边界（勿随意放宽）：`electron/http-client.ts` 协议白名单（https/http）+ 方法白名单；`preload.ts` 结构白名单消毒；`ipc-handlers.ts` 入参二次校验（URL≤8192、body≤10MB、响应≤10MB、15s 超时）。
- 使用方式：`const { data } = await http.get<T>('/api/x')`——响应**不自动解包**，保持类型安全；登录后 `setToken(...)` 写入 token。

### 1.8 运行时插件体系（`src/core/plugin/`，Phase 1–4 已落地）

在 §1.3 构建期模块裁剪之上，新增运行时插件内核（详见 `docs/architecture/PLUGIN_ARCHITECTURE.md`）：

- **目录分层**：`src/core/plugin/` 内核不依赖业务；`electron/plugins-handlers.ts` 主进程做外置插件目录的第一层防线；业务模块（内建插件）经 `pluginManager` 以 `PluginModule` 身份注册。
- **链路**：AppShell `createBuiltinPluginManager()` → `discoverExternal()`（扫描 `<userData>/plugins`，渲染层 `externalManifest.ts` 严格 schema 校验）→ `activateStartupPlugins()` 激活 `activationEvents: ['onStartup']` 的外置插件 → 贡献点（视图/命令/设置）注册进贡献注册表 → 侧边栏 / ⌘K 消费。
- **外置插件形态**：目录 `<userData>/plugins/<kebab-id>/`，`manifest.json`（`name` 必须等于目录名）+ 自包含单文件 ESM 入口（`default` 导出 `{ activate(ctx), deactivate?(ctx) }`）；entry 仅 `./` 相对路径、禁止 `..` 穿越、入口 ≤2MB（主进程 `plugins-handlers.ts` 强制）。
- **信任分级**：内建 = Level 0（raw host）；**外置 = Level 2（Worker 沙箱）**——插件源码在主线程不复存在，被 `?raw` 注入的 `sandboxRuntime.ts` 于独立 module Worker（Blob）内 `import()` 求值；宿主侧（`sandbox.ts`，仍在主线程）以 `createGatedHostApi` 包权限门逐调用判定。Level 1（主线程受限外置，Phase 3 过渡形态）已移除，`trustLevel: 0|1|2` 字段保留 1 仅为历史兼容。
- **沙箱桥协议**（宿主 ↔ Worker，MSG 常量双端同源，见 `sandboxRuntime.ts` 头部注释）：宿主→Worker `boot/run-command/event/deactivate/abort`，Worker→宿主 `activated/boot-error/deactivated/command-result/call/log/register-*/unregister-*/subscribe/unsubscribe/publish`；请求以 `payload.rid` 关联、能力调用以 `payload.id` 关联（宿主回 `call-result`）；一次性随机 token 随 boot 建立，后续所有消息必须携带，Worker 内伪造/串台消息被静默丢弃。
- **运行时自包含约束**：`sandboxRuntime.ts` 以 `?raw` 文本注入 Blob module worker，必须保持纯 JS（无 import/无 TS 语法，仅末尾 `export {}` 空导出标模块、无 Vite alias）；权限判定与审计仍发生在宿主主线程（Worker 不可自证可信）。
- **生命周期/崩溃**：激活/停用均有超时；Worker 异常（crash/超时）走 `handleSandboxCrash` → 记录 error → 清理贡献 → `deactivateRecord`；activation 失败会回滚已注册贡献并销毁 sandbox。
- **权限门**（`security.ts`）：manifest `capabilities` 显式声明 → 逐调用判定（能力域 / 动作 / 命名空间 / URL 前缀）→ 未声明即抛 `PluginPermissionError` 并写入审计环（`auditDenied()` 供「设置 → 插件」面板展示）；自身命名空间经 `ctx.storage` 走 raw host 直通。
- **T8/T9（已落地）**：贡献点统一 `order?: number`（⌘K 消费点升序渲染：`pluginManager.getActiveCommands/getPluginCommands` 按 order 排序；沙箱命令经 `register-command` 透传 order）；事件总线支持尾部 `*` 通配订阅（`meta.eventType` 携带实际事件名，`sandboxRuntime.ts` 内联 pattern 判定本地路由，与 `eventBus.ts` 双端一致——见红线 20）。
- **外置插件无视图**：按"后台贡献型"处理（命令进 ⌘K 的"外置插件命令"分组），与内建视图切换语义解耦；「设置 → 插件」面板以 `内建 · L0` / `外置 · L2` 徽标区分信任级别。
- **随宿主分发视图插件（Phase 5，机制 A；当前无实例）**：机制仍在，但曾用它的三个模块已全部**下记**为市场 UI 岛——`excel-copy` / `order-insight` / `shop-accounts` 的 `extensions/<id>/` 目录曾是**源码留档、不进构建** —— 那批留档已于 **2026-09-30（C3）删除**（算法早已在内建 `src/lib` / 岛 `dist` / 宿主 op 各有落地；它们还占着 `tsconfig` / `eslint` 的覆盖范围，属「多套实现」的源头）。**机制保留、当前无实例**：要用就按本节重建 `extensions/<id>/`。机制本身：`manifest.json`（`kind: view` + displayName/version/description/author）+ `src/` 源码随宿主编译（registry 双根收录），**保留完整 Vue 视图/数据/设置能力**。设置面板贡献化：插件包 `settings.ts`（导出 `settingPanels`）经 registry `settingsPanelLoaders` 注册，SettingsModal 分类导航/内容区按贡献生成（已去硬 import）。运行时按包启停：`pluginManager.setPluginEnabled/applyDisabled`（停用 → 移除静态视图贡献 → 侧栏/⌘K/设置分类消失、`activate` 拒绝；启用 → 恢复静态贡献）；停用集经 `plugins` 命名空间持久化；PluginCenter 内建行提供启停按钮。安装/移除 = 增删 `extensions/<id>/` 目录（构建期收录），与 src/modules 模块同受 `MODULE_IDS`/profile 裁剪。

### 1.9 `extensions/` 与 `ui-plugins/` 的判定规则（易混）

两个目录都叫"插件"，但**形态、分发方式、加载机制完全不同**，判断依据如下：

|          | `extensions/<id>/`                                                                                                                                                                               | `ui-plugins/<id>/`                                                                                                                                         |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 判定标志 | 存在 `meta.ts` **且未被下记**（`ui-plugins/<id>` 不存在）；manifest `kind: 'view'`                                                                                                           | manifest `kind: 'ui'`；`entry: './dist/index.html'`                                                                                                        |
| 形态     | 随宿主分发的**视图插件包**，完整 Vue 视图/数据/设置能力                                                                                                                                          | **UI 岛**：独立构建的静态产物，iframe 运行时 + `window.__sk` 桥                                                                                            |
| 加载     | `vite.config.ts` 双根探测（`MODULE_ROOTS`）收录进 registry，随宿主编译                                                                                                                           | 运行时由宿主注入 UI 岛协议加载，**不进主 bundle**                                                                                                          |
| 数据访问 | 直接用自己的 store（Pinia + `useModuleStorage`）                                                                                                                                                 | 只能经 host 能力域（`storage` / `db` / `clipboard` / `dialog` / `secrets` / `mail`），受 `gatedHost` 权限门约束                                            |
| 分发     | `npm run dist` 随包                                                                                                                                                                              | 打成 zip 走插件市场（`market-out/`）                                                                                                                       |
| 注册登记 | 必须在 `modules.config.json` 的 profile 中登记                                                                                                                                                   | **禁止**登记进 profile（否则内建记录占用同名 id，市场安装的 UI 岛无法注册）                                                                                |
| 当前实例 | **无，且目录不存在**（`excel-copy` / `order-insight` / `shop-accounts` 已全部下记；最后两个**留档源码包**已于 **2026-09-30（C3）删除** —— 机制保留，要用再建；脚手架在 `scripts/templates/`） | **4 个**：`shop-accounts` / `excel-copy` / `ae-profit` / `shipping-rate`（原样例岛 `sk-ui-starter` 已于 2026-09-24 删除；**`product-library` 已于 2026-10-01 整体下架** —— 功能收回内建「货与成本」，见 `docs/features/PRODUCT_LIBRARY.md` §0-A；**`order-insight` 已于 2026-10-05 整体下架** —— 功能收回内建「今天」发货台七页签，见 `docs/notes/2026-10-01-ui-island-retirement.md` §6）。**这里不写版本号** —— 版本会随每次发版变，权威清单见 `docs/baseline/PROJECT_BASELINE.md` §4 |

⚠️ **脚手架已归位（2026-09-22，T4）**：`npm run plugins:create` 的**模板**与**示例**曾寄居在 `extensions/` 下（`_template` / `sk-hello`），
现全部迁到 `scripts/templates/` —— L2 后台插件模板 `scripts/templates/l2-plugin/`、L2 演示插件 `scripts/templates/l2-demo/`。
它们是**第 4 类脚手架**（manifest 有 `entry: './index.js'` 但**无 `meta.ts`**），不被 registry 收录、不随包分发，
真实运行位置是 `<userData>/plugins/`。因此 **`extensions/` 下的目录 = 随宿主分发的视图插件包**这条直觉现在成立，不要再把脚手架放回去。

> `npm run plugins:create <id>` 的**生成产物**默认仍落在 `extensions/<id>/`（模板变了，落点未变）；
> 它是 L2 后台插件，最终要 `--install` 到 `<userData>/plugins/<id>` 才生效。生成后别把它当成视图插件包去登记 profile。

> 保留红线 23：**禁止把 UI 岛 id 登记进 `modules.config.json` 的 profile**；**禁止依赖 `extensions/` 下无 `meta.ts` 的目录被构建收录**。
>
> 2026-09-22 补强：下记后源码留档仍含 `meta.ts`，故"有 meta.ts 即模块"的枚举会把已下记 id 重新算成**打包候选**。
> 现由 `scripts/lib/module-roots.cjs` 的 `isUndocked()`（判据：`ui-plugins/<id>` 存在）在**枚举与构建两处**硬拦：
> `select-build.js` 把这类目录单列为"已下记为市场 UI 岛"、不进候选；`vite.config.ts` 对 `MODULE_IDS` 里出现的已下记 id **报错并忽略**。
> 因此**也不得用 `MODULE_IDS=<已下记 id>` 打包**。

> **UI 岛的接入 / 改动 / 排障逐步清单**（含检查项、故障速查表、一键冒烟）见
> `docs/architecture/UI_ISLAND_INTAKE_CHECKLIST.md`；新增或修改 UI 岛前先过一遍它的 §1 步骤与 §2 清单。
> 记住三条结构性约束：**桥随岛重建**（红线 24）、**运行时随包分发**（红线 25）、**消息永不静默丢**（红线 20 的双端纪律）。

### 1.10 用户可见文案纪律（2026-09-30，R-文案）

**判据只有一条**：这句话是写给**用户**看的，还是写给**我们**看的？写给用户的**不得**出现下列任何一类：

| 禁用族 | 例子（都是真实出现过的） |
| --- | --- |
| 能力域 / 表名 / op 名 | `ae_rates upsert`、`ae_cost_map`、`按款编码精确匹配（ae_cost_map）` |
| 进程与协议名 | 宿主 / 桥 / 握手 / iframe / CSP / realm / token / `Worker 沙箱` / `sk-plugin://` / `sk-mail://` |
| 权限与审计内部词 | `越权调用由宿主权限门拒绝并审计`、`未声明（所有受限能力被拒）` |
| 内部分级 / 内部 id | `L0` / `L2` / `外置 · 视图` / `扩展包 · L0` / 主键 ID（「已删除的企业（ID 3）」） |
| 悬空功能名 | 引号里的 `「X」` 必须是**真实存在**的入口名（曾出现 `「运费测算」`，全仓无此功能） |

改写方向：**能力说人话**（`db` → 「读写业务数据」，原始名进 tooltip）、**来源说人话**（`外置 · L2` → 「从市场安装」）、
**状态说人话**（`等待桥握手…` → 「正在连接…」；失败 → 「未能连接 —— 点此重试」）、**空态三段式**（现状 + 原因 + 一个可点的下一步）。

**守卫落在哪一层**（2026-09-30 实测定下的取舍）：

- **首选真机冒烟读 `innerText`** —— `npm run plugins:island:smoke` 里已加"工具条文案体检"（逐个岛读宿主
  `.ui-island-bar` 的可见文本，断言无禁用词且状态行为「已连接」）。**折叠区（如「诊断」）天然不在 `innerText` 里**，
  所以"调试入口必须默认收起"这条也被同一条断言顺手守住。
- **源码正则扫描只钉结构性事实**（如"诊断区存在且被 `v-if` 包着"），不要拿它判文案：注释、被折叠的模板、
  拼接字符串都会误判，收益低噪声大。
- ⚠️ 例外（**刻意保留**）：插件中心的**权限明细**那一列保留技术细目 —— 知情同意需要精确范围（哪个域、哪些动作）。
  但它必须有上面那句人话摘要，不能只有 `db`。

---

## 2. 统一代码风格

### 2.1 命名规则

| 场景                 | 规则                                                                                                                                               | 示例                                         |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------- |
| TypeScript 接口      | PascalCase（禁止与 TS 内置工具类型同名，如 Record/Partial/Omit）                                                                                   | `RecordItem`, `TemplateConfig`, `ModuleMeta` |
| 类型别名（联合类型） | PascalCase                                                                                                                                         | `FilterMode = 'all' \| 'used' \| 'unused'`   |
| Vue 组件             | PascalCase `.vue`                                                                                                                                  | `PreviewPanel.vue`, `RecordItem.vue`         |
| 普通 TS 文件         | camelCase `.ts`                                                                                                                                    | `excelParser.ts`, `templateEngine.ts`        |
| 函数/方法            | camelCase                                                                                                                                          | `copyAndMark()`, `scheduleSave()`            |
| Pinia 状态           | camelCase（ref/computed 不加前缀）                                                                                                                 | `records`, `filteredRecords`                 |
| 模块常量             | UPPER_SNAKE_CASE（仅模块级）                                                                                                                       | `MODULE_ID`, `SAVE_DEBOUNCE_MS`              |
| IPC 通道名           | kebab-case 字符串                                                                                                                                  | `'get-app-version'`, `'win-control'`         |
| 模块目录 / meta.id   | kebab-case                                                                                                                                         | `excel-copy`, `quick-note`                   |
| 环境变量             | `VITE_` 前缀为渲染层（`VITE_API_BASE_URL` / `VITE_REQUEST_ENGINE`）；构建期 Node 环境变量（vite.config.ts 读取）为 `MODULE_PROFILE` / `MODULE_IDS` | `VITE_API_BASE_URL`, `MODULE_IDS`            |

### 2.2 注释规范

- 公共导出函数写 JSDoc（`@param` / `@returns` / `@throws`）。
- 模块内私有辅助函数行内注释即可。
- 文件头注释说明文件职责与依赖关系（参考 `storage.ts` / `excel.ts`）。
- TODO / FIXME 标注已知问题。

### 2.3 异常处理标准

渲染进程（store / 组件）：

```typescript
try {
  const ok = await writeClipboard(text);
  if (!ok) {
    toast('复制失败', 'error');
    return;
  }
} catch (e: unknown) {
  toast(`复制失败: ${e instanceof Error ? e.message : '未知错误'}`, 'error');
  return;
}
```

主进程 IPC handler：

```typescript
ipcMain.handle('xxx', async (_e: any, ...args) => {
  try {
    /* ... */ return { success: true, data };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});
```

原则：

1. 用户可感知的错误必须 `toast`（`toast.success/error/info`）。
2. IPC 调用必须检查 `result.success`，并处理失败分支。
3. `try/finally` 保证 loading 等状态复位。
4. 禁止空 catch、吞错误、在 catch 中做业务逻辑。
5. catch 变量名：渲染进程 `e`（短块）或 `e: unknown`；主进程 `err: any`。

---

## 3. 常见错误规避（红线）

1. **禁止硬编码路径**：默认模板路径经 `get-default-template-path` IPC 获取（主进程按 isPackaged 区分 dev/resources）。
2. **禁止裸写 Magic Number/String**：`const USED_ORDER_BASE = 10000;` 命名常量。
3. **禁止不校验入参**：IPC handler 与 store 方法必须校验入参类型/存在性。
4. **禁止忽略 IPC 返回**：`const r = await ipc.xxx(); if (!r.success) { /* 处理 */ }`。
5. **禁止渲染进程直接用 Node API**：一律走 `core/services/ipc.ts`。
6. **禁止直接改 Pinia 状态绕过 action**（例外：`selectedId`/`searchQuery`/`filterMode`/`showTemplateManager` 等纯 UI 状态可直接赋值）。
7. **禁止将整个 store 作为 prop 传组件**：组件内 `useXxxStore()` 自行获取。
8. **禁止滥用 `as` 断言**（主进程宽松例外）。
9. **禁止 Vue 模板中复杂表达式**：用 computed 抽取。
10. **禁止在模块间共享业务数据**：模块状态各自命名空间持久化，跨模块能力通过 core services 提供。
11. **禁止渲染层直接 fetch/XHR 跨域请求**：一律走 `src/core/network/request.ts`（CORS 规避链路见 §1.7）。
12. **禁止主进程新增 .ts 文件不标模块**：顶层声明会被 TS 视为全局作用域，与其它主进程文件冲突——每个主进程 .ts 文件头部必须加 `export {}`。
13. **禁止业务类型命名遮蔽 TS 内置类型**：曾因 `interface Record` 遮蔽全局 `Record<K,V>` 工具类型（已改名 `RecordItem`），新类型命名前先确认不与内置工具类型冲突。
14. **禁止修改 .env 变量名**：`VITE_API_BASE_URL` / `VITE_REQUEST_ENGINE` 已被 `request.ts` 与 `env.d.ts` 读取，改名需三处同步。
15. **禁止改变模块选择优先级或移除 `MODULE_IDS` 支持**：`scripts/select-build.js` 交互选择器依赖 `MODULE_IDS` 驱动 `vite.config.ts` 裁剪；调整优先级需同步选择器、vite.config.ts 与本文档（见 §1.3）。
16. **禁止插件直连 `window.electronAPI`/裸 IPC**：一律 `ctx.host.*`（权限门）；manifest `capabilities` 未声明即调用会抛 `PluginPermissionError` 并写审计。
17. **禁止给外置插件放行未声明能力**：`capabilities` 显式声明是权限门的唯一放行依据；新增能力声明需评估（storage 命名空间/动作）并同步示例 manifest。
18. **禁止破坏外置插件目录安全边界**：目录名 = manifest.name（kebab-case）、entry 仅 `./` 相对且禁 `..`、入口 ≤2MB——任何放宽须同步 `electron/plugins-handlers.ts` 与渲染层 `externalManifest.ts` 两处防线。
19. **禁止新增主进程插件 handler 不设双防线**：主进程只做形状/路径/大小第一层校验，严格 schema（manifest 能力/entry）校验必须在渲染层 `externalManifest.ts` 完成。
20. **禁止两端桥协议常量不同步**：`sandboxRuntime.ts`（Worker 端）与 `sandbox.ts`（宿主端）的 MSG 常量与消息载荷（rid/id/token 关联规则）必须一一对应；改动须两处同步并跑通冒烟验证（`npm run plugins:sandbox:smoke`，即 `node scripts/sandbox-smoke.mjs`，boot→command→call→deactivate→token 拒绝全链路）。T9 通配 pattern 判定（`plugin:*` 前缀匹配）同属两端双份逻辑（`eventBus.ts` 宿主实现 / `sandboxRuntime.ts` Worker 纯 JS 内联），改动须两处同步——冒烟已覆盖通配订阅命中实际事件。
21. **禁止破坏 Worker 运行时自包含性**：`sandboxRuntime.ts` 以 `?raw` 文本注入 Blob module worker，必须保持纯 JS——无 import/TS 语法、仅末尾 `export {}` 空导出标模块、无 Vite alias、不触碰 window/DOM/electronAPI；任何新增依赖必须内联到该文件（见 §1.8）。
22. **禁止外置插件绕过沙箱**：外置插件执行必须走 `createSandboxedPlugin`（Worker 沙箱），不得回退到主线程 `import()`/`eval` 执行插件源码；宿主侧权限门判定不得移入 Worker。
23. **禁止混淆 `extensions/` 与 `ui-plugins/` 语义**：UI 岛 id 不得登记进 `modules.config.json` 的 profile（会占用同名 id 阻断市场安装包注册）；不得依赖 `extensions/` 下无 `meta.ts` 的目录（脚手架/示例）被构建收录。判定规则见 §1.9。
24. **禁止让 UI 岛桥会话跨岛复用**（2026-09-24 修「重启后点导航一片空白」）：宿主渲染 `<UiIslandView>` **必须带 `:key="activeIslandId"`**，且 `UiIslandView.attach()` 必须按 `pluginId` 判定是否重建桥。Vue 会复用同位置同类型组件——桥（`expectedOrigin` + token）若不随岛重建，新岛的 `hello` 被判串台、旧桥的 `boot` 又被 `postMessage` 的 targetOrigin **静默丢弃**（不抛错、不打印），表现为"本会话第一个岛能用、之后每个岛都是空白页"。改动此链路须跑 `npm run plugins:island:smoke`（逐岛点击 + 断言握手）。
25. **禁止让 `electron/plugin-ui-runtime.js` 离开分发路径**：它是 inject 进 UI 包 HTML 的**桥运行时源码文本**，既不能被 tsc 编译重写（`tsconfig.electron.json` 的 include 只收 `*.ts`），也不能漏在 `electron-builder.yml` 的 `files` 之外——漏了则打包版不注入桥（`loadRuntimeSource()` 两候选全 miss），**所有**岛 `window.__sk` 缺失、点导航空白；dev 因读项目源码而看不出来。
26. **禁止只改一层 CSP 就去嵌自定义协议文档**（2026-10-04 修「邮件正文里的图全不显示」）：岛页面同时受**两层** CSP 约束 —— ①宿主响应头的 `UI_CSP`（`electron/plugin-ui-protocol.ts`）②**岛自己的 `ui-plugins/<id>/index.html` 里的 `<meta http-equiv="Content-Security-Policy">`**，二者**取交集**。任一层缺 `frame-src` 就整个 frame 被拒（`ERR_BLOCKED_BY_CSP`，界面无提示、只在 Electron 日志里报）。故：给正文/子文档引入新 scheme（如 `sk-mail:`）时，**两处都要放行**，并跑 `npm run mail:body:smoke` + `tests/islandMailFrameCsp.spec.ts`（后者静态守卫"岛引用了 `sk-mail://` 却没在 meta CSP 放行"）。**注意别把冒烟的宿主页只复刻成头 CSP** —— 那是假绿（本轮实际踩过）。
27. **禁止把"改完仓库代码"当成"改完了"**：UI 岛一律从 `<userData>/plugins/<id>/` 加载，仓库里的 `ui-plugins/<id>/dist/` 只是**待发布产物**。改岛的完整闭环是 **改源码 → 构建 → 拷 `manifest.json` + `dist/` 进插件目录 → 重启宿主**，缺任一步用户看到的都是旧代码，且**没有任何提示**（旧版本照常能跑）。同类盲区：preload / 主进程改动需要**重启宿主**才生效（HMR 不覆盖）。真机取证用真实 userData 的**克隆**（`cp -cR`）跑，别用全新的隔离目录 —— 后者没有真实数据，测不出这类问题。

---

## 4. 文件操作边界

### 4.1 可自由修改

`src/core/components/`、`src/core/network/`（保持现有模式）、`src/modules/*/`、`extensions/<id>/`（随宿主分发视图插件包：manifest.json + `src/` 源码，源码 import 一律走 `@/` 别名或模块内相对路径，禁止 `../..` 相对宿主引用）、`src/lib/`、`src/styles/index.css`、`src/core/services/`（保持现有模式）、`modules.config.json`（登记新模块）、`scripts/`。

### 4.2 需先理解 IPC 模式后再改

`electron/main.ts` / `electron/preload.ts`：新增/修改 IPC 必须同步 `preload.ts` 与 `src/types.ts` 的 `ElectronAPI`。
`electron/http-client.ts` / `electron/ipc-handlers.ts`：网络白名单/校验逻辑，修改需评估安全边界（见 §1.7）。
`electron/plugins-handlers.ts`：外置插件目录扫描/入口读取/卸载的**主进程第一层防线**，改动须评估路径穿越/大小上限（见红线 18）。

### 4.3 严格禁止修改（除非用户明确要求并确认）

`package.json` 的 `name/main/overrides`、`electron-builder.yml` 的 `appId/mac.asar/产出目录`、`vite.config.ts` 的 plugin/alias/outDir、`tsconfig*.json`（注：Phase 5 曾为覆盖插件包类型把 `extensions/**/*.{ts,vue}` 加进 include，**随 2026-09-30 C3 删留档而移除**；将来再引入视图插件包时按 §1.8 重新加回）、`tailwind.config.js` / `postcss.config.js`、`index.html`、**`src/registry.generated.ts`（自动生成）**。

### 4.4 底层公共工具（改动前必须搜全部调用方并逐一更新）

`src/lib/excelParser.ts`、`src/lib/fieldProcessor.ts`、`src/types.ts`、`src/env.d.ts`、`electron/preload.ts`、`src/core/services/*`、`src/core/network/*`（request/token/types）、`src/core/types.ts`、`src/core/plugin/*`（内核：pluginManager / security / gatedHost / externalManifest / externalLoader / sdk / types / index）、`electron/plugins-handlers.ts`。

---

## 5. 新增功能 SOP（对照检查）

| 场景                                  | 必须步骤                                                                                                                                                                                                                                                                                                                                                                                                                                           |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 新增业务模块                          | 见 §1.3 SOP；meta.id 与目录一致；modules.config.json 登记                                                                                                                                                                                                                                                                                                                                                                                          |
| 新增随宿主分发视图插件 / 大模块外挂化 | 代码放 `extensions/<id>/src/`（meta/index/store/view/components 自包含）+ `manifest.json`（`kind: view`）；设置面板在包内写 `settings.ts` 导出 `settingPanels`（分类/tab + 组件）；在 modules.config `enabledModules`/相关 profile 登记 id 进包；SettingsModal 不新增硬 import（分类/内容注册式）。机制保留但**当前无实例**（留档已随 C3 删除；形态可参考 git 历史或 `ui-plugins/excel-copy` 的岛版）；若该 id 同时存在 `ui-plugins/<id>`，按 UI 岛走，别登记进 profile（红线 23） |
| 停用/启用插件                         | 「设置 → 插件」内建行按钮，或 `pm.setPluginEnabled(id, enabled)` / 启动时 `pm.applyDisabled(list)`；停用集自动持久化 `plugins` 命名空间；停用后侧栏/⌘K/设置分类消失、视图不可激活                                                                                                                                                                                                                                                                  |
| 新增模块状态                          | `store.ts` 中 `defineStore` setup 语法；经 `useModuleStorage('<模块id>')` 持久化；用 `scheduleSave`                                                                                                                                                                                                                                                                                                                                                |
| 新增 IPC 通道                         | main.ts（或 ipc-handlers.ts）注册 handler → preload.ts 暴露 → `ipc.ts` 封装 → `src/types.ts` 声明 → 调用方只依赖服务层；主进程 .ts 记得加 `export {}`                                                                                                                                                                                                                                                                                              |
| 业务功能需要 HTTP 请求                | 经 `src/core/network/request.ts` 的 `http` 实例调用；Token 用 `setToken/getToken`；新域名/方法需评估 `http-client.ts` 白名单与 §1.7 安全边界                                                                                                                                                                                                                                                                                                       |
| 定制打包范围                          | 预设：`MODULE_PROFILE=minimal npm run build`；自定义清单：`MODULE_IDS=quick-note npm run build`（优先级最高）；交互勾选：`npm run dist:select`；未选模块不进 bundle（见 §1.3）。⚠ **只能填未下记的 id**：写入已下记为 UI 岛的 id 会被构建报错并忽略（红线 23）                                                                                                                                                                                     |
| 新增设置分类/Tab                      | SettingsModal 加 categories 项 / 二级 Tab 数组；面板组件实现 `embedded` 支持；如需入口定位则 dispatch `open-settings`                                                                                                                                                                                                                                                                                                                              |
| 新增 UI 颜色                          | 先在 `index.css` 两套主题定义 `--wb-*`，再引用；主色底文字用 `--wb-primary-contrast`                                                                                                                                                                                                                                                                                                                                                               |
| 新增命令面板项                        | 模块 `index.ts` 的 `commands` 数组添加 `{ id, title, shortcut?, run }`                                                                                                                                                                                                                                                                                                                                                                             |
| 新增持久化字段                        | 主进程 defaultStoreData 或模块 loadState 兜底默认值；保持向后兼容读取                                                                                                                                                                                                                                                                                                                                                                              |
| 新增外置插件                          | `npm run plugins:create <kebab-id>` 脚手架生成（或手建）`extensions/<kebab-id>/`（manifest.json + index.js 自包含 ESM）；manifest 声明 name/entry/capabilities；`npm run plugins:demo:install`（或脚本复制到 `<userData>/plugins/`）后 AppShell 启动扫描即注册                                                                                                                                                                                     |
| 新增外置插件能力调用                  | 插件内一律 `ctx.host.<domain>.<action>`；先在 manifest `capabilities` 声明，未声明调用会被权限门拒绝（`PluginPermissionError` + 审计）                                                                                                                                                                                                                                                                                                             |
| 插件审计查看                          | 「设置 → 插件」分类（`PluginCenter.vue`，依赖 `manager` prop）；越权拒绝实时反映在"最近被拒绝的调用"区                                                                                                                                                                                                                                                                                                                                             |

---

## 6. 构建与验证（每次改动后）

```bash
npm run dev          # 开发（Vite HMR + Electron）
npm run build        # 生产构建（会重新生成 registry.generated.ts）
npm run dist:select  # 交互式勾选模块 → 构建 → 出安装包（scripts/select-build.js）
npm run build:select # 交互式勾选模块 → 只构建
npm run lint         # ESLint（eslint.config.mjs，flat config）：门禁标准是 **error 数 = 0**
npm run lint:fix     # 自动修复可修复项
npm run verify       # IPC 契约校验（preload 键 ↔ types 声明 ↔ 主进程注册通道）
npm run verify:docs  # 文档引用校验（Markdown 链接 + 反引号路径 + 代码注释里的文档引用）
npm test             # 单元测试（vitest，src/lib 纯函数层）
npm run test:watch   # 单元测试 watch 模式
npm run schema:smoke # schema 迁移冒烟（改了 electron/db.ts 的 migrate 或任何域的表形状后必跑）
npm run mail:inline:smoke # 邮件内联图离线冒烟（改了 content_id 补列 / cid 改写 / 远程图 CSP 两态必跑；不需凭据）
npm run mail:body:smoke   # 邮件正文渲染通道（sk-mail://）端到端冒烟（改了协议 / 岛 index.html 的 meta CSP 必跑；需真 Electron）
npm run ipc:shape:smoke   # preload ↔ 主进程「图片通道」载荷形状端到端冒烟（改了 preload 的图片方法 / 批量缩略图包装必跑；需真 Electron）
npm run ae:settle:smoke # 结算明细冒烟（改了 ae_settle_lines 的落库 / 聚合 / 件数明细后必跑）
npm run picking:smoke # 拣货投影冒烟（改了 electron/picking-db.ts 的筛选 / JOIN / 取图回落必跑）
npm run picking:ui    # 拣货页假桥无头冒烟（改了拣货页接线 / 导出必跑；需本机 Chrome）
npm run today:ui      # 「今天」首页假桥无头冒烟（改了首页卡片 / 跳转必跑；需本机 Chrome）
npm run goods:ui      # 「货与成本」页假桥无头冒烟（改了该页接线必跑；需本机 Chrome）
npm run shipping-rate:ui # 运费岛假桥无头冒烟（两个来回：冷启动空态 / 运价表迁移；改了岛的计价接线必跑；手写岛无构建，这是唯一可自动化的真点）
npm run format       # Prettier 写入（.prettierrc；存量代码尚未全量格式化，慎用大面积 --write）
npm run format:check # Prettier 只检查
npx vue-tsc --noEmit # 渲染进程 + tests 类型检查（本地 devDependency 为 2.x；勿 npx 拉取最新 3.x，与项目 TS 5.4 不兼容）
npx tsc -p tsconfig.electron.json --noEmit  # 主进程类型检查
```

- 每次改动后：`npm run lint` 无 error → `npm run verify` 通过 → `npm test` 全绿 → `npx vue-tsc --noEmit` 通过 → `npm run build` 通过 → 手动验证涉及流程（启动/导入/预览/复制/设置/主题切换）。
- **动了主进程数据层（表形状 / SQL / 迁移）时，额外跑该域冒烟**（如 `npm run product:sku:smoke`）**与 `npm run schema:smoke`** ——
  DB 层没有 vitest 覆盖（`better-sqlite3` 的 Electron ABI 与系统 Node 不同，见 §6.3），冒烟是唯一自动化门禁。
- **改了 `electron/preload.ts` 里任何"把渲染层参数拼成载荷"的方法时，额外跑 `npm run ipc:shape:smoke`** ——
  `npm run verify` 只核**通道名**三方一致，看不见**载荷形状**；形状错了是**静默**失效
  （最刺眼的一例：`orderImageThumbBatch` 声明收裸数组、实现只读 `payload.items` ⇒ 4 个内置页面
  的缩略图全部空占位且 console 一条错都不报，2026-10-04 修）。
- **动了文档目录 / 删了任何 `.md` / 改了引用路径时，额外跑 `npm run verify:docs`**。它挡的是"读者点开一个不存在的文件"这类损伤——lint 与 tsc 都看不见。豁免表（脚本头部 `DELIBERATELY_MISSING`）只承接**文档正在陈述"该路径不存在"**的句子，每项必写理由，见 §6.2 的同类约定。同一命令还带 **④ 反向守卫**：查 `docs/notes/` 的笔记是否命名合规且已登记索引（见 §0），零条目时会显式打印"未验证任何内容"。
- 改 CSS 令牌 / 纯样式时若构建受网络/审批影响，可用 lint + 逻辑审查兜底判断风险。
- 无 CI（见 §6.4），以上命令**本地手动执行**是唯一门禁。

### 6.0.1 主进程类型严格度（R3-4 落地，有意决策）

`tsconfig.electron.json` 为 **`strict: false` + `noImplicitAny: true`**。这是渐进收紧的中间态，不是遗漏：

- `noImplicitAny` 已于 R3-4 开启：隐式 `any` 一律报错。写法约定——**允许显式 `any`，禁止隐式**；
  事件回调参数用 `(payload: any)` / `(_e: any)` 显式标注。
- 主进程经 `require('electron')` / `require('./xxx')` 引入的模块是 `any`（CommonJS require 无类型）。
  需要**上下文类型**的调用点（如 `net.request` 的 response 回调、`register/handle` 的 handler 回调）
  必须写成 `require('electron') as typeof import('electron')` 这类断言取回真实类型——
  R3-4 在 5 个 handler 文件 + http-client + plugins-market 已如此处理，新增文件沿用。
- **不要一步开全 `strict`**：主进程 26 文件/11k+ 行，全开会产生大量 strictNullChecks 错误；
  后续按目录/文件渐进推进（新文件可从严，存量文件改造时顺带收紧）。
- 渲染层（`tsconfig.json`）保持 `strict: true` 不动。

### 6.1 lint 门禁说明（R2-3 落地）

`eslint.config.mjs` 覆盖 `src/**`、`electron/**`、`scripts/**` 与根级构建配置（`extensions/**` 的覆盖随 2026-09-30 C3 删除留档而移除）；
`ui-plugins/**` 是独立子包（各自工具链与发布流程），不在本 lint 图内。

| 规则                                 | 级别      | 说明                                                                                                                                                                                                  |
| ------------------------------------ | --------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `vue/no-restricted-class`            | **error** | §1.6 令牌纪律的自动拦截：调色板类（`text-white`/`bg-gray-500`/`hover:bg-black/20`…）与任意值色（`text-[#fff]`）一律不允许；唯一例外是图片遮罩（见 `ProductLibraryView.vue` 内的 `eslint-disable` 块） |
| `no-console`                         | warn      | 渲染层 console 属调试残留；确需保留的诊断输出用 `// eslint-disable-next-line no-console` 注明理由                                                                                                     |
| `@typescript-eslint/no-explicit-any` | warn      | 存量 300+ 处，逐步收敛（不设 error 以免阻塞）                                                                                                                                                         |

**已知覆盖边界**：`vue/no-restricted-class` 不解析**三元/逻辑表达式**里的类名，例如
`:class="ok ? 'text-white' : 'text-[var(--wb-text)]'"` 会漏检；核心 ESLint 规则又看不到
`<template>` 内部（模板 AST 不在核心遍历键内），无法用 `no-restricted-syntax` 兜底。
**因此禁止在三元/`&&` 分支里写调色板类名——这是必须靠 code review 补位的残余缺口。**

**Prettier 现状（重要）**：`.prettierrc` 已按现有代码的主导风格固化（单引号 / 分号 / 2 空格 / 100 列），
但**存量 125 个文件尚未按该规则格式化**，故 `npm run format:check` 当前必然失败，**不纳入门禁**。
新写/新改的文件可按 Prettier 风格产出；仓库级一次性格式化需单独决策（会产生 125 文件的机械 diff）。

### 6.2 IPC 契约校验（R2-4 落地）

`npm run verify` → `scripts/check-ipc-contract.mjs`，从源码**动态提取**三份清单并求差：

| 清单              | 来源                                                               | 提取方式                                                                                              |
| ----------------- | ------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------- |
| A. API 暴露键     | `electron/preload.ts` 的 `exposeInMainWorld('electronAPI', {...})` | 花括号配对 + 顶层键扫描                                                                               |
| B. 类型声明       | `src/types.ts` 的 `interface ElectronAPI`                          | 同上（掩码掉字符串/注释后处理，不受嵌套对象干扰）                                                     |
| C. 主进程注册通道 | `electron/**/*.ts`                                                 | `ipcMain.handle/on` 直调 + **包装式注册**（本地 `handle<T>()` / `register()` 等函数，动态识别函数名） |

校验项：① A ⇔ B 集合对称（**C-02 复发防护**）② A 调用的通道必须都在 C 中被注册 ③ 广播事件
（`webContents.send` ↔ preload `ipcRenderer.on`）双向对称 ④ C 中无人调用的通道 → 仅提示不失败。

**主进程的两种注册契约**（`electron/ipc-util.ts`，不可混用）：

| 封装                         | handler 返回                                    | 适用                                                                                                       |
| ---------------------------- | ----------------------------------------------- | ---------------------------------------------------------------------------------------------------------- |
| `register(channel, handler)` | 自行返回 `{ success, data?, error? }`           | 需在 handler 内做入参校验并主动回传 `{success:false,error:'invalid payload'}` 的写型域（order / purchase） |
| `handle<T>(channel, fn)`     | 只返回数据，由本层包成 `{ success:true, data }` | 查询型域（ae / mail / shop-accounts）                                                                      |

**维护约定（重要）**：新增通道的正确顺序是
**主进程 handler → preload 暴露键 → 补 `src/types.ts` 声明 → `npm run verify` 通过**。
校验报错时不要把差异项直接塞进豁免清单；豁免清单（脚本头部 `API_WITHOUT_CHANNEL` /
`BROADCAST_EVENTS` / `SHARED_CHANNELS`）只承接语义上本就不一一对应的项，每项都要写理由。

**包装名是跨文件解析的**：脚本会先扫出所有"函数体里含 `ipcMain.handle/on`"的函数名（含
`import { register as xx }` 这类别名），再在全仓收集这些名字的调用点。因此把注册封装抽到
共享模块（如 `ipc-util.ts`）后无需改脚本；但**调用点若在 `wrappers` 集合之外**（例如用字符串
变量拼通道名、或经别的抽象间接注册），校验会漏 —— 这类写法不要用。

### 6.3 单元测试（R2-5 落地）

`npm test` → vitest（`vitest.config.mts`，`environment: 'node'`，固定 `TZ=Asia/Shanghai` 以免日期断言随机器时区漂移）。

- **覆盖范围**（当前 37 个文件；用例数随门禁输出为准，不在此写死）：
  ① `src/lib/` 纯函数层——`excelParser` / `templateEngine` / `fieldProcessor` /
  `orderRowSplitter` / `orderImportRow`（一行订单→落库字段：店铺名/主图 URL 的口径）/
  `aggregator` / `orderClassifier` / `styleMatcher` / `colorSwatch` /
  `orderCost`（订单利润口径）/ `settleImport`（结算明细解析：等式校验 + 行类型判定）；
  ①' **主进程侧的纯函数层**同样单独成文件以便被 vitest 覆盖：`electron/shopName.ts` / `shopSku.ts`（零依赖），
  以及 `electron/orderMoney.ts`（订单金额/状态/时点解析）——`*-db.ts` 因 Electron ABI 进不了 vitest，故摘出来；
  ② `electron/ipc-util.ts` 的 IPC 注册契约（`tests/ipcUtil.spec.ts` 用 `vi.mock('electron')` 假 ipcMain，
  钉住返回形状、异常兜底、两套 fallback 文案——**主进程现注册 137 个通道**都经它注册，改错即全盘失效。
  该数字随 handler 增减变化，以 `npm run verify` 输出为准）；
  ③ **插件体系静态守卫**——`pluginManifest`（manifest schema）/ `pluginSettingsIsland`（岛设置分类聚合）/
  `pluginTriage`（红线 23：预设不得占用岛 id；岛的 db 调用必须全在 manifest 声明内）/ `uiIslandThemeTokens`（岛主题令牌 =
  注入清单 ⊇ 宿主定义；**且岛内元素级不得写死 `color-scheme`、不得用 `[data-theme=...]` 选择器**——两者都会让
  深色主题下的原生控件发白，见 §1.6）。
  ④ **UI 岛宿主桥行为**——`uiBridgeHost`：自建 window/document 桩（不引 jsdom），钉住
  「hello 不轮转 token」「token 不匹配的 call 必须回错包」「boot/theme 载荷带 theme.mode」「dispose 发得出 abort」。
  ③+④ 之外还有**接线守卫** `uiIslandBridgeLifecycle`：钉住「切岛必须重建桥（`:key` + `bridgePluginId`）」
  「桥运行时必须随包分发（builder files 收录、且不被 tsc 重写）」「宿主 `UI_MSG` 与 runtime `TYPE` 消息字面量一致」
  「启动时**先发现外置插件/岛、再恢复上次所在模块**（顺序反了岛就恢复不到，静默回落）」——
  这几条都属于**静默失效**（不报错、页面只是空白 / 只是"没回到上次那个岛"），只在真机点击时暴露，故既做静态守卫也做冒烟
  （`npm run plugins:island:smoke`：逐岛点击断言握手 + **重启一次**断言恢复；清单见
  `docs/architecture/UI_ISLAND_INTAKE_CHECKLIST.md`）。
  写这类时序断言时**只在 `onMounted` 体内比对调用点**：对整个文件 `indexOf('pm.discoverExternal()')` 命中的是函数
  **定义**，把调用挪到恢复之后仍然全绿（已踩过）。
  **组件、Pinia store、主进程业务逻辑、插件 Worker 沙箱运行时均无自动化覆盖**，这些改动仍须手动回归；
  岛本身还有一层无头冒烟（见技能 `esm-spa-headless-smoke`），别把"测试全绿"当成整体已验证。
- **夹具**：一律用 `tests/fixtures/` 内自造的小 Excel（`node tests/fixtures/generate-fixtures.mjs` 可重新生成，
  已入库）。**不得依赖根目录 `导出测试.xlsx`**——它被 `.gitignore` 忽略，他机不存在。
- **断言纪律**：钉住契约（缺失字段标记、两位小数四舍五入、记录 id 起始值与空行间隙、掩码优先级等），
  不要复述实现。新增/改动 `src/lib/` 逻辑时同步补用例。
  本仓测试网已用变异测试抽查：去掉 `round()`、把 `id` 起始值偏移 +100、把缺失标记改成空串，
  三种变异都会被立即拦下（漏检的那次已补用例修掉）。
- **类型一致性**：`tests/**/*.ts` 已纳入 `tsconfig.json` 的 `include`，`npx vue-tsc --noEmit` 会一并检查，
  避免出现"测试里的对象形状与实现类型脱节"。
  注意**「类型标必填、运行时却有兜底」**这类脱节只能在用例里显式断言：
  `aggregator.ts` 曾用 `PivotSpec` 把 `measures` 标为必填、实现里却有 count 兜底，覆盖该分支
  靠的就是用例里的 `withoutMeasures` 断言（该模块**及其用例**已随 2026-10-05 的孤儿代码清理删除，
  例子没了、纪律保留：新写纯函数不要再造这种"类型与运行时两套口径"）。
- **版本配套**：vitest 固定 2.x（与 vite 5 同代）。升 vite 8 时须同步评估 vitest 版本（见 R3-1）。

### 6.4 尚无 CI（已知缺口）

`.github/workflows` 不存在，上述门禁全靠本地手动执行。是否补 CI 属独立决策（见 `REMEDIATION_PLAN.md`
§5「不建议在本计划内做的事」）；在此之前，**提交前请自行跑完 §6 的四项检查**。

---

## 7. 已知历史问题与规避

| 问题                                    | 规避方式                                                                              |
| --------------------------------------- | ------------------------------------------------------------------------------------- |
| electron-store v8+ ESM-only             | 主进程动态 `import()` 加载，失败降级 SimpleStore（已实现，勿改）                      |
| macOS 打开闪退（ElectronAsarIntegrity） | afterPack.js 自动移除该 key                                                           |
| 深色主题白字白底                        | 主色底文字一律 `--wb-primary-contrast`                                                |
| 深色主题输入框白底                      | 全局 `@layer components` 规则统一（见 §1.6）                                          |
| 硬编码默认模板路径                      | 经 `get-default-template-path` IPC（已修复，禁止回退硬编码）                          |
| 设置页定位                              | `open-settings` 全局事件 + initialCategory/initialTab（禁止组件间传 store 定位）      |
| 菜单 hover 反馈不可见                   | 使用 `--wb-hover`（浅色 #e8ebf0）或 `--wb-primary-soft`；自定义 div 需自行加 hover 态 |
| 业务接口 `Record` 遮蔽 TS 内置类型      | 已重命名为 `RecordItem`；新类型命名避开内置工具类型（见红线 13）                      |
| 主进程多 .ts 文件顶层变量全局冲突       | 每个主进程 .ts 文件头部加 `export {}` 模块标记（见红线 12）                           |
| 渲染层跨域（CORS）                      | 走网络模块：axios IPC adapter → Electron `net`（见 §1.7），禁止业务侧自行 fetch       |
| vue-tsc 版本不兼容                      | 已装本地 devDependency `vue-tsc@2.x`（匹配 TS 5.4）；勿用 npx 装最新版                |
