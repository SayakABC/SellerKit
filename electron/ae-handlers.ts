// electron/ae-handlers.ts
// 「速卖通利润追踪」渲染层 IPC（语义化查询通道）。
// 入站数据不经过 IPC（走 ae-receiver.ts localhost）；本文件只暴露：
//   ae-db-ensure        幂等建表（视图首次激活时调用）
//   ae-order-list       订单明细（分页 + 关键字）
//   ae-summary          汇总（分币种，收入/费用分列）
//   ae-receiver-status  接收端运行状态（端口 / 最近入库 / 错误）
//   ae-profit-stats     M1 利润引擎总览（趋势 / TOP / 费用构成 / 覆盖率）
//   ae-cost-map-*       M1 成本快照（D3：全量替换 / 列表）；P4 起另有手工进价的 upsert / delete
//   ae-rate-*           M1 汇率维护（列表 / upsert）
//   settle-import       结算明细落库（AE 后台「订单明细」导出 → 解析在渲染层，本层只归一+存）
//   settle-orders       按订单号取结算汇总（利润页"精准轨"用）
//   settle-stats        结算明细概览（导入结果/诊断展示）
// 入参在 preload 层已做形状消毒，本层再做一次业务口径校验（双防线）。

export {};

import {
  ensureAeSchema,
  listOrders,
  getAeSummary,
  costMapReplace,
  costMapList,
  costMapDeleteManual,
  upsertSettleLines,
  settleOrders,
  settleStats,
  rateList,
  rateUpsert,
} from './ae-db';
// 手工进价的写入口径（与产品导入的「进价」列共用同一份；见该文件头）
import { applyManualCosts } from './manual-costs';
import { getProfitOverview } from './ae-engine';
import { getAeReceiverStatus } from './ae-receiver';
import { handle } from './ipc-util';

handle('ae-db-ensure', (): null => {
  ensureAeSchema();
  return null;
});

handle('ae-order-list', (payload: any) => {
  const p = payload ?? {};
  const offset = typeof p.offset === 'number' && Number.isFinite(p.offset) ? Math.max(Math.round(p.offset), 0) : 0;
  const limit = typeof p.limit === 'number' && Number.isFinite(p.limit) ? Math.min(Math.max(Math.round(p.limit), 1), 2000) : 200;
  const search = typeof p.search === 'string' ? p.search.slice(0, 100) : '';
  return listOrders({ offset, limit, search });
});

handle('ae-summary', () => {
  ensureAeSchema();
  return getAeSummary();
});

handle('ae-receiver-status', () => getAeReceiverStatus());

handle('ae-profit-stats', (payload: any) => {
  const p = payload ?? {};
  return getProfitOverview({
    granularity: p.granularity === 'day' ? 'day' : 'month',
    rangeDays: typeof p.rangeDays === 'number' && Number.isFinite(p.rangeDays) ? p.rangeDays : 90,
  });
});

handle('ae-cost-map-import', (payload: any) => {
  // 全量替换：items 来自 purchase-cost-snapshot 只读导出；此处仅做形状校验后交数据层
  if (!payload || !Array.isArray(payload.items)) return { replaced: 0 };
  const items = payload.items
    .filter((it: any) => it && typeof it === 'object' && typeof it.styleCode === 'string' && it.styleCode)
    .slice(0, 20000)
    .map((it: any) => ({
      styleCode: it.styleCode,
      styleName: typeof it.styleName === 'string' ? it.styleName : '',
      unitPriceCents: Number.isFinite(Number(it.unitPriceCents)) ? Math.max(0, Math.round(Number(it.unitPriceCents))) : 0,
      sampleCount: Number.isFinite(Number(it.sampleCount)) ? Math.max(0, Math.round(Number(it.sampleCount))) : 0,
      lastBizDate: typeof it.lastBizDate === 'string' ? it.lastBizDate : '',
    }));
  return costMapReplace(items);
});

handle('ae-cost-map-list', () => {
  ensureAeSchema();
  return costMapList();
});

// ---- 手工进价（P4 成本维护界面；写入口径与产品导入的「进价」列共用 `manual-costs.ts`）----

/** 单次写入上限（界面逐款录入，给足余量但不放任大 payload） */
const MAX_MANUAL_COST_ROWS = 2000;

/**
 * 手工录入 / 修改进价（`source='manual'`）。
 *
 * ⚠️ **不会**回落 `COST_LEGACY_FROM`（`0000-01-01`）：缺省生效日 = 当天。回落 legacy 会把该款
 * **全部历史订单**的成本一起改掉。补录历史价请显式传 `effectiveFrom`。
 */
handle('ae-cost-map-upsert-manual', (payload: any) => {
  ensureAeSchema();
  const rows = Array.isArray(payload?.items) ? payload.items : [];
  if (rows.length > MAX_MANUAL_COST_ROWS) {
    throw new Error(
      `ae-cost-map-upsert-manual: 单次最多 ${MAX_MANUAL_COST_ROWS} 条（收到 ${rows.length}）`,
    );
  }
  const items = rows
    .filter(
      (it: any) => it && typeof it === 'object' && typeof it.styleCode === 'string' && it.styleCode.trim(),
    )
    .map((it: any) => ({
      code: String(it.styleCode).trim().slice(0, 64),
      name: typeof it.styleName === 'string' ? it.styleName.slice(0, 200) : '',
      costCents: Number(it.unitPriceCents),
      effectiveFrom: typeof it.effectiveFrom === 'string' ? it.effectiveFrom.slice(0, 40) : '',
    }));
  return applyManualCosts(items, String(payload?.effectiveFrom ?? ''));
});

/**
 * 删除手工进价区间（只删 `manual`；`purchase` 行删了下次对账同步会原样回来）。
 * 删掉后读取侧回落到更早的区间 —— 界面负责把这句话说给用户。
 */
handle('ae-cost-map-delete-manual', (payload: any) => {
  ensureAeSchema();
  const keys = Array.isArray(payload?.keys) ? payload.keys : [];
  if (keys.length > MAX_MANUAL_COST_ROWS) {
    throw new Error(
      `ae-cost-map-delete-manual: 单次最多 ${MAX_MANUAL_COST_ROWS} 条（收到 ${keys.length}）`,
    );
  }
  return costMapDeleteManual(
    keys.map((k: any) => ({
      styleCode: String(k?.styleCode ?? ''),
      effectiveFrom: String(k?.effectiveFrom ?? ''),
    })),
  );
});

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
