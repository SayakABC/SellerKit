/**
 * Token 管理 — 渲染进程侧轻量存取。
 * 使用 localStorage 持久化（跨会话），key 带 sk_ 前缀避免与业务命名冲突。
 */

const TOKEN_KEY = 'sk_auth_token';

/** 读取当前 token，无则返回 null */
export function getToken(): string | null {
  try {
    return localStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

/** 写入 / 清除 token（传 null 即清除） */
export function setToken(token: string | null): void {
  try {
    if (token) localStorage.setItem(TOKEN_KEY, token);
    else localStorage.removeItem(TOKEN_KEY);
  } catch {
    // localStorage 不可用时静默降级，不影响请求主流程
  }
}
