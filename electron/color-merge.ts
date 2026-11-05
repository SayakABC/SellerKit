// electron/color-merge.ts
// 「颜色管理」的编排层：颜色板 + 颜色合并（**跨域**，因此不收进任何一个 `-db`）。
//
// 为什么需要（2026-10-30 用户口径「当前颜色的管理页面还没有，现状是存在相同的颜色，
// 只是名称不一样，要支持颜色合并」）：
//   色名在业务表里是**文本**（`oi_style_colors.color` / `pl_variants.color`），而字典
//   （`md_colors`）只是"常用色清单"—— 没有任何约束保证它们指向同一个词。真库实测
//   `黑 / 黑色`、`白 / 白色`、`灰 / 灰色`、`红 / 红色`、`蓝 / 蓝色`、`black / 黑色` 各自成行，
//   于是"黑色卖了多少"被拆成两三个数。合并必须**真正改写业务数据**（不是只记别名）：
//   用户口径「合并后颜色ID归一，最终统计按归一后的颜色ID来统计，展示的名称也按归一后的
//   名称展示」。
//
// 四条纪律（与仓内既有口径一致）：
//   ① **保留名必须是真颜色**：纯数字色号（平台 `1`..`15`）只能当源，不能当保留名 ——
//      与 `md-color-create` 同一条校验（"还没定色"不许被固化成主数据）。
//   ② **code 一律不动**：`oi_style_colors.code` / `pl_variants.code` 是已被拣货/编码规则
//      引用的身份，合并只改色名与指向，不改编码。
//   ③ **平台原文不动**：`oi_order_items.color` 是平台侧原文，"未认色"是派生态；
//      合并改的是归一后的色名（`style_color_id` 指向的款色行），不是原始标签。
//   ④ **撞名先并引用再删行**：同款已有保留色时，先把订单行 / 变体键 / 套装部件指到保留色行，
//      `image_id` 只补空，再删源行 —— 顺序反了就会被外键挡住或留下悬空引用。

export {};

const dbCore = require('./db') as typeof import('./db');
const md = require('./master-data-db') as typeof import('./master-data-db');
const orderDb = require('./order-db') as typeof import('./order-db');
const productDb = require('./product-db') as typeof import('./product-db');
const { colorAliasKey } = require('./colorAlias') as typeof import('./colorAlias');

const { dbRun, dbGet, dbQuery, dbTransaction, tableExists } = dbCore;

/** 颜色板上的一行（一行 = 一个色名，字典内外都在） */
export interface ColorBoardRow {
  name: string;
  /** `md_colors.id`；0 = 还没进字典 */
  colorId: number;
  hex: string;
  /** 用到这个色的款数（`oi_style_colors` 去重 style_id） */
  styles: number;
  /** 这个色的 SKU 数（`pl_variants`） */
  skus: number;
  /** 指向这个色的订单明细行数（经 `style_color_id`） */
  orders: number;
  /** 是否已在字典里（false = 只有业务表在用它） */
  inDict: boolean;
  /** 纯数字色号（平台色号，不能当保留名） */
  numeric: boolean;
  /**
   * 这个色名的**代表款图**本地路径（`oi_style_colors.image_id` → `md_images.local_path`）。
   *
   * 为什么颜色板上要带图（2026-10-31 用户口径「带归一列表中需要加款图，不然数字没法知道
   * 是什么颜色」）：数字色号 / 平台原文色名只有字符串，`5` 到底是红还是蓝无从判断 ——
   * 选错源色就是把一整批款色并到别的颜色上。图取的是**该色名在款色表里已有的色图**，
   * 没有就是空串（界面画空占位，不用中性灰假装是答案）。
   */
  imagePath: string;
}

/** 合并回执（界面用它说清"动了多少"） */
export interface ColorMergeResult {
  source: string;
  target: string;
  /** 源色在字典里的 1 行（删掉；0 = 源色本来不在字典） */
  dictRemoved: number;
  /** 改指 / 新增的平台色别名条数 */
  aliases: number;
  /** 直接改色名的款色行（同款下还没有保留色） */
  styleRenamed: number;
  /** 并进同款已有保留色的款色行（引用搬走后删行） */
  styleMerged: number;
  /** 随手改指的订单明细行 */
  orders: number;
  /** 改指的变体键 */
  keys: number;
  /** 改指的套装部件 */
  parts: number;
  /** 直接改色名的 SKU（`pl_variants`） */
  skusRenamed: number;
  /** 撞名并掉的 SKU（保留保留色那一行，源行删掉） */
  skusMerged: number;
}

const MAX_NAME = 40;

function normName(raw: unknown): string {
  return String(raw ?? '').trim().slice(0, MAX_NAME);
}

function countOf(sql: string, params: readonly (string | number)[] = []): number {
  const row = dbGet<{ n: number }>(sql, [...params]);
  return Number(row?.n ?? 0);
}

function ensureSchemas(): void {
  // 三个域都可能还没建表（各域懒建）：合并要同时读写订单域与产品域的色名列。
  orderDb.ensureOrderSchema();
  productDb.ensureProductSchema();
  // SKU 表（`pl_variants`）在**另一个**入口建（`ensureProductSchema` 不管它）。不建的话
  // `tableExists('pl_variants')` 为假 ⇒ SKU 那半段被静默跳过：回执里 `skusRenamed/skusMerged`
  // 恒为 0，用户看到"合并成功"但 SKU 矩阵里同色异名还在（升级后没打开过产品页的新库必踩）。
  productDb.ensureVariantSchema();
}

/**
 * 颜色板：字典 ∪ 业务表里出现过的色名。
 *
 * 为什么把"只在业务表里"的色也列出来：它们正是"同色异名"的证据来源 ——
 * 用户要合并的往往是 `黑`（只在款色里）与 `黑色`（字典里的种子），只列字典就看不见要并的东西。
 * 数字色号也列（并进哪个真色由人指认），只标 `numeric` 让界面禁止把它当保留名。
 *
 * 排序：字典色按 `sort_order`（与下拉一致）在前，其余按用量降序 —— 用得多的问题色先看见。
 */
export function colorBoard(): { rows: ColorBoardRow[] } {
  ensureSchemas();
  const byName = new Map<string, ColorBoardRow>();
  const dictOrder = new Map<string, number>();

  let seq = 0;
  for (const c of md.colorList()) {
    byName.set(c.name, {
      name: c.name,
      colorId: c.id,
      hex: c.hex,
      styles: 0,
      skus: 0,
      orders: 0,
      inDict: true,
      numeric: false,
      imagePath: '',
    });
    dictOrder.set(c.name, seq++);
  }

  const ensureRow = (name: string): ColorBoardRow => {
    let row = byName.get(name);
    if (!row) {
      row = {
        name,
        colorId: 0,
        hex: '',
        styles: 0,
        skus: 0,
        orders: 0,
        inDict: false,
        numeric: /^\d+$/.test(name),
        imagePath: '',
      };
      byName.set(name, row);
    }
    return row;
  };

  if (tableExists('oi_style_colors')) {
    for (const r of dbQuery<{ color: string; styles: number }>(
      `SELECT color, COUNT(DISTINCT style_id) AS styles FROM oi_style_colors GROUP BY color`,
    )) {
      const name = String(r.color ?? '');
      if (!name) continue;
      ensureRow(name).styles = Number(r.styles) || 0;
    }
  }
  if (tableExists('oi_order_items')) {
    for (const r of dbQuery<{ color: string; n: number }>(
      `SELECT sc.color AS color, COUNT(*) AS n
         FROM oi_order_items oi
         JOIN oi_style_colors sc ON sc.id = oi.style_color_id
        WHERE oi.style_color_id > 0
        GROUP BY sc.color`,
    )) {
      const name = String(r.color ?? '');
      if (!name) continue;
      ensureRow(name).orders = Number(r.n) || 0;
    }
  }
  if (tableExists('pl_variants')) {
    for (const r of dbQuery<{ color: string; n: number }>(
      `SELECT color, COUNT(*) AS n FROM pl_variants WHERE color <> '' GROUP BY color`,
    )) {
      const name = String(r.color ?? '');
      if (!name) continue;
      ensureRow(name).skus = Number(r.n) || 0;
    }
  }

  // 代表款图：每个色名取该色在款色表里**已有的一张**图（同色多款时取 image_id 最小的那张，
  // 确定性可复现）。`local_path` 为空的行跳过 —— 登记了图但文件没落盘的旧行不该画成空图。
  // 数字色号的用途正在于此：`5` 只有靠这张图才能看出是红是蓝（见 ColorBoardRow.imagePath）。
  if (tableExists('oi_style_colors') && tableExists('md_images')) {
    const firstImageId = new Map<string, number>();
    for (const r of dbQuery<{ color: string; image_id: number }>(
      `SELECT sc.color AS color, sc.image_id AS image_id
         FROM oi_style_colors sc
         JOIN md_images i ON i.id = sc.image_id
        WHERE sc.image_id > 0 AND COALESCE(i.local_path, '') <> ''
        ORDER BY sc.color ASC, sc.image_id ASC`,
    )) {
      const name = String(r.color ?? '');
      const imageId = Number(r.image_id) || 0;
      if (!name || !imageId || firstImageId.has(name)) continue;
      firstImageId.set(name, imageId);
    }
    if (firstImageId.size) {
      const paths = md.imageLocalPathMap([...new Set(firstImageId.values())]);
      for (const [name, imageId] of firstImageId) {
        ensureRow(name).imagePath = paths.get(imageId) ?? '';
      }
    }
  }

  const rows = [...byName.values()];
  rows.sort((a, b) => {
    const ao = dictOrder.has(a.name) ? dictOrder.get(a.name)! : null;
    const bo = dictOrder.has(b.name) ? dictOrder.get(b.name)! : null;
    if (ao !== null && bo !== null) return ao - bo;
    if (ao !== null) return -1;
    if (bo !== null) return 1;
    const ua = a.styles + a.skus + a.orders;
    const ub = b.styles + b.skus + b.orders;
    if (ua !== ub) return ub - ua;
    return a.name.localeCompare(b.name, 'zh');
  });
  return { rows };
}

/**
 * 把 `source` 色**整体并进** `target` 色（事务内）。
 *
 * 覆盖的数据（一处漏掉 = 那个视图上的"同色"还在）：
 *   · `md_colors`：源色行删掉（保留色若不存在则补进字典）
 *   · `md_color_aliases`：指向源色的别名改指保留色；并**新增**一条全局别名 源→保留
 *     （下次导入平台色 `黑` 时直接落到 `黑色`，不用再认一次）
 *   · `oi_color_aliases`：`color = 源色` 的对照行改成保留色
 *   · `oi_style_colors`：同款已有保留色 ⇒ 先搬引用再删源行（`image_id` 只补空）；
 *     没有 ⇒ 原地改色名（**code 不动**）
 *   · `pl_variants`：同产品已有「保留色 + 同一尺码」⇒ 并掉（克重/编码只补空）；
 *     没有 ⇒ 改 `color` 与 `name`（code 不动）
 *
 * 拒绝路径（全部在写之前判定）：空名 / 同一个色 / 保留名是数字色号 / 源色根本不存在。
 */
export function mergeColors(sourceRaw: unknown, targetRaw: unknown): ColorMergeResult {
  ensureSchemas();
  const source = normName(sourceRaw);
  const target = normName(targetRaw);
  if (!source) throw new Error('源颜色不能为空');
  if (!target) throw new Error('保留颜色不能为空');
  if (source === target) throw new Error('这是同一个颜色，不需要合并');
  if (/^\d+$/.test(target)) throw new Error('数字色号不能作为保留色名（先认成具体的颜色）');

  const sourceInDict = md.resolveColorId(source) > 0;
  const sourceStyles = tableExists('oi_style_colors')
    ? countOf(`SELECT COUNT(*) AS n FROM oi_style_colors WHERE color = ?`, [source])
    : 0;
  const sourceSkus = tableExists('pl_variants')
    ? countOf(`SELECT COUNT(*) AS n FROM pl_variants WHERE color = ?`, [source])
    : 0;
  if (!sourceInDict && !sourceStyles && !sourceSkus) {
    throw new Error(`颜色「${source}」不存在`);
  }

  // 保留色先落字典（事务外建，避免在事务里跑建表/播种）
  const targetId = md.ensureColorId(target).id;

  return dbTransaction(() => {
    const out: ColorMergeResult = {
      source,
      target,
      dictRemoved: 0,
      aliases: 0,
      styleRenamed: 0,
      styleMerged: 0,
      orders: 0,
      keys: 0,
      parts: 0,
      skusRenamed: 0,
      skusMerged: 0,
    };

    // ① 平台色别名（字典侧）：指向源色的改指保留色
    const sourceDictId = md.resolveColorId(source);
    if (sourceDictId > 0) {
      out.aliases += dbRun(
        `UPDATE md_color_aliases SET color_id = ?, updated_at = datetime('now','localtime')
          WHERE color_id = ?`,
        [targetId, sourceDictId],
      ).changes;
    }
    // ② 记下「源 → 保留」这条全局别名（折叠大小写/空白后的键；下次导入直接归一）
    const aliasKey = colorAliasKey(source);
    if (aliasKey) {
      dbRun(
        `INSERT INTO md_color_aliases (product_id, alias_key, alias_raw, color_id)
         VALUES (0, ?, ?, ?)
         ON CONFLICT(product_id, alias_key) DO UPDATE SET
           alias_raw = excluded.alias_raw,
           color_id = excluded.color_id,
           updated_at = datetime('now','localtime')`,
        [aliasKey, source, targetId],
      );
      out.aliases += 1;
    }
    // ③ 源色从字典删掉（先删别名指向，再删行 —— 别名是 ON DELETE CASCADE）
    if (sourceDictId > 0) {
      out.dictRemoved = dbRun(`DELETE FROM md_colors WHERE id = ?`, [sourceDictId]).changes;
    }

    // ④ 订单域的平台色对照表
    if (tableExists('oi_color_aliases')) {
      dbRun(
        `UPDATE oi_color_aliases SET color = ?, updated_at = datetime('now','localtime')
          WHERE color = ?`,
        [target, source],
      );
    }

    // ⑤ 款色：同款已有保留色 ⇒ 搬引用后删源行；否则原地改色名（code 不动）
    if (tableExists('oi_style_colors')) {
      for (const row of dbQuery<{ id: number; style_id: number; image_id: number }>(
        `SELECT id, style_id, image_id FROM oi_style_colors WHERE color = ? ORDER BY id`,
        [source],
      )) {
        const srcSc = Number(row.id);
        const styleId = Number(row.style_id);
        const srcImage = Number(row.image_id) || 0;
        const hit = dbGet<{ id: number; image_id: number }>(
          `SELECT id, image_id FROM oi_style_colors WHERE style_id = ? AND color = ?`,
          [styleId, target],
        );
        if (!hit) {
          dbRun(`UPDATE oi_style_colors SET color = ? WHERE id = ?`, [target, srcSc]);
          out.styleRenamed += 1;
          continue;
        }
        const keepSc = Number(hit.id);
        const keepImage = Number(hit.image_id) || 0;
        out.orders += dbRun(
          `UPDATE oi_order_items SET style_color_id = ? WHERE style_color_id = ?`,
          [keepSc, srcSc],
        ).changes;
        out.keys += dbRun(
          `UPDATE oi_variant_keys SET style_color_id = ?, updated_at = datetime('now','localtime')
            WHERE style_color_id = ?`,
          [keepSc, srcSc],
        ).changes;
        out.parts += dbRun(
          `UPDATE oi_item_parts SET style_color_id = ? WHERE style_color_id = ?`,
          [keepSc, srcSc],
        ).changes;
        if (!keepImage && srcImage) {
          dbRun(`UPDATE oi_style_colors SET image_id = ? WHERE id = ?`, [srcImage, keepSc]);
        }
        dbRun(`DELETE FROM oi_style_colors WHERE id = ?`, [srcSc]);
        out.styleMerged += 1;
      }
    }

    // ⑥ 产品 SKU：同产品已有「保留色 尺码」⇒ 并掉；否则改色名与 name
    if (tableExists('pl_variants')) {
      for (const v of dbQuery<{ id: number; product_id: number; size: string; weight_g: number; code: string }>(
        `SELECT id, product_id, size, weight_g, code FROM pl_variants WHERE color = ? ORDER BY id`,
        [source],
      )) {
        const vid = Number(v.id);
        const pid = Number(v.product_id);
        const size = String(v.size ?? '');
        const nextName = [target, size].filter(Boolean).join(' ');
        const hit = dbGet<{ id: number; weight_g: number; code: string }>(
          `SELECT id, weight_g, code FROM pl_variants WHERE product_id = ? AND name = ?`,
          [pid, nextName],
        );
        if (!hit) {
          dbRun(`UPDATE pl_variants SET color = ?, name = ?, updated_at = datetime('now','localtime') WHERE id = ?`, [
            target,
            nextName,
            vid,
          ]);
          out.skusRenamed += 1;
          continue;
        }
        // 保留行只补空：克重 / 编码都只在保留行没有时才搬（已有值一律不动）。
        // ⚠️ **先删源行再补编码**：`idx_pl_variants_code` 是 code 非空时的**全局唯一**索引，
        //    先给保留行写码，源行还占着同一个码 ⇒ 唯一键当场冲突（事务回滚整次合并）。
        const keepId = Number(hit.id);
        dbRun(`DELETE FROM pl_variants WHERE id = ?`, [vid]);
        const patch: string[] = [];
        const vals: (string | number)[] = [];
        if (!(Number(hit.weight_g) > 0) && Number(v.weight_g) > 0) {
          patch.push('weight_g = ?');
          vals.push(Number(v.weight_g));
        }
        if (!String(hit.code ?? '').trim() && String(v.code ?? '').trim()) {
          patch.push('code = ?');
          vals.push(String(v.code).trim());
        }
        if (patch.length) {
          dbRun(
            `UPDATE pl_variants SET ${patch.join(', ')}, updated_at = datetime('now','localtime') WHERE id = ?`,
            [...vals, keepId],
          );
        }
        out.skusMerged += 1;
      }
    }

    return out;
  });
}
