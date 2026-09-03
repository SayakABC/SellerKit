# SellerKit 重构计划（REFACTOR_PLAN）

> 状态：**方案已锁定**（Phase 0 已完成并通过验证）
> 目标：在不影响现有功能的前提下，将单体结构重构为「基础能力层 + 可插拔业务模块」分层架构，支持构建期选择打包模块、模块间隔离、可扩展。
> 关联文档：`PROJECT_OVERVIEW.md`、`AGENTS.md`

---

## 一、背景与目标

**现状痛点**
- 当前所有逻辑集中在单一 `stores/app.ts`（约 580 行），所有组件直接 import 这个全局 store，项目不存在「模块」概念。
- 任何新增业务功能都会让 `app.ts` 与 `App.vue` 持续膨胀，模块边界消失、互相耦合。
- 无法按客户/场景裁剪打包（例如只交付「Excel 复制」或「数据转换」）。

**目标**
1. 拆出**基础能力层 `core/`**：所有模块共享、且不被业务反向依赖的通用能力与布局原子。
2. 业务功能迁入**可插拔模块 `modules/`**：每个模块自带视图、私有 store、组件，彼此不直接 import。
3. 提供**通用外壳 `AppShell`**：借鉴 WorkBuddy 的左侧窄图标栏导航，简洁直观，承载所有模块。
4. **构建期裁剪**：未启用的模块完全不进入 bundle，满足「可选择打包」需求。

---

## 二、设计原则与约束

| 原则 | 说明 |
|------|------|
| 增量式、分阶段 | 每阶段独立可验证，始终保证现有功能不受影响（不一次性全量重写） |
| 单一事实源 | 模块启用清单只有 `modules.config.ts` 一处，构建自动派生注册表 |
| 模块互不耦合 | 模块之间禁止直接 import；跨模块交互只能通过 `core` 暴露的能力 |
| 依赖单向 | `modules/` → `core/` → `lib/`，禁止反向依赖 |
| 行为零改动优先 | 迁移阶段只搬代码、改 import 路径，不重写业务逻辑 |
| 命名空间隔离 | 每个模块的持久化数据落在各自 key 前缀下，互不污染 |

**已对齐的关键决策（详见第十一节）**
- 字段规则 / 模板管理：留在 `excel-copy` 模块内部（不提前升为 core 能力）。
- 构建裁剪机制：`modules.config` 清单 + profile。
- 加载方式：仅构建期裁剪（不做运行时热插拔 / 外部 asar 加载）。
- 主界面导航：左侧窄图标栏。

---

## 三、目标架构（分层）

```
┌────────────────────────────────────────────────────────────────┐
│  App.vue  →  <AppShell/>  （通用外壳：左栏导航 + 内容区渲染）       │
├────────────────────────────────────────────────────────────────┤
│  modules/  （业务模块，可插拔、可裁剪）                              │
│   ├─ excel-copy/   meta.ts + index.ts + store.ts + 私有 components │
│   └─ <new-module>/ ……                                             │
│         │ 仅依赖 ↓                                                │
├────────────────────────────────────────────────────────────────┤
│  core/  （基础能力层 + 布局原子，不被业务反向依赖）                  │
│   ├─ types.ts          模块契约 ModuleMeta / ModuleLifecycle       │
│   ├─ AppShell.vue      外壳导航                                   │
│   ├─ layout/           SplitPane / ContentHeader 等通用布局        │
│   └─ services/         ipc / toast / storage / clipboard /        │
│                        dialog / excel（Phase 1 落地）             │
│         │ 仅依赖 ↓                                                │
├────────────────────────────────────────────────────────────────┤
│  lib/  （纯函数：excelParser / templateEngine / fieldProcessor）   │
│  electron/  （主进程 + preload，保持不变）                          │
└────────────────────────────────────────────────────────────────┘
```

依赖方向严格单向：`modules → core → lib`。`core` 与 `lib` 永不直接引用任何具体模块。

---

## 四、当前目录结构（Phase 0 后现状）

```
SellerKit/
├── modules.config.ts              # 业务模块启用清单（单一事实源）
├── vite.config.ts                 # 构建时读取清单 → 生成 registry.generated.ts
├── src/
│   ├── App.vue                    # 仅渲染 <AppShell/>
│   ├── main.ts
│   ├── registry.generated.ts      # 自动生成，勿手改
│   ├── types.ts                   # 全局类型（含 interface Record，见第十节）
│   ├── lib/                       # 纯函数（不变）
│   │   ├── excelParser.ts
│   │   ├── templateEngine.ts
│   │   └── fieldProcessor.ts
│   ├── core/                      # 【新增】基础能力层
│   │   ├── types.ts               # ModuleMeta / ModuleLifecycle 契约
│   │   ├── AppShell.vue           # 外壳：左栏图标 + 内容区
│   │   └── layout/
│   │       ├── SplitPane.vue
│   │       └── ContentHeader.vue
│   └── modules/                   # 【新增】业务模块
│       └── excel-copy/
│           ├── meta.ts            # 轻量元信息（进导航，体积可忽略）
│           ├── index.ts           # 默认导出视图（激活时才动态 import）
│           ├── store.ts           # 原 stores/app.ts 原样搬入
│           ├── ExcelCopyView.vue  # 原 App.vue 业务内容
│           └── components/        # 8 个组件原样搬入
│               ├── AppToast.vue ToolBar.vue DropZone.vue RecordList.vue
│               ├── RecordItem.vue PreviewPanel.vue ColumnSelector.vue
│               └── TemplateManager.vue FieldRuleManager.vue
└── electron/                      # 主进程 + preload（未改动）
```

---

## 五、核心机制

### 5.1 模块契约（meta / index 双层）

模块拆成两个文件，使「导航渲染」与「视图加载」解耦——`meta` 始终静态打包（轻量），`index`（重量级视图）仅在模块被激活时动态加载：

```ts
// modules/<id>/meta.ts
import type { ModuleMeta } from '@/core/types';
export const meta: ModuleMeta = { id: 'excel-copy', name: 'Excel 模板复制', icon: 'table', order: 1 };

// modules/<id>/index.ts
import ExcelCopyView from './ExcelCopyView.vue';
export default ExcelCopyView;
```

`ModuleLifecycle`（激活/停用钩子）已在 `core/types.ts` 定义，Phase 2 接入：

```ts
export interface ModuleLifecycle {
  activate?: () => void | Promise<void>;
  deactivate?: () => void | Promise<void>;
}
```

### 5.2 构建期裁剪（清单 → 自动生成注册表）

`vite.config.ts` 在构建启动时读取 `modules.config.ts` 的 `enabledModules`，生成 `src/registry.generated.ts`：

```ts
// AUTO-GENERATED — 只 import 启用模块的 meta 与 index
import * as excelcopy from '@/modules/excel-copy/meta';
export const enabledModuleMetas = [excelcopy.meta];
export const moduleViewLoaders: Record<string, () => Promise<any>> = {
  'excel-copy': () => import('@/modules/excel-copy/index'),
};
```

**裁剪生效原理**：未出现在 `enabledModules` 的模块不会被任何源码引用，`vite build` 的 tree-shaking 会将其完全排除出 bundle。已验证：`excel-copy` 视图被打入独立的懒加载 chunk（`index-DIhLffQF.js`），入口 chunk 仅动态 `import()` 它，`ExcelCopyView` 定义只存在于懒加载块中。

`AppShell.vue` 在 `onMounted` 时读取 `enabledModuleMetas` 渲染左栏，点击后通过 `moduleViewLoaders[id]()` 懒加载视图。

### 5.3 模块命名空间持久化（Phase 1 落地）

每个模块的持久化数据落在 `modules.<id>.*` 前缀下，重置单个模块不会误伤其他模块（替代当前全局 store 的单 key 方案）。

---

## 六、模块开发规范（新增一个模块的标准流程）

1. 在 `src/modules/<id>/` 下创建：
   - `meta.ts`：导出 `ModuleMeta`（填 `id` / `name` / `icon` / `order`）
   - `index.ts`：默认导出一个 Vue 组件作为模块视图
   - 模块私有 `store.ts` 与 `components/`
2. 在 `modules.config.ts` 的 `enabledModules` 数组加入 `'<id>'`（构建自动纳入）
3. 模块内只 `import` 自 `core/` 与 `lib/`，**禁止** `import` 其他模块
4. 持久化通过 `core/services/storage` 的 `useModuleStorage('<id>')` 访问

---

## 七、分阶段实施计划

### ✅ Phase 0 · core 骨架 + 注册表 + 迁移（已完成）
- 新增 `core/types.ts`、`AppShell.vue`、`layout/SplitPane`、`layout/ContentHeader`
- 新增根 `modules.config.ts` + `vite.config.ts` 生成 `registry.generated.ts`
- 迁移 `excel-copy`：`stores/app.ts` + 8 组件原样搬入，行为零改动
- 删除旧 `src/components`、`src/stores`；`App.vue` 改为只渲染 `<AppShell/>`
- **验收**：`npm run build` 通过；dev server 全部模块 HTTP 200；懒加载 chunk 拆分正确 ✅

### 🔲 Phase 1 · 基础能力服务化（`core/services`）
**目标**：把散落在模块内的能力收敛为 `core` 服务，模块不再直接依赖 `window.electronAPI` / 全局 store。

| 服务文件 | 职责 | 替代现状 |
|----------|------|----------|
| `core/services/ipc.ts` | 类型安全地封装 `window.electronAPI`（从 preload 提取 `ElectronApi` 接口） | `store.ts: const api = () => window.electronAPI` |
| `core/services/toast.ts` | 全局 toast：`toast.success/error/info`，配 `<ToastHost/>` 挂到 AppShell | 模块内自实现的 `showToast` |
| `core/services/storage.ts` | `useModuleStorage(id)`：按命名空间 load/save(防抖)/clear | `scheduleSave` + 全局单 key |
| `core/services/clipboard.ts` | `writeClipboard(text)` | `api().writeClipboard` |
| `core/services/dialog.ts` | `selectExcelFile()` / `selectTemplateFile()` | `api().selectExcel` / `selectTemplate` |
| `core/services/excel.ts` | `importExcelFromFile(path)`（内部用 `lib/excelParser`） | 直接读 buffer 解析 |

**涉及改动**：`excel-copy/store.ts`（替换 `api()`、`showToast`、`scheduleSave`）、`ToolBar.vue`（替换 `window.electronAPI.resetStore()` 直调）、其余组件 `store.showToast` 调用改为 `core/services/toast`。
**验收**：功能不变；模块内 grep `window.electronAPI` 与全局 store 引用为 0；`npm run build` 通过。

### 🔲 Phase 2 · 外壳增强 + WorkBuddy 视觉统一
- **左侧窄图标栏**：已实现基础版，补充 hover 显示名称、激活态样式。
- **⌘K 命令面板**：跳转模块 + 执行模块内命令（低成本高「高级感」）。
- **记忆上次活动模块**：关闭再开回到上次使用的模块（存 `core` storage / localStorage）。
- **生命周期钩子**：`activate/deactivate` 接入 `ModuleLifecycle`，切走时释放资源（如停止轮询）。
- **视觉统一**：定义一套 WorkBuddy 风格 design tokens（白底、克制蓝主色、轻边框、圆角卡片、充足留白），沉淀到 `core/` 或 `src/styles`，各模块复用。
**验收**：交互流畅；视觉简洁直观；记忆恢复正确。

### 🔲 Phase 3 · 验证可插拔 + 第二模块 + 裁剪验证
- **新增最小 stub 模块**（如 `modules/hello/`），证明架构可插拔 / 可扩展。
- **裁剪真实生效**：在 `modules.config.ts` 移除某模块后 `npm run build`，验证产物中不含该模块 chunk（对比 dist 文件清单与体积）。
- **profile 真正生效**：让 `vite.config.ts` 支持按环境变量（如 `MODULE_PROFILE=minimal`）选择不同 `enabledModules` 预设（当前 `profile` 字段尚未被消费）。
- **补充 npm 脚本**：如 `dist:mac --profile=minimal`、`dist:win --profile=pro`。
**验收**：切换启用列表后，产物仅含启用模块；stub 模块可正常加载。

---

## 八、回滚策略

- 每个 Phase 开始前用 git 打 tag / 提交，阶段可独立回滚。
- Phase 0 的旧 `src/components`、`src/stores` 已删除；如需回滚到单体结构，从 git 历史恢复即可（功能代码已完整保留在 `modules/excel-copy/`）。
- 构建期裁剪是「纯新增层 + 自动生成」，不影响主进程与 `lib/`；即使 `registry.generated.ts` 生成逻辑出问题，回退 `vite.config.ts` 即可回到单体打包。

---

## 九、风险与缓解

| 风险 | 缓解 |
|------|------|
| 迁移改坏现有功能 | 行为零改动原则：只搬代码、改 import 路径；每阶段 `npm run build` + dev 冒烟验证 |
| 模块间误耦合 | 代码评审 + grep 检查跨模块 import；`core` 单向依赖约束 |
| 裁剪误删启用模块 | `modules.config.ts` 单一事实源 + 构建后校验 dist 产物 |
| 运行时热插拔需求将来出现 | 当前不做；架构已留 `meta/index` 双层与 loader 接口，将来可平滑扩展 |

---

## 十、已知遗留问题（非本次重构引入）

`src/types.ts` 中 `interface Record` 遮蔽了 TypeScript 全局 `Record<K,V>` 工具类型，导致渲染进程若执行 `tsc --noEmit` 会报 `Record is not generic`（`lib/excelParser.ts`、`fieldProcessor.ts`、`templateEngine.ts`、`store.ts` 等）。

- **根因**：原构建脚本 `tsc -p tsconfig.electron.json` 仅检查主进程，渲染进程从未被类型检查，Vite/esbuild 直接剥离类型不报错，运行时无影响。
- **处理建议**：留到单独阶段；若要开启渲染进程类型检查，需重命名该 interface（AGENTS.md 将其列为受保护底層文件，需同步所有调用方）。**本重构不处理此项**，以免扩大改动面。

---

## 十一、决策记录（已与用户对齐）

| 议题 | 结论 |
|------|------|
| 字段规则 / 模板管理归属 | 留在 `excel-copy` 模块内（不提前升为 core 能力） |
| 构建裁剪方式 | `modules.config` 清单 + profile |
| 加载时机 | 仅构建期裁剪（不做运行时热插拔） |
| 主界面导航 | 左侧窄图标栏（借鉴 WorkBuddy） |

---

## 十二、验收清单汇总

- [x] Phase 0：`npm run build` 通过；dev 全模块 200；懒加载 chunk 正确
- [ ] Phase 1：模块零 `window.electronAPI` 直调；服务化后功能不变
- [ ] Phase 2：⌘K / 记忆模块 / 生命周期 / 视觉统一 达标
- [ ] Phase 3：stub 模块可加载；裁剪产物验证通过；profile 脚本可用
