// This file is the entry point for the Electron main process.
// We use a wrapper approach to handle ESM-only packages like electron-store.

// 标记为 ES 模块，避免顶层声明进入全局作用域与其他主进程文件冲突
export {};

const { app, BrowserWindow, ipcMain, dialog, clipboard } = require('electron');
const fs = require('fs');
const path = require('path');

// 网络请求 IPC（渲染进程经 axios IPC adapter 调用，主进程用 Electron net 发起请求）
require('./ipc-handlers');
// 订单归类模块 IPC（SQLite 数据访问 + 主图下载/读取）
require('./order-handlers');
// 数据备份/恢复 IPC（换机迁移：导出/导入备份文件夹 + 选择目录 + 打开数据目录）
require('./backup');
// 拿货对账模块 IPC（厂商 / 拿货单 / 付款 / 对账 / 待拿货缺口）
require('./purchase-handlers');
// 外置插件 IPC（Phase 3：独立插件目录 <userData>/plugins 扫描/入口读取/卸载/打开目录）
require('./plugins-handlers');

// 解析默认模板路径：开发模式使用项目根目录，打包后使用 resources 目录
function getDefaultTemplatePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, '默认模板.txt');
  }
  return path.join(app.getAppPath(), '默认模板.txt');
}

let store: any = null;
let mainWindow: any = null;

// Simple JSON-based store as fallback if electron-store fails to load
class SimpleStore {
  private data: any;
  private filePath: string;

  constructor(options: { defaults: any }) {
    const userDataPath = app.getPath('userData');
    this.filePath = path.join(userDataPath, 'config.json');
    try {
      if (fs.existsSync(this.filePath)) {
        this.data = { ...options.defaults, ...JSON.parse(fs.readFileSync(this.filePath, 'utf-8')) };
      } else {
        this.data = { ...options.defaults };
      }
    } catch {
      this.data = { ...options.defaults };
    }
  }

  get store() {
    return this.data;
  }

  get(key: string) {
    return this.data[key];
  }

  set(key: string, value: any) {
    this.data[key] = value;
    this.save();
  }

  private save() {
    try {
      fs.writeFileSync(this.filePath, JSON.stringify(this.data, null, 2), 'utf-8');
    } catch (e) {
      console.error('Failed to save store:', e);
    }
  }
}

async function initStore() {
  // 构建默认配置
  const defaultTemplatePath = getDefaultTemplatePath();
  let defaultTemplateContent = '';
  try {
    if (fs.existsSync(defaultTemplatePath)) {
      defaultTemplateContent = fs.readFileSync(defaultTemplatePath, 'utf-8');
    }
  } catch (e) {
    console.warn('Failed to read default template file:', e);
  }

  const defaultStoreData = {
    lastExcelPath: '',
    lastTemplatePath: '',
    records: [],
    templateConfigs: [
      {
        id: 'default',
        name: '默认模板',
        filePath: defaultTemplatePath,
        content: defaultTemplateContent,
        isBuiltIn: true,
      },
    ],
    activeTemplateId: 'default',
    processingRules: [
      {
        id: 'default_domain',
        name: '域名解析',
        enabled: true,
        targetField: 'domain',
        type: 'jsExpression',
        order: 1,
        config: {
          code: `fields["DNS"].split('.').slice(0, 1)[0]`,
        },
      },
    ],
    visibleColumns: [],
  };

  try {
    const Store = (await import('electron-store')).default;
    store = new Store({ defaults: defaultStoreData });
  } catch (err: any) {
    console.warn('electron-store not available, using SimpleStore:', err);
    store = new SimpleStore({ defaults: defaultStoreData });
  }
}

function createWindow() {
  mainWindow = new BrowserWindow({
    title: 'SellerKit',
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    // 隐藏原生标题栏，改用渲染进程自绘标题栏（与 App 主题同源，实现「一体」效果）
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  mainWindow.webContents.on('will-navigate', (e: any) => {
    if (e.url.startsWith('file://')) {
      const filePath = decodeURIComponent(e.url.replace('file://', ''));
      if (filePath.endsWith('.xlsx') || filePath.endsWith('.xls')) {
        e.preventDefault();
      }
    }
  });

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL('http://localhost:5173');
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

app.whenReady().then(async () => {
  await initStore();
  createWindow();
});

app.on('window-all-closed', () => {
  app.quit();
});

app.on('activate', () => {
  if (mainWindow === null) createWindow();
});

// --- IPC Handlers ---

ipcMain.handle('select-excel', async () => {
  try {
    if (!mainWindow) return { success: false, error: 'No window' };
    const result = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'Excel', extensions: ['xlsx', 'xls'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: 'User canceled' };
    }
    const filePath = result.filePaths[0];
    const buffer = fs.readFileSync(filePath);
    const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
    return { success: true, data: { filePath, data: arrayBuffer } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('select-template', async () => {
  try {
    if (!mainWindow) return { success: false, error: 'No window' };
    const result = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'Text', extensions: ['txt'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: 'User canceled' };
    }
    const filePath = result.filePaths[0];
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, data: { filePath, content } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('read-file', async (_event: any, filePath: string) => {
  try {
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' };
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls') {
      const buffer = fs.readFileSync(filePath);
      const arrayBuffer = buffer.buffer.slice(buffer.byteOffset, buffer.byteOffset + buffer.byteLength);
      return { success: true, data: { filePath, data: arrayBuffer } };
    } else {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { success: true, data: { filePath, content } };
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('write-clipboard', async (_event: any, text: string) => {
  try {
    clipboard.writeText(text);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('save-template', async (_event: any, filePath: string, content: string) => {
  try {
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-store', async () => {
  try {
    return { success: true, data: store.store };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('set-store', async (_event: any, data: Record<string, any>) => {
  try {
    for (const [key, value] of Object.entries(data)) {
      store.set(key, value);
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('check-file-exists', async (_event: any, filePath: string) => {
  try {
    return { success: true, data: fs.existsSync(filePath) };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('get-default-template-path', async () => {
  try {
    return { success: true, data: getDefaultTemplatePath() };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// 应用版本号：开发与打包均返回 package.json 的 version（app.getVersion() 读取）
ipcMain.handle('get-app-version', async () => {
  try {
    return { success: true, data: app.getVersion() };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// --- 模块命名空间持久化（Phase 1） ---
// 数据落在 `modules.<id>` 命名空间下，模块之间互不污染。
// 首次读取 excel-copy 命名空间时，做一次从旧扁平结构的数据迁移（无损）。

const MODULE_NS_PREFIX = 'modules.';

ipcMain.handle('get-module-state', async (_event: any, moduleId: string) => {
  try {
    const nsKey = MODULE_NS_PREFIX + moduleId;
    let data = store.get(nsKey);
    if (data === undefined || data === null) {
      if (moduleId === 'excel-copy') {
        const hasLegacy =
          store.get('records') !== undefined || store.get('templateConfigs') !== undefined;
        if (hasLegacy) {
          const legacy = {
            lastExcelPath: store.get('lastExcelPath') ?? '',
            lastTemplatePath: store.get('lastTemplatePath') ?? '',
            records: store.get('records') ?? [],
            templateConfigs: store.get('templateConfigs') ?? [],
            activeTemplateId: store.get('activeTemplateId') ?? 'default',
            processingRules: store.get('processingRules') ?? [],
            visibleColumns: store.get('visibleColumns') ?? [],
          };
          store.set(nsKey, legacy);
          // 清理旧的扁平 key，避免与新命名空间并存造成混淆
          ['lastExcelPath', 'lastTemplatePath', 'records', 'templateConfigs', 'activeTemplateId', 'processingRules', 'visibleColumns'].forEach(
            (k) => store.set(k, undefined),
          );
          data = legacy;
        }
      }
    }
    return { success: true, data: data ?? null };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

ipcMain.handle('set-module-state', async (_event: any, moduleId: string, data: any) => {
  try {
    store.set(MODULE_NS_PREFIX + moduleId, data);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// 恢复出厂设置：删除持久化数据后重启
ipcMain.handle('reset-store', async () => {
  try {
    const configPath = path.join(app.getPath('userData'), 'config.json');
    if (fs.existsSync(configPath)) {
      fs.unlinkSync(configPath);
    }
    app.relaunch();
    app.exit(0);
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// 自定义标题栏的窗口控制（最小化 / 最大化切换 / 关闭）
ipcMain.handle('win-control', async (_event: any, action: 'minimize' | 'maximize' | 'close') => {
  try {
    if (!mainWindow) return { success: false, error: 'No window' };
    if (action === 'minimize') {
      mainWindow.minimize();
    } else if (action === 'maximize') {
      if (mainWindow.isMaximized()) mainWindow.unmaximize();
      else mainWindow.maximize();
    } else if (action === 'close') {
      mainWindow.close();
    }
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});
