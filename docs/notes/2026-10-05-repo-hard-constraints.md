# 本仓硬约束总表（跨工具，改代码前后都该扫一眼）

**为什么单开一条**：这些约束此前散在各工具的**私有记忆**里（`.workbuddy/memory/` 等）——
私有记忆**换机器即失效、别的工具看不见**（见 [`2026-09-30-cross-tool-context-sharing`](2026-09-30-cross-tool-context-sharing.md)）。
它们每条都对应一次真实踩坑，且**不止一个模块会再撞上**，所以必须入库。

**取证约定**：每条后面括号里是"这条是哪次踩出来的"，对应笔记在 `docs/notes/`。

---

## 一、工具与流程类

- **管道会把退出码换掉**：`npm run build | tail -2 && npm run smoke` 拿到的是 `tail` 的退出码 0 ⇒ build 静默失败
  仍往下跑、冒烟跑的是**旧 `dist/`**。曾因此把"变异后仍然全绿"读成"断言恒绿"（实际是断言有效、产物是旧的）。
  ⇒ **逐条命令单独看退出码**；也别与前一个后台任务（尤其 `vitest` 里 fork 子进程的 `publishGuard`）并发跑 build。
  （2026-10-05；通用写法见技能 `esm-spa-headless-smoke` §4.14）
- **变异测试一律用 Edit 工具改，别用 `node -e "…"` 拼引号**：shell 转义会把判据弄坏，脚本打印"❌ 未命中"
  却**已经把改动写进去了** ⇒ 变完白、还留下半截修改。收工前 `grep -rn MUTANT src/ scripts/ tests/` 是必做的一步。
  另一条：**变红要打在真正的守卫点**（内层 `throw` 可能被外层 `catch` 吞掉 ⇒ 照绿），**"没变红"什么都证明不了**。
  （2026-10-01 / 2026-10-05）
- **`ELECTRON_RUN_AS_NODE=1` 在本机 shell 默认带着**：会让 `electron` 当纯 Node 跑，`require('electron')` 返回的
  只是**路径字符串**（症状是 `Cannot read properties of undefined (reading 'setPath')`，**看不出是环境问题**）。
  凡要 `app` / `nativeImage` / `protocol` / `ipcMain` 的脚本一律：
  `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox --disable-gpu <script>`。（2026-10-05）
- **判"某某全仓不存在"要先换命令复核**：本机 Grep 工具对某模式返回 "No matches"，`grep -n` 却命中；
  且 **BSD grep 不支持 `\|` 做 BRE 交替**（`grep "a\|b"` **静默无命中**，看起来像"文件里真没有"）。
  要用 `grep -E "a|b"` 或直接用 Grep 工具。（2026-10-05）
- **文案里的入口名会被守卫拦**：写"去「X」"时 X 必须是真入口（模块名 / 岛 displayName / 今天页页签名）；
  自造路径（如「货与成本 › 商品ID 映射」）当场判红；确是"同页控件"才进 `ALLOWED_NON_ENTRY` 并写理由。
  实现见 `tests/uxEntryNames.spec.ts`。（2026-10-05）
- **注入式假桥脚本（模板字面量）里的注释不能含反引号**，正则要写 `\\.` —— 两条都踩过（反引号提前闭合模板串，
  报错却指向注释行）。改完先 `cp` 到 `/tmp/x.mjs` 跑 `node --check`。（2026-10-05）
- ⚠️ **工具私有记忆 `AGENTS.local.md` 是 `.workbuddy/memory/MEMORY.md` 的软链接**，而它**位于仓库根** ⇒
  `npm run verify:docs` 按**仓库根**解析 MEMORY.md 里的相对链接（写 `../../docs/…` 会判成越界悬空）。
  在里面引用笔记一律写**以仓库为基准的完整路径**（别用 `..` 回退，那会越界成悬空引用）。（2026-10-05）

## 二、守卫怎么才算"有效"

- ⭐ **假桥"太干净"会盖住真实缺陷**：**主进程派生的字段**（先例 `OrderRecord.itemId`）在假桥里是**夹具直接给的**
  ⇒ 宿主忘了 select 该列、派生逻辑整个坏掉，`today:ui` **照样全绿**。⇒ 这类字段必须由**数据层冒烟**守
  （`npm run order:smoke`），且夹具要放**名字相近的干扰列**（先例「商品名称」）证明没抓错列。（2026-10-05）
- **断言依赖"某行会消失"时，夹具必须真的让它消失**：列表不缩水 ⇒ "往后走一格"与"原地不动"不可分辨。
  先例给假桥加了 `__emulateCorrected` 开关（**默认关** —— 前半段断言要反复操作同一行）。（2026-10-05）
- **提示类断言必须先 `waitFor` 那句提示真的进 DOM**：假桥在 `invoke` 的**同步**阶段就记下了调用，而 toast 要等
  `await` 回来才 push、再等渲染才进 DOM ⇒ 那一刻取 DOM 只会得到"还没有提示"，**反向**断言（"不许出现 X"）
  于是在"没渲染"与"没有那句"之间**恒绿**（实测：把提示改成恒显示那句，它照样全绿）。（2026-10-05）
- **断言只用语义锚点**：`data-act` / `aria-label` / 业务键 / 可访问性角色。**不要**血缘或位置选择器
  （`aside > div` 这类把布局当契约，改 `div`→`button` 即假红）；**不要**用 `arr[0]` 当默认值 ——
  默认值要按语义取（先例：已归类行必须选中**它自己**的款）。（2026-10-01 / 2026-10-05）
- **删掉一个功能要留"它不在了"的反向断言**（钉 `data-act`，注释写"要加回来就改这条"）；
  且该断言要**自证非空转**（同查询路径能取到元素）。（2026-10-05）

## 三、界面类硬约束（几乎每次改界面都会撞）

1. **改宿主界面 = 只换 class / 加包裹层，文本节点一字不动**。`*:ui` 的断言判据是 `el.textContent`
   的**子串**，而 `textContent` **不给相邻元素插分隔符** ⇒ 把"标签 + 数字"拆成兄弟元素会拼成 `产品2`，断言红，
   **红的不是样式**。要改文案就得**同时**把断言从"整段拼串"升级为"按元素断言（钉在 `data-act` 上）"。
   ⚠️ 更隐蔽的是**裸空格**：Vue 的 `whitespace:'condense'` 会**整段删除含换行的空白文本节点**。
   （2026-10-01，取证：`goods:ui` 实测输出 `产品 2SKU 3缺克重 1…`）
2. **`flex:1` 的 grid 里放 `<table>` 必须写 `align-content: start`**（否则行被摊到 200+px）。**「信息展示不全」
   先量 `scrollWidth`** —— `.wb-panel{overflow:hidden}` 会**静默裁掉**超宽内容（无滚动条、无报错、DOM 字段不少）。
   （2026-10-03）
3. **同屏并列、允许相减的两个数必须同口径**（曾 `costTotal` 含关闭单而 `revenueTotal` 不含 ⇒ 相减得错数却看不出）。
   延展：**"全零"不是正确表达**（N 个 `缺X 0` ⇒ 只在非零时列）。（2026-10-03）
4. **新增 `--wb-*` 主题令牌必须同步 `uiBridgeHost.ts` 的 `WB_THEME_TOKENS`**（`tests/uiIslandThemeTokens.spec.ts`
   双向守卫）。（2026-10-01）
5. ⚠️ **`src/core/services/ipc.ts` 顶层就求值 `window.electronAPI`** ⇒ **node 环境的 `vitest` 不能 import
   任何经它的模块**（`@/core/network/*`、`@/core/ai/*`…）。要单测的纯逻辑必须自己不依赖它 ——
   先例：提示词被拆进纯模块 `src/core/ai/visionPrompt.ts`，好让"枚举必须与词表同源"成为**行为断言**
   而不是扫源码文本（模式写歪就恒绿）。（2026-10-05）

## 四、能力域与 op 预算（ADR-002 N5）

- 单域 op ≤ 10；真门槛 `externalManifest.MAX_ACTIONS`，判据在 `src/core/plugin/host.ts` 的 `DB_OPS` 顶层键。
  `mail` / `secrets` / `storage` / `clipboard` / `dialog` 是独立域，不数进 db。超预算存量在
  `tests/pluginTriage.spec.ts` 的 `GRANDFATHERED` 冻结，**只许变少**。
- 快到上限按 **C4 拆只读子域**；`security.ts` 对 domains 与 actions **分别独立检查**。两点易漏：
  ①判据是消费者**结构上够不到写 op**；②**拆域必须连带消费岛发版**。
- 岛声明数可少于宿主 op 数，但**声明了就必须真调用**（守卫双向）。
- **域可以删，判据是"有没有消费者"而非"还有没有代码提到它"**（内建页与宿主同进程、够不到 `DB_OPS`
  ⇒ "宿主也在用这些表"**不构成保留理由**）。删域后**就地留墓碑**；`verify` 应显示 **IPC 契约零改动**。
  删守卫时**同组"自证"断言要换锚点**（原锚点常正好是被删的域）。（2026-10-05）
- ⚠️ **能力域 ≠ 存储命名空间**：`modules.order-insight` 是**已落盘的用户数据键**（引擎配置 + 列映射），
  改名会让 API Key 静默消失 ⇒ 名刻意保留。（2026-10-05）

## 五、收工纪律

- 每轮三件事：①**落 git 提交**；②`CHANGELOG.md` 记做了什么；③跨工具结论写
  `docs/notes/YYYY-MM-DD-<slug>.md` **并在 `docs/notes/README.md` 表里登记**。
- ⚠️ **本仓踩过大坑**：HEAD 曾停在 2026-09-22 达**两周**，263 项变更含**整套新冒烟**，**从未 `git add`**
  ⇒ **`git status` 一片脏 ≠ "刚改的"**。（2026-10-05）
- 计数类事实（冒烟项数 / 通道数）**顺手回写 `docs/baseline/PROJECT_BASELINE.md`**。
- 远端 `main` / `master` **长期不同步**（多轮提交只在本地）⇒ 别假设线上有这些改动。
