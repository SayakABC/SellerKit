// electron/clipboard-handlers.ts
// 剪贴板 IPC：文本（write-clipboard）与图片（write-clipboard-image，「复制给厂家」的最后一跳）。
//
// 为什么独立成文件：`scripts/preload-ipc-shape-smoke.cjs` 用「真 preload + 真 handler」对穿
// 验证通道形状，它逐文件 require handler 模块；而这两条原先住在 main.ts —— 那是应用入口，
// 冒烟不能加载（会起窗口、开 ae-receiver）。这类"运行时 API 形状"缺陷（如 Electron 44 移除
// clipboard.writeImage）tsc / verify 全拦不住（require('electron') 是 any、通道名三方一致照样过），
// 只有真写一次系统剪贴板才暴露 —— 2026-10-10 实测踩到，守卫即 ⑧ 段。

import { clipboard, nativeImage, ClipboardItem } from 'electron';
import { register } from './ipc-util';

/** 图片剪贴板 dataURL 的字符数上限（约 6MB PNG）—— 发厂清单图是自绘的几百 KB 量级，超了必是异常入参 */
const MAX_CLIPBOARD_IMAGE_CHARS = 8 * 1024 * 1024;

register('write-clipboard', async (payload: any) => {
  // Electron 44 起 clipboard.writeText 是 async（返回 Promise）—— 不 await 会变成"发起即成功"，
  // 写入真失败时错误落进 unhandled rejection（界面却是"已复制"）。
  await clipboard.writeText(payload);
  return { success: true };
});

// 写图片剪贴板（「复制给厂家」：发厂清单 PNG 进系统剪贴板，用户粘到微信里发给厂家）。
// 渲染层只交 PNG dataURL；只认前缀 + 长度，不做通用图片转换 —— 这不是一个任意解码入口。
register('write-clipboard-image', async (payload: any) => {
  const dataUrl = payload;
  if (typeof dataUrl !== 'string' || !dataUrl.startsWith('data:image/png;base64,')) {
    return { success: false, error: 'invalid image payload' };
  }
  if (dataUrl.length > MAX_CLIPBOARD_IMAGE_CHARS) {
    return { success: false, error: 'image too large' };
  }
  const image = nativeImage.createFromDataURL(dataUrl);
  if (image.isEmpty()) {
    return { success: false, error: 'image decode failed' };
  }
  // Electron 44 移除了 clipboard.writeImage（narrow helpers 清理，同批还有 readImage / writeHTML 等）——
  // 新写法 = ClipboardItem + Blob。别改回 writeImage：v44 上它不存在，调用报
  // "clipboard.writeImage is not a function"。守卫：npm run ipc:shape:smoke ⑧ 段（真写系统剪贴板 + 读回）。
  // `new Uint8Array(png)` 而非直接给 Buffer：① DOM 的 BlobPart 不收 Buffer 的 ArrayBufferLike（类型层）
  // ② Buffer 底层是池化分配，直接给 `.buffer` 会带上池里无关字节（运行时层）。
  const png = image.toPNG();
  await clipboard.write([
    new ClipboardItem({ 'image/png': new Blob([new Uint8Array(png)], { type: 'image/png' }) }),
  ]);
  return { success: true };
});
