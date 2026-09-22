// dist/splitter.js
// 一订单多产品行拆分（从宿主 src/lib/orderRowSplitter.ts 同语义移植）。
// 平台导出的订单表中，一行订单可能含多个产品：「产品数量」声明 N，
// 「产品图片链接/产品ID/尺寸/产品信息」等列以 换行/分号/逗号/【N】块 承载多值。
// 本模块把这类行拆为 N 条产品级记录；缺图产品保留空图片记录，由概览页补图后重处理。

const MAX_PRODUCTS_PER_ORDER = 50;
/** 换行符（避免源码内出现行分隔符字面转义） */
const NL = String.fromCharCode(10);
const RE_NL = new RegExp('[' + NL + ']+', 'g');

/** 空 execution: 按多个分隔符切分字符串，返回去空 trim 列表 */
function splitList(value, seps) {
  let v = String(value ?? '');
  for (const s of seps) v = v.replace(s, ' ');
  return v
    .split(' ')
    .map((t) => t.trim())
    .filter((t) => t.length > 0);
}

/** 解析「【1】xxx【2】yyy」块结构，尝试从块内提取 Size 兜底 */
function parseInfoBlocks(text) {
  const raw = String(text ?? '');
  if (raw.indexOf('【') === -1) return [];
  const blocks = [];
  const re = /【([0-9]+)】([\s\S]*?)(?=【[0-9]+】|$)/g;
  let m = null;
  while ((m = re.exec(raw)) !== null) {
    const t = String(m[2] ?? '').trim();
    const sm = /(?:Size|尺寸)\s*[:：]\s*([^\s,;，；)）]+)/i.exec(t);
    blocks.push({ text: t, size: sm ? sm[1] : undefined });
  }
  return blocks;
}

/**
 * 探测多产品结构所需列（列名关键词 + 样本校验；无多产品结构返回 null）
 * @param {string[]} headers
 * @param {Record<string,string>[]} rows
 * @param {{imageColumn?:string,sizeColumn?:string}} known 既有探测结果（主图/尺寸列）
 */
export function detectMultiProductColumns(headers, rows, known = {}) {
  const count =
    headers.find((h) => {
      if (!/数量|Quantity|QTY/i.test(h)) return false;
      return rows.some((r) => {
        const n = Number.parseInt(String(r[h] ?? '').trim(), 10);
        return Number.isFinite(n) && n >= 2 && n <= MAX_PRODUCTS_PER_ORDER;
      });
    }) ?? '';
  if (!count) return null;
  const has = (re) => headers.find((h) => re.test(h)) ?? '';
  const info =
    headers.find(
      (h) =>
        /产品信息|商品信息|产品名称|商品名称|产品详情|商品详情/i.test(h) &&
        rows.some((r) => String(r[h] ?? '').indexOf('【') >= 0),
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

/** 拆分单行订单为产品级记录（N<=1 或数量无法解析时原样返回） */
export function expandOrderRow(fields, cols) {
  const n = Math.min(
    MAX_PRODUCTS_PER_ORDER,
    Math.max(1, Number.parseInt(String(fields[cols.count] ?? '').trim(), 10) || 1),
  );
  if (n <= 1) return { rows: [fields], missingImage: false };

  const urls = splitList(fields[cols.image] ?? '', [RE_NL, /;/g]);
  const ids = cols.productId ? splitList(fields[cols.productId] ?? '', [/;/g, RE_NL]) : [];
  const sizes = cols.size ? splitList(fields[cols.size] ?? '', [/,/g, /;/g]) : [];
  const blocks = cols.info ? parseInfoBlocks(fields[cols.info] ?? '') : [];

  const rows = [];
  let missingImage = false;
  for (let i = 0; i < n; i += 1) {
    const row = { ...fields };
    row[cols.image] = urls[i] ?? '';
    if (cols.productId) row[cols.productId] = ids[i] ?? (ids.length === 1 ? ids[0] : '');
    if (cols.size) row[cols.size] = sizes[i] ?? (sizes.length === 1 ? sizes[0] : blocks[i]?.size ?? sizes[0] ?? '');
    if (cols.info && blocks.length === n) row[cols.info] = blocks[i].text;
    if (!row[cols.image]) missingImage = true;
    rows.push(row);
  }
  return { rows, missingImage };
}

/** 批量展开全部行 */
export function expandOrderRows(allRows, cols) {
  if (!cols) return { rows: allRows, expanded: 0, missingImageCount: 0 };
  let expanded = 0;
  let missingImageCount = 0;
  const out = [];
  for (const r of allRows) {
    const res = expandOrderRow(r, cols);
    if (res.rows.length > 1) expanded += 1;
    if (res.missingImage) missingImageCount += 1;
    out.push(...res.rows);
  }
  return { rows: out, expanded, missingImageCount };
}
