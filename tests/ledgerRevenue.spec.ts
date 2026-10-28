// 记账「按营收占比分摊」的取数/归属层单测（`src/lib/ledgerRevenue.ts`）。
//
// 这一层的风险全是**悄悄摊错**：订单只存店名原文，名字靠归一键对到店铺 id，
// 一旦"认不出就猜一个最像的"，钱会摊到错的店上，而界面上只是两个数字，
// 谁也看不出哪个错了。故断言钉在三件事：
//   ① 归一对得上 → 金额进对的 id；
//   ② 对不上（未登记 / 同名多店）→ 进 `unmatched` 并标明原因，**不许**落到任意一家；
//   ③ 三块金额（已归属 + 对不上 + 没写店铺）恒等于总营收 —— 少一块就是"钱蒸发了"。
import { describe, it, expect } from 'vitest';
import {
  participantRevenueCents,
  revenueByShopId,
  revenueFromOrderRows,
  type RevenueShopRef,
} from '../src/lib/ledgerRevenue';
import type { OrderCostInput } from '../src/lib/orderCost';
import type { UnifiedOrderRow } from '../src/types';

type OrderInput = OrderCostInput['orders'][number];

function order(patch: Partial<OrderInput> & { orderNo: string }): OrderInput {
  return {
    id: 1,
    shop: '',
    shopKey: '',
    amountCents: null,
    rawFields: {},
    ...patch,
  };
}

const shops: RevenueShopRef[] = [
  { id: 11, name: '店A', nameKey: '店a' },
  { id: 12, name: '店B', nameKey: '店b' },
];

describe('营收 → 店铺 id 归属', () => {
  it('同一家店多单累加；关闭单不计营收（口径与统计页一致）', () => {
    const r = revenueByShopId({
      shops,
      orders: [
        order({ orderNo: 'A1', shop: '店A', shopKey: '店a', amountCents: 10000, bizStatus: '已完成' }),
        order({ orderNo: 'A2', shop: '店A', shopKey: '店a', amountCents: 2500, bizStatus: '运输中' }),
        order({ orderNo: 'A3', shop: '店A', shopKey: '店a', amountCents: 9999, bizStatus: '已关闭' }),
      ],
    });
    expect(r.byShopId).toEqual({ 11: 12500 });
    expect(r.assignedTotalCents).toBe(12500);
    expect(r.totalCents).toBe(12500);
    expect(r.excludedClosedRows).toBe(1);
    expect(r.unmatched).toEqual([]);
  });

  it('未登记的店名进 unmatched(not-found)，**不**归到任何一家', () => {
    const r = revenueByShopId({
      shops,
      orders: [order({ orderNo: 'X1', shop: '新开的店', shopKey: '新开的店', amountCents: 700 })],
    });
    expect(r.byShopId).toEqual({});
    expect(r.unmatched).toEqual([
      { shopKey: '新开的店', shop: '新开的店', amountCents: 700, reason: 'not-found' },
    ]);
    expect(r.unmatchedTotalCents).toBe(700);
  });

  it('同名多店（跨平台）进 unmatched(ambiguous)，不按遍历顺序取第一家', () => {
    const dup: RevenueShopRef[] = [
      { id: 21, name: '同名店', nameKey: '同名店' },
      { id: 22, name: '同名店', nameKey: '同名店' },
    ];
    const r = revenueByShopId({
      shops: dup,
      orders: [order({ orderNo: 'D1', shop: '同名店', shopKey: '同名店', amountCents: 300 })],
    });
    expect(r.byShopId).toEqual({});
    expect(r.unmatched.map((u) => u.reason)).toEqual(['ambiguous']);
  });

  it('订单没写店铺 → unassigned（无处可归，不掺进任何店）', () => {
    const r = revenueByShopId({
      shops,
      orders: [
        order({ orderNo: 'N1', shop: '', shopKey: '', amountCents: 400 }),
        order({ orderNo: 'N2', shop: '店B', shopKey: '店b', amountCents: 600 }),
      ],
    });
    expect(r.byShopId).toEqual({ 12: 600 });
    expect(r.unassignedCents).toBe(400);
    expect(r.totalCents).toBe(1000);
  });

  it('金额缺失的行只计数、不进任何合计（不按 0 算成"有营收的 0"）', () => {
    const r = revenueByShopId({
      shops,
      orders: [
        order({ orderNo: 'M1', shop: '店A', shopKey: '店a', amountCents: null, source: 'collect' }),
        order({ orderNo: 'M2', shop: '店A', shopKey: '店a', amountCents: 100 }),
      ],
    });
    expect(r.byShopId).toEqual({ 11: 100 });
    expect(r.missingRevenueRows).toBe(1);
    expect(r.totalCents).toBe(100);
  });

  it('三块金额恒等于总营收（已归属 + 对不上 + 没写店铺）', () => {
    const r = revenueByShopId({
      shops,
      orders: [
        order({ orderNo: 'T1', shop: '店A', shopKey: '店a', amountCents: 1000 }),
        order({ orderNo: 'T2', shop: '店B', shopKey: '店b', amountCents: 500 }),
        order({ orderNo: 'T3', shop: '野店', shopKey: '野店', amountCents: 200 }),
        order({ orderNo: 'T4', shop: '', shopKey: '', amountCents: 50 }),
      ],
    });
    expect(r.assignedTotalCents + r.unmatchedTotalCents + r.unassignedCents).toBe(r.totalCents);
    expect(r.totalCents).toBe(1750);
  });

  it('触达取数上限时透传 truncated（调用方据此停用该基准，而不是拿半份数据摊钱）', () => {
    const r = revenueByShopId({ shops, orders: [], truncated: true });
    expect(r.truncated).toBe(true);
  });
});

describe('参与店铺的营收权重', () => {
  it('按传入的店铺顺序取，没营收 = 0（0 是真实的 0，不是缺数据）', () => {
    const revenue = revenueByShopId({
      shops,
      orders: [order({ orderNo: 'P1', shop: '店A', shopKey: '店a', amountCents: 85 })],
    });
    expect(participantRevenueCents(revenue, [12, 11, 13])).toEqual([0, 85, 0]);
  });

  it('没有营收数据时全部为 0（交给分摊引擎回落平均并明确标注）', () => {
    expect(participantRevenueCents(null, [1, 2])).toEqual([0, 0]);
  });
});

describe('取数接线：订单行 → 营收（记一笔与批量导入共用一份）', () => {
  /** 宿主取数返回的行形状（比 `order()` 多出的字段是 `UnifiedOrderRow` 的必填项） */
  function row(patch: Partial<UnifiedOrderRow> & { orderNo: string }): UnifiedOrderRow {
    return {
      shop: '',
      shopKey: '',
      amountCents: null,
      rawFields: {},
      ...patch,
    } as UnifiedOrderRow;
  }

  const ORDERS = [
    row({ orderNo: 'W1', shop: '店A', shopKey: '店a', amountCents: 30000, bizStatus: '交易完成' }),
    row({ orderNo: 'W2', shop: '店B', shopKey: '店b', amountCents: 10000, bizStatus: '交易完成' }),
  ];

  it('与直接调 `revenueByShopId` 的结果逐字段相同（接线只做接线，不加口径）', () => {
    const viaWiring = revenueFromOrderRows({ orders: ORDERS, shops });
    expect(viaWiring).toEqual(
      revenueByShopId({ orders: ORDERS, shops })
    );
    expect(viaWiring.byShopId).toEqual({ 11: 30000, 12: 10000 });
  });

  it('`limit` 是给接线用的截断判据：行数够到上限即 truncated（半份订单会把钱摊错店）', () => {
    expect(revenueFromOrderRows({ orders: ORDERS, shops, limit: 2 }).truncated).toBe(true);
    expect(revenueFromOrderRows({ orders: ORDERS, shops, limit: 3 }).truncated).toBe(false);
    // 不传 limit 时不自作主张判截断
    expect(revenueFromOrderRows({ orders: ORDERS, shops }).truncated).toBe(false);
  });

  it('取数返回空/坏值时给空表，而不是抛错（界面据此显示"这个月还没有营收"）', () => {
    for (const bad of [null, undefined, 'oops']) {
      const r = revenueFromOrderRows({ orders: bad as unknown as UnifiedOrderRow[], shops, limit: 2000 });
      expect(r.byShopId).toEqual({});
      expect(r.truncated).toBe(false);
    }
  });

  it('店铺表缺失时不崩，全部订单进 unmatched（占比基准随后因无权重回落平均）', () => {
    const r = revenueFromOrderRows({ orders: ORDERS, shops: null });
    expect(r.byShopId).toEqual({});
    expect(r.unmatched.map((u) => u.shop)).toEqual(['店A', '店B']);
  });
});
