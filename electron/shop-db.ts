// electron/shop-db.ts
// 「店铺」主数据数据访问层（基于 electron/db.ts 公共层），随主程序分发。
//
// 定位（ADR-002 / DOMAIN_INTEGRATION_PLAN S1）
//   店铺属**主数据层**：schema 与写入权挂宿主中立层（C3），不挂在可卸载的市场 UI 岛上。
//   现状病根（该计划 D1/D2）：**店铺实体根本不存在** —— 店铺名以自由文本各存三处
//   （`oi_orders.shop` / `purchase_sources.shop` / `ae_orders.shop_name`），且互相拷贝。
//   本层新增两张表补上"实体层"，历史文本**一律不改写**（G2）：查询时靠 `sk_name_map` 旁挂归一。
//
//   sk_shops      店铺实体：`platform × name`（UNIQUE 建在归一键 name_key 上）
//                 + `platform_shop_id`（平台店铺ID，2026-09-27 新增）：店铺实体的**稳定业务键**。
//                 与名称并存但语义不同 —— 名称会改（改了历史文本就对不上），标识不会。
//                 ⚠️ 唯一性走**部分索引**（`WHERE platform_shop_id <> ''`）：没填标识的店不受约束，
//                    否则一批空串会互相撞唯一键。
//   sk_name_map   名称归一映射：`(kind, raw_key)` UNIQUE → ref_id / ignored（kind 为 supplier /
//                 style / product 预留，产品库 P3 的编码归一会复用同一张表）
//
// 三条口径（都是被真实数据逼出来的，别改宽）
//   1. **只做「去空白 + 剥不可见字符」**（G6）：不做模糊匹配、不做大小写折叠。相似店名在真实数据里
//      是**不同**的店（ADR-002「Q3 数据证据」），自动合并会把钱算错，且不可逆。
//   2. **不猜歧义**：同一个归一键若命中多于一家店（同名不同平台是合法的），就不给"精确命中"提示，
//      让人来选。猜错一次就是两家店的账并到一起。
//   3. **`sk_name_map` 只存"人的决定"**：本层不写 `source='auto'` 的占位行。
//      未归一名单是**每次实时聚合三处文本**算出来的（`listUnmapped`），不是一张会被放陈的缓存表 ——
//      否则删了订单/重导之后名单就与源头不一致了。
//   4. **平台店铺ID 是"落点之后"的锚，不是"替代落点"**（2026-09-27 逐处实测）：三处历史文本
//      （`oi_orders.raw_fields` / `purchase_sources` / `ae_orders`）+ 账号套装 `sk_shop_sets`
//      **都没有店铺标识列**，全库唯一能拿来比对订单的仍然是店名字符串。所以这个字段解决不了
//      "订单自动关联"，它能解决的是两件名称归一永远做不到的事：
//        a. **改名不断链** —— 名称一变，历史文本就指向不存在的东西；标识不变。
//        b. **收拢同一家店的多种写法** —— 实测订单侧 42 行出现 7 种店名，其中 `Shop1105228632 Store`
//           只在订单侧、按名称永远归不到「十店」上，但两者可以是同一个标识。
//
// 安全边界
//   本层只允许主进程内部使用；渲染层与 UI 岛一律经语义化 IPC / db 能力域访问，
//   禁止把 SQL 透传给渲染层（AGENTS.md §1.7）。

export {};

import { initDb, dbMigrate, dbGet, dbRun, dbQuery,
  tableExists,
} from './db';
import { mergeNameGroups, toNameKey, type NameSourceGroup, type MergedName } from './shopName';

// ---- 类型（与渲染层 src/types.ts 对应结构保持一致；两端各自声明，避免主进程 import 渲染层） ----

/** 店铺状态：在营 / 停用（停用仅标记，不物理删除 —— 历史订单仍指向它） */
export type ShopStatus = 'active' | 'archived';
export const SHOP_STATUSES: readonly ShopStatus[] = ['active', 'archived'];

/** 归一映射的实体类型（S1 只用 shop；其余为 supplier / style / product 预留） */
export type NameMapKind = 'shop' | 'supplier' | 'style' | 'product';
export const NAME_MAP_KINDS: readonly NameMapKind[] = ['shop', 'supplier', 'style', 'product'];

export interface ShopListItem {
  id: number;
  platform: string;
  name: string;
  /** 归一键（展示用不上，导出/核对时有用） */
  nameKey: string;
  /** 平台店铺ID（**归一后**的值；'' = 未填）—— 店铺实体的稳定业务键，改名不影响 */
  platformShopId: string;
  site: string;
  /** 所属账号套装 sk_shop_sets(id)；0 = 未关联（软关联，套装删除后仍保留 id 供回显） */
  shopSetId: number;
  status: string;
  openedAt: string;
  note: string;
  createdAt: string;
  updatedAt: string;
  /** 已归一到本店的历史文本条数（含被忽略的不算） */
  aliasCount: number;
}

/** 新增/更新入参（**全量提交**语义：缺省即空，不做局部 patch） */
export interface ShopUpsertInput {
  /** 0 / 缺省 = 新增 */
  id: number;
  platform: string;
  name: string;
  /** 平台店铺ID（可空；非空时参与唯一性 —— 同平台内不得重复） */
  platformShopId: string;
  site: string;
  shopSetId: number;
  status: string;
  openedAt: string;
  note: string;
}

export interface ShopListQuery {
  offset: number;
  limit: number;
  search: string;
  platform: string;
  status: string;
  /** 只看某个账号套装名下的店铺（0 = 不过滤）—— 店铺套编辑抽屉用 */
  shopSetId: number;
}

/** 未归一的历史店铺名（一次实时聚合的结果） */
export interface UnmappedShopRow {
  /** 归一键 —— `mapName` / `unmapName` 的入参 */
  key: string;
  /** 展示用原文 */
  raw: string;
  /** 三处文本里出现的总条数 */
  occurrences: number;
  /** 出现过的来源（order / purchase / ae） */
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
    /** 三处文本去重并归一后的名称总数（不含空/纯空白） */
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
 * ⚠️ `name_key` 不是冗余列：UNIQUE 必须建在**归一键**上。
 * 若只对 `name` 建唯一约束，`"店A"` 与 `"店A "` 会同时入库 → 同一个键命中两家店 →
 * 自动命中的语义立刻破产（"同名不同平台"是合法的，但"同平台同归一名的两家店"不是）。
 */
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS sk_shops (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    platform TEXT NOT NULL DEFAULT '',
    name TEXT NOT NULL,
    name_key TEXT NOT NULL,
    platform_shop_id TEXT NOT NULL DEFAULT '',
    site TEXT NOT NULL DEFAULT '',
    shop_set_id INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    opened_at TEXT NOT NULL DEFAULT '',
    note TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(platform, name_key)
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sk_shops_name_key ON sk_shops(name_key)`,
  `CREATE INDEX IF NOT EXISTS idx_sk_shops_set ON sk_shops(shop_set_id)`,
  `CREATE INDEX IF NOT EXISTS idx_sk_shops_status ON sk_shops(status)`,
  // ⚠️ 有意**不建** `confidence` 列：G6 已裁定模糊匹配永不写 ref_id，故没有任何生产者会写它，
  //    留一个恒 0 的死列不如以后真需要时按 `sk_shop_sets.opened_at` 的先例 ALTER 增量补列。
  `CREATE TABLE IF NOT EXISTS sk_name_map (
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
  )`,
  `CREATE INDEX IF NOT EXISTS idx_sk_name_map_ref ON sk_name_map(kind, ref_id)`,
];

/**
 * 幂等补列（**老库**）。
 *
 * ⚠️ `CREATE TABLE IF NOT EXISTS` 对**已存在**的表一个字都不改 —— 新列只写进建表语句的话，
 *    老库永远拿不到它，症状是 `no such column: platform_shop_id`，**且只在老库上出现**
 *    （新建的库一切正常，所以这类问题特别容易在"我这跑得好好的"里漏掉）。
 *    判定必须用 `PRAGMA table_info`（唯一能区分"表刚建出来"与"表早就存在"的探针）。
 */
function ensureShopColumns(): void {
  const cols = new Set(
    dbQuery<{ name: string }>(`PRAGMA table_info(sk_shops)`).map((r) => String(r.name ?? '')),
  );
  if (!cols.has('platform_shop_id')) {
    dbRun(`ALTER TABLE sk_shops ADD COLUMN platform_shop_id TEXT NOT NULL DEFAULT ''`);
  }
}

/**
 * 依赖**新列**的索引 —— 必须在 `ensureShopColumns()` **之后**跑，
 * 否则老库上会因列不存在而报 `no such column: platform_shop_id`。
 *
 * 平台店铺ID 用**部分唯一索引**（`WHERE platform_shop_id <> ''`）：只在填了标识时约束。
 * 不写 `WHERE` 的话，一批空串会互相撞唯一键 —— 第二家没填标识的店直接存不进去。
 */
const INDEXES = [
  `CREATE UNIQUE INDEX IF NOT EXISTS idx_sk_shops_platform_sid
     ON sk_shops(platform, platform_shop_id) WHERE platform_shop_id <> ''`,
];

/** 幂等初始化（视图首次激活 / 每个 handler 入口调用） */
export function ensureShopSchema(): void {
  initDb();
  dbMigrate(SCHEMA); // 建表（新库直接含新列）+ 旧索引
  ensureShopColumns(); // 老库补列
  dbMigrate(INDEXES); // 依赖新列的索引
}

// ---- 字段规整 ----

const MAX = {
  platform: 40,
  name: 200,
  platformShopId: 100,
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

/** 表是否存在 —— 各域表按域懒建，店铺汇总不能假定订单/采购/利润三域都已初始化 */
// ---- 历史文本来源（D2 的三处自由文本） ----

/**
 * 店铺名的三个历史来源。**这是"店铺名从哪来"的唯一出处** ——
 * 加第四处时改这里即可，`listUnmapped` / `shopSummary` 都从它派生。
 * ⚠️ 三处都是自由文本、且**都没有平台字段**：`sk_shops.platform` 无法从历史文本推导，
 *    只能在登记开店时由人指定（这正是"自动归一填不满店铺表"的原因）。
 */
export const SHOP_NAME_SOURCES = [
  { id: 'order', table: 'oi_orders', column: 'shop' },
  { id: 'purchase', table: 'purchase_sources', column: 'shop' },
  { id: 'ae', table: 'ae_orders', column: 'shop_name' },
] as const;

/** 逐表取 (原文, 条数) 分组；表不存在则跳过（返回空） */
function collectShopNameGroups(): NameSourceGroup[] {
  const groups: NameSourceGroup[] = [];
  for (const src of SHOP_NAME_SOURCES) {
    if (!tableExists(src.table)) continue;
    // ⚠️ 不用 `TRIM(x) <> ''` 过滤：SQLite 的 TRIM 只认半角空格，全角空格构成的值会漏进分组。
    //    空/纯空白统一交给 toNameKey 判定（唯一口径）。
    const rows = dbQuery<{ raw: unknown; c: number }>(
      `SELECT ${src.column} AS raw, COUNT(*) AS c FROM ${src.table} WHERE ${src.column} IS NOT NULL AND ${src.column} <> '' GROUP BY ${src.column}`
    );
    for (const r of rows) {
      groups.push({ source: src.id, raw: String(r.raw ?? ''), count: num(r.c) });
    }
  }
  return groups;
}

/** 实时聚合三处文本 → 归一后的名称清单 */
function currentNames(): MergedName[] {
  return mergeNameGroups(collectShopNameGroups());
}

/** `(kind, raw_key)` → 映射行 */
function nameMapRows(kind: NameMapKind): Map<string, { refId: number; ignored: boolean }> {
  const m = new Map<string, { refId: number; ignored: boolean }>();
  for (const r of dbQuery<Record<string, unknown>>(
    `SELECT raw_key, ref_id, ignored FROM sk_name_map WHERE kind = ?`,
    [kind]
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
 * 同名可以合法地存在于不同平台（UNIQUE 是 platform × name_key），此时"精确命中"本身就是歧义的，
 * 猜哪一家都会错 —— 不猜，让人来选。
 */
function autoMatchIndex(): Map<string, { id: number; name: string; platform: string }> {
  const index = new Map<string, { id: number; name: string; platform: string }>();
  const ambiguous = new Set<string>();
  for (const r of dbQuery<Record<string, unknown>>(
    `SELECT id, platform, name, name_key FROM sk_shops`
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

const COLS = `id, platform, name, name_key, platform_shop_id, site, shop_set_id, status, opened_at, note, created_at, updated_at`;

function mapShopRow(row: Record<string, unknown>, aliasCounts: Map<number, number>): ShopListItem {
  const id = num(row.id);
  return {
    id,
    platform: String(row.platform ?? ''),
    name: String(row.name ?? ''),
    nameKey: String(row.name_key ?? ''),
    platformShopId: String(row.platform_shop_id ?? ''),
    site: String(row.site ?? ''),
    shopSetId: num(row.shop_set_id),
    status: String(row.status ?? 'active'),
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
    `SELECT ref_id, COUNT(*) AS c FROM sk_name_map WHERE kind = 'shop' AND ignored = 0 AND ref_id > 0 GROUP BY ref_id`
  )) {
    m.set(num(r.ref_id), num(r.c));
  }
  return m;
}

/** 列表（关键字 / 平台 / 状态过滤 + 分页；按平台 → 名称排序，符合"按平台看店"的习惯） */
export function listShops(payload: ShopListQuery): { rows: ShopListItem[]; total: number } {
  const search = str(payload?.search, MAX.search);
  const platform = str(payload?.platform, MAX.platform);
  const status = str(payload?.status, MAX.status);
  const shopSetId = toId(payload?.shopSetId);

  const where: string[] = [];
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
  // 只看某个账号套装名下的店铺（店铺套编辑抽屉用）。0 = 不过滤 —— 与"未关联任何套装的店"区分开
  if (shopSetId) {
    where.push(`shop_set_id = ?`);
    params.push(shopSetId);
  }
  const whereSql = where.length ? `WHERE ${where.join(' AND ')}` : '';

  const offset = Math.max(0, Math.floor(Number(payload?.offset) || 0));
  const limit = Math.min(
    MAX_LIST_LIMIT,
    Math.max(1, Math.floor(Number(payload?.limit) || DEFAULT_LIST_LIMIT))
  );

  const rowsRaw = dbQuery<Record<string, unknown>>(
    `SELECT ${COLS} FROM sk_shops ${whereSql} ORDER BY platform ASC, name ASC LIMIT ? OFFSET ?`,
    [...params, limit, offset]
  );
  const totalRow = dbGet<{ c: number }>(
    `SELECT COUNT(*) AS c FROM sk_shops ${whereSql}`,
    params
  );
  const counts = aliasCounts();
  return {
    rows: rowsRaw.map((r) => mapShopRow(r, counts)),
    total: totalRow ? num(totalRow.c) : 0,
  };
}

/** 单条详情（不存在返回 null） */
export function getShop(id: number): ShopListItem | null {
  const sid = toId(id);
  if (!sid) return null;
  const row = dbGet<Record<string, unknown>>(`SELECT ${COLS} FROM sk_shops WHERE id = ?`, [sid]);
  if (!row) return null;
  return mapShopRow(row, aliasCounts());
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

/** 汇总（店铺侧 + 历史文本侧的归一进度） */
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
    total: num(dbGet<{ c: number }>(`SELECT COUNT(*) AS c FROM sk_shops`)?.c),
    byPlatform: dbQuery<{ platform: string; count: number }>(
      `SELECT platform, COUNT(*) AS count FROM sk_shops GROUP BY platform ORDER BY platform ASC`
    ).map((r) => ({ platform: String(r.platform ?? ''), count: num(r.count) })),
    byStatus: dbQuery<{ status: string; count: number }>(
      `SELECT status, COUNT(*) AS count FROM sk_shops GROUP BY status ORDER BY status ASC`
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
 * 新增 / 更新店铺（全量提交）。
 *
 * **两条唯一性是硬约束**：① `(platform, 归一键)` ② `(platform, 平台店铺ID)`（后者仅在标识非空时生效）。
 * 冲突时**明确抛错**，不静默改名或覆盖 —— 店铺是订单/采购/利润三域的归属维度，
 * 静默合并会把两个店的账算到一起。
 *
 * 两项冲突**分别给不同的文案**：撞名称和撞标识的处置方式完全不同（前者改名、后者是重复登记），
 * 一句"已存在"会让人修错地方。
 *
 * @returns { id, created } created=false 表示更新既有记录
 */
export function upsertShop(input: ShopUpsertInput): { id: number; created: boolean } {
  const name = str(input?.name, MAX.name);
  if (!name) throw new Error('店铺名称不能为空');
  const nameKey = toNameKey(name);
  if (!nameKey) throw new Error('店铺名称不能只有空白字符');
  const platform = str(input?.platform, MAX.platform);
  const platformShopId = toShopIdKey(str(input?.platformShopId, MAX.platformShopId));

  const id = toId(input?.id);
  const fields = [
    platform,
    name,
    nameKey,
    platformShopId,
    str(input?.site, MAX.site),
    toId(input?.shopSetId),
    normStatus(input?.status),
    str(input?.openedAt, MAX.openedAt),
    str(input?.note, MAX.note),
  ] as const;

  // 更新时先确认目标存在，再查占用 —— 顺序反了会把「改一个已被删除的店」报成「已存在」，
  // 把真正原因盖住（product-db 同款约定）。
  if (id && !dbGet<{ id: number }>(`SELECT id FROM sk_shops WHERE id = ?`, [id])) {
    throw new Error('店铺不存在或已被删除');
  }

  const dup = dbGet<{ id: number; name: string }>(
    `SELECT id, name FROM sk_shops WHERE platform = ? AND name_key = ? AND id <> ?`,
    [platform, nameKey, id]
  );
  if (dup) {
    throw new Error(
      `该平台下已存在同名店铺：${dup.name}（ID ${num(dup.id)}）—— 同名不同店请改用不同名称或平台`
    );
  }

  // 平台店铺ID 的**第二道防线**：部分唯一索引会硬拦，但它抛的是
  // `UNIQUE constraint failed: sk_shops.platform, sk_shops.platform_shop_id` —— 用户看不懂，
  // 也分不清撞的是名称还是标识。这里给出指名道姓的错误，索引负责兜住并发/绕过入口的情况。
  // 空标识不参与唯一性（与索引的 `WHERE platform_shop_id <> ''` 同口径）。
  if (platformShopId) {
    const dupSid = dbGet<{ id: number; name: string }>(
      `SELECT id, name FROM sk_shops WHERE platform = ? AND platform_shop_id = ? AND id <> ?`,
      [platform, platformShopId, id]
    );
    if (dupSid) {
      throw new Error(
        `该平台下的店铺标识已被占用：${dupSid.name}（ID ${num(dupSid.id)}）—— 一个平台店铺ID 只能对应一家店`
      );
    }
  }

  if (id) {
    dbRun(
      `UPDATE sk_shops SET platform=?, name=?, name_key=?, platform_shop_id=?, site=?, shop_set_id=?, status=?, opened_at=?, note=?, updated_at=datetime('now','localtime') WHERE id=?`,
      [...fields, id]
    );
    return { id, created: false };
  }

  const info = dbRun(
    `INSERT INTO sk_shops (platform, name, name_key, platform_shop_id, site, shop_set_id, status, opened_at, note) VALUES (?,?,?,?,?,?,?,?,?)`,
    [...fields]
  );
  return { id: info.lastInsertRowid, created: true };
}

/**
 * 归一指派：把一条历史文本（原文或归一键均可）指到某家店铺，或标记"忽略"。
 *
 * - `ignored=true` 时不校验 refId（用于"这不是店铺名"的噪音，如合计行 / '-'）；
 * - **指到不存在的店铺直接抛错**，不静默写成"未归一"（那会让用户以为登记成功了）。
 * - 这是本表**唯一**的写入方，且恒写 `source='manual'` —— 故"manual 行永不被自动覆盖"天然成立
 *   （没有自动写入方）；将来若加自动归一，必须按 `ae_cost_map` 的先例只清 `source<>'manual'` 的行。
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
    if (!dbGet<{ id: number }>(`SELECT id FROM sk_shops WHERE id = ?`, [refId])) {
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
    [kind, raw, key, refId, ignored ? 1 : 0, str(input?.note, MAX.note)]
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
