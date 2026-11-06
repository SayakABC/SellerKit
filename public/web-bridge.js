/**
 * 浏览器预览垫片（web preview shim）—— 只在 `npm run dev:web` 这种「纯浏览器看界面」时生效。
 *
 * 为什么需要：
 *   `src/core/services/ipc.ts` 在**模块加载时**就取 `window.electronAPI.platform`，
 *   没有 preload ⇒ TypeError ⇒ 整个模块图崩 ⇒ `#app` 永远是空的（白屏），
 *   不是"数据区留空"这种可读的降级。本文件把这一步补成"能渲染 + 明确报错"。
 *
 * 为什么会出现这种情况（2026-11-06 实测）：
 *   本项目 Electron 44 要求 macOS 13+（`LSMinimumSystemVersion = 13.0`，官方 README 写
 *   "macOS (Ventura and up)"）。而这台开发机是 macOS 12.7.6，直接跑 44 的二进制会
 *   `dyld: Symbol not found: _OBJC_CLASS_$_SMAppService`。于是本机只做前端预览。
 *
 * 安全边界（两条，缺一不可）：
 *   ① `window.electronAPI` 已存在 ⇒ 立即返回。Electron 的 preload 先于页面脚本执行，
 *      所以开发态（同样走 http://localhost:5173）和打包态都走不到这里。
 *   ② 只认 `http:` / `https:`（= vite dev server）。打包产物是 `file://`：
 *      即使哪天 preload 真挂了导致桥缺失，这里也**不许**替它兜底 ——
 *      那种情况必须暴露成真故障，不能伪装成"能用"。
 *
 * 垫片行为：任何 IPC 调用一律返回 ApiResult 的失败形状
 *   `{ success: false, error: "浏览器预览模式：未连接主进程（xxx）" }`，
 *   于是各页走自己的错误分支，显示"未连接主进程"而不是 0 / 空表。
 *   缺就写缺，不给假数字 —— 与本项目「派生非幂等必然漂移」的纪律一致。
 */
(function () {
  if (window.electronAPI) return;
  if (!/^https?:$/.test(location.protocol)) return;

  var ua = navigator.platform || navigator.userAgent || '';
  var platform = /Mac/i.test(ua) ? 'darwin' : /Win/i.test(ua) ? 'win32' : 'linux';

  function fail(name) {
    return function () {
      return Promise.resolve({
        success: false,
        error: '浏览器预览模式：未连接主进程（' + name + '）',
      });
    };
  }

  var staticProps = { platform: platform, isWebPreview: true };

  window.electronAPI = new Proxy(staticProps, {
    get: function (target, prop) {
      if (typeof prop !== 'string') return undefined;
      if (prop in target) return target[prop];
      // then/toJSON 不能被伪造成函数：会把整个桥当成 thenable，await 时行为诡异地跑偏。
      if (prop === 'then' || prop === 'toJSON') return undefined;
      return fail(prop);
    },
  });

  // 让"这是预览模式"在控制台一眼可见，避免有人拿这里的空白数字当结论。
  console.warn(
    '[web-bridge] 浏览器预览模式：未连接主进程，所有 IPC 调用都会返回失败。' +
      '要看真实数据请用 Electron（需 macOS 13+）。'
  );
})();
