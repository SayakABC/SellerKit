// 「亚洲款加码」纯计算层的契约用例。
//
// 钉住的是**拿货侧口径**，不是实现：
//   · 只有 `size` 被改写、`orderSize` 记下单码 —— 订单原文/利润/发货不参与；
//   · 字母码按码序、数字码按行业步长（38→40）、有码链时**按位置**（链能覆盖 170/92A 这类码）；
//   · 最大码再加码 = 封顶并**报数**；认不出的码**不动**并报数（静默当成加好了会让用户按错码拿货）；
//   · 同一批行算两次不会再多加一码（带 `orderSize` 的行直接跳过）—— 派生必须幂等。
import { describe, expect, it } from 'vitest';
import {
  applySizeShift,
  compareSize,
  normalizeSize,
  shiftSize,
  sizeChain,
  type SizeShiftRowLike,
} from '../src/lib/sizeShift';
import { aggregatePicking, groupByColor, pendingOf, type PickingRow } from '../src/lib/picking';

const row = (over: Partial<SizeShiftRowLike> = {}): SizeShiftRowLike => ({
  styleCode: 'S1',
  size: 'L',
  ...over,
});

describe('shiftSize · 单码换算', () => {
  it('shift=0 原样返回（连大小写与空格都不改）', () => {
    expect(shiftSize('l', 0)).toMatchObject({ size: 'l', changed: false, known: true });
    expect(shiftSize(' M ', 0)).toMatchObject({ size: ' M ', changed: false });
    expect(shiftSize('', 2)).toMatchObject({ size: '', changed: false });
  });

  it('字母码按码序加码', () => {
    expect(shiftSize('L', 1).size).toBe('XL');
    expect(shiftSize('L', 2).size).toBe('XXL');
    expect(shiftSize('M', 3).size).toBe('XXL');
    expect(shiftSize('s', 1)).toMatchObject({ size: 'M', changed: true, known: true });
  });

  it('2XL/3XL 是 XXL/XXXL 的同义写法：加码后**保持原写法**（台账键按文本）', () => {
    // 关键断言：`2XL` 加一码必须是 `3XL`，不能变成 `XXXL` —— 同一个码换写法，台账就对不上
    expect(shiftSize('2XL', 1).size).toBe('3XL');
    expect(shiftSize('3XL', -1).size).toBe('2XL');
    expect(shiftSize('XXL', 1).size).toBe('XXXL');
  });

  it('最大码再加码 = 封顶，并标 clamped；最小码减码同理', () => {
    expect(shiftSize('6XL', 2)).toMatchObject({ size: '6XL', changed: false, clamped: true });
    expect(shiftSize('XXS', -3)).toMatchObject({ size: 'XXS', clamped: true });
    // 封顶但不是"认不出"：它就是最大码，不该混进"码认不出"的告警里
    expect(shiftSize('6XL', 2).known).toBe(true);
  });

  it('数字码按行业步长 +2（38 的下一个码是 40，不是 39）', () => {
    expect(shiftSize('38', 1).size).toBe('40');
    expect(shiftSize('38', 2).size).toBe('42');
    expect(shiftSize('38', -1).size).toBe('36');
  });

  it('有码链时**按位置**移位（链能覆盖字典推不出的码）', () => {
    expect(shiftSize('38', 1, ['36', '38', '40', '42']).size).toBe('40');
    // 链里的数字码不连续也照链走（36→39）
    expect(shiftSize('36', 1, ['36', '39', '42']).size).toBe('39');
    // 170/92A 这类码只可能靠链
    expect(shiftSize('170/92A', 1, ['165/88A', '170/92A', '175/96A']).size).toBe('175/96A');
  });

  it('链里没有这个码 → 回落字典规则；字典也认不出 → 不动并标 unknown', () => {
    expect(shiftSize('L', 1, ['36', '38'])).toMatchObject({ size: 'XL', known: true });
    expect(shiftSize('F', 2, ['36', '38'])).toMatchObject({ size: 'F', known: false, changed: false });
    expect(shiftSize('均码', 1)).toMatchObject({ size: '均码', known: false, changed: false });
  });

  it('尺码链 / 比较：字母码按码序、数字码按数值、其余按原串', () => {
    expect(sizeChain(['XL', 'M', '38', 'S', '40'])).toEqual(['S', 'M', 'XL', '38', '40']);
    expect(compareSize('2XL', 'XXL')).toBe(0); // 同义写法同序（2XL ≡ XXL，不是 XXXL）
    expect(compareSize('3XL', 'XXXL')).toBe(0);
    expect(normalizeSize(' 2xl ')).toBe('2XL');
  });
});

describe('applySizeShift · 行级换算', () => {
  const shiftMap = (m: Record<string, number>) => (code: string) => m[code] ?? 0;

  it('只改 size、记下单码，且**不改入参**', () => {
    const src = [row({ styleCode: 'A', size: 'L' })];
    const { rows, stats } = applySizeShift(src, shiftMap({ A: 1 }));
    expect(rows[0]).toMatchObject({ size: 'XL', orderSize: 'L' });
    expect(src[0]).toMatchObject({ size: 'L' }); // 入参没被改
    expect(rows[0]).not.toBe(src[0]);
    expect(stats).toMatchObject({ shiftedRows: 1, shiftedStyles: 1, clampedRows: 0, unknownRows: 0 });
  });

  it('偏移为 0 的款**原样返回同一个对象**（存量形状零变化）', () => {
    const src = [row({ styleCode: 'B', size: 'L' })];
    const { rows, stats } = applySizeShift(src, shiftMap({ B: 0 }));
    expect(rows[0]).toBe(src[0]);
    expect(rows[0]).not.toHaveProperty('orderSize');
    expect(stats.shiftedRows).toBe(0);
  });

  it('封顶 / 认不出分别计数（两种异常不能混成一个数）', () => {
    const src = [
      row({ styleCode: 'A', size: '6XL' }),
      row({ styleCode: 'A', size: 'F' }),
      row({ styleCode: 'A', size: 'L' }),
    ];
    const { rows, stats } = applySizeShift(src, shiftMap({ A: 2 }));
    expect(stats.clampedRows).toBe(1);
    expect(stats.unknownRows).toBe(1);
    expect(stats.shiftedRows).toBe(1);
    expect(rows.map((r) => r.size)).toEqual(['6XL', 'F', 'XXL']);
    // 认不出的那行不记 orderSize（它没被换算）
    expect(rows[1]).not.toHaveProperty('orderSize');
  });

  it('逐款明细：一款一条，行数/改动/封顶/认不出都落到**款**上（只报总数等于没报）', () => {
    const src = [
      row({ styleCode: 'A', size: 'L' }),
      row({ styleCode: 'A', size: '6XL' }),
      row({ styleCode: 'B', size: 'M' }),
      row({ styleCode: 'C', size: 'L' }), // 未设偏移 ⇒ 不进列表
    ];
    const { stats } = applySizeShift(src, shiftMap({ A: 1, B: 1 }));
    expect(stats.styles.map((s) => s.styleCode)).toEqual(['A', 'B']); // 首现顺序，C 不在
    expect(stats.styles[0]).toMatchObject({
      styleCode: 'A',
      shift: 1,
      rows: 2,
      changedRows: 1,
      clampedRows: 1,
      unknownRows: 0,
    });
    expect(stats.styles[1]).toMatchObject({ styleCode: 'B', rows: 1, changedRows: 1 });
    // 逐款行数之和 = 参与换算的行数（3），不含未设偏移的 C
    expect(stats.styles.reduce((n, s) => n + s.rows, 0)).toBe(3);
  });

  it('整款都被封顶 / 整款认不出：仍然算"这 1 款加了码"（否则界面报 0 款，用户以为没保存）', () => {
    const { stats } = applySizeShift(
      [row({ styleCode: 'A', size: '6XL' }), row({ styleCode: 'A', size: 'F' })],
      shiftMap({ A: 2 })
    );
    expect(stats.shiftedRows).toBe(0);
    expect(stats.shiftedStyles).toBe(1);
    expect(stats.styles[0]).toMatchObject({ styleCode: 'A', shift: 2, rows: 2, changedRows: 0, clampedRows: 1, unknownRows: 1 });
  });

  it('幂等：同一批行算两次，尺码不会再多加一码', () => {

    const once = applySizeShift([row({ styleCode: 'A', size: 'L' })], shiftMap({ A: 1 })).rows;
    const twice = applySizeShift(once, shiftMap({ A: 1 })).rows;
    expect(twice[0].size).toBe('XL');
    expect(twice[0]).toHaveProperty('orderSize', 'L');
  });

  it('同一款换成另一种偏移 → 结果必须不同（桩要能区分，否则断言恒绿）', () => {
    const src = [row({ styleCode: 'A', size: 'L' })];
    expect(applySizeShift(src, shiftMap({ A: 1 })).rows[0].size).toBe('XL');
    expect(applySizeShift(src, shiftMap({ A: 2 })).rows[0].size).toBe('XXL');
  });

  it('链优先：同一款给了码链就按链走', () => {
    const { rows } = applySizeShift([row({ styleCode: 'A', size: '38' })], shiftMap({ A: 1 }), () => [
      '36',
      '38',
      '40',
    ]);
    expect(rows[0].size).toBe('40');
  });
});

// ───────────────────── 与拣货清单的联动（换算在聚合之前 → 下游全是拿货码） ─────────────────────

const infoBlock = (qty: number) => `【1】 某款 (产品属性:Color:黑、Size:L)\n(商品数量:${qty} piece)`;

function pickRow(over: Partial<PickingRow> = {}): PickingRow {
  return {
    id: 1,
    orderNo: 'O1',
    shop: '店A',
    orderTime: '',
    styleCode: 'S1',
    styleName: '某款',
    styleColor: '黑',
    styleColorId: 11,
    color: '黑',
    size: 'L',
    itemId: 'ITEM1',
    supplierId: 7,
    supplierName: '厂A',
    imagePath: '',
    shipped: false,
    bizStatus: '等待发货',
    actualCostCents: null,
    costCents: null,
    productCostCents: null,
    rawFields: { 商品信息: infoBlock(1) },
    ...over,
  };
}

describe('加码后进拣货清单', () => {
  const shifted = (rows: PickingRow[], shift: number) =>
    applySizeShift(rows, () => shift).rows;

  it('尺码格是拿货码，下单码留在 orderSizes 里（`L→XL` 的数据来源）', () => {
    const s = aggregatePicking(shifted([pickRow({ id: 1 }), pickRow({ id: 2 })], 1), {
      today: '2026-11-02',
    });
    expect(s.groups).toHaveLength(1);
    const g = s.groups[0];
    expect(g.size).toBe('XL');
    expect(g.orderSizes).toEqual(['L']);
    expect(g.pieces).toBe(2);

    const [line] = groupByColor(s.groups);
    expect(line.sizes[0]).toMatchObject({ size: 'XL', orderSizes: ['L'], pieces: 2 });
  });

  it('封顶：多个下单码并到最大码 —— 件数相加、下单码全留着（不能只留一个）', () => {
    const s = aggregatePicking(
      shifted(
        [
          pickRow({ id: 1, size: '5XL', rawFields: { 商品信息: infoBlock(2) } }),
          pickRow({ id: 2, size: '6XL', rawFields: { 商品信息: infoBlock(3) } }),
        ],
        1
      ),
      { today: '2026-11-02' }
    );
    expect(s.groups).toHaveLength(1);
    expect(s.groups[0]).toMatchObject({ size: '6XL', pieces: 5, orderSizes: ['5XL', '6XL'] });
  });

  it('未加码的款：尺码原样、`orderSizes` 为空（存量形状零变化）', () => {
    const s = aggregatePicking(shifted([pickRow()], 0), { today: '2026-11-02' });
    expect(s.groups[0]).toMatchObject({ size: 'L', pieces: 1, orderSizes: [] });
  });

  it('已拿按**拿货码**抵扣：台账键与清单的 size 同码才算得上', () => {
    const rows = shifted([pickRow({ id: 1 }), pickRow({ id: 2 })], 1);
    // 台账记的是 XL（拿货码）；若拿 L 去对，这两个断言会同时变成"未拿"
    const taken = { '#11|XL': 1, '#11|L': 99 };
    const s = aggregatePicking(rows, { today: '2026-11-02', taken });
    expect(s.groups[0]).toMatchObject({ size: 'XL', pieces: 2, taken: 1, remaining: 1 });
    expect(pendingOf(s.groups)[0].remaining).toBe(1);
  });
});
