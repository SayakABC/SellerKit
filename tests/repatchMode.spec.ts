import { describe, it, expect } from 'vitest';
import {
  isRepatchModeAvailable,
  preferredRepatchMode,
  repatchModeBlockedReason,
  type RepatchModeChoice,
} from '../src/modules/ledger/repatchMode';
import type { LedgerRepatchMode } from '../src/types';

/** 预览里与"选哪条路"有关的三个字段（其余字段不影响判定） */
const previewOf = (over: {
  recommended?: LedgerRepatchMode;
  settledCount?: number;
  unsettledCount?: number;
}): { recommended: LedgerRepatchMode; settledCount: number; unsettledCount: number } => ({
  recommended: 'move-all',
  settledCount: 0,
  unsettledCount: 0,
  ...over,
});

describe('变更相关人：默认停在哪条路上', () => {
  it('全已结算 → **不预选**（绝不自动落到"撤销结算后改挂"）', () => {
    // 后端 recommended 在这种场景是 move-unsettled，但它要求 unsettledCount > 0 而不成立
    const choice: RepatchModeChoice = preferredRepatchMode(
      previewOf({ recommended: 'move-unsettled', settledCount: 5, unsettledCount: 0 })
    );
    expect(choice).toBe('');
  });

  it('全未结算 → 直接改挂', () => {
    expect(preferredRepatchMode(previewOf({ recommended: 'move-all', settledCount: 0, unsettledCount: 7 }))).toBe(
      'move-all'
    );
  });

  it('混合 → 只改挂未结算（不动已结算、不写结转）', () => {
    expect(
      preferredRepatchMode(previewOf({ recommended: 'move-unsettled', settledCount: 5, unsettledCount: 7 }))
    ).toBe('move-unsettled');
  });

  it('后端明确推荐 C 时才用 C（那是用户已经在别的入口点过"撤销结算"的场景）', () => {
    expect(
      preferredRepatchMode(previewOf({ recommended: 'void-then-move', settledCount: 2, unsettledCount: 0 }))
    ).toBe('void-then-move');
  });
});

describe('变更相关人：每条路可用性', () => {
  const none = previewOf({ settledCount: 0, unsettledCount: 0 });
  const allUnsettled = previewOf({ settledCount: 0, unsettledCount: 3 });
  const mixed = previewOf({ settledCount: 2, unsettledCount: 3 });
  const allSettled = previewOf({ settledCount: 2, unsettledCount: 0 });

  it('直接改挂：只在"全未结算且有条目"时可用', () => {
    expect(isRepatchModeAvailable('move-all', none)).toBe(false);
    expect(isRepatchModeAvailable('move-all', allUnsettled)).toBe(true);
    expect(isRepatchModeAvailable('move-all', mixed)).toBe(false);
    expect(isRepatchModeAvailable('move-all', allSettled)).toBe(false);
  });

  it('只改挂未结算：必须"两类都有"', () => {
    expect(isRepatchModeAvailable('move-unsettled', allUnsettled)).toBe(false);
    expect(isRepatchModeAvailable('move-unsettled', mixed)).toBe(true);
    expect(isRepatchModeAvailable('move-unsettled', allSettled)).toBe(false);
  });

  it('撤销后改挂：含已结算就"能"用（但永不作为默认）', () => {
    expect(isRepatchModeAvailable('void-then-move', mixed)).toBe(true);
    expect(isRepatchModeAvailable('void-then-move', allSettled)).toBe(true);
    expect(isRepatchModeAvailable('void-then-move', allUnsettled)).toBe(false);
  });

  it('不可用时给的是"为什么"，不是"不可用"三个字', () => {
    expect(repatchModeBlockedReason('move-unsettled', allUnsettled)).toContain('直接改挂');
    expect(repatchModeBlockedReason('void-then-move', allUnsettled)).toContain('无需撤销');
    expect(repatchModeBlockedReason('move-unsettled', allSettled)).toContain('全部已结算');
    expect(repatchModeBlockedReason('void-then-move', mixed)).toBe('');
  });
});
