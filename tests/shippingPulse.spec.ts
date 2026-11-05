import { describe, expect, it } from 'vitest';
import { parseLocalTime, RISK_WINDOW_MS, shippingPulse, type PulseRow } from '../src/lib/shippingPulse';

/** 造一行（默认是一单一件、待发货、有图、有截止期） */
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

/** 固定"现在"：2026-11-01 20:00 本地时间 —— 断言不能依赖运行时刻 */
const NOW = new Date(2026, 10, 1, 20, 0, 0, 0).getTime();

describe('parseLocalTime · 只认一种形状，认不出返回 0', () => {
  it('yyyy-mm-dd hh:mm:ss 按**本地时区**解析', () => {
    const t = parseLocalTime('2026-11-11 23:59:59');
    expect(t).toBe(new Date(2026, 10, 11, 23, 59, 59).getTime());
    expect(new Date(t).getHours()).toBe(23); // 若按 UTC 解析，东八区会偏移，这里必须还是 23
  });

  it('秒可省；日期分隔符兼容 / 与 .（库里有历史写法）', () => {
    expect(parseLocalTime('2026-11-11 23:59')).toBe(new Date(2026, 10, 11, 23, 59, 0).getTime());
    expect(parseLocalTime('2026/11/11 23:59:59')).toBe(new Date(2026, 10, 11, 23, 59, 59).getTime());
    expect(parseLocalTime('2026.11.11 23:59:59')).toBe(new Date(2026, 10, 11, 23, 59, 59).getTime());
  });

  it('空值 / 乱写 / 越界一律 0（**不猜**，猜错一小时就是错的告警）', () => {
    for (const v of ['', '   ', '明天', '2026-11-11', '2026-13-01 10:00:00', '2026-11-01 25:00:00', null, 123]) {
      expect(parseLocalTime(v)).toBe(0);
    }
  });
});

describe('shippingPulse · 第二行四数', () => {
  it('待发货按**单号去重**，件数与缺图按**行**累加', () => {
    // 一单三行：单数 1、件数 3、缺图 2 —— 单级与行级混着算是最常见的错
    const p = shippingPulse(
      [
        row({ orderNo: 'A', qty: 1 }),
        row({ orderNo: 'A', qty: 1, imageId: 0 }),
        row({ orderNo: 'A', qty: 1, imageId: 0 }),
      ],
      { now: NOW },
    );
    expect(p.pending).toBe(1);
    expect(p.pieces).toBe(3);
    expect(p.missingImage).toBe(2);
  });

  it('非待发货的行一条都不进（已发货/已完成/已取消/未知）', () => {
    const p = shippingPulse(
      [
        row({ orderNo: 'B', bizStatus: '已发货' }),
        row({ orderNo: 'C', bizStatus: '交易完成' }),
        row({ orderNo: 'D', bizStatus: '订单关闭' }),
        row({ orderNo: 'E', bizStatus: '什么鬼状态' }), // unknown 也不算待发货
        row({ orderNo: 'F' }), // 唯一的待发货
      ],
      { now: NOW },
    );
    expect(p.pending).toBe(1);
    expect(p.pieces).toBe(1);
    expect(p.missingImage).toBe(0);
  });

  it('认不出的状态绝不落 pending（否则清单里会有永远不消失的行）', () => {
    expect(shippingPulse([row({ bizStatus: '' })], { now: NOW }).pending).toBe(0);
    expect(shippingPulse([row({ bizStatus: '待' })], { now: NOW }).pending).toBe(0);
  });

  it('风险窗口：24h 内算、**恰好 24h 算**（边界含）、超过不算', () => {
    const at = (ms: number) => {
      const d = new Date(NOW + ms);
      const p2 = (n: number) => String(n).padStart(2, '0');
      return `${d.getFullYear()}-${p2(d.getMonth() + 1)}-${p2(d.getDate())} ${p2(d.getHours())}:${p2(d.getMinutes())}:${p2(d.getSeconds())}`;
    };
    expect(shippingPulse([row({ dealDeadline: at(RISK_WINDOW_MS - 1000) })], { now: NOW }).risk).toBe(1);
    expect(shippingPulse([row({ dealDeadline: at(RISK_WINDOW_MS) })], { now: NOW }).risk).toBe(1);
    expect(shippingPulse([row({ dealDeadline: at(RISK_WINDOW_MS + 1000) })], { now: NOW }).risk).toBe(0);
  });

  it('**已过期也算风险** —— 越紧急越要提醒，不能因为在过去就排除', () => {
    const p = shippingPulse([row({ dealDeadline: '2026-10-20 10:00:00' })], { now: NOW });
    expect(p.risk).toBe(1);
    expect(p.pending).toBe(1);
  });

  it('没有截止期 ⇒ 计入 noDeadline 且**不算**风险（"算不出" ≠ "不会超时"）', () => {
    const p = shippingPulse(
      [row({ orderNo: 'A', dealDeadline: '' }), row({ orderNo: 'B', dealDeadline: '不是日期' })],
      { now: NOW },
    );
    expect(p.pending).toBe(2);
    expect(p.risk).toBe(0);
    // 空与"写坏了"都算"算不出"：写坏的若静默跳过，风险数会永远是 0 而没人知道为什么
    expect(p.noDeadline).toBe(2);
  });

  it('件数为空按 1 兜底并**计数**（不静默：界面要说件数可能偏小）', () => {
    const p = shippingPulse(
      [row({ orderNo: 'A', qty: null }), row({ orderNo: 'B', qty: 0 }), row({ orderNo: 'C', qty: 3 })],
      { now: NOW },
    );
    expect(p.pieces).toBe(1 + 1 + 3);
    expect(p.assumedQty).toBe(2);
  });

  it('空输入 / 脏输入不抛错', () => {
    expect(shippingPulse(null).pending).toBe(0);
    expect(shippingPulse([]).pieces).toBe(0);
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    expect(shippingPulse([null as any, undefined as any], { now: NOW }).pending).toBe(0);
  });

  it('四数彼此自洽：pending ≤ 风险 + 算不出的；缺图 ≤ 件数对应行数', () => {
    const rows = [
      row({ orderNo: 'A', dealDeadline: '2026-11-01 21:00:00' }), // 风险
      row({ orderNo: 'B', dealDeadline: '' }), // 算不出
      row({ orderNo: 'C', dealDeadline: '2026-12-01 00:00:00' }), // 不风险
      row({ orderNo: 'D', bizStatus: '已发货' }),
    ];
    const p = shippingPulse(rows, { now: NOW });
    expect(p.pending).toBe(3);
    expect(p.risk).toBe(1);
    expect(p.noDeadline).toBe(1);
    // 每个待发货单必落在"有风险 / 算不出 / 还早"三者之一
    expect(p.risk + p.noDeadline).toBeLessThanOrEqual(p.pending);
  });
});
