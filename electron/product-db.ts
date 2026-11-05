// electron/product-db.ts
// 「产品库」主数据数据访问层（基于 electron/db.ts 公共层），随主程序分发。
//
// 定位（ADR-002）
//   产品/款式属**主数据层**：schema 与写入权挂宿主中立层（C3），不挂在可卸载的市场 UI 岛上 ——
//   卸载视图岛不改变任何一个消费方的数据供给；跨域消费靠共享只读域 `product` 开口子（C4）。
//
// 编码锚点（C2）
//   pl_products.code 与既有链路同口径：oi_styles.code → purchase_items.style_code →
//   （曾用的款级价目表已退役）。后续「店铺商品 ID → 产品」映射与订单自动关联以此为唯一关联键，
//   不引入第二套编码。关联一律用 id，名称仅作展示（厂家名即由 supplier_id 派生，不入本表）。
//
// 本层**不做**的事（避免过度设计 / 避免第二套口径）
//   1. 成本**不再**只做展示：2026-10-21（C2）起「当前进价」= `pl_products.cost_cents`，
//      由本域维护（产品页 / 导入 / 抽屉）。旧款级区间价目表 `ae_cost_map` 已退役删除；
//      历史成本落在订单明细行（预估 / 实际进价两字段），不回写本表。
//   2. 厂家不在此建表：权威表是采购域 suppliers，本层只存 supplier_id。
//
// 安全边界
//   本层只允许主进程内部使用；渲染层与 UI 岛一律经语义化 IPC / db 能力域访问，
//   禁止把 SQL 透传给渲染层（AGENTS.md §1.7）。

export {};

import {
  initDb,
  dbMigrate,
  dbGet,
  dbRun,
  dbQuery,
  dbTransaction,
  migrate,
  tableSql,
  tableExists,
  type DbBindValue,
  type MigrationStep,
} from './db';
import { toNameKey } from './shopName';
import { shopIdByItemId, itemShopIndex, skuColorByItemImage } from './shop-item-db';
import {
  bindingKey,
  buildQueueView,
  extractSkuFields,
  toSkuKey,
  type QueueRow,
  type QueueStats,
  type SkuOrderRow,
} from './shopSku';
// 色号归一只留一份：套装配色与单品别名的键必须同口径，否则同一个 `8` 在两处算两个键
import { colorAliasKey } from './colorAlias';
// 图片主数据（唯一图片仓，R1）：本域**只读**它（款主图 / 商品图池取 local_path），
// 登记新图一律走 `registerImageRow`（二进制落盘只有 `landImageBytes` 一个入口）。
import {
  ensureMasterDataSchema,
  imageIdExists,
  imageLocalPathMap,
  registerImageRow,
} from './master-data-db';

// ---- 类型（与渲染层 src/types.ts 对应结构保持一致；两端各自声明，避免主进程 import 渲染层） ----

/** 产品状态：在售 / 停用（停用仅标记，不物理删除 —— 编码一经使用永不复用） */
export type ProductStatus = 'active' | 'archived';
export const PRODUCT_STATUSES: readonly ProductStatus[] = ['active', 'archived'];

export interface ProductListItem {
  id: number;
  /** 内部编码（锚点，不可改后复用） */
  code: string;
  name: string;
  /** 关联厂家 suppliers(id)；0 = 未关联 */
  supplierId: number;
  /** 厂家名（由 supplier_id 派生，非本表字段 —— 避免同一语义两个写入者，ADR-002 C1） */
  supplierName: string;
  category: string;
  status: string;
  note: string;
  /** 主图 `md_images.id`；0 = 未设置。走窄接口 imageAttach/detach 维护，不进 upsertProduct */
  imageId: number;
  /** 主图缓存路径（由 image_id 派生；'' = 无图。渲染层经 order-image-thumb/读图通道展示） */
  imagePath: string;
  /** **当前进价**（分；0 = 未填）。产品级维护入口，供产品页展示 + 新订单默认进价。
   *  ⚠️ 只管"现在多少钱"；订单行快照（`oi_order_items.cost_cents`）管"那单当时多少钱"。 */
  costCents: number;
  createdAt: string;
  updatedAt: string;
}

/** 新增/更新入参（**全量提交**语义，与 shop-account-upsert 一致：缺省即空，不做局部 patch）
 *  ⚠️ 唯一例外是 `costCents`：**未传即保留**（`undefined` 不覆盖）。理由见 `upsertProduct` 注释 ——
 *  进价是钱，被一次"只改了个名字"的全量提交清成 0 是最贵的一类静默事故。 */
export interface ProductUpsertInput {
  /** 0 / 缺省 = 新增 */
  id: number;
  code: string;
  name: string;
  supplierId: number;
  category: string;
  status: string;
  note: string;
  /** 当前进价（分）。`undefined` = 不修改（新增时落 0） */
  costCents?: number;
}

export interface ProductSummary {
  total: number;
  byStatus: { status: string; count: number }[];
  /** 已关联厂家的产品数分布（供筛选下拉 / 覆盖率提示） */
  supplierOptions: { id: number; name: string; productCount: number }[];
  /** 未关联厂家的产品数 */
  withoutSupplier: number;
}

// ---- 表结构 ----

const SCHEMA = [
  // `pl_products`：产品 / 款式主数据（product 域，一行 = 一个可管理的产品），PK `id`、业务编码 `code` 唯一。
  // `supplier_id` 软关联 `suppliers`（无外键）；`image_id` → `md_images`（主数据域图片仓）；`cost_cents` 是**当前进价**（不是历史）。
  // 写 = 产品库编辑 / 套装子商品；读 = 商品映射（`pl_shop_sku.product_id`）、订单归类、成本与利润估算。
  `CREATE TABLE IF NOT EXISTS pl_products (
    -- 用途：产品/款式主数据（product 域，code 唯一）；cost_cents 是当前进价，历史成本看订单行。供应商为软关联。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL DEFAULT '',
    supplier_id INTEGER NOT NULL DEFAULT 0,
    category TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    note TEXT NOT NULL DEFAULT '',
    image_id INTEGER NOT NULL DEFAULT 0,
    cost_cents INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pl_products_supplier ON pl_products(supplier_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pl_products_status ON pl_products(status)`,
  // `pl_size_shift`：**亚洲款加码**（款级码位偏移，一行 = 一个款）。
  // 为什么不塞进 `pl_products`：`ProductUpsertInput` 是**全量提交**语义（缺省即空），
  // 多加一列就会被"只改了个名字"的提交清成 0 —— 与 `cost_cents` 必须开 `undefined=不覆盖`
  // 特例是同一类事故。主图已经走 `imageAttach` 窄接口，本表同理：一个写入口、一个读入口。
  // 键是 `style_code`（跨域锚点 `oi_styles.code ≡ pl_products.code`，见文件头"编码锚点"），
  // 不要求该款已入库 —— 拿货页上发现"这牌是亚洲款"时，款可能还没建产品行。
  `CREATE TABLE IF NOT EXISTS pl_size_shift (
    -- 用途：款级码位偏移（亚洲款拿货要加 1-3 码）；读 = 拣货/需求换算，写 = 产品抽屉 / 拿货页。
    style_code TEXT PRIMARY KEY,
    shift INTEGER NOT NULL DEFAULT 0,
    note TEXT NOT NULL DEFAULT '',
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
];

/**
 * 幂等补列（**老库**）—— `image_id` / `cost_cents` 只写进了 CREATE TABLE 的话老库永远拿不到它
 * （`CREATE TABLE IF NOT EXISTS` 对已存在的表一个字都不改）。判定用 `PRAGMA table_info`。
 *
 * `cost_cents`（2026-10-21）：产品**当前进价**（分）。权威口径从 `ae_cost_map`（款级 + 生效区间，
 * 已退役删除）迁到本列 —— 本列只答"现在多少钱"；"那单当时多少钱"由订单行两个字段回答
 * （`oi_order_items.cost_cents` 归类确认时钉住 / `actual_cost_cents` 拿货落账回写）。
 */
function ensureProductColumns(): void {
  const cols = new Set(
    dbQuery<{ name: string }>(`PRAGMA table_info(pl_products)`).map((r) => String(r.name ?? '')),
  );
  if (!cols.has('image_id')) {
    dbRun(`ALTER TABLE pl_products ADD COLUMN image_id INTEGER NOT NULL DEFAULT 0`);
  }
  if (!cols.has('cost_cents')) {
    dbRun(`ALTER TABLE pl_products ADD COLUMN cost_cents INTEGER NOT NULL DEFAULT 0`);
  }
}

/**
 * 套装 = 产品**关联子商品**。子商品本来就是独立的 `pl_products` 行（能单独卖、有自己的
 * 变体/成本/图片/订单），本表只存"关联关系"，**不复制子商品的任何字段** ——
 * 复制一份就是第二个真相：改子商品的价格或名称时，套装那份会静默过期。
 *
 * 为什么关联键里必须有 **`alias_key`（平台色号）**：
 *   关联的不是"这个套装 ↔ 那些子商品"，而是"**这个套装的这个色号** ↔ 那些子商品的那些颜色"。
 *   套装自由搭配（同一款：色号 8 = 红上衣+黑裤，色号 9 = 黑上衣+黑裤），少了色号这一列，
 *   两个色号会拆成同一堆东西 —— 拿货单上颜色就没了。而平台色号是商品级编号
 *   （真库实测 `"8"`，见 `pl_shop_items.sku_json`），名字里没有语义可推，只能人认一次。
 *
 * 不建 `pl_products.kind='bundle'`：**"是不是套装"= 有没有关联行**，这是派生事实。
 * 写成列就会出现"删了关联忘改 kind"的第二个真相。
 *
 * `item_id`：'' = 该套装产品所有商品通用；非空 = 只有这个平台商品这么配
 *（同款套装的不同供货商品可能用各自的色号体系）。
 */
const BUNDLE_SCHEMA = [
  `CREATE TABLE IF NOT EXISTS pl_bundle_links (
    -- 用途：套装关联（套装产品×商品×平台色号→子产品/子色/数量）；只存关系，不复制子商品字段（避免第二个真相）。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    item_id TEXT NOT NULL DEFAULT '',
    alias_key TEXT NOT NULL,
    role TEXT NOT NULL,
    child_product_id INTEGER NOT NULL,
    child_color TEXT NOT NULL,
    qty INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(product_id, item_id, alias_key, role)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_pl_bundle_links_product ON pl_bundle_links(product_id)`,
  `CREATE INDEX IF NOT EXISTS idx_pl_bundle_links_child ON pl_bundle_links(child_product_id)`,
];

/** 幂等初始化（视图首次激活 / 每个 handler 入口调用） */
export function ensureProductSchema(): void {
  initDb();
  dbMigrate(SCHEMA);
  dbMigrate(BUNDLE_SCHEMA);
  ensureProductColumns();
}

/**
 * `pl_products` 是否已就绪 —— 供**其它域**（订单归类 / 采购）在派生款式名前问一句。
 * 导出而不是让各域自己写 `sqlite_master` 查询：口径只留一份，表名改动时不会漏掉某一处，
 * 而漏掉那处的症状是"查询直接抛错"，看起来像自己的 SQL 坏了 —— 排查方向整个反掉。
 */
export function productSchemaReady(): boolean {
  return !!dbGet(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'pl_products'`);
}

// ---- 亚洲款加码（`pl_size_shift`）：一个读口、一个写口 ----------------------------------
//
// 为什么独立窄接口而不进 `upsertProduct`：那边是**全量提交**，产品抽屉"只改了个名字"的
// 提交会把加码清成 0（`cost_cents` 已经因此开过 `undefined=不覆盖` 的特例）。偏移量是
// "拿货照哪个码拿"的经营规则，改动频率和产品档案完全不同，混在一起必然互相误伤。
//
// 偏移的**换算**不在这里做：主进程只存数字，`size → 下一个码` 的判定只写一份
// （`src/lib/sizeShift.ts`，有单测）。主进程 import 不了渲染层（两套 tsconfig），
// 所以本文件只回"这款偏几码"和"这款有哪些码"，判断留给上层。

/** 允许的偏移范围（与 `src/lib/sizeShift.ts` 的 `MAX_SIZE_SHIFT` 同口径；负数是给"偏大减码"留的位） */
const SIZE_SHIFT_LIMIT = 3;

/** 全部**非 0** 的加码配置（款编码 → 码位数）。0 的款不落库，这里也就不会出现。 */
export function sizeShiftMap(): Record<string, number> {
  ensureProductSchema();
  const out: Record<string, number> = {};
  for (const r of dbQuery<Record<string, unknown>>(
    `SELECT style_code, shift FROM pl_size_shift WHERE shift <> 0`
  )) {
    const code = String(r.style_code ?? '').trim();
    const n = Math.trunc(Number(r.shift) || 0);
    if (code && n) out[code] = n;
  }
  return out;
}

/**
 * 码链：款编码 → 该款 SKU 矩阵里出现过的码（**升序由调用方排**）。
 *
 * 用途：数字码/异形码（`170/92A`）的"下一个码"只能看这款实际有哪些码，
 * 靠字典猜会把 38 的下一个码算错。矩阵没建/没采到的款返回空数组 ⇒ 调用方回落字典规则。
 */
export function sizeChains(codes: unknown): Record<string, string[]> {
  ensureProductSchema();
  const list = Array.isArray(codes)
    ? [...new Set(codes.map((c) => String(c ?? '').trim()).filter(Boolean))].slice(0, 500)
    : [];
  const out: Record<string, string[]> = {};
  if (!list.length || !tableExists('pl_variants')) return out;
  const ph = list.map(() => '?').join(',');
  for (const r of dbQuery<Record<string, unknown>>(
    `SELECT p.code AS code, v.size AS size
       FROM pl_variants v JOIN pl_products p ON p.id = v.product_id
      WHERE p.code IN (${ph}) AND v.size <> ''
      GROUP BY p.code, v.size`,
    list
  )) {
    const code = String(r.code ?? '');
    const size = String(r.size ?? '');
    if (!code || !size) continue;
    (out[code] ??= []).push(size);
  }
  return out;
}

/**
 * 写一款的加码偏移。`0` = 取消（**删行**，不留"0 的行"—— 否则以后没法用"表里有没有这行"
 * 判断"这款是不是设过"，而那种判断迟早会被写成业务条件）。
 *
 * 只接受 `-3..3` 的整数：偏移写错一位就是拿错一个码的货，宁可报错也不截断。
 */
export function setSizeShift(input: unknown): { styleCode: string; shift: number } {
  ensureProductSchema();
  const o = (input ?? {}) as Record<string, unknown>;
  const code = str(o.styleCode, MAX.code);
  if (!code) throw new Error('款编码不能为空');
  const n = Math.trunc(Number(o.shift ?? 0));
  if (!Number.isFinite(n) || Math.abs(n) > SIZE_SHIFT_LIMIT) {
    throw new Error(`加码只能是 -${SIZE_SHIFT_LIMIT}…${SIZE_SHIFT_LIMIT} 的整数`);
  }
  if (n === 0) {
    dbRun(`DELETE FROM pl_size_shift WHERE style_code = ?`, [code]);
  } else {
    dbRun(
      `INSERT INTO pl_size_shift (style_code, shift, note, updated_at)
       VALUES (?, ?, ?, datetime('now','localtime'))
       ON CONFLICT(style_code) DO UPDATE SET
         shift = excluded.shift, note = excluded.note, updated_at = excluded.updated_at`,
      [code, n, str(o.note, MAX.note)]
    );
  }
  return { styleCode: code, shift: n };
}

// ---- 字段规整 ----

const MAX = {
  code: 64,
  name: 200,
  category: 60,
  status: 20,
  note: 2000,
  search: 200,
} as const;

/** 列表单页上限（分页在主进程做，避免全量塞渲染层） */
const MAX_LIST_LIMIT = 500;
const DEFAULT_LIST_LIMIT = 50;

function str(v: unknown, max: number): string {
  return typeof v === 'string' ? v.slice(0, max).trim() : '';
}

/** 解析正整数 id（非法返回 0） */
function toId(v: unknown): number {
  return typeof v === 'number' && Number.isInteger(v) && v > 0 && v <= 2147483647 ? v : 0;
}

/** 状态白名单（非法/缺省 → active；更新场景由 handler 保证全量提交） */
function normStatus(v: unknown): ProductStatus {
  const s = str(v, MAX.status);
  return (PRODUCT_STATUSES as readonly string[]).includes(s) ? (s as ProductStatus) : 'active';
}

// ---- 厂家名派生（跨域读 suppliers；表未建时降级为空名，不报错） ----

function suppliersTableReady(): boolean {
  return !!dbGet(`SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'suppliers'`);
}

function supplierNameMap(): Map<number, string> {
  const m = new Map<number, string>();
  if (!suppliersTableReady()) return m;
  for (const r of dbQuery<Record<string, unknown>>(`SELECT id, name FROM suppliers`)) {
    m.set(Number(r.id) || 0, String(r.name ?? ''));
  }
  return m;
}

// ---- 查询 ----

function num(v: unknown): number {
  return v !== undefined && v !== null ? Number(v) || 0 : 0;
}

const COLS = `id, code, name, supplier_id, category, status, note, image_id, cost_cents, created_at, updated_at`;

/** image_id → 缓存路径（`md_images` 未建表/无行时降级为空，不报错） */
function imagePathMap(imageIds: number[]): Map<number, string> {
  return imageLocalPathMap(imageIds);
}

function mapRow(row: Record<string, unknown>, supplierNames: Map<number, string>, imagePaths?: Map<number, string>): ProductListItem {
  const supplierId = num(row.supplier_id);
  const imageId = num(row.image_id);
  return {
    id: num(row.id),
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    supplierId,
    supplierName: supplierNames.get(supplierId) ?? '',
    category: String(row.category ?? ''),
    status: String(row.status ?? 'active'),
    note: String(row.note ?? ''),
    imageId,
    imagePath: imagePaths?.get(imageId) ?? '',
    costCents: num(row.cost_cents),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

/** 列表（关键字 / 状态 / 厂家过滤 + 分页；按编码升序，符合主数据查阅习惯） */
export function listProducts(payload: {
  offset: number;
  limit: number;
  search: string;
  status: string;
  supplierId: number;
  /** 只看"未关联厂家"的款（= `supplier_id = 0`）。与 `supplierId` 互斥，同时给时以本项为准。 */
  withoutSupplier?: boolean;
  /** 只看"至少有一个 SKU 缺克重"的款。 */
  onlyMissingWeight?: boolean;
  /** 只看"还没维护进价"的款（`cost_cents` 为 NULL 或 <= 0）。 */
  onlyMissingCost?: boolean;
}): { rows: ProductListItem[]; total: number } {
  const search = str(payload?.search, MAX.search);
  const status = str(payload?.status, MAX.status);
  const supplierId = toId(payload?.supplierId);

  const where: string[] = [];
  const params: (string | number)[] = [];
  if (search) {
    where.push(`(code LIKE ? OR name LIKE ? OR category LIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, like);
  }
  if ((PRODUCT_STATUSES as readonly string[]).includes(status)) {
    where.push(`status = ?`);
    params.push(status);
  }
  // 四个筛选互斥（界面上也做成互斥的开关），优先级：未关联厂家 > 指定厂家 > 缺克重 > 缺进价
  if (payload?.withoutSupplier === true) {
    where.push(`supplier_id = 0`);
  } else if (supplierId) {
    where.push(`supplier_id = ?`);
    params.push(supplierId);
  } else if (payload?.onlyMissingWeight === true) {
    // 过滤放在 SQL 里而不是渲染层：分页是服务端做的，客户端过滤会把
    // 「第 2 页之后的缺克重款」藏起来 —— 界面显示"没有"而数据里有一堆。
    where.push(
      `EXISTS (SELECT 1 FROM pl_variants v WHERE v.product_id = pl_products.id ` +
        `AND (v.weight_g IS NULL OR v.weight_g <= 0))`
    );
  } else if (payload?.onlyMissingCost === true) {
    // 同源理：缺进价清单是「基础数据 › 进价」页退场后的承接能力，
    // 必须在服务端筛（当前价 0 一律视为未维护，与库层 / 列表列口径一致）。
    where.push(`(cost_cents IS NULL OR cost_cents <= 0)`);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const offset = Math.max(0, Math.floor(Number(payload?.offset) || 0));
  const limit = Math.min(
    MAX_LIST_LIMIT,
    Math.max(1, Math.floor(Number(payload?.limit) || DEFAULT_LIST_LIMIT))
  );

  const rowsRaw = dbQuery<Record<string, unknown>>(
    `SELECT ${COLS} FROM pl_products ${whereSql} ORDER BY code ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const totalRow = dbGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM pl_products ${whereSql}`,
    params
  );
  const names = supplierNameMap();
  const imagePaths = imagePathMap(rowsRaw.map((r) => num(r.image_id)));
  return {
    rows: rowsRaw.map((r) => mapRow(r, names, imagePaths)),
    total: totalRow ? num(totalRow.c) : 0,
  };
}

/** 单条详情（不存在返回 null） */
export function getProduct(id: number): ProductListItem | null {
  const pid = toId(id);
  if (!pid) return null;
  const row = dbGet<Record<string, unknown>>(`SELECT ${COLS} FROM pl_products WHERE id = ?`, [pid]);
  if (!row) return null;
  return mapRow(row, supplierNameMap(), imagePathMap([num(row.image_id)]));
}

// ---- 写入 ----

/**
 * 新增 / 更新（全量提交）。
 * 编码唯一性是硬约束：与其它记录冲突时**明确抛错**，不静默改名或静默覆盖 ——
 * 编码是订单/采购/成本三域的关联键，静默变更会让历史数据指向另一个产品。
 *
 * ⚠️ `costCents` 是**唯一**不遵守"全量提交"的字段：**未传（`undefined`）= 不修改**。
 *    为什么破例：进价是钱，而本函数被"改名 / 改厂家 / 导出→导回"等多条路径共用，
 *    只要有一条没传进价就把它清成 0，利润会凭空变好看且**不报错**（本项目最贵的一类静默失效）。
 *    显式传 `0` 仍然等于"清零"——"没说"与"说它是 0"必须能分开。
 *
 * @returns { id, created } created=false 表示更新既有记录
 */
export function upsertProduct(input: ProductUpsertInput): { id: number; created: boolean } {
  const code = str(input?.code, MAX.code);
  if (!code) throw new Error('产品编码不能为空');

  const id = toId(input?.id);
  const fields = [
    code,
    str(input?.name, MAX.name),
    toId(input?.supplierId),
    str(input?.category, MAX.category),
    normStatus(input?.status),
    str(input?.note, MAX.note),
  ] as const;

  // 进价：undefined / null = 不修改；显式数值才写（含 0）。非法值**报错不猜**（进价直通利润链路）。
  const costProvided = input?.costCents !== undefined && input?.costCents !== null;
  let costCents = 0;
  if (costProvided) {
    const n = Number(input.costCents);
    if (!Number.isFinite(n) || n < 0) throw new Error('进价必须是不小于 0 的整数（分）');
    costCents = Math.round(n);
  }

  // 更新（id > 0）时先确认目标存在，再查编码占用 ——
  // 顺序反了会让「改一个已被删除的产品」报成「编码已存在」，把真正原因盖住。
  if (id && !dbGet<{ id: number }>(`SELECT id FROM pl_products WHERE id = ?`, [id])) {
    throw new Error('产品不存在或已被删除');
  }

  const dup = dbGet<{ id: number }>(`SELECT id FROM pl_products WHERE code = ? AND id <> ?`, [
    code,
    id,
  ]);
  if (dup) throw new Error(`产品编码已存在：${code}`);

  if (id) {
    if (costProvided) {
      dbRun(
        `UPDATE pl_products SET code=?, name=?, supplier_id=?, category=?, status=?, note=?, cost_cents=?, updated_at=datetime('now','localtime') WHERE id=?`,
        [...fields, costCents, id]
      );
    } else {
      dbRun(
        `UPDATE pl_products SET code=?, name=?, supplier_id=?, category=?, status=?, note=?, updated_at=datetime('now','localtime') WHERE id=?`,
        [...fields, id]
      );
    }
    return { id, created: false };
  }

  const info = dbRun(
    `INSERT INTO pl_products (code, name, supplier_id, category, status, note, cost_cents) VALUES (?,?,?,?,?,?,?)`,
    [...fields, costCents]
  );
  return { id: info.lastInsertRowid, created: true };
}

/**
 * 只改一款的**当前进价**（按款编码定位、只写一列，`renameProduct` 同一手法）。
 *
 * 用途（C2 起）：成本面板逐款改价 / 产品导入随行写入。产品表的当前价只影响**此后归类确认的
 * 新单**（预估快照从它拷贝），不回写任何历史订单行。
 *
 * @returns `found=false` 表示该编码在产品库里没有产品行（价没落下 —— 调用方必须如实报出来，
 *          不要静默吞掉：那正是"改了价、产品列表没变"这类失效的温床）。
 *          `updated=false` = 值本来就相同（幂等，不产生写入）。
 */
export function setProductCostByCode(
  code: string,
  costCents: number,
): { found: boolean; updated: boolean } {
  const c = str(code, MAX.code).trim();
  const cents = Math.max(0, Math.round(Number(costCents) || 0));
  if (!c) return { found: false, updated: false };
  if (!tableExists('pl_products')) return { found: false, updated: false };
  const info = dbRun(
    `UPDATE pl_products SET cost_cents = ?, updated_at = datetime('now','localtime')
      WHERE code = ? AND cost_cents <> ?`,
    [cents, c, cents],
  );
  return {
    found: !!dbGet<{ id: number }>(`SELECT id FROM pl_products WHERE code = ?`, [c]),
    updated: info.changes > 0,
  };
}

/**
 * 有当前进价的款编码（`cost_cents > 0`）。
 *
 * 为什么单独一个只读投影：「今天」的缺口卡只想知道"这些款有没有价"，
 * 而 `productList` 一次最多 500 条 —— 为这一个判断翻 40 页产品，代价远大于一条 SQL。
 * 返回的是**编码集合**，不是金额（金额各页自己读产品行，别在这里再算一份）。
 */
export function listPricedProductCodes(): string[] {
  if (!tableExists('pl_products')) return [];
  return dbQuery<{ code: string }>(
    `SELECT code FROM pl_products WHERE cost_cents > 0 ORDER BY code ASC`
  ).map((r) => String(r.code ?? ''));
}

/**
 * 只改展示名（D1 落地后，款式/产品的改名统一落到这里）。
 *
 * 为什么不用 `upsertProduct`：它是**全量提交**语义 —— 只传 `{ code, name }` 会把既有的
 * 厂家 / 类目 / 状态 / 备注一起重置成默认值。这种静默清空比直接报错更难发现。
 *
 * @returns changed=false 表示该编码尚无产品（调用方自行决定要不要补建）
 */
export function renameProduct(code: string, name: string): { changed: boolean } {
  const c = str(code, MAX.code);
  if (!c) return { changed: false };
  const info = dbRun(
    `UPDATE pl_products SET name = ?, updated_at = datetime('now','localtime') WHERE code = ?`,
    [str(name, MAX.name), c]
  );
  return { changed: info.changes > 0 };
}

/**
 * 改一款的厂家（拣货宫格里"把 SKU 拖到别家"的写入口；`supplierId` 0 = 清空关联）。
 *
 * 为什么单独一个窄函数、按 **code** 收：拣货清单手上只有款编码（跨域关联锚点），
 * 而 `batchUpdateProducts` 按产品 id 收 —— 渲染层为此先查一遍 id 只会多一轮往返
 * 和一个"查到了但已被删"的中间态。与 `renameProduct` 同一手法（code 定位、只改一列）。
 *
 * 覆盖规则（照 `adoptProduct` 的语义，别退化成裸 upsert）：
 *   · 该编码**没有产品行** → 新建（只落 code + supplier_id）—— 未建档的款也能拖：
 *     它正因没有 `pl_products` 行才落在拣货清单的「未指定厂家」里，不给建就等于拖不动；
 *   · 已有产品 → **只改 supplier_id**，name/category/status/note 一律不碰
 *     （全量 upsert 会把没展示的列按默认值重置，静默清空比报错更难查）；
 *   · `supplierId > 0` 时校验厂家存在（suppliers 表属采购域、未建表时降级放行，
 *     与 `batchUpdateProducts` 同口径）。
 *
 * @returns changed=false = 目标厂家与原厂家相同（没有可改的；调用方据此说"没有变化"）
 */
export function moveProductSupplier(code: string, supplierId: number): { changed: boolean } {
  ensureProductSchema();
  const c = str(code, MAX.code);
  if (!c) throw new Error('款编码不能为空');
  const sid = toId(supplierId);
  if (sid && suppliersTableReady()) {
    if (!dbGet(`SELECT id FROM suppliers WHERE id = ?`, [sid])) {
      throw new Error(`厂家不存在或已被删除：#${sid}`);
    }
  }
  const existing = dbGet<{ id: number; supplier_id: number }>(
    `SELECT id, supplier_id FROM pl_products WHERE code = ?`,
    [c]
  );
  if (existing) {
    if (num(existing.supplier_id) === sid) return { changed: false };
    const info = dbRun(
      `UPDATE pl_products SET supplier_id = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
      [sid, toId(existing.id)]
    );
    return { changed: info.changes > 0 };
  }
  dbRun(`INSERT INTO pl_products (code, supplier_id) VALUES (?, ?)`, [c, sid]);
  return { changed: true };
}

/**
 * 从**其它域**交接一个款式进产品库（ADR-002 D1：`pl_products` 是款式主数据唯一权威）。
 * 调用方是订单归类的「识别建款 / 款式导入」—— 它们手上只有 `code` + 一个**建议名**。
 *
 * 覆盖规则（这是本函数存在的理由，别退化成裸 upsert）：
 *   · 该编码尚无产品 → 新建（建议名首次落地时采用）；
 *   · 已有产品 → 默认**不覆盖** name（识别结果不得盖掉人工维护的主数据），
 *     只在主数据名为空时补位；`overwriteName: true` 仅给「产品库 Excel 导入」这种
 *     **显式的产品库写入**语义用。
 *   · 其余字段（厂家 / 类目 / 状态 / 备注）一律不动 —— 故走窄接口 `renameProduct`
 *     而不是整行 upsert（后者会把它们按默认值重置，静默清空比报错更难查）。
 */
export function adoptProduct(
  input: { code: string; name?: string },
  opts?: { overwriteName?: boolean }
): { id: number; created: boolean; renamed: boolean } {
  const code = str(input?.code, MAX.code);
  if (!code) throw new Error('产品编码不能为空');
  const name = str(input?.name, MAX.name);

  const existing = dbGet<{ id: number; name: string }>(`SELECT id, name FROM pl_products WHERE code = ?`, [code]);
  if (!existing) {
    const info = dbRun(`INSERT INTO pl_products (code, name) VALUES (?, ?)`, [code, name]);
    return { id: Number(info.lastInsertRowid), created: true, renamed: false };
  }
  const shouldRename = !!opts?.overwriteName || (!String(existing.name ?? '').trim() && name.length > 0);
  if (!shouldRename) return { id: Number(existing.id), created: false, renamed: false };
  renameProduct(code, name);
  return { id: Number(existing.id), created: false, renamed: true };
}

/** 删除（物理删除；仅用于录错的记录。已进入业务链路的产品应改为 status='archived'） */
export function deleteProduct(id: number): { deleted: boolean } {
  const pid = toId(id);
  if (!pid) return { deleted: false };
  const info = dbRun(`DELETE FROM pl_products WHERE id = ?`, [pid]);
  return { deleted: info.changes > 0 };
}

/**
 * 批量编辑入参（**部分 patch** 语义 —— 与 upsertProduct 的全量提交刻意不同）：
 * `undefined` 的字段**不修改**，出现即写入（空串 = 清空）。批量编辑的价值就在
 * "只改勾选的那几列"，逐条 upsert 会把没展示的列静默重置，也逼着界面回读全量行。
 * code / name 不可批量改：编码是跨域关联锚点（见 deleteProduct 注），批量改名必然误伤。
 */
export interface ProductBatchUpdateInput {
  ids: number[];
  supplierId?: number;
  category?: string;
  status?: string;
  note?: string;
}

export function batchUpdateProducts(input: ProductBatchUpdateInput): { updated: number } {
  ensureProductSchema();
  const ids = [...new Set((input?.ids ?? []).map((x) => toId(x)).filter(Boolean))];
  if (!ids.length) throw new Error('请选择要编辑的产品');

  const sets: string[] = [];
  const args: DbBindValue[] = [];
  if (input?.supplierId !== undefined) {
    const sid = toId(input.supplierId);
    // 0 = 清空关联，合法；>0 时校验厂家存在（suppliers 表属采购域，未建表时不校验降级放行）
    if (sid && suppliersTableReady()) {
      if (!dbGet(`SELECT id FROM suppliers WHERE id = ?`, [sid])) {
        throw new Error(`厂家不存在或已被删除：#${sid}`);
      }
    }
    sets.push('supplier_id = ?');
    args.push(sid);
  }
  if (input?.category !== undefined) {
    sets.push('category = ?');
    args.push(str(input.category, MAX.category));
  }
  if (input?.status !== undefined) {
    sets.push('status = ?');
    args.push(normStatus(input.status));
  }
  if (input?.note !== undefined) {
    sets.push('note = ?');
    args.push(str(input.note, MAX.note));
  }
  if (!sets.length) throw new Error('没有要修改的字段 —— 至少填写一项');

  const placeholders = ids.map(() => '?').join(',');
  const info = dbRun(
    `UPDATE pl_products SET ${sets.join(', ')}, updated_at = datetime('now','localtime')
     WHERE id IN (${placeholders})`,
    [...args, ...ids],
  );
  return { updated: info.changes };
}

// ---- 汇总 ----

export function productSummary(): ProductSummary {
  const totalRow = dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM pl_products`);
  const byStatus = dbQuery<Record<string, unknown>>(
    `SELECT status, COUNT(*) AS c FROM pl_products GROUP BY status ORDER BY c DESC`
  ).map((r) => ({ status: String(r.status ?? ''), count: num(r.c) }));

  const grouped = dbQuery<Record<string, unknown>>(
    `SELECT supplier_id AS sid, COUNT(*) AS c FROM pl_products WHERE supplier_id > 0 GROUP BY supplier_id`
  );
  const counts = new Map<number, number>();
  for (const r of grouped) counts.set(num(r.sid), num(r.c));
  const names = supplierNameMap();
  // ⚠️ 返回**全部**厂家，而不是只返回「已有产品的那些」：
  // 这个字段是给编辑表单的厂家下拉用的 —— 只给"已用过的"会让用户无法给产品关联一个
  // 新厂家（下拉里根本没有这一项），而症状是"选不到"，看起来像界面 bug 而不是数据问题。
  // 有产品的厂家靠 productCount 仍能一眼看出（排序也在前）。
  const supplierOptions = [...names.entries()]
    .map(([id, name]) => ({ id, name, productCount: counts.get(id) ?? 0 }))
    .sort((a, b) => b.productCount - a.productCount || a.name.localeCompare(b.name, 'zh'));

  const unassigned = dbGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM pl_products WHERE supplier_id = 0`
  );

  return {
    total: totalRow ? num(totalRow.c) : 0,
    byStatus,
    supplierOptions,
    withoutSupplier: unassigned ? num(unassigned.c) : 0,
  };
}

// ---- 厂家参照（跨域读 suppliers；供编辑表单下拉与 Excel 导入的「名称 → id」解析） ----

/**
 * 全部厂家（id + 名称）。
 *
 * 只**读**采购域的 `suppliers` 表，不写不建：该表的 owner 是采购域（ADR-002 C1 单点写入），
 * 产品库只是借用它把 Excel 里的厂家名解析成 id。表不存在时返回空数组（降级而非报错）——
 * 未启用采购域的用户仍应该能维护产品，只是关联不上厂家。
 */
export function listSuppliers(): { id: number; name: string }[] {
  return [...supplierNameMap().entries()].map(([id, name]) => ({ id, name }));
}

// ---- Excel 批量导入 ----

/** 一行导入数据（字段已在渲染层解析校验过，本层只做最后兜底与落库） */
export interface ProductImportRow {
  /** Excel 行号（1-based，仅用于回报失败行） */
  rowNo: number;
  code: string;
  name: string;
  supplierId: number;
  /**
   * 供应商**原文**（Excel 里写的名字；2026-10-10 新增）。
   *
   * `supplierId` 为 0 且有它时，由调用方注入的 `ensureSupplier` 去**按名称查找、不存在则新建**
   * （见 `importProducts` 的第 3 个参数）—— 本层自己**不写** `suppliers` 表：
   * 那张表的 owner 是采购域（ADR-002 C1 单点写入）。
   */
  supplierRaw?: string;
  status: string;
  note: string;
  /**
   * 该行声明的 SKU（颜色 + 尺码 + 克重）。
   * 空数组 = 这行没说 SKU（只导产品本身），**不是**"把这个款现有的 SKU 都删掉"。
   */
  skus: { color: string; size: string; weightG: number }[];
  /**
   * 该行 Excel 里那张图（已由 `product-extract-images` 落盘并登记 `md_images`）；
   * 0 = 这行没图（**不覆盖**款上已有的主图）。
   */
  imageId: number;
  /** 该行填的进价（分）。`undefined` = 这行没填 ⇒ **不修改**库内已有价（**不是清 0**）。
   *  2026-10-21 起：产品表 `pl_products.cost_cents`（"当前价"维护入口）也收同一个值。 */
  costCents?: number;
}

export interface ProductImportOutcome {
  created: number;
  updated: number;
  /** 本次真正写库的 SKU 条数（新增 + 更新） */
  skusWritten: number;
  /** 本次设为款主图的张数 */
  imagesAttached: number;
  /** 只有库层才拦得住的失败行（如 `insertOnly` 模式下编码已存在） */
  failed: { rowNo: number; code: string; message: string }[];
  /**
   * 本次由 `ensureSupplier` **新建**的供应商条数（2026-10-10）。
   * 只统计"真的为某一行建了档"的次数 —— 名称已存在时不计（那本来就不是新写）。
   */
  suppliersCreated: number;
}

/**
 * 批量导入（**单事务**，整批同进同出）。
 *
 * 关于「部分失败」与「单事务」并存：行级错误在**本函数内**逐行 catch 并记录，
 * 不让它冒泡出事务 —— 于是事务只在遇到真正的致命错误（磁盘满、库锁死）时才回滚。
 * 若改成"有一行错就整批回滚"，用户拿到一份 500 行的表里有 1 个空编码时会**一行都进不去**，
 * 而 P2 验收要求的正是「490 入库、10 行可在界面重试」。
 *
 * ---- 三处与"全量提交"不同调的取舍（2026-10-08，模板改列时一并裁定）----
 *
 * ① **类目保留**：模板与导出都不再有「类目」列 ⇒ 这里对**已存在的产品原样保留** `category`。
 *    若照 `upsertProduct` 的全量提交语义写空串，用户"导出→改几行→导回"一次，**所有款的类目
 *    就全没了**，而且不报错、界面上也看不出是哪一步弄丢的。少一列就清空一列，是这张表最贵的坑。
 * ② **SKU 按（颜色, 尺码）upsert**：同款的重复行在渲染层已合并成一行多 SKU，这里只负责落库。
 *    克重 **0 = 这行没写 ⇒ 不覆盖已有值** —— 克重是算运费的输入，静默清零会让成本算错且无痕。
 *    想清掉某个 SKU 的克重请走界面（那里改完立刻看得见）。
 * ③ **有图才设主图**：这一行插了图 ⇒ 覆盖设为款主图（用户把图放进去就是要换它）；
 *    这行没图 ⇒ **不动**已有主图（"导出→改→导回"时导出的文件自带图，空着说明用户删了它，
 *    但删图的意图不如"没带图"这个事实明确，宁可不覆盖）。
 *
 * @param mode `upsert`（默认）= 编码已存在则更新该行；`insertOnly` = 编码已存在则记为该行失败
 * @param opts.ensureSupplier 「名称 → 供应商 id」的解析器（**由调用方注入**，本层不写 `suppliers` 表）。
 *        只在行**确定要接着往下走**（编码冲突检查已通过）时才调用 ⇒ 失败行不会留下孤儿供应商。
 *        `created: true` 会被计入 `outcome.suppliersCreated`。
 * @returns 新增 / 更新 / SKU / 图 / 失败行 / 新建供应商 的计数与明细
 */
export function importProducts(
  rows: ProductImportRow[],
  mode: 'upsert' | 'insertOnly' = 'upsert',
  opts?: { ensureSupplier?: (name: string) => { id: number; created: boolean } },
): ProductImportOutcome {
  ensureProductSchema();
  ensureVariantSchema();
  const list = Array.isArray(rows) ? rows : [];
  const ensureSupplier = typeof opts?.ensureSupplier === 'function' ? opts.ensureSupplier : null;
  const out: ProductImportOutcome = {
    created: 0,
    updated: 0,
    skusWritten: 0,
    imagesAttached: 0,
    failed: [],
    suppliersCreated: 0,
  };

  dbTransaction(() => {
    for (const r of list) {
      const rowNo = Number(r?.rowNo) || 0;
      const code = str(r?.code, MAX.code);
      try {
        if (!code) throw new Error('款编码为空');
        const existing = dbGet<{ id: number; category: string }>(
          `SELECT id, category FROM pl_products WHERE code = ?`,
          [code],
        );
        if (existing && mode === 'insertOnly') {
          throw new Error(`款编码已存在：${code}`);
        }

        // 供应商：显式 id 优先；否则拿原文去「查找或新建」（2026-10-10）。
        // ⚠️ 放在编码冲突检查**之后**：insertOnly 下会被跳过的行不该先把供应商建出来，
        //    否则用户会看到一堆"从没被任何产品引用过"的供应商。
        let supplierId = toId(r?.supplierId);
        if (!supplierId && ensureSupplier && r?.supplierRaw) {
          const sup = ensureSupplier(String(r.supplierRaw));
          supplierId = toId(sup?.id);
          if (sup?.created) out.suppliersCreated++;
        }

        const saved = upsertProduct({
          id: existing ? num(existing.id) : 0,
          code,
          name: str(r?.name, MAX.name),
          supplierId,
          // ① 保留类目：新行无类目（空串），已有行原样带回来
          category: existing ? str(existing.category, MAX.category) : '',
          status: (PRODUCT_STATUSES as readonly string[]).includes(str(r?.status, MAX.status))
            ? (str(r?.status, MAX.status) as ProductStatus)
            : 'active',
          note: str(r?.note, MAX.note),
          // 进价：只有这行填了才写（undefined = 不修改；见 `upsertProduct` 的破例说明）
          ...(r?.costCents !== undefined && r?.costCents !== null
            ? { costCents: Number(r.costCents) }
            : {}),
        });

        // ② SKU
        for (const s of Array.isArray(r?.skus) ? r.skus : []) {
          const color = str(s?.color, VARIANT_MAX.color);
          const size = str(s?.size, VARIANT_MAX.size);
          // 解析侧已保证颜色/尺码成对；这里只兜底（不成对就跳过，不猜一个补上）
          if (!color || !size) continue;
          const name = `${color} ${size}`;
          const cur = dbGet<{ id: number; weight_g: number }>(
            `SELECT id, weight_g FROM pl_variants WHERE product_id = ? AND name = ?`,
            [saved.id, name],
          );
          const g = Math.round(Number(s?.weightG));
          const asked = Number.isFinite(g) && g > 0 ? g : 0;
          variantUpsert({
            id: cur ? num(cur.id) : 0,
            productId: saved.id,
            code: '',
            name,
            color,
            size,
            // 没写克重时不覆盖已有值（见上方 ②）
            weightG: asked > 0 ? asked : cur ? num(cur.weight_g) : 0,
            status: 'active',
          });
          out.skusWritten++;
        }

        // ③ 图
        const imageId = toId(r?.imageId);
        if (imageId && imageIdExists(imageId)) {
          attachProductImage(saved.id, imageId);
          out.imagesAttached++;
        }

        if (existing) out.updated++;
        else out.created++;
      } catch (e) {
        out.failed.push({
          rowNo,
          code,
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });

  return out;
}

// ═══════════════════════════════════════════════════════════════════════════════════
// 「店铺商品ID → 产品」映射（P3；PRODUCT_LIBRARY §3.1 / §3.4 / §3.5）
// ═══════════════════════════════════════════════════════════════════════════════════
//
// 本表解决的问题与 `sk_name_map` **不同，不要混淆**（§3.4）：
//   sk_name_map   键 = 人的**文本**（店名/款名）  → 主数据 ID；靠精确匹配 + 人工指派
//   pl_shop_sku   键 = 平台**商品ID**（稳定标识）→ 产品；本身就是精确键，不需要模糊匹配
//
// 三条已裁定的口径：
//   1. **`spec` 一期恒 `'*'`**（D4 冻结了四列唯一键，但 P5 建变体表之前没有非 `'*'` 的生产者）。
//      待关联队列按 `(店铺, 商品ID)` 聚合，不按规格拆 —— 拆了用户要对同一个商品点 N 次。
//   2. **`item_id` 存归一后的形态**（`toSkuKey`：剥不可见字符 + 去空白）。
//      存原文会让 `" B0X1"` 与 `"B0X1"` 各占一行、四列 UNIQUE 拦不住，于是"精确命中"立刻歧义 ——
//      这正是 S1 的 `name_key` 那条教训（"Excel 多一个空格即归成两家店且不报错"）。
//   3. **商品ID 变了标 `status='invalid'`，不物理删除**（§3.5-2）：否则关联率会莫名回落且查不出原因。
//
// 与店铺域的关系：平台只能从店铺实体（`sk_shops.platform`）来，`oi_orders` 没有平台字段。
// 故**店铺没归一就不允许写映射**（队列里标 `shopUnresolved`），而不是拿空平台硬塞一行 ——
// 空平台会把不同平台的两家店并到同一个键上。
//
// 有意**不做** `pl_import_errors`（§3.1 原写"建表时机 = P3"）：P2 的导入失败行已经能回传界面重试，
// 落一张跨重启的失败表需要一个消费它的界面（"历史失败行"），P3 的验收里没有这条。等真需要时再补，而不是先建一张没有生产者的表。

/** 映射状态：确认 / 待确认 / 已失效（商品ID 变了） */
export type SkuMapStatus = 'confirmed' | 'pending' | 'invalid';
export const SKU_MAP_STATUSES: readonly SkuMapStatus[] = ['confirmed', 'pending', 'invalid'];

/** 映射来源（一期只有 manual；import / ai_suggest 预留，与 DDL 注释一致） */
export type SkuMapSource = 'manual' | 'import' | 'ai_suggest';

export interface ShopSkuRow {
  id: number;
  platform: string;
  shopId: number;
  /** 由 shop_id 派生（软关联 sk_shops；店被删则留空，不报错） */
  shopName: string;
  itemId: string;
  spec: string;
  productId: number;
  /** 由 product_id 派生（软关联 pl_products） */
  productCode: string;
  productName: string;
  variantId: number;
  qtyPerItem: number;
  status: string;
  source: string;
  note: string;
  createdAt: string;
  updatedAt: string;
}

export interface SkuMapQuery {
  offset: number;
  limit: number;
  search: string;
  status: string;
  shopId: number;
  /**
   * 反向过滤：只看**某一款**关联了哪些店铺商品（产品侧「已关联商品」用）。
   * `0` = 不过滤（与其它过滤项同口径：0 是"没指定"，不是"id 为 0 的行"）。
   * 走既有索引 `idx_pl_shop_sku_product`，不新增表、不新增通道。
   */
  productId: number;
}

/** 一条待写入的映射（批量关联 / 改绑共用） */
export interface SkuMapInput {
  platform: string;
  shopId: number;
  itemId: string;
  /** **颜色**（D4 起承载颜色语义；缺省 `'*'` = 未指定色）。
   *  颜色是商品ID 的属性（同一商品ID 的所有订单必然同色），配在这里即"配一次、后面全自动带出"。 */
  spec?: string;
  productId: number;
  status?: string;
  note?: string;
}

export interface SkuMapOutcome {
  created: number;
  updated: number;
  /** 顺带处理的**存量订单行数**（映射写入后重跑确定性归款：新归款 + 补色都算，值没变的不计）。
   *  由 handler 层填（本层不 import 订单域，避免 `order-db → product-db` 成环）。 */
  reassigned: number;
  /** 顺带把订单图采纳为**款主图**的张数（认款那一刻顺手做，见 `pendingProductImages`）。
   *  由 handler 层填：本层只挑"该采纳哪张给哪个款"，复制文件与登记图行走 handler。 */
  adopted: number;
  /** 只有库层才拦得住的失败行（编码/店铺不存在、商品ID 为空…） */
  failed: { itemId: string; message: string }[];
}

export interface SkuMapSummary {
  total: number;
  byStatus: { status: string; count: number }[];
  byShop: { shopId: number; shopName: string; platform: string; count: number }[];
  byPlatform: { platform: string; count: number }[];
}

export interface SkuQueueResult {
  rows: QueueRow[];
  stats: QueueStats & { /** 涉及但尚未归一的店铺名（去重，给界面提示"先去登记哪些店"） */ unresolvedShops: string[] };
}

/**
 * `pl_shop_sku` 的**建表**语句（当前形状）。
 *
 * 单独抽出来是因为**重建表**要用它：改唯一键只能"建新表 → 搬数据 → 删旧表 → 建索引"，
 * 而索引必须在删掉旧表之后再建（`ALTER TABLE ... RENAME` 会把原索引一起改名跟着老表走，
 * 此时 `CREATE INDEX IF NOT EXISTS` 会因"名字已被占用"被静默跳过 —— 新表最后没有索引）。
 */
const SKU_TABLE_SQL = `CREATE TABLE IF NOT EXISTS pl_shop_sku (
    -- 用途：店铺商品认款映射（平台商品→产品/SKU，含每件用量）；认款写路径只走本表，与采集快照 pl_shop_items 不互写。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL DEFAULT '',
    shop_id INTEGER NOT NULL DEFAULT 0,
    item_id TEXT NOT NULL,
    spec TEXT NOT NULL DEFAULT '*',
    product_id INTEGER NOT NULL DEFAULT 0,
    variant_id INTEGER NOT NULL DEFAULT 0,
    qty_per_item INTEGER NOT NULL DEFAULT 1,
    status TEXT NOT NULL DEFAULT 'confirmed',
    source TEXT NOT NULL DEFAULT 'manual',
    note TEXT NOT NULL DEFAULT '',
    image_url TEXT NOT NULL DEFAULT '',
    imported_at INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(platform, shop_id, item_id, spec, product_id)
  )`;

/** 建表 + 索引：由 `ensureSkuSchema` 统一执行（重建后索引由它补，见其注释） */
const SKU_SCHEMA = [
  SKU_TABLE_SQL,
  `CREATE INDEX IF NOT EXISTS idx_pl_shop_sku_lookup ON pl_shop_sku(platform, shop_id, item_id, status)`,
  // 认款/队列/批量解析/写入判重全部按 `(shop_id, item_id)` 走（平台已退出匹配键，见 `bindingKey`）：
  // 没有这条索引，那几条查询会放弃 `idx_pl_shop_sku_lookup` 的前缀 `platform` 而退化成扫表
  `CREATE INDEX IF NOT EXISTS idx_pl_shop_sku_binding ON pl_shop_sku(shop_id, item_id, status)`,
  `CREATE INDEX IF NOT EXISTS idx_pl_shop_sku_product ON pl_shop_sku(product_id)`,
];

/** 幂等补列（老库）—— image_url / imported_at 只写进 CREATE TABLE 的话老库拿不到 */
function ensureSkuColumns(): void {
  const info = dbQuery<{ name: string }>(`PRAGMA table_info(pl_shop_sku)`);
  // 表还不存在 = 新库（迁移先于 dbMigrate 跑）→ 直接跳过，别去 ALTER 一张没有的表
  if (info.length === 0) return;
  const cols = new Set(info.map((r) => String(r.name ?? '')));
  if (!cols.has('image_url')) {
    dbRun(`ALTER TABLE pl_shop_sku ADD COLUMN image_url TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.has('imported_at')) {
    dbRun(`ALTER TABLE pl_shop_sku ADD COLUMN imported_at INTEGER NOT NULL DEFAULT 0`);
  }
}

/** 重建表时要原样搬过去的列（显式列举 —— 不用 `SELECT *`，列序变化时会静默错位） */
const SKU_COPY_COLS = `id, platform, shop_id, item_id, spec, product_id, variant_id, qty_per_item,
  status, source, note, image_url, imported_at, created_at, updated_at`;

/**
 * 把唯一键归一成**含 `product_id` 的 5 列**（一对多的前提）。
 *
 * 为什么必须做：`UNIQUE(platform, shop_id, item_id, spec)` 下，同一 (店, 商品, 规格) 只能有一条绑定 ——
 * 池的套装关联（同店同商品挂第二个产品）会被唯一键挡掉；而 `CREATE TABLE IF NOT EXISTS`
 * 不会重建老库，所以老库永远停在 4 列键上（新库是 5 列），两边行为不一致且都不报错。
 *
 * 形状判定用建表 SQL 原文；已是 5 列则**跳过**（新库走的就是这条路）。
 */
function normalizeSkuUniqueKey(): void {
  const sql = tableSql('pl_shop_sku');
  if (!sql) return; // 表尚不存在（新库由 dbMigrate 建）——不该发生，保守返回
  // ⚠️ 重建要按 `SKU_COPY_COLS` 逐列搬数据，而这份清单会随着加列变长。
  //    老库可能还没那些列（它停在 v1，v1 当时只补 image_url/imported_at），直接 SELECT 会抛
  //    `no such column` 并把整个迁移事务回滚 —— 症状是"升级卡死"而报错指向一句看不懂的 SQL。
  //    故先跑一遍**幂等**补列，保证 legacy 表至少有清单里的每一列（以后再加列也不会重犯）。
  ensureSkuColumns();
  if (/unique\s*\([^)]*product_id[^)]*\)/i.test(sql)) return; // 已含 product_id

  dbRun(`ALTER TABLE pl_shop_sku RENAME TO pl_shop_sku_legacy_struct`);
  dbMigrate([SKU_TABLE_SQL]); // 只建新表：索引此刻还被老表占着名，交给 ensureSkuSchema 末尾的 dbMigrate(SCHEMA)
  dbRun(
    `INSERT INTO pl_shop_sku (${SKU_COPY_COLS}) SELECT ${SKU_COPY_COLS} FROM pl_shop_sku_legacy_struct`,
  );
  dbRun(`DROP TABLE pl_shop_sku_legacy_struct`); // 连它名下的旧索引一并消失
  // AUTOINCREMENT 序列随旧表被 DROP 掉，按现存最大 id 重置 —— 不重置会让新插入复用已发出的 id。
  // ⚠️ `sqlite_sequence` **没有主键/唯一约束**（`CREATE TABLE sqlite_sequence(name,seq)`），
  // 故不能用 `ON CONFLICT(name)`（会报 "does not match any PRIMARY KEY or UNIQUE constraint"
  // 并把整个迁移事务回滚掉）；只能先 UPDATE、未命中再 INSERT。
  if (tableSql('sqlite_sequence')) {
    const maxId = Number(dbGet<{ m: number }>(`SELECT COALESCE(MAX(id), 0) AS m FROM pl_shop_sku`)?.m ?? 0);
    const upd = dbRun(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'pl_shop_sku'`, [maxId]);
    if (!upd.changes) {
      dbRun(`INSERT INTO sqlite_sequence (name, seq) VALUES ('pl_shop_sku', ?)`, [maxId]);
    }
  }
}

/** `pl_shop_sku` 的演进步骤（版本化：只跑未应用的，见 `electron/db.ts` 的 `migrate`） */
function skuMigrationSteps(): MigrationStep[] {
  return [
    { version: 1, name: 'pl_shop_sku 补 image_url / imported_at', up: ensureSkuColumns },
    {
      version: 2,
      name: 'pl_shop_sku 唯一键升到含 product_id（一对多）',
      up: normalizeSkuUniqueKey,
    },
    {
      version: 3,
      name: '删 pl_item_weights（「商品ID 克重」整条链退场：克重只属于 SKU）',
      up: dropItemWeightsTable,
    },
  ];
}

/**
 * v3 迁移：删掉 `pl_item_weights`（2026-10-01，用户领域裁定）。
 *
 * 为什么删：**克重是 SKU 属性**（同款不同颜色/尺码的重量都可能不同），而这张表把克重挂在
 * **商品ID**上 —— 粒度错一层：拿它算运费时，同款不同码会用同一个重量，且它一旦存在就会与
 * `pl_variants.weight_g`（真正的那份）形成两个来源（S3 甚至拿它去"回填"SKU 克重，等于用粗值盖细值）。
 * 本机实测该表 0 行（用户从未导过），且解析器（`src/lib/productWeight.ts`）**没有任何真实样本**做依据。
 * 故连同「商品信息 Excel → 商品ID 克重」的导入路径一起退场，克重唯一来源 = `pl_variants.weight_g`。
 */
function dropItemWeightsTable(): void {
  if (!tableExists('pl_item_weights')) return; // 新库/已删过 → 无事可做
  dbRun(`DROP TABLE pl_item_weights`);
}

/** 幂等初始化（与 ensureProductSchema 同挂载点调用；单独函数避免改动既有语义） */
export function ensureSkuSchema(): void {
  initDb();
  // 顺序有讲究（house convention，见技能与 agents.local.md §4）：**自定义迁移先跑，再 dbMigrate(SCHEMA)** ——
  // 重建表会把旧索引跟着老表一起带走，故索引统一由末尾的 dbMigrate 补（新库也走同一条路）。
  migrate('product.sku', skuMigrationSteps()); // 老库补齐：补列 → 唯一键归一
  dbMigrate(SKU_SCHEMA); // 新库一次建到当前形状（含 5 列唯一键）+ 补索引
}

/**
 * `pl_shop_sku` 的**种群标记**：池行（「商品清单」的一对多套装关联）与归款映射
 * （「映射与关联」的一对一绑定）**同表共存**，判据必须收在一处 —— 两个域各抄一份字面量必然漂移，
 * 而漂移的症状是"池行被归款当成映射命中"这类静默错账。
 *
 * 判据：新池行打此标记；**存量池行**（标记落地前导入的）靠 `shop_id = 0` 认 ——
 * 映射侧永远写不出 0（`upsertSkuMappings` 校验「请选择店铺」）。池/映射两个谓词互为补集。
 */
export const SKU_POOL_SOURCE = 'shop-import';

/** 池行谓词（`alias` 传 `''` 或 `'t2.'`） */
export function skuPoolSql(alias = ''): string {
  return `(${alias}source = '${SKU_POOL_SOURCE}' OR ${alias}shop_id = 0)`;
}

/** 归款映射行谓词（`skuPoolSql` 的补集）；映射侧的读写一律带它 */
export function skuMappingSql(alias = ''): string {
  return `(${alias}source <> '${SKU_POOL_SOURCE}' AND ${alias}shop_id <> 0)`;
}

/** 表是否存在 —— 各域表按域懒建，本层不能假定订单/店铺域都已初始化 */
/** 解析 JSON 文本，坏值降级为空对象（一条脏 raw_fields 不该让整张队列算不出来） */
function safeParseJson(txt: unknown): Record<string, string> {
  if (typeof txt !== 'string' || !txt) return {};
  try {
    const v = JSON.parse(txt);
    return v && typeof v === 'object' ? (v as Record<string, string>) : {};
  } catch {
    return {};
  }
}

/** `product_id` → (编码, 名称, 供应商 id)，供映射表与队列展示、以及本页汇总按供应商去重 */
function productLabelMap(): Map<number, { code: string; name: string; supplierId: number }> {
  const m = new Map<number, { code: string; name: string; supplierId: number }>();
  for (const r of dbQuery<Record<string, unknown>>(
    `SELECT id, code, name, supplier_id FROM pl_products`,
  )) {
    m.set(num(r.id), {
      code: String(r.code ?? ''),
      name: String(r.name ?? ''),
      supplierId: num(r.supplier_id),
    });
  }
  return m;
}

/** `sk_shops.id` → (名称, 平台)；店铺域未初始化时返回空表（降级而非报错） */function shopLabelMap(): Map<number, { name: string; platform: string }> {
  const m = new Map<number, { name: string; platform: string }>();
  if (!tableExists('sk_shops')) return m;
  for (const r of dbQuery<Record<string, unknown>>(`SELECT id, name, platform FROM sk_shops`)) {
    m.set(num(r.id), { name: String(r.name ?? ''), platform: String(r.platform ?? '') });
  }
  return m;
}

/** 人工归一的店铺：归一键 → shop_id（只用 `sk_name_map` 里 `ref_id>0` 且未忽略的行） */
function manualShopIdByKey(): Map<string, number> {
  const m = new Map<string, number>();
  if (!tableExists('sk_name_map')) return m;
  for (const r of dbQuery<Record<string, unknown>>(
    `SELECT raw_key, ref_id FROM sk_name_map WHERE kind = 'shop' AND ignored = 0 AND ref_id > 0`,
  )) {
    m.set(String(r.raw_key ?? ''), num(r.ref_id));
  }
  return m;
}

/**
 * 同名**唯一**精确命中的店铺（同一归一键命中多家 = 歧义 = 不进索引，与 `shop-db.autoMatchIndex` 同规则）。
 * 这里给出的是**建议**（`autoShopId`），永不自动落库（G6）。
 */
function uniqueShopByKey(): Map<string, { id: number; name: string; platform: string }> {
  const index = new Map<string, { id: number; name: string; platform: string }>();
  if (!tableExists('sk_shops')) return index;
  const ambiguous = new Set<string>();
  for (const r of dbQuery<Record<string, unknown>>(
    `SELECT id, name, name_key, platform FROM sk_shops`,
  )) {
    const key = String(r.name_key ?? '');
    if (!key) continue;
    if (index.has(key)) {
      ambiguous.add(key);
      continue;
    }
    index.set(key, {
      id: num(r.id),
      name: String(r.name ?? ''),
      platform: String(r.platform ?? ''),
    });
  }
  for (const k of ambiguous) index.delete(k);
  return index;
}

// ---- 映射表查询 ----

const SKU_COLS = `id, platform, shop_id, item_id, spec, product_id, variant_id, qty_per_item, status, source, note, created_at, updated_at`;

function mapSkuRow(
  row: Record<string, unknown>,
  products: Map<number, { code: string; name: string }>,
  shops: Map<number, { name: string; platform: string }>,
): ShopSkuRow {
  const productId = num(row.product_id);
  const shopId = num(row.shop_id);
  return {
    id: num(row.id),
    // 平台以**店铺当前值**为准（店铺行是权威，映射行那列只是写入时的副本）——
    // 改过平台的店，列表里也不会再显示成旧平台；店铺被删才回落到副本（有值比空着好查）
    platform: shops.get(shopId)?.platform || String(row.platform ?? ''),
    shopId,
    shopName: shops.get(shopId)?.name ?? '',
    itemId: String(row.item_id ?? ''),
    spec: String(row.spec ?? '*'),
    productId,
    productCode: products.get(productId)?.code ?? '',
    productName: products.get(productId)?.name ?? '',
    variantId: num(row.variant_id),
    qtyPerItem: num(row.qty_per_item) || 1,
    status: String(row.status ?? 'confirmed'),
    source: String(row.source ?? 'manual'),
    note: String(row.note ?? ''),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

/** 映射列表（关键字 / 状态 / 店铺 / 款 过滤 + 分页；按更新时间倒序，最近动的在最上面） */
export function listSkuMappings(payload: SkuMapQuery): { rows: ShopSkuRow[]; total: number } {
  ensureSkuSchema();
  const search = str(payload?.search, MAX.search);
  const status = str(payload?.status, MAX.status);
  const shopId = toId(payload?.shopId);
  const productId = toId(payload?.productId);

  const where: string[] = [skuMappingSql()];
  const params: (string | number)[] = [];
  if (search) {
    const like = `%${search}%`;
    // 平台按**店铺当前值**搜（与上图展示同一权威）：改过平台的店，搜新平台要能搜到。
    // 店铺域未初始化时回落到映射行自己的副本（否则建表都做不了）。
    if (tableExists('sk_shops')) {
      where.push(
        `(item_id LIKE ? OR note LIKE ? OR EXISTS (
            SELECT 1 FROM sk_shops s WHERE s.id = pl_shop_sku.shop_id AND s.platform LIKE ?
         ))`,
      );
    } else {
      where.push(`(item_id LIKE ? OR platform LIKE ? OR note LIKE ?)`);
    }
    params.push(like, like, like);
  }
  if ((SKU_MAP_STATUSES as readonly string[]).includes(status)) {
    where.push(`status = ?`);
    params.push(status);
  }
  if (shopId) {
    where.push(`shop_id = ?`);
    params.push(shopId);
  }
  // 反向：某款关联了哪些店铺商品。`status` 由调用方按语义给（产品侧"已关联"只算 confirmed，
  // 失效单列 —— 把 invalid 混进来会让用户以为那个商品还在用）。
  if (productId) {
    where.push(`product_id = ?`);
    params.push(productId);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;
  const offset = Math.max(0, Math.floor(Number(payload?.offset) || 0));
  const limit = Math.min(
    MAX_LIST_LIMIT,
    Math.max(1, Math.floor(Number(payload?.limit) || DEFAULT_LIST_LIMIT)),
  );

  const rowsRaw = dbQuery<Record<string, unknown>>(
    `SELECT ${SKU_COLS} FROM pl_shop_sku ${whereSql} ORDER BY updated_at DESC, id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const totalRow = dbGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM pl_shop_sku ${whereSql}`,
    params,
  );
  const products = productLabelMap();
  const shops = shopLabelMap();
  return {
    rows: rowsRaw.map((r) => mapSkuRow(r, products, shops)),
    total: totalRow ? num(totalRow.c) : 0,
  };
}

/** 映射表汇总（**不扫订单**；队列侧的待办数由 `shopSkuQueue` 自己给） */
export function skuMapSummary(): SkuMapSummary {
  ensureSkuSchema();
  const totalRow = dbGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM pl_shop_sku WHERE ${skuMappingSql()}`,
  );
  const byStatus = dbQuery<Record<string, unknown>>(
    `SELECT status, COUNT(*) AS c FROM pl_shop_sku WHERE ${skuMappingSql()} GROUP BY status ORDER BY c DESC`,
  ).map((r) => ({ status: String(r.status ?? ''), count: num(r.c) }));

  const shops = shopLabelMap();
  const grouped = dbQuery<Record<string, unknown>>(
    `SELECT shop_id AS sid, COUNT(*) AS c, MAX(platform) AS plat
       FROM pl_shop_sku WHERE ${skuMappingSql()} GROUP BY shop_id ORDER BY c DESC`,
  );
  const byShop = grouped.map((r) => {
    const sid = num(r.sid);
    const label = shops.get(sid);
    return {
      shopId: sid,
      // 店铺被删 / 未登记时留空名，不隐藏这一行 —— 藏起来会让"映射总数对不上"变成查不出的悬案
      shopName: label?.name ?? '',
      // 平台取店铺当前值（权威）；店铺已删才回落到映射行的副本
      platform: label?.platform || String(r.plat ?? ''),
      count: num(r.c),
    };
  });
  // 平台汇总按**店铺当前平台**聚合（与列表、认款同一权威）——按映射行自己的副本分组的话，
  // 改过平台的店会在这里显示成旧平台，而列表已经是新平台，两处对不上
  const buckets = new Map<string, number>();
  for (const row of byShop) {
    const key = row.platform || '未登记';
    buckets.set(key, (buckets.get(key) ?? 0) + row.count);
  }
  const byPlatform = [...buckets]
    .map(([platform, count]) => ({ platform, count }))
    .sort((a, b) => b.count - a.count);

  return {
    total: totalRow ? num(totalRow.c) : 0,
    byStatus,
    byPlatform,
    byShop,
  };
}

// ---- 待关联队列（实时聚合 oi_orders，不做缓存表） ----

/** 单次扫描的订单行上限（一次同步调用里扫爆大库没有意义；超限由界面提示"先导入更少的订单"） */
const MAX_QUEUE_SCAN = 50000;
/** 队列单次返回上限 */
const MAX_QUEUE_ROWS = 1000;

/** 取订单行最小投影（表不存在时返回空 —— 未启用订单域的用户仍应能看到一个空队列而不是报错） */
function collectOrderRows(maxRows: number): { rows: SkuOrderRow[]; truncated: boolean } {
  if (!tableExists('oi_order_items')) return { rows: [], truncated: false };
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT o.shop, oi.raw_fields FROM oi_order_items oi JOIN oi_orders o ON o.id = oi.order_id LIMIT ?`,
    [maxRows + 1],
  );
  const truncated = rows.length > maxRows;
  return {
    rows: rows.slice(0, maxRows).map((r) => ({
      shop: String(r.shop ?? ''),
      rawFields: safeParseJson(r.raw_fields),
    })),
    truncated,
  };
}

/**
 * 待关联队列：当前订单里出现过的「店铺 × 商品ID」，减去已有生效映射的部分。
 *
 * **实时计算**（与 `shop-db.listUnmapped` 同理由）：缓存表在删订单 / 重导 / 改映射之后必然与源头
 * 不一致，而"名单里还挂着一个已经不存在的商品"这种错无法自证。
 */
export function shopSkuQueue(payload: { limit?: number; maxRows?: number } = {}): SkuQueueResult {
  ensureSkuSchema();
  const maxRows = Math.min(
    MAX_QUEUE_SCAN,
    Math.max(1, Math.floor(Number(payload?.maxRows) || MAX_QUEUE_SCAN)),
  );
  const limit = Math.min(
    MAX_QUEUE_ROWS,
    Math.max(1, Math.floor(Number(payload?.limit) || MAX_QUEUE_ROWS)),
  );

  const { rows: orders, truncated } = collectOrderRows(maxRows);

  // 「已关联」的键集合 —— **只算产品还在的映射**（`JOIN pl_products`）。
  // 为什么：映射行在产品被删之后不会消失（没有外键级联），而 `resolveOrderSku` 把"指向已删产品"
  // 的映射当**未命中**（绝不替人猜一个产品）。两边口径不一致的症状（2026-10-20 真库实测：
  // 2 条映射指向已删的 `9802`，卡住 10 单）：订单永远认不出款，队列却说这个商品**已关联** ⇒
  // 它连"去补"的入口都不出现，用户只看到"有 10 单认不出，但没有一处能点"。
  //
  // ⭐ 键只含 `(店铺, 商品ID)`（`bindingKey`），**不取映射行自己的 `platform`**：那是写映射那刻
  // 从店铺行抄来的副本，而队列侧拼键用的是店铺**当前**平台 —— 改一次平台两边就对不上，
  // 该店全部商品被当成"未关联"重新塞回待办，用户只能全量重配。
  const mappedKeys = new Set<string>();
  for (const r of dbQuery<Record<string, unknown>>(
    `SELECT m.shop_id, m.item_id FROM pl_shop_sku m
       JOIN pl_products p ON p.id = m.product_id
      WHERE m.status = 'confirmed' AND ${skuMappingSql('m.')}`,
  )) {
    mappedKeys.add(bindingKey(num(r.shop_id), r.item_id));
  }

  // 「商品ID 反查店铺」的索引**按需加载**（只有真的存在未认店的分组时才查一次全量）——
  // 队列每次打开都建一遍全表索引是白花钱，而认店成功的用户永远用不到它。
  let itemShops: Map<string, number> | null = null;
  const view = buildQueueView({
    orders,
    manualShopIdByKey: manualShopIdByKey(),
    autoShopByKey: uniqueShopByKey(),
    shopsById: shopLabelMap(),
    mappedKeys,
    resolveShopByItemId: (itemId) => {
      if (!itemShops) itemShops = itemShopIndex();
      return itemShops.get(toSkuKey(itemId)) ?? 0;
    },
    limit,
  });

  const unresolved = new Set<string>();
  for (const r of view.rows) {
    if (r.status === 'shopUnresolved') unresolved.add(r.shopRaw || r.shopKey);
  }

  return {
    rows: view.rows,
    stats: {
      ...view.stats,
      truncated: view.stats.truncated || truncated,
      unresolvedShops: [...unresolved].sort(),
    },
  };
}

/**
 * 批量解析：`(平台, 店铺, 商品ID)` → 命中的产品（**一次调用算完一批**，不做逐单查询）。
 *
 * 只用 `status='confirmed'` 的行：`invalid`（商品ID 已变）与 `pending`（还没人确认）都不算命中 ——
 * 把没确认的映射当命中，等于让系统替人下结论。
 */
export function resolveSkuBatch(
  /** `platform` 仍收但**不参与匹配**（保留是因为调用方手上本来就有它；见 `bindingKey`） */
  keys: { platform?: string; shopId: number; itemId: string }[],
): { matched: boolean; productId: number; productCode: string; productName: string; itemId: string }[] {
  ensureSkuSchema();
  const list = Array.isArray(keys) ? keys.slice(0, 20000) : [];
  const products = productLabelMap();
  const index = new Map<string, number>();
  for (const r of dbQuery<Record<string, unknown>>(
    // 与队列同一口径：**指向已删产品的映射不算命中**（见 `shopSkuQueue` 里那段注释）——
    // 否则这里会回 "matched:true + 产品编码为空"，调用方拿它当已关联，问题同样看不见。
    `SELECT m.shop_id, m.item_id, m.product_id FROM pl_shop_sku m
       JOIN pl_products p ON p.id = m.product_id
       WHERE m.status = 'confirmed' AND ${skuMappingSql('m.')}`,
  )) {
    index.set(bindingKey(num(r.shop_id), r.item_id), num(r.product_id));
  }
  return list.map((k) => {
    const itemId = toSkuKey(k?.itemId);
    const pid = index.get(bindingKey(toId(k?.shopId), itemId)) ?? 0;
    return {
      matched: pid > 0,
      productId: pid,
      productCode: pid ? (products.get(pid)?.code ?? '') : '',
      productName: pid ? (products.get(pid)?.name ?? '') : '',
      itemId,
    };
  });
}

/**
 * 单条订单行的**确定性关联**（业务链路「先查 `pl_shop_sku`，查不到才走 AI 兜底」的落点）。
 *
 * 与 `resolveSkuBatch` 的分工：批量版给**已知 平台 + 店铺 id** 的调用方（岛侧队列，它手上就是
 * 归一后的店铺）；本函数给**只有订单原文**的调用方（主进程订单落库）—— 它多承担"店铺原文 →
 * 店铺实体"这一步，而这一步必须与待关联队列用**同一套规则**（人工归一优先 → 同名唯一精确命中）。
 * 两处规则一旦分叉，症状是"队列里说这家店已归一、落单时却认不出来"，且两边各自看都正常。
 *
 * **D4 升级（2026-10-05）**：映射从「产品级」升到「款 + 色」级 —— `spec` 承载**颜色**
 * （`'*'` = 未指定色，与一期行为等价）。选择理由见 `skuMapColorOf()`：颜色是**商品ID 的属性**
 * （同一个商品ID 的所有订单必然同色），把它配在映射上，颜色就从"每单看图猜"变成"配一次自动带出"。
 *
 * 匹配规则：**带色的行优先**（`spec <> '*'` 排在前）——
 * 同一 (店, 商品ID) 若同时存在 `'*'` 与带色两条，取带色的那条；不然人配了色却不生效，
 * 症状是"配了没用"（最难查的一类）。同色并列时取 `id` 最小的一条，保证结果不随写入顺序漂移。
 *
 * ⭐ 认店补第五级（2026-10-19）：店铺原文的归一键（人工归一 → 同名唯一）**都落空**时，
 * 用**商品ID 反查采集快照**（`shopIdByItemIds`）—— 商品ID 是比店名更强的证据：
 * `pl_shop_items` 的键就是 `(shop_id, store_key, item_id)`，它记录了这个商品当初归在哪家店。
 * 没有这一级时，"用户把店铺ID 填成店名"这类登记错误会让订单**永远认不了店**，
 * 而订单行上其实一直带着能反证的 itemId（症状是"配了映射却不生效"，且两边各自看都正常）。
 * 该级**只兜底**：原文归一成功就不查；多店歧义返回 0（不猜）。
 *
 * @returns null = 未命中（店铺未归一 / 无映射 / 映射非 confirmed / 产品已删），调用方保持原状
 */
export function resolveOrderSku(input: { shop?: unknown; itemId?: unknown }): {
  productId: number;
  productCode: string;
  productName: string;
  /** 映射里配的颜色（`''` = 未指定）；归款侧的颜色权威来源 */
  spec: string;
  /** 与 `spec` 同色的变体 id（`0` = 该产品还没录这个色的变体）—— 不参与匹配，供下游按变体取克重/图 */
  variantId: number;
  shopId: number;
  platform: string;
} | null {
  const shopKey = toNameKey(input?.shop);
  const itemId = toSkuKey(input?.itemId);
  if (!itemId) return null;
  ensureSkuSchema();

  const manual = shopKey ? (manualShopIdByKey().get(shopKey) ?? 0) : 0;
  // 店铺没归一 → 平台未知。不拿空平台去凑：不同平台的同名店铺会被并到同一个键上。
  // 兜底顺序：人工归一 → 同名唯一 → **商品ID 反查采集快照**（末级，唯一命中才算）
  const shopId = manual || (shopKey ? (uniqueShopByKey().get(shopKey)?.id ?? 0) : 0) || shopIdByItemId(itemId);
  if (!shopId) return null;

  // 平台只用于返回值（下游写映射时记一笔）；匹配键**不含平台** —— 见 `bindingKey`：
  // 映射行的 `platform` 是副本，用它当条件会让"改一次店铺平台"废掉该店全部映射。
  // 同 (店,商品ID) 若遗留多平台重复行，下面的 ORDER BY 已定序（带色优先 → id 最小），结果确定。
  const platform = shopLabelMap().get(shopId)?.platform ?? '';
  // 一个商品只映射**一个产品**：套装商品也走这里 —— 它映射到"套装产品"本身，
  // 再按 `resolveBundleParts(产品, 商品ID, 色号)` 展开成部件。
  // 所以这一层不需要任何套装分支：部件是产品之间的关联（`pl_bundle_links`），不是映射行的分裂。
  const row = dbGet<{ product_id: number; variant_id: number; spec: string }>(
    `SELECT product_id, variant_id, spec FROM pl_shop_sku
     WHERE shop_id = ? AND item_id = ? AND status = 'confirmed'
       AND ${skuMappingSql()}
     ORDER BY (spec = '*' OR spec = '') ASC, id ASC
     LIMIT 1`,
    [shopId, itemId],
  );
  const pid = num(row?.product_id);
  if (!pid) return null;
  const label = productLabelMap().get(pid);
  // 产品被删 = 映射成了悬空指针：按未命中处理（进队列让人看见），不替它猜一个产品
  if (!label) return null;
  const spec = String(row?.spec ?? '').trim();
  return {
    productId: pid,
    productCode: label.code,
    productName: label.name,
    spec: spec && spec !== '*' ? spec : '',
    variantId: num(row?.variant_id),
    shopId,
    platform,
  };
}

/**
 * 「这张订单图是哪个颜色」—— 归款侧的唯一入口（实现在采集域 `shop-item-db`）。
 *
 * 为什么在**产品域**再包一层而不是让订单域直接读采集表：订单域只认产品域这一个锚点
 * （`order-db → product-db` 是已登记的唯一跨域边），采集快照是"平台事实"，
 * 由产品域统一对外transit，符合"订单不直接读采集"的分层。
 *
 * @returns `''` = 定不了（没采到过 / 图不在 SKU 图里 / 多色共用一张图 ⇒ 歧义，不猜）
 */
export function orderColorByItemImage(itemId: unknown, imageUrl: unknown): string {
  return skuColorByItemImage(itemId, imageUrl);
}

/**
 * 店铺**原文** → (店铺实体 id, 平台)：`resolveOrderSku` 的第一步单独抽出来。
 *
 * 为什么必须抽出来而不是让调用方自己拼：**人工核对回流**那条链路手上只有订单原文的店铺名，
 * 却要写 `pl_shop_sku`（那张表的键是 `(平台, 店铺 id, 商品ID)`）。规则与
 * `resolveOrderSku` / 待关联队列必须是**同一份** —— 各写一遍的症状是"队列里说这家店已归一、
 * 回流却写不进去"，而且两边分别看都正常，只能靠对着读才发现。
 *
 * `itemId` = 可选的**反向证据**（与 `resolveOrderSku` 第五级同一条）：原文归一落空时，
 * 用商品ID 反查采集快照里"这个商品归在哪家已登记店"。回流链路本来就拿着 itemId
 * （`recognizeOrderStyle` 先用它查重才走到这里），不传这级就白丢。
 *
 * @returns `shopId = 0` = 店铺尚未归一。此时**不得**写映射：订单里没有平台，
 *          拿空平台硬塞会把不同平台的同名店铺并到同一个键上（见 `shopSku.ts` 口径 3）。
 */
export function resolveShopRef(shop: unknown, itemId?: unknown): { shopId: number; platform: string } {
  const key = toNameKey(shop);
  const named = key ? (manualShopIdByKey().get(key) ?? uniqueShopByKey().get(key)?.id ?? 0) : 0;
  // 末级兜底：店铺原文认不出时用商品ID 反证（唯一命中才算；多店歧义返回 0）
  const shopId = named || shopIdByItemId(itemId);
  if (!shopId) return { shopId: 0, platform: '' };
  return { shopId, platform: shopLabelMap().get(shopId)?.platform ?? '' };
}

/**
 * 款编码 → 产品库 id。`pl_products.code` 是订单域（`oi_styles.code`）与产品域之间**唯一**的锚点
 * （ADR-002 D1），映射行存的 `product_id` 必须是它 —— 拿 `oi_styles.id` 去填会指向别的产品，
 * 而界面上两边都显示同一个款编码，症状是"配了 A 款、订单归到 B 款"。
 *
 * @returns 0 = 产品库还没建 / 该编码在产品库不存在。两种都是"**现在写不了映射**"，
 *          不是错误（老库还没跑交接时会短暂落到这一支，重跑一次就好）
 */
export function productIdByCode(code: unknown): number {
  const c = str(code, MAX.code);
  if (!c || !productSchemaReady()) return 0;
  return num(dbGet<{ id: number }>(`SELECT id FROM pl_products WHERE code = ?`, [c])?.id);
}

/**
 * 一条订单行命中的**全部**产品（一对多 / 套装）—— `resolveOrderSku` 的复数版。
 *
 * 命中规则：店铺原文先归一（人工归一优先 → 同名唯一精确命中，与 `resolveOrderSku` **同一套规则**），
 * 然后**店精确优先、回落 `shop_id = 0` 的跨店共用池** ——「商品清单」的关联行按商品维护
 * （`source='shop-import'`），不指定店铺即视为跨店共用，与 spec「精确优先、回落 `'*'`」同思路。
 *
 * ⚠️ 池行没有店铺归属，故 `platform` 可能为空串：消费方（归款）**不得**拿空平台去写映射。
 *
 * @returns [] = 未命中（无关联 / 非 confirmed / 产品已删）
 */
export function resolveOrderSkuList(input: { shop?: unknown; itemId?: unknown }): {
  productId: number;
  productCode: string;
  productName: string;
  shopId: number;
  platform: string;
}[] {
  const shopKey = toNameKey(input?.shop);
  const itemId = toSkuKey(input?.itemId);
  if (!shopKey || !itemId) return [];
  ensureSkuSchema();

  const manual = manualShopIdByKey().get(shopKey) ?? 0;
  const shopId = manual || uniqueShopByKey().get(shopKey)?.id || 0;

  const rows = dbQuery<Record<string, unknown>>(
    `SELECT product_id, shop_id, platform FROM pl_shop_sku
     WHERE item_id = ? AND status = 'confirmed' AND product_id > 0
       AND (shop_id = ? OR shop_id = 0)
     ORDER BY shop_id DESC`,
    [itemId, shopId],
  );

  const products = productLabelMap();
  const shops = shopLabelMap();
  const seen = new Set<number>();
  const out: {
    productId: number;
    productCode: string;
    productName: string;
    shopId: number;
    platform: string;
  }[] = [];
  for (const r of rows) {
    const pid = num(r.product_id);
    // 精确行排在前面，同产品只取一次（精确优先，池行不覆盖店精确行）
    if (!pid || seen.has(pid)) continue;
    const label = products.get(pid);
    if (!label) continue; // 产品已删 = 悬空指针，按未命中处理
    seen.add(pid);
    const rowShopId = num(r.shop_id);
    out.push({
      productId: pid,
      productCode: label.code,
      productName: label.name,
      shopId: rowShopId,
      platform: rowShopId ? shops.get(rowShopId)?.platform ?? '' : '',
    });
  }
  return out;
}

// ---- 映射写入 ----

function normSkuStatus(v: unknown, fallback: SkuMapStatus): SkuMapStatus {
  const s = str(v, MAX.status);
  return (SKU_MAP_STATUSES as readonly string[]).includes(s) ? (s as SkuMapStatus) : fallback;
}

/** 平台名与商品ID 一律存归一形态（见文件头口径 2） */
function normPlatform(v: unknown): string {
  return toNameKey(v);
}

/**
 * 批量写入映射（**单事务**，行级错误逐行 catch 记录 —— 与 `importProducts` 同策略）。
 *
 * 校验（不静默兜底的三种）：
 *   · 商品ID 为空 → 报错（空键会让所有空商品ID 的行共用一个映射）；
 *   · 店铺不存在 → 报错（不写成 `shop_id=0`，那会让两家店共用一个键）；
 *   · 产品不存在 → 报错（映射指向空产品等于没映射，但界面上会显示成"已关联"）。
 *
 * **改绑 = 替换**（2026-09-29 裁定）：同一 `(shop_id, item_id, spec)` 的映射行**只有一条**，
 * 提交另一个产品即替换它；一对多的「套装」不在此处维护，走「商品清单」的池行（`SKU_POOL_SOURCE`）。
 * ⭐ 2026-10-20 起判重**不含 `platform`**（店铺的副本，见 `bindingKey`）：含它时"改过平台的店"
 * 重配会新增一行、旧行留成幽灵关联。
 *
 * **改色 = 改同一条绑定**（2026-10-10，补色通道）：键只在 `spec` 上对不上、而该商品名下**同产品**
 * 恰好只有**一条**映射行时，**替换它的 spec** 而不是并排新增 —— 用户"给这个商品补个颜色"之后，
 * 旧的款级行（`*`）必须消失（否则映射列表里同商品两条、一条永远不会被命中，而人以为旧的那条已经变了）。
 *
 * ⚠️ 不能再用 `ON CONFLICT(platform, shop_id, item_id, spec)`：表的一对多改造已把 UNIQUE 扩成
 * **5 列**（含 `product_id`，池行的 N 条关联需要它），该 target 不再匹配任何唯一约束 ——
 * 症状是**每次写入都失败**（`ON CONFLICT clause does not match ...`）且只在全新库上暴露
 * （老库的 4 列键因 `CREATE TABLE IF NOT EXISTS` 保留下来，把问题掩盖了）。
 * 故这里显式「查映射行 → 命中即替换；spec 对不上时再看是否属于'同一条绑定的改色'；都不是才新增」，
 * 不再依赖唯一键形状。
 */
/**
 * 按 (产品, 颜色) 取一个变体 id —— **不让用户在弹层里把颜色选两遍**（选产品、再选颜色），
 * 变体只是"这个色的实例"，由系统按色反查即可。
 *
 * 同色多码（`黑色 L` / `黑色 XL`…）是常态，取 `id` 最小的一条作代表；
 * 该产品还没录这个色的变体则回 `0`（**不是错误** —— 映射照样成立，颜色仍由 `spec` 承载）。
 */
function variantIdByColor(productId: number, color: string): number {
  if (!color || color === '*' || !tableExists('pl_variants')) return 0;
  const r = dbGet<{ id: number }>(
    `SELECT id FROM pl_variants
     WHERE product_id = ? AND color = ? AND COALESCE(status, '') <> 'archived'
     ORDER BY id LIMIT 1`,
    [productId, color],
  );
  return num(r?.id);
}

export function upsertSkuMappings(rows: SkuMapInput[]): SkuMapOutcome {
  ensureSkuSchema();
  const list = Array.isArray(rows) ? rows : [];
  const out: SkuMapOutcome = { created: 0, updated: 0, reassigned: 0, adopted: 0, failed: [] };

  dbTransaction(() => {
    for (const r of list) {
      const itemId = toSkuKey(r?.itemId);
      try {
        if (!itemId) throw new Error('商品ID不能为空');
        const platform = normPlatform(r?.platform);
        let shopId = toId(r?.shopId);
        // shopId 允许缺省（2026-10-20）：从**拿货/拣货**页面配映射时，界面手里只有商品ID
        // （订单行不带店铺 id），硬要它先查店铺 id 就等于逼用户回「归类核对」重做一遍。
        // 认店走既有证据链末级 `shopIdByItemId`（URL → storeId → 店名 → 桶键 → 商品ID 反查），
        // **认不出就报错、不猜**：多店歧义/无证据时返回 0 ⇒ 下面照常抛"请选择店铺"。
        if (!shopId) shopId = toId(shopIdByItemId(itemId));
        if (!shopId) throw new Error('请选择店铺');
        if (tableExists('sk_shops') && !dbGet(`SELECT id FROM sk_shops WHERE id = ?`, [shopId])) {
          throw new Error('店铺不存在或已被删除');
        }
        const productId = toId(r?.productId);
        if (!productId) throw new Error('请选择产品');
        if (!dbGet(`SELECT id FROM pl_products WHERE id = ?`, [productId])) {
          throw new Error('产品不存在或已被删除');
        }
        const spec = str(r?.spec, 40) || '*';
        const status = normSkuStatus(r?.status, 'confirmed');
        const note = str(r?.note, MAX.note);
        // 变体关联由颜色反查（见 `variantIdByColor`）—— 调用方只管配颜色，不必知道变体 id
        const variantId = variantIdByColor(productId, spec);

        // 只认映射行（池行的绑定不参与一对一改绑）；命中即整体替换该行的产品与状态。
        // ⚠️ 判重**不含平台**（2026-10-20）：平台是店铺的副本，用它判重会让"改过平台的店"
        // 在重配时**新增**一行、旧行留成永远命中不了的幽灵关联（产品详情里还会被算进"已关联"）。
        const existing = dbGet<{ id: number }>(
          `SELECT id FROM pl_shop_sku
           WHERE shop_id = ? AND item_id = ? AND spec = ? AND ${skuMappingSql()}
           ORDER BY id LIMIT 1`,
          [shopId, itemId, spec],
        );
        if (existing) {
          // 顺手把 `platform` 副本刷新成店铺当前值：它不参与匹配，但留在表里的旧值会让看库的人
          // 以为这家店还在别的平台（"改过平台的店"重配一次就自洽了，不用专门写迁移）
          dbRun(
            `UPDATE pl_shop_sku
             SET platform = ?, product_id = ?, variant_id = ?, status = ?, source = 'manual', note = ?,
                 updated_at = datetime('now','localtime')
             WHERE id = ?`,
            [platform, productId, variantId, status, note, existing.id],
          );
          out.updated++;
        } else {
          // 键在 spec 上对不上：先看是不是"**同一条绑定的改色**"——该商品名下**同产品**
          // 恰好已有**一条**映射行时，改色 = **替换它的 spec**，而不是在它旁边新增一条。
          // 旁留的旧行永远命中不了（`resolveOrderSku` 只取一条、带色行优先），而人以为它已经变了
          //（症状：映射列表里同商品两条，一条 `*` 一条带色，看不出哪条算数）。
          // 判据带"同产品"是有意的：同商品把**不同颜色绑到不同产品**是既有合法形态（带色行优先
          // 就是为它设计的），那种写入是在**新增一条绑定**，不能把既有行替换掉；
          // 已有 2+ 条同产品行（历史数据）也无从判断该动哪条，维持"新增"。
          const twin = dbQuery<{ id: number }>(
            `SELECT id FROM pl_shop_sku
              WHERE shop_id = ? AND item_id = ? AND product_id = ? AND ${skuMappingSql()}
              ORDER BY id LIMIT 2`,
            [shopId, itemId, productId],
          );
          if (twin.length === 1) {
            dbRun(
              `UPDATE pl_shop_sku
               SET spec = ?, variant_id = ?, status = ?, source = 'manual', note = ?,
                   updated_at = datetime('now','localtime')
               WHERE id = ?`,
              [spec, variantId, status, note, twin[0].id],
            );
            out.updated++;
          } else {
            dbRun(
              `INSERT INTO pl_shop_sku (platform, shop_id, item_id, spec, product_id, variant_id, status, source, note)
               VALUES (?,?,?,?,?,?,?,'manual',?)`,
              [platform, shopId, itemId, spec, productId, variantId, status, note],
            );
            out.created++;
          }
        }
      } catch (e) {
        out.failed.push({
          itemId: itemId || String(r?.itemId ?? ''),
          message: e instanceof Error ? e.message : String(e),
        });
      }
    }
  });

  return out;
}

/** 标失效（商品ID 变了）：**不物理删除**，否则关联率会莫名回落且查不出原因（§3.5-2） */
export function invalidateSkuMapping(id: number): { changed: boolean } {
  ensureSkuSchema();
  const mid = toId(id);
  if (!mid) return { changed: false };
  const info = dbRun(
    `UPDATE pl_shop_sku SET status = 'invalid', updated_at = datetime('now','localtime') WHERE id = ?`,
    [mid],
  );
  return { changed: info.changes > 0 };
}

// ═══════════════════════════════════════════════════════════════════════════════════
// SKU 子表（pl_variants，P5 计划的表提前落地）+ 产品图（`md_images`，主数据域）
// ═══════════════════════════════════════════════════════════════════════════════════
//
// pl_variants    一个款（pl_products.id）下**多个 SKU**（颜色/尺码），每 SKU 一个克重。
//                与 pl_item_weights（键 = 商品ID，来自「商品信息」Excel，**只读导入**）分层：
//                变体是人工维护的款维度主数据；商品ID 克重是订单算运费的输入。两者不互写。
// md_images      全项目**唯一**图片仓（`electron/master-data-db.ts` 拥有）：`fingerprint` = 内容 SHA-256
//                唯一，二进制在 `userData/images/`（不入库）。本域只读它，登记走 `registerImageRow`。
//                产品主图 = `pl_products.image_id`；商品覆盖图 = `pl_shop_items.image_id`。
//                两层都指向同一张表 ⇒ 不再有「产品图 / 订单图各自一套 id」的撞车与双份去重。
// 取图三层回落（`itemImagePool`）：商品覆盖图（`pl_shop_items.image_id`）→ 订单图
//                （`oi_order_items.raw_fields` 命中该商品ID 的行，`image_id → md_images`，最新在前）
//                → 款主图（映射 → `pl_products.image_id`）。

export interface VariantRow {
  id: number;
  productId: number;
  /** SKU 编码（可空；非空时全局唯一 —— 部分唯一索引，空串不参与约束） */
  code: string;
  name: string;
  /** 颜色（服装 SKU；老数据可能为空 —— 老行只有自由文本 name） */
  color: string;
  /** 尺码（服装 SKU；与 color 成对填写，成对时 name = "颜色 尺码" 自动生成） */
  size: string;
  /** 克重（克，整数；0 = 未填）。口径与 pl_item_weights.weight_g 一致 */
  weightG: number;
  status: string;
  createdAt: string;
  updatedAt: string;
}

export interface VariantUpsertInput {
  /** 0 / 缺省 = 新增 */
  id: number;
  productId: number;
  code: string;
  /** 自由文本名称（color+size 都填时**自动覆盖**为 "颜色 尺码"；老数据只传 name 仍兼容） */
  name: string;
  color: string;
  size: string;
  weightG: number;
  status: string;
}

export interface ProductImageRef {
  /** `md_images.id`（三层回落都指向同一张图仓）——仅标识用，展示走 localPath */
  imageId: number;
  /** 缓存文件的绝对路径；渲染层经 order-image-thumb(-batch) 取缩略图 dataUrl */
  localPath: string;
}

/** 一个商品ID的候选图（**有序回落**：override → order[] → product） */
export interface ItemImagePoolEntry {
  override: ProductImageRef | null;
  /** 订单识别图（可能多张，最新的在前） */
  order: ProductImageRef[];
  product: ProductImageRef | null;
}

const VARIANT_SCHEMA = [
  // `pl_variants`：产品下的 SKU（颜色 + 尺码组合），`product_id` 软关联（无外键）、`(product_id,name)` 唯一。
  // `code` 非空时全局唯一（部分唯一索引）；`weight_g` 是拣货/运费重量的唯一落点（不再有商品级克重表）。
  // 写 = 产品库 SKU 矩阵 / 导入；读 = 拣货、成本、商品映射的 `variant_id` 反查。
  `CREATE TABLE IF NOT EXISTS pl_variants (
    -- 用途：产品 SKU（颜色+尺码组合，product_id 软关联，同产品内 name 唯一）；weight_g 是拣货/运费的唯一克重落点。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    code TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    color TEXT NOT NULL DEFAULT '',
    size TEXT NOT NULL DEFAULT '',
    weight_g INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(product_id, name)
  )`,
  // SKU 编码非空时**全局**唯一（部分唯一索引，与 sk_shops.platform_shop_id 同一手法：
  // 不写 WHERE 的话一批空串会互相撞唯一键）。拣货按编码找 SKU，全局唯一才不会歧义。
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_pl_variants_code
     ON pl_variants(code) WHERE code <> ''`,
  `CREATE INDEX IF NOT EXISTS idx_pl_variants_product ON pl_variants(product_id)`,
];

/**
 * 幂等补列（**老库**）—— color/size 只写进了 CREATE TABLE 的话老库永远拿不到它
 * （`CREATE TABLE IF NOT EXISTS` 对已存在的表一个字都不改）。判定用 `PRAGMA table_info`。
 * 老行 color/size 为空、name 原样保留（自由文本历史不改写，见 shopName 同一纪律）。
 */
function ensureVariantColumns(): void {
  const cols = new Set(
    dbQuery<{ name: string }>(`PRAGMA table_info(pl_variants)`).map((r) => String(r.name ?? '')),
  );
  if (!cols.has('color')) {
    dbRun(`ALTER TABLE pl_variants ADD COLUMN color TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.has('size')) {
    dbRun(`ALTER TABLE pl_variants ADD COLUMN size TEXT NOT NULL DEFAULT ''`);
  }
}

/** 幂等初始化（SKU + 图片主数据；与 ensureProductSchema 同挂载点调用）
 *  图片表（`md_images`）由主数据域拥有，这里只是**确保它建好**（本域查询要 JOIN 它）。 */
export function ensureVariantSchema(): void {
  initDb();
  dbMigrate(VARIANT_SCHEMA);
  ensureVariantColumns();
  ensureMasterDataSchema();
}

// ---- SKU 子表 ----

const VARIANT_MAX = { code: 64, name: 200, color: 40, size: 40, status: 20 } as const;

function normVariantStatus(v: unknown): string {
  const s = str(v, VARIANT_MAX.status);
  return (PRODUCT_STATUSES as readonly string[]).includes(s) ? s : 'active';
}

const VARIANT_COLS = `id, product_id, code, name, color, size, weight_g, status, created_at, updated_at`;

function mapVariantRow(row: Record<string, unknown>): VariantRow {
  return {
    id: num(row.id),
    productId: num(row.product_id),
    code: String(row.code ?? ''),
    name: String(row.name ?? ''),
    color: String(row.color ?? ''),
    size: String(row.size ?? ''),
    weightG: num(row.weight_g),
    status: String(row.status ?? 'active'),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

/**
 * 新增 / 更新 SKU（全量提交；同款下名称唯一，编码非空时全局唯一）。
 * color+size 成对填写时 name 自动生成为 "颜色 尺码"（`UNIQUE(product_id, name)` 顺带保证
 * 同款下颜色尺码组合不重复）；只传 name（老数据路径）行为不变。
 * 冲突**分别抛不同文案**（撞组合改个颜色尺码、撞编码是录错了 SKU），一句"已存在"会让人修错地方。
 */
export function variantUpsert(input: VariantUpsertInput): { id: number; created: boolean } {
  ensureVariantSchema();
  const productId = toId(input?.productId);
  if (!productId) throw new Error('请指定所属产品');
  const color = str(input?.color, VARIANT_MAX.color);
  const size = str(input?.size, VARIANT_MAX.size);
  if (!color !== !size) throw new Error('颜色和尺码要成对填写（或都不填，仅老数据用名称）');
  const composed = [color, size].filter(Boolean).join(' ');
  const name = composed || str(input?.name, VARIANT_MAX.name);
  if (!name) throw new Error('请填写颜色和尺码');
  const code = str(input?.code, VARIANT_MAX.code);
  const weightG = Math.round(Number(input?.weightG));
  if (!Number.isFinite(weightG) || weightG < 0) throw new Error('克重必须是不小于 0 的整数（克）');

  const id = toId(input?.id);

  // 更新时先确认目标存在，再查占用 —— 与 upsertProduct 同序（别把"改已删除的 SKU"报成"已存在"）
  if (id) {
    const cur = dbGet<{ id: number; product_id: number }>(
      `SELECT id, product_id FROM pl_variants WHERE id = ?`,
      [id],
    );
    if (!cur) throw new Error('SKU 不存在或已被删除');
    if (num(cur.product_id) !== productId) throw new Error('SKU 不属于该产品，不能跨款改绑');
  } else if (!dbGet<{ id: number }>(`SELECT id FROM pl_products WHERE id = ?`, [productId])) {
    throw new Error('产品不存在或已被删除');
  }

  const dupName = dbGet<{ id: number }>(
    `SELECT id FROM pl_variants WHERE product_id = ? AND name = ? AND id <> ?`,
    [productId, name, id],
  );
  if (dupName) {
    throw new Error(
      composed
        ? `该款下已存在相同颜色尺码的 SKU：${name}`
        : `该款下已存在同名 SKU：${name}`,
    );
  }

  if (code) {
    const dupCode = dbGet<{ id: number; name: string }>(
      `SELECT id, name FROM pl_variants WHERE code = ? AND id <> ?`,
      [code, id],
    );
    if (dupCode) {
      throw new Error(`SKU 编码已被占用：${code}（${dupCode.name}）—— 一个编码只能对应一个 SKU`);
    }
  }

  if (id) {
    dbRun(
      `UPDATE pl_variants SET product_id=?, code=?, name=?, color=?, size=?, weight_g=?, status=?, updated_at=datetime('now','localtime') WHERE id=?`,
      [productId, code, name, color, size, weightG, normVariantStatus(input?.status), id],
    );
    return { id, created: false };
  }
  const info = dbRun(
    `INSERT INTO pl_variants (product_id, code, name, color, size, weight_g, status) VALUES (?,?,?,?,?,?,?)`,
    [productId, code, name, color, size, weightG, normVariantStatus(input?.status)],
  );
  return { id: Number(info.lastInsertRowid), created: true };
}

/** 删除 SKU（物理删除；variant_id 引用它的映射行不做级联 —— 一期 variant_id 恒 0） */
export function variantDelete(id: number): { removed: number } {
  ensureVariantSchema();
  const vid = toId(id);
  if (!vid) return { removed: 0 };
  const info = dbRun(`DELETE FROM pl_variants WHERE id = ?`, [vid]);
  return { removed: info.changes };
}

/** 按款批量拉 SKU（无 SKU 的款不在返回里；按 product_id, id 排序，界面按款分组展示） */
export function variantList(productIds: number[]): VariantRow[] {
  ensureVariantSchema();
  const ids = [
    ...new Set((Array.isArray(productIds) ? productIds : []).map((x) => toId(x)).filter(Boolean)),
  ];
  if (!ids.length) return [];
  const placeholders = ids.map(() => '?').join(',');
  return dbQuery<Record<string, unknown>>(
    `SELECT ${VARIANT_COLS} FROM pl_variants WHERE product_id IN (${placeholders})
     ORDER BY product_id ASC, id ASC`,
    ids,
  ).map(mapVariantRow);
}

// ---- 产品图（`md_images` 主数据域 + `pl_products.image_id`） ----

/**
 * 登记一张已落盘的图（同指纹复用既有行）。
 *
 * ⚠️ 函数名保留是为了不惊动历史调用方（handler / 冒烟），**实现已委托主数据域的
 * `registerImageRow`**：全项目只有一张图片表，登记口径（指纹、去重、默认 source）只此一份。
 * 二进制落盘不在这里 —— 那是 `master-data-db.landImageBytes` 的事。
 */
export function upsertImageRecord(input: {
  fingerprint: string;
  localPath: string;
  source?: string;
}): { imageId: number; reused: boolean } {
  ensureVariantSchema();
  const out = registerImageRow({
    fingerprint: str(input?.fingerprint, 128),
    localPath: str(input?.localPath, 1024),
    source: str(input?.source, 40) || 'upload',
  });
  return { imageId: out.imageId, reused: out.reused };
}

/** 设置款主图（窄接口：**不进 upsertProduct**，全量提交会把它按缺省值清掉） */
export function attachProductImage(productId: number, imageId: number): { changed: boolean } {
  ensureProductSchema();
  ensureVariantSchema();
  const pid = toId(productId);
  const iid = toId(imageId);
  if (!pid) throw new Error('请指定产品');
  if (!iid) throw new Error('请指定图片');
  if (!dbGet<{ id: number }>(`SELECT id FROM pl_products WHERE id = ?`, [pid])) {
    throw new Error('产品不存在或已被删除');
  }
  if (!imageIdExists(iid)) {
    throw new Error('图片不存在或已被删除');
  }
  dbRun(
    `UPDATE pl_products SET image_id = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
    [iid, pid],
  );
  return { changed: true };
}

/**
 * 把**已入库**的图片采纳为款主图（**只补空**：款已有主图时不动，返回 false）。
 *
 * 与 `adoptOrderImages` 的差别只在采纳源（那个从订单图来，这个从采集图来）——
 * 落点与纪律是同一件：`attachProductImage` 是同一条写路径，"只补空"的判定也收在这里，
 * 不靠调用方自觉（调用方传个 productId 就覆盖的话，"款已有主图不覆盖"这条验收就落空了）。
 */
export function adoptProductImageIfEmpty(productId: number, imageId: number): boolean {
  ensureProductSchema();
  const pid = toId(productId);
  const iid = toId(imageId);
  if (!pid || !iid) return false;
  const row = dbGet<{ image_id: number }>(`SELECT image_id FROM pl_products WHERE id = ?`, [pid]);
  if (!row) return false;
  if (Number(row.image_id) || 0) return false;
  attachProductImage(pid, iid);
  return true;
}

/**
 * 按产品 id 取款编码（`pl_products.code`；产品已删返回 ''）。
 * 色图采纳要用它定位识别池里的款色（`ensureStyleByCode`）—— 编码从**产品行**取，
 * 不接收渲染层传的字符串：传错就是在识别池里建一个张冠李戴的占位款。
 */
export function getProductCode(productId: number): string {
  ensureProductSchema();
  const pid = toId(productId);
  if (!pid) return '';
  const row = dbGet<{ code: string }>(`SELECT code FROM pl_products WHERE id = ?`, [pid]);
  return row ? String(row.code ?? '') : '';
}

/** 移除款主图（`md_images` 行与字节保留 —— 可能仍被订单行 / 采集行引用；孤图清理另议） */
export function detachProductImage(productId: number): { changed: boolean } {
  ensureVariantSchema();
  const pid = toId(productId);
  if (!pid) return { changed: false };
  const info = dbRun(
    `UPDATE pl_products SET image_id = 0, updated_at = datetime('now','localtime') WHERE id = ?`,
    [pid],
  );
  return { changed: info.changes > 0 };
}

// ---- 商品ID 覆盖图（落 `pl_shop_items.image_id`） ----

/**
 * 设置商品ID的覆盖图（item_id 存归一形态，与映射表同口径）。
 *
 * 落点是**采集快照行自己的 `image_id`**（`pl_shop_items` 唯一键 `(shop_id, store_key, item_id)`），
 * 一个商品ID 在多店/多行时逐行同写 —— 覆盖图是"这个商品就用这张"的决定，与店铺无关。
 * 没有任何采集行时**显式报错**：旧实现能凭空插一行映射（`pl_item_images` 以 item_id 为主键），
 * 但那个商品的元数据并不存在，图上去了也无处展示、且会在图池里成为一个孤键。
 */
export function setItemImage(input: { itemId: string; imageId: number }): { changed: boolean } {
  ensureVariantSchema();
  const key = toSkuKey(input?.itemId);
  const iid = toId(input?.imageId);
  if (!key) throw new Error('商品ID不能为空');
  if (!iid) throw new Error('请指定图片');
  if (!imageIdExists(iid)) {
    throw new Error('图片不存在或已被删除');
  }
  const info = dbRun(
    `UPDATE pl_shop_items SET image_id = ?, updated_at = datetime('now','localtime')
      WHERE item_id = ?`,
    [iid, key],
  );
  if (info.changes <= 0) {
    throw new Error(`商品ID ${key} 还没有采集到的店铺商品行 —— 先采集商品，再设覆盖图`);
  }
  return { changed: true };
}

/** 清除商品ID的覆盖图（回到"自动聚合"回落链；图片行与字节保留） */
export function clearItemImage(itemId: string): { removed: number } {
  ensureVariantSchema();
  const key = toSkuKey(itemId);
  if (!key) return { removed: 0 };
  const info = dbRun(
    `UPDATE pl_shop_items SET image_id = 0, updated_at = datetime('now','localtime')
      WHERE item_id = ? AND image_id <> 0`,
    [key],
  );
  return { removed: info.changes };
}

// ---- 取图三层回落（映射与关联列表 / 待关联队列共用） ----

/** 订单图池扫描上限（与 shopSkuQueue 同量级；超过部分不参与取图） */
const IMAGE_POOL_SCAN_LIMIT = 50000;
/** 每个商品ID最多带几张订单图（界面展示 1 张 + 换图时看候选） */
const ORDER_IMAGES_PER_ITEM = 3;

/**
 * 批量取商品ID的候选图（**三层回落，逐 item 独立判定**）：
 *   ① 商品覆盖图 —— `pl_shop_items.image_id`（人的显式决定，最高优先）；
 *   ② 订单图 —— `oi_order_items.image_id` 非空的订单行，raw_fields 商品ID 命中即收集（最新在前）；
 *   ③ 款主图 —— 该商品ID 的 confirmed 映射 → `pl_products.image_id`（多行映射取任一，确定性按 id 升序）。
 * 三层都指向同一张图仓 `md_images`（R1）—— 候选图之间不再有"这张图在哪个表里"的分叉。
 * 不做模糊匹配：商品ID 是精确键（toSkuKey 归一后比对），命中不了就回落下一层。
 */
export function itemImagePool(itemIds: string[]): Map<string, ItemImagePoolEntry> {
  ensureVariantSchema();
  const keys = [
    ...new Set((Array.isArray(itemIds) ? itemIds : []).map((x) => toSkuKey(x)).filter(Boolean)),
  ];
  const out = new Map<string, ItemImagePoolEntry>();
  if (!keys.length) return out;
  for (const k of keys) out.set(k, { override: null, order: [], product: null });

  // ① 商品覆盖图（采集快照行自己的 image_id；同 itemId 多行时取最早一行，确定性）
  if (tableExists('pl_shop_items') && tableExists('md_images')) {
    const placeholders = keys.map(() => '?').join(',');
    for (const r of dbQuery<Record<string, unknown>>(
      `SELECT si.item_id AS item_id, si.image_id AS image_id, i.local_path AS local_path
       FROM pl_shop_items si JOIN md_images i ON i.id = si.image_id
       WHERE si.image_id <> 0 AND si.item_id IN (${placeholders})
       ORDER BY si.id ASC`,
      keys,
    )) {
      const e = out.get(String(r.item_id ?? ''));
      if (e && !e.override) {
        e.override = { imageId: num(r.image_id), localPath: String(r.local_path ?? '') };
      }
    }
  }

  // ② 订单图：商品ID 只在明细表 raw_fields JSON 里（与队列同一条扫描路径）
  if (tableExists('oi_order_items')) {
    const keySet = new Set(keys);
    /** 先挑出命中的 (itemId, imageId)，再**一次**查出本地路径（避免逐行 SQL） */
    const collected = new Map<string, number[]>();
    const rows = dbQuery<Record<string, unknown>>(
      `SELECT id, image_id, raw_fields FROM oi_order_items
       WHERE image_id IS NOT NULL ORDER BY id DESC LIMIT ${IMAGE_POOL_SCAN_LIMIT}`,
    );
    for (const r of rows) {
      let itemId = '';
      try {
        const rf = typeof r.raw_fields === 'string' ? JSON.parse(r.raw_fields) : r.raw_fields;
        itemId = toSkuKey(extractSkuFields(rf).itemId);
      } catch {
        continue; // raw_fields 不是合法 JSON 的行跳过（不让一条脏行毁掉整池）
      }
      if (!itemId || !keySet.has(itemId)) continue;
      const iid = num(r.image_id);
      if (!iid) continue;
      const list = collected.get(itemId) ?? [];
      if (list.length >= ORDER_IMAGES_PER_ITEM) continue;
      // 同一张图可能被同一商品ID 的多条订单行复用 —— 去重但保留"最新在前"的顺序
      if (list.includes(iid)) continue;
      list.push(iid);
      collected.set(itemId, list);
    }
    const paths = imageLocalPathMap([...collected.values()].flat());
    for (const [k, ids] of collected) {
      const e = out.get(k);
      if (!e) continue;
      e.order = ids
        .map((id) => ({ imageId: id, localPath: paths.get(id) ?? '' }))
        .filter((ref) => !!ref.localPath);
    }
  }

  // ③ 款主图：映射 → 产品 → image_id → md_images
  if (tableExists('pl_shop_sku') && tableExists('pl_products') && tableExists('md_images')) {
    const placeholders = keys.map(() => '?').join(',');
    for (const r of dbQuery<Record<string, unknown>>(
      `SELECT s.item_id AS item_id, p.image_id AS image_id, i.local_path AS local_path
       FROM pl_shop_sku s
       JOIN pl_products p ON p.id = s.product_id
       JOIN md_images i ON i.id = p.image_id
       WHERE s.status = 'confirmed' AND s.item_id IN (${placeholders})
       ORDER BY s.id ASC`,
      keys,
    )) {
      const e = out.get(String(r.item_id ?? ''));
      // 一款主图就够：多店铺映射到同一商品ID时取第一条（id 升序 = 最早建立的映射）
      if (e && !e.product) {
        e.product = { imageId: num(r.image_id), localPath: String(r.local_path ?? '') };
      }
    }
  }

  return out;
}

// ---- 认款时顺手采纳：订单图 → 款主图 ----

/** 一条「该把哪张图采纳给哪个款」的待办（本层只挑，落库在 handler 层） */
export interface ProductImageAdoption {
  productId: number;
  /** 归一后的商品ID（池键口径，回查/日志用） */
  itemId: string;
  /** **首选图**的缓存路径（与界面里显示给用户的是同一张） */
  localPath: string;
  /** 来源（人话）：覆盖图 = 人手工设过的；订单图 = 订单报表自带的 */
  source: string;
}

/**
 * 挑出「认款那一刻该顺手采纳的订单图」：入参是本次写入的 (productId, itemId) 对，出参是待办列表。
 *
 * 三条规则都是「不做多余的事」：
 *   ① **只补空**：`pl_products.image_id = 0`（还没主图）才采纳 —— 已有主图的款一律不动
 *      （主图是人的决定，程序不该悄悄换掉它）；
 *   ② **取与界面同一张**：用 `itemImagePool` 的**首选**（覆盖图 → 订单识别图），这样"你刚才
 *      看着的那张图"就是被采纳的那张；款主图那层此刻必为空（见 ①），跳过；
 *   ③ **确定性**：同一个款被多个商品ID 映射时取 `productId` 升序 + `itemKey` 升序的第一个 ——
 *      不依赖 Map 插入顺序 / SQL 返回顺序（否则同一次操作两次跑出不同的图）。
 *
 * ⚠️ 本层**不碰文件**：只回路径。复制文件、算指纹、登记 `md_images`、写 `pl_products.image_id`
 * 全在 handler 层（与 `product-image-attach` 同一套实现，口径只此一份）。
 */
export function pendingProductImages(
  pairs: readonly { productId?: unknown; itemId?: unknown }[],
): ProductImageAdoption[] {
  ensureVariantSchema();
  const list: { productId: number; itemKey: string }[] = [];
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const pid = toId(p?.productId);
    const key = toSkuKey(p?.itemId);
    if (!pid || !key) continue;
    list.push({ productId: pid, itemKey: key });
  }
  if (!list.length) return [];
  list.sort(
    (a, b) =>
      a.productId - b.productId || (a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0),
  );

  // 一个款只采纳一张：同款被多个商品映射时，取排序后的第一个（确定性）
  const firstItemByProduct = new Map<number, string>();
  for (const r of list) {
    if (!firstItemByProduct.has(r.productId)) firstItemByProduct.set(r.productId, r.itemKey);
  }

  const need: { productId: number; itemKey: string }[] = [];
  for (const [productId, itemKey] of firstItemByProduct) {
    const row = dbGet<{ image_id: number }>(`SELECT image_id FROM pl_products WHERE id = ?`, [
      productId,
    ]);
    if (!row) continue; // 产品不存在：映射那步已经报过失败，这里静默跳过
    if (num(row.image_id)) continue; // ① 已有主图 → 只补空、不覆盖
    need.push({ productId, itemKey });
  }
  if (!need.length) return [];

  const pool = itemImagePool(need.map((x) => x.itemKey));
  const out: ProductImageAdoption[] = [];
  for (const n of need) {
    const e = pool.get(n.itemKey);
    const hit = e?.override ?? e?.order?.[0] ?? null; // ② 与界面首选同口径
    if (!hit || !hit.localPath) continue; // 这个商品在订单里也没有图 → 没什么可采纳的
    out.push({
      productId: n.productId,
      itemId: n.itemKey,
      localPath: hit.localPath,
      source: e?.override ? 'item-override' : 'order-image',
    });
  }
  return out;
}

/** 一条「该去下载哪张远程采集图并采纳给哪个款」的待办（本层只挑，下载在 handler 层） */
export interface RemoteProductImageAdoption {
  productId: number;
  /** 归一后的商品ID */
  itemId: string;
  /** `pl_shop_items` 行 id —— 下载入库后要回填它的 `image_id`，列表下次就能直接用本地图 */
  shopItemId: number;
  imageUrl: string;
}

/**
 * 认款补图的**第二档**：「产品没主图 + 采集商品只有远程 `image_url`」。
 *
 * 为什么 `pendingProductImages` 不够：它只发**本地**图（订单图 / 人工覆盖图）。采集回来的商品
 * 常常还没下载主图（`pl_shop_items.image_id = 0`，但 `image_url` 有值，界面**直接拿远程 URL 显示**）。
 * 用户在「款与商品」认款时看到的就是这张远程图；不把它落库，款侧永远是一张白图
 * （2026-10-30 用户实报：认款后主图还是没有）。
 *
 * 规则与 `pendingProductImages` 同口径：① 只补空（`pl_products.image_id = 0`）；
 * ② 一个款只挑一张，按 `productId` + `itemKey` 升序取第一个（确定性）；
 * ③ 只挑**还没入库**的采集行（`image_id = 0` 且有 URL）—— 已经入过库的交给第一档；
 * ④ 本层**不做网络**：下载、登记 `md_images`、回填采集行、写产品主图全在 handler 层。
 */
export function pendingRemoteProductImages(
  pairs: readonly { productId?: unknown; itemId?: unknown }[],
): RemoteProductImageAdoption[] {
  ensureVariantSchema();
  if (!tableExists('pl_shop_items')) return [];
  const list: { productId: number; itemKey: string }[] = [];
  for (const p of Array.isArray(pairs) ? pairs : []) {
    const pid = toId(p?.productId);
    const key = toSkuKey(p?.itemId);
    if (!pid || !key) continue;
    list.push({ productId: pid, itemKey: key });
  }
  if (!list.length) return [];
  list.sort(
    (a, b) =>
      a.productId - b.productId || (a.itemKey < b.itemKey ? -1 : a.itemKey > b.itemKey ? 1 : 0),
  );

  const firstItemByProduct = new Map<number, string>();
  for (const r of list) {
    if (!firstItemByProduct.has(r.productId)) firstItemByProduct.set(r.productId, r.itemKey);
  }

  const need: { productId: number; itemKey: string }[] = [];
  for (const [productId, itemKey] of firstItemByProduct) {
    const row = dbGet<{ image_id: number }>(`SELECT image_id FROM pl_products WHERE id = ?`, [
      productId,
    ]);
    if (!row) continue;
    if (num(row.image_id)) continue; // ① 已有主图 → 只补空、不覆盖
    need.push({ productId, itemKey });
  }
  if (!need.length) return [];

  const keys = [...new Set(need.map((x) => x.itemKey))];
  const placeholders = keys.map(() => '?').join(',');
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT id, item_id, image_url FROM pl_shop_items
     WHERE image_id = 0 AND image_url <> '' AND item_id IN (${placeholders})
     ORDER BY id ASC`,
    keys,
  );
  // 同一商品ID 可能有多家店各一行（同图）；取 id 最小的一条，结果与 SQL 顺序无关
  const byItem = new Map<string, { shopItemId: number; imageUrl: string }>();
  for (const r of rows) {
    const key = toSkuKey(r.item_id);
    if (!key || byItem.has(key)) continue;
    const imageUrl = String(r.image_url ?? '').trim();
    if (!imageUrl) continue;
    byItem.set(key, { shopItemId: Number(r.id) || 0, imageUrl });
  }

  const out: RemoteProductImageAdoption[] = [];
  for (const n of need) {
    const hit = byItem.get(n.itemKey);
    if (!hit?.shopItemId) continue;
    out.push({
      productId: n.productId,
      itemId: n.itemKey,
      shopItemId: hit.shopItemId,
      imageUrl: hit.imageUrl,
    });
  }
  return out;
}

/**
 * 全库「已确认认款」的 (款, 商品ID) 配对 —— 存量补图（`product-sku-repair-images`）的输入。
 *
 * 为什么需要它：认款顺手补图只在**写入那一刻**跑。升级前就认过的映射不会自己长图，
 * 用户看到的就是"认款后主图还是没有"（2026-10-30 实报）。补图时无从知道"当时那一批行"，
 * 只能从库里把已确认的配对重新取出来。
 *
 * 口径与 `upsertSkuMappings` 的映射行一致（`skuMappingSql`：排除商品清单的池行），
 * 商品ID 归一后去重；排序固定（含产品 id），让"一款只补一张"的选择可复现。
 */
export function confirmedMapPairs(): { productId: number; itemId: string }[] {
  ensureProductSchema();
  ensureSkuSchema();
  if (!tableExists('pl_shop_sku')) return [];
  const rows = dbQuery<{ product_id: number; item_id: string }>(
    `SELECT DISTINCT product_id, item_id FROM pl_shop_sku
      WHERE status = 'confirmed' AND product_id > 0 AND ${skuMappingSql('')}
      ORDER BY product_id ASC, item_id ASC`,
  );
  // 归一 + 去重必须放在**出参**这一层：`DISTINCT` 比的是库里的原文，而历史数据/手工行可能
  // 带着空白（`B0PAIR1` 与 ` B0PAIR1 ` 是同一件商品）。只按原文去重会让同一款同一商品出现两次，
  // 「一款只补一张」的选择就会随库里的排列顺序漂移（SQL 排序也按原文，空白会排到前面）。
  const seen = new Set<string>();
  const out: { productId: number; itemId: string }[] = [];
  for (const r of rows) {
    const pid = toId(r.product_id);
    const key = toSkuKey(r.item_id);
    if (!pid || !key) continue;
    const dedupe = `${pid}\u0000${key}`;
    if (seen.has(dedupe)) continue;
    seen.add(dedupe);
    out.push({ productId: pid, itemId: key });
  }
  out.sort(
    (a, b) =>
      a.productId - b.productId || (a.itemId < b.itemId ? -1 : a.itemId > b.itemId ? 1 : 0),
  );
  return out;
}


// ─────────────────────────────────────────────────────────────────────────────
// 套装（产品关联子商品）
//
// 一个套装 = 一组关联行：`(套装产品, 商品ID?, 色号) → (子商品, 子颜色, 件数)`。
// 子商品是**独立产品**（`pl_products` 的一行），本层不复制它的名称/价格/图片 ——
// 所以子商品照常单独卖，套装这边不会出现"改了子商品、套装那份没跟上"。
//
// 展开出来的东西只回答"这一套该拆成哪些 (款, 色, 件数)"，**不碰尺码**：
// 尺码属于订单行，展开时继承给每一件（同码套装是常态；真要上衣 L 裤 M 再加 size_override）。
// ─────────────────────────────────────────────────────────────────────────────

/** 一个套装最多几个部件（防误操作刷出一万个；三件套/四件套远用不到 12） */
const MAX_BUNDLE_PARTS = 12;
const MAX_BUNDLE_QTY = 99;
/** 部件名长度上限（`上衣`/`裤子`/`马甲`；不校验取值范围 —— 自由文本，别替用户规定叫法） */
const MAX_BUNDLE_ROLE = 20;

export interface BundleLinkInput {
  /** 部件名（同一套装同一色号内唯一；也是唯一键的一半） */
  role: string;
  childProductId: number;
  /** 子商品的颜色（自家色名）。**必填**：宁可报缺，也不拿父级或别的色凑 */
  childColor: string;
  /** 每套几件 */
  qty?: number;
}

export interface BundleLinkRow {
  id: number;
  productId: number;
  /** '' = 该套装产品所有商品通用 */
  itemId: string;
  /** 已按 `colorAliasKey` 归一（平台色号 `8` / `Khaki`） */
  aliasKey: string;
  role: string;
  childProductId: number;
  /** 子商品编码/名称（由 `pl_products` 派生，不落库） */
  childCode: string;
  childName: string;
  childColor: string;
  qty: number;
}

export interface ResolvedBundlePart {
  role: string;
  childProductId: number;
  childCode: string;
  childName: string;
  color: string;
  qty: number;
}

export interface ResolvedBundle {
  /** 该产品在任何色号下有没有关联行（= 它是不是套装） */
  isBundle: boolean;
  /** 这个色号**配过**没有。false ⇒ 调用方进"待配"，不许回落别的色号 */
  matched: boolean;
  /** 命中的作用域：商品级（点名）优先于产品级（提示） */
  matchedScope: 'item' | 'product' | 'none';
  parts: ResolvedBundlePart[];
}

const NO_BUNDLE: ResolvedBundle = { isBundle: false, matched: false, matchedScope: 'none', parts: [] };

/** 全部关联行（按色号 → 部件名稳定排序，与录入顺序无关） */
export function bundleLinksOf(productId: unknown): BundleLinkRow[] {
  const pid = toId(productId);
  if (!pid) return [];
  return dbQuery<Record<string, unknown>>(
    `SELECT b.id, b.product_id, b.item_id, b.alias_key, b.role, b.child_product_id,
            b.child_color, b.qty,
            COALESCE(p.code, '') AS child_code, COALESCE(p.name, '') AS child_name
       FROM pl_bundle_links b
       LEFT JOIN pl_products p ON p.id = b.child_product_id
      WHERE b.product_id = ?
      ORDER BY b.alias_key, b.role`,
    [pid],
  ).map((r) => ({
    id: num(r.id),
    productId: num(r.product_id),
    itemId: String(r.item_id ?? ''),
    aliasKey: String(r.alias_key ?? ''),
    role: String(r.role ?? ''),
    childProductId: num(r.child_product_id),
    childCode: String(r.child_code ?? ''),
    childName: String(r.child_name ?? ''),
    childColor: String(r.child_color ?? ''),
    qty: num(r.qty) || 1,
  }));
}

/** 这个产品是不是套装 —— 判据只看"有没有关联行"（不设 kind 列，避免两个真相） */
export function isBundleProduct(productId: unknown): boolean {
  const pid = toId(productId);
  if (!pid) return false;
  return !!dbGet(`SELECT id FROM pl_bundle_links WHERE product_id = ? LIMIT 1`, [pid]);
}

/**
 * 该套装用过的部件名（去重、排序）—— 供界面在"新色号还没配"时提示
 * 「这个套装通常是 上衣 + 裤子，请逐个指定颜色」。**不是权威**：只是提示，别拿它校验。
 */
export function bundleRolesOf(productId: unknown): string[] {
  const pid = toId(productId);
  if (!pid) return [];
  return dbQuery<{ role: string }>(
    `SELECT DISTINCT role FROM pl_bundle_links WHERE product_id = ? ORDER BY role`,
    [pid],
  ).map((r) => String(r.role ?? ''));
}

/**
 * 整组替换「某套装 × 某色号」的关联行（事务内先删后插）。
 *
 * 为什么按"色号"整组替换而不是逐行增删：一个色号对应的搭配是一个**整体**——
 * 改搭配时"先删裤子再加马甲"这种中间态对读取方毫无意义，还容易留下半套。
 *
 * 校验**全部前置**：先算完错误再进事务。半途抛错会把已存关联留在"删了一半"的状态，
 * 用户看到的是"保存失败但搭配没了"。
 *
 * 三条硬约束：
 *   · 子商品不能是自己（自引用）、也不能**本身是套装**（不嵌套）—— 两者都是环的入口。
 *     真实业务是"套装由几个单款组成"，一层足够；要嵌套时再开，并同时补环检测。
 *   · `role` 在同一 (套装, 商品, 色号) 内唯一 —— 「裤子」写两行不是两件裤子，
 *     是两件裤子该用 `qty=2`。
 *   · 子颜色必填：留空等于"到展平时再猜"，而猜错的表现是**拿货单少一条裤子**。
 */
export function replaceBundleLinks(input: {
  productId: unknown;
  itemId?: unknown;
  aliasKey?: unknown;
  parts: BundleLinkInput[];
}): { ok: boolean; error?: string; links: BundleLinkRow[] } {
  const pid = toId(input?.productId);
  if (!pid) return { ok: false, error: '产品 id 无效', links: [] };
  if (!dbGet(`SELECT id FROM pl_products WHERE id = ?`, [pid])) {
    return { ok: false, error: '产品不存在', links: [] };
  }
  const aliasKey = colorAliasKey(String(input?.aliasKey ?? ''));
  if (!aliasKey) return { ok: false, error: '平台色号不能为空', links: [] };
  const itemId = str(String(input?.itemId ?? ''), 64);

  const list = Array.isArray(input?.parts) ? input.parts : [];
  if (!list.length) return { ok: false, error: '至少要有一样子商品（清空请用删除）', links: [] };
  if (list.length > MAX_BUNDLE_PARTS) {
    return { ok: false, error: `子商品不能超过 ${MAX_BUNDLE_PARTS} 个`, links: [] };
  }

  const seen = new Set<string>();
  const clean: { role: string; childProductId: number; childColor: string; qty: number }[] = [];
  for (const raw of list) {
    const role = str(String(raw?.role ?? ''), MAX_BUNDLE_ROLE);
    if (!role) return { ok: false, error: '部件名称不能为空（上衣/裤子…）', links: [] };
    const roleKey = role.toLowerCase();
    if (seen.has(roleKey)) return { ok: false, error: `部件名称重复：${role}`, links: [] };
    seen.add(roleKey);

    const child = toId(raw?.childProductId);
    if (!child) return { ok: false, error: `部件「${role}」没有选子商品`, links: [] };
    if (child === pid) return { ok: false, error: '套装不能把自己当子商品', links: [] };
    if (!dbGet(`SELECT id FROM pl_products WHERE id = ?`, [child])) {
      return { ok: false, error: `部件「${role}」的子商品不存在`, links: [] };
    }
    // 禁嵌套：子商品本身若是套装，展开就成环（A 含 B、B 含 A 会无限递归）
    if (dbGet(`SELECT id FROM pl_bundle_links WHERE product_id = ? LIMIT 1`, [child])) {
      return { ok: false, error: `部件「${role}」本身是套装，不支持套装套套装`, links: [] };
    }

    const childColor = str(String(raw?.childColor ?? ''), MAX.name);
    if (!childColor) return { ok: false, error: `部件「${role}」还没定颜色`, links: [] };

    const qty = Math.trunc(Number(raw?.qty ?? 1));
    if (!Number.isFinite(qty) || qty < 1 || qty > MAX_BUNDLE_QTY) {
      return { ok: false, error: `部件「${role}」的件数须在 1~${MAX_BUNDLE_QTY}`, links: [] };
    }
    clean.push({ role, childProductId: child, childColor, qty });
  }

  dbTransaction(() => {
    dbRun(`DELETE FROM pl_bundle_links WHERE product_id = ? AND item_id = ? AND alias_key = ?`, [
      pid,
      itemId,
      aliasKey,
    ]);
    for (const c of clean) {
      dbRun(
        `INSERT INTO pl_bundle_links (product_id, item_id, alias_key, role, child_product_id, child_color, qty)
         VALUES (?, ?, ?, ?, ?, ?, ?)`,
        [pid, itemId, aliasKey, c.role, c.childProductId, c.childColor, c.qty],
      );
    }
  });
  return { ok: true, links: bundleLinksOf(pid) };
}

/** 删掉「某套装 × 某色号」这一组关联（含商品级/产品级，按传入作用域精确删） */
export function deleteBundleLinks(input: {
  productId: unknown;
  itemId?: unknown;
  aliasKey?: unknown;
}): { removed: number } {
  const pid = toId(input?.productId);
  if (!pid) return { removed: 0 };
  const aliasKey = colorAliasKey(String(input?.aliasKey ?? ''));
  if (!aliasKey) return { removed: 0 };
  const itemId = str(String(input?.itemId ?? ''), 64);
  const r = dbRun(
    `DELETE FROM pl_bundle_links WHERE product_id = ? AND item_id = ? AND alias_key = ?`,
    [pid, itemId, aliasKey],
  );
  return { removed: Number(r.changes) || 0 };
}

/** 解除整个套装关系（产品本身不删） */
export function clearBundle(productId: unknown): { removed: number } {
  const pid = toId(productId);
  if (!pid) return { removed: 0 };
  const r = dbRun(`DELETE FROM pl_bundle_links WHERE product_id = ?`, [pid]);
  return { removed: Number(r.changes) || 0 };
}

/**
 * 展开一个套装：`(套装产品, 商品ID, 平台色号) → [{部件名, 子商品, 颜色, 件数}]`。
 *
 * 查找顺序 **点名先于提示**：`(商品ID, 色号)` → `('', 色号)`。
 * 商品级是"这件事就这么定"，产品级是"同款套装一般都这样"；顺序反了会让用户
 * 配了商品级却不生效（改一次不生效，第二次就会以为是没保存）。
 *
 * **该色号没配过就报 `matched: false`，绝不回落别的色号**。这一条是"数据精准"的底线：
 * 拿别的色号顶上，统计会安静地给出**错误的拿货单** —— 少发一条裤子是发货后才发现的事。
 * 调用方拿到 `matched: false` 应进"待配"队列（可见、可修），不要混进已确认的需求。
 */
export function resolveBundleParts(input: {
  productId?: unknown;
  itemId?: unknown;
  color?: unknown;
}): ResolvedBundle {
  const pid = toId(input?.productId);
  if (!pid) return NO_BUNDLE;
  const rows = bundleLinksOf(pid);
  if (!rows.length) return NO_BUNDLE;

  const aliasKey = colorAliasKey(String(input?.color ?? ''));
  if (!aliasKey) return { ...NO_BUNDLE, isBundle: true }; // 色号都没采到 ⇒ 无从判断，按"未配"

  const itemId = str(String(input?.itemId ?? ''), 64);
  // 点名（item_id 非空且相等）→ 提示（产品级 item_id=''）
  const sameAlias = rows.filter((r) => r.aliasKey === aliasKey);
  const scopes: [string, 'item' | 'product'][] = [];
  if (itemId) scopes.push([itemId, 'item']);
  scopes.push(['', 'product']);
  for (const [want, scope] of scopes) {
    const hit = sameAlias.filter((r) => r.itemId === want);
    if (!hit.length) continue;
    return {
      isBundle: true,
      matched: true,
      matchedScope: scope,
      parts: hit.map((r) => ({
        role: r.role,
        childProductId: r.childProductId,
        childCode: r.childCode,
        childName: r.childName,
        color: r.childColor,
        qty: r.qty,
      })),
    };
  }
  return { isBundle: true, matched: false, matchedScope: 'none', parts: [] };
}
