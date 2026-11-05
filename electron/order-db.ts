// electron/order-db.ts
// 「订单归类」模块的数据访问层（基于 electron/db.ts 公共层）。
// 表：
//   md_images         图片主数据（`electron/master-data-db.ts` 拥有；内容指纹唯一、二进制在
//                     `userData/images/`）。本模块**只读**它（列表/拿货单取 local_path），
//                     不写、不删 —— 写只有 `landImageBytes` 一个入口（R1 / S0a）
//   款色代表图        挂在 `oi_style_colors.image_id`（1:1；不再有「图行挂色」的记忆表）
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
  tableSql,
  type MigrationStep,
} from './db';
import {
  adoptProduct,
  adoptProductImageIfEmpty,
  bundleRolesOf,
  ensureProductSchema,
  isBundleProduct,
  moveProductSupplier,
  orderColorByItemImage,
  productIdByCode,
  productSchemaReady,
  renameProduct,
  resolveBundleParts,
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
import { extractSkuFields, productTitleOf } from './shopSku';
import { splitVariantKey, variantKeyOf } from './variantKey';
// 图键（色名塌陷链接的第 4 段键）：纯函数，认不出返回 ''（见其文件头）
import { imageKeyOf } from './podImageKey';
// 「平台色名 → 我的色名」的查表/归一（纯函数；口径见其文件头）
import { colorAliasKey, pickColorAlias, translateColor, type ColorAliasRow } from './colorAlias';
// 店名归一（纯函数；与店铺主表 UNIQUE / 名称映射同一口径）。订单只存店名原文，
// 下游要按**店铺身份**聚合时必须经它换算，别自己 trim（否则多一个空格就成了两家店）。
import { toNameKey } from './shopName';
// 图片主数据（唯一图片仓）：本域只用它的**读**接口（`md_images` 的写入口在 master-data-db）。
import {
  allImageLocalPaths,
  ensureMasterDataSchema,
  findImageByFingerprint as mdFindImageByFingerprint,
  findImageByUrlFingerprint as mdFindImageByUrlFingerprint,
  imageIdExists,
  registerImageRow,
  type MdImageId,
  type MdImageRow,
} from './master-data-db';
// 旧图表的**一次性**搬迁（R1 修订）：拆表前把 oi_images / pl_images 的存量搬进 md_images。
// 过渡件 —— 迁移窗口结束后可整文件删除（旧表名只应出现在那里）。
import { migrateLegacyImages, remapOrderItemImages } from './legacy-image-migration';

// ---- 类型（与渲染层 src/types.ts 对应，结构保持一致） ----

/**
 * 图片主键 —— **品牌类型**（值仍是 number，只是带了来源标记）。
 *
 * R1 之后全项目只有一张图片表（`md_images`），"两张表 id 撞车"的历史问题消失了；
 * 但品牌类型保留：业务表里的 `image_id` 全是裸 number 列，把"产品 id / 款色 id"
 * 误当图片 id 传进来仍是运行期静默写脏，`tsc` 这一层能挡住就别留到运行时。
 */
export type OrderImageId = MdImageId;

/** 图片记录（渲染层展示用；`md_images` 的行，已无识别流水线字段，见 D16） */
export type OrderImageRecord = MdImageRow;

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
  // ── 芒果同步（2026-11-01，v13）──────────────────────────────────────────
  // 采集帧里有、而导入报表里没有的**订单级**字段。四个都属"一单一份、不随商品行变化"，
  // 故进主表（判据见本数组头上那段）。
  //   · `pay_time`：付款时刻。**发货时效的起点**是它而不是 `order_time`（下单）——
  //     芒果的时效计时从付款开始，用下单时刻算会把"下单后隔天才付"的单算成更紧急。
  //   · `shop_auth_id`：芒果的 `authId`（店铺在 ERP 里的 id）。`sk_shops.erp_shop_id`
  //     是同一口径 ⇒ 订单→店铺是**硬关联**，不必靠店名文本猜（T1-4）。
  //     存原文不存归一 id：归一 id 的映射在店铺域，订单域不持有别人的 id 语义。
  //   · `deal_deadline`：芒果 `sendGoodExpiredDate`，"最晚发货日"（界面倒计时用它）。
  //   · `timeout_at`：芒果 `aeInternetInfoDTO.qualifiedTime`。**与上一个差 6 天**（实测
  //     3077041601058259：11-11 vs 11-05），规律 `qualifiedTime ≈ 付款 + timeoutType + 39h`。
  //     两个都存是刻意的：哪个是真倒计时尚未去订单详情页核对（计划 D-2），
  //     只存一个就得在没证据时选一个，选错了晨报第一天就是错的。界面默认显示 `deal_deadline`。
  { name: 'pay_time', ddl: "pay_time TEXT NOT NULL DEFAULT ''" },
  { name: 'shop_auth_id', ddl: "shop_auth_id TEXT NOT NULL DEFAULT ''" },
  { name: 'deal_deadline', ddl: "deal_deadline TEXT NOT NULL DEFAULT ''" },
  { name: 'timeout_at', ddl: "timeout_at TEXT NOT NULL DEFAULT ''" },
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
  // 图片主键指向 `md_images`（主数据域）。**刻意不写外键**：
  //   ① 图片表由主数据域懒建，订单域不保证它在（跨域外键会把两张表的建表顺序焊死）；
  //   ② 迁移期要重建本表去掉旧外键（`retireLegacyImageTables`），有外键就得多一次拆除；
  //   ③ 图片行删除只发生在主数据域的"孤图清理"，那时引用它的订单行早已不存在。
  { name: 'image_id', ddl: 'image_id INTEGER' },
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
  // 变体键（2026-10-28）：`(店铺, 商品ID, 平台色原文)` 的归一复合键（口径见 `electron/variantKey.ts`）。
  // **必须在导入那一刻算好并落库**，不在查询时从 `raw_fields` 现算 —— 理由有两条：
  //   ① `raw_fields` 的键名族不唯一（`产品ID` / `商品ID` / `SKU` / `货号`），`json_extract` 只认
  //      死键名，换一家店就整批落空且不报错（`outstanding` 现在正是这么写的）；
  //   ② `color` 列会被人改（真库已有 1 行 `5 → 红色`），而键不能被改 —— 落在独立列上，
  //      改名只动标签、不动聚合关系。
  { name: 'variant_key', ddl: "variant_key TEXT NOT NULL DEFAULT ''" },
  // ── 芒果同步（2026-11-01，v13）──────────────────────────────────────────
  // 采集通道路径原先**根本不写商品ID**（`upsertCollectedOrder` 的 `ins.run()` 只用了
  // size/rawJson/color/qty），于是采集进来的行一行都拼不出 `variant_key` ——
  // 图案绑定、款色归类、成本全部落空，且不报错（人在界面上只看到"未归类"）。
  // 商品ID 必须有**独立列**而不是只藏在 `raw_fields` 里：态要从 `raw_fields` 的键名族捞
  // （`商品ID` / `产品ID` / `SKU` / `货号`），而键名族换一家店就可能整批落空（见
  // `variant_key` 上面那条的 ① ② 两条理由，同一件事）。
  { name: 'item_id', ddl: "item_id TEXT NOT NULL DEFAULT ''" },
  // 平台 SKU 唯一 ID（芒果 `skuCode`）。`variant_key` 是"店+商品ID+色名"的**我们拼的**键，
  // 色名会塌陷（一链接多图同名色）；`sku_code` 是**平台给的**精确标识 ⇒ 图案绑定首选锚点
  // （计划 D-4：两列并列，`sku_code` 命中不了再回落 `variant_key`）。空 = 采集帧没给。
  { name: 'sku_code', ddl: "sku_code TEXT NOT NULL DEFAULT ''" },
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
  -- 用途：订单主表（订单域，一行 = 一份订单，order_no 唯一）；金额/状态汇总，明细在 oi_order_items。
${ORDER_HEADER_COLS.map((c) => `    ${c.ddl}`).join(',\n')},
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`;

/** `oi_order_items`（明细）建表语句 —— 由 `ORDER_ITEM_COLS` 拼出。 */
const ORDER_ITEM_TABLE_DDL = `CREATE TABLE IF NOT EXISTS oi_order_items (
  -- 用途：订单明细行（一行 = 订单×商品/尺码），承载归类款色、成本与变体键；order_id 级联删除。
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

/** `oi_variant_keys` 建表语句（`SCHEMA` 与迁移 v12 共用这一份，避免两处形状分叉） */
const VARIANT_KEYS_DDL = `CREATE TABLE IF NOT EXISTS oi_variant_keys (
    -- 用途：变体键→款色映射（订单驱动归类；state = auto/named/merged）；保证重导幂等，N:1 合并合法。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    variant_key TEXT NOT NULL UNIQUE,
    style_color_id INTEGER NOT NULL REFERENCES oi_style_colors(id) ON DELETE CASCADE,
    state TEXT NOT NULL DEFAULT 'auto',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`;

/**
 * 款合并的两张表：`oi_style_merges`（一次操作 = 一行）+ `oi_style_merge_items`（明细）。
 *
 * 为什么必须有明细而不是"改完键就算"：合并的第一条验收是**可拆**（47 listing → 12 款，
 * 拆开回到 47）。只改 `oi_variant_keys.style_color_id` 的实现，改完源色信息就没了 ——
 * 那时"拆开"只能靠人回忆原来挂在哪个色上。
 *
 * 明细有两种 `kind`，因为"合并"在库里是两件不同的事：
 *   · `color` **搬色**：目标款下没有同名色 ⇒ 直接把这行款的 `style_id` 改到目标款。
 *     色 id 不变 ⇒ 键、订单行、套装拆件**一个都不用动**（这是默认路径，最不容易出错）。
 *   · `key`   **改键**：目标款下已有同名色 ⇒ 把源色的键改指到那条，源色行留着不删
 *     （留着才拆得回去；它变成源款下一个不挂键的空色，拿货/统计都看不见它）。
 *
 * `from_state` 一并记：拆完键要回到 `auto`/`named`，不能一律写成 `merged`
 * （那会让命名板把它们当成"人工合并过的"而不再提示命名）。
 */
const STYLE_MERGES_DDL = `CREATE TABLE IF NOT EXISTS oi_style_merges (
    -- 用途：款合并操作头（一行 = 一次合并，支持撤销还原）；明细见 oi_style_merge_items。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    batch_id TEXT NOT NULL DEFAULT '',
    source_style_id INTEGER NOT NULL,
    target_style_id INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`;

const STYLE_MERGE_ITEMS_DDL = `CREATE TABLE IF NOT EXISTS oi_style_merge_items (
    -- 用途：款合并明细（kind = color 搬色 / key 改键），记 from/to 与 from_state 以支持拆开还原。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    merge_id INTEGER NOT NULL REFERENCES oi_style_merges(id) ON DELETE CASCADE,
    kind TEXT NOT NULL,
    color_id INTEGER NOT NULL DEFAULT 0,
    variant_key TEXT NOT NULL DEFAULT '',
    from_style_id INTEGER NOT NULL DEFAULT 0,
    to_style_id INTEGER NOT NULL DEFAULT 0,
    from_style_color_id INTEGER NOT NULL DEFAULT 0,
    to_style_color_id INTEGER NOT NULL DEFAULT 0,
    from_state TEXT NOT NULL DEFAULT 'auto'
  )`;

const SCHEMA = [
  // ── 变体键 → 款色（2026-10-28，订单驱动归类）────────────────────────────────
  // 这**一张表**同时承担三件事，所以它必须存在（而不是"从订单行现推"）：
  //   ① 幂等：重导同一批订单时，同键必须落回同一个款色，而不是长出一条新款色；
  //   ② 可存活：订单被清理后，键与款色的绑定不能跟着消失（从行现推就做不到）；
  //   ③ 可合并：**N:1 是合法的** —— 真库已有 9 次"一个款色含多个键"的人工合并，
  //      所以映射必须是表，不能靠"同键行的 style_color_id 相同"反推。
  //
  // `state` 三态（都只是**标签**，不参与匹配）：
  //   `auto`   导入自动建（款色名 = 平台色原文，如 `5` / `Khaki` —— 诚实的不确定，等人命名）
  //   `named`  人给过名（`oi_style_colors.color` 已换成自家色名）
  //   `merged` 人显式把它并到别的键的款色上（跨 listing 同款、或同款多色号）
  //
  // ⚠️ `variant_key` 上是 UNIQUE，但**不加外键**到 `oi_order_items`（键是值不是行）——
  //    同键有多行订单，指向任意一行都会随该行删除而级联掉整条记忆。
  VARIANT_KEYS_DDL,
  STYLE_MERGES_DDL,
  STYLE_MERGE_ITEMS_DDL,
  `CREATE INDEX IF NOT EXISTS idx_oi_style_merge_items_merge ON oi_style_merge_items(merge_id)`,
  `CREATE INDEX IF NOT EXISTS idx_oi_style_merges_target ON oi_style_merges(target_style_id)`,
  ORDER_TABLE_DDL,
  `CREATE INDEX IF NOT EXISTS idx_oi_orders_shop ON oi_orders(shop)`,
  ORDER_ITEM_TABLE_DDL,
  `CREATE INDEX IF NOT EXISTS idx_oi_order_items_order ON oi_order_items(order_id)`,
  `CREATE INDEX IF NOT EXISTS idx_oi_order_items_image ON oi_order_items(image_id)`,
  `CREATE INDEX IF NOT EXISTS idx_oi_order_items_sc ON oi_order_items(style_color_id)`,
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
    -- 用途：包裹（一单可多包，按订单行拆；金额/重量缺值为 NULL 不给 0）；总额与总重由 parcelTotals 派生。
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
    -- 用途：拆包明细（包×订单行唯一，拆出的 qty 记在这条）；parcel_id / order_item_id 均级联删除。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    parcel_id INTEGER NOT NULL REFERENCES parcels(id) ON DELETE CASCADE,
    order_item_id INTEGER NOT NULL REFERENCES oi_order_items(id) ON DELETE CASCADE,
    qty INTEGER NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(parcel_id, order_item_id)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_parcel_lines_parcel ON parcel_lines(parcel_id)`,
  `CREATE INDEX IF NOT EXISTS idx_parcel_lines_item ON parcel_lines(order_item_id)`,
  // `oi_styles`：款式主档（一行 = 一个款），`code` 与主 `fingerprint` 均唯一。
  // 写 = 识别落库 / 人工建款 / 款合并（`mergeStylesInto` 只改色与键、不改本行）；读 = 款列表、归类、采购与拣货的款维度汇总。
  // 附加指纹存 `oi_style_fingerprints`（本表单列只放主指纹，供快速匹配）。
  `CREATE TABLE IF NOT EXISTS oi_styles (
    -- 用途：款式识别池（order 域，code 与主指纹唯一）；业务字段权威在 pl_products，本表只存识别私有信息。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    fingerprint TEXT NOT NULL UNIQUE,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  // `oi_style_colors`：款色（款下的一种颜色），PK `id`、编码 `code` 全局唯一、`(style_id,color)` 唯一。
  // 它是订单行 `style_color_id` / 变体键 / 套装部件共同指向的**款色主键**；合并款时改 `style_id` 即"搬色"。
  // 写 = 归类建款色 / 命名 / 合并；读 = 订单、采购需求、拣货、商品映射的全部款色维度。
  //
  // `image_id`（R1 / S0a）：**款色的代表图**（指向主数据域 `md_images`）。旧实现是反过来的
  // —— 图片行上挂 `style_color_id`，于是「一张图只能属于一个款色、一个款色可以有很多图」；
  // 归色改成 1:1 之后，图的生命周期归主数据、归属归业务表，这张表才是那个"业务表"。
  // 0 = 这个色还没有代表图（允许：色可以先建、图后补）。
  `CREATE TABLE IF NOT EXISTS oi_style_colors (
    -- 用途：款色主键（款下一种颜色，code 全局唯一）；订单行 / 变体键 / 套装部件都指向它，合并款时改 style_id 即"搬色"。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    style_id INTEGER NOT NULL REFERENCES oi_styles(id) ON DELETE CASCADE,
    color TEXT NOT NULL,
    code TEXT NOT NULL UNIQUE,
    image_id INTEGER NOT NULL DEFAULT 0,
    UNIQUE(style_id, color)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_oi_style_colors_style ON oi_style_colors(style_id)`,
  // 「这张图是哪个款色的代表图」—— 列表/拿货单/归款判断都按它反查（1:1 的数据，普通索引即可）
  `CREATE INDEX IF NOT EXISTS idx_oi_style_colors_image ON oi_style_colors(image_id)`,
  // 附加款式指纹：用户手动归并款式时，把订单指纹记入目标款式，使后续自动识别也命中该款编码
  // （oi_styles.fingerprint 为主指纹 UNIQUE，无法容纳同一款式的多个识别指纹，故单独成表）
  `CREATE TABLE IF NOT EXISTS oi_style_fingerprints (
    -- 用途：款式附加指纹（人工归并后让后续识别也命中该款；主指纹唯一约束在 oi_styles，故附加指纹单独成表）。
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
    -- 用途：平台色名→自家色名对照（产品级，唯一键 product_id+alias_key）；人工指认一次，归类时查表翻译。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL,
    alias_key TEXT NOT NULL,
    alias_raw TEXT NOT NULL DEFAULT '',
    color TEXT NOT NULL,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(product_id, alias_key)
  )`,
  // ── 套装部件（2026-10-28）─────────────────────────────────────────────────
  // 场景：一件实物由多个**款色**组成（上衣与裤子各自不同款、不同色），平台把它当一个商品卖。
  //
  // 为什么挂在**订单行**而不是图片：款色归属的权威是订单行（`ITEM_STYLE_COLOR_ID`：
  //   订单行优先、图回落；所有列表/采购/拣货都按它 JOIN 款色），
  //   而那张图是"按图找色"的**共享记忆**（内容指纹命中即继承）。一张套装图挂上单个款色后，
  //   同一张图在别的订单里出现就会被读成那个单品 —— 记忆从此被污染，且没有任何地方能纠正它。
  //   所以套装事实必须落在**行级**（这张订单到底买的是哪几件），并且读取时**压过**图级记忆。
  //
  // `style_color_id` 是 `NOT NULL` 而不是 `DEFAULT 0`：0 是 `oi_order_items.style_color_id` 的
  //   "未归属"哨兵；部件没有"未归属"这个合法状态 —— 挂不上款色的部件等于没录，写 0 只会让
  //   下游把它当成一个真实的款色去求和（拿货单上多出一行空白款）。
  //
  // `UNIQUE(order_item_id, role)`：同一件实物里「上衣」只能有一个款色。同部位要两件
  //   （比如套装含两条裤子）用 `qty_per_set=2` 表达，不写两条 —— 两条同 role 会让采购需求算重，
  //   也会让"这个部位是什么款"失去唯一答案。
  //
  // **不存** `bundle_key`：组合键 = 排序后的 `style_color_id` 串，是纯派生值。落库必然与部件表
  //   漂移（改一个部件忘更新键），需要时用 `bundleKeyOf` 现算。
  //
  // 老数据零迁移：表里没行 ⇒ 该行不是套装 ⇒ 读取口径回落图/行的单品款色（见 `itemStyleColorIds`）。
  `CREATE TABLE IF NOT EXISTS oi_item_parts (
    -- 用途：套装部件（订单行×部位→款色，qty_per_set 记套内件数）；表里没行 = 该行不是套装，读取回落单品款色。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    order_item_id INTEGER NOT NULL REFERENCES oi_order_items(id) ON DELETE CASCADE,
    role TEXT NOT NULL,
    style_color_id INTEGER NOT NULL REFERENCES oi_style_colors(id),
    qty_per_set INTEGER NOT NULL DEFAULT 1,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(order_item_id, role)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_oi_item_parts_item ON oi_item_parts(order_item_id)`,
  `CREATE INDEX IF NOT EXISTS idx_oi_item_parts_sc ON oi_item_parts(style_color_id)`,
  VARIANT_KEYS_DDL,
  `CREATE INDEX IF NOT EXISTS idx_oi_variant_keys_sc ON oi_variant_keys(style_color_id)`,
  // 「这一行属于哪个变体键」的查询索引（回填、命名页、重导去重都走它）
  `CREATE INDEX IF NOT EXISTS idx_oi_order_items_variant ON oi_order_items(variant_key)`,
];

/** 幂等初始化：迁移 + 建表/索引 + 款式主数据权威交接（应用启动 / 首次使用自动调用）
 *  顺序不能换：产品表要先存在，交接才有落点（见 migrateStyleAuthority）。 */
export function ensureOrderSchema(): void {
  initDb();
  // house convention：**自定义迁移先跑，再 dbMigrate(SCHEMA)** —— 老库缺列时才能补上，
  // 依赖新增列的索引也就可以安全地留在 SCHEMA 里（见 `migrateColumns` 的旧注释）。
  migrate('order.main', orderMigrationSteps());
  // R1：拆除三张旧图表（`oi_images` / `pl_images` / `pl_item_images`）并把 `oi_order_items`
  // 上那条指向 `oi_images` 的外键一并去掉。顺序两头都卡死：
  //   · 必须排在 **migrate 之后**：迁移链 v1/v6 还要读 `oi_images`；
  //   · 必须排在 **dbMigrate(SCHEMA) 之前**（就是上面那条 house convention）：SCHEMA 里
  //     `idx_oi_style_colors_image` 建在 `oi_style_colors.image_id` 上，而老库的这一列是
  //     本函数补的。2026-10-30 真库事故：先跑 dbMigrate 时老库没有该列 ⇒ 每次启动都在建索引处
  //     抛 `no such column: image_id`，订单域所有 IPC 全灭、retire 永远跑不到。
  retireLegacyImageTables();
  dbMigrate(SCHEMA);
  // 图片收口后的读侧（列表/拿货单取 `md_images.local_path`）直接 JOIN 它 ⇒ 表必须存在。
  // 幂等且开销很小（建表 IF NOT EXISTS + 字典仅在缺失时播种，见 `seedDictionaries`）。
  ensureMasterDataSchema();
  ensureProductSchema();
  // 存量收口：v12 只补了**键**，款色要等产品库就绪才建得出来 ⇒ 放在最后补一次。
  // 幂等（已归的行不再扫）且带 limit，启动路径不会因为老库大而卡住。
  // 不 catch 的是**归款本身**：这里的失败只有"表结构坏"一种，吞掉就变成"看着升级了却没归类"。
  // 但要挡住一个真实场景：`oi_variant_keys` 尚未建出来时（迁移中途异常）不该把启动整死。
  if (tableExists('oi_variant_keys')) backfillVariantStyleColors();
}

const RETIRED_IMAGE_TABLES = ['oi_images', 'pl_images', 'pl_item_images'] as const;

/**
 * **一次性退役三张旧图片表**（R1 / S0a）：图片收口到主数据域的 `md_images`。
 *
 * 为什么不能用一条 `DROP TABLE` 收工：`oi_order_items.image_id` 的旧 DDL 上挂着
 * `REFERENCES oi_images(id) ON DELETE CASCADE`。父表一删，这条外键就指向不存在的表 ——
 * 之后**任何**带 `image_id` 的插入都会以 `FOREIGN KEY constraint failed` 失败
 *（症状是"导入订单全失败"，且报错指向图片表，排查方向整个反掉）。所以先重建明细表，
 * 新 DDL（`ORDER_ITEM_TABLE_DDL`）**本来就不带这条外键**。
 *
 * 两个 SQLite 的硬约束决定了这个函数的形状：
 *   ① `PRAGMA foreign_keys` **在事务内是 no-op**（关不掉）⇒ 必须在事务外切换；
 *   ② `ALTER TABLE ... RENAME` 会**改写别的表里指向它的外键**（`parcel_lines` 指向本表）
 *      ⇒ 只能用「建新表 → 拷数据 → 删旧表 → 改名」这个顺序，不能反过来先改名。
 *
 * 幂等判据：`oi_order_items` 的建表 SQL 里还含 `REFERENCES oi_images` 才重建；
 * `oi_style_colors.image_id` 用 `PRAGMA table_info` 探列（老库要补、新库建表就带）。
 *
 * **存量图片要搬**（2026-10-30 修订，原口径是"清库重建、老图不留"）：真库里有 113 张图、
 * 92 条「图 → 款色」绑定，直接 DROP 等于把人工定款定色的积累清零。搬迁收在
 * `legacy-image-migration.ts`（一次性过渡件，拆表前调用；落盘仍走 `landImageBytes`）。
 * 顺序是硬要求：**先搬完、再建 `oi_style_colors.image_id` 列、再写绑定、最后才 DROP 旧表**。
 */
function retireLegacyImageTables(): void {
  const d = getDb();
  const needRebuild =
    tableExists('oi_order_items') &&
    /REFERENCES\s+oi_images/i.test(tableSql('oi_order_items'));
  const hasRetired = RETIRED_IMAGE_TABLES.some((t) => tableExists(t));
  if (!needRebuild && !hasRetired) return;

  // 旧表是搬迁的唯一数据源 ⇒ 必须在任何 DROP 之前。
  const legacy = migrateLegacyImages();

  const prevFk = d.pragma('foreign_keys', { simple: true }) !== 0;
  d.pragma('foreign_keys = OFF');
  try {
    dbTransaction(() => {
      if (needRebuild) {
        d.exec(
          ORDER_ITEM_TABLE_DDL.replace(
            /^CREATE TABLE IF NOT EXISTS oi_order_items/i,
            'CREATE TABLE oi_order_items_md',
          ),
        );
        // 只拷**老表真实存在**的列：老库可能还没有 `variant_key`（v12 才加）等新列，
        // 按当前列清单硬拷会 `no such column`；新表缺的列由 DDL 的 DEFAULT 兜住。
        const oldCols = new Set(
          (d.prepare(`PRAGMA table_info(oi_order_items)`).all() as { name: string }[]).map((c) =>
            String(c.name),
          ),
        );
        const common = ORDER_ITEM_TABLE_COLUMNS.filter((c) => oldCols.has(c));
        const cols = common.map((c) => `"${c}"`).join(', ');
        d.exec(`INSERT INTO oi_order_items_md (${cols}) SELECT ${cols} FROM oi_order_items`);
        d.exec(`DROP TABLE oi_order_items`);
        d.exec(`ALTER TABLE oi_order_items_md RENAME TO oi_order_items`);
        // 重建后索引随旧表一起没了；SCHEMA 里的 `CREATE INDEX IF NOT EXISTS` 由下面的
        // dbMigrate 重新建出来（放在函数末尾，保证"拆完立刻补回原形状"）。
      }
      // 订单行的图 id 换成 md id：**只能在这里**（旧表带 `REFERENCES oi_images` 外键，
      // 拆表前改写会直接 `FOREIGN KEY constraint failed`，见迁移模块的接口注释）。
      if (needRebuild && tableExists('oi_order_items')) remapOrderItemImages(legacy);
      for (const t of RETIRED_IMAGE_TABLES) {
        if (tableExists(t)) dbRun(`DROP TABLE ${t}`);
      }
      // 款色代表图这一列：新库建表就带；老库要补（补完才能被上面的读写用到）
      const scCols = (
        d.prepare(`PRAGMA table_info(oi_style_colors)`).all() as { name: string }[]
      ).map((c) => String(c.name));
      if (scCols.length && !scCols.includes('image_id')) {
        dbRun(`ALTER TABLE oi_style_colors ADD COLUMN image_id INTEGER NOT NULL DEFAULT 0`);
      }
      // 第 5 步的结论必须**等到这一列存在**才写得进去（新库建表就带，老库由上面补）。
      for (const b of legacy.bindings) {
        dbRun(`UPDATE oi_style_colors SET image_id = ? WHERE id = ?`, [b.imageId, b.styleColorId]);
      }
    });
    // 重建掉的索引/新增列上的索引：把幂等 DDL 再跑一遍（只跑 DDL，不再走迁移）
    dbMigrate(SCHEMA);
  } finally {
    d.pragma(`foreign_keys = ${prevFk ? 'ON' : 'OFF'}`);
  }
  if (legacy.landed > 0 || legacy.remappedOrderItems > 0) {
    console.log(
      `[retire] 旧图搬迁：落 ${legacy.landed} 张（跳过 ${legacy.skipped}）` +
        `，订单行改写 ${legacy.remappedOrderItems}，产品 ${legacy.remappedProducts}` +
        `，款色代表图 ${legacy.bindings.length}` +
        `（同色多图省 ${legacy.droppedBindings}，悬空 ${legacy.danglingBindings}）`,
    );
  }
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
    {
      version: 12,
      name: '订单行 += variant_key（店铺+商品ID+平台色）· 从 raw_fields 回填 · oi_variant_keys 建表',
      up: addVariantKeys,
    },
    {
      version: 13,
      name: '芒果同步：主表 += pay_time/shop_auth_id/deal_deadline/timeout_at · 明细 += item_id/sku_code',
      up: addMangoSyncColumns,
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
 * （见 `docs/notes/2026-10-30-order-classify-panel.md`）⇒ 队列没有任何生产者，
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
 * 一行的变体键：`(店铺, 商品ID, 平台色原文[, 图键])`。
 *
 * 色**优先取 `raw_fields` 里的规格串**（`产品属性:Color:5`），只在解析不出时才吃 `color` 列 ——
 * `color` 列会被人改（真库已有 1 行 `5 → 红色`），而键必须回到事实。
 * 商品ID 的列名族解析复用 `extractSkuFields`（探测规则只能有一份）。
 *
 * `imageUrl`（T0-6）：**只在色名塌陷的链接上有值**。给了就拼第 4 段、不给就是 3 段键。
 * 调用点现状：
 *   · 采集写入（`upsertCollectedOrder`）直接传帧里的 `productImgUrl`；
 *   · v12 存量回填**不传** —— 那 75 行的键已经写好了，重算会改动非塌陷链接的键
 *     （计划 §T0 的警告：本轮不重算存量，只对塌陷链接做定向重算是 M3 T3-6 的事）；
 *   · 导入路径（`upsertOrder`）**不传** —— 导入行手上只有 `imageId`（本机自增），
 *     拿它当键会让同一张图在两台机器上得到不同键；要传也得先反查 `md_images.source_url`，
 *     而那次 JOIN 只会让每行多一次查询、改的却全是已写好的键，没有收益。
 */
function variantKeyOfRow(
  shop: string,
  rawFieldsJson: string,
  colorColumn: string,
  imageUrl?: string,
): string {
  let rf: Record<string, string> = {};
  try {
    const parsed: unknown = JSON.parse(rawFieldsJson || '{}');
    if (parsed && typeof parsed === 'object') rf = parsed as Record<string, string>;
  } catch {
    rf = {};
  }
  const { itemId } = extractSkuFields(rf);
  const colorKey = parseOrderPropsColor(rf) || String(colorColumn ?? '').trim();
  return variantKeyOf({ shopKey: shop, itemKey: itemId, colorKey, imageKey: imageKeyOf(imageUrl) });
}

/**
 * **v12：订单行 + `variant_key`，并把存量回填**（2026-10-28，订单驱动归类 P1）。
 *
 * 键要落库而不是查询时现算，理由见 `ORDER_ITEM_COLS` 里 `variant_key` 的注释。
 * 只写键、**不建款色**：迁移是纯结构步骤，而建款色要碰产品库（那一刻 `pl_products` 可能还没建）；
 * 收口交给 `backfillVariantStyleColors()`，它在 `ensureOrderSchema` 末尾、产品库就绪之后跑。
 */
function addVariantKeys(): void {
  const d = getDb();
  const cols = dbQuery<{ name: string }>(`PRAGMA table_info(oi_order_items)`).map((c) =>
    String(c.name),
  );
  // 新库：自定义迁移**先于** `dbMigrate(SCHEMA)` 跑，此刻明细表还没建出来。
  // 直接空转即可 —— 列与键表都会由 SCHEMA 一次建好（v5/v6 几个迁移也是这么守的）。
  if (!cols.length) return;
  if (!cols.includes('variant_key')) {
    dbRun(`ALTER TABLE oi_order_items ADD COLUMN variant_key TEXT NOT NULL DEFAULT ''`);
  }
  // 回填要有落点；`SCHEMA` 里那条是给新库的，这里补老库
  d.exec(VARIANT_KEYS_DDL);

  const rows = dbQuery<{ id: number; shop: string; raw_fields: string; color: string }>(
    `SELECT oi.id AS id, COALESCE(o.shop, '') AS shop,
            COALESCE(oi.raw_fields, '') AS raw_fields, COALESCE(oi.color, '') AS color
       FROM oi_order_items oi
       LEFT JOIN oi_orders o ON o.id = oi.order_id
      WHERE COALESCE(oi.variant_key, '') = ''`,
  );
  for (const r of rows) {
    const key = variantKeyOfRow(r.shop, r.raw_fields, r.color);
    // 键为空（无商品ID）的行保持空串：它们仍走"未归类"，不会被这把键吞掉
    if (key) dbRun(`UPDATE oi_order_items SET variant_key = ? WHERE id = ?`, [key, r.id]);
  }
}

/**
 * **v13：芒果同步要用的六列**（2026-11-01，M0 T0-1）。
 *
 * 只加列、**不回填**：
 *   · `item_id` / `sku_code` 的存量值在 `raw_fields` 里能捞（导入报表带商品ID），但**不在这里捞** ——
 *     回填口径必须与采集写入同一份实现（`variantKeyOfRow` 那条链），迁移里再写一份就是两套口径。
 *     存量行的键在 v12 已经写过了，这里再算一遍只会让"改了函数但键没变"更难发现；
 *   · `pay_time` / `deal_deadline` 之类导入报表里**根本没有**（芒果独有），回填无从下手。
 *     空串就是空串 —— 与"付款时刻未知"同义，界面显示"未同步"而不是编一个时间。
 *
 * 幂等靠 `PRAGMA table_info` 逐列判，不靠"版本号只跑一次"：脚本/冒烟会拿旧库反复跑
 * `ensureOrderSchema`，而 SQLite 没有 `ADD COLUMN IF NOT EXISTS`，重复 ALTER 会
 * `duplicate column name` —— 那会在用户升级那一刻失败（红线 8）。
 *
 * 新库走 `ORDER_HEADER_COLS` / `ORDER_ITEM_COLS` 直接建列；此刻明细表还没建出来
 * （自定义迁移先于 `dbMigrate(SCHEMA)`），故空表时直接返回。
 */
function addMangoSyncColumns(): void {
  const colsOf = (table: string): Set<string> =>
    new Set(dbQuery<{ name: string }>(`PRAGMA table_info(${table})`).map((c) => String(c.name)));
  const head = colsOf('oi_orders');
  // 主表在、明细表不在是不可能的（拆表迁移 v8 一起建）；但两者可能都还没建（新库）→ 空转
  if (!head.size) return;
  const item = colsOf('oi_order_items');
  const add = (table: string, present: Set<string>, name: string, ddl: string): void => {
    if (present.has(name)) return;
    dbRun(`ALTER TABLE ${table} ADD COLUMN ${ddl}`);
  };
  add('oi_orders', head, 'pay_time', "pay_time TEXT NOT NULL DEFAULT ''");
  add('oi_orders', head, 'shop_auth_id', "shop_auth_id TEXT NOT NULL DEFAULT ''");
  add('oi_orders', head, 'deal_deadline', "deal_deadline TEXT NOT NULL DEFAULT ''");
  add('oi_orders', head, 'timeout_at', "timeout_at TEXT NOT NULL DEFAULT ''");
  add('oi_order_items', item, 'item_id', "item_id TEXT NOT NULL DEFAULT ''");
  add('oi_order_items', item, 'sku_code', "sku_code TEXT NOT NULL DEFAULT ''");
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
    // （`oi_images` 可能已被 R1 退役 ⇒ 先探表，别把一次可选的回填跑成 `no such table`）
    if (tableExists('oi_images')) {
      dbRun(
        `UPDATE oi_orders
            SET style_color_id = COALESCE((SELECT i.style_color_id FROM oi_images i WHERE i.id = oi_orders.image_id), 0)
          WHERE COALESCE(style_color_id, 0) = 0 AND image_id IS NOT NULL`,
      );
    }
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
 * 见 `docs/notes/2026-10-30-db-schema-and-migration.md`）。
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
  // 表不存在（新库 / R1 之后已退役）→ 跳过。不判就会 ALTER 一张没有的表。
  if (imgCols.length === 0) return;
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

// ---- 图片（主数据域 `md_images`）----
//
// R1 起本域**不再拥有图片表**：`oi_images` 已退役（`retireLegacyImageTables`），图片统一落
// `md_images`（`electron/master-data-db.ts`）。这里的三个函数只是**兼容别名**：
// 老调用方（冒烟 / 订单图落地）按原名字调，落到主数据域的唯一实现上，不引第二套去重口径。

/** 按内容指纹查（同一文件字节级去重） */
export function findImageByFingerprint(fingerprint: string): OrderImageRecord | undefined {
  return mdFindImageByFingerprint(fingerprint);
}

/** 按 URL 规范化指纹查（同图不同 URL/签名参数去重） */
export function findImageByUrlFingerprint(urlFingerprint: string): OrderImageRecord | undefined {
  return mdFindImageByUrlFingerprint(urlFingerprint);
}

/**
 * 登记一张**已落盘**的图，返回 `md_images` 主键（`OrderImageId`）。
 *
 * 唯一正当用途见 `registerImageRow` 的注释（文件已经在 `images/` 里）；其余路径一律走
 * `landImageBytes`（唯一落盘入口）。保留本函数名只为不打断既有调用方。
 */
export function insertImage(rec: {
  fingerprint: string;
  urlFingerprint?: string;
  sourceUrl?: string;
  localPath: string;
  source?: string;
}): OrderImageId {
  return registerImageRow(rec).imageId;
}

/**
 * 把一张图绑成某个款色的**代表图**（`oi_style_colors.image_id`），并把结论投影到订单行。
 *
 * R1 的语义变更：归属从「图行上的 `style_color_id`」搬到「色行上的 `image_id`」——
 * 款色 ↔ 图是 **1:1**（一个色只有一张代表图），因此绑定前必须把这张图在**别的**色上的
 * 旧绑定摘掉；否则两行 `image_id` 相同，`findStyleColorImagePath` 的 `LIMIT 1`
 * 会给出"别的色"的图（症状是发错货）。
 *
 * `styleColorId = 0/null` = 解绑（把当前持有这张图的色行摘空），不动订单行上的历史结论
 *（旧实现的 `SET style_color_id = NULL` 在 `COALESCE` 比较下本来也是空操作）。
 */
export function setImageStyleColor(
  imageId: number,
  styleColorId: number | null,
  opts?: { onlyUnset?: boolean },
): void {
  const imgId = Number(imageId) || 0;
  if (!imgId) return;
  const next = Number(styleColorId) || 0;
  dbTransaction(() => {
    dbRun(`UPDATE oi_style_colors SET image_id = 0 WHERE image_id = ? AND id <> ?`, [imgId, next]);
    if (next > 0) dbRun(`UPDATE oi_style_colors SET image_id = ? WHERE id = ?`, [imgId, next]);
  });
  projectImageColorToOrders(imgId, styleColorId, opts);
}

/**
 * 把**图片上的款色结论**投影到订单行（`oi_order_items.style_color_id`）。
 *
 * 为什么要有这一层（2026-10-20）：订单行的款色原先只能经「订单图 → 色图 → 款色」四表 JOIN 派生，
 * 每个消费者各走一遍、各拼一套文本键 ⇒ 3 套需求口径；色名一改，全部文本键失联（用户实报"全待拿"）。
 * 订单行有了 id 列之后，需求/已拿/取图只认 id。
 *
 * 四条纪律：
 *   · **一处写**：所有改「这张图属于哪个款色」的地方都走 `setImageStyleColor` / 本函数
 *     （多一个写者，就回到"同一事实多个写入方"的老坑）；归属本身落在 `oi_style_colors.image_id`。
 *   · **值未变不写**（`WHERE style_color_id <> ?`）：避免每次进页自愈都白写一遍、把 WAL 撑大；
 *   · 一张图可能被多行订单共用（同单同 SKU 拆行）⇒ 按 `image_id` 全量投影，它们是同一个结论；
 *   · **`onlyUnset` 只在"图不是结论源头"时用**（自动按变体键归款、导入后补投影）：
 *     一个商品多个色共用一张主图是常态，那些行的 `variant_key` 不同、结论本来也不同。
 *     全量投影会让后进的那行把先归好的行**改判**（症状：同款两色的单，先导的那色变成后导的色）。
 *     人工改图（识别确认 / 纠正 / 点名归款）要的就是"这张图整片改成 X"，仍走全量。
 */
function projectImageColorToOrders(
  imageId: number | null | undefined,
  styleColorId: number | null,
  opts?: { onlyUnset?: boolean },
): void {
  const imgId = Number(imageId);
  if (!imgId) return;
  const next = Number(styleColorId) || 0;
  dbRun(
    `UPDATE oi_order_items SET style_color_id = ?
      WHERE image_id = ? AND COALESCE(style_color_id, 0) <> ?
      ${opts?.onlyUnset ? 'AND COALESCE(style_color_id, 0) = 0' : ''}`,
    [next, imgId, next],
  );
  // 人工/自动给出的结论同时记进键表：**这是"下次同款同色不用再设一遍"的记忆本体**。
  // 只写这一处（`projectImageColorToOrders` 是全部分类结论的唯一投影点），就不会出现
  // "行上归了、键表没记" ⇒ 重导时又新建一个 provisional 款色的分裂。
  if (next > 0) rememberVariantBinding(next);
}

/**
 * 把「现在**行上就是这个款色**的键」记进 `oi_variant_keys`（**只补新，不改已有**）。
 *
 * 为什么按行上的款色（而不是按 `image_id` 取这张图的全部键）：
 *   一张图可能被**不同变体键**的行共用（一个商品多个色共用一张主图）。按图取键，会把
 *   "图上没有、但键有自己的结论"的那些键也一起绑到这次的值上 —— 记忆从此记错，且
 *   `DO NOTHING` 会让这个错误永久化。按"行上确实持有这个结论"取，作用域与投影一模一样。
 *
 * 为什么用 `DO NOTHING` 而不是覆盖：键表是**记忆**，它的价值在于"上次人做过什么"。
 * 覆盖会让一次误点（把某键临时改到错的款色）永久改写记忆，而正确的那次再也回不来。
 * 要改结论就走"重新归类"（那条路会经 `setImageStyleColor` 再写一次行，但人的显式合并
 * 记在 `state='merged'` 上，语义不同）。
 */
function rememberVariantBinding(styleColorId: number): void {
  if (!tableExists('oi_variant_keys')) return;
  const id = Number(styleColorId) || 0;
  if (id <= 0) return;
  dbRun(
    `INSERT INTO oi_variant_keys (variant_key, style_color_id, state)
     SELECT DISTINCT oi.variant_key, ?, 'auto'
       FROM oi_order_items oi
      WHERE oi.style_color_id = ? AND COALESCE(oi.variant_key, '') <> ''
     ON CONFLICT(variant_key) DO NOTHING`,
    [id, id],
  );
}

/**
 * 从图片反查一次结论并投影（订单落库后用：图可能**在导入前**就已被识别/人工归过色）。
 *
 * 读的是 `oi_style_colors.image_id`（款色代表图 1:1）：一张图最多对应一个款色 ——
 * 这比旧实现更严格，正是 R1 想要的形状（"这张图是什么色"只有一个答案）。
 *
 * **只补空**：图上的结论是"粗"的（一张图可能挂着几个不同变体键的行），它只能补到
 * 还没有结论的行上；已经有结论的行按键更细，不许被图改判。全量把图上的值刷下去，
 * 症状是"先导的那色被后导的那色顶掉"。
 */
function syncOrderClassificationFromImage(imageId: number | null | undefined): void {
  const imgId = Number(imageId);
  if (!imgId) return;
  const row = dbGet<{ id: number }>(
    `SELECT id FROM oi_style_colors WHERE image_id = ? ORDER BY id LIMIT 1`,
    [imgId],
  );
  if (!row) return; // 这张图还没绑色 ⇒ 没有结论可投影（不拿 0 去刷行）
  projectImageColorToOrders(imgId, Number(row.id), { onlyUnset: true });
}

/**
 * 「这条归类结论是**系统猜的、还没人认过**」的**唯一**判据（SQL 片段；`col` 给 `style_color_id` 表达式）。
 *
 * 两条判据，全部取**可重算的事实**，不存标记位、不看名字像不像：
 *   ① 该色上没有任何 `state <> 'auto'` 的键绑定 —— 命名（`named`）/ 人工合并（`merged`）都算人认过；
 *   ② 色名还是订单原文：存在挂在它上面的行，其 `color` 与色名逐字相同 ——
 *      用户在命名板把 `Khaki` 改成 `卡其` 的那一刻，这条就不成立了
 *      （与 `variantNamingBoard` 的 `named` 派生**同一口径**）。
 * 两条都成立才算"猜的"；少一条一律按"人的结论"对待 —— 宁可少改几行，不可推翻人的判定。
 *
 * 为什么必须有它（2026-10-28 P5 收尾实测）：P2 让**导入即归类**以后，图和行上永远有值，
 * 旧判据「未归款 / 占位色」再也不可能成立 ⇒ 「先导订单、后配映射」的回填**静默失效**：
 * 用户配完映射看不到任何变化，和"没配过"长得一模一样（铁律④的静默失败）。
 * 判据必须从"有没有值"换成"这个值是不是猜的"。
 *
 * @param col 必须是能安全内联的**列表达式**（如 `i.style_color_id` / `t.style_color_id`），
 *            不接受外部字符串 —— 本片段直接拼进 SQL。
 */
function guessedScSql(col: string): string {
  return `(COALESCE(${col}, 0) = 0 OR (
    NOT EXISTS (SELECT 1 FROM oi_variant_keys v
                 WHERE v.style_color_id = ${col} AND v.state <> 'auto')
    AND EXISTS (SELECT 1 FROM oi_order_items x
                  JOIN oi_style_colors s2 ON s2.id = ${col}
                 WHERE x.style_color_id = ${col}
                   AND TRIM(COALESCE(x.color, '')) = TRIM(COALESCE(s2.color, '')))
  ))`;
}

/** `guessedScSql` 的 JS 版（同一份判据，靠 `(SELECT ? AS style_color_id)` 造一个单行表来复用片段） */
function isGuessedStyleColor(styleColorId: number): boolean {
  const id = Math.trunc(Number(styleColorId) || 0);
  const r = dbGet<{ g: number }>(
    `SELECT ${guessedScSql('t.style_color_id')} AS g FROM (SELECT ? AS style_color_id) t`,
    [id],
  );
  return Number(r?.g ?? 0) === 1;
}

/**
 * 把一张**已入库**的图采纳为「款色绑定图」（采集建款向导的色图采纳；方案 §8.8 P4 扩展）。
 *
 * 落点与 `autoAssignByMap` 完全同一条：`ensureStyleByCode` + `ensureStyleColor` +
 * `setImageStyleColor` —— 订单归款与采集色图采纳共用同一份款色解析，不引第二套口径
 * （订单按图归色认的款色，与向导采纳绑的款色，必须是同一个东西）。
 *
 * 只补空（两条边界，都是"不换掉已经有的结论"）：
 *   ① **图侧**：这张图已是某个款色的代表图（`oi_style_colors.image_id` 命中）⇒ 不动它。
 *      同图去重会落到同一 `md_images` 行 —— 它可能已被订单识别或上次采纳绑过；
 *   ② **色侧**：目标款色已经有图 ⇒ 不换图（色→图 1:1，后来者不踢掉先来的；
 *      同一色在矩阵里出现多行时，第二条自然落在这里）。
 *
 * @param imageId **`md_images` 的主键**（`OrderImageId`）。品牌类型保留的理由：业务表里的
 *   `image_id` 全是裸 number 列，把"产品 id / 款色 id"误当图片 id 传进来是运行期静默写脏
 *   （历史 P0：拿 `pl_images` 的 id 改判了另一张表的行，回执还报 `bound:true`）。
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
  // 图片必须真实存在（否则传进来的是别域的 id / 已删的行）。**先验再建**：不然一次无效入参
  // 会留下一个空壳款 + 款色行（"没绑上却长出了款"，下次同名色就绑到那个空壳上了）。
  if (!imageIdExists(imageId)) return { bound: false };
  const style = ensureStyleByCode(c);
  const sc = ensureStyleColor(style.id, style.code, col);
  const imgBound = dbGet<{ id: number }>(
    `SELECT id FROM oi_style_colors WHERE image_id = ? LIMIT 1`,
    [imageId],
  );
  if (imgBound) return { bound: false, reason: 'image-bound' };
  const target = dbGet<{ image_id: number }>(
    `SELECT COALESCE(image_id, 0) AS image_id FROM oi_style_colors WHERE id = ?`,
    [sc.id],
  );
  if (Number(target?.image_id ?? 0) > 0) return { bound: false, reason: 'color-bound' };
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
  // 探测语句提到循环外：编码冲突时循环每转一圈就重编译一次同样的 SQL（导入场景下按行触发）
  const existsByCode = d.prepare(`SELECT id FROM oi_style_colors WHERE code = ?`);
  let scCode = `${styleCode}-${colorCode(color)}`;
  let seq = 2;
  while (existsByCode.get(scCode)) {
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
  // 仅空壳才清理：原款下仍有代表图的，保留款式主数据（R1：图挂在色行上，见 `setImageStyleColor`）
  const alive = d
    .prepare(
      `SELECT 1 FROM oi_style_colors sc WHERE sc.style_id = ? AND sc.image_id <> 0 LIMIT 1`,
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
 * 认款顺手把**这个款色当前生效的那张图**采纳为款主图（只补空、不覆盖）。
 *
 * 源的优先级由调用方先算好：有本次订单图 ⇒ 就是它（`setImageStyleColor` 刚绑定）；
 * 订单没图 ⇒ 款色之前已有的图。两者都是用户嘴里"当前款的图片"。
 *
 * 为什么必须在认款这条路上也做：`product-sku-map` 里的同类采纳（`adoptOrderImages`）只覆盖
 * "给商品ID 配产品映射"那条路；归类核对里**点名归款 / 批量定款根本不走映射**（没商品ID 的单
 * 也不该被卡住），于是"已经认过款、产品页还是一张白图"成了常态 —— 用户实报（2026-10-30）。
 *
 * 三条边界与 `adoptOrderImages` 同构：
 *   · **只补空**：判定收在 `adoptProductImageIfEmpty`（`pl_products.image_id = 0` 才写），
 *     已有主图的款绝不覆盖（人挑过的图优先）；
 *   · **失败不外抛**：归属 / 款色 / 回流都已提交，坏一张图不能让人以为"没保存"；
 *   · **无处可采纳就静默跳过**：款色也没图 / 产品库还没有这个编码 ⇒ 下次认款再试。
 */
function adoptStyleColorImageIfEmpty(styleCode: string, imageId: number): void {
  const pid = productIdByCode(styleCode);
  if (!pid || !imageId) return;
  try {
    adoptProductImageIfEmpty(pid, imageId);
  } catch {
    // 图是附加值：失败不留痕（同 `skuBackfillFromOrder` / `rememberColorFromAssignment` 的纪律）
  }
}

/**
 * 手动归并款式：把订单图片挂到指定款编码的对应款色，并把订单指纹记入该款式的附加指纹表，
 * 使后续自动识别也能命中目标款编码（解决同款衣服识别漂移产生多个款编码的问题）。
 * 不改动目标款式的既有主指纹；指纹已被其他款式占用时附加指纹静默忽略（图片归属仍生效）。
 * 归并后原款若因此变空壳，会把其指纹迁入目标款并删除（见 mergeOrphanStyle）。
 *
 * ⭐ **颜色是"以图为准"的记忆落点**（2026-10-10 用户口径：记住订单里的产品图片地址对应的颜色）：
 * 这里写的 `oi_style_colors.image_id` 就是那份记忆 —— 图片行按内容/URL 指纹去重，同一张图
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
  /** 归完后**该款色上生效的图**（`md_images.id`；0 = 这一行和这个款色都没有图）—— 只给顺手采纳款主图用 */
  imageId: number;
  skuBackfill: SkuBackfillOutcome;
  /** 本次顺带记住的「平台色名 → 我的色名」（`null` = 没记 / 无需记） */
  colorAlias: ColorAliasRemembered | null;
  /** 归到**套装款**时自动展开的部位快照（单品行为 `notBundle`；不影响归属是否成功） */
  bundleMaterialize: MaterializeOutcome;
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
      // 探测语句提到循环外（同 ensureStyleColor）：冲突回退时每圈都重编译一次没必要
      const existsByCode = d.prepare(`SELECT id FROM oi_style_colors WHERE code = ?`);
      let scCode = `${style.code}-${colorCode(color)}`;
      let seq = 2;
      while (existsByCode.get(scCode)) {
        scCode = `${style.code}-${colorCode(color)}-${seq}`;
        seq += 1;
      }
      const r = d.prepare(`INSERT INTO oi_style_colors (style_id, color, code) VALUES (?, ?, ?)`).run(style.id, color, scCode);
      sc = { id: Number(r.lastInsertRowid), code: scCode };
    }
    // 改挂前记录图片原归属款（供空壳原款清理使用）：图 → 色行是 1:1，查一张即可
    const prevImg = d
      .prepare(`SELECT id AS id, style_id AS style_id FROM oi_style_colors WHERE image_id = ? ORDER BY id LIMIT 1`)
      .get(order.image_id) as { id: number; style_id: number } | undefined;
    const prevStyleId = Number(prevImg?.style_id) || undefined;
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
    // 归完后款色上**生效**的那张图：有订单图 ⇒ 刚被 `setImageStyleColor` 绑上去的那张；
    // 订单本身没图 ⇒ 这个款色之前已经有的那张（不是 0 —— 用户说的"当前款的图片"就是它）。
    const scImg = d.prepare(`SELECT image_id FROM oi_style_colors WHERE id = ?`).get(sc.id) as
      | { image_id: number }
      | undefined;
    return { styleCode: style.code, styleColorCode: sc.code, imageId: Number(scImg?.image_id) || 0 };
  });
  // ⭐ 认款顺手把**这个款色当前那张图**采纳为款主图（只补空、不覆盖；失败不影响已提交的归属）。
  // 放在事务外：图是附加值，与 `skuBackfill` / `colorAlias` 同一条纪律。
  adoptStyleColorImageIfEmpty(assigned.styleCode, assigned.imageId);
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
  // ⭐ 套装展开（同一条纪律：事务外、失败不影响已提交的归属）：
  //   用户把这一行归到**套装款**后，部件应当自动出现 —— 否则"今天要拿哪些款色码"永远是空的，
  //   而用户得逐个部位手填，等于把产品库已经定义过的目录事实再抄一遍。
  //   它内部**不猜**：色号没配过配色 ⇒ `missingColor` + 一件也不写（宁可当单品等人补）。
  const bundleMaterialize = materializeItemParts(input.orderId);
  return { ...assigned, skuBackfill, colorAlias, bundleMaterialize };
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
            EXISTS (SELECT 1 FROM md_images i WHERE i.id = sc.image_id AND COALESCE(i.local_path,'') <> '') AS has_image
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
 * 所以改名只动标签，`oi_style_colors.id` 与 `oi_style_colors.image_id`（R1 起的代表图）保持原样，
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
 * 按 款编码+款色（+尺码）取一张已下载的图（本地路径），供拿货单编辑器/Excel 导出嵌图；查不到返回 null。
 *
 * ⚠️ `size` 不是装饰，**调用方应当传**（2026-10-11 用户报"拿货单明细的图片都是一样的"）：
 *   · 明细行的粒度是「款色 × 尺码」（`outstanding()` 的聚合键 = `purchase_items` 唯一键），
 *     而订单 Excel 解析出来的图挂在**订单行**上（`oi_order_items.image_id` → 那一件商品自己的图）。
 *   · 只按款色取 ⇒ `ORDER BY i.id DESC LIMIT 1` 永远挑"该款色最新那张"——同一款的多行
 *     （不同尺码、各来自不同商品）会**全显示同一张图**，且多数行显示的还不是自己那件的图。
 *     真库实测（SUST-006·未分类 下挂 4 张不同商品的图）：5 行明细全落到 id 最大那张，**4/5 行是错的**。
 *   · 传了 `size` 就**先**挑「该尺码的订单行用过的那张图」（R1 后色→图是 1:1，
 *     但同一款色在**不同订单行**上仍可能挂不同的图，所以这一档继续保留）；
 *     该尺码下压根没有订单行（手工加的行 / 订单还没导入）才回落到款色的代表图
 *     （`oi_style_colors.image_id`）—— **有图仍优于缺图**，回落只是兜底。
 */
export function findStyleColorImagePath(
  styleCode: string,
  color: string,
  size = '',
  styleColorId = 0,
): string | null {
  const sz = String(size ?? '').trim();
  // 身份优先（2026-10-20）：拿货明细里带了款色 id 就只认它 —— 色名是**会变的标签**
  // （`autoAssignByMap` / 人工核对都会改写），拿它找图会在改名后静默变 null，
  // 症状是"拿货单图片全没了"（用户实报）。id 命中而该色行没图时**返回 null，不回落色名**：
  // 色名回落可能取到**别的色**的图 ⇒ 发错货；缺图只让人去补图，代价小得多。
  let scId = Number(styleColorId) || 0;
  if (scId <= 0) {
    const code = String(styleCode ?? '').trim();
    const clr = String(color ?? '').trim();
    if (!code || !clr) return null;
    const hit = dbGet<{ id: number }>(
      `SELECT sc.id AS id
         FROM oi_styles s
         JOIN oi_style_colors sc ON sc.style_id = s.id
        WHERE s.code = ? AND sc.color = ?
        LIMIT 1`,
      [code, clr],
    );
    scId = Number(hit?.id) || 0;
  }
  if (scId <= 0) return null;
  // ① 该尺码的订单行用过的图（同款多商品：每件的图可能不同）
  if (sz) {
    const bySize = dbGet<{ local_path: string }>(
      `SELECT i.local_path
         FROM oi_order_items oi
         JOIN md_images i ON i.id = oi.image_id
        WHERE oi.size = ?
          AND ${ITEM_STYLE_COLOR_ID} = ?
          AND COALESCE(i.local_path, '') <> ''
        ORDER BY oi.id DESC LIMIT 1`,
      [sz, scId],
    );
    if (bySize?.local_path) return bySize.local_path;
  }
  // ② 款色的代表图（色 → 图 1:1）
  const row = dbGet<{ local_path: string }>(
    `SELECT i.local_path
       FROM oi_style_colors sc
       JOIN md_images i ON i.id = sc.image_id
      WHERE sc.id = ? AND COALESCE(i.local_path, '') <> ''
      LIMIT 1`,
    [scId],
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
        // 探测语句提到循环外（同 ensureStyleColor）：导入时这段按行执行，每行都编译一次纯浪费
        const existsByCode = d.prepare(`SELECT id FROM oi_style_colors WHERE code = ?`);
        let scCode = `${styleCode}-${colorCode(color)}`;
        let seq = 2;
        while (existsByCode.get(scCode)) {
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
         FROM oi_order_items o LEFT JOIN md_images i ON i.id = o.image_id
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
/** 变体键归类的统计（回执 / 排障用；不参与业务判定） */
export interface VariantAssignStats {
  /** 扫到的候选行（键非空且还没归款） */
  candidateRows: number;
  /** 其中被落上款色的行 */
  fixedRows: number;
  /** 本次**新建**的键→款色绑定数（判断"重导会不会涨"看它：稳态应为 0） */
  createdStyleColors: number;
}


/**
 * **存量收口**：把「有键但未归款」的行按变体键归上（幂等；`ensureOrderSchema` 末尾自愈跑一次）。
 *
 * 为什么要有：键是 v12 迁移补写的，而**款色**要在产品库就绪之后才能建（迁移那一刻可能还没有
 * `pl_products`）。两件事分两步，历史 75 行才不会在升级后一直停在"未归类"。
 *
 * `limit`：单次最多处理这么多行 —— 启动路径上的自愈不能因为库里有几万条老数据就卡住启动。
 * 返回的 `candidateRows` 与 `fixedRows` 不等，说明中途有行建不出款（无商品ID / 建表失败），
 * 这种情况要**报出来**而不是静默（回执里能看见）。
 */
export function backfillVariantStyleColors(): VariantAssignStats {
  const stats: VariantAssignStats = { candidateRows: 0, fixedRows: 0, createdStyleColors: 0 };
  if (!tableExists('oi_variant_keys')) return stats;
  // 2026-10-29 回退「导入即归类」：本函数**不再**自动把「有键未归」的行认到款色
  // （那会为每个未配映射的 listing 自动建款色 + 产品占位，且实测出现重复款）。
  // 现在只做一件事：把**人工已归类**的行补记成 `oi_variant_keys` 绑定，
  // 这样重导同一份报表时不会因「缺记忆」而长出第二套款色（与人工那个款分裂）。
  const needBind = dbGet<{ one: number }>(
    `SELECT 1 AS one FROM oi_order_items oi
      WHERE COALESCE(oi.variant_key, '') <> '' AND COALESCE(oi.style_color_id, 0) > 0
        AND NOT EXISTS (SELECT 1 FROM oi_variant_keys v WHERE v.variant_key = oi.variant_key)
      LIMIT 1`,
  );
  if (needBind) {
    dbRun(
      `INSERT INTO oi_variant_keys (variant_key, style_color_id, state)
       SELECT oi.variant_key, MIN(oi.style_color_id), 'auto'
         FROM oi_order_items oi
        WHERE COALESCE(oi.variant_key, '') <> '' AND COALESCE(oi.style_color_id, 0) > 0
        GROUP BY oi.variant_key
       ON CONFLICT(variant_key) DO NOTHING`,
    );
  }
  return stats;
}

// ─────────────────────────────────────────── 命名板（P3）：把「平台原文」变成「人给的词」

/**
 * 一个色键在命名板上的投影（**一个变体键一行**，不是一个订单行一行）。
 *
 * 为什么按键而不是按款色聚合：一个款色可能被多个键指向（那 9 次人工跨 listing 合并就是
 * N:1）。命名板要显示「这个键的平台原文是什么」，而那正是 58 个键各自的事实；
 * 拿款色当行的话，一个色下有 3 个 `5/6/10` 就只能显示其中一个的原文。
 */
export interface VariantColorItem {
  styleColorId: number;
  styleCode: string;
  styleName: string;
  /** 当前落库的色名（可能就是平台原文） */
  colorName: string;
  /** 平台色原文（取该键下订单行的 `color` 列，导入时原样落的值） */
  colorRaw: string;
  /**
   * 是否**已经有人给过名字**。
   *
   * 派生，不存档：`colorName` 与 `colorRaw` 不同 ⇒ 有人改过。
   * 为什么不读 `oi_variant_keys.state`：存量那 65 行是人工归类后回填的绑定，`state` 一律
   * 写成 `auto`（写的时候不知道人改没改过），拿它判"未命名"会把 13 个人工色名也算成待办。
   * 而"名字还是不是平台原文"是能从数据本身重算的事实，且改名后立刻成立。
   */
  named: boolean;
  /** 该键下的订单行数 */
  orderRows: number;
  /** 该键下的件数（`SUM(qty)`；为 0 时用行数兜，见下方注释） */
  qty: number;
  /** 代表图（本地路径，渲染层用 `orderImageThumbBatch` 换成 dataURL） */
  localPath: string;
}

/** 命名板的一组 = 一个 listing（`店铺 + 商品ID`）下的全部色键 */
export interface VariantNamingGroup {
  shop: string;
  itemId: string;
  /** 产品标题（`raw_fields` 里那一行；取不到时回落商品ID，**不冒充款名**） */
  title: string;
  /**
   * 组内各色共属的款 id（`0` = 这组的色分属多个款 —— 人工做过跨 listing 合并，
   * 整组改款名/厂家会改到别人头上，所以那种情况不给整组编辑入口）。
   */
  styleId: number;
  styleCode: string;
  /** 款名（权威在 `pl_products.name`；占位款为空串 = 还没人给它起名） */
  styleName: string;
  /** 厂家 id（0 = 未指定）。拿货按厂家统计靠它，缺了这些款就落在「未指定厂家」里 */
  supplierId: number;
  /** 组内涉及的款数（>1 时说明这是合并过的组，界面据此说明为什么不能整组改） */
  styleCount: number;
  colors: VariantColorItem[];
}

export interface VariantNamingBoard {
  groups: VariantNamingGroup[];
  /** 这一批里还没人给过名字的**键**数（页签角标 / 折叠标题读它） */
  unnamedKeys: number;
  /** 这一批参与统计的键总数（分母；两者相等时说明"全都命名过了"） */
  totalKeys: number;
}

/**
 * 命名板取数：按 listing 分组，组内是色键。
 *
 * 四条口径：
 *   ① **只取有键的**（`oi_variant_keys` 是记忆本体），没有键的款色不在这里出现 ——
 *      它们的归属不由订单驱动，给了入口反而会让人以为能在这一页重建。
 *   ② `colorRaw` 取该键下订单行的 `color`（导入时原样落库的值），**不从键里反解**：
 *      键里的色段是 `toNameKey` 归一过的（`Khaki` → `khaki`），拿来展示会让人以为
 *      平台写的就是小写。
 *   ③ `title` 用 `extractSkuFields`（与导入 / 采集同**一份**实现）：标题不是键，只用于
 *      "这行是哪个商品"的可读性，所以取不到就回落商品ID，不猜。
 *   ④ `importDate`（2026-10-30）：只算**这一批导入日**里的订单行 —— 键表是**跨批次的记忆**，
 *      不筛的话命名板会把十几天累积的键全铺出来（真库实测 59 个键横跨 10-05 → 10-28），
 *      而下面那张核对表只显示今天的导入日。两处口径必须一样，否则"这一屏要我做什么"
 *      和"下面这批是什么"对不上。传空串 = 不筛（订单库冒烟与历史调用走这条）。
 */
export function variantNamingBoard(limit = 400, importDate = ''): VariantNamingBoard {
  if (!tableExists('oi_variant_keys')) return { groups: [], unnamedKeys: 0, totalKeys: 0 };
  // 与 `listPending` 同一条正则/同一个日期字段口径（`date(o.created_at)` 是导入日，不是下单日）
  const day =
    typeof importDate === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(importDate) ? importDate : '';
  // 把"这一批的订单行"先收成一个 CTE：下面 6 个子查询各自写一遍日期条件的话，
  // 漏掉任何一处都会让"件数/行数/原文"来自别的批次 —— 而界面上看不出来。
  const batchSql = `SELECT x.id AS id, x.variant_key AS variant_key, x.qty AS qty, x.color AS color,
                           x.raw_fields AS raw_fields, x.image_id AS image_id,
                           COALESCE(o.shop, '') AS shop
                      FROM oi_order_items x
                      JOIN oi_orders o ON o.id = x.order_id
                     ${day ? 'WHERE date(o.created_at) = ?' : ''}`;
  const rows = dbQuery<{
    variant_key: string;
    style_color_id: number;
    style_id: number;
    color_name: string;
    style_code: string;
    shop: string;
    order_rows: number;
    qty: number;
    color_raw: string;
    local_path: string;
    raw_fields: string;
    state: string;
  }>(
    `WITH it AS (${batchSql})
     SELECT v.variant_key AS variant_key,
            v.style_color_id AS style_color_id,
            COALESCE(sc.style_id, 0) AS style_id,
            COALESCE(sc.color, '') AS color_name,
            COALESCE(st.code, '') AS style_code,
            COALESCE(v.state, 'auto') AS state,
            (SELECT it.shop FROM it WHERE it.variant_key = v.variant_key LIMIT 1) AS shop,
            (SELECT COUNT(*) FROM it WHERE it.variant_key = v.variant_key) AS order_rows,
            (SELECT COALESCE(SUM(COALESCE(it.qty, 0)), 0)
               FROM it WHERE it.variant_key = v.variant_key) AS qty,
            (SELECT MAX(COALESCE(it.color, ''))
               FROM it WHERE it.variant_key = v.variant_key) AS color_raw,
            (SELECT COALESCE(i.local_path, '')
               FROM it JOIN md_images i ON i.id = it.image_id
              WHERE it.variant_key = v.variant_key AND COALESCE(i.local_path, '') <> ''
              ORDER BY it.id LIMIT 1) AS local_path,
            (SELECT COALESCE(it.raw_fields, '')
               FROM it WHERE it.variant_key = v.variant_key
              ORDER BY it.id LIMIT 1) AS raw_fields
       FROM oi_variant_keys v
       JOIN oi_style_colors sc ON sc.id = v.style_color_id
       JOIN oi_styles st ON st.id = sc.style_id
      WHERE EXISTS (SELECT 1 FROM it WHERE it.variant_key = v.variant_key)
      ORDER BY v.variant_key
      LIMIT ?`,
    day ? [day, Math.max(1, Number(limit) || 400)] : [Math.max(1, Number(limit) || 400)],
  );

  const prodMeta = productMetaMap();
  const catalogTitles = shopItemTitleMap(rows.map((r) => splitVariantKey(r.variant_key).itemKey));
  const groups = new Map<string, VariantNamingGroup>();
  /** 组 → 该组涉及的全部款 id（用来判"这组的色是不是分属几个款"） */
  const groupStyles = new Map<string, Set<number>>();
  let unnamedKeys = 0;
  for (const r of rows) {
    const parts = splitVariantKey(r.variant_key);
    const shop = String(r.shop ?? '').trim() || parts.shopKey;
    const itemId = parts.itemKey;
    if (!itemId) continue; // 键里没商品ID（不该有：`variantKeyOf` 就不产出这种键）⇒ 不入板
    let rf: Record<string, string> = {};
    try {
      const parsed: unknown = JSON.parse(r.raw_fields || '{}');
      if (parsed && typeof parsed === 'object') rf = parsed as Record<string, string>;
    } catch {
      rf = {};
    }
    const { title } = extractSkuFields(rf);
    const shownTitle = title || productTitleOf(rf) || catalogTitles.get(itemId) || '';
    const colorRaw = String(r.color_raw ?? '').trim();
    const colorName = String(r.color_name ?? '').trim();
    // "未命名" = 名字仍是**平台原文**（或仍是兜底占位）。空原文的键在导入时被写成
    // `未分类`，所以那一档要跟兜底常量比，否则空色键永远算"已命名"。
    const named =
      String(r.state ?? '') !== 'auto' ||
      (colorRaw
        ? toNameKey(colorName) !== toNameKey(colorRaw)
        : toNameKey(colorName) !== toNameKey(MAPPED_FALLBACK_COLOR));
    if (!named) unnamedKeys += 1;
    const gk = `${shop}\u0000${itemId}`;
    let g = groups.get(gk);
    if (!g) {
      g = {
        shop,
        itemId,
        title: shownTitle || itemId,
        styleId: 0,
        styleCode: String(r.style_code ?? ''),
        styleName: '',
        supplierId: 0,
        styleCount: 0,
        colors: [],
      };
      groups.set(gk, g);
      groupStyles.set(gk, new Set());
    }
    const sid = Number(r.style_id) || 0;
    if (sid) groupStyles.get(gk)?.add(sid);
    g.colors.push({
      styleColorId: Number(r.style_color_id) || 0,
      styleCode: String(r.style_code ?? ''),
      styleName: prodMeta.get(String(r.style_code ?? ''))?.name ?? '',
      colorName,
      colorRaw,
      named,
      orderRows: Number(r.order_rows) || 0,
      // `SUM(qty)` 在存量行上可能全为 NULL（早期导入没写件数）⇒ 用行数兜，
      // 不能让命名板显示"0 件"——那会让人以为这批货没量、不值得命名。
      qty: Number(r.qty) || Number(r.order_rows) || 0,
      localPath: String(r.local_path ?? ''),
    });
  }

  const list = [...groups.values()];
  // 款信息（组级）：只有全组的色都挂在**同一个款**下，才允许整组改款名/厂家 ——
  // 那种 1 个 listing 的色被人工分到两个款的组（跨 listing 合并的产物）如果也给你一个
  // 输入框，保存一次就会把另一个款的名字/厂家一起改掉，而界面上完全看不出来。
  for (const g of list) {
    const ids = groupStyles.get(`${g.shop}\u0000${g.itemId}`) ?? new Set<number>();
    g.styleCount = ids.size;
    if (ids.size === 1) {
      g.styleId = [...ids][0];
      const meta = prodMeta.get(g.styleCode);
      g.styleName = meta?.name ?? '';
      g.supplierId = meta?.supplierId ?? 0;
    }
  }
  // 组内：未命名的排前面（要人做的事在眼前），同状态按平台原文排（同一 listing 的
  // `1/2/3` 是连续的，人读起来像在核对一个色卡）。
  for (const g of list) {
    g.colors.sort((a, b) => {
      if (a.named !== b.named) return a.named ? 1 : -1;
      return a.colorRaw.localeCompare(b.colorRaw, 'zh-Hans-CN', { numeric: true });
    });
  }
  // 组间：有待办的排前面；同为待办时按键数多的在前（一屏内先解决大头）
  list.sort((a, b) => {
    const ua = a.colors.filter((c) => !c.named).length;
    const ub = b.colors.filter((c) => !c.named).length;
    if (ua !== ub) return ub - ua;
    return a.itemId.localeCompare(b.itemId);
  });
  return { groups: list, unnamedKeys, totalKeys: rows.length };
}

/**
 * 商品ID → 采集库里的标题（**第三顺位**兜底，只用于展示）。
 *
 * 真库实测它只覆盖 37 个商品里的 3 个（`pl_shop_items` 是采集来的，与订单不是同一批），
 * 所以它排在「订单原文的产品信息首行」之后 —— 订单自己的原文才是这批单的共同事实。
 */
function shopItemTitleMap(itemIds: string[]): Map<string, string> {
  const out = new Map<string, string>();
  const ids = [...new Set(itemIds.map((s) => String(s ?? '').trim()).filter(Boolean))];
  if (!ids.length || !tableExists('pl_shop_items')) return out;
  const holes = ids.map(() => '?').join(',');
  for (const r of dbQuery<{ item_id: string; title: string }>(
    `SELECT item_id, title FROM pl_shop_items
      WHERE item_id IN (${holes}) AND COALESCE(title, '') <> ''`,
    ids,
  )) {
    const id = String(r.item_id ?? '');
    const t = String(r.title ?? '').trim();
    // 同一 itemId 多处采集时取最长的标题（与 `queueGroups` 同一取舍：更长的信息更多）
    if (id && t && t.length > (out.get(id)?.length ?? 0)) out.set(id, t);
  }
  return out;
}

/** 款编码 → { 款名, 厂家 }（命名板显示与「未指定厂家」计数用；产品库没建时返回空表，不报错） */
function productMetaMap(): Map<string, { name: string; supplierId: number }> {
  const out = new Map<string, { name: string; supplierId: number }>();
  if (!productSchemaReady()) return out;
  for (const r of dbQuery<{ code: string; name: string; supplier_id: number }>(
    `SELECT code, name, supplier_id FROM pl_products WHERE code <> ''`,
  )) {
    const code = String(r.code ?? '');
    if (!code) continue;
    out.set(code, {
      name: String(r.name ?? '').trim(),
      supplierId: Number(r.supplier_id) || 0,
    });
  }
  return out;
}

export interface RenameColorOutcome {
  ok: boolean;
  error?: string;
  styleColorId: number;
  name: string;
  /** 这次改名覆盖到的键数（N:1 合并过的色会一次改到多行） */
  keys: number;
}

/**
 * 给一个款色起名（命名板唯一的写入口）。
 *
 * 四条纪律：
 *   ① **只改 `oi_style_colors.color`，不改 `code`**：`code` 是拿货单/对账引用的稳定标识
 *      （形如 `SUST-001-5`），跟着改会让历史单据指向一个不存在的编码。现有库里就有先例
 *      （`color=深蓝` 而 `code=SUST-001-5`）。
 *   ② **同款下不允许重名**：`oi_style_colors` 本来就有 `UNIQUE(style_id, color)`，重名会被
 *      SQLite 自己拦下 —— 但拦下来的是 `UNIQUE constraint failed: oi_style_colors.style_id,
 *      oi_style_colors.color` 这种原话（变异测试真跑出来过第 2761 行那条断言就是这么红的），
 *      界面只能原样吐给用户。这里提前判一次，是为了给一句能照着做的话：
 *      **要合并去「映射与关联」，这里只负责起名**。
 *   ③ **空名/超长一律拒绝**：空名会让下游 `if (!color)` 的分支把这一行重新当"没色"
 *      （拿货、算钱都读它），等于把刚做完的事撤销掉。
 *   ④ 顺带把该款色下所有键的 `state` 置 `named` —— 它是"人碰过这条"的记账，
 *      不参与匹配（匹配只用 `variant_key`）。
 */
export function renameStyleColor(styleColorId: number, name: unknown): RenameColorOutcome {
  const id = Number(styleColorId) || 0;
  const next = String(name ?? '').trim();
  const fail = (error: string): RenameColorOutcome => ({ ok: false, error, styleColorId: id, name: next, keys: 0 });
  if (id <= 0) return fail('invalid styleColorId');
  if (!next) return fail('色名不能为空');
  if (next.length > 40) return fail('色名太长（最多 40 字）');
  const row = dbGet<{ id: number; style_id: number; color: string }>(
    `SELECT id, style_id, COALESCE(color, '') AS color FROM oi_style_colors WHERE id = ?`,
    [id],
  );
  if (!row) return fail('款色不存在（可能已被删除）');
  const styleId = Number(row.style_id) || 0;
  // 同款重名守卫：**排除自己**（改回同一个名字是幂等操作，不该报错）
  const dup = dbGet<{ id: number; code: string }>(
    `SELECT id, code FROM oi_style_colors WHERE style_id = ? AND color = ? AND id <> ? LIMIT 1`,
    [styleId, next, id],
  );
  if (dup) return fail(`这个款下已经有同名颜色了（${String(dup.code)}），要合并请用「映射与关联」`);
  if (String(row.color ?? '') === next) {
    // 幂等：目标值 == 现值 ⇒ 不写。派生非幂等就必然漂移（重名检查、state 记账都别重复做）
    const keys = Number(
      dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM oi_variant_keys WHERE style_color_id = ?`, [id])?.n ?? 0,
    );
    return { ok: true, styleColorId: id, name: next, keys };
  }
  const keys = dbTransaction(() => {
    dbRun(`UPDATE oi_style_colors SET color = ? WHERE id = ?`, [next, id]);
    dbRun(
      `UPDATE oi_variant_keys SET state = 'named', updated_at = datetime('now','localtime')
        WHERE style_color_id = ? AND state = 'auto'`,
      [id],
    );
    return Number(
      dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM oi_variant_keys WHERE style_color_id = ?`, [id])?.n ?? 0,
    );
  });
  return { ok: true, styleColorId: id, name: next, keys };
}

export interface SaveStyleBasicsOutcome {
  ok: boolean;
  error?: string;
  styleId: number;
  /** 款编码（`oi_styles.code` ≡ `pl_products.code`，写产品主数据靠它定位） */
  styleCode: string;
  name: string;
  supplierId: number;
}

/**
 * 给一个**款**起名 / 指定厂家（命名板组头的写入口）。
 *
 * 为什么这两件事同一个入口：它们在同一条判断链上 —— 人看的是一个 listing 的图，
 * 心里同时决定了"这是个什么款"和"从哪家拿"。分成两个入口就得在同一处点两次、
 * 而两次之间界面还可能被别的刷新打断。
 *
 * 落点纪律：
 *   ① **只写产品主数据**（`pl_products.name` / `supplier_id`），`oi_styles` 只读不写 ——
 *      款名/厂家的唯一权威在产品域（见文件头 ADR-002 C1），订单库再存一份就是两套口径。
 *   ② 走**窄接口** `renameProduct` / `moveProductSupplier`，不整行 upsert：
 *      全量 upsert 会把没展示的列按默认值重置（静默清空比报错更难查）。
 *   ③ **幂等**：目标值 == 现值就不写（重导/重复回车不该产生 updated_at 抖动）。
 *   ④ `supplierId` 只在**显式传入**时改（`undefined` = 不动），而 `0` 是合法的"清空厂家"。
 *   ⑤ 厂家不存在时 `moveProductSupplier` 会抛 —— 这里接住转成人话，别让 IPC 层吐英文栈。
 */
export function saveStyleBasics(
  styleId: number,
  patch: { name?: unknown; supplierId?: unknown } = {},
): SaveStyleBasicsOutcome {
  const id = Number(styleId) || 0;
  const name = patch?.name === undefined ? undefined : String(patch.name ?? '').trim();
  const supplierId = patch?.supplierId === undefined ? undefined : Number(patch.supplierId);
  const fail = (error: string, code = ''): SaveStyleBasicsOutcome => ({
    ok: false,
    error,
    styleId: id,
    styleCode: code,
    name: name ?? '',
    supplierId: 0,
  });
  if (id <= 0) return fail('invalid styleId');
  if (name !== undefined && name.length > 60) return fail('款名太长（最多 60 字）');
  if (supplierId !== undefined && (!Number.isFinite(supplierId) || supplierId < 0)) {
    return fail('厂家参数不合法');
  }
  if (name === undefined && supplierId === undefined) return fail('没有要改的内容');
  const row = dbGet<{ code: string }>(`SELECT COALESCE(code, '') AS code FROM oi_styles WHERE id = ?`, [id]);
  if (!row) return fail('款不存在（可能已被删除）');
  const code = String(row.code ?? '').trim();
  if (!code) return fail('这个款没有编码，挂不上产品主数据');
  ensureProductSchema();
  // ⚠️ 两步必须**同一个事务**：改款名在 `pl_products.name`，改厂家要顺带校验"厂家存在吗"。
  //    先写名再校验厂家的写法，在厂家不存在时会把名字留在库里、却回一个 `ok:false`
  //    —— 界面说"没保存"，库里已经变了（冒烟 [15] 的变异测试真跑出来过）。
  try {
    dbTransaction(() => {
      if (name !== undefined) renameProduct(code, name);
      if (supplierId !== undefined) moveProductSupplier(code, supplierId);
    });
  } catch (e: unknown) {
    return fail(e instanceof Error ? e.message : '保存失败', code);
  }
  const after = dbGet<{ name: string; supplier_id: number }>(
    `SELECT COALESCE(name, '') AS name, COALESCE(supplier_id, 0) AS supplier_id
       FROM pl_products WHERE code = ?`,
    [code],
  );
  return {
    ok: true,
    styleId: id,
    styleCode: code,
    name: String(after?.name ?? ''),
    supplierId: Number(after?.supplier_id) || 0,
  };
}

// ── 款合并（P4）：同厂家下 N 个"其实是同一件货"的款 → 1 个，且可拆 ──────────────
//
// 为什么必须存在：默认 **1 个 listing = 1 个款**，这是"导入即可统计"的前提，代价是
// 同款开了 3 个链接就变成 3 个款（真库 47 个 listing 收敛后本该是 12 个款）。
// 合并只影响"按款汇总"的口径，不影响任何原始数据 —— 所以它**不是门**，不做也能拿货。

/** 候选合并里的一个款（够人眼判断"是不是同一件货"的信息，不多也不少） */
export interface MergeStyleBrief {
  styleId: number;
  styleCode: string;
  /** 款名（空串 = 占位款，还没起名） */
  styleName: string;
  /** 挂在这个款下的变体键数（= 几个 listing×色） */
  keyCount: number;
  /** 款下色数（含不挂键的历史色） */
  colorCount: number;
  /** 涉及的订单行数 */
  rowCount: number;
  /** 色名/平台原文（最多 10 个，界面按顺序摊开，用来比"这两批色像不像"） */
  colors: string[];
  /** 示例图（本地绝对路径，可能空：采集通道的行没有图） */
  imagePath: string;
}

/** 同厂家下的一组候选（`styles.length >= 2` 才出组） */
export interface MergeCandidateGroup {
  supplierId: number;
  supplierName: string;
  styles: MergeStyleBrief[];
}

/** 一次已发生的合并（撤销入口的数据面）；一次操作 = 一条记录，可能含多个源款 */
export interface StyleMergeRecord {
  /** 批次 id（撤销按它，**不是**按行 id：一次 N→1 会写 N 行，按行拆只能拆掉最后一个） */
  batchId: string;
  targetStyleId: number;
  targetStyleCode: string;
  /** 并进来的源款（顺序 = 合并顺序） */
  sources: Array<{ styleId: number; styleCode: string }>;
  /** 搬过去的色数 */
  movedColors: number;
  /** 改指的键数 */
  movedKeys: number;
  createdAt: string;
}

export interface StyleMergeBoard {
  groups: MergeCandidateGroup[];
  merges: StyleMergeRecord[];
}

export interface MergeStylesOutcome {
  ok: boolean;
  error?: string;
  /** 本批次的 id（空串 = 没发生合并） */
  batchId: string;
  targetStyleId: number;
  /** 搬过去的色数 + 改指的键数（回执文案用） */
  movedColors: number;
  movedKeys: number;
}

export interface UnmergeOutcome {
  ok: boolean;
  error?: string;
  /** 还原成功的明细数（色 + 键） */
  restored: number;
  /** 跳过的明细数（键已被后续合并改指 / 色已被删） */
  skipped: number;
}

/** 色名比较键：合并判定"同名色"用；不转小写会把 `Khaki` 与 `khaki` 当成两个色 */
function colorKey(raw: unknown): string {
  const k = toNameKey(String(raw ?? '')).toLowerCase();
  // 空色名也必须有键：否则同名判定退化成"每次都不匹配"，搬色时撞
  // `UNIQUE(style_id, color)`（真库里色名都有值，这是给脏数据留的兜底）
  return k || '\u0000';
}

function styleBriefOf(styleId: number, code: string, meta: Map<string, { name: string; supplierId: number }>): MergeStyleBrief {
  const id = Number(styleId) || 0;
  const keyCount =
    dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM oi_variant_keys WHERE style_color_id IN
      (SELECT id FROM oi_style_colors WHERE style_id = ?)`, [id])?.n ?? 0;
  const colors = dbQuery<{ color: string; id: number }>(
    `SELECT id, COALESCE(color, '') AS color FROM oi_style_colors WHERE style_id = ? ORDER BY id`,
    [id],
  );
  const rowCount =
    dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM oi_order_items WHERE variant_key IN
      (SELECT variant_key FROM oi_variant_keys WHERE style_color_id IN
        (SELECT id FROM oi_style_colors WHERE style_id = ?))`, [id])?.n ?? 0;
  const imagePath =
    dbGet<{ p: string }>(
      `SELECT COALESCE(i.local_path, '') AS p
         FROM oi_order_items x
         JOIN oi_variant_keys v ON v.variant_key = x.variant_key
         JOIN md_images i ON i.id = x.image_id
        WHERE v.style_color_id IN (SELECT id FROM oi_style_colors WHERE style_id = ?)
          AND COALESCE(i.local_path, '') <> ''
        ORDER BY x.id LIMIT 1`,
      [id],
    )?.p ?? '';
  return {
    styleId: id,
    styleCode: code,
    styleName: meta.get(code)?.name ?? '',
    keyCount: Number(keyCount) || 0,
    colorCount: colors.length,
    rowCount: Number(rowCount) || 0,
    colors: colors.map((c) => String(c.color ?? '').trim()).filter(Boolean).slice(0, 10),
    imagePath: String(imagePath ?? ''),
  };
}

/**
 * 同厂家下 ≥2 个款的组（还没合并的）。
 *
 * ⚠️ 只按厂家分组，**不做任何"看起来像同款"的猜测**：真库实测 CLIP 判色 AUC 0.522，
 * 用视觉相似度提议合并等于掷硬币，而错并比拆更难发现（拆的入口在，但人不会去拆一个
 * "看着挺对"的合并）。所以这里给的是**候选**，判断留给人。
 *
 * 只统计"有键的款"：合并后源款键数归零，自然从候选里消失（不会反复提示已合过的组）。
 */
export function styleMergeCandidates(supplierLimit = 200): MergeCandidateGroup[] {
  if (!tableExists('oi_variant_keys')) return [];
  const styles = dbQuery<{ style_id: number; code: string }>(
    `SELECT sc.style_id AS style_id, COALESCE(st.code, '') AS code
       FROM oi_variant_keys v
       JOIN oi_style_colors sc ON sc.id = v.style_color_id
       JOIN oi_styles st ON st.id = sc.style_id
      GROUP BY sc.style_id
      ORDER BY sc.style_id`,
  );
  if (!styles.length) return [];
  const meta = productMetaMap();
  const bySupplier = new Map<number, MergeStyleBrief[]>();
  for (const s of styles) {
    const code = String(s.code ?? '').trim();
    const supplierId = meta.get(code)?.supplierId ?? 0;
    if (supplierId <= 0) continue; // 没指定厂家的款不参与（"同厂家"是这组候选的唯一依据）
    const list = bySupplier.get(supplierId) ?? [];
    list.push(styleBriefOf(Number(s.style_id), code, meta));
    bySupplier.set(supplierId, list);
  }
  const supNames = new Map<number, string>();
  if (bySupplier.size && tableExists('suppliers')) {
    const ids = [...bySupplier.keys()];
    for (const r of dbQuery<{ id: number; name: string }>(
      `SELECT id, COALESCE(name, '') AS name FROM suppliers WHERE id IN (${ids.map(() => '?').join(',')})`,
      ids,
    )) {
      supNames.set(Number(r.id), String(r.name ?? ''));
    }
  }
  const out: MergeCandidateGroup[] = [];
  for (const [supplierId, list] of bySupplier) {
    if (list.length < 2) continue; // 一个款没有"合并"可言
    out.push({
      supplierId,
      supplierName: supNames.get(supplierId) ?? `#${supplierId}`,
      // 款多（同厂家十几款）时按"挂的键多"排，人最可能先认出量大的那批
      styles: list.slice().sort((a, b) => b.keyCount - a.keyCount || a.styleCode.localeCompare(b.styleCode)),
    });
  }
  return out
    .sort((a, b) => b.styles.length - a.styles.length || a.supplierName.localeCompare(b.supplierName))
    .slice(0, Math.max(1, Number(supplierLimit) || 200));
}

/** 候选 + 已有的合并记录（拿货页那一块的全部数据面） */
export function styleMergeBoard(): StyleMergeBoard {
  const merges: StyleMergeRecord[] = tableExists('oi_style_merges')
    ? (() => {
        const heads = dbQuery<Record<string, unknown>>(
          `SELECT m.batch_id AS batch_id,
                  m.target_style_id AS tgt,
                  COALESCE(t.code, '') AS tgt_code,
                  MIN(m.created_at) AS created_at,
                  (SELECT COUNT(*) FROM oi_style_merge_items i
                     JOIN oi_style_merges x ON x.id = i.merge_id
                    WHERE x.batch_id = m.batch_id AND i.kind = 'color') AS moved_colors,
                  (SELECT COUNT(*) FROM oi_style_merge_items i
                     JOIN oi_style_merges x ON x.id = i.merge_id
                    WHERE x.batch_id = m.batch_id AND i.kind = 'key') AS moved_keys
             FROM oi_style_merges m
             LEFT JOIN oi_styles t ON t.id = m.target_style_id
            GROUP BY m.batch_id, m.target_style_id
            ORDER BY MAX(m.id) DESC
            LIMIT 200`,
        );
        return heads.map((r) => {
          const batchId = String(r.batch_id ?? '');
          const sources = dbQuery<{ id: number; code: string }>(
            `SELECT m.source_style_id AS id, COALESCE(s.code, '') AS code
               FROM oi_style_merges m LEFT JOIN oi_styles s ON s.id = m.source_style_id
              WHERE m.batch_id = ? ORDER BY m.id`,
            [batchId],
          ).map((s) => ({ styleId: Number(s.id) || 0, styleCode: String(s.code ?? '') }));
          return {
            batchId,
            targetStyleId: Number(r.tgt) || 0,
            targetStyleCode: String(r.tgt_code ?? ''),
            sources,
            movedColors: Number(r.moved_colors) || 0,
            movedKeys: Number(r.moved_keys) || 0,
            createdAt: String(r.created_at ?? ''),
          };
        });
      })()
    : [];
  return { groups: styleMergeCandidates(), merges };
}

/**
 * 把 `sourceStyleIds` 全部并进 `targetStyleId`（一次 N→1）。
 *
 * 色配对只按**同名**（归一化后相等），不按位置也不按相似度：
 *   · 同名 ⇒ 改键（源色留下不删，否则拆不回去）；
 *   · 不同名 ⇒ 搬色（`style_id` 改到目标款，色 id 不变 ⇒ 键与订单行零改动）。
 *
 * 两条都不猜"这两个色其实是同一个"：猜错会让两个不同色的库存并成一色，
 * 而拿货单照样能打印、照样能下单 —— 错得悄无声息，正是这轮改造要消灭的那类问题。
 * 剩下的色由人在命名板里改个同名，再合一次即可。
 */
export function mergeStylesInto(targetStyleIdRaw: unknown, sourceStyleIdsRaw: unknown): MergeStylesOutcome {
  const target = Number(targetStyleIdRaw) || 0;
  const srcIds = [
    ...new Set(
      (Array.isArray(sourceStyleIdsRaw) ? sourceStyleIdsRaw : [])
        .map((n) => Number(n) || 0)
        .filter((n) => n > 0 && n !== target),
    ),
  ];
  const fail = (error: string): MergeStylesOutcome => ({
    ok: false,
    error,
    batchId: '',
    targetStyleId: target,
    movedColors: 0,
    movedKeys: 0,
  });
  if (target <= 0) return fail('没有选目标款');
  if (!srcIds.length) return fail('没有选要合并进来的款');
  if (!tableExists('oi_variant_keys')) return fail('订单库还没准备好（变体键表不存在）');
  const tgt = dbGet<{ code: string }>(`SELECT COALESCE(code, '') AS code FROM oi_styles WHERE id = ?`, [target]);
  if (!tgt) return fail('目标款不存在（可能已被删除）');
  const srcRows = dbQuery<{ id: number; code: string }>(
    `SELECT id, COALESCE(code, '') AS code FROM oi_styles WHERE id IN (${srcIds.map(() => '?').join(',')})`,
    srcIds,
  );
  if (srcRows.length !== srcIds.length) return fail('要合并的款里有些不在了（可能已被删除），刷新后再试');

  let movedColors = 0;
  let movedKeys = 0;
  // 一次 N→1 会写 N 行 `oi_style_merges`（一源一行），但人眼里是**一次操作** ——
  // 所以撤销键必须是批次号。按行 id 拆的实现只能拆掉最后一个源款（真库副本实测 restored=1）。
  const batchId = `m${Date.now().toString(36)}${Math.random().toString(36).slice(2, 8)}`;
  dbTransaction(() => {
    // 目标款现有色，按**归一化名**索引；同名多行取 id 最小那条（否则"合并到哪一条"变成随机）
    const colorIndex = new Map<string, number>();
    for (const c of dbQuery<{ id: number; color: string }>(
      `SELECT id, COALESCE(color, '') AS color FROM oi_style_colors WHERE style_id = ? ORDER BY id`,
      [target],
    )) {
      const k = colorKey(c.color);
      if (k && !colorIndex.has(k)) colorIndex.set(k, Number(c.id));
    }
    for (const src of srcRows) {
      const mid = dbRun(
        `INSERT INTO oi_style_merges (batch_id, source_style_id, target_style_id) VALUES (?, ?, ?)`,
        [batchId, Number(src.id), target],
      ).lastInsertRowid;
      const srcColors = dbQuery<{ id: number; color: string }>(
        `SELECT id, COALESCE(color, '') AS color FROM oi_style_colors WHERE style_id = ? ORDER BY id`,
        [Number(src.id)],
      );
      for (const sc of srcColors) {
        const fromId = Number(sc.id) || 0;
        if (fromId <= 0) continue;
        const k = colorKey(sc.color);
        const toId = colorIndex.get(k) ?? 0;
        if (toId && toId !== fromId) {
          // 同名色已在目标款下 ⇒ 只改键（源色行留着，拆的时候要能指回来）
          for (const key of dbQuery<{ variant_key: string; state: string }>(
            `SELECT variant_key, COALESCE(state, 'auto') AS state FROM oi_variant_keys WHERE style_color_id = ?`,
            [fromId],
          )) {
            dbRun(
              `UPDATE oi_variant_keys SET style_color_id = ?, state = 'merged',
                      updated_at = datetime('now','localtime')
                WHERE variant_key = ?`,
              [toId, key.variant_key],
            );
            dbRun(
              `INSERT INTO oi_style_merge_items
                 (merge_id, kind, variant_key, from_style_color_id, to_style_color_id, from_state)
               VALUES (?, 'key', ?, ?, ?, ?)`,
              [mid, key.variant_key, fromId, toId, String(key.state ?? 'auto')],
            );
            dbRun(
              `UPDATE oi_order_items SET style_color_id = ?
                WHERE variant_key = ? AND COALESCE(style_color_id, 0) = ?`,
              [toId, key.variant_key, fromId],
            );
            movedKeys += 1;
          }
          continue;
        }
        // 不同名（或目标款下的同名色就是它自己）⇒ 搬色：只改 style_id，色 id 不变
        dbRun(`UPDATE oi_style_colors SET style_id = ? WHERE id = ?`, [target, fromId]);
        // ⚠️ 索引必须跟着更新：同一批里两个源款都有 `4` 时，不更新就会把第二条也搬过来，
        //    撞 `UNIQUE(style_id, color)`（真库副本上实测撞到过，整批回滚）。
        colorIndex.set(k, fromId);
        dbRun(
          `INSERT INTO oi_style_merge_items (merge_id, kind, color_id, from_style_id, to_style_id)
           VALUES (?, 'color', ?, ?, ?)`,
          [mid, fromId, Number(src.id), target],
        );
        movedColors += 1;
      }
    }
  });
  return { ok: true, batchId, targetStyleId: target, movedColors, movedKeys };
}

/**
 * 拆开一次合并（按批次把明细逐条还原，然后删掉整批）。
 *
 * 跳过而不是硬还原的情况有两种，都要计数报出来（静默少还原几条，人会以为合并没拆干净）：
 *   · 键已经被后来的合并改指到别处（当前指向 ≠ 本次的 `to`）；
 *   · 键/色已被删（`ON DELETE CASCADE`）。
 */
export function unmergeStyles(batchIdRaw: unknown): UnmergeOutcome {
  const batchId = String(batchIdRaw ?? '').trim();
  if (!batchId) return { ok: false, error: '没有指定要拆开的合并', restored: 0, skipped: 0 };
  const head = dbGet<{ id: number }>(`SELECT id FROM oi_style_merges WHERE batch_id = ? LIMIT 1`, [batchId]);
  if (!head) return { ok: false, error: '这条合并记录不在了（可能已经拆过）', restored: 0, skipped: 0 };
  const items = dbQuery<{
    kind: string;
    color_id: number;
    variant_key: string;
    from_style_id: number;
    to_style_id: number;
    from_style_color_id: number;
    to_style_color_id: number;
    from_state: string;
  }>(
    `SELECT i.* FROM oi_style_merge_items i
       JOIN oi_style_merges m ON m.id = i.merge_id
      WHERE m.batch_id = ?
      ORDER BY i.id DESC`,
    [batchId],
  );
  let restored = 0;
  let skipped = 0;
  dbTransaction(() => {
    for (const it of items) {
      if (String(it.kind) === 'color') {
        const cid = Number(it.color_id) || 0;
        // 色已被删（或被别的合并搬走了）⇒ 跳过
        const cur = cid
          ? dbGet<{ style_id: number }>(`SELECT style_id FROM oi_style_colors WHERE id = ?`, [cid])
          : undefined;
        if (!cur || Number(cur.style_id) !== Number(it.to_style_id)) {
          skipped += 1;
          continue;
        }
        dbRun(`UPDATE oi_style_colors SET style_id = ? WHERE id = ?`, [Number(it.from_style_id), cid]);
        restored += 1;
        continue;
      }
      // kind = 'key'
      const key = String(it.variant_key ?? '');
      const fromId = Number(it.from_style_color_id) || 0;
      const toId = Number(it.to_style_color_id) || 0;
      const cur = key
        ? dbGet<{ style_color_id: number }>(`SELECT style_color_id FROM oi_variant_keys WHERE variant_key = ?`, [key])
        : undefined;
      if (!cur || Number(cur.style_color_id) !== toId) {
        skipped += 1;
        continue;
      }
      dbRun(
        `UPDATE oi_variant_keys SET style_color_id = ?, state = ?,
                updated_at = datetime('now','localtime')
          WHERE variant_key = ?`,
        [fromId, String(it.from_state ?? 'auto'), key],
      );
      dbRun(
        `UPDATE oi_order_items SET style_color_id = ?
          WHERE variant_key = ? AND COALESCE(style_color_id, 0) = ?`,
        [fromId, key, toId],
      );
      restored += 1;
    }
    dbRun(`DELETE FROM oi_style_merges WHERE batch_id = ?`, [batchId]);
  });
  return { ok: true, restored, skipped };
}

function autoAssignByMap(
  rec: Pick<OrderRecord, 'imageId' | 'shop' | 'color' | 'rawFields'>,
  rowId = 0,
): void {
  const { itemId } = extractSkuFields(rec.rawFields);
  if (!itemId) return; // 订单没有商品ID → 这条链路无从查起（不是错误）
  // ⚠️ 产品库守卫**只管映射那条路**：变体键来自订单自身，不需要产品库、也不需要图。
  //    原来这里一上来就 `if (!productSchemaReady()) return`，那会让没建产品库的机器永远归不了类。
  const hit = productSchemaReady() ? resolveOrderSku({ shop: rec.shop, itemId }) : null;
  if (!hit) {
    // 2026-10-29 回退「导入即按变体键自动建款色/产品」：没有人工映射时**不自动建**，
    // 订单行留在「待认款」（style_color_id = 0），由人工在认款界面认款。
    // 原因：自动建会在导入时为每个未配映射的 listing 长出一套款色 + 产品占位，
    // 且实际运行中出现了重复款；恢复为只认人工配过映射（hit）的行，其余行留待认款。
    return;
  }
  // 产品库里手工新建的款在识别池里没有行 ⇒ 补一行占位款（与「点名归款」共用同一个实现）
  const style = ensureStyleByCode(hit.productCode);
  // 无图订单：归款的落点（图）写不了，但**行**能写 —— 不写就等于让"采集通道来的单"永远未归类。
  if (!rec.imageId) {
    const mappedNoImg = String(hit.spec ?? '').trim();
    if (mappedNoImg && mappedNoImg !== '*' && Number(rowId) > 0) {
      // 判据与图那条**同一个**：行上没结论、或结论是"猜的"（按变体键自动建的临时款）⇒ 落映射；
      // 人认过的（命名过 / 改过色名）不动。旧实现只认 `style_color_id = 0`，
      // P2 让导入即归类之后这个条件永远不成立 ⇒ 映射对无图行彻底失效。
      const cur = dbGet<{ style_color_id: number }>(
        `SELECT COALESCE(style_color_id, 0) AS style_color_id FROM oi_order_items WHERE id = ?`,
        [Number(rowId)],
      );
      if (isGuessedStyleColor(Number(cur?.style_color_id ?? 0))) {
        const sc = ensureStyleColor(style.id, hit.productCode, mappedNoImg);
        dbRun(`UPDATE oi_order_items SET style_color_id = ? WHERE id = ?`, [sc.id, Number(rowId)]);
      }
    }
    return;
  }
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
  // ②的"不动"有两个例外：见下方 `currentIsAlias`（已确认是平台色名的要重定）与
  // `currentIsGuess`（"猜的"结论不算人的结论，映射可以改掉）。
  // 图上的当前结论（mapped 分支要判"能不能改"，②③④ 还要 URL 与色名）——
  // 一次查回，两个分支共用，不查两遍。
  const img = dbGet<{ source_url: string; color: string; style_color_id: number }>(
    `SELECT COALESCE(i.source_url, '') AS source_url, COALESCE(sc.color, '') AS color,
            COALESCE(sc.id, 0) AS style_color_id
       FROM md_images i LEFT JOIN oi_style_colors sc ON sc.image_id = i.id
      WHERE i.id = ?
      ORDER BY sc.id LIMIT 1`,
    [rec.imageId],
  );
  // R1 起「款色 ↔ 图」是 **1:1**：同一款色只有一张代表图能读到结论，同色的其他订单图读不到。
  // 所以**行上有结论时以行为准**（行上的投影本来就更细，也是 R1 之后唯一的权威），图只作回落。
  const rowCur =
    Number(rowId) > 0
      ? dbGet<{ color: string; style_color_id: number }>(
          `SELECT COALESCE(sc.color, '') AS color, COALESCE(oi.style_color_id, 0) AS style_color_id
             FROM oi_order_items oi LEFT JOIN oi_style_colors sc ON sc.id = oi.style_color_id
            WHERE oi.id = ?`,
          [Number(rowId)],
        )
      : undefined;
  const curScId = Number(rowCur?.style_color_id ?? 0) || Number(img?.style_color_id ?? 0);
  const current = String(rowCur?.color ?? '').trim() || String(img?.color ?? '').trim();
  // "猜的"结论（按变体键自动建的临时款）映射才可以改；人认过的（命名 / 合并 / 改过色名）不动。
  // 没有结论（`0`）= 猜的 ⇒ 可写；**占位色 `未分类` 也一律算猜的** —— 它本来就不是结论，
  // 只是"什么都没定出来"的兜底名；不算猜的的话，补色通道永远回填不到占位行
  // （`reassignCore` 把占位行选成候选、这里又把它挡回去，用户配完映射看不到任何变化）。
  const currentIsGuess =
    curScId === 0 || current === MAPPED_FALLBACK_COLOR || isGuessedStyleColor(curScId);
  const mapped = String(hit.spec ?? '').trim();
  if (mapped && mapped !== '*') {
    // 映射是"这个商品ID 是什么色"的人为判定，但它**不许冲掉人更直接的操作**：
    // 重导同一份 Excel / 后配映射时，图上已经被命名过的那条必须留住
    //（否则"每次重导都把人工色名改回平台名叫法"，用户只能重导一次改一次）。
    if (!currentIsGuess) return;
    setImageStyleColor(rec.imageId, ensureStyleColor(style.id, hit.productCode, mapped).id);
    return;
  }
  const aliases = colorAliases(hit.productId);
  // ②已有的真实色不动 —— 但**平台色名不算"真实色名"**：它只是采集侧的字符串（`Khaki` / `1`），
  //   一旦这个产品配过对照（`Khaki → 卡其`），挂在 `Khaki` 上的图就是"还没翻译的"，要重定。
  //   判据用"字典里有没有这一对"而不是猜"像不像色名"：`未分类` 之外的每一串都可能是自家色名，
  //   只有用户认过的那几串能确定是平台侧写法。
  // 第三个例外（2026-10-28）：**"猜的"结论也不算人的结论**。P2 让导入即按变体键建临时款色，
  //   图上的 `黑` 常常就是这么来的 —— 它不是人说的，映射（人明确配的判定）应该能改掉它；
  //   命名过 / 改过色名的（`isGuessedStyleColor` 判否）照旧不动。
  const currentIsAlias = current ? pickColorAlias(aliases, hit.productId, current) !== '' : false;
  if (current && current !== MAPPED_FALLBACK_COLOR && !currentIsAlias && !currentIsGuess) return;
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

  // 候选 = "这条结论还能被映射改写"的行：
  //   · 图上没结论（`style_color_id IS NULL`）；
  //   · 占位色（`未分类`）；
  //   · 平台色名（调用方显式点名的 `opts.colors`，见 `reassignOrdersByItemIds` 的说明）；
  //   · **"猜的"结论**（按变体键自动建的临时款）—— 2026-10-28 补：P2 让导入即归类之后，
  //     前两条再也不可能成立，只剩这个判据能让"先导订单、后配映射"的回填生效。
  //     判据与 `autoAssignByMap` 的 ② 守卫**同一个函数**（`guessedScSql`），不另写一套。
  //   人认过的（命名过 / 改过色名 / 合并过）一律不在候选里 —— 那是"改一次映射把历史全改判"，禁用。
  const rows = dbQuery<{
    id: number;
    image_id: number;
    shop: string;
    color: string;
    raw_fields: string;
    cur_id: number;
  }>(
    // R1：结论读**订单行自己的投影**（`ITEM_STYLE_COLOR_ID`：行优先、图回落）。
    // 不能只按 `sc.image_id = oi.image_id` —— 款色 ↔ 图是 1:1，同色但不同图的行会读不到结论，
    // 于是"占位色的存量单"被当成"没归款"再判一次（回填数也会跟着虚高）。
    `SELECT oi.id, oi.image_id, o.shop, oi.color, oi.raw_fields, ${ITEM_STYLE_COLOR_ID} AS cur_id
       FROM oi_order_items oi
       JOIN oi_orders o ON o.id = oi.order_id
       LEFT JOIN oi_style_colors sc ON sc.id = ${ITEM_STYLE_COLOR_ID}
      WHERE oi.image_id IS NOT NULL
        AND (sc.id IS NULL OR sc.color = ?${colorCond} OR ${guessedScSql('sc.id')})`,
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
    const rowId = Number(r.id);
    const beforeId = Number(r.cur_id) || 0;
    autoAssignByMap(
      {
        imageId,
        shop: String(r.shop ?? ''),
        color: String(r.color ?? ''),
        rawFields,
      },
      rowId,
    );
    // 判据同样看**行**（行是 R1 之后的权威；一张图挂多行时逐行读数才不会漏计/多计）
    const after = d
      .prepare(`SELECT COALESCE(style_color_id, 0) AS style_color_id FROM oi_order_items WHERE id = ?`)
      .get(rowId) as { style_color_id: number } | undefined;
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

    // 套装商品在这里**没有任何特殊分支**（这是新模型相对上一版的最大简化）：
    // `pl_shop_sku` 一条映射 = 「这个商品卖哪个产品」，套装商品的答案是**套装产品本身**
    // （它也是 `pl_products` 的一行）。部件是产品之间的关系（`pl_bundle_links`），
    // 由产品库定义一次，与"这个商品归哪个款"是两件事 —— 混在一层就会分裂成
    // 「同商品同一个 spec 挂多行、还要按角色判重」，那是把目录事实塞进映射表。
    //
    // 于是 `resolveOrderSku` 对套装商品照常命中套装产品，核对页再据
    // `isBundleProduct(产品)` 决定要不要展开 —— 展开读的是行级快照 `oi_item_parts`。

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
  const status: OrderStatus = rec.status === 'shipped' ? 'shipped' : 'pending';
  // 金额/状态/时点在**入库这一刻**从 raw_fields 提成正式列（口径见 `electron/orderMoney.ts`）——
  // 放在主进程做，岛侧无需改，也就不必发版；其余 30 余列留在 raw_fields 里保真、随时可提。
  const m = extractOrderMoney(rec.rawFields);
  // 颜色同理：报表**没有颜色列**，颜色藏在「产品信息」的 `(产品属性:Color:5,...)` 里。
  const color = String(rec.color ?? '').trim() || parseOrderPropsColor(rec.rawFields);
  // 件数：**落库那一刻**从报表块里定下来（`(商品数量:2 piece)`），不再让下游各算一遍。
  const qty = parseOrderQty(rec.rawFields);
  const size = String(rec.size ?? '').trim();
  // 幂等：(订单号, 图片, 色, 码, 件数) 已存在则跳过，避免重复导入同一 Excel 产生重复行。
  // ⚠️ 不能只用 `(订单号, 图片)`：拆行后同一 listing 的多个 SKU 经常共用一张商品图
  //   （速卖通一单 4 段同商品不同色/码就是这样），只按图判重会把后 3 段当成重复行吞掉。
  // ⚠️ 用 `IS ?` 而不是 `= ?`：无图订单的 `image_id` 是 NULL，`= NULL` 永远不成立 →
  //   重导同一份报表会不断插重复行（幂等当场失效）；`size`/`qty` 同理可能为空。
  if (header) {
    const existing = d
      .prepare(`SELECT id FROM oi_order_items WHERE order_id = ? AND image_id IS ? AND color = ? AND size IS ? AND qty IS ?`)
      .get(header.id, rec.imageId, color, size, qty);
    if (existing) {
      const id = Number((existing as { id: number }).id);
      // 幂等重入**也要再试一次归款**：映射很可能是这条订单之后才人工确认的，
      // 不重试的话「先导订单、后确认映射」的人永远等不到自动命中（验收②的字面场景）。
      autoAssignByMap(rec, id);
      syncOrderClassificationFromImage(rec.imageId);
      return id;
    }
  }
  // 变体键：**导入这一刻算一次并落库**，此后只读（除店铺改名）。口径只有一份，见 `variantKeyOfRow`。
  const variantKey = variantKeyOfRow(rec.shop, JSON.stringify(rec.rawFields ?? {}), color);

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
        `INSERT INTO oi_order_items (order_id, image_id, size, raw_fields, category, color, logo, status, qty, variant_key)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
      )
      .run(
        headerId,
        rec.imageId,
        size,
        JSON.stringify(rec.rawFields),
        rec.category,
        color,
        rec.logo,
        status,
        qty,
        variantKey,
      );
    itemId = Number(ir.lastInsertRowid);
  });
  // 归款**必须带行 id**：没有映射时 `autoAssignByMap` 会把这一行交给变体键
  // （`assignByVariantKey` 要回读行上的 `variant_key`，拿不到 id 就整条链路空转）。
  autoAssignByMap(rec, itemId);
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
  // ── 芒果同步的订单级字段（v13；缺省一律空串，导入通道不传）─────────────────
  /** 付款时刻（发货时效起点，不是下单时刻） */
  payTime?: string;
  /** 芒果 `authId`（店铺在 ERP 里的 id；`sk_shops.erp_shop_id` 同口径） */
  shopAuthId?: string;
  /** 最晚发货日（芒果 `sendGoodExpiredDate`） */
  dealDeadline?: string;
  /** 另一套时效时点（芒果 `qualifiedTime`，与上者差 6 天，待核对后二选一） */
  timeoutAt?: string;
  /**
   * 采集帧原文（保真放进 `raw_fields`；键名前缀 `采集` 以免与报表列名族相撞）。
   *
   * ⚠️ 这是**订单级**快照，写入时每行还会叠加自己的可识别字段（`商品ID` / `产品属性`），
   * 见下方 `lineRawFields`。行级字段必须每行各一份 —— 一单多商品时共用一份会让整单的
   * 变体键塌成第一行的值（键一塌，图案绑定与成本全落在错的商品上）。
   */
  rawFields?: Record<string, string>;
  lines: {
    itemId: string;
    qty: number;
    color: string;
    size: string;
    /** 平台 SKU 唯一 ID（芒果 `skuCode`）；空 = 帧里没给 */
    skuCode?: string;
    /** 已落地到 `md_images` 的图片 id；0/缺省 = 无图（写 NULL，不是 0） */
    imageId?: number;
    /**
     * 本行图的 URL（**算图键用**，不是展示用）。
     *
     * 为什么必须给 URL 而不是让函数自己从 `imageId` 反查：`md_images.id` 是**本机**自增，
     * 同一张图在两台机器上是不同 id ⇒ 拿 id 当键会让"换台机器键就变了"。
     * 给不出来也没关系 —— 图键为空时仍是 3 段键（与改造前逐字节相同）。
     */
    imageUrl?: string;
  }[];
}

/** 采集单写入的回执。`refusedReason` 非空 ⇒ **一行都没写**，调用方必须把它带进回执日志。 */
export interface CollectedOrderResult {
  rows: number;
  replaced: boolean;
  /**
   * 未写入的原因（空 = 已写入）。宁可整单不写、也不半写：
   * 半写的单行数少了，人工看不出"是这一单只有 2 件还是丢了 3 行"。
   */
  refusedReason: string;
}

export function upsertCollectedOrder(input: CollectedOrderInput): CollectedOrderResult {
  const d = initDb();
  const orderNo = String(input?.orderNo ?? '').trim().slice(0, 64);
  if (!orderNo) throw new Error('upsertCollectedOrder: 订单号不能为空');
  const lines = Array.isArray(input?.lines) ? input.lines : [];
  const rawFields = input?.rawFields ?? {};
  const bizStatus = String(input?.bizStatus ?? '').slice(0, 64);
  const orderTime = String(input?.orderTime ?? '').slice(0, 32);
  const shop = String(input?.shop ?? '').slice(0, 120);
  const payTime = String(input?.payTime ?? '').slice(0, 32);
  const shopAuthId = String(input?.shopAuthId ?? '').slice(0, 64);
  const dealDeadline = String(input?.dealDeadline ?? '').slice(0, 32);
  const timeoutAt = String(input?.timeoutAt ?? '').slice(0, 32);
  const amount = input?.amountCents === null || input?.amountCents === undefined ? null : Math.round(Number(input.amountCents));

  let replaced = false;
  let rows = 0;
  let refusedReason = '';
  dbTransaction(() => {
    const existed = d
      .prepare(`SELECT id, source FROM oi_orders WHERE order_no = ? LIMIT 1`)
      .get(orderNo) as { id: number; source: string } | undefined;
    // 通道**升级**（v13 / T0-4，原先是"非 collect 直接抛错"）：
    //   · `import → collect` **允许** —— 采集帧是更完整、更新的来源（带付款时刻/时效/店铺 authId，
    //     这些导入报表里根本没有）。原先直接抛错意味着"采集一开跑，存量导入单全部被拒"，
    //     而调用方只把它计进 `skipped` 计数，界面上只有一个数字、没有原因。
    //   · `collect → import` 反向禁止：导入是逐行追加、金额口径不同，覆盖采集单会把它删成半截。
    // **行数不许缩水**（对任何来源都成立，不只 import→collect）：采集帧若是残的（翻页中断 /
    // 某行解析失败），整单替换会把这单的行删掉几行，而且删得静默 —— 之后按行统计的
    // "这单买了几件"就永久偏少，拣货单上少一件都没人发现。
    // 宁可整单不写、把原因带回执，让人看到"这一单没同步成功"。
    if (existed) {
      const oldCount = Number(
        (
          d.prepare(`SELECT COUNT(*) AS n FROM oi_order_items WHERE order_id = ?`).get(existed.id) as
            | { n: number }
            | undefined
        )?.n ?? 0,
      );
      if (lines.length < oldCount) {
        refusedReason = `采集帧 ${lines.length} 行 < 已有 ${oldCount} 行（疑似帧不完整），保留原单`;
        return;
      }
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
        `INSERT INTO oi_orders (order_no, shop, order_time, source, amount_cents, biz_status,
                                pay_time, shop_auth_id, deal_deadline, timeout_at)
         VALUES (?, ?, ?, 'collect', ?, ?, ?, ?, ?, ?)`,
      )
      .run(orderNo, shop, orderTime, amount, bizStatus, payTime, shopAuthId, dealDeadline, timeoutAt);
    const headerId = Number(h.lastInsertRowid);
    // 明细：逐行插（一单零行也插一行，订单数不能凭空少；件数按 1，不猜 0）
    //
    // 四列一次落齐（T0-2）：`item_id` / `sku_code` / `image_id` / `variant_key`。
    // 改造前这里只写 size/raw_fields/color/qty 且 `image_id` 写死 NULL ⇒ 采集单**一行都
    // 拼不出变体键**，图案绑定与款色归类全部落空，而且不报错（界面只显示"未归类"）。
    const ins = d.prepare(
      `INSERT INTO oi_order_items
         (order_id, image_id, size, raw_fields, color, qty, item_id, sku_code, variant_key)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const fallbackLine: CollectedOrderInput['lines'][number] = {
      itemId: '',
      qty: 1,
      color: '',
      size: '',
    };
    const rowsToWrite: CollectedOrderInput['lines'] = lines.length ? lines : [fallbackLine];
    for (const l of rowsToWrite) {
      const itemId = String(l?.itemId ?? '').trim().slice(0, 64);
      const color = String(l?.color ?? '').slice(0, 64);
      const size = String(l?.size ?? '').slice(0, 64);
      const skuCode = String(l?.skuCode ?? '').trim().slice(0, 64);
      const imageId = Math.round(Number(l?.imageId) || 0);
      // 行级可识别字段（T0-3）：既有解析链（`shopSku.extractSkuFields` 的键名族、
      // `aeMoney.parseOrderPropsColor` 的规格串）都在**顶层**按列名找值 —— 只存整帧 JSON
      // 时它们找不到且不报错（`variantKeyOfRow` 于是静默返回空键）。
      // 顺序很重要：行级字段**放在订单级快照之后**，同键以行为准。
      const lineRawFields = JSON.stringify({
        ...rawFields,
        商品ID: itemId,
        产品属性: `(产品属性:Color:${color},Size:${size})`,
      });
      const key = variantKeyOf({
        shopKey: shop,
        itemKey: itemId,
        colorKey: color,
        // 图键只在能算出时追加（T0-6）：空串 ⇒ 仍是 3 段键，存量口径不动
        imageKey: imageKeyOf(l?.imageUrl),
      });
      ins.run(
        headerId,
        imageId > 0 ? imageId : null,
        size,
        lineRawFields,
        color,
        Math.max(1, Math.round(Number(l?.qty) || 1)),
        itemId,
        skuCode,
        key,
      );
      rows += 1;
    }
  });
  return { rows, replaced, refusedReason };
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
  /** 付款时点（采集侧 `gmtPayTime` 写入；导入侧没有 → 空串）。发货时效的**起点** */
  payTime: string;
  /**
   * 最晚发货时点（采集侧芒果 `sendGoodExpiredDate`）。
   *
   * **D-2 已定：这就是真倒计时**，「有截止风险」只认这一列。空串 = 不知道（导入单没有）。
   */
  dealDeadline: string;
  /**
   * 芒果 `qualifiedTime`（实测比 `dealDeadline` **早 6 天**）。**只存不用** —— 不参与任何告警判定。
   *
   * 留着是为了将来核对"到底哪个是官方倒计时"时有原始值可比；若把它与 `dealDeadline` 取更近的
   * 那个来告警，稳定的 6 天偏差会变成一堆假"快超时"。
   */
  timeoutAt: string;
  /** 行图（`oi_order_items.image_id`；**0 = 没落地**）—— 图案槽位与「缺图 K」读它 */
  imageId: number;
  /** 行图的本地路径（`md_images.local_path`；空串 = 没图或文件没落地）。
   *  2026-11-05：「待发货」清单要出缩略图 —— 那一屏只拿得到 id 就得多一次往返，
   *  而「这单要印什么」正是 POD 卖家判断"能不能发"的第一判据。 */
  localPath: string;
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
  // 款编码走**识别链** `oi_style_colors.image_id → oi_style_colors → oi_styles`（与
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
            oi.image_id, o.pay_time, o.deal_deadline, o.timeout_at,
            COALESCE(img.local_path, '') AS local_path,
            COALESCE(s.code, '') AS style_code, COALESCE(sc.color, '') AS style_color,
            COALESCE(sc.id, 0) AS style_color_id,
            ${supplierSel}
     FROM oi_order_items oi
     JOIN oi_orders o ON o.id = oi.order_id
     LEFT JOIN md_images img ON img.id = oi.image_id
     LEFT JOIN oi_style_colors sc ON sc.id = ${ITEM_STYLE_COLOR_ID}
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
    payTime: String(r.pay_time ?? ''),
    dealDeadline: String(r.deal_deadline ?? ''),
    timeoutAt: String(r.timeout_at ?? ''),
    // `image_id` 列在无图时是 NULL（不是 0，见 upsertCollectedOrder 的写法）。
    // 这里折成 0 是安全的：SQLite 自增从 1 起，0 不可能是一个真实图片 id，
    // 且下游（缺图统计 / 图案槽位）只需要布尔"有没有图"。
    imageId: Number(r.image_id ?? 0) || 0,
    localPath: String(r.local_path ?? ''),
    rawFields: safeJson(String(r.raw_fields ?? '')),
  }));
}

/** 订单列表（分页 + corrected 过滤 + 关键字搜索）：
 *  - 列表不携带 o.raw_fields（整行 Excel 原始字段体积大且界面不消费），显著降低 IPC 传输；
 *  - 返回 { rows, total } 供渲染层同步总数/分页；
 *  - search 匹配 单号/店铺/分类/颜色/logo/款编码/款名/款色，供纠正页/明细页服务端搜索。
 *
 *  ⚠️ **改造触发阈值（不是"以后有空再说"，到了就必须做）**：
 *    - `oi_order_items` 任一表 > 5 万行 → 把下面的 8 列 `LIKE '%kw%'` 换成 FTS5 虚拟表
 *      （范式抄 `electron/mail-db.ts` 的 `FTS_TABLE` + 回填游标，那份已经在生产用着）；
 *      `LIKE '%x%'` 用不上任何索引，是全表扫 + 每页再跑一次 `COUNT(*)`。
 *    - 单页实测返回 > 500 行 → 渲染层加虚拟滚动，再谈把 `limit` 上限从 2000 抬上去。
 *  2026-11-04 取证：真库 `oi_order_items` 5 行 / `oi_orders` 5 行 / `pl_products` 21 行，
 *  此时做索引与 FTS 没有可测收益，属提前优化（见 docs/plans/SECURITY_PERF_HARDENING_PLAN_2026-11-04.md §S3）。 */
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
       LEFT JOIN oi_style_colors sc ON sc.id = ${ITEM_STYLE_COLOR_ID}
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
            i.fingerprint, i.source_url, i.local_path,
            s.code AS style_code, ${n.name} AS style_name, sc.color AS style_color
     FROM oi_order_items oi
     JOIN oi_orders o ON o.id = oi.order_id
     LEFT JOIN md_images i ON i.id = oi.image_id
     LEFT JOIN oi_style_colors sc ON sc.id = ${ITEM_STYLE_COLOR_ID}
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
      // 重归类前记录图片原归属款（供空壳原款清理使用）：图 → 色行 1:1
      const prevImg = d
        .prepare(`SELECT style_id AS style_id FROM oi_style_colors WHERE image_id = ? ORDER BY id LIMIT 1`)
        .get(order.image_id) as { style_id: number } | undefined;
      const prevStyleId = Number(prevImg?.style_id) || undefined;
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
           LEFT JOIN oi_style_colors sc ON sc.id = ${ITEM_STYLE_COLOR_ID}
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
 *  - oi_styles 行删除（CASCADE 级联删除其款色；款色行上的代表图 `image_id` 随之消失，
 *    图片**字节与 `md_images` 行保留** —— 图片归主数据域，孤图清理负责回收）；
 *  - 订单行保留（category/color 等字段不变），仅款编码联表变为空。 */
export function deleteStyle(id: number): void {
  const d = getDb();
  const style = d.prepare(`SELECT id FROM oi_styles WHERE id = ?`).get(id);
  if (!style) throw new Error(`款式不存在: id=${id}`);
  dbTransaction(() => {
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

/**
 * 清空订单（**不碰图片**：图片与主数据归 `md_images`，生命周期由孤图清理决定）。
 */
export function clearAll(): void {
  dbTransaction(() => {
    dbRun('DELETE FROM parcels');
    dbRun('DELETE FROM oi_order_items');
    dbRun('DELETE FROM oi_orders');
  });
}

/**
 * 图片本地路径全集（`md_images` 的非空 local_path），供孤图清理判定"仍被引用"。
 *
 * ⚠️ 2026-10-28 顺带修掉一条**从未成功执行过**的查询：原 SQL 是
 * `UNION SELECT local_path FROM oi_queue`，而 `oi_queue` 的建表语句里**没有 local_path 列** ——
 * 真库上整条语句抛 `no such column: local_path`，被调用方的 try/catch 吞掉后返回失败
 * （症状：孤图清理永远删不掉任何文件，界面上只看到"失败"）。删队列时去掉那一支才第一次能跑。
 *
 * R1：实现搬到主数据域（`allImageLocalPaths`），本域只留一个转发（调用方是订单处理器，
 * 但它清理的是全项目唯一的图片目录 —— 口径只能有一份）。
 */
export function listImageLocalPaths(): string[] {
  return allImageLocalPaths();
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
    // 识别流水线已删（D16，`result_json` 随 `oi_images` 一起退役）⇒ 特征恒空。
    // 字段保留是因为渲染层「重新归类」仍读它（空数组交给 `buildStyleFingerprint` 按品类算指纹）。
    features: undefined,
  };
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

// ───────────────────────────────────────── 套装部件（`oi_item_parts`）
//
// 「一件实物 = 多个款色」（上衣 + 裤子各自不同款不同色）的行级事实。
// 表的存在意义与字段口径见 `SCHEMA` 里那段注释；这里只强调**读取纪律**：
//
//   · 一个订单行的款色集合**只有一个读取入口** —— `itemStyleColorIds`；
//   · 有部件 ⇒ 用部件集，**绝不**再掺行/图上那个单品款色（掺进去等于把套装当单品多算一件）；
//   · 无部件 ⇒ 回落单品款色（图优先，理由见该函数注释）—— 老数据零迁移。
//
// ⚠️ 不要在各处 SQL 里各写一套「有部件就 JOIN 部件表、否则 JOIN 图」的 CASE：
//    套装与非套装的分支必须只有一份实现，否则两页会算出不同的件数（同一件事两套口径）。

/** 套装的一个部件：`oi_item_parts` 一行 + 联表带出的展示字段 */
export interface OrderItemPart {
  /** 部位（上衣/裤子/马甲/配件…，原文，已 trim）。同一行内唯一 */
  role: string;
  styleColorId: number;
  /** 款色编码（`oi_style_colors.code`，如 `SUST-006-红`） */
  styleColorCode: string;
  /** 款编码（`oi_styles.code`）—— 与产品库 `pl_products.code` 同锚点 */
  styleCode: string;
  color: string;
  /** 一套含几件该部位（≥1；「套装含两条裤子」用 2 表达，不写两条同 role 的记录） */
  qtyPerSet: number;
}

/** 部件投影的唯一一份 SELECT（单笔与批量共用；改列只改这里） */
const PART_SELECT = `SELECT p.order_item_id, p.role, p.style_color_id, p.qty_per_set,
       COALESCE(sc.code, '') AS sc_code, COALESCE(sc.color, '') AS color,
       COALESCE(s.code, '') AS style_code
  FROM oi_item_parts p
  LEFT JOIN oi_style_colors sc ON sc.id = p.style_color_id
  LEFT JOIN oi_styles s ON s.id = sc.style_id`;

/**
 * ⭐ 「一个订单行 → 它的款色」的**唯一一份展开口径**，以可嵌入 FROM 的派生表形式导出。
 *
 * 形状（别名 `v`）：`(order_item_id, style_color_id, qty_per_set)`
 *   · 有部件 ⇒ 每个部件一行（`qty_per_set` = 一套几件）；
 *   · 无部件 ⇒ 一行，取图上那个单品款色，`qty_per_set` 恒 1（老数据零影响）；
 *   · `style_color_id = 0` = 还没归类 —— **必须保留**，未归类的真实需求不能被吞掉。
 *
 * 为什么是"导出片段"而不是数据库视图：本库的迁移会 `ALTER TABLE ... RENAME` / `DROP TABLE`
 * 重建 `oi_order_items`（v3 主干归一），**视图在底层表被换掉后会变悬空**，之后连无关的
 * `ALTER TABLE` 都会报 `error in view ...: no such table` —— 老库迁移当场全红。
 * 派生表只在语句执行时解析，随表走，不给迁移留地雷。
 *
 * 为什么必须唯一一份：各页 SQL 各抄一遍「有部件就 JOIN 部件表、否则 JOIN 图」，
 * 必然出现"采购页算两件、拣货页算一件"，而两边各自看都正常（正是本项目踩过的坑）。
 * TS 侧的 `itemStyleColorIds` 与 `purchase-db.outstanding()` 都读这一份。
 */
/**
 * ⭐ 「这一行订单属于哪个款色」的**唯一身份表达式**（SQL 片段，要求 FROM 里有
 * `oi_order_items oi`，**不需要**再 JOIN 图片表）。
 *
 * 口径：**订单行优先、图回落**（图 → 色经 `oi_style_colors.image_id` 反查，1:1）。
 * 2026-10-28 订单驱动归类之后，`oi_order_items.style_color_id` 才是权威（由
 * `(店铺, 商品ID, Color 原值)` 的变体键自动写入）；色行上的 `image_id` 是"这张图属于哪个色"
 * 的历史结论（R1 起这里是唯一落点），只在该行还没归类时兜底。
 *
 * 为什么用**相关子查询**而不是 `LEFT JOIN oi_images i`：R1 之后图片表是 `md_images`，
 * 而"图 → 色"不经过图片表（归属直接写在色行上）；用 JOIN 还得在每个消费者里多写一条
 * `LEFT JOIN oi_images i`（拣货 / 采购 / 订单三处都抄），口径会分叉。
 * 子查询也**不占用别名 `i`** —— 调用方常把 `i` 留给图片表。
 *
 * 为什么必须导出而不是各页自己写一遍 `COALESCE(...)`：
 * 改造前"改装色"只走图，于是所有投影层（待核对列表 / 订单利润 / 拣货 / 拿货缺口）都
 * 按 `oi_images.style_color_id` 直接 JOIN 款色。改造后订单行先有了款色，
 * 若投影层仍只认图，就会出现**同一行"统计说已归类、列表显示没归类"** ——
 * 真库实测这类行有 9/75（`image.style_color_id = 0` 但订单行已归）。
 * 一个数字两处实现，用户只会认为坏了。
 */
export const ITEM_STYLE_COLOR_ID = `COALESCE(NULLIF(oi.style_color_id, 0), (SELECT sc.id FROM oi_style_colors sc WHERE sc.image_id = oi.image_id AND oi.image_id <> 0 LIMIT 1), 0)`;

export const ITEM_STYLE_COLOR_SRC = `(SELECT p.order_item_id AS order_item_id,
            p.style_color_id AS style_color_id, p.qty_per_set AS qty_per_set
       FROM oi_item_parts p
     UNION ALL
     SELECT oi.id AS order_item_id,
            -- 款色权威 = **订单行**（2026-10-28 订单驱动归类后的唯一落点），图只是历史回落：
            -- 采集通道来的行 image_id 恒空，只认图的话这些行永远进不了拿货单。
            ${ITEM_STYLE_COLOR_ID} AS style_color_id,
            1 AS qty_per_set
       FROM oi_order_items oi
      WHERE NOT EXISTS (SELECT 1 FROM oi_item_parts p2 WHERE p2.order_item_id = oi.id))`;

function mapPart(r: Record<string, unknown>): OrderItemPart {
  return {
    role: String(r.role ?? ''),
    styleColorId: Number(r.style_color_id ?? 0) || 0,
    styleColorCode: String(r.sc_code ?? ''),
    styleCode: String(r.style_code ?? ''),
    color: String(r.color ?? ''),
    qtyPerSet: Number(r.qty_per_set ?? 1) || 1,
  };
}

/** 一个订单行的全部部件（按录入顺序；空数组 = 这行不是套装） */
export function listItemParts(orderItemId: number): OrderItemPart[] {
  const id = Number(orderItemId) || 0;
  if (id <= 0) return [];
  return dbQuery<Record<string, unknown>>(`${PART_SELECT} WHERE p.order_item_id = ? ORDER BY p.id ASC`, [
    id,
  ]).map(mapPart);
}

/**
 * **一批**订单行的部件（核对页/列表一次问一批，避免每行一次 IPC）。
 * 不在返回里的 id = 该行没有部件（非套装）。返回 Map 形态的普通对象便于 `structuredClone` 过 IPC。
 */
export function partsByItemIds(ids: number[]): Record<number, OrderItemPart[]> {
  const clean = [...new Set((Array.isArray(ids) ? ids : []).map((n) => Number(n) || 0))].filter(
    (n) => n > 0,
  );
  const out: Record<number, OrderItemPart[]> = {};
  if (!clean.length) return out;
  const marks = clean.map(() => '?').join(',');
  const rows = dbQuery<Record<string, unknown>>(
    `${PART_SELECT} WHERE p.order_item_id IN (${marks}) ORDER BY p.order_item_id ASC, p.id ASC`,
    clean,
  );
  for (const r of rows) {
    const key = Number(r.order_item_id ?? 0) || 0;
    if (!key) continue;
    (out[key] ??= []).push(mapPart(r));
  }
  return out;
}

/**
 * 写入/替换一个订单行的部件（**全量替换**，事务）。
 *
 * 传空数组 = 把这行改回单品（清空部件）—— 合法且必须支持：套装判定错了要有回头路，
 * 而"部分删除"没有业务含义（套装要么整体成立，要么不存在）。
 *
 * 校验放在写库**之前**并给出可读中文错误，不靠 `UNIQUE` 抛约束名：
 *   · `role` 去空白后不得为空 —— 空 role 在核对页上是一行没有名字的款色，用户无法理解；
 *   · 同一行内 `role` 不得重复（**大小写不敏感**：`Top` 与 `top` 是同一个部位，
 *     DB 的 UNIQUE 只按字节比，挡不住这种写法，必须在这里先归一判重）；
 *   · `styleColorId` 必须指向真实款色行 —— 0/负数会让下游把"没选"当成一个真实款色去求和。
 */
export function replaceItemParts(
  orderItemId: number,
  parts: Array<{ role: string; styleColorId: number; qtyPerSet?: number }>,
): { ok: boolean; error?: string; parts: OrderItemPart[] } {
  const id = Number(orderItemId) || 0;
  if (id <= 0) return { ok: false, error: '订单行不存在', parts: [] };
  const exists = dbGet<{ id: number }>(`SELECT id FROM oi_order_items WHERE id = ?`, [id]);
  if (!exists) return { ok: false, error: `订单行不存在: id=${id}`, parts: [] };

  const want = (Array.isArray(parts) ? parts : []).map((p) => ({
    role: String(p?.role ?? '').trim(),
    styleColorId: Number(p?.styleColorId ?? 0) || 0,
    qtyPerSet: Number(p?.qtyPerSet ?? 1) || 1,
  }));
  const seen = new Set<string>();
  for (const p of want) {
    if (!p.role) return { ok: false, error: '每个部件都要有一个部位名（如 上衣 / 裤子）', parts: [] };
    const key = p.role.toLowerCase();
    if (seen.has(key)) return { ok: false, error: `部位「${p.role}」重复了：一件实物里同一部位只有一个款色`, parts: [] };
    seen.add(key);
    if (p.styleColorId <= 0) return { ok: false, error: `部位「${p.role}」还没选款色`, parts: [] };
    if (!Number.isInteger(p.qtyPerSet) || p.qtyPerSet < 1) {
      return { ok: false, error: `部位「${p.role}」的每套件数必须是 ≥1 的整数`, parts: [] };
    }
    const sc = dbGet<{ id: number }>(`SELECT id FROM oi_style_colors WHERE id = ?`, [p.styleColorId]);
    if (!sc) return { ok: false, error: `部位「${p.role}」指向的款色不存在: id=${p.styleColorId}`, parts: [] };
  }

  dbTransaction(() => {
    dbRun(`DELETE FROM oi_item_parts WHERE order_item_id = ?`, [id]);
    for (const p of want) {
      dbRun(
        `INSERT INTO oi_item_parts (order_item_id, role, style_color_id, qty_per_set) VALUES (?, ?, ?, ?)`,
        [id, p.role, p.styleColorId, p.qtyPerSet],
      );
    }
  });
  return { ok: true, parts: listItemParts(id) };
}

/** 清空一个订单行的部件（= 改回单品）。返回删掉的行数 */
export function clearItemParts(orderItemId: number): number {
  const id = Number(orderItemId) || 0;
  if (id <= 0) return 0;
  const r = dbRun(`DELETE FROM oi_item_parts WHERE order_item_id = ?`, [id]);
  return Number(r.changes) || 0;
}

/** `materializeItemParts` 的结局。`missingColor` 是**正常结局**（不是错误）：配色没配过，等人补。 */
export interface MaterializeOutcome {
  /**
   * · `written` 展开并写入了部件
   * · `already` 这行已有部件（幂等，不覆盖人工改过的）
   * · `notBundle` 该商品不是套装（正常单品行，什么都不做）
   * · `missingColor` 商品已在产品库定义成套装，但**这个色号还没配过**配色
   * · `noProduct` 商品还没映射到产品 / 产品域不可用
   * · `noItemId` 订单行没有商品ID（采集/导入缺列）
   */
  status: 'written' | 'already' | 'notBundle' | 'missingColor' | 'noProduct' | 'noItemId';
  parts: OrderItemPart[];
  /** 这套套装有哪些部位（`missingColor` 时用来告诉用户"还差哪个"） */
  roles: string[];
  /** 本次写进去的部位口径（便于界面直接显示"已自动展开为 上衣红 / 裤子黑"） */
  expanded: Array<{ role: string; styleCode: string; color: string; qty: number }>;
}

const NO_MATERIALIZE = (status: MaterializeOutcome['status']): MaterializeOutcome => ({
  status,
  parts: [],
  roles: [],
  expanded: [],
});

/**
 * ⭐ 把「这个商品是套装」这件事**落成这一行的部件快照**（幂等）。
 *
 * 为什么要有这一步：产品库只定义了**目录事实**（这套由哪些款组成、各几件）与**配色字典**
 * （平台色号 → 各部件色名）。订单行需要的是**这一单实际拆成什么** —— 那是快照，
 * 必须在归类那一刻落下来，否则：
 *   · 明天改一次套餐配方，历史单的拿货口径会被一起改掉（与"历史单钉住成本"同一条纪律反着来）；
 *   · 每次汇总都要现算一遍展开，汇总页与核对页各算一次就是两套口径。
 *
 * **不猜的三条**（写错一条就是"发货后才发现少一条裤子"）：
 *   · 该色号没配过 ⇒ 返回 `missingColor` 且**不写任何部件**（宁可留着当单品等人补，也不编配色）；
 *   · 商品没映射到产品 ⇒ `noProduct`（不按标题/图上猜款）；
 *   · 已有部件 ⇒ `already`，**不覆盖** —— 人工改过的部件优先于任何自动展开。
 *
 * 款色落库走 `ensureStyleByCode` + `ensureStyleColor`（与 `assignOrderStyle` 同一对函数）：
 * 子商品的款编码与产品库同锚点，色名是**自家色名**（来自配色字典，不是平台色号原文）。
 */
export function materializeItemParts(orderItemId: number): MaterializeOutcome {
  const id = Number(orderItemId) || 0;
  if (id <= 0) return NO_MATERIALIZE('noProduct');
  if (!productSchemaReady()) return NO_MATERIALIZE('noProduct');
  // 幂等：已有部件就不动（人工改过的那份永远优先）
  const existing = listItemParts(id);
  if (existing.length) return { status: 'already', parts: existing, roles: [], expanded: [] };

  const row = dbGet<{ color: string; raw_fields: string; shop: string }>(
    `SELECT oi.color, oi.raw_fields, o.shop
       FROM oi_order_items oi JOIN oi_orders o ON o.id = oi.order_id WHERE oi.id = ?`,
    [id],
  );
  if (!row) return NO_MATERIALIZE('noProduct');

  let rawFields: Record<string, string> = {};
  try {
    const v = JSON.parse(String(row.raw_fields ?? '{}'));
    if (v && typeof v === 'object') rawFields = v as Record<string, string>;
  } catch {
    rawFields = {}; // 一条脏 raw_fields 只让这一行展不开，不该往外抛
  }
  const { itemId } = extractSkuFields(rawFields);
  if (!itemId) return NO_MATERIALIZE('noItemId');

  const sku = resolveOrderSku({ shop: row.shop, itemId });
  if (!sku) return NO_MATERIALIZE('noProduct');
  if (!isBundleProduct(sku.productId)) return NO_MATERIALIZE('notBundle');

  const roles = bundleRolesOf(sku.productId);
  // 色号取**订单行的原文**（平台色号 `5`/`Khaki`）—— 它就是配色字典的键，不许先翻译成色名
  const resolved = resolveBundleParts({
    productId: sku.productId,
    itemId,
    color: String(row.color ?? ''),
  });
  if (!resolved.isBundle) return NO_MATERIALIZE('notBundle');
  if (!resolved.matched || !resolved.parts.length) return { ...NO_MATERIALIZE('missingColor'), roles };

  const want: Array<{ role: string; styleColorId: number; qtyPerSet: number }> = [];
  const expanded: MaterializeOutcome['expanded'] = [];
  for (const p of resolved.parts) {
    const code = String(p.childCode ?? '').trim();
    const color = String(p.color ?? '').trim();
    if (!code || !color) return { ...NO_MATERIALIZE('missingColor'), roles }; // 字典残缺：不写半套
    const style = ensureStyleByCode(code);
    const sc = ensureStyleColor(style.id, style.code, color);
    want.push({ role: p.role, styleColorId: sc.id, qtyPerSet: p.qty });
    expanded.push({ role: p.role, styleCode: style.code, color, qty: p.qty });
  }
  const r = replaceItemParts(id, want);
  if (!r.ok) return { ...NO_MATERIALIZE('missingColor'), roles }; // 校验失败 = 什么都不写（replaceItemParts 已事务保护）
  return { status: 'written', parts: r.parts, roles, expanded };
}

/**
 * ⭐ 一个订单行的**款色集合 —— 唯一读取口径**（采购需求、拣货、核对页都从这里取）。
 *
 * 有部件 ⇒ 只返回部件集。**绝不**再把该行的单品款色并进来：套装行上那个 `style_color_id`
 *   是"这张套装图整体像哪个款"的残留，并进来就是同一件实物算两遍。
 * 无部件 ⇒ 回落单品款色（口径 = `ITEM_STYLE_COLOR_ID`：**行优先、图回落**）。
 *
 *   `oi_order_items.style_color_id` 是权威（订单驱动归类、人工归款都写它）；
 *   色行上的 `image_id`（R1 起是"图 → 色"的唯一落点）只在该行还没归类时兜底。
 *   两者都经 `ITEM_STYLE_COLOR_ID` 一份实现，别在这里另写 `COALESCE`。
 *
 * 返回值已去重、按部件录入顺序（单件时长度为 0 或 1）。
 */
export function itemStyleColorIds(orderItemId: number): number[] {
  const id = Number(orderItemId) || 0;
  if (id <= 0) return [];
  // 口径只有一份：`ITEM_STYLE_COLOR_SRC`（有部件出部件集、无部件回落图款色），
  // 采购/拣货等汇总口径读的是同一条 —— 不在这里另写一遍 JOIN，否则就是第二套口径。
  const rows = dbQuery<{ style_color_id: number }>(
    `SELECT v.style_color_id FROM ${ITEM_STYLE_COLOR_SRC} v
      WHERE v.order_item_id = ? AND v.style_color_id > 0
      ORDER BY v.style_color_id`,
    [id],
  ).map((r) => Number(r.style_color_id) || 0);
  return [...new Set(rows.filter((n) => n > 0))];
}

/**
 * 组合键（派生，不落库）：把一个订单行的部件集压成一个可比较的字符串，形如 `12x1+57x1`。
 *
 * 用来回答「这个组合以前见过吗」——同名款色顺序不同的两条（上衣A+裤子B 与 裤子B+上衣A）
 * 必须得到**同一个键**，所以先按款色 id 排序再拼；`qty_per_set` 参与拼接
 * （「含两条裤子」与「含一条」是两个不同商品，不是一个组合的倍率）。
 * 空串 = 这行不是套装。
 */
export function bundleKeyOf(orderItemId: number): string {
  const id = Number(orderItemId) || 0;
  if (id <= 0) return '';
  const row = dbGet<{ k: string | null }>(
    `SELECT group_concat(style_color_id || 'x' || qty_per_set, '+') AS k
       FROM (SELECT style_color_id, qty_per_set FROM oi_item_parts
              WHERE order_item_id = ? ORDER BY style_color_id, qty_per_set)`,
    [id],
  );
  return String(row?.k ?? '');
}

