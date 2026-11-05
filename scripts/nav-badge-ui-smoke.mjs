// scripts/nav-badge-ui-smoke.mjs
// 侧栏徽标 + 「点通知切模块」的假桥无头冒烟（build 产物 + 无头 Chrome，不启动宿主）。
//
//   npm run nav:ui
//
// 为什么需要它（2026-11-04）：
//   这两件事的失败方式**全是静默的** —— 没有异常、没有红色日志，只有"侧栏没有数字"和
//   "点了通知还停在原来那页"：
//   ① 主进程在 did-finish-load 重放徽标（`electron/ui-bridge.ts`），渲染层若晚一步注册监听就收不到；
//      这一条由 `tests/navBadgeWiring.spec.ts` 的静态断言守着（订阅必须早于 onMounted 里的第一个 await）。
//   ② 收到之后**画不画得出来**只有真渲染才知道：`navRows` 是 computed，模块行的徽标字段一旦忘了
//      拼进去，数据在、DOM 里没有 —— 这个文件就是钉这一层。
//   ③ `count: null` 必须**撤掉徽标**，不能退化成画一个 0（"没事了"和"还有 0 件"是两回事）。
//
// 做法与 master-data:ui / today:ui 同款：假桥（Proxy 兜底）→ 本地 HTTP → 无头 Chrome → 抓 #smoke-result。
// ⚠️ 注入脚本里的注释不能含反引号（`verify` 的 check-smoke-injection 会拦）；改完 node --check。

import { spawn } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const DIST = path.join(ROOT, 'dist', 'renderer');
const WORK = path.join('/tmp', 'sellerkit-nav-badge-smoke');
const PORT = 8133;
const CHROME = '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';

if (!existsSync(path.join(DIST, 'index.html'))) {
  console.error(`✗ 找不到构建产物 ${DIST}/index.html —— 先跑 npm run build`);
  process.exit(1);
}
if (!existsSync(CHROME)) {
  console.error(`✗ 找不到无头 Chrome：${CHROME}`);
  process.exit(1);
}

// 假桥：只为让外壳与「邮件」页能挂起来。
// ⚠️ `on*` 键必须单独处理 —— 真实 preload 返回的是**退订函数**，不是 { success, data } 信封；
//    套进信封的话 AppShell 拿到的是 Promise，注册副作用照样发生（断言会假绿），
//    卸载时的 stopNavBadge?.() 却会抛 —— 夹具在结构层就错了。
const FAKE_BRIDGE = `<script>
(function () {
  window.__badgeCb = null;
  window.__openCb = null;

  var OVERRIDES = {
    getAppVersion: function () { return '0.0.0-smoke'; },
    mailDbEnsure: function () { return { ok: true }; },
    mailAccountList: function () { return []; },
    mailProviderList: function () { return []; },
    mailStats: function () { return { accounts: 0, messages: 0, unread: 0, lastSyncedAt: '', folders: [] }; },
    mailMessagesList: function () { return { items: [], total: 0 }; },
    mailSyncState: function () { return { active: [], queued: [] }; },
    mailAutoSyncConfig: function (p) { return { minutes: (p && p.minutes) || 0 }; },
    mailFtsStatus: function () { return { ready: false, indexed: 0 }; },
    mailCacheStatus: function () { return { files: 0, bytes: 0 }; },
    onNavBadge: function (cb) { window.__badgeCb = cb; return function () {}; },
    onOpenModule: function (cb) { window.__openCb = cb; return function () {}; },
  };

  window.electronAPI = new Proxy({}, {
    get: function (_t, key) {
      if (typeof key !== 'string') return undefined;
      var fn = OVERRIDES[key];
      if (fn) {
        if (/^on[A-Z]/.test(key)) return function () { return fn.apply(null, arguments); };
        return function () { return Promise.resolve({ success: true, data: fn.apply(null, arguments) }); };
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
/** 有界等待：超时**不抛**，判定留给紧随其后的 report（抛了就没结果输出了） */
async function settle(fn, ms) {
  var t0 = Date.now();
  while (!fn() && Date.now() - t0 < (ms || 3000)) await sleep(50);
}
function flat(el) { return el ? el.textContent.replace(/\\s+/g, ' ').trim() : ''; }
function navBtn() { return document.querySelector('[data-act="nav-mail"]'); }
/** 模块行里的徽标（圆角数字气泡）；没有就是 null —— 断言"不渲染"靠它 */
function badgeEl() {
  var btn = navBtn();
  if (!btn) return null;
  var spans = btn.querySelectorAll('span');
  for (var i = 0; i < spans.length; i++) {
    if (String(spans[i].className || '').indexOf('rounded-full') >= 0) return spans[i];
  }
  return null;
}
/** 模拟主进程的 nav-badge 广播（真 preload 会做同样的裁剪，这里只给已裁剪值的形状） */
function pushBadge(payload) { if (window.__badgeCb) window.__badgeCb(payload); }
function pushOpen(payload) { if (window.__openCb) window.__openCb(payload); }
function activeIsMail() {
  var btn = navBtn();
  return !!btn && String(btn.className || '').indexOf('primary-soft') >= 0;
}

async function main() {
  // ---- ① 外壳挂起来了，且「邮件」入口在侧栏 ----
  await settle(function () { return !!navBtn(); }, 8000);
  report('侧栏有「邮件」入口', !!navBtn());
  report('渲染层注册了 nav-badge 订阅', typeof window.__badgeCb === 'function');
  report('渲染层注册了 open-module 订阅', typeof window.__openCb === 'function');

  // ---- ② 初始无徽标：没数就是**不画**，不是画 0 ----
  report('初始不渲染徽标（不是 0）', badgeEl() === null, badgeEl() ? 'text=' + flat(badgeEl()) : '');

  // ---- ③ 收到未读 → 真的画出来，且是待办色 ----
  pushBadge({ moduleId: 'mail', count: 7, title: '7 封未读邮件', todo: true });
  await settle(function () { return !!badgeEl(); }, 3000);
  var b = badgeEl();
  report('推送未读 7 → 侧栏出现徽标', !!b && flat(b) === '7', b ? 'text=' + flat(b) : 'no-badge');
  report('徽标悬停说明来自主进程', !!b && (b.getAttribute('title') || '') === '7 封未读邮件',
    b ? 'title=' + (b.getAttribute('title') || '') : '');
  report('待办徽标用警示色', !!b && String(b.className).indexOf('wb-warning') >= 0,
    b ? String(b.className) : '');

  // ---- ④ count:null = 撤掉（这一条坏了的表现是"未读清空了但角标还挂着 0"） ----
  pushBadge({ moduleId: 'mail', count: null });
  await settle(function () { return badgeEl() === null; }, 3000);
  report('推送 count:null → 徽标被撤掉（不画 0）', badgeEl() === null);

  // ---- ⑤ 未登记模块的徽标不渲染，也不该报错 ----
  var warnBefore = warningBadges();
  pushBadge({ moduleId: 'no-such-module-xyz', count: 9 });
  await sleep(200);
  report('未登记模块的徽标不进侧栏', warningBadges() === warnBefore, 'before=' + warnBefore + ' after=' + warningBadges());

  // ---- ⑥ 点通知 = 切到「邮件」（旧行为只 show 窗口，用户还得自己找侧栏） ----
  // 先把落点挪开：默认的"恢复上次模块"在干净 profile 下可能恰好就是邮件，
  // 那样下面这条断言会**恒绿**（没验到任何东西）。
  if (activeIsMail()) {
    pushOpen({ moduleId: 'today' });
    await settle(function () { return !activeIsMail(); }, 6000);
  }
  report('切之前不在「邮件」（保证下面不是恒绿）', !activeIsMail());
  pushOpen({ moduleId: 'mail' });
  await settle(function () { return activeIsMail(); }, 6000);
  report('open-module 切换到「邮件」模块', activeIsMail());
  await settle(function () { return (document.body.innerText || '').indexOf('邮件') >= 0; }, 4000);
  report('邮件页真的渲染出来了', (document.body.innerText || '').indexOf('收件箱') >= 0
    || !!document.querySelector('.mv-view'), 'body 里找不到收件箱/mv-view');

  // ---- ⑦ 未知模块 id：停在原地，不许把用户扔到空白页 ----
  pushOpen({ moduleId: 'no-such-module-xyz' });
  await sleep(300);
  report('未知模块 id 不切走（仍停在邮件）', activeIsMail());

  // ---- ⑧ 带 action 的意图：外壳不吞掉它（模块自己监听 switch-module 消费） ----
  window.__switched = [];
  window.addEventListener('switch-module', function (e) {
    window.__switched.push({ moduleId: e.detail && e.detail.moduleId, action: e.detail && e.detail.action });
  });
  pushOpen({ moduleId: 'mail', action: 'unread' });
  await settle(function () { return window.__switched.length > 0; }, 4000);
  var sw = window.__switched[0] || {};
  report('带 action 的意图被转发成 switch-module', sw.action === 'unread' && sw.moduleId === 'mail',
    JSON.stringify(window.__switched));

  report('无未捕获错误', (window.__smokeErrors || []).length === 0, JSON.stringify(window.__smokeErrors || []));
  finish();
}

/** 侧栏里"待办色"的徽标个数（未登记模块的徽标不该让这个数变化） */
function warningBadges() { return document.querySelectorAll('nav [class*="wb-warning"]').length; }

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
    `http://127.0.0.1:${PORT}/index.html`,
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
    '✗ 没抓到 #smoke-result（页面可能没挂载）。排查：产物新鲜度（npm run build）→ 资源 404 → 内联脚本语法错 → 假桥缺键',
  );
  process.exit(1);
}
const out = m[1].replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>').trim();
console.log(out);
const ok = out.split('\n').pop() === 'SMOKE: ALL PASS';
console.log(ok ? '\n✓ 侧栏徽标 / 通知切模块冒烟通过' : '\n✗ 侧栏徽标 / 通知切模块冒烟失败');
process.exit(ok ? 0 : 1);
