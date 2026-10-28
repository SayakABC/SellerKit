# 「基础数据」二级菜单再收拢：七项并列 → 三组 + 组内页签

**结论**（2026-10-17 晚间，用户口径「① 店铺登记、企业收拢到店铺账号中；② 成本与费率、供应商收拢到货品档案中」）

侧栏二级菜单从**七个并列项**收到**三项**；项内的资料页改由内容区顶部一条页签条切换。

> ⚠️ 同日晚间二次修复：组 id 与 kind id 撞车导致组内第一页页签点不动，已拆
> `selectGroup` / `selectKind` 两个入口（见下文「组 id 与 kind id 撞车」节）。

| 侧栏（组） | 组内页签（资料页）               | 锚点                                        |
| ---------- | -------------------------------- | ------------------------------------------- |
| 店铺账号   | 账号库 / 店铺登记 / 企业         | 侧栏 `data-act="kind-accounts"`             |
| 货品档案   | 建档与关联 / 成本 / 供应商       | 侧栏 `data-act="kind-goods"`                |
| 物流运费   | （单页，**不画**页签条）         | 侧栏 `data-act="kind-shipping"`             |

组内页签统一 `data-act="kind-tab-<kindId>"`（`accounts` / `registry` / `companies` / `goods` / `cost` / `suppliers` / `shipping`）。

---

## 为什么这么收

七项不是"同一层级的七件事"，而是**两簇加一个单独**：凡"这家店 / 这家公司"归店铺，
凡"这款货 / 用哪家厂 / 多少钱拿"归货品，物流运费自成一条动线。平铺的代价不是"多两行"，
而是每次记一家供应商都要在七个名字里找"该点哪个"——同一件事的归属信息被结构丢掉了。

判据与 2026-10-14 整合同向：**同一件事只留一个入口**。收进组内页签 = 在结构上表达归属，
且不新增一层导航（侧栏仍是"一级项 + 二级项"两层）。

## 三条实现约束（改结构的人必须知道）

1. **七个 kind id 与 `store.mainTab` 的持久化值一个没改**。它们是两个跨会话协议的键：
   用户本地偏好（`modules.shop-accounts.mainTab`）与 `switch-module` 的 `action`
   （`registry` / `cost` / `suppliers` …）。改 id = 老用户醒来落到不存在的项 + 所有跨模块跳转
   "点了没反应"。收拢只动**呈现层**。
2. **两套锚点，刻意不重名**：侧栏组走 `kind-<groupId>`（AppShell 生成），组内页签走
   `kind-tab-<kindId>`（`MasterDataView` 生成）。若两边都叫 `kind-accounts`，
   `querySelector` 会抓到第一个 —— 冒烟脚本会**静默失配**（找不到元素就跳过，看着是绿的）。
3. **单页组不画页签条**：物流运费只有一页，画一条只有一个格子的页签条既是噪音，也让人以为还有别的页。

## ⭐⭐ 组 id 与 kind id 撞车：两个入口必须分函数（当晚 bug，已修）

组 id 与 kind id 有**两个字面量撞车**：组 `accounts` ⇄ kind `accounts`、组 `goods` ⇄ kind
`goods`。收拢第一版的 `selectKind(id)` 一个函数先查组表再接 kind 表 ⇒ 在组内点**第一页页签**
（「账号库」/「建档与关联」）被解释成"点组名"，命中"已在这组"的早退 ⇒ **页面什么都不发生**
（无报错、无变化）。用户口径即「店铺账号和货品档案中切换 tab 不正常」。

修法：入口按**来源**拆函数，两种 id **不许互相解释**：

| 入口 | id 语义 | 函数 | 行为 |
| ---- | ------- | ---- | ---- |
| 侧栏二级菜单 | 组 id | `selectGroup()` | 已在这组保持当前页；否则落组内第一页 |
| 组内页签 | kind id | `selectKind()` | 直接切（体内不出现 `GROUPS`） |
| `switch-module` action | 两种都可能 | `applySwitchAction()` | 先按 kind 解、落空再按组解（`accounts`/`goods` 两种解释同页，顺序不影响现有跳转） |

**为什么旧冒烟全绿也盖不住**：`gotoKind` 的走法是"先点侧栏组、再点页签"——点组那一步在
同组时是 no-op，页签点的又从来不是第一页（默认就在第一页）⇒ 唯一能触发的路径被绕开。
回归断言必须**单独走页签**：停在「企业」点「账号库」、停在「成本与费率」点「建档与关联」。

## 「货品档案」的页签条交给外层画

`GoodsView` 自己那条 `.gd-tabs` 在 embedded 形态下**不再渲染**（新 prop `hideTabs`），
否则屏幕上会出现两条并排的页签条（一条属于"页"、一条属于"组"），用户分不清哪条是"我在哪一层"。

- 只在**页签数 ≤ 1** 时才允许隐藏：`GOODS_LAYOUT` 回退成 `'tabs'` 时页签是 2~3 个，
  藏掉它们等于把产品表与映射队列的入口抹掉，"改一个常量回退"就成了一句假话；
- 隐藏后 `.gd-tabs` 的 `margin-bottom: -16px`（吃掉 `.wb-page` 的 gap）也不再生效，
  页头与内容区之间仍是 16px —— 不需要补样式。

## 徽标：只在组上挂一个，且**不做相加**

组上有待办（未归一店名 / 缺进价）就用待办色报**那个数**；没有待办时才报"这类有多少"
（仅店铺账号）；读不到数就不画（不拿 0 冒充"没有"）。

**别把组内各项的数加起来**：账号套数 + 待登记店名 + 企业数相加没有任何含义。
逐项的数仍在组内页签上（`MasterDataView` 的 `.md-tab__count`），位置从侧栏下移一层而已。

## 守卫对策（这轮真正值钱的部分）

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

锚点迁移的落点（三处冒烟）：`kind-<kindId>` → **`kind-tab-<kindId>`**；`clickText('.gd-tabs .gd-tab', …)`
→ `.md-tabs .md-tab`；`kindActive(id)` 改为优先取 `kind-tab-<id>`（单页组回落侧栏那一行）。

## 踩坑

- ⭐ **组页签的文本里带徽标数字**：`mapFlat('.md-tabs .md-tab')` 拼出来是
  `建档与关联/成本与费率1/供应商2`，与「三条页签」做**字符串全等**会直接红（首跑就是这样红的）。
  判断签"是哪几条"要查 `data-act` 锚点（稳定），判高亮查 `.is-active` 那一格的**开头**。
- ⭐⭐ 注入脚本（`ASSERT_SCRIPT` 模板串）的**注释里也不能有反引号** —— 本轮又踩两次：
  一次写成 `` `MasterDataView.vue` `` 让模板串提前闭合（`node --check` 直接报
  `Unexpected identifier`），另一次在 `goods-ui-smoke` 里连踩四行。改完必须 `node --check`
  **并且实跑**（`node --check` 只看外层文件，注入串里的语法错误只在页面里炸）。

## 取证

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
