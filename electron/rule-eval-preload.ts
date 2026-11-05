// electron/rule-eval-preload.ts
// 求值窗口的**最小** preload。
//
// 为什么这里可以有 preload（而计划文档写的是「无 preload」）：
//   该窗口要双向收发消息（主进程下发批次 / 页面回传结果），而 ipcRenderer 只在 preload
//   上下文里可用；没有 preload 就只能靠 `executeJavaScript` 拼字符串，几万行时拼接与二次
//   序列化的开销比消息通道更大。真正的不变量是「窗口不持任何能力」，不是「没有 preload 文件」：
//     · 只暴露 `__ruleEvalBridge` 的两个方向转发（onBatch / postResult）；
//     · 不暴露 fs / shell / ipcRenderer 本体 / 任何 DB 通道；
//     · webPreferences 仍是 sandbox: true + contextIsolation: true。
//   判据见 scripts/rule-eval-smoke.cjs：窗口内 `window.electronAPI === undefined` 必须成立。

export {};

const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('__ruleEvalBridge', {
  /** 订阅主进程下发的批次。回调抛错必须回传，否则主进程只能等到超时（排查会变成"莫名其妙 2s"） */
  onBatch: (cb: (payload: any) => void): void => {
    ipcRenderer.on('rule-eval:batch', (_e: any, payload: any) => {
      try {
        cb(payload);
      } catch (err: any) {
        ipcRenderer.send('rule-eval:result', {
          id: payload?.id,
          result: { ok: false, error: String(err?.message || err) },
        });
      }
    });
  },
  postResult: (id: number, result: unknown): void => {
    ipcRenderer.send('rule-eval:result', { id, result });
  },
});
