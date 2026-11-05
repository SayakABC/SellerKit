// electron/pod-report.ts
// **花纸报单的导出**（M4·T4-3）：`报单_YYYYMMDD.zip` = `清单.xlsx` + 每行的**图稿**。
//
// 三件事必须做对，任一错了花纸商就拿不到能制版的料：
//   ① **图稿 ≠ 预览图**（红线 7）：`pod_patterns.artwork_image_id` 才是纯图案（制版用），
//      `preview_image_id` 是认图用的模特图。传错一次整批报废，所以这里只认 `artwork_image_id`，
//      并在清单里把"缺图稿"的行**显式标出来**（不拿预览图兜底 —— 兜底就是错印）。
//   ② **清单与图片张数要对得上**：解压后 `图稿/` 里的文件数应当等于清单的数据行数。
//      缺图稿的行仍然留在清单里（它是真需求），但单独计数回报，让用户先去补图再发。
//   ③ **口径不在这里算**：净需件 / 张数由渲染层 `src/lib/podNeed.ts` 算好传进来
//      （状态口径只有一份）。本层只做**校验 + 画表 + 打包**，绝不重新"算一遍"。
//
// 为什么图稿走主进程读盘、而不是拣货单那样由渲染层 canvas 编码：图稿是**存量的产品图**
//（`md_images.local_path`，PNG/JPEG 居多），不是采集来的 WebP；打包进 zip 要的是原字节，
// 转码只会降质。透明背景的 PNG **必须保留原格式**（转 JPEG 会把透明底变成白底，制版直接把白边印上去）。

export {};

import * as fs from 'fs';
import * as path from 'path';
import ExcelJS from 'exceljs';
import { imageLocalPath } from './master-data-db';
import { buildZip } from './zip-writer';
import type { ZipEntry } from './zip-writer';

/** 清单的一行（= 渲染层 `PodNeedRow`；字段名逐字对应，主进程不重算净需件） */
export interface PodReportRowInput {
  patternId: number;
  code: string;
  name: string;
  /** 制版用图稿（**不是**预览图） */
  artworkImageId: number;
  previewImageId: number;
  needPieces: number;
  remainingPieces: number;
  netNeed: number;
  sheets: number;
}

export interface PodReportInput {
  /** 要报单的行（净需件 > 0；主进程会再过滤一次，防止渲染层误传"够料"的行） */
  rows: PodReportRowInput[];
  /** `yyyy-mm-dd`（文件名与表头用） */
  date: string;
  piecesPerSheet: number;
  /** 待发但没绑图案的件数（> 0 时清单顶部必须写一行警告 —— 这份单是偏少的） */
  unboundPieces?: number;
  unboundRows?: number;
  /** 件数按 1 兜底的行数 */
  assumedRows?: number;
}

export interface PodReportOutput {
  zip: Buffer;
  /** 实际打进 zip 的图稿张数（应当 == 清单数据行数；不等就是有缺失，界面要说） */
  images: number;
  /** 缺图稿的行（`code`；空 = 齐） */
  missingArtwork: string[];
  /** 已在清单顶部写进 xlsx 的警告（回报给界面 toast 用） */
  warnings: string[];
  /** 清单数据行数（= `rows` 里净需件 > 0 的行） */
  rows: number;
}

/** 图稿扩展名（按文件真实后缀；认不出时按 jpg —— xlsx/zip 里它只是文件名，内容不受影响） */
function extOf(filePath: string): string {
  const ext = path.extname(filePath || '').toLowerCase().replace('.', '');
  if (!ext) return 'jpg';
  if (!/^[a-z0-9]{2,5}$/.test(ext)) return 'jpg';
  return ext;
}

/** 文件名里不许出现的字符（图案编码是用户填的，可能带 `/`） */
function safeName(raw: string): string {
  // 控制字符（`\u0000`~`\u001f`）用逐字符过滤，而不是塞进正则：
  //   ① `no-control-regex` 是 lint 的硬规则；
  //   ② 这里**必须**过滤它们 —— 变体键里本来就带 `\u0000`，漏进 zip 条目名会解出诡异文件名。
  const flat = Array.from(String(raw ?? ''))
    .map((ch) => (ch.charCodeAt(0) < 0x20 ? '_' : ch))
    .join('');
  return flat.replace(/[\\/:*?"<>|]/g, '_').slice(0, 80) || 'unnamed';
}

/** 画清单（纯函数：只吃传入的行与已解析好的图稿文件名，不碰磁盘 → 可单测） */
export interface PodSheetLine {
  row: PodReportRowInput;
  /** 图稿文件在 zip 内的名字；'' = 缺图稿 */
  artworkName: string;
}

export async function buildPodReportWorkbook(
  lines: readonly PodSheetLine[],
  input: { date: string; piecesPerSheet: number; unboundPieces?: number; unboundRows?: number; assumedRows?: number },
): Promise<Buffer> {
  const wb = new ExcelJS.Workbook();
  wb.created = new Date();
  const ws = wb.addWorksheet('报单', { views: [{ state: 'frozen', ySplit: 3 }] });

  ws.columns = [
    { header: '图案编码', key: 'code', width: 14 },
    { header: '图案名', key: 'name', width: 24 },
    { header: '待印件', key: 'need', width: 10, style: { numFmt: '0' } },
    { header: '余量', key: 'stock', width: 10, style: { numFmt: '0' } },
    { header: '净需件', key: 'net', width: 10, style: { numFmt: '0' } },
    { header: '报单张数', key: 'sheets', width: 12, style: { numFmt: '0' } },
    { header: '图稿', key: 'artwork', width: 20 },
    { header: '备注', key: 'note', width: 30 },
  ];

  // 标题行写在表头之上（合并 1~8 列）—— 花纸商打开第一眼就是"这是什么、哪天的、按多少件一张"
  ws.spliceRows(1, 0, [
    `花纸报单 ${input.date}（每张 ${Math.max(1, Math.round(Number(input.piecesPerSheet) || 1))} 件）`,
  ]);
  ws.mergeCells('A1:H1');
  ws.getCell('A1').font = { bold: true, size: 13 };
  ws.getCell('A1').alignment = { vertical: 'middle', horizontal: 'left' };

  const warnings: string[] = [];
  if (Number(input.unboundPieces) > 0) {
    warnings.push(
      `⚠ 还有 ${Number(input.unboundPieces)} 件待发没绑图案（${Number(input.unboundRows) || 0} 行）—— 本单不含这些件，报少了要补`,
    );
  }
  if (Number(input.assumedRows) > 0) {
    warnings.push(`⚠ ${Number(input.assumedRows)} 行没有件数，已按 1 件计 —— 实际可能更多`);
  }
  const missing = lines.filter((l) => !l.artworkName).map((l) => l.row.code);
  if (missing.length) {
    warnings.push(`⚠ ${missing.length} 个图案有需求但没有图稿（${missing.join('、')}）—— 缺图稿的行不能直接制版`);
  }

  // 第 2 行：警告（没有警告时写一句口径说明，避免那一行空着被当成"漏了"）
  const warnText = warnings.length ? warnings.join('    ') : '所有待发件都已绑图案；图稿取自图案的「图稿」字段（不是预览图）';
  ws.spliceRows(2, 0, [warnText]);
  ws.mergeCells('A2:H2');
  ws.getCell('A2').font = { size: 10, color: { argb: warnings.length ? 'FFB00020' : 'FF666666' } };
  ws.getCell('A2').alignment = { wrapText: true, vertical: 'top' };
  ws.getRow(2).height = warnings.length ? 30 : 16;

  for (const l of lines) {
    const r = l.row;
    const added = ws.addRow({
      code: r.code,
      name: r.name,
      need: Math.max(0, Math.round(Number(r.needPieces) || 0)),
      stock: Math.max(0, Math.round(Number(r.remainingPieces) || 0)),
      net: Math.max(0, Math.round(Number(r.netNeed) || 0)),
      sheets: Math.max(0, Math.round(Number(r.sheets) || 0)),
      artwork: l.artworkName || '（缺）',
      note: l.artworkName ? '' : '缺图稿：先去图案库里传「图稿」（预览图不能制版）',
    });
    if (!l.artworkName) added.getCell('artwork').font = { color: { argb: 'FFB00020' }, bold: true };
  }

  // 合计行（老板/花纸商最常看的就是"一共几张"）
  const total = lines.reduce(
    (s, l) => ({
      need: s.need + Math.max(0, Math.round(Number(l.row.needPieces) || 0)),
      net: s.net + Math.max(0, Math.round(Number(l.row.netNeed) || 0)),
      sheets: s.sheets + Math.max(0, Math.round(Number(l.row.sheets) || 0)),
    }),
    { need: 0, net: 0, sheets: 0 },
  );
  ws.addRow({ code: '合计', name: '', need: total.need, stock: '', net: total.net, sheets: total.sheets, artwork: '', note: '' })
    .font = { bold: true };

  // exceljs 自带的 `writeBuffer` 声明与 @types/node 的 Buffer 泛型不兼容（同 `picking-xlsx` 的写法）
  return Buffer.from((await wb.xlsx.writeBuffer()) as any);
}

/**
 * 生成报单 zip（读盘 + 画表 + 打包；**不弹对话框**，落盘由 handler 做）。
 *
 * 图稿缺失**不阻断**导出：清单里那几行标红、`missingArtwork` 回给界面、
 * zip 里少几张图 —— 但**绝不拿预览图顶上**（红线 7：传错一次整批报废）。
 */
export async function buildPodReportZip(input: PodReportInput): Promise<PodReportOutput> {
  const date = /^\d{4}-\d{2}-\d{2}$/.test(String(input?.date ?? ''))
    ? String(input.date)
    : new Date().toISOString().slice(0, 10);
  const piecesPerSheet =
    Number.isFinite(Number(input?.piecesPerSheet)) && Number(input.piecesPerSheet) > 0
      ? Math.round(Number(input.piecesPerSheet))
      : 1;

  const rows = (Array.isArray(input?.rows) ? input.rows : []).filter(
    (r) => r && Math.max(0, Math.round(Number(r.netNeed) || 0)) > 0,
  );
  if (!rows.length) throw new Error('没有需要报单的图案（余量都够，不用报）');

  // 图稿路径：一次批量解析（`imageLocalPath` 自带路径自愈，缺失返回原路径 → 这里再判存在）
  const lines: PodSheetLine[] = rows.map((row) => {
    const code = safeName(row.code);
    const p = imageLocalPath(Math.round(Number(row.artworkImageId) || 0));
    if (!p || !fs.existsSync(p)) return { row, artworkName: '' };
    return { row, artworkName: `图稿/${code}.${extOf(p)}` };
  });

  const entries: ZipEntry[] = [];
  const images = lines.filter((l) => l.artworkName);
  for (const l of images) {
    const p = imageLocalPath(Math.round(Number(l.row.artworkImageId) || 0));
    const data = fs.readFileSync(p);
    // 图是已压缩格式：用 store（deflate 只会白烧 CPU，压不小）
    entries.push({ name: l.artworkName, data, method: 'store' });
  }

  const book = await buildPodReportWorkbook(lines, {
    date,
    piecesPerSheet,
    unboundPieces: input?.unboundPieces,
    unboundRows: input?.unboundRows,
    assumedRows: input?.assumedRows,
  });
  // 清单放最前（解压时人第一眼看到它）
  entries.unshift({ name: '清单.xlsx', data: book, method: 'deflate' });

  const missingArtwork = lines.filter((l) => !l.artworkName).map((l) => l.row.code);
  const warnings: string[] = [];
  if (Number(input?.unboundPieces) > 0) {
    warnings.push(
      `还有 ${Number(input.unboundPieces)} 件待发没绑图案（${Number(input?.unboundRows) || 0} 行）—— 本单不含这些件`,
    );
  }
  if (missingArtwork.length) {
    warnings.push(`${missingArtwork.length} 个图案缺图稿（不能制版）`);
  }

  return {
    zip: buildZip(entries),
    images: images.length,
    missingArtwork,
    warnings,
    rows: lines.length,
  };
}
