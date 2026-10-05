// src/bridge.js — __sk 受控桥封装（岛内唯一宿主访问入口）。
//
// 纪律（AGENTS 红线 16 / 20）：岛内一律走桥，不直连 window.electronAPI / 裸 IPC；
// 能力需在 manifest.json 的 capabilities 中显式声明，否则宿主权限门拒绝并写入审计环。
// 宿主由主进程 sk-plugin:// 协议注入 window.__sk（见 electron/plugin-ui-runtime.js），
// 注入时序早于本模块执行，但仍做惰性取值 + 就绪等待，避免首帧竞态。

/** 惰性取桥（未注入时返回 null） */
function sk() {
  return typeof window !== 'undefined' && window.__sk ? window.__sk : null;
}

/** 是否已完成与宿主的 boot 握手 */
export function isConnected() {
  const s = sk();
  // 注意：host 对象在 boot 之前就已存在，不能用它判断已连接；
  // manifest.id 只在宿主回 boot 时才被运行时写入，是可靠的「已握手」信号。
  return !!s && typeof s.host === 'object' && !!s.manifest && !!s.manifest.id;
}

/**
 * boot 握手等待上限（毫秒）。
 * 超时不让调用方静默悬挂——由 App.vue 转为可行动提示（重试 / 说明），
 * 避免界面停在「加载中」而看不出是握手未完成。
 */
export const BOOT_TIMEOUT_MS = 8000;

/**
 * 等待桥就绪（宿主注入完成 **且** 已收到 boot 握手）。
 *
 * 历史坑（2026-09-21）：这里原先写作 `if (s.ready) return Promise.resolve(true)`，
 * 但运行时的 `window.__sk.ready` 是一个 **Promise**（boot 兑现时才 resolve），恒为真值，
 * 于是 ready() 立刻返回 true：岛在握手完成前就挂载主视图，
 * 首屏用的是 style.css 的浅色回退令牌（深色主题下观感与宿主不一致），
 * 且首个数据调用挂在 boot 上，界面表现为**永久「加载中」**。
 *
 * @param {number} timeoutMs 等待上限；<=0 表示不设上限
 * @returns {Promise<boolean>} 是否在超时前完成握手
 */
export function ready(timeoutMs = BOOT_TIMEOUT_MS) {
  const s = sk();
  if (!s) return Promise.resolve(false);
  return new Promise((resolve) => {
    let done = false;
    const finish = (v) => {
      if (done) return;
      done = true;
      resolve(v);
    };
    // onReady：已 boot 时会被立即回调，否则 boot 后回调（运行时约定）
    if (typeof s.onReady === 'function') {
      try {
        s.onReady(() => finish(true));
      } catch {
        /* 忽略：继续走 ready Promise / 超时 */
      }
    }
    // ready 是 boot 的 Promise；兼容它缺失或非 Promise 的情况
    if (s.ready && typeof s.ready.then === 'function') {
      s.ready.then(
        () => finish(true),
        () => finish(false),
      );
    }
    if (timeoutMs > 0) setTimeout(() => finish(false), timeoutMs);
  });
}

/** 提示（宿主 toast；脱宿主时退化为控制台，不静默吞掉） */
export function notify(text, kind = 'info') {
  const s = sk();
  if (s && s.host && s.host.ui) {
    s.host.ui.notify({ kind, text: String(text) });
    return;
  }
  console.log(`[shop-accounts] ${kind}: ${text}`);
}

/** 复制文本到剪贴板 */
export async function copyText(text) {
  const s = sk();
  if (!s) throw new Error('未连接到宿主');
  await s.host.clipboard.writeText(String(text));
}

/** 业务库调用（白名单 domain + op，由宿主权限门判定） */
export async function dbCall(op, payload) {
  const s = sk();
  if (!s) throw new Error('未连接到宿主：请在 SellerKit 插件市场安装后从侧栏打开');
  return s.host.db.call('shop-accounts', op, payload === undefined ? null : payload);
}

/**
 * 绑到**指定域**的业务库调用 —— 本岛要访问第二个域（`shop`，店铺实体 S1）时用。
 *
 * ⚠️ 签名刻意写成 `db('domain', op, payload)`（域是**字面量第一实参**）：仓库的岛能力守卫
 * （`tests/pluginTriage.spec.ts` 的 `apiBindings`）按 `= (…) => db('domain', …)` 这一形态
 * 解析"哪次调用属于哪个域"。若改成 `dbCall(op, payload, domain)` 之类把域挪到非首参、或由调用方
 * 传变量，两个方向的断言（调用 ⊆ 声明 / 声明的 op 都被调用）会一起**静默失效**，
 * 而报告里看起来仍然是全绿。
 */
export async function db(domain, op, payload) {
  const s = sk();
  if (!s) throw new Error('未连接到宿主：请在 SellerKit 插件市场安装后从侧栏打开');
  return s.host.db.call(String(domain), op, payload === undefined ? null : payload);
}

/** 邮件能力调用（白名单 op） */
export async function mailCall(op, payload) {
  const s = sk();
  if (!s) throw new Error('未连接到宿主：请在 SellerKit 插件市场安装后从侧栏打开');
  return s.host.mail.call(op, payload === undefined ? null : payload);
}

/** 宿主安全存储可用性 */
export async function secretsStatus() {
  const s = sk();
  if (!s) return { secureStorage: false };
  return s.host.secrets.status();
}

/** 命名空间级持久化（落 modules.<ns>） */
export const storage = {
  async load(ns) {
    const s = sk();
    if (!s) return undefined;
    return s.storage.load(ns);
  },
  async save(ns, value) {
    const s = sk();
    if (!s) return;
    return s.storage.save(ns, value);
  },
  async clear(ns) {
    const s = sk();
    if (!s) return;
    return s.storage.clear(ns);
  },
};

/** 订阅宿主总线事件（返回退订函数） */
export function onBus(pattern, cb) {
  const s = sk();
  if (!s || !s.bus) return () => {};
  const off = s.bus.on(pattern, cb);
  return typeof off === 'function' ? off : () => {};
}

/**
 * 请求宿主打开设置中心并定位分类。
 *
 * 背景：本岛设置页已迁入宿主设置中心（manifest.settings 贡献），岛内不再渲染设置内容。
 * 走宿主既有能力 `host.ui.openSettings(category, tab)`（host.ts 内部 dispatch 宿主
 * `open-settings`，由 AppShell 打开 SettingsModal 并定位分类）；`ui` 属轻量能力，
 * gatedHost 默认放行且**不得写入 manifest.capabilities**（写入即安装校验失败）。
 * @param {string} category 设置分类 id（本岛为 `shop-accounts:settings`）
 * @returns {boolean} 是否已发出（未连宿主时为 false）
 */
export function openHostSettingsPanel(category) {
  const s = sk();
  if (!s || !s.host || !s.host.ui || typeof s.host.ui.openSettings !== 'function') {
    // eslint-disable-next-line no-console
    console.warn('[shop-accounts] 未连接到宿主，无法打开宿主设置中心');
    return false;
  }
  s.host.ui.openSettings(String(category || ''));
  return true;
}
