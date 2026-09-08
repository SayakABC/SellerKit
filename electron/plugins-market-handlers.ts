// electron/plugins-market-handlers.ts
// 插件市场（Market）主进程防线：拉取 catalog + 下载 zip 安装外置插件。
//
// 职责与安全边界（对应渲染层 src/core/plugin/marketClient.ts 的调用方）：
//  - plugins-market-catalog ：下载市场 catalog.json（http/https）→ JSON 解析 → 逐项净化 → 返回合法条目
//  - plugins-market-install  ：{ item, force } → 下载 zip → sha256 强制校验 → 安全解压（zip-slip
//                              防护、拒符号链接）→ 校验 manifest.name === item.id && entry 合法
//                              → 删除旧目录 → 原子落盘 <userData>/plugins/<id>/
//
// 约束：
//  - 下载走 electron/http-client.ts 的 downloadFile（协议白名单 + ≤20MB + 超时）
//  - 所有解压条目 resolve 后必须仍位于目标目录内；符号链接一律拒绝
//  - manifest 严格校验与渲染层 externalManifest.ts 同语义（本文件为第一层防线）
//  - 本文件为 CommonJS + export {} 标模块（见 AGENTS 红线 12）
'use strict';

const { app, ipcMain } = require('electron');
const fs = require('fs');
const fsp = fs.promises;
const path = require('path');
const crypto = require('crypto');
const { downloadFile } = require('./http-client');
const yauzl = require('yauzl');

/** 插件根目录（与 plugins-handlers.ts 同源：<userData>/plugins） */
function pluginsRoot(): string {
  return path.join(app.getPath('userData'), 'plugins');
}

/** kebab-case id：字母数字 + 中划线，长度 ≤64 */
const PLUGIN_ID_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/i;
/** sha256 hex：64 位小写/大写 hex */
const SHA256_RE = /^[0-9a-fA-F]{64}$/;
const VERSION_RE = /^\d+\.\d+\.\d+$/;

function isHttpUrl(u: string): boolean {
  try {
    const p = new URL(u);
    return p.protocol === 'https:' || p.protocol === 'http:';
  } catch {
    return false;
  }
}

/** 净化并浅校验单个市场条目（安装入口：不信任渲染层传来的任何字段） */
function sanitizeItem(raw: unknown): any {
  if (!raw || typeof raw !== 'object') return null;
  const o = raw as Record<string, unknown>;
  const id = typeof o.id === 'string' ? o.id.trim().toLowerCase() : '';
  const name = typeof o.name === 'string' ? o.name.trim().slice(0, 80) : '';
  const version = typeof o.version === 'string' ? o.version.trim() : '';
  const downloadUrl = typeof o.downloadUrl === 'string' ? o.downloadUrl.trim().slice(0, 2048) : '';
  const sha256 = typeof o.sha256 === 'string' ? o.sha256.trim() : '';
  if (!PLUGIN_ID_RE.test(id) || id.length > 64) return null;
  if (!name || !VERSION_RE.test(version)) return null;
  if (!isHttpUrl(downloadUrl)) return null;
  if (!SHA256_RE.test(sha256)) return null;
  const description = typeof o.description === 'string' ? o.description.slice(0, 300) : '';
  const author = typeof o.author === 'string' ? o.author.slice(0, 80) : '';
  const homepage = typeof o.homepage === 'string' && isHttpUrl(o.homepage) ? o.homepage.slice(0, 2048) : '';
  // kind：catalog 标记插件形态（P3）；'ui' = iframe 运行时岛（静态站点包），仅放行白名单值
  const kind = o.kind === 'ui' || o.kind === 'extension' ? (o.kind as string) : '';
  return { id, name, version, description, author, downloadUrl, sha256, homepage, ...(kind ? { kind } : {}) };
}

/** 语义化版本比较：a>b 返回 1，相等 0，a<b 返回 -1（入参已校验 x.y.z） */
function compareVersions(a: string, b: string): number {
  const pa = a.split('.').map(Number);
  const pb = b.split('.').map(Number);
  for (let i = 0; i < 3; i++) {
    if (pa[i] !== pb[i]) return pa[i] > pb[i] ? 1 : -1;
  }
  return 0;
}

/** 读取已装插件 manifest.version；未安装返回 null */
function installedVersion(id: string): string | null {
  try {
    const m = JSON.parse(fs.readFileSync(path.join(pluginsRoot(), id, 'manifest.json'), 'utf8'));
    return typeof m?.version === 'string' && VERSION_RE.test(m.version) ? m.version : null;
  } catch {
    return null;
  }
}

/**
 * 安全解压：yauzl 逐条目，拒绝：
 *  - 绝对路径 / '..' 穿越（resolve 后必须仍在 destDir 内）
 *  - 符号链接（unix mode 0o120000）
 * 目录条目跳过；普通文件递归建目录写入。
 */
function unzipSafe(zipPath: string, destDir: string): Promise<void> {
  return new Promise((resolve, reject) => {
    yauzl.open(zipPath, { lazyEntries: true }, (err, zipfile) => {
      if (err) return reject(err);
      if (!zipfile) return reject(new Error('yauzl 打开 zip 失败'));
      const fail = (e: Error) => {
        try {
          zipfile.close();
        } catch {
          /* ignore */
        }
        reject(e);
      };
      zipfile.readEntry();
      zipfile.on('entry', (entry: any) => {
        const rawName = String(entry.fileName || '');
        // 目录条目
        if (rawName.endsWith('/')) {
          zipfile.readEntry();
          return;
        }
        const rel = rawName.replace(/\\/g, '/');
        // 穿越防护
        const resolved = path.resolve(destDir, rel);
        const relCheck = path.relative(destDir, resolved);
        if (relCheck.startsWith('..') || path.isAbsolute(relCheck) || rawName.startsWith('/')) {
          fail(new Error(`zip 条目越界: ${rawName}`));
          return;
        }
        // 符号链接拒绝
        const mode = (entry.externalFileAttributes >>> 16) & 0xffff;
        if ((mode & 0o170000) === 0o120000) {
          fail(new Error(`zip 含符号链接，已拒绝: ${rawName}`));
          return;
        }
        zipfile.openReadStream(entry, (err2: Error | null, readStream: any) => {
          if (err2 || !readStream) {
            fail(err2 || new Error('openReadStream 失败'));
            return;
          }
          const outPath = resolved;
          fs.mkdirSync(path.dirname(outPath), { recursive: true });
          const out = fs.createWriteStream(outPath);
          readStream.pipe(out);
          readStream.on('error', fail);
          out.on('error', fail);
          out.on('close', () => zipfile.readEntry());
        });
      });
      zipfile.on('end', () => resolve());
      zipfile.on('error', fail);
    });
  });
}

/** 校验解压目录内的 manifest：name 必须等于 item.id；entry 为合法相对路径 */
function validateExtracted(rootDir: string, item: any): void {
  const mf = path.join(rootDir, 'manifest.json');
  if (!fs.existsSync(mf)) throw new Error('zip 内缺少 manifest.json');
  let manifest: any;
  try {
    manifest = JSON.parse(fs.readFileSync(mf, 'utf8'));
  } catch {
    throw new Error('manifest.json 解析失败');
  }
  if (manifest?.name !== item.id) {
    throw new Error(`manifest.name 与目录 id 不一致: ${String(manifest?.name)} != ${item.id}`);
  }
  if (typeof manifest?.version !== 'string' || !VERSION_RE.test(manifest.version)) {
    throw new Error('manifest.version 非法（须 x.y.z）');
  }
  if (manifest.version !== item.version) {
    throw new Error(`manifest.version(${manifest.version}) 与 catalog version(${item.version}) 不一致`);
  }
  const entry = typeof manifest?.entry === 'string' ? manifest.entry.trim() : '';
  if (!entry.startsWith('./') || entry.includes('..')) {
    throw new Error(`manifest.entry 非法: ${entry || '(空)'}（须 ./ 相对且不含 ..）`);
  }
  const entryPath = path.resolve(rootDir, entry);
  const relCheck = path.relative(rootDir, entryPath);
  if (relCheck.startsWith('..') || path.isAbsolute(relCheck)) throw new Error('manifest.entry 越界');
  if (!fs.existsSync(entryPath)) throw new Error(`manifest.entry 文件不存在: ${entry}`);
}

// ---- catalog 净化：仅保留合法字段，非法项丢弃（防御恶意 catalog） ----
function sanitizeCatalog(json: any): { plugins: any[] } {
  if (!json || typeof json !== 'object') return { plugins: [] };
  const rawList = Array.isArray(json.plugins) ? json.plugins : [];
  const plugins: any[] = [];
  const seen = new Set<string>();
  for (const raw of rawList) {
    const item = sanitizeItem(raw);
    if (!item || seen.has(item.id)) continue;
    seen.add(item.id);
    plugins.push(item);
  }
  return { plugins };
}

// 首次 require 即注册 IPC（同 plugins-handlers.ts 风格）
ipcMain.handle('plugins-market-catalog', async (_e: any, payload: any) => {
  const url = typeof payload?.url === 'string' ? payload.url.trim().slice(0, 2048) : '';
  if (!isHttpUrl(url)) return { success: false, error: '市场地址非法（须 http/https）' };
  const tmpDir = path.join(app.getPath('temp'), `sk-market-catalog-${process.pid}-${Date.now()}`);
  const tmpFile = path.join(tmpDir, 'catalog.json');
  try {
    fs.mkdirSync(tmpDir, { recursive: true });
    // downloadFile 不抛错，须检查 ok（失败时不会写文件）
    const dl = await downloadFile(url, tmpFile); // 协议白名单 + ≤20MB + 30s 超时（http-client 内建）
    if (!dl.ok) {
      return { success: false, error: `获取市场目录失败: HTTP ${dl.status}${dl.error ? `（${dl.error}）` : ''}` };
    }
    const raw = JSON.parse(fs.readFileSync(tmpFile, 'utf8'));
    return { success: true, data: sanitizeCatalog(raw) };
  } catch (err: any) {
    return { success: false, error: `获取市场目录失败: ${err?.message ?? String(err)}` };
  } finally {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  }
});

ipcMain.handle('plugins-market-install', async (_e: any, payload: any) => {
  const item = sanitizeItem(payload?.item);
  const force = payload?.force === true;
  if (!item) return { success: false, error: '安装请求参数非法' };
  const root = pluginsRoot();
  const destDir = path.join(root, item.id);
  // 版本语义：已装且版本不低于目标（且非 force）→ 拒绝重复/降级安装
  const curVer = installedVersion(item.id);
  if (curVer !== null && !force && compareVersions(curVer, item.version) >= 0) {
    return { success: false, error: `已安装 v${curVer}，无需重复安装（目录含 v${item.version}）` };
  }
  const tmpRoot = path.join(app.getPath('temp'), `sk-market-install-${item.id}-${Date.now()}`);
  const tmpZip = path.join(tmpRoot, 'plugin.zip');
  const tmpUnzip = path.join(tmpRoot, 'out');
  try {
    // 1) 下载（白名单/≤20MB/超时）；downloadFile 不抛错，须检查 ok
    const dl = await downloadFile(item.downloadUrl, tmpZip);
    if (!dl.ok) {
      return { success: false, error: `下载插件包失败: HTTP ${dl.status}${dl.error ? `（${dl.error}）` : ''}` };
    }
    // 2) sha256 强制校验
    const buf = await fsp.readFile(tmpZip);
    const actual = crypto.createHash('sha256').update(buf).digest('hex');
    if (actual.toLowerCase() !== item.sha256.toLowerCase()) {
      return { success: false, error: `sha256 校验失败（期望 ${item.sha256.slice(0, 12)}…，实际 ${actual.slice(0, 12)}…）` };
    }
    // 3) 安全解压
    fs.mkdirSync(tmpUnzip, { recursive: true });
    await unzipSafe(tmpZip, tmpUnzip);
    // 4) manifest 校验（name/version/entry）
    validateExtracted(tmpUnzip, item);
    // 5) 原子落盘：删除旧目录 → rename
    fs.mkdirSync(root, { recursive: true });
    fs.rmSync(destDir, { recursive: true, force: true });
    await fsp.rename(tmpUnzip, destDir);
    return { success: true, data: { id: item.id, version: item.version } };
  } catch (err: any) {
    return { success: false, error: `安装插件失败: ${err?.message ?? String(err)}` };
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true });
  }
});

export {};
