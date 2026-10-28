# 「算钱」整步撤出发货台：五步 → 四步，钱只剩「统计」一个入口（同批改名）

> 用户口径（原话）：**「发货台中的算钱步骤去掉，还是都归拢到算钱菜单中，算钱菜单修改成统计」**。
> 一句话：发货台只管**做**（导入 → 归类 → 拿货 → 对账），「统计」只管**看钱**。

**结论（先看这段）**

1. **发货台从五步变四步、六个页签变五个**（总览 + 导入订单 / 归类核对 / 拿货 / 结算对账）。
   拿货由第 4 步顺位成**第 3 步**、结算对账由第 5 步成**第 4 步**。
2. **`order-cost` 的显示名「算钱」→「统计」，`id` 一个字母都没动**（`src/modules/order-cost/meta.ts`）。
   id 是路由/配置/`switchModule`/`data-act` 的锚，改名只动 `name` —— 这样 `modules.config.json` 的
   用户配置、冒烟里的 `moduleId: 'order-cost'`、文档里的路径引用**全部无需迁移**。
3. **判据（为什么这一步能撤）**：它**不写任何数据**、也不是发货的必经动作（可以一辈子不看利润照常发货），
   却占着流程卡的一个节点 —— 结果是"当前该做哪一步"的推导里**永远挂着一个不动的位置**
   （`flowNow` 找不到 `now` 时会落到它身上）。撤掉后 `now` 恒为 1，流程卡才真正是"一条线"。
4. **钱只有一份实现，只是入口少了一个**：利润口径仍在 `src/lib/orderCost.ts` 一处算，
   `OrderCostView.vue` 的**内嵌形态（`embedded` / `refreshToken` / `importDate` 三个 prop）整套删除**。
   原来"同一页两个口径"（内嵌时只算今天导入的那批、独立时看全库）随之消失 ⇒ **一个入口、一个口径（全库）**。

## 连带清单（改一处就得跟着改的地方，漏一个就是"点了没反应"）

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

## 三个坑（本轮真踩的）

### 坑 A：删页签 ≠ 删掉入口 —— 回执里的 `tab: 'cost'` 会变成"点了没反应"

`src/core/services/importSheet.ts` 的原话是 `{ label: '去「算钱」归店铺', tab: 'cost' }`，
`tab` 的语义是**就地切页签**（不跳页）。页签被删后 `go('cost')` 只会把 `tab.value` 设成一个
TABS 里不存在的 id，界面**什么都不发生**（`activeComp` 有 `?? TABS[0]` 兜底，于是你会看到总览页 ——
比报错更难查）。

修法：与钱有关的三处（归店铺 / 看毛利 / 核对运价表）一律改成 `moduleId: 'order-cost'`。
连带效应：`data-act` 由 `import-next-${a.tab || a.moduleId}` 自动生成，
所以按钮 id 从 `import-next-cost` **变成** `import-next-order-cost` —— 冒烟里所有钉旧 id 的断言
（含"这个按钮不许回来"这类反向断言）必须同批改，否则守卫守的是一个不存在的元素（**恒绿**）。

### 坑 B：跨模块跳转的**回程**要等目标页真挂上，不能只等事件

`switchModule()` 只是 `window.dispatchEvent(new CustomEvent('switch-module'))`，
真正的切换在 `AppShell.vue` 的 `onSwitchModule` 里，而且是 **`await pm.activate(id)`**（异步）。

本轮首跑冒烟直接 `FAILED at [classify] - timeout`：点 `cl-goto-cost` 后我只等 `switch-module` 事件
（同步派发，立刻就"等到了"），随即 dispatch 回 `today` —— 两次 `activate` 互相覆盖，
**后到的 order-cost 把 today 顶掉**，后续断言全部找不到元素。

判据写法（现役）：去程等 `moduleId === 'order-cost'` **且** `.oc-view` 已在 DOM，
回程等 `.td-view` + `[data-act="tab-classify"]` 出现**且** `.oc-view` 已消失。两条都要，单向不够。

### 坑 C：步号是"跨页复制的字"，注释改了界面不一定改

`ReconPanel.vue` 空态写「或者先去**第 4 步**「拿货」把拿货单开出来」—— 撤掉算钱后拿货是第 3 步。
源码注释里我写清了顺位，**界面文案漏了**，而没有任何门禁看得见（文案是常量、步号不在任何断言里）。
所以冒烟里那条断言现在钉着"步号与实际一致"（`reconEmpty.indexOf('第 3 步') >= 0`），
理由写在断言旁边的注释里：**这类错只有人点那条路径才会发现，不值得靠人。**

## 前向守卫（让这步没法自己走回来）

| 守卫 | 断言 |
| --- | --- |
| `tests/uxEntryNames.spec.ts` | `shippingTabNames()` **不含**「算钱」；`hostModuleNames()` **含**「统计」 |
| `scripts/today-ui-smoke.mjs`（`tabs` 步） | `tab-cost` 按钮与 `.oc-view` 面板**都不在本页** |
| 同上（`flow` 步） | `flow-cost` 卡**不存在**；`flowKeys = ['import','classify','purchase','recon']`；当前步唯一 |
| 同上（回执段） | 次操作是 `import-next-order-cost` 且文案含「统计」（反向：`import-next-cost` 不存在） |
| 同上（归类空态段） | 「去「统计」看利润」→ 真跳模块（`moduleId === 'order-cost'` 且目标页挂上） |

## 验证与取证

```
npm run build                 # ⚠️ today:ui 读 dist —— 改界面文案后**必须先 build**
npm run today:ui              # 250 PASS / SMOKE: ALL PASS
npm run vue-tsc -- --noEmit   # 无输出
npm run verify / verify:docs
```

**再踩一次的旧坑**：改完 `ReconPanel.vue` 的「第 3 步」直接跑 `today:ui`，红在
`FAILED 厂家账清零时给空态…`，报告里显示的还是「第 4 步」—— 因为 `dist` 里是旧产物。
源码已经是「第 3 步」（`grep -n "第 [0-9] 步" src/modules/today/tabs/ReconPanel.vue` 可证）。
**判据：`*:ui` 类门禁读 `dist`，改界面必须先 `npm run build`，否则红的可能是自己的缓存。**

## 边界（本轮**没有**做完的事）

- **`ui-plugins/ae-profit` 的岛内文案已改（`AeProfitView.vue` 的 tip-card）但没发版**：
  已装旧岛的机器上仍显示「算钱」。要让这行字到用户手里得走发布四步
  （打包 → `market-out/` commit → `publish-plugin.js` → 安装），见
  `docs/notes/2026-09-30-island-publish-runbook.md`。`manifest.json` 的 `description` **故意没动**
  （同版本改内容会被发布口判成硬错误，见"版本号是唯一更新信号"那条纪律）。
- 历史笔记里写「五步」「六页签」的（`2026-10-05-shipping-console-tabs.md`、
  `2026-10-10-picking-merged-into-purchase.md` 等）**不回填**：它们记录的是当时的形态，
  本条是它们之后的下一次顺位。要查当前形态看 `docs/baseline/PROJECT_BASELINE.md`。
