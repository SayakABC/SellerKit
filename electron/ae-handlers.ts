// electron/ae-handlers.ts
// 「速卖通利润追踪」渲染层 IPC（语义化查询通道）。
// 入站数据不经过 IPC（走 ae-receiver.ts localhost）；本文件只暴露：
//   ae-db-ensure        幂等建表（视图首次激活时调用）
//   ae-order-list       订单明细（分页 + 关键字）
//   ae-summary          汇总（分币种，收入/费用分列）
//   ae-receiver-status  接收端运行状态（端口 / 最近入库 / 错误）
//   ae-profit-stats     M1 利润引擎总览（趋势 / TOP / 费用构成 / 覆盖率）
//   ae-cost-map-*       M1 成本快照（D3：全量替换 / 列表）
//   ae-rate-*           M1 汇率维护（列表 / upsert）
// 入参在 preload 层已做形状消毒，本层再做一次业务口径校验（双防线）。

export {};

import {
  ensureAeSchema,
  listOrders,
  getAeSummary,
  costMapReplace,
  costMapList,
  rateList,
  rateUpsert,
} from './ae-db';
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
