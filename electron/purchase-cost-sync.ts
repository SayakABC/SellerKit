// electron/purchase-cost-sync.ts
// **拿货落账 → 订单行实际进价**（C2 定稿，2026-10-21）。
//
// 订单明细行有两个成本字段（见 `docs/archive/plans/ORDER_PURCHASE_MODEL_SIMPLIFY_PLAN.md` §5）：
//   · `cost_cents` = **进价（预估）**，归类核对「确认无误」时按当时产品当前价钉（`order-db.snapshotOrderCosts`）；
//   · `actual_cost_cents` = **实际进价（实付真值）**，就是本函数写的那一列。
// 利润取数 `实际 > 预估 > 缺`，所以拿货实付永远压过估算。
//
// 为什么跨域编排放在这一层：这是**拿货域产出 → 订单域消费**（两个 `*-db` 都不该认识对方的写路径，
// ADR-002 C1/C3）；编排收在主进程这一层，界面与岛都不参与。
// 旧版还会把同一批价写成 `ae_cost_map` 的区间行（`syncPurchaseCosts`）—— C2 已把写口与那张表
// 一并移除：成本的真源只剩「产品当前价 + 订单行两字段」，不再有第二张表。
//
// ⚠️ 回写的三条边界（缺一条就会改坏历史利润）：
//   ① **只写 `actual_cost_cents IS NULL` 的行** —— 同一行被后一次拿货"重新定价"，等于改了它的历史利润；
//   ② **按拿货日期升序、先到先得** —— 订单先来、拿货后到，覆盖它的应该是**第一次**为它付的钱；
//   ③ 只认**有身份**的明细（`purchase_items.style_color_id > 0`）：老明细只有文本色名，
//      拿文本去配订单行会在改名后静默错配（本项目最贵的一类失效）。

export {};

import { dbQuery, dbRun, dbTransaction, tableExists } from './db';

/**
 * 拿货落账 → **订单行实际进价**（`oi_order_items.actual_cost_cents`）。
 *
 * @returns 本次真正补上价的订单行数（0 = 没有新行需要补，不是错误）
 */
export function syncOrderRowCosts(): { rows: number } {
  if (!tableExists('oi_orders') || !tableExists('purchase_items')) return { rows: 0 };

  // 拿货明细按「身份（款色 id）+ 尺码」取价；`biz_date` 升序 = 先到先得（见文件头 ②）
  const items = dbQuery<Record<string, unknown>>(
    `SELECT pi.style_color_id AS sc_id, pi.size AS size, pi.price_cents AS price_cents
       FROM purchase_items pi
       JOIN purchase_orders po ON po.id = pi.purchase_id
      WHERE po.status = 'submitted'
        AND pi.qty > 0
        AND pi.price_cents > 0
        AND pi.style_color_id > 0
      ORDER BY po.biz_date ASC, pi.id ASC`,
  );
  if (!items.length) return { rows: 0 };

  // 同一 (款色, 尺码) 只留**最早**那条价（后面的不参与 —— 见 ②）
  const firstPrice = new Map<string, number>();
  for (const r of items) {
    const scId = Number(r.sc_id) || 0;
    const size = String(r.size ?? '');
    const price = Number(r.price_cents) || 0;
    if (!scId || price <= 0) continue;
    const key = `${scId}\u0000${size}`;
    if (!firstPrice.has(key)) firstPrice.set(key, price);
  }
  if (!firstPrice.size) return { rows: 0 };

  let rows = 0;
  dbTransaction(() => {
    for (const [key, price] of firstPrice) {
      const [scIdText, size] = key.split('\u0000');
      // ① 只补空：已写过的行不动（它们记的是当时那笔钱）
      const info = dbRun(
        `UPDATE oi_order_items SET actual_cost_cents = ?
          WHERE actual_cost_cents IS NULL AND style_color_id = ? AND size = ?`,
        [price, Number(scIdText) || 0, size],
      );
      rows += info.changes;
    }
  });
  return { rows };
}
