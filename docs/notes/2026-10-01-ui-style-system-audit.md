# 界面样式盘点：缺的是"层"，不是"页"

**结论（先看这条）**：本轮界面问题里，**真正可见的缺陷只有 3 处**，其余全是**同一角色被写了 5–6 遍**——
按钮/输入框/标签在各模块里各有一套高度(24/26/28)、圆角(6/8/12)、字号(12/13)，
所以"看起来不像一个软件"。修法不是逐页调像素，而是**在 `src/styles/index.css` 补一层统一基座**
（`.wb-btn` / `.wb-tag` / `.wb-input--sm`），模块侧只留布局职责。
配套补齐此前**完全缺失**的三件事：全局 `:focus-visible` 焦点环、`prefers-reduced-motion` 兜底、圆角尺度令牌。

---

## 1. 全仓缺失（不是某页的问题）

| 缺什么 | 取证 | 后果 |
| --- | --- | --- |
| 键盘焦点不可见 | `src/` 下 `focus:` / `focus-visible` 命中总计 **4 处**（`.wb-input:focus`、`.rs-input:focus` 等），全部集中在输入框 | Tab 走一遍界面，侧栏项/工具栏按钮/列表行/弹层菜单项**没有任何**可见焦点（WCAG 2.4.7） |
| 无减弱动效兜底 | `prefers-reduced-motion` 在 `src/` 下 **0 命中** | toast 滑入、命令面板淡入、侧栏宽度过渡照播 |
| 圆角无档次 | `--wb-radius: 12px` 同时喂给卡片与 26px 高小按钮、18px 高标签 | 26px 高的按钮配 12px 圆角已接近胶囊；同屏 6/8/12 三种圆角互不呼应 |

新增令牌：`--wb-radius-sm/md/lg`（`--wb-radius` 保留并指向 lg，存量调用点不动）、
`--wb-focus`、`--wb-focus-ring`、`--wb-on-accent`。

> **新增 `--wb-*` 令牌必须同步 `src/core/plugin/uiBridgeHost.ts` 的 `WB_THEME_TOKENS`**，
> 否则 `tests/uiIslandThemeTokens.spec.ts` 直接红（岛内那个令牌永久拿不到，`var()` 解析失败会丢掉整条声明）。

## 2. 对比度：两处不达 AA（已量化）

用 WCAG 相对亮度公式实算（不是目测）：

| 令牌 | 原值 | 用在 | 对比度 | 判 |
| --- | --- | --- | --- | --- |
| `--wb-text-muted` | `#8a909a` | 白底上的 11–13px 说明文字 | **3.2:1** | ✗（AA 要 4.5:1） |
| `--wb-success` | `#16a34a` | toast 底配白字 / 白底上的成功文字 | **3.3:1** | ✗（同 `.pk-ok`、`.gd-hint` 也是文字色） |
| `--wb-danger` | `#dc2626` | 同上 | 4.8:1 | ✓ 不动 |

改为 `--wb-text-muted: #666d79`（白底 5.2:1、画布底 4.8:1）、`--wb-success: #15803d`（5.0:1）。
深色主题一档（`#15171c` 底）原本就有 6–9:1，**不动**。

## 3. 输入框主题化按 `type` 逐个列举 → 漏了两个最常用的

`src/styles/index.css` 原按 `input[type='text'|'search'|'date'|…]` 列举，
**漏了 `number` 与 `password`**——恰好是克重/天数窗/温度/费率与 API Key 用的类型。
它们拿不到 `--wb-surface-2`，只能由 UA 按 `color-scheme` 渲染 ⇒ 深色主题下与相邻的 text 输入框**明显不同底色**。
已改为排除法（排除 checkbox/radio/range/file/color/button/submit/reset/image），新增 type 自动纳入。

## 4. 唯一的真·布局 bug：`flex:1` 的 grid 里放 `<table>`

`src/modules/goods/GoodsView.vue` 的 `.gd-body` 是 `flex: 1` + `display: grid`，且**没写 `align-content`**：

1. 隐式行的默认对齐是 `stretch` ⇒ 这一行被撑到容器整屏高；
2. `align-items` 默认也是 `stretch` ⇒ `<table>` 作为 grid item 一起被拉高；
3. **表格会把多出来的高度摊到各个 `<tr>` 上** ⇒ 两行数据各被拉到 200+px，表看起来像散架。

修法：`align-content: start`。

> **可复用的判据**：`flex: 1` 的 grid 容器里放 `<table>` / 需要按内容高度的子项，
> 必须写 `align-content: start`（或 `align-items: start`）。这条不是"审美"，是可复现的渲染行为。

## 5. 视觉复核怎么做（不用起宿主）

现成的假桥 UI 冒烟脚本本身就是"真产物 + 真假桥 + 无头 Chrome"，把 Chrome 参数换个开关就是截图器：

```bash
cp scripts/goods-ui-smoke.mjs scripts/_shot.mjs        # 必须在仓库内：脚本用 xlsx 等依赖
# 把 '--dump-dom', 换成 '--window-size=1440,980', '--screenshot=/tmp/x.png',
node scripts/_shot.mjs                                  # 脚本末尾会在"没抓到 #smoke-result"处退出，PNG 已经写好
```

- 它跑完会 `process.exit(1)` 并报"没抓到 #smoke-result"——**这是预期的**，截图已经落盘，只看 PNG。
- `sips -c 高 宽 --cropOffset y x in.png --out out.png` 可放大局部（本轮就是靠放大才确认 toast 是**白字红底**，小图会误判成黑字）。
- ⚠️ 脚本放 `/tmp` 会 `ERR_MODULE_NOT_FOUND: xlsx`（ESM 不读 `NODE_PATH`）；**用完删掉**，别留在 `scripts/`。

## 6. 顺手修的 5 处可访问性缺陷（都在宿主侧）

| 位置 | 原状 | 现状 |
| --- | --- | --- |
| `src/core/components/SettingsModal.vue` 分类导航 | `<div @click>` —— Tab 到不了、读屏读不出可选项 | `<button>` + `aria-current` |
| `src/modules/quick-note/QuickNoteView.vue` 删除按钮 | `opacity-0 group-hover:opacity-100` —— 键盘/触屏上**看不见却能点到**（等于藏了个能毁数据的控件） | 补 `focus-visible:opacity-100` + 命中区 + `aria-label` |
| `src/core/components/ToastHost.vue` | 无 `role`/`aria-live`，读屏读不到任何提示 | `role="status" aria-live="polite"`，容器常驻（随提示挂载会漏掉第一条） |
| `src/core/components/CommandPalette.vue` | 无对话框语义；输入框 `outline-none` 且无替代 | `role="dialog"` + combobox/listbox/`aria-activedescendant`；行上加 `focus-within` 边框 |
| `src/modules/goods/GoodsView.vue` 产品表行 | `<tr @click>` 有 `cursor:pointer` 但**无 hover 底色**、不可聚焦 | 补 hover + `tabindex="0"` + Enter/Space + `aria-current`（用 `aria-current` 而非 `aria-selected`：后者在非 grid 的 `<tr>` 上不合法） |

`src/core/settings/RecognitionSettings.vue` 模板里还有一处**字面 Markdown**（`**留在…**`）会原样显示星号，已去掉。

## 7. 刻意**不**做的事

- **没有把正文提到 16px**。本仓是桌面高密度工具，表格里 13px 是既有事实标准；
  强行统一到 16px 会毁掉信息密度。只把**低于可读下限的 11px**（`.cr__note`、`.cr__alert`、`.ui-island-diag`）提到 12px。
- **没有动 `ui-plugins/` 下的岛**。岛有自己的样式表与 `--wb-*` 注入链路，改宿主不等于改岛；本轮只同步了注入清单。
- 没有引入新的 CSS 框架/字体（`body` 仍是系统字体栈）——引入自定义字体对 Electron 包体与首屏都是负担，不属于"修问题"。

## 8. 顺带修的假失败（不是本轮引入）

`tests/uxEntryNames.spec.ts` 的用例要读 `src/` 整棵树：单跑 0.68s，但全量并发被同机其他用例挤过默认 5s，
报的是 `Test timed out in 5000ms`（**不是断言失败**），看起来像"文案悬空"守卫被破坏。
按 `tests/uiIslandThemeTokens.spec.ts` 已有先例加了 `{ timeout: 20000 }`。
（同款坑在本项目已出现多次，见 `docs/notes/2026-09-30-headless-smoke-waitfor-trap.md` 的姊妹现象。）

## 9. 验证口径（本轮实跑）

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
