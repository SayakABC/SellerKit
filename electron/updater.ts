// 主进程「自动更新」模块：发布源 = GitHub Releases（SayakABC/SellerKit）
// 链路：渲染层「检查更新」→ updater-check IPC → autoUpdater.checkForUpdates()
//       → 结果/进度经 updater-event 通道广播给渲染层（toast 提示）
//       → 下载完成主进程弹原生对话框，用户确认后 quitAndInstall()
// 说明：开发模式（app.isPackaged=false）不执行真实检查，返回 mode:'dev' 供渲染层提示。

export {};

const { app, ipcMain, dialog } = require('electron');
const path = require('path');
const fs = require('fs');
// electron-updater 支持 CommonJS require（electron-builder 26.x 配套 v6.x）
const { autoUpdater } = require('electron-updater');

type GetWindow = () => any | null;

let getWindow: GetWindow | null = null;

/**
 * 极简文件 logger：electron-updater 内部日志（Squirrel 拉取/安装细节）只写
 * autoUpdater.logger，不配置则排障无据。日志落盘到
 * macOS: ~/Library/Logs/SellerKit/updater.log   Windows: %USERPROFILE%\AppData\Roaming\<name>\logs\updater.log
 */
function createUpdaterLogger() {
  const dir = path.join(app.getPath('logs'), 'SellerKit');
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, 'updater.log');
  const ts = () => new Date().toISOString();
  const write = (level: string, ...args: unknown[]) => {
    const line = `[${ts()}] ${level} ${args.map((a) => (typeof a === 'string' ? a : JSON.stringify(a, null, 2))).join(' ')}\n`;
    try {
      fs.appendFileSync(file, line);
    } catch {
      /* 日志失败不影响更新主流程 */
    }
  };
  return {
    info: (...a: unknown[]) => write('INFO', ...a),
    warn: (...a: unknown[]) => write('WARN', ...a),
    error: (...a: unknown[]) => write('ERROR', ...a),
    debug: (...a: unknown[]) => write('DEBUG', ...a),
  };
}

/** 将更新事件广播给渲染层（载荷仅最小安全字段，由本模块构造，可信） */
function emit(type: string, payload: Record<string, unknown> = {}) {
  const win = getWindow?.();
  if (win && !win.isDestroyed()) {
    win.webContents.send('updater-event', { type, ...payload });
  }
}

function registerAutoUpdaterEvents() {
  autoUpdater.autoDownload = true;
  // 手动安装路径：下载完成后由用户点「立即重启」才 quitAndInstall()，
  // 避免 app 运行期间 Squirrel 提前拉取安装导致点击无反应。
  autoUpdater.autoInstallOnAppQuit = false;
  autoUpdater.logger = createUpdaterLogger();
  autoUpdater.logger.info('autoUpdater logger ready, currentVersion=', app.getVersion());

  autoUpdater.on('checking-for-update', () => emit('checking'));
  autoUpdater.on('update-available', (info: any) =>
    emit('update-available', { version: String(info?.version ?? '') }),
  );
  autoUpdater.on('update-not-available', () => emit('update-not-available'));
  autoUpdater.on('download-progress', (p: any) =>
    emit('download-progress', { percent: Math.round(p?.percent ?? 0) }),
  );
  autoUpdater.on('update-downloaded', (info: any) => {
    const version = String(info?.version ?? '');
    autoUpdater.logger?.info('update-downloaded version=', version, 'files=', JSON.stringify(info?.files));
    emit('update-downloaded', { version });
    // 原生对话框（渲染层无需自建确认 UI）：立即重启安装 / 稍后
    const win = getWindow?.();
    if (!win) return;
    dialog
      .showMessageBox(win, {
        type: 'info',
        title: '软件更新',
        message: `新版本 v${version} 已下载完成`,
        detail: '重启应用即可完成安装（自动重启并打开新版本）。',
        buttons: ['立即重启', '稍后'],
        defaultId: 0,
        cancelId: 1,
      })
      .then((r: any) => {
        if (r.response === 0) {
          autoUpdater.logger?.info('user clicked 立即重启, calling quitAndInstall()');
          try {
            autoUpdater.quitAndInstall();
            autoUpdater.logger?.info('quitAndInstall() returned without throwing');
          } catch (err: any) {
            autoUpdater.logger?.error('quitAndInstall() threw:', err?.message ?? String(err));
            emit('updater-error', { message: `安装失败：${err?.message ?? String(err)}` });
          }
        } else {
          autoUpdater.logger?.info('user clicked 稍后');
        }
      })
      .catch((e: any) => {
        autoUpdater.logger?.warn('update dialog error:', e?.message ?? String(e));
      });
  });
  autoUpdater.on('error', (err: any) =>
    emit('updater-error', { message: err?.message ?? String(err) }),
  );
}

// 进行中的检查/下载锁：autoUpdater.checkForUpdates() 不支持并发，
// 下载期间重复点击会被忽略（避免并发抛错 + update-available 重复触发）。
let updateCheckInFlight: Promise<void> | null = null;

// 首次 require 即注册 IPC；窗口引用由 main.ts 在 createWindow 后经 initUpdater 注入
ipcMain.handle('updater-check', async () => {
  try {
    if (!app.isPackaged) {
      return { success: true, data: { mode: 'dev', currentVersion: app.getVersion() } };
    }
    // 显式指定发布源（与 electron-builder.yml 的 publish 段保持一致）
    autoUpdater.setFeedURL({ provider: 'github', owner: 'SayakABC', repo: 'SellerKit' });
    if (!updateCheckInFlight) {
      emit('checking');
      updateCheckInFlight = autoUpdater
        .checkForUpdates()
        .then(() => autoUpdater.logger?.info('checkForUpdates settled'))
        .catch((e: any) => emit('updater-error', { message: e?.message ?? String(e) }))
        .finally(() => {
          updateCheckInFlight = null;
        });
    } else {
      autoUpdater.logger?.info('updater-check ignored: check already in progress');
    }
    return { success: true, data: { mode: 'release', currentVersion: app.getVersion() } };
  } catch (err: any) {
    return { success: false, error: err?.message ?? String(err) };
  }
});

ipcMain.handle('updater-install', async () => {
  try {
    autoUpdater.logger?.info('updater-install IPC called');
    autoUpdater.quitAndInstall();
    autoUpdater.logger?.info('quitAndInstall() returned without throwing (IPC)');
    return { success: true };
  } catch (err: any) {
    autoUpdater.logger?.error('updater-install IPC failed:', err?.message ?? String(err));
    return { success: false, error: err?.message ?? String(err) };
  }
});

/** 注入窗口引用并注册 autoUpdater 事件（main.ts 在 createWindow 后调用） */
function initUpdater(fn: GetWindow) {
  getWindow = fn;
  registerAutoUpdaterEvents();
}

module.exports = { initUpdater };
