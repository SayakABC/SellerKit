# 项目名称：IPTV 模板复制工具（跨平台桌面应用）

## 1. 项目目标
开发一个轻量、开箱即用的跨平台桌面工具，用于：
- 导入 Excel 文件（支持拖拽、按钮选择、自动加载预设路径等多种方式），**智能解析**数据内容，Excel模版格式文件地址：/Users/ck/work/work/ai/iptv/导出测试.xlsx
- 以列表形式展示解析结果
- 点击单条数据时，根据**可配置的模板**填充内容并复制到剪贴板
- 自动将该条记录标记为“已使用”，并将其移动到列表末尾（未使用记录保持原有顺序）
- 提供状态撤销、重置、模板编辑管理、搜索过滤等辅助功能

## 2. 技术栈（请严格使用）
- **桌面框架**：Electron（最新稳定版，使用 electron-builder 打包）
- **前端**：Vue 3（Composition API） + Vite + TypeScript
- **样式**：Tailwind CSS
- **状态管理**：Pinia
- **Excel 解析**：`xlsx` 库（在渲染进程中解析）
- **剪贴板访问**：通过 Electron 主进程的 `clipboard` 模块，使用 preload 脚本暴露安全 API
- **文件读取与写入**：主进程使用 `fs` 读取文件，通过 IPC 通信；文件选择使用 `dialog.showOpenDialog`；拖拽文件通过 Electron 窗口的 `will-navigate` 或渲染进程 HTML5 拖放 API 获取文件路径，再交给主进程读取
- **数据持久化**：使用 `electron-store` 存储使用记录状态、模板配置和最近文件路径

## 3. 架构与进程分工
- **主进程（main process）**：
  - 创建窗口，配置拖拽区域支持（通过 `webPreferences` 和 `preload` 暴露文件拖放路径）
  - 处理文件选择对话框
  - 读取 Excel 文件（返回 ArrayBuffer）和模板文件（返回文本）
  - 提供剪贴板写入能力
  - 管理持久化存储（`electron-store`）
  - 暴露 IPC 接口给渲染进程
- **预加载脚本（preload.ts）**：
  - 通过 `contextBridge` 暴露有限 API：
    - `selectExcel()` → 返回 `{ filePath, buffer }`
    - `importExcelByPath(filePath)` → 由拖拽或按钮触发，返回同上
    - `selectTemplate()` → 返回 `{ filePath, content }`
    - `saveTemplate(filePath, content)` → 保存模板
    - `writeClipboard(text)` → 写入剪贴板
    - `loadState()` / `saveState(data)` → 持久化状态
- **渲染进程（Vue 应用）**：
  - 负责 UI、状态管理、Excel 解析、模板引擎、交互控制
  - 实现拖拽区域监听、智能解析逻辑

## 4. 核心数据结构
每条记录：
- `id`：原始行号（从1开始）
- `fields`：对象，键为 Excel 列名，值为单元格内容（字符串）
- `used`：布尔值
- `order`：排序数字（未使用从1递增，已使用排在10000之后）

持久化存储结构：
```json
{
  "lastExcelPath": "…",
  "lastTemplatePath": "…",
  "records": [ … ],
  "templateConfigs": [
    {
      "id": "default",
      "name": "默认模板",
      "filePath": "/path/to/模板.txt",
      "content": "模板内容快照"
    }
  ],
  "activeTemplateId": "default"
}
```

## 5. 功能详述

### 5.1 导入 Excel 功能（多种方式）
- **启动自动加载**：读取持久化存储中的 `lastExcelPath`，若文件存在则自动解析。
- **拖拽导入**：
  - 在应用窗口的**列表区域或整个背景区域**监听 `dragover` 和 `drop` 事件（需要主进程禁用默认的文件拖放行为，将文件路径通过 IPC 传递给渲染进程）。
  - 过滤仅接受 `.xlsx` 文件，拖入后立即调用解析流程。
- **导入按钮**：
  - 工具栏提供“导入Excel”按钮，点击后调用主进程 `dialog.showOpenDialog` 选择文件，返回后解析。
- **智能解析**（见 5.2）

### 5.2 智能解析 Excel
- 使用 `xlsx` 库读取第一个工作表，**智能识别数据区域**：
  - 跳过完全空白的首行（有时文件前几行是空行）
  - 自动将第一个非空行作为表头（列名）
  - 忽略表头之后完全空白的行和列（连续空白才视为结束，中间个别空单元格保留为空字符串）
  - 若表头行有合并单元格，`xlsx` 会读出重复列名，需自动去重（如“姓名1”、“姓名2”改为“姓名”、“姓名_1”）
- 解析成功后，与已存储状态比对：
  - 如果当前 Excel 路径与存储的 `lastExcelPath` 相同且行数一致，则沿用已保存的 `used` 和 `order`；否则全部初始化为未使用。
- 若解析失败，显示具体错误并提示手动修正。

### 5.3 模板支持配置（增强版）
- **多模板管理**：
  - 工具栏增加“模板配置”按钮，点击打开模板管理面板（侧边抽屉或模态框）。
  - 显示已添加的模板列表，可进行以下操作：
    - **添加模板**：点击“导入模板文件”选择 `.txt` 文件，或“新建空白模板”输入内容。
    - **编辑模板**：选中一个模板，在文本编辑区修改内容，支持占位符 `{{列名}}` 实时预览。
    - **删除模板**：删除非当前激活的模板。
    - **设为当前**：选择一个模板作为当前使用的模板。
  - 当前激活的模板在预览区显示，所有复制操作均基于此模板。
- **模板占位符智能提示**：
  - 在模板编辑区输入 `{{` 时，自动弹出可用列名列表（基于当前 Excel 表头），选择后自动补全。
- **模板保存**：
  - 修改模板内容后，可保存到原 `.txt` 文件（若存在）或另存为新文件。
  - 同时将模板内容和路径存入 `electron-store` 的 `templateConfigs`，下次启动自动加载。
- **默认模板**：首次使用时，若固定路径 `/Users/ck/work/work/ai/iptv/测试模板.txt` 存在，则自动加载为默认模板并激活。

### 5.4 主界面布局（同前，略调整）
- 左侧列表区域（60%）：
  - 顶部工具栏：搜索框、筛选按钮组（全部/未使用/已使用）、重置按钮、**“导入Excel”按钮**（带图标）、**“模板配置”按钮**。
  - 整个左侧区域支持**拖拽导入**（有明显的虚线边框和提示文字，当拖入文件时高亮）。
  - 记录列表：状态图标 + 前两个字段值，已使用条目降低不透明度并加删除线。
- 右侧预览面板（40%）：
  - 显示当前激活模板名称和内容预览。
  - 预览替换后的文本。
  - 操作按钮：“复制并标记已使用”（主按钮）或“仅复制”（已使用时），撤销按钮。

### 5.5 点击与复制逻辑（核心）
（基本同前，唯一修改是复制时必须使用**当前激活的模板**，模板可能被用户切换或修改过）

- 点击未使用记录：
  - 根据**当前激活模板**的内容，将记录 `fields` 替换占位符，生成最终文本。
  - 调用 `writeClipboard` 写入剪贴板，Toast 提示。
  - 标记 `used = true`，`order` 调整为最大已使用 order +1，列表重新排序并滚动。
  - 操作入撤销栈。
- 点击已使用记录：仅复制，不改变状态。
- 撤销、重置操作同前。

### 5.6 状态持久化（增强）
- 保存内容增加：`templateConfigs` 数组，`activeTemplateId`，确保多模板和选择状态能恢复。
- 保存时机：debounce 500ms 自动保存。

### 5.7 搜索与过滤、快捷键（同前）
- 搜索、筛选按钮正常工作。
- 快捷键：`↑` `↓` 移动选择，`Enter` 执行主要复制操作，`Ctrl+Z` 撤销。

### 5.8 错误与边界处理（增加拖拽和模板相关）
- 拖入非 `.xlsx` 文件时，提示“仅支持 .xlsx 格式”。
- 模板占位符与列名不匹配时，预览中用红色标记并替换为 `[字段缺失]`。
- 模板文件被外部删除：启动时检测，标记该模板为“文件丢失”，允许用户重新关联或删除。
- 剪贴板失败提供手动复制方案。

## 6. 项目文件结构（更新）
```
iptv-template-tool/
├── electron/
│   ├── main.ts
│   ├── preload.ts
│   └── ipc-handlers.ts
├── src/
│   ├── main.ts
│   ├── App.vue
│   ├── stores/
│   │   └── app.ts          # 包含 records, templates, ui state
│   ├── components/
│   │   ├── ToolBar.vue     # 导入按钮、模板配置按钮
│   │   ├── DropZone.vue    # 拖拽导入区域包裹列表
│   │   ├── RecordList.vue
│   │   ├── RecordItem.vue
│   │   ├── PreviewPanel.vue
│   │   ├── TemplateManager.vue  # 多模板管理面板
│   │   ├── TemplateEditor.vue   # 模板编辑区
│   │   └── AppToast.vue
│   ├── lib/
│   │   ├── excelParser.ts      # 智能解析
│   │   ├── templateEngine.ts
│   │   └── electronAPI.ts
│   └── styles/
│       └── index.css
├── index.html
├── vite.config.ts
├── tailwind.config.js
├── tsconfig.json
└── electron-builder.yml
```

## 7. 关键实现细节（新增/修改部分）

### 7.1 Electron 主进程 IPC 设计
定义以下 IPC 通道（通过 `ipcMain.handle`）：
- `select-excel`：打开对话框选择 `.xlsx` 文件，读取 Buffer 并返回 `{ filePath, data: ArrayBuffer }`（通过 IPC 序列化可能需将 Buffer 转为 base64 或使用 `Uint8Array`，推荐转换为 `ArrayBuffer` 直接传递，Electron 支持）。
- `select-template`：打开对话框选择 `.txt` 文件，读取文本并返回 `{ filePath, content: string }`。
- `read-file`：接收路径参数，根据扩展名返回内容（Excel 返回 ArrayBuffer，模板返回 string），用于启动时自动加载。
- `write-clipboard`：接收文本字符串，调用 `clipboard.writeText(text)`。
- `save-template`：接收 `{ filePath, content }`，写回模板文件。
- `get-store` / `set-store`：读写持久化状态（可合并为一个 `store:get` 和 `store:set` 通道，使用 `electron-store`）。

所有方法需做好错误处理，返回统一格式 `{ success: boolean, data?: any, error?: string }`。

### 7.2 剪贴板方案
推荐使用主进程的 `clipboard.writeText()` 以确保跨平台一致性和权限。preload 脚本暴露：
```typescript
writeClipboard: (text: string) => ipcRenderer.invoke('write-clipboard', text)
```
渲染进程调用时需 try/catch 并处理失败提示。

### 7.3 状态持久化与 electron-store
在 main 进程中初始化 Store：
```typescript
import Store from 'electron-store';
const store = new Store({
  defaults: {
    lastExcelPath: '',
    lastTemplatePath: '',
    records: []
  }
});
```
IPC 处理 `get-store` 返回整个 store 内容，`set-store` 接收部分更新并合并。

### 7.4 模板替换引擎
简易实现：使用正则 `/\{\{(.+?)\}\}/g` 匹配占位符，替换为 `fields[key]` 或 `''`。
预览时高亮显示：在 Vue 模板中使用 `v-html` 渲染经过转义和标记的 HTML，但需防止 XSS（因数据来源固定，可信任，但仍建议做基本转义）。

### 7.5 排序与移动逻辑
- 初始时，未使用记录的 `order` = 其原始行号（1, 2, 3...）。
- 当标记一条记录为已使用时，计算当前所有已使用记录的最大 `order` 值（若没有则为 10000），然后设置该记录的 `order = maxOrder + 1`。
- 列表渲染时，使用 `computed` 属性对 records 按 `order` 升序排列。

## 8. UI/UX 细节
- 整体风格简洁现代，使用 Tailwind 的 `gray` 和 `blue` 色调。
- 已使用记录：`opacity-60 line-through`。
- 选中项：`bg-blue-100 border-l-4 border-blue-500`。
- 按钮样式：主操作按钮 `bg-blue-600 hover:bg-blue-700 text-white`；危险操作（重置）`bg-red-500`；次要按钮边框样式。
- Toast 通知：固定在右下角，滑入动画，2 秒后自动消失。
- 加载状态：启动时如果正在读取文件，显示居中加载动画。
- 窗口标题：`IPTV Template Tool`，尺寸 1200x800，最小 900x600。

### 7.1 拖拽导入实现
- 主进程在窗口创建时启用文件拖拽：`webPreferences: { … }` 不需要特殊配置，但为防止 Electron 默认打开文件，需监听 `will-navigate` 事件并阻止。
- 渲染进程在 `DropZone.vue` 上监听 `dragover` 和 `drop` 事件：
  ```typescript
  const onDrop = async (e: DragEvent) => {
    e.preventDefault();
    const file = e.dataTransfer?.files?.[0];
    if (file && file.name.endsWith('.xlsx')) {
      const buffer = await file.arrayBuffer();
      // 由于安全策略，不能直接获取路径，但可通过 IPC 将 buffer 传递（注意大文件性能）
      // 或使用 Electron 的 webContents 获取文件路径，再让主进程读取。
      // 推荐：通过 contextBridge 暴露一个方法 `importExcelFromDrop(path)`，
      // 但拖拽事件无法直接拿到完整路径，因此需要主进程协助。
      // 更简单：直接读取文件 buffer 并传给解析函数，无需主进程。
      // 修改架构：Excel 解析完全在渲染进程，因此可以直接用 file.arrayBuffer() 解析。
    }
  };
  ```
  **调整**：为支持拖拽时直接拿文件内容，不再强制必须经过主进程。新增 preload API 可保留，但拖拽直接用 `file.arrayBuffer()` 解析即可。需在提示中说明。

### 7.2 智能解析逻辑
- 在 `excelParser.ts` 中实现：
  1. 使用 `XLSX.read(buffer, {type: 'array'})` 获取 workbook。
  2. 第一个 sheet 转二维数组（`sheet_to_json` 带 header:1）。
  3. 去除首尾完全空白的行（所有单元格为 null/undefined/''）。
  4. 找到第一个非空行作为表头，若表头有重复列名，则自动添加后缀区分。
  5. 剩余行作为数据，过滤掉完全空白的行。
  6. 构建 `records` 数组。

### 7.3 模板配置面板
- `TemplateManager.vue`：
  - 左侧模板列表（可滚动），右侧为编辑区域。
  - 添加模板：支持从文件导入（调用 `selectTemplate` IPC）或创建空白。
  - 激活模板：点击列表项，store 中更新 `activeTemplateId`，右侧预览立即切换。
  - 保存：调用 `saveTemplate` IPC 写入原文件（或另存）。
- 占位符自动补全：在编辑区绑定 `@input` 检测 `{{`，并弹出下拉菜单列出当前 Excel 列名。

### 7.4 剪贴板与文件路径（无变化）

## 8. UI/UX 细节
- 整体风格简洁现代，使用 Tailwind 的 `gray` 和 `blue` 色调。
- 已使用记录：`opacity-60 line-through`。
- 选中项：`bg-blue-100 border-l-4 border-blue-500`。
- 按钮样式：主操作按钮 `bg-blue-600 hover:bg-blue-700 text-white`；危险操作（重置）`bg-red-500`；次要按钮边框样式。
- Toast 通知：固定在右下角，滑入动画，2 秒后自动消失。
- 加载状态：启动时如果正在读取文件，显示居中加载动画。
- 窗口标题：`IPTV Template Tool`，尺寸 1200x800，最小 900x600。
- **拖拽区域**：当没有加载文件时，整个左侧区域显示虚线边框，中间文字“拖拽 Excel 文件到此处或点击导入”，已加载文件后该提示消失，但拖拽功能仍保留。
- **导入按钮**：使用上传图标，工具提示“导入Excel文件”。
- **模板管理**：模态框或抽屉，宽度适中，包含清晰的列表和操作按钮。

## 9. 配置与依赖
### package.json 关键脚本
```json
{
  "scripts": {
    "dev": "vite",
    "build": "vite build",
    "electron:dev": "electron .",  // 可结合 concurrently
    "dist": "electron-builder"
  }
}
```
### 必须的依赖
- `electron` (dev)
- `electron-builder` (dev)
- `vue` `pinia` `xlsx`
- `tailwindcss` `postcss` `autoprefixer`
- `typescript` `vite` `@vitejs/plugin-vue`
- `electron-store` (用于持久化)
- 开发辅助：`concurrently` `wait-on` 等（可选）

## 10. 交付标准
- 提供完整源码，执行 `npm install && npm run dev`（需配置好 Vite + Electron 联合启动）即可看到应用窗口并加载内置文件（或提示手动选择）。
- 打包命令 `npm run dist` 能生成 macOS `.dmg`、Windows `.exe`、Linux `.AppImage` 等安装包。
- 所有功能（加载、解析、列表、复制、状态移动、撤销、搜索、模板编辑）完整可用。
- 提供简短 README 说明使用方法和开发启动命令。
- 应用能通过 `npm run dev` 启动，支持拖拽导入、按钮导入、自动加载固定路径。
- 智能解析正确处理带空行、重复列名的 Excel。
- 模板可添加、编辑、切换、保存，配置可持久化。
- 其余功能完整。

请严格按照以上规格实现完整应用代码。