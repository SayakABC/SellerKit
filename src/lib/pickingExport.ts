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
//   ① `encodeImagesForExport(items, deps)` —— 编排（逐项、失败不抛），纯逻辑，可被 vitest 覆盖；
//   ② `domToJpeg` —— `<img>` 解码 + canvas 重绘（含**尺码×件数角标**）+ `toDataURL('image/jpeg')`，浏览器实现。
// 这样"哪张图失败了、失败会不会拖垮整张导出"这类问题能在单测里钉住，而不必起浏览器。
//
// **角标（2026-10-10）**：把尺码与件数烧进图片角（`sizeQtyBadge`）。导出的用途是"发出去/打出来照着拿"，
// 角标必须**跟着图走** —— Excel 没有"图上的文字"这种格式，靠旁边那一列对方未必看。

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
  /** dataUrl → JPEG（`null` = 解码/编码失败）；生产实现是 `domToJpeg`。`badge` 为空串 = 不加角标 */
  toJpeg: (dataUrl: string, maxEdge: number, badge?: string) => Promise<EncodedImage | null>;
}

/**
 * 图片角标文案（**尺码 × 件数**）—— "拿图就能拿货"就靠它。
 *
 * 为什么把它做成函数而不是在模板里拼：界面角标与**导出 xlsx 里烧进图的那一个**必须是同一个字符串
 *   （两处各拼一次，迟早一处写 `L×3`、一处写 `L ×3`，屏幕上和纸上的清单对不上）。
 * 尺码为空时用 `?` 占位 —— **不静默省略**：省略了看起来就是"这张图没有尺码"，而事实是"不知道尺码"。
 */
export function sizeQtyBadge(size: unknown, pieces: unknown): string {
  const s = String(size ?? '').trim() || '?';
  const n = Math.max(0, Math.round(Number(pieces) || 0));
  return `${s}×${n}`;
}

/** 待编码的一张图（键 = 调用方取回结果的键；角标按**这一项**画） */
export interface ExportImageItem {
  /** 结果里的键（同一键只编一次）—— 用组键（款·色·码）而**不是**路径：
   *  同一张图可能被不同尺码的组共用，而角标（尺码×件数）不同 ⇒ 按路径去重会把角标串味。 */
  key: string;
  /** 本地图片路径 */
  localPath: string;
  /** 角标文案（`sizeQtyBadge` 的产物）；`''` = 不画角标 */
  badge?: string;
}

/**
 * 批量编码（**顺序执行**：canvas 编码本身是同步重活，并发只会更卡）。
 *
 * 键 = 传入的 `item.key`（调用方按同一个键去取结果，别再拼一次）。
 * - **同一个键只编一次**（首个为准）；
 * - 空键 / 取不到 dataUrl / 编码失败 → **该键不出现在结果里**（`Record` 里没有键，不是 `null` 值）；
 * - **一张失败不影响其他张**（导出的是清单，少一张图不该让整个导出失败）。
 */
export async function encodeImagesForExport(
  items: (ExportImageItem | null | undefined)[],
  deps: EncodeDeps,
  maxEdge = 320,
): Promise<Record<string, EncodedImage>> {
  const out: Record<string, EncodedImage> = {};
  const seen = new Set<string>();
  for (const it of Array.isArray(items) ? items : []) {
    const key = String(it?.key ?? '');
    if (!key || seen.has(key)) continue;
    seen.add(key);
    let dataUrl = '';
    try {
      dataUrl = String(deps?.loadDataUrl(String(it?.localPath ?? '')) ?? '');
    } catch {
      dataUrl = '';
    }
    if (!dataUrl) continue;
    try {
      const enc = await deps.toJpeg(dataUrl, maxEdge, String(it?.badge ?? ''));
      if (enc && enc.base64) out[key] = enc;
    } catch {
      /* 单张编码失败：跳过（这张没图），不阻断整张导出 */
    }
  }
  return out;
}

/**
 * dataUrl → JPEG（浏览器实现）。**永不 reject**：解码失败/画布不可用都返回 `null`。
 *
 * 三个细节：
 *   · 超过 `maxEdge` 的长边要按比例缩 —— 原图可能是 1000px，直接嵌进 Excel 会让文件几十 MB；
 *   · JPEG **没有透明通道**：PNG 的透明区直接画上去会变黑，所以先铺一层白底；
 *   · `badge` 非空时把**尺码×件数**烧进图片左下角（"拿图就能拿货"靠它）。
 *     画在**图里**而不是 Excel 单元格里：Excel 没有"图上的文字"这种格式，而导出的用途是
 *     **发出去/打出来照着拿**，角标必须跟着图走，不能指望对方去看旁边那一列。
 */
export function domToJpeg(dataUrl: string, maxEdge = 320, badge = ''): Promise<EncodedImage | null> {
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
        if (badge) drawBadge(ctx, cw, ch, badge);
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

/**
 * 在画布**左下角**画角标（深底白字，圆角）。
 *
 * 尺寸按图短边取比例（不是固定像素）：缩略图可能是 64px 也可能是 320px，
 * 固定字号会在小图上糊成一片、在大图上小得看不见。
 * 字号下限 11px —— 小于它的字在任何缩放下都读不出来，那时宁可让它占多一点。
 */
function drawBadge(ctx: CanvasRenderingContext2D, cw: number, ch: number, text: string): void {
  const fs = Math.max(11, Math.round(Math.min(cw, ch) * 0.24));
  ctx.font = `600 ${fs}px -apple-system, "PingFang SC", "Microsoft YaHei", system-ui, sans-serif`;
  ctx.textBaseline = 'middle';
  ctx.textAlign = 'left';
  const pad = Math.max(3, Math.round(fs * 0.34));
  const tw = ctx.measureText(text).width;
  const bw = Math.min(cw, Math.ceil(tw) + pad * 2);
  const bh = Math.min(ch, Math.round(fs + pad * 1.1));
  const bx = 0;
  const by = ch - bh;
  const r = Math.min(Math.round(bh / 2), Math.round(bw / 2));
  ctx.beginPath();
  // 只圆右上角：左下角贴边（看起来是"贴在图片角上"而不是一张浮着的小卡片）
  ctx.moveTo(bx, by);
  ctx.lineTo(bx + bw - r, by);
  ctx.quadraticCurveTo(bx + bw, by, bx + bw, by + r);
  ctx.lineTo(bx + bw, by + bh - r);
  ctx.quadraticCurveTo(bx + bw, by + bh, bx + bw - r, by + bh);
  ctx.lineTo(bx, by + bh);
  ctx.closePath();
  ctx.fillStyle = 'rgba(17, 17, 17, 0.82)';
  ctx.fill();
  ctx.fillStyle = '#ffffff';
  ctx.fillText(text, bx + pad, by + bh / 2);
}
