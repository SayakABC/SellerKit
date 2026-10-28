/**
 * SKU 矩阵的**二维模型**（色 × 码）与 `sku_json` 平面数组之间的互转。
 *
 * 为什么要有这一层（2026-10-16，用户口径：把「修改 SKU 矩阵」重设计成速卖通那种"色 / 码"
 * 的展示方式）：真库最大一条采集行有 **140 条 SKU（14 色 × 10 码，满叉积）**，平铺成
 * 140 行表格时，"店里有哪些颜色、哪个色缺哪个码"这件事完全看不出来；而色图在平铺表里
 * 每行重复画一遍（同色 10 行 = 同一张图 10 次）。
 *
 * 三维事实（真库取证，见 `docs/notes/2026-10-16-sku-matrix-editor.md`）：
 *   ① 色图是**色级**属性 —— 同色多行带的是同一张图 ⇒ 图应该长在"行"上，不是"格"上；
 *   ② `(色名, 码)` **不是主键** —— 同一条采集行里 `blue` 这个色名可能挂两张不同的图
 *      （各 6 码）⇒ 行的身份必须包含色图，按色名做行会静默合并掉一半数据；
 *   ③ `price` 在界面里已撤（546/546 全空、且代码里零下游读者）—— 但它**必须原样带回**：
 *      界面不显示 ≠ 可以丢（本仓"漏传字段 = 静默清空"的那条铁律）。
 *
 * 三条不变量（改这个文件前先读）：
 *   · **空格 = 这个组合不存在**。展开回平面数组时**只输出存在的格**，绝不为空缺补一条
 *     （否则"取消一个格"会变成"凭空造出一个 SKU"）。
 *   · **行身份 = 色图 URL + 色名**（无图时只有色名）。同 URL 同名的重复帧会被合并（幂等），
 *     不同 URL 或不同名一律各占一行 —— 合并是数据判断，得由人看着图做。
 *   · **顺序稳定**：行序 = 平面数组里首次出现的顺序；列序 = 尺码首次出现的顺序。
 *     展开时按"行序 × 列序"输出 ⇒ 保存前后条数/顺序可对账。
 *   · **克重是「格」的属性**（色 × 码各一个值），0 = 没填；写回 `sku_json` 时 0 不写 key
 *     （存量形状不变，见 `toSkuJsonRow`）。
 *   · **`variantId` 只属于产品侧**（采集快照没有它）：它让"色名/码名改了"能在**原行上改**，
 *     而不是删旧建新 —— 删旧建新会静默丢掉该 SKU 的编码与状态（身份用 id，标签只展示）。
 *     结构变更的纯函数要么搬同一个格对象（`renameMatrixSize` / `mergeMatrixColor`），
 *     要么展开保留（`fillMatrixWeight`）；
 *     `toggleMatrixCell` 重新加回来的格是**新组合**，不带 id（那本来就是删了重建）。
 */

import { normalizeColor, normalizeText } from './orderClassifier';

/**
 * `sku_json` 里的规范形（主进程 `parseSkuProps` 的产物；也是 IPC 载荷的形状）。
 *
 * `weightG` 是**人补的**（采集端不产这个字段）：0 / 缺省都表示"没填"，
 * 因此序列化时**为 0 不写这个 key** —— 存量 546 条快照的形状一个字节都不变，
 * 「谁补过克重」在 raw JSON 里也看得出来（约定见 `toSkuJsonRow`）。
 */
export interface SkuFlatRow {
  color: string;
  size: string;
  price: string;
  imageUrl: string;
  /** 克重（克）；缺省 = 没填 */
  weightG?: number;
}

/** 一格：存在即有一条；`price` / `weightG` 是**界面可能不显示**但要原样带回的值 */
export interface SkuMatrixCell {
  price: string;
  /** 克重（克；0 = 没填）。两处界面都能填（2026-10-17）；落库时随 `sku_json` 走，0 不写 key */
  weightG: number;
  /**
   * 产品侧该 SKU 的 id（`pl_variants.id`；采集快照恒 undefined）。
   * 唯一的用途是**改名时认出"还是那一行"** —— 按 `(色, 码)` 对不上时排到"删旧建新"，
   * 会静默丢掉编码与状态。平面数组（`SkuFlatRow`）里没有这个字段：它不进 `sku_json`。
   */
  variantId?: number;
}

export interface SkuMatrixRow {
  /** 行身份（`色图 + 色名`）：同 key = 同一条数据行；仅供分组与调试，**不做列表 key** */
  key: string;
  color: string;
  /** 这一色的代表图（详情页采集；空 = 没采到 —— 不拿主图冒充） */
  imageUrl: string;
  /** 尺码 → 格。**缺 key = 这个组合不存在**（不是"0 元"，也不是"待填"） */
  cells: Record<string, SkuMatrixCell>;
  /**
   * 并进产品矩阵那一刻的**原色名**（采集侧色名，如平台的 `5`）。只有 `mergeSkuMatrix`
   * 新并入的行会带上；此后用户在矩阵里改色名，`color` 变而它不变。
   *
   * 用途：这些行落进 `pl_variants` 时是**新建**（没有 id），订单域的款色行还叫原色名 ——
   * 色图按「款编码 + 色名」查（`order-db#findStyleColorImagePath`），不把订单域色行一起改名，
   * 保存后图就查不到了（2026-10-23 用户实报「保存以后图片还是丢失了」）。
   * 不在 `sku_json` 里：`toSkuMatrix` 之外的序列化都不带它（见 `toSkuFlat`）。
   */
  srcColor?: string;
}

export interface SkuMatrix {
  /** 列（尺码）顺序；含空串（= 这一款没有尺码维度，只有颜色） */
  sizes: string[];
  rows: SkuMatrixRow[];
}

/** 展开结果：`sku_json` 的形状 + 界面扩展字段（克重） */
export interface SkuOutRow extends SkuFlatRow {
  weightG: number;
}

/** 行身份：色图 URL + 色名（无图时只剩色名 —— 两张都没图的同名行本来就分不出来，合并是对的） */
export function skuRowKey(imageUrl: string, color: string): string {
  const img = String(imageUrl ?? '').trim();
  const c = String(color ?? '').trim();
  return img ? `img:${img}\u0001${c}` : `name:${c}`;
}

/** 克重归一：非数 / 负数 / NaN 一律 0（0 = 没填，与 `pl_variants.weight_g` 同口径） */
export function normWeightG(v: unknown): number {
  const n = Math.round(Number(v));
  return Number.isFinite(n) && n > 0 ? n : 0;
}

/** 平面数组 → 矩阵（幂等：同一份数据来回转不会变形状） */
export function toSkuMatrix(flat: SkuFlatRow[] | null | undefined): SkuMatrix {
  const rows: SkuMatrixRow[] = [];
  const sizes: string[] = [];
  const byKey = new Map<string, SkuMatrixRow>();

  for (const raw of flat ?? []) {
    if (!raw) continue;
    const color = String(raw.color ?? '');
    const size = String(raw.size ?? '');
    const price = String(raw.price ?? '');
    const imageUrl = String(raw.imageUrl ?? '');
    // 全空行不入矩阵（与主进程 `normalizeIngestSku` 同一条规则：色 / 码 / 价全空即跳过）
    if (!color.trim() && !size.trim() && !price.trim()) continue;

    if (!sizes.includes(size)) sizes.push(size);

    const key = skuRowKey(imageUrl, color);
    let row = byKey.get(key);
    if (!row) {
      row = { key, color, imageUrl, cells: {} };
      byKey.set(key, row);
      rows.push(row);
    }
    // 同 key 同码 = 同一格被写两次（重复帧）⇒ 后写覆盖，不产生第二格
    row.cells[size] = { price, weightG: normWeightG(raw.weightG) };
  }

  return { sizes, rows };
}

/**
 * `sku_json` → 平面数组（渲染层的唯一解析点）。
 *
 * 两处调用（弹层 / 建款向导）此前各抄了一份 `parseSkus`，字段清单一旦不同步，
 * 克重就在其中一条路上静默归零 —— 所以这里只留一份。
 * 解析不了 / 不是数组 ⇒ 空数组（不抛：历史损坏值不该让弹层打不开）。
 */
export function parseSkuJsonRows(json: string | null | undefined): SkuFlatRow[] {
  if (!json) return [];
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return [];
  }
  if (!Array.isArray(v)) return [];
  const out: SkuFlatRow[] = [];
  for (const s of v) {
    if (!s || typeof s !== 'object') continue;
    const r = s as Record<string, unknown>;
    const row: SkuFlatRow = {
      color: String(r.color ?? ''),
      size: String(r.size ?? ''),
      price: String(r.price ?? ''),
      imageUrl: String(r.imageUrl ?? ''),
    };
    const w = normWeightG(r.weightG);
    if (w > 0) row.weightG = w;
    out.push(row);
  }
  return out;
}

/** 存在的组合数（表格里能看见的"实心格"数） */
export function skuMatrixComboCount(m: SkuMatrix): number {
  let n = 0;
  for (const r of m.rows) n += m.sizes.filter((s) => Object.prototype.hasOwnProperty.call(r.cells, s)).length;
  return n;
}

/** 克重已填的格数（"还差几格"是矩阵上最该一眼看出的进度） */
export function countFilledWeightCells(m: SkuMatrix): number {
  let n = 0;
  for (const r of m.rows) {
    for (const s of m.sizes) {
      const c = r.cells[s];
      if (c && normWeightG(c.weightG) > 0) n += 1;
    }
  }
  return n;
}

/**
 * 批量填克重。
 *
 * ⭐ 默认**只填空格**（`onlyEmpty = true`）：填克重是个高频的"补作业"动作，
 * 一不小心把 140 个已经核对过的值全覆盖成同一个数，等于静默毁数据（而克重会进成本/运费）。
 * 「覆盖已填」必须是人另外点的一个按钮。
 */
export function fillMatrixWeight(
  m: SkuMatrix,
  weightG: number,
  opts?: { onlyEmpty?: boolean },
): SkuMatrix {
  const w = normWeightG(weightG);
  if (w <= 0) return m;
  const onlyEmpty = opts?.onlyEmpty !== false;
  let changed = false;
  const rows = m.rows.map((r) => {
    const cells: Record<string, SkuMatrixCell> = { ...r.cells };
    let rowChanged = false;
    for (const s of m.sizes) {
      const cell = cells[s];
      if (!cell) continue; // 空格 = 组合不存在：绝不因为"批量填"把它变成一条 SKU
      if (onlyEmpty && normWeightG(cell.weightG) > 0) continue;
      if (normWeightG(cell.weightG) === w) continue;
      cells[s] = { ...cell, weightG: w };
      rowChanged = true;
    }
    if (!rowChanged) return r;
    changed = true;
    return { ...r, cells };
  });
  return changed ? { ...m, rows } : m;
}

/**
 * 按**一个尺码**批量填克重（该码下所有存在的格）。
 *
 * 为什么需要它（2026-10-25，真库取证）：克重在业务上不是"格的属性"，而是
 * **款 × 码**的属性 —— 411 个 SKU 里 303 个填了克重，按「产品 + 尺码」分组，
 * 86 组里有 2 色以上的组**全部**"同码各色完全一致"（0 组不一致，涉及 298 个 SKU）。
 * 典型款是"整款一个值"（连帽风衣 6 码全 500g），少数是码阶梯（L500→XL600→XXL700…）。
 * 也就是说逐格录 40 次里，最多 6 次是新信息。
 *
 * ⭐ `createMissing`（2026-10-25 晚加，用户实报「克重都填好了，保存还说这 3 个组合会被删掉」）：
 * **在列头敲一个数 = 对"这一码整列"的声明**，所以默认行为里缺的格也要补上 ——
 * 否则人明明填了「L = 500」，那三格在矩阵里仍然"不存在"，保存时反被判成要删的 SKU。
 * 这与格内敲数字即建组合（`onWeightInput`）是同一条不变量：**克重即存在**。
 * 不给 `createMissing` 时仍然只碰存在的格（纯函数保守，其它调用方语义不变）。
 * 默认**只填空**（覆盖已填必须是另一个显式动作，因为克重会进成本/运费）。
 */
export function fillMatrixSizeWeight(
  m: SkuMatrix,
  size: string,
  weightG: number,
  opts?: { onlyEmpty?: boolean; createMissing?: boolean },
): SkuMatrix {
  const w = normWeightG(weightG);
  if (w <= 0) return m;
  const onlyEmpty = opts?.onlyEmpty !== false;
  const createMissing = opts?.createMissing === true;
  let changed = false;
  const rows = m.rows.map((r) => {
    const cell = r.cells[size];
    if (!cell) {
      if (!createMissing) return r; // 不补齐时：空格 = 组合不存在，批量填不造 SKU
      changed = true;
      return { ...r, cells: { ...r.cells, [size]: { price: '', weightG: w } } };
    }
    if (onlyEmpty && normWeightG(cell.weightG) > 0) return r;
    if (normWeightG(cell.weightG) === w) return r;
    changed = true;
    return { ...r, cells: { ...r.cells, [size]: { ...cell, weightG: w } } };
  });
  return changed ? { ...m, rows } : m;
}

/**
 * 一组格子的克重**共同值**：参与统计的格全部已填且字面相同才返回它，否则 0。
 *
 * 用途只有一个：把"整款/这一码现在是多重"显示成输入框的值（而不是让人对着 40 格找规律）。
 * ⚠️ 它是**派生显示**，不落库、不构成第二个真相 —— 0 的三种来源（没有格 / 全没填 / 值不一致）
 * 由调用方用 `countFilledWeightCells` 之类的事实区分，别在这里编一个"看起来像值"的默认。
 */
export function matrixWeightCommon(m: SkuMatrix, size?: string): number {
  let common = 0;
  let seen = 0;
  for (const r of m.rows) {
    for (const s of m.sizes) {
      if (size !== undefined && s !== size) continue;
      const cell = r.cells[s];
      if (!cell) continue; // 空格不存在，不参与"共同值"
      const w = normWeightG(cell.weightG);
      if (w <= 0) return 0; // 有格没填 ⇒ 谈不上共同值
      if (seen === 0) common = w;
      else if (common !== w) return 0;
      seen += 1;
    }
  }
  return seen ? common : 0;
}

/** 矩阵 → 平面数组（**只输出存在的格**；顺序 = 行序 × 列序） */
export function fromSkuMatrix(m: SkuMatrix): SkuOutRow[] {
  const out: SkuOutRow[] = [];
  for (const row of m.rows) {
    for (const size of m.sizes) {
      if (!Object.prototype.hasOwnProperty.call(row.cells, size)) continue;
      const cell = row.cells[size];
      const color = String(row.color ?? '').trim();
      const price = String(cell?.price ?? '');
      // 与主进程同规则：色 / 码 / 价全空 ⇒ 跳过（一个"什么都没有"的格不构成 SKU）
      if (!color && !String(size).trim() && !price.trim()) continue;
      out.push({
        color,
        size,
        price,
        imageUrl: String(row.imageUrl ?? ''),
        weightG: normWeightG(cell?.weightG),
      });
    }
  }
  return out;
}

/**
 * 回到 `sku_json` 的形状。
 *
 * ⭐ 克重为 0 **不写 key**：存量快照的形状保持不变（0 = 没填，不携带任何信息），
 * 也让"这一行有人补过克重"在 raw JSON 里直接看得出来。
 */
export function toSkuJsonRow(r: SkuOutRow): SkuFlatRow {
  const row: SkuFlatRow = { color: r.color, size: r.size, price: r.price, imageUrl: r.imageUrl };
  const w = normWeightG(r.weightG);
  if (w > 0) row.weightG = w;
  return row;
}

/**
 * 新增一色。**新行对所有现有尺码默认"有"** —— 这一条是刻意的：
 * "再加一个颜色"的意图通常是"这个色全码都有"，让用户从零点 N 个格比"点掉几个不需要的"
 * 难得多。它与"不许凭空造 SKU"不冲突：那个人为禁止的是**隐式**副作用
 * （填一格价就生成 10 条 SKU），而这里是**人明确点了「+ 颜色」**。
 *
 * `weightG` = 当前界面上的「默认克重」：人显式设过才会带上（0 = 新格保持待填）。
 */
export function addMatrixColor(m: SkuMatrix, color = '', imageUrl = '', weightG = 0): SkuMatrix {
  const cells: Record<string, SkuMatrixCell> = {};
  for (const s of m.sizes) cells[s] = { price: '', weightG: normWeightG(weightG) };
  return { ...m, rows: [...m.rows, { key: skuRowKey(imageUrl, color), color, imageUrl, cells }] };
}

/** 新增一码。**新列对所有现有颜色默认"有"**（理由同上） */
export function addMatrixSize(m: SkuMatrix, size = '', weightG = 0): SkuMatrix {
  if (m.sizes.includes(size)) return m;
  const sizes = [...m.sizes, size];
  const rows = m.rows.map((r) => ({
    ...r,
    cells: { ...r.cells, [size]: { price: '', weightG: normWeightG(weightG) } },
  }));
  return { sizes, rows };
}

/** 删一色（整行，连同它的所有格 —— 这些组合都不存在了） */
export function removeMatrixColor(m: SkuMatrix, index: number): SkuMatrix {
  if (index < 0 || index >= m.rows.length) return m;
  return { ...m, rows: m.rows.filter((_, i) => i !== index) };
}

/** 合并两色的结果（`moved` / `conflicts` / `dropped` 是给界面说人话用的，不影响落库） */
export interface MergeColorResult {
  matrix: SkuMatrix;
  /** 搬进目标行的格数（源行有、目标行没有的那些码） */
  moved: number;
  /** 两边都有的码数（这些格以目标行为准） */
  conflicts: number;
  /**
   * **真正会消失的 SKU 数** —— 只有"两边这一格都已经落库（都有 `variantId`）"时才会少一条。
   * 目标格是新建的空白格时源行的 id 会被沿用（见下），那种冲突不丢 SKU，
   * 所以不能拿 `conflicts` 当"少几个 SKU"报给用户（会把人吓住，而且不实）。
   */
  dropped: number;
}

/**
 * 把第 `from` 行「并进」第 `to` 行（2026-10-24 用户口径「通过拖动颜色方式来合并」）。
 *
 * 为什么要有它：采集来的色名经常是**同一个色的两种说法**（`藏青` / `藏蓝`、`黑` / `黑色`），
 * 而产品侧一个色只能有一行（`pl_variants` 唯一键是 `(product_id, name)`）。
 * 在那之前用户唯一能做的是「把一行改名成另一行的名字」，但保存校验会拦下（"出现了两行"），
 * 于是看起来像"改了名 SKU 就没了"—— 其实是没有一条**把两行并成一行**的路。
 *
 * 四条规则（每一条都关系到"数据不许静默丢"）：
 *   · **只在目标行没这个码时搬格**，且搬的是**同一个格对象**（`variantId` 跟着走）⇒ 保存时
 *     那些 SKU 是"原地改色名"，不是"删旧建新"（见 `SkuMatrixCell.variantId` 的说明）。
 *   · **两边都有这个码 ⇒ 以目标行的格为准**（拖到谁身上就以谁为准，这是"并进"的字面意思）；
 *     但**克重取有值的一方** —— 目标行那格是"待填"时把源行的克重带过来，否则合并会顺手把
 *     人已经量过的克重清零。
 *   · **目标格还没落库（无 `variantId`）而源格有 ⇒ 接过源格的 id**：那一刻"还是同一条 SKU"。
 *     不接的话，往"刚点常用色新建的空白行"上合并会删掉已落库的 SKU 再造一条（编码/状态一起丢）。
 *     两边都有 id 时源侧那条才是真要删 —— `dropped` 数它（界面据此说"保存后少 N 个 SKU"）。
 *   · **行序不变**（源行只是从原位移除）：行序就是 SKU 的生成顺序，合并顺带重排会让
 *     "保存前后逐行对账"变成不可能。
 *
 * `from === to`、越界 ⇒ 返回**原引用**（调用方据此判断"什么都没发生"，不会白多一处待保存）。
 */
export function mergeMatrixColor(m: SkuMatrix, from: number, to: number): MergeColorResult {
  const none: MergeColorResult = { matrix: m, moved: 0, conflicts: 0, dropped: 0 };
  if (from === to) return none;
  const src = m.rows[from];
  const dst = m.rows[to];
  if (!src || !dst) return none;

  // 源行可能带着"矩阵列里没有的码"（理论上不该有，但静默丢掉就是丢一条 SKU）⇒ 补齐列。
  // 目标行同样要收：合并后它是活下来的那一行，它自己有列外格时也会被 `fromSkuMatrix` 丢掉。
  const sizes = [...m.sizes];
  for (const size of [...Object.keys(dst.cells), ...Object.keys(src.cells)]) {
    if (!sizes.includes(size)) sizes.push(size);
  }

  const cells: Record<string, SkuMatrixCell> = { ...dst.cells };
  let moved = 0;
  let conflicts = 0;
  let dropped = 0;
  for (const [size, cell] of Object.entries(src.cells)) {
    const cur = cells[size];
    if (!cur) {
      cells[size] = { ...cell };
      moved += 1;
      continue;
    }
    conflicts += 1;
    const w = normWeightG(cell.weightG);
    const next: SkuMatrixCell = { ...cur };
    if (normWeightG(cur.weightG) === 0 && w > 0) next.weightG = w;
    const curId = Number(cur.variantId) > 0 ? Number(cur.variantId) : 0;
    const srcId = Number(cell.variantId) > 0 ? Number(cell.variantId) : 0;
    if (!curId && srcId) next.variantId = srcId;
    else if (curId && srcId) dropped += 1;
    cells[size] = next;
  }

  // 行序 = 生成顺序：只把目标行的格换掉、源行摘掉，其余一行都不动
  const rows = m.rows
    .map((r, i) => (i === to ? { ...r, cells, imageUrl: r.imageUrl || src.imageUrl } : r))
    .filter((_, i) => i !== from);
  return { matrix: { ...m, sizes, rows }, moved, conflicts, dropped };
}

/** 归类到常用色的结果（`merged` 决定回执怎么说：并入已有行 / 原地改名） */
export interface ClassifyColorResult {
  matrix: SkuMatrix;
  /** true = 矩阵里已经有一行叫这个常用色 ⇒ 源行并进那一行；false = 原地改名为常用色 */
  merged: boolean;
  /** 并进时搬过来的格数（原地改名恒 0） */
  moved: number;
  /** 并进时同码冲突的格数（以目标行为准） */
  conflicts: number;
  /** 其中**真的会少掉的 SKU 数**（两边都已落库的那些）；界面按它说"保存后少 N 个 SKU" */
  dropped: number;
  /** 源行归类的**原名**（回执要说"把「藏蓝」归到「藏青」"） */
  fromColor: string;
}

/**
 * 把第 `from` 行**归类到常用色** `canonical`（2026-10-24 用户口径
 * 「拖动颜色里的项，拖动到常用色中进行归类，最终存储的以常用色为主」）。
 *
 * 与 `mergeMatrixColor` 的分工：那个是"拖到另一个色上"，目标色由**矩阵当前内容**决定；
 * 这个的目标色是**字典里的规范名**，因此多出两条语义：
 *
 *   · **目标色已经在矩阵里** ⇒ 走 `mergeMatrixColor`（格连同 `variantId` 一起搬、行序不变），
 *     再把目标行的色名统一成字典写法（去掉手输的空格等）⇒ 落库只有一行规范色。
 *   · **目标色还不在矩阵里** ⇒ **原地改名**（`cells` / `variantId` / `imageUrl` 一个都不动）。
 *     于是"采集来的 `藏蓝` 归到 `藏青`"是改标签，不是删旧建新 —— SKU 编码与状态都留着。
 *
 * ⭐ **一个色只留一张图**：无论合并还是改名，结果的每一行只有 `SkuMatrixRow.imageUrl` 这一个
 * 字段（合并时优先保目标行的图，目标行没图才用源行的）。图不按格存**是刻意的**：色图属于
 * 款色，不属于某一个 SKU；按格存会让"同一个色下十条 SKU 挂着三张互相矛盾的图"成为可能。
 *
 * 已经是这个规范名 / 名字为空 / 越界 ⇒ 返回**原引用**（调用方据此判断"什么都没发生"）。
 */
export function classifyMatrixColor(
  m: SkuMatrix,
  from: number,
  canonical: string
): ClassifyColorResult {
  const none: ClassifyColorResult = {
    matrix: m,
    merged: false,
    moved: 0,
    conflicts: 0,
    dropped: 0,
    fromColor: '',
  };
  const name = String(canonical ?? '').trim();
  const src = m.rows[from];
  if (!name || !src) return none;
  const fromColor = String(src.color ?? '').trim();

  const to = m.rows.findIndex(
    (r, i) => i !== from && String(r.color ?? '').trim() === name
  );
  if (to >= 0) {
    const res = mergeMatrixColor(m, from, to);
    if (res.matrix === m) return none;
    // ⚠️ 源行被摘掉后，目标行下标会前移一位（from < to 时）—— 按 from 之前的原下标改会改错行
    const at = to > from ? to - 1 : to;
    const rows = res.matrix.rows.map((r, i) =>
      i === at ? { ...r, color: name, key: skuRowKey(r.imageUrl, name) } : r
    );
    return {
      matrix: { ...res.matrix, rows },
      merged: true,
      moved: res.moved,
      conflicts: res.conflicts,
      dropped: res.dropped,
      fromColor,
    };
  }

  if (fromColor === name) return none;
  const rows = m.rows.map((r, i) =>
    i === from ? { ...r, color: name, key: skuRowKey(r.imageUrl, name) } : r
  );
  return { matrix: { ...m, rows }, merged: false, moved: 0, conflicts: 0, dropped: 0, fromColor };
}

/** 删一码（整列，连同所有颜色上的那一格） */
export function removeMatrixSize(m: SkuMatrix, size: string): SkuMatrix {
  const sizes = m.sizes.filter((s) => s !== size);
  if (sizes.length === m.sizes.length) return m;
  const rows = m.rows.map((r) => {
    const cells = { ...r.cells };
    delete cells[size];
    return { ...r, cells };
  });
  return { sizes, rows };
}

/** 改一个尺码名（列头改名：整列跟着改，格里的值原样搬过去） */
export function renameMatrixSize(m: SkuMatrix, from: string, to: string): SkuMatrix {
  const at = m.sizes.indexOf(from);
  if (at < 0 || from === to) return m;
  // 目标名已存在 ⇒ 两列合并（值以已有列为准，不覆盖 —— 合并是数据判断，不在这里猜）
  const merged = m.sizes.includes(to);
  const sizes = merged ? m.sizes.filter((s) => s !== from) : m.sizes.map((s) => (s === from ? to : s));
  const rows = m.rows.map((r) => {
    const cells = { ...r.cells };
    const cell = cells[from];
    delete cells[from];
    if (cell && !merged) cells[to] = cell;
    return { ...r, cells };
  });
  return { sizes, rows };
}

/** 从采集商品导入矩阵的结果（预览与导入后回执共用；全部是"将要/已经"发生的事） */
export interface MergeSkuStats {
  /** 新增的颜色行数 */
  addedColors: number;
  /** 新增的尺码列数 */
  addedSizes: number;
  /** 新出现的组合（格）数 */
  addedCells: number;
  /** 原本空着、这次补上克重的格数 */
  filledWeights: number;
  /** 缺色名或码名、落不进产品矩阵的采集行数 */
  skipped: number;
}

/**
 * 把**采集快照的矩阵**并进产品矩阵（2026-10-23：产品 SKU 的唯一来源是采集商品）。
 *
 * 三条规则，缺一条都会静默毁数据：
 *   · **只补缺口，绝不覆盖**：已存在的格一律不动（人核对过的组合/克重比采集快照可信）；
 *     克重只补 0（没填）的格，且保留格里的 `variantId`（填克重不是重建 SKU）。
 *   · **按色名对齐**：产品侧行身份是色名（`pl_variants` 唯一键是名字），采集侧行身份
 *     还带色图（同名不同图 = 采集侧两行）。所以两份 `blue` 落到产品侧**同一行**，
 *     不会把产品矩阵变成"同名两行"（保存时撞 UNIQUE）。
 *   · **空格不补**：采集快照里没有的组合（洞）导入后仍是空 —— 导入不是"补齐叉积"。
 *
 * `incoming` 由 `toSkuMatrix(parseSkuJsonRows(skuJson))` 得到。色名/码名缺一即跳过并计数
 * （产品 SKU 必须成对；采集侧允许"只有颜色"的行，那是采集形态，不是产品形态）。
 */
export function mergeSkuMatrix(
  base: SkuMatrix,
  incoming: SkuMatrix,
): { matrix: SkuMatrix; stats: MergeSkuStats } {
  const sizes = [...base.sizes];
  const rows = base.rows.map((r) => ({ ...r, cells: { ...r.cells } }));
  const byColor = new Map<string, SkuMatrixRow>();
  for (const r of rows) {
    const c = String(r.color ?? '').trim();
    if (c && !byColor.has(c)) byColor.set(c, r);
  }
  const stats: MergeSkuStats = { addedColors: 0, addedSizes: 0, addedCells: 0, filledWeights: 0, skipped: 0 };
  let changed = false;

  for (const src of incoming.rows ?? []) {
    const color = String(src.color ?? '').trim();
    for (const sizeRaw of incoming.sizes ?? []) {
      const srcCell = src.cells?.[sizeRaw];
      if (!srcCell) continue;
      const size = String(sizeRaw ?? '').trim();
      if (!color || !size) {
        stats.skipped += 1;
        continue;
      }
      let row = byColor.get(color);
      if (!row) {
        // `srcColor` 只在这里写：并入那一刻的色名 = 订单域款色行现在的名字（见 SkuMatrixRow 注释）
        row = { key: `color:${color}`, color, imageUrl: '', cells: {}, srcColor: color };
        byColor.set(color, row);
        rows.push(row);
        stats.addedColors += 1;
        changed = true;
      }
      if (!sizes.includes(size)) {
        sizes.push(size);
        stats.addedSizes += 1;
        changed = true;
      }
      const existing = row.cells[size];
      const w = normWeightG(srcCell.weightG);
      if (!existing) {
        row.cells[size] = { price: '', weightG: w };
        stats.addedCells += 1;
        changed = true;
      } else if (normWeightG(existing.weightG) === 0 && w > 0) {
        row.cells[size] = { ...existing, weightG: w };
        stats.filledWeights += 1;
        changed = true;
      }
    }
  }

  return { matrix: changed ? { sizes, rows } : base, stats };
}

/** 切换一格的存在性（空格 → 有；有 → 空）。加入时带上当前默认克重（0 = 待填） */
export function toggleMatrixCell(m: SkuMatrix, rowIndex: number, size: string, weightG = 0): SkuMatrix {
  const row = m.rows[rowIndex];
  if (!row) return m;
  const cells = { ...row.cells };
  if (Object.prototype.hasOwnProperty.call(cells, size)) {
    delete cells[size];
  } else {
    cells[size] = { price: '', weightG: normWeightG(weightG) };
  }
  const rows = m.rows.map((r, i) => (i === rowIndex ? { ...r, cells } : r));
  return { ...m, rows };
}

/**
 * 整行 / 整列的批量存在性（矩阵上"这一色全都卖""这一码全都卖"）。
 *
 * 与 `toggleMatrixCell` 的区别：那个回答"这一格反过来是什么"，这个回答"这一行/列**应该**是什么"。
 * 因此它是**幂等**的 —— 已经是目标状态就返回原对象引用（界面不会白白多出一处"待保存"，
 * 也不会在连点两下时把整行翻回去）。
 *
 * `present = false` 会删掉整行/整列的格 —— 那是**真的取消组合**，由调用方的保存确认框兜住
 * （删除在保存那一刻才落库，见 `ProductEditorDrawer` 的 `pendingSkuPlan`）。
 */
export function setMatrixRowCells(
  m: SkuMatrix,
  rowIndex: number,
  present: boolean,
  weightG = 0,
): SkuMatrix {
  const row = m.rows[rowIndex];
  if (!row) return m;
  const w = normWeightG(weightG);
  let changed = false;
  const cells: Record<string, SkuMatrixCell> = { ...row.cells };
  for (const s of m.sizes) {
    const has = Object.prototype.hasOwnProperty.call(cells, s);
    if (present && !has) {
      cells[s] = { price: '', weightG: w };
      changed = true;
    } else if (!present && has) {
      delete cells[s];
      changed = true;
    }
  }
  if (!changed) return m;
  return { ...m, rows: m.rows.map((r, i) => (i === rowIndex ? { ...r, cells } : r)) };
}

/** 整列同理（列 = 尺码；`size` 必须是 `m.sizes` 里的原文，含空串"无码"这一列） */
export function setMatrixColumnCells(
  m: SkuMatrix,
  size: string,
  present: boolean,
  weightG = 0,
): SkuMatrix {
  if (!m.sizes.includes(size)) return m;
  const w = normWeightG(weightG);
  let changed = false;
  const rows = m.rows.map((r) => {
    const has = Object.prototype.hasOwnProperty.call(r.cells, size);
    if (present && !has) {
      changed = true;
      return { ...r, cells: { ...r.cells, [size]: { price: '', weightG: w } } };
    }
    if (!present && has) {
      changed = true;
      const cells = { ...r.cells };
      delete cells[size];
      return { ...r, cells };
    }
    return r;
  });
  return changed ? { ...m, rows } : m;
}

/** 空矩阵起步（打开就能填：一色 × 一码，那一个格存在 —— 与旧弹层"先给一个空行"等价） */
export function emptySkuMatrix(): SkuMatrix {
  return { sizes: [''], rows: [{ key: skuRowKey('', ''), color: '', imageUrl: '', cells: { '': { price: '', weightG: 0 } } }] };
}

/**
 * 「这个色名认不出标准色名」—— 归一结果仍等于原文（`normalizeColor` 认不出时原样保留）。
 * 数字色号（`4`）与平台英文色名（`Black`，词表是中文的）都落在这里 —— 都该由人看着图确认。
 *
 * ⚠️ 判据只此一份：矩阵里的行高亮与"N 行认不出"的计数必须同源，否则会出现
 * "高亮 1 行、计数说 2 行"这种自相矛盾的界面。
 */
export function isUnknownColorName(color: string): boolean {
  const c = String(color ?? '').trim();
  if (!c) return false;
  return normalizeColor(c) === normalizeText(c);
}
