# SellerKit - 项目基线（Architecture Baseline）与编码规则

AI 编码助手和开发者在修改 SellerKit 项目时必须遵循本文件。本文档是**基线**：以当前代码实际状态为准，任何新增功能都需符合本文档描述的架构模式与编码规则。

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
- IPC 通道命名 kebab-case；preload 中每通道一个方法；新增通道必须同步更新 `src/types.ts` 的 `ElectronAPI` 接口。
- 网络请求链路：渲染层 axios（IPC adapter）→ `net-request` IPC → 主进程 `electron/http-client.ts`（Electron `net`）→ 真实 HTTP（详见 §1.7）。

### 1.2 渲染进程分层（src/）

```
src/
├── core/                       # 平台核心（禁止业务逻辑）
│   ├── AppShell.vue            # 工作台外壳：TitleBar+侧边栏+工作区+设置/命令/Toast
│   ├── components/             # TitleBar / SettingsModal / CommandPalette / ToastHost
│   ├── services/               # ipc / storage / theme / toast / clipboard / dialog / excel
│   ├── network/                # 统一网络请求（request: axios+IPC adapter / token / types）
│   └── types.ts                # ModuleMeta / ModuleDefinition / ModuleCommand 等
├── modules/<module-id>/        # 业务模块（可插拔，一个文件夹一个模块）
│   ├── meta.ts                 # 模块元信息（必须）
│   ├── index.ts                # ModuleDefinition（必须）
│   ├── store.ts                # Pinia store（setup 语法）
│   ├── <Xxx>View.vue           # 模块主视图
│   └── components/             # 模块内组件
├── lib/                        # 纯函数工具（无副作用）
├── styles/index.css            # 全局样式 + 设计令牌（--wb-*）
├── types.ts                    # 业务共享类型 + ElectronAPI 接口
├── registry.generated.ts       # ⚠️ 自动生成，禁止手改
├── env.d.ts
├── main.ts / App.vue
```

### 1.3 模块化插件体系（核心机制）

模块启停由构建期裁剪控制，链路：

```
modules.config.ts ──► vite.config.ts ──► src/registry.generated.ts ──► AppShell.vue
(buildConfig)         (读取+求值)          (自动生成 enabledModuleMetas + moduleViewLoaders)
```

关键约束：
- **`src/registry.generated.ts` 是 AUTO-GENERATED，严禁手改**；任何修改会在下次 `npm run dev/build` 被覆盖。
- `vite.config.ts` 用 esbuild 转译求值 `modules.config.ts`，因此 config 必须是**纯字面量结构**（对象/数组/字符串），禁止复杂逻辑。
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
5. 在 `modules.config.ts` 的 `enabledModules` / 相关 profile 中登记 id（确认纳入哪些打包预设）
6. 重启 `npm run dev` 自动注册；验证侧边栏出现、⌘K 可切换

### 1.4 持久化基线（命名空间隔离）

- 统一经 `src/core/services/storage.ts` 的 `useModuleStorage<T>(namespaceId)`，返回 `{ load, save, scheduleSave, clear }`。
- 数据落在 electron-store 的 `modules.<namespaceId>` key 下，**模块之间互不污染**。
- 已有命名空间：`app-shell`（外壳状态：lastActiveModuleId / collapsed）、`excel-copy`（业务状态）。
- 写操作统一 `scheduleSave(data)`（500ms 防抖）；需要立即落盘用 `save(data)`。
- **禁止**使用旧扁平 key（records/templateConfigs 等）直接读写；主进程内置 excel-copy 旧数据迁移，勿新增扁平 key。
- 持久化字段的新增/变更需保持向后兼容：读取时对缺失字段做默认值兜底（参考 `store.loadState()` 的写法）。
- Token/会话态等安全敏感状态例外：走 `src/core/network/token.ts`（localStorage `sk_auth_token`），不落 electron-store。

### 1.5 设置页扩展机制（SettingsModal）

- 左右布局：左侧分类导航（`categories` 数组）+ 右侧内容区。
- 当前分类：`general`（通用）/ `excel`（TV模版，含二级 Tab：模板配置 / 字段规则 / 显示列）。
- **设置项收拢原则**：业务功能设置一律收进设置页，内容页只留高频操作（筛选 Tab 等）。
- 模块内组件需要"打开设置页并定位"时，dispatch 全局事件（AppShell 已监听）：
  ```typescript
  window.dispatchEvent(new CustomEvent('open-settings', { detail: { category: 'excel', tab: 'columns' } }));
  ```
  AppShell 通过 `initialCategory` / `initialTab` props 传给 SettingsModal 完成定位。
- 设置面板组件同时用于"设置页内嵌"与"独立抽屉"两种形态时，用 `embedded?: boolean` prop 条件渲染外壳（参考 `TemplateManager.vue` / `FieldRuleManager.vue` / `ColumnSelector.vue`）。

### 1.6 主题设计令牌（--wb-* CSS 变量）

- **禁止在组件中硬编码色值**；一律用 `var(--wb-*)`（浅色 `:root` 与深色 `[data-theme='dark']` 两套）。
- 常用令牌：`--wb-bg / --wb-surface / --wb-surface-2 / --wb-border / --wb-text / --wb-text-muted / --wb-primary / --wb-primary-hover / --wb-primary-soft / --wb-primary-contrast / --wb-accent(-soft) / --wb-success / --wb-warning / --wb-danger / --wb-hover / --wb-overlay / --wb-radius`。
- **主色背景上的文字必须用 `--wb-primary-contrast`**（不可写死 `text-white`——深色主题下主色为冷白灰会白字白底）。
- 输入控件（input/select/textarea）由 `@layer components` 全局规则统一主题化，组件无需重复设背景/文字色；确需覆盖时用更高层类（如 `bg-transparent`）。
- 新颜色必须走令牌体系：先在 `index.css` 两套主题各定义一个 `--wb-*`，再在组件引用。

### 1.7 网络请求基线（统一走 src/core/network）

- 渲染层**禁止直接 fetch/XHR 跨域**（CORS 限制）：一律经 `src/core/network/request.ts` 的默认 axios 实例。
- 请求链路：axios（IPC adapter，默认）→ `net-request` IPC → 主进程 `electron/http-client.ts`（Electron `net`）→ 真实 HTTP。
- 引擎切换：`.env` 的 `VITE_REQUEST_ENGINE`（`ipc` 默认 / `xhr` 仅本地调试）；基础地址 `VITE_API_BASE_URL`（`.env.development` / `.env.production`），创建实例时可传 `baseURL` 覆盖。
- Token：`getToken/setToken`（`token.ts`）；请求拦截器自动附加 `Authorization: Bearer <token>`，401 响应自动清除本地 token。
- 安全边界（勿随意放宽）：`electron/http-client.ts` 协议白名单（https/http）+ 方法白名单；`preload.ts` 结构白名单消毒；`ipc-handlers.ts` 入参二次校验（URL≤8192、body≤10MB、响应≤10MB、15s 超时）。
- 使用方式：`const { data } = await http.get<T>('/api/x')`——响应**不自动解包**，保持类型安全；登录后 `setToken(...)` 写入 token。

---

## 2. 统一代码风格

### 2.1 命名规则

| 场景 | 规则 | 示例 |
|------|------|------|
| TypeScript 接口 | PascalCase（禁止与 TS 内置工具类型同名，如 Record/Partial/Omit） | `RecordItem`, `TemplateConfig`, `ModuleMeta` |
| 类型别名（联合类型） | PascalCase | `FilterMode = 'all' \| 'used' \| 'unused'` |
| Vue 组件 | PascalCase `.vue` | `PreviewPanel.vue`, `RecordItem.vue` |
| 普通 TS 文件 | camelCase `.ts` | `excelParser.ts`, `templateEngine.ts` |
| 函数/方法 | camelCase | `copyAndMark()`, `scheduleSave()` |
| Pinia 状态 | camelCase（ref/computed 不加前缀） | `records`, `filteredRecords` |
| 模块常量 | UPPER_SNAKE_CASE（仅模块级） | `MODULE_ID`, `SAVE_DEBOUNCE_MS` |
| IPC 通道名 | kebab-case 字符串 | `'get-app-version'`, `'win-control'` |
| 模块目录 / meta.id | kebab-case | `excel-copy`, `quick-note` |
| 环境变量 | `VITE_` 前缀为渲染层（`VITE_API_BASE_URL` / `VITE_REQUEST_ENGINE`）；构建期 Node 环境变量（vite.config.ts 读取）为 `MODULE_PROFILE` / `MODULE_IDS` | `VITE_API_BASE_URL`, `MODULE_IDS` |

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
  if (!ok) { toast('复制失败', 'error'); return; }
} catch (e: unknown) {
  toast(`复制失败: ${e instanceof Error ? e.message : '未知错误'}`, 'error');
  return;
}
```
主进程 IPC handler：
```typescript
ipcMain.handle('xxx', async (_e: any, ...args) => {
  try { /* ... */ return { success: true, data }; }
  catch (err: any) { return { success: false, error: err.message }; }
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

---

## 4. 文件操作边界

### 4.1 可自由修改
`src/core/components/`、`src/core/network/`（保持现有模式）、`src/modules/*/`、`src/lib/`、`src/styles/index.css`、`src/core/services/`（保持现有模式）、`modules.config.ts`（登记新模块）、`scripts/`。

### 4.2 需先理解 IPC 模式后再改
`electron/main.ts` / `electron/preload.ts`：新增/修改 IPC 必须同步 `preload.ts` 与 `src/types.ts` 的 `ElectronAPI`。
`electron/http-client.ts` / `electron/ipc-handlers.ts`：网络白名单/校验逻辑，修改需评估安全边界（见 §1.7）。

### 4.3 严格禁止修改（除非用户明确要求并确认）
`package.json` 的 `name/main/overrides`、`electron-builder.yml` 的 `appId/mac.asar/产出目录`、`vite.config.ts` 的 plugin/alias/outDir、`tsconfig*.json`、`tailwind.config.js` / `postcss.config.js`、`index.html`、**`src/registry.generated.ts`（自动生成）**。

### 4.4 底层公共工具（改动前必须搜全部调用方并逐一更新）
`src/lib/excelParser.ts`、`src/lib/templateEngine.ts`、`src/lib/fieldProcessor.ts`、`src/types.ts`、`src/env.d.ts`、`electron/preload.ts`、`src/core/services/*`、`src/core/network/*`（request/token/types）、`src/core/types.ts`。

---

## 5. 新增功能 SOP（对照检查）

| 场景 | 必须步骤 |
|------|----------|
| 新增业务模块 | 见 §1.3 SOP；meta.id 与目录一致；modules.config.ts 登记 |
| 新增模块状态 | `store.ts` 中 `defineStore` setup 语法；经 `useModuleStorage('<模块id>')` 持久化；用 `scheduleSave` |
| 新增 IPC 通道 | main.ts（或 ipc-handlers.ts）注册 handler → preload.ts 暴露 → `ipc.ts` 封装 → `src/types.ts` 声明 → 调用方只依赖服务层；主进程 .ts 记得加 `export {}` |
| 业务功能需要 HTTP 请求 | 经 `src/core/network/request.ts` 的 `http` 实例调用；Token 用 `setToken/getToken`；新域名/方法需评估 `http-client.ts` 白名单与 §1.7 安全边界 |
| 定制打包范围 | 预设：`MODULE_PROFILE=minimal npm run build`；自定义清单：`MODULE_IDS=excel-copy,quick-note npm run build`（优先级最高）；交互勾选：`npm run dist:select`；未选模块不进 bundle（见 §1.3） |
| 新增设置分类/Tab | SettingsModal 加 categories 项 / 二级 Tab 数组；面板组件实现 `embedded` 支持；如需入口定位则 dispatch `open-settings` |
| 新增 UI 颜色 | 先在 `index.css` 两套主题定义 `--wb-*`，再引用；主色底文字用 `--wb-primary-contrast` |
| 新增命令面板项 | 模块 `index.ts` 的 `commands` 数组添加 `{ id, title, shortcut?, run }` |
| 新增持久化字段 | 主进程 defaultStoreData 或模块 loadState 兜底默认值；保持向后兼容读取 |

---

## 6. 构建与验证（每次改动后）

```bash
npm run dev          # 开发（Vite HMR + Electron）
npm run build        # 生产构建（会重新生成 registry.generated.ts）
npm run dist:select  # 交互式勾选模块 → 构建 → 出安装包（scripts/select-build.js）
npm run build:select # 交互式勾选模块 → 只构建
npx vue-tsc --noEmit # 渲染进程类型检查（本地 devDependency 为 2.x；勿 npx 拉取最新 3.x，与项目 TS 5.4 不兼容）
npx tsc -p tsconfig.electron.json --noEmit  # 主进程类型检查
```

- 每次改动后：无 lint 红色波浪线 → `npm run build` 通过 → 手动验证涉及流程（启动/导入/预览/复制/设置/主题切换）。
- 改 CSS 令牌 / 纯样式时若构建受网络/审批影响，可用 lint + 逻辑审查兜底判断风险。

---

## 7. 已知历史问题与规避

| 问题 | 规避方式 |
|------|----------|
| electron-store v8+ ESM-only | 主进程动态 `import()` 加载，失败降级 SimpleStore（已实现，勿改） |
| macOS 打开闪退（ElectronAsarIntegrity） | afterPack.js 自动移除该 key |
| 深色主题白字白底 | 主色底文字一律 `--wb-primary-contrast` |
| 深色主题输入框白底 | 全局 `@layer components` 规则统一（见 §1.6） |
| 硬编码默认模板路径 | 经 `get-default-template-path` IPC（已修复，禁止回退硬编码） |
| 设置页定位 | `open-settings` 全局事件 + initialCategory/initialTab（禁止组件间传 store 定位） |
| 菜单 hover 反馈不可见 | 使用 `--wb-hover`（浅色 #e8ebf0）或 `--wb-primary-soft`；自定义 div 需自行加 hover 态 |
| 业务接口 `Record` 遮蔽 TS 内置类型 | 已重命名为 `RecordItem`；新类型命名避开内置工具类型（见红线 13） |
| 主进程多 .ts 文件顶层变量全局冲突 | 每个主进程 .ts 文件头部加 `export {}` 模块标记（见红线 12） |
| 渲染层跨域（CORS） | 走网络模块：axios IPC adapter → Electron `net`（见 §1.7），禁止业务侧自行 fetch |
| vue-tsc 版本不兼容 | 已装本地 devDependency `vue-tsc@2.x`（匹配 TS 5.4）；勿用 npx 装最新版 |
