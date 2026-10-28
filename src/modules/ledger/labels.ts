// 记账域的中文标签（明细页 / 记一笔 / 两个管理弹层共用一份）。
//
// 为什么单拎出来：同一个 `kind` 在三处都要显示，各写一遍必然出现
// 「收入」「收」两种说法并存；而「收 / 支」这种数字边上的一字标签最容易被随手缩写。
import type { LedgerBasis } from '@/lib/ledger';
import type { LedgerKind, LedgerPartyKind, LedgerScope } from '@/types';

export const KIND_LABEL: Record<LedgerKind, string> = { income: '收入', expense: '支出' };

// 术语只此一份：界面不得再出现"专属 / 这家店"两种说法（审查 §5-1）。
// 表格里的标签要短（列宽固定），所以 `shared` 仍是「公共」；「公共（多店分摊）」只用在范围选择器上，
// 由 `EntryEditor` 自己写全称。
export const SCOPE_LABEL: Record<LedgerScope, string> = { shop: '本店', shared: '公共' };

export const PARTY_KIND_LABEL: Record<LedgerPartyKind, string> = {
  supplier: '供应商',
  staff: '员工',
  landlord: '房东',
  platform: '平台',
  other: '其他',
};

export const PARTY_KIND_OPTIONS: Array<{ value: LedgerPartyKind; label: string }> = [
  { value: 'supplier', label: PARTY_KIND_LABEL.supplier },
  { value: 'staff', label: PARTY_KIND_LABEL.staff },
  { value: 'landlord', label: PARTY_KIND_LABEL.landlord },
  { value: 'platform', label: PARTY_KIND_LABEL.platform },
  { value: 'other', label: PARTY_KIND_LABEL.other },
];

/** 三种分摊基准的显示名（记一笔 / 明细页 / 方案下拉共用一份） */
export const BASIS_LABEL: Record<LedgerBasis, string> = {
  equal: '平均分摊',
  revenue: '按营收占比',
  manual: '手工比例',
};

export const EXCLUDED_REASON_LABEL: Record<'not-open-yet' | 'inactive', string> = {
  'not-open-yet': '当月还没开店',
  // 退店（exited）**不在此列**：它照样参与分摊（收尾的房租/年费/税还要摊），见 `eligibleShops`
  inactive: '已停用 / 已封店',
};

/**
 * 结算方向（台账与弹层共用）。
 * `offset` = 互抵结清：一张单同时核销收入与支出，只发生差额资金流（可能为 0）。
 */
export const SETTLE_DIRECTION_LABEL: Record<'pay' | 'receive' | 'offset', string> = {
  pay: '我付给对方',
  receive: '对方付给我',
  offset: '互抵结清',
};
