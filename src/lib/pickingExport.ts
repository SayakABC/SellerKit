// src/lib/pickingExport.ts
// 「拣货单导出」的**图片编码**层：把订单图转成能嵌进 xlsx 的 JPEG 字节。
//
// 为什么这件事必须在渲染层做（而不是主进程读文件）：
//   实测用户库里 **8/9 张订单图内容是 WebP**（文件名 `.webp`，也存在"内容是 webp、名字是 .jpg"的存量图）。
//   · Electron 的 `nativeImage` **解不了 WebP**（实测 `createFromPath` / `createFromBuffer` 都 `isEmpty()`）
//     ⇒ 主进程既转不了码、也拿不到宽高；
//   · exceljs 只有拿到 `extension` 才能写出合法部件，而 WebP 在旧版 Office/WPS 里显示不出来
//     （"发厂家"这个用途下对方用什么版本不可控）；
//   · 渲染层是 Chromium，`<img>` + `canvas` 本来就支持 WebP ⇒ 在这里统一转成 **JPEG**，处处能显示。
//
// 分层：编码分两步，**只有第二步依赖浏览器**：
//   ① `encodeImagesForExport(paths, deps)` —— 编排（去重、逐张、失败不抛），纯逻辑，可被 vitest 覆盖；
//   ② `domToJpeg` —— `<img>` 解码 + canvas 重绘 + `toDataURL('image/jpeg')`，浏览器实现。
// 这样"哪张图失败了、失败会不会拖垮整张导出"这类问题能在单测里钉住，而不必起浏览器。

/** 编码好的图（可直接嵌进 xlsx） */
export interface EncodedImage {
  /** **不含** `data:image/jpeg;base64,` 前缀的纯 base64 */
  base64: string;
  width: number;
  height: number;
}

/** 编码所需的两件外部能力（注入以便单测；生产实现见下方 `domToJpeg`） */
export interface EncodeDeps {
  /** 本地路径 → dataUrl（`''`/null = 这张取不到）；生产实现读的是页面上已有的缩略图缓存 */
  loadDataUrl: (localPath: string) => string | null;
  /** dataUrl → JPEG（`null` = 解码/编码失败）；生产实现是 `domToJpeg` */
  toJpeg: (dataUrl: string, maxEdge: number) => Promise<EncodedImage | null>;
}

/**
 * 批量编码（**顺序执行**：canvas 编码本身是同步重活，并发只会更卡）。
 *
 * 键 = 传入的路径原文（调用方按同一个键去取结果，别再拼一次）。
 * - 空路径 / 取不到 dataUrl / 编码失败 → **该路径不出现在结果里**（`Record` 里没有键，不是 `null` 值）；
 * - **一张失败不影响其他张**（导出的是清单，少一张图不该让整个导出失败）；
 * - 路径去重（同 SKU 的多行共用一张图）。
 */
export async function encodeImagesForExport(
  paths: (string | null | undefined)[],
  deps: EncodeDeps,
  maxEdge = 320,
): Promise<Record<string, EncodedImage>> {
  const out: Record<string, EncodedImage> = {};
  const uniq = [...new Set((Array.isArray(paths) ? paths : []).map((p) => String(p ?? '')).filter(Boolean))];
  for (const p of uniq) {
    let dataUrl = '';
    try {
      dataUrl = String(deps?.loadDataUrl(p) ?? '');
    } catch {
      dataUrl = '';
    }
    if (!dataUrl) continue;
    try {
      const enc = await deps.toJpeg(dataUrl, maxEdge);
      if (enc && enc.base64) out[p] = enc;
    } catch {
      /* 单张编码失败：跳过（这张没图），不阻断整张导出 */
    }
  }
  return out;
}

/**
 * dataUrl → JPEG（浏览器实现）。**永不 reject**：解码失败/画布不可用都返回 `null`。
 *
 * 两个细节：
 *   · 超过 `maxEdge` 的长边要按比例缩 —— 原图可能是 1000px，直接嵌进 Excel 会让文件几十 MB；
 *   · JPEG **没有透明通道**：PNG 的透明区直接画上去会变黑，所以先铺一层白底。
 */
export function domToJpeg(dataUrl: string, maxEdge = 320): Promise<EncodedImage | null> {
  return new Promise((resolve) => {
    const img = new Image();
    img.onload = () => {
      try {
        const w = img.naturalWidth;
        const h = img.naturalHeight;
        if (!w || !h) return resolve(null);
        const scale = Math.min(1, maxEdge / Math.max(w, h));
        const cw = Math.max(1, Math.round(w * scale));
        const ch = Math.max(1, Math.round(h * scale));
        const c = document.createElement('canvas');
        c.width = cw;
        c.height = ch;
        const ctx = c.getContext('2d');
        if (!ctx) return resolve(null);
        ctx.fillStyle = '#ffffff';
        ctx.fillRect(0, 0, cw, ch);
        ctx.drawImage(img, 0, 0, cw, ch);
        const out = c.toDataURL('image/jpeg', 0.85);
        const i = out.indexOf(',');
        if (i < 0) return resolve(null);
        resolve({ base64: out.slice(i + 1), width: cw, height: ch });
      } catch {
        resolve(null);
      }
    };
    img.onerror = () => resolve(null);
    img.src = dataUrl;
  });
}
