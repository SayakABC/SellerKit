// dist/bridge.js
// __sk 桥封装：统一「是否连接宿主」「提示」「复制」「文件选择」「业务库调用」，业务层只面对本文件导出的函数。
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

/** 宿主文件选择（excel/template），返回 FilePayload 或 null（用户取消） */
export async function openFile(kind = 'excel') {
  if (!connected) throw new Error('未连接到宿主');
  return sk.host.dialog.openFile({ kind });
}

/** 业务库调用（白名单 domain + op，由宿主权限门判定） */
export function db(domain, op, payload) {
  if (!connected) return Promise.reject(new Error('未连接到宿主'));
  return sk.host.db.call(domain, op, payload);
}

/** 插件命名空间（modules.<id>）。与内建 `useModuleStorage('excel-copy')` 同源 → 配置天然互通 */
export const NS = 'excel-copy';

/**
 * 命名空间级读写：一次 IPC 取回/写回整个配置对象。
 * 本岛的配置是「整块」语义（记录 / 模板 / 规则 / 显示列必须一起读、一起写），
 * 所以直接用 all()/patch()，而不是逐键 prefs。
 *
 * ⚠️ 写回是**合并**语义（宿主侧 modules.<id> = {...old, ...patch}），
 * 因此绝不能传一个「只含部分字段」的对象当作全量 —— 那样不会丢数据，但也不会删数据。
 * 需要删除某个键时显式传 undefined（JSON 序列化后该键消失），见 store.js 的 collect()。
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
