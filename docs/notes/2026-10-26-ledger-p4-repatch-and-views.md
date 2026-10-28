# 记账 P4（批量变更相关人 / 单店与汇总 / xlsx 导出）：五条判定

**结论先说**：这一轮 DB 冒烟抓出的两个错都在**主进程生产代码**里，且都属于同一类盲区
—— 「静态门禁看不见的那一层」（SQL 字符串、跨单口径）。另三条是界面与守卫的判定。

## 1. 「作废」是整单的 ⇒ 任何派生量必须按整单口径算

C 路（撤销结算后改挂）的"改挂后原人还剩多少"首版用**选中条目**的金额去减，
而结算单撤销是**整张单**一起撤（同单里没被选中的条目也跟着恢复未结算）。
后果不是报错而是**数字错**：界面把残留报大，用户按这个数决定走哪条路。

- 取证：`electron/ledger-db.ts:1797`（注释写明"作废是整单作废 ⇒ 预估要减整单金额、每单只计一次"）、
  `:1831`（`afterVoidMoveCents = baseUnsettled − signedAll − settledNetSelected`，其中末项按结算单去重后求和）。
- 守卫：`npm run ledger:smoke` 段 `[8]` 的
  `C 路连带披露：作废只结了选中条目的同单账，会牵连它恢复未结算且不跟着改挂`。
- 通用判据：凡是"对集合里的元素做一件**以整单为单位**的动作"（作废 / 撤销 / 关闭 / 重开），
  它的**预估、回执、余额**三处都要问一句：算的是选中的那些，还是被牵连的整单？

## 2. SQL 字符串里的裸列名，`tsc` 与 `lint` 都抓不到

单店取数排序写成 `ORDER BY expense DESC`，而表里从来没有 `expense` 这一列
（只有 `direct_expense` / `shared_expense` 两个分量）。这是 `byShop` 拆成四分量时漏改的一处
—— 类型检查看不见 SQL 文本，SQLite 只在**运行时**报 `no such column: expense`。

- 取证：现状 `electron/ledger-db.ts:2275`（`ORDER BY (direct_expense + shared_expense) DESC, a.shop_id ASC`）。
- 定位它的只有真建库跑一遍的域冒烟：`npm run ledger:smoke`（46 项）。
- 通用判据：列被拆分/改名时，除了改 `SELECT` 的输出列，**必须全文件搜一次 `ORDER BY` / `HAVING` /
  窗口函数里的旧列名** —— 那些位置不产生类型错误，且只在特定筛选路径下才执行到。

## 3. 改派（repatch）不写 `bk_transfers`：结转的唯一来源是「合并相关人」

B 路（只改挂未结算）**刻意不产生结转记录**，与 P0 定的"合并相关人不写结转"是同一条理由：
余额随条目走，条目已经换了人，再写一笔结转等于**同一笔钱算两遍**。
A 路（全未结算）同理。只有 C 路会写结算单的撤销（那是"撤结算"这个动作本身的账，不是结转）。

- 取证：`electron/ledger-db.ts` 全文件只有 **一处** `INSERT INTO bk_transfers`（`:1562`，在
  `mergeParty`（`:1517`）体内）；断言在 `scripts/ledger-db-smoke.cjs:910` ——
  `常规 repatch 完全不碰 bk_transfers：余额随条目走，再写一笔结转等于算两遍`。
- 这条决定了**账能分得多细**：想看某人历史被改派过多少次，看 `bk_entry_logs`（操作日志），
  不要指望 `bk_transfers`。要加"改派也要留一笔可结转的账"必须先回答"余额从哪扣"。

## 4. UI 冒烟里"上一步记下的变量"会被后续步骤改写 ⇒ 断言要钉具体 id，候选集要从控件本身读

P4 的三路弹层原本都用 `window.__smokeLedger.lastPartyId` 当"改派目标"，结果
`[p4-repatch-a] 按钮始终不可点`。真因：P3 的归档 / 合并用例也调 `upsertParty`，
把 `lastPartyId` 覆盖成了一个**不在下拉候选里**的 id ⇒ `v-model.number` 拿不到有效值 ⇒ 提交按钮恒 disabled。
表现完全像"产品坏了"。

- 取证：`scripts/ledger-ui-smoke.mjs:1200`（新增 `targetChoices()`：直接读 `<select>` 自己的
  `options`，排掉哨兵 `value === '0'`），`:2269` 与 `:2308`（B 路断言候选只剩 `22`；
  C 路断言 `22,901` —— 排除的是**选中条目的原属人**，不是一切原属人）。
- 两条纪律：① 断言"下拉给了谁"时**从下拉自己读**，别拿脚本里攒着的变量当答案（否则恒绿）；
  ② 硬编码 id 要从**夹具的真实演变路径**推（本轮：23/24 被归档、24 合并进 21 ⇒ 条目 7 的属主是 21；
  结算单 #9 覆盖条目 4），不能凭上一轮的记忆。

## 5. 同页的页签名进悬空入口名豁免表；临时豁免用完必须删

`tests/uxEntryNames.spec.ts` 拦「相关人」「往来」两个引号名。处理方式不同：
「往来」是**本页自己的四个页签之一**（明细 / 往来 / 单店 / 汇总），与 `运费查询 / 款与商品` 同例
⇒ 进 `ALLOWED_NON_ENTRY` 并写明存在性由 `ledger:ui` 钉；
「相关人」是**弹层把遮罩下面的头部按钮当成目的地**（用户看不到那个按钮，它被弹层盖住了）⇒
**改文案**而不是加豁免：`src/modules/ledger/RepatchDialog.vue:39` 改成先说清"关掉这里，点页面右上角的 相关人 按钮"。
加豁免时临时用来定位误报的条目，命中消失后必须删掉 —— 留着等于给守卫开了永久的洞。

## 6. 导出：行数与三个合计只有一个实现（渲染层），主进程只画与存；「取消」不是失败

`electron/ledger-xlsx.ts` 不重算任何口径，`rows` / `totalIncomeCents` / `totalExpenseCents` /
`balanceCents` 全由渲染层按屏幕同源的数据传入（与 §5「每个数字只能有一处实现」同族）。
用户目的不是"造一个文件"而是"确认导的是屏幕上这批"，所以断言取**载荷**：
`导出载荷：11 行 + 合计与屏幕同源（主进程不复算口径）`、
`按筛选导出：只出这 1 条，筛选条件写进表头、合计改成这批的合计`、
`在保存对话框里点取消：不报「导出失败」，按钮恢复正常（取消不是错误）`
（取证 `scripts/ledger-ui-smoke.mjs` 段 `p4-export`；渲染层组装载荷在 `src/modules/ledger/LedgerView.vue:874`，
通道 `ledger-export-excel` 在 `electron/ledger-handlers.ts:266`）。

## 收工快照（实跑，2026-10-26）

`ledger:smoke` 46 项 exit 0 · `ledger:ui` 宽 160 / 窄 162（合计 322）ALL PASS ·
`npm run verify` 234 声明 / 229 通道（`ledger-handlers` 22 条）· `npx eslint .` 0 error / 608 warning ·
`npx vitest run` 49 文件 / 974 用例 · `npx vue-tsc --noEmit` 与 `npx tsc -p tsconfig.electron.json --noEmit` 均退 0 ·
`npm run db:inventory` 50 对象 = 49 表 + 1 FTS5（`bk_*` 仍 10 张，本轮无表形状变更 ⇒ 未跑 `schema:smoke`）。

相关：`docs/plans/LEDGER_PLAN.md` §11（P4 行已标 ✅）、`docs/notes/2026-10-25-ledger-p0-formula-fixes.md`
（合并相关人不写结转的原始论证）、`docs/notes/2026-10-26-ledger-p3-parties.md`（假桥桩的三类假绿）。
