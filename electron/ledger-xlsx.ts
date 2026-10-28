// electron/ledger-xlsx.ts
// 「记账明细导出 xlsx」的**生成**部分（不含对话框、不含磁盘写入）。
//
// 与 `picking-xlsx.ts` 同一分工：主进程只做"分行 → 画表 → 存盘"，
// **一个业务口径都不搬** —— 行文本、金额（分）、三个合计全部由渲染层算好传进来
// （渲染层是这些数的唯一实现；主进程再算一遍就会出现"导出的表与屏幕上的数不一致"）。
//
// 本文件不 import 任何 `*-db`：保持纯函数，才能被冒烟脚本直接调用验产物（同 picking-xlsx 的理由）。

export {};

/** 一行导出（文本已由渲染层本地化；金额为整数分，本层只负责换算与格式） */
export interface LedgerExportRow {
  bizDate: string;
  /** 收入 / 支出 */
  kindLabel: string;
  /** 专属这家店 / 公共分摊（可带店数，如「公共 · 5 家」） */
  scopeLabel: string;
  /** 店名（公共条目写分摊店数说明） */
  shopLabel: string;
  partyName: string;
  categoryName: string;
  amountCents: number;
  /** 未结算 / 已结算 #9 / 已作废 */
  settleLabel: string;
  note: string;
}

export interface LedgerExportInput {
  title: string;
  /** 期间文案，如「2026-10」或「2026-10-01 ~ 2026-10-31」 */
  periodLabel: string;
  /** 筛选摘要（渲染层给的本地化文案，可能为空） */
  filterLabel: string;
  rows: LedgerExportRow[];
  /** 底部合计（与屏幕上的三个数同源，本层不复算） */
  totalIncomeCents: number;
  totalExpenseCents: number;
  balanceCents: number;
}

const HEAD = ['日期', '收/支', '范围', '店铺', '相关人', '科目', '金额(元)', '结算', '备注'];
const WIDTHS = [12, 8, 16, 20, 18, 14, 14, 16, 40];

/** 分 → 元（保留两位，交给 numFmt 显示；不在这里 round 成字符串，避免与屏幕显示口径分叉） */
function yuan(cents: number): number {
  return Math.round(Number(cents) || 0) / 100;
}

export async function buildLedgerWorkbook(input: LedgerExportInput): Promise<Buffer> {
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('记账明细');

  WIDTHS.forEach((w, i) => {
    ws.getColumn(i + 1).width = w;
  });

  ws.addRow([input.title || '记账明细']);
  ws.getRow(1).font = { bold: true, size: 14 };
  ws.addRow([`期间：${input.periodLabel || '全部'}`]);
  if (input.filterLabel) {
    ws.addRow([`筛选：${input.filterLabel}`]);
    ws.getRow(3).font = { italic: true };
  }
  ws.addRow([]);

  const headRowIndex = ws.rowCount + 1;
  ws.addRow(HEAD);
  ws.getRow(headRowIndex).font = { bold: true };

  for (const r of input.rows) {
    ws.addRow([
      r.bizDate,
      r.kindLabel,
      r.scopeLabel,
      r.shopLabel,
      r.partyName,
      r.categoryName,
      yuan(r.amountCents),
      r.settleLabel,
      r.note,
    ]);
    ws.getRow(ws.rowCount).getCell(7).numFmt = '0.00';
  }

  ws.addRow([]);
  const totals: Array<[string, number]> = [
    ['本期收入', input.totalIncomeCents],
    ['本期支出', input.totalExpenseCents],
    ['结余', input.balanceCents],
  ];
  for (const [label, cents] of totals) {
    ws.addRow(['', '', '', '', '', label, yuan(cents)]);
    const row = ws.getRow(ws.rowCount);
    row.font = { bold: true };
    row.getCell(7).numFmt = '0.00';
  }

  return (await wb.xlsx.writeBuffer()) as Buffer;
}

/**
 * 「下载导入模板」的三张表（数据表 + 填写说明 + 已有名称）。
 *
 * 表的**内容**由渲染层 `buildLedgerTemplateSheets` 生成 —— 列定义、必填标记、别名族、例子
 * 都在 `src/lib/ledgerImport.ts` 那一份里（模板与解析器共用一份定义，改列不会只改一边）。
 * 本层只做"画成 xlsx 存盘"，与 `buildLedgerWorkbook` 同一分工。
 */
export interface LedgerTemplateSheetInput {
  name: string;
  /** 逐行文本（第一行通常是表头） */
  rows: readonly (readonly string[])[];
  /** 各列宽（字符数），可为空 */
  widths?: readonly number[];
}

export async function buildLedgerTemplateWorkbook(
  sheets: readonly LedgerTemplateSheetInput[],
): Promise<Buffer> {
  // `Array.isArray` 会把 `readonly T[]` 窄成 `any[]`，这里显式标回类型（主进程开了 noImplicitAny）
  const list: readonly LedgerTemplateSheetInput[] = Array.isArray(sheets) ? sheets.slice(0, 8) : [];
  if (!list.length) throw new Error('模板没有内容');
  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const usedNames = new Set<string>();

  for (const s of list) {
    let name = String(s?.name ?? '').trim().slice(0, 31) || '模板';
    // Excel 不允许两张同名表（写了会得到打不开的文件）：撞名就加序号，而不是静默覆盖
    for (let n = 2; usedNames.has(name); n++) name = `${name.slice(0, 28)}${n}`;
    usedNames.add(name);
    const ws = wb.addWorksheet(name);
    (s?.widths ?? []).slice(0, 40).forEach((w, i) => {
      ws.getColumn(i + 1).width = Math.min(120, Math.max(6, Number(w) || 12));
    });
    const rows = (s?.rows ?? []).slice(0, 2000);
    rows.forEach((cells, index) => {
      ws.addRow((cells ?? []).slice(0, 40).map((c) => String(c ?? '')));
      if (index === 0) ws.getRow(ws.rowCount).font = { bold: true };
    });
    // 表头冻住：用户在「已有名称」里对着名字抄，滚动时表头不能消失
    ws.views = [{ state: 'frozen', ySplit: 1 }];
  }

  return (await wb.xlsx.writeBuffer()) as Buffer;
}