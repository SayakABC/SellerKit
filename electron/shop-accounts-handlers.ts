// electron/shop-accounts-handlers.ts
// 「店铺账号」合并域 IPC（店铺与账号是同一行；见 docs/plans/SHOP_ACCOUNT_REDESIGN_PLAN.md）。
//   shop-account-db-ensure   幂等建表 / 迁移（视图首次激活时调用）
//   shop-account-list        合并列表（含企业 / 手机号 / 支付宝 / 工具账号；永不含明文密码）
//   shop-account-get         单行详情（含解密敏感字段，仅编辑 / 复制时使用）
//   shop-account-upsert      合并写入（一次写完整行；密码在主进程加密后落库）
//   shop-account-delete      删除（有商品 / 映射引用时拒绝）
//   shop-account-reveal      按需解密单个敏感字段
//   shop-account-summary     汇总（总数 / 状态 / 完整、待补账号、待建店铺）
//   shop-account-security    系统安全存储是否可用
//   shop-account-batch-update 批量修改（仅非敏感字段）
//   tool-account-list        工具账号列表（紫鸟 / ERP；含被引用次数）
//   tool-account-upsert      新建 / 改名 / 改密
//   tool-account-delete      删除（被店铺引用时拒绝）
//   tool-account-reveal      按需解密工具账号密码
// 入参在 preload 层已做形状消毒，本层再做一次业务口径校验（双防线，见 AGENTS.md §2.3）。

export {};

import {
  ensureShopAccountSchema,
  listShopAccounts,
  getShopAccount,
  upsertShopAccount,
  revealShopAccountSecret,
  batchUpdateShopAccounts,
  shopAccountSummary,
  listToolAccounts,
  upsertToolAccount,
  deleteToolAccount,
  revealToolAccountPassword,
  SHOP_ACCOUNT_SECRET_KEYS,
  SHOP_ACCOUNT_STATUSES,
  type ShopAccountStatus,
  type ShopAccountSecretKey,
  type ShopAccountUpsertInput,
  type ShopAccountBatchFieldPatch,
  type ToolAccountKind,
} from './shop-accounts-db';
import { isSecureStorageAvailable } from './shop-secrets';
import { deleteShopAccountGuarded } from './shop-delete-guard';
import { handle } from './ipc-util';

const MAX_LEN = {
  name: 200,
  email: 200,
  platform: 40,
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
} as const;

/** 截断字符串到指定长度（非字符串一律视为空串） */
function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** 解析正整数 id（非法返回 0） */
function toId(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

/** 解析非负整数（0 = 取消关联；非法 / 缺省返回 undefined = 保持原值） */
function optNonNeg(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const n = Math.floor(value);
  return n >= 0 && n <= 2147483647 ? n : undefined;
}

/** 状态白名单校验，非法值返回 undefined（由 db 层保持原值 / 兜底 active） */
function coerceStatus(value: unknown): ShopAccountStatus | undefined {
  const v = str(value, MAX_LEN.status);
  return (SHOP_ACCOUNT_STATUSES as readonly string[]).includes(v)
    ? (v as ShopAccountStatus)
    : undefined;
}

handle('shop-account-db-ensure', (): null => {
  ensureShopAccountSchema();
  return null;
});

handle('shop-account-list', (payload: any) => {
  ensureShopAccountSchema();
  const p = payload ?? {};
  return listShopAccounts({
    search: str(p.search, 200),
    status: str(p.status, MAX_LEN.status),
    companyId: optNonNeg(p.companyId),
    ziniaoAccountId: optNonNeg(p.ziniaoAccountId),
    erpAccountId: optNonNeg(p.erpAccountId),
  });
});

handle('shop-account-get', (payload: any) => {
  const id = toId(payload?.id);
  if (!id) throw new Error('缺少店铺 id');
  return getShopAccount(id) ?? null;
});

handle('shop-account-summary', () => {
  ensureShopAccountSchema();
  return shopAccountSummary();
});

handle('shop-account-security', () => ({ secureStorage: isSecureStorageAvailable() }));

handle('shop-account-upsert', (payload: any) => {
  const p = payload ?? {};

  const input: ShopAccountUpsertInput = { id: toId(p.id) };

  // 字符串字段：undefined（键缺失 / 非字符串）= 保持原值；'' = 清空
  if (typeof p.name === 'string') input.name = str(p.name, MAX_LEN.name);
  if (typeof p.platform === 'string') input.platform = str(p.platform, MAX_LEN.platform);
  if (typeof p.platformShopId === 'string') {
    input.platformShopId = str(p.platformShopId, MAX_LEN.platformShopId);
  }
  if (typeof p.shopUrl === 'string') input.shopUrl = str(p.shopUrl, MAX_LEN.shopUrl);
  if (typeof p.site === 'string') input.site = str(p.site, MAX_LEN.site);
  if (typeof p.email === 'string') input.email = str(p.email, MAX_LEN.email);
  if (typeof p.openedAt === 'string') input.openedAt = str(p.openedAt, MAX_LEN.openedAt);
  if (typeof p.depositReceivedAt === 'string') {
    input.depositReceivedAt = str(p.depositReceivedAt, MAX_LEN.depositReceivedAt);
  }
  if (typeof p.tags === 'string') input.tags = str(p.tags, MAX_LEN.tags);
  if (typeof p.note === 'string') input.note = str(p.note, MAX_LEN.note);

  const status = coerceStatus(p.status);
  if (status !== undefined) input.status = status;

  if (typeof p.score === 'number' && Number.isFinite(p.score) && p.score >= 0) {
    input.score = Math.min(p.score, 2147483647);
  }

  const companyId = optNonNeg(p.companyId);
  if (companyId !== undefined) input.companyId = companyId;
  const ziniaoAccountId = optNonNeg(p.ziniaoAccountId);
  if (ziniaoAccountId !== undefined) input.ziniaoAccountId = ziniaoAccountId;
  const erpAccountId = optNonNeg(p.erpAccountId);
  if (erpAccountId !== undefined) input.erpAccountId = erpAccountId;

  // 敏感字段：仅覆盖显式传入的键（未传 = 保持原值；空串 = 清除）
  const secretsRaw =
    p.secrets && typeof p.secrets === 'object' ? (p.secrets as Record<string, unknown>) : null;
  if (secretsRaw) {
    const secrets: Partial<Record<ShopAccountSecretKey, string>> = {};
    for (const key of SHOP_ACCOUNT_SECRET_KEYS) {
      if (!Object.prototype.hasOwnProperty.call(secretsRaw, key)) continue;
      const value = secretsRaw[key];
      if (typeof value === 'string') secrets[key] = value.slice(0, MAX_LEN.secret);
    }
    if (Object.keys(secrets).length) input.secrets = secrets;
  }
  if (Array.isArray(p.clearSecrets)) {
    const clear = p.clearSecrets.filter(
      (v: unknown): v is ShopAccountSecretKey =>
        typeof v === 'string' && SHOP_ACCOUNT_SECRET_KEYS.includes(v as ShopAccountSecretKey),
    );
    if (clear.length) input.clearSecrets = clear;
  }

  const result = upsertShopAccount(input);
  return { id: result.id, created: result.created, secureStorage: isSecureStorageAvailable() };
});

handle('shop-account-delete', (payload: any) => {
  const id = toId(payload?.id);
  if (!id) throw new Error('缺少店铺 id');
  // 记账引用（条目归属 / 公共分摊行）由编排层统一拦截：见 shop-delete-guard.ts
  return deleteShopAccountGuarded(id);
});

handle('shop-account-reveal', (payload: any) => {
  const id = toId(payload?.id);
  if (!id) throw new Error('缺少店铺 id');
  const field = str(payload?.field, 30) as ShopAccountSecretKey;
  if (!SHOP_ACCOUNT_SECRET_KEYS.includes(field)) throw new Error('不支持的敏感字段');
  return { value: revealShopAccountSecret(id, field) };
});

/**
 * 批量修改（非敏感字段；整批一个事务）
 * 入参形状由 preload 结构白名单控制，这里只做二次校验 + 实际执行
 */
handle('shop-account-batch-update', (payload: any) => {
  const ids = Array.isArray(payload?.ids)
    ? payload.ids.map((v: unknown) => toId(v)).filter((v: number) => v > 0)
    : [];
  if (ids.length === 0) return { updated: 0 };
  if (ids.length > 5000) throw new Error('单次批量修改条数过多（最多 5000）');

  const raw = payload?.patch && typeof payload.patch === 'object' ? payload.patch : {};
  const patch: ShopAccountBatchFieldPatch = {};

  const status = coerceStatus(raw.status);
  if (status !== undefined) patch.status = status;

  const companyId = optNonNeg(raw.companyId);
  if (companyId !== undefined) patch.companyId = companyId;
  const ziniaoAccountId = optNonNeg(raw.ziniaoAccountId);
  if (ziniaoAccountId !== undefined) patch.ziniaoAccountId = ziniaoAccountId;
  const erpAccountId = optNonNeg(raw.erpAccountId);
  if (erpAccountId !== undefined) patch.erpAccountId = erpAccountId;

  if (raw.tags && typeof raw.tags === 'object') {
    const mode = raw.tags.mode === 'append' ? 'append' : 'set';
    patch.tags = { mode, value: str(raw.tags.value, MAX_LEN.tags) };
  }
  if (raw.note && typeof raw.note === 'object') {
    const mode = raw.note.mode === 'append' ? 'append' : 'set';
    patch.note = { mode, value: str(raw.note.value, MAX_LEN.note) };
  }

  return { updated: batchUpdateShopAccounts(ids, patch) };
});

// ---- 工具账号 ----

handle('tool-account-list', (payload: any) => listToolAccounts(str(payload?.kind, 20)));

handle('tool-account-upsert', (payload: any) => {
  const p = payload ?? {};
  const id = upsertToolAccount({
    id: toId(p.id),
    kind: (str(p.kind, 20) || undefined) as ToolAccountKind | undefined,
    account: typeof p.account === 'string' ? str(p.account, MAX_LEN.account) : undefined,
    note: typeof p.note === 'string' ? str(p.note, MAX_LEN.note) : undefined,
    password: typeof p.password === 'string' ? p.password.slice(0, MAX_LEN.secret) : undefined,
  });
  return { id };
});

handle('tool-account-delete', (payload: any) => {
  const id = toId(payload?.id);
  if (!id) throw new Error('缺少账号 id');
  deleteToolAccount(id);
  return { deleted: true };
});

handle('tool-account-reveal', (payload: any) => {
  const id = toId(payload?.id);
  if (!id) throw new Error('缺少账号 id');
  return { value: revealToolAccountPassword(id) };
});
