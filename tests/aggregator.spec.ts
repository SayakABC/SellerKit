// aggregator 单测 —— 汇总面板与导出共用同一套聚合逻辑，
// 分组键、度量口径（四舍五入/去重/空值处理）一旦回归，用户看到的就是"数字对不上"。
import { describe, it, expect } from 'vitest';
import {
  pivotRows,
  getDimensionValue,
  dimensionId,
  fieldLabel,
  rawFieldId,
  isStructuredField,
  orderStatusLabel,
  STRUCTURED_FIELD_POOL,
  type PivotSpec,
} from '../src/lib/aggregator';
import type { OrderRecord } from '../src/types';

/**
 * 只给维度、不给度量的 PivotSpec。
 *
 * 实现里 measures 有 count 兜底（aggregator.ts:267 `spec.measures && spec.measures.length`），
 * 但 PivotSpec 把 measures 标为**必填**，因此类型层面无法直接传"省略 measures"的规格。
 * 这里用一次断言把该兜底分支纳入测试覆盖；生产调用方（PivotPanel.vue、order-insight
 * store）均显式传 measures，不受影响。
 */
const withoutMeasures = (spec: Omit<PivotSpec, 'measures'>): PivotSpec => spec as PivotSpec;

function rec(partial: Partial<OrderRecord>): OrderRecord {
  return {
    imageId: 1,
    orderNo: 'SO-1',
    shop: '',
    size: '',
    rawFields: {},
    category: '',
    color: '',
    logo: '',
    ...partial,
  };
}

describe('字段 id 辅助函数', () => {
  it('raw: 前缀判定与标签', () => {
    expect(isStructuredField('shop')).toBe(true);
    expect(isStructuredField(rawFieldId('金额'))).toBe(false);
    expect(rawFieldId('金额')).toBe('raw:金额');
    expect(fieldLabel('raw:金额')).toBe('金额');
  });

  it('结构化字段取字段池显示名；未知字段回落原 id', () => {
    expect(fieldLabel('orderTime')).toBe('下单时间');
    expect(fieldLabel('unknownField')).toBe('unknownField');
  });

  it('字段池内所有字段都能取到 label（防止池里漏配）', () => {
    for (const f of STRUCTURED_FIELD_POOL) {
      expect(fieldLabel(f.field)).toBe(f.label);
    }
  });

  it('维度 id 区分桶粒度', () => {
    expect(dimensionId({ field: 'orderTime' })).toBe('orderTime');
    expect(dimensionId({ field: 'orderTime', bucket: 'month' })).toBe('orderTime@month');
  });

  it('订单状态显示名', () => {
    expect(orderStatusLabel('shipped')).toBe('已发货');
    expect(orderStatusLabel('pending')).toBe('未发货');
  });
});

describe('getDimensionValue', () => {
  const row = rec({
    shop: 'A店',
    orderTime: '2024年8月24日 10:30',
    status: 'shipped',
    rawFields: { 金额: '¥128.00' },
  });

  it('raw: 字段取 rawFields 原值', () => {
    expect(getDimensionValue(row, { field: 'raw:金额' })).toBe('¥128.00');
  });

  it('日期桶：年 / 月 / 日', () => {
    expect(getDimensionValue(row, { field: 'orderTime', bucket: 'year' })).toBe('2024');
    expect(getDimensionValue(row, { field: 'orderTime', bucket: 'month' })).toBe('2024-08');
    expect(getDimensionValue(row, { field: 'orderTime', bucket: 'day' })).toBe('2024-08-24');
  });

  it('日期解析失败时原样返回（不丢维度值）', () => {
    const r = rec({ orderTime: '待确认' });
    expect(getDimensionValue(r, { field: 'orderTime', bucket: 'month' })).toBe('待确认');
  });

  it('status 维度取显示名而非原始枚举', () => {
    expect(getDimensionValue(row, { field: 'status' })).toBe('已发货');
  });

  it('缺失的结构化字段返回空串；未识别的字段名也返回空串', () => {
    expect(getDimensionValue(rec({}), { field: 'shop' })).toBe('');
    expect(getDimensionValue(rec({}), { field: '不存在的字段' })).toBe('');
    expect(getDimensionValue(rec({}), { field: 'material' })).toBe('');
  });
});

describe('pivotRows · 分组与度量', () => {
  const rows = [
    rec({ shop: 'A', size: 'S', rawFields: { 金额: '100.5' }, category: '短袖T恤' }),
    rec({ shop: 'A', size: 'M', rawFields: { 金额: '99.5' }, category: '短袖T恤' }),
    rec({ shop: 'B', size: 'S', rawFields: { 金额: '50' }, category: '长裤' }),
  ];

  it('无维度 → 返回单行整表汇总', () => {
    const out = pivotRows(rows, { dimensions: [], measures: [] });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ key: '', dims: {}, count: 3 });
    expect(out[0].measures).toEqual({ count: 3 });
  });

  it('未指定度量时默认按数量计数', () => {
    const out = pivotRows(rows, withoutMeasures({ dimensions: [{ field: 'shop' }] }));
    expect(out.map((r) => [r.dims.shop, r.measures.count])).toEqual([
      ['A', 2],
      ['B', 1],
    ]);
  });

  it('sum / avg / max / min 与两位小数四舍五入', () => {
    const spec: PivotSpec = {
      dimensions: [{ field: 'shop' }],
      measures: [
        { id: 'sum', field: 'raw:金额', op: 'sum' },
        { id: 'avg', field: 'raw:金额', op: 'avg' },
        { id: 'max', field: 'raw:金额', op: 'max' },
        { id: 'min', field: 'raw:金额', op: 'min' },
      ],
    };
    const a = pivotRows(rows, spec).find((r) => r.dims.shop === 'A')!;
    expect(a.measures).toEqual({ sum: 200, avg: 100, max: 100.5, min: 99.5 });
  });

  // 下面两条专门钉住 round()：上面的用例取值恰好都是精确值，去掉 round 也照样通过
  // （变异测试实测漏检），故补上"浮点残差"与"除不尽"两类会真正暴露未收敛的输入。
  it('sum 收敛浮点加法残差：0.1 + 0.2 = 0.3（而非 0.30000000000000004）', () => {
    const out = pivotRows(
      [
        rec({ shop: 'A', rawFields: { 金额: '0.1' } }),
        rec({ shop: 'A', rawFields: { 金额: '0.2' } }),
      ],
      { dimensions: [{ field: 'shop' }], measures: [{ id: 'sum', field: 'raw:金额', op: 'sum' }] },
    );
    expect(out[0].measures.sum).toBe(0.3);
  });

  it('avg 收敛除不尽的结果：(10 + 10 + 10.1) / 3 → 10.03', () => {
    const out = pivotRows(
      [
        rec({ shop: 'A', rawFields: { 金额: '10' } }),
        rec({ shop: 'A', rawFields: { 金额: '10' } }),
        rec({ shop: 'A', rawFields: { 金额: '10.1' } }),
      ],
      { dimensions: [{ field: 'shop' }], measures: [{ id: 'avg', field: 'raw:金额', op: 'avg' }] },
    );
    expect(out[0].measures.avg).toBe(10.03); // 未收敛时是 10.033333333333333
  });

  it('countDistinct 按去重值计数（含空串）', () => {
    const out = pivotRows(
      [
        rec({ shop: 'A', size: 'S' }),
        rec({ shop: 'A', size: 'S' }),
        rec({ shop: 'A', size: 'M' }),
        rec({ shop: 'A', size: '' }),
      ],
      { dimensions: [{ field: 'shop' }], measures: [{ id: 'd', field: 'size', op: 'countDistinct' }] },
    );
    expect(out[0].measures.d).toBe(3); // S / M / ''
  });

  it('数值无法解析时不计入 sum/avg，但行仍计入 count', () => {
    const out = pivotRows(
      [rec({ shop: 'A', rawFields: { 金额: '一百' } }), rec({ shop: 'A', rawFields: { 金额: '50' } })],
      {
        dimensions: [{ field: 'shop' }],
        measures: [
          { id: 'c', field: '', op: 'count' },
          { id: 'sum', field: 'raw:金额', op: 'sum' },
          { id: 'avg', field: 'raw:金额', op: 'avg' },
        ],
      },
    );
    expect(out[0].measures).toEqual({ c: 2, sum: 50, avg: 50 });
  });

  it('全部值不可解析时 max/min/avg 回落为 0（不出现 Infinity）', () => {
    const out = pivotRows([rec({ shop: 'A', rawFields: { 金额: 'x' } })], {
      dimensions: [{ field: 'shop' }],
      measures: [
        { id: 'max', field: 'raw:金额', op: 'max' },
        { id: 'min', field: 'raw:金额', op: 'min' },
        { id: 'avg', field: 'raw:金额', op: 'avg' },
      ],
    });
    expect(out[0].measures).toEqual({ max: 0, min: 0, avg: 0 });
  });

  it('千分位数字可被解析', () => {
    const out = pivotRows([rec({ shop: 'A', rawFields: { 金额: '1,234.5' } })], {
      dimensions: [{ field: 'shop' }],
      measures: [{ id: 'sum', field: 'raw:金额', op: 'sum' }],
    });
    expect(out[0].measures.sum).toBe(1234.5);
  });

  it('多维度分组：key 用 | 连接，dims 按维度 id 展开（含日期桶维度 id）', () => {
    const out = pivotRows(
      [
        rec({ shop: 'A', orderTime: '2024-08-01' }),
        rec({ shop: 'A', orderTime: '2024-08-20' }),
        rec({ shop: 'A', orderTime: '2024-09-01' }),
      ],
      withoutMeasures({ dimensions: [{ field: 'shop' }, { field: 'orderTime', bucket: 'month' }] }),
    );
    expect(out).toHaveLength(2);
    const aug = out.find((r) => r.key === 'A|2024-08')!;
    expect(aug.dims).toEqual({ shop: 'A', 'orderTime@month': '2024-08' });
    expect(aug.count).toBe(2);
  });

  it('默认按计数倒序，计数相同按 key 字典序', () => {
    const out = pivotRows(
      [rec({ shop: 'B' }), rec({ shop: 'A' }), rec({ shop: 'C' }), rec({ shop: 'C' })],
      withoutMeasures({ dimensions: [{ field: 'shop' }] }),
    );
    expect(out.map((r) => r.key)).toEqual(['C', 'A', 'B']);
  });

  it("sort: 'key' 时按维度组合字典序（中文按拼音）", () => {
    const out = pivotRows(
      [rec({ shop: '白' }), rec({ shop: '啊' }), rec({ shop: '白' })],
      withoutMeasures({ dimensions: [{ field: 'shop' }], sort: 'key' }),
    );
    expect(out.map((r) => r.key)).toEqual(['啊', '白']);
  });

  it('空维度值自成一组', () => {
    const out = pivotRows([rec({ shop: '' }), rec({ shop: 'A' })], withoutMeasures({ dimensions: [{ field: 'shop' }] }));
    expect(out.find((r) => r.key === '')).toMatchObject({ count: 1, dims: { shop: '' } });
  });

  it('空输入返回空数组（无维度时为单行 0 计数）', () => {
    expect(pivotRows([], withoutMeasures({ dimensions: [{ field: 'shop' }] }))).toEqual([]);
    expect(pivotRows([], { dimensions: [], measures: [] })).toEqual([
      { key: '', dims: {}, measures: { count: 0 }, count: 0 },
    ]);
  });
});

describe('pivotRows · 筛选', () => {
  const rows = [
    rec({ shop: 'A', size: 'S', rawFields: { 金额: '100' } }),
    rec({ shop: 'A', size: 'M', rawFields: { 金额: '50' } }),
    rec({ shop: 'B', size: '', rawFields: { 金额: '' } }),
  ];
  const countOf = (filters: PivotSpec['filters']) =>
    pivotRows(rows, withoutMeasures({ dimensions: [{ field: 'shop' }], filters })).map((r) => [r.key, r.count]);

  it('eq / ne', () => {
    expect(countOf([{ field: 'shop', op: 'eq', value: 'A' }])).toEqual([['A', 2]]);
    expect(countOf([{ field: 'size', op: 'ne', value: '' }])).toEqual([['A', 2]]);
  });

  it('contains / notContains', () => {
    expect(countOf([{ field: 'size', op: 'contains', value: 'M' }])).toEqual([['A', 1]]);
    expect(countOf([{ field: 'size', op: 'notContains', value: 'M' }])).toEqual([
      ['A', 1],
      ['B', 1],
    ]);
  });

  it('gt / lt 对可解析数字生效，非数字一律不通过', () => {
    expect(countOf([{ field: 'raw:金额', op: 'gt', value: '60' }])).toEqual([['A', 1]]);
    expect(countOf([{ field: 'raw:金额', op: 'lt', value: '60' }])).toEqual([['A', 1]]);
    expect(countOf([{ field: 'shop', op: 'gt', value: '0' }])).toEqual([]);
  });

  it('empty / notEmpty', () => {
    expect(countOf([{ field: 'size', op: 'empty', value: '' }])).toEqual([['B', 1]]);
    expect(countOf([{ field: 'size', op: 'notEmpty', value: '' }])).toEqual([['A', 2]]);
  });

  it('多个筛选为 AND 语义', () => {
    expect(
      countOf([
        { field: 'shop', op: 'eq', value: 'A' },
        { field: 'raw:金额', op: 'gt', value: '60' },
      ]),
    ).toEqual([['A', 1]]);
  });

  it('筛选是"行级过滤"：先筛行再聚合，count 反映筛选后的行数', () => {
    const out = pivotRows(rows, {
      dimensions: [],
      measures: [{ id: 'c', field: '', op: 'count' }],
      filters: [{ field: 'shop', op: 'eq', value: 'A' }],
    });
    expect(out[0].count).toBe(2);
  });
});
