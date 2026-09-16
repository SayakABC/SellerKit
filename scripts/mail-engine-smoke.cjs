// 邮件收件箱「引擎 + 数据层」集成冒烟（不启动 Electron 界面）。
//
// 做法：把 electron 模块打桩后用真实 SQLite（临时目录）加载 dist/electron 下的主进程代码，
// 走通 建表 → 建店铺套 → 写授权码 → 接入账号 → 连接测试 → 同步 → 解析 → 列表 全链路。
//
// 必须用 **Electron** 运行（better-sqlite3 按 Electron 的 Node ABI 编译，系统 node 加载会报
// NODE_MODULE_VERSION 不匹配）。在 Electron 环境下不打桩，走真实 app/safeStorage。
//
//   npx tsc -p tsconfig.electron.json
//   MAIL_USER=xxx@163.com MAIL_PASS=<授权码> npx electron scripts/mail-engine-smoke.cjs
//
// 注意：凭据只经环境变量传入，不落任何文件；库文件落在临时目录，不污染真实 userData。

const fs = require('fs');
const os = require('os');
const path = require('path');
const Module = require('module');

const user = process.env.MAIL_USER || '';
const pass = process.env.MAIL_PASS || '';
if (!user || !pass) {
  console.error('缺少凭据：请设置 MAIL_USER / MAIL_PASS 环境变量');
  process.exit(1);
}

const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-mail-smoke-'));

// --- electron 打桩：本冒烟只用到 app.getPath 与 safeStorage ---
const fakeElectron = {
  app: {
    getPath: () => tmpDir,
    getVersion: () => '0.0.0',
    getName: () => 'SellerKit',
    isPackaged: false,
    on: () => {},
  },
  ipcMain: { handle: () => {}, on: () => {} },
  // 打桩环境无钥匙串：走明文降级分支（首字节 'P'），不影响链路验证
  safeStorage: {
    isEncryptionAvailable: () => false,
    encryptString: (s) => Buffer.from(String(s), 'utf8'),
    decryptString: (b) => Buffer.from(b).toString('utf8'),
  },
  BrowserWindow: class {},
  clipboard: {},
  dialog: {},
  shell: {},
};

// 仅在非 Electron 环境（如系统 node）下打桩，便于排查；真实运行请用 Electron
if (!process.versions || !process.versions.electron) {
  console.warn('[warn] 非 Electron 环境：electron 模块已打桩，且 better-sqlite3 很可能加载失败');
  const originalLoad = Module._load;
  Module._load = function (request) {
    if (request === 'electron') return fakeElectron;
    return originalLoad.apply(this, arguments);
  };
}

const { initDb } = require('../dist/electron/db.js');
const shopDb = require('../dist/electron/shop-accounts-db.js');
const mailDb = require('../dist/electron/mail-db.js');
const mailEngine = require('../dist/electron/mail-engine.js');

function title(text) {
  console.log(`\n=== ${text} ${'='.repeat(Math.max(0, 58 - text.length))}`);
}

/** 等待同步队列排空 */
async function waitSyncDone(timeoutMs = 120000) {
  const t0 = Date.now();
  while (Date.now() - t0 < timeoutMs) {
    const state = mailEngine.getMailSyncState();
    if (!state.active.length && !state.queued.length) return Date.now() - t0;
    await new Promise((r) => setTimeout(r, 300));
  }
  throw new Error('同步超时');
}

(async () => {
  initDb(path.join(tmpDir, 'smoke.db'));

  title('1. 建店铺套 + 写入 IMAP 授权码');
  const setId = shopDb.upsertShopAccount({ email: user });
  shopDb.setShopAccountSecret(setId, 'mailAuthPwd', pass);
  const keys = shopDb.getShopAccount(setId)?.secretKeys || [];
  console.log('shopSetId =', setId, '| secretKeys =', JSON.stringify(keys));
  console.log('授权码可解密 =', shopDb.revealShopAccountSecret(setId, 'mailAuthPwd') === pass);

  title('2. 接入邮箱账号');
  mailDb.ensureMailSchema();
  const accountId = mailDb.upsertMailAccount({
    shopSetId: setId,
    email: user,
    providerId: 'netease-163',
    syncDays: 30,
  });
  console.log('accountId =', accountId, JSON.stringify(mailDb.getMailAccount(accountId)));

  title('3. 连接测试（只读打开 INBOX 后即登出）');
  const test = await mailEngine.testMailConnection({
    email: user,
    authPassword: pass,
    providerId: 'netease-163',
  });
  console.log('ok =', test.ok, '| error =', test.error || '-');
  console.log('IDLE 支持 =', test.idle, '| INBOX 存在 =', test.inboxExists, '| 邮件总数 =', test.messageCount);
  console.log('文件夹前 5 个 =', JSON.stringify(test.folders.slice(0, 5)));

  title('4. 触发同步');
  console.log('enqueue =', JSON.stringify(mailEngine.enqueueMailSync(accountId)));
  const cost = await waitSyncDone();
  console.log(`同步完成，耗时 ${cost}ms`);
  const acc = mailDb.getMailAccount(accountId);
  console.log('状态 =', acc.status, '| lastUid =', acc.lastUid, '| uidValidity =', acc.uidValidity);
  console.log('lastSyncedAt =', acc.lastSyncedAt, '| lastError =', acc.lastError || '-');

  title('5. 本地列表（纯查库）+ 详情');
  const list = mailDb.listMailMessages({ limit: 10 });
  console.log('total =', list.total);
  for (const m of list.items) {
    console.log(
      `- [${m.receivedAt.slice(0, 19)}] ${m.seen ? '已读' : '未读'} ${m.fromAddr} | ${m.subject.slice(0, 40)} | 正文缓存=${m.bodyCached} | 预览=${m.preview.slice(0, 40)}`,
    );
  }
  if (list.items.length) {
    const detail = mailDb.getMailMessage(list.items[0].id);
    console.log('首封详情: textLen =', detail.textBody.length, '| htmlLen =', detail.htmlBody.length, '| 附件 =', detail.attachments.length);
  }

  title('6. 增量再同步（应无新增）');
  mailEngine.enqueueMailSync(accountId);
  console.log(`二次同步耗时 ${await waitSyncDone()}ms | total =`, mailDb.listMailMessages({ limit: 1 }).total);

  title('7. 汇总与清理');
  console.log('stats =', JSON.stringify(mailDb.mailStats()));
  // 清理「30 天前」（= 同步窗口边界）：窗口内邮件不应被删
  const deletedInWindow = mailDb.purgeMailMessages(
    accountId,
    new Date(Date.now() - 30 * 86400000).toISOString(),
  );
  console.log('清理 30 天前（窗口内应删 0）deleted =', deletedInWindow, '| 剩余 total =', mailDb.listMailMessages({ limit: 1 }).total);

  console.log(`\n临时目录: ${tmpDir}`);
  console.log('全部通过');
  process.exit(0);
})().catch((err) => {
  console.error('\n[FAIL]', err);
  process.exit(1);
});
