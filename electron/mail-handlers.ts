// electron/mail-handlers.ts
// 「集中邮件收件箱」渲染层 IPC（语义化通道，electron/main.ts require 后自动生效）。
//   mail-db-ensure       幂等建表（视图首次激活时调用）
//   mail-account-list    已接入的邮箱账号列表（含同步状态与游标，**不含任何凭据**）
//   mail-account-upsert  接入/更新邮箱（授权码经 shop-accounts 的加密列落库）
//   mail-account-delete  取消接入（连带删除已缓存邮件）
//   mail-account-test    连接测试（只读打开 INBOX 后立即登出，不落库）
//   mail-sync-now        触发同步（省略 accountId = 全部启用账号）
//   mail-sync-cancel     取消同步
//   mail-sync-state      当前同步队列状态
//   mail-messages-list   邮件列表（**纯本地查询**）
//   mail-message-get     邮件详情（含正文与附件元信息）
//   mail-body-fetch      按需补拉正文（M2-1：超大邮件点开时现拉原文）
//   mail-attachment-save 附件另存（M2-2：重拉原文解析后落盘，弹系统保存对话框）
//   mail-attachment-preview 附件预览（M3-1：本地缓存命中直接读盘，图片返回 data URL）
//   mail-attachment-open   附件用系统应用打开（M3-1）
//   mail-folders-list   拉取服务端文件夹列表（M3-3：设置页勾选同步目录）
//   mail-cache-status   附件缓存占用（M3-1）
//   mail-cache-clear    清空附件缓存
//   mail-cache-open     打开缓存目录
//   mail-fts-status     FTS5 索引状态（M3-2）
//   mail-fts-rebuild    重建全文索引
//   mail-purge           手动清理过期邮件
//   mail-stats           收件箱汇总（含文件夹分布）
// 安全边界：授权码只进不出（写入后永不回传渲染层）；入参在 preload 层已做形状消毒，
//   本层再做一次业务口径校验（双防线，见 AGENTS.md §2.3 / 红线 3）。

export {};

import { ipcMain, dialog, shell, BrowserWindow } from 'electron';
import { promises as fsPromises } from 'fs';
import {
  ensureMailSchema,
  listMailAccounts,
  upsertMailAccount,
  deleteMailAccount,
  listMailMessages,
  getMailMessage,
  purgeMailMessages,
  updateMailAccountStatus,
  mailStats,
  mailFtsStatus,
  rebuildMailFts,
  markMailMessagesRead,
  markAllMailMessagesRead,
  MAIL_ACCOUNT_STATUSES,
} from './mail-db';
import {
  testMailConnection,
  enqueueMailSync,
  cancelMailSync,
  getMailSyncState,
  fetchMailBody,
  resolveMailAttachment,
  listMailRemoteFolders,
} from './mail-engine';
import { getShopAccount, setShopAccountSecret } from './shop-accounts-db';
import { MAIL_PROVIDERS, CUSTOM_MAIL_PROVIDER } from './mail-providers';
import {
  mailCacheStatus,
  clearMailCache,
  garbageCollectMailCache,
  ensureMailAttachmentPath,
  getMailCacheDir,
} from './mail-cache';

const MAX_LEN = {
  email: 200,
  providerId: 40,
  host: 200,
  folder: 200,
  keyword: 100,
  secret: 500,
} as const;

/** 可内联预览的附件类型前缀（其余类型走「系统应用打开」） */
const PREVIEW_MIME_PREFIX = 'image/';
/** 预览附件大小上限：超出不转 data URL，避免大 base64 撑爆渲染进程 */
const PREVIEW_MAX_BYTES = 5 * 1024 * 1024;

function handle<T>(channel: string, fn: (payload: any) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_e: any, payload: any) => {
    try {
      const data = await fn(payload);
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err?.message || '未知错误' };
    }
  });
}

/** 正整数收敛（非法值回落到 fallback） */
function toInt(value: unknown, fallback: number): number {
  const n = Number(value);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : fallback;
}

handle('mail-db-ensure', () => {
  ensureMailSchema();
  return { ok: true };
});

handle('mail-account-list', () => listMailAccounts());

// 服务商预设只外发 UI 需要的字段（clientInfo / maxConnections 属连接细节，不下发）
handle('mail-provider-list', () =>
  [...MAIL_PROVIDERS, CUSTOM_MAIL_PROVIDER].map((p) => ({
    id: p.id,
    label: p.label,
    domains: p.domains,
    host: p.host,
    port: p.port,
    secure: p.secure,
    authHint: p.authHint,
    helpUrl: p.helpUrl,
    idle: p.idle,
    defaultSyncDays: p.defaultSyncDays,
  })),
);

handle('mail-account-upsert', (payload: any) => {
  ensureMailSchema();
  const shopSetId = toInt(payload?.shopSetId, 0);
  if (shopSetId <= 0) throw new Error('店铺套不存在或已被删除');

  const shopSet = getShopAccount(shopSetId);
  if (!shopSet) throw new Error('店铺套不存在或已被删除');

  const email = String(payload?.email || shopSet.email || '').trim().slice(0, MAX_LEN.email);
  if (!email.includes('@')) throw new Error('邮箱格式不正确');

  const syncEnabled = payload?.syncEnabled === undefined ? true : Boolean(payload?.syncEnabled);
  // 多文件夹（M3-3）：未传 = 保持原值；空数组 = 回退单文件夹 folder
  const folders = Array.isArray(payload?.folders)
    ? payload.folders
        .map((f: unknown) => String(f || '').trim().slice(0, MAX_LEN.folder))
        .filter(Boolean)
        .slice(0, 30)
    : undefined;

  const id = upsertMailAccount({
    shopSetId,
    email,
    providerId: String(payload?.providerId || '').slice(0, MAX_LEN.providerId),
    imapHost: String(payload?.imapHost || '').slice(0, MAX_LEN.host),
    imapPort: toInt(payload?.imapPort, 993),
    imapSecure: payload?.imapSecure === undefined ? true : Boolean(payload?.imapSecure),
    folder: String(payload?.folder || 'INBOX').slice(0, MAX_LEN.folder) || 'INBOX',
    folders,
    syncEnabled,
    syncDays: Math.min(365, Math.max(1, toInt(payload?.syncDays, 30))),
    maxBodyBytes: Math.min(2 * 1024 * 1024, Math.max(8 * 1024, toInt(payload?.maxBodyBytes, 204800))),
  });

  // 授权码写入既有加密列（空串 = 清空；未传 = 保持原值）
  const secret = payload?.secrets?.mailAuthPwd;
  if (typeof secret === 'string') {
    setShopAccountSecret(shopSetId, 'mailAuthPwd', secret.slice(0, MAX_LEN.secret));
  }
  return { id };
});

handle('mail-account-delete', async (payload: any) => {
  const id = toInt(payload?.id, 0);
  if (id <= 0) throw new Error('账号不存在');
  deleteMailAccount(id);
  // 账号删除后附件缓存索引级联消失，磁盘残留文件在此回收
  await garbageCollectMailCache().catch(() => 0);
  return { deleted: true };
});

handle('mail-account-test', async (payload: any) => {
  const email = String(payload?.email || '').trim().slice(0, MAX_LEN.email);
  const authPassword = String(payload?.authPassword || '').slice(0, MAX_LEN.secret);
  if (!email.includes('@')) throw new Error('邮箱格式不正确');
  if (!authPassword) throw new Error('请填写 IMAP 授权码');
  return await testMailConnection({
    email,
    providerId: String(payload?.providerId || '').slice(0, MAX_LEN.providerId),
    host: String(payload?.host || '').slice(0, MAX_LEN.host),
    port: toInt(payload?.port, 993),
    secure: payload?.secure === undefined ? true : Boolean(payload?.secure),
    authPassword,
  });
});

handle('mail-sync-now', (payload: any) => {
  ensureMailSchema();
  const accountId = toInt(payload?.accountId, 0);
  return enqueueMailSync(accountId > 0 ? accountId : undefined);
});

handle('mail-sync-cancel', (payload: any) => {
  const accountId = toInt(payload?.accountId, 0);
  if (accountId <= 0) throw new Error('账号不存在');
  cancelMailSync(accountId);
  return { cancelled: true };
});

handle('mail-sync-state', () => getMailSyncState());

handle('mail-messages-list', (payload: any) => {
  ensureMailSchema();
  const accountIds = Array.isArray(payload?.accountIds)
    ? payload.accountIds.map((n: unknown) => toInt(n, 0)).filter((n: number) => n > 0).slice(0, 200)
    : [];
  // 多文件夹筛选（M3-3）：只显示指定文件夹的邮件
  const folders = Array.isArray(payload?.folders)
    ? payload.folders.map((f: unknown) => String(f || '').trim().slice(0, MAX_LEN.folder)).filter(Boolean).slice(0, 30)
    : [];
  return listMailMessages({
    accountIds,
    keyword: String(payload?.keyword || '').slice(0, MAX_LEN.keyword),
    unreadOnly: Boolean(payload?.unreadOnly),
    since: String(payload?.since || '').slice(0, 40),
    folders,
    limit: Math.min(200, Math.max(1, toInt(payload?.limit, 50))),
    offset: Math.max(0, toInt(payload?.offset, 0)),
  });
});

handle('mail-message-get', (payload: any) => {
  ensureMailSchema();
  const id = toInt(payload?.id, 0);
  if (id <= 0) throw new Error('邮件不存在');
  return getMailMessage(id);
});

// 本地已读标记（IMAP 只读，不改服务端 flag；有效已读 = 服务端 seen || 本地 read_at）
handle('mail-message-read', (payload: any) => {
  ensureMailSchema();
  const read = payload?.read !== false;
  const ids = Array.isArray(payload?.ids) ? payload.ids.map((n: any) => toInt(n, 0)) : [];
  if (ids.length) {
    const changed = markMailMessagesRead(ids, read);
    return { changed, unread: mailStats().unread };
  }
  const accountId = toInt(payload?.accountId, 0);
  if (accountId > 0 || payload?.all === true) {
    const changed = markAllMailMessagesRead(accountId > 0 ? accountId : undefined, read);
    return { changed, unread: mailStats().unread };
  }
  throw new Error('缺少待标记的邮件');
});

// 按需补拉正文（M2-1）：同步时为超大邮件只存了预览，点开详情时现拉原文
handle('mail-body-fetch', async (payload: any) => {
  ensureMailSchema();
  const messageId = toInt(payload?.messageId, 0);
  if (messageId <= 0) throw new Error('邮件不存在');
  return await fetchMailBody(toInt(payload?.accountId, 0), messageId);
});

// 附件另存（M2-2 / M3-1）：优先读本地缓存，未命中才重拉原文 → 解析 → 弹保存对话框 → 落盘
handle('mail-attachment-save', async (payload: any) => {
  ensureMailSchema();
  const messageId = toInt(payload?.messageId, 0);
  const attachmentId = toInt(payload?.attachmentId, 0);
  if (messageId <= 0 || attachmentId <= 0) throw new Error('附件不存在');

  const data = await resolveMailAttachment(messageId, attachmentId);
  const win = BrowserWindow.getFocusedWindow();
  const dialogOpts = {
    title: '保存附件',
    defaultPath: String(data.filename || 'attachment.bin'),
  };
  const picked = win ? await dialog.showSaveDialog(win, dialogOpts) : await dialog.showSaveDialog(dialogOpts);
  if (picked.canceled || !picked.filePath) return { canceled: true, path: '', size: 0 };
  await fsPromises.writeFile(picked.filePath, data.content);
  return { canceled: false, path: picked.filePath, size: data.size || data.content.length };
});

// 附件预览（M3-1）：图片内联预览（data URL）；命中本地缓存时不触网
handle('mail-attachment-preview', async (payload: any) => {
  ensureMailSchema();
  const messageId = toInt(payload?.messageId, 0);
  const attachmentId = toInt(payload?.attachmentId, 0);
  if (messageId <= 0 || attachmentId <= 0) throw new Error('附件不存在');

  const file = await resolveMailAttachment(messageId, attachmentId);
  const previewable =
    file.mime.startsWith(PREVIEW_MIME_PREFIX) && file.content.length <= PREVIEW_MAX_BYTES;
  return {
    filename: file.filename,
    mime: file.mime,
    size: file.size,
    path: file.path,
    previewable,
    dataUrl: previewable ? `data:${file.mime};base64,${file.content.toString('base64')}` : '',
  };
});

// 附件用系统默认应用打开（M3-1）：确保有本地文件（缓存命中 / 临时落盘）后交给 shell
handle('mail-attachment-open', async (payload: any) => {
  ensureMailSchema();
  const messageId = toInt(payload?.messageId, 0);
  const attachmentId = toInt(payload?.attachmentId, 0);
  if (messageId <= 0 || attachmentId <= 0) throw new Error('附件不存在');

  const file = await resolveMailAttachment(messageId, attachmentId);
  const target =
    file.path || (await ensureMailAttachmentPath(attachmentId, messageId, file.filename, file.content));
  const openError = await shell.openPath(target);
  if (openError) throw new Error(openError);
  return { path: target };
});

// 服务端文件夹列表（M3-3）：设置页勾选要同步的目录
handle('mail-folders-list', async (payload: any) => {
  ensureMailSchema();
  const accountId = toInt(payload?.accountId, 0);
  if (accountId <= 0) throw new Error('账号不存在');
  return await listMailRemoteFolders(accountId);
});

// 附件缓存（M3-1）：占用统计 / 清空 / 打开目录
handle('mail-cache-status', () => {
  ensureMailSchema();
  return mailCacheStatus();
});

handle('mail-cache-clear', async () => {
  ensureMailSchema();
  const removed = await clearMailCache();
  return { removed };
});

handle('mail-cache-open', async () => {
  const openError = await shell.openPath(getMailCacheDir());
  if (openError) throw new Error(openError);
  return { opened: true };
});

// 全文检索（M3-2）：索引状态 / 重建
handle('mail-fts-status', () => {
  ensureMailSchema();
  return mailFtsStatus();
});

handle('mail-fts-rebuild', () => {
  ensureMailSchema();
  return rebuildMailFts();
});

handle('mail-purge', async (payload: any) => {
  ensureMailSchema();
  const accountId = toInt(payload?.accountId, 0);
  const days = Math.min(365, Math.max(1, toInt(payload?.days, 30)));
  const before = new Date(Date.now() - days * 86400000).toISOString();
  const deleted = purgeMailMessages(accountId > 0 ? accountId : undefined, before);
  // 邮件删除后附件缓存索引级联消失，磁盘残留文件在此回收
  await garbageCollectMailCache().catch(() => 0);
  return { deleted };
});

handle('mail-stats', () => {
  ensureMailSchema();
  return mailStats();
});

/** 供内部调用：把账号置为暂停（例如连续失败后的退避由 UI 决定时） */
export function pauseMailAccount(id: number, reason: string): void {
  if (!MAIL_ACCOUNT_STATUSES.length) return;
  updateMailAccountStatus(id, { status: 'paused', lastError: String(reason || '').slice(0, 500) });
}
