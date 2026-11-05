// electron/shop-secrets.ts
// 店铺行与工具账号共用的敏感字段加解密层（不碰表、不含业务口径）。
//
// 存储约定（两条表共用同一套 BLOB 格式）：
//   - `secret_enc` / `password_enc` 首字节是标记：'E' = safeStorage 密文；'P' = 安全存储不可用时的明文降级；
//   - 店铺行只存四个键：店铺密码 / 邮箱密码 / 国际支付宝密码 / IMAP 授权码；
//   - 工具账号（紫鸟 / ERP）只存一个键 `pwd`，一条登录一份密码。
//
// 安全边界：明文只在主进程按需解密（reveal / 复制 / 邮件同步），列表接口永不返回密码
// （见 AGENTS.md §1.7 与红线 3）。

export {};

const { safeStorage } = require('electron');

/** 店铺行的敏感字段键 */
export type ShopSecretKey = 'shopPwd' | 'emailPwd' | 'alipayPwd' | 'mailAuthPwd';

/** 店铺行敏感字段白名单 */
export const SHOP_SECRET_KEYS: readonly ShopSecretKey[] = [
  'shopPwd',
  'emailPwd',
  'alipayPwd',
  'mailAuthPwd',
];

/** 工具账号的敏感字段键（紫鸟 / ERP 共用） */
export type ToolSecretKey = 'pwd';

/** 工具账号敏感字段白名单 */
export const TOOL_SECRET_KEYS: readonly ToolSecretKey[] = ['pwd'];

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

/** 序列化并加密敏感字段；无内容返回 null */
export function encodeSecrets(secrets: Partial<Record<string, string>>): Buffer | null {
  const entries = Object.entries(secrets).filter(([, value]) => !!value);
  if (entries.length === 0) return null;
  const json = Buffer.from(JSON.stringify(Object.fromEntries(entries)), 'utf8');
  if (isSecureStorageAvailable()) {
    try {
      return Buffer.concat([Buffer.from('E'), safeStorage.encryptString(json.toString('utf8'))]);
    } catch {
      /* 加密异常时降级为明文标记，保证数据不丢 */
    }
  }
  return Buffer.concat([Buffer.from('P'), json]);
}

/** 解密为原始键值对（不做键白名单过滤，供历史数据迁移使用） */
export function decodeSecretsRaw(enc: Buffer | null): Record<string, string> {
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

/** 解密店铺行敏感字段（仅保留白名单键） */
export function decodeShopSecrets(enc: Buffer | null): Partial<Record<ShopSecretKey, string>> {
  const raw = decodeSecretsRaw(enc);
  const result: Partial<Record<ShopSecretKey, string>> = {};
  for (const key of SHOP_SECRET_KEYS) {
    if (raw[key]) result[key] = raw[key];
  }
  return result;
}

/** 工具账号密码（无密码 / 解密失败返回空串） */
export function decodeToolPassword(enc: Buffer | null): string {
  return decodeSecretsRaw(enc).pwd || '';
}
