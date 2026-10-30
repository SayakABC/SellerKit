# 侧栏导航与页签：38 条结论（蒸馏自 5 篇，2026-10-05 ~ 2026-10-17）

> **蒸馏笔记**：由 5 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/<原文件名>`

## 1. 这不是"新做一套导航"，是"把现成机制用到第二种对象上"

**结论**：侧栏从 2026-10-14 起就有「一级分组 + 缩进子项」（`src/core/nav.ts` 的 `NAV_GROUPS` + `meta.parent` + `AppShell.vue` 的 `navRows`），但那次收的是**模块**（"店铺管理"分组下的子模块），用了一天就撤了（`NAV_GROUPS` 至今是空数组）。这次收的是**一个模块内部的几个面** —— 机制够用，缺的只是"子项不是模块"这一种来源。

**取证**：`src/core/nav.ts` 的 `NAV_GROUPS`（当前为空数组）、`meta.parent`、`AppShell.vue` 的 `navRows`。

**源**：`2026-10-17-sub-nav-to-sidebar`（2026-10-17）

## 2. 动机是一笔宽度账，不是审美

**结论**：`MasterDataView` 那条 `.md-nav` 是 `flex: 0 0 200px`，加 `.md-body` 的 `gap: 12px` 共 **212px 从内容区里扣**。搬到侧栏后可用宽度回到 **956**（左 420 / 右 520），断点**回调到 1180**。一句话：**那 200px 是从内容区里扣的，侧栏那 208px 是已经付过的** —— 同样的七个面，换个地方放就免费。

**取证**：默认 1200 窗口下 `1200 − 侧栏 208 − 页内边距 36 = 956`，再减 212 只剩 **744**，而「货品档案」两栏工作台的下限之和是 836 —— **同一天上午并进基础数据时，代价就是被迫把断点抬到 1280、默认窗口变成堆叠**（见 `2026-10-17-mail-out-goods-into-master-data.md`）。搬到侧栏后断点回调到 1180，"主形态被一个本该免费的东西改掉"这件事当天就还上了。

**源**：`2026-10-17-sub-nav-to-sidebar`（2026-10-17）

## 3. 模块运行时上报，`items` / `activeId` 是 getter 不是快照

**结论**：七项里有两项只有模块自己知道实时值：徽标数（每次进页面重算、还会随用户刚登记完一家店而变）与当前停在哪一项（`store.mainTab`）。所以 `SubNavState` 的 `items` / `activeId` 是 **getter 不是快照** —— 传数组就会退化成"进页面那一瞬"的僵值。`ModuleMeta` 只留一个布尔 `subNav`，唯一用途是**模块还没打开过时也画得出展开箭头**（否则第一次见它的人不知道里面有东西）。

**取证**：`src/core/services/subNav.ts`（新增）的上报口 `reportSubNav` / `subNavOf` / `SubNavState`（items & activeId 为 getter）+ `__resetSubNavForTest`；`src/core/types.ts` 的 `ModuleMeta.subNav?: boolean`。

**源**：`2026-10-17-sub-nav-to-sidebar`（2026-10-17）

## 4. "点进去才展开"顺手解决了两个隐患

**结论**：侧栏只在 `activeId === 模块 id` 且侧栏展开时渲染子项：① 八个缩进项不常驻占高度（展开时才约 8×36 = 288px）；② 子项的 `onSelect` 只在模块**确实挂载着**时才存在 —— 不会出现"点得到但没反应"的幽灵项。

**取证**：展开高度约 8×36 = 288px；子项渲染条件为 `activeId === 模块 id` 且侧栏展开。

**源**：`2026-10-17-sub-nav-to-sidebar`（2026-10-17）

## 5. 锚点名一个没改；激活态换成 `aria-current="page"`

**结论**：侧栏子项的 `data-act` 仍是 `kind-<id>`（生成处从视图模板搬到 `AppShell.vue`），三个冒烟脚本与单测都钉在它上面 —— 借搬家顺手改名 = 一堆断言静默失配（找不到元素时那些用例是**跳过**而不是红）。激活态则从 `.is-active` 类换成 `aria-current="page"`：查语义不查配色，换皮时不会红，而"高亮错了项"照样红。

**取证**：`data-act` 生成处由 `MasterDataView.vue` 迁到 `AppShell.vue`；`master-data:ui` / `goods:ui` / `shipping-rate:ui` / `order-profit:ui` 的 `kindActive()` 改查 `aria-current`。

**源**：`2026-10-17-sub-nav-to-sidebar`（2026-10-17）

## 6. 连带清单：改一处就得跟着改的地方

**结论**：这个机制横跨 13 个位置，漏任何一处都是"页面正常但侧栏空着"级别的静默失败。

**取证**：

| 位置 | 改了什么 | 漏了会怎样 |
| --- | --- | --- |
| `src/core/services/subNav.ts`（新增） | 上报口：`reportSubNav` / `subNavOf` / `SubNavState`（items & activeId 为 getter）+ `__resetSubNavForTest` | 侧栏永远画不出二级菜单 |
| `src/core/types.ts` | `ModuleMeta.subNav?: boolean` | 首次进模块前侧栏没有展开箭头 |
| `src/core/plugin/types.ts` | `ViewContribSpec.subNav?: boolean`（**过路字段**，见下面坑 2） | 字段在 meta → spec 间消失 |
| `src/core/plugin/managerDiscover.ts` | `subNav: meta.subNav` | 同上 |
| `src/core/plugin/pluginManager.ts` | `metasFromContributions` 里 `subNav: c.spec.subNav` | 同上（**最隐蔽的一处**：它才是最后一道门） |
| `src/core/AppShell.vue` | `NavSubRow` 类型 + `navRows` 里追加子行 + 模板 `v-else-if="row.kind === 'sub'"` + 一级行的展开箭头 | 菜单数据齐了但画不出来 |
| `src/modules/shop-accounts/meta.ts` | 加 `subNav: true` | 同上 |
| `src/modules/shop-accounts/MasterDataView.vue` | 删 `.md-nav` 整块与 `.md-body` 两栏容器、删只为它们存在的样式；`onMounted` 首行上报七项（原还带一个"设置"回调，**同日下午去掉**，见 §11） | 页面正常但侧栏空着；或留下一条点不到的死导航 |
| `src/modules/goods/components/GoodsWorkbenchView.vue` | 栅格回 `minmax(420px,40%) minmax(360px,1fr)`，断点 **1280 → 1180** | 默认窗口仍是堆叠（白白多一层滚动） |
| `scripts/master-data-ui-smoke.mjs` | `kindActive()` 助手（查 `aria-current`）+ 文案「左导航」→「侧栏二级菜单」 | 6 处高亮断言恒红 |
| `scripts/goods-ui-smoke.mjs` | 同款 `kindActive()`；reach 那遍的布局断言**翻面**（堆叠 → 并排） | 布局改对了但断言还在守旧的 |
| `scripts/shipping-rate-ui-smoke.mjs` / `order-profit-ui-smoke.mjs` | 同款高亮判据替换 | 同上 |
| `tests/shopAccountsIntake.spec.ts` | `data-act` 生成处改查 `AppShell.vue`；新增两条（上报齐不齐、subNav 过路不丢） | 拆掉上报也没人发现 |

**源**：`2026-10-17-sub-nav-to-sidebar`（2026-10-17）

## 7. 四个坑（本轮真踩的）

**结论**：

**① `ModuleMeta` 的可选字段会穿过两层字面量白名单，且 TypeScript 一句话都不报。**
`meta` → manifest 的 `contributes.views[0]`（`managerDiscover.ts`）→ `ViewContribSpec` → `metasFromContributions()`（`pluginManager.ts`）→ `sortedMetas` → `AppShell`。中间两处都是**手写字面量**（`{ id, name, icon, order, navHidden }`），新字段不抄就没了。症状极安静：页面完全正常，只是侧栏那一串菜单永远不出现，控制台零报错。排查路径是"先怀疑条件判断、再怀疑数据、最后才想到字段被吃了"。→ 已在 `shopAccountsIntake.spec.ts` 里加了断言钉住这两行字面量。

**② 注入脚本（`scripts/*-ui-smoke.mjs`）的注释里不能有反引号 —— 本轮又踩了三次。**
整个 ASSERT_SCRIPT 在一个模板串里，注释里的 `` ` `` 会提前闭合它。两次 `node --check` 直接报，**一次残句恰好是合法 JS**（`// 元素仍在 document 里、data-act 仍是 kind-<id>` 那行），到运行时才炸。判据只能是实跑，`node --check` 不够。（跨篇合并见 §22）

**③ 激活态换实现时，冒烟的判据会一起失效，而且是"红得莫名其妙"那种。**
原来七项是 `.md-nav__item.is-active`（CSS 类），搬到侧栏后视觉由 Tailwind 的 `bg-[var(--wb-primary-soft)]` 承担，**没有 `.is-active` 这个类了**。6 处断言查的都是这个类名。换成 `aria-current="page"` 之后：换皮不会红，而"高亮落在错的项上"照样红。

**④ 布局断言必须随布局"翻面"，否则它守的是昨天的事实。**
`goods:ui` reach 那遍原有一条 `⓪ 默认窗口下两栏上下堆叠`（上午并进基础数据时加的）。下午宽度回来了，这条会**红**——而它红了恰恰说明改动生效了。把它翻成"并排"时留了一句注释：下面那些可达性断言在两种布局下都能过，**只有这一条抓得住"布局变了"**。

**取证**：坑①的两处手写字面量 `{ id, name, icon, order, navHidden }`（`managerDiscover.ts` / `pluginManager.ts`）；坑②的 `node --check` 与运行期两次报错；坑③的 6 处 `.is-active` 断言；坑④的 `⓪ 默认窗口下两栏上下堆叠` 断言。

**源**：`2026-10-17-sub-nav-to-sidebar`（2026-10-17）

## 8. 前向守卫：下次动这里会被哪条拦住

**结论**：七组改动各有对应守卫；唯一没有守卫拦的是"把子项改成常驻展开"——那是**形态选择**，改之前先问。

**取证**：

| 想改什么 | 会被哪条拦住 |
| --- | --- |
| 给七项加/删/改名 | `tests/shopAccountsIntake.spec.ts` 的七项清单 + `uxEntryNames` 的豁免名单（两处都是断言正文） |
| 把子项 `data-act` 改成别的名字 | 同文件「`kind-<id>` 的生成处」那条 |
| 删掉 `reportSubNav` 调用 | 同文件「七项 + 设置都上报」那条 |
| 给 `ModuleMeta` 再加可选字段 | 同文件「subNav 在 meta → spec → meta 的往返里不会丢」（照着它抄一份即可） |
| 改两栏断点 / 栏宽下限 | `goods:ui` 的 reach 那遍：并排断言 + 「ID 列 ≥120px」「行高 ≤120px」两条几何断言 |
| 改侧栏子项的激活色 | `master-data:ui` / `goods:ui` / `shipping-rate:ui` / `order-profit:ui` 的 `kindActive()`（查 aria-current） |
| 把子项改成"常驻展开" | 没有断言拦 —— 这是**形态选择**（用户 2026-10-17 选的是"点进去才展开"），改之前先问 |

**源**：`2026-10-17-sub-nav-to-sidebar`（2026-10-17）

## 9. 边界：这次刻意没做的

**结论**：

- **⌘K 不能直达这七项**。命令面板仍只列模块。要做就得给 `SubNavItem` 也生成命令贡献，而命令是"全局可搜"的语义 —— 七项只在模块内成立，先不动。
- **侧栏收起（48px 纯图标）时不渲染子项**。这与既有分组的规矩**相反**（分组子项在收起态平铺，因为它们是别处唯一的入口）；二级项不是入口 —— 一级项本身就在那儿，点进去就是上次停的那一屏。十四个图标挤在 48px 里谁也认不出。
- ~~**没有"手动收起"**~~ → **2026-10-17 下午补上了**（见 §10）。
- **TitleBar 仍显示「基础数据」**，没做成「基础数据 › 货品档案」。侧栏高亮已经表达了这个信息；侧栏收起时确实看不出来，但改成"两段式标题"会牵动 `TitleBar` 的既有断言，收益不抵这一批改动。
- **别的模块没接**。`subNav` 是通用机制，但目前只有「基础数据」用它 —— 其它模块没有"一个模块七个面"的形态，硬套就是给一个面做个二级菜单（多一层点击、零收益）。

**取证**：命令面板仍只列模块；侧栏收起态（48px 纯图标）不渲染子项；`TitleBar` 仍显示「基础数据」。

**源**：`2026-10-17-sub-nav-to-sidebar`（2026-10-17）

## 10. 下午补丁：点一级项能收起二级菜单

**结论**：用户口径「现在点击基础数据没法收起二级菜单」。展开态原本只有两个条件：`activeId === 模块id && !collapsed`，**没有"用户想收起"这一路** —— 点一级项走 `activate(row.id)`，而 `activateCore` 第一句之后就是 `if (id === activeId.value && activeView.value) return;`（**同模块早退**）⇒ "点自己"什么也不会发生：菜单既收不起来，也没有任何反馈。修法是给渲染判据加第三个条件 `subCollapsedFor`，它只记**一个模块 id** 且**不持久化**，切模块时在 `activateCore` 顶部清掉。

**取证**：

```ts
const subOpen =
  !!m.subNav && activeId.value === m.id && !collapsed.value && subCollapsedFor.value !== m.id;
```

- 结果那 8 个缩进行（约 8×36 = 288px）原先只能靠**切到别的模块**才消失；用户想临时看一眼完整模块列表，得先去别处再回来 —— 而回来又自动展开，等于没有收起这个动作。
- `subCollapsedFor` **不持久化**（与 `collapsedGroups` 的差别就在这）。理由：收起是一次**临时视图动作**。记住"基础数据默认收起"，用户下次点进来就是一行空菜单 —— 与"点进去才展开"正好相反，而箭头是折着的，他不会想到菜单还在。
- 切模块时在 `activateCore` 顶部清掉（`if (id !== activeId.value) subCollapsedFor.value = ''`）。不清的话，"收起 → 去「邮件」→ 点回「基础数据」"会看到空菜单（同一个坑换个入口）。
- 点击语义收敛到 `onModuleRow(row)`：**已在前台 + 有二级菜单 ⇒ 切换折叠**（不重激活，反正会早退）；其余情况才是 `activate`。
- 箭头旋转与 `aria-expanded` **只认 `row.subExpanded`**。模板里再推一遍 `activeId === row.id` 就是两份判据，下一次加条件必忘一处（上一轮 `subNav` 白名单那个坑的同款形状）。
- 一级行补 `data-act="nav-<id>"`：原先模块行没有任何稳定锚点，冒烟点不到它。二级项的 `kind-<id>` **一个没动**（三个脚本 + 单测都钉在它上面）。

**源**：`2026-10-17-sub-nav-to-sidebar`（2026-10-17）

## 11. 下午补丁：去掉「设置」行（重复入口）

**结论**：`SubNavState.settings` 是上一轮加的通用口，唯一消费者就是「基础数据」。按用户口径（「二级菜单中的设置去掉」）删除：第 8 行「设置」混在七项资料里，读起来像"第八个页面"，而它其实只是打开宿主设置中心。安全设置仍在**设置中心**（侧栏底部齿轮 →「基础数据」分类，`shop-accounts:settings` 由 `settings.ts` 贡献）—— 所以这次去掉的是**重复入口**，不是能力。连带删：`AppShell` 里那个 `if (sub.settings)` 渲染块、`MasterDataView` 的 `openHostSettings` 与 `openSettings` / `toast` 导入（唯一用途就是它）。

**取证**：`SubNavState.settings` 无消费者后删除；`settings.ts` 仍贡献 `shop-accounts:settings` 分类。

**源**：`2026-10-17-sub-nav-to-sidebar`（2026-10-17）

## 12. 下午补丁的判据怎么钉

**结论**：收起必须验**双向**（关得掉也打得开），且判据要挂在渲染条件上而不是只看箭头；「设置」行要用反向断言守住。

**取证**：

| 想守住的事 | 判据 |
| --- | --- |
| 收起真的让出高度 | `master-data:ui`：点 `nav-shop-accounts` ⇒ `kind-accounts` / `kind-goods` **从 DOM 消失**（不是只看箭头） |
| 收起不是单向死路 | 同一脚本再点一次 ⇒ 七项回来、`aria-expanded=true`。只验一向的话，"关了打不开"照样绿 |
| 收起判据挂在渲染条件上 | `shopAccountsIntake.spec.ts` 新用例：`subCollapsedFor.value !== m.id` 在 `navRows` 里；点一级行走 `onModuleRow`；切模块清空 |
| 「设置」行不回来 | 同一脚本反向断言 `[data-act="kind-settings"]` 不存在 + 单测断言视图里没有 `settings: {`、没有 `openHostSettings` |
| 设置分类 id 仍只有一处来源 | 原用例"视图入口与 settings.ts 两处一致"改为"只有 settings.ts 一个来源 + 视图不再自己打开设置" |

最后一条是本轮唯一**改了语义**的既有断言：视图那个入口没了，"两处一致"没有第二处可比。不是删它 —— 改成守改名时真正会坏的那件事（第二个来源写死 id ⇒ 点了没反应）。

**源**：`2026-10-17-sub-nav-to-sidebar`（2026-10-17）

## 13. 验证取证（搬到侧栏那两轮）

**结论**：搬到侧栏当轮 `master-data:ui` 75 PASS，同日下午去掉「设置」行后 79 PASS；`goods:ui` 三遍 ALL PASS，断点回调后 reach 那遍量到 `cols=420px 520px`。

**取证**：

- `master-data:ui` **75 PASS**（当轮：七项 + 设置都在侧栏；同日下午去掉「设置」行后为 79 PASS —— 宽 75 + 窄 4）
- `goods:ui` **三遍 ALL PASS**；reach 那遍：`默认窗口下两栏并排 | cols=420px 520px`
- `today:ui` 257、`order-profit:ui` 91、`shipping-rate:ui` 43 全绿
- `vitest` 737/737（40 个文件；`shopAccountsIntake` 从 11 例增到 13 例）
- 侧栏实测（1440 宽、进基础数据后）：
  `发货台 | 基础数据 | 店铺账号2 | 货品档案 | 店铺登记2 | 企业1 | 供应商2 | 成本与费率1 | 物流运费 | 设置 | 邮件 | 统计 | 便签 | 账户与设置`
  —— 八项（七项资料 + 设置）带徽标，其余模块行不受影响（「设置」行同日下午去掉）
- 下午补丁后：`master-data:ui` **79 PASS**（宽 75 + 窄 4），两遍全绿；新增 4 条（无设置行 / 一级项可点 / 收起 / 展开）；`vitest` **738/738**（`shopAccountsIntake` 13 → 14 例）；`vue-tsc --noEmit` 0、`npm run build` 0

**源**：`2026-10-17-sub-nav-to-sidebar`（2026-10-17）

## 14. 侧栏二级菜单从七项并列收到三项 + 组内页签

**结论**（2026-10-17 晚间，用户口径「① 店铺登记、企业收拢到店铺账号中；② 成本与费率、供应商收拢到货品档案中」）：侧栏二级菜单从**七个并列项**收到**三项**；项内的资料页改由内容区顶部一条页签条切换。

**取证**：

| 侧栏（组） | 组内页签（资料页）               | 锚点                                        |
| ---------- | -------------------------------- | ------------------------------------------- |
| 店铺账号   | 账号库 / 店铺登记 / 企业         | 侧栏 `data-act="kind-accounts"`             |
| 货品档案   | 建档与关联 / 成本 / 供应商       | 侧栏 `data-act="kind-goods"`                |
| 物流运费   | （单页，**不画**页签条）         | 侧栏 `data-act="kind-shipping"`             |

组内页签统一 `data-act="kind-tab-<kindId>"`（`accounts` / `registry` / `companies` / `goods` / `cost` / `suppliers` / `shipping`）。

> ⚠️ 同日晚间二次修复：组 id 与 kind id 撞车导致组内第一页页签点不动，已拆 `selectGroup` / `selectKind` 两个入口（见 §17）。

**源**：`2026-10-17-nav-three-groups`（2026-10-17）

## 15. 为什么这么收：两簇加一个单独

**结论**：七项不是"同一层级的七件事"，而是**两簇加一个单独**：凡"这家店 / 这家公司"归店铺，凡"这款货 / 用哪家厂 / 多少钱拿"归货品，物流运费自成一条动线。平铺的代价不是"多两行"，而是每次记一家供应商都要在七个名字里找"该点哪个"——同一件事的归属信息被结构丢掉了。判据与 2026-10-14 整合同向：**同一件事只留一个入口**。收进组内页签 = 在结构上表达归属，且不新增一层导航（侧栏仍是"一级项 + 二级项"两层）。

**取证**：收拢后侧栏仍是两层（一级项 + 二级项），不新增层级；组内切换靠内容区顶部页签条。

**源**：`2026-10-17-nav-three-groups`（2026-10-17）

## 16. 三条实现约束（改结构的人必须知道）

**结论**：

1. **七个 kind id 与 `store.mainTab` 的持久化值一个没改**。它们是两个跨会话协议的键：用户本地偏好（`modules.shop-accounts.mainTab`）与 `switch-module` 的 `action`（`registry` / `cost` / `suppliers` …）。改 id = 老用户醒来落到不存在的项 + 所有跨模块跳转"点了没反应"。收拢只动**呈现层**。
2. **两套锚点，刻意不重名**：侧栏组走 `kind-<groupId>`（AppShell 生成），组内页签走 `kind-tab-<kindId>`（`MasterDataView` 生成）。若两边都叫 `kind-accounts`，`querySelector` 会抓到第一个 —— 冒烟脚本会**静默失配**（找不到元素就跳过，看着是绿的）。
3. **单页组不画页签条**：物流运费只有一页，画一条只有一个格子的页签条既是噪音，也让人以为还有别的页。

**取证**：持久化键 `modules.shop-accounts.mainTab` 与 `switch-module` 的 `action` 未改；锚点 `kind-<groupId>`（AppShell）与 `kind-tab-<kindId>`（`MasterDataView`）并存。

**源**：`2026-10-17-nav-three-groups`（2026-10-17）

## 17. 组 id 与 kind id 撞车：两个入口必须分函数

**结论**：组 id 与 kind id 有**两个字面量撞车**：组 `accounts` ⇄ kind `accounts`、组 `goods` ⇄ kind `goods`。收拢第一版的 `selectKind(id)` 一个函数先查组表再接 kind 表 ⇒ 在组内点**第一页页签**（「账号库」/「建档与关联」）被解释成"点组名"，命中"已在这组"的早退 ⇒ **页面什么都不发生**（无报错、无变化）。用户口径即「店铺账号和货品档案中切换 tab 不正常」。修法：入口按**来源**拆函数，两种 id **不许互相解释**。

**取证**：

| 入口 | id 语义 | 函数 | 行为 |
| ---- | ------- | ---- | ---- |
| 侧栏二级菜单 | 组 id | `selectGroup()` | 已在这组保持当前页；否则落组内第一页 |
| 组内页签 | kind id | `selectKind()` | 直接切（体内不出现 `GROUPS`） |
| `switch-module` action | 两种都可能 | `applySwitchAction()` | 先按 kind 解、落空再按组解（`accounts`/`goods` 两种解释同页，顺序不影响现有跳转） |

**为什么旧冒烟全绿也盖不住**：`gotoKind` 的走法是"先点侧栏组、再点页签"——点组那一步在同组时是 no-op，页签点的又从来不是第一页（默认就在第一页）⇒ 唯一能触发的路径被绕开。回归断言必须**单独走页签**：停在「企业」点「账号库」、停在「成本与费率」点「建档与关联」。

**源**：`2026-10-17-nav-three-groups`（2026-10-17）

## 18. 「货品档案」的页签条交给外层画

**结论**：`GoodsView` 自己那条 `.gd-tabs` 在 embedded 形态下**不再渲染**（新 prop `hideTabs`），否则屏幕上会出现两条并排的页签条（一条属于"页"、一条属于"组"），用户分不清哪条是"我在哪一层"。**只在页签数 ≤ 1 时才允许隐藏**：`GOODS_LAYOUT` 回退成 `'tabs'` 时页签是 2~3 个，藏掉它们等于把产品表与映射队列的入口抹掉，"改一个常量回退"就成了一句假话。隐藏后 `.gd-tabs` 的 `margin-bottom: -16px`（吃掉 `.wb-page` 的 gap）也不再生效，页头与内容区之间仍是 16px —— 不需要补样式。

**取证**：新 prop `hideTabs`；`GOODS_LAYOUT = 'tabs'` 时页签 2~3 个；`margin-bottom: -16px` 失效后间距仍 16px。

**源**：`2026-10-17-nav-three-groups`（2026-10-17）

## 19. 徽标：只在组上挂一个，且**不做相加**

**结论**：组上有待办（未归一店名 / 缺进价）就用待办色报**那个数**；没有待办时才报"这类有多少"（仅店铺账号）；读不到数就不画（不拿 0 冒充"没有"）。**别把组内各项的数加起来**：账号套数 + 待登记店名 + 企业数相加没有任何含义。逐项的数仍在组内页签上（`MasterDataView` 的 `.md-tab__count`），位置从侧栏下移一层而已。

**取证**：`MasterDataView` 的 `.md-tab__count` 承载逐项数；组徽标按待办色报单个待办数。

**源**：`2026-10-17-nav-three-groups`（2026-10-17）

## 20. 守卫对策（这轮真正值钱的部分）

**结论**：结构收拢的守卫要能抓住四类静默失败：漏一项资料页、侧栏报的是资料页而不是组、组里一个页签都没画、两个入口被合并回去。

**取证**：

| 守的是什么 | 在哪 | 判据 |
| ---------- | ---- | ---- |
| 三组把七类资料**一个不漏**地装进去 | `tests/shopAccountsIntake.spec.ts` | 解析 `GROUPS[].kinds` 与七项清单做全等 —— 漏一项时那一页**照样实现、照样能渲染**，只是侧栏没有入口，日志里一个错都没有 |
| 侧栏上报的是组、不是资料页 | 同上 | `items` 由 `GROUPS` 派生 + `activeId: () => currentGroup.value.id` |
| 四个被收拢的项**不再并列**在侧栏 | `scripts/master-data-ui-smoke.mjs` | 反向断言 `kind-registry` / `kind-companies` / `kind-cost` / `kind-suppliers` 都不存在 |
| 组里**真的画了**页签 | 同上 | 只验"三组在"的话，组里一个页签都没画（点进去一片空白）照样绿 |
| 页签条只有当前组那几项 | 同上 | `kind-tab-goods` / `kind-tab-shipping` 在「店铺账号」组里不存在 |
| 「货品档案」只有一条页签条 | `scripts/goods-ui-smoke.mjs` | `!document.querySelector('.gd-tabs')` |
| 供应商没有第二份实现 | 同上 | `kind-tab-suppliers` 在，但 `supplier-table` 不在货品档案页里 |
| 组内点**第一页**页签有反应（当晚 bug 回归） | `scripts/master-data-ui-smoke.mjs` | 单独走页签（不经侧栏组）：停在「企业」点 `kind-tab-accounts`、停在「成本与费率」点 `kind-tab-goods`，判据 = 页签高亮 + 面板可见 |
| 两个入口没合并回去 | `tests/shopAccountsIntake.spec.ts` | 页签 `@click="selectKind(k.id)"` 且 `selectKind` 体内无 `GROUPS`；侧栏 `onSelect: (id) => selectGroup(id)`；`applySwitchAction` 先 kind 后组 |

锚点迁移的落点（三处冒烟）：`kind-<kindId>` → **`kind-tab-<kindId>`**；`clickText('.gd-tabs .gd-tab', …)` → `.md-tabs .md-tab`；`kindActive(id)` 改为优先取 `kind-tab-<id>`（单页组回落侧栏那一行）。

**源**：`2026-10-17-nav-three-groups`（2026-10-17）

## 21. 踩坑：页签文本里带徽标数字，字符串全等会红

**结论**：组页签的文本里带徽标数字 —— `mapFlat('.md-tabs .md-tab')` 拼出来是 `建档与关联/成本与费率1/供应商2`，与「三条页签」做**字符串全等**会直接红（首跑就是这样红的）。判断签"是哪几条"要查 `data-act` 锚点（稳定），判高亮查 `.is-active` 那一格的**开头**。

**取证**：实跑拼串 `建档与关联/成本与费率1/供应商2`；判据改为查 `data-act` 锚点与 `.is-active` 前缀。

**源**：`2026-10-17-nav-three-groups`（2026-10-17）

## 22. 注入脚本（`ASSERT_SCRIPT`）的注释里不能有反引号

**结论**：`FAKE_BRIDGE` / `ASSERT_SCRIPT` 都是 `scripts/*-ui-smoke.mjs` 里的**模板字面量**，注释里写一个 `` ` `` 会**提前终止模板串**，报错却指向注释那一行，形如 `SyntaxError: Unexpected identifier 'xxx'`（caret 指在注释文字中间），极易误判成"别的语法问题"。**纪律**：改完注入脚本必跑 `node --check scripts/<x>.mjs`（该文件头部本就有这条提醒，别跳过）。

**取证**（三篇共六次，均实录）：

- `2026-10-05` 那轮踩两次 —— ① 注释里写 `` `evts('switch-module')[0]` `` 报 `Unexpected identifier 'evts'`；② 注释里写 `` `{success:true, data:null}` `` 报 `Unexpected token '{'`。
- `2026-10-17` 搬到侧栏那轮又踩三次：两次 `node --check` 直接报，**一次残句恰好是合法 JS**（`// 元素仍在 document 里、data-act 仍是 kind-<id>` 那行），到运行时才炸。判据只能是实跑，`node --check` 不够。
- 同日晚间三组那轮又踩两次：一次写成 `` `MasterDataView.vue` `` 让模板串提前闭合（`node --check` 直接报 `Unexpected identifier`），另一次在 `goods-ui-smoke` 里连踩四行。改完必须 `node --check` **并且实跑**（`node --check` 只看外层文件，注入串里的语法错误只在页面里炸）。

**源**：`2026-10-05-daily-flow-card`（2026-10-05）、`2026-10-17-sub-nav-to-sidebar`（2026-10-17）、`2026-10-17-nav-three-groups`（2026-10-17）

## 23. 取证：三组那轮实跑

**结论**：收拢后九条门禁全绿，`master-data:ui` 82 PASS、`goods:ui` 338 PASS、`vitest` 40 文件 / 739 用例。

**取证**：

```bash
npx vue-tsc --noEmit            # 绿
npm run verify                  # 绿（跨域/契约）
npm run build                   # 绿
npm run master-data:ui          # 82 PASS（宽 78 + 窄 4）
npm run goods:ui                # 338 PASS（三遍）
npm run shipping-rate:ui        # ALL PASS
npm run order-profit:ui         # ALL PASS
npm run today:ui                # ALL PASS
npx vitest run                  # 40 files / 739 tests
```

**源**：`2026-10-17-nav-three-groups`（2026-10-17）

## 24. 【历史记录】「今天」页签链版重设计被否决、整轮还原

**结论**：**范围裁定（用户原话，`2026-10-10T16:16:21Z` / 本地 2026-10-11 00:16）**：「你怎么又还原回去了，我说的是今天菜单中的每个页面的样式，不是五步页签的样式，页签的样式不用改，还原回去」⇒ 原始需求「每日发货全流程…每一步的页面样式」指的是**各页签内的页面内容**（导入订单 / 归类核对 / 算钱 / 拿货 / 结算对账 各自长什么样）；**页签栏不在设计范围** —— 维持"安静版"现状（当前步 = 左缘 3px 竖条、数字章、`pending` 概念在位），不要再动。**页签链版重设计（2026-10-10 那轮）已整轮撤销**：链版 = 数字章承载状态（done=实心绿✓ / now=实心主色 / gap=实心警示）+ 步骤间「›」相连 + 页头说明句整段删。撤销后 `today:ui` 回到 **185**（链版曾 187）。

**取证**：终态要点（安静版页签栏）：页头说明句在位（「每日发货全流程：…点页签就地切换」）·当前步 = `.td-tab.is-now::before` 3px 左缘竖条 · `pending` 概念在位 · `today:ui` 185 全绿。还原后规模复测（已写回 `PROJECT_BASELINE.md` §3）：`scripts/` 47 → 46 个文件 · `src/` 40,452 → 40,436 行（TodayView / flowCtx / OverviewPanel 回落）。用户裁定时间戳：`2026-10-10T16:16:21.804Z`（本地 2026-10-11 00:16）。

**源**：`2026-10-11-today-tab-revert`（2026-10-11）

## 25. 【历史记录】撤销 / 保留的边界："还原"≠无条件回滚

**结论**：24 处载荷：**15 处还原**（TodayView ×6 · flowCtx · OverviewPanel ×2 · 冒烟 · CHANGELOG · 根 README · 基线 ×2 · package.json）· **2 处删除**（`today-shot` 截图脚本；链版那份笔记 `2026-10-10-tab-chain-status-design`）· **7 处不动** —— 其中 1 处落在被删脚本内部（随删除归零），其余 6 处是**与轮次无关的事实修正**。判据：**撤轮次只撤轮次产出** —— 顺手修对的事实若一并回滚 = 把已知错误写回去。

**取证**：6 处事实修正为 —— 4 处陈旧步骤号注释：「结算对账」第 6 → 第 5 步（`flowCtx.ts` · `purchase.ts` ×2 · `ReconPanel.vue`；拣货并入拿货后"六步 → 五步"的顺位事实）；基线「2026-10-10 第七次全量重扫」2 处（修正真实过时计数）。还原手法：会话转录里该轮的 24 处载荷逐条 **new→old 逆序**回放（存在耦合编辑，必须先撤后改的那条），全过才落盘 + 写后逐条复验（new 已去、old 已回）；落盘前备份。

**源**：`2026-10-11-today-tab-revert`（2026-10-11）

## 26. 教训：自己的产物被"整批回退"时，先当作"用户 / 另一工具的表态"

**结论**：⭐ **教训：自己的产物被"整批回退"时，先当作"用户 / 另一工具的表态"核对，别当事故去"恢复"。** 本仓多工具交替打开（AGENTS.md §0），用户完全可能在会话外直接改工作区。本轮实况：链版收尾刚过，工作区即被一次会话外操作整体回退 —— **那正是用户的否决**；我误判为事故、把 24 处载荷重放"恢复"，旋即被用户原话纠正，再整轮还原（本次为终态）。

**取证**：会话外整体回退发生在本轮链版收尾刚过；24 处载荷重放后用户原话纠正（`2026-10-10T16:16:21.804Z`）。

**源**：`2026-10-11-today-tab-revert`（2026-10-11）

## 27. 下一步（原始需求，仍未做）

**结论**：「今天」**各页签页面内容**的样式设计：导入订单 / 归类核对 / 算钱 / 拿货 / 结算对账，目标「简洁明朗、操作便捷、上手就会、少文字解释、不过度设计」。动手前先与用户对齐做法；**不要再把页签栏纳入范围**。

**取证**：**2026-10-11 补记**：其中四页（导入订单 / 归类核对 / 算钱 / 结算对账）已按上述口径过一轮，见 `docs/notes/2026-10-30-mail-and-today-pages.md`；拿货页 10-10 刚重做过三轮、本轮未动。

**源**：`2026-10-11-today-tab-revert`（2026-10-11）

## 28. 拿货页：病根是行粒度太细 + 数字和动作离开对象，不是"元素多"

**结论**：用户原话：「拿货 tab 界面一条一条的实在太多了，元素很多，嵌套也很多，你重新设计一下页面，使界面简洁直观，操作便捷，始终要记得初衷」。初衷 = 这条链：**要拿什么（图角标 + 价）→ 按此生成拿货单 → 拿了什么 → 录付了多少钱 → 对账**。**换聚合层，不是删信息**：清单原按 款 × 色 × 码 一行（黑 L 一行、黑 M 又一行）⇒ 同一款色的图、款名、进价逐行重复，10 列的表大半是重复。行粒度折叠到 **款色**（行键 `S1 · 黑`），尺码并排成 chips（`L×2` = 这一码**还要拿** 2 件、`L✓` = 已拿完；tooltip 保留「需求 3 · 已拿 1 · 还差 2」三个数）⇒ 表收成 6 列。**展示粒度与出货粒度可以不同**：发给厂家的 xlsx 仍按码把角标烧进图（与 `badgeOf` 同源，不是一个数两套算法）。

**取证**：口径层 `src/lib/picking.ts` 的 `groupByColor`（行键 + sizes 折叠 + `pendingRollup`）；行键 `S1 · 黑`；表 10 列 → 6 列。

**源**：`2026-10-10-purchase-tab-rework`（2026-10-10）

## 29. 数字就地给，不抽到顶栏

**结论**：**数字就地给，不抽到顶栏**。"指标条 + 分段徽章"是同一批数字的第三份拷贝；撤掉后：清单条给「待拿 N 款色 · N 件 · 预估 ¥」（与段尾按钮同一个 `pendingRollup`）、「拿了什么」面板头给「N 张 · N 张草稿待提交 · 已提交 ¥」。**数字住在它所描述的对象旁边**，不用上下对照。

**取证**：清单条文案「待拿 N 款色 · N 件 · 预估 ¥」与段尾按钮共用 `pendingRollup`；面板头「N 张 · N 张草稿待提交 · 已提交 ¥」。

**源**：`2026-10-10-purchase-tab-rework`（2026-10-10）

## 30. 动作钉在起作用域上

**结论**：**动作钉在起作用域上**。一张拿货单只能挂一个厂家，数据里已按厂家分好段 ⇒ 开单按钮钉**段尾**（`pk-create-order` + `data-supplier`）；页级"先选厂家 + 按此生成拿货单（N）"整个撤掉 —— 那一步对用户是白问的。剩下的厂家下拉只服务「新建空白单」，且没选厂家时两个新建都禁用。

**取证**：`src/modules/picking/PickingView.vue` 的 `pk-create-order`（`supplierAction`）；宿主层 `src/modules/today/tabs/PurchasePanel.vue` 的 `pu-orders-meta` / `pu-ignore-toggle`（展开才出 `pu-ignore-table`）。

**源**：`2026-10-10-purchase-tab-rework`（2026-10-10）

## 31. 把"下一步"自动做掉

**结论**：**把"下一步"自动做掉**。开单只是中点，"填单价"才是目的 ⇒ 生成草稿后自动切「拿了什么」并**直接打开这张单的编辑器**（合计 0.00 等填）；toast 说「已生成拿货单 #N（草稿）—— 填好单价再提交」。

**取证**：`PurchasePanel.vue` 的 `createFromPick` 成功后 `sub='orders'` + `bump()` + `openEditor(r.id)`；toast 文案「已生成拿货单 #N（草稿）—— 填好单价再提交」。

**源**：`2026-10-10-purchase-tab-rework`（2026-10-10）

## 32. 拿货页取证：改在哪 + 守卫规模

**结论**：四条判据分别落在口径层 / 展示层 / 宿主层，守卫随之整段重写。

**取证**：

- 口径层 `src/lib/picking.ts`：`groupByColor`（行键 + sizes 折叠 + `pendingRollup`）；`row.noPricePieces` 按**需求**口径、`pendingNoPricePieces` 按**待拿**口径 —— 两者刻意不同值（夹具 3 vs 2），拿"3 件"作断言时口径混用会立刻露馅。
- 展示层 `src/modules/picking/PickingView.vue`：`size-chip` / `pk-create-order`（`supplierAction`）/ 精简条 `pk-bar`（待拿数 / 缺口 / 口径 / 动作各占一段；导出与「更多」在内嵌时跟着它走）。
- 宿主层 `src/modules/today/tabs/PurchasePanel.vue`：`pu-orders-meta` / `pu-ignore-toggle`（展开才出 `pu-ignore-table`）/ `createFromPick` 成功后 `sub='orders'` + `bump()` + `openEditor(r.id)`。
- 守卫：`scripts/today-ui-smoke.mjs` 拿货段整段重写（`today:ui` 164 → **168**，`SMOKE: ALL PASS`）；`scripts/picking-ui-smoke.mjs` 断言改钉新 DOM（**60** 条）；`vitest` 36 文件 / **678** 用例。

**源**：`2026-10-10-purchase-tab-rework`（2026-10-10）

## 33. 三条实测纪律（文案 / 假桥 / 同一格两判据）

**结论**：

- **改 toast 文案要 grep 按文案取的断言**：文案是断言输入的一部分。
- **假桥必须"记住"新建的单**：`createFromPick` 之后立刻 `purchaseOrderGet(新 id)` 开编辑器 —— 夹具不持久化就当场报「拿货单不存在」。
- **同一格的两个判据钉在同一个元素**：分开取（或整行拼串）时"列串位"不会红。

**取证**：toast 从「…去「拿货单」填单价」改成「…填好单价再提交」后，`toastHas('填单价')` 不再成立 —— `today:ui` 当场红一条。夹具补 `CREATED_ORDERS` + `allOrders()` 才成立。chip 的文本 `L×2` 与 tooltip 都在同一个 `size-chip` 上取。

**源**：`2026-10-10-purchase-tab-rework`（2026-10-10）

## 34. 与并入那一轮的关系：取代

**结论**：`2026-10-10-picking-merged-into-purchase.md` 的文件表与结论 5/6 描述的是并入时那一版（需求/已拿/还差三列 + 图上角标 + 页级"先选厂家"开单）；本笔记取代其**界面形态**部分：结论 1–4（口径单源 / "删页签 ≠ 改名" / 不复制视图 / `remaining` 夹 0）不受影响；"角标写还差"现在只对导出 xlsx 成立（屏上角标撤了，信息落在尺码格）；"一次一厂"不变，但入口从"页级下拉 + 按钮"改为**段尾按钮**。

**取证**：屏上角标已撤，信息落在尺码格；导出 xlsx 仍按码烧角标。

**源**：`2026-10-10-purchase-tab-rework`（2026-10-10）

## 35. 流程卡的「当前步」必须**串联**推导

**结论**：场景是「今天」页新增「每日发货流程」卡（导入 → 归类核对 → 拣货 → 算钱，后三步标注在插件里）。前一步没完成时，后面的步骤一律 `todo` + 写明「等第 N 步」。各步独立判断会让**多个步骤同时高亮**，"当前该做哪一步"这个卡片的唯一职能反而答不出来。

**取证**：初版第 2/3/4 步各看自己的数（未识别款 / 有 SKU 要拣 / 缺数据），假桥夹具下第 2/3/4 步**同时**是 `now` —— 截图上是三块橙边（`/tmp/flow-light.png` 首版）。修法：

```
wait2 = !hasOrders ? '等第 1 步' : needClassify ? '等第 2 步' : ''
wait3 = wait2 || (needPicking ? '等第 3 步' : '')
state = wait2 ? 'todo' : …
```

守卫：`scripts/today-ui-smoke.mjs` 的「当前步唯一：高亮（now/gap）的步骤数 = 1，且第 2 步未完成时第 3/4 步是 todo 并写明「等第 2 步」」。**变异复核**：把第 3 步的 `state` 改回 `!hasOrders ? 'todo' : needPicking ? 'now' : 'done'` → 输出 `高亮数=2` → 该断言变红（47 PASS + 1 FAIL）；复原后 48 PASS。

> 这条是**拍图拍出来的**，冒烟全绿时没暴露 —— 因为原断言只要求"第 2 步是 `is-now`"，没说"别的步骤不能也是"。凡"当前/唯一/默认"这类语义，断言要**同时钉住正例与排他**。

**源**：`2026-10-05-daily-flow-card`（2026-10-05）

## 36. 宿主**跳不进岛的某个页**：`switchModule` 的 `action`/`payload` 目前无消费方

**结论**：`switchModule(moduleId, action?, payload?)` 的参数是**半接线**的 —— `AppShell.vue:490` 把 `detail.action` 存进 `window.__switchModuleAction`，但**全仓没有任何读取方**。所以文案可以点名"在「订单归类」插件的「拿货对账」页"，按钮只能承诺**打开那个岛**（不能承诺落在那一页）。

**取证**：

```bash
grep -rn "__switchModuleAction" src/      # 只有 AppShell.vue:491 的写入，无读取
grep -rn "拿货对账" ui-plugins/order-insight/dist/views/stockin.js
#   → export default { id: 'stockin', title: '拿货对账', order: 60 }
```

**待办**（未做，属 S3+ 范围）：若真要深链到岛内页，得给 `UiIslandView`/岛加"打开时消费一次性动作"的协议，并按 `docs/notes/2026-10-30-island-host-boundary.md` 的分界判据确认它算主干契约还是岛内约定。

**源**：`2026-10-05-daily-flow-card`（2026-10-05）

## 37. 岛内页签名不在宿主可枚举范围 ⇒ 只能进 `ALLOWED_NON_ENTRY`

**结论**：`tests/uxEntryNames.spec.ts` 的合法名集合 = 宿主模块名 ∪ 岛 `displayName` ∪ `ALLOWED_NON_ENTRY`。「拿货对账」是**岛内页签**（既不是模块名也不是岛名），文案里引用它就会被判悬空。处理方式与先例「识别设置」一致：加进 `ALLOWED_NON_ENTRY` 并**逐条写明理由**。⚠️ 豁免是**按名字**生效的 ⇒ 岛改页签名时要同步这里，否则守卫会对一个已不存在的名字继续放行。

**取证**：加豁免前 `npx vitest run tests/uxEntryNames.spec.ts` 报 `文案让用户去一个不存在的入口: expected 'src/modules/today/TodayView.vue: 「拿货对…'`；加后 2 passed。

**源**：`2026-10-05-daily-flow-card`（2026-10-05）

## 38. 「复用冒烟脚本当截图器」的三个坑

**结论**：沿用 §7/§22 同款做法（`'--dump-dom',` → `'--window-size=…','--screenshot=…'`）时有三处会得到"看着正常的假绿截图"：主题注入写在页面脚本里、没在跳转类断言前 `return`、夹具兜底值不忠实。

**取证**：

1. **主题注入不能写在页面脚本里**：`process.env` 在浏览器里不存在 ⇒ 整段断言脚本首行就抛，但**图照样出**（页面由 app 自己渲染）⇒ 得到一张"看起来正常"的假绿截图。正确做法：主题在 **Node 侧**注入 —— `html.replace('</head>', () => '<script>…</script></head>')`。
2. **必须 `return` 在跳转类断言之前**：断言脚本里有"点下一步真的跳"，跑完页面已在目标模块，截到的是被跳过去的岛，不是要审的页。
3. **截图前先让夹具忠实**：假桥兜底 `{success:true, data:null}`，而 `externalLoader.ts:44` 判的是 `!r.data` ⇒ 每张截图右下角常驻红 toast「扫描插件目录失败（IPC 不可用）」。补 `pluginsScan` 桩（返回 `{root, plugins: []}`，与 `plugins-handlers.ts` 真形状一致）—— 目的是**忠于真形状**，不是为了消颜色：常驻红 toast 会训练人忽略红 toast。

（文件放仓库内、用完即删：`scripts/` 之外跑会 `ERR_MODULE_NOT_FOUND: xlsx`。）

**源**：`2026-10-05-daily-flow-card`（2026-10-05）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-17-sub-nav-to-sidebar.md` | 2026-10-17 | §1–§13 / §22 |
| `2026-10-17-nav-three-groups.md` | 2026-10-17 | §14–§23 / §22 |
| `2026-10-11-today-tab-revert.md` | 2026-10-11 | §24 / §25 / §26 / §27 |
| `2026-10-10-purchase-tab-rework.md` | 2026-10-10 | §28 / §29 / §30 / §31 / §32 / §33 / §34 |
| `2026-10-05-daily-flow-card.md` | 2026-10-05 | §35 / §36 / §37 / §38 / §22 |
