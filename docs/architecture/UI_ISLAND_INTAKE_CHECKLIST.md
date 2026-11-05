# UI 岛插件接入步骤与检查清单（Intake Checklist）

- **状态**：✅ 活跃（2026-09-24 建立）
- **适用**：① 新增一个 UI 岛；② 改动已装 UI 岛后确认生效；③ UI 岛"打不开/空白"时逐步排查
- **规则源头**：`AGENTS.md` §1.8 / §1.9 + 红线 16–23（唯一规则源）；构建/发布/桥面字段细节见
  `docs/architecture/PLUGIN_DEVELOPMENT.md` §12；架构背景见 `docs/architecture/PLUGIN_ARCHITECTURE.md` §15
- **一键回归**：`npm run plugins:island:smoke`（逐个点岛并断言握手，见 §4.1）

> 本文只写"**步骤 + 检查点 + 怎么查**"。规则原文不在本文复制，避免双头文档漂移。

---

## 0. 为什么需要这份清单：UI 岛故障几乎都是「静默失效」

2026-09-24 定位的实例：**重启后点导航一片空白**（本会话第一个岛正常，之后每个岛都白），
此前已按"握手竞态 / token 轮转 / origin 兜底"修过多次仍未解决。根因是**组件生命期**问题，不是桥内部逻辑：

| 环节     | 事实                                                                                                                    |
| -------- | ----------------------------------------------------------------------------------------------------------------------- |
| 渲染     | AppShell 双通道渲染 `<UiIslandView :plugin-id="activeIslandId">`，Vue **复用同位置同类型组件**                          |
| 后果     | 切岛只换 prop、组件实例不重建 → `bridge`（含 `expectedOrigin` 与 token）仍是**上一个岛**的                              |
| 静默点 1 | 新岛的 `hello` 来自 `sk-plugin://<新岛>` → 被旧桥的 origin 校验丢弃（**不打印**）                                       |
| 静默点 2 | 旧桥补发的 `boot` 以 `sk-plugin://<旧岛>` 为 targetOrigin → **postMessage 静默丢弃**（targetOrigin 不匹配规范上不抛错） |
| 表现     | 新岛永久停在「等待桥握手」；把首屏门控在 boot 之后的岛 = **一片空白**；宿主工具条却仍显示「桥已连接」（旧会话状态）     |

三类结构性原因（本清单按此组织检查项）：

1. **生命期**：桥的存活期必须与"当前岛"一致（切岛重建，见 `AppShell.vue` 的 `:key` + `UiIslandView.attach` 的 `bridgePluginId`）；
2. **分发**：桥运行时 `electron/plugin-ui-runtime.js` 必须真的到得了运行环境（dev 读项目源码 / 打包读 asar）；
3. **时序**：握手允许"谁先谁后"，但**不允许丢失**（runtime 无限重试 hello；host 不轮转 token；不匹配必须回错包）。

> 排查心法：**岛空白 ≠ 岛的问题**。先在宿主侧看工具条状态灯与 `sk-plugin://` 请求，再进岛内看 `window.__sk`。
> 岛内是独立 JS realm，异常只出现在 **iframe 那个 target 的 console**，宿主 DevTools 默认看不到。

---

## 1. 接入步骤（SOP）

### Step 1 — 造包（脚手架）

```bash
npm run plugins:create:ui <kebab-id>      # → ui-plugins/<kebab-id>/（vite 工程）
cd ui-plugins/<kebab-id> && npm install
```

判据：脚手架 = `scripts/ui-plugin-template/`；安装形态 = `<userData>/plugins/<id>/`。
**不要把 UI 岛 id 登记进 `modules.config.json` 的 profiles**（会与内建 id 冲突 → 岛注册被静默跳过，见 §3.6）。

### Step 2 — 写 `manifest.json`（契约最硬的一层）

| 字段           | 取值                                                          | 校验点                                                                   |
| -------------- | ------------------------------------------------------------- | ------------------------------------------------------------------------ |
| `name`         | kebab-case，**必须等于目录名**                                | 不等 → `目录名与 manifest.name 不一致`，岛被丢弃                         |
| `kind`         | `"ui"`                                                        | 缺了 → 当成 L2 插件，入口 `dist/index.html` 会被 Worker import（语法错） |
| `entry`        | `"./dist/index.html"`                                         | 仅 `./` 相对；路径越界/不存在 → `sk-plugin://` 返回 403/404              |
| `version`      | `x.y.z`                                                       | **改内容必须升版本**（同版本重装会被视为同一包，见 §3.7）                |
| `capabilities` | 白名单数组                                                    | 见 Step 3 / §2.E；`ui`/`env` **不得**写入                                |
| `settings`     | `{ entry: "./dist/settings.html", displayName, icon, order }` | 可选；`entry` 必须与 `entry` 同子树                                      |

### Step 3 — 岛内工程约定（错一处就是"空白页"）

1. `vite.config.mjs` 的 **`base: './'` 不可改**——`sk-plugin://<id>/dist/index.html` 下绝对路径 `/assets/...` 会 404；
2. 产物入口 = `dist/index.html`；`dist/` 被 `.gitignore` 忽略，**改完必须重新 build**；
3. **首屏建议门控在握手之后**（`await sk.ready` / `onReady`），避免闪一屏无主题的空白；门控后若握手失败就是**长时间空白**，所以 §4.1 的冒烟必须跑；
4. 自带 CSP `<meta>` 保持 `script-src 'self'`（宿主注入的 `runtime.js` 同源，允许）；
5. 不打包重依赖（xlsx 等由宿主能力域代劳）；**禁 `eval`**（CSP 无 `unsafe-eval`）；
6. 只走 `window.__sk`，**禁止**直连 `window.electronAPI` / 裸 IPC（红线 3）；
7. 主题：一律 `var(--wb-x, <回退>)`；`color-scheme` 用 `inherit`，**不要元素级写死 light**，也不要靠 `[data-theme]` 选择器。

### Step 4 — 构建 + 安装

```bash
cd ui-plugins/<id> && npm run build
node scripts/plugin-create.js --ui <id> --install     # 复制 manifest.json + dist/** 到 <userData>/plugins/<id>/
```

`--install` 语义 = 重建 `<userData>/plugins/<id>/`（**只含 `manifest.json` + `dist/`**）。
可用 `SK_USER_DATA=<dir>` 覆盖目标目录（便于隔离验证）。

### Step 5 — 重启宿主并做首屏验证

```bash
npm run dev        # 或重启打包后的桌面应用
```

检查：侧栏出现该岛入口 → 点进去**首屏有内容** → 工具条状态灯为「桥已连接」而不是一直「等待桥握手…」。
**重启后必须再点一遍所有岛**（本次故障就是"首个岛正常、其余全白"，只在切岛时暴露）。

### Step 6 — 发给别人（市场）

```bash
node scripts/publish-plugin.js --dir ui-plugins/<id> \
  --base https://raw.githubusercontent.com/SayakABC/SellerKitPlugin/main [--build]
```

`catalog.json` 是 **upsert 语义（没有删除路径）**——下架/改名要手工改 `catalog.json` 并删 zip，见 `docs/archive/plans/PLUGIN_TRIAGE_PLAN.md`。
`market-out/` 是**独立 git 仓**（远端 `SayakABC/SellerKitPlugin`），本地改完不推送等于没下架。

### Step 7 — 收工前跑门禁（见 §4）

### Step 8 — 记录

在 `CHANGELOG.md` 记一条；若引入新的宿主能力/约束，回写 `AGENTS.md`（规则）与 `docs/baseline/PROJECT_BASELINE.md`（现状）。

---

## 2. 检查清单（逐步勾选）

### A. 包结构与静态

- [ ] 目录名 = `manifest.name`（kebab-case）；`kind: "ui"`；`entry` 指向存在的 `dist/index.html`
- [ ] `dist/index.html` 内的资源引用是**相对路径**（`./assets/...`），无 `/assets/...` 绝对路径
- [ ] 改动过内容 → 已 `npm run build` 且 `manifest.json` / `package.json` 的 `version` 已递增
- [ ] `npm run plugins:island:smoke` 全绿（§4.1）

### B. 运行时与握手

- [ ] 宿主已注册 `sk-plugin://` 协议（dev 终端日志：`[plugin-ui] sk-plugin:// 协议已注册`）
- [ ] 岛 HTML 内**被注入了** `<script src="sk-plugin://<id>/__sk__/runtime.js">`（§3.3 探针 1 条命令）
- [ ] 岛内 `typeof window.__sk === 'object'`（§3.3 探针）
- [ ] 岛内 `await window.__sk.ready` 能落地（不是超时）：代表 boot 真的到了
- [ ] 工具条状态灯语义正确：**岛回话了才绿**（`onBooted` 以岛的回执为准，不是"宿主发了 boot"）

### C. 交互与生命周期（本类故障高发区）

- [ ] **切岛**：A → B → C → A 逐个点，每个都要有首屏（不能只有本会话第一个岛能用）
- [ ] **回退**：岛 → 非岛模块 → 另一岛，也要正常（这条路径会重建组件，通常能自愈，可作故障辨别用）
- [ ] 「重新加载」按钮可恢复卡住的岛（**能恢复 = 桥层没问题、是会话没重建**，指向 §3.1）
- [ ] 切走后再切回，岛内状态符合预期（岛内刷新/重载由岛自己负责）
- [ ] `dispose` 生效：切岛/离开后宿主不再收到旧岛的日志（岛内 `sk.log` 不再出现）

### D. 打包版专项（dev 正常 ≠ 打包正常）

- [ ] `electron-builder.yml` 的 `files` 含 `electron/plugin-ui-runtime.js`（**打包版专属**，§3.2）
- [ ] `tsconfig.electron.json` 的 `include` **不含** `electron/**/*.js`（避免 tsc 重写运行时源码）
- [ ] 打包版启动后，主进程日志**没有** `[ui-island] 桥运行时源码缺失`（有即 §3.2）
- [ ] 打包后核对 asar 内容：`npx asar list <app>.app/Contents/Resources/app.asar | grep plugin-ui-runtime`
- [ ] 打包版实测：点每个岛都有首屏

### E. 能力与安全

- [ ] 用到的每个 `sk.host.*` 都在 `capabilities` 里声明；`db`/`mail` 额外给 `domains`（`secrets` 无域粒度）
- [ ] `http` 能力带 `allow` 前缀白名单；未声明能力 → 桥拒绝 + 审计环有记录（设置 → 插件）
- [ ] `ui` / `env` **未**写入 `capabilities`（写入即安装校验失败）
- [ ] 岛内不出现宿主的 `--wb-*` 之外硬编码配色；深色主题下原生控件（日期/下拉/滚动条）颜色跟随

---

## 3. 故障速查（症状 → 根因 → 定位 → 修复）

### 3.1 点导航一片空白；**本会话第一个岛正常、之后每个岛都白**（工具条还显示"桥已连接"）

- **根因**：切岛未重建桥（组件复用，旧桥的 `expectedOrigin`/token 属于上一个岛；新岛 hello 被丢、boot 被 `postMessage` 静默丢）
- **定位**：岛内 `await sk.ready` 超时（§3.3 探针）；宿主 console 若出现
  `[ui-island:<id>] 收到来源不符的岛消息（got=… want=…）` 即坐实
- **修复**：`src/core/AppShell.vue` 的 `<UiIslandView>` 必须带 `:key="activeIslandId"`；
  `UiIslandView.attach()` 必须按 `bridgePluginId === props.pluginId` 判定是否重建（两者都已落地，有守卫测试）
- **辨别技巧**：岛 → 非岛模块 → 另一个岛，若能正常渲染，说明就是本条

### 3.2 **打包版**所有岛都空白（dev 里却正常）

- **根因**：asar 内找不到 `plugin-ui-runtime.js` → 协议不注入桥 → 所有岛 `window.__sk` 缺失
- **定位**：
  - 主进程日志里出现 `[ui-island] 桥运行时源码缺失：<候选路径>` —— 这一条**就是**本故障
    （`loadRuntimeSource()` 首个 miss 时打一次，直接列出它找过的两个路径）
  - `npx asar list …/app.asar | grep plugin-ui-runtime`（无输出即命中）
  - 岛内 `typeof window.__sk === 'undefined'`
- **修复**：`electron-builder.yml` 的 `files` 显式收录 `electron/plugin-ui-runtime.js`
  （`tsc` 不会搬运未被 import 的 `.js`；且**不要**改用 `allowJs` 纳入编译——会把运行时全文重写）

### 3.3 某岛一直「等待桥握手…」/ 岛内没有 `__sk`

- **定位探针**（宿主 DevTools 的 Console，先切到 `sk-plugin://…` 那个 frame context）：
  ```js
  // 1) 桥脚本有没有被注入 / 有没有 404
  Array.from(document.scripts)
    .map((s) => s.src)
    .filter(Boolean);
  // 2) 桥对象在不在
  typeof window.__sk;
  // 3) 握手是否真的完成
  await Promise.race([
    window.__sk.ready.then(() => 'OK'),
    new Promise((r) => setTimeout(() => r('TIMEOUT'), 1500)),
  ]);
  ```
- **根因候选**：① 该岛 `entry` 路径错（`sk-plugin://` 403/404）；② 协议未注册或 runtime 文件缺失（§3.2）；
  ③ 桥绑在别的岛（§3.1）；④ 岛 HTML 自带 CSP 把注入脚本挡了（`script-src` 必须允许 `'self'`）
- **注意**：runtime 的 hello 是**无限重试**的（退避封顶 2s），所以"偶发丢一条 hello"不会造成永久失败；
  永久失败一定是上面四类

### 3.4 岛首屏数据加载不出来（永久「加载中…」），点「重新加载」恢复

- **根因**：宿主与岛的消息配对/会话错位（历史上是 token 轮转 + 静默丢包）
- **状态**：已修（见 `docs/reviews/ISLAND_COLD_START_AND_THEME_2026-09-22.md`）
- **若复现**：先按 §3.1 排除切岛；再看是否"不匹配的 call 没回错包"（契约：**永不静默挂起**，
  不匹配必须回 `call-result{ok:false}`）

### 3.5 深色主题下岛内日期选择器/下拉/滚动条发白

- **根因**：`color-scheme` **不是设计令牌**，不随 `--wb-*` 注入；岛内写死 `light` 或不声明
- **修复**：宿主在 boot/theme 载荷带 `theme.mode` 并由 runtime 内联写到 iframe `<html>`；
  岛内元素级写 `color-scheme: inherit`，**别写 `light`**，也别指望 `[data-theme]`

### 3.6 岛「装上了但侧栏没有入口」

- **根因候选**：① 该 id 与内建冲突（被登记进 `modules.config.json` 的 profiles）→ `registerUiIsland` 静默跳过
  （宿主 console 有 `UI 岛 "<id>" 与内建插件同名，已跳过注册`）；② manifest 校验失败（`pluginsScan` 的 error 会 toast）；
  ③ 被停用集挡住（`modules.plugins.disabled`）
- **定位**：宿主 console 搜 `[plugin]`；或看设置 → 插件面板的报错行

### 3.7 改了岛代码但界面没变

- **根因**：`dist/` 被 gitignore + 未重建；或 `version` 未升（同版本被当成同一包）；或没重装到 `<userData>/plugins/<id>/`
- **定位**：比对 `<userData>/plugins/<id>/manifest.json` 的 version 与源码；比对 `dist/` 的构建时间
- **修复**：`npm run build` → 升 version → `--install`（或市场重装）→ 重启宿主

### 3.8 岛设置页没出现在 设置中心

- **根因**：`manifest.settings.entry` 缺失 / 与 `manifest.entry` 不同子树（发布脚本强校验）；或分类 id 猜错
- **规则**：分类 id 固定 `<pluginId>:settings`；岛内按钮调 `sk.host.ui.openSettings('<pluginId>:settings')`；
  `initialTab` 只对**声明了 tabs 的视图插件包**有效，UI 岛是单页（传 tab 被忽略）
- **例外**：`excel-copy` / `order-insight` 有意把设置留在岛内（ADR-001），别当 bug 修

### 3.9 卸载岛后仍有残留

- **检查**：`<userData>/plugins/<id>/` 是否删净；市场 `catalog.json` 是否还有条目（**upsert 无删除路径，要手改**）；
  `market-out/*.zip` 是否还在；`market-out` 远端仓是否推送了

### 3.10 重启后**不回到**上次所在的岛（回落到首个非岛模块）

- **根因**：启动时序 —— 恢复「上次所在模块」用 `pm.has(id)` 判定，而 UI 岛只在 `pm.discoverExternal()`
  里登记。此前扫描排在 `activate(initialId)` **之后** → 恢复时岛尚未登记 → 判假 → 静默回落。
  （不是岛的锅，也不是 `isEnabled` 的锅；判假处没有任何日志，属静默失效。）
- **定位**：不点任何导航直接重启，若侧栏还在、岛也在，但主区停在别的模块 → 命中。
  冒烟脚本的 `[重启恢复]` 段会直接报出来。
- **修复**：`src/core/AppShell.vue#onMounted` 里把外置插件扫描拆出来，**在恢复之前 await**：
  ① `await scanExternalPlugins()`（扫描+登记，含岛）→ ② 恢复 `lastActiveModuleId` → ③ `void startStartupExternalPlugins()`。
  无存档时的默认落点不受影响：岛 meta 的 `order` 固定 120，排在所有内建模块之后。
- **守卫**：`tests/uiIslandBridgeLifecycle.spec.ts` 断言 onMounted 内**调用点**顺序（扫描 < 恢复，且必须 `await`）。
  ⚠️ 该断言只在 onMounted 体内做 `indexOf` —— 对整个文件做 `indexOf('pm.discoverExternal()')` 会命中函数**定义**，
  那样把扫描挪到恢复之后仍然全绿（本仓踩过这个坑，见测试里的注释）。

---

## 4. 回归验证

### 4.1 一键冒烟：`npm run plugins:island:smoke`

```bash
npm run dev                                  # 另开终端，vite 要在 5173
npm run plugins:island:smoke                 # 逐个点岛 + 断言握手与首屏 + 重启一次验恢复
# 受限环境（CI/沙箱，Chromium sandbox 起不来）：
npm run plugins:island:smoke -- --no-sandbox --disable-gpu
```

它做了什么：复制一份 `<userData>/plugins` 到**临时 userData**（不动你在用的宿主数据）→ 起一个宿主实例 →
按侧栏入口逐个点岛 → 用 CDP 进岛内断言 `typeof window.__sk === 'object'` 且 `sk.ready` 在超时内落地、首屏非空
→ **杀掉实例、用同一份 userData 重启一次**，不点任何导航，断言自动回到了最后点开的那个岛（§3.10）。
失败时会打印引导：**"首个岛正常、其余全坏" → §3.1；"全部坏" → §3.2/§3.3；"[重启恢复] ✗" → §3.10**。

### 4.2 三条必跑门禁

```bash
npm run verify:docs     # 文档交叉引用无悬空（删文件/改名后必须跑）
npx vitest run          # 含 tests/uiIslandBridgeLifecycle.spec.ts（切岛/分发/双端协议守卫）
npm run verify          # IPC 契约（preload ↔ types ↔ 主进程 handler）
```

### 4.3 手工取证配方（冒烟不够用时）

CDP 三行速查：给宿主加 `--remote-debugging-port=<port>` 启动 →
`curl -s http://127.0.0.1:<port>/json/list` 看 targets（宿主是 `localhost:5173`，岛是 `sk-plugin://<id>/…`，**跨源 iframe 是独立 target**）
→ 直接对目标跑 `Runtime.evaluate`（本文 §3.3 的三段探针）。
要点：**宿主与岛是两个 target**，只看宿主 DevTools 会漏掉岛内错误。

### 4.4 打包版核验（只验「运行时有没有进包」，不必出安装包）

```bash
npx electron-builder --mac --dir --arm64        # 只打包不签名、不出 dmg，最快
npx asar list release/mac-arm64/*.app/Contents/Resources/app.asar | grep plugin-ui-runtime
# 期望看到：/electron/plugin-ui-runtime.js（只有这一条，dist/electron/ 下不应再有一份）
```

判定依据不必跑起来：`electron-builder` 的 `files` 语义是**显式列举**（`node_modules/app-builder-lib/out/fileMatcher.js`
的 `getMainFileMatchers`：非空且含包含型模式时**不会**补 `**/*`，只额外补 `package.json` 与生产依赖的
`node_modules`，再叠加内置排除 `.git`/`release` 输出目录等）——所以出现在 `files` 里的
`electron/plugin-ui-runtime.js` 必进包，唯一风险是有人把它从 `files` 里删掉，这已由守卫测试钉住。

> 受限环境（沙箱 / 只读文件策略）跑不完 `electron-builder`：它会在写 asar 或读 `node_modules` 时被拦。
> 此时退化为「静态核验」——`grep -n plugin-ui-runtime electron-builder.yml` 有命中即等价通过。

---

## 5. 已知缺口（未修，供决策）

| #   | 缺口                           | 影响                              | 备注                                       |
| --- | ------------------------------ | --------------------------------- | ------------------------------------------ |
| 1   | 岛内 `dist/` 不进版本库        | 新克隆的仓库要各自 build 才能装岛 | 有意为之（避免产物入库），已由 Step 4 覆盖 |
| 2   | 市场 `catalog.json` 无删除路径 | 下架要手改 + 推远端               | 见 `PLUGIN_TRIAGE_PLAN.md`                 |

> 原第 1 项「重启后不恢复上次所在的岛」已于 2026-09-24 修复（§3.10；`AppShell.onMounted` 调整为扫描先于恢复），
> 并由冒烟脚本的 `[重启恢复]` 段做真机断言。

---

## 附：本次（2026-09-24）故障的完整证据链

- 环境：真实 Electron（dev）+ CDP 驱动；隔离 `--user-data-dir`，已装 4 个岛
- 修复前（逐岛点击，探针 = 岛内 `sk.ready` 是否落地）：
  | 顺序 | 岛           | 结果                                  |
  | ---- | ------------ | ------------------------------------- |
  | 1    | 店铺账号管家 | `BOOTED`，10828B 正常渲染             |
  | 2    | 订单归类     | `TIMEOUT`（无 boot）→ 空白            |
  | 3    | 利润追踪     | `TIMEOUT`（无 boot）→ 永久「加载中…」 |
- 反向验证：岛 → 便签（非岛模块）→ 订单归类 → `BOOTED`（组件被重建即恢复 ⇒ 坐实"桥随组件而不随岛"）
- 「重新加载」按钮 → `BOOTED`（重建会话即恢复）
- 修复后同一序列：1/2/3/4 全部 `BOOTED`，首屏内容完整；`npm run plugins:island:smoke` → 4/4 ✓
- 回归守卫：`tests/uiIslandBridgeLifecycle.spec.ts`（切岛必须重建桥 / 运行时必须随包分发 / 双端协议一致）
