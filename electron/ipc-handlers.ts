// 网络相关 IPC handler 注册（主进程入口 require 后自动生效）。
// 入参二次校验：只接受结构白名单内的字段，禁止把渲染层任意对象透传。

// 标记为 ES 模块，避免顶层声明进入全局作用域与其他主进程文件冲突
export {};

const { ipcMain } = require('electron');
const { netRequest } = require('./http-client');

const MAX_URL_LENGTH = 8192;
const MAX_REQUEST_BODY = 10 * 1024 * 1024; // 10 MB

ipcMain.handle('net-request', async (_event: any, payload: any) => {
  try {
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { success: false, error: 'Invalid payload' };
    }
    if (typeof payload.url !== 'string' || payload.url.length === 0 || payload.url.length > MAX_URL_LENGTH) {
      return { success: false, error: 'url is required or too long' };
    }
    if (typeof payload.method !== 'string' || payload.method.length === 0 || payload.method.length > 10) {
      return { success: false, error: 'invalid method' };
    }
    if (
      payload.headers !== undefined &&
      (typeof payload.headers !== 'object' || Array.isArray(payload.headers))
    ) {
      return { success: false, error: 'invalid headers' };
    }
    if (
      payload.body !== undefined &&
      (typeof payload.body !== 'string' || payload.body.length > MAX_REQUEST_BODY)
    ) {
      return { success: false, error: 'invalid body' };
    }
    // 超时白名单：有限正整数且 ≤120s（AI 视觉识别等长耗时请求可放宽，勿再放大）
    let timeoutMs: number | undefined;
    if (payload.timeout !== undefined) {
      if (typeof payload.timeout !== 'number' || !Number.isFinite(payload.timeout)) {
        return { success: false, error: 'invalid timeout' };
      }
      timeoutMs = Math.min(Math.floor(payload.timeout), 120000);
    }

    const result = await netRequest({
      url: payload.url,
      method: payload.method,
      headers: payload.headers || {},
      body: payload.body,
      timeout: timeoutMs,
    });
    return { success: true, data: result };
  } catch (err: any) {
    return { success: false, error: err.message || 'Unknown error' };
  }
});
