# 「邮件」独立成一级菜单；「货与成本」并进「基础数据」成「货品档案」

> 用户口径（原话）：**「邮件功能独立出来，放在一级菜单。货与成本归拢到基础数据中」**。
> 两处形态由用户在选项里定：① 货与成本 → **左导航加一项「货品档案」**（不另起新页、内部页签原样保留）；
> ② 邮件的设置 → **跟模块走，设置中心新增「邮件」分类**。
> 一句话：**整合的是同一类动作，拆出的是另一类动作** —— 读信有自己的动线，款/货是资料本身。

**结论（先看这段）**

1. **分界线是"动作的种类"，不是"功能的大小"**。基础数据整合的判据一直是「维护一份资料」；
   读信不是资料（它每天要看未读、有"同步 / 检索 / 附件"自己的动线），所以**搬出去**；
   款 / 采集商品 / 映射 / 成本表是资料本身，所以**搬进来**。判据不矛盾 —— 一句话：
   **进基础数据的是"我维护的东西"，留在外面的模块是"我做的动作"**。
2. **模块 id ≠ 存储命名空间**。新模块 id 是 `mail`，但 `mailStore` 的
   `defineStore('shop-accounts-mail')` 与 `useModuleStorage` 的命名空间**刻意一个字母没改**：
   它俩是**已落盘的用户数据键**（邮箱账号、同步游标、附件缓存索引），改 id 就等于让老用户的
   收件箱在中转时"变空"。先例同 `order-insight`（键名沿用已下架岛的 id，见 `AGENTS.md` §6）。
3. **"只说模块 id"会把用户丢在上次停留的那一类上**。`shop-accounts` 有七类资料，
   `switchModule('shop-accounts')` 不带 `action` 时落点是 `store.mainTab`（持久化的上次位置）。
   于是 `ImportNextStep` 与 `openModule()` 都补了 `action`；`data-act` 仍由
   `import-next-${a.tab || a.action || a.moduleId}` 生成 ⇒ 锚点名 `import-next-goods` **没变**，
   尽管 `moduleId` 从 `goods` 变成了 `shop-accounts`（这是刻意的：既有断言按锚点挂，不按 moduleId 挂）。
4. **嵌入是有宽度代价的，几何断言会以"文案/可达性"的形式红出来**。左导航 200 + 页内边距 36 +
   栏间距 12 = **248px** 不再属于这一页：默认 1200 窗口下可用宽度从 1200 掉到 **736**，
   而两栏工作台的下限之和是 420 + 400 + 16 = **836** ⇒ 硬排的结果是右栏只剩 300px，
   队列「商品ID」列被挤到 **42px**（16 位 ID 折成六行、行高 234px），图列被顶出视口。
   修法是**把断点从 1180 抬到 1280**（侧排要窗口 ≥ 1084，取 1280 留余量）——
   也就是**默认窗口现在落在断点下方，堆叠成了主形态**，这条写进了 `GoodsWorkbenchView.vue` 与冒烟断言。
5. **顺手修掉一个既有 bug**：`MailInboxView` 的齿轮原来手写
   `CustomEvent('open-settings', { detail: { category: 'shop-accounts', tab: 'mail' } })`，
   而 `SettingsModal` 是按 **categoryId 全串**匹配的（`shop-accounts:settings`）⇒
   **那个齿轮点了其实什么都没发生**。改用 `openSettings('mail:settings', 'inbox')` 一并修好。

## 连带清单（改一处就得跟着改的地方）

| 位置 | 改了什么 | 漏了会怎样 |
| --- | --- | --- |
| `src/modules/mail/{meta,index,MailView,settings}.ts`、`MailInboxView.vue`、`MailSettingsPanel.vue`、`mailStore.ts` | 新建模块（`id: 'mail'`、`name: '邮件'`、`icon: 'inbox'`、`order: 3`）；设置分类 `mail:settings` | 页面在、入口不在（或反之） |
| `src/modules/shop-accounts/{meta,settings}.ts` | 设置只剩「安全设置」；左导航新增 `goods` 一项 | 设置中心出现同一个"邮件收件箱"两份 |
| `src/modules/goods/` 下的模块外壳（`meta.ts` 与 `index.ts` 两份，均已删） | **删除**（不再是模块，只留视图实现） | 侧栏出现第二个"货"入口 |
| `src/modules/shop-accounts/MasterDataView.vue` | `GoodsView` 以 `embedded` 形态渲染在 `kind === 'goods'`；删 `mail` 分支、`shop-accounts:goto` 监听、`counts.mail`、`.is-accent` | 点了左导航第二项落在空面板 |
| `src/modules/shop-accounts/store.ts` | `ShopAccountsMainTab` 的 `'mail'` → `'goods'`（loadPrefs 白名单同步） | 老用户上次停在"邮件"这一项 ⇒ 落空（无 `v-else` 兜底） |
| `src/modules/goods/GoodsView.vue` | 加 `embedded` prop（只去掉 h1，页头动作与页签一字不动）、`.is-embedded { padding: 0 }` | 两个标题 / 双份内边距 |
| `src/modules/goods/components/GoodsWorkbenchView.vue` | 断点 1180 → 1280（理由见结论 4） | 默认窗口下队列被挤成一条缝 |
| `src/modules/shop-accounts/components/MailAccessDrawer.vue` | `emit('close')` → `mail.closeAccess()`（自己持开合），父组件写 `<MailAccessDrawer />` | 抽屉关不掉（父组件的 `mail` 已删） |
| `src/core/components/{IconGlyph.vue,icons.ts}` | 从 `modules/shop-accounts` 搬到 `core`（`mail` 与 `shop-accounts` 都要用）；新增 `box` 图标 | 两个模块互相 import，环 |
| `modules.config.json` / `src/registry.generated.ts` | profiles 与 `enabledModules` 换成 `today / shop-accounts / mail / order-cost / picking / quick-note` | 构建期裁掉模块或注册不到 |
| `src/core/AppShell.vue` | `iconSvg` 加 `inbox` | 侧栏图标空一格 |
| `src/core/services/importSheet.ts`、`today/tabs/ImportPanel.vue`、`OverviewPanel.vue`、`today/flowCtx.ts` | `ImportNextStep.action` + 回执文案改「货品档案」 | 点了"去维护 SKU 克重"落在店铺登记上 |
| 各处文案（`ClassifyPanel` / `importDetect` / `orderCost` / `OrderCostView` / `ShipRate*`） | 「货与成本」→「货品档案」/「基础数据 › 货品档案」 | 悬空入口名（守卫会红） |

## 四个坑（本轮真踩的）

### 坑 A：`git mv` 不认未跟踪文件 —— 这个仓一半文件不在索引里

`git mv src/modules/shop-accounts/mailStore.ts …` 直接 `fatal: not under version control`
（工作区有 235 个未提交改动，`src/modules/shop-accounts/` 下多数文件从未被 add 过）。
搬家一律用 `mv`（文件系统层），搬完再 `git status` 看新增/删除两边的对应关系 ——
别为了"历史可追"临时 `git add` 一堆无关文件。

### 坑 B：注入脚本的注释不能含反引号（**本轮又踩两次**，第二次还过了 `node --check`）

`scripts/*-ui-smoke.mjs` 的断言整段在一个模板串里。本轮两次把 `` `kind-goods` `` /
`` `reachInfo` `` 写进注释：

- 第一次 `node --check` 直接报 `SyntaxError`（好抓）；
- 第二次残句恰好是**合法 JS**，`node --check` **通过**，运行时报
  `ReferenceError: view is not defined`、行号还指向注释本身（本仓 2026-10-16 记过同款）。

判据只有一条：**改完 `node --check` 通过不算数，得实跑**。注释里要点名就写
`kind-goods` / `reachInfo`（不加反引号），或者用「」。

### 坑 C：`stripComments` 认不出**正则字面量里的引号**，于是注释里的入口名被当成用户文案

`uxEntryNames` 报 `src/modules/mail/MailInboxView.vue: 「邮件收件箱」` 悬空 —— 那句话在注释里。
根因：`MailInboxView.vue` 有一条 `/["']?\s*(?:https?:)?\/\//` 这样的 URL 正则，逐字符扫描器读到
里面的 `"` 就以为进了字符串，**之后整段（含 `//` 注释）都不再被剥**。
修法：`stripComments` 末尾补一道**行级兜底**（丢掉行首是 `//` / `*` / `/*` 的行）。
代价写在函数注释里：行首以 `*` 开头的**代码**会被丢掉 —— 本仓没有这种写法（`*d.balance` 之类）。

### 坑 D：豁免要跟着入口一起搬（**删豁免比加豁免更要紧**）

`ALLOWED_NON_ENTRY` 里原来有「邮件」这一条（它当时是基础数据左导航的项名）。
邮件变成一级模块后，它的名字由 `hostModuleNames()` 兜住了，那条豁免**必须删**：
本守卫的判据是 `known.has(name) || name in ALLOWED`，**两道都放行** ⇒
留着它等于让"文案指着一个已经不存在的左导航项"照样绿。
同批加的是「货品档案」，并为两处都补了**反向锚点**：
`hostModuleNames()` 含「邮件」、**不含**「货与成本」。

## 前向守卫

| 守卫 | 断言 |
| --- | --- |
| `tests/uxEntryNames.spec.ts` | 入口名三来源（`meta.name` / 岛 `displayName` / 白名单逐条理由）；支持 `A › B` 路径式（「基础数据 › 货品档案」）；「邮件」「货品档案」各自的存在/不存在反向锚点 |
| `tests/shopAccountsIntake.spec.ts` | 左导航**七项**且顺序 `accounts / goods / registry / companies / suppliers / cost / shipping`；`goods` 的 `order` 必须小于 `mail`、`order-cost`（顺序改成读 `mail/meta.ts` 与 `order-cost/meta.ts` —— 原先读的是已删的 goods 模块 `meta.ts`） |
| `tests/islandMailFrameCsp.spec.ts` | `sk-mail://` 的宿主页锚点从 `shop-accounts` 改成 `mail` |
| `scripts/master-data-ui-smoke.mjs` | `kind-*` 七项；**没有** `kind-mail`；邮件未读徽标在 `mail-view` 页头（`[data-act="mail-unread"]`）；`gotoMailModule()` / `backToMasterData()` 双向 |
| `scripts/goods-ui-smoke.mjs` | 帮助里的「打开「店铺登记」」→ 同模块落到 `kind-registry`（**不再有 `title-back`**，回程点 `kind-goods`）；reach 那一遍：断点/堆叠、`商品ID` 列 ≥ 120px、行高 ≤ 120px |

## 验证与取证

```
npm run build                 # ⚠️ *:ui 读 dist，改界面必须先 build
npm run goods:ui              # 三遍（1440 / 1200 / 900）SMOKE: ALL PASS
npm run master-data:ui        # SMOKE: ALL PASS（两遍）
npm run today:ui / picking:ui / order-profit:ui / shipping-rate:ui
npx vue-tsc --noEmit / tsc -p tsconfig.electron.json
npm run verify / verify:docs
npx vitest run                # 全量（>120s ⇒ 后台跑）
```

**变异取证（新增的三条断言不是空转）**：把 `@media (max-width: 1279px)` 临时改回 `1024px`
（= 默认窗口硬排两栏）后重跑 reach 那一遍，三条同时红：

```
FAIL 默认窗口下两栏**上下堆叠**…            | cols=420px 300px
FAIL 队列「商品ID」列宽到能读出一整串 …      | idCol=42px
FAIL 队列行高 ≤ 120px …                     | rowH=234px
```

同一次变异里 `队列行缩略图可达（点开看原图）` **是绿的**（`滚动后`）——
这正是"判据放宽一档"的代价：滚动可达后，靠滚动就能救回来的现象不再报错。
所以那两条**几何**断言不是补充说明，而是这一类缺陷唯一还抓得住的地方。

**reach 那一遍的判据变了，理由写进脚本**：`reachInfo` 现在先滚再判，但**只滚 overflow 为
auto/scroll 的祖先**（用户滚得动的那些）。`overflow: hidden` 的容器一律不替它滚 ——
`.wb-panel` 那种"元素在 DOM 里却被静默裁掉"的缺陷仍会红。靠滚动才通过的断言，详情里带「滚动后」。

## 边界（本轮**没有**做的事）

- **`MailAccessDrawer` 留在「基础数据」**：它的触发点是账号行（「接入邮箱」），是**账号的属性**
  而不是收件箱的属性；挂到邮件页会渲染两份蒙层，而且从账号页点开时目标模块根本不在场。
- **邮件的旧存储键不改**（`shop-accounts-mail` / `useModuleStorage('shop-accounts-mail')`）：
  理由见结论 2。哪天要做"改键 + 迁移"，得先写一份把老键读出来再写新键的迁移，而不是改字符串。
- **`goods:ui` 的主语没改名**：脚本文件名、`data-act`、`.gd-*` 类名、"货与成本页冒烟"这句标题
  一律保留（它们锚的是**视图实现**，不是模块名）。用户可见的文案已经全部是「货品档案」。
- 历史笔记里写「基础数据六项」「货与成本是个模块」的**不回填**：它们记录的是当时的形态。
  当前形态以 `docs/baseline/PROJECT_BASELINE.md` 为准。
