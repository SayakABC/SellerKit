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
  migrate,
  tableExists,
  type MigrationStep,
} from './db';
import { productSchemaReady } from './product-db';
// 「一个订单行 → 它的款色」的唯一展开口径（套装 = 一件实物多个款色）。
// 进货口的**需求**必须与核对页/拣货同一份口径，否则套装会被算成一个款、子商品永远不进拿货单。
import { ITEM_STYLE_COLOR_ID, ITEM_STYLE_COLOR_SRC } from './order-db';

/**
 * 款式展示名的派生片段（ADR-002 D1：款名权威在 `pl_products`，按 `code` 关联）。
 * 采购域只是**消费方**，不拥有款式主数据 —— 缺产品表时降级为空名，而不是让整个
 * 拿货/对账查询抛「no such table」（那会把「产品域还没建」报成「采购域坏了」）。
 */
function styleNameJoin(): { join: string; name: string } {
  return productSchemaReady()
    ? { join: 'LEFT JOIN pl_products p ON p.code = s.code', name: 'p.name' }
    : { join: '', name: `''` };
}

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
  /**
   * 款色 id（**身份**：已拿 ↔ 需求的匹配键）。0 / 缺省 = 老数据或未归色
   * ⇒ 回落 (款,色,码) 文本匹配（见 `outstanding` 注释）。
   *
   * 为什么必须有（2026-10-20 用户实报"全待拿"）：拿货明细原先只存**色名文本**，
   * 而归色链路会把色名从「未分类」改写成平台色名 ⇒ 10 行台账键命中 0 ⇒ 每张卡都待拿。
   * 色名是可变标签，不能当身份；开单那一刻把它背后的款色 id 一起存下来。
   */
  styleColorId?: number;
}

/**
 * 明细行**写入侧**入参：`id` 由库自增、`amountCents` 由 `qty × priceCents` 现算
 * （见 `insertItems` / `computeTotal`）—— 两个都不是调用方能决定的，故写侧类型里没有它们。
 *
 * ⚠️ 与渲染层 `src/modules/today/purchase.ts` 的 `PurchaseItemInput`（同一条 Omit）同义：
 * 一边改另一边要跟着改。**读侧**（`loadItems` / `PurchaseOrder.items`）仍是完整 `PurchaseItem`。
 */
export type PurchaseItemInput = Omit<PurchaseItem, 'id' | 'amountCents'>;

/**
 * 拿货单的来源订单快照行（生成时锁定的订单明细，含店铺/尺码）。
 *
 * 两个用途（2026-10-22 起）：
 *   1. 按店铺拆分拿货成本（`allocateToShops`，2026-10 初就有）；
 *   2. **哪张订单的货齐了** —— 靠 `orderItemId` 指回 `oi_order_items.id`。
 *
 * ⚠️ `orderItemId = 0` 是**合法且必须保留**的取值：历史单（加这一列之前生成的）没有归属，
 *    以及"需求订单行不够、这次拿多了"的尾巴。它不参与逐单判定，只进「无归属台账」。
 */
export interface PurchaseSourceRow {
  shop: string;
  styleCode: string;
  styleName?: string;
  color: string;
  size: string;
  qty: number;
  /** 指向 `oi_order_items.id`；0 = 无归属（历史单 / 订单行不够） */
  orderItemId?: number;
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
  /** 恒 'detail'（包价单 2026-10-20 删除；列保留只为兼容老库） */
  mode: 'detail';
  status: 'draft' | 'submitted';
  totalCents: number;
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

/**
 * **已拿台账**（一行 = 一个款色码，来自**已提交**拿货单的 qty 合计）。
 *
 * ⚠️ 为什么必须有它、而不从 `outstanding()` 上扒 `taken` 字段（2026-10-17 实测事故）：
 *    `outstanding()` 是「**还缺什么**」，末尾有 `if (missing <= 0) continue;`
 *    —— **拿完的行会被它自己过滤掉**。拿它当台账用，结果正好反了：
 *    拿得越多越看不见，一旦拿齐（`missing = 0`）该款色从台账里消失
 *    ⇒ 清单按"已拿 0"算 ⇒ `remaining = pieces` ⇒ 卡**永远停在待拿**（用户实报）。
 *    这里只做**台账**（不碰需求、不算缺口），拿完了照样在。
 */
export interface TakenRow {
  /** 款色 id（身份键）。0 = 老明细（只有文本） */
  styleColorId: number;
  styleCode: string;
  color: string;
  size: string;
  /** 已拿件数（所有已提交拿货单合计） */
  taken: number;
}

export interface OutstandingRow {
  styleCode: string;
  styleName: string;
  /** 身份的匹配键（0 = 未归类）；`taken` 与 `missing` 都按它算 */
  styleColorId: number;
  color: string;
  size: string;
  /** 订单需求件数 = SUM(COALESCE(qty,1))（不是行数：一单买 2 件就是 2） */
  demand: number;
  /** 已拿（所有已提交拿货单合计，按款色 id；老数据按文本兜底） */
  taken: number;
  /** 缺口 = max(0, demand − taken) */
  missing: number;
  /** 这组订单行**没有款色归属**（`style_color_id=0`）—— 界面必须标出来，不许静默排除 */
  unclassified: boolean;
  /** 未归类组的线索：涉及的平台商品ID（按商品ID 聚合成修复入口） */
  itemIds: string[];
  /** 未归类组的线索：订单原文色名（平台写法，不翻译） */
  colorRaw: string;
  /** 需求行数（件数与行数不同：一单多件时 demand > orders） */
  orders: number;
}

/**
 * 一行订单明细的覆盖情况（`orderCoverage()` 的 `rows` 元素）。
 *
 * `qty` 是**明细真值**（`oi_order_items.qty`；`null` = 不知道，导入行由渲染层从报表回落），
 * `covered` 只统计**已提交**拿货单 —— 草稿单不算"已经拿了"（与 `takenLedger()` 同一口径）。
 */
export interface OrderCoverageRow {
  /** `oi_order_items.id` —— 与 `purchase_sources.order_item_id` 同一空间 */
  orderItemId: number;
  orderNo: string;
  shop: string;
  orderTime: string;
  styleCode: string;
  styleName: string;
  styleColorId: number;
  /** 款色（识别结论） */
  styleColor: string;
  /** 订单原文色（平台写法；`unclassified` 时的线索） */
  colorRaw: string;
  size: string;
  qty: number | null;
  rawFields: Record<string, string>;
  /** 已提交拿货单里指向本行的件数合计 */
  covered: number;
  /** 没有款色归属（`style_color_id = 0`）—— 界面要标出来，不许静默当成"已齐" */
  unclassified: boolean;
}

export interface OrderCoveragePayload {
  rows: OrderCoverageRow[];
  /** 无归属的已拿台账（形状同 `TakenRow`）：按款色码当池子用，与 `covered` 互斥不重复 */
  unattributed: TakenRow[];
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
    style_color_id INTEGER NOT NULL DEFAULT 0,
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
    qty INTEGER NOT NULL DEFAULT 1,
    order_item_id INTEGER NOT NULL DEFAULT 0
  )`,
  `CREATE INDEX IF NOT EXISTS idx_purchase_sources_purchase ON purchase_sources(purchase_id)`,
  `CREATE INDEX IF NOT EXISTS idx_purchase_sources_item ON purchase_sources(order_item_id)`,
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

/** 幂等初始化：迁移 + 建表/索引 + 存量库升级（应用启动 / 首次使用自动调用） */
export function ensurePurchaseSchema(): void {
  initDb();
  // house convention：**自定义迁移先跑，再 dbMigrate(SCHEMA)** —— 老库删列在 SCHEMA 之前收敛，
  // 新库由（已无 note 的）建表语句一次建到当前形状。
  migrate('purchase.main', purchaseMigrationSteps());
  dbMigrate(SCHEMA);
  migrateItemsSize();
}

/** `purchase_orders` 的演进步骤（版本化：只跑未应用的，见 `electron/db.ts` 的 `migrate`） */
function purchaseMigrationSteps(): MigrationStep[] {
  return [
    { version: 1, name: 'purchase_orders 删 note（零读者列：不进导出/对账/成本）', up: dropOrderNote },
    { version: 2, name: 'purchase_items += style_color_id（已拿的身份键）· 存量按唯一色回填', up: addItemStyleColor },
    {
      version: 3,
      name: 'purchase_sources += order_item_id（哪张订单的哪一行被这批货覆盖）· 存量只补唯一确定的',
      up: addSourceOrderItem,
    },
  ];
}

/**
 * **v3：给来源快照补订单行 id**（2026-10-22）。
 *
 * 为什么加这一列：`autoSourceRows()` 从 2026-10 初就在生成拿货单时**逐条订单行做 FIFO 分配**
 * （"这 N 件对应哪几条订单行"当时就算出来了），但只把 `shop` 写进库、把 `oi.id` 扔了
 * ⇒ 拿货与订单之间没有一条可查的边，「哪张单的货齐了」只能靠款色码总量猜。
 * 列加上之后，源快照才真的是"一条订单行 × 覆盖件数"。
 *
 * **存量回填只补"能由事实唯一确定"的行**（同 v2 补色的纪律，绝不猜）：
 *   该（拿货单, 款色码）组里**只有一条**来源行、且该款色码在未发货订单里**只有一条**候选行、
 *   且那条来源只覆盖 1 件 —— 三者同时成立才认。其余一律留 0（= 无归属），
 *   由 `orderCoverage()` 归进「无归属台账」，界面明说"这批历史拿货没有订单归属"。
 *   猜错的代价是**把别的单宣布成已齐**，比显示"历史单查不到归属"贵得多。
 *
 * ⚠️ 与所有迁移步骤同一条纪律：迁移跑在表可能存在之前 —— 表不存在时 PRAGMA 返回空，直接跳过。
 */
function addSourceOrderItem(): void {
  const cols = dbQuery<{ name: string }>(`PRAGMA table_info(purchase_sources)`);
  if (cols.length === 0) return; // 新库：SCHEMA 建表即带该列
  if (cols.some((c) => c.name === 'order_item_id')) return;
  dbRun(`ALTER TABLE purchase_sources ADD COLUMN order_item_id INTEGER NOT NULL DEFAULT 0`);
  dbRun(`CREATE INDEX IF NOT EXISTS idx_purchase_sources_item ON purchase_sources(order_item_id)`);
  // 订单域表可能还没建（本模块可先跑）→ 缺表就跳过回填，列留着，等下次进页由重放补
  if (!tableExists('oi_order_items') || !tableExists('oi_orders')) return;

  // 候选订单行：**未发货 + 非终结**，与 `outstanding()` 同一范围（口径见该函数注释）。
  // 两套索引：`#款色id|码`（身份，抗改名）与 `款|色|码`（老明细只有文本时才用）。
  const candidates = dbQuery<{
    oid: number;
    style_color_id: number;
    style_code: string;
    color: string;
    size: string;
  }>(
    `SELECT oi.id AS oid, COALESCE(sc.id, 0) AS style_color_id, COALESCE(s.code, '') AS style_code,
            COALESCE(sc.color, '') AS color, oi.size AS size
       FROM oi_order_items oi
       JOIN oi_orders o ON o.id = oi.order_id
       LEFT JOIN oi_images i ON oi.image_id = i.id
       LEFT JOIN oi_style_colors sc ON sc.id = ${ITEM_STYLE_COLOR_ID}
       LEFT JOIN oi_styles s ON sc.style_id = s.id
      WHERE o.ship_time = '' AND oi.status <> 'shipped' AND NOT ${TERMINAL_BIZ_STATUS_SQL}
      ORDER BY oi.id`,
  );
  const byId = new Map<string, number[]>();
  const byText = new Map<string, number[]>();
  const push = (m: Map<string, number[]>, k: string, oid: number): void => {
    const arr = m.get(k);
    if (arr) arr.push(oid);
    else m.set(k, [oid]);
  };
  for (const c of candidates) {
    const id = Number(c.style_color_id) || 0;
    if (id > 0) push(byId, `#${id}|${c.size}`, Number(c.oid));
    push(byText, `${c.style_code}\u0000${c.color}\u0000${c.size}`, Number(c.oid));
  }

  // 拿货明细的款色身份（v2 补的）：来源行本身没有色 id，只能经"同一张单的同一款色码"取。
  // 取不到（`0`）时才退回文本匹配 —— 文本是开单那一刻的副本，色名改过就对不上（真库里
  // 「未分类 → 1/2/3」那批全是这种情况），所以身份优先不是洁癖。
  const itemIds = new Map<string, number>();
  for (const it of dbQuery<{ purchase_id: number; style_code: string; color: string; size: string; style_color_id: number }>(
    `SELECT purchase_id, style_code, color, size, MAX(COALESCE(style_color_id, 0)) AS style_color_id
       FROM purchase_items GROUP BY purchase_id, style_code, color, size`,
  )) {
    itemIds.set(
      `${Number(it.purchase_id)}\u0000${it.style_code}\u0000${it.color}\u0000${it.size}`,
      Number(it.style_color_id) || 0,
    );
  }

  const groups = dbQuery<{ id: number; purchase_id: number; style_code: string; color: string; size: string; qty: number }>(
    `SELECT id, purchase_id, style_code, color, size, qty FROM purchase_sources ORDER BY id`,
  );
  const seen = new Map<string, number>();
  for (const g of groups) {
    const k = `${g.purchase_id}\u0000${g.style_code}\u0000${g.color}\u0000${g.size}`;
    seen.set(k, (seen.get(k) ?? 0) + 1);
  }

  let filled = 0;
  for (const g of groups) {
    if (Number(g.qty) !== 1) continue;
    const gk = `${g.purchase_id}\u0000${g.style_code}\u0000${g.color}\u0000${g.size}`;
    if ((seen.get(gk) ?? 0) !== 1) continue; // 组内多条来源 ⇒ 分不清对应哪一行
    const scId = itemIds.get(gk) ?? 0;
    const cands = scId > 0
      ? byId.get(`#${scId}|${g.size}`) ?? []
      : byText.get(`${g.style_code}\u0000${g.color}\u0000${g.size}`) ?? [];
    if (cands.length !== 1) continue; // 候选不唯一 ⇒ 不猜
    dbRun(`UPDATE purchase_sources SET order_item_id = ? WHERE id = ?`, [cands[0], g.id]);
    filled += 1;
  }
  if (filled > 0) {
    console.log(`[migrate] purchase.main v3：${filled} 行来源快照按"款色码只有唯一候选订单行"补上了 order_item_id（其余留 0，归无归属台账）`);
  }
}


/**
 * **v2：给拿货明细补身份列**（2026-10-20）。
 *
 * 只补"**能由事实唯一确定**"的那些行：该款在款色表里只有**一个**真实色（排除占位「未分类」）
 * ⇒ 这行的色就是它。其余留 0，由界面标「色未定」并给就地修复入口 —— **绝不猜色**
 * （真库 10 行里只有 1 行符合条件；猜错 = 发错货，比显示"未定"贵得多）。
 *
 * 回填放在"列刚被加上"的分支内 ⇒ 只做一次；此后由开单路径直接写入。
 */
function addItemStyleColor(): void {
  const cols = dbQuery<{ name: string }>(`PRAGMA table_info(purchase_items)`);
  if (cols.length === 0) return; // 新库：SCHEMA 建表即带该列
  if (cols.some((c) => c.name === 'style_color_id')) return;
  dbRun(`ALTER TABLE purchase_items ADD COLUMN style_color_id INTEGER NOT NULL DEFAULT 0`);
  dbRun(`CREATE INDEX IF NOT EXISTS idx_purchase_items_sc ON purchase_items(style_color_id)`);
  // 订单域表可能还没建（本模块可先跑）→ 缺表就跳过回填，列留着，等下次进页由重放补
  if (!tableExists('oi_style_colors') || !tableExists('oi_styles')) return;
  // 唯一色回填：款编码 → 款色表里唯一的真实色行
  const filled = dbRun(
    `UPDATE purchase_items
        SET style_color_id = (
          SELECT sc.id FROM oi_style_colors sc JOIN oi_styles s ON s.id = sc.style_id
           WHERE s.code = purchase_items.style_code
             AND TRIM(COALESCE(sc.color, '')) NOT IN ('', '未分类'))
      WHERE COALESCE(style_color_id, 0) = 0
        AND (SELECT COUNT(*) FROM oi_style_colors sc JOIN oi_styles s ON s.id = sc.style_id
              WHERE s.code = purchase_items.style_code
                AND TRIM(COALESCE(sc.color, '')) NOT IN ('', '未分类')) = 1`,
  );
  if (Number(filled.changes) > 0) {
    console.log(`[migrate] purchase.main v2：${filled.changes} 行拿货明细按"该款唯一色"补上了款色 id（其余留 0 待人工认色）`);
  }
}

/**
 * v1 迁移：删 `purchase_orders.note`。
 *
 * 判据：该列全仓零消费者 —— 只被存过、在拿货单列表显示过，不进导出 xlsx、不进对账
 * （`reconciliation` 只读 total_cents）、不进成本快照（`costSnapshot` 只读明细行）；
 * 「模式」(mode) 与它不同，有两条真实下游链路（明细扣缺口 / 包价只进对账），故保留。
 * **不改历史的迁移是空转**：老库带着这列时在此收敛掉，SCHEMA（新库路径）里也已无此列，
 * 两侧形状一致（同 `oi_styles.name` 的删法）。
 *
 * ⚠️ 与所有迁移步骤同一条纪律：**迁移跑在表可能存在之前** —— 表还不存在时 PRAGMA 返回空，
 * 直接跳过（新库由 SCHEMA 建出已无 note 的形状）。
 */
function dropOrderNote(): void {
  const cols = dbQuery<{ name: string }>(`PRAGMA table_info(purchase_orders)`);
  if (!cols.some((c) => c.name === 'note')) return;
  dbRun(`ALTER TABLE purchase_orders DROP COLUMN note`);
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

/**
 * 厂商名归一（**只用于查重比对**，不改变落库原文）：去空白 + 小写。
 *
 * 与渲染层 `src/lib/productImport.ts` 的 `normSupplierName` **同一套口径** ——
 * 预览里"这个名字对得上库里那家"与主进程"找不到就新建"必须是同一个判据，
 * 否则会出现"预览说已关联、导入却新建了一家重名厂商"（名字只差一个空格）。
 *
 * ⚠️ 刻意**不剥**「有限公司」「厂」这类后缀：那是模糊匹配，会把两家不同的供应商并成一家，
 *    而合并了的分账在界面上看不出来（与"不猜近似名"同一判据）。
 */
function normSupplierNameKey(v: unknown): string {
  return String(v ?? '')
    .replace(/\s+/g, '')
    .toLowerCase();
}

/**
 * 按名称**查找，不存在则新建**，返回厂商 id（2026-10-10，产品 Excel 导入用）。
 *
 * 为什么放在采购域：`suppliers` 表的 owner 是这里（ADR-002 C1 单点写入）——
 * 产品域只借它做「名称 → id」的解析（`product-db.listSuppliers`），自己**不写**它。
 * 产品导入了新厂商名却写不进去，症状正是"供应商没有写入"。
 *
 * 比对口径 = 去空白 + 忽略大小写（**精确**，不做近似）：`factory_name` 上的 UNIQUE 是区分大小写
 * 与空格的，直接 INSERT 会造出「厂A」「厂 A」「厂a」三家，所以先查再建。
 *
 * @returns 已存在 → 那条的 id；不存在 → 新建后的 id
 */
export function findOrCreateSupplierByName(name: string): { id: number; created: boolean } {
  const raw = String(name ?? '').trim();
  if (!raw) return { id: 0, created: false };
  ensurePurchaseSchema();
  const key = normSupplierNameKey(raw);
  const hit = dbQuery<{ id: number; name: string }>(`SELECT id, name FROM suppliers`).find(
    (s) => normSupplierNameKey(s.name) === key,
  );
  if (hit) return { id: Number(hit.id) || 0, created: false };
  return { id: createSupplier(raw, '', '产品导入时自动新建'), created: true };
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
            po.total_cents, po.edited_at, po.created_at
     FROM purchase_orders po JOIN suppliers s ON po.supplier_id = s.id
     ORDER BY po.biz_date DESC, po.id DESC`,
  );
  return rows.map((r) => ({ ...mapOrderRow(r), items: loadItems(Number(r.id)) }));
}

export function getPurchaseOrder(id: number): PurchaseOrder | undefined {
  const r = dbGet<Record<string, unknown>>(
    `SELECT po.id, po.supplier_id, s.name AS supplier_name, po.biz_date, po.mode, po.status,
            po.total_cents, po.edited_at, po.created_at
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
  items?: PurchaseItemInput[];
  sources?: PurchaseSourceRow[];
}): number {
  const supplier = dbGet<{ id: number }>(`SELECT id FROM suppliers WHERE id = ?`, [input.supplierId]);
  if (!supplier) throw new Error(`厂商不存在: id=${input.supplierId}`);
  const date = String(input.bizDate ?? '').slice(0, 10);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) throw new Error('日期格式不正确');

  return dbTransaction(() => {
    const items = input.items ?? [];
    // `mode` 列保留并恒写 'detail'（包价单分支 2026-10-20 按用户决定删除：
    // 真库 `mode='package'` 0 条、也没有创建入口，留着只是第四套金额口径）。
    // 列不删：SQLite 删列要重建表，收益为零；判据是"还有没有分支"，不是"列在不在"。
    const id = dbRun(
      `INSERT INTO purchase_orders (supplier_id, biz_date, mode, status, total_cents)
       VALUES (?, ?, 'detail', 'draft', ?)`,
      [input.supplierId, date, computeTotal(items)],
    ).lastInsertRowid;
    insertItems(id, items);
    // 锁定来源订单（店铺归属）；未显式提供时按订单缺口自动推导
    const sources = input.sources?.length
      ? sanitizeSources(input.sources)
      : autoSourceRows(items);
    if (sources.length) insertSources(id, sources);
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
      orderItemId: Math.max(0, Math.round(Number(s.orderItemId ?? 0)) || 0),
    });
  }
  return out;
}

/**
 * 按缺口自动推导来源订单行：对拿货单每个款色码，从 `oi_order_items` 中取**最靠前的未满足订单行**
 * 作为来源，**按件数**逐行分配，并记下 `order_item_id`（哪一行被覆盖）。
 *
 * 就是这张表让「哪张订单的货齐了」成为事实（2026-10-22）。三条口径：
 *
 *   1. **范围 = 未发货 + 非终结**（与 `outstanding()` 同一把尺子）。原来一条过滤都没有，
 *      会把这次拿货记到**已发货、甚至已取消**的订单上 —— 对店铺分摊只是少记，
 *      对"哪单齐了"就是**把别的单宣布成已齐**。
 *   2. **跳过按件、不按行**。`taken` 是件数、需求也按件（`SUM(COALESCE(NULLIF(qty,0),1))`），
 *      而原来 `skip -= 1` 每行只算 1 件 ⇒ 一单买 2 件时会多跳一行。
 *   3. **一条来源 = 一条订单行 × 覆盖件数**（`qty` 可以是 2），不再"每覆盖 1 件插一条 1 件的行"
 *      —— 同一行的件数必须是同一个数，否则店铺分摊按行数近似、逐单判定按件数精确，两套会打架。
 *
 * 需求行不够（拿多了）时，多出来的件**不记来源**（没有订单行可指），由 `orderCoverage()`
 * 归进「无归属台账」。无订单数据（未导入）时返回空数组，该单不参与店铺拆分。
 */
function autoSourceRows(items: PurchaseItemInput[], excludePurchaseId = 0): PurchaseSourceRow[] {
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
    // 该款色码已拿（**别的**已提交拿货单）：编辑一张已提交单时必须把自己排除掉，
    // 否则"自己已经拿的件数"会被当成别人拿的、再跳一遍 ⇒ 来源整体后移。
    const takenRow = dbGet<{ t: number }>(
      `SELECT COALESCE(SUM(pi.qty), 0) AS t
       FROM purchase_items pi JOIN purchase_orders po ON pi.purchase_id = po.id
       WHERE po.status = 'submitted' AND pi.purchase_id <> ? AND pi.style_code = ? AND pi.color = ? AND pi.size = ?`,
      [excludePurchaseId, code, color, size],
    );
    let skipLeft = Number(takenRow?.t ?? 0);
    // 需求订单行（按导入顺序 FIFO；范围与 outstanding() 一致）
    const n = styleNameJoin();
    const rows = dbQuery<Record<string, unknown>>(
      `SELECT oi.id AS oid, o.shop, s.code AS style_code, ${n.name} AS style_name,
              sc.color AS style_color, oi.size AS size,
              COALESCE(NULLIF(oi.qty, 0), 1) AS qty
       FROM oi_order_items oi
       JOIN oi_orders o ON o.id = oi.order_id
       LEFT JOIN oi_images i ON oi.image_id = i.id
       JOIN oi_style_colors sc ON sc.id = ${ITEM_STYLE_COLOR_ID}
       JOIN oi_styles s ON sc.style_id = s.id
       ${n.join}
       WHERE s.code = ? AND sc.color = ? AND oi.size = ?
         AND o.ship_time = '' AND oi.status <> 'shipped' AND NOT ${TERMINAL_BIZ_STATUS_SQL}
       ORDER BY oi.id`,
      [code, color, size],
    );
    let pushed = 0;
    for (const row of rows) {
      if (pushed >= need || out.length >= 5000) break;
      let avail = Math.max(1, Math.round(Number(row.qty ?? 1)));
      // 先按**件**跳过已被别的拿货单覆盖的部分（可能只吃掉这一行的一部分）
      if (skipLeft > 0) {
        const skipped = Math.min(skipLeft, avail);
        skipLeft -= skipped;
        avail -= skipped;
      }
      if (avail <= 0) continue;
      const take = Math.min(avail, need - pushed);
      if (take <= 0) continue;
      out.push({
        shop: String(row.shop ?? ''),
        styleCode: String(row.style_code ?? ''),
        styleName: String(row.style_name ?? ''),
        color: String(row.style_color ?? ''),
        size: String(row.size ?? ''),
        qty: take,
        orderItemId: Number(row.oid ?? 0) || 0,
      });
      pushed += take;
    }
  }
  return out;
}

function insertSources(purchaseId: number, sources: PurchaseSourceRow[]): void {
  for (const s of sources) {
    dbRun(
      `INSERT INTO purchase_sources (purchase_id, shop, style_code, style_name, color, size, qty, order_item_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
      [purchaseId, s.shop, s.styleCode, s.styleName ?? '', s.color, s.size, s.qty, s.orderItemId ?? 0],
    );
  }
}

/**
 * 编辑拿货单（草稿或已提交均可）：明细模式整体替换明细并重算金额；
 * 包价模式更新 totalCents。置 edited_at 留痕。
 */
export function updatePurchaseOrder(id: number, input: {
  bizDate?: string;
  totalCents?: number;
  items?: PurchaseItemInput[];
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
    if (input.items !== undefined) {
      dbRun(`DELETE FROM purchase_items WHERE purchase_id = ?`, [id]);
      insertItems(id, input.items);
      // 来源快照跟着明细重算（2026-10-22）：原来只重算明细、sources 留在开单那一刻，
      // 改了件数也不动 ⇒ 店铺分摊与"哪单齐了"都按旧数量说话。重算时把自己排除，
      // 否则已提交单的"自己拿的件数"会被当成别人拿的再跳一遍。
      dbRun(`DELETE FROM purchase_sources WHERE purchase_id = ?`, [id]);
      const sources = autoSourceRows(input.items, id);
      if (sources.length) insertSources(id, sources);
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
    `SELECT id, style_code, style_name, color, size, qty, price_cents, amount_cents, suggestion_qty, style_color_id
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
    styleColorId: Number(r.style_color_id ?? 0) || 0,
  }));
}

function insertItems(purchaseId: number, items: PurchaseItemInput[]): void {
  for (const it of items) {
    const qty = Math.max(0, Math.round(Number(it.qty ?? 0)));
    const price = Math.max(0, Math.round(Number(it.priceCents ?? 0)));
    const code = String(it.styleCode ?? '').trim().slice(0, 50);
    if (!code) continue;
    dbRun(
      `INSERT INTO purchase_items
         (purchase_id, style_code, style_name, color, size, qty, price_cents, amount_cents, suggestion_qty, style_color_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
        // 身份由调用方在开单那一刻带上（来自缺口行）；不带就 0，靠文本兜底，绝不现猜
        Math.max(0, Math.round(Number(it.styleColorId ?? 0))) || 0,
      ],
    );
  }
}

function computeTotal(items: PurchaseItemInput[]): number {
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
    // 包价单已删（2026-10-20）：老库里万一还有 package 行，一律按明细读（列还在，但不再有分支）
    mode: 'detail' as const,
    status: (r.status === 'submitted' ? 'submitted' : 'draft') as 'draft' | 'submitted',
    totalCents: Number(r.total_cents ?? 0),
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
 * **已拿台账**：所有**已提交**拿货单的明细 qty 合计，按款色码。
 *
 * ⚠️ 与 `outstanding()` 的分工（2026-10-17）：它是**台账**（拿过多少，拿齐了照样在），
 *    而 `outstanding()` 是**缺口**（还缺什么，缺为 0 的行不返回）—— 拿后者当台账用，
 *    "刚拿完"的那一行会被过滤掉 ⇒ 清单按已拿 0 算 ⇒ 卡永远停在待拿（用户实报，见 `TakenRow` 注释）。
 *    两者的"已拿"都从下面这条 SQL 来，口径只留一份。
 */
export function takenLedger(): TakenRow[] {
  return dbQuery<Record<string, unknown>>(
    `SELECT pi.style_color_id AS style_color_id, pi.style_code AS style_code, pi.color AS color,
            pi.size AS size, SUM(pi.qty) AS taken
     FROM purchase_items pi JOIN purchase_orders po ON pi.purchase_id = po.id
     WHERE po.status = 'submitted'
     GROUP BY pi.style_color_id, pi.style_code, pi.color, pi.size`,
  ).map((r) => ({
    styleColorId: Number(r.style_color_id ?? 0) || 0,
    styleCode: String(r.style_code ?? ''),
    color: String(r.color ?? ''),
    size: String(r.size ?? ''),
    taken: Number(r.taken ?? 0),
  }));
}

/**
 * 台账的两套键（2026-10-20）。
 *
 * **身份优先**：`style_color_id` 是拿货那一刻记下的款色行 id，改名/换色名都不会失联；
 * **文本兜底**：老明细（`style_color_id = 0`）只有文本，按 `款|色|码` 匹配。
 *
 * ⚠️ 两套必须**互斥**：带 id 的行只进 idMap，没 id 的行才进 textMap。
 * 否则同一行会被两边同时命中 → 已拿算两遍 → `missing` 提前变 0 → **漏货**。
 */
function takenMaps(): { byId: Map<string, number>; byText: Map<string, number> } {
  const byId = new Map<string, number>();
  const byText = new Map<string, number>();
  for (const r of takenLedger()) {
    if (r.styleColorId > 0) {
      const k = `${r.styleColorId}|${r.size}`;
      byId.set(k, (byId.get(k) ?? 0) + r.taken);
    } else {
      const k = `${r.styleCode}|${r.color}|${r.size}`;
      byText.set(k, (byText.get(k) ?? 0) + r.taken);
    }
  }
  return { byId, byText };
}

/**
 * 「不该再要求拿货」的状态原文（与渲染层 `bucketOfStatus` 的 closed/completed 同一口径）。
 *
 * 为什么在 SQL 里也写一份：需求必须与**拣货清单**同一范围，否则页签徽标与卡面永远对不上。
 * 清单的判定在渲染层（`src/lib/orderCost.bucketOfStatus`），主进程拿不到 → 这里用等价的
 * LIKE 条件表达，并由 `tests/orderStatusParity.spec.ts` 逐值比对两个实现（改一处就红）。
 * `biz_status` 为空 ⇒ 不属任何一类（照收）。
 */
const TERMINAL_BIZ_STATUS_SQL = `(
  o.biz_status LIKE '%关闭%' OR o.biz_status LIKE '%取消%' OR o.biz_status LIKE '%撤销%'
  OR LOWER(o.biz_status) LIKE '%cancel%' OR LOWER(o.biz_status) LIKE '%closed%'
  OR o.biz_status LIKE '%完成%' OR o.biz_status LIKE '%已收货%' OR o.biz_status LIKE '%交易成功%'
  OR LOWER(o.biz_status) LIKE '%complete%'
)`;

/**
 * 待拿货缺口 = max(0, 订单需求 − 已拿) − 已忽略。
 *
 * 需求 = `oi_orders` 未发货 + 非终结的行，按 **`style_color_id`（身份）+ 尺码** 求和件数；
 *        未归类（id=0）的行**照样参与**，按 (商品ID, 订单原文色, 码) 单列成组并标 `unclassified`
 *        —— 排除它们 = 悄悄少算一批真实要拿的货（真库 51 行里 9 行，18%）。
 * 已拿 = 已提交拿货单明细，**身份优先、文本兜底**（见 `takenMaps`）。
 * 已忽略 = `purchase_ignore` 标记的整款色。
 *
 * 三条口径修正（2026-10-20，简化审查 F1/F2/F4）：
 *   · 件数用 `SUM(COALESCE(qty,1))`，不再 `COUNT(*)`（一单买 2 件时按行数算会 `missing=-1` ⇒ 整行丢出缺口）；
 *   · 过滤未发货 + 非终结，与拣货清单同一范围（原来一条过滤都没有，已发货/关闭单永久挂在待拿）；
 *   · 需求侧改 LEFT JOIN（原来 INNER JOIN 把未归类行整批吞掉，与清单是两套事实）。
 */
export function outstanding(): OutstandingRow[] {
  const n = styleNameJoin();
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT COALESCE(s.code, '') AS style_code, ${n.name} AS style_name,
            COALESCE(sc.id, 0) AS style_color_id, COALESCE(sc.color, '') AS style_color,
            COALESCE(oi.color, '') AS color_raw, oi.size AS size,
            COALESCE(json_extract(oi.raw_fields, '$."产品ID"'), '') AS item_id,
            -- 件数 = 订单件数 × 每套几件（一套含两条裤子 = 2）。单品行 qty_per_set 恒为 1 ⇒ 老数据不变。
            -- orders 用 DISTINCT：套装展开成 N 行是**同一个订单行**，COUNT(*) 会把"几行在要"算成 N 倍。
            SUM(COALESCE(NULLIF(oi.qty, 0), 1) * v.qty_per_set) AS demand,
            COUNT(DISTINCT oi.id) AS orders
     FROM oi_order_items oi
     JOIN oi_orders o ON o.id = oi.order_id
     -- 款色从**同一份展开口径**取（ITEM_STYLE_COLOR_SRC）：一行订单行 → N 个款色（套装展开）。
     -- 这里不自己 JOIN 图：那会让套装只算成一个款，子商品永远不进拿货单。
     JOIN ${ITEM_STYLE_COLOR_SRC} v ON v.order_item_id = oi.id
     LEFT JOIN oi_style_colors sc ON sc.id = v.style_color_id
     LEFT JOIN oi_styles s ON sc.style_id = s.id
     ${n.join}
     WHERE o.ship_time = '' AND oi.status <> 'shipped' AND NOT ${TERMINAL_BIZ_STATUS_SQL}
     GROUP BY COALESCE(sc.id, 0), oi.size,
              CASE WHEN COALESCE(sc.id, 0) = 0 THEN COALESCE(json_extract(oi.raw_fields, '$."产品ID"'), '') ELSE '' END,
              CASE WHEN COALESCE(sc.id, 0) = 0 THEN COALESCE(oi.color, '') ELSE '' END`,
  );
  const { byId, byText } = takenMaps();
  const ignored = new Set(
    dbQuery<{ style_code: string; color: string }>(
      `SELECT style_code, color FROM purchase_ignore`,
    ).map((r) => `${r.style_code}|${r.color}`),
  );

  const result: OutstandingRow[] = [];
  for (const d of rows) {
    const styleColorId = Number(d.style_color_id ?? 0) || 0;
    const styleCode = String(d.style_code ?? '');
    const color = String(d.style_color ?? '');
    const size = String(d.size ?? '');
    const unclassified = styleColorId <= 0;
    if (!unclassified && ignored.has(`${styleCode}|${color}`)) continue;
    const demand = Number(d.demand ?? 0);
    // 身份优先；老明细（id=0）按文本兜底（只在"该款该色该码"完全相等时算数）
    const have = unclassified
      ? 0
      : (byId.get(`${styleColorId}|${size}`) ?? 0) + (byText.get(`${styleCode}|${color}|${size}`) ?? 0);
    const missing = demand - have;
    // 未归类组**永远返回**：它就是"还不准"的那部分，藏起来等于谎报已拿全
    if (!unclassified && missing <= 0) continue;
    result.push({
      styleCode,
      styleName: String(d.style_name ?? ''),
      styleColorId,
      color,
      size,
      demand,
      taken: have,
      missing: Math.max(0, missing),
      unclassified,
      itemIds: unclassified && d.item_id ? [String(d.item_id)] : [],
      colorRaw: unclassified ? String(d.color_raw ?? '') : '',
      orders: Number(d.orders ?? 0),
    });
  }
  result.sort((a, b) => Number(b.unclassified) - Number(a.unclassified) || b.missing - a.missing);
  return result;
}

/**
 * **逐行覆盖度**（2026-10-22）：这是「哪张订单的货齐了」的唯一事实来源。
 *
 * 返回两样东西：
 *   · `rows`：**未发货 + 非终结**订单的每一行明细，带上「已提交拿货单里指向本行的件数合计」
 *     （`covered`）。行的 id 是 `oi_order_items.id` —— 与 `purchase_sources.order_item_id` 同一空间。
 *   · `unattributed`：**无归属的已拿台账**（形状同 `takenLedger()`）。来源是那些
 *     `order_item_id = 0` 的拿货明细（加列之前的历史单 / 需求订单行不够、这次拿多了的尾巴）。
 *     它不能凭空丢掉（会让"已拿"变小、界面谎报还差），也不能硬摊到某一行（那是编造事实）
 *     ⇒ 交回渲染层，按款色码当"池子"用，并与 `covered` **相加时不重复**（两边互斥：
 *     一件货要么有订单行归属，进了 `covered`；要么没有，进了 `unattributed`）。
 *
 * 为什么不用 `outstanding()`：那个是「还缺什么」，缺为 0 的行会被它自己过滤掉
 * ⇒ 拿齐的行根本不返回，没法回答"这张单齐了"（`TakenRow` 注释里记的那次事故同一个坑）。
 * 为什么不用 `shippingRows()`：那个带 `limit` 且按导入日筛，这里是**全部未发货**、只要最小列。
 */
export function orderCoverage(): OrderCoveragePayload {
  const n = styleNameJoin();
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT oi.id AS order_item_id, o.order_no AS order_no, o.shop AS shop, o.order_time AS order_time,
            oi.raw_fields AS raw_fields, oi.qty AS qty, oi.size AS size,
            COALESCE(sc.id, 0) AS style_color_id, COALESCE(sc.color, '') AS style_color,
            COALESCE(oi.color, '') AS color_raw, COALESCE(s.code, '') AS style_code,
            ${n.name} AS style_name, COALESCE(oc.covered, 0) AS covered
       FROM oi_order_items oi
       JOIN oi_orders o ON o.id = oi.order_id
       LEFT JOIN oi_images i ON oi.image_id = i.id
       LEFT JOIN oi_style_colors sc ON sc.id = ${ITEM_STYLE_COLOR_ID}
       LEFT JOIN oi_styles s ON sc.style_id = s.id
       ${n.join}
       LEFT JOIN (
         SELECT ps.order_item_id AS oid, SUM(ps.qty) AS covered
           FROM purchase_sources ps JOIN purchase_orders po ON po.id = ps.purchase_id
          WHERE po.status = 'submitted' AND ps.order_item_id > 0
          GROUP BY ps.order_item_id
       ) oc ON oc.oid = oi.id
      WHERE o.ship_time = '' AND oi.status <> 'shipped' AND NOT ${TERMINAL_BIZ_STATUS_SQL}
      ORDER BY oi.id`,
  );

  // 无归属台账：已提交拿货明细的件数，减去**同一张单里已经指到订单行**的那部分。
  // 差额按款色码聚合 —— 有归属的不进这里，保证与 `covered` 相加不重复。
  const unattributed = dbQuery<Record<string, unknown>>(
    `WITH it AS (
       SELECT pi.purchase_id AS purchase_id, COALESCE(pi.style_color_id, 0) AS style_color_id,
              pi.style_code AS style_code, pi.color AS color, pi.size AS size, SUM(pi.qty) AS q
         FROM purchase_items pi JOIN purchase_orders po ON po.id = pi.purchase_id
        WHERE po.status = 'submitted'
        GROUP BY pi.purchase_id, COALESCE(pi.style_color_id, 0), pi.style_code, pi.color, pi.size
     ), at AS (
       SELECT ps.purchase_id AS purchase_id, ps.style_code AS style_code,
              ps.color AS color, ps.size AS size,
              SUM(CASE WHEN ps.order_item_id > 0 THEN ps.qty ELSE 0 END) AS attributed
         FROM purchase_sources ps
        GROUP BY ps.purchase_id, ps.style_code, ps.color, ps.size
     )
     SELECT it.style_color_id AS style_color_id, it.style_code AS style_code,
            it.color AS color, it.size AS size,
            SUM(MAX(0, it.q - COALESCE(at.attributed, 0))) AS taken
       FROM it LEFT JOIN at
         ON at.purchase_id = it.purchase_id AND at.style_code = it.style_code
        AND at.color = it.color AND at.size = it.size
      GROUP BY it.style_color_id, it.style_code, it.color, it.size
     HAVING SUM(MAX(0, it.q - COALESCE(at.attributed, 0))) > 0`,
  ).map((r) => ({
    styleColorId: Number(r.style_color_id ?? 0) || 0,
    styleCode: String(r.style_code ?? ''),
    color: String(r.color ?? ''),
    size: String(r.size ?? ''),
    taken: Number(r.taken ?? 0),
  }));

  return {
    rows: rows.map((r) => {
      let rawFields: Record<string, string> = {};
      try {
        const v = JSON.parse(String(r.raw_fields ?? '{}'));
        if (v && typeof v === 'object') rawFields = v as Record<string, string>;
      } catch {
        rawFields = {}; // 一条脏 raw_fields 只让这一行的件数走兜底，不该毁掉整张清单
      }
      const styleColorId = Number(r.style_color_id ?? 0) || 0;
      return {
        orderItemId: Number(r.order_item_id ?? 0) || 0,
        orderNo: String(r.order_no ?? ''),
        shop: String(r.shop ?? ''),
        orderTime: String(r.order_time ?? ''),
        styleCode: String(r.style_code ?? ''),
        styleName: String(r.style_name ?? ''),
        styleColorId,
        styleColor: String(r.style_color ?? ''),
        colorRaw: String(r.color_raw ?? ''),
        size: String(r.size ?? ''),
        qty: r.qty === null || r.qty === undefined ? null : Number(r.qty),
        rawFields,
        covered: Math.max(0, Number(r.covered ?? 0)),
        unclassified: styleColorId <= 0,
      };
    }),
    unattributed,
  };
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

// ---- 成本快照（只读导出：拿货明细按 款 × 拿货日 加权；不向渲染层透传本模块） ----

/** 快照项：款编码 × 拿货日期 → 加权均价（分/件，按已提交拿货单明细数量加权） */
export interface CostSnapshotItem {
  styleCode: string;
  styleName: string;
  /** 参与统计的拿货件数（该款该日） */
  sampleCount: number;
  /** 加权单价（分） = Σ(qty×price_cents) / Σqty，取整 */
  weightedPriceCents: number;
  /**
   * 该行的拿货日期（yyyy-mm-dd，无则空串）。
   *
   * ⚠️ 语义在 P4a 变了：改造前是「该款**最近一次**拿货日期」（`MAX(biz_date)`，一款一行），
   * 现在是「**本行**的拿货日期」（一款可多行，一行 = 一个成本区间）。
   */
  lastBizDate: string;
}

/**
 * 成本快照（单向只读）：从「已提交」拿货单明细按 **款编码 × 拿货日期** 聚合，
 * 输出款编码 → 多行加权均价（分）。不暴露本模块任何写能力；
 * 口径 = 按次拿货加权均价（M1 简化，不计颜色/尺码差异）。
 *
 * ⚠️ P4a 之前是 `GROUP BY pi.style_code` + `MAX(biz_date)`：一款只导出一行、且生效日取最新，
 * 于是「同一款跨两次进货」只剩一条区间 —— 历史毛利复算不出来。现按拿货日分组保留多行。
 */
export function costSnapshot(): CostSnapshotItem[] {
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT pi.style_code, pi.style_name, po.biz_date AS biz_date, SUM(pi.qty) AS qty, SUM(pi.amount_cents) AS amount_cents
     FROM purchase_items pi
     JOIN purchase_orders po ON pi.purchase_id = po.id
     WHERE po.status = 'submitted' AND pi.qty > 0 AND pi.amount_cents > 0
     GROUP BY pi.style_code, po.biz_date
     ORDER BY pi.style_code, po.biz_date`,
  );
  return rows
    .map((r) => {
      const qty = Number(r.qty ?? 0);
      const amount = Number(r.amount_cents ?? 0);
      if (qty <= 0) return null;
      return {
        styleCode: String(r.style_code ?? ''),
        styleName: String(r.style_name ?? ''),
        sampleCount: qty,
        weightedPriceCents: Math.round(amount / qty),
        lastBizDate: String(r.biz_date ?? ''),
      };
    })
    .filter((x): x is CostSnapshotItem => x !== null);
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
