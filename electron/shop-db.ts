// electron/shop-db.ts
// 「店铺」主数据数据访问层（基于 electron/db.ts 公共层），随主程序分发。
//
// 定位（ADR-002 / ADR-003 / DOMAIN_INTEGRATION_PLAN S1）
//   店铺属**主数据层**：schema 与写入权挂宿主中立层（C3），不挂在可卸载的市场 UI 岛上。
//   历史病根（该计划 D1/D2）：**店铺实体根本不存在** —— 店铺名以自由文本各存两处
//   （`oi_orders.shop` / `purchase_sources.shop`），且互相拷贝。
//   （2026-10-15：`ae_orders.shop_name` 曾是的第三个来源，随 `ae_orders` 弃表一并删。）
//   本层新增两张表补上"实体层"，历史文本**一律不改写**（G2）：查询时靠 `sk_name_map` 旁挂归一。
//
//   sk_shops        店铺 + 账号**物理合并**（ADR-003，2026-10-22）：
//                   身份列（店名 / 平台店铺ID / 地址）与账号列（邮箱 / 企业 / 工具账号 / 凭证）
//                   是同一行的两种完成度 —— `name = ''` = 只有账号、还没建店铺；
//                   `email = ''` = 只有店铺、账号待补；两者都空由 CHECK 拒绝。
//                   部分唯一索引是核心：`name_key = ''` 不参与店名唯一性、`email = ''` 不参与邮箱唯一性。
//                 + `platform_shop_id`（2026-09-27 新增）：店铺实体的**稳定业务键**；
//                   唯一性走部分索引（`WHERE platform_shop_id <> ''`），没填标识的店不受约束。
//                 + `shop_url` / `shop_url_raw`（2026-10-16 拆两列）：**一列一个角色** ——
//                    `shop_url` = 采集帧的**匹配键**（协议/www/尾斜杠/index.html/查询串全剥掉的小写形）；
//                    `shop_url_raw` = 用户在界面里填的**地址原文**（展示 + 「打开店铺」的目标）。
//                    ⚠️ 两列各司其职，别再合成一列：归一化后的匹配键**打不开**（`openExternal`
//                       要求 `http(s)://` 开头，无协议直接报"链接地址无效"），
//                       而带协议的原文**匹配不上**采集帧的 URL 变体 —— 2026-10-16 之前是后者
//                       被前者吃掉（用户填 `https://x.com` 存进去变 `x.com`，「打开店铺」必报无效）。
//   sk_tool_accounts 紫鸟 / ERP 登录（一条登录一份密码，多店共享；店铺行只存外键）
//   sk_name_map      名称归一映射：`(kind, raw_key)` UNIQUE → ref_id / ignored（kind 为 supplier /
//                    style / product 预留，产品库 P3 的编码归一会复用同一张表）
//
// 共享域投影（`shop-list` / `shop-get` / `shop-summary`）**只返回有店名的行**，且不返回账号列与凭证——
//   「货与成本」的店铺选择器、订单利润、拣货都不该看到纯账号行，更不该看到密码（AGENTS.md §1.7）。
//
// 三条口径（都是被真实数据逼出来的，别改宽）
//   1. **只做「去空白 + 剥不可见字符」**（G6）：不做模糊匹配、不做大小写折叠。相似店名在真实数据里
//      是**不同**的店（ADR-002「Q3 数据证据」），自动合并会把钱算错，且不可逆。
//   2. **不猜歧义**：同一个归一键若命中多于一家店（同名不同平台是合法的），就不给"精确命中"提示，
//      让人来选。猜错一次就是两家店的账并到一起。
//   3. **`sk_name_map` 只存"人的决定"**：本层不写 `source='auto'` 的占位行。
//      未归一名单是**每次实时聚合两处文本**算出来的（`listUnmapped`），不是一张会被放陈的缓存表 ——
//      否则删了订单/重导之后名单就与源头不一致了。
//   4. **平台店铺ID 是"落点之后"的锚，不是"替代落点"**（2026-09-27 逐处实测）：两处历史文本
//      （`oi_order_items.raw_fields` / `purchase_sources`）**都没有店铺标识列**，
//      全库唯一能拿来比对订单的仍然是店名字符串。所以这个字段解决不了"订单自动关联"，
//      它能解决的是两件名称归一永远做不到的事：
//        a. **改名不断链** —— 名称一变，历史文本就指向不存在的东西；标识不变。
//        b. **收拢同一家店的多种写法** —— 实测订单侧 42 行出现 7 种店名，其中 `Shop1105228632 Store`
//           只在订单侧、按名称永远归不到「十店」上，但两者可以是同一个标识。
//
// 迁移（`shop.main` v1，一次性、不可逆）
//   老 `sk_shops` 的表级 `UNIQUE(platform, name_key)` 要换成部分唯一索引；邮件表外键要从
//   `sk_shop_sets(id)` 改指 `sk_shops(id)`。SQLite 两件事都只能重建表，且 `RENAME COLUMN`
//   不会改外键目标。迁移必须自己管事务：`PRAGMA foreign_keys=OFF` 在事务内无效。
//   迁移前 `VACUUM INTO` 备份是唯一退路；预检不通过就抛错回滚，旧库原样保留。
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
  migrationVersion,
  tableExists,
  getDb,
  getDbFilePath,
} from './db';
import { ensureCompanySchema } from './company-db';
import {
  encodeSecrets,
  decodeSecretsRaw,
  SHOP_SECRET_KEYS,
  type ShopSecretKey,
} from './shop-secrets';
import { mergeNameGroups, toNameKey, type NameSourceGroup, type MergedName } from './shopName';

// ---- 类型（与渲染层 src/types.ts 对应结构保持一致；两端各自声明，避免主进程 import 渲染层） ----

/**
 * 店铺状态：启用 / 停用 / 封店 / 退店。
 * 后三者都只是标记，不物理删除 —— 历史订单 / 采购仍指向它。
 */
export type ShopStatus = 'active' | 'archived' | 'banned' | 'exited';
export const SHOP_STATUSES: readonly ShopStatus[] = [
  'active',
  'archived',
  'banned',
  'exited',
];

/** 归一映射的实体类型（S1 只用 shop；其余为 supplier / style / product 预留） */
export type NameMapKind = 'shop' | 'supplier' | 'style' | 'product';
export const NAME_MAP_KINDS: readonly NameMapKind[] = ['shop', 'supplier', 'style', 'product'];

/** 工具账号类型（紫鸟 / ERP 共用一个形状） */
export type ToolAccountKind = 'ziniao' | 'erp';
export const TOOL_ACCOUNT_KINDS: readonly ToolAccountKind[] = ['ziniao', 'erp'];

/**
 * 店铺列表项（**共享只读投影**）。
 * ⚠️ 这里刻意只有店铺身份列：账号 / 企业 / 工具 / 凭证属 `shop-accounts` 域，
 *    由 `shop-accounts-db.ts` 的合并列表返回。共享域多给一列，就是多一条密码泄漏面。
 */
export interface ShopListItem {
  id: number;
  platform: string;
  name: string;
  /** 归一键（展示用不上，导出/核对时有用） */
  nameKey: string;
  /** 平台店铺ID（**归一后**的值；'' = 未填）—— 店铺实体的稳定业务键，改名不影响 */
  platformShopId: string;
  /**
   * 店铺地址（**原文**：界面回显 + 「打开店铺」的目标；'' = 未填）。
   * ⚠️ 这是界面唯一该读的那个。DB 里的匹配键列（`shop_url`）**故意不出现在本结构里** ——
   *    没有消费者，而且它打不开（见 `openExternal` 的协议判据）。
   */
  shopUrl: string;
  site: string;
  status: string;
  /** 记分分值（平台记分 / 扣分；0 = 未记录） */
  score: number;
  openedAt: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  /** 已归一到本店的历史文本条数（含被忽略的不算） */
  aliasCount: number;
}

/**
 * 店铺侧新增/更新入参（**局部更新**语义：`undefined = 保持原值`，`'' = 清空`）。
 * ⚠️ 物理合并后这条语义是硬约束：店铺选择器编辑一次不能把同一行的邮箱 / 企业 / 工具 / 凭证清空。
 */
export interface ShopUpsertInput {
  /** 0 / 缺省 = 新增 */
  id: number;
  platform?: string;
  name?: string;
  /** 平台店铺ID（可空；非空时参与唯一性 —— 同平台内不得重复） */
  platformShopId?: string;
  /** 店铺地址（采集帧精确连接键；可空） */
  shopUrl?: string;
  site?: string;
  status?: string;
  /** 记分分值（≥ 0；缺省 = 保持原值，0 = 清为未记录） */
  score?: number;
  openedAt?: string;
  note?: string;
}

export interface ShopListQuery {
  offset: number;
  limit: number;
  search: string;
  platform: string;
  status: string;
}

/** 未归一的历史店铺名（一次实时聚合的结果） */
export interface UnmappedShopRow {
  /** 归一键 —— `mapName` / `unmapName` 的入参 */
  key: string;
  /** 展示用原文 */
  raw: string;
  /** 两处文本里出现的总条数 */
  occurrences: number;
  /** 出现过的来源（order / purchase） */
  sources: string[];
  /** 若恰好能按精确名唯一命中一家店铺，给出 id 供"一键采纳"（**不自动写映射**） */
  autoShopId: number;
  autoShopName: string;
  autoShopPlatform: string;
}

export interface ShopSummary {
  total: number;
  byPlatform: { platform: string; count: number }[];
  byStatus: { status: string; count: number }[];
  /** 历史文本侧的归一进度 */
  names: {
    /** 两处文本去重并归一后的名称总数（不含空/纯空白） */
    total: number;
    mapped: number;
    unmapped: number;
    ignored: number;
    /** 未归一里能按精确名唯一命中的条数（"一键采纳"能消掉多少） */
    autoMatched: number;
    /** 映射表里已指向店铺、但这些名称在文本里已不存在（映射过期，可清理） */
    stale: number;
  };
}

// ---- 表结构 ----

/**
 * ⚠️ `name_key` 不是冗余列：店名唯一性必须建在**归一键**上。
 * 若只对 `name` 建唯一约束，`"店A"` 与 `"店A "` 会同时入库 → 同一个键命中两家店 →
 * 自动命中的语义立刻破产（"同名不同平台"是合法的，但"同平台同归一名的两家店"不是）。
 *
 * 部分唯一索引（而不是表级 UNIQUE）是「一行同时容纳两种空态」的前提：
 * 纯账号行 `name_key=''`、纯店铺行 `email=''` 都不参与各自维度的唯一性。
 */
function shopTableSql(table: string, ifNotExists = false): string {
  return `CREATE TABLE ${ifNotExists ? 'IF NOT EXISTS ' : ''}${table} (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL DEFAULT 'ae',
    name TEXT NOT NULL DEFAULT '',
    name_key TEXT NOT NULL DEFAULT '',
    platform_shop_id TEXT NOT NULL DEFAULT '',
    shop_url TEXT NOT NULL DEFAULT '',
    shop_url_raw TEXT NOT NULL DEFAULT '',
    site TEXT NOT NULL DEFAULT '',
    email TEXT NOT NULL DEFAULT '',
    company_id INTEGER NOT NULL DEFAULT 0,
    ziniao_account_id INTEGER NOT NULL DEFAULT 0,
    erp_account_id INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    score REAL NOT NULL DEFAULT 0,
    opened_at TEXT NOT NULL DEFAULT '',
    deposit_received_at TEXT NOT NULL DEFAULT '',
    tags TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    secret_enc BLOB,
    secret_keys TEXT NOT NULL DEFAULT '[]',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    CHECK (trim(name) <> '' OR trim(email) <> ''),
    CHECK (
      (trim(name) = '' AND trim(name_key) = '') OR
      (trim(name) <> '' AND trim(name_key) <> '')
    )
  )`;
}

const TOOL_ACCOUNTS_DDL = `CREATE TABLE IF NOT EXISTS sk_tool_accounts (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK (kind IN ('ziniao', 'erp')),
  account TEXT NOT NULL DEFAULT '',
  account_key TEXT NOT NULL DEFAULT '',
  password_enc BLOB,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT '',
  UNIQUE (kind, account_key),
  CHECK (trim(account) <> '')
)`;

const NAME_MAP_DDL = `CREATE TABLE IF NOT EXISTS sk_name_map (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL DEFAULT 'shop',
  raw TEXT NOT NULL DEFAULT '',
  raw_key TEXT NOT NULL,
  ref_id INTEGER NOT NULL DEFAULT 0,
  ignored INTEGER NOT NULL DEFAULT 0,
  source TEXT NOT NULL DEFAULT 'manual',
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
  UNIQUE(kind, raw_key)
)`;

// ⚠️ 有意**不建** `confidence` 列：G6 已裁定模糊匹配永不写 ref_id，故没有任何生产者会写它，
//    留一个恒 0 的死列不如以后真需要时按 `sk_shop_sets.opened_at` 的先例 ALTER 增量补列。
const SCHEMA = [shopTableSql('sk_shops', true), TOOL_ACCOUNTS_DDL, NAME_MAP_DDL];

const INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_sk_shops_platform_name
     ON sk_shops(platform, name_key) WHERE trim(name_key) <> ''`,
  `CREATE UNIQUE INDEX IF NOT EXISTS uq_sk_shops_email
     ON sk_shops(lower(email)) WHERE trim(email) <> ''`,
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sk_shops_platform_sid
     ON sk_shops(platform, platform_shop_id) WHERE platform_shop_id <> ''`,
  `CREATE INDEX IF NOT EXISTS idx_sk_shops_name_key ON sk_shops(name_key)`,
  `CREATE INDEX IF NOT EXISTS idx_sk_shops_status ON sk_shops(status)`,
  `CREATE INDEX IF NOT EXISTS idx_sk_shops_company ON sk_shops(company_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sk_shops_ziniao ON sk_shops(ziniao_account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sk_shops_erp ON sk_shops(erp_account_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sk_name_map_ref ON sk_name_map(kind, ref_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sk_tool_accounts_kind ON sk_tool_accounts(kind)`,
];

/**
 * 幂等初始化（视图首次激活 / 每个 handler 入口调用）。
 *
 * 启动编排（main.ts）**先企业、再店铺、后邮件**：店铺迁移要把账号侧的手机号 / 支付宝回填进企业表。
 * 各 handler 里的懒 ensure 保持不变；`ensureCompanySchema()` 幂等且很轻。
 *
 * ⚠️ 建表必须在**迁移之前**：迁移收尾会按 `INDEXES` 建索引，其中
 * `idx_sk_name_map_ref` 指向 `sk_name_map` —— 迁移先跑时这张表还不存在，
 * 老库第一次启动就抛 `no such table: main.sk_name_map`（2026-10-22 由 shop-item 冒烟抓到）。
 * `CREATE TABLE IF NOT EXISTS` 对已存在的老表一个字都不改，所以先建不会把迁移抢走。
 */
export function ensureShopSchema(): void {
  initDb();
  ensureCompanySchema();
  dbMigrate(SCHEMA);
  runShopMainMigration();
  runShopColumnsMigration();
  dbMigrate(INDEXES);
}

// ---- shop.columns：物理合并之后的增量补列 ----
//
// `shop.main` 是整表重建（自带事务外壳 + 版本判断），不能再往上叠补列步骤 ——
// 它的版本号一旦 ≥ 1 就整段跳过。故增量列走独立 key，互不影响。

const SHOP_COLUMNS_KEY = 'shop.columns';

/** 老库补 `score`（记分分值）。新库由 `shopTableSql` 建表时已含，这里幂等跳过。 */
function ensureShopScoreColumn(): void {
  if (!tableExists('sk_shops')) return;
  if (columnSet('sk_shops').has('score')) return;
  dbRun(`ALTER TABLE sk_shops ADD COLUMN score REAL NOT NULL DEFAULT 0`);
}

/** 老库补 `deposit_received_at`（保证金到账时间，仅退店时有意义）。 */
function ensureShopDepositColumn(): void {
  if (!tableExists('sk_shops')) return;
  if (columnSet('sk_shops').has('deposit_received_at')) return;
  dbRun(`ALTER TABLE sk_shops ADD COLUMN deposit_received_at TEXT NOT NULL DEFAULT ''`);
}

function runShopColumnsMigration(): void {
  migrate(SHOP_COLUMNS_KEY, [
    { version: 1, name: 'sk_shops 补 score（记分分值）', up: ensureShopScoreColumn },
    {
      version: 2,
      name: 'sk_shops 补 deposit_received_at（保证金到账时间）',
      up: ensureShopDepositColumn,
    },
  ]);
}

// ---- shop.main v1 迁移 ----

const SHOP_MAIN_KEY = 'shop.main';
const SHOP_MAIN_VERSION = 1;

type MigrationRow = Record<string, any>;

function columnSet(table: string): Set<string> {
  if (!tableExists(table)) return new Set();
  return new Set(
    dbQuery<{ name: string }>(`PRAGMA table_info(${table})`).map((r) => String(r.name ?? '')),
  );
}

function applyShopMainLedger(): void {
  dbRun(
    `INSERT INTO sk_schema_migrations (key, version, applied_at)
     VALUES (?, ?, datetime('now','localtime'))
     ON CONFLICT(key) DO UPDATE SET version = excluded.version, applied_at = excluded.applied_at`,
    [SHOP_MAIN_KEY, SHOP_MAIN_VERSION],
  );
}

/**
 * 迁移前备份。
 *
 * ⚠️ `VACUUM INTO` 必须在事务外执行；备份失败按「暂停迁移」处理 —— 这次迁移会删表删列，
 *    没有 SQL 级回滚，备份是唯一退路。
 *
 * ⚠️ 目标名必须**避让已存在的文件**：`VACUUM INTO` 撞到已有路径直接报错，而"上一次尝试留下过
 *    备份"是常态（迁移预检失败 ⇒ 事务回滚、数据没动，但备份文件已经写出去了）。
 *    若按秒级时间戳定名，用户修好数据再启动就会撞名 ⇒ 备份失败 ⇒ 暂停迁移 ⇒ **永远进不去**
 *    （症状是"应用起不来 / 店铺页一直报错"，而真正原因只有一个已存在的 .bak 文件）。
 */
function backupBeforeMigration(): string {
  const fs = require('fs');
  const source = getDbFilePath();
  if (!source || !fs.existsSync(source)) return '';
  const stamp = new Date().toISOString().replace(/[-:]/g, '').replace(/\..+$/, '');
  let target = `${source}.bak-shop-merge-v1-${stamp}`;
  for (let i = 1; fs.existsSync(target); i++) {
    if (i > 50) throw new Error(`迁移前备份名重复过多（${target}）—— 请先清理旧的 .bak-shop-merge-v1-* 文件`);
    target = `${source}.bak-shop-merge-v1-${stamp}-${i}`;
  }
  try {
    getDb().prepare('VACUUM INTO ?').run(target);
    return target;
  } catch (err: any) {
    throw new Error(`迁移前备份失败，已暂停迁移：${err?.message || err}`);
  }
}

/**
 * 执行 `shop.main` v1。
 *
 * 为什么不用 `migrate()`：它在事务内跑步骤，而 `PRAGMA foreign_keys=OFF` 在事务内**无效**；
 * 重建 `sk_shops` / `sk_mail_accounts` 时必须关外键（否则 DROP 旧表会级联删子表）。
 * 账本仍写 `sk_schema_migrations`（key `shop.main`，version 1），只是事务外壳自己管。
 */
function runShopMainMigration(): void {
  // 只为确保账本表存在（步骤表刻意留空：真正的迁移自己管事务外壳，见下方注释）
  migrate(SHOP_MAIN_KEY, []);
  if (migrationVersion(SHOP_MAIN_KEY) >= SHOP_MAIN_VERSION) return;

  const hasShops = tableExists('sk_shops');
  const hasSets = tableExists('sk_shop_sets');
  if (!hasShops && !hasSets) {
    // 新库：形状由 dbMigrate(SCHEMA) 建（它在迁移**之前**跑，见 ensureShopSchema 注释）；这里只补账本
    applyShopMainLedger();
    return;
  }

  const shopCols = columnSet('sk_shops');
  // 「已是新形状」必须**同时**没有 sk_shop_sets：迁移收尾会 DROP 它，所以它还留着 = 这台机器
  // 从没做过合并（例如只有账号表、没有店铺表的早期库）。只看形状就补账本，会把账号行永久孤立。
  if (hasShops && shopCols.has('email') && !shopCols.has('shop_set_id') && !hasSets) {
    // 已是新形状（例如上次迁移已跑完但账本行丢失）——只补账本
    applyShopMainLedger();
    return;
  }

  const backup = backupBeforeMigration();
  const db = getDb();
  db.pragma('foreign_keys = OFF');
  try {
    dbTransaction(() => {
      migrateShopMainV1();
      applyShopMainLedger();
    });
  } finally {
    db.pragma('foreign_keys = ON');
  }
  if (backup) {
    // eslint-disable-next-line no-console
    console.log(`[shop.main] 迁移完成；迁移前备份：${backup}`);
  }
}

/** 老 `sk_shop_sets` 形状（仅在历史 `sk_accounts` 存在、需要临时落点时创建） */
const LEGACY_SET_DDL = `CREATE TABLE IF NOT EXISTS sk_shop_sets (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL DEFAULT '',
  phone TEXT NOT NULL DEFAULT '',
  company TEXT NOT NULL DEFAULT '',
  company_id INTEGER NOT NULL DEFAULT 0,
  alipay TEXT NOT NULL DEFAULT '',
  ziniao_account TEXT NOT NULL DEFAULT '',
  erp_account TEXT NOT NULL DEFAULT '',
  platforms TEXT NOT NULL DEFAULT '[]',
  opened_at TEXT NOT NULL DEFAULT '',
  status TEXT NOT NULL DEFAULT 'active',
  tags TEXT NOT NULL DEFAULT '',
  note TEXT NOT NULL DEFAULT '',
  secret_enc BLOB,
  secret_keys TEXT NOT NULL DEFAULT '[]',
  created_at TEXT NOT NULL DEFAULT '',
  updated_at TEXT NOT NULL DEFAULT ''
)`;

/** 老库补列：`sk_shop_sets.opened_at` / `company_id`（历史增量列） */
function ensureLegacySetColumns(): void {
  if (!tableExists('sk_shop_sets')) return;
  const cols = columnSet('sk_shop_sets');
  if (!cols.has('opened_at')) {
    dbRun(`ALTER TABLE sk_shop_sets ADD COLUMN opened_at TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.has('company_id')) {
    dbRun(`ALTER TABLE sk_shop_sets ADD COLUMN company_id INTEGER NOT NULL DEFAULT 0`);
  }
}

/** 老 `sk_shops` 补列（迁移读取前先补齐，避免缺列导致 SQL 报错） */
function ensureLegacyShopColumns(): void {
  const cols = columnSet('sk_shops');
  if (!cols.has('platform_shop_id')) {
    dbRun(`ALTER TABLE sk_shops ADD COLUMN platform_shop_id TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.has('shop_url')) {
    dbRun(`ALTER TABLE sk_shops ADD COLUMN shop_url TEXT NOT NULL DEFAULT ''`);
  }
  if (!cols.has('shop_url_raw')) {
    dbRun(`ALTER TABLE sk_shops ADD COLUMN shop_url_raw TEXT NOT NULL DEFAULT ''`);
    // 存量回填：老库的 `shop_url` 里存的是**归一化键**（无协议），直接拿去「打开店铺」必报
    // "链接地址无效"。补 `https://` 让这些老行当场可点 —— 90% 的电商站是 https，
    // 真不是的话用户在抽屉里改一次就对了（比"点了没反应"强）。
    dbRun(
      `UPDATE sk_shops SET shop_url_raw = 'https://' || shop_url
        WHERE shop_url_raw = '' AND shop_url <> ''`,
    );
  }
}

/**
 * 上一版扁平「账号 + category」模型（sk_accounts）→ `sk_shop_sets`。
 * 与旧 `migrateLegacyAccounts` 同口径，只是落点改到迁移内部的临时老表，随后随迁移一起消失。
 */
function materializeLegacyAccounts(): void {
  if (!tableExists('sk_accounts')) return;
  dbRun(LEGACY_SET_DDL);
  ensureLegacySetColumns();
  const rows = dbQuery<MigrationRow>(`SELECT * FROM sk_accounts`);
  for (const row of rows) {
    const rawSecrets = decodeSecretsRaw(coerceBuffer(row.secret_enc));
    const secrets: Record<string, string> = {};
    if (rawSecrets.loginPwd) secrets.shopPwd = rawSecrets.loginPwd;
    if (rawSecrets.emailPwd) secrets.emailPwd = rawSecrets.emailPwd;
    if (rawSecrets.payPwd) secrets.alipayPwd = rawSecrets.payPwd;
    const email = String(row.email ?? '').trim();
    if (!email) continue;
    const platforms = String(row.platform ?? '').trim() ? [String(row.platform).trim()] : [];
    const now = new Date().toISOString();
    dbRun(
      `INSERT INTO sk_shop_sets
         (email, phone, company, company_id, alipay, ziniao_account, erp_account, platforms,
          opened_at, status, tags, note, secret_enc, secret_keys, created_at, updated_at)
       VALUES (?, ?, '', 0, ?, '', '', ?, '', 'active', ?, ?, ?, ?, ?, ?)`,
      [
        email,
        String(row.phone ?? '').trim(),
        String(row.alipay ?? '').trim(),
        JSON.stringify(platforms),
        String(row.tags ?? '').trim(),
        String(row.note ?? '').trim(),
        encodeSecrets(secrets),
        JSON.stringify(Object.keys(secrets)),
        String(row.created_at || now),
        String(row.updated_at || now),
      ],
    );
  }
  dbRun(`DROP TABLE IF EXISTS sk_accounts`);
}

function coerceBuffer(value: unknown): Buffer | null {
  return Buffer.isBuffer(value) ? value : null;
}

/**
 * 状态合并（店铺侧优先；账号侧旧状态并入新四态）：
 * - 店铺侧已是非启用态（停用 / 封店 / 退店）→ 原样保留，它才是被明确标记的那个；
 * - 账号侧 `banned` → 封店、`closed` → 退店、其余非启用（paused / archived）→ 停用。
 */
function mergeStatus(shopStatus: unknown, accountStatus: unknown): ShopStatus {
  const shop = normStatus(shopStatus);
  if (shop !== 'active') return shop;
  const account = String(accountStatus ?? '').trim();
  if (account === 'banned') return 'banned';
  if (account === 'closed') return 'exited';
  if (account && account !== 'active') return 'archived';
  return 'active';
}

/** 店铺行敏感字段（只取白名单键；旧 ziniaoPwd / erpPwd 不搬进来，它们归工具账号） */
function shopSecretsOf(set: MigrationRow): Partial<Record<ShopSecretKey, string>> {
  const raw = decodeSecretsRaw(coerceBuffer(set.secret_enc));
  const out: Partial<Record<ShopSecretKey, string>> = {};
  for (const key of SHOP_SECRET_KEYS) {
    if (raw[key]) out[key] = raw[key];
  }
  return out;
}

/** 没有任何企业信息的账号：旧手机号 / 支付宝原值写进备注（不建企业壳） */
function appendLegacyNote(note: string, set: MigrationRow): string {
  const bits: string[] = [];
  const phone = String(set.phone ?? '').trim();
  const alipay = String(set.alipay ?? '').trim();
  if (phone) bits.push(`手机号 ${phone}`);
  if (alipay) bits.push(`支付宝 ${alipay}`);
  if (!bits.length) return note;
  const line = `迁移遗留：${bits.join('；')}`;
  return note ? `${note}\n${line}` : line;
}

interface CompanyResolution {
  companyId: number;
  pendingName: string;
}

/** `shop.main` v1 主体（必须在 foreign_keys=OFF 的事务内执行） */
function migrateShopMainV1(): void {
  materializeLegacyAccounts();
  ensureLegacySetColumns();
  if (tableExists('sk_shops')) ensureLegacyShopColumns();

  const oldShops = tableExists('sk_shops')
    ? dbQuery<MigrationRow>(`SELECT * FROM sk_shops ORDER BY id ASC`)
    : [];
  const oldSets = tableExists('sk_shop_sets')
    ? dbQuery<MigrationRow>(`SELECT * FROM sk_shop_sets ORDER BY id ASC`)
    : [];
  const mailTable = tableExists('sk_mail_accounts');
  const mailCols = columnSet('sk_mail_accounts');
  const oldMail = mailTable ? dbQuery<MigrationRow>(`SELECT * FROM sk_mail_accounts ORDER BY id ASC`) : [];
  const companies = dbQuery<MigrationRow>(`SELECT * FROM sk_companies`);
  const now = new Date().toISOString();

  const setsById = new Map<number, MigrationRow>();
  for (const set of oldSets) setsById.set(Number(set.id), set);

  // ---- 预检（只读，任一项不满足就抛错回滚） ----

  const emailSeen = new Map<string, number>();
  const platformValues = new Set(['', 'ae', '速卖通']);
  const accountStatuses = new Set(['active', 'paused', 'banned', 'closed', 'archived', '']);
  for (const set of oldSets) {
    const id = Number(set.id);
    const email = String(set.email ?? '').trim();
    if (email) {
      if (!email.includes('@')) throw new Error(`账号 #${id} 的邮箱格式不正确：${email}`);
      const key = email.toLowerCase();
      const other = emailSeen.get(key);
      if (other !== undefined) {
        throw new Error(`邮箱重复（忽略大小写）：${email}（账号 #${other} 与 #${id}）—— 请先人工处理`);
      }
      emailSeen.set(key, id);
    }
    let platforms: unknown = [];
    try {
      platforms = JSON.parse(String(set.platforms ?? '[]'));
    } catch {
      platforms = [];
    }
    if (Array.isArray(platforms)) {
      for (const p of platforms) {
        const v = String(p ?? '').trim().toLowerCase();
        if (!platformValues.has(v)) {
          throw new Error(`账号 #${id} 的平台值不受支持：${String(p)} —— 请先人工处理`);
        }
      }
    }
    const status = String(set.status ?? '').trim();
    if (!accountStatuses.has(status)) {
      throw new Error(`账号 #${id} 的状态值不受支持：${status} —— 请先人工处理`);
    }
  }

  const shopRefs = new Map<number, number[]>();
  for (const shop of oldShops) {
    const setId = Number(shop.shop_set_id) || 0;
    if (!setId) continue;
    const list = shopRefs.get(setId) || [];
    list.push(Number(shop.id));
    shopRefs.set(setId, list);
  }
  for (const [setId, ids] of shopRefs) {
    if (ids.length > 1) {
      throw new Error(`账号 #${setId} 被多家店铺引用（店铺 ${ids.join(', ')}）—— 请先人工处理`);
    }
  }

  if (oldMail.length && mailCols.has('shop_set_id')) {
    for (const mail of oldMail) {
      const sid = Number(mail.shop_set_id) || 0;
      if (!setsById.has(sid)) {
        throw new Error(`邮件账号 #${Number(mail.id)} 指向不存在的账号 #${sid} —— 请先人工处理`);
      }
    }
  }

  // 企业文本歧义（同名多家 = 无法判定，暂停）
  const companyById = new Map<number, MigrationRow>();
  const companyNameHits = new Map<string, number[]>();
  for (const company of companies) {
    companyById.set(Number(company.id), company);
    const key = String(company.name ?? '').trim().toLowerCase();
    if (!key) continue;
    const hits = companyNameHits.get(key) || [];
    hits.push(Number(company.id));
    companyNameHits.set(key, hits);
  }
  for (const set of oldSets) {
    const text = String(set.company ?? '').trim();
    if (!text) continue;
    const hits = companyNameHits.get(text.toLowerCase()) || [];
    if (hits.length > 1) {
      throw new Error(`企业名称「${text}」命中多家企业（${hits.join(', ')}）—— 请先人工处理`);
    }
  }

  // ---- 企业归并：显式 id > 精确名称 > 待新建；纯手机号 / 支付宝不建壳 ----
  const resolved = new Map<number, CompanyResolution>();
  for (const set of oldSets) {
    const id = Number(set.id);
    const explicit = Number(set.company_id) || 0;
    if (explicit > 0 && companyById.has(explicit)) {
      resolved.set(id, { companyId: explicit, pendingName: '' });
      continue;
    }
    const text = String(set.company ?? '').trim();
    if (!text) {
      resolved.set(id, { companyId: 0, pendingName: '' });
      continue;
    }
    const hits = companyNameHits.get(text.toLowerCase()) || [];
    if (hits.length === 1) {
      resolved.set(id, { companyId: hits[0], pendingName: '' });
    } else {
      resolved.set(id, { companyId: 0, pendingName: text });
    }
  }

  interface CompanyGroup {
    companyId: number;
    pendingName: string;
    phones: Set<string>;
    alipays: Set<string>;
  }
  const groups = new Map<string, CompanyGroup>();
  const groupKeyOf = (r: CompanyResolution): string =>
    r.companyId > 0 ? `id:${r.companyId}` : r.pendingName ? `new:${r.pendingName.toLowerCase()}` : '';
  for (const set of oldSets) {
    const id = Number(set.id);
    const r = resolved.get(id);
    if (!r) continue;
    const groupKey = groupKeyOf(r);
    if (!groupKey) continue;
    let group = groups.get(groupKey);
    if (!group) {
      group = {
        companyId: r.companyId,
        pendingName: r.pendingName,
        phones: new Set<string>(),
        alipays: new Set<string>(),
      };
      groups.set(groupKey, group);
    }
    const phone = String(set.phone ?? '').trim();
    const alipay = String(set.alipay ?? '').trim();
    if (phone) group.phones.add(phone);
    if (alipay) group.alipays.add(alipay);
  }
  for (const group of groups.values()) {
    const label = group.companyId > 0 ? `企业 #${group.companyId}` : `企业「${group.pendingName}」`;
    const company = group.companyId > 0 ? companyById.get(group.companyId) : undefined;
    const existingPhone = String(company?.contact_phone ?? '').trim();
    const existingAlipay = String(company?.alipay_account ?? '').trim();
    if (!existingPhone && group.phones.size > 1) {
      throw new Error(`${label} 出现多个不同手机号（${[...group.phones].join(' / ')}）—— 请先人工处理`);
    }
    if (!existingAlipay && group.alipays.size > 1) {
      throw new Error(`${label} 出现多个不同支付宝（${[...group.alipays].join(' / ')}）—— 请先人工处理`);
    }
  }

  for (const group of groups.values()) {
    const phone = group.phones.size === 1 ? [...group.phones][0] : '';
    const alipay = group.alipays.size === 1 ? [...group.alipays][0] : '';
    if (group.companyId > 0) {
      const company = companyById.get(group.companyId)!;
      if (phone && !String(company.contact_phone ?? '').trim()) {
        dbRun(`UPDATE sk_companies SET contact_phone = ?, updated_at = ? WHERE id = ?`, [
          phone,
          now,
          group.companyId,
        ]);
        company.contact_phone = phone;
      }
      if (alipay && !String(company.alipay_account ?? '').trim()) {
        dbRun(`UPDATE sk_companies SET alipay_account = ?, updated_at = ? WHERE id = ?`, [
          alipay,
          now,
          group.companyId,
        ]);
        company.alipay_account = alipay;
      }
      continue;
    }
    const info = dbRun(
      `INSERT INTO sk_companies (name, contact_phone, alipay_account, status, note, created_at, updated_at)
       VALUES (?, ?, ?, 'active', '', ?, ?)`,
      [group.pendingName, phone, alipay, now, now],
    );
    group.companyId = info.lastInsertRowid;
    for (const item of resolved.values()) {
      if (
        item.companyId === 0 &&
        item.pendingName &&
        item.pendingName.toLowerCase() === group.pendingName.toLowerCase()
      ) {
        item.companyId = group.companyId;
        item.pendingName = '';
      }
    }
  }

  // ---- 工具账号：按 (kind, lower(trim(account))) 归并；密码冲突 / 孤儿密码暂停 ----
  const tools = new Map<string, { kind: string; account: string; key: string; password: string }>();
  for (const set of oldSets) {
    const id = Number(set.id);
    const raw = decodeSecretsRaw(coerceBuffer(set.secret_enc));
    const pairs = [
      { kind: 'ziniao', login: set.ziniao_account, pwd: raw.ziniaoPwd || '' },
      { kind: 'erp', login: set.erp_account, pwd: raw.erpPwd || '' },
    ];
    for (const pair of pairs) {
      const login = String(pair.login ?? '').trim();
      const password = String(pair.pwd ?? '');
      if (!login) {
        if (password) {
          throw new Error(`账号 #${id} 存了 ${pair.kind} 密码但没有登录名 —— 请先人工处理`);
        }
        continue;
      }
      const key = `${pair.kind}|${login.toLowerCase()}`;
      const existing = tools.get(key);
      if (!existing) {
        tools.set(key, { kind: pair.kind, account: login, key: login.toLowerCase(), password });
      } else if (password && existing.password && password !== existing.password) {
        throw new Error(`${pair.kind} 登录「${login}」出现多个不同密码 —— 请先人工处理`);
      } else if (password && !existing.password) {
        existing.password = password;
      }
    }
  }

  dbRun(TOOL_ACCOUNTS_DDL);
  const toolIds = new Map<string, number>();
  for (const [mapKey, tool] of tools) {
    const info = dbRun(
      `INSERT INTO sk_tool_accounts (kind, account, account_key, password_enc, note, created_at, updated_at)
       VALUES (?, ?, ?, ?, '', ?, ?)`,
      [
        tool.kind,
        tool.account,
        tool.key,
        encodeSecrets({ pwd: tool.password }),
        now,
        now,
      ],
    );
    toolIds.set(mapKey, info.lastInsertRowid);
  }

  // ---- 重建 sk_shops：先插旧店铺（显式 id，保证 1–9 不变），再插纯账号 ----
  dbRun(shopTableSql('sk_shops_new'));
  const loadShopsSql = `INSERT INTO sk_shops_new
    (id, platform, name, name_key, platform_shop_id, shop_url, shop_url_raw, site, email,
     company_id, ziniao_account_id, erp_account_id, status, opened_at, tags, note,
     secret_enc, secret_keys, created_at, updated_at)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
  const loadAccountsSql = `INSERT INTO sk_shops_new
    (platform, name, name_key, email, company_id, ziniao_account_id, erp_account_id,
     status, opened_at, tags, note, secret_enc, secret_keys, created_at, updated_at)
    VALUES ('ae', '', '', ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;

  const rowIdBySet = new Map<number, number>();
  for (const shop of oldShops) {
    const id = Number(shop.id);
    const set = setsById.get(Number(shop.shop_set_id) || 0);
    const name = String(shop.name ?? '').trim();
    const nameKey = toNameKey(name);
    const email = String(set?.email ?? '').trim();
    if (!name && !email) {
      throw new Error(`店铺 #${id} 既没有店名也没有可合并的账号 —— 请先人工处理`);
    }
    if (name && !nameKey) {
      throw new Error(`店铺 #${id} 的名称只有空白字符 —— 请先人工处理`);
    }
    const resolution = set ? resolved.get(Number(set.id)) : undefined;
    const secrets = set ? shopSecretsOf(set) : {};
    const status = mergeStatus(shop.status, set?.status);
    const openedAt = String(set?.opened_at ?? '').trim() || String(shop.opened_at ?? '');
    let note = String(set?.note ?? '');
    if (!resolution?.companyId && set) note = appendLegacyNote(note, set);
    const shopNote = String(shop.note ?? '');
    if (shopNote && shopNote !== note) note = note ? `${note}\n${shopNote}` : shopNote;
    const ziniaoAccount = String(set?.ziniao_account ?? '').trim();
    const erpAccount = String(set?.erp_account ?? '').trim();
    const ziniaoId = ziniaoAccount
      ? toolIds.get(`ziniao|${ziniaoAccount.toLowerCase()}`) || 0
      : 0;
    const erpId = erpAccount ? toolIds.get(`erp|${erpAccount.toLowerCase()}`) || 0 : 0;

    dbRun(loadShopsSql, [
      id,
      String(shop.platform ?? '').trim() || 'ae',
      name,
      nameKey,
      String(shop.platform_shop_id ?? '').trim(),
      String(shop.shop_url ?? ''),
      String(shop.shop_url_raw ?? ''),
      String(shop.site ?? ''),
      email,
      resolution?.companyId || 0,
      ziniaoId,
      erpId,
      status,
      openedAt,
      String(set?.tags ?? ''),
      note,
      encodeSecrets(secrets),
      JSON.stringify(Object.keys(secrets)),
      String(shop.created_at ?? '') || now,
      String(shop.updated_at ?? '') || now,
    ]);
    if (set) rowIdBySet.set(Number(set.id), id);
  }

  for (const set of oldSets) {
    const setId = Number(set.id);
    if (rowIdBySet.has(setId)) continue;
    const email = String(set.email ?? '').trim();
    if (!email) {
      throw new Error(`账号 #${setId} 没有邮箱且未挂店铺 —— 请先人工处理`);
    }
    const resolution = resolved.get(setId);
    const secrets = shopSecretsOf(set);
    let note = String(set.note ?? '');
    if (!resolution?.companyId) note = appendLegacyNote(note, set);
    const ziniaoAccount = String(set.ziniao_account ?? '').trim();
    const erpAccount = String(set.erp_account ?? '').trim();
    const ziniaoId = ziniaoAccount
      ? toolIds.get(`ziniao|${ziniaoAccount.toLowerCase()}`) || 0
      : 0;
    const erpId = erpAccount ? toolIds.get(`erp|${erpAccount.toLowerCase()}`) || 0 : 0;
    const info = dbRun(loadAccountsSql, [
      email,
      resolution?.companyId || 0,
      ziniaoId,
      erpId,
      mergeStatus('active', set.status),
      String(set.opened_at ?? ''),
      String(set.tags ?? ''),
      note,
      encodeSecrets(secrets),
      JSON.stringify(Object.keys(secrets)),
      String(set.created_at ?? '') || now,
      String(set.updated_at ?? '') || now,
    ]);
    rowIdBySet.set(setId, info.lastInsertRowid);
  }

  // ---- 重建 sk_mail_accounts（外键改指 sk_shops.id；保留账号 id 与全部列） ----
  if (mailTable && mailCols.has('shop_set_id')) {
    dbRun(`CREATE TABLE sk_mail_accounts_new (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      shop_id INTEGER NOT NULL UNIQUE REFERENCES sk_shops(id) ON DELETE CASCADE,
      email TEXT NOT NULL DEFAULT '',
      provider_id TEXT NOT NULL DEFAULT '',
      imap_host TEXT NOT NULL DEFAULT '',
      imap_port INTEGER NOT NULL DEFAULT 993,
      imap_secure INTEGER NOT NULL DEFAULT 1,
      proxy TEXT NOT NULL DEFAULT '',
      folder TEXT NOT NULL DEFAULT 'INBOX',
      folders TEXT NOT NULL DEFAULT '',
      sync_enabled INTEGER NOT NULL DEFAULT 1,
      sync_days INTEGER NOT NULL DEFAULT 30,
      max_body_bytes INTEGER NOT NULL DEFAULT 204800,
      status TEXT NOT NULL DEFAULT 'idle',
      last_error TEXT NOT NULL DEFAULT '',
      last_synced_at TEXT NOT NULL DEFAULT '',
      uid_validity INTEGER NOT NULL DEFAULT 0,
      last_uid INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL DEFAULT '',
      updated_at TEXT NOT NULL DEFAULT ''
    )`);
    const loadMailSql = `INSERT INTO sk_mail_accounts_new
      (id, shop_id, email, provider_id, imap_host, imap_port, imap_secure, proxy, folder, folders,
       sync_enabled, sync_days, max_body_bytes, status, last_error, last_synced_at,
       uid_validity, last_uid, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`;
    for (const mail of oldMail) {
      const shopId = rowIdBySet.get(Number(mail.shop_set_id) || 0);
      if (!shopId) {
        throw new Error(`邮件账号 #${Number(mail.id)} 找不到对应的店铺行 —— 请先人工处理`);
      }
      dbRun(loadMailSql, [
        Number(mail.id),
        shopId,
        String(mail.email ?? ''),
        String(mail.provider_id ?? ''),
        String(mail.imap_host ?? ''),
        Number(mail.imap_port ?? 993),
        Number(mail.imap_secure ?? 1),
        String(mail.proxy ?? ''),
        String(mail.folder ?? 'INBOX'),
        String(mail.folders ?? ''),
        Number(mail.sync_enabled ?? 1),
        Number(mail.sync_days ?? 30),
        Number(mail.max_body_bytes ?? 204800),
        String(mail.status ?? 'idle'),
        String(mail.last_error ?? ''),
        String(mail.last_synced_at ?? ''),
        Number(mail.uid_validity ?? 0),
        Number(mail.last_uid ?? 0),
        String(mail.created_at ?? ''),
        String(mail.updated_at ?? ''),
      ]);
    }
    dbRun(`DROP TABLE sk_mail_accounts`);
    dbRun(`ALTER TABLE sk_mail_accounts_new RENAME TO sk_mail_accounts`);
    dbRun(
      `CREATE INDEX IF NOT EXISTS idx_sk_mail_accounts_sync ON sk_mail_accounts(sync_enabled, status)`,
    );
  }

  // ---- 换表：**直接 DROP 旧表**，不能 RENAME 成临时名 ----
  // RENAME 会把 pl_shop_sku / pl_shop_items / sk_mail_* 的外键目标一起改写（legacy_alter_table 默认关），
  // 之后再改回来就找不到原目标了。DROP + 新表改名，子表的外键文本始终指向 `sk_shops` / `sk_mail_accounts`。
  dbRun(`DROP TABLE IF EXISTS sk_shops`);
  dbRun(`ALTER TABLE sk_shops_new RENAME TO sk_shops`);
  dbRun(`DROP TABLE IF EXISTS sk_shop_sets`);
  for (const sql of INDEXES) dbRun(sql);

  const violations = dbQuery<MigrationRow>(`PRAGMA foreign_key_check`);
  if (violations.length) {
    const first = violations[0];
    throw new Error(
      `外键校验失败：${String(first.table ?? '')} 行 #${String(first.rowid ?? '')} → ${String(first.parent ?? '')}`,
    );
  }
}

// ---- 字段规整 ----

/**
 * 店铺地址归一（采集帧**匹配键**的唯一真相源）。
 * 人贴的地址和页面采集的 URL 必然不同形（http/https、www、index.html、尾斜杠、?spm 查询串），
 * 直接精确相等会大面积失配、全落 shop_id=0。落库与匹配都走这一个函数 ⇒ 两端同口径。
 * 返回 '' 表示空；非空的已是「协议+www+尾斜杠+index.html+查询串」都剥掉的小写规范形。
 *
 * ⚠️ 本函数的返回值**只用于匹配**，绝不能再拿去展示或当「打开店铺」的目标 ——
 *    剥掉协议的串 `openExternal` 打不开（2026-10-16 现场）。展示/打开一律用 `toOpenableUrl`。
 */
export function normalizeShopUrl(u: unknown): string {
  if (typeof u !== 'string') return '';
  let s = u.trim().toLowerCase();
  if (!s) return '';
  s = s.replace(/^https?:\/\//, '').replace(/^\/\//, '').replace(/^www\./, '');
  s = s.replace(/[?#].*$/, '').replace(/\/index\.html?$/, '').replace(/\/+$/, '');
  return s;
}

/**
 * 店铺地址**原文**规整（展示 / 「打开店铺」的目标）。
 *
 * 与 `normalizeShopUrl` 的分工：那个是**匹配键**（越归一越好），本函数产出的是**能打开的地址**
 * （协议必须有）。两个职责必须分开 —— 2026-10-16 之前只有前一个函数，于是用户填的地址被
 * 当"匹配键的原料"处理、协议被剥掉，两处「打开店铺」全报"链接地址无效"。
 *
 * 规则：① 已带 `http(s)://` → **原样**（用户填 http 就还是 http，只补不删）；
 *       ② `//host/x`（协议相对）→ 补 `https:`；
 *       ③ 其它协议（`ftp:` / `javascript:` …）→ 原样留着，由 `open-external` 按协议白名单
 *          拒绝并给出中文原因（这里改写成 https 会把"填错了"伪装成"能打开"）；
 *       ④ 其余（裸域名 / 路径）→ 补 `https://`。
 *
 * ⚠️ `upsertShop` 的匹配键**从本函数的返回值派生**（不是从用户原始输入各算一套）：
 *    否则 `//host/x` 这类输入会让原文与键来自两个不同的规整结果，用户下次保存时键就变了，
 *    已采集的行会静默断链（"店还在、商品却掉回未登记桶"）。
 */
export function toOpenableUrl(u: unknown): string {
  if (typeof u !== 'string') return '';
  const s = u.trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.startsWith('//')) return `https:${s}`;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return s;
  return `https://${s}`;
}

/**
 * 给界面看的店铺地址：优先原文，原文缺失时用匹配键**补协议**兜底。
 *
 * 兜底存在的理由：老库迁移中 raw 可能还是空（补列与回填同一事务外被中断 / 早于本次的库
 * 被别处的写入路径只写了键）。这时宁可给一个"几乎肯定对"的 https 地址，也好过让
 * 「打开店铺」直接报无效。
 */
function displayShopUrl(key: string, raw: string): string {
  if (raw) return raw;
  return key ? `https://${key}` : '';
}

const MAX = {
  platform: 40,
  name: 200,
  platformShopId: 100,
  shopUrl: 500,
  site: 40,
  status: 20,
  openedAt: 40,
  note: 2000,
  search: 200,
  kind: 20,
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

function num(v: unknown): number {
  return v !== undefined && v !== null ? Number(v) || 0 : 0;
}

/**
 * 记分分值归一：只接受 ≥ 0 的有限数，保留两位小数。
 * 非法值**抛错**而不是静默归零 —— 把「输错了」写成「没记分」会让用户以为保存成功。
 */
export function normalizeShopScore(value: unknown): number {
  const n = typeof value === 'number' ? value : Number(String(value ?? '').trim());
  if (!Number.isFinite(n) || n < 0) throw new Error('记分分值必须是 0 或正数');
  return Math.round(n * 100) / 100;
}

/**
 * 平台店铺ID 的归一 —— **复用店铺名 / 商品ID 的同一口径**（`toNameKey`：剥不可见字符 → 折叠空白 → trim）。
 * 从 Excel 粘贴带零宽字符/BOM 是常态，标识不归一就会出现"看着一模一样却是两条"。
 *
 * 与名称的一处**有意差别**：名称存 `name` + `name_key` 两列（人要看 `name` 顺眼）；
 * 标识**只存归一后的值** —— 它是机器键，没有"展示形态 vs 匹配形态"的差别，
 * 多留一列只会多一个会分叉的地方。
 */
function toShopIdKey(v: unknown): string {
  return toNameKey(v);
}

function normStatus(v: unknown): ShopStatus {
  const s = str(v, MAX.status);
  return (SHOP_STATUSES as readonly string[]).includes(s) ? (s as ShopStatus) : 'active';
}

function normKind(v: unknown): NameMapKind {
  const s = str(v, MAX.kind);
  return (NAME_MAP_KINDS as readonly string[]).includes(s) ? (s as NameMapKind) : 'shop';
}

// ---- 历史文本来源（D2 的两处自由文本） ----

/**
 * 店铺名的历史来源。**这是"店铺名从哪来"的唯一出处** ——
 * 加来源时改这里即可，`listUnmapped` / `shopSummary` 都从它派生。
 * ⚠️ 两处都是自由文本、且**都没有平台字段**：`sk_shops.platform` 无法从历史文本推导，
 *    只能在登记开店时由人指定（这正是"自动归一填不满店铺表"的原因）。
 *
 * ⚠️ 2026-10-15 移除原第三源 `{ id: 'ae', table: 'ae_orders', column: 'shop_name' }`：
 *    C1 合并后浏览器采集单落订单主干 `oi_orders`（`shop` 列已覆盖同一批文本），
 *    且 `ae_orders` 已被 `ae.main` v3 删除 —— 该源已成死配置。
 */
export const SHOP_NAME_SOURCES = [
  { id: 'order', table: 'oi_orders', column: 'shop' },
  { id: 'purchase', table: 'purchase_sources', column: 'shop' },
] as const;

/** 逐表取 (原文, 条数) 分组；表不存在则跳过（返回空） */
function collectShopNameGroups(): NameSourceGroup[] {
  const groups: NameSourceGroup[] = [];
  for (const src of SHOP_NAME_SOURCES) {
    if (!tableExists(src.table)) continue;
    // ⚠️ 不用 `TRIM(x) <> ''` 过滤：SQLite 的 TRIM 只认半角空格，全角空格构成的值会漏进分组。
    //    空/纯空白统一交给 toNameKey 判定（唯一口径）。
    const rows = dbQuery<{ raw: unknown; c: number }>(
      `SELECT ${src.column} AS raw, COUNT(*) AS c FROM ${src.table} WHERE ${src.column} IS NOT NULL AND ${src.column} <> '' GROUP BY ${src.column}`,
    );
    for (const r of rows) {
      groups.push({ source: src.id, raw: String(r.raw ?? ''), count: num(r.c) });
    }
  }
  return groups;
}

/** 实时聚合两处文本 → 归一后的名称清单 */
function currentNames(): MergedName[] {
  return mergeNameGroups(collectShopNameGroups());
}

/** `(kind, raw_key)` → 映射行 */
function nameMapRows(kind: NameMapKind): Map<string, { refId: number; ignored: boolean }> {
  const m = new Map<string, { refId: number; ignored: boolean }>();
  for (const r of dbQuery<Record<string, unknown>>(
    `SELECT raw_key, ref_id, ignored FROM sk_name_map WHERE kind = ?`,
    [kind],
  )) {
    m.set(String(r.raw_key ?? ''), {
      refId: num(r.ref_id),
      ignored: num(r.ignored) !== 0,
    });
  }
  return m;
}

/**
 * 归一键 → 唯一候选店铺。**只在恰好命中一家时给出**：
 * 同名可以合法地存在于不同平台（唯一性是 platform × name_key），此时"精确命中"本身就是歧义的，
 * 猜哪一家都会错 —— 不猜，让人来选。
 */
function autoMatchIndex(): Map<string, { id: number; name: string; platform: string }> {
  const index = new Map<string, { id: number; name: string; platform: string }>();
  const ambiguous = new Set<string>();
  for (const r of dbQuery<Record<string, unknown>>(
    `SELECT id, platform, name, name_key FROM sk_shops WHERE trim(name_key) <> ''`,
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
  for (const key of ambiguous) index.delete(key);
  return index;
}

// ---- 查询 ----

const COLS = `id, platform, name, name_key, platform_shop_id, shop_url, shop_url_raw, site, status, score, opened_at, note, created_at, updated_at`;

function mapShopRow(row: Record<string, unknown>, aliasCounts: Map<number, number>): ShopListItem {
  const id = num(row.id);
  return {
    id,
    platform: String(row.platform ?? ''),
    name: String(row.name ?? ''),
    nameKey: String(row.name_key ?? ''),
    platformShopId: String(row.platform_shop_id ?? ''),
    // 给界面的是**原文**（可展示、可打开）；匹配键留在库里，不进这个结构
    shopUrl: displayShopUrl(String(row.shop_url ?? ''), String(row.shop_url_raw ?? '')),
    site: String(row.site ?? ''),
    status: String(row.status ?? 'active'),
    score: num(row.score),
    openedAt: String(row.opened_at ?? ''),
    note: String(row.note ?? ''),
    createdAt: String(row.created_at ?? ''),
    updatedAt: String(row.updated_at ?? ''),
    aliasCount: aliasCounts.get(id) ?? 0,
  };
}

/** 每家店铺挂着几条已归一的历史名称 */
function aliasCounts(): Map<number, number> {
  const m = new Map<number, number>();
  for (const r of dbQuery<Record<string, unknown>>(
    `SELECT ref_id, COUNT(*) AS c FROM sk_name_map WHERE kind = 'shop' AND ignored = 0 AND ref_id > 0 GROUP BY ref_id`,
  )) {
    m.set(num(r.ref_id), num(r.c));
  }
  return m;
}

/**
 * 列表（关键字 / 平台 / 状态过滤 + 分页；按平台 → 名称排序，符合"按平台看店"的习惯）。
 * **只列有店名的行**：纯账号行属于 `shop-accounts` 域，不能出现在订单 / 拣货 / 利润的店铺选择器里。
 */
export function listShops(payload: ShopListQuery): { rows: ShopListItem[]; total: number } {
  const search = str(payload?.search, MAX.search);
  const platform = str(payload?.platform, MAX.platform);
  const status = str(payload?.status, MAX.status);

  const where: string[] = [`trim(name) <> ''`];
  const params: (string | number)[] = [];
  if (search) {
    // 平台店铺ID 也进搜索：用户从平台后台抄来的就是一串 ID，搜 ID 比搜名字更常用
    where.push(`(name LIKE ? OR platform_shop_id LIKE ? OR site LIKE ? OR note LIKE ?)`);
    const like = `%${search}%`;
    params.push(like, like, like, like);
  }
  if (platform) {
    where.push(`platform = ?`);
    params.push(platform);
  }
  if ((SHOP_STATUSES as readonly string[]).includes(status)) {
    where.push(`status = ?`);
    params.push(status);
  }
  const whereSql = `WHERE ${where.join(' AND ')}`;

  const offset = Math.max(0, Math.floor(Number(payload?.offset) || 0));
  const limit = Math.min(
    MAX_LIST_LIMIT,
    Math.max(1, Math.floor(Number(payload?.limit) || DEFAULT_LIST_LIMIT)),
  );

  const rowsRaw = dbQuery<Record<string, unknown>>(
    `SELECT ${COLS} FROM sk_shops ${whereSql} ORDER BY platform ASC, name ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset],
  );
  const totalRow = dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM sk_shops ${whereSql}`, params);
  const counts = aliasCounts();
  return {
    rows: rowsRaw.map((r) => mapShopRow(r, counts)),
    total: totalRow ? num(totalRow.c) : 0,
  };
}

/** 单条详情（纯账号行返回 null —— 共享域只认店铺身份） */
export function getShop(id: number): ShopListItem | null {
  const sid = toId(id);
  if (!sid) return null;
  const row = dbGet<Record<string, unknown>>(
    `SELECT ${COLS} FROM sk_shops WHERE id = ? AND trim(name) <> ''`,
    [sid],
  );
  if (!row) return null;
  return mapShopRow(row, aliasCounts());
}

/** 门 1 的一行：订单里出现过、但还没归成店铺实体的店名 */
export interface ShopGateRow {
  /** 归一后的键（`sk_name_map.raw_key` 用的就是它） */
  key: string;
  /** 原文（展示用） */
  raw: string;
  /** 这个店名在订单里有多少行 */
  orders: number;
  /** 同名候选店铺（空 = 库里还没有这家店，得先去登记，不是"点一下认下来"） */
  autoShopName: string;
  autoShopPlatform: string;
}

export interface ShopGate {
  /** 未归一的店铺（按订单行数倒序 —— 大店先做） */
  pending: ShopGateRow[];
  /** 覆盖的订单行数合计（"够不够严重"看这个数，不看店铺家数） */
  orders: number;
}

/**
 * 门 1（店铺归一）：**订单里出现过、却还没归成店铺实体**的店名。
 *
 * 为什么判据是派生的、不是一张"已归一"表：每导一次订单都可能有新店名冒出来，
 * 存标志的后果是第二次导入后标志还说"已完成"（本仓"派生非幂等就必然漂移"）。
 *
 * 三处口径要说清：
 *   ① **"未归一"只有一个实现** —— 本函数不自己判 `sk_name_map` / 忽略标记 / 精确命中，
 *      直接复用 `listUnmapped()`；自己再写一遍，迟早出现"归一页说 3 家、门说 5 家"。
 *   ② **作用域收窄到订单**：`purchase_sources.shop` 是订单导出的下游，把历史拿货单里的旧店名
 *      也算进来，门就永远关不上（那条来源不会因为归一而消失）。
 *   ③ **空店名不进名单**：`toNameKey` 判空（全角空格 / 零宽字符也算空），否则噪音淹没真问题。
 *
 * ⚠️ 这个门**不阻断任何按钮**（原因见 `docs/notes/2026-10-28-order-driven-classify-plan.md` §9.9）：
 *    它保护的是"数字口径"（同一家店被当成两家 ⇒ 同一件货在统计里两行），不是某个动作；
 *    真去拦一个不存在的动作，只会做成一个点不到的门。
 */
export function shopNormalizeGate(): ShopGate {
  const counts = new Map<string, number>();
  if (tableExists('oi_orders')) {
    // `oi_orders` 在别的域、且本域会在建表前被调用 ⇒ 表不在就返回空门，不炸
    for (const r of dbQuery<{ raw: unknown; n: number }>(
      `SELECT shop AS raw, COUNT(*) AS n FROM oi_orders
        WHERE shop IS NOT NULL AND shop <> ''
        GROUP BY shop`,
    )) {
      const key = toNameKey(String(r.raw ?? ''));
      if (!key) continue;
      counts.set(key, (counts.get(key) ?? 0) + num(r.n));
    }
  }
  const pending: ShopGateRow[] = [];
  if (counts.size) {
    for (const u of listUnmapped()) {
      const orders = counts.get(u.key);
      if (!orders) continue; // 只出现在拿货单里的旧店名：不是这个门的事
      pending.push({
        key: u.key,
        raw: u.raw,
        orders,
        autoShopName: u.autoShopName,
        autoShopPlatform: u.autoShopPlatform,
      });
    }
  }
  pending.sort((a, b) => b.orders - a.orders || (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return { pending, orders: pending.reduce((n, r) => n + r.orders, 0) };
}

/**
 * 未归一的历史店铺名（**实时聚合**，不是缓存表 —— 见文件头口径 3）。
 * 已归一（ref_id > 0）与已标记忽略的不出现在这里。
 */
export function listUnmapped(): UnmappedShopRow[] {
  const maps = nameMapRows('shop');
  const auto = autoMatchIndex();
  const out: UnmappedShopRow[] = [];
  for (const n of currentNames()) {
    const m = maps.get(n.key);
    if (m && m.ignored) continue;
    if (m && m.refId > 0) continue;
    const hit = auto.get(n.key);
    out.push({
      key: n.key,
      raw: n.raw,
      occurrences: n.occurrences,
      sources: [...n.sources],
      autoShopId: hit ? hit.id : 0,
      autoShopName: hit ? hit.name : '',
      autoShopPlatform: hit ? hit.platform : '',
    });
  }
  return out;
}

/** 汇总（店铺侧 + 历史文本侧的归一进度；只统计有店名的行） */
export function shopSummary(): ShopSummary {
  const names = currentNames();
  const maps = nameMapRows('shop');
  const auto = autoMatchIndex();

  let mapped = 0;
  let ignored = 0;
  let autoMatched = 0;
  const liveKeys = new Set<string>();
  for (const n of names) {
    liveKeys.add(n.key);
    const m = maps.get(n.key);
    if (m && m.ignored) {
      ignored += 1;
      continue;
    }
    if (m && m.refId > 0) {
      mapped += 1;
      continue;
    }
    if (auto.has(n.key)) autoMatched += 1;
  }
  let stale = 0;
  for (const [key, v] of maps) {
    if (!liveKeys.has(key) && v.refId > 0) stale += 1;
  }

  return {
    total: num(
      dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM sk_shops WHERE trim(name) <> ''`)?.c,
    ),
    byPlatform: dbQuery<{ platform: string; count: number }>(
      `SELECT platform, COUNT(*) AS count FROM sk_shops WHERE trim(name) <> '' GROUP BY platform ORDER BY platform ASC`,
    ).map((r) => ({ platform: String(r.platform ?? ''), count: num(r.count) })),
    byStatus: dbQuery<{ status: string; count: number }>(
      `SELECT status, COUNT(*) AS count FROM sk_shops WHERE trim(name) <> '' GROUP BY status ORDER BY status ASC`,
    ).map((r) => ({ status: String(r.status ?? ''), count: num(r.count) })),
    names: {
      total: names.length,
      mapped,
      unmapped: names.length - mapped - ignored,
      ignored,
      autoMatched,
      stale,
    },
  };
}

// ---- 写入 ----

/**
 * 新增 / 更新店铺（**局部更新**：`undefined = 保持原值`，`'' = 清空`）。
 *
 * **三条唯一性是硬约束**：① `(platform, 店名归一键)`（纯账号行不参与）
 * ② `(platform, 平台店铺ID)`（标识非空时）③ `lower(email)`（由合并域写入时保证，这里不碰 email）。
 * 冲突时**明确抛错**，不静默改名或覆盖 —— 店铺是订单/采购/利润三域的归属维度，
 * 静默合并会把两个店的账算到一起。
 *
 * ⚠️ 本函数**不碰账号列**（email / company_id / 工具引用 / secret_enc / tags）：
 *    物理合并后它们在同一行，全量提交语义会让「货与成本」编辑店铺地址一次就把账号清空。
 *
 * @returns { id, created } created=false 表示更新既有记录
 */
export function upsertShop(input: ShopUpsertInput): { id: number; created: boolean } {
  const id = toId(input?.id);
  const existing = id
    ? dbGet<MigrationRow>(`SELECT * FROM sk_shops WHERE id = ?`, [id])
    : undefined;
  // 更新时先确认目标存在，再查占用 —— 顺序反了会把「改一个已被删除的店」报成「已存在」，
  // 把真正原因盖住（product-db 同款约定）。
  if (id && !existing) throw new Error('店铺不存在或已被删除');

  const platform = (
    input?.platform === undefined
      ? String(existing?.platform ?? '')
      : str(input.platform, MAX.platform)
  ).trim() || 'ae';

  const name =
    input?.name === undefined ? String(existing?.name ?? '').trim() : str(input.name, MAX.name);
  if (!name) throw new Error('店铺名称不能为空');
  const nameKey = toNameKey(name);
  if (!nameKey) throw new Error('店铺名称不能只有空白字符');

  const platformShopId =
    input?.platformShopId === undefined
      ? String(existing?.platform_shop_id ?? '')
      : toShopIdKey(str(input.platformShopId, MAX.platformShopId));

  // 地址落**两列**，一列一个角色（2026-10-16）：
  //   `shop_url_raw` = 原文（展示 / 「打开店铺」的目标）—— 用户填什么协议就是什么协议；
  //   `shop_url`     = 匹配键（采集帧比对用，两侧同口径，否则差一个尾斜杠就失配，审查 P1）。
  // ⚠️ 键**从规整后的原文派生**，两个值来自同一次规整 —— 见 `toOpenableUrl` 注释里的断链坑。
  const shopUrlRaw =
    input?.shopUrl === undefined
      ? String(existing?.shop_url_raw ?? '')
      : toOpenableUrl(input.shopUrl).slice(0, MAX.shopUrl);
  const shopUrl = normalizeShopUrl(shopUrlRaw).slice(0, MAX.shopUrl);

  const valueOf = (value: string | undefined, fallback: unknown, max: number): string =>
    value === undefined ? String(fallback ?? '') : str(value, max);
  const site = valueOf(input?.site, existing?.site, MAX.site);
  // 缺省 = 保持原值（**按原值归一，不能只看是否 archived**：否则封店 / 退店会被悄悄改回启用）
  const status =
    input?.status === undefined ? normStatus(existing?.status) : normStatus(input.status);
  const score =
    input?.score === undefined ? num(existing?.score) : normalizeShopScore(input.score);
  const openedAt = valueOf(input?.openedAt, existing?.opened_at, MAX.openedAt);
  const note = valueOf(input?.note, existing?.note, MAX.note);

  const dup = dbGet<{ id: number; name: string }>(
    `SELECT id, name FROM sk_shops WHERE platform = ? AND name_key = ? AND trim(name_key) <> '' AND id <> ?`,
    [platform, nameKey, id],
  );
  if (dup) {
    throw new Error(
      `该平台下已存在同名店铺：${dup.name}（ID ${num(dup.id)}）—— 同名不同店请改用不同名称或平台`,
    );
  }

  // 平台店铺ID 的**第二道防线**：部分唯一索引会硬拦，但它抛的是
  // `UNIQUE constraint failed: sk_shops.platform, sk_shops.platform_shop_id` —— 用户看不懂，
  // 也分不清撞的是名称还是标识。这里给出指名道姓的错误，索引负责兜住并发/绕过入口的情况。
  if (platformShopId) {
    const dupSid = dbGet<{ id: number; name: string }>(
      `SELECT id, name FROM sk_shops WHERE platform = ? AND platform_shop_id = ? AND id <> ?`,
      [platform, platformShopId, id],
    );
    if (dupSid) {
      throw new Error(
        `该平台下的店铺标识已被占用：${dupSid.name}（ID ${num(dupSid.id)}）—— 一个平台店铺ID 只能对应一家店`,
      );
    }
  }

  if (id) {
    dbRun(
      `UPDATE sk_shops SET platform=?, name=?, name_key=?, platform_shop_id=?, shop_url=?,
         shop_url_raw=?, site=?, status=?, score=?, opened_at=?, note=?,
         updated_at=datetime('now','localtime') WHERE id=?`,
      [
        platform,
        name,
        nameKey,
        platformShopId,
        shopUrl,
        shopUrlRaw,
        site,
        status,
        score,
        openedAt,
        note,
        id,
      ],
    );
    return { id, created: false };
  }

  const info = dbRun(
    `INSERT INTO sk_shops
       (platform, name, name_key, platform_shop_id, shop_url, shop_url_raw, site,
        status, score, opened_at, note)
     VALUES (?,?,?,?,?,?,?,?,?,?,?)`,
    [
      platform,
      name,
      nameKey,
      platformShopId,
      shopUrl,
      shopUrlRaw,
      site,
      status,
      score,
      openedAt,
      note,
    ],
  );
  return { id: info.lastInsertRowid, created: true };
}

/**
 * 归一指派：把一条历史文本（原文或归一键均可）指到某家店铺，或标记"忽略"。
 *
 * - `ignored=true` 时不校验 refId（用于"这不是店铺名"的噪音，如合计行 / '-'）；
 * - **指到不存在的店铺直接抛错**，不静默写成"未归一"（那会让用户以为登记成功了）；
 * - 目标必须是**有店名的行**（纯账号行不是可归一的落点）。
 * - 这是本表**唯一**的写入方，且恒写 `source='manual'` —— 故"manual 行永不被自动覆盖"天然成立
 *   （没有自动写入方）；将来若加自动归一，必须只清 `source<>'manual'` 的行。
 */
export function mapName(input: {
  raw: string;
  refId: number;
  ignored: boolean;
  kind?: string;
  note?: string;
}): { key: string; refId: number; ignored: boolean } {
  const kind = normKind(input?.kind);
  const raw = typeof input?.raw === 'string' ? input.raw.slice(0, MAX.name) : '';
  const key = toNameKey(raw);
  if (!key) throw new Error('名称不能为空');

  const ignored = input?.ignored === true;
  const refId = ignored ? 0 : toId(input?.refId);
  if (!ignored) {
    if (!refId) throw new Error('请选择要归一的店铺');
    // 目标表按 kind 决定；S1 只开放 shop
    if (kind !== 'shop') throw new Error(`暂不支持归一类型：${kind}`);
    if (
      !dbGet<{ id: number }>(
        `SELECT id FROM sk_shops WHERE id = ? AND trim(name) <> ''`,
        [refId],
      )
    ) {
      throw new Error('店铺不存在或已被删除');
    }
  }

  dbRun(
    `INSERT INTO sk_name_map (kind, raw, raw_key, ref_id, ignored, source, note)
     VALUES (?,?,?,?,?,'manual',?)
     ON CONFLICT(kind, raw_key) DO UPDATE SET
       raw = excluded.raw,
       ref_id = excluded.ref_id,
       ignored = excluded.ignored,
       source = 'manual',
       note = excluded.note,
       updated_at = datetime('now','localtime')`,
    [kind, raw, key, refId, ignored ? 1 : 0, str(input?.note, MAX.note)],
  );
  return { key, refId, ignored };
}

/** 撤销归一（回到未归一名单）。返回实际删除的行数。 */
export function unmapName(input: { raw: string; kind?: string }): { removed: number } {
  const kind = normKind(input?.kind);
  const key = toNameKey(typeof input?.raw === 'string' ? input.raw : '');
  if (!key) return { removed: 0 };
  const info = dbRun(`DELETE FROM sk_name_map WHERE kind = ? AND raw_key = ?`, [kind, key]);
  return { removed: info.changes };
}
