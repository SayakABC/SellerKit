// dist/bridge.js
// __sk 桥封装：统一「是否连接宿主」「提示」「复制」「文件选择」，业务层只面对本文件导出的函数。
// 宿主未注入 __sk（脱离宿主直接打开 dist）时，能力调用以明确错误失败，不做静默降级。

const sk = window.__sk;

/** 是否已连接到宿主桥 */
export const connected = !!sk && typeof sk.host === 'object';

/** 提示（宿主 toast；脱宿主时退化为页面内 toast） */
export function notify(text, kind = 'info') {
  if (sk && sk.host && sk.host.ui) {
    sk.host.ui.notify({ kind, text });
    return;
  }
  const el = document.getElementById('toast');
  if (!el) return;
  el.textContent = text;
  el.className = `toast is-${kind}`;
  el.hidden = false;
  setTimeout(() => {
    el.hidden = true;
  }, 2200);
}

/** 复制文本到剪贴板 */
export async function copy(text) {
  if (!connected) throw new Error('未连接到宿主');
  await sk.host.clipboard.writeText(String(text));
}

/** 宿主文件选择（excel/template/directory），返回 FilePayload 或 null（用户取消） */
export async function openFile(kind = 'excel') {
  if (!connected) throw new Error('未连接到宿主');
  return sk.host.dialog.openFile({ kind });
}

/** 业务库调用（白名单 domain + op，由宿主权限门判定） */
export function db(domain, op, payload) {
  if (!connected) return Promise.reject(new Error('未连接到宿主'));
  return sk.host.db.call(domain, op, payload);
}

/** 插件命名空间（modules.<id>）。与内建 `useModuleStorage('order-insight')` 同源 → 配置天然互通 */
export const NS = 'order-insight';

/**
 * 命名空间级读写：一次 IPC 取回/写回整个配置对象。
 * 用途是需要「读全量再合并」的场景（列映射、分组维度等多字段配置）；
 * 单键读写走 prefs 即可（底层合并写回逻辑相同，但每次都会多一次整对象读取）。
 */
export const store = {
  async all() {
    if (!connected) return {};
    const v = await sk.host.storage.load(NS);
    return v && typeof v === 'object' && !Array.isArray(v) ? v : {};
  },
  async patch(patch) {
    if (!connected) return {};
    const next = { ...(await store.all()), ...(patch || {}) };
    await sk.host.storage.save(NS, next);
    return next;
  },
};

/** 岛内偏好持久化（key 级，落 modules.order-insight；与 store 同一命名空间） */
export const prefs = {
  async get(key) {
    if (!connected) return undefined;
    return sk.storage.load(key);
  },
  async set(key, value) {
    if (!connected) return;
    return sk.storage.save(key, value);
  },
};

/** 订阅宿主总线事件（返回退订函数） */
export function onBus(pattern, cb) {
  if (!connected || !sk.bus) return () => {};
  return sk.bus.on(pattern, cb);
}

/**
 * 等待桥就绪（runtime 完成 boot 握手）。
 * 注意：__sk.ready 本身是 boot 后 resolve 的 Promise —— 旧写法 `if (sk.ready) return true`
 * 判断的是「Promise 对象存在」（恒真），等于从不等待，会在握手前就发起调用而全部失败。
 * 这里真正 await 它，并加超时兜底，避免无声挂在"未连接宿主"。
 */
export function ready(timeoutMs = 8000) {
  if (!sk) return Promise.resolve(false);
  if (!sk.ready || typeof sk.ready.then !== 'function') return Promise.resolve(false);
  return Promise.race([
    Promise.resolve(sk.ready).then(() => true, () => false),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
