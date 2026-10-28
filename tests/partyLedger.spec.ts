// 资金相关人往来与结算单测（`src/lib/partyLedger.ts`）。
//
// 这组用例守的是**资损**：结算方向搞反、超额结算、把作废条目算进往来，
// 三种错都不会抛异常 —— 页面照常显示一个"看起来合理"的余额，然后用户按它打钱。
//
// 特别说明方向那条（`canSettle`）：如果只校验"金额不超过未结清"而不校验方向，
// 一笔方向反了的结算会**通过**校验，并把余额从 −500 变成 −1500（越结越欠）。
// 这是最隐蔽的一种错，所以专门有一组方向断言。
import { describe, it, expect } from 'vitest';
import {
  partyBalance,
  runningUnsettled,
  canSettle,
  canOffsetSettle,
  settlementAmountOf,
  partyLedgerGap,
  describeNet,
  type LedgerEntryLite,
  type SettlementLite,
  type PartyTimelineEvent,
} from '../src/lib/partyLedger';

const income = (amountCents: number, status: 'active' | 'void' = 'active'): LedgerEntryLite => ({
  kind: 'income',
  amountCents,
  status,
});
const expense = (amountCents: number, status: 'active' | 'void' = 'active'): LedgerEntryLite => ({
  kind: 'expense',
  amountCents,
  status,
});
const pay = (amountCents: number, status: 'active' | 'void' = 'active'): SettlementLite => ({
  direction: 'pay',
  amountCents,
  status,
});
const receive = (amountCents: number, status: 'active' | 'void' = 'active'): SettlementLite => ({
  direction: 'receive',
  amountCents,
  status,
});

describe('往来余额（五个数）', () => {
  it('只有收入：对方欠我', () => {
    const b = partyBalance([income(1000), income(500)], []);
    expect(b).toEqual({
      receivableCents: 1500,
      payableCents: 0,
      netCents: 1500,
      settledNetCents: 0,
      unsettledCents: 1500,
      unsettledReceivableCents: 1500,
      unsettledPayableCents: 0,
    });
  });

  it('收支混杂：净往来 = 应收 − 应付', () => {
    const b = partyBalance([income(500), expense(800)], []);
    expect(b.receivableCents).toBe(500);
    expect(b.payableCents).toBe(800);
    expect(b.netCents).toBe(-300);
    expect(b.unsettledCents).toBe(-300);
  });

  it('作废条目不计入（作废 = 这笔从未发生，不是金额为 0）', () => {
    const b = partyBalance([income(1000), income(999, 'void'), expense(200, 'void')], []);
    expect(b.receivableCents).toBe(1000);
    expect(b.payableCents).toBe(0);
    expect(b.netCents).toBe(1000);
  });

  it('已付出去的结算冲减欠款：净 −1000 + 付 1000 → 未结清 0', () => {
    const b = partyBalance([expense(1000)], [pay(1000)]);
    expect(b.netCents).toBe(-1000);
    expect(b.settledNetCents).toBe(1000);
    expect(b.unsettledCents).toBe(0);
    expect(b.unsettledPayableCents).toBe(0);
  });

  it('收到的结算冲减应收', () => {
    const b = partyBalance([income(1000)], [receive(400)]);
    expect(b.settledNetCents).toBe(-400);
    expect(b.unsettledCents).toBe(600);
    expect(b.unsettledReceivableCents).toBe(600);
  });

  it('分方向余额之差恒等于净额（改错符号这条会立刻红）', () => {
    const cases: Array<[LedgerEntryLite[], SettlementLite[]]> = [
      [[income(5000), expense(3000)], []],
      [[income(5000), expense(3000)], [pay(1000)]],
      [[income(5000), expense(3000)], [pay(3000), receive(2000)]],
      [[income(1), expense(999)], [receive(1)]],
    ];
    for (const [entries, settlements] of cases) {
      const b = partyBalance(entries, settlements);
      expect(b.unsettledReceivableCents - b.unsettledPayableCents).toBe(b.unsettledCents);
    }
  });

  it('作废的结算单不计入（撤销后余额必须回到未结状态）', () => {
    const b = partyBalance([expense(1000)], [pay(1000, 'void')]);
    expect(b.settledNetCents).toBe(0);
    expect(b.unsettledCents).toBe(-1000);
  });

  it('金额非法直接抛错，而不是静默当 0（那会让钱从报表里消失）', () => {
    expect(() => partyBalance([{ kind: 'income', amountCents: -1 }], [])).toThrow(/不能为负/);
    expect(() => partyBalance([{ kind: 'income', amountCents: 1.5 }], [])).toThrow(/整数分/);
    expect(() => partyBalance([], [{ direction: 'pay', amountCents: Number.NaN }])).toThrow(
      /不是有效数字/,
    );
  });

  it('类型/方向非法直接抛错（不认识的枚举一定是接错了数据）', () => {
    expect(() => partyBalance([{ kind: 'x' as any, amountCents: 1 }], [])).toThrow(/类型非法/);
    expect(() => partyBalance([], [{ direction: 'swap' as any, amountCents: 1 }])).toThrow(
      /方向非法/,
    );
  });
});

describe('结算校验（能结多少、往哪个方向结）', () => {
  it('对方欠我 1500 → 记「对方付给我」；反方向没有余额可结', () => {
    const b = partyBalance([income(1500)], []);
    expect(canSettle(b, 'receive', 1500)).toEqual({ ok: true });
    const bad = canSettle(b, 'pay', 1500);
    expect(bad.ok).toBe(false);
    expect(bad.ok === false && bad.reason).toBe('nothing-to-settle');
    // 提示里要说明"另一个方向还有钱"，否则用户不知道是方向选错了
    expect(bad.ok === false && bad.message).toMatch(/应收/);
  });

  it('我欠对方 300 → 记「我付给对方」；反方向没有余额可结', () => {
    const b = partyBalance([expense(300)], []);
    expect(canSettle(b, 'pay', 300)).toEqual({ ok: true });
    const bad = canSettle(b, 'receive', 300);
    expect(bad.ok === false && bad.reason).toBe('nothing-to-settle');
  });

  it('超出该方向余额直接拒（本期不做预付/多付）', () => {
    const b = partyBalance([expense(300)], []);
    const bad = canSettle(b, 'pay', 301);
    expect(bad.ok === false && bad.reason).toBe('over-amount');
    // 少结是允许的：剩余部分留在未结清里，下次再结
    expect(canSettle(b, 'pay', 200)).toEqual({ ok: true });
  });

  it('混方向：应收 5000 / 应付 3000 时两笔都能结（只按净额 2000 判会把"该付的"误拦）', () => {
    const b = partyBalance([income(5000), expense(3000)], []);
    expect(b.netCents).toBe(2000);
    expect(b.unsettledPayableCents).toBe(3000);
    expect(b.unsettledReceivableCents).toBe(5000);
    expect(canSettle(b, 'pay', 3000)).toEqual({ ok: true });
    expect(canSettle(b, 'receive', 5000)).toEqual({ ok: true });
    // 上限各自独立，不因另一个方向有余额而放宽
    expect(canSettle(b, 'pay', 3001).ok).toBe(false);
    expect(canSettle(b, 'receive', 5001).ok).toBe(false);
  });

  it('某一个方向结清后，该方向就不能再结；另一个方向不受影响', () => {
    const b = partyBalance([income(5000), expense(3000)], [pay(3000)]);
    expect(b.unsettledPayableCents).toBe(0);
    const bad = canSettle(b, 'pay', 1);
    expect(bad.ok === false && bad.reason).toBe('nothing-to-settle');
    expect(canSettle(b, 'receive', 5000)).toEqual({ ok: true });
  });

  it('已结清 → 没有可结的东西（再结就是凭空多付一笔）', () => {
    const b = partyBalance([expense(300)], [pay(300)]);
    expect(b.unsettledCents).toBe(0);
    const bad = canSettle(b, 'pay', 1);
    expect(bad.ok === false && bad.reason).toBe('nothing-to-settle');
  });

  it('金额非法一律拒（0 / 负 / 小数）', () => {
    const b = partyBalance([expense(300)], []);
    expect(canSettle(b, 'pay', 0).ok).toBe(false);
    expect(canSettle(b, 'pay', -5).ok).toBe(false);
    expect(canSettle(b, 'pay', 1.5).ok).toBe(false);
  });

  it('方向非法一律拒（不认识的枚举一定是接错了数据）', () => {
    const b = partyBalance([expense(300)], []);
    expect(canSettle(b, 'swap' as any, 100).ok).toBe(false);
  });
});

describe('结算金额的唯一算法', () => {
  it('结算单金额 = 勾选条目之和，不取外部值', () => {
    expect(settlementAmountOf([120, 80, 1])).toBe(201);
    expect(settlementAmountOf([])).toBe(0);
  });

  it('条目金额非法时抛错（不允许把脏数据求和成一个"看起来正常"的数）', () => {
    expect(() => settlementAmountOf([100, -1])).toThrow(/不能为负/);
  });
});

describe('往来时间线的滚动余额', () => {
  const ev = (
    date: string,
    kind: PartyTimelineEvent['kind'],
    amountCents: number,
    status: 'active' | 'void' = 'active',
  ): PartyTimelineEvent => ({ date, kind, amountCents, status });

  it('按日期升序累加，符号与 partyBalance 一致（收入 +、支出 −、我付出 +、我收到 −）', () => {
    const events = [
      ev('2026-10-01', 'expense', 1000),
      ev('2026-10-03', 'settle-pay', 400),
      ev('2026-10-05', 'income', 2000),
      ev('2026-10-08', 'settle-receive', 300),
    ];
    expect(runningUnsettled(events)).toEqual([
      { index: 0, balanceCents: -1000 },
      { index: 1, balanceCents: -600 },
      { index: 2, balanceCents: 1400 },
      { index: 3, balanceCents: 1100 },
    ]);
    // 最后一行的余额必须等于 partyBalance 的未结清（两套算法只有一个真相）
    const b = partyBalance(
      [expense(1000), income(2000)],
      [pay(400), receive(300)],
    );
    expect(b.unsettledCents).toBe(1100);
  });

  it('入参乱序也按下标回填（抽屉倒序展示靠这个，重排后余额不能错位）', () => {
    const events = [
      ev('2026-10-05', 'income', 2000),
      ev('2026-10-01', 'expense', 1000),
    ];
    const points = runningUnsettled(events);
    expect(points[1].balanceCents).toBe(-1000);
    expect(points[0].balanceCents).toBe(1000);
  });

  it('同一天按入参顺序排（先记的账在前），不靠字符串比较偶然正确', () => {
    const events = [
      ev('2026-10-02', 'income', 100),
      ev('2026-10-02', 'expense', 300),
    ];
    expect(runningUnsettled(events).map((p) => p.balanceCents)).toEqual([100, -200]);
  });

  it('作废事件保留在时间线上但不改余额（撤销结算后要能看到"这一步没发生"）', () => {
    const events = [
      ev('2026-10-01', 'expense', 1000),
      ev('2026-10-02', 'settle-pay', 1000, 'void'),
      ev('2026-10-03', 'settle-pay', 600),
    ];
    expect(runningUnsettled(events).map((p) => p.balanceCents)).toEqual([-1000, -1000, -400]);
  });

  it('类型非法直接抛错（不认识的枚举一定是接错了数据）', () => {
    expect(() => runningUnsettled([ev('2026-10-01', 'swap' as any, 1)])).toThrow(/类型非法/);
  });
});

describe('全局体检与文案', () => {
  it('Σ净往来 == 总收入 − 总支出 时差为 0', () => {
    expect(partyLedgerGap(1000, 400, 600)).toBe(0);
  });

  it('少挂一个人就会露出来（差额即漏掉的钱）', () => {
    expect(partyLedgerGap(1000, 400, 500)).toBe(-100);
  });

  it('往来方向文案只有三种说法', () => {
    expect(describeNet(0)).toBe('已结清');
    expect(describeNet(1)).toBe('对方欠我');
    expect(describeNet(-1)).toBe('我欠对方');
  });
});

// ---- 互抵结清（2026-10-27）----
// 守的是"分方向余额必须各减各的毛额"：只减净额会让另一个方向留下假余额，
// 用户会被引导去再付一次已经抵掉的钱（而这正是他提问的原场景：收支相同却仍显示"要付"）。
describe('互抵结算单（direction=offset）', () => {
  const offset = (
    payCents: number,
    receiveCents: number,
    status: 'active' | 'void' = 'active'
  ): SettlementLite => ({
    direction: 'offset',
    amountCents: payCents + receiveCents,
    payCents,
    receiveCents,
    status,
  });

  it('两侧各减各的毛额：应付 1000 + 应收 400 互抵后两个方向都归零', () => {
    const b = partyBalance([expense(1000), income(400)], [offset(1000, 400)]);
    expect(b.unsettledPayableCents).toBe(0);
    expect(b.unsettledReceivableCents).toBe(0);
    expect(b.unsettledCents).toBe(0);
    // 净额 = 付出 1000 − 收到 400 = 600，正好等于实际要打出去的钱
    expect(b.settledNetCents).toBe(600);
  });

  it('收支相同（各 1000）完全对冲：实付 0，两边同时归零', () => {
    const b = partyBalance([expense(1000), income(1000)], [offset(1000, 1000)]);
    expect(b.netCents).toBe(0);
    expect(b.settledNetCents).toBe(0);
    expect(b.unsettledPayableCents).toBe(0);
    expect(b.unsettledReceivableCents).toBe(0);
    expect(b.unsettledCents).toBe(0);
  });

  it('只减净额的实现会把应收留成假余额（变异守卫）', () => {
    // 若把这张单当成"pay 600"：应付 1000−1000 看似对，但应收仍是 400 ⇒ 用户会被告知"还能收 400"
    const b = partyBalance([expense(1000), income(400)], [offset(1000, 400)]);
    expect(b.unsettledReceivableCents).not.toBe(400);
    expect(b.unsettledReceivableCents).toBe(0);
  });

  it('缺 payCents/receiveCents 直接抛错（按 0 计会让这笔钱从余额里消失）', () => {
    const broken = { direction: 'offset', amountCents: 1000 } as SettlementLite;
    expect(() => partyBalance([expense(1000)], [broken])).toThrow(/缺少支出\/收入侧金额/);
  });

  it('毛额与两侧之和不一致直接抛错（手改或漏插在这里暴露）', () => {
    const broken: SettlementLite = {
      direction: 'offset',
      amountCents: 1000,
      payCents: 600,
      receiveCents: 600,
    };
    expect(() => partyBalance([expense(1000)], [broken])).toThrow(/与两侧金额之和不一致/);
  });

  it('作废的互抵单不改余额（作废 = 这笔从未发生）', () => {
    const b = partyBalance([expense(1000), income(400)], [offset(1000, 400, 'void')]);
    expect(b.unsettledPayableCents).toBe(1000);
    expect(b.unsettledReceivableCents).toBe(400);
    expect(b.settledNetCents).toBe(0);
  });
});

describe('canOffsetSettle', () => {
  const bal = (payable: number, receivable: number) => {
    const entries: LedgerEntryLite[] = [];
    if (payable > 0) entries.push(expense(payable));
    if (receivable > 0) entries.push(income(receivable));
    return partyBalance(entries, []);
  };

  it('两侧都在各自余额内才通过', () => {
    expect(canOffsetSettle(bal(1000, 400), 1000, 400)).toEqual({ ok: true });
  });

  it('只勾单方向要拒绝（那不是互抵，是普通结算）', () => {
    const r = canOffsetSettle(bal(1000, 400), 1000, 0);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.message).toMatch(/同时勾选收入与支出/);
  });

  it('支出侧超出应付余额要拒绝', () => {
    const r = canOffsetSettle(bal(1000, 400), 1001, 400);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('over-amount');
  });

  it('收入侧超出应收余额要拒绝（否则等于拿结过的额度再抵一次）', () => {
    const r = canOffsetSettle(bal(1000, 400), 1000, 401);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('over-amount');
  });

  it('净额为 0 也允许（完全对冲，一分钱都不用走）', () => {
    expect(canOffsetSettle(bal(1000, 1000), 1000, 1000)).toEqual({ ok: true });
  });

  it('非整数分拒绝', () => {
    const r = canOffsetSettle(bal(1000, 400), 100.5, 400);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('invalid-amount');
  });

  it('余额字段不是整数时保守拒绝（不静默按 0 放行）', () => {
    const broken = { ...bal(1000, 400), unsettledPayableCents: NaN };
    const r = canOffsetSettle(broken, 100, 100);
    expect(r.ok).toBe(false);
    expect(r.ok === false && r.reason).toBe('invalid-amount');
  });
});

// 逐笔时间线的滚动余额：起点必须能带上「相关人合并承接的残额」。
// 不带起点时最后一行永远差 transferCents，而顶部「未结清」里含这笔钱 —— 两个数对不上，
// 用户只能自己减（审查 P2-15）。
describe('runningUnsettled 的起始余额（承接残额）', () => {
  const ev = (over: Partial<PartyTimelineEvent> & { amountCents: number }): PartyTimelineEvent => ({
    date: '2026-10-01',
    kind: 'income',
    status: 'active',
    ...over,
  });

  it('不给起点时行为不变（0 起算）', () => {
    const rows = runningUnsettled([ev({ amountCents: 500 }), ev({ amountCents: 300 })]);
    expect(rows.map((r) => r.balanceCents)).toEqual([500, 800]);
  });

  it('给正起点（我该收的残额）：每一行都整体抬高', () => {
    const rows = runningUnsettled([ev({ amountCents: 500 }), ev({ amountCents: 300 })], 200);
    expect(rows.map((r) => r.balanceCents)).toEqual([700, 1000]);
  });

  it('给负起点（我该付的残额）：末行恰好等于顶部未结清', () => {
    const rows = runningUnsettled(
      [ev({ amountCents: 1000 }), ev({ amountCents: 400, kind: 'expense' })],
      -300
    );
    expect(rows[rows.length - 1].balanceCents).toBe(-300 + 1000 - 400);
  });
});
