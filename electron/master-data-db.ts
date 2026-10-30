// electron/master-data-db.ts
// 主数据域（S0a / R1）：**全项目只有一张图片表、一张颜色表、一张尺码表**。
//
// 为什么单开一个域（2026-10-30 用户口径）：
//   「图片/颜色/尺码是主数据，其他表只准存 id」—— 旧实现有三张图片表（`pl_images` 产品域、
//   `oi_images` 订单域、`pl_item_images` 商品覆盖图），两套落盘目录（`product-images/` 与
//   `order-images/`），于是同一张图会存两份字节、且只有 `order-images/` 进备份；两表的
//   AUTOINCREMENT 还各自从 1 起，id 必然撞车（`order-image-land.ts` 记录的那次 P0）。
//   颜色则散在三处：`oi_style_colors.color` 文本、`pl_variants.color` 文本、
//   `oi_color_aliases` 对照表 —— 同一件「什么色」有三个词表。
//
// 四条纪律（与方案 §3 一致）：
//   ① 一张图一份字节：内容指纹（SHA-256）唯一，文件落 `userData/images/<fingerprint><ext>`；
//   ② 一个落盘入口：`landImageBytes` 是**唯一**写图片的地方（订单图/款图/采集图都调它）；
//   ③ 主数据只做字典：`md_images` 只存「这张图是什么字节」，不存「它属于哪个 listing 的哪一色」
//      （归属写 `pl_shop_sku`，R2；款色代表图写 `oi_style_colors.image_id`）；
//   ④ 派生不存储：色块 hex、尺码排序都是字典行上的字段，业务表只存 `color_id` / `size_id`。
//
// 迁移方式（D12）：**不写 backfill**。`scripts/reset-dev-data.mjs` 清业务表 + `md_*` 后由应用
// 空库重建并重新播种；老库里的两套图片目录不再合并（测试数据可丢，见方案 §10 E）。

import { app } from 'electron';
import * as crypto from 'crypto';
import * as fs from 'fs';
import * as path from 'path';
import { initDb, dbMigrate, dbGet, dbRun, dbQuery, tableExists } from './db';
import { IMG_EXT_BY_FORMAT, sniffImageFormat } from './ipc-util';

/** 全项目唯一的图片目录（进备份；孤图清理认的也是它） */
export const IMAGE_DIR = () => path.join(app.getPath('userData'), 'images');

/** 单张图片上限（与 `order-read-local-image` / 产品图导入的 10MB 对齐） */
export const MAX_IMAGE_BYTES = 10 * 1024 * 1024;

/**
 * `md_images` 的主键 —— **品牌类型**（值仍是 number，只是带了来源标记）。
 *
 * 保留品牌类型的理由不是形式主义：`pl_products.image_id` / `oi_order_items.image_id` /
 * `oi_style_colors.image_id` / `pl_shop_items.image_id` 都是**裸 number 列**，把
 * "产品 id" 或 "款色 id" 误传成图片 id 是运行期静默写脏（曾经真的发生过，见文件头 P0）。
 * 品牌类型让这类传参在 `tsc` 这一层就编译不过。
 */
export type MdImageId = number & { readonly __mdImageId: unique symbol };

export interface MdImageRow {
  id: number;
  /** 内容 SHA-256（唯一；文件名就是它） */
  fingerprint: string;
  /** URL 规范化指纹（同图不同签名参数去重；普通索引，不做唯一） */
  urlFingerprint: string;
  sourceUrl: string;
  localPath: string;
  /** 来源标记：order-image / product-image / shop-item / upload …（只用于排查，不参与判定） */
  source: string;
}

export interface MdColorRow {
  id: number;
  name: string;
  hex: string;
  sortOrder: number;
  status: string;
}

export interface MdSizeRow {
  id: number;
  name: string;
  sortOrder: number;
  /** 尺码组（`S-5XL` / `均码` …；一键套用时的分组标签，仅展示） */
  sizeGroup: string;
  /** 别名（逗号分隔；`XXXL,XXXXL` 之类平台写法 → 本行 name） */
  aliases: string;
}

/** URL 规范化指纹（同类图不同签名参数视为同一张；解析失败退回整串哈希） */
export function fingerprintUrl(url: string): string {
  try {
    const u = new URL(url);
    return crypto.createHash('sha256').update(u.origin + u.pathname).digest('hex');
  } catch {
    return crypto.createHash('sha256').update(String(url ?? '')).digest('hex');
  }
}

const SCHEMA = [
  // `md_images`：全项目唯一图片仓（内容寻址）。`fingerprint` 唯一 = 一份字节一行；
  // `url_fingerprint` 普通索引（同一 URL 规范化后应只有一行，但**不做唯一约束** ——
  // 历史/并发落盘时宁可多一行也不要把一次导入整批回滚）。
  `CREATE TABLE IF NOT EXISTS md_images (
    -- 用途：全项目唯一图片仓（内容指纹唯一，二进制落 userData/images/ 不入库）；归属写业务表。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    fingerprint TEXT NOT NULL UNIQUE,
    url_fingerprint TEXT NOT NULL DEFAULT '',
    source_url TEXT NOT NULL DEFAULT '',
    local_path TEXT NOT NULL,
    source TEXT NOT NULL DEFAULT 'order-image',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_md_images_url_fp ON md_images(url_fingerprint)`,
  // `md_colors`：颜色主数据（全局唯一色名）。`hex` 只用于界面色块，允许为空。
  `CREATE TABLE IF NOT EXISTS md_colors (
    -- 用途：颜色主数据（全局唯一色名 + 色块 hex）；业务表只存 color_id。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    hex TEXT NOT NULL DEFAULT '',
    sort_order INTEGER NOT NULL DEFAULT 0,
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  // `md_sizes`：尺码主数据（全局唯一码名 + 一组别名）。别名解析在 ensureSizeId/resolveSizeId。
  `CREATE TABLE IF NOT EXISTS md_sizes (
    -- 用途：尺码主数据（全局唯一码名 + 逗号分隔别名 + 尺码组标签）；业务表只存 size_id。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    name TEXT NOT NULL UNIQUE,
    sort_order INTEGER NOT NULL DEFAULT 0,
    size_group TEXT NOT NULL DEFAULT '',
    aliases TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'active',
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  // `md_color_aliases`：平台色名 → 颜色主数据。`product_id = 0` 是**全局**别名，
  // >0 是「这一款专属」的覆盖（查表顺序：先款级、再全局；与 `oi_color_aliases` 同口径）。
  `CREATE TABLE IF NOT EXISTS md_color_aliases (
    -- 用途：平台色名→颜色主数据（product_id=0 全局别名，>0 按款覆盖）；唯一键 product_id+alias_key。
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    product_id INTEGER NOT NULL DEFAULT 0,
    alias_key TEXT NOT NULL,
    alias_raw TEXT NOT NULL DEFAULT '',
    color_id INTEGER NOT NULL REFERENCES md_colors(id) ON DELETE CASCADE,
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    UNIQUE(product_id, alias_key)
  )`,
];

/**
 * 颜色种子（与 `electron/order-db.ts` 的 `COLOR_CODE` 词表 + `src/lib/colorSwatch.ts` 的
 * 色值对齐）。**只播种「确定的色名」**：`未分类` / 纯数字平台色（`1`..`15`）不入字典 ——
 * 那是"还没定色"的证据，不是主数据（方案 §5「不建占位色」）。
 */
const COLOR_SEEDS: ReadonlyArray<readonly [string, string]> = [
  ['黑色', '#3a3a3a'],
  ['白色', '#f5f5f5'],
  ['灰色', '#9a9a9a'],
  ['深灰', '#6b6b6b'],
  ['浅灰', '#c4c4c4'],
  ['藏青', '#2f3b5e'],
  ['藏蓝', '#2f3b5e'],
  ['军绿', '#5b6b46'],
  ['墨绿', '#1d4b3a'],
  ['蓝色', '#3b6fd4'],
  ['天蓝', '#7fb6e8'],
  ['卡其', '#c3b091'],
  ['红色', '#d64545'],
  ['酒红', '#7d2f3a'],
  ['粉色', '#e89ab6'],
  ['紫色', '#8b5ec9'],
  ['香芋紫', '#b3a1c9'],
  ['绿色', '#3d9a5c'],
  ['黄色', '#e8c23d'],
  ['橙色', '#e8853d'],
  ['棕色', '#8a6a4f'],
  ['咖啡', '#5d4231'],
  ['米色', '#d9c9a8'],
  ['米白', '#efe9dc'],
  ['肤色', '#e8c4a8'],
  ['牛仔', '#4a6a8a'],
  ['印花多色', ''],
];

/** 尺码种子：[码名, 组, 别名] */
const SIZE_SEEDS: ReadonlyArray<readonly [string, string, string]> = [
  ['XS', 'S-5XL', ''],
  ['S', 'S-5XL', ''],
  ['M', 'S-5XL', ''],
  ['L', 'S-5XL', ''],
  ['XL', 'S-5XL', ''],
  ['2XL', 'S-5XL', 'XXL'],
  ['3XL', 'S-5XL', 'XXXL,3X'],
  ['4XL', 'S-5XL', 'XXXXL,4X'],
  ['5XL', 'S-5XL', 'XXXXXL,5X'],
  ['均码', '均码', 'F,FREE,FREESIZE'],
];

let seeded = false;

/**
 * 幂等初始化（建表 + 播种）。
 *
 * 播种**每次 ensure 都跑**（`INSERT OR IGNORE`，代价是 30 条空操作）—— 因为
 * `scripts/reset-dev-data.mjs` 会把 `md_*` 一起清掉（清完后种子要能自己回来，
 * 否则用户看到的是"颜色下拉空了"而不是"库被重置过"）。
 */
export function ensureMasterDataSchema(): void {
  initDb();
  dbMigrate(SCHEMA);
  seedDictionaries();
  seeded = true;
}

function seedDictionaries(): void {
  // 已全量播种就跳过：`ensureMasterDataSchema` 现在也挂在订单/产品域的每次 ensure 上
  //（那些查询要 JOIN `md_images`），37 条 upsert 每次白跑会持续写 WAL。
  // 计数回到 0（`scripts/reset-dev-data.mjs` 清掉 `md_*`）时种子自动回来。
  const colorN = Number(dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM md_colors`)?.n ?? 0);
  const sizeN = Number(dbGet<{ n: number }>(`SELECT COUNT(*) AS n FROM md_sizes`)?.n ?? 0);
  if (colorN >= COLOR_SEEDS.length && sizeN >= SIZE_SEEDS.length) return;
  for (let i = 0; i < COLOR_SEEDS.length; i += 1) {
    const [name, hex] = COLOR_SEEDS[i];
    dbRun(
      `INSERT INTO md_colors (name, hex, sort_order) VALUES (?, ?, ?)
       ON CONFLICT(name) DO NOTHING`,
      [name, hex, i + 1],
    );
  }
  for (let i = 0; i < SIZE_SEEDS.length; i += 1) {
    const [name, group, aliases] = SIZE_SEEDS[i];
    dbRun(
      `INSERT INTO md_sizes (name, sort_order, size_group, aliases) VALUES (?, ?, ?, ?)
       ON CONFLICT(name) DO NOTHING`,
      [name, i + 1, group, aliases],
    );
  }
}

// ─────────────────────────────────────────────────────────────────────────────
// 图片（唯一落盘入口 + 唯一查询入口）
// ─────────────────────────────────────────────────────────────────────────────

export interface LandImageOptions {
  /** 远程地址（可选；落库留证据，也用于 URL 指纹去重） */
  sourceUrl?: string;
  /** 调用方已算好的 URL 指纹（省一次解析；缺省时从 sourceUrl 现算） */
  urlFingerprint?: string;
  /** 来源标记（order-image / product-image / shop-item / upload …） */
  source?: string;
}

export interface LandedImage {
  imageId: MdImageId;
  localPath: string;
  fingerprint: string;
  /** true = 命中既有行（URL 指纹或内容指纹），没插新行、没写第二份字节 */
  reused: boolean;
}

function rowToImage(r: Record<string, unknown> | undefined): MdImageRow | undefined {
  if (!r) return undefined;
  return {
    id: Number(r.id) || 0,
    fingerprint: String(r.fingerprint ?? ''),
    urlFingerprint: String(r.url_fingerprint ?? ''),
    sourceUrl: String(r.source_url ?? ''),
    localPath: String(r.local_path ?? ''),
    source: String(r.source ?? ''),
  };
}

/**
 * 把**已在内存里**的图片字节落进 `userData/images/` 并登记 `md_images`。
 *
 * 去重顺序（与旧 `order-image-land` 同序，行为不变）：
 *   ① URL 规范化指纹 —— 同一张色图被采纳两次不落第二行；
 *   ② 内容指纹（SHA-256）—— 同图不同 URL 也复用同一行（这是"按图找色"的命入口）；
 *   ③ 都不中 → 写文件 + 插一行。
 *
 * @throws 内容不是受支持的图片格式（按文件头判断，不只看扩展名）/ 超过 10MB
 */
export function landImageBytes(buf: Buffer, opts: LandImageOptions = {}): LandedImage {
  ensureMasterDataSchema();
  if (!buf || !buf.length) throw new Error('图片内容为空');
  if (buf.length > MAX_IMAGE_BYTES) throw new Error('图片超过 10MB 上限');
  const fmt = sniffImageFormat(buf);
  if (!fmt) throw new Error('文件内容不是受支持的图片格式（按文件头判断，不只看扩展名）');
  const fingerprint = crypto.createHash('sha256').update(buf).digest('hex');
  const sourceUrl = String(opts?.sourceUrl ?? '');
  const urlFp = String(opts?.urlFingerprint ?? '') || (sourceUrl ? fingerprintUrl(sourceUrl) : '');

  const hit = (row: MdImageRow | undefined): LandedImage | undefined =>
    row && row.id > 0
      ? { imageId: row.id as MdImageId, localPath: row.localPath, fingerprint: row.fingerprint, reused: true }
      : undefined;

  if (urlFp) {
    const byUrl = hit(rowToImage(dbGet('SELECT * FROM md_images WHERE url_fingerprint = ?', [urlFp])));
    if (byUrl) return byUrl;
  }
  const byContent = hit(
    rowToImage(dbGet('SELECT * FROM md_images WHERE fingerprint = ?', [fingerprint])),
  );
  if (byContent) return byContent;

  const dir = IMAGE_DIR();
  fs.mkdirSync(dir, { recursive: true });
  const finalPath = path.join(dir, fingerprint + IMG_EXT_BY_FORMAT[fmt]);
  if (!fs.existsSync(finalPath)) fs.writeFileSync(finalPath, buf);
  const r = dbRun(
    `INSERT INTO md_images (fingerprint, url_fingerprint, source_url, local_path, source)
     VALUES (?, ?, ?, ?, ?)`,
    [fingerprint, urlFp, sourceUrl, finalPath, String(opts?.source ?? 'order-image') || 'order-image'],
  );
  return {
    imageId: Number(r.lastInsertRowid) as MdImageId,
    localPath: finalPath,
    fingerprint,
    reused: false,
  };
}

/**
 * 登记一张**已经落盘**的图（不经过本模块写文件）：调用方自己算好了指纹与本地路径。
 *
 * 唯一正当用途是"文件已经在 `images/` 里"（如导入 xlsx 内嵌图、或调用方先落了盘）；
 * 其余路径（下载 / 上传 / 采集）一律走 `landImageBytes`，别绕过它 —— 那是唯一落盘入口。
 *
 * 同指纹复用既有行（内容寻址的唯一性由 `md_images.fingerprint UNIQUE` 兜住）。
 */
export function registerImageRow(input: {
  fingerprint: string;
  localPath: string;
  urlFingerprint?: string;
  sourceUrl?: string;
  source?: string;
}): { imageId: MdImageId; reused: boolean } {
  ensureMasterDataSchema();
  const fp = String(input?.fingerprint ?? '').trim().slice(0, 128);
  const lp = String(input?.localPath ?? '').trim().slice(0, 1024);
  if (!fp || !lp) throw new Error('图片指纹与路径不能为空');
  const existing = dbGet<{ id: number }>(`SELECT id FROM md_images WHERE fingerprint = ?`, [fp]);
  if (existing) return { imageId: Number(existing.id) as MdImageId, reused: true };
  const r = dbRun(
    `INSERT INTO md_images (fingerprint, url_fingerprint, source_url, local_path, source)
     VALUES (?, ?, ?, ?, ?)`,
    [
      fp,
      String(input?.urlFingerprint ?? '').slice(0, 128),
      String(input?.sourceUrl ?? '').slice(0, 1024),
      lp,
      String(input?.source ?? 'upload').slice(0, 40) || 'upload',
    ],
  );
  return { imageId: Number(r.lastInsertRowid) as MdImageId, reused: false };
}

/** 按 id 取一行（0/无行 → undefined） */
export function imageRowById(imageId: number): MdImageRow | undefined {
  const id = Number(imageId) || 0;
  if (id <= 0 || !tableExists('md_images')) return undefined;
  return rowToImage(dbGet('SELECT * FROM md_images WHERE id = ?', [id]));
}

/** 按内容指纹查 */
export function findImageByFingerprint(fingerprint: string): MdImageRow | undefined {
  ensureMasterDataSchema();
  return rowToImage(dbGet('SELECT * FROM md_images WHERE fingerprint = ?', [String(fingerprint ?? '')]));
}

/** 按 URL 规范化指纹查 */
export function findImageByUrlFingerprint(urlFingerprint: string): MdImageRow | undefined {
  ensureMasterDataSchema();
  return rowToImage(
    dbGet('SELECT * FROM md_images WHERE url_fingerprint = ? ORDER BY id LIMIT 1', [
      String(urlFingerprint ?? ''),
    ]),
  );
}

/** 图片行是否存在（业务表写 image_id 前的校验；缺表降级 = false） */
export function imageIdExists(imageId: number): boolean {
  const id = Number(imageId) || 0;
  if (id <= 0) return false;
  if (!tableExists('md_images')) return false;
  return !!dbGet<{ id: number }>(`SELECT id FROM md_images WHERE id = ?`, [id]);
}

/** image_id → 本地路径（缺表/无行降级为空串，不报错） */
export function imageLocalPath(imageId: number): string {
  const id = Number(imageId) || 0;
  if (id <= 0 || !tableExists('md_images')) return '';
  const row = dbGet<{ local_path: string }>(`SELECT local_path FROM md_images WHERE id = ?`, [id]);
  return String(row?.local_path ?? '');
}

/** 批量 image_id → 本地路径（产品/订单列表一次取完，避免 N+1） */
export function imageLocalPathMap(imageIds: readonly number[]): Map<number, string> {
  const m = new Map<number, string>();
  const ids = [...new Set((imageIds || []).map((x) => Number(x) || 0).filter((x) => x > 0))];
  if (!ids.length || !tableExists('md_images')) return m;
  for (const r of dbQuery<{ id: number; local_path: string }>(
    `SELECT id, local_path FROM md_images WHERE id IN (${ids.map(() => '?').join(',')})`,
    ids,
  )) {
    m.set(Number(r.id), String(r.local_path ?? ''));
  }
  return m;
}

/**
 * 全部已登记图片的本地路径（孤图清理的"仍被引用"判定另见业务表 image_id 集合）。
 * 缺表降级为空数组。
 */
export function allImageLocalPaths(): string[] {
  if (!tableExists('md_images')) return [];
  return dbQuery<{ p: string }>(
    `SELECT local_path AS p FROM md_images WHERE local_path <> ''`,
  ).map((r) => String(r.p ?? ''));
}

// ─────────────────────────────────────────────────────────────────────────────
// 颜色 / 尺码（字典）
// ─────────────────────────────────────────────────────────────────────────────

function mapColor(r: Record<string, unknown>): MdColorRow {
  return {
    id: Number(r.id) || 0,
    name: String(r.name ?? ''),
    hex: String(r.hex ?? ''),
    sortOrder: Number(r.sort_order) || 0,
    status: String(r.status ?? 'active'),
  };
}

function mapSize(r: Record<string, unknown>): MdSizeRow {
  return {
    id: Number(r.id) || 0,
    name: String(r.name ?? ''),
    sortOrder: Number(r.sort_order) || 0,
    sizeGroup: String(r.size_group ?? ''),
    aliases: String(r.aliases ?? ''),
  };
}

/** 全部启用中的颜色（按 sort_order, id） */
export function colorList(): MdColorRow[] {
  ensureMasterDataSchema();
  return dbQuery<Record<string, unknown>>(
    `SELECT * FROM md_colors WHERE status <> 'disabled' ORDER BY sort_order, id`,
  ).map(mapColor);
}

/** 全部启用中的尺码（按 sort_order, id） */
export function sizeList(): MdSizeRow[] {
  ensureMasterDataSchema();
  return dbQuery<Record<string, unknown>>(
    `SELECT * FROM md_sizes WHERE status <> 'disabled' ORDER BY sort_order, id`,
  ).map(mapSize);
}

function normDictName(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, 40);
}

/** 颜色名 → id（**精确匹配，不猜**；查不到 0） */
export function resolveColorId(raw: unknown): number {
  const name = normDictName(raw);
  if (!name || !tableExists('md_colors')) return 0;
  const row = dbGet<{ id: number }>(`SELECT id FROM md_colors WHERE name = ?`, [name]);
  return Number(row?.id) || 0;
}

/** 颜色 id → 名字（0/无行 → ''） */
export function colorNameOf(colorId: number): string {
  const id = Number(colorId) || 0;
  if (id <= 0 || !tableExists('md_colors')) return '';
  const row = dbGet<{ name: string }>(`SELECT name FROM md_colors WHERE id = ?`, [id]);
  return String(row?.name ?? '');
}

/** 颜色 id → 行（0/无行 → undefined） */
export function colorById(colorId: number): MdColorRow | undefined {
  const id = Number(colorId) || 0;
  if (id <= 0 || !tableExists('md_colors')) return undefined;
  const row = dbGet<Record<string, unknown>>(`SELECT * FROM md_colors WHERE id = ?`, [id]);
  return row ? mapColor(row) : undefined;
}

/**
 * 颜色名 → id（不存在则**新建**）。`hex` 缺省时沿用 `findSwatch` 的色值口径由调用方传。
 * 返回 `{ id, created }`；名字为空抛错（空色名不是主数据）。
 */
export function ensureColorId(raw: unknown, hex = ''): { id: number; created: boolean } {
  ensureMasterDataSchema();
  const name = normDictName(raw);
  if (!name) throw new Error('颜色名不能为空');
  const hit = dbGet<{ id: number }>(`SELECT id FROM md_colors WHERE name = ?`, [name]);
  if (hit) return { id: Number(hit.id), created: false };
  const max = Number(dbGet<{ m: number }>(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM md_colors`)?.m ?? 0);
  const r = dbRun(
    `INSERT INTO md_colors (name, hex, sort_order) VALUES (?, ?, ?)`,
    [name, String(hex ?? ''), max + 1],
  );
  return { id: Number(r.lastInsertRowid), created: true };
}

/** 把平台码名归一成字典里的码名（先本名，再别名；都不中返回 trim 原值） */
function sizeAliasIndex(): Map<string, string> {
  const m = new Map<string, string>();
  if (!tableExists('md_sizes')) return m;
  for (const r of dbQuery<Record<string, unknown>>(`SELECT name, aliases FROM md_sizes`)) {
    const name = normDictName(r.name);
    if (!name) continue;
    m.set(name.toUpperCase(), name);
    for (const a of String(r.aliases ?? '').split(',')) {
      const key = normDictName(a).toUpperCase();
      if (key) m.set(key, name);
    }
  }
  return m;
}

/** 尺码名（含别名）→ id（**精确匹配，不猜**；查不到 0） */
export function resolveSizeId(raw: unknown): number {
  const name = normDictName(raw);
  if (!name || !tableExists('md_sizes')) return 0;
  const hit = dbGet<{ id: number }>(`SELECT id FROM md_sizes WHERE name = ?`, [name]);
  if (hit) return Number(hit.id);
  const canonical = sizeAliasIndex().get(name.toUpperCase());
  if (!canonical) return 0;
  const row = dbGet<{ id: number }>(`SELECT id FROM md_sizes WHERE name = ?`, [canonical]);
  return Number(row?.id) || 0;
}

/** 尺码名（含别名）归一成字典里的标准码名；都不中返回 trim 原值 */
export function canonicalSizeName(raw: unknown): string {
  const name = normDictName(raw);
  if (!name) return '';
  const canonical = sizeAliasIndex().get(name.toUpperCase());
  return canonical || name;
}

/** 尺码 id → 标准码名（0/无行 → ''） */
export function sizeNameOf(sizeId: number): string {
  const id = Number(sizeId) || 0;
  if (id <= 0 || !tableExists('md_sizes')) return '';
  const row = dbGet<{ name: string }>(`SELECT name FROM md_sizes WHERE id = ?`, [id]);
  return String(row?.name ?? '');
}

/** 尺码名（含别名）→ id（不存在则**新建**；别名命中时返回既有行） */
export function ensureSizeId(raw: unknown, sizeGroup = ''): { id: number; created: boolean; name: string } {
  ensureMasterDataSchema();
  const name = normDictName(raw);
  if (!name) throw new Error('尺码不能为空');
  const canonical = canonicalSizeName(name);
  const hit = dbGet<{ id: number }>(`SELECT id FROM md_sizes WHERE name = ?`, [canonical]);
  if (hit) return { id: Number(hit.id), created: false, name: canonical };
  const max = Number(dbGet<{ m: number }>(`SELECT COALESCE(MAX(sort_order), 0) AS m FROM md_sizes`)?.m ?? 0);
  const r = dbRun(
    `INSERT INTO md_sizes (name, sort_order, size_group) VALUES (?, ?, ?)`,
    [canonical, max + 1, String(sizeGroup ?? '')],
  );
  return { id: Number(r.lastInsertRowid), created: true, name: canonical };
}

// ─────────────────────────────────────────────────────────────────────────────
// 平台色别名（并入原 `oi_color_aliases` 的口径：先款级、再全局）
// ─────────────────────────────────────────────────────────────────────────────

export interface ColorAliasEntry {
  productId: number;
  aliasKey: string;
  aliasRaw: string;
  colorId: number;
}

function mapAlias(r: Record<string, unknown>): ColorAliasEntry {
  return {
    productId: Number(r.product_id) || 0,
    aliasKey: String(r.alias_key ?? ''),
    aliasRaw: String(r.alias_raw ?? ''),
    colorId: Number(r.color_id) || 0,
  };
}

/** 某款（含全局）的平台色别名（`productId = 0` 只返回全局；>0 返回款级 + 全局） */
export function colorAliasList(productId: number): ColorAliasEntry[] {
  ensureMasterDataSchema();
  const pid = Number(productId) || 0;
  const rows = pid
    ? dbQuery<Record<string, unknown>>(
        `SELECT * FROM md_color_aliases WHERE product_id = ? OR product_id = 0 ORDER BY product_id DESC, id`,
        [pid],
      )
    : dbQuery<Record<string, unknown>>(`SELECT * FROM md_color_aliases WHERE product_id = 0 ORDER BY id`);
  return rows.map(mapAlias);
}

/** 写/改一对别名（唯一键 `(product_id, alias_key)`） */
export function setColorAlias(input: {
  productId?: number;
  aliasKey: string;
  aliasRaw?: string;
  colorId: number;
}): { changed: boolean } {
  ensureMasterDataSchema();
  const pid = Number(input?.productId) || 0;
  const key = String(input?.aliasKey ?? '').trim().slice(0, 200);
  const cid = Number(input?.colorId) || 0;
  if (!key) throw new Error('别名不能为空');
  if (!cid || !colorById(cid)) throw new Error('目标颜色不存在');
  dbRun(
    `INSERT INTO md_color_aliases (product_id, alias_key, alias_raw, color_id)
     VALUES (?, ?, ?, ?)
     ON CONFLICT(product_id, alias_key) DO UPDATE SET
       alias_raw = excluded.alias_raw,
       color_id = excluded.color_id,
       updated_at = datetime('now','localtime')`,
    [pid, key, String(input?.aliasRaw ?? ''), cid],
  );
  return { changed: true };
}

/** 删一对别名（款级优先；找不到款级行时**不**误删全局行） */
export function deleteColorAlias(productId: number, aliasKey: string): { removed: number } {
  ensureMasterDataSchema();
  const pid = Number(productId) || 0;
  const key = String(aliasKey ?? '').trim();
  if (!key) return { removed: 0 };
  const r = dbRun(`DELETE FROM md_color_aliases WHERE product_id = ? AND alias_key = ?`, [pid, key]);
  return { removed: r.changes };
}

/** 本模块是否已初始化过（冒烟/体检展示用） */
export function masterDataReady(): boolean {
  return seeded && tableExists('md_images') && tableExists('md_colors') && tableExists('md_sizes');
}
