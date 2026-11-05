// src/lib/orderImportRow.ts
// 订单报表**一行 → 落库字段**的纯提取层（零副作用、可 vitest）。
//
// 为什么单拎出来：这几条口径错了全是**静默**的 —— 店铺列没接上 → 订单全"未归属"，
// 主图 URL 没 trim → 带换行去下载必然失败（或把两张图拼成一个 URL），
// 订单号认不出 → 整行被 skip 而界面只说"导入了 N 行"。规则只有这一份，导入服务直接用。
//
// 列名族与 `orderClassifier` / `orderRowSplitter` / `shipRateOrders` 同口径（探测规则只能有一份）。

/** 本行要用到的列名（来自 `orderClassifier` 的探测结果；'' = 报表没有该列） */
export interface OrderRowColumns {
  /** 店铺名列 */
  shop: string;
  /** 主图 / 图片链接列 */
  image: string;
}

/** 一行订单落库所需的最小字段 */
export interface OrderRowFields {
  orderNo: string;
  /** 店铺**原文**（报表没有店铺列 → ''；归一在查询侧做，历史文本不改写） */
  shop: string;
  size: string;
  orderTime: string;
  /** 主图 URL（已 trim；'' = 这一行没有图） */
  imageUrl: string;
}

/** 订单号列名族（与岛屿 `detectOrderNoColumn` 同族，这里按行容错取第一个非空） */
const ORDER_NO_KEYS = [/订单号/, /^order\s*id$/i, /order_no/];
/** 尺码列名族（芒果店长的列名是「尺寸」，不写进去整列为空） */
const SIZE_KEYS = [/尺码/, /^size$/i, /尺寸/];
/** 下单时间列名族 */
const TIME_KEYS = [/下单时间/, /订单时间/, /^时间$/];

/** 按列名族取该行第一个非空值（外层按"具体 → 宽泛"逐条试，命中即回） */
export function pickOrderCol(row: Record<string, string> | null | undefined, family: RegExp[]): string {
  for (const re of family) {
    for (const [k, v] of Object.entries(row ?? {})) {
      if (re.test(k) && String(v ?? '').trim()) return String(v).trim();
    }
  }
  return '';
}

/**
 * 一行（**已拆行**的产品级记录）→ 落库字段。
 *
 * 组合键 `(订单号, 图片)` 是 `oi_orders` 的幂等键：两个字段都必须**归一到单片/单值**，
 * 否则重复导入会重复落行、多产品单会互相顶掉（`insertOrder` 的可空幂等判定见 `order-db`）。
 */
export function orderRowFields(
  row: Record<string, string> | null | undefined,
  cols: OrderRowColumns,
): OrderRowFields {
  return {
    orderNo: pickOrderCol(row, ORDER_NO_KEYS),
    shop: cols?.shop ? String(row?.[cols.shop] ?? '').trim() : '',
    size: pickOrderCol(row, SIZE_KEYS),
    orderTime: pickOrderCol(row, TIME_KEYS),
    // 单产品行的图片单元格会带着尾随换行（拆行只在 N>1 时切分）→ 一律 trim 后再下载
    imageUrl: cols?.image ? String(row?.[cols.image] ?? '').trim() : '',
  };
}
