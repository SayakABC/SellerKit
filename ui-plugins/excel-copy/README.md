# TV模版（UI 岛插件）

把「TV模版」从随宿主编译的 view 插件（`extensions/excel-copy`，1,849 行 Vue/TS）迁移为市场可分发的 **UI 岛（kind: ui）** 插件：原生 ESM 静态站 + `window.__sk` 宿主桥，零 npm 依赖、不打包 `xlsx`、**无构建步骤**（`dist/` 即源码）。

## 功能

| 页签 | 能力 |
|------|------|
| 复制工作台 | 导入 Excel（**点击或拖拽**，拖拽走字节通道）→ 左栏记录列表（状态圆点 / 已使用删除线 / 双击复制）→ 右栏模板替换预览（占位符高亮 + 缺失字段告警 + 字段详情）→ 复制并标记 / 仅复制 / 撤销；筛选（全部 / 未使用 / 已使用）+ 搜索 + 重置；↑↓ 切换、Enter 复制并标记、⌘/Ctrl+Z 撤销 |
| 设置 · 模板配置 | 多模板列表、导入模板文件、新建空白模板、内容编辑器（输入 `{{` **自动补全**已加载列名）、设为当前 / 保存 / 删除；有来源文件的模板保存时同步回写文件 |
| 设置 · 字段规则 | 规则列表（启用开关 + 类型徽标 + 顺序号）、新建 / 删除、四类配置表单：`dateOffset` 日期偏移 / `template` 模板拼接 / `math` 数值运算 / `jsExpression` 自定义 JS；「立即应用」重算衍生列 |
| 设置 · 显示列 | 原始列 + 衍生列勾选（衍生列紫标）、全选 / 默认（前 2 列） |

## 从内建版升级（1.0.0 起）

本插件自 1.0.0 起是「TV模版」的**唯一实现**。宿主 `modules.config.json` 的三个预设已不再登记同名内建视图包 —— 内建记录会占用 id，`registerUiIsland()` 见 id 已存在即静默跳过，结果是岛装上了、市场显示"已安装"，却永远没有侧栏入口（AGENTS 红线 23）。宿主侧业务库与 db 能力域 `excel-copy` 原样保留，**数据零迁移**。

**配置自动继承**：岛与内建版共用同一命名空间 `modules.excel-copy`（岛的 `bridge.js#store` 走 `host.storage`，内建走 `useModuleStorage`），键名逐一对齐 `src/types.ts#AppState`：

| 键 | 含义 | 岛内入口 |
|---|---|---|
| `templateConfigs` / `activeTemplateId` | 模板集与当前模板 | 设置 · 模板配置 |
| `processingRules` | 字段处理规则 | 设置 · 字段规则 |
| `visibleColumns` | 记录行显示哪些列 | 设置 · 显示列 |
| `records` | 记录 + `used` / `order` | 复制工作台 |
| `lastExcelPath` / `lastTemplatePath` | 上次打开的文件 | 启动时自动重载 |

写回是**合并**语义（宿主侧 `modules.<id> = {...old, ...patch}`），不会抹掉其它字段。

> 设置页位置变化：内建版把 TV模版设置挂在**宿主设置中心**（当时由内建视图插件包里的 settings 贡献产出 `excel` 分类）。下记后该贡献随宿主预设一起消失，设置改到**岛内第二个页签**；工作台工具栏的「显示列」按钮会直接跳到「设置 · 显示列」。功能一项没少，只是位置变了。

### `ready()` 语义（勿回退）

`__sk.ready` 本身是 boot 后 resolve 的 Promise。旧写法 `if (sk.ready) return true` 判断的是"Promise 对象存在"（恒真）→ **从不等待**，调用会在握手前发出而全部失败。本岛真正 `await` 它并加超时兜底。

## 为什么 Excel 解析与规则求值必须在宿主

两条硬约束，违反了**不报错、只是功能不对**，所以写进守卫测试（`tests/pluginTriage.spec.ts`）：

1. **规则求值**：岛运行在 iframe 里，文档 CSP 是 `script-src 'self'`（`electron/plugin-ui-protocol.ts`），**没有 `'unsafe-eval'`** —— 岛内既不能用 `new Function` 也不能用 `eval`，而 `jsExpression` 类型（用户在设置页写 JS 代码）必须求值。故：岛负责收集参数 → 宿主 `fieldProcessor` 求值 → 岛消费返回值。
2. **Excel 解析**：宿主已有 `src/lib/excelParser.ts`（xlsx）；岛内重复引入会让两端口径漂移，也违背"静态站零依赖"。故：按路径读（`parseExcel`）与按字节读（`parseExcelBuffer`，拖拽用：iframe 里 `File` 拿不到真实磁盘路径）都在宿主完成。

## 与宿主的边界

- **能力域**：只有一个 `db` 域 `excel-copy`，7 个 op —— `parseExcel` / `parseExcelBuffer` / `applyRules` / `readTextFile` / `readDefaultTemplate` / `checkFileExists` / `saveTemplateFile`。每个都被岛真实调用（守卫反向断言）。
- **剪贴板**：`clipboard.writeText`。复制失败时**不标记** `used` —— 否则用户以为拿到了内容，实际剪贴板是空的。
- **文件选择**：`dialog.openFile('excel' | 'template')`，仅宿主允许的类型。
- **主题**：只消费宿主注入的 `--wb-*` 令牌，`styles.css` 里给同值兜底（便于脱离宿主静态预览），不硬编码色值。

## 目录

```
manifest.json     # kind: ui + capabilities（db 一域 / dialog / clipboard / storage）
dist/
  index.html      # 入口（加载 main.js）
  styles.css      # 依赖宿主注入的 --wb-* 主题令牌（含兜底值）
  bridge.js       # window.__sk 封装（db / store / notify / copy / openFile / ready）
  api.js          # 业务 API（ec 域调用 + 语义化包装）
  app.js          # 视图注册与外壳（标签导航、重绘、事件代理）
  store.js        # 状态容器（等价于内建 pinia store）+ 500ms 防抖落盘
  util.js         # 转义/模板渲染与预览/模态框等通用工具
  main.js         # 入口：等握手 → 注册视图 → 激活首个
  views/
    copy.js       # 复制工作台（分栏、拖拽导入、键盘、局部重绘）
    settings.js   # 设置（模板配置 / 字段规则 / 显示列）
```

## 开发/自测

岛内脚本为原生 ES Module，**无构建步骤**（`dist/` 即源码，改完直接发布）。

```bash
# 1) 语法自检（.js 是 ESM，需按 module 解析）
for f in dist/*.js dist/views/*.js; do cp "$f" /tmp/c.mjs && node --check /tmp/c.mjs || echo "FAIL $f"; done

# 2) 静态渲染自检（脱离宿主时桥不可用 → 顶栏显示「未连接宿主」）
cd ui-plugins/excel-copy/dist && python3 -m http.server 5173
```

真机联调需把插件装进宿主的 UI 岛目录后从插件中心打开。

**三个自检陷阱**（都踩过）：

1. 不要用 `file://` 打开 —— ESM 动态导入会被 CORS 拦，页面**根本不会挂载**（症状是首个断言超时、结果数组为空，极易误判成选择器写错），必须走本地 HTTP。
2. 桥的 boot 是**异步握手**，断言要等 `#conn` 变为「已连接宿主」再开始，否则会在握手前发起调用。
3. 假桥夹具里做 DOM 注入时，**`String.replace(pat, str)` 会把替换串里的 `$$` 折叠成 `$`、`$&` 展开成匹配串** —— 断言脚本里的 `$$` 会被静默吃掉。构造注入内容要用**函数式替换** `src.replace('</body>', () => ...)`。

## 局部重绘约定（勿改成整体重绘）

工作台有搜索框、设置页有**正在编辑的 textarea**。若订阅到 store 变更就整块重绘，用户每敲一个字都会丢焦点丢光标。故：

- 每个视图把自己的 DOM 拆成 `#rec-list` / `#preview` / `#seg`、`#tpl-list` / `#tpl-main`、`#rule-list` / `#rule-main`，store 变更只重绘**列表区**；编辑区只由显式动作（选中 / 新建 / 删除 / 切页签）重绘。
- 编辑草稿（视图内的 `st.draftTpl` / `st.draftRule`）与 store 分离，点「保存」才落库 —— 与内建"深拷贝以允许取消"一致。
- 视图切换时 `app.js` 会调上一个视图的 `leave()` 解绑（document 级快捷键、store 订阅都是全局副作用，不摘掉的话切到设置页后 ↑↓ / ⌘Z 仍作用在记录列表上）。

## 出包

```bash
node scripts/publish-plugin.js --dir ui-plugins/excel-copy \
  --base http://127.0.0.1:8000 --out market-out --catalog market-out/catalog.json
```

产物：`market-out/excel-copy-<version>.zip` + 更新 `market-out/catalog.json`。远端市场仓库的推送需人工确认。
