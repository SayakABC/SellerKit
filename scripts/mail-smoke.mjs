// IMAP 协议冒烟：验证真实邮箱可连、可只读打开、可抓取并解析正文。
// 凭据只经环境变量传入，不落盘、不入库：
//   MAIL_USER=xxx@163.com MAIL_PASS=<授权码> node scripts/mail-smoke.mjs [抓取封数]
// 可选：MAIL_DAYS=30  MAIL_FOLDER=INBOX

import { ImapFlow } from 'imapflow';
import { simpleParser } from 'mailparser';

const user = process.env.MAIL_USER || '';
const pass = process.env.MAIL_PASS || '';
const days = Number(process.env.MAIL_DAYS || '30');
const folder = process.env.MAIL_FOLDER || 'INBOX';
const limit = Number(process.argv[2] || '10');

if (!user || !pass) {
  console.error('缺少凭据：请设置 MAIL_USER / MAIL_PASS 环境变量');
  process.exit(1);
}

const t0 = Date.now();
const client = new ImapFlow({
  host: process.env.MAIL_HOST || 'imap.163.com',
  port: Number(process.env.MAIL_PORT || '993'),
  secure: process.env.MAIL_SECURE !== '0',
  auth: { user, pass },
  // 网易要求客户端声明身份（RFC 2971 ID 命令），否则易被判不安全登录
  clientInfo: {
    name: 'SellerKit',
    version: '1.0.0',
    vendor: 'SellerKit',
    contact: user,
  },
  logger: false,
  connectionTimeout: 20000,
  greetingTimeout: 15000,
  socketTimeout: 30000,
});

/** 输出分隔线 */
function title(text) {
  console.log(`\n=== ${text} ${'='.repeat(Math.max(0, 60 - text.length))}`);
}

try {
  await client.connect();
  title('connected');
  console.log(`耗时 ${Date.now() - t0}ms`);

  // capabilities 是 Map<name, value>：取值用 get/has，不要按数组遍历
  const caps = client.capabilities;
  const capNames = caps ? [...caps.keys()] : [];
  title('capabilities');
  console.log(capNames.join(' '));
  for (const name of ['IDLE', 'CONDSTORE', 'UIDPLUS', 'SPECIAL-USE', 'XLIST', 'ID', 'AUTH=XOAUTH2']) {
    console.log(`${name} 支持:`, caps ? caps.has(name) : false);
  }

  const folders = await client.list();
  title(`folders (${folders.length})`);
  for (const f of folders.slice(0, 15)) {
    // f.flags 是 Set
    const flags = f.flags ? [...f.flags] : [];
    console.log(
      `- path=${JSON.stringify(f.path)} delimiter=${JSON.stringify(f.delimiter)} specialUse=${f.specialUse || '-'} flags=${flags.join(',')}`,
    );
  }

  const mailbox = await client.mailboxOpen(folder, { readOnly: true });
  title(`mailboxOpen(readOnly) ${folder}`);
  console.log('exists        =', mailbox.exists);
  console.log('uidNext       =', mailbox.uidNext, typeof mailbox.uidNext);
  console.log('uidValidity   =', mailbox.uidValidity, typeof mailbox.uidValidity);
  console.log('highestModseq =', mailbox.highestModseq, typeof mailbox.highestModseq);
  console.log('readOnly      =', mailbox.readOnly);
  console.log('flags         =', mailbox.flags ? [...mailbox.flags].join(',') : '-');

  const since = new Date(Date.now() - days * 86400000);
  const uids = await client.search({ since });
  title(`search(since=${since.toISOString().slice(0, 10)})`);
  console.log('命中:', Array.isArray(uids) ? uids.length : uids);

  const target = Array.isArray(uids) && uids.length ? uids.slice(-limit) : [];
  title(`fetch ${target.length} 封（envelope + source≤200KB）`);
  const t1 = Date.now();
  let idx = 0;
  for await (const msg of client.fetch(target, {
    uid: true,
    flags: true,
    envelope: true,
    internalDate: true,
    size: true,
    source: { start: 0, maxLength: 200 * 1024 },
  })) {
    idx += 1;
    const env = msg.envelope || {};
    const from = (env.from || [])[0] || {};
    let parsedText = '';
    let parsedHtml = 0;
    let attach = 0;
    let parseErr = '';
    try {
      if (msg.source) {
        const parsed = await simpleParser(msg.source);
        parsedText = (parsed.text || '').replace(/\s+/g, ' ').slice(0, 120);
        parsedHtml = (parsed.html || '').length;
        attach = (parsed.attachments || []).length;
      }
    } catch (err) {
      parseErr = err instanceof Error ? err.message : String(err);
    }
    console.log(
      `#${idx} uid=${msg.uid} date=${String(msg.internalDate).slice(0, 24)} size=${msg.size} seen=${(msg.flags || new Set()).has('\\Seen')}`,
    );
    console.log(`   from=${from.name || ''} <${from.address || ''}>`);
    console.log(`   subject=${JSON.stringify(env.subject || '')}`);
    console.log(`   text=${parsedText || '(空)'} htmlLen=${parsedHtml} attachments=${attach} sourceBytes=${msg.source ? msg.source.length : 0}${parseErr ? ` parseErr=${parseErr}` : ''}`);
  }
  console.log(`抓取耗时 ${Date.now() - t1}ms`);

  await client.logout();
  title('logout ok');
  console.log(`总计 ${Date.now() - t0}ms`);
  process.exit(0);
} catch (err) {
  console.error('\n[FAIL]', err instanceof Error ? `${err.name}: ${err.message}` : err);
  console.error('responseText:', err?.responseText || '-');
  console.error('responseStatus:', err?.responseStatus ?? '-');
  process.exit(1);
}
