// electron/db.ts
// 通用 SQLite 数据访问层（主进程，better-sqlite3 同步 API）。
// 职责：统一数据库初始化（userData/sellerkit.db）、幂等 DDL 迁移、增删查改与事务封装，
//       供各业务模块的主进程数据层复用（如 order-db.ts），避免重复建库/重复写 SQL 样板。
// 安全边界：本层只允许主进程内部使用；渲染进程一律经语义化 IPC 访问，
//           禁止将 SQL 透传给渲染进程执行（见 AGENTS.md §1.7 / 红线 3）。
// 依赖：better-sqlite3（原生模块，已在 package.json dependencies，打包时 electron-builder 自动 rebuild）。

export {};

import Database = require('better-sqlite3');

type Db = Database.Database;

const DEFAULT_FILE_NAME = 'sellerkit.db';

let db: Db | null = null;
let dbFilePath = '';

export interface DbRunResult {
  lastInsertRowid: number;
  changes: number;
}

/** 参数占位符绑定值（better-sqlite3 支持的类型） */
export type DbBindValue = string | number | null | boolean | bigint | Buffer | Uint8Array;
export type DbBindParams = DbBindValue[] | Record<string, DbBindValue>;

/**
 * 惰性初始化（幂等）。省略 file 时默认 userData/sellerkit.db。
 * @param file 可选，覆盖默认库文件路径（测试/多库场景）
 * @returns 数据库实例
 */
export function initDb(file?: string): Db {
  if (db) return db;
  const { app } = require('electron');
  dbFilePath = file || require('path').join(app.getPath('userData'), DEFAULT_FILE_NAME);
  db = new Database(dbFilePath);
  db.pragma('journal_mode = WAL');
  db.pragma('foreign_keys = ON');
  return db;
}

/** 获取数据库实例（未初始化时惰性初始化） */
export function getDb(): Db {
  if (!db) return initDb();
  return db;
}

/** 当前库文件路径（调试/设置页展示用） */
export function getDbFilePath(): string {
  return dbFilePath;
}

/**
 * 关闭数据库连接（数据备份/恢复覆盖库文件前调用）。
 * 关闭时 SQLite 自动把 WAL 内容合并进主库文件；关闭后单例置空，下次访问惰性重开。
 */
export function closeDb(): void {
  if (db) {
    try {
      db.close();
    } catch {
      /* 忽略关闭异常 */
    }
    db = null;
    dbFilePath = '';
  }
}

/** 批量执行 DDL（幂等建表/索引），整体走事务，任一条失败则全部回滚 */
export function dbMigrate(statements: string[]): void {
  dbTransaction(() => {
    const d = getDb();
    for (const sql of statements) d.exec(sql);
  });
}

/** 一条演进步骤：`version` 从 1 起、按域内连续升序；`up` 只做这一步，不依赖后续步骤 */
export interface MigrationStep {
  version: number;
  name: string;
  up: () => void;
}

/**
 * 按域 key 的**版本化迁移**（有序 + 只跑一次 + 记录版本）。
 *
 * 与 `dbMigrate` 的分工（两者都要，别互相替代）：
 *   · `dbMigrate(statements)` —— 幂等 DDL（`CREATE TABLE/INDEX IF NOT EXISTS`），每次 ensure 都能跑，
 *     负责"**新库**一次建到当前形状"；
 *   · `migrate(key, steps)` —— **演进**（补列 / 重建表 / 改唯一键 / 搬数据），只跑未应用的版本，
 *     负责"**老库**追上来"。
 *
 * 为什么必须有它（2026-09-29 实测教训）：`pl_shop_sku` 的唯一键在一对多改造时由 4 列扩成 5 列，
 * 而 `CREATE TABLE IF NOT EXISTS` **不会重建老库** —— 于是老库是 4 列键、新库是 5 列键，
 * 代码里那个对旧形状的假设（`ON CONFLICT(platform, shop_id, item_id, spec)`）在**新库上必失败、
 * 在老库上看不出来**。形状差异只能靠一次性迁移收敛，幂等 DDL 永远收敛不了。
 *
 * 记账表 `sk_schema_migrations` 按域 key 分别记版本（各域仍自己拥有 schema，不共用一个全局版本号）。
 * @returns 实际应用的步骤数（0 = 已是最新；测试与日志用）
 */
export function migrate(key: string, steps: MigrationStep[]): number {
  const d = getDb();
  d.exec(`CREATE TABLE IF NOT EXISTS sk_schema_migrations (
    key TEXT PRIMARY KEY,
    version INTEGER NOT NULL DEFAULT 0,
    applied_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`);

  const current = migrationVersion(key);
  const pending = (Array.isArray(steps) ? steps : [])
    .filter((s) => Number(s.version) > current)
    .sort((a, b) => Number(a.version) - Number(b.version));
  if (!pending.length) return 0;

  dbTransaction(() => {
    for (const step of pending) {
      step.up();
      dbRun(
        `INSERT INTO sk_schema_migrations (key, version, applied_at)
         VALUES (?, ?, datetime('now','localtime'))
         ON CONFLICT(key) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at`,
        [key, Number(step.version)],
      );
    }
  });
  return pending.length;
}

/** 某域已应用的迁移版本（0 = 从未迁移过；记账表不存在时也是 0） */
export function migrationVersion(key: string): number {
  if (!tableSql('sk_schema_migrations')) return 0;
  const row = dbGet<{ version: number }>(
    `SELECT version FROM sk_schema_migrations WHERE key = ?`,
    [key],
  );
  return row ? Number(row.version) || 0 : 0;
}

/**
 * 表是否存在 —— 各域表**按域懒建**，跨域读之前先探一下：缺表时**降级**（回落空值），
 * 而不是抛 `no such table`（那会被误读成"自己的 SQL 坏了"，排查方向整个反掉）。
 *
 * 唯一一份：原先 `product-db` / `shop-db` / `shop-product-db` 各抄了一份（口径一样但四处维护），
 * 2026-09-29 收拢到这里。
 */
export function tableExists(name: string): boolean {
  const row = dbGet<{ n: number }>(
    `SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name = ?`,
    [name],
  );
  return Number(row?.n ?? 0) > 0;
}

/** 对象的建表/建索引 SQL 原文（形状判定用：如"唯一键含不含 product_id"）；不存在返回 '' */
export function tableSql(name: string): string {
  const row = dbGet<{ sql: string | null }>(
    `SELECT sql FROM sqlite_master WHERE name = ?`,
    [name],
  );
  return String(row?.sql ?? '');
}

/** 查询多条记录 */
export function dbQuery<T = Record<string, unknown>>(sql: string, params: DbBindParams = []): T[] {
  return getDb().prepare(sql).all(...normalizeParams(params)) as T[];
}

/** 查询单条记录，无结果返回 undefined */
export function dbGet<T = Record<string, unknown>>(
  sql: string,
  params: DbBindParams = [],
): T | undefined {
  return getDb().prepare(sql).get(...normalizeParams(params)) as T | undefined;
}

/**
 * 执行写操作（INSERT/UPDATE/DELETE）。
 * @returns lastInsertRowid（自增主键）/ changes（受影响行数）
 */
export function dbRun(sql: string, params: DbBindParams = []): DbRunResult {
  const info = getDb().prepare(sql).run(...normalizeParams(params));
  return { lastInsertRowid: Number(info.lastInsertRowid), changes: info.changes };
}

/** 同步事务包装：fn 抛错则整体回滚 */
export function dbTransaction<T>(fn: () => T): T {
  return getDb().transaction(fn)();
}

function normalizeParams(params: DbBindParams): DbBindValue[] {
  return Array.isArray(params) ? params : Object.values(params);
}
