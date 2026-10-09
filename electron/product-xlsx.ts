// electron/product-xlsx.ts
// 「产品库 Excel」的两端：**生成**（导出/下载模板，带嵌入图）与**抽取**（导入时把图取回来）。
//
// 为什么单独一个文件、且不 import 任何 *-db / 不碰 electron 的 app（与 `picking-xlsx.ts` 同一理由）：
//   · 生成侧唯一有正确性风险的是「图**真的**嵌进去了没有」—— 少写一处包结构，导出照样成功、
//     文件照样能打开，只是图没了（`xlsx-image.ts` 文件头记了这个坑）；
//   · 抽取侧唯一有正确性风险的是「图归到了**哪一行**」—— Excel 的嵌入图是浮动对象，
//     按顺序配会把错位全部吃掉且不报错。
//   这两条只有在**能单独调用**的前提下才可能被自动验（`scripts/product-xlsx-smoke.cjs`
//   把产物当 zip 拆开数 `xl/media/`，再读回来逐行比）。一旦本文件 import 了 product-db 或
//   `electron` 的 app，冒烟就必须先起 Electron、先建库，"函数是不是纯的"就再也没人管了。
//
// 「抽出的图往哪落」由调用方注入（`land` 回调）：本文件不碰 fs、不登记 `pl_images`。
//   handler 传的是"落 product-images + 登记"，冒烟传的是"记下字节"。
//
// ---- 两个方向共用一份口径 ----
// 两侧都认「**行号**」：生成时图由调用方标在具体某一行上（`rows[i].imagePath`），
// 抽取时也只按锚点行号报回（`nativeRow + 1`）。中间不出现任何"第几张图"这种序号语义。

export {};

import { embedCellImage } from './xlsx-image';
import { safeSheetName } from './picking-xlsx';

/** 「图片」列的宽度（字符）；与 `xlsx-image` 的像素换算配套（默认字号 1 字符 ≈ 7px + 5px 边距） */
const IMG_COL_WIDTH = 16;
const IMG_COL_PX = Math.round(IMG_COL_WIDTH * 7 + 5);
const IMG_W = Math.min(96, IMG_COL_PX - 14);
const IMG_COL_OFF = Math.max(0, Math.round((IMG_COL_PX - IMG_W) / 2));

/** 按表头给列宽（宽的是人看的：款式名/备注/图片地址；编码一类窄列不必占地方） */
export function exportColWidth(header: string): number {
  if (header === '图片') return IMG_COL_WIDTH;
  if (header === '款式名') return 26;
  if (header === '备注') return 30;
  if (header === '图片地址') return 42;
  return 14;
}

/** 导出/模板的入参（渲染层算好"每格写什么"，这里只负责写） */
export interface ProductSheetInput {
  sheetName: string;
  headers: string[];
  /** 数据行（不含表头）；`cells` 与 `headers` 按位对齐 */
  rows: { cells: string[]; imagePath?: string }[];
  /** 「图片」列的 0 基下标（图就嵌在这一列上） */
  imageColumn: number;
}

export interface ProductSheetResult {
  buffer: Buffer;
  /** 成功嵌进去的图张数 */
  embedded: number;
  /** 有图但没嵌成（文件不在 / 内容认不出）的张数 —— 不报出来用户是看不见的 */
  imagesFailed: number;
}

/**
 * 生成产品表工作簿（含表头 + 数据行 + 按行嵌入的图）。
 *
 * @returns xlsx 字节 + 嵌图成功/失败的张数
 */
export async function buildProductWorkbook(input: ProductSheetInput): Promise<ProductSheetResult> {
  const ExcelJS = require('exceljs');
  const headers: string[] = (input?.headers ?? []).map((h) => String(h ?? ''));
  const bodyRows = Array.isArray(input?.rows) ? input.rows : [];
  const imageColumn = Math.max(0, Math.floor(Number(input?.imageColumn) || 0));

  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet(safeSheetName(String(input?.sheetName ?? ''), '产品库'));
  ws.addRow(headers);
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.height = 20;
  headers.forEach((h, i) => {
    ws.getColumn(i + 1).width = exportColWidth(h);
  });

  let embedded = 0;
  let imagesFailed = 0;
  bodyRows.forEach((r, i) => {
    const cells = Array.isArray(r?.cells) ? r.cells : [];
    const line = i + 2; // 第 1 行是表头
    // 空单元格一律写空串（而不是 undefined）：导出的文件是"待编辑的模板"，
    // 空列也该有格子，用户才不会以为是漏了一列。
    const row = ws.addRow(headers.map((_: string, c: number) => String(cells[c] ?? '')));
    row.alignment = { vertical: 'middle' };
    const imgPath = String(r?.imagePath ?? '');
    if (!imgPath) return;
    const h = embedCellImage(
      wb,
      ws,
      line,
      { filePath: imgPath },
      { col: imageColumn, width: IMG_W, colOff: IMG_COL_OFF },
    );
    if (h === null) {
      imagesFailed++;
      return;
    }
    embedded++;
    row.height = h;
  });

  return { buffer: Buffer.from(await wb.xlsx.writeBuffer()), embedded, imagesFailed };
}

/** 抽出的一张图（`land` 的返回值直接透传） */
export interface LandedImage {
  imageId: number;
  localPath: string;
}

export interface ExtractImagesResult {
  /** 行号（字符串键，1-based Excel 行）→ 图 */
  byRow: Record<string, LandedImage>;
  /** 没能归位的图（表头以上 / 该行已有图 / 格式不认识…） */
  skips: { rowNo: number; reason: string }[];
  /** 文件里一共扫到几张图 */
  total: number;
}

const DEFAULT_MAX_IMAGES = 3000;

/**
 * 抽出 xlsx 里的**嵌入图**，按**锚点行号**报回。
 *
 * ⚠️ 只认锚点行，**不按顺序配**：浮动图会随用户插行/删行漂移；顺序法（第 1 张配第 1 行）
 *    会把错位全部吃掉且不报错，表现为"图进来了但配错了款"，比直接丢图难查得多。
 *
 * **不抛**单张图的错（内容是空的 / `land` 抛了）：其余行照常，这一行只是没图。
 * 但会抛"没有这张工作表" —— 那说明两套读表实现对**表名**的理解出现了分岔，
 * 静默返回空会变成"导入成功但一张图都没有"，是最难查的形态。
 *
 * @param headerRow 表头所在行（1-based）；数据行从它的下一行开始
 * @param land 把图字节落盘并登记（handler 侧落 product-images；冒烟侧只记字节）
 */
export async function extractEmbeddedImages(
  buffer: Buffer | ArrayBuffer,
  opts: {
    sheetName: string;
    headerRow: number;
    max?: number;
    land: (bytes: Buffer) => LandedImage;
  },
): Promise<ExtractImagesResult> {
  const sheetName = String(opts?.sheetName ?? '');
  const headerRow = Math.max(0, Math.floor(Number(opts?.headerRow) || 0));
  const firstDataRow = headerRow + 1;
  const max = Math.max(1, Math.floor(Number(opts?.max) || DEFAULT_MAX_IMAGES));
  const land = opts?.land;
  if (typeof land !== 'function') throw new Error('缺少落图回调（land）');

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  await wb.xlsx.load(Buffer.isBuffer(buffer) ? buffer : Buffer.from(buffer as ArrayBuffer));
  const ws = wb.getWorksheet(sheetName);
  if (!ws) {
    // 渲染层自己选中的表名，主进程却不认识 —— 报出来，不要静默返回空
    throw new Error(`工作簿里没有名为「${sheetName}」的工作表，无法抽取图片`);
  }

  const byRow: Record<string, LandedImage> = {};
  const skips: { rowNo: number; reason: string }[] = [];
  const anchors = ws.getImages();
  let total = 0;
  for (const a of Array.isArray(anchors) ? anchors : []) {
    if (total >= max) {
      skips.push({
        rowNo: 0,
        reason: `这次只处理了前 ${max} 张图片，其余的没有导入（请分批导）`,
      });
      break;
    }
    total++;
    const nativeRow = Number(a?.range?.tl?.nativeRow);
    const rowNo = Number.isFinite(nativeRow) ? nativeRow + 1 : 0;
    if (!rowNo) {
      skips.push({ rowNo: 0, reason: '有一张图片读不出锚定的行，没有归位' });
      continue;
    }
    if (rowNo < firstDataRow) {
      skips.push({
        rowNo,
        reason: `第 ${rowNo} 行的图片没有归位 —— 表头（第 ${headerRow} 行）及以上的图不是数据`,
      });
      continue;
    }
    const key = String(rowNo);
    if (byRow[key]) {
      skips.push({
        rowNo,
        reason: `第 ${rowNo} 行插了不止一张图片，只用了第一张（这一行对应一个款，主图只能有一张）`,
      });
      continue;
    }
    try {
      const media = wb.getImage(Number(a?.imageId));
      const bytes = media?.buffer ? Buffer.from(media.buffer) : null;
      if (!bytes || !bytes.length) throw new Error('这张图片的内容是空的');
      byRow[key] = land(bytes);
    } catch (e) {
      skips.push({
        rowNo,
        reason: `第 ${rowNo} 行的图片没有导入：${e instanceof Error ? e.message : String(e)}`,
      });
    }
  }
  return { byRow, skips, total };
}
