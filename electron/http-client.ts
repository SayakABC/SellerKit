// 主进程 HTTP 客户端：基于 Electron `net`（Chromium 网络栈）发起请求，
// 供渲染进程经 IPC 调用，规避浏览器 CORS 限制。
// 安全约束：协议白名单 + 方法白名单 + 响应体大小上限 + 超时中断。

// 标记为 ES 模块，避免顶层声明进入全局作用域与其他主进程文件冲突
export {};

const { net } = require('electron');

const ALLOWED_PROTOCOLS = ['https:', 'http:'];
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'HEAD', 'OPTIONS']);
const MAX_RESPONSE_BYTES = 10 * 1024 * 1024; // 10 MB
const DEFAULT_TIMEOUT_MS = 15000;
const MAX_TIMEOUT_MS = 120000; // 上限 120s：AI 视觉识别等长耗时请求可放宽

/** 仅保留字符串/数字请求头，拒绝对象/数组等危险值 */
function sanitizeHeaders(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers || typeof headers !== 'object' || Array.isArray(headers)) return out;
  for (const [k, v] of Object.entries(headers)) {
    if (typeof v === 'string' || typeof v === 'number') out[k] = String(v);
  }
  return out;
}

/**
 * 发起一次 HTTP 请求（仅支持文本响应）。
 * @param payload { url, method, headers, body, timeout }
 *   timeout 可选：覆盖默认 15s 超时（上限 120s，由上层 IPC 白名单约束）
 * @returns { ok, status, statusText, headers, data }
 * @throws 协议不在白名单 / 方法不在白名单 / 超时 / 响应过大 / 网络错误
 */
function netRequest(payload: {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  timeout?: number;
}): Promise<{ ok: boolean; status: number; statusText: string; headers: Record<string, string>; data: string }> {
  return new Promise((resolve, reject) => {
    const { url, method = 'GET', headers = {}, body } = payload || {};
    const timeoutMs =
      typeof payload?.timeout === 'number' && Number.isFinite(payload.timeout) && payload.timeout > 0
        ? Math.min(Math.floor(payload.timeout), MAX_TIMEOUT_MS)
        : DEFAULT_TIMEOUT_MS;

    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      reject(new Error('Invalid URL'));
      return;
    }
    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      reject(new Error(`Protocol not allowed: ${parsed.protocol}`));
      return;
    }
    const m = String(method).toUpperCase();
    if (!ALLOWED_METHODS.has(m)) {
      reject(new Error(`Method not allowed: ${m}`));
      return;
    }

    const request = net.request({ method: m, url, headers: sanitizeHeaders(headers) });
    let settled = false;
    let size = 0;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.abort();
      reject(new Error(`Request timeout (${timeoutMs}ms)`));
    }, timeoutMs);

    request.on('response', (response) => {
      const status = response.statusCode || 0;
      const statusText = response.statusMessage || '';
      const respHeaders: Record<string, string> = {};
      for (const [k, v] of Object.entries(response.headers || {})) {
        respHeaders[k] = Array.isArray(v) ? v.join(', ') : String(v);
      }
      const chunks: Buffer[] = [];
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_RESPONSE_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.abort();
          reject(new Error(`Response too large (> ${MAX_RESPONSE_BYTES} bytes)`));
        } else {
          chunks.push(chunk);
        }
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        const data = Buffer.concat(chunks).toString('utf-8');
        resolve({ ok: status >= 200 && status < 300, status, statusText, headers: respHeaders, data });
      });
      response.on('error', (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(e);
      });
    });
    request.on('error', (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      reject(e);
    });
    if (body !== undefined && body !== null) {
      request.write(body);
    }
    request.end();
  });
}

const MAX_IMAGE_BYTES = 20 * 1024 * 1024; // 20 MB（图片下载上限，主图场景够用）
const IMAGE_TIMEOUT_MS = 30000;

/**
 * 下载文件到本地（二进制流式落盘，用于订单主图等）。
 * 复用协议白名单与超时机制；响应体上限 20MB。
 * @param url 图片地址（http/https）
 * @param destPath 落盘路径（自动创建父目录）
 * @returns { ok, status, size, error? }
 */
function downloadFile(
  url: string,
  destPath: string,
): Promise<{ ok: boolean; status: number; size: number; error?: string }> {
  return new Promise((resolve) => {
    let parsed: URL;
    try {
      parsed = new URL(url);
    } catch {
      resolve({ ok: false, status: 0, size: 0, error: 'Invalid URL' });
      return;
    }
    if (!ALLOWED_PROTOCOLS.includes(parsed.protocol)) {
      resolve({ ok: false, status: 0, size: 0, error: `Protocol not allowed: ${parsed.protocol}` });
      return;
    }

    const request = net.request({ method: 'GET', url });
    let settled = false;
    let size = 0;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      request.abort();
      resolve({ ok: false, status: 0, size, error: `Download timeout (${IMAGE_TIMEOUT_MS}ms)` });
    }, IMAGE_TIMEOUT_MS);

    const chunks: Buffer[] = [];
    request.on('response', (response) => {
      const status = response.statusCode || 0;
      response.on('data', (chunk: Buffer) => {
        size += chunk.length;
        if (size > MAX_IMAGE_BYTES) {
          if (settled) return;
          settled = true;
          clearTimeout(timer);
          request.abort();
          resolve({ ok: false, status, size, error: `Image too large (> ${MAX_IMAGE_BYTES} bytes)` });
          return;
        }
        chunks.push(chunk);
      });
      response.on('end', () => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        if (status < 200 || status >= 300) {
          resolve({ ok: false, status, size, error: `HTTP ${status}` });
          return;
        }
        try {
          require('fs').mkdirSync(require('path').dirname(destPath), { recursive: true });
          require('fs').writeFileSync(destPath, Buffer.concat(chunks));
          resolve({ ok: true, status, size });
        } catch (e: any) {
          resolve({ ok: false, status, size, error: e.message });
        }
      });
      response.on('error', (e: Error) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve({ ok: false, status, size, error: e.message });
      });
    });
    request.on('error', (e: Error) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve({ ok: false, status: 0, size, error: e.message });
    });
    request.end();
  });
}

module.exports = { netRequest, downloadFile };
