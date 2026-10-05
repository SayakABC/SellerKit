// src/lib/orderRowSplitter.ts
// 一订单多产品行拆分（纯函数，无副作用，可单测）。
// 芒果店长等平台导出的订单 Excel 中，一个订单行可能包含多个产品：
//   「产品数量」列声明 N，「产品图片链接」「产品ID」「尺寸」等多值列以
//   换行 / 分号 / 逗号分隔（顺序与产品一一对应）。
// 本模块将这样的行拆分为 N 条产品级记录：订单级字段原样复制，
// 产品级字段按索引对齐切成单个；缺图产品保留空图片记录（由用户在概览页补图后重处理）。

/** 拆分所需的多值列配置 */
export interface MultiProductColumns {
  /**
   * 产品数量列（**权威 N**）。**可为空串** —— 速卖通订单报表根本没有数量列，
   * 此时 N 由「【N】块数 / 逗号分隔的商品ID 数」兜底（见 `expandOrderRow`）。
   */
  count: string;
  /** 主图链接列（多值：换行/分号分隔） */
  image: string;
  /** 产品ID列（多值：分号/换行/**逗号**分隔，可空） */
  productId: string;
  /** 尺寸列（多值：逗号/分号分隔，可空） */
  size: string;
  /** 产品信息列（【N】块，可空；块内 Size 作尺寸兜底） */
  info: string;
}

export interface SplitResult {
  /** 拆分后的产品级记录 */
  rows: Record<string, string>[];
  /** 该行是否含缺图产品（图片链接数量不足 N） */
  missingImage: boolean;
}

export interface ExpandResult {
  /** 展开后的全部记录 */
  rows: Record<string, string>[];
  /** 被拆分的订单行数 */
  expanded: number;
  /** 缺图的产品记录数 */
  missingImageCount: number;
}

const MAX_PRODUCTS_PER_ORDER = 50;
/** 订单级字段里承载多值的分隔符 */
const IMAGE_SEPS: RegExp[] = [/\n/, /;/];
/** 商品ID：速卖通订单报表用**逗号**分隔多商品（`1005...,1005...`），故逗号必须算一种 */
const ID_SEPS: RegExp[] = [/;/, /\n/, /,/];
const SIZE_SEPS: RegExp[] = [/,/, /;/];

/** 「商品信息 / 产品信息」列名族（探测与**件数提取**共用这一份 —— 规则只能有一处） */
export const ITEM_INFO_KEYS: RegExp = /产品信息|商品信息|产品名称|商品名称|产品详情|商品详情/i;

/** 单行件数的合理上限：超过它多半是解析撞上了别的数字 → 宁可按"取不到"处理，别给拣货单一个荒谬件数 */
const MAX_LINE_QTY = 999;

/** 件数写法族：速卖通实测为 `(商品数量:1 piece)`；换一家平台多半写作「产品数量」 */
const QTY_PATTERNS: RegExp[] = [/商品数量\s*[:：]\s*(\d+)/, /产品数量\s*[:：]\s*(\d+)/];

/** 按多个分隔符切分字符串，返回去空 trim 列表 */
function splitList(value: string, seps: RegExp[]): string[] {
  let v = value;
  for (const s of seps) v = v.split(s).join('\u0000');
  return v
    .split('\u0000')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** 解析「【1】xxx【2】yyy」块结构，并尝试从块内提取 Size 兜底 */
function parseInfoBlocks(text: string): Array<{ text: string; size?: string }> {
  if (!text.includes('【')) return [];
  const blocks: Array<{ text: string; size?: string }> = [];
  const re = /【(\d+)】([\s\S]*?)(?=【\d+】|$)/g;
  let m: RegExpExecArray | null;
  while ((m = re.exec(text)) !== null) {
    const t = (m[2] ?? '').trim();
    const sm = /(?:Size|尺寸)\s*[:：]\s*([^\s,;，；)）]+)/i.exec(t);
    blocks.push({ text: t, size: sm ? sm[1] : undefined });
  }
  return blocks;
}

/**
 * 从一行 `raw_fields` 的「商品信息」列里取**这一行的件数**（实测写法 `(商品数量:1 piece)`）。
 *
 * 为什么这一行的文本里就有件数：拆分（`expandOrderRow`）在块数与商品数一致时**已把该行的商品信息
 * 替换成它自己那一块**（速卖通 47 列报表的 153 行样本里两者 100% 一致），于是块内的数量就是这一件的数量。
 *
 * **取不到就返回 null，绝不猜**（两种情形）：
 *   1. 这一列还留着**多块原文**（拆分时块数 < 商品数，没替换）→ "这块是哪件"无从判定，
 *      按第一块给会让同一商品的多行重复计数；
 *   2. 该列压根没有（非速卖通格式）。
 * 也**刻意不用「数量」列**：拆行后那一列仍是**整行**的值（splitter 不清空），
 * 拿它会把 N 件拆出的每行都按 N 件算 —— 与 `extractShipping` 不用它的理由同一条。
 *
 * @returns 件数（≥1）；null = 这一行取不到件数（调用方按 1 件并**标缺口**）
 */
export function parseRowQty(rawFields: Record<string, string> | null | undefined): number | null {
  let text = '';
  for (const k of Object.keys(rawFields ?? {})) {
    if (!ITEM_INFO_KEYS.test(k)) continue;
    const v = String(rawFields?.[k] ?? '').trim();
    if (v) {
      text = v;
      break;
    }
  }
  if (!text) return null;
  if (parseInfoBlocks(text).length >= 2) return null;
  for (const re of QTY_PATTERNS) {
    const m = re.exec(text);
    if (!m) continue;
    const n = Number.parseInt(m[1], 10);
    return Number.isFinite(n) && n >= 1 && n <= MAX_LINE_QTY ? n : null;
  }
  return null;
}

/**
 * 探测多产品结构所需列（列名关键词 + 样本校验），无多产品结构返回 null。
 *
 * **两条多产品信号**（任一成立即算，缺一就会漏掉一整类报表）：
 *   ① 数量列声明 N —— 芒果店长式导出（有「产品数量」列，样本里存在 2..50 的整数，规避订单号误判）；
 *   ② **没有数量列**时的兜底 —— 「【N】块 ≥ 2」或「商品ID 逗号分隔 ≥ 2」；
 *      速卖通订单报表就是这一种（47 列无数量列，多商品行把商品ID 用逗号并列、商品信息里带【N】块）。
 *      漏掉 ②的后果不是"少拆"，而是把 `A,B` 当成**一个假商品ID**入库，且全程无告警。
 * @param known 已知列（主图列/尺寸列由既有列探测结果提供）
 */
export function detectMultiProductColumns(
  headers: string[],
  rows: Record<string, string>[],
  known: { imageColumn?: string; sizeColumn?: string },
): MultiProductColumns | null {
  // 产品数量列：列名含"数量"，且样本中存在 2..50 的整数（规避订单号等长数字误判）
  const count =
    headers.find((h) => {
      if (!/数量|Quantity|QTY/i.test(h)) return false;
      return rows.some((r) => {
        const n = Number.parseInt((r[h] ?? '').trim(), 10);
        return Number.isFinite(n) && n >= 2 && n <= MAX_PRODUCTS_PER_ORDER;
      });
    }) ?? '';
  const has = (re: RegExp): string => headers.find((h) => re.test(h)) ?? '';
  const info =
    headers.find((h) => ITEM_INFO_KEYS.test(h) && rows.some((r) => (r[h] ?? '').includes('【'))) ??
    '';
  // 商品ID 列名族：与 `shopSku.ITEM_ID_KEYS` / `shipRateOrders` **同口径**（探测规则只能有一份）——
  // 必须带 `\s*`：速卖通报表的列名是 `商品 ID`（带空格），`/商品ID/` 会漏掉它（漏了 = 多值列永不拆，
  // 且 `A,B` 当成一个假商品ID 入库）。
  const productId = has(/商品\s*ID|产品\s*ID|SKU|货号/i);

  const blockSignal = (): boolean =>
    !!info && rows.some((r) => parseInfoBlocks(r[info] ?? '').length >= 2);
  const idSignal = (): boolean =>
    !!productId && rows.some((r) => splitList(r[productId] ?? '', ID_SEPS).length >= 2);
  if (!count && !blockSignal() && !idSignal()) return null;

  return {
    count,
    image: known.imageColumn ?? '',
    productId,
    size: known.sizeColumn ?? '',
    info,
  };
}

/**
 * 拆分一行订单为产品级记录；N<=1 或无法判定数量时原样返回。
 * 缺图产品保留空图片链接记录（由用户补图后重处理）。
 *
 * **N 的来源**：数量列优先（有该列即权威）；**没有数量列时**取「【N】块数 / 逗号分隔的商品ID 数」的
 * 较大者。两者不一致时按较大值拆，多出来的那一行字段为空 —— 与"缺图产品保留空记录"同一处置：
 * **留给人看见并补齐，而不是静默丢掉一个产品**。
 */
export function expandOrderRow(fields: Record<string, string>, cols: MultiProductColumns): SplitResult {
  const urls = cols.image ? splitList(fields[cols.image] ?? '', IMAGE_SEPS) : [];
  const ids = cols.productId ? splitList(fields[cols.productId] ?? '', ID_SEPS) : [];
  const sizes = cols.size ? splitList(fields[cols.size] ?? '', SIZE_SEPS) : [];
  const blocks = cols.info ? parseInfoBlocks(fields[cols.info] ?? '') : [];

  const declaredN = cols.count
    ? Number.parseInt((fields[cols.count] ?? '').trim(), 10) || 1
    : 0;
  const inferredN = Math.max(blocks.length, ids.length);
  const n = Math.min(MAX_PRODUCTS_PER_ORDER, Math.max(1, declaredN || inferredN));
  if (n <= 1) return { rows: [fields], missingImage: false };

  const rows: Record<string, string>[] = [];
  let missingImage = false;
  for (let i = 0; i < n; i++) {
    const row: Record<string, string> = { ...fields };
    if (cols.image) row[cols.image] = urls[i] ?? '';
    if (cols.productId) {
      row[cols.productId] = ids[i] ?? (ids.length === 1 ? ids[0] : '');
    }
    if (cols.size) {
      row[cols.size] = sizes[i] ?? (sizes.length === 1 ? sizes[0] : blocks[i]?.size ?? sizes[0] ?? '');
    }
    if (cols.info && blocks.length === n) row[cols.info] = blocks[i].text;
    // 只在**存在图片列**时判缺图：像速卖通订单报表那样压根没有图片列（`cols.image` 为空串）的格式，
    // 逐行标"缺图"是凭空制造待补图 —— 那种报表的图另有来源（按商品ID 抓），不属拆行该判的事。
    if (cols.image && !row[cols.image]) missingImage = true;
    rows.push(row);
  }
  return { rows, missingImage };
}

/** 批量展开全部行，返回展开后记录与统计信息 */
export function expandOrderRows(
  allRows: Record<string, string>[],
  cols: MultiProductColumns | null,
): ExpandResult {
  if (!cols) return { rows: allRows, expanded: 0, missingImageCount: 0 };
  let expanded = 0;
  let missingImageCount = 0;
  const out: Record<string, string>[] = [];
  for (const r of allRows) {
    const { rows, missingImage } = expandOrderRow(r, cols);
    if (rows.length > 1) expanded += 1;
    if (missingImage) missingImageCount += 1;
    out.push(...rows);
  }
  return { rows: out, expanded, missingImageCount };
}
