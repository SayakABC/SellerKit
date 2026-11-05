# 发货台与物流运费：43 条结论（蒸馏自 5 篇，2026-10-05 ~ 2026-10-21）

> **蒸馏笔记**：由 5 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/<原文件名>`

## 1. 把六步收进同一页的七个页签，点步骤走 `go(tabId)`，不走 `switchModule`

**结论**：把「导入 → 归类 → 拣货 → 算钱 → 拿货 → 对账」六步从"点一步跳一个模块"改成**同一页的七个页签**，点击就地切换（懒加载 + 保活），人不再被弹出当前页。落点 `src/modules/today/**`，**零迁移 / 零新 IPC / 零能力域 / 岛不发版**。用户原话：「将每日发货流程中的每一步都挪到宿主中，可以在一个页面中的多个tab中，避免点击后跳转到其他页面，丝滑操作」。拍板两项：**扩「今天」**（导航不增项）、**六步全内建**。

旧形态（S2 落地的四步流程卡）点一步 = `switchModule(id)`：模块被卸载、下一个挂载，中间状态（表单、已生成的清单、滚动位置）**全丢**，回来还得再点一次导航。`AppShell.vue` 的工作区是单个 `<component :is="activeView" v-if="activeView" />`，**没有 `KeepAlive`** —— 这是"切模块就重建"的根因。本次**没有动外壳**（那是全局行为，影响所有模块），而是在「今天」页**内部**建页签系统：`defineAsyncComponent` + `<KeepAlive>`。好处是影响面可控、可单独回退；代价是"只有今天页有这待遇"。

关键判据：**点步骤走 `go(tabId)`，不走 `switchModule`** —— 否则只是"看起来没跳"：`switchModule` 一旦派发，外壳照样把本页卸掉重挂。

**取证**：`AppShell.vue` 的工作区是单个 `<component :is="activeView" v-if="activeView" />`，**没有 `KeepAlive`**；「今天」页内部用 `defineAsyncComponent` + `<KeepAlive>` 自建页签。

**源**：`2026-10-05-shipping-console-tabs`（2026-10-05）

---

## 2. 保活必须配 `token`：保活 = 数据变旧，得有人把"数据变了"打到各面板

**结论**：四条设计决定各有"不然会怎样"：①点步骤走 `go(tabId)` 不走 `switchModule`（派发即重挂）；②懒挂载 `defineAsyncComponent`，第一次点才 import（七个页签里两个是上千行的整页视图、各自进页就取数，全量挂载 ⇒ 打开就慢、还白跑一堆 IPC）；③`<KeepAlive>` 包动态组件（切走就销毁 ⇒ 回到拣货页签，刚生成的清单没了、要重生成）；④`token` 把保活的代价还回去。

`token` 是最容易被漏掉的一条：**保活 = 数据变旧**，必须有一个"数据变了"的信号打到各面板。否则"导入之后"切回拣货页签看到的还是**导入之前**那份清单，用户以为没生效（比不保活更糟）。

**取证**：实现方式 —— 容器 `bump()` → `token.value += 1`；面板 `watch(() => props.refreshToken, ...)` 重取。拣货面板的重取**有条件**（`if (generated.value)`）—— 本页的"一键语义"是"进页不自动取数"，冒烟有断言钉着，不能因为外面推了个信号就破例。

**源**：`2026-10-05-shipping-console-tabs`（2026-10-05）

---

## 3. 各步**复用整页视图**，`embedded` 只藏 `wb-head__main` —— 藏信息可以，藏能力就是功能缺失

**结论**：`PickingView` / `OrderCostView` 加一个 `embedded` prop，页签里直接嵌它们，只做两件事：①藏掉**标题两行**（`wb-head__main`）—— 外层页签已经交代了"这是哪一步"；②接到 `token` 时重算。**不复制一份"页签版"**：那种作法必然分叉（同一件事两处摆，岛内「拣货」页签 2026-10-05 发布前撤回就是这个理由）。复用同一份组件 ⇒ 屏幕上与页签里**结构上不可能不一致**。

⚠️ **踩到的真 bug（变异测试抓到的）**：第一版把 `embedded` 写成"整个 `<header>` `v-if="!embedded"`"，于是**动作按钮一起被藏了** —— 拣货页的「生成待拣清单 / 导出带图 xlsx / 更多」、算钱页的「刷新 / 更多 / 未归属」都在那个 header 里。症状是"点开拣货页签只有空态、没法操作"。**修法：只藏 `wb-head__main`，`wb-head__actions` 保留**（并加 `.is-embedded .wb-head__actions{margin-left:0}` 当工具栏用，否则按钮会被 `margin-left:auto` 顶到右边像飞了）。

一般化：**给整页视图加"内嵌模式"时，要按"信息层级"藏，不能按"容器"藏。** 页头里"标题/说明"是信息，"动作"是能力 —— 藏信息可以，藏能力就是功能缺失。

**取证**：拣货页的「生成待拣清单 / 导出带图 xlsx / 更多」、算钱页的「刷新 / 更多 / 未归属」都在那个 header 里；修法为保留 `wb-head__actions` 并加 `.is-embedded .wb-head__actions{margin-left:0}`。

**源**：`2026-10-05-shipping-console-tabs`（2026-10-05）

---

## 4. 页签名成了**新的一类入口名**，守卫要跟着扩（收进 `known`，不是豁免）

**结论**：六步收进一页之后，文案里出现「去「归类核对」页签」「在「生成拣货单」页签」这类说法。`tests/uxEntryNames.spec.ts`（悬空入口名守卫，判据是"文案让用户去的地方必须真存在"）一眼把它判红 —— 它只认**模块名**与**岛 displayName**。正确的处理不是豁免（`ALLOWED_NON_ENTRY` 是给"页面上看得见的控件文字"用的），而是**把页签名当入口名收进 `known`**：用户真的点得到它们，凭什么不算入口？

**取证**：页签名在 `src/modules/today/flowCtx.ts` 的 `SHIPPING_TAB_NAMES` 里**只写一处**（`TodayView.vue` 的页签定义按 id 取用），守卫按同一条路径读它，并加了"来源非空"的自证（正则写歪会静默返回 `[]` ⇒ "页签名全部悬空"这条判据形同虚设）。

**源**：`2026-10-05-shipping-console-tabs`（2026-10-05）

---

## 5. 一条**假守卫**：按"调用总数"断言，被另一个调用方喂饱

**结论**：`today:ui` 里"导入订单后已生成的拣货单自动重算"这条，第一版数的是 `pickingRows` 的**调用总数**，变异（拿掉 PickingPanel 的 `:refresh-token`）⇒ 冒烟照样 ALL PASS。原因：`pickingRows` 有**两个调用方** —— ①容器每次 `reload()` 都调 `{limit:2000}`（只为页签徽标/总览卡要个汇总数）；②拣货面板点「生成」时调 `{shop, includeShipped}`（**没有 limit**）。`bump()` 会触发容器的 `reload()` ⇒ 总数照样涨 ⇒ 断言恒绿。

**判据：跨模块共用的 IPC，断言必须按入参区分调用方**（本项目里两边的形状本来就不同，`limit` 的有无就是分界）。

一般化：**"调用次数增加了"不是"我关心的那件事发生了"。** 只要那个 IPC/函数有第二个调用方，计数型断言就只是在测"系统还活着"。

**取证**：变异记录 `变异（拿掉 PickingPanel 的 :refresh-token）⇒ 冒烟照样 ALL PASS`。改完变异立刻变红，并且**暴露出 §3 那个"生成按钮不见了"的真 bug** —— 修好后这条断言的输出是 `生成后=1 导入后=1`（生成真的发生了、没重算），一眼能读懂。

**源**：`2026-10-05-shipping-console-tabs`（2026-10-05）

---

## 6. 页签现状与"收编到什么程度才够下架"= 岛上的**每日动作**清零，而非功能全等

**结论**：总览 / 导入订单 / 归类核对 / 生成拣货单 / 算钱 / 拿货 / 结算对账 —— **全部内建可用**（数据层全用宿主现成 IPC，零新 IPC / 零迁移 / 岛不发版）。`order-insight` 岛的处置：已拍板 = 整体下架。原本留的选项是"拆 `purchase` 只读子域 + 岛发版（作过渡）"或"整体下架"；**因为三个页签当晚就都内建完了**，岛只剩「识别库 / 透视 / 明细」三个非每日动作页，过渡形态没有存在理由 ⇒ 直接下架。

判据：**"收编到什么程度才够下架"= 岛上的每日动作清零，而非功能全等。** 本次砍掉的岛功能里（队列中间层、行内改主数据、四个非每日动作页、要新开 IPC 的对账导出、厂家增删改）**没有一个是每日流程的一步**；反过来，付款的「退款」类型是真实业务（厂家退次品），就必须留。裁量结论写进了两个面板的头注释，与岛对照得回来。

收编时**照功能不照样式**：宿主内建页走 `src/styles/index.css` 的 `.wb-*` 一套（`.wb-btn` / `.wb-tag` / `.wb-input`）。

【历史记录】中间态（当晚之前）：总览 / 导入订单 / 生成拣货单 / 算钱 **已可用**（复用现有实现）；归类核对 **占位**（写明"界面在插件里、功能可用"，收编需把 AI 识别调度一起搬进宿主，`src/core/ai` 客户端已有、当前零调用方）；拿货 / 结算对账 **占位**（数据层**已全在宿主**：`purchase*` 全套 IPC + `orderQueue*`，缺的只是界面 ⇒ 纯 UI 工程）。

**取证**：下架动作当时**卡在市场那一步**（`git -C market-out push` 网络不通）；**重试后已成功**（远端 `main` = `4482d57`，线上目录 4 条、`order-insight-1.5.0.zip` 404）。三处坐标里最容易留半截的就是这里 —— 而且"raw 读不到"**不等于**"push 失败"：两者要用不同命令分别证（见 `2026-10-01-ui-island-retirement.md` §6.6）。

**源**：`2026-10-05-shipping-console-tabs`（2026-10-05）

---

## 7. 收编岛功能：裁量清单（"哪些在流程里有用"）+ 两条守卫写法

**结论**：
- **砍**：队列中间层（宿主导入**直落订单表**，`oi_queue` 是多余一层）· 行内改**主数据**（款式展示名归「货与成本 › 产品」）· 非每日动作的页（识别库 / 透视 / 明细 / 设置 —— 设置已在宿主「设置 → 识别」）· 要新开 IPC 才能实现的"导出对账汇总"（数字屏幕看得见，不属每日动作）。
- **留**：付款的**退款**类型（真实业务：厂家退次品）。

裁量结论写进了两个面板的头注释，与岛对照得回来。拿货/对账的功能与交互参考是原「订单归类」岛的拿货对账页（994 行，手写岛、dist 即源码；**该岛已于同日（2026-10-05）晚些时候整体下架**，源码留档不入库）。

**收编时的两条守卫写法（这次各抓到一个）**：
- **假桥要替的是 preload 上面那一层，载荷形状以 `src/types.ts` 的声明为准**：`orderImageThumbBatch(items)` 渲染层传的是**裸数组**，归一成 `{items}` 是 preload 干的事 —— 假桥写 `p.items` ⇒ 恒空数组 ⇒ 界面全是空占位且**不报错**（静默失败，与 preload 注释里记过的那次同源）。**写假桥先看 types.ts 的签名，别照 handler 写**（handler 收到的已是归一后的形状）。
- **验 `A && B` 两个过滤条件，夹具必须"各缺一样"**：要有"只缺 A 的行 / 只缺 B 的行 / 都不缺的行"。第一版把"已归类"那条写成**无图** ⇒「识别只挑未归类的行」恒绿（排除它的是"没图"，`!styleCode` 根本没被验到）。且当某条件在**更早的步骤**就抛错时（无图行在读图前就 throw），必须换一个**后置的可观测点**（队列大小 / 进度文案）来验它 —— 读图次数抓不到它。

**取证**：参考页 994 行，手写岛、dist 即源码；该岛同日更晚整体下架。

**源**：`2026-10-05-shipping-console-tabs`（2026-10-05）

---

## 8. 删功能必须同时留一条"它不在了"的**反向断言**

**结论**：归类核对的「识别未归类」批量按钮被用户拍板删除。它是全页**唯一的批量动作**，删掉后归类核对只剩逐行核对 —— 即"只留必然正确的那条路"。删的三条理由（慢 20~60s/张且绑住界面 · 范围是"当前页"不是"所有未归类" · **直接落库**而非先给建议）与"保留但暂无调用方的两个识别原语"都写进了 `ClassifyPanel.vue` 的头注释。

**这一步带出一条通用纪律**：**删功能必须同时留一条"它不在了"的反向断言**，否则按钮被加回来时冒烟照绿、也没人会想起它当初是被有意拿掉的。

⚠️ 顺带回顾裁量判据：这条批量识别**不属于"每日动作"**（它是可选的加速手段），所以按当时的标准它本就该被质疑 —— 只是内建时照搬了岛的功能，没在同一轮里追问。

**取证**：反向断言落在 `today:ui` 的 `classify` 段：`!card('cl-recognize') && !card('cl-stop') && !card('cl-progress')`，并在注释里写明"要加回来就改这条"。非空转的证明挂在紧邻的下一条 report 上（**同一个** `card()` 取到了 `cl-query` / `cl-reload` 两个真元素 ⇒ 上一条不可能是"查不到任何元素才恒绿"）。

**源**：`2026-10-05-shipping-console-tabs`（2026-10-05）

---

## 9. 改名：显示名 ≠ 模块 id —— 名称 = **发货台**

**结论**：名称 = **发货台**（只改显示名、id 不动）：只改 `today/meta.ts` 的 `name`（+ `TodayView` 页头 `<h1>`）；**模块 id 仍是 `today`**。改 id 会断 `knownModules` / 深链 / 市场 id，而"给用户看的那个名字"只有 `name` 一处。连带要扫的是**注释里的指路**：「今天 › 拿货」这类写法在 4 处注释 + 2 处测试注释里。

**取证**：`tests/uxEntryNames.spec.ts` 的悬空入口名守卫会拦写错的指路（但它**扫前会 stripComments**，所以只改文档不同步改注释，守卫是看不见的 —— 得手工 `grep -E` 一遍）。

**源**：`2026-10-11-shipping-desk-naming-and-daily-scope`（2026-10-11）

---

## 10. 每日口径按 `created_at`（导入日），不是 `order_time`（下单日）

**结论**：工作流是"每天早上导**前一天 → 导出时点**的全部订单"，中途追加的也算同一天要拿的货。⇒ 筛的键是**导入时间** `date(created_at)`（`created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))`），**不是** `order_time`：昨天下的单今天导，就该落在今天这批里。消费方口径分工：**1–3 步（导入 / 归类 / 算钱）按导入日筛；4–5 步（拿货 / 对账）不动** —— 它们走"未结清 / 未发货近 30 天"，天然可跨天结转。这就是用户拍板的"跨天结转"。

**取证**：落地四处同改（本仓 IPC 契约的标准姿势）：`electron/order-db.ts`（`shippingRows` + `listOrdersPage`）→ `electron/order-handlers.ts`（`sanitizeImportDate` 形状兜底，只放行 `yyyy-mm-dd`）→ `electron/preload.ts` → `src/types.ts` + `src/core/services/ipc.ts`。

**源**：`2026-10-11-shipping-desk-naming-and-daily-scope`（2026-10-11）

---

## 11. ⚠️ 契约是**四处**、不是三处

**结论**：只改 `IpcApi` 接口、漏改 `ipc.ts` 顶层的 `export function orderShippingRows(payload?: {...})` 包装签名 ⇒ `vue-tsc` 报"属性不存在"。本轮实踩一次。

**取证**：漏改对象为 `src/core/services/ipc.ts` 顶层的 `export function orderShippingRows(payload?: {...})` 包装签名；报错为 `vue-tsc` 的"属性不存在"。

**源**：`2026-10-11-shipping-desk-naming-and-daily-scope`（2026-10-11）

---

## 12. 同一份视图、两个入口两种口径 ⇒ 页面必须**写明作用域**

**结论**：「算钱」`OrderCostView` 加了**可选** `importDate` prop：内嵌在发货台（`CostPanel`）时传**今天**；独立模块入口不传 = **全库**（= 改造前行为，不动）。页面上必须**写明作用域**：加了 `data-act="oc-scope"` 的「今天导入」药丸；总览的订单卡同样加 `data-act="orders-scope"`。理由：**同一页里两个数不一样时，用户没法判断谁对** —— 标签就是这个数字的作用域。⚠️ 只在**有数字时**出现（空态那句自己已交代范围，再挂一个标签是重复）。

**取证**：`data-act="oc-scope"` 的「今天导入」药丸；总览订单卡的 `data-act="orders-scope"`。

**源**：`2026-10-11-shipping-desk-naming-and-daily-scope`（2026-10-11）

---

## 13. ⚠️「今天」有两种语义，全仓改名时**别一起改**

**结论**：⚠️ 「今天」在**结算对账的时间窗分段控件**里是**日期语义**（`{ id: 'day', label: '今天' }`），不是模块名 —— 全仓搜「今天」改名时**别一起改**。同理 `electron/*.ts` 里的「今天」都是日期语义。

**取证**：`{ id: 'day', label: '今天' }`；`electron/*.ts` 里的「今天」都是日期语义。

**源**：`2026-10-11-shipping-desk-naming-and-daily-scope`（2026-10-11）

---

## 14. 回执拆两层：`headline` / `message` / `warnings`

**结论**：用户原话是「反馈信息模糊、文字太多、完全看不懂」，而原来 `message` 一坨里塞了**结论 + 判据**。拆成三层：

| 层 | 字段 | 界面 | 判据 |
| --- | --- | --- | --- |
| 结论 | `headline` | 17px 大字，独立一行 | 扫一眼就知道"成了没有、成了多少" |
| 判据 | `message` | **默认折叠**在 `<details>`（「怎么看出来的」） | 排查用；不该占日常阅读路径 |
| 异常 | `warnings[]` | **平铺不折叠** | 用户**要采取行动**的事（跳过几行 / 主图没下来）；空数组 ⇒ 一个字都不写（不写"无异常"，那种话不携带信息） |

**取证**：`headline` 为 17px 大字独立一行；`message` 默认折叠在 `<details>`（「怎么看出来的」）；`warnings[]` 平铺不折叠，空数组一个字都不写。

**源**：`2026-10-11-shipping-desk-naming-and-daily-scope`（2026-10-11）

---

## 15. 「下一步」的 `tab` 与 `moduleId` 二选一，冒烟必须比对**现读**清单

**结论**：「下一步」的 `ImportNextStep` 加了可选 `tab`（与 `moduleId` 二选一）：**目标在本页页签就写 `tab`**（就地切页签，`go()`），真跳别的模块才写 `moduleId`（`openModule()`）。写错 = 点了没反应且**界面看不出异常**。

**取证**：冒烟里 `checkNextTargets()` 会把按钮 id 拿去与**现读的** `KNOWN_TABS`（正则从 `flowCtx.ts` 抓）∪ `KNOWN_MODULES`（读 `modules.config.json`）比对 —— 清单**抄副本**的话将来改配置这断言会恒绿。

**源**：`2026-10-11-shipping-desk-naming-and-daily-scope`（2026-10-11）

---

## 16. 回执主次按场景分叉，**两支都要测**

**结论**：主次按场景分叉，**两支都要测**：店铺**未归属**（报表没店铺列）⇒ 次操作「去『算钱』归店铺」(`cost`)；**已归属** ⇒ 次操作「去看要拿什么」(`purchase`)。主操作两场都是「去核对这些行」(`classify`) —— 这条是修**自相矛盾**：流程卡上"第 2 步才是当前步"，而回执原先把人直接送到第 4 步拿货。

**取证**：未归属分支次操作为 `cost`、已归属分支为 `purchase`，主操作两场都是 `classify`。

**源**：`2026-10-11-shipping-desk-naming-and-daily-scope`（2026-10-11）

---

## 17. 归类页：页头「待核对 X · 已核对 Y」是**动作计数**，两个数必须同一个筛

**结论**：页头「**待核对 X · 已核对 Y**」（`data-act="cl-counts"`）。它不是被撤掉的"指标条"复活，而是**这一页的动作计数** —— 这页的动作是"逐行核对 → 那行离开列表"，做完一轮用户**看不出自己做了多少**，列表一空只剩一句"都核对完了"，无从判断"真核完了"还是"这批本来就没有"。

⚠️ 两个数**必须同一个筛**（都按导入日），否则两边之和会大于这批的行数，用户一眼看出对不上。

**取证**：`pendingCounts()` 因此是三次 `orderList` 的 `Promise.all`（`corrected:false` / `corrected:true` / 不带 ⇒ 用来数 unclassified）。

**源**：`2026-10-11-shipping-desk-naming-and-daily-scope`（2026-10-11）

---

## 18. 归类页空态按**原因**分三支（提示不是入口）

**结论**：空态按**原因**分三支（提示不是入口 —— 说明里的下一步必须**点得到**）：
- 今天还没导 ⇒ 「去导入订单」(`cl-goto-import`)；
- 搜不到 ⇒ **不给按钮**（清空搜索框就在旁边，塞个按钮反而多一步）；
- 这批核对完了 ⇒ 「去算钱」(`cl-goto-cost`) + 「去看要拿什么」(`cl-goto-purchase`)。

空态标题是「**今天还没有导入订单**」而不是「还没有订单数据」：只数今天这批时，后者是**假话**（库里可能有前几天的单，用户会以为数据丢了 —— 正是本轮要治的病）。

**取证**：三支出口锚点 `cl-goto-import` / 无按钮 / `cl-goto-cost` + `cl-goto-purchase`；标题文案「今天还没有导入订单」。

**源**：`2026-10-11-shipping-desk-naming-and-daily-scope`（2026-10-11）

---

## 19. ⚠️ 假桥要连**结构**一起复刻（夹具只复刻"内容"不够）

**结论**：`scripts/today-ui-smoke.mjs` 的假桥 `orderList`，原先在 `corrected` **未传**时只回"待核对"行；而真实 `listOrdersPage` 的语义是 **`corrected === undefined` ⇒ 不过滤（全表）**。后果：为「核对过的行不该出现在待核对表里」新加的断言**恒绿** —— 假桥根本不可能在待核对分支里返回那些行，"列表漏传 `corrected: false`"这个回归永远抓不到。

修法：让假桥照抄真实语义（`undefined` ⇒ 全部；`true`/`false` 才按列筛）。之后 `listPending` 掉 `corrected: false` 的变异体才真的把这条断言打红。

**推论（可复用到任何假桥）**：夹具只复刻"内容"不够，**被依赖的结构（参数语义、缺省行为、分页边界、sheet 顺序…）也要一起复刻** —— 否则依赖该结构的错误实现必然恒绿。

**取证**：真实语义 `corrected === undefined` ⇒ 不过滤（全表）；修后 `listPending` 掉 `corrected: false` 的变异体把断言打红。

**源**：`2026-10-11-shipping-desk-naming-and-daily-scope`（2026-10-11）

---

## 20. 两个操作层面的坑：注入脚本注释里的反引号 · BSD 版 `grep`

**结论**：
- ⚠️ **注入脚本注释里的反引号**：`today-ui-smoke.mjs` 是两个大模板串（`FAKE_BRIDGE` / `ASSERT_SCRIPT`），注释里写 `` `createdAt` `` 会把模板串**提前闭合**，而 `node --check` 报的是"文件末尾 brace 不配"，很难往这里想。本轮又踩 **4 次**（累计第 3、4 次）。**小批改、每批 `node --check`**，别攒一批再跑。
- ⚠️ 本仓 `grep` 是 macOS BSD 版：`grep "a\|b"` **静默返回"无匹配"**（看起来像"文件里真没有"）。一律用 `grep -E` 或 Grep 工具。本轮又据此误判过一次"文件里没有"。

**取证**：`node --check` 对 `` `createdAt` `` 这类提前闭合报的是"文件末尾 brace 不配"；`grep "a\|b"` 静默返回"无匹配"。

**源**：`2026-10-11-shipping-desk-naming-and-daily-scope`（2026-10-11）

---

## 21. 门禁与变异复核（2026-10-11 实跑）

**结论**：门禁全绿；变异复核 6 条全部按预期变红。

**取证**：

**门禁（逐条单看退出码）**：`vue-tsc --noEmit` · `tsc -p tsconfig.electron.json` · `verify` · `verify:docs` · `vitest run`（689 通过）· `lint`（0 error）· `build` · `today:ui`（**215** 项）· `goods:ui`（271 项 ×3 遍）· `order-profit:ui` —— **全部通过**。

**变异复核 6 条**（改坏实现 → 确认对应断言真的变红 → `grep -rn MUTANT` 清零）：

1. `TodayView` 去掉 `importDate` ⇒ 「订单卡：只数今天导入的」红（2 行变 3 行；连带缺口计数红 —— 反向夹具那行也进了缺口统计）；
2. `pendingCounts` 的 `corrected` 取错 ⇒ 「页头动作计数：待核对 5 · 已核对 2」红（变 5 · 5）；
3. 回执去掉 `import-headline` ⇒ 大字结论那条红（`headline=无`）；
4. 空态文案退回「还没有订单数据」 ⇒ `[empty]` 步**直接超时中止**（连带挡住后续步骤）;
5. `hasOrders` 漏算 `counts.corrected` ⇒ 「今天这批都核对完了」+ 它的两个出口红；
6. `listPending` 掉 `corrected: false` ⇒ 「核对过的行不在待核对表里（P-46 / P-47）」红（两行都混进来）。

⚠️ 变异的反向夹具是**刻意给"不相等且都不为 0"**的一组数（5 待核对 + 2 已核对）：给 0 的话"计数实现坏了恒返回 0"照样绿；给满的话两个数相等，也分不出"数错了"。

**源**：`2026-10-11-shipping-desk-naming-and-daily-scope`（2026-10-11）

---

## 22. 运费岛回收：真正的工作是把 6 个 op 抽成**单源服务**

**结论**：用户要求把运费岛也并进「基础数据」。与 shop-accounts 同模式，但**这次的痛点不在桥桩，而在"两份实现"**：岛时代 6 个 op（`parseRateSheet` / `rateCurrent` / `rateAdopt` / `quote` / `quoteOrders` / `quoteProducts`）住在 `src/core/plugin/host.ts` 的 `DB_OPS['shipping-rate']` 里，供 iframe 岛经 `window.__sk` 调。内建页面要**直接**调同一份逻辑，若在页面里另写一遍，档位/取整/类别优先级任何一处漂移都会让同一份报价单算出两个数（**静默错价**，本仓反复强调的红线）。故抽 `src/core/services/shipRateOps.ts` 作为唯一实现，`host.ts` 该域改为**薄委托**（只服务市场里已装旧岛的用户）。

岛：`ui-plugins/shipping-rate`（手写 ESM 岛，`dist/` 即源码、无构建步骤，14 文件，1.3.1）→ 内建 `src/modules/shop-accounts/`。页面落地：`shipRateFormat.ts`（展示格式化）+ `shipRateStore.ts`（Pinia store）+ 5 个组件（`ShippingRatePane` 四页签 shell + `ShipRateQuote/Rates/Orders/ProductsTab`）。`MasterDataView.vue` 的资料种类由 6 项增至 **7 项**，新增「物流运费」；`icons.ts` 补 `ship` 图标路径。冒烟重写：`scripts/shipping-rate-ui-smoke.mjs` 从"岛 dist 站点"整体改为"宿主 build 产物站点"（骨架与两遍视口沿用）。

**取证**：`git rm -r ui-plugins/shipping-rate`（14 文件全在 git 跟踪下，可从历史恢复）；`.gitignore` 里那条岛专用的反忽略行 `!ui-plugins/shipping-rate/dist/` 同步删除（留着会让 `tests/pluginTriage.spec.ts` 的「dist/ 未被忽略」守卫读到一条指向已删目录的规则）。

**源**：`2026-10-15-shipping-rate-intake`（2026-10-15）

---

## 23. 存储命名空间刻意沿用 `shipping-rate`

**结论**：`useModuleStorage('shipping-rate')`（不是改成 `shop-accounts`）。空间键未变 ⇒ 升级后旧岛存下的查询偏好（克重 / 类别 / 变体 / 进位方式 + `lastFile` / `sheetNames` / `candidates`）**无缝接续**，不必迁移也不必清空。回收时最容易顺手"改成更整齐的名字"，那会让所有老用户丢偏好。

**取证**：`useModuleStorage('shipping-rate')`；空间键未变 ⇒ 升级后旧岛存下的查询偏好无缝接续。

**源**：`2026-10-15-shipping-rate-intake`（2026-10-15）

---

## 24. `ui-plugins/` 的规模表**看不出**岛被删了

**结论**：baseline 口径 `find … -name dist -prune` 把手写岛的源码整体排除，而手写岛的源码**就在 `dist/`**。故下架 shipping-rate 后该行数值（8 文件 / 509 行）**不变**——不是没删，是从不上它。已在 baseline 就地标注，别让下一个读者误判成"下架没生效"。

**取证**：`find … -name dist -prune`；该行数值 8 文件 / 509 行不变。

**源**：`2026-10-15-shipping-rate-intake`（2026-10-15）

---

## 25. 旧守卫的断言对象随架构改变 —— 不是删了事，而是改成顺着三层链逐层查

**结论**：`tests/pluginTriage.spec.ts` 原先断言 `hostDomainBlock('shipping-rate')` 含 `importSheet.importRateSheet`。抽服务后调用链多了一层（host → shipRateOps → importSheet），该断言**必然变红**。不是删了事，而是改成**顺着三层链逐层查**（每层不许自己解析、全链不许回落取第一张 sheet）。删掉断言会让"两份实现"这道防线凭空消失。

**取证**：`tests/pluginTriage.spec.ts`：删除依赖岛源码的 6 条断言（op 被岛调用 / 禁 eval / 不引 xlsx / 不自算费率 / bridge 命名空间 / 导入走 prefer），改为 6 条**三层链**断言。**变异复核**：① 让 host.ts 混入 `xlsx`（自解析）→ 1 条红；② 让 shipRateOps 不调 importSheet（自己解析）→ 2 条红；还原后全绿。

**源**：`2026-10-15-shipping-rate-intake`（2026-10-15）

---

## 26. `pluginManifest.spec.ts` 的三元组不够用 ⇒ 改五元组；夹具 sheet 数别写死

**结论**：原 ISLANDS 是 `[岛id, manifest, 一个db动作]`，断言里拿 `domain: id` 顶替真实域名。换锚到 `ae-profit` 后立刻暴露——**它的 db 域是 `ae` 不是 `ae-profit`，且它根本没声明 storage**。改为五元组显式携带真实域名与命名空间（`null` = 未声明，该组用例跳过），不再靠"id==域"的巧合。

**夹具 sheet 数别写死**：冒烟里原断言 `sheetNames.length === 8`，实跑打点才发现 `tests/fixtures/shipping-rate.xlsx` 是 **9 张**（多一张「无忧物流-海运大件专线」）。改为按**真实 sheet 名称集合**断言（每张都在 + 数量相等），换夹具时不会静默错位。

**取证**：`tests/pluginManifest.spec.ts`：岛清单 −shipping-rate，改钉 `excel-copy` + `ae-profit`；`shipAccountsIntake` 之外的 `tests/uiIslandThemeTokens.spec.ts` / `pluginTriage` 的 `noBuild` 守卫：手写岛只剩 `excel-copy`，注释同步。`scripts/check-doc-links.mjs`：`ui-plugins/shipping-rate/**` 的 7 个 token 进 `DELIBERATELY_MISSING`（历史陈述，改指现存文件则句子不成立）。⚠️ `docs/README.md` 里那条**活导航**不豁免、已改指本笔记 —— 它现在还指引人去看岛 README，是真会被人点开的。

**源**：`2026-10-15-shipping-rate-intake`（2026-10-15）

---

## 27. 运费真值必须**独立算**，且要能被"换一个人"的用例证伪

**结论**：冒烟里三条真值钉的是**独立算出来的**数，不是照抄实现。这条尤其重要：写死"350g 还是 KZ 8.50"会恒红，而只写"最便宜那行"则两者都绿、等于没验。

**取证**：100g 最便宜哈萨克斯坦 `8.50`（45×0.1+4）、次便宜马来西亚 `9.80`；**改 350g 后首行换人**（KZ 只有 ≤150g 档，装不下 350g → 马来西亚 150g–500g 档 `16.05`）。

`tsc -p tsconfig.electron.json` ✅ · `vue-tsc --noEmit` ✅ · `verify` ✅ · `verify:docs` ✅（本笔记登记后）· `vitest run` ✅ · `build` ✅ · `shipping-rate:ui` ✅（31 项 × 宽/窄两遍）。

**源**：`2026-10-15-shipping-rate-intake`（2026-10-15）

---

## 28. 二次收口：整域删除，但**三处刻意没删**

**结论**：用户原话：**「老用户市场里的旧岛不需要能用，都删除掉，这个项目还没上线」**。薄委托的前提是"老用户市场里已装旧岛"——这个前提不成立（岛从未推送上线，zip 只在本机 `market-out/` 打包过）。于是把整条通路拿掉：

| 层 | 处置 |
|---|---|
| `host.ts` `DB_OPS['shipping-rate']` | **整域删除**（5 op）+ 删随之未用的 `shipRateOps` import |
| 市场 `catalog.json` | 去掉 `shipping-rate` 与 `shop-accounts` 两条（后者 10-14 已回收，同样该撤） |
| 市场 `*.zip` | `shipping-rate-*.zip` 8 个 + `shop-accounts-*.zip` 全部删除（**先 `cp -cR` 备份到 `/tmp/market-out.bak.*`**） |
| `OrderCostView.vue` | 删读旧岛 storage 键 `table` 的回落分支 |
| `tests/pluginTriage.spec.ts` | 三层链断言**改为反向守卫**（见下） |

**三处刻意没删**（都是"删了会拆掉有价值的东西"）：

1. **`rateAdopt`** —— 它不是岛通路，是**用户数据迁移**（把早期留在 storage 里的运价表一次性交给宿主快照）。删了 ⇒ 早期用户的表永远迁不上来。
2. **`computeOrderCosts` 的 `rateTable` 入参与其单表回退分支** —— 分支本身合法，`tests/orderCost.spec.ts` 有 20+ 处传入、还专门钉着"快照优先于单表"。只把生产调用点改成恒传 `null`。
3. **storage 命名空间 `shipping-rate`** —— 现在只存**查询偏好**（克重/类别/变体/取整），仍在读写，与岛无关。

**守卫：从"查链条"改成"钉不存在"** —— 原三层链断言（① op 委托服务 → ② 服务调 importSheet → ③ 不得回落取第一张 sheet）在域删除后前两条失去断言对象。**不删、改造**为：`host.ts` 不得再有 `shipping-rate` 域；市场 catalog 不得再有 `shipping-rate` / `shop-accounts`；保留 `importSheet` 单源与"不回落取第一张 sheet"两条（它们的对象还在）。

**为什么必须留**：这个域一旦被加回来，症状**不是报错**，是同一份报价单算出两个数（静默错价）；而且它长得"很合理"（薄委托 + 一段注释解释"为什么为老用户保留"），review 时极易放过。反向守卫比"查解析只有一份实现"更靠上游 —— 后者挡不住有人新写一整个平行实现。

**取证**：**变异复核**：把域加回 `DB_OPS` ⇒ 目标守卫红；catalog 加回条目 ⇒ 红。（首次变异时插入点算错、域被插到了 `DB_OPS` 外面，守卫因 `hostDomainBlock` 返回空而**假绿**——插入点必须落在对象内。）

**源**：`2026-10-15-shipping-rate-intake`（2026-10-15）

---

## 29. 「运费查询」页空白：**`flex: 1` 只在祖先给出确定高度时才是"伸缩"**

**结论**：冒烟全绿（31 项，184 国表格、费用构成、金额全对），`--dump-dom` 里表格**完整存在**，但截图上工具条之下**一整块空白**，什么也没有。用户描述为"样式不对"。根因：**`flex: 1` 只在祖先给出确定高度时才是"伸缩"，否则是"平分内容"。** 宿主 `.wb-panel__body { flex: 1 }`（`src/styles/index.css`）本身没错，前提是祖先链给到确定高度；四个页签的根容器都漏了 `flex:1 + min-height:0` ⇒ 面板被内容撑到 8000px ⇒ 内部 body 平分 ⇒ summary（row 布局 + `align-items:center`）那行"共 184 国"的标签被垂直居中到 y≈2162，而视口 913 ⇒ **整个可见区全是那 3982px 的空白**。

**取证**：新建 `scripts/shipping-rate-ui-shot.mjs`（一次性取证工具，不是门禁）：截图 + 把关键节点的 `getBoundingClientRect()` 与可见性样式写进 `#probe`，`--dump-dom` 后读出来。量到的事实串成一条因果链：

```
.srq            内容高 8036px   ← 根容器只有 display:flex，没有高度约束
.srp__body         高  773px   ← 真正可用的高度
.srq__results      高 7966px   ← 被内容撑高（.wb-panel 是 flex column）
  .wb-panel__body  高 3982px   ← 两个各平分（flex:1 1 0%）
  .wb-panel__body  高 3982px   ← 其中表格那份
  srq__summary     高 3982px   ← ⭐ 只有一行标签的行
table-wrap        y = 4153px   ← 视口只有 913px ⇒ 完全在屏幕外
docScrollH = 913              ← 祖先 overflow:hidden ⇒ 文档也不滚
```

修法（契约抄 `CostPane.vue` 的 `.ct`）：

```css
.<page> { flex: 1; min-height: 0; }      /* 根：接受祖先给的确定高度 */
.<fixed> { flex-shrink: 0; }             /* 工具条/信息卡：不参与伸缩 */
.<results> { flex: 1; min-height: 0; }   /* 唯一可伸缩的面板 */
.<summary> { flex: 0 0 auto; }           /* ⭐ 收回：它只有一行高 */
.<table-body> { flex: 1 1 auto; min-height: 0; overflow: hidden; }  /* 表格容器自己滚 */
```

修后：`srq` 798px · `results` 728px · `summary` **18px** · 表格容器 `clientH=708 / scrollH=7946`（内部滚动）。

**源**：`2026-10-15-shipping-rate-intake`（2026-10-15）

---

## 30. ⭐⭐「DOM 断言全绿」不等于「页面能用」——需 4 条几何断言

**结论**：原 `isShown(el)` = `getClientRects().length > 0 && display !== 'none'` ——**元素在视口外 4.5 倍高的地方照样判"可见"**。这类"DOM 在、用户看不见"的故障，文本类断言（`has('哈萨克斯坦')` / 行数 / 金额）**一条都不会红**。凡渲染大面积内容的面板，都要有一条"关键元素在视口内 + 容器可滚"的几何断言；这类判据只能在真浏览器里跑。

补的 4 条几何断言：

| 断言 | 钉的是什么 |
|---|---|
| `heightOf(summary) < 120` | 一行标签不该被 flex 撑成几千 px（断裂的第一症状） |
| `inViewport(firstRow)` | 首行必须落在视口内（`r.bottom > 0 && r.top < innerHeight`） |
| `heightOf(results) <= innerHeight` | 面板不该比视口高（表格要滚，不要撑高整页） |
| `wrap.scrollHeight > wrap.clientHeight` | 表格容器真的可滚（不是被裁掉） |

工具本身的两条纪律：**假桥从冒烟脚本里切出来**（按标记定位模板串），不复制粘贴 ⇒ 截出来的就是冒烟在跑的那条链；**注入脚本的注释里不能有反引号**（模板串提前闭合）。⭐ 一个页面有多个同类区块时，按同一病因一次全修（本次四个页签同病，只修了用户点到的那个就会在其余三个上复现）。

**取证**：**变异复核**：退回修复前的样式 ⇒ 4 条全红，且 detail 精确复现原始数字（`h=3982px` / `top=4188 bottom=4231` / `h=7966` / `scrollH=7946 clientH=7946`）；还原后全绿（36 项）。本次反引号又踩一次：变异跑出来是 `SyntaxError: Unexpected identifier 'flex'`，而 `node --check` 对这类脚本不充分。

**源**：`2026-10-15-shipping-rate-intake`（2026-10-15）

---

## 31. 「算钱」整步撤出发货台：五步 → 四步，六个页签 → 五个

**结论**：用户口径（原话）：**「发货台中的算钱步骤去掉，还是都归拢到算钱菜单中，算钱菜单修改成统计」**。一句话：发货台只管**做**（导入 → 归类 → 拿货 → 对账），「统计」只管**看钱**。**发货台从五步变四步、六个页签变五个**（总览 + 导入订单 / 归类核对 / 拿货 / 结算对账）。拿货由第 4 步顺位成**第 3 步**、结算对账由第 5 步成**第 4 步**。

**`order-cost` 的显示名「算钱」→「统计」，`id` 一个字母都没动**（`src/modules/order-cost/meta.ts`）。id 是路由/配置/`switchModule`/`data-act` 的锚，改名只动 `name` —— 这样 `modules.config.json` 的用户配置、冒烟里的 `moduleId: 'order-cost'`、文档里的路径引用**全部无需迁移**。

**判据（为什么这一步能撤）**：它**不写任何数据**、也不是发货的必经动作（可以一辈子不看利润照常发货），却占着流程卡的一个节点 —— 结果是"当前该做哪一步"的推导里**永远挂着一个不动的位置**（`flowNow` 找不到 `now` 时会落到它身上）。撤掉后 `now` 恒为 1，流程卡才真正是"一条线"。

**钱只有一份实现，只是入口少了一个**：利润口径仍在 `src/lib/orderCost.ts` 一处算，`OrderCostView.vue` 的**内嵌形态（`embedded` / `refreshToken` / `importDate` 三个 prop）整套删除**。原来"同一页两个口径"（内嵌时只算今天导入的那批、独立时看全库）随之消失 ⇒ **一个入口、一个口径（全库）**。

**取证**：`src/modules/order-cost/meta.ts` 只改 `name`；`OrderCostView.vue` 删 `embedded` / `refreshToken` / `importDate` 三个 prop。

**源**：`2026-10-17-cost-out-of-shipping-desk`（2026-10-17）

---

## 32. 撤一步的**连带清单**（漏一个就是"点了没反应"）

**结论**：

| 位置 | 改了什么 | 漏了会怎样 |
| --- | --- | --- |
| `src/modules/today/TodayView.vue` `TABS` | 删 `cost` 项，`purchase` 编号 4→3、`recon` 5→4 | 页签还在，点开是空面板 |
| 同上 `flow` 计算 | 删 `cost` 步、删 `needCost`/`gt`、`wait4 = wait3` | 流程卡多一张永远 `todo`/`gap` 的卡 |
| 同上 `flowNow` | 只找 `state === 'now'` | 找不到时落到算钱那步（"当前步"指向一个撤掉的步骤） |
| `src/modules/today/flowCtx.ts` | `FlowStep.state` 由 `'done'\|'now'\|'gap'\|'todo'` 收成三态；`SHIPPING_TAB_NAMES` 删 `cost` | `gap` 唯一的产生者就是算钱步 ⇒ 留着就是死状态；页签名表多一项 = 悬空入口名守卫**反过来失效** |
| `TodayView.vue` 样式 | 删 `.td-tab.is-gap::before` | 死样式 |
| `OrderCostView.vue` | 删 `embedded`/`refreshToken`/`importDate`、删页内刷新按钮与「今天导入」范围标、`<h1>算钱</h1>`→`统计` | 内嵌分支没人走，但**存在即会被下一个人复制** |
| `today/meta.ts`、`order-cost/meta.ts`、`order-cost/components/CostRatesSection.vue`、`shop-accounts/**` | 注释与排序说明跟着改 | 下一个人按注释找「算钱」页 |
| `README.md` / `AGENTS.md` / `docs/baseline/PROJECT_BASELINE.md` | 模块表、显示名、"一页五页签" | 基线快照与实际不符（本仓"计数只信 baseline"会被带偏） |

**取证**：上表逐行对应 `TodayView.vue` / `flowCtx.ts` / 三个 `meta.ts` / `README.md` / `AGENTS.md` / `docs/baseline/PROJECT_BASELINE.md`。

**源**：`2026-10-17-cost-out-of-shipping-desk`（2026-10-17）

---

## 33. 坑 A：删页签 ≠ 删掉入口 —— 回执里的 `tab: 'cost'` 会变成"点了没反应"

**结论**：`src/core/services/importSheet.ts` 的原话是 `{ label: '去「算钱」归店铺', tab: 'cost' }`，`tab` 的语义是**就地切页签**（不跳页）。页签被删后 `go('cost')` 只会把 `tab.value` 设成一个 TABS 里不存在的 id，界面**什么都不发生**（`activeComp` 有 `?? TABS[0]` 兜底，于是你会看到总览页 ——比报错更难查）。修法：与钱有关的三处（归店铺 / 看毛利 / 核对运价表）一律改成 `moduleId: 'order-cost'`。

**连带效应**：`data-act` 由 `import-next-${a.tab || a.moduleId}` 自动生成，所以按钮 id 从 `import-next-cost` **变成** `import-next-order-cost` —— 冒烟里所有钉旧 id 的断言（含"这个按钮不许回来"这类反向断言）必须同批改，否则守卫守的是一个不存在的元素（**恒绿**）。

**取证**：原代码 `{ label: '去「算钱」归店铺', tab: 'cost' }`；`data-act` 生成式 `import-next-${a.tab || a.moduleId}`；id 由 `import-next-cost` → `import-next-order-cost`。

**源**：`2026-10-17-cost-out-of-shipping-desk`（2026-10-17）

---

## 34. 坑 B：跨模块跳转的**回程**要等目标页真挂上，不能只等事件

**结论**：`switchModule()` 只是 `window.dispatchEvent(new CustomEvent('switch-module'))`，真正的切换在 `AppShell.vue` 的 `onSwitchModule` 里，而且是 **`await pm.activate(id)`**（异步）。本轮首跑冒烟直接 `FAILED at [classify] - timeout`：点 `cl-goto-cost` 后只等 `switch-module` 事件（同步派发，立刻就"等到了"），随即 dispatch 回 `today` —— 两次 `activate` 互相覆盖，**后到的 order-cost 把 today 顶掉**，后续断言全部找不到元素。

**取证**：判据写法（现役）：去程等 `moduleId === 'order-cost'` **且** `.oc-view` 已在 DOM，回程等 `.td-view` + `[data-act="tab-classify"]` 出现**且** `.oc-view` 已消失。两条都要，单向不够。

**源**：`2026-10-17-cost-out-of-shipping-desk`（2026-10-17）

---

## 35. 坑 C：步号是"跨页复制的字"，注释改了界面不一定改

**结论**：`ReconPanel.vue` 空态写「或者先去**第 4 步**「拿货」把拿货单开出来」—— 撤掉算钱后拿货是第 3 步。源码注释里写清了顺位，**界面文案漏了**，而没有任何门禁看得见（文案是常量、步号不在任何断言里）。所以冒烟里那条断言现在钉着"步号与实际一致"（`reconEmpty.indexOf('第 3 步') >= 0`），理由写在断言旁边的注释里：**这类错只有人点那条路径才会发现，不值得靠人。**

**取证**：`reconEmpty.indexOf('第 3 步') >= 0`；`grep -n "第 [0-9] 步" src/modules/today/tabs/ReconPanel.vue` 可证源码已是「第 3 步」。

**源**：`2026-10-17-cost-out-of-shipping-desk`（2026-10-17）

---

## 36. 前向守卫：让这步没法自己走回来

**结论**：

| 守卫 | 断言 |
| --- | --- |
| `tests/uxEntryNames.spec.ts` | `shippingTabNames()` **不含**「算钱」；`hostModuleNames()` **含**「统计」 |
| `scripts/today-ui-smoke.mjs`（`tabs` 步） | `tab-cost` 按钮与 `.oc-view` 面板**都不在本页** |
| 同上（`flow` 步） | `flow-cost` 卡**不存在**；`flowKeys = ['import','classify','purchase','recon']`；当前步唯一 |
| 同上（回执段） | 次操作是 `import-next-order-cost` 且文案含「统计」（反向：`import-next-cost` 不存在） |
| 同上（归类空态段） | 「去「统计」看利润」→ 真跳模块（`moduleId === 'order-cost'` 且目标页挂上） |

**取证**：上表五行逐条对应 `tests/uxEntryNames.spec.ts` 与 `scripts/today-ui-smoke.mjs` 的 `tabs` / `flow` / 回执 / 归类空态四段。

**源**：`2026-10-17-cost-out-of-shipping-desk`（2026-10-17）

---

## 37. `*:ui` 类门禁读 `dist` —— 改界面必须先 `npm run build`

**结论**：**判据：`*:ui` 类门禁读 `dist`，改界面必须先 `npm run build`，否则红的可能是自己的缓存。**

**取证**：

```
npm run build                 # ⚠️ today:ui 读 dist —— 改界面文案后**必须先 build**
npm run today:ui              # 250 PASS / SMOKE: ALL PASS
npm run vue-tsc -- --noEmit   # 无输出
npm run verify / verify:docs
```

**再踩一次的旧坑**：改完 `ReconPanel.vue` 的「第 3 步」直接跑 `today:ui`，红在 `FAILED 厂家账清零时给空态…`，报告里显示的还是「第 4 步」—— 因为 `dist` 里是旧产物。

**源**：`2026-10-17-cost-out-of-shipping-desk`（2026-10-17）

---

## 38. 本轮**没有**做完的事（边界）+ 历史笔记不回填

**结论**：
- **`ui-plugins/ae-profit` 的岛内文案已改（`AeProfitView.vue` 的 tip-card）但没发版**：已装旧岛的机器上仍显示「算钱」。要让这行字到用户手里得走发布四步（打包 → `market-out/` commit → `publish-plugin.js` → 安装），见 `docs/notes/2026-10-30-island-publish-and-retire.md`。`manifest.json` 的 `description` **故意没动**（同版本改内容会被发布口判成硬错误，见"版本号是唯一更新信号"那条纪律）。
- 历史笔记里写「五步」「六页签」的（`2026-10-05-shipping-console-tabs.md`、`2026-10-10-picking-merged-into-purchase.md` 等）**不回填**：它们记录的是当时的形态，本条是它们之后的下一次顺位。要查当前形态看 `docs/baseline/PROJECT_BASELINE.md`。

**取证**：`AeProfitView.vue` 的 tip-card 已改、未发版；`manifest.json` 的 `description` 故意未动。

**源**：`2026-10-17-cost-out-of-shipping-desk`（2026-10-17）

---

## 39. 包裹运费接进利润（C1）：**包裹真值优先**

**结论**：利润页的运费改为**包裹真值优先**：已拆包的单 = 包裹 `ship_cents` 合计（按件数摊到各商品行），没拆包的单保持运价表链路；**已拆包但缺运费 ⇒ 标缺，不回落估算**。

四条口径（改之前先读）：
1. **包裹是真相**。用户在拆包抽屉里填的运费/重量就是这一单的实付，不能再被运价表估算覆盖。缺了就写「—」并标 `parcel` 缺口（界面 chip「缺包裹运费」，可点筛行）—— 回落估算会让"按包记的真值"被悄悄盖掉，且行上没有任何痕迹（和 A7「真值先于估算」同一条纪律）。
2. **摊的只是行，订单总额不变**。`orderCost.ts` 按每单件数把订单级运费摊到各行：`round2(total × qty / qtySum)`，**尾差归末行** ⇒ 各行之和恒等于订单合计（`10.01 → 3.34/3.34/3.33`）。件数取的是同一处 `resolveQty`（结算真值 → 报表块 → 按 1 并标缺）。
3. **未拆包的单原样**。`parcelTotals[orderNo].count === 0` 或不在返回里 ⇒ 走原「快照按订单日期取当时那份」的运价表链路，行为与 C1 之前逐字相同。
4. **一个数字一处实现**。单笔 `parcelTotals(orderNo)` 已改为委托批量 `parcelTotalsByOrders([no])` —— 聚合 SQL、缺值判空、`shipMissing/weightMissing` 只有一份。利润页一次批量取（`order-parcel-totals`），不逐单 IPC。

**取证**：摊分公式 `round2(total × qty / qtySum)`，尾差归末行，`10.01 → 3.34/3.34/3.33`；`parcelTotals[orderNo].count === 0` 或不在返回里 ⇒ 走运价表链路。

**源**：`2026-10-21-parcel-shipping-in-profit-c1`（2026-10-21）

---

## 40. 接线与界面三态：`shippingSource` = `parcel` / `rate` / `none`

**结论**：链路：`order-db.parcelTotalsByOrders` → `order-handlers` 的 `order-parcel-totals` → preload `orderParcelTotals` → `src/types.ts` / `src/core/services/ipc.ts`（**三处同步**，`npm run verify` 会拦）。`OrderCostRow.shippingSource`：`parcel` / `rate` / `none`；运费单元格悬停三态说清"真值 / 哪份运价表 / 包裹缺运费且不估算"。多件提示同步改成"成本按单件价；未拆包的单运费按 1 件估"。

「还没读到运价表」的 toast **只在还有未拆包订单时**出现：全部已拆包时运费走包裹实付，再喊用户去导报价单 = 支他去补一份用不到的数据。

**取证**：链路 `order-db.parcelTotalsByOrders` → `order-handlers` 的 `order-parcel-totals` → preload `orderParcelTotals` → `src/types.ts` / `src/core/services/ipc.ts`（三处同步，`npm run verify` 会拦）。

**源**：`2026-10-21-parcel-shipping-in-profit-c1`（2026-10-21）

---

## 41. 两个静默坑：内联 `Record<...>` 切不动 · 假桥兜底把新通道伪装成"没数据"

**结论**：
- **契约校验器切不动内联 `Record<...>`**：`ElectronAPI` 里直接写 `Promise<APIResult<Record<string, ParcelTotals>>>` 会被顶层逗号切成假成员 ⇒ 用具名别名 `ParcelTotalsMap`（同 `ParcelCountMap`）。这是脚本的局限，不是契约错。
- **假桥的兜底会把新通道伪装成"没数据"**：`order-profit:ui` 的 Proxy 对未声明方法返回 `{success:true,data:null}` ⇒ 新加的 `orderParcelTotals` 不补桩也"全绿"，但页面永远走运价表。故显式加桩，并用**两个应结果不同的数**验真：运价表 30.00、包裹 45.00（同值会让"走了哪条链"空转）。

**取证**：`Promise<APIResult<Record<string, ParcelTotals>>>` 被顶层逗号切成假成员；Proxy 兜底返回 `{success:true,data:null}`；验真用 运价表 30.00 / 包裹 45.00。

**源**：`2026-10-21-parcel-shipping-in-profit-c1`（2026-10-21）

---

## 42. 顺带修复：B1 拆表后遗留的旧夹具（但要分清"真夹具"与"最小同构桩"）

**结论**：`ipc:shape:smoke` ⑥/⑧ 仍按 B1 前形状造数（`INSERT INTO oi_orders (image_id, size, ...)`）—— B1 后 `image_id`/`size` 在 `oi_order_items`，冒烟一跑就 `no column named image_id`。已改为「主表一行 + 明细一行」。

⚠️ **不是所有 `INSERT INTO oi_orders (shop)` 都要补列**：`shop-db-smoke.cjs` 里那张 `oi_orders` 是**最小同构桩**（只关心店铺名文本，只建 `id/shop` 两列），它刻意不跟订单域 schema 走。拆表后 grep 到旧列时，先分清「真夹具要跟 schema」还是「有意的最小桩」——这次一度把桩改坏。

**取证**：`no column named image_id`；桩只建 `id/shop` 两列。

**源**：`2026-10-21-parcel-shipping-in-profit-c1`（2026-10-21）

---

## 43. 守卫与门禁（C1）

**结论**：`tests/orderCost.spec.ts` 新增 5 条：包裹合计压过运价表 / 多行按件数摊 / 尾差归末行 / 缺运费标缺不回落（`shippingSource='parcel'` + `parcel` 缺口、**没有** `rate` 缺口）/ 无包保持原链路。`scripts/order-profit-ui-smoke.mjs` 新增 2 条：包裹 45.00 ≠ 运价表 30.00；缺运费 →「—」+ 行标「缺包裹运费」+ chip「缺包裹运费 1」+ 悬停写明不估算。批量读口断言"刷新一次调用、带上全部单号"。

**留给 C2**：`ae_cost_map` 退役仍按计划门槛：先把成本维护/导入写口搬到产品表、回填行快照，再以**全库统计 `costSource='costmap'` 与 `weightSource='lookup'` 归零**为判据删回落分支，最后删表（不可逆，由用户执行）。

**取证**：本轮门禁：`tsc`（主进程）· `vue-tsc` · `verify`（209/209/204）· `vitest` 818 · `build` · `order-profit:ui` · `order:smoke` · `shop:smoke` · `ipc:shape:smoke` 全绿。

**源**：`2026-10-21-parcel-shipping-in-profit-c1`（2026-10-21）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-05-shipping-console-tabs.md` | 2026-10-05 | §1 / §2 / §3 / §4 / §5 / §6 / §7 / §8 |
| `2026-10-11-shipping-desk-naming-and-daily-scope.md` | 2026-10-11 | §9 / §10 / §11 / §12 / §13 / §14 / §15 / §16 / §17 / §18 / §19 / §20 / §21 |
| `2026-10-15-shipping-rate-intake.md` | 2026-10-15 | §22 / §23 / §24 / §25 / §26 / §27 / §28 / §29 / §30 |
| `2026-10-17-cost-out-of-shipping-desk.md` | 2026-10-17 | §31 / §32 / §33 / §34 / §35 / §36 / §37 / §38 |
| `2026-10-21-parcel-shipping-in-profit-c1.md` | 2026-10-21 | §39 / §40 / §41 / §42 / §43 |
