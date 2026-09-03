// src/lib/orderRowSplitter.ts
// 一订单多产品行拆分（纯函数，无副作用，可单测）。
// 芒果店长等平台导出的订单 Excel 中，一个订单行可能包含多个产品：
//   「产品数量」列声明 N，「产品图片链接」「产品ID」「尺寸」等多值列以
//   换行 / 分号 / 逗号分隔（顺序与产品一一对应）。
// 本模块将这样的行拆分为 N 条产品级记录：订单级字段原样复制，
// 产品级字段按索引对齐切成单个；缺图产品保留空图片记录（由用户在概览页补图后重处理）。

/** 拆分所需的多值列配置 */
export interface MultiProductColumns {
  /** 产品数量列（权威 N） */
  count: string;
  /** 主图链接列（多值：换行/分号分隔） */
  image: string;
  /** 产品ID列（多值：分号分隔，可空） */
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
 * 探测多产品结构所需列（列名关键词 + 样本校验），无多产品结构返回 null。
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
  if (!count) return null;
  const has = (re: RegExp): string => headers.find((h) => re.test(h)) ?? '';
  const info =
    headers.find(
      (h) =>
        /产品信息|商品信息|产品名称|商品名称|产品详情|商品详情/i.test(h) &&
        rows.some((r) => (r[h] ?? '').includes('【')),
    ) ?? '';
  const productId = has(/产品ID|商品ID|SKU/i);
  return {
    count,
    image: known.imageColumn ?? '',
    productId,
    size: known.sizeColumn ?? '',
    info,
  };
}

/**
 * 拆分一行订单为产品级记录；N<=1 或无法解析数量时原样返回。
 * 缺图产品保留空图片链接记录（由用户补图后重处理）。
 */
export function expandOrderRow(fields: Record<string, string>, cols: MultiProductColumns): SplitResult {
  const n = Math.min(
    MAX_PRODUCTS_PER_ORDER,
    Math.max(1, Number.parseInt((fields[cols.count] ?? '').trim(), 10) || 1),
  );
  if (n <= 1) return { rows: [fields], missingImage: false };

  const urls = splitList(fields[cols.image] ?? '', [/\n/, /;/]);
  const ids = cols.productId ? splitList(fields[cols.productId] ?? '', [/;/, /\n/]) : [];
  const sizes = cols.size ? splitList(fields[cols.size] ?? '', [/,/, /;/]) : [];
  const blocks = cols.info ? parseInfoBlocks(fields[cols.info] ?? '') : [];

  const rows: Record<string, string>[] = [];
  let missingImage = false;
  for (let i = 0; i < n; i++) {
    const row: Record<string, string> = { ...fields };
    row[cols.image] = urls[i] ?? '';
    if (cols.productId) {
      row[cols.productId] = ids[i] ?? (ids.length === 1 ? ids[0] : '');
    }
    if (cols.size) {
      row[cols.size] = sizes[i] ?? (sizes.length === 1 ? sizes[0] : blocks[i]?.size ?? sizes[0] ?? '');
    }
    if (cols.info && blocks.length === n) row[cols.info] = blocks[i].text;
    if (!row[cols.image]) missingImage = true;
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
