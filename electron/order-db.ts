// electron/order-db.ts
// 「订单归类」模块的数据访问层（基于 electron/db.ts 公共层）。
// 表：
//   oi_images         图片指纹库：内容指纹(SHA-256) 唯一，缓存 AI 识别结果，避免重复扣费；
//                     style_color_id 归属款色（阶段1：识别后自动建立款式/款色并挂接）
//   oi_orders         订单明细：归属图片 + 原始字段 + 归一化属性（款式/颜色/logo/材质）
//   oi_styles         款编码库：code 唯一（STYLE-001）、name 可改、fingerprint 款式指纹唯一（匹配键）
//   oi_style_colors   款色库：款编码 + 归一化颜色 → 款色编码（STYLE-001-RED），唯一
// 仅提供语义化方法；渲染进程经 order-handlers.ts 的 IPC 访问，不直接接触 SQL。

export {};

import {
  initDb,
  dbMigrate,
  dbQuery,
  dbGet,
  dbRun,
  dbTransaction,
  getDb,
} from './db';

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
  imageId: number;
  orderNo: string;
  shop: string;
  size: string;
  /** 下单时间（可空，来自 Excel 下单时间列） */
  orderTime?: string;
  rawFields: Record<string, string>;
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

/** 款色（款式 × 颜色） */
export interface StyleColorRecord {
  id: number;
  styleId: number;
  color: string;
  code: string;
  /** 归属该款色的图片数（列表统计用） */
  imageCount: number;
  /** 代表图路径（最新一张，产品库展示用） */
  imagePath?: string;
}

/** 款编码（产品库主数据） */
export interface StyleRecord {
  id: number;
  code: string;
  name: string;
  fingerprint: string;
  colorCount: number;
  imageCount: number;
  orderCount: number;
  /** 封面图路径（最新一张，产品库展示用） */
  coverPath?: string;
  colors: StyleColorRecord[];
  createdAt?: string;
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
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime')),
    updated_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE TABLE IF NOT EXISTS oi_orders (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    image_id INTEGER NOT NULL REFERENCES oi_images(id) ON DELETE CASCADE,
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
    created_at TEXT NOT NULL DEFAULT (datetime('now','localtime'))
  )`,
  `CREATE INDEX IF NOT EXISTS idx_oi_images_url_fp ON oi_images(url_fingerprint)`,
  `CREATE INDEX IF NOT EXISTS idx_oi_orders_image ON oi_orders(image_id)`,
  `CREATE INDEX IF NOT EXISTS idx_oi_orders_shop ON oi_orders(shop)`,
  `CREATE INDEX IF NOT EXISTS idx_oi_orders_no_img ON oi_orders(order_no, image_id)`,
  `CREATE TABLE IF NOT EXISTS oi_styles (
    id INTEGER PRIMARY KEY AUTOINCREMENT,
    code TEXT NOT NULL UNIQUE,
    name TEXT NOT NULL,
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

/** 幂等初始化：建表 + 索引 + 列迁移（应用启动 / 首次使用自动调用） */
export function ensureOrderSchema(): void {
  initDb();
  dbMigrate(SCHEMA);
  migrateColumns();
}

/** 老库列迁移：补充历史建表语句缺失的列（order_time / style_color_id）。
 *  注意：依赖新增列的索引必须在本函数内、加列成功后再创建，
 *  不能放进 SCHEMA——老库缺列时建索引会抛错导致整个 dbMigrate 事务回滚。 */
function migrateColumns(): void {
  const d = getDb();
  const orderCols = d.prepare(`PRAGMA table_info(oi_orders)`).all() as { name: string }[];
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
 * 避免手工改名/导入手工款号占用连续序号后仍返回同一编码造成复号。 */
function nextStyleCode(): string {
  const rows = dbQuery<{ code: string }>(`SELECT code FROM oi_styles`);
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
      .prepare(`SELECT id, code, name FROM oi_styles WHERE fingerprint = ?`)
      .get(input.fingerprint) as { id: number; code: string; name: string } | undefined;
    // 主指纹未命中 → 查附加指纹表（用户手动归并款式时写入，使自动识别也能命中目标款编码）
    if (!style) {
      style = d
        .prepare(
          `SELECT s.id, s.code, s.name FROM oi_style_fingerprints f
           JOIN oi_styles s ON s.id = f.style_id WHERE f.fingerprint = ?`,
        )
        .get(input.fingerprint) as { id: number; code: string; name: string } | undefined;
    }
    if (!style) {
      const code = nextStyleCode();
      const name = (input.styleName && input.styleName.trim()) || buildStyleName(input.category, input.features);
      const r = d
        .prepare(`INSERT INTO oi_styles (code, name, fingerprint) VALUES (?, ?, ?)`)
        .run(code, name, input.fingerprint);
      style = { id: Number(r.lastInsertRowid), code, name };
    }
    const sc = d
      .prepare(`SELECT id, code FROM oi_style_colors WHERE style_id = ? AND color = ?`)
      .get(style.id, input.color) as { id: number; code: string } | undefined;
    if (sc) {
      return { styleId: style.id, styleColorId: sc.id, styleCode: style.code, styleColorCode: sc.code };
    }
    let scCode = `${style.code}-${colorCode(input.color)}`;
    let seq = 2;
    while (d.prepare(`SELECT id FROM oi_style_colors WHERE code = ?`).get(scCode)) {
      scCode = `${style.code}-${colorCode(input.color)}-${seq}`;
      seq += 1;
    }
    const r = d
      .prepare(`INSERT INTO oi_style_colors (style_id, color, code) VALUES (?, ?, ?)`)
      .run(style.id, input.color, scCode);
    return {
      styleId: style.id,
      styleColorId: Number(r.lastInsertRowid),
      styleCode: style.code,
      styleColorCode: scCode,
    };
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
 */
export function assignOrderStyle(input: {
  orderId: number;
  styleId: number;
  color: string;
  fingerprint?: string;
}): { styleCode: string; styleColorCode: string } {
  const d = getDb();
  return dbTransaction(() => {
    const order = d.prepare(`SELECT image_id FROM oi_orders WHERE id = ?`).get(input.orderId) as
      | { image_id: number }
      | undefined;
    if (!order) throw new Error(`订单不存在: id=${input.orderId}`);
    const style = d.prepare(`SELECT id, code FROM oi_styles WHERE id = ?`).get(input.styleId) as
      | { id: number; code: string }
      | undefined;
    if (!style) throw new Error(`款式不存在: id=${input.styleId}`);
    const color = String(input.color ?? '').trim();
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
}

/** 修改款式展示名（款编码级，全局生效；仅展示，不参与指纹匹配） */
export function renameStyle(code: string, name: string): void {
  const style = dbQuery<{ id: number }>(`SELECT id FROM oi_styles WHERE code = ?`, [code]);
  if (!style.length) throw new Error(`款式不存在: code=${code}`);
  dbRun(`UPDATE oi_styles SET name = ? WHERE code = ?`, [String(name ?? '').trim().slice(0, 50), code]);
}

/** 按 款编码+款色 取一张已下载的代表图（本地路径），供拿货单 Excel 导出嵌入图片；查不到返回 null */
export function findStyleColorImagePath(styleCode: string, color: string): string | null {
  const row = dbGet<{ local_path: string }>(
    `SELECT i.local_path
     FROM oi_styles s
     JOIN oi_style_colors sc ON sc.style_id = s.id
     JOIN oi_images i ON i.style_color_id = sc.id
     WHERE s.code = ? AND sc.color = ?
       AND i.local_path IS NOT NULL AND i.local_path <> ''
     ORDER BY i.id DESC LIMIT 1`,
    [String(styleCode ?? '').trim(), String(color ?? '').trim()],
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
        ? (d.prepare(`SELECT id, code, name, fingerprint FROM oi_styles WHERE code = ?`).get(code) as
            | { id: number; code: string; name: string; fingerprint: string }
            | undefined)
        : undefined;
      let styleId: number;
      let styleCode: string;
      let styleMainFp = '';
      if (existing) {
        styleId = existing.id;
        styleCode = existing.code;
        styleMainFp = String(existing.fingerprint ?? '');
        if (name) d.prepare(`UPDATE oi_styles SET name = ? WHERE id = ?`).run(name, styleId);
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
            .prepare(`INSERT INTO oi_styles (code, name, fingerprint) VALUES (?, ?, ?)`)
            .run(finalCode, name || '未命名款式', fp);
          styleId = Number(r.lastInsertRowid);
          styleCode = finalCode;
          styleMainFp = fp;
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

/** 产品库列表：款编码 + 款色数/图片数/订单数 + 款色明细（含图片数） */
export function listStyles(): StyleRecord[] {
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT s.id, s.code, s.name, s.fingerprint, s.created_at,
       (SELECT COUNT(*) FROM oi_style_colors sc WHERE sc.style_id = s.id) AS color_count,
       (SELECT COUNT(*) FROM oi_images i JOIN oi_style_colors sc ON i.style_color_id = sc.id
         WHERE sc.style_id = s.id) AS image_count,
       (SELECT COUNT(*) FROM oi_orders o JOIN oi_images i ON o.image_id = i.id
         JOIN oi_style_colors sc ON i.style_color_id = sc.id WHERE sc.style_id = s.id) AS order_count,
       (SELECT i.local_path FROM oi_images i JOIN oi_style_colors sc ON i.style_color_id = sc.id
         WHERE sc.style_id = s.id ORDER BY i.id DESC LIMIT 1) AS cover_path
     FROM oi_styles s ORDER BY s.id`,
  );
  return rows.map((r) => {
    const styleId = Number(r.id);
    const colors = dbQuery<Record<string, unknown>>(
      `SELECT sc.id, sc.style_id, sc.color, sc.code,
         (SELECT COUNT(*) FROM oi_images i WHERE i.style_color_id = sc.id) AS image_count,
         (SELECT i.local_path FROM oi_images i WHERE i.style_color_id = sc.id ORDER BY i.id DESC LIMIT 1) AS image_path
       FROM oi_style_colors sc WHERE sc.style_id = ? ORDER BY sc.id`,
      [styleId],
    ).map((c) => ({
      id: Number(c.id),
      styleId: Number(c.style_id),
      color: String(c.color ?? ''),
      code: String(c.code ?? ''),
      imageCount: Number(c.image_count ?? 0),
      imagePath: c.image_path !== undefined && c.image_path !== null ? String(c.image_path) : undefined,
    }));
    return {
      id: styleId,
      code: String(r.code ?? ''),
      name: String(r.name ?? ''),
      fingerprint: String(r.fingerprint ?? ''),
      colorCount: Number(r.color_count ?? 0),
      imageCount: Number(r.image_count ?? 0),
      orderCount: Number(r.order_count ?? 0),
      coverPath: r.cover_path !== undefined && r.cover_path !== null ? String(r.cover_path) : undefined,
      colors,
      createdAt: r.created_at !== undefined && r.created_at !== null ? String(r.created_at) : undefined,
    };
  });
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

/** 插入一条订单明细，返回自增 id */
export function insertOrder(rec: OrderRecord): number {
  const d = getDb();
  const orderNo = String(rec.orderNo ?? '').trim();
  // 幂等：订单号非空时，(订单号, 图片) 已存在则跳过，避免重复导入同一 Excel 产生重复行
  if (orderNo) {
    const existing = d
      .prepare(`SELECT id FROM oi_orders WHERE order_no = ? AND image_id = ?`)
      .get(orderNo, rec.imageId);
    if (existing) return Number((existing as { id: number }).id);
  }
  const status: OrderStatus = rec.status === 'shipped' ? 'shipped' : 'pending';
  const r = dbRun(
    `INSERT INTO oi_orders (image_id, order_no, shop, size, order_time, raw_fields, category, color, logo, status)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
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
    ],
  );
  return r.lastInsertRowid;
}

/** 最近订单列表（联图片指纹/路径），供界面明细展示 */
export function listOrders(limit = 500): OrderRecord[] {
  return listOrdersPage({ limit }).rows;
}

/** 订单列表（分页 + corrected 过滤 + 关键字搜索）：
 *  - 列表不携带 o.raw_fields（整行 Excel 原始字段体积大且界面不消费），显著降低 IPC 传输；
 *  - 返回 { rows, total } 供渲染层同步总数/分页；
 *  - search 匹配 单号/店铺/分类/颜色/logo/款编码/款名/款色，供纠正页/明细页服务端搜索。 */
export function listOrdersPage(
  opts: { offset?: number; limit?: number; corrected?: boolean; search?: string } = {},
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
  const search = typeof opts.search === 'string' ? opts.search.trim().slice(0, 100) : '';
  if (search) {
    const like = `%${search.replace(/[\\%_]/g, (m) => `\\${m}`)}%`;
    conds.push(
      `(o.order_no LIKE ? ESCAPE '\\' OR o.shop LIKE ? ESCAPE '\\' OR o.category LIKE ? ESCAPE '\\'
        OR o.color LIKE ? ESCAPE '\\' OR o.logo LIKE ? ESCAPE '\\'
        OR s.code LIKE ? ESCAPE '\\' OR s.name LIKE ? ESCAPE '\\' OR sc.color LIKE ? ESCAPE '\\')`,
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
       ${where}`,
      params,
    )[0]?.n ?? 0,
  );
  const rows = dbQuery<Record<string, unknown>>(
    `SELECT o.id, o.image_id, o.order_no, o.shop, o.size, o.order_time,
            o.category, o.color, o.logo, o.material, o.status, o.corrected, o.created_at,
            i.fingerprint, i.source_url, i.local_path, i.result_json,
            s.code AS style_code, s.name AS style_name, sc.color AS style_color
     FROM oi_orders o
     LEFT JOIN oi_images i ON o.image_id = i.id
     LEFT JOIN oi_style_colors sc ON i.style_color_id = sc.id
     LEFT JOIN oi_styles s ON sc.style_id = s.id
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
  return {
    id: Number(row.id),
    imageId: Number(row.image_id),
    orderNo: String(row.order_no ?? ''),
    shop: String(row.shop ?? ''),
    size: String(row.size ?? ''),
    orderTime: String(row.order_time ?? ''),
    rawFields: safeJson(String(row.raw_fields ?? '')),
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
