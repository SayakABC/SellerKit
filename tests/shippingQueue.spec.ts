import { describe, expect, it } from 'vitest';
import {
  PATTERN_STATE_LABEL,
  patternStateOf,
  remainText,
  shippingPulse,
  shippingQueue,
  type PulseRow,
} from '../src/lib/shippingPulse';

/** 造一行（默认：一单一件、待发货、有图、11-11 到截止） */
function row(p: Partial<PulseRow> = {}): PulseRow {
  return {
    orderNo: 'O1',
    bizStatus: '等待卖家发货',
    dealDeadline: '2026-11-11 23:59:59',
    imageId: 7,
    qty: 1,
    ...p,
  };
}

/** 固定「现在」：2026-11-01 20:00 本地时间 —— 断言不能依赖运行时刻 */
const NOW = new Date(2026, 10, 1, 20, 0, 0, 0).getTime();

describe('shippingQueue · 最急的在最上', () => {
  it('按截止期升序：远的在后，近的在前', () => {
    const q = shippingQueue(
      [
        row({ orderNo: 'far', dealDeadline: '2026-11-20 10:00:00' }),
        row({ orderNo: 'near', dealDeadline: '2026-11-02 10:00:00' }),
        row({ orderNo: 'mid', dealDeadline: '2026-11-05 10:00:00' }),
      ],
      { now: NOW },
    );
    expect(q.lines.map((l) => l.orderNo)).toEqual(['near', 'mid', 'far']);
  });

  it('**已过期**的排在最前（越紧急越要提醒，不能因为在过去就沉底）', () => {
    const q = shippingQueue(
      [
        row({ orderNo: 'ok', dealDeadline: '2026-11-02 10:00:00' }),
        row({ orderNo: 'late', dealDeadline: '2026-10-31 10:00:00' }),
      ],
      { now: NOW },
    );
    expect(q.lines[0]!.orderNo).toBe('late');
    expect(q.lines[0]!.overdue).toBe(true);
    expect(q.lines[0]!.risk).toBe(true);
  });

  it('没有截止期的**垫底**，不是排最前、也不是当 0 排最前（不知道 ≠ 不着急）', () => {
    const q = shippingQueue(
      [
        row({ orderNo: 'none', dealDeadline: '' }),
        row({ orderNo: 'far', dealDeadline: '2026-11-20 10:00:00' }),
        row({ orderNo: 'late', dealDeadline: '2026-10-31 10:00:00' }),
      ],
      { now: NOW },
    );
    expect(q.lines.map((l) => l.orderNo)).toEqual(['late', 'far', 'none']);
    expect(q.lines[2]!.deadlineMs).toBe(0);
    expect(Number.isNaN(q.lines[2]!.remainMs)).toBe(true);
    expect(q.noDeadline).toBe(1);
  });

  it('同一截止期按**进入顺序**（一单多行必须挨在一起，不能被打散）', () => {
    const q = shippingQueue(
      [
        row({ orderNo: 'B', qty: 1 }),
        row({ orderNo: 'A', qty: 1 }),
        row({ orderNo: 'B', qty: 1 }),
      ],
      { now: NOW },
    );
    expect(q.lines.map((l) => l.orderNo)).toEqual(['B', 'A', 'B']);
  });

  it('只收待发货：已发货 / 交易完成 / 订单关闭 一条都不进', () => {
    const q = shippingQueue(
      [
        row({ orderNo: 'a', bizStatus: '已发货' }),
        row({ orderNo: 'b', bizStatus: '交易完成' }),
        row({ orderNo: 'c', bizStatus: '订单关闭' }),
        row({ orderNo: 'd', bizStatus: '等待卖家发货' }),
      ],
      { now: NOW },
    );
    expect(q.lines.map((l) => l.orderNo)).toEqual(['d']);
    expect(q.orders).toBe(1);
  });

  it('单级 vs 行级：一单三行 ⇒ orders=1、lines=3、件数按行累加', () => {
    const q = shippingQueue(
      [
        row({ orderNo: 'A', qty: 2 }),
        row({ orderNo: 'A', qty: 2 }),
        row({ orderNo: 'A', qty: null }),
      ],
      { now: NOW },
    );
    expect(q.orders).toBe(1);
    expect(q.lines).toHaveLength(3);
    expect(q.pieces).toBe(5); // 2 + 2 + 缺数量按 1
    expect(q.lines[2]!.assumedQty).toBe(true);
  });

  it('空单号不算一单（与 shippingPulse.pending 同口径），但件数照算', () => {
    const q = shippingQueue([row({ orderNo: '', qty: 3 })], { now: NOW });
    expect(q.orders).toBe(0);
    expect(q.pieces).toBe(3);
    expect(q.lines).toHaveLength(1);
  });

  it('截止期原文带出来（界面 title 能自证读的是哪一列）', () => {
    const q = shippingQueue([row({ dealDeadline: '2026/11/11 23:59:59' })], { now: NOW });
    expect(q.lines[0]!.deadlineRaw).toBe('2026/11/11 23:59:59');
    expect(q.lines[0]!.deadlineMs).toBe(new Date(2026, 10, 11, 23, 59, 59).getTime());
  });
});

describe('shippingQueue 与 shippingPulse · 必须同源（两处数字不许打架）', () => {
  it('orders/pieces/risk/noDeadline 与四数逐项相等', () => {
    const rows: PulseRow[] = [
      row({ orderNo: 'A', dealDeadline: '2026-11-02 10:00:00', qty: 2 }), // 风险（<24h）
      row({ orderNo: 'A', dealDeadline: '2026-11-02 10:00:00', qty: 2 }),
      row({ orderNo: 'B', dealDeadline: '2026-11-20 10:00:00', qty: null }),
      row({ orderNo: 'C', dealDeadline: '', qty: 1, imageId: 0 }), // 算不出风险
      row({ orderNo: 'D', bizStatus: '已发货', dealDeadline: '2026-11-01 00:00:00' }),
    ];
    const q = shippingQueue(rows, { now: NOW });
    const p = shippingPulse(rows, { now: NOW });
    expect(q.orders).toBe(p.pending);
    expect(q.pieces).toBe(p.pieces);
    expect(q.risk).toBe(p.risk);
    expect(q.noDeadline).toBe(p.noDeadline);
    expect(p.pending).toBe(3);
    expect(p.pieces).toBe(6);
    expect(p.risk).toBe(1); // 只有 A 单在 24h 内（同单单行多行只算一次）
    expect(p.noDeadline).toBe(1);
    expect(p.assumedQty).toBe(1);
    expect(p.missingImage).toBe(1);
  });
});

describe('patternStateOf · 图案状态三档', () => {
  it('没有行图 ⇒ 缺图（定制品没买家图就印不了，这是唯一真正卡住的一档）', () => {
    expect(patternStateOf({ imageId: 0, styleColorId: 0 })).toBe('noImage');
    expect(patternStateOf({ imageId: 0, styleColorId: 11 })).toBe('noImage'); // 归类了也没图
    expect(patternStateOf(null)).toBe('noImage');
  });

  it('有图但还没归到款色 ⇒ 待绑（知道印什么，不知道印在哪个款色上）', () => {
    expect(patternStateOf({ imageId: 7, styleColorId: 0 })).toBe('unbound');
  });

  it('图和款色都齐 ⇒ 已绑', () => {
    expect(patternStateOf({ imageId: 7, styleColorId: 11 })).toBe('ready');
  });

  it('三档都有中文标签（界面直接用，不在模板里再写一套）', () => {
    expect(PATTERN_STATE_LABEL).toEqual({ ready: '已绑', unbound: '待绑', noImage: '缺图' });
  });
});

describe('remainText · 「还剩多久」分四档', () => {
  it('已过期要说「已超时」，不能显示成负数', () => {
    expect(remainText(-90 * 60 * 1000)).toBe('已超时 1 小时 30 分');
    expect(remainText(0)).toBe('已超时 1 分钟');
    expect(remainText(-3 * 24 * 3600 * 1000)).toBe('已超时 3 天');
  });

  it('不足 1 小时按分钟；1 天以上按天+小时', () => {
    expect(remainText(20 * 60 * 1000)).toBe('还剩 20 分钟');
    expect(remainText(3 * 3600 * 1000)).toBe('还剩 3 小时');
    expect(remainText((3 * 3600 + 20 * 60) * 1000)).toBe('还剩 3 小时 20 分');
    expect(remainText((2 * 24 * 3600 + 5 * 3600) * 1000)).toBe('还剩 2 天 5 小时');
    expect(remainText(9 * 24 * 3600 * 1000)).toBe('还剩 9 天');
  });

  it('不知道 ≠ 还有很久：没有截止期必须说「不知道」，不能回落成「—」或「明天」', () => {
    expect(remainText(Number.NaN)).toBe('不知道');
    expect(remainText(Number.POSITIVE_INFINITY)).toBe('不知道');
  });

  // ⚠️ 这一组是 2026-11-05 补的**进位边界**：旧实现分段各自 Math.round 余数，
  //    在档位边界会输出「0 小时 60 分」「23 小时 60 分」「29 天 24 小时」——
  //    而原有 4 条用例全是整点（3 小时 / 3 小时 20 分 / 2 天 5 小时 / 9 天），
  //    恰好避开边界 ⇒ 全绿但漏。改回旧实现，这 4 条立刻红。
  it('进位不能溢出：不能出现「60 分」或「24 小时」', () => {
    expect(remainText(59.6 * 60_000)).toBe('还剩 1 小时');
    expect(remainText((23 * 60 + 59.6) * 60_000)).toBe('还剩 1 天');
    expect(remainText(29 * 24 * 3_600_000 + 23.7 * 3_600_000)).toBe('还剩 30 天');
    expect(remainText((47 * 60 + 54) * 60_000)).toBe('还剩 2 天');
  });

  it('档位边界本身要落在正确的一档（59 分 / 1 小时 / 24 小时）', () => {
    expect(remainText(59 * 60_000)).toBe('还剩 59 分钟');
    expect(remainText(60 * 60_000)).toBe('还剩 1 小时');
    expect(remainText(23.9 * 3_600_000)).toBe('还剩 23 小时 54 分');
    expect(remainText(24 * 3_600_000)).toBe('还剩 1 天');
    expect(remainText(48 * 3_600_000)).toBe('还剩 2 天');
  });
});
