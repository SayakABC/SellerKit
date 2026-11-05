// electron/ledger-db.ts
// 「记账」域数据层：店铺收支（入账）+ 公共费用分摊（派生）+ 资金相关人往来与结算。
//
// ---- 三条不可违反的结构性约定 ----
//
// 1. **条目是唯一真相，分摊是派生数据。**
//    `bk_allocations` 没有任何业务写入入口，只有 `writeAllocations()`（内部）能写它，
//    且写之前必须通过 `Σ 分摊 == 条目金额` 的硬断言。一旦允许"手改某店分摊金额"，
//    分摊行就变成第二份真相，条目金额改了它不跟着变，汇总立刻对不上，而且没有任何判据
//    能区分"这行是算出来的还是人改的"（方案 §5.6）。
//
// 2. **结算只改往来状态，不生成收支。**（方案 §1.3 硬规则 4）
//    `bk_entries` 上根本没有"结算来源"这类字段，所以"结算时顺手记一笔支出"在结构上写不进去
//    —— 这是 RK-03（支出翻倍）唯一可靠的防线，不是靠代码评审记得住。
//
// 3. **`period` 由 SQLite 生成列派生，不由任何 JS 计算。**
//    原先方案写"数据层从 biz_date 派生 period 落库"，但主进程若自己写一遍
//    `slice(0,7)`，渲染层再写一遍，两边一旦口径不同（一边按发生日、一边按录入日），
//    跨月那几笔就会漏进某个月，且没有任何报错。生成列让 period 在**结构上**无法写错。
//
// ---- 为什么主进程不 import `src/lib/ledger.ts` ----
//   三层边界（AGENTS.md §1.1）禁止主进程引渲染层代码，`tsconfig.electron.json` 的
//   rootDir=electron 也会直接编译失败。所以分工是：**分摊算法只在渲染层算**，
//   主进程只做守恒断言（Σ 必须等于条目金额）与入参消毒，不重复实现一份。
//   代价（已知并接受）：比例算错而合计又恰好对得上时，主进程拦不住 —— 故算法必须有单测，
//   见 tests/ledger.spec.ts。

export {};

import { dbGet, dbQuery, dbRun, dbTransaction, dbMigrate, migrate, tableExists, tableSql } from './db';
import { toNameKey } from './shopName';

// ---------------------------------------------------------------------------
// 常量与类型
// ---------------------------------------------------------------------------

/** 相关人类型（方案 §6.1；不需要"客户/合伙人"时再扩，扩枚举要同步改 CHECK） */
export const PARTY_KINDS = ['supplier', 'staff', 'landlord', 'platform', 'other'] as const;
export type PartyKind = (typeof PARTY_KINDS)[number];

/** 收/支方向 */
export type LedgerKind = 'income' | 'expense';
/** 范围：专属某店 / 公共（需分摊） */
export type LedgerScope = 'shop' | 'shared';
/** 条目状态：作废不是删除 */
export type LedgerStatus = 'active' | 'void';
/** 结算方向：我付出去 / 我收到 / 互抵结清 */
export type SettleDirection = 'pay' | 'receive' | 'offset';

/**
 * 把库里的 direction 文本收敛成三值枚举（**唯一一处分派**）。
 * 原先在 `partyLedger` / `listSettlements` / `repatchRows` / 抽屉查询里各写一遍
 * `=== 'receive' ? 'receive' : 'pay'`，加 `offset` 时漏一处就会把互抵单静默当成"我付给对方"。
 */
function toSettleDirection(raw: unknown): SettleDirection {
  return raw === 'receive' ? 'receive' : raw === 'offset' ? 'offset' : 'pay';
}
/** 分摊基准（与 `src/lib/ledger.ts` 的 `LedgerBasis` 必须同名同值） */
export type AllocBasis = 'equal' | 'revenue' | 'manual';
export const ALLOC_BASES: readonly AllocBasis[] = ['equal', 'revenue', 'manual'];

const MAX_LEN = {
  name: 100,
  note: 2000,
  method: 40,
  reason: 200,
  phone: 40,
} as const;

/** 单笔金额上限：10 亿元（与渲染层 `MAX_ALLOC_AMOUNT_CENTS` 对齐） */
const MAX_AMOUNT_CENTS = 1e11;

/**
 * 预置科目（方案 §14 第 1 项，用户选择"先按这份来，需要再改"）。
 * 只在表**空**时播种：builtin 科目允许改名，若每次 ensure 都按原名补插，
 * 用户改过名的科目会"复活"成两条，账目被拆开。
 */
const BUILTIN_CATEGORIES: Array<{ kind: LedgerKind; name: string }> = [
  { kind: 'expense', name: '采购货款' },
  { kind: 'expense', name: '物流运费' },
  { kind: 'expense', name: '平台佣金' },
  { kind: 'expense', name: '广告推广' },
  { kind: 'expense', name: '人工工资' },
  { kind: 'expense', name: '房租水电' },
  { kind: 'expense', name: '软件与工具' },
  { kind: 'expense', name: '包装耗材' },
  { kind: 'expense', name: '税费' },
  { kind: 'expense', name: '其他' },
  { kind: 'income', name: '店铺回款' },
  { kind: 'income', name: '其他收入' },
];

// ---------------------------------------------------------------------------
// DDL
// ---------------------------------------------------------------------------

/**
 * `bk_settlements` 的建表语句（写成函数：迁移 v2 重建表时必须**复用同一份形状**，
 * 否则"新库一条 DDL、迁移另一条 DDL"必然漂移，而漂移的症状是"老库能存 offset、新库存不进"）。
 */
function settlementsDdl(table: string): string {
  return `CREATE TABLE IF NOT EXISTS ${table} (
    -- 用途：结算单（付款/收款/互抵结清，一行 = 一次结算；作废不删行，保留原因与时间）。属 ledger 域。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    party_id INTEGER NOT NULL,
    settle_date TEXT NOT NULL,
    direction TEXT NOT NULL CHECK (direction IN ('pay','receive','offset')),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    method TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
    void_reason TEXT NOT NULL DEFAULT '',
    voided_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`;
}

const SETTLEMENTS_TABLE_SQL = settlementsDdl('bk_settlements');
const SETTLEMENTS_INDEX_SQL = `CREATE INDEX IF NOT EXISTS idx_bk_settle_party ON bk_settlements(party_id, settle_date)`;

/**
 * 建表语句（幂等）。新库由这里一次建到当前形状，老库靠 `migrate('ledger.main')` 追。
 *
 * ⚠️ `bk_settlement_lines` 的唯一性**不能用内联 `UNIQUE(entry_id)`**：
 *    撤销结算时若只把结算单置 void，内联唯一键会让这批条目永远无法重新结算
 *    （撤销功能等于废掉）。故改为**部分唯一索引** `WHERE active = 1`，
 *    作废时把结算行的 active 置 0 —— 结构上既禁"一条被两张有效单结"，
 *    又允许"撤销后重新结算"。
 */
const LEDGER_SCHEMA: string[] = [
  // `bk_parties`：记账域「资金相关人」主档（供应商 / 员工 / 房东 / 平台 / 其他），PK `id`、业务唯一键 `name_key`。
  // 写 = 相关人维护页（新增 / 改名 / 停用 / 合并）；读 = 条目、结算、余额（`partyLedger`）全部按 `party_id` 汇总。
  // 只停用 / 合并、**不物理删除**：历史条目必须始终能指回一个人。
  `CREATE TABLE IF NOT EXISTS bk_parties (
    -- 用途：记账「资金相关人」主档（供应商/员工/房东/平台/其他），余额按 party_id 汇总；停用/合并不删行。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    kind TEXT NOT NULL DEFAULT 'other'
      CHECK (kind IN ('supplier','staff','landlord','platform','other')),
    phone TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    -- 被合并到谁（0 = 没被合并）。archived 一个字段同时表示"手动停用"和"已并入他人"，
    -- 两者在界面上是完全不同的含义（后者能顺着找过去，前者只能重启用），故分开存（审查 §5-4）。
    merged_to INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (name_key)
  )`,

  // `bk_categories`：收支科目（`kind` 在收入 / 支出两套里各独立），唯一键 `(kind,name_key)`。
  // 写 = 启动种子内置科目 + 科目维护页；读 = 条目表单下拉、分类汇总。停用走 `archived`，不删行。
  `CREATE TABLE IF NOT EXISTS bk_categories (
    -- 用途：收支科目（收入/支出两套各自独立，唯一键 kind+name_key）；停用走 archived，不删行。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    kind TEXT NOT NULL CHECK (kind IN ('income','expense')),
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    builtin INTEGER NOT NULL DEFAULT 0,
    sort INTEGER NOT NULL DEFAULT 0,
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (kind, name_key)
  )`,

  // `bk_entries`：记账域**收支条目**主表（金额恒为正整数分，方向只由 `kind` 表达）。
  // `period` 是 SQLite 生成列（取 `biz_date` 前 7 位，只读、不写）；`shop_id` 是软关联（无外键，删店由
  // `shop-delete-guard` 拦）；结算状态**不双写在本表**，由 `bk_settlement_lines` JOIN 得出。
  // 写 = 条目录入 / 导入 / 改挂；读 = 台账列表、月汇总、分摊、结算候选。
  `CREATE TABLE IF NOT EXISTS bk_entries (
    -- 用途：收支条目主表（金额恒为正、方向由 kind 表达；period 是生成列）；读 = 台账/月汇总/分摊/结算候选。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    biz_date TEXT NOT NULL,
    period TEXT GENERATED ALWAYS AS (substr(biz_date, 1, 7)) STORED,
    kind TEXT NOT NULL CHECK (kind IN ('income','expense')),
    scope TEXT NOT NULL CHECK (scope IN ('shop','shared')),
    shop_id INTEGER NOT NULL DEFAULT 0,
    party_id INTEGER NOT NULL CHECK (party_id > 0),
    category_id INTEGER NOT NULL DEFAULT 0,
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    basis TEXT NOT NULL DEFAULT '',
    rule_id INTEGER NOT NULL DEFAULT 0,
    method TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
    void_reason TEXT NOT NULL DEFAULT '',
    voided_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    CHECK (scope <> 'shop' OR shop_id > 0),
    CHECK (scope <> 'shared' OR shop_id = 0)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bk_entries_period ON bk_entries(period, kind)`,
  `CREATE INDEX IF NOT EXISTS idx_bk_entries_shop   ON bk_entries(shop_id, biz_date)`,
  `CREATE INDEX IF NOT EXISTS idx_bk_entries_party  ON bk_entries(party_id, biz_date)`,
  `CREATE INDEX IF NOT EXISTS idx_bk_entries_scope  ON bk_entries(scope, status)`,

  // `bk_allocations`：公共条目（`scope='shared'`）的**分摊行**，一行 = 一条目×一店铺（`UNIQUE(entry_id,shop_id)`）。
  // 派生数据：无业务写入口，只有 `writeAllocations()` 内部整批重写；`Σ分摊 == 条目金额` 由主进程断言，
  // 不满足整笔回滚。读 = 店铺维度损益、删店校验（`shop-delete-guard`）。
  `CREATE TABLE IF NOT EXISTS bk_allocations (
    -- 用途：公共条目（scope=shared）的分摊行，一行 = 一条目×一店；派生数据，由 writeAllocations 整批重写。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    entry_id INTEGER NOT NULL REFERENCES bk_entries(id) ON DELETE CASCADE,
    shop_id INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL CHECK (amount_cents >= 0),
    ratio_bp INTEGER NOT NULL DEFAULT 0,
    UNIQUE (entry_id, shop_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_bk_alloc_shop ON bk_allocations(shop_id)`,

  // `bk_allocation_rules`：分摊方案（名称唯一；基准 equal / revenue / manual；店铺 id 与万分比存 JSON）。
  // 写 = 条目页「保存为方案」；读 = 分摊下拉套用。条目上的 `rule_id` 只作来源留痕，重算不读它。
  `CREATE TABLE IF NOT EXISTS bk_allocation_rules (
    -- 用途：分摊方案（equal/revenue/manual，店铺 id 与万分比存 JSON）；条目上的 rule_id 只留痕，重算不读。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    basis TEXT NOT NULL CHECK (basis IN ('equal','revenue','manual')),
    shop_ids TEXT NOT NULL DEFAULT '[]',
    ratios TEXT NOT NULL DEFAULT '[]',
    note TEXT NOT NULL DEFAULT '',
    archived INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE (name_key)
  )`,

  // `bk_settlements`：结算单（付款 / 收款 / 互抵结清），一行 = 一次结算；`direction` 三态，
  // `status='void'` 为作废（不删行，保留 `void_reason` / `voided_at`）。写 = 结算页；读 = 相关人余额与明细。
  SETTLEMENTS_TABLE_SQL,
  SETTLEMENTS_INDEX_SQL,

  // `bk_settlement_lines`：结算单明细（一行 = 一张单结掉的条目；`settlement_id` → `bk_settlements` 级联）。
  // 唯一性靠部分唯一索引 `WHERE active=1`（见上），作废时置 0，允许撤销后重结。写 = 结算页；读 = 条目结算状态。
  `CREATE TABLE IF NOT EXISTS bk_settlement_lines (
    -- 用途：结算单明细（一张单结掉的条目，settlement_id 级联；有效行由部分唯一索引约束，可撤销后重结）。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    settlement_id INTEGER NOT NULL REFERENCES bk_settlements(id) ON DELETE CASCADE,
    entry_id INTEGER NOT NULL REFERENCES bk_entries(id),
    amount_cents INTEGER NOT NULL CHECK (amount_cents > 0),
    active INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_bk_settle_line_entry
     ON bk_settlement_lines(entry_id) WHERE active = 1`,
  `CREATE INDEX IF NOT EXISTS idx_bk_settle_line_settle ON bk_settlement_lines(settlement_id)`,

  // `bk_transfers`：相关人之间的**承接余额**（合并相关人时把残额转给承接人；`from ≠ to` 由 CHECK 钉住）。
  // 写 = 相关人合并（`mergeParty`）；读 = 相关人余额的起始项（`partyLedger` 的 transfer 净额）。
  `CREATE TABLE IF NOT EXISTS bk_transfers (
    -- 用途：相关人之间的承接余额（合并相关人时把残额转给承接人）；读 = 相关人余额的起始项。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    from_party_id INTEGER NOT NULL,
    to_party_id INTEGER NOT NULL,
    amount_cents INTEGER NOT NULL,
    transfer_date TEXT NOT NULL,
    note TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active' CHECK (status IN ('active','void')),
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    CHECK (from_party_id <> to_party_id)
  )`,

  // `bk_op_log`：记账域操作留痕（改挂 / 合并 / 作废等），一行 = 一次动作，前后值存 JSON，**只追加不更新**。
  // 写 = `logOp()`（各写操作事务内）；读 = 操作历史面板 / 排障取证。
  `CREATE TABLE IF NOT EXISTS bk_op_log (
    -- 用途：记账域操作留痕（改挂/合并/作废等），前后值存 JSON，只追加不更新；读 = 操作历史/排障取证。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    action TEXT NOT NULL,
    entity TEXT NOT NULL,
    entity_id INTEGER NOT NULL DEFAULT 0,
    before_json TEXT NOT NULL DEFAULT '{}',
    after_json TEXT NOT NULL DEFAULT '{}',
    note TEXT NOT NULL DEFAULT '',
    at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
];

// ---------------------------------------------------------------------------
// 小工具
// ---------------------------------------------------------------------------

function num(v: unknown): number {
  const n = typeof v === 'number' ? v : Number(v);
  return Number.isFinite(n) ? n : 0;
}

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

function toKind(v: unknown): LedgerKind {
  return v === 'expense' ? 'expense' : 'income';
}

function toScope(v: unknown): LedgerScope {
  return v === 'shared' ? 'shared' : 'shop';
}

function toPartyKind(v: unknown): PartyKind {
  return (PARTY_KINDS as readonly string[]).includes(String(v)) ? (v as PartyKind) : 'other';
}

function toBasis(v: unknown): AllocBasis {
  return (ALLOC_BASES as readonly string[]).includes(String(v)) ? (v as AllocBasis) : 'equal';
}

/**
 * 日期合法性：交给 SQLite 判（`date('2026-02-30')` 会规范化成 `2026-03-02`，故不等即非法）。
 * 不在主进程另写一份 JS 日期逻辑 —— 但渲染层 `isValidBizDate` 仍保留（表单即时反馈）。
 * 两份的关系是「前端严、后端也严」，方向安全；反过来才会出现"前端放行后端拒"的怪现象。
 */
function assertBizDate(value: unknown, field: string): string {
  const s = typeof value === 'string' ? value.trim() : '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s)) throw new Error(`${field}格式必须是 YYYY-MM-DD`);
  const row = dbGet<{ d: string | null }>(`SELECT date(?) AS d`, [s]);
  if (row?.d !== s) throw new Error(`${field}不是真实存在的日期：${s}`);
  return s;
}

function assertAmountCents(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(value);
  if (!Number.isFinite(n) || !Number.isInteger(n)) throw new Error('金额必须是整数分');
  if (n <= 0) throw new Error('金额必须大于 0（方向由收/支决定，不要用负数表达）');
  if (n > MAX_AMOUNT_CENTS) throw new Error('单笔金额超出上限（10 亿元）');
  return n;
}

function logOp(
  action: string,
  entity: string,
  entityId: number,
  before: unknown,
  after: unknown,
  note = '',
): void {
  dbRun(
    `INSERT INTO bk_op_log (action, entity, entity_id, before_json, after_json, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [action, entity, entityId, JSON.stringify(before ?? {}), JSON.stringify(after ?? {}), note],
  );
}

/** 店铺是否存在（店铺域可能尚未初始化，缺表时按"不存在"处理而不是抛 no such table） */
function shopExists(shopId: number): boolean {
  if (!tableExists('sk_shops')) return false;
  const row = dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM sk_shops WHERE id = ?`, [shopId]);
  return num(row?.n) > 0;
}

// ---------------------------------------------------------------------------
// 建表 / 迁移
// ---------------------------------------------------------------------------

/**
 * 幂等初始化（每个 handler 入口都会调用；视图首次激活时也会显式调一次）。
 * 顺序要紧：先幂等 DDL 建到当前形状，再跑版本化迁移追老库，最后播种科目。
 */
export function ensureLedgerSchema(): void {
  dbMigrate(LEDGER_SCHEMA);
  // 记账表全部由上面的幂等 DDL 建立，v1 是"形状基线"的空步骤：
  // 它的作用只是把版本号写进 sk_schema_migrations，让后续 v2/v3/v4 有起点可比。
  migrate('ledger.main', [
    { version: 1, name: 'initial-shape', up: () => {} },
    { version: 2, name: 'settlements 支持互抵结清（direction=offset）', up: widenSettleDirection },
    { version: 3, name: 'bk_parties.merged_to（区分「已并入」与「手动停用」）', up: addPartyMergedTo },
    { version: 4, name: '退役 bk_periods（月结留位表，产品不做月结）', up: retirePeriodsTable },
  ]);
  seedBuiltinCategories();
}

/**
 * v4 迁移：删掉月结留位表 `bk_periods`。
 *
 * 本期产品明确不做月结 / 锁账（`docs/plans/LEDGER_PLAN.md` RK-10），这张表从未被任何代码读写，
 * 只是历史建表语句里的占位。项目尚未正式发布，没有需要保留它的存量库；将来真做锁账时，
 * 再按需新建（形状可以重新设计，不必背着这张空表）。
 */
function retirePeriodsTable(): void {
  dbRun(`DROP TABLE IF EXISTS bk_periods`);
}

/**
 * v2 迁移：把 `bk_settlements.direction` 的 CHECK 放开 `'offset'`（互抵结清）。
 *
 * 为什么必须重建表：SQLite 改不了已存在的 CHECK，也没有 `ALTER ... DROP CONSTRAINT`。
 *
 * ⚠️ 顺序**不能照抄** `product-db.ts` 的 `normalizeSkuUniqueKey`（那边先 RENAME 老表）：
 *    先 RENAME 的话，SQLite 3.25+ 会把子表
 *    `bk_settlement_lines.REFERENCES bk_settlements` 的**文本**改写成 legacy 表名；
 *    老表一 DROP，结算行就指向一张不存在的表 —— 此刻 `foreign_keys` 是 OFF（本项目全局未开启）
 *    所以**不会报错**，属于最坏的那种"看起来迁移成功、schema 已经歪了"。
 *    故这里走"建新表 → 拷数据 → DROP 老表 → 换名"：子表引用的是 `bk_settlements`，
 *    换名后正好指回新表。
 */
function widenSettleDirection(): void {
  const sql = tableSql('bk_settlements');
  if (!sql) return; // 新库：dbMigrate 已一次建到当前形状
  if (sql.includes("'offset'")) return; // 已经是新形状（重复 ensure 时短路）

  dbRun(settlementsDdl('bk_settlements_rebuild'));
  dbRun(
    `INSERT INTO bk_settlements_rebuild
       (id, party_id, settle_date, direction, amount_cents, method, note,
        status, void_reason, voided_at, created_at)
     SELECT id, party_id, settle_date, direction, amount_cents, method, note,
            status, void_reason, voided_at, created_at
     FROM bk_settlements`,
  );
  dbRun(`DROP TABLE bk_settlements`);
  dbRun(`ALTER TABLE bk_settlements_rebuild RENAME TO bk_settlements`);
  dbMigrate([SETTLEMENTS_INDEX_SQL]); // 索引随老表被 DROP 掉了，补回来
  // AUTOINCREMENT 序列也随老表一起没了；不按现存最大 id 重置，新单会复用已发出的 id
  // （`sqlite_sequence` 没有主键，不能 ON CONFLICT，只能先 UPDATE 再 INSERT）
  if (tableSql('sqlite_sequence')) {
    const maxId = Number(
      dbGet<{ m: number }>(`SELECT COALESCE(MAX(id), 0) AS m FROM bk_settlements`)?.m ?? 0,
    );
    const upd = dbRun(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'bk_settlements'`, [maxId]);
    if (!upd.changes) {
      dbRun(`INSERT INTO sqlite_sequence (name, seq) VALUES ('bk_settlements', ?)`, [maxId]);
    }
  }
}

/**
 * v3 迁移：`bk_parties` 加 `merged_to`。
 *
 * 加列**不用重建表**（SQLite 允许 `ALTER TABLE ADD COLUMN`，只要新列不带 UNIQUE/主键、
 * 且默认值是常量）—— 与 v2 改 CHECK 的情况不同，这里没有约束要放开。
 *
 * 老库里的历史合并痕迹补不回来（当时只置了 `archived=1`）：这里不做任何猜测性回填，
 * 猜错就会把"手动停用的人"标成"已并入某人"，那是比不显示更难查的错。
 */
function addPartyMergedTo(): void {
  const sql = tableSql('bk_parties');
  if (!sql) return; // 新库：dbMigrate 已一次建到当前形状
  if (sql.includes('merged_to')) return; // 重复 ensure 时短路
  dbRun(`ALTER TABLE bk_parties ADD COLUMN merged_to INTEGER NOT NULL DEFAULT 0`);
}

function seedBuiltinCategories(): void {  const row = dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM bk_categories`);
  if (num(row?.n) > 0) return;
  dbTransaction(() => {
    BUILTIN_CATEGORIES.forEach((cat, index) => {
      dbRun(
        `INSERT INTO bk_categories (kind, name, name_key, builtin, sort) VALUES (?, ?, ?, 1, ?)`,
        [cat.kind, cat.name, toNameKey(cat.name), index],
      );
    });
  });
}

// ---------------------------------------------------------------------------
// 相关人
// ---------------------------------------------------------------------------

export interface PartyRow {
  id: number;
  name: string;
  kind: PartyKind;
  phone: string;
  note: string;
  archived: boolean;
  /** 被合并到谁（0 = 没被合并）；`archived && mergedTo > 0` = 「已并入」，否则才是「手动停用」 */
  mergedTo: number;
  createdAt: string;
  updatedAt: string;
  /** 关联条目数（含作废；列表用来判断"能不能停用/合并"） */
  entryCount: number;
}

export interface PartyUpsertInput {
  id?: number;
  name?: string;
  kind?: string;
  phone?: string;
  note?: string;
  archived?: boolean;
}

const PARTY_COLS = `p.id, p.name, p.kind, p.phone, p.note, p.archived, p.merged_to, p.created_at, p.updated_at`;

function mapParty(row: Record<string, unknown>): PartyRow {
  return {
    id: num(row.id),
    name: String(row.name ?? ''),
    kind: toPartyKind(row.kind),
    phone: String(row.phone ?? ''),
    note: String(row.note ?? ''),
    archived: num(row.archived) === 1,
    mergedTo: num(row.merged_to),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    entryCount: num(row.entry_count),
  };
}

export function listParties(filter: { includeArchived?: boolean; keyword?: string } = {}): PartyRow[] {
  ensureLedgerSchema();
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (!filter.includeArchived) where.push('p.archived = 0');
  const kw = str(filter.keyword, MAX_LEN.name).trim();
  if (kw) {
    where.push(`(p.name LIKE ? OR p.phone LIKE ?)`);
    params.push(`%${kw}%`, `%${kw}%`);
  }
  const sql = `SELECT ${PARTY_COLS},
      (SELECT COUNT(*) FROM bk_entries e WHERE e.party_id = p.id) AS entry_count
    FROM bk_parties p
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY p.archived ASC, p.name ASC`;
  return dbQuery<Record<string, unknown>>(sql, params).map(mapParty);
}

/**
 * 新建 / 更新相关人。
 *
 * `name_key` 唯一是**结构性**要求：拦住"张三"与"张三 "被建成两个人（本项目已因
 * "名字兼作匹配键"栽过 3 次，这里是反向用法 —— 名字只用于去重，归属一律用 id）。
 */
export function upsertParty(input: PartyUpsertInput): { id: number; created: boolean } {
  ensureLedgerSchema();
  const id = num(input?.id);
  const name = str(input?.name, MAX_LEN.name).trim();
  if (!name) throw new Error('相关人名称不能为空');
  const nameKey = toNameKey(name);
  if (!nameKey) throw new Error('相关人名称不能只有空白字符');

  return dbTransaction(() => {
    const clash = dbGet<{ id: number }>(`SELECT id FROM bk_parties WHERE name_key = ?`, [nameKey]);
    if (clash && num(clash.id) !== id) {
      throw new Error(`已存在同名相关人（id=${num(clash.id)}），请改名或直接选用它`);
    }

    if (id > 0) {
      const existing = dbGet<Record<string, unknown>>(`SELECT * FROM bk_parties WHERE id = ?`, [id]);
      if (!existing) throw new Error('相关人不存在或已被删除');
      const before = mapParty(existing);
      const nextArchived = (input?.archived ?? before.archived) ? 1 : 0;
      // 重新启用时清掉「已并入」标记：否则启用了的人还挂着"已并入 → B"，
      // 用户会以为它仍是停用状态（`merged_to` 只描述**当前这次停用是不是合并导致的**）
      const nextMergedTo = nextArchived === 1 ? before.mergedTo : 0;
      dbRun(
        `UPDATE bk_parties SET name = ?, name_key = ?, kind = ?, phone = ?, note = ?,
           archived = ?, merged_to = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
        [
          name,
          nameKey,
          toPartyKind(input?.kind ?? before.kind),
          str(input?.phone ?? before.phone, MAX_LEN.phone),
          str(input?.note ?? before.note, MAX_LEN.note),
          nextArchived,
          nextMergedTo,
          id,
        ],
      );
      logOp('party-update', 'party', id, before, { name, nameKey });
      return { id, created: false };
    }

    const res = dbRun(
      `INSERT INTO bk_parties (name, name_key, kind, phone, note, archived) VALUES (?, ?, ?, ?, ?, ?)`,
      [
        name,
        nameKey,
        toPartyKind(input?.kind),
        str(input?.phone, MAX_LEN.phone),
        str(input?.note, MAX_LEN.note),
        input?.archived ? 1 : 0,
      ],
    );
    logOp('party-create', 'party', res.lastInsertRowid, {}, { name });
    return { id: res.lastInsertRowid, created: true };
  });
}

// ---------------------------------------------------------------------------
// 科目
// ---------------------------------------------------------------------------

export interface CategoryRow {
  id: number;
  kind: LedgerKind;
  name: string;
  builtin: boolean;
  sort: number;
  archived: boolean;
}

export function listCategories(kind?: LedgerKind, includeArchived = false): CategoryRow[] {
  ensureLedgerSchema();
  const where: string[] = [];
  const params: Array<string | number> = [];
  if (kind === 'income' || kind === 'expense') {
    where.push('kind = ?');
    params.push(kind);
  }
  if (!includeArchived) where.push('archived = 0');
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT id, kind, name, builtin, sort, archived FROM bk_categories
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY kind ASC, sort ASC, id ASC`,
    params,
  );
  return rows.map((r) => ({
    id: num(r.id),
    kind: toKind(r.kind),
    name: String(r.name ?? ''),
    builtin: num(r.builtin) === 1,
    sort: num(r.sort),
    archived: num(r.archived) === 1,
  }));
}

export function upsertCategory(input: {
  id?: number;
  kind?: string;
  name?: string;
  sort?: number;
  archived?: boolean;
}): { id: number; created: boolean } {
  ensureLedgerSchema();
  const id = num(input?.id);
  const name = str(input?.name, MAX_LEN.name).trim();
  if (!name) throw new Error('科目名称不能为空');
  const nameKey = toNameKey(name);
  const kind = toKind(input?.kind);

  return dbTransaction(() => {
    const clash = dbGet<{ id: number }>(
      `SELECT id FROM bk_categories WHERE kind = ? AND name_key = ?`,
      [kind, nameKey],
    );
    if (clash && num(clash.id) !== id) throw new Error('同类型下已有同名科目');

    if (id > 0) {
      const existing = dbGet<Record<string, unknown>>(`SELECT * FROM bk_categories WHERE id = ?`, [id]);
      if (!existing) throw new Error('科目不存在');
      if (toKind(existing.kind) !== kind) {
        // 改科目录入方向的后果是历史条目全部换到另一侧（收入变支出），必须禁止
        throw new Error('不能修改科目的收/支类型，请新建一个科目');
      }
      dbRun(`UPDATE bk_categories SET name = ?, name_key = ?, sort = ?, archived = ? WHERE id = ?`, [
        name,
        nameKey,
        Number.isFinite(Number(input?.sort)) ? Math.trunc(Number(input?.sort)) : num(existing.sort),
        (input?.archived ?? num(existing.archived) === 1) ? 1 : 0,
        id,
      ]);
      logOp('category-update', 'category', id, { name: existing.name }, { name });
      return { id, created: false };
    }

    const res = dbRun(
      `INSERT INTO bk_categories (kind, name, name_key, builtin, sort) VALUES (?, ?, ?, 0, ?)`,
      [kind, name, nameKey, Number.isFinite(Number(input?.sort)) ? Math.trunc(Number(input?.sort)) : 999],
    );
    return { id: res.lastInsertRowid, created: true };
  });
}

// ---------------------------------------------------------------------------
// 分摊方案（周期性固定开销存一次，下次一键套用）
// ---------------------------------------------------------------------------

export interface AllocRuleRow {
  id: number;
  name: string;
  basis: AllocBasis;
  shopIds: number[];
  ratios: number[];
  note: string;
  archived: boolean;
}

function parseJsonArray(raw: unknown): number[] {
  try {
    const v = JSON.parse(String(raw ?? '[]'));
    return Array.isArray(v) ? v.map((x) => num(x)) : [];
  } catch {
    return [];
  }
}

export function listAllocRules(): AllocRuleRow[] {
  ensureLedgerSchema();
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT id, name, basis, shop_ids, ratios, note, archived FROM bk_allocation_rules
     WHERE archived = 0 ORDER BY name ASC`,
  );
  return rows.map((r) => ({
    id: num(r.id),
    name: String(r.name ?? ''),
    basis: toBasis(r.basis),
    shopIds: parseJsonArray(r.shop_ids),
    ratios: parseJsonArray(r.ratios),
    note: String(r.note ?? ''),
    archived: num(r.archived) === 1,
  }));
}

export function upsertAllocRule(input: {
  id?: number;
  name?: string;
  basis?: string;
  shopIds?: number[];
  ratios?: number[];
  note?: string;
}): { id: number; created: boolean } {
  ensureLedgerSchema();
  const id = num(input?.id);
  const name = str(input?.name, MAX_LEN.name).trim();
  if (!name) throw new Error('分摊方案名称不能为空');
  const nameKey = toNameKey(name);
  const shopIds = Array.isArray(input?.shopIds) ? input!.shopIds.map((x) => num(x)).filter((x) => x > 0) : [];
  const ratios = Array.isArray(input?.ratios) ? input!.ratios.map((x) => Math.trunc(num(x))) : [];

  return dbTransaction(() => {
    const clash = dbGet<{ id: number }>(`SELECT id FROM bk_allocation_rules WHERE name_key = ?`, [nameKey]);
    if (clash && num(clash.id) !== id) throw new Error('已有同名分摊方案');

    if (id > 0) {
      const existing = dbGet<{ id: number }>(`SELECT id FROM bk_allocation_rules WHERE id = ?`, [id]);
      if (!existing) throw new Error('分摊方案不存在');
      dbRun(
        `UPDATE bk_allocation_rules SET name = ?, name_key = ?, basis = ?, shop_ids = ?, ratios = ?,
           note = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
        [
          name,
          nameKey,
          toBasis(input?.basis),
          JSON.stringify(shopIds),
          JSON.stringify(ratios),
          str(input?.note, MAX_LEN.note),
          id,
        ],
      );
      return { id, created: false };
    }

    const res = dbRun(
      `INSERT INTO bk_allocation_rules (name, name_key, basis, shop_ids, ratios, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        name,
        nameKey,
        toBasis(input?.basis),
        JSON.stringify(shopIds),
        JSON.stringify(ratios),
        str(input?.note, MAX_LEN.note),
      ],
    );
    return { id: res.lastInsertRowid, created: true };
  });
}

// ---------------------------------------------------------------------------
// 店铺引用的删除保护（`shop-account-delete` 追加判据；方案 §4）
// ---------------------------------------------------------------------------

/**
 * 某店铺在记账域被引用多少处。
 *
 * 判据只取**引用事实**，不看店铺状态：条目归属店铺 + 公共分摊行。
 * 已作废条目也算 —— 它仍留在明细里可查，删店会让历史账目失去归属；
 * 而"停用"不影响任何历史数字（店名照常显示），所以删店时一律引导去停用。
 *
 * 记账域可能从未初始化（用户没打开过记账）→ 两张表都不存在时返回 0，不抛错。
 */
export function countShopReferences(shopId: number): {
  entries: number;
  allocations: number;
  total: number;
} {
  const id = num(shopId);
  if (!Number.isInteger(id) || id <= 0) throw new Error('缺少店铺 id');
  if (!tableExists('bk_entries') || !tableExists('bk_allocations')) {
    return { entries: 0, allocations: 0, total: 0 };
  }
  const entries = num(
    dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM bk_entries WHERE shop_id = ?`, [id])?.n,
  );
  const allocations = num(
    dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM bk_allocations WHERE shop_id = ?`, [id])?.n,
  );
  return { entries, allocations, total: entries + allocations };
}

// ---------------------------------------------------------------------------
// 条目
// ---------------------------------------------------------------------------

export interface AllocationInput {
  shopId: number;
  amountCents: number;
  ratioBp?: number;
}

export interface EntryInput {
  id?: number;
  bizDate?: string;
  kind?: string;
  scope?: string;
  shopId?: number;
  partyId?: number;
  categoryId?: number;
  amountCents?: number;
  basis?: string;
  ruleId?: number;
  method?: string;
  note?: string;
  /** `scope='shared'` 时必须给；`scope='shop'` 时忽略（自动单行全额） */
  allocations?: AllocationInput[];
  /**
   * **只有批量导入给这两个字段**：`partyId` / `categoryId` 为 0 时按名字解析，
   * 库里没有就在同一事务里新建（excel 导入"自动建不存在的人与科目"的唯一入口）。
   *
   * 「记一笔」永远给 id、不给名字 —— 那条路径上"名字找不到"就是打错了字，必须报错让人改。
   * 名字只在这一刻换算成 id，之后一切按 id 走（本项目已因"名字兼作匹配键"栽过 3 次）。
   */
  partyName?: string;
  categoryName?: string;
}

export interface AllocationRowOut {
  shopId: number;
  shopName: string;
  amountCents: number;
  ratioBp: number;
}

export interface EntryListItem {
  id: number;
  bizDate: string;
  period: string;
  kind: LedgerKind;
  scope: LedgerScope;
  shopId: number;
  shopName: string;
  partyId: number;
  partyName: string;
  partyArchived: boolean;
  categoryId: number;
  categoryName: string;
  amountCents: number;
  basis: AllocBasis | '';
  /** 套用的分摊方案（`bk_allocation_rules.id`；0 = 未套用）。只作来源留痕，重算不读它 */
  ruleId: number;
  method: string;
  note: string;
  status: LedgerStatus;
  voidReason: string;
  /** 是否已被**有效**结算单占用（由结算行 JOIN 得出，不在条目上再存一份） */
  settled: boolean;
  settlementId: number;
  /** 分摊行数（公共条目显示"摊 5 家"用） */
  allocCount: number;
  /** 仅在 `filter.includeAllocations` 且 `scope='shared'` 时返回（导入查重的指纹要用） */
  allocations?: Array<{ shopId: number; amountCents: number; ratioBp: number }>;
  createdAt: string;
  updatedAt: string;
}

export interface EntryFilter {
  period?: string;
  from?: string;
  to?: string;
  kind?: string;
  scope?: string;
  shopId?: number;
  partyId?: number;
  categoryId?: number;
  /** all / settled / unsettled */
  settleStatus?: string;
  /** 含作废条目（默认不含） */
  includeVoid?: boolean;
  keyword?: string;
  limit?: number;
  offset?: number;
  /**
   * 给**公共条目**补上分摊行（只补 shopId/amountCents/ratioBp，不补店名）。
   *
   * 只有一个买家：导入查重。公共条目的指纹要含分摊签名，而列表接口默认不返回分摊行，
   * 于是"房租/工资按月重复导入"曾完全无保护（审查 P1-4）。开关存在 = 常规列表不多付一份查询。
   */
  includeAllocations?: boolean;
}

const ENTRY_SELECT = `
  SELECT e.id, e.biz_date, e.period, e.kind, e.scope, e.shop_id, e.party_id, e.category_id,
         e.amount_cents, e.basis, e.rule_id, e.method, e.note, e.status, e.void_reason,
         e.created_at, e.updated_at,
         COALESCE(s.name, '') AS shop_name,
         COALESCE(p.name, '') AS party_name,
         COALESCE(p.archived, 0) AS party_archived,
         COALESCE(c.name, '') AS category_name,
         (SELECT COUNT(*) FROM bk_allocations a WHERE a.entry_id = e.id) AS alloc_count,
         COALESCE((SELECT l.settlement_id FROM bk_settlement_lines l
                   WHERE l.entry_id = e.id AND l.active = 1), 0) AS settlement_id
  FROM bk_entries e
  LEFT JOIN bk_parties p ON p.id = e.party_id
  LEFT JOIN bk_categories c ON c.id = e.category_id
  LEFT JOIN sk_shops s ON s.id = e.shop_id`;

function mapEntry(row: Record<string, unknown>): EntryListItem {
  const settlementId = num(row.settlement_id);
  return {
    id: num(row.id),
    bizDate: String(row.biz_date ?? ''),
    period: String(row.period ?? ''),
    kind: toKind(row.kind),
    scope: toScope(row.scope),
    shopId: num(row.shop_id),
    shopName: String(row.shop_name ?? ''),
    partyId: num(row.party_id),
    partyName: String(row.party_name ?? ''),
    partyArchived: num(row.party_archived) === 1,
    categoryId: num(row.category_id),
    categoryName: String(row.category_name ?? ''),
    amountCents: num(row.amount_cents),
    basis: String(row.basis ?? '') as AllocBasis | '',
    ruleId: num(row.rule_id),
    method: String(row.method ?? ''),
    note: String(row.note ?? ''),
    status: row.status === 'void' ? 'void' : 'active',
    voidReason: String(row.void_reason ?? ''),
    settled: settlementId > 0,
    settlementId,
    allocCount: num(row.alloc_count),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

/**
 * 条目列表。
 *
 * ⚠️ `sk_shops` 可能不存在（用户从未进过基础数据页）。这里**不做**跨域建表，
 *    而是把 JOIN 放在"表存在才拼接"的表达式里 —— 缺表时店名回落空串，
 *    列表照常可用（降级而非抛 `no such table`，否则用户会以为记账页坏了）。
 */
export function listEntries(filter: EntryFilter = {}): EntryListItem[] {
  ensureLedgerSchema();
  const hasShops = tableExists('sk_shops');
  const select = hasShops
    ? ENTRY_SELECT
    : ENTRY_SELECT.replace(`LEFT JOIN sk_shops s ON s.id = e.shop_id`, `LEFT JOIN (SELECT 0 AS id, '' AS name) s ON s.id = e.shop_id`);

  const where: string[] = [];
  const params: Array<string | number> = [];

  if (filter.period) {
    where.push('e.period = ?');
    params.push(str(filter.period, 7));
  }
  if (filter.from) {
    where.push('e.biz_date >= ?');
    params.push(str(filter.from, 10));
  }
  if (filter.to) {
    where.push('e.biz_date <= ?');
    params.push(str(filter.to, 10));
  }
  if (filter.kind === 'income' || filter.kind === 'expense') {
    where.push('e.kind = ?');
    params.push(filter.kind);
  }
  if (filter.scope === 'shop' || filter.scope === 'shared') {
    where.push('e.scope = ?');
    params.push(filter.scope);
  }
  if (num(filter.shopId) > 0) {
    // 按店筛选要看**分摊行**：公共支出摊到这家店的那部分也属于这家店的成本，
    // 只按 e.shop_id 过滤会把公共支出整块漏掉（那正是用户最想看的部分之一）。
    where.push('EXISTS (SELECT 1 FROM bk_allocations a WHERE a.entry_id = e.id AND a.shop_id = ?)');
    params.push(num(filter.shopId));
  }
  if (num(filter.partyId) > 0) {
    where.push('e.party_id = ?');
    params.push(num(filter.partyId));
  }
  if (num(filter.categoryId) > 0) {
    where.push('e.category_id = ?');
    params.push(num(filter.categoryId));
  }
  if (!filter.includeVoid) where.push(`e.status = 'active'`);
  if (filter.settleStatus === 'settled') {
    where.push('EXISTS (SELECT 1 FROM bk_settlement_lines l WHERE l.entry_id = e.id AND l.active = 1)');
  } else if (filter.settleStatus === 'unsettled') {
    where.push('NOT EXISTS (SELECT 1 FROM bk_settlement_lines l WHERE l.entry_id = e.id AND l.active = 1)');
  }
  const kw = str(filter.keyword, MAX_LEN.name).trim();
  if (kw) {
    where.push('(e.note LIKE ? OR p.name LIKE ? OR c.name LIKE ?)');
    params.push(`%${kw}%`, `%${kw}%`, `%${kw}%`);
  }

  const limit = Math.min(Math.max(Math.trunc(num(filter.limit)) || 500, 1), 2000);
  const offset = Math.max(Math.trunc(num(filter.offset)) || 0, 0);

  const sql = `${select}
    ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
    ORDER BY e.biz_date DESC, e.id DESC
    LIMIT ? OFFSET ?`;
  const rows = dbQuery<Record<string, unknown>>(sql, [...params, limit, offset]).map(mapEntry);
  if (filter.includeAllocations === true) attachAllocations(rows);
  return rows;
}

/**
 * 一次性给结果集里的**公共条目**补分摊行（一条 SQL，不逐条 `getEntry`）。
 * 专属条目不需要：它的分摊行恒为"本店全额"，指纹由 `shop_id + amount` 直接表达。
 */
function attachAllocations(entries: EntryListItem[]): void {
  const shared = entries.filter((e) => e.scope === 'shared');
  if (!shared.length) return;
  const ids = shared.map((e) => e.id);
  const holes = ids.map(() => '?').join(',');
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT entry_id, shop_id, amount_cents, ratio_bp
     FROM bk_allocations
     WHERE entry_id IN (${holes})
     ORDER BY entry_id ASC, shop_id ASC`,
    ids,
  );
  const byEntry = new Map<number, Array<{ shopId: number; amountCents: number; ratioBp: number }>>();
  for (const r of rows) {
    const key = num(r.entry_id);
    const list = byEntry.get(key) ?? [];
    list.push({ shopId: num(r.shop_id), amountCents: num(r.amount_cents), ratioBp: num(r.ratio_bp) });
    byEntry.set(key, list);
  }
  for (const e of shared) {
    e.allocations = byEntry.get(e.id) ?? [];
  }
}

/** 单条详情（含分摊明细；分摊按金额降序，店名从店铺表补） */
export function getEntry(id: number): (EntryListItem & { allocations: AllocationRowOut[] }) | null {
  ensureLedgerSchema();
  const hasShops = tableExists('sk_shops');
  const select = hasShops
    ? ENTRY_SELECT
    : ENTRY_SELECT.replace(`LEFT JOIN sk_shops s ON s.id = e.shop_id`, `LEFT JOIN (SELECT 0 AS id, '' AS name) s ON s.id = e.shop_id`);
  const row = dbGet<Record<string, unknown>>(`${select} WHERE e.id = ?`, [num(id)]);
  if (!row) return null;
  const entry = mapEntry(row);
  const allocs = dbQuery<Record<string, unknown>>(
    `SELECT a.shop_id, a.amount_cents, a.ratio_bp, COALESCE(s.name, '') AS shop_name
     FROM bk_allocations a
     ${hasShops ? 'LEFT JOIN sk_shops s ON s.id = a.shop_id' : `LEFT JOIN (SELECT 0 AS id, '' AS name) s ON s.id = a.shop_id`}
     WHERE a.entry_id = ?
     ORDER BY a.amount_cents DESC, a.shop_id ASC`,
    [entry.id],
  ).map((r) => ({
    shopId: num(r.shop_id),
    shopName: String(r.shop_name ?? ''),
    amountCents: num(r.amount_cents),
    ratioBp: num(r.ratio_bp),
  }));
  return { ...entry, allocations: allocs };
}

/** 该条目是否已被有效结算单占用 */
function activeSettlementOf(entryId: number): number {
  const row = dbGet<{ settlement_id: number }>(
    `SELECT settlement_id FROM bk_settlement_lines WHERE entry_id = ? AND active = 1`,
    [entryId],
  );
  return num(row?.settlement_id);
}

/**
 * 校验并归一目标分摊行（**不做分摊计算**，只做守恒断言与形状消毒）。
 *
 * 守恒断言不通过时抛错并回滚整个事务 —— 宁可保存失败，也不要把一个合计对不上的
 * 分摊写进库：那种数据在界面上看不出异常，只会让汇总页和总账差几分钱（RK-05）。
 */
function normalizeAllocations(
  scope: LedgerScope,
  shopId: number,
  amountCents: number,
  input: AllocationInput[] | undefined,
): Array<{ shopId: number; amountCents: number; ratioBp: number }> {
  if (scope === 'shop') {
    // 专属店：单行全额，不接受外部传值（传了也不看，避免两套来源打架）
    return [{ shopId, amountCents, ratioBp: 10000 }];
  }

  const rows = Array.isArray(input) ? input : [];
  if (!rows.length) throw new Error('公共支出必须提供分摊明细');
  const seen = new Set<number>();
  const normalized = rows.map((r) => {
    const sid = num(r?.shopId);
    if (!Number.isInteger(sid) || sid <= 0) throw new Error('分摊行缺少有效的店铺 id');
    if (seen.has(sid)) throw new Error(`分摊行店铺重复：${sid}`);
    seen.add(sid);
    if (!shopExists(sid)) throw new Error(`分摊到的店铺不存在或已被删除：${sid}`);
    const amount = num(r?.amountCents);
    if (!Number.isInteger(amount) || amount < 0) throw new Error('分摊金额必须是 ≥ 0 的整数分');
    const bp = num(r?.ratioBp);
    if (!Number.isInteger(bp) || bp < 0 || bp > 10000) throw new Error('分摊比例必须在 0~10000 之间');
    return { shopId: sid, amountCents: amount, ratioBp: bp };
  });

  const sum = normalized.reduce((s, r) => s + r.amountCents, 0);
  if (sum !== amountCents) {
    throw new Error(`分摊合计 ${sum} 分 ≠ 条目金额 ${amountCents} 分（差 ${sum - amountCents} 分），已拒绝保存`);
  }
  return normalized.sort((a, b) => a.shopId - b.shopId);
}

/** 目标分摊与库中现值是否逐行相同（相同则不写，保证 updated_at 不虚动） */
function sameAllocations(entryId: number, target: Array<{ shopId: number; amountCents: number }>): boolean {
  const current = dbQuery<{ shop_id: number; amount_cents: number }>(
    `SELECT shop_id, amount_cents FROM bk_allocations WHERE entry_id = ?`,
    [entryId],
  );
  if (current.length !== target.length) return false;
  const map = new Map<number, number>();
  for (const row of current) map.set(num(row.shop_id), num(row.amount_cents));
  for (const t of target) {
    if (map.get(t.shopId) !== t.amountCents) return false;
    map.delete(t.shopId);
  }
  return map.size === 0;
}

function writeAllocations(
  entryId: number,
  target: Array<{ shopId: number; amountCents: number; ratioBp: number }>,
): void {
  if (sameAllocations(entryId, target)) return; // 幂等：分摊没变就不动，避免 updated_at 漂移
  dbRun(`DELETE FROM bk_allocations WHERE entry_id = ?`, [entryId]);
  for (const row of target) {
    dbRun(
      `INSERT INTO bk_allocations (entry_id, shop_id, amount_cents, ratio_bp) VALUES (?, ?, ?, ?)`,
      [entryId, row.shopId, row.amountCents, row.ratioBp],
    );
  }
  // 落库后再断言一次（防的是"上面某处写错列"这种低级错，不是防算法）
  const check = dbGet<{ total: number }>(
    `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM bk_allocations WHERE entry_id = ?`,
    [entryId],
  );
  const entry = dbGet<{ amount_cents: number }>(`SELECT amount_cents FROM bk_entries WHERE id = ?`, [entryId]);
  if (num(check?.total) !== num(entry?.amount_cents)) {
    throw new Error('分摊守恒断言失败：落库后合计与条目金额不一致，已回滚');
  }
}

/**
 * 新建 / 更新条目。
 *
 * `id=0` 新增；`id>0` 更新（**局部语义**：未传的字段保持原值）。
 * 已被有效结算单占用的条目**禁止改金额/方向/范围/店铺/相关人** —— 否则结算单金额
 * 与它结的那些条目对不上，而结算单本身看起来毫无异常（方案 §6.3 的对账前提）。
 * 改备注、改科目、改日期是允许的（不影响金额与归属）。
 */
export function upsertEntry(input: EntryInput): {
  id: number;
  created: boolean;
  allocations: number;
  settledLocked: boolean;
} {
  ensureLedgerSchema();
  const id = num(input?.id);

  return dbTransaction(() => {
    const existing =
      id > 0
        ? dbGet<Record<string, unknown>>(`SELECT * FROM bk_entries WHERE id = ?`, [id])
        : undefined;
    if (id > 0 && !existing) throw new Error('条目不存在或已被删除');

    const bizDate = assertBizDate(input?.bizDate ?? String(existing?.biz_date ?? ''), '发生日期');
    const kind = input?.kind !== undefined ? toKind(input.kind) : toKind(existing?.kind);
    const scope = input?.scope !== undefined ? toScope(input.scope) : toScope(existing?.scope);
    const amountCents =
      input?.amountCents !== undefined
        ? assertAmountCents(input.amountCents)
        : assertAmountCents(num(existing?.amount_cents));

    const partyId = input?.partyId !== undefined ? num(input.partyId) : num(existing?.party_id);
    // 相关人必填：0 / 空一律拒（结构上还有 CHECK (party_id > 0) 兜一层）
    if (!Number.isInteger(partyId) || partyId <= 0) throw new Error('请选择资金相关人（必填）');
    const party = dbGet<{ id: number; archived: number }>(`SELECT id, archived FROM bk_parties WHERE id = ?`, [partyId]);
    if (!party) throw new Error('所选相关人不存在');
    // 已停用的人：**只有"换人"才要求未停用**。相关人没改动就允许保存，
    // 否则挂在离职员工身上的历史条目会变成"改个备注都存不了"。
    const partyChanged = !existing || num(existing.party_id) !== partyId;
    if (num(party.archived) === 1 && partyChanged) throw new Error('所选相关人已停用，请选择其他相关人');

    let shopId = input?.shopId !== undefined ? num(input.shopId) : num(existing?.shop_id);
    if (scope === 'shop') {
      if (!Number.isInteger(shopId) || shopId <= 0) throw new Error('专属支出必须选择店铺');
      if (!shopExists(shopId)) throw new Error('所选店铺不存在或已被删除');
    } else {
      shopId = 0; // 公共条目不带店铺；结构上有 CHECK (scope='shared' ⇒ shop_id=0) 兜底
    }

    const categoryId = input?.categoryId !== undefined ? num(input.categoryId) : num(existing?.category_id);
    if (categoryId > 0) {
      const cat = dbGet<{ id: number; kind: string; archived: number }>(
        `SELECT id, kind, archived FROM bk_categories WHERE id = ?`,
        [categoryId],
      );
      if (!cat) throw new Error('所选科目不存在');
      if (String(cat.kind) !== kind) throw new Error('科目类型与收/支方向不一致');
      if (num(cat.archived) === 1 && num(existing?.category_id) !== categoryId) {
        throw new Error('所选科目已停用');
      }
    }

    // ---- 已结算条目的改动边界 ----
    // 位置必须在**分摊计算之前**：否则改 `scope` 时会先撞上"公共支出必须提供分摊明细"，
    // 把真正的原因（这条已被结算单占用）盖住，用户按提示去补分摊、补完还是存不了。
    const lockedSettlementId = id > 0 ? activeSettlementOf(id) : 0;
    let settledLocked = false;
    if (lockedSettlementId > 0) {
      const changedAmount = num(existing?.amount_cents) !== amountCents;
      const changedKind = toKind(existing?.kind) !== kind;
      const changedParty = num(existing?.party_id) !== partyId;
      const changedScope = toScope(existing?.scope) !== scope || num(existing?.shop_id) !== shopId;
      if (changedAmount || changedKind || changedParty || changedScope) {
        throw new Error(
          `该条目已被结算单 #${lockedSettlementId} 占用，改动金额/方向/归属会让那张结算单对不上账。请先撤销结算。`,
        );
      }
      settledLocked = true;
    }

    const basis = scope === 'shared' ? toBasis(input?.basis ?? existing?.basis) : '';
    /**
     * 更新时前端可能只改备注而没重传分摊 —— 此时沿用库中现值，
     * 但**金额改过就必须重算**：沿用旧分摊会让合计与新金额不符，等于绕过守恒断言。
     * （前端只传 `allocations` 就重算，不传就沿用；两种情形都以守恒断言收尾。）
     */
    const hasNewAllocs = Array.isArray(input?.allocations) && input!.allocations!.length > 0;
    let target: Array<{ shopId: number; amountCents: number; ratioBp: number }>;
    if (scope === 'shared' && existing && toScope(existing.scope) === 'shared' && !hasNewAllocs) {
      target = dbQuery<Record<string, unknown>>(
        `SELECT shop_id, amount_cents, ratio_bp FROM bk_allocations WHERE entry_id = ? ORDER BY shop_id ASC`,
        [id],
      ).map((r) => ({ shopId: num(r.shop_id), amountCents: num(r.amount_cents), ratioBp: num(r.ratio_bp) }));
      if (!target.length) throw new Error('公共支出缺少分摊明细，请重新分摊');
      const sum = target.reduce((s, r) => s + r.amountCents, 0);
      if (sum !== amountCents) {
        throw new Error(`金额已改为 ${amountCents} 分，但原分摊合计是 ${sum} 分，请重新分摊后再保存`);
      }
    } else {
      target = normalizeAllocations(scope, shopId, amountCents, input?.allocations);
    }

    const fields = {
      bizDate,
      kind,
      scope,
      shopId,
      partyId,
      categoryId,
      amountCents,
      basis,
      ruleId: input?.ruleId !== undefined ? num(input.ruleId) : num(existing?.rule_id),
      method: input?.method !== undefined ? str(input.method, MAX_LEN.method) : String(existing?.method ?? ''),
      note: input?.note !== undefined ? str(input.note, MAX_LEN.note) : String(existing?.note ?? ''),
    };

    let entryId = id;
    let created = false;
    if (id > 0) {
      dbRun(
        `UPDATE bk_entries SET biz_date = ?, kind = ?, scope = ?, shop_id = ?, party_id = ?,
           category_id = ?, amount_cents = ?, basis = ?, rule_id = ?, method = ?, note = ?,
           updated_at = datetime('now','localtime') WHERE id = ?`,
        [
          fields.bizDate,
          fields.kind,
          fields.scope,
          fields.shopId,
          fields.partyId,
          fields.categoryId,
          fields.amountCents,
          fields.basis,
          fields.ruleId,
          fields.method,
          fields.note,
          entryId,
        ],
      );
      logOp('entry-update', 'entry', entryId, { amount_cents: existing?.amount_cents }, { amount_cents: amountCents });
    } else {
      const res = dbRun(
        `INSERT INTO bk_entries (biz_date, kind, scope, shop_id, party_id, category_id,
           amount_cents, basis, rule_id, method, note)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          fields.bizDate,
          fields.kind,
          fields.scope,
          fields.shopId,
          fields.partyId,
          fields.categoryId,
          fields.amountCents,
          fields.basis,
          fields.ruleId,
          fields.method,
          fields.note,
        ],
      );
      entryId = res.lastInsertRowid;
      created = true;
      logOp('entry-create', 'entry', entryId, {}, { amount_cents: amountCents, kind });
    }

    writeAllocations(entryId, target);
    return { id: entryId, created, allocations: target.length, settledLocked };
  });
}

/**
 * 作废条目（不是删除）。
 *
 * 已结算的条目不能作废：结算单里那几行会指向一条"不存在的收入/支出"，
 * 往来余额凭空多出来一块。必须先撤销结算单。
 */
export function voidEntry(id: number, reason: string): { id: number; voided: boolean } {
  ensureLedgerSchema();
  const entryId = num(id);
  const why = str(reason, MAX_LEN.reason).trim();
  if (!why) throw new Error('作废必须填写原因');

  return dbTransaction(() => {
    const existing = dbGet<{ id: number; status: string; amount_cents: number }>(
      `SELECT id, status, amount_cents FROM bk_entries WHERE id = ?`,
      [entryId],
    );
    if (!existing) throw new Error('条目不存在');
    if (String(existing.status) === 'void') return { id: entryId, voided: false };

    const lockedSettlementId = activeSettlementOf(entryId);
    if (lockedSettlementId > 0) {
      throw new Error(`该条目已被结算单 #${lockedSettlementId} 占用，请先撤销结算再作废`);
    }

    dbRun(
      `UPDATE bk_entries SET status = 'void', void_reason = ?, voided_at = datetime('now','localtime'),
         updated_at = datetime('now','localtime') WHERE id = ?`,
      [why, entryId],
    );
    logOp('entry-void', 'entry', entryId, { status: 'active' }, { status: 'void', reason: why });
    return { id: entryId, voided: true };
  });
}

/**
 * 批量作废（导入撤销用）。
 *
 * **整批一个事务**：撤销导入时用户的心智是"这批当没发生过"，成功 9 条、失败 1 条
 * 比一条都没撤更难收拾 —— 他得自己找出哪条没撤掉。
 *
 * 逐条复用 `voidEntry`（better-sqlite3 的嵌套 transaction 走 savepoint，安全）：
 * 「已结算不能作废」这条规则只允许有一处实现，抄一遍就会有一天两处不一致。
 */
export function voidEntries(ids: number[], reason: string): { voided: number; ids: number[] } {
  ensureLedgerSchema();
  const why = String(reason ?? '').trim();
  if (!why) throw new Error('作废必须填写原因');
  const list: number[] = [];
  for (const raw of Array.isArray(ids) ? ids : []) {
    const n = num(raw);
    if (n > 0 && !list.includes(n)) list.push(n);
  }
  if (!list.length) throw new Error('没有要作废的条目');

  return dbTransaction(() => {
    const done: number[] = [];
    for (const id of list) {
      try {
        if (voidEntry(id, why).voided) done.push(id);
      } catch (err: unknown) {
        // 带上条目号：批量失败时"哪一条"比"为什么"更需要先知道
        const msg = err instanceof Error ? err.message : String(err);
        throw new Error(`条目 #${id}：${msg}`);
      }
    }
    return { voided: done.length, ids: done };
  });
}

/**
 * 恢复作废条目（`void` → `active`）。
 *
 * 方案 §9 早就写了"P2 提供恢复"，但一直只有作废没有反向操作：导入错了 1000 行、或手滑作废一笔，
 * 只能一条条重记（审查 §5-5）。这里不加时间窗 —— 能不能恢复只取决于"当前是否被有效结算单占用"，
 * 与作废了多久无关。
 *
 * 分摊行在作废时是**保留**的（只置 status），所以恢复后金额与出入立刻回到原样，不需要重算分摊。
 * 仍然要断言一次守恒：万一分摊行被外部删过，恢复出来的就是一条"金额对不上"的账。
 */
export function restoreEntry(id: number): { id: number; restored: boolean } {
  ensureLedgerSchema();
  const entryId = num(id);
  if (!(entryId > 0)) throw new Error('条目 id 不合法');

  return dbTransaction(() => {
    const existing = dbGet<{ id: number; status: string; amount_cents: number }>(
      `SELECT id, status, amount_cents FROM bk_entries WHERE id = ?`,
      [entryId],
    );
    if (!existing) throw new Error('条目不存在');
    if (String(existing.status) !== 'void') return { id: entryId, restored: false };

    const lockedSettlementId = activeSettlementOf(entryId);
    if (lockedSettlementId > 0) {
      throw new Error(`该条目已被结算单 #${lockedSettlementId} 占用，不能恢复为有效`);
    }

    const allocSum = num(
      dbGet<{ total: number }>(`SELECT COALESCE(SUM(amount_cents), 0) AS total FROM bk_allocations WHERE entry_id = ?`, [
        entryId,
      ])?.total,
    );
    if (allocSum !== num(existing.amount_cents)) {
      throw new Error(
        `分摊行合计 ${allocSum / 100} 与金额 ${num(existing.amount_cents) / 100} 不一致，无法恢复；请重记这一笔`,
      );
    }

    // `voided_at` 是 `NOT NULL DEFAULT ''`（不是可空列）：清空要写回空串，写 NULL 会直接撞约束
    dbRun(
      `UPDATE bk_entries SET status = 'active', void_reason = '', voided_at = '',
         updated_at = datetime('now','localtime') WHERE id = ?`,
      [entryId],
    );
    logOp('entry-restore', 'entry', entryId, { status: 'void' }, { status: 'active' });
    return { id: entryId, restored: true };
  });
}

// ---------------------------------------------------------------------------
// 往来（相关人轴）
// ---------------------------------------------------------------------------
export interface PartyLedgerRow {
  partyId: number;
  partyName: string;
  kind: PartyKind;
  archived: boolean;
  /** 被合并到谁（0 = 没被合并）：台账据此写「已并入 → B」并给跳转 */
  mergedTo: number;
  receivableCents: number;
  payableCents: number;
  netCents: number;
  settledNetCents: number;
  unsettledCents: number;
  /** 应收方向还能结多少（= 应收 − 已收 + 正向承接） */
  unsettledReceivableCents: number;
  /** 应付方向还能结多少（= 应付 − 已付 + 负向承接） */
  unsettledPayableCents: number;
  /** 承接自他人的余额（`bk_transfers` 净额，正 = 增加应收） */
  transferCents: number;
  lastSettleDate: string;
}

/**
 * 往来余额的唯一权威实现（SQL）。
 *
 * 与 `src/lib/partyLedger.ts` 的关系：那边是**同一口径的 JS 表达**，用于界面预演与
 * 单测覆盖；这边的 SQL 是落库口径，结算拦截以本函数为准。两者用
 * `scripts/ledger-db-smoke.cjs` 的交叉校验保证同构（同一组数据两边结果必须相等）。
 *
 * 为什么用两个子查询而不是两个 LEFT JOIN：条目与结算单是一对多关系，
 * 直接 JOIN 会做笛卡尔积，`SUM` 立刻翻倍 —— 这类错在页面上表现为"金额莫名乘了几倍"，
 * 极难查。分别聚合再 JOIN 是唯一安全的写法。
 *
 * ⚠️ 已结算金额按**结算行所关联条目的收/支**聚合，**不按单据的 `direction`**：
 *   互抵单（`direction='offset'`）一张单里同时挂着收入行与支出行，单据方向拆不出毛额，
 *   而"可收 / 可付"两个数必须各减各的毛额才能同时归零。普通单只含同一类行，两种算法等价，
 *   所以这个改法对存量数据是安全的（`scripts/ledger-db-smoke.cjs` 有交叉校验）。
 */
export function partyLedger(filter: { includeArchived?: boolean; partyId?: number } = {}): PartyLedgerRow[] {
  // 这里**不无条件调 `ensureLedgerSchema()`**：本函数会在 `createSettlement` / `mergeParty`
  // 的事务内部被调用，每次都重跑一遍建表 DDL 是白白开销（幂等不代表免费）。
  // 空库首次调用才建表，其余情况一次 sqlite_master 查询就够。
  if (!tableExists('bk_parties')) ensureLedgerSchema();
  const where: string[] = [];
  const params: Array<number> = [];
  if (!filter.includeArchived) where.push('p.archived = 0');
  if (num(filter.partyId) > 0) {
    where.push('p.id = ?');
    params.push(num(filter.partyId));
  }

  const rows = dbQuery<Record<string, unknown>>(
    `SELECT p.id, p.name, p.kind, p.archived, p.merged_to,
       COALESCE(en.receivable, 0) AS receivable,
       COALESCE(en.payable, 0)    AS payable,
       COALESCE(st.settled_pay, 0)     AS settled_pay,
       COALESCE(st.settled_receive, 0) AS settled_receive,
       COALESCE(tr.transfer_net, 0) AS transfer_net,
       COALESCE(st.last_date, '') AS last_date
     FROM bk_parties p
     LEFT JOIN (
       SELECT party_id,
         SUM(CASE WHEN kind = 'income'  THEN amount_cents ELSE 0 END) AS receivable,
         SUM(CASE WHEN kind = 'expense' THEN amount_cents ELSE 0 END) AS payable
       FROM bk_entries WHERE status = 'active' GROUP BY party_id
     ) en ON en.party_id = p.id
     LEFT JOIN (
       SELECT s.party_id,
         SUM(CASE WHEN e.kind = 'expense' THEN l.amount_cents ELSE 0 END) AS settled_pay,
         SUM(CASE WHEN e.kind = 'income'  THEN l.amount_cents ELSE 0 END) AS settled_receive,
         MAX(s.settle_date) AS last_date
       FROM bk_settlements s
       JOIN bk_settlement_lines l ON l.settlement_id = s.id AND l.active = 1
       JOIN bk_entries e ON e.id = l.entry_id
       WHERE s.status = 'active'
       GROUP BY s.party_id
     ) st ON st.party_id = p.id
     LEFT JOIN (
       SELECT t.party_id, SUM(t.amount_cents) AS transfer_net FROM (
         SELECT to_party_id AS party_id,  amount_cents FROM bk_transfers WHERE status = 'active'
         UNION ALL
         SELECT from_party_id AS party_id, -amount_cents FROM bk_transfers WHERE status = 'active'
       ) t GROUP BY t.party_id
     ) tr ON tr.party_id = p.id
     ${where.length ? `WHERE ${where.join(' AND ')}` : ''}
     ORDER BY p.archived ASC, p.name ASC`,
    params,
  );

  return rows.map((r) => {
    const receivableCents = num(r.receivable);
    const payableCents = num(r.payable);
    const netCents = receivableCents - payableCents;
    const settledPayCents = num(r.settled_pay);
    const settledReceiveCents = num(r.settled_receive);
    const settledNetCents = settledPayCents - settledReceiveCents;
    const transferCents = num(r.transfer_net);
    return {
      partyId: num(r.id),
      partyName: String(r.name ?? ''),
      kind: toPartyKind(r.kind),
      archived: num(r.archived) === 1,
      mergedTo: num(r.merged_to),
      receivableCents,
      payableCents,
      netCents,
      settledNetCents,
      // 加号：见 `src/lib/partyLedger.ts` 文件头的口径 §3（方案 v1.1 §6.2 原写减法，符号反了）
      unsettledCents: netCents + settledNetCents + transferCents,
      // 分方向余额：两个数之差恒等于净额（承接按符号归到对应方向）
      unsettledReceivableCents: receivableCents - settledReceiveCents + Math.max(transferCents, 0),
      unsettledPayableCents: payableCents - settledPayCents + Math.max(-transferCents, 0),
      transferCents,
      lastSettleDate: String(r.last_date ?? ''),
    };
  });
}

/** 单人的往来余额（结算拦截用，避免把整张表拉回来） */
export function partyBalanceOf(partyId: number) {
  const rows = partyLedger({ includeArchived: true, partyId });
  return rows[0] ?? null;
}

// ---------------------------------------------------------------------------
// 结算
// ---------------------------------------------------------------------------

export interface SettlementInput {
  partyId?: number;
  settleDate?: string;
  direction?: string;
  entryIds?: number[];
  method?: string;
  note?: string;
}

/**
 * 创建结算单。
 *
 * 三件套（方案 §6.3）在这里落地：
 *   ① **金额不接受前端传值** —— 一律由服务端按勾选条目求和，结构上没有第二个数；
 *   ② **幂等** —— `uq_bk_settle_line_entry ... WHERE active=1` 让"一条被两张有效单结"
 *      在数据库层就失败，不靠应用层先查后插（那是典型的竞态写法）；
 *   ③ **超额与方向拦截** —— 按 SQL 算出的未结清判定，方向不符直接拒（方向错了比金额错更隐蔽）。
 */
export function createSettlement(input: SettlementInput): {
  id: number;
  /** 毛额 = 结算行之和（对账断言的基准） */
  amountCents: number;
  entryCount: number;
  /** 实际资金流：正 = 我净付出去，负 = 我净收到，0 = 完全对冲（互抵单才有负/零） */
  cashCents: number;
} {
  ensureLedgerSchema();
  const partyId = num(input?.partyId);
  if (partyId <= 0) throw new Error('结算必须指定相关人');
  const party = dbGet<{ id: number; name: string }>(`SELECT id, name FROM bk_parties WHERE id = ?`, [partyId]);
  if (!party) throw new Error('相关人不存在');

  const direction: SettleDirection = toSettleDirection(input?.direction);
  const settleDate = assertBizDate(input?.settleDate, '结算日期');
  const ids = Array.isArray(input?.entryIds) ? [...new Set(input!.entryIds.map((x) => num(x)).filter((x) => x > 0))] : [];
  if (!ids.length) throw new Error('请至少勾选一条要结算的条目');

  return dbTransaction(() => {
    // 逐条核验：属于这个人、有效、且未被其他有效结算单占用
    const placeholders = ids.map(() => '?').join(',');
    const entries = dbQuery<{ id: number; amount_cents: number; party_id: number; status: string; kind: string }>(
      `SELECT id, amount_cents, party_id, status, kind FROM bk_entries WHERE id IN (${placeholders})`,
      ids,
    );
    if (entries.length !== ids.length) {
      const found = new Set(entries.map((e) => num(e.id)));
      const missing = ids.filter((x) => !found.has(x));
      throw new Error(`有 ${missing.length} 条条目不存在（id: ${missing.join(', ')}）`);
    }
    for (const e of entries) {
      if (num(e.party_id) !== partyId) {
        throw new Error(`条目 #${num(e.id)} 不属于「${String(party.name)}」，不能一起结算`);
      }
      if (String(e.status) !== 'active') throw new Error(`条目 #${num(e.id)} 已作废，不能结算`);
      // 方向必须与条目的收/支一致：拿收入条目做「我付给对方」，会把应收方向的余额
      // 记成已付，两边同时算错，而且台账上五个数看起来都"有值"。
      // 互抵单（offset）例外 —— 它两边都收，校验改成"必须同时存在两类"（见下方）。
      if (direction !== 'offset') {
        const wantKind = direction === 'pay' ? 'expense' : 'income';
        if (String(e.kind) !== wantKind) {
          throw new Error(
            `「${direction === 'pay' ? '我付给对方' : '对方付给我'}」只能结算${wantKind === 'expense' ? '支出' : '收入'}条目，条目 #${num(e.id)} 不是`,
          );
        }
      }
      const used = activeSettlementOf(num(e.id));
      if (used > 0) throw new Error(`条目 #${num(e.id)} 已结算过（结算单 #${used}），不能重复结算`);
    }

    // 金额：服务端求和，唯一算法。**存的是毛额**（行和），实际资金流是派生值 ——
    // 若把净额落库，`amount_cents == Σ行` 这条对账断言就失效，"手改金额"与"勾错条目"
    // 会长得一样，无法区分（方案 §6.3 的原始理由）。
    const amountCents = entries.reduce((s, e) => s + num(e.amount_cents), 0);
    if (amountCents <= 0) throw new Error('所选条目金额合计为 0，无法结算');
    const payCents = entries
      .filter((e) => String(e.kind) === 'expense')
      .reduce((s, e) => s + num(e.amount_cents), 0);
    const receiveCents = entries
      .filter((e) => String(e.kind) === 'income')
      .reduce((s, e) => s + num(e.amount_cents), 0);

    // 上限取**同方向**余额，不取净额：同一个供应商可能既欠我钱又该我付，
    // 净额更小会把"该付的那笔"误判成超额（见 partyLedger.ts 的 canSettle 注释）。
    const balance = partyBalanceOf(partyId);
    if (!balance) throw new Error('相关人往来余额读取失败');

    if (direction === 'offset') {
      // 互抵必须两边都有。只勾单方向说明这是普通结算，不是互抵 —— 放过去的话
      // 「互抵」就退化成一个不产生任何效果、却让用户以为"抵过了"的标签。
      if (payCents <= 0 || receiveCents <= 0) {
        throw new Error(
          '互抵结清必须同时勾选收入与支出条目；只勾单方向请改选「我付给对方」或「对方付给我」',
        );
      }
      if (payCents > balance.unsettledPayableCents) {
        throw new Error(
          `互抵里的支出部分 ${payCents} 分超出应付未结清 ${balance.unsettledPayableCents} 分`,
        );
      }
      if (receiveCents > balance.unsettledReceivableCents) {
        throw new Error(
          `互抵里的收入部分 ${receiveCents} 分超出应收未结清 ${balance.unsettledReceivableCents} 分`,
        );
      }
    } else {
      const available =
        direction === 'pay' ? balance.unsettledPayableCents : balance.unsettledReceivableCents;
      if (available <= 0) {
        const other =
          direction === 'pay' ? balance.unsettledReceivableCents : balance.unsettledPayableCents;
        const hint =
          other > 0
            ? `；另有 ${other} 分在${direction === 'pay' ? '应收' : '应付'}方向，请改选结算方向`
            : '';
        throw new Error(
          `这个人在「${direction === 'pay' ? '应付' : '应收'}」方向已经没有余额了，没有可结算的条目${hint}`,
        );
      }
      if (amountCents > available) {
        throw new Error(`结算金额超出该方向未结清 ${available} 分（本期不支持预付/多付）`);
      }
    }

    const res = dbRun(
      `INSERT INTO bk_settlements (party_id, settle_date, direction, amount_cents, method, note)
       VALUES (?, ?, ?, ?, ?, ?)`,
      [
        partyId,
        settleDate,
        direction,
        amountCents,
        str(input?.method, MAX_LEN.method),
        str(input?.note, MAX_LEN.note),
      ],
    );
    const settlementId = res.lastInsertRowid;

    for (const e of entries) {
      dbRun(
        `INSERT INTO bk_settlement_lines (settlement_id, entry_id, amount_cents, active)
         VALUES (?, ?, ?, 1)`,
        [settlementId, num(e.id), num(e.amount_cents)],
      );
    }

    // 对账断言：结算单金额必须等于其结算行之和（手改/漏插都会在这里暴露）
    const lineSum = dbGet<{ total: number }>(
      `SELECT COALESCE(SUM(amount_cents), 0) AS total FROM bk_settlement_lines
       WHERE settlement_id = ? AND active = 1`,
      [settlementId],
    );
    if (num(lineSum?.total) !== amountCents) {
      throw new Error('结算单金额与结算行合计不一致，已回滚');
    }

    // 实际资金流 = 支出行 − 收入行：正 = 我净付出去，负 = 我净收到，0 = 完全对冲。
    // 它是**派生值不落库**（单份真相在结算行里），否则"单据金额"会有毛额/净额两套口径。
    const cashCents = payCents - receiveCents;
    logOp('settle', 'settlement', settlementId, {}, {
      partyId,
      direction,
      amountCents,
      payCents,
      receiveCents,
      cashCents,
      entryIds: ids,
    });
    return { id: settlementId, amountCents, entryCount: entries.length, cashCents };
  });
}

/**
 * 撤销结算（作废，不删行）。
 *
 * 结算行置 `active=0` 而不是删除：① 保留"这张单当时结了哪几条"的痕迹；
 * ② 让部分唯一索引放行，这批条目可以重新结算。
 */
export function voidSettlement(id: number, reason: string): { id: number; voided: boolean } {
  ensureLedgerSchema();
  const settlementId = num(id);
  const why = str(reason, MAX_LEN.reason).trim();
  if (!why) throw new Error('撤销结算必须填写原因');

  return dbTransaction(() => {
    const existing = dbGet<{ id: number; status: string; amount_cents: number }>(
      `SELECT id, status, amount_cents FROM bk_settlements WHERE id = ?`,
      [settlementId],
    );
    if (!existing) throw new Error('结算单不存在');
    if (String(existing.status) === 'void') return { id: settlementId, voided: false };

    dbRun(
      `UPDATE bk_settlements SET status = 'void', void_reason = ?,
         voided_at = datetime('now','localtime') WHERE id = ?`,
      [why, settlementId],
    );
    dbRun(`UPDATE bk_settlement_lines SET active = 0 WHERE settlement_id = ?`, [settlementId]);
    logOp('settle-void', 'settlement', settlementId, { status: 'active' }, { status: 'void', reason: why });
    return { id: settlementId, voided: true };
  });
}

export function listSettlements(partyId?: number): Array<{
  id: number;
  partyId: number;
  partyName: string;
  settleDate: string;
  direction: SettleDirection;
  /** 毛额 = 结算行之和 */
  amountCents: number;
  /** 支出侧毛额（互抵单里我付出的部分；普通 pay 单等于 amountCents） */
  payCents: number;
  /** 收入侧毛额（互抵单里我收到的部分；普通 receive 单等于 amountCents） */
  receiveCents: number;
  /** 实际资金流 = pay − receive：正 = 我净付出，负 = 我净收到，0 = 完全对冲 */
  cashCents: number;
  method: string;
  note: string;
  status: LedgerStatus;
  voidReason: string;
  entryCount: number;
}> {
  ensureLedgerSchema();
  const params: Array<number> = [];
  let where = '';
  if (num(partyId) > 0) {
    where = 'WHERE s.party_id = ?';
    params.push(num(partyId));
  }
  return dbQuery<Record<string, unknown>>(
    `SELECT s.id, s.party_id, s.settle_date, s.direction, s.amount_cents, s.method, s.note,
            s.status, s.void_reason, COALESCE(p.name, '') AS party_name,
            (SELECT COUNT(*) FROM bk_settlement_lines l WHERE l.settlement_id = s.id AND l.active = 1) AS entry_count,
            COALESCE((SELECT SUM(l.amount_cents) FROM bk_settlement_lines l
                        JOIN bk_entries e ON e.id = l.entry_id
                       WHERE l.settlement_id = s.id AND l.active = 1 AND e.kind = 'expense'), 0) AS pay_cents,
            COALESCE((SELECT SUM(l.amount_cents) FROM bk_settlement_lines l
                        JOIN bk_entries e ON e.id = l.entry_id
                       WHERE l.settlement_id = s.id AND l.active = 1 AND e.kind = 'income'), 0) AS receive_cents
     FROM bk_settlements s
     LEFT JOIN bk_parties p ON p.id = s.party_id
     ${where}
     ORDER BY s.settle_date DESC, s.id DESC
     LIMIT 500`,
    params,
  ).map((r) => {
    const payCents = num(r.pay_cents);
    const receiveCents = num(r.receive_cents);
    return {
      id: num(r.id),
      partyId: num(r.party_id),
      partyName: String(r.party_name ?? ''),
      settleDate: String(r.settle_date ?? ''),
      direction: toSettleDirection(r.direction),
      amountCents: num(r.amount_cents),
      payCents,
      receiveCents,
      cashCents: payCents - receiveCents,
      method: String(r.method ?? ''),
      note: String(r.note ?? ''),
      status: (r.status === 'void' ? 'void' : 'active') as LedgerStatus,
      voidReason: String(r.void_reason ?? ''),
      entryCount: num(r.entry_count),
    };
  });
}

// ---------------------------------------------------------------------------
// 合并相关人（结算后统一变更相关人的安全路径）
// ---------------------------------------------------------------------------

/**
 * A 并入 B。
 *
 * ---- 与方案 §6.4「B 路结转」的偏差（实现时发现的方案错误）----
 *   方案原写"未结算条目改挂 + 生成 bk_transfers 转余额"。这是**重复计算**：
 *   条目的余额已经随改挂带过去了，再写一条 transfer 会把同一笔钱算两遍。
 *   正确做法（本实现）：
 *     ① 未结算条目改挂到 B —— 余额随明细一起走，用户能从 B 的抽屉里看到具体是哪几笔；
 *     ② 已结算条目**留在 A**（历史与 A 的结算单一起不动，否则结算单里的当事人与条目当事人不一致）；
 *     ③ 只在"改挂后 A 仍有非零残额"时才写 transfer 兜底 —— 正常情况恒为 0。
 *   验收判据因此变成可断言的：**合并后 A 的未结清必须为 0**。
 */
export function mergeParty(input: { fromId?: number; toId?: number; note?: string }): {
  fromId: number;
  toId: number;
  movedEntries: number;
  transferredCents: number;
} {
  ensureLedgerSchema();
  const fromId = num(input?.fromId);
  const toId = num(input?.toId);
  if (fromId <= 0 || toId <= 0) throw new Error('请选择要合并的两个相关人');
  if (fromId === toId) throw new Error('不能合并到自己');
  const from = dbGet<{ id: number; name: string }>(`SELECT id, name FROM bk_parties WHERE id = ?`, [fromId]);
  const to = dbGet<{ id: number; name: string; archived: number }>(
    `SELECT id, name, archived FROM bk_parties WHERE id = ?`,
    [toId],
  );
  if (!from) throw new Error('被合并的相关人不存在');
  if (!to) throw new Error('目标相关人不存在');
  if (num(to.archived) === 1) throw new Error('目标相关人已停用，请先启用');

  return dbTransaction(() => {
    // ① 未结算条目改挂（已结算的留在原处：换了人，结算单就对不上了）
    const unsettled = dbQuery<{ id: number }>(
      `SELECT e.id FROM bk_entries e
       WHERE e.party_id = ? AND e.status = 'active'
         AND NOT EXISTS (SELECT 1 FROM bk_settlement_lines l WHERE l.entry_id = e.id AND l.active = 1)`,
      [fromId],
    );
    for (const row of unsettled) {
      dbRun(`UPDATE bk_entries SET party_id = ?, updated_at = datetime('now','localtime') WHERE id = ?`, [
        toId,
        num(row.id),
      ]);
    }

    // ② 残额兜底：正常情况下改挂后 A 的未结清已是 0（未结算部分被搬走，已结算部分差额本来就对平）
    const after = partyBalanceOf(fromId);
    const residual = after?.unsettledCents ?? 0;
    if (residual !== 0) {
      const today = new Date();
      const ymd = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(
        today.getDate(),
      ).padStart(2, '0')}`;
      // 残额为负（我欠 A）→ 由 B 承接这笔应付，transfer 金额同样是负
      dbRun(
        `INSERT INTO bk_transfers (from_party_id, to_party_id, amount_cents, transfer_date, note)
         VALUES (?, ?, ?, ?, ?)`,
        [fromId, toId, residual, ymd, str(input?.note, MAX_LEN.note) || `并入「${String(to.name)}」的残额承接`],
      );
    }

    // ③ 停用 A：不物理删除，台账保留只读入口（RK-08）
    //    `merged_to` 记下"并到谁"：界面据此写「已并入 → B」而不是含混的「已停用」，
    //    并给出跳转；否则用户看到两个停用的人根本分不清哪个是被合并掉的（审查 §5-4）。
    dbRun(
      `UPDATE bk_parties SET archived = 1, merged_to = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
      [toId, fromId],
    );

    logOp(
      'party-merge',
      'party',
      toId,
      { fromId, fromName: String(from.name) },
      { toId, toName: String(to.name), moved: unsettled.length, residual },
    );
    return { fromId, toId, movedEntries: unsettled.length, transferredCents: residual };
  });
}

// ---------------------------------------------------------------------------
// 批量变更相关人（方案 §6.4 三路：改挂 / 只改挂未结算 / 撤销结算后改挂）
// ---------------------------------------------------------------------------

/** `move-all` = A 改挂（要求全未结算）；`move-unsettled` = B 留旧账；`void-then-move` = C 撤销后改挂 */
export type RepatchMode = 'move-all' | 'move-unsettled' | 'void-then-move';

const REPATCH_MODES: readonly RepatchMode[] = ['move-all', 'move-unsettled', 'void-then-move'];

export interface RepatchEntryInfo {
  id: number;
  bizDate: string;
  kind: LedgerKind;
  amountCents: number;
  partyId: number;
  partyName: string;
  status: LedgerStatus;
  settlementId: number;
}

export interface RepatchPartyImpact {
  partyId: number;
  partyName: string;
  /** 现未结清（净额，与台账同一个数） */
  unsettledCents: number;
  selectedCount: number;
  selectedCents: number;
  selectedSettledCount: number;
  selectedSettledCents: number;
  /** A/B 路（只移走所选**未结算**条目）后的未结清 */
  afterMoveCents: number;
  /** C 路（作废结算并移走所选**全部**条目）后的未结清 */
  afterVoidMoveCents: number;
}

export interface RepatchSettlementInfo {
  id: number;
  partyId: number;
  partyName: string;
  settleDate: string;
  direction: SettleDirection;
  amountCents: number;
  /** 该结算单当前有效结算行总数 */
  entryCount: number;
  /** 本批次选中了几条（差额 = C 路作废时被连带恢复未结算的条目） */
  selectedCount: number;
}

export interface RepatchPreview {
  entries: RepatchEntryInfo[];
  /** 传进来的 id 里查不到的（已被删除/从没见过） */
  missingIds: number[];
  /** 传进来的 id 里已作废的（不能变更，需先在明细里看到它） */
  voidIds: number[];
  fromParties: RepatchPartyImpact[];
  settlements: RepatchSettlementInfo[];
  unsettledCount: number;
  unsettledCents: number;
  settledCount: number;
  settledCents: number;
  /** C 路会连带把**未选中**的条目恢复未结算的条数（作废结算单的副作用，必须让用户看见） */
  collateralEntryCount: number;
  /** 推荐路径：无已结算 → `move-all`；含已结算 → `move-unsettled`（C 永远要用户主动选） */
  recommended: RepatchMode;
}

export interface RepatchResult {
  mode: RepatchMode;
  toPartyId: number;
  toPartyName: string;
  movedCount: number;
  movedCents: number;
  /** B 路留在原人的已结算条目（历史与结算单一起不动） */
  keptSettledCount: number;
  keptSettledCents: number;
  voidedSettlements: Array<{
    id: number;
    settleDate: string;
    direction: SettleDirection;
    amountCents: number;
    entryCount: number;
  }>;
  fromParties: Array<{
    partyId: number;
    partyName: string;
    movedCount: number;
    movedCents: number;
    /** 改挂后原人剩余未结清（不等于 0 是正常的：本次只搬走了所选的那些） */
    remainingUnsettledCents: number;
  }>;
}

/** id 列表消毒：去重、只留正整数（与 settle/entry 的入参处理同一口径） */
function uniqueIds(value: unknown): number[] {
  const arr = Array.isArray(value) ? value : [];
  return [...new Set(arr.map((x) => num(x)).filter((x) => Number.isInteger(x) && x > 0))];
}

interface RepatchRow {
  id: number;
  bizDate: string;
  kind: LedgerKind;
  amountCents: number;
  status: LedgerStatus;
  partyId: number;
  partyName: string;
  settlementId: number;
  settleDate: string;
  direction: string;
  settleAmountCents: number;
  /** 该结算单对净往来的调整量（= Σ支出行 − Σ收入行）；互抵单不等于 `settleAmountCents` */
  settleCashCents: number;
  settleEntryCount: number;
}

/**
 * 取所选条目的「变更相关人」上下文（含各自有效结算单）。
 *
 * 结算信息走 `bk_settlement_lines ... active = 1` 且结算单为 active：作废时结算行被置
 * `active=0`，故"有生效结算行"与"被有效结算单占用"是同一件事，不另存字段（方案 §1.3 第 2 条）。
 */
function repatchRows(ids: number[]): RepatchRow[] {
  if (!ids.length) return [];
  const ph = ids.map(() => '?').join(',');
  return dbQuery<Record<string, unknown>>(
    `SELECT e.id, e.biz_date, e.kind, e.amount_cents, e.status, e.party_id,
            COALESCE(p.name, '') AS party_name,
            COALESCE(s.id, 0) AS settlement_id,
            COALESCE(s.settle_date, '') AS settle_date,
            COALESCE(s.direction, '') AS settle_direction,
            COALESCE(s.amount_cents, 0) AS settle_amount,
            COALESCE((SELECT SUM(CASE WHEN e2.kind = 'expense' THEN l2.amount_cents
                                      ELSE -l2.amount_cents END)
                        FROM bk_settlement_lines l2
                        JOIN bk_entries e2 ON e2.id = l2.entry_id
                       WHERE l2.settlement_id = s.id AND l2.active = 1), 0) AS settle_cash,
            COALESCE((SELECT COUNT(*) FROM bk_settlement_lines l2
                      WHERE l2.settlement_id = s.id AND l2.active = 1), 0) AS settle_entry_count
     FROM bk_entries e
     LEFT JOIN bk_parties p ON p.id = e.party_id
     LEFT JOIN bk_settlement_lines l ON l.entry_id = e.id AND l.active = 1
     LEFT JOIN bk_settlements s ON s.id = l.settlement_id AND s.status = 'active'
     WHERE e.id IN (${ph})`,
    ids,
  ).map((r) => ({
    id: num(r.id),
    bizDate: String(r.biz_date ?? ''),
    kind: toKind(r.kind),
    amountCents: num(r.amount_cents),
    status: (r.status === 'void' ? 'void' : 'active') as LedgerStatus,
    partyId: num(r.party_id),
    partyName: String(r.party_name ?? ''),
    settlementId: num(r.settlement_id),
    settleDate: String(r.settle_date ?? ''),
    direction: toSettleDirection(r.settle_direction),
    settleAmountCents: num(r.settle_amount),
    settleCashCents: num(r.settle_cash),
    settleEntryCount: num(r.settle_entry_count),
  }));
}

export function repatchPreview(input: { entryIds?: number[] } = {}): RepatchPreview {
  ensureLedgerSchema();
  const ids = uniqueIds(input?.entryIds);
  if (!ids.length) throw new Error('请至少选择一条条目');
  const rows = repatchRows(ids);
  const found = new Set(rows.map((r) => r.id));
  const missingIds = ids.filter((id) => !found.has(id));
  const voidIds = rows.filter((r) => r.status === 'void').map((r) => r.id);
  const active = rows.filter((r) => r.status === 'active');

  type Acc = RepatchPartyImpact & {
    signedAll: number;
    signedUnsettled: number;
    settledNetSelected: number;
    baseUnsettled: number;
  };
  const parties = new Map<number, Acc>();
  const settlements = new Map<number, RepatchSettlementInfo>();
  const entryInfos: RepatchEntryInfo[] = [];
  let unsettledCount = 0;
  let unsettledCents = 0;
  let settledCount = 0;
  let settledCents = 0;

  for (const r of active) {
    let p = parties.get(r.partyId);
    if (!p) {
      const bal = partyBalanceOf(r.partyId);
      const base = bal?.unsettledCents ?? 0;
      p = {
        partyId: r.partyId,
        partyName: r.partyName,
        unsettledCents: base,
        selectedCount: 0,
        selectedCents: 0,
        selectedSettledCount: 0,
        selectedSettledCents: 0,
        afterMoveCents: base,
        afterVoidMoveCents: base,
        signedAll: 0,
        signedUnsettled: 0,
        settledNetSelected: 0,
        baseUnsettled: base,
      };
      parties.set(r.partyId, p);
    }
    const signed = r.kind === 'income' ? r.amountCents : -r.amountCents;
    p.selectedCount += 1;
    p.selectedCents += r.amountCents;
    p.signedAll += signed;
    if (r.settlementId > 0) {
      settledCount += 1;
      settledCents += r.amountCents;
      p.selectedSettledCount += 1;
      p.selectedSettledCents += r.amountCents;
      const s = settlements.get(r.settlementId);
      if (s) {
        s.selectedCount += 1;
      } else {
        // 作废是**整单**作废：那张单结的钱全部从"已结算"里撤走（包括没被选中的同单条目），
        // 所以 C 路的预估要减整单金额、每单只计一次。按选中条目的金额加会低估残留，
        // 牵连没被选中条目时给出的"原人改挂后未结清"就是错的数。
        // 减的是**整单对净额的调整量**（Σ支出行 − Σ收入行）：互抵单的 pay/receive 会相抵，
        // 用毛额 `settleAmountCents` 会把它算成"我单方面付了一整笔"，C 路预估直接偏大。
        p.settledNetSelected += r.settleCashCents;
        settlements.set(r.settlementId, {
          id: r.settlementId,
          partyId: r.partyId,
          partyName: r.partyName,
          settleDate: r.settleDate,
          direction: toSettleDirection(r.direction),
          amountCents: r.settleAmountCents,
          entryCount: r.settleEntryCount,
          selectedCount: 1,
        });
      }
    } else {
      unsettledCount += 1;
      unsettledCents += r.amountCents;
      p.signedUnsettled += signed;
    }
    entryInfos.push({
      id: r.id,
      bizDate: r.bizDate,
      kind: r.kind,
      amountCents: r.amountCents,
      partyId: r.partyId,
      partyName: r.partyName,
      status: 'active',
      settlementId: r.settlementId,
    });
  }

  for (const p of parties.values()) {
    p.afterMoveCents = p.baseUnsettled - p.signedUnsettled;
    p.afterVoidMoveCents = p.baseUnsettled - p.signedAll - p.settledNetSelected;
  }

  const settlementList = [...settlements.values()].sort((a, b) => b.id - a.id);
  const collateralEntryCount = settlementList.reduce(
    (sum, s) => sum + Math.max(0, s.entryCount - s.selectedCount),
    0,
  );

  return {
    entries: entryInfos.sort((a, b) => (a.bizDate < b.bizDate ? 1 : a.bizDate > b.bizDate ? -1 : b.id - a.id)),
    missingIds,
    voidIds,
    fromParties: [...parties.values()].map((p) => ({
      partyId: p.partyId,
      partyName: p.partyName,
      unsettledCents: p.unsettledCents,
      selectedCount: p.selectedCount,
      selectedCents: p.selectedCents,
      selectedSettledCount: p.selectedSettledCount,
      selectedSettledCents: p.selectedSettledCents,
      afterMoveCents: p.afterMoveCents,
      afterVoidMoveCents: p.afterVoidMoveCents,
    })),
    settlements: settlementList,
    unsettledCount,
    unsettledCents,
    settledCount,
    settledCents,
    collateralEntryCount,
    recommended: settledCount === 0 ? 'move-all' : 'move-unsettled',
  };
}

/**
 * 批量变更相关人（三路，全程一个事务）。
 *
 * ---- 为什么 B 路不写 `bk_transfers`（与方案 §6.4 表里那句"生成往来转移记录"的偏差）----
 *   条目的余额**随改挂一起过去**，再写一条结转等于把同一笔钱算两遍（`mergeParty` 的注释里
 *   有同一段论证与实测数字）。本实现只在"改挂后原人仍有非零残额"时由 `mergeParty` 兜底写一笔，
 *   常规的 repatch **完全不碰** `bk_transfers`。因此结果里给的是"原人改挂后剩余未结清"这个
 *   可核对的数，而不是"结转了多少"。
 *
 * ---- C 路的连带影响必须如实回传 ----
 *   一张结算单可能结了没被选中的条目；作废它会把那些条目一起恢复成未结算。
 *   `voidedSettlements[].entryCount` 与 preview 的 `collateralEntryCount` 就是给界面写这句话用的。
 */
export function repatchEntries(input: {
  entryIds?: number[];
  toPartyId?: number;
  mode?: string;
  reason?: string;
} = {}): RepatchResult {
  ensureLedgerSchema();
  const ids = uniqueIds(input?.entryIds);
  if (!ids.length) throw new Error('请至少选择一条条目');
  const modeRaw = String(input?.mode ?? '');
  if (!(REPATCH_MODES as readonly string[]).includes(modeRaw)) {
    throw new Error('变更相关人缺少有效路径（改挂 / 只改挂未结算 / 撤销结算后改挂）');
  }
  const mode = modeRaw as RepatchMode;
  const why = str(input?.reason, MAX_LEN.reason).trim();
  if (mode === 'void-then-move' && !why) throw new Error('撤销结算后改挂必须填写原因');

  const toPartyId = num(input?.toPartyId);
  if (toPartyId <= 0) throw new Error('请选择要改挂到的相关人');
  const to = dbGet<{ id: number; name: string; archived: number }>(
    `SELECT id, name, archived FROM bk_parties WHERE id = ?`,
    [toPartyId],
  );
  if (!to) throw new Error('目标相关人不存在');
  if (num(to.archived) === 1) throw new Error('目标相关人已停用，请先启用或换一个');

  return dbTransaction(() => {
    const rows = repatchRows(ids);
    const found = new Set(rows.map((r) => r.id));
    const missing = ids.filter((id) => !found.has(id));
    if (missing.length) throw new Error(`有 ${missing.length} 条条目不存在（id: ${missing.join(', ')}）`);
    const voided = rows.filter((r) => r.status === 'void');
    if (voided.length) {
      throw new Error(`有 ${voided.length} 条已作废条目不能变更相关人（id: ${voided.map((r) => r.id).join(', ')}）`);
    }

    // 已属于目标人的条目：无需改挂（也不参与作废），全部如此则视为重复操作
    const movable = rows.filter((r) => r.partyId !== toPartyId);
    if (!movable.length) throw new Error('所选条目已经都属于该相关人，无需变更');

    const settled = movable.filter((r) => r.settlementId > 0);
    let moves: RepatchRow[] = movable;
    let kept: RepatchRow[] = [];

    if (mode === 'move-all') {
      if (settled.length) {
        throw new Error(
          `有 ${settled.length} 条已结算条目不能直接改挂（会与历史结算单对不上）：请改用「只改挂未结算」或「撤销结算后改挂」`,
        );
      }
      moves = movable;
    } else if (mode === 'move-unsettled') {
      moves = movable.filter((r) => r.settlementId === 0);
      kept = settled;
      if (!moves.length) {
        throw new Error('所选条目都已被结算，没有可改挂的未结算条目；请改用「撤销结算后改挂」');
      }
    }

    // C 路：先作废涉及的结算单（同一事务内），条目恢复未结算后再改挂
    const voidedSettlements: RepatchResult['voidedSettlements'] = [];
    if (mode === 'void-then-move' && settled.length) {
      const byId = new Map<number, RepatchRow>();
      for (const r of settled) if (!byId.has(r.settlementId)) byId.set(r.settlementId, r);
      for (const s of [...byId.values()].sort((a, b) => a.settlementId - b.settlementId)) {
        const res = dbRun(
          `UPDATE bk_settlements SET status = 'void', void_reason = ?,
             voided_at = datetime('now','localtime') WHERE id = ? AND status = 'active'`,
          [why, s.settlementId],
        );
        dbRun(`UPDATE bk_settlement_lines SET active = 0 WHERE settlement_id = ?`, [s.settlementId]);
        if (res.changes > 0) {
          logOp('settle-void', 'settlement', s.settlementId, { status: 'active' }, { status: 'void', reason: why, by: 'repatch' });
        }
        voidedSettlements.push({
          id: s.settlementId,
          settleDate: s.settleDate,
          direction: toSettleDirection(s.direction),
          amountCents: s.settleAmountCents,
          entryCount: s.settleEntryCount,
        });
      }
    }

    const fromAcc = new Map<number, { partyName: string; movedCount: number; movedCents: number }>();
    let movedCents = 0;
    for (const r of moves) {
      dbRun(`UPDATE bk_entries SET party_id = ?, updated_at = datetime('now','localtime') WHERE id = ?`, [
        toPartyId,
        r.id,
      ]);
      movedCents += r.amountCents;
      const acc = fromAcc.get(r.partyId) ?? { partyName: r.partyName, movedCount: 0, movedCents: 0 };
      acc.movedCount += 1;
      acc.movedCents += r.amountCents;
      fromAcc.set(r.partyId, acc);
    }

    const fromParties = [...fromAcc.entries()].map(([partyId, acc]) => ({
      partyId,
      partyName: acc.partyName,
      movedCount: acc.movedCount,
      movedCents: acc.movedCents,
      remainingUnsettledCents: partyBalanceOf(partyId)?.unsettledCents ?? 0,
    }));

    // 结果提示必须给"改了几条"这个可核对的数，不能只说"操作成功"（方案 §6.4 硬约束 3）
    logOp(
      'repatch',
      'entry',
      0,
      { entryIds: ids, mode, fromParties },
      {
        toPartyId,
        toPartyName: String(to.name),
        mode,
        movedCount: moves.length,
        movedCents,
        keptSettledCount: kept.length,
        voidedSettlements: voidedSettlements.map((s) => s.id),
      },
      why,
    );

    return {
      mode,
      toPartyId,
      toPartyName: String(to.name),
      movedCount: moves.length,
      movedCents,
      keptSettledCount: kept.length,
      keptSettledCents: kept.reduce((s, r) => s + r.amountCents, 0),
      voidedSettlements,
      fromParties,
    };
  });
}

// ---------------------------------------------------------------------------
// 单店（店铺轴明细：科目分布含公摊 + 该店承担的公摊条目）
// ---------------------------------------------------------------------------

export interface ShopBreakdownCategoryRow {
  categoryId: number;
  categoryName: string;
  kind: LedgerKind;
  /** 该店专属条目金额 */
  directCents: number;
  /** 公共条目摊到该店的金额 */
  sharedCents: number;
  amountCents: number;
}

export interface ShopBreakdownSharedRow {
  entryId: number;
  bizDate: string;
  kind: LedgerKind;
  /** 公共条目总额 */
  entryCents: number;
  /** 该店分摊到的那部分 */
  amountCents: number;
  ratioBp: number;
  categoryName: string;
  partyName: string;
  note: string;
}

export interface ShopBreakdown {
  shopId: number;
  shopName: string;
  shopStatus: string;
  period: string;
  incomeCents: number;
  expenseCents: number;
  balanceCents: number;
  directIncomeCents: number;
  sharedIncomeCents: number;
  directExpenseCents: number;
  sharedExpenseCents: number;
  byCategory: ShopBreakdownCategoryRow[];
  sharedEntries: ShopBreakdownSharedRow[];
}

/**
 * 单店取数（方案 §7.1）。
 *
 * 三张卡与分摊明细**共用同一次分组查询的结果**：收入/支出 = 科目分布行按 kind 求和，
 * 不再另写一次 `SUM`，天然与汇总页 `byShop` 一致（同一轴 = `bk_allocations JOIN bk_entries`）。
 * 结算进度**不出现在这里** —— 那是人的维度（方案 §7.1 末句）。
 */
export function shopBreakdown(input: { shopId?: number; period?: string; from?: string; to?: string } = {}): ShopBreakdown {
  ensureLedgerSchema();
  const shopId = num(input?.shopId);
  if (shopId <= 0) throw new Error('请选择店铺');

  const shopRow = tableExists('sk_shops')
    ? dbGet<{ name: string; status: string }>(`SELECT name, COALESCE(status, '') AS status FROM sk_shops WHERE id = ?`, [shopId])
    : undefined;
  if (tableExists('sk_shops') && !shopRow) throw new Error('店铺不存在或已被删除');

  const where: string[] = [`e.status = 'active'`, 'a.shop_id = ?'];
  const params: Array<string | number> = [shopId];
  if (input?.period) {
    where.push('e.period = ?');
    params.push(str(input.period, 7));
  }
  if (input?.from) {
    where.push('e.biz_date >= ?');
    params.push(str(input.from, 10));
  }
  if (input?.to) {
    where.push('e.biz_date <= ?');
    params.push(str(input.to, 10));
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const byCategory = dbQuery<Record<string, unknown>>(
    `SELECT e.category_id, COALESCE(c.name, '') AS category_name, e.kind,
            SUM(CASE WHEN e.scope = 'shop'   THEN a.amount_cents ELSE 0 END) AS direct,
            SUM(CASE WHEN e.scope = 'shared' THEN a.amount_cents ELSE 0 END) AS shared,
            SUM(a.amount_cents) AS amount
     FROM bk_allocations a
     JOIN bk_entries e ON e.id = a.entry_id
     LEFT JOIN bk_categories c ON c.id = e.category_id
     ${whereSql}
     GROUP BY e.category_id, e.kind
     ORDER BY e.kind ASC, amount DESC`,
    params,
  ).map((r) => {
    const directCents = num(r.direct);
    const sharedCents = num(r.shared);
    return {
      categoryId: num(r.category_id),
      categoryName: String(r.category_name ?? ''),
      kind: toKind(r.kind),
      directCents,
      sharedCents,
      amountCents: directCents + sharedCents,
    };
  });

  const sharedEntries = dbQuery<Record<string, unknown>>(
    `SELECT e.id, e.biz_date, e.kind, e.amount_cents AS entry_amount, a.amount_cents, a.ratio_bp,
            COALESCE(c.name, '') AS category_name, COALESCE(p.name, '') AS party_name, e.note
     FROM bk_allocations a
     JOIN bk_entries e ON e.id = a.entry_id
     LEFT JOIN bk_categories c ON c.id = e.category_id
     LEFT JOIN bk_parties p ON p.id = e.party_id
     ${whereSql} AND e.scope = 'shared'
     ORDER BY e.biz_date DESC, e.id DESC`,
    params,
  ).map((r) => ({
    entryId: num(r.id),
    bizDate: String(r.biz_date ?? ''),
    kind: toKind(r.kind),
    entryCents: num(r.entry_amount),
    amountCents: num(r.amount_cents),
    ratioBp: num(r.ratio_bp),
    categoryName: String(r.category_name ?? ''),
    partyName: String(r.party_name ?? ''),
    note: String(r.note ?? ''),
  }));

  const sumBy = (kind: LedgerKind, field: 'directCents' | 'sharedCents' | 'amountCents') =>
    byCategory.filter((r) => r.kind === kind).reduce((s, r) => s + r[field], 0);

  const directIncomeCents = sumBy('income', 'directCents');
  const sharedIncomeCents = sumBy('income', 'sharedCents');
  const directExpenseCents = sumBy('expense', 'directCents');
  const sharedExpenseCents = sumBy('expense', 'sharedCents');
  const incomeCents = directIncomeCents + sharedIncomeCents;
  const expenseCents = directExpenseCents + sharedExpenseCents;

  return {
    shopId,
    shopName: String(shopRow?.name ?? ''),
    shopStatus: String(shopRow?.status ?? ''),
    period: str(input?.period, 7),
    incomeCents,
    expenseCents,
    balanceCents: incomeCents - expenseCents,
    directIncomeCents,
    sharedIncomeCents,
    directExpenseCents,
    sharedExpenseCents,
    byCategory,
    sharedEntries,
  };
}

// ---------------------------------------------------------------------------
// 汇总与体检
// ---------------------------------------------------------------------------

export interface ShopSummaryRow {
  shopId: number;
  shopName: string;
  shopStatus: string;
  /** 专属收入（条目本身就属于该店） */
  directIncomeCents: number;
  /** 公摊收入（公共条目摊到该店的部分） */
  sharedIncomeCents: number;
  /** 专属支出 */
  directExpenseCents: number;
  /** 公摊支出 */
  sharedExpenseCents: number;
  incomeCents: number;
  expenseCents: number;
  balanceCents: number;
  /** 该店承担的分摊来自几个公共条目 */
  sharedEntryCount: number;
}

export interface LedgerSummary {
  period: string;
  incomeCents: number;
  expenseCents: number;
  balanceCents: number;
  entryCount: number;
  /** 公共条目金额，按方向分开（混加会让"其中公共"读不出意思） */
  sharedIncomeCents: number;
  sharedExpenseCents: number;
  /** 本期公共条目条数（汇总页「公共池」显示用） */
  sharedEntryCount: number;
  byShop: ShopSummaryRow[];
  byCategory: Array<{ categoryId: number; categoryName: string; kind: LedgerKind; amountCents: number }>;
  /**
   * 体检：
   * - `allocationGapCents`：Σ分摊 − Σ有效条目金额。恒 0，非 0 说明有分摊行缺失/多余。
   * - `brokenEntries`：分摊合计 ≠ 条目金额的条目（理论上被写入口拦死，这里只作兜底告警）。
   * - `partyGapCents`：Σ净往来（**JOIN 有效相关人**）− (总收入 − 总支出)。非 0 只可能来自悬空
   *   `party_id`，`missingPartyEntries` 给出具体条目。
   * - `publicPoolCents`：`(总收入 − 总支出) − Σ各店结余`。恒 0，非 0 就是公共池漏摊。
   */
  integrity: {
    allocationGapCents: number;
    partyGapCents: number;
    publicPoolCents: number;
    brokenEntries: Array<{ entryId: number; amountCents: number; allocatedCents: number }>;
    /** 条目挂在不存在的相关人上（party_id 悬空）：体检③ 非 0 时的具体定位 */
    missingPartyEntries: Array<{ entryId: number; amountCents: number }>;
  };
}

/**
 * 汇总（店铺轴 + 科目轴 + 体检）。
 *
 * 所有金额都从 `bk_allocations JOIN bk_entries` 出：**店铺结余必须按分摊算**，
 * 否则公共支出会整块落在"全部店铺"上，单店永远看不到自己该承担的那份。
 * 总收入/总支出走条目金额 —— 两者因为守恒断言（Σ分摊 == 条目金额）必然一致；
 * 不一致就由体检报出来，绝不静默取其中一个。
 */
export function ledgerSummary(filter: { period?: string; from?: string; to?: string } = {}): LedgerSummary {
  ensureLedgerSchema();
  const hasShops = tableExists('sk_shops');
  const where: string[] = [`e.status = 'active'`];
  const params: Array<string> = [];
  if (filter.period) {
    where.push('e.period = ?');
    params.push(str(filter.period, 7));
  }
  if (filter.from) {
    where.push('e.biz_date >= ?');
    params.push(str(filter.from, 10));
  }
  if (filter.to) {
    where.push('e.biz_date <= ?');
    params.push(str(filter.to, 10));
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const totals = dbGet<{ income: number; expense: number; cnt: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN e.kind = 'income'  THEN e.amount_cents ELSE 0 END), 0) AS income,
       COALESCE(SUM(CASE WHEN e.kind = 'expense' THEN e.amount_cents ELSE 0 END), 0) AS expense,
       COUNT(*) AS cnt
     FROM bk_entries e ${whereSql}`,
    params,
  );

  // 公共条目金额必须**按方向拆**：混加之后排在"收入/支出/结余"后面，用户会读成"支出里的公共部分"，
  // 而一笔公共收入还会让这个数反直觉地变大（审查 P2-11）
  const shared = dbGet<{ income: number; expense: number; cnt: number }>(
    `SELECT
       COALESCE(SUM(CASE WHEN e.kind = 'income'  THEN e.amount_cents ELSE 0 END), 0) AS income,
       COALESCE(SUM(CASE WHEN e.kind = 'expense' THEN e.amount_cents ELSE 0 END), 0) AS expense,
       COUNT(*) AS cnt
     FROM bk_entries e
     ${whereSql} AND e.scope = 'shared'`,
    params,
  );

  // 店铺轴：分摊行是唯一的店铺归属来源（专属条目也有单行分摊，故这里覆盖全部）
  const shotRows = dbQuery<Record<string, unknown>>(
    `SELECT a.shop_id,
            COALESCE(s.name, '')  AS shop_name,
            COALESCE(s.status, '') AS shop_status,
            SUM(CASE WHEN e.kind = 'income'  AND e.scope = 'shop'   THEN a.amount_cents ELSE 0 END) AS direct_income,
            SUM(CASE WHEN e.kind = 'income'  AND e.scope = 'shared' THEN a.amount_cents ELSE 0 END) AS shared_income,
            SUM(CASE WHEN e.kind = 'expense' AND e.scope = 'shop'   THEN a.amount_cents ELSE 0 END) AS direct_expense,
            SUM(CASE WHEN e.kind = 'expense' AND e.scope = 'shared' THEN a.amount_cents ELSE 0 END) AS shared_expense,
            SUM(CASE WHEN e.scope = 'shared' THEN 1 ELSE 0 END) AS shared_cnt
     FROM bk_allocations a
     JOIN bk_entries e ON e.id = a.entry_id
     ${hasShops ? 'LEFT JOIN sk_shops s ON s.id = a.shop_id' : `LEFT JOIN (SELECT 0 AS id, '' AS name, '' AS status) s ON s.id = a.shop_id`}
     ${whereSql}
     GROUP BY a.shop_id
     ORDER BY (direct_expense + shared_expense) DESC, a.shop_id ASC`,
    params,
  );

  const byShop: ShopSummaryRow[] = shotRows.map((r) => {
    const directIncomeCents = num(r.direct_income);
    const sharedIncomeCents = num(r.shared_income);
    const directExpenseCents = num(r.direct_expense);
    const sharedExpenseCents = num(r.shared_expense);
    // 收入/支出只由上面四个分项相加得到 —— 汇总表与单店页共用同一组数，不另取一次 SUM
    const incomeCents = directIncomeCents + sharedIncomeCents;
    const expenseCents = directExpenseCents + sharedExpenseCents;
    return {
      shopId: num(r.shop_id),
      shopName: String(r.shop_name ?? ''),
      shopStatus: String(r.shop_status ?? ''),
      directIncomeCents,
      sharedIncomeCents,
      directExpenseCents,
      sharedExpenseCents,
      incomeCents,
      expenseCents,
      balanceCents: incomeCents - expenseCents,
      // 这里统计的是"该店有分摊行的公共条目条数"，只作展示，不参与任何金额求和
      sharedEntryCount: num(r.shared_cnt),
    };
  });

  const byCategory = dbQuery<Record<string, unknown>>(
    `SELECT e.category_id, COALESCE(c.name, '') AS category_name, e.kind,
            SUM(e.amount_cents) AS amount
     FROM bk_entries e
     LEFT JOIN bk_categories c ON c.id = e.category_id
     ${whereSql}
     GROUP BY e.category_id, e.kind
     ORDER BY e.kind ASC, amount DESC`,
    params,
  ).map((r) => ({
    categoryId: num(r.category_id),
    categoryName: String(r.category_name ?? ''),
    kind: toKind(r.kind),
    amountCents: num(r.amount),
  }));

  const incomeCents = num(totals?.income);
  const expenseCents = num(totals?.expense);

  // 体检①：分摊合计 vs 条目金额
  const gapRow = dbGet<{ alloc_sum: number; entry_sum: number }>(
    `SELECT
       (SELECT COALESCE(SUM(a.amount_cents), 0) FROM bk_allocations a
          JOIN bk_entries e ON e.id = a.entry_id ${whereSql}) AS alloc_sum,
       (SELECT COALESCE(SUM(e.amount_cents), 0) FROM bk_entries e ${whereSql}) AS entry_sum`,
    [...params, ...params],
  );

  // 体检②：逐条目找平（兜底告警，正常恒空）
  // ⚠️ 判据写成 WHERE 子查询，不用 `HAVING`：没有 GROUP BY 的 HAVING 会被 SQLite
  //    当成"整表一个组"，只返回一行聚合结果 —— 看着不报错，实际漏掉了所有问题条目。
  const brokenEntries = dbQuery<Record<string, unknown>>(
    `SELECT e.id, e.amount_cents,
            COALESCE((SELECT SUM(a.amount_cents) FROM bk_allocations a WHERE a.entry_id = e.id), 0) AS allocated
     FROM bk_entries e
     ${whereSql}
       AND COALESCE((SELECT SUM(a.amount_cents) FROM bk_allocations a WHERE a.entry_id = e.id), 0) <> e.amount_cents
     LIMIT 50`,
    params,
  ).map((r) => ({
    entryId: num(r.id),
    amountCents: num(r.amount_cents),
    allocatedCents: num(r.allocated),
  }));

  // 体检③：Σ净往来 == 总收入 − 总支出。
  //
  // ⚠️ 必须 **JOIN bk_parties** 再求和：以前的写法与「总收入 − 总支出」是同一个 `bk_entries`
  //    表达式的两种拼法，两边相减恒等于 0 —— 于是这一项永远不会红，而它本该抓的正是
  //    "条目挂在不存在的相关人身上"（party_id 越界），那种数据会让台账 Σ 与总收支对不上
  //    却查不出原因（审查 P2-13）。
  const netRow = dbGet<{ net: number }>(
    `SELECT COALESCE(SUM(CASE WHEN e.kind = 'income' THEN e.amount_cents ELSE -e.amount_cents END), 0) AS net
     FROM bk_entries e JOIN bk_parties p ON p.id = e.party_id
     ${whereSql}`,
    params,
  );

  // 悬空归属：条目指向一个不存在的相关人（触发器/手改库才会出现，但一旦出现台账就少一笔）
  const missingPartyEntries = dbQuery<Record<string, unknown>>(
    `SELECT e.id, e.amount_cents
     FROM bk_entries e LEFT JOIN bk_parties p ON p.id = e.party_id
     ${whereSql} AND p.id IS NULL
     ORDER BY e.id ASC
     LIMIT 50`,
    params,
  ).map((r) => ({ entryId: num(r.id), amountCents: num(r.amount_cents) }));

  // 体检④：公共池 = 总收支差 − Σ各店结余。恒 0；非 0 说明有条目没摊出去（公共池漏摊）。
  const shopBalanceSum = byShop.reduce((sum, r) => sum + r.balanceCents, 0);

  return {
    period: str(filter.period, 7),
    incomeCents,
    expenseCents,
    balanceCents: incomeCents - expenseCents,
    entryCount: num(totals?.cnt),
    sharedIncomeCents: num(shared?.income),
    sharedExpenseCents: num(shared?.expense),
    sharedEntryCount: num(shared?.cnt),
    byShop,
    byCategory,
    integrity: {
      allocationGapCents: num(gapRow?.alloc_sum) - num(gapRow?.entry_sum),
      partyGapCents: num(netRow?.net) - (incomeCents - expenseCents),
      publicPoolCents: incomeCents - expenseCents - shopBalanceSum,
      brokenEntries,
      missingPartyEntries,
    },
  };
}

// ---------------------------------------------------------------------------
// 参与分摊的店铺默认集合
// ---------------------------------------------------------------------------

/**
 * 期间内可参与分摊的店铺（方案 §5.3：默认值必须靠事实字段，不靠顺序）。
 *
 * 规则：`status` 为 `active` **或 `exited`（退店）** 且（`opened_at` 为空 或 `opened_at` ≤ 期间首日）。
 * 退店参与分摊是刻意的：退店只是标记，收尾的房租 / 年费 / 税 / 清仓运费仍要摊到它头上；
 * 把它排除会让这笔钱只落到剩下几家，而**合计依然等于金额**（守恒断言抓不到），事后查不出来。
 * 不参与的是 `archived`（停用，人主动关掉）与 `banned`（封店，平台冻结）—— 那两种是"这家不算了"。
 *
 * 返回**排除项及原因**，界面必须显式写出"参与 5 家 · 已排除 2 家（1 未开业 / 1 已停用）"，
 * 否则用户看不出为什么某家店没被摊到，只会认为"它漏了"。
 */
export function eligibleShops(period: string): {
  eligible: Array<{ id: number; name: string }>;
  excluded: Array<{ id: number; name: string; reason: 'not-open-yet' | 'inactive'; status: string }>;
} {
  ensureLedgerSchema();
  if (!tableExists('sk_shops')) return { eligible: [], excluded: [] };
  const p = /^\d{4}-\d{2}$/.test(str(period, 7)) ? str(period, 7) : '';
  const firstDay = p ? `${p}-01` : '';
  const rows = dbQuery<{ id: number; name: string; status: string; opened_at: string }>(
    `SELECT id, name, status, COALESCE(opened_at, '') AS opened_at FROM sk_shops ORDER BY id ASC`,
  );
  const eligible: Array<{ id: number; name: string }> = [];
  const excluded: Array<{ id: number; name: string; reason: 'not-open-yet' | 'inactive'; status: string }> = [];
  for (const r of rows) {
    const id = num(r.id);
    const name = String(r.name ?? '');
    const status = String(r.status ?? '');
    const openedAt = String(r.opened_at ?? '');
    if (status !== 'active' && status !== 'exited') {
      excluded.push({ id, name, reason: 'inactive', status });
      continue;
    }
    if (firstDay && openedAt && openedAt > firstDay) {
      excluded.push({ id, name, reason: 'not-open-yet', status });
      continue;
    }
    eligible.push({ id, name });
  }
  return { eligible, excluded };
}

// ---------------------------------------------------------------------------
// Excel 批量导入（名字 → 身份，整批落库）
// ---------------------------------------------------------------------------

/**
 * 一个名字在库里的下落。
 *
 * 四态是给渲染层逐行说人话用的（`src/lib/ledgerImport.ts` 负责措辞），本层只给事实：
 * `ok` / `archived`（停用或封店）/ `missing`（库里没有）/ `ambiguous`（同名不止一条）。
 *
 * ⚠️ 店铺的 `exited`（退店）算 `ok` —— 退店仍参与分摊，若在这里折成 `archived`，
 * 渲染层就会把"这家已退店"判成"不能摊钱"，两处口径分叉。
 */
export interface LedgerNameHit {
  id: number;
  /** 库里登记的名字（用户文件里的写法是返回值的**键**，两者可能差一个空格） */
  name: string;
  state: 'ok' | 'archived' | 'missing' | 'ambiguous';
  /** 只有科目带：收入还是支出（方向与科目对不上时，先在预览里逐行说清，不必等落库报错） */
  kind: string;
  /** 只有店铺带原始状态（`active`/`exited`/`archived`/`banned`）：措辞要能说出"已退店"还是"已停用" */
  status: string;
}

/** `name_key IN (…)` 的行形状；`archived` 由各轴自己折算（店铺用 `status` 判） */
interface NameRow {
  k: string;
  id: number;
  name: string;
  archived: number;
  kind: string;
  status: string;
}

function placeholders(n: number): string {
  return new Array(n).fill('?').join(',');
}

/** 只留非空、去重、限量（一份文件里的不同名字数量级很小，超了就是喂了垃圾数据） */
function distinctRaws(v: unknown, limit: number): string[] {
  if (!Array.isArray(v)) return [];
  const out: string[] = [];
  for (const item of v) {
    if (typeof item !== 'string' || !toNameKey(item)) continue;
    if (!out.includes(item)) out.push(item);
    if (out.length >= limit) break;
  }
  return out;
}

/** 归一键 → 该键下的所有行，再按调用方给的**原文**取（键用原文：预览要按用户文件里的写法回显） */
function toHitMap(raws: readonly string[], rows: readonly NameRow[]): Record<string, LedgerNameHit> {
  const byKey = new Map<string, NameRow[]>();
  for (const r of rows) {
    const list = byKey.get(r.k);
    if (list) list.push(r);
    else byKey.set(r.k, [r]);
  }
  const out: Record<string, LedgerNameHit> = {};
  for (const raw of raws) {
    const hits = (byKey.get(toNameKey(raw)) ?? []).slice().sort((a, b) => a.id - b.id);
    if (!hits.length) {
      out[raw] = { id: 0, name: raw, state: 'missing', kind: '', status: '' };
      continue;
    }
    const one = hits[0];
    if (hits.length > 1) {
      out[raw] = { id: 0, name: String(one.name ?? ''), state: 'ambiguous', kind: '', status: '' };
      continue;
    }
    out[raw] = {
      id: num(one.id),
      name: String(one.name ?? ''),
      state: num(one.archived) === 1 ? 'archived' : 'ok',
      kind: String(one.kind ?? ''),
      status: String(one.status ?? ''),
    };
  }
  return out;
}

/**
 * 文件里的相关人 / 科目 / 店铺名 → 库里的 id。
 *
 * 为什么这一跳必须在主进程：`toNameKey`（「什么算同一个名字」的唯一口径）在主进程，
 * 而"同名是不是同一家店"只有拥有 `sk_shops` / `bk_parties` 的一侧能答。
 * 渲染层自己再算一遍归一 = 两份口径，迟早分叉。
 *
 * ⚠️ 科目按**名字**查（不分收/支）：`bk_categories` 的唯一键是 `(kind, name_key)`，
 * 所以「运费」可以同时是收入科目和支出科目 —— 那是真歧义，返回 `ambiguous`，
 * 让人去改名区分，而不是按行里的方向"猜一个"（猜错会把钱记到另一个科目的账上）。
 */
export function resolveImportNames(input: {
  party?: unknown;
  category?: unknown;
  shop?: unknown;
}): {
  party: Record<string, LedgerNameHit>;
  category: Record<string, LedgerNameHit>;
  shop: Record<string, LedgerNameHit>;
} {
  ensureLedgerSchema();
  const partyRaws = distinctRaws(input?.party, 1000);
  const categoryRaws = distinctRaws(input?.category, 1000);
  const shopRaws = distinctRaws(input?.shop, 1000);

  const partyRows = partyRaws.length
    ? dbQuery<NameRow>(
        `SELECT name_key AS k, id, name, archived, '' AS kind, '' AS status
           FROM bk_parties WHERE name_key IN (${placeholders(partyRaws.length)})`,
        partyRaws.map(toNameKey),
      )
    : [];

  const categoryRows = categoryRaws.length
    ? dbQuery<NameRow>(
        `SELECT name_key AS k, id, name, archived, kind, '' AS status
           FROM bk_categories WHERE name_key IN (${placeholders(categoryRaws.length)})`,
        categoryRaws.map(toNameKey),
      )
    : [];

  // `sk_shops` 可能还不存在（用户从未进过基础数据页）：没有表就是"一个都认不出"，不跨域建表。
  // 退店（`exited`）不折成 archived —— 它还能参与分摊，折了就会被渲染层判成"不能摊钱"。
  const shopRows =
    shopRaws.length && tableExists('sk_shops')
      ? dbQuery<NameRow>(
          `SELECT name_key AS k, id, name,
                  COALESCE(status, 'active') AS status,
                  CASE WHEN COALESCE(status, 'active') IN ('archived', 'banned') THEN 1 ELSE 0 END AS archived,
                  '' AS kind
             FROM sk_shops
            WHERE trim(name_key) <> '' AND name_key IN (${placeholders(shopRaws.length)})`,
          shopRaws.map(toNameKey),
        )
      : [];

  return {
    party: toHitMap(partyRaws, partyRows),
    category: toHitMap(categoryRaws, categoryRows),
    shop: toHitMap(shopRaws, shopRows),
  };
}

/**
 * 导入时「名字 → id」，**库里没有就建**（自动建人/科目唯一入口）。
 *
 * 只在这一条批事务里被调用：失败随整批回滚，不会留下"导失败了但凭空多出三个相关人"。
 * 判据只有一处 —— `toNameKey`（与 `upsertParty` / `upsertCategory` 去重用的是同一个键）。
 * 先查后建而不是 `INSERT OR IGNORE`：同名但**已停用**的要报错，不能顺手把它启用，
 * 也不能再建一个同名的（`name_key` 唯一索引会挡，报出来的是 SQL 错而不是人话）。
 */
function resolveOrCreatePartyByName(raw: string): { id: number; created: boolean } {
  const name = str(raw, MAX_LEN.name).trim();
  const nameKey = toNameKey(name);
  if (!nameKey) throw new Error('相关人名字只有空白字符');
  const hit = dbGet<{ id: number; archived: number }>(
    `SELECT id, archived FROM bk_parties WHERE name_key = ?`,
    [nameKey],
  );
  if (hit) {
    if (num(hit.archived) === 1) throw new Error(`相关人「${name}」已停用：请到「记账 › 相关人」启用它，或换个名字`);
    return { id: num(hit.id), created: false };
  }
  // 类型给「其他」：文件里没有"这个人是什么身份"这一列，凭方向/科目猜（房东/供应商）就是编造
  return upsertParty({ name, kind: 'other' });
}

/**
 * 科目的自动新建。唯一键是 `(kind, name_key)`：同一个名字可以同时是收入科目和支出科目，
 * 所以这里**按方向找**，不按名字跨方向找（跨方向找到就是"预览里已判 ambiguous"的那种真歧义）。
 */
function resolveOrCreateCategoryByName(raw: string, kind: LedgerKind): { id: number; created: boolean } {
  const name = str(raw, MAX_LEN.name).trim();
  const nameKey = toNameKey(name);
  if (!nameKey) throw new Error('科目名字只有空白字符');
  const same = dbGet<{ id: number; archived: number }>(
    `SELECT id, archived FROM bk_categories WHERE kind = ? AND name_key = ?`,
    [kind, nameKey],
  );
  if (same) {
    if (num(same.archived) === 1) throw new Error(`科目「${name}」已停用：请到「记账 › 科目」启用它，或换一个`);
    return { id: num(same.id), created: false };
  }
  return upsertCategory({ name, kind });
}

/**
 * 整批新增条目（Excel 批量导入唯一的写入口）。
 *
 * 三条硬规矩（与渲染层 `src/lib/ledgerImport.ts` 文件头同一份口径）：
 * 1. **整批一个事务**：第 N 行失败就全批回滚。半批落库会让用户以为"导完了"，
 *    而他既不知道哪些进了、也不知道哪些没进，再导一遍就变成重复账。
 * 2. **只新增**：`id` 一律按 0 处理，导入永不改已有条目（改账是「记一笔」的活，那里有结算占用边界）。
 * 3. **不产生结算单**：这里只写 `bk_entries` / `bk_allocations`。
 *
 * 逐行的字段校验与守恒断言全部复用 `upsertEntry`（每个数字只有一处实现），
 * 本函数只补三件事：把错误定位到"第几行"、拦住"静默取默认值"的入口
 * （`upsertEntry` 对 `kind` 缺失会按收入处理 —— 那是给"更新时不改方向"的局部语义，
 * 新建路径带着它进来就会把一笔支出记成收入），以及**按名字自动新建相关人/科目**
 * （`partyName` / `categoryName`；见 `resolveOrCreatePartyByName`）。
 */
export function batchCreateEntries(entries: unknown): {
  created: number;
  ids: number[];
  allocations: number;
  /** 本批自动新建的相关人 / 科目（名字原文，界面要如实说出"多出了哪些名字"） */
  createdParties: string[];
  createdCategories: string[];
} {
  ensureLedgerSchema();
  if (!Array.isArray(entries) || !entries.length) throw new Error('没有要导入的行');
  if (entries.length > 2000) throw new Error(`一次最多导入 2000 行（本次 ${entries.length} 行）`);

  return dbTransaction(() => {
    const ids: number[] = [];
    const createdParties: string[] = [];
    const createdCategories: string[] = [];
    let allocations = 0;
    for (let i = 0; i < entries.length; i++) {
      const e = entries[i] as EntryInput & { rowNo?: number };
      // 行号优先取载荷里带的 **Excel 行号**：勾选子集后 `i + 1` 指的是"这批的第几条"，
      // 报给用户就是错的地址（他会去改别人的那一行）。没带时才回落成批内序号。
      const payloadRowNo = num(e?.rowNo);
      const rowNo = payloadRowNo > 0 ? payloadRowNo : i + 1;
      const kind = e?.kind === 'income' || e?.kind === 'expense' ? e.kind : '';
      if (!kind) throw new Error(`第 ${rowNo} 行：没有收/支方向（不猜，猜错整本账的结余方向就反了）`);
      if (!String(e?.bizDate ?? '')) throw new Error(`第 ${rowNo} 行：没有发生日期`);
      if (num(e?.amountCents) <= 0) throw new Error(`第 ${rowNo} 行：金额必须是正数（单位分）`);
      let res: { id: number; created: boolean; allocations: number };
      try {
        // 名字 → id（库里没有就建）。建出来的名字记下来，界面要告诉用户"多出了谁"。
        let partyId = num(e?.partyId);
        if (partyId <= 0 && String(e?.partyName ?? '').trim()) {
          const p = resolveOrCreatePartyByName(String(e.partyName));
          partyId = p.id;
          if (p.created) createdParties.push(String(e.partyName).trim());
        }
        if (partyId <= 0) throw new Error('没有资金相关人');
        let categoryId = num(e?.categoryId);
        if (categoryId <= 0 && String(e?.categoryName ?? '').trim()) {
          const c = resolveOrCreateCategoryByName(String(e.categoryName), kind);
          categoryId = c.id;
          if (c.created) createdCategories.push(String(e.categoryName).trim());
        }
        res = upsertEntry({ ...e, id: 0, kind, partyId, categoryId });
      } catch (err: unknown) {
        const msg = err instanceof Error ? err.message : String(err);
        // 已经带上行号的（内层分摊计算）不再重复前缀，避免出现「第 3 行：第 3 行：…」
        throw new Error(/^第 \d+ 行：/.test(msg) ? msg : `第 ${rowNo} 行：${msg}`);
      }
      ids.push(res.id);
      allocations += res.allocations;
    }
    return {
      created: ids.length,
      ids,
      allocations,
      createdParties: [...new Set(createdParties)],
      createdCategories: [...new Set(createdCategories)],
    };
  });
}
