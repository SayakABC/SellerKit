import * as XLSX from 'xlsx';
import type { RecordItem } from '../types';

export interface ParseResult {
  headers: string[];
  records: RecordItem[];
}

function isEmptyRow(row: (string | number | null | undefined)[]): boolean {
  return row.every((cell) => cell === null || cell === undefined || cell === '');
}

function deduplicateHeaders(headers: string[]): string[] {
  const countMap: Record<string, number> = {};
  return headers.map((h) => {
    const key = String(h || '').trim();
    if (!key) return `Column_${Object.keys(countMap).length + 1}`;
    if (countMap[key] === undefined) {
      countMap[key] = 0;
      return key;
    } else {
      countMap[key]++;
      return `${key}_${countMap[key]}`;
    }
  });
}

export function parseExcel(buffer: ArrayBuffer): ParseResult {
  const workbook = XLSX.read(buffer, { type: 'array' });
  const sheetName = workbook.SheetNames[0];
  if (!sheetName) throw new Error('No sheet found in Excel file');

  const sheet = workbook.Sheets[sheetName];
  const rawData: (string | number | null | undefined)[][] = XLSX.utils.sheet_to_json(sheet, {
    header: 1,
    defval: '',
  });

  // Remove leading empty rows
  while (rawData.length > 0 && isEmptyRow(rawData[0])) {
    rawData.shift();
  }

  // Remove trailing empty rows
  while (rawData.length > 0 && isEmptyRow(rawData[rawData.length - 1])) {
    rawData.pop();
  }

  if (rawData.length === 0) throw new Error('Excel file is empty');

  // First non-empty row is the header
  const headerRow = rawData[0];
  let headers = headerRow.map((h) => String(h ?? '').trim());
  headers = deduplicateHeaders(headers);

  // Data rows
  const records: RecordItem[] = [];
  for (let i = 1; i < rawData.length; i++) {
    const row = rawData[i];
    if (isEmptyRow(row)) continue;

    const fields: Record<string, string> = {};
    headers.forEach((header, idx) => {
      const cellValue = row[idx];
      fields[header] = cellValue !== null && cellValue !== undefined ? String(cellValue) : '';
    });

    records.push({
      id: i,
      fields,
      used: false,
      order: i,
    });
  }

  return { headers, records };
}
