// electron/purchase-cost-sync.ts
// **拿货落账 → 成本自动同步**（重构 S3 / M5 / E2）。
//
// 问题：成本的来源是「拿货对账」（`purchase-db.costSnapshot()`），但要用到算钱里，
// 得有人在利润页**手动点一次**「从拿货对账导入成本」—— 实测用户库里 `purchase_orders` 有 3 张、
// 而 `ae_cost_map` 是 **0 行**：货拿了、钱花了，利润里却没有成本（数字凭空变好看）。
//
// 做法：把"拿货快照 → `ae_cost_map`（source='purchase'）"的转换**收在宿主一处**，并在每次
// 拿货单/付款发生写操作后自动跑一遍。用户不再需要知道"还有个成本要同步"。
//
// 为什么是两个域在这里合流：这是**跨域编排**（拿货域产出 → 财务域消费），
// 两个 `*-db` 都不该认识对方（ADR-002 C1/C3）；编排放在主进程的这一层，界面与岛都不参与。
// 幂等：`costMapReplace` 只清 `source='purchase'` 再重写 —— 手工改过的价（`source='manual'`）不受影响。

export {};

import { costMapReplace } from './ae-db';
import { costSnapshot } from './purchase-db';

/** 拿货快照 → 成本表（`source='purchase'`）。幂等，可在每次拿货写操作后跑。 */
export function syncPurchaseCosts(): { replaced: number } {
  const items = costSnapshot().map((it) => ({
    styleCode: it.styleCode,
    styleName: it.styleName,
    unitPriceCents: it.weightedPriceCents,
    sampleCount: it.sampleCount,
    // 生效日 = 该行的拿货日期（成本按生效区间取，历史订单毛利可复算）
    effectiveFrom: it.lastBizDate,
    lastBizDate: it.lastBizDate,
  }));
  return costMapReplace(items);
}