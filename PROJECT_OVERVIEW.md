# SellerKit - IPTV 模板复制工具 项目分析报告

## 一、项目概述

**SellerKit** 是一款基于 **Electron + Vue 3 + TypeScript** 的跨平台桌面应用，核心功能为：导入 Excel 数据并根据可配置模板生成文本内容，一键复制到剪贴板，并智能跟踪使用状态。项目适用于批量数据模板填充场景（如文案生成、批量回复等）。

---

## 二、项目文件结构

```
iptv/
├── electron/                     # Electron 主进程代码
│   ├── main.ts                   # 主进程入口：窗口管理、IPC 处理、持久化存储
│   └── preload.ts                # 预加载脚本：安全暴露 IPC API 给渲染进程
├── src/                          # Vue 渲染进程代码
│   ├── components/               # Vue 组件
│   │   ├── AppToast.vue          # 全局 Toast 通知组件
│   │   ├── DropZone.vue          # 拖拽导入区域（包裹记录列表）
│   │   ├── PreviewPanel.vue      # 右侧预览面板
│   │   ├── RecordItem.vue        # 单条记录展示项
│   │   ├── RecordList.vue        # 记录列表容器
│   │   ├── TemplateManager.vue   # 模板管理面板（侧边抽屉）
│   │   └── ToolBar.vue           # 顶部工具栏（搜索/筛选/导入/模板/撤销/重置）
│   ├── lib/
│   │   ├── excelParser.ts        # Excel 文件智能解析引擎
│   │   └── templateEngine.ts     # 模板占位符替换引擎
│   ├── stores/
│   │   └── app.ts                # Pinia 全局状态管理（核心逻辑）
│   ├── styles/
│   │   └── index.css             # 全局样式（Tailwind + 自定义动画/滚动条）
│   ├── App.vue                   # 根组件（布局编排 + 键盘快捷键）
│   ├── env.d.ts                  # Vite 环境类型声明（.vue 模块声明）
│   ├── main.ts                   # Vue 应用入口（创建 App + Pinia）
│   └── types.ts                  # TypeScript 类型定义（核心接口/全局声明）
├── scripts/
│   ├── afterPack.js              # electron-builder 打包后钩子（移除 asar 完整性校验）
│   └── gen-icon.js               # 应用图标生成脚本（生成 PNG 图标）
├── build/                        # 构建资源（图标等）
├── dist/                         # 构建输出目录
├── release/                      # 打包输出目录
├── index.html                    # HTML 入口
├── package.json                  # 项目配置与依赖
├── vite.config.ts                # Vite 构建配置
├── tailwind.config.js            # Tailwind CSS 配置
├── postcss.config.js             # PostCSS 配置
├── tsconfig.json                 # 渲染进程 TypeScript 配置
├── tsconfig.electron.json        # 主进程 TypeScript 配置
├── tsconfig.node.json            # Vite 配置 TypeScript 配置
├── electron-builder.yml          # electron-builder 打包配置
├── Requirements.md               # 详细需求文档
├── 导出测试.xlsx                 # 测试用 Excel 数据文件
└── 测试模板.txt                   # 测试用模板文件
```

---

## 三、架构分层与依赖关系

### 整体架构（双进程模型）

```
 ┌─────────────────────────────────────────────────────────────┐
 │                    Electron 主进程                           │
 │  ┌──────────────────────────────────────────────────────┐   │
 │  │  main.ts                                              │   │
 │  │  - 窗口管理 (BrowserWindow)                            │   │
 │  │  - 系统对话框 (dialog.showOpenDialog)                  │   │
 │  │  - 文件读写 (fs)                                      │   │
 │  │  - 剪贴板操作 (clipboard.writeText)                    │   │
 │  │  - 持久化存储 (electron-store / SimpleStore 回退方案)    │   │
 │  │  - IPC 处理器 (9 个通道)                                │   │
 │  └───────────────┬──────────────────────────────────────┘   │
 │                  │ contextBridge（安全桥接）                  │
 │  ┌───────────────▼──────────────────────────────────────┐   │
 │  │  preload.ts                                           │   │
 │  │  - 暴露 electronAPI 对象到 window 全局                  │   │
 │  │  - 方法：selectExcel / importExcelByPath / selectTemplate│  │
 │  │          saveTemplate / writeClipboard / loadState     │   │
 │  │          saveState / checkFileExists / readFile        │   │
 │  └──────────────────────────────────────────────────────┘   │
 ├─────────────────────────────────────────────────────────────┤
 │                    渲染进程（Vue 3 应用）                     │
 │  ┌──────────────────────────────────────────────────────┐   │
 │  │  src/main.ts → App.vue (挂载点)                       │   │
 │  │  ┌─────────────────────────────────────────────────┐  │   │
 │  │  │  Pinia Store (app.ts) — 全局状态管理中心          │  │   │
 │  │  │  ├─ 状态: records/headers/selectedId/...         │  │   │
 │  │  │  ├─ 计算属性: filteredRecords/selectedRecord/... │  │   │
 │  │  │  └─ 方法: importExcel/copyAndMark/undo/...       │  │   │
 │  │  └─────────────────────────────────────────────────┘  │   │
 │  │  ┌───────────┐ ┌──────────┐ ┌───────────────────┐    │   │
 │  │  │ ToolBar   │ │ DropZone │ │ PreviewPanel      │    │   │
 │  │  │ RecordList │ │ AppToast │ │ TemplateManager   │    │   │
 │  │  │ RecordItem │ │          │ │                   │    │   │
 │  │  └───────────┘ └──────────┘ └───────────────────┘    │   │
 │  │  ┌────────────────────────────────────────────────┐   │   │
 │  │  │  lib/                                          │   │   │
 │  │  │  ├─ excelParser.ts  (xlsx 库)                   │   │   │
 │  │  │  └─ templateEngine.ts (正则替换引擎)             │   │   │
 │  │  └────────────────────────────────────────────────┘   │   │
 │  └──────────────────────────────────────────────────────┘   │
 └─────────────────────────────────────────────────────────────┘
```

### 进程间通信（IPC）通道

| 通道名 | 方向 | 功能 |
|---|---|---|
| `select-excel` | 渲染进程 → 主进程 | 打开文件对话框选择 Excel 文件 |
| `read-file` | 渲染进程 → 主进程 | 根据路径读取文件（Excel 或文本） |
| `select-template` | 渲染进程 → 主进程 | 打开文件对话框选择模板文件 |
| `save-template` | 渲染进程 → 主进程 | 写入模板文件 |
| `write-clipboard` | 渲染进程 → 主进程 | 写入剪贴板 |
| `get-store` | 渲染进程 → 主进程 | 读取持久化状态 |
| `set-store` | 渲染进程 → 主进程 | 写入持久化状态 |
| `check-file-exists` | 渲染进程 → 主进程 | 检查文件是否存在 |

---

## 四、组件依赖树

```
App.vue
├── AppToast.vue                    [全局 Toast 通知，浮动固定定位]
├── ToolBar.vue                     [顶部工具栏]
│   ├── 搜索框（绑定 store.searchQuery）
│   ├── 筛选按钮组（全部/未使用/已使用）
│   ├── 导入Excel按钮（→ store.selectExcelFile）
│   ├── 模板配置按钮（→ store.showTemplateManager = true）
│   ├── 撤销按钮（→ store.undo）
│   └── 重置按钮（→ store.resetAll）
├── DropZone.vue → <slot>           [拖拽区域容器]
│   └── RecordList.vue              [记录列表]
│       └── RecordItem.vue × N      [单条记录项]
└── PreviewPanel.vue                [右侧预览面板]
    ├── 模板替换结果预览（v-html）
    ├── 字段详情（可折叠）
    └── 操作按钮（复制/撤销）

<!-- 模态层（条件渲染） -->
TemplateManager.vue                 [模板管理侧边抽屉]
├── 模板列表（左侧）
├── 模板编辑器（右侧，textarea + 自动补全）
└── 操作按钮（保存/删除/设为当前）
```

---

## 五、核心数据流

### 5.1 数据模型（types.ts）

```typescript
/** 核心记录 */
Record {
  id: number;                      // 行号（从1开始）
  fields: Record<string, string>;  // 列名 → 单元格值
  used: boolean;                   // 是否已使用
  order: number;                   // 排序号（未使用=行号，已使用从10000开始）
}

/** 模板配置 */
TemplateConfig {
  id: string;
  name: string;
  filePath: string;                // 对应文件路径
  content: string;                 // 模板内容快照
}

/** 持久化状态 */
AppState {
  lastExcelPath: string;           // 上次导入的 Excel 路径
  lastTemplatePath: string;
  records: Record[];
  templateConfigs: TemplateConfig[];
  activeTemplateId: string;
}
```

### 5.2 主要业务流程

```
① 启动流程
   App.vue onMounted → store.init()
   → loadState() 恢复持久化状态
   → loadDefaultTemplate() 加载默认模板
   → checkFileExists(lastExcelPath) 自动加载上次 Excel

② Excel 导入流程（3种方式）
   ├─ 拖拽导入: DropZone.vue onDrop → file.arrayBuffer() → store.importExcel()
   ├─ 按钮选取: ToolBar.vue → store.selectExcelFile() → IPC select-excel → store.importExcel()
   └─ 自动加载: store.init() → IPC read-file → store.importExcel()
   └──→ excelParser.parseExcel(buffer) 智能解析
       → 更新 records / headers
       → 如果路径相同且行数一致，保留已有 used/order 状态
       → scheduleSave() 自动持久化

③ 复制流程
   用户点击/双击/Enter → store.copyAndMark(record)
   → templateEngine.renderTemplate(template.content, record.fields) 生成文本
   → IPC write-clipboard 写入剪贴板
   → 标记 record.used = true，调整 order
   → push 撤销栈 (undoStack)
   → scheduleSave()

④ 撤销流程
   用户 Ctrl+Z / 撤销按钮 → store.undo()
   → undoStack.pop() 获取上次操作
   → 恢复记录之前的 used/order
   → scheduleSave()

⑤ 模板管理流程
   TemplateManager 侧边面板
   ├─ 导入模板: IPC select-template → store.addTemplate()
   ├─ 新建空白: store.addTemplate()
   ├─ 编辑模板: textarea 绑定内容，输入 {{ 时触发自动补全
   ├─ 保存模板: store.saveTemplateToFile() → IPC save-template + store.updateTemplate()
   ├─ 切换模板: store.setActiveTemplate()
   └─ 删除模板: store.removeTemplate()
```

### 5.3 状态管理（Pinia Store）

Store `app.ts` 是应用的核心枢纽，集中管理所有状态和业务逻辑：

| 类别 | 内容 |
|---|---|
| **响应式状态** (ref) | records, headers, selectedId, searchQuery, filterMode, templateConfigs, activeTemplateId, isLoading, toasts, undoStack, showTemplateManager 等 |
| **计算属性** (computed) | activeTemplate, filteredRecords, selectedRecord, previewHtml, usedCount, unusedCount, totalCount |
| **业务方法** | init, importExcel, selectExcelFile, loadExcelByPath, copyAndMark, undo, resetAll 等 |
| **模板管理方法** | addTemplate, removeTemplate, updateTemplate, setActiveTemplate, importTemplateFile, saveTemplateToFile |
| **状态持久化** | loadState (初始化时), saveState / scheduleSave (debounce 500ms) |

---

## 六、核心模块详解

### 6.1 Excel 解析引擎 (`src/lib/excelParser.ts`)

- 使用 `xlsx` 库读取第一个工作表
- **智能解析策略**：
  1. 移除首尾空行
  2. 第一个非空行作为表头
  3. 重复列名自动去重（添加 `_1`, `_2` 后缀）
  4. 跳过数据行中的空行
  5. 构建 `Record[]` 数组
- 返回 `{ headers: string[], records: Record[] }`

### 6.2 模板引擎 (`src/lib/templateEngine.ts`)

- **渲染函数** `renderTemplate`: `/\{\{(.+?)\}\}/g` 正则替换占位符，缺失字段显示 `[字段缺失: xxx]`
- **预览函数** `previewTemplate`: 对替换结果进行 HTML 转义并添加颜色标记（蓝色=成功替换，红色=字段缺失）
- **提取函数** `extractPlaceholders`: 提取模板中的所有占位符

### 6.3 主进程存储 (`electron/main.ts`)

- 优先使用 `electron-store` 库进行持久化
- 如果加载失败，回退到基于 `JSON` 文件的 `SimpleStore`（存储到 `app.getPath('userData')/config.json`）

### 6.4 快捷键系统

在 `App.vue` 中通过全局 `keydown` 事件监听：
| 快捷键 | 功能 |
|---|---|
| `↑` / `↓` | 上/下移动选中记录 |
| `Enter` | 复制当前记录到剪贴板并标记已使用 |
| `Ctrl+Z` / `Cmd+Z` | 撤销上次操作 |

---

## 七、构建与部署

### 开发启动
```bash
npm run dev     # concurrently 同时启动 Vite + Electron
```

### 构建流程
```bash
npm run build   # Vite build + tsc 编译 Electron 代码
npm run dist    # build + electron-builder 打包
```

### 打包目标
| 平台 | 命令 | 生成格式 |
|---|---|---|
| macOS | `npm run dist:mac` | `.dmg` + `.zip` (arm64) |
| Windows | `npm run dist:win` | `.exe` (nsis) + portable |
| 所有平台 | `npm run dist:all` | 同时构建 Mac + Windows |

### 关键构建配置 (`electron-builder.yml`)
- 额外资源：打包时包含 `测试模板.txt`
- macOS：`afterPack` 脚本移除 `ElectronAsarIntegrity` 解决未签名构建的辅助进程加载问题
- 输出目录：`release/`
- 应用 ID：`com.sellerkit.app`

---

## 八、配置清单

| 配置文件 | 用途 |
|---|---|
| `vite.config.ts` | Vite 构建配置：Vue 插件、路径别名 `@/`、输出到 `dist/renderer` |
| `tailwind.config.js` | Tailwind CSS 扫描范围：`index.html` + `src/**/*.{vue,js,ts,jsx,tsx}` |
| `postcss.config.js` | PostCSS 集成 Tailwind + Autoprefixer |
| `tsconfig.json` | 渲染进程 TS 配置：ES2020 target, `@/*` 路径别名 |
| `tsconfig.electron.json` | 主进程 TS 配置：CommonJS 模块, 输出到 `dist/electron` |
| `electron-builder.yml` | Electron 打包配置：平台目标、图标、额外资源、afterPack |

---

## 九、已实现功能对照

| 功能 | 状态 | 实现位置 |
|---|---|---|
| Excel 导入（按钮 + 拖拽 + 自动加载） | ✅ 已实现 | `ToolBar.vue` / `DropZone.vue` / `store.init()` |
| 智能解析（去空行/去重列名） | ✅ 已实现 | `excelParser.ts` |
| 记录列表展示 | ✅ 已实现 | `RecordList.vue` + `RecordItem.vue` |
| 搜索与筛选（全部/未使用/已使用） | ✅ 已实现 | `ToolBar.vue` + `store.filteredRecords` |
| 模板占位符替换并复制到剪贴板 | ✅ 已实现 | `templateEngine.ts` + `store.copyAndMark()` |
| 复制后标记已使用 + 状态移动 | ✅ 已实现 | `store.copyAndMark()` |
| 撤销 / 重置 | ✅ 已实现 | `store.undo()` / `store.resetAll()` |
| 多模板管理（添加/编辑/删除/切换） | ✅ 已实现 | `TemplateManager.vue` |
| 模板占位符自动补全 | ✅ 已实现 | `TemplateManager.vue onTemplateInput` |
| 状态持久化（electron-store） | ✅ 已实现 | `electron/main.ts` + `store.scheduleSave()` |
| 键盘快捷键 | ✅ 已实现 | `App.vue handleKeydown` |
| Toast 通知 | ✅ 已实现 | `AppToast.vue` |
| 跨平台打包（Mac + Win） | ✅ 已实现 | `electron-builder.yml` |
| 构建后处理（macOS Info.plist 修复） | ✅ 已实现 | `scripts/afterPack.js` |
