// 邮件内联图片「存量库迁移 + 正文渲染」离线冒烟（不联网、不需要凭据）。
//
//   npm run mail:inline:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/mail-inline-images-smoke.cjs
//
// 为什么值得单独一个冒烟：正文里的图能不能显示，押在三件**在全新库上永远复现不出来的事**上 ——
//   1. 老库（content_id 列还不存在）跑 ensureMailSchema() 后列补上、老数据一条不丢；
//   2. 重解析附件时按「同名同型同大小」保留原 attachment_id（否则每次重解析都换 id，
//      已落盘的附件缓存与 sk_mail_attachment_cache 索引会整批失效）——顺带把 content_id 补上；
//   3. cid → sk-mail://att/<msgId>/<attId> 的改写，与"远程图默认被拦"的两态 CSP。
//
// 必须用 Electron 运行（better-sqlite3 按 Electron 的 Node ABI 编译）。库落在临时目录，不碰真实 userData。

const assert = require('assert');
const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-mail-inline-smoke-'));

// --- electron 打桩（本冒烟只用 app.getPath 与 safeStorage；真 Electron 环境下不打桩）---
const fakeElectron = {
  app: {
    getPath: () => tmpDir,
    getVersion: () => '0.0.0',
    getName: () => 'SellerKit',
    isPackaged: false,
    on: () => {},
  },
  ipcMain: { handle: () => {}, on: () => {} },
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(String(s), 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8'),
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  shell: {},
  // sk-mail 协议只在 initMailBodyProtocol 里注册，本冒烟不调用它，protocol 存在即可
  protocol: { registerSchemesAsPrivileged: () => {}, handle: () => {} },
};

if (!process.versions || !process.versions.electron) {
  console.warn('[warn] 非 Electron 环境：electron 已打桩，better-sqlite3 很可能加载失败');
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
}

const { initDb, dbRun, dbQuery } = require('../dist/electron/db.js');
const mailDb = require('../dist/electron/mail-db.js');
const mailHtml = require('../dist/electron/mail-html.js');
const mailBody = require('../dist/electron/mail-body-protocol.js');

let failed = 0;
function check(name, fn) {
  try {
    fn();
    console.log('  ✓ ' + name);
  } catch (err) {
    failed += 1;
    console.error('  ✗ ' + name);
    console.error('    ' + (err && err.message ? err.message : String(err)));
  }
}
function section(text) {
  console.log('\n' + text);
}
function attachmentCols() {
  return dbQuery(`PRAGMA table_info(sk_mail_attachments)`).map((c) => String(c.name));
}
function attachmentRows(messageId) {
  return dbQuery(
    `SELECT id, filename, mime, size, content_id FROM sk_mail_attachments WHERE message_id = ${Number(
      messageId,
    )} ORDER BY id ASC`,
  ).map((r) => ({
    id: Number(r.id),
    filename: String(r.filename),
    mime: String(r.mime),
    size: Number(r.size),
    contentId: String(r.content_id || ''),
  }));
}

initDb(path.join(tmpDir, 'mail-inline-smoke.db'));

// ---------------------------------------------------------------------------
// 1. 存量库补列：模拟"老库"（sk_mail_attachments 还没有 content_id）
// ---------------------------------------------------------------------------
section('存量库迁移（老库 → 补 content_id）');
// 手搓老形状：只建这一张表，其余表交给 ensureMailSchema 建
dbRun(
  `CREATE TABLE IF NOT EXISTS sk_mail_attachments (
     id INTEGER PRIMARY KEY AUTOINCREMENT,
     message_id INTEGER NOT NULL,
     filename TEXT NOT NULL DEFAULT '',
     mime TEXT NOT NULL DEFAULT '',
     size INTEGER NOT NULL DEFAULT 0
   )`,
);
dbRun(
  `INSERT INTO sk_mail_attachments (message_id, filename, mime, size) VALUES (901, 'old-logo.png', 'image/png', 1234)`,
);

check('前置条件：老库确实缺 content_id（否则本组恒绿空转）', () => {
  assert.ok(!attachmentCols().includes('content_id'), `老库不该有 content_id：${attachmentCols().join(',')}`);
});

mailDb.ensureMailSchema();

check('ensureMailSchema 后补出 content_id', () => {
  assert.ok(attachmentCols().includes('content_id'), `未补列：${attachmentCols().join(',')}`);
});

check('老数据一条不丢，content_id 落到空串默认值', () => {
  const row = attachmentRows(901)[0];
  assert.ok(row, '老行被迁移弄丢了');
  assert.strictEqual(row.filename, 'old-logo.png');
  assert.strictEqual(row.size, 1234);
  assert.strictEqual(row.contentId, '');
});

check('幂等：再跑一次 ensureMailSchema 不报错、形状不变、行数不变', () => {
  const colsBefore = attachmentCols();
  mailDb.ensureMailSchema();
  assert.deepStrictEqual(attachmentCols(), colsBefore);
  assert.strictEqual(attachmentRows(901).length, 1);
});

// ---------------------------------------------------------------------------
// 2. 附件写入：content_id 落库 + 重解析保留原 id（缓存不失效）
// ---------------------------------------------------------------------------
section('附件写入与重解析（id 稳定性）');
const MSG = 902;
mailDb.replaceMailAttachments(MSG, [
  { filename: 'image001.png', mime: 'image/png', size: 100, contentId: '<logo@01D9A>' },
  { filename: 'report.pdf', mime: 'application/pdf', size: 9000, contentId: '' },
]);

const firstPass = attachmentRows(MSG);
const logoIdBefore = firstPass.find((a) => a.filename === 'image001.png').id;

check('写入时 content_id 已剥掉尖括号', () => {
  assert.strictEqual(firstPass.find((a) => a.filename === 'image001.png').contentId, 'logo@01D9A');
  assert.strictEqual(firstPass.find((a) => a.filename === 'report.pdf').contentId, '');
});

// 重解析：同名同型同大小的附件这次**不带** contentId（模拟老库补列后第一次重解析），并新增一张图
mailDb.replaceMailAttachments(MSG, [
  { filename: 'image001.png', mime: 'image/png', size: 100 },
  { filename: 'report.pdf', mime: 'application/pdf', size: 9000, contentId: '' },
  { filename: 'image002.jpg', mime: 'image/jpeg', size: 200, contentId: 'banner@01D9A' },
]);
const secondPass = attachmentRows(MSG);

check('同键附件保留原 id（否则附件缓存与索引整批失效）', () => {
  const logo = secondPass.find((a) => a.filename === 'image001.png');
  assert.strictEqual(logo.id, logoIdBefore, `重解析后 id 从 ${logoIdBefore} 变成 ${logo.id}`);
});

check('已补出的 content_id 不被"空值重解析"冲掉（只在旧值为空时写入）', () => {
  assert.strictEqual(secondPass.find((a) => a.filename === 'image001.png').contentId, 'logo@01D9A');
});

check('新增附件照常入库', () => {
  assert.strictEqual(secondPass.length, 3);
  assert.strictEqual(secondPass.find((a) => a.filename === 'image002.jpg').contentId, 'banner@01D9A');
});

// ---------------------------------------------------------------------------
// 3. 正文渲染：cid 改写 + 远程图默认被拦
// ---------------------------------------------------------------------------
section('正文文档渲染');
const bannerId = secondPass.find((a) => a.filename === 'image002.jpg').id;
const htmlBody =
  '<p>hi</p><img src="cid:logo@01D9A"><img src="cid:banner@01D9A">' +
  '<img src="cid:missing@01D9A"><img src="https://cdn.example.com/pixel.png"><img src="data:image/gif;base64,R0lG">';
const rendered = mailBody.renderMailBodyHtml({
  id: MSG,
  htmlBody,
  attachments: secondPass.map((a) => ({ id: a.id, contentId: a.contentId })),
});

check('cid 引用被改写成 sk-mail://att/<msgId>/<attId>', () => {
  assert.ok(rendered.includes(`sk-mail://att/${MSG}/${logoIdBefore}`), '未改写 logo');
  assert.ok(rendered.includes(`sk-mail://att/${MSG}/${bannerId}`), '未改写 banner');
});

check('映射不上的 cid 与远程图都保持原样（不静默清空 src）', () => {
  assert.ok(rendered.includes('src="cid:missing@01D9A"'), '缺失映射的 cid 不该被清空');
  assert.ok(rendered.includes('https://cdn.example.com/pixel.png'), '远程图 src 不应被改动');
});

check('文档显式声明 UTF-8（压过发件方的 gb2312 meta，避免乱码）', () => {
  assert.ok(/<meta charset="utf-8">/.test(rendered), '正文文档缺 charset 声明');
});

check('远程图默认被拦：img-src 无 http(s)，且脚本一律禁', () => {
  const csp = mailBody.mailBodyCsp(false);
  assert.ok(!/img-src[^;]*https:/.test(csp), `默认态不该放行 https：${csp}`);
  assert.ok(/script-src 'none'/.test(csp), '正文文档必须禁脚本');
  assert.ok(/default-src 'none'/.test(csp), '默认应全禁，只按需放开图片');
});

check('放行态（?remote=1）才出现 http(s)，脚本仍禁', () => {
  const csp = mailBody.mailBodyCsp(true);
  assert.ok(/img-src[^;]*https:/.test(csp), `放行态应含 https：${csp}`);
  assert.ok(/img-src[^;]*http:/.test(csp), `放行态应含 http：${csp}`);
  assert.ok(/script-src 'none'/.test(csp), '放行远程图不等于放行脚本');
});

// ---------------------------------------------------------------------------
// 4. 回填判据（决定"打开老邮件时是否重解析一次"）
// ---------------------------------------------------------------------------
section('回填判据');
check('正文引用 cid + 附件行全无映射 → 触发回填', () => {
  assert.strictEqual(
    mailHtml.needsInlineBackfill({
      htmlBody: '<img src="cid:x@y">',
      attachments: [{ contentId: '' }, { contentId: '' }],
    }),
    true,
  );
});

check('已有映射 / 没有附件 / 没有详情 → 不触发', () => {
  assert.strictEqual(
    mailHtml.needsInlineBackfill({ htmlBody: '<img src="cid:x@y">', attachments: [{ contentId: 'x@y' }] }),
    false,
  );
  assert.strictEqual(mailHtml.needsInlineBackfill({ htmlBody: '<img src="cid:x@y">', attachments: [] }), false);
  assert.strictEqual(mailHtml.needsInlineBackfill(null), false);
});

console.log('\n' + (failed ? `✗ ${failed} 项失败` : '✓ 全部通过'));
fs.rmSync(tmpDir, { recursive: true, force: true });
process.exit(failed ? 1 : 0);
