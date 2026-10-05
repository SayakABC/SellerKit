// electron/picking-handlers.ts
// 「拣货」渲染层 IPC（语义化通道）。
//
// 通道列表：
//   picking-rows           未发货订单行投影（款色码 + 图 + 供应商 + 原始字段）→ 渲染层按 SKU 汇总
//   picking-export-excel   拣货单导出（**主进程 exceljs 生成，带图、按厂家分表**）→ 保存对话框
//
// 为什么聚合不在主进程做：件数要从 `raw_fields` 的「商品信息」块解析（`parseRowQty`）、
// 「关闭单不进拣货单」要按状态原文判定（`bucketOfStatus`）—— 两者都是渲染层纯函数层的**唯一实现**，
// 主进程再抄一份必然漂移（见 `electron/orderMoney.ts` 末尾的同一纪律）。
// 所以本通道只回**投影**（机械筛选 + 图），聚合与口径判定留在 `src/lib/picking.ts`（可被 vitest 覆盖）。
//
// 为什么导出**反过来**放在主进程：Excel 嵌图要 exceljs（渲染层打进 bundle 只为一个导出动作不值）
// 而且要写文件、弹保存对话框 —— 那是主进程的活。既有先例：`purchase-export-excel`（拿货单带图导出）。
// 但**业务口径一个都不搬**：渲染层把已算好的行（件数/进价/金额/缺口文案/已编码的图）传进来，
// 主进程只做"分行 → 画表 → 嵌图 → 存盘"，这样"导出的数"与"屏幕上的数"结构上不可能不一致。
//
// ⚠️ 图由**渲染层**编码成 JPEG 再传（不是主进程读文件）：真实订单图 8/9 是 WebP，而 Electron 的
// `nativeImage` 解不了 WebP ⇒ 主进程转不了码。渲染层（Chromium）能解 ⇒ 由它 canvas 转码。
// 顺带的好处：主进程不再按渲染层给的路径读任意本地文件（只有 `order-image-thumb` 那条白名单通道在读）。
//
// 入参在 preload 层已做形状消毒，本层再做一次业务口径校验（双防线）。

export {};

import { BrowserWindow, app, dialog } from 'electron';
import * as fs from 'fs';
import * as path from 'path';
import { ensureOrderSchema } from './order-db';
import { pickingRows } from './picking-db';
import { buildPickingWorkbook, type PickingExportImage, type PickingExportRow } from './picking-xlsx';
import { handle } from './ipc-util';

handle('picking-rows', (payload: any) => {
  ensureOrderSchema();
  if (payload !== undefined && payload !== null && typeof payload !== 'object') {
    throw new Error('picking-rows: payload 必须是对象');
  }
  return pickingRows({
    limit: payload?.limit,
    shop: payload?.shop,
    includeShipped: payload?.includeShipped,
  });
});

const str = (v: unknown, max = 60): string => String(v ?? '').slice(0, max);
const int = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.round(n) : 0;
};
/** 金额/单价：非有限数或负数 → `null`（**留空**，不是 0 —— 0 是"免费"，表里含义完全不同） */
const moneyOrNull = (v: unknown): number | null => {
  const n = Number(v);
  return v === null || v === undefined || !Number.isFinite(n) || n < 0 ? null : Math.round(n * 100) / 100;
};
/** 图：只收"纯 base64 + 尺寸"（长度上限防"塞一个巨大载荷进来"；长度不对/尺寸缺失一律当没图） */
const BASE64_MAX = 400_000;
const imageOf = (v: any): PickingExportImage | null => {
  if (!v || typeof v !== 'object') return null;
  const base64 = typeof v.base64 === 'string' ? v.base64 : '';
  if (!base64 || base64.length > BASE64_MAX || !/^[A-Za-z0-9+/]+={0,2}$/.test(base64.slice(0, 200))) return null;
  const width = int(v.width);
  const height = int(v.height);
  return width && height ? { base64, width, height } : null;
};

handle('picking-export-excel', async (payload: any) => {
  ensureOrderSchema();
  if (!payload || typeof payload !== 'object' || !Array.isArray(payload.rows)) {
    throw new Error('picking-export-excel: payload.rows 必须是数组');
  }
  const rows: PickingExportRow[] = payload.rows
    .slice(0, 500)
    .map((it: any) => ({
      supplierName: str(it?.supplierName, 100),
      styleCode: str(it?.styleCode),
      color: str(it?.color),
      size: str(it?.size, 20),
      pieces: int(it?.pieces),
      orders: int(it?.orders),
      unitPrice: moneyOrNull(it?.unitPrice),
      amount: moneyOrNull(it?.amount),
      gaps: str(it?.gaps, 200),
      image: imageOf(it?.image),
    }))
    .filter((it: PickingExportRow) => it.styleCode || it.color || it.size);
  if (!rows.length) throw new Error('没有可导出的行');

  const buffer = await buildPickingWorkbook(rows);
  const safe = str(payload?.defaultName, 120).replace(/[\\/:*?"<>|]/g, '_') || '拣货单';
  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const dialogOpts = {
    title: '导出拣货单（含图，按厂家分表）',
    defaultPath: path.join(app.getPath('documents'), `${safe}.xlsx`),
    filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
  };
  const result = win
    ? await dialog.showSaveDialog(win, dialogOpts)
    : await dialog.showSaveDialog(dialogOpts);
  if (result.canceled || !result.filePath) throw new Error('__canceled__');
  fs.writeFileSync(result.filePath, buffer);
  return { filePath: result.filePath, rows: rows.length, images: rows.filter((r) => r.image).length };
});