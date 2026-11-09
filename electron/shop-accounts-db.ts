// electron/shop-accounts-db.ts
// 「店铺账号」合并域的数据访问层：读写 `sk_shops` 的账号列 + `sk_tool_accounts`。
//
// 物理合并后**一行 = 店铺或账号（至少有一个）**：
//   店铺列（platform / name / 地址 / 站点）与账号列（email / 企业引用 / 工具引用 / 凭证）
//   在同一行。`shop-db.ts` 是 `sk_shops` 的表 owner（建表 / 迁移 / 店铺侧局部写入），
//   本文件负责账号侧：合并列表、合并 upsert（一次写完整行）、按需解密、批量、删除保护。
//
// 为什么合并 upsert 不放进 shop-db：它要写账号列 + 企业 / 工具引用 + 凭证，
// 且必须**一次写完整行**；店铺侧 `upsertShop` 只碰店铺列，两者按列分工、互不覆盖。
//
// 安全边界：明文密码只经 `getShopAccount` / `revealShopAccountSecret` /
//   `revealToolAccountPassword` 返回；列表永远只有 `secretKeys` 徽标。

export {};

import { dbGet, dbQuery, dbRun, dbTransaction, tableExists } from './db';
import {
  ensureShopSchema,
  normalizeFundAmount,
  normalizeShopScore,
  normalizeShopUrl,
  toOpenableUrl,
  SHOP_STATUSES,
  TOOL_ACCOUNT_KINDS,
  type ShopStatus,
  type ToolAccountKind,
} from './shop-db';
import {
  SHOP_SECRET_KEYS,
  decodeShopSecrets,
  decodeToolPassword,
  encodeSecrets,
  type ShopSecretKey,
} from './shop-secrets';
import { toNameKey } from './shopName';

/** 店铺状态（合并后只有启用 / 停用；停用 = 有历史数据时的唯一清理方式） */
export type ShopAccountStatus = ShopStatus;
export const SHOP_ACCOUNT_STATUSES: readonly ShopAccountStatus[] = SHOP_STATUSES;

/** 店铺行上的敏感字段键（紫鸟 / ERP 密码在工具账号表，不在这里） */
export type ShopAccountSecretKey = ShopSecretKey;
export const SHOP_ACCOUNT_SECRET_KEYS: readonly ShopAccountSecretKey[] = SHOP_SECRET_KEYS;

/** 工具账号类型（紫鸟 / ERP）—— 透传给 handler 层做入参收敛 */
export type { ToolAccountKind };

const MAX = {
  platform: 40,
  name: 200,
  email: 200,
  platformShopId: 100,
  shopUrl: 500,
  site: 40,
  status: 20,
  openedAt: 40,
  depositReceivedAt: 40,
  tags: 200,
  note: 2000,
  secret: 500,
  account: 200,
  search: 200,
} as const;

/** 合并写入入参（`undefined = 保持原值`，`'' = 清空`） */
export interface ShopAccountUpsertInput {
  /** 0 / 缺省 = 新增 */
  id?: number;
  // 店铺列
  name?: string;
  platform?: string;
  platformShopId?: string;
  shopUrl?: string;
  site?: string;
  // 账号列
  email?: string;
  companyId?: number;
  ziniaoAccountId?: number;
  erpAccountId?: number;
  status?: ShopAccountStatus;
  /** 记分分值（≥ 0；缺省 = 保持原值，0 = 清为未记录） */
  score?: number;
  openedAt?: string;
  /** 保证金到账时间（YYYY-MM-DD；退店时填写） */
  depositReceivedAt?: string;
  /** 资金三项（元；≥ 0；缺省 = 保持原值，0 = 清为未记录） */
  fundAvailable?: number;
  fundPendingSettlement?: number;
  fundFrozen?: number;
  tags?: string;
  note?: string;
  /** 非空值覆盖；空串 = 清除该字段；缺省 = 保持原值 */
  secrets?: Partial<Record<ShopAccountSecretKey, string>>;
  /** 明确清除的敏感字段（与 secrets 同时传时，clear 优先） */
  clearSecrets?: ShopAccountSecretKey[];
}

/** 合并列表行（企业 / 手机号 / 支付宝只读带出，真源在企业表） */
export interface ShopAccountItem {
  id: number;
  platform: string;
  /** 店名；'' = 纯账号行（还没建店铺） */
  name: string;
  nameKey: string;
  platformShopId: string;
  /** 店铺地址原文（展示 / 打开；匹配键留在库内） */
  shopUrl: string;
  site: string;
  /** 邮箱；'' = 纯店铺行（账号待补） */
  email: string;
  companyId: number;
  companyName: string;
  phone: string;
  alipay: string;
  ziniaoAccountId: number;
  erpAccountId: number;
  ziniaoAccount: string;
  erpAccount: string;
  status: ShopAccountStatus;
  /** 记分分值（平台记分 / 扣分；0 = 未记录） */
  score: number;
  openedAt: string;
  /** 保证金到账时间（YYYY-MM-DD；'' = 未填写） */
  depositReceivedAt: string;
  /** 资金三项（单位元；0 = 未记录） */
  fundAvailable: number;
  fundPendingSettlement: number;
  fundFrozen: number;
  tags: string;
  note: string;
  /** 已配置的敏感字段（仅徽标，不含明文） */
  secretKeys: ShopAccountSecretKey[];
  /** 是否挂着邮件账号（删除确认要写明级联删除范围） */
  hasMailAccount: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ShopAccountDetail extends ShopAccountItem {
  secrets: Partial<Record<ShopAccountSecretKey, string>>;
}

export interface ShopAccountListFilter {
  search?: string;
  status?: string;
  /** undefined = 不筛选；0 = 未关联企业；> 0 = 指定企业 */
  companyId?: number;
  /** undefined = 不筛选；0 = 未使用紫鸟；> 0 = 指定工具账号 */
  ziniaoAccountId?: number;
  erpAccountId?: number;
}

export interface ShopAccountSummary {
  total: number;
  byStatus: Partial<Record<ShopAccountStatus, number>>;
  /** 店名 + 邮箱都有 */
  complete: number;
  /** 只有店名（账号待补） */
  shopOnly: number;
  /** 只有邮箱（店铺待建） */
  accountOnly: number;
}

/** 批量修改（仅非敏感字段；企业 / 工具账号是引用关系，只有覆盖语义） */
export interface ShopAccountBatchFieldPatch {
  status?: ShopAccountStatus;
  companyId?: number;
  ziniaoAccountId?: number;
  erpAccountId?: number;
  tags?: { mode: 'set' | 'append'; value: string };
  note?: { mode: 'set' | 'append'; value: string };
}

export interface ToolAccountItem {
  id: number;
  kind: ToolAccountKind;
  account: string;
  note: string;
  /** 被多少家店铺引用（决定删除是否可用） */
  usageCount: number;
  hasPassword: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface ToolAccountUpsertInput {
  id?: number;
  /** 新增时必填；更新时不可改类型 */
  kind?: ToolAccountKind;
  account?: string;
  note?: string;
  /** undefined = 保持；'' = 清除；非空 = 覆盖 */
  password?: string;
}

interface ShopRow {
  id: number;
  platform: string;
  name: string;
  name_key: string;
  platform_shop_id: string;
  shop_url: string;
  shop_url_raw: string;
  site: string;
  email: string;
  company_id: number;
  ziniao_account_id: number;
  erp_account_id: number;
  status: string;
  score: number;
  opened_at: string;
  deposit_received_at: string;
  fund_available: number;
  fund_pending_settlement: number;
  fund_frozen: number;
  tags: string;
  note: string;
  secret_enc: Buffer | null;
  secret_keys: string;
  created_at: string;
  updated_at: string;
}

/** 建表 / 迁移统一交给表 owner；账号域不再自建任何表 */
export function ensureShopAccountSchema(): void {
  ensureShopSchema();
}

// ---- 读 ----

const LIST_COLS = `s.id, s.platform, s.name, s.name_key, s.platform_shop_id, s.shop_url,
  s.shop_url_raw, s.site, s.email, s.company_id, s.ziniao_account_id, s.erp_account_id,
  s.status, s.score, s.opened_at, s.deposit_received_at,
  s.fund_available, s.fund_pending_settlement, s.fund_frozen,
  s.tags, s.note, s.secret_keys, s.created_at, s.updated_at,
  c.name AS company_name, c.contact_phone AS company_phone, c.alipay_account AS company_alipay,
  z.account AS ziniao_account, e.account AS erp_account`;

/** 邮件账号是否挂在当前行（邮件表可能还没建 —— 各域按域懒建） */
function mailCountExpr(): string {
  return tableExists('sk_mail_accounts')
    ? `(SELECT COUNT(*) FROM sk_mail_accounts m WHERE m.shop_id = s.id) AS mail_count`
    : `0 AS mail_count`;
}

function selectRows(whereSql = '', params: (string | number)[] = []): Record<string, unknown>[] {
  return dbQuery<Record<string, unknown>>(
    `SELECT ${LIST_COLS}, ${mailCountExpr()}
       FROM sk_shops s
       LEFT JOIN sk_companies c ON c.id = s.company_id
       LEFT JOIN sk_tool_accounts z ON z.id = s.ziniao_account_id AND z.kind = 'ziniao'
       LEFT JOIN sk_tool_accounts e ON e.id = s.erp_account_id AND e.kind = 'erp'
       ${whereSql}
      ORDER BY CASE WHEN trim(s.name) = '' THEN 1 ELSE 0 END ASC,
               s.name_key ASC, lower(s.email) ASC, s.id ASC`,
    params,
  );
}

/**
 * 合并列表：纯店铺行、纯账号行都在内（这是「一个列表看全」的唯一入口）。
 * 数据量级为店群规模，一次全量返回，筛选在内存完成（不做分页 / 虚拟滚动）。
 */
export function listShopAccounts(filter: ShopAccountListFilter = {}): ShopAccountItem[] {
  ensureShopAccountSchema();
  const items = selectRows().map(toItem);

  const status = String(filter.status ?? '').trim();
  const search = normalizeSearch(filter.search ?? '');

  return items.filter((item) => {
    if (status && item.status !== status) return false;
    if (filter.companyId !== undefined && item.companyId !== filter.companyId) return false;
    if (filter.ziniaoAccountId !== undefined && item.ziniaoAccountId !== filter.ziniaoAccountId) {
      return false;
    }
    if (filter.erpAccountId !== undefined && item.erpAccountId !== filter.erpAccountId) return false;
    if (!search) return true;
    const haystack = normalizeSearch(
      [
        item.name,
        item.email,
        item.companyName,
        item.phone,
        item.alipay,
        item.ziniaoAccount,
        item.erpAccount,
        item.platformShopId,
        item.tags,
        item.note,
      ].join(' '),
    );
    return haystack.includes(search);
  });
}

/** 单行详情（含解密后的凭据，仅编辑 / 复制时使用） */
export function getShopAccount(id: number): ShopAccountDetail | undefined {
  ensureShopAccountSchema();
  const sid = toId(id);
  if (!sid) return undefined;
  const row = selectRows('WHERE s.id = ?', [sid])[0];
  if (!row) return undefined;
  return { ...toItem(row), secrets: decodeShopSecrets(toBeBuffer(row.secret_enc)) };
}

/** 汇总（总量 / 状态 / 两种空态） */
export function shopAccountSummary(): ShopAccountSummary {
  ensureShopAccountSchema();
  const rows = dbQuery<{ name: string; email: string; status: string }>(
    `SELECT name, email, status FROM sk_shops`,
  );
  const byStatus: Partial<Record<ShopAccountStatus, number>> = {};
  let complete = 0;
  let shopOnly = 0;
  let accountOnly = 0;
  for (const row of rows) {
    const status = normStatus(row.status);
    byStatus[status] = (byStatus[status] || 0) + 1;
    const hasName = !!String(row.name ?? '').trim();
    const hasEmail = !!String(row.email ?? '').trim();
    if (hasName && hasEmail) complete += 1;
    else if (hasName) shopOnly += 1;
    else if (hasEmail) accountOnly += 1;
  }
  return { total: rows.length, byStatus, complete, shopOnly, accountOnly };
}

/** 单字段按需解密（列表复制 / 临时查看）；不存在或未配置返回空串 */
export function revealShopAccountSecret(id: number, key: ShopAccountSecretKey): string {
  ensureShopAccountSchema();
  if (!SHOP_ACCOUNT_SECRET_KEYS.includes(key)) return '';
  const row = dbGet<{ secret_enc: Buffer | null }>(
    `SELECT secret_enc FROM sk_shops WHERE id = ?`,
    [toId(id)],
  );
  if (!row) return '';
  return decodeShopSecrets(row.secret_enc)[key] || '';
}

/**
 * 单独写入一个敏感字段（不动其它列）。
 * 供「收件箱接入」等场景使用：只更新授权码，避免误改店铺业务字段。
 * @param value 明文；空串 = 清除该字段
 */
export function setShopAccountSecret(id: number, key: ShopAccountSecretKey, value: string): void {
  ensureShopAccountSchema();
  if (!SHOP_ACCOUNT_SECRET_KEYS.includes(key)) throw new Error('不支持的敏感字段');
  const sid = toId(id);
  const row = dbGet<{ secret_enc: Buffer | null }>(
    `SELECT secret_enc FROM sk_shops WHERE id = ?`,
    [sid],
  );
  if (!row) throw new Error('店铺不存在或已被删除');
  const next = decodeShopSecrets(row.secret_enc);
  const text = String(value || '');
  if (text) next[key] = text.slice(0, MAX.secret);
  else delete next[key];
  dbRun(
    `UPDATE sk_shops SET secret_enc = ?, secret_keys = ?, updated_at = datetime('now','localtime')
      WHERE id = ?`,
    [encodeSecrets(next), JSON.stringify(Object.keys(next)), sid],
  );
}

// ---- 写 ----

/**
 * 合并写入：一次写完整行（店铺列 + 账号列 + 企业 / 工具引用 + 凭证）。
 *
 * 校验顺序见计划 §4.1：至少店名 / 邮箱之一 → 邮箱格式与唯一性 → 店名唯一性 →
 * 平台店铺 ID 唯一性 → 企业 / 工具账号存在且类型匹配。冲突一律明确报错，不静默改名。
 *
 * @returns `{ id, created }`；created=false 表示更新既有行
 */
export function upsertShopAccount(input: ShopAccountUpsertInput): {
  id: number;
  created: boolean;
} {
  ensureShopAccountSchema();
  const id = toId(input?.id);
  const existing = id ? dbGet<ShopRow>(`SELECT * FROM sk_shops WHERE id = ?`, [id]) : undefined;
  if (id && !existing) throw new Error('店铺不存在或已被删除');

  const platform =
    (optStr(input?.platform, MAX.platform) ?? String(existing?.platform ?? '')).trim() || 'ae';
  const name = (optStr(input?.name, MAX.name) ?? String(existing?.name ?? '')).trim();
  const email = (optStr(input?.email, MAX.email) ?? String(existing?.email ?? '')).trim();
  if (!name && !email) {
    throw new Error('店铺名和邮箱不能同时为空；不再使用请删除这一行');
  }
  if (email && !email.includes('@')) throw new Error('邮箱格式不正确');
  const nameKey = name ? toNameKey(name) : '';
  if (name && !nameKey) throw new Error('店铺名称不能只有空白字符');

  const platformShopId = (
    optStr(input?.platformShopId, MAX.platformShopId) ??
    String(existing?.platform_shop_id ?? '')
  ).trim();
  const platformShopIdKey = toNameKey(platformShopId);

  // —— 唯一性：先给可读错误，索引兜底并发 / 绕过入口 ——
  if (email) {
    const dup = dbGet<{ id: number; name: string }>(
      `SELECT id, name FROM sk_shops
        WHERE lower(email) = lower(?) AND trim(email) <> '' AND id <> ?`,
      [email, id],
    );
    if (dup) {
      throw new Error(
        `这个邮箱已被另一个店铺账号使用（${dup.name || '未建店铺'}，ID ${num(dup.id)}）—— 请换一个邮箱`,
      );
    }
  }
  if (nameKey) {
    const dup = dbGet<{ id: number; name: string }>(
      `SELECT id, name FROM sk_shops
        WHERE platform = ? AND name_key = ? AND trim(name_key) <> '' AND id <> ?`,
      [platform, nameKey, id],
    );
    if (dup) {
      throw new Error(
        `同一平台下已有同名店铺：${dup.name}（ID ${num(dup.id)}）—— 同名不同店请改用不同名称`,
      );
    }
  }
  if (platformShopIdKey) {
    const dup = dbGet<{ id: number; name: string }>(
      `SELECT id, name FROM sk_shops
        WHERE platform = ? AND platform_shop_id = ? AND id <> ?`,
      [platform, platformShopIdKey, id],
    );
    if (dup) {
      throw new Error(
        `该平台下的店铺标识已被占用：${dup.name || '未建店铺'}（ID ${num(dup.id)}）—— 一个平台店铺ID 只能对应一家店`,
      );
    }
  }

  const shopUrlRaw =
    typeof input?.shopUrl === 'string'
      ? toOpenableUrl(input.shopUrl).slice(0, MAX.shopUrl)
      : String(existing?.shop_url_raw ?? '');
  const shopUrlKey = normalizeShopUrl(shopUrlRaw).slice(0, MAX.shopUrl);

  const site = optStr(input?.site, MAX.site) ?? String(existing?.site ?? '');
  const status =
    input?.status === undefined ? normStatus(existing?.status) : normStatus(input.status);
  const score =
    input?.score === undefined ? num(existing?.score) : normalizeShopScore(input.score);
  const openedAt =
    input?.openedAt === undefined
      ? String(existing?.opened_at ?? '')
      : normalizeOpenedAt(input.openedAt);
  const depositReceivedAt =
    input?.depositReceivedAt === undefined
      ? String(existing?.deposit_received_at ?? '')
      : normalizeOpenedAt(input.depositReceivedAt);
  // 资金三项：缺省 = 保持原值；传了就走唯一的归一（负数 / 非数 / 过大一律抛可读错误）。
  // 注意不能复用 num() 直接落库 —— 那样负数、脏值会被静默写成钱，用户看不出来。
  const fundAvailable =
    input?.fundAvailable === undefined
      ? num(existing?.fund_available)
      : normalizeFundAmount(input.fundAvailable);
  const fundPendingSettlement =
    input?.fundPendingSettlement === undefined
      ? num(existing?.fund_pending_settlement)
      : normalizeFundAmount(input.fundPendingSettlement);
  const fundFrozen =
    input?.fundFrozen === undefined
      ? num(existing?.fund_frozen)
      : normalizeFundAmount(input.fundFrozen);

  const tags = (optStr(input?.tags, MAX.tags) ?? String(existing?.tags ?? '')).trim();
  const note = optStr(input?.note, MAX.note) ?? String(existing?.note ?? '');

  const companyId =
    input?.companyId === undefined ? nonNeg(existing?.company_id) : nonNeg(input.companyId);
  if (companyId > 0) {
    const company = dbGet<{ id: number }>(`SELECT id FROM sk_companies WHERE id = ?`, [companyId]);
    if (!company) throw new Error('所选企业不存在或已被删除');
  }

  const ziniaoAccountId =
    input?.ziniaoAccountId === undefined
      ? nonNeg(existing?.ziniao_account_id)
      : nonNeg(input.ziniaoAccountId);
  const erpAccountId =
    input?.erpAccountId === undefined
      ? nonNeg(existing?.erp_account_id)
      : nonNeg(input.erpAccountId);
  assertToolAccount(ziniaoAccountId, 'ziniao');
  assertToolAccount(erpAccountId, 'erp');

  // 凭证：只有显式传入的键才动；其余保留（含未被识别键的清理 —— decodeShopSecrets 已过滤白名单）
  const nextSecrets = decodeShopSecrets(existing?.secret_enc ?? null);
  if (input?.secrets && typeof input.secrets === 'object') {
    for (const key of SHOP_ACCOUNT_SECRET_KEYS) {
      const value = input.secrets[key];
      if (value === undefined) continue;
      const text = String(value).slice(0, MAX.secret);
      if (text) nextSecrets[key] = text;
      else delete nextSecrets[key];
    }
  }
  if (Array.isArray(input?.clearSecrets)) {
    for (const key of input.clearSecrets) {
      if (SHOP_ACCOUNT_SECRET_KEYS.includes(key)) delete nextSecrets[key];
    }
  }
  const secretEnc = encodeSecrets(nextSecrets);
  const secretKeys = JSON.stringify(Object.keys(nextSecrets));

  if (id) {
    dbRun(
      `UPDATE sk_shops SET
         platform = ?, name = ?, name_key = ?, platform_shop_id = ?, shop_url = ?, shop_url_raw = ?,
         site = ?, email = ?, company_id = ?, ziniao_account_id = ?, erp_account_id = ?,
         status = ?, score = ?, opened_at = ?, deposit_received_at = ?,
         fund_available = ?, fund_pending_settlement = ?, fund_frozen = ?,
         tags = ?, note = ?, secret_enc = ?, secret_keys = ?,
         updated_at = datetime('now','localtime')
       WHERE id = ?`,
      [
        platform,
        name,
        nameKey,
        platformShopIdKey,
        shopUrlKey,
        shopUrlRaw,
        site,
        email,
        companyId,
        ziniaoAccountId,
        erpAccountId,
        status,
        score,
        openedAt,
        depositReceivedAt,
        fundAvailable,
        fundPendingSettlement,
        fundFrozen,
        tags,
        note,
        secretEnc,
        secretKeys,
        id,
      ],
    );
    return { id, created: false };
  }

  const info = dbRun(
    `INSERT INTO sk_shops
       (platform, name, name_key, platform_shop_id, shop_url, shop_url_raw, site, email,
        company_id, ziniao_account_id, erp_account_id, status, score, opened_at,
        deposit_received_at, fund_available, fund_pending_settlement, fund_frozen, tags, note,
        secret_enc, secret_keys, created_at, updated_at)
     VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`,
    [
      platform,
      name,
      nameKey,
      platformShopIdKey,
      shopUrlKey,
      shopUrlRaw,
      site,
      email,
      companyId,
      ziniaoAccountId,
      erpAccountId,
      status,
      score,
      openedAt,
      depositReceivedAt,
      fundAvailable,
      fundPendingSettlement,
      fundFrozen,
      tags,
      note,
      secretEnc,
      secretKeys,
    ],
  );
  return { id: info.lastInsertRowid, created: true };
}

/**
 * 删除一行。有下游引用时**拒绝**（只允许「停用」）：
 * 采集商品 / 商品清单 / 名称映射都按 shop_id 指向这家店，删除会让历史账失去归属。
 * 邮件账号随外键级联删除（删除确认由界面按 `hasMailAccount` 写明）。
 */
export function deleteShopAccount(id: number): { deleted: boolean } {
  ensureShopAccountSchema();
  const sid = toId(id);
  if (!sid) return { deleted: false };
  const row = dbGet<{ id: number }>(`SELECT id FROM sk_shops WHERE id = ?`, [sid]);
  if (!row) throw new Error('店铺不存在或已被删除');

  const refs: string[] = [];
  const skuCount = countRef('pl_shop_sku', 'shop_id', sid);
  if (skuCount) refs.push(`${skuCount} 条平台商品`);
  const itemCount = countRef('pl_shop_items', 'shop_id', sid);
  if (itemCount) refs.push(`${itemCount} 条商品清单`);
  const mappingCount = num(
    dbGet<{ c: number }>(
      `SELECT COUNT(*) AS c FROM sk_name_map WHERE kind = 'shop' AND ref_id = ?`,
      [sid],
    )?.c,
  );
  if (mappingCount) refs.push(`${mappingCount} 条名称映射`);

  if (refs.length) {
    throw new Error(
      `这个店铺还有 ${refs.join('、')}，不能删除。如果不再使用，请把状态改为「停用」。`,
    );
  }
  dbRun(`DELETE FROM sk_shops WHERE id = ?`, [sid]);
  return { deleted: true };
}

/**
 * 批量修改（仅非敏感字段）。
 * - 整个 patch 一个事务：任一 SQL 抛错则全部回滚
 * - id 不存在 → 跳过；patch 没有有效字段 → 不计数
 * - 企业 / 工具账号：只覆盖（0 = 取消关联），引用不存在时抛错（用户是从下拉里点名的）
 */
export function batchUpdateShopAccounts(
  ids: number[],
  patch: ShopAccountBatchFieldPatch,
): number {
  ensureShopAccountSchema();
  const validIds = Array.isArray(ids)
    ? Array.from(new Set(ids.filter((v): v is number => Number.isInteger(v) && v > 0)))
    : [];
  if (validIds.length === 0) return 0;
  if (!patch || typeof patch !== 'object') return 0;

  const hasAny =
    patch.status !== undefined ||
    patch.companyId !== undefined ||
    patch.ziniaoAccountId !== undefined ||
    patch.erpAccountId !== undefined ||
    patch.tags !== undefined ||
    patch.note !== undefined;
  if (!hasAny) return 0;

  const status = patch.status === undefined ? undefined : normStatus(patch.status);
  const companyId = patch.companyId === undefined ? undefined : nonNeg(patch.companyId);
  if (companyId !== undefined && companyId > 0) {
    const company = dbGet<{ id: number }>(`SELECT id FROM sk_companies WHERE id = ?`, [companyId]);
    if (!company) throw new Error('所选企业不存在或已被删除');
  }
  const ziniaoAccountId =
    patch.ziniaoAccountId === undefined ? undefined : nonNeg(patch.ziniaoAccountId);
  const erpAccountId = patch.erpAccountId === undefined ? undefined : nonNeg(patch.erpAccountId);
  if (ziniaoAccountId !== undefined) assertToolAccount(ziniaoAccountId, 'ziniao');
  if (erpAccountId !== undefined) assertToolAccount(erpAccountId, 'erp');

  let updated = 0;
  dbTransaction(() => {
    for (const id of validIds) {
      const existing = dbGet<ShopRow>(`SELECT * FROM sk_shops WHERE id = ?`, [id]);
      if (!existing) continue;

      const sets: string[] = [];
      const params: (string | number)[] = [];

      if (status !== undefined) {
        sets.push('status = ?');
        params.push(status);
      }
      if (companyId !== undefined) {
        sets.push('company_id = ?');
        params.push(companyId);
      }
      if (ziniaoAccountId !== undefined) {
        sets.push('ziniao_account_id = ?');
        params.push(ziniaoAccountId);
      }
      if (erpAccountId !== undefined) {
        sets.push('erp_account_id = ?');
        params.push(erpAccountId);
      }
      if (patch.tags && typeof patch.tags === 'object') {
        const mode = patch.tags.mode === 'append' ? 'append' : 'set';
        const value =
          typeof patch.tags.value === 'string' ? patch.tags.value.replace(/\s+/g, ' ').trim() : '';
        const prev = String(existing.tags ?? '');
        sets.push('tags = ?');
        params.push(mode === 'append' && prev ? `${prev} ${value}`.replace(/\s+/g, ' ').trim() : value);
      }
      if (patch.note && typeof patch.note === 'object') {
        const mode = patch.note.mode === 'append' ? 'append' : 'set';
        const value = typeof patch.note.value === 'string' ? patch.note.value.trim() : '';
        const prev = String(existing.note ?? '');
        sets.push('note = ?');
        params.push(mode === 'append' && prev ? `${prev}\n${value}` : value);
      }

      if (sets.length === 0) continue;
      params.push(id);
      dbRun(
        `UPDATE sk_shops SET ${sets.join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`,
        params,
      );
      updated += 1;
    }
  });
  return updated;
}

// ---- 工具账号（紫鸟 / ERP 共用一个形状） ----

/** 工具账号列表（含被多少店铺引用；kind 缺省 / 非法 = 全部） */
export function listToolAccounts(kind?: string): ToolAccountItem[] {
  ensureShopAccountSchema();
  const k = normToolKind(kind);
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT t.id, t.kind, t.account, t.note, t.created_at, t.updated_at,
            CASE WHEN t.password_enc IS NULL THEN 0 ELSE 1 END AS has_password,
            CASE t.kind
              WHEN 'ziniao' THEN (SELECT COUNT(*) FROM sk_shops s WHERE s.ziniao_account_id = t.id)
              ELSE (SELECT COUNT(*) FROM sk_shops s WHERE s.erp_account_id = t.id)
            END AS usage_count
       FROM sk_tool_accounts t
       ${k ? 'WHERE t.kind = ?' : ''}
      ORDER BY t.kind ASC, t.account_key ASC`,
    k ? [k] : [],
  );
  return rows.map((r) => ({
    id: num(r.id),
    kind: normToolKind(r.kind) || 'ziniao',
    account: String(r.account ?? ''),
    note: String(r.note ?? ''),
    usageCount: num(r.usage_count),
    hasPassword: num(r.has_password) === 1,
    createdAt: String(r.created_at ?? ''),
    updatedAt: String(r.updated_at ?? ''),
  }));
}

/**
 * 新增 / 更新工具账号。
 * - 一条登录一份密码；同类型下登录名（忽略大小写）唯一
 * - 更新时不能改类型（类型变了等于换了一种工具，语义不清）
 */
export function upsertToolAccount(input: ToolAccountUpsertInput): number {
  ensureShopAccountSchema();
  const id = toId(input?.id);
  const existing = id
    ? dbGet<{ id: number; kind: string; account: string; note: string; password_enc: Buffer | null }>(
        `SELECT id, kind, account, note, password_enc FROM sk_tool_accounts WHERE id = ?`,
        [id],
      )
    : undefined;
  if (id && !existing) throw new Error('账号不存在或已被删除');

  const requestedKind = normToolKind(input?.kind);
  if (existing) {
    if (requestedKind && requestedKind !== existing.kind) throw new Error('不能修改账号类型');
  } else if (!requestedKind) {
    throw new Error('请选择账号类型');
  }
  const kind = existing ? (existing.kind as ToolAccountKind) : requestedKind;

  const account = (
    optStr(input?.account, MAX.account) ?? String(existing?.account ?? '')
  ).trim();
  if (!account) throw new Error('请填写登录名');
  const accountKey = toNameKey(account).toLowerCase();

  const dup = dbGet<{ id: number; account: string }>(
    `SELECT id, account FROM sk_tool_accounts
      WHERE kind = ? AND account_key = ? AND id <> ?`,
    [kind, accountKey, id],
  );
  if (dup) {
    throw new Error(
      `同类型下已有这个登录名：${dup.account}（ID ${num(dup.id)}）—— 请直接使用已有账号`,
    );
  }

  const note = optStr(input?.note, MAX.note) ?? String(existing?.note ?? '');
  const passwordEnc =
    typeof input?.password === 'string'
      ? input.password
        ? encodeSecrets({ pwd: input.password.slice(0, MAX.secret) })
        : null
      : (existing?.password_enc ?? null);

  if (id) {
    dbRun(
      `UPDATE sk_tool_accounts SET account = ?, account_key = ?, password_enc = ?, note = ?,
         updated_at = datetime('now','localtime') WHERE id = ?`,
      [account, accountKey, passwordEnc, note, id],
    );
    return id;
  }
  const info = dbRun(
    `INSERT INTO sk_tool_accounts
       (kind, account, account_key, password_enc, note, created_at, updated_at)
     VALUES (?,?,?,?,?,datetime('now','localtime'),datetime('now','localtime'))`,
    [kind, account, accountKey, passwordEnc, note],
  );
  return info.lastInsertRowid;
}

/** 删除工具账号：仍被店铺引用时拒绝（并告诉用户被多少家店用着） */
export function deleteToolAccount(id: number): void {
  ensureShopAccountSchema();
  const sid = toId(id);
  if (!sid) return;
  const row = dbGet<{ kind: string }>(`SELECT kind FROM sk_tool_accounts WHERE id = ?`, [sid]);
  if (!row) throw new Error('账号不存在或已被删除');
  const label = row.kind === 'ziniao' ? '紫鸟' : 'ERP';
  const column = row.kind === 'ziniao' ? 'ziniao_account_id' : 'erp_account_id';
  const used = num(
    dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM sk_shops WHERE ${column} = ?`, [sid])?.c,
  );
  if (used) {
    throw new Error(
      `这个${label}账号被 ${used} 个店铺使用，不能删除；请先在店铺里改挂其他账号。`,
    );
  }
  dbRun(`DELETE FROM sk_tool_accounts WHERE id = ?`, [sid]);
}

/** 按需解密工具账号密码（不存在的账号返回空串） */
export function revealToolAccountPassword(id: number): string {
  ensureShopAccountSchema();
  const sid = toId(id);
  if (!sid) return '';
  const row = dbGet<{ password_enc: Buffer | null }>(
    `SELECT password_enc FROM sk_tool_accounts WHERE id = ?`,
    [sid],
  );
  return row ? decodeToolPassword(row.password_enc) : '';
}

// ---- 内部工具 ----

function toItem(row: Record<string, unknown>): ShopAccountItem {
  const urlKey = String(row.shop_url ?? '');
  const urlRaw = String(row.shop_url_raw ?? '');
  return {
    id: num(row.id),
    platform: String(row.platform ?? ''),
    name: String(row.name ?? ''),
    nameKey: String(row.name_key ?? ''),
    platformShopId: String(row.platform_shop_id ?? ''),
    shopUrl: urlRaw || (urlKey ? `https://${urlKey}` : ''),
    site: String(row.site ?? ''),
    email: String(row.email ?? ''),
    companyId: nonNeg(row.company_id),
    companyName: String(row.company_name ?? ''),
    phone: String(row.company_phone ?? ''),
    alipay: String(row.company_alipay ?? ''),
    ziniaoAccountId: nonNeg(row.ziniao_account_id),
    erpAccountId: nonNeg(row.erp_account_id),
    ziniaoAccount: String(row.ziniao_account ?? ''),
    erpAccount: String(row.erp_account ?? ''),
    status: normStatus(row.status),
    score: num(row.score),
    openedAt: String(row.opened_at ?? ''),
    depositReceivedAt: String(row.deposit_received_at ?? ''),
    fundAvailable: num(row.fund_available),
    fundPendingSettlement: num(row.fund_pending_settlement),
    fundFrozen: num(row.fund_frozen),
    tags: String(row.tags ?? ''),
    note: String(row.note ?? ''),
    secretKeys: parseSecretKeys(String(row.secret_keys ?? '')),
    hasMailAccount: num(row.mail_count) > 0,
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

function countRef(table: string, column: string, id: number): number {
  if (!tableExists(table)) return 0;
  return num(dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM ${table} WHERE ${column} = ?`, [id])?.c);
}

function assertToolAccount(id: number, kind: ToolAccountKind): void {
  if (!id) return;
  const label = kind === 'ziniao' ? '紫鸟' : 'ERP';
  const row = dbGet<{ kind: string }>(`SELECT kind FROM sk_tool_accounts WHERE id = ?`, [id]);
  if (!row) throw new Error(`所选${label}账号不存在或已被删除`);
  if (row.kind !== kind) throw new Error(`所选账号不是${label}账号`);
}

function normStatus(value: unknown): ShopAccountStatus {
  const s = str(value, MAX.status);
  return (SHOP_STATUSES as readonly string[]).includes(s) ? (s as ShopAccountStatus) : 'active';
}

function normToolKind(value: unknown): ToolAccountKind | '' {
  const s = str(value, 20);
  return (TOOL_ACCOUNT_KINDS as readonly string[]).includes(s) ? (s as ToolAccountKind) : '';
}

/** 字符串 → 去首尾空白并截断（非字符串视为空串） */
function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max).trim() : '';
}

/** 可选字符串：非字符串 = undefined（保持原值，而不是误清空） */
function optStr(value: unknown, max: number): string | undefined {
  return typeof value === 'string' ? value.slice(0, max) : undefined;
}

function toId(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 && value <= 2147483647
    ? value
    : 0;
}

function nonNeg(value: unknown): number {
  const n = Math.floor(Number(value));
  return Number.isFinite(n) && n > 0 && n <= 2147483647 ? n : 0;
}

function num(value: unknown): number {
  return value !== undefined && value !== null ? Number(value) || 0 : 0;
}

function toBeBuffer(value: unknown): Buffer | null {
  return Buffer.isBuffer(value) ? value : null;
}

function parseSecretKeys(raw: string): ShopAccountSecretKey[] {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    return arr.filter((v): v is ShopAccountSecretKey =>
      SHOP_ACCOUNT_SECRET_KEYS.includes(v as ShopAccountSecretKey),
    );
  } catch {
    return [];
  }
}

/** 开店时间：只接受 YYYY-MM-DD（或以其开头的 ISO 串），落库统一 YYYY-MM-DD；非法值清空 */
function normalizeOpenedAt(value: unknown): string {
  const raw = String(value ?? '').trim();
  const matched = /^(\d{4})-(\d{2})-(\d{2})(?:[T\s].*)?$/.exec(raw);
  if (!matched) return '';
  const year = Number(matched[1]);
  const month = Number(matched[2]);
  const day = Number(matched[3]);
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

/** 搜索归一化：忽略空白与常见分隔符（138-1234-5678 与 13812345678 等价） */
function normalizeSearch(value: string): string {
  return String(value || '')
    .toLowerCase()
    .replace(/[\s\-()（）+]/g, '');
}
