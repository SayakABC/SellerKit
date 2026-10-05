// 邮件正文渲染通道（`sk-mail://`）端到端冒烟：真 handler + 真 SQLite + 真磁盘缓存，**不联网、不需凭据**。
//
//   npm run mail:body:smoke
//   # = tsc -p tsconfig.electron.json && electron scripts/mail-body-protocol-smoke.cjs
//   # 受限/沙箱环境（起不了 Chromium sandbox）加：--no-sandbox --disable-gpu
//
// 为什么不能只靠 `mail:inline:smoke`：那个脚本覆盖的是**数据层与纯函数**（补列、id 稳定性、HTML 改写）。
// 协议本身还有一堆只有真跑请求才暴露的东西 —— URL 路由解析（`sk-mail://body/<id>` 的 host 段）、
// 响应头（CSP 两态、content-type）、沙箱 iframe 里的子资源能不能取到、缺失附件是否只裂一张图。
// 这些在离线断言里全是盲区，而它们正是"用户到底能不能看到图"的判据。
//
// 关键设计：附件**预置磁盘缓存**后再请求 → resolveMailAttachment 命中缓存、不触网，故离线可跑；
// 同时用一个不存在的 attachmentId 做反向判别（必须 404），避免"200"这种断言恒绿空转。

const assert = require('assert');
const fs = require('fs');
const http = require('http');
const os = require('os');
const path = require('path');

const { app, protocol, BrowserWindow, net, session } = require('electron');

const ROOT = path.join(__dirname, '..');
const tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'sk-mail-body-smoke-'));
app.setPath('userData', tmpDir);

const { registerMailBodyScheme, initMailBodyProtocol } = require(
  path.join(ROOT, 'dist', 'electron', 'mail-body-protocol.js'),
);
registerMailBodyScheme();
// 冒烟自己的"宿主页面"来源：模拟 `sk-plugin://` + 岛 CSP
protocol.registerSchemesAsPrivileged([{ scheme: 'sk-host', privileges: { standard: true, secure: true } }]);

/**
 * 宿主页 CSP 直接取**真值**（`plugin-ui-protocol.ts` 导出的 UI_CSP），不在这里抄副本 ——
 * 抄一份的话，哪天 `frame-src sk-mail:` 被误删，本冒烟的 iframe 断言会因为用的是副本而恒绿。
 */
const { UI_CSP: HOST_CSP } = require(path.join(ROOT, 'dist', 'electron', 'plugin-ui-protocol.js'));

/**
 * 岛自带的那层 CSP（第二层）：直接读岛的真实 `index.html`，不抄副本 ——
 * 抄一份的话，岛那边把 `frame-src sk-mail:` 删了，本冒烟会因为用的是副本而恒绿（真事故就发生在这一层）。
 * ⚠️ content 取值必须按**引号配对**：CSP 内容里全是单引号（'self'），写成 `[^"']*` 会在第一个 `'` 处截断。
 */
const ISLAND_META_CSP = (() => {
  const html = fs.readFileSync(path.join(ROOT, 'ui-plugins', 'shop-accounts', 'index.html'), 'utf8');
  const m = html.match(/http-equiv=["']Content-Security-Policy["'][^>]*content=(?:"([^"]*)"|'([^']*)')/i);
  return m ? m[1] ?? m[2] ?? '' : '';
})();

/** 1×1 透明 PNG：内容比对用，字节数固定（70） */
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8DwHwAFAAH/q842iQAAAABJRU5ErkJggg==',
  'base64',
);

const results = [];
function check(name, pass, extra = '') {
  results.push(pass);
  console.log(`  ${pass ? '✓' : '✗'} ${name}${extra ? '  ' + extra : ''}`);
}
function section(text) {
  console.log('\n' + text);
}

app.whenReady().then(async () => {
  let remoteServer;
  try {
    const { initDb, dbRun, dbQuery, dbGet } = require(path.join(ROOT, 'dist', 'electron', 'db.js'));
    const mailDb = require(path.join(ROOT, 'dist', 'electron', 'mail-db.js'));
    const mailCache = require(path.join(ROOT, 'dist', 'electron', 'mail-cache.js'));
    initDb(path.join(tmpDir, 'mail-body-smoke.db'));
    // 临时库里没有 sk_shop_sets（那是别的域的表）→ 关外键校验以便直接插账号行
    dbRun(`PRAGMA foreign_keys = OFF`);
    mailDb.ensureMailSchema();

    // ---- 远程图夹具：真起一个 http 服务，并通过**非 loopback 的 LAN IP** 访问 ----
    // 为什么不用 127.0.0.1：loopback 被视为「潜在可信来源」，Chromium 对它的混合内容检查直接豁免，
    // 于是「http 图在正文文档里能不能加载」这个真实问题会被静默测成恒绿。本项目 84/103 封邮件
    // 的正文图是 http:// —— 判据必须是不可信来源上的真请求。
    const served = [];
    remoteServer = http.createServer((req, res) => {
      served.push(req.url);
      if (req.url.startsWith('/ok.png')) {
        res.writeHead(200, { 'content-type': 'image/png' });
        res.end(PNG_1PX);
      } else {
        res.writeHead(404);
        res.end();
      }
    });
    const remotePort = await new Promise((r) => remoteServer.listen(0, '0.0.0.0', () => r(remoteServer.address().port)));
    const lanIp =
      Object.values(os.networkInterfaces())
        .flat()
        .find((n) => n && n.family === 'IPv4' && !n.internal)?.address || '';
    const remoteImgUrl = lanIp ? `http://${lanIp}:${remotePort}/ok.png` : '';
    check('本机存在非 loopback IPv4（"http 图真的能加载"这条判据的前提）', !!lanIp, lanIp || '(无，后面的远程图断言会失去意义)');

    section('准备夹具（不联网）');
    dbRun(`INSERT INTO sk_mail_accounts (shop_set_id, email) VALUES (1, 'probe@example.com')`);
    dbRun(
      `INSERT INTO sk_mail_messages (account_id, folder, uid, subject, body_cached, preview)
       VALUES (1, 'INBOX', 42, 'probe', 1, 'probe')`,
    );
    const msgId = Number(dbGet(`SELECT id FROM sk_mail_messages`).id);
    mailDb.saveMailBody(
      msgId,
      'hi',
      '<p>hi</p><img src="cid:logo@probe">' +
        `<img src="${remoteImgUrl || 'http://127.0.0.1:1/x.png'}" width="10" height="10">`,
      false,
    );
    mailDb.replaceMailAttachments(msgId, [
      { filename: 'logo.png', mime: 'image/png', size: PNG_1PX.length, contentId: '<logo@probe>' },
    ]);
    const attId = Number(dbGet(`SELECT id FROM sk_mail_attachments WHERE message_id = ?`, [msgId]).id);
    const cachedPath = await mailCache.writeMailAttachmentCache(attId, msgId, 'logo.png', PNG_1PX);
    // 没有缓存就会走 IMAP → 离线必红。这条同时是"离线可跑"的前提自检
    check('附件已预置磁盘缓存（否则 att 会走 IMAP）', !!cachedPath, cachedPath ? '' : '(未入缓存)');

    initMailBodyProtocol();
    const bodyUrl = `sk-mail://body/${msgId}`;

    // ---- 1. 正文文档本身 ----
    section('正文文档（net.fetch 直取）');
    const bodyRes = await net.fetch(bodyUrl);
    const bodyHtml = await bodyRes.text();
    const csp = bodyRes.headers.get('content-security-policy') || '';
    check('正文文档 200 且是 text/html', bodyRes.status === 200, `status=${bodyRes.status}`);
    check('cid 引用改写为 sk-mail://att/<msgId>/<attId>', bodyHtml.includes(`sk-mail://att/${msgId}/${attId}`));
    check('远程图 src 保持原样（只拦不发，不改写 DOM）', bodyHtml.includes(remoteImgUrl));
    check('默认 CSP：img-src 无 http(s)、禁脚本、默认全禁',
      /img-src sk-mail: data:;/.test(csp) && /script-src 'none'/.test(csp) && /default-src 'none'/.test(csp),
      csp);
    const remoteCsp =
      (await net.fetch(`${bodyUrl}?remote=1`)).headers.get('content-security-policy') || '';
    check('?remote=1 才放行 http(s)，脚本仍禁',
      /img-src sk-mail: data: https: http:/.test(remoteCsp) && /script-src 'none'/.test(remoteCsp),
      remoteCsp);

    // ---- 2. 路由与错误语义 ----
    section('路由与错误语义');
    const attRes = await net.fetch(`sk-mail://att/${msgId}/${attId}`);
    const attBytes = Buffer.from(await attRes.arrayBuffer());
    check(
      '附件返回真实字节 + 正确 content-type',
      attRes.status === 200 && attBytes.equals(PNG_1PX) && attRes.headers.get('content-type') === 'image/png',
      `status=${attRes.status} bytes=${attBytes.length} ctype=${attRes.headers.get('content-type')}`,
    );
    const missAtt = await net.fetch(`sk-mail://att/${msgId}/999999`).catch((e) => ({ status: 'ERR:' + e.message }));
    check('不存在的附件 → 404（证明上面的 200 非空转）', missAtt.status === 404, `status=${missAtt.status}`);
    const missMsg = await net.fetch(`sk-mail://body/999999`).catch((e) => ({ status: 'ERR:' + e.message }));
    check('不存在的邮件 → 404', missMsg.status === 404, `status=${missMsg.status}`);
    const badRoute = await net.fetch(`sk-mail://nope/1`).catch((e) => ({ status: 'ERR:' + e.message }));
    check('未知 host → 404', badRoute.status === 404, `status=${badRoute.status}`);

    // ---- 3. 真实渲染路径：宿主页 + sandbox iframe ----
    // 宿主页用 query 决定嵌哪一态：`sk-host://page/index.html`（默认拦截）/ `?remote=1`（放行）
    section('渲染路径（sandbox iframe 子资源）');
    protocol.handle('sk-host', async (req) => {
      const u = new URL(req.url);
      if (u.hostname !== 'page') return new Response('nope', { status: 404 });
      const src = `${bodyUrl}${u.searchParams.get('remote') === '1' ? '?remote=1' : ''}`;
      // `/page/island.html` = 复刻"岛页面"（头 CSP + 岛自带 meta CSP 两层）；
      // `/page/index.html` = 只有头 CSP 的裸宿主页（前几节用）
      const meta = u.pathname.includes('island')
        ? `<meta http-equiv="Content-Security-Policy" content="${ISLAND_META_CSP}">`
        : '';
      // 只嵌正文 iframe：宿主页自身的 img 取 sk-mail:// 会被 UI_CSP 的 img-src 拦（那是刻意的边界），
      // 图片能力只属于正文文档，故这里不掺宿主取图
      return new Response(
        `<!doctype html><html><head>${meta}</head><body>
           <iframe id="f" sandbox="" src="${src}" style="width:600px;height:400px"></iframe>
         </body></html>`,
        { headers: { 'content-type': 'text/html; charset=utf-8', 'content-security-policy': HOST_CSP } },
      );
    });

    const seen = [];
    session.defaultSession.webRequest.onCompleted({ urls: ['sk-mail://*/*', 'sk-host://*/*'] }, (d) =>
      seen.push(`${d.statusCode} ${d.url}`),
    );
    session.defaultSession.webRequest.onErrorOccurred({ urls: ['sk-mail://*/*'] }, (d) =>
      seen.push(`ERR(${d.error}) ${d.url}`),
    );
    const win = new BrowserWindow({ width: 900, height: 700, show: false, webPreferences: { sandbox: false } });
    await win.loadURL('sk-host://page/index.html');
    await new Promise((r) => setTimeout(r, 1500));

    check('iframe 加载了 sk-mail:// 正文（父 CSP 的 frame-src 放行）',
      seen.some((s) => s.startsWith('200 ') && s.includes('/body/')), seen.join(' | '));
    check('正文里的内联图子资源取到了 200（图片能力只归正文文档）',
      seen.some((s) => s.startsWith('200 ') && s.includes('/att/')));
    // 注意这条**抓不到 CSP 拦截**（实测：frame-src 被改坏时 onErrorOccurred 不报、只有上面两条断言变红）。
    // 它守的是网络层错误。名字如实写，别让下一个人以为它能代替 CSP 断言。
    check('sk-mail:// 请求无网络层错误（CSP 拦截由上面两条覆盖）',
      !seen.some((s) => s.startsWith('ERR(')));

    // ---- 4. 远程图：默认不发请求 / 放行后**真取到字节** ----
    // 这一节是"用户到底能不能看到图"的最终判据：前面几节只证明文档与内联图通了，
    // 而本项目绝大多数邮件的图是**远程图**（不点放行就该一直空着）。
    section('远程图（默认拦截 / ?remote=1 真的加载）');
    const remoteSeen = [];
    const remoteFilter = { urls: [`http://${lanIp}:${remotePort}/*`] };
    session.defaultSession.webRequest.onCompleted(remoteFilter, (d) =>
      remoteSeen.push(`DONE ${d.statusCode} ${d.url}`),
    );
    session.defaultSession.webRequest.onErrorOccurred(remoteFilter, (d) =>
      remoteSeen.push(`ERR(${d.error}) ${d.url}`),
    );

    // 4a. 默认态：**连请求都不该发出**（这是"防追踪像素"这条承诺的唯一可测形式）
    await win.loadURL('sk-host://page/index.html');
    await new Promise((r) => setTimeout(r, 1200));
    check('默认态：远程图一个请求都没发出（防追踪成立）',
      remoteSeen.length === 0 && served.length === 0, `${remoteSeen.join(' | ')} / served=${served.join(',')}`);

    // 4b. 放行态：请求真的到达了服务端并拿到 200 —— 用"服务端真的被访问过"记账，不看 DOM
    served.length = 0;
    remoteSeen.length = 0;
    await win.loadURL('sk-host://page/index.html?remote=1');
    await new Promise((r) => setTimeout(r, 2000));
    check('?remote=1：远程图请求到达服务端（非 loopback http，未被混合内容拦）',
      served.some((u) => u.startsWith('/ok.png')), `served=${served.join(',')}`);
    check('?remote=1：远程图响应 200（CSP 与网络层都放行）',
      remoteSeen.some((s) => s.startsWith('DONE 200')), remoteSeen.join(' | '));

    // ---- 5. 岛自带 meta CSP 的那一层：用岛的真实 index.html 复现 ----
    // 为什么必须单独测：宿主下发的 UI_CSP 只是**一层**，CSP 取交集。岛自己的 index.html 里那份
    // `<meta http-equiv="Content-Security-Policy">` 若缺 `frame-src sk-mail:`（回落到 default-src 'self'），
    // 正文 iframe 照样 ERR_BLOCKED_BY_CSP —— 2026-10-04 的真实事故就是这样：宿主侧全绿、
    // 真机正文全白，第 3 轮才在真机上抓到。这里读**岛的真实文件**（不抄副本），
    // 把它放进父页（sk-host://page/island.html 那条分支），于是"岛删掉那条指令"会立刻在本冒烟里变红。
    section('岛自带 meta CSP（第二层，取交集）');
    check('读到了岛的 meta CSP（读不到 ⇒ 后面的断言失去意义，先修 index.html 结构）',
      !!ISLAND_META_CSP, ISLAND_META_CSP.slice(0, 60));
    check('岛的 meta CSP 放行 frame-src sk-mail:', /frame-src[^;]*sk-mail:/.test(ISLAND_META_CSP));
    check('岛的 meta CSP 没夹带明显越权项（script-src 通配 / unsafe-eval）',
      !/unsafe-eval/.test(ISLAND_META_CSP) && !/script-src[^;]*\*/.test(ISLAND_META_CSP), ISLAND_META_CSP);

    const seen5 = [];
    session.defaultSession.webRequest.onCompleted({ urls: ['sk-mail://*/*'] }, (d) =>
      seen5.push(`${d.statusCode} ${d.url}`),
    );
    // 复用同一个窗口：本环境（--no-sandbox --disable-gpu）下销毁再新建窗口会把进程带崩，
    // 上一版就是这么崩的（日志停在创建第二个窗口处，最后的汇总行都没打出来）。
    const diag = [];
    win.webContents.on('console-message', (_e, _lvl, message) => diag.push(`console: ${message}`));
    win.webContents.on('did-fail-load', (_e, code, desc, url, isMainFrame) =>
      diag.push(`fail-load: ${code} ${desc} ${url} main=${isMainFrame}`),
    );
    await win
      .loadURL('sk-host://page/island.html')
      .catch((e) => diag.push(`loadURL 抛错: ${e.message}`));
    await new Promise((r) => setTimeout(r, 1800));
    check('带岛 meta CSP 的页面里正文 iframe 仍加载成功（两层交集放行）',
      seen5.some((s) => s.startsWith('200 ') && s.includes('/body/')),
      (seen5.join(' | ') || '(无 sk-mail 请求)') + (diag.length ? `  ${diag.join(' ⏐ ').slice(0, 400)}` : ''));
    win.destroy();

    const failed = results.filter((r) => !r).length;
    console.log('\n' + (failed ? `✗ ${failed} 项失败` : '✓ 全部通过'));
    remoteServer.close();
    fs.rmSync(tmpDir, { recursive: true, force: true });
    app.exit(failed ? 1 : 0);
  } catch (err) {
    console.error('PROBE_THREW:', err && err.stack ? err.stack : err);
    try {
      remoteServer && remoteServer.close();
    } catch {
      /* 关不掉也不影响退出码 */
    }
    fs.rmSync(tmpDir, { recursive: true, force: true });
    app.exit(2);
  }
});
