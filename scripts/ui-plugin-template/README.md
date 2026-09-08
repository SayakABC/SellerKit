# __PLUGIN_ID__（UI 岛）

SellerKit **UI 形态包**脚手架产物：静态站点经 `sk-plugin://` 只读协议在宿主 iframe（独立 JS realm）内运行，通过宿主注入的 `window.__sk` 桥调用宿主能力（权限门按 `manifest.json` 的 `capabilities` 判定）。

## 目录

```
__PLUGIN_ID__/
├── manifest.json     # kind: "ui"；entry: ./dist/index.html；capabilities 声明（可增 http/clipboard/dialog）
├── package.json      # vite 工程（先构建后打包：产物 dist/ 随包发布）
├── vite.config.mjs   # base 必须 './'（sk-plugin:// 协议下绝对资源路径会 404）
├── index.html        # 页面入口（自设 CSP）
└── src/              # 源码：main.js（__sk 桥演示）+ style.css（--wb-* 令牌）
```

## 开发

```bash
npm install
npm run dev        # 浏览器本地预览（无桥环境，__sk 缺失时会提示）
```

## 构建 + 发布

```bash
npm run build                                   # 产出 dist/（先构建后打包）
node scripts/publish-plugin.js ui-plugins/__PLUGIN_ID__ -o market-out   # 本地市场打包
```

发布脚本会：校验 manifest `kind: "ui"` 与 `entry` 指向产物存在；打包 **manifest.json + dist/**（自动排除 node_modules/.git）；catalog 条目写入 `kind: "ui"`。若 dist 缺失可加 `--build` 自动执行 `npm run build`。

## 本地体验（无需市场）

构建后复制进插件目录即可被宿主发现（「设置 → 插件」可启停/卸载）：

```bash
node scripts/plugin-create.js --ui __PLUGIN_ID__ --install
# 或手动：cp manifest.json + dist/ → <userData>/plugins/__PLUGIN_ID__/
```

## 桥面速查（完整见 PLUGIN_DEVELOPMENT.md）

- `window.__sk.onReady(fn)`：握手完成后回调（**无参**；元信息经 `sk.manifest` / `sk.env` 读取；`sk.ready` 是 Promise，不可当函数调用）。
- `sk.storage.load(key)` / `save(key, value)` / `clear()`：自身命名空间 key 级存储（需先声明 `storage`）。
- `sk.host.storage.load(ns)` / `save(ns, value)` / `clear(ns)`：跨命名空间（ns 须列入 `namespaces`）。
- `sk.host.ui.notify({ kind, text })` / `sk.log.info(...)`：宿主 toast / 日志。
- `sk.bus.emit(type, payload)` / `sk.bus.on(pattern, cb)`：发布 / 通配订阅（`cb(payload, meta)`，返回退订函数）。
- `sk.host.*`：能力域调用（storage / clipboard.writeText / http / dialog / ui），未声明对应能力 → `PluginPermissionError` + 审计环。
- ⚠️ 无 `sk.ui` 顶层成员、无 `sk.storage.get/set`；`clipboard` 桥面只有 `writeText`。

## 红线

- 页面**不得**直连 `window.electronAPI` / 裸 IPC；一律 `window.__sk`。
- 保持 `vite.config.mjs` 的 `base: './'`（改动会导致 iframe 资源 404）。
- 产物体积控制：入口 ≤2MB（宿主第一层防线），静态资源走包内相对引用。
