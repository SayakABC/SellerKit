# 记账 P3（往来与结算）：五条判定 + 假桥桩的三类假绿

**结论先行**：往来页的每个数都能直接拿去打钱，所以这轮的判定全部围绕"两处实现会不会漂"与"错误会不会被静默"。

## 1. 台账恒等式必须取**全期间**汇总，而且要两条独立路径

`PartyLedger.vue:241` 取 `api.partyLedger({includeArchived:true})` + `api.summaryAll()`（`period = ''`），
对账判据是 `Σ按人净往来 == 全期间收入 − 全期间支出`（`PartyLedger.vue:219`）。

- **不能**用页面上那个「整月」汇总：往来与结算跨月，按当月算会除最后一天外**天天报红**，
  用户很快就会学会无视这条提示（比没有更糟）。
- **不能**用 `ledgerSummary` 里的 `partyGapCents`：它与台账同一来源，等于自己减自己，永远为 0 —— 同义反复。
  必须一条来自「按人聚合」、一条来自「全局收支聚合」，两条路径独立才有发现力。
- 筛选只改视图：合计行跟当前显示，恒等式按**全量（含已停用）**。勾「含已停用」时合计会变、恒等式不该变。

## 2. 抽屉余额只能有一个算法，且必须"正序累计、倒序展示"

`runningUnsettled`（`src/lib/partyLedger.ts:137`）算时间线逐行余额，与 `partyBalance`（同文件 `:80`）共用同一套符号
（收入 +、支出 −、结算按方向冲减）。

- 抽屉按日期**倒序**渲染，但余额必须先在**正序**上累计再按原下标回填 —— 直接倒序累加，
  "首行余额 == 顶部未结清"只在最后一条恰好是今天时成立。
- 同日多笔要有稳定的 `seq`（条目在前、结算按列表序），否则 `Array.sort` 的稳定性会把余额挂到另一行上。
- **作废事件不动余额**（作废 = 这笔从未发生，不是金额为 0）；作废结算单同理。
- 证据：`tests/partyLedger.spec.ts` 的 `往来时间线的滚动余额` 5 例，其中"乱序入参按原始下标回填"
  是唯一能拦住"就地倒序累加"的实现；累计末值必须与 `partyBalance(...).unsettledCents` 相等。

## 3. 结算金额只有**服务端按条目求和**这一个来源

`SettlementDialog.vue:260` 的提交刻意不带金额，只传 `entryIds`；界面上的「合计」是
`settlementAmountOf(勾选金额)` 的**预览**，不是可编辑值。

- 一旦为了"显示/校验方便"把客户端求和结果也传上去，两边算法就会漂：客户端漏一条校验就会被绕过，
  超额拦截形同虚设。
- 方向与条目类型绑定（`pay → expense`、`receive → income`），切方向要清空勾选 ——
  否则会出现"勾着支出按收款提交"，而服务端只按方向求和，两边都算错。
- 默认方向由余额决定（`unsettledPayableCents > 0 ? 'pay' : 'receive'`），不写死：只有应收的人打开弹层
  若默认"我付给对方"，会看到「可结 ¥0.00」以为系统坏了。

## 4. 结算/撤销**不产生收支**，冒烟要断言"条目不增、整月合计不变"

结算只改 `bk_settlement_lines.active` 与条目的结算标记；撤销只把结算单置 `void`、结算行失活、条目恢复未结。

- 如果实现"顺手补一笔付款支出"，支出会翻倍、往来又对不上 —— 这是最容易被当成"功能完整"的错。
- 因此 `ledger:ui` 里同时钉两条：`结算不产生收支/条目（明细仍是 11 条）` 与 `结算后整月合计不变`。
- 撤销后必须验证**三个落点一起动**：台账「已结算 / 未结清」、明细行「已结算」标、作废按钮禁用态。
  只验台账会让"明细还显示已结算"这种半截状态漏过去。

## 5. 假桥冒烟的三类假绿（本轮实测，全部先出现再修）

| 类型 | 现象 | 判据/修法 |
|---|---|---|
| **内省 helper 缺字段** | `window.__smokeLedger.entry(id)` 只回 `partyId/status/...`，没有 `settled` ⇒ 断言 `entry(7).settled === true` 恒为 `undefined === true`（恒假）。反向的"恒真"更危险：`!entry(id).settled` 永远成立 | 任何"桩数据真的改了"的断言，先确认 helper 暴露了被断言的那个字段；helper 与 fake 表同一次改动里加字段 |
| **helper 前缀叠加** | `actAll('[data-settle-entry]')` 内部是 `querySelectorAll('[data-act="…"]')` ⇒ 选择器变成 `[data-act="[data-settle-entry]"]`，恒 0 行（断言红得莫名） | 非 `data-act` 属性一律用 `all(sel)`；`actAll` 只接 `data-act` 的**值**（不带方括号） |
| **数字是猜的** | 时间线断言 `rows === 11`，实际 12（11 条明细 + 1 张结算单） | 行数类断言用来源算：明细条数 + 结算单数；不要在心里数 —— 加夹具时必错 |

另：`PartyDrawer` 的金额着色原本用 `row.type`（`TimelineRow` 上没有这个字段，只有 `kind`）。
`vue-tsc` 会拦，但**模板三元里的类名不在 lint 的 `vue/no-restricted-class` 覆盖范围内**，
改这类着色时仍要人工确认用的是 `--wb-*` 令牌。

## 取证

```bash
npm run ledger:ui        # 宽 108 PASS / 窄 110 PASS，ALL PASS
npm run ledger:smoke     # 34 项；段 [5] 往来与结算 10 项、[6] 合并相关人 3 项、[7] 台账同构 2 项
npx vitest run tests/partyLedger.spec.ts   # 27 例
```

- 抽屉/台账数据调用：`ledgerEntryList` 带 `partyId`、**不带 `period`**、`includeVoid:true`（`PartyDrawer.vue` 的 `load()`）。
- 结算单列表含已撤销：`ledgerSettleList` 不过滤 `status`，由界面标「已撤销 + 原因」。
- 台账排序：未结清绝对值降序、同值按 `partyId`；合计行只跟当前显示。
