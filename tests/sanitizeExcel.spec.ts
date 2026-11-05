// sanitizeExcel 单测 —— 覆盖「超限语义分层」这一契约：
//   ① 配置类（规则条数 / 表头列数 / 单条字段数 / 文件体积）→ 拒绝并抛错
//   ② 数据类（记录行数 / 单元格长度）→ 截断，但必须回传截断元信息
// 这些是 iframe 不可信入参的第一道整形，静默截断曾导致「数据莫名变少」且无从排查。

import { describe, expect, it } from 'vitest';
import {
  assertExcelBytes,
  EC_MAX_EXCEL_BYTES,
  EC_MAX_FIELDS,
  EC_MAX_HEADERS,
  EC_MAX_RECORDS,
  EC_MAX_RULES,
  EC_MAX_STR,
  sanitizeRecords,
  sanitizeRules,
} from '../src/core/plugin/sanitizeExcel';

const rule = (type = 'template') => ({ id: 'r1', name: 'n', type, targetField: 'f', enabled: true });

describe('① 配置类超限 —— 拒绝并报错（不再是静默截断）', () => {
  it('规则条数超限抛错，且不返回任何规则', () => {
    const raw = Array.from({ length: EC_MAX_RULES + 1 }, () => rule());
    expect(() => sanitizeRules(raw)).toThrow(/规则条数 超限/);
  });

  it('规则条数刚好等于上限时放行（边界不误伤）', () => {
    const raw = Array.from({ length: EC_MAX_RULES }, () => rule());
    expect(sanitizeRules(raw)).toHaveLength(EC_MAX_RULES);
  });

  it('单条记录字段数超限抛错', () => {
    const fields: Record<string, string> = {};
    for (let i = 0; i < EC_MAX_FIELDS + 1; i++) fields[`c${i}`] = 'v';
    expect(() => sanitizeRecords([{ id: 1, fields }])).toThrow(/单条记录字段数 超限/);
  });

  it('Excel 体积超限抛错；等于上限放行', () => {
    expect(() => assertExcelBytes(new ArrayBuffer(EC_MAX_EXCEL_BYTES + 1))).toThrow(/Excel 文件大小 超限/);
    expect(() => assertExcelBytes(new ArrayBuffer(EC_MAX_EXCEL_BYTES))).not.toThrow();
  });

  it('错误信息带上实际值与上限，便于岛侧直接展示', () => {
    const raw = Array.from({ length: 100 }, () => rule());
    expect(() => sanitizeRules(raw)).toThrow(`规则条数 超限：100 > ${EC_MAX_RULES}`);
  });
});

describe('② 数据类超限 —— 截断但可感知', () => {
  it('记录数超限：保留前 N 行，并回传丢弃行数', () => {
    const raw = Array.from({ length: EC_MAX_RECORDS + 7 }, (_, i) => ({ id: i + 1, fields: { a: 'x' } }));
    const { records, truncation } = sanitizeRecords(raw);
    expect(records).toHaveLength(EC_MAX_RECORDS);
    expect(truncation.droppedRecords).toBe(7);
  });

  it('未超限时截断计数全为 0（不误报）', () => {
    const { truncation } = sanitizeRecords([{ id: 1, fields: { a: 'x' } }]);
    expect(truncation).toEqual({ droppedRecords: 0, truncatedStrings: 0 });
  });

  it('超长单元格被截断到 EC_MAX_STR，并计数', () => {
    const long = 'x'.repeat(EC_MAX_STR + 500);
    const { records, truncation } = sanitizeRecords([{ id: 1, fields: { a: long, b: 'ok' } }]);
    expect(records[0].fields.a).toHaveLength(EC_MAX_STR);
    expect(records[0].fields.b).toBe('ok');
    expect(truncation.truncatedStrings).toBe(1);
  });

  it('非数组入参返回空集且不抛错（iframe 载荷形状不可信）', () => {
    expect(sanitizeRecords(undefined)).toEqual({
      records: [],
      truncation: { droppedRecords: 0, truncatedStrings: 0 },
    });
    expect(sanitizeRules(null)).toEqual([]);
  });
});

describe('结构消毒本身（不因分层改造而回退）', () => {
  it('丢弃类型不在白名单内的规则（绝不把未校验对象透给规则引擎）', () => {
    expect(sanitizeRules([rule('evilType'), rule('template')])).toHaveLength(1);
  });

  it('非字符串字段被丢弃，只保留字符串值', () => {
    const { records } = sanitizeRecords([{ id: 1, fields: { a: 'keep', b: 123, c: null } }]);
    expect(records[0].fields).toEqual({ a: 'keep' });
  });

  it('表头列名长度受 EC_MAX_HEADERS 约束（列名本身仍在配置类之外按数据类截断）', () => {
    const longKey = 'k'.repeat(EC_MAX_HEADERS + 10);
    const { records } = sanitizeRecords([{ id: 1, fields: { [longKey]: 'v' } }]);
    expect(Object.keys(records[0].fields)[0]).toHaveLength(EC_MAX_HEADERS);
  });
});
