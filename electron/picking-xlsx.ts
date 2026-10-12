// electron/picking-xlsx.ts
// 「拣货单带图 xlsx」的**生成**部分（不含对话框、不含磁盘写入）。
//
// 为什么单独一个文件、且不 import 任何 *-db：
//   · 生成 xlsx 里唯一有正确性风险的是「图真的嵌进去了没有」和「按厂家分表分对了没有」——
//     这两条只有在**能单独调用**的前提下才可能被自动验（`scripts/picking-xlsx-smoke.cjs` 直接调本文件的
//     `buildPickingWorkbook`，把产物当 zip 拆开数 `xl/media/`）；
//   · 一旦本文件 import 了 `order-db`，它就带上了 better-sqlite3 的依赖，冒烟脚本必须再建一个库才能跑，
//     于是「函数是不是纯的」就没人管了。
//
// ---- 图为什么不走"主进程读文件"（与拿货单导出的分岔，是有意的）----
// 实测用户库里 8/9 张订单图**内容是 WebP**（文件名是 `.webp`，也有内容是 webp 的 `.jpg`）。
// 而 Electron 的 `nativeImage` 解不了 WebP ⇒ 主进程既转不了码、也拿不到宽高。
// 直嵌 webp 虽然内容类型合法（Office 2021+ 能显示），但"发厂家"这个用途下对方的 Office/WPS 是什么版本不可控。
// ⇒ 拣货单这条链由**渲染层**（Chromium 有 WebP 解码）用 canvas 统一转成 JPEG 再传进来，
//   本文件只负责"把已经编码好的图嵌进表"（`image.base64` + `width/height`）。
// 拿货单导出的图源是主进程自己解析的本地路径，没有渲染层参与 ⇒ 走 `filePath` 分支（见 `xlsx-image.ts`）。
//
// 分表口径：**一个厂家一张 sheet**（订单是按厂家发出去的，一家一张表正好直接转给对方）。
// 未指定厂家的行单独一张「未指定厂家」，**不混进任何厂家的表** —— 混进去会把"还没配厂家"的货
// 变成"这家要拿的货"，而对方照着拿，事后对不上账。

export {};

import { embedCellImage } from './xlsx-image';

/** 已经过渲染层 canvas 编码的图（JPEG），可直接嵌进 xlsx */
export interface PickingExportImage {
  /** **不含** `data:image/jpeg;base64,` 前缀的纯 base64 */
  base64: string;
  width: number;
  height: number;
}

/** 一行导出（= 拣货单上的一行 SKU；已算好金额与缺口文案，本层不再计算业务口径） */
export interface PickingExportRow {
  /** 供应商名；'' = 未指定厂家 */
  supplierName: string;
  styleCode: string;
  color: string;
  size: string;
  /** 要拣几件（需求） */
  pieces: number;
  /** 已拿件数（已提交拿货单合计；与 `purchase-db.outstanding()` 同一口径） */
  taken: number;
  /** 还差件数 = `max(0, pieces − taken)` —— 厂家照着拿的就是这个数 */
  remaining: number;
  /** 涉及订单数 */
  orders: number;
  /** 进价（元/件）；`null` = 无进价（表里留空，**不写 0**） */
  unitPrice: number | null;
  /** 预估金额（元）；`null` = 无进价（表里留空） */
  amount: number | null;
  /** 缺口文案（"缺图 · 缺供应商"…）；'' = 齐 */
  gaps: string;
  /** 该行的图（已编码）；`null` = 没图 */
  image: PickingExportImage | null;
}

/** 厂家分表（保持传入顺序 —— 界面已经按"有厂家的在前、未指定的最后"排过） */
export function splitBySupplier(rows: PickingExportRow[]): { supplierName: string; rows: PickingExportRow[] }[] {
  const out: { supplierName: string; rows: PickingExportRow[] }[] = [];
  const idx = new Map<string, number>();
  for (const r of Array.isArray(rows) ? rows : []) {
    const name = String(r?.supplierName ?? '').trim();
    let i = idx.get(name);
    if (i === undefined) {
      i = out.length;
      idx.set(name, i);
      out.push({ supplierName: name, rows: [] });
    }
    out[i].rows.push(r);
  }
  return out;
}

/** Excel 工作表名限制：≤31 字符、不含 `[]:*?/\`；空 → 兜底名 */
export function safeSheetName(raw: string, fallback = '未指定厂家'): string {
  const name = String(raw ?? '')
    .replace(/[[\]:*?/\\]/g, '_')
    .trim()
    .slice(0, 31);
  return name || fallback;
}

// 表头（顺序与界面一致：图在最前，钱在最后，缺口收尾）
const HEAD = ['图片', '款编码', '款色', '尺码', '需求', '已拿', '还差', '订单数', '进价(元)', '金额(元)', '缺什么'];
const WIDTHS = [22, 16, 12, 8, 8, 8, 8, 9, 10, 11, 22];
// Excel 无"图片作为单元格内容"的存储格式（除 Excel 365 IMAGE()，兼容性差）⇒ 浮动图锚定 A 列。
// 默认字号下 1 字符≈7px + 5px 边距；留边距避免压到 B 列。
// ⚠️ A 列宽 22 → 图约 140px：**尺码×件数的角标已经烧进图里**（渲染层 canvas 合成），
//    图太小角标就读不出来 —— "拿图就能拿货"这条链正好卡在这个尺寸上。
const A_COL_PX = Math.round(WIDTHS[0] * 7 + 5); // A 列宽 22 → 约 159px
const IMG_W = Math.min(140, A_COL_PX - 14); // 图片显示宽度（像素）
const COL_OFF = Math.max(0, Math.round((A_COL_PX - IMG_W) / 2)); // 水平居中偏移

/** 生成拣货单工作簿（**一个厂家一张 sheet**）。返回 xlsx 字节。 */
export async function buildPickingWorkbook(rows: PickingExportRow[]): Promise<Buffer> {
  const ExcelJS = require('exceljs');

  const wb = new ExcelJS.Workbook();
  const used = new Set<string>();
  for (const part of splitBySupplier(rows)) {
    // 同名厂家去重（Excel 不允许两张同名表；同名不同 id 的供应商在数据里是可能的）
    let name = safeSheetName(part.supplierName);
    if (used.has(name)) {
      let n = 2;
      while (used.has(`${name}(${n})`)) n++;
      name = `${name}(${n})`.slice(0, 31);
    }
    used.add(name);

    const ws = wb.addWorksheet(name);
    ws.addRow(HEAD);
    const head = ws.getRow(1);
    head.font = { bold: true };
    head.height = 20;
    WIDTHS.forEach((w, i) => {
      ws.getColumn(i + 1).width = w;
    });

    let piecesTotal = 0;
    let remainTotal = 0;
    let amountTotal = 0;
    let priced = false;
    part.rows.forEach((it, i) => {
      const r = i + 2;
      piecesTotal += Number(it.pieces) || 0;
      remainTotal += Number(it.remaining) || 0;
      if (it.amount !== null && Number.isFinite(Number(it.amount))) {
        amountTotal += Number(it.amount);
        priced = true;
      }
      ws.addRow([
        undefined, // 图片占位（下面嵌图）
        it.styleCode || '(未识别款)',
        it.color || '(无颜色)',
        it.size || '(无尺码)',
        Number(it.pieces) || 0,
        Number(it.taken) || 0,
        Number(it.remaining) || 0,
        Number(it.orders) || 0,
        it.unitPrice === null ? undefined : it.unitPrice, // 无进价 → 留空（写 0 会被当成"免费"）
        it.amount === null ? undefined : it.amount, // 无进价 → 留空（写 0 会被当成"免费"）
        it.gaps || '齐',
      ]);
      const row = ws.getRow(r);
      row.alignment = { vertical: 'middle' };
      if (it.unitPrice !== null) row.getCell(9).numFmt = '0.00';
      if (it.amount !== null) row.getCell(10).numFmt = '0.00';
      const h = embedCellImage(wb, ws, r, it.image, { width: IMG_W, colOff: COL_OFF });
      if (h !== null) row.height = h;
    });

    // 合计行：厂家照着拿货时最关心的两个数（件数、钱）。无进价时**不写金额**，改写明缺了多少。
    const sum = ws.addRow([
      undefined,
      '合计',
      '',
      '',
      piecesTotal,
      '',
      remainTotal,
      '',
      '',
      priced ? +amountTotal.toFixed(2) : undefined,
      part.rows.some((x) => x.unitPrice === null) ? '含未计价的款' : '',
    ]);
    sum.font = { bold: true };
    if (priced) sum.getCell(10).numFmt = '0.00';
  }

  return (await wb.xlsx.writeBuffer()) as Buffer;
}
