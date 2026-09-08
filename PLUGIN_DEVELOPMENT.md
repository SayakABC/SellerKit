# SellerKit 外置插件开发与部署指南

面向在 SellerKit 桌面应用中开发、调试并发布到插件市场（GitHub 静态托管）的插件开发者。

- 本文档是**插件作者**向的操作手册（生态文档，可随仓库提交）。
- 内核实现细节见 `PLUGIN_ARCHITECTURE.md`（本地 AI 内部文档，不提交 GitHub）。
- 官方市场仓库：`https://github.com/SayakABC/SellerKitPlugin`（`catalog.json` + `*.zip` 平铺在 `main` 分支根目录）。

---

## 1. 插件是什么

SellerKit 运行时插件分为两类，**本文只讲「外置插件」（可进市场分发）**：

| 类别 | 存放 | 信任级别 | 能力 |
|------|------|----------|------|
| 随宿主分发视图插件 | `extensions/<id>/` 随安装包编译 | L0（宿主同权） | 完整 Vue 视图/数据/设置 |
| **外置插件（本指南）** | `<userData>/plugins/<id>/` 运行时安装 | **L2（Worker 沙箱）** | 后台贡献型：命令进 ⌘K + 事件 + 受限能力 |

外置插件的关键约束（红线）：

- **源码在 Worker 沙箱内执行**（Blob module worker + 权限门），不可见也不可触碰 `window` / `DOM` / `electronAPI` / Node API；
- **入口是自包含单文件 ESM**：无 `import`、无 `..` 穿越、文件 ≤2MB；
- 宿主能力经 `ctx.host.*` 调用并按 `manifest.json` 的 `capabilities` 显式声明放行，未声明即调用抛 `PluginPermissionError` 并写审计记录（例外：`ctx.storage` 自身命名空间存储直通、`ui`/`env` 默认放行，见 §6）；
- **无视图能力**（不能渲染 Vue 页面），属于后台贡献型插件；
- `manifest.name` 必须等于安装目录名（kebab-case），也等于市场条目 `id`。

---

## 2. 插件目录结构

```
extensions/<kebab-id>/        # 源码目录（脚手架生成）
├── manifest.json             # 声明式元信息（必须）
└── index.js                  # 自包含单文件 ESM 入口（必须，默认 entry）
```

安装后运行时形态为：

```
<userData>/plugins/<kebab-id>/
├── manifest.json
└── index.js
```

`userData` 默认路径（dev 未打包时）：

- macOS：`~/Library/Application Support/seller-kit`
- Windows：`%APPDATA%/seller-kit`
- 可用环境变量 `SK_USER_DATA` 覆盖（仅脚手架 `--install` 时生效）

---

## 3. manifest.json 字段说明

以脚手架模板（`extensions/_template/manifest.json`）为例：

```json
{
  "name": "my-tool",
  "displayName": "我的工具",
  "version": "0.1.0",
  "description": "一句话描述（市场展示）",
  "author": "SellerKit Developer",
  "engines": { "sellerkit": "^1.0.0" },
  "activationEvents": ["onStartup"],
  "entry": "./index.js",
  "capabilities": []   // ← 模板默认空：只声明用得到的能力，见 §6
}
```

> ⚠️ `capabilities` 的合法能力域 id **仅 `storage / http / clipboard / dialog` 四项**；`ui` / `env` 等**不可声明**（写入即安装校验失败，见 §6）。

| 字段 | 必填 | 说明 |
|------|------|------|
| `name` | 是 | 全局唯一 kebab-case id，**必须等于目录名/安装目录名** |
| `displayName` | 是 | 设置页/市场展示名 |
| `version` | 是 | semver `x.y.z`；每次市场发版递增 |
| `description` / `author` | 否 | 市场条目展示信息 |
| `engines.sellerkit` | 是 | 兼容的宿主版本语义（`^1.0.0`） |
| `activationEvents` | 是 | 见 §4；留空 = 不自动激活，需在「设置 → 插件」手动启用 |
| `entry` | 否 | 相对入口，仅 `./` 开头、禁 `..`；默认 `./index.js` |
| `capabilities` | 否 | 能力声明；缺省仅放行自身命名空间存储与 `ui`/`env`，其余拒绝，见 §6 |

---

## 4. 激活方式（activationEvents）

懒激活声明，命中才调用 `activate(ctx)`；命中前仅登记静态贡献：

| 取值 | 触发时机 |
|------|----------|
| `["onStartup"]` | 宿主启动即激活（模板默认） |
| `[]` | 不自动激活，用户在「设置 → 插件」手动启用 |
| `["onCommand:xxx"]` 等 | ⚠️ **未实现**：校验时非 `onStartup` 项被过滤舍弃（等同 `[]`，不会自动激活、需手动启用），保留仅为形态预留 |

---

## 5. 入口 index.js（生命周期 + ctx API）

入口 `default` 导出一个生命周期对象 `{ activate(ctx), deactivate?(ctx) }`。

```js
// extensions/my-tool/index.js —— 自包含单文件 ESM，无任何 import
let disposers = [];

export default {
  async activate(ctx) {
    const { log } = ctx;
    log.info('my-tool activate');

    // ⌘K 命令：id 为插件内本地 id，全局 id 由宿主拼成 <plugin>.<localId>
    disposers.push(
      ctx.contributions.registerCommand({
        id: 'hello',
        title: 'my-tool: 打招呼',
        order: 1,                       // ⌘K 分组内升序，缺省 0
        run: async () => {
          const n = (await ctx.storage.load('visits')) ?? 0;
          await ctx.storage.save('visits', Number(n) + 1);
          ctx.host.ui.notify({ kind: 'success', text: `第 ${Number(n) + 1} 次调用` });
        },
      }),
    );

    // 事件订阅：type 以 * 结尾为通配订阅（回调签名 (payload, meta)，meta.eventType 为实际事件名）
    disposers.push(
      ctx.bus.on('plugin:*', (payload, meta) => {
        log.info('plugin:* →', meta && meta.eventType, payload);
      }),
    );
  },

  async deactivate(ctx) {
    while (disposers.length) disposers.pop()();  // 统一注销命令/订阅
    ctx.log.info('my-tool deactivate');
  },
};
```

### ctx 对象（activate/deactivate 注入）

| 成员 | 说明 |
|------|------|
| `ctx.manifest` | 本插件 manifest |
| `ctx.trustLevel` | 信任级别（外置恒为 2） |
| `ctx.contributions` | 动态贡献注册器：`registerCommand(spec)` → 返回注销函数；注册的命令在 deactivate 时自动清理 |
| `ctx.host` | 宿主能力面（受 capabilities 门控），见 §6 |
| `ctx.storage` | 插件专属命名空间存储：`load(key)` / `save(key, value)` / `clear()`，底层落 `modules.<pluginId>`（raw host 直通，**无需声明 `storage`**） |
| `ctx.bus` | 事件总线：`on(type, handler)` 订阅（支持 `*` 尾部通配）、`emit(type, payload)` 发布 |
| `ctx.log` | 带 `[plugin:<id>]` 前缀的日志器：`debug/info/warn/error` |
| `ctx.abort` | `AbortSignal`；插件被停用/卸载时中止（释放长任务/定时器） |

### 命令规范（CommandContribSpec）

| 字段 | 说明 |
|------|------|
| `id` | 插件内本地 id，全局唯一由宿主拼 `<plugin>.<id>` |
| `title` | ⌘K 面板显示文本 |
| `order` | 分组内显示顺序（升序，缺省 0） |
| `run` | 执行函数（async 亦可） |

命令注册后出现在 ⌘K 面板的**「外置插件命令」分组**。

---

## 6. 能力声明（capabilities 权限门）

权限门按 manifest 声明逐调用判定；未声明即调用 → `PluginPermissionError` + 审计（可在「设置 → 插件」面板看到被拒记录）。

能力域与声明写法：

```json
"capabilities": [
  { "id": "storage", "namespaces": ["my-tool", "shared-ns"] },
  { "id": "clipboard", "actions": ["write"] },
  { "id": "http", "allow": ["https://api.example.com/*"] },
  { "id": "dialog" }
]
```

| 能力 id | 对应 `ctx.host.*` | 声明规则 |
|---------|-------------------|----------|
| `storage` | `host.storage` 跨命名空间读写 | 自身命名空间 `modules.<pluginId>` 声明后恒放行、无需列入 `namespaces`；访问**其他**命名空间须列入 `namespaces`（L2 的 `ctx.storage` 走 raw host 直通，连声明都不需要） |
| `clipboard` | `host.clipboard.writeText` | `actions` 省略 = 该域全部放行 |
| `http` | `host.http.get/post` | `allow`（URL 前缀，支持尾部 `*`）**省略 = 禁止任何请求** |
| `dialog` | `host.dialog.openFile` | 同上，`actions` 省略 = 全放行 |

⚠️ `ui` / `env` 两个面**默认放行、不设门**（透传），且**不在能力域白名单内**——`capabilities` 的合法 id 仅 `storage / http / clipboard / dialog` 四项，把 `ui` / `env` 写进声明会在安装校验时被拒（`capabilities.id 非法`）。

### ctx.host 能力面一览

```js
ctx.host.storage.load(ns);  ctx.host.storage.save(ns, v);  ctx.host.storage.clear(ns); // 需声明 storage（跨命名空间）
ctx.host.clipboard.writeText(text);                         // 需声明 clipboard
ctx.host.http.get(url, { timeout, params, headers });       // 需声明 http + allow 前缀
ctx.host.http.post(url, body, opts);
ctx.host.dialog.openFile({ kind: 'excel' | 'template' | 'directory' }); // 需声明 dialog
ctx.host.ui.notify({ kind: 'success'|'error'|'info', text });           // 默认放行
ctx.host.ui.openSettings(category, tab);
ctx.host.env.isMac / ctx.host.env.platform / ctx.host.env.version;      // 只读，默认放行
```

---

## 7. 本地开发与调试（标准流程）

```bash
# 1) 脚手架：在 extensions/<id>/ 生成骨架
npm run plugins:create my-tool

# 2) 编辑 manifest.json（displayName/capabilities/version）与 index.js

# 3) 安装到运行时目录（先删旧目录再拷贝；每次改代码后重跑）
npm run plugins:create my-tool -- --install
#     → 已复制到 ~/Library/Application Support/seller-kit/plugins/my-tool

# 4) 重启应用（dev: npm run dev；或打包后重启桌面应用）
```

重启后验证路径：

1. **「设置 → 插件」**：出现一行「外置 · L2」记录（若 `activationEvents` 为空，先手动启用）；
2. 状态流转：`installed → loaded → activating → active`；失败显示 `error`；
3. **⌘K**：在「外置插件命令」分组看到并执行命令；
4. 观察输出：dev 模式下 `ctx.log.*` 直接打印到运行 npm 的终端（带 `[plugin:<id>]` 前缀）；
5. 权限被拒：插件行/审计区能看到 `PluginPermissionError` 记录 → 对照 §6 补齐 `capabilities`。

修改 → 重跑 `--install` → 重启 → 再验证，循环即可。

---

## 8. 发布到插件市场

市场形态：`catalog.json`（含条目元数据 + 下载地址 + sha256）与 `sk-hello-0.1.0.zip` 这类 zip 包，平铺在 GitHub 仓库 `main` 分支根目录，经 `raw.githubusercontent.com` 静态分发。

### 8.1 打发布包并合并 catalog

```bash
node scripts/publish-plugin.js --dir extensions/my-tool \
  --base https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main

# 可选参数：
#   --out <dir>   输出目录，默认 market-out/
#   --dir 必填    插件源码目录（含 manifest.json）
#   --base 必填   产物下载 URL 前缀，downloadUrl = <base>/<id>-<version>.zip
```

脚本做的事：

1. 校验 manifest（`name`、`version`、`entry` 等）；
2. 打成 `<id>-<version>.zip`（zip 根即插件内容：manifest.json + index.js）；
3. 计算 zip 的 sha256 并写入 catalog 条目（含 id/name/version/description/author/downloadUrl/sha256）；
4. 合并进 `market-out/catalog.json`（**按 id 合并，同名条目被覆盖为新版本**）。

### 8.2 推送市场仓库

```bash
cd market-out
git add -A
git commit -m "market: add/update my-tool v0.1.0"
git push          # 推到 https://github.com/SayakABC/SellerKitPlugin main
```

（`market-out/` 是该市场仓库的工作副本：`catalog.json` + 各插件 zip。）

### 8.3 批量发布多个/全部插件

```bash
for d in extensions/*/; do
  [ "$(basename "$d")" = "_template" ] && continue
  node scripts/publish-plugin.js --dir "${d%/}" \
    --base https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main \
    --out market-out || exit 1
done
cd market-out && git add -A && git commit -m "market: 批量发布插件" && git push
```

### 8.4 应用侧验证

插件市场 Tab 填（或使用默认值）：

```
https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main/catalog.json
```

刷新后应看到条目，按钮状态：未安装 → **安装**；远端版本更高 → **更新到 vX**；已最新 → **已安装**。

---

## 9. 版本与更新约定

- `version` 用 semver；同 id 的 catalog 条目版本更高，UI 才提示「更新到 vX」；
- **不要修改已发布版本的 zip 内容**：文件内容变了但版本号不变，sha256 对不上会导致安装失败。改内容必须升版本；
- 安装流程强制：下载 → sha256 校验 → 安全解压（防 `..`/symlink）→ 校验 `manifest.name` = 条目 id 且版本匹配 → 原子落盘到 `<userData>/plugins/<id>/` → 重新扫描。

---

## 10. 卸载 / 停用

- **停用**：「设置 → 插件」关闭开关（贡献被移除、命令从 ⌘K 消失、`deactivate(ctx)` 被调用）；
- **卸载**：市场条目或插件面板的卸载按钮删除目录；或手动删除 `<userData>/plugins/<id>/`。

---

## 11. 常见问题（FAQ）

| 现象 | 原因与处理 |
|------|-----------|
| 安装成功但激活失败（状态 `error`） | 入口语法错误 / 非自包含（有 import）/ 触发了未声明能力。看 `ctx.log`（dev 终端）与错误详情 |
| 调用 `ctx.host.*` 抛 `PluginPermissionError` | 未在 `capabilities` 声明对应能力（http 还需 `allow` 前缀）→ 补声明后重装/重启 |
| 安装报「下载插件包失败: HTTP 404」 | `downloadUrl` 或 `--base` 配错 / zip 未推送 |
| 安装报 sha256 不匹配 | zip 与 catalog 的 sha256 不一致（改了文件没重跑发布脚本）→ 重跑 `publish-plugin.js` |
| 入口文件过大被拒 | 入口 ≤2MB；多文件逻辑需合并进单文件（沙箱不支持多模块 import） |
| 修改代码后市场仍是旧行为 | 本地目录是缓存/已安装副本；请升版本后重新发布，并在应用内更新 |
| UI 提示「已安装」但想要强制覆盖 | 同版本内容变更建议直接升版本（干净可追溯） |
| UI 岛页面空白 / 资源 404 | `vite.config.mjs` 的 `base` 不是 `'./'`；或 `dist` 未重建但 manifest `entry` 指向旧产物 → 重跑 `npm run build` 再发布 |
| UI 岛 `storage` 调用抛权限错误 | UI 岛全部 storage 调用（含自身命名空间 `sk.storage`）都走权限门：须在 `capabilities` 声明 `storage`（自身命名空间无需列入 `namespaces`）→ 补声明后升版本重发 |

---

## 12. UI 形态插件（UI 岛）开发与发布

前面章节默认面向 **L2 后台插件**（单文件 ESM + Worker 沙箱，命令进 ⌘K，无界面）。若插件需要**自有界面**，用 **UI 岛（UI 形态包）**：静态站点经 `sk-plugin://` 只读协议在宿主 iframe（独立 JS realm）运行，通过宿主注入的 `window.__sk` 桥调用宿主能力。

| | L2 后台插件 | UI 岛（UI 形态包） |
|---|---|---|
| manifest | `entry: "./index.js"` | `entry: "./dist/index.html"`，**`kind: "ui"`** |
| 运行 | Worker 沙箱（无 DOM） | iframe 独立 JS realm（有 DOM/CSS） |
| 桥面 | `ctx.*`（activate 注入） | `window.__sk`（onReady 后可用） |
| 界面 | 无 | 自绘页面（自由用 Vue/React/原生） |
| 启停 | 激活/停用 | 侧栏入口即时出现/隐藏；卸载删除目录 |

### 12.1 脚手架（create-ui-plugin 模板）

```bash
npm run plugins:create:ui <kebab-id>        # 在 ui-plugins/<kebab-id>/ 生成 vite 工程
cd ui-plugins/<kebab-id>
npm install
npm run build                                # 产出 dist/（先构建后打包）
```

生成物：`manifest.json`（`kind: "ui"` + `entry: "./dist/index.html"` + `capabilities`，可自行增 `http`/`clipboard`/`dialog`）、`package.json`、`vite.config.mjs`（**`base: './'` 不可改**，sk-plugin:// 下绝对资源路径会 404）、`index.html`（自设 CSP）、`src/main.js`（`window.__sk` 桥演示）、`src/style.css`（消费 `--wb-*` 令牌）。

### 12.2 本地体验

```bash
node scripts/plugin-create.js --ui <kebab-id> --install   # 仅复制 manifest.json + dist/** 到运行时目录
# 或手动复制 <userData>/plugins/<kebab-id>/；重启应用后侧栏出现该岛
```

「设置 → 插件」面板可对其**启停/卸载**；卸载仅删目录与入口，无后台 `deactivate` 语义。

### 12.3 发布到市场

```bash
node scripts/publish-plugin.js --dir ui-plugins/<kebab-id> --base <URL前缀> [-o market-out] [--build]
```

- 发布工具按 `kind: "ui"` 走 UI 语义：entry 须指向 **HTML 产物** 且文件存在；缺失时给 `--build` 会先执行 `npm run build`（先构建后打包），否则报错引导；
- 打包范围只含 `manifest.json + dist/**`（自动剔除 `node_modules/.git/src/package.json` 等工程文件）；
- catalog 条目写入 `kind: "ui"`，宿主市场列表安装前即可见「UI 岛」徽标。

### 12.4 UI 岛桥面速查（`window.__sk`，双端实现见 `electron/plugin-ui-runtime.js` ↔ `src/core/plugin/uiBridgeHost.ts`）

- `sk.onReady(cb)`：宿主握手后回调（**无参**）；元信息经 boot 后的 getter 读取——`sk.manifest`（`{ id, displayName, version }`）/ `sk.env`（`{ isMac, platform }`）；`sk.ready` 是 Promise，可用 `await sk.ready` 或 `onReady`，**不可当函数调用**；
- `sk.storage.load(key)` / `save(key, value)` / `clear()`：**自身命名空间** key 级存储（直接读/写原始值，无 `{ value }` 包裹）；跨命名空间走 `sk.host.storage.load(ns)` / `save(ns, value)` / `clear(ns)`。⚠️ UI 岛 storage 调用全部过权限门：**`capabilities` 必须先声明 `storage`**（自身命名空间无需列入 `namespaces`）；
- `sk.host.ui.notify({ kind, text })`：宿主 toast（`text` 必填；`kind: 'success' | 'error' | 'info'`，非法/缺省按 info）；`sk.log.debug/info/warn/error(...)`：宿主日志（dev 终端带 `[ui-island:<id>]` 前缀）；
- `sk.bus.emit(type, payload)` / `sk.bus.on(pattern, cb)`：发布 / 通配订阅（`*` 尾部前缀匹配，建议按 `plugin:<id>:*` 前缀约定）；回调 `cb(payload, meta)`，`meta` 为 `{ sourcePlugin, origin }`，**不含 eventType**（实际事件名由命中的订阅 pattern 判定；与 L2 `ctx.bus` 的 `meta.eventType` 不同）；`on` 返回退订函数；
- `sk.host.*` 其余能力面：`clipboard.writeText` / `http.get/post`（须 `allow` 前缀）/ `dialog.openFile` / `ui.openSettings` ——未声明对应能力 → 桥拒绝（`PluginPermissionError` + 审计环，设置 → 插件可查）；
- ⚠️ **不存在** `sk.ui` 顶层成员、`sk.storage.get/set`、`clipboard.readText`（桥面只有 `writeText`）——旧模板/demo 用法请勿照抄；
- 桥握手 token 校验失败的消息会被静默丢弃；页面 **禁止直连 `window.electronAPI`/裸 IPC**。

---

## 13. 红线速查（插件作者必读）

1. `manifest.name` = 目录名 = 安装目录名，kebab-case；
2. `entry` 仅 `./` 相对路径、禁 `..`、单文件自包含（无 import）、≤2MB（L2 后台）；UI 岛则指向 `./dist/index.html` 且产物 ≤2MB 入口约束；
3. L2 后台不触碰 `window` / `DOM` / `electronAPI` / Node；UI 岛有独立页面/JS realm，但仍只走 `window.__sk` 桥，不直连宿主 API；
4. 能力调用只走 `ctx.host.*` / `sk.host.*`，且按 `capabilities` 显式声明放行（`http` 必须有 `allow` 前缀）；`ctx.storage` 自身命名空间与 `ui`/`env` 默认放行，且 `ui`/`env` **不得写入** `capabilities`（写入即安装校验失败）；
5. 命令/事件/定时器等资源在 `deactivate` 中清理（统一收集 disposers 执行）；
6. 版本号 semver 递增，不要改已发布 zip 内容；
7. 插件间通信只用事件总线（`ctx.bus` / `sk.bus`），不共享业务状态；
8. UI 岛 `vite.config.mjs` 保持 `base: './'`（改动会导致 iframe 内资源 404）。
