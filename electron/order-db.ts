// electron/order-db.ts
// 「订单归类」模块的数据访问层（基于 electron/db.ts 公共层）。
// 表：
//   oi_images         图片指纹库：内容指纹(SHA-256) 唯一，缓存 AI 识别结果，避免重复扣费；
//                     style_color_id 归属款色（阶段1：识别后自动建立款式/款色并挂接）
//   oi_orders         订单明细：归属图片 + 原始字段 + 归一化属性（款式/颜色/logo/材质）
//   oi_styles         款编码库：code 唯一（STYLE-001）、fingerprint 款式指纹唯一（匹配键）
//   oi_style_colors   款色库：款编码 + 归一化颜色 → 款色编码（STYLE-001-RED），唯一
// 仅提供语义化方法；渲染进程经 order-handlers.ts 的 IPC 访问，不直接接触 SQL。
//
// ── 款式主数据权威：pl_products（ADR-002 D1 = 路径 A，2026-09-27 落地） ──
// 本模块只维护**识别私有信息**：oi_styles 的 `code` / `fingerprint`、款色归属、附加指纹。
// 款式的业务字段（`name` / `category` / `supplier_id` / `status` / `note`）唯一权威在
// `pl_products`（electron/product-db.ts）：
//   · 写：建款 / 改名 / 导入一律经 product-db（`upsertProduct` / `renameProduct`）；
//   · 读：列表与联表查询按 `pl_products.code = oi_styles.code` **派生**，不再读 oi_styles.name。
// `oi_styles.name` **已删列**（v3 迁移 `ALTER TABLE … DROP COLUMN name`，本文件的建表语句也不再有它）——
// 历史展示名在迁移里一次性交接给 `pl_products`，此后 `name` 在结构上不可能出现两份分叉的值，
// C1「同一语义只有一个写入方」不靠自觉、靠结构。
//
// ⚠️ **2026-10-05 更正**：此前这里写的是"列保留、写入固定空串哨兵"，与迁移（`DROP COLUMN`）**相反**。
// 三处 INSERT 仍在写 `name`，于是**老库上任何"新建款"的路径必抛** `no such column: name`
//（AI 识别建款、映射归款建款都中招；症状是"识别/归款静默失败、款表永远为空"）——
// 而夹具建的是**新库**（建表带 `name`），于是冒烟恒绿、线上必崩。统一到"无该列"后两者形状才一致。

export {};

import {
  initDb,
  dbMigrate,
  dbQuery,
  dbGet,
  dbRun,
  dbTransaction,
  getDb,
  migrate,
  tableExists,
  type MigrationStep,
} from './db';
import {
  adoptProduct,
  ensureProductSchema,
  orderColorByItemImage,
  productIdByCode,
  productSchemaReady,
  renameProduct,
  resolveOrderSku,
  resolveShopRef,
  setProductCostByCode,
  skuMappingSql,
  upsertSkuMappings,
} from './product-db';
import { extractOrderMoney } from './orderMoney';
// 采集侧口径的**纯原语**（收入 = 商品+买家运费；外币 × 汇率 → 分）。
// 回填走**同一组**函数而不是另写一遍算式 —— 两份口径必然漂移（AGENTS §4.2）。
import { orderIncomeCcy, parseOrderPropsColor, parseOrderQty, parseSkuProps, toCentsCny } from './aeMoney';
import { extractSkuFields } from './shopSku';
// 「平台色名 → 我的色名」的查表/归一（纯函数；口径见其文件头）
import { colorAliasKey, pickColorAlias, translateColor, type ColorAliasRow } from './colorAlias';
// 店名归一（纯函数；与店铺主表 UNIQUE / 名称映射同一口径）。订单只存店名原文，
// 下游要按**店铺身份**聚合时必须经它换算，别自己 trim（否则多一个空格就成了两家店）。
import { toNameKey } from './shopName';

// ---- 类型（与渲染层 src/types.ts 对应，结构保持一致） ----

/**
 * `oi_images` 的主键 —— **品牌类型**（值仍是 number，只是带了来源标记）。
 *
 * 为什么不是裸 `number`：产品域还有一张 `pl_images`，两表各自 AUTOINCREMENT、
 * id 在同一个库里必然撞上。把它们当成一个东西传，编译期看不出来，运行时是
 *「改了另一张表的另一行，还报成功」。品牌类型把这类错误挡在 `tsc` 这一层。
 * 造它的唯一正当途径是 `landOrderImageBytes` / `insertImage` 的返回值（见 `order-image-land`）。
 */
export type OrderImageId = number & { readonly __orderImageId: unique symbol };

export interface OrderImageRecord {
  id?: number;
  /** 内容指纹 SHA-256 */
  fingerprint: string;
  /** URL 规范化指纹（同图不同参数视为同图） */
  urlFingerprint: string;
  sourceUrl: string;
  localPath: string;
  status: 'pending' | 'done' | 'error';
  /** AI 识别结果 JSON */
  resultJson?: string;
  error?: string;
  createdAt?: string;
  updatedAt?: string;
  /** 归属款色 id（oi_style_colors，识别确认后挂接） */
  styleColorId?: number;
}

/** 订单发货状态：pending=未发货（导入后默认），shipped=已发货 */
export type OrderStatus = 'pending' | 'shipped';

export interface OrderRecord {
  id?: number;
  /** 归属图片；**null = 无图订单**（订单报表没有主图列，见 S2-b 免图导入） */
  imageId: number | null;
  orderNo: string;
  shop: string;
  size: string;
  /** 下单时间（可空，来自 Excel 下单时间列） */
  orderTime?: string;
  rawFields: Record<string, string>;
  /** 派生字段：商品ID（由 `extractSkuFields(rawFields)` 取出，供归类核对页标「同商品」）。
   *  ⚠️ 本接口与渲染层 `src/types.ts` 的 `OrderRecord` **逐字对应**，改一处必须改两处。 */
  itemId?: string;
  category: string;
  color: string;
  logo: string;
  /** 发货状态（导入后默认未发货） */
  status?: OrderStatus;
  /** 是否已纠正（保存纠正后置位；数据纠正列表只展示未纠正订单） */
  corrected?: boolean;
  createdAt?: string;
  /** 联表字段：图片指纹（列表展示用） */
  fingerprint?: string;
  /** 联表字段：图片本地路径（列表展示用） */
  localPath?: string;
  /** 联表字段：款编码（如 STYLE-001，经图片→款色→款 关联） */
  styleCode?: string;
  /** 联表字段：款式名 */
  styleName?: string;
  /** 联表字段：款色（归一化颜色） */
  styleColor?: string;
  /** 联表字段：图片识别结果中的款式特征（纠正重新归类时重建指纹用） */
  features?: string[];
}

export interface GroupStat {
  /** 组合键，如 "黑色|短袖T恤" */
  key: string;
  category: string;
  color: string;
  shop: string;
  count: number;
}

/**
 * 款选项 —— 给「归类核对」页的「归属款」下拉用（一个产品一行）。
 *
 * ⚠️ **数据源是 `pl_products`（产品库），不是 `oi_styles`（识别池）**。2026-10-10 用户口径：
 * 「归属款的选项应该来源于货与成本中的产品库，当前数据展示不全」—— 根因就是旧实现按
 * `oi_styles` 驱动，而只有**进过识别链路**的款才在识别池里：在「货与成本」手工新建、
 * 还没出过订单的产品一个都不会出现在下拉里（用户看着就是"展示不全"，且无从察觉为什么）。
 * 产品库才是主数据（D1 权威交接：`oi_styles.code` ≡ `pl_products.code` 同一编码池）。
 *
 * 下面的 `colors` 给「选完款再选颜色」用（2026-10-10 用户口径）：
 * **产品库 SKU 的颜色在前**（主数据），**识别链已学到的款色在后**（历史结论，别丢），去重。
 * 两者都空 ⇒ 这一个款没有可选颜色，界面必须回落成"自己填"，不能给一个空下拉。
 */
export interface StyleRecord {
  /** 产品编码（`pl_products.code`，与 `oi_styles.code` 同一锚点） */
  code: string;
  /** 展示名（唯一权威在 `pl_products.name`） */
  name: string;
  /** `active` / `archived`（停用款仍要能选：历史订单可能正指向它） */
  status: string;
  /** 可选颜色（产品库 SKU 颜色 + 识别链款色，去重，主数据在前） */
  colors: string[];
}

/** 订单字段纠正入参（数据纠正步骤） */
export interface UpdateOrderInput {
  id: number;
  category: string;
  color: string;
  logo: string;
  /** 重新归类用：新款指纹（渲染层 styleMatcher 生成，与 category/features 一致） */
  fingerprint?: string;
  /** 重新归类用：款式特征（随指纹一起落库） */
  features?: string[];
  /** true=按新款指纹重新匹配款式/款色并挂接图片 */
  reclassify: boolean;
}

/** 订单发货状态更新入参（订单明细行内切换） */
export interface UpdateOrderStatusInput {
  id: number;
  status: OrderStatus;
}

/** 款式匹配/落库入参（由渲染层按 styleMatcher.ts 生成款式指纹） */
export interface ResolveStyleInput {
  fingerprint: string;
  category: string;
  features: string[];
  color: string;
  /** 精炼款式名（模型 style_name），建款时优先作为展示名；空则回退 category+features */
  styleName?: string;
}

/**
 * `oi_orders` 的**固定列**（永远在头部、不参与"老库补列"的那几列）。
 *
 * 拆出这一份的唯一目的是让**解析后的完整列序**（`ORDER_TABLE_COLUMNS`，见下）**可以被机器读出来**，
 * 好在 `schema:smoke` 里对着真库 `PRAGMA table_info` 逐列自校验 —— 否则拼接结果只存在于运行时，
 * 新库建表这条路上"模板里少写一个 `${}`"没有任何断言能发现（老库补列走的是 `ALTER`，测不到模板）。
 */
/**
 * 订单**主表**列（2026-10-21，B1 拆表）：`order_no` 唯一、一单一行。
 *
 * 拆表动机（订单-采购模型简化 B1）：旧 `oi_orders` 一行 = 订单×商品图，同单多图时
 * 订单级字段（金额/税/状态/发货时点/店铺/下单时点）被复制 N 份。拆出主表后这些字段
 * 有天然"一单一行"的落点。
 *
 * ⚠️ 主表**没有**「总克重 / 总物流费」两列（A3 原计划有）：包裹模型（B2）定案
 * **总运费/总重 = Σ 包裹，由 `parcelTotals(order_no)` 实时派生、不落库** ——
 * 存一份就是同一数字两处实现，改包裹不改快照 ⇒ 两页对不上（AGENTS 铁律 5）。
 * 需要订单级总数时调 `parcelTotals`，别在这里加列。
 *
 * 归入主表的判据：**一单一份、不随商品行变化**的值。行级值（图/尺码/色/件数/款色/快照）
 * 一律进 `oi_order_items` 明细表。
 */
const ORDER_HEADER_COLS: { name: string; ddl: string }[] = [
  { name: 'id', ddl: 'id INTEGER PRIMARY KEY AUTOINCREMENT' },
  { name: 'order_no', ddl: 'order_no TEXT NOT NULL UNIQUE' },
  { name: 'shop', ddl: "shop TEXT NOT NULL DEFAULT ''" },
  { name: 'order_time', ddl: "order_time TEXT NOT NULL DEFAULT ''" },
  { name: 'source', ddl: "source TEXT NOT NULL DEFAULT 'import'" },
  // 利润用金额列（可空，NULL = 报表里没有；口径见 `electron/orderMoney.ts` 头）
  { name: 'amount_cents', ddl: 'amount_cents INTEGER' },
  { name: 'vat_cents', ddl: 'vat_cents INTEGER' },
  { name: 'ddp_cents', ddl: 'ddp_cents INTEGER' },
  { name: 'tax_platform', ddl: "tax_platform TEXT NOT NULL DEFAULT ''" },
  { name: 'biz_status', ddl: "biz_status TEXT NOT NULL DEFAULT ''" },
  // `ship_time` **不能删**：拣货的"未发货"判定读它（`picking-db`）
  { name: 'ship_time', ddl: "ship_time TEXT NOT NULL DEFAULT ''" },
];

/**
 * 订单**明细**列（2026-10-21，B1 拆表）：一 SKU 一行（`order_id` → 主表）。
 *
 * ⚠️ `id` 刻意**保留旧 `oi_orders.id` 的值**（迁移不重排）：`parcel_lines.order_item_id`、
 * `purchase_sources` 以及所有以"行 id"为键的下游调用零迁移。主表 `id` 才是新自增。
 */
const ORDER_ITEM_COLS: { name: string; ddl: string }[] = [
  { name: 'id', ddl: 'id INTEGER PRIMARY KEY' },
  { name: 'order_id', ddl: 'order_id INTEGER NOT NULL REFERENCES oi_orders(id) ON DELETE CASCADE' },
  { name: 'image_id', ddl: 'image_id INTEGER REFERENCES oi_images(id) ON DELETE CASCADE' },
  { name: 'size', ddl: "size TEXT NOT NULL DEFAULT ''" },
  { name: 'raw_fields', ddl: 'raw_fields TEXT NOT NULL' },
  { name: 'category', ddl: "category TEXT NOT NULL DEFAULT ''" },
  { name: 'color', ddl: "color TEXT NOT NULL DEFAULT ''" },
  { name: 'logo', ddl: "logo TEXT NOT NULL DEFAULT ''" },
  { name: 'material', ddl: "material TEXT NOT NULL DEFAULT ''" },
  { name: 'status', ddl: "status TEXT NOT NULL DEFAULT 'pending'" },
  { name: 'corrected', ddl: 'corrected INTEGER NOT NULL DEFAULT 0' },
  { name: 'qty', ddl: 'qty INTEGER' },
  { name: 'style_color_id', ddl: 'style_color_id INTEGER NOT NULL DEFAULT 0' },
  { name: 'weight_g', ddl: 'weight_g INTEGER' },
  // 成本两字段（C2，2026-10-21）：进价（预估）在前、实际进价（拿货实付）在后。
  // 取数 `actual > estimate > 缺`；**0 一律当缺失**（见 `src/lib/orderCost.ts`）。
  { name: 'cost_cents', ddl: 'cost_cents INTEGER' },
  { name: 'actual_cost_cents', ddl: 'actual_cost_cents INTEGER' },
];

/**
 * `oi_orders`（主表）的**解析后列序** —— 即下面建表语句展开后的真实列序（尾部 `created_at` 也在内）。
 * 由 `ORDER_HEADER_COLS` 推出 ⇒ 改列只改数组、这里自动跟着变。`schema:smoke` 拿它对着真库
 * `PRAGMA table_info(oi_orders)` 逐列比对，DDL 里少一个 `${}` 或手加一列没进数组都会红。
 */
export const ORDER_TABLE_COLUMNS: readonly string[] = ORDER_HEADER_COLS.map((c) => c.name).concat(
  'created_at',
);

/** `oi_order_items`（明细）的列序 —— 同上，供 `schema:smoke` 对真库自校验。 */
export const ORDER_ITEM_TABLE_COLUMNS: readonly string[] = ORDER_ITEM_COLS.map((c) => c.name).concat(
  'created_at',
);

/** `oi_orders`（主表）建表语句 —— 由 `ORDER_HEADER_COLS` 拼出，改列只改数组。 */
const ORDER_TABLE_DDL = `CREATE TABLE IF NOT EXISTS oi_orders (
${ORDER_HEADER_COLS.map((c) => `    ${c.ddl}`).join(',\n')},
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`;

/** `oi_order_items`（明细）建表语句 —— 由 `ORDER_ITEM_COLS` 拼出。 */
const ORDER_ITEM_TABLE_DDL = `CREATE TABLE IF NOT EXISTS oi_order_items (
${ORDER_ITEM_COLS.map((c) => `    ${c.ddl}`).join(',\n')},
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`;

/**
 * **历史快照**：v3 迁移重建 `oi_orders` 时用的「旧主干形状」（一行 = 订单×商品图）DDL。
 *
 * 为什么单独留一份、不复用上面的新 DDL：迁移链 v1→v8 是**线性演进**，v3 只负责把
 * 「旧采集表 + 旧订单表」归一成"唯一主干"（仍一行=订单×图），真正拆表是 v8 的事。
 * v3 里 `image_id`/`size`/`raw_fields`/`qty`/`style_color_id` 等行级列必须还在表里，
 * 否则 v8 拆表时就没得拆了。这份 DDL 是**冻结的历史形状**，之后不再改。
 */
const ORDER_LEGACY_SPINE_DDL = `CREATE TABLE IF NOT EXISTS oi_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER REFERENCES oi_images(id) ON DELETE CASCADE,
    order_no TEXT NOT NULL,
    shop TEXT NOT NULL DEFAULT '',
    size TEXT NOT NULL DEFAULT '',
    order_time TEXT NOT NULL DEFAULT '',
    raw_fields TEXT NOT NULL,
    category TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL DEFAULT '',
    logo TEXT NOT NULL DEFAULT '',
    material TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    corrected INTEGER NOT NULL DEFAULT 0,
    amount_cents INTEGER,
    vat_cents INTEGER,
    ddp_cents INTEGER,
    tax_platform TEXT NOT NULL DEFAULT '',
    biz_status TEXT NOT NULL DEFAULT '',
    ship_time TEXT NOT NULL DEFAULT '',
    source TEXT NOT NULL DEFAULT 'import',
    qty INTEGER,
    style_color_id INTEGER NOT NULL DEFAULT 0,
    weight_g INTEGER,
    cost_cents INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`;

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS oi_images (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT NOT NULL UNIQUE,
    url_fingerprint TEXT NOT NULL,
    source_url TEXT NOT NULL,
    local_path TEXT NOT NULL,
    status TEXT NOT NULL DEFAULT 'pending',
    result_json TEXT,
    error TEXT,
    style_color_id INTEGER,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_oi_images_sc ON oi_images(style_color_id)`,
  ORDER_TABLE_DDL,
  `CREATE INDEX IF NOT EXISTS idx_oi_orders_shop ON oi_orders(shop)`,
  ORDER_ITEM_TABLE_DDL,
  `CREATE INDEX IF NOT EXISTS idx_oi_order_items_order ON oi_order_items(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_oi_order_items_image ON oi_order_items(image_id)`,
  `CREATE INDEX IF NOT EXISTS idx_oi_order_items_sc ON oi_order_items(style_color_id)`,
  `CREATE INDEX IF NOT EXISTS idx_oi_images_url_fp ON oi_images(url_fingerprint)`,
  // ── 包裹（2026-10-21，订单-采购模型简化 B2）───────────────────────────────
  // 一单多包、按**单个商品行**拆、允许把一个合并行的数量拆到两个包里。
  // 为什么键是 `order_no` 而不是订单主键：`oi_orders` 现在一行 = 订单×商品图（B1 拆表前），
  // 一单天然多行、没有"订单主键"可指；`order_no` 是这单的唯一身份（AE 订单号全局唯一）。
  // B1 拆出订单主表后，这里的 `order_no` 正好就是主表的业务键，不需要改数据。
  //
  // 两条口径，与金额列同一条纪律：
  //   · `ship_cents` / `weight_g` **可空（NULL = 还不知道）**，不给 DEFAULT 0 ——
  //     0 是"这包没花钱/没重量"，混起来会把"缺运费"算成"零运费"，利润凭空变大；
  //   · 总物流费/总重 = Σ 包裹（`parcelTotals` 派生，不另存一份），
  //     任一个包缺值就整单返回 NULL —— 不是"已知部分之和"。
  `CREATE TABLE IF NOT EXISTS parcels (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_no TEXT NOT NULL,
    label TEXT NOT NULL DEFAULT '',
    tracking_no TEXT NOT NULL DEFAULT '',
    carrier TEXT NOT NULL DEFAULT '',
    ship_cents INTEGER,
    weight_g INTEGER,
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_parcels_order ON parcels(order_no)`,
  // 拆包明细：一个订单行可以出现在多个包里（拆数量），但**同一个包同一个行只一条**（UNIQUE），
  // 数量就写在这一条上 —— 有这一条约束，"同一行在同一包里记两次"在结构上不可能。
  // `order_item_id` 指向 `oi_order_items.id`（B1 拆表后订单行就是明细行）。
  `CREATE TABLE IF NOT EXISTS parcel_lines (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parcel_id INTEGER NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
    order_item_id INTEGER NOT NULL REFERENCES oi_order_items(id) ON DELETE CASCADE,
    qty INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(parcel_id, order_item_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_parcel_lines_parcel ON parcel_lines(parcel_id)`,
  `CREATE INDEX IF NOT EXISTS idx_parcel_lines_item ON parcel_lines(order_item_id)`,
  `CREATE TABLE IF NOT EXISTS oi_styles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE TABLE IF NOT EXISTS oi_style_colors (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    style_id INTEGER NOT NULL REFERENCES oi_styles(id) ON DELETE CASCADE,
    color TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    UNIQUE(style_id, color)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_oi_style_colors_style ON oi_style_colors(style_id)`,
  // 附加款式指纹：用户手动归并款式时，把订单指纹记入目标款式，使后续自动识别也命中该款编码
  // （oi_styles.fingerprint 为主指纹 UNIQUE，无法容纳同一款式的多个识别指纹，故单独成表）
  `CREATE TABLE IF NOT EXISTS oi_style_fingerprints (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    style_id INTEGER NOT NULL REFERENCES oi_styles(id) ON DELETE CASCADE,
    fingerprint TEXT NOT NULL UNIQUE
  )`,
  `CREATE INDEX IF NOT EXISTS idx_oi_style_fp_style ON oi_style_fingerprints(style_id)`,
  // 平台色名 → 我的色名（**产品级**对照，见 `electron/colorAlias.ts` 的口径说明）。
  // 采集侧的色是平台字符串（`Khaki` / `1..15`），款色要的是自家色名；没有可计算的对应关系，
  // 只能由人在归类核对时指认一次。新表（不是加列）⇒ `dbMigrate` 的 CREATE IF NOT EXISTS
  // 对老库同样生效，不需要版本化迁移步骤。
  `CREATE TABLE IF NOT EXISTS oi_color_aliases (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    alias_key TEXT NOT NULL,
    alias_raw TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(product_id, alias_key)
  )`,
];

/** 幂等初始化：迁移 + 建表/索引 + 款式主数据权威交接（应用启动 / 首次使用自动调用）
 *  顺序不能换：产品表要先存在，交接才有落点（见 migrateStyleAuthority）。 */
export function ensureOrderSchema(): void {
  initDb();
  // house convention：**自定义迁移先跑，再 dbMigrate(SCHEMA)** —— 老库缺列时才能补上，
  // 依赖新增列的索引也就可以安全地留在 SCHEMA 里（见 `migrateColumns` 的旧注释）。
  migrate('order.main', orderMigrationSteps());
  dbMigrate(SCHEMA);
  ensureProductSchema();
}

/** `oi_orders` / `oi_images` 的演进步骤（版本化：只跑未应用的，见 `electron/db.ts` 的 `migrate`）
 *
 * ⚠️ **v1–v7 全部操作"未拆表"的旧形状**（`oi_orders` 一行 = 订单×商品图，行级列就在主表上）。
 *    这些迁移写在拆表**之前**、且按版本号只跑一次，里面的 `oi_orders.image_id` /
 *    `oi_orders.raw_fields` / `oi_orders.qty` 之类是**当时那一版的真列**，不要"顺手"改成
 *    `oi_order_items.*` —— 改了就再也跑不出当年的中间状态，老库复现会失败。
 *    拆表本身是 **v8**（见 `migrateOrderSplit`），它之后主表只剩订单级列。
 */
function orderMigrationSteps(): MigrationStep[] {
  return [
    { version: 1, name: 'oi_orders +order_time/status/corrected；oi_images +style_color_id', up: migrateColumns },
    { version: 2, name: 'oi_orders +金额/状态/时点列（预测利润用）', up: addOrderMoneyColumns },
    {
      version: 3,
      name: 'oi_orders 归一为唯一订单主干（image_id 可空 + source/qty；删 8 个零读者列）· oi_styles 去哨兵列 name',
      up: migrateOrderSpine,
    },
    {
      version: 4,
      name: '历史采集单回填主干（ae_orders + ae_order_lines → oi_orders, source=collect）',
      up: migrateLegacyCollectedOrders,
    },
    {
      version: 5,
      name: 'oi_orders.color 从报表规格串补出平台色名（只补空值）',
      up: backfillOrderPropColors,
    },
    {
      version: 6,
      name: 'oi_orders += style_color_id（分析结论落订单行）· qty 从报表件数回填',
      up: addOrderClassification,
    },
    {
      version: 7,
      name: 'oi_orders += weight_g / cost_cents（行级快照，NULL = 未算）',
      up: addOrderSnapshots,
    },
    {
      version: 8,
      name: 'B1 拆表：oi_orders 拆成主表（一单一行）+ oi_order_items（一 SKU 一行）',
      up: migrateOrderSplit,
    },
    {
      version: 9,
      name: 'C2 成本两字段：+actual_cost_cents（旧值=实付）；cost_cents 回填为下单时预估',
      up: migrateOrderCostSplit,
    },
    {
      version: 10,
      name: 'C2 删表：退役 ae_cost_map（必须排在 v9 回填之后）',
      up: dropRetiredCostMap,
    },
    {
      version: 11,
      name: '删表：退役 oi_queue（待识别队列；云端识别链同步删除）',
      up: dropRetiredOrderQueue,
    },
  ];
}

/**
 * **v10：删掉退役的 `ae_cost_map`**（2026-10-21，C2 收尾）。
 *
 * 为什么挂在订单域、而不是 ae 域的 v4：v9 要**先**从这张表把预估回填进订单行。
 * 两个域的 schema 各自懒初始化，谁先跑不确定 —— 若删表在 ae 域，它可能先于 v9 执行，
 * 回填源就没了（历史利润永久少一块）。放在同一域、紧跟 v9，顺序由版本号钉死。
 *
 * `IF EXISTS`：新库从 C2 起不再建这张表（`ae-db.ts` 的 SCHEMA 已移除），这里是空操作。
 */
function dropRetiredCostMap(): void {
  dbRun(`DROP TABLE IF EXISTS ae_cost_map`);
}

/**
 * **v11：删掉退役的 `oi_queue`**（2026-10-28）。
 *
 * 队列存在的唯一用途是"导入行整批落库 → 逐行跑云端 VLM 识别 → 失败/缺图可重试"。
 * 那条识别链自 2026-10-05 起零调用方，2026-10-28 用户决定不接云端模型并把它整体删除
 * （见 `docs/notes/2026-10-28-classify-local-vision-direction.md`）⇒ 队列没有任何生产者，
 * 留着只会在 `reset`/备份/孤图清理里制造"一张永远空着的表"。
 *
 * 真库实测 0 行（`SELECT count(*) FROM oi_queue`），删表不丢业务数据；
 * `IF EXISTS` 让新库（SCHEMA 已不再建这张表）走空操作。
 *
 * ⚠️ 连带修掉一个真 bug：`listImageLocalPaths` 原来 UNION 了这张表的 `local_path` 列，
 * 而该列**从未存在** ⇒ 孤图清理在真库上一直是失败状态（详见该函数的注释）。
 */
function dropRetiredOrderQueue(): void {
  dbRun(`DROP TABLE IF EXISTS oi_queue`);
}

/**
 * **v7：给订单行补"算钱用的快照"两列**（2026-10-21）。
 *
 * 只加列、**不回填** —— 存量行的克重/进价按新口径"还没算过"（NULL）处理，由各自的写入口
 * （归类核对确认无误 / 拿货落账回写）逐步补齐。为什么不在这里扫全库回填：
 *   克重要 JOIN 款色 → 产品 → SKU 三跳，且"当时那个价"在旧模型里根本不是快照
 *   （`ae_cost_map` 只有区间），回填出来的数是**编的**——编出来的历史比"不知道"更危险。
 */
function addOrderSnapshots(): void {
  const cols = new Set(
    dbQuery<{ name: string }>(`PRAGMA table_info(oi_orders)`).map((r) => String(r.name ?? '')),
  );
  if (cols.size === 0) return; // 新库：建表即带这两列
  if (!cols.has('weight_g')) dbRun(`ALTER TABLE oi_orders ADD COLUMN weight_g INTEGER`);
  if (!cols.has('cost_cents')) dbRun(`ALTER TABLE oi_orders ADD COLUMN cost_cents INTEGER`);
}

/**
 * **v8：B1 拆表**（2026-10-21，订单-采购模型简化 B1）。
 *
 * 把「一行 = 订单×商品图」的旧 `oi_orders` 拆成：
 *   · `oi_orders`（主表，`order_no` UNIQUE、一单一行）—— 订单级字段；
 *   · `oi_order_items`（明细，一 SKU 一行）—— 行级字段。
 *
 * 为什么拆：同单多图时订单级字段（金额/税/状态/发货时点）被复制 N 份。
 *   （订单级「总克重/总物流费」不在此列 —— 见 `ORDER_HEADER_COLS` 头上的说明：
 *    B2 定案 Σ 包裹实时派生，不落库。）
 *
 * ⚠️ 迁移的**关键不变量**：`oi_order_items.id` **原样保留旧 `oi_orders.id` 的值**（不重排）。
 *   这样 `parcel_lines.order_item_id`、`purchase_sources` 以及所有以"行 id"为键的下游调用
 *   零迁移 —— 主表 `oi_orders.id` 才是新自增。
 *
 * 拆分口径：
 *   · 主表取**每个 `order_no` 的任意一行**的订单级字段（它们本该一致；万一不一致取 `MIN(id)` 最老那行，
 *     与旧「同单多行同值」的假设保持一致）；
 *   · 明细逐行搬运行级字段；
 *   · 同款合并（`style_color_id` + `size` 相同 → SUM qty）**不做在迁移里** —— 合并是汇总层语义
 *     （需求统计按 GROUP BY 聚合），物理层保留 SKU 级粒度，拆包/取图都要靠它。迁移只做拆不做好。
 *
 * 幂等：整段在 `migrate('order.main', …)` 内、版本记账兜底，只跑一次；重入由版本号挡住。
 * 可回滚：迁移前旧表 RENAME 为 `oi_orders_legacy_split`，成功后才 DROP。
 */
function migrateOrderSplit(): void {
  // 新库：`oi_orders` 已是主表形状（建表即 `order_no UNIQUE`）→ 无旧表可拆，无事可做。
  // 判据取「`raw_fields` 不在主表列里」—— 那是**行级**列，拆表时搬进了 `oi_order_items`。
  // （不能用 `total_weight_g` 之类的列当哨兵：主表本来就不该有订单级总数字段，见上。）
  const cols = dbQuery<{ name: string }>(`PRAGMA table_info(oi_orders)`).map((r) => String(r.name ?? ''));
  if (cols.length === 0) return; // 表还没建（迁移跑在建表之前）
  if (!cols.includes('raw_fields')) return; // 已是主表形状

  dbTransaction(() => {
    dbRun(`DROP TABLE IF EXISTS oi_orders_legacy_split`);
    dbRun(`ALTER TABLE oi_orders RENAME TO oi_orders_legacy_split`);
    dbRun(ORDER_TABLE_DDL);
    dbRun(ORDER_ITEM_TABLE_DDL);

    // 主表：按 order_no 归组、取 MIN(id) 那行的订单级字段。
    // 空单号的行**各自独立成一单**（order_no 用 `__empty__||id` 兜底唯一键）——
    // 空单号本就"不知道是不是同一单"，不并、也不丢，宁可多几条主表行也不误并不同订单。
    dbRun(
      `INSERT INTO oi_orders (id, order_no, shop, order_time, source,
                              amount_cents, vat_cents, ddp_cents, tax_platform, biz_status, ship_time,
                              created_at)
       SELECT MIN(id) AS id,
              CASE WHEN TRIM(COALESCE(order_no, '')) = '' THEN '__empty__' || id ELSE order_no END AS order_no,
              shop, order_time, source,
              amount_cents, vat_cents, ddp_cents,
              COALESCE(tax_platform, ''), COALESCE(biz_status, ''), COALESCE(ship_time, ''),
              MIN(created_at) AS created_at
       FROM oi_orders_legacy_split
       GROUP BY CASE WHEN TRIM(COALESCE(order_no, '')) = '' THEN '__empty__' || id ELSE order_no END`,
    );

    // 明细：逐行搬行级字段，`id` 原样保留、`order_id` 指回主表（按 order_no 关联）。
    // 空单号与主表同一条映射（`__empty__||id` 兜底），否则 JOIN 不上会整批丢行。
    dbRun(
      `INSERT INTO oi_order_items (id, order_id, image_id, size, raw_fields, category, color, logo,
                                   material, status, corrected, qty, style_color_id, weight_g, cost_cents,
                                   created_at)
       SELECT o.id,
              h.id AS order_id,
              o.image_id, o.size, o.raw_fields, o.category, o.color, o.logo,
              o.material, o.status, o.corrected, o.qty, o.style_color_id, o.weight_g, o.cost_cents,
              o.created_at
       FROM oi_orders_legacy_split o
       JOIN oi_orders h
         ON h.order_no = CASE WHEN TRIM(COALESCE(o.order_no, '')) = '' THEN '__empty__' || o.id ELSE o.order_no END`,
    );

    dbRun(`DROP TABLE oi_orders_legacy_split`);

    // 追平主表 AUTOINCREMENT（主表 id 是新自增，旧 id 已进明细，主表 seq 取 MAX(id)）
    const maxId = Number(dbGet<{ m: number }>(`SELECT COALESCE(MAX(id), 0) AS m FROM oi_orders`)?.m ?? 0);
    const seq = dbGet<{ seq: number }>(`SELECT seq FROM sqlite_sequence WHERE name = 'oi_orders'`);
    if (seq) dbRun(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'oi_orders'`, [maxId]);
    else if (maxId > 0) dbRun(`INSERT INTO sqlite_sequence (name, seq) VALUES ('oi_orders', ?)`, [maxId]);
  });
}

/** v9 里从旧价目表读出来的一条价格区间（只在本文件的迁移内使用） */
interface LegacyCostInterval {
  styleCode: string;
  effectiveFrom: string;
  /** `manual` / `purchase` —— 同日 manual 排在后面（`pickCostInterval` 的规则） */
  source: string;
  unitPriceCents: number;
}

/**
 * **v9：C2 成本两字段**（2026-10-21，订单-采购模型简化 C2）。
 *
 * 背景：`cost_cents`（v7 加、A5 写）实际一直只装「拿货实付」；「进价（预估）」每次现查
 * `ae_cost_map`。C2 要退役那张表 ⇒ 必须先把预估也落成字段，否则删表那一刻，只靠价目表
 * 估出来的行会从"有估算"突变"缺成本"（真实库盘点：36/51 行会掉）。
 *
 * 为什么这次**回填**预估、而 v7 明确说"不回填"：这两件事性质不同。v7 的克重/进价在旧模型里
 * 根本没有"当时的值"，回填等于编数；这里的预估**一直在被利润页实时算给用户看**（就是价目表
 * 按生效区间取的价），搬进字段只是把同一个数字留在原地，不是编造。
 *
 * 顺序不可颠倒（每一步的输入是上一步的输出）：
 *   ① 加列 `actual_cost_cents`；
 *   ② 存量 `cost_cents` 全是拿货实付 → 搬进 `actual_cost_cents`（0/负 = 缺失，留 NULL）；
 *   ③ 清空 `cost_cents`（这一列从此只放预估）；
 *   ④ 按**下单日期**从 `ae_cost_map` 取当时生效价回填 `cost_cents`（无款/无区间 → 留 NULL）；
 *   ⑤ 从拿货单回填一次实际进价 —— **不能等"下次拿货写操作"**：真实库那 1 行实付 32 的订单
 *      下单时价目表是 28，不在这里补，它会从 32 暂时掉回 28；
 *   ⑥ 把旧价目表每个款**最新**的价镜像进 `pl_products.cost_cents`（当前价）——
 *      产品表当时全是 0，不搬 = 删表把价扔掉。
 *
 * 这段是**冻结的历史代码**：v10 已把 `ae_cost_map` 删掉，`pickCostInterval` 也已不复存在，
 * 但这里**不要**跟着改成"表已不存在"的写法 —— 它服务的是"升级那一刻表还在"的老库。
 * 表不存在时下面的 `tableExists` 会让它整体空转（新库 / 已升级过的库）。
 */
function migrateOrderCostSplit(): void {
  const itemCols = tableExists('oi_order_items')
    ? new Set(
        dbQuery<{ name: string }>(`PRAGMA table_info(oi_order_items)`).map((r) =>
          String(r.name ?? ''),
        ),
      )
    : null;
  const hasItems = !!itemCols?.size;

  if (itemCols && hasItems) {
    if (!itemCols.has('actual_cost_cents')) {
      dbRun(`ALTER TABLE oi_order_items ADD COLUMN actual_cost_cents INTEGER`);
    }
    // ② 只搬**正数**：0 是"没价"，搬过去会让利润按"免费"算。
    dbRun(
      `UPDATE oi_order_items SET actual_cost_cents = cost_cents
        WHERE actual_cost_cents IS NULL AND cost_cents > 0`,
    );
    // ③ 清空即预估列（旧的实付已经搬走）；④ 会按区间重新填。
    dbRun(`UPDATE oi_order_items SET cost_cents = NULL WHERE cost_cents IS NOT NULL`);
  }

  const intervals = readLegacyCostIntervals();
  if (hasItems && intervals.length) backfillOrderEstimateCosts(intervals);
  if (hasItems) backfillOrderActualCosts();
  mirrorLegacyCostToProducts(intervals);
}

/** 读旧价目表（`ae_cost_map`）的全部有效区间。表不存在 = 这个用户没用过成本表 → 返回空。 */
function readLegacyCostIntervals(): LegacyCostInterval[] {
  if (!tableExists('ae_cost_map')) return [];
  // 极老的库可能还没跑过 ae.main v1（表是旧主键形状、没有 effective_from）——
  // 那时所有行都对应迁移里的基准日，与 v1 的口径一致（不能报 no such column 把升级卡死）。
  const cols = new Set(
    dbQuery<{ name: string }>(`PRAGMA table_info(ae_cost_map)`).map((r) => String(r.name ?? '')),
  );
  const hasFrom = cols.has('effective_from');
  const fromExpr = hasFrom ? 'effective_from' : `'0000-01-01'`;
  const fromFilter = hasFrom ? `effective_from <> '' AND ` : '';
  const orderBy = hasFrom
    ? `effective_from ASC, CASE WHEN source = 'manual' THEN 1 ELSE 0 END ASC`
    : `CASE WHEN source = 'manual' THEN 1 ELSE 0 END ASC`;
  return dbQuery<Record<string, unknown>>(
    // 排序 = 当年 `pickCostInterval` 的规则：生效日升序、同日 manual 最后。
    `SELECT style_code, ${fromExpr} AS effective_from, source, unit_price_cents
       FROM ae_cost_map
      WHERE ${fromFilter}unit_price_cents > 0
      ORDER BY style_code ASC, ${orderBy}`,
  ).map((r) => ({
    styleCode: String(r.style_code ?? ''),
    effectiveFrom: String(r.effective_from ?? ''),
    source: String(r.source ?? ''),
    unitPriceCents: Number(r.unit_price_cents) || 0,
  }));
}

/**
 * ④ 按**下单日期**把旧价目表的当时生效价回填为「进价（预估）」。
 *
 * 挑法与 `src/lib/orderCost.ts#pickCostInterval` 逐字一致：取 ≤ 下单日的最后一条；
 * 一条都没有（或下单日期认不出）→ 取最早那条。款编码经**订单行的身份列**
 *（`style_color_id`，与克重快照同一条 JOIN）取；未归类的行没有款级价可估 → 留 NULL。
 */
function backfillOrderEstimateCosts(intervals: LegacyCostInterval[]): void {
  const byStyle = new Map<string, LegacyCostInterval[]>();
  for (const it of intervals) {
    const list = byStyle.get(it.styleCode);
    if (list) list.push(it);
    else byStyle.set(it.styleCode, [it]);
  }
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT oi.id AS id, o.order_time AS order_time, s.code AS style_code
       FROM oi_order_items oi
       JOIN oi_orders o ON o.id = oi.order_id
       LEFT JOIN oi_style_colors sc ON sc.id = oi.style_color_id
       LEFT JOIN oi_styles s ON s.id = sc.style_id`,
  );
  for (const r of rows) {
    const list = byStyle.get(String(r.style_code ?? ''));
    if (!list?.length) continue;
    const date = legacyDateKey(r.order_time);
    let hit: LegacyCostInterval | undefined;
    if (date) {
      for (const c of list) {
        if (c.effectiveFrom <= date) hit = c;
        else break;
      }
    }
    const pick = hit ?? list[0];
    dbRun(`UPDATE oi_order_items SET cost_cents = ? WHERE id = ? AND cost_cents IS NULL`, [
      pick.unitPriceCents,
      Number(r.id) || 0,
    ]);
  }
}

/**
 * ⑤ 从拿货单回填**一次**实际进价。
 *
 * 这段是 `purchase-cost-sync.ts#syncOrderRowCosts` 在 v9 时点的**冻结副本**（同样的过滤/排序）：
 * 迁移不能反向依赖编排层。之后新发生的拿货仍由那个函数回写，两边不需要保持同步 ——
 * 它只负责把"升级当天已经拿过货"的行补上。
 */
function backfillOrderActualCosts(): void {
  if (!tableExists('purchase_items') || !tableExists('purchase_orders')) return;
  const items = dbQuery<Record<string, unknown>>(
    `SELECT pi.style_color_id AS sc_id, pi.size AS size, pi.price_cents AS price_cents
       FROM purchase_items pi
       JOIN purchase_orders po ON po.id = pi.purchase_id
      WHERE po.status = 'submitted'
        AND pi.qty > 0
        AND pi.price_cents > 0
        AND pi.style_color_id > 0
      ORDER BY po.biz_date ASC, pi.id ASC`,
  );
  const firstPrice = new Map<string, number>();
  for (const r of items) {
    const scId = Number(r.sc_id) || 0;
    const price = Number(r.price_cents) || 0;
    if (!scId || price <= 0) continue;
    const key = `${scId}\u0000${String(r.size ?? '')}`;
    if (!firstPrice.has(key)) firstPrice.set(key, price);
  }
  for (const [key, price] of firstPrice) {
    const [scIdText, size] = key.split('\u0000');
    dbRun(
      `UPDATE oi_order_items SET actual_cost_cents = ?
        WHERE actual_cost_cents IS NULL AND style_color_id = ? AND size = ?`,
      [price, Number(scIdText) || 0, size],
    );
  }
}

/**
 * ⑥ 旧价目表 → 产品「当前进价」（每个款取最新一条）。
 *
 * 只补空（`cost_cents <= 0`）：产品页已经维护过的价是用户更新的决定，旧价目表没资格覆盖它。
 * 主动 `ensureProductSchema()`：本步骤跑在 `ensureOrderSchema` 建产品表**之前**，
 * 不先建就会"读到价、却没有落点"，而迁移只跑一次 ⇒ 价格永久丢失（同 v3 款名交接的教训）。
 */
function mirrorLegacyCostToProducts(intervals: LegacyCostInterval[]): void {
  if (!intervals.length) return;
  ensureProductSchema();
  const latest = new Map<string, number>();
  for (const it of intervals) latest.set(it.styleCode, it.unitPriceCents);
  for (const [code, cents] of latest) {
    const row = dbGet<{ cost_cents: number }>(`SELECT cost_cents FROM pl_products WHERE code = ?`, [
      code,
    ]);
    if (!row || Number(row.cost_cents) > 0) continue;
    setProductCostByCode(code, cents);
  }
}

/**
 * 迁移内的日期归一 —— 与 `src/lib/orderCost.ts#dateKey` 同一口径的**冻结副本**。
 * 主进程不能 import 渲染层纯函数；这段只服务 v9 这一次回填，不随引擎改。
 */
function legacyDateKey(raw: unknown): string {
  const s = typeof raw === 'string' ? raw.trim() : '';
  if (!s) return '';
  const m = /^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/.exec(s);
  if (m) return `${m[1]}-${m[2].padStart(2, '0')}-${m[3].padStart(2, '0')}`;
  const t = Date.parse(s);
  if (Number.isNaN(t)) return '';
  const d = new Date(t);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(
    d.getDate(),
  ).padStart(2, '0')}`;
}

/**
 * **v6：把"分析结论"落到订单行**（2026-10-20，简化审查 §3.1）。
 *
 * 之前款色只挂在**图片**上（`oi_images.style_color_id`），任何消费者要用都得 JOIN 四张表、
 * 自己拼一套文本键 —— 结果是 3 套需求口径、10 处手拼 `款|色|码`，色名一改全部失联。
 * 这里给订单行一个**身份列**，此后需求/已拿/取图只认 id。
 *
 * 为什么**只加 `style_color_id`**、不加 `style_code` / `color_name` 两列快照：
 * 那两个值是款色行的**派生物**，存下来就是第二份会漂移的副本（改名不同步 ⇒ 又是"静默失联"）。
 * 展示用的款编码/色名走一次 `LEFT JOIN oi_style_colors → oi_styles` 即可，只有一条读路径。
 *
 * 回填放在"列刚被加上"的分支内 ⇒ **只做一次**（老行从图片继承，图片是当时的结论）。
 * 之后由 `setImageStyleColor` / `assignOrderStyle` 在**同一次写入**里投影过来，不需要再扫全库。
 */
function addOrderClassification(): void {
  const cols = dbQuery<{ name: string }>(`PRAGMA table_info(oi_orders)`).map((r) => String(r.name ?? ''));
  if (cols.length === 0) return; // 新库：建表即带该列（见 ORDER_TABLE_DDL）
  const added = !cols.includes('style_color_id');
  if (added) {
    dbRun(`ALTER TABLE oi_orders ADD COLUMN style_color_id INTEGER NOT NULL DEFAULT 0`);
    // 老行：图片上已有结论（识别 / 映射归款 / 人工纠正）→ 继承过来；图片没有结论 = 0（未归类）
    dbRun(
      `UPDATE oi_orders
          SET style_color_id = COALESCE((SELECT i.style_color_id FROM oi_images i WHERE i.id = oi_orders.image_id), 0)
        WHERE COALESCE(style_color_id, 0) = 0 AND image_id IS NOT NULL`,
    );
  }
  dbRun(`CREATE INDEX IF NOT EXISTS idx_oi_orders_sc ON oi_orders(style_color_id)`);

  // 件数：`qty` 列一直存在但没人写（真库 51 行全 NULL）⇒ 缺口按行数算、一单多件就漏货。
  // 只补空值，已有值不动（人工/采集写过的算数）；解析不出仍留 NULL（渲染层按 1 件并标缺）。
  const need = dbQuery<{ id: number; raw_fields: string }>(
    `SELECT id, raw_fields FROM oi_orders WHERE COALESCE(qty, 0) <= 0 AND COALESCE(raw_fields, '') <> ''`,
  );
  if (!need.length) return;
  const upd = getDb().prepare(`UPDATE oi_orders SET qty = ? WHERE id = ?`);
  let filled = 0;
  for (const r of need) {
    let obj: Record<string, unknown> = {};
    try {
      const v = JSON.parse(String(r.raw_fields ?? ''));
      if (v && typeof v === 'object') obj = v as Record<string, unknown>;
    } catch {
      continue; // 脏 JSON：留空，不让一条坏行毁掉整批回填
    }
    const q = parseOrderQty(obj);
    if (!q) continue;
    upd.run(q, r.id);
    filled += 1;
  }
  if (filled) {
    console.log(`[migrate] order.main v6：${filled} 行件数已从报表「商品数量」补出（其余解析不出，按 1 件并标缺）`);
  }
}

/**
 * v5 迁移：把**存量订单**的平台色名从报表规格串里补出来（`(产品属性:Color:5,...)`）。
 *
 * 为什么必须回填而不是只对以后生效：颜色在此之前唯一来源是"订单图 → 采集色图"，
 * 采集没覆盖到的商品（本机库 44/51 单）全部落在占位色「未分类」上 ——
 * **不同颜色的订单在拣货单上长得一模一样**（发错色的直接来源）。
 * 只修新单的话，老单要么永远停在未分类、要么只能重导一遍 Excel。
 *
 * 三条边界：
 *   · **只补空值**（`TRIM(COALESCE(color,'')) = ''`）：已有值要么是采集帧逐行解析的、
 *     要么是人工核对写下的结论 —— 迁移不许覆盖人的结论；
 *   · 解析不出（无规格串 / 一单多色 ⇒ 歧义）就**保持空**，不猜（见 `parseOrderPropsColor`）；
 *   · 只动这一列，不碰 `raw_fields` / `updated_at`（保真原文；这也让回滚只是一条 UPDATE）。
 *
 * ⚠️ 它**不负责**把图片从「未分类」改到新色 —— 那件事的重放（`replaySkuMappings`）在界面进页时跑，
 *    迁移里调重放会依赖产品域建的款色表（本步骤跑在 `ensureProductSchema()` 之前，见 `ensureOrderSchema`）。
 */
function backfillOrderPropColors(): void {
  if (!tableExists('oi_orders')) return;
  const rows = dbQuery<{ id: number; raw_fields: string }>(
    `SELECT id, raw_fields FROM oi_orders WHERE TRIM(COALESCE(color, '')) = ''`,
  );
  if (!rows.length) return;
  const upd = getDb().prepare(`UPDATE oi_orders SET color = ? WHERE id = ?`);
  let filled = 0;
  for (const r of rows) {
    const color = parseOrderPropsColor(safeJson(String(r.raw_fields ?? '')));
    if (!color) continue;
    upd.run(color, r.id);
    filled += 1;
  }
  if (filled) {
    console.log(
      `[migrate] order.main v5：${filled} 单的平台色名已从报表规格串补出（仍有 ${rows.length - filled} 单定不出，保持未分类）`,
    );
  }
}

/**
 * v4 迁移：把**老采集表**里的历史订单回填进主干（2026-09-30，C9' 的前置）。
 *
 * 背景：C1 之后**新采集的**订单直接写主干，而 C1 之前采到的单只存在于 `ae_orders` / `ae_order_lines` ——
 * 界面只读主干，于是那些单**看不见了**（本机实测 101 单）。删表（C9'）之前先把它们搬进来，
 * 否则删表就是真丢数据。
 *
 * 口径与实时采集**完全同一组原语**（`electron/aeMoney.ts` + `upsertCollectedOrder`）：
 * 整单收入 =（商品金额 + 买家付运费）× 汇率 → 分；`sku_props` 解析出颜色/尺码；行级明细按行落主干。
 * **不迁** `ae_fees`：费用侧的真值源是「结算明细」（`ae_settle_lines`），采集侧的科目实测为空，
 * 主干的模型里也没有费用科目列（见 `upsertOrderBatch` 的注释）。
 *
 * 幂等：`upsertCollectedOrder` 按 (order_no, source='collect') 先删后插 —— 迁移重入不会翻倍；
 * 版本记账再兜一层（同一域同一版本只跑一次）。
 * 可回滚：回填行的 `raw_fields.__migratedFrom = 'ae_orders'`，要撤就按这个标记删。
 *
 * ⚠️ 与所有迁移步骤同一条纪律：**迁移跑在表可能存在之前**，故先判表在不在（交接类步骤要自己保证目标表存在，
 * 见 `docs/notes/2026-09-30-table-rebuild-traps.md`）。
 */
function migrateLegacyCollectedOrders(): void {
  if (!tableExists('oi_orders') || !tableExists('ae_orders')) return; // 新库没有采集表 → 无事可做
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT id, order_id, shop_name, order_time, status, currency, goods_amount, shipping_income, raw_json
     FROM ae_orders`,
  );
  if (!rows.length) return;

  const linesByOrder = new Map<number, { productId: string; skuProps: string; qty: number }[]>();
  if (tableExists('ae_order_lines')) {
    for (const l of dbQuery<Record<string, unknown>>(
      `SELECT ae_order_id, product_id, sku_props, qty FROM ae_order_lines`,
    )) {
      const key = Number(l.ae_order_id) || 0;
      const list = linesByOrder.get(key) ?? [];
      list.push({
        productId: String(l.product_id ?? ''),
        skuProps: String(l.sku_props ?? ''),
        qty: Number(l.qty) || 1,
      });
      linesByOrder.set(key, list);
    }
  }

  // 汇率表可能还没建（老库首次进入本域）→ 缺席时按"缺汇率"处理（金额留 null，不猜 1:1）
  const rates = new Map<string, number>();
  if (tableExists('ae_rates')) {
    for (const r of dbQuery<Record<string, unknown>>(
      `SELECT from_currency, rate_to_cny FROM ae_rates`,
    )) {
      const ccy = String(r.from_currency ?? '');
      const v = Number(r.rate_to_cny);
      if (ccy && v > 0) rates.set(ccy, v);
    }
  }

  let migrated = 0;
  for (const r of rows) {
    const orderNo = String(r.order_id ?? '').trim();
    if (!orderNo) continue;
    const currency = String(r.currency ?? '') || 'USD';
    const rate = currency === 'CNY' ? 1 : (rates.get(currency) ?? 0);
    const amountCents = rate
      ? toCentsCny(
          orderIncomeCcy({
            goodsAmount: Number(r.goods_amount) || 0,
            shippingIncome: Number(r.shipping_income) || 0,
          }),
          rate,
        )
      : null;
    const srcLines = linesByOrder.get(Number(r.id) || 0) ?? [];
    // ⚠️ v4 跑在 v8 拆表**之前**，`oi_orders` 此时还是「一行 = 订单×图」的旧形状，
    //    必须**内联旧形状 INSERT**，不能复用已改成「主表+明细」两表写入的 `upsertCollectedOrder`
    //    （那时 `oi_order_items` 明细表还没建）。字段与旧 `upsertCollectedOrder` 逐一对齐。
    const d = getDb();
    const rawJson = JSON.stringify({
      采集帧: String(r.raw_json ?? '').slice(0, 20000),
      __migratedFrom: 'ae_orders',
    });
    const lines = srcLines.length
      ? srcLines
      : [{ productId: '', skuProps: '', qty: 1 }];
    for (const l of lines) {
      const props = parseSkuProps(l.skuProps);
      d.prepare(
        `INSERT INTO oi_orders (image_id, order_no, shop, size, order_time, raw_fields, category, color, logo,
                                status, amount_cents, biz_status, source, qty)
         VALUES (NULL, ?, ?, ?, ?, ?, '', ?, '', 'pending', ?, ?, 'collect', ?)`,
      ).run(
        orderNo,
        String(r.shop_name ?? ''),
        props.size.slice(0, 64),
        String(r.order_time ?? ''),
        rawJson,
        props.color.slice(0, 64),
        amountCents,
        String(r.status ?? ''),
        Math.max(1, Math.round(Number(l.qty) || 1)),
      );
    }
    migrated += 1;
  }
  if (migrated) {
    console.log(
      `[migrate] order.main v4：历史采集单 ${migrated} 单已回填主干（oi_orders, source=collect）`,
    );
  }
}

/** 老库列迁移：补充历史建表语句缺失的列（order_time / style_color_id / status / corrected）。
 *  注意：依赖新增列的索引必须在本函数内、加列成功后再创建，
 *  不能放进 SCHEMA——老库缺列时建索引会抛错导致整个 dbMigrate 事务回滚。 */
function migrateColumns(): void {
  const d = getDb();
  const orderCols = d.prepare(`PRAGMA table_info(oi_orders)`).all() as { name: string }[];
  // 表还不存在 = 新库（迁移先于 dbMigrate 跑）→ 跳过，别去 ALTER 一张没有的表
  if (orderCols.length === 0) return;
  if (!orderCols.some((c) => c.name === 'order_time')) {
    dbRun(`ALTER TABLE oi_orders ADD COLUMN order_time TEXT NOT NULL DEFAULT ''`);
  }
  if (!orderCols.some((c) => c.name === 'status')) {
    dbRun(`ALTER TABLE oi_orders ADD COLUMN status TEXT NOT NULL DEFAULT 'pending'`);
  }
  if (!orderCols.some((c) => c.name === 'corrected')) {
    dbRun(`ALTER TABLE oi_orders ADD COLUMN corrected INTEGER NOT NULL DEFAULT 0`);
  }
  const imgCols = d.prepare(`PRAGMA table_info(oi_images)`).all() as { name: string }[];
  if (!imgCols.some((c) => c.name === 'style_color_id')) {
    dbRun(`ALTER TABLE oi_images ADD COLUMN style_color_id INTEGER`);
  }
  dbRun(`CREATE INDEX IF NOT EXISTS idx_oi_images_sc ON oi_images(style_color_id)`);
}

/** 老库补「利润用列」（金额/状态/时点）；列名与主表 `ORDER_HEADER_COLS` 里的金额列一致（不会漂移）。
 *  ⚠️ 本步骤（v2）跑在 v8 拆表**之前**，补的是旧 `oi_orders`（一行=订单×图）的列；拆表时这些
 *     金额列会作为订单级字段搬进主表。 */
function addOrderMoneyColumns(): void {
  const cols = dbQuery<{ name: string }>(`PRAGMA table_info(oi_orders)`).map((r) =>
    String(r.name ?? ''),
  );
  if (cols.length === 0) return; // 新库：由 dbMigrate 建表时带上这些列
  const have = new Set(cols);
  // 金额/状态/时点列（与主表 ORDER_HEADER_COLS 同列名；`source`/`qty` 由 v3 处理）
  const moneyCols: { name: string; ddl: string }[] = [
    { name: 'amount_cents', ddl: 'amount_cents INTEGER' },
    { name: 'vat_cents', ddl: 'vat_cents INTEGER' },
    { name: 'ddp_cents', ddl: 'ddp_cents INTEGER' },
    { name: 'tax_platform', ddl: "tax_platform TEXT NOT NULL DEFAULT ''" },
    { name: 'biz_status', ddl: "biz_status TEXT NOT NULL DEFAULT ''" },
    { name: 'ship_time', ddl: "ship_time TEXT NOT NULL DEFAULT ''" },
  ];
  for (const c of moneyCols) {
    if (!have.has(c.name)) dbRun(`ALTER TABLE oi_orders ADD COLUMN ${c.ddl}`);
  }
}

/**
 * **v3：`oi_orders` 归一为唯一订单主干**（2026-09-30，C1 合并的表侧）。
 *
 * 三件事**同一个事务**：
 *   ① 款式名交接（原 `migrateStyleAuthority` 的两条语句）—— 必须**在删列之前**跑，
 *      否则 `oi_styles.name` 一删，历史展示名就没了源头；
 *   ② 重建 `oi_orders`：`image_id` 改**可空**（订单报表里没有主图列，S2-b 免图导入的前提）、
 *      加 `source`/`qty`、删 8 个零读者列（`goods/ship_fee/shop_discount/platform_subsidy/
 *      currency/biz_mode/paid_time/received_time`，投影早已不取）；
 *   ③ `oi_styles` 去掉 `name`（SQLite ≥3.35 直接 `DROP COLUMN`；该列无索引引用，不必重建表）。
 *
 * 幂等判定：`oi_orders` 已有 `source` 列即视为已迁移（新库由 `ORDER_TABLE_DDL` 一次建到位）。
 * ⚠️ 重建会**重置 `sqlite_sequence`**（AUTOINCREMENT 的行号记账）：显式插入历史 id 之后必须把它
 * 追平，否则下一笔插入会从 1 开始撞主键。
 */
function migrateOrderSpine(): void {
  const cols = dbQuery<{ name: string }>(`PRAGMA table_info(oi_orders)`).map((r) => String(r.name ?? ''));
  if (cols.length === 0) return; // 新库：建表即新形状
  if (cols.includes('source')) return; // 已是主干形状
  dbTransaction(() => {
    // ⚠️ 交接必须有落点：本迁移跑在 `ensureOrderSchema` 的 `ensureProductSchema()` **之前**，
    // 老库（订单域早于产品域）此时可能还没有 `pl_products` —— 那样交接会被跳过、而列却照删：
    // **历史款名静默丢失**。所以这里主动把产品表建起来（幂等），保证交接永远有落点。
    ensureProductSchema();
    // ⚠️ 交接与删列都要先**探列**：老库此时通常还有 `name`（更要紧的是别白删），
    // 但若某个库的 `oi_styles` 已是新形状（无 name），不判就 `no such column: name` 直接崩。
    const styleCols = dbQuery<{ name: string }>(`PRAGMA table_info(oi_styles)`).map((r) =>
      String(r.name ?? ''),
    );
    if (styleCols.includes('name')) {
      dbRun(
        `INSERT OR IGNORE INTO pl_products (code, name)
         SELECT s.code, s.name FROM oi_styles s WHERE s.code <> ''`,
      );
    }
    dbRun(`DROP TABLE IF EXISTS oi_orders_legacy_spine`);
    // 防御：v3 跑在 v8 拆表**之前**，正常老库此时还没有 `oi_order_items`；但若库被
    // 「版本回退 + 重建老形状」破坏性地残留了明细表，它外键引用 `oi_orders`，会在 RENAME
    // 时被 SQLite 自动改指 legacy 表、DROP 后变成悬空引用 → 后续 INSERT 报 no such table。
    dbRun(`DROP TABLE IF EXISTS oi_order_items`);
    dbRun(`ALTER TABLE oi_orders RENAME TO oi_orders_legacy_spine`);
    dbRun(ORDER_LEGACY_SPINE_DDL);
    // 老行**一律是报表导入来的**（当时没有第二条通道）→ source='import'；qty 留 NULL（由渲染层解析块内数量）
    dbRun(
      `INSERT INTO oi_orders (id, image_id, order_no, shop, size, order_time, raw_fields, category,
                              color, logo, material, status, corrected,
                              amount_cents, vat_cents, ddp_cents, tax_platform, biz_status, ship_time,
                              created_at, source, qty)
       SELECT id, image_id, order_no, shop, size, order_time, raw_fields, category,
              color, logo, material, status, corrected,
              amount_cents, vat_cents, ddp_cents,
              COALESCE(tax_platform, ''), COALESCE(biz_status, ''), COALESCE(ship_time, ''),
              created_at, 'import', NULL
       FROM oi_orders_legacy_spine`,
    );
    dbRun(`DROP TABLE oi_orders_legacy_spine`);
    // 追平 AUTOINCREMENT 行号（sqlite_sequence 无主键 → UPDATE，没有行时再 INSERT）
    const seq = dbGet<{ seq: number }>(`SELECT seq FROM sqlite_sequence WHERE name = 'oi_orders'`);
    const maxId = Number(dbGet<{ m: number }>(`SELECT COALESCE(MAX(id), 0) AS m FROM oi_orders`)?.m ?? 0);
    if (seq) dbRun(`UPDATE sqlite_sequence SET seq = ? WHERE name = 'oi_orders'`, [maxId]);
    else if (maxId > 0) dbRun(`INSERT INTO sqlite_sequence (name, seq) VALUES ('oi_orders', ?)`, [maxId]);
    // oi_styles 去哨兵列（无索引引用它；SQLite ≥3.35 可直接 DROP COLUMN）
    if (styleCols.includes('name')) dbRun(`ALTER TABLE oi_styles DROP COLUMN name`);
  });
}

/**
 * 款式主数据权威交接（D1 落地，幂等）：
 *   1. 把历史库里 `oi_styles.name` 的展示名**灌进** `pl_products`（缺哪个补哪个，已有产品不动 ——
 *      主数据优先于历史遗留值）。name 为空的历史款也补行，保证「oi_styles.code 必有对应产品」
 *      这个关联不变量成立，否则读侧 LEFT JOIN 出来的空名会既看不出原因也修不了。
 *   2. 交接完成后把 `oi_styles.name` 全部置空（哨兵）：留着旧值就是留着一份将来会分叉的副本，
 *      哪天有人顺手读了它，C1 就又破了一次。置空让它**在结构上不可能**成为第二数据源。
 *   两步同一事务：插入失败就不清源数据，不会丢名字。
 *
 * 幂等判定用 `INSERT OR IGNORE` + `WHERE name <> ''`：第二次起两边都是空操作，
 * 可安全地挂在每次 `ensureOrderSchema()` 上。
 */
/** 原 `migrateStyleAuthority` 已**并入 v3 迁移**（`migrateOrderSpine` ①）：名字交接必须在
 * `ALTER TABLE oi_styles DROP COLUMN name` **之前**跑，否则一删列历史展示名就没了源头。 */

// ---- 图片指纹库 ----

/** 行映射：DB snake_case → 领域 camelCase（避免 local_path/localPath、result_json/resultJson 字段错位） */
function mapImageRow(row: unknown): OrderImageRecord | undefined {
  if (!row || typeof row !== 'object') return undefined;
  const r = row as Record<string, unknown>;
  return {
    id: r.id !== undefined && r.id !== null ? Number(r.id) : undefined,
    fingerprint: r.fingerprint !== undefined && r.fingerprint !== null ? String(r.fingerprint) : '',
    urlFingerprint: r.url_fingerprint !== undefined && r.url_fingerprint !== null ? String(r.url_fingerprint) : '',
    sourceUrl: r.source_url !== undefined && r.source_url !== null ? String(r.source_url) : '',
    localPath: r.local_path !== undefined && r.local_path !== null ? String(r.local_path) : '',
    status: (['pending', 'done', 'error'].includes(String(r.status)) ? String(r.status) : 'pending') as OrderImageRecord['status'],
    resultJson: r.result_json !== undefined && r.result_json !== null ? String(r.result_json) : undefined,
    error: r.error !== undefined && r.error !== null ? String(r.error) : undefined,
    createdAt: r.created_at !== undefined && r.created_at !== null ? String(r.created_at) : undefined,
    updatedAt: r.updated_at !== undefined && r.updated_at !== null ? String(r.updated_at) : undefined,
    styleColorId: r.style_color_id !== undefined && r.style_color_id !== null ? Number(r.style_color_id) : undefined,
  };
}

/** 按内容指纹查（同一文件字节级去重） */
export function findImageByFingerprint(fingerprint: string): OrderImageRecord | undefined {
  return mapImageRow(dbGet('SELECT * FROM oi_images WHERE fingerprint = ?', [fingerprint]));
}

/** 按 URL 规范化指纹查（同图不同 URL/签名参数去重） */
export function findImageByUrlFingerprint(urlFingerprint: string): OrderImageRecord | undefined {
  return mapImageRow(dbGet('SELECT * FROM oi_images WHERE url_fingerprint = ?', [urlFingerprint]));
}

/** 记录下载成功的图片（pending 态，待 AI 识别）。返回的是 `oi_images` 的主键（`OrderImageId`） */
export function insertImage(rec: OrderImageRecord): OrderImageId {
  const r = dbRun(
    `INSERT INTO oi_images (fingerprint, url_fingerprint, source_url, local_path, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    [rec.fingerprint, rec.urlFingerprint, rec.sourceUrl, rec.localPath],
  );
  return Number(r.lastInsertRowid) as OrderImageId;
}

/** 更新图片归属款色（识别确认后挂接）—— **同时**把结论投影到订单行（见 `projectImageColorToOrders`） */
export function setImageStyleColor(imageId: number, styleColorId: number | null): void {
  dbRun(`UPDATE oi_images SET style_color_id = ?, updated_at = datetime('now','localtime') WHERE id = ?`, [
    styleColorId,
    imageId,
  ]);
  projectImageColorToOrders(imageId, styleColorId);
}

/**
 * 把**图片上的款色结论**投影到订单行（`oi_order_items.style_color_id`）。
 *
 * 为什么要有这一层（2026-10-20）：订单行的款色原先只能经「订单图 → 色图 → 款色」四表 JOIN 派生，
 * 每个消费者各走一遍、各拼一套文本键 ⇒ 3 套需求口径；色名一改，全部文本键失联（用户实报"全待拿"）。
 * 订单行有了 id 列之后，需求/已拿/取图只认 id。
 *
 * 三条纪律：
 *   · **一处写**：所有改 `oi_images.style_color_id` 的地方都走 `setImageStyleColor` / 本函数
 *     （多一个写者，就回到"同一事实多个写入方"的老坑）；
 *   · **值未变不写**（`WHERE style_color_id <> ?`）：避免每次进页自愈都白写一遍、把 WAL 撑大；
 *   · 一张图可能被多行订单共用（同单同 SKU 拆行）⇒ 按 `image_id` 全量投影，它们是同一个结论。
 */
function projectImageColorToOrders(imageId: number | null | undefined, styleColorId: number | null): void {
  const imgId = Number(imageId);
  if (!imgId) return;
  const next = Number(styleColorId) || 0;
  dbRun(`UPDATE oi_order_items SET style_color_id = ? WHERE image_id = ? AND COALESCE(style_color_id, 0) <> ?`, [
    next,
    imgId,
    next,
  ]);
}

/** 从图片反查一次结论并投影（订单落库后用：图可能**在导入前**就已被识别/人工归过色） */
function syncOrderClassificationFromImage(imageId: number | null | undefined): void {
  const imgId = Number(imageId);
  if (!imgId) return;
  const row = dbGet<{ style_color_id: number | null }>(
    `SELECT style_color_id FROM oi_images WHERE id = ?`,
    [imgId],
  );
  if (!row) return;
  projectImageColorToOrders(imgId, row.style_color_id);
}

/**
 * 把一张**已入库**的图采纳为「款色绑定图」（采集建款向导的色图采纳；方案 §8.8 P4 扩展）。
 *
 * 落点与 `autoAssignByMap` 完全同一条：`ensureStyleByCode` + `ensureStyleColor` +
 * `setImageStyleColor` —— 订单归款与采集色图采纳共用同一份款色解析，不引第二套口径
 * （订单按图归色认的款色，与向导采纳绑的款色，必须是同一个东西）。
 *
 * 只补空（两条边界，都是"不换掉已经有的结论"）：
 *   ① **图侧**：这张图已挂在某个款色上（`style_color_id` 非空）⇒ 不动它。
 *      同图去重会落到同一 `oi_images` 行 —— 它可能已被订单识别或上次采纳绑过；
 *   ② **色侧**：目标款色已经有图 ⇒ 不换图（色→图 1:1，后来者不踢掉先来的；
 *      同一色在矩阵里出现多行时，第二条自然落在这里）。
 *
 * @param imageId **oi_images 的主键**（`OrderImageId`）。用品牌类型而不是裸 `number`：
 *   本仓有第二张图片表 `pl_images`（产品域），两表各自 AUTOINCREMENT、id 必然撞上。
 *   曾经把 `pl_images` 的 id 当成色图 id 传进来，结果是**改了另一张表的另一行**（一张订单图
 *   的归类状态被改判），而回执还报 `bound:true`（审查报告 P0-1）。品牌类型让这种传参
 *   **编译不过**，而不是留到运行时静默写脏。
 * @returns bound=false 时 `reason` 说清为什么没绑（调用方写进回执，不猜）
 */
export function adoptStyleColorImageByCode(
  code: string,
  color: string,
  imageId: OrderImageId,
): { bound: boolean; reason?: 'image-bound' | 'color-bound' } {
  const c = String(code ?? '').trim();
  const col = String(color ?? '').trim();
  if (!c || !col || !(Number(imageId) > 0)) return { bound: false };
  const style = ensureStyleByCode(c);
  const sc = ensureStyleColor(style.id, style.code, col);
  const img = dbGet<{ style_color_id: number | null }>(
    `SELECT style_color_id FROM oi_images WHERE id = ?`,
    [imageId],
  );
  if (!img) return { bound: false };
  if (img.style_color_id) return { bound: false, reason: 'image-bound' };
  const taken = dbGet<{ id: number }>(`SELECT id FROM oi_images WHERE style_color_id = ? LIMIT 1`, [
    sc.id,
  ]);
  if (taken) return { bound: false, reason: 'color-bound' };
  setImageStyleColor(imageId, sc.id);
  return { bound: true };
}

// ---- 款编码 / 款色（产品库主数据） ----

/** 颜色 → 款色编码英文段（数据层存英文 key，展示层映射中文，避免编码字符集问题） */
const COLOR_CODE: Record<string, string> = {
  黑色: 'BLACK',
  白色: 'WHITE',
  灰色: 'GRAY',
  深灰: 'DARKGRAY',
  浅灰: 'LIGHTGRAY',
  藏蓝: 'NAVY',
  // 与渲染层 `src/lib/colorSwatch.ts` 的键对齐：映射页的颜色下拉就用那张表的键
  //（枚举分叉的症状是"这里能选、那边编码成 OTHER" —— `colorCode` 对表外色名回落 ASCII/OTHER）
  藏青: 'NAVY',
  军绿: 'ARMYGREEN',
  蓝色: 'BLUE',
  卡其: 'KHAKI',
  红色: 'RED',
  酒红: 'WINE',
  粉色: 'PINK',
  紫色: 'PURPLE',
  绿色: 'GREEN',
  黄色: 'YELLOW',
  橙色: 'ORANGE',
  棕色: 'BROWN',
  米色: 'BEIGE',
  米白: 'OFFWHITE',
  牛仔: 'DENIM',
  印花多色: 'MULTI',
};

function colorCode(color: string): string {
  const c = COLOR_CODE[color];
  if (c) return c;
  const ascii = String(color)
    .replace(/[^\x20-\x7e]/g, '')
    .toUpperCase()
    .replace(/\s+/g, '');
  return ascii || 'OTHER';
}

/** 款式展示名：品类 + 区分特征拼接（仅展示，不参与匹配） */
function buildStyleName(category: string, features: string[]): string {
  const name = String(category || '').trim();
  const feats = (features || []).map((f) => String(f).trim()).filter(Boolean);
  return feats.length ? `${name} ${feats.join(' ')}`.trim() : name || '未命名款式';
}

/** 下一个款编码序号：按现有 code 的最大序号 +1（删除后不回收）。
 * 同时记录全部已占用 code，从 max+1 起向后找第一个未占用序号，
 * 避免手工改名/导入手工款号占用连续序号后仍返回同一编码造成复号。
 *
 * D1 后编码池有**两个**来源：`oi_styles`（识别建款）与 `pl_products`（产品库手工新建）。
 * 只查前者会让 `STYLE-005` 被产品库先占用、又发给下一款识别 → 撞 pl_products 的唯一键
 * （表现为「识别建款失败」，报错却指向产品库，方向全反）。 */
export function nextStyleCode(): string {
  const rows = dbQuery<{ code: string }>(
    productSchemaReady()
      ? `SELECT code FROM oi_styles UNION SELECT code FROM pl_products`
      : `SELECT code FROM oi_styles`,
  );
  const used = new Set<string>();
  let max = 0;
  for (const r of rows) {
    const code = String(r.code);
    used.add(code);
    const m = code.match(/^STYLE-(\d+)$/);
    if (m) max = Math.max(max, Number(m[1]));
  }
  let n = max + 1;
  while (used.has('STYLE-' + String(n).padStart(3, '0'))) n += 1;
  return 'STYLE-' + String(n).padStart(3, '0');
}

/**
 * 找/建款色（款编码 + 归一化颜色 → 款色）。
 * 编码冲突时加 `-2/-3` 后缀 —— 与 `importStyles` 同规则（同款多色 + 历史数据可能已占用编码）。
 * 抽出来是因为映射自动归款（`autoAssignByMap`）也要落到款色上：两处各写一遍迟早分叉。
 */
function ensureStyleColor(styleId: number, styleCode: string, color: string): { id: number; code: string } {
  const d = getDb();
  const sc = d
    .prepare(`SELECT id, code FROM oi_style_colors WHERE style_id = ? AND color = ?`)
    .get(styleId, color) as { id: number; code: string } | undefined;
  if (sc) return sc;
  let scCode = `${styleCode}-${colorCode(color)}`;
  let seq = 2;
  while (d.prepare(`SELECT id FROM oi_style_colors WHERE code = ?`).get(scCode)) {
    scCode = `${styleCode}-${colorCode(color)}-${seq}`;
    seq += 1;
  }
  const r = d.prepare(`INSERT INTO oi_style_colors (style_id, color, code) VALUES (?, ?, ?)`).run(styleId, color, scCode);
  return { id: Number(r.lastInsertRowid), code: scCode };
}

/**
 * 款式匹配/落库（原子事务）：
 *   1. 按款式指纹查 oi_styles，命中复用款编码，未命中新建；
 *   2. 按 款编码+归一化颜色 查/建款色；
 *   3. 返回款色 id（调用方负责挂到图片上）。
 * 幂等：同一指纹+颜色重复调用返回同一款色。
 */
export function resolveStyle(input: ResolveStyleInput): {
  styleId: number;
  styleColorId: number;
  styleCode: string;
  styleColorCode: string;
} {
  const d = getDb();
  return dbTransaction(() => {
    let style = d
      .prepare(`SELECT id, code FROM oi_styles WHERE fingerprint = ?`)
      .get(input.fingerprint) as { id: number; code: string } | undefined;
    // 主指纹未命中 → 查附加指纹表（用户手动归并款式时写入，使自动识别也能命中目标款编码）
    if (!style) {
      style = d
        .prepare(
          `SELECT s.id, s.code FROM oi_style_fingerprints f
           JOIN oi_styles s ON s.id = f.style_id WHERE f.fingerprint = ?`,
        )
        .get(input.fingerprint) as { id: number; code: string } | undefined;
    }
    if (!style) {
      const code = nextStyleCode();
      const name = (input.styleName && input.styleName.trim()) || buildStyleName(input.category, input.features);
      // D1：oi_styles 只留识别私有信息（code + 指纹），展示名写产品库（唯一权威）。
      // 这里必须是**空串哨兵**，不能顺手把 name 也写进来 —— 那又是一份会分叉的副本。
      const r = d
        .prepare(`INSERT INTO oi_styles (code, fingerprint) VALUES (?, ?)`)
        .run(code, input.fingerprint);
      style = { id: Number(r.lastInsertRowid), code };
      adoptProduct({ code, name });
    }
    const sc = ensureStyleColor(style.id, style.code, input.color);
    return { styleId: style.id, styleColorId: sc.id, styleCode: style.code, styleColorCode: sc.code };
  });
}

/**
 * 归并后清理原款（须在主进程事务内调用，勿自行开事务）：
 * 当订单图片被移出原款、原款已无任何图片（空壳——无图即无订单挂接）时——
 *   1. 把原款主指纹 + 全部附加指纹迁入目标款的附加指纹表（与目标主指纹相同的跳过，
 *      重复/被其他款占用由 INSERT OR IGNORE 静默吸收），保证释放后同指纹识别能直接命中目标款编码；
 *   2. 删除原款（其款色与残留附加指纹 CASCADE 级联清理；空壳无图，无需解挂图片）。
 * 原款仍有图片时不动（保留主数据，避免误删）。删除后编码不再占用，产品库可重新导入同名款编码。
 */
function mergeOrphanStyle(fromStyleId: number | undefined, toStyleId: number): void {
  if (!fromStyleId || fromStyleId === toStyleId) return;
  const d = getDb();
  const from = d.prepare(`SELECT fingerprint FROM oi_styles WHERE id = ?`).get(fromStyleId) as
    | { fingerprint: string }
    | undefined;
  if (!from) return; // 原款已被删除（如先 reclassify 后手动归并的两段处理）
  // 仅空壳才清理：原款下仍有图片的，保留款式主数据
  const alive = d
    .prepare(
      `SELECT 1 FROM oi_images i JOIN oi_style_colors sc ON i.style_color_id = sc.id WHERE sc.style_id = ? LIMIT 1`,
    )
    .get(fromStyleId);
  if (alive) return;
  const to = d.prepare(`SELECT fingerprint FROM oi_styles WHERE id = ?`).get(toStyleId) as
    | { fingerprint: string }
    | undefined;
  if (!to) return;
  // 收集原款主指纹 + 附加指纹，全部迁入目标款
  const fps = new Set<string>();
  if (from.fingerprint) fps.add(from.fingerprint);
  const extras = dbQuery<{ fingerprint: string }>(
    `SELECT fingerprint FROM oi_style_fingerprints WHERE style_id = ?`,
    [fromStyleId],
  );
  for (const e of extras) {
    if (e.fingerprint) fps.add(e.fingerprint);
  }
  const insert = d.prepare(`INSERT OR IGNORE INTO oi_style_fingerprints (style_id, fingerprint) VALUES (?, ?)`);
  for (const fp of fps) {
    if (fp === to.fingerprint) continue; // 与目标主指纹相同：主表即可命中，无需重复写附加
    insert.run(toStyleId, fp);
  }
  // 图片已全部改挂 → 直接删除原款（款色/附加指纹 ON DELETE CASCADE 级联清理）
  d.prepare(`DELETE FROM oi_styles WHERE id = ?`).run(fromStyleId);
}

/**
 * 手动归并款式：把订单图片挂到指定款编码的对应款色，并把订单指纹记入该款式的附加指纹表，
 * 使后续自动识别也能命中目标款编码（解决同款衣服识别漂移产生多个款编码的问题）。
 * 不改动目标款式的既有主指纹；指纹已被其他款式占用时附加指纹静默忽略（图片归属仍生效）。
 * 归并后原款若因此变空壳，会把其指纹迁入目标款并删除（见 mergeOrphanStyle）。
 *
 * ⭐ **颜色是"以图为准"的记忆落点**（2026-10-10 用户口径：记住订单里的产品图片地址对应的颜色）：
 * 这里写的 `oi_images.style_color_id` 就是那份记忆 —— 图片行按内容/URL 指纹去重，同一张图
 * 反复出现时**还是同一行**，于是"下次遇到同样的地址"读到的就是这次写下的颜色
 * （订单列表把 `sc.color` 联表出来给核对页当默认值）。所以颜色只在这里落一次，不要另建一张记忆表。
 *
 * 定位目标款有两种入参，**`styleId` 优先**（老调用方/宿主冒烟仍按 id 走）：
 *   · `styleId > 0` —— 直连识别池的行；
 *   · 否则按 `styleCode` 走 `ensureStyleByCode`（产品库里手工新建的款在识别池里没有行，
 *     点名它时必须补一行占位款，否则会抛「款式不存在」而用户只看到"保存失败"）。
 */
export function assignOrderStyle(input: {
  orderId: number;
  /** 直连识别池行时给 id（老调用方/宿主冒烟按 id 走）；给 0/缺省则按 styleCode 解析 */
  styleId?: number;
  /** 目标款编码（`oi_styles.code` / `pl_products.code` 同一锚点） */
  styleCode?: string;
  color: string;
  fingerprint?: string;
}): {
  styleCode: string;
  styleColorCode: string;
  skuBackfill: SkuBackfillOutcome;
  /** 本次顺带记住的「平台色名 → 我的色名」（`null` = 没记 / 无需记） */
  colorAlias: ColorAliasRemembered | null;
} {
  const d = getDb();
  const color = String(input.color ?? '').trim();
  const assigned = dbTransaction(() => {
    const order = d.prepare(`SELECT image_id FROM oi_order_items WHERE id = ?`).get(input.orderId) as
      | { image_id: number }
      | undefined;
    if (!order) throw new Error(`订单不存在: id=${input.orderId}`);
    const wantId = Number(input.styleId ?? 0);
    let style: { id: number; code: string } | undefined;
    if (wantId > 0) {
      style = d.prepare(`SELECT id, code FROM oi_styles WHERE id = ?`).get(wantId) as
        | { id: number; code: string }
        | undefined;
      if (!style) throw new Error(`款式不存在: id=${input.styleId}`);
    } else {
      style = ensureStyleByCode(String(input.styleCode ?? ''));
    }
    let sc = d.prepare(`SELECT id, code FROM oi_style_colors WHERE style_id = ? AND color = ?`).get(style.id, color) as
      | { id: number; code: string }
      | undefined;
    if (!sc) {
      let scCode = `${style.code}-${colorCode(color)}`;
      let seq = 2;
      while (d.prepare(`SELECT id FROM oi_style_colors WHERE code = ?`).get(scCode)) {
        scCode = `${style.code}-${colorCode(color)}-${seq}`;
        seq += 1;
      }
      const r = d.prepare(`INSERT INTO oi_style_colors (style_id, color, code) VALUES (?, ?, ?)`).run(style.id, color, scCode);
      sc = { id: Number(r.lastInsertRowid), code: scCode };
    }
    // 改挂前记录图片原归属款（供空壳原款清理使用）
    const prevImg = d.prepare(`SELECT style_color_id FROM oi_images WHERE id = ?`).get(order.image_id) as
      | { style_color_id: number | null }
      | undefined;
    let prevStyleId: number | undefined;
    if (prevImg?.style_color_id) {
      const prevSc = d
        .prepare(`SELECT style_id FROM oi_style_colors WHERE id = ?`)
        .get(prevImg.style_color_id) as { style_id: number } | undefined;
      prevStyleId = prevSc?.style_id;
    }
    // 图片归属与订单行投影**同一次写入**（同一个事务）：订单行的款色不许比图片晚一拍，
    // 否则"人工归了款、拿货页还是没归"会变成偶发（取决于哪条路径先进）。
    setImageStyleColor(order.image_id, sc.id);
    if (input.fingerprint) {
      d.prepare(`INSERT OR IGNORE INTO oi_style_fingerprints (style_id, fingerprint) VALUES (?, ?)`).run(
        style.id,
        input.fingerprint,
      );
    }
    // 原款若因此变空壳（无图无单）→ 指纹迁入目标款并删除，避免空壳款占用主指纹误导后续识别
    if (prevStyleId && prevStyleId !== style.id) mergeOrphanStyle(prevStyleId, style.id);
    return { styleCode: style.code, styleColorCode: sc.code };
  });
  // ⭐ 回流「商品ID → 款 + 色」在**事务外**做：它是"顺手记住"，失败绝不能影响
  // "归属已改"这个**已提交**的事实（`skuBackfillFromOrder` 内部不抛）。
  // 顺序也不能反：回流要用本次真正落下的款编码（`assigned.styleCode`），而不是入参里的猜测。
  const skuBackfill = skuBackfillFromOrder({ orderId: input.orderId, styleCode: assigned.styleCode, color });
  // ⭐ 色名对照同样在事务外、同样"失败不影响归属"：用户把 `Khaki` 改成了 `卡其`，
  // 这一对记到产品级字典上，同一款后续订单（以及同商品的历史订单）自动落成 `卡其`。
  const colorAlias = rememberColorFromAssignment({
    orderId: input.orderId,
    styleCode: assigned.styleCode,
    color,
  });
  return { ...assigned, skuBackfill, colorAlias };
}

/** 修改款式展示名（款编码级，全局生效；仅展示，不参与指纹匹配）。
 *
 *  D1：唯一权威是 `pl_products` —— 只写产品库。产品库尚无该 code 时补建一行
 *  （历史库还没跑交接、或产品被删过），避免「改名改到没有的地方」变成静默空操作。
 *
 *  入口边界：本函数以**识别编码池**为准（code 必须能在 oi_styles 里查到），因为它是
 *  「订单归类」的款名编辑入口 —— 没参与过订单、只在产品库手工新建的产品不在它视野里，
 *  那种产品改名走产品库界面自己的 `upsert`。故这里保持"查不到就抛错"，
 *  不为了多覆盖一种情况就静默改判（会让调用方以为改成功了）。 */
export function renameStyle(code: string, name: string): void {
  const c = String(code ?? '').trim();
  const style = dbQuery<{ id: number }>(`SELECT id FROM oi_styles WHERE code = ?`, [c]);
  if (!style.length) throw new Error(`款式不存在: code=${code}（识别编码池无此编码）`);
  const next = String(name ?? '').trim().slice(0, 50);
  if (!renameProduct(c, next).changed) {
    adoptProduct({ code: c, name: next }, { overwriteName: true });
  }
}

/** 一款下的一个色行（"色未定"就地修复的候选：**只列该款真实存在的色**，不猜、不编） */
export interface StyleColorOption {
  id: number;
  color: string;
  /** 该色行挂着图 → 用户能对着图认；`false` 多为归色改写留下的空壳（界面里要能与真实色区分） */
  hasImage: boolean;
}

/**
 * 按款编码批量列出该款所有色行（2026-10-20）。
 *
 * 为什么需要它：历史拿货明细只存了**色名快照**（且是占位「未分类」），色行改名后两边对不上，
 * 明细既匹配不上"已拿"、也取不到图。修复必须由人选一个**真实存在的色**——
 * 候选只能来自款色表，界面上现编一个名字只会再造一批对不上的标签。
 *
 * 顺序按 id（= 色行创建顺序，稳定）；界面自行决定怎么排（有图优先 / 把占位排最后）。
 */
export function styleColorOptions(styleCodes: string[]): Record<string, StyleColorOption[]> {
  const codes = [
    ...new Set(
      (Array.isArray(styleCodes) ? styleCodes : [])
        .map((c) => String(c ?? '').trim().toUpperCase())
        .filter(Boolean),
    ),
  ].slice(0, 500);
  const out: Record<string, StyleColorOption[]> = {};
  if (!codes.length) return out;
  for (const c of codes) out[c] = [];
  const ph = codes.map(() => '?').join(',');
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT UPPER(s.code) AS code, sc.id AS id, sc.color AS color,
            EXISTS (SELECT 1 FROM oi_images i WHERE i.style_color_id = sc.id AND COALESCE(i.local_path,'') <> '') AS has_image
     FROM oi_styles s
     JOIN oi_style_colors sc ON sc.style_id = s.id
     WHERE UPPER(s.code) IN (${ph}) AND COALESCE(TRIM(sc.color), '') <> ''
     ORDER BY s.code, sc.id`,
    codes,
  );
  for (const r of rows) {
    const code = String(r.code ?? '');
    const list = out[code] ?? (out[code] = []);
    list.push({
      id: Number(r.id) || 0,
      color: String(r.color ?? ''),
      hasImage: Number(r.has_image) === 1,
    });
  }
  return out;
}

/**
 * 把某个款的**色行改名**（只动 `oi_style_colors.color` 这一列）—— id / 编码 / 绑定的图全不动。
 *
 * 为什么要它（2026-10-23 用户实报「并入矩阵后改颜色，图片就没了」）：款色图是按
 * 「款编码 + 色名」查的（见下方 `findStyleColorImagePath`），而产品编辑抽屉里的色名是
 * **人会改的标签**。产品侧改名、订单侧不改，两边就只剩"名字"这一条线索 ⇒ 图当场查不到
 * （重开抽屉也空）。按 C2「关联用 ID，不用名字」：色名是标签，款色行才是身份 ——
 * 所以改名只动标签，`oi_style_colors.id` 与 `oi_images.style_color_id` 保持原样，
 * 图、拿货/拣货的历史分组、订单归属全都不受影响。
 *
 * 三条边界（少一条就会造出"同款两行同色"或"改完更差"）：
 *   · **目标色名已存在 ⇒ 拒绝**（`target-exists`）。那是两个色行的合并，图该留哪张是
 *     人看着图做的判断，不能由"改成了同一个名字"隐式决定 —— 合并留给人做。
 *   · **不碰 `code`**：款色编码是历史派生值（`款编码-色码英文段`），表上有全局 UNIQUE；
 *     顺手重算一次就可能去撞别的色行，把一次改名变成一次失败。
 *   · 款 / 色行找不到 ⇒ 什么都不做并给出原因（老库还没建、这个色只存在于产品侧）。
 *
 * @returns `renamed=false` 时 `reason` 说清为什么没改（调用方据此决定要不要提示）
 */
export function renameStyleColorByCode(
  code: string,
  fromColor: string,
  toColor: string,
): {
  renamed: boolean;
  styleColorId?: number;
  reason?: 'noop' | 'no-style' | 'no-color' | 'target-exists';
} {
  const c = String(code ?? '').trim();
  const from = String(fromColor ?? '').trim();
  const to = String(toColor ?? '').trim();
  if (!c || !from || !to || from === to) return { renamed: false, reason: 'noop' };
  const style = dbGet<{ id: number }>(`SELECT id FROM oi_styles WHERE code = ?`, [c]);
  if (!style) return { renamed: false, reason: 'no-style' };
  const sc = dbGet<{ id: number }>(
    `SELECT id FROM oi_style_colors WHERE style_id = ? AND color = ?`,
    [style.id, from],
  );
  if (!sc) return { renamed: false, reason: 'no-color' };
  const taken = dbGet<{ id: number }>(
    `SELECT id FROM oi_style_colors WHERE style_id = ? AND color = ?`,
    [style.id, to],
  );
  if (taken) return { renamed: false, reason: 'target-exists' };
  dbRun(`UPDATE oi_style_colors SET color = ? WHERE id = ?`, [to, sc.id]);
  return { renamed: true, styleColorId: sc.id };
}

/**
 * 按 款编码+款色（+尺码）取一张已下载的代表图（本地路径），供拿货单编辑器/Excel 导出嵌图；查不到返回 null。
 *
 * ⚠️ `size` 不是装饰，**调用方应当传**（2026-10-11 用户报"拿货单明细的图片都是一样的"）：
 *   · 明细行的粒度是「款色 × 尺码」（`outstanding()` 的聚合键 = `purchase_items` 唯一键），
 *     而订单 Excel 解析出来的图挂在**订单行**上（`oi_order_items.image_id` → 那一件商品自己的图）。
 *   · 只按款色取 ⇒ `ORDER BY i.id DESC LIMIT 1` 永远挑"该款色最新那张"——同一款的多行
 *     （不同尺码、各来自不同商品）会**全显示同一张图**，且多数行显示的还不是自己那件的图。
 *     真库实测（SUST-006·未分类 下挂 4 张不同商品的图）：5 行明细全落到 id 最大那张，**4/5 行是错的**。
 *   · 传了 `size` 就**先**挑「该尺码的订单行用过的那张图」（`EXISTS` 子查询，不是 JOIN ——
 *     JOIN 会让一张图按引用它的订单行数放大，`LIMIT 1` 取到谁就变得不确定）；
 *     该尺码下压根没有订单行（手工加的行 / 订单还没导入）才回落到款色级最新图 ——
 *     **有图仍优于缺图**，回落只是兜底，不改变"优先本行对应图"的口径。
 */
export function findStyleColorImagePath(
  styleCode: string,
  color: string,
  size = '',
  styleColorId = 0,
): string | null {
  const code = String(styleCode ?? '').trim();
  const clr = String(color ?? '').trim();
  const sz = String(size ?? '').trim();
  // 身份优先（2026-10-20）：拿货明细里带了款色 id 就只认它 —— 色名是**会变的标签**
  // （`autoAssignByMap` / 人工核对都会改写），拿它找图会在改名后静默变 null，
  // 症状是"拿货单图片全没了"（用户实报）。id 命中而该色行没图时**返回 null，不回落色名**：
  // 色名回落可能取到**别的色**的图 ⇒ 发错货；缺图只让人去补图，代价小得多。
  if (Number(styleColorId) > 0) {
    const byId = dbGet<{ local_path: string }>(
      `SELECT i.local_path
       FROM oi_style_colors sc
       JOIN oi_images i ON i.style_color_id = sc.id
       WHERE sc.id = ?
         AND i.local_path IS NOT NULL AND i.local_path <> ''
       ORDER BY
         CASE WHEN ? <> '' AND EXISTS (
           SELECT 1 FROM oi_order_items o WHERE o.image_id = i.id AND o.size = ?
         ) THEN 0 ELSE 1 END,
         i.id DESC
       LIMIT 1`,
      [Number(styleColorId), sz, sz],
    );
    return byId?.local_path ?? null;
  }
  const row = dbGet<{ local_path: string }>(
    `SELECT i.local_path
     FROM oi_styles s
     JOIN oi_style_colors sc ON sc.style_id = s.id
     JOIN oi_images i ON i.style_color_id = sc.id
     WHERE s.code = ? AND sc.color = ?
       AND i.local_path IS NOT NULL AND i.local_path <> ''
     ORDER BY
       CASE WHEN ? <> '' AND EXISTS (
         SELECT 1 FROM oi_order_items o WHERE o.image_id = i.id AND o.size = ?
       ) THEN 0 ELSE 1 END,
       i.id DESC
     LIMIT 1`,
    [code, clr, sz, sz],
  );
  return row?.local_path ?? null;
}

/** 产品库 Excel 导入项（渲染层已按 styleMatcher 生成指纹后传入） */
export interface StyleImportItem {
  /** 款编码（可选，留空自动生成 STYLE-xxx；已存在则视为更新该款式） */
  code?: string;
  /** 款式名 */
  name: string;
  /** 款色（归一化颜色，必填） */
  color: string;
  /** 主指纹：渲染层按「品类+特征」用识别同一算法生成，或用户自定义指纹 */
  fingerprint: string;
  /** 附加指纹（用户显式填写、与主指纹不同的指纹，写入附加指纹表使识别也能命中） */
  extraFingerprints?: string[];
}

export interface StyleImportResult {
  imported: number;
  errors: { row: number; message: string }[];
}

/**
 * 产品库 Excel 批量导入（原子事务，任一行出错仅记录不中断）：
 * - 款编码已存在 → 更新款式名、追加缺失款色、把本次生成的主指纹记入附加指纹（不覆盖主指纹，避免破坏既有订单匹配）；
 * - 款编码不存在 → 新建款式（主指纹已被其他款式占用时：显式给了不同款编码报错，否则归并到该款式——同款多色/重复导入）；
 * - 附加指纹写入 oi_style_fingerprints，使订单识别也能命中该款编码；
 * - 错误行的 row 从 2 起算（第 1 行为表头）。
 */
export function importStyles(items: StyleImportItem[]): StyleImportResult {
  const d = getDb();
  const errors: { row: number; message: string }[] = [];
  let imported = 0;
  dbTransaction(() => {
    items.forEach((item, i) => {
      const row = i + 2;
      const code = String(item.code ?? '').trim().toUpperCase().slice(0, 50);
      const name = String(item.name ?? '').trim().slice(0, 50);
      const color = String(item.color ?? '').trim().slice(0, 50);
      const fp = String(item.fingerprint ?? '').trim().slice(0, 512);
      const extra = (item.extraFingerprints ?? [])
        .map((f) => String(f ?? '').trim().slice(0, 512))
        .filter((f) => f && f !== fp)
        .slice(0, 20);
      if (!fp) {
        errors.push({ row, message: '缺少指纹：请填写「品类/特征」或「指纹」列' });
        return;
      }
      if (!color) {
        errors.push({ row, message: '缺少颜色：「颜色」列必填' });
        return;
      }
      // 按款编码查/建（同一款编码多行 = 多个款色，仅首行生效的指纹/款式名）
      const existing = code
        ? (d.prepare(`SELECT id, code, fingerprint FROM oi_styles WHERE code = ?`).get(code) as
            | { id: number; code: string; fingerprint: string }
            | undefined)
        : undefined;
      let styleId: number;
      let styleCode: string;
      let styleMainFp = '';
      if (existing) {
        styleId = existing.id;
        styleCode = existing.code;
        styleMainFp = String(existing.fingerprint ?? '');
        // D1：名字写产品库。这里是**显式的产品库导入**语义（用户拿一张产品表来覆盖），
        // 与「识别时顺手建款」不同 —— 故允许覆盖既有主数据名。
        if (name) adoptProduct({ code: styleCode, name }, { overwriteName: true });
      } else {
        // 主指纹占用检查：同指纹已有款式时——
        //   显式给了不同的款编码 → 冲突报错；未给/给同编码 → 归并（同款多色多行、重复导入同款）
        const owner = d.prepare(`SELECT id, code, fingerprint FROM oi_styles WHERE fingerprint = ?`).get(fp) as
          | { id: number; code: string; fingerprint: string }
          | undefined;
        if (owner) {
          if (code && code !== owner.code) {
            errors.push({ row, message: `指纹已属于款式 ${owner.code}：如需归并请在「数据纠正」页操作，或修改款编码/指纹后重试` });
            return;
          }
          styleId = owner.id;
          styleCode = owner.code;
          styleMainFp = String(owner.fingerprint ?? '');
        } else {
          const finalCode = code || nextStyleCode();
          if (d.prepare(`SELECT id FROM oi_styles WHERE code = ?`).get(finalCode)) {
            errors.push({ row, message: `款编码 ${finalCode} 冲突` });
            return;
          }
          const r = d
            .prepare(`INSERT INTO oi_styles (code, fingerprint) VALUES (?, ?)`)
            .run(finalCode, fp);
          styleId = Number(r.lastInsertRowid);
          styleCode = finalCode;
          styleMainFp = fp;
          adoptProduct({ code: finalCode, name: name || '未命名款式' });
        }
      }
      // 附加指纹：用户自定义指纹 + 本次生成的主指纹（与款式主指纹不同时）→ 订单识别也能命中已有款编码
      const addFps = new Set(extra);
      if (fp && styleMainFp && fp !== styleMainFp) addFps.add(fp);
      for (const efp of addFps) {
        const owner = d
          .prepare(`SELECT style_id FROM oi_style_fingerprints WHERE fingerprint = ?`)
          .get(efp) as { style_id: number } | undefined;
        if (owner && Number(owner.style_id) !== styleId) {
          errors.push({ row, message: `附加指纹已被其他款式占用` });
          continue;
        }
        d.prepare(`INSERT OR IGNORE INTO oi_style_fingerprints (style_id, fingerprint) VALUES (?, ?)`).run(styleId, efp);
      }
      // 款色：按 (款式, 颜色) 查/建（款色编码冲突加 -2/-3 后缀）
      const sc = d
        .prepare(`SELECT id, code FROM oi_style_colors WHERE style_id = ? AND color = ?`)
        .get(styleId, color) as { id: number; code: string } | undefined;
      if (!sc) {
        let scCode = `${styleCode}-${colorCode(color)}`;
        let seq = 2;
        while (d.prepare(`SELECT id FROM oi_style_colors WHERE code = ?`).get(scCode)) {
          scCode = `${styleCode}-${colorCode(color)}-${seq}`;
          seq += 1;
        }
        d.prepare(`INSERT INTO oi_style_colors (style_id, color, code) VALUES (?, ?, ?)`).run(styleId, color, scCode);
      }
      imported += 1;
    });
  });
  return { imported, errors };
}

/**
 * 款式展示名的派生片段（D1：权威在 `pl_products`，按 `code` 关联）。
 *   · 产品表未就绪时降级为空名 —— 直接 JOIN 会抛「no such table」，把「产品域还没建」
 *     报成「订单域坏了」，排查方向整个反掉；
 *   · 用 LEFT JOIN 而非 INNER：oi_styles 有行而产品缺失时仍要能列出该款 ——
 *     少一行比空名难查得多（这正是「读错对象」伪装成「对象有问题」的经典形态）。
 */
function styleNameJoin(): { join: string; name: string } {
  return productSchemaReady()
    ? { join: 'LEFT JOIN pl_products p ON p.code = s.code', name: 'p.name' }
    : { join: '', name: `''` };
}

/** 一列去重（保序、去空白） */
function uniqColor(list: string[]): string[] {
  const out: string[] = [];
  const seen = new Set<string>();
  for (const c of list) {
    const v = String(c ?? '').trim();
    if (!v || seen.has(v)) continue;
    seen.add(v);
    out.push(v);
  }
  return out;
}

/** `product_id → 颜色[]`（产品库 SKU 那一侧；表还没建时给空 Map，别把"没这张表"报成"没有颜色"） */
function productColorMap(): Map<number, string[]> {
  const m = new Map<number, string[]>();
  if (!tableExists('pl_variants')) return m;
  for (const r of dbQuery<{ product_id: number; color: string }>(
    `SELECT product_id, color FROM pl_variants WHERE color <> '' ORDER BY product_id, id`,
  )) {
    const pid = Number(r.product_id);
    if (!m.has(pid)) m.set(pid, []);
    m.get(pid)!.push(String(r.color ?? ''));
  }
  return m;
}

/** `style_id → 颜色[]`（识别链已学到的款色那一侧） */
function styleColorMap(): Map<number, string[]> {
  const m = new Map<number, string[]>();
  for (const r of dbQuery<{ style_id: number; color: string }>(
    `SELECT style_id, color FROM oi_style_colors WHERE color <> '' ORDER BY style_id, id`,
  )) {
    const sid = Number(r.style_id);
    if (!m.has(sid)) m.set(sid, []);
    m.get(sid)!.push(String(r.color ?? ''));
  }
  return m;
}

/**
 * **款选项列表**（「归类核对」页「归属款」下拉的数据源，也供其它域查款）。
 *
 * 驱动表是 `pl_products`（产品库）—— **不是** `oi_styles`。旧实现按识别池驱动，于是
 * 「货与成本」里手工新建、还没出过订单的产品**一个都不出现**，界面上无从察觉
 * （2026-10-10 用户报的「当前数据展示不全」就是这个）。两处 `LEFT`/补充串接的边界：
 *   · 产品库有、识别池没有（手工新建的款）⇒ 照样列出（`styleId` 概念已从本结构移除，
 *     点名时才由 `ensureStyleByCode` 补一行识别池占位款）；
 *   · 识别池有、产品库没有（历史库还没跑交接 / 产品被删）⇒ 也要能选 —— 少一行比多一行难查得多；
 *   · 产品表**整张不存在**（产品域还没建）⇒ 退回识别池，而不是抛 `no such table` 把
 *     「产品域还没建」报成「订单域坏了」（排查方向整个反掉）。
 */
export function listStyles(): StyleRecord[] {
  const prodColors = productColorMap();
  const learnColors = styleColorMap();

  if (!productSchemaReady()) {
    return dbQuery<{ style_id: number; code: string }>(
      `SELECT id AS style_id, code FROM oi_styles WHERE code <> '' ORDER BY code`,
    ).map((r) => ({
      code: String(r.code ?? ''),
      name: '',
      status: 'active',
      colors: uniqColor(learnColors.get(Number(r.style_id)) ?? []),
    }));
  }

  const rows = dbQuery<{
    product_id: number;
    code: string;
    name: string;
    status: string;
    style_id: number | null;
  }>(
    `SELECT p.id AS product_id, p.code AS code, p.name AS name, p.status AS status, s.id AS style_id
     FROM pl_products p LEFT JOIN oi_styles s ON s.code = p.code
     WHERE p.code <> ''
     ORDER BY p.code`,
  );
  const seen = new Set(rows.map((r) => String(r.code ?? '')));
  // 识别池有、产品库没有的行（历史库 / 产品被删）—— 补在末尾，别让它们从下拉里消失
  const ghosts = dbQuery<{ style_id: number; code: string }>(
    `SELECT id AS style_id, code FROM oi_styles WHERE code <> '' ORDER BY code`,
  ).filter((r) => !seen.has(String(r.code ?? '')));

  const toOption = (
    code: string,
    name: string,
    status: string,
    productId: number,
    styleId: number,
  ): StyleRecord => ({
    code,
    name,
    status,
    colors: uniqColor([
      ...(productId ? (prodColors.get(productId) ?? []) : []),
      ...(styleId ? (learnColors.get(styleId) ?? []) : []),
    ]),
  });

  return [
    ...rows.map((r) =>
      toOption(
        String(r.code ?? ''),
        String(r.name ?? ''),
        String(r.status ?? 'active'),
        Number(r.product_id),
        Number(r.style_id ?? 0),
      ),
    ),
    ...ghosts.map((r) => toOption(String(r.code ?? ''), '', 'active', 0, Number(r.style_id))),
  ];
}

/** 更新识别结果（done / error） */
export function updateImageResult(
  id: number,
  status: 'done' | 'error',
  resultJson?: string,
  error?: string,
): void {
  dbRun(
    `UPDATE oi_images SET status = ?, result_json = ?, error = ?, updated_at = datetime('now','localtime') WHERE id = ?`,
    [status, resultJson ?? null, error ?? null, id],
  );
}

// ---- 订单明细 ----

/** 映射命中但产品还没进过识别链路（产品库手工新建的款）时，给它建的占位款用的指纹前缀。
 *  AI 指纹是内容/特征哈希，不可能以此开头 —— 故占位指纹既不会被真实指纹命中，
 *  也不会反过来命中任何真实款（`resolveStyle` 是精确匹配）。
 *  为什么不干脆不建：`oi_styles.fingerprint` 是 `NOT NULL UNIQUE`，没有指纹就落不下一行，
 *  而订单的归款结论只能挂在款色上（`oi_style_colors.style_id`）。 */
const MAPPED_FP_PREFIX = 'mapped:';

/** 订单没有颜色字段时的兜底色名（映射只到"款"，色取自订单自身；取不到也得能落一个款色） */
const MAPPED_FALLBACK_COLOR = '未分类';

/**
 * 按**款编码**取识别池里的行，没有就补一行占位款。
 *
 * 为什么必须有它：点名归款（`assignOrderStyle`）的入口是「归属款」下拉，而下拉的数据源是
 * **产品库**（`listStyles`，2026-10-10 起）—— 产品库里手工新建、还没出过订单的款，
 * 识别池里**没有行**，`oi_styles.fingerprint` 又是 `NOT NULL UNIQUE`（没有指纹就落不下一行），
 * 归款结论只能挂在款色上（`oi_style_colors.style_id`）⇒ 不补这一行，"点名一个产品库里的新款"
 * 会直接抛「款式不存在」，而用户看到的只是"选了这个款却保存失败"。
 *
 * 占位指纹前缀见 `MAPPED_FP_PREFIX` 的说明（`mapped:` 不可能与 AI 内容指纹相撞）。
 * 同一个 code 只建一次（`INSERT OR IGNORE` + 唯一索引），并与 `autoAssignByMap` 共用本函数，
 * 避免"两处各建一次占位款、指纹前缀写歪"。
 */
function ensureStyleByCode(code: string): { id: number; code: string } {
  const c = String(code ?? '').trim();
  if (!c) throw new Error('款编码不能为空');
  const d = getDb();
  let row = d.prepare(`SELECT id, code FROM oi_styles WHERE code = ?`).get(c) as
    | { id: number; code: string }
    | undefined;
  if (!row) {
    d.prepare(`INSERT OR IGNORE INTO oi_styles (code, fingerprint) VALUES (?, ?)`).run(
      c,
      `${MAPPED_FP_PREFIX}${c}`,
    );
    row = d.prepare(`SELECT id, code FROM oi_styles WHERE code = ?`).get(c) as
      | { id: number; code: string }
      | undefined;
  }
  if (!row) throw new Error(`款式不存在: code=${c}`);
  return { id: Number(row.id), code: String(row.code) };
}

/**
 * 某产品下已配的「平台色名 → 我的色名」对照。
 *
 * 为什么按产品取全量而不是按 (产品, 色名) 点查：归色一次要判"当前色是不是平台色名"
 * 和"重定出的色要不要翻译"两件事，同一份字典用两次；字典行数量级是"每款几个色"，
 * 一条 `WHERE product_id = ?` 的代价远小于两次往返。
 */
function colorAliases(productId: unknown): ColorAliasRow[] {
  const pid = Number(productId) || 0;
  if (pid <= 0) return [];
  return dbQuery<ColorAliasRow>(
    `SELECT product_id, alias_key, color FROM oi_color_aliases WHERE product_id = ?`,
    [pid],
  );
}

/** 平台色名 → 自家色名（没配过原样返回；空进空出）。 */
function toOwnColor(productId: unknown, raw: unknown): string {
  return translateColor(colorAliases(productId), productId, raw);
}

/** 记住一对「平台色名 → 我的色名」的结果（供界面说清"记住了什么"） */
export interface ColorAliasRemembered {
  /** 平台侧原文（用户看到的那个怪名字） */
  from: string;
  /** 用户填的自家色名 */
  to: string;
}

/**
 * 记住「这个产品的平台色名 X 就是我的 Y」。
 *
 * 入口只有一处：**归类核对**里用户把颜色从平台色名改成了自家色名（见 `assignOrderStyle`）。
 * 为什么必须记住：不记的话，同一款的下一个商品/下一批订单**照样**落成 `Khaki`，
 * 用户每次核对都要重改一遍 —— 人工量不随时间递减，这正是"归类省力"要解决的事。
 *
 * 三条边界：
 *   · 同键已有**不同**颜色 ⇒ **以最新一次为准**（覆盖）。不覆盖的话用户会看到
 *     "改了、保存了、下次还是旧的"，且没有任何地方能查出原因（静默失效最糟）；
 *   · 用户填的与平台色名**同键**（只是改大小写/空格）⇒ 不是对照，不记；
 *   · 空产品 id / 空色 ⇒ 不记（占位款没有产品库行，记了也永远查不到）。
 *
 * @returns 真正新增/改写时给出这一对；没有变化返回 `null`
 */
export function rememberColorAlias(
  productId: unknown,
  aliasRaw: unknown,
  color: unknown,
): ColorAliasRemembered | null {
  const pid = Number(productId) || 0;
  const key = colorAliasKey(aliasRaw);
  const raw = typeof aliasRaw === 'string' ? aliasRaw.trim() : '';
  const want = String(color ?? '').trim();
  if (pid <= 0 || !key || !want) return null;
  // 名字本身相同（`khaki` → `Khaki`）不是"另一种叫法"，记下来只会多一行噪声
  if (colorAliasKey(want) === key) return null;
  const existing = dbGet<{ id: number; color: string }>(
    `SELECT id, color FROM oi_color_aliases WHERE product_id = ? AND alias_key = ?`,
    [pid, key],
  );
  if (existing) {
    if (String(existing.color ?? '').trim() === want) return null;
    dbRun(
      `UPDATE oi_color_aliases
          SET color = ?, alias_raw = ?, updated_at = datetime('now','localtime')
        WHERE id = ?`,
      [want, raw, existing.id],
    );
    return { from: raw, to: want };
  }
  dbRun(
    `INSERT INTO oi_color_aliases (product_id, alias_key, alias_raw, color) VALUES (?, ?, ?, ?)`,
    [pid, key, raw, want],
  );
  return { from: raw, to: want };
}

/**
 * 人工核对（`assignOrderStyle`）之后**学一对色名**：这一单的图在采集侧是什么平台色名、
 * 用户把它改成了什么自家色名。
 *
 * 为什么原始色名只能从**外部事实**取（采集快照 / 报表规格串）：用户改完之后 `oi_order_items.color`
 * 已经是新值（`saveCorrection` 先写订单再点名款），拿它当"原文"等于自己跟自己学 ——
 * 键和目标同值，永远记不下东西。两条来源都没有时**不记**（记一对猜的比不记更糟）。
 *
 * 全程不抛：这是"顺手记住"，失败不能影响"归属已改"这个已提交的事实（同 `skuBackfillFromOrder`）。
 *
 * @returns 真正记住时返回这一对；定不出平台色名 / 产品库没有这个款 / 值没变 → `null`
 */
function rememberColorFromAssignment(input: {
  orderId: number;
  styleCode: string;
  color: string;
}): ColorAliasRemembered | null {
  try {
    const color = String(input.color ?? '').trim();
    if (!color || color === MAPPED_FALLBACK_COLOR) return null;
    const row = dbGet<{ source_url: string; raw_fields: string }>(
      `SELECT COALESCE(i.source_url, '') AS source_url, COALESCE(o.raw_fields, '{}') AS raw_fields
         FROM oi_order_items o LEFT JOIN oi_images i ON i.id = o.image_id
        WHERE o.id = ?`,
      [input.orderId],
    );
    if (!row) return null;
    let rawFields: Record<string, string> = {};
    try {
      const v = JSON.parse(String(row.raw_fields ?? '{}'));
      if (v && typeof v === 'object') rawFields = v as Record<string, string>;
    } catch {
      return null; // 脏 raw_fields ⇒ 取不到商品ID，学不了
    }
    const { itemId } = extractSkuFields(rawFields);
    if (!itemId) return null;
    // 平台色名的来源（**必须是外部事实**，绝不能取本链路刚写下的 `oi_order_items.color`）：
    //   ① 订单图 → 采集 SKU 色图（采集快照里记的色名）；
    //   ② 报表规格串里的 `Color:<值>`（`parseOrderPropsColor`）—— 采集没覆盖到的商品只有这一条
    //      （本机库 44/51 单属于这类：没有采集快照 ⇒ ① 恒空 ⇒ 以前一对也记不下、用户每次重改）。
    const raw = orderColorByItemImage(itemId, row.source_url) || parseOrderPropsColor(rawFields);
    // 定不出平台色名 = "从什么改成什么"这个前提不成立，此时记任何一对都是猜
    // （只差大小写/空白也不算对照 —— 与 `rememberColorAlias` 的判据同一份）
    if (!raw || colorAliasKey(raw) === colorAliasKey(color)) return null;
    const pid = productIdByCode(input.styleCode);
    if (!pid) return null; // 产品库里没有这个款（老库还没交接）⇒ 记了也查不到
    const remembered = rememberColorAlias(pid, raw, color);
    // 同商品的历史订单跟着翻译一次：用户改的是"这个名字"，不只是"这一行"
    if (remembered) reassignOrdersByItemIds([itemId], { colors: [remembered.from] });
    return remembered;
  } catch {
    return null;
  }
}

/**
 * 订单落库时的**确定性归款**（P3 业务链路「先查 `pl_shop_sku`，查不到才走 AI 兜底」的落点）。
 *
 * 只认 `status='confirmed'` 的映射（`resolveOrderSku` 内部保证）：`pending`/`invalid` 不得替人下结论。
 * 命中后把订单图片挂到该产品的款色 —— 颜色来源见下方**五级顺序**。
 * 未命中则什么都不做：保持 AI 识别结果不动（不覆盖、也不清空）。
 *
 * 不 catch 是**有意的**：这里能抛的只有真异常（表结构坏 / 约束冲突），吞掉会让
 * "订单看着导入成功却没归款"变成查不出的问题。订单此时已落库，调用方重试会走 `insertOrder`
 * 的幂等分支并**再次尝试本函数** —— 也就是一次可自愈的重试。
 */
function autoAssignByMap(
  rec: Pick<OrderRecord, 'imageId' | 'shop' | 'color' | 'rawFields'>,
): void {
  if (!productSchemaReady()) return;
  // 无图订单不参与归款（归款的落点是把**图片**挂到款色上）
  if (!rec.imageId) return;
  const { itemId } = extractSkuFields(rec.rawFields);
  if (!itemId) return; // 订单没有商品ID → 这条链路无从查起（不是错误）
  const hit = resolveOrderSku({ shop: rec.shop, itemId });
  if (!hit) return;
  // 产品库里手工新建的款在识别池里没有行 ⇒ 补一行占位款（与「点名归款」共用同一个实现）
  const style = ensureStyleByCode(hit.productCode);
  // 颜色权威来源（D4 + 2026-10-19 按图定色 / 平台色名对照 + 2026-10-20 报表规格串）：
  //   ① **映射里配的颜色**（人明确说过"这个商品ID 是什么色"）—— 已经是我方色名，不再翻译
  //   ② 图片**已有**的真实款色（人工纠正 / AI 结论 / 色图采纳继承）—— 一律不动
  //   ③ **订单图 → 采集 SKU 色图**反查出的色（多色商品的确定性途径）
  //   ④ **订单报表的规格串**（`产品属性:Color:5`）与订单自己的颜色列 ——
  //      2026-10-20 起才真正有值：颜色列实测恒空，颜色藏在规格串里（见 `parseOrderPropsColor`）。
  //      为什么排在③之后：③ 有采集快照作证据、且同一份快照还能定克重；④ 只是报表文本，
  //      两者都有时以③为准 —— 这样"以前能定的行"一个都不变，只多救回以前定不了的行。
  //      ④ 刻意**不看图**：采集通道的订单没有图（`image_id` 恒空）+ 采集没覆盖到的商品没有色图，
  //      这两类以前全部落 `未分类`，而规格串里的色名跟图一点关系都没有。
  //   → ⑤ `未分类`（一切都没有时的占位；不许因为查不到就丢成没颜色）
  // ③/④ 出来的都是**平台色名**（`Khaki` / `1`），落库前过一遍产品级对照（`oi_color_aliases`）：
  // 用户在核对页把 `Khaki` 改成 `卡其` 的那一刻，这一对就被记住了 —— 不翻译的话，
  // 同一款的下一批订单照样落成 `Khaki`，用户每次都白改一遍。
  // ②必须在③之前：色图采纳时写的是**我的色名**（如「红色」），采集侧记的是平台色名
  //（如 `Khaki`）；让③盖掉②等于把人工命名冲成平台内部编号。
  // ②的"不动"有一个例外，见下方 `currentIsAlias`：已经确认是平台色名的那些要重定。
  const mapped = String(hit.spec ?? '').trim();
  if (mapped && mapped !== '*') {
    setImageStyleColor(rec.imageId, ensureStyleColor(style.id, hit.productCode, mapped).id);
    return;
  }
  // ②/③ 都要看图，一次查回 URL 与当前归属（两次往返没必要）
  const img = dbGet<{ source_url: string; color: string }>(
    `SELECT COALESCE(i.source_url, '') AS source_url, COALESCE(sc.color, '') AS color
       FROM oi_images i LEFT JOIN oi_style_colors sc ON sc.id = i.style_color_id
      WHERE i.id = ?`,
    [rec.imageId],
  );
  const current = String(img?.color ?? '').trim();
  const aliases = colorAliases(hit.productId);
  // ②已有的真实色不动 —— 但**平台色名不算"真实色名"**：它只是采集侧的字符串（`Khaki` / `1`），
  //   一旦这个产品配过对照（`Khaki → 卡其`），挂在 `Khaki` 上的图就是"还没翻译的"，要重定。
  //   判据用"字典里有没有这一对"而不是猜"像不像色名"：`未分类` 之外的每一串都可能是自家色名，
  //   只有用户认过的那几串能确定是平台侧写法。
  const currentIsAlias = current ? pickColorAlias(aliases, hit.productId, current) !== '' : false;
  if (current && current !== MAPPED_FALLBACK_COLOR && !currentIsAlias) return; // ②不覆盖人的结论
  const raw =
    orderColorByItemImage(itemId, img?.source_url)
    || String(rec.color ?? '').trim()
    // ④ 报表规格串里的平台色名（`产品属性:Color:5`）—— 不看图、不依赖采集快照
    || parseOrderPropsColor(rec.rawFields)
    // 图与字段都定不出时，拿**已有的平台色名**去翻译（有对照就能落成自家名，不退化成未分类）
    || (currentIsAlias ? current : '');
  const color = (raw ? toOwnColor(hit.productId, raw) : '') || MAPPED_FALLBACK_COLOR;
  const sc = ensureStyleColor(style.id, hit.productCode, color);
  setImageStyleColor(rec.imageId, sc.id);
}

/**
 * 映射新增/变更后，对**存量订单**重跑确定性归款 —— 覆盖两类"还没配好色的图"：
 *
 *   · **未归款**（`style_color_id IS NULL`）：先导订单、后配映射时的常规回填；
 *   · 归在**占位色**（`未分类`，见 `MAPPED_FALLBACK_COLOR`）上：配映射时没有色可配，
 *     被兜底名顶了位置；现在补上真实颜色，这些存量订单要跟着改到该色
 *     （否则"补色"只在库里改了映射，订单们还挂着"未分类" —— 用户看不出发生过什么）。
 *
 * 为什么必须有：归款是**写时触发**的（订单落库那一刻跑一次），而真实操作顺序常常反着来 ——
 * 先导订单、后配映射。没有这个回填，用户配完映射**看不到任何变化**，只能把 Excel 重导一遍
 *（同类先例：`syncPurchaseCosts` 上线前的拿货单没进 `ae_cost_map`，见 `purchase-cost-sync.ts`）。
 *
 * 三条边界（都为了"不覆盖人的结论"）：
 *   · **挂在真实颜色上的图一律不动**（人工纠正 / 识别结论 / 上次补的色都算数）——
 *     只认"色还没定"的两种状态：占位色，以及**调用方显式点名的平台色名**（`opts.colors`：
 *     那串不是人的结论，是采集侧的写法，配上对照后要跟着翻译）。改一次映射色不会把历史订单全改判；
 *   · 只处理传入 `itemIds` 命中的行 —— 配了哪个商品就只回填那个商品，不顺手全库重算；
 *   · `autoAssignByMap` 自身未命中就什么都不做（保持原状），所以这里不需要额外判空。
 *
 * @returns 本次**实际发生变化**的行数（新归款 + 补色都算；值没变的行不计 ——
 *          回执里报出的数必须是"真的动了这几行"，而不是"扫过这几行"）
 */
export function reassignOrdersByItemIds(
  itemIds: string[],
  opts?: {
    /**
     * 额外视为"色还没定"的款色名（`sc.color`）。用于**平台色名翻译**那条回填：
     * 图画在 `Khaki` 上不是"人的结论"，而是"还没翻译"，配上 `Khaki → 卡其` 后要跟着改。
     * 不传 = 只回填未归色 / 占位色（原行为）。
     */
    colors?: string[];
  },
): number {
  return reassignCore(itemIds, opts).fixedRows;
}

/** 一次重放的统计（`replaySkuMappings` 的返回，也是界面按钮文案的依据） */
export interface ReplayStats {
  /** 有 `confirmed` 映射的商品数（本次重放的输入面） */
  mappedItems: number;
  /** 扫到的**待补订单行**（卡在"没归款 / 占位色"上；与回填的筛选条件同口径） */
  candidateRows: number;
  /** 其中**能被映射补上**的行（`dryRun` 时是按解析预估，真跑时是实际结果） */
  fixableRows: number;
  /** 真正写进库的行（`dryRun` 恒 0） */
  fixedRows: number;
}

function reassignCore(
  itemIds: string[],
  opts?: {
    colors?: string[];
    /** 只算不写：界面要先报"有多少行能补"，不能为了报数就真改库 */
    dryRun?: boolean;
  },
): { candidateRows: number; fixableRows: number; fixedRows: number } {
  const none = { candidateRows: 0, fixableRows: 0, fixedRows: 0 };
  if (!productSchemaReady()) return none;
  const want = new Set(
    (Array.isArray(itemIds) ? itemIds : []).map((s) => String(s ?? '').trim()).filter(Boolean),
  );
  if (!want.size) return none;
  const extraColors = [
    ...new Set(
      (Array.isArray(opts?.colors) ? opts.colors : [])
        .map((s) => String(s ?? '').trim())
        .filter((s) => s && s !== MAPPED_FALLBACK_COLOR),
    ),
  ];
  // ⚠️ 比较用 `LOWER(TRIM(x))` 而不是精确相等：库里那串是当初落库时 trim 过的采集原文，
  //    与字典里的 `from` 可能差大小写/首尾空格；对不上就"回填了却没变化"，用户只看到没反应。
  //    （内部空格/全角差异没有在 SQL 里折叠 —— 那种写法在真实库里没出现过，且下面
  //    `autoAssignByMap` 自己还有 alias_key 级的判断，漏网只会少改几行、不会改错。）
  const colorCond = extraColors.length
    ? ` OR LOWER(TRIM(sc.color)) IN (${extraColors.map(() => '?').join(',')})`
    : '';

  const rows = dbQuery<{
    image_id: number;
    shop: string;
    color: string;
    raw_fields: string;
    cur_id: number | null;
  }>(
    `SELECT oi.image_id, o.shop, oi.color, oi.raw_fields, i.style_color_id AS cur_id
       FROM oi_order_items oi
       JOIN oi_orders o ON o.id = oi.order_id
       JOIN oi_images i ON oi.image_id = i.id
       LEFT JOIN oi_style_colors sc ON sc.id = i.style_color_id
      WHERE oi.image_id IS NOT NULL
        AND (i.style_color_id IS NULL OR sc.color = ?${colorCond})`,
    [MAPPED_FALLBACK_COLOR, ...extraColors.map((c) => c.toLowerCase().trim())],
  );
  const d = getDb();
  const stats = { candidateRows: 0, fixableRows: 0, fixedRows: 0 };
  for (const r of rows) {
    let rawFields: Record<string, string> = {};
    try {
      const v = JSON.parse(String(r.raw_fields ?? '{}'));
      if (v && typeof v === 'object') rawFields = v as Record<string, string>;
    } catch {
      continue; // 一条脏 raw_fields 不该毁掉整批回填
    }
    const { itemId } = extractSkuFields(rawFields);
    if (!itemId || !want.has(itemId)) continue;
    stats.candidateRows += 1;
    if (opts?.dryRun) {
      // 只算不写：`autoAssignByMap` 是"命中就写"，所以"解析得出映射"等价于"本该能补上"。
      // 真跑那条分支不看这个预判，仍以**写完之后实际变没变**为准（两处口径不会互相替代）。
      if (resolveOrderSku({ shop: r.shop, itemId })) stats.fixableRows += 1;
      continue;
    }
    const imageId = Number(r.image_id);
    const beforeId = Number(r.cur_id) || 0;
    autoAssignByMap({
      imageId,
      shop: String(r.shop ?? ''),
      color: String(r.color ?? ''),
      rawFields,
    });
    const after = d.prepare(`SELECT style_color_id FROM oi_images WHERE id = ?`).get(imageId) as
      | { style_color_id: number | null }
      | undefined;
    const afterId = Number(after?.style_color_id) || 0;
    // 判据是**换没换**而不是"有没有值"：补色前的占位色也有 id，拿"非空"计数会把没动的行也报成处理过
    if (afterId && afterId !== beforeId) {
      stats.fixedRows += 1;
      stats.fixableRows += 1;
    }
  }
  return stats;
}

/**
 * **全库重放**：把所有 `confirmed` 映射再套一遍现存订单。
 *
 * 为什么需要它（而 `reassignOrdersByItemIds` 不够）：那条是"配映射时顺手回填该商品"，
 * 只在**人工核对/新建映射**那一刻跑。真实库里存在另一类漏网 —— 映射是自己先有的，
 * 订单却是后来（或更早）以别的路径进的，**没有任何人再触发过那个商品**，于是
 * 「映射在、订单没吃到」永远停在那儿，界面上和"这根商品没配过映射"长得一模一样。
 *
 * 边界与单商品回填**完全同一份实现**（`reassignCore`）：只碰"没归款 / 占位色"的行，
 * 挂在真实颜色上的一律不动 —— 全库重放最怕的就是顺手改判历史结论。
 *
 * `dryRun` 供界面先报数（"有 6 行能补"）：报数不能以**改库**为代价，
 * 否则"看一眼"就等于"悄悄执行一次写入"。
 */
export function replaySkuMappings(opts: { dryRun?: boolean } = {}): ReplayStats {
  const empty: ReplayStats = { mappedItems: 0, candidateRows: 0, fixableRows: 0, fixedRows: 0 };
  if (!productSchemaReady()) return empty;
  const ids = [
    ...new Set(
      dbQuery<{ item_id: string }>(
        `SELECT DISTINCT item_id FROM pl_shop_sku
          WHERE status = 'confirmed' AND item_id <> '' AND ${skuMappingSql()}`,
      )
        .map((r) => String(r.item_id ?? '').trim())
        .filter(Boolean),
    ),
  ];
  if (!ids.length) return empty;
  return { mappedItems: ids.length, ...reassignCore(ids, { dryRun: !!opts.dryRun }) };
}

// ---- ⭐ 人工核对的**回流**：订单 → 「商品ID → 款 + 色」映射 ----

/** 回流结果（`assignOrderStyle` 的附加产物；界面据此说清"记住了什么 / 为什么没记住"） */
export type SkuBackfillStatus =
  /** 写进映射了（并顺带回填了存量订单） */
  | 'written'
  /** 映射里已经是这个结论：不重复写（避免把既有行的 source/note 刷掉） */
  | 'already'
  /** 该商品已有**别的**产品的映射：不动它（改绑的影响面是它所有订单） */
  | 'conflict'
  /** 订单里没有商品ID列/值为空：这条链路无从查起 */
  | 'noItemId'
  /** 店铺还没归一：没有平台，写进去会把不同平台的同名店并到一起 */
  | 'shopUnresolved'
  /** 产品库里没有这个款编码（老库还没跑交接） */
  | 'noProduct'
  /** 写库时抛了（约束冲突之类）；归属本身不受影响 */
  | 'failed'
  /** 产品域还没建表 */
  | 'disabled';

export interface SkuBackfillOutcome {
  status: SkuBackfillStatus;
  /** 本次顺带处理的**存量**订单行数（新归款 + 补色都算；不含刚点名的那一单） */
  reassigned: number;
  /** 真正写进映射的颜色；`''` = 只记到款级（没有可信的颜色可用） */
  spec: string;
  /** `conflict` 时对方的产品编码——让界面能说清"没覆盖掉谁" */
  conflictCode: string;
}

/**
 * ⭐ 人工核对的**回流**：把"这个商品属于哪个款、什么色"写回**确定性层**
 * （`pl_shop_sku`：`(平台, 店铺, 商品ID) → 款 + 色`）。
 *
 * **为什么必须有**：归款是**写时触发**的（`autoAssignByMap`，订单落库那一刻跑一次），而人工核对
 * 写的是**指纹 → 款**（`orderStyleAssign`）。指纹只覆盖"图长得一样"的那些单，**商品ID**才覆盖
 * "同一件商品的每一单"。不回流的后果是：用户把某个商品判对 10 次，第 11 条订单**照样进待核对队列**
 * —— 人工工作量不随时间递减。而真实库上 42 行订单的商品ID **去重后只有 17 个**：十几条映射
 * 就能覆盖绝大多数行，这是"更方便归类"里最省力的那一步（顺序本来就是 映射 → 指纹 → 模型）。
 *
 * **三条边界**（都为了"不替人下结论 / 不放大单次判断的影响面"）：
 *
 *   · **只写、不覆盖**：该 `(店铺, 商品ID)` 已有生效映射且指向**别的产品**时一律跳过并回报
 *     `conflict`。理由不是"保守"，是**影响面不对等**：在这里顺手改绑，等于让那个商品
 *     **所有**（含历史）订单一起改判，而用户此刻只看了眼前这一单。真要改绑请走
 *     「货与成本 › 商品ID 映射」——那里配完会说清影响了几行。
 *   · **颜色只填不猜**：颜色为空 / 是占位（`未分类`）时写款级 `'*'`（= 色从订单取），
 *     不把"还没定"固化成结论。已经有同产品同色的映射时更不该重写（`already`）。
 *   · **失败不外抛**：这是"顺手记住"的附加动作，绝不能让它把**已经提交**的"归属已改"
 *     报成失败 ⇒ 整段吞异常，调用方看到 `status: 'failed'`，归属照常生效。
 *
 * 写入成功后**顺带回填存量**（`reassignOrdersByItemIds`）：同一商品的历史订单（还没归款的、
 * 以及还挂在「未分类」占位色上的）当场一起归到位 —— 没有这一步，"已经记住了"在界面上看不出
 * 任何变化，用户不会信它真的发生了。
 *
 * @returns 见 `SkuBackfillOutcome`；**任何分支都不抛**
 */
export function skuBackfillFromOrder(input: {
  orderId: number;
  /** 目标款编码（`oi_styles.code`，与产品库同锚点） */
  styleCode: string;
  /** 本次核对认定的颜色（**原文**，与写进款色的那份同值——两处归一不一致会拆出两个款色） */
  color: string;
}): SkuBackfillOutcome {
  const none: SkuBackfillOutcome = { status: 'disabled', reassigned: 0, spec: '', conflictCode: '' };
  try {
    if (!productSchemaReady()) return none;
    const order = dbGet<{ shop: string; raw_fields: string }>(
      `SELECT o.shop, oi.raw_fields FROM oi_order_items oi JOIN oi_orders o ON o.id = oi.order_id WHERE oi.id = ?`,
      [input.orderId],
    );
    if (!order) return { ...none, status: 'noItemId' };

    let rawFields: Record<string, string> = {};
    try {
      const v = JSON.parse(String(order.raw_fields ?? '{}'));
      if (v && typeof v === 'object') rawFields = v as Record<string, string>;
    } catch {
      rawFields = {}; // 一条脏 raw_fields 只让这一单回流不了，不该往外抛
    }
    const { itemId } = extractSkuFields(rawFields);
    if (!itemId) return { ...none, status: 'noItemId' };

    const shop = resolveShopRef(order.shop, itemId);
    if (!shop.shopId) return { ...none, status: 'shopUnresolved' };

    const productId = productIdByCode(input.styleCode);
    if (!productId) return { ...none, status: 'noProduct' };

    const color = String(input.color ?? '').trim();
    // 占位色不是"颜色"：写进映射会把兜底名固化成该商品的颜色（以后再也回不去"从订单取"）
    const spec = color && color !== MAPPED_FALLBACK_COLOR ? color : '';

    const existing = resolveOrderSku({ shop: order.shop, itemId });
    if (existing && existing.productId !== productId) {
      return { ...none, status: 'conflict', conflictCode: existing.productCode };
    }
    // 已命中同产品：只有"能补上颜色"才值得再写一行（`existing.spec` 非空时带色行优先，
    // 再写一行款级不会有任何效果，只会让映射表变脏）
    if (existing && (!spec || existing.spec === spec)) {
      return { ...none, status: 'already', spec: existing.spec };
    }

    const out = upsertSkuMappings([
      {
        platform: shop.platform,
        shopId: shop.shopId,
        itemId,
        spec: spec || '*',
        productId,
        status: 'confirmed',
        note: '归类核对页点名某款时记住',
      },
    ]);
    if (out.failed.length) return { ...none, status: 'failed' };

    return { status: 'written', reassigned: reassignOrdersByItemIds([itemId]), spec, conflictCode: '' };
  } catch {
    return { ...none, status: 'failed' };
  }
}

/** 插入一条订单明细（一 SKU），返回明细行 id。拆表后：主表按 `order_no` upsert、明细逐行插。 */
export function insertOrder(rec: OrderRecord): number {
  const d = getDb();
  const orderNo = String(rec.orderNo ?? '').trim();
  // 拆表后主表 `order_no` 是 NOT NULL UNIQUE：没有订单号就**没有主表行可挂**。
  // 导入侧在解析层已跳过缺单号的行（`importSheet.ts`），走到这里说明调用方有 bug ——
  // 明确报错，别写 NULL 占位（那必然撞 NOT NULL，报出来的是一句看不懂的 SQLite 错）。
  if (!orderNo) throw new Error('订单号为空：这一行不能入库（导入侧应先跳过缺订单号的行）');

  const header = d.prepare(`SELECT id, source FROM oi_orders WHERE order_no = ?`).get(orderNo) as
    | { id: number; source: string }
    | undefined;
  // 同一订单号只容一个来源（主表 UNIQUE(order_no)）。采集通道重推是**整单替换**：
  // 导入若往采集单里追加一行，下一次重推会把它删掉，且导入/采集两套金额口径会互相污染。
  // （采集在扩展侧已下线，这里挡的是历史采集单与将来重开采集的撞车。）
  if (header && header.source !== 'import') {
    throw new Error(`订单 ${orderNo} 已由采集通道写入，不能再按导入追加`);
  }
  // 幂等：(订单号, 图片) 已存在则跳过，避免重复导入同一 Excel 产生重复行
  if (header) {
    // ⚠️ 用 `IS ?` 而不是 `= ?`：无图订单的 `image_id` 是 NULL，`= NULL` 永远不成立 →
    // 重导同一份报表会不断插重复行（幂等当场失效）。
    const existing = d
      .prepare(`SELECT id FROM oi_order_items WHERE image_id IS ? AND order_id = ?`)
      .get(rec.imageId, header.id);
    if (existing) {
      const id = Number((existing as { id: number }).id);
      // 幂等重入**也要再试一次归款**：映射很可能是这条订单之后才人工确认的，
      // 不重试的话「先导订单、后确认映射」的人永远等不到自动命中（验收②的字面场景）。
      autoAssignByMap(rec);
      syncOrderClassificationFromImage(rec.imageId);
      return id;
    }
  }
  const status: OrderStatus = rec.status === 'shipped' ? 'shipped' : 'pending';
  // 金额/状态/时点在**入库这一刻**从 raw_fields 提成正式列（口径见 `electron/orderMoney.ts`）——
  // 放在主进程做，岛侧无需改，也就不必发版；其余 30 余列留在 raw_fields 里保真、随时可提。
  const m = extractOrderMoney(rec.rawFields);
  // 颜色同理：报表**没有颜色列**，颜色藏在「产品信息」的 `(产品属性:Color:5,...)` 里。
  const color = String(rec.color ?? '').trim() || parseOrderPropsColor(rec.rawFields);
  // 件数：**落库那一刻**从报表块里定下来（`(商品数量:2 piece)`），不再让下游各算一遍。
  const qty = parseOrderQty(rec.rawFields);

  let itemId = 0;
  dbTransaction(() => {
    // 主表：order_no 不存在才插（同一单多行，第一次插主表、后续复用）
    let headerId = header ? Number(header.id) : 0;
    if (!headerId) {
      const hr = d
        .prepare(
          `INSERT INTO oi_orders (order_no, shop, order_time, source, amount_cents, vat_cents, ddp_cents, tax_platform, biz_status, ship_time)
           VALUES (?, ?, ?, 'import', ?, ?, ?, ?, ?, ?)`,
        )
        .run(orderNo, rec.shop, rec.orderTime ?? '', m.amountCents, m.vatCents, m.ddpCents, m.taxPlatformRaw, m.bizStatus, m.shipTime);
      headerId = Number(hr.lastInsertRowid);
    }
    const ir = d
      .prepare(
        `INSERT INTO oi_order_items (order_id, image_id, size, raw_fields, category, color, logo, status, qty)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        headerId,
        rec.imageId,
        rec.size,
        JSON.stringify(rec.rawFields),
        rec.category,
        color,
        rec.logo,
        status,
        qty,
      );
    itemId = Number(ir.lastInsertRowid);
  });
  autoAssignByMap(rec);
  // 图**在导入前**就可能已有结论（识别过 / 人工归过色 / 上次归款写过）⇒ 补一次投影，
  // 不依赖 autoAssignByMap 这一趟是否命中（它未命中时什么都不做）。
  syncOrderClassificationFromImage(rec.imageId);
  return itemId;
}

/**
 * 把若干订单号**归属到某店铺**（写 `oi_orders.shop`）。
 *
 * 为什么需要它：实测 AE 的「订单列表/订单明细」导出**按店铺导出、报表里没有店铺列**
 * （只有"店铺优惠"；岛侧"店铺列"是手选的，对这类报表选不出来）→ 店铺只能**在导入后由人指定**。
 * 这里写的是店铺**名称原文**：`oi_orders.shop` 与 `purchase_sources.shop` 一样是
 * 自由文本，归一由 `sk_name_map` 在**查询时**旁挂完成（G2：历史文本不改写）。
 *
 * 一个订单号的多行（拆行后的多商品）会一起更新；`order_no` 为空的行不动。
 * @returns updated = 实际改动的行数
 */
export function assignShopToOrders(orderNos: string[], shopName: string): { updated: number } {
  const d = initDb();
  const shop = String(shopName ?? '').trim();
  const nos = [...new Set((Array.isArray(orderNos) ? orderNos : []).map((x) => String(x ?? '').trim()))]
    .filter(Boolean)
    .slice(0, 2000);
  if (!shop || !nos.length) return { updated: 0 };
  const stmt = d.prepare(`UPDATE oi_orders SET shop = ? WHERE order_no = ? AND shop <> ?`);
  let updated = 0;
  dbTransaction(() => {
    for (const no of nos) updated += stmt.run(shop, no, shop).changes;
  });
  return { updated };
}

/**
 * **采集通道写入主干**（C1 合并的写侧）：一单多行（每行一个商品），整体幂等替换。
 *
 * 为什么由**调用方**把金额折算好再进来：采集帧是**原币**（`ae_rates` 才认），而汇率属 ae 域的表 ——
 * 让 order-db 去读别的域的表就是跨域耦合（本层只认 `oi_orders` 的语义，金额一律 CNY 分）。
 * 调用方（`ae-db.upsertOrderBatch`）负责 `(商品金额 + 买家付运费) × 汇率 × 100` 与规格串解析。
 *
 * 幂等：同一订单号**已存在 collect 行就整单删掉重插**（重推一帧 = 更新那一单，与导入侧的"同单同图不重复插"同理）。
 * `image_id` 恒 NULL（采集帧没有主图）—— 这正是本轮把该列改成可空的原因。
 *
 * **通道互斥**：同一订单号若已被导入通道写入，这里**拒绝覆盖**（主表 `UNIQUE(order_no)` 只容一个来源）。
 * 导入行是逐行追加、采集是整单替换 —— 混在一起会让下次重推删掉导入的行，而且两边的金额口径不同。
 * **重推会重置这一单的包裹**：明细 id 全部换新，旧包裹留着就是空壳（见下方实现注释）。
 */
export interface CollectedOrderInput {
  orderNo: string;
  orderTime: string;
  bizStatus: string;
  /** 店铺原文（采集帧常为空 —— 空就是空，不猜） */
  shop?: string;
  /** **整单**收入（CNY 分，未扣退款）；`null` = 缺汇率。每行都记整单金额，按件数分摊在算账层做 */
  amountCents: number | null;
  /** 采集帧原文（保真放进 `raw_fields`；键名前缀 `采集` 以免与报表列名族相撞） */
  rawFields?: Record<string, string>;
  lines: {
    itemId: string;
    qty: number;
    color: string;
    size: string;
  }[];
}

export function upsertCollectedOrder(input: CollectedOrderInput): { rows: number; replaced: boolean } {
  const d = initDb();
  const orderNo = String(input?.orderNo ?? '').trim().slice(0, 64);
  if (!orderNo) throw new Error('upsertCollectedOrder: 订单号不能为空');
  const lines = Array.isArray(input?.lines) ? input.lines : [];
  const rawJson = JSON.stringify(input?.rawFields ?? {});
  const bizStatus = String(input?.bizStatus ?? '').slice(0, 64);
  const orderTime = String(input?.orderTime ?? '').slice(0, 32);
  const shop = String(input?.shop ?? '').slice(0, 120);
  const amount = input?.amountCents === null || input?.amountCents === undefined ? null : Math.round(Number(input.amountCents));

  let replaced = false;
  let rows = 0;
  dbTransaction(() => {
    const existed = d
      .prepare(`SELECT id, source FROM oi_orders WHERE order_no = ? LIMIT 1`)
      .get(orderNo) as { id: number; source: string } | undefined;
    // 通道互斥：导入单是逐行追加（一 SKU 一行、金额来自报表），采集是整单替换。
    // 采集若覆盖导入单，重推会把导入的行全删掉，而且两套金额口径会落在同一个 order_no 上。
    if (existed && existed.source !== 'collect') {
      throw new Error(`订单 ${orderNo} 已由导入通道写入，采集不能整单替换它`);
    }
    if (existed) {
      // 包裹挂在明细行上（`parcel_lines.order_item_id`）。整单替换会换掉全部明细 id：
      // 不先清包裹，它们就变成「0 条明细的空壳」，还继续参与 `parcelTotals` 的运费/重量汇总。
      // 重采集 = 这一单的装箱作废，明确连包裹一起清掉（包裹表属 B2，旧库可能尚未建）。
      if (tableExists('parcels')) {
        d.prepare(
          `DELETE FROM parcel_lines WHERE parcel_id IN (SELECT id FROM parcels WHERE order_no = ?)`,
        ).run(orderNo);
        d.prepare(`DELETE FROM parcels WHERE order_no = ?`).run(orderNo);
      }
      // 显式删明细**不靠 CASCADE**：`PRAGMA foreign_keys` 是连接级开关（脚本/将来换驱动未必开），
      // 关掉时只删主表会留下孤儿明细，重插后同一单出现两套行。
      d.prepare(`DELETE FROM oi_order_items WHERE order_id = ?`).run(existed.id);
      d.prepare(`DELETE FROM oi_orders WHERE id = ?`).run(existed.id);
      replaced = true;
    }
    // 主表：一单一行（订单级字段）
    const h = d
      .prepare(
        `INSERT INTO oi_orders (order_no, shop, order_time, source, amount_cents, biz_status)
         VALUES (?, ?, ?, 'collect', ?, ?)`,
      )
      .run(orderNo, shop, orderTime, amount, bizStatus);
    const headerId = Number(h.lastInsertRowid);
    // 明细：逐行插（一单零行也插一行，订单数不能凭空少；件数按 1，不猜 0）
    const ins = d.prepare(
      `INSERT INTO oi_order_items (order_id, image_id, size, raw_fields, color, qty)
       VALUES (?, NULL, ?, ?, ?, ?)`,
    );
    for (const l of lines.length ? lines : [{ itemId: '', qty: 1, color: '', size: '' }]) {
      ins.run(
        headerId,
        String(l?.size ?? '').slice(0, 64),
        rawJson,
        String(l?.color ?? '').slice(0, 64),
        Math.max(1, Math.round(Number(l?.qty) || 1)),
      );
      rows += 1;
    }
  });
  return { rows, replaced };
}

/** 最近订单列表（联图片指纹/路径），供界面明细展示 */
export function listOrders(limit = 500): OrderRecord[] {
  return listOrdersPage({ limit }).rows;
}

/** 按订单算**运费/成本**所需的**最小原始行**（SHIPPING_RATE_ISLAND_PLAN §8）：
 *  - 与 listOrdersPage 不同，这里**带 raw_fields**（收货国家 / 商品ID 都在里面）；
 *  - 另带 `shop` / `order_time` / `style_code` / `style_color`（2026-09-29 加）：
 *    前两者是"按店铺/按日"聚合的维度，后两者是**成本侧**的键（C2 起成本直接读行级两字段：
 *    `actual_cost_cents` 实付 > `cost_cents` 预估）；
 *  - 仍**只回最小列**（不含订单明细的大字段），提取结果（国家/商品ID/克重/成本）收敛后再回渲染层，大载荷不过岛；
 *  - 只读，不暴露任何写能力。
 *
 * ⚠️ `opts.importDate`（`yyyy-mm-dd`，本地时区）是**「发货台」的每日口径**：一天一导（导出
 *    "昨天 → 导出时点"的全部订单，中间追加的也算同一天），故按**导入日**筛，而不是按 `order_time`
 *    （下单日）—— 用户关心的是"今天我导进来的这一批"，昨天下的单今天导也该在今天这批里。 */
export function shippingRows(
  limit = 500,
  opts: {
    source?: 'all' | 'import' | 'collect';
    importDate?: string;
    /** 只看订单**发生月**（`yyyy-mm`）；记账的营收占比按条目所属月份取数（P2） */
    period?: string;
  } = {},
): {
  id: number;
  orderNo: string;
  /** 摄取通道（主干 `source`） */
  source: 'import' | 'collect';
  /** 件数真值（采集通道写入；`NULL` = 不知道，导入侧由渲染层解析块内数量） */
  qty: number | null;
  shop: string;
  /** 店名归一键（`toNameKey`）—— 订单只存原文，按店铺身份聚合（营收占比）靠它对齐 `sk_shops` */
  shopKey: string;
  orderTime: string;
  styleCode: string;
  styleColor: string;
  /** 款色**身份**（`oi_style_colors.id`；0 = 未归类）—— 与 `purchase_sources.order_item_id`
   *  同属"订单行的身份"，逐行覆盖度靠它拼台账键（2026-10-22） */
  styleColorId: number;
  /** 颜色 / 尺码（SKU 粒度 = 款×色×码；拣货与统计要用） */
  color: string;
  size: string;
  /** 供应商（经 `pl_products.supplier_id → suppliers`）；未识别款或未填厂家时为空 */
  supplierId: number;
  supplierName: string;
  /** ---- 主线（算钱 + 拣货）真正读的列（金额单位：分；**null = 报表里没有**，不是 0）----
   * 精简（2026-09-30，用户原则"非必要先删、必要再加"）：货值/买家运费/店铺优惠/平台补贴/币种/
   * 业务模式/付款·收货时点一律不再投影（**零读者**）；原始整行仍在 `rawFields` 里保真，要加回来随时可提取。 */
  amountCents: number | null;
  vatCents: number | null;
  ddpCents: number | null;
  taxPlatform: string;
  bizStatus: string;
  /** ---- 快照列（阶段 A4/A5；**NULL = 还没钉过**，读方自己回落，别折成 0）----
   * `weightG`：归类核对「确认无误」时按款色码取的 SKU 克重（`snapshotOrderWeights`）；
   * `costCents`：归类确认时按当时产品当前价钉的**进价（预估）**（`snapshotOrderCosts`）；
   * `actualCostCents`：拿货落账后回写的**实际进价（实付真值）**（`syncOrderRowCosts`）。
   * 利润取数 `actualCostCents > 0 ? actual : costCents > 0 ? estimate : none`，见 `lib/orderCost.ts`。 */
  weightG: number | null;
  costCents: number | null;
  actualCostCents: number | null;
  rawFields: Record<string, string>;
}[] {
  const n = Math.min(Math.max(Number(limit) || 500, 1), 2000);
  // 摄取通道过滤（`all` = 两条都看 → 不加条件，也不占参数位）
  const want = opts?.source === 'import' || opts?.source === 'collect' ? opts.source : 'all';
  const conds: string[] = [];
  const args: (string | number)[] = [];
  if (want !== 'all') {
    conds.push(`o.source = ?`);
    args.push(want);
  }
  // 「导入日」过滤（`yyyy-mm-dd`，本地时区）：`created_at` 存的是 `datetime('now','localtime')`
  // ⇒ 取日期部分与传入的那天比。形状在主进程 handler 已收窄，这里再兜一次（直调本函数的老路径）。
  const importDate =
    typeof opts?.importDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.importDate)
      ? opts.importDate
      : '';
  if (importDate) {
    conds.push(`date(o.created_at) = ?`);
    args.push(importDate);
  }
  // 「订单发生月」过滤（`yyyy-mm`）：`order_time` 由导入/采集写入，实测形如
  // `2026-10-03 12:56:28`；分隔符兼容 `/` 与 `.`（与 `lib/orderCost.ts` 的 `dateKey` 同口径），
  // 认不出月份的行**不进该月**（营收占比不把无日期订单摊到某个头上）。
  const period =
    typeof opts?.period === 'string' && /^\d{4}-\d{2}$/.test(opts.period) ? opts.period : '';
  if (period) {
    conds.push(`substr(replace(replace(o.order_time, '/', '-'), '.', '-'), 1, 7) = ?`);
    args.push(period);
  }
  args.push(n);
  // 款编码走**识别链** `oi_images.style_color_id → oi_style_colors → oi_styles`（与
  // `purchase-db.outstanding()` 同一套 JOIN，口径只留一份）。一律 **LEFT JOIN**：
  // 未识别的订单行必须仍然回得来 —— 丢了行，"缺的是哪一环"就看不出来了。
  // 供应商**可选**：`suppliers` 表属采购域、可能还没建（各域表按域懒建）→ 先探再拼 JOIN，
  // 缺表时回落空串（降级而非抛 `no such table`，与 product-db 的 `shopLabelMap` 同策略）。
  const hasSupplier = tableExists('suppliers') && tableExists('pl_products');
  const supplierSel = hasSupplier
    ? `COALESCE(p.supplier_id, 0) AS supplier_id, COALESCE(sup.name, '') AS supplier_name`
    : `0 AS supplier_id, '' AS supplier_name`;
  const supplierJoin = hasSupplier
    ? `LEFT JOIN pl_products p ON p.code = s.code
       LEFT JOIN suppliers sup ON sup.id = p.supplier_id`
    : '';
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT oi.id, o.order_no, o.shop, o.order_time, oi.raw_fields, oi.color, oi.size,
            o.amount_cents, o.vat_cents, o.ddp_cents, o.tax_platform, o.biz_status, o.source, oi.qty,
            oi.weight_g, oi.cost_cents, oi.actual_cost_cents,
            COALESCE(s.code, '') AS style_code, COALESCE(sc.color, '') AS style_color,
            COALESCE(sc.id, 0) AS style_color_id,
            ${supplierSel}
     FROM oi_order_items oi
     JOIN oi_orders o ON o.id = oi.order_id
     LEFT JOIN oi_images i ON oi.image_id = i.id
     LEFT JOIN oi_style_colors sc ON i.style_color_id = sc.id
     LEFT JOIN oi_styles s ON sc.style_id = s.id
     ${supplierJoin}
     ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
     ORDER BY oi.id DESC LIMIT ?`,
    args,
  );
  /** 金额列：NULL 原样返回（**不要** ?? 0 —— 那会把"报表没有"变成"金额为零"） */
  const money = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return rows.map((r) => ({
    id: Number(r.id ?? 0),
    orderNo: String(r.order_no ?? ''),
    source: String(r.source ?? 'import') === 'collect' ? 'collect' : 'import',
    qty: r.qty === null || r.qty === undefined ? null : Number(r.qty),
    shop: String(r.shop ?? ''),
    shopKey: toNameKey(String(r.shop ?? '')),
    orderTime: String(r.order_time ?? ''),
    styleCode: String(r.style_code ?? ''),
    styleColor: String(r.style_color ?? ''),
    styleColorId: Number(r.style_color_id ?? 0) || 0,
    color: String(r.color ?? ''),
    size: String(r.size ?? ''),
    supplierId: Number(r.supplier_id ?? 0) || 0,
    supplierName: String(r.supplier_name ?? ''),
    amountCents: money(r.amount_cents),
    vatCents: money(r.vat_cents),
    ddpCents: money(r.ddp_cents),
    taxPlatform: String(r.tax_platform ?? ''),
    bizStatus: String(r.biz_status ?? ''),
    weightG: money(r.weight_g),
    costCents: money(r.cost_cents),
    actualCostCents: money(r.actual_cost_cents),
    rawFields: safeJson(String(r.raw_fields ?? '')),
  }));
}

/** 订单列表（分页 + corrected 过滤 + 关键字搜索）：
 *  - 列表不携带 o.raw_fields（整行 Excel 原始字段体积大且界面不消费），显著降低 IPC 传输；
 *  - 返回 { rows, total } 供渲染层同步总数/分页；
 *  - search 匹配 单号/店铺/分类/颜色/logo/款编码/款名/款色，供纠正页/明细页服务端搜索。 */
export function listOrdersPage(
  opts: { offset?: number; limit?: number; corrected?: boolean; search?: string; importDate?: string } = {},
): {
  rows: OrderRecord[];
  total: number;
} {
  const offset = Math.max(Number(opts.offset ?? 0) || 0, 0);
  const limit = Math.min(Math.max(Number(opts.limit ?? 500) || 0, 1), 2000);
  const conds: string[] = [];
  const params: Array<string | number> = [];
  if (opts.corrected === undefined) {
    // 不过滤
  } else if (opts.corrected) {
    conds.push('oi.corrected = 1');
  } else {
    conds.push('oi.corrected = 0');
  }
  // 「导入日」过滤（与 `shippingRows` 同口径）：`created_at` 是 `datetime('now','localtime')`
  const importDate =
    typeof opts.importDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(opts.importDate)
      ? opts.importDate
      : '';
  if (importDate) {
    conds.push(`date(o.created_at) = ?`);
    params.push(importDate);
  }
  const search = typeof opts.search === 'string' ? opts.search.trim().slice(0, 100) : '';
  // D1：款名的搜索目标随权威表一起换到 pl_products（搜索走的是展示名，不是遗留列）
  const n = styleNameJoin();
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conds.push(
      `(o.order_no LIKE ? ESCAPE '\\' OR o.shop LIKE ? ESCAPE '\\' OR oi.category LIKE ? ESCAPE '\\'
        OR oi.color LIKE ? ESCAPE '\\' OR oi.logo LIKE ? ESCAPE '\\'
        OR s.code LIKE ? ESCAPE '\\' OR ${n.name} LIKE ? ESCAPE '\\' OR sc.color LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like, like, like, like, like, like);
  }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  const total = Number(
    dbQuery<{ n: number }>(
      `SELECT COUNT(*) AS n FROM oi_order_items oi
       JOIN oi_orders o ON o.id = oi.order_id
       LEFT JOIN oi_images i ON oi.image_id = i.id
       LEFT JOIN oi_style_colors sc ON i.style_color_id = sc.id
       LEFT JOIN oi_styles s ON sc.style_id = s.id
       ${n.join}
       ${where}`,
      params,
    )[0]?.n ?? 0,
  );
  // ⚠️ 这里**必须**带上 `oi.raw_fields`：`OrderRecord.itemId` 由它推出来（见 `mapOrderRow`），
  //    而归类核对页要靠 itemId 标出"本页哪几行是同一个商品"。之前漏了它，`rawFields` 恒为 `{}`
  //    —— 那是个静默陷阱：类型上写着"原始整行"，用的人读到的却是空对象。
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT oi.id, oi.image_id, o.order_no, o.shop, oi.size, o.order_time, oi.raw_fields,
            oi.category, oi.color, oi.logo, oi.material, oi.status, oi.corrected, oi.created_at,
            i.fingerprint, i.source_url, i.local_path, i.result_json,
            s.code AS style_code, ${n.name} AS style_name, sc.color AS style_color
     FROM oi_order_items oi
     JOIN oi_orders o ON o.id = oi.order_id
     LEFT JOIN oi_images i ON oi.image_id = i.id
     LEFT JOIN oi_style_colors sc ON i.style_color_id = sc.id
     LEFT JOIN oi_styles s ON sc.style_id = s.id
     ${n.join}
     ${where} ORDER BY oi.id DESC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  return { rows: rows.map(mapOrderRow), total };
}

/** 订单字段纠正（数据纠正步骤）：
 *  - 更新订单行的 款式/颜色/logo（材质已从 UI 移除，不传则保留原值）；
 *  - reclassify=true 且提供 fingerprint 时，按新款指纹重新匹配款式/款色并挂接图片（改款/改色后自动归位）。 */
export function updateOrder(input: UpdateOrderInput): { styleCode?: string; styleColorCode?: string } {
  const d = getDb();
  return dbTransaction(() => {
    const order = d.prepare(`SELECT image_id FROM oi_order_items WHERE id = ?`).get(input.id) as
      | { image_id: number }
      | undefined;
    if (!order) throw new Error(`订单不存在: id=${input.id}`);
    let reassigned: { styleCode?: string; styleColorCode?: string } = {};
    if (input.reclassify && input.fingerprint) {
      // 重归类前记录图片原归属款（供空壳原款清理使用）
      const prevImg = d.prepare(`SELECT style_color_id FROM oi_images WHERE id = ?`).get(order.image_id) as
        | { style_color_id: number | null }
        | undefined;
      let prevStyleId: number | undefined;
      if (prevImg?.style_color_id) {
        const prevSc = d
          .prepare(`SELECT style_id FROM oi_style_colors WHERE id = ?`)
          .get(prevImg.style_color_id) as { style_id: number } | undefined;
        prevStyleId = prevSc?.style_id;
      }
      const resolved = resolveStyle({
        fingerprint: input.fingerprint,
        category: input.category,
        features: input.features ?? [],
        color: input.color,
      });
      setImageStyleColor(order.image_id, resolved.styleColorId);
      reassigned = { styleCode: resolved.styleCode, styleColorCode: resolved.styleColorCode };
      // 原款若因此变空壳（无图无单）→ 指纹迁入新款并删除，避免空壳款占用主指纹误导后续识别
      if (prevStyleId && prevStyleId !== resolved.styleId) mergeOrphanStyle(prevStyleId, resolved.styleId);
    }
    dbRun(
      // `weight_g` / `cost_cents` = NULL：这一行的款/色被改写了 ⇒ 旧快照作废（下面立刻按新归属重钉一次；
      // 钉不上就留 NULL 交给缺口统计 —— **不保留旧值**，那会让利润按错色的重量/价算）。
      // `actual_cost_cents` **不动**：那是拿货实付的历史事实，不属于"归类"这一层可以抹掉的推导值。
      `UPDATE oi_order_items SET category = ?, color = ?, logo = ?, corrected = 1, weight_g = NULL, cost_cents = NULL WHERE id = ?`,
      [input.category, input.color, input.logo, input.id],
    );
    snapshotOrderWeights([input.id]);
    snapshotOrderCosts([input.id]);
    // 未 reclassify 时也返回当前归属款编码（渲染层改款式名等场景需要定位款编码）
    if (!reassigned.styleCode) {
      const cur = d
        .prepare(
          `SELECT s.code AS style_code, sc.code AS style_color_code
           FROM oi_order_items oi
           LEFT JOIN oi_images i ON oi.image_id = i.id
           LEFT JOIN oi_style_colors sc ON i.style_color_id = sc.id
           LEFT JOIN oi_styles s ON sc.style_id = s.id
           WHERE oi.id = ?`,
        )
        .get(input.id) as { style_code?: string; style_color_code?: string } | undefined;
      if (cur?.style_code) {
        reassigned = { styleCode: cur.style_code, styleColorCode: cur.style_color_code };
      }
    }
    return reassigned;
  });
}

/** 更新订单发货状态（未发货/已发货互切，订单明细行内操作） */
export function updateOrderStatus(id: number, status: OrderStatus): void {
  const d = getDb();
  const order = d.prepare(`SELECT id FROM oi_order_items WHERE id = ?`).get(id);
  if (!order) throw new Error(`订单不存在: id=${id}`);
  dbRun(`UPDATE oi_order_items SET status = ? WHERE id = ?`, [status, id]);
}

/** 批量标记订单已核对（corrected=1）：
 * 数据纠正页「确认无误」/「全部确认无误」时调用——识别结果无需修改的订单不改字段，
 * 仅置位后离开待纠正列表。返回实际更新的行数。 */
export function markOrdersCorrected(ids: number[]): number {
  const list = [...new Set(ids)].filter((n): n is number => Number.isInteger(n) && n > 0);
  if (!list.length) return 0;
  const d = getDb();
  const placeholders = list.map(() => '?').join(',');
  const r = d
    .prepare(`UPDATE oi_order_items SET corrected = 1 WHERE id IN (${placeholders})`)
    .run(...list);
  // 阶段 A4：确认无误 = 这一行的款/色/码定稿了 ⇒ 顺手把克重钉成快照（`NULL` 的才写）
  snapshotOrderWeights(list);
  // C2：同一时刻钉「进价（预估）」—— 之后产品改价不回写历史行
  snapshotOrderCosts(list);
  return Number(r.changes);
}

/** 标记全部未核对订单为已核对（纠正页「全部确认无误」）：
 * 一次 UPDATE 完成，避免大批量下把数万 id 经 IPC 传回主进程再拼 IN(...)。 */
export function markAllOrdersCorrected(): number {
  const r = dbRun(`UPDATE oi_order_items SET corrected = 1 WHERE corrected = 0`);
  snapshotOrderWeights();
  snapshotOrderCosts();
  return Number(r.changes);
}

/**
 * **阶段 A4（2026-10-21）：把克重钉成订单行快照**（`oi_order_items.weight_g`）。
 *
 * 为什么钉：利润/运费原先每次都要"款色 → 产品 → SKU"三跳现查，于是**历史订单的重量会随
 * SKU 表被改而变**（同一单今天算 250g、明天算 300g，运费跟着漂）。快照让一行自带答案。
 *
 * 只在**归类核对确认无误 / 全部确认无误**时调用（那一刻款、色、码才定稿）；
 * 只写 `weight_g IS NULL` 的行 —— 已钉过的不重算，否则改一次 SKU 克重会把历史全刷新。
 *
 * @param ids 指定行；缺省 = 全库所有还没钉克重的行
 * @returns 真正钉上的行数
 */
export function snapshotOrderWeights(ids?: number[]): number {
  // 产品域可能还没建（新装应用先走订单导入）→ 降级为"没有克重可钉"，不抛 no such table
  if (!tableExists('pl_variants') || !productSchemaReady()) return 0;

  const list = Array.isArray(ids)
    ? [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))]
    : null;
  const scope = list?.length ? `AND o.id IN (${list.map(() => '?').join(',')})` : '';
  const args: (number | string)[] = [];
  if (list?.length) args.push(...list);

  // 一条查询取"每行能钉的那个克重"：款色 → 款编码 → 产品 → 同色同码 SKU。
  // 多行命中取最小 id 的那条（同款同色同码理论上只有一条；取确定的一条，不猜最大值）。
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT o.id AS id,
            (SELECT v.weight_g
               FROM pl_variants v
              WHERE v.product_id = p.id AND v.color = sc.color AND v.size = o.size
                AND v.weight_g > 0
              ORDER BY v.id ASC LIMIT 1) AS g
       FROM oi_order_items o
       JOIN oi_style_colors sc ON sc.id = o.style_color_id
       JOIN oi_styles s ON s.id = sc.style_id
       JOIN pl_products p ON p.code = s.code
      WHERE o.weight_g IS NULL ${scope}`,
    args,
  );

  let filled = 0;
  dbTransaction(() => {
    for (const r of rows) {
      const g = Number(r.g);
      if (!Number.isFinite(g) || g <= 0) continue; // 该行查不到 SKU 克重 → 留 NULL（标"缺"，不编数）
      dbRun(`UPDATE oi_order_items SET weight_g = ? WHERE id = ? AND weight_g IS NULL`, [
        Math.round(g),
        Number(r.id) || 0,
      ]);
      filled++;
    }
  });
  return filled;
}

/**
 * **C2（2026-10-21）：把「进价（预估）」钉成订单行快照**（`oi_order_items.cost_cents`）。
 *
 * 与 `snapshotOrderWeights` 同一时机、同一纪律（归类确认时钉；只写 `NULL`，已钉过的不重算）：
 * 预估 = 确认那一刻 `pl_products.cost_cents`（当前进价）的拷贝 —— 之后产品改价不回写历史行。
 * `actual_cost_cents`（拿货实付）是另一列、另一个写者（`syncOrderRowCosts`），本函数不碰。
 *
 * @param ids 指定行；缺省 = 全库所有还没钉预估的行
 * @returns 真正钉上的行数
 */
export function snapshotOrderCosts(ids?: number[]): number {
  // 产品域可能还没建（新装应用先走订单导入）→ 降级为"没有价可钉"，不抛 no such table
  if (!tableExists('pl_products') || !productSchemaReady()) return 0;

  const list = Array.isArray(ids)
    ? [...new Set(ids.filter((n) => Number.isInteger(n) && n > 0))]
    : null;
  const scope = list?.length ? `AND o.id IN (${list.map(() => '?').join(',')})` : '';
  const args: (number | string)[] = [];
  if (list?.length) args.push(...list);

  // 款色 → 款编码 → 产品当前价。未识别款 / 产品不存在 / 价还是 0 → 留 NULL（标"缺"）。
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT o.id AS id, p.cost_cents AS cents
       FROM oi_order_items o
       JOIN oi_style_colors sc ON sc.id = o.style_color_id
       JOIN oi_styles s ON s.id = sc.style_id
       JOIN pl_products p ON p.code = s.code
      WHERE o.cost_cents IS NULL AND p.cost_cents > 0 ${scope}`,
    args,
  );

  let filled = 0;
  dbTransaction(() => {
    for (const r of rows) {
      const cents = Number(r.cents);
      if (!Number.isFinite(cents) || cents <= 0) continue;
      dbRun(`UPDATE oi_order_items SET cost_cents = ? WHERE id = ? AND cost_cents IS NULL`, [
        Math.round(cents),
        Number(r.id) || 0,
      ]);
      filled++;
    }
  });
  return filled;
}

/**
 * 退回待核对（`corrected = 0`）：把**已核对**的行重新放回待核对队列
 * （归类核对页的「退回待核对」—— 核对过之后发现定错了款/色的唯一回头路）。
 *
 * 与 `markOrdersCorrected` 是**镜像**：那边置 1 让行离开待核对列表，这边置 0 让它回来。
 * 只动 `corrected` 这一个位：**不改** category/color/logo，也不碰图片的款色归属 ——
 * 上一轮核对留下的结论原样保留（用户是"要重做这一行"，不是"把这一行清空"），
 * 重做时界面上不带出任何被清空的字段，也就不存在"退回把数据弄没了"。
 *
 * ⚠️ **刻意没有 `all` 分支**（有 `markAllOrdersCorrected` 那样的镜像就太顺手了）：
 *    一次把整批已核对的行全退回，用户既看不出退回了多少、也记不住哪些本来是核对好的，
 *    而退回是不可逆的"状态回滚"（没有任何地方记着"它原来是不是核对过的"）。
 *    ⇒ 退回一律**点名**，一行一个动作（2026-10-12 与用户确认过的口径）。
 */
export function reopenOrdersCorrected(ids: number[]): number {
  const list = [...new Set(ids)].filter((n): n is number => Number.isInteger(n) && n > 0);
  if (!list.length) return 0;
  const d = getDb();
  const placeholders = list.map(() => '?').join(',');
  const r = d
    .prepare(`UPDATE oi_order_items SET corrected = 0 WHERE id IN (${placeholders})`)
    .run(...list);
  return Number(r.changes);
}

/** 删除款式（款编码）：
 *  - oi_styles 行删除（CASCADE 级联删除其款色）；
 *  - 该款式下所有图片解除款色归属（style_color_id 置 NULL），图片与识别指纹保留；
 *  - 订单行保留（category/color 等字段不变），仅款编码联表变为空。 */
export function deleteStyle(id: number): void {
  const d = getDb();
  const style = d.prepare(`SELECT id FROM oi_styles WHERE id = ?`).get(id);
  if (!style) throw new Error(`款式不存在: id=${id}`);
  dbTransaction(() => {
    dbRun(
      `UPDATE oi_images SET style_color_id = NULL
       WHERE style_color_id IN (SELECT id FROM oi_style_colors WHERE style_id = ?)`,
      [id],
    );
    // 订单行的投影跟着退成「未归类」（0）—— 款删了还留着旧 id 就是指向不存在行的悬空引用，
    // 而缺口统计按 id 分组，会把它算进一个已经不存在的款里（界面上看不见、数字却还在）。
    dbRun(`UPDATE oi_order_items SET style_color_id = 0 WHERE style_color_id IN (SELECT id FROM oi_style_colors WHERE style_id = ?)`, [
      id,
    ]);
    dbRun(`DELETE FROM oi_styles WHERE id = ?`, [id]);
  });
}

/** 删除订单（删订单行；图片与识别指纹保留，供款式匹配复用） */
export function deleteOrder(id: number): void {
  const d = getDb();
  const order = d.prepare(`SELECT id FROM oi_order_items WHERE id = ?`).get(id);
  if (!order) throw new Error(`订单不存在: id=${id}`);
  dbTransaction(() => {
    dbRun(`DELETE FROM oi_order_items WHERE id = ?`, [id]);
    // 包裹收尾：`parcel_lines.order_item_id` 的 ON DELETE CASCADE 会带走这一行在各个包里的明细，
    // 但 `parcels` 自己**没有**外键指向订单行（键是 `order_no`，见 B2 笔记 §2.1）——
    // 不补这一步，删掉某单最后一行后会留下一个「0 条明细的空壳包」：
    // 它在 `parcelTotals` 里照样参与求和（缺值则让整单运费变 null），界面也多一张空卡片。
    // 只删**确实空了**的包；还有别的商品行占着的包不动。
    dbRun(
      `DELETE FROM parcels
       WHERE id NOT IN (SELECT DISTINCT parcel_id FROM parcel_lines)`,
    );
  });
}

/**
 * 按维度分组统计（dimensions 取 'category'/'color'/'shop' 子集）。
 * 返回每组件数，按数量倒序。拆表后 `category`/`color` 在明细、`shop` 在主表，统一 JOIN 后取。
 */
export function groupStats(dimensions: string[]): GroupStat[] {
  const cols = dimensions.filter((d) => d === 'category' || d === 'color' || d === 'shop');
  if (cols.length === 0) return [];
  const select = cols.map((c) => (c === 'shop' ? 'o.shop' : `oi.${c}`)).join(', ');
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT ${select}, COUNT(*) AS count
     FROM oi_order_items oi JOIN oi_orders o ON o.id = oi.order_id
     GROUP BY ${select} ORDER BY count DESC`,
  );
  return rows.map((r) => ({
    key: cols.map((c) => String(r[c] ?? '')).join('|'),
    category: String(r.category ?? ''),
    color: String(r.color ?? ''),
    shop: String(r.shop ?? ''),
    count: Number(r.count),
  }));
}

/** 清空订单与图片指纹库（含识别缓存与待识别队列），谨慎使用 */
export function clearAll(): void {
  dbTransaction(() => {
    dbRun('DELETE FROM parcels');
    dbRun('DELETE FROM oi_order_items');
    dbRun('DELETE FROM oi_orders');
    dbRun('DELETE FROM oi_images');
  });
}

/**
 * 图片本地路径全集（`oi_images` 的非空 local_path），供孤图清理判定"仍被引用"。
 *
 * ⚠️ 2026-10-28 顺带修掉一条**从未成功执行过**的查询：原 SQL 是
 * `UNION SELECT local_path FROM oi_queue`，而 `oi_queue` 的建表语句里**没有 local_path 列** ——
 * 真库上整条语句抛 `no such column: local_path`，被调用方的 try/catch 吞掉后返回失败
 * （症状：孤图清理永远删不掉任何文件，界面上只看到"失败"）。删队列时去掉那一支才第一次能跑。
 * 取证：对真库直接执行原 SQL 可复现该报错。
 */
export function listImageLocalPaths(): string[] {
  const rows = dbQuery<{ p: string }>(
    `SELECT local_path AS p FROM oi_images WHERE local_path <> ''`,
  );
  return rows.map((r) => r.p);
}

function mapOrderRow(row: Record<string, unknown>): OrderRecord {
  const rawFields = safeJson(String(row.raw_fields ?? ''));
  return {
    id: Number(row.id),
    imageId: Number(row.image_id),
    orderNo: String(row.order_no ?? ''),
    shop: String(row.shop ?? ''),
    size: String(row.size ?? ''),
    orderTime: String(row.order_time ?? ''),
    rawFields,
    // ⭐ 商品ID 由**主进程**从原始行里取（`extractSkuFields`），刻意不交给渲染层自己正则匹配：
    //    这个值是「归类核对页按商品分组」的键，而回流（`skuBackfillFromOrder`）写映射时用的
    //    也是同一个函数 —— 两处各写一套列名族，就会出现"徽标说同商品、回流却按另一个键记"。
    itemId: extractSkuFields(rawFields).itemId,
    category: String(row.category ?? ''),
    color: String(row.color ?? ''),
    logo: String(row.logo ?? ''),
    status: row.status === 'shipped' ? 'shipped' : 'pending',
    corrected: Number(row.corrected) === 1,
    createdAt: String(row.created_at ?? ''),
    fingerprint: row.fingerprint !== undefined && row.fingerprint !== null ? String(row.fingerprint) : undefined,
    localPath: row.local_path !== undefined && row.local_path !== null ? String(row.local_path) : undefined,
    styleCode: row.style_code !== undefined && row.style_code !== null ? String(row.style_code) : undefined,
    styleName: row.style_name !== undefined && row.style_name !== null ? String(row.style_name) : undefined,
    styleColor: row.style_color !== undefined && row.style_color !== null ? String(row.style_color) : undefined,
    features: parseFeatures(row.result_json),
  };
}

/** 从识别结果 JSON 中解析款式特征数组（纠正重新归类时重建指纹用） */
function parseFeatures(resultJson: unknown): string[] | undefined {
  if (typeof resultJson !== 'string' || !resultJson) return undefined;
  try {
    const v = JSON.parse(resultJson);
    if (Array.isArray(v?.features)) {
      const feats = v.features.map((f: unknown) => String(f ?? '').trim()).filter(Boolean);
      return feats.length ? feats.slice(0, 20) : undefined;
    }
  } catch {
    /* 识别结果损坏时忽略，纠正时特征为空仍可按品类归类 */
  }
  return undefined;
}

function safeJson(s: string): Record<string, string> {
  try {
    const v = JSON.parse(s);
    return v && typeof v === 'object' ? v : {};
  } catch {
    return {};
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 包裹（阶段 B2）：一单多包 / 按单个商品行拆 / 允许拆分一个合并行的数量
//
// 谁写这一层：只有本文件的 `createParcel` / `updateParcel` / `deleteParcel` /
// `setParcelLineQty`。渲染层只经 IPC 调用，不拼 SQL —— 拆包的**数量上限校验**必须只有一处，
// 界面上"还能拆几件"与写入时"允不允许写"用的是同一个函数（`parcelRemaining`），
// 否则界面放行、落库拒绝（或反过来超拆）时，用户看到的是"我明明点了保存"。
// ─────────────────────────────────────────────────────────────────────────────

/** 包裹里的一个订单行（拆了数量的行会带 `qty`） */
export interface ParcelLine {
  id: number;
  orderItemId: number;
  qty: number;
}

/** 一个包裹（含箱内明细） */
export interface Parcel {
  id: number;
  orderNo: string;
  /** 人工标注的包名（「箱 1」/「补发」），空串 = 只按顺序展示 */
  label: string;
  trackingNo: string;
  carrier: string;
  /** 运费（分）；**null = 还不知道**，不是 0 */
  shipCents: number | null;
  /** 包裹重量（克）；**null = 还不知道**，不是 0 */
  weightG: number | null;
  note: string;
  lines: ParcelLine[];
  createdAt: string;
}

/** 拆包面板的候选行：订单行本身 + 已分包件数 */
export interface ParcelItem {
  id: number;
  styleCode: string;
  styleColor: string;
  color: string;
  size: string;
  /** 件数真值（`oi_order_items.qty`）；null = 导入侧没解析出来，不是 0 */
  qty: number | null;
  /** 已分到各包裹的件数之和 */
  packed: number;
  /** 还能拆几件；`qty` 未知时 null（不编数，界面据此提示"件数未知"） */
  remaining: number | null;
  weightG: number | null;
}

/** 一单的包裹汇总（**派生**，不落库：总物流费/总重就是 Σ 包裹） */
export interface ParcelTotals {
  count: number;
  /** Σ `ship_cents`；任一个包缺值 ⇒ null（不是"已知部分之和"） */
  shipCents: number | null;
  /** Σ `weight_g`；任一个包缺值 ⇒ null */
  weightG: number | null;
  /** 缺运费的包数 / 缺重量的包数（界面据此说"还有 N 个包没填"） */
  shipMissing: number;
  weightMissing: number;
}

/** 包裹写入口的返回：`error` 有值即没写（界面直接展示这句话，不自己编文案） */
export interface ParcelWriteResult {
  ok: boolean;
  id: number;
  error?: string;
}

export interface ParcelInput {
  id?: number;
  orderNo?: string;
  label?: string;
  trackingNo?: string;
  carrier?: string;
  /** `undefined` = 不改；`null` = 清成"不知道"（与"填 0"是两件事） */
  shipCents?: number | null;
  weightG?: number | null;
  note?: string;
}

function numOrNull(v: unknown): number | null {
  if (v === null) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) return null;
  return Math.round(v);
}

/** 单个订单行的"已分包 / 还能拆"—— 界面与写入校验**共用这一份**（见本节头注释）。 */
function parcelRemaining(orderItemId: number, excludeParcelId = 0): { qty: number | null; packed: number; remaining: number | null } {
  const row = dbGet<{ qty: number | null }>(`SELECT qty FROM oi_order_items WHERE id = ?`, [orderItemId]);
  if (!row) return { qty: null, packed: 0, remaining: null };
  const packedRow = dbGet<{ s: number | null }>(
    `SELECT SUM(qty) AS s FROM parcel_lines WHERE order_item_id = ? AND parcel_id <> ?`,
    [orderItemId, excludeParcelId],
  );
  const packed = Number(packedRow?.s ?? 0) || 0;
  const qty = row.qty === null || row.qty === undefined ? null : Number(row.qty);
  // `qty` 未知（导入侧没解析出件数）⇒ 上限未知。这时**不替用户编一个数**：
  // remaining = null，界面提示"件数未知"，写入不做上限校验（否则合并行永远拆不动）。
  const remaining = qty === null ? null : Math.max(qty - packed, 0);
  return { qty, packed, remaining };
}

/** 一单的全部包裹 + 可拆的商品行（拆包面板一次取全，避免"列表与弹层各查一次"两套口径） */
export function parcelDetail(orderNo: string): { parcels: Parcel[]; items: ParcelItem[]; totals: ParcelTotals } {
  ensureOrderSchema();
  const no = String(orderNo || '').trim();
  if (!no) return { parcels: [], items: [], totals: parcelTotals('') };

  const parcelRows = dbQuery<Record<string, unknown>>(
    `SELECT id, order_no, label, tracking_no, carrier, ship_cents, weight_g, note, created_at
     FROM parcels WHERE order_no = ? ORDER BY id`,
    [no],
  );
  const lineRows = dbQuery<Record<string, unknown>>(
    `SELECT l.id, l.parcel_id, l.order_item_id, l.qty
     FROM parcel_lines l JOIN parcels p ON p.id = l.parcel_id
     WHERE p.order_no = ? ORDER BY l.id`,
    [no],
  );
  const byParcel = new Map<number, ParcelLine[]>();
  for (const r of lineRows) {
    const pid = Number(r.parcel_id);
    const arr = byParcel.get(pid) || [];
    arr.push({ id: Number(r.id), orderItemId: Number(r.order_item_id), qty: Number(r.qty) });
    byParcel.set(pid, arr);
  }
  const parcels: Parcel[] = parcelRows.map((r) => ({
    id: Number(r.id),
    orderNo: String(r.order_no ?? ''),
    label: String(r.label ?? ''),
    trackingNo: String(r.tracking_no ?? ''),
    carrier: String(r.carrier ?? ''),
    shipCents: r.ship_cents === null || r.ship_cents === undefined ? null : Number(r.ship_cents),
    weightG: r.weight_g === null || r.weight_g === undefined ? null : Number(r.weight_g),
    note: String(r.note ?? ''),
    lines: byParcel.get(Number(r.id)) || [],
    createdAt: String(r.created_at ?? ''),
  }));

  // 商品行：款色码走与 `shippingRows`/`outstanding()` 同一条识别链（LEFT JOIN，未识别的行照样回来）
  const itemRows = dbQuery<Record<string, unknown>>(
    `SELECT oi.id, oi.qty, oi.size, oi.color, oi.weight_g,
            COALESCE(sc.color, '') AS sc_color,
            COALESCE(st.code, '')  AS st_code,
            COALESCE((SELECT SUM(pl.qty) FROM parcel_lines pl WHERE pl.order_item_id = oi.id), 0) AS packed
     FROM oi_order_items oi
     JOIN oi_orders o ON o.id = oi.order_id
     LEFT JOIN oi_style_colors sc ON sc.id = oi.style_color_id
     LEFT JOIN oi_styles st ON st.id = sc.style_id
     WHERE o.order_no = ?
     ORDER BY oi.id`,
    [no],
  );
  const items: ParcelItem[] = itemRows.map((r) => {
    const qty = r.qty === null || r.qty === undefined ? null : Number(r.qty);
    const packed = Number(r.packed ?? 0) || 0;
    return {
      id: Number(r.id),
      styleCode: String(r.st_code ?? ''),
      styleColor: String(r.sc_color ?? ''),
      color: String(r.color ?? '') || String(r.sc_color ?? ''),
      size: String(r.size ?? ''),
      qty,
      packed,
      remaining: qty === null ? null : Math.max(qty - packed, 0),
      weightG: r.weight_g === null || r.weight_g === undefined ? null : Number(r.weight_g),
    };
  });

  return { parcels, items, totals: parcelTotals(no) };
}

/**
 * 一单的包裹汇总（派生）。**任一个包缺值就整单 null** —— 不让"已知部分之和"冒充总运费。
 * 口径只有一份：单笔与批量走同一个聚合（`parcelTotalsByOrders`），改语义只改那一处。
 */
export function parcelTotals(orderNo: string): ParcelTotals {
  const no = String(orderNo || '').trim();
  if (!no) return { count: 0, shipCents: null, weightG: null, shipMissing: 0, weightMissing: 0 };
  return (
    parcelTotalsByOrders([no])[no] ?? {
      count: 0,
      shipCents: null,
      weightG: null,
      shipMissing: 0,
      weightMissing: 0,
    }
  );
}

/**
 * **一批**订单的包裹汇总（利润页一次问一批，避免每行一次 IPC）。
 * 不在返回里的单号 = 还没拆包（读方按「没有包裹」处理）。
 * **唯一实现**（单笔 `parcelTotals` 也走这里）：**任一个包缺值 ⇒ 该单对应合计为 `null`**，不给部分和。
 */
export function parcelTotalsByOrders(orderNos: string[]): Record<string, ParcelTotals> {
  const nos = [
    ...new Set(
      (Array.isArray(orderNos) ? orderNos : [])
        .map((x) => String(x ?? '').trim())
        .filter(Boolean),
    ),
  ].slice(0, 2000);
  const out: Record<string, ParcelTotals> = {};
  if (!nos.length) return out;
  const marks = nos.map(() => '?').join(',');
  const rows = dbQuery<{ order_no: string; n: number; s: number; w: number; sm: number; wm: number }>(
    `SELECT order_no,
            COUNT(*) AS n,
            COALESCE(SUM(ship_cents), 0) AS s,
            COALESCE(SUM(weight_g), 0)   AS w,
            SUM(CASE WHEN ship_cents IS NULL THEN 1 ELSE 0 END) AS sm,
            SUM(CASE WHEN weight_g   IS NULL THEN 1 ELSE 0 END) AS wm
     FROM parcels WHERE order_no IN (${marks}) GROUP BY order_no`,
    nos,
  );
  for (const r of rows) {
    const count = Number(r.n) || 0;
    const shipMissing = Number(r.sm) || 0;
    const weightMissing = Number(r.wm) || 0;
    out[String(r.order_no ?? '')] = {
      count,
      shipCents: count > 0 && shipMissing === 0 ? Number(r.s) || 0 : null,
      weightG: count > 0 && weightMissing === 0 ? Number(r.w) || 0 : null,
      shipMissing,
      weightMissing,
    };
  }
  return out;
}

/** 新建包裹。`order_no` 必须是一张真的存在的订单 —— 拼错的单号只会造出一个永远看不见的孤儿包。 */
export function createParcel(input: ParcelInput): ParcelWriteResult {
  ensureOrderSchema();
  const no = String(input?.orderNo || '').trim();
  if (!no) return { ok: false, id: 0, error: '缺少订单号' };
  const exists = dbGet<{ id: number }>(`SELECT id FROM oi_orders WHERE order_no = ? LIMIT 1`, [no]);
  if (!exists) return { ok: false, id: 0, error: `订单库里没有 ${no}，先导入/采集这张订单` };
  const r = dbRun(
    `INSERT INTO parcels (order_no, label, tracking_no, carrier, ship_cents, weight_g, note)
     VALUES (?, ?, ?, ?, ?, ?, ?)`,
    [
      no,
      String(input?.label ?? '').slice(0, 40),
      String(input?.trackingNo ?? '').slice(0, 80),
      String(input?.carrier ?? '').slice(0, 40),
      numOrNull(input?.shipCents),
      numOrNull(input?.weightG),
      String(input?.note ?? '').slice(0, 500),
    ],
  );
  return { ok: true, id: Number(r.lastInsertRowid || 0) };
}

/**
 * 改包裹。**只改传进来的字段**（`undefined` = 不动），`null` = 清成"不知道"。
 * 不提供"整包覆盖"：拆包面板是逐格编辑，整包覆盖会让没显示的那几格（如运单号）被空串冲掉。
 */
export function updateParcel(input: ParcelInput): ParcelWriteResult {
  ensureOrderSchema();
  const id = Number(input?.id || 0);
  if (!id) return { ok: false, id: 0, error: '缺少包裹 id' };
  const row = dbGet<{ id: number; order_no: string }>(`SELECT id, order_no FROM parcels WHERE id = ?`, [id]);
  if (!row) return { ok: false, id: 0, error: '包裹不存在（可能已被删除）' };

  const sets: string[] = [];
  const args: (string | number | null)[] = [];
  const setText = (col: string, v: unknown, max: number) => {
    if (v === undefined) return;
    sets.push(`${col} = ?`);
    args.push(typeof v === 'string' ? v.slice(0, max) : '');
  };
  const setNum = (col: string, v: unknown) => {
    if (v === undefined) return;
    sets.push(`${col} = ?`);
    args.push(numOrNull(v));
  };
  setText('label', input.label, 40);
  setText('tracking_no', input.trackingNo, 80);
  setText('carrier', input.carrier, 40);
  setText('note', input.note, 500);
  setNum('ship_cents', input.shipCents);
  setNum('weight_g', input.weightG);
  if (!sets.length) return { ok: true, id };
  sets.push(`updated_at = datetime('now','localtime')`);
  args.push(id);
  dbRun(`UPDATE parcels SET ${sets.join(', ')} WHERE id = ?`, args);
  return { ok: true, id };
}

/** 删包（明细**显式**先删，不靠外键级联）。包里的商品行**不受影响** —— 删的是"怎么装的"，不是"买了什么"。 */
export function deleteParcel(id: number): boolean {
  ensureOrderSchema();
  const pid = Number(id || 0);
  if (!pid) return false;
  // 为什么显式删而不是靠 `ON DELETE CASCADE`：级联只在 `PRAGMA foreign_keys=ON` 时生效，
  // 而那个 pragma 是连接级的（测试/脚本/将来换驱动都可能没开）。级联关掉时包会消失、
  // 明细留在库里，于是"删掉的那个包"仍在 `parcel_lines` 里占着这行的件数 —— 看不见、拆不动。
  const r = dbTransaction(() => {
    dbRun(`DELETE FROM parcel_lines WHERE parcel_id = ?`, [pid]);
    return dbRun(`DELETE FROM parcels WHERE id = ?`, [pid]);
  });
  return r.changes > 0;
}

/**
 * 设置"某个订单行在某个包里装几件"。`qty <= 0` = 从该包移除这一行。
 *
 * 三条拒绝，都要说清楚原因（返回 `error`，界面直接展示）：
 *   ① 包与订单行不属于同一张订单 —— 跨单分包是数据错，不是操作错；
 *   ② 超过该行**还能拆**的件数（`parcelRemaining` 已排除本包原有数量）；
 *   ③ 件数不是整数。
 * `qty` 未知的行不做上限校验（`remaining === null`），但仍要求 `qty > 0`。
 */
export function setParcelLineQty(parcelId: number, orderItemId: number, qty: number): ParcelWriteResult {
  ensureOrderSchema();
  const pid = Number(parcelId || 0);
  const iid = Number(orderItemId || 0);
  const q = Math.round(Number(qty));
  if (!pid || !iid) return { ok: false, id: 0, error: '缺少包裹或商品行' };
  if (!Number.isFinite(q)) return { ok: false, id: 0, error: '件数必须是数字' };

  const parcel = dbGet<{ order_no: string }>(`SELECT order_no FROM parcels WHERE id = ?`, [pid]);
  if (!parcel) return { ok: false, id: 0, error: '包裹不存在（可能已被删除）' };
  const item = dbGet<{ order_no: string }>(
    `SELECT o.order_no FROM oi_order_items oi JOIN oi_orders o ON o.id = oi.order_id WHERE oi.id = ?`,
    [iid],
  );
  if (!item) return { ok: false, id: 0, error: '商品行不存在（可能已被删除）' };
  if (String(item.order_no) !== String(parcel.order_no)) {
    return { ok: false, id: 0, error: '这个商品行不属于该包裹所在的订单' };
  }

  if (q <= 0) {
    dbRun(`DELETE FROM parcel_lines WHERE parcel_id = ? AND order_item_id = ?`, [pid, iid]);
    return { ok: true, id: pid };
  }

  const { remaining, qty: rowQty } = parcelRemaining(iid, pid);
  if (remaining !== null && q > remaining) {
    return { ok: false, id: 0, error: `这行只有 ${rowQty ?? 0} 件，已分包 ${(rowQty ?? 0) - remaining} 件，最多还能放 ${remaining} 件` };
  }
  dbRun(
    `INSERT INTO parcel_lines (parcel_id, order_item_id, qty) VALUES (?, ?, ?)
     ON CONFLICT(parcel_id, order_item_id) DO UPDATE SET qty = excluded.qty`,
    [pid, iid, q],
  );
  return { ok: true, id: pid };
}

/** 某张订单有哪些包裹（轻量投影：只给单号与箱数，供列表页标"已拆 N 包"） */
export function parcelCountByOrders(orderNos: string[]): Record<string, number> {
  const out: Record<string, number> = {};
  const nos = (orderNos || []).map((s) => String(s || '')).filter(Boolean);
  if (!nos.length) return out;
  const marks = nos.map(() => '?').join(',');
  const rows = dbQuery<{ order_no: string; n: number }>(
    `SELECT order_no, COUNT(*) AS n FROM parcels WHERE order_no IN (${marks}) GROUP BY order_no`,
    nos,
  );
  for (const r of rows) out[String(r.order_no)] = Number(r.n) || 0;
  return out;
}

