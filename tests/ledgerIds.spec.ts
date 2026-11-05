import { describe, it, expect } from 'vitest';
import { LEDGER_BATCH_ID_LIMIT, normalizeIdList } from '../electron/ledger-ids';

describe('批量 id 消毒（结算 / 改挂共用）', () => {
  it('去重、只留正整数、非数组给空', () => {
    expect(normalizeIdList([3, 3, '5', 0, -1, 'x', null])).toEqual([3, 5]);
    expect(normalizeIdList(undefined)).toEqual([]);
    expect(normalizeIdList('3,4')).toEqual([]);
  });

  it('刚好到上限仍可用（2000 条是列表能给出的上限）', () => {
    const ids = Array.from({ length: LEDGER_BATCH_ID_LIMIT }, (_, i) => i + 1);
    expect(normalizeIdList(ids)).toHaveLength(LEDGER_BATCH_ID_LIMIT);
  });

  it('超过上限**抛错**（旧实现静默只处理前 500 条，用户以为改完了）', () => {
    const ids = Array.from({ length: LEDGER_BATCH_ID_LIMIT + 1 }, (_, i) => i + 1);
    expect(() => normalizeIdList(ids)).toThrow(/一次最多处理 2000 条/);
    expect(() => normalizeIdList(ids)).toThrow(/2001 条/);
  });

  it('去重后才判上限：重复 id 不应把用户挡在门外', () => {
    const one = Array.from({ length: LEDGER_BATCH_ID_LIMIT }, (_, i) => i + 1);
    expect(normalizeIdList([...one, ...one])).toHaveLength(LEDGER_BATCH_ID_LIMIT);
  });
});
