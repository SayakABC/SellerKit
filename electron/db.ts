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
