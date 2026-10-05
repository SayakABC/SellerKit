// dist/bridge.js
// __sk 桥封装：统一「是否连接宿主」「提示」「复制」「选文件」「业务库调用」，业务层只面对本文件导出的函数。
// 宿主未注入 __sk（脱离宿主直接打开 dist）时，能力调用以明确错误失败，不做静默降级。
//
// ⚠️ 本文件与 ui-plugins/excel-copy/dist/bridge.js 是同一份约定的两个副本（岛之间没有构建期复用），
//    改动时请同步：ready() 的握手语义、store 的合并写回语义、NS 与 manifest.name 的一致性。

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
  }, 2600);
}

/** 复制文本到剪贴板 */
export async function copy(text) {
  if (!connected) throw new Error('未连接到宿主');
  await sk.host.clipboard.writeText(String(text));
}

/** 宿主文件选择（只支持 excel），返回 FilePayload 或 null（用户取消） */
export async function openFile(kind = 'excel') {
  if (!connected) throw new Error('未连接到宿主');
  return sk.host.dialog.openFile({ kind });
}

/** 业务库调用（白名单 domain + op，由宿主权限门判定） */
export function db(domain, op, payload) {
  if (!connected) return Promise.reject(new Error('未连接到宿主'));
  return sk.host.db.call(domain, op, payload);
}

/**
 * 插件命名空间（modules.<id>）。
 * 必须与 manifest.name / 目录名逐字一致 —— 权限门对"自身命名空间"恒放行，
 * 写成别的名字就得额外声明 namespaces，且数据会落到别的命名空间里。
 */
export const NS = 'shipping-rate';

/**
 * 命名空间级读写：一次 IPC 取回/写回整个配置对象。
 *
 * ⚠️ 写回是**合并**语义（宿主侧 modules.<id> = {...old, ...patch}），
 * 所以 patch 只传要改的键即可，不会抹掉别的键；但也因此**无法靠省略键来删除数据**，
 * 要清空某个键得显式传 null（JSON 序列化后为 null，不是消失）——见 store.js 的 clearAll。
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

/**
 * 等待桥就绪（runtime 完成 boot 握手）。
 *
 * ⚠️ `__sk.ready` 本身是 boot 之后才 resolve 的 Promise。早期写法
 * `if (sk.ready) return true` 判断的是「Promise 对象存在」（恒真）→ 从不等待，
 * 会在握手前就发起调用而全部失败，且页面无声地停在"未连接"。这里真正 await 它，并加超时兜底。
 */
export function ready(timeoutMs = 8000) {
  if (!sk || !sk.ready || typeof sk.ready.then !== 'function') return Promise.resolve(false);
  return Promise.race([
    Promise.resolve(sk.ready).then(() => true, () => false),
    new Promise((resolve) => setTimeout(() => resolve(false), timeoutMs)),
  ]);
}
