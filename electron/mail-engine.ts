// electron/mail-engine.ts
// 「集中邮件收件箱」同步引擎（主进程，IMAP **只读**）。
//
// 职责：连接测试 / 增量同步 / 正文按需解析 / 并发限流 / 过期清理，并通过 IPC 事件向渲染层广播进度。
//
// 关键设计（依据 163/126 实测，见 mail-providers.ts 头部注释）：
//   1. **只读**：mailboxOpen 一律 { readOnly: true }，且本文件不提供任何 STORE/flag 写入能力，
//      因此不会改动用户邮箱里的已读状态（"已读"仅作本地展示字段）。
//   2. **无 IDLE、无 CONDSTORE**：163/126 实测均不支持，故实时性靠轮询 + UID 空间扫描：
//      先按 since 窗口 search，再叠加 `uid > lastUid` 增量；UIDVALIDITY 变化即清空重拉。
//   3. **两轮抓取**：第一轮只取元数据（envelope/flags/size），第二轮只对"未缓存且未超限"的邮件
//      抓 source 并解析正文——避免为大附件邮件浪费流量（对齐 Thunderbird「不下载大于 X KB」）。
//   4. **分批事务 + 可中断**：better-sqlite3 是同步 API，长事务会阻塞主进程，故每 200 封提交一次；
//      任意时刻可取消，且所有写入都在事务内，中断不留半截数据。
//   5. **凭据不出引擎**：授权码经 shop-accounts-db 解密后只在本文件使用，绝不回传渲染层。
//
// 依赖：imapflow（IMAP 客户端）/ mailparser（MIME 解析）/ electron/mail-db、shop-accounts-db。

export {};

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';
import { promises as fsPromises } from 'fs';
import {
  ensureMailSchema,
  getMailAccount,
  listMailAccounts,
  getMessageIndex,
  getMailMessage,
  upsertMailMessages,
  saveMailBody,
  updateMailParsed,
  replaceMailAttachments,
  updateMailAccountStatus,
  updateMailCursor,
  resetMailAccountMessages,
  purgeMailMessages,
  resolveMailFolders,
  getMailFolderCursor,
  updateMailFolderCursor,
  indexMailMessages,
  type MailAccountRow,
  type MailMessageUpsertRow,
  type MailMessageDetail,
} from './mail-db';
import { normalizeContentId } from './mail-html';
import { resolveMailProvider, type MailProviderPreset } from './mail-providers';
import { revealShopAccountSecret } from './shop-accounts-db';
import { readMailAttachmentCache, writeMailAttachmentCache } from './mail-cache';

/** 单批事务提交的邮件数（兼顾主进程不卡顿与事务开销） */
const FETCH_BATCH = 200;
/** 单轮抓取正文的邮件数（正文解析较重，批次更小） */
const BODY_BATCH = 20;
/** 全局并发连接上限（网易对第三方客户端有风控） */
const MAX_GLOBAL_CONNECTIONS = 3;
/** 预览文本长度 */
const PREVIEW_LEN = 200;
/** 单封正文最大入库长度（按需拉取同样受此约束，避免大邮件撑爆 SQLite） */
const BODY_TEXT_MAX = 200000;
/** HTML 正文最大入库长度 */
const BODY_HTML_MAX = 2 * 1024 * 1024;
/** 按需拉取（正文补拉 / 附件下载）的原文上限：用户明确要看，放宽到 25MB */
const ON_DEMAND_MAX_BYTES = 25 * 1024 * 1024;
/** 按需拉取并发上限（给同步队列留连接，避免长时间饿死） */
const ON_DEMAND_MAX_CONCURRENT = 2;

/** 同步事件（主进程 → 渲染层，通道 mail-sync-event） */
export interface MailSyncEvent {
  type: 'status' | 'progress' | 'done' | 'error';
  accountId: number;
  email: string;
  status?: string;
  /** 已处理封数 */
  processed?: number;
  /** 本轮命中总封数 */
  total?: number;
  message?: string;
}

let getWindow: (() => any) | null = null;

/** 注入主窗口引用（main.ts 创建窗口后调用），用于向渲染层广播同步事件 */
export function setMailEventWindow(fn: () => any): void {
  getWindow = fn;
}

/** 广播同步事件（窗口已销毁时静默忽略） */
function emitMailEvent(event: MailSyncEvent): void {
  const win = getWindow?.();
  if (!win || win.isDestroyed?.()) return;
  try {
    win.webContents.send('mail-sync-event', event);
  } catch {
    /* 窗口关闭中，忽略 */
  }
}

/**
 * 构造 ImapFlow 客户端（含网易要求的 ID 声明与超时配置）。
 * @param preset 服务商预设（提供 host/port/secure/clientInfo）
 * @param account 账号行（可覆盖 host/port/secure/proxy）
 * @param password IMAP 授权码（明文，仅在本文件使用）
 */
function createClient(preset: MailProviderPreset, account: MailAccountRow, password: string): ImapFlow {
  return new ImapFlow({
    host: String(account.imapHost || preset.host),
    port: Number(account.imapPort || preset.port),
    secure: account.imapHost ? account.imapSecure : preset.secure,
    auth: { user: account.email, pass: password },
    clientInfo: preset.clientInfo,
    proxy: account.proxy || undefined,
    logger: false,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 60000,
  });
}

/**
 * HTML → 纯文本（163/126 的营销/通知邮件普遍**只有 HTML 没有 text**，必须自行降级）。
 * 仅做标签/实体/空白处理，不追求排版还原，产出用于列表预览与关键词检索。
 */
export function htmlToText(html: string, maxLen = PREVIEW_LEN): string {
  if (!html) return '';
  const text = String(html)
    .replace(/<(script|style|head)[\s\S]*?<\/\1>/gi, ' ')
    .replace(/<br\s*\/?>/gi, ' ')
    .replace(/<\/(p|div|tr|li|h[1-6])>/gi, ' ')
    .replace(/<[^>]+>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/&amp;/g, '&')
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, ' ')
    .trim();
  return maxLen > 0 ? text.slice(0, maxLen) : text;
}

/** 取发件人显示名与地址（envelope 为空时兜底空串） */
function pickAddress(list: any[] | undefined): { name: string; address: string } {
  const first = Array.isArray(list) ? list[0] : undefined;
  return {
    name: String(first?.name || '').slice(0, 200),
    address: String(first?.address || '').toLowerCase().slice(0, 200),
  };
}

/** 地址数组 → 紧凑 JSON（只保留 name/address，避免存整个对象） */
function addressesToJson(list: any[] | undefined): string {
  if (!Array.isArray(list) || !list.length) return '[]';
  return JSON.stringify(
    list.slice(0, 20).map((a) => ({ name: String(a?.name || ''), address: String(a?.address || '') })),
  );
}

/**
 * 把离散 UID 合并为 IMAP 区间字符串（如 5,8:11,20）。
 * 必要性：imapflow 的 fetch/range 里 `number[]` 按**序列号**解释（实测 163：传 [1..8] 抓到的是
 * 真实 uid 1789040684+），要按 UID 抓取必须走 `{ uid: '<区间>' }` 形式。
 * @param uids 真实 UID 列表（已排序与否均可）
 * @returns 区间字符串；空列表返回空串
 */
export function buildUidRange(uids: number[]): string {
  const sorted = Array.from(new Set(uids.map((n) => Number(n)).filter((n) => Number.isFinite(n) && n > 0))).sort(
    (a, b) => a - b,
  );
  if (!sorted.length) return '';
  const parts: string[] = [];
  let start = sorted[0];
  let prev = sorted[0];
  for (let i = 1; i < sorted.length; i += 1) {
    const cur = sorted[i];
    if (cur === prev + 1) {
      prev = cur;
      continue;
    }
    parts.push(start === prev ? `${start}` : `${start}:${prev}`);
    start = cur;
    prev = cur;
  }
  parts.push(start === prev ? `${start}` : `${start}:${prev}`);
  return parts.join(',');
}

export interface MailConnectionTestInput {
  email: string;
  providerId?: string;
  host?: string;
  port?: number;
  secure?: boolean;
  /** IMAP 授权码（明文，仅用于本次连接测试，不落库） */
  authPassword: string;
}

export interface MailConnectionTestResult {
  ok: boolean;
  capabilities: string[];
  /** 是否支持 IDLE 长连接（163/126 = false） */
  idle: boolean;
  folders: { path: string; specialUse: string }[];
  inboxExists: boolean;
  messageCount: number;
  error: string;
}

/**
 * 连接测试（只读打开 INBOX 后立即登出，不落库任何数据）。
 * 用于「接入邮箱」向导里即时校验授权码是否可用。
 */
export async function testMailConnection(
  input: MailConnectionTestInput,
): Promise<MailConnectionTestResult> {
  const email = String(input.email || '').trim();
  if (!email.includes('@')) throw new Error('邮箱格式不正确');
  if (!input.authPassword) throw new Error('请填写 IMAP 授权码');

  const preset = resolveMailProvider(email, input.providerId);
  const host = String(input.host || preset.host || '').trim();
  if (!host) throw new Error('请填写 IMAP 服务器地址');

  const client = new ImapFlow({
    host,
    port: Number(input.port || preset.port),
    secure: input.secure === undefined ? preset.secure : input.secure,
    auth: { user: email, pass: input.authPassword },
    clientInfo: preset.clientInfo,
    logger: false,
    connectionTimeout: 20000,
    greetingTimeout: 15000,
    socketTimeout: 30000,
  });

  const result: MailConnectionTestResult = {
    ok: false,
    capabilities: [],
    idle: false,
    folders: [],
    inboxExists: false,
    messageCount: 0,
    error: '',
  };

  try {
    await client.connect();
    result.capabilities = client.capabilities ? [...client.capabilities.keys()] : [];
    result.idle = client.capabilities ? client.capabilities.has('IDLE') : false;

    const folders = await client.list();
    result.folders = (folders || []).map((f: any) => ({
      path: String(f.path || ''),
      specialUse: String(f.specialUse || ''),
    }));
    result.inboxExists = result.folders.some(
      (f) => f.path.toUpperCase() === 'INBOX' || f.specialUse === '\\Inbox',
    );

    if (result.inboxExists) {
      const mailbox = await client.mailboxOpen('INBOX', { readOnly: true });
      result.messageCount = Number(mailbox?.exists || 0);
    }
    result.ok = true;
    return result;
  } catch (err: any) {
    result.error = String(err?.message || err);
    return result;
  } finally {
    try {
      await client.logout();
    } catch {
      /* 登出失败不影响结果 */
    }
  }
}

// ---------------------------------------------------------------------------
// 同步调度：队列 + 并发上限 + 可取消
// ---------------------------------------------------------------------------

const queue: number[] = [];
const active = new Set<number>();
const cancelled = new Set<number>();

/**
 * 触发同步（按账号入队；已在队列/执行中则跳过）。
 * @param accountId 省略则同步全部启用中的账号
 */
export function enqueueMailSync(accountId?: number): { queued: number[] } {
  ensureMailSchema();
  const ids = accountId
    ? [Number(accountId)]
    : listMailAccounts()
        .filter((a) => a.syncEnabled)
        .map((a) => a.id);
  const accepted: number[] = [];
  for (const id of ids) {
    if (!Number.isFinite(id) || id <= 0) continue;
    if (active.has(id) || queue.includes(id)) continue;
    cancelled.delete(id);
    queue.push(id);
    accepted.push(id);
  }
  pumpMailQueue();
  return { queued: accepted };
}

/** 请求取消（下一个批次边界生效，不会强杀 socket 中途状态） */
export function cancelMailSync(accountId: number): void {
  cancelled.add(Number(accountId));
}

/** 当前同步态（供 UI 展示与轮询判断） */
export function getMailSyncState(): { active: number[]; queued: number[] } {
  return { active: [...active], queued: [...queue] };
}

function pumpMailQueue(): void {
  while (active.size < MAX_GLOBAL_CONNECTIONS && queue.length) {
    const id = queue.shift();
    if (!id) break;
    active.add(id);
    runMailSync(id)
      .catch((err: any) => {
        updateMailAccountStatus(id, { status: 'error', lastError: String(err?.message || err) });
        emitMailEvent({
          type: 'error',
          accountId: id,
          email: '',
          message: String(err?.message || err),
        });
      })
      .finally(() => {
        active.delete(id);
        cancelled.delete(id);
        pumpMailQueue();
      });
  }
}

/**
 * 单账号同步主流程（只读）。
 * M3 多文件夹：一条 IMAP 连接按文件夹顺序同步（imapflow 再次 mailboxOpen 会自动关闭上一个邮箱），
 * 每个文件夹各自维护 UID 游标；单个文件夹失败（目录被删/无权限）不熔断整个账号。
 */
async function runMailSync(accountId: number): Promise<void> {
  const account = getMailAccount(accountId);
  if (!account) return;
  if (!account.syncEnabled) {
    updateMailAccountStatus(accountId, { status: 'paused' });
    return;
  }

  updateMailAccountStatus(accountId, { status: 'syncing', lastError: '' });
  emitMailEvent({ type: 'status', accountId, email: account.email, status: 'syncing' });

  const preset = resolveMailProvider(account.email, account.providerId);
  const password = revealShopAccountSecret(account.shopId, 'mailAuthPwd');
  if (!password) {
    updateMailAccountStatus(accountId, {
      status: 'error',
      lastError: '未配置 IMAP 授权码（登录密码不能用于 IMAP）',
    });
    emitMailEvent({
      type: 'error',
      accountId,
      email: account.email,
      message: '未配置 IMAP 授权码',
    });
    return;
  }

  const folders = resolveMailFolders(account);
  const client = createClient(preset, account, password);
  let processed = 0;
  let total = 0;
  const errors: string[] = [];

  try {
    await client.connect();
    // 多文件夹：同一条连接按文件夹顺序同步，各自维护 UID 游标
    for (const folder of folders) {
      if (cancelled.has(accountId)) break;
      try {
        const res = await syncMailFolder(client, account, folder, processed);
        processed += res.processed;
        total += res.total;
      } catch (err: any) {
        // 单个文件夹失败（目录被删 / 无权限）不熔断整个账号
        errors.push(`${folder}: ${String(err?.message || err)}`);
      }
    }

    // 过期清理：窗口外邮件（正文/附件经外键级联删除）
    purgeMailMessages(accountId, new Date(Date.now() - account.syncDays * 86400000).toISOString());

    if (folders.length && errors.length >= folders.length) {
      const message = errors.join('；').slice(0, 500);
      updateMailAccountStatus(accountId, { status: 'error', lastError: message });
      emitMailEvent({ type: 'error', accountId, email: account.email, message });
      return;
    }
    updateMailAccountStatus(accountId, {
      status: 'idle',
      lastError: errors.length ? errors.join('；').slice(0, 500) : '',
      lastSyncedAt: new Date().toISOString(),
    });
    emitMailEvent({
      type: 'done',
      accountId,
      email: account.email,
      processed,
      total,
    });
  } catch (err: any) {
    const message = String(err?.message || err);
    updateMailAccountStatus(accountId, { status: 'error', lastError: message });
    emitMailEvent({ type: 'error', accountId, email: account.email, message });
  } finally {
    try {
      await client.logout();
    } catch {
      /* 忽略登出异常 */
    }
  }
}

/**
 * 同步单个文件夹（只读）。
 * @param baseProcessed 本文件夹开始前已完成的邮件数（多文件夹共享同一条进度）
 */
async function syncMailFolder(
  client: ImapFlow,
  account: MailAccountRow,
  folder: string,
  baseProcessed: number,
): Promise<{ processed: number; total: number }> {
  const accountId = account.id;
  let processed = 0;
  const mailbox = await client.mailboxOpen(folder, { readOnly: true });

  // UIDVALIDITY 变化 → 服务端邮箱被重建，旧 UID 不可信，清空重拉（仅影响该文件夹）
  const uidValidity = Number(mailbox.uidValidity || 0);
  const cursor = getMailFolderCursor(accountId, folder);
  if (cursor.uidValidity && uidValidity && cursor.uidValidity !== uidValidity) {
    resetMailAccountMessages(accountId, folder);
  }
  const lastUid = cursor.uidValidity === uidValidity ? cursor.lastUid : 0;

  // 增量条件：时间窗口 +（已有游标时的）UID 下界
  const since = new Date(Date.now() - account.syncDays * 86400000);
  const query: Record<string, any> = { since };
  if (lastUid > 0) {
    query.uid = `${lastUid + 1}:*`;
  }
  // 必须显式 { uid: true }：默认返回的是**序列号**，而库里按真实 UID 唯一索引
  const uids = (await client.search(query, { uid: true })) || [];
  const target = Array.isArray(uids) ? uids.map(Number).filter((n) => Number.isFinite(n) && n > 0) : [];

  emitMailEvent({
    type: 'progress',
    accountId,
    email: account.email,
    processed: baseProcessed,
    total: baseProcessed + target.length,
  });

  // 本轮写入正文的邮件 id，末尾统一维护全文索引（避免逐封开事务）
  const indexedIds: number[] = [];

  if (target.length) {
      const index = getMessageIndex(accountId, folder);

      // 第一轮：元数据（envelope/flags/size），分批事务落库
      for (let i = 0; i < target.length; i += FETCH_BATCH) {
        if (cancelled.has(accountId)) break;
        const chunk = target.slice(i, i + FETCH_BATCH);
        // 按 UID 抓取：range 必须是 { uid: '<区间>' }，直接传数组会被当作序列号
        const range = buildUidRange(chunk);
        if (!range) continue;
        const rows: MailMessageUpsertRow[] = [];
        for await (const msg of client.fetch(
          { uid: range },
          {
            uid: true,
            flags: true,
            envelope: true,
            internalDate: true,
            size: true,
          },
        )) {
          if (!msg || msg.uid === undefined) continue;
          const env: any = msg.envelope || {};
          const from = pickAddress(env.from);
          const date = msg.internalDate instanceof Date ? msg.internalDate : env.date;
          rows.push({
            accountId,
            folder,
            uid: Number(msg.uid),
            messageId: String(env.messageId || '').slice(0, 300),
            subject: String(env.subject || '').slice(0, 500),
            fromName: from.name,
            fromAddr: from.address,
            toJson: addressesToJson(env.to),
            ccJson: addressesToJson(env.cc),
            receivedAt: date ? new Date(date).toISOString() : new Date().toISOString(),
            size: Number(msg.size || 0),
            seen: msg.flags ? msg.flags.has('\\Seen') : false,
            flagged: msg.flags ? msg.flags.has('\\Flagged') : false,
            hasAttachment: false,
            preview: '',
          });
        }
        upsertMailMessages(rows);
        processed += rows.length;
        emitMailEvent({
          type: 'progress',
          accountId,
          email: account.email,
          processed,
          total: target.length,
        });
      }

      // 第二轮：正文（跳过超大邮件，避免拖垮磁盘与流量）
      const needBody = target.filter((uid) => {
        const hit = index.get(uid);
        if (hit && hit.bodyCached) return false;
        return true;
      });
      const freshIndex = getMessageIndex(accountId, folder);
      for (let i = 0; i < needBody.length; i += BODY_BATCH) {
        if (cancelled.has(accountId)) break;
        const chunk = needBody.slice(i, i + BODY_BATCH);
        const bodies: { id: number; uid: number }[] = [];
        for (const uid of chunk) {
          const hit = freshIndex.get(uid);
          if (!hit) continue;
          bodies.push({ id: hit.id, uid });
        }
        if (!bodies.length) continue;
        const range = buildUidRange(bodies.map((b) => b.uid));
        if (!range) continue;
        for await (const msg of client.fetch(
          { uid: range },
          { uid: true, size: true, source: { start: 0, maxLength: account.maxBodyBytes } },
        )) {
          if (!msg || msg.uid === undefined) continue;
          const hit = freshIndex.get(Number(msg.uid));
          if (!hit) continue;
          // 超过上限：只留元数据（点击时可按需补拉，M2）
          if (Number(msg.size || 0) > account.maxBodyBytes || !msg.source) {
            updateMailParsed(hit.id, { preview: '(正文过大，未缓存)' });
            continue;
          }
          let textBody = '';
          let htmlBody = '';
          let attachments: { filename: string; mime: string; size: number; contentId: string }[] = [];
          try {
            const parsed = await simpleParser(msg.source, { skipHtmlToText: true });
            textBody = String(parsed.text || '');
            htmlBody = String(parsed.html || '').slice(0, BODY_HTML_MAX);
            attachments = toAttachmentMeta(parsed);
          } catch (parseErr: any) {
            updateMailParsed(hit.id, { preview: '(正文解析失败)' });
            continue;
          }
          // 纯 HTML 邮件（163/126 常见）：text 为空时降级由 html 生成预览
          const previewSource = textBody || htmlToText(htmlBody, PREVIEW_LEN * 3);
          saveMailBody(hit.id, textBody.slice(0, BODY_TEXT_MAX), htmlBody, htmlBody.length >= BODY_HTML_MAX, {
            index: false,
          });
          indexedIds.push(hit.id);
          updateMailParsed(hit.id, {
            preview: previewSource.slice(0, PREVIEW_LEN),
            hasAttachment: attachments.length > 0,
          });
          if (attachments.length) replaceMailAttachments(hit.id, attachments);
        }
      }
    }

    // 更新文件夹游标（取本轮最大 UID；无新邮件时保持原值）
    const maxUid = target.length ? Math.max(...target) : lastUid;
    updateMailFolderCursor(accountId, folder, uidValidity || cursor.uidValidity, Math.max(lastUid, maxUid || 0));
    // 账号级游标保持同步（兼容旧逻辑与列表展示）
    if (folder === (account.folder || 'INBOX')) {
      updateMailCursor(accountId, uidValidity || account.uidValidity, Math.max(account.lastUid, maxUid || 0));
    }
    // 末尾统一维护全文索引（M3）：批量事务，避免逐封开事务
    if (indexedIds.length) indexMailMessages(indexedIds);

    return { processed, total: target.length };
}

// ---------------------------------------------------------------------------
// 按需拉取（M2）：单封重拉原文 → 解析 → 补正文 / 取附件
// 与同步共用「只读」约束：这里同样只 fetch source，不做任何 flag 写入。
// ---------------------------------------------------------------------------

let onDemandActive = 0;
const onDemandWaiters: (() => void)[] = [];

/** 获取按需拉取名额（超出上限时排队等待，先到先得） */
function acquireOnDemandSlot(): Promise<void> {
  if (onDemandActive < ON_DEMAND_MAX_CONCURRENT) {
    onDemandActive += 1;
    return Promise.resolve();
  }
  return new Promise((resolve) => {
    onDemandWaiters.push(() => {
      onDemandActive += 1;
      resolve();
    });
  });
}

/** 归还名额并唤醒下一个等待者 */
function releaseOnDemandSlot(): void {
  onDemandActive = Math.max(0, onDemandActive - 1);
  const next = onDemandWaiters.shift();
  if (next) next();
}

/**
 * 按需场景打开只读连接（失败即抛，由 handler 转成用户可见错误）。
 * @param folder 目标文件夹（多文件夹后必须按邮件所属目录打开，否则 UID 会落到错误邮箱）
 */
async function openOnDemandClient(accountId: number, folder?: string): Promise<{
  account: MailAccountRow;
  client: ImapFlow;
}> {
  const account = getMailAccount(accountId);
  if (!account) throw new Error('邮箱账号不存在');
  const preset = resolveMailProvider(account.email, account.providerId);
  const password = revealShopAccountSecret(account.shopId, 'mailAuthPwd');
  if (!password) throw new Error('未配置 IMAP 授权码（登录密码不能用于 IMAP）');
  const client = createClient(preset, account, password);
  await client.connect();
  await client.mailboxOpen(folder || account.folder || 'INBOX', { readOnly: true });
  return { account, client };
}

/**
 * 按 UID 抓单封原文（按需路径的公共底座）。
 * @returns 原文 Buffer；服务端已无此邮件时返回 null
 */
async function fetchSourceByUid(client: ImapFlow, uid: number, maxBytes: number): Promise<Buffer | null> {
  for await (const msg of client.fetch(
    { uid: String(Number(uid)) },
    { uid: true, size: true, source: { start: 0, maxLength: maxBytes } },
  )) {
    if (msg?.source) return msg.source as Buffer;
  }
  return null;
}

/** MIME 解析结果 → 附件元信息（与同步路径同口径） */
function toAttachmentMeta(
  parsed: any,
): { filename: string; mime: string; size: number; contentId: string }[] {
  return (parsed?.attachments || []).map((a: any) => ({
    filename: String(a.filename || '').slice(0, 300),
    mime: String(a.contentType || '').slice(0, 120),
    size: Number(a.size || 0),
    // contentId 是内联图片（正文 src="cid:..."）唯一的映射键，必须与同步路径同口径落库
    contentId: normalizeContentId(a.contentId),
  }));
}

/**
 * 按需补拉正文（M2-1）：同步时为超大邮件留的口子——只缓存了预览，点开时现拉原文。
 * 与同步路径的差异：上限放宽到 max(账号上限, 25MB)，**失败不熔断账号**（单次失败不代表账号不可用）。
 * @param accountId 邮箱账号 id（传 0 时取邮件自身的 accountId）
 * @param messageId 本地邮件 id
 * @returns 最新详情（含正文与附件清单）；邮件不存在时返回 null
 */
export async function fetchMailBody(
  accountId: number,
  messageId: number,
): Promise<MailMessageDetail | null> {
  ensureMailSchema();
  const message = getMailMessage(Number(messageId));
  if (!message) return null;

  const targetAccountId = Number(accountId) > 0 ? Number(accountId) : Number(message.accountId);
  await acquireOnDemandSlot();
  const { account, client } = await openOnDemandClient(targetAccountId, message.folder);
  try {
    const maxBytes = Math.max(Number(account.maxBodyBytes) || 0, ON_DEMAND_MAX_BYTES);
    const source = await fetchSourceByUid(client, message.uid, maxBytes);
    if (!source) throw new Error('未取到邮件原文（可能已在服务端被删除）');

    const parsed = await simpleParser(source, { skipHtmlToText: true });
    const textBody = String(parsed.text || '');
    const htmlBody = String(parsed.html || '').slice(0, BODY_HTML_MAX);
    const attachments = toAttachmentMeta(parsed);
    const previewSource = textBody || htmlToText(htmlBody, PREVIEW_LEN * 3);
    const truncated = source.length >= maxBytes || htmlBody.length >= BODY_HTML_MAX;

    saveMailBody(message.id, textBody.slice(0, BODY_TEXT_MAX), htmlBody, truncated);
    updateMailParsed(message.id, {
      preview: previewSource.slice(0, PREVIEW_LEN),
      hasAttachment: attachments.length > 0,
    });
    if (attachments.length) replaceMailAttachments(message.id, attachments);
    return getMailMessage(message.id);
  } finally {
    try {
      await client.logout();
    } catch {
      /* 忽略登出异常 */
    }
    releaseOnDemandSlot();
  }
}

/** 附件内容（按需拉取结果，交给 handler 落盘；**不入库**） */
export interface MailAttachmentData {
  filename: string;
  mime: string;
  size: number;
  /** 附件二进制内容 */
  content: Buffer;
}

/**
 * 按需下载附件（M2-2）：库里只存了元信息，落盘前必须重拉原文解析。
 * 定位策略：先按「附件行序号」取（与入库顺序一致），文件名对不上时按同名序号回退——
 * 处理重名附件（如多张 image001.png）。
 * @param messageId 本地邮件 id
 * @param attachmentId sk_mail_attachments.id
 */
export async function fetchMailAttachmentData(
  messageId: number,
  attachmentId: number,
): Promise<MailAttachmentData> {
  ensureMailSchema();
  const message = getMailMessage(Number(messageId));
  if (!message) throw new Error('邮件不存在');
  const rows = message.attachments || [];
  const ordinal = rows.findIndex((a) => Number(a.id) === Number(attachmentId));
  if (ordinal < 0) throw new Error('附件不存在（可能已被清理）');
  const target = rows[ordinal];

  await acquireOnDemandSlot();
  const { account, client } = await openOnDemandClient(Number(message.accountId), message.folder);
  try {
    const maxBytes = Math.max(Number(account.maxBodyBytes) || 0, ON_DEMAND_MAX_BYTES);
    const source = await fetchSourceByUid(client, message.uid, maxBytes);
    if (!source) throw new Error('未取到邮件原文（可能已在服务端被删除）');

    const parsed = await simpleParser(source, { skipHtmlToText: true });
    const list: any[] = parsed.attachments || [];
    let hit = list[ordinal];
    if (hit && String(hit.filename || '') !== target.filename) {
      const sameNameOrdinal = rows
        .slice(0, ordinal)
        .filter((r) => r.filename === target.filename).length;
      hit = list.filter((a) => String(a.filename || '') === target.filename)[sameNameOrdinal] || hit;
    }
    if (!hit || !hit.content) throw new Error('原文中未找到该附件');

    const content = Buffer.isBuffer(hit.content) ? hit.content : Buffer.from(hit.content);
    return {
      filename: target.filename || 'attachment.bin',
      mime: target.mime,
      size: content.length,
      content,
    };
  } finally {
    try {
      await client.logout();
    } catch {
      /* 忽略登出异常 */
    }
    releaseOnDemandSlot();
  }
}

/** 附件解析结果（M3）：优先本地缓存命中，未命中才重拉原文 */
export interface MailAttachmentFile {
  filename: string;
  mime: string;
  size: number;
  /** 本地缓存路径；空串表示未入缓存（如超过单文件上限） */
  path: string;
  content: Buffer;
}

/**
 * 取附件（M3）：先查本地缓存，命中直接读盘（**不触网**，预览/重复下载秒开）；
 * 未命中则重拉原文并写入缓存，供下次复用。
 */
export async function resolveMailAttachment(
  messageId: number,
  attachmentId: number,
): Promise<MailAttachmentFile> {
  ensureMailSchema();
  const message = getMailMessage(Number(messageId));
  if (!message) throw new Error('邮件不存在');
  const rows = message.attachments || [];
  const target = rows.find((a) => Number(a.id) === Number(attachmentId));
  if (!target) throw new Error('附件不存在（可能已被清理）');

  const hit = await readMailAttachmentCache(Number(attachmentId));
  if (hit) {
    const content = await fsPromises.readFile(hit.path);
    return {
      filename: target.filename || 'attachment.bin',
      mime: target.mime,
      size: content.length,
      path: hit.path,
      content,
    };
  }

  const data = await fetchMailAttachmentData(messageId, attachmentId);
  const cached = await writeMailAttachmentCache(
    Number(attachmentId),
    Number(message.id),
    data.filename,
    data.content,
  ).catch(() => '');
  return { filename: data.filename, mime: data.mime, size: data.size, path: cached, content: data.content };
}

/**
 * 惰性回填附件 `content_id`（内联图片修复的存量迁移路径）。
 *
 * 为什么必须单独有这一步：增量同步只处理新 UID，而正文已缓存的邮件不会再进正文轮 ——
 * 对老邮件来说，`content_id` 列补出来永远只能是空串，正文里的 `cid:` 引用永远映射不上。
 * 触发点在 `mail-message-get`：发现"正文引用了 cid、但附件行一条 content_id 都没有"才走这里
 * （判定见 mail-html.ts 的 needsInlineBackfill）。
 *
 * 与 fetchMailBody 的差异：只刷附件元信息，**不重写正文**（正文没变，重写只会多一次大对象写库）；
 * 复用同一套按需限流与只读连接，因此不会与同步抢连接。
 *
 * @returns 是否真的重解析过（false = 邮件不存在/服务端已删/取原文失败，调用方不必重取详情）
 */
export async function refreshMailAttachmentContentIds(messageId: number): Promise<boolean> {
  ensureMailSchema();
  const message = getMailMessage(Number(messageId));
  if (!message) return false;

  await acquireOnDemandSlot();
  const { account, client } = await openOnDemandClient(Number(message.accountId), message.folder);
  try {
    const maxBytes = Math.max(Number(account.maxBodyBytes) || 0, ON_DEMAND_MAX_BYTES);
    const source = await fetchSourceByUid(client, message.uid, maxBytes);
    if (!source) return false;
    const parsed = await simpleParser(source, { skipHtmlToText: true });
    const attachments = toAttachmentMeta(parsed);
    // 空清单也走一遍 replaceMailAttachments：库里可能有陈旧行需要清掉
    replaceMailAttachments(message.id, attachments);
    return attachments.length > 0;
  } finally {
    try {
      await client.logout();
    } catch {
      /* 忽略登出异常 */
    }
    releaseOnDemandSlot();
  }
}

/** 服务端文件夹条目（设置页勾选同步目录） */
export interface MailRemoteFolder {
  path: string;
  specialUse: string;
  delimiter: string;
}

/**
 * 拉取服务端文件夹列表（只读；用于设置页勾选要同步的目录）。
 * 与同步/测试共用连接参数；失败直接抛出，由 handler 转成用户可见错误。
 */
export async function listMailRemoteFolders(accountId: number): Promise<MailRemoteFolder[]> {
  ensureMailSchema();
  const account = getMailAccount(Number(accountId));
  if (!account) throw new Error('邮箱账号不存在');
  const preset = resolveMailProvider(account.email, account.providerId);
  const password = revealShopAccountSecret(account.shopId, 'mailAuthPwd');
  if (!password) throw new Error('未配置 IMAP 授权码（登录密码不能用于 IMAP）');
  const client = createClient(preset, account, password);
  try {
    await client.connect();
    const list: any[] = (await client.list()) || [];
    return list
      .map((f: any) => ({
        path: String(f?.path || '').slice(0, 300),
        specialUse: String(f?.specialUse || ''),
        delimiter: String(f?.delimiter || ''),
      }))
      .filter((f) => !!f.path)
      .slice(0, 200);
  } finally {
    try {
      await client.logout();
    } catch {
      /* 忽略登出异常 */
    }
  }
}
