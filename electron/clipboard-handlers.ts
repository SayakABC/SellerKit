// electron/clipboard-handlers.ts
// 系统交互 IPC（OS 级一次性动作，不走数据域）：
//   · 剪贴板：文本（write-clipboard）与图片（write-clipboard-image，「复制给厂家」的最后一跳）；
//   · 外链打开：open-external（「打开店铺」—— 优先 Chrome，见下）。
//
// 为什么独立成文件：`scripts/preload-ipc-shape-smoke.cjs` 用「真 preload + 真 handler」对穿
// 验证通道形状，它逐文件 require handler 模块；而这两条原先住在 main.ts —— 那是应用入口，
// 冒烟不能加载（会起窗口、开 ae-receiver）。这类"运行时 API 形状"缺陷（如 Electron 44 移除
// clipboard.writeImage）tsc / verify 全拦不住（require('electron') 是 any、通道名三方一致照样过），
// 只有真跑一次才暴露 —— 2026-10-10 实测踩到，守卫即 ⑧ 段。

import { clipboard, nativeImage, ClipboardItem } from 'electron';
import { register } from './ipc-util';
import { openUrlInPreferredBrowser } from './browser-open';

/** 图片剪贴板 dataURL 的字符数上限（约 6MB PNG）—— 发厂清单图是自绘的几百 KB 量级，超了必是异常入参 */
const MAX_CLIPBOARD_IMAGE_CHARS = 8 * 1024 * 1024;

/** 外链长度上限（店铺地址字段限 500 字符，2048 给足余量；超了必是异常入参） */
const MAX_EXTERNAL_URL_CHARS = 2048;

/** 允许交给系统浏览器打开的协议 —— 只放行网页。file: / 自定义协议一律拒绝 */
const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:']);

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

// 打开网页链接（「打开店铺」）—— **优先 Chrome**，用不了才回落系统默认浏览器。
//
// 为什么必须有这条通道：主窗口对 `window.open` / `target="_blank"` 是**一律拒绝**
// （`main.ts` 的 setWindowOpenHandler，deny 是静默的——点击毫无反应），渲染进程
// 也没有别的路能开外部浏览器。渲染层 `<a target="_blank">` 的写法曾经就是"点了没反应"的
// 现场（店铺登记页「打开」，2026-10-16）。
//
// 安全边界：只收 http/https（URL 解析后按 protocol 判定，防 `javascript:` / `file:`）；
// 失败返回用户能看懂的中文原因（地址填错是渲染层的输入问题，提示要指得回去）。
//
// 为什么优先 Chrome：采集靠 Chrome MV3 扩展，「打开店铺」的下一步就是点扩展的采集按钮
// ——交给别的浏览器等于开了个"没有按钮"的页面。探测与回落逻辑见 `browser-open.ts`。
register('open-external', async (payload: any) => {
  const raw = typeof payload === 'string' ? payload.trim() : '';
  if (!raw || raw.length > MAX_EXTERNAL_URL_CHARS) return { success: false, error: '链接地址无效' };
  let url: URL;
  try {
    url = new URL(raw);
  } catch {
    return { success: false, error: '链接地址无效（需要完整网址，以 http:// 或 https:// 开头）' };
  }
  if (!EXTERNAL_PROTOCOLS.has(url.protocol)) {
    return { success: false, error: '这只支持网页链接（http/https），其他协议不会打开' };
  }
  try {
    await openUrlInPreferredBrowser(url.toString());
  } catch {
    return { success: false, error: '系统没能打开这个链接' };
  }
  return { success: true };
});
