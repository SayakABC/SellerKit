// 「店铺账号管家」（extensions/shop-accounts）主进程数据访问层，基于 electron/db.ts 公共层。
//
// 业务模型：一行 = **一套店铺**（店群中的一个邮箱主体，邮箱为业务主键）：
//   邮箱 + 店铺密码（平台登录密码）/ 邮箱密码 / 关联手机号 / 关联企业名称
//   / 关联支付宝 + 支付宝支付密码 / 关联紫鸟账号 + 紫鸟密码 / ERP账号 + ERP密码
//   / 关联平台（可多选，既支持单平台，也支持一个邮箱跨平台复用）/ 状态 / 标签 / 备注
//
// 存储策略（单表 + 密文列，敏感字段演进无需 ALTER TABLE）：
//   - sk_shop_sets 明文列 = 可检索元数据（邮箱/手机/企业/支付宝/紫鸟账号/ERP账号/平台/状态/标签/备注）；
//   - secret_enc  = 敏感字段（店铺密码/邮箱密码/支付宝支付密码/紫鸟密码/ERP密码）整体 JSON 加密后的 BLOB；
//   - secret_keys = 密文中实际存在的字段名数组（明文，仅供列表展示「已配置」徽标，不泄露任何值）。
//
// 加密：主进程 Electron safeStorage（macOS Keychain / Windows DPAPI / Linux 钥匙串）。
//   BLOB 首字节标记：'E' = safeStorage 密文；'P' = 安全存储不可用时的明文降级。
// 安全边界：明文密码仅在 shop-account-get / shop-account-reveal 通道按需返回；
//   列表接口永不返回明文（仅 secretKeys 徽标）——见 AGENTS.md §1.7 与红线 3。

export {};

import { dbMigrate, dbGet, dbRun, dbQuery, dbTransaction } from './db';

const { safeStorage } = require('electron');

/** 普通对象判定（入参形状校验用；排除数组/null） */
function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** 店铺状态：在用 / 停用 / 封店 / 已注销 */
export type ShopAccountStatus = 'active' | 'paused' | 'banned' | 'closed';

/** 状态白名单（用于入参校验与统计兜底） */
export const SHOP_ACCOUNT_STATUSES: ShopAccountStatus[] = ['active', 'paused', 'banned', 'closed'];

/**
 * 敏感字段键（聚合为一个加密 JSON，新增键无需改表）
 * mailAuthPwd = **IMAP 授权码**（集中邮件收件箱专用）。
 * 注意：与 emailPwd（网页登录密码）是两套凭据——163/126 的 IMAP 只认授权码。
 */
export type ShopAccountSecretKey =
  | 'shopPwd'
  | 'emailPwd'
  | 'alipayPwd'
  | 'ziniaoPwd'
  | 'erpPwd'
  | 'mailAuthPwd';

/** 敏感字段白名单 */
export const SHOP_ACCOUNT_SECRET_KEYS: ShopAccountSecretKey[] = [
  'shopPwd',
  'emailPwd',
  'alipayPwd',
  'ziniaoPwd',
  'erpPwd',
  'mailAuthPwd',
];

/** 平台数量上限（防止异常输入撑爆单行） */
const MAX_PLATFORM_COUNT = 20;

/**
 * 批量修改中「单值覆盖」文本字段 → 数据库列名映射。
 * 这四者为唯一标识（手机号 / 支付宝 / 紫鸟账号 / ERP 账号），同一字段追加多值无业务意义，
 * 故批量修改仅提供覆盖语义。
 */
const SINGLE_TEXT_BATCH_FIELDS: {
  key: 'phone' | 'alipay' | 'ziniaoAccount' | 'erpAccount';
  column: string;
}[] = [
  { key: 'phone', column: 'phone' },
  { key: 'alipay', column: 'alipay' },
  { key: 'ziniaoAccount', column: 'ziniao_account' },
  { key: 'erpAccount', column: 'erp_account' },
];

/** 传入的店铺套字段（与渲染层 src/types.ts 的 ShopAccountUpsertInput 保持一致） */
export interface ShopAccountUpsertInput {
  id?: number;
  email?: string;
  shopPwd?: string;
  emailPwd?: string;
  phone?: string;
  company?: string;
  alipay?: string;
  alipayPwd?: string;
  ziniaoAccount?: string;
  ziniaoPwd?: string;
  erpAccount?: string;
  erpPwd?: string;
  /** IMAP 授权码：账号编辑器 UI 不出现（见 src/types.ts ShopAccountSecretField），但收件箱接入流程经本通道写入 */
  mailAuthPwd?: string;
  platforms?: string[];
  /** 开店时间（YYYY-MM-DD；空串 = 清除，undefined = 保持原值） */
  openedAt?: string;
  status?: ShopAccountStatus;
  tags?: string;
  note?: string;
}

/**
 * 批量修改的单字段指令（与渲染层 src/types.ts 的 ShopAccountBatchFieldPatch 保持一致）。
 * - status / phone / alipay / ziniaoAccount / erpAccount：仅覆盖（后四者为单值账号标识，追加无意义）
 * - company / tags / note：set=覆盖、append=追加；platforms：set/append/remove
 * - 未出现在 patch 中的字段一律不动；主标识 email 与敏感密码字段不支持批量修改
 */
export interface ShopAccountBatchFieldPatch {
  status?: ShopAccountStatus;
  company?: { mode: 'set' | 'append'; value: string };
  phone?: string;
  alipay?: string;
  ziniaoAccount?: string;
  erpAccount?: string;
  tags?: { mode: 'set' | 'append'; value: string };
  note?: { mode: 'set' | 'append'; value: string };
  platforms?: { mode: 'set' | 'append' | 'remove'; values: string[] };
}

/** 列表项（数量多、用于表格/卡片渲染）——不含明文密码 */
export interface ShopAccountItem {
  id: number;
  email: string;
  phone: string;
  company: string;
  alipay: string;
  ziniaoAccount: string;
  erpAccount: string;
  platforms: string[];
  /** 开店时间（YYYY-MM-DD，空串表示未填写） */
  openedAt: string;
  status: ShopAccountStatus;
  tags: string;
  note: string;
  /** 密文中实际存在的敏感字段名（用于「已配置」徽标） */
  secretKeys: ShopAccountSecretKey[];
  createdAt: string;
  updatedAt: string;
}

/** 详情（仅编辑时按需拉取）——secrets 为解密后的明文 */
export interface ShopAccountDetail extends ShopAccountItem {
  secrets: Partial<Record<ShopAccountSecretKey, string>>;
}

/** 列表筛选条件 */
export interface ShopAccountListFilter {
  search?: string;
  status?: string;
  platform?: string;
}

/** 平台维度计数 */
export interface ShopAccountPlatformCount {
  platform: string;
  count: number;
}

/** 汇总（总量 / 按状态计数 / 平台选项） */
export interface ShopAccountSummary {
  total: number;
  byStatus: Partial<Record<ShopAccountStatus, number>>;
  platforms: ShopAccountPlatformCount[];
}

interface ShopAccountRow {
  id: number;
  email: string;
  phone: string;
  company: string;
  alipay: string;
  ziniao_account: string;
  erp_account: string;
  platforms: string;
  opened_at: string;
  status: string;
  tags: string;
  note: string;
  secret_enc: Buffer | null;
  secret_keys: string;
  created_at: string;
  updated_at: string;
}

/** 建表 + 索引（幂等），并顺手执行一次性历史迁移 */
export function ensureShopAccountSchema(): void {
  dbMigrate([
    `CREATE TABLE IF NOT EXISTS sk_shop_sets (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      email TEXT NOT NULL DEFAULT '',
      phone TEXT NOT NULL DEFAULT '',
      company TEXT NOT NULL DEFAULT '',
      alipay TEXT NOT NULL DEFAULT '',
      ziniao_account TEXT NOT NULL DEFAULT '',
      erp_account TEXT NOT NULL DEFAULT '',
      platforms TEXT NOT NULL DEFAULT '[]',
      opened_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      tags TEXT NOT NULL DEFAULT '',
      note TEXT NOT NULL DEFAULT '',
      secret_enc BLOB,
      secret_keys TEXT NOT NULL DEFAULT '[]',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sk_shop_sets_email ON sk_shop_sets(email)`,
    `CREATE INDEX IF NOT EXISTS idx_sk_shop_sets_status ON sk_shop_sets(status)`,
  ]);
  // 建表语句是 IF NOT EXISTS，历史库不会自动补列 → 需单独探测后 ALTER
  ensureOpenedAtColumn();
  migrateLegacyAccounts();
}

/**
 * 增量迁移：为历史库补上「开店时间」列（opened_at）。
 * PRAGMA table_info 探测列是否存在，缺失时 ALTER ADD COLUMN 补上（默认空串）。
 */
function ensureOpenedAtColumn(): void {
  const columns = dbQuery<{ name: string }>(`PRAGMA table_info(sk_shop_sets)`);
  if (columns.some((column) => column.name === 'opened_at')) return;
  dbRun(`ALTER TABLE sk_shop_sets ADD COLUMN opened_at TEXT NOT NULL DEFAULT ''`);
}

/**
 * 一次性迁移：把上一版扁平「账号 + category」模型（sk_accounts）搬到「店铺套」模型。
 * 仅做可确定字段的搬运（邮箱/邮箱密码/手机号/支付宝/支付密码/平台/标签/备注），迁移后删除旧表。
 * 旧版 loginPwd（平台登录密码）对应新版「店铺密码（shopPwd）」，密文中存在时一并搬运。
 */
function migrateLegacyAccounts(): void {
  const legacy = dbGet<{ name: string }>(
    `SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'sk_accounts'`,
  );
  if (!legacy) return;
  try {
    const rows = dbQuery<Record<string, any>>(`SELECT * FROM sk_accounts`);
    for (const row of rows) {
      const legacySecrets = decodeSecretsRaw(row.secret_enc);
      const secrets: Partial<Record<ShopAccountSecretKey, string>> = {};
      if (legacySecrets.loginPwd) secrets.shopPwd = legacySecrets.loginPwd;
      if (legacySecrets.emailPwd) secrets.emailPwd = legacySecrets.emailPwd;
      if (legacySecrets.payPwd) secrets.alipayPwd = legacySecrets.payPwd;
      const email = String(row.email || '').trim();
      if (!email) continue;
      const platforms = String(row.platform || '').trim() ? [String(row.platform).trim()] : [];
      const now = new Date().toISOString();
      dbRun(
        `INSERT INTO sk_shop_sets
           (email, phone, company, alipay, ziniao_account, erp_account, platforms, status, tags, note,
            secret_enc, secret_keys, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        [
          email,
          String(row.phone || '').trim(),
          '',
          String(row.alipay || '').trim(),
          '',
          '',
          JSON.stringify(platforms),
          'active',
          String(row.tags || '').trim(),
          String(row.note || '').trim(),
          encodeSecrets(secrets),
          JSON.stringify(Object.keys(secrets)),
          String(row.created_at || now),
          String(row.updated_at || now),
        ],
      );
    }
  } catch {
    /* 迁移失败不应阻塞主流程；旧表保留待下次重试 */
    return;
  }
  dbRun(`DROP TABLE IF EXISTS sk_accounts`);
}

/** 列表查询（搜索/状态/平台在内存中过滤，数据量级为店群规模，实现简单且对 JSON 平台列更精确） */
export function listShopAccounts(filter: ShopAccountListFilter = {}): ShopAccountItem[] {
  ensureShopAccountSchema();
  const rows = dbQuery<ShopAccountRow>(
    `SELECT * FROM sk_shop_sets ORDER BY updated_at DESC, id DESC`,
  );
  const items = rows.map(toItem);

  const status = (filter.status || '').trim();
  const platform = (filter.platform || '').trim();
  const search = normalizeSearch(filter.search || '');

  return items.filter((item) => {
    if (status && item.status !== status) return false;
    if (platform && !item.platforms.includes(platform)) return false;
    if (!search) return true;
    const haystack = normalizeSearch(
      [
        item.email,
        item.phone,
        item.company,
        item.alipay,
        item.ziniaoAccount,
        item.erpAccount,
        item.tags,
        item.note,
        item.platforms.join(' '),
      ].join(' '),
    );
    return haystack.includes(search);
  });
}

/** 读取单个店铺套详情（含解密后的敏感字段） */
export function getShopAccount(id: number): ShopAccountDetail | undefined {
  ensureShopAccountSchema();
  if (!Number.isFinite(id) || id <= 0) return undefined;
  const row = dbGet<ShopAccountRow>(`SELECT * FROM sk_shop_sets WHERE id = ?`, [id]);
  if (!row) return undefined;
  return { ...toItem(row), secrets: decodeSecrets(row.secret_enc) };
}

/** 汇总（总量 / 按状态计数 / 平台去重计数并降序） */
export function shopAccountSummary(): ShopAccountSummary {
  ensureShopAccountSchema();
  const rows = dbQuery<{ status: string; platforms: string }>(
    `SELECT status, platforms FROM sk_shop_sets`,
  );
  const byStatus: Partial<Record<ShopAccountStatus, number>> = {};
  const platformCounter = new Map<string, number>();
  for (const row of rows) {
    const status = coerceStatus(row.status);
    byStatus[status] = (byStatus[status] || 0) + 1;
    for (const platform of parsePlatforms(row.platforms)) {
      platformCounter.set(platform, (platformCounter.get(platform) || 0) + 1);
    }
  }
  const platforms = [...platformCounter.entries()]
    .map(([platform, count]) => ({ platform, count }))
    .sort((a, b) => b.count - a.count || a.platform.localeCompare(b.platform));
  return { total: rows.length, byStatus, platforms };
}

/** 单字段按需解密（列表点击复制 / 临时查看），key 不在白名单返回空串 */
export function revealShopAccountSecret(
  id: number,
  key: ShopAccountSecretKey,
): string {
  ensureShopAccountSchema();
  if (!SHOP_ACCOUNT_SECRET_KEYS.includes(key)) return '';
  const row = dbGet<{ secret_enc: Buffer | null }>(
    `SELECT secret_enc FROM sk_shop_sets WHERE id = ?`,
    [id],
  );
  if (!row) return '';
  return decodeSecrets(row.secret_enc)[key] || '';
}

/**
 * 单独写入一个敏感字段（不动其它字段、不动其它列）。
 * 供「收件箱接入」等场景使用：只更新授权码，避免误改店铺套的业务字段。
 * @param id 店铺套 id
 * @param key 敏感字段键（必须在白名单内）
 * @param value 明文值；空串 = 清除该字段
 */
export function setShopAccountSecret(id: number, key: ShopAccountSecretKey, value: string): void {
  ensureShopAccountSchema();
  if (!SHOP_ACCOUNT_SECRET_KEYS.includes(key)) throw new Error('不支持的敏感字段');
  const row = dbGet<{ secret_enc: Buffer | null }>(
    `SELECT secret_enc FROM sk_shop_sets WHERE id = ?`,
    [Number(id) || 0],
  );
  if (!row) throw new Error('店铺套不存在或已被删除');
  const next = decodeSecrets(row.secret_enc);
  const trimmed = String(value || '');
  if (trimmed) next[key] = trimmed;
  else delete next[key];
  dbRun(`UPDATE sk_shop_sets SET secret_enc = ?, secret_keys = ?, updated_at = ? WHERE id = ?`, [
    encodeSecrets(next),
    JSON.stringify(Object.keys(next)),
    new Date().toISOString(),
    Number(id),
  ]);
}

/** 新增或更新店铺套，返回主键 id */
export function upsertShopAccount(input: ShopAccountUpsertInput): number {
  ensureShopAccountSchema();
  const now = new Date().toISOString();
  const id = Number(input.id) || 0;

  const email = String(input.email || '').trim();
  if (!email) throw new Error('请填写店铺邮箱（店铺套主标识）');
  if (!email.includes('@')) throw new Error('邮箱格式不正确');

  // 邮箱查重：同一邮箱视为同一套店铺（大小写不敏感）
  const duplicate = dbGet<{ id: number }>(
    `SELECT id FROM sk_shop_sets WHERE LOWER(email) = LOWER(?)`,
    [email],
  );
  if (duplicate && duplicate.id !== id) {
    throw new Error(`邮箱 ${email} 已存在（同一邮箱视为同一套店铺）`);
  }

  const existing = id > 0 ? dbGet<ShopAccountRow>(`SELECT * FROM sk_shop_sets WHERE id = ?`, [id]) : undefined;
  if (id > 0 && !existing) throw new Error('店铺套不存在或已被删除');

  const platforms =
    input.platforms === undefined
      ? parsePlatforms(existing?.platforms || '[]')
      : normalizePlatforms(input.platforms);
  const status =
    input.status === undefined
      ? coerceStatus(existing?.status || 'active')
      : coerceStatus(input.status);

  // 合并敏感字段：仅覆盖本次显式传入的键（未传 = 保持原值；传空串 = 清除该字段）
  const prevSecrets = decodeSecrets(existing?.secret_enc ?? null);
  const nextSecrets: Partial<Record<ShopAccountSecretKey, string>> = { ...prevSecrets };
  for (const key of SHOP_ACCOUNT_SECRET_KEYS) {
    const value = input[key];
    if (value === undefined) continue;
    const trimmed = String(value);
    if (trimmed) nextSecrets[key] = trimmed;
    else delete nextSecrets[key];
  }

  // 开店时间：undefined = 保持原值；空串 / 非法值 = 清除
  const openedAt =
    input.openedAt === undefined ? String(existing?.opened_at ?? '') : normalizeOpenedAt(input.openedAt);

  const values = [
    email,
    String(input.phone ?? existing?.phone ?? '').trim(),
    String(input.company ?? existing?.company ?? '').trim(),
    String(input.alipay ?? existing?.alipay ?? '').trim(),
    String(input.ziniaoAccount ?? existing?.ziniao_account ?? '').trim(),
    String(input.erpAccount ?? existing?.erp_account ?? '').trim(),
    openedAt,
    JSON.stringify(platforms),
    status,
    String(input.tags ?? existing?.tags ?? '').trim(),
    String(input.note ?? existing?.note ?? '').trim(),
    encodeSecrets(nextSecrets),
    JSON.stringify(Object.keys(nextSecrets)),
  ];

  if (id > 0) {
    dbRun(
      `UPDATE sk_shop_sets SET
         email = ?, phone = ?, company = ?, alipay = ?, ziniao_account = ?, erp_account = ?,
         opened_at = ?, platforms = ?, status = ?, tags = ?, note = ?, secret_enc = ?, secret_keys = ?,
         updated_at = ?
       WHERE id = ?`,
      [...values, now, id],
    );
    return id;
  }
  const result = dbRun(
    `INSERT INTO sk_shop_sets
       (email, phone, company, alipay, ziniao_account, erp_account, opened_at, platforms, status,
        tags, note, secret_enc, secret_keys, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [...values, now, now],
  );
  return result.lastInsertRowid;
}

/** 删除店铺套 */
export function deleteShopAccount(id: number): void {
  ensureShopAccountSchema();
  if (!Number.isFinite(id) || id <= 0) return;
  dbRun(`DELETE FROM sk_shop_sets WHERE id = ?`, [id]);
}

/**
 * 批量修改店铺套（仅限非敏感字段）
 * - 整个 patch 走一个事务：任一 SQL 抛错则全部回滚
 * - 任一 id 不存在 → 跳过（不影响其他记录）
 * - patch 中所有字段都未设置 → 该 id 跳过（updated 不计数）
 * - 返回实际被改动的店铺套条数
 *
 * 字符串字段追加语义：
 *   company → 空格拼接并去多余空白
 *   tags    → 空格拼接并去多余空白（tags 本身就是空格分隔字符串）
 *   note    → 换行拼接（多段备注可读性更好）
 *
 * 单值账号字段（phone / alipay / ziniaoAccount / erpAccount）：
 *   仅覆盖语义，值做 trim 后写入
 *
 * 平台字段：
 *   set    → 直接覆盖为 values（去重）
 *   append → 并入并去重
 *   remove → 从已有 platforms 中剔除 values 中的项
 */
export function batchUpdateShopAccounts(
  ids: number[],
  patch: ShopAccountBatchFieldPatch,
): number {
  ensureShopAccountSchema();
  const validIds = Array.isArray(ids)
    ? Array.from(
        new Set(
          ids.filter((v): v is number => Number.isInteger(v) && (v as number) > 0),
        ),
      )
    : [];
  if (validIds.length === 0) return 0;
  if (!isPlainObject(patch)) return 0;

  // 提前判空：patch 所有字段都没声明 → 一条都不动
  const hasAny =
    patch.status !== undefined ||
    patch.company !== undefined ||
    patch.tags !== undefined ||
    patch.note !== undefined ||
    patch.platforms !== undefined ||
    SINGLE_TEXT_BATCH_FIELDS.some((f) => patch[f.key] !== undefined);
  if (!hasAny) return 0;

  const now = new Date().toISOString();
  let updated = 0;

  dbTransaction(() => {
    for (const id of validIds) {
      const existing = dbGet<ShopAccountRow>(
        `SELECT * FROM sk_shop_sets WHERE id = ?`,
        [id],
      );
      if (!existing) continue;

      const sets: string[] = ['updated_at = ?'];
      const params: (string | number)[] = [now];

      // status：覆盖
      if (typeof patch.status === 'string') {
        sets.push('status = ?');
        params.push(coerceStatus(patch.status));
      }

      // 单值账号字段：覆盖（phone / alipay / ziniaoAccount / erpAccount）
      for (const field of SINGLE_TEXT_BATCH_FIELDS) {
        const value = patch[field.key];
        if (typeof value === 'string') {
          sets.push(`${field.column} = ?`);
          params.push(value.trim());
        }
      }

      // company：set / append（空格拼接）
      if (isPlainObject(patch.company)) {
        const mode = patch.company.mode === 'append' ? 'append' : 'set';
        const v = typeof patch.company.value === 'string'
          ? patch.company.value.replace(/\s+/g, ' ').trim()
          : '';
        if (mode === 'append') {
          const prev = typeof existing.company === 'string' ? existing.company : '';
          const next = prev ? `${prev} ${v}`.replace(/\s+/g, ' ').trim() : v;
          sets.push('company = ?');
          params.push(next);
        } else {
          sets.push('company = ?');
          params.push(v);
        }
      }

      // tags：set / append（空格分隔字符串）
      if (isPlainObject(patch.tags)) {
        const mode = patch.tags.mode === 'append' ? 'append' : 'set';
        const v = typeof patch.tags.value === 'string'
          ? patch.tags.value.replace(/\s+/g, ' ').trim()
          : '';
        if (mode === 'append') {
          const prev = typeof existing.tags === 'string' ? existing.tags : '';
          const next = prev ? `${prev} ${v}`.replace(/\s+/g, ' ').trim() : v;
          sets.push('tags = ?');
          params.push(next);
        } else {
          sets.push('tags = ?');
          params.push(v);
        }
      }

      // note：set / append（换行拼接）
      if (isPlainObject(patch.note)) {
        const mode = patch.note.mode === 'append' ? 'append' : 'set';
        const v = typeof patch.note.value === 'string' ? patch.note.value.trim() : '';
        if (mode === 'append') {
          const prev = typeof existing.note === 'string' ? existing.note : '';
          const next = prev ? `${prev}\n${v}` : v;
          sets.push('note = ?');
          params.push(next);
        } else {
          sets.push('note = ?');
          params.push(v);
        }
      }

      // platforms：set / append / remove（数组集合操作）
      if (isPlainObject(patch.platforms)) {
        const mode = patch.platforms.mode;
        const values = Array.isArray(patch.platforms.values)
          ? normalizePlatforms(patch.platforms.values)
          : [];
        const current = parsePlatforms(existing.platforms);
        let next: string[];
        if (mode === 'append') {
          next = Array.from(new Set([...current, ...values]));
        } else if (mode === 'remove') {
          next = current.filter((p) => !values.includes(p));
        } else {
          next = values;
        }
        sets.push('platforms = ?');
        params.push(JSON.stringify(next));
      }

      // 仅 updated_at 时不动业务字段（不计入 updated）
      if (sets.length === 1) continue;

      params.push(id);
      dbRun(`UPDATE sk_shop_sets SET ${sets.join(', ')} WHERE id = ?`, params);
      updated++;
    }
  });

  return updated;
}

/** 系统安全存储是否可用（不可用时前端需提示密码保护降级风险） */
export function isSecureStorageAvailable(): boolean {
  try {
    return !!safeStorage && typeof safeStorage.isEncryptionAvailable === 'function'
      ? safeStorage.isEncryptionAvailable()
      : false;
  } catch {
    return false;
  }
}

// ── 内部工具 ────────────────────────────────────────────────────────────────

function toItem(row: ShopAccountRow): ShopAccountItem {
  return {
    id: row.id,
    email: row.email,
    phone: row.phone,
    company: row.company,
    alipay: row.alipay,
    ziniaoAccount: row.ziniao_account,
    erpAccount: row.erp_account,
    openedAt: String(row.opened_at || ''),
    platforms: parsePlatforms(row.platforms),
    status: coerceStatus(row.status),
    tags: row.tags,
    note: row.note,
    secretKeys: parseSecretKeys(row.secret_keys),
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

function coerceStatus(value: unknown): ShopAccountStatus {
  const v = String(value || '').trim();
  return (SHOP_ACCOUNT_STATUSES as string[]).includes(v) ? (v as ShopAccountStatus) : 'active';
}

function normalizePlatforms(input: unknown): string[] {
  if (!Array.isArray(input)) return [];
  const cleaned = input
    .map((v) => String(v || '').trim())
    .filter((v) => !!v);
  return Array.from(new Set(cleaned)).slice(0, MAX_PLATFORM_COUNT);
}

function parsePlatforms(raw: string | null | undefined): string[] {
  if (!raw) return [];
  try {
    return normalizePlatforms(JSON.parse(raw));
  } catch {
    return [];
  }
}

function parseSecretKeys(raw: string | null | undefined): ShopAccountSecretKey[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter(
      (v): v is ShopAccountSecretKey => SHOP_ACCOUNT_SECRET_KEYS.includes(v as ShopAccountSecretKey),
    );
  } catch {
    return [];
  }
}

/**
 * 开店时间归一化：只接受 YYYY-MM-DD（或以其开头的 ISO 串），落库统一为 YYYY-MM-DD。
 * 非法值（含 2024-02-31 这类不存在日期）一律清空，避免列表算天数时出现 NaN。
 * @param value 待归一化的输入
 * @returns 'YYYY-MM-DD'，非法时返回空串
 */
function normalizeOpenedAt(value: unknown): string {
  const raw = String(value ?? '').trim();
  const matched = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(raw);
  if (!matched) return '';
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
  // 用 UTC 校验日期真实性，避免 2 月 31 日等被 Date 自动进位
  const date = new Date(Date.UTC(year, month - 1, day));
  if (
    date.getUTCFullYear() !== year ||
    date.getUTCMonth() !== month - 1 ||
    date.getUTCDate() !== day
  ) {
    return '';
  }
  return `${matched[1]}-${matched[2]}-${matched[3]}`;
}

/** 搜索归一化：忽略空白与常见分隔符（手机号 138-1234-5678 与 13812345678 等价），邮箱大小写不敏感 */
function normalizeSearch(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\-()（）+]/g, '');
}

/** 序列化并加密敏感字段；无内容返回 null */
function encodeSecrets(secrets: Partial<Record<ShopAccountSecretKey, string>>): Buffer | null {
  const keys = Object.keys(secrets) as ShopAccountSecretKey[];
  if (keys.length === 0) return null;
  const json = Buffer.from(JSON.stringify(secrets), 'utf8');
  if (isSecureStorageAvailable()) {
    try {
      return Buffer.concat([Buffer.from('E'), safeStorage.encryptString(json.toString('utf8'))]);
    } catch {
      /* 加密异常时降级为明文标记，保证数据不丢 */
    }
  }
  return Buffer.concat([Buffer.from('P'), json]);
}

/** 解密为原始键值对（不做键白名单过滤，供历史数据迁移使用）；BLOB 首字节为标记（'E' 密文 / 'P' 明文降级） */
function decodeSecretsRaw(enc: Buffer | null): Record<string, string> {
  if (!enc || enc.length === 0) return {};
  try {
    const flag = String.fromCharCode(enc[0]);
    const body = enc.subarray(1);
    const json = flag === 'E' ? safeStorage.decryptString(body) : body.toString('utf8');
    const parsed = JSON.parse(json);
    if (!parsed || typeof parsed !== 'object') return {};
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed as Record<string, unknown>)) {
      if (typeof value === 'string' && value) result[key] = value;
    }
    return result;
  } catch {
    return {};
  }
}

/** 解密敏感字段（仅保留白名单键） */
function decodeSecrets(enc: Buffer | null): Partial<Record<ShopAccountSecretKey, string>> {
  const raw = decodeSecretsRaw(enc);
  const result: Partial<Record<ShopAccountSecretKey, string>> = {};
  for (const key of SHOP_ACCOUNT_SECRET_KEYS) {
    if (raw[key]) result[key] = raw[key];
  }
  return result;
}
