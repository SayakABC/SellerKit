// 「口径门禁」只读汇总的单测（P0，2026-11-06）
//
// 为什么单独一个文件：`trustSummary` 是纯新增的纯函数，不碰 `computeOrderCosts` 的任何既有行为，
// 与 `tests/orderCost.spec.ts` 的 97 例零耦合。夹具只造本函数真正读的那几列，
// 其余用 `as unknown as OrderCostRow` 抹掉 —— 加一列就得改全部夹具，那才是脆的。
import { describe, expect, it } from 'vitest';
import { trustSummary, type OrderCostRow } from '../src/lib/orderCost';

type RowPart = Partial<
  Pick<
    OrderCostRow,
    'bucket' | 'tier' | 'gaps' | 'shippingSource'
  >
>;

function row(part: RowPart = {}): OrderCostRow {
  return {
    bucket: 'intransit',
    tier: 'forecast',
    gaps: [],
    shippingSource: 'rate',
    ...part,
  } as unknown as OrderCostRow;
}

describe('trustSummary · 统计页口径门禁', () => {
  it('关闭单不进任何计数（与金额合计同口径）', () => {
    const r = trustSummary([
      row(),
      row(),
      row({ bucket: 'closed', tier: 'precise', gaps: ['cost'], shippingSource: 'parcel' }),
    ]);
    expect(r.liveRows).toBe(2);
    expect(r.preciseRows).toBe(0);
    expect(r.gapRows).toBe(0);
    expect(r.estimatedFreightRows).toBe(2);
  });

  it('精准/预测两轨互斥，相加恒等于参与合计的行数', () => {
    const r = trustSummary([
      row({ tier: 'precise' }),
      row({ tier: 'precise' }),
      row(),
    ]);
    expect(r.preciseRows).toBe(2);
    expect(r.forecastRows).toBe(1);
    expect(r.preciseRows + r.forecastRows).toBe(r.liveRows);
  });

  it('覆盖率按精准 / 参与合计行数算，且随样本变化（不是常数）', () => {
    const low = trustSummary([row({ tier: 'precise' }), row(), row()]);
    const high = trustSummary([row({ tier: 'precise' }), row({ tier: 'precise' }), row()]);
    expect(low.coveragePercent).toBe(33);
    expect(high.coveragePercent).toBe(67);
    expect(low.coveragePercent).not.toBe(high.coveragePercent);
  });

  it('没有有效行时覆盖率是 null，不是 0（缺就写 — ）', () => {
    expect(trustSummary([]).coveragePercent).toBeNull();
    expect(trustSummary(null).coveragePercent).toBeNull();
    expect(trustSummary([row({ bucket: 'closed' })]).coveragePercent).toBeNull();
  });

  it('缺口行与估算运费行各自只认自己的事实', () => {
    const r = trustSummary([
      row({ gaps: ['cost', 'weight'], shippingSource: 'rate' }),
      row({ gaps: [], shippingSource: 'parcel' }),
      row({ gaps: ['qty'], shippingSource: 'none' }),
    ]);
    expect(r.gapRows).toBe(2);
    expect(r.estimatedFreightRows).toBe(1);
  });

  it('结构反向守卫：不返回任何金额字段（金额只能来自 OrderCostSummary 一处实现）', () => {
    const keys = Object.keys(trustSummary([row()])).sort();
    expect(keys).toEqual([
      'coveragePercent',
      'estimatedFreightRows',
      'forecastRows',
      'gapRows',
      'liveRows',
      'preciseRows',
    ]);
  });
});
