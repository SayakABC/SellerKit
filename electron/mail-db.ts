// electron/mail-db.ts
// 「集中邮件收件箱」主进程数据访问层，基于 electron/db.ts 公共层。
//
// 业务模型：一个店铺套（sk_shop_sets，业务主键=邮箱）可接入一个邮箱账号（sk_mail_accounts），
//   账号下的邮件按 (account_id, folder, uid) 唯一定位；正文分表懒存，附件只存元信息。
//
// 设计要点（吸收 Mailspring / Thunderbird 的做法）：
//   - 窄列 + 分表：**不**把整封邮件塞进单个 JSON 列（Mailspring 已公开反思该设计导致行过宽、扫描变慢）；
//   - 预处理语句缓存：better-sqlite3 的瓶颈在解析 SQL 字符串，故本文件统一经 stmt() 复用语句；
//   - 无状态同步：所有写入走 dbTransaction 分批提交，随时中断都不会留下半截数据；
//   - 只读：本模块不提供任何写回服务器的字段（见 mail-engine.ts 的 readOnly 约束）。
//
// M3 增补：
//   - 多文件夹：游标下沉到 sk_mail_folders(account_id, path)，账号级 uid_validity/last_uid 仅作兼容；
//   - FTS5 全文检索：sk_mail_fts 虚拟表（rowid = sk_mail_messages.id），写入即增量维护，
//     better-sqlite3 未编译 FTS5 时自动降级为 LIKE（见 isMailFtsAvailable）；
//   - 附件本地缓存：sk_mail_attachment_cache 只存**落盘路径**（二进制不入库，见 mail-cache.ts）。
//
// 依赖：better-sqlite3（同步 API）；关联表 sk_shop_sets（外键级联删除）。

export {};

import { getDb, dbMigrate, dbTransaction, dbRun } from './db';

/**
 * 预处理语句类型。
 * 注：不能写 ReturnType<Db['prepare']>——better-sqlite3 的 prepare 是泛型方法，
 * ReturnType 会把类型参数落到约束 `unknown[] | {}` 上，条件类型分发后得到联合类型，
 * 调用 run/get/all 时签名会退化成「必须传 1 个参数」。此处显式结构化描述规避该问题。
 */
interface Stmt {
  run(...params: any[]): { changes: number | bigint; lastInsertRowid: number | bigint };
  get(...params: any[]): any;
  all(...params: any[]): any[];
}

/** 收件箱账号状态：空闲 / 同步中 / 出错 / 已暂停 */
export type MailAccountStatus = 'idle' | 'syncing' | 'error' | 'paused';

export const MAIL_ACCOUNT_STATUSES: MailAccountStatus[] = ['idle', 'syncing', 'error', 'paused'];

/** 账号行（DB 列名 → 本文件统一转驼峰输出） */
export interface MailAccountRow {
  id: number;
  shopSetId: number;
  email: string;
  providerId: string;
  imapHost: string;
  imapPort: number;
  imapSecure: boolean;
  proxy: string;
  folder: string;
  /** 需同步的文件夹列表（M3 多文件夹；空时按 folder 单文件夹兜底） */
  folders: string[];
  syncEnabled: boolean;
  syncDays: number;
  maxBodyBytes: number;
  status: MailAccountStatus;
  lastError: string;
  lastSyncedAt: string;
  uidValidity: number;
  lastUid: number;
  createdAt: string;
  updatedAt: string;
}

export interface MailAccountUpsertInput {
  id?: number;
  shopSetId: number;
  email: string;
  providerId?: string;
  imapHost?: string;
  imapPort?: number;
  imapSecure?: boolean;
  proxy?: string;
  folder?: string;
  /** 需同步的文件夹列表（省略 = 保持原值；空数组 = 回退单文件夹 folder） */
  folders?: string[];
  syncEnabled?: boolean;
  syncDays?: number;
  maxBodyBytes?: number;
}

/** 账号级文件夹同步游标（多文件夹后每个文件夹各自记录增量位置） */
export interface MailFolderRow {
  id: number;
  accountId: number;
  path: string;
  uidValidity: number;
  lastUid: number;
  lastSyncedAt: string;
  createdAt: string;
}

/** 附件本地缓存索引（磁盘文件在 mail-cache.ts 管理，此处只记路径与大小） */
export interface MailAttachmentCacheRow {
  attachmentId: number;
  messageId: number;
  filePath: string;
  size: number;
  cachedAt: string;
}

export interface MailMessageRow {
  id: number;
  accountId: number;
  accountEmail: string;
  folder: string;
  uid: number;
  messageId: string;
  subject: string;
  fromName: string;
  fromAddr: string;
  toJson: string;
  ccJson: string;
  receivedAt: string;
  size: number;
  seen: boolean;
  flagged: boolean;
  hasAttachment: boolean;
  bodyCached: boolean;
  preview: string;
  createdAt: string;
  /** 本地标记已读的时间（空串 = 未在本地读过）。IMAP 只读，不改服务端 flag */
  readAt: string;
  /** 有效已读态：服务端 seen 或 本地已读过，二者取或 */
  read: boolean;
}

export interface MailMessageDetail extends MailMessageRow {
  textBody: string;
  htmlBody: string;
  truncated: boolean;
  attachments: MailAttachmentRow[];
}

export interface MailAttachmentRow {
  id: number;
  messageId: number;
  filename: string;
  mime: string;
  size: number;
}

/** 同步批次内待落库的邮件元数据 */
export interface MailMessageUpsertRow {
  accountId: number;
  folder: string;
  uid: number;
  messageId: string;
  subject: string;
  fromName: string;
  fromAddr: string;
  toJson: string;
  ccJson: string;
  receivedAt: string;
  size: number;
  seen: boolean;
  flagged: boolean;
  hasAttachment: boolean;
  preview: string;
}

const MAIL_SCHEMA: string[] = [
  `CREATE TABLE IF NOT EXISTS sk_mail_accounts (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    shop_set_id INTEGER NOT NULL UNIQUE REFERENCES sk_shop_sets(id) ON DELETE CASCADE,
    email TEXT NOT NULL DEFAULT '',
    provider_id TEXT NOT NULL DEFAULT '',
    imap_host TEXT NOT NULL DEFAULT '',
    imap_port INTEGER NOT NULL DEFAULT 993,
    imap_secure INTEGER NOT NULL DEFAULT 1,
    proxy TEXT NOT NULL DEFAULT '',
    folder TEXT NOT NULL DEFAULT 'INBOX',
    sync_enabled INTEGER NOT NULL DEFAULT 1,
    sync_days INTEGER NOT NULL DEFAULT 30,
    max_body_bytes INTEGER NOT NULL DEFAULT 204800,
    status TEXT NOT NULL DEFAULT 'idle',
    last_error TEXT NOT NULL DEFAULT '',
    last_synced_at TEXT NOT NULL DEFAULT '',
    uid_validity INTEGER NOT NULL DEFAULT 0,
    last_uid INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sk_mail_accounts_sync ON sk_mail_accounts(sync_enabled, status)`,
  `CREATE TABLE IF NOT EXISTS sk_mail_messages (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES sk_mail_accounts(id) ON DELETE CASCADE,
    folder TEXT NOT NULL DEFAULT 'INBOX',
    uid INTEGER NOT NULL,
    message_id TEXT NOT NULL DEFAULT '',
    subject TEXT NOT NULL DEFAULT '',
    from_name TEXT NOT NULL DEFAULT '',
    from_addr TEXT NOT NULL DEFAULT '',
    to_json TEXT NOT NULL DEFAULT '[]',
    cc_json TEXT NOT NULL DEFAULT '[]',
    received_at TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    seen INTEGER NOT NULL DEFAULT 0,
    flagged INTEGER NOT NULL DEFAULT 0,
    has_attachment INTEGER NOT NULL DEFAULT 0,
    body_cached INTEGER NOT NULL DEFAULT 0,
    preview TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ''
  )`,
  // 幂等 upsert 的基石：同一账号同一文件夹同一 UID 只存一行
  `CREATE UNIQUE INDEX IF NOT EXISTS uidx_sk_mail_messages ON sk_mail_messages(account_id, folder, uid)`,
  `CREATE INDEX IF NOT EXISTS idx_sk_mail_messages_received ON sk_mail_messages(received_at DESC)`,
  `CREATE INDEX IF NOT EXISTS idx_sk_mail_messages_from ON sk_mail_messages(from_addr)`,
  `CREATE TABLE IF NOT EXISTS sk_mail_bodies (
    message_id INTEGER PRIMARY KEY REFERENCES sk_mail_messages(id) ON DELETE CASCADE,
    text_body TEXT NOT NULL DEFAULT '',
    html_body TEXT NOT NULL DEFAULT '',
    truncated INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS sk_mail_attachments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    message_id INTEGER NOT NULL REFERENCES sk_mail_messages(id) ON DELETE CASCADE,
    filename TEXT NOT NULL DEFAULT '',
    mime TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sk_mail_attachments_msg ON sk_mail_attachments(message_id)`,
  // 多文件夹：每个文件夹独立记录增量游标（M3）
  `CREATE TABLE IF NOT EXISTS sk_mail_folders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id INTEGER NOT NULL REFERENCES sk_mail_accounts(id) ON DELETE CASCADE,
    path TEXT NOT NULL DEFAULT '',
    uid_validity INTEGER NOT NULL DEFAULT 0,
    last_uid INTEGER NOT NULL DEFAULT 0,
    last_synced_at TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT ''
  )`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uidx_sk_mail_folders ON sk_mail_folders(account_id, path)`,
  // 附件本地缓存索引：只记落盘路径，二进制永不入库（M3，文件读写见 mail-cache.ts）
  `CREATE TABLE IF NOT EXISTS sk_mail_attachment_cache (
    attachment_id INTEGER PRIMARY KEY REFERENCES sk_mail_attachments(id) ON DELETE CASCADE,
    message_id INTEGER NOT NULL DEFAULT 0,
    file_path TEXT NOT NULL DEFAULT '',
    size INTEGER NOT NULL DEFAULT 0,
    cached_at TEXT NOT NULL DEFAULT ''
  )`,
  // 轻量键值表：FTS 回填游标等内部状态
  `CREATE TABLE IF NOT EXISTS sk_mail_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL DEFAULT ''
  )`,
];

let cachedDb: unknown = null;
const stmtCache = new Map<string, Stmt>();

/**
 * 取（并缓存）预处理语句。DB 实例变化时（如备份恢复后 closeDb 重开）自动重建缓存。
 * @param sql 参数化 SQL（禁止拼接外部输入）
 */
function stmt(sql: string): Stmt {
  const d = getDb();
  if (cachedDb !== d) {
    stmtCache.clear();
    cachedDb = d;
  }
  let s = stmtCache.get(sql);
  if (!s) {
    s = d.prepare(sql);
    stmtCache.set(sql, s);
  }
  return s;
}

/** 幂等建表（视图首次激活时调用；备份恢复后需重新调用以重建语句缓存） */
export function ensureMailSchema(): void {
  dbMigrate(MAIL_SCHEMA);
  ensureMailAccountColumns();
  ensureMailMessageColumns();
  ensureMailFtsTable();
  seedMailFolders();
  backfillMailFts();
  stmtCache.clear();
  cachedDb = getDb();
}

/** 存量库补列：sk_mail_accounts.folders（多文件夹，M3） */
function ensureMailAccountColumns(): void {
  const cols = (getDb().prepare(`PRAGMA table_info(sk_mail_accounts)`).all() as { name: string }[]).map((c) =>
    String(c.name),
  );
  if (!cols.includes('folders')) dbRun(`ALTER TABLE sk_mail_accounts ADD COLUMN folders TEXT NOT NULL DEFAULT ''`);
}

/** 存量库补列：sk_mail_messages.read_at（本地已读标记，IMAP 只读不改服务端 flag） */
function ensureMailMessageColumns(): void {
  const cols = (getDb().prepare(`PRAGMA table_info(sk_mail_messages)`).all() as { name: string }[]).map((c) =>
    String(c.name),
  );
  if (!cols.includes('read_at')) dbRun(`ALTER TABLE sk_mail_messages ADD COLUMN read_at TEXT NOT NULL DEFAULT ''`);
}

/** 有效已读态：服务端 seen 或 本地已读过（列表/详情/统计统一用它，避免口径不一致） */
const EFFECTIVE_READ_SQL = `(CASE WHEN m.seen = 1 OR COALESCE(m.read_at, '') <> '' THEN 1 ELSE 0 END) AS effective_read`;

function parseFolders(raw: string): string[] {
  try {
    const parsed = JSON.parse(raw || '[]');
    if (!Array.isArray(parsed)) return [];
    return Array.from(new Set(parsed.map((p) => String(p || '').trim()).filter(Boolean))).slice(0, 30);
  } catch {
    return [];
  }
}

/**
 * 存量账号补齐 folders 与 sk_mail_folders 行。
 * 主文件夹沿用账号级游标（uid_validity/last_uid），避免升级到多文件夹后触发全量重拉。
 */
function seedMailFolders(): void {
  const rows = stmt(`SELECT id, folder, folders, uid_validity, last_uid FROM sk_mail_accounts`).all() as Record<
    string,
    any
  >[];
  const now = new Date().toISOString();
  dbTransaction(() => {
    for (const r of rows) {
      const id = Number(r.id);
      const primary = String(r.folder || 'INBOX') || 'INBOX';
      let list = parseFolders(String(r.folders || ''));
      if (!list.length) {
        list = [primary];
        stmt(`UPDATE sk_mail_accounts SET folders = ? WHERE id = ?`).run(JSON.stringify(list), id);
      }
      for (const path of list) {
        const exists = stmt(`SELECT id FROM sk_mail_folders WHERE account_id = ? AND path = ?`).get(id, path);
        if (exists) continue;
        const isPrimary = path === primary;
        stmt(
          `INSERT INTO sk_mail_folders (account_id, path, uid_validity, last_uid, last_synced_at, created_at)
           VALUES (?, ?, ?, ?, ?, ?)`,
        ).run(
          id,
          path,
          isPrimary ? Number(r.uid_validity || 0) : 0,
          isPrimary ? Number(r.last_uid || 0) : 0,
          '',
          now,
        );
      }
    }
  });
}

const FTS_TABLE = 'sk_mail_fts';
const FTS_META_KEY = 'fts_indexed_upto';
/** 单封邮件参与索引的正文长度上限（尾部超长正文对检索收益有限，优先保证速度与体积） */
const FTS_BODY_MAX = 10000;
/** 每次 ensureMailSchema 兜底回填的最大邮件数（避免升级后首次调用卡住主线程） */
const FTS_BACKFILL_BATCH = 200;
const CJK_RE = /([㐀-䶿一-鿿぀-ヿ가-힯])/g; // \u3400-\u4dbf / \u4e00-\u9fff / \u3040-\u30ff / \uac00-\ud7af

let ftsChecked = false;
let ftsAvailable = false;

/** FTS5 是否可用（better-sqlite3 未编译 FTS5 时全文检索自动降级为 LIKE） */
export function isMailFtsAvailable(): boolean {
  ensureMailSchema();
  return ftsAvailable;
}

function ensureMailFtsTable(): void {
  if (ftsChecked) return;
  ftsChecked = true;
  try {
    getDb().exec(
      `CREATE VIRTUAL TABLE IF NOT EXISTS ${FTS_TABLE} USING fts5(subject, from_name, from_addr, body, tokenize='unicode61')`,
    );
    ftsAvailable = true;
  } catch {
    // 未启用 FTS5 编译选项：全文检索降级（见 listMailMessages）
    ftsAvailable = false;
  }
}

/** CJK 逐字补空格：unicode61 会把连续汉字视为一个 token，补空格后可用短语精确命中 */
function cjkPad(text: string): string {
  if (!text) return '';
  return text.replace(CJK_RE, ' $1 ');
}

/**
 * 关键词 → FTS5 MATCH 表达式。
 * @returns 空串表示无法构造（调用方回落到 LIKE 检索）
 */
export function toMailFtsQuery(keyword: string): string {
  const raw = String(keyword || '').trim().slice(0, 100);
  if (!raw) return '';
  const terms = raw.split(/[\s,;|]+/).filter(Boolean).slice(0, 6);
  const parts: string[] = [];
  for (const term of terms) {
    const tokens = cjkPad(term).split(/\s+/).filter(Boolean).slice(0, 20);
    if (!tokens.length) continue;
    parts.push(`"${tokens.join(' ').replace(/"/g, '""')}"`);
  }
  return parts.length ? parts.join(' AND ') : '';
}

/** 重建（或增量维护）指定邮件的全文索引；索引 rowid = sk_mail_messages.id */
export function indexMailMessages(ids: number[]): void {
  if (!ftsChecked) ensureMailSchema();
  if (!ftsAvailable || !ids.length) return;
  const del = stmt(`DELETE FROM ${FTS_TABLE} WHERE rowid = ?`);
  const ins = stmt(`INSERT INTO ${FTS_TABLE}(rowid, subject, from_name, from_addr, body) VALUES (?, ?, ?, ?, ?)`);
  const sel = stmt(
    `SELECT m.id AS id, m.subject AS subject, m.from_name AS from_name, m.from_addr AS from_addr,
            COALESCE(b.text_body, '') AS body
       FROM sk_mail_messages m
       LEFT JOIN sk_mail_bodies b ON b.message_id = m.id
      WHERE m.id = ?`,
  );
  dbTransaction(() => {
    for (const raw of ids) {
      const id = Number(raw);
      if (!Number.isFinite(id) || id <= 0) continue;
      del.run(id);
      const r = sel.get(id) as Record<string, any> | undefined;
      if (!r) continue;
      ins.run(
        id,
        cjkPad(String(r.subject || '')),
        cjkPad(String(r.from_name || '')),
        cjkPad(String(r.from_addr || '')),
        cjkPad(String(r.body || '').slice(0, FTS_BODY_MAX)),
      );
    }
  });
}

/** 删除邮件时同步清索引（FTS 虚拟表不支持外键级联） */
export function removeMailFtsByMessageFilter(accountId: number, folder?: string): void {
  if (!ftsChecked) ensureMailSchema();
  if (!ftsAvailable) return;
  if (folder) {
    stmt(`DELETE FROM ${FTS_TABLE} WHERE rowid IN (SELECT id FROM sk_mail_messages WHERE account_id = ? AND folder = ?)`).run(
      Number(accountId),
      folder,
    );
    return;
  }
  stmt(`DELETE FROM ${FTS_TABLE} WHERE rowid IN (SELECT id FROM sk_mail_messages WHERE account_id = ?)`).run(
    Number(accountId),
  );
}

/** 清理已无对应邮件的残留索引行 */
export function pruneMailFts(): number {
  if (!ftsChecked) ensureMailSchema();
  if (!ftsAvailable) return 0;
  const info = stmt(`DELETE FROM ${FTS_TABLE} WHERE rowid NOT IN (SELECT id FROM sk_mail_messages)`).run();
  return Number(info.changes) || 0;
}

/** 全量重建全文索引（设置页「重建索引」按钮） */
export function rebuildMailFts(): { total: number; indexed: number } {
  ensureMailSchema();
  const total = Number((stmt(`SELECT COUNT(*) AS c FROM sk_mail_messages`).get() as { c: number }).c) || 0;
  const maxId = Number((stmt(`SELECT COALESCE(MAX(id), 0) AS m FROM sk_mail_messages`).get() as { m: number }).m) || 0;
  if (!ftsAvailable) return { total, indexed: 0 };
  stmt(`DELETE FROM ${FTS_TABLE}`).run();
  let cursor = 0;
  let indexed = 0;
  // 分批插入，避免长事务与峰值内存
  for (;;) {
    const ids = (
      stmt(`SELECT id FROM sk_mail_messages WHERE id > ? ORDER BY id ASC LIMIT ?`).all(cursor, FTS_BACKFILL_BATCH) as {
        id: number;
      }[]
    ).map((r) => Number(r.id));
    if (!ids.length) break;
    indexMailMessages(ids);
    cursor = ids[ids.length - 1];
    indexed += ids.length;
    if (ids.length < FTS_BACKFILL_BATCH) break;
  }
  setMailMeta(FTS_META_KEY, String(maxId));
  return { total, indexed };
}

/** 索引状态（设置页展示：是否可用 / 已索引 / 总数） */
export function mailFtsStatus(): { available: boolean; total: number; indexed: number } {
  ensureMailSchema();
  const total = Number((stmt(`SELECT COUNT(*) AS c FROM sk_mail_messages`).get() as { c: number }).c) || 0;
  if (!ftsAvailable) return { available: false, total, indexed: 0 };
  const upto = Number(getMailMeta(FTS_META_KEY) || 0) || 0;
  const pending =
    Number((stmt(`SELECT COUNT(*) AS c FROM sk_mail_messages WHERE id > ?`).get(upto) as { c: number }).c) || 0;
  return { available: true, total, indexed: Math.max(0, total - pending) };
}

/** 增量回填：每次 ensureMailSchema 推进一小批，直到覆盖全部历史邮件 */
function backfillMailFts(): void {
  if (!ftsAvailable) return;
  const upto = Number(getMailMeta(FTS_META_KEY) || 0) || 0;
  const ids = (
    stmt(`SELECT id FROM sk_mail_messages WHERE id > ? ORDER BY id ASC LIMIT ?`).all(upto, FTS_BACKFILL_BATCH) as {
      id: number;
    }[]
  ).map((r) => Number(r.id));
  if (!ids.length) return;
  indexMailMessages(ids);
  setMailMeta(FTS_META_KEY, String(ids[ids.length - 1]));
}

function getMailMeta(key: string): string {
  const row = stmt(`SELECT value FROM sk_mail_meta WHERE key = ?`).get(key) as { value: string } | undefined;
  return row ? String(row.value || '') : '';
}

function setMailMeta(key: string, value: string): void {
  stmt(
    `INSERT INTO sk_mail_meta (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value`,
  ).run(key, String(value || ''));
}

function toAccountRow(r: Record<string, any>): MailAccountRow {
  return {
    id: Number(r.id),
    shopSetId: Number(r.shop_set_id),
    email: String(r.email || ''),
    providerId: String(r.provider_id || ''),
    imapHost: String(r.imap_host || ''),
    imapPort: Number(r.imap_port || 993),
    imapSecure: Number(r.imap_secure) === 1,
    proxy: String(r.proxy || ''),
    folder: String(r.folder || 'INBOX'),
    folders: parseFolders(String(r.folders || '')),
    syncEnabled: Number(r.sync_enabled) === 1,
    syncDays: Number(r.sync_days || 30),
    maxBodyBytes: Number(r.max_body_bytes || 204800),
    status: (MAIL_ACCOUNT_STATUSES.includes(r.status) ? r.status : 'idle') as MailAccountStatus,
    lastError: String(r.last_error || ''),
    lastSyncedAt: String(r.last_synced_at || ''),
    uidValidity: Number(r.uid_validity || 0),
    lastUid: Number(r.last_uid || 0),
    createdAt: String(r.created_at || ''),
    updatedAt: String(r.updated_at || ''),
  };
}

function toMessageRow(r: Record<string, any>): MailMessageRow {
  return {
    id: Number(r.id),
    accountId: Number(r.account_id),
    accountEmail: String(r.account_email || ''),
    folder: String(r.folder || ''),
    uid: Number(r.uid),
    messageId: String(r.message_id || ''),
    subject: String(r.subject || ''),
    fromName: String(r.from_name || ''),
    fromAddr: String(r.from_addr || ''),
    toJson: String(r.to_json || '[]'),
    ccJson: String(r.cc_json || '[]'),
    receivedAt: String(r.received_at || ''),
    size: Number(r.size || 0),
    seen: Number(r.seen) === 1,
    flagged: Number(r.flagged) === 1,
    hasAttachment: Number(r.has_attachment) === 1,
    bodyCached: Number(r.body_cached) === 1,
    preview: String(r.preview || ''),
    createdAt: String(r.created_at || ''),
    readAt: String(r.read_at || ''),
    read: Number(r.effective_read) === 1,
  };
}

const ACCOUNT_SELECT = `SELECT * FROM sk_mail_accounts`;

/** 新增或更新账号（shop_set_id 唯一，重复接入同一店铺套即覆盖配置） */
export function upsertMailAccount(input: MailAccountUpsertInput): number {
  ensureMailSchema();
  const now = new Date().toISOString();
  const shopSetId = Number(input.shopSetId);
  if (!Number.isFinite(shopSetId) || shopSetId <= 0) throw new Error('店铺套不存在或已被删除');

  const existing = stmt(`SELECT * FROM sk_mail_accounts WHERE shop_set_id = ?`).get(shopSetId) as
    | Record<string, any>
    | undefined;

  const values = {
    shopSetId,
    email: String(input.email || existing?.email || '').trim().slice(0, 200),
    providerId: String(input.providerId ?? existing?.provider_id ?? '').slice(0, 40),
    imapHost: String(input.imapHost ?? existing?.imap_host ?? '').trim().slice(0, 200),
    imapPort: Number(input.imapPort ?? existing?.imap_port ?? 993),
    imapSecure: input.imapSecure === undefined ? Number(existing?.imap_secure ?? 1) : input.imapSecure ? 1 : 0,
    proxy: String(input.proxy ?? existing?.proxy ?? '').trim().slice(0, 300),
    folder: String(input.folder ?? existing?.folder ?? 'INBOX').trim().slice(0, 200) || 'INBOX',
    folders: JSON.stringify(resolveFoldersInput(input.folders, input.folder, existing)),
    syncEnabled:
      input.syncEnabled === undefined ? Number(existing?.sync_enabled ?? 1) : input.syncEnabled ? 1 : 0,
    syncDays: Math.min(365, Math.max(1, Number(input.syncDays ?? existing?.sync_days ?? 30))),
    maxBodyBytes: Math.min(
      2 * 1024 * 1024,
      Math.max(8 * 1024, Number(input.maxBodyBytes ?? existing?.max_body_bytes ?? 204800)),
    ),
    now,
  };

  if (existing) {
    stmt(
      `UPDATE sk_mail_accounts SET
         email = @email, provider_id = @providerId, imap_host = @imapHost, imap_port = @imapPort,
         imap_secure = @imapSecure, proxy = @proxy, folder = @folder, folders = @folders,
         sync_enabled = @syncEnabled,
         sync_days = @syncDays, max_body_bytes = @maxBodyBytes, updated_at = @now
       WHERE shop_set_id = @shopSetId`,
    ).run(values);
    const accountId = Number(existing.id);
    replaceMailFolders(accountId, JSON.parse(String(values.folders || '[]')) as string[]);
    return accountId;
  }

  const info = stmt(
    `INSERT INTO sk_mail_accounts
       (shop_set_id, email, provider_id, imap_host, imap_port, imap_secure, proxy, folder, folders,
        sync_enabled, sync_days, max_body_bytes, status, last_error, last_synced_at,
        uid_validity, last_uid, created_at, updated_at)
     VALUES
       (@shopSetId, @email, @providerId, @imapHost, @imapPort, @imapSecure, @proxy, @folder, @folders,
        @syncEnabled, @syncDays, @maxBodyBytes, 'idle', '', '', 0, 0, @now, @now)`,
  ).run(values);
  const accountId = Number(info.lastInsertRowid);
  replaceMailFolders(accountId, JSON.parse(String(values.folders || '[]')) as string[]);
  return accountId;
}

/** 归一化 folders 入参：省略则沿用原值，仍为空则回退单文件夹 folder */
function resolveFoldersInput(
  input: string[] | undefined,
  folder: string | undefined,
  existing: Record<string, any> | undefined,
): string[] {
  if (Array.isArray(input)) {
    const list = Array.from(new Set(input.map((p) => String(p || '').trim()).filter(Boolean))).slice(0, 30);
    if (list.length) return list;
  }
  const fallback = parseFolders(String(existing?.folders || ''));
  if (fallback.length) return fallback;
  return [String(folder ?? existing?.folder ?? 'INBOX').trim().slice(0, 200) || 'INBOX'];
}

/** 账号列表（含状态与游标，供设置页/收件箱展示） */
export function listMailAccounts(): MailAccountRow[] {
  ensureMailSchema();
  const rows = stmt(`${ACCOUNT_SELECT} ORDER BY id ASC`).all() as Record<string, any>[];
  return rows.map(toAccountRow);
}

/** 按 id 取账号 */
export function getMailAccount(id: number): MailAccountRow | undefined {
  ensureMailSchema();
  const row = stmt(`SELECT * FROM sk_mail_accounts WHERE id = ?`).get(Number(id) || 0) as
    | Record<string, any>
    | undefined;
  return row ? toAccountRow(row) : undefined;
}

/** 按店铺套 id 取账号 */
export function getMailAccountByShopSet(shopSetId: number): MailAccountRow | undefined {
  ensureMailSchema();
  const row = stmt(`SELECT * FROM sk_mail_accounts WHERE shop_set_id = ?`).get(Number(shopSetId) || 0) as
    | Record<string, any>
    | undefined;
  return row ? toAccountRow(row) : undefined;
}

/** 删除账号（邮件/附件/缓存索引经外键级联删除，全文索引需手动清理） */
export function deleteMailAccount(id: number): void {
  ensureMailSchema();
  dbTransaction(() => {
    removeMailFtsByMessageFilter(Number(id) || 0);
    stmt(`DELETE FROM sk_mail_accounts WHERE id = ?`).run(Number(id) || 0);
  });
}

/** 更新同步状态（status/lastError/lastSyncedAt 三者可选） */
export function updateMailAccountStatus(
  id: number,
  patch: { status?: MailAccountStatus; lastError?: string; lastSyncedAt?: string },
): void {
  ensureMailSchema();
  const acc = getMailAccount(id);
  if (!acc) return;
  stmt(
    `UPDATE sk_mail_accounts SET status = ?, last_error = ?, last_synced_at = ?, updated_at = ? WHERE id = ?`,
  ).run(
    patch.status ?? acc.status,
    String(patch.lastError ?? acc.lastError).slice(0, 500),
    patch.lastSyncedAt ?? acc.lastSyncedAt,
    new Date().toISOString(),
    Number(id),
  );
}

/** 更新增量游标（uidValidity 变化由引擎负责先清空重拉） */
export function updateMailCursor(id: number, uidValidity: number, lastUid: number): void {
  ensureMailSchema();
  stmt(
    `UPDATE sk_mail_accounts SET uid_validity = ?, last_uid = ?, last_synced_at = ?, updated_at = ? WHERE id = ?`,
  ).run(uidValidity, lastUid, new Date().toISOString(), new Date().toISOString(), Number(id));
}

/** 清空某账号（可选某文件夹）的全部邮件并重置游标——UIDVALIDITY 变化时调用 */
export function resetMailAccountMessages(id: number, folder?: string): void {
  ensureMailSchema();
  const accountId = Number(id);
  dbTransaction(() => {
    if (folder) {
      stmt(`DELETE FROM sk_mail_messages WHERE account_id = ? AND folder = ?`).run(accountId, folder);
      stmt(`UPDATE sk_mail_folders SET uid_validity = 0, last_uid = 0, last_synced_at = '' WHERE account_id = ? AND path = ?`).run(accountId, folder);
    } else {
      stmt(`DELETE FROM sk_mail_messages WHERE account_id = ?`).run(accountId);
      stmt(`UPDATE sk_mail_folders SET uid_validity = 0, last_uid = 0, last_synced_at = '' WHERE account_id = ?`).run(accountId);
    }
    stmt(`UPDATE sk_mail_accounts SET uid_validity = 0, last_uid = 0 WHERE id = ?`).run(accountId);
  });
  removeMailFtsByMessageFilter(accountId, folder);
}

/** 取某账号某文件夹已有邮件的 uid → {id, bodyCached} 索引（用于增量判断是否需要补正文） */
export function getMessageIndex(
  accountId: number,
  folder: string,
): Map<number, { id: number; bodyCached: boolean }> {
  ensureMailSchema();
  const rows = stmt(
    `SELECT uid, id, body_cached FROM sk_mail_messages WHERE account_id = ? AND folder = ?`,
  ).all(Number(accountId), folder) as Record<string, any>[];
  const map = new Map<number, { id: number; bodyCached: boolean }>();
  for (const r of rows) map.set(Number(r.uid), { id: Number(r.id), bodyCached: Number(r.body_cached) === 1 });
  return map;
}

/** 批量 upsert 邮件元数据（幂等：冲突则更新可变字段），整体走事务 */
export function upsertMailMessages(rows: MailMessageUpsertRow[]): void {
  if (!rows.length) return;
  ensureMailSchema();
  const insert = stmt(
    `INSERT INTO sk_mail_messages
       (account_id, folder, uid, message_id, subject, from_name, from_addr, to_json, cc_json,
        received_at, size, seen, flagged, has_attachment, body_cached, preview, created_at)
     VALUES
       (@accountId, @folder, @uid, @messageId, @subject, @fromName, @fromAddr, @toJson, @ccJson,
        @receivedAt, @size, @seen, @flagged, @hasAttachment, 0, @preview, @now)
     ON CONFLICT(account_id, folder, uid) DO UPDATE SET
       message_id = excluded.message_id, subject = excluded.subject, from_name = excluded.from_name,
       from_addr = excluded.from_addr, to_json = excluded.to_json, cc_json = excluded.cc_json,
       received_at = excluded.received_at, size = excluded.size, seen = excluded.seen,
       flagged = excluded.flagged, has_attachment = excluded.has_attachment, preview = excluded.preview`,
  );
  dbTransaction(() => {
    for (const r of rows) {
      insert.run({
        accountId: r.accountId,
        folder: r.folder,
        uid: r.uid,
        messageId: r.messageId.slice(0, 300),
        subject: r.subject.slice(0, 500),
        fromName: r.fromName.slice(0, 200),
        fromAddr: r.fromAddr.slice(0, 200),
        toJson: r.toJson.slice(0, 2000),
        ccJson: r.ccJson.slice(0, 2000),
        receivedAt: r.receivedAt,
        size: r.size,
        seen: r.seen ? 1 : 0,
        flagged: r.flagged ? 1 : 0,
        hasAttachment: r.hasAttachment ? 1 : 0,
        preview: r.preview.slice(0, 300),
        now: new Date().toISOString(),
      });
    }
  });
  indexMailMessages(collectMessageIds(rows));
}

/** 按 (account_id, folder, uid) 回查本批邮件的自增 id（供全文索引维护使用） */
function collectMessageIds(rows: MailMessageUpsertRow[]): number[] {
  const grouped = new Map<string, { accountId: number; folder: string; uids: number[] }>();
  for (const r of rows) {
    // 复合键用 \x00 作分隔符：accountId 是数字、folder 来自 IMAP，都不可能含 NUL，
    // 故不会与 "1"+"23" 这类拼接产生歧义。\x00 必须写成**转义**——裸控制字节会让整个
    // 文件被 file(1)/grep(1) 判定为二进制（BSD grep 静默跳过），语义完全一致。（R2-8）
    const key = `${r.accountId}\x00${r.folder}`;
    const g = grouped.get(key) || { accountId: r.accountId, folder: r.folder, uids: [] };
    if (!g.uids.includes(r.uid)) g.uids.push(r.uid);
    grouped.set(key, g);
  }
  const ids: number[] = [];
  for (const g of grouped.values()) {
    for (let i = 0; i < g.uids.length; i += 400) {
      const chunk = g.uids.slice(i, i + 400);
      const ph = chunk.map(() => '?').join(',');
      const found = stmt(
        `SELECT id FROM sk_mail_messages WHERE account_id = ? AND folder = ? AND uid IN (${ph})`,
      ).all(g.accountId, g.folder, ...chunk) as { id: number }[];
      for (const f of found) ids.push(Number(f.id));
    }
  }
  return ids;
}

/**
 * 写入正文并标记已缓存。
 * @param opts.index 是否立即维护全文索引（同步循环批量保存时传 false，由调用方末尾统一 indexMailMessages）
 */
export function saveMailBody(
  messageId: number,
  textBody: string,
  htmlBody: string,
  truncated: boolean,
  opts?: { index?: boolean },
): void {
  ensureMailSchema();
  dbTransaction(() => {
    stmt(
      `INSERT INTO sk_mail_bodies (message_id, text_body, html_body, truncated)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(message_id) DO UPDATE SET
         text_body = excluded.text_body, html_body = excluded.html_body, truncated = excluded.truncated`,
    ).run(Number(messageId), textBody, htmlBody, truncated ? 1 : 0);
    stmt(`UPDATE sk_mail_messages SET body_cached = 1 WHERE id = ?`).run(Number(messageId));
  });
  if (opts?.index !== false) indexMailMessages([Number(messageId)]);
}

/**
 * 整封替换附件元信息。
 * 采用「同键保留原 id」的合并写：重解析后同一附件不会换 id，本地缓存索引与已落盘文件得以复用
 * （若先清后写，每次重同步都会让 attachment_id 漂移，缓存将永久失效）。
 */
export function replaceMailAttachments(
  messageId: number,
  items: { filename: string; mime: string; size: number }[],
): void {
  ensureMailSchema();
  const mid = Number(messageId);
  const incoming = items.slice(0, 100).map((it) => ({
    filename: String(it.filename || '').slice(0, 300),
    mime: String(it.mime || '').slice(0, 120),
    size: Number(it.size) || 0,
  }));
  dbTransaction(() => {
    const existing = (
      stmt(`SELECT id, filename, mime, size FROM sk_mail_attachments WHERE message_id = ? ORDER BY id ASC`).all(
        mid,
      ) as Record<string, any>[]
    ).map((r) => ({
      id: Number(r.id),
      filename: String(r.filename || ''),
      mime: String(r.mime || ''),
      size: Number(r.size || 0),
    }));
    const insert = stmt(`INSERT INTO sk_mail_attachments (message_id, filename, mime, size) VALUES (?, ?, ?, ?)`);
    const remove = stmt(`DELETE FROM sk_mail_attachments WHERE id = ?`);
    const pool = new Map<string, number[]>();
    // 复合键同 collectMessageIds：filename / mime 都可能含空格或 '-'，故用 \x00 分隔（转义写法，见上）
    for (const e of existing) {
      const key = `${e.filename}\x00${e.mime}\x00${e.size}`;
      pool.set(key, [...(pool.get(key) || []), e.id]);
    }
    const kept = new Set<number>();
    for (const it of incoming) {
      const key = `${it.filename}\x00${it.mime}\x00${it.size}`;
      const bucket = pool.get(key);
      if (bucket && bucket.length) {
        kept.add(Number(bucket.shift()));
        continue;
      }
      insert.run(mid, it.filename, it.mime, it.size);
    }
    for (const e of existing) {
      if (!kept.has(e.id)) remove.run(e.id);
    }
  });
}

/**
 * 正文解析完成后回写派生字段（预览文本 / 附件标记）。
 * 与正文写入分开调用：超大邮件的正文可能不落库，但预览仍需更新。
 */
export function updateMailParsed(
  id: number,
  patch: { preview?: string; hasAttachment?: boolean },
): void {
  ensureMailSchema();
  const sets: string[] = [];
  const params: Record<string, any> = { id: Number(id) };
  if (patch.preview !== undefined) {
    sets.push(`preview = @preview`);
    params.preview = String(patch.preview).slice(0, 300);
  }
  if (patch.hasAttachment !== undefined) {
    sets.push(`has_attachment = @hasAttachment`);
    params.hasAttachment = patch.hasAttachment ? 1 : 0;
  }
  if (!sets.length) return;
  stmt(`UPDATE sk_mail_messages SET ${sets.join(', ')} WHERE id = @id`).run(params);
}

export interface MailMessageListFilter {
  accountIds?: number[];
  keyword?: string;
  unreadOnly?: boolean;
  since?: string;
  /** 多文件夹过滤（M3）：只显示指定文件夹的邮件 */
  folders?: string[];
  limit?: number;
  offset?: number;
}

/**
 * 关键词全文检索（FTS5）。
 * @returns 命中的邮件 id 列表；FTS 不可用或查询无法构造时返回空数组（调用方回落 LIKE）
 */
export function searchMailFtsIds(keyword: string, limit = 2000): number[] {
  if (!ftsChecked) ensureMailSchema();
  const query = toMailFtsQuery(keyword);
  if (!ftsAvailable || !query) return [];
  try {
    const rows = stmt(
      `SELECT rowid AS id FROM ${FTS_TABLE} WHERE ${FTS_TABLE} MATCH ? ORDER BY rank LIMIT ?`,
    ).all(query, Math.min(2000, Math.max(1, Number(limit) || 2000))) as { id: number }[];
    return rows.map((r) => Number(r.id)).filter((n) => n > 0);
  } catch {
    return [];
  }
}

/**
 * 邮件列表（**纯本地查询，绝不触网**——这是列表能秒开的前提）。
 * 关键词：优先走 FTS5 全文索引（主题 / 发件人 / 正文），不可用时回落 LIKE（主题 / 发件人 / 预览）。
 */
export function listMailMessages(filter: MailMessageListFilter = {}): {
  items: MailMessageRow[];
  total: number;
} {
  ensureMailSchema();
  const where: string[] = [];
  const params: Record<string, any> = {};

  const ids = (filter.accountIds || []).map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (ids.length) {
    where.push(`m.account_id IN (${ids.map((_, i) => `@id${i}`).join(',')})`);
    ids.forEach((id, i) => {
      params[`id${i}`] = id;
    });
  }
  if (filter.unreadOnly) where.push(`m.seen = 0 AND COALESCE(m.read_at, '') = ''`);
  if (filter.since) {
    where.push(`m.received_at >= @since`);
    params.since = String(filter.since);
  }
  const folders = (filter.folders || []).map((f) => String(f || '').trim()).filter(Boolean);
  if (folders.length) {
    where.push(`m.folder IN (${folders.map((_, i) => `@fd${i}`).join(',')})`);
    folders.forEach((f, i) => {
      params[`fd${i}`] = f;
    });
  }
  const keyword = String(filter.keyword || '').trim();
  if (keyword) {
    const ftsIds = searchMailFtsIds(keyword);
    if (ftsIds.length) {
      where.push(`m.id IN (${ftsIds.map((_, i) => `@ft${i}`).join(',')})`);
      ftsIds.forEach((id, i) => {
        params[`ft${i}`] = id;
      });
    } else {
      where.push(`(m.subject LIKE @kw OR m.from_addr LIKE @kw OR m.from_name LIKE @kw OR m.preview LIKE @kw)`);
      params.kw = `%${keyword.slice(0, 100)}%`;
    }
  }

  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';
  const total = Number(
    (stmt(`SELECT COUNT(*) AS c FROM sk_mail_messages m ${whereSql}`).get(params) as { c: number }).c,
  );

  const limit = Math.min(200, Math.max(1, Number(filter.limit) || 50));
  const offset = Math.max(0, Number(filter.offset) || 0);
  const rows = stmt(
    `SELECT m.*, ${EFFECTIVE_READ_SQL}, a.email AS account_email
       FROM sk_mail_messages m
       LEFT JOIN sk_mail_accounts a ON a.id = m.account_id
       ${whereSql}
      ORDER BY m.received_at DESC, m.uid DESC
      LIMIT @limit OFFSET @offset`,
  ).all({ ...params, limit, offset }) as Record<string, any>[];

  return { items: rows.map(toMessageRow), total };
}

/** 邮件详情（含正文与附件元信息） */
export function getMailMessage(id: number): MailMessageDetail | null {
  ensureMailSchema();
  const row = stmt(
    `SELECT m.*, ${EFFECTIVE_READ_SQL}, a.email AS account_email
       FROM sk_mail_messages m
       LEFT JOIN sk_mail_accounts a ON a.id = m.account_id
      WHERE m.id = ?`,
  ).get(Number(id) || 0) as Record<string, any> | undefined;
  if (!row) return null;
  const body = stmt(`SELECT * FROM sk_mail_bodies WHERE message_id = ?`).get(Number(id)) as
    | Record<string, any>
    | undefined;
  const attachments = stmt(
    `SELECT * FROM sk_mail_attachments WHERE message_id = ? ORDER BY id ASC`,
  ).all(Number(id)) as Record<string, any>[];
  return {
    ...toMessageRow(row),
    textBody: String(body?.text_body || ''),
    htmlBody: String(body?.html_body || ''),
    truncated: Number(body?.truncated) === 1,
    attachments: attachments.map((a) => ({
      id: Number(a.id),
      messageId: Number(a.message_id),
      filename: String(a.filename || ''),
      mime: String(a.mime || ''),
      size: Number(a.size || 0),
    })),
  };
}

/**
 * 本地标记已读 / 恢复未读。
 *  IMAP 只读，不改服务端 flag，因此"已读"必须由本地记录兜底，否则重新同步会把 seen 覆盖回服务端值。
 *  服务端本就 seen=1 的邮件无法本地改回未读（有效已读为二者取或）。
 * @param ids 邮件 id 列表（上限 500）
 * @param read true=标记已读；false=恢复未读
 * @returns 实际变更行数
 */
export function markMailMessagesRead(ids: number[], read: boolean): number {
  ensureMailSchema();
  const list = (Array.isArray(ids) ? ids : [])
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
    .slice(0, 500);
  if (!list.length) return 0;
  const params: Record<string, any> = { now: new Date().toISOString() };
  list.forEach((id, i) => {
    params[`id${i}`] = id;
  });
  const idsSql = list.map((_, i) => `@id${i}`).join(',');
  const setSql = read ? `read_at = @now` : `read_at = ''`;
  // 幂等：只对状态尚未达标的行更新，避免重复写入
  const cond = read ? `COALESCE(read_at, '') = ''` : `COALESCE(read_at, '') <> '' AND seen = 0`;
  let changed = 0;
  dbTransaction(() => {
    const info = stmt(`UPDATE sk_mail_messages SET ${setSql} WHERE id IN (${idsSql}) AND ${cond}`).run(params);
    changed = Number(info.changes) || 0;
  });
  return changed;
}

/**
 * 批量标记某账号（省略则全部账号）的邮件为已读 / 未读。
 * @returns 实际变更行数
 */
export function markAllMailMessagesRead(accountId: number | undefined, read: boolean): number {
  ensureMailSchema();
  const accId = Number(accountId) || 0;
  const where: string[] = [];
  const params: Record<string, any> = { now: new Date().toISOString() };
  if (accId > 0) {
    where.push(`account_id = @accId`);
    params.accId = accId;
  }
  const setSql = read ? `read_at = @now` : `read_at = ''`;
  const cond = read ? `COALESCE(read_at, '') = ''` : `COALESCE(read_at, '') <> '' AND seen = 0`;
  where.push(cond);
  let changed = 0;
  dbTransaction(() => {
    const info = stmt(`UPDATE sk_mail_messages SET ${setSql} WHERE ${where.join(' AND ')}`).run(params);
    changed = Number(info.changes) || 0;
  });
  return changed;
}

/**
 * 清理过期邮件（正文与附件经外键级联删除）。
 * @param accountId 省略则清理全部账号
 * @param beforeIso 早于该 ISO 时间的邮件将被删除
 * @returns 删除行数
 */
export function purgeMailMessages(accountId?: number, beforeIso?: string): number {
  ensureMailSchema();
  const id = Number(accountId) || 0;
  const before = String(beforeIso || '');
  if (!before) return 0;
  let changes = 0;
  dbTransaction(() => {
    if (ftsAvailable) {
      if (id > 0) {
        stmt(
          `DELETE FROM ${FTS_TABLE} WHERE rowid IN (SELECT id FROM sk_mail_messages WHERE account_id = ? AND received_at < ?)`,
        ).run(id, before);
      } else {
        stmt(
          `DELETE FROM ${FTS_TABLE} WHERE rowid IN (SELECT id FROM sk_mail_messages WHERE received_at < ?)`,
        ).run(before);
      }
    }
    const info =
      id > 0
        ? stmt(`DELETE FROM sk_mail_messages WHERE account_id = ? AND received_at < ?`).run(id, before)
        : stmt(`DELETE FROM sk_mail_messages WHERE received_at < ?`).run(before);
    changes = Number(info.changes) || 0;
  });
  return changes;
}

/** 收件箱汇总（账号数 / 邮件数 / 未读数 / 最近同步时间） */
export function mailStats(): {
  accounts: number;
  messages: number;
  unread: number;
  lastSyncedAt: string;
  folders: { path: string; count: number }[];
} {
  ensureMailSchema();
  const a = stmt(`SELECT COUNT(*) AS c, MAX(last_synced_at) AS t FROM sk_mail_accounts`).get() as {
    c: number;
    t: string | null;
  };
  const m = stmt(
    `SELECT COUNT(*) AS c, SUM(CASE WHEN seen = 0 AND COALESCE(read_at, '') = '' THEN 1 ELSE 0 END) AS u FROM sk_mail_messages`,
  ).get() as {
    c: number;
    u: number | null;
  };
  // 本地已收邮件的文件夹分布（供列表的文件夹筛选器使用）
  const f = stmt(
    `SELECT folder AS path, COUNT(*) AS c FROM sk_mail_messages GROUP BY folder ORDER BY folder ASC LIMIT 100`,
  ).all() as Record<string, any>[];
  return {
    accounts: Number(a.c) || 0,
    messages: Number(m.c) || 0,
    unread: Number(m.u) || 0,
    lastSyncedAt: String(a.t || ''),
    folders: f.map((r) => ({ path: String(r.path || ''), count: Number(r.c) || 0 })).filter((x) => !!x.path),
  };
}

/** 账号实际参与同步的文件夹列表（folders 为空时回退单文件夹 folder） */
export function resolveMailFolders(account: { folder: string; folders?: string[] }): string[] {
  const list = (account.folders || []).map((p) => String(p || '').trim()).filter(Boolean);
  return list.length ? list : [String(account.folder || 'INBOX') || 'INBOX'];
}

/** 取文件夹级同步游标（多文件夹下增量位置按文件夹分别记录） */
export function getMailFolderCursor(
  accountId: number,
  folder: string,
): { uidValidity: number; lastUid: number } {
  ensureMailSchema();
  const row = stmt(`SELECT uid_validity, last_uid FROM sk_mail_folders WHERE account_id = ? AND path = ?`).get(
    Number(accountId),
    folder,
  ) as Record<string, any> | undefined;
  return { uidValidity: Number(row?.uid_validity || 0), lastUid: Number(row?.last_uid || 0) };
}

/** 更新文件夹级同步游标（不存在则创建） */
export function updateMailFolderCursor(
  accountId: number,
  folder: string,
  uidValidity: number,
  lastUid: number,
): void {
  ensureMailSchema();
  const now = new Date().toISOString();
  stmt(
    `INSERT INTO sk_mail_folders (account_id, path, uid_validity, last_uid, last_synced_at, created_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id, path) DO UPDATE SET
       uid_validity = excluded.uid_validity, last_uid = excluded.last_uid, last_synced_at = excluded.last_synced_at`,
  ).run(Number(accountId), folder, Number(uidValidity) || 0, Number(lastUid) || 0, now, now);
}

/** 列出账号已配置的同步文件夹（含游标） */
export function listMailFolders(accountId?: number): MailFolderRow[] {
  ensureMailSchema();
  const id = Number(accountId) || 0;
  const rows = (
    id > 0
      ? stmt(`SELECT * FROM sk_mail_folders WHERE account_id = ? ORDER BY path ASC`).all(id)
      : stmt(`SELECT * FROM sk_mail_folders ORDER BY account_id ASC, path ASC`).all()
  ) as Record<string, any>[];
  return rows.map((r) => ({
    id: Number(r.id),
    accountId: Number(r.account_id),
    path: String(r.path || ''),
    uidValidity: Number(r.uid_validity || 0),
    lastUid: Number(r.last_uid || 0),
    lastSyncedAt: String(r.last_synced_at || ''),
    createdAt: String(r.created_at || ''),
  }));
}

/**
 * 覆盖账号的同步文件夹集合：新增的从 0 开始拉，移除的仅清游标（已收邮件保留，避免数据丢失）。
 */
export function replaceMailFolders(accountId: number, folders: string[]): void {
  ensureMailSchema();
  const id = Number(accountId);
  if (id <= 0) return;
  const list = Array.from(new Set((folders || []).map((p) => String(p || '').trim()).filter(Boolean))).slice(0, 30);
  if (!list.length) return;
  const now = new Date().toISOString();
  dbTransaction(() => {
    stmt(`DELETE FROM sk_mail_folders WHERE account_id = ? AND path NOT IN (${list.map(() => '?').join(',')})`).run(
      id,
      ...list,
    );
    const insert = stmt(
      `INSERT INTO sk_mail_folders (account_id, path, uid_validity, last_uid, last_synced_at, created_at)
       VALUES (?, ?, 0, 0, '', ?) ON CONFLICT(account_id, path) DO NOTHING`,
    );
    for (const path of list) insert.run(id, path, now);
    stmt(`UPDATE sk_mail_accounts SET folders = ? WHERE id = ?`).run(JSON.stringify(list), id);
  });
}

/** 附件元信息（缓存落盘前用于确定文件名/类型） */
export function getMailAttachmentRow(id: number): MailAttachmentRow | null {
  ensureMailSchema();
  const row = stmt(`SELECT * FROM sk_mail_attachments WHERE id = ?`).get(Number(id) || 0) as
    | Record<string, any>
    | undefined;
  if (!row) return null;
  return {
    id: Number(row.id),
    messageId: Number(row.message_id),
    filename: String(row.filename || ''),
    mime: String(row.mime || ''),
    size: Number(row.size || 0),
  };
}

/** 取附件缓存索引（未缓存返回 null） */
export function getMailAttachmentCacheRow(attachmentId: number): MailAttachmentCacheRow | null {
  ensureMailSchema();
  const row = stmt(`SELECT * FROM sk_mail_attachment_cache WHERE attachment_id = ?`).get(Number(attachmentId) || 0) as
    | Record<string, any>
    | undefined;
  if (!row) return null;
  return {
    attachmentId: Number(row.attachment_id),
    messageId: Number(row.message_id),
    filePath: String(row.file_path || ''),
    size: Number(row.size || 0),
    cachedAt: String(row.cached_at || ''),
  };
}

/** 写入/更新附件缓存索引 */
export function putMailAttachmentCacheRow(row: {
  attachmentId: number;
  messageId: number;
  filePath: string;
  size: number;
}): void {
  ensureMailSchema();
  stmt(
    `INSERT INTO sk_mail_attachment_cache (attachment_id, message_id, file_path, size, cached_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(attachment_id) DO UPDATE SET
       message_id = excluded.message_id, file_path = excluded.file_path,
       size = excluded.size, cached_at = excluded.cached_at`,
  ).run(
    Number(row.attachmentId),
    Number(row.messageId),
    String(row.filePath || ''),
    Number(row.size) || 0,
    new Date().toISOString(),
  );
}

/** 按缓存时间升序列出缓存索引（供 LRU 淘汰使用） */
export function listMailAttachmentCacheRows(limit = 500): MailAttachmentCacheRow[] {
  ensureMailSchema();
  const rows = stmt(
    `SELECT * FROM sk_mail_attachment_cache ORDER BY cached_at ASC, attachment_id ASC LIMIT ?`,
  ).all(Math.min(2000, Math.max(1, Number(limit) || 500))) as Record<string, any>[];
  return rows.map((r) => ({
    attachmentId: Number(r.attachment_id),
    messageId: Number(r.message_id),
    filePath: String(r.file_path || ''),
    size: Number(r.size) || 0,
    cachedAt: String(r.cached_at || ''),
  }));
}

/** 删除缓存索引（调用方负责删除磁盘文件） */
export function deleteMailAttachmentCacheRows(attachmentIds: number[]): void {
  ensureMailSchema();
  const ids = attachmentIds.map(Number).filter((n) => Number.isFinite(n) && n > 0);
  if (!ids.length) return;
  dbTransaction(() => {
    const del = stmt(`DELETE FROM sk_mail_attachment_cache WHERE attachment_id = ?`);
    for (const id of ids) del.run(id);
  });
}

/** 清空缓存索引（清空缓存目录时调用） */
export function clearMailAttachmentCacheRows(): void {
  ensureMailSchema();
  stmt(`DELETE FROM sk_mail_attachment_cache`).run();
}

/** 缓存占用统计（条数 / 字节） */
export function mailAttachmentCacheStats(): { files: number; bytes: number } {
  ensureMailSchema();
  const row = stmt(
    `SELECT COUNT(*) AS c, COALESCE(SUM(size), 0) AS s FROM sk_mail_attachment_cache`,
  ).get() as { c: number; s: number };
  return { files: Number(row.c) || 0, bytes: Number(row.s) || 0 };
}
