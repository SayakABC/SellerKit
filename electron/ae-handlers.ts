// electron/ae-handlers.ts
// 「速卖通订单采集」渲染层 IPC（语义化查询通道）。
// 入站数据不经过 IPC（走 ae-receiver.ts localhost）；本文件只暴露：
//   ae-db-ensure        幂等建表（视图首次激活时调用）
//   ae-receiver-status  接收端运行状态（端口 / 最近入库 / 错误）
//   ae-rate-*           M1 汇率维护（列表 / upsert）
//   settle-import       结算明细落库（AE 后台「订单明细」导出 → 解析在渲染层，本层只归一+存）
//   settle-orders       按订单号取结算汇总（利润页"精准轨"用）
//   settle-stats        结算明细概览（导入结果/诊断展示）
// 入参在 preload 层已做形状消毒，本层再做一次业务口径校验（双防线）。
//
// ⚠️ 2026-10-21（C2 删表）：`ae-cost-map-*` 四条通道随 `ae_cost_map` 退役一并删除 ——
//   成本真源改为产品行「当前进价」（`product-cost-set`）+ 订单明细行两字段。
// ⚠️ 2026-10-15 清理：原 `ae-order-list` / `ae-summary` / `ae-profit-stats` 三条通道随「订单明细 /
//   利润统计」页并入宿主「算钱」后已无消费者（C9 收编时岛侧 op 已删），其读取的 `ae_orders` /
//    `ae_order_lines` / `ae_fees` 是 C1 合并前遗留的孤儿表（采集入口早已改写 `oi_orders`）——
//   一并删除。利润口径在宿主「算钱」页由渲染层 `src/lib/orderCost.ts` 组合计算。

export {};

import {
  ensureAeSchema,
  upsertSettleLines,
  settleOrders,
  settleStats,
  rateList,
  rateUpsert,
} from './ae-db';
import { getAeReceiverStatus } from './ae-receiver';
import { handle } from './ipc-util';

handle('ae-db-ensure', (): null => {
  ensureAeSchema();
  return null;
});

handle('ae-receiver-status', () => getAeReceiverStatus());

handle('ae-rate-list', () => {
  ensureAeSchema();
  return rateList();
});

handle('ae-rate-upsert', (payload: any) => {
  const p = payload ?? {};
  const ccy = typeof p.fromCurrency === 'string' ? p.fromCurrency : '';
  const rate = Number(p.rateToCny);
  if (!ccy || !Number.isFinite(rate) || rate <= 0 || rate > 1e6) return { ok: false, error: '非法汇率入参' };
  ensureAeSchema();
  rateUpsert(ccy, rate);
  return { ok: true };
});

// ---- 「结算明细」（AE 后台导出的订单明细；解析在渲染层 *src/lib/settleImport.ts*）----

/** 单次导入上限（一个导出通常 ≤ 2000 行） */
const MAX_SETTLE_ROWS = 20000;

handle('settle-import', (payload: any) => {
  const rows = Array.isArray(payload?.rows) ? payload.rows : [];
  if (rows.length > MAX_SETTLE_ROWS) {
    throw new Error(`settle-import: 单次最多 ${MAX_SETTLE_ROWS} 行（收到 ${rows.length}）`);
  }
  return upsertSettleLines(rows);
});

handle('settle-orders', (payload: any) => {
  const orderNos = Array.isArray(payload?.orderNos) ? payload.orderNos : [];
  return { rows: settleOrders(orderNos) };
});

handle('settle-stats', () => settleStats());
