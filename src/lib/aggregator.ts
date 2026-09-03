// src/lib/aggregator.ts
// 数据透视聚合引擎（纯函数，无副作用，可单测）：
//   输入订单行列表 + 透视规格（维度 / 度量 / 筛选），输出分组汇总行。
// 字段标识约定：
//   - 结构化字段：'shop' | 'size' | 'orderTime' | 'category' | 'color' | 'logo' | 'createdAt'
//   - Excel 原始列：'raw:<列名>'（取值来自 OrderRecord.rawFields）
// 供「订单归类」模块的汇总面板与导出复用；不依赖 Electron / Vue。

import type { OrderRecord } from '@/types';

/** 日期字段的桶粒度 */
export type DateBucket = 'year' | 'month' | 'day';

/** 分组维度（可多选；日期字段可指定桶粒度） */
export interface PivotDimension {
  field: string;
  bucket?: DateBucket;
}

/** 聚合度量（计数 + 数值列的求和/平均/最大/最小/去重计数） */
export interface PivotMeasure {
  id: string;
  /** 参与计算的字段；op=count 时忽略 */
  field: string;
  op: 'count' | 'countDistinct' | 'sum' | 'avg' | 'max' | 'min';
  /** 表头显示名（留空自动生成） */
  alias?: string;
}

/** 行筛选（AND 语义；gt/lt 对可解析为数字的值生效） */
export interface PivotFilter {
  field: string;
  op: 'eq' | 'ne' | 'contains' | 'notContains' | 'gt' | 'lt' | 'empty' | 'notEmpty';
  value: string;
}

export interface PivotSpec {
  dimensions: PivotDimension[];
  measures: PivotMeasure[];
  filters?: PivotFilter[];
  /** 排序：'count' = 按计数倒序（默认）；'key' = 按维度组合字典序 */
  sort?: 'count' | 'key';
}

/** 汇总结果行 */
export interface PivotRow {
  /** 维度值组合（以 | 连接，供 :key 与钻取匹配） */
  key: string;
  /** 维度 id（见 dimensionId）→ 维度值（空值存空串） */
  dims: Record<string, string>;
  /** 度量 id → 数值（已四舍五入到 2 位小数） */
  measures: Record<string, number>;
  /** 组内行数（冗余：便于排序与展示） */
  count: number;
}

/** 字段池元信息（UI 渲染用） */
export interface FieldMeta {
  field: string;
  label: string;
  /** 是否为日期字段（可桶化） */
  date?: boolean;
}

/** 结构化字段池（固定） */
export const STRUCTURED_FIELD_POOL: FieldMeta[] = [
  { field: 'shop', label: '店铺' },
  { field: 'size', label: '尺寸' },
  { field: 'orderTime', label: '下单时间', date: true },
  { field: 'logo', label: 'Logo' },
  { field: 'createdAt', label: '导入日期', date: true },
  { field: 'styleCode', label: '款编码' },
  { field: 'styleName', label: '款式名' },
  { field: 'styleColor', label: '款色' },
  { field: 'status', label: '订单状态' },
];

export const DATE_BUCKET_LABEL: Record<DateBucket, string> = {
  year: '按年',
  month: '按月',
  day: '按日',
};

export const MEASURE_OP_LABEL: Record<PivotMeasure['op'], string> = {
  count: '数量',
  countDistinct: '去重数',
  sum: '合计',
  avg: '平均',
  max: '最大',
  min: '最小',
};

/** 维度是否结构化字段（非 raw: 前缀） */
export function isStructuredField(field: string): boolean {
  return !field.startsWith('raw:');
}

/** Excel 原始列 → 字段 id */
export function rawFieldId(column: string): string {
  return 'raw:' + column;
}

/** 字段 id → 显示名 */
export function fieldLabel(field: string): string {
  if (field.startsWith('raw:')) return field.slice(4);
  return STRUCTURED_FIELD_POOL.find((f) => f.field === field)?.label ?? field;
}

/** 维度 id（同字段不同桶视为不同维度） */
export function dimensionId(dim: PivotDimension): string {
  return dim.bucket ? `${dim.field}@${dim.bucket}` : dim.field;
}

function getFieldValue(row: OrderRecord, field: string): string {
  if (field.startsWith('raw:')) return row.rawFields?.[field.slice(4)] ?? '';
  switch (field) {
    case 'shop': return row.shop ?? '';
    case 'size': return row.size ?? '';
    case 'orderTime': return row.orderTime ?? '';
    case 'category': return row.category ?? '';
    case 'color': return row.color ?? '';
    case 'logo': return row.logo ?? '';
    // material 已移除（字段池无该项）；旧聚合配置如仍含该维度则取值恒为空串
    case 'material': return '';
    case 'createdAt': return row.createdAt ?? '';
    case 'styleCode': return row.styleCode ?? '';
    case 'styleName': return row.styleName ?? '';
    case 'styleColor': return row.styleColor ?? '';
    case 'status': return orderStatusLabel(row.status ?? 'pending');
    default: return '';
  }
}

/** 订单状态显示名 */
export function orderStatusLabel(status: string): string {
  return status === 'shipped' ? '已发货' : '未发货';
}

function parseDate(v: string): Date | null {
  const t = (v || '').trim();
  if (!t) return null;
  const d = new Date(t);
  if (!isNaN(d.getTime())) return d;
  // 兼容 "2024年8月24日 10:30" / "2024/8/24" 等非标准格式
  const m = t.match(/(\d{4})[年/.\-](\d{1,2})(?:[月/.\-](\d{1,2}))?/);
  if (m) {
    const d2 = new Date(Number(m[1]), Number(m[2]) - 1, m[3] ? Number(m[3]) : 1);
    if (!isNaN(d2.getTime())) return d2;
  }
  return null;
}

/** 维度取值（已应用日期桶；解析失败的日期原样返回） */
export function getDimensionValue(row: OrderRecord, dim: PivotDimension): string {
  const raw = getFieldValue(row, dim.field);
  if (!dim.bucket) return raw;
  const d = parseDate(raw);
  if (!d) return raw;
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, '0');
  const day = String(d.getDate()).padStart(2, '0');
  if (dim.bucket === 'year') return String(y);
  if (dim.bucket === 'month') return `${y}-${m}`;
  return `${y}-${m}-${day}`;
}

/** 解析数值（去千分位；失败返回 NaN） */
function toNumber(v: string): number {
  if (v === null || v === undefined || v === '') return NaN;
  const n = Number(String(v).replace(/,/g, '').trim());
  return Number.isNaN(n) ? NaN : n;
}

function matchFilter(value: string, f: PivotFilter): boolean {
  switch (f.op) {
    case 'eq': return value === f.value;
    case 'ne': return value !== f.value;
    case 'contains': return value.includes(f.value);
    case 'notContains': return !value.includes(f.value);
    case 'gt': {
      const a = toNumber(value);
      const b = toNumber(f.value);
      return !Number.isNaN(a) && !Number.isNaN(b) && a > b;
    }
    case 'lt': {
      const a = toNumber(value);
      const b = toNumber(f.value);
      return !Number.isNaN(a) && !Number.isNaN(b) && a < b;
    }
    case 'empty': return value === '';
    case 'notEmpty': return value !== '';
    default: return true;
  }
}

interface AccEntry {
  sum: number;
  cnt: number;
  hasVal: boolean;
  max: number;
  min: number;
  distinct: Set<string>;
}

type Acc = Map<string, AccEntry>;

function initAcc(measures: PivotMeasure[]): Acc {
  const acc: Acc = new Map();
  for (const m of measures) {
    acc.set(m.id, { sum: 0, cnt: 0, hasVal: false, max: -Infinity, min: Infinity, distinct: new Set() });
  }
  return acc;
}

function accumulate(acc: Acc, row: OrderRecord, measures: PivotMeasure[]): void {
  for (const m of measures) {
    const a = acc.get(m.id);
    if (!a) continue;
    if (m.op === 'count') continue; // count 在 finalize 用组内行数
    const raw = getFieldValue(row, m.field);
    if (m.op === 'countDistinct') {
      a.distinct.add(raw);
      continue;
    }
    const n = toNumber(raw);
    if (Number.isNaN(n)) continue;
    a.sum += n;
    a.cnt += 1;
    a.hasVal = true;
    if (n > a.max) a.max = n;
    if (n < a.min) a.min = n;
  }
}

function round(n: number): number {
  return Math.round(n * 100) / 100;
}

function finalize(acc: Acc, measures: PivotMeasure[], rowCount: number): Record<string, number> {
  const out: Record<string, number> = {};
  for (const m of measures) {
    const a = acc.get(m.id);
    if (!a) {
      out[m.id] = 0;
      continue;
    }
    switch (m.op) {
      case 'count': out[m.id] = rowCount; break;
      case 'countDistinct': out[m.id] = a.distinct.size; break;
      case 'sum': out[m.id] = round(a.sum); break;
      case 'avg': out[m.id] = round(a.hasVal ? a.sum / a.cnt : 0); break;
      case 'max': out[m.id] = a.hasVal ? a.max : 0; break;
      case 'min': out[m.id] = a.hasVal ? a.min : 0; break;
    }
  }
  return out;
}

/**
 * 对订单行执行透视聚合。
 * @param rows 订单行（建议传入脱壳后的纯对象数组）
 * @param spec 透视规格：维度 + 度量 + 可选筛选/排序
 * @returns 汇总行数组；无维度时返回单行（整表汇总）
 */
export function pivotRows(rows: OrderRecord[], spec: PivotSpec): PivotRow[] {
  const dims = spec.dimensions ?? [];
  const measures =
    spec.measures && spec.measures.length
      ? spec.measures
      : [{ id: 'count', field: '', op: 'count' as const, alias: '数量' }];
  const filters = spec.filters ?? [];

  const list = filters.length
    ? rows.filter((r) => filters.every((f) => matchFilter(getFieldValue(r, f.field), f)))
    : rows;

  if (dims.length === 0) {
    const acc = initAcc(measures);
    for (const r of list) accumulate(acc, r, measures);
    return [{ key: '', dims: {}, measures: finalize(acc, measures, list.length), count: list.length }];
  }

  const buckets = new Map<string, OrderRecord[]>();
  for (const r of list) {
    const key = dims.map((d) => getDimensionValue(r, d)).join('|');
    let arr = buckets.get(key);
    if (!arr) {
      arr = [];
      buckets.set(key, arr);
    }
    arr.push(r);
  }

  const out: PivotRow[] = [];
  for (const [key, group] of buckets) {
    const parts = key.split('|');
    const dimsMap: Record<string, string> = {};
    dims.forEach((d, i) => {
      dimsMap[dimensionId(d)] = parts[i] ?? '';
    });
    const acc = initAcc(measures);
    for (const r of group) accumulate(acc, r, measures);
    out.push({ key, dims: dimsMap, measures: finalize(acc, measures, group.length), count: group.length });
  }

  const byKey = spec.sort === 'key';
  out.sort((a, b) => {
    if (byKey) return a.key.localeCompare(b.key, 'zh-Hans-CN');
    if (b.count !== a.count) return b.count - a.count;
    return a.key.localeCompare(b.key, 'zh-Hans-CN');
  });
  return out;
}
