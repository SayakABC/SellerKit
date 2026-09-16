// electron/shop-accounts-handlers.ts
// 「店铺账号管家」（extensions/shop-accounts）渲染层 IPC（语义化通道，electron/main.ts require 后自动生效）。
//   shop-account-db-ensure   幂等建表（视图首次激活时调用）
//   shop-account-list        店铺套列表（关键字 / 状态 / 平台过滤，永不含明文密码）
//   shop-account-get         单套详情（含解密敏感字段，仅编辑时使用）
//   shop-account-upsert      新增 / 更新（密码在主进程加密后落库）
//   shop-account-delete      删除
//   shop-account-reveal      按需解密单个敏感字段（复制 / 查看）
//   shop-account-summary     汇总（总数 / 按状态计数 / 平台选项）
//   shop-account-security    当前系统安全存储可用性（不可用时前端提示风险）
//   shop-account-batch-update 批量修改（非敏感字段；含整批事务）
// 入参在 preload 层已做形状消毒，本层再做一次业务口径校验（双防线，见 AGENTS.md §2.3）。

export {};

import { ipcMain } from 'electron';
import {
  ensureShopAccountSchema,
  listShopAccounts,
  getShopAccount,
  upsertShopAccount,
  deleteShopAccount,
  revealShopAccountSecret,
  batchUpdateShopAccounts,
  shopAccountSummary,
  isSecureStorageAvailable,
  SHOP_ACCOUNT_SECRET_KEYS,
  SHOP_ACCOUNT_STATUSES,
  type ShopAccountStatus,
  type ShopAccountSecretKey,
  type ShopAccountUpsertInput,
  type ShopAccountBatchFieldPatch,
} from './shop-accounts-db';

const MAX_LEN = {
  email: 200,
  platform: 60,
  company: 120,
  phone: 40,
  alipay: 200,
  ziniaoAccount: 120,
  erpAccount: 120,
  tags: 200,
  note: 2000,
  secret: 500,
  openedAt: 10,
} as const;

/** 平台数组上限（与 db 层 MAX_PLATFORM_COUNT 保持一致） */
const MAX_PLATFORM_COUNT = 20;

function handle<T>(channel: string, fn: (payload: any) => T): void {
  ipcMain.handle(channel, (_e: any, payload: any) => {
    try {
      const data = fn(payload);
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err?.message || '未知错误' };
    }
  });
}

/** 截断字符串到指定长度（非字符串一律视为空串） */
function str(value: unknown, max: number): string {
  return typeof value === 'string' ? value.slice(0, max) : '';
}

/** 解析正整数 id（非法返回 0） */
function toId(value: unknown): number {
  return typeof value === 'number' && Number.isInteger(value) && value > 0 ? value : 0;
}

handle('shop-account-db-ensure', () => {
  ensureShopAccountSchema();
  return null;
});

handle('shop-account-list', (payload: any) => {
  ensureShopAccountSchema();
  const p = payload ?? {};
  return listShopAccounts({
    search: str(p.search, 100),
    status: str(p.status, 20),
    platform: str(p.platform, MAX_LEN.platform),
  });
});

handle('shop-account-get', (payload: any) => {
  const id = toId(payload?.id);
  if (!id) throw new Error('缺少店铺套 id');
  return getShopAccount(id);
});

handle('shop-account-summary', () => {
  ensureShopAccountSchema();
  return shopAccountSummary();
});

handle('shop-account-security', () => ({ secureStorage: isSecureStorageAvailable() }));

handle('shop-account-upsert', (payload: any) => {
  const p = payload ?? {};

  const input: ShopAccountUpsertInput = {
    id: toId(p.id),
    email: str(p.email, MAX_LEN.email),
    phone: str(p.phone, MAX_LEN.phone),
    company: str(p.company, MAX_LEN.company),
    alipay: str(p.alipay, MAX_LEN.alipay),
    ziniaoAccount: str(p.ziniaoAccount, MAX_LEN.ziniaoAccount),
    erpAccount: str(p.erpAccount, MAX_LEN.erpAccount),
    status: coerceStatus(p.status),
    tags: str(p.tags, MAX_LEN.tags),
    note: str(p.note, MAX_LEN.note),
  };
  // 开店时间：未传 / 非字符串 = 保持原值；字符串由 db 层按 YYYY-MM-DD 归一化（空串即清除）
  if (typeof p.openedAt === 'string') {
    input.openedAt = str(p.openedAt, MAX_LEN.openedAt);
  }
  // 平台：undefined = 保持原值；数组（含空数组）= 覆盖（空数组即清空）
  if (Array.isArray(p.platforms)) {
    input.platforms = p.platforms
      .slice(0, MAX_PLATFORM_COUNT)
      .map((v: unknown) => str(v, MAX_LEN.platform))
      .filter((v: string) => !!v);
  }
  // 敏感字段：仅覆盖显式传入的键（未传 = 保持原值；空串 = 清除）
  const secretsRaw = p.secrets && typeof p.secrets === 'object' ? (p.secrets as Record<string, unknown>) : null;
  if (secretsRaw) {
    for (const key of SHOP_ACCOUNT_SECRET_KEYS) {
      if (Object.prototype.hasOwnProperty.call(secretsRaw, key)) {
        input[key as ShopAccountSecretKey] = str(secretsRaw[key], MAX_LEN.secret);
      }
    }
  }

  return { id: upsertShopAccount(input), secureStorage: isSecureStorageAvailable() };
});

handle('shop-account-delete', (payload: any) => {
  const id = toId(payload?.id);
  if (!id) throw new Error('缺少店铺套 id');
  deleteShopAccount(id);
  return { deleted: true };
});

handle('shop-account-reveal', (payload: any) => {
  const id = toId(payload?.id);
  if (!id) throw new Error('缺少店铺套 id');
  const field = str(payload?.field, 20) as ShopAccountSecretKey;
  if (!SHOP_ACCOUNT_SECRET_KEYS.includes(field)) throw new Error('不支持的敏感字段');
  return { value: revealShopAccountSecret(id, field) };
});

/**
 * 批量修改店铺套（非敏感字段；含整批事务）
 * 入参形状由 preload 结构白名单控制，这里只做二次校验 + 实际执行
 */
handle('shop-account-batch-update', (payload: any) => {
  const ids = Array.isArray(payload?.ids)
    ? payload.ids
        .map((v: unknown) => toId(v))
        .filter((v: number | undefined): v is number => v !== undefined)
    : [];
  if (ids.length === 0) return { updated: 0 };
  // 单次批量上限：防止极端场景下事务过长（按 2000 条/批为上限，按需可放宽）
  if (ids.length > 5000) throw new Error('单次批量修改条数过多（最多 5000）');

  const raw = payload?.patch && typeof payload.patch === 'object' ? payload.patch : {};
  const patch: ShopAccountBatchFieldPatch = {};

  if (typeof raw.status === 'string') {
    patch.status = coerceStatus(raw.status);
  }
  if (typeof raw.phone === 'string') {
    patch.phone = str(raw.phone, MAX_LEN.phone);
  }
  if (typeof raw.alipay === 'string') {
    patch.alipay = str(raw.alipay, MAX_LEN.alipay);
  }
  if (typeof raw.ziniaoAccount === 'string') {
    patch.ziniaoAccount = str(raw.ziniaoAccount, MAX_LEN.ziniaoAccount);
  }
  if (typeof raw.erpAccount === 'string') {
    patch.erpAccount = str(raw.erpAccount, MAX_LEN.erpAccount);
  }
  if (raw.company && typeof raw.company === 'object') {
    const mode = raw.company.mode === 'append' ? 'append' : 'set';
    patch.company = { mode, value: str(raw.company.value, MAX_LEN.company) };
  }
  if (raw.tags && typeof raw.tags === 'object') {
    const mode = raw.tags.mode === 'append' ? 'append' : 'set';
    patch.tags = { mode, value: str(raw.tags.value, MAX_LEN.tags) };
  }
  if (raw.note && typeof raw.note === 'object') {
    const mode = raw.note.mode === 'append' ? 'append' : 'set';
    patch.note = { mode, value: str(raw.note.value, MAX_LEN.note) };
  }
  if (raw.platforms && typeof raw.platforms === 'object') {
    const mode: 'set' | 'append' | 'remove' =
      raw.platforms.mode === 'append'
        ? 'append'
        : raw.platforms.mode === 'remove'
          ? 'remove'
          : 'set';
    const values = Array.isArray(raw.platforms.values)
      ? raw.platforms.values
          .slice(0, MAX_PLATFORM_COUNT)
          .map((v: unknown) => str(v, MAX_LEN.platform))
          .filter((v: string) => !!v)
      : [];
    patch.platforms = { mode, values };
  }

  const updated = batchUpdateShopAccounts(ids, patch);
  return { updated };
});

/** 状态白名单校验，非法值返回 undefined（由 db 层保持原值 / 兜底 active） */
function coerceStatus(value: unknown): ShopAccountStatus | undefined {
  const v = str(value, 20);
  return (SHOP_ACCOUNT_STATUSES as string[]).includes(v) ? (v as ShopAccountStatus) : undefined;
}
