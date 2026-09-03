// 文件选择对话框服务：封装 select-excel / select-template。

import { ipc } from './ipc';
import type { ExcelFilePayload, TemplateFilePayload } from './ipc';

/** 选择 Excel 文件，返回 { filePath, data } 或 null（用户取消/失败） */
export async function selectExcelFile(): Promise<ExcelFilePayload | null> {
  const result = await ipc.selectExcel();
  return result.success && result.data ? result.data : null;
}

/** 选择模板文本文件，返回 { filePath, content } 或 null */
export async function selectTemplateFile(): Promise<TemplateFilePayload | null> {
  const result = await ipc.selectTemplate();
  return result.success && result.data ? result.data : null;
}
