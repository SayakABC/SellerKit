// electron/picking-db.ts
// 「拣货」只读投影：**未发货**的订单行 + 三层回落后的图 + 款色码/供应商（供拣货单按 SKU 汇总）。
//
// 为什么单开一个文件而不是扩 `order-db.shippingRows`：两者问的不是同一个问题 ——
//   · `shippingRows` 是"算钱"用的（金额/时点/运价维度，最多 2000 行、不筛时点）；
//   · 本投影是"要拣什么"用的（**未发货** + 日期窗 + 店铺 + 图 + 供应商）。
// 但**款编码的识别链 JOIN 与"缺表降级"策略与它同一份**（`oi_images → oi_style_colors → oi_styles`、
// `pl_products → suppliers` 可选）—— 两处都改时别忘了对方（口径只能有一份）。
//
// ⚠️ 本层**只做机械筛选**（`ship_time` 空 / `status <> 'shipped'` / 店铺 / 上限）：
//   日期窗与"关闭单不该出现在拣货单里"**都不在本层** —— 前者要认 `order_time` 的多种写法
//   （实测存在 `2026-09-10 12:00:00` 与 `08/30/2026 07:00` 两种，SQL 里做字符串比较会**静默丢掉**
//   一整种格式的行），后者要按状态原文判定；两者的唯一实现都在渲染层纯函数
//   （`dateKey` / `bucketOfStatus`，见 `src/lib/orderCost.ts`）→ 由渲染层剔除并**计数报出**。
//   实测依据（`订单列表-6.xlsx` 153 行）：101 行"订单关闭"的 `发货时间` **是空的** ——
//   只按 `ship_time` 筛会把 101 条关闭单当成待拣，必须由渲染层按状态原文剔掉。

export {};

import { initDb, dbQuery, tableExists } from './db';
import { itemImagePool } from './product-db';
import { extractSkuFields } from './shopSku';

/** 拣货投影行（与 `src/lib/picking.ts` 的 `PickingRow` 对应，两端各自声明） */
export interface PickingRowProjection {
  id: number;
  orderNo: string;
  shop: string;
  orderTime: string;
  styleCode: string;
  /** 款色（识别链 / 映射的**权威结论**；'' = 没结论）。仅作事实呈现，分组键用的是下面的 `color` */
  styleColor: string;
  /** **有效颜色** —— 款色优先、回落订单原文色。
   *  为什么是这个顺序（2026-10-05 D4）：订单原文色在真实数据里几乎不可用（芒果待发货单该列恒空；
   *  采集帧里 39% 是 `Picture color` 这类"以图为准"的占位），而映射配的色正是写在款色上。
   *  不这样回落，配好的颜色会在拣货单上被丢掉 —— 症状是"我明明配了色，拣货单还是没色"。 */
  color: string;  size: string;
  itemId: string;
  supplierId: number;
  supplierName: string;
  /** 三层回落后的图（本地路径，经 `order-image-thumb(-batch)` 取缩略图）；'' = 没图 */
  imagePath: string;
  /** 机械事实：已发货（`ship_time` 非空 或 `status='shipped'`）。默认范围里恒 false */
  shipped: boolean;
  /** 平台状态原文（**交由渲染层**判"关闭/取消"等口径，见文件头） */
  bizStatus: string;
  /** 件数由渲染层从 raw_fields 解析（与订单利润页同一份实现） */
  rawFields: Record<string, string>;
}

export interface PickingRowsResult {
  rows: PickingRowProjection[];
  /** 该次查询的机械事实（范围口径由渲染层算并报出，见文件头） */
  meta: {
    /** 返回的行数 */
    rows: number;
    /** 实际用的上限 */
    limit: number;
  };
}

/**
 * 未发货订单行投影（只读）。
 *
 * @param input.limit 上限（1..5000，默认 2000）
 * @param input.shop 店铺原文精确匹配（'' = 不限；店铺是自由文本，归一在渲染层另议）
 * @param input.includeShipped 连已发货的一起回（默认 false；拣货只需未发货）
 *
 * 排序 `id DESC`（最近的导入在前）—— 上限截断的是"最旧的那批"，与渲染层的天数窗方向一致。
 */
export function pickingRows(
  input: { limit?: unknown; shop?: unknown; includeShipped?: unknown } = {},
): PickingRowsResult {
  initDb();
  const clamp = (v: unknown, lo: number, hi: number, dflt: number): number => {
    const n = Number(v);
    if (!Number.isFinite(n)) return dflt;
    return Math.min(Math.max(Math.round(n), lo), hi);
  };
  const limit = clamp(input?.limit, 1, 5000, 2000);
  const shop = typeof input?.shop === 'string' ? input.shop.trim().slice(0, 200) : '';
  const includeShipped = input?.includeShipped === true;

  // 供应商可选（`suppliers` / `pl_products` 属采购与产品域，可能还没建表）→ 先探再拼 JOIN，
  // 缺表时回落 0/''，不抛 `no such table`（与 `shippingRows` 同一策略）
  const hasSupplier = tableExists('suppliers') && tableExists('pl_products');
  const supplierSel = hasSupplier
    ? `COALESCE(p.supplier_id, 0) AS supplier_id, COALESCE(sup.name, '') AS supplier_name`
    : `0 AS supplier_id, '' AS supplier_name`;
  const supplierJoin = hasSupplier
    ? `LEFT JOIN pl_products p ON p.code = s.code
       LEFT JOIN suppliers sup ON sup.id = p.supplier_id`
    : '';

  const conds: string[] = [];
  const args: (string | number)[] = [];
  if (!includeShipped) {
    // "已发货"只认**机械事实**：平台给了发货时间，或域内标记已发货
    conds.push(`o.ship_time = '' AND o.status <> 'shipped'`);
  }
  if (shop) {
    conds.push(`o.shop = ?`);
    args.push(shop);
  }
  args.push(limit);
  const where = conds.length ? `WHERE ${conds.join(' AND ')}` : '';

  const rows = dbQuery<Record<string, unknown>>(
    `SELECT o.id, o.order_no, o.shop, o.order_time, o.raw_fields, o.color, o.size,
            o.ship_time, o.status, o.biz_status,
            COALESCE(s.code, '') AS style_code, COALESCE(sc.color, '') AS style_color,
            ${supplierSel}
     FROM oi_orders o
     LEFT JOIN oi_images i ON o.image_id = i.id
     LEFT JOIN oi_style_colors sc ON i.style_color_id = sc.id
     LEFT JOIN oi_styles s ON sc.style_id = s.id
     ${supplierJoin}
     ${where}
     ORDER BY o.id DESC LIMIT ?`,
    args,
  );

  const itemIds: string[] = [];
  const parsed = rows.map((r) => {
    let rawFields: Record<string, string> = {};
    try {
      const v = typeof r.raw_fields === 'string' ? JSON.parse(r.raw_fields) : r.raw_fields;
      if (v && typeof v === 'object') rawFields = v as Record<string, string>;
    } catch {
      /* raw_fields 不是合法 JSON 的行：留空（不让一条脏行毁掉整批），件数会按 1 件并标缺 */
    }
    // 商品ID 只在 raw_fields 里（`oi_orders` 无该列）—— 提取口径直接复用 `shopSku`（队列/取图同一份）
    const itemId = extractSkuFields(rawFields).itemId;
    if (itemId) itemIds.push(itemId);
    return { r, rawFields, itemId };
  });

  // 三层回落取图（`itemImagePool` 是唯一实现：覆盖图 → 订单图 → 款主图）—— 一次算好，逐 item 取首选
  const pool = itemIds.length ? itemImagePool(itemIds) : new Map();
  const out: PickingRowProjection[] = parsed.map(({ r, rawFields, itemId }) => {
    const orderTime = String(r.order_time ?? '');
    const entry = itemId ? pool.get(itemId) : undefined;
    const imagePath = entry
      ? String(entry.override?.localPath ?? entry.order[0]?.localPath ?? entry.product?.localPath ?? '')
      : '';
    const shipTime = String(r.ship_time ?? '');
    const status = String(r.status ?? '');
    return {
      id: Number(r.id ?? 0),
      orderNo: String(r.order_no ?? ''),
      shop: String(r.shop ?? ''),
      orderTime,
      styleCode: String(r.style_code ?? ''),
      styleColor: String(r.style_color ?? ''),
      // 有效颜色 = 款色（映射 / 识别结论）→ 订单原文（见 `PickingRowProjection.color` 的注释）
      color: String(r.style_color ?? '').trim() || String(r.color ?? ''),
      size: String(r.size ?? ''),
      itemId,
      supplierId: Number(r.supplier_id ?? 0) || 0,
      supplierName: String(r.supplier_name ?? ''),
      imagePath,
      shipped: shipTime !== '' || status === 'shipped',
      bizStatus: String(r.biz_status ?? ''),
      rawFields,
    };
  });

  return {
    rows: out,
    meta: { rows: out.length, limit },
  };
}