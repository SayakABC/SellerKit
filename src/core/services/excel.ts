// Excel 读取/解析服务：封装「文件路径 → 解析结果」与「ArrayBuffer → 解析结果」。

import { ipc } from './ipc';
import { parseExcel } from '@/lib/excelParser';

export type ParseResult = ReturnType<typeof parseExcel>;

export interface ImportExcelResult {
  filePath: string;
  result: ParseResult;
}

/** 从文件路径读取并解析 Excel */
export async function importExcelFromFile(filePath: string): Promise<ImportExcelResult | null> {
  const result = await ipc.importExcelByPath(filePath);
  if (!result.success || !result.data) return null;
  return {
    filePath: result.data.filePath,
    result: parseExcel(result.data.data),
  };
}

/** 从拖拽/选择的 ArrayBuffer 解析 Excel（同步，供组件直接调用） */
export function parseExcelBuffer(buffer: ArrayBuffer): ParseResult {
  return parseExcel(buffer);
}
