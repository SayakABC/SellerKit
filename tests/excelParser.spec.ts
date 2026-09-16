// excelParser 单测 —— 这是用户数据的入口：表头去重、空行裁剪、值字符串化
// 一旦回归，症状是"列名错位 / 记录缺失"而不是报错，属最难发现的一类 bug。
// 夹具 order.xlsx 为固定入库文件（生成方式见 tests/fixtures/generate-fixtures.mjs）。
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import * as XLSX from 'xlsx';
import { parseExcel } from '../src/lib/excelParser';

/** 读取入库夹具并转成生产同款入参（渲染层 FileReader 给的就是 ArrayBuffer） */
function fixture(name: string): ArrayBuffer {
  const buf = readFileSync(new URL(`./fixtures/${name}`, import.meta.url));
  return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer;
}

/** 用内存构造的工作簿（只用于构造边界输入，避免为每个边界都提交一个二进制夹具） */
function workbookBuffer(rows: (string | number)[][]): ArrayBuffer {
  const wb = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(wb, XLSX.utils.aoa_to_sheet(rows), 'Sheet1');
  return XLSX.write(wb, { type: 'array', bookType: 'xlsx' }) as ArrayBuffer;
}

describe('parseExcel · 真实夹具 orders.xlsx', () => {
  const result = parseExcel(fixture('orders.xlsx'));

  it('重复表头自动加序号后缀，保持列数不变', () => {
    expect(result.headers).toEqual(['订单号', '商品名称', '商品名称_1', '数量', '金额', '下单时间']);
  });

  it('只解析第一个工作表（第二个"说明"表不参与）', () => {
    expect(result.headers).not.toContain('无关表头');
  });

  it('首尾空行被裁掉、数据区空行被跳过 → 恰好 2 条记录', () => {
    expect(result.records).toHaveLength(2);
  });

  it('记录 id/order 保留源表行序（被跳过的空行会留下编号间隙：1, 3）', () => {
    // 这是"可回溯到源表行"的取舍：id/order 用的是原始行下标而非连续计数。
    // 若将来需要连续编号（例如界面上的行号显示），改这里就说明行为变了。
    expect(result.records.map((r) => r.id)).toEqual([1, 3]);
    expect(result.records.map((r) => r.order)).toEqual([1, 3]);
    expect(result.records.every((r) => r.used === false)).toBe(true);
  });

  it('重复列按去重后的表头各就各位（不串列）', () => {
    expect(result.records[0].fields['商品名称']).toBe('短袖T恤 A款');
    expect(result.records[0].fields['商品名称_1']).toBe('圆领 白色');
    expect(result.records[1].fields['订单号']).toBe('SO-1002');
  });

  it('单元格值统一转成字符串', () => {
    expect(typeof result.records[0].fields['数量']).toBe('string');
    expect(result.records[0].fields['数量']).toBe('2');
    expect(result.records[0].fields['金额']).toBe('¥128.00');
  });
});

describe('parseExcel · 边界输入', () => {
  it('空表头单元格补成 Column_N（编号按"已见非空表头数+1"，故可能与列序号不一致）', () => {
    const r = parseExcel(workbookBuffer([['', 'b', ''], ['1', '2', '3']]));
    expect(r.headers).toEqual(['Column_1', 'b', 'Column_2']);
  });

  it('⚠️ 已知缺陷 C-23：多个空表头会拿到重复列名，导致这些列的数据相互覆盖', () => {
    // 触发条件：表头行有 ≥2 个空单元格（例如数据列比表头列多、或表头上有合并标题行）。
    // 后果：headers 里出现重复项，而 parseExcel 用 `fields[header] = value` 赋值，
    //       后一列会静默覆盖前一列 —— 属于"不报错但丢数据"。
    // 修复方向：为 Column_N 生成的名字也要占用 countMap，并做最终去重（约 3 行）。
    // 本用例固化的是**当前缺陷行为**，用于保证缺陷可见；修好后此处应变红并同步更新。
    const r = parseExcel(workbookBuffer([['', '', 'x'], ['1', '2', '3']]));
    expect(r.headers).toEqual(['Column_1', 'Column_1', 'x']);
    expect(Object.keys(r.records[0].fields)).toHaveLength(2); // 'x' 与合并后的 'Column_1'
  });

  it('同名表头出现三次 → x / x_1 / x_2', () => {
    const r = parseExcel(workbookBuffer([['x', 'x', 'x'], ['1', '2', '3']]));
    expect(r.headers).toEqual(['x', 'x_1', 'x_2']);
    expect(r.records[0].fields).toEqual({ x: '1', x_1: '2', x_2: '3' });
  });

  it('表头两侧空白被 trim', () => {
    const r = parseExcel(workbookBuffer([['  订单号  '], ['SO-1']]));
    expect(r.headers).toEqual(['订单号']);
  });

  it('数值型单元格转字符串（不保留 .0）', () => {
    const r = parseExcel(workbookBuffer([['数量'], [128]]));
    expect(r.records[0].fields['数量']).toBe('128');
  });

  it('全空工作表抛 "Excel file is empty"', () => {
    expect(() => parseExcel(workbookBuffer([[''], ['']]))).toThrow('Excel file is empty');
  });

  it('只有表头、没有数据行 → headers 正常、records 为空', () => {
    const r = parseExcel(workbookBuffer([['订单号', 'SKU']]));
    expect(r.headers).toEqual(['订单号', 'SKU']);
    expect(r.records).toEqual([]);
  });
});
