# UI 岛（外置插件）冷启动「数据加载不出来 + 样式不跟主题」根因分析与修复

- 日期：2026-09-22
- 范围：宿主桥 `src/core/plugin/uiBridgeHost.ts`、iframe 端运行时 `electron/plugin-ui-runtime.js`、`order-insight` / `ae-profit` 两个 UI 岛
- 结论：两个症状**不是同一个 bug**，但都属于同一类「静默失效」——出问题时既不报错也没有自愈路径。

---

## 0. 结论摘要

| # | 症状 | 根因 | 修复 |
|---|---|---|---|
| 1 | 重启后岛内数据加载不出来，必须点工具条「重新加载」才恢复（冷启动必现） | **握手竞态 + 静默丢包**：宿主「iframe load 安全网」先发 boot(A)，迟到的 `hello` 又把 token 轮转成 B，岛**已在途**的首批 `call(A)` 被判为串台；旧实现对 token 不匹配的消息**直接丢弃且不回包** → 岛内 pending 永不 reject | `hello` 改为复用同一 token 补发 boot（不轮转）；token 不匹配的 `call` 一律回错误包 |
| 2 | 订单归类 / 利润追踪的「页面样式跟主题不一样」（深色主题下） | **`color-scheme` 不是设计令牌**，无法随 `--wb-*` 注入。岛里写死 `color-scheme: light`（或完全不声明）时，面板与文字已跟随主题变黑，**只有原生控件**（日期选择器 / 下拉弹层 / 滚动条 / 复选框 / 输入光标）仍是浅色 | 宿主 boot/theme 载荷增加 `theme.mode`（`light|dark`），运行时把它写到 iframe `<html>` 的内联样式上（内联优先级可覆盖岛内写死的值） |
| 3 | （附带发现）`dispose()` 的 `abort` 消息**发不出去** | `alive = false` 先于 `post(...)`，被 `post` 自身的 `if (!alive) return` 守卫吞掉 → 岛内在途调用无法被中止（同属"静默挂起"） | 先广播 `abort` 再置 `alive = false`。由新增用例抓出 |

两条修复都做了**双端同步**（AGENTS.md 红线 20）并各自留下守卫。

---

## 1. 症状 1：握手竞态导致的静默丢包

### 1.1 时序（冷启动必现，非偶发）

```
t0  UiIslandView 挂载 → 建 iframe(sk-plugin://…) → attachUiIslandBridge() 监听 message
t1  iframe 文档 load 事件到达宿主 → 「安全网」onFrameLoad() → token=null → issueBoot() → boot(A)
t2  岛收到 boot(A)：token=A、ready resolve → 立刻发出首批能力调用 call(A)（order-insight 是 4 个 db.call）
t3  **迟到的** hello 到达宿主（iframe 端 DOMContentLoaded 早于 load 发过，但跨进程投递被打乱）
    → 旧实现 issueBoot() → token=B，并再次 boot
t4  宿主收到 call(A)：token 已变 B → 判为"伪造/串台" → **直接 return，不回包**
t5  岛侧 pending[1] 永不 resolve → 首屏永久「加载中」；点「重新加载」重建桥 → 恢复正常
```

关键点：`t1` 的「安全网」与 `t3` 的「hello」**都会**触发 `issueBoot()`，而 `issueBoot()` 每次都 `crypto.randomUUID()`。
两个触发源谁先谁后由 iframe（跨源 → 独立进程）的 postMessage 投递与父窗口 load 事件竞速决定，
因此**冷启动时必现、手工点刷新时又"好了"**（刷新路径下 hello 稳定先到）。

### 1.2 为什么"丢包"比"轮转 token"更致命

token 轮转本身只制造一个很短的窗口；真正让故障表现为**永久卡住**的是第二段：

```ts
if (typeof d.token !== 'string' || d.token !== token) return; // 旧实现：静默丢弃
```

岛侧 `call()` 把 promise 存在 `pending[id]`，只有收到 `call-result` 才会 settle。
宿主既不执行也不回包 → 该 promise 永久 pending，**岛内没有任何超时/重试可自愈**（`bridge.js#ready()` 只对握手有 8s 超时，对能力调用没有）。

### 1.3 复现探针（取证后已删除，重建配方见 §6）

探针是未纳入版本库的临时无头脚本（`.sk-probe/` 目录，收口时已按指示删除）。它的作用：
真实 `sk-plugin://` 协议 + **已安装**的岛产物 + 可切换的宿主桥实现（`old` 复刻旧行为 / `new` 修复后），
并注入脚本回报岛内真实生效的值。下面是当时的实测记录（命令中的文件已不存在）：

```
# 探针脚本已删除（见 §6 重建配方）；以下为当时实录
# 旧实现：首批调用全被丢弃
electron .sk-probe/main3.js order-insight dark old
  [host] 安全网 issueBoot
  [host] issueBoot(新 token) tok-e6lniq
  [host] 收到 hello
  [host] issueBoot(新 token) tok-iigwrg          ← 轮转
  [host] ✗ 丢弃 call（token 不匹配 got=tok-e6lniq want=tok-iigwrg）— 岛侧该调用永久挂起
  [host] 汇总: 成功 call=0 被丢弃 call=1

# 修复后：同一序列，全部应答
electron .sk-probe/main3.js order-insight dark new
  [host] repostBoot(复用 token tok-1z6rde)       ← 不轮转
  [host] ✓ call db.call ×4
  [host] 汇总: 成功 call=4 被丢弃 call=0
```

`ae-profit` 同法验证：修复后 `成功 call=12 被丢弃 call=0`。

---

## 2. 症状 2：`color-scheme` 不在令牌体系里

### 2.1 机制

- 宿主把 `--wb-*` 令牌以**内联样式**写到 iframe 的 `<html>` 上（`electron/plugin-ui-runtime.js#applyTheme`），
  内联优先级高于岛内样式表里的 `:root` 回退值 —— 所以**配色本身是对的**（探针实测 `--wb-bg=#15171c`，`body` 背景 `rgb(21,23,28)`）。
- 但 `color-scheme` 是 CSS 属性、**不是自定义属性**，`WB_THEME_TOKENS` 那 22 个令牌里没有它，
  它也不会从宿主 `data-theme` 属性继承过来（iframe 内的 `<html>` 没有 `data-theme`）。
- 于是岛里 `:root { color-scheme: light }`（写死）或干脆不声明（继承初始值 `normal`）时，
  引擎按「本页面只支持浅色」渲染**原生件**：`<input type=date>` 日历面板与图标、`<select>` 弹层、
  滚动条、checkbox/radio、输入光标。

### 2.2 四岛实测（深色主题，逐个岛跑同一无头探针）

| 岛 | 修复前 | 修复后 |
|---|---|---|
| `order-insight`（订单归类） | `html=normal date=normal select=normal` ❌ | `html=dark date=dark select=dark` ✅ |
| `ae-profit`（利润追踪） | `html=light date=light select=light` ❌（`style.css` 写死 light） | `html=dark date=dark select=dark` ✅ |
| `excel-copy` | `html=normal …` ❌（同一缺陷，用户未提及） | `html=dark …` ✅ |
| `shop-accounts` | `html=dark …` ✅ | 未受影响（岛内 `ui-plugins/shop-accounts/src/theme.js` 自己按 `--wb-bg` 亮度回写过） |

`order-insight` 的命中点最直白：`ui-plugins/order-insight/dist/views/stockin.js` 里「拿货对账」时间窗与「拿货日期」
就是 `<input type="date">`，深色下原本渲染成白色控件。

### 2.3 `shop-accounts` 的先例

同一现象在 2026-09-21 已被 `ui-plugins/shop-accounts/src/theme.js` 记录并绕过（岛内自行按 `--wb-bg` 亮度回写 `color-scheme`）。
本次改为**宿主统一下发**：宿主本来就知道自己是哪套主题（`data-theme`），不必让每个岛去嗅探颜色亮度；
`shop-accounts` 的旧机制与宿主新机制取值一致，不冲突。

---

## 3. 修复清单

| 文件 | 改动 |
|---|---|
| `src/core/plugin/uiBridgeHost.ts` | ① `hello` 不再轮转 token（新增 `repostBoot()`，复用会话密钥）；② token 不匹配的 `call` 回错误包而非静默丢弃；③ 新增 `currentThemeMode()`，boot/theme 载荷带 `theme.mode`；④ `dispose()` 先发 `abort` 再置 `alive=false`；⑤ `repostBoot()` 一并触发 `onBooted`（否则岛 reload / 换岛后工具条状态灯停在"等待桥握手"） |
| `electron/plugin-ui-runtime.js` | `applyTheme(vars, mode)` 同时写 `<html>` 的 `color-scheme`（`mode` 缺失时保持岛内声明，不猜） |
| `tests/uiBridgeHost.spec.ts`（新增） | 7 例行为回归，自建 `window`/`document` 桩、**不引 jsdom**（保持 vitest `environment: node`）：hello 不轮转 / 陈旧 token 必回错包 / 来源不符必丢弃 / dispose 发得出 abort / boot 与 pushTheme 都带 mode / 非 light-dark 时不猜模式 |
| `AGENTS.md` | §1.6 增「`color-scheme` 不是令牌，须单独跟随」；§6 测试覆盖清单增第 ④ 类 |
| `docs/architecture/PLUGIN_ARCHITECTURE.md` | §15.3 主题条款补 `theme.mode` 与原生件说明 |
| `docs/baseline/PROJECT_BASELINE.md` | §10 双端契约由「两条纪律」扩为四条（补 ③ 不轮转 token / ④ theme.mode） |
| `CHANGELOG.md` | `[Unreleased]` 增 Fixed 段 |
| `ui-plugins/shop-accounts/src/components/AccountEditor.vue` | `.date-input` 元素级 `color-scheme: light` → `inherit`；删除永不命中的 `:global([data-theme='dark'])` 死规则 |
| `ui-plugins/ae-profit/src/style.css` | `@layer components` 日期/时间输入组 `color-scheme: light` → `inherit` |
| `ui-plugins/{shop-accounts,ae-profit}/manifest.json` + `package.json` | 版本递增 1.4.4 / 1.0.2（同版本改内容会撞 sha256 校验，见开发指南 §9） |

---

## 4. 验证证据

| 项 | 结果 |
|---|---|
| 症状 1 复现（旧实现） | `成功 call=0 被丢弃 call=1`，岛首屏空白（截图 `/tmp/probe-old-dark.png`） |
| 症状 1 修复后 | `成功 call=4 被丢弃 call=0`（order-insight）、`12/12`（ae-profit），首屏正常渲染 |
| 症状 2 修复后 | 四岛 × 深浅两套主题：`html/body/date/select/text` 的 `color-scheme` 全部与宿主一致 |
| `npx vue-tsc --noEmit` | 0 error |
| `npx tsc -p tsconfig.electron.json --noEmit` | 0 error |
| `npx vitest run` | 16 文件 **232/232** 通过（225 → 232，新增 7） |
| `npx eslint .` | 0 error / 365 warning（全部为既存 `no-console`、`no-explicit-any`） |
| `npm run verify` | IPC 契约一致（preload 141 / types 141 / 主进程 137） |
| `npm run verify:docs` | 无悬空引用 |
| `npm run build` | 通过（146 modules） |
| 岛侧收口（14:20） | 两岛重建产物静态校验：元素级 `color-scheme` 仅剩 `inherit`（shop-accounts ×2 / ae-profit ×1），`light` 仅存在于 `:root` 首帧兜底；`data-theme` 死选择器 0 残留；运行时目录版本 = 1.4.4 / 1.0.2 |

---

## 5. 残留项（**已于 2026-09-22 14:20 全部收口**，逐条状态见下表）

| # | 项 | 处置 |
|---|---|---|
| 1 | `shop-accounts/src/components/AccountEditor.vue` `.date-input` 元素级 `color-scheme: light` + 永不命中的 `:global([data-theme='dark'])` 选择器 | ✅ 改为 `inherit`、删除死选择器；随 1.4.4 重建并重装 |
| 2 | `ae-profit/src/style.css` `@layer components` 里日期/时间输入组 `color-scheme: light` | ✅ 改为 `inherit`；随 1.0.2 重建并重装 |
| 3 | `excel-copy` 无 `color-scheme` 声明 | ✅ 无需改动（已由宿主机制覆盖） |
| 4 | `.sk-probe/` 无头探针 | ✅ 已删除（按用户指示）；需要复现时按 §6 重建 |
| 5 | 已安装副本需重建 + 重装 | ✅ 两个岛均已重建、重装到 `<userData>/plugins/`，市场包与 catalog 已更新 |

---

## 6. 收口动作（2026-09-22 14:20）

**岛侧改动**（元素级 `color-scheme` 收敛为 `inherit`）：

| 文件 | 改动 | 版本 |
|---|---|---|
| `ui-plugins/shop-accounts/src/components/AccountEditor.vue` | `.date-input { color-scheme: inherit }`；删除 `:global([data-theme='dark']) .date-input` 死规则 | 1.4.3 → **1.4.4** |
| `ui-plugins/ae-profit/src/style.css` | `input[type='date'\|'datetime-local'\|'month'\|'time'] { color-scheme: inherit }` | 1.0.1 → **1.0.2** |
| `ui-plugins/*/package.json` | 版本号同步（发布脚本与工程版本一致） | — |

**产物与分发**：

- 重建：`ui-plugins/ae-profit` → `dist/assets/index-DnT5yLt_.css`（`inherit` ×1 + `:root` 兜底 `light` ×1）、
  `ui-plugins/shop-accounts` → `dist/assets/index-7ZhzKLF5.css`（`inherit` ×2 + `theme-*.css` 的 `:root` 兜底 ×1，死选择器 0 残留）。
- 重装：`<userData>/plugins/{ae-profit,shop-accounts}` 按「manifest + dist」形态重建（同 `scripts/plugin-create.js --install` 语义）。
- 市场：`market-out/ae-profit-1.0.2.zip`（sha256 `a219062f…`）、`market-out/shop-accounts-1.4.4.zip`（sha256 `0a9ceba6…`），
  `catalog.json` 两条目已更新。**未推送远端**（`market-out` 的 `git push` 待人工确认）。

**复现探针如何重建**（`.sk-probe/` 已删）：核心是「Electron 主进程注册 `sk-plugin://` 协议 → 读 `dist/index.html`
→ 注入 `electron/plugin-ui-runtime.js` → 用 `postMessage` 模拟宿主 boot/theme 载荷 → 截图 + 回报 `getComputedStyle`」。
产物在 `<userData>/plugins/<id>/dist`，宿主 CSS 取本仓 `src/styles/index.css`，两套宿主实现（修复前/后）分别在
`git show HEAD:src/core/plugin/uiBridgeHost.ts` 与工作区版本。

