#!/usr/bin/env node
// 本地插件市场静态服务：`node scripts/serve-market.mjs [--port 8000] [--dir market-out]`
//
// 为什么不用 `python3 -m http.server`：
//   SimpleHTTPRequestHandler 只发 `Last-Modified`、**不发 `Cache-Control`**。Chromium（Electron 的 net
//   走的就是它）对这类响应套用启发式新鲜度 `freshness = (Date - Last-Modified) × 10%`。catalog.json
//   上一次改动距今越久，算出的新鲜期越长（隔两天就是 5 小时量级），期间宿主刷新市场**连请求都不发**，
//   直接吃旧目录 —— 症状就是「插件已经发布，市场里却看不到」。
//
//   本服务对**所有**响应显式发 `Cache-Control: no-store`，从源头掐掉这条路径；
//   宿主侧另有 `downloadFile({ noCache: true })` 作为第二道防线（见 electron/http-client.ts）。
//
// 用法：起在插件市场目录，宿主「插件中心 → 市场」地址填 `http://127.0.0.1:<port>/catalog.json`

import { createServer } from 'node:http';
import { createReadStream, existsSync, readdirSync, statSync } from 'node:fs';
import { extname, join, normalize, resolve, sep } from 'node:path';

const argv = process.argv.slice(2);
function opt(name, fallback) {
  const i = argv.indexOf(`--${name}`);
  return i !== -1 && argv[i + 1] ? argv[i + 1] : fallback;
}

const ROOT = resolve(opt('dir', 'market-out'));
const PORT = Number(opt('port', process.env.PORT || 8000));
const HOST = opt('host', '127.0.0.1');

const MIME = {
  '.json': 'application/json; charset=utf-8',
  '.zip': 'application/zip',
  '.js': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.html': 'text/html; charset=utf-8',
  '.md': 'text/markdown; charset=utf-8',
  '.txt': 'text/plain; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.webp': 'image/webp',
};

if (!existsSync(ROOT)) {
  console.error(`✖ 目录不存在: ${ROOT}`);
  console.error('  用法: node scripts/serve-market.mjs [--port 8000] [--dir market-out]');
  process.exit(1);
}

const server = createServer((req, res) => {
  const started = Date.now();
  const send = (code, body, headers = {}) => {
    // 关键：所有响应都要 no-store（Etag/Last-Modified 一概不发，杜绝 304 复核路径）
    const head = {
      'Cache-Control': 'no-store, no-cache, must-revalidate, max-age=0',
      Pragma: 'no-cache',
      Expires: '0',
      'Access-Control-Allow-Origin': '*',
      ...headers,
    };
    res.writeHead(code, head);
    if (Buffer.isBuffer(body) || typeof body === 'string') res.end(body);
    else body.pipe(res);
    if (code >= 400) console.log(`${code} ${req.method} ${req.url} (${Date.now() - started}ms)`);
  };

  if (req.method === 'OPTIONS') return send(204, '');
  if (req.method !== 'GET' && req.method !== 'HEAD')
    return send(405, 'Method Not Allowed', { 'Content-Type': 'text/plain' });

  let pathname;
  try {
    pathname = decodeURIComponent(new URL(req.url, `http://${HOST}`).pathname);
  } catch {
    return send(400, 'Bad Request', { 'Content-Type': 'text/plain' });
  }
  if (pathname === '/') pathname = '/index.html';

  // 目录穿越防护：resolve 后必须仍在 ROOT 内
  const target = normalize(join(ROOT, pathname));
  if (target !== ROOT && !target.startsWith(ROOT + sep)) {
    return send(403, 'Forbidden', { 'Content-Type': 'text/plain' });
  }

  if (!existsSync(target)) {
    // 落到 / 时给一个目录列表，便于在浏览器里肉眼确认有哪些 zip
    if (pathname === '/index.html') {
      const list = readdirSync(ROOT)
        .filter((f) => !f.startsWith('.'))
        .sort()
        .map((f) => `<li><a href="${encodeURIComponent(f)}">${f}</a></li>`)
        .join('');
      return send(
        200,
        `<!doctype html><meta charset="utf-8"><title>market-out</title><ul>${list}</ul>`,
        {
          'Content-Type': 'text/html; charset=utf-8',
        }
      );
    }
    return send(404, 'Not Found', { 'Content-Type': 'text/plain' });
  }

  const st = statSync(target);
  if (st.isDirectory()) return send(404, 'Not Found', { 'Content-Type': 'text/plain' });
  send(200, createReadStream(target), {
    'Content-Type': MIME[extname(target).toLowerCase()] || 'application/octet-stream',
    'Content-Length': String(st.size),
  });
});

server.listen(PORT, HOST, () => {
  console.log(`插件市场服务已启动（no-store）`);
  console.log(`  目录: ${ROOT}`);
  console.log(`  catalog: http://${HOST}:${PORT}/catalog.json`);
  console.log(`  宿主「插件中心 → 市场」填上面这个 catalog 地址`);
});
