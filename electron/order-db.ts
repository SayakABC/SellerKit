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
  productIdByCode,
  productSchemaReady,
  renameProduct,
  resolveOrderSku,
  resolveShopRef,
  upsertSkuMappings,
} from './product-db';
import { extractOrderMoney } from './orderMoney';
// 采集侧口径的**纯原语**（收入 = 商品+买家运费；外币 × 汇率 → 分）。
// 回填走**同一组**函数而不是另写一遍算式 —— 两份口径必然漂移（AGENTS §4.2）。
import { orderIncomeCcy, parseSkuProps, toCentsCny } from './aeMoney';
import { extractSkuFields } from './shopSku';

// ---- 类型（与渲染层 src/types.ts 对应，结构保持一致） ----

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
 * 利润用列（2026-09-29 加；真实报表实证见 `electron/orderMoney.ts` 的文件头）。
 *
 * 口径两条，都会影响后续算账，别改：
 *   · **金额列可空（NULL = 不知道），故意不给 DEFAULT 0** —— 0 是"确实是 0"，NULL 是"报表里没有"，
 *     混起来就会把"缺税"算成"零税"，预测利润凭空变大；
 *   · 文字列空串 = 未知（`tax_platform` 空串 ≠ 非代征：前者是不知道谁承担，后者是明确我们承担）。
 *
 * 建表（新库）与老库补列**共用这一份**，避免两处列定义漂移。
 */
const ORDER_MONEY_COLS: { name: string; ddl: string }[] = [
  { name: 'amount_cents', ddl: 'amount_cents INTEGER' },
  { name: 'vat_cents', ddl: 'vat_cents INTEGER' },
  { name: 'ddp_cents', ddl: 'ddp_cents INTEGER' },
  { name: 'tax_platform', ddl: "tax_platform TEXT NOT NULL DEFAULT ''" },
  { name: 'biz_status', ddl: "biz_status TEXT NOT NULL DEFAULT ''" },
  // `ship_time` **不能删**：拣货的"未发货"判定读它（`picking-db`）
  { name: 'ship_time', ddl: "ship_time TEXT NOT NULL DEFAULT ''" },
];

/**
 * 主干列（2026-09-30，C1 合并）：`oi_orders` 是**唯一订单主干**，两条摄取通道都写它。
 *   · `source` = 摄取通道（'import' 报表导入 / 'collect' 浏览器采集）—— 界面按它标来源；
 *   · `qty` = 件数**真值**（采集帧每行自带）；NULL = 不知道（导入侧由渲染层解析"商品信息"块）。
 */
const ORDER_SPINE_COLS: { name: string; ddl: string }[] = [
  { name: 'source', ddl: "source TEXT NOT NULL DEFAULT 'import'" },
  { name: 'qty', ddl: 'qty INTEGER' },
];

/** `oi_orders` 建表/重建**共用一份**列定义（改列只改这里；重建见 `migrateOrderSpine`） */
const ORDER_TABLE_DDL = `CREATE TABLE IF NOT EXISTS oi_orders (
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
${ORDER_MONEY_COLS.map((c) => `    ${c.ddl}`).join(',\n')},
${ORDER_SPINE_COLS.map((c) => `    ${c.ddl}`).join(',\n')},
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
  `CREATE INDEX IF NOT EXISTS idx_oi_images_url_fp ON oi_images(url_fingerprint)`,
  `CREATE INDEX IF NOT EXISTS idx_oi_orders_image ON oi_orders(image_id)`,
  `CREATE INDEX IF NOT EXISTS idx_oi_orders_shop ON oi_orders(shop)`,
  `CREATE INDEX IF NOT EXISTS idx_oi_orders_no_img ON oi_orders(order_no, image_id)`,
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
  // 待识别队列：导入 Excel 的行整批落库（batch_no 批次）；识别失败/缺图记录重启不丢、可增量重试。
  // 成功后订单入 oi_orders、本行转 done 并在批次结束清理，仅失败/缺图行残留待办。
  `CREATE TABLE IF NOT EXISTS oi_queue (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_no TEXT NOT NULL,
    raw_fields TEXT NOT NULL,
    url TEXT NOT NULL DEFAULT '',
    order_no TEXT NOT NULL DEFAULT '',
    info TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'pending',
    error TEXT NOT NULL DEFAULT '',
    fail_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_oi_queue_batch ON oi_queue(batch_no, status, id)`,
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

/** `oi_orders` / `oi_images` 的演进步骤（版本化：只跑未应用的，见 `electron/db.ts` 的 `migrate`） */
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
  ];
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
    upsertCollectedOrder({
      orderNo,
      orderTime: String(r.order_time ?? ''),
      bizStatus: String(r.status ?? ''),
      shop: String(r.shop_name ?? ''),
      amountCents,
      // 保真：原帧整段搬进来（与实时采集同一个 raw_fields 键名），另加一个可回滚的迁移标记
      rawFields: {
        采集帧: String(r.raw_json ?? '').slice(0, 20000),
        __migratedFrom: 'ae_orders',
      },
      lines: srcLines.map((l) => {
        const props = parseSkuProps(l.skuProps);
        return {
          itemId: l.productId.slice(0, 64),
          qty: Math.max(1, Math.round(l.qty) || 1),
          color: props.color.slice(0, 64),
          size: props.size.slice(0, 64),
        };
      }),
    });
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

/** 老库补「利润用列」（金额/状态/时点）；列定义与建表共用 `ORDER_MONEY_COLS`，不会漂移 */
function addOrderMoneyColumns(): void {
  const cols = dbQuery<{ name: string }>(`PRAGMA table_info(oi_orders)`).map((r) =>
    String(r.name ?? ''),
  );
  if (cols.length === 0) return; // 新库：由 dbMigrate 建表时带上这些列
  const have = new Set(cols);
  for (const c of ORDER_MONEY_COLS) {
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
    dbRun(`ALTER TABLE oi_orders RENAME TO oi_orders_legacy_spine`);
    dbRun(ORDER_TABLE_DDL);
    // 老行**一律是报表导入来的**（当时没有第二条通道）→ source='import'；qty 留 NULL（由渲染层解析块内数量）
    dbRun(
      `INSERT INTO oi_orders (id, image_id, order_no, shop, size, order_time, raw_fields, category,
                              color, logo, material, status, corrected,
                              amount_cents, vat_cents, ddp_cents, tax_platform, biz_status, ship_time,
                              created_at, source, qty)
       SELECT id, image_id, order_no, shop, size, order_time, raw_fields, category,
              color, logo, material, status, corrected,
              amount_cents, vat_cents, ddp_cents, tax_platform, biz_status, ship_time,
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

/** 记录下载成功的图片（pending 态，待 AI 识别） */
export function insertImage(rec: OrderImageRecord): number {
  const r = dbRun(
    `INSERT INTO oi_images (fingerprint, url_fingerprint, source_url, local_path, status)
     VALUES (?, ?, ?, ?, 'pending')`,
    [rec.fingerprint, rec.urlFingerprint, rec.sourceUrl, rec.localPath],
  );
  return r.lastInsertRowid;
}

/** 更新图片归属款色（识别确认后挂接） */
export function setImageStyleColor(imageId: number, styleColorId: number | null): void {
  dbRun(`UPDATE oi_images SET style_color_id = ?, updated_at = datetime('now','localtime') WHERE id = ?`, [
    styleColorId,
    imageId,
  ]);
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
function nextStyleCode(): string {
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
}): { styleCode: string; styleColorCode: string; skuBackfill: SkuBackfillOutcome } {
  const d = getDb();
  const color = String(input.color ?? '').trim();
  const assigned = dbTransaction(() => {
    const order = d.prepare(`SELECT image_id FROM oi_orders WHERE id = ?`).get(input.orderId) as
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
    d.prepare(`UPDATE oi_images SET style_color_id = ?, updated_at = datetime('now','localtime') WHERE id = ?`).run(
      sc.id,
      order.image_id,
    );
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
  return { ...assigned, skuBackfill };
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

/**
 * 按 款编码+款色（+尺码）取一张已下载的代表图（本地路径），供拿货单编辑器/Excel 导出嵌图；查不到返回 null。
 *
 * ⚠️ `size` 不是装饰，**调用方应当传**（2026-10-11 用户报"拿货单明细的图片都是一样的"）：
 *   · 明细行的粒度是「款色 × 尺码」（`outstanding()` 的聚合键 = `purchase_items` 唯一键），
 *     而订单 Excel 解析出来的图挂在**订单行**上（`oi_orders.image_id` → 那一件商品自己的图）。
 *   · 只按款色取 ⇒ `ORDER BY i.id DESC LIMIT 1` 永远挑"该款色最新那张"——同一款的多行
 *     （不同尺码、各来自不同商品）会**全显示同一张图**，且多数行显示的还不是自己那件的图。
 *     真库实测（SUST-006·未分类 下挂 4 张不同商品的图）：5 行明细全落到 id 最大那张，**4/5 行是错的**。
 *   · 传了 `size` 就**先**挑「该尺码的订单行用过的那张图」（`EXISTS` 子查询，不是 JOIN ——
 *     JOIN 会让一张图按引用它的订单行数放大，`LIMIT 1` 取到谁就变得不确定）；
 *     该尺码下压根没有订单行（手工加的行 / 订单还没导入）才回落到款色级最新图 ——
 *     **有图仍优于缺图**，回落只是兜底，不改变"优先本行对应图"的口径。
 */
export function findStyleColorImagePath(styleCode: string, color: string, size = ''): string | null {
  const code = String(styleCode ?? '').trim();
  const clr = String(color ?? '').trim();
  const sz = String(size ?? '').trim();
  const row = dbGet<{ local_path: string }>(
    `SELECT i.local_path
     FROM oi_styles s
     JOIN oi_style_colors sc ON sc.style_id = s.id
     JOIN oi_images i ON i.style_color_id = sc.id
     WHERE s.code = ? AND sc.color = ?
       AND i.local_path IS NOT NULL AND i.local_path <> ''
     ORDER BY
       CASE WHEN ? <> '' AND EXISTS (
         SELECT 1 FROM oi_orders o WHERE o.image_id = i.id AND o.size = ?
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
 * 订单落库时的**确定性归款**（P3 业务链路「先查 `pl_shop_sku`，查不到才走 AI 兜底」的落点）。
 *
 * 只认 `status='confirmed'` 的映射（`resolveOrderSku` 内部保证）：`pending`/`invalid` 不得替人下结论。
 * 命中后把订单图片挂到该产品的款色 —— 颜色取自**订单自身字段**（映射只到"款"，不带颜色）。
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
  // 颜色权威来源（D4）：**映射里配的颜色** > 订单自身字段 > 兜底。
  // 顺序不能反 —— 订单侧的颜色在真实数据里几乎不可用（芒果待发货单该列恒空；采集帧里
  // 39% 是 `Picture color` 这类"以图为准"的占位），"每单看一眼图"就是这么来的。
  // 映射带了色就一律以它为准：它才是"这个商品ID 是什么颜色"的权威。
  const mapped = String(hit.spec ?? '').trim();
  const color =
    mapped && mapped !== '*' ? mapped : String(rec.color ?? '').trim() || MAPPED_FALLBACK_COLOR;
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
 *     只认占位色这一种"色还没定"的状态，改一次映射色不会把历史订单全改判；
 *   · 只处理传入 `itemIds` 命中的行 —— 配了哪个商品就只回填那个商品，不顺手全库重算；
 *   · `autoAssignByMap` 自身未命中就什么都不做（保持原状），所以这里不需要额外判空。
 *
 * @returns 本次**实际发生变化**的行数（新归款 + 补色都算；值没变的行不计 ——
 *          回执里报出的数必须是"真的动了这几行"，而不是"扫过这几行"）
 */
export function reassignOrdersByItemIds(itemIds: string[]): number {
  if (!productSchemaReady()) return 0;
  const want = new Set(
    (Array.isArray(itemIds) ? itemIds : []).map((s) => String(s ?? '').trim()).filter(Boolean),
  );
  if (!want.size) return 0;

  const rows = dbQuery<{
    image_id: number;
    shop: string;
    color: string;
    raw_fields: string;
    cur_id: number | null;
  }>(
    `SELECT o.image_id, o.shop, o.color, o.raw_fields, i.style_color_id AS cur_id
       FROM oi_orders o
       JOIN oi_images i ON o.image_id = i.id
       LEFT JOIN oi_style_colors sc ON sc.id = i.style_color_id
      WHERE o.image_id IS NOT NULL
        AND (i.style_color_id IS NULL OR sc.color = ?)`,
    [MAPPED_FALLBACK_COLOR],
  );
  const d = getDb();
  let n = 0;
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
    if (afterId && afterId !== beforeId) n += 1;
  }
  return n;
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
      `SELECT shop, raw_fields FROM oi_orders WHERE id = ?`,
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

    const shop = resolveShopRef(order.shop);
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

/** 插入一条订单明细，返回自增 id */
export function insertOrder(rec: OrderRecord): number {
  const d = getDb();
  const orderNo = String(rec.orderNo ?? '').trim();
  // 幂等：订单号非空时，(订单号, 图片) 已存在则跳过，避免重复导入同一 Excel 产生重复行
  if (orderNo) {
    // ⚠️ 用 `IS ?` 而不是 `= ?`：无图订单的 `image_id` 是 NULL，`= NULL` 永远不成立 →
    // 重导同一份报表会不断插重复行（幂等当场失效）。
    const existing = d
      .prepare(`SELECT id FROM oi_orders WHERE order_no = ? AND image_id IS ?`)
      .get(orderNo, rec.imageId);
    if (existing) {
      const id = Number((existing as { id: number }).id);
      // 幂等重入**也要再试一次归款**：映射很可能是这条订单之后才人工确认的，
      // 不重试的话「先导订单、后确认映射」的人永远等不到自动命中（验收②的字面场景）。
      autoAssignByMap(rec);
      return id;
    }
  }
  const status: OrderStatus = rec.status === 'shipped' ? 'shipped' : 'pending';
  // 金额/状态/时点在**入库这一刻**从 raw_fields 提成正式列（口径见 `electron/orderMoney.ts`）——
  // 放在主进程做，岛侧无需改，也就不必发版；其余 30 余列留在 raw_fields 里保真、随时可提。
  const m = extractOrderMoney(rec.rawFields);
  const r = dbRun(
    `INSERT INTO oi_orders (image_id, order_no, shop, size, order_time, raw_fields, category, color, logo, status,
                            amount_cents, vat_cents, ddp_cents, tax_platform, biz_status, ship_time)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    [
      rec.imageId,
      orderNo,
      rec.shop,
      rec.size,
      rec.orderTime ?? '',
      JSON.stringify(rec.rawFields),
      rec.category,
      rec.color,
      rec.logo,
      status,
      m.amountCents,
      m.vatCents,
      m.ddpCents,
      m.taxPlatformRaw,
      m.bizStatus,
      m.shipTime,
    ],
  );
  autoAssignByMap(rec);
  return r.lastInsertRowid;
}

/**
 * 把若干订单号**归属到某店铺**（写 `oi_orders.shop`）。
 *
 * 为什么需要它：实测 AE 的「订单列表/订单明细」导出**按店铺导出、报表里没有店铺列**
 * （只有"店铺优惠"；岛侧"店铺列"是手选的，对这类报表选不出来）→ 店铺只能**在导入后由人指定**。
 * 这里写的是店铺**名称原文**：`oi_orders.shop` 与 `purchase_sources.shop` / `ae_orders.shop_name` 一样是
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
      .prepare(`SELECT id FROM oi_orders WHERE order_no = ? AND source = 'collect' LIMIT 1`)
      .get(orderNo) as { id: number } | undefined;
    if (existed) {
      d.prepare(`DELETE FROM oi_orders WHERE order_no = ? AND source = 'collect'`).run(orderNo);
      replaced = true;
    }
    // 列与值一一对应（14 列 / 14 值 / 9 个参数）—— 别在这里做任何字符串拼接
    const ins = d.prepare(
      `INSERT INTO oi_orders (image_id, order_no, shop, size, order_time, raw_fields, category, color, logo,
                              status, amount_cents, biz_status, source, qty)
       VALUES (NULL, ?, ?, ?, ?, ?, '', ?, '', 'pending', ?, ?, 'collect', ?)`,
    );
    // 一单零行也落一行（订单数不能凭空少）；件数按 1（不猜 0）
    for (const l of lines.length ? lines : [{ itemId: '', qty: 1, color: '', size: '' }]) {
      ins.run(
        orderNo,
        shop,
        String(l?.size ?? '').slice(0, 64),
        orderTime,
        rawJson,
        String(l?.color ?? '').slice(0, 64),
        amount,
        bizStatus,
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
 *    前两者是"按店铺/按日"聚合的维度，后两者是**成本侧**的键（款级成本 `ae_cost_map`）；
 *  - 仍**只回最小列**（不含订单明细的大字段），提取结果（国家/商品ID/克重/成本）收敛后再回渲染层，大载荷不过岛；
 *  - 只读，不暴露任何写能力。
 *
 * ⚠️ `opts.importDate`（`yyyy-mm-dd`，本地时区）是**「发货台」的每日口径**：一天一导（导出
 *    "昨天 → 导出时点"的全部订单，中间追加的也算同一天），故按**导入日**筛，而不是按 `order_time`
 *    （下单日）—— 用户关心的是"今天我导进来的这一批"，昨天下的单今天导也该在今天这批里。 */
export function shippingRows(
  limit = 500,
  opts: { source?: 'all' | 'import' | 'collect'; importDate?: string } = {},
): {
  id: number;
  orderNo: string;
  /** 摄取通道（主干 `source`） */
  source: 'import' | 'collect';
  /** 件数真值（采集通道写入；`NULL` = 不知道，导入侧由渲染层解析块内数量） */
  qty: number | null;
  shop: string;
  orderTime: string;
  styleCode: string;
  styleColor: string;
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
    `SELECT o.id, o.order_no, o.shop, o.order_time, o.raw_fields, o.color, o.size,
            o.amount_cents, o.vat_cents, o.ddp_cents, o.tax_platform, o.biz_status, o.source, o.qty,
            COALESCE(s.code, '') AS style_code, COALESCE(sc.color, '') AS style_color,
            ${supplierSel}
     FROM oi_orders o
     LEFT JOIN oi_images i ON o.image_id = i.id
     LEFT JOIN oi_style_colors sc ON i.style_color_id = sc.id
     LEFT JOIN oi_styles s ON sc.style_id = s.id
     ${supplierJoin}
     ${conds.length ? `WHERE ${conds.join(' AND ')}` : ''}
     ORDER BY o.id DESC LIMIT ?`,
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
    orderTime: String(r.order_time ?? ''),
    styleCode: String(r.style_code ?? ''),
    styleColor: String(r.style_color ?? ''),
    color: String(r.color ?? ''),
    size: String(r.size ?? ''),
    supplierId: Number(r.supplier_id ?? 0) || 0,
    supplierName: String(r.supplier_name ?? ''),
    amountCents: money(r.amount_cents),
    vatCents: money(r.vat_cents),
    ddpCents: money(r.ddp_cents),
    taxPlatform: String(r.tax_platform ?? ''),
    bizStatus: String(r.biz_status ?? ''),
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
    conds.push('o.corrected = 1');
  } else {
    conds.push('o.corrected = 0');
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
      `(o.order_no LIKE ? ESCAPE '\\' OR o.shop LIKE ? ESCAPE '\\' OR o.category LIKE ? ESCAPE '\\'
        OR o.color LIKE ? ESCAPE '\\' OR o.logo LIKE ? ESCAPE '\\'
        OR s.code LIKE ? ESCAPE '\\' OR ${n.name} LIKE ? ESCAPE '\\' OR sc.color LIKE ? ESCAPE '\\')`,
    );
    params.push(like, like, like, like, like, like, like, like);
  }
  const where = conds.length ? ` WHERE ${conds.join(' AND ')}` : '';
  const total = Number(
    dbQuery<{ n: number }>(
      `SELECT COUNT(*) AS n FROM oi_orders o
       LEFT JOIN oi_images i ON o.image_id = i.id
       LEFT JOIN oi_style_colors sc ON i.style_color_id = sc.id
       LEFT JOIN oi_styles s ON sc.style_id = s.id
       ${n.join}
       ${where}`,
      params,
    )[0]?.n ?? 0,
  );
  // ⚠️ 这里**必须**带上 `o.raw_fields`：`OrderRecord.itemId` 由它推出来（见 `mapOrderRow`），
  //    而归类核对页要靠 itemId 标出"本页哪几行是同一个商品"。之前漏了它，`rawFields` 恒为 `{}`
  //    —— 那是个静默陷阱：类型上写着"原始整行"，用的人读到的却是空对象。
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT o.id, o.image_id, o.order_no, o.shop, o.size, o.order_time, o.raw_fields,
            o.category, o.color, o.logo, o.material, o.status, o.corrected, o.created_at,
            i.fingerprint, i.source_url, i.local_path, i.result_json,
            s.code AS style_code, ${n.name} AS style_name, sc.color AS style_color
     FROM oi_orders o
     LEFT JOIN oi_images i ON o.image_id = i.id
     LEFT JOIN oi_style_colors sc ON i.style_color_id = sc.id
     LEFT JOIN oi_styles s ON sc.style_id = s.id
     ${n.join}
     ${where} ORDER BY o.id DESC LIMIT ? OFFSET ?`,
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
    const order = d.prepare(`SELECT image_id FROM oi_orders WHERE id = ?`).get(input.id) as
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
      `UPDATE oi_orders SET category = ?, color = ?, logo = ?, corrected = 1 WHERE id = ?`,
      [input.category, input.color, input.logo, input.id],
    );
    // 未 reclassify 时也返回当前归属款编码（渲染层改款式名等场景需要定位款编码）
    if (!reassigned.styleCode) {
      const cur = d
        .prepare(
          `SELECT s.code AS style_code, sc.code AS style_color_code
           FROM oi_orders o
           LEFT JOIN oi_images i ON o.image_id = i.id
           LEFT JOIN oi_style_colors sc ON i.style_color_id = sc.id
           LEFT JOIN oi_styles s ON sc.style_id = s.id
           WHERE o.id = ?`,
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
  const order = d.prepare(`SELECT id FROM oi_orders WHERE id = ?`).get(id);
  if (!order) throw new Error(`订单不存在: id=${id}`);
  dbRun(`UPDATE oi_orders SET status = ? WHERE id = ?`, [status, id]);
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
    .prepare(`UPDATE oi_orders SET corrected = 1 WHERE id IN (${placeholders})`)
    .run(...list);
  return Number(r.changes);
}

/** 标记全部未核对订单为已核对（纠正页「全部确认无误」）：
 * 一次 UPDATE 完成，避免大批量下把数万 id 经 IPC 传回主进程再拼 IN(...)。 */
export function markAllOrdersCorrected(): number {
  const r = dbRun(`UPDATE oi_orders SET corrected = 1 WHERE corrected = 0`);
  return Number(r.changes);
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
    .prepare(`UPDATE oi_orders SET corrected = 0 WHERE id IN (${placeholders})`)
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
    dbRun(`DELETE FROM oi_styles WHERE id = ?`, [id]);
  });
}

/** 删除订单（仅删订单行；图片与识别指纹保留，供款式匹配复用） */
export function deleteOrder(id: number): void {
  const d = getDb();
  const order = d.prepare(`SELECT id FROM oi_orders WHERE id = ?`).get(id);
  if (!order) throw new Error(`订单不存在: id=${id}`);
  dbRun(`DELETE FROM oi_orders WHERE id = ?`, [id]);
}

/**
 * 按维度分组统计（dimensions 取 'category'/'color'/'shop' 子集）。
 * 返回每组件数，按数量倒序。
 */
export function groupStats(dimensions: string[]): GroupStat[] {
  const cols = dimensions.filter((d) => d === 'category' || d === 'color' || d === 'shop');
  if (cols.length === 0) return [];
  const select = cols.join(', ');
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT ${select}, COUNT(*) AS count FROM oi_orders GROUP BY ${select} ORDER BY count DESC`,
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
    dbRun('DELETE FROM oi_orders');
    dbRun('DELETE FROM oi_images');
    dbRun('DELETE FROM oi_queue');
  });
}

// ---- 待识别队列（oi_queue）----
// 用途：导入 Excel 的行先整批落库为队列，识别失败(missing/error)记录保留，
//       重启不丢、可增量重试；成功(done)行在批次跑完后清理，避免表无限膨胀。

export interface OrderQueueEnqueueRow {
  rawFields: Record<string, string>;
  url: string;
  orderNo: string;
  info: string;
}

export interface OrderQueueStats {
  total: number;
  pending: number;
  done: number;
  error: number;
  missing: number;
}

function mapQueueRow(row: Record<string, unknown>): OrderQueueRow {
  return {
    id: Number(row.id),
    batchNo: String(row.batch_no ?? ''),
    rawFields: safeJson(String(row.raw_fields ?? '')),
    url: String(row.url ?? ''),
    orderNo: String(row.order_no ?? ''),
    info: String(row.info ?? ''),
    status: (String(row.status ?? 'pending') as OrderQueueStatus),
    error: String(row.error ?? ''),
    failCount: Number(row.fail_count ?? 0),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
  };
}

export type OrderQueueStatus = 'pending' | 'done' | 'error' | 'missing';

export interface OrderQueueRow {
  id: number;
  batchNo: string;
  rawFields: Record<string, string>;
  url: string;
  orderNo: string;
  info: string;
  status: OrderQueueStatus;
  error: string;
  failCount: number;
  createdAt?: string;
  updatedAt?: string;
}

function queryQueueStats(batchNo: string): OrderQueueStats {
  const rows = dbQuery<{ status: string; n: number }>(
    `SELECT status, COUNT(*) AS n FROM oi_queue WHERE batch_no = ? GROUP BY status`,
    [batchNo],
  );
  const s: OrderQueueStats = { total: 0, pending: 0, done: 0, error: 0, missing: 0 };
  for (const r of rows) {
    const n = Number(r.n);
    s.total += n;
    if (r.status === 'pending') s.pending = n;
    else if (r.status === 'done') s.done = n;
    else if (r.status === 'error') s.error = n;
    else if (r.status === 'missing') s.missing = n;
  }
  return s;
}

/** 整批写入队列（同一次导入共享 batchNo），返回写入行数 */
export function enqueueQueueRows(batchNo: string, rows: OrderQueueEnqueueRow[]): number {
  const d = getDb();
  dbTransaction(() => {
    const stmt = d.prepare(
      `INSERT INTO oi_queue (batch_no, raw_fields, url, order_no, info, status, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, 'pending', datetime('now','localtime'), datetime('now','localtime'))`,
    );
    for (const r of rows) {
      stmt.run(
        batchNo,
        JSON.stringify(r.rawFields ?? {}),
        String(r.url ?? ''),
        String(r.orderNo ?? ''),
        String(r.info ?? ''),
      );
    }
  });
  return rows.length;
}

/** 批次内队列行（概览/补图预览列表）。
 *  - 列表不携带 raw_fields（整行原始数据体积大），补图回写等需要原始行的场景走 getQueueRow；
 *  - limit > 0 时截断返回，避免大批量（如刚导入整批）时全量过 IPC。 */
export function listQueueRows(batchNo: string, limit = 0): OrderQueueRow[] {
  return listQueueRowsPage(batchNo, { limit }).rows;
}

/** 批次内队列行分页（失败清单/缺图清单按需加载）：
 *  - status：按单状态过滤（'pending'|'error'|'missing'|'done'），'all' 或省略为不过滤；
 *  - missingOnly：缺图待补（status IN ('pending','missing') 且 url=''），与 status 互斥（同传优先）；
 *  - 列表不携带 raw_fields，返回 { rows, total } 供前端分页与"其余 N 条"计数。 */
export function listQueueRowsPage(
  batchNo: string,
  opts: {
    offset?: number;
    limit?: number;
    status?: OrderQueueStatus | 'all';
    missingOnly?: boolean;
  } = {},
): { rows: OrderQueueRow[]; total: number } {
  const offset = Math.max(Number(opts.offset ?? 0) || 0, 0);
  const limit = Math.min(Math.max(Number(opts.limit ?? 0) || 0, 0), 2000);
  const conds: string[] = ['batch_no = ?'];
  const params: Array<string | number> = [batchNo];
  if (opts.missingOnly) {
    conds.push(`status IN ('pending','missing') AND url = ''`);
  } else if (opts.status && opts.status !== 'all') {
    conds.push('status = ?');
    params.push(opts.status);
  }
  const where = ` WHERE ${conds.join(' AND ')}`;
  const total = Number(
    dbQuery<{ n: number }>(`SELECT COUNT(*) AS n FROM oi_queue${where}`, params)[0]?.n ?? 0,
  );
  const pageSql = limit > 0 ? `${where} ORDER BY id LIMIT ? OFFSET ?` : `${where} ORDER BY id`;
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT id, batch_no, url, order_no, info, status, error, fail_count, created_at, updated_at
     FROM oi_queue${pageSql}`,
    limit > 0 ? [...params, limit, offset] : params,
  ).map(mapQueueRow);
  return { rows, total };
}

/** 按 id 取单行队列行（含 raw_fields，补图/复制原始信息用），无则返回 undefined */
export function getQueueRow(id: number): OrderQueueRow | undefined {
  const row = dbQuery<Record<string, unknown>>(`SELECT * FROM oi_queue WHERE id = ?`, [id])[0];
  return row ? mapQueueRow(row) : undefined;
}

/** 批次统计 */
export function queueStats(batchNo: string): OrderQueueStats {
  return queryQueueStats(batchNo);
}

/** 拉取下一批待处理行（status=pending，游标分页） */
export function nextPendingQueueRows(batchNo: string, afterId: number, limit: number): OrderQueueRow[] {
  return dbQuery<Record<string, unknown>>(
    `SELECT * FROM oi_queue WHERE batch_no = ? AND status = 'pending' AND id > ? ORDER BY id LIMIT ?`,
    [batchNo, afterId, limit],
  ).map(mapQueueRow);
}

/** 标记单行处理结果：done/error/missing；error 累计 fail_count */
export function setQueueRowResult(id: number, status: OrderQueueStatus, error = ''): void {
  if (status === 'error') {
    dbRun(
      `UPDATE oi_queue SET status = 'error', error = ?, fail_count = fail_count + 1, updated_at = datetime('now','localtime') WHERE id = ?`,
      [error, id],
    );
  } else {
    dbRun(
      `UPDATE oi_queue SET status = ?, error = '', updated_at = datetime('now','localtime') WHERE id = ?`,
      [status, id],
    );
  }
}

/** 补图：回写主图 URL 与原始行；行从 missing/error 转回 pending 以便下次识别 */
export function patchQueueRow(id: number, url: string, rawFields: Record<string, string>): void {
  dbRun(
    `UPDATE oi_queue SET url = ?, raw_fields = ?, error = '',
       status = CASE WHEN ? <> '' THEN 'pending' ELSE status END,
       updated_at = datetime('now','localtime') WHERE id = ?`,
    [url, JSON.stringify(rawFields ?? {}), url, id],
  );
}

/** 失败行重试：error → pending（fail_count 累计保留，便于识别持续失败告警） */
export function retryQueueErrors(batchNo: string): number {
  const r = dbRun(
    `UPDATE oi_queue SET status = 'pending', error = '', updated_at = datetime('now','localtime')
     WHERE batch_no = ? AND status = 'error'`,
    [batchNo],
  );
  return r.changes;
}

/** 清理批次内已完成行（done），释放空间；error/missing/pending 保留为待办 */
export function purgeDoneQueueRows(batchNo: string): number {
  const r = dbRun(`DELETE FROM oi_queue WHERE batch_no = ? AND status = 'done'`, [batchNo]);
  return r.changes;
}

/** 图片本地路径全集（oi_images ∪ oi_queue 的非空 local_path），供孤图清理判定"仍被引用" */
export function listImageLocalPaths(): string[] {
  const rows = dbQuery<{ p: string }>(
    `SELECT local_path AS p FROM oi_images WHERE local_path <> ''
     UNION SELECT local_path AS p FROM oi_queue WHERE local_path <> ''`,
  );
  return rows.map((r) => r.p);
}

/** 找到仍有未完成工作（pending/error/missing）的最近批次，供应用重启后恢复 */
export function lastActiveQueueBatch(): { batchNo: string; stats: OrderQueueStats } | null {
  const row = dbGet<{ batch_no: string }>(
    `SELECT batch_no FROM oi_queue
     GROUP BY batch_no
     HAVING SUM(CASE WHEN status IN ('pending','error','missing') THEN 1 ELSE 0 END) > 0
     ORDER BY MAX(id) DESC LIMIT 1`,
  );
  if (!row?.batch_no) return null;
  const batchNo = String(row.batch_no);
  return { batchNo, stats: queryQueueStats(batchNo) };
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
