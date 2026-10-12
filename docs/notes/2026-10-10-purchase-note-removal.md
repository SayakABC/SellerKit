# 「拿货单」的「模式」与「备注」逐条裁决：一个留、一个整条删（2026-10-10）

**背景**：用户问「拿货单列表展示图片、款色、尺码、建议、实拿、单价、金额。**模式是什么？备注的意义是什么？**
如果没有可以去掉，界面尽量简洁，不要过度设计」。逐条溯源后裁决：**模式（mode）保留**（有两条真实下游链路）、
**备注（note）整条删除**（零消费者，含 DB 列走版本化迁移）。本文记裁决的判据与删列的纪律。

## 一、「模式」留、「备注」删 —— 判据都是"谁在读它"

**mode 留**（`detail` 明细 / `package` 包价），因为它有两条**互不相同**的真实下游行为：

- `detail`：金额 = Σ(实拿 × 单价)，行**参与**拿货缺口扣减与成本同步；
- `package`：只记总额，**只参与厂家对账**（`reconciliation` 读 `total_cents`），不扣缺口、不进成本。

⇒ 之前它是编辑器里的一个表单格，但 `purchase-order-update` **不接受 mode**（创建时定死）——
给一个"改不动的下拉框"是**假动作**。改成页头**只读标签**（`pue-mode-tag`，措辞与列表逐字一致），
界面更简、语义不减。

**note 删**，因为全仓**零读者**：只被"存过"与"在列表显示过"，不进导出 xlsx、不进对账、
不进成本快照（`costSnapshot` 只读明细行）。真实库佐证（2026-10-10，只读）：2 张拿货单、0 条备注 ——
⚠️ 这只是**佐证不是判据**（"0 条包价 ≠ 包价没用"同理，使用者没用过不等于能力没价值；
判据始终是"有没有下游链路"）。

**同名不同表要分清**：`Supplier.note`（suppliers 表）与 `Payment.note`（payments 表）**保留**，
不受本轮影响；冒烟里「付款记录」的备注列照旧（那是 payment 域）。

## 二、删列的纪律 = 「新增列两处都要动」的镜像

`AGENTS.md` §1.4 的纪律「新增列必须同时写进 `CREATE TABLE`（SCHEMA）与迁移」**删列一模一样**：
`IF NOT EXISTS` 对已存在表一个字都不改 ⇒ **只删 SCHEMA 或只写迁移都会让新旧库形状分叉**。

- `purchase.main` **v1** 迁移（`electron/purchase-db.ts` `dropOrderNote`）：`PRAGMA table_info` 查到
  `note` 就 `ALTER TABLE ... DROP COLUMN`（SQLite 3.35+）；查不到（新库、表还不存在）直接跳过 ——
  **迁移跑在 `dbMigrate(SCHEMA)` 之前**（house convention），每一步都必须处理"表还不存在"。
- `ensurePurchaseSchema()` 的顺序：`migrate('purchase.main', steps)` **先** → `dbMigrate(SCHEMA)`（已无 note）
  的新库路径一次建到当前形状。
- **老库删列后必须实测建单路径**（本轮冒烟场景 F 第四条）：列删了但 INSERT 还写它 ⇒ 老库上任何建单
  必抛（同 `oi_styles.name` 的删法事故）；"数据一条不丢"与"能建新单"是两件事，都要断言。

## 三、守卫与取证

- `scripts/schema-migration-smoke.cjs` **场景 F**（+7 项，总 30 → 38）：老库（带 note）→ 迁移后
  版本记 v1、列已删、数据一条不丢、**新建单可用**、幂等；随后新库直建 PRAGMA 无 note ——
  抓"只删迁移忘了删 SCHEMA"的分叉。步数常数 `PURCHASE_STEPS = 1` 纳入 `[0]` 自检。
- `scripts/today-ui-smoke.mjs`（172 → **175** 项）：列表无「备注」列 · 编辑器无备注输入框（`pue-note` 不再存在）·
  开单出参无 `note` · 模式钉 `pue-mode-tag`（旧的 `pue-mode` 表单格反向断言）·
  **删除包价单的确认不许出现「回升」**（见第四节）。
- **变异确认非空转**：把 `dropOrderNote` 改成空操作 → 恰好那一条断言变红（`note 列应已删除：…`），
  其余全绿；还原后复跑全绿。⚠️ 变异跑完必须重跑 `tsc`/`build` 再跑最终门禁。

## 四、顺带修的文案谎报：确认弹层按 mode 分叉

删除/提交确认与编辑器已提交警示原先对**所有**拿货单都写「缺口会回升、成本同步减少」——
对**包价单**是**谎话**（包价不扣缺口、不进成本）。现按 `mode`（及 `status`）分叉：
包价单说「只影响厂家对账金额」，草稿说「只影响这张单自己」。反向守卫：包价单的删除确认里
**不许出现「回升」**。

## 取证

- 数据层：`electron/purchase-db.ts`（`purchaseMigrationSteps` / `dropOrderNote` / `ensurePurchaseSchema` 注释）；
  迁移记账 `purchase.main` = v1。
- 冒烟：`npm run schema:smoke`（场景 F）· `npm run today:ui`（175 项）；变异记录见本节。
- 真实库（只读）：`sqlite3 -readonly .../seller-kit/sellerkit.db "SELECT COUNT(*) FROM purchase_orders"` 等。
- 先例：`docs/notes/2026-09-30-table-rebuild-traps.md`（重建表三坑）· `oi_styles.name` 的删法（order.main v3）。
