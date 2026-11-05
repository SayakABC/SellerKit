// electron/ipc-util.ts
// 主进程 IPC 注册封装（单一事实源）。
//
// 背景（C-12 / R2-6）：原先 5 个 handler 文件各自抄了一份注册封装——两份 `register`
// 逐字节相同，三份 `handle<T>` 同一模板，差异只落在「是否 async」与
// `err.message` / `err?.message` 这类**无意的漂移**上。抽到本文件后，返回形状与
// 异常兜底只有一处定义，新增域不会再产生第 6 份拷贝。
//
// ---- 两种契约（不可合并）----
// 二者不是「严格/宽松」的关系，而是职责不同，合并会迫使某个域改写全部 handler：
//
//   register —— handler 自行返回业务结果 `{ success, data?, error? }`。
//               适合需要在 handler 内做入参校验、并**主动**回传
//               `{ success:false, error:'invalid payload' }` 的写型域（order / purchase）。
//               本层只兜住未捕获异常，不介入业务判断。
//
//   handle   —— handler 只返回数据（或 Promise），本层包装成 `{ success:true, data }`；
//               抛出即转 `{ success:false, error }`。适合查询型域
//               （ae / mail / shop-accounts），省掉每处手写包装。
//
// ---- 两处有意的行为收敛（均为修 bug，不是改功能）----
//   1. `err.message` → `err?.message`：原实现若被 `throw null` / `throw undefined`
//      击穿（如底层库直接抛出非对象），catch 块自身会抛 TypeError，变成 IPC promise
//      reject，渲染层拿到的是未处理拒绝而非 `{ success:false }`。
//   2. `handle` 统一为 async：原先 ae / shop-accounts 的版本是同步的，其 `fn` 类型
//      因此无法接受 async handler。ipcMain 的返回值本身就是 promise，渲染层
//      `invoke` 恒为异步，故对调用方无任何可观测差异；同步 handler 照旧可用。
//
// ---- 未纳入本文件的直调注册 ----
// `electron/order-handlers.ts` 的 `order-export-excel` 仍是裸 `ipcMain.handle`：
// 它需要 IPC 事件对象（`event.sender`）反查父窗口以正确挂载保存对话框，而
// `register` 的签名只传 payload。若后续要统一，把 `register` 的 handler 扩成
// `(payload, event)` 即可（现有 handler 忽略第二参，属纯增量），本次不做以控制改动面。

import { ipcMain } from 'electron';

/**
 * 主进程 → 渲染层的统一返回形状。
 * 与渲染层 `src/types.ts` 的 `APIResult<T>` 对应，但**有意不复用**：三层边界要求
 * 主进程不 import 渲染层代码（见 AGENTS.md §1.1），故此处定义最小形状。
 */
export interface IpcApiResult {
  success: boolean;
  data?: any;
  error?: string;
}

/**
 * 注册「自行返回业务结果」的通道。
 * handler 抛出的未捕获异常会被兜成 `{ success:false, error }`。
 */
export function register(
  channel: string,
  handler: (payload: any) => IpcApiResult | Promise<IpcApiResult>,
): void {
  ipcMain.handle(channel, async (_e: any, payload: any) => {
    try {
      return await handler(payload);
    } catch (err: any) {
      return { success: false, error: err?.message || 'Unknown error' };
    }
  });
}

/**
 * 注册「只返回数据」的通道，由本层包装成 `{ success:true, data }`。
 * handler 抛出即转 `{ success:false, error }`。
 */
export function handle<T>(channel: string, fn: (payload: any) => T | Promise<T>): void {
  ipcMain.handle(channel, async (_e: any, payload: any) => {
    try {
      const data = await fn(payload);
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err?.message || '未知错误' };
    }
  });
}

// ---- 图片格式魔数嗅探（order / product 两个图片域共用，口径只此一份） ----

/**
 * 图片格式魔数嗅探：按文件头字节判断真实格式。
 * 背景：商品图 CDN 常以 WebP 返回，但下载逻辑曾一律落 .jpg 扩展名，
 *       扩展名与内容不符会让读取端按错误 MIME/解码器解析导致图片空白。
 * 统一按内容定格式：读取端决定 MIME、下载端决定落盘扩展名，存量错名文件亦兼容。
 */
export function sniffImageFormat(buf: Buffer): 'jpeg' | 'png' | 'webp' | null {
  if (!buf || buf.length < 12) return null;
  // JPEG: FF D8 FF
  if (buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return 'jpeg';
  // PNG: 89 50 4E 47 0D 0A 1A 0A
  if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return 'png';
  // WebP: RIFF .... WEBP（VP8/VP8L/VP8X）
  if (
    buf[0] === 0x52 && buf[1] === 0x49 && buf[2] === 0x46 && buf[3] === 0x46 &&
    buf[8] === 0x57 && buf[9] === 0x45 && buf[10] === 0x42 && buf[11] === 0x50
  ) return 'webp';
  return null;
}

/** 格式 → 落盘扩展名（写入端用；读取端不依赖扩展名判断内容） */
export const IMG_EXT_BY_FORMAT: Record<'jpeg' | 'png' | 'webp', string> = {
  jpeg: '.jpg',
  png: '.png',
  webp: '.webp',
};
