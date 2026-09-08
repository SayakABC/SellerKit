// electron/ae-db.ts
// 「速卖通利润追踪」数据访问层（基于 electron/db.ts 公共层），M0 起随主程序分发。
//
// 存储策略（v2，通用化：字段增减不动表结构）：
//   - ae_orders    窄列 = 稳定键（orderId/时间/状态/币种/商品金额/买家运费等查询与列表骨架），
//                   不随业务字段演进频繁加列；
//   - raw_json     整帧全量快照 = 扩展发来的原始订单对象（【不裁剪未知字段】），
//                   语义化字段增减只改采集端与展示端，历史数据不丢、主程序无需升级即宽容入库；
//   - ae_fees      订单级费用科目子表（category/amount/currency）——费用集合最易增减，
//                   科目化后「加科目 = 插行」，零 ALTER；v1 顶层费用字段（platformFee 等）自动映射为科目行；
//   - ae_order_lines SKU 行（明细键不稳定，随订单 upsert 整批替换）。
//
// 协议字段与 schema 权威定义：PROFIT_TRACKER.md §5/§6；金额语义见 §4（收入侧/费用侧分列，不预摊）。
// schema 兼容：ae-order/v1（旧帧，顶层 platformFee/logisticsFee/refundAmount → fees 科目）与
//              ae-order/v2（结构化 fees 数组，见 AeIngestFee）。

export {};

import { initDb, dbMigrate, dbGet, dbRun, dbQuery, dbTransaction } from './db';

// ---- 类型（与渲染层 src/types.ts 对应结构保持一致；两端各自声明，避免主进程 import 渲染层） ----

/** 费用科目 key（宽松白名单：未知科目同样入库，仅前端字典缺失 label） */
export type AeFeeCategory =
  | 'platform_commission' // 平台佣金
  | 'logistics_fee' // 物流费-卖家承担
  | 'payment_channel' // 支付通道费
  | 'refund' // 退款/纠纷调整（收入扣减类）
  | (string & {}); // 未来科目：宽容接收，不在此枚举也能入库

/** 订单级费用条目（v2 帧 fee 数组元素；条目内未知字段宽容保留） */
export interface AeIngestFee {
  category?: string;
  amount?: number;
  currency?: string;
  [key: string]: unknown;
}

export interface AeIngestLine {
  productId?: string;
  skuId?: string;
  title?: string;
  skuProps?: string;
  qty?: number;
  unitPrice?: number;
  goodsAmount?: number;
  [key: string]: unknown;
}

/**
 * 扩展/CSV 推入的单条订单（JSON 帧内对象，snake→camel）。
 * v1 兼容：platformFee/logisticsFee/refundAmount 顶层便捷字段会被映射为 fees 科目行。
 * 宽容：未知字段一律保留（进 raw_json 快照），主程序不因新字段拒绝旧版本协同。
 */
export interface AeIngestOrder {
  orderId: string;
  shopName?: string;
  site?: string;
  orderTime?: string;
  status?: string;
  currency?: string;
  goodsAmount?: number;
  shippingIncome?: number;
  /** 数据来源（extension / csv / curl 调试） */
  source?: string;
  /** v1 兼容便捷费用字段（sanitize 阶段映射进 fees，不再落独立列） */
  platformFee?: number;
  logisticsFee?: number;
  refundAmount?: number;
  fees?: AeIngestFee[];
  lines?: AeIngestLine[];
  [key: string]: unknown;
}

export interface AeUpsertResult {
  inserted: number;
  updated: number;
  skipped: number;
}

/** 查询返回的费用条目（列表行 / 汇总共用，currency 已回填订单币种） */
export interface AeFeeItem {
  category: string;
  amount: number;
  currency: string;
}

/** 明细列表行（不含 raw_json） */
export interface AeOrderListItem {
  id: number;
  orderId: string;
  shopName: string;
  site: string;
  orderTime: string;
  status: string;
  currency: string;
  /** 商品金额（收入侧） */
  goodsAmount: number;
  /** 买家付运费（收入侧） */
  shippingIncome: number;
  /** 费用科目明细（平台佣金/物流费/退款…；同币种 = 订单币种） */
  fees: AeFeeItem[];
  lineCount: number;
  source: string;
  updatedAt: string;
}

export interface AeFeeSummary {
  category: string;
  total: number;
  orders: number;
}

export interface AeCurrencyGroup {
  currency: string;
  orders: number;
  goodsAmount: number;
  shippingIncome: number;
  fees: AeFeeSummary[];
}

/**
 * 汇总（分币种，收入/费用分列；M1 利润引擎基于此扩展）。
 * 金额保留原币种按组聚合；top 级 total* 为跨币种预览合计（真实口径以 byCurrency 为准）。
 */
export interface AeSummary {
  totalOrders: number;
  totalGoodsAmount: number;
  totalShippingIncome: number;
  byCurrency: AeCurrencyGroup[];
}

// ---- 表结构（窄列 + 科目子表；旧库残留的 platform_fee 等列不再读写，无害保留） ----

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS ae_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_id TEXT NOT NULL UNIQUE,
    shop_name TEXT NOT NULL DEFAULT '',
    site TEXT NOT NULL DEFAULT '',
    order_time TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT '',
    currency TEXT NOT NULL DEFAULT 'USD',
    goods_amount REAL NOT NULL DEFAULT 0,
    shipping_income REAL NOT NULL DEFAULT 0,
    raw_json TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'extension',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE TABLE IF NOT EXISTS ae_order_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ae_order_id INTEGER NOT NULL REFERENCES ae_orders(id) ON DELETE CASCADE,
    product_id TEXT NOT NULL DEFAULT '',
    sku_id TEXT NOT NULL DEFAULT '',
    title TEXT NOT NULL DEFAULT '',
    sku_props TEXT NOT NULL DEFAULT '',
    qty INTEGER NOT NULL DEFAULT 1,
    unit_price REAL NOT NULL DEFAULT 0,
    goods_amount REAL NOT NULL DEFAULT 0
  )`,
  `CREATE TABLE IF NOT EXISTS ae_fees (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    ae_order_id INTEGER NOT NULL REFERENCES ae_orders(id) ON DELETE CASCADE,
    category TEXT NOT NULL DEFAULT '',
    amount REAL NOT NULL DEFAULT 0,
    currency TEXT NOT NULL DEFAULT 'USD',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_ae_orders_order_time ON ae_orders(order_time)`,
  `CREATE INDEX IF NOT EXISTS idx_ae_orders_status ON ae_orders(status)`,
  `CREATE INDEX IF NOT EXISTS idx_ae_orders_currency ON ae_orders(currency)`,
  `CREATE INDEX IF NOT EXISTS idx_ae_order_lines_ae_order_id ON ae_order_lines(ae_order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ae_fees_ae_order_id ON ae_fees(ae_order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_ae_fees_category ON ae_fees(category)`,
];

/** 幂等初始化：建表 + 索引（应用启动 / 首次使用自动调用；含旧库无 ALTER 增量，新表由 CREATE IF NOT EXISTS 补齐） */
export function ensureAeSchema(): void {
  initDb();
  dbMigrate(SCHEMA);
}

// ---- 字段规整与校验 ----

const MAX_STR = {
  orderId: 40, shopName: 200, site: 20, orderTime: 40, status: 60, currency: 8,
  productId: 64, skuId: 64, title: 300, skuProps: 300,
  category: 60, source: 20,
};
const MAX_MONEY = 1e9;
const MAX_QTY = 1e6;
const MAX_LINES = 100;
const MAX_FEES = 100;
/** raw 快照长度上限（单条帧；接收端 body 已限 1MB/批 100，此处保险） */
const MAX_RAW_JSON = 64 * 1024;

/** v1 顶层费用字段 → 费用科目 key 映射（迁移路径，v1/v2 帧均转科目行入库） */
const LEGACY_FEE_MAP: Record<string, string> = {
  platformFee: 'platform_commission',
  logisticsFee: 'logistics_fee',
  refundAmount: 'refund',
};

function clipStr(v: unknown, max: number): string {
  if (typeof v !== 'string') return '';
  return v.slice(0, max).trim();
}

/** 金额规整：仅接受有限数字，保留两位小数；非法返回 null（调用方跳过或记 0） */
function normMoney(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  if (Math.abs(v) > MAX_MONEY) return null;
  return Math.round(v * 100) / 100;
}

function normQty(v: unknown): number | null {
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  const n = Math.round(v);
  if (n < 1 || n > MAX_QTY) return null;
  return n;
}

/**
 * 单条订单 schema 校验与规整（宽容模式）：
 *  - 必填仅 orderId；核心字符串/金额字段做长度/有限数校验并规整；
 *  - 未知字段不拒绝：原样保留（整帧快照进 raw_json），
 *  - v1 顶层费用字段 → fees 科目行；v2 fees 数组逐条规整（未知科目照收）。
 * @returns { order|null, error? } 非法返回 { order: null, error }
 */
export function sanitizeIngestOrder(input: unknown): { order: AeIngestOrder | null; error?: string } {
  if (!input || typeof input !== 'object') return { order: null, error: '订单必须是对象' };
  const o = input as Record<string, unknown>;
  const orderId = clipStr(o.orderId, MAX_STR.orderId);
  if (!orderId) return { order: null, error: '缺少 orderId' };

  const currency = clipStr(o.currency, MAX_STR.currency).toUpperCase() || 'USD';

  // 核心金额：商品金额 / 买家付运费（收入侧窄列）；非法则整单拒绝
  const goodsAmount = normMoney(o.goodsAmount);
  if (o.goodsAmount !== undefined && o.goodsAmount !== null && goodsAmount === null) {
    return { order: null, error: '金额字段 goodsAmount 非法' };
  }
  const shippingIncome = normMoney(o.shippingIncome);
  if (o.shippingIncome !== undefined && o.shippingIncome !== null && shippingIncome === null) {
    return { order: null, error: '金额字段 shippingIncome 非法' };
  }

  // 费用：v2 fees 数组 + v1 顶层映射；非法金额跳过该条费用（不整单失败），容忍演进
  const fees: AeIngestFee[] = [];
  if (Array.isArray(o.fees)) {
    if (o.fees.length > MAX_FEES) return { order: null, error: `fees 条数超上限（≤${MAX_FEES}）` };
    for (const raw of o.fees as unknown[]) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const amount = normMoney(r.amount);
      if (amount === null) continue;
      const category = clipStr(r.category, MAX_STR.category);
      if (!category) continue;
      fees.push({ ...r, category, amount, currency: clipStr(r.currency, MAX_STR.currency).toUpperCase() || currency });
    }
  }
  for (const [key, cat] of Object.entries(LEGACY_FEE_MAP)) {
    const v = o[key];
    if (v === undefined || v === null) continue;
    const n = normMoney(v);
    if (n === null) return { order: null, error: `金额字段 ${key} 非法` };
    fees.push({ category: cat, amount: n, currency });
  }

  // SKU 行：非法行跳过；条目内未知字段宽容保留
  let lines: AeIngestLine[] = [];
  if (o.lines !== undefined && o.lines !== null) {
    if (!Array.isArray(o.lines) || o.lines.length > MAX_LINES) return { order: null, error: 'lines 必须是 ≤100 的数组' };
    for (const raw of o.lines as unknown[]) {
      if (!raw || typeof raw !== 'object') continue;
      const r = raw as Record<string, unknown>;
      const qty = normQty(r.qty);
      const unitPrice = normMoney(r.unitPrice);
      const lineGoods = normMoney(r.goodsAmount);
      if (qty === null || unitPrice === null || lineGoods === null) continue;
      lines.push({
        ...r,
        productId: clipStr(r.productId, MAX_STR.productId),
        skuId: clipStr(r.skuId, MAX_STR.skuId),
        title: clipStr(r.title, MAX_STR.title),
        skuProps: clipStr(r.skuProps, MAX_STR.skuProps),
        qty,
        unitPrice,
        goodsAmount: lineGoods,
      });
    }
  }

  // 宽容快照：保留原始对象全部字段，仅覆盖规整后的核心值
  const order: Record<string, unknown> = { ...o };
  order.orderId = orderId;
  order.currency = currency;
  order.shopName = clipStr(o.shopName, MAX_STR.shopName);
  order.site = clipStr(o.site, MAX_STR.site);
  order.orderTime = clipStr(o.orderTime, MAX_STR.orderTime);
  order.status = clipStr(o.status, MAX_STR.status);
  order.goodsAmount = goodsAmount ?? 0;
  order.shippingIncome = shippingIncome ?? 0;
  order.fees = fees;
  order.lines = lines;

  return { order: order as AeIngestOrder };
}

// ---- 入库 ----

/** 批量幂等 upsert：存在 order_id 则更新（含 SKU 行/费用科目整批替换），否则插入。整体走事务。 */
export function upsertOrderBatch(orders: AeIngestOrder[]): AeUpsertResult {
  if (!orders.length) return { inserted: 0, updated: 0, skipped: 0 };
  return dbTransaction(() => {
    let inserted = 0;
    let updated = 0;
    for (const o of orders) {
      const rawJson = JSON.stringify(o).slice(0, MAX_RAW_JSON);
      const existing = dbGet<{ id: number }>('SELECT id FROM ae_orders WHERE order_id = ?', [o.orderId]);
      if (existing) {
        dbRun(
          `UPDATE ae_orders SET shop_name=?, site=?, order_time=?, status=?, currency=?, goods_amount=?, shipping_income=?, raw_json=?, source=?, updated_at=datetime('now','localtime') WHERE id=?`,
          [o.shopName ?? '', o.site ?? '', o.orderTime ?? '', o.status ?? '', o.currency ?? 'USD',
           o.goodsAmount ?? 0, o.shippingIncome ?? 0, rawJson, o.source ?? 'extension', existing.id],
        );
        dbRun('DELETE FROM ae_order_lines WHERE ae_order_id = ?', [existing.id]);
        dbRun('DELETE FROM ae_fees WHERE ae_order_id = ?', [existing.id]);
        replaceLines(existing.id, o.lines ?? []);
        replaceFees(existing.id, o.fees ?? []);
        updated += 1;
      } else {
        const info = dbRun(
          `INSERT INTO ae_orders (order_id, shop_name, site, order_time, status, currency, goods_amount, shipping_income, raw_json, source) VALUES (?,?,?,?,?,?,?,?,?,?)`,
          [o.orderId, o.shopName ?? '', o.site ?? '', o.orderTime ?? '', o.status ?? '', o.currency ?? 'USD',
           o.goodsAmount ?? 0, o.shippingIncome ?? 0, rawJson, o.source ?? 'extension'],
        );
        replaceLines(info.lastInsertRowid, o.lines ?? []);
        replaceFees(info.lastInsertRowid, o.fees ?? []);
        inserted += 1;
      }
    }
    return { inserted, updated, skipped: 0 };
  });
}

function replaceLines(orderDbId: number, lines: AeIngestLine[]): void {
  for (const l of lines) {
    dbRun(
      `INSERT INTO ae_order_lines (ae_order_id, product_id, sku_id, title, sku_props, qty, unit_price, goods_amount) VALUES (?,?,?,?,?,?,?,?)`,
      [orderDbId, l.productId ?? '', l.skuId ?? '', l.title ?? '', l.skuProps ?? '', l.qty ?? 1, l.unitPrice ?? 0, l.goodsAmount ?? 0],
    );
  }
}

function replaceFees(orderDbId: number, fees: AeIngestFee[]): void {
  for (const f of fees) {
    const category = clipStr(f.category, MAX_STR.category);
    const amount = normMoney(f.amount);
    if (!category || amount === null) continue;
    dbRun(
      `INSERT INTO ae_fees (ae_order_id, category, amount, currency) VALUES (?,?,?,?)`,
      [orderDbId, category, amount, clipStr(f.currency, MAX_STR.currency).toUpperCase() || 'USD'],
    );
  }
}

// ---- 查询 ----

function num(v: unknown): number {
  return v !== undefined && v !== null ? Number(v) : 0;
}

const ORDER_COLS = `o.id, o.order_id, o.shop_name, o.site, o.order_time, o.status, o.currency, o.goods_amount, o.shipping_income, o.source, o.updated_at`;

function mapOrderRow(row: Record<string, unknown>, fees: AeFeeItem[]): AeOrderListItem {
  return {
    id: num(row.id),
    orderId: String(row.order_id ?? ''),
    shopName: String(row.shop_name ?? ''),
    site: String(row.site ?? ''),
    orderTime: String(row.order_time ?? ''),
    status: String(row.status ?? ''),
    currency: String(row.currency ?? 'USD'),
    goodsAmount: num(row.goods_amount),
    shippingIncome: num(row.shipping_income),
    fees,
    lineCount: num(row.line_count),
    source: String(row.source ?? 'extension'),
    updatedAt: String(row.updated_at ?? ''),
  };
}

/** 按订单 id 批量取费用（分块 IN 查询，规避 SQLite 变量数上限） */
function fetchFeesByOrderIds(ids: number[]): Map<number, AeFeeItem[]> {
  const map = new Map<number, AeFeeItem[]>();
  for (let i = 0; i < ids.length; i += 500) {
    const chunk = ids.slice(i, i + 500);
    const qs = chunk.map(() => '?').join(',');
    const rows = dbQuery<Record<string, unknown>>(
      `SELECT ae_order_id, category, amount, currency FROM ae_fees WHERE ae_order_id IN (${qs}) ORDER BY amount DESC`,
      chunk,
    );
    for (const r of rows) {
      const key = num(r.ae_order_id);
      const list = map.get(key) ?? [];
      list.push({ category: String(r.category ?? ''), amount: num(r.amount), currency: String(r.currency ?? 'USD') });
      map.set(key, list);
    }
  }
  return map;
}

/** 明细列表（分页 + 可选单号/店铺关键字）。不含 raw_json，降低传输量。 */
export function listOrders(payload: { offset: number; limit: number; search?: string }): { rows: AeOrderListItem[]; total: number } {
  const search = (payload.search ?? '').trim();
  const like = `%${search}%`;
  const where = search ? `WHERE o.order_id LIKE ? OR o.shop_name LIKE ?` : '';
  const params: (string | number)[] = search ? [like, like] : [];
  const rowsRaw = dbQuery<Record<string, unknown>>(
    `SELECT ${ORDER_COLS}, (SELECT COUNT(*) FROM ae_order_lines l WHERE l.ae_order_id = o.id) AS line_count
     FROM ae_orders o ${where}
     ORDER BY o.order_time DESC, o.id DESC
     LIMIT ? OFFSET ?`,
    [...params, payload.limit, payload.offset],
  );
  const ids = rowsRaw.map((r) => num(r.id)).filter((n) => n > 0);
  const feeMap = fetchFeesByOrderIds(ids);
  const totalRow = dbGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM ae_orders o ${where}`,
    params,
  );
  return {
    rows: rowsRaw.map((r) => mapOrderRow(r, feeMap.get(num(r.id)) ?? [])),
    total: totalRow ? Number(totalRow.c) : 0,
  };
}

/**
 * 汇总（分币种，收入侧/费用科目分列）：收入按订单币种聚合；
 * 费用按「订单币种 × 科目」聚合（JOIN 订单取币种，防费用条目币种与订单不一致导致串组）。
 * top 级 total* 为跨币种预览合计，仅供排序参考。
 */
export function getAeSummary(): AeSummary {
  const orderRows = dbQuery<Record<string, unknown>>(
    `SELECT currency,
            COUNT(*) AS c,
            COALESCE(SUM(goods_amount),0) AS ga,
            COALESCE(SUM(shipping_income),0) AS si
     FROM ae_orders GROUP BY currency ORDER BY ga DESC`,
  );
  const feeRows = dbQuery<Record<string, unknown>>(
    `SELECT o.currency AS ccy, f.category, COUNT(*) AS orders, COALESCE(SUM(f.amount),0) AS total
     FROM ae_fees f JOIN ae_orders o ON o.id = f.ae_order_id
     GROUP BY o.currency, f.category`,
  );
  const byCurrency: AeCurrencyGroup[] = orderRows.map((r) => ({
    currency: String(r.currency ?? 'USD'),
    orders: num(r.c),
    goodsAmount: num(r.ga),
    shippingIncome: num(r.si),
    fees: [],
  }));
  const groupByCcy = new Map<string, AeCurrencyGroup>(byCurrency.map((g) => [g.currency, g]));
  for (const f of feeRows) {
    const g = groupByCcy.get(String(f.ccy ?? 'USD'));
    if (!g) continue;
    g.fees.push({ category: String(f.category ?? ''), total: num(f.total), orders: num(f.orders) });
  }
  return {
    totalOrders: byCurrency.reduce((s, g) => s + g.orders, 0),
    totalGoodsAmount: byCurrency.reduce((s, g) => s + g.goodsAmount, 0),
    totalShippingIncome: byCurrency.reduce((s, g) => s + g.shippingIncome, 0),
    byCurrency,
  };
}
