// electron/plugin-ui-protocol.ts
// 外置富 UI 插件运行时协议（PLUGIN_ARCHITECTURE.md §15：P0 验证技术路线 → P1 落地桥 + 权限门复用）
// 职责：
//  1. 注册特权 scheme `sk-plugin://`（standard/secure/CORS/stream），只读映射 <userData>/plugins/<id>/；
//  2. 请求校验：host = 插件 id（kebab-case），路径解码后逐段拒绝 `..`/反斜杠/空字节，realpath 二次防逃逸；
//  3. 响应：目录回退 index.html、扩展名→MIME、注入 CSP 头、单文件大小上限（对齐 §15.4 分层阈值 ≤16MB）；
//  4. P1 桥运行时注入：HTML 文档尾部注入同源 <script src="sk-plugin://<id>/__sk__/runtime.js">，
//     runtime（electron/plugin-ui-runtime.js，纯浏览器 JS 文本）经保留路径 /__sk__/runtime.js 下发——
//     桥代码版本由宿主控制，UI 包不携带桥实现；
//  5. 开发模式（!app.isPackaged）：把 scripts/poc-ui-hello/ 种子 UI 包同步到 <userData>/plugins/sk-ui-hello。
// 依赖：仅 electron/node 标准模块；由 electron/main.ts 顶层 require（scheme 特权须在 app ready 前注册）。
// 纪律：本文件为宿主能力面新增项，能力放行/路径边界收紧须与渲染层 externalManifest 双防线同步（AGENTS 红线 18/19）。

import { app, protocol } from 'electron';
import * as fs from 'fs';
import * as path from 'path';

/** P0 演示插件 id（与 scripts/poc-ui-hello/manifest.json 的 name 一致） */
export const UI_POC_ID = 'sk-ui-hello';

/** 单资源大小上限（对齐 §15.4 建议：单资源 ≤16MB；目录总大小由安装链路另行约束） */
const UI_MAX_FILE_BYTES = 16 * 1024 * 1024;

/** 插件 id（URL host 段）白名单：kebab-case，≤64 字符 */
const PLUGIN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const MIME: Record<string, string> = {
  '.html': 'text/html; charset=utf-8',
  '.htm': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.mjs': 'text/javascript; charset=utf-8',
  '.css': 'text/css; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.png': 'image/png',
  '.jpg': 'image/jpeg',
  '.jpeg': 'image/jpeg',
  '.gif': 'image/gif',
  '.webp': 'image/webp',
  '.ico': 'image/x-icon',
  '.woff': 'font/woff',
  '.woff2': 'font/woff2',
  '.ttf': 'font/ttf',
  '.otf': 'font/otf',
  '.map': 'application/json; charset=utf-8',
};

/** 注入 CSP：插件文档只能加载自身（sk-plugin:// 同源）+ data: 内联资源；不设 frame-ancestors（允许被宿主嵌入） */
const UI_CSP =
  "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; " +
  "font-src 'self' data:; connect-src 'self'; object-src 'none'; base-uri 'none'";

/** 必须在 app ready 之前调用（module 顶层即可：main.ts 顶层 require） */
protocol.registerSchemesAsPrivileged([
  {
    scheme: 'sk-plugin',
    privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true },
  },
]);

function pluginsRoot(): string {
  return path.join(app.getPath('userData'), 'plugins');
}

function devLog(message: string): void {
  if (!app.isPackaged) console.log(`[plugin-ui] ${message}`);
}

/**
 * 将 `sk-plugin://<id>/<path>` 解析为插件目录内真实文件路径；任何越界返回 null。
 * 双层防逃逸：路径逐段白名单 + realpath 包含性校验（防 symlink 指向插件目录外）。
 */
function resolvePluginFile(id: string, rawPath: string): string | null {
  if (!PLUGIN_ID_RE.test(id) || id.length > 64) return null;
  let decoded: string;
  try {
    decoded = decodeURIComponent(rawPath.split('?')[0]);
  } catch {
    return null;
  }
  if (!decoded.startsWith('/')) return null;
  const segments = decoded.slice(1).split('/');
  for (const seg of segments) {
    if (seg === '..' || seg.includes('\\') || seg.includes(':') || seg.includes('\0')) return null;
  }
  const base = path.join(pluginsRoot(), id);
  const target = path.join(base, ...segments);
  // 相对包含性（字符串层二次校验，覆盖空段/点段归一化差异）
  const rel = path.relative(base, target);
  if (rel.startsWith('..') || path.isAbsolute(rel)) return null;
  // realpath 包含性：目标必须真实存在于插件目录内（拒绝 symlink 逃逸）
  try {
    const realBase = fs.realpathSync(base);
    const realTarget = fs.realpathSync(target);
    if (realTarget !== realBase && !realTarget.startsWith(realBase + path.sep)) return null;
  } catch {
    return null; // 目录/文件不存在或不可达
  }
  return target;
}

/** P1：iframe 端桥运行时源（electron/plugin-ui-runtime.js 纯文本）。懒加载一次；dev 读项目源码，打包读 asar 内（files 收 electron/**）。 */
let runtimeSourceCache: string | null = null;
function loadRuntimeSource(): string | null {
  if (runtimeSourceCache !== null) return runtimeSourceCache || null;
  const candidates = [
    path.join(app.getAppPath(), 'electron', 'plugin-ui-runtime.js'), // dev：项目根源码；打包：asar 根（若 files 含 electron/**）
    path.join(__dirname, 'plugin-ui-runtime.js'), // 打包：dist/electron 邻位
  ];
  for (const p of candidates) {
    try {
      runtimeSourceCache = fs.readFileSync(p, 'utf8');
      return runtimeSourceCache || null;
    } catch {
      /* 尝试下一个候选 */
    }
  }
  runtimeSourceCache = '';
  return null;
}

/** HTML 文档尾部注入桥 runtime（同源 <script src>，CSP script-src 'self' 允许）；返回注入后的 UTF-8 文本 */
function injectRuntimeIntoHtml(html: string, hostId: string): string {
  const source = loadRuntimeSource();
  if (!source) return html; // runtime 缺失时原样返回（岛内 __sk 不可用，页面其余功能不受影响）
  const tag = `<script src="sk-plugin://${hostId}/__sk__/runtime.js"></script>`;
  const lower = html.toLowerCase();
  let marker = lower.lastIndexOf('</head>');
  if (marker === -1) marker = lower.lastIndexOf('</body>');
  const at = marker === -1 ? html.length : marker;
  return html.slice(0, at) + tag + html.slice(at);
}

async function serveFile(target: string, injectRuntimeHostId?: string): Promise<Response> {
  let st: fs.Stats;
  try {
    st = await fs.promises.stat(target);
  } catch {
    return new Response('Not Found', { status: 404 });
  }
  let file = target;
  if (st.isDirectory()) {
    // 目录请求回退 index.html（对齐常规静态站点语义）
    file = path.join(target, 'index.html');
    try {
      st = await fs.promises.stat(file);
    } catch {
      return new Response('Not Found', { status: 404 });
    }
  }
  if (!st.isFile()) return new Response('Not Found', { status: 404 });
  if (st.size > UI_MAX_FILE_BYTES) {
    return new Response('Payload Too Large', { status: 413 });
  }
  const ext = path.extname(file).toLowerCase();
  const headers: Record<string, string> = {
    'Content-Type': MIME[ext] ?? 'application/octet-stream',
    'Content-Security-Policy': UI_CSP,
    'X-Content-Type-Options': 'nosniff',
    'Cache-Control': 'no-store', // 开发/桥演进期一律不缓存，保证种子与插件更新即时可见
  };
  // P1：UI 岛 HTML 文档注入桥 runtime 引用（同源、宿主控制版本）
  if (ext === '.html' && injectRuntimeHostId) {
    const html = (await fs.promises.readFile(file)).toString('utf8');
    const out = injectRuntimeIntoHtml(html, injectRuntimeHostId);
    headers['Content-Length'] = String(Buffer.byteLength(out, 'utf8'));
    return new Response(out, { status: 200, headers });
  }
  const body = await fs.promises.readFile(file);
  headers['Content-Length'] = String(st.size);
  return new Response(body, { status: 200, headers });
}

function devDenyLog(id: string, pathname: string): void {
  devLog(`拒绝访问 sk-plugin://${id}${pathname}（id 非法或路径越界）`);
}

/** 开发模式：同步种子 UI 包 → <userData>/plugins/<UI_POC_ID>（每次启动覆盖，保持与仓库源一致） */
function seedDevPocPackage(): void {
  if (app.isPackaged) return;
  const srcDir = path.join(app.getAppPath(), 'scripts', 'poc-ui-hello');
  if (!fs.existsSync(srcDir)) {
    devLog(`跳过种子同步（找不到 ${srcDir}）`);
    return;
  }
  const destDir = path.join(pluginsRoot(), UI_POC_ID);
  try {
    fs.mkdirSync(destDir, { recursive: true });
    fs.cpSync(srcDir, destDir, { recursive: true, force: true });
    devLog(`已同步 demo UI 包 → ${destDir}`);
  } catch (err: any) {
    console.error(`[plugin-ui] 同步 demo UI 包失败: ${err?.message ?? err}`);
  }
}

let initialized = false;

/** 注册 sk-plugin:// 请求处理（app ready 后调用一次） */
export function initPluginUiProtocol(): void {
  if (initialized) return;
  initialized = true;
  protocol.handle('sk-plugin', async (request) => {
    const url = new URL(request.url);
    const id = url.hostname.toLowerCase();
    const pathname = url.pathname;
    if (!PLUGIN_ID_RE.test(id)) {
      devDenyLog(id, pathname);
      return new Response('Forbidden', { status: 403 });
    }
    // P1：保留路径 /__sk__/runtime.js → 下发宿主桥 runtime（同源脚本，不映射插件目录文件）
    if (pathname === '/__sk__/runtime.js') {
      const source = loadRuntimeSource();
      if (!source) return new Response('Not Found', { status: 404 });
      return new Response(source, {
        status: 200,
        headers: {
          'Content-Type': 'text/javascript; charset=utf-8',
          'Content-Security-Policy': UI_CSP,
          'X-Content-Type-Options': 'nosniff',
          'Cache-Control': 'no-store',
        },
      });
    }
    const target = resolvePluginFile(id, pathname);
    if (!target) {
      devDenyLog(id, pathname);
      return new Response('Forbidden', { status: 403 });
    }
    return serveFile(target, id);
  });
  devLog('sk-plugin:// 协议已注册（根映射 <userData>/plugins）');
}

/** 开发模式种子入口（app ready 后、协议注册前调用） */
export function ensurePocPackageSeeded(): void {
  seedDevPocPackage();
}
