# 记账相关人与结算：36 条结论（蒸馏自 5 篇，2026-10-26 ~ 2026-10-27）

> **蒸馏笔记**：由 5 篇同期笔记合并（清单见文末）。结论与取证全部保留，仅去重重排。
> 原文可取回：`git show b5df35c:docs/notes/<原文件名>`

## 1. 营收口径只允许复用统计页那一套；认不出的钱必须分桶，不许猜

**结论**：`src/lib/ledgerRevenue.ts` 不写任何收入 SQL，只把 `summarizeRevenueByShop` 的结果（`src/lib/orderCost.ts`）按**归一键**映射到 `sk_shops.id`（RK-06）。四个桶必须各自可见，而不是并成一句"部分营收未计入"。

**取证**：

- 名字没登记 → `unmatched.reason='not-found'`；同名多店（跨平台同名是合法的）→ `'ambiguous'`，**不按遍历顺序取第一家**；
- 订单没写店铺 → `unassignedCents`；
- 关闭/取消单 → `excludedClosedRows`（与统计页同一判据）；
- 金额缺失 → `missingRevenueRows`。

`src/lib/ledgerRevenue.ts:62`、`:111`、`:123`；弹层取数 `src/modules/ledger/EntryEditor.vue:863`。

**源**：`2026-10-26-ledger-p2-allocation`（2026-10-26）

---

## 2. 取数触顶与"全部营收为 0"是两件不同的事

**结论**：前者停用基准，后者回落并诚实落库。订单行取数上限 2000 行，`rows.length >= ORDER_ROW_LIMIT` 即视为**半份数据**，此时营收基准直接不可用 —— 按半份数据算占比会把钱摊错，且界面上看不出少了一半。反之，参与店营收全为 0 时引擎回落平均并显式提示；落库的 `basis` 记**实际采用的 `equal`**（`payload.basis = appliedBasis`），不把"按营收"写进历史却给一组平均分摊。

**取证**：`EntryEditor.vue:663`、保存前再拦一次 `:1067`；`payload.basis = appliedBasis`（`:1109`）。

**源**：`2026-10-26-ledger-p2-allocation`（2026-10-26）

---

## 3. 历史营收条目：参与集合与基准冻结，改金额按当初分摊金额的比例重算

**结论**：不回头拉营收 —— 否则之后每来一笔订单，历史分摊都会"自己变"，而账已经结过、报表已经看过。实现：权重取 `bk_allocations.amount_cents`（`storedRevenueParts`），只有 `scope`/参与集合锁死（`scopeLocked`），**金额可改**（`amountLocked` 只认已结算）。

**取证**：`storedRevenueParts`（`:687`）、`scopeLocked`（`:555`）、`amountLocked` 只认已结算（`:552`）。⚠️ 【历史记录】这修正了 P1 的"营收基准锁金额"口径：录错金额只能作废重记，摩擦大于风险。

`ledger:ui` 用「重新打开旧营收账」这条断言钉住两个事实：预览仍是 300/100（75% / 25%），且 `orderShippingRows` 调用次数**不变**（`watch(basis)` 只在 `!existingRevenue` 时取数，`EntryEditor.vue:806`）。

**源**：`2026-10-26-ledger-p2-allocation`（2026-10-26）

---

## 4. 方案 id 只作来源留痕；换基准/比例时必须显式写 0

**结论**：主进程对 `ruleId` 是**局部更新**语义（不传 = 沿用库里的旧值）。前端若在 `> 0` 时才传，用户"套用了方案后又改成手工比例"时，旧方案 id 会永远挂在这笔账上，回看时误导来源。所以 `save()` 无条件带 `payload.ruleId = ruleId.value`；重算从不读它。

**取证**：`src/modules/ledger/EntryEditor.vue:1112`、`electron/ledger-db.ts` 的 `ruleId` 分支。

**源**：`2026-10-26-ledger-p2-allocation`（2026-10-26）

---

## 5. 删店保护放在编排层，handler 与冒烟调同一份判据

**结论**：`electron/shop-delete-guard.ts:18` 用 `countShopReferences`（`electron/ledger-db.ts`）拦两类引用：专属条目 `bk_entries.shop_id`、公共分摊行 `bk_allocations.shop_id`。

**取证**：

- **已作废条目也算引用**：作废不删行，明细里仍按店名展示历史；
- 不能写进 `shop-accounts-db`（会多一条 db→db 隐式依赖边），也不能只写在 handler 里（冒烟只能断言文案，测不到"到底删没删"）；
- 提示统一引导「停用」：停用后店名照常显示、历史数字一分不变。

`shop:smoke` 同时有拒绝与正控制（无引用的店必须能删），避免"全都删不了"也能过。

**源**：`2026-10-26-ledger-p2-allocation`（2026-10-26）

---

## 6. 冒烟的夹具为什么要放"坏数据"

**结论**：只放"干净订单"时，四类分桶全都走不到，"营收与统计页对平"会变成一句空话。同理，方案用例走的是**保存为方案 → 套用到另一笔 → 重新打开看下拉** 的完整往返（而不是只断言请求体），才能抓到"按顺序回填"或"旧 id 残留"这类静默错。

**取证**：`scripts/ledger-ui-smoke.mjs` 的 `ORDER_ROWS` 刻意放了关闭单（999999 分）、未登记店（幽灵店 300 元）、没写店铺（200 元）、缺金额（null）四类行。

**源**：`2026-10-26-ledger-p2-allocation`（2026-10-26）

---

## 7. P2 门禁实测（2026-10-26）

**结论**：全绿；`ledger:ui` 78 / 80 条（宽 / 窄；P1 时为 55 / 57）。

**取证**：`npx tsc -p tsconfig.electron.json --noEmit` / `npx vue-tsc --noEmit` / `npm run verify`（230 / 225）/ `npm run verify:docs` / `npm test`（**49 文件 / 969 例**）/ `npm run build` 全绿。`ledger:smoke` **34 项** · `shop:smoke` **45 项**。`db:inventory` 不变：**50 个对象 = 49 表 + 1 FTS5**，业务表 47（本轮无表形状变更、无新 IPC 通道）。

**源**：`2026-10-26-ledger-p2-allocation`（2026-10-26）

---

## 8. 台账恒等式必须取**全期间**汇总，而且要两条独立路径

**结论**：`PartyLedger.vue:241` 取 `api.partyLedger({includeArchived:true})` + `api.summaryAll()`（`period = ''`），对账判据是 `Σ按人净往来 == 全期间收入 − 全期间支出`。

**取证**：

- **不能**用页面上那个「整月」汇总：往来与结算跨月，按当月算会除最后一天外**天天报红**，用户很快就会学会无视这条提示（比没有更糟）。
- **不能**用 `ledgerSummary` 里的 `partyGapCents`：它与台账同一来源，等于自己减自己，永远为 0 —— 同义反复。必须一条来自「按人聚合」、一条来自「全局收支聚合」，两条路径独立才有发现力。
- 筛选只改视图：合计行跟当前显示，恒等式按**全量（含已停用）**。勾「含已停用」时合计会变、恒等式不该变。

判据位置 `PartyLedger.vue:219`。

**源**：`2026-10-26-ledger-p3-parties`（2026-10-26）

---

## 9. 抽屉余额只能有一个算法，且必须"正序累计、倒序展示"

**结论**：`runningUnsettled`（`src/lib/partyLedger.ts:137`）算时间线逐行余额，与 `partyBalance`（同文件 `:80`）共用同一套符号（收入 +、支出 −、结算按方向冲减）。

**取证**：

- 抽屉按日期**倒序**渲染，但余额必须先在**正序**上累计再按原下标回填 —— 直接倒序累加，"首行余额 == 顶部未结清"只在最后一条恰好是今天时成立。
- 同日多笔要有稳定的 `seq`（条目在前、结算按列表序），否则 `Array.sort` 的稳定性会把余额挂到另一行上。
- **作废事件不动余额**（作废 = 这笔从未发生，不是金额为 0）；作废结算单同理。
- 证据：`tests/partyLedger.spec.ts` 的 `往来时间线的滚动余额` 5 例，其中"乱序入参按原始下标回填"是唯一能拦住"就地倒序累加"的实现；累计末值必须与 `partyBalance(...).unsettledCents` 相等。

**源**：`2026-10-26-ledger-p3-parties`（2026-10-26）

---

## 10. 结算金额只有**服务端按条目求和**这一个来源

**结论**：`SettlementDialog.vue:260` 的提交刻意不带金额，只传 `entryIds`；界面上的「合计」是 `settlementAmountOf(勾选金额)` 的**预览**，不是可编辑值。

**取证**：

- 一旦为了"显示/校验方便"把客户端求和结果也传上去，两边算法就会漂：客户端漏一条校验就会被绕过，超额拦截形同虚设。
- 方向与条目类型绑定（`pay → expense`、`receive → income`），切方向要清空勾选 —— 否则会出现"勾着支出按收款提交"，而服务端只按方向求和，两边都算错。
- 默认方向由余额决定（`unsettledPayableCents > 0 ? 'pay' : 'receive'`），不写死：只有应收的人打开弹层若默认"我付给对方"，会看到「可结 ¥0.00」以为系统坏了。

**源**：`2026-10-26-ledger-p3-parties`（2026-10-26）

---

## 11. 结算/撤销**不产生收支**，冒烟要断言"条目不增、整月合计不变"

**结论**：结算只改 `bk_settlement_lines.active` 与条目的结算标记；撤销只把结算单置 `void`、结算行失活、条目恢复未结。

**取证**：如果实现"顺手补一笔付款支出"，支出会翻倍、往来又对不上 —— 这是最容易被当成"功能完整"的错。因此 `ledger:ui` 里同时钉两条：`结算不产生收支/条目（明细仍是 11 条）` 与 `结算后整月合计不变`。撤销后必须验证**三个落点一起动**：台账「已结算 / 未结清」、明细行「已结算」标、作废按钮禁用态。只验台账会让"明细还显示已结算"这种半截状态漏过去。

**源**：`2026-10-26-ledger-p3-parties`（2026-10-26）

---

## 12. 假桥冒烟的三类假绿（本轮实测，全部先出现再修）

**结论**：桩数据类断言有三种恒真/恒假形态，必须按各自判据修。

**取证**：

| 类型 | 现象 | 判据/修法 |
|---|---|---|
| **内省 helper 缺字段** | `window.__smokeLedger.entry(id)` 只回 `partyId/status/...`，没有 `settled` ⇒ 断言 `entry(7).settled === true` 恒为 `undefined === true`（恒假）。反向的"恒真"更危险：`!entry(id).settled` 永远成立 | 任何"桩数据真的改了"的断言，先确认 helper 暴露了被断言的那个字段；helper 与 fake 表同一次改动里加字段 |
| **helper 前缀叠加** | `actAll('[data-settle-entry]')` 内部是 `querySelectorAll('[data-act="…"]')` ⇒ 选择器变成 `[data-act="[data-settle-entry]"]`，恒 0 行（断言红得莫名） | 非 `data-act` 属性一律用 `all(sel)`；`actAll` 只接 `data-act` 的**值**（不带方括号） |
| **数字是猜的** | 时间线断言 `rows === 11`，实际 12（11 条明细 + 1 张结算单） | 行数类断言用来源算：明细条数 + 结算单数；不要在心里数 —— 加夹具时必错 |

另：`PartyDrawer` 的金额着色原本用 `row.type`（`TimelineRow` 上没有这个字段，只有 `kind`）。`vue-tsc` 会拦，但**模板三元里的类名不在 lint 的 `vue/no-restricted-class` 覆盖范围内**，改这类着色时仍要人工确认用的是 `--wb-*` 令牌。

**源**：`2026-10-26-ledger-p3-parties`（2026-10-26）

---

## 13. P3 取证（实跑命令与调用口径）

**结论**：往来页的每个数都能直接拿去打钱，判定全部围绕"两处实现会不会漂"与"错误会不会被静默"。

**取证**：

```bash
npm run ledger:ui        # 宽 108 PASS / 窄 110 PASS，ALL PASS
npm run ledger:smoke     # 34 项；段 [5] 往来与结算 10 项、[6] 合并相关人 3 项、[7] 台账同构 2 项
npx vitest run tests/partyLedger.spec.ts   # 27 例
```

- 抽屉/台账数据调用：`ledgerEntryList` 带 `partyId`、**不带 `period`**、`includeVoid:true`（`PartyDrawer.vue` 的 `load()`）。
- 结算单列表含已撤销：`ledgerSettleList` 不过滤 `status`，由界面标「已撤销 + 原因」。
- 台账排序：未结清绝对值降序、同值按 `partyId`；合计行只跟当前显示。

**源**：`2026-10-26-ledger-p3-parties`（2026-10-26）

---

## 14. 「作废」是整单的 ⇒ 任何派生量必须按整单口径算

**结论**：C 路（撤销结算后改挂）的"改挂后原人还剩多少"首版用**选中条目**的金额去减，而结算单撤销是**整张单**一起撤（同单里没被选中的条目也跟着恢复未结算）。后果不是报错而是**数字错**：界面把残留报大，用户按这个数决定走哪条路。

**取证**：`electron/ledger-db.ts:1797`（注释写明"作废是整单作废 ⇒ 预估要减整单金额、每单只计一次"）、`:1831`（`afterVoidMoveCents = baseUnsettled − signedAll − settledNetSelected`，其中末项按结算单去重后求和）。

守卫：`npm run ledger:smoke` 段 `[8]` 的 `C 路连带披露：作废只结了选中条目的同单账，会牵连它恢复未结算且不跟着改挂`。

通用判据：凡是"对集合里的元素做一件**以整单为单位**的动作"（作废 / 撤销 / 关闭 / 重开），它的**预估、回执、余额**三处都要问一句：算的是选中的那些，还是被牵连的整单？

**源**：`2026-10-26-ledger-p4-repatch-and-views`（2026-10-26）

---

## 15. SQL 字符串里的裸列名，`tsc` 与 `lint` 都抓不到

**结论**：单店取数排序写成 `ORDER BY expense DESC`，而表里从来没有 `expense` 这一列（只有 `direct_expense` / `shared_expense` 两个分量）。这是 `byShop` 拆成四分量时漏改的一处 —— 类型检查看不见 SQL 文本，SQLite 只在**运行时**报 `no such column: expense`。

**取证**：现状 `electron/ledger-db.ts:2275`（`ORDER BY (direct_expense + shared_expense) DESC, a.shop_id ASC`）。定位它的只有真建库跑一遍的域冒烟：`npm run ledger:smoke`（46 项）。

通用判据：列被拆分/改名时，除了改 `SELECT` 的输出列，**必须全文件搜一次 `ORDER BY` / `HAVING` / 窗口函数里的旧列名** —— 那些位置不产生类型错误，且只在特定筛选路径下才执行到。

**源**：`2026-10-26-ledger-p4-repatch-and-views`（2026-10-26）

---

## 16. 改派（repatch）不写 `bk_transfers`：结转的唯一来源是「合并相关人」

**结论**：B 路（只改挂未结算）**刻意不产生结转记录**，与 P0 定的"合并相关人不写结转"是同一条理由：余额随条目走，条目已经换了人，再写一笔结转等于**同一笔钱算两遍**。A 路（全未结算）同理。只有 C 路会写结算单的撤销（那是"撤结算"这个动作本身的账，不是结转）。

**取证**：`electron/ledger-db.ts` 全文件只有 **一处** `INSERT INTO bk_transfers`（`:1562`，在 `mergeParty`（`:1517`）体内）；断言在 `scripts/ledger-db-smoke.cjs:910` —— `常规 repatch 完全不碰 bk_transfers：余额随条目走，再写一笔结转等于算两遍`。

这条决定了**账能分得多细**：想看某人历史被改派过多少次，看 `bk_entry_logs`（操作日志），不要指望 `bk_transfers`。要加"改派也要留一笔可结转的账"必须先回答"余额从哪扣"。

**源**：`2026-10-26-ledger-p4-repatch-and-views`（2026-10-26）

---

## 17. UI 冒烟里"上一步记下的变量"会被后续步骤改写 ⇒ 断言要钉具体 id

**结论**：P4 的三路弹层原本都用 `window.__smokeLedger.lastPartyId` 当"改派目标"，结果 `[p4-repatch-a] 按钮始终不可点`。真因：P3 的归档 / 合并用例也调 `upsertParty`，把 `lastPartyId` 覆盖成了一个**不在下拉候选里**的 id ⇒ `v-model.number` 拿不到有效值 ⇒ 提交按钮恒 disabled。表现完全像"产品坏了"。

**取证**：`scripts/ledger-ui-smoke.mjs:1200`（新增 `targetChoices()`：直接读 `<select>` 自己的 `options`，排掉哨兵 `value === '0'`），`:2269` 与 `:2308`（B 路断言候选只剩 `22`；C 路断言 `22,901` —— 排除的是**选中条目的原属人**，不是一切原属人）。

两条纪律：① 断言"下拉给了谁"时**从下拉自己读**，别拿脚本里攒着的变量当答案（否则恒绿）；② 硬编码 id 要从**夹具的真实演变路径**推（本轮：23/24 被归档、24 合并进 21 ⇒ 条目 7 的属主是 21；结算单 #9 覆盖条目 4），不能凭上一轮的记忆。

**源**：`2026-10-26-ledger-p4-repatch-and-views`（2026-10-26）

---

## 18. 同页的页签名进悬空入口名豁免表；临时豁免用完必须删

**结论**：`tests/uxEntryNames.spec.ts` 拦「相关人」「往来」两个引号名。处理方式不同：「往来」是**本页自己的四个页签之一**（明细 / 往来 / 单店 / 汇总），与 `运费查询 / 款与商品` 同例 ⇒ 进 `ALLOWED_NON_ENTRY` 并写明存在性由 `ledger:ui` 钉；「相关人」是**弹层把遮罩下面的头部按钮当成目的地**（用户看不到那个按钮，它被弹层盖住了）⇒ **改文案**而不是加豁免：`src/modules/ledger/RepatchDialog.vue:39` 改成先说清"关掉这里，点页面右上角的 相关人 按钮"。

**取证**：加豁免时临时用来定位误报的条目，命中消失后必须删掉 —— 留着等于给守卫开了永久的洞。

**源**：`2026-10-26-ledger-p4-repatch-and-views`（2026-10-26）

---

## 19. 导出：行数与三个合计只有一个实现（渲染层），主进程只画与存；「取消」不是失败

**结论**：`electron/ledger-xlsx.ts` 不重算任何口径，`rows` / `totalIncomeCents` / `totalExpenseCents` / `balanceCents` 全由渲染层按屏幕同源的数据传入（与「每个数字只能有一处实现」同族）。用户目的不是"造一个文件"而是"确认导的是屏幕上这批"，所以断言取**载荷**。

**取证**：三条断言：

`导出载荷：11 行 + 合计与屏幕同源（主进程不复算口径）`、

`按筛选导出：只出这 1 条，筛选条件写进表头、合计改成这批的合计`、

`在保存对话框里点取消：不报「导出失败」，按钮恢复正常（取消不是错误）`

`scripts/ledger-ui-smoke.mjs` 段 `p4-export`；渲染层组装载荷在 `src/modules/ledger/LedgerView.vue:874`，通道 `ledger-export-excel` 在 `electron/ledger-handlers.ts:266`。

**源**：`2026-10-26-ledger-p4-repatch-and-views`（2026-10-26）

---

## 20. P4 收工快照（实跑，2026-10-26）

**结论**：全部退 0；本轮 DB 冒烟抓出的两个错都在**主进程生产代码**里，且都属于同一类盲区 —— 「静态门禁看不见的那一层」（SQL 字符串、跨单口径）。

**取证**：`ledger:smoke` 46 项 exit 0 · `ledger:ui` 宽 160 / 窄 162（合计 322）ALL PASS · `npm run verify` 234 声明 / 229 通道（`ledger-handlers` 22 条）· `npx eslint .` 0 error / 608 warning · `npx vitest run` 49 文件 / 974 用例 · `npx vue-tsc --noEmit` 与 `npx tsc -p tsconfig.electron.json --noEmit` 均退 0 · `npm run db:inventory` 50 对象 = 49 表 + 1 FTS5（`bk_*` 仍 10 张，本轮无表形状变更 ⇒ 未跑 `schema:smoke`）。

相关：`docs/plans/LEDGER_PLAN.md` §11（P4 行已标 ✅）、`docs/notes/2026-10-30-ledger-core-fixes.md`（合并相关人不写结转的原始论证）、`docs/notes/2026-10-30-ledger-parties-and-settlement.md`（假桥桩的三类假绿）。

**源**：`2026-10-26-ledger-p4-repatch-and-views`（2026-10-26）

---

## 21. "要不要自动新建"是两条路各一份口径，故意的

**结论**：「记一笔」永远给 id、名字找不到就报错（逐笔手填，打错字必须拦）；Excel 导入给名字、库里没有就建（用户拿现成账单来对账，名字本来就在表里）。

**取证**：分叉落在类型上 —— `LedgerImportEntryInput`（带 `partyName` / `categoryName`）与 `LedgerEntryInput` 分开，「记一笔」那条路**拿不到**这两个字段。用户口径原文：「导入记账明细时，如果不存在的科目、相关人，需要自动新建。店铺状态为退店的时候也可以参与均摊」。

**源**：`2026-10-26-ledger-import-auto-create-parties`（2026-10-26）

---

## 22. 新建必须在落库的同一个事务里，不能在预览阶段建

**结论**：预览是"看看会怎样"，此时建就是把"用户点了取消"变成"库里多三个假房东"。`batchCreateEntries` 内按 `toNameKey` 先找后建，第 N 行失败整批回滚，**新建的人一起退回**。

**取证**：`batchCreateEntries` 的 `dbTransaction` 包住"建名字 + 写条目"（better-sqlite3 的嵌套事务走 savepoint）。

**源**：`2026-10-26-ledger-import-auto-create-parties`（2026-10-26）

---

## 23. 新建的东西必须念出来

**结论**：主进程回 `createdParties` / `createdCategories`，预览逐行标「将新建」、汇总条给个数、导入成功的 toast 列名字、父层跟着刷主数据缓存。理由：自动新建唯一的真实风险是"打错一个字凭空多一个假房东，之后所有钱都累计到假名字上"，只有让它显形才有意义。

**取证**：`createdParties` / `createdCategories` 两个回传字段与上述四处呈现。

**源**：`2026-10-26-ledger-import-auto-create-parties`（2026-10-26）

---

## 24. 指纹要带待新建的名字

**结论**：id 都是 0 时用名字占位，否则"同一天同一笔钱给张三 / 给李四"会判成同一笔（把真账标成重复、默认不勾 —— 比不查重更坏）。

**取证**：`tests/ledgerImport.spec.ts` 新增 ④b 指纹 3 例。

**源**：`2026-10-26-ledger-import-auto-create-parties`（2026-10-26）

---

## 25. 退店是标记，不是"不算了"

**结论**：可摊状态 `active | exited`；`archived`（停用）/ `banned`（封店）仍排除。退店排除的失效方式是静默的：钱只摊到剩下几家，**合计依然等于金额**，守恒断言抓不到。

**取证**：口径唯一：`electron/ledger-db.ts` 的 `resolveOrCreatePartyByName` / `resolveOrCreateCategoryByName` 都只认 `toNameKey`（与 `upsertParty` / `upsertCategory` 去重同一个键）；创建走既有 upsert，不新写 INSERT。可摊判定：`electron/ledger-db.ts` `eligibleShops`（`status !== 'active' && status !== 'exited'` ⇒ 排除）；`resolveImportNames` 的店铺查询把 `exited` 折成 `ok`、`archived|banned` 折成 `archived`，并把原始 `status` 一并返回给文案层。假桥同口径：`scripts/ledger-ui-smoke.mjs` 的 `eligible()` 同步放宽；只改主进程不改假桥，夹具里退店的店会恒绿。

**源**：`2026-10-26-ledger-import-auto-create-parties`（2026-10-26）

---

## 26. 导入自动建人的门禁与两处顺带修正

**结论**：四套冒烟都要动；两处顺带修正（悬空菜单名、注入脚本模板字符串）。

**取证**：

- `npx vitest run` → 50 文件 / **1045 例**全绿（含 `tests/ledgerImport.spec.ts` 67 例：④ 组重写为"缺失→待建"、新增 ④b 指纹 3 例）；
- `npm run ledger:smoke` → **51 项**（新增 `[12]` 组 5 项：自动建名 / 同名只建一个 / 整批回滚带走新建 / 停用名报错带行号 / 退店能摊）；
- `npm run ipc:shape:smoke` → 58 项全绿（新增 `⑫` 组 5 项）。**这一组是必须的**：`preload.ts` 的 `sanitizeLedgerImportEntries` 是**字段白名单**，直接调 `batchCreateEntries` 的 DB 冒烟看不见它 —— 变异验证：把 preload 里 `partyName` / `categoryName` 两行注释掉，这 5 项当场全红（报「第 1 行：没有资金相关人」）；
- `npm run ledger:ui` → ALL PASS（新增 `exited-shop` 步 2 条：退店的店真在勾选区、真拿到 1/3 分摊）。

顺带修的悬空名：文案里的「基础数据 › 店铺登记」自 2026-10-22 物理合并后已不存在（实体增改在「店铺」，「店名归一」只管历史文本），改成「基础数据 › 店铺」；`tests/uxEntryNames.spec.ts` 新豁免「相关人 / 科目」（「记账」页头按钮 `data-act="open-parties"` / `open-categories`，由 `ledger:ui` 点得开）。

注入脚本的老坑又踩一次：假桥那段是**模板字符串**，注释里写 `eligibleShops` 用的反引号直接截断整段（`node --check` 报的是注释下一行的 `Unexpected identifier`）。改假桥时先跑 `node --check`。

**源**：`2026-10-26-ledger-import-auto-create-parties`（2026-10-26）

---

## 27. 金额超两位小数自动取整（用户口径「解析的金额自动保留小数点后两位」）

**结论**：【历史记录】原设计是"超过两位小数**整行报错**"（`金额只到分（最多两位小数）`）。实测代价：一份三级精度的平台结算表 / 换算过汇率的分摊表，整批一行都导不进来。改成**自动四舍五入到分 + 逐行念出来**。

**取证**：

1. **两条路先归一成字符串，再做同一段算术**：数字格 `(v).toFixed(6)` 去尾零、文本格 `trim()`。不归一就会出现"Excel 里 1200.505 进成 1200.50、手打成文本却进 1200.51"——同一份文件两种结果，而且没有人会想到去比对。
2. **两位以内仍交给 `parseYuanToCents`**（与「记一笔」同一份实现）。取整分支只负责"多余的小数位"，不重写正常路径；用例里逐个数比对两条路的结论恒等（`for (const s of [...]) expect(import).toBe(strict)`）。
3. **只看十进制第三位、半进一，不碰浮点**：`1.005 * 100 === 100.49999999999999`，用 `Math.round(v*100)` 会把 1.005 舍成 1.00 —— 这与"用户以为四舍五入"正好相反，且只在很窄的输入上出现（最难发现的那种）。
4. **取整必须念出来**：回一句 `rounded`，进该行 warn、状态列标「金额取整」、汇总条计数。允许"金额和文件里不一样"，不允许"不一样还没人说"。
5. **不拦行**：`ok`/默认勾选照旧（旧行为是整行 error）。
6. **两种 0 分开说**：`0` → 「金额必须大于 0」（`assertAmountCents` 原话）；`0.004` → 「保留两位小数后是 0.00：导入只记到分」。合成一句"金额必填"会让人回去检查单元格是不是空的。

顺带修上一版遗留的**文案自相矛盾**：相关人/科目的列提示还写着「导入不会新建」，与已上线的自动新建相反；`tests/ledgerImport.spec.ts` 里那条断言「不会新建」的用例正是靠这句错话才绿 —— 用例钉住了旧行为时，改行为要连用例一起改，否则"全绿"本身就是假证据。

变异验证：把 `Number(rest[0]) >= 5` 改成 `> 5`，取整那组当场变红（69 passed / 1 failed）。

**源**：`2026-10-26-ledger-import-auto-create-parties`（2026-10-26）

---

## 28. 整批导入报 `An object could not be cloned.`

**结论**：用户点「导入」→「导入失败，一笔都没进：An object could not be cloned.」。**根因不是数据、不是 SQL，是载荷里有 Vue 的 reactive 代理**：`ipcRenderer.invoke` 走结构化克隆，Proxy 一律克隆不了，主进程一个字节都没收到 —— 所以既没有行号，也没有业务文案。

**取证**：

1. **浅拷贝不算**：`{ ...r.input }` 只换最外层，`allocations` 与它的元素仍是代理。而且失效面随文件内容变：只导专属行时 `input.allocations` 是 `undefined`，碰巧能过；**一旦有公共支出就整批炸**。这种"看文件内容决定成不成"的故障最难查，也最容易在自测里漏掉（自己试的那份文件正好都是专属行）。
2. **过 IPC 的对象必须现造**：`toCloneable` 深拷贝（对象/数组/标量，Date 单独处理）。**不做字段白名单** —— 白名单在 preload 的 `sanitizeLedgerImportEntries` 里已有一份，渲染层再抄一份就是等着"新加字段两边不同步 → 静默丢掉"（本仓库吃过三次）。
3. **为什么单元测试全绿还是炸**：`buildLedgerImportPayload` 单测里吃的是普通数组，不是 `ref` 里的数组。修法是让用例复刻真实状态：`vueRef(runOnce(...).results)` 再 `structuredClone` —— 直接调纯函数永远绿。
4. **为什么 UI 冒烟也没拦住**：`ledger:ui` 从来不覆盖导入弹层（此前已记为残留缺口），这次正好落在盲区。现在补上了：Node 侧用 `xlsx` 生成**真 xlsx**（喂假 grid 会绕开 `XLSX.read` 那段），假桥的 `ledgerEntryBatchCreate` 桩**照真机先做一次 `structuredClone`**，混进代理就当场红。夹具刻意三行各带一个失效点：金额超两位（取整）/ 公共「全部」/ 名字库里没有（自动新建）。
5. **夹具踩到的坑**：一开始用「房东陈」当相关人，结果前序步骤把它停用了 —— 导入两行报「已停用」。冒烟是**有状态的长流程**，夹具取的名字必须确认在该步骤时点仍然可用（或自己造一个）。

变异验证：把 `toCloneable(r.input)` 退回 `{ ...r.input }` → 单测 ⑪ 组变红、`ledger:ui` 导入步变红（`SMOKE: FAILED`）。

**源**：`2026-10-26-ledger-import-auto-create-parties`（2026-10-26）

---

## 29. "净额为零 ≠ 两清"是设计，不是 bug

**结论**：系统给每个人同时记两条账轨（应收 / 应付），结算按**条目逐笔核销**，不做净额轧账。于是"应收 1000、应付 1000"在页面上是：净往来 ¥0、未结清 ¥0（看起来两清）；可收 ¥1000、可付 ¥1000（实际两笔都没结）。用户只看到前一行，自然会问"为什么还要付钱"。

**取证**：不按净额当上限是方案 §6.2 修正 2 定过的：同一个供应商既欠我钱（退货/返利）又该我付（新货款）时，净额更小会把"该付的那笔"误判成超额，这笔账永远结不掉。

> 真正的缺口不是口径，而是**没有"互相抵掉"的入口**。用户的两笔账在业务上要相抵，系统只能逼他"付一张 + 收一张"，资金流水凭空多一进一出。

触发：用户问「往来里收入和支出相同的情况下，结算还需要付钱？」——账上净额 0，点结算却提示"应付方向可结 ¥1000"。

**源**：`2026-10-27-ledger-settle-offset`（2026-10-27）

---

## 30. 行业口径：核销（clearing）/ 冲抵（offsetting）

**结论**：共同点：**单据记毛额、资金流记净额、两者分开存**。会计上还有一条硬约束 —— 只允许**同一往来对象**内部抵销，不能跨人。本实现照此：互抵单必须同一个 `party_id`。

**取证**：

| 系统 | 做法 | 关键点 |
|---|---|---|
| 用友 / 金蝶 | 「往来核销 → 应收冲应付」生成往来转账单 | 一张单同时减两边余额，不走资金流水 |
| SAP FI | Clearing（F-32 客户清账） | 同一往来人的 debit/credit item 互清，剩余项保留 |
| QuickBooks / Xero | Bill Credit / Pay down | 用信用额度冲应付 |
| 合思 / 汇联易 | 借款单核销报销单 | 报销金额 − 借款余额 = 实际打款 |

**源**：`2026-10-27-ledger-settle-offset`（2026-10-27）

---

## 31. 毛额落库，资金流派生（唯一一处口径）

**结论**：`bk_settlements.amount_cents` 对互抵单记的是**行和**（毛额 1400），不是实付 600。实付由 `payCents - receiveCents` **派生**：`listSettlements` 现算、`createSettlement` 返回，不落库。界面显示的"付 ¥600"与单据里的 1400 是同一份数据的两种视图，不是两个数。

**取证**：为什么不让它记净额：① `createSettlement` 有一条对账断言 `Σ结算行 == 单据金额`。改成净额就失效 —— 而这条断言是"手改金额"与"勾错条目"的唯一区分手段（方案 §6.3 原始理由）。② 净额可能是 0（各 1000 完全对冲），而 `amount_cents` 有 `CHECK (> 0)`。③ 两套口径一旦并存，下次改代码的人一定会混用其中一个。

**源**：`2026-10-27-ledger-settle-offset`（2026-10-27）

---

## 32. 余额算法必须改成"按条目 kind 聚合"

**结论**：原实现按**单据 direction** 汇总已结算金额；互抵单的 direction 是 `offset`，两个 SUM 都落到 0 —— 结了等于没结，`可收/可付` 一点不减。改成按**结算行所关联条目的收/支**聚合。

**取证**：原写法：

```sql
SUM(CASE WHEN direction = 'pay' THEN amount_cents ELSE 0 END) AS settled_pay
```

改成：

```sql
SUM(CASE WHEN e.kind = 'expense' THEN l.amount_cents ELSE 0 END) AS settled_pay
SUM(CASE WHEN e.kind = 'income'  THEN l.amount_cents ELSE 0 END) AS settled_receive
```

对存量普通单是等价的（它们只含同一类行），但顺手也把"单据方向与条目方向不一致"这种历史脏数据的影响消掉了 —— 余额从此只信条目，不信单据上那个标签。

**两侧必须各减各的毛额。** 只减净额的话，应付 1000/应收 400 互抵后应付归零、应收还剩 400，用户会被引导去再收一次已经抵掉的钱。单测与冒烟各有三条守着这个（变异测试：把两侧改回净额，`partyLedger.spec.ts` 红 3 例、`ledger-db-smoke` 红 3 项）。

**源**：`2026-10-27-ledger-settle-offset`（2026-10-27）

---

## 33. 迁移：SQLite 改不了 CHECK，只能重建表，但顺序不能照抄

**结论**：`direction` 的 CHECK 从 `('pay','receive')` 放开 `'offset'`，只能重建表。项目里已有先例（`product-db.ts` 的 `normalizeSkuUniqueKey`），但**不能照抄它的顺序**。

**取证**：先例先 `ALTER TABLE ... RENAME TO ..._legacy`。对 `bk_settlements` 这么做的话，SQLite 3.25+ 会把子表 `bk_settlement_lines.REFERENCES bk_settlements` 的**文本**改写成 `_legacy`；老表一 DROP，结算行就指向一张不存在的表。而本项目 `foreign_keys` 是 OFF（从未开启），**不会报错** —— 迁移"成功"、schema 已经歪了，属于最难查的一类。

所以走另一条顺序：建 `_rebuild` 新表 → 拷数据 → `DROP` 老表 → `RENAME` 新表。子表引用的是 `bk_settlements`，换名后正好指回新表。迁移末尾补回随老表消失的索引，并按 `MAX(id)` 重置 `sqlite_sequence`（不重置会让新单复用已发出的 id）。

`ledger-db-smoke.cjs` 有一条专门造老形状再迁移的用例，断言：CHECK 放开、老数据还在、子表外键文本仍指向 `bk_settlements`、索引补回、新 id 大于旧 id。

**源**：`2026-10-27-ledger-settle-offset`（2026-10-27）

---

## 34. 界面：把"能互抵"写在用户会卡住的地方

**结论**：两个方向都有余额时，弹层多一行提示（`data-act="settle-offset-tip"`），否则用户只会看到"应付方向可结 ¥1000"，回到最初那个困惑。

**取证**：互抵模式下：

- 候选不再按方向过滤，每条前面多一列「收/支」
- 汇总拆开写「支出 ¥1000 · 收入 ¥400」，右侧单独给「资金流 付 ¥600」
- 只勾单边时**提交直接禁用**并提示改选方向 —— 放过去用户会以为"抵过了"，实际只清了一边

**源**：`2026-10-27-ledger-settle-offset`（2026-10-27）

---

## 35. 两个测试坑：假桥与夹具

**结论**：假桥必须跟着实现 offset 分支；夹具不能预置"两边都有余额"的人。

**取证**：

1. **UI 假桥必须跟着实现 offset 分支**。假桥里如果只按 direction 汇总，界面照样"全绿"，但它测的是假桥自己。`settleSides()` 就是为此加的：与主进程同一口径（按条目 kind 拆毛额）。
2. **夹具不能预置"两边都有余额"的人**。他会改变往来台账人数、合计、对账恒等式、改挂下拉选项 —— 七条与互抵无关的断言全要跟着改具体数值，而那些数字正是它们要守的东西。改成流程末尾 `window.__smokeLedger.addOffsetFixture()` 按需插入，既有断言一个不动。

**源**：`2026-10-27-ledger-settle-offset`（2026-10-27）

---

## 36. 仍然不做：部分核销与跨人抵销

**结论**：仍然不做的两条。

**取证**：

- **部分核销**：单据金额恒等于结算行之和，一条条目只能整条结清。要"先付一半"仍需撤销重结。
- **跨人抵销**：只在同一个 `party_id` 内允许（会计上也需要双方确认的抵销依据）。

**源**：`2026-10-27-ledger-settle-offset`（2026-10-27）

---

## 合并清单

| 原笔记 | 日期 | 归并到 |
|--------|------|--------|
| `2026-10-26-ledger-p2-allocation.md` | 2026-10-26 | §1–§7 |
| `2026-10-26-ledger-p3-parties.md` | 2026-10-26 | §8–§13 |
| `2026-10-26-ledger-p4-repatch-and-views.md` | 2026-10-26 | §14–§20 |
| `2026-10-26-ledger-import-auto-create-parties.md` | 2026-10-26 | §21–§28 |
| `2026-10-27-ledger-settle-offset.md` | 2026-10-27 | §29–§36 |
