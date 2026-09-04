// electron/plugins-handlers.ts
// 外置插件目录 IPC（Phase 3）：<userData>/plugins 的扫描 / 入口读取 / 卸载 / 打开目录。
// 安全边界（纵深防御第一层；渲染层 externalManifest.ts 还有严格 schema 校验）：
//  - 插件 id 必须是 kebab-case，目录名必须等于 manifest.name；
//  - entry 只允许相对路径且禁止 '..' 穿越（resolve 后仍校验在插件目录内）；
//  - 入口文件大小上限 2MB，超出拒绝。
// 说明：主进程 .ts 文件必须带 export {} 模块标记（AGENTS 红线 12）；本文件副作用注册 ipcMain。

export {};

const { app, ipcMain, shell } = require('electron');
const fs = require('fs');
const path = require('path');

const PLUGINS_DIR = 'plugins';
const ID_RE = /^[a-z0-9]+(-[a-z0-9]+)*$/;
const MAX_ENTRY_BYTES = 2 * 1024 * 1024; // 2 MB

/** 插件根目录（不存在则创建） */
function pluginsRoot(): string {
  const dir = path.join(app.getPath('userData'), PLUGINS_DIR);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** 插件 id 合法性（防目录穿越/非法路径） */
function isValidPluginId(id: unknown): id is string {
  return typeof id === 'string' && ID_RE.test(id) && id.length <= 64;
}

/** 插件绝对目录；非法 id 抛错 */
function pluginDirOf(id: string): string {
  if (!isValidPluginId(id)) throw new Error(`非法插件 id: ${String(id)}`);
  return path.join(pluginsRoot(), id);
}

/** 校验并解析入口绝对路径（id + 相对 entry，禁止穿越出插件目录） */
function resolveEntryPath(id: string, entry: unknown): string {
  if (typeof entry !== 'string' || !entry || !entry.startsWith('./') || entry.includes('..')) {
    throw new Error('entry 必须是 ./ 开头的相对路径且不允许目录穿越');
  }
  const dir = pluginDirOf(id);
  const full = path.resolve(dir, entry);
  const rel = path.relative(dir, full);
  if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('entry 越出插件目录');
  return full;
}

/** 读取单个目录的 manifest.json；失败返回 error 说明（不中断整体扫描） */
function scanPluginDir(dirName: string, dirPath: string): Record<string, unknown> | null {
  try {
    const manifestPath = path.join(dirPath, 'manifest.json');
    if (!fs.existsSync(manifestPath)) return null;
    const raw = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
    const entry = typeof raw.entry === 'string' && raw.entry ? raw.entry : './index.js';
    resolveEntryPath(dirName, entry); // 提前校验 entry，避免后续读取时才发现穿越
    return raw as Record<string, unknown>;
  } catch {
    return null;
  }
}

ipcMain.handle('plugins-scan', async () => {
  try {
    const root = pluginsRoot();
    const plugins: Array<{ id: string; entry: string; manifest: Record<string, unknown>; error?: string }> = [];
    for (const dirName of fs.readdirSync(root)) {
      const dirPath = path.join(root, dirName);
      let isDir = false;
      try {
        isDir = fs.statSync(dirPath).isDirectory();
      } catch {
        continue;
      }
      if (!isDir || !ID_RE.test(dirName)) continue;
      const manifest = scanPluginDir(dirName, dirPath);
      if (!manifest || manifest.name !== dirName) {
        plugins.push({ id: dirName, entry: './index.js', manifest: {}, error: `manifest 缺失或 name 与目录名不一致: ${dirName}` });
        continue;
      }
      plugins.push({
        id: dirName,
        entry: typeof manifest.entry === 'string' ? manifest.entry : './index.js',
        manifest,
      });
    }
    return { success: true, data: { root, plugins } };
  } catch (err: any) {
    return { success: false, error: err instanceof Error ? err.message : '扫描插件目录失败' };
  }
});

ipcMain.handle('plugins-read-entry', async (_event: any, payload: any) => {
  try {
    if (!payload || typeof payload !== 'object' || !isValidPluginId(payload.id)) {
      throw new Error('非法插件 id');
    }
    const full = resolveEntryPath(payload.id, payload.entry);
    const stat = fs.statSync(full);
    if (!stat.isFile() || stat.size > MAX_ENTRY_BYTES) {
      throw new Error(`入口文件过大（上限 ${Math.floor(MAX_ENTRY_BYTES / 1024)}KB）`);
    }
    const code = fs.readFileSync(full, 'utf8');
    return { success: true, data: { code } };
  } catch (err: any) {
    return { success: false, error: err instanceof Error ? err.message : '读取插件入口失败' };
  }
});

ipcMain.handle('plugins-uninstall', async (_event: any, payload: any) => {
  try {
    if (!payload || typeof payload !== 'object' || !isValidPluginId(payload.id)) {
      throw new Error('非法插件 id');
    }
    const dir = pluginDirOf(payload.id);
    // 双保险：确认解析后仍在插件根目录内
    const rel = path.relative(pluginsRoot(), dir);
    if (rel.startsWith('..') || path.isAbsolute(rel)) throw new Error('插件目录越界，已拒绝删除');
    fs.rmSync(dir, { recursive: true, force: true });
    return { success: true, data: undefined };
  } catch (err: any) {
    return { success: false, error: err instanceof Error ? err.message : '卸载插件失败' };
  }
});

ipcMain.handle('plugins-open-dir', async () => {
  try {
    const opened = await shell.openPath(pluginsRoot());
    return opened ? { success: false, error: opened } : { success: true, data: pluginsRoot() };
  } catch (err: any) {
    return { success: false, error: err instanceof Error ? err.message : '打开插件目录失败' };
  }
});
