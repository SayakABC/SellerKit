// electron/purchase-handlers.ts
// 拿货对账模块（stock-in）IPC handler（electron/main.ts require 后自动生效）。
// 语义化通道 + 入参二次校验；不向渲染层透传 SQL（安全边界见 AGENTS.md §1.7 / 红线 3）。
// 职责：厂商 / 拿货单 / 付款 / 对账汇总 / 待拿货缺口 / 单价记忆。

export {};

// ⚠️ `as typeof import(...)` 不能省：跨文件 `require` 不带类型标注就是 `any`，
// 被调模块改了签名这里也不会红（`electron/` 是独立 ts 项目，跨文件调用不会被自动检查）。
const purchaseDb = require('./purchase-db') as typeof import('./purchase-db');
const { register } = require('./ipc-util') as typeof import('./ipc-util');
// 拿货落账 → 订单行实际进价（跨域编排收在宿主这一层；见 `purchase-cost-sync.ts` 的文件头）
const { syncOrderRowCosts } = require('./purchase-cost-sync') as typeof import('./purchase-cost-sync');

/**
 * 拿货**写操作统一收口**：落账后自动把实付价回填到订单行
 * （`oi_order_items.actual_cost_cents`，C2 两字段模型的"实际进价"）。
 *
 * 为什么自动：成本的唯一来源是拿货对账，而它过去只由利润页上的一个手动按钮搬运 ——
 * 实测用户库 `purchase_orders` 有 3 张、成本表是 **0 行**（货拿了、利润里没成本，数字凭空变好看）。
 * C2 起不再写任何"成本表"：同一笔实付直接落在订单行上，利润按 `实际 > 预估 > 缺` 取数。
 *
 * 同步失败**不影响落账本身**（拿货单已经写成功，抛出去会让用户以为单据没落）；
 * 失败只打日志，且**界面看得见**：首页缺口卡会显示「缺成本 N 行」。
 */
function withCostSync<T extends { success: boolean }>(result: T): T {
  if (result?.success) {
    try {
      syncOrderRowCosts();
    } catch (err: any) {
      // eslint-disable-next-line no-console
      console.error('[cost-sync] 订单行实际进价回填失败（不影响本次落账）：', err?.message || err);
    }
  }
  return result;
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return !!v && typeof v === 'object' && !Array.isArray(v);
}

const str = (v: unknown, max = 500) => String(v ?? '').slice(0, max);
const num = (v: unknown) => Math.max(0, Math.round(Number(v ?? 0)));
const dateStr = (v: unknown) => str(v, 10);

// 幂等建表（模块首次使用时调用）
register('purchase-db-ensure', async () => {
  purchaseDb.ensurePurchaseSchema();
  return { success: true };
});

// 只读成本快照导出（仅供外部读取拿货成本，无写能力；旧的款级价目表已退役，当前无岛消费者）
register('purchase-cost-snapshot', async () => {
  purchaseDb.ensurePurchaseSchema();
  const items = purchaseDb.costSnapshot();
  return { success: true, data: { items, count: items.length } };
});

// 逐行覆盖度（2026-10-22）：未发货订单每一行「要几件 / 已被拿货单覆盖几件」+ 无归属台账。
// 只读。渲染层据此判「哪张单齐了」，并给总览算精确的「已拿」。
register('purchase-order-coverage', async () => {
  purchaseDb.ensurePurchaseSchema();
  return { success: true, data: purchaseDb.orderCoverage() };
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
  const items = sanitizeItems(payload.items);
  const sources = sanitizeSources(payload.sources);
  // 包价单已删（2026-10-20）：建单只有明细一种形态（真库 0 条 package，也没有创建入口）
  const id = purchaseDb.createPurchaseOrder({
    supplierId: payload.supplierId,
    bizDate: dateStr(payload.bizDate),
    items,
    sources,
  });
  return withCostSync({ success: true, data: { id } });
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
    items,
  });
  return withCostSync({ success: true });
});

register('purchase-order-submit', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.id !== 'number' || !Number.isInteger(payload.id)) {
    return { success: false, error: 'invalid payload' };
  }
  purchaseDb.ensurePurchaseSchema();
  purchaseDb.submitPurchaseOrder(payload.id);
  return withCostSync({ success: true });
});

register('purchase-order-delete', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.id !== 'number' || !Number.isInteger(payload.id)) {
    return { success: false, error: 'invalid payload' };
  }
  purchaseDb.ensurePurchaseSchema();
  purchaseDb.deletePurchaseOrder(payload.id);
  return withCostSync({ success: true });
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
  return withCostSync({ success: true, data: { id } });
});

register('purchase-payment-delete', async (payload) => {
  if (!isPlainObject(payload) || typeof payload.id !== 'number' || !Number.isInteger(payload.id)) {
    return { success: false, error: 'invalid payload' };
  }
  purchaseDb.ensurePurchaseSchema();
  purchaseDb.deletePayment(payload.id);
  return withCostSync({ success: true });
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

// 「已拿台账」（2026-10-17）：与 outstanding 分开 —— 拿齐的款色码在缺口里不存在，
// 清单要算"还差多少"必须读它（见 purchase-db.takenLedger 的注释）。
register('purchase-taken', async () => {
  purchaseDb.ensurePurchaseSchema();
  return { success: true, data: purchaseDb.takenLedger() };
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
// **跨域读**（边 C）：拿货单的款色图来自订单域的识别结果（`oi_styles`/`oi_style_colors`/`oi_images`）。
// 与购货同域无关，是 ADR-002 允许的 3 条受控合流点之一 —— 见 `docs/notes/2026-10-30-island-host-boundary.md`。
// ⚠️ 类型标注必须留着（同规则 A）：不带标注时下面几处调用**编译期不报错**，只在运行期按错的参数查图。
// 2026-10-20 起签名是 `(styleCode, color, size, styleColorId?)`：明细带了款色 id 就**只按 id** 取图
// （色名是可变标签，改名后按色名取图会静默变 null ⇒ "拿货单图片全没了"）。
const orderDb = require('./order-db') as typeof import('./order-db');
const path = require('path');

// ---- 编辑器行图：按「款编码 + 款色 + 尺码」批量取本地图路径（渲染层再经 order-image-thumb-batch 出缩略图）----
// 与导出嵌图共用 `findStyleColorImagePath` 同一份实现（改口径只改那一处）；
// 未命中/缺款色为 null —— 图是装饰，查不到只是空占位，不阻断编辑器。
//
// ⚠️ `size` 必须原样带下去（2026-10-11 用户报"细节图全一样"）：订单 Excel 里每个商品行各有自己的图，
// 而明细行的粒度是「款色 × 尺码」⇒ 只按款色取会把同款所有行都显示成同一张（且多半不是本行那件）。
const STYLE_IMAGES_MAX = 500;
register('purchase-style-images', async (payload) => {
  if (!isPlainObject(payload) || !Array.isArray(payload.items)) {
    return { success: false, error: 'invalid payload' };
  }
  orderDb.ensureOrderSchema();
  const items = payload.items.slice(0, STYLE_IMAGES_MAX).map((it: any) => ({
    styleCode: str(it?.styleCode, 50).trim(),
    color: str(it?.color, 50).trim(),
    size: str(it?.size, 50).trim(),
    // 身份优先：明细里带了款色 id 就按 id 取图（色名可能已被改写 —— 见 order-db 的注释）
    styleColorId: Number(it?.styleColorId) || 0,
  }));
  const paths = items.map((it: any) =>
    it.styleCode && (it.color || it.styleColorId)
      ? orderDb.findStyleColorImagePath(it.styleCode, it.color, it.size, it.styleColorId)
      : null,
  );
  return { success: true, data: { paths } };
});

// ---- 「色未定」修复的候选色：按款编码列出该款真实存在的色行（带"有没有图"）----
// 只提供事实（`oi_style_colors` 里有什么），选哪个由用户在编辑器里定 —— 这里绝不猜色。
register('purchase-style-colors', async (payload) => {
  if (!isPlainObject(payload) || !Array.isArray(payload.styleCodes)) {
    return { success: false, error: 'invalid payload' };
  }
  orderDb.ensureOrderSchema();
  const codes = payload.styleCodes
    .slice(0, 500)
    .map((c: any) => str(c, 50).trim())
    .filter(Boolean);
  return { success: true, data: orderDb.styleColorOptions(codes) };
});

// 嵌图：与「拣货单带图导出」共用一份实现（`xlsx-image.ts`）——
// 原先本文件自己读文件头 + 自己调 `wb.addImage({filename})`，两处都踩过坑（见该文件头）。
const { embedCellImage } = require('./xlsx-image') as typeof import('./xlsx-image');

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
      // 身份优先取图（与编辑器同一份实现）：色名可能已被改写
      styleColorId: num(it?.styleColorId),
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
    // 按 款编码+款色+尺码 查本地代表图并嵌进 A 列（尺码 = 该行对应订单商品的画像，见 order-db 同函数注释）。
    // ⚠️ 嵌图必须走 `xlsx-image.embedCellImage`：v4.4.0 下 `wb.addImage({filename})` 只给文件名时
    // 会写成 `xl/media/image1.undefined` + `<Default ContentType="image/undefined"/>`（**包结构不合法**，
    // Excel 会提示修复并丢掉图）。该文件头记了两个实测坑 + 修法。
    const imgPath = orderDb.findStyleColorImagePath(it.styleCode, it.color, it.size, it.styleColorId);
    const h = embedCellImage(wb, ws, r, imgPath ? { filePath: imgPath } : null, {
      width: IMG_W,
      colOff,
    });
    if (h !== null) row.height = h;
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
