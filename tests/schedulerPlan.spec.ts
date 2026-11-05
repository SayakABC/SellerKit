// tests/schedulerPlan.spec.ts
// 开机自动化的判定层（`electron/schedulerPlan.ts`）—— 纯函数，vitest 直接覆盖。
//
// 这几条测的都是"**写错了不会报错**"的地方：
//   · 该不该开浏览器：多开一次 = 用户开机被 Chrome 弹一脸；少开一次 = 当天的单没抓；
//   · 通知说什么：把「抓 0 条但芒果说有 12 单」说成「同步成功」= 静默漏发整天。
// 两者都没有异常、没有红字，只会在某天早上表现为"今天没单"，所以判据必须逐条钉住。
//
// 时区：`vitest.config.mts` 已固定 `TZ=Asia/Shanghai`，下面"跨天"的用例依赖这个前提。
import { describe, it, expect } from 'vitest';
import {
  INGEST_WAIT_MS,
  MANGO_ORDER_LIST_URL,
  MAX_AUTO_SYNC_PER_DAY,
  NETWORK_RETRY_GAP_MS,
  NETWORK_TRIES,
  NETWORK_WAIT_MS,
  autoSyncNotice,
  decideAutoSync,
  localClock,
  localDayKey,
  shouldStartHidden,
} from '../electron/schedulerPlan';

/** 本地时刻：按参数直接构造，避免用 UTC 串写用例（那会把时区阈值也写死进断言里） */
const at = (y: number, m: number, d: number, h = 9, mi = 0): Date => new Date(y, m - 1, d, h, mi, 0, 0);
/** 本地时刻 → ISO 串（模拟 `sk_sync_log.finished_at` 的存法） */
const iso = (y: number, m: number, d: number, h = 9, mi = 0): string => at(y, m, d, h, mi).toISOString();

describe('本地日 / 时分', () => {
  it('按本地时区给 yyyy-mm-dd（不用 toISOString：那是 UTC 日期）', () => {
    // 东八区 11-02 00:30 = UTC 11-01 16:30：`toISOString().slice(0,10)` 会返回 11-01（前一天）
    expect(localDayKey(new Date('2026-11-01T16:30:00Z'))).toBe('2026-11-02');
    expect(localDayKey(at(2026, 11, 1, 23, 59))).toBe('2026-11-01');
    expect(localClock(at(2026, 11, 1, 9, 5))).toBe('09:05');
  });

  it('认不出的时间给空串（调用方据此不显示时间，而不是 Invalid Date）', () => {
    expect(localDayKey('')).toBe('');
    expect(localDayKey('not-a-date')).toBe('');
    expect(localClock('not-a-date')).toBe('');
  });
});

describe('decideAutoSync — 今天该不该自动同步', () => {
  it('今天已经同步过 → already_done（文案带出本地时分）', () => {
    const d = decideAutoSync({ now: at(2026, 11, 1, 9, 0), lastSyncAt: iso(2026, 11, 1, 8, 12), attemptsToday: 0 });
    expect(d.action).toBe('already_done');
    expect(d.reason).toContain('08:12');
  });

  it('上次同步是昨天 → open（跨天必须重新抓，否则今天的单永远不进库）', () => {
    const d = decideAutoSync({ now: at(2026, 11, 1, 9, 0), lastSyncAt: iso(2026, 10, 31, 22, 50), attemptsToday: 0 });
    expect(d.action).toBe('open');
    expect(d.reason).toContain('2026-10-31');
  });

  it('从没同步过（空串）→ open', () => {
    expect(decideAutoSync({ now: at(2026, 11, 1, 9, 0), lastSyncAt: '', attemptsToday: 0 }).action).toBe('open');
  });

  it('跨天边界：今天 00:05 开机，昨天 23:50 那次不算"今天已同步"', () => {
    const d = decideAutoSync({ now: at(2026, 11, 1, 0, 5), lastSyncAt: iso(2026, 10, 31, 23, 50), attemptsToday: 0 });
    expect(d.action).toBe('open');
    // 反过来：今天 00:05 已经同步过（00:03 那次），再开机就不该开浏览器
    expect(
      decideAutoSync({ now: at(2026, 11, 1, 0, 5), lastSyncAt: iso(2026, 11, 1, 0, 3), attemptsToday: 0 }).action,
    ).toBe('already_done');
  });

  it('今天已触发满 3 次 → give_up（即使没同步过也不再开浏览器：不做常驻轮询）', () => {
    const d = decideAutoSync({ now: at(2026, 11, 1, 22, 0), lastSyncAt: '', attemptsToday: 3 });
    expect(d.action).toBe('give_up');
    expect(d.attempts).toBe(3);
    expect(d.reason).toContain('3 次');
  });

  it('**先判上限、再判今天已同步**：上限判定的优先级不能被 already_done 抢走', () => {
    // 同一天已经同步过，且已触发 3 次 —— 两个条件同时成立时给 give_up（说明"补跑用满了"），
    // 而不是 already_done（那会让人以为"今天就是同步成功的一天"，实际是三次都没结果）
    expect(
      decideAutoSync({ now: at(2026, 11, 1, 9, 0), lastSyncAt: iso(2026, 11, 1, 8, 0), attemptsToday: 3 }).action,
    ).toBe('give_up');
  });

  it('上限可压到 1（单测/排障用），且脏输入按 0 次处理', () => {
    expect(decideAutoSync({ now: at(2026, 11, 1), lastSyncAt: '', attemptsToday: 1, maxAttempts: 1 }).action).toBe(
      'give_up',
    );
    const d = decideAutoSync({ now: at(2026, 11, 1), lastSyncAt: '', attemptsToday: -5 });
    expect(d.action).toBe('open');
    expect(d.attempts).toBe(0);
  });

  it('三种出口的 reason 都不许为空（它要写进 sk_auto_sync_log）', () => {
    for (const input of [
      { now: at(2026, 11, 1), lastSyncAt: '', attemptsToday: 0 },
      { now: at(2026, 11, 1), lastSyncAt: iso(2026, 11, 1, 8, 0), attemptsToday: 0 },
      { now: at(2026, 11, 1), lastSyncAt: '', attemptsToday: 3 },
    ]) {
      expect(decideAutoSync(input).reason.trim().length).toBeGreaterThan(0);
    }
  });
});

describe('autoSyncNotice — 三种通知（T5-5）', () => {
  it('**抓 0 条但总数 > 0** → zero 告警，且排在"失败"之前判（红线 1）', () => {
    const n = autoSyncNotice({ ok: false, fetched: 0, totalItems: 12, warnings: ['芒果同步未取到数据'] });
    expect(n.kind).toBe('zero');
    expect(n.title).toContain('12');
    // 不能退化成"同步失败（原因：…）"：那样用户会以为是网络问题，而真正的原因是登录/筛选
    expect(n.title).not.toContain('失败');
    expect(n.body).toContain('登录');
  });

  it('真失败（ok:false 且总数也是 0）→ failure，并带出第一条原因', () => {
    const n = autoSyncNotice({ ok: false, fetched: 0, totalItems: 0, warnings: ['没有取到数据'] });
    expect(n.kind).toBe('failure');
    expect(n.body).toBe('没有取到数据');
  });

  it('失败且没有任何 warning → 也给一句人话（不许空 body）', () => {
    const n = autoSyncNotice({ ok: false });
    expect(n.kind).toBe('failure');
    expect(n.body.trim().length).toBeGreaterThan(0);
  });

  it('芒果明确回"共 0 单" → success + "今天没有待发货"（这才是真没单）', () => {
    const n = autoSyncNotice({ ok: true, fetched: 0, totalItems: 0 });
    expect(n.kind).toBe('success');
    expect(n.title).toContain('没有待发货');
  });

  it('成功 → 带出抓取/新增/更新三个数', () => {
    const n = autoSyncNotice({ ok: true, fetched: 3, totalItems: 3, inserted: 2, updated: 1 });
    expect(n.kind).toBe('success');
    expect(n.title).toContain('3');
    expect(n.title).toContain('新增 2');
    expect(n.title).toContain('更新 1');
  });

  it('成功但有瑕疵 → body 逐条说清（未入库 / 缺图 / 没认到店 / 没抓全）', () => {
    const n = autoSyncNotice({
      ok: true,
      fetched: 5,
      totalItems: 6,
      inserted: 4,
      updated: 1,
      skipped: 1,
      missingImage: 2,
      shopUnmatched: 1,
      partial: true,
    });
    expect(n.kind).toBe('success');
    expect(n.body).toContain('1 单未入库');
    expect(n.body).toContain('2 行没取到图');
    expect(n.body).toContain('1 单没认到店');
    expect(n.body).toContain('没抓全');
  });

  it('脏输入（负数 / 字符串 / undefined）按 0 处理，不抛错', () => {
    expect(() => autoSyncNotice({})).not.toThrow();
    expect(autoSyncNotice({ fetched: -3, totalItems: '8' as unknown as number }).kind).toBe('zero');
    const n = autoSyncNotice({ ok: true, fetched: -1, totalItems: 0, inserted: -9 });
    expect(n.kind).toBe('success');
  });
});

describe('shouldStartHidden — 开机自启不许弹窗（T5-2）', () => {
  it('认 `--hidden`（Windows 自启项里写的就是它）', () => {
    expect(shouldStartHidden(['/Applications/SellerKit.app/Contents/MacOS/SellerKit', '--hidden'])).toBe(true);
    expect(shouldStartHidden(['SellerKit.exe', ' --hidden '])).toBe(true);
  });

  it('没有标记 → 正常显示窗口（手动双击图标时要能看到界面）', () => {
    expect(shouldStartHidden(['SellerKit'])).toBe(false);
    expect(shouldStartHidden([])).toBe(false);
  });

  it('不做模糊匹配：`hidden` / `--hidden=1` 都不算（避免"用户传了别的参数就被藏起来"）', () => {
    expect(shouldStartHidden(['hidden'])).toBe(false);
    expect(shouldStartHidden(['--hidden=1'])).toBe(false);
  });

  it('脏输入（null / 非数组）不抛错', () => {
    expect(() => shouldStartHidden(null as unknown as string[])).not.toThrow();
    expect(shouldStartHidden(null as unknown as string[])).toBe(false);
  });
});

describe('常量与扩展侧同源', () => {
  it('一天最多 3 次补跑；网络等 60s、重试 3 次、间隔 20s', () => {
    expect(MAX_AUTO_SYNC_PER_DAY).toBe(3);
    expect(NETWORK_WAIT_MS).toBe(60_000);
    expect(NETWORK_TRIES).toBe(3);
    expect(NETWORK_RETRY_GAP_MS).toBe(20_000);
    expect(NETWORK_TRIES * NETWORK_RETRY_GAP_MS).toBe(NETWORK_WAIT_MS);
  });

  it('待发货 URL 与扩展 background.js 的 ORDER_LIST_URL 同源（改动要两边一起改）', () => {
    // 扩展侧常量：SellerKitExtensions/extensions/mango-order/src/background.js
    expect(MANGO_ORDER_LIST_URL).toBe(
      'https://www.mangoerp.com/erp/#/erp/order/list/search/status/正常/normal',
    );
  });

  it('等推送的上限是分钟级（不是秒级：扩展打开页面本身就要几秒）', () => {
    expect(INGEST_WAIT_MS).toBeGreaterThanOrEqual(60_000);
    expect(INGEST_WAIT_MS).toBeLessThanOrEqual(15 * 60_000);
  });
});
