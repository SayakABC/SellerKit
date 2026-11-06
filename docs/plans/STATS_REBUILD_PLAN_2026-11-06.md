# 统计页重做 · 实施方案与分阶段计划 v1

> 日期：2026-11-06 ｜ 对象：`src/modules/order-cost`（模块 id 不变，显示名仍为「统计」）
> 上游：[`ANALYTICS_UI_PROPOSAL_2026-11-04.md`](ANALYTICS_UI_PROPOSAL_2026-11-04.md)（视觉 / IA 目标态，方案稿，未改代码）
> 本文定位：**落地承接，不是第二份设计方案**。裁决用户三项决策、暴露两份数据盘点的冲突、给出 P0–P3 可施工任务书。
> 状态：方案定稿 · **P0 同批落地**（实施记录见 §10）

---

## 0. 一句话结论

**先把"这批数能不能信"做成一等公民，再谈图表。**

P0 不动计算层、不新开 IPC、不改 schema、不改模块 id、不改名、不拆既有 DOM ——
只在既有页面上「只增不改」地加一层口径门禁，并修掉"默认只算最近 500 行"这个静默截断。
11-04 方案的完整 IA（四页签 / 八个子组件 / 四个新 IPC / 两个 schema 变更）留到 P3 评估，不在本轮动。

理由不是保守，是取证：`src/lib/orderCost.ts` 已经有 6 个分组维度、月/日趋势、10 类逐行缺口、
`precise/forecast` 双轨、按店营收汇总；现有页面也已经有指标条、可点缺口筛子、分组表、趋势表、14 列明细表。
**缺的不是指标，是"能不能用这批数做决定"这句话没有被说出来。**

---

## 1. 用户三项决策（2026-11-06 确认，本轮据此施工）

| # | 决策 | 取值 | 落到代码 | 后果 |
|---|---|---|---|---|
| D-1 | 默认时间范围 | **全部订单** | 不新增时间窗筛选；`limit` 默认值 `500 → 2000`（主进程硬上限）；到上限时显式提示 | 消除"默认最近 500 行"的静默少算 |
| D-2 | 趋势口径 | **按下单日** | `trendOf` 已按 `dateKey(r.orderTime)` 归档 ⇒ **不改算法**；在口径条显式写出 | 美式 / 中式日期由 `dateKey` 归一；认不出的进 `(无日期)` 桶且排最后 |
| D-3 | 交付节奏 | **先方案+计划，再按计划落地** | 本文 + P0 同批；P0 门禁全绿后停下验收，确认后再进 P1 | 每阶段全绿才进下一阶段，不做一次性全量重写 |

> D-1 的实质不是"加一个时间选择器"，而是**不许静默截断**。2000 是宿主 `shippingRows` 的物理上限，
> 不是"全部"的同义词：到了上限必须在界面上说出来（与「待补清单」§5 的口径边界同一条纪律）。

---

## 2. 与 11-04 方案的关系（不重开已定的口子）

### 2.1 继承的六条原则（原文 §3 / §11，逐条照办）

1. 先可信再好看：数字旁边有口径与分母。
2. 缺就写 `—`，不写 0。
3. **三本账只并排不相加**：预测 / 结算 / 现金各自成块。
4. 一处发声：同屏只有异常用警示色，覆盖率不足用灰 + 文字。
5. 稀疏不连线、能力降级而非空卡。
6. 不加颜色、不加字号档位、不引第三方图表库（全部手写 SVG）。

### 2.2 分期映射（两套编号并存时以本表对齐）

| 11-04 方案 | 本文 | 内容 |
|---|---|---|
| P1（A 档：体检 / 资金卡 / 商品缺口 / 待发计数） | **P0 + P1** | P0 先做口径门禁与双轨分列；P1 做钻取链与跳补 |
| P2（趋势 / 排行 / 款级毛利，需 `order_date` + ≥30 单） | **P2** | 拆解视图 + 纯 SVG，样本不达标自动降级 |
| P3（结算导入后的净收入 / 退款率 / 利润桥） | **P3** | 跨域对账；届时一并评估是否切换四页签与改名 |
| P4（采购缺口 / 导出 / 删旧页） | **P3 尾** | 与旧页退役合并评估 |

### 2.3 三处冲突，必须记录在案

1. **数据盘点对不上**：11-04 方案基于「5 单 / 0 结算 / 21 款 481 变体」；本轮取证基于
   `../notes/2026-10-30-db-schema-and-migration.md` §20 的 2026-10-29 快照
   「70 单 / 75 明细 / 24 结算 / 19 款 / 457 SKU / `parcels` 0 行 / `bk_entries` 307 行」。
   且**本机 `~/Library/Application Support/seller-kit/sellerkit.db` 不存在**，无法现测。
   ⇒ 两份盘点来自不同时间 / 不同库，**阈值判定必须以落地前的 `mode=ro` 现测为准**，不把任何一方写死进方案。
2. **分期编号不同**：11-04 用 P1–P4，本文用 P0–P3，映射见 §2.2。
3. **改名未确认**：11-04 §4.1 建议「统计」→「经营分析」。用户本轮未提改名
   ⇒ **`meta.name` 保持「统计」**，`order-cost` id 不动（深链 / 冒烟锚点 / 存储命名空间全靠它）。

### 2.4 本轮明确不采用 11-04 的哪些部分

| 不采用 | 原因 |
|---|---|
| 新建主进程 analytics handler 模块 + 4 条 IPC | P0 无需新取数；新通道要同步 preload / `types.ts` / `ipc.ts` / host 四处，收益为零 |
| 新建 `AnalyticsView.vue` + 8 个子组件替换旧页 | 会一次性拆掉 86 条冒烟断言依赖的 DOM 契约；留到 P3 整体评估 |
| `oi_orders.order_date` 迁移 | D-2 已由 `dateKey` 满足，P0 不改 schema |
| `bk_categories.pnl_role` 迁移 | 属 P3 资金页前置，本轮不碰账本 |
| 四页签 IA + 下划线页签 | 现有 `wb-seg` 是"同一份数据的互斥视图"，切四页签要先有四张事实表 |

---

## 3. 现状取证（本轮实读，全部带 `文件:行`）

| 事实 | 位置 | 对施工的约束 |
|---|---|---|
| `trendOf` 按 `orderTime` + `dateKey` 归档，关闭单排除，无日期单列 | `src/lib/orderCost.ts:745` / `:569` / `:774` | D-2 零算法改动 |
| `OrderCostSummary` 的金额字段**同口径**（只含非关闭单） | `src/lib/orderCost.ts:414` | 新增区块不得引入第二套合计 |
| 10 类逐行 `gaps` + `gapCounts` | `OrderCostView.vue:672` / `orderCost.ts:447` | 可信度层直接复用，不重算 |
| `preciseRows` / `preciseGross` 已有 | `OrderCostView.vue:1017` | 双轨分列只补"预测轨"那一半 |
| `limit = ref(500)`，选项 100 / 500 / 1000 | `OrderCostView.vue:662` / `:180` | D-1 的真缺口 |
| 主进程上限 `Math.min(..., 2000)` | `electron/order-db.ts:4681` | "全部"的物理边界 |
| `goImport()` 用 `switchModule('today')` | `OrderCostView.vue:1094` | 跳补沿用同一协议 |
| 「待补清单」的 kind id = `health` | `src/modules/shop-accounts/MasterDataView.vue:156` | 跳补落点，`switchModule('shop-accounts', 'health')` |
| 冒烟硬断言 `last.limit === 500` | `scripts/order-profit-ui-smoke.mjs:388` | 改默认必须同步改此条 |
| 冒烟按 `.oc-topbar` / `.oc-gaps` 整段 `textContent` 与 `data-act` 取用 | 同文件 `:322` / `:348` / `:354` / `:594` | **P0 只增不改**：新区块放既有容器之外 |
| 假桥记录 `window.__navs`（`switch-module` 事件） | 同文件 `:244` | 跳补断言可直接复用，零新桩 |
| 无任何图表库 | `package.json` | 纯 SVG / CSS，零新依赖 |
| 「待补清单」已登记为合法入口名 | `tests/uxEntryNames.spec.ts:265` | 文案写「去「基础数据 › 待补清单」」可通过悬空名守卫 |

---

## 4. 目标信息架构（承接 11-04 §4，分两步到达）

**P0–P2：在现有单页内演进**（本轮与下一阶段）

```
页头（不动）
├ 指标条 .oc-topbar（不动 · 5 个数同口径）
├ 体检行 .oc-health / .oc-gaps（不动 · 缺口即筛子）
├ ★ 新增：口径门禁 .oc-trust          ← P0
│   · 成熟度徽标（可信 / 预测为主 / 数据不全）
│   · 精准轨 / 预测轨 并排分列，不相加
│   · 结算覆盖率条 + 口径行（全部订单 · 按下单日 · 只含非关闭单）
│   · 到上限提示（条件渲染）
│   · 唯一实心主按钮 → 去「基础数据 › 待补清单」
├ .oc-scope（不动）
├ 分组统计 / 趋势（P1 加下钻，P2 加纯 SVG 结构条）
└ 14 列明细表（P1 承接筛选链与钻取）
```

**P3：再评估是否切到 11-04 的四页签**（经营总览 / 店铺经营 / 商品表现 / 资金与履约）。
切换前提：四个事实表的取数口都已存在，且旧页退役有独立冒烟迁移方案。

---

## 5. 分阶段施工计划

### P0 · 口径门禁（本轮执行）

| 项 | 内容 |
|---|---|
| 改动文件 | `src/modules/order-cost/OrderCostView.vue`、`scripts/order-profit-ui-smoke.mjs`、`CHANGELOG.md`、`docs/notes/`、`docs/README.md` |
| 不动 | `src/lib/orderCost.ts`、`electron/**`、`preload.ts`、`src/types.ts`、`src/core/services/ipc.ts`、`meta.ts`、既有 `data-act` |
| 任务 | ① `limit` 默认 2000 + 新增「全部（最多 2000 行）」选项 ② 到上限显式提示 ③ 口径行写死「全部订单 · 按下单日 · 只含非关闭单」 ④ 精准/预测双轨分列 + 结算覆盖率 ⑤ 成熟度徽标（文字 + 形状，不靠颜色） ⑥ 缺口跳补一个入口 →「待补清单」 |
| 验收判据 | 见 §5.1 |
| 门禁 | 见 §8 |
| 明确不做 | 不改算法、不新开 IPC、不改 schema、不改模块名、不拆 `.wb-metric` DOM、不引图表库、不在统计页做录入 |

#### 5.1 P0 验收判据（可量、可变异）

| # | 判据 | 断言方式 |
|---|---|---|
| 1 | 默认取全部 | `orderShippingRows` 首次调用 `limit === 2000` |
| 2 | 到上限不静默 | 返回行数 == 上限时，页面出现「已到上限」；未到时不出现（零的正确表达是不出现） |
| 3 | 双轨不相加 | 「精准」与「预测」各在独立元素，页面内不存在同时含两轨金额的合计节点 |
| 4 | 覆盖率不是常数 | `覆盖率条宽度 = round(coverage × 100)%`，样本有结算 / 无结算时宽度不同 |
| 5 | 缺写 `—` | 精准轨 0 行时金额显示 `—`，不匹配 `^0(\.0+)?$` |
| 6 | 口径可见 | 口径行含「全部订单」「按下单日」「只含非关闭单」 |
| 7 | 跳补真发生 | 点主按钮 → `window.__navs` 末条 `moduleId === 'shop-accounts' && action === 'health'` |
| 8 | 旧断言不回退 | 既有 86 条全绿（含 `metric-complete` 不再出现、`gap-filter` 可撤等） |

**变异点（改坏必须红）**：① 默认退回 500；② 到上限不提示；③ 两轨金额相加；④ 覆盖率恒 100；
⑤ 精准 0 行显示 `0.00`；⑥ 跳补改成无 action。

### P1 · 钻取链（待 P0 验收后开工）

- 导出 `costGroupKey(row, dim)`，把 `summarizeOrderCosts` 的 `keyOf` 提成唯一实现
  （这项欠账记在 `../notes/2026-10-30-cost-maintenance-and-retire.md` §13）。
- 数字 → 构成它的行（含"哪些因缺口被排除"）→ 具体行 → 跳到能补的那一页。
- 全局筛选链（时间 / 店铺 / 款 / 缺口 / 轨道）共用一份 `summary.rows`，不各算一遍。
- 表格收束行 + `useRowNav` 键盘动线。
- 验收：点统计表某行 → 明细表只剩该组的行，且数字与汇总表同源（变异：`keyOf` 与下钻各算一遍 ⇒ 红）。

### P2 · 拆解视图（待 P1 验收后开工）

- 六维切换（复用 `CostGroupDim`）、相对横条、成本结构堆叠条，全部纯 SVG / CSS。
- 样本阈值沿用 11-04 §7：**订单 ≥ 30 单才出毛利率结论、成本覆盖 ≥ 90% 才出款级毛利、结算 ≥ 50 单才出退款率**。
  不达标时降级为「清单 + 覆盖单数」，不出排行榜 / 不做 ABC 分级。
- 稀疏不连线：趋势数据点 < 7 时只画孤点。
- 验收：改样本量跨过阈值时，排行榜出现 / 收起；`—` 不被写成 0。

### P3 · 跨域对账 + IA 评估（待 P2 验收后开工）

- 统计侧（订单毛利，权责/预测）与记账侧（`summarizeRevenueByShop`）并列展示，**禁止相减**。
- 评估 11-04 的两项 schema 前置（`order_date` / `pnl_role`）、四页签 IA、改名、旧页退役与冒烟迁移。
- 不在统计页做发货 / 认款 / 改价（各域自己的页面才是写入方）。

---

## 6. 口径与红线

1. **每个数字只能有一处实现**：新增区块只读 `summary`，不另写 SUM / 不另写 COUNT。
2. **三本账不相加**：预测 / 结算 / 现金并列，不允许出现跨口径合计。
3. **零 ≠ 缺**：缺失记 `—` 并给出口，0 是一个结论。
4. **入口唯一**：缺口跳补只给一个按钮去「待补清单」，不在统计页复制六套跨模块跳转。
5. **提示变入口**：所有"缺 X"必须能点，且点了要有可观测后果（事件 / 筛选）。
6. **同屏并列的数必须同口径**：新区块的"全部订单行数"与指标条的"订单行 N"若不同，必须写明差异。
7. **冒烟契约**：既有 `data-act` 一个不改、一个不删；新增锚点单独命名。
8. **不新增颜色 / 字号令牌**，沿用 `--wb-*`；一屏只有一个实心主按钮。
9. **样本不足不硬解读**：不做同比环比、复购 / RFM / 同期群、销量预测、智能选品建议。

---

## 7. 明确不做

- 同比环比 / 复购 / RFM / 同期群 / 销量预测 / 「哪款值得加大投放」类因果结论（样本与因果链都不成立）。
- 多屏 BI 大屏、12 个 KPI 平铺、饼图做科目结构。
- 单一「总利润」大卡（三本账不可相加）。
- 在统计页做录入（入口唯一，主数据维护归「基础数据」）。
- 本轮不引入任何第三方图表库、不新增 IPC 通道、不做数据库迁移、不改模块显示名。

---

## 8. 门禁（每阶段逐条单看退出码，不许跳过）

```bash
cd /Users/ck/work/ai/SellerKit
npx tsc -p tsconfig.electron.json --noEmit
npx vue-tsc --noEmit
npm run verify
npm run verify:docs
npm run build
npx vitest run
npm run order-profit:ui
```

> `npm run build` 不含 `vue-tsc`；改了渲染层跨层参数必须单独跑第二条。
> 改主进程先 `tsc`、改界面先 `build`，否则 `order-profit:ui` 跑的是旧产物。
> `order-profit:ui` 依赖 `/Applications/Google Chrome.app` 与新鲜的 `dist/renderer/index.html`（本轮已确认两者都在）。

收工两件事（AGENTS §0）：`CHANGELOG.md` 的 `[Unreleased]` 记「做了什么」；
`docs/notes/` 记跨工具结论并在 `docs/notes/README.md` 索引登记一行。

---

## 9. P0 之后待确认（不阻塞本轮）

| 编号 | 决策点 | 建议 |
|---|---|---|
| D-4 | 是否把显示名改成「经营分析」 | 暂不改；等 P3 切四页签时一起改，避免用户两次适应 |
| D-5 | 是否做 `oi_orders.order_date` 迁移 | P0 不需要；若 P3 要做长区间筛选 / 高性能趋势再做，先补美式日期归一取证 |
| D-6 | 是否按 11-04 §10 新开 4 条 analytics IPC | P3 评估；P0–P2 全部复用既有取数口 |
| D-7 | 真实库现测结果以哪份盘点为准 | 落地前 `mode=ro` 现测，阈值按现测值配置，不写死 |

---

## 10. 实施记录（P0 · 2026-11-06）

> 状态：**P0 已落地并验收，停下等用户确认再进 P1**。P1–P3 一行代码未动。

### 10.1 改动文件（5 个，含新建 2 个）

| 文件 | 改动 | 为什么 |
|---|---|---|
| `docs/plans/STATS_REBUILD_PLAN_2026-11-06.md` | 新建 | 本文；先出方案+计划再落地（D-3） |
| `src/lib/orderCost.ts` | +50：新增 `TrustSummary` / `trustSummary(rows)` | 只数「可信度」行数，**刻意不返回任何金额** —— 金额仍只来自 `OrderCostSummary` 一处实现 |
| `tests/trustSummary.spec.ts` | 新建，6 用例 | 含一条结构反向守卫：断言返回键里没有任何金额字段 |
| `src/modules/order-cost/OrderCostView.vue` | +239 / −7：`limit` 默认 500→2000、`.oc-trust` 口径门禁区块、`onLimitChange` / `goHealth`、常驻行数档位 select、scoped 样式 | 只增不改既有 DOM 锚点；旧冒烟契约 `.oc-topbar` / `.oc-gaps` / `data-act` 一个没动 |
| `scripts/order-profit-ui-smoke.mjs` | +118 / −5：新增 `trust` 段 12 条断言、夹具 `__capRows`、两条旧断言升级 | 见 §10.2 / §10.3 |

三处关键实现：

```ts
// src/modules/order-cost/OrderCostView.vue
const limit = ref(2000);                       // D-1：默认全部（宿主 shippingRows 物理上限）
const trust = computed(() => trustSummary(summary.value.rows));
const rowLimitHit = computed(
  () => rawRowCount.value > 0 && rawRowCount.value >= limit.value,  // 到上限必须说出来
);
function onLimitChange(event: Event): void {  // 显式读事件目标，不信 v-model 的映射结果
  const el = event.target as HTMLSelectElement | null;
  const n = Number(el?.value);
  if (!el || !Number.isFinite(n) || n < 1) return;
  limit.value = Math.min(Math.max(Math.round(n), 1), 2000);
  void nextTick(() => { void load(); });
}
function goHealth(): void { switchModule('shop-accounts', 'health'); }  // 入口唯一
```

- **D-2 未改算法**：`trendOf` 原本就按 `dateKey(r.orderTime)` 归档（`src/lib/orderCost.ts`），本轮只在口径条写出「按下单日」。
- **口径行**写死「全部订单 · 按下单日 · 只含非关闭单」，并带估算运费行数 / 平台费扣没扣。
- **成熟度徽标**：有缺口或平台费未扣 → 「这批数还不能拿去结算」；覆盖率 < 50% → 「预测为主」；否则「数据基本齐全」。用**虚线边框**区分 warn / ok，不靠颜色编码。

### 10.2 新增断言（`npm run order-profit:ui` 共 103 条 PASS，`SMOKE: ALL PASS`）

`trust` 段 12 条，逐条都有可验算的后果，不是「有内容/大于 0」：

1. 口径门禁区块存在；
2. 口径行写明「全部订单 / 按下单日 / 只含非关闭单」；
3. 精准 / 预测两轨并列且明确写「不相加」；
4. 无结算样本时覆盖率 **0%**，且进度条宽度 `0%` 与文本同源（不是恒 100）；
5. 不到上限时**不渲染** `.oc-trust__limit`（零的正确表达是不出现）；
6. 行数档位 select 存在且默认 2000；
7. 首次取数 payload `{"limit":2000}`（不是 500）；
8. 改成 100 行档 → 真的按 `{"limit":100}` 重取（钉住「select 没接 change」这个静默失效）；
9. 到上限提示写明「本次取到 100 行，已达上限 100 行」；
10. **反向守卫**：非法档位一次都不许取数（见 §10.3）；
11. 改回 2000 后提示消失（状态可撤）；
12. 跳补按钮真的派发 `switch-module → shop-accounts / health`（临时接管 `window.dispatchEvent` 抓 detail，不让外壳真的切页）。

另修改两条旧断言：
- `刷新真的重新取数` 的期望 `limit` 由 500 改 2000；
- `克重按款色码批量取` 由 `=== 1`（赌「刷新还在半路」的时序巧合）升级为**每次取数各一次 `productList` / `productVariantList`，1:1 配平**——比原来更严，且不受前面多了几次刷新影响。

### 10.3 本轮踩到并修掉的三个坑（结论已并入 `docs/notes/`）

1. **`v-model.number` + 无匹配 option ⇒ 静默回落 500 行**。冒烟最初写 `limSel.value = '1'`，但 select 里根本没有 `1` 这个 option；Vue 的 `vModelSelect` 取「被选中 option 的 `_value`」，无选中项时把 `limit` 写成 `undefined` ⇒ payload 变 `{}` ⇒ 宿主 preload 对非 number 的 `limit` **静默回落 500**（`electron/preload.ts:479-484`）。用户会看到「选了新档位，数字却按 500 行算」且一声不响。修法：`onLimitChange(event)` 显式读 `event.target.value`、判合法、夹到 `[1,2000]` 才落值并 `load()`；非法档位直接不取数。
2. **夹具不能制造用户到不了的 UI 状态**。改用真实存在的 100 行 option，并让假桥 `__capRows` 模拟「库里有 100+ 行、宿主按 `limit` 截断返回」——复刻到结构层，1 行样本才第一次真的撞到上限。
3. **`row-limit` 控件一开始放在默认收起的 `.oc-more` 里** ⇒ 冒烟拿不到节点（`(missing)`）。它是「会改数字的开关」，按既有信息架构应常驻 `.oc-scope`，已搬回。

补充：本机 `node_modules` 只带 ARM 版 `rolldown` / `lightningcss` binding，而机器是 `darwin x64`，导致 `vitest` / `build` 起不来。用 `npm pack` + 解压对应 x64 原生包补进 `node_modules` 临时修好，**`package.json` / `package-lock.json` 未改**，属本机环境前置，不是代码变更。

### 10.4 门禁逐条退出码

| 门禁 | 退出码 / 结果 |
|---|---|
| `npx tsc -p tsconfig.electron.json --noEmit` | 0 |
| `npx vue-tsc --noEmit` | 0 |
| `npm run verify` | 0 |
| `npm run verify:docs` | 0（文档收工后已复跑，✅ 无悬空引用） |
| `npm run build` | 0 |
| `npx vitest run` | 0 · **80 文件 / 1542 用例** |
| `npm run order-profit:ui` | 0 · **103 条 PASS / `SMOKE: ALL PASS`** |
| `npm run master-data:ui` | 0 |
| `npm run today:ui` | 0 |
| `npm run shipping-rate:ui` | 0 |
| `npm run goods:ui` | **1 · 与本轮无关的存量红**（见 §10.5） |
| `npm run plugins:island:smoke` | **1 · 环境前置未满足**（见 §10.5） |

### 10.5 两处非本轮红灯（如实记录，不擅自改别人的断言）

- `goods:ui`：三遍里「默认窗口可达性」「窄视口 + 空态」两遍 `ALL PASS`，仅**宽视口**第 193 行一条红：
  `FAIL 产品管理（原「货品档案」）这一组是两条页签：款与商品 / 供应商 | 款与商品/颜色/供应商2`。
  断言写于 2026-10-22（进价页退役后剩两类资料），而当前实际页签已是三条（多了「颜色」）⇒ **存量陈旧断言**。
  本轮 `git diff --name-only HEAD` 只有 `scripts/order-profit-ui-smoke.mjs`、`src/lib/orderCost.ts`、
  `src/modules/order-cost/OrderCostView.vue` 三个跟踪文件，`src/modules/goods/` 与导航相关文件改动数为 **0**，
  故与本轮无关；未顺手改它，等该模块负责人按新 IA 判定后一起修。
- `plugins:island:smoke`：按 `docs/notes/2026-10-20-engineering-hard-laws.md` §门禁要求起了 vite dev server 并带
  `--no-sandbox --disable-gpu`，但本机 `~/Library/Application Support/seller-kit/plugins` **没装任何 `kind:"ui"` 的岛**，
  脚本在「先安装一个岛再跑冒烟」处退出。属环境前置，不是失败结论。

### 10.6 遗留 / 下一步

- **P0 到此为止，等用户验收**；确认后再按 §5 从 P1（钻取链：导出 `costGroupKey`、统计表行点进去筛明细）开工。
- 真实库（`~/Library/Application Support/seller-kit/sellerkit.db`）本机不存在，本轮全部结论基于仓库权威快照与假桥；
  上线前仍需 `mode=ro` 现测（§9 的 D-7）。
- 「全部」= `limit=2000` 是宿主物理上限，不是无限；到上限的提示已经补上，但**真正消除截断**要等 P3 评估分页/聚合口。
