// electron/xlsx-image.ts
// 「把一张图嵌进 xlsx 单元格」的**唯一实现**（拿货单导出 / 拣货单导出共用）。
//
// 为什么必须只有一份：Excel 没有"图片作为单元格内容"的存储格式（除 Excel 365 的 IMAGE()，兼容性差），
// 所以只能走浮动图 + 图片部件 + 关系 + 内容类型**四处同时写对**。少写一处不会报错 ——
// 导出照样成功、文件照样能打开，只是**图没了**（或者更糟：包结构不合法，Excel 提示"需要修复"）。
//
// ---- 两个实测踩到的坑（2026-10-05，都是"看着成功、图是坏的"）----
//
// ① `wb.addImage({ filename })` **必须同时给 `extension`**。
//    只给 filename 时 exceljs 写出来的是 `xl/media/image1.undefined`，且 `[Content_Types].xml` 里是
//    `<Default ContentType="image/undefined"/>`（连 `Extension` 属性都空掉）—— 按 OPC 规范
//    **每个 part 都必须有内容类型**，这个包是不合法的：Excel 会提示修复并丢掉图。
//    实测（`scripts/picking-xlsx-smoke.cjs`）：修复前 media 名是 `image1.undefined`。
//    ⇒ 本文件按**内容**（`sniffImageFormat` 魔数）推扩展名，并把它显式传给 exceljs。
//    顺带：不能按文件扩展名推 —— 项目里真实存在"内容是 WebP、文件名是 .jpg"的存量图（下载 CDN 的真实形态）。
//
// ② **WebP**：Electron 的 `nativeImage` 解不了 WebP（实测 `createFromPath/createFromBuffer` 都 isEmpty），
//    所以主进程既不能转码、也拿不到宽高。但 Excel 侧 `image/webp` 是合法内容类型（Office 2021+ 能显示）。
//    ⇒ 文件源里的 WebP **原样嵌入并标 webp**（不假装是 jpeg）；拿不到宽高时用兜底行高。
//    想要"处处都能显示"的图，得由**渲染层**（Chromium 有 WebP 解码）先用 canvas 转成 JPEG 再传进来 ——
//    这正是「拣货单导出」走 base64 那条路的原因（见 `picking-xlsx.ts` 文件头）。

export {};

import * as fs from 'fs';
import { sniffImageFormat } from './ipc-util';

/** 图源：本地文件（主进程自己解析出的路径）或已编码好的图片字节（渲染层 canvas 产出） */
export type XlsxImageSource =
  | { filePath: string; width?: number; height?: number }
  | { base64: string; width?: number; height?: number };

/** 读 PNG/JPEG 文件头取原始宽高；无法解析返回 null（WebP 一定返回 null，见文件头 ②） */
export function imageSizeOf(filePath: string): { w: number; h: number } | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64);
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    // PNG：8 字节签名 + 4 长度 + 4 "IHDR" 后为宽高（大端）
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // JPEG：遍历前 64 字节找 SOFn 标记
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      for (let i = 2; i < 60; i++) {
        const mk = buf[i + 1];
        if (buf[i] === 0xff && mk >= 0xc0 && mk <= 0xc3 && mk !== 0xc4) {
          return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

/** 嵌图布局（列宽换算出来的像素值，由调用方按自己的表头给） */
export interface CellImageLayout {
  /** 0 基列号 */
  col?: number;
  /** 图片显示宽度（像素） */
  width: number;
  /** 水平居中偏移（像素） */
  colOff?: number;
  /** 最大显示高度（像素，默认 160）—— 竖长图不会把行撑成一根旗杆 */
  maxHeight?: number;
  /** 拿不到原始宽高时的兜底显示高度（像素，默认 70） */
  fallbackHeight?: number;
}

/**
 * 把一张图嵌进 `ws` 的第 `rowNumber` 行（1 基，与 `ws.getRow()` 同一套编号）。
 *
 * @returns 建议的行高（pt，`ceil(高 × 0.75) + 2`）；没嵌成返回 `null`（调用方保持默认行高）
 *
 * **不抛**：图不存在、内容不认识的格式、exceljs 内部报错 —— 一律返回 null。
 * 一张图坏掉不该让整张导出失败（单张损坏 → 只是那一行没图）。
 */
export function embedCellImage(
  wb: any,
  ws: any,
  rowNumber: number,
  src: XlsxImageSource | null | undefined,
  layout: CellImageLayout,
): number | null {
  if (!src) return null;
  const col = layout.col ?? 0;
  const colOff = layout.colOff ?? 0;
  const maxHeight = layout.maxHeight ?? 160;
  const fallbackHeight = layout.fallbackHeight ?? 70;

  let addImageArg: Record<string, unknown> | null = null;
  let size: { w: number; h: number } | null = null;

  if ('base64' in src && src.base64) {
    // 渲染层已经编码好（内容必是它声明的格式）——宽高由它一并给出，主进程不需要解码
    addImageArg = { base64: src.base64, extension: 'jpeg' };
    const w = Number(src.width);
    const h = Number(src.height);
    size = Number.isFinite(w) && Number.isFinite(h) && w > 0 && h > 0 ? { w, h } : null;
  } else if ('filePath' in src && src.filePath) {
    const p = String(src.filePath);
    try {
      if (!fs.existsSync(p)) return null;
      const fd = fs.openSync(p, 'r');
      const head = Buffer.alloc(12);
      fs.readSync(fd, head, 0, 12, 0);
      fs.closeSync(fd);
      const fmt = sniffImageFormat(head);
      if (!fmt) return null; // 认不出内容类型 → 嵌进去也是打不开的图，不如不嵌
      addImageArg = { filename: p, extension: fmt }; // ⚠️ extension 必须给（坑 ①）
      size = imageSizeOf(p);
    } catch {
      return null;
    }
  }
  if (!addImageArg) return null;

  const dh =
    size && size.w > 0
      ? Math.min(maxHeight, Math.max(24, Math.round((layout.width * size.h) / size.w)))
      : fallbackHeight;
  try {
    const imgId = wb.addImage(addImageArg);
    // oneCellAnchor：删除/插入行时图片随锚定行移动
    ws.addImage(imgId, { tl: { col, colOff, row: rowNumber - 1 }, ext: { width: layout.width, height: dh } });
  } catch {
    return null;
  }
  return Math.max(22, Math.ceil(dh * 0.75) + 2); // 1px ≈ 0.75pt
}
