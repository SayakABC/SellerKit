// electron/ship-rate-handlers.ts
// 「运价表快照」渲染层 IPC（语义化通道）。
//
// 通道列表：
//   ship-rate-snapshot-save   导入报价单时落一份快照（按内容去重）
//   ship-rate-snapshot-list   快照列表（不含整张表）
//   ship-rate-snapshot-calc   算账用：含 payload 的快照集合（按生效日倒序）
//
// 为什么写在宿主：运价表是**主数据**，必须挂中立层（ADR-002 C3）——存在可卸载的岛私有 storage 里，
// 任何跨域算运费都够不到；而且"只留当前一份"会让历史订单的预测值随报价单更新而变（不可复算）。
// 入参在 preload 层已做形状消毒，本层再做一次业务口径校验（双防线）。

export {};

import {
  ensureShipRateSchema,
  listRateSnapshots,
  rateSnapshotsForCalc,
  saveRateSnapshot,
} from './ship-rate-db';
import { handle } from './ipc-util';

const MAX = {
  sourceFile: 500,
  sheetName: 200,
  limit: 200,
  /** 整张运价表的 JSON 上限（防超大载荷灌进主进程内存；正常报价单归一化后远小于此） */
  payloadChars: 2_000_000,
} as const;

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max) : '';
}

handle('ship-rate-snapshot-save', (payload: any) => {
  ensureShipRateSchema();
  const payloadText = JSON.stringify(payload?.table ?? null);
  if (payloadText.length > MAX.payloadChars) {
    throw new Error(
      `ship-rate-snapshot-save: 运价表过大（${payloadText.length} 字符 > ${MAX.payloadChars}）`,
    );
  }
  return saveRateSnapshot({
    table: payload?.table,
    sourceFile: str(payload?.sourceFile, MAX.sourceFile),
    sheetName: str(payload?.sheetName, MAX.sheetName),
    effectiveFrom: str(payload?.effectiveFrom, 10),
  });
});

handle('ship-rate-snapshot-list', (payload: any) => {
  ensureShipRateSchema();
  return { rows: listRateSnapshots(Number(payload?.limit) || 50) };
});

handle('ship-rate-snapshot-calc', (payload: any) => {
  ensureShipRateSchema();
  return { rows: rateSnapshotsForCalc(Number(payload?.limit) || 50) };
});