// This file is the entry point for the Electron main process.
// We use a wrapper approach to handle ESM-only packages like electron-store.

// 标记为 ES 模块，避免顶层声明进入全局作用域与其他主进程文件冲突
export {};

const { app, BrowserWindow, ipcMain, dialog, Tray, Menu, nativeImage } = require('electron');
const fs = require('fs');
const path = require('path');
const { pathToFileURL } = require('url');

/** 开发服务器地址（dev 模式 loadURL 与导航白名单共用一处，避免两处漂移） */
const DEV_SERVER_URL = 'http://localhost:5173';

// 网络请求 IPC（渲染进程经 axios IPC adapter 调用，主进程用 Electron net 发起请求）
require('./ipc-handlers');
// 剪贴板 IPC（文本 + 图片；图片通道是「复制给厂家」的最后一跳）
require('./clipboard-handlers');
// 订单归类模块 IPC（SQLite 数据访问 + 主图下载/读取）
require('./order-handlers');
// 数据备份/恢复 IPC（换机迁移：导出/导入备份文件夹 + 选择目录 + 打开数据目录）
require('./backup');
// 拿货对账模块 IPC（厂商 / 拿货单 / 付款 / 对账 / 待拿货缺口）
require('./purchase-handlers');
// 外置插件 IPC（Phase 3：独立插件目录 <userData>/plugins 扫描/入口读取/卸载/打开目录）
require('./plugins-handlers');
// 插件市场 IPC（Market：拉取 catalog + 下载 zip 安装外置插件，主进程防线）
require('./plugins-market-handlers');
// P0 POC：外置富 UI 插件运行时协议 sk-plugin://（模块顶层 registerSchemesAsPrivileged 须在 app ready 前执行）
const { initPluginUiProtocol } = require('./plugin-ui-protocol');
// 邮件正文渲染协议 sk-mail://（同样须在 app ready 前注册 scheme）—— 正文里的 cid/远程图片靠它显示
const { registerMailBodyScheme, initMailBodyProtocol } = require('./mail-body-protocol');
registerMailBodyScheme();
// 自动更新 IPC（GitHub Releases：checkForUpdates / quitAndInstall + updater-event 广播）
const updater = require('./updater');
// 速卖通订单采集：localhost 接收端（应用就绪后自启）+ 语义化查询 IPC（ae-db-ensure / ae-receiver-status / settle-* / ae-cost-map-* / ae-rate-*）
const aeReceiver = require('./ae-receiver');
require('./ae-handlers');
// 店铺账号管家 IPC（账号元数据 CRUD + safeStorage 加密的密码字段）
require('./shop-accounts-handlers');
// 企业管理 IPC（企业基本信息 CRUD + 欧代/土代/德国包装法等合规资料）
require('./company-handlers');
// 产品库 IPC（产品主数据 CRUD + 汇总；pl_products 属主数据层，随宿主分发 —— ADR-002 C3）
require('./product-handlers');
// 主数据字典 IPC（颜色 / 尺码的只读面；R1 / S0a）
require('./master-data-handlers');
// 店铺实体 IPC（sk_shops / sk_name_map：店铺登记 + 两处历史店铺名的归一）
// 同属主数据层，随宿主分发 —— 历史文本不改写，靠映射旁挂关联（DOMAIN_INTEGRATION_PLAN S1/G2）
require('./shop-handlers');
// 店铺商品快照 IPC（采集而来的商品清单：列表 / 汇总；落 pl_shop_items，与 pl_shop_sku 认款写路径解耦）
require('./shop-item-handlers');
// 店铺商品清单 IPC（商品清单导入/列表/删除 + 商品↔产品一对多关联；表结构由 product-db 建，见 pl_shop_sku）
require('./shop-product-handlers');
// 运价表快照 IPC（报价单导入时留档 + 算账按生效日取当时那份；运价表属主数据，挂宿主中立层 —— ADR-002 C3）
require('./ship-rate-handlers');
// 拣货 IPC（未发货订单行投影：款色码 + 三层回落图 + 供应商；**只回投影，聚合与口径在渲染层纯函数**）
require('./picking-handlers');
// 图案域 IPC（POD：绑定台 / 报单 / 余量看板；图案与变体键绑定是本域唯一写入口）
require('./pod-handlers');
// 记账 IPC（店铺收支 + 公共费用分摊 + 资金相关人往来结算；分摊算法只在 src/lib/ledger.ts，本域只做守恒断言）
require('./ledger-handlers');
// 集中邮件收件箱 IPC（IMAP 只读同步：账号接入 / 连接测试 / 同步 / 本地邮件查询）
const mailEngine = require('./mail-engine');
require('./mail-handlers');
// 邮件后台收信调度（定时器 + 新邮件系统通知）。必须在主进程：渲染层轮询只在「邮件」页
// 挂载时存在，冷启动不进该页 / 关窗口到托盘时都不会跑（2026-11-04 修「不会自动收信」）
const mailScheduler = require('./mail-scheduler');
// 主进程 →「界面意图」下发（打开模块 / 侧栏徽标）：通知点击与未读角标都走这里
const uiBridge = require('./ui-bridge') as typeof import('./ui-bridge');
const { publishMailUnreadBadge } = require('./mail-badge') as typeof import('./mail-badge');
// schema 启动编排（顺序有依赖，见 app.whenReady 内的注释）：企业 → 店铺（含迁移）→ 邮件
const { ensureCompanySchema } = require('./company-db') as typeof import('./company-db');
const { ensureShopSchema } = require('./shop-db') as typeof import('./shop-db');
const { ensureMailSchema } = require('./mail-db') as typeof import('./mail-db');
// 「用户显式选择过的文件」白名单：收紧 read-file / save-template / check-file-exists 的路径权限（H-02）
const { initApprovedUserFiles, approveUserFile, isUserFileAllowed, MAX_TEMPLATE_CHARS } =
  require('./user-file-allowlist') as typeof import('./user-file-allowlist');
// 规则求值隔离窗口（S0）：`jsExpression` 的 new Function 从主窗口搬到这里执行，
// 该窗口无 electronAPI、CSP `connect-src 'none'`，见 electron/rule-eval-window.ts 头部说明。
const ruleEval = require('./rule-eval-window') as typeof import('./rule-eval-window');
ruleEval.initRuleEval();
// 开机自动化（M5）：托盘 / 自启 / 定时同步的编排在 scheduler.ts，判定在 schedulerPlan.ts
const scheduler = require('./scheduler') as typeof import('./scheduler');
const { HIDDEN_ARG, shouldStartHidden } = require('./schedulerPlan') as typeof import('./schedulerPlan');

// 解析默认模板路径：开发模式使用项目根目录，打包后使用 resources 目录
function getDefaultTemplatePath(): string {
  if (app.isPackaged) {
    return path.join(process.resourcesPath, '默认模板.txt');
  }
  return path.join(app.getAppPath(), '默认模板.txt');
}

let store: any = null;
let mainWindow: any = null;
/** 托盘（M5·T5-1）；`null` = 没建出来（那时关窗仍退出，行为与旧版一致） */
let tray: any = null;
/**
 * 「真的在退出」。
 *
 * 有托盘之后，**关窗口 ≠ 退出**（T5-1 的判据就是"关窗口不退出进程"）：托盘菜单与
 * macOS 的 ⌘Q / 系统关机才会置这个标记。少了它，用户点红点就再也收不到今天的自动同步。
 */
let isQuitting = false;
/** 本次启动是否隐藏（开机自启不许弹窗，T5-2） */
const START_HIDDEN = shouldStartHidden(process.argv);

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
    records: [] as unknown[],
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
    visibleColumns: [] as string[],
  };

  try {
    const Store = (await import('electron-store')).default;
    store = new Store({ defaults: defaultStoreData });
  } catch (err: any) {
    console.warn('electron-store not available, using SimpleStore:', err);
    store = new SimpleStore({ defaults: defaultStoreData });
  }

  // 装载「用户已选文件」白名单（H-02）。必须在任何按路径读写的通道被调用之前完成。
  initApprovedUserFiles(store);
}

function createWindow(show = !START_HIDDEN) {
  mainWindow = new BrowserWindow({
    title: 'SellerKit',
    width: 1200,
    height: 800,
    minWidth: 900,
    minHeight: 600,
    // 开机自启的隐藏启动（T5-2）：`--hidden` 时**不显示**窗口，只留托盘。
    // 这里用 `show` 而不是创建后再 hide：后者会先闪一下窗口再消失（用户看到的最像是"弹广告"）。
    show,
    // 隐藏原生标题栏，改用渲染进程自绘标题栏（与 App 主题同源，实现「一体」效果）
    titleBarStyle: 'hidden',
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  // —— 导航收敛：只放行「应用自身的 URL」，其余一律拦下 ——
  // 原实现只拦 `.xlsx/.xls` 两种后缀，等于把「把任意本地 .html 拖进窗口」放行：
  // 该文档会在**主窗口**内加载，而 preload 绑定在 webContents 上、不随 URL 变化
  // → 这个第三方页面直接拥有 window.electronAPI（全部暴露键）。
  // 业务上「文件来自第三方（供应商 Excel、别人发来的模板）」是常态，这条路径足够现实。
  // 注：loadURL/loadFile 这类主进程发起的导航不触发 will-navigate，SPA 的 pushState 也不触发，
  // 因此这里拦不到正常流程。
  const ownUrls = new Set([
    DEV_SERVER_URL,
    pathToFileURL(path.join(__dirname, '../renderer/index.html')).toString(),
  ]);
  mainWindow.webContents.on('will-navigate', (e: any, url: string) => {
    const target = String(url || e?.url || '');
    // 同文档内的 hash/query 变化不算导航
    if (ownUrls.has(target.split(/[?#]/)[0])) return;
    e.preventDefault();
  });

  // —— 禁止 window.open() / target="_blank" 真的开出新窗口 ——
  // 新窗口会继承同样的 preload 与 IPC 暴露面，故一律拒绝。
  // 外链有专门的出口：`open-external` 通道（clipboard-handlers.ts，只放行 http/https，
  // 优先 Chrome、用不了回落系统默认浏览器，见 browser-open.ts）。渲染层想开网页一律走它 —— 直接写
  // `<a target="_blank">` 在这里被静默拒绝，表现为"点了没反应"（2026-10-16 店铺登记页「打开」就是这么坏的）。
  mainWindow.webContents.setWindowOpenHandler(() => ({ action: 'deny' }));

  if (process.env.NODE_ENV === 'development' || !app.isPackaged) {
    mainWindow.loadURL(DEV_SERVER_URL);
    mainWindow.webContents.openDevTools();
  } else {
    mainWindow.loadFile(path.join(__dirname, '../renderer/index.html'));
  }

  mainWindow.on('closed', () => {
    mainWindow = null;
  });

  // 页面就绪后重放「最后一次界面意图」（未读徽标 / 待打开的模块）。
  // 窗口可能是刚刚被通知点击新建的，那时 `webContents.send` 只会被静默丢弃 ——
  // 缓存在 ui-bridge，等到这一刻才送得出去（见该文件纪律 ②）。
  mainWindow.webContents.on('did-finish-load', () => {
    try {
      uiBridge.flushUiBridge();
    } catch (err: any) {
      console.warn('[main] 重放界面意图失败：', err?.message || err);
    }
  });
}

/** 把主窗口拿出来（托盘菜单 / 通知点击 / Dock 激活共用一处，避免三份 `isMinimized` 判断） */
function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed?.()) {
    createWindow(true);
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

/**
 * 通知点击：把主窗口拿出来**并切到「邮件」**。
 *
 * 与 `showMainWindow` 分开是因为语义不同：托盘「显示主窗口」只是"我要回到应用"，
 * 用户上次停在哪页就还是哪页；而新邮件通知的语义是"带我去看这几封信"。
 * 页面尚未就绪时 `openModule` 会缓存，由 `did-finish-load` 重放，不会丢。
 */
function openMailInbox() {
  showMainWindow();
  uiBridge.openModule('mail');
}

/**
 * 托盘图标路径（M5·T5-1）。
 *
 * 打包后走 `extraResources`（electron-builder.yml 里 build/ 下的图标 → resources 根目录），
 * 开发模式直接读仓库里的 `build/`。
 * macOS 用专用模板图：`setTemplateImage(true)` 只按 alpha 渲染剪影，彩色应用图标带整块
 * 不透明底板 ⇒ 剪影退化成实心圆角方块、S 完全消失；故单独一份透明底单色轮廓。
 * Windows 保持原色（应用图标 256px 缩到 16px）。
 * 找不到图标时**不建托盘**（返回空串）：一个看不见又点不到的托盘比重启后没有托盘更坏
 * —— 而且关窗不退出会变成"应用消失了但进程还在"。
 */
function trayIconPath(): string {
  const name = process.platform === 'darwin' ? 'tray-template.png' : 'icon.png';
  const candidate = app.isPackaged
    ? path.join(process.resourcesPath, name)
    : path.join(app.getAppPath(), 'build', name);
  return fs.existsSync(candidate) ? candidate : '';
}

/**
 * 建托盘 + 三项菜单（T5-1：显示 / 立即同步 / 退出）。
 *
 * 为什么要有托盘：开机自启 + 关窗不退出之后，**没有托盘就再也找不到应用**（
 * macOS 还有 Dock，Windows 就只有任务管理器）。托盘是隐藏启动的配套，不是装饰。
 */
function createTray() {
  const iconPath = trayIconPath();
  if (!iconPath) {
    console.warn('[main] 找不到托盘图标，本次不建托盘（关窗仍退出）');
    return;
  }
  try {
    const base = nativeImage.createFromPath(iconPath);
    // macOS：模板图自带 18px 与 @2x 36px 两个表示，createFromPath 会按同目录的 @2x
    // 文件自动合并；这里**不 resize**，否则会把多表示压平成单张，高分屏菜单栏发虚。
    // Windows 保持原色并缩到 16px。
    const image =
      process.platform === 'darwin' ? base : base.resize({ width: 16, height: 16 });
    // macOS 托盘用模板图（系统按深浅色自动反相）；Windows 保持原色
    if (process.platform === 'darwin') image.setTemplateImage(true);
    tray = new Tray(image);
    tray.setToolTip('SellerKit');
    tray.setContextMenu(
      Menu.buildFromTemplate([
        { label: '显示主窗口', click: () => showMainWindow() },
        {
          label: '立即同步',
          // 人点的不受"今天已同步 / 一天 3 次"约束（那两条是给自动补跑的），但仍会留日志
          click: () => {
            scheduler.runAutoSync('manual').catch((err: any) => {
              console.warn('[main] 手动同步异常：', err?.message || err);
            });
          },
        },
        { type: 'separator' },
        {
          label: '退出',
          click: () => {
            isQuitting = true;
            app.quit();
          },
        },
      ]),
    );
    // 左键点图标 = 显示主窗口（macOS 上右键/左键都会出菜单，这里只兜住"点图标"的直觉）
    tray.on('click', () => showMainWindow());
  } catch (err: any) {
    console.warn('[main] 建托盘失败：', err?.message || err);
    tray = null;
  }
}

/**
 * 开机自启 + 隐藏启动（T5-2）。
 *
 * 三条刻意的限制：
 *   · **只在打包版**改这个系统设置 —— 开发时一跑 `npm run dev` 就往用户的自启项里塞一条
 *     "用 electron 打开这个仓库"，既跑不起来也删不掉（用户只能自己去系统设置里找）。
 *   · Windows / Linux 的 `openAsHidden` **不生效**，必须把 `--hidden` 写进自启参数里；
 *     `shouldStartHidden(process.argv)` 读的就是这个标记（两处同字，改一处要改两处）。
 *   · 允许用 `SELLERKIT_DISABLE_AUTOSTART=1` 关掉（排障 / 不想自启的用户）。
 */
function configureLoginItem() {
  if (process.env.SELLERKIT_DISABLE_AUTOSTART === '1') {
    console.log('[main] 已按 SELLERKIT_DISABLE_AUTOSTART=1 跳过开机自启配置');
    return;
  }
  if (!app.isPackaged) {
    console.log('[main] 开发模式不改开机自启（改用 SELLERKIT_AUTO_SYNC=1 单独测自动同步）');
    return;
  }
  try {
    const settings: { openAtLogin: boolean; openAsHidden?: boolean; args?: string[] } = {
      openAtLogin: true,
    };
    if (process.platform === 'darwin') settings.openAsHidden = true;
    else settings.args = [HIDDEN_ARG];
    app.setLoginItemSettings(settings);
  } catch (err: any) {
    // 自启失败不许阻断启动（Windows 组策略 / 受限账户都可能拒绝）
    console.warn('[main] 配置开机自启失败：', err?.message || err);
  }
}

app.whenReady().then(async () => {
  await initStore();
  // ① 企业表 + 支付宝列 → ② 店铺主迁移（会重建 sk_shops / sk_mail_accounts，并把旧账号的
  // 手机号/支付宝并进企业）→ ③ 邮件表幂等收尾（FTS / 补列）。
  // 各 handler 里仍有懒 ensure；这里只为保证「第一次 IPC 之前」跑完，且顺序不靠碰巧。
  // 失败必须显式停下：带着半旧半新的库继续跑，会把「查不到数据」伪装成「没有数据」。
  try {
    ensureCompanySchema();
    ensureShopSchema();
    ensureMailSchema();
  } catch (err: any) {
    const detail = String(err?.message || err || '未知错误');
    dialog.showErrorBox(
      '数据升级未完成',
      `应用已停止启动，你的原始数据没有被改动。\n\n请把下面这句话发给开发者：\n${detail}\n\n` +
        '如果数据目录里出现以 .bak-shop-merge-v1- 开头的备份文件，说明升级前已自动备份，可交给开发者恢复。',
    );
    app.quit();
    return;
  }
  // 注册 sk-plugin:// 请求处理（先于窗口创建，保证 iframe 首次导航即可命中）
  initPluginUiProtocol();
  // 注册 sk-mail:// 请求处理：邮件正文（含内联/远程图片）的渲染入口
  initMailBodyProtocol();
  // Windows 的系统通知要 appUserModelId（否则通知静默不弹；macOS/Linux 无此要求）
  if (process.platform === 'win32') app.setAppUserModelId('com.sellerkit.app');
  createWindow();
  // 托盘（T5-1）：建在窗口之后 —— 托盘菜单的「显示主窗口」需要一个窗口可显示；
  // 托盘建不出来时 `tray === null`，`window-all-closed` 会退回"关窗即退出"的旧行为。
  createTray();
  // 开机自启 + 隐藏启动（T5-2）
  configureLoginItem();
  // 注入窗口引用：updater.ts 随即注册 autoUpdater 事件（向渲染层广播 updater-event）
  updater.initUpdater(() => mainWindow);
  // 邮件同步进度广播（mail-sync-event）同样需要窗口引用
  mailEngine.setMailEventWindow(() => mainWindow);
  // 界面意图（open-module / nav-badge）的窗口引用；随后先播一次未读数，
  // 冷启动那一刻窗口多半还在加载，值会缓存起来、由 did-finish-load 重放。
  uiBridge.setUiBridgeWindow(() => mainWindow);
  publishMailUnreadBadge();
  // 邮件后台收信：首轮延迟 15s（等 schema / 窗口 / 网络），间隔按渲染层下发的设置排程；
  // 新邮件只在**自动轮次**弹系统通知，点通知 = 拿出窗口并切到「邮件」（见 openMailInbox）
  mailScheduler.setMailSchedulerWindowHook({ show: showMainWindow, openInbox: openMailInbox });
  mailScheduler.startMailScheduler();
  // 采集入库广播（ae-items-ingested）：扩展推帧落库后，已打开的页面据此重拉
  aeReceiver.setAeEventWindow(() => mainWindow);
  // 通知点击 / 托盘菜单都从这一处拿窗口
  scheduler.setAutoSyncWindowHooks({ show: showMainWindow });
  // 开机自动同步（T5-3）：**打包版默认开**；开发模式下会一重启就开一次 Chrome，
  // 所以只在显式 `SELLERKIT_AUTO_SYNC=1` 时才跑（手动测这条链路就加这个环境变量）。
  if (app.isPackaged || process.env.SELLERKIT_AUTO_SYNC === '1') {
    scheduler.startAutoSync();
  } else {
    console.log('[main] 开发模式跳过启动时自动同步（要测就 SELLERKIT_AUTO_SYNC=1 npm run dev）');
  }
});

app.on('before-quit', () => {
  // ⌘Q / 系统关机 / updater 的 quitAndInstall 都走这里：置了标记后 `window-all-closed` 才真的退
  isQuitting = true;
  // 求值窗口是隐藏窗口：不主动销毁会拖住退出（用户看到"点了退出没反应"）
  ruleEval.shutdownRuleEval();
});

app.on('window-all-closed', () => {
  // 有托盘时**关窗口不退出**（T5-1 的判据）：退出了就再也不会自动同步今天的单。
  // 没有托盘（图标缺失 / 建失败）时保持旧行为，否则应用会变成"看不见的常驻进程"。
  if (isQuitting || !tray) app.quit();
});

app.on('activate', () => {
  showMainWindow();
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
    // 用户经对话框真实选过 → 落白名单，后续 read-file / check-file-exists 才放行（H-02）
    approveUserFile(filePath);
    const buffer = fs.readFileSync(filePath);
    const arrayBuffer = buffer.buffer.slice(
      buffer.byteOffset,
      buffer.byteOffset + buffer.byteLength
    );
    return { success: true, data: { filePath, data: arrayBuffer } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// 选择图片文件（产品库主图 / 商品ID覆盖图）。只返回路径不读内容 ——
// 内容由 product-image-attach 等写通道按需读取并复制进 product-images 缓存。
// 用户经对话框真实选过 → 落白名单（与 select-excel 同一 H-02 语义）。
ipcMain.handle('select-image', async () => {
  try {
    if (!mainWindow) return { success: false, error: 'No window' };
    const result = await dialog.showOpenDialog(mainWindow, {
      filters: [{ name: 'Images', extensions: ['jpg', 'jpeg', 'png', 'webp'] }],
      properties: ['openFile'],
    });
    if (result.canceled || result.filePaths.length === 0) {
      return { success: false, error: 'User canceled' };
    }
    const filePath = result.filePaths[0];
    approveUserFile(filePath);
    return { success: true, data: { filePath } };
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
    // 同上：模板文件同样要落白名单，否则「导入模板 → 保存写回文件」会在下次启动失败
    approveUserFile(filePath);
    const content = fs.readFileSync(filePath, 'utf-8');
    return { success: true, data: { filePath, content } };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// 按路径读取（模板 .txt / Excel .xlsx）。
// 安全（H-02）：**只允许**宿主内置模板文件与用户经对话框真实选过的文件。
// 本通道在 `src/` 里的唯一调用点是插件内核 `host.ts` 的业务库白名单，
// 也就是 UI 岛的能力面 —— 不设限就等于"声明了 db 域的岛 = 全盘读"。不要放宽。
ipcMain.handle('read-file', async (_event: any, filePath: string) => {
  try {
    if (!isUserFileAllowed(filePath, [getDefaultTemplatePath()])) {
      return { success: false, error: 'path not allowed' };
    }
    if (!fs.existsSync(filePath)) {
      return { success: false, error: 'File not found' };
    }
    const ext = path.extname(filePath).toLowerCase();
    if (ext === '.xlsx' || ext === '.xls') {
      const buffer = fs.readFileSync(filePath);
      const arrayBuffer = buffer.buffer.slice(
        buffer.byteOffset,
        buffer.byteOffset + buffer.byteLength
      );
      return { success: true, data: { filePath, data: arrayBuffer } };
    } else {
      const content = fs.readFileSync(filePath, 'utf-8');
      return { success: true, data: { filePath, content } };
    }
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// 写回模板文件。
// 安全（H-02）：路径同 read-file 的白名单；另加内容长度上限（原实现无上限）。
// 这一条尤其要紧 —— 原实现等于"任意可写文件的覆写原语"，而 op 名叫 saveTemplateFile，
// 严重低估了它的实际权力。
ipcMain.handle('save-template', async (_event: any, filePath: string, content: string) => {
  try {
    if (!isUserFileAllowed(filePath, [getDefaultTemplatePath()])) {
      return { success: false, error: 'path not allowed' };
    }
    if (typeof content !== 'string') {
      return { success: false, error: 'invalid content' };
    }
    if (content.length > MAX_TEMPLATE_CHARS) {
      return {
        success: false,
        error: `模板内容过大（上限 ${Math.round(MAX_TEMPLATE_CHARS / 1024)}KB）`,
      };
    }
    fs.writeFileSync(filePath, content, 'utf-8');
    return { success: true };
  } catch (err: any) {
    return { success: false, error: err.message };
  }
});

// 路径存在性探测。
// 安全（H-02）：它本身就是一个"信息面"。不允许的路径一律返回 false ——
// 与"文件不存在"不可区分，不泄露任何信息；也不抛错，岛侧 `if (r) reload()` 的写法
// 会自然跳过，行为等同于"上次那个文件已不在了"（拖拽导入时 filePath 只是文件名占位，
// 走的正是这条分支，原本也查不到）。
ipcMain.handle('check-file-exists', async (_event: any, filePath: string) => {
  try {
    if (!isUserFileAllowed(filePath, [getDefaultTemplatePath()])) {
      return { success: true, data: false };
    }
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
          [
            'lastExcelPath',
            'lastTemplatePath',
            'records',
            'templateConfigs',
            'activeTemplateId',
            'processingRules',
            'visibleColumns',
          ].forEach((k) => store.set(k, undefined));
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
