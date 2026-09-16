// electron/mail-providers.ts
// 邮件服务商预设表：为「集中邮件收件箱」提供按邮箱域名推断的 IMAP 连接参数。
//
// 设计目标：**新增一个服务商 = 数组里加一项**，引擎 / IPC / UI 均无需改动。
//   - authType 预留 oauth2（Gmail / Outlook365 走 XOAUTH2），163/126 为 password（客户端授权码）；
//   - idle 标记该服务商是否启用 IMAP IDLE 长连接——163/126 实测不支持，一律走轮询；
//   - clientInfo 用于 IMAP ID 命令（RFC 2971）声明客户端身份，网易等服务商要求声明，否则易被判不安全登录。
//
// 实测依据（rich091002@163.com，2026-09）：
//   imap.163.com:993 授权码登录 424ms；能力集含 XLIST/SPECIAL-USE/ID/UIDPLUS/AUTH=XOAUTH2，
//   **不含 IDLE、不含 CONDSTORE** —— 故实时性只能靠轮询，增量只能靠 UID 空间扫描。

export {};

/** 认证方式：password = 授权码/应用专用密码；oauth2 = XOAUTH2 令牌（预留，尚未启用） */
export type MailAuthType = 'password' | 'oauth2';

export interface MailProviderPreset {
  /** 服务商 id（kebab-case），落库于 sk_mail_accounts.provider_id */
  id: string;
  /** 展示名 */
  label: string;
  /** 邮箱域名（小写，不含 @），用于按地址自动识别 */
  domains: string[];
  host: string;
  port: number;
  secure: boolean;
  authType: MailAuthType;
  /** 凭据获取说明（UI 引导文案） */
  authHint: string;
  /** 授权码获取帮助页 */
  helpUrl: string;
  /** 是否启用 IDLE 长连接（163/126 = false） */
  idle: boolean;
  /** 该服务商允许的并发连接数（网易对第三方客户端有风控，需限流） */
  maxConnections: number;
  /** 默认同步窗口（天） */
  defaultSyncDays: number;
  /** IMAP ID 命令声明的客户端身份 */
  clientInfo: { name: string; version: string; vendor: string; contact: string };
}

/** 自定义服务商 id：域名无法推断（企业邮等）时使用，连接参数由用户手填 */
export const CUSTOM_MAIL_PROVIDER_ID = 'custom';

const CLIENT_INFO = {
  name: 'SellerKit',
  version: '1.0.0',
  vendor: 'SellerKit',
  contact: 'sellerkit@example.com',
};

const NETEASE_AUTH_HINT =
  '网页端「设置 → POP3/SMTP/IMAP」开启 IMAP 后生成客户端授权码；登录密码不能用于 IMAP';

export const MAIL_PROVIDERS: MailProviderPreset[] = [
  {
    id: 'netease-163',
    label: '163 邮箱',
    domains: ['163.com'],
    host: 'imap.163.com',
    port: 993,
    secure: true,
    authType: 'password',
    authHint: NETEASE_AUTH_HINT,
    helpUrl:
      'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac286624f309a1a7089',
    idle: false,
    maxConnections: 3,
    defaultSyncDays: 30,
    clientInfo: CLIENT_INFO,
  },
  {
    id: 'netease-126',
    label: '126 邮箱',
    domains: ['126.com'],
    host: 'imap.126.com',
    port: 993,
    secure: true,
    authType: 'password',
    authHint: NETEASE_AUTH_HINT,
    helpUrl:
      'https://help.mail.163.com/faqDetail.do?code=d7a5dc8471cd0c0e8b4b8f4f8e49998b374173cfe9171305fa1ce630d7f67ac286624f309a1a7089',
    idle: false,
    maxConnections: 3,
    defaultSyncDays: 30,
    clientInfo: CLIENT_INFO,
  },
];

/** 自定义兜底：host 为空表示必须由用户在 UI 填写 */
export const CUSTOM_MAIL_PROVIDER: MailProviderPreset = {
  id: CUSTOM_MAIL_PROVIDER_ID,
  label: '自定义（企业邮等）',
  domains: [],
  host: '',
  port: 993,
  secure: true,
  authType: 'password',
  authHint: '填写服务商提供的 IMAP 地址、端口与专用密码',
  helpUrl: '',
  idle: false,
  maxConnections: 2,
  defaultSyncDays: 30,
  clientInfo: CLIENT_INFO,
};

/** 按 id 取预设（未知 id 返回 undefined，由调用方决定兜底） */
export function getMailProvider(id: string): MailProviderPreset | undefined {
  return MAIL_PROVIDERS.find((p) => p.id === id);
}

/** 按邮箱地址推断服务商（取 @ 后域名小写匹配） */
export function detectMailProvider(email: string): MailProviderPreset | undefined {
  const at = String(email || '').lastIndexOf('@');
  if (at < 0) return undefined;
  const domain = String(email).slice(at + 1).trim().toLowerCase();
  if (!domain) return undefined;
  return MAIL_PROVIDERS.find((p) => p.domains.includes(domain));
}

/**
 * 解析出最终生效的连接参数：显式 providerId 优先，域名推断兜底，最后落到自定义。
 * @param email 邮箱地址（用于域名推断）
 * @param providerId 显式指定的服务商 id（空 = 自动推断）
 * @returns 预设对象（连接参数可被 sk_mail_accounts 的 host/port/secure 覆盖）
 */
export function resolveMailProvider(email: string, providerId?: string): MailProviderPreset {
  const explicit = providerId ? getMailProvider(providerId) : undefined;
  if (explicit) return explicit;
  if (providerId === CUSTOM_MAIL_PROVIDER_ID) return CUSTOM_MAIL_PROVIDER;
  return detectMailProvider(email) || CUSTOM_MAIL_PROVIDER;
}
