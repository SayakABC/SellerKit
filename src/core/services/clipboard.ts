// 剪贴板服务：封装主进程的 write-clipboard。

import { ipc } from './ipc';

/** 写入剪贴板，返回是否成功 */
export async function writeClipboard(text: string): Promise<boolean> {
  try {
    const result = await ipc.writeClipboard(text);
    return result.success;
  } catch {
    return false;
  }
}
