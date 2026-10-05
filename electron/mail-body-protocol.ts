// electron/mail-body-protocol.ts
// 邮件正文渲染通道（`sk-mail://`）：让正文跑在**自带 CSP 的独立来源文档**里。
//
//   sk-mail://body/<messageId>[?remote=1]      正文文档（cid 引用已改写为下面的 att URL）
//   sk-mail://att/<messageId>/<attachmentId>   内联图片二进制（磁盘缓存优先，未命中才重拉原文）
//
// ── 为什么必须另起一个 scheme，而不是继续用 iframe srcdoc ──────────────────────────
// srcdoc 文档按规范**继承父文档的 CSP**，而父文档是 sk-plugin:// 下的岛页面，其
// `img-src 'self' data:` 会拦掉邮件里的全部远程图；`cid:` 更是浏览器不认识的 scheme。
// 实测（2026-10-04，Electron 44）：srcdoc 内的 `<img src="cid:...">` 直接
// `violates ... "img-src 'self' data:"`，远程图同理。独立 scheme 的响应可以自带 CSP，
// 于是「放行图片 / 禁脚本」的边界收敛在这一处，岛自身的 CSP 只需多一条 `frame-src sk-mail:`。
//
// ── 安全姿态（三层，互不依赖）────────────────────────────────────────────────────
//   1. 岛页面 CSP：`frame-src sk-mail:` 只放行"被嵌入"，不放开 img/connect/script；
//   2. 正文文档 CSP：`default-src 'none'` + `img-src <按需>` + `script-src 'none'`；
//   3. iframe `sandbox=""`：连脚本执行与非用户触发的导航都关掉（邮件 HTML 里的 JS 一律不跑）。
//   越权面：附件只按 (messageId, attachmentId) 取，且 resolveMailAttachment 会校验该附件
//   确属这封邮件 —— 与 `mail` 能力域已暴露的读能力同级，未新增信任边界。
//
// ── 红线不变 ─────────────────────────────────────────────────────────────────
// 列表/搜索依旧纯本地；联网只发生在「内联图片首次加载」（复用 mail-engine 的按需限流与磁盘缓存）。

export {};

import { protocol } from 'electron';
import { ensureMailSchema, getMailMessage, type MailMessageDetail } from './mail-db';
import { resolveMailAttachment } from './mail-engine';
import { rewriteCidRefs } from './mail-html';

export const MAIL_BODY_SCHEME = 'sk-mail';

/** 正文文档的外壳样式：邮件按浅色渲染（与常见邮件客户端一致），正文超宽一律换行 */
const BODY_CSS = [
  'html,body{margin:0;padding:10px;background:#fff;color:#1a1a1a;',
  'font:13px/1.7 -apple-system,BlinkMacSystemFont,"PingFang SC","Microsoft YaHei",sans-serif;',
  'word-break:break-word;overflow-wrap:anywhere}',
  'img{max-width:100%;height:auto}',
  'table{max-width:100%}',
  'a{color:#0b6bcb}',
].join('');

/**
 * 正文文档 CSP。
 * 远程图（http/https）默认**不放行**：邮件里的追踪像素靠它挡住，用户点「显示远程图片」才转为 remote=1。
 * 用 scheme 源（`sk-mail:`）而不是 `'self'`：iframe 带 sandbox 时文档是不透明来源，`'self'` 匹配不上任何东西。
 */
function bodyCsp(allowRemote: boolean): string {
  const img = allowRemote ? 'sk-mail: data: https: http:' : 'sk-mail: data:';
  const style = allowRemote ? "'unsafe-inline' data: https: http:" : "'unsafe-inline' data:";
  return [
    "default-src 'none'",
    `img-src ${img}`,
    `style-src ${style}`,
    'font-src data:',
    "script-src 'none'",
    "object-src 'none'",
    "frame-src 'none'",
    "media-src 'none'",
    "base-uri 'none'",
    "form-action 'none'",
  ].join('; ');
}

/** 包一层外壳：显式声明 UTF-8（发件方的 `<meta charset=gb2312>` 会被这层压过，避免乱码） */
function wrapBodyDocument(html: string): string {
  return `<meta charset="utf-8"><style>${BODY_CSS}</style>${html}`;
}

function plain(status: number, text: string): Response {
  return new Response(text, { status, headers: { 'content-type': 'text/plain; charset=utf-8' } });
}

/**
 * 必须在 app ready **之前**调用（main.ts 顶层 require 时执行）。
 * 注：`protocol.registerSchemesAsPrivileged` 可多次调用（plugin-ui-protocol 已为 sk-plugin 注册过一次），
 * 实测 Electron 44 两次调用互不影响。
 */
export function registerMailBodyScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: MAIL_BODY_SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        stream: true,
      },
    },
  ]);
}

/** `sk-mail://att/<messageId>/<attachmentId>` */
function attachmentUrl(messageId: number, attachmentId: number): string {
  return `${MAIL_BODY_SCHEME}://att/${messageId}/${attachmentId}`;
}

/**
 * 正文文档 HTML（导出以便离线冒烟直接断言，不必真起协议）。
 * cid 引用按「归一化 Content-ID → 附件 id」映射改写；映射不上的保持原样（浏览器显示裂图，不静默清空 src）。
 */
export function renderMailBodyHtml(detail: MailMessageDetail): string {
  const cidToAttachment = new Map<string, number>();
  for (const a of detail.attachments) {
    const cid = String(a.contentId || '').trim();
    if (cid && !cidToAttachment.has(cid)) cidToAttachment.set(cid, a.id);
  }
  const { html } = rewriteCidRefs(
    detail.htmlBody || '<p style="color:#888">（无正文）</p>',
    (cid) => {
      const id = cidToAttachment.get(cid);
      return id ? attachmentUrl(detail.id, id) : null;
    },
  );
  return wrapBodyDocument(html);
}

/** 正文文档的 CSP（导出理由同 renderMailBodyHtml：让"远程图默认被拦"这条可被离线断言） */
export function mailBodyCsp(allowRemote: boolean): string {
  return bodyCsp(allowRemote);
}

async function handleBody(url: URL): Promise<Response> {
  const messageId = Number(url.pathname.replace(/^\/+/, '').split('/')[0]);
  if (!Number.isFinite(messageId) || messageId <= 0) return plain(400, 'bad message id');
  ensureMailSchema();
  const detail = getMailMessage(messageId);
  if (!detail) return plain(404, 'message not found');

  return new Response(renderMailBodyHtml(detail), {
    headers: {
      'content-type': 'text/html; charset=utf-8',
      'content-security-policy': mailBodyCsp(url.searchParams.get('remote') === '1'),
      'cache-control': 'no-store',
    },
  });
}

async function handleAttachment(url: URL): Promise<Response> {
  const parts = url.pathname.replace(/^\/+/, '').split('/');
  const messageId = Number(parts[0]);
  const attachmentId = Number(parts[1]);
  if (!Number.isFinite(messageId) || !Number.isFinite(attachmentId) || messageId <= 0 || attachmentId <= 0) {
    return plain(400, 'bad attachment ref');
  }
  ensureMailSchema();
  try {
    const file = await resolveMailAttachment(messageId, attachmentId);
    // 复制成裸 Uint8Array：Response 的 BodyInit 不接受 Buffer 的类型（Uint8Array 子类的泛型签名对不上）
    return new Response(new Uint8Array(file.content), {
      headers: {
        'content-type': file.mime || 'application/octet-stream',
        // 附件 id 在同一封邮件内稳定（replaceMailAttachments 按同键保留原 id），会话内可放心复用
        'cache-control': 'private, max-age=600',
        'x-content-type-options': 'nosniff',
      },
    });
  } catch (err: any) {
    // 单张图失败不该毁掉整篇正文：返回 404 让浏览器显示裂图，正文其余部分照常
    return plain(404, String(err?.message || 'attachment unavailable'));
  }
}

/** app ready 之后调用（main.ts） */
export function initMailBodyProtocol(): void {
  protocol.handle(MAIL_BODY_SCHEME, async (request) => {
    let url: URL;
    try {
      url = new URL(request.url);
    } catch {
      return plain(400, 'bad url');
    }
    if (url.hostname === 'body') return handleBody(url);
    if (url.hostname === 'att') return handleAttachment(url);
    return plain(404, 'unknown sk-mail host');
  });
}
