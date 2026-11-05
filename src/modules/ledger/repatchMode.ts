import type { LedgerRepatchMode, LedgerRepatchPreview } from '@/types';

/**
 * 三条改挂路径中，哪几条**当前可用**（判据只看选中条目的结算状态，不猜别的）。
 *
 * 放在组件外是为了能被单测直接打：这里错了的后果是"默认停在唯一会作废结算单的那条路上"，
 * 而不是样式错位 —— 必须有一条会红的守卫（审查 P1-6）。
 */
export function isRepatchModeAvailable(
  mode: LedgerRepatchMode,
  p: Pick<LedgerRepatchPreview, 'settledCount' | 'unsettledCount'>
): boolean {
  if (mode === 'move-all') return p.settledCount === 0 && p.unsettledCount > 0;
  if (mode === 'move-unsettled') return p.settledCount > 0 && p.unsettledCount > 0;
  // void-then-move：只要含已结算就"能"用，但它会作废结算单，**永不作为默认值**
  return p.settledCount > 0;
}

/** 空串 = 不预选，要求用户自己点一条（全已结算时正是这种情况） */
export type RepatchModeChoice = LedgerRepatchMode | '';

/**
 * 打开弹层时默认选哪条路。
 *
 * **兜底顺序里绝不能有 `void-then-move`**：全已结算时 `recommended` 是 `move-unsettled`，
 * 但它要求 `unsettledCount > 0` 而不成立，于是一路落到 C 路 —— 用户勾了 5 条已结算条目
 * 打开弹层，默认停在唯一会作废历史结算单的那条路上，而"推荐"标签还是空的（`recommended !== mode`），
 * 界面上没有任何"这条最危险"的暗示，填个原因点确认就作废了。后端注释明写「C 永远要用户主动选」。
 */
export function preferredRepatchMode(
  p: Pick<LedgerRepatchPreview, 'recommended' | 'settledCount' | 'unsettledCount'>
): RepatchModeChoice {
  const order: LedgerRepatchMode[] = [p.recommended, 'move-all', 'move-unsettled'];
  return order.find((m) => isRepatchModeAvailable(m, p)) ?? '';
}

/** 该路径为什么会不可用（写成用户能懂的一句话，不是"不可用"三个字） */
export function repatchModeBlockedReason(
  mode: LedgerRepatchMode,
  p: Pick<LedgerRepatchPreview, 'settledCount' | 'unsettledCount'>
): string {
  if (p.settledCount === 0) {
    return mode === 'move-unsettled'
      ? '所选条目全部未结算，直接用「直接改挂」即可'
      : '所选条目里没有已结算的，无需撤销';
  }
  if (p.unsettledCount === 0) return '所选条目全部已结算，没有可单独改挂的未结算条目';
  return '';
}
