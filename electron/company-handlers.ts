// electron/company-handlers.ts
// 「企业管理」渲染层 IPC（语义化通道，electron/main.ts require 后自动生效）。
//   company-db-ensure        幂等建表（企业管理 Tab 首次激活时调用）
//   company-list             企业列表（关键字 / 状态过滤，含已维护合规类型）
//   company-get              企业详情（含欧代 / 土代 / 德国包装法明细）
//   company-upsert           企业新增 / 更新
//   company-delete           删除企业（级联删除其合规资料）
//   company-profile-upsert   合规资料新增 / 更新（type 白名单校验）
//   company-profile-delete   删除合规资料
//   company-summary          汇总（总数 / 状态 / 各合规类型覆盖数 / 到期预警）
// 入参在 preload 层已做形状消毒，本层再做一次业务口径校验（双防线，见 AGENTS.md §2.3）。

export {};

import {
  ensureCompanySchema,
  listCompanies,
  getCompany,
  upsertCompany,
  deleteCompany,
  upsertCompanyProfile,
  deleteCompanyProfile,
  companySummary,
  COMPLIANCE_TYPES,
  COMPANY_STATUSES,
  COMPLIANCE_STATUSES,
  type ComplianceType,
  type CompanyStatus,
  type ComplianceStatus,
  type CompanyUpsertInput,
} from './company-db';
import { handle } from './ipc-util';

const MAX_LEN = {
  name: 200,
  unifiedCode: 60,
  country: 40,
  address: 300,
  person: 60,
  phone: 40,
  email: 200,
  taxNo: 60,
  note: 2000,
  date: 10,
  type: 20,
  status: 20,
} as const;

/** 截断字符串到指定长度（非字符串一律视为空串） */
function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** 解析正整数 id（非法返回 0） */
function toId(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

handle('company-db-ensure', (): null => {
  ensureCompanySchema();
  return null;
});

handle('company-list', (payload: any) => {
  ensureCompanySchema();
  const p = payload ?? {};
  return listCompanies({ search: str(p.search, 100), status: str(p.status, MAX_LEN.status) });
});

handle('company-get', (payload: any) => {
  const id = toId(payload?.id);
  if (!id) throw new Error('缺少企业 id');
  return getCompany(id);
});

handle('company-summary', () => {
  ensureCompanySchema();
  return companySummary();
});

handle('company-upsert', (payload: any) => {
  const p = payload ?? {};
  const input: CompanyUpsertInput = {
    id: toId(p.id),
    name: str(p.name, MAX_LEN.name),
    unifiedCode: str(p.unifiedCode, MAX_LEN.unifiedCode),
    country: str(p.country, MAX_LEN.country),
    address: str(p.address, MAX_LEN.address),
    legalPerson: str(p.legalPerson, MAX_LEN.person),
    contactName: str(p.contactName, MAX_LEN.person),
    contactPhone: str(p.contactPhone, MAX_LEN.phone),
    contactEmail: str(p.contactEmail, MAX_LEN.email),
    vatNo: str(p.vatNo, MAX_LEN.taxNo),
    eoriNo: str(p.eoriNo, MAX_LEN.taxNo),
    note: str(p.note, MAX_LEN.note),
  };
  // 状态：仅白名单值才覆盖，非法值由 db 层兜底为 active
  const status = str(p.status, MAX_LEN.status);
  if ((COMPANY_STATUSES as string[]).includes(status)) {
    input.status = status as CompanyStatus;
  }
  return { id: upsertCompany(input) };
});

handle('company-delete', (payload: any) => {
  const id = toId(payload?.id);
  if (!id) throw new Error('缺少企业 id');
  deleteCompany(id);
  return { deleted: true };
});

handle('company-profile-upsert', (payload: any) => {
  const p = payload ?? {};
  const type = str(p.type, MAX_LEN.type) as ComplianceType;
  if (!COMPLIANCE_TYPES.includes(type)) throw new Error('不支持的合规资料类型');

  const status = str(p.status, MAX_LEN.status) as ComplianceStatus;
  const extra =
    p.extra && typeof p.extra === 'object' && !Array.isArray(p.extra)
      ? (p.extra as Record<string, unknown>)
      : undefined;

  return {
    id: upsertCompanyProfile({
      id: toId(p.id),
      companyId: toId(p.companyId),
      type,
      name: str(p.name, MAX_LEN.name),
      regNo: str(p.regNo, MAX_LEN.taxNo),
      contactName: str(p.contactName, MAX_LEN.person),
      contactPhone: str(p.contactPhone, MAX_LEN.phone),
      contactEmail: str(p.contactEmail, MAX_LEN.email),
      address: str(p.address, MAX_LEN.address),
      // 日期/状态：未传（非字符串）或非法值 = 保持原值，避免部分提交误清已有数据
      ...(typeof p.effectiveAt === 'string' ? { effectiveAt: str(p.effectiveAt, MAX_LEN.date) } : {}),
      ...(typeof p.expireAt === 'string' ? { expireAt: str(p.expireAt, MAX_LEN.date) } : {}),
      ...(COMPLIANCE_STATUSES.includes(status) ? { status } : {}),
      note: str(p.note, MAX_LEN.note),
      ...(extra === undefined ? {} : { extra }),
    }),
  };
});

handle('company-profile-delete', (payload: any) => {
  const id = toId(payload?.id);
  if (!id) throw new Error('缺少合规资料 id');
  deleteCompanyProfile(id);
  return { deleted: true };
});
