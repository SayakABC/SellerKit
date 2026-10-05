# 重建存量表的三个坑（父表有子表 / 行号记账 / 交接顺序）

**结论**：给存量 SQLite 表做结构手术时，有三处**不报错但会丢东西**的地方，本项目都已踩过（2026-09-30，`oi_orders` 归一为订单主干时）。

## ① 父表**有外键子表**时，不要用 `rename → create → drop` 套路

`oi_styles` 被 `oi_style_colors.style_id REFERENCES oi_styles(id) ON DELETE CASCADE` 引用。
若按"rename → 建新表 → 拷数据 → drop 旧表"重建：`DROP TABLE oi_styles_legacy` 会**连带级联删掉子表数据**（子表的外键指向的是那张被改名的表）。
⇒ 子表在引用时，**优先用 `ALTER TABLE … DROP COLUMN`**（SQLite ≥3.35，本项目内置 3.53）—— 它不发 FK 事件。
只有在**必须改约束**（如 `NOT NULL` → 可空）时才重建，且要确认该表**没有被别的表引用**（`oi_orders` 没有子表 ✓，重建安全）。

## ② 重建会**重置 `sqlite_sequence`** → 下一笔插入撞主键

`AUTOINCREMENT` 的行号记账挂在 `sqlite_sequence` 上；旧表被 drop 时它的记账行随之消失，新表记账从 0 开始。
显式插入历史 id **不会**推进记账 ⇒ 下一笔 `INSERT` 会从 1 开始，直接撞已有主键。
⇒ 重建事务末尾必须追平：`UPDATE sqlite_sequence SET seq = MAX(id) WHERE name = ?`，没有记账行时 `INSERT` 一行
（`sqlite_sequence` **没有主键**，不能写 `ON CONFLICT`——本项目更早踩过同一坑）。

## ③ 迁移里做"数据交接"时，**先自己保证目标表存在**

`oi_orders` 的 v3 迁移里要把 `oi_styles.name` 交接进 `pl_products` 再删列，但本迁移跑在
`ensureOrderSchema()` 的 `ensureProductSchema()` **之前** —— 老库（订单域早于产品域）此时**还没有 `pl_products`**，
于是"交接被跳过、列却照删"⇒ **历史款名静默丢失**。
⇒ 交接类步骤要自己把目标表建起来（调幂等的 `ensureProductSchema()`），不要假设外层已经建好。

## 取证

- `electron/order-db.ts` 的 `migrateOrderSpine()`（v3）：① 交接前置、② 重建 `oi_orders`（`image_id` 可空 + `source`/`qty`）、
  ③ `oi_styles` 走 `DROP COLUMN`、④ 追平 `sqlite_sequence`。
- `scripts/schema-migration-smoke.cjs` 场景 [C]：六条断言——记账到 3 · 主干形状（含 8 列已删）· `image_id` 可空能落库 ·
  **款式名已进 `pl_products` 且 `oi_styles.name` 已删** · 老行 `source='import'`/`qty=NULL`/金额 NULL · **新插入 id > 历史最大 id**（行号已追平）· 数据一条不丢。
- 同类纪律见 `AGENTS.md` §1.4「schema 演进必须走版本化迁移」与技能 `sellerkit-host-schema-migration`。