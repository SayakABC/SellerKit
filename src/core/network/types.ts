/**
 * 网络模块共享类型 — 渲染进程与主进程的 IPC 契约。
 * 渲染层只允许传结构白名单内的字段，主进程再校验一次。
 */

/** 渲染层 → 主进程的请求载荷 */
export interface NetRequestPayload {
  /** 完整 URL（含协议），或相对路径（配合 axios baseURL 自动拼接） */
  url: string;
  /** HTTP 方法，白名单：GET/POST/PUT/PATCH/DELETE/HEAD/OPTIONS */
  method?: string;
  /** 请求头（仅字符串/数字值会被透传） */
  headers?: Record<string, string>;
  /** 请求体（JSON 字符串；GET/HEAD 不应携带） */
  body?: string;
  /** 超时毫秒（可选；默认主进程 15000）。AI 视觉识别等长耗时请求可放宽 */
  timeout?: number;
}

/** 主进程 → 渲染层的响应结果（文本型响应） */
export interface NetRequestResult {
  /** 是否 2xx */
  ok: boolean;
  /** HTTP 状态码 */
  status: number;
  statusText: string;
  /** 响应头（主进程已拍平为字符串值） */
  headers: Record<string, string>;
  /** 响应体文本 */
  data: string;
}
