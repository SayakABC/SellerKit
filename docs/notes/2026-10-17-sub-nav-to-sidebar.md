# 把「基础数据」的七项资料搬到主侧栏做二级菜单

> 用户口径（原话）：**「基础数据中的左边区域可以放到工作台中基础数据的二级菜单中吗？」**
> 两处形态由用户在选项里定：① 展开方式 → **点进去才展开**（切走自动收起）；
> ② 待办徽标（未归一店名数 / 缺进价数）→ **跟到侧栏子项上**。
> 一句话：**那 200px 是从内容区里扣的，侧栏那 208px 是已经付过的** —— 同样的七个面，换个地方放就免费。

**结论（先看这段）**

1. **这不是"新做一套导航"，是"把现成机制用到第二种对象上"**。侧栏从 2026-10-14 起就有
   「一级分组 + 缩进子项」（`src/core/nav.ts` 的 `NAV_GROUPS` + `meta.parent` + `AppShell.vue`
   的 `navRows`），但那次收的是**模块**（"店铺管理"分组下的子模块），用了一天就撤了
   （`NAV_GROUPS` 至今是空数组）。这次收的是**一个模块内部的几个面** —— 机制够用，
   缺的只是"子项不是模块"这一种来源。
2. **动机是一笔宽度账，不是审美**。`MasterDataView` 那条 `.md-nav` 是 `flex: 0 0 200px`，
   加 `.md-body` 的 `gap: 12px` 共 **212px 从内容区里扣**。默认 1200 窗口下：
   `1200 − 侧栏 208 − 页内边距 36 = 956`，再减 212 只剩 **744**，而「货品档案」两栏工作台的
   下限之和是 836 —— **同一天上午并进基础数据时，代价就是被迫把断点抬到 1280、
   默认窗口变成堆叠**（见 `2026-10-17-mail-out-goods-into-master-data.md`）。搬到侧栏后
   可用宽度回到 **956**（左 420 / 右 520），断点**回调到 1180**，"主形态被一个本该免费的
   东西改掉"这件事当天就还上了。
3. **模块运行时上报，不是 meta 里声明内容**。七项里有两项只有模块自己知道实时值：
   徽标数（每次进页面重算、还会随用户刚登记完一家店而变）与当前停在哪一项（`store.mainTab`）。
   所以 `SubNavState` 的 `items` / `activeId` 是 **getter 不是快照** —— 传数组就会退化成
   "进页面那一瞬"的僵值。`ModuleMeta` 只留一个布尔 `subNav`，唯一用途是
   **模块还没打开过时也画得出展开箭头**（否则第一次见它的人不知道里面有东西）。
4. **"点进去才展开"顺手解决了两个隐患**。侧栏只在 `activeId === 模块 id` 且侧栏展开时
   渲染子项：① 八个缩进项不常驻占高度（展开时才约 8×36 = 288px）；
   ② 子项的 `onSelect` 只在模块**确实挂载着**时才存在 —— 不会出现"点得到但没反应"的幽灵项。
5. **锚点名一个没改**。侧栏子项的 `data-act` 仍是 `kind-<id>`（生成处从视图模板搬到
   `AppShell.vue`），三个冒烟脚本与单测都钉在它上面 —— 借搬家顺手改名 = 一堆断言静默失配
   （找不到元素时那些用例是**跳过**而不是红）。激活态则从 `.is-active` 类换成
   `aria-current="page"`：查语义不查配色，换皮时不会红，而"高亮错了项"照样红。

## 连带清单（改一处就得跟着改的地方）

| 位置 | 改了什么 | 漏了会怎样 |
| --- | --- | --- |
| `src/core/services/subNav.ts`（新增） | 上报口：`reportSubNav` / `subNavOf` / `SubNavState`（items & activeId 为 getter）+ `__resetSubNavForTest` | 侧栏永远画不出二级菜单 |
| `src/core/types.ts` | `ModuleMeta.subNav?: boolean` | 首次进模块前侧栏没有展开箭头 |
| `src/core/plugin/types.ts` | `ViewContribSpec.subNav?: boolean`（**过路字段**，见下面坑 2） | 字段在 meta → spec 间消失 |
| `src/core/plugin/managerDiscover.ts` | `subNav: meta.subNav` | 同上 |
| `src/core/plugin/pluginManager.ts` | `metasFromContributions` 里 `subNav: c.spec.subNav` | 同上（**最隐蔽的一处**：它才是最后一道门） |
| `src/core/AppShell.vue` | `NavSubRow` 类型 + `navRows` 里追加子行 + 模板 `v-else-if="row.kind === 'sub'"` + 一级行的展开箭头 | 菜单数据齐了但画不出来 |
| `src/modules/shop-accounts/meta.ts` | 加 `subNav: true` | 同上 |
| `src/modules/shop-accounts/MasterDataView.vue` | 删 `.md-nav` 整块与 `.md-body` 两栏容器、删只为它们存在的样式；`onMounted` 首行上报七项（原还带一个"设置"回调，**同日下午去掉**，见文末补丁） | 页面正常但侧栏空着；或留下一条点不到的死导航 |
| `src/modules/goods/components/GoodsWorkbenchView.vue` | 栅格回 `minmax(420px,40%) minmax(360px,1fr)`，断点 **1280 → 1180** | 默认窗口仍是堆叠（白白多一层滚动） |
| `scripts/master-data-ui-smoke.mjs` | `kindActive()` 助手（查 `aria-current`）+ 文案「左导航」→「侧栏二级菜单」 | 6 处高亮断言恒红 |
| `scripts/goods-ui-smoke.mjs` | 同款 `kindActive()`；reach 那遍的布局断言**翻面**（堆叠 → 并排） | 布局改对了但断言还在守旧的 |
| `scripts/shipping-rate-ui-smoke.mjs` / `order-profit-ui-smoke.mjs` | 同款高亮判据替换 | 同上 |
| `tests/shopAccountsIntake.spec.ts` | `data-act` 生成处改查 `AppShell.vue`；新增两条（上报齐不齐、subNav 过路不丢） | 拆掉上报也没人发现 |

## 四个坑（本轮真踩的）

**① `ModuleMeta` 的可选字段会穿过两层字面量白名单，且 TypeScript 一句话都不报。**
`meta` → manifest 的 `contributes.views[0]`（`managerDiscover.ts`）→ `ViewContribSpec` →
`metasFromContributions()`（`pluginManager.ts`）→ `sortedMetas` → `AppShell`。
中间两处都是**手写字面量**（`{ id, name, icon, order, navHidden }`），新字段不抄就没了。
症状极安静：页面完全正常，只是侧栏那一串菜单永远不出现，控制台零报错。
排查路径是"先怀疑条件判断、再怀疑数据、最后才想到字段被吃了"。
→ 已在 `shopAccountsIntake.spec.ts` 里加了断言钉住这两行字面量。

**② 注入脚本（`scripts/*-ui-smoke.mjs`）的注释里不能有反引号 —— 本轮又踩了三次。**
整个 ASSERT_SCRIPT 在一个模板串里，注释里的 `` ` `` 会提前闭合它。两次 `node --check` 直接报，
**一次残句恰好是合法 JS**（`// 元素仍在 document 里、data-act 仍是 kind-<id>` 那行），
到运行时才炸。判据只能是实跑，`node --check` 不够。

**③ 激活态换实现时，冒烟的判据会一起失效，而且是"红得莫名其妙"那种。**
原来七项是 `.md-nav__item.is-active`（CSS 类），搬到侧栏后视觉由 Tailwind 的
`bg-[var(--wb-primary-soft)]` 承担，**没有 `.is-active` 这个类了**。6 处断言查的都是这个类名。
换成 `aria-current="page"` 之后：换皮不会红，而"高亮落在错的项上"照样红。

**④ 布局断言必须随布局"翻面"，否则它守的是昨天的事实。**
`goods:ui` reach 那遍原有一条 `⓪ 默认窗口下两栏上下堆叠`（上午并进基础数据时加的）。
下午宽度回来了，这条会**红**——而它红了恰恰说明改动生效了。把它翻成"并排"时留了一句注释：
下面那些可达性断言在两种布局下都能过，**只有这一条抓得住"布局变了"**。

## 前向守卫（下次动这里的判据）

| 想改什么 | 会被哪条拦住 |
| --- | --- |
| 给七项加/删/改名 | `tests/shopAccountsIntake.spec.ts` 的七项清单 + `uxEntryNames` 的豁免名单（两处都是断言正文） |
| 把子项 `data-act` 改成别的名字 | 同文件「`kind-<id>` 的生成处」那条 |
| 删掉 `reportSubNav` 调用 | 同文件「七项 + 设置都上报」那条 |
| 给 `ModuleMeta` 再加可选字段 | 同文件「subNav 在 meta → spec → meta 的往返里不会丢」（照着它抄一份即可） |
| 改两栏断点 / 栏宽下限 | `goods:ui` 的 reach 那遍：并排断言 + 「ID 列 ≥120px」「行高 ≤120px」两条几何断言 |
| 改侧栏子项的激活色 | `master-data:ui` / `goods:ui` / `shipping-rate:ui` / `order-profit:ui` 的 `kindActive()`（查 aria-current） |
| 把子项改成"常驻展开" | 没有断言拦 —— 这是**形态选择**（用户 2026-10-17 选的是"点进去才展开"），改之前先问 |

## 验证取证

- `master-data:ui` **75 PASS**（当轮：七项 + 设置都在侧栏；同日下午去掉「设置」行后为 79 PASS —— 宽 75 + 窄 4）
- `goods:ui` **三遍 ALL PASS**；reach 那遍：`默认窗口下两栏并排 | cols=420px 520px`
- `today:ui` 257、`order-profit:ui` 91、`shipping-rate:ui` 43 全绿
- `vitest` 737/737（40 个文件；`shopAccountsIntake` 从 11 例增到 13 例）
- 侧栏实测（1440 宽、进基础数据后）：
  `发货台 | 基础数据 | 店铺账号2 | 货品档案 | 店铺登记2 | 企业1 | 供应商2 | 成本与费率1 | 物流运费 | 设置 | 邮件 | 统计 | 便签 | 账户与设置`
  —— 八项（七项资料 + 设置）带徽标，其余模块行不受影响（「设置」行同日下午去掉）

## 边界（这次刻意没做）

- **⌘K 不能直达这七项**。命令面板仍只列模块。要做就得给 `SubNavItem` 也生成命令贡献，
  而命令是"全局可搜"的语义 —— 七项只在模块内成立，先不动。
- **侧栏收起（48px 纯图标）时不渲染子项**。这与既有分组的规矩**相反**（分组子项在收起态平铺，
  因为它们是别处唯一的入口）；二级项不是入口 —— 一级项本身就在那儿，点进去就是上次停的那一屏。
  十四个图标挤在 48px 里谁也认不出。
- ~~**没有"手动收起"**~~ → **2026-10-17 下午补上了**（用户反馈「现在点击基础数据没法收起二级菜单」）。
  收起状态只记一个模块 id、**不持久化**，切走即清 —— 理由见文末补丁。原话是：
  "展开/收起完全由'是否在这个模块里'决定" —— 那句话正是 bug 的描述：点自己会被 `activateCore` 早退，收不起来。
- **TitleBar 仍显示「基础数据」**，没做成「基础数据 › 货品档案」。侧栏高亮已经表达了这个信息；
  侧栏收起时确实看不出来，但改成"两段式标题"会牵动 `TitleBar` 的既有断言，收益不抵这一批改动。
- **别的模块没接**。`subNav` 是通用机制，但目前只有「基础数据」用它 —— 其它模块没有"一个模块
  七个面"的形态，硬套就是给一个面做个二级菜单（多一层点击、零收益）。

## 下午补丁：点一级项能收起 + 去掉「设置」行（同日第二轮反馈）

> 用户口径：**「现在点击基础数据没法收起二级菜单，二级菜单中的设置去掉」**

### 收起：原形态为什么收不起来

展开态原本只有两个条件：`activeId === 模块id && !collapsed`。唯独**没有"用户想收起"这一路**：

- 点一级项走的是 `activate(row.id)`，而 `activateCore` 第一句之后就是
  `if (id === activeId.value && activeView.value) return;` —— **同模块早退**。
  于是"点自己"这一下什么也不会发生：菜单既收不起来，也没有任何反馈。
- 结果那 8 个缩进行（约 8×36 = 288px）只能靠**切到别的模块**才消失。用户想临时看一眼完整模块列表，
  得先去别处再回来 —— 而回来又自动展开，等于没有收起这个动作。

### 修法：给渲染判据加第三个条件

```ts
const subOpen =
  !!m.subNav && activeId.value === m.id && !collapsed.value && subCollapsedFor.value !== m.id;
```

- `subCollapsedFor` 只记**一个模块 id**，且**不持久化**（与 `collapsedGroups` 的差别就在这）。
  理由：收起是一次**临时视图动作**。记住"基础数据默认收起"，用户下次点进来就是一行空菜单 ——
  与上一轮定下的"点进去才展开"正好相反，而箭头是折着的，他不会想到菜单还在。
- 切模块时在 `activateCore` 顶部清掉（`if (id !== activeId.value) subCollapsedFor.value = ''`）。
  不清的话，"收起 → 去「邮件」→ 点回「基础数据」"会看到空菜单（同一个坑换个入口）。
- 点击语义收敛到 `onModuleRow(row)`：**已在前台 + 有二级菜单 ⇒ 切换折叠**（不重激活，反正会早退）；
  其余情况才是 `activate`。
- 箭头旋转与 `aria-expanded` **只认 `row.subExpanded`**。模板里再推一遍 `activeId === row.id`
  就是两份判据，下一次加条件必忘一处（上一轮 `subNav` 白名单那个坑的同款形状）。
- 一级行补 `data-act="nav-<id>"`：原先模块行没有任何稳定锚点，冒烟点不到它。
  二级项的 `kind-<id>` **一个没动**（三个脚本 + 单测都钉在它上面）。

### 「设置」行去掉

`SubNavState.settings` 是上一轮加的通用口，唯一消费者就是「基础数据」。按用户口径删除：
第 8 行「设置」混在七项资料里，读起来像"第八个页面"，而它其实只是打开宿主设置中心。
安全设置仍在**设置中心**（侧栏底部齿轮 →「基础数据」分类，`shop-accounts:settings` 由
`settings.ts` 贡献）—— 所以这次去掉的是**重复入口**，不是能力。

连带删：`AppShell` 里那个 `if (sub.settings)` 渲染块、`MasterDataView` 的 `openHostSettings`
与 `openSettings` / `toast` 导入（唯一用途就是它）。

### 判据怎么钉

| 想守住的事 | 判据 |
| --- | --- |
| 收起真的让出高度 | `master-data:ui`：点 `nav-shop-accounts` ⇒ `kind-accounts` / `kind-goods` **从 DOM 消失**（不是只看箭头） |
| 收起不是单向死路 | 同一脚本再点一次 ⇒ 七项回来、`aria-expanded=true`。只验一向的话，"关了打不开"照样绿 |
| 收起判据挂在渲染条件上 | `shopAccountsIntake.spec.ts` 新用例：`subCollapsedFor.value !== m.id` 在 `navRows` 里；点一级行走 `onModuleRow`；切模块清空 |
| 「设置」行不回来 | 同一脚本反向断言 `[data-act="kind-settings"]` 不存在 + 单测断言视图里没有 `settings: {`、没有 `openHostSettings` |
| 设置分类 id 仍只有一处来源 | 原用例"视图入口与 settings.ts 两处一致"改为"只有 settings.ts 一个来源 + 视图不再自己打开设置" |

最后一条是本轮唯一**改了语义**的既有断言：视图那个入口没了，"两处一致"没有第二处可比。
不是删它 —— 改成守改名时真正会坏的那件事（第二个来源写死 id ⇒ 点了没反应）。

### 验证取证

- `master-data:ui` **79 PASS**（宽 75 + 窄 4），两遍全绿；新增 4 条（无设置行 / 一级项可点 / 收起 / 展开）
- `vitest` **738/738**（`shopAccountsIntake` 13 → 14 例）
- `vue-tsc --noEmit` 0、`npm run build` 0

