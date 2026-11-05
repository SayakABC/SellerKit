// 「全部日期」这一档的守卫（记账 › 明细 / 单店 / 汇总 共用一个期间状态）。
//
// 为什么必须钉**请求参数**而不是屏幕上的数字：
//   主进程对 period 的处理是 `if (filter.period) where.push('e.period = ?')` ——
//   传一个它认不出来的值（比如哨兵 `'all'`）不会有任何报错，只会查出 0 行。
//   于是"点了全部，列表一片空白"看起来像没有数据，而不像参数传错。
//   这类故障只能靠断言"发出去的到底是什么"拦住，单据断言行数在夹具恰好为空时恒绿。
//
// 另一半风险在**偏好还原**：`month` 以前只认 `YYYY-MM`，
// 若忘了给 `ALL_PERIOD` 开口子，用户每次重开都要重新点一次「全部」——
// 不丢数据、不出错数，只是"设定不生效"，因此最难被发现。
import { describe, it, expect, vi, beforeEach } from 'vitest';

// vi.mock 的工厂会被提升到 import 之前，共享状态必须经 vi.hoisted 提供
const h = vi.hoisted(() => ({
  prefs: null as Record<string, unknown> | null,
  calls: { entries: [] as Array<Record<string, unknown>>, summary: [] as string[] },
}));

vi.mock('@/core/services/storage', () => ({
  useModuleStorage: () => ({
    load: async () => h.prefs,
    save: async () => undefined,
    scheduleSave: () => undefined,
    clear: async () => undefined,
  }),
}));

vi.mock('../src/modules/ledger/api', () => ({
  ensure: async () => undefined,
  entries: async (filter: Record<string, unknown>) => {
    h.calls.entries.push(filter);
    return [];
  },
  summary: async (period: string) => {
    h.calls.summary.push(period);
    return {
      incomeCents: 0,
      expenseCents: 0,
      balanceCents: 0,
      entryCount: 0,
      sharedIncomeCents: 0,
      sharedExpenseCents: 0,
    };
  },
  categories: async () => [],
  parties: async () => [],
  shops: async () => [],
}));

import { ALL_PERIOD, useLedger } from '../src/modules/ledger/useLedger';

/** 等 `setAllPeriod()` / `shiftMonth()` 里那条 `void load()` 落到底 */
async function settled(): Promise<void> {
  await vi.waitFor(() => {
    if (!h.calls.entries.length) throw new Error('还没发出取数请求');
  });
}

function lastEntryFilter(): Record<string, unknown> {
  return h.calls.entries[h.calls.entries.length - 1];
}

function lastSummaryPeriod(): string {
  return h.calls.summary[h.calls.summary.length - 1];
}

function thisMonth(): string {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}

beforeEach(() => {
  h.prefs = null;
  h.calls.entries.length = 0;
  h.calls.summary.length = 0;
});

describe('① 全部日期 = 不传 period（而不是传一个哨兵）', () => {
  it('默认是本月：列表与合计都带 YYYY-MM', async () => {
    const s = useLedger();
    await s.init();
    expect(s.isAllPeriod.value).toBe(false);
    expect(s.month.value).toBe(thisMonth());
    expect(lastEntryFilter().period).toBe(thisMonth());
    expect(lastSummaryPeriod()).toBe(thisMonth());
  });

  it('切到全部后：列表请求**不带 period**，合计传空串（全期间，与往来对账同口径）', async () => {
    const s = useLedger();
    await s.init();
    h.calls.entries.length = 0;
    h.calls.summary.length = 0;

    s.setAllPeriod();
    await settled();

    // 关键：不是 `period: 'all'`、也不是 `period: ''` —— 是**根本没有这个筛选**
    expect(lastEntryFilter().period).toBeUndefined();
    expect(lastSummaryPeriod()).toBe('');
    expect(s.isAllPeriod.value).toBe(true);
    expect(s.monthLabel()).toBe('全部日期');
  });

  it('从全部切回具体月份：period 立刻恢复成那个月（不是把全部当成一个月份）', async () => {
    const s = useLedger();
    await s.init();
    s.setAllPeriod();
    await settled();

    h.calls.entries.length = 0;
    s.shiftMonth(-1);
    await settled();
    const expectPrev = (() => {
      const d = new Date();
      const p = new Date(d.getFullYear(), d.getMonth() - 1, 1);
      return `${p.getFullYear()}-${String(p.getMonth() + 1).padStart(2, '0')}`;
    })();
    expect(lastEntryFilter().period).toBe(expectPrev);
    expect(s.isAllPeriod.value).toBe(false);
  });
});

describe('② 全部日期下翻月不会算出 NaN-NaN', () => {
  it('点「‹」从本月往回翻，得到上个月这个合法值', async () => {
    const s = useLedger();
    await s.init();
    s.setAllPeriod();
    await settled();

    s.shiftMonth(-1);
    // `NaN-NaN` 是合法字符串，`/^\d{4}-\d{2}$/` 才拦得住；主进程只 slice 不校验，
    // 传进去就是"这个月一条都没有"，而且不报错
    expect(s.month.value).toMatch(/^\d{4}-\d{2}$/);
    const d = new Date();
    const prev = new Date(d.getFullYear(), d.getMonth() - 1, 1);
    expect(s.month.value).toBe(`${prev.getFullYear()}-${String(prev.getMonth() + 1).padStart(2, '0')}`);
  });
});

describe('③ 偏好还原：存过"全部"就要还原成"全部"', () => {
  it('偏好里是 all → 启动即全部日期，且一进来就按全期间取数', async () => {
    h.prefs = { month: ALL_PERIOD };
    const s = useLedger();
    await s.init();
    expect(s.month.value).toBe(ALL_PERIOD);
    expect(s.isAllPeriod.value).toBe(true);
    // 不能先按本月查一遍再切：那会让"上次选的期间"在首屏闪一下旧数
    expect(lastEntryFilter().period).toBeUndefined();
    expect(lastSummaryPeriod()).toBe('');
  });

  it('偏好里的月份坏掉 → 回落本月，**不能**顺带变成"全部"', async () => {
    h.prefs = { month: '2026/10' };
    const s = useLedger();
    await s.init();
    expect(s.month.value).toBe(thisMonth());
    expect(s.isAllPeriod.value).toBe(false);
  });
});
