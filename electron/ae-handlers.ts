// electron/ae-handlers.ts
// 「速卖通利润追踪」渲染层 IPC（语义化查询通道）。
// 入站数据不经过 IPC（走 ae-receiver.ts localhost）；本文件只暴露：
//   ae-db-ensure        幂等建表（视图首次激活时调用）
//   ae-order-list       订单明细（分页 + 关键字）
//   ae-summary          汇总（分币种，收入/费用分列）
//   ae-receiver-status  接收端运行状态（端口 / 最近入库 / 错误）
// 入参在 preload 层已做形状消毒，本层再做一次业务口径校验（双防线）。

export {};

import { ipcMain } from 'electron';
import { ensureAeSchema, listOrders, getAeSummary } from './ae-db';
import { getAeReceiverStatus } from './ae-receiver';

function handle<T>(channel: string, fn: (payload: any) => T): void {
  ipcMain.handle(channel, (_e: any, payload: any) => {
    try {
      const data = fn(payload);
      return { success: true, data };
    } catch (err: any) {
      return { success: false, error: err.message || '未知错误' };
    }
  });
}

handle('ae-db-ensure', () => {
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
