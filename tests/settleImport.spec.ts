// 「结算明细」纯解析层的契约用例。
//
// 钉住的是**实测口径**（真实样本 `订单明细-6.xlsx`：2 表 / 200 单 / 412 商品行，2026-09-29 勘察）：
//   · 取**商品级**那张表（订单级行 = `商品id` 为空的那一条）；
//   · **待结算行的费用列全是 0**（平台结算前不给）→ 这些 0 不是事实，靠 `settleStatus` 区分；
//   · 两条等式只对"**已结算且无退款**"的行校验（实测 277/277 命中）；退款/待结算行不校验；
//   · 模板定义行（订单号是 JSON 串）必须跳掉，且**记 issue 不静默丢**；
//   · 幂等键 = (订单号, 商品id, sku id)。
import { describe, expect, it } from 'vitest';
import {
  SETTLE_FEE_CATEGORIES,
  looksLikeOrderNo,
  parseSettleRows,
  pickSettleSheet,
  settleKey,
} from '../src/lib/settleImport';

/** 造一行"已结算·无退款"的商品行：成交 100 → 八类费用合计 9.14 → 净收入 90.86 / 平台分账 9.14 */
function settledRow(over: Record<string, string> = {}): Record<string, string> {
  const fees: Record<string, string> = {};
  for (const k of SETTLE_FEE_CATEGORIES) fees[k] = '0.00';
  // 合计必须**恰好** 9.14（等式①要成立）：5.50 + 2.23 + 0.59 + 0.50 + 0.32 = 9.14
  fees['佣金'] = '5.50';
  fees['交易服务费'] = '2.23';
  fees['联盟佣金'] = '0.59';
  fees['金币营销费'] = '0.50';
  fees['营销技术服务费'] = '0.32';
  return {
    订单号: '3074396411979203',
    商品id: '1005012244700397',
    'sku id': '12000057838127422',
    'sku 描述': 'Color:5,Size:XL,Ships From:China Mainland',
    商品数量: '1',
    支付时间: '2026-06-28 13:31:12',
    发货时间: '2026-06-29 03:21:02',
    确认收货时间: '2026-07-12 03:20:44',
    成交金额: '100.00',
    待结算金额: '0.00',
    售中退款金额: '0.00',
    放款金额: '100.00',
    订单放款净收入金额: '90.86',
    售后退款金额: '0.00',
    平台分账金额: '9.14',
    ...fees,
    币种: 'CNY',
    待结算原因: '已结算',
    预计放款时间: '',
    结算状态: '已结算',
    半托管服务: 'false',
    ...over,
  };
}

describe('looksLikeOrderNo', () => {
  it('16 位纯数字算订单号', () => {
    expect(looksLikeOrderNo('3074396411979203')).toBe(true);
  });
  it('模板定义串 / 空 / 太短 → 不算', () => {
    expect(looksLikeOrderNo('{"dataSourceValidate":false,"hide":true}')).toBe(false);
    expect(looksLikeOrderNo('')).toBe(false);
    expect(looksLikeOrderNo('1234567')).toBe(false);
    expect(looksLikeOrderNo(undefined)).toBe(false);
  });
});

describe('pickSettleSheet', () => {
  const itemSheet = { name: '订单商品明细_1', rows: [settledRow()] };
  const orderSheet = { name: '订单明细_1', rows: [{ 订单号: '3074396411979203', 成交金额: '100.00' }] };

  it('取含 商品id + 结算状态 的那张（订单级那张没有结算状态）', () => {
    expect(pickSettleSheet([orderSheet, itemSheet])?.name).toBe('订单商品明细_1');
  });
  it('两张都合规时取行数多的那张', () => {
    const bigger = { name: 'b', rows: [settledRow(), settledRow({ 订单号: '3074396411979204' })] };
    expect(pickSettleSheet([itemSheet, bigger])?.name).toBe('b');
  });
  it('都不合规 → null', () => {
    expect(pickSettleSheet([orderSheet])).toBeNull();
    expect(pickSettleSheet([])).toBeNull();
    expect(pickSettleSheet(null)).toBeNull();
  });
});

describe('parseSettleRows：行类型与统计', () => {
  it('商品行 / 订单级行（商品id 空）分别归类', () => {
    const r = parseSettleRows([
      settledRow(),
      settledRow({ 商品id: '', 'sku id': '' }), // 订单级行
    ]);
    expect(r.rows[0].lineType).toBe('item');
    expect(r.rows[1].lineType).toBe('order');
    expect(r.stats.itemLines).toBe(1);
    expect(r.stats.orderLines).toBe(1);
    expect(r.issues).toEqual([]);
  });

  it('金额解析成分（含千分位与小数）', () => {
    const r = parseSettleRows([settledRow({ 成交金额: '1,234.56', 平台分账金额: '9.14' })]);
    expect(r.rows[0].dealCents).toBe(123456);
  });

  it('八类费用逐科目存分；"退回"另存', () => {
    const r = parseSettleRows([
      settledRow({ 佣金: '5.50', 佣金退回: '1.25', 平台分账金额: '9.14' }),
    ]);
    expect(r.rows[0].feeCents['佣金']).toBe(550);
    expect(r.rows[0].feeRefundCents['佣金']).toBe(125);
  });

  it('待结算行：标 pending 且**不做净收入校验**（费用列全是 0 不是事实）', () => {
    const zeros: Record<string, string> = {};
    for (const k of SETTLE_FEE_CATEGORIES) zeros[k] = '0.00';
    const r = parseSettleRows([
      settledRow({
        结算状态: '待结算',
        待结算原因: '订单未发货',
        待结算金额: '100.00',
        成交金额: '100.00',
        放款金额: '0.00',
        订单放款净收入金额: '0.00',
        平台分账金额: '0.00',
        ...zeros,
      }),
    ]);
    expect(r.stats.pending).toBe(1);
    expect(r.stats.settled).toBe(0);
    expect(r.rows[0].pendingReason).toBe('订单未发货');
    // 全 0 的行若去校验净收入会得到 0 − (100 − 0) = −100 → 误报；必须跳过
    expect(r.issues.filter((x) => x.kind === 'net-mismatch')).toHaveLength(0);
    expect(r.issues.filter((x) => x.kind === 'split-mismatch')).toHaveLength(0);
  });

  it('全额退款行：不做净收入校验（平台口径：费用与净收入都是 0）', () => {
    const zeros: Record<string, string> = {};
    for (const k of SETTLE_FEE_CATEGORIES) zeros[k] = '0.00';
    const r = parseSettleRows([
      settledRow({
        成交金额: '31.81',
        售中退款金额: '31.81',
        放款金额: '0.00',
        订单放款净收入金额: '0.00',
        平台分账金额: '0.00',
        ...zeros,
      }),
    ]);
    expect(r.rows[0].refundInCents).toBe(3181);
    expect(r.issues.filter((x) => x.kind === 'net-mismatch')).toHaveLength(0);
  });
});

describe('parseSettleRows：两条等式校验（只对已结算且无退款的行）', () => {
  it('平台分账 ≠ Σ八类费用 → 记 split-mismatch（不抛错）', () => {
    const r = parseSettleRows([settledRow({ 平台分账金额: '8.00' })]);
    const hit = r.issues.find((x) => x.kind === 'split-mismatch');
    expect(hit).toBeTruthy();
    expect(hit?.row).toBe(2); // 第 1 行是表头
    expect(r.rows).toHaveLength(1); // 行照存
  });

  it('净收入 ≠ 成交 − Σ费用 → 记 net-mismatch', () => {
    const r = parseSettleRows([settledRow({ 订单放款净收入金额: '95.00' })]);
    expect(r.issues.some((x) => x.kind === 'net-mismatch')).toBe(true);
  });

  it('容差内（≤2 分）不报（浮点/分位误差）', () => {
    const r = parseSettleRows([settledRow({ 平台分账金额: '9.15' })]); // 差 1 分
    expect(r.issues).toEqual([]);
  });
});

describe('parseSettleRows：坏行处理', () => {
  it('模板定义行 → 跳过 + 记 definition-row', () => {
    const r = parseSettleRows([
      { 订单号: '{"dataSourceValidate":false,"hide":true}' },
      settledRow(),
    ]);
    expect(r.rows).toHaveLength(1);
    expect(r.stats.skipped).toBe(1);
    expect(r.issues[0].kind).toBe('definition-row');
    expect(r.issues[0].row).toBe(2);
  });

  it('空订单号 → 跳过 + 记 no-order-no', () => {
    const r = parseSettleRows([{ 订单号: '' }]);
    expect(r.rows).toHaveLength(0);
    expect(r.issues[0].kind).toBe('no-order-no');
  });

  it('空输入不炸', () => {
    const r = parseSettleRows([]);
    expect(r.rows).toEqual([]);
    expect(r.stats).toEqual({ itemLines: 0, orderLines: 0, settled: 0, pending: 0, skipped: 0 });
    expect(parseSettleRows(null).rows).toEqual([]);
  });
});

describe('settleKey（幂等键）', () => {
  it('键 = 订单号 | 商品id | sku id，且稳定（同输入同键）', () => {
    const a = { orderNo: '3074396411979203', itemId: '1005012244700397', skuId: '120' };
    expect(settleKey(a)).toBe(settleKey({ ...a }));
    expect(settleKey(a)).not.toBe(settleKey({ ...a, skuId: '121' }));
    expect(settleKey({ ...a, itemId: '' })).not.toBe(settleKey(a));
  });
});