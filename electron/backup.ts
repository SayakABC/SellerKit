// electron/backup.ts
// 数据备份与恢复（换机迁移）：把本机全部业务数据打包/还原为一个备份文件夹。
// 备份内容（均位于 userData 目录）：
//   sellerkit.db    SQLite 库（订单 / 识别结果 / 款式库 / 款色 / 附加指纹）
//   order-images/   订单主图缓存（缩略图/预览依赖）
//   config.json     electron-store（外壳状态 / TV模版配置 / 模块业务状态）
// 关键点：
//   - 库文件经 VACUUM INTO 生成一致副本（WAL 安全，无需停止应用）
//   - 导入前自动把当前数据备份到 userData/backup_before_import_<ts>/，误操作可找回
//   - 覆盖库文件前先 closeDb()，保证旧连接不持有文件句柄
// 安全边界：入参为目标目录路径（≤4096，仅字符串）；不做任意文件读写。

export {};

const { ipcMain, app, dialog, shell } = require('electron');
const fs = require('fs');
const path = require('path');
const { initDb, getDbFilePath, getDb, closeDb } = require('./db');

const MAX_PATH = 4096;

function isValidPath(v: unknown): v is string {
  return typeof v === 'string' && v.length > 0 && v.length <= MAX_PATH;
}

/** 时间戳目录名：20260901-1530 */
function tsName(): string {
  const d = new Date();
  const p = (n: number) => String(n).padStart(2, '0');
  return `${d.getFullYear()}${p(d.getMonth() + 1)}${p(d.getDate())}-${p(d.getHours())}${p(d.getMinutes())}`;
}

/** SQLite 在线备份：VACUUM INTO 生成一致快照（WAL 安全） */
function vacuumInto(targetPath: string): void {
  const esc = targetPath.replace(/'/g, "''");
  getDb().exec(`VACUUM INTO '${esc}'`);
}

/** 目录内文件数 + 字节数 */
function dirStats(dir: string): { count: number; bytes: number } {
  let count = 0;
  let bytes = 0;
  const walk = (d: string) => {
    if (!fs.existsSync(d)) return;
    for (const name of fs.readdirSync(d)) {
      const p = path.join(d, name);
      const st = fs.statSync(p);
      if (st.isDirectory()) walk(p);
      else {
        count += 1;
        bytes += st.size;
      }
    }
  };
  walk(dir);
  return { count, bytes };
}

// 选择目标文件夹（导出备份的存放位置 / 导入备份的备份目录），支持新建
ipcMain.handle('select-directory', async () => {
  try {
    const r = await dialog.showOpenDialog({
      title: '选择文件夹',
      properties: ['openDirectory', 'createDirectory'],
    });
    if (r.canceled || !r.filePaths[0]) return { success: false, error: '已取消' };
    return { success: true, data: r.filePaths[0] };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// 导出数据备份：targetDir/SellerKit备份_<ts>/（sellerkit.db + order-images/ + config.json）
ipcMain.handle('backup-export', async (_e: any, payload: any) => {
  try {
    if (!isValidPath(payload?.targetDir)) return { success: false, error: 'invalid target dir' };
    if (!fs.existsSync(payload.targetDir) || !fs.statSync(payload.targetDir).isDirectory()) {
      return { success: false, error: '目标文件夹不存在' };
    }
    // 确保库已初始化（VACUUM INTO 需打开连接；空库也输出一致快照）
    initDb();
    const userData = app.getPath('userData');
    const backupDir = path.join(payload.targetDir, `SellerKit备份_${tsName()}`);
    fs.mkdirSync(backupDir, { recursive: true });
    // 1. 数据库一致快照
    vacuumInto(path.join(backupDir, 'sellerkit.db'));
    const dbBytes = fs.statSync(path.join(backupDir, 'sellerkit.db')).size;
    // 2. 图片缓存
    const imageDir = path.join(userData, 'order-images');
    const images = dirStats(imageDir);
    if (fs.existsSync(imageDir) && images.count > 0) {
      fs.cpSync(imageDir, path.join(backupDir, 'order-images'), { recursive: true });
    }
    // 3. electron-store 配置
    const configPath = path.join(userData, 'config.json');
    if (fs.existsSync(configPath)) fs.copyFileSync(configPath, path.join(backupDir, 'config.json'));
    return {
      success: true,
      data: {
        dir: backupDir,
        dbBytes,
        imageCount: images.count,
        imageBytes: images.bytes,
        hasConfig: fs.existsSync(configPath),
      },
    };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// 导入数据备份：校验 → 备份当前数据 → 关闭库连接 → 覆盖 db/images/config → 重启
ipcMain.handle('backup-import', async (_e: any, payload: any) => {
  try {
    if (!isValidPath(payload?.backupDir)) return { success: false, error: 'invalid backup dir' };
    const backupDir = payload.backupDir;
    const dbSrc = path.join(backupDir, 'sellerkit.db');
    if (!fs.existsSync(dbSrc) || !fs.statSync(dbSrc).isFile()) {
      return { success: false, error: '备份目录中未找到 sellerkit.db，请选择正确的备份文件夹' };
    }
    const userData = app.getPath('userData');
    // 1. 当前数据先备份（防误操作，可手工找回）
    const safety = path.join(userData, `backup_before_import_${tsName()}`);
    fs.mkdirSync(safety, { recursive: true });
    const curDb = path.join(userData, 'sellerkit.db');
    if (fs.existsSync(curDb)) fs.copyFileSync(curDb, path.join(safety, 'sellerkit.db'));
    const curImages = path.join(userData, 'order-images');
    if (fs.existsSync(curImages)) fs.cpSync(curImages, path.join(safety, 'order-images'), { recursive: true });
    const curConfig = path.join(userData, 'config.json');
    if (fs.existsSync(curConfig)) fs.copyFileSync(curConfig, path.join(safety, 'config.json'));
    // 2. 关闭当前库连接（覆盖文件前必须释放句柄，SQLite close 时自动 checkpoint WAL）
    closeDb();
    // 3. 覆盖
    fs.copyFileSync(dbSrc, curDb);
    fs.rmSync(curImages, { recursive: true, force: true });
    const imgSrc = path.join(backupDir, 'order-images');
    if (fs.existsSync(imgSrc)) fs.cpSync(imgSrc, curImages, { recursive: true });
    const configSrc = path.join(backupDir, 'config.json');
    if (fs.existsSync(configSrc)) fs.copyFileSync(configSrc, curConfig);
    // 4. 重启（新进程惰性重开数据库）
    app.relaunch();
    app.exit(0);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// 打开本机数据目录（userData），便于手动查看/备份
ipcMain.handle('open-data-dir', async () => {
  try {
    const p = app.getPath('userData');
    const err = await shell.openPath(p);
    return err ? { success: false, error: err } : { success: true, data: p };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});
