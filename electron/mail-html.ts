// electron/mail-html.ts
// 邮件正文 HTML 的**纯函数**处理层：无 Electron / 无 DB 依赖，可被单测直接引用。
//
// 唯一职责：把「MIME 世界的 cid 引用」翻译成「本地可加载的 URL」，并判定是否还缺映射。
//
// 为什么需要它：正文里的 `<img src="cid:image001.png@01D9...">` 是 MIME 的 Content-ID 引用，
// 浏览器不认识 `cid:` 这个 scheme（实测被 CSP 直接拦掉，见 docs/notes/2026-10-30-mail-and-today-pages.md）。
// 必须靠 `sk_mail_attachments.content_id` 把它换成宿主的
// `sk-mail://att/<messageId>/<attachmentId>`（渲染通道见 electron/mail-body-protocol.ts）。
//
// 属性匹配用 `(?<![-\w])` 而不是 `\b`：`-` 也是词边界，`\b` 会把 `data-src` 里的 `src` 认成
// 同名属性（懒加载邮件常见 `data-src`），改写它会静默破坏原属性名。

/** 匹配 `src=` / `background=` 三种引号形态（双引号 / 单引号 / 裸值） */
const ATTR_RE = /(?<![-\w])(src|background)(\s*=\s*)("[^"]*"|'[^']*'|[^\s"'=<>`]+)/gi;
/** 匹配 CSS `url(...)` 三种引号形态（营销邮件大量用背景图） */
const CSS_URL_RE = /url\(\s*("[^"]*"|'[^']*'|[^)'"]*)\s*\)/gi;
/** 匹配 `<img ...>` 开标签 */
const IMG_TAG_RE = /<img\b[^>]*>/gi;
/** 远程图片判定：http(s) 绝对地址或协议相对地址（`//host/x.png` 同样是外链） */
const REMOTE_URL_RE = /(?<![-\w])(?:src|background)\s*=\s*["']?\s*(?:https?:)?\/\//i;

/**
 * MIME `Content-ID` 归一化。
 * mailparser 给的形如 `<image001.png@01D9...>`，正文里却可能写成
 * `cid:image001.png@01D9...` / `cid:%3C...%3E` / 带引号 —— 统一成「剥尖括号 + 去引号 + 反转义」
 * 的裸串，两侧同口径后才好比对。
 */
export function normalizeContentId(raw: unknown): string {
  let s = String(raw ?? '').trim();
  if (!s) return '';
  // 少数服务商把 cid 整体 URL 编码后再塞进正文引用
  if (/%[0-9a-fA-F]{2}/.test(s)) {
    try {
      s = decodeURIComponent(s);
    } catch {
      /* 保留原文 */
    }
  }
  s = s.replace(/^['"]|['"]$/g, '');
  if (s.startsWith('<')) s = s.slice(1);
  if (s.endsWith('>')) s = s.slice(0, -1);
  return s.trim().slice(0, 500);
}

/** 去掉 value 两侧成对的引号，并回报用的是哪种引号（改写时原样还原） */
function unquote(v: string): { value: string; quote: string } {
  if (v.length >= 2 && (v[0] === '"' || v[0] === "'") && v[v.length - 1] === v[0]) {
    return { value: v.slice(1, -1), quote: v[0] };
  }
  return { value: v, quote: '' };
}

/** `cid:xxx` → 归一化后的 Content-ID；不是 cid 引用返回空串 */
function cidFromRef(raw: unknown): string {
  const s = String(raw ?? '').trim();
  if (!/^cid:/i.test(s)) return '';
  return normalizeContentId(s.slice(4));
}

/**
 * 收集正文里出现的全部 Content-ID（归一化后去重）。
 * 用途：判断"正文引用了内联图，但库里一条 content_id 都没有"⇒ 需要重解析回填。
 */
export function collectCidRefs(html: string): string[] {
  const source = String(html ?? '');
  const found: string[] = [];
  const push = (raw: unknown): void => {
    const cid = cidFromRef(raw);
    if (cid && !found.includes(cid)) found.push(cid);
  };
  for (const m of source.matchAll(ATTR_RE)) push(unquote(m[3]).value);
  for (const m of source.matchAll(CSS_URL_RE)) push(unquote(m[1]).value);
  return found;
}

/** 正文引用了多少个远程（http/https/协议相对）图片：img 标签 + CSS url() 背景图 */
export function countRemoteImages(html: string): number {
  const source = String(html ?? '');
  let n = 0;
  for (const m of source.matchAll(IMG_TAG_RE)) if (REMOTE_URL_RE.test(m[0])) n += 1;
  for (const m of source.matchAll(CSS_URL_RE)) if (/^\s*["']?\s*(?:https?:)?\/\//.test(m[1])) n += 1;
  return n;
}

/**
 * 是否需要为内联图片做一次重解析回填。
 *
 * 背景：`content_id` 列是后加的，存量库里已同步邮件的附件行全是空串；而**增量同步只处理新 UID**
 * （正文已缓存的邮件不会再进正文轮），不主动重解析一次，老邮件的内联图永远映射不上。
 */
export function needsInlineBackfill(
  detail: { htmlBody?: string; attachments?: { contentId?: string }[] } | null | undefined,
): boolean {
  if (!detail) return false;
  const attachments = detail.attachments || [];
  if (!attachments.length) return false;
  // 只要有任何一行带了 content_id，就说明这封已在新口径下解析过，不必反复重拉
  if (attachments.some((a) => String(a.contentId || '').trim())) return false;
  return collectCidRefs(detail.htmlBody || '').length > 0;
}

/**
 * 改写正文里的 cid 引用。
 * @param resolve 把归一化后的 Content-ID 映射成可加载 URL；返回 null 表示无法映射（保留原样）
 * @returns html 改写后的正文；replaced / unmapped 为计数（unmapped > 0 即"图会缺"，供诊断用）
 */
export function rewriteCidRefs(
  html: string,
  resolve: (cid: string) => string | null,
): { html: string; replaced: number; unmapped: number } {
  const source = String(html ?? '');
  let replaced = 0;
  let unmapped = 0;
  const rewrite = (raw: string): string | null => {
    const cid = cidFromRef(raw);
    if (!cid) return null; // 不是 cid 引用，原样保留（null = 不管）
    const url = resolve(cid);
    if (!url) {
      unmapped += 1;
      return null;
    }
    replaced += 1;
    return url;
  };

  let out = source.replace(ATTR_RE, (whole, name: string, eq: string, rawValue: string) => {
    const { value, quote } = unquote(rawValue);
    const url = rewrite(value);
    return url === null ? whole : `${name}${eq}${quote}${url}${quote}`;
  });
  out = out.replace(CSS_URL_RE, (whole, rawValue: string) => {
    const { value } = unquote(rawValue);
    const url = rewrite(value);
    return url === null ? whole : `url("${url}")`;
  });
  return { html: out, replaced, unmapped };
}
