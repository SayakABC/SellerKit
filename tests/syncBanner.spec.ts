import { describe, expect, it } from 'vitest';
import { isNeverSynced, syncBanner, type SyncBannerInput } from '../src/lib/syncBanner';
import { localDayKey } from '../src/lib/localDay';

const NOW = new Date();
const TODAY_ISO = new Date(NOW.getFullYear(), NOW.getMonth(), NOW.getDate(), 9, 12, 0).toISOString();

/** 一条正常的同步记录 */
function ok(p: Partial<SyncBannerInput['last']> = {}) {
  return {
    at: TODAY_ISO,
    fetched: 3,
    totalItems: 3,
    inserted: 2,
    updated: 1,
    skipped: 0,
    missingImage: 0,
    shopUnmatched: 0,
    partial: false,
    reason: '',
    ...p,
  };
}

describe('syncBanner · 采集状态条文案与配色（T2-3）', () => {
  it('正常态：时间 + 抓了几条 + 入库几条，染 ok', () => {
    const v = syncBanner({ last: ok(), error: '' });
    expect(v.tone).toBe('ok');
    expect(v.text).toContain('抓 3 条');
    // 入库 = inserted + updated（"这次落了几单"，不是只有新插入的）
    expect(v.text).toContain('入库 3');
    expect(v.partial).toBe(false);
  });

  it('时间按**本地时区**显示成「今天 HH:mm」（不是 UTC 的 slice）', () => {
    const v = syncBanner({ last: ok(), error: '' });
    // 取**记录自己的**本地时分（不是"现在"的时分 —— 夹具是今天 09:12）
    const d = new Date(TODAY_ISO);
    const hh = String(d.getHours()).padStart(2, '0');
    const mm = String(d.getMinutes()).padStart(2, '0');
    expect(v.text).toContain(`今天 ${hh}:${mm}`);
    // 若实现按 UTC 取 `slice(11,16)`，东八区下会差 8 小时。只在两者确实不同的时区里断言，
    // 免得 CI 跑在 UTC 上时这条恒绿（恒绿也就算了，但它不该在非 UTC 机器上漏过去）。
    const uh = String(d.getUTCHours()).padStart(2, '0');
    if (uh !== hh) expect(v.text).not.toContain(`今天 ${uh}:`);
  });

  it('跨天要带日期（全天都写"今天"是假话：昨天同步的会被当成刚抓的）', () => {
    const y = new Date();
    y.setDate(y.getDate() - 1);
    const v = syncBanner({ last: ok({ at: y.toISOString() }), error: '' });
    expect(v.text).not.toContain('今天');
    expect(v.text).toContain(`${String(y.getMonth() + 1).padStart(2, '0')}-${String(y.getDate()).padStart(2, '0')}`);
  });

  it('同步失败：**原样**给出 reason（不许翻译成"同步异常"），染 error', () => {
    const reason = '芒果说共 12 单，但一单都没抓到（登录过期 / 没停在待发货筛选 / 扩展未生效）';
    const v = syncBanner({ last: ok({ fetched: 0, inserted: 0, updated: 0, reason }), error: '' });
    expect(v.tone).toBe('error');
    expect(v.text).toContain(reason);
    expect(v.text).toContain('同步失败');
  });

  it('失败态绝不说成"今天没单"（那正是这个功能要消灭的歧义）', () => {
    const v = syncBanner({ last: ok({ fetched: 0, reason: '芒果说共 12 单，但一单都没抓到' }), error: '' });
    expect(v.text).not.toContain('没有订单');
    expect(v.text).not.toContain('没单');
  });

  it('从没同步过：说"还没同步过"并给出开始的地方，染 idle（不是红）', () => {
    const v = syncBanner({ last: null, error: '' });
    expect(v.tone).toBe('idle');
    expect(v.text).toContain('还没同步过');
    expect(v.text).toContain('芒果店长');
  });

  it('读不到日志 ≠ 没同步过：优先说"读不到"，染 error', () => {
    const v = syncBanner({ last: null, error: '日志表读不出来' });
    expect(v.tone).toBe('error');
    expect(v.text).toContain('读不到同步状态');
    expect(v.text).toContain('日志表读不出来');
    // 最关键：不许退化成"还没同步过"
    expect(v.text).not.toContain('还没同步过');
  });

  it('读不到日志的优先级**高于**有没有 last（有旧数据也不能说"正常"）', () => {
    const v = syncBanner({ last: ok(), error: 'boom' });
    expect(v.tone).toBe('error');
    expect(v.text).toContain('读不到');
  });

  it('抓取被截断：染 warn 并带 partial 标记（能用但不全，不是失败）', () => {
    const v = syncBanner({ last: ok({ partial: true }), error: '' });
    expect(v.tone).toBe('warn');
    expect(v.partial).toBe(true);
    expect(v.text).toContain('抓 3 条');
  });

  it('跳过 / 缺图 / 没认到店：有值才说，为 0 不占篇幅', () => {
    const quiet = syncBanner({ last: ok(), error: '' });
    expect(quiet.text).not.toContain('跳过');
    expect(quiet.text).not.toContain('没图');
    expect(quiet.text).not.toContain('没认到店');

    const loud = syncBanner({
      last: ok({ skipped: 2, missingImage: 5, shopUnmatched: 1 }),
      error: '',
    });
    expect(loud.text).toContain('跳过 2');
    expect(loud.text).toContain('5 行没图');
    expect(loud.text).toContain('1 单没认到店');
  });

  it('脏值 / 空输入不抛错，也不显示 NaN', () => {
    expect(syncBanner(null).tone).toBe('idle');
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    const v = syncBanner({ last: { at: 'not-a-date', fetched: NaN, inserted: undefined } as any, error: '' });
    expect(v.text).not.toContain('NaN');
    expect(v.text).not.toContain('undefined');
  });

  it('`at` 认不出时不显示时间前缀（而不是显示 Invalid Date）', () => {
    const v = syncBanner({ last: ok({ at: '乱写' }), error: '' });
    expect(v.text).not.toContain('Invalid');
    expect(v.text.startsWith('抓 ')).toBe(true);
  });

  it('`localDayKey` 与状态条同口径（今天 = 本机今天，不是 UTC 的今天）', () => {
    // 这条守的是"两处对'今天'的判断不能分叉"：分叉时状态条会在跨天那几个小时里说错话
    const v = syncBanner({ last: ok(), error: '' });
    expect(v.text).toContain('今天');
    expect(localDayKey(new Date(TODAY_ISO))).toBe(localDayKey(new Date()));
  });
});

describe('isNeverSynced · 空态用的判据（T2-5）', () => {
  it('真的没同步过 ⇒ true（这是唯一该给"去芒果采集"出口的形态）', () => {
    expect(isNeverSynced({ last: null, error: '' })).toBe(true);
    expect(isNeverSynced(null)).toBe(true);
    expect(isNeverSynced(undefined)).toBe(true);
  });

  it('**读不到日志 ≠ 没同步过**：这是两种不同的处境，做的事也不同', () => {
    // 日志表坏了的时候说"还没同步过"是假话，而且会让人白做一遍同步
    expect(isNeverSynced({ last: null, error: '日志表读不出来' })).toBe(false);
    expect(isNeverSynced({ last: null, error: 'x' })).toBe(false);
  });

  it('同步过（哪怕抓 0 条）⇒ false：那说明芒果那边真是空的，不是"没开始"', () => {
    expect(isNeverSynced({ last: ok({ fetched: 0, totalItems: 0 }), error: '' })).toBe(false);
  });
});
