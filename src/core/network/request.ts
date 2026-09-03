/**
 * 渲染进程统一请求入口（Axios）。
 *
 * 设计要点：
 * - 默认走 IPC adapter → 主进程 Electron `net` 发起请求，规避浏览器 CORS 限制；
 *   调试期可通过 .env 的 VITE_REQUEST_ENGINE=xhr 切回浏览器 XHR。
 * - 请求拦截器自动附加 Authorization: Bearer <token>；
 * - 响应拦截器在 401 时清除本地 token，其余错误原样透传。
 * - 当前仅支持文本型请求体/响应体（JSON 序列化传输）。
 */
import axios, { AxiosError, AxiosResponse, InternalAxiosRequestConfig } from 'axios';
import { getToken, setToken } from './token';
import type { NetRequestPayload, NetRequestResult } from './types';
import { ipc } from '@/core/services/ipc';

/** 请求引擎：ipc（默认，Electron net）/ xhr（浏览器调试） */
const REQUEST_ENGINE: 'ipc' | 'xhr' = import.meta.env.VITE_REQUEST_ENGINE === 'xhr' ? 'xhr' : 'ipc';

/** 默认 API 基础地址（创建实例时可通过 baseURL 覆盖） */
export const DEFAULT_BASE_URL: string = import.meta.env.VITE_API_BASE_URL || '';

/** 拼接 baseURL 与相对路径（与 axios 内置 buildFullPath 语义一致） */
function resolveUrl(baseURL: string | undefined, url: string | undefined): string {
  if (!url) return '';
  if (/^https?:\/\//i.test(url)) return url;
  if (!baseURL) return url;
  return baseURL.replace(/\/+$/, '') + '/' + url.replace(/^\/+/, '');
}

/** 将 AxiosHeaders 拍平为普通对象（仅取字符串/数字/布尔值） */
function headersToRecord(headers: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (!headers) return out;
  try {
    const raw: unknown =
      typeof (headers as { toJSON?: () => unknown }).toJSON === 'function'
        ? (headers as { toJSON: () => unknown }).toJSON()
        : headers;
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[k] = String(v);
    }
  } catch {
    // 头部序列化异常时按空头处理，不阻断请求
  }
  return out;
}

/** 尝试按 JSON 解析响应体，失败则原样返回文本 */
function tryParse<T>(text: string): T | string {
  if (!text) return '';
  try {
    return JSON.parse(text) as T;
  } catch {
    return text;
  }
}

/**
 * IPC adapter：渲染层只负责组装参数，实际请求由主进程 Electron `net` 执行。
 * 返回结构与 axios 内置 adapter 一致，供 axios 内部继续走拦截器/类型管道。
 */
async function ipcAdapter(config: InternalAxiosRequestConfig): Promise<AxiosResponse> {
  const method = (config.method || 'get').toUpperCase();
  const payload: NetRequestPayload = {
    url: resolveUrl(config.baseURL, config.url),
    method,
    headers: headersToRecord(config.headers),
    body:
      typeof config.data === 'string'
        ? config.data
        : config.data
          ? JSON.stringify(config.data)
          : undefined,
    // 透传 axios 实例/单请求的 timeout（主进程据此设置网络超时）
    timeout: typeof config.timeout === 'number' && config.timeout > 0 ? config.timeout : undefined,
  };

  let result: NetRequestResult;
  try {
    const r = await ipc.netRequest(payload);
    if (!r.success || !r.data) {
      throw new Error(r.error || 'net-request failed');
    }
    result = r.data;
  } catch (e) {
    throw AxiosError.from(e as Error, AxiosError.ERR_NETWORK, config);
  }

  const data = tryParse<unknown>(result.data);
  if (result.status >= 400) {
    throw AxiosError.from(
      new Error(`Request failed with status code ${result.status}`),
      AxiosError.ERR_BAD_RESPONSE,
      config,
      undefined,
      {
        data,
        status: result.status,
        statusText: result.statusText,
        headers: result.headers,
        config,
      },
    );
  }

  return {
    data,
    status: result.status,
    statusText: result.statusText,
    headers: result.headers,
    config,
    request: undefined,
  };
}

const instance = axios.create({
  baseURL: DEFAULT_BASE_URL,
  timeout: 15000,
});

// 默认引擎为 ipc；xhr 模式使用 axios 原生 XHR adapter（仅调试用）
if (REQUEST_ENGINE === 'ipc') {
  instance.defaults.adapter = ipcAdapter as unknown as typeof instance.defaults.adapter;
}

// 请求拦截：自动附加鉴权头
instance.interceptors.request.use((config) => {
  const token = getToken();
  if (token) config.headers.Authorization = `Bearer ${token}`;
  return config;
});

// 响应拦截：401 清除 token，其余错误透传（不在此处解包，调用方经 res.data 取数，保持类型安全）
instance.interceptors.response.use(
  (res) => res,
  (error: AxiosError) => {
    if (error.response?.status === 401) setToken(null);
    return Promise.reject(error);
  },
);

export { AxiosError };
export default instance;
