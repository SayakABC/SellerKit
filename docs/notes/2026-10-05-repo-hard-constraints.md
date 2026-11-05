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
- ⭐ **变异跑完必须 `npm run build` 再跑最终门禁**：`*:ui` 一律读 `dist/`，而变异改的是 `src/` ——
  改回来却忘了 rebuild，**变异体就留在 `dist/` 里**，最后一次全量冒烟会挂着几条"源码看着完全对"的假 FAIL。
  识别特征：**红的正是那条变异所针对的断言**。2026-10-08 实测踩到（`firstRun.ts` 的 `&&` 变异体
  让「零款但订单已进队列 → 卡不出现」与窄视口的同款断言同时假红，rebuild 即恢复）。
- ⚠️ **子进程/GUI 类冒烟不能只看退出码**：`plugins:island:smoke` 在 Chromium sandbox 起不来时
  （`sandbox initialization failed` → GPU 反复崩 → `GPU process isn't usable. Goodbye.` → SIGTRAP）
  **退出码仍是 0**。两条纪律：①本机跑要显式传参 `npm run plugins:island:smoke -- --no-sandbox --disable-gpu`；
  ②必须看输出里有没有 `4/4 个 UI 岛` 那一行。另：它要求 vite dev server 在跑，而**起它和跑它必须在同一次
  命令调用里**（分两次调用连不上，脚本只说"连不上 vite dev server"）。（2026-10-08）
- **本机是 zsh**：取管道前一环的退出码用 `${pipestatus[1]}` —— `PIPESTATUS[0]` 是 bash 写法，在 zsh 里
  **恒展开为空**，看起来像"命令没报错"。（2026-10-08）
- **变异测试一律用 Edit 工具改，别用 `node -e "…"` 拼引号**：shell 转义会把判据弄坏，脚本打印"❌ 未命中"
  却**已经把改动写进去了** ⇒ 变完白、还留下半截修改。收工前 `grep -rn MUTANT src/ scripts/ tests/` 是必做的一步。
  另一条：**变红要打在真正的守卫点**（内层 `throw` 可能被外层 `catch` 吞掉 ⇒ 照绿），**"没变红"什么都证明不了**。
  （2026-10-01 / 2026-10-05）
- **`ELECTRON_RUN_AS_NODE=1` 在本机 shell 默认带着**：会让 `electron` 当纯 Node 跑，`require('electron')` 返回的
  只是**路径字符串**（症状是 `Cannot read properties of undefined (reading 'setPath')`，**看不出是环境问题**）。
  凡要 `app` / `nativeImage` / `protocol` / `ipcMain` 的脚本一律：
  `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron --no-sandbox --disable-gpu <script>`。（2026-10-05）
- ⚠️ **`electron <script>` 在"加载期"报错时照样退 0**：语法错 / 顶层 `require` 失败会走 Electron 自己的
  `App threw an error during load` 路径，进程退出码是 **0** —— 脚本末尾那句 `process.exit(failed ? 1 : 0)`
  **根本没执行到**。实测：往冒烟脚本插断言时漏掉了下一条用例的 `check(...)` 开头行 ⇒ 语法错 ⇒
  `echo $?` 是 0（看着"全绿"）、`tail` 里只有一段 `SyntaxError` 堆栈。
  ⇒ 跑 electron 冒烟前先 `node --check <script>`，并且**别只看退出码**：同时确认输出里有
  `✅ 全部通过` / `✓ 全部通过（N 项）`。（2026-10-08）
- **判"某某全仓不存在"要先换命令复核**：本机 Grep 工具对某模式返回 "No matches"，`grep -n` 却命中；
  且 **BSD grep 不支持 `\|` 做 BRE 交替**（`grep "a\|b"` **静默无命中**，看起来像"文件里真没有"）。
  要用 `grep -E "a|b"` 或直接用 Grep 工具。（2026-10-05）
  ⚠️ **2026-10-08 又踩一次（S4 轮）**：用 `grep "goTab\|TabId\|GOODS_LAYOUT\|tab-products"` 查"页签相关还有哪些引用点"，
  整条命令返回**空**（退出码 1），看起来像"这些标识符已经没人用了、页签只需改一处"。改用 Grep 工具立刻看到
  `GoodsView.vue` 里多处命中 —— 差一点据此低估改动面。**凡是 `\|` 交替，一律 `grep -E` 或 Grep 工具，没有例外。**
- **文案里的入口名会被守卫拦**：写"去「X」"时 X 必须是真入口（模块名 / 岛 displayName / 今天页页签名）；
  自造路径（如「货与成本 › 商品ID 映射」）当场判红；确是"同页控件"才进 `ALLOWED_NON_ENTRY` 并写理由。
  实现见 `tests/uxEntryNames.spec.ts`。（2026-10-05）
- **注入式假桥脚本（模板字面量）里的注释不能含反引号**，正则要写 `\\.` —— 两条都踩过（反引号提前闭合模板串，
  报错却指向注释行）。改完先 `cp` 到 `/tmp/x.mjs` 跑 `node --check`。（2026-10-05）
  ⚠️ **2026-10-08 一天之内累计复现七次**（S1 轮 1 · 「页面减负」轮 2 · **S3 轮 4**）：
  给 `goods-ui-smoke.mjs` **新增**断言时，新写的注释里带了 `` `SkuMappingView` `` / `` `waitFor` `` /
  `` `calls` `` / `` `image-thumb-batch` `` / `` `disabled` `` / `` `click()` `` / `` `useProductList` ``
  （全都是"想引用得更清楚"）⇒ 模板串在注释行被截断。因为门禁纪律已立，跑冒烟前先 `node --check`
  当场抓到（报 `SyntaxError: Unexpected identifier`，**行号指向注释本身**）—— 代价只是几秒，不是一次假绿。
  ⇒ 在 `FAKE_BRIDGE` / `ASSERT_SCRIPT` 这类内嵌脚本里，**任何**想加反引号的冲动都改用引号或直接裸写标识符。
  ⭐ **S3 轮的 4 次全发生在"边写边加断言"的中间过程**（一次改一行注释也会中）⇒ 别指望一次写对，
  把 `node --check` 当成**每次编辑注入脚本之后的固定动作**，与"改界面先 build"同级。（2026-10-08）
- ⚠️ **`node --check` 覆盖不到*注入脚本的内容*（盲区）**：`<script>` 派生的冒烟脚本里，两段要注入的东西
  （`FAKE_BRIDGE` / `ASSERT_SCRIPT`）是**模板字面量的内容**，而 `node --check` 只校验**外层 JS**。
  于是它能抓到"模板串提前闭合"（那会让外层语法错），却**抓不到注入脚本自己写错语法** ——
  症状是页面挂掉、runner 只报"没抓到 #smoke-result"，离真正的原因隔了好几层（要靠肉眼翻几百行注入代码）。
  ⇒ 新增/改动注入脚本后，**把它抠出来单独 check**：按模板串的起止（`const X = <模板串起点>` 到结尾的
  `` `; ``）切出内容，剥掉 `<script>` 标签，各自 `node --check` 一遍。写一次就几秒，
  能省掉一整轮"猜哪里挂了"。（2026-10-08，S4 轮新增 `finish()` / `narrowViewportChecks()` 时立）
- **删掉一个被文档多处引用的源文件，会让 `verify:docs` 变红**（哪怕那些文档是**历史记录**：
  "当时新增了它"）。此时**不要**去把文档改指现存文件（句子会变成假的）—— 按守卫的设计走
  `scripts/check-doc-links.mjs` 的 `DELIBERATELY_MISSING` 豁免表，逐条写清"为什么改成存在的路径后句子就不成立了"，
  并在被引用的笔记顶部加 ⚠️ 横幅说明它已降级为历史记录。（2026-10-08，删 `flow.ts` / `tests/goodsFlow.spec.ts` 时）
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
  ⚠️ **反过来也有一坑（恒红）**：`--virtual-time-budget` 页**一次跑完、toast 永不过期** ⇒ 上一步的回执一直留在
  DOM 里，拿**全页合计**（`all('.wb-toast__text').join()`）去判"这一条有没有/有没有那句"会被旧话污染：
  反向断言（"不许出现 X"）被上一步的值污染成**恒红**（正向同类断言则被污染成恒绿）。⇒ 要 **`lastToastWith(needle)`**
  只认**含本次动作特征词的那一条**（先 `waitFor` 它进 DOM，再在**这一条**上判"含不含另一段话"）。（2026-10-08）
- ⚠️ **别把断言本身写成 `waitFor` 的条件**：`await waitFor(() => 条数 === 2)` 在条数不对时只会 `timeout`，
  而 timeout 会把**整段断言脚本**打断 —— 后面几十条一起消失，读日志的人只看到 `timeout`，看不出是
  "多了"还是"少了"。正解：`waitFor` 只等**"渲染出来了"**（`>= 1` / 元素存在），条数用 `report` 判。
  实测：变异"反查不带 productId"原本只报 timeout，改完报出 **3 条可读 FAIL 且后面 80 多条照跑**。
  同理**读 DOM 的值要空安全**（`el ? el.value : null`）：元素不见了应当是一条 FAIL，
  而不是 TypeError 把整段打断（变异"行展开不渲染 SKU 子表"实测）。（2026-10-08）
- ⭐ **等待条件不能指向"上一步也可能出现"的那句话**（`waitFor` 被上一步满足 ⇒ 读到旧值）。
  实测：按 `lastToastWith('新增 2 条')` 等回执 —— 但上一步（直连）也发过同样一句，虚拟时间下它
  还没过期 ⇒ 条件立刻为真、拿到的是**上一步**的 toast，那条"回执报出采纳了几张款主图"于是**恒缺**。
  ⇒ 等待条件要指向**这一次才可能出现的那句话**（本例改用「款主图」），且判定留给 `report`（`settle`
  不抛 → 可读 FAIL）。（2026-10-08）
- ⭐ **写入期间按钮是 `disabled` 的，而在 disabled 按钮上 `click()` 不派发事件**（不是"点了没反应"，
  是**根本没有 click 事件**）。实测：对比模式的 `Esc` 那一步在写入刚完成时点「对比」，弹层没打开，
  症状读起来像"功能坏了"。⇒ 先 `waitFor` 它**恢复可点**再点 —— 这条等待本身也是个断言（写入完成后
  动作必须恢复可点，不能永久卡在禁用态）。同 S1 的 `rebind` 步骤。（2026-10-08）
- ⭐ **"某通道只调了 N 次"这种绝对计数会被同通道的其它调用污染**。实测：队列断言"缩略图是合批取的
  （只调 1 次 `orderImageThumbBatch`）"—— 左栏产品列表走的是**同一条**通道，于是它恒红。⇒ 断言守的是
  哪一侧的行为，就只数哪一侧的调用（按入参内容过滤：`items.some(x => x.localPath === 订单图)`）。
  （2026-10-08，S3）
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
