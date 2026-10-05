# 「看到问题」和「能解决问题」必须在同一个控件上：另两类复杂度来源

**结论**

接续 `2026-10-01-simplify-ui-evidence-first.md`（四类来源）。本轮对「算钱」盘点又认领出**两类**独立来源，与前四类并列：

| 复杂度来源 | 判据（怎么当场认出来） | 改法 |
| --- | --- | --- |
| **提示不是入口** | 一个字面提示（"未归属 N 单"/"平台费未扣"）告诉用户**有问题**，但**处理它的动作在别处**（藏在"更多"里） | 把它做成**按钮**：点了**自动展开**那片区域**并聚焦到对应控件**。提示的价值 = 把"看见"和"去处理"缝成一步 |
| **"全零"不是正确表达** | 一行 N 个 `缺X 0`：数据齐全时用户得**逐个读完 N 个零**才知道"都齐了" | 只在**非零**时列；全零时渲染**一句**"没有缺项"。这一行的目的是"哪里缺"，不是"每个都不缺" |

**两条硬约束**（本轮踩过）

1. **"提示变入口"只改可达性、不改语义**。顺带发现一个作用域陷阱：「归到该店」送出的是**当前列表里全部订单号**（不只未归属的那几单），界面上一个字都没说 —— 用户会以为只处理那几单。**先补一句作用域说明**，但**不改行为**（"是否该只处理未归属单"是产品决策，不该由 UI 简化顺手改掉）。
2. **生造词/行话只出现在用户可见面就要换掉**，别按全仓 `grep` 判：本轮换掉「算齐」→「各环齐全」、「轨」→「毛利依据」；但代码注释里的同款词**刻意保留**（避免无谓 churn）。
3. **"全零"收敛出来的那句话，作用域必须与它所在的那一行一致**（本轮自己踩到并修掉）：把 8 个 `缺X 0` 收敛成「没有缺项」后，同一行里还有一项全局标志 `platformFeeMissing`（未配平台费率，`src/lib/orderCost.ts` 有意做成**全局标志**而非逐行缺口）⇒ 未配费率时会出现「没有缺项」与「平台费未扣」**并存**，读起来是"什么都不缺、但这个缺着"。修法：`v-else-if="!summary.platformFeeMissing"` —— **一句话的断言不能只覆盖它旁边的一部分**。

**取证**（可复现）

- **提示不是入口**：`src/modules/order-cost/OrderCostView.vue` ——
  - 「未归属 N 单」原为 `<span data-act="unassigned-hint">`（点了没反应）→ 改 `<button>` 文案补「· 去归属」，`@click="openMore('shop')"`。
  - 「平台费未扣」原为只读 `<span class="wb-tag">` → 改 `<button data-act="fee-missing">` 文案补「· 去配费率」，`@click="openMore('rate')"`。
  - `openMore(focus: 'shop' | 'rate')`：`showMore=true` → `nextTick` 里 `ref.focus()` + `scrollIntoView({ block: 'nearest' })`。新增 `.wb-btn--warn`（`src/styles/index.css`，与 `.wb-tag.is-warn` 同角色）供这类"这是待办"的按钮用。
- **全零收敛**：`activeGaps = computed(() => gapList.value.filter(g => g.count > 0))`；模板 `v-if="activeGaps.length"` 否则渲染 `<span data-act="gaps-none">没有缺项</span>`（**`v-else-if="!summary.platformFeeMissing"`** —— 见硬约束 3）。逐项带 `data-act="gap-<key>"`。
- **两个入口按钮改名**：「更多」→「费率与归属」（"更多"等于没说：用户得先点开才知道值不值得点）。

**冒烟同步**：`scripts/order-profit-ui-smoke.mjs`

- 指标条断言从「`.oc-topbar` 整段 `textContent`」升级为**按 `data-act` 逐元素断言**（`metric-rows|metric-complete|metric-revenue|metric-gross`）。
- 缺口行判据：全齐 → **无任何 `gap-*` chip**；未配费率 → **不出现**「没有缺项」；配好费率 → **才出现**「没有缺项」；有缺 → 逐项按锚点出现。
- **补此前零覆盖的路径**：点页头「未归属」→「费率与归属」**展开且店铺下拉获得焦点** → 再走该分支原有断言。

**变异复核**（用例全绿 ≠ 守卫有效；四组都确认能变红，之后复原）

| 变异 | 预期变红 | 实际 |
| --- | --- | --- |
| `activeGaps` 退回"全量"（8 个全渲染） | 三条缺口断言 | ✅ `none=false chips=8`（三条同时红） |
| `openMore` 去掉聚焦 | 「未归属 → 聚焦店铺」路径 | ✅ `SMOKE: FAILED at [shop] - timeout` |
| 明细列头改回「轨」 | 列头断言 | ✅ FAIL |
| 「没有缺项」条件退回 `v-else` | 「未配费率时不谎报整行齐全」 | ✅ `none=true fee-missing=true`（正是矛盾态） |

**没动的**：数据层、能力域、IPC 通道、算账口径（`src/lib/orderCost.ts`）。

> ⚠️ **一条打断过的命令留下的教训**：这轮收口时，`vitest`/`verify:docs` 的整条链在一次 shell 会话里被打断，恢复后**不能假设"跑过了"** —— 必须从头再跑一遍并看退出码。门禁的价值在"最近一次实跑"。另：`grep -c "a\|b"` 这类 BSD BRE 交替静默返回 0（本轮又在找术语时中招），一律用 `grep -E` 或 Grep 工具。
