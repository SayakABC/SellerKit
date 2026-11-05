// scripts/mail-todo-ui-smoke.mjs
// 「邮件 · 待办」假桥无头冒烟：build 产物 + 无头 Chrome，不启动宿主。
//
//   npm run mail:ui
//
// 为什么需要它（2026-11-04）：
//   待办这件事的失败**全是静默的** —— 数据在主进程算对了、DOM 里没画出来，界面照样一片正常：
//   ① `todoActions` 是 computed（severity>=2），拼漏一道 filter 就变成"待办区永远空"；
//   ② 邮件列表默认收起靠 `listCollapsed`，写反了就是"待办区在上面、流水通知照样刷屏"；
//   ③ 点待办要真的打开那封邮件（调 mailMessageGet），只改高亮不加载正文也看不出来。
//   纯函数与 SQL 由 tests/mailTriage.spec.ts + 真库验收守；这个文件只守"画不画得出来、点得动吗"。
//
// 做法与 nav-badge-ui-smoke 同款：假桥（Proxy 兜底）→ 本地 HTTP → 无头 Chrome → 抓 #smoke-result。
// ⚠️ 注入脚本里的注释不能含反引号（`npm run verify` 的 check-smoke-injection 会拦）。

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'renderer');
const WORK = path.join('/tmp', 'sellerkit-mail-todo-smoke');
const PORT = 8134;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error('✗ 找不到构建产物 ' + DIST + '/index.html —— 先跑 npm run build');
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error('✗ 找不到无头 Chrome：' + CHROME);
  process.exit(1);
}

// 假桥：账号 1 个、邮件 2 封（列表）、待办 3 单（2 单要动手 + 1 单已了结）。
// ⚠️ on* 键返回**退订函数**（不是 { success, data } 信封），与真实 preload 保持同构。
const FAKE_BRIDGE = `<script>
(function () {
  var NOW = Date.now();
  function iso(hoursAgo) { return new Date(NOW - hoursAgo * 3600 * 1000).toISOString(); }

  var ACCOUNTS = [{ id: 1, shopId: 1, email: 'shop@example.com', status: 'idle', lastSyncedAt: iso(1) }];
  // 三条 13/14/11 都属于订单 1123236682794896（罚单那一单的历史往来）：
  // 时间线上必须按时间升序排成 3 个 chip，点第 1 个要换成 13 而**不换单**。
  var MESSAGES = [
    { id: 11, accountId: 1, accountEmail: 'shop@example.com', folder: 'INBOX', uid: 11,
      subject: '违背发货承诺订单预扣罚单待处理', fromName: 'AliExpress', fromAddr: 'info@aliexpress.com',
      toJson: '[]', ccJson: '[]', receivedAt: iso(2), size: 2048, seen: true, flagged: false,
      hasAttachment: false, bodyCached: true, preview: '您有一笔订单成交不卖的预处罚单待申诉', createdAt: iso(2), readAt: iso(1), read: true },
    { id: 12, accountId: 1, accountEmail: 'shop@example.com', folder: 'INBOX', uid: 12,
      subject: 'Resolution for Order 3077090273647695', fromName: 'AliExpress', fromAddr: 'info@aliexpress.com',
      toJson: '[]', ccJson: '[]', receivedAt: iso(30), size: 2048, seen: true, flagged: false,
      hasAttachment: false, bodyCached: true, preview: '订单号3077090273647695的请求已处理完毕', createdAt: iso(30), readAt: iso(28), read: true },
    { id: 13, accountId: 1, accountEmail: 'shop@example.com', folder: 'INBOX', uid: 13,
      subject: '罚单通知：订单 1123236682794896', fromName: 'AliExpress', fromAddr: 'info@aliexpress.com',
      toJson: '[]', ccJson: '[]', receivedAt: iso(6), size: 2048, seen: true, flagged: false,
      hasAttachment: false, bodyCached: true, preview: '已对订单 1123236682794896 发出违规通知', createdAt: iso(6), readAt: iso(5), read: true },
    { id: 14, accountId: 1, accountEmail: 'shop@example.com', folder: 'INBOX', uid: 14,
      subject: '我们已收到你的申诉', fromName: 'AliExpress', fromAddr: 'info@aliexpress.com',
      toJson: '[]', ccJson: '[]', receivedAt: iso(4), size: 2048, seen: true, flagged: false,
      hasAttachment: false, bodyCached: true, preview: '申诉已受理，48 小时内完成审核', createdAt: iso(4), readAt: iso(3), read: true },
  ];
  var TODOS = [
    { orderNo: '1123236682794896', orderNoSource: 'subject', kind: 'penalty',
      label: '罚单待申诉（有申诉期）', severity: 3, messageId: 11,
      subject: '违背发货承诺订单预扣罚单待处理', receivedAt: iso(2), accountId: 1,
      accountEmail: 'shop@example.com',
      events: [
        { messageId: 13, label: '罚单通知', kind: 'penalty', severity: 3, receivedAt: iso(6),
          subject: '罚单通知：订单 1123236682794896' },
        { messageId: 14, label: '申诉已受理', kind: 'penalty', severity: 2, receivedAt: iso(4),
          subject: '我们已收到你的申诉' },
        { messageId: 11, label: '罚单待申诉（有申诉期）', kind: 'penalty', severity: 3, receivedAt: iso(2),
          subject: '违背发货承诺订单预扣罚单待处理' }
      ] },
    { orderNo: '3077090273647695', orderNoSource: 'body', kind: 'dispute',
      label: '客诉请求已处理', severity: 2, messageId: 12,
      subject: 'Resolution for Order 3077090273647695', receivedAt: iso(30), accountId: 1,
      accountEmail: 'shop@example.com',
      events: [{ messageId: 12, label: '客诉请求已处理', kind: 'dispute', severity: 2,
        receivedAt: iso(30), subject: 'Resolution for Order 3077090273647695' }] },
    { orderNo: '3077947352804002', orderNoSource: 'subject', kind: 'closed',
      label: '订单已关闭（协议取消）', severity: 1, messageId: 13,
      subject: '订单3077947352804002关闭', receivedAt: iso(50), accountId: 1,
      accountEmail: 'shop@example.com',
      events: [{ messageId: 13, label: '订单已关闭（协议取消）', kind: 'closed', severity: 1,
        receivedAt: iso(50), subject: '订单3077947352804002关闭' }] },
  ];

  window.__detailCalls = [];
  // 划掉/恢复的调用记录 + 内存态：划掉后下一次 mailTodoList 真的返回 dismissed=true，
  // 这样断言的是"界面按主进程给的状态重画"，而不是只看按钮点得动。
  window.__dismissCalls = [];
  var DISMISSED = {};

  function todosNow() {
    return TODOS.map(function (t) {
      var d = !!DISMISSED[t.orderNo];
      return Object.assign({}, t, { dismissed: d, dismissedAt: d ? iso(1) : '', resurfaced: false });
    });
  }

  var OVERRIDES = {
    getAppVersion: function () { return '0.0.0-smoke'; },
    mailDbEnsure: function () { return { ok: true }; },
    mailAccountList: function () { return ACCOUNTS; },
    mailProviderList: function () { return []; },
    mailStats: function () { return { accounts: 1, messages: 1423, unread: 0, lastSyncedAt: iso(1), folders: [] }; },
    mailMessagesList: function () { return { items: MESSAGES, total: 1423 }; },
    mailTodoList: function () {
      var items = todosNow();
      var dis = items.filter(function (i) { return i.dismissed; }).length;
      return { items: items, orders: items.length - dis, dismissed: dis, mails: 3, unattributed: 0 };
    },
    mailTodoDismiss: function (p) {
      window.__dismissCalls.push({ key: p && p.key, messageId: p && p.messageId, kind: p && p.kind });
      DISMISSED[(p && p.key) || ''] = true;
      return { dismissed: true, key: p && p.key };
    },
    mailTodoRestore: function (p) {
      window.__dismissCalls.push({ key: p && p.key, restore: true });
      delete DISMISSED[(p && p.key) || ''];
      return { restored: 1 };
    },
    mailMessageGet: function (p) {
      window.__detailCalls.push(p && p.id);
      var m = MESSAGES.filter(function (x) { return x.id === (p && p.id); })[0] || MESSAGES[0];
      return { id: m.id, subject: m.subject, fromName: m.fromName, fromAddr: m.fromAddr,
        toJson: '[]', ccJson: '[]', accountEmail: m.accountEmail, receivedAt: m.receivedAt,
        size: m.size, seen: m.seen, read: true, readAt: m.readAt, htmlBody: '<p>body</p>',
        textBody: '', truncated: false, bodyCached: true, attachments: [] };
    },
    mailMessageRead: function () { return { changed: 0, unread: 0 }; },
    mailFoldersList: function () { return []; },
    mailSyncState: function () { return { active: [], queued: [] }; },
    mailAutoSyncConfig: function (p) { return { minutes: (p && p.minutes) || 0 }; },
    mailFtsStatus: function () { return { ready: false, indexed: 0 }; },
    mailCacheStatus: function () { return { files: 0, bytes: 0 }; },
    onMailSyncEvent: function () { return function () {}; },
    onNavBadge: function () { return function () {}; },
    onOpenModule: function (cb) { window.__openCb = cb; return function () {}; },
  };

  // 模拟"响应乱序"：id=13 那封故意晚 400ms 返回（虚拟时间足够让后点的 11 先到）。
  // 没有这一条，store 里"丢弃过期响应"的守卫就不可测 —— 而它的失效表现是
  // "点 A 显示 B"，不报错、不看前后两步就发现不了。
  var SLOW_MS = { 13: 400 };

  window.electronAPI = new Proxy({}, {
    get: function (_t, key) {
      if (typeof key !== 'string') return undefined;
      var fn = OVERRIDES[key];
      if (fn) {
        if (/^on[A-Z]/.test(key)) return function () { return fn.apply(null, arguments); };
        return function (p) {
          var data = fn(p);
          var ms = (key === 'mailMessageGet' && p && SLOW_MS[p.id]) || 0;
          return new Promise(function (res) {
            setTimeout(function () { res({ success: true, data: data }); }, ms);
          });
        };
      }
      if (/^on[A-Z]/.test(key)) return function () { return function () {}; };
      return function () { return Promise.resolve({ success: true, data: null }); };
    },
  });

  window.__smokeErrors = [];
  window.addEventListener('error', function (e) { window.__smokeErrors.push(String((e && e.message) || e)); });
  window.addEventListener('unhandledrejection', function (e) { window.__smokeErrors.push('rejection: ' + String((e && e.reason) || e)); });
})();
</script>`;

const ASSERT_SCRIPT = `<script type="module">
var lines = [];
function report(name, ok, detail) { lines.push((ok ? 'PASS ' : 'FAIL ') + name + (detail ? ' | ' + detail : '')); }
function sleep(ms) { return new Promise(function (r) { setTimeout(r, ms); }); }
async function settle(fn, ms) {
  var t0 = Date.now();
  while (!fn() && Date.now() - t0 < (ms || 3000)) await sleep(50);
}
function flat(el) { return el ? el.textContent.replace(/\\s+/g, ' ').trim() : ''; }
function all(sel) { return Array.prototype.slice.call(document.querySelectorAll(sel)); }
function panel() { return document.querySelector('[data-act="mail-todo-panel"]'); }
// 计数徽标在左栏标题行（不在队列容器内）—— 它属于"这块视图"，不属于"这一列行"
function todoNum() { return flat(document.querySelector('[data-act="mail-todo-count"]')); }
function rows() { return panel() ? Array.prototype.slice.call(panel().querySelectorAll('.todo-row')) : []; }
function mailList() { return document.querySelector('.mail-list'); }
function detailTitle() { var h = document.querySelector('.detail-head h3'); return flat(h); }
function clickText(sel, needle) {
  var els = Array.prototype.slice.call(document.querySelectorAll(sel));
  for (var i = 0; i < els.length; i++) {
    if (flat(els[i]).indexOf(needle) >= 0) { els[i].click(); return true; }
  }
  return false;
}

async function main() {
  // 进「邮件」模块：默认模块不一定是它
  await settle(function () { return typeof window.__openCb === 'function'; }, 8000);
  window.__openCb({ moduleId: 'mail' });
  await settle(function () { return !!panel(); }, 8000);

  // ---- ① 待办区出现，且只数"要动手的"（severity>=2 → 2 单，不是 3 单） ----
  report('待办区渲染出来了', !!panel());
  report('待办只数要动手的（2 单，不含已了结）', todoNum().indexOf('2') === 0,
    todoNum());
  report('默认只画 2 行（severity=1 的折起来）', rows().length === 2, 'rows=' + rows().length);

  // ---- ② 紧急度靠竖条 + 类型徽标，不靠文字猜 ----
  var r0 = rows()[0] || null;
  report('最高紧急度行带 sev3（有期限）', !!r0 && String(r0.className).indexOf('sev3') >= 0,
    r0 ? String(r0.className) : 'no-row');
  report('罚单行有「罚单」类型徽标', !!r0 && flat(r0.querySelector('.todo-kind')) === '罚单',
    r0 ? flat(r0.querySelector('.todo-kind')) : '');
  report('行内显示订单号原文', !!r0 && flat(r0.querySelector('.todo-order')) === '1123236682794896',
    r0 ? flat(r0.querySelector('.todo-order')) : '');

  // ---- ③ 两个视图（不是上下堆叠，也不是"折叠列表让位"） ----
  report('默认落在待办视图（有待办时不先给流水）', mailList() === null, 'mail-list=' + !!mailList());
  var toMail = document.querySelector('[data-act="mail-mode-mail"]');
  report('有「全部邮件」切换入口', !!toMail, toMail ? flat(toMail) : 'missing');
  if (toMail) toMail.click();
  await settle(function () { return all('.mail-list .mail-item').length === 4; }, 4000);
  report('切到「全部邮件」后列表出现（4 封）', all('.mail-list .mail-item').length === 4,
    'rows=' + all('.mail-list .mail-item').length);
  report('切到全部邮件后待办队列让位（同一块位置，不是上下堆叠）', !panel());
  var toTodo = document.querySelector('[data-act="mail-mode-todo"]');
  if (toTodo) toTodo.click();
  await settle(function () { return !!panel() && rows().length === 2; }, 4000);
  report('切回待办：队列与计数都回来', rows().length === 2, 'rows=' + rows().length);

  // ---- ④ 点待办 = 真的打开那封邮件（不是只高亮） ----
  var before = (window.__detailCalls || []).length;
  rows()[0].click();
  await settle(function () { return (window.__detailCalls || []).length > before; }, 4000);
  await settle(function () { return detailTitle().length > 0; }, 4000);
  report('点待办触发 mailMessageGet(11)', (window.__detailCalls || [])[before] === 11,
    JSON.stringify(window.__detailCalls));
  report('右侧详情换成了该单的邮件', detailTitle().indexOf('罚单待处理') >= 0, detailTitle());

  // ---- ⑤ 同一单的多封邮件：时间线可切换，且**不换单** ----
  var thread = document.querySelector('[data-act="mail-todo-thread"]');
  report('同一单 3 封 ⇒ 出现邮件时间线', !!thread);
  var chips = thread ? Array.prototype.slice.call(thread.querySelectorAll('.chip')) : [];
  report('时间线按时间升序（13 → 14 → 11）',
    chips.map(function (c) { return c.getAttribute('data-msg-id'); }).join(',') === '13,14,11',
    chips.map(function (c) { return c.getAttribute('data-msg-id'); }).join(','));
  report('最新那封是当前选中', chips.length === 3 && String(chips[2].className).indexOf('on') >= 0,
    chips.length ? String(chips[2].className) : 'no-chip');
  var orderText = flat(document.querySelector('.doc-order'));
  var dcBefore = (window.__detailCalls || []).length;
  if (chips[0]) chips[0].click();
  await settle(function () { return (window.__detailCalls || []).length > dcBefore; }, 4000);
  report('点时间线第 1 封 ⇒ 载入那封（13）', (window.__detailCalls || [])[dcBefore] === 13,
    JSON.stringify(window.__detailCalls));
  report('换邮件不换单（单据头仍是同一张单）', flat(document.querySelector('.doc-order')) === orderText,
    flat(document.querySelector('.doc-order')) + ' vs ' + orderText);
  report('同一单历史邮件不再是"看不见的死数据"', chips.length === 3, 'chips=' + chips.length);

  // ---- ⑤b 连点两封（前慢后快）：后到的旧响应不得盖掉新选中那封 ----
  if (chips[0] && chips[2]) {
    chips[0].click(); // 13，桩里故意慢 400ms
    chips[2].click(); // 11，立即返回
    await sleep(900);
    report('响应乱序时以最后一次点击为准（不会"点 11 显示 13"）',
      detailTitle().indexOf('罚单待处理') >= 0, detailTitle());
  }

  // ---- ⑥ 已了结的单可以摊开看，但不会混进"要动手"的计数 ----
  clickText('.todo-more', '另有');
  await settle(function () { return rows().length === 3; }, 3000);
  report('摊开已了结后多出 1 行', rows().length === 3, 'rows=' + rows().length);
  report('已了结行是 sev1（灰色竖条）', !!rows()[2] && String(rows()[2].className).indexOf('sev1') >= 0,
    rows()[2] ? String(rows()[2].className) : '');
  report('已了结不计入"待办 N 单"', todoNum().indexOf('2') === 0,
    todoNum());

  // ---- ⑦ 划掉：真的发 IPC（带订单号 + 水位线 messageId），并自动接到下一条 ----
  var dismissBtn = rows()[0] && rows()[0].querySelector('[data-act="mail-todo-dismiss"]');
  report('每行有「已处理」入口', !!dismissBtn);
  if (dismissBtn) dismissBtn.click();
  await settle(function () { return (window.__dismissCalls || []).length > 0; }, 4000);
  var dc = (window.__dismissCalls || [])[0] || {};
  report('点「已处理」调 mailTodoDismiss 并带订单号', dc.key === '1123236682794896', JSON.stringify(dc));
  report('划掉时带最新邮件 id（水位线，不能是 0）', dc.messageId === 11, String(dc.messageId));
  // 旧版这里断言"不会打开正文"；改版后**会**打开下一条 —— 判据改成"打开的是下一条，不是被划掉那条"
  await settle(function () {
    var c = window.__detailCalls || [];
    return c[c.length - 1] === 12;
  }, 4000);
  report('划掉后自动切到下一条（打开 12，而不是停在刚划掉的那封）',
    (window.__detailCalls || [])[(window.__detailCalls || []).length - 1] === 12,
    JSON.stringify(window.__detailCalls));
  await settle(function () {
    return todoNum().indexOf('1') === 0;
  }, 4000);
  report('划掉后待办数字 2 → 1（按主进程重算，不是本地 -1 占位）',
    todoNum().indexOf('1') === 0,
    todoNum());

  // ---- ⑧ 撤销：提示条上的「撤销」要真的调 mailTodoRestore 并把行放回来 ----
  var undoBtn = document.querySelector('[data-act="toast-action"]');
  report('划掉后给出「撤销」入口（不是只能去已划掉里翻）', !!undoBtn, undoBtn ? flat(undoBtn) : 'missing');
  if (undoBtn) undoBtn.click();
  await settle(function () {
    return (window.__dismissCalls || []).some(function (c) { return c.restore === true; });
  }, 4000);
  var rc0 = (window.__dismissCalls || []).filter(function (c) { return c.restore === true; })[0] || {};
  report('点「撤销」调 mailTodoRestore 并带同一个订单号',
    rc0.key === '1123236682794896', JSON.stringify(rc0));
  await settle(function () {
    return todoNum().indexOf('2') === 0;
  }, 4000);
  report('撤销后待办数字回到 2',
    todoNum().indexOf('2') === 0,
    todoNum());

  // ---- ⑨ 已划掉的仍能从列表里展开、能恢复（划错了不该变成永久静默） ----
  var dismissBtn2 = rows()[0] && rows()[0].querySelector('[data-act="mail-todo-dismiss"]');
  if (dismissBtn2) dismissBtn2.click();
  await settle(function () {
    return todoNum().indexOf('1') === 0;
  }, 4000);
  var dToggle = document.querySelector('[data-act="mail-todo-dismissed-toggle"]');
  report('出现「已划掉 N 单」入口', !!dToggle, dToggle ? flat(dToggle) : '');
  if (dToggle) dToggle.click();
  await settle(function () { return !!document.querySelector('[data-act="mail-todo-dismissed"]'); }, 4000);
  report('展开后能看到被划掉的行', !!document.querySelector('[data-act="mail-todo-dismissed"]'));
  var restoreBtn = document.querySelector('[data-act="mail-todo-restore"]');
  report('被划掉的行有「恢复」按钮', !!restoreBtn);
  if (restoreBtn) restoreBtn.click();
  await settle(function () {
    return todoNum().indexOf('2') === 0;
  }, 4000);
  report('从列表里恢复后待办数字回到 2',
    todoNum().indexOf('2') === 0,
    todoNum());

  // ---- ⑩ 搜索是「全部邮件」视图的事：待办队列不占这块位置 ----
  var toMail2 = document.querySelector('[data-act="mail-mode-mail"]');
  if (toMail2) toMail2.click();
  await settle(function () { return !panel(); }, 3000);
  var input = document.querySelector('.search-box input');
  report('切到全部邮件后有搜索框', !!input);
  if (input) {
    input.value = '罚单';
    input.dispatchEvent(new Event('input', { bubbles: true }));
  }
  await settle(function () { return all('.mail-list .mail-item').length > 0; }, 4000);
  report('搜索时待办队列不占位置（结果直接占满这一栏）', !panel() && !!mailList());

  report('无未捕获错误', (window.__smokeErrors || []).length === 0, JSON.stringify(window.__smokeErrors || []));
  finish();
}

function finish() {
  var failed = lines.some(function (l) { return l.indexOf('FAIL') === 0; });
  lines.push(failed ? 'SMOKE: FAILED' : 'SMOKE: ALL PASS');
  var pre = document.createElement('pre');
  pre.id = 'smoke-result';
  pre.textContent = lines.join('\\n');
  document.body.appendChild(pre);
}

main().catch(function (e) {
  lines.push('FAIL 脚本异常 | ' + String((e && e.message) || e));
  finish();
});
</script>`;

rmSync(WORK, { recursive: true, force: true });
mkdirSync(WORK, { recursive: true });
cpSync(DIST, WORK, { recursive: true });
const indexPath = path.join(WORK, 'index.html');
let html = readFileSync(indexPath, 'utf8');
html = html.replace(/<meta\s+http-equiv="Content-Security-Policy"[^>]*>/i, '');
html = html.replace('</head>', () => FAKE_BRIDGE + '</head>');
html = html.replace('</body>', () => ASSERT_SCRIPT + '</body>');
writeFileSync(indexPath, html);

const MIME = {
  '.html': 'text/html',
  '.js': 'text/javascript',
  '.css': 'text/css',
  '.json': 'application/json',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
};
const server = http.createServer((req, res) => {
  const rel = decodeURIComponent((req.url || '/').split('?')[0]);
  const file = path.join(WORK, rel === '/' ? '/index.html' : rel);
  if (!file.startsWith(WORK)) {
    res.writeHead(403);
    res.end('forbidden');
    return;
  }
  try {
    const buf = readFileSync(file);
    res.writeHead(200, { 'Content-Type': MIME[path.extname(file)] || 'application/octet-stream' });
    res.end(buf);
  } catch {
    res.writeHead(404);
    res.end('not found');
  }
});
await new Promise((resolve) => server.listen(PORT, '127.0.0.1', resolve));

const dom = await new Promise((resolve, reject) => {
  const cp = spawn(CHROME, [
    '--headless=new',
    '--disable-gpu',
    '--no-sandbox',
    '--window-size=1440,900',
    '--virtual-time-budget=60000',
    '--dump-dom',
    'http://127.0.0.1:' + PORT + '/index.html',
  ]);
  let out = '';
  cp.stdout.on('data', (d) => (out += String(d)));
  cp.on('error', reject);
  cp.on('close', () => resolve(out));
});
server.close();

const m = dom.match(/id="smoke-result"[^>]*>([\s\S]*?)<\/pre>/);
if (!m) {
  console.error(
    '✗ 没抓到 #smoke-result（页面可能没挂载）。排查：产物新鲜度（npm run build）→ 资源 404 → 内联脚本语法错 → 假桥缺键'
  );
  process.exit(1);
}
const out = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
console.log(out);
const ok = out.split('\n').pop() === 'SMOKE: ALL PASS';
console.log(ok ? '\n✓ 邮件待办 UI 冒烟通过' : '\n✗ 邮件待办 UI 冒烟失败');
process.exit(ok ? 0 : 1);
