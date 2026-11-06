import { describe, expect, it } from 'vitest';
import { planShipReceipt, splitShipBatch, toShipReceipt } from '../electron/mango-ingest';

/**
 * 芒果帧 → 发货回执的守卫（2026-11-05，P3a / S1）。
 *
 * 这一层是"已发货批能不能安全落库"的第一道门：它只做**纯映射**（不写库），
 * 所以所有容易错的取值——毫秒 vs 本地串、两套键名、缺号、空运单——都能在这里钉住。
 *
 * 断言原则与 `mangoIngest.spec.ts` 一致：**每一条成对**（该取到 ≠ 该留空），
 * 单边断言等于没断言（改坏一处，另一处照样绿）。
 *
 * 夹具形状照抄真机抓包（`SellerKitExtensions/tests/fixtures/mango-search.sample.json`）：
 * 原始帧是 `orderId` + `gmtSend`（毫秒），扩展规整帧是 `orderNo` + 已格式化的本地串。
 */

/** 一单已发货的**原始响应**（字段名照抄抓包；`gmtSend` 是毫秒） */
function rawShipped(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: '3077508596852457',
    cnOrderStatus: '已发货',
    orderStatus: 'send_goods',
    gmtSend: 1762200000000, // 2026-11-04 04:00:00 (UTC) → 本地 12:00:00
    logisticsNo: 'LP00123456789',
    logisticsServiceName: '菜鸟无忧物流-标准',
    logisticsTypeCode: 'CAINIAO_STD',
    ...over,
  };
}

/** 一单待发货的原始响应：`gmtSend` 为 `null`，没有运单号 */
function rawPending(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderId: '3077508596859999',
    cnOrderStatus: '等待卖家发货',
    orderStatus: 'wait_seller_send',
    gmtSend: null,
    logisticsNo: '',
    ...over,
  };
}

/** 扩展规整帧（`mango-parse.js` 的 `toOrder` 形状；S2 起会带 `shipTime` / `logisticsCarrier`） */
function normalized(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    orderNo: '3077508596852457',
    platformStatusCn: '已发货',
    platformStatus: 'send_goods',
    shipTime: '2026-11-04 12:00:00',
    logisticsNo: 'LP00123456789',
    logisticsCarrier: '菜鸟无忧物流-标准',
    ...over,
  };
}

describe('toShipReceipt：一单 → 回执四列', () => {
  it('原始帧：毫秒转本地时间串，运单号与承运商都取到', () => {
    const r = toShipReceipt(rawShipped()).receipt!;
    expect(r.orderNo).toBe('3077508596852457');
    expect(r.bizStatus).toBe('已发货');
    // 毫秒 → 本地（`mangoTime` 唯一实现）→ `YYYY-MM-DD HH:mm:ss`
    expect(r.shipTime).toMatch(/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/);
    expect(r.logisticsNo).toBe('LP00123456789');
    // 优先中文名（人核对方便），编码只在没有名字时兜底
    expect(r.logisticsCarrier).toBe('菜鸟无忧物流-标准');
  });

  it('规整帧：已是本地串就原样，不再过一遍毫秒解析', () => {
    const r = toShipReceipt(normalized()).receipt!;
    expect(r.shipTime).toBe('2026-11-04 12:00:00');
    expect(r.bizStatus).toBe('已发货');
    expect(r.logisticsCarrier).toBe('菜鸟无忧物流-标准');
  });

  it('未发货：`gmtSend: null` ⇒ 发货时间是空串（不是 1970、不是这次采集的时刻）', () => {
    const r = toShipReceipt(rawPending()).receipt!;
    expect(r.shipTime).toBe('');
    expect(r.logisticsNo).toBe('');
    expect(r.bizStatus).toBe('等待卖家发货');
  });

  it('非本地串形状的时间（ISO / 只有日期）一律丢成空串', () => {
    // 为什么：`ship_time` 与 `deal_deadline` 是同一族的列，界面按
    // `YYYY-MM-DD HH:mm:ss` 直接截取比较；写进 ISO 串不会报错，只会让排序与倒计时静默错位。
    for (const bad of ['2026-11-04T12:00:00Z', '2026-11-04', '11/04/2026']) {
      expect(toShipReceipt(rawShipped({ shipTime: bad, gmtSend: null })).receipt!.shipTime).toBe('');
    }
  });

  it('运单号两套键名都认（`logisticsNo` / `mailNo`），缺了就是空串', () => {
    expect(toShipReceipt({ orderId: 'A', mailNo: 'MAIL9' }).receipt!.logisticsNo).toBe('MAIL9');
    expect(toShipReceipt({ orderId: 'A' }).receipt!.logisticsNo).toBe('');
    // 两个都有时以 `logisticsNo` 为准（`mailNo` 是部分站点的旧键）
    expect(
      toShipReceipt({ orderId: 'A', logisticsNo: 'NEW1', mailNo: 'OLD1' }).receipt!.logisticsNo,
    ).toBe('NEW1');
  });

  it('承运商回落顺序：中文名 → 扩展字段 → 编码', () => {
    expect(toShipReceipt({ orderId: 'A', logisticsServiceName: '中名', logisticsTypeCode: 'CODE' }).receipt!.logisticsCarrier).toBe('中名');
    expect(toShipReceipt({ orderId: 'A', logisticsTypeCode: 'CODE' }).receipt!.logisticsCarrier).toBe('CODE');
    expect(toShipReceipt({ orderId: 'A', logisticsCarrier: '扩展名' }).receipt!.logisticsCarrier).toBe('扩展名');
    expect(toShipReceipt({ orderId: 'A' }).receipt!.logisticsCarrier).toBe('');
  });

  it('缺订单号 ⇒ `receipt: null` 且 reason 说得清（不能给个空号让上层去写库）', () => {
    for (const bad of [{}, null, undefined, 'string', 42, { cnOrderStatus: '已发货' }]) {
      const r = toShipReceipt(bad);
      expect(r.receipt).toBeNull();
      expect(r.reason.length).toBeGreaterThan(0);
    }
  });

  it('两套键名认的是**同一个单号**（入库与回执不许各写一遍顺序）', () => {
    // 这条是防"两处各写一遍取键顺序、改一处就分叉"的守卫：
    // 分叉的后果不是报错，而是"入库写成 A、回执记到 B"，有几单永远更新不到。
    const fromRaw = toShipReceipt({ orderId: 'X1' }).receipt!;
    const fromNorm = toShipReceipt({ orderNo: 'X1' }).receipt!;
    expect(fromRaw.orderNo).toBe('X1');
    expect(fromNorm.orderNo).toBe('X1');
    // 两个都有时一致地取 `orderId`（与 `toInternal` 同序）
    expect(toShipReceipt({ orderId: 'A', orderNo: 'B' }).receipt!.orderNo).toBe('A');
  });
});

describe('planShipReceipt：一批帧 → 回执计划', () => {
  it('正常的已发货批：全部映射成功，withShipTime 数得上', () => {
    const p = planShipReceipt([rawShipped(), rawShipped({ orderId: '2' }), rawPending()]);
    expect(p.receipts).toHaveLength(3);
    expect(p.bad).toHaveLength(0);
    // 3 单里 2 单带发货时间 —— 这是"这批是回执批"的机械证据（不靠猜筛选参数）
    expect(p.withShipTime).toBe(2);
  });

  it('缺号的帧进 bad 且**不进 receipts**（宁可少更新，不能写错行）', () => {
    const p = planShipReceipt([rawShipped(), { cnOrderStatus: '已发货' }, rawPending()]);
    expect(p.receipts).toHaveLength(2);
    expect(p.bad).toHaveLength(1);
    expect(p.bad[0]!.reason).toContain('订单号');
    // 连单号都没有 ⇒ 只能用**这批里的第几条**占位（`#2` = 这批第 2 条）。
    // 不写 `#1` 而是算位置：一条都没有号时，人最需要知道的是"去芒果按第几条找"。
    expect(p.bad[0]!.orderNo).toBe('#2');
  });

  it('只有 `orderNo` 的规整帧**不许**被当成缺号丢掉', () => {
    // 这是上一条的反向：`bad` 的判据必须是"两个键都没值"，只认 `orderId` 会把
    // 线上真实推送（规整帧只有 `orderNo`）整批丢进 bad，而回执永远同步不到。
    const p = planShipReceipt([{ orderNo: 'ONLY-NO', platformStatusCn: '已发货' }]);
    expect(p.bad).toHaveLength(0);
    expect(p.receipts).toHaveLength(1);
    expect(p.receipts[0]!.orderNo).toBe('ONLY-NO');
  });

  it('空输入 / 非数组 ⇒ 空计划，不抛', () => {
    for (const bad of [null, undefined, {}, 'orders', 0]) {
      const p = planShipReceipt(bad);
      expect(p.receipts).toEqual([]);
      expect(p.bad).toEqual([]);
      expect(p.withShipTime).toBe(0);
    }
  });

  it('全待发货批：withShipTime 为 0（这就是"这批不是回执"的信号）', () => {
    const p = planShipReceipt([rawPending(), rawPending({ orderId: '3' })]);
    expect(p.withShipTime).toBe(0);
    expect(p.receipts).toHaveLength(2);
  });

  it('bad 最多留 50 条，但 receipts 一单不少', () => {
    const many = Array.from({ length: 60 }, () => ({ cnOrderStatus: '已发货' }));
    const p = planShipReceipt(many);
    expect(p.bad).toHaveLength(50);
    expect(p.receipts).toHaveLength(0);
  });
});

describe('splitShipBatch：一批帧 → 回执批 / 待发批（分流判据的唯一实现）', () => {
  // 为什么要有这一条：`ingestMangoOrders` 靠它决定"这单走 UPDATE 四列"还是"走整单替换"。
  // 分错的后果不是报错，是**静默清掉归类与图案绑定**（`upsertCollectedOrder` 是 DELETE + 重插）。
  // 所以两头都要钉：该进回执的进得去（正向），不该进的**一个都不许进**（反向）。

  it('混批：2 已发 + 1 待发 + 1 缺号 ⇒ 回执 2 / 待发 2（缺号的落回待发批，不静默丢）', () => {
    const s = splitShipBatch([
      rawShipped({ orderId: 'A' }),
      rawPending({ orderId: 'B' }),
      rawShipped({ orderId: 'C', logisticsNo: 'LP-C' }),
      { cnOrderStatus: '已发货', gmtSend: 1762200000000 }, // 缺号
    ]);
    expect(s.receipts.map((r) => r.orderNo)).toEqual(['A', 'C']);
    expect(s.pending).toHaveLength(2);
    // 缺号那一帧仍在 pending：交给 toInternal 报"缺少订单号"，而不是在这里被吞掉
    expect(s.pending[1]).toEqual({ cnOrderStatus: '已发货', gmtSend: 1762200000000 });
  });

  it('全待发批 ⇒ 回执 0，一单都不许进（判据恒真就会让队列永远清不掉）', () => {
    const s = splitShipBatch([rawPending({ orderId: 'A' }), rawPending({ orderId: 'B' })]);
    expect(s.receipts).toHaveLength(0);
    expect(s.pending).toHaveLength(2);
  });

  it('全已发批 ⇒ 待发 0（不把已发货单再塞进 upsert 路径）', () => {
    const s = splitShipBatch([rawShipped({ orderId: 'A' }), rawShipped({ orderId: 'B' })]);
    expect(s.receipts).toHaveLength(2);
    expect(s.pending).toHaveLength(0);
  });

  it('「已发货」这四个字不是判据 —— 没有发货时间的已发状态单仍走待发批', () => {
    // 现实里会出现：状态已是「已发货」但 `gmtSend` 还没回填（平台异步写）。
    // 这种单如果进了回执批，`applyShipStatus` 只会写 `biz_status`，看不出问题；
    // 但如果哪天判据被改成"看状态文本"，另一头就会有人放松成"看带没带物流单号"，
    // 而那会把"填了运单号还没发出去"的单误判成已发。判据只认发货时间。
    const s = splitShipBatch([{ orderId: 'X', cnOrderStatus: '已发货', logisticsNo: 'LP-X' }]);
    expect(s.receipts).toHaveLength(0);
    expect(s.pending).toHaveLength(1);
  });

  it('规整帧同样能分（扩展 S2 起的 shipTime 走的是另一条键）', () => {
    const s = splitShipBatch([normalized({ orderNo: 'N1' }), { orderNo: 'N2', platformStatusCn: '等待卖家发货' }]);
    expect(s.receipts.map((r) => r.orderNo)).toEqual(['N1']);
    expect(s.pending).toHaveLength(1);
  });

  it('非数组 / 空 ⇒ 两边都空（调用方不必先判类型）', () => {
    for (const bad of [null, undefined, 'x', 42, {}]) {
      const s = splitShipBatch(bad);
      expect(s.receipts).toHaveLength(0);
      expect(s.pending).toHaveLength(0);
    }
  });

  it('顺序保持：回执批按原顺序（同一单重复出现时靠后的覆盖靠前的，别打乱）', () => {
    const s = splitShipBatch([
      rawShipped({ orderId: 'A', logisticsNo: 'LP-1' }),
      rawPending({ orderId: 'B' }),
      rawShipped({ orderId: 'A', logisticsNo: 'LP-2' }),
    ]);
    expect(s.receipts.map((r) => `${r.orderNo}:${r.logisticsNo}`)).toEqual(['A:LP-1', 'A:LP-2']);
    expect(s.pending).toHaveLength(1);
  });
});
