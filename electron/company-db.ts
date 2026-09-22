// electron/company-db.ts
// 「企业管理」（UI 岛 shop-accounts 的第三个 Tab）主进程数据访问层，基于 electron/db.ts 公共层。
//
// 业务模型：一个企业（sk_companies）下挂若干**合规资料**（sk_company_profiles），
// 目前三类：欧代（欧盟授权代表）/ 土代（土耳其授权代表）/ 德国包装法（LUCID + 双元系统）。
//
// 设计取舍（为什么合规资料是一张通用表而不是三张专用表）：
//   - 三类资料的可检索骨架高度一致（主体名称 / 编号 / 联系人 / 有效期 / 状态）；
//   - 跨境合规条目会持续增加（英代、WEEE、电池法…），通用表 + `type` 只需在岛内加表单定义，
//     无需改表、无需新增 IPC 通道（沿用既有 op，type 由 payload 传入并做白名单校验）；
//   - 类型专属字段（如德国包装法的回收商合同号 / 申报年度 / 申报重量）放 `extra` JSON 列，
//     仅供编辑回填与展示，不参与检索——与「明文列 = 可检索元数据」的基线一致。
//
// 安全口径：本域**不含密码类凭据**（欧代/土代/包装法都是可公开核验的合规信息），
//   故不进 safeStorage 加密列；若日后需要存账号密码，应另起 secret 列并走 db 层加密 helper。

export {};

import { dbMigrate, dbGet, dbRun, dbQuery, dbTransaction } from './db';

/** 企业状态：启用 / 停用 */
export type CompanyStatus = 'active' | 'inactive';

/** 企业状态白名单（入参校验与兜底） */
export const COMPANY_STATUSES: CompanyStatus[] = ['active', 'inactive'];

/**
 * 合规资料类型
 * - eu_rep      欧代：欧盟授权代表（EC Rep / EU Responsible Person）
 * - tr_rep      土代：土耳其授权代表（Turkish Representative）
 * - de_packaging 德国包装法：LUCID 注册 + 双元系统（回收商）合同
 */
export type ComplianceType = 'eu_rep' | 'tr_rep' | 'de_packaging';

/** 合规资料类型白名单 */
export const COMPLIANCE_TYPES: ComplianceType[] = ['eu_rep', 'tr_rep', 'de_packaging'];

/** 合规资料状态：有效 / 办理中 / 已过期 */
export type ComplianceStatus = 'valid' | 'pending' | 'expired';

/** 合规资料状态白名单 */
export const COMPLIANCE_STATUSES: ComplianceStatus[] = ['valid', 'pending', 'expired'];

/** 到期预警天数阈值（summary.expiringSoon 的判定口径） */
export const EXPIRING_SOON_DAYS = 30;

/** 企业写入入参（字段缺省 = 保持原值；空串 = 清空；非空 = 覆盖） */
export interface CompanyUpsertInput {
  id?: number;
  /** 企业名称（业务主键，唯一） */
  name?: string;
  /** 统一社会信用代码 / 境外注册号 */
  unifiedCode?: string;
  /** 注册国家/地区 */
  country?: string;
  /** 注册地址 */
  address?: string;
  /** 法定代表人 */
  legalPerson?: string;
  /** 联系人 */
  contactName?: string;
  /** 联系电话 */
  contactPhone?: string;
  /** 联系邮箱 */
  contactEmail?: string;
  /** VAT 税号 */
  vatNo?: string;
  /** EORI 号 */
  eoriNo?: string;
  status?: CompanyStatus;
  note?: string;
}

/** 合规资料写入入参 */
export interface CompanyProfileUpsertInput {
  id?: number;
  /** 所属企业 id */
  companyId?: number;
  type?: ComplianceType;
  /** 主体名称（欧代公司 / 土代公司 / 双元系统回收商） */
  name?: string;
  /** 编号（协议号 / 注册号 / LUCID 号） */
  regNo?: string;
  contactName?: string;
  contactPhone?: string;
  contactEmail?: string;
  address?: string;
  /** 生效日期（YYYY-MM-DD） */
  effectiveAt?: string;
  /** 到期日期（YYYY-MM-DD；空 = 长期有效） */
  expireAt?: string;
  status?: ComplianceStatus;
  note?: string;
  /** 类型专属扩展字段（德国包装法的合同号 / 申报年度 / 申报重量等），整体 JSON 覆盖 */
  extra?: Record<string, unknown>;
}

/** 合规资料行 */
export interface CompanyProfileItem {
  id: number;
  companyId: number;
  type: ComplianceType;
  name: string;
  regNo: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  address: string;
  effectiveAt: string;
  expireAt: string;
  status: ComplianceStatus;
  note: string;
  extra: Record<string, unknown>;
  createdAt: string;
  updatedAt: string;
}

/** 企业列表行（含三类资料的「是否已维护」标记，供列表徽标展示） */
export interface CompanyItem {
  id: number;
  name: string;
  unifiedCode: string;
  country: string;
  address: string;
  legalPerson: string;
  contactName: string;
  contactPhone: string;
  contactEmail: string;
  vatNo: string;
  eoriNo: string;
  status: CompanyStatus;
  note: string;
  /** 已维护的合规资料类型（如 ['eu_rep','de_packaging']） */
  profileTypes: ComplianceType[];
  createdAt: string;
  updatedAt: string;
}

/** 企业详情（含合规资料明细） */
export interface CompanyDetail extends CompanyItem {
  profiles: CompanyProfileItem[];
}

/** 企业汇总（列表顶部 chips 用） */
export interface CompanySummary {
  total: number;
  byStatus: Partial<Record<CompanyStatus, number>>;
  /** 各合规类型已维护的企业数 */
  byType: Partial<Record<ComplianceType, number>>;
  /** 30 天内到期（含已过期）的合规资料条数 */
  expiringSoon: number;
}

interface CompanyRow {
  id: number;
  name: string;
  unified_code: string;
  country: string;
  address: string;
  legal_person: string;
  contact_name: string;
  contact_phone: string;
  contact_email: string;
  vat_no: string;
  eori_no: string;
  status: string;
  note: string;
  created_at: string;
  updated_at: string;
}

interface CompanyProfileRow {
  id: number;
  company_id: number;
  type: string;
  name: string;
  reg_no: string;
  contact_name: string;
  contact_phone: string;
  contact_email: string;
  address: string;
  effective_at: string;
  expire_at: string;
  status: string;
  note: string;
  extra: string;
  created_at: string;
  updated_at: string;
}

/** 建表 + 索引（幂等） */
export function ensureCompanySchema(): void {
  dbMigrate([
    `CREATE TABLE IF NOT EXISTS sk_companies (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL DEFAULT '',
      unified_code TEXT NOT NULL DEFAULT '',
      country TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      legal_person TEXT NOT NULL DEFAULT '',
      contact_name TEXT NOT NULL DEFAULT '',
      contact_phone TEXT NOT NULL DEFAULT '',
      contact_email TEXT NOT NULL DEFAULT '',
      vat_no TEXT NOT NULL DEFAULT '',
      eori_no TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'active',
      note TEXT NOT NULL DEFAULT '',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sk_companies_name ON sk_companies(name)`,
    `CREATE INDEX IF NOT EXISTS idx_sk_companies_status ON sk_companies(status)`,
    `CREATE TABLE IF NOT EXISTS sk_company_profiles (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      company_id INTEGER NOT NULL DEFAULT 0,
      type TEXT NOT NULL DEFAULT 'eu_rep',
      name TEXT NOT NULL DEFAULT '',
      reg_no TEXT NOT NULL DEFAULT '',
      contact_name TEXT NOT NULL DEFAULT '',
      contact_phone TEXT NOT NULL DEFAULT '',
      contact_email TEXT NOT NULL DEFAULT '',
      address TEXT NOT NULL DEFAULT '',
      effective_at TEXT NOT NULL DEFAULT '',
      expire_at TEXT NOT NULL DEFAULT '',
      status TEXT NOT NULL DEFAULT 'valid',
      note TEXT NOT NULL DEFAULT '',
      extra TEXT NOT NULL DEFAULT '{}',
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    )`,
    `CREATE INDEX IF NOT EXISTS idx_sk_company_profiles_company ON sk_company_profiles(company_id)`,
    `CREATE INDEX IF NOT EXISTS idx_sk_company_profiles_type ON sk_company_profiles(type)`,
  ]);
}

/** 状态白名单收敛（非法值兜底 active） */
function coerceStatus(value: unknown): CompanyStatus {
  const v = String(value ?? '').trim();
  return (COMPANY_STATUSES as string[]).includes(v) ? (v as CompanyStatus) : 'active';
}

/** 类型白名单收敛（非法值兜底 eu_rep；调用方已在 handler 层校验并报错） */
function coerceType(value: unknown): ComplianceType {
  const v = String(value ?? '').trim();
  return (COMPLIANCE_TYPES as string[]).includes(v) ? (v as ComplianceType) : 'eu_rep';
}

/** 合规资料状态收敛（非法值兜底 valid） */
function coerceProfileStatus(value: unknown): ComplianceStatus {
  const v = String(value ?? '').trim();
  return (COMPLIANCE_STATUSES as string[]).includes(v) ? (v as ComplianceStatus) : 'valid';
}

/** 日期归一化：仅接受 YYYY-MM-DD，其余视为空串（不写入脏数据） */
function normalizeDate(value: unknown): string {
  const v = String(value ?? '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(v) ? v : '';
}

/** JSON 安全解析（失败返回 null，由调用方决定兜底） */
function parseJson<T>(raw: string | null | undefined): T | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    return parsed as T;
  } catch {
    return null;
  }
}

/** 搜索归一化：去空白 + 小写（与 shop-accounts-db 同口径） */
function normalizeSearch(value: string): string {
  return String(value || '').trim().toLowerCase();
}

function toProfileItem(row: CompanyProfileRow): CompanyProfileItem {
  return {
    id: row.id,
    companyId: row.company_id,
    type: coerceType(row.type),
    name: row.name,
    regNo: row.reg_no,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    contactEmail: row.contact_email,
    address: row.address,
    effectiveAt: row.effective_at,
    expireAt: row.expire_at,
    status: coerceProfileStatus(row.status),
    note: row.note,
    extra: parseJson<Record<string, unknown>>(row.extra) || {},
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 企业列表（搜索在内存过滤；附每家企业已维护的合规类型） */
export function listCompanies(filter: { search?: string; status?: string } = {}): CompanyItem[] {
  ensureCompanySchema();
  const rows = dbQuery<CompanyRow>(`SELECT * FROM sk_companies ORDER BY updated_at DESC, id DESC`);
  const profileRows = dbQuery<{ company_id: number; type: string }>(
    `SELECT company_id, type FROM sk_company_profiles`,
  );
  const typesByCompany = new Map<number, ComplianceType[]>();
  for (const row of profileRows) {
    const list = typesByCompany.get(row.company_id) || [];
    const type = coerceType(row.type);
    if (!list.includes(type)) list.push(type);
    typesByCompany.set(row.company_id, list);
  }

  const status = String(filter.status || '').trim();
  const search = normalizeSearch(filter.search || '');

  return rows
    .map((row) => ({
      id: row.id,
      name: row.name,
      unifiedCode: row.unified_code,
      country: row.country,
      address: row.address,
      legalPerson: row.legal_person,
      contactName: row.contact_name,
      contactPhone: row.contact_phone,
      contactEmail: row.contact_email,
      vatNo: row.vat_no,
      eoriNo: row.eori_no,
      status: coerceStatus(row.status),
      note: row.note,
      profileTypes: typesByCompany.get(row.id) || [],
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    }))
    .filter((item) => {
      if (status && item.status !== status) return false;
      if (!search) return true;
      const haystack = normalizeSearch(
        [
          item.name,
          item.unifiedCode,
          item.country,
          item.address,
          item.legalPerson,
          item.contactName,
          item.contactPhone,
          item.contactEmail,
          item.vatNo,
          item.eoriNo,
          item.note,
        ].join(' '),
      );
      return haystack.includes(search);
    });
}

/** 企业详情（含合规资料明细，按类型/更新时间排序） */
export function getCompany(id: number): CompanyDetail | undefined {
  ensureCompanySchema();
  if (!Number.isFinite(id) || id <= 0) return undefined;
  const row = dbGet<CompanyRow>(`SELECT * FROM sk_companies WHERE id = ?`, [id]);
  if (!row) return undefined;
  const profiles = dbQuery<CompanyProfileRow>(
    `SELECT * FROM sk_company_profiles WHERE company_id = ? ORDER BY type ASC, updated_at DESC`,
    [id],
  ).map(toProfileItem);
  return {
    id: row.id,
    name: row.name,
    unifiedCode: row.unified_code,
    country: row.country,
    address: row.address,
    legalPerson: row.legal_person,
    contactName: row.contact_name,
    contactPhone: row.contact_phone,
    contactEmail: row.contact_email,
    vatNo: row.vat_no,
    eoriNo: row.eori_no,
    status: coerceStatus(row.status),
    note: row.note,
    profileTypes: Array.from(new Set(profiles.map((p) => p.type))),
    profiles,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
}

/** 新增/更新企业（企业名称唯一；undefined = 保持原值，空串 = 清空） */
export function upsertCompany(input: CompanyUpsertInput): number {
  ensureCompanySchema();
  const now = new Date().toISOString();
  const id = Number(input.id) || 0;

  const name = String(input.name || '').trim();
  if (!name) throw new Error('请填写企业名称');

  // 企业查重：同名视为同一家企业（大小写不敏感）
  const duplicate = dbGet<{ id: number }>(
    `SELECT id FROM sk_companies WHERE LOWER(name) = LOWER(?)`,
    [name],
  );
  if (duplicate && duplicate.id !== id) {
    throw new Error(`企业「${name}」已存在`);
  }

  const existing = dbGet<CompanyRow>(`SELECT * FROM sk_companies WHERE id = ?`, [id]);
  if (id > 0 && !existing) throw new Error('企业不存在或已被删除');

  const pick = (value: unknown, fallback: string): string =>
    value === undefined ? fallback : String(value ?? '').trim();

  const values = [
    name,
    pick(input.unifiedCode, existing?.unified_code ?? ''),
    pick(input.country, existing?.country ?? ''),
    pick(input.address, existing?.address ?? ''),
    pick(input.legalPerson, existing?.legal_person ?? ''),
    pick(input.contactName, existing?.contact_name ?? ''),
    pick(input.contactPhone, existing?.contact_phone ?? ''),
    pick(input.contactEmail, existing?.contact_email ?? ''),
    pick(input.vatNo, existing?.vat_no ?? ''),
    pick(input.eoriNo, existing?.eori_no ?? ''),
    input.status === undefined ? coerceStatus(existing?.status) : coerceStatus(input.status),
    pick(input.note, existing?.note ?? ''),
  ];

  if (id > 0) {
    dbRun(
      `UPDATE sk_companies SET
         name = ?, unified_code = ?, country = ?, address = ?, legal_person = ?,
         contact_name = ?, contact_phone = ?, contact_email = ?, vat_no = ?, eori_no = ?,
         status = ?, note = ?, updated_at = ?
       WHERE id = ?`,
      [...values, now, id],
    );
    return id;
  }

  const result = dbRun(
    `INSERT INTO sk_companies
       (name, unified_code, country, address, legal_person, contact_name, contact_phone,
        contact_email, vat_no, eori_no, status, note, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [...values, now, now],
  );
  return result.lastInsertRowid;
}

/** 删除企业（级联删除其合规资料，整批一个事务） */
export function deleteCompany(id: number): void {
  ensureCompanySchema();
  if (!Number.isFinite(id) || id <= 0) return;
  dbTransaction(() => {
    dbRun(`DELETE FROM sk_company_profiles WHERE company_id = ?`, [id]);
    dbRun(`DELETE FROM sk_companies WHERE id = ?`, [id]);
  });
}

/** 新增/更新合规资料（type 与 companyId 必填且需合法） */
export function upsertCompanyProfile(input: CompanyProfileUpsertInput): number {
  ensureCompanySchema();
  const now = new Date().toISOString();
  const id = Number(input.id) || 0;
  const rawCompanyId = Number(input.companyId) || 0;
  const rawType = String(input.type || '').trim();

  const existing = dbGet<CompanyProfileRow>(
    `SELECT * FROM sk_company_profiles WHERE id = ?`,
    [id],
  );
  if (id > 0 && !existing) throw new Error('合规资料不存在或已被删除');

  // 更新时 companyId / type 缺省 = 沿用原值（部分提交不应改变归属与类型）；新增时必须显式给出
  const companyId = rawCompanyId > 0 ? rawCompanyId : Number(existing?.company_id ?? 0);
  if (companyId <= 0) throw new Error('缺少所属企业');
  const owner = dbGet<{ id: number }>(`SELECT id FROM sk_companies WHERE id = ?`, [companyId]);
  if (!owner) throw new Error('所属企业不存在或已被删除');

  const type: ComplianceType =
    (COMPLIANCE_TYPES as string[]).includes(rawType)
      ? (rawType as ComplianceType)
      : coerceType(existing?.type);
  if (id === 0 && !(COMPLIANCE_TYPES as string[]).includes(rawType)) {
    throw new Error('不支持的合规资料类型');
  }

  const pick = (value: unknown, fallback: string): string =>
    value === undefined ? fallback : String(value ?? '').trim();

  // extra 为对象时整体覆盖；未传则保持原值（与文本字段同口径）
  const extraJson =
    input.extra && typeof input.extra === 'object' && !Array.isArray(input.extra)
      ? JSON.stringify(input.extra)
      : String(existing?.extra || '{}');

  const values = [
    companyId,
    type,
    pick(input.name, existing?.name ?? ''),
    pick(input.regNo, existing?.reg_no ?? ''),
    pick(input.contactName, existing?.contact_name ?? ''),
    pick(input.contactPhone, existing?.contact_phone ?? ''),
    pick(input.contactEmail, existing?.contact_email ?? ''),
    pick(input.address, existing?.address ?? ''),
    input.effectiveAt === undefined
      ? String(existing?.effective_at ?? '')
      : normalizeDate(input.effectiveAt),
    input.expireAt === undefined ? String(existing?.expire_at ?? '') : normalizeDate(input.expireAt),
    input.status === undefined
      ? coerceProfileStatus(existing?.status)
      : coerceProfileStatus(input.status),
    pick(input.note, existing?.note ?? ''),
    extraJson,
  ];

  if (id > 0) {
    dbRun(
      `UPDATE sk_company_profiles SET
         company_id = ?, type = ?, name = ?, reg_no = ?, contact_name = ?, contact_phone = ?,
         contact_email = ?, address = ?, effective_at = ?, expire_at = ?, status = ?, note = ?,
         extra = ?, updated_at = ?
       WHERE id = ?`,
      [...values, now, id],
    );
    return id;
  }

  const result = dbRun(
    `INSERT INTO sk_company_profiles
       (company_id, type, name, reg_no, contact_name, contact_phone, contact_email, address,
        effective_at, expire_at, status, note, extra, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [...values, now, now],
  );
  return result.lastInsertRowid;
}

/** 删除合规资料 */
export function deleteCompanyProfile(id: number): void {
  ensureCompanySchema();
  if (!Number.isFinite(id) || id <= 0) return;
  dbRun(`DELETE FROM sk_company_profiles WHERE id = ?`, [id]);
}

/**
 * 汇总：企业总数 / 按状态计数 / 各合规类型已维护企业数 / 30 天内到期（含已过期）的资料条数
 * 到期口径：`expire_at` 非空且 ≤ 今天 + 30 天（无到期日 = 长期有效，不计入）。
 */
export function companySummary(): CompanySummary {
  ensureCompanySchema();
  const rows = dbQuery<{ status: string }>(`SELECT status FROM sk_companies`);
  const byStatus: Partial<Record<CompanyStatus, number>> = {};
  for (const row of rows) {
    const status = coerceStatus(row.status);
    byStatus[status] = (byStatus[status] || 0) + 1;
  }

  const profileRows = dbQuery<{ company_id: number; type: string; expire_at: string }>(
    `SELECT company_id, type, expire_at FROM sk_company_profiles`,
  );
  const byType: Partial<Record<ComplianceType, number>> = {};
  const companiesByType = new Map<ComplianceType, Set<number>>();
  let expiringSoon = 0;

  const threshold = new Date();
  threshold.setDate(threshold.getDate() + EXPIRING_SOON_DAYS);
  const thresholdKey = threshold.toISOString().slice(0, 10);

  for (const row of profileRows) {
    const type = coerceType(row.type);
    const set = companiesByType.get(type) || new Set<number>();
    set.add(row.company_id);
    companiesByType.set(type, set);

    const expire = String(row.expire_at || '').trim();
    if (expire && expire <= thresholdKey) expiringSoon += 1;
  }
  for (const [type, set] of companiesByType.entries()) {
    byType[type] = set.size;
  }

  return { total: rows.length, byStatus, byType, expiringSoon };
}
