# 「货与成本 / 货品档案」可用性重构：51 条结论（蒸馏自 5 篇，2026-10-08 ~ 2026-10-17）

> **蒸馏笔记**：由 5 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/<原文件名>`

## 1. R0–R3 四段的顺序不可换

**结论**：`docs/plans/GOODS_UX_REFACTOR_PLAN.md` 的 R0–R3 全部落地（用户 2026-10-08 拍板"R0–R3 全做"）。
四段的**顺序不可换**，理由不是"先易后难"，而是每段都在给下一段**去掉一个假的失败原因**：

- **R0 修 bug 先于一切文案** —— 文案是在教用户"怎么用"，而当时"用法"本身是坏的（左栏认款后
  缓存不刷新、「显示更多」点了没反应、窄形态按钮被裁）。不先修，改好的文案会挂在同一批坏东西上，
  用户照着做依然失败，于是"改文案"这件事会被误判成"文案没用"。
- **R1 解死锁先于包装层** —— 「店铺未归一」提示条在全新安装下**零可点元素**（登记功能当时只在
  一个没装的 UI 岛里）。包装层做的是"把提示变成按钮"；而这里连**目标页**都不存在，
  先包装只会得到一个更精致的假动作。
- **R2 包装层先于首次动线** —— 引导卡里写的第三步是"点一款、按「认到本款」"。那个按钮是 R2 才
  从提示条变出来的；先写引导等于教用户点一个还不存在的东西。
- **R3 首次动线最后** —— 它把前三段的结果串成一条链，链上任何一环坏了它都是空话。

**取证**：`docs/plans/GOODS_UX_REFACTOR_PLAN.md`；门禁逐条：`npx tsc -p tsconfig.electron.json` ✅ 0 ·
`npx vue-tsc --noEmit` ✅ 0 · `npm run verify` ✅ 0（`✅ IPC 契约一致` —— 本轮**零 IPC 改动**）·
`npm run verify:docs` ✅ 0（`✅ 无悬空引用`）· `npm run build` ✅ 0 ·
`npx vitest run` ✅ **36 文件 / 593 用例**（新增 `tests/goodsFirstRun.spec.ts` 8 例）·
`npm run goods:ui` ✅ **180 PASS / 0 FAIL**（宽 1440 / 默认 1200 / 窄 900 三遍）·
`npm run product:sku:smoke` / `npm run shop:smoke` ✅ 0 ·
`npm run plugins:island:smoke` ✅ **4/4 岛** + 工具条文案体检 + 设置贡献 + 重启恢复。

⚠️ 两条环境注意（与本轮改动无关，但下次会同样撞上）：
- 岛冒烟需要 **vite dev server 在跑**，且**必须在同一次命令里**起它与跑它（分两次调用则连接不到，脚本会说
  "连不上 vite dev server"）；本机沙箱下还要**显式传 electron 参数**：
  `npm run plugins:island:smoke -- --no-sandbox --disable-gpu`（否则症状是
  `sandbox initialization failed` → GPU 进程反复崩 → `GPU process isn't usable. Goodbye.` → SIGTRAP，
  而脚本**退出码仍是 0**；必须看输出里有没有"4/4 个 UI 岛"那一行，别只看退出码）。
- 本机是 zsh：取管道前一环的退出码用 `${pipestatus[1]}`（`PIPESTATUS[0]` 是 bash 写法，在 zsh 里恒空）。

计数类事实以 `docs/baseline/PROJECT_BASELINE.md` 为准，本笔记不重复记数（会漂）。

**源**：`2026-10-08-goods-ux-refactor-r0-r3`（2026-10-08）

---

## 2. 存在性断言 ≠ 可达性断言（本轮最重要的一条）

**结论**：本仓此前的界面断言全是**存在性**的：`document.querySelector('[data-act="compare"]')` 有值就算过。
而 R0-4 的 bug 恰恰是："按钮**真的在 DOM 里**，只是被裁到视口之外 / 被工具栏盖住，用户点不到" ——
存在性断言在这种情况下**照样全绿**。

新增的 `reach` 判据（`scripts/goods-ui-smoke.mjs` 的 `reportReachable`）是两条**同时**成立：

1. `el.getBoundingClientRect()` 落在一段**真的**可见区域内（中心点在视口内）；
2. `document.elementFromPoint(中心)` 返回的是它自己（或它的后代） —— 挡住它的可以是任何东西：
   兄弟元素的层叠、`overflow: hidden` 的容器边缘、另一个浮层。

⚠️ 第 2 条不能用"`offsetParent !== null`"或"`display` 不是 none"代替 —— 那两条查的还是存在性，
被裁、被盖这两种"看得见但点不到"它们一律查不出来。同理**不能用 `el.click()` 代替**：
`click()` 是脚本直接派发，绕过命中测试，被盖住的按钮一样会响应（本仓已在 disabled 按钮上吃过一次：
`click()` 在 disabled 元素上根本不派发事件，而脚本以为点了）。

**取证**：`scripts/goods-ui-smoke.mjs` 的 `reportReachable`；`el.getBoundingClientRect()` + `document.elementFromPoint(中心)`。

**源**：`2026-10-08-goods-ux-refactor-r0-r3`（2026-10-08）

---

## 3. 页签「点得开」不等于「有内容」

**结论**：R1 的 D1 死锁在文案上表现为"让你去店铺登记，可它不在软件里"。收进内建页后，这里留了一条
**存在性**守卫的补强：每个页签不仅要点得到，还要**渲染出真的内容**（不是"页签在、点开一片空白"）。

📌 为什么页签名不能只靠 `tests/uxEntryNames.spec.ts`：那个守卫查的是"悬空入口名"，而本页的页签名
走的是 `ALLOWED_NON_ENTRY` 豁免（判据：用户**已经在这一页上**，只是被指到同页另一个页签）。
**豁免只说明"不需要报错"，不说明"这个页签存在"** —— 两件事必须分别守卫。这条已写进
`src/modules/goods/tabs.ts` 的文件头。

**取证**：`src/modules/goods/tabs.ts` 文件头注释。

**源**：`2026-10-08-goods-ux-refactor-r0-r3`（2026-10-08）

---

## 4. 「提示变按钮」时，变的必须是**目标**那一半

**结论**：`2026-10-03-hint-is-not-an-entry.md` 定的规矩是"提示只说有问题、动作藏在别处 ⇒ 做成按钮"。
本轮补一条：做成按钮之后**必须验证按钮真的到了**（不是"按钮渲染出来了"）。

实例：队列提示条上的「现在登记」与行内的「去登记」**都**跳「店铺登记」页签。跳转靠
`data-act="tab-registry"` —— 那是**字符串拼出来的**（`tab-${id}`），页签 id 写错一个字母，
按钮照样可点、点了**什么都不发生**，控制台不报任何错。
⇒ 用具名常量 `GOODS_TAB_REGISTRY`（`tabs.ts`）收成一处，并让冒烟断言"点完之后**目标页签真的激活**"。

**取证**：变异 **C2** `goRegistry()` 只关面板不切页签 ⇒ `帮助里的「打开「店铺登记」」真的切过去｜active=建档与关联`。

**源**：`2026-10-08-goods-ux-refactor-r0-r3`（2026-10-08）

---

## 5. 「没有」有三种，不能合并（`null` / `0` / 全零）

**结论**：`PoolMetrics.vue` 把这条规则**只写一遍**（工作台右栏与整宽回落形态共用同一个组件）：

| 状态 | 表达 | 为什么不能合并 |
| --- | --- | --- |
| 队列**还没拉过**（`stats === null`） | **一项都不渲染**（连"没有待认的"也不说） | 首屏那一瞬间说"没有待认的"，等于替用户宣布一个**它不知道**的结论 |
| 某项**为 0** | 那一项**不渲染** | "五项都写着 0 和 —，这页是不是坏了？"（走查 P0-3 原话） |
| **整行全零** | 说一句**真的**话："队列里还没有待认的店铺商品" | ⚠️ 不能说成"都认好了" —— 全零 ⇒ 一个订单组都没有，根本没有"认过"这个前提 |

⚠️ 「整行全零」这句话的成立条件**比 `unmapped === 0` 严**：必须 `stats !== null` **且**
`!truncated`（队列可能只取了一页）**且** `withoutItemId === 0`（有商品没有商品ID ⇒ 还有东西进不来）。
后两种情况下说"没有待认的"是**假话**，而它读起来完全正常。

**取证**：变异 **A2** 给 `metric-mapped` 加 `v-if="true"` ⇒ `值为 0 的指标不渲染…` 红。

**源**：`2026-10-08-goods-ux-refactor-r0-r3`（2026-10-08）

---

## 6. 新断言在变异下必须给出可读 FAIL；等待与判定必须分开

**结论**：冒烟的 `waitFor` 一旦超时，**后面的几十条断言全部不执行**（`2026-09-30-headless-smoke-waitfor-trap.md`）。
本轮新增的 W3 / 编辑器 / 首启卡步骤一律用**有界轮询 `settle(fn, ms)` + `report(ok, msg)`**：
等待（轮询到超时为止，不抛）与判定（打 PASS/FAIL 并继续）分开。变异的期望产物是
`FAIL 左栏那个按钮按下去真的写库…| calls=0 []` 这样一行可读的失败，**不是** `SMOKE: FAILED at [...]`。
（⚠️ 变异 B2 例外：它打在 `requestClose()` 的前置分支上，会走到"找不到可点击元素"而中断；
中断前那条 FAIL 已经打出来了，故按已知限制记录，不为了让 run 跑完而加判据之外的分支。）

收敛批又用一个反向断言把这条纪律验证了两遍：

- 反向断言第一版等 `settle(() => rows >= 1)` —— **行本来就在**，恒真，等于没等。
- 第二版改等 `settle(() => calls('productSkuSummary').length > sumBefore)` ——
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

**取证**：`FAIL 左栏那个按钮按下去真的写库…| calls=0 []`（变异 **B1** `@relate-request="void 0"` ⇒ 3 条可读 FAIL，**无 timeout**）；
收敛批 `settle` + `report` 两段式代码（原文照抄见上）。

**源**：`2026-10-08-goods-ux-refactor-r0-r3`（2026-10-08）· `2026-10-08-goods-ux-refactor-closing-batch`（2026-10-08）

---

## 7. `margin-right: auto` 写在子元素上，只把「它自己」推到左侧

**结论**：`ProductPicker` 复用了 `ConfirmDialog` 的全局 `.wb-dialog__foot`，其中 `margin-right: auto`
挂在 `.pk-color` 上。新加的"灰按钮原因"提示（`pk-blocked`）若写成 `.pk-color` 的**后继兄弟**，
它会掉到右边去（和「确定」挤在一起）。正解：放进**同一个左组**里。

**取证**：`.wb-dialog__foot` 的 `margin-right: auto` 挂在 `.pk-color` 上。

**源**：`2026-10-08-goods-ux-refactor-r0-r3`（2026-10-08）

---

## 8. 首启卡的守卫必须把两个前提都造齐，否则判据空转

**结论**：`shouldShowFirstRunCard` 要求 `stylesTotal === 0 && queueGroups === 0`。冒烟里如果只清空产品、
不清空队列，`queueGroups` 非 0 ⇒ 卡本来就不该出现 ⇒ **变异（把 `&&` 改成 `||`）也不会变红**。
同理 `empty-entry` 那一组断言前必须先 `window.__smokeReset()` —— 否则「已关联」非零，
"全零才说那句话"的分支**根本不可达**，断言变成了在验一个恒不成立的世界。

**取证**：变异 **C1b** `shouldShowFirstRunCard` 的 `&&` 改 `||` ⇒ vitest `4 failed | 4 passed` **且**冒烟 4 条
（`队列空但有款…` / `有款之后…自己消失` / `零款但订单已进队列…` / `窄窗口下零款 + 队列非空…`）。

**源**：`2026-10-08-goods-ux-refactor-r0-r3`（2026-10-08）

---

## 9. 会切页签的断言放最后

**结论**：页头「?」里那个"打开「店铺登记」"按钮**真的会切页签**，于是后面所有"当前处于哪个页签"的断言
会落在错的页签上。放在最后并**反过来**断言"页签真的切过去了"（`| active=店铺登记`）——
既是功能断言，也顺手证明了它不是装饰按钮。

**取证**：`| active=店铺登记`。

**源**：`2026-10-08-goods-ux-refactor-r0-r3`（2026-10-08）

---

## 10. `data-act` 名是拼出来的地方，字符串错误是静默的

**结论**：页签是 `tab-${id}`、指标是 `metric-${key}`。这类名字**必须**从一份常量派生（`tabs.ts` /
`PoolMetrics.vue`），否则"点击无反应、无报错、控制台干净"是最难查的一类毛病。

**取证**：`tab-${id}` / `metric-${key}`。

**源**：`2026-10-08-goods-ux-refactor-r0-r3`（2026-10-08）

---

## 11. `stylesTotal` 必须取全库汇总，不能取当前筛选列表的 `total`

**结论**："零款"这个前提如果读的是**按筛选**算出来的 `total`，用户只要开着"缺克重"筛选，它就会是 0 ——
一个筛选条件就能**伪造**出"全新安装"。`useProductList.ts` 的 `stylesTotal` 取
`productSummary.total`（不受筛选影响），出错时回落 `null`（= 不知道，不是 0）。

**取证**：`useProductList.ts` 的 `stylesTotal` 取 `productSummary.total`，出错回落 `null`。

**源**：`2026-10-08-goods-ux-refactor-r0-r3`（2026-10-08）

---

## 12. ⭐ 变异测试的产物会留在 `dist/` 里，被接下来的门禁读到

**结论**：⚠️ 本轮**真的踩了**：变异 C1b 把 `firstRun.ts` 的 `&&` 改成 `||`，为看冒烟变红而 `build` 了一次；
变异还原、源码改回 `&&`，**但没有再 build** —— `dist/` 里于是留着变异体。
下一次跑 `npm run goods:ui`（它读 `dist/renderer`）时：全量遍的「零款但订单已进队列 → 卡不出现」
与窄视口遍的「零款 + 队列非空 → 卡不出现」**同时**报 FAIL，而源码怎么看都是对的。
⇒ **变异跑完必须 `npm run build` 再跑最终门禁**；症状的识别特征是
"源码对、断言红、且红的正是那条变异所针对的断言"。
（同源纪律：`*:ui` 一律读 `dist/`，所以"改界面先 build"这条对本仓不是建议而是前提。
本轮还顺带验证了它的反面 —— 重建后同一份源码 180 PASS。）

收敛批复述同一条：变异之后必须 rebuild —— 变异体留在 `dist/` 会被**下一次**门禁读到，制造假 FAIL
（同源问题 R0–R3 轮已踩过一次）。本轮 10 条变异每条跑完都 `npm run build`，全部还原后再 rebuild 一次。

**取证**：`dist/renderer`；**180 PASS / 0 FAIL**；10 条变异每条跑完都 `npm run build`。

**源**：`2026-10-08-goods-ux-refactor-r0-r3`（2026-10-08）· `2026-10-08-goods-ux-refactor-closing-batch`（2026-10-08）

---

## 13. 注入脚本内不能有反引号（含两次"过了 `node --check`"的新症状）

**结论**：`FAKE_BRIDGE` / `ASSERT_SCRIPT` 是模板字面量，注释里出现 `` `title` `` / `` `window.__x` ``
会把字符串提前终止。**每次改完立刻 `node --check`**。

本条在本仓反复复发，并演化出两种症状：

- R0–R3 轮：反引号 ⇒ 直接 `SyntaxError`（好抓）。
- 矩阵轮（第三次、第四次）：`node --check` 直接报在第 3575 行；同日加"看大图"时注释里写
  `` `.wb-dialog` `` / `` `.mx-wrap` `` 两个类名 ⇒ 模板串提前闭合，剩下的文字**恰好是合法的 JS
  表达式语句**（`dialog is not defined`）⇒ **`node --check` 照样通过**，报错挪到 `npm run goods:ui`
  的 import 阶段才出来（`ReferenceError: dialog is not defined`，行号指向注释本身）。
- 收敛批：本轮又踩 5 次，报 `SyntaxError: Unexpected identifier '<某个单词>'`。
- 邮件/货品档案轮（坑 B）：本轮又踩两次，第二次的残句恰好是**合法 JS**，`node --check` **通过**，
  运行时报 `ReferenceError: view is not defined`、行号还指向注释本身（本仓 2026-10-16 记过同款）。
  判据只有一条：**改完 `node --check` 通过不算数，得实跑**。注释里要点名就写
  `kind-goods` / `reachInfo`（不加反引号），或者用「」。

**取证**：`SyntaxError: Unexpected identifier 'price'`（`node --check` 第 3575 行）；
`ReferenceError: dialog is not defined`；`SyntaxError: Unexpected identifier '<某个单词>'`；
`ReferenceError: view is not defined`。

**源**：`2026-10-08-goods-ux-refactor-closing-batch`（2026-10-08）· `2026-10-16-sku-matrix-editor`（2026-10-16，转述）· `2026-10-17-mail-out-goods-into-master-data`（2026-10-17）

---

## 14. `colspan` 必须跟着列数算

**结论**：简洁 6 / 完整 7 列 ⇒ `ProductPane.vue:703`
`const gdColspan = computed(() => (goodsSimple.value ? 6 : 7))`，两处使用（`:244` 展开行、`:381` 空态）。
写死 7 的症状是**"右边缺一块"、不报错**（不会有一行红字告诉你）。

**取证**：`ProductPane.vue:703` / `:244` / `:381`；变异 **M4** `colspan` 写死 7 ⇒ ✅。

**源**：`2026-10-08-goods-ux-refactor-closing-batch`（2026-10-08）

---

## 15. 想给冒烟一个干净起点：改假桥，**不要** `--user-data-dir`

**结论**："简洁模式默认开"这条要在冒烟里确定性成立，就需要一个**没有历史 `localStorage` 的形态起点**。
先试了每遍一个临时 profile（`mkdtempSync` + `--user-data-dir=…`）—— **headless Chrome 挂住不退出**
（跑到 15 分钟仍在，`pgrep` 看到进程还在；单独探测 `--user-data-dir=/tmp/p3 --dump-dom data:text/html,…`
同样不退出）。顺带发现**这台机器没有 `timeout` 命令**（`command not found`），没法给它兜底。

正确解法：在 `<head>` 的假桥里（经典内联脚本，**先于** `<script type="module">` 执行）直接删 key：

```js
try { localStorage.removeItem('sk.goods.simple'); } catch (e) {}
```

注释里写明"**不要改用 `--user-data-dir`**"，免得下一个人重踩。

**取证**：跑到 15 分钟仍在（`pgrep` 看到进程还在）；`timeout` 命令 `command not found`。

**源**：`2026-10-08-goods-ux-refactor-closing-batch`（2026-10-08）

---

## 16. ⭐ 两条"空转断言"是怎么暴露出来的

**结论**：判据：**一条断言只有在"把实现改坏"时变红，它才存在。** 本轮两条断言在变异下**不变红**。

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

**取证**：`FAIL 库里一条失效都没有时… | rows=6 btn=true`；`scripts/goods-ui-smoke.mjs:1813`。

**源**：`2026-10-08-goods-ux-refactor-closing-batch`（2026-10-08）

---

## 17. 三处**刻意偏离报告**（都是本仓已有裁定的后果，不是漏做）

**结论**：

1. **不做报告建议的「批量…」按钮**。它与「简洁模式」开关是**同一个布尔值的两个控件** ——
   点它到底算"开"还是"关"，界面上说不清。本仓既有裁定是"一个布尔值只留一个开关"。
2. **不隐藏左栏「问题件」下拉**。它是「缺克重 / 未关联供应商」两个筛选的**唯一入口**
   （2026-10-08 撤页级指标条时补进来的）。藏掉就是把两个能力变成**界面上进不去的死功能**，
   而那正是本仓记过的现行犯（"撤入口必须同时补入口"）。
3. **不隐藏右栏队列每行的勾选框**。那是**认款**（勾商品 → 落到款上）的唯一选择方式，
   藏掉等于"简洁模式不能认款"。那是把主功能藏了，不叫简洁。

> 三条写进了 `simple.ts` 的文件头注释（该文件 2026-10-25 已删） —— 下一个想"顺手更简洁一点"的人先看到这些话。

**取证**：`simple.ts` 文件头注释（2026-10-25 已删）。

**源**：`2026-10-08-goods-ux-refactor-closing-batch`（2026-10-08）

---

## 18. 收尾批落地清单（判据 + 位置）

**结论**：`docs/reviews/UX_GOODS_NOVICE_2026-10-08.md` §4 里 R0–R3 之外剩下的条目（P0-5 左半 / P1-2 /
P1-4 / P1-5 / P2-1 / P2-2 / P2-3）全部落地，外加报告建议的 **P1-1 简洁模式**（默认开、页头一键关）。
净效果：`goods:ui` **180 → 203 项**（全量 181 + 默认窗口可达性 11 + 窄视口 11），
`vitest` **36 文件 / 593 用例**，其余门禁零变化（**零 IPC 改动**）。

| 条目 | 判据（一句话） | 位置 |
| --- | --- | --- |
| **P1-1 简洁模式** | 一个布尔值只留一个控件；默认开；只作用于工作台形态 | `src/modules/goods/simple.ts`（新；⚠️ 2026-10-25 已随简洁模式撤除）· `GoodsView.vue:91`（`data-act="simple-toggle"`，`:aria-pressed`）· `ProductPane.vue:133/167/203` · `PoolPane.vue`（`PoolMetrics` 条件渲染） |
| **P0-5 空态说清先做哪个** | `queueEmpty === true`（**不是** `!queueEmpty`）才翻顺序 | `ProductPane.vue:381-435`（`data-act="empty-go-today"`）· `GoodsWorkbenchView.vue:142` |
| **P1-2 行展开可被发现** | 常显提示，**不**默认展开第一行 | `ProductPane.vue:447`（`data-act="expand-hint"`） |
| **P1-4 失效有汇总入口** | 入口随计数出现、按下即筛、**0 时不渲染** | `PoolPane.vue:365/376`（`mapped-invalid-only` / `mapped-invalid-on`）· `PoolPane.vue:735` |
| **P1-5 术语/入口名收敛** | 提示里的引用必须是**真名** | `src/modules/today/tabs/ClassifyPanel.vue:393/584` · `tests/uxEntryNames.spec.ts`（登记 `建档与关联`） |
| **P2-1 悬停信息常显** | 来源 **常显**，`title` 只做补充 | `PoolPane.vue:218/414`（`q-thumb-src` / `m-thumb-src`）· `:448`（`m-source`）· `⤢` 角标 |
| **P2-2 拖选补按钮 + 键盘可达** | 拖选之外有**不用鼠标**的等价路径 | `ProductEditorDrawer.vue:137-159`（`keydown.enter/space` + `size-all` / `size-none`） |
| **P2-3 对比弹层键盘提示降级** | 提示是**补充**，不是要求 | `CompareModal.vue`（11px / `.75`，文案改"也可以只用键盘…"） |

**取证**：`npx tsc -p tsconfig.electron.json` 0 · `npx vue-tsc --noEmit` 0 · `npm run verify` 0 ·
`npm run verify:docs` 0 · `npm run build` 0 · `npx vitest run` 36 文件 / 593 用例 ·
`npm run goods:ui` 203 PASS / 0 FAIL（181 + 11 + 11）· `npm run today:ui` 139 PASS ·
`npm run plugins:island:smoke -- --no-sandbox --disable-gpu` 4/4 个 UI 岛。
`goods:ui` 三遍视口：1440×900 全量 / 1200×800 默认窗口可达性 / 900×800 窄视口。
新增步骤三组：`simple-mode`（`:1003`）· `mapped-invalid-entry`（`:1791`）·
`viewport-narrow-empty-order`（`:862`，断言 `empty-go-today` 在**第一位**且是主按钮）。

**源**：`2026-10-08-goods-ux-refactor-closing-batch`（2026-10-08）

---

## 19. 收尾批变异复核（10 条，逐条确认变红）

**结论**：

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

**取证**：上述命令，期望无输出。

**源**：`2026-10-08-goods-ux-refactor-closing-batch`（2026-10-08）

---

## 20. R0–R3 变异取证（逐条确认**真的**变红；跑完均已还原）

**结论**：

| 变异 | 打在真守卫点 | 变红的断言 |
| --- | --- | --- |
| **A1** `emit('selection-changed', 1)`（写死常量） | 左栏认款按钮的计数来源 | 2 条：`展开区里有认款入口…｜disabled=false` / `右栏勾了 2 项后…｜认到本款（1 项）` |
| **A2** 给 `metric-mapped` 加 `v-if="true"` | 「0 不占位」 | `值为 0 的指标不渲染…` |
| **B1** `@relate-request="void 0"` | 认款入口 → 写库那一段 | 3 条可读 FAIL（`左栏那个按钮按下去真的写库…｜calls=0 []` 等），**无 timeout** |
| **B2** 删掉 `requestClose()` 里的 `closeGuard` 分支 | 关抽屉前的确认 | `带未保存的 SKU 改动点 ✕ → 先确认`（随后中断，见 §6） |
| **B3** 删掉类目的 `@blur` | 编辑抽屉的自动保存 | 2 条：`改类目后离开输入框就落库…｜[]` / `页脚给出"已自动保存"的回执` |
| **C1b** `shouldShowFirstRunCard` 的 `&&` 改 `\|\|` | 首启卡判据 | vitest `4 failed \| 4 passed` **且**冒烟 4 条（`队列空但有款…` / `有款之后…自己消失` / `零款但订单已进队列…` / `窄窗口下零款 + 队列非空…`） |
| **C2** `goRegistry()` 只关面板不切页签 | 帮助里的"打开店铺登记" | `帮助里的「打开「店铺登记」」真的切过去｜active=建档与关联` |

⚠️ 两条"看起来该红却没红"的教训：
- A2 若只断言"`metric-mapped` 存在" —— 恒绿（它本来就存在）。必须断言 **0 时不渲染**，
  且夹具里**真的有 0 的行**（否则那个分支不可达）。
- C1b 单测与冒烟**都要有**：单测钉纯函数的真值表（含 `queueGroups: null` 必须为 false 的反例），
  冒烟钉"卡真的进/出 DOM + 自己消失"。只留一层，另一层的错法（模板里 `v-if` 写反）会漏。

⚠️ 变异跑完的收尾：**把源码改回来之后必须 `npm run build` 再跑最终门禁**（见 §12，本轮就因漏了这一步在
`dist/` 里留下 C1b 的变异体，让最后一次全量冒烟挂着两条假 FAIL）。

**取证**：上表实跑结果；`4 failed | 4 passed`。

**源**：`2026-10-08-goods-ux-refactor-r0-r3`（2026-10-08）

---

## 21. R0–R3 落地清单（哪块代码负责哪一段）

**结论**：

| 段 | 位置 | 做了什么 |
| --- | --- | --- |
| R0 | `ProductPane.vue` / `useSkuPool.ts` / `PoolPane.vue` / `GoodsWorkbenchView.vue` | 修 4 个硬 bug：已关联缓存不再"拉过一次即置位"；「显示更多」的真假判据（`queuePendingTotal` / `queueHasMore`）；窄形态 `grid-template-rows: max-content max-content`；队列列精简（**只留商品ID + 图片**，图是主） |
| R1 | `tabs.ts`（新）/ `shopApi.ts`（新）/ `ShopRegistryView.vue`（新，从 UI 岛迁入）/ `GoodsView.vue` | 「店铺登记」收进内建页签；提示条变按钮（`row-open-registry`）；页签 id/名收成一处 |
| R2 | `glossary.ts`（新）/ `PoolMetrics.vue`（新）/ `ProductPane.vue` / `PoolPane.vue` / `useSkuPool.ts` / `ProductEditorDrawer.vue` / `ProductPicker.vue` | 术语首现加括号白话（`gloss()`）；左栏「认到本款」按钮（含 `relateCount` / 计数为 0 时禁用）；0 不占位 + 全零一句话 + 单项不说"批量"（`batchLabel`）；编辑抽屉统一保存模型（离开输入框即落库 / `formDirty` 快照比对 / 单飞 `flying` / `closeGuard` 只为"真的会丢"的 SKU 改动确认） |
| R3 | `firstRun.ts`（新）/ `FirstRunCard.vue`（新）/ `useProductList.ts` / `GoodsView.vue` / `GoodsWorkbenchView.vue` | 空库一次性引导卡（**三步第三次刻意无按钮**：用户此刻就在这一页）；页头「?」帮助面板与卡**共用** `FIRST_RUN_STEPS`（同一件事只写一遍） |

**被删的**：`docs/guides/USER_GUIDE.md` 的 594 行正文（描述的是「TV模版」时代的三栏界面，
照着找对不上）。现在是**下线说明**，指向应用内「货与成本」页头的「?」。保留文件路径只为不让
别处的引用悬空。

**回退开关**：`GOODS_LAYOUT = 'workbench' | 'tabs'`（`'tabs'` 仍是重构前形态，DOM 逐字一致）。
R0–R3 的所有改动**都在两种形态下成立** —— 新增的 R1 页签、`PoolMetrics`、「店铺登记」在
`'tabs'` 分支里同样在（否则回退会退回一个**死锁**的版本：登记入口又没了）。

**取证**：`GOODS_LAYOUT = 'workbench' | 'tabs'`；`FIRST_RUN_STEPS`；`docs/guides/USER_GUIDE.md` 594 行正文。

**源**：`2026-10-08-goods-ux-refactor-r0-r3`（2026-10-08）

---

## 22. R0–R3 未做（本轮范围外，用户未拍板 ≠ 遗漏）

**结论**：`PRODUCT_SKU_LINKING_PLAN` 遗留的 P1/P2：简洁模式开关、失效汇总入口、悬停信息常显。
本轮拍板的是 R0–R3（R3 只含审查报告的 P0-6 与 UX-G5）。另 UX-G6/G7 已在本轮由用户拍板
（G6 收进内建 / G7 精简列展示），故 `GOODS_UX_REFACTOR_PLAN.md` 的待拍板已清空。

**取证**：`PRODUCT_SKU_LINKING_PLAN` P1/P2；`GOODS_UX_REFACTOR_PLAN.md` 待拍板已清空。

**源**：`2026-10-08-goods-ux-refactor-r0-r3`（2026-10-08）

---

## 23. 「能不能自动带过去」要拆成三段问

**结论**：用户问"导入订单时有 产品图片链接 / 产品ID / 店铺名，能不能自动添加到货与成本？"
三个字段里**两个早已自动**，第三个（图片）**图也早就自动下载入库了**，
只是**只有一半界面显示它** —— 断点在"显示"，不在"导入"。

| 订单字段 | 状态 | 机制（全在既有代码里） |
| --- | --- | --- |
| 产品ID | ✅ 早已自动 | 导入时整行保真进 `oi_orders.raw_fields`；队列的商品ID 列名族 `ITEM_ID_KEYS` = `/商品\s*ID/i, /产品\s*ID/i, /SKU/i, /货号/`（`electron/shopSku.ts`）**本来就含「产品ID」** ⇒ 导入完队列里自动出现「店铺 × 商品ID」 |
| 店铺名 | ✅ 早已自动 | 队列按 `sk_name_map` 归一（人工归一优先 + 同名唯一精确命中只作建议） |
| 产品图片链接 | ⚠️ 图已入库，**显示端只有一半** | 图下载后落 `oi_images`，`oi_orders.image_id` 指向它；`itemImagePool()` 的第 ② 层「订单识别图」就是它 —— **已配映射那半在用，待关联队列那半没接** |

| 段 | 问什么 | 本轮答案 |
| --- | --- | --- |
| 源**有没有** | 源报表里有没有这一列 | 芒果店长「待发货订单」自带 `产品图片链接 / 产品ID / 店铺名` |
| 库**进没进** | 导入层提没提取 | 只提 4 个字段（`orderRowFields()`：订单号/店铺/尺寸/时间 + 图片 URL），**其余全部留在 `raw_fields` 里保真** |
| 界面**用没用** | 消费侧读没读它 | 图片读了一半（映射列表读了，队列没读） |

**三段症状一模一样**（"界面上看不到"），但解法完全不同：补采集 / 改导入 / 改消费侧。
跳过前两段直接改导入层，是白改。

> **副产品判据**：`raw_fields` 这种"整行保真"的列，让"库进没进"这一段的答案经常是**已经进了** ——
> 于是真正的缺口通常在第三段。查之前先问一句"它是不是已经在 raw 里了"。

**取证**：真库只读实测（2026-10-08）：9 行订单 `image_id` **9/9 非空**、`oi_images` 9 行、本地文件都在；
`pl_products` 27 个款、`pl_shop_sku` **0 行**（一条映射都没配过）。

**源**：`2026-10-08-order-image-into-goods`（2026-10-08）

---

## 24. 「另一半已经做了」是最强的线索

**结论**：图通路、通道、安全校验（`IMAGE_CACHE_DIRS` 白名单 + 扩展名 + realpath）**全都具备**，
因为「已配映射」那半早就在用。缺的只是一次调用 + 一列。

⇒ 遇到"这个功能能不能也自动到那一处"时，**先去找仓库里已经这么做的地方** ——
如果存在，改动量通常是一个函数调用，不是一条新链路；而且要复用它（`itemImagePool` 注释写明是
"唯一实现"，`picking-db.ts` 也在用）。

**取证**：`itemImagePool` 注释写明"唯一实现"；`picking-db.ts` 也在用。

**源**：`2026-10-08-order-image-into-goods`（2026-10-08）

---

## 25. 同一个能力用在两处时，键的口径必须逐字对齐

**结论**（本轮最容易静默出错的一条）：

- `itemImagePool()` 返回的池，键是**归一后**的商品ID（内部 `toSkuKey`）。
- `pl_shop_sku.item_id` **本来就是归一存储**的 ⇒ 映射列表拿 `itemId` 去查池，命中。
- 队列的 `itemId` 是**订单原文**（`extractSkuFields` → `pickField` 只做 `trim()`）⇒ 拿它查池，
  **整列的图全变空占位，且不报错** —— 看起来像"这些订单本来就没有图"。

⇒ 归一键要由**算它的那一层**带出来：`aggregateQueue` 里本来就算过 `toSkuKey(itemId)`，
加一个 `itemKey` 字段一路带出即可（**零复制**）。**不要在前端再实现一份归一** ——
两份规则必然漂移，而症状是"队列里认得出、查图查不到"这类各看一边都正常的问题。

**取证**：变异「队列查图用 `itemId`（订单原文）而不是 `itemKey`」⇒ ✅ 4 条 FAIL；
变异「`aggregateQueue` 的 `itemKey` 记成订单原文」⇒ ✅ 单测 2 failed；
变异「`toSkuKey` → `String(itemId).trim()`（不归一）」⇒ ✅ 数据层「商品ID 先归一」FAIL（`0 !== 1`）。

**源**：`2026-10-08-order-image-into-goods`（2026-10-08）

---

## 26. 「能看见图」≠「能比对图」

**结论**：认款是"看图选款"，需要两端都有图：

- 订单侧：有（订单报表自带图片列）
- 款侧：**一张都没有** —— `pl_products.image_id` 非空 = **0**（27 个款），`pl_images` **0 行**

⇒ 现在只能单向：**看订单图 + 读款名**（款名是中文描述性的，如「虎头袄 立领 绗缝」「连帽拉链外套」）。
做"图对图"的交互之前，先数一遍款侧有没有图，否则做了也是空占位。

**取证**：`pl_products.image_id` 非空 = **0**（27 个款），`pl_images` **0 行**。

**源**：`2026-10-08-order-image-into-goods`（2026-10-08）

---

## 27. 列名像 ≠ 同一个东西：按「用途 / 来源 / 粒度」判

**结论**（2026-10-08 用户纠正）：「商品标题」与「产品信息」都长得像"商品名字"，**但不是一回事**：

| | 商品标题 | 产品信息 |
| --- | --- | --- |
| **用途** | **让人一眼认出是哪款**（纯展示，不参与匹配） | 提**件数**（产品数量兜底）+ 尺寸兜底 |
| **来源** | 平台**商品管理/在线产品**类报表 | 芒果「待发货订单」的订单行 |
| **粒度** | 商品 | **店铺 × 商品** —— 同一款在不同店铺**完全不同** |
| **结构** | 一行干净标题 | `【N】<店铺给这件商品的标题>` ⏎ `(产品属性:Color/Size/Ships From)` ⏎ `(产品数量:N piece)` |

本仓两处的落点也印证了这条：

- **商品标题**：只有 `electron/ae-db.ts:63` 的 `title`（**AE 报表**才有）、`SkuQueueRow.title`；
  `TITLE_KEYS`（`electron/shopSku.ts:46`）= `/^商品标题$/ /^产品标题$/ /商品标题/ /产品名称/ /商品名称/ /^标题$/ /title/i`。
- **产品信息**：`ITEM_INFO_KEYS`（`src/lib/orderRowSplitter.ts:50`）= `/产品信息|商品信息|产品名称|商品名称|产品详情|商品详情/i`，
  只服务于件数提取与尺寸兜底；另有 `oi_queue.info`「产品信息摘要（列表展示用）」。

⇒ `TITLE_KEYS` **不收「产品信息」是对的**。我上一轮"把产品信息纳入标题列名族"的建议是错的 ——
那会把"每店各异的原始信息块"伪装成"统一标题"。

**可迁移的判据**：两个字段"看着都能当同一个用途"时，先各问三句 —— 它**干什么用**（用途）·
它**从哪来**（来源）· 它**代表多细的一层**（粒度）。**三条里任一不同，就不是同一个东西，不能互换**。

**取证**：`electron/ae-db.ts:63`；`electron/shopSku.ts:46`；`src/lib/orderRowSplitter.ts:50`。

**源**：`2026-10-08-order-image-into-goods`（2026-10-08）

---

## 28. 一个真 bug：假桥的形状写错了，于是"图能显示"从来没被测过

**结论**：`goods-ui-smoke.mjs` 的假桥是把 `window.electronAPI` **整个替换**掉的 ——
**它替换的是 preload 那一层**，所以入参形状 = **渲染层传给 preload 的形状**。

而 `payload → items` 的包装**发生在 preload**，被假桥绕过了：`ipc.ts` 的拆批函数调用
`ipc.orderImageThumbBatch(chunk)` 时传的是**数组**。旧假桥只认 `{ items }`
⇒ `((p && p.items) || [])` **恒为 `[]`** ⇒ 返回空 → 界面永远没图 → 而所有断言都以"空"为合格。

**这类假守卫的特征**：它在测一个恒为空的世界。判据：**给假桥喂一个非空样本**，
若断言在"实现正确"与"实现被改坏"两种情况下都绿，它就是假的。

（同理，`productItemImagePool` 的假桥之前恒返回 `{ pool: {} }` —— 映射列表那半的图列
也一直没被覆盖。修假桥后两边一起被覆盖。）

**取证**：变异「假桥改回只认 `{ items }`（复现旧假桥）」⇒ ✅ 3 条 FAIL；
`((p && p.items) || [])` 恒为 `[]`。

**源**：`2026-10-08-order-image-into-goods`（2026-10-08）

---

## 29. 看图弹层的两条细节

**结论**（都是"别让用户对着空白等"）：

1. 先用**缩略图**顶上弹层，再去主进程取原图替换 —— 取不到就停在缩略图上，不报错、不空白。
2. 用**递增序号**丢弃过期请求：点开另一行后，先前那次原图读取的结果不能盖到错的商品上。

落地清单：

| 位置 | 动作 |
| --- | --- |
| `src/modules/goods/components/SkuMappingView.vue` | 队列表格加「图」列（与已配映射表同位、同形态）；`loadQueueThumbs()` 复用 `pickFirst` + `api.itemImagePool`（三层回落：覆盖图 → 订单识别图 → 款主图）+ `api.imageThumbBatch`（渲染层已自动按 40 拆批）；点缩略图 → `api.readImage()` 读原图 |
| `electron/shopSku.ts` | `QueueGroup` / `QueueRow` 增加 `itemKey`，`buildQueueView` 透传 |
| `src/modules/goods/api.ts` | 新增 `readImage()`：读**原图**不缩放（缩略图通道的 `maxEdge` 在主进程被夹到 **256**，认印花/领型/颜色不够） |
| `src/core/services/ipc.ts` | 补 `orderReadImage` 的**渲染层包装**（此前只有 `ElectronApi` 上的声明、没有导出函数 —— 与 `orderImageThumbBatch` 同款缺口） |

**取证**：变异「不调 `loadQueueThumbs()`（队列根本不取图）」⇒ ✅ 4 条 FAIL；
变异「点开不取原图（停在缩略图上）」⇒ ✅ 卡在 `queue-viewer`。

**源**：`2026-10-08-order-image-into-goods`（2026-10-08）

---

## 30. 认款时顺手把订单图采纳为款主图

**结论**：（2026-10-08 已落地）判据 ④（见 §26）说"款侧一张图都没有 ⇒ 图对图认款只有一半"。
这一版补上另一半的**起点**：认款（写映射）那一刻，若该款还没有主图，就把**这个商品在订单里的那张图**
采纳为款主图。

三条规则都是「不做多余的事」（都在 `pendingProductImages`（`electron/product-db.ts`）里）：

| 规则 | 为什么 |
| --- | --- |
| **只补空**：`pl_products.image_id = 0` 才采纳 | 主图是人的决定；已有主图的款一律不动（否则程序会悄悄换掉人的图） |
| **取与界面同一张**：覆盖图 → 订单识别图（`itemImagePool` 首选） | "你刚才看着的那张"就是被采纳的那张；款主图那层此刻必为空，跳过 |
| **确定性**：同款被多个商品ID 映射时取 `productId` 升序 + `itemKey` 升序的第一个 | 不依赖 Map 插入顺序 / SQL 返回顺序（否则同一次操作两次跑出不同的图） |

落库在 `electron/product-handlers.ts` 的 `adoptOrderImages()`（与 `product-image-attach` **同一套实现**：
复制进 `product-images/` + 登记 `pl_images` + 写 `pl_products.image_id`）；**失败不外抛**
（单张失败只让这个款留空图，下次认款再试，绝不影响"映射已写入"这个事实）。

**为什么挂在认款里、而不是单独做个按钮**：用户此刻的注意力就在"这个商品=哪个款"，
订单图就在旁边（队列的「图」列）——顺手落下来形成正循环：**认一次款 → 款就有一张图 →
下次这个款在候选列表里就有图可比 → 更好认款**。

变异复核（8 条都确认能变红，之后复原，`grep MUTANT` 源码零残留）：

| 变异 | 结果 |
| --- | --- |
| `pendingProductImages` 去掉「只补空」（`if (num(image_id))` → `if (false)`） | ✅ 数据层「款已有主图还被挑出来」FAIL（`1 !== 0`） |
| 采纳图去掉覆盖图优先（`e?.override ??` 删掉、只取订单图） | ✅ 数据层「与界面同口径」FAIL（拿到 `order-images/a.webp`） |
| 去掉确定性排序（`list.sort(...)` 整段删） | ✅ 数据层「不随入参顺序漂」FAIL（`AD-B` vs `AD-A`） |
| `toSkuKey` → `String(itemId).trim()`（不归一） | ✅ 数据层「商品ID 先归一」FAIL（`0 !== 1`） |
| `order[0]` → 取**最早**那张 | ✅ 数据层「取图池首选（最新一张）」FAIL |
| `adoptOrderImages` 不调 `attachProductImage`（只数不写） | ✅ 端到端 4 条 FAIL（`image_id=0`，正是"不是只在返回值里数了个数"） |
| 界面 `adopted` **恒显示**（去掉三元） | ✅ UI「adopted=0 时不提」FAIL（回执出现"并把 0 张订单图设为款主图"） |
| 界面 `adopted` **恒不显示**（三元换成 `''`） | ✅ UI「认款回执报出采纳了几张」FAIL |

**源**：`2026-10-08-order-image-into-goods`（2026-10-08）

---

## 31. 写了**主数据**就必须说一声

**结论**：`adopted` 是**产品主数据**被改动的数（不是本次订单的行数）。不说的话，用户只会觉得
"我的产品页怎么多了张图，谁动的？"。回执尾部 `（reassigned ? '，另有 N 行老订单一并归好' : ''）
+ (adopted ? '，并把 N 张订单图设为款主图' : '')` —— **两个数都为 0 时都不提**
（"全零不是正确表达"：`adopted=2` 必须报，`adopted=0` 一个字都不许多说）。
> 2026-10-10 起 `reassigned` 措辞由「已自动关联 N 行存量订单」改为「另有 N 行老订单一并归好」
> （去行话 + 该数现在也计入**补色回填** —— 不只是"关联"，还有"改色"），见
> `docs/notes/2026-10-30-mapping-color-and-replay.md`。这条反向断言
不能拿全页 toast 合计去判（本页是 `--virtual-time-budget` 一次性跑完的，上一步的回执一直留在
DOM ⇒ 合计文本会被旧话污染成恒红/恒绿）；要用 `lastToastWith(needle)` 只认**这一条**回执。

**取证**：`lastToastWith(needle)`；`（reassigned ? '，另有 N 行老订单一并归好' : ''）`。

**源**：`2026-10-08-order-image-into-goods`（2026-10-08）

---

## 32. 三层守卫（一层都省不掉）

**结论**：**数据层** `product:sku:smoke`（挑哪个款、挑哪张图，+6 项）→
**端到端** `ipc:shape:smoke`（真复制文件、真登记 `pl_images`、真写 `image_id`、再认一次不覆盖，+6 项）
→ **界面** `goods:ui`（回执说不说、为 0 时说不说，+2 项）。⚠️ 中间那层必须端到端：
假桥冒烟替的是 **preload 上面那一层**，`payload → items` 的包装在 preload，它测不到。

**取证**：`product:sku:smoke` +6 项 / `ipc:shape:smoke` +6 项 / `goods:ui` +2 项。

**源**：`2026-10-08-order-image-into-goods`（2026-10-08）

---

## 33. 队列的「商品标题」列对芒果单恒空

**结论**：（⚠️ 2026-10-08 更正 —— 原先写的"它的对应物是「产品信息」"是错的）：
芒果店长「待发货订单」**没有「商品标题」列**，两种导出都没有（本机这批 8 列；仓库完整模板
`tests/fixtures/mango-pending-orders.xlsx` 12 列：店铺名 / 尺寸 / 订单号 / 下单时间 / 产品信息 /
产品数量 / 产品图片链接 / 产品ID / 产品总金额 / 物流费用 / 订单金额 / 收货国家（中文））。
**不能用「产品信息」去顶** —— 两者不是一回事，见 §27。

**取证**：本机这批 8 列；`tests/fixtures/mango-pending-orders.xlsx` 12 列。

**源**：`2026-10-08-order-image-into-goods`（2026-10-08）

---

## 34. 分界线是"动作的种类"，不是"功能的大小"

**结论**：用户口径原话：**「邮件功能独立出来，放在一级菜单。货与成本归拢到基础数据中」**。
两处形态由用户在选项里定：① 货与成本 → **左导航加一项「货品档案」**（不另起新页、内部页签原样保留）；
② 邮件的设置 → **跟模块走，设置中心新增「邮件」分类**。
一句话：**整合的是同一类动作，拆出的是另一类动作** —— 读信有自己的动线，款/货是资料本身。

基础数据整合的判据一直是「维护一份资料」；
读信不是资料（它每天要看未读、有"同步 / 检索 / 附件"自己的动线），所以**搬出去**；
款 / 采集商品 / 映射 / 成本表是资料本身，所以**搬进来**。判据不矛盾 —— 一句话：
**进基础数据的是"我维护的东西"，留在外面的模块是"我做的动作"**。

**取证**：验证 `npm run build`（⚠️ `*:ui` 读 dist，改界面必须先 build）· `npm run goods:ui` 三遍（1440 / 1200 / 900）SMOKE: ALL PASS ·
`npm run master-data:ui` SMOKE: ALL PASS（两遍）· `npm run today:ui` / `picking:ui` / `order-profit:ui` / `shipping-rate:ui` ·
`npx vue-tsc --noEmit` / `tsc -p tsconfig.electron.json` · `npm run verify` / `verify:docs` ·
`npx vitest run` 全量（>120s ⇒ 后台跑）。

**源**：`2026-10-17-mail-out-goods-into-master-data`（2026-10-17）

---

## 35. 模块 id ≠ 存储命名空间

**结论**：新模块 id 是 `mail`，但 `mailStore` 的
`defineStore('shop-accounts-mail')` 与 `useModuleStorage` 的命名空间**刻意一个字母没改**：
它俩是**已落盘的用户数据键**（邮箱账号、同步游标、附件缓存索引），改 id 就等于让老用户的
收件箱在中转时"变空"。先例同 `order-insight`（键名沿用已下架岛的 id，见 `AGENTS.md` §6）。

**取证**：`defineStore('shop-accounts-mail')`。

**源**：`2026-10-17-mail-out-goods-into-master-data`（2026-10-17）

---

## 36. "只说模块 id"会把用户丢在上次停留的那一类上

**结论**：`shop-accounts` 有七类资料，
`switchModule('shop-accounts')` 不带 `action` 时落点是 `store.mainTab`（持久化的上次位置）。
于是 `ImportNextStep` 与 `openModule()` 都补了 `action`；`data-act` 仍由
`import-next-${a.tab || a.action || a.moduleId}` 生成 ⇒ 锚点名 `import-next-goods` **没变**，
尽管 `moduleId` 从 `goods` 变成了 `shop-accounts`（这是刻意的：既有断言按锚点挂，不按 moduleId 挂）。

**取证**：`import-next-${a.tab || a.action || a.moduleId}`。

**源**：`2026-10-17-mail-out-goods-into-master-data`（2026-10-17）

---

## 37. 嵌入是有宽度代价的，几何断言会以"文案/可达性"的形式红出来

**结论**：左导航 200 + 页内边距 36 +
栏间距 12 = **248px** 不再属于这一页：默认 1200 窗口下可用宽度从 1200 掉到 **736**，
而两栏工作台的下限之和是 420 + 400 + 16 = **836** ⇒ 硬排的结果是右栏只剩 300px，
队列「商品ID」列被挤到 **42px**（16 位 ID 折成六行、行高 234px），图列被顶出视口。
修法是**把断点从 1180 抬到 1280**（侧排要窗口 ≥ 1084，取 1280 留余量）——
也就是**默认窗口现在落在断点下方，堆叠成了主形态**，这条写进了 `GoodsWorkbenchView.vue` 与冒烟断言。

**取证**：变异取证（新增的三条断言不是空转）：把 `@media (max-width: 1279px)` 临时改回 `1024px`
（= 默认窗口硬排两栏）后重跑 reach 那一遍，三条同时红：

```
FAIL 默认窗口下两栏**上下堆叠**…            | cols=420px 300px
FAIL 队列「商品ID」列宽到能读出一整串 …      | idCol=42px
FAIL 队列行高 ≤ 120px …                     | rowH=234px
```

同一次变异里 `队列行缩略图可达（点开看原图）` **是绿的**（`滚动后`）——
这正是"判据放宽一档"的代价：滚动可达后，靠滚动就能救回来的现象不再报错。
所以那两条**几何**断言不是补充说明，而是这一类缺陷唯一还抓得住的地方。

**源**：`2026-10-17-mail-out-goods-into-master-data`（2026-10-17）

---

## 38. 顺手修掉一个既有 bug：`MailInboxView` 的齿轮点了什么都没发生

**结论**：`MailInboxView` 的齿轮原来手写
`CustomEvent('open-settings', { detail: { category: 'shop-accounts', tab: 'mail' } })`，
而 `SettingsModal` 是按 **categoryId 全串**匹配的（`shop-accounts:settings`）⇒
**那个齿轮点了其实什么都没发生**。改用 `openSettings('mail:settings', 'inbox')` 一并修好。

**取证**：`shop-accounts:settings` vs `openSettings('mail:settings', 'inbox')`。

**源**：`2026-10-17-mail-out-goods-into-master-data`（2026-10-17）

---

## 39. 连带清单（改一处就得跟着改的地方）

**结论**：

| 位置 | 改了什么 | 漏了会怎样 |
| --- | --- | --- |
| `src/modules/mail/{meta,index,MailView,settings}.ts`、`MailInboxView.vue`、`MailSettingsPanel.vue`、`mailStore.ts` | 新建模块（`id: 'mail'`、`name: '邮件'`、`icon: 'inbox'`、`order: 3`）；设置分类 `mail:settings` | 页面在、入口不在（或反之） |
| `src/modules/shop-accounts/{meta,settings}.ts` | 设置只剩「安全设置」；左导航新增 `goods` 一项 | 设置中心出现同一个"邮件收件箱"两份 |
| `src/modules/goods/` 下的模块外壳（`meta.ts` 与 `index.ts` 两份，均已删） | **删除**（不再是模块，只留视图实现） | 侧栏出现第二个"货"入口 |
| `src/modules/shop-accounts/MasterDataView.vue` | `GoodsView` 以 `embedded` 形态渲染在 `kind === 'goods'`；删 `mail` 分支、`shop-accounts:goto` 监听、`counts.mail`、`.is-accent` | 点了左导航第二项落在空面板 |
| `src/modules/shop-accounts/store.ts` | `ShopAccountsMainTab` 的 `'mail'` → `'goods'`（loadPrefs 白名单同步） | 老用户上次停在"邮件"这一项 ⇒ 落空（无 `v-else` 兜底） |
| `src/modules/goods/GoodsView.vue` | 加 `embedded` prop（只去掉 h1，页头动作与页签一字不动）、`.is-embedded { padding: 0 }` | 两个标题 / 双份内边距 |
| `src/modules/goods/components/GoodsWorkbenchView.vue` | 断点 1180 → 1280（理由见 §37） | 默认窗口下队列被挤成一条缝 |
| `src/modules/shop-accounts/components/MailAccessDrawer.vue` | `emit('close')` → `mail.closeAccess()`（自己持开合），父组件写 `<MailAccessDrawer />` | 抽屉关不掉（父组件的 `mail` 已删） |
| `src/core/components/{IconGlyph.vue,icons.ts}` | 从 `modules/shop-accounts` 搬到 `core`（`mail` 与 `shop-accounts` 都要用）；新增 `box` 图标 | 两个模块互相 import，环 |
| `modules.config.json` / `src/registry.generated.ts` | profiles 与 `enabledModules` 换成 `today / shop-accounts / mail / order-cost / picking / quick-note` | 构建期裁掉模块或注册不到 |
| `src/core/AppShell.vue` | `iconSvg` 加 `inbox` | 侧栏图标空一格 |
| `src/core/services/importSheet.ts`、`today/tabs/ImportPanel.vue`、`OverviewPanel.vue`、`today/flowCtx.ts` | `ImportNextStep.action` + 回执文案改「货品档案」 | 点了"去维护 SKU 克重"落在店铺登记上 |
| 各处文案（`ClassifyPanel` / `importDetect` / `orderCost` / `OrderCostView` / `ShipRate*`） | 「货与成本」→「货品档案」/「基础数据 › 货品档案」 | 悬空入口名（守卫会红） |

**取证**：上表逐行。

**源**：`2026-10-17-mail-out-goods-into-master-data`（2026-10-17）

---

## 40. 坑 A：`git mv` 不认未跟踪文件

**结论**：这个仓一半文件不在索引里。
`git mv src/modules/shop-accounts/mailStore.ts …` 直接 `fatal: not under version control`
（工作区有 235 个未提交改动，`src/modules/shop-accounts/` 下多数文件从未被 add 过）。
搬家一律用 `mv`（文件系统层），搬完再 `git status` 看新增/删除两边的对应关系 ——
别为了"历史可追"临时 `git add` 一堆无关文件。

**取证**：`fatal: not under version control`；工作区有 235 个未提交改动。

**源**：`2026-10-17-mail-out-goods-into-master-data`（2026-10-17）

---

## 41. 坑 C：`stripComments` 认不出**正则字面量里的引号**

**结论**：`uxEntryNames` 报 `src/modules/mail/MailInboxView.vue: 「邮件收件箱」` 悬空 —— 那句话在注释里。
根因：`MailInboxView.vue` 有一条 `/["']?\s*(?:https?:)?\/\//` 这样的 URL 正则，逐字符扫描器读到
里面的 `"` 就以为进了字符串，**之后整段（含 `//` 注释）都不再被剥**。
修法：`stripComments` 末尾补一道**行级兜底**（丢掉行首是 `//` / `*` / `/*` 的行）。
代价写在函数注释里：行首以 `*` 开头的**代码**会被丢掉 —— 本仓没有这种写法（`*d.balance` 之类）。

**取证**：`/["']?\s*(?:https?:)?\/\//`。

**源**：`2026-10-17-mail-out-goods-into-master-data`（2026-10-17）

---

## 42. 坑 D：豁免要跟着入口一起搬（删豁免比加豁免更要紧）

**结论**：`ALLOWED_NON_ENTRY` 里原来有「邮件」这一条（它当时是基础数据左导航的项名）。
邮件变成一级模块后，它的名字由 `hostModuleNames()` 兜住了，那条豁免**必须删**：
本守卫的判据是 `known.has(name) || name in ALLOWED`，**两道都放行** ⇒
留着它等于让"文案指着一个已经不存在的左导航项"照样绿。
同批加的是「货品档案」，并为两处都补了**反向锚点**：
`hostModuleNames()` 含「邮件」、**不含**「货与成本」。

**取证**：`known.has(name) || name in ALLOWED`。

**源**：`2026-10-17-mail-out-goods-into-master-data`（2026-10-17）

---

## 43. 前向守卫

**结论**：

| 守卫 | 断言 |
| --- | --- |
| `tests/uxEntryNames.spec.ts` | 入口名三来源（`meta.name` / 岛 `displayName` / 白名单逐条理由）；支持 `A › B` 路径式（「基础数据 › 货品档案」）；「邮件」「货品档案」各自的存在/不存在反向锚点 |
| `tests/shopAccountsIntake.spec.ts` | 左导航**七项**且顺序 `accounts / goods / registry / companies / suppliers / cost / shipping`；`goods` 的 `order` 必须小于 `mail`、`order-cost`（顺序改成读 `mail/meta.ts` 与 `order-cost/meta.ts` —— 原先读的是已删的 goods 模块 `meta.ts`） |
| `tests/islandMailFrameCsp.spec.ts` | `sk-mail://` 的宿主页锚点从 `shop-accounts` 改成 `mail` |
| `scripts/master-data-ui-smoke.mjs` | `kind-*` 七项；**没有** `kind-mail`；邮件未读徽标在 `mail-view` 页头（`[data-act="mail-unread"]`）；`gotoMailModule()` / `backToMasterData()` 双向 |
| `scripts/goods-ui-smoke.mjs` | 帮助里的「打开「店铺登记」」→ 同模块落到 `kind-registry`（**不再有 `title-back`**，回程点 `kind-goods`）；reach 那一遍：断点/堆叠、`商品ID` 列 ≥ 120px、行高 ≤ 120px |

**取证**：上表各 spec / smoke 脚本。

**源**：`2026-10-17-mail-out-goods-into-master-data`（2026-10-17）

---

## 44. `reach` 判据改为先滚再判（只滚得动 overflow）

**结论**：`reachInfo` 现在先滚再判，但**只滚 overflow 为
auto/scroll 的祖先**（用户滚得动的那些）。`overflow: hidden` 的容器一律不替它滚 ——
`.wb-panel` 那种"元素在 DOM 里却被静默裁掉"的缺陷仍会红。靠滚动才通过的断言，详情里带「滚动后」。

**取证**：`overflow: hidden` 不替它滚；详情里带「滚动后」。

**源**：`2026-10-17-mail-out-goods-into-master-data`（2026-10-17）

---

## 45. 边界（本轮**没有**做的事）

**结论**：

- **`MailAccessDrawer` 留在「基础数据」**：它的触发点是账号行（「接入邮箱」），是**账号的属性**
  而不是收件箱的属性；挂到邮件页会渲染两份蒙层，而且从账号页点开时目标模块根本不在场。
- **邮件的旧存储键不改**（`shop-accounts-mail` / `useModuleStorage('shop-accounts-mail')`）：
  理由见 §35。哪天要做"改键 + 迁移"，得先写一份把老键读出来再写新键的迁移，而不是改字符串。
- **`goods:ui` 的主语没改名**：脚本文件名、`data-act`、`.gd-*` 类名、"货与成本页冒烟"这句标题
  一律保留（它们锚的是**视图实现**，不是模块名）。用户可见的文案已经全部是「货品档案」。
- 历史笔记里写「基础数据六项」「货与成本是个模块」的**不回填**：它们记录的是当时的形态。
  当前形态以 `docs/baseline/PROJECT_BASELINE.md` 为准。

**取证**：`useModuleStorage('shop-accounts-mail')`；`docs/baseline/PROJECT_BASELINE.md`。

**源**：`2026-10-17-mail-out-goods-into-master-data`（2026-10-17）

---

## 46. 「进价」页"不好看"的真因是"没有信息架构"

**结论**：用户口径：**当前页面不够直观，也不好看**。
把三块等宽平铺的白卡改成 **左=行动区（录入 + 待补）· 右=现状表** 两栏，
录入框加**回显**，展开区标出**哪条正在生效**。`data-act` 契约一个没动 ⇒ 既有 20 余条进价断言
**原样重挂**（只加不减），另新增 19 条守卫（含 1 处**反向夹具**）。

改版前的纵向堆叠：`录入进价` → `还没维护进价的款` → `款级进价`，三块都是 `.wb-panel`、
同一重量、同一宽度。宽屏下每块内部大片留白（录入行 4 个控件只占左边 1/3，右边 2/3 空着；
待补清单一行两个字段撑满 1400px）。

**判据不是"好不好看"，而是"这一页的动线在版面上有没有形状"**：这一页只做一件事 ——
**把没有价的款变成有价的款**（缺 → 有）。动线的两端是「待补 / 录入」与「现状表」，
它们**等宽平铺**时，版面既不表达"先做什么"，也不表达"两支各是什么"。
两栏（左 340px 定宽行动区 + 右侧自理宽度表）一次把两件事都说清了，顺带把留白收掉。

⚠️ 左栏用**定宽 340px** 而不是百分比：这一栏装的是**表单**，宽度再变不会多出信息，
反而会从"进价/生效日两列并排"退回一列；而表列多，多出来的宽度给它才有用。

**取证**：`npm run goods:shot` 多出一张 `cost-<W>x<H>.png`（切页签 + 展开生效区间）。
`goods:ui` **三遍 ALL PASS = 261 项**（= 全量 235 + 默认窗口 11 + 窄视口 15；本轮 +19：宽 15 + 窄 4）。

**源**：`2026-10-10-goods-cost-pane-rework`（2026-10-10）

---

## 47. 回显（`data-act="cost-echo"`）：防"价挂错款"

**结论**：`ae_cost_map` 的一行是 `(款编码, 生效日, 单价, 来源)`。**编码写错的价，在表上看起来完全正常**
—— 它只是一行永远没有订单取到的数据。所以"改之前先能核对改的是谁"是这一页唯一真正的防错点，
而改版前界面上只有一个光秃秃的输入框（`cost-code`），填完看不到任何反馈。

回显三态（判据是"用户此刻需要知道什么"）：

| 输入 | 回显 |
| --- | --- |
| 命中已有成本的款 | `S1 款一 · 当前 12.34 元（手工录入，2026-01-01 起生效）` |
| 命中产品库但还没价 | `S2 · 还没有进价 —— 保存后它从 2026-10-10 起生效` |
| 都不命中 | `ZZZ · 产品库里没有这个款编码（保存会被拦下，请用「选款」挑一个）` |

**⭐ 第四态是唯一那条"体验型"守卫**：`S` 是 `S1`/`S2` 的**前缀**，逐字输入时必然会经过它。
若按"精确命中"直接判，用户每敲一个字符都会看到一次「产品库里没有这个款」——
那是**在用户还没输完就报错**。所以 `draftIsPrefix` 专门挡这一下（`startsWith`）。
守卫方式：`setVal` 成 `'S'` 后断言回显里**没有**「没有」二字；变异（把 `draftIsPrefix` 改成恒 `false`）
确认这一条真的变红。

**取证**：变异 **M3** `draftIsPrefix` 恒 `false`（前缀守卫失效）⇒ 1 条：`S · 产品库里没有这个款编码…`。

**源**：`2026-10-10-goods-cost-pane-rework`（2026-10-10）

---

## 48. 单位必须挂在 `data-act` **外面**

**结论**：新增了「元」后缀，但既有断言 `flat(r.querySelector('[data-act="cost-current"]')) === '12.34'`
要求那一格**恰好**是数字。把「元」写进同一个 `data-act` 元素里 → 变成 `12.34元` → **立刻变红**。
这条不是风格问题，是**选择器的语义边界**：`data-act` 钉的是"那个数字"，单位是**装饰**。
所以「元」挂在外层 `.ct-price` 里的兄弟 `span` 上，并补一条断言把这件事**写成契约**
（`data-act` 里只有数字 **且** 父元素里有「元」）—— 免得下次有人"顺手"把单位合进去之后
只看到一条"当前进价取错了哪条"的红，排查方向被带偏。
同类还有一处：`[data-cost-code]` / `[data-cost-detail]` 与 `.ct-iv tbody tr` 都**没动**。

**取证**：`flat(r.querySelector('[data-act="cost-current"]')) === '12.34'`。

**源**：`2026-10-10-goods-cost-pane-rework`（2026-10-10）

---

## 49. 反向夹具：`__smokeEmptyCosts`

**结论**：新写了空态（`.wb-empty`：`￥` + 「还没有任何进价」）。**不造出"一条成本都没有"这个状态，
空态那条断言恒绿** —— 这是本仓记过多次的坑，所以假桥加一个开关：

```js
if (window.__smokeEmptyCosts) return { success: true, data: [] };
```

⚠️ 必须**返回空数组**，不能把夹具 `COSTS.length = 0`：后面的步还要用那份夹具，清空回不来。
（第一次写成注释 `COSTS.length = 0` 时还踩了本仓第 7 次老坑：**注入脚本的注释里不能有反引号**
—— 模板串被提前终止，`node --check` 直接红。）

零成本那一步顺带验了一条会被人忽略的联动：**S1 也要回到待补清单里**（它此刻真的没有价）。
"缺价清单 = 产品库 − 有成本的款"这条口径，只有在"全部款都缺价"时才会把 S1 也列出来。

**取证**：`if (window.__smokeEmptyCosts) return { success: true, data: [] };`。

**源**：`2026-10-10-goods-cost-pane-rework`（2026-10-10）

---

## 50. 窄窗口：三条缺一不可

**结论**：`.ct-cols` 在 `<1180px` 收成一列。三条缺一不可（理由逐字见组件里 `@media` 上的注释）：

1. `grid-template-rows: max-content max-content`（**不能**是 `auto`）：子栏都带 `min-height: 0`，
   `auto` 轨道的基准 = 0，网格会把富余高度**均分**给两行而不是按内容定高 ⇒ 每行比内容矮、
   内容溢出自己的盒子，而 `.wb-panel` 是 `overflow: hidden` ⇒ **被静默裁掉**。
2. `align-content: start`：默认 stretch 会把两行摊开、每块拉到半屏高。
3. ⚠️ **只改子栏内部的 flex**：`flex: 1` 的 basis 是 0，在"高度由内容决定"的场景里固有高度≈0
   （要改成 `flex: none` + `max-height`）；但 **`.ct` 自己必须继续 `flex: 1`**
   —— 它是 `.gd-tabpanel` 的 flex 项，高度由外部给定，`.ct-cols` 才有定高、`overflow: auto` 才有意义。

窄视口那遍新增 4 条：轨道数 = 1 · 两栏都还在 · **行动区排在表上面**（堆叠顺序 = 宽屏阅读顺序）·
**「保存进价」可达**（`reportReachable` —— 补价是这一页唯一的动线，被压扁到点不到就等于这页没用）。

变异 **M1** `.ct-cols` 两栏 → 单列 ⇒ 2 条变红：`tracks=1`（轨道数）· 两栏重叠（`asideR=1420 listL=228`）。
⚠️ M1 只让**几何那两条**变红，「左栏 = 行动区」那条**照旧绿** —— 这是对的：结构没变，
变的只是"分不分栏"。两条判据各有分工（结构 / 几何），谁也替代不了谁。

**取证**：`tracks=1`；`asideR=1420 listL=228`。

**源**：`2026-10-10-goods-cost-pane-rework`（2026-10-10）

---

## 51. 进价页变异 3 组（各自 rebuild 后确认变红再复原）

**结论**：

| # | 变异 | 变红的断言 |
| --- | --- | --- |
| M1 | `.ct-cols` 两栏 → 单列 | 2 条：`tracks=1`（轨道数）· 两栏重叠（`asideR=1420 listL=228`） |
| M2 | 去掉区间行的 `:class="{'is-current':…}"` | 1 条：`标了 0 条` |
| M3 | `draftIsPrefix` 恒 `false`（前缀守卫失效） | 1 条：`S · 产品库里没有这个款编码…` |

门禁：`tsc -p tsconfig.electron.json` 0 · `vue-tsc` 0 · `verify` · `verify:docs` 0 · `build` 0 ·
`vitest` 0 · `goods:ui` **三遍 ALL PASS = 261 项** · `goods:shot`。

**取证**：上表实跑结果 + 门禁逐条 0。

**源**：`2026-10-10-goods-cost-pane-rework`（2026-10-10）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-08-goods-ux-refactor-r0-r3.md` | 2026-10-08 | §1 / §2 / §3 / §4 / §5 / §6 / §7 / §8 / §9 / §10 / §11 / §12 / §20 / §21 / §22 |
| `2026-10-08-goods-ux-refactor-closing-batch.md` | 2026-10-08 | §6 / §12 / §13 / §14 / §15 / §16 / §17 / §18 / §19 |
| `2026-10-08-order-image-into-goods.md` | 2026-10-08 | §23 / §24 / §25 / §26 / §27 / §28 / §29 / §30 / §31 / §32 / §33 |
| `2026-10-10-goods-cost-pane-rework.md` | 2026-10-10 | §46 / §47 / §48 / §49 / §50 / §51 |
| `2026-10-17-mail-out-goods-into-master-data.md` | 2026-10-17 | §34 / §35 / §36 / §37 / §38 / §39 / §40 / §41 / §42 / §43 / §44 / §45 |
