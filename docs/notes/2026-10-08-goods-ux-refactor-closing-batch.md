# 「货与成本」收尾批 + 简洁模式：把两条"空转断言"揪出来

**结论**：`docs/reviews/UX_GOODS_NOVICE_2026-10-08.md` §4 里 R0–R3 之外剩下的条目（P0-5 左半 / P1-2 /
P1-4 / P1-5 / P2-1 / P2-2 / P2-3）全部落地，外加报告建议的 **P1-1 简洁模式**（默认开、页头一键关）。
净效果：`goods:ui` **180 → 203 项**（全量 181 + 默认窗口可达性 11 + 窄视口 11），
`vitest` **36 文件 / 593 用例**，其余门禁零变化（**零 IPC 改动**）。

本轮真正的收获不在功能，而在**两条"看起来在守、实际恒绿"的断言被找出来了**（§2），
以及**"想给冒烟一个干净起点"这个念头的正确解法是假桥里删 key，不是 `--user-data-dir`**（§4）。

---

## 1. 落地清单（判据 + 位置）

| 条目 | 判据（一句话） | 位置 |
| --- | --- | --- |
| **P1-1 简洁模式** | 一个布尔值只留一个控件；默认开；只作用于工作台形态 | `src/modules/goods/simple.ts`（新）· `GoodsView.vue:91`（`data-act="simple-toggle"`，`:aria-pressed`）· `ProductPane.vue:133/167/203` · `PoolPane.vue`（`PoolMetrics` 条件渲染） |
| **P0-5 空态说清先做哪个** | `queueEmpty === true`（**不是** `!queueEmpty`）才翻顺序 | `ProductPane.vue:381-435`（`data-act="empty-go-today"`）· `GoodsWorkbenchView.vue:142` |
| **P1-2 行展开可被发现** | 常显提示，**不**默认展开第一行 | `ProductPane.vue:447`（`data-act="expand-hint"`） |
| **P1-4 失效有汇总入口** | 入口随计数出现、按下即筛、**0 时不渲染** | `PoolPane.vue:365/376`（`mapped-invalid-only` / `mapped-invalid-on`）· `PoolPane.vue:735` |
| **P1-5 术语/入口名收敛** | 提示里的引用必须是**真名** | `src/modules/today/tabs/ClassifyPanel.vue:393/584` · `tests/uxEntryNames.spec.ts`（登记 `建档与关联`） |
| **P2-1 悬停信息常显** | 来源 **常显**，`title` 只做补充 | `PoolPane.vue:218/414`（`q-thumb-src` / `m-thumb-src`）· `:448`（`m-source`）· `⤢` 角标 |
| **P2-2 拖选补按钮 + 键盘可达** | 拖选之外有**不用鼠标**的等价路径 | `ProductEditorDrawer.vue:137-159`（`keydown.enter/space` + `size-all` / `size-none`） |
| **P2-3 对比弹层键盘提示降级** | 提示是**补充**，不是要求 | `CompareModal.vue`（11px / `.75`，文案改"也可以只用键盘…"） |

### 三处**刻意偏离报告**（都是本仓已有裁定的后果，不是漏做）

1. **不做报告建议的「批量…」按钮**。它与「简洁模式」开关是**同一个布尔值的两个控件** ——
   点它到底算"开"还是"关"，界面上说不清。本仓既有裁定是"一个布尔值只留一个开关"。
2. **不隐藏左栏「问题件」下拉**。它是「缺克重 / 未关联供应商」两个筛选的**唯一入口**
   （2026-10-08 撤页级指标条时补进来的）。藏掉就是把两个能力变成**界面上进不去的死功能**，
   而那正是本仓记过的现行犯（"撤入口必须同时补入口"）。
3. **不隐藏右栏队列每行的勾选框**。那是**认款**（勾商品 → 落到款上）的唯一选择方式，
   藏掉等于"简洁模式不能认款"。那是把主功能藏了，不叫简洁。

> 三条写进了 `simple.ts` 的文件头注释 —— 下一个想"顺手更简洁一点"的人先看到这些话。

---

## 2. ⭐ 两条"空转断言"是怎么暴露出来的（本轮最值得记）

判据：**一条断言只有在"把实现改坏"时变红，它才存在。** 本轮两条断言在变异下**不变红**。

### ① 假桥把 `byStatus` 写死成空数组

`scripts/goods-ui-smoke.mjs` 的假桥里，`productSkuSummary` 桩原先直接返回 `byStatus: []`。
于是"失效汇总入口"的条数在夹具里**恒为 0**，而当时唯一的断言是"有正数就显示" ——
**它在一个恒空的世界里测一个从不出现的元素**。

修法：桩改成按 `visibleMapped()` **真实聚合** `byStatus`。

### ② 只验正例 ⇒ 没验"0 时不渲染"

补完聚合之后，种子库里本来就有**一条失效行** ⇒ "有正数就显示"依旧恒真。
把守卫（`invalidCount > 0`）整个删掉的变异体，**还是绿的**（实测 M6）。

修法：加**反向夹具** `window.__smokeNoInvalid`（`:102` `visibleMapped()` / `:1813`），
让"库里一条失效都没有"这个状态**造得出来**，再加一条断言：

```js
// scripts/goods-ui-smoke.mjs:1813 附近
window.__smokeNoInvalid = true;
await settle(() => !document.querySelector('[data-act="mapped-invalid-only"]'), 8000);
report('库里一条失效都没有时，「只见失效」入口不该渲染', !btn);
```

加完再跑 M6 → ✅ 变红（`FAIL 库里一条失效都没有时… | rows=6 btn=true`）。

> **一般化**：凡"计数 / 汇总 / 状态"类 UI，**"零"和"非零"是两个状态**，
> 只验有数据的那个等于只测了一半，而且是最不重要的那一半。
> 反向夹具（让"没有"这个状态可造）是唯一解法。

---

## 3. 等待信号 / 判定信号必须分开（反向断言的两次返工）

反向断言第一版等 `settle(() => rows >= 1)` —— **行本来就在**，恒真，等于没等。
第二版改等 `settle(() => calls('productSkuSummary').length > sumBefore)` ——
被**上一步请求喂饱**（读到的是刷新前的 `btn=true`），仍失败。

最终形态：

```js
await settle(() => !document.querySelector('[data-act="mapped-invalid-only"]'), 8000);  // 等「目标状态」
report('…', !document.querySelector('[data-act="mapped-invalid-only"]'));               // 独立判定
```

两条硬纪律（与 `2026-09-30-headless-smoke-waitfor-trap` 同源，但这次是"等错信号"而不是"抛错"）：

- `settle` 是**有界等待且不抛**（超时返回，不中断整轮）；**判定交给独立的 `report`**。
  把断言写成 `waitFor` 的条件，超时会吞掉后面几十条。
- 等的对象必须是**"只有新结论才有的特征"**。等"表格有行"、等"某个通道被调过"这类
  **在条件成立前就已为真 / 被无关请求满足**的信号，等于没等。

---

## 4. 想给冒烟一个干净起点：改假桥，**不要** `--user-data-dir`

"简洁模式默认开"这条要在冒烟里确定性成立，就需要一个**没有历史 `localStorage` 的形态起点**。
先试了每遍一个临时 profile（`mkdtempSync` + `--user-data-dir=…`）—— **headless Chrome 挂住不退出**
（跑到 15 分钟仍在，`pgrep` 看到进程还在；单独探测 `--user-data-dir=/tmp/p3 --dump-dom data:text/html,…`
同样不退出）。顺带发现**这台机器没有 `timeout` 命令**（`command not found`），没法给它兜底。

正确解法：在 `<head>` 的假桥里（经典内联脚本，**先于** `<script type="module">` 执行）直接删 key：

```js
try { localStorage.removeItem('sk.goods.simple'); } catch (e) {}
```

注释里写明"**不要改用 `--user-data-dir`**"，免得下一个人重踩。

---

## 5. 其它三个工程细节

- **`colspan` 必须跟着列数算**：简洁 6 / 完整 7 列 ⇒ `ProductPane.vue:703`
  `const gdColspan = computed(() => (goodsSimple.value ? 6 : 7))`，两处使用（`:244` 展开行、`:381` 空态）。
  写死 7 的症状是**"右边缺一块"、不报错**（不会有一行红字告诉你）。
- **注入脚本内不能有反引号**（本轮又踩 5 次，报 `SyntaxError: Unexpected identifier '<某个单词>'`）：
  `FAKE_BRIDGE` / `ASSERT_SCRIPT` 是模板字面量，注释里出现 `` `title` `` / `` `window.__x` ``
  会把字符串提前终止。**每次改完立刻 `node --check`**。
- **变异之后必须 rebuild**：变异体留在 `dist/` 会被**下一次**门禁读到，制造假 FAIL
  （同源问题 R0–R3 轮已踩过一次）。本轮 10 条变异每条跑完都 `npm run build`，全部还原后再 rebuild 一次。

---

## 6. 变异复核（10 条，逐条确认变红）

| # | 变异 | 结果 |
| --- | --- | --- |
| M1 | `GOODS_SIMPLE_DEFAULT` `true` → `false` | ✅ |
| M2 | 统计条不从渲染里摘掉 | ✅ |
| M3 | 开关不写回状态（`setGoodsSimple` 空转） | ✅ |
| M4 | `colspan` 写死 7 | ✅ |
| M5 | 空态顺序不跟 `queueEmpty` 变 | ✅ |
| M6 | 失效入口丢掉条数守卫（`invalidCount > 0`） | ✅ **加反向断言后才红** |
| M7 | 失效入口按下去不筛（不发 `status:'invalid'`） | ✅ |
| M8 | 行展开提示不渲染 | ✅ |
| M9 | 队列图注不渲染 | ✅ |
| M10 | 跨页文案写回悬空名（"映射清单页签"） | ✅ |

还原后核对残留：

```bash
grep -rnE "GOODS_SIMPLE_DEFAULT = false|v-if=\"true\"|void on;|computed\(\(\) => 7\)|映射清单」页签" src/ scripts/
# 期望：无输出
```

---

## 7. 门禁（逐条单看退出码，全部 0）

```bash
npx tsc -p tsconfig.electron.json      # 0
npx vue-tsc --noEmit                   # 0
npm run verify                         # 0（✅ IPC 契约一致 —— 本轮零 IPC 改动）
npm run verify:docs                    # 0（✅ 无悬空引用）
npm run build                          # 0
npx vitest run                         # 36 文件 / 593 用例
npm run goods:ui                        # 203 PASS / 0 FAIL（181 + 11 + 11）
npm run today:ui                        # 139 PASS
npm run plugins:island:smoke -- --no-sandbox --disable-gpu   # 4/4 个 UI 岛
```

`goods:ui` 三遍视口：1440×900 全量 / 1200×800 默认窗口可达性 / 900×800 窄视口。

新增步骤三组：`simple-mode`（`:1003`）· `mapped-invalid-entry`（`:1791`）·
`viewport-narrow-empty-order`（`:862`，断言 `empty-go-today` 在**第一位**且是主按钮）。

---

## 8. 相关

- 上游方案与审查：`docs/plans/GOODS_UX_REFACTOR_PLAN.md` · `docs/reviews/UX_GOODS_NOVICE_2026-10-08.md`
- 上一段（R0–R3）：`docs/notes/2026-10-08-goods-ux-refactor-r0-r3.md`
- 整页重构（S0–S5）：`docs/plans/GOODS_WORKBENCH_PLAN.md` §11
- 同源教训：`docs/notes/2026-09-30-headless-smoke-waitfor-trap.md`（等信号的两种坏法）
