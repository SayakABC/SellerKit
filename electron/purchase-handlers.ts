// electron/purchase-handlers.ts
// 拿货对账模块（stock-in）IPC handler（electron/main.ts require 后自动生效）。
// 语义化通道 + 入参二次校验；不向渲染层透传 SQL（安全边界见 AGENTS.md §1.7 / 红线 3）。
// 职责：厂商 / 拿货单 / 付款 / 对账汇总 / 待拿货缺口 / 单价记忆。

export {};

const { ipcMain } = require('electron');
const purchaseDb = require('./purchase-db');

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

/** 注册语义化 handler：统一 try/catch 与错误返回结构 */
function register(
  channel: string,
  handler: (payload: any) => Promise<{ success: boolean; data?: any; error?: string }> | { success: boolean; data?: any; error?: string },
) {
  ipcMain.handle(channel, async (_e: any, payload: any) => {
    try {
      return await handler(payload);
    } catch (err: any) {
      return { success: false, error: err.message || 'Unknown error' };
    }
  });
}

const str = (v: unknown, max = 500) => String(v ?? '').slice(0, max);
const num = (v: unknown) => Math.max(0, Math.round(Number(v ?? 0)));
const dateStr = (v: unknown) => str(v, 10);

// 幂等建表（模块首次使用时调用）
register('purchase-db-ensure', async () => {
  purchaseDb.ensurePurchaseSchema();
  return { success: true };
});

// ---- 厂商 ----
register('purchase-supplier-list', async () => {
  purchaseDb.ensurePurchaseSchema();
  return { success: true, data: purchaseDb.listSuppliers() };
});

register('purchase-supplier-create', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.name !== 'string' || !payload.name.trim()) {
    return { success: false, error: '厂商名称不能为空' };
  }
  purchaseDb.ensurePurchaseSchema();
  const id = purchaseDb.createSupplier(str(payload.name, 50), str(payload.phone, 30), str(payload.note, 200));
  return { success: true, data: { id } };
});

register('purchase-supplier-update', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.id !== 'number' || !Number.isInteger(payload.id)) {
    return { success: false, error: 'invalid payload' };
  }
  purchaseDb.ensurePurchaseSchema();
  purchaseDb.updateSupplier(payload.id, str(payload.phone, 30), str(payload.note, 200));
  return { success: true };
});

register('purchase-supplier-delete', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.id !== 'number' || !Number.isInteger(payload.id)) {
    return { success: false, error: 'invalid payload' };
  }
  purchaseDb.ensurePurchaseSchema();
  purchaseDb.deleteSupplier(payload.id);
  return { success: true };
});

// ---- 拿货单 ----
register('purchase-order-list', async () => {
  purchaseDb.ensurePurchaseSchema();
  return { success: true, data: purchaseDb.listPurchaseOrders() };
});

register('purchase-order-get', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.id !== 'number' || !Number.isInteger(payload.id)) {
    return { success: false, error: 'invalid payload' };
  }
  purchaseDb.ensurePurchaseSchema();
  const order = purchaseDb.getPurchaseOrder(payload.id);
  if (!order) return { success: false, error: '拿货单不存在' };
  return { success: true, data: order };
});

register('purchase-order-create', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.supplierId !== 'number' || !Number.isInteger(payload.supplierId)) {
    return { success: false, error: 'invalid payload' };
  }
  purchaseDb.ensurePurchaseSchema();
  const mode = payload.mode === 'package' ? 'package' : 'detail';
  const items = sanitizeItems(payload.items);
  const sources = sanitizeSources(payload.sources);
  const id = purchaseDb.createPurchaseOrder({
    supplierId: payload.supplierId,
    bizDate: dateStr(payload.bizDate),
    mode,
    note: str(payload.note, 500),
    totalCents: num(payload.totalCents),
    items,
    sources,
  });
  return { success: true, data: { id } };
});

/** 明细行清洗：尺码透传，其余字段长度/数值约束 */
function sanitizeItems(items: unknown) {
  if (!Array.isArray(items)) return [];
  return items
    .filter((it: any) => isPlainObject(it) && typeof it.styleCode === 'string' && it.styleCode.trim())
    .map((it: any) => ({
      styleCode: str(it.styleCode, 50),
      styleName: str(it.styleName, 100),
      color: str(it.color, 50),
      size: str(it.size, 50),
      qty: num(it.qty),
      priceCents: num(it.priceCents),
      suggestionQty: num(it.suggestionQty),
    }))
    .slice(0, 500);
}

/** 来源订单快照行清洗 */
function sanitizeSources(sources: unknown) {
  if (!Array.isArray(sources)) return [];
  return sources
    .filter((s: any) => isPlainObject(s) && typeof s.styleCode === 'string' && s.styleCode.trim())
    .map((s: any) => ({
      shop: str(s.shop, 100),
      styleCode: str(s.styleCode, 50),
      styleName: str(s.styleName, 100),
      color: str(s.color, 50),
      size: str(s.size, 50),
      qty: Math.max(1, Math.round(num(s.qty))),
    }))
    .slice(0, 100000);
}

register('purchase-order-update', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.id !== 'number' || !Number.isInteger(payload.id)) {
    return { success: false, error: 'invalid payload' };
  }
  purchaseDb.ensurePurchaseSchema();
  const items = Array.isArray(payload.items) ? sanitizeItems(payload.items) : undefined;
  purchaseDb.updatePurchaseOrder(payload.id, {
    bizDate: payload.bizDate !== undefined ? dateStr(payload.bizDate) : undefined,
    note: payload.note !== undefined ? str(payload.note, 500) : undefined,
    totalCents: payload.totalCents !== undefined ? num(payload.totalCents) : undefined,
    items,
  });
  return { success: true };
});

register('purchase-order-submit', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.id !== 'number' || !Number.isInteger(payload.id)) {
    return { success: false, error: 'invalid payload' };
  }
  purchaseDb.ensurePurchaseSchema();
  purchaseDb.submitPurchaseOrder(payload.id);
  return { success: true };
});

register('purchase-order-delete', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.id !== 'number' || !Number.isInteger(payload.id)) {
    return { success: false, error: 'invalid payload' };
  }
  purchaseDb.ensurePurchaseSchema();
  purchaseDb.deletePurchaseOrder(payload.id);
  return { success: true };
});

// ---- 付款 ----
register('purchase-payment-list', async (payload) => {
  purchaseDb.ensurePurchaseSchema();
  const filter = isPlainObject(payload)
    ? {
        supplierId: typeof payload.supplierId === 'number' ? payload.supplierId : undefined,
        from: typeof payload.from === 'string' ? payload.from : undefined,
        to: typeof payload.to === 'string' ? payload.to : undefined,
      }
    : undefined;
  return { success: true, data: purchaseDb.listPayments(filter) };
});

register('purchase-payment-add', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.supplierId !== 'number' || !Number.isInteger(payload.supplierId)) {
    return { success: false, error: 'invalid payload' };
  }
  purchaseDb.ensurePurchaseSchema();
  const id = purchaseDb.addPayment({
    supplierId: payload.supplierId,
    payDate: dateStr(payload.payDate),
    type: payload.type === 'refund' ? 'refund' : 'payment',
    amountCents: num(payload.amountCents),
    method: str(payload.method, 20),
    note: str(payload.note, 200),
  });
  return { success: true, data: { id } };
});

register('purchase-payment-delete', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.id !== 'number' || !Number.isInteger(payload.id)) {
    return { success: false, error: 'invalid payload' };
  }
  purchaseDb.ensurePurchaseSchema();
  purchaseDb.deletePayment(payload.id);
  return { success: true };
});

// ---- 对账 / 待拿货 / 单价记忆 ----
register('purchase-reconciliation', async (payload) => {
  purchaseDb.ensurePurchaseSchema();
  const from = isPlainObject(payload) && typeof payload.from === 'string' ? payload.from : undefined;
  const to = isPlainObject(payload) && typeof payload.to === 'string' ? payload.to : undefined;
  return { success: true, data: purchaseDb.reconciliation(from, to) };
});

register('purchase-outstanding', async () => {
  purchaseDb.ensurePurchaseSchema();
  return { success: true, data: purchaseDb.outstanding() };
});

register('purchase-shop-allocation', async (payload) => {
  purchaseDb.ensurePurchaseSchema();
  const from = isPlainObject(payload) && typeof payload.from === 'string' ? payload.from : undefined;
  const to = isPlainObject(payload) && typeof payload.to === 'string' ? payload.to : undefined;
  return { success: true, data: purchaseDb.shopAllocation(from, to) };
});

register('purchase-shop-allocation-detail', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.shop !== 'string') {
    return { success: false, error: 'invalid payload' };
  }
  purchaseDb.ensurePurchaseSchema();
  const from = typeof payload.from === 'string' ? payload.from : undefined;
  const to = typeof payload.to === 'string' ? payload.to : undefined;
  return { success: true, data: purchaseDb.shopAllocationDetail(payload.shop, from, to) };
});

register('purchase-ignore-add', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.styleCode !== 'string' || !payload.styleCode.trim()) {
    return { success: false, error: 'invalid payload' };
  }
  purchaseDb.ensurePurchaseSchema();
  purchaseDb.addIgnore(str(payload.styleCode, 50), str(payload.color, 50), str(payload.reason, 100));
  return { success: true };
});

register('purchase-ignore-remove', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.styleCode !== 'string') {
    return { success: false, error: 'invalid payload' };
  }
  purchaseDb.ensurePurchaseSchema();
  purchaseDb.removeIgnore(str(payload.styleCode, 50), str(payload.color, 50));
  return { success: true };
});

register('purchase-ignore-list', async () => {
  purchaseDb.ensurePurchaseSchema();
  return { success: true, data: purchaseDb.listIgnores() };
});

register('purchase-price-history', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.styleCode !== 'string') {
    return { success: false, error: 'invalid payload' };
  }
  purchaseDb.ensurePurchaseSchema();
  const price = purchaseDb.priceHistory(
    Number(payload.supplierId) || 0,
    str(payload.styleCode, 50),
    str(payload.color, 50),
  );
  return { success: true, data: { priceCents: price } };
});

// ---- 拿货单导出（Excel 嵌入款色图；主进程生成：图片在本地缓存，xlsx 社区版不支持写图）----
const { dialog: electronDialog, BrowserWindow, app } = require('electron');
const orderDb = require('./order-db');
const fs = require('fs');
const path = require('path');

/** 读 PNG/JPEG 文件头取原始宽高；无法解析返回 null */
function imageSizeOf(filePath: string): { w: number; h: number } | null {
  try {
    const fd = fs.openSync(filePath, 'r');
    const buf = Buffer.alloc(64);
    fs.readSync(fd, buf, 0, buf.length, 0);
    fs.closeSync(fd);
    // PNG：8 字节签名 + 4 长度 + 4 "IHDR" 后为宽高（大端）
    if (buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) {
      return { w: buf.readUInt32BE(16), h: buf.readUInt32BE(20) };
    }
    // JPEG：遍历前 64 字节找 SOFn 标记
    if (buf[0] === 0xff && buf[1] === 0xd8) {
      for (let i = 2; i < 60; i++) {
        const mk = buf[i + 1];
        if (buf[i] === 0xff && mk >= 0xc0 && mk <= 0xc3 && mk !== 0xc4) {
          return { w: buf.readUInt16BE(i + 7), h: buf.readUInt16BE(i + 5) };
        }
      }
    }
    return null;
  } catch {
    return null;
  }
}

register('purchase-export-excel', async (payload) => {
  if (!isPlainObject(payload) || !Array.isArray(payload.items)) {
    return { success: false, error: 'invalid payload' };
  }
  const rows = payload.items
    .slice(0, 500)
    .map((it: any) => ({
      styleCode: str(it?.styleCode, 60),
      styleName: str(it?.styleName, 60),
      color: str(it?.color, 60),
      size: str(it?.size, 20),
      suggestionQty: num(it?.suggestionQty),
      qty: num(it?.qty),
      priceCents: num(it?.priceCents),
    }))
    .filter((it: any) => it.styleCode || it.styleName);
  if (!rows.length) return { success: false, error: '没有可导出的行' };

  const ExcelJS = require('exceljs');
  const wb = new ExcelJS.Workbook();
  const ws = wb.addWorksheet('拿货单');
  const HEAD = ['图片', '款编码', '款式名', '款色', '尺码', '建议数量', '实拿数量', '单价(元)', '金额(元)'];
  ws.addRow(HEAD);
  const head = ws.getRow(1);
  head.font = { bold: true };
  head.height = 20;
  const widths = [13, 15, 26, 12, 8, 10, 10, 10, 12];
  widths.forEach((w, idx) => {
    ws.getColumn(idx + 1).width = w;
  });

  // Excel 无“图片作为单元格内容”的存储格式（除 Excel 365 IMAGE()，兼容性差）。
  // 这里用标准做法：浮动图锚定 A 列单元格，图宽按列宽换算并水平居中，视觉上“嵌在单元格内”。
  // 默认字号下 1 字符≈7px + 5px 边距；留边距避免压到 B 列。
  const A_COL_PX = Math.round(widths[0] * 7 + 5); // A 列宽 13 → 约 96px
  const IMG_W = Math.min(72, A_COL_PX - 14); // 图片显示宽度（像素）
  const colOff = Math.max(0, Math.round((A_COL_PX - IMG_W) / 2)); // 水平居中偏移
  rows.forEach((it, i) => {
    const r = i + 2;
    // 第 1 位是 A 列（图片占位，下面嵌图）；金额/单价以元为单位
    const price = it.priceCents > 0 ? it.priceCents / 100 : null;
    const amount = it.qty > 0 && price ? +(it.qty * price).toFixed(2) : null;
    ws.addRow([
      undefined,
      it.styleCode,
      it.styleName,
      it.color,
      it.size,
      it.suggestionQty || undefined,
      it.qty || undefined,
      price,
      amount,
    ]);
    const row = ws.getRow(r);
    row.alignment = { vertical: 'middle', wrapText: it.styleName ? true : false };
    if (price !== null) row.getCell(8).numFmt = '0.00';
    if (amount !== null) row.getCell(9).numFmt = '0.00';
    if (!it.styleCode || !it.color) return;
    // 按 款编码+款色 查本地代表图并嵌入 A 列
    const imgPath = orderDb.findStyleColorImagePath(it.styleCode, it.color);
    if (!imgPath || !fs.existsSync(imgPath)) return;
    const raw = imageSizeOf(imgPath);
    const dh = raw && raw.w > 0 ? Math.min(160, Math.max(24, Math.round((IMG_W * raw.h) / raw.w))) : 70;
    try {
      const imgId = wb.addImage({ filename: imgPath });
      // 锚定 A 列该行（oneCellAnchor），删除/插入行时图片随锚定行移动；colOff 水平居中
      ws.addImage(imgId, { tl: { col: 0, colOff, row: r - 1 }, ext: { width: IMG_W, height: dh } });
      row.height = Math.max(22, Math.ceil(dh * 0.75) + 2); // 行高撑起以容纳图片（1px≈0.75pt）
    } catch {
      /* 单张图损坏不阻断导出 */
    }
  });

  const win = BrowserWindow.getFocusedWindow() ?? BrowserWindow.getAllWindows()[0];
  const safe = String(payload.defaultName ?? '拿货单').replace(/[\\/:*?"<>|]/g, '_').slice(0, 120);
  const dialogOpts = {
    title: '导出拿货单（含款色图）',
    defaultPath: path.join(app.getPath('documents'), `${safe || '拿货单'}.xlsx`),
    filters: [{ name: 'Excel 工作簿', extensions: ['xlsx'] }],
  };
  const result = win
    ? await electronDialog.showSaveDialog(win, dialogOpts)
    : await electronDialog.showSaveDialog(dialogOpts);
  if (result.canceled || !result.filePath) return { success: false, error: '__canceled__' };
  await wb.xlsx.writeFile(result.filePath);
  return { success: true, data: { filePath: result.filePath } };
});
