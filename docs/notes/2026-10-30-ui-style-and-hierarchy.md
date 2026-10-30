# 界面风格与视觉层级：35 条结论（蒸馏自 6 篇，2026-10-01 ~ 2026-10-10）

> **蒸馏笔记**：由 6 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/<原文件名>`

## 1. 真正可见的缺陷只有 3 处，其余是同一角色被写了 5–6 遍

**结论**：本轮界面问题里，**真正可见的缺陷只有 3 处**，其余全是**同一角色被写了 5–6 遍** —— 按钮/输入框/标签在各模块里各有一套高度(24/26/28)、圆角(6/8/12)、字号(12/13)，所以"看起来不像一个软件"。修法不是逐页调像素，而是**在 `src/styles/index.css` 补一层统一基座**（`.wb-btn` / `.wb-tag` / `.wb-input--sm`），模块侧只留布局职责。配套补齐此前**完全缺失**的三件事：全局 `:focus-visible` 焦点环、`prefers-reduced-motion` 兜底、圆角尺度令牌。

**取证**：原笔记的判据即"缺的是'层'，不是'页'"——按钮/输入框/标签在各模块里各有一套高度(24/26/28)、圆角(6/8/12)、字号(12/13)；基座落在 `src/styles/index.css` 的 `.wb-btn` / `.wb-tag` / `.wb-input--sm`，模块侧只留布局职责。三件"完全缺失"的逐条取证见 §2。

**源**：`2026-10-01-ui-style-system-audit`（2026-10-01）

## 2. 三件缺失是全仓的，不是某页的问题

**结论**：键盘焦点不可见、无减弱动效兜底、圆角无档次 —— 这三项在 `src/` 整棵树上都不存在，属于**全仓缺失（不是某页的问题）**。

**取证**：

| 缺什么 | 取证 | 后果 |
| --- | --- | --- |
| 键盘焦点不可见 | `src/` 下 `focus:` / `focus-visible` 命中总计 **4 处**（`.wb-input:focus`、`.rs-input:focus` 等），全部集中在输入框 | Tab 走一遍界面，侧栏项/工具栏按钮/列表行/弹层菜单项**没有任何**可见焦点（WCAG 2.4.7） |
| 无减弱动效兜底 | `prefers-reduced-motion` 在 `src/` 下 **0 命中** | toast 滑入、命令面板淡入、侧栏宽度过渡照播 |
| 圆角无档次 | `--wb-radius: 12px` 同时喂给卡片与 26px 高小按钮、18px 高标签 | 26px 高的按钮配 12px 圆角已接近胶囊；同屏 6/8/12 三种圆角互不呼应 |

新增令牌：`--wb-radius-sm/md/lg`（`--wb-radius` 保留并指向 lg，存量调用点不动）、
`--wb-focus`、`--wb-focus-ring`、`--wb-on-accent`。

**源**：`2026-10-01-ui-style-system-audit`（2026-10-01）

## 3. 新增 `--wb-*` 令牌必须同步 `WB_THEME_TOKENS`

**结论**：新增 `--wb-*` 令牌必须同步 `src/core/plugin/uiBridgeHost.ts` 的 `WB_THEME_TOKENS`，漏一处即失败；本轮新增 `--wb-border-strong` 与 `--wb-elev-1/2/3`，**四处一起改**。

**取证**：否则 `tests/uiIslandThemeTokens.spec.ts` 直接红（岛内那个令牌永久拿不到，`var()` 解析失败会丢掉整条声明）。该用例**双向校验**（清单 ⊇ 定义、且清单内无孤儿）。

**源**：`2026-10-01-ui-style-system-audit`（2026-10-01）、`2026-10-01-ui-visual-hierarchy`（2026-10-01）

## 4. 对比度有两处不达 AA（已量化）

**结论**：用 WCAG 相对亮度公式实算（不是目测），`--wb-text-muted` 与 `--wb-success` 两处不达 AA，`--wb-danger` 达标不动。深色主题一档（`#15171c` 底）原本就有 6–9:1，**不动**。

**取证**：

| 令牌 | 原值 | 用在 | 对比度 | 判 |
| --- | --- | --- | --- | --- |
| `--wb-text-muted` | `#8a909a` | 白底上的 11–13px 说明文字 | **3.2:1** | ✗（AA 要 4.5:1） |
| `--wb-success` | `#16a34a` | toast 底配白字 / 白底上的成功文字 | **3.3:1** | ✗（同 `.pk-ok`、`.gd-hint` 也是文字色） |
| `--wb-danger` | `#dc2626` | 同上 | 4.8:1 | ✓ 不动 |

改为 `--wb-text-muted: #666d79`（白底 5.2:1、画布底 4.8:1）、`--wb-success: #15803d`（5.0:1）。

**源**：`2026-10-01-ui-style-system-audit`（2026-10-01）

## 5. 输入框主题化按 `type` 逐个列举，漏了两个最常用的

**结论**：`src/styles/index.css` 原按 `input[type='text'|'search'|'date'|…]` 列举，**漏了 `number` 与 `password`**——恰好是克重/天数窗/温度/费率与 API Key 用的类型。已改为排除法（排除 checkbox/radio/range/file/color/button/submit/reset/image），新增 type 自动纳入。

**取证**：漏掉的类型拿不到 `--wb-surface-2`，只能由 UA 按 `color-scheme` 渲染 ⇒ 深色主题下与相邻的 text 输入框**明显不同底色**。

**源**：`2026-10-01-ui-style-system-audit`（2026-10-01）

## 6. `flex:1` 的 grid 里放 `<table>` 必须写 `align-content: start`

**结论**：这是本轮**唯一的真·布局 bug**。判据可复用：`flex: 1` 的 grid 容器里放 `<table>` / 需要按内容高度的子项，必须写 `align-content: start`（或 `align-items: start`）。这条不是"审美"，是可复现的渲染行为。

**取证**：`src/modules/goods/GoodsView.vue` 的 `.gd-body` 是 `flex: 1` + `display: grid`，且**没写 `align-content`**：

1. 隐式行的默认对齐是 `stretch` ⇒ 这一行被撑到容器整屏高；
2. `align-items` 默认也是 `stretch` ⇒ `<table>` 作为 grid item 一起被拉高；
3. **表格会把多出来的高度摊到各个 `<tr>` 上** ⇒ 两行数据各被拉到 200+px，表看起来像散架。

修法：`align-content: start`。

**源**：`2026-10-01-ui-style-system-audit`（2026-10-01）

## 7. 假桥冒烟脚本本身就是截图器，不用起宿主

**结论**：现成的假桥 UI 冒烟脚本本身就是"真产物 + 真假桥 + 无头 Chrome"，把 Chrome 参数换个开关就是截图器；截图参数替换的唯一可靠判据是 `'--dump-dom',` 这一个 token，不能按整串匹配。

**取证**：

```bash
cp scripts/goods-ui-smoke.mjs scripts/_shot.mjs        # 必须在仓库内：脚本用 xlsx 等依赖
# 把 '--dump-dom', 换成 '--window-size=1440,980', '--screenshot=/tmp/x.png',
node scripts/_shot.mjs                                  # 脚本末尾会在"没抓到 #smoke-result"处退出，PNG 已经写好
```

- 它跑完会 `process.exit(1)` 并报"没抓到 #smoke-result"——**这是预期的**，截图已经落盘，只看 PNG。
- `sips -c 高 宽 --cropOffset y x in.png --out out.png` 可放大局部（本轮就是靠放大才确认 toast 是**白字红底**，小图会误判成黑字）。
- ⚠️ 脚本放 `/tmp` 会 `ERR_MODULE_NOT_FOUND: xlsx`（ESM 不读 `NODE_PATH`）；**用完删掉**，别留在 `scripts/`。
- 无头 Chrome 把 `--dump-dom` 换成 `--screenshot=<png> --window-size=1440,1000`，即可**复用既有冒烟的假桥与数据夹具**拿到真截图（不必另写一套 fixture）。
- 要冻结在某个中间状态：在该脚本的 `step('x');` 之后插一句 `return;`。断言结果写不出来无所谓，要的是那一帧画面。
- ⚠️ 参数替换要按 **`'--dump-dom',` 这一个 token** 匹配，不要按整串匹配 —— 各脚本里它有时单行、有时在多行数组里，整串匹配会静默漏掉（本轮踩到）。
- 深色主题：注入 `setTimeout(() => document.documentElement.setAttribute('data-theme','dark'), 1200)` 即可（主题是 `data-theme` 属性驱动，见 `src/core/services/theme.ts`）。本轮用它核了浅色/深色两套主题与四个页面。

**源**：`2026-10-01-ui-style-system-audit`（2026-10-01）、`2026-10-01-ui-visual-hierarchy`（2026-10-01）

## 8. 顺手修的 5 处可访问性缺陷（都在宿主侧）

**结论**：5 处缺陷全部落在宿主侧组件：分类导航是 `div` 点不了、删除按钮藏起来却能点到、toast 读屏读不到、命令面板无对话框语义、产品表行不可聚焦。

**取证**：

| 位置 | 原状 | 现状 |
| --- | --- | --- |
| `src/core/components/SettingsModal.vue` 分类导航 | `<div @click>` —— Tab 到不了、读屏读不出可选项 | `<button>` + `aria-current` |
| `src/modules/quick-note/QuickNoteView.vue` 删除按钮 | `opacity-0 group-hover:opacity-100` —— 键盘/触屏上**看不见却能点到**（等于藏了个能毁数据的控件） | 补 `focus-visible:opacity-100` + 命中区 + `aria-label` |
| `src/core/components/ToastHost.vue` | 无 `role`/`aria-live`，读屏读不到任何提示 | `role="status" aria-live="polite"`，容器常驻（随提示挂载会漏掉第一条） |
| `src/core/components/CommandPalette.vue` | 无对话框语义；输入框 `outline-none` 且无替代 | `role="dialog"` + combobox/listbox/`aria-activedescendant`；行上加 `focus-within` 边框 |
| `src/modules/goods/GoodsView.vue` 产品表行 | `<tr @click>` 有 `cursor:pointer` 但**无 hover 底色**、不可聚焦 | 补 hover + `tabindex="0"` + Enter/Space + `aria-current`（用 `aria-current` 而非 `aria-selected`：后者在非 grid 的 `<tr>` 上不合法） |

**源**：`2026-10-01-ui-style-system-audit`（2026-10-01）

## 9. 模板里的字面 Markdown 会原样显示星号

**结论**：`src/core/settings/RecognitionSettings.vue` 模板里还有一处**字面 Markdown**（`**留在…**`）会原样显示星号，已去掉。

**取证**：`src/core/settings/RecognitionSettings.vue` 模板中的 `**留在…**` 字面量。

**源**：`2026-10-01-ui-style-system-audit`（2026-10-01）

## 10. 顺带修的假失败：被同机用例挤过默认 5s

**结论**：`tests/uxEntryNames.spec.ts` 的用例要读 `src/` 整棵树，全量并发时被同机其他用例挤过默认 5s——报的是**超时不是断言失败**，看起来却像"文案悬空"守卫被破坏。按先例加 `{ timeout: 20000 }`。

**取证**：单跑 0.68s；全量报 `Test timed out in 5000ms`（**不是断言失败**）。先例见 `tests/uiIslandThemeTokens.spec.ts`。（同款坑在本项目已出现多次，见 `docs/notes/2026-10-30-smoke-and-guard-discipline.md` 的姊妹现象。）

**源**：`2026-10-01-ui-style-system-audit`（2026-10-01）

## 11. 验证口径（本轮实跑）

**结论**：本轮收口的门禁是九条命令全绿，外加三张无头截图人工复核。

**取证**：

```
npx vue-tsc --noEmit                       ✅ 无输出
npx vitest run                             ✅ 33 files / 597 tests
npm run build                              ✅
npm run goods:ui / today:ui / picking:ui / order-profit:ui   ✅ ALL PASS
npm run order-insight:settings:ui          ✅ ALL PASS
npm run verify                             ✅ IPC 契约一致（188/188）
npm run verify:docs                        ✅ 无悬空引用
npx eslint <改动文件>                       ✅ 0 error
```

外加三张无头截图人工复核：`货与成本`（表格行高修复前后对比）、`拣货`/toast 栈、
`宿主设置弹窗`（分类导航 div→button 后布局未变）。

**源**：`2026-10-01-ui-style-system-audit`（2026-10-01）

## 12. "难看"的根因是层次缺失，不是配色或控件不统一

**结论**（2026-10-01，样式治理第二轮）：第一轮已经把按钮/输入/标签收敛成同一套（控件层），但用户仍然说"还是很难看" —— 因为画布 `#f6f7f9` 与面板 `#ffffff` 只差约 **2%**（看不出卡片边界）、全仓**零阴影尺度**、字号集中在 12–13px（标题只比正文大 5px）、统计数字写成一句流水（`产品 2 SKU 3 缺克重 0`）、空态是一行居中灰字飘在大片空白里。用户看到的是"一整块浅灰 + 一堆同重量文字"。

**取证**：画布 `#f6f7f9` vs 面板 `#ffffff` ≈ 2%；零阴影尺度；字号 12–13px（标题只比正文大 5px）；统计数字为一句流水 `产品 2 SKU 3 缺克重 0`；空态为一行居中灰字。

**源**：`2026-10-01-ui-visual-hierarchy`（2026-10-01）

## 13. 补的是五种结构骨架，不是配色

**结论**：这轮补的是**五种结构骨架**（`src/styles/index.css` 的 `@layer components`）：`.wb-page` / `.wb-head`（页头：标题 + 描述 + 动作）/ `.wb-metabar`（指标条：标签 + 数字）/ `.wb-panel`（画布上的白卡，带投影）/ `.wb-empty`（空态四段：图标 / 标题 / 说明 / 动作）/ `.wb-table`。同时把画布压到约 5% 反差、新增 `--wb-elev-1/2/3` 三档投影与 `--wb-border-strong`。

**取证**：骨架落在 `src/styles/index.css` 的 `@layer components`；新增令牌 `--wb-elev-1/2/3` 与 `--wb-border-strong`（同步 `WB_THEME_TOKENS` 见 §3）；画布反差压到约 5%。

**源**：`2026-10-01-ui-visual-hierarchy`（2026-10-01）

## 14. 硬约束：改模板结构会让断言变红，而红的不是样式

**结论**：`scripts/today-ui-smoke.mjs` / `goods-ui-smoke.mjs` / `picking-ui-smoke.mjs` / `order-profit-ui-smoke.mjs` 在无头 Chrome 里跑**真实构建产物**，断言形如 `/产品 2/`、`件数 7`、`缺克重 0 行`、`1 个 SKU · 3 件`，判据是整段拼串。**推论（比本条规则更重要）**：模板里的可见文本是**既有验收契约的一部分**。要改文案或改结构，正解是 ① 有意识地一并改断言，② 并把判据从"整段拼串"升级为"按元素断言"（给文本元素加稳定的 `data-act`，断言钉在元素上）。若只是顺手把断言改成新拼串，等于**用测试迁就实现**，把"用户还能不能看见那句话"的守卫悄悄删掉。本轮只做视觉，故**一字未改**。

**取证**：判据为

```
el.textContent.replace(/\s+/g, ' ').trim()
```

它 **不会在元素之间插空格**。`npm run goods:ui` 的真实输出：

```
PASS 统计条：产品 2 / SKU 3 / 缺克重 1 / ... | 产品 2SKU 3缺克重 1未关联厂家 1已映射商品ID 4
```

`产品 ` 的尾空格位于文本节点内被保留；而 `2`（在 `<b>` 里）与下一个 `SKU`（下一个元素）之间**一个字符都没有**。于是：

- ❌ **把"标签 + 数字"拆成两个兄弟元素**（`<span>产品</span><span>2</span>`）→ 拼成 `产品2` → 断言红。
- ❌ **依赖模板里的裸空格**：Vue 编译器默认 `whitespace: 'condense'`，**含换行的纯空白文本节点会被整段删除**（不含换行的只压成单个空格）。`{{ n }} <span>个 SKU</span>` 只要被 prettier 重排成两行，那个空格就没了。而 prettier 的 `htmlWhitespaceSensitivity: css` 又会把 `<span>产品 <b>X</b></span>` 排版成 `>产品 <b>X</b></span\n>` 这种**刻意保空白**的形状 —— 两种行为混在一起，靠肉眼读源很难判断。
- ✅ **允许的改法**：换 class、加包裹元素（父级或兄弟）、改样式。**文本节点本身逐字不动。**

**源**：`2026-10-01-ui-visual-hierarchy`（2026-10-01）

## 15. `--wb-shadow` 是**颜色**，不是整套阴影

**结论**：新增的三档投影刻意**不叫** `--wb-shadow-sm` —— 存量 `--wb-shadow` 是**颜色**（岛内抽屉按 `box-shadow: ... var(--wb-shadow)` 自行拼装）。同名同前缀必被传错，故另起 `--wb-elev-1/2/3`。

**取证**：岛内抽屉的用法是 `box-shadow: ... var(--wb-shadow)`；`tests/uiIslandThemeTokens.spec.ts` 双向校验（清单 ⊇ 定义、且清单内无孤儿），漏一处即失败。

**源**：`2026-10-01-ui-visual-hierarchy`（2026-10-01）

## 16. 刻意**不**做的事（两轮合并）

**结论**：正文不提 16px、不动 `ui-plugins/` 下的岛、不引入 CSS 框架/字体、不碰任何文案。

**取证**：

- **没有把正文提到 16px**。本仓是桌面高密度工具，表格里 13px 是既有事实标准；强行统一到 16px 会毁掉信息密度。只把**低于可读下限的 11px**（`.cr__note`、`.cr__alert`、`.ui-island-diag`）提到 12px。文本框正文的 13px 尺度亦未动。
- **没有动 `ui-plugins/` 下的岛**。岛有自己的样式表与 `--wb-*` 注入链路，改宿主不等于改岛；本轮只同步了注入清单（只增令牌、未改语义）。
- 没有引入新的 CSS 框架/字体（`body` 仍是系统字体栈）——引入自定义字体对 Electron 包体与首屏都是负担，不属于"修问题"。
- 任何**文案**未改（见 §14"硬约束"）。

**源**：`2026-10-01-ui-style-system-audit`（2026-10-01）、`2026-10-01-ui-visual-hierarchy`（2026-10-01）

## 17. "简化"要先取证再动手：四类复杂度来源

**结论**："简化"是个方向词，不是方案。动手前先把"复杂"拆成**可复核的现象**，否则改出来的是"另一种复杂"。本轮对「货与成本」盘出**四类**互相独立的来源，各有各的改法：

| 复杂度来源 | 判据（怎么当场认出来） | 改法 |
| --- | --- | --- |
| **假动作** | 控件可点，但点下去什么也不发生 / 只是"回到全部" | 要么给它真目的地，要么**降级成只读事实**（`<span>` 而不是 `<button>`） |
| **重复入口** | 同一件事有两个入口，且两处文案不同（有一处更贴场景） | 删掉**场景更远**的那个；保留在用户真正需要它的那一刻出现的那处 |
| **同一状态两套控件** | 两块 UI 改的是同一个 state；且其中一块会**静默**关掉另一块 | 收敛到**一个入口**，另一处改成**只显示"当前生效了什么"**（可撤除的 chip，空闲时整行不存在） |
| **术语分裂** | 同一概念两套词，同一个文件里都能各出现几次 | 定一个词（本仓取**供应商**），把**用户可见面**全部改掉 —— 含**导出/模板表头**（它是用户拿在手上的产物） |

**取证**（可复现）：

- **假动作**：`src/modules/goods/GoodsView.vue` —— 指标条左段两格原先都绑 `goProducts('all')`（`产品` / `SKU` 两格点下去都只是"回到全部"）。现为 `<span data-act="metric-products">` / `metric-sku`，非 `<button>`；右段三格才是 `<button>`。
- **重复入口**：`下载模板` 曾在工具栏与 `ProductImportDialog.vue` 各有一个（后者文案"没有现成表格？下载导入模板"更贴场景）⇒ 删工具栏那个。产品页签常驻控件 **9 → 6**（`搜索` / `状态` / `供应商` + `导出` / `导入 Excel` / `新增产品`）。
- **同一状态两套控件**：`只看缺克重` / `只看未关联供应商` 与指标条是同一 state，且互斥（服务端筛选互斥），但界面上看不出；点一个会静默关掉另一个。现改为 `ProductListView.vue` 的 `data-act="active-filters"` 行（`v-if="filtered"`，空闲时整行不存在），每个条件一个 `gd-chip`（`data-act="chip-search|chip-status|chip-supplier|chip-missing|chip-no-supplier"`）+ `data-act="clear-filters"`。
- **术语分裂**：改前 `厂家` 23 处 / `供应商` 18 处（`grep -c`）。用户可见面统一为「供应商」；`src/lib/productImport.ts` 的 `PRODUCT_EXPORT_HEADERS` 第 3 列同步改。
  - ⚠️ **改导出表头不会让老文件失效**：`COLUMN_FAMILIES.supplier = ['厂家名称','供应商名称','厂家','供应商','supplier']` 同时收录两者 ⇒ 用户按旧表头导出的文件仍能原样导回（`tests/productImport.spec.ts` 顶部 `HEAD = ['款编码','款式名','厂家',…]` 那批夹具逐条断言 `supplierId` 解析正确）。

**没动的**：布局骨架（`.wb-page/.wb-head/.wb-metabar`）、数据层、能力域、IPC 通道、页签名。页签名的解释职责改用**页头本来就有**的那行说明位承担（`GoodsView.vue` 的 `TAB_DESC`，随页签走）—— 一句话回答"这页是干什么的、什么时候该来这"，不新增控件。

**源**：`2026-10-01-simplify-ui-evidence-first`（2026-10-01）

## 18. 三条硬约束：改文案要升级断言、删能力要留反向守卫、事实与待办要分开

**结论**（本轮都踩过）：

1. **改文案必须同时升级断言**。判据若还在"整段 `textContent` 拼串"，改一个词就让整条断言失配 —— 那不是"改文案"，是把测试改成迁就实现。正确做法：先把判据从**整串比对**升级为**按 `data-act` 逐元素断言**，再改文案（铁律见 §14）。
2. **删掉的能力要留"反向守卫"**。删了常驻开关，就要新增一条"工具栏**不再**有它"的断言，否则它会以"补个快捷开关吧"的名义回来。
3. **"只读事实"和"可点待办"必须真的分开**。指标条上混着两种语义时，用户会默认**每一格都能点**；有一格点不动，就变成"界面坏了"。

**取证**：第 1 条的落地见 §17"假动作"格的 `<span data-act="metric-products">` 与 §14 的整串判据；第 2 条见 §17"重复入口"（工具栏 9 → 6）；第 3 条见同一处指标条左段 `<span>` / 右段 `<button>` 的划分。

**源**：`2026-10-01-simplify-ui-evidence-first`（2026-10-01）

## 19. 变异复核：用例全绿 ≠ 守卫有效

**结论**：三条变异都确认能变红，之后复原。另顺带发现一个**恒真断言**：`tests/productImport.spec.ts` 的「模板只出表头」写的是常量跟自己比，表头字符串被整体改错时它照样绿，故补了一条钉字面量的用例。

**取证**：

| 变异 | 预期变红 | 实际 |
| --- | --- | --- |
| 事实格外包一层 `<button>` | 「产品 / SKU 是只读事实格，不是按钮」 | ✅ FAIL |
| chip 的 × 错分派到另一个条件 | 指标条筛选路径 | ✅ `SMOKE: FAILED at [metric-filter] - timeout` |
| `PRODUCT_EXPORT_HEADERS[2]` 改回 `厂家` | 新增的"钉字面量"单测 | ✅ `expected '厂家' to be '供应商'` |

恒真断言的原文：

`expect(buildProductSheet([], true)).toEqual([[...PRODUCT_EXPORT_HEADERS]])` —— **常量跟自己比**，表头字符串被整体改错时它照样绿。上表第 3 行即新增用例的变异复核。

**源**：`2026-10-01-simplify-ui-evidence-first`（2026-10-01）

## 20. 术语是否统一，只看用户可见面；实现层刻意保留

**结论**：理解层还留着"厂家"这个词是**刻意保留**的（避免无谓 churn；别名族里那个"厂家"更是老文件能导回的唯一保证）。判断"术语是否统一"时请只看**用户可见面**，别按全仓 `grep` 计数下结论。

**取证**：保留处为 `src/core/services/ipc.ts` / `src/types.ts` / `src/styles/index.css` 的**注释**，以及 `productImport.ts` 的**别名族**。

**源**：`2026-10-01-simplify-ui-evidence-first`（2026-10-01）

## 21. 「信息展示不全」= 容器把内容裁掉了，不是数据缺失

**结论**：用户说"页面信息展示不全"时，第一反应几乎都是"少了字段"。本轮「算钱」取证否掉了这个方向：**"展示不全" = 容器把内容裁掉了，不是数据缺失。** 判据只有一行：在**真实长度的数据**下量 `table.scrollWidth` 与可用宽度 `page.clientWidth`。修法由这条判据直接决定：**不是加字段，是让表能滚**。

**取证**：实测 `table.scrollWidth = 1211` > `page.clientWidth = 1064`，而外层 `.wb-panel { overflow: hidden }` **静默吞掉溢出** —— 不出滚动条、不报错、DOM 里字段一个不少。截图 `/tmp/c3-oc-clipped.png` 里右侧 3 列整块消失。若只看"字段在不在"（模板 / 数据 / 类型），**永远查不出来** —— 字段确实在，只是画到屏幕外面去了。修法：新增全局 `.wb-table-wrap`，`overflow: auto` + `max-height` + 首列吸附（`src/styles/index.css`；`OrderCostView.vue` 明细表与统计表套入）。

**源**：`2026-10-03-clipped-not-missing`（2026-10-03）

## 22. 同屏并列的数必须同口径，否则"杂乱"会伪装成"展示不全"

**结论**：本轮顺带查出一个真实口径 bug：同一条指标带上的 5 个合计里，`costTotal` / `shippingTotal` / `platformFeeTotal` **含关闭单**，而 `revenueTotal` / `grossTotal` **不含**。用户拿它们相减算毛利，得到的是错的数 —— **而且看不出来**。统一为「只含非关闭单」并补单测守卫。通用判据：**凡是并排显示、允许用户做加减的两个数，先问"它们的作用域是不是同一个"**。

**取证**：`src/lib/orderCost.ts`；变异复核第 ④ 条 `costTotal` 退回含关闭单 → `expected 52 to be close to 26`。

**源**：`2026-10-03-clipped-not-missing`（2026-10-03）

## 23. 守卫要钉在根因上，钉在"壳"上会恒绿

**结论**：只断言"页面里有 `.wb-table-wrap` 元素"没有任何价值：包上去就绿，溢出依旧被裁。本轮的根因守卫是**三合一**：`wrap 存在 ∧ 该容器 scrollWidth > clientWidth 时真的可滚（overflowX=auto）∧ 最后一列可达`。

**取证**：`scripts/order-profit-ui-smoke.mjs` 的「宽明细表在滚动容器里…末列可达」。实测输出 `wrap=true overflowX=auto 表宽=819 容器宽=498 溢出=true 末列可达=true`。变异验证：去掉滚动包裹层 → `末列可达=false`（红）。四条变异复核：①去包裹层 → 末列不可达；②平台费列恒显 0.00 → 列守卫红；③分段切换打断 → 红；④`costTotal` 退回含关闭单 → `expected 52 to be close to 26`。

**源**：`2026-10-03-clipped-not-missing`（2026-10-03）

## 24. 同一角色的控件在第二个页面上出现时，就该提为全局

**结论**：`.wb-seg` 原为「货与成本」模块私有，本轮提为全局（`src/styles/index.css`）——**同一角色的控件在第二个页面上出现时，就该提为全局**，不要复制第二份。

**取证**：`src/styles/index.css` 中 `.wb-seg` 的归属从模块私有改为全局。

**源**：`2026-10-03-clipped-not-missing`（2026-10-03）

## 25. 提示不是入口：看见了就得能去处理

**结论**：本轮对「算钱」盘点又认领出**两类**独立来源，与前四类（§17）并列。**提示不是入口**：一个字面提示（"未归属 N 单"/"平台费未扣"）告诉用户**有问题**，但**处理它的动作在别处**（藏在"更多"里）⇒ 把它做成**按钮**：点了**自动展开**那片区域**并聚焦到对应控件**。提示的价值 = 把"看见"和"去处理"缝成一步。

**取证**：`src/modules/order-cost/OrderCostView.vue` ——

- 「未归属 N 单」原为 `<span data-act="unassigned-hint">`（点了没反应）→ 改 `<button>` 文案补「· 去归属」，`@click="openMore('shop')"`。
- 「平台费未扣」原为只读 `<span class="wb-tag">` → 改 `<button data-act="fee-missing">` 文案补「· 去配费率」，`@click="openMore('rate')"`。
- `openMore(focus: 'shop' | 'rate')`：`showMore=true` → `nextTick` 里 `ref.focus()` + `scrollIntoView({ block: 'nearest' })`。新增 `.wb-btn--warn`（`src/styles/index.css`，与 `.wb-tag.is-warn` 同角色）供这类"这是待办"的按钮用。
- **两个入口按钮改名**：「更多」→「费率与归属」（"更多"等于没说：用户得先点开才知道值不值得点）。

**源**：`2026-10-03-hint-is-not-an-entry`（2026-10-03）

## 26. "全零"不是正确表达

**结论**：一行 N 个 `缺X 0`：数据齐全时用户得**逐个读完 N 个零**才知道"都齐了" ⇒ 只在**非零**时列；全零时渲染**一句**"没有缺项"。这一行的目的是"哪里缺"，不是"每个都不缺"。

**取证**：`activeGaps = computed(() => gapList.value.filter(g => g.count > 0))`；模板 `v-if="activeGaps.length"` 否则渲染 `<span data-act="gaps-none">没有缺项</span>`（**`v-else-if="!summary.platformFeeMissing"`** —— 见 §27 第 3 条）。逐项带 `data-act="gap-<key>"`。

**源**：`2026-10-03-hint-is-not-an-entry`（2026-10-03）

## 27. 提示变入口的三条硬约束

**结论**（本轮踩过）：

1. **"提示变入口"只改可达性、不改语义**。顺带发现一个作用域陷阱：「归到该店」送出的是**当前列表里全部订单号**（不只未归属的那几单），界面上一个字都没说 —— 用户会以为只处理那几单。**先补一句作用域说明**，但**不改行为**（"是否该只处理未归属单"是产品决策，不该由 UI 简化顺手改掉）。
2. **生造词/行话只出现在用户可见面就要换掉**，别按全仓 `grep` 判：本轮换掉「算齐」→「各环齐全」、「轨」→「毛利依据」；但代码注释里的同款词**刻意保留**（避免无谓 churn）。
3. **"全零"收敛出来的那句话，作用域必须与它所在的那一行一致**（本轮自己踩到并修掉）：把 8 个 `缺X 0` 收敛成「没有缺项」后，同一行里还有一项全局标志 `platformFeeMissing`（未配平台费率，`src/lib/orderCost.ts` 有意做成**全局标志**而非逐行缺口）⇒ 未配费率时会出现「没有缺项」与「平台费未扣」**并存**，读起来是"什么都不缺、但这个缺着"。修法：`v-else-if="!summary.platformFeeMissing"` —— **一句话的断言不能只覆盖它旁边的一部分**。

**取证**：第 1 条见「归到该店」送出全部订单号的行为与新增的作用域说明；第 2 条见列头文案「毛利依据」（变异见 §28 第 3 行）；第 3 条见 `src/lib/orderCost.ts` 的 `platformFeeMissing` 与模板 `v-else-if="!summary.platformFeeMissing"`。

**源**：`2026-10-03-hint-is-not-an-entry`（2026-10-03）

## 28. 冒烟同步与四组变异复核

**结论**：指标条断言从「`.oc-topbar` 整段 `textContent`」升级为**按 `data-act` 逐元素断言**；缺口行判据改成"全齐 → 无任何 `gap-*` chip；未配费率 → 不出现「没有缺项」"；并补了此前零覆盖的路径（点页头「未归属」→ 展开且店铺下拉获得焦点）。四组变异都确认能变红，之后复原。

**取证**：`scripts/order-profit-ui-smoke.mjs`

- 指标条断言锚点：`metric-rows|metric-complete|metric-revenue|metric-gross`。
- 缺口行判据：全齐 → **无任何 `gap-*` chip**；未配费率 → **不出现**「没有缺项」；配好费率 → **才出现**「没有缺项」；有缺 → 逐项按锚点出现。
- 补此前零覆盖的路径：点页头「未归属」→「费率与归属」**展开且店铺下拉获得焦点** → 再走该分支原有断言。

| 变异 | 预期变红 | 实际 |
| --- | --- | --- |
| `activeGaps` 退回"全量"（8 个全渲染） | 三条缺口断言 | ✅ `none=false chips=8`（三条同时红） |
| `openMore` 去掉聚焦 | 「未归属 → 聚焦店铺」路径 | ✅ `SMOKE: FAILED at [shop] - timeout` |
| 明细列头改回「轨」 | 列头断言 | ✅ FAIL |
| 「没有缺项」条件退回 `v-else` | 「未配费率时不谎报整行齐全」 | ✅ `none=true fee-missing=true`（正是矛盾态） |

**没动的**：数据层、能力域、IPC 通道、算账口径（`src/lib/orderCost.ts`）。

**源**：`2026-10-03-hint-is-not-an-entry`（2026-10-03）

## 29. 被打断过的命令不能假设"跑过了"

**结论**：这轮收口时，`vitest`/`verify:docs` 的整条链在一次 shell 会话里被打断，恢复后**不能假设"跑过了"** —— 必须从头再跑一遍并看退出码。门禁的价值在"最近一次实跑"。另：`grep -c "a\|b"` 这类 BSD BRE 交替静默返回 0（本轮又在找术语时中招），一律用 `grep -E` 或 Grep 工具。

**取证**：本轮 `vitest`/`verify:docs` 链被 shell 会话打断后重跑；`grep -c "a\|b"` 在 BSD grep 上静默返回 0。

**源**：`2026-10-03-hint-is-not-an-entry`（2026-10-03）

## 30. 吸底汇总条被压成 2px：真因是弹性塌陷，与页签无关

**结论先行**：用户报「选『全部』『集雨』时没有『复制给厂家』和『生成拿货单』，选『欢喜』『大众』就出现，这出现的逻辑是什么？」——**按钮的显隐与页签毫无关系**。真因是**弹性塌陷**：`.pk-sum`（吸底汇总条）是 `.pk-view` 的弹性子项，而根节点 `.wb-page` 是 `height: 100%` 的**定高弹性列** ⇒ 内容一溢出，默认 `flex-shrink: 1` 就先把汇总条压扁；汇总条自己又带 `overflow: hidden`（为圆角），它本该保底的自动最小尺寸（`min-height: auto`）被这行**归零** ⇒ 一路压到 **2px**，行与按钮被**它自己裁掉**（元素仍在 DOM 里、`getBoundingClientRect` 也还回矩形，但只剩 2px 高，`elementFromPoint` 命中的是下面的卡片）。「页签能决定按钮有无」是假象：**页签只改卡片数量 ⇒ 改内容总高 ⇒ 改塌陷程度**。

**取证**：实测（真机、克隆库）：全部 6 款色 / 集雨 4 → **2px 全塌**；欢喜 / 大众各 1 款色 → 95px / 71px（压得浅、按钮露出来）。

**源**：`2026-10-10-sum-bar-flex-collapse`（2026-10-10）

## 31. 按钮的渲染逻辑是代码事实，与页签无关

**结论**：三个按钮各有明确的渲染条件，且 `.pk-sum` 遍历**全部** `sections`，页签 `supplierFilter` **只过滤卡片网格**，不碰汇总条 ⇒ 三个页签下汇总条内容**一样**，变的只是被压成几像素。

**取证**：

- 「复制给厂家」= `v-if="sec.sg.supplierId && sec.pending.pieces > 0"`（`PickingView.vue:295`）——**逐厂家**：这家厂有 ID 且有待拿件数就有按钮。
- 「生成拿货单」= 同上**再加** `supplierAction`（`PickingView.vue:306`）——只有宿主「今天 › 拿货」嵌入形态传 `true`；独立「拣货」模块页不给（那是宿主页的动作）。
- `.pk-sum` 遍历**全部** `sections` 逐厂家出一行（它是总账）；页签 `supplierFilter` **只过滤卡片网格**，不碰汇总条。

**源**：`2026-10-10-sum-bar-flex-collapse`（2026-10-10）

## 32. 修法 `flex-shrink: 0`，守卫从声明式换成几何 + 可达性

**结论**：「必须完整可见」的条/栏要显式 `flex-shrink: 0`。原断言只断言 `position === 'sticky'` 是**空的**——声明式断言，塌成 2px 照样绿；换成 **几何 + 可达性** 三条。

**取证**：

- **修**：`.pk-sum` 加 `flex-shrink: 0`（`PickingView.vue` 附"不许删"的 why-comment）——修复语义：条子不许缩，内容装不下就溢出 `.pk-view` 去滚（那才是本来的设计），`sticky` 负责把**完整的**条子钉在滚动口底边。
- **守卫升级**（`pkSumGuard`，`picking-ui-smoke.mjs` / `today-ui-smoke.mjs` 各一份）：① `clientHeight + 1 >= scrollHeight`（没被压扁）② 矩形底边在视口内、顶边没越过上沿 ③ 每个必需按钮的**中心 `elementFromPoint` 命中它自己或后代**。
- **红证纪律**：先加守卫跑红（`条 h=2（client 0 / scroll 139）… pk-copy→点到 pk-card__head`）→ 再应用修复 → 绿。断言条数 **1:1 替换**（`today:ui` 172、`picking:ui` 84 不变；`picking:ui` 里"独立页不给生成拿货单"那条共存，两条各自钉一件事）。

**源**：`2026-10-10-sum-bar-flex-collapse`（2026-10-10）

## 33. ToastHost 常驻容器吞点击

**结论**：修完塌陷后 `today:ui` 仍红，命中元素是 **ToastHost 的常驻容器**（`fixed bottom-4 right-4 z-[60] flex flex-col gap-2`）。它为 `aria-live` **常驻**（即便没有 toast 也在）⇒ 自身的盒子（含两条 toast 之间的 `gap-2` 空隙）静止地挡在右下角、吞掉点击。真实场景：点「复制给厂家」→ 成功 toast 弹出，恰好盖在同时位于右下角的「生成拿货单」上 ⇒ 下一次点击被挡约 3 秒（用户感知是"按钮点了没反应"）。**修**：容器加 `pointer-events: none`（继承 ⇒ 整条提示链穿透；toast 是纯信息、没有可点元素，穿透无害）。

**取证**：命中元素为 `fixed bottom-4 right-4 z-[60] flex flex-col gap-2` 的常驻容器；遮挡时长约 3 秒。

**源**：`2026-10-10-sum-bar-flex-collapse`（2026-10-10）

## 34. 真机取证（可复跑）

**结论**：这类"只有真实数据才复现"的塌陷必须用克隆库 + CDP 量几何，四页签修复后高度一律 `h=163`、6 个按钮全部可达。

**取证**：

- `cp -cR` 克隆真实 userData + `env -u ELECTRON_RUN_AS_NODE ./node_modules/.bin/electron . --no-sandbox --disable-gpu --remote-debugging-port=9222 --user-data-dir=<克隆>`，Node 内置 WebSocket 直驱 CDP 量几何。
- 克隆库里 9 条订单全是 2026-08-25（超过默认 30 天窗）⇒ 默认窗口下面板合法为空；经「更多 › 天数窗」扩大后复现用户场景（全部 6 / 集雨 4 / 欢喜 1 / 大众 1）。
- 修复前：全部 / 集雨 `h=2`（按钮 `elementFromPoint` 命中卡片）；欢喜 `h=95`、大众 `h=71`（按钮部分露出）。
- 修复后：四页签一律 `h=163`，6 个按钮全部 `hit=self inView=true`（截图目视确认完整汇总条：行 + 按钮 + 「待拿 6 款色 · 9 件 · 预估 ¥152.00」）。

**源**：`2026-10-10-sum-bar-flex-collapse`（2026-10-10）

## 35. 三条教训：声明式断言 / 常驻覆盖层 / 定高弹性列

**结论**：

1. **声明式断言 ≠ 可达性断言**：`position: sticky`、`v-if` 求值为真、`display: flex` —— 都只说明"写了"，不说明"看得见、点得到"。凡"按钮在不在眼前"的断言，判据必须是**几何 + `elementFromPoint` 命中**。
2. **常驻覆盖层必须 `pointer-events: none`**：为 aria-live 常驻的 toast 容器是标准案例——它自身的盒子（含间隙）与胶囊都会静止地挡在右下角，且只在"恰好点同一个角落"时咬人。
3. **定高弹性列里的子项默认会被压扁**：`height: 100%` 的 flex 列 + 内容溢出 = 压最软的那个；若该子项还带 `overflow: hidden`，它会**先被压到接近 0 再被自己裁掉**，看起来像"这个模块没渲染"。凡是"必须完整可见"的条/栏，都要显式 `flex-shrink: 0`。

**取证**：三条教训分别由 §32 的 `pkSumGuard` 三条判据、§33 的 `pointer-events: none`、§30 的 `h=2` 实测支撑。

**源**：`2026-10-10-sum-bar-flex-collapse`（2026-10-10）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-01-ui-style-system-audit.md` | 2026-10-01 | §1 / §2 / §3 / §4 / §5 / §6 / §7 / §8 / §9 / §10 / §11 / §16 |
| `2026-10-01-ui-visual-hierarchy.md` | 2026-10-01 | §3 / §7 / §12 / §13 / §14 / §15 / §16 |
| `2026-10-01-simplify-ui-evidence-first.md` | 2026-10-01 | §17 / §18 / §19 / §20 |
| `2026-10-03-clipped-not-missing.md` | 2026-10-03 | §21 / §22 / §23 / §24 |
| `2026-10-03-hint-is-not-an-entry.md` | 2026-10-03 | §25 / §26 / §27 / §28 / §29 |
| `2026-10-10-sum-bar-flex-collapse.md` | 2026-10-10 | §30 / §31 / §32 / §33 / §34 / §35 |
