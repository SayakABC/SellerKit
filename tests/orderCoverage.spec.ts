// 「哪张订单的货齐了」的契约用例（2026-10-22）。
//
// 这一层回答的是**用户真会问的那句话**（"拿完货怎么知道哪些订单拿齐了"），
// 而它只有两个信息源：
//   · 精确：`covered[订单行 id]` —— 生成拿货单时 `autoSourceRows` 已经把"这 N 件补给哪一行"算出来
//     并落进 `purchase_sources.order_item_id`，是对账意义上的**事实**；
//   · 回退：加列之前的历史拿货单没有归属，只能按款色码当池子摊 —— 摊到的部分**必须标 estimated**。
//
// 钉的是**关系**，不是某个实现：
//   · 一件台账只能被一行吃掉一次（精确与池子互斥相加，重复就是"已拿虚高 ⇒ 漏货"）；
//   · 池子按**订单行 id 升序**摊（= 导入顺序），不按传进来的顺序 —— 否则同一批数据换个调用顺序就换个答案；
//   · 未识别款**不摊池子**（空键会把"同色同码的不同商品"并成一格，凭空宣布已拿）；
//   · `已拿 + 还差 === 件数` 恒成立（与总览那四个数同一个恒等式）。
import { describe, expect, it } from 'vitest';
import {
  coverageImportSplit,
  coverageInputs,
  coverageSummary,
  groupByOrder,
  missingLabel,
  planCoverage,
  scopeCoverageByDays,
  type CoverageInputRow,
  type OrderCoverageOrder,
} from '../src/lib/orderCoverage';
import { takenKey } from '../src/lib/picking';

function row(over: Partial<CoverageInputRow> = {}): CoverageInputRow {
  return {
    id: 1,
    orderNo: 'O1',
    shop: '店A',
    orderTime: '2026-10-22 09:00:00',
    qty: 1,
    rawFields: {},
    styleCode: 'S1',
    styleColor: '黑',
    color: '黑',
    size: 'L',
    styleColorId: 11,
    bizStatus: '等待发货',
    ...over,
  };
}

/** 无归属台账（键 = `takenKeyOf` 的文本分支 —— 历史明细没有款色 id） */
function pool(entries: [string, string, string, number][]): Record<string, number> {
  const out: Record<string, number> = {};
  for (const [code, color, size, qty] of entries) {
    const k = takenKey(code, color, size);
    out[k] = (out[k] ?? 0) + qty;
  }
  return out;
}

describe('planCoverage：逐行「拿了没有」', () => {
  it('空输入 → 空计划（不抛、不是 NaN）', () => {
    const p = planCoverage([]);
    expect(p.rows).toEqual([]);
    expect(planCoverage(null)).toMatchObject({ excludedFinished: 0, assumedQty: 0 });
  });

  it('精确覆盖按订单行 id 命中：拿满的行 covered = 需求，没拿的 = 0', () => {
    const p = planCoverage([row({ id: 7, qty: 2 }), row({ id: 8, qty: 3 })], {
      covered: { '7': 2 },
    });
    expect(p.rows.map((r) => r.covered)).toEqual([2, 0]);
    expect(p.rows[0].estimated).toBe(false);
  });

  it('精确覆盖**夹到需求以内**：多算了也不会出现"已拿 > 件数 / 还差为负"', () => {
    const p = planCoverage([row({ id: 7, qty: 2 })], { covered: { '7': 5 } });
    expect(p.rows[0].covered).toBe(2);
    const g = groupByOrder(p.rows)[0];
    expect(g.remaining).toBe(0);
    expect(g.done).toBe(true);
  });

  it('无归属台账只摊给还没拿满的行，且**按订单行 id 升序**（换传参顺序答案不变）', () => {
    // 故意把 id=5 放前面：实现若按数组顺序摊，就会摊给后下的那一单
    const rows = [row({ id: 5, orderNo: 'O5' }), row({ id: 2, orderNo: 'O2' })];
    const p = planCoverage(rows, { pool: pool([['S1', '黑', 'L', 1]]) });
    const byId = new Map(p.rows.map((r) => [r.orderItemId, r]));
    expect(byId.get(2)?.covered).toBe(1);
    expect(byId.get(5)?.covered).toBe(0);
    expect(byId.get(2)?.estimated).toBe(true);
  });

  it('一件台账只被吃掉一次（两行都要 1 件、台账也只有 1 件 ⇒ 合计已拿 1，不是 2）', () => {
    const p = planCoverage([row({ id: 1 }), row({ id: 2, orderNo: 'O2' })], {
      pool: pool([['S1', '黑', 'L', 1]]),
    });
    expect(p.rows.reduce((s, r) => s + r.covered, 0)).toBe(1);
  });

  it('台账多于需求时其余留在池子里（不跨款色串味）', () => {
    const p = planCoverage([row({ id: 1 })], { pool: pool([['S1', '黑', 'L', 9]]) });
    expect(p.rows[0].covered).toBe(1);
  });

  it('**精确 + 池子不重复**：已按行归属的那件，不再从台账里扣一次', () => {
    // 一行要 1 件、已有精确归属 1 件，同时池子里还有 1 件同款色
    const p = planCoverage([row({ id: 1, qty: 1 })], {
      covered: { '1': 1 },
      pool: pool([['S1', '黑', 'L', 1]]),
    });
    expect(p.rows[0].covered).toBe(1); // 不是 2
    expect(p.rows[0].estimated).toBe(false); // 没用到池子
  });

  it('未识别款不摊池子：空款编码键会把"同色同码的不同商品"并成一格', () => {
    const p = planCoverage(
      [row({ id: 1, styleCode: '', styleColorId: 0, color: '白', size: 'M', qty: 2 })],
      {
        pool: pool([['', '白', 'M', 2]]),
      }
    );
    expect(p.rows[0].covered).toBe(0);
    expect(p.rows[0].unclassified).toBe(true);
  });

  it('已终结（关闭/完成）的行剔掉并计数 —— 单没了，不该出现在"可以发货"里', () => {
    const p = planCoverage([
      row({ id: 1, bizStatus: '等待发货' }),
      row({ id: 2, orderNo: 'O2', bizStatus: '订单关闭' }),
      row({ id: 3, orderNo: 'O3', bizStatus: '交易成功' }),
    ]);
    expect(p.rows.map((r) => r.orderItemId)).toEqual([1]);
    expect(p.excludedFinished).toBe(2);
  });

  it('件数按 1 件兜底的行**报出来**（assumedQty），不静默', () => {
    const p = planCoverage([row({ id: 1, qty: null, rawFields: {} })]);
    expect(p.rows[0].qty).toBe(1);
    expect(p.assumedQty).toBe(1);
  });
});

describe('groupByOrder：每张单齐了没有', () => {
  const p = planCoverage(
    [
      row({ id: 1, orderNo: 'O1', qty: 2, size: 'L' }),
      row({ id: 2, orderNo: 'O1', qty: 1, size: 'XL' }),
      row({ id: 3, orderNo: 'O2', qty: 1, size: 'M', orderTime: '2026-10-22 10:00:00' }),
    ],
    { covered: { '1': 2, '2': 1 } }
  );

  it('按订单号聚合：O1 齐了、O2 还差 1 件', () => {
    const g = groupByOrder(p.rows);
    expect(g.map((o) => o.orderNo)).toEqual(['O1', 'O2']);
    expect(g[0]).toMatchObject({ pieces: 3, covered: 3, remaining: 0, done: true });
    expect(g[1]).toMatchObject({ pieces: 1, covered: 0, remaining: 1, done: false });
  });

  it('汇总：齐了 N 单 / 还差 N 单，件数与行级判定同源（不另算一遍）', () => {
    const s = coverageSummary(groupByOrder(p.rows));
    expect(s).toMatchObject({
      orders: 2,
      done: 1,
      partial: 1,
      pieces: 4,
      covered: 3,
      remaining: 1,
    });
    expect(s.covered + s.remaining).toBe(s.pieces);
  });

  it('还差的行排在齐了的行前面（用户先看见要动手的）', () => {
    const plan = planCoverage(
      [row({ id: 1, orderNo: 'O1', size: 'L' }), row({ id: 2, orderNo: 'O1', size: 'XL' })],
      { covered: { '2': 1 } }
    );
    const one = groupByOrder(plan.rows)[0];
    expect(one.rows.map((r) => r.size)).toEqual(['L', 'XL']);
  });

  it('空输入 → 空数组（不抛）', () => {
    expect(groupByOrder(null)).toEqual([]);
    expect(coverageSummary(undefined)).toMatchObject({ orders: 0, done: 0, partial: 0 });
  });
});

describe('coverageInputs：宿主返回 → 纯函数入参（列名与键只在这里翻译一次）', () => {
  it('rows 按订单行 id 累加；unattributed 按 `takenKeyOf` 拼（与清单同一个函数）', () => {
    const ins = coverageInputs({
      rows: [
        { orderItemId: 7, covered: 1 },
        { orderItemId: 7, covered: 2 },
        { orderItemId: 0, covered: 9 }, // 没有身份的行丢掉，不能落到 "0" 上
      ],
      unattributed: [
        { styleColorId: 11, styleCode: 'S1', color: '黑', size: 'L', taken: 2 },
        { styleColorId: 0, styleCode: 'S2', color: '白', size: 'M', taken: 1 },
      ],
    });
    expect(ins.covered).toEqual({ '7': 3 });
    expect(ins.pool).toEqual({
      '#11|L': 2,
      [takenKey('S2', '白', 'M')]: 1,
    });
    // 宿主列 `orderItemId` → 本层 `id`；两条重复 id 各留一行（行数不能丢，件数靠它累加）
    expect(ins.rows.map((r) => r.id)).toEqual([7, 7]);
  });

  it('`colorRaw`（订单原文色）落到 `color`；`styleColor` 单独保留（有效色的回落顺序只在本层）', () => {
    const ins = coverageInputs({
      rows: [{ orderItemId: 1, styleColor: '黑', colorRaw: '5', size: 'L' }],
    });
    expect(ins.rows[0]).toMatchObject({ color: '5', styleColor: '黑' });
  });

  it('null / undefined → 空表（缺省与空对象同行为）', () => {
    expect(coverageInputs(null)).toEqual({ rows: [], covered: {}, pool: {} });
    expect(coverageInputs(undefined)).toEqual({ rows: [], covered: {}, pool: {} });
  });

  it('返回的三样能直接喂给 `planCoverage`（`planCoverage(ins.rows, ins)` 的约定）', () => {
    const ins = coverageInputs({
      rows: [
        {
          orderItemId: 1,
          orderNo: 'O1',
          qty: 2,
          styleCode: 'S1',
          styleColor: '黑',
          size: 'L',
          styleColorId: 11,
          covered: 2,
        },
        {
          orderItemId: 2,
          orderNo: 'O1',
          qty: 1,
          styleCode: 'S1',
          styleColor: '黑',
          size: 'XL',
          styleColorId: 11,
        },
      ],
    });
    const plan = planCoverage(ins.rows, ins);
    const g = groupByOrder(plan.rows)[0];
    expect(g).toMatchObject({ pieces: 3, covered: 2, remaining: 1, done: false });
  });
});

describe('missingLabel：一句话说清还差什么', () => {
  it('款 · 色 · 码 × 件数', () => {
    const p = planCoverage([row({ id: 1, qty: 3, size: 'L' })], { covered: { '1': 1 } });
    expect(missingLabel(p.rows[0])).toBe('S1 · 黑 · L × 2');
  });

  it('缺款编码 / 缺颜色时不拼出空段（"未识别款 ·  ·  × 1"读不懂）', () => {
    const p = planCoverage([row({ id: 1, styleCode: '', styleColor: '', color: '' })]);
    expect(missingLabel(p.rows[0])).toBe('未识别款 · 未分类 · L × 1');
  });
});

// 2026-11-02：用户拿「今天同步 4 单」对上「拿货页 73 单未发」，以为同步出了 73 单。
// 两个数都真：总览按导入日筛，按单核对是**全部未发货**（跨天结转 + 历史导入）。
// 下面钉住"范围怎么算"与"历史从哪来"，界面文案只是它们的投影。
describe('scopeCoverageByDays：按单核对的时间窗（下单日）', () => {
  function ordersOf(list: Partial<CoverageInputRow>[]): OrderCoverageOrder[] {
    return groupByOrder(planCoverage(list.map((o, i) => row({ id: i + 1, ...o }))).rows);
  }

  it('days<=0 → 全部可见、没有隐藏（"不限"不是"只看今天"）', () => {
    const g = ordersOf([
      { orderNo: 'O-OLD', orderTime: '2026-08-23 10:00:00', qty: 2 },
      { orderNo: 'O-NEW', orderTime: '2026-11-01 10:00:00', qty: 1 },
    ]);
    const w = scopeCoverageByDays(g, { days: 0, today: '2026-11-02' });
    expect(w.visible).toHaveLength(2);
    expect(w.hidden).toEqual([]);
    expect(w.cutoff).toBe('');
    expect(w.hiddenPieces).toBe(0);
  });

  it('近 30 天：更早的单进 hidden 并报件数；没有下单日的单**照收**（不能当"太老"）', () => {
    const g = ordersOf([
      { orderNo: 'OLD', orderTime: '2026-10-02 10:00:00', qty: 3 },
      { orderNo: 'EDGE', orderTime: '2026-10-03 10:00:00', qty: 1 }, // 下界当天算在窗口内
      { orderNo: 'NEW', orderTime: '2026-11-01 10:00:00', qty: 2 },
      { orderNo: 'NODATE', orderTime: '', qty: 1 },
    ]);
    const w = scopeCoverageByDays(g, { days: 30, today: '2026-11-02' });
    expect(w.cutoff).toBe('2026-10-03');
    expect(w.visible.map((o) => o.orderNo)).toEqual(['NODATE', 'EDGE', 'NEW']);
    expect(w.hidden.map((o) => o.orderNo)).toEqual(['OLD']);
    expect(w.hiddenPieces).toBe(3);
  });

  it('认多种下单日期写法（2026/10/02 也要挡在外面，不能在比较里静默放行）', () => {
    const g = ordersOf([{ orderNo: 'SLASH', orderTime: '2026/10/02 10:00', qty: 1 }]);
    const w = scopeCoverageByDays(g, { days: 30, today: '2026-11-02' });
    expect(w.hidden.map((o) => o.orderNo)).toEqual(['SLASH']);
  });
});

describe('coverageImportSplit：这 73 单从哪来（入库日，不是下单日）', () => {
  function ordersOf(list: Partial<CoverageInputRow>[]): OrderCoverageOrder[] {
    return groupByOrder(planCoverage(list.map((o, i) => row({ id: i + 1, ...o }))).rows);
  }

  it('今天导入 / 历史导入 / 导入日未知 三档分开，未知不并进历史', () => {
    const g = ordersOf([
      { orderNo: 'TODAY', importedAt: '2026-11-02 00:21:00' },
      { orderNo: 'HIST', importedAt: '2026-10-28 18:00:00' },
      { orderNo: 'UNKNOWN', importedAt: '' },
    ]);
    expect(coverageImportSplit(g, '2026-11-02')).toEqual({ today: 1, history: 1, undated: 1 });
  });

  it('ISO 入库时间按本地日归一（东八区 11-02 → today；不能取 UTC 日期）', () => {
    const g = ordersOf([{ orderNo: 'ISO', importedAt: '2026-11-02T00:21:00+08:00' }]);
    expect(coverageImportSplit(g, '2026-11-02')).toEqual({ today: 1, history: 0, undated: 0 });
  });
});
