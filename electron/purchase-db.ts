// electron/purchase-db.ts
// 拿货对账模块（stock-in）数据访问层：厂商 / 拿货单 / 拿货明细 / 付款 / 对账汇总 / 待拿货缺口。
// 与订单归类共用同一 SQLite（order.db），表名前缀 suppliers/purchase_*/payments。
// 金额统一以"分"为整数存储（*_cents），避免浮点误差；对账与待拿货缺口均为聚合查询，实时反映最新数据。

export {};

import {
  initDb,
  dbMigrate,
  dbQuery,
  dbGet,
  dbRun,
  dbTransaction,
} from './db';

// ---- 类型（与渲染层 src/types.ts 对应，结构保持一致） ----

export interface Supplier {
  id: number;
  name: string;
  phone: string;
  note: string;
  createdAt: string;
}

export interface PurchaseItem {
  /** 草稿新增行/未落库行为 0（仅落库后回填） */
  id?: number;
  styleCode: string;
  styleName: string;
  color: string;
  /** 尺码；旧数据与无码拿货为空串 */
  size: string;
  /** 实拿数量 */
  qty: number;
  /** 单价（分） */
  priceCents: number;
  /** 金额（分）= qty × priceCents */
  amountCents: number;
  /** 生成草稿时的建议数量（仅展示，不参与待拿货计算） */
  suggestionQty: number;
}

/** 拿货单的来源订单快照行（生成时锁定的订单明细，含店铺/尺码，用于按店铺拆分成本） */
export interface PurchaseSourceRow {
  shop: string;
  styleCode: string;
  styleName?: string;
  color: string;
  size: string;
  qty: number;
}

/** 店铺对账汇总行（拿货成本按来源订单拆分到店铺） */
export interface ShopAllocationRow {
  shop: string;
  qty: number;
  amountCents: number;
  orderCount: number;
}

/** 店铺对账明细行 */
export interface ShopAllocationDetailRow {
  purchaseId: number;
  bizDate: string;
  supplierName: string;
  shop: string;
  styleCode: string;
  styleName: string;
  color: string;
  size: string;
  qty: number;
  priceCents: number;
  amountCents: number;
}

export interface PurchaseOrder {
  id: number;
  supplierId: number;
  supplierName: string;
  bizDate: string;
  mode: 'detail' | 'package';
  status: 'draft' | 'submitted';
  totalCents: number;
  note: string;
  editedAt: string | null;
  createdAt: string;
  items: PurchaseItem[];
}

export interface Payment {
  id: number;
  supplierId: number;
  supplierName: string;
  payDate: string;
  type: 'payment' | 'refund';
  /** 金额（分），恒为正数，方向由 type 区分 */
  amountCents: number;
  method: string;
  note: string;
  createdAt: string;
}

export interface ReconciliationRow {
  supplierId: number;
  supplierName: string;
  /** 时间窗内已提交拿货单总额（分） */
  purchaseCents: number;
  /** 时间窗内付款合计（分） */
  paidCents: number;
  /** 时间窗内退款合计（分） */
  refundCents: number;
  /** 欠款（分）= purchaseCents − (paidCents − refundCents) */
  balanceCents: number;
  orderCount: number;
  paymentCount: number;
}

export interface OutstandingRow {
  styleCode: string;
  styleName: string;
  color: string;
  size: string;
  /** 订单需求（按款色码聚合的订单行数） */
  demand: number;
  /** 已拿（所有已提交拿货单合计，按款色码） */
  taken: number;
  /** 缺口 = max(0, demand − taken) */
  missing: number;
}

// ---- 建表 ----

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS suppliers (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    phone TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE TABLE IF NOT EXISTS purchase_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    biz_date TEXT NOT NULL,
    mode TEXT NOT NULL DEFAULT 'detail',
    status TEXT NOT NULL DEFAULT 'draft',
    total_cents INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    edited_at TEXT,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE TABLE IF NOT EXISTS purchase_items (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    style_code TEXT NOT NULL,
    style_name TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    size TEXT NOT NULL DEFAULT '',
    qty INTEGER NOT NULL DEFAULT 0,
    price_cents INTEGER NOT NULL DEFAULT 0,
    amount_cents INTEGER NOT NULL DEFAULT 0,
    suggestion_qty INTEGER NOT NULL DEFAULT 0,
    UNIQUE(purchase_id, style_code, color, size)
  )`,
  `CREATE TABLE IF NOT EXISTS purchase_sources (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    purchase_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
    shop TEXT NOT NULL DEFAULT '',
    style_code TEXT NOT NULL,
    style_name TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    size TEXT NOT NULL DEFAULT '',
    qty INTEGER NOT NULL DEFAULT 1
  )`,
  `CREATE INDEX IF NOT EXISTS idx_purchase_sources_purchase ON purchase_sources(purchase_id)`,
  `CREATE TABLE IF NOT EXISTS payments (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    supplier_id INTEGER NOT NULL REFERENCES suppliers(id),
    pay_date TEXT NOT NULL,
    type TEXT NOT NULL DEFAULT 'payment',
    amount_cents INTEGER NOT NULL,
    method TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE TABLE IF NOT EXISTS purchase_ignore (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    style_code TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '',
    reason TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(style_code, color)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_purchase_orders_supplier ON purchase_orders(supplier_id)`,
  `CREATE INDEX IF NOT EXISTS idx_purchase_orders_date ON purchase_orders(biz_date)`,
  `CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id)`,
  `CREATE INDEX IF NOT EXISTS idx_payments_supplier ON payments(supplier_id)`,
];

/** 幂等初始化：建表 + 索引 + 存量库升级（应用启动 / 首次使用自动调用） */
export function ensurePurchaseSchema(): void {
  initDb();
  dbMigrate(SCHEMA);
  migrateItemsSize();
}

/**
 * 旧库升级：purchase_items 缺 size 列（升级前版本）→ 重建表。
 * 历史明细统一 size=''，唯一键升级为 (purchase_id, style_code, color, size)。
 * 旧约束已保证同单同款色唯一，因此新增空尺码后不会产生重复行。
 */
function migrateItemsSize(): void {
  const cols = dbQuery<{ name: string }>(`PRAGMA table_info(purchase_items)`);
  if (cols.some((c) => c.name === 'size')) return;
  dbTransaction(() => {
    dbRun(
      `CREATE TABLE purchase_items_new (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        purchase_id INTEGER NOT NULL REFERENCES purchase_orders(id) ON DELETE CASCADE,
        style_code TEXT NOT NULL,
        style_name TEXT NOT NULL DEFAULT '',
        color TEXT NOT NULL DEFAULT '',
        size TEXT NOT NULL DEFAULT '',
        qty INTEGER NOT NULL DEFAULT 0,
        price_cents INTEGER NOT NULL DEFAULT 0,
        amount_cents INTEGER NOT NULL DEFAULT 0,
        suggestion_qty INTEGER NOT NULL DEFAULT 0,
        UNIQUE(purchase_id, style_code, color, size)
      )`,
    );
    dbRun(
      `INSERT INTO purchase_items_new (id, purchase_id, style_code, style_name, color, qty, price_cents, amount_cents, suggestion_qty)
       SELECT id, purchase_id, style_code, style_name, color, qty, price_cents, amount_cents, suggestion_qty FROM purchase_items`,
    );
    dbRun(`DROP TABLE purchase_items`);
    dbRun(`ALTER TABLE purchase_items_new RENAME TO purchase_items`);
    dbRun(`CREATE INDEX IF NOT EXISTS idx_purchase_items_purchase ON purchase_items(purchase_id)`);
  });
}

// ---- 厂商 ----

export function listSuppliers(): Supplier[] {
  return dbQuery<Record<string, unknown>>(
    `SELECT id, name, phone, note, created_at FROM suppliers ORDER BY id`,
  ).map(mapSupplier);
}

/** 新建厂商（同名报错），返回新 id */
export function createSupplier(name: string, phone: string, note: string): number {
  const trimmed = String(name ?? '').trim();
  if (!trimmed) throw new Error('厂商名称不能为空');
  return dbRun(`INSERT INTO suppliers (name, phone, note) VALUES (?, ?, ?)`, [
    trimmed,
    String(phone ?? '').trim().slice(0, 30),
    String(note ?? '').trim().slice(0, 200),
  ]).lastInsertRowid;
}

export function updateSupplier(id: number, phone: string, note: string): void {
  const sup = dbGet<{ id: number }>(`SELECT id FROM suppliers WHERE id = ?`, [id]);
  if (!sup) throw new Error(`厂商不存在: id=${id}`);
  dbRun(`UPDATE suppliers SET phone = ?, note = ? WHERE id = ?`, [
    String(phone ?? '').trim().slice(0, 30),
    String(note ?? '').trim().slice(0, 200),
    id,
  ]);
}

/** 删除厂商：有拿货单或付款记录时禁止（保护对账历史） */
export function deleteSupplier(id: number): void {
  const sup = dbGet<{ id: number }>(`SELECT id FROM suppliers WHERE id = ?`, [id]);
  if (!sup) throw new Error(`厂商不存在: id=${id}`);
  const po = dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM purchase_orders WHERE supplier_id = ?`, [id]);
  const pm = dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM payments WHERE supplier_id = ?`, [id]);
  if ((po?.c ?? 0) > 0 || (pm?.c ?? 0) > 0) {
    throw new Error('该厂商已有拿货单或付款记录，不能删除（可归档置灰）');
  }
  dbRun(`DELETE FROM suppliers WHERE id = ?`, [id]);
}

function mapSupplier(r: Record<string, unknown>): Supplier {
  return {
    id: Number(r.id),
    name: String(r.name ?? ''),
    phone: String(r.phone ?? ''),
    note: String(r.note ?? ''),
    createdAt: String(r.created_at ?? ''),
  };
}

// ---- 拿货单 ----

export function listPurchaseOrders(): PurchaseOrder[] {
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT po.id, po.supplier_id, s.name AS supplier_name, po.biz_date, po.mode, po.status,
            po.total_cents, po.note, po.edited_at, po.created_at
     FROM purchase_orders po JOIN suppliers s ON po.supplier_id = s.id
     ORDER BY po.biz_date DESC, po.id DESC`,
  );
  return rows.map((r) => ({ ...mapOrderRow(r), items: loadItems(Number(r.id)) }));
}

export function getPurchaseOrder(id: number): PurchaseOrder | undefined {
  const r = dbGet<Record<string, unknown>>(
    `SELECT po.id, po.supplier_id, s.name AS supplier_name, po.biz_date, po.mode, po.status,
            po.total_cents, po.note, po.edited_at, po.created_at
     FROM purchase_orders po JOIN suppliers s ON po.supplier_id = s.id
     WHERE po.id = ?`,
    [id],
  );
  if (!r) return undefined;
  return { ...mapOrderRow(r), items: loadItems(id) };
}

/**
 * 新建拿货单（明细模式：items 必填，金额由本层重算；包价模式：传 totalCents）。
 * 明细模式可附来源订单快照 sources（生成时锁定店铺归属）；未提供时按缺口自动推导。
 * 返回新 id。
 */
export function createPurchaseOrder(input: {
  supplierId: number;
  bizDate: string;
  mode: 'detail' | 'package';
  note: string;
  totalCents?: number;
  items?: PurchaseItem[];
  sources?: PurchaseSourceRow[];
}): number {
  const supplier = dbGet<{ id: number }>(`SELECT id FROM suppliers WHERE id = ?`, [input.supplierId]);
  if (!supplier) throw new Error(`厂商不存在: id=${input.supplierId}`);
  const mode = input.mode === 'package' ? 'package' : 'detail';
  const date = String(input.bizDate ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式不正确');

  return dbTransaction(() => {
    const total = mode === 'package'
      ? Math.max(0, Math.round(Number(input.totalCents ?? 0)))
      : computeTotal(input.items ?? []);
    const id = dbRun(
      `INSERT INTO purchase_orders (supplier_id, biz_date, mode, status, total_cents, note)
       VALUES (?, ?, ?, 'draft', ?, ?)`,
      [input.supplierId, date, mode, total, String(input.note ?? '').slice(0, 500)],
    ).lastInsertRowid;
    if (mode === 'detail') {
      const items = input.items ?? [];
      insertItems(id, items);
      // 锁定来源订单（店铺归属）；未显式提供时按订单缺口自动推导
      const sources = input.sources?.length
        ? sanitizeSources(input.sources)
        : autoSourceRows(items);
      if (sources.length) insertSources(id, sources);
    }
    return id;
  });
}

/** 显式传入的来源快照清洗（只保留有效行，件数至少 1） */
function sanitizeSources(sources: PurchaseSourceRow[]): PurchaseSourceRow[] {
  const out: PurchaseSourceRow[] = [];
  for (const s of sources) {
    const code = String(s.styleCode ?? '').trim().slice(0, 50);
    if (!code) continue;
    const qty = Math.max(1, Math.round(Number(s.qty ?? 1)));
    out.push({
      shop: String(s.shop ?? '').trim().slice(0, 100),
      styleCode: code,
      styleName: String(s.styleName ?? '').slice(0, 100),
      color: String(s.color ?? '').slice(0, 50),
      size: String(s.size ?? '').slice(0, 50),
      qty,
    });
  }
  return out;
}

/**
 * 按缺口自动推导来源订单行：对拿货单每个款色码，从 oi_orders 中取最靠前的
 * 未满足订单行（已拿 = 其它已提交拿货单合计）作为来源，件数不足需求的部分不补。
 * 无订单数据（未导入）时返回空数组，该单不参与店铺拆分。
 */
function autoSourceRows(items: PurchaseItem[]): PurchaseSourceRow[] {
  const out: PurchaseSourceRow[] = [];
  const seen = new Set<string>();
  for (const it of items) {
    const code = String(it.styleCode ?? '').trim();
    const color = String(it.color ?? '');
    const size = String(it.size ?? '');
    if (!code) continue;
    const key = `${code}\u0000${color}\u0000${size}`;
    if (seen.has(key)) continue;
    seen.add(key);
    const need = Math.max(0, Math.round(Number(it.qty ?? 0)));
    if (need <= 0) continue;
    // 该款色码已拿（其它已提交拿货单）
    const takenRow = dbGet<{ t: number }>(
      `SELECT COALESCE(SUM(pi.qty), 0) AS t
       FROM purchase_items pi JOIN purchase_orders po ON pi.purchase_id = po.id
       WHERE po.status = 'submitted' AND pi.style_code = ? AND pi.color = ? AND pi.size = ?`,
      [code, color, size],
    );
    const taken = Number(takenRow?.t ?? 0);
    // 需求订单行（按导入顺序 FIFO）
    const rows = dbQuery<Record<string, unknown>>(
      `SELECT o.id AS oid, o.shop, s.code AS style_code, s.name AS style_name,
              sc.color AS style_color, o.size
       FROM oi_orders o
       JOIN oi_images i ON o.image_id = i.id
       JOIN oi_style_colors sc ON i.style_color_id = sc.id
       JOIN oi_styles s ON sc.style_id = s.id
       WHERE s.code = ? AND sc.color = ? AND o.size = ?
       ORDER BY o.id`,
      [code, color, size],
    );
    let skip = taken;
    let pushed = 0;
    for (const row of rows) {
      if (skip > 0) {
        skip -= 1;
        continue;
      }
      if (pushed >= need || out.length >= 5000) break;
      out.push({
        shop: String(row.shop ?? ''),
        styleCode: String(row.style_code ?? ''),
        styleName: String(row.style_name ?? ''),
        color: String(row.style_color ?? ''),
        size: String(row.size ?? ''),
        qty: 1,
      });
      pushed += 1;
    }
  }
  return out;
}

function insertSources(purchaseId: number, sources: PurchaseSourceRow[]): void {
  for (const s of sources) {
    dbRun(
      `INSERT INTO purchase_sources (purchase_id, shop, style_code, style_name, color, size, qty)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
      [purchaseId, s.shop, s.styleCode, s.styleName ?? '', s.color, s.size, s.qty],
    );
  }
}

/**
 * 编辑拿货单（草稿或已提交均可）：明细模式整体替换明细并重算金额；
 * 包价模式更新 totalCents。置 edited_at 留痕。
 */
export function updatePurchaseOrder(id: number, input: {
  bizDate?: string;
  note?: string;
  totalCents?: number;
  items?: PurchaseItem[];
}): void {
  const order = dbGet<Record<string, unknown>>(`SELECT * FROM purchase_orders WHERE id = ?`, [id]);
  if (!order) throw new Error(`拿货单不存在: id=${id}`);
  dbTransaction(() => {
    const sets: string[] = [];
    const params: (string | number)[] = [];
    if (input.bizDate !== undefined) {
      const date = String(input.bizDate).slice(0, 10);
      if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式不正确');
      sets.push('biz_date = ?');
      params.push(date);
    }
    if (input.note !== undefined) {
      sets.push('note = ?');
      params.push(String(input.note).slice(0, 500));
    }
    if (order.mode === 'package' && input.totalCents !== undefined) {
      sets.push('total_cents = ?');
      params.push(Math.max(0, Math.round(Number(input.totalCents ?? 0))));
    }
    if (order.mode === 'detail' && input.items !== undefined) {
      dbRun(`DELETE FROM purchase_items WHERE purchase_id = ?`, [id]);
      insertItems(id, input.items);
      sets.push('total_cents = ?');
      params.push(computeTotal(input.items));
    }
    sets.push("edited_at = datetime('now','localtime')");
    dbRun(`UPDATE purchase_orders SET ${sets.join(', ')} WHERE id = ?`, [...params, id]);
  });
}

/** 提交拿货单：draft → submitted（提交后参与待拿货与对账） */
export function submitPurchaseOrder(id: number): void {
  const order = dbGet<{ status: string }>(`SELECT status FROM purchase_orders WHERE id = ?`, [id]);
  if (!order) throw new Error(`拿货单不存在: id=${id}`);
  if (order.status === 'submitted') return;
  dbRun(`UPDATE purchase_orders SET status = 'submitted' WHERE id = ?`, [id]);
}

/** 删除拿货单（显式删明细与来源快照，防御性保证）：已拿数量自动回滚，待拿货缺口自动回升 */
export function deletePurchaseOrder(id: number): void {
  const order = dbGet<{ id: number }>(`SELECT id FROM purchase_orders WHERE id = ?`, [id]);
  if (!order) throw new Error(`拿货单不存在: id=${id}`);
  dbTransaction(() => {
    dbRun(`DELETE FROM purchase_items WHERE purchase_id = ?`, [id]);
    dbRun(`DELETE FROM purchase_sources WHERE purchase_id = ?`, [id]);
    dbRun(`DELETE FROM purchase_orders WHERE id = ?`, [id]);
  });
}

function loadItems(purchaseId: number): PurchaseItem[] {
  return dbQuery<Record<string, unknown>>(
    `SELECT id, style_code, style_name, color, size, qty, price_cents, amount_cents, suggestion_qty
     FROM purchase_items WHERE purchase_id = ? ORDER BY id`,
    [purchaseId],
  ).map((r) => ({
    id: Number(r.id),
    styleCode: String(r.style_code ?? ''),
    styleName: String(r.style_name ?? ''),
    color: String(r.color ?? ''),
    size: String(r.size ?? ''),
    qty: Number(r.qty ?? 0),
    priceCents: Number(r.price_cents ?? 0),
    amountCents: Number(r.amount_cents ?? 0),
    suggestionQty: Number(r.suggestion_qty ?? 0),
  }));
}

function insertItems(purchaseId: number, items: PurchaseItem[]): void {
  for (const it of items) {
    const qty = Math.max(0, Math.round(Number(it.qty ?? 0)));
    const price = Math.max(0, Math.round(Number(it.priceCents ?? 0)));
    const code = String(it.styleCode ?? '').trim().slice(0, 50);
    if (!code) continue;
    dbRun(
      `INSERT INTO purchase_items
         (purchase_id, style_code, style_name, color, size, qty, price_cents, amount_cents, suggestion_qty)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      [
        purchaseId,
        code,
        String(it.styleName ?? '').slice(0, 100),
        String(it.color ?? '').slice(0, 50),
        String(it.size ?? '').slice(0, 50),
        qty,
        price,
        qty * price,
        Math.max(0, Math.round(Number(it.suggestionQty ?? 0))),
      ],
    );
  }
}

function computeTotal(items: PurchaseItem[]): number {
  return items.reduce((sum, it) => {
    const qty = Math.max(0, Math.round(Number(it.qty ?? 0)));
    const price = Math.max(0, Math.round(Number(it.priceCents ?? 0)));
    return sum + qty * price;
  }, 0);
}

function mapOrderRow(r: Record<string, unknown>): Omit<PurchaseOrder, 'items'> {
  return {
    id: Number(r.id),
    supplierId: Number(r.supplier_id),
    supplierName: String(r.supplier_name ?? ''),
    bizDate: String(r.biz_date ?? ''),
    mode: (r.mode === 'package' ? 'package' : 'detail') as 'detail' | 'package',
    status: (r.status === 'submitted' ? 'submitted' : 'draft') as 'draft' | 'submitted',
    totalCents: Number(r.total_cents ?? 0),
    note: String(r.note ?? ''),
    editedAt: r.edited_at ? String(r.edited_at) : null,
    createdAt: String(r.created_at ?? ''),
  };
}

// ---- 付款 ----

export function listPayments(filter?: { supplierId?: number; from?: string; to?: string }): Payment[] {
  const conds: string[] = [];
  const params: (string | number)[] = [];
  if (filter?.supplierId) {
    conds.push('p.supplier_id = ?');
    params.push(filter.supplierId);
  }
  if (filter?.from) {
    conds.push('p.pay_date >= ?');
    params.push(filter.from);
  }
  if (filter?.to) {
    conds.push('p.pay_date <= ?');
    params.push(filter.to);
  }
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT p.id, p.supplier_id, s.name AS supplier_name, p.pay_date, p.type, p.amount_cents,
            p.method, p.note, p.created_at
     FROM payments p JOIN suppliers s ON p.supplier_id = s.id ${where}
     ORDER BY p.pay_date DESC, p.id DESC`,
    params,
  );
  return rows.map((r) => ({
    id: Number(r.id),
    supplierId: Number(r.supplier_id),
    supplierName: String(r.supplier_name ?? ''),
    payDate: String(r.pay_date ?? ''),
    type: (r.type === 'refund' ? 'refund' : 'payment') as 'payment' | 'refund',
    amountCents: Number(r.amount_cents ?? 0),
    method: String(r.method ?? ''),
    note: String(r.note ?? ''),
    createdAt: String(r.created_at ?? ''),
  }));
}

/** 记一笔付款/退款，返回新 id */
export function addPayment(input: {
  supplierId: number;
  payDate: string;
  type: 'payment' | 'refund';
  amountCents: number;
  method: string;
  note: string;
}): number {
  const supplier = dbGet<{ id: number }>(`SELECT id FROM suppliers WHERE id = ?`, [input.supplierId]);
  if (!supplier) throw new Error(`厂商不存在: id=${input.supplierId}`);
  const date = String(input.payDate ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式不正确');
  const amount = Math.max(0, Math.round(Number(input.amountCents ?? 0)));
  if (amount <= 0) throw new Error('金额必须大于 0');
  return dbRun(
    `INSERT INTO payments (supplier_id, pay_date, type, amount_cents, method, note)
     VALUES (?, ?, ?, ?, ?, ?)`,
    [
      input.supplierId,
      date,
      input.type === 'refund' ? 'refund' : 'payment',
      amount,
      String(input.method ?? '').trim().slice(0, 20),
      String(input.note ?? '').trim().slice(0, 200),
    ],
  ).lastInsertRowid;
}

export function deletePayment(id: number): void {
  const p = dbGet<{ id: number }>(`SELECT id FROM payments WHERE id = ?`, [id]);
  if (!p) throw new Error(`付款记录不存在: id=${id}`);
  dbRun(`DELETE FROM payments WHERE id = ?`, [id]);
}

// ---- 对账汇总 ----

/** 按厂商聚合对账（biz_date / pay_date 在 [from, to] 窗口内，含边界；缺省为全部） */
export function reconciliation(from?: string, to?: string): ReconciliationRow[] {
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT s.id AS supplier_id, s.name AS supplier_name,
       (SELECT COALESCE(SUM(po.total_cents), 0) FROM purchase_orders po
          WHERE po.supplier_id = s.id AND po.status = 'submitted'
            AND (? IS NULL OR po.biz_date >= ?) AND (? IS NULL OR po.biz_date <= ?)) AS purchase_cents,
       (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p
          WHERE p.supplier_id = s.id AND p.type = 'payment'
            AND (? IS NULL OR p.pay_date >= ?) AND (? IS NULL OR p.pay_date <= ?)) AS paid_cents,
       (SELECT COALESCE(SUM(p.amount_cents), 0) FROM payments p
          WHERE p.supplier_id = s.id AND p.type = 'refund'
            AND (? IS NULL OR p.pay_date >= ?) AND (? IS NULL OR p.pay_date <= ?)) AS refund_cents,
       (SELECT COUNT(*) FROM purchase_orders po
          WHERE po.supplier_id = s.id AND po.status = 'submitted'
            AND (? IS NULL OR po.biz_date >= ?) AND (? IS NULL OR po.biz_date <= ?)) AS order_count,
       (SELECT COUNT(*) FROM payments p
          WHERE p.supplier_id = s.id
            AND (? IS NULL OR p.pay_date >= ?) AND (? IS NULL OR p.pay_date <= ?)) AS payment_count
     FROM suppliers s
     ORDER BY (SELECT COALESCE(SUM(po.total_cents), 0) FROM purchase_orders po
          WHERE po.supplier_id = s.id AND po.status = 'submitted'
            AND (? IS NULL OR po.biz_date >= ?) AND (? IS NULL OR po.biz_date <= ?)) DESC, s.id`,
    // SQL 共 6 处窗口子查询（purchase/paid/refund/order_count/payment_count/ORDER BY），每处 4 个占位符
    // （两个 (? IS NULL OR 列 >= ?)，两个 (? IS NULL OR 列 <= ?)），合计 24 个，必须一一对应。
    [
      from ?? null, from ?? null, to ?? null, to ?? null, // purchase_cents
      from ?? null, from ?? null, to ?? null, to ?? null, // paid_cents
      from ?? null, from ?? null, to ?? null, to ?? null, // refund_cents
      from ?? null, from ?? null, to ?? null, to ?? null, // order_count
      from ?? null, from ?? null, to ?? null, to ?? null, // payment_count
      from ?? null, from ?? null, to ?? null, to ?? null, // ORDER BY 排序子查询
    ],
  );
  return rows.map((r) => {
    const purchaseCents = Number(r.purchase_cents ?? 0);
    const paidCents = Number(r.paid_cents ?? 0);
    const refundCents = Number(r.refund_cents ?? 0);
    return {
      supplierId: Number(r.supplier_id),
      supplierName: String(r.supplier_name ?? ''),
      purchaseCents,
      paidCents,
      refundCents,
      balanceCents: purchaseCents - (paidCents - refundCents),
      orderCount: Number(r.order_count ?? 0),
      paymentCount: Number(r.payment_count ?? 0),
    };
  });
}

// ---- 待拿货缺口（实时差量） ----

/**
 * 待拿货缺口 = max(0, 订单需求 − 已拿) − 已忽略。
 * 需求   = 订单库按款色码聚合的行数（经 oi_orders → oi_images → oi_style_colors → oi_styles）；
 * 已拿   = 所有已提交拿货单明细 qty 合计（按款色码）；
 * 已忽略 = purchase_ignore 标记的整款色（含全部尺码）。
 * 实时反映：新订单 / 删除订单 / 拿货单增删改 / 标记无需补货。
 */
export function outstanding(): OutstandingRow[] {
  const demands = dbQuery<Record<string, unknown>>(
    `SELECT s.code AS style_code, s.name AS style_name, sc.color AS style_color, o.size AS size,
            COUNT(*) AS demand
     FROM oi_orders o
     JOIN oi_images i ON o.image_id = i.id
     JOIN oi_style_colors sc ON i.style_color_id = sc.id
     JOIN oi_styles s ON sc.style_id = s.id
     GROUP BY sc.id, o.size`,
  );
  const takenRows = dbQuery<Record<string, unknown>>(
    `SELECT pi.style_code, pi.color, pi.size, SUM(pi.qty) AS taken
     FROM purchase_items pi JOIN purchase_orders po ON pi.purchase_id = po.id
     WHERE po.status = 'submitted'
     GROUP BY pi.style_code, pi.color, pi.size`,
  );
  const ignored = new Set(
    dbQuery<{ style_code: string; color: string }>(
      `SELECT style_code, color FROM purchase_ignore`,
    ).map((r) => `${r.style_code}|${r.color}`),
  );
  const taken = new Map(
    takenRows.map((r) => [`${r.style_code}|${r.color}|${r.size}`, Number(r.taken ?? 0)]),
  );

  const result: OutstandingRow[] = [];
  for (const d of demands) {
    const ignoredKey = `${d.style_code}|${d.style_color}`;
    if (ignored.has(ignoredKey)) continue;
    const key = `${d.style_code}|${d.style_color}|${d.size}`;
    const demand = Number(d.demand ?? 0);
    const have = taken.get(key) ?? 0;
    const missing = demand - have;
    if (missing <= 0) continue;
    result.push({
      styleCode: String(d.style_code ?? ''),
      styleName: String(d.style_name ?? ''),
      color: String(d.style_color ?? ''),
      size: String(d.size ?? ''),
      demand,
      taken: have,
      missing,
    });
  }
  result.sort((a, b) => b.missing - a.missing);
  return result;
}

/** 标记某款色无需补货（已线下拿/放弃/退单），缺口不再提示；同款色新需求差额会重新出现 */
export function addIgnore(styleCode: string, color: string, reason: string): void {
  dbRun(
    `INSERT OR IGNORE INTO purchase_ignore (style_code, color, reason) VALUES (?, ?, ?)`,
    [String(styleCode ?? '').trim().slice(0, 50), String(color ?? '').slice(0, 50), String(reason ?? '').slice(0, 100)],
  );
}

/** 恢复某款色的待拿货提示 */
export function removeIgnore(styleCode: string, color: string): void {
  dbRun(`DELETE FROM purchase_ignore WHERE style_code = ? AND color = ?`, [
    String(styleCode ?? '').trim().slice(0, 50),
    String(color ?? '').slice(0, 50),
  ]);
}

export function listIgnores(): { styleCode: string; color: string; reason: string; createdAt: string }[] {
  return dbQuery<Record<string, unknown>>(
    `SELECT style_code, color, reason, created_at FROM purchase_ignore ORDER BY id DESC`,
  ).map((r) => ({
    styleCode: String(r.style_code ?? ''),
    color: String(r.color ?? ''),
    reason: String(r.reason ?? ''),
    createdAt: String(r.created_at ?? ''),
  }));
}

// ---- 店铺对账（拿货成本按来源订单拆分到店铺，实时计算） ----

/**
 * 对全部已提交拿货单做来源拆分：
 * 每单明细行（款色码 × 单价）按该单锁定来源订单行 FIFO 覆盖，
 * 产出 (单, 店铺, 款色码) 粒度的明细行；超过来源件数的部分不计入店铺成本。
 */
function allocateToShops(from?: string, to?: string): ShopAllocationDetailRow[] {
  const conds: string[] = [`po.status = 'submitted'`];
  const params: (string | number)[] = [];
  if (from) {
    conds.push('po.biz_date >= ?');
    params.push(from);
  }
  if (to) {
    conds.push('po.biz_date <= ?');
    params.push(to);
  }
  const where = `WHERE ${conds.join(' AND ')}`;
  const orders = dbQuery<Record<string, unknown>>(
    `SELECT po.id, po.biz_date, s.name AS supplier_name
     FROM purchase_orders po JOIN suppliers s ON po.supplier_id = s.id ${where}
     ORDER BY po.biz_date, po.id`,
    params,
  );
  if (orders.length === 0) return [];
  const ids = orders.map((o) => Number(o.id));
  const idIn = `(${ids.map(() => '?').join(',')})`;
  const itemRows = dbQuery<Record<string, unknown>>(
    `SELECT purchase_id, style_code, style_name, color, size, qty, price_cents
     FROM purchase_items WHERE purchase_id IN ${idIn}`,
    ids,
  );
  const srcRows = dbQuery<Record<string, unknown>>(
    `SELECT purchase_id, shop, style_code, style_name, color, size, qty
     FROM purchase_sources WHERE purchase_id IN ${idIn} ORDER BY id`,
    ids,
  );

  // 每单：款色码 bucket（qty 上限 + 单价 + 已消费 used）
  type Bucket = { qty: number; priceCents: number; used: number };
  const orderBuckets = new Map<number, Map<string, Bucket>>();
  for (const it of itemRows) {
    const pid = Number(it.purchase_id);
    let m = orderBuckets.get(pid);
    if (!m) {
      m = new Map();
      orderBuckets.set(pid, m);
    }
    const key = `${it.style_code}\u0000${it.color}\u0000${it.size}`;
    const hit = m.get(key);
    if (hit) hit.qty += Number(it.qty ?? 0);
    else m.set(key, { qty: Number(it.qty ?? 0), priceCents: Number(it.price_cents ?? 0), used: 0 });
  }

  const lines: ShopAllocationDetailRow[] = [];
  for (const src of srcRows) {
    const pid = Number(src.purchase_id);
    const buckets = orderBuckets.get(pid);
    if (!buckets) continue;
    const key = `${src.style_code}\u0000${src.color}\u0000${src.size}`;
    const bucket = buckets.get(key);
    if (!bucket) continue;
    const srcQty = Number(src.qty ?? 1);
    const avail = bucket.qty - bucket.used;
    const take = Math.min(srcQty, avail);
    if (take <= 0) continue;
    bucket.used += take;
    const order = orders.find((o) => Number(o.id) === pid)!;
    const price = bucket.priceCents;
    lines.push({
      purchaseId: pid,
      bizDate: String(order.biz_date ?? ''),
      supplierName: String(order.supplier_name ?? ''),
      shop: String(src.shop ?? ''),
      styleCode: String(src.style_code ?? ''),
      styleName: String(src.style_name ?? ''),
      color: String(src.color ?? ''),
      size: String(src.size ?? ''),
      qty: take,
      priceCents: price,
      amountCents: take * price,
    });
  }
  return lines;
}

/** 店铺对账汇总（按店铺聚合，缺省时间窗 = 全部已提交拿货单） */
export function shopAllocation(from?: string, to?: string): ShopAllocationRow[] {
  const lines = allocateToShops(from, to);
  const byShop = new Map<string, { qty: number; amountCents: number; orderIds: Set<number> }>();
  for (const l of lines) {
    let agg = byShop.get(l.shop);
    if (!agg) {
      agg = { qty: 0, amountCents: 0, orderIds: new Set() };
      byShop.set(l.shop, agg);
    }
    agg.qty += l.qty;
    agg.amountCents += l.amountCents;
    agg.orderIds.add(l.purchaseId);
  }
  return [...byShop.entries()]
    .map(([shop, agg]) => ({
      shop,
      qty: agg.qty,
      amountCents: agg.amountCents,
      orderCount: agg.orderIds.size,
    }))
    .sort((a, b) => b.amountCents - a.amountCents || a.shop.localeCompare(b.shop));
}

/** 指定店铺的对账明细行（按拿货日期、单号排序） */
export function shopAllocationDetail(shop: string, from?: string, to?: string): ShopAllocationDetailRow[] {
  return allocateToShops(from, to)
    .filter((l) => l.shop === shop)
    .sort((a, b) => a.bizDate.localeCompare(b.bizDate) || a.purchaseId - b.purchaseId);
}

// ---- 单价记忆（同款衣服自动填价：优先当前厂商，未命中或未选厂商时按款色全局取最近一次） ----

export function priceHistory(supplierId: number, styleCode: string, color: string): number {
  const code = String(styleCode ?? '');
  const clr = String(color ?? '');
  if (!code) return 0;
  if (supplierId > 0) {
    const r = dbGet<{ price_cents: number }>(
      `SELECT pi.price_cents
       FROM purchase_items pi JOIN purchase_orders po ON pi.purchase_id = po.id
       WHERE po.supplier_id = ? AND pi.style_code = ? AND pi.color = ? AND pi.qty > 0
       ORDER BY po.biz_date DESC, pi.id DESC LIMIT 1`,
      [supplierId, code, clr],
    );
    if (r) return Number(r.price_cents ?? 0);
  }
  const g = dbGet<{ price_cents: number }>(
    `SELECT pi.price_cents
     FROM purchase_items pi JOIN purchase_orders po ON pi.purchase_id = po.id
     WHERE pi.style_code = ? AND pi.color = ? AND pi.qty > 0
     ORDER BY po.biz_date DESC, pi.id DESC LIMIT 1`,
    [code, clr],
  );
  return g ? Number(g.price_cents ?? 0) : 0;
}
