// 剪贴板服务：封装主进程的 write-clipboard / write-clipboard-image。

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

/** 写入图片剪贴板（PNG dataURL），返回是否成功。文本与图片分属两个通道 —— 图片不能走 writeText。 */
export async function writeClipboardImage(dataUrl: string): Promise<boolean> {
  try {
    const result = await ipc.writeClipboardImage(dataUrl);
    if (!result.success) {
      // 界面只提示一句泛化文案（§1.10 不给用户英文错误码），但真机取证必须能拿到原始错误 ——
      // 本次「clipboard.writeImage is not a function」就是在这里被吞掉、多绕了一轮排查。
      // eslint-disable-next-line no-console
      console.warn('[clipboard] writeClipboardImage rejected:', result.error);
    }
    return result.success;
  } catch (e: unknown) {
    // eslint-disable-next-line no-console
    console.warn('[clipboard] writeClipboardImage threw:', e instanceof Error ? e.message : e);
    return false;
  }
}
